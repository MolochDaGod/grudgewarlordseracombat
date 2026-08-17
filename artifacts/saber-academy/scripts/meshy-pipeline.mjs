#!/usr/bin/env node
/**
 * Meshy character pipeline: text-to-3d (preview -> refine) -> auto-rig ->
 * download rigged GLB+FBX into public/models/meshy/<slug>/.
 *
 * Resumable: task IDs are persisted to scripts/meshy-state.json after every
 * step, so re-running the script never re-spends credits on finished steps.
 *
 * Usage: MESHY_API_KEY must be set.  `node scripts/meshy-pipeline.mjs`
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://api.meshy.ai";
const KEY = process.env.MESHY_API_KEY;
if (!KEY) {
  console.error("MESHY_API_KEY is not set");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STATE_FILE = path.join(ROOT, "scripts", "meshy-state.json");
const OUT_DIR = path.join(ROOT, "public", "models", "meshy");

// Batch 1: four modular RPG archetypes. Prompts keep proportions consistent
// (realistic adult humanoid, neutral A-pose) so one animation set retargets
// cleanly across all of them, and outfits read as separable "modules"
// (helmet/chest/gloves/boots) for future gear-swap work.
const CHARACTERS = [
  {
    slug: "knight",
    prompt:
      "Full-body game-ready RPG knight character, adult human male, standing A-pose, arms slightly away from body, realistic proportions. Modular armor set with clearly separated pieces: open-faced steel helmet, segmented chest plate over chainmail, layered pauldrons, plated gauntlets, armored boots, blue cloth tabard with silver trim. Determined face, short beard. Clean silhouette, empty hands, no weapon, single character, neutral pose.",
  },
  {
    slug: "mage",
    prompt:
      "Full-body game-ready RPG mage character, adult human female, standing A-pose, arms slightly away from body, realistic proportions. Modular outfit with clearly separated pieces: hooded violet robe with gold runic hems, leather corset belt with potion pouches, cloth gloves, soft leather boots, shoulder mantle. Wise face, long braided hair under hood. Clean silhouette, empty hands, no staff, single character, neutral pose.",
  },
  {
    slug: "rogue",
    prompt:
      "Full-body game-ready RPG rogue character, adult human male, standing A-pose, arms slightly away from body, realistic proportions. Modular leather outfit with clearly separated pieces: dark hooded half-cowl, studded leather jerkin, bracers, twin belt straps with dagger sheaths, fitted pants, quiet boots. Sharp angular face with scar. Clean silhouette, empty hands, no weapon, single character, neutral pose.",
  },
  {
    slug: "ranger",
    prompt:
      "Full-body game-ready RPG ranger character, adult human female, standing A-pose, arms slightly away from body, realistic proportions. Modular wilderness outfit with clearly separated pieces: green hooded cloak, hardened leather chest guard, arm guards, quiver harness straps, layered skirt over leggings, tall boots. Focused face, ponytail. Clean silhouette, empty hands, no bow, single character, neutral pose.",
  },
];

const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : {};
const save = () =>
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

async function api(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    // Abort hung requests so the resumable loop can retry instead of stalling.
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a task endpoint until SUCCEEDED (or throw on FAILED/CANCELED). */
async function poll(url, label, timeoutMin = 30) {
  const deadline = Date.now() + timeoutMin * 60_000;
  for (;;) {
    let t;
    try {
      t = await api("GET", url);
    } catch (err) {
      console.log(`  [${label}] poll error, retrying: ${err.message?.slice(0, 120)}`);
      await sleep(10_000);
      continue;
    }
    const st = t.status;
    if (st === "SUCCEEDED") return t;
    if (st === "FAILED" || st === "CANCELED")
      throw new Error(`${label} ${st}: ${JSON.stringify(t.task_error || t).slice(0, 400)}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    console.log(`  [${label}] ${st} ${t.progress ?? 0}%`);
    await sleep(15_000);
  }
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download ${res.status} ${url.slice(0, 120)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`  saved ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} bytes)`);
}

async function runCharacter(ch) {
  const s = (state[ch.slug] ||= {});
  console.log(`\n=== ${ch.slug} ===`);

  // 1) Preview (draft geometry).
  if (!s.previewId) {
    const r = await api("POST", "/openapi/v2/text-to-3d", {
      mode: "preview",
      prompt: ch.prompt,
      art_style: "realistic",
      symmetry_mode: "on",
      should_remesh: true,
      target_polycount: 30000,
    });
    s.previewId = r.result;
    save();
    console.log(`  preview task ${s.previewId}`);
  }
  if (!s.previewDone) {
    await poll(`/openapi/v2/text-to-3d/${s.previewId}`, `${ch.slug} preview`);
    s.previewDone = true;
    save();
  }

  // 2) Refine (textures/PBR).
  if (!s.refineId) {
    const r = await api("POST", "/openapi/v2/text-to-3d", {
      mode: "refine",
      preview_task_id: s.previewId,
      enable_pbr: true,
    });
    s.refineId = r.result;
    save();
    console.log(`  refine task ${s.refineId}`);
  }
  if (!s.refineDone) {
    const t = await poll(`/openapi/v2/text-to-3d/${s.refineId}`, `${ch.slug} refine`);
    s.refineDone = true;
    s.refineModelUrls = t.model_urls;
    save();
  }

  // 3) Auto-rig (humanoid skeleton).
  if (!s.rigId) {
    const r = await api("POST", "/openapi/v1/rigging", {
      input_task_id: s.refineId,
      height_meters: 1.8,
    });
    s.rigId = r.result;
    save();
    console.log(`  rig task ${s.rigId}`);
  }
  if (!s.rigDone) {
    const t = await poll(`/openapi/v1/rigging/${s.rigId}`, `${ch.slug} rig`);
    s.rigDone = true;
    s.rigResult = t.result || t;
    save();
  }

  // 4) Download rigged outputs (GLB + FBX) and the textured refine GLB.
  const rr = s.rigResult || {};
  const glbUrl =
    rr.rigged_character_glb_url ||
    rr.model_urls?.glb ||
    rr.basic_animations?.glb_url;
  const fbxUrl =
    rr.rigged_character_fbx_url ||
    rr.model_urls?.fbx ||
    rr.basic_animations?.fbx_url;
  const dir = path.join(OUT_DIR, ch.slug);
  if (glbUrl && !s.glbSaved) {
    await download(glbUrl, path.join(dir, `${ch.slug}-rigged.glb`));
    s.glbSaved = true;
    save();
  }
  if (fbxUrl && !s.fbxSaved) {
    await download(fbxUrl, path.join(dir, `${ch.slug}-rigged.fbx`));
    s.fbxSaved = true;
    save();
  }
  if (!glbUrl && !fbxUrl) {
    console.log(`  WARNING: no rigged output urls; rigResult keys: ${Object.keys(rr).join(",")}`);
    console.log(JSON.stringify(rr).slice(0, 1200));
  }
  console.log(`  ${ch.slug} DONE`);
}

// Run all characters concurrently — each is independently resumable.
const results = await Promise.allSettled(CHARACTERS.map(runCharacter));
let failed = 0;
results.forEach((r, i) => {
  if (r.status === "rejected") {
    failed++;
    console.error(`FAILED ${CHARACTERS[i].slug}: ${r.reason?.message || r.reason}`);
  }
});
console.log(`\nPipeline finished. ${CHARACTERS.length - failed}/${CHARACTERS.length} succeeded.`);
process.exit(failed ? 1 : 0);

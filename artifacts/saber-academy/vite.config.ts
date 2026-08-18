import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { promises as fs } from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/**
 * Weapon Skill Studio save endpoint (DEV ONLY). Exposes POST /__save-skills,
 * which STRICTLY validates the posted catalog and only then rewrites the
 * on-disk JSON so the file becomes the new source of truth for every game mode.
 * Mounted only via configureServer, so it never exists in a production build.
 */

/** Hard cap on the request body (bytes). A valid catalog is a few KB. */
const SAVE_BODY_LIMIT = 256 * 1024;

// ---- Allowed enums / shapes (must mirror skillcatalog.ts registries) ----
const CLASS_KEYS = ["warrior", "mage", "ranger", "worge", "blade dancer"];
const SKILLS_PER_CLASS = 2;
const CAST_COUNT = 6;
const SKILL_KINDS = ["projectile", "nova", "dash", "boomerang", "heal"];
const CAST_ELEMENTS = ["fire", "ice", "thunder", "nova", "snare", "volley"];
const CAST_SHAPES = ["line", "zone"];
const SPRITE_EFFECTS = [
  "crit",
  "hit",
  "flamestrike",
  "frostbolt",
  "frozen",
  "arcanebolt",
];
// KeyboardEvent.code values the Studio may bind. Reserved control keys
// (movement, jump, block/sprint, target, browser) are intentionally excluded.
const ALLOWED_HOTKEYS = [
  "KeyQ",
  "KeyE",
  "KeyR",
  "KeyF",
  "KeyG",
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyT",
  "KeyY",
  "KeyB",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "Numpad0",
];

/** A finite number within [min, max]. */
function numIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}
function isInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v);
}
function isColor(v: unknown): boolean {
  return isInt(v) && (v as number) >= 0 && (v as number) <= 0xffffff;
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function oneOf(v: unknown, allowed: readonly string[]): boolean {
  return isStr(v) && allowed.includes(v);
}

// ---- Buff/debuff validation (mirrors buffs.ts) ----
const BUFF_TYPES = ["slow", "burn", "stun", "poison", "heal", "haste"];
const BUFF_TARGETS = ["self", "enemies"];

function validateBuff(b: unknown, where: string): string | null {
  if (!b || typeof b !== "object") return `${where}: not an object`;
  const d = b as Record<string, unknown>;
  if (!BUFF_TYPES.includes(d.type as string))
    return `${where}: bad type "${d.type}"`;
  if (!numIn(d.magnitude, 0, 10000)) return `${where}: bad magnitude`;
  if (!numIn(d.duration, 0.1, 30)) return `${where}: bad duration`;
  if (!BUFF_TARGETS.includes(d.target as string))
    return `${where}: bad target`;
  return null;
}

function validateBuffArray(arr: unknown, where: string): string | null {
  if (arr === undefined || arr === null) return null; // optional
  if (!Array.isArray(arr)) return `${where}: buffs must be an array`;
  if (arr.length > 8) return `${where}: too many buffs (max 8)`;
  for (let i = 0; i < arr.length; i++) {
    const err = validateBuff(arr[i], `${where}[${i}]`);
    if (err) return err;
  }
  return null;
}

/** Validate a signature-skill def. Returns an error string or null if valid. */
function validateSkill(s: unknown, where: string): string | null {
  if (!s || typeof s !== "object") return `${where}: not an object`;
  const d = s as Record<string, unknown>;
  if (!isStr(d.id) || !isStr(d.name) || !isStr(d.key) || !isStr(d.blurb))
    return `${where}: bad string field`;
  if (!oneOf(d.kind, SKILL_KINDS)) return `${where}: bad kind`;
  if (!oneOf(d.texture, SPRITE_EFFECTS)) return `${where}: bad texture`;
  if (d.impact !== undefined && !oneOf(d.impact, SPRITE_EFFECTS))
    return `${where}: bad impact`;
  if (!isColor(d.color)) return `${where}: bad color`;
  if (!numIn(d.forceCost, 0, 1000)) return `${where}: bad forceCost`;
  if (!numIn(d.cooldown, 0, 120)) return `${where}: bad cooldown`;
  if (!numIn(d.damage, 0, 100000)) return `${where}: bad damage`;
  if (!numIn(d.radius, 0, 200)) return `${where}: bad radius`;
  if (!numIn(d.range, 0, 500)) return `${where}: bad range`;
  if (!numIn(d.speed, 0, 500)) return `${where}: bad speed`;
  const buffErr = validateBuffArray(d.buffs, `${where}.buffs`);
  if (buffErr) return buffErr;
  return null;
}

/** Validate an elemental cast def. Returns an error string or null if valid. */
function validateCast(c: unknown, where: string): string | null {
  if (!c || typeof c !== "object") return `${where}: not an object`;
  const d = c as Record<string, unknown>;
  if (!oneOf(d.element, CAST_ELEMENTS)) return `${where}: bad element`;
  if (!isStr(d.name) || !isStr(d.key)) return `${where}: bad string field`;
  if (!isColor(d.color)) return `${where}: bad color`;
  if (!numIn(d.range, 0, 500)) return `${where}: bad range`;
  if (!numIn(d.speed, 0, 500)) return `${where}: bad speed`;
  if (!numIn(d.damage, 0, 100000)) return `${where}: bad damage`;
  if (!numIn(d.radius, 0, 200)) return `${where}: bad radius`;
  if (!numIn(d.knock, 0, 1000)) return `${where}: bad knock`;
  if (!numIn(d.cost, 0, 1000)) return `${where}: bad cost`;
  if (!numIn(d.cooldown, 0, 120)) return `${where}: bad cooldown`;
  if (!numIn(d.windup, 0, 10)) return `${where}: bad windup`;
  if (d.castShape !== undefined && !oneOf(d.castShape, CAST_SHAPES))
    return `${where}: bad castShape`;
  if (d.zoneRadius !== undefined && !numIn(d.zoneRadius, 0, 200))
    return `${where}: bad zoneRadius`;
  if (d.hold !== undefined && !numIn(d.hold, 0, 30)) return `${where}: bad hold`;
  const buffErr = validateBuffArray(d.buffs, `${where}.buffs`);
  if (buffErr) return buffErr;
  return null;
}

const ARROW_KEYS: Array<[string, number, number]> = [
  ["releaseMs", 0, 5000],
  ["speed", 0, 500],
  ["range", 0, 500],
  ["damage", 0, 100000],
  ["radius", 0, 200],
  ["knock", 0, 1000],
];
const ORB_KEYS: Array<[string, number, number]> = [
  ["castT", 0, 10],
  ["speed", 0, 500],
  ["range", 0, 500],
  ["damage", 0, 100000],
  ["radius", 0, 200],
  ["knock", 0, 1000],
  ["splashKnock", 0, 1000],
];

function validateShot(
  o: unknown,
  keys: Array<[string, number, number]>,
  where: string,
): string | null {
  if (!o || typeof o !== "object") return `${where}: not an object`;
  const d = o as Record<string, unknown>;
  for (const [k, min, max] of keys) {
    if (!numIn(d[k], min, max)) return `${where}.${k}: out of range`;
  }
  if (!isColor(d.color)) return `${where}.color: bad color`;
  return null;
}

function validateHotkeyList(v: unknown, count: number, where: string): string | null {
  if (!Array.isArray(v) || v.length !== count) return `${where}: wrong length`;
  for (const code of v) {
    if (!oneOf(code, ALLOWED_HOTKEYS)) return `${where}: disallowed key "${code}"`;
  }
  return null;
}

/**
 * STRICT catalog validation. Returns an error string (safe to surface) or null
 * when the payload is a well-formed catalog safe to persist.
 */
function validateCatalog(data: unknown): string | null {
  if (!data || typeof data !== "object") return "not an object";
  const c = data as Record<string, unknown>;
  if (!isInt(c.version) || (c.version as number) < 0) return "bad version";
  if (c.note !== undefined && !isStr(c.note)) return "bad note";

  // classSkills: exactly the known class keys, each with the right skill count.
  const cs = c.classSkills;
  if (!cs || typeof cs !== "object") return "classSkills: not an object";
  const csRec = cs as Record<string, unknown>;
  const gotKeys = Object.keys(csRec).sort();
  if (
    gotKeys.length !== CLASS_KEYS.length ||
    !CLASS_KEYS.slice().sort().every((k, i) => k === gotKeys[i])
  ) {
    return "classSkills: unexpected class keys";
  }
  for (const key of CLASS_KEYS) {
    const arr = csRec[key];
    if (!Array.isArray(arr) || arr.length !== SKILLS_PER_CLASS)
      return `classSkills.${key}: expected ${SKILLS_PER_CLASS} skills`;
    for (let i = 0; i < arr.length; i++) {
      const err = validateSkill(arr[i], `classSkills.${key}[${i}]`);
      if (err) return err;
    }
  }

  // elementalCasts: exactly CAST_COUNT entries.
  const ec = c.elementalCasts;
  if (!Array.isArray(ec) || ec.length !== CAST_COUNT)
    return `elementalCasts: expected ${CAST_COUNT} entries`;
  for (let i = 0; i < ec.length; i++) {
    const err = validateCast(ec[i], `elementalCasts[${i}]`);
    if (err) return err;
  }

  // hotkeys: right lengths, allowlisted codes, no duplicates across all binds.
  const hk = c.hotkeys;
  if (!hk || typeof hk !== "object") return "hotkeys: not an object";
  const hkRec = hk as Record<string, unknown>;
  const skillErr = validateHotkeyList(hkRec.skill, SKILLS_PER_CLASS, "hotkeys.skill");
  if (skillErr) return skillErr;
  const castErr = validateHotkeyList(hkRec.cast, CAST_COUNT, "hotkeys.cast");
  if (castErr) return castErr;
  const allBinds = [
    ...(hkRec.skill as string[]),
    ...(hkRec.cast as string[]),
  ];
  if (new Set(allBinds).size !== allBinds.length)
    return "hotkeys: duplicate key binding";

  // rangedShots: arrow + orb with bounded numerics.
  const rs = c.rangedShots;
  if (!rs || typeof rs !== "object") return "rangedShots: not an object";
  const rsRec = rs as Record<string, unknown>;
  const arrowErr = validateShot(rsRec.arrow, ARROW_KEYS, "rangedShots.arrow");
  if (arrowErr) return arrowErr;
  const orbErr = validateShot(rsRec.orb, ORB_KEYS, "rangedShots.orb");
  if (orbErr) return orbErr;

  return null;
}

/**
 * Best-effort local-origin check: the save endpoint only serves the dev
 * preview itself. Reject cross-site requests (Origin present and pointing at a
 * different host than the request) so a malicious page can't drive the editor.
 * The destination file path is fixed, so path traversal is not a concern.
 */
function isLocalRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  const origin = req.headers["origin"];
  const host = req.headers["host"];
  if (!origin) return true; // same-origin fetches often omit Origin
  if (Array.isArray(origin) || Array.isArray(host)) return false;
  try {
    const o = new URL(origin);
    // Allow loopback dev hosts outright.
    if (o.hostname === "localhost" || o.hostname === "127.0.0.1") return true;
    // Otherwise require the Origin host to match the request Host header.
    return !!host && o.host === host;
  } catch {
    return false;
  }
}

function omitHeavyModelsPlugin(): Plugin {
  const heavy = ["models/toonrts", "models/meshy", "models/racalvin"];
  return {
    name: "omit-heavy-public-models",
    apply: "build",
    async closeBundle() {
      const outDir = path.resolve(import.meta.dirname, "dist/public");
      await Promise.all(
        heavy.map((rel) =>
          fs.rm(path.join(outDir, rel), { recursive: true, force: true }),
        ),
      );
    },
  };
}

function saveSkillsPlugin(): Plugin {
  const catalogPath = path.resolve(
    import.meta.dirname,
    "src/game/data/weapon-skills.json",
  );
  return {
    name: "saber-save-skills",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.endsWith("/__save-skills") || req.method !== "POST") {
          next();
          return;
        }
        if (!isLocalRequest(req)) {
          res.statusCode = 403;
          res.end("Forbidden: cross-origin save rejected.");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;
        req.on("data", (c: Buffer) => {
          if (aborted) return;
          size += c.length;
          if (size > SAVE_BODY_LIMIT) {
            aborted = true;
            res.statusCode = 413;
            res.end("Payload too large.");
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on("end", async () => {
          if (aborted) return;
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            let data: unknown;
            try {
              data = JSON.parse(raw);
            } catch {
              res.statusCode = 400;
              res.end("Invalid JSON.");
              return;
            }
            const err = validateCatalog(data);
            if (err) {
              res.statusCode = 400;
              res.end(`Invalid catalog: ${err}`);
              return;
            }
            await fs.writeFile(
              catalogPath,
              JSON.stringify(data, null, 2) + "\n",
              "utf8",
            );
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 500;
            res.end(
              `Save error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      });
    },
  };
}

const rawPort = process.env.PORT ?? "5173";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    saveSkillsPlugin(),
    omitHeavyModelsPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom", "three"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

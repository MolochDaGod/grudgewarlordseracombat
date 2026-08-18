// Weapon Skill Studio — data catalog.
//
// The catalog is the single source of tunable gameplay numbers for the player's
// signature skills, the elemental line-casts and the player's ranged shots
// (bow arrow / staff orb). The engine reads these values through the getters
// below instead of hard-coded constants, so live edits made in the Weapon
// Skill Studio (animtest mode) take effect immediately across every game mode.
//
// It is seeded from `data/weapon-skills.json` (imported, so Vite HMR reloads
// the seed on save) and kept in a mutable in-memory copy. The Studio mutates
// this copy for instant preview, then POSTs it to the dev-only `/__save-skills`
// endpoint which rewrites the JSON file — making the file the new source of
// truth for fresh loads and all modes.

import seed from "./data/weapon-skills.json";
import type { SkillDef, SkillKind } from "./skills";
import { CAST_DEFS, type CastDef, type CastElement } from "./casting";
import type { ClipName } from "./animations";
import {
  defaultAiCatalog,
  type AiCatalog,
} from "./brains";
import {
  DEFAULT_LINEAR_GLOBAL,
  defaultPrimitive,
  type EffectPrimitive,
  type LinearGlobal,
} from "./effectPrefab";

/** Player ranged-shot tuning (bow arrow / staff orb LMB attacks). */
export interface ArrowShotParams {
  /** Delay from attack-anim start to arrow release (ms). */
  releaseMs: number;
  speed: number;
  range: number;
  damage: number;
  /** Splash radius (0 = single target). */
  radius: number;
  color: number;
  /** Knockback impulse applied on hit. */
  knock: number;
  /** Extra loft (m/s) so the shot flies an arc. */
  arc?: number;
  /** Gravity on the shot (m/s²). */
  gravity?: number;
  /** Stretch along travel so the shot reads as a bullet, not a ball. */
  length?: number;
}

export interface OrbShotParams {
  /** Arcane cast time before the orb fires (seconds). */
  castT: number;
  speed: number;
  range: number;
  damage: number;
  radius: number;
  color: number;
  /** Knockback on the primary struck enemy. */
  knock: number;
  /** Knockback on splash-caught enemies. */
  splashKnock: number;
  arc?: number;
  gravity?: number;
  length?: number;
}

/** The full editable catalog. Colors are stored as integers (0xRRGGBB). */
export interface WeaponSkillCatalog {
  version: number;
  note?: string;
  /** Signature skills per champion class (each class has a Q and an E). */
  classSkills: Record<string, SkillDef[]>;
  /** Elemental line-casts (keys 1..6); mirrors casting.ts CAST_DEFS. */
  elementalCasts: CastDef[];
  /**
   * Physical key bindings (KeyboardEvent.code) for the player's two signature
   * skills and the (up to six) elemental casts. The engine builds its dispatch
   * from these so click-to-rebind in the Studio changes the live key.
   */
  hotkeys: { skill: string[]; cast: string[] };
  /** Player ranged LMB shots. */
  rangedShots: { arrow: ArrowShotParams; orb: OrbShotParams };
  /** Linear skillshot global multipliers (Casting / LinearAbility SSOT). */
  linear?: { global: LinearGlobal };
  /** Isolatable effect primitives (casting effectPrefab schema). */
  effects?: EffectPrimitive[];
  /** Grudge AI / Yuka rings + threat (grudge-ai-brains). */
  ai?: AiCatalog;
}

// Deep clone so the mutable runtime copy never aliases the frozen import.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The live, mutable catalog the engine reads every frame. */
export const catalog: WeaponSkillCatalog = clone(
  seed as unknown as WeaponSkillCatalog,
);

/**
 * Push edited catalog data into the live copy (Studio "apply live"). Mutates
 * `catalog` in place (keeping the same object identity the engine holds) and
 * re-syncs the shared CAST_DEFS array so already-running casts pick up edits.
 */
export function applyCatalog(next: WeaponSkillCatalog): void {
  catalog.version = next.version;
  catalog.classSkills = clone(next.classSkills);
  catalog.elementalCasts = clone(next.elementalCasts);
  catalog.hotkeys = clone(next.hotkeys);
  catalog.rangedShots = clone(next.rangedShots);
  catalog.linear = clone(next.linear ?? { global: { ...DEFAULT_LINEAR_GLOBAL } });
  catalog.effects = clone(next.effects ?? []);
  catalog.ai = clone(next.ai ?? defaultAiCatalog());
  syncCastDefs();
}

/**
 * A short HUD label for a physical KeyboardEvent.code (e.g. "KeyQ" -> "Q",
 * "Digit1" -> "1", "ArrowUp" -> "Up"). Used to show a rebound key on the HUD.
 */
export function keyLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return code.slice(6);
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}

/**
 * A stable, shallow snapshot of a CastDef. CastDef fields are all primitives,
 * so a shallow copy fully detaches the returned object from the shared
 * CAST_DEFS entry. Callers snapshot at the instant a cast starts so a live
 * Studio edit (which mutates CAST_DEFS in place via syncCastDefs) only affects
 * the NEXT cast, never one already winding up / travelling / resolving.
 */
export function snapshotCastDef(def: CastDef): CastDef {
  const g = catalog.linear?.global;
  if (!g) return { ...def };
  return {
    ...def,
    speed: def.speed * (g.speed ?? 1),
    range: def.range * (g.range ?? 1),
    damage: def.damage * (g.damage ?? 1),
    radius: def.radius * (g.aoe ?? 1),
    knock: def.knock * (g.intensity ?? 1),
    windup: def.windup * (g.windup ?? 1),
  };
}

/**
 * Mirror the catalog's elemental casts back into the shared CAST_DEFS array
 * (same object identity casting.ts / SaberGame reference), field by field, so
 * cooldown-index alignment and any live references stay valid.
 */
export function syncCastDefs(): void {
  for (let i = 0; i < catalog.elementalCasts.length && i < CAST_DEFS.length; i++) {
    Object.assign(CAST_DEFS[i], catalog.elementalCasts[i]);
  }
}

/**
 * Resolve the two signature skills for a champion class from the catalog.
 * Unknown classes fall back to the warrior set (mirrors skills.ts getSkills).
 * Returns fresh SkillDef copies so callers can hold them without aliasing the
 * catalog (the engine re-reads the catalog for live values where it matters).
 */
export function catalogSkills(classId: string): SkillDef[] {
  const set =
    catalog.classSkills[classId.toLowerCase()] ?? catalog.classSkills.warrior;
  return clone(set);
}

/** Player ranged-shot params for the given projectile kind. */
export function rangedShot(kind: "arrow" | "orb"): ArrowShotParams | OrbShotParams {
  return kind === "arrow" ? catalog.rangedShots.arrow : catalog.rangedShots.orb;
}

/* ------------------------------------------------------------------ */
/* Effect registry — named VFX/effect builders the Studio can pick     */
/* from. Creating brand-new shader effects is out of scope this round; */
/* new skill combos = choosing an existing effect id.                  */
/* ------------------------------------------------------------------ */

/** A named effect the Studio surfaces in its dropdowns. */
export interface EffectEntry {
  id: string;
  label: string;
  /** Where the effect comes from (for the Studio's grouping). */
  source: "sprite" | "cast" | "impact";
}

/**
 * Sprite VFX texture ids (R2 effects/custom/<id>.png). Used for skill trails
 * and impacts (SkillDef.texture / SkillDef.impact). These are the names the
 * engine already loads defensively via makeVfxSprite.
 */
export const SPRITE_EFFECTS: EffectEntry[] = [
  { id: "crit", label: "Crit Burst", source: "sprite" },
  { id: "hit", label: "Hit Spark", source: "sprite" },
  { id: "flamestrike", label: "Flame Strike", source: "sprite" },
  { id: "frostbolt", label: "Frost Bolt", source: "sprite" },
  { id: "frozen", label: "Frozen Shatter", source: "sprite" },
  { id: "arcanebolt", label: "Arcane Bolt", source: "sprite" },
];

/**
 * Elemental cast effect builders (castvfx.ts / casting.ts). Each id maps to a
 * CastElement whose phase-machine (travel/impact/hold) drives the visuals.
 */
export const CAST_EFFECTS: EffectEntry[] = [
  { id: "fire", label: "Fire — Cinder Fall (arcing meteor)", source: "cast" },
  { id: "ice", label: "Ice — Frost Lance (crystal field)", source: "cast" },
  { id: "thunder", label: "Thunder — Storm Lance (instant bolt)", source: "cast" },
  { id: "nova", label: "Nova — Nova Beam (held column)", source: "cast" },
  { id: "snare", label: "Snare — Voltaic Snare (zone cage)", source: "cast" },
  { id: "volley", label: "Volley — Rain of Arrows (zone barrage)", source: "cast" },
];

/** Skill kinds selectable in the Studio (drives spawn logic in SaberGame). */
export const SKILL_KINDS: SkillKind[] = [
  "projectile",
  "nova",
  "dash",
  "boomerang",
];

/** Cast element ids selectable in the Studio. */
export const CAST_ELEMENTS: CastElement[] = [
  "fire",
  "ice",
  "thunder",
  "nova",
  "snare",
  "volley",
];

/** Locomotion / action clip names available for the animation dropdown. */
export const CLIP_NAMES: ClipName[] = [
  "idle",
  "walk",
  "run",
  "strafeLeft",
  "strafeRight",
  "jump",
  "dodge",
  "attack",
  "attack2",
  "attack3",
  "cast",
  "guard",
  "hit",
  "death",
];

if (!catalog.linear) catalog.linear = { global: { ...DEFAULT_LINEAR_GLOBAL } };
if (!catalog.effects || catalog.effects.length === 0) {
  catalog.effects = [
    defaultPrimitive("travel"),
    { ...defaultPrimitive("impact"), meshId: "sphering", duration: 0.45, aoe: 3.2 },
    { ...defaultPrimitive("trail"), meshId: "slashblue", attach: "weapon_tip" },
    { ...defaultPrimitive("residual"), meshId: "slashred", aoe: 4, speed: 12 },
    { ...defaultPrimitive("decal"), attach: "feet", duration: 1.4 },
    { ...defaultPrimitive("aura"), attach: "root", aoe: 2, speed: 0 },
    { ...defaultPrimitive("cast"), attach: "R_hand", meshId: "staff-charge" },
  ];
}
if (!catalog.ai) catalog.ai = defaultAiCatalog();

// Keep CAST_DEFS aligned with the seed on first import (idempotent).
syncCastDefs();

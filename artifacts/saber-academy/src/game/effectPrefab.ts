/**
 * Casting-lab effect primitives (shared schema).
 * Source: CastingAbilitiesThreeJS src/vfx/effectPrefab.js
 * Editor knobs 1:1 — do not invent a second VFX engine.
 */

export type EffectKind =
  | "trail"
  | "travel"
  | "cast"
  | "impact"
  | "residual"
  | "decal"
  | "aura";

export type EffectAttach =
  | "R_hand"
  | "L_hand"
  | "root"
  | "feet"
  | "weapon_tip";

export interface EffectPrimitive {
  kind: EffectKind;
  intensity: number;
  aoe: number;
  speed: number;
  size: number;
  color: string;
  meshId?: string;
  duration?: number;
  attach?: EffectAttach;
  effectId?: string;
}

export const EFFECT_KINDS: EffectKind[] = [
  "trail",
  "travel",
  "cast",
  "impact",
  "residual",
  "decal",
  "aura",
];

export const EFFECT_ATTACH: EffectAttach[] = [
  "R_hand",
  "L_hand",
  "root",
  "feet",
  "weapon_tip",
];

/** Casting lab mesh ids (orbs / slash / rocks — never whole fireball.glb). */
export const EFFECT_MESH_IDS = [
  "none",
  "slashblue",
  "slashred",
  "slashpurple",
  "slashyellow",
  "orb-fire",
  "orb-ember",
  "orb-core",
  "orb-flare",
  "orb-ice",
  "orb-nature",
  "orb-storm",
  "orb-holy",
  "orb-arcane",
  "staff-charge",
  "rock-0",
  "rock-1",
  "rock-2",
  "arrow-path",
  "arrow-loft",
  "summon-fire-fist",
  "summon-ice-shard",
  "sphering",
] as const;

export interface LinearGlobal {
  timeScale: number;
  speed: number;
  range: number;
  damage: number;
  aoe: number;
  windup: number;
  glow: number;
  intensity: number;
  cameraShake: number;
}

export const DEFAULT_LINEAR_GLOBAL: LinearGlobal = {
  timeScale: 1,
  speed: 1,
  range: 1,
  damage: 1,
  aoe: 1,
  windup: 1,
  glow: 1,
  intensity: 1,
  cameraShake: 1,
};

export interface LinearCastExtras {
  linearId: "ice" | "thunder" | "meteor" | "beam" | "snare" | "glacier";
  minRange: number;
  telegraphSec: number;
  telegraphVariant: "aoe" | "cone" | "incoming";
  intensity: number;
  castAnim: "cast1" | "cast2" | "cast3";
}

export const LINEAR_IDS = [
  "ice",
  "thunder",
  "meteor",
  "beam",
  "snare",
  "glacier",
] as const;

export const CAST_ANIMS = ["cast1", "cast2", "cast3"] as const;

export const ELEMENT_LINEAR: Record<string, LinearCastExtras["linearId"]> = {
  fire: "meteor",
  ice: "ice",
  thunder: "thunder",
  nova: "beam",
  snare: "snare",
  volley: "glacier",
};

export function defaultPrimitive(kind: EffectKind = "travel"): EffectPrimitive {
  return {
    kind,
    intensity: 1,
    aoe: 2.4,
    speed: 18,
    size: 1,
    color: "#ff7733",
    meshId: "orb-fire",
    duration: 0.8,
    attach: "weapon_tip",
  };
}

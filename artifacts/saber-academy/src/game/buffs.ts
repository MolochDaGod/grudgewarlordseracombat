/**
 * Buff / Debuff data model for weapon skills and elemental casts.
 *
 * BuffDef is stored as an optional `buffs` array on SkillDef (skills.ts) and
 * CastDef (casting.ts). The engine (SaberGame) reads these at hit / cast time
 * and applies the corresponding StatusEffect to the appropriate targets.
 */

/** Status-effect category. */
export type BuffType =
  | "slow"    // Reduce enemy movement speed
  | "burn"    // Damage over time (fire)
  | "stun"    // Briefly freeze enemy
  | "poison"  // Damage over time (nature)
  | "heal"    // Restore player HP over time (self only)
  | "haste";  // Increase player move speed (self only)

/** Who receives the effect. */
export type BuffTarget = "self" | "enemies";

export interface BuffDef {
  type: BuffType;
  /**
   * Magnitude interpretation per type:
   * - slow:   fraction reduced (0–0.9); 0.3 → 30% slower
   * - burn:   damage-per-second tick
   * - stun:   freeze duration in seconds (overrides magnitude as duration)
   * - poison: damage-per-second tick
   * - heal:   HP-per-second restored (self)
   * - haste:  fraction speed bonus (0–1); 0.3 → 30% faster
   */
  magnitude: number;
  /** How long the effect lasts, in seconds (0.1–30). */
  duration: number;
  /** Who the effect applies to. */
  target: BuffTarget;
}

/** Ordered list of selectable buff types for the Studio dropdowns. */
export const BUFF_TYPES: BuffType[] = [
  "slow",
  "burn",
  "stun",
  "poison",
  "heal",
  "haste",
];

/** Selectable targets for the Studio dropdowns. */
export const BUFF_TARGETS: BuffTarget[] = ["self", "enemies"];

/** Human-readable labels for the Studio UI. */
export const BUFF_TYPE_LABELS: Record<BuffType, string> = {
  slow: "Slow",
  burn: "Burn (DoT)",
  stun: "Stun",
  poison: "Poison (DoT)",
  heal: "Heal (self)",
  haste: "Haste (self)",
};

export const BUFF_TARGET_LABELS: Record<BuffTarget, string> = {
  self: "Self",
  enemies: "Enemies",
};

/** Default template for a new buff entry added in the Studio. */
export const DEFAULT_BUFF: BuffDef = {
  type: "slow",
  magnitude: 0.3,
  duration: 3,
  target: "enemies",
};

/**
 * Validate a BuffDef for the save-skills endpoint. Returns an error string
 * or null when the def is safe to persist.
 */
export function validateBuff(b: unknown, where: string): string | null {
  if (!b || typeof b !== "object") return `${where}: not an object`;
  const d = b as Record<string, unknown>;
  if (!BUFF_TYPES.includes(d.type as BuffType))
    return `${where}: bad type "${d.type}"`;
  if (typeof d.magnitude !== "number" || d.magnitude < 0 || d.magnitude > 10000)
    return `${where}: bad magnitude`;
  if (typeof d.duration !== "number" || d.duration < 0.1 || d.duration > 30)
    return `${where}: bad duration`;
  if (!BUFF_TARGETS.includes(d.target as BuffTarget))
    return `${where}: bad target`;
  return null;
}

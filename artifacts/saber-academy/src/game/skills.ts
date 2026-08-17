// Signature skills per champion class. Pure data (no THREE) so the React UI can
// import it for the skill bar / character-select detail, while the engine reads
// the same defs to drive VFX, damage and cooldowns.
//
// Each class has two unique skills bound to Q and E. VFX textures are real R2
// sprites (https://assets.grudge-studio.com/effects/custom/<texture>.png); the
// engine loads them defensively and falls back to a tinted additive sprite if a
// texture is unavailable, so gameplay never depends on the download.

export type SkillKind = "projectile" | "nova" | "dash" | "boomerang";

export interface SkillDef {
  id: string;
  name: string;
  /** Keyboard key label shown in the HUD (the engine binds Q -> 0, E -> 1). */
  key: string;
  kind: SkillKind;
  /** Force energy spent per cast. */
  forceCost: number;
  /** Cooldown in seconds. */
  cooldown: number;
  /** Damage dealt to each enemy hit. */
  damage: number;
  /** Area-of-effect radius (nova radius, or projectile splash radius). */
  radius: number;
  /** Projectile travel range / max distance (unused by novas). */
  range: number;
  /** Projectile travel speed in units/sec (unused by novas). */
  speed: number;
  /** Tint applied to the VFX (also the fallback sprite color). */
  color: number;
  /** R2 sprite texture name under effects/custom (no extension). */
  texture: string;
  /** Impact burst texture name (defaults to `texture`). */
  impact?: string;
  /** One-line flavor for the character-select detail panel. */
  blurb: string;
  /**
   * Optional buff/debuff riders applied on hit or cast.
   * Absent / empty → no status effect (defaults keep current gameplay).
   */
  buffs?: import("./buffs").BuffDef[];
}

const WARRIOR: SkillDef[] = [
  {
    id: "whirlwind",
    name: "Whirlwind",
    key: "Q",
    kind: "nova",
    forceCost: 30,
    cooldown: 6,
    damage: 38,
    radius: 5.2,
    range: 0,
    speed: 0,
    color: 0xffb347,
    texture: "crit",
    blurb: "A spinning blade storm that rends every foe around you.",
  },
  {
    id: "sunder",
    name: "Sunder Charge",
    key: "E",
    kind: "projectile",
    forceCost: 36,
    cooldown: 7,
    damage: 60,
    radius: 2.6,
    range: 30,
    speed: 34,
    color: 0xff7b3b,
    texture: "flamestrike",
    impact: "flamestrike",
    blurb: "Hurl a shockwave that detonates on the first enemy it strikes.",
  },
];

const MAGE: SkillDef[] = [
  {
    id: "flame_strike",
    name: "Flame Strike",
    key: "Q",
    kind: "projectile",
    forceCost: 28,
    cooldown: 5,
    damage: 52,
    radius: 3.2,
    range: 36,
    speed: 30,
    color: 0xff5a2a,
    texture: "flamestrike",
    impact: "flamestrike",
    blurb: "A roaring fireball that erupts where it lands.",
  },
  {
    id: "frost_nova",
    name: "Frost Nova",
    key: "E",
    kind: "nova",
    forceCost: 32,
    cooldown: 7,
    damage: 32,
    radius: 6.2,
    range: 0,
    speed: 0,
    color: 0x66ccff,
    texture: "frostbolt",
    impact: "frozen",
    blurb: "Shatter the ground with an expanding ring of killing frost.",
  },
];

const RANGER: SkillDef[] = [
  {
    id: "piercing_shot",
    name: "Piercing Shot",
    key: "Q",
    kind: "projectile",
    forceCost: 22,
    cooldown: 3.5,
    damage: 46,
    radius: 1.8,
    range: 44,
    speed: 46,
    color: 0x9cff6b,
    texture: "arcanebolt",
    impact: "crit",
    blurb: "A razor-fast bolt that punches through armor at range.",
  },
  {
    id: "arrow_storm",
    name: "Arrow Storm",
    key: "E",
    kind: "nova",
    forceCost: 34,
    cooldown: 8,
    damage: 30,
    radius: 7,
    range: 0,
    speed: 0,
    color: 0xa7d8ff,
    texture: "crit",
    blurb: "Call down a rain of arrows over the whole arena floor.",
  },
];

const WORGE: SkillDef[] = [
  {
    id: "savage_pounce",
    name: "Savage Pounce",
    key: "Q",
    kind: "projectile",
    forceCost: 25,
    cooldown: 4,
    damage: 44,
    radius: 3,
    range: 22,
    speed: 40,
    color: 0xff4d4d,
    texture: "hit",
    impact: "crit",
    blurb: "Lunge forward and tear into prey where you land.",
  },
  {
    id: "bloodhowl",
    name: "Bloodhowl",
    key: "E",
    kind: "nova",
    forceCost: 30,
    cooldown: 7,
    damage: 34,
    radius: 5.6,
    range: 0,
    speed: 0,
    color: 0xff2d2d,
    texture: "crit",
    blurb: "A feral howl that savages every nearby foe.",
  },
];

const BLADE_DANCER: SkillDef[] = [
  {
    id: "whirlwind_dash",
    name: "Whirlwind Dash",
    key: "Q",
    kind: "dash",
    forceCost: 26,
    cooldown: 5,
    damage: 40,
    radius: 3.4, // damage sweep radius carried along the dash
    range: 14, // dash distance
    speed: 52, // dash launch speed
    color: 0xff7bd0,
    texture: "crit",
    impact: "crit",
    blurb: "Spin forward in a whirlwind of steel, shredding all you pass.",
  },
  {
    id: "boomerang_blade",
    name: "Boomerang Blade",
    key: "E",
    kind: "boomerang",
    forceCost: 30,
    cooldown: 6,
    damage: 38,
    radius: 2.2, // hit radius as it flies
    range: 22, // out distance before it curves back
    speed: 40,
    color: 0xe0729f,
    texture: "crit",
    impact: "arcanebolt",
    blurb: "Hurl your blade like a boomerang — it carves out and back to you.",
  },
];

const BY_CLASS: Record<string, SkillDef[]> = {
  warrior: WARRIOR,
  mage: MAGE,
  ranger: RANGER,
  worge: WORGE,
  "blade dancer": BLADE_DANCER,
};

/**
 * Resolve the two signature skills for a champion class. Unknown classes fall
 * back to the warrior set so every fighter always has a usable kit.
 */
export function getSkills(classId: string): SkillDef[] {
  return BY_CLASS[classId.toLowerCase()] ?? WARRIOR;
}

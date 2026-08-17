// Movement Motivation (MM): a single signed scalar on a +100 -> -100 axis that
// describes an entity's positioning intent.
//
//   +100 = CLOSE THE GAP   (melee preference)
//      0 = NEUTRAL         (balanced)
//   -100 = KEEP DISTANCE   (ranged preference)
//
// The design references (weapon/ability MM charts) live in .local/ref. This
// module is pure data (no THREE) so the engine and any UI can share it, mirroring
// skills.ts. Enemy AI reads an MM value per weapon and turns it into the standoff
// distance the enemy tries to hold, unifying "chase" and "kite" into one
// data-driven rule instead of a hardcoded melee/ranged branch.

export const MM_MELEE = 100;
export const MM_RANGED = -100;

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** A weapon-name keyword -> characteristic MM value, ordered specific first. */
interface MMRule {
  re: RegExp;
  mm: number;
}
const RULES: MMRule[] = [
  // Ranged / casters want to keep distance (negative MM).
  { re: /rifle|carbine/i, mm: -90 },
  { re: /gun|blaster|cannon|musket/i, mm: -90 },
  { re: /pistol|revolver/i, mm: -85 },
  { re: /longbow|crossbow|\bbow\b/i, mm: -85 },
  { re: /staff|wand|arcane|tome|grimoire|\borb\b|scepter|sceptre/i, mm: -80 },
  // Melee want to close the gap (positive MM). Specific before generic.
  { re: /dagger|knife|dirk|\bclaw/i, mm: 95 },
  { re: /fist|unarmed|gauntlet|knuckle/i, mm: 85 },
  { re: /katana|saber|sabre|scimitar|rapier/i, mm: 80 },
  { re: /greatsword|great sword|claymore|zwei|broadsword/i, mm: 70 },
  { re: /axe|cleaver|hatchet/i, mm: 70 },
  { re: /hammer|maul|\bmace\b/i, mm: 65 },
  { re: /shield|bulwark|aegis|legionnaire/i, mm: 60 },
  { re: /spear|lance|pike|halberd|glaive|polearm|naginata/i, mm: 55 },
  { re: /sword|blade/i, mm: 78 },
];

/**
 * MM value for a roster weapon string. Falls back to the coarse weapon category
 * (blade -> close, magic/bow -> keep distance) when no keyword matches, so an
 * unrecognized weapon still resolves to a sensible motivation.
 */
export function mmForWeapon(weapon: string, category: string): number {
  const w = weapon ?? "";
  for (const r of RULES) if (r.re.test(w)) return r.mm;
  if (category === "magic" || category === "bow") return -85;
  return 78; // blade / unknown melee default
}

/**
 * DistanceBias d in [0,1] derived from an MM value (the linear mapping from the
 * design chart, inverted): d = (100 - MM) / 200. d=0 -> +100 (melee), d=0.5 -> 0
 * (neutral), d=1 -> -100 (ranged).
 */
export function distanceBiasFromMM(mm: number): number {
  return (MM_MELEE - mm) / (MM_MELEE - MM_RANGED);
}

/**
 * Standoff distance (world units) an enemy with this MM wants to hold.
 *
 * `hasRangedAttack` splits the mapping into two regimes so every enemy stays
 * functional: enemies that can fire from range map their negative MM onto a kite
 * band (aggressive kiters hold closer, cautious ones hold farther), while
 * melee-only enemies map their positive MM onto a band that is always inside
 * melee reach (high MM rushes into your face, lower MM holds at poke range) so a
 * flavor-ranged weapon on a melee-only fighter never turns it into a harmless
 * runaway.
 */
export function enemyStandoff(mm: number, hasRangedAttack: boolean): number {
  if (hasRangedAttack) {
    // MM -50 -> 10 (press the attack), MM -100 -> 16 (hold far).
    const t = clamp01((-50 - mm) / 50);
    return 10 + (16 - 10) * t;
  }
  // MM +100 -> 1.7 (rush in), MM +50 -> 2.5 (poke); both within melee reach.
  const t = clamp01((100 - mm) / 50);
  return 1.7 + (2.5 - 1.7) * t;
}

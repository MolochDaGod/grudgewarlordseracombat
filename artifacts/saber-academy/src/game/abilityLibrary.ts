/**
 * 50-ability library: Avatar 5 families (fire/water/earth/air + force)
 * repurposed via texture/color/params. Same SkillDef kinds the engine already
 * runs (projectile · nova · dash · push). Not 50 shaders.
 *
 * Counts: 20 ranged · 10 aoe · 10 force-push · 10 mobility.
 */
import type { SkillDef, SkillKind } from "./skills";

export type AbilityRole = "ranged" | "aoe" | "push" | "mobility";
export type AbilityFamily = "fire" | "water" | "earth" | "air" | "force";

export interface LibraryAbility extends SkillDef {
  family: AbilityFamily;
  role: AbilityRole;
}

const TEX = {
  fire: "flamestrike",
  frost: "frostbolt",
  ice: "frozen",
  arcane: "arcanebolt",
  crit: "crit",
  hit: "hit",
  heal: "heal",
} as const;

function ab(
  id: string,
  name: string,
  kind: SkillKind,
  family: AbilityFamily,
  role: AbilityRole,
  opts: Partial<SkillDef> & { color: number; texture: string },
): LibraryAbility {
  return {
    id,
    name,
    key: "Q",
    kind,
    family,
    role,
    forceCost: opts.forceCost ?? 24,
    cooldown: opts.cooldown ?? 5,
    damage: opts.damage ?? 28,
    radius: opts.radius ?? 2.4,
    range: opts.range ?? 18,
    speed: opts.speed ?? 28,
    color: opts.color,
    texture: opts.texture,
    impact: opts.impact ?? opts.texture,
    blurb: opts.blurb ?? name,
    mobility: opts.mobility,
    taunt: opts.taunt,
  };
}

/** 20 ranged — travel projectiles, Avatar fire/water/earth/air skins. */
const RANGED: LibraryAbility[] = [
  ab("ember_bolt", "Ember Bolt", "projectile", "fire", "ranged", { color: 0xff6a1a, texture: TEX.fire, speed: 32, range: 28, damage: 34, radius: 1.8, blurb: "Fire family needle." }),
  ab("cinder_lance", "Cinder Lance", "projectile", "fire", "ranged", { color: 0xff3d10, texture: TEX.fire, speed: 26, range: 32, damage: 42, radius: 2.2, blurb: "Long fire lance." }),
  ab("magma_shot", "Magma Shot", "projectile", "fire", "ranged", { color: 0xffb02e, texture: TEX.fire, speed: 20, range: 22, damage: 48, radius: 3.0, forceCost: 28, blurb: "Heavy molten glob." }),
  ab("flare_needle", "Flare Needle", "projectile", "fire", "ranged", { color: 0xfff6d8, texture: TEX.crit, speed: 44, range: 36, damage: 26, radius: 1.2, blurb: "Hot white pin." }),
  ab("sun_spear", "Sun Spear", "projectile", "fire", "ranged", { color: 0xff7a26, texture: TEX.fire, speed: 30, range: 34, damage: 40, radius: 2.0, blurb: "Bright fire spear." }),
  ab("frost_shard", "Frost Shard", "projectile", "water", "ranged", { color: 0x31b6ff, texture: TEX.frost, speed: 28, range: 26, damage: 32, radius: 1.6, blurb: "Water family ice dart." }),
  ab("tide_needle", "Tide Needle", "projectile", "water", "ranged", { color: 0x2ec4d6, texture: TEX.frost, speed: 36, range: 30, damage: 28, radius: 1.4, blurb: "Thin aqua bolt." }),
  ab("ice_javelin", "Ice Javelin", "projectile", "water", "ranged", { color: 0x8fd8ff, texture: TEX.ice, speed: 24, range: 32, damage: 38, radius: 2.0, blurb: "Heavy frost javelin." }),
  ab("mist_bolt", "Mist Bolt", "projectile", "water", "ranged", { color: 0xeaf9ff, texture: TEX.heal, speed: 22, range: 24, damage: 22, radius: 2.6, blurb: "Soft mist glob." }),
  ab("glacier_arrow", "Glacier Arrow", "projectile", "water", "ranged", { color: 0x052a45, texture: TEX.ice, speed: 40, range: 38, damage: 36, radius: 1.5, blurb: "Deep-blue arrow." }),
  ab("wind_needle", "Wind Needle", "projectile", "air", "ranged", { color: 0xc9f0ff, texture: TEX.arcane, speed: 48, range: 34, damage: 24, radius: 1.1, blurb: "Air family pin." }),
  ab("gale_bolt", "Gale Bolt", "projectile", "air", "ranged", { color: 0xb6d8ea, texture: TEX.arcane, speed: 38, range: 30, damage: 30, radius: 1.8, blurb: "Pale gale shot." }),
  ab("storm_pin", "Storm Pin", "projectile", "air", "ranged", { color: 0xbfe8ff, texture: TEX.crit, speed: 50, range: 40, damage: 22, radius: 1.0, blurb: "Fastest air dart." }),
  ab("zephyr_shot", "Zephyr Shot", "projectile", "air", "ranged", { color: 0xf4fcff, texture: TEX.heal, speed: 34, range: 28, damage: 26, radius: 1.6, blurb: "Soft air puff shot." }),
  ab("vacuum_dart", "Vacuum Dart", "projectile", "air", "ranged", { color: 0x9ec2ff, texture: TEX.arcane, speed: 42, range: 32, damage: 28, radius: 1.3, blurb: "Sucking air dart." }),
  ab("stone_chip", "Stone Chip", "projectile", "earth", "ranged", { color: 0xb98a4d, texture: TEX.hit, speed: 22, range: 20, damage: 36, radius: 2.0, blurb: "Earth family chip." }),
  ab("pebble_shot", "Pebble Shot", "projectile", "earth", "ranged", { color: 0x6b5744, texture: TEX.hit, speed: 28, range: 24, damage: 30, radius: 1.5, blurb: "Fast pebble." }),
  ab("crystal_bolt", "Crystal Bolt", "projectile", "earth", "ranged", { color: 0xc9a06a, texture: TEX.crit, speed: 26, range: 26, damage: 38, radius: 1.8, blurb: "Hard crystal." }),
  ab("dust_lance", "Dust Lance", "projectile", "earth", "ranged", { color: 0x8a7355, texture: TEX.hit, speed: 20, range: 22, damage: 34, radius: 2.4, blurb: "Dusty spear." }),
  ab("slag_round", "Slag Round", "projectile", "earth", "ranged", { color: 0x3a2e24, texture: TEX.fire, speed: 18, range: 18, damage: 44, radius: 2.8, forceCost: 28, blurb: "Heavy slag ball." }),
];

/** 10 AOE — nova rings, Avatar impact colors. */
const AOE: LibraryAbility[] = [
  ab("cinder_nova", "Cinder Nova", "nova", "fire", "aoe", { color: 0xff6a1a, texture: TEX.fire, impact: TEX.crit, damage: 36, radius: 6.0, range: 0, speed: 0, cooldown: 7, blurb: "Fire ring." }),
  ab("magma_ring", "Magma Ring", "nova", "fire", "aoe", { color: 0xff3d10, texture: TEX.fire, damage: 42, radius: 5.2, range: 0, speed: 0, cooldown: 8, blurb: "Tight hot ring." }),
  ab("tide_burst", "Tide Burst", "nova", "water", "aoe", { color: 0x31b6ff, texture: TEX.frost, impact: TEX.ice, damage: 30, radius: 6.4, range: 0, speed: 0, cooldown: 7, blurb: "Water splash nova." }),
  ab("frost_bloom", "Frost Bloom", "nova", "water", "aoe", { color: 0x8fd8ff, texture: TEX.ice, damage: 28, radius: 7.0, range: 0, speed: 0, cooldown: 8, blurb: "Wide frost flower." }),
  ab("earth_stomp", "Earth Stomp", "nova", "earth", "aoe", { color: 0xb98a4d, texture: TEX.hit, damage: 40, radius: 5.0, range: 0, speed: 0, cooldown: 7, blurb: "Ground slam." }),
  ab("quake_ring", "Quake Ring", "nova", "earth", "aoe", { color: 0x6b5744, texture: TEX.crit, damage: 38, radius: 6.8, range: 0, speed: 0, cooldown: 9, blurb: "Wide quake." }),
  ab("gale_burst", "Gale Burst", "nova", "air", "aoe", { color: 0xc9f0ff, texture: TEX.arcane, damage: 26, radius: 6.2, range: 0, speed: 0, cooldown: 6, blurb: "Air pop." }),
  ab("cyclone_ring", "Cyclone Ring", "nova", "air", "aoe", { color: 0xbfe8ff, texture: TEX.arcane, damage: 32, radius: 7.2, range: 0, speed: 0, cooldown: 8, blurb: "Spinning air ring." }),
  ab("holy_bloom", "Holy Bloom", "nova", "water", "aoe", { color: 0xb8ff88, texture: TEX.heal, damage: 18, radius: 5.5, range: 0, speed: 0, cooldown: 8, blurb: "Heal-tinted nova (still damages foes)." }),
  ab("ember_pulse", "Ember Pulse", "nova", "fire", "aoe", { color: 0xffb02e, texture: TEX.fire, damage: 34, radius: 4.8, range: 0, speed: 0, cooldown: 6, blurb: "Short fire pulse." }),
];

/** 10 force-push — radial knock, same ring as R Force Push. */
const PUSH: LibraryAbility[] = [
  ab("fire_blast", "Fire Blast", "push", "fire", "push", { color: 0xff6a1a, texture: TEX.fire, damage: 12, radius: 7, range: 0, speed: 0, cooldown: 6, forceCost: 28, blurb: "Hot shockwave." }),
  ab("steam_burst", "Steam Burst", "push", "water", "push", { color: 0xeaf9ff, texture: TEX.heal, damage: 8, radius: 6.5, range: 0, speed: 0, cooldown: 5, blurb: "Steam shove." }),
  ab("earth_heave", "Earth Heave", "push", "earth", "push", { color: 0xb98a4d, texture: TEX.hit, damage: 16, radius: 6, range: 0, speed: 0, cooldown: 7, forceCost: 32, blurb: "Ground heave." }),
  ab("air_cannon", "Air Cannon", "push", "air", "push", { color: 0xc9f0ff, texture: TEX.arcane, damage: 10, radius: 8, range: 0, speed: 0, cooldown: 5, blurb: "Wide air shove." }),
  ab("vacuum_push", "Vacuum Push", "push", "air", "push", { color: 0x9ec2ff, texture: TEX.arcane, damage: 8, radius: 7.5, range: 0, speed: 0, cooldown: 6, blurb: "Sucking then shove." }),
  ab("tide_surge", "Tide Surge", "push", "water", "push", { color: 0x31b6ff, texture: TEX.frost, damage: 10, radius: 7, range: 0, speed: 0, cooldown: 6, blurb: "Water wall push." }),
  ab("shockwave", "Shockwave", "push", "force", "push", { color: 0xe8e8ff, texture: TEX.crit, damage: 14, radius: 7.2, range: 0, speed: 0, cooldown: 6, blurb: "Neutral force ring." }),
  ab("war_shout", "War Shout", "push", "force", "push", { color: 0xff5533, texture: TEX.crit, damage: 10, radius: 6, range: 0, speed: 0, cooldown: 7, taunt: true, blurb: "Taunting shove." }),
  ab("ember_wave", "Ember Wave", "push", "fire", "push", { color: 0xffb02e, texture: TEX.fire, damage: 12, radius: 6.4, range: 0, speed: 0, cooldown: 5, blurb: "Low fire wave." }),
  ab("gale_wall", "Gale Wall", "push", "air", "push", { color: 0xb6d8ea, texture: TEX.arcane, damage: 9, radius: 8.5, range: 0, speed: 0, cooldown: 7, blurb: "Broad air wall." }),
];

/** 10 mobility — existing whirlwind dash path. */
const MOBILITY: LibraryAbility[] = [
  ab("flame_dash", "Flame Dash", "dash", "fire", "mobility", { color: 0xff6a1a, texture: TEX.fire, damage: 28, radius: 2.8, range: 12, speed: 50, cooldown: 5, mobility: true, blurb: "Fire dash." }),
  ab("ice_slide", "Ice Slide", "dash", "water", "mobility", { color: 0x31b6ff, texture: TEX.frost, damage: 22, radius: 2.4, range: 14, speed: 46, cooldown: 5, mobility: true, blurb: "Ice slide." }),
  ab("earth_lunge", "Earth Lunge", "dash", "earth", "mobility", { color: 0xb98a4d, texture: TEX.hit, damage: 34, radius: 3.0, range: 10, speed: 40, cooldown: 6, mobility: true, blurb: "Short heavy lunge." }),
  ab("air_step", "Air Step", "dash", "air", "mobility", { color: 0xc9f0ff, texture: TEX.arcane, damage: 18, radius: 2.2, range: 16, speed: 58, cooldown: 4, mobility: true, blurb: "Long air step." }),
  ab("blink_gale", "Blink Gale", "dash", "air", "mobility", { color: 0xf4fcff, texture: TEX.heal, damage: 14, radius: 2.0, range: 18, speed: 64, cooldown: 6, mobility: true, blurb: "Farthest dash." }),
  ab("ember_roll", "Ember Roll", "dash", "fire", "mobility", { color: 0xffb02e, texture: TEX.fire, damage: 24, radius: 2.6, range: 11, speed: 48, cooldown: 4, mobility: true, blurb: "Short fire roll." }),
  ab("tide_rush", "Tide Rush", "dash", "water", "mobility", { color: 0x2ec4d6, texture: TEX.frost, damage: 20, radius: 2.8, range: 13, speed: 44, cooldown: 5, mobility: true, blurb: "Water rush." }),
  ab("stone_charge", "Stone Charge", "dash", "earth", "mobility", { color: 0x6b5744, texture: TEX.hit, damage: 38, radius: 3.2, range: 9, speed: 36, cooldown: 6, mobility: true, blurb: "Slow stone charge." }),
  ab("wind_whirl", "Wind Whirl", "dash", "air", "mobility", { color: 0xbfe8ff, texture: TEX.arcane, damage: 26, radius: 3.4, range: 14, speed: 52, cooldown: 5, mobility: true, blurb: "Whirl dash." }),
  ab("shadow_step", "Shadow Step", "dash", "force", "mobility", { color: 0x446688, texture: TEX.hit, damage: 20, radius: 2.2, range: 15, speed: 56, cooldown: 5, mobility: true, blurb: "Dark step." }),
];

export const ABILITY_LIBRARY: LibraryAbility[] = [
  ...RANGED,
  ...AOE,
  ...PUSH,
  ...MOBILITY,
];

export const LIBRARY_COUNTS = {
  ranged: RANGED.length,
  aoe: AOE.length,
  push: PUSH.length,
  mobility: MOBILITY.length,
  total: ABILITY_LIBRARY.length,
} as const;

export function libraryByRole(role: AbilityRole): LibraryAbility[] {
  return ABILITY_LIBRARY.filter((a) => a.role === role);
}

export function findLibraryAbility(id: string): LibraryAbility | undefined {
  return ABILITY_LIBRARY.find((a) => a.id === id);
}

/** Copy a library row onto a class Q/E slot (keeps the slot key). */
export function assignLibraryToSkill(
  lib: LibraryAbility,
  slotKey: string,
): SkillDef {
  const { family: _f, role: _r, ...skill } = lib;
  return { ...skill, key: slotKey };
}

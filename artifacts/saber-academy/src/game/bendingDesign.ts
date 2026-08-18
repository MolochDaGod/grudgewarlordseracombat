/**
 * AvatarCastingAbilitiesThreeJS (playground) → combat linear casts.
 * Source: github.com/MolochDaGod/AvatarCastingAbilitiesThreeJS
 *   abilities/{Fire,Water,Earth,Wind}Ability + config/settings.js ELEMENT_META
 *
 * Product SSOT stays CastingAbilitiesThreeJS / combat CastingSystem.
 * We do NOT port volumetric fire, ocean march, earth paving, or windsurf IK.
 * These presets retint + retune the existing 1–6 casts and puff primitives.
 */
import type { CastElement } from "./casting";
import type { ParticleElement } from "./smokePuff";
import type { ClipName } from "./animations";
import type { WeaponSkillCatalog } from "./skillcatalog";

export type BendId = "fire" | "water" | "earth" | "wind";

export interface BendDesign {
  id: BendId;
  label: string;
  hint: string;
  accent: string;
  /** Existing combat CastElement this design drives. */
  combatElement: CastElement;
  puff: ParticleElement;
  clip: ClipName;
  speed: number;
  color: string;
  glow: number;
  shake: number;
  radius: number;
  flightHeight: number;
}

/** Avatar ELEMENT_META + settings.{fire,water,earth,wind} cruise numbers. */
export const BEND_DESIGNS: Record<BendId, BendDesign> = {
  fire: {
    id: "fire",
    label: "Fire",
    hint: "Firebending — meteor + fire puff",
    accent: "#ff6a1a",
    combatElement: "fire",
    puff: "fire",
    clip: "cast",
    speed: 11.5,
    color: "#ff6a1a",
    glow: 1.4,
    shake: 1,
    radius: 3,
    flightHeight: 1,
  },
  water: {
    id: "water",
    label: "Water",
    hint: "Waterbending — frost lance + cool heal",
    accent: "#31b6ff",
    combatElement: "ice",
    puff: "frost",
    clip: "cast2",
    speed: 7.5,
    color: "#31b6ff",
    glow: 0.8,
    shake: 0.6,
    radius: 2.2,
    flightHeight: 1,
  },
  earth: {
    id: "earth",
    label: "Earth",
    hint: "Earthbending — ground snare + crust smoke",
    accent: "#b98a4d",
    combatElement: "snare",
    puff: "smoke",
    clip: "cast3",
    speed: 6,
    color: "#b98a4d",
    glow: 1.1,
    shake: 1.5,
    radius: 3.2,
    flightHeight: 0,
  },
  wind: {
    id: "wind",
    label: "Air",
    hint: "Airbending — storm bolt + pale trail",
    accent: "#c9f0ff",
    combatElement: "thunder",
    puff: "frost",
    clip: "cast",
    speed: 14,
    color: "#c9f0ff",
    glow: 0.95,
    shake: 0.42,
    radius: 2,
    flightHeight: 0.4,
  },
};

export const BEND_IDS: BendId[] = ["fire", "water", "earth", "wind"];

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16) || 0xffffff;
}

/** Paint an Avatar bend onto the matching combat cast + puff primitive. */
export function applyBendDesign(
  cat: WeaponSkillCatalog,
  id: BendId,
): WeaponSkillCatalog {
  const d = BEND_DESIGNS[id];
  const next = structuredClone(cat);
  const cast = next.elementalCasts.find((c) => c.element === d.combatElement);
  if (cast) {
    cast.color = hexToInt(d.color);
    cast.speed = d.speed;
    cast.radius = d.radius;
    cast.knock = Math.round(8 + d.shake * 6);
  }
  next.effects = next.effects ?? [];
  let puff = next.effects.find((e) => e.kind === d.puff || e.meshId === d.puff);
  if (!puff) {
    puff = {
      kind: d.puff,
      intensity: d.glow,
      aoe: d.radius,
      speed: d.speed,
      size: 0.75,
      color: d.color,
      meshId: d.puff,
      duration: 0.7,
      attach: "root",
      effectId: `bend-${id}`,
    };
    next.effects.push(puff);
  } else {
    puff.color = d.color;
    puff.intensity = d.glow;
    puff.aoe = d.radius;
  }
  if (next.linear?.global) {
    next.linear.global.glow = d.glow;
    next.linear.global.cameraShake = d.shake;
    next.linear.global.speed = Math.max(0.5, d.speed / 12);
  }
  next.bending = { ...(next.bending ?? {}), selected: id };
  return next;
}

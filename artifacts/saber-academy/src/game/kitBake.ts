/**
 * Bake + diagnose a combat kit: skeleton names, visible meshes, SI height,
 * feet from bone min.y (never pelvis). Stamps userData for the live AI debugger.
 * Does not rename bones (mixer already bound) — records canonical aliases.
 */
import * as THREE from "three";

const BONE_ALIASES = {
  hips: ["bip001pelvis", "mixamorighips", "mixamorig:hips", "hips", "pelvis"],
  spine: ["bip001spine", "mixamorigspine", "mixamorig:spine", "spine"],
  head: ["bip001head", "mixamorighead", "mixamorig:head", "head"],
  handR: [
    "bip001rhand",
    "mixamorigrighthand",
    "mixamorig:righthand",
    "righthand",
    "handr",
  ],
  handL: [
    "bip001lhand",
    "mixamoriglefthand",
    "mixamorig:lefthand",
    "lefthand",
    "handl",
  ],
  footR: [
    "bip001rfoot",
    "mixamorigrightfoot",
    "mixamorig:rightfoot",
    "rightfoot",
    "footr",
  ],
  footL: [
    "bip001lfoot",
    "mixamorigleftfoot",
    "mixamorig:leftfoot",
    "leftfoot",
    "footl",
  ],
} as const;

export type KitBoneRole = keyof typeof BONE_ALIASES;

export interface KitBake {
  heightM: number;
  feetMinY: number;
  hips: string | null;
  spine: string | null;
  head: string | null;
  handR: string | null;
  handL: string | null;
  footL: string | null;
  footR: string | null;
  meshes: string[];
  boneCount: number;
  errors: string[];
  ok: boolean;
  rigHint: string;
}

function norm(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function pickBone(root: THREE.Object3D, aliases: readonly string[]): THREE.Bone | null {
  let hit: THREE.Bone | null = null;
  root.traverse((o) => {
    if (hit) return;
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const n = norm(b.name);
    if (aliases.some((a) => n === a || n.endsWith(a))) hit = b;
  });
  return hit;
}

function boneSpan(root: THREE.Object3D): { minY: number; maxY: number } | null {
  root.updateMatrixWorld(true);
  let minY = Infinity;
  let maxY = -Infinity;
  root.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const p = b.getWorldPosition(new THREE.Vector3());
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  if (!Number.isFinite(minY) || maxY - minY < 0.15) return null;
  return { minY, maxY };
}

export function bakeKit(root: THREE.Object3D, rigHint = "unknown"): KitBake {
  const errors: string[] = [];
  const hips = pickBone(root, BONE_ALIASES.hips);
  const spine = pickBone(root, BONE_ALIASES.spine);
  const head = pickBone(root, BONE_ALIASES.head);
  const handR = pickBone(root, BONE_ALIASES.handR);
  const handL = pickBone(root, BONE_ALIASES.handL);
  const footL = pickBone(root, BONE_ALIASES.footL);
  const footR = pickBone(root, BONE_ALIASES.footR);

  let boneCount = 0;
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) boneCount++;
  });

  const meshes: string[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    if (m.name) meshes.push(m.name);
  });

  const span = boneSpan(root);
  const heightM = span ? span.maxY - span.minY : 0;
  const feetMinY = span ? span.minY : 0;

  if (boneCount === 0) errors.push("no skeleton bones");
  if (!hips) errors.push("hips/pelvis name not found");
  if (!footL && !footR) errors.push("no foot bones (grounding will use mesh AABB)");
  if (!handR && !handL) errors.push("no hand bones");
  if (meshes.length === 0) errors.push("no visible meshes");
  if (heightM > 0 && (heightM < 1.45 || heightM > 2.25)) {
    errors.push(`height ${heightM.toFixed(2)} m outside SI hero band`);
  }
  if (span && Math.abs(span.minY) > 0.12) {
    errors.push(`feet min.y ${span.minY.toFixed(3)} not grounded`);
  }

  return {
    heightM,
    feetMinY,
    hips: hips?.name ?? null,
    spine: spine?.name ?? null,
    head: head?.name ?? null,
    handR: handR?.name ?? null,
    handL: handL?.name ?? null,
    footL: footL?.name ?? null,
    footR: footR?.name ?? null,
    meshes: meshes.slice(0, 12),
    boneCount,
    errors,
    ok: errors.length === 0,
    rigHint,
  };
}

export function stampKitBake(root: THREE.Object3D, bake: KitBake): void {
  root.userData.kitBake = bake;
  root.userData.warlordsPlayContract = {
    loader: "combat-kitBake",
    heightM: bake.heightM,
    feetMinY: bake.feetMinY,
    hips: bake.hips,
    handR: bake.handR,
    face: "+Z",
    ok: bake.ok,
  };
}

export function firstSkinned(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let hit: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (hit) return;
    const s = o as THREE.SkinnedMesh;
    if (s.isSkinnedMesh) hit = s;
  });
  return hit;
}

/**
 * One-mixer combat assistance: overlay queue + feet plant on the same
 * groundAt used by the body. Never a second mixer. Never pose() the skeleton.
 */
import * as THREE from "three";
import type { ClipName } from "./animations";
import type { CharacterInstance } from "./characters";

const FOOT_RE = /(bip001[lr]foot|leftfoot|rightfoot)$/;
const QUEUE_CAP = 2;

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function resolveFootBones(inst: CharacterInstance): THREE.Bone[] {
  if (inst.footBones) return inst.footBones;
  const found: THREE.Bone[] = [];
  inst.group.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone && FOOT_RE.test(sanitize(b.name))) found.push(b);
  });
  inst.footBones = found;
  return found;
}

const _cur = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const _delta = new THREE.Vector3();

/**
 * Plant feet on terrain after mixer.update. Same height field as root ground.
 * Only when grounded; small lift so we do not fight authored stride.
 */
export function applyFootIk(
  inst: CharacterInstance,
  groundAt: (x: number, z: number) => number,
): void {
  const bones = resolveFootBones(inst);
  if (!bones.length) return;
  inst.group.updateWorldMatrix(true, true);
  for (const bone of bones) {
    const parent = bone.parent;
    if (!parent) continue;
    bone.updateWorldMatrix(true, false);
    _cur.setFromMatrixPosition(bone.matrixWorld);
    const gy = groundAt(_cur.x, _cur.z);
    const dy = gy - _cur.y;
    if (dy <= -0.06 || dy >= 0.28) continue;
    _tgt.copy(_cur);
    _tgt.y = gy;
    parent.updateWorldMatrix(true, false);
    parent.worldToLocal(_tgt);
    parent.worldToLocal(_cur);
    _delta.copy(_tgt).sub(_cur);
    bone.position.add(_delta);
  }
}

/** Queue a one-shot if an overlay is already playing. */
export function queueOneShot(inst: CharacterInstance, name: ClipName): void {
  inst.animQueue ??= [];
  if (inst.overlayClip === name) return;
  if (inst.overlayClip) {
    if (inst.animQueue.length < QUEUE_CAP && !inst.animQueue.includes(name)) {
      inst.animQueue.push(name);
    }
    return;
  }
  inst.overlayClip = name;
}

export function finishOverlay(inst: CharacterInstance): ClipName | null {
  inst.overlayClip = null;
  const next = inst.animQueue?.shift() ?? null;
  if (next) inst.overlayClip = next;
  return next;
}

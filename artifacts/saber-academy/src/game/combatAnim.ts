/**
 * One-mixer combat assistance: overlay queue + feet plant on the same
 * groundAt used by the body. Never a second mixer. Never pose() the skeleton.
 */
import * as THREE from "three";
import type { ClipName } from "./animations";
import type { CharacterInstance } from "./characters";

const FOOT_RE = /(bip001[lr]foot|leftfoot|rightfoot)$/;
const QUEUE_CAP = 2;
const STANCE_MAX_SHIFT = 0.55;
const FOOT_LIFT = 0.02;
const FOOT_MAX_UP = 0.42;
const FOOT_MAX_DOWN = 0.55;

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
const _q = new THREE.Quaternion();
const _inv = new THREE.Quaternion();

/**
 * Keep the physics root (group) between the two feet. Mixamo-on-Bip001
 * swings the hips off the stance; shift `inner` in XZ so the midpoint of
 * the foot bones sits under the capsule. Same mesh groundAt is used next
 * to plant Y. Clamped so a one-legged pose cannot yank the kit.
 */
export function centerStanceOnRoot(inst: CharacterInstance): void {
  const feet = resolveFootBones(inst);
  if (feet.length < 2 || !inst.inner) return;
  inst.group.updateWorldMatrix(true, true);
  let mx = 0;
  let mz = 0;
  let n = 0;
  for (const f of feet) {
    f.updateWorldMatrix(true, false);
    _cur.setFromMatrixPosition(f.matrixWorld);
    mx += _cur.x;
    mz += _cur.z;
    n++;
  }
  mx /= n;
  mz /= n;
  inst.group.getWorldPosition(_tgt);
  _delta.set(_tgt.x - mx, 0, _tgt.z - mz);
  const dist = Math.hypot(_delta.x, _delta.z);
  if (dist < 0.008) return;
  if (dist > STANCE_MAX_SHIFT) _delta.multiplyScalar(STANCE_MAX_SHIFT / dist);
  inst.group.getWorldQuaternion(_q);
  _inv.copy(_q).invert();
  _delta.applyQuaternion(_inv);
  inst.inner.position.x += _delta.x;
  inst.inner.position.z += _delta.z;
}

/**
 * Plant feet on the **mesh** height field after mixer.update + stance center.
 * Same groundAt as the body. Un-penetrate always; pull hover down within
 * stride. Leave true airborne kicks (dy > FOOT_MAX_UP) authored.
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
    const dy = gy + FOOT_LIFT - _cur.y;
    if (dy > FOOT_MAX_UP) continue;
    const apply = THREE.MathUtils.clamp(dy, -FOOT_MAX_DOWN, FOOT_MAX_UP);
    if (Math.abs(apply) < 0.008) continue;
    _tgt.copy(_cur);
    _tgt.y = _cur.y + apply;
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

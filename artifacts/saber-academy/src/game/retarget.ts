import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ClipName, RawClip } from "./animations";

// Retarget the Mixamo clip library (authored on the "mixamorig:" skeleton) onto
// the Grudge champions' 3ds Max Biped (Bip001) skeleton. The Grudge GLBs ship
// with NO embedded animations, so without this they could only be animated
// procedurally. All six races share an identical 18-joint Bip001 rig, so we bake
// each clip once and reuse the result across every champion.
//
// Method (verified numerically headless, where WebGL cannot run): a world-space
// delta bake. For each mapped bone and frame:
//   deltaWorld = qSourceAnimWorld * qSourceBindWorld^-1   (rotation source moved through)
//   qTargetWorld = (F * deltaWorld * F^-1) * qTargetBindWorld
//   qTargetLocal = qTargetParentWorld^-1 * qTargetWorld   (parents processed first)
// where F is a small frame-alignment correction between the two skeletons'
// authoring bases. Because deltaWorld is identity at the source bind pose, each
// skeleton's own (different) bind pose is preserved automatically with no manual
// per-bone offsets. Bone lengths are untouched (rotation-only), so nothing
// stretches. Output tracks are node-name based ("<bone>.quaternion") so the mixer
// binds against the model group exactly like the mixamorig path.

// Bip001 target bone -> mixamorig source bone. Source names are matched
// colon-insensitively (FBXLoader sanitizes "mixamorig:Hips" to "mixamorigHips").
const BIP001_BONE_MAP: Record<string, string> = {
  "Bip001 Pelvis": "mixamorig:Hips",
  // Toon / 3ds Max Biped has ONE spine bone. Mixamo Spine1 is the chest —
  // dumping that onto Bip001 Spine folds both arms into the gut (Ser Roland).
  // Character-Animator DEFAULT_BONE_MAP: Bip001_Spine → mixamorigSpine.
  "Bip001 Spine": "mixamorig:Spine",
  "Bip001 Neck": "mixamorig:Neck",
  "Bip001 Head": "mixamorig:Head",
  "Bip001 L Clavicle": "mixamorig:LeftShoulder",
  "Bip001 L UpperArm": "mixamorig:LeftArm",
  "Bip001 L Forearm": "mixamorig:LeftForeArm",
  "Bip001 L Hand": "mixamorig:LeftHand",
  "Bip001 R Clavicle": "mixamorig:RightShoulder",
  "Bip001 R UpperArm": "mixamorig:RightArm",
  "Bip001 R Forearm": "mixamorig:RightForeArm",
  "Bip001 R Hand": "mixamorig:RightHand",
  "Bip001 L Thigh": "mixamorig:LeftUpLeg",
  "Bip001 L Calf": "mixamorig:LeftLeg",
  "Bip001 L Foot": "mixamorig:LeftFoot",
  "Bip001 R Thigh": "mixamorig:RightUpLeg",
  "Bip001 R Calf": "mixamorig:RightLeg",
  "Bip001 R Foot": "mixamorig:RightFoot",
};

// Meshy auto-rig target bone -> mixamorig source bone. Meshy's rigger emits
// Mixamo-style names WITHOUT the "mixamorig:" prefix ("Hips", "Spine01",
// lowercase "neck", ...), so the same world-delta bake retargets the Mixamo
// library onto Meshy characters with just this different name map. Only bones
// guaranteed to exist in the Mixamo sources are mapped (no toes / head_end).
const MESHY_BONE_MAP: Record<string, string> = {
  Hips: "mixamorig:Hips",
  Spine: "mixamorig:Spine",
  Spine01: "mixamorig:Spine1",
  Spine02: "mixamorig:Spine2",
  neck: "mixamorig:Neck",
  Head: "mixamorig:Head",
  LeftShoulder: "mixamorig:LeftShoulder",
  LeftArm: "mixamorig:LeftArm",
  LeftForeArm: "mixamorig:LeftForeArm",
  LeftHand: "mixamorig:LeftHand",
  RightShoulder: "mixamorig:RightShoulder",
  RightArm: "mixamorig:RightArm",
  RightForeArm: "mixamorig:RightForeArm",
  RightHand: "mixamorig:RightHand",
  LeftUpLeg: "mixamorig:LeftUpLeg",
  LeftLeg: "mixamorig:LeftLeg",
  LeftFoot: "mixamorig:LeftFoot",
  RightUpLeg: "mixamorig:RightUpLeg",
  RightLeg: "mixamorig:RightLeg",
  RightFoot: "mixamorig:RightFoot",
};

// Standout (itch.io low-poly minion packs) target bone -> mixamorig source
// bone. These FBX characters use a Blender "basic human" rig: spine (root/hips),
// spine001..spine006 up the torso/neck/head, upper_armL/forearmL/handL style
// limbs. No fingers/toes are mapped (the sources don't guarantee them), and
// spine006 (head tip) plus pelvisL/R + heel helpers are left unmapped on purpose.
const STANDOUT_BONE_MAP: Record<string, string> = {
  spine: "mixamorig:Hips",
  spine001: "mixamorig:Spine",
  spine002: "mixamorig:Spine1",
  spine003: "mixamorig:Spine2",
  spine004: "mixamorig:Neck",
  spine005: "mixamorig:Head",
  shoulderL: "mixamorig:LeftShoulder",
  upper_armL: "mixamorig:LeftArm",
  forearmL: "mixamorig:LeftForeArm",
  handL: "mixamorig:LeftHand",
  shoulderR: "mixamorig:RightShoulder",
  upper_armR: "mixamorig:RightArm",
  forearmR: "mixamorig:RightForeArm",
  handR: "mixamorig:RightHand",
  thighL: "mixamorig:LeftUpLeg",
  shinL: "mixamorig:LeftLeg",
  footL: "mixamorig:LeftFoot",
  thighR: "mixamorig:RightUpLeg",
  shinR: "mixamorig:RightLeg",
  footR: "mixamorig:RightFoot",
};

/** Landmark bones (target names) used to compute the frame correction F. */
interface BasisBones {
  head: string;
  pelvis: string;
  rArm: string;
  lArm: string;
}
const BIP001_BASIS: BasisBones = {
  head: "Bip001 Head",
  pelvis: "Bip001 Pelvis",
  rArm: "Bip001 R UpperArm",
  lArm: "Bip001 L UpperArm",
};
const MESHY_BASIS: BasisBones = {
  head: "Head",
  pelvis: "Hips",
  rArm: "RightArm",
  lArm: "LeftArm",
};
const STANDOUT_BASIS: BasisBones = {
  head: "spine005",
  pelvis: "spine",
  rArm: "upper_armR",
  lArm: "upper_armL",
};

export type RetargetRig = "bip001" | "meshy" | "standout";

/**
 * Which retargetable skeleton (if any) a loaded template carries. Bip001 is
 * checked first since it is the primary Grudge rig; a Meshy rig is recognized
 * by its prefix-less Mixamo-style names (which must NOT be an actual mixamorig
 * skeleton — those play the library directly without retargeting).
 */
export function detectRetargetRig(root: THREE.Object3D): RetargetRig | null {
  const bones = collectBonesNormalized(root);
  if (bones.has(norm("Bip001 Pelvis"))) return "bip001";
  if (bones.has(norm("upper_armL")) && bones.has(norm("spine001"))) {
    return "standout";
  }
  if (
    bones.has(norm("Hips")) &&
    bones.has(norm("LeftForeArm")) &&
    !bones.has(norm("mixamorig:Hips"))
  ) {
    return "meshy";
  }
  return null;
}

const FPS = 30;
const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

export type Bip001Clips = Record<ClipName, THREE.AnimationClip>;

// Cached per cache key (one key per weapon category): all six races share the
// same 18-joint Bip001 rig, so a category's clip set is baked once and reused
// across every champion that uses that category.
// Bounded bake cache. Bip001 entries key per category (all Grudge races share
// one rig), but Meshy entries key per model x category, so an unbounded map
// would grow with every generated character for the browser's lifetime. Evict
// the oldest entry (Map iteration order) past the cap; a re-selected hero just
// re-bakes.
const CACHE_MAX = 24;
const cache = new Map<string, Bip001Clips>();

function collectBonesNormalized(root: THREE.Object3D): Map<string, THREE.Bone> {
  const m = new Map<string, THREE.Bone>();
  // Keep the FIRST depth-first match per name. Some FBX rigs (the Standout
  // minion packs) carry duplicate-named nested bone chains — one per skinned
  // mesh binding. The mixer's PropertyBinding also resolves a track name to the
  // first depth-first match, so baking against the same bone keeps the bake's
  // bind/local frames and the runtime binding in agreement; inner duplicates
  // inherit the rotation through the hierarchy.
  root.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone && !m.has(norm(b.name))) m.set(norm(b.name), b);
  });
  return m;
}

function worldPos(b: THREE.Object3D): THREE.Vector3 {
  return b.getWorldPosition(new THREE.Vector3());
}

/** A rotation whose basis is (right, up, forward) derived from skeleton landmarks. */
function basisQuat(
  head: THREE.Object3D,
  pelvis: THREE.Object3D,
  rArm: THREE.Object3D,
  lArm: THREE.Object3D,
): THREE.Quaternion {
  const up = worldPos(head).sub(worldPos(pelvis)).normalize();
  let right = worldPos(rArm).sub(worldPos(lArm)).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
  right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, fwd),
  );
}

function bakeOne(
  raw: RawClip,
  target: THREE.Object3D,
  tBones: Map<string, THREE.Bone>,
  tBind: Map<string, THREE.Quaternion>,
  tRest: Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>,
  depthOrder: string[],
  F: THREE.Quaternion,
  Finv: THREE.Quaternion,
  boneMap: Record<string, string>,
): THREE.AnimationClip {
  raw.object.updateMatrixWorld(true);
  const sBones = collectBonesNormalized(raw.object);
  const srcBone = (n: string): THREE.Bone => sBones.get(norm(n))!;

  // Source bind (rest) world quaternions — read before any mixer plays.
  const sBind = new Map<string, THREE.Quaternion>();
  for (const s of Object.values(boneMap)) {
    sBind.set(s, srcBone(s).getWorldQuaternion(new THREE.Quaternion()));
  }

  const numFrames = Math.max(2, Math.round(raw.clip.duration * FPS));
  const times = new Float32Array(numFrames);
  const values = new Map<string, Float32Array>();
  for (const t of Object.keys(boneMap)) values.set(t, new Float32Array(numFrames * 4));

  const mixer = new THREE.AnimationMixer(raw.object);
  mixer.clipAction(raw.clip).play();

  for (let i = 0; i < numFrames; i++) {
    const time = i / FPS;
    times[i] = time;
    mixer.setTime(time);
    raw.object.updateMatrixWorld(true);

    const sAnim = new Map<string, THREE.Quaternion>();
    for (const s of Object.values(boneMap)) {
      sAnim.set(s, srcBone(s).getWorldQuaternion(new THREE.Quaternion()));
    }

    // Reset target to bind, then drive mapped bones parent-first.
    for (const [name, b] of tBones) {
      const r = tRest.get(name)!;
      b.position.copy(r.p);
      b.quaternion.copy(r.q);
      b.scale.copy(r.s);
    }
    target.updateMatrixWorld(true);

    for (const tname of depthOrder) {
      const s = boneMap[tname];
      const dWorld = sAnim.get(s)!.clone().multiply(sBind.get(s)!.clone().invert());
      dWorld.premultiply(F).multiply(Finv); // F * delta * F^-1
      const qWorld = dWorld.multiply(tBind.get(tname)!); // (F d F^-1) * bind
      const bone = tBones.get(tname)!;
      const parentWorld = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
      const qLocal = parentWorld.invert().multiply(qWorld);
      bone.quaternion.copy(qLocal);
      bone.updateWorldMatrix(false, false);
      qLocal.toArray(values.get(tname)!, i * 4);
    }
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(raw.object);

  const tracks: THREE.KeyframeTrack[] = [];
  for (const tname of Object.keys(boneMap)) {
    // Bind against the bone's REAL (GLTFLoader-sanitized) name, not the
    // space-separated boneMap key, or the mixer silently finds no target.
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${tBones.get(tname)!.name}.quaternion`,
        times,
        values.get(tname)!,
      ),
    );
  }
  return new THREE.AnimationClip(raw.name, numFrames / FPS, tracks);
}

/**
 * Build (and cache) the Mixamo clip library retargeted onto the Bip001 skeleton.
 * `template` is any loaded Grudge GLB scene; `sources` are the raw Mixamo FBX
 * objects + clips. `cacheKey` (the weapon category) keys the cached result.
 * Throws if the expected bones are missing (caller should fall back to
 * procedural animation). Cached after the first successful bake per key.
 */
export function getBip001Clips(
  template: THREE.Group,
  sources: RawClip[],
  cacheKey: string,
): Bip001Clips {
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  if (!sources.length) throw new Error("Bip001 retarget: no animation sources");

  // Pick the bone map + basis landmarks for whichever retargetable skeleton
  // the template carries (Grudge Bip001 or a Meshy auto-rig).
  const rig = detectRetargetRig(template);
  if (!rig) throw new Error("retarget: template has no retargetable skeleton");
  const boneMap =
    rig === "meshy"
      ? MESHY_BONE_MAP
      : rig === "standout"
        ? STANDOUT_BONE_MAP
        : BIP001_BONE_MAP;
  const basis =
    rig === "meshy"
      ? MESHY_BASIS
      : rig === "standout"
        ? STANDOUT_BASIS
        : BIP001_BASIS;

  const target = cloneSkeleton(template);
  target.updateMatrixWorld(true);
  // GLTFLoader sanitizes node names (spaces -> underscores), so the GLB's
  // "Bip001 Pelvis" loads as "Bip001_Pelvis". Match the Bip001 target bones by
  // NORMALIZED name (strip separators + lowercase) so the lookup survives that
  // sanitization (and colons/case), exactly like the source side. tBones is keyed
  // by the canonical boneMap key, but each resolved bone keeps its real
  // (sanitized) name, which is what the output tracks bind against.
  const byNorm = collectBonesNormalized(target);
  const tBones = new Map<string, THREE.Bone>();
  for (const name of Object.keys(boneMap)) {
    const bone = byNorm.get(norm(name));
    if (!bone) {
      throw new Error(`Bip001 retarget: missing target bone "${name}"`);
    }
    tBones.set(name, bone);
  }
  // Real (sanitized) names of the resolved bones, for parent-membership tests.
  const actualBoneNames = new Set(Array.from(tBones.values(), (b) => b.name));

  // Target bind (rest) quaternions + a full rest snapshot for per-frame reset.
  const tBind = new Map<string, THREE.Quaternion>();
  const tRest = new Map<
    string,
    { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }
  >();
  for (const [name, b] of tBones) {
    tBind.set(name, b.getWorldQuaternion(new THREE.Quaternion()));
    tRest.set(name, {
      p: b.position.clone(),
      q: b.quaternion.clone(),
      s: b.scale.clone(),
    });
  }

  // Frame-alignment correction F between the two authoring bases (small in
  // practice; keeps the bake robust if a future model is rotated differently).
  const src0 = sources[0].object;
  src0.updateMatrixWorld(true);
  const sBonesN = collectBonesNormalized(src0);
  const sb = (n: string): THREE.Bone => sBonesN.get(norm(n))!;
  const tBasis = basisQuat(
    tBones.get(basis.head)!,
    tBones.get(basis.pelvis)!,
    tBones.get(basis.rArm)!,
    tBones.get(basis.lArm)!,
  );
  const sBasis = basisQuat(
    sb("mixamorig:Head"),
    sb("mixamorig:Hips"),
    sb("mixamorig:RightArm"),
    sb("mixamorig:LeftArm"),
  );
  const F = tBasis.clone().multiply(sBasis.clone().invert());
  const Finv = F.clone().invert();

  // Process bones parent-first (by Bip001 bone-ancestor depth).
  const depthOf = (n: string): number => {
    let k = 0;
    let x: THREE.Object3D | null = tBones.get(n)!;
    while (x && x.parent && actualBoneNames.has(x.parent.name)) {
      k++;
      x = x.parent;
    }
    return k;
  };
  const depthOrder = Object.keys(boneMap).sort((a, b) => depthOf(a) - depthOf(b));

  const out = {} as Bip001Clips;
  for (const raw of sources) {
    out[raw.name] = bakeOne(raw, target, tBones, tBind, tRest, depthOrder, F, Finv, boneMap);
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, out);
  return out;
}

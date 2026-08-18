import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { stripPositionTracks, weaponCategory } from "./animations";
import type { AnimationLibrary, ClipName } from "./animations";
import type { Bip001Clips } from "./retarget";
import {
  applyFootIk,
  finishOverlay,
  queueOneShot,
} from "./combatAnim";
import {
  applyWarlordsLoadout,
  type WarlordsLoadout,
} from "./warlordsLoadout";

// Real character models live in Cloudflare R2 (public) and are referenced by the
// /api/saber/roster endpoint (data from Cloudflare D1). They use a 3ds Max Biped
// (Bip001) skeleton and ship as "customizable kits": many alternative body/head/
// arm/leg meshes plus weapon/shield meshes in one file. We keep one mesh per slot,
// hide the rest and the kit weapons, then attach our own glowing saber.

const TARGET_HEIGHT = 2.0;
/** Fleet SI human. Used for Toon play kits — never unskinned mesh AABB. */
const HUMAN_HEIGHT_M = 1.8;
const loader = new GLTFLoader();
const templateCache = new Map<string, Promise<THREE.Group>>();

export function loadCharacterTemplate(url: string): Promise<THREE.Group> {
  let p = templateCache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
    });
    templateCache.set(url, p);
  }
  return p;
}

// ---------- Lucy: a real mixamorig-rigged FBX character ----------
//
// Unlike the Grudge kits (Bip001, no animations), Lucy ships on the standard
// "mixamorig:" skeleton, so the Mixamo clip library (see ./animations) plays on
// her directly with no retargeting. Her FBX references external textures by name;
// we load and assign them explicitly rather than relying on FBX path resolution.

const fbxLoader = new FBXLoader();
const texLoader = new THREE.TextureLoader();
const lucyCache = new Map<string, Promise<THREE.Group>>();

export interface LucyAssets {
  modelUrl: string;
  bodyTexUrl: string;
  hairTexUrl: string;
}

export function loadLucyTemplate(assets: LucyAssets): Promise<THREE.Group> {
  let p = lucyCache.get(assets.modelUrl);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      fbxLoader.load(
        assets.modelUrl,
        (group) => {
          const bodyTex = texLoader.load(assets.bodyTexUrl);
          bodyTex.colorSpace = THREE.SRGBColorSpace;
          const hairTex = texLoader.load(assets.hairTexUrl);
          hairTex.colorSpace = THREE.SRGBColorSpace;
          group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            const old = mesh.material;
            const matName = Array.isArray(old)
              ? old[0]?.name ?? ""
              : old?.name ?? "";
            const isHair = /hair/i.test(mesh.name) || /hair/i.test(matName);
            mesh.material = new THREE.MeshStandardMaterial({
              map: isHair ? hairTex : bodyTex,
              roughness: 0.85,
              metalness: 0.0,
            });
            // Free the FBX-authored materials we are replacing.
            for (const m of Array.isArray(old) ? old : [old]) m?.dispose();
          });
          resolve(group);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      // Don't poison the cache on a transient failure; allow a later retry.
      lucyCache.delete(assets.modelUrl);
      throw err;
    });
    lucyCache.set(assets.modelUrl, p);
  }
  return p;
}

const SLOT_KEYWORDS = ["shoulderpad", "body", "head", "arms", "legs"];
// Hidden accessories (shields, extras, quivers, bags). Weapons are handled
// separately so the champion's matching weapon can be kept.
const HIDE_RE = /(shield|xtra|quiver|_bag|_wood|bone_)/i;
const WEAPON_RE = /weapon/i;

// Roster weapon string -> embedded weapon-mesh matcher. The kit meshes are named
// "<PREFIX>_weapon_<Type>" with varying case (e.g. WK_weapon_sword_A,
// ORC_weapon_Sword_B, UD_weapon_Hammer), so we match case-insensitively.
function weaponMeshMatcher(weapon: string): RegExp {
  const w = weapon.toLowerCase();
  const type = /bow/.test(w)
    ? "bow"
    : /staff|wand|scepter|rod/.test(w)
      ? "staff"
      : /axe/.test(w)
        ? "axe"
        : /hammer|maul/.test(w)
          ? "hammer"
          : /dagger|knife|dirk/.test(w)
            ? "dagger"
            : /spear|lance|pike|halberd/.test(w)
              ? "spear"
              : /mace|club/.test(w)
                ? "mace"
                : /pick/.test(w)
                  ? "pick"
                  : "sword";
  return new RegExp(`weapon[_ ]?${type}`, "i");
}

/**
 * Reduce a customizable kit to one mesh per body slot and reveal exactly the
 * champion's weapon. The kit's weapon meshes are parented under the hand
 * containers (R_hand_container / L_hand_container) and authored in-hand, so
 * keeping the matching one visible makes it follow the hand through the skeletal
 * hierarchy automatically — no separate attach needed. All other weapons and
 * accessories are hidden. Falls back to a sword, then to leaving the fighter
 * unarmed, if the requested weapon mesh is absent.
 */
function pruneKit(root: THREE.Object3D, weapon: string): void {
  const usedSlot = new Set<string>();
  const weaponMeshes: THREE.Object3D[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const name = o.name.toLowerCase();
    if (WEAPON_RE.test(name)) {
      o.visible = false; // hide all; we re-show the chosen one below
      weaponMeshes.push(o);
      return;
    }
    if (HIDE_RE.test(name)) {
      o.visible = false;
      return;
    }
    for (const slot of SLOT_KEYWORDS) {
      if (name.includes(slot)) {
        if (usedSlot.has(slot)) o.visible = false;
        else usedSlot.add(slot);
        return;
      }
    }
  });

  const want = weaponMeshMatcher(weapon);
  let chosen = weaponMeshes.find((m) => want.test(m.name));
  if (!chosen) {
    chosen = weaponMeshes.find((m) => /weapon[_ ]?sword/i.test(m.name));
  }
  if (chosen) chosen.visible = true;
}

/**
 * World-space midpoint between the character's feet, or null if the rig exposes
 * no foot bones. Matches any bone whose sanitized name ends in "foot" (covers
 * "LeftFoot"/"RightFoot", "Bip001 L Foot"/"R Foot", "mixamorig:LeftFoot", ...),
 * so the average of the matches lands between the two feet regardless of the
 * side-naming convention. Read after the scene's world matrix is current.
 */
function feetCenterWorld(scene: THREE.Object3D): { x: number; z: number } | null {
  const isFoot = (n: string): boolean =>
    n.replace(/[^a-z0-9]/gi, "").toLowerCase().endsWith("foot");
  const pts: THREE.Vector3[] = [];
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone && isFoot(b.name)) {
      pts.push(b.getWorldPosition(new THREE.Vector3()));
    }
  });
  if (!pts.length) return null;
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  return { x: x / pts.length, z: z / pts.length };
}

/**
 * Skeleton-aware facing correction. The game's forward is +Z at yaw 0; instead
 * of trusting each pack's export convention, the facing is read from the rig
 * itself: toe bones sit AHEAD of their foot/heel/ankle references on a humanoid
 * standing forward. The toe-to-ref direction is measured in the ground plane
 * and snapped to the nearest quarter turn, so rigs exported facing +X/-X/-Z
 * (90/180/270 degrees off) are ALL corrected — not just backwards ones.
 * Rigs without such bones (props, capsules) return 0 and are left alone.
 */
function skeletalFacingYaw(scene: THREE.Object3D): number {
  scene.updateMatrixWorld(true);
  let toeX = 0;
  let toeZ = 0;
  let toeN = 0;
  let refX = 0;
  let refZ = 0;
  let refN = 0;
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const n = norm(b.name);
    if (n.includes("toe")) {
      b.getWorldPosition(_facingTmp);
      toeX += _facingTmp.x;
      toeZ += _facingTmp.z;
      toeN++;
    } else if (n.includes("foot") || n.includes("heel") || n.includes("ankle")) {
      b.getWorldPosition(_facingTmp);
      refX += _facingTmp.x;
      refZ += _facingTmp.z;
      refN++;
    }
  });
  if (!toeN || !refN) return 0;
  const dx = toeX / toeN - refX / refN;
  const dz = toeZ / toeN - refZ / refN;
  if (dx * dx + dz * dz < 1e-6) return 0;
  // Heading the model actually faces, snapped to the nearest quarter turn;
  // the correction is the negative (rotate that heading back to +Z).
  const heading = Math.atan2(dx, dz);
  const snapped = Math.round(heading / (Math.PI / 2)) * (Math.PI / 2);
  return snapped === 0 ? 0 : -snapped;
}
const _facingTmp = new THREE.Vector3();

// Global facing trim applied to every normalized character model, on top of
// the automatic toe-vs-heel yaw detection. -PI/2 turns each model a quarter
// circle to its right (user-requested default). Tunable.
const MODEL_YAW_TRIM = -Math.PI / 2;

/** Bone structural min/max Y (feet → head). Not mesh AABB, not pelvis. */
function boneHeightSpan(scene: THREE.Object3D): { minY: number; maxY: number } | null {
  scene.updateMatrixWorld(true);
  let minY = Infinity;
  let maxY = -Infinity;
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const p = b.getWorldPosition(new THREE.Vector3());
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  if (!Number.isFinite(minY) || maxY - minY < 0.2) return null;
  return { minY, maxY };
}

/**
 * Toon RTS play GLB: authored +Z, yaw 0. Fit ~1.8 m from bone span and ground
 * feet from bone min.y. Do not apply FBX +X MODEL_YAW_TRIM.
 */
function fitToonPlayKit(scene: THREE.Object3D): void {
  scene.updateMatrixWorld(true);
  const span = boneHeightSpan(scene);
  if (span) {
    scene.scale.multiplyScalar(HUMAN_HEIGHT_M / (span.maxY - span.minY));
    scene.updateMatrixWorld(true);
  }
  const span2 = boneHeightSpan(scene);
  const feet = feetCenterWorld(scene);
  if (feet) {
    scene.position.x -= feet.x;
    scene.position.z -= feet.z;
  }
  if (span2) scene.position.y -= span2.minY;
  else {
    const box = new THREE.Box3().setFromObject(scene);
    scene.position.y -= box.min.y;
  }
}

function normalize(scene: THREE.Object3D): void {
  // Face the game's +Z before measuring: recentering uses world positions, so
  // any yaw correction must already be applied (same reasoning as Lucy/Meshy).
  const yawFix = skeletalFacingYaw(scene) + MODEL_YAW_TRIM;
  if (yawFix !== 0) scene.rotation.y += yawFix;
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = TARGET_HEIGHT / (size.y || 1);
  scene.scale.setScalar(scale);
  scene.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(scene);
  // Root the character at the point BETWEEN ITS FEET (horizontal) so it stands
  // and pivots about its stance, not the bounding-box center (which arms, capes
  // and weapons skew). Falls back to the bbox center for rigs without foot bones.
  const feet = feetCenterWorld(scene);
  if (feet) {
    scene.position.x -= feet.x;
    scene.position.z -= feet.z;
  } else {
    const center = new THREE.Vector3();
    box2.getCenter(center);
    scene.position.x -= center.x;
    scene.position.z -= center.z;
  }
  scene.position.y -= box2.min.y;
}

export interface WeaponAttach {
  pivot: THREE.Group;
  blade: THREE.Mesh;
}

/**
 * A solid (non-glowing) metal blade used only by characters that have no
 * embedded kit weapon: Lucy (mixamorig) and the capsule fallback. Champions wear
 * their real kit weapon instead. The blade points along +Y from the pivot origin
 * (the grip), matching how it is attached to a hand bone.
 */
function makeBlade(): WeaponAttach {
  const pivot = new THREE.Group();
  pivot.position.set(0.42, 1.3, 0.18);

  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.34, 10),
    new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.85 }),
  );
  grip.castShadow = true;
  pivot.add(grip);

  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.05, 0.1),
    new THREE.MeshStandardMaterial({
      color: 0x7a6326,
      metalness: 0.8,
      roughness: 0.4,
    }),
  );
  guard.position.y = 0.2;
  guard.castShadow = true;
  pivot.add(guard);

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 1.7, 0.02),
    new THREE.MeshStandardMaterial({
      color: 0xd2d8e2,
      metalness: 0.95,
      roughness: 0.22,
      emissive: new THREE.Color(0x000000),
    }),
  );
  blade.position.y = 1.08;
  blade.castShadow = true;
  pivot.add(blade);

  return { pivot, blade };
}

export type RigKind = "bip001" | "mixamo" | "capsule";

export interface CharacterInstance {
  /** Outer group; set .position to place feet on the ground. */
  group: THREE.Group;
  /** Inner model; animated for bob/lean/twist so it doesn't fight world position. */
  inner: THREE.Object3D;
  /** Faction accent color, used for sparks / skill-VFX tint. */
  accent: number;
  /**
   * An attached metal blade — ONLY for characters with no embedded kit weapon
   * (Lucy, capsule fallback). Champions wear their real kit weapon mesh, so this
   * is null/undefined for them.
   */
  weapon?: WeaponAttach | null;
  /**
   * The attached weapon is a clone of a cached shared template (minions):
   * its geometry/material/texture must NOT be disposed per instance.
   */
  sharedWeapon?: boolean;
  isModel: boolean;
  phase: number;
  /** Which skeleton/animation path drives this instance. */
  rig: RigKind;
  // ---- mixamo rig only: real skeletal animation ----
  mixer?: THREE.AnimationMixer;
  actions?: Partial<Record<ClipName, THREE.AnimationAction>>;
  /** Right-hand bone the attached blade tracks each frame (only when `weapon`). */
  handBone?: THREE.Bone | null;
  /**
   * Right-hand bone used to anchor the melee collider to the actual animated
   * hand (resolved lazily for every rig, champions included, so the blade
   * hitbox originates where the weapon really is during the swing). `null` once
   * a lookup has failed; `undefined` means "not resolved yet".
   */
  attackHand?: THREE.Bone | null;
  /** Blade placement in hand-bone local space (rotation + grip offset). */
  gripMatrix?: THREE.Matrix4;
  currentClip?: ClipName;
  prevStrike?: boolean;
  prevCast?: boolean;
  /** True while the 5-way locomotion blend (idle/walk/run/strafes) owns the mixer. */
  locoActive?: boolean;
  /** Current smoothed weight per locomotion clip while blending. */
  locoWeights?: Partial<Record<ClipName, number>>;
  /** Overlay one-shot currently owning the mixer (attack/cast/hit). */
  overlayClip?: ClipName | null;
  /** Deterministic one-shot queue (cap 2). */
  animQueue?: ClipName[];
  footBones?: THREE.Bone[];
  /** Terrain height sampler (same field as body ground). */
  terrainAt?: (x: number, z: number) => number;
}

export interface AnimState {
  speed01: number; // 0..1 movement intensity
  strafe: number; // -1..1 lateral lean
  grounded: boolean;
  airborne01: number; // 0..1 jump height factor
  strike01: number; // -1 = none, else 0..1 swing progress
  guard: boolean;
  hitFlash: number;
  /** Same terrain sampler as the body (never a second height field). */
  groundAt?: (x: number, z: number) => number;
  /**
   * Target real-time seconds the current swing lasts. The (fixed-length) attack
   * clip is time-scaled to fill exactly this window so swings read as crisp and
   * "quick" instead of drifting out of sync with the gameplay hit timing.
   */
  strikeDur?: number;
  /**
   * -1 = not casting, else 0..1 progress through an elemental cast wind-up +
   * release. Drives the dedicated "cast" clip (magic 2H attack) as a one-shot,
   * taking priority over everything except death-style states.
   */
  cast01?: number;
  /** Real-time seconds the cast window lasts (clip is time-scaled to fit). */
  castDur?: number;
}

/**
 * Wrap a model/mesh in the outer group and assemble a CharacterInstance. When
 * `attachWeapon` is set, a metal blade is added as a group child (for rigs with
 * no embedded kit weapon: Lucy, capsule). Champions pass `attachWeapon: false`
 * and wear their real kit weapon instead.
 */
function buildInstance(
  inner: THREE.Object3D,
  accent: number,
  isModel: boolean,
  rig: RigKind,
  attachWeapon: boolean,
): CharacterInstance {
  const group = new THREE.Group();
  group.add(inner);
  let weapon: WeaponAttach | null = null;
  if (attachWeapon) {
    weapon = makeBlade();
    group.add(weapon.pivot);
  }
  return {
    group,
    inner,
    accent,
    weapon,
    isModel,
    phase: Math.random() * Math.PI * 2,
    rig,
  };
}

export function instantiateModel(
  template: THREE.Group,
  accent: number,
  weapon: string,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  pruneKit(scene, weapon);
  normalize(scene);
  return buildInstance(scene, accent, true, "bip001", false);
}

// Lucy's model faces the opposite way in her own space; rotate a full 180 so
// she looks down the game's forward axis (was Math.PI — she read backwards).
const LUCY_YAW = 0;
// Bone names are matched colon-insensitively: FBXLoader sanitizes "mixamorig:Hips"
// to "mixamorigHips", so an exact "mixamorig:RightHand" lookup would miss.
const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

function findBone(root: THREE.Object3D, name: string): THREE.Bone | null {
  const want = norm(name);
  let found: THREE.Bone | null = null;
  root.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone && !found && norm(b.name) === want) found = b;
  });
  return found;
}

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const want = norm(name);
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && norm(o.name) === want) found = o;
  });
  return found;
}

// Roll the saber about its own length axis after it is aligned to the hand (see
// gripFromHandBone). The alignment itself is derived from the skeleton, so this
// is only a small flat-of-the-blade tweak, not a full orientation guess.
// Tunable: if the blade's edge faces the wrong way, set a roll about Y here.
const SABER_GRIP_ROLL = new THREE.Quaternion();
// How far along the hand's finger axis to seat the grip (hand-local units). The
// fist already sits at the bone origin, so a small value nudges the handle into
// the palm; 0 keeps it centered on the bone.
const SABER_GRIP_SEAT = 0;
const LUCY_HAND_BONE = "mixamorig:RightHand";

// Grudge Bip001 right-hand bone, and the artist-authored weapon attach locator
// parented under it (gives the exact grip transform; not guessed).
const BIP_HAND_BONE = "Bip001 R Hand";
const BIP_HAND_CONTAINER = "R_hand_container";
// Optional extra grip orientation tweak applied after the container transform.
// Tunable: if the Bip001 blade points the wrong way, adjust these Euler angles.
const BIP_GRIP_ADJUST = new THREE.Quaternion();

const ONE_SHOT: ReadonlySet<ClipName> = new Set([
  "attack",
  "cast",
  "jump",
  "hit",
  "death",
]);

/** Build the mixer + per-clip actions for a model, looping all but one-shots. */
function setupMixer(
  root: THREE.Object3D,
  clips: Partial<Record<ClipName, THREE.AnimationClip>>,
): {
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<ClipName, THREE.AnimationAction>>;
} {
  const mixer = new THREE.AnimationMixer(root);
  const actions: Partial<Record<ClipName, THREE.AnimationAction>> = {};
  (Object.keys(clips) as ClipName[]).forEach((name) => {
    const clip = clips[name];
    if (!clip) return;
    const action = mixer.clipAction(clip);
    if (ONE_SHOT.has(name)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions[name] = action;
  });
  return { mixer, actions };
}

// Weapons are modeled pointing along +Y from their grip origin (see makeBlade /
// makeGun), so +Y is the length axis we align to the hand.
const GRIP_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Derive a grip transform (hand-bone local) from the skeleton instead of guessing
 * a fixed Euler. The hand's "down the fingers" axis is read directly from the
 * bone hierarchy — the local-space direction from the hand bone to its first
 * child bone (a finger root) — and the weapon's length axis (+Y) is rotated onto
 * it. This adapts automatically to each rig's hand bind orientation (Lucy,
 * Racalvin, Heavy all differ) rather than assuming one rotation fits them all.
 *
 * `roll` spins the weapon about its own length axis afterward (flat-of-the-blade
 * / sight alignment) and `seat` slides the grip along that axis to sit deeper in
 * the palm. Both default to a no-op. Falls back to a plain rotation when the
 * bone has no readable child direction.
 */
function gripFromHandBone(
  hand: THREE.Bone | null,
  roll: THREE.Quaternion,
  seat: number,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!hand) {
    m.makeRotationFromQuaternion(roll);
    return m;
  }
  const child = hand.children.find((c) => (c as THREE.Bone).isBone) as
    | THREE.Bone
    | undefined;
  const dir = new THREE.Vector3(0, 1, 0);
  if (child && child.position.lengthSq() > 1e-8) {
    dir.copy(child.position).normalize();
  }
  // Rotate the weapon about its length axis (roll) first, then swing that axis
  // onto the hand's finger direction.
  const align = new THREE.Quaternion().setFromUnitVectors(GRIP_AXIS, dir);
  align.multiply(roll);
  m.compose(dir.clone().multiplyScalar(seat), align, new THREE.Vector3(1, 1, 1));
  return m;
}

/**
 * The weapon's placement in hand-bone local space, as a matrix. For Bip001 kits
 * that ship an artist-authored weapon-attach locator (R_hand_container) we read
 * it directly so the grip matches where kit weapons sit. Every other rig (the
 * FBX-rigged Lucy / Racalvin / Heavy, which have no such locator) derives the
 * grip from the skeleton via gripFromHandBone.
 */
function computeGripMatrix(
  scene: THREE.Object3D,
  hand: THREE.Bone | null,
  roll: THREE.Quaternion,
  seat = 0,
): THREE.Matrix4 {
  const container = findNode(scene, BIP_HAND_CONTAINER);
  if (hand && container) {
    const m = new THREE.Matrix4();
    scene.updateMatrixWorld(true);
    hand.updateWorldMatrix(true, false);
    container.updateWorldMatrix(true, false);
    // hand-local -> container (scale cancels: inv(hand.world) * container.world).
    m.copy(hand.matrixWorld).invert().multiply(container.matrixWorld);
    m.multiply(new THREE.Matrix4().makeRotationFromQuaternion(BIP_GRIP_ADJUST));
    // Strip any residual scale so the weapon keeps its own dimensions.
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    m.compose(pos, quat, new THREE.Vector3(1, 1, 1));
    return m;
  }
  return gripFromHandBone(hand, roll, seat);
}

/**
 * Build Lucy: a mixamorig-rigged model driven by real Mixamo clips. The saber is
 * kept as a group child (world scale 1) and re-placed onto her right-hand bone
 * each frame, so it is not affected by the deep, scaled bone hierarchy.
 */
export function instantiateLucy(
  template: THREE.Group,
  library: AnimationLibrary,
  accent: number,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  // Rotate to the game's forward BEFORE normalizing: normalize recenters the
  // model over the point between its feet using world positions, so the yaw must
  // already be applied or the rotation pivots about the geometry origin and
  // re-introduces a horizontal offset (model stands off its location).
  scene.rotation.y = LUCY_YAW;
  normalize(scene);
  const inst = buildInstance(scene, accent, true, "mixamo", true);

  const hand = findBone(scene, LUCY_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(
    scene,
    hand,
    SABER_GRIP_ROLL,
    SABER_GRIP_SEAT,
  );

  const { mixer, actions } = setupMixer(scene, library);
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

/**
 * Build a Grudge champion (Bip001 kit) driven by the Mixamo clip library
 * retargeted onto its skeleton (see retarget.ts) — real skeletal animation, not
 * procedural. The saber is kept as a group child and re-placed onto the right-
 * hand bone each frame via the artist's weapon-attach locator.
 */
export function instantiateGrudgeAnimated(
  template: THREE.Group,
  clips: Bip001Clips,
  accent: number,
  weapon: string,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  pruneKit(scene, weapon);
  normalize(scene);
  // Champions wear their embedded kit weapon (kept visible by pruneKit and
  // parented under the hand container), so no separate blade is attached.
  const inst = buildInstance(scene, accent, true, "bip001", false);

  const { mixer, actions } = setupMixer(scene, clips);
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

// ---------- Toon RTS: self-contained faction characters (Bip001) ----------
//
// The Toon RTS faction packs (crusade / fabled / legion) ship one GLB per
// race+class with the FULL animation set embedded on its own Bip001-style
// skeleton — including a two-handed greatsword package (gs_idle/gs_walk/gs_run
// locomotion plus sword_attack_*, sword_block, dodge). No retargeting needed:
// the clips are bound to the same skeleton they were authored on, which is the
// most robust skeletal path we have.

export interface ToonRtsTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const toonRtsCache = new Map<string, Promise<ToonRtsTemplate>>();

export function loadToonRtsTemplate(url: string): Promise<ToonRtsTemplate> {
  let p = toonRtsCache.get(url);
  if (!p) {
    p = new Promise<ToonRtsTemplate>((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          gltf.scene.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
              mesh.castShadow = true;
              mesh.receiveShadow = true;
            }
          });
          resolve({ scene: gltf.scene, animations: gltf.animations });
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      toonRtsCache.delete(url); // don't poison the cache on transient failures
      throw err;
    });
    toonRtsCache.set(url, p);
  }
  return p;
}

// Game clip -> embedded clip names, first match wins, chosen per weapon class:
// warriors prefer the two-handed greatsword ("gs_") stance set, knights use the
// one-handed sword+shield set, and rangers/mages use the plain locomotion with
// their own class attack ("attack" is the bow shot / spell cast on those rigs).
function toonRtsClipMap(weapon: string): ReadonlyArray<[ClipName, string[]]> {
  const w = weapon.toLowerCase();
  const category = weaponCategory(weapon);
  const greatsword = category === "blade" && /great\s*sword|greatsword/.test(w);
  if (greatsword) {
    return [
      ["idle", ["gs_idle", "idle"]],
      ["walk", ["gs_walk", "walk"]],
      ["run", ["gs_run", "run"]],
      ["strafeLeft", ["strafe_left"]],
      ["strafeRight", ["strafe_right"]],
      ["jump", ["jump"]],
      ["attack", ["sword_attack_a", "attack"]],
      ["guard", ["sword_block"]],
    ];
  }
  if (category === "blade") {
    // Sword & shield: plain locomotion carries the shield naturally.
    return [
      ["idle", ["idle"]],
      ["walk", ["walk"]],
      ["run", ["run"]],
      ["strafeLeft", ["strafe_left"]],
      ["strafeRight", ["strafe_right"]],
      ["jump", ["jump"]],
      ["attack", ["sword_attack_a", "attack"]],
      ["guard", ["sword_block"]],
    ];
  }
  // Bow / magic: "attack" is the class attack (bow shot, spell cast). These
  // rigs have no block clip; missing guard is safe (crossfade guards absent
  // actions).
  return [
    ["idle", ["idle"]],
    ["walk", [category === "bow" ? "bow_walk_fwd" : "magic_walk_fwd", "walk"]],
    ["run", ["run"]],
    ["strafeLeft", ["strafe_left"]],
    ["strafeRight", ["strafe_right"]],
    ["jump", ["jump"]],
    ["attack", ["attack"]],
  ];
}

function mapToonRtsClips(
  animations: THREE.AnimationClip[],
  weapon: string,
): Partial<Record<ClipName, THREE.AnimationClip>> {
  const clips: Partial<Record<ClipName, THREE.AnimationClip>> = {};
  for (const [name, candidates] of toonRtsClipMap(weapon)) {
    for (const want of candidates) {
      const clip = animations.find((a) => a.name === want);
      if (clip) {
        clips[name] = stripPositionTracks(clip);
        break;
      }
    }
  }
  return clips;
}

/** Library (retargeted Mixamo pack) wins; embedded Toon clips fill holes. */
function mergeToonLibraryClips(
  embedded: Partial<Record<ClipName, THREE.AnimationClip>>,
  library: Partial<Bip001Clips> | null | undefined,
): Partial<Record<ClipName, THREE.AnimationClip>> {
  const out: Partial<Record<ClipName, THREE.AnimationClip>> = { ...embedded };
  if (!library) return out;
  (Object.keys(library) as ClipName[]).forEach((name) => {
    const clip = library[name];
    if (clip) out[name] = clip;
  });
  return out;
}

/**
 * Build a Toon RTS character: embedded clips play directly on the skeleton
 * they ship with. The model wears its own weapon mesh (no attached blade), and
 * the melee collider anchors to the Bip001 hand via the usual lazy lookup.
 */
export function instantiateToonRts(
  template: ToonRtsTemplate,
  accent: number,
  weapon = "greatsword",
  library?: Partial<Bip001Clips> | null,
  loadout?: WarlordsLoadout | null,
): CharacterInstance {
  const scene = cloneSkeleton(template.scene);
  if (loadout) applyWarlordsLoadout(scene, loadout);
  else {
    pruneKit(scene, weapon);
    if (/shield/i.test(weapon)) {
      let shown = false;
      scene.traverse((o) => {
        if (!/shield/i.test(o.name)) return;
        if (!shown) {
          o.visible = true;
          shown = true;
        }
      });
    }
  }
  fitToonPlayKit(scene);
  const inst = buildInstance(scene, accent, true, "bip001", false);
  // One clip source only. Mixing Mixamo-retarget + authored Toon clips on the
  // same mixer is what slightly deformed the limbs. Library only if the kit
  // has no attack clip (empty D1-style bake).
  const embedded = mapToonRtsClips(template.animations, weapon);
  const clips =
    embedded.attack || !library
      ? embedded
      : mergeToonLibraryClips(embedded, library);
  const { mixer, actions } = setupMixer(scene, clips);
  inst.mixer = mixer;
  inst.actions = actions;
  inst.animQueue = [];
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

// ---------- Meshy: AI-generated auto-rigged GLB characters ----------
//
// Meshy's auto-rigger emits a Mixamo-style skeleton WITHOUT the "mixamorig:"
// prefix, so the Mixamo clip library is retargeted onto it (see retarget.ts,
// MESHY_BONE_MAP) rather than played directly. Like Lucy, these characters have
// empty hands, so a blade is attached to the right hand via the skeleton-derived
// grip transform.

const MESHY_HAND_BONE = "RightHand";
// Meshy rigs face +Z in their own space, same as the game's forward when yaw=0.
// Tunable: set to Math.PI if a generated model reads backwards.
const MESHY_YAW = 0;

export function instantiateMeshyAnimated(
  template: THREE.Group,
  clips: Record<ClipName, THREE.AnimationClip>,
  accent: number,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  // Rotate BEFORE normalize (same reasoning as Lucy: normalize recenters using
  // world positions, so yaw must already be applied).
  scene.rotation.y = MESHY_YAW;
  normalize(scene);
  const inst = buildInstance(scene, accent, true, "mixamo", true);

  const hand = findBone(scene, MESHY_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(
    scene,
    hand,
    SABER_GRIP_ROLL,
    SABER_GRIP_SEAT,
  );

  const { mixer, actions } = setupMixer(scene, clips);
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

/**
 * Procedural (non-skeletal) fallback for Meshy characters when the Mixamo
 * library or retarget bake fails. Unlike instantiateModel this does NOT
 * pruneKit (Meshy models legitimately carry shields/bags/quivers as part of
 * their look) and keeps the "mixamo" rig kind with a blade attached to the
 * right hand, so the game treats it like the other empty-handed rigs.
 */
export function instantiateMeshyModel(
  template: THREE.Group,
  accent: number,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  scene.rotation.y = MESHY_YAW;
  normalize(scene);
  const inst = buildInstance(scene, accent, true, "mixamo", true);
  const hand = findBone(scene, MESHY_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(
    scene,
    hand,
    SABER_GRIP_ROLL,
    SABER_GRIP_SEAT,
  );
  return inst;
}

// ---------- Minions: Standout low-poly FBX sets (marauders + elves) ----------
//
// These lesser-enemy packs (itch.io "Standout" low-poly sets) ship as rigged
// FBX characters on a Blender "basic human" skeleton (spine..spine006,
// upper_armL/forearmL/handL, ...) with NO embedded animations, plus separate
// static weapon FBX meshes (grip at the origin, length along +Y — the same
// convention as makeBlade) and a shared palette texture the UVs point into.
// The Mixamo library is retargeted onto the rig (see retarget.ts,
// STANDOUT_BONE_MAP) and the set's weapon is attached to the right hand via
// the same per-frame hand-follow path as the saber.

const minionCache = new Map<string, Promise<THREE.Group>>();
const minionWeaponCache = new Map<string, Promise<THREE.Group>>();
const minionTexCache = new Map<string, THREE.Texture>();
const MINION_HAND_BONE = "handR";

function minionPaletteTex(url: string): THREE.Texture {
  let tex = minionTexCache.get(url);
  if (!tex) {
    tex = texLoader.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Palette atlas: UV islands sit inside flat color cells, so nearest
    // filtering avoids color bleed between neighboring swatches.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    minionTexCache.set(url, tex);
  }
  return tex;
}

function applyMinionMaterial(root: THREE.Object3D, texUrl: string): void {
  const tex = minionPaletteTex(texUrl);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const old = mesh.material;
    mesh.material = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.9,
      metalness: 0.0,
    });
    for (const m of Array.isArray(old) ? old : [old]) m?.dispose();
  });
}

export function loadMinionTemplate(url: string, texUrl: string): Promise<THREE.Group> {
  let p = minionCache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      fbxLoader.load(
        url,
        (group) => {
          applyMinionMaterial(group, texUrl);
          resolve(group);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      minionCache.delete(url); // don't poison the cache on transient failures
      throw err;
    });
    minionCache.set(url, p);
  }
  return p;
}

export function loadMinionWeapon(url: string, texUrl: string): Promise<THREE.Group> {
  let p = minionWeaponCache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      fbxLoader.load(
        url,
        (group) => {
          applyMinionMaterial(group, texUrl);
          resolve(group);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      minionWeaponCache.delete(url);
      throw err;
    });
    minionWeaponCache.set(url, p);
  }
  return p;
}

function buildMinionBase(
  template: THREE.Group,
  accent: number,
  weaponTemplate: THREE.Group | null,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  // Facing is handled inside normalize() (skeleton-aware toe-vs-heel check).
  normalize(scene);
  // No auto-blade: the set's own weapon mesh is attached instead (or none).
  const inst = buildInstance(scene, accent, true, "mixamo", false);

  const hand = findBone(scene, MINION_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(scene, hand, SABER_GRIP_ROLL, SABER_GRIP_SEAT);

  if (weaponTemplate && hand) {
    const pivot = new THREE.Group();
    const model = weaponTemplate.clone(true);
    pivot.add(model);
    inst.group.add(pivot);
    let blade: THREE.Mesh | null = null;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !blade) blade = m;
    });
    if (blade) {
      inst.weapon = { pivot, blade };
      inst.sharedWeapon = true;
    }
  }
  return inst;
}

/** Minion driven by the retargeted Mixamo library (real skeletal animation). */
export function instantiateMinionAnimated(
  template: THREE.Group,
  clips: Record<ClipName, THREE.AnimationClip>,
  accent: number,
  weaponTemplate: THREE.Group | null,
): CharacterInstance {
  const inst = buildMinionBase(template, accent, weaponTemplate);
  const { mixer, actions } = setupMixer(inst.inner, clips);
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

/** Procedural fallback when the library fetch or retarget bake fails. */
export function instantiateMinionModel(
  template: THREE.Group,
  accent: number,
  weaponTemplate: THREE.Group | null,
): CharacterInstance {
  return buildMinionBase(template, accent, weaponTemplate);
}

// ---------- Heavy: a ranged mixamorig-rigged gunner enemy ----------
//
// Like Lucy, the Heavy ships on the standard "mixamorig:" skeleton, so its own
// per-clip FBX files (aiming idle + run) play directly with no retargeting. It
// has no embedded weapon, so a simple procedural rifle is attached to its right
// hand via the same hand-follow path the saber uses.

const heavyCache = new Map<string, Promise<THREE.Group>>();
const HEAVY_HAND_BONE = "mixamorig:RightHand";
// Heavy faces +Z in its own space; rotate so it looks down the game's forward.
const HEAVY_YAW = Math.PI;
// Roll the rifle about its barrel after it is aligned to the hand's finger axis
// (see gripFromHandBone). The rifle is modeled along +Y from the grip, so the
// skeleton alignment already lays it forward out of the hand; this only spins it
// upright. Tunable: if the sights face the wrong way, set a roll about Y here.
const GUN_GRIP_ROLL = new THREE.Quaternion();
const GUN_GRIP_SEAT = 0;

export function loadHeavyTemplate(url: string): Promise<THREE.Group> {
  let p = heavyCache.get(url);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      fbxLoader.load(
        url,
        (group) => {
          group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          });
          resolve(group);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      heavyCache.delete(url);
      throw err;
    });
    heavyCache.set(url, p);
  }
  return p;
}

/** A simple non-glowing rifle prop for the gunner (no embedded weapon mesh). */
function makeGun(): WeaponAttach {
  const pivot = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({
    color: 0x2b2f36,
    metalness: 0.7,
    roughness: 0.45,
  });

  // Main body/barrel runs along +Y from the grip origin.
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.95, 0.1), metal);
  blade.position.y = 0.42;
  blade.castShadow = true;
  pivot.add(blade);

  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.26, 0.09),
    new THREE.MeshStandardMaterial({ color: 0x1c140e, roughness: 0.85 }),
  );
  stock.position.set(0, -0.06, 0);
  stock.castShadow = true;
  pivot.add(stock);

  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), metal);
  mag.position.set(0, 0.18, -0.1);
  mag.castShadow = true;
  pivot.add(mag);

  return { pivot, blade };
}

/**
 * Build the Heavy gunner: a mixamorig model driven directly by its own clips
 * (idle aiming + run), with a procedural rifle attached to the right hand. Uses
 * the same hand-follow mechanism as Lucy's saber.
 */
export function instantiateHeavy(
  template: THREE.Group,
  library: Partial<AnimationLibrary>,
  accent: number,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  // Yaw before normalize (see instantiateLucy): otherwise the post-normalize
  // rotation pivots about the geometry origin and the Heavy stands off-location.
  scene.rotation.y = HEAVY_YAW;
  normalize(scene);
  const inst = buildInstance(scene, accent, true, "mixamo", false);

  const hand = findBone(scene, HEAVY_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(scene, hand, GUN_GRIP_ROLL, GUN_GRIP_SEAT);
  const gun = makeGun();
  inst.weapon = gun;
  inst.group.add(gun.pivot);

  const { mixer, actions } = setupMixer(
    scene,
    library as Record<ClipName, THREE.AnimationClip>,
  );
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

// ---------- Racalvin: the secret player-only Pirate King ----------
//
// A self-contained rigged FBX whose locomotion/attack clips ship in the SAME FBX
// export (identical skeleton), so they play DIRECTLY through the mixer with no
// retargeting and no remote-host dependency — the most robust skeletal path in
// the game. Like Lucy he has no embedded weapon, so a metal blade is attached to
// his right hand via the same hand-follow path.

const racalvinCache = new Map<string, Promise<THREE.Group>>();
// Racalvin faces +Z in his own space; rotate so he looks down the game forward.
// Tunable: if he faces the wrong way, adjust this yaw.
// He was reading backwards (facing the camera); 0 points him down the game's forward.
const RAC_YAW = 0;
const RAC_HAND_BONE = "RightHand";

/**
 * Load Racalvin's rigged FBX. The Meshy export embeds its own texture; if that
 * texture does not survive the load, the bundled atlas at `texUrl` is applied as
 * a fallback. Every mesh is re-materialed to MeshStandardMaterial so it lights
 * consistently with the rest of the arena. Cached by url.
 */
export function loadRacalvinTemplate(
  modelUrl: string,
  texUrl: string,
): Promise<THREE.Group> {
  let p = racalvinCache.get(modelUrl);
  if (!p) {
    p = new Promise<THREE.Group>((resolve, reject) => {
      fbxLoader.load(
        modelUrl,
        (group) => {
          let fallback: THREE.Texture | null = null;
          const getFallback = (): THREE.Texture => {
            if (!fallback) {
              fallback = texLoader.load(texUrl);
              fallback.colorSpace = THREE.SRGBColorSpace;
              fallback.flipY = false; // FBX/glTF-style UVs
            }
            return fallback;
          };
          group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            const old = mesh.material;
            const olds = Array.isArray(old) ? old : [old];
            const embedded = olds
              .map((m) => (m as THREE.MeshStandardMaterial | null)?.map ?? null)
              .find((t): t is THREE.Texture => !!t);
            const map = embedded ?? getFallback();
            map.colorSpace = THREE.SRGBColorSpace;
            mesh.material = new THREE.MeshStandardMaterial({
              map,
              roughness: 0.8,
              metalness: 0.05,
            });
            // Material.dispose() leaves textures intact, so the embedded map we
            // reuse above survives.
            for (const m of olds) m?.dispose();
          });
          resolve(group);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      racalvinCache.delete(modelUrl);
      throw err;
    });
    racalvinCache.set(modelUrl, p);
  }
  return p;
}

/**
 * Build Racalvin: a rigged FBX driven directly by its own bundled clips (no
 * retargeting). A metal blade is attached to his right hand via the saber-follow
 * path. Missing clips (jump/guard/hit/death) are simply absent — pickClip's
 * crossfade no-ops on them, holding the current pose.
 */
export function instantiateRacalvin(
  template: THREE.Group,
  clips: Partial<Record<ClipName, THREE.AnimationClip>>,
  accent: number,
): CharacterInstance {
  const scene = cloneSkeleton(template);
  // Yaw before normalize (see instantiateLucy) so feet-rooting stays accurate.
  scene.rotation.y = RAC_YAW;
  normalize(scene);
  const inst = buildInstance(scene, accent, true, "mixamo", true);

  const hand = findBone(scene, RAC_HAND_BONE);
  inst.handBone = hand;
  inst.gripMatrix = computeGripMatrix(
    scene,
    hand,
    SABER_GRIP_ROLL,
    SABER_GRIP_SEAT,
  );

  const { mixer, actions } = setupMixer(
    scene,
    clips as Record<ClipName, THREE.AnimationClip>,
  );
  inst.mixer = mixer;
  inst.actions = actions;
  actions.idle?.play();
  inst.currentClip = "idle";
  return inst;
}

function disposeTree(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (child as { material?: THREE.Material | THREE.Material[] })
      .material;
    if (mat) {
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) {
        const withMap = m as THREE.Material & { map?: THREE.Texture | null };
        if (withMap.map) withMap.map.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Dispose only the resources this instance owns. Model clones share their
 * geometries/materials with the cached template and sibling clones (via
 * SkeletonUtils.clone), so the cloned body is NEVER disposed here — only the
 * per-instance saber. Capsule fallbacks own their meshes, so those are freed.
 */
export function disposeInstance(inst: CharacterInstance): void {
  if (inst.mixer) {
    inst.mixer.stopAllAction();
    inst.mixer.uncacheRoot(inst.inner);
  }
  inst.group.removeFromParent();
  // Shared-template weapons (minions) clone a cached weapon FBX: geometry,
  // material and palette texture are shared with the template and every other
  // living clone, so disposing them here would corrupt the survivors.
  if (inst.weapon && !inst.sharedWeapon) disposeTree(inst.weapon.pivot);
  if (!inst.isModel) disposeTree(inst.inner);
}

/** Fallback capsule humanoid used when a model fails to load. */
export function instantiateCapsule(
  robe: number,
  skin: number,
  accent: number,
): CharacterInstance {
  const g = new THREE.Group();
  const robeMat = new THREE.MeshStandardMaterial({
    color: robe,
    roughness: 0.7,
    metalness: 0.1,
  });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.6 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.85, 6, 12), robeMat);
  torso.position.y = 1.45;
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 16), skinMat);
  head.position.y = 2.15;
  head.castShadow = true;
  g.add(head);

  const legGeo = new THREE.CapsuleGeometry(0.17, 0.75, 4, 8);
  const legL = new THREE.Mesh(legGeo, robeMat);
  legL.position.set(-0.2, 0.45, 0);
  legL.castShadow = true;
  g.add(legL);
  const legR = new THREE.Mesh(legGeo, robeMat);
  legR.position.set(0.2, 0.45, 0);
  legR.castShadow = true;
  g.add(legR);
  g.userData.legL = legL;
  g.userData.legR = legR;

  return buildInstance(g, accent, false, "capsule", true);
}

const READY_X = -0.5;
const READY_Z = -0.15;

function pickClip(s: AnimState): ClipName {
  if (s.cast01 !== undefined && s.cast01 >= 0) return "cast";
  if (s.strike01 >= 0) return "attack";
  if (!s.grounded || s.airborne01 > 0.15) return "jump";
  if (s.guard) return "guard";
  if (s.speed01 > 0.55) return "run";
  if (s.speed01 > 0.05) {
    if (s.strafe < -0.5) return "strafeLeft";
    if (s.strafe > 0.5) return "strafeRight";
    return "walk";
  }
  return "idle";
}

function crossfadeTo(inst: CharacterInstance, name: ClipName, dur: number): void {
  if (inst.currentClip === name) return;
  const next = inst.actions?.[name];
  if (!next) return;
  const prev = inst.currentClip ? inst.actions?.[inst.currentClip] : undefined;
  next.reset();
  next.enabled = true;
  next.setEffectiveTimeScale(1);
  next.setEffectiveWeight(1);
  next.play();
  if (prev && prev !== next) prev.crossFadeTo(next, dur, false);
  inst.currentClip = name;
}

const _followMat = new THREE.Matrix4();
const _followScale = new THREE.Vector3();

const _gripWorld = new THREE.Matrix4();

/**
 * Re-place the saber group onto the hand bone each frame, ignoring the bone's
 * scale. Saber world = handBone.world * gripMatrix; expressed in group space so
 * the saber (a group child at world scale 1) is unaffected by the scaled rig.
 */
function updateSaberFollow(inst: CharacterInstance): void {
  const weapon = inst.weapon;
  const bone = inst.handBone;
  if (!weapon || !bone) return;
  bone.updateWorldMatrix(true, false);
  inst.group.updateWorldMatrix(true, false);
  _gripWorld.copy(bone.matrixWorld);
  if (inst.gripMatrix) _gripWorld.multiply(inst.gripMatrix);
  _followMat.copy(inst.group.matrixWorld).invert().multiply(_gripWorld);
  _followMat.decompose(
    weapon.pivot.position,
    weapon.pivot.quaternion,
    _followScale,
  );
  weapon.pivot.scale.setScalar(1);
}

// Right-hand bone names across the rigs, colon/space-insensitive (Bip001 R Hand,
// mixamorig:RightHand). Sanitized the same way bone lookups are elsewhere.
const _RIGHT_HAND_RE = /(bip001rhand|righthand)$/;
function sanitizeBone(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * World position of the character's animated right hand, used to anchor the
 * melee collider where the weapon actually is during a swing. Resolves the bone
 * lazily for any rig (reusing the weapon-follow hand bone when present) and
 * caches the result. Returns `null` when the rig exposes no hand bone (e.g. the
 * capsule fallback), so callers can fall back to a body-relative offset.
 */
export function attackHandWorld(
  inst: CharacterInstance,
  out: THREE.Vector3,
): THREE.Vector3 | null {
  let bone = inst.attackHand;
  if (bone === undefined) {
    bone = inst.handBone ?? null;
    if (!bone) {
      inst.group.traverse((o) => {
        if (bone) return;
        const b = o as THREE.Bone;
        if (b.isBone && _RIGHT_HAND_RE.test(sanitizeBone(b.name))) bone = b;
      });
    }
    inst.attackHand = bone;
  }
  if (!bone) return null;
  bone.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/**
 * World-space segment (grip -> tip) of an attached `makeBlade` weapon, so the
 * melee collider can follow the actual animated blade point instead of a
 * facing-derived arc. Returns false for instances with no attached blade
 * (champions wear embedded kit weapons, handled by the hand-anchored path).
 * The blade box is 1.7 tall, centered on the mesh origin, pointing +Y.
 */
export function bladeSegmentWorld(
  inst: CharacterInstance,
  outBase: THREE.Vector3,
  outTip: THREE.Vector3,
): boolean {
  const weapon = inst.weapon;
  if (!weapon) return false;
  const blade = weapon.blade;
  blade.updateWorldMatrix(true, false);
  outBase.set(0, -0.85, 0).applyMatrix4(blade.matrixWorld);
  outTip.set(0, 0.85, 0).applyMatrix4(blade.matrixWorld);
  return true;
}

// The five clips that participate in the directional locomotion blend.
const LOCO_CLIPS: readonly ClipName[] = [
  "idle",
  "walk",
  "run",
  "strafeLeft",
  "strafeRight",
];

/**
 * Target blend weight per locomotion clip from the movement state. Instead of
 * hard-switching one clip at a time, movement is expressed as a weighted mix:
 * overall movement amount fades idle out, lateral velocity feeds the strafe
 * clips, and speed crossfades walk into run. The result is smooth directional
 * transitions (e.g. forward -> diagonal -> strafe) with no clip "pops".
 */
function locoTargets(s: AnimState): Record<string, number> {
  const move = THREE.MathUtils.clamp(s.speed01 / 0.15, 0, 1);
  const strafeAmt =
    s.speed01 > 0.05
      ? THREE.MathUtils.clamp((Math.abs(s.strafe) - 0.3) / 0.35, 0, 1)
      : 0;
  const runBlend = THREE.MathUtils.clamp((s.speed01 - 0.4) / 0.3, 0, 1);
  const fwd = move * (1 - strafeAmt);
  return {
    idle: 1 - move,
    walk: fwd * (1 - runBlend),
    run: fwd * runBlend,
    strafeLeft: s.strafe < 0 ? move * strafeAmt : 0,
    strafeRight: s.strafe > 0 ? move * strafeAmt : 0,
  };
}

/** Fade out every blend participant (except `keep`) when a one-shot takes over. */
function exitLocoBlend(inst: CharacterInstance, keep?: ClipName): void {
  if (!inst.locoActive) return;
  for (const name of LOCO_CLIPS) {
    if (name === keep) continue;
    const a = inst.actions?.[name];
    if (!a) continue;
    // Re-assert the current weight before scheduling the fade so a fade
    // cancelled by an earlier setEffectiveWeight still starts from truth.
    a.setEffectiveWeight(a.getEffectiveWeight());
    a.fadeOut(0.15);
  }
  inst.locoActive = false;
  inst.locoWeights = {};
}

/**
 * Drive the 5-way locomotion blend: all available locomotion actions play
 * simultaneously and their weights ease toward the directional targets each
 * frame, with per-clip time-scales synced to real movement speed.
 */
function blendLocomotion(inst: CharacterInstance, dt: number, s: AnimState): void {
  const actions = inst.actions;
  if (!actions) return;
  const targets = locoTargets(s);
  if (!inst.locoActive) {
    // Entering the blend from a one-shot (attack/jump/guard): fade it out.
    const prev =
      inst.currentClip && !LOCO_CLIPS.includes(inst.currentClip)
        ? actions[inst.currentClip]
        : undefined;
    prev?.fadeOut(0.18);
    inst.locoActive = true;
    inst.locoWeights = inst.locoWeights ?? {};
  }
  const w = inst.locoWeights!;
  const ease = Math.min(1, dt * 10);
  let best: ClipName = "idle";
  let bestW = -1;
  for (const name of LOCO_CLIPS) {
    const a = actions[name];
    if (!a) continue;
    const target = targets[name] ?? 0;
    // Seed from the action's real mixer weight (it may be mid-fade after a
    // one-shot) so re-entering the blend never snaps weights.
    const cur = w[name] ?? a.getEffectiveWeight();
    const next = cur + (target - cur) * ease;
    w[name] = next;
    if (!a.isRunning()) {
      a.reset();
      a.play();
    }
    a.enabled = true;
    a.setEffectiveWeight(next);
    a.setEffectiveTimeScale(locoTimeScale(name, s.speed01));
    if (next > bestW) {
      bestW = next;
      best = name;
    }
  }
  inst.currentClip = best;
}

function updateMixamo(inst: CharacterInstance, dt: number, s: AnimState): void {
  const desired = pickClip(s);
  const strikeActive = s.strike01 >= 0;
  const castActive = s.cast01 !== undefined && s.cast01 >= 0;
  // Restart the cast clip on each new cast (reference cast->release pattern:
  // one one-shot spanning wind-up plus release, time-scaled to the window).
  if (desired === "cast" && castActive && !inst.prevCast) {
    queueOneShot(inst, "cast");
    exitLocoBlend(inst);
    const cast = inst.actions?.cast;
    if (cast && inst.overlayClip === "cast") {
      cast.reset();
      cast.enabled = true;
      cast.setEffectiveWeight(1);
      cast.setEffectiveTimeScale(attackTimeScale(cast, s.castDur));
      cast.play();
      inst.currentClip = "cast";
    }
  } else if (desired === "attack" && strikeActive && !inst.prevStrike) {
    queueOneShot(inst, "attack");
    exitLocoBlend(inst);
    const atk = inst.actions?.attack;
    if (atk && inst.overlayClip === "attack") {
      atk.reset();
      atk.enabled = true;
      atk.setEffectiveWeight(1);
      atk.setEffectiveTimeScale(attackTimeScale(atk, s.strikeDur));
      atk.play();
      inst.currentClip = "attack";
    }
  } else if (
    inst.overlayClip &&
    !strikeActive &&
    !castActive
  ) {
    const queued = finishOverlay(inst);
    if (queued && inst.actions?.[queued]) {
      exitLocoBlend(inst);
      const a = inst.actions[queued]!;
      a.reset();
      a.enabled = true;
      a.setEffectiveWeight(1);
      a.play();
      inst.currentClip = queued;
    }
  } else if (
    LOCO_CLIPS.includes(desired) &&
    !(desired === "attack" && strikeActive) &&
    !(desired === "cast" && castActive)
  ) {
    // Directional locomotion: weighted blend instead of hard clip switches.
    blendLocomotion(inst, dt, s);
  } else {
    // One-shot / stance clips (attack tail, jump, guard): classic crossfade.
    exitLocoBlend(inst, inst.currentClip);
    crossfadeTo(inst, desired, 0.18);
    const loco = locoTimeScale(desired, s.speed01);
    if (loco !== 1) inst.actions?.[desired]?.setEffectiveTimeScale(loco);
  }
  inst.prevStrike = strikeActive;
  inst.prevCast = castActive;
  inst.mixer?.update(dt);
  const sample = s.groundAt ?? inst.terrainAt;
  if (s.grounded && s.airborne01 < 0.08 && sample) {
    applyFootIk(inst, sample);
  }
  updateSaberFollow(inst);
}

/** Attack-clip playback rate so its duration matches the swing window. */
function attackTimeScale(
  atk: THREE.AnimationAction,
  strikeDur: number | undefined,
): number {
  if (!strikeDur || strikeDur <= 0) return 1;
  const clipDur = atk.getClip().duration;
  if (clipDur <= 0) return 1;
  return THREE.MathUtils.clamp(clipDur / strikeDur, 0.5, 4);
}

/**
 * Locomotion playback rate scaled by movement intensity so stride cadence
 * tracks world speed (kills foot-sliding). Clamped so slow/fast extremes stay
 * readable; non-locomotion clips play at their authored rate.
 */
function locoTimeScale(clip: ClipName, speed01: number): number {
  if (clip === "run") {
    return THREE.MathUtils.clamp(0.85 + (speed01 - 0.55) * 1.2, 0.85, 1.4);
  }
  if (clip === "walk" || clip === "strafeLeft" || clip === "strafeRight") {
    return THREE.MathUtils.clamp(0.7 + (speed01 - 0.05) * 1.0, 0.7, 1.2);
  }
  return 1;
}

export function updateCharacterAnim(
  inst: CharacterInstance,
  dt: number,
  s: AnimState,
): void {
  if (inst.mixer && inst.actions) {
    updateMixamo(inst, dt, s);
    if (inst.weapon) {
      const flash = s.hitFlash > 0;
      (inst.weapon.blade.material as THREE.MeshStandardMaterial).emissive.setHex(
        flash ? 0xffffff : 0x000000,
      );
    }
    return;
  }

  const { inner, weapon } = inst;
  inst.phase += dt * (4 + s.speed01 * 10);
  const stride = inst.phase;

  // Locomotion: vertical bob, forward lean, lateral roll.
  const bob = Math.abs(Math.sin(stride)) * 0.09 * s.speed01;
  inner.position.y = bob + s.airborne01 * 0.0;
  inner.rotation.x = 0.16 * s.speed01 + s.airborne01 * 0.25;
  inner.rotation.z = -s.strafe * 0.14;

  // Capsule fallback legs swing for a sense of stride.
  if (!inst.isModel) {
    const legL = inner.userData.legL as THREE.Mesh | undefined;
    const legR = inner.userData.legR as THREE.Mesh | undefined;
    const swing = Math.sin(stride) * 0.5 * s.speed01;
    if (legL) legL.rotation.x = swing;
    if (legR) legR.rotation.x = -swing;
  }

  // Blade pose (only when an attached blade exists; capsule / Lucy fallback).
  let twist = 0;
  if (weapon) {
    const saberPivot = weapon.pivot;
    if (s.strike01 >= 0) {
      // Overhead slash: raised back -> down across the body.
      const t = s.strike01;
      const arc = Math.sin(t * Math.PI);
      saberPivot.rotation.x = READY_X - 1.3 + t * 2.6;
      saberPivot.rotation.z = READY_Z - arc * 1.1;
      twist = arc * 0.3;
    } else if (s.guard) {
      // Blade raised vertical across the chest.
      saberPivot.rotation.x = -0.2;
      saberPivot.rotation.z = 1.15;
    } else {
      // Idle / run ready pose with subtle sway.
      const sway = Math.sin(stride * 0.5) * (0.06 + s.speed01 * 0.12);
      saberPivot.rotation.x = READY_X + sway;
      saberPivot.rotation.z = READY_Z + Math.cos(stride * 0.5) * 0.05 * s.speed01;
    }
    const flash = s.hitFlash > 0;
    (weapon.blade.material as THREE.MeshStandardMaterial).emissive.setHex(
      flash ? 0xffffff : 0x000000,
    );
  }
  inner.rotation.y = twist;
}

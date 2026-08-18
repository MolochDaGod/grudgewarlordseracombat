import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

// The Mixamo animation library lives in Cloudflare R2 (public) under /animations.
// Every clip is authored on the standard "mixamorig:" skeleton, so the clips play
// directly on any mixamorig-rigged model (e.g. Lucy); for the Grudge Bip001 kits
// they are retargeted at load time (see retarget.ts), which needs the raw source
// FBX objects, not just the clips.
//
// "Weapons animator": instead of one shared clip set, each weapon CATEGORY gets a
// category-appropriate clip set so a swordsman, a mage and an archer move and
// fight differently. The real R2 packs used:
//   blade -> animations/sword_shield (full sword-and-shield set)
//   magic -> animations/magic        (two-handed casting set)
//   bow   -> animations/longbow      (full bow set)
// All categories share the locomotion pack for strafes / jump where a category
// has no clean equivalent. Source FBX are cached per-URL so shared clips download
// only once across categories.
const BASE = "https://assets.grudge-studio.com/animations";

export type ClipName =
  | "idle"
  | "walk"
  | "run"
  | "strafeLeft"
  | "strafeRight"
  | "jump"
  | "attack"
  | "cast"
  | "guard"
  | "hit"
  | "death";

/** Weapon category that selects which animation clip set a character uses. */
export type WeaponCategory = "blade" | "magic" | "bow";

/** Map a roster weapon string to its animation category. */
export function weaponCategory(weapon: string): WeaponCategory {
  const w = weapon.toLowerCase();
  if (/bow|crossbow/.test(w)) return "bow";
  if (/staff|wand|tome|orb|scepter|rod/.test(w)) return "magic";
  // sword, axe, hammer, dagger, spear, pick, mace, saber, ...
  return "blade";
}

// Per-category clip sets, mapped to gameplay states. Paths are relative to BASE.
const CLIP_SETS: Record<WeaponCategory, Record<ClipName, string>> = {
  blade: {
    idle: "sword_shield/sword_and_shield_idle.fbx",
    walk: "sword_shield/sword_and_shield_walk.fbx",
    run: "sword_shield/sword_and_shield_run.fbx",
    strafeLeft: "locomotion/left_strafe.fbx",
    strafeRight: "locomotion/right_strafe.fbx",
    jump: "sword_shield/sword_and_shield_jump.fbx",
    attack: "sword_shield/sword_and_shield_slash.fbx",
    cast: "magic/Standing_2H_Magic_Attack_01.fbx",
    guard: "sword_shield/sword_and_shield_block_idle.fbx",
    hit: "sword_shield/sword_and_shield_impact.fbx",
    death: "sword_shield/sword_and_shield_death.fbx",
  },
  magic: {
    idle: "locomotion/idle.fbx",
    walk: "locomotion/walking.fbx",
    run: "locomotion/running.fbx",
    strafeLeft: "locomotion/left_strafe.fbx",
    strafeRight: "locomotion/right_strafe.fbx",
    jump: "locomotion/jump.fbx",
    attack: "magic/Standing_2H_Magic_Attack_01.fbx",
    cast: "magic/Standing_2H_Magic_Attack_01.fbx",
    guard: "magic/Standing_Block_Idle.fbx",
    hit: "magic/Standing_React_Small_From_Front.fbx",
    death: "magic/Standing_React_Death_Forward.fbx",
  },
  bow: {
    idle: "longbow/standing_idle_01.fbx",
    walk: "longbow/standing_walk_forward.fbx",
    run: "longbow/standing_run_forward.fbx",
    strafeLeft: "longbow/standing_run_left.fbx",
    strafeRight: "longbow/standing_run_right.fbx",
    jump: "locomotion/jump.fbx",
    attack: "longbow/standing_draw_arrow.fbx",
    cast: "magic/Standing_2H_Magic_Attack_01.fbx",
    guard: "longbow/standing_block.fbx",
    hit: "longbow/standing_react_small_from_front.fbx",
    death: "longbow/standing_death_forward_01.fbx",
  },
};

export type AnimationLibrary = Record<ClipName, THREE.AnimationClip>;

/**
 * A raw loaded Mixamo source: the parsed FBX object (kept alive so its skeleton
 * can be sampled during retargeting) plus its single gameplay-mapped clip.
 */
export interface RawClip {
  name: ClipName;
  object: THREE.Group;
  clip: THREE.AnimationClip;
}

const fbxLoader = new FBXLoader();

/** Drop every `.position` track so a grounded kit does not hip-float. */
export function stripPositionTracks(clip: THREE.AnimationClip): THREE.AnimationClip {
  clip.tracks = clip.tracks.filter((t) => !/\.position$/i.test(t.name));
  return clip;
}

function clipUrl(rel: string): string {
  return `${BASE}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

// Raw FBX cached by relative path so clips shared across categories (e.g. the
// locomotion strafes) download only once. A failure clears the entry so a later
// attempt can retry.
const rawByUrl = new Map<
  string,
  Promise<{ group: THREE.Group; clip: THREE.AnimationClip }>
>();

function loadFbxRaw(
  rel: string,
): Promise<{ group: THREE.Group; clip: THREE.AnimationClip }> {
  let p = rawByUrl.get(rel);
  if (!p) {
    p = new Promise<{ group: THREE.Group; clip: THREE.AnimationClip }>(
      (resolve, reject) => {
        fbxLoader.load(
          clipUrl(rel),
          (group) => {
            const clip = group.animations[0];
            if (!clip) {
              reject(new Error(`No animation track found in "${rel}"`));
              return;
            }
            // Rotation-only: kit is already grounded. Engine owns world XZ/Y.
            clip.tracks = stripPositionTracks(clip).tracks;
            resolve({ group, clip });
          },
          undefined,
          reject,
        );
      },
    ).catch((err) => {
      rawByUrl.delete(rel);
      throw err;
    });
    rawByUrl.set(rel, p);
  }
  return p;
}

/**
 * Load a single Mixamo clip from an absolute FBX url and tag it with a gameplay
 * clip name. Used by self-contained mixamorig characters (e.g. the Heavy gunner)
 * that ship their own per-clip FBX files rather than a category clip set. The hip
 * translation is dropped so locomotion stays in place (the engine owns world
 * position). Cached by url so repeat loads are free.
 */
const clipByUrl = new Map<string, Promise<THREE.AnimationClip>>();

export function loadClip(url: string, name: ClipName): Promise<THREE.AnimationClip> {
  let p = clipByUrl.get(url);
  if (!p) {
    p = new Promise<THREE.AnimationClip>((resolve, reject) => {
      fbxLoader.load(
        url,
        (group) => {
          const clip = group.animations[0];
          if (!clip) {
            reject(new Error(`No animation track found in "${url}"`));
            return;
          }
          clip.tracks = stripPositionTracks(clip).tracks;
          clip.name = name;
          resolve(clip);
        },
        undefined,
        reject,
      );
    }).catch((err) => {
      clipByUrl.delete(url);
      throw err;
    });
    clipByUrl.set(url, p);
  }
  return p;
}

const sourcesByCat = new Map<WeaponCategory, Promise<RawClip[]>>();
const libraryByCat = new Map<WeaponCategory, Promise<AnimationLibrary>>();

/**
 * Load and cache the raw Mixamo sources (FBX objects + clips) for a weapon
 * category, used by the retarget path (Bip001 kits). A failure clears the cache
 * so a later attempt can retry.
 */
export function loadAnimationSources(
  category: WeaponCategory,
): Promise<RawClip[]> {
  let p = sourcesByCat.get(category);
  if (!p) {
    p = (async () => {
      const set = CLIP_SETS[category];
      const names = Object.keys(set) as ClipName[];
      return Promise.all(
        names.map(async (name): Promise<RawClip> => {
          const { group, clip } = await loadFbxRaw(set[name]);
          clip.name = name;
          return { name, object: group, clip };
        }),
      );
    })().catch((err) => {
      sourcesByCat.delete(category);
      throw err;
    });
    sourcesByCat.set(category, p);
  }
  return p;
}

/**
 * Load and cache the clip library for a category (state -> AnimationClip), used
 * directly by mixamorig-rigged models such as Lucy (no retargeting).
 */
export function loadAnimationLibrary(
  category: WeaponCategory,
): Promise<AnimationLibrary> {
  let p = libraryByCat.get(category);
  if (!p) {
    p = loadAnimationSources(category)
      .then((raws) => {
        const lib = {} as AnimationLibrary;
        for (const r of raws) lib[r.name] = r.clip;
        return lib;
      })
      .catch((err) => {
        libraryByCat.delete(category);
        throw err;
      });
    libraryByCat.set(category, p);
  }
  return p;
}

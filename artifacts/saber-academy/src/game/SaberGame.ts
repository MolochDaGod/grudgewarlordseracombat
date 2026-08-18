import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { AdvancedLightingSystem } from "grudge-studio/tools";
import { CastingSystem, CastAimLine, CAST_DEFS, type CastDef } from "./casting";
import { TelegraphSystem } from "./telegraphs";
import {
  loadCharacterTemplate,
  instantiateMeshyAnimated,
  instantiateMeshyModel,
  instantiateModel,
  instantiateGrudgeAnimated,
  instantiateCapsule,
  instantiateLucy,
  loadLucyTemplate,
  instantiateHeavy,
  loadHeavyTemplate,
  instantiateRacalvin,
  loadRacalvinTemplate,
  instantiateToonRts,
  loadToonRtsTemplate,
  type ToonRtsTemplate,
  loadMinionTemplate,
  loadMinionWeapon,
  instantiateMinionAnimated,
  instantiateMinionModel,
  updateCharacterAnim,
  attackHandWorld,
  bladeSegmentWorld,
  disposeInstance,
  type AnimState,
  type CharacterInstance,
} from "./characters";
import {
  loadAnimationLibrary,
  loadAnimationSources,
  loadClip,
  weaponCategory,
  weaponCombatProfile,
  type AnimationLibrary,
  type ClipName,
  type RawClip,
  type WeaponCategory,
} from "./animations";
import { getBip001Clips, detectRetargetRig, type Bip001Clips } from "./retarget";
import { getSkills, type SkillDef } from "./skills";
import { type BuffDef } from "./buffs";
import {
  catalog,
  catalogSkills,
  rangedShot,
  keyLabel,
  applyCatalog,
  snapshotCastDef,
  type WeaponSkillCatalog,
  type OrbShotParams,
  type ArrowShotParams,
} from "./skillcatalog";
import { saveCatalog } from "./studio";
import { mmForWeapon, enemyStandoff } from "./mm";
import { initRapier, PhysicsWorld, type CharacterBody } from "./physics";
import { toonRaceKitUrl } from "@/lib/fleetAssets";
import { StaticWorldBVH, makeBodyHitter, type BodyHitter } from "./worldbvh";
import {
  CombatSteering,
  ThreatTable,
  aggroState,
  type SteerMode,
} from "./brains";
import { COMBAT_DT, CombatTicker } from "./combatTicker";
import {
  HEAVY_WARP,
  LIGHT_WARP,
  advanceWarp,
  resolveWarp,
  type MotionWarp,
} from "./motionWarp";
import {
  WARLORDS_TEST_LOADOUTS,
  type WarlordsLoadout,
} from "./warlordsLoadout";

export type GamePhase = "menu" | "loading" | "playing" | "gameover" | "victory";

/**
 * Survival waves, the free-play Testing Grounds sandbox, or the Animation Test
 * lab (loads the champion through the real skeletal pipeline and lets you drive /
 * force each locomotion clip to verify animation + directional movement).
 */
export type GameMode = "waves" | "sandbox" | "animtest" | "factions";

/** Per-faction accent colors for the Faction War mode (one hue per race). */
export const FACTION_COLORS: Record<string, string> = {
  dwarf: "#e8c77f",
  orc: "#8fe87f",
  elf: "#9fe8d8",
  "high elf": "#9fe8d8",
  undead: "#b07fe8",
  human: "#7fa8e8",
  barbarian: "#e8a05f",
};

/** Selectable Faction War battleground. */
export type FactionMap = "colosseum" | "highlands";

/** Configuration for a Faction War match, resolved by the UI layer. */
export interface FactionConfig {
  /** One champion HeroInfo per race (5 non-player factions + player's race). */
  heroesByRace: Record<string, HeroInfo>;
  /** Squad size (fighters per faction): 2 or 3. */
  squadSize: number;
  /** Which battleground to fight on. */
  map: FactionMap;
}

/** Live animation diagnostics surfaced in the Animation Test lab HUD. */
export interface AnimDiag {
  /** Human-readable animation path actually in use for the player model. */
  animMode: string;
  /** True when a real AnimationMixer is driving the skeleton (not procedural). */
  skeletal: boolean;
  /** The clip currently playing on the player model. */
  currentClip: string;
  /** A clip forced via the lab buttons, or null when driven live by WASD. */
  forcedClip: string | null;
  /** Auto clip-cycle on. */
  auto: boolean;
  /** Movement keys currently held, e.g. "W - - D". */
  keys: string;
  /** 0..1 locomotion intensity fed to the animator. */
  speed01: number;
  /** -1..1 lateral (strafe) component relative to facing. */
  strafe: number;
  /** Body facing in degrees. */
  facingDeg: number;
}

/**
 * Synthesize an AnimState that makes pickClip select `clip`, so the Animation
 * Test lab can force any single locomotion clip onto the player model.
 */
function animStateForClip(clip: ClipName): AnimState {
  const base: AnimState = {
    speed01: 0,
    strafe: 0,
    grounded: true,
    airborne01: 0,
    strike01: -1,
    guard: false,
    hitFlash: 0,
  };
  switch (clip) {
    case "walk":
      return { ...base, speed01: 0.3 };
    case "run":
      return { ...base, speed01: 0.9 };
    case "strafeLeft":
      return { ...base, speed01: 0.4, strafe: -1 };
    case "strafeRight":
      return { ...base, speed01: 0.4, strafe: 1 };
    case "jump":
      return { ...base, grounded: false, airborne01: 0.5 };
    case "attack":
    case "attack2":
    case "attack3":
      return { ...base, strike01: 0.5, strikeClip: clip };
    case "cast":
      return { ...base, cast01: 0.4, castDur: 1.2 };
    case "guard":
      return { ...base, guard: true };
    case "hit":
      return { ...base, hitFlash: 1 };
    case "idle":
    case "death":
    default:
      return base;
  }
}

export interface HeroInfo {
  id: string;
  name: string;
  title: string;
  faction: string;
  factionColor: string;
  modelUrl: string;
  weapon: string;
  raceId: string;
  /** Champion class from the roster (selects the signature skill kit). */
  classId?: string;
  /**
   * "mixamo" => real skeletal-animated FBX (Lucy); "racalvin" => the secret
   * Pirate King (self-contained rigged FBX + bundled clips); "meshy" => an
   * AI-generated auto-rigged GLB (Mixamo library retargeted onto its
   * prefix-less Mixamo-style skeleton); "toonrts" => a Toon RTS faction GLB
   * (self-contained Bip001 rig with embedded greatsword clips); otherwise a
   * Bip001 GLB driven by the retargeted clip library.
   */
  rig?: "mixamo" | "racalvin" | "meshy" | "toonrts";
}

/** A signature skill as surfaced to the HUD skill bar. */
export interface SkillHud {
  id: string;
  name: string;
  key: string;
  cost: number;
  /** 1 = just cast (full cooldown), 0 = ready. */
  cooldownPct: number;
  /** Off cooldown and enough force to cast. */
  ready: boolean;
}

export interface HudState {
  phase: GamePhase;
  mode: GameMode;
  playerHealth: number;
  playerMaxHealth: number;
  forceEnergy: number;
  forceMaxEnergy: number;
  score: number;
  wave: number;
  totalWaves: number;
  enemiesRemaining: number;
  combo: number;
  blocking: boolean;
  message: string;
  playerName: string;
  playerTitle: string;
  factionColor: string;
  skills: SkillHud[];
  /** A tab-target / lock-on enemy is currently focused. */
  targetLocked: boolean;
  /** Focused enemy (hard lock first, else soft focus) for the target frame. */
  target?: { name: string; healthPct: number; locked: boolean };
  /** Elemental cast wind-up in progress (drives the HUD cast bar). */
  castBar?: { name: string; t01: number; color: string };
  /** Animation Test diagnostics; present only while in animtest mode. */
  diag?: AnimDiag;
}

type Listener = (s: HudState) => void;

/** Delay (ms) from attack-anim start to projectile release for bows/staves. */
const RANGED_RELEASE_MS = 300;
/** Player mage LMB: cast time before the arcane bolt fires (seconds). */
const ARCANE_CAST_T = 1.5;

/** Slim arrow mesh (shaft + head + fletch glow), forward along +Z. */
function makeArrowNode(color: number): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xd8c9a3 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 5), mat);
  shaft.rotation.x = Math.PI / 2;
  const headMat = new THREE.MeshBasicMaterial({ color });
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), headMat);
  head.rotation.x = Math.PI / 2;
  head.position.z = 0.4;
  const fletch = new THREE.Mesh(
    new THREE.ConeGeometry(0.045, 0.12, 4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
  );
  fletch.rotation.x = -Math.PI / 2;
  fletch.position.z = -0.34;
  g.add(shaft, head, fletch);
  return g;
}

/** Point a node's +Z axis along a (normalized) travel direction. */
function orientAlong(node: THREE.Object3D, dir: THREE.Vector3): void {
  node.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
}

/** Dispose every mesh/sprite geometry+material inside a projectile node. */
function disposeShotNode(node: THREE.Object3D): void {
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[];
    if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
    else if (m) m.dispose();
  });
}

/** Which projectile a ranged weapon fires: bow -> arrow, staff -> orb. */
function shotKindFor(weapon: string): "arrow" | "orb" | "bolt" {
  const w = weapon.toLowerCase();
  if (w.includes("bow")) return "arrow";
  if (w.includes("staff")) return "orb";
  return "bolt";
}

/** Human-readable name for the HUD target frame, derived from the weapon. */
function enemyLabel(weapon: string, ranged: boolean): string {
  const w = weapon.toLowerCase();
  if (w.includes("bow")) return "Ranger";
  if (w.includes("staff")) return "Mage";
  if (w.includes("rifle")) return "Heavy Gunner";
  if (w.includes("greatsword")) return "Warrior";
  if (w.includes("shield")) return "Knight";
  if (w) return "Duelist";
  return ranged ? "Marksman" : "Hostile";
}

/**
 * Behavior archetype driving the enemy's AI branch in updateEnemies:
 * - "grunt": the classic close-and-swing melee / kiting gunner behavior.
 * - "flanker": fast, fragile melee that orbits sideways while closing in.
 * - "bruiser": slow, heavy melee with a longer telegraph and a harder,
 *   knockback-laced blow; resists stagger.
 * - "caster": kites like a gunner but attacks through the elemental casting
 *   system (a telegraphed line cast instead of a bullet).
 */
type EnemyArchetype = "grunt" | "flanker" | "bruiser" | "caster";

/**
 * Faction War squad role. Extends the AI archetypes with "ranged": a grunt-AI
 * unit that uses the faction's own model but is forced to fight at range (fires
 * shots) so squads without the dedicated staff-caster model still field a
 * backline fighter. All other roles map directly to an EnemyArchetype.
 */
type FactionRole = EnemyArchetype | "ranged";

interface Enemy {
  inst: CharacterInstance;
  /**
   * Faction/team id. 0 = the player's faction (the player + AI allies). Any
   * non-zero value is a rival AI faction. Units only attack units of a
   * different team; the player is treated as a virtual unit on team 0.
   */

  team: number;
  /** Faction accent color (nameplate/bar tint). */

  factionColor: number;
  /** True for AI allies on the player's team (never target team 0). */

  ally: boolean;
  /** Display name for the HUD target frame. */

  label: string;
  /** AI behavior branch (see EnemyArchetype). */

  archetype: EnemyArchetype;
  /** Caster: wind-up in progress (aura grows, then the line cast releases). */

  pendingCast: { def: CastDef; t: number; aura: THREE.Sprite } | null;
  /** Faction-specific cast override; falls back to ENEMY_CAST_DEF when absent. */
  castDef?: CastDef;
  /**
   * Support role: can this unit pulse an AoE heal to nearby same-team allies?
   * True for mage-type units (casters / staff wielders) and knight-class melee.
   * Faction War only (AI units of those classes, allied or rival).
   */

  healer: boolean;
  /** Cooldown (s) until this healer may pulse again. */

  healCooldown: number;
  /** Heal cast pause: brief plant while the heal pulse resolves. */

  healCast: number;
  /** What this enemy's ranged attack looks like (from its weapon). */

  shotKind: "arrow" | "orb" | "bolt";

  health: number;

  maxHealth: number;

  alive: boolean;

  attackCooldown: number;

  hitFlash: number;

  stagger: number;
  /** Parry stun: frozen this long, or until the next player hit clears it. */

  stunTimer: number;

  speed: number;

  moving: boolean;

  gone: boolean;

  bar: THREE.Sprite;

  barCanvas: HTMLCanvasElement;

  barTex: THREE.CanvasTexture;

  swing: number;
  /** Decaying knockback velocity (XZ), applied through the controller. */

  knockback: THREE.Vector3;
  /** Kinematic physics body (null when physics is unavailable). */

  body: CharacterBody | null;
  /** Precise weapon-vs-body hit tester (null falls back to a capsule test). */

  hitter: BodyHitter | null;
  /** Swing id the hitter was last refit for (refit at most once per swing). */

  hitterSwing: number;
  /** Ranged gunner: kites the player and fires bullets instead of melee. */

  ranged: boolean;
  /** Persistent strafe direction (+1/-1) used while holding range as a gunner. */

  strafeDir: number;
  /** Movement Motivation (+100 close gap .. -100 keep distance), from its weapon. */

  mm: number;
  /** Standoff distance this enemy tries to hold, derived from `mm` (see mm.ts). */

  desiredRange: number;
  /**
   * Weapon Skill Studio target dummy: takes damage and shows numbers but never
   * moves or attacks (a passive practice target). False for every real fighter.
   */
  passive?: boolean;
  /** Active status effects applied by weapon-skill buffs/debuffs. */
  statusEffects: StatusEffect[];
  /** Yuka root steering (never writes bones / mixer). */
  steer: CombatSteering;
  /** uMMORPG threat table — not nearest-only. */
  threat: ThreatTable;
  spawnX: number;
  spawnZ: number;
  brainId: string;
}

/**
 * Ragdoll-lite corpse: on death the body is detached from gameplay (collider,
 * health bar, AI) and launched as a rigid tumbling prop — impulse direction
 * and intensity come from the killing blow's knockback, so explosion kills
 * (Force Push, Meteor Rush) hurl bodies while a light slash just drops them.
 */
interface Corpse {
  inst: CharacterInstance;
  vel: THREE.Vector3;
  vy: number;
  spinAxis: THREE.Vector3;
  spinRate: number;
  t: number;
}

interface Spark {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

/** Tint colors for each status type (used for the floating VFX sprite). */
const STATUS_COLORS: Record<string, number> = {
  slow:    0x88aaff, // cool blue
  burn:    0xff5500, // orange-red
  stun:    0xffee00, // bright yellow
  poison:  0x44ff44, // lime green
  heal:    0x00ffaa, // teal
  haste:   0xffffff, // white
};

/** An active status effect on an enemy or the player. */
interface StatusEffect {
  type: string; // BuffType — kept as string to avoid circular imports
  magnitude: number;
  /** Remaining duration in seconds. */
  remaining: number;
  /** Countdown until next DoT tick (burn / poison). */
  dotTimer: number;
  /** Floating sprite anchored above the target (null when disposed). */
  vfx: THREE.Sprite | null;
}

interface EnemyDef {
  template: THREE.Group | null;
  color: number;
  /** Roster weapon string (selects the embedded weapon mesh). */
  weapon: string;
  /** Weapon category (selects the animation clip set). */
  category: WeaponCategory;
  /** Retargeted Mixamo clips for this template's skeleton, if available. */
  clips: Bip001Clips | null;
  /** Meshy heroes instantiate via the meshy path (blade attach, no kit prune). */
  rig?: "meshy" | "toonrts" | "minion";
  /** Toon RTS heroes carry their own template + embedded clips. */
  toonTemplate?: ToonRtsTemplate | null;
  /** Minions: the set's own weapon FBX, attached to the right hand. */
  weaponTemplate?: THREE.Group | null;
  /** Minions: fixed HUD label (e.g. "Ash Walker") instead of a weapon-derived one. */
  label?: string;
  /** Behavior archetype for the dedicated Toon RTS enemy roster. */
  archetype?: EnemyArchetype;
  /** Race id (Faction War: selects which def spawns for each faction). */
  raceId?: string;
}

/** A traveling skill projectile (fireball, bolt, arrow). */
interface Projectile {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  origin: THREE.Vector3;
  def: SkillDef;
  /** Boomerang: flies out to `def.range`, then homes back to the player. */
  boomerang?: boolean;
  returning?: boolean;
  /** Per-enemy re-hit cooldown so a boomerang can strike again on its return. */
  hitCd?: Map<Enemy, number>;
  age?: number;
}

/** A projectile fired by a ranged enemy; resolves against the player via damagePlayer. */
interface EnemyShot {
  /** Arrow mesh group, magic orb group, or tracer sprite. */
  node: THREE.Object3D;
  velocity: THREE.Vector3;
  origin: THREE.Vector3;
  range: number;
  damage: number;
  shooter: Enemy;
  color: number;
  /** Unit this shot was aimed at (null = the player). */
  target: Enemy | null;
}

/** A projectile fired by the player's bow or staff (LMB ranged attacks). */
interface PlayerShot {
  node: THREE.Object3D;
  velocity: THREE.Vector3;
  origin: THREE.Vector3;
  range: number;
  damage: number;
  color: number;
  kind: "arrow" | "orb";
  /** Orb splash radius (arrows are single-target). */
  radius: number;
}

/** An expanding ground nova (AoE applied on spawn; this is the visual). */
interface Nova {
  obj: THREE.Group;
  ring: THREE.Mesh;
  flash: THREE.Sprite;
  radius: number;
  life: number;
  maxLife: number;
}

/** A short-lived additive impact burst. */
interface Flash {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  grow: number;
}

/**
 * Resolve a champion's skill class (drives `getSkills`). Lucy (mixamo) is the
 * Blade Dancer; otherwise we match the faction name against a known class, and
 * fall back to the weapon category (bow -> ranger, magic -> mage, else warrior)
 * so every champion always gets a coherent two-skill kit.
 */
function classFor(hero: HeroInfo): string {
  if (hero.rig === "mixamo" || hero.rig === "racalvin") return "blade dancer";
  const known = ["blade dancer", "worge", "mage", "ranger", "warrior"];
  const cls = (hero.classId ?? "").toLowerCase();
  if (known.includes(cls)) return cls;
  const f = (hero.faction ?? "").toLowerCase();
  for (const c of known) {
    if (f.includes(c)) return c;
  }
  const cat = weaponCategory(hero.weapon);
  if (cat === "bow") return "ranger";
  if (cat === "magic") return "mage";
  return "warrior";
}

const ATTACK_DUR = 0.46;
const WALK_SPEED = 8;
const SPRINT_SPEED = 15;
const GUARD_SPEED = 3.2;
const DASH_SPEED = 40;
const DASH_TIME = 0.18;
const DASH_COST = 26;
/** MMB pistol-draw tentacle hook: shoot at crosshair, dash to the hit. */
const GRAPPLE_RANGE = 22;
const GRAPPLE_COST = 14;
const GRAPPLE_CD = 0.85;
const GRAPPLE_SPEED = 32;
const GRAPPLE_SHOOT = 0.12;
const DASH_WINDOW = 0.28;
const DODGE_IFRAMES = 0.34;
const PARRY_WINDOW = 0.26;
const COMBO_CHAIN_WINDOW = 0.55;
const COMBO_CANCEL = 0.18;
const STUN_TIME = 2.0;
const BLOCK_PUSHBACK = 9;
// Deterministic attack lunge: strikes step the player into contact range.
const LUNGE_MAX = 5.0; // farthest gap a single strike will close (world units)
const LUNGE_SPEED = 26; // lunge travel speed during the swing windup
const LUNGE_STANDOFF = 2.2; // desired distance from the target at contact
// Force Jump: double-tap Space for a second, force-powered jump mid-air.
const FJUMP_COST = 18;
const FJUMP_VEL = 11;
const TRAIL_LIFE = 0.32; // per-afterimage fade time of the motion-blur trail
// Force Push (R): radial shockwave that hurls every nearby enemy away.
const PUSH_COST = 30;
const PUSH_CD = 7;
const PUSH_RADIUS = 9;
const PUSH_POWER = 34;
// Drawn slash (LMB hold) / drawn guard (MMB drag) tuning.
const DRAW_HOLD_T = 0.22; // hold LMB this long to start drawing a slash path
const DRAW_SENS = 0.0016; // mouse delta px -> screen fraction while drawing
const DRAW_INK_SLASH = 1.5; // max slash path length (screen fractions) — limited ink
const DRAW_INK_GUARD = 1.9; // max guard path length
const DRAW_MIN_LEN = 0.12; // ignore strokes shorter than this
const SLASH_EXEC_T = 0.34; // seconds the sword sweeps the drawn path
const SLASH_COST = 12; // force cost of a drawn slash
const SLASH_DMG = 30; // per-enemy damage of a drawn slash
const GUARD_LIFE = 3.2; // seconds a drawn guard ribbon persists
const GUARD_COST = 18; // force cost of a drawn guard
const GUARD_HALF_H = 0.8; // ribbon half-height (world units)
const GUARD_BLOCK_R = 0.9; // how close a bullet/attack line must pass to be blocked

// Ranged gunner tuning.
const KITE_BAND = 2; // hysteresis: back off only when this far inside desiredRange
const GUNNER_FIRE_RANGE = 26; // only fire within this distance
const GUNNER_FIRE_CD = 1.9; // base seconds between shots
const BULLET_SPEED = 34;
const BULLET_RANGE = 60;
// Archetype tuning (flanker / bruiser / caster; see EnemyArchetype).
const FLANKER_ORBIT_BAND = 9; // inside this range a flanker blends in orbit motion
const FLANKER_ATTACK_CD = 1.0; // faster, lighter swings than a grunt
const BRUISER_TELEGRAPH = 0.8; // long, readable wind-up before the heavy blow
const BRUISER_KNOCKBACK = 14; // shove applied to the player on a landed blow
const CASTER_RANGE = 20; // starts casting within this distance
const CASTER_CD = 4.2; // base seconds between line casts
// Support heal (mage-type + knight-class units, Faction War only).
const HEAL_RADIUS = 6; // AoE pulse radius around the healer
const HEAL_AMOUNT = 30; // hp restored to each same-team ally in range
const HEAL_TRIGGER = 0.6; // pulse when self/an ally in range is below this hp%
const HEAL_CD_MIN = 8; // seconds
const HEAL_CD_MAX = 12;
const HEAL_CAST = 0.55; // brief plant while the pulse resolves
const HEAL_COLOR = 0x7fffa0; // green/gold heal VFX accent
/** The enemy caster's line cast (damage is scaled per wave at release). */
const ENEMY_CAST_DEF: CastDef = {
  element: "thunder",
  name: "Void Lance",
  key: "",
  range: 24,
  speed: 26,
  damage: 12,
  radius: 2.4,
  knock: 0,
  cost: 0,
  cooldown: 0,
  color: 0xb26bff,
  windup: 0.9,
};

/**
 * Per-race caster spell overrides — each faction's staff-wielder hurls a
 * different elemental line cast so players can read the danger at a glance.
 * Stats inherit from ENEMY_CAST_DEF (cost/cooldown handled by CASTER_CD);
 * only the element, name, visual, and a few feel tweaks differ per race.
 */
const FACTION_CAST_DEFS: Record<string, CastDef> = {
  dwarf: {
    ...ENEMY_CAST_DEF,
    element: "fire",
    name: "Forge Bolt",
    color: 0xff6622,
    range: 18,
    speed: 22,
    radius: 3.0,
    windup: 0.8,
  },
  orc: {
    ...ENEMY_CAST_DEF,
    element: "nova",
    name: "Warburst Beam",
    color: 0x5fc8ff,
    range: 22,
    speed: 58,
    radius: 2.2,
    windup: 1.0,
  },
  elf: {
    ...ENEMY_CAST_DEF,
    element: "ice",
    name: "Frost Spear",
    color: 0x8fd8ff,
    range: 16,
    speed: 16,
    radius: 2.4,
    windup: 0.85,
  },
  "high elf": {
    ...ENEMY_CAST_DEF,
    element: "ice",
    name: "Winter Lance",
    color: 0xaae8ff,
    range: 16,
    speed: 16,
    radius: 2.4,
    windup: 0.85,
  },
  undead: {
    ...ENEMY_CAST_DEF,
    element: "thunder",
    name: "Void Lance",
    color: 0xb26bff,
    range: 24,
    speed: 26,
    radius: 2.4,
    windup: 0.9,
  },
  human: {
    ...ENEMY_CAST_DEF,
    element: "snare",
    name: "Voltaic Net",
    color: 0x8a5cff,
    range: 17,
    speed: 44,
    radius: 3.0,
    windup: 0.75,
    castShape: "zone",
    zoneRadius: 3.0,
    hold: 0.8,
  },
  barbarian: {
    ...ENEMY_CAST_DEF,
    element: "volley",
    name: "Sky Barrage",
    color: 0xffd65a,
    range: 18,
    speed: 40,
    radius: 3.2,
    windup: 0.7,
    castShape: "zone",
    zoneRadius: 3.2,
    hold: 1.0,
  },
};
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 2.0;
const ENEMY_RADIUS = 0.5;
const ENEMY_HEIGHT = 2.0;
const KNOCKBACK_DECAY = 7;

/** Closest point on segment [a,b] to point p (returns a new vector). */
function closestPointOnSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  p: THREE.Vector3,
): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(
    p.clone().sub(a).dot(ab) / Math.max(1e-6, ab.lengthSq()),
    0,
    1,
  );
  return a.clone().addScaledVector(ab, t);
}

export class SaberGame {
  private canvas: HTMLCanvasElement;

  private renderer: THREE.WebGLRenderer;

  private scene: THREE.Scene;

  private camera: THREE.PerspectiveCamera;

  private clock = new THREE.Clock();

  private lighting: AdvancedLightingSystem;

  // ---- third-person orbit follow camera (self-owned, not the SDK controller) ----
  /** Horizontal look angle; atan2(fwd.x, fwd.z), so this IS the camera heading. */
  private camYaw = Math.PI;

  /** Camera look heading (radians), updated each frame; used for crosshair aim. */
  private camHeading = Math.PI;

  /** Vertical look angle (camera elevation above the target), radians. */
  private camPitch = 0.42;

  /** Resting distance from the framed target back to the camera. */
  private camDist = 8.5;

  private camShakeAmp = 0;

  private camShakeT = 0;

  private camShakeDur = 0;

  private camRay = new THREE.Raycaster();

  /** Pillars (collidables) + arena meshes/boundary wall (staticColliders) the
   * camera must not clip through; assembled once after the arena is built. */
  private camOccluders: THREE.Object3D[] = [];

  private camTmpTarget = new THREE.Vector3();

  private camTmpDesired = new THREE.Vector3();

  private camTmpDir = new THREE.Vector3();

  private player = new THREE.Group();

  private playerInst: CharacterInstance | null = null;

  private enemies: Enemy[] = [];

  private enemyDefs: EnemyDef[] = [];

  private minionDefs: EnemyDef[] = [];

  /** Dedicated Toon RTS archetype roster (flanker / bruiser / caster / archer). */
  private archetypeDefs: EnemyDef[] = [];

  /** Ranged-gunner template + clips (mixamorig "Heavy"), loaded best-effort. */
  private gunnerDef: { template: THREE.Group; library: Partial<AnimationLibrary> } | null =
    null;

  /** Raw Mixamo sources for Bip001 retargeting, cached per weapon category. */
  private animSources = new Map<WeaponCategory, RawClip[]>();

  private sparks: Spark[] = [];

  private collidables: THREE.Object3D[] = [];

  /** Arena meshes used to build mesh-accurate static colliders + ground BVH. */
  private staticColliders: THREE.Mesh[] = [];

  private physics: PhysicsWorld | null = null;

  private worldBvh: StaticWorldBVH | null = null;

  private playerBody: CharacterBody | null = null;

  /** Latched once physics/BVH throws at runtime, so we warn only once. */
  private physicsDisabled = false;

  private worldBvhDisabled = false;

  // ---- skills & VFX ----
  private skills: SkillDef[] = [];

  /** Remaining cooldown (seconds) per skill, parallel to `skills`. */
  private cooldowns: number[] = [];

  /** Elemental line-cast skills (keys 1..3); see casting.ts. */
  private casting: CastingSystem | null = null;

  private castCooldowns: number[] = CAST_DEFS.map(() => 0);

  /** Casts winding up (aura phase); released when their timer elapses. */
  private pendingCasts: { def: CastDef; t: number; aura: THREE.Sprite }[] = [];

  /**
   * Signature skill with a cast timer (Warcry): circle VFX + HUD bar.
   * The same timer is the mobility / dash-blur window when skill.mobility.
   */
  private pendingSkill: {
    skill: SkillDef;
    t: number;
    dur: number;
    resolved: boolean;
    fade: number;
    root: THREE.Object3D | null;
    mixer: THREE.AnimationMixer | null;
  } | null = null;

  private warcryProto: {
    scene: THREE.Object3D;
    clip: THREE.AnimationClip | null;
    extent: number;
  } | null = null;

  /** MOBA-style linear aim strip shown while a cast winds up. */
  private castAimLine: CastAimLine | null = null;

  /** Seconds left in the cast animation window (wind-up + release tail). */
  private castAnimT = 0;

  private castAnimDur = 0;

  /** Soft focus: the enemy under the reticle, aimed at without a hard lock. */
  private softTarget: Enemy | null = null;

  private softMarker: THREE.Sprite | null = null;

  /** Fixed-step simulation accumulator (deterministic gameplay/animation). */
  private simAccum = 0;
  private readonly ticker = new CombatTicker();

  /** RTS-style ground telegraphs (uploaded warning/arrow indicator props). */
  private telegraphs: TelegraphSystem | null = null;

  private projectiles: Projectile[] = [];

  private enemyShots: EnemyShot[] = [];

  private playerShots: PlayerShot[] = [];

  /** Player weapon category: drives LMB behavior (melee / bow / staff). */
  private playerCategory: WeaponCategory = "blade";

  /** Roster weapon string — GRUDGE6 profile + Toon clip map. */
  private playerWeapon = "sword";

  /** Light-combo overlay clip for the current swing. */
  private strikeClip: ClipName = "attack";

  /** GRUDGE6 windup / active window for the current melee swing. */
  private meleeWindup = 0.22;

  private meleeActive = 0.28;

  /** Bow / staff LMB charge length (HUD + fire). */
  private rangedChargeDur = 0;

  /** Pending projectile released when the charge / draw timer ends. */
  private pendingShot: "arrow" | "orb" | null = null;

  /** Mage LMB: remaining cast time; > 0 means an arcane bolt is charging. */
  private arcaneCharge = 0;

  private novas: Nova[] = [];

  private flashes: Flash[] = [];

  // ---- Whirlwind Dash (blade dancer Q): a spinning forward dash that sweeps
  // damage along its path once per enemy, with a cyclone visual that follows. ----
  private spinTimer = 0;

  private spinDef: SkillDef | null = null;

  private spinHits = new Set<Enemy>();

  private spinObj: THREE.Group | null = null;

  private spinRing: THREE.Mesh | null = null;

  private vfxTextures = new Map<string, THREE.Texture>();

  private vfxLoader = new THREE.TextureLoader();

  /**
   * The CastDef being released right now — set in releaseCast so the shared
   * onDamage closure can read its buffs when the cast travels/hits.
   */
  private _activeCastDef: ReturnType<typeof Object.assign> | null = null;

  /** Active status effects on the player (from self-targeted skill buffs). */
  private playerStatusEffects: StatusEffect[] = [];

  // ---- mode ----
  private mode: GameMode = "waves";

  /**
   * Transient flag read by finishEnemySpawn: when true the next spawned unit
   * is a passive Weapon Skill Studio target dummy. Set around studio spawns.
   */
  private spawnAsPassive = false;

  /** Throttle HUD emits (force/cooldown bars) to ~10/s instead of every frame. */
  private hudAccum = 0;

  // ---- Faction War ----
  /** Pending faction config for the next start (set by startFactions). */
  private factionConfig: FactionConfig | null = null;

  /** The player's team (always 0). */
  private readonly playerTeam = 0;

  /** GLB arena scene loaded for the Faction War mode (null otherwise). */
  private factionArena: THREE.Group | null = null;

  /** Squad spawn ring radius derived from the fitted GLB arena interior. */
  private factionSpawnRadius = 40;

  /** Scattered terrain props (Highlands map) added under factionArena. */
  private factionProps: THREE.Object3D[] = [];

  /** Cached terrain FBX templates (by filename), loaded once and cloned. */
  private terrainTemplates: Map<string, THREE.Group> | null = null;

  /** Most recent enemy caster's target (null = the player). */
  private enemyCastTarget: Enemy | null = null;

  /** Procedural arena objects (hidden when the GLB arena is active). */
  private procArena: THREE.Object3D[] = [];

  /** Procedural arena's static collider meshes (restored for waves/sandbox). */
  private procColliders: THREE.Mesh[] = [];

  /** Procedural arena's pillar collidables (restored for waves/sandbox). */
  private procCollidables: THREE.Object3D[] = [];

  // ---- animation test lab ----
  /** Diagnostic label of the animation path the loaded player model uses. */
  private playerAnimMode = "";

  /** When set (animtest), force this clip instead of deriving from movement. */
  private forcedClip: ClipName | null = null;

  /** Auto-cycle through the locomotion clips (animtest). */
  private animTestAuto = false;

  private animTestTimer = 0;

  /** Last animator inputs, mirrored into the diagnostics readout. */
  private lastSpeed01 = 0;

  private lastStrafe = 0;

  private keys: Record<string, boolean> = {};

  private lastTap: Record<string, number> = {};

  private dashRequested = false;

  private mouseDown = false;

  private rightDown = false;

  private pointerLocked = false;

  /** Tab-target / RMB lock-on: the currently focused enemy (null = free aim). */
  private targetEnemy: Enemy | null = null;

  /** Billboarded marker that hovers over the locked target. */
  private targetMarker: THREE.Sprite | null = null;

  private velocity = new THREE.Vector3();

  private velocityY = 0;

  private grounded = true;

  /**
   * Character heading (yaw). Starts aligned with the camera's initial heading
   * (PI) so the player spawns facing AWAY from the screen — you look at the
   * back of their head, not their face.
   */
  private facing = Math.PI;

  private dashTimer = 0;

  private dashCooldown = 0;
  private grappleCd = 0;
  private grapple: {
    mesh: THREE.Object3D;
    from: THREE.Vector3;
    to: THREE.Vector3;
    nativeLen: number;
    t: number;
    flying: boolean;
  } | null = null;
  private tentacleTpl: THREE.Object3D | null = null;
  private tentacleLen = 17.7;

  /** Dodge invulnerability window (skips incoming damage while > 0). */
  private iFrames = 0;

  /** Parry window opened on guard press (timed perfect-block). */
  private parryTimer = 0;

  private attackTimer = 0;

  /**
   * Per-frame swing-aim callback: (x01, y01, active) in screen fractions.
   * Set by the React layer to move the DOM crosshair to the weapon point
   * without re-rendering; not part of HudState (this fires every frame).
   */
  onAim: ((x01: number, y01: number, active: boolean) => void) | null = null;

  /**
   * Per-frame draw-trail callback: flat [x01,y01,...] points while the player
   * is drawing a slash (LMB hold) or guard (MMB drag) path, null when the
   * gesture ends. Set by the React layer to paint the trail overlay.
   */
  onDraw: ((pts: number[] | null, mode: "slash" | "guard") => void) | null =
    null;

  private drawMode: "none" | "slash" | "guard" = "none";

  /** Screen-fraction gesture points (virtual cursor, starts at center). */
  private drawPts: { x: number; y: number }[] = [];

  /** Total path length drawn so far (screen fractions); capped = limited ink. */
  private drawInk = 0;

  private lmbDownAt = -1;

  private middleDown = false;

  /** A draw attempt was already made this press (prevents retry spam). */
  private drawTried = false;

  /** Scratch vector for guard-ribbon interception sampling. */
  private tmpV3 = new THREE.Vector3();

  /** An executing drawn slash: world path swept over `dur` seconds. */
  private slashExec: {
    pts: THREE.Vector3[];
    t: number;
    dur: number;
    hit: Set<Enemy>;
    ribbon: THREE.Line;
    fade: number;
  } | null = null;

  /** Active drawn guard ribbons: world path that blocks bullets and melee. */
  private guards: {
    pts: THREE.Vector3[];
    life: number;
    mesh: THREE.Mesh;
  }[] = [];

  private aimActive = false;

  private aimBase = new THREE.Vector3();

  private aimTip = new THREE.Vector3();

  private aimUp = new THREE.Vector3();

  private aimNdc = new THREE.Vector3();

  private attackActive = false;

  private attackHitSet = new Set<Enemy>();

  /** Duration of the current swing (light vs heavy), for arc/anim timing. */
  private attackDur = ATTACK_DUR;

  /** True while the active swing is a heavy (Shift+LMB) strike. */
  private attackHeavy = false;

  /** True while the active swing was launched in the air (plunge strike). */
  private attackAir = false;

  /** Current light-attack chain step (0..2); drives arc + damage scaling. */
  private comboStep = 0;

  /** Time left to continue the light-attack chain after a swing ends. */
  private comboChainTimer = 0;

  /** A strike pressed during a swing's cancel window, queued for next step. */
  private bufferedAttack = false;

  private bufferedHeavy = false;

  /** One air dash is allowed per airtime; reset on landing. */
  private airDashUsed = false;

  /** Force Jump: one force-powered second jump per airtime; reset on landing. */
  private doubleJumpUsed = false;

  private forceJumpRequested = false;

  /** Ragdoll-lite tumbling corpses (visual only; gameplay already detached). */
  private corpses: Corpse[] = [];

  /** Motion-blur afterimage trail (spawned during a Force Jump). */
  private trailTimer = 0;

  private trailSpawnT = 0;

  private trail: { sprite: THREE.Sprite; life: number; maxLife: number }[] = [];

  /** Force Push cooldown (R). */
  private pushCooldown = 0;

  /** Deterministic attack lunge: remaining distance + direction this swing. */
  private lungeRemain = 0;

  private lungeDir = new THREE.Vector3();
  /** Motion warp locked at swing press (Samurai TPS turn-then-close). */
  private swingWarp: MotionWarp | null = null;

  /** Enemy this swing was aimed at; facing tracks it for turn-to-contact. */
  private swingAim: Enemy | null = null;

  private blocking = false;

  /** Previous-frame block state, to detect the guard press edge for parry. */
  private prevBlocking = false;

  /** Increments each player swing; used to refit each enemy hitter once. */
  private swingId = 0;

  /** Current ground height under the player (from the world BVH). */
  private groundY = 0;

  private health = 100;

  private maxHealth = 100;

  private force = 100;

  private maxForce = 100;

  private score = 0;

  private wave = 0;

  private totalWaves = 5;

  private combo = 0;

  private comboTimer = 0;

  private message = "";

  private messageTimer = 0;

  private playerName = "";

  private playerTitle = "";

  private factionColor = "#3bb0ff";

  private classId = "warrior";

  private lastPlayer: HeroInfo | null = null;

  private lastPool: HeroInfo[] = [];

  private phase: GamePhase = "menu";

  private listeners: Listener[] = [];

  private rafId = 0;

  private disposed = false;

  private startVersion = 0;

  private timeouts = new Set<number>();

  private tmpV = new THREE.Vector3();

  private tmpV2 = new THREE.Vector3();

  private tmpHand = new THREE.Vector3();

  /** Brief slow-motion after a landed melee hit for impact "juice". */
  private hitStop = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tone mapping: keeps additive VFX (casts, clashes, novas) from
    // clipping to white and grades the dark arena more cinematically.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060c);
    this.scene.fog = new THREE.FogExp2(0x05060c, 0.012);

    this.camera = new THREE.PerspectiveCamera(
      62,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      1000,
    );
    this.camera.position.set(0, 6, 12);

    this.lighting = new AdvancedLightingSystem(this.scene, { shadows: true });
    this.tuneLights();
    this.buildArena();
    // Camera occlusion tests against both pillars and the arena/boundary meshes.
    this.camOccluders = [...this.collidables, ...this.staticColliders];
    this.scene.add(this.player);

    // The orbit follow camera is driven each frame by updateCamera(); mouse
    // movement feeds camYaw/camPitch directly (see onMouseMove).

    this.resize();
    this.bindEvents();
    this.emit();

    this.clock.start();
    this.loop();
  }

  onUpdate(fn: Listener): () => void {
    this.listeners.push(fn);
    fn(this.snapshot());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /**
   * Launch a Faction War match: 6 race squads in a free-for-all. `config`
   * carries one champion HeroInfo per race and the squad size (2 or 3). The
   * player's champion decides their faction (team 0); the other 5 races become
   * rival AI squads.
   */
  async startFactions(
    player: HeroInfo,
    config: FactionConfig,
  ): Promise<void> {
    this.factionConfig = config;
    // Enemy pool = one champion per non-player race, for asset loading.
    const pool = Object.values(config.heroesByRace).filter(
      (h) => h.raceId !== player.raceId,
    );
    await this.start(player, pool, "factions");
  }

  async start(
    player: HeroInfo,
    enemyPool: HeroInfo[],
    mode: GameMode = "waves",
  ): Promise<void> {
    this.lastPlayer = player;
    this.lastPool = enemyPool;
    this.mode = mode;
    if (mode !== "factions") this.factionConfig = null;
    const token = ++this.startVersion;
    this.resetRun();
    this.phase = "loading";
    this.playerName = player.name;
    this.playerTitle = player.title;
    this.factionColor = player.factionColor;
    this.classId = classFor(player);
    this.skills = catalogSkills(this.classId);
    this.cooldowns = this.skills.map(() => 0);
    this.emit();

    // Build off to the side; only commit if this start is still the latest.
    const inst = await this.loadPlayerInstance(player);
    if (this.disposed || token !== this.startVersion) {
      disposeInstance(inst);
      return;
    }
    const defs = await this.loadEnemyDefs(
      enemyPool,
      mode === "factions" ? 6 : 5,
    );
    if (this.disposed || token !== this.startVersion) {
      disposeInstance(inst);
      return;
    }

    void this.ensureTentacle().catch(() => {
      /* first MMB will retry */
    });
    this.gunnerDef = await this.loadGunnerDef();
    if (this.disposed || token !== this.startVersion) {
      disposeInstance(inst);
      return;
    }

    this.minionDefs = await this.loadMinionDefs();
    if (this.disposed || token !== this.startVersion) {
      disposeInstance(inst);
      return;
    }

    this.archetypeDefs = await this.loadArchetypeDefs();
    if (this.disposed || token !== this.startVersion) {
      disposeInstance(inst);
      return;
    }

    if (this.playerInst) disposeInstance(this.playerInst);
    this.playerInst = inst;
    this.player.add(inst.group);
    this.enemyDefs = defs;

    // Faction War swaps the procedural arena for the uploaded GLB arena
    // (best-effort: falls back to the procedural arena on any load failure).
    if (this.mode === "factions") {
      await this.loadFactionArena(token);
      if (this.disposed || token !== this.startVersion) return;
    } else {
      this.restoreProceduralArena();
    }

    // Build mesh-accurate physics + ground BVH for this run (best-effort).
    await this.ensurePhysics(token);
    if (this.disposed || token !== this.startVersion) return;

    // Snap the player onto the ground of the (possibly new) arena.
    this.player.position.y = this.groundAt(0, 0);

    this.phase = "playing";
    if (this.mode === "animtest") {
      this.setMessage("Weapon Skill Studio", 2.2);
    } else if (this.mode === "sandbox") {
      this.setMessage("Testing Grounds", 2.2);
      this.sandboxSpawn(3);
    } else if (this.mode === "factions") {
      this.setMessage("Faction War", 2.4);
      this.spawnFactions();
    } else {
      this.setMessage("Defend the Temple", 2.2);
      this.spawnWave();
    }
    this.requestPointerLock();
    this.emit();
  }

  restart(): void {
    if (this.lastPlayer) void this.start(this.lastPlayer, this.lastPool, this.mode);
  }

  /** Spawn practice dummies. No-op outside sandbox play. */
  sandboxSpawn(count = 3): void {
    if (this.phase !== "playing" || this.mode !== "sandbox") return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 14 + Math.random() * 16;
      // Make every third dummy a ranged gunner so the sandbox can practice both.
      const ranged = this.gunnerDef !== null && i % 3 === 0;
      this.spawnEnemy(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), 80, 3.2, ranged);
    }
    this.emit();
  }

  /** Ring of every race × knight/warrior/ranger/mage kit for AI / mixer learning. */
  sandboxSpawnKits(): void {
    if (this.phase !== "playing" || (this.mode !== "sandbox" && this.mode !== "animtest"))
      return;
    void this.spawnKitRing();
  }

  private async spawnKitRing(): Promise<void> {
    const list = WARLORDS_TEST_LOADOUTS;
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      try {
        const tmpl = await loadToonRtsTemplate(toonRaceKitUrl(L.race));
        const ang = (i / list.length) * Math.PI * 2;
        const pos = new THREE.Vector3(Math.cos(ang) * 20, 0, Math.sin(ang) * 20);
        pos.y = this.groundAt(pos.x, pos.z);
        const inst = this.makeToon(tmpl, 0x8aa0c0, L.weapon, null, {
          raceId: L.race,
          weapon: L.weapon,
          classId: L.id.split("-")[1],
        });
        this.finishEnemySpawn(
          inst,
          {
            template: tmpl.scene,
            clips: null,
            color: 0x8aa0c0,
            weapon: L.weapon,
            category: weaponCategory(L.weapon),
            rig: "toonrts",
            toonTemplate: tmpl,
            raceId: L.race,
            label: L.label,
          },
          pos,
          70,
          3.0,
          /bow|staff/.test(L.weapon),
        );
      } catch (err) {
        console.warn(`kit spawn failed: ${L.id}`, err);
      }
    }
    this.emit();
  }

  /** Remove all enemies from the arena (no score). */
  sandboxClear(): void {
    for (const e of this.enemies) {
      // Neutralize any pending delayed-attack timers (their closures bail on !alive).
      e.alive = false;
      this.disposeEnemy(e);
    }
    this.enemies = [];
    this.emit();
  }

  /** Restore health and force to full. */
  sandboxRefill(): void {
    this.health = this.maxHealth;
    this.force = this.maxForce;
    this.emit();
  }

  /**
   * Weapon Skill Studio: spawn passive practice dummies in a ring around the
   * player so edited skills can be tested against a live target. Dummies take
   * damage and show numbers but never move or attack. No-op outside animtest.
   */
  studioSpawnDummies(count = 3): void {
    if (this.phase !== "playing" || this.mode !== "animtest") return;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const r = 8 + Math.random() * 6;
      this.spawnAsPassive = true;
      try {
        this.spawnEnemy(
          new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
          200,
          0,
          false,
        );
      } finally {
        this.spawnAsPassive = false;
      }
    }
    this.emit();
  }

  /** Weapon Skill Studio: remove all dummies (no score). No-op elsewhere. */
  studioClearDummies(): void {
    if (this.mode !== "animtest") return;
    for (const e of this.enemies) {
      e.alive = false;
      this.disposeEnemy(e);
    }
    this.enemies = [];
    this.emit();
  }

  /** A deep copy of the live catalog for the Studio panel to edit. */
  studioGetCatalog(): WeaponSkillCatalog {
    return JSON.parse(JSON.stringify(catalog)) as WeaponSkillCatalog;
  }

  /** The player's currently-resolved skill class (for the Studio's context). */
  studioPlayerClass(): string {
    return this.classId;
  }

  /**
   * Apply edited catalog data to the running game immediately. Mutates the
   * in-memory catalog (so casts/shots read the new numbers next frame) and
   * re-resolves the player's signature skills from it, preserving cooldowns.
   */
  studioApplyCatalog(next: WeaponSkillCatalog): void {
    applyCatalog(next);
    const prevCd = this.cooldowns.slice();
    this.skills = catalogSkills(this.classId);
    this.cooldowns = this.skills.map((_, i) => prevCd[i] ?? 0);
    this.emit();
  }

  /** POST the catalog to the dev-only save endpoint (writes the JSON file). */
  studioSaveCatalog(next: WeaponSkillCatalog): Promise<{ ok: boolean; message: string }> {
    return saveCatalog(next);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.clearTimers();
    for (const e of this.enemies) this.disposeEnemy(e);
    this.enemies = [];
    this.disposeFactionArena();
    // Drop cached terrain templates so their geometries are freed on teardown.
    if (this.terrainTemplates) {
      for (const t of this.terrainTemplates.values()) this.disposeObject(t);
      this.terrainTemplates = null;
    }
    this.teardownPhysics();
    for (const s of this.sparks) this.disposeObject(s.mesh);
    this.sparks = [];
    this.clearVfx();
    for (const c of this.corpses) disposeInstance(c.inst);
    this.corpses = [];
    this.casting?.dispose();
    this.casting = null;
    for (const sys of this.enemyCastSystems.values()) sys.dispose();
    this.enemyCastSystems.clear();
    this.castAimLine?.dispose();
    this.castAimLine = null;
    this.telegraphs?.dispose();
    this.telegraphs = null;
    for (const p of this.pendingCasts) this.disposeCastAura(p.aura);
    this.pendingCasts = [];
    this.clearSkillCast();
    this.softTarget = null;
    if (this.softMarker) {
      const mat = this.softMarker.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.scene.remove(this.softMarker);
      this.softMarker = null;
    }
    for (const t of this.vfxTextures.values()) t.dispose();
    this.vfxTextures.clear();
    if (this.playerInst) disposeInstance(this.playerInst);
    this.playerInst = null;
    if (this.targetMarker) {
      const mat = this.targetMarker.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.scene.remove(this.targetMarker);
      this.targetMarker = null;
    }
    this.targetEnemy = null;
    window.removeEventListener("resize", this.resizeHandler);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    this.canvas.removeEventListener("contextmenu", this.preventContext);
    this.renderer.dispose();
  }

  /** Schedule a timeout tracked for cleanup on reset/dispose. */
  private schedule(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
  }

  private clearTimers(): void {
    for (const id of this.timeouts) window.clearTimeout(id);
    this.timeouts.clear();
  }

  /**
   * (Re)build the physics world + ground BVH for the current run. Best-effort:
   * any failure leaves `physics`/`worldBvh` null and the engine falls back to
   * its hand-rolled math movement + a flat ground plane.
   */
  private async ensurePhysics(token: number): Promise<void> {
    this.teardownPhysics();
    this.scene.updateMatrixWorld(true);
    try {
      this.worldBvh = new StaticWorldBVH(this.staticColliders);
    } catch {
      this.worldBvh = null;
    }
    const mod = await initRapier();
    if (this.disposed || token !== this.startVersion) return;
    if (!mod) return;
    let pw: PhysicsWorld | null = null;
    try {
      pw = new PhysicsWorld(mod);
      pw.addStaticMeshes(this.staticColliders);
      pw.step();
      this.physics = pw;
      this.playerBody = pw.createCharacter(
        this.player.position,
        PLAYER_RADIUS,
        PLAYER_HEIGHT,
      );
    } catch {
      // Partial init: free the half-built world so it does not leak.
      pw?.dispose();
      this.physics = null;
      this.playerBody = null;
    }
  }

  /** Free the physics world + player body (enemy bodies free via disposeEnemy). */
  private teardownPhysics(): void {
    if (this.physics) {
      if (this.playerBody) this.physics.removeCharacter(this.playerBody);
      this.physics.dispose();
    }
    this.physics = null;
    this.playerBody = null;
    if (this.worldBvh) this.worldBvh.dispose();
    this.worldBvh = null;
  }

  /**
   * Permanently drop Rapier and fall back to math movement. Called when any
   * per-frame physics call throws, so a runtime failure can never freeze the
   * render loop. Bodies are nulled; the world is disposed.
   */
  private disablePhysics(err: unknown): void {
    if (!this.physicsDisabled) {
      this.physicsDisabled = true;
      console.warn(
        "Grudge Gladiators: physics failed at runtime; using math movement.",
        err,
      );
    }
    if (this.physics) this.physics.dispose();
    this.physics = null;
    this.playerBody = null;
    for (const e of this.enemies) e.body = null;
  }

  /** Permanently drop the ground BVH and fall back to a flat floor. */
  private disableWorldBvh(err: unknown): void {
    if (!this.worldBvhDisabled) {
      this.worldBvhDisabled = true;
      console.warn(
        "Grudge Gladiators: ground BVH failed at runtime; using flat ground.",
        err,
      );
    }
    if (this.worldBvh) this.worldBvh.dispose();
    this.worldBvh = null;
  }

  /** Step the simulation; self-disable physics on failure. */
  private stepPhysics(): void {
    if (!this.physics) return;
    try {
      this.physics.step();
    } catch (err) {
      this.disablePhysics(err);
    }
  }

  /**
   * Layered, each step best-effort and falling through to the next:
   *   1. Rapier capsule collide-and-slide (when physics is up).
   *   2. Mesh-accurate wall constraint via the ground/world BVH, applied ON TOP
   *      of whatever step 1 produced so pillars/edges stay tight even when
   *      Rapier is unavailable.
   *   3. Plain math move (px+dx, pz+dz) when neither layer is available.
   */
  private moveBody(
    body: CharacterBody | null,
    px: number,
    py: number,
    pz: number,
    dx: number,
    dz: number,
    radius: number,
    height: number,
  ): { x: number; z: number } {
    let nx = px + dx;
    let nz = pz + dz;
    if (this.physics && body) {
      try {
        const r = this.physics.moveHorizontal(body, px, py, pz, dx, dz);
        nx = r.x;
        nz = r.z;
      } catch (err) {
        this.disablePhysics(err);
        nx = px + dx;
        nz = pz + dz;
      }
    }
    if (this.worldBvh) {
      try {
        const r = this.worldBvh.resolveWalls(nx, py, nz, radius, height);
        nx = r.x;
        nz = r.z;
      } catch (err) {
        this.disableWorldBvh(err);
      }
    }
    return { x: nx, z: nz };
  }

  /** Mesh-accurate ground height under (x, z), or flat 0 on failure. */
  private groundAt(x: number, z: number): number {
    if (this.worldBvh) {
      try {
        return this.worldBvh.groundHeight(x, z) ?? 0;
      } catch (err) {
        this.disableWorldBvh(err);
      }
    }
    return 0;
  }

  /** Collect visible, position-bearing meshes of an instance for the body BVH. */
  private bodyMeshes(group: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    group.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.isMesh && m.visible && m.geometry?.getAttribute("position")) {
        out.push(m);
      }
    });
    return out;
  }

  /** Dispose an enemy: its per-instance saber plus the health-bar sprite. */
  /**
   * Convert a just-killed enemy into a rigid tumbling corpse. Strips gameplay
   * attachments (physics body, hit tester, health bar) but keeps the visual
   * instance alive in `corpses`, launched by the killing blow's knockback.
   */
  private spawnCorpse(e: Enemy): void {
    if (e.gone) return;
    e.gone = true;
    if (e.body) this.physics?.removeCharacter(e.body);
    e.body = null;
    if (e.hitter) e.hitter.dispose();
    e.hitter = null;
    e.bar.removeFromParent();
    e.barTex.dispose();
    (e.bar.material as THREE.SpriteMaterial).dispose();
    // Impulse from the killing blow: knockback magnitude = intensity.
    const kb = e.knockback;
    const intensity = THREE.MathUtils.clamp(kb.length(), 5, 28);
    const dir =
      kb.lengthSq() > 1e-4 ? kb.clone().setY(0).normalize() : this.facingDir();
    // Tumble about the axis perpendicular to the launch direction so the body
    // topples end-over-end away from the blow.
    const spinAxis = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    if (spinAxis.lengthSq() < 1e-4) spinAxis.set(1, 0, 0);
    if (this.corpses.length >= 12) {
      const oldest = this.corpses.shift();
      if (oldest) disposeInstance(oldest.inst);
    }
    this.corpses.push({
      inst: e.inst,
      vel: dir.multiplyScalar(intensity * 0.55),
      vy: 3.2 + intensity * 0.22,
      spinAxis,
      spinRate: 1.2 + intensity * 0.14,
      t: 0,
    });
  }

  /** Integrate corpse tumbles: ballistic arc, ground slide, sink, dispose. */
  private updateCorpses(dt: number): void {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      const g = c.inst.group;
      g.position.x += c.vel.x * dt;
      g.position.z += c.vel.z * dt;
      c.vy -= 26 * dt;
      g.position.y += c.vy * dt;
      if (g.position.y <= 0) {
        g.position.y = 0;
        if (c.vy < -3) {
          // Small damped bounce for hard explosion launches.
          c.vy = -c.vy * 0.28;
        } else {
          c.vy = 0;
        }
        // Ground friction kills the slide and the tumble settles.
        c.vel.multiplyScalar(Math.max(0, 1 - 6 * dt));
        c.spinRate *= Math.max(0, 1 - 5 * dt);
      }
      if (c.spinRate > 0.01) {
        g.rotateOnWorldAxis(c.spinAxis, c.spinRate * dt);
      }
      // Sink away after the body has rested, then release resources.
      if (c.t > 2.2) g.position.y -= dt * 1.4;
      if (c.t > 3.2) {
        disposeInstance(c.inst);
        this.corpses.splice(i, 1);
      }
    }
  }

  private disposeEnemy(e: Enemy): void {
    if (e.gone) return;
    e.gone = true;
    if (e.pendingCast) {
      this.disposeCastAura(e.pendingCast.aura);
      e.pendingCast = null;
    }
    // Remove any floating status-effect VFX sprites.
    for (const se of e.statusEffects) {
      if (se.vfx) {
        this.scene.remove(se.vfx);
        this.disposeSprite(se.vfx);
        se.vfx = null;
      }
    }
    e.statusEffects = [];
    if (e.body) this.physics?.removeCharacter(e.body);
    e.body = null;
    if (e.hitter) e.hitter.dispose();
    e.hitter = null;
    // Release per-caster casting system so its in-flight effects dispose cleanly.
    const castSys = this.enemyCastSystems.get(e);
    if (castSys) {
      castSys.clear();
      castSys.dispose();
      this.enemyCastSystems.delete(e);
    }
    e.bar.removeFromParent();
    e.barTex.dispose();
    (e.bar.material as THREE.SpriteMaterial).dispose();
    disposeInstance(e.inst);
  }

  /** Recursively dispose geometries, materials and textures of an object tree. */
  private disposeObject(obj: THREE.Object3D): void {
    obj.removeFromParent();
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh | THREE.Sprite;
      const geom = (mesh as THREE.Mesh).geometry;
      if (geom) geom.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] })
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

  private colorHex(s: string): number {
    return new THREE.Color(s).getHex();
  }

  private async loadPlayerInstance(player: HeroInfo): Promise<CharacterInstance> {
    const color = this.colorHex(player.factionColor);
    const category = weaponCategory(player.weapon);
    this.playerCategory = category;
    this.playerWeapon = player.weapon;
    if (player.rig === "mixamo") {
      try {
        const base = import.meta.env.BASE_URL;
        const [template, library] = await Promise.all([
          loadLucyTemplate({
            modelUrl: `${base}models/lucy/Lucy.fbx`,
            bodyTexUrl: `${base}models/lucy/Female_char1.png`,
            hairTexUrl: `${base}models/lucy/hair.png`,
          }),
          loadAnimationLibrary(category),
        ]);
        this.playerAnimMode = "Skeletal (mixamo rig, direct clips)";
        return instantiateLucy(template, library, color);
      } catch {
        this.playerAnimMode = "Capsule (model/clip load failed)";
        return instantiateCapsule(0x3a1f3a, 0xe6c8a0, color);
      }
    }
    if (player.rig === "meshy") {
      try {
        const template = await loadCharacterTemplate(player.modelUrl);
        const clips = await this.ensureBip001Clips(template, category, player.modelUrl);
        if (clips) {
          this.playerAnimMode = "Skeletal (Meshy retarget)";
          return instantiateMeshyAnimated(template, clips, color);
        }
        this.playerAnimMode = "Procedural (Mixamo library unavailable)";
        return instantiateMeshyModel(template, color);
      } catch {
        this.playerAnimMode = "Capsule (Meshy model load failed)";
        return instantiateCapsule(0x1f3a2e, 0xe6c8a0, color);
      }
    }
    if (player.rig === "toonrts") {
      try {
        const template = await loadToonRtsTemplate(player.modelUrl);
        const library = await this.ensureBip001Clips(
          template.scene,
          category,
          "toonrts",
        );
        this.playerAnimMode = "Skeletal (Toon Warlords pack, one mixer)";
        return this.makeToon(template, color, player.weapon, library, player);
      } catch {
        this.playerAnimMode = "Capsule (Toon RTS model load failed)";
        return instantiateCapsule(0x2d3550, 0xe6c8a0, color);
      }
    }
    if (player.rig === "racalvin") {
      try {
        const dir = `${import.meta.env.BASE_URL}models/racalvin/`;
        const clipNames: ClipName[] = [
          "idle",
          "walk",
          "run",
          "strafeLeft",
          "strafeRight",
          "attack",
        ];
        const [template, ...loaded] = await Promise.all([
          loadRacalvinTemplate(`${dir}Racalvin.fbx`, `${dir}texture.png`),
          ...clipNames.map((name) => loadClip(`${dir}${name}.fbx`, name)),
        ]);
        const clips: Partial<Record<ClipName, THREE.AnimationClip>> = {};
        clipNames.forEach((name, i) => {
          clips[name] = loaded[i];
        });
        this.playerAnimMode = "Skeletal (Racalvin, bundled clips)";
        return instantiateRacalvin(template, clips, color);
      } catch {
        this.playerAnimMode = "Capsule (Racalvin load failed)";
        return instantiateCapsule(0x241a12, 0xe6c8a0, color);
      }
    }
    try {
      const template = await loadCharacterTemplate(player.modelUrl);
      const clips = await this.ensureBip001Clips(template, category);
      if (clips) {
        this.playerAnimMode = "Skeletal (Bip001 retarget)";
        return instantiateGrudgeAnimated(template, clips, color, player.weapon);
      }
      this.playerAnimMode = "Procedural (Mixamo library unavailable)";
      return instantiateModel(template, color, player.weapon);
    } catch {
      this.playerAnimMode = "Capsule (model load failed)";
      return instantiateCapsule(0x2d3550, 0xe6c8a0, color);
    }
  }

  private raceKey(id: string): WarlordsLoadout["race"] {
    const n = id.toLowerCase().replace(/\s+/g, "");
    if (n.includes("barb")) return "barbarian";
    if (n.includes("elf")) return "highelf";
    if (n.includes("dwarf")) return "dwarf";
    if (n.includes("orc")) return "orc";
    if (n.includes("undead") || n === "ud") return "undead";
    return "human";
  }

  private loadoutFor(h: { raceId?: string; classId?: string; weapon: string }): WarlordsLoadout | undefined {
    const race = this.raceKey(h.raceId ?? "human");
    const w = (h.weapon ?? "").toLowerCase();
    const c = (h.classId ?? "").toLowerCase();
    const role =
      /staff|mage|wand/.test(w) || c.includes("mage")
        ? "mage"
        : /bow|ranger/.test(w) || c.includes("ranger")
          ? "ranger"
          : /great/.test(w) || c.includes("warrior")
            ? "warrior"
            : "knight";
    return WARLORDS_TEST_LOADOUTS.find((l) => l.id === `${race}-${role}`);
  }

  private makeToon(
    template: ToonRtsTemplate,
    color: number,
    weapon: string,
    clips: Bip001Clips | null | undefined,
    hero?: { raceId?: string; classId?: string; weapon: string },
  ) {
    const loadout = hero ? this.loadoutFor(hero) : this.loadoutFor({ weapon });
    const inst = instantiateToonRts(template, color, weapon, clips, loadout);
    inst.terrainAt = (x, z) => this.groundAt(x, z);
    return inst;
  }

  /** Load Mixamo sources for a category once (cached); null if unavailable. */
  private async ensureAnimSources(
    category: WeaponCategory,
  ): Promise<RawClip[] | null> {
    const cached = this.animSources.get(category);
    if (cached) return cached;
    try {
      const sources = await loadAnimationSources(category);
      this.animSources.set(category, sources);
      return sources;
    } catch (err) {
      console.warn("Grudge Gladiators: Mixamo library failed to load; using procedural animation.", err);
      return null;
    }
  }

  /**
   * Retarget the Mixamo library onto a Bip001 template (cached per category
   * across all six races). Returns null if sources or baking fail, so callers
   * fall back to procedural animation.
   */
  private async ensureBip001Clips(
    template: THREE.Group,
    category: WeaponCategory,
    modelKey?: string,
  ): Promise<Bip001Clips | null> {
    const sources = await this.ensureAnimSources(category);
    if (!sources) return null;
    try {
      // All six Grudge races share one Bip001 rig, so their bake caches per
      // category. Meshy rigs have per-character bind poses, so their bake must
      // cache per model as well.
      // Non-Bip001 rigs (Meshy, Standout minions) have per-model bind poses,
      // so their bakes must key per model too — a bare category key would
      // collide with the shared Bip001 bake.
      const rig = detectRetargetRig(template);
      const key =
        rig === "meshy" || rig === "standout"
          ? `${rig}|${modelKey ?? "?"}|${category}`
          : modelKey === "toonrts"
            ? `toonrts|spine0|${category}`
            : `bip|spine0|${category}`;
      return getBip001Clips(template, sources, key);
    } catch (err) {
      console.warn("Grudge Gladiators: Bip001 retarget failed; using procedural animation.", err);
      return null;
    }
  }

  private async loadEnemyDefs(
    pool: HeroInfo[],
    cap = 5,
  ): Promise<EnemyDef[]> {
    // Dedupe by model + weapon so distinct weapon loadouts of the same race each
    // get their own embedded-weapon mesh and animation set.
    const seen = new Map<string, HeroInfo>();
    for (const h of pool) {
      if (
        h.modelUrl === this.lastPlayer?.modelUrl &&
        h.weapon === this.lastPlayer?.weapon
      ) {
        continue;
      }
      const key = `${h.modelUrl}|${h.weapon}`;
      if (!seen.has(key)) seen.set(key, h);
      if (seen.size >= cap) break;
    }
    if (seen.size === 0 && pool.length) {
      const h = pool[0];
      seen.set(`${h.modelUrl}|${h.weapon}`, h);
    }
    return Promise.all(
      [...seen.values()].map(async (h): Promise<EnemyDef> => {
        const category = weaponCategory(h.weapon);
        const color = this.colorHex(h.factionColor);
        if (h.rig === "toonrts") {
          try {
            const toonTemplate = await loadToonRtsTemplate(h.modelUrl);
            const clips = await this.ensureBip001Clips(
              toonTemplate.scene,
              category,
              "toonrts",
            );
            return {
              template: toonTemplate.scene,
              clips,
              color,
              weapon: h.weapon,
              category,
              rig: "toonrts",
              toonTemplate,
              raceId: h.raceId,
            };
          } catch {
            return { template: null, clips: null, color, weapon: h.weapon, category, raceId: h.raceId };
          }
        }
        const rig = h.rig === "meshy" ? ("meshy" as const) : undefined;
        try {
          const template = await loadCharacterTemplate(h.modelUrl);
          const clips = await this.ensureBip001Clips(template, category, h.modelUrl);
          return { template, clips, color, weapon: h.weapon, category, rig, raceId: h.raceId };
        } catch {
          return { template: null, clips: null, color, weapon: h.weapon, category, rig, raceId: h.raceId };
        }
      }),
    );
  }

  /**
   * Load the lesser-minion sets (Standout low-poly FBX packs bundled under
   * public/models/minions): three marauders (melee) and three elves (one ranged
   * staff caster). Each is a rigged character + its set's weapon mesh + the
   * set's palette texture, animated by retargeting the Mixamo library onto the
   * Standout rig. Best-effort per minion: a failed load just drops that minion.
   */
  private async loadMinionDefs(): Promise<EnemyDef[]> {
    const base = import.meta.env.BASE_URL;
    const dir = `${base}models/minions`;
    const sets: Array<{
      model: string;
      weaponFile: string;
      palette: string;
      label: string;
      weapon: string;
      color: number;
    }> = [
      { model: "ash_walker", weaponFile: "iron_cleaver", palette: "marauder_palette.png", label: "Ash Walker", weapon: "axe", color: 0xb7643a },
      { model: "bone_whittler", weaponFile: "furnace_gavel", palette: "marauder_palette.png", label: "Bone Whittler", weapon: "hammer", color: 0xd8cdb6 },
      { model: "ironbound_marauder", weaponFile: "gate_crasher", palette: "marauder_palette.png", label: "Ironbound Marauder", weapon: "mace", color: 0x8b93a6 },
      { model: "elf", weaponFile: "sword_elf", palette: "elf_palette.png", label: "Elf Blade", weapon: "sword", color: 0x7fd0a0 },
      { model: "ice_elf", weaponFile: "crystal_spear_elf", palette: "elf_palette.png", label: "Ice Elf", weapon: "spear", color: 0x9fd8ff },
      { model: "fire_elf", weaponFile: "magma_staff_elf", palette: "elf_palette.png", label: "Fire Elf", weapon: "staff", color: 0xff9b4a },
    ];
    const defs = await Promise.all(
      sets.map(async (s): Promise<EnemyDef | null> => {
        try {
          const tex = `${dir}/${s.palette}`;
          const [template, weaponTemplate] = await Promise.all([
            loadMinionTemplate(`${dir}/${s.model}.fbx`, tex),
            loadMinionWeapon(`${dir}/${s.weaponFile}.fbx`, tex),
          ]);
          const category = weaponCategory(s.weapon);
          const clips = await this.ensureBip001Clips(template, category, s.model);
          return {
            template,
            clips,
            color: s.color,
            weapon: s.weapon,
            category,
            rig: "minion",
            weaponTemplate,
            label: s.label,
          };
        } catch (err) {
          console.warn(`Grudge Gladiators: minion "${s.label}" failed to load.`, err);
          return null;
        }
      }),
    );
    return defs.filter((d): d is EnemyDef => d !== null);
  }

  /**
   * Load the dedicated archetype roster from the bundled Toon RTS faction pack
   * (self-contained Bip001 GLBs with embedded clips — no retarget bake needed).
   * These are always available regardless of the hero pool, so every run sees
   * the flanker / bruiser / caster / archer variety. Best-effort per unit.
   */
  private async loadArchetypeDefs(): Promise<EnemyDef[]> {
    const units: Array<{
      race: string;
      label: string;
      weapon: string;
      color: number;
      archetype: EnemyArchetype;
    }> = [
      { race: "human", label: "Vanguard Flanker", weapon: "sword shield", color: 0x64d9ff, archetype: "flanker" },
      { race: "orc", label: "Orc Juggernaut", weapon: "greatsword", color: 0x8bd44a, archetype: "bruiser" },
      { race: "undead", label: "Lich Elementalist", weapon: "staff", color: 0xb26bff, archetype: "caster" },
      { race: "barbarian", label: "Barbarian Archer", weapon: "bow", color: 0xffb347, archetype: "grunt" },
    ];
    const defs = await Promise.all(
      units.map(async (u): Promise<EnemyDef | null> => {
        try {
          const category = weaponCategory(u.weapon);
          const toonTemplate = await loadToonRtsTemplate(toonRaceKitUrl(u.race));
          const clips = await this.ensureBip001Clips(
            toonTemplate.scene,
            category,
            "toonrts",
          );
          return {
            template: toonTemplate.scene,
            clips,
            color: u.color,
            weapon: u.weapon,
            category,
            rig: "toonrts",
            toonTemplate,
            label: u.label,
            archetype: u.archetype,
            raceId: u.race,
          };
        } catch (err) {
          console.warn(`Grudge Gladiators: archetype "${u.label}" failed to load.`, err);
          return null;
        }
      }),
    );
    return defs.filter((d): d is EnemyDef => d !== null);
  }

  /**
   * Load the ranged-gunner ("Heavy") mixamorig template + its own clips (aiming
   * idle + run). Best-effort: returns null if any asset fails, so the game simply
   * has no ranged enemies rather than crashing.
   */
  private async loadGunnerDef(): Promise<
    { template: THREE.Group; library: Partial<AnimationLibrary> } | null
  > {
    try {
      const base = import.meta.env.BASE_URL;
      const dir = `${base}models/heavy`;
      const [template, idle, run] = await Promise.all([
        loadHeavyTemplate(`${dir}/Heavy.fbx`),
        loadClip(`${dir}/idle.fbx`, "idle"),
        loadClip(`${dir}/run.fbx`, "run"),
      ]);
      // The aiming idle doubles as the guard pose; run covers walk + run speeds.
      const library: Partial<AnimationLibrary> = { idle, run, walk: run, guard: idle };
      return { template, library };
    } catch (err) {
      console.warn("Grudge Gladiators: ranged gunner assets failed to load.", err);
      return null;
    }
  }

  private tuneLights(): void {
    const ambient = this.lighting.lights.get("ambient");
    if (ambient) {
      ambient.color.set(0x33405f);
      ambient.intensity = 0.8;
    }
    const sun = this.lighting.lights.get("sun");
    if (sun) {
      sun.color.set(0x9fb8ff);
      sun.intensity = 0.65;
      sun.position.set(40, 80, 30);
    }
    const fill1 = this.lighting.lights.get("fill1");
    if (fill1) fill1.intensity = 0.4;
  }

  private buildArena(): void {
    // Everything the procedural arena creates lives under this group so the
    // Faction War GLB arena can hide it wholesale and waves/sandbox restore it.
    const procGroup = new THREE.Group();
    this.scene.add(procGroup);
    this.procArena.push(procGroup);

    const floorGeo = new THREE.CircleGeometry(60, 64);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x12182b,
      metalness: 0.6,
      roughness: 0.35,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    procGroup.add(floor);
    this.staticColliders.push(floor);
    this.procColliders.push(floor);

    for (let i = 1; i <= 4; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(i * 12 - 0.25, i * 12 + 0.25, 96),
        new THREE.MeshBasicMaterial({
          color: 0x1f6dff,
          transparent: true,
          opacity: 0.35,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      procGroup.add(ring);
    }

    const grid = new THREE.GridHelper(120, 60, 0x1b4170, 0x10203a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    grid.position.y = 0.01;
    procGroup.add(grid);

    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x1a2238,
      metalness: 0.5,
      roughness: 0.4,
    });
    const count = 10;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const r = 40;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 2.0, 22, 12),
        pillarMat,
      );
      pillar.position.set(Math.cos(a) * r, 11, Math.sin(a) * r);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      procGroup.add(pillar);
      this.collidables.push(pillar);
      this.procCollidables.push(pillar);
      this.staticColliders.push(pillar);
      this.procColliders.push(pillar);

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 0.6, 12),
        new THREE.MeshBasicMaterial({ color: 0x2f6dff }),
      );
      cap.position.set(Math.cos(a) * r, 22.3, Math.sin(a) * r);
      procGroup.add(cap);
    }

    // Arena boundary: a real (mesh-accurate) wall just inside the floor edge.
    // It is registered as a static collider so both the Rapier capsule path and
    // the world BVH (resolveWalls) push characters back inside the playable ring
    // -- this replaces the old hard-coded radius clamp with true geometry, and
    // bounds enemies as well as the player. The capsule push stops a character
    // at (boundary radius - capsule radius), i.e. ~56 for the player.
    const boundary = new THREE.Mesh(
      new THREE.CylinderGeometry(56.5, 56.5, 12, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2f6dff,
        transparent: true,
        opacity: 0.05,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    boundary.position.y = 6;
    procGroup.add(boundary);
    this.staticColliders.push(boundary);
    this.procColliders.push(boundary);

    const starGeo = new THREE.BufferGeometry();
    const starCount = 600;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(180 + Math.random() * 120);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = Math.abs(v.y) + 30;
      positions[i * 3 + 2] = v.z;
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xaecbff, size: 0.7, sizeAttenuation: true }),
    );
    this.scene.add(stars);
  }

  /**
   * Dispose a scattered terrain prop WITHOUT touching its geometry. Placements
   * are `template.clone(true)` and therefore SHARE the cached template's
   * geometry buffers; only the per-instance cloned materials are owned by the
   * placement and safe to free here. The prop is detached from its parent too.
   */
  private disposePropMaterials(prop: THREE.Object3D): void {
    prop.removeFromParent();
    prop.traverse((child) => {
      const mat = (child as { material?: THREE.Material | THREE.Material[] })
        .material;
      if (!mat) return;
      const mats = Array.isArray(mat) ? mat : [mat];
      for (const m of mats) m.dispose();
    });
  }

  /** Tear down the loaded GLB arena + any scattered terrain props it owns. */
  private disposeFactionArena(): void {
    // Detach + free scattered props first (materials only — their geometry is
    // owned by the cached terrainTemplates and must survive for the next match).
    for (const p of this.factionProps) this.disposePropMaterials(p);
    this.factionProps = [];
    if (this.factionArena) {
      // Props are already detached, so the arena walk won't reach (and dispose)
      // any template-owned geometry.
      this.scene.remove(this.factionArena);
      this.disposeObject(this.factionArena);
      this.factionArena = null;
    }
  }

  /** Show the procedural arena + restore its colliders (waves/sandbox/animtest). */
  private restoreProceduralArena(): void {
    for (const o of this.procArena) o.visible = true;
    this.disposeFactionArena();
    // Rebuild the collider/collidable sets from the procedural arena only.
    this.staticColliders = [...this.procColliders];
    this.collidables = [...this.procCollidables];
    this.camOccluders = [...this.collidables, ...this.staticColliders];
  }

  /**
   * Load + fit the Faction War battleground selected by the UI. Two maps:
   *   - "colosseum": a closed interior structure whose OWN geometry is the
   *     playable space (floor/walls/props all double as colliders).
   *   - "highlands": the outdoor Sketchfab arena (arena6.glb) fitted to a
   *     ~60-radius disc with scattered mountain/plateau terrain obstructions.
   * Best-effort: any load failure falls back to the procedural arena.
   */
  private async loadFactionArena(token: number): Promise<void> {
    // Hide the procedural arena while a GLB arena is active, and clear any
    // previously-loaded GLB arena + scattered props.
    for (const o of this.procArena) o.visible = false;
    this.disposeFactionArena();

    const map = this.factionConfig?.map ?? "highlands";
    try {
      if (map === "colosseum") {
        await this.loadColosseumArena(token);
      } else {
        await this.loadHighlandsArena(token);
      }
    } catch (err) {
      console.warn(
        "Grudge Gladiators: Faction War arena GLB failed to load; using procedural arena.",
        err,
      );
      if (!this.disposed && token === this.startVersion) {
        this.restoreProceduralArena();
      }
    }
  }

  /** True when a newer start()/dispose superseded the load identified by token. */
  private loadSuperseded(token: number): boolean {
    return this.disposed || token !== this.startVersion;
  }

  /** Promise wrapper around GLTFLoader for a BASE_URL-relative path. */
  private loadGltf(relPath: string): Promise<THREE.Group> {
    const url = `${import.meta.env.BASE_URL}${relPath}`;
    const loader = new GLTFLoader();
    return new Promise<THREE.Group>((resolve, reject) =>
      loader.load(url, (g) => resolve(g.scene), undefined, reject),
    );
  }

  /**
   * "Colosseum" map: the closed interior arena. The whole scene is scaled so
   * its horizontal extent is ~120 units, centered at origin, floor dropped to
   * y=0, and ALL meshes become colliders (they are tiny, ~10k verts total).
   */
  private async loadColosseumArena(token: number): Promise<void> {
    const scene = await this.loadGltf("models/arena/arena-interior.glb");
    // A newer start()/dispose superseded this load: drop the freshly-loaded
    // scene without touching any instance state.
    if (this.loadSuperseded(token)) {
      this.disposeObject(scene);
      return;
    }
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = true;
      }
    });

    scene.updateMatrixWorld(true);
    const allMeshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry?.getAttribute("position")) allMeshes.push(m);
    });
    if (allMeshes.length === 0) {
      this.disposeObject(scene);
      this.restoreProceduralArena();
      return;
    }

    // Scale so the interior playable width (max horizontal extent) is ~120.
    const box0 = new THREE.Box3().setFromObject(scene);
    const size0 = new THREE.Vector3();
    box0.getSize(size0);
    const extent0 = Math.max(size0.x, size0.z) || 1;
    const scale = 120 / extent0;
    scene.scale.setScalar(scale);
    scene.updateMatrixWorld(true);

    // Center in XZ.
    const box1 = new THREE.Box3().setFromObject(scene);
    const center1 = new THREE.Vector3();
    box1.getCenter(center1);
    scene.position.x -= center1.x;
    scene.position.z -= center1.z;
    scene.updateMatrixWorld(true);

    // Drop the interior floor to y=0 (raycast the topmost hit at/under midY).
    const box2 = new THREE.Box3().setFromObject(scene);
    const midY = (box2.min.y + box2.max.y) / 2;
    const ray = new THREE.Raycaster();
    ray.set(new THREE.Vector3(0, box2.max.y + 50, 0), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObjects(allMeshes, false);
    let floorY = box2.min.y;
    const floorHit = hits.find((h) => h.point.y <= midY + 1e-3);
    if (floorHit) floorY = floorHit.point.y;
    else if (hits.length > 0) floorY = hits[hits.length - 1].point.y;
    scene.position.y -= floorY;
    scene.updateMatrixWorld(true);

    this.scene.add(scene);
    this.factionArena = scene;

    const box3 = new THREE.Box3().setFromObject(scene);
    const size3 = new THREE.Vector3();
    box3.getSize(size3);
    const halfExtent = Math.max(size3.x, size3.z) / 2 || 60;
    this.factionSpawnRadius = 0.35 * halfExtent;

    const colliders: THREE.Mesh[] = [...allMeshes];
    const boundaryR = halfExtent + 4;
    const boundary = this.makeBoundaryRing(boundaryR, 24, 12);
    this.factionArena.add(boundary);
    boundary.updateWorldMatrix(true, false);
    colliders.push(boundary);

    this.staticColliders = colliders;
    this.collidables = [];
    this.camOccluders = [...colliders];

    console.info(
      `Grudge Gladiators: Colosseum fitted — scale ${scale.toFixed(3)}, ` +
        `floorY ${floorY.toFixed(2)}, spawnRadius ${this.factionSpawnRadius.toFixed(1)}, ` +
        `colliders ${colliders.length}.`,
    );
  }

  /**
   * "Highlands" map: the outdoor Sketchfab arena (arena6.glb). The base slab
   * (name contains "ne_base"/"base" or material "Sand", else the largest XZ
   * footprint) is measured, the whole scene scaled so the base radius ~= 60 and
   * its top surface anchored to y=0, centered at origin. A sane collider subset
   * (base + nearby props within r~70, reasonable vert counts) is fed to
   * physics/BVH, an invisible boundary wall is added, then mountain/plateau
   * terrain props are scattered as obstructions.
   */
  private async loadHighlandsArena(token: number): Promise<void> {
    const scene = await this.loadGltf("models/arena/arena6.glb");
    if (this.loadSuperseded(token)) {
      this.disposeObject(scene);
      return;
    }
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        m.receiveShadow = true;
      }
    });

    const norm = (s: string): string =>
      s.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const matName = (m: THREE.Mesh): string => {
      const mat = m.material as THREE.Material | THREE.Material[];
      const one = Array.isArray(mat) ? mat[0] : mat;
      return norm(one?.name ?? "");
    };

    scene.updateMatrixWorld(true);
    let base: THREE.Mesh | null = null;
    let baseExtent = 0;
    const allMeshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.getAttribute("position")) return;
      allMeshes.push(m);
      const n = norm(m.name);
      const isBaseName = n.includes("nebase") || n.includes("base");
      const isSand = matName(m).includes("sand");
      const bb = new THREE.Box3().setFromObject(m);
      const sz = new THREE.Vector3();
      bb.getSize(sz);
      const ext = Math.max(sz.x, sz.z);
      if ((isBaseName || isSand) && ext > baseExtent) {
        base = m;
        baseExtent = ext;
      }
    });
    if (!base) {
      for (const m of allMeshes) {
        const bb = new THREE.Box3().setFromObject(m);
        const sz = new THREE.Vector3();
        bb.getSize(sz);
        const ext = Math.max(sz.x, sz.z);
        if (ext > baseExtent) {
          base = m;
          baseExtent = ext;
        }
      }
    }
    if (!base) {
      this.disposeObject(scene);
      this.restoreProceduralArena();
      return;
    }
    const baseMesh: THREE.Mesh = base;

    // Scale so the base radius ~= 60, anchor its top surface to y=0, center XZ.
    const baseBox = new THREE.Box3().setFromObject(baseMesh);
    const baseSize = new THREE.Vector3();
    baseBox.getSize(baseSize);
    const currentRadius = Math.max(baseSize.x, baseSize.z) / 2 || 1;
    const TARGET_RADIUS = 60;
    const scale = TARGET_RADIUS / currentRadius;
    scene.scale.setScalar(scale);
    scene.updateMatrixWorld(true);
    const baseBox2 = new THREE.Box3().setFromObject(baseMesh);
    const baseCenter2 = new THREE.Vector3();
    baseBox2.getCenter(baseCenter2);
    scene.position.x -= baseCenter2.x;
    scene.position.z -= baseCenter2.z;
    scene.position.y -= baseBox2.max.y; // top surface -> y=0
    scene.updateMatrixWorld(true);

    // The spawn ring radius is a fixed 40 for Highlands.
    const spawnRadius = 40;

    // Collider subset: the base + nearby structural props inside r~70 with a
    // reasonable vertex count; distant/heavy decor stays visual-only.
    const colliders: THREE.Mesh[] = [];
    const COLL_RADIUS = 70;
    const MAX_VERTS = 12000;
    for (const m of allMeshes) {
      const pos = m.geometry.getAttribute("position");
      if (!pos) continue;
      const wc = new THREE.Vector3();
      new THREE.Box3().setFromObject(m).getCenter(wc);
      const rXZ = Math.hypot(wc.x, wc.z);
      const isBase = m === baseMesh;
      const mn = matName(m);
      const structural =
        isBase ||
        mn.includes("sand") ||
        mn.includes("rock") ||
        mn.includes("metal") ||
        mn.includes("stone");
      if (!isBase) {
        if (rXZ > COLL_RADIUS) continue;
        if (pos.count > MAX_VERTS) continue;
        if (!structural) continue;
      }
      colliders.push(m);
    }
    const baseColliderCount = colliders.length;

    // Invisible boundary wall just outside the playable disc (parented to the
    // local scene group; not committed to instance state until the end).
    const boundary = this.makeBoundaryRing(56.5, 14, 7);
    scene.add(boundary);
    boundary.updateWorldMatrix(true, false);
    colliders.push(boundary);

    // Flat invisible safety floor at y=0 so ground queries always resolve.
    const safety = new THREE.Mesh(
      new THREE.CircleGeometry(62, 48),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    safety.rotation.x = -Math.PI / 2;
    safety.position.y = -0.05;
    scene.add(safety);
    safety.updateWorldMatrix(true, false);
    colliders.push(safety);

    // Scatter mountain/plateau terrain props as obstructions. Props are parented
    // to the LOCAL scene group and returned alongside their collider meshes so
    // nothing touches instance state before the final supersede check.
    const { props, colliders: propColliders } =
      await this.scatterHighlandsTerrain(scene, spawnRadius, token);

    // Final supersede check: if a newer start()/dispose landed during any await,
    // drop the entire locally-built arena (props included) without mutating
    // instance state.
    if (this.loadSuperseded(token)) {
      // Detach + free the props' cloned materials FIRST (never their shared
      // template geometry), then dispose the remaining owned arena geometry.
      for (const p of props) this.disposePropMaterials(p);
      this.disposeObject(scene);
      return;
    }

    colliders.push(...propColliders);

    // Commit: parent the arena, register colliders, record props for cleanup.
    this.scene.add(scene);
    this.factionArena = scene;
    this.factionProps = props;
    this.factionSpawnRadius = spawnRadius;
    this.staticColliders = colliders;
    this.collidables = [];
    this.camOccluders = [...colliders];

    console.info(
      `Grudge Gladiators: Highlands fitted — scale ${scale.toFixed(3)}, ` +
        `spawnRadius ${this.factionSpawnRadius.toFixed(1)}, ` +
        `base/prop colliders ${baseColliderCount}, terrain props ${propColliders.length}, ` +
        `total colliders ${colliders.length}.`,
    );
  }

  /** Build an invisible open-cylinder wall used as an out-of-bounds barrier. */
  private makeBoundaryRing(radius: number, height: number, y: number): THREE.Mesh {
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2f6dff,
        transparent: true,
        opacity: 0.03,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.position.y = y;
    return ring;
  }

  /** Terrain FBX filenames, tagged by silhouette so scale bands differ. */
  private static readonly TERRAIN_FILES: Array<{ file: string; kind: "mountain" | "plateau" | "hill" }> = [
    { file: "Mountains_temperate_climate_001.fbx", kind: "mountain" },
    { file: "Mountains_temperate_climate_002.fbx", kind: "mountain" },
    { file: "Mountains_temperate_climate_003.fbx", kind: "mountain" },
    { file: "Mountains_temperate_climate_004.fbx", kind: "mountain" },
    { file: "Mountains_temperate_climate_005.fbx", kind: "mountain" },
    { file: "Mountains_temperate_climate_006.fbx", kind: "mountain" },
    { file: "Plateau_temperate_climate_001.fbx", kind: "plateau" },
    { file: "Plateau_temperate_climate_002.fbx", kind: "plateau" },
    { file: "Plateau_temperate_climate_003.fbx", kind: "plateau" },
    { file: "Plateau_temperate_climate_004.fbx", kind: "plateau" },
    { file: "Plateau_temperate_climate_005.fbx", kind: "plateau" },
    { file: "Hill_temperate_climate_003.fbx", kind: "hill" },
  ];

  /** Load (and cache) the 12 terrain FBX templates. */
  private async loadTerrainTemplates(): Promise<Map<string, THREE.Group>> {
    if (this.terrainTemplates) return this.terrainTemplates;
    const cache = new Map<string, THREE.Group>();
    const loader = new FBXLoader();
    await Promise.all(
      SaberGame.TERRAIN_FILES.map(
        ({ file }) =>
          new Promise<void>((resolve) => {
            const url = `${import.meta.env.BASE_URL}models/terrain/${file}`;
            loader.load(
              url,
              (obj) => {
                cache.set(file, obj as unknown as THREE.Group);
                resolve();
              },
              undefined,
              (err) => {
                console.warn(
                  `Grudge Gladiators: terrain FBX ${file} failed to load; skipping.`,
                  err,
                );
                resolve();
              },
            );
          }),
      ),
    );
    this.terrainTemplates = cache;
    return cache;
  }

  /**
   * Props are parented to the passed-in local scene group and returned together
   * with their collider meshes; the caller commits them to instance state only
   * after a final supersede check (so a stale async load can be dropped safely).
   */
  private async scatterHighlandsTerrain(
    sceneGroup: THREE.Group,
    spawnRadius: number,
    token: number,
  ): Promise<{ props: THREE.Object3D[]; colliders: THREE.Mesh[] }> {
    const empty = { props: [] as THREE.Object3D[], colliders: [] as THREE.Mesh[] };
    const templates = await this.loadTerrainTemplates();
    if (this.loadSuperseded(token) || templates.size === 0) return empty;

    // Seeded RNG (mulberry32) reseeded per match so the layout is deterministic
    // for the run but different each match.
    let seed = (Date.now() ^ (this.startVersion * 0x9e3779b1)) >>> 0;
    const rng = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // Toon-ish rocky material: high-roughness gray-brown, matching the game's
    // lit art style. Slight per-instance hue variation is applied via clones.
    const baseRock = new THREE.MeshStandardMaterial({
      color: 0x6b6157,
      roughness: 0.95,
      metalness: 0.04,
      flatShading: true,
    });

    // The 6 squad spawn ring points (see spawnFactions): keep clearance around
    // them so squads never spawn embedded in a prop.
    const spawnPts: THREE.Vector2[] = [];
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI * 2;
      spawnPts.push(
        new THREE.Vector2(Math.cos(a) * spawnRadius, Math.sin(a) * spawnRadius),
      );
    }

    const R_MIN = 15;
    const R_MAX = 52;
    const CENTER_MARGIN = 12; // clearance beyond a prop's footprint at center
    const SPAWN_MARGIN = 8; // clearance beyond a prop's footprint at spawns
    const SELF_MARGIN = 2; // gap between two props' footprints
    const MAX_FOOTPRINT = 12; // cap so no single prop seals a lane
    const target = 10 + Math.floor(rng() * 7); // ~10-16 placements
    const placed: Array<{ p: THREE.Vector2; foot: number }> = [];
    const props: THREE.Object3D[] = [];
    const colliders: THREE.Mesh[] = [];

    const files = SaberGame.TERRAIN_FILES.filter((f) => templates.has(f.file));
    if (files.length === 0) return empty;

    let attempts = 0;
    while (placed.length < target && attempts < target * 24) {
      attempts++;
      const ang = rng() * Math.PI * 2;
      const rad = R_MIN + rng() * (R_MAX - R_MIN);
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      const p = new THREE.Vector2(x, z);

      const pick = files[Math.floor(rng() * files.length)];
      const tmpl = templates.get(pick.file);
      if (!tmpl) continue;
      const inst = tmpl.clone(true);

      // Measure the source box, then scale so the HEIGHT matches the kind band.
      inst.updateMatrixWorld(true);
      const pbox = new THREE.Box3().setFromObject(inst);
      const psize = new THREE.Vector3();
      pbox.getSize(psize);
      const srcH = psize.y || 1;
      const srcHalfW = Math.max(psize.x, psize.z) / 2 || 1;
      const targetH =
        pick.kind === "mountain"
          ? 6 + rng() * 8 // ~6-14 tall
          : 4 + rng() * 4; // plateaus/hills ~4-8 tall
      let s = targetH / srcH;
      // Clamp scale DOWN so wide assets (plateau/hill) can't seal a lane: the
      // post-scale footprint radius must stay within MAX_FOOTPRINT.
      const maxScaleForFootprint = MAX_FOOTPRINT / srcHalfW;
      if (s > maxScaleForFootprint) s = maxScaleForFootprint;
      const foot = srcHalfW * s; // post-scale footprint radius (yaw-invariant)

      // Footprint-aware clearance tests.
      if (p.length() < foot + CENTER_MARGIN) {
        this.disposePropMaterials(inst);
        continue;
      }
      if (spawnPts.some((sp) => sp.distanceTo(p) < foot + SPAWN_MARGIN)) {
        this.disposePropMaterials(inst);
        continue;
      }
      if (
        placed.some((q) => q.p.distanceTo(p) < foot + q.foot + SELF_MARGIN)
      ) {
        this.disposePropMaterials(inst);
        continue;
      }

      // Apply toon rocky material (cloned per instance for subtle hue variety).
      const mat = baseRock.clone();
      const hue = 0.06 + rng() * 0.05; // brownish
      const light = 0.32 + rng() * 0.12;
      mat.color.setHSL(hue, 0.22, light);
      inst.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = mat;
          m.castShadow = true;
          m.receiveShadow = true;
          if (m.geometry && !m.geometry.getAttribute("normal")) {
            m.geometry.computeVertexNormals();
          }
        }
      });

      inst.scale.setScalar(s);
      inst.rotation.y = rng() * Math.PI * 2;
      // Re-measure the scaled/rotated bottom so we sit it on the ground, then
      // sink 0.5-1u so no edges float above the terrain. (groundAt is 0 here —
      // worldBvh builds after arena load — which matches the base surface y=0.)
      inst.updateMatrixWorld(true);
      const sbox = new THREE.Box3().setFromObject(inst);
      const groundY = this.groundAt(x, z);
      const sink = 0.5 + rng() * 0.5;
      inst.position.set(x, groundY - sbox.min.y - sink, z);

      sceneGroup.add(inst);
      inst.updateMatrixWorld(true);
      props.push(inst);
      placed.push({ p, foot });

      inst.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry?.getAttribute("position")) {
          colliders.push(m);
        }
      });
    }

    return { props, colliders };
  }

  private makeHealthBar(): {
    sprite: THREE.Sprite;
    canvas: HTMLCanvasElement;
    tex: THREE.CanvasTexture;
  } {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 16;
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.4, 0.3, 1);
    return { sprite, canvas, tex };
  }

  private drawHealthBar(enemy: Enemy): void {
    const ctx = enemy.barCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, 128, 16);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, 128, 16);
    const pct = Math.max(0, enemy.health / enemy.maxHealth);
    // Allies read green; rivals keep the red danger gradient.
    if (enemy.ally) {
      ctx.fillStyle = pct > 0.5 ? "#5aff7a" : pct > 0.25 ? "#9bff5f" : "#f5ff2d";
    } else {
      ctx.fillStyle = pct > 0.5 ? "#ff5a5a" : pct > 0.25 ? "#ff9b3b" : "#ff2d2d";
    }
    ctx.fillRect(2, 2, (128 - 4) * pct, 12);
    // Faction accent border so squads are visually distinct.
    ctx.strokeStyle = `#${enemy.factionColor.toString(16).padStart(6, "0")}`;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 126, 14);
    enemy.barTex.needsUpdate = true;
  }

  private spawnWave(): void {
    this.wave++;
    if (this.wave > this.totalWaves) {
      this.phase = "victory";
      this.exitPointerLock();
      this.emit();
      return;
    }
    const count = 2 + this.wave;
    const baseHp = 40 + this.wave * 12;
    // From wave 2, a portion of the wave are ranged gunners (kiting + firing).
    const gunners = this.gunnerDef && this.wave >= 2 ? Math.min(count - 1, 1 + Math.floor(this.wave / 2)) : 0;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random();
      const r = 26 + Math.random() * 8;
      const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.spawnEnemy(pos, baseHp, 3.0 + this.wave * 0.3, i < gunners);
    }
    // Archetype roster: dedicated Toon RTS units join as waves ramp up.
    // Flankers from wave 1, archers from wave 2, bruisers + casters from wave 3.
    if (this.archetypeDefs.length > 0) {
      const picks: EnemyArchetype[] = [];
      for (let i = 0; i < Math.min(3, Math.ceil(this.wave / 2)); i++) picks.push("flanker");
      if (this.wave >= 2) for (let i = 0; i < Math.floor(this.wave / 2); i++) picks.push("grunt");
      if (this.wave >= 3) for (let i = 0; i < Math.floor(this.wave / 3) + 1; i++) picks.push("bruiser");
      if (this.wave >= 3) for (let i = 0; i < Math.floor((this.wave - 1) / 2); i++) picks.push("caster");
      for (const arch of picks) {
        const a = Math.random() * Math.PI * 2;
        const r = 26 + Math.random() * 8;
        this.spawnArchetype(
          new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r),
          baseHp,
          arch,
        );
      }
    }
    // Lesser minions pad every wave: weaker, slightly smaller foot-soldiers
    // from the marauder/elf packs. The Fire Elf caster joins from wave 2.
    if (this.minionDefs.length > 0) {
      const minions = 1 + this.wave;
      const minionHp = Math.round(baseHp * 0.5);
      for (let i = 0; i < minions; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 24 + Math.random() * 10;
        const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
        const wantRanged = this.wave >= 2 && i % 3 === 2;
        this.spawnMinion(pos, minionHp, 3.2 + this.wave * 0.25, wantRanged);
      }
    }
    this.setMessage(`Wave ${this.wave} / ${this.totalWaves}`, 2);
    this.emit();
  }

  /**
   * Spawn the six race squads for a Faction War free-for-all. The player's race
   * is team 0 (player + AI allies spawn beside the player); each remaining race
   * becomes a rival AI squad at an evenly spaced point around the ring.
   */
  /**
   * Deterministic squad role mix. Returns `size` roles, index 0 being the melee
   * anchor. `slot` (0..5) picks between the "either/or" support choices so the
   * layout is fair and stable per squad but varies faction to faction.
   *   size 3 -> [grunt, flanker|bruiser, caster|ranged]
   *   size 2 -> [grunt, caster|flanker]
   * "grunt"/"flanker"/"bruiser"/"caster" reuse the survival archetype AI; the
   * "ranged" role is a grunt-model backline fighter that shoots (see
   * spawnFactionUnit) so squads without the staff model still field a shooter.
   */
  private squadComposition(size: number, slot: number): FactionRole[] {
    const even = slot % 2 === 0;
    if (size >= 3) {
      return ["grunt", even ? "flanker" : "bruiser", even ? "caster" : "ranged"];
    }
    return ["grunt", even ? "caster" : "flanker"];
  }

  /**
   * Spawn the six race squads for a Faction War free-for-all. The player's race
   * is team 0 (player + AI allies spawn beside the player); each remaining race
   * becomes a rival AI squad at an evenly spaced point around the ring.
   */
  private spawnFactions(): void {
    const cfg = this.factionConfig;
    if (!cfg || !this.lastPlayer) return;
    const size = Math.max(2, Math.min(3, cfg.squadSize));
    const playerRace = this.lastPlayer.raceId;
    // Spawn ring radius derived from the fitted interior (falls back to 40 when
    // the procedural arena is in use / the GLB failed to load).
    const RING =
      this.mode === "factions" && this.factionArena
        ? this.factionSpawnRadius
        : 40;
    const hp = 120;
    const speed = 4.2;

    // Order races so the player's race takes ring slot 0 (beside the player).
    const races = Object.keys(cfg.heroesByRace);
    const ordered = [
      playerRace,
      ...races.filter((r) => r !== playerRace),
    ].filter((r, i, a) => a.indexOf(r) === i);

    ordered.forEach((race, slot) => {
      const hero = cfg.heroesByRace[race];
      if (!hero) return;
      const isPlayerTeam = race === playerRace;
      const team = isPlayerTeam ? this.playerTeam : slot;
      const color = this.colorHex(
        FACTION_COLORS[race] ?? hero.factionColor ?? "#cccccc",
      );
      const ang = (slot / ordered.length) * Math.PI * 2;
      const cx = Math.cos(ang) * RING;
      const cz = Math.sin(ang) * RING;
      // The player already occupies one slot of their squad, so spawn size-1
      // allies beside the player; other squads spawn `size` fighters.
      const units = isPlayerTeam ? size - 1 : size;
      const hasCasterDef = this.archetypeDefs.some((d) => d.archetype === "caster");
      // Deterministic per-squad role mix. Every squad fields a melee anchor plus
      // a supporting mix drawn from the survival archetypes (flanker / bruiser /
      // caster / ranged). The player's squad is sized down by one (the player is
      // the melee anchor), so its allies fill the SUPPORT slots of the same
      // full-squad composition rather than the leading grunt slot.
      const composition = this.squadComposition(size, slot);
      const roles = isPlayerTeam ? composition.slice(1) : composition;
      for (let i = 0; i < units; i++) {
        const jitter = (i - (units - 1) / 2) * 3.2;
        // Offset units perpendicular to the ring radius so a squad lines up.
        const px = isPlayerTeam
          ? this.player.position.x + (i + 1) * 2.4
          : cx + Math.cos(ang + Math.PI / 2) * jitter;
        const pz = isPlayerTeam
          ? this.player.position.z + jitter
          : cz + Math.sin(ang + Math.PI / 2) * jitter;
        const pos = new THREE.Vector3(px, this.groundAt(px, pz), pz);
        let role = roles[i] ?? "grunt";
        // Casters need the dedicated staff model; without it, demote to ranged
        // so the squad still fields a backline fighter.
        if (role === "caster" && !hasCasterDef) role = "ranged";
        if (role === "caster") {
          // Staff-caster from the archetype roster, tinted with the squad's
          // faction color so it reads as part of the same team. Each race
          // gets its own elemental cast from FACTION_CAST_DEFS.
          const factionCastDef = FACTION_CAST_DEFS[race] ?? ENEMY_CAST_DEF;
          this.spawnArchetype(pos, hp, "caster", team, color, isPlayerTeam, factionCastDef);
        } else {
          this.spawnFactionUnit(
            hero,
            pos,
            hp,
            speed,
            team,
            color,
            isPlayerTeam,
            role,
          );
        }
      }
    });
    this.emit();
  }

  /**
   * Spawn a single squad fighter (reuses the enemy instantiation paths) with a
   * survival role. `role` selects the AI archetype + per-archetype HP/speed
   * tuning (base values, no wave scaling); the special "ranged" role keeps the
   * grunt AI but forces the unit to fight at range so squads without the staff
   * model still get a backline shooter.
   */
  private spawnFactionUnit(
    hero: HeroInfo,
    pos: THREE.Vector3,
    hp: number,
    speed: number,
    team: number,
    color: number,
    ally: boolean,
    role: FactionRole = "grunt",
  ): void {
    // Find the loaded def for this race (falls back to any def, then capsule).
    let def =
      this.enemyDefs.find((d) => d.raceId === hero.raceId) ??
      this.enemyDefs.find((d) => d.weapon === hero.weapon) ??
      null;
    // "ranged" forces a shooter regardless of weapon; other roles use ranged
    // only when the def's weapon is non-blade (bow/staff etc.).
    const defRanged = def ? def.category !== "blade" : false;
    const ranged = role === "ranged" ? true : defRanged;
    // Map role -> AI archetype ("ranged" behaves as a grunt that kites).
    const archetype: EnemyArchetype = role === "ranged" ? "grunt" : role;
    // Per-archetype tuning off the faction base (fair, deterministic, no wave
    // scaling). Flankers are fast/fragile, bruisers slow/tanky, others baseline.
    let unitHp = hp;
    let unitSpeed = speed;
    let scale = 1;
    switch (archetype) {
      case "flanker":
        unitHp = Math.round(hp * 0.7);
        unitSpeed = speed * 1.3;
        break;
      case "bruiser":
        unitHp = Math.round(hp * 1.8);
        unitSpeed = speed * 0.7;
        scale = 1.18;
        break;
      default:
        break;
    }
    let inst: CharacterInstance;
    if (def?.rig === "toonrts" && def.toonTemplate) {
      inst = this.makeToon(def.toonTemplate, color, def.weapon, def.clips, def);
    } else if (def?.template && def.clips) {
      inst =
        def.rig === "meshy"
          ? instantiateMeshyAnimated(def.template, def.clips, color)
          : instantiateGrudgeAnimated(def.template, def.clips, color, def.weapon);
    } else if (def?.template) {
      inst =
        def.rig === "meshy"
          ? instantiateMeshyModel(def.template, color)
          : instantiateModel(def.template, color, def.weapon);
    } else {
      inst = instantiateCapsule(0x1a1320, 0x9a3b3b, color);
      def = null;
    }
    if (scale !== 1) inst.group.scale.setScalar(scale);
    this.finishEnemySpawn(
      inst,
      def,
      pos,
      unitHp,
      unitSpeed,
      ranged,
      archetype,
      team,
      color,
      ally,
    );
  }

  /**
   * Spawn a lesser minion from the Standout packs: half-strength, slightly
   * smaller foot-soldiers. Ranged picks the magic-category minion (Fire Elf
   * staff caster); melee picks any blade minion. Falls back to a regular
   * enemy spawn if the requested pool is empty.
   */
  private spawnMinion(
    pos: THREE.Vector3,
    hp: number,
    speed: number,
    ranged = false,
  ): void {
    const pool = ranged
      ? this.minionDefs.filter((d) => d.category !== "blade")
      : this.minionDefs.filter((d) => d.category === "blade");
    const def = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : null;
    if (!def?.template) {
      this.spawnEnemy(pos, hp, speed, ranged);
      return;
    }
    const inst = def.clips
      ? instantiateMinionAnimated(def.template, def.clips, def.color, def.weaponTemplate ?? null)
      : instantiateMinionModel(def.template, def.color, def.weaponTemplate ?? null);
    // Slightly smaller than champions so minions read as the lesser rank.
    inst.group.scale.setScalar(0.88);
    this.finishEnemySpawn(inst, def, pos, hp, speed, ranged && def.category !== "blade");
  }

  /**
   * Spawn a dedicated archetype unit (flanker / bruiser / caster / archer)
   * from the Toon RTS roster, with per-archetype HP, speed, and scale tuning.
   * Falls back to a regular enemy spawn if the roster failed to load.
   */
  private spawnArchetype(
    pos: THREE.Vector3,
    baseHp: number,
    archetype: EnemyArchetype,
    team?: number,
    factionColor?: number,
    ally?: boolean,
    castDef?: CastDef,
  ): void {
    const def = this.archetypeDefs.find((d) => d.archetype === archetype);
    if (!def?.toonTemplate) {
      this.spawnEnemy(pos, baseHp, 3.0 + this.wave * 0.3, archetype === "caster");
      return;
    }
    // Use the archetype's own accent unless overridden by a faction color (e.g.
    // Faction War squads tint the caster's health bar to their squad color).
    const accentColor = factionColor ?? def.color;
    const inst = this.makeToon(def.toonTemplate, accentColor, def.weapon, def.clips, def);
    let hp = baseHp;
    let speed = 3.0 + this.wave * 0.3;
    const ranged = archetype === "caster" || def.category !== "blade";
    switch (archetype) {
      case "flanker":
        hp = Math.round(baseHp * 0.65);
        speed = 5.4 + this.wave * 0.35; // fast — closes and circles
        break;
      case "bruiser":
        hp = Math.round(baseHp * 2.4);
        speed = 2.1 + this.wave * 0.15; // slow, relentless
        inst.group.scale.setScalar(1.22); // reads as the heavy rank
        break;
      case "caster":
        hp = Math.round(baseHp * 0.85);
        speed = 2.8 + this.wave * 0.25;
        break;
      default:
        hp = Math.round(baseHp * 0.9);
        break;
    }
    this.finishEnemySpawn(inst, def, pos, hp, speed, ranged, archetype, team, factionColor ?? null, ally ?? false, castDef);
  }

  private spawnEnemy(
    pos: THREE.Vector3,
    hp: number,
    speed: number,
    ranged = false,
  ): void {
    // Ranged spawns prefer the Toon RTS bow/mage units (they shoot with the
    // same tracer path as the gunner); the mixamorig gunner is the fallback.
    const toonRangedDefs = this.enemyDefs.filter(
      (d) => d.rig === "toonrts" && d.toonTemplate && d.category !== "blade",
    );
    const useRanged =
      ranged && (toonRangedDefs.length > 0 || this.gunnerDef !== null);
    let inst: CharacterInstance;
    let def: EnemyDef | null = null;
    if (useRanged && toonRangedDefs.length > 0) {
      def = toonRangedDefs[Math.floor(Math.random() * toonRangedDefs.length)];
      inst = this.makeToon(def.toonTemplate!, def.color, def.weapon, def.clips, def);
    } else if (useRanged && this.gunnerDef) {
      inst = instantiateHeavy(this.gunnerDef.template, this.gunnerDef.library, 0xffb347);
    } else {
      // Melee spawns draw from the blade-carrying defs so archers/mages don't
      // wander into sword range with no block animation.
      const meleeDefs = this.enemyDefs.filter((d) => d.category === "blade");
      const pool = meleeDefs.length > 0 ? meleeDefs : this.enemyDefs;
      def = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
      if (def?.rig === "toonrts" && def.toonTemplate) {
        inst = this.makeToon(def.toonTemplate, def.color, def.weapon, def.clips, def);
      } else if (def?.template && def.clips) {
        inst =
          def.rig === "meshy"
            ? instantiateMeshyAnimated(def.template, def.clips, def.color)
            : instantiateGrudgeAnimated(def.template, def.clips, def.color, def.weapon);
      } else if (def?.template) {
        inst =
          def.rig === "meshy"
            ? instantiateMeshyModel(def.template, def.color)
            : instantiateModel(def.template, def.color, def.weapon);
      } else {
        inst = instantiateCapsule(0x1a1320, 0x9a3b3b, def?.color ?? 0xff3b3b);
      }
    }
    this.finishEnemySpawn(inst, def, pos, hp, speed, useRanged);
  }

  /** Shared tail of every enemy spawn: scene add, physics, health bar, Enemy record. */
  private finishEnemySpawn(
    inst: CharacterInstance,
    def: EnemyDef | null,
    pos: THREE.Vector3,
    hp: number,
    speed: number,
    useRanged: boolean,
    archetype: EnemyArchetype = "grunt",
    team = 1,
    factionColor: number | null = null,
    ally = false,
    castDef?: CastDef,
  ): void {
    inst.group.position.copy(pos);
    this.scene.add(inst.group);
    inst.group.updateWorldMatrix(true, true);

    let body: CharacterBody | null = null;
    if (this.physics) {
      try {
        body = this.physics.createCharacter(pos, ENEMY_RADIUS, ENEMY_HEIGHT);
      } catch {
        body = null;
      }
    }
    const hitter = makeBodyHitter(this.bodyMeshes(inst.group));

    const bar = this.makeHealthBar();
    bar.sprite.position.set(0, 2.7, 0);
    inst.group.add(bar.sprite);

    // Movement Motivation from the weapon: gunners carry a rifle, roster enemies
    // use their own weapon/category. `desiredRange` turns MM into the standoff
    // this enemy holds (see mm.ts) -- only ranged attackers actually kite.
    const mm = useRanged
      ? mmForWeapon(def?.weapon ?? "rifle", def?.category ?? "bow")
      : mmForWeapon(def?.weapon ?? "", def?.category ?? "blade");
    const desiredRange = enemyStandoff(mm, useRanged);

    const accent = factionColor ?? def?.color ?? inst.accent;
    const baseLabel =
      def?.label ?? enemyLabel(def?.weapon ?? (useRanged ? "rifle" : ""), useRanged);
    // Support healers: casters/staff wielders (mage-type) and knight-class melee
    // (shield). Faction War only — these AI units pulse AoE heals to same-team
    // allies. Player-team allies heal too (they are Enemy records on team 0).
    const weaponStr = (def?.weapon ?? "").toLowerCase();
    const healer =
      this.mode === "factions" &&
      (archetype === "caster" ||
        weaponStr.includes("staff") ||
        weaponStr.includes("shield"));
    const enemy: Enemy = {
      inst,
      team,
      factionColor: accent,
      ally,
      archetype,
      pendingCast: null,
      healer,
      healCooldown: healer ? 3 + Math.random() * 3 : 0,
      healCast: 0,
      label: ally ? `[Ally] ${baseLabel}` : baseLabel,
      shotKind: shotKindFor(def?.weapon ?? "rifle"),
      health: hp,
      maxHealth: hp,
      alive: true,
      attackCooldown: useRanged ? 1.2 + Math.random() * 1.2 : 1 + Math.random(),
      hitFlash: 0,
      stagger: 0,
      stunTimer: 0,
      speed,
      moving: false,
      gone: false,
      bar: bar.sprite,
      barCanvas: bar.canvas,
      barTex: bar.tex,
      swing: 0,
      knockback: new THREE.Vector3(),
      body,
      hitter,
      hitterSwing: -1,
      ranged: useRanged,
      strafeDir: Math.random() < 0.5 ? -1 : 1,
      mm,
      desiredRange,
      castDef,
      passive: this.spawnAsPassive,
      statusEffects: [],
      steer: new CombatSteering(),
      threat: new ThreatTable(),
      spawnX: pos.x,
      spawnZ: pos.z,
      brainId: `e-${this.enemies.length}-${Math.random().toString(36).slice(2, 8)}`,
    };
    this.drawHealthBar(enemy);
    this.enemies.push(enemy);
  }

  private enemiesAlive(): number {
    // Faction War: count only rival (non-team-0) units for the HUD "hostiles".
    if (this.mode === "factions") {
      return this.enemies.filter((e) => e.alive && e.team !== this.playerTeam)
        .length;
    }
    return this.enemies.filter((e) => e.alive).length;
  }

  /**
   * True when the player's own attacks may hit this unit: it must be alive and
   * NOT one of the player's team-0 allies (Faction War). In every other mode all
   * enemies are hostile, so this is just an alive check.
   */
  private isPlayerFoe(e: Enemy): boolean {
    return e.alive && e.team !== this.playerTeam;
  }

  /** World position of a unit; a null target means the player. */
  private unitPos(u: Enemy | null): THREE.Vector3 {
    return u ? u.inst.group.position : this.player.position;
  }

  /** Team of a unit; a null target means the player (team 0). */
  private unitTeam(u: Enemy | null): number {
    return u ? u.team : this.playerTeam;
  }

  /**
   * Nearest LIVING unit on a team different from `e`, including the player
   * (returned as the sentinel `"player"`). Returns null when `e` has no valid
   * target. Used by AI target selection so allies and rival squads all fight.
   */
  private nearestTargetFor(e: Enemy): Enemy | "player" | null {
    const pos = e.inst.group.position;
    const ai = catalog.ai;
    const aggro = ai?.aggro;
    const now = performance.now() / 1000;
    e.threat.tick(
      0.016,
      ai?.threat.decayPerSec ?? 4,
      now,
    );
    const resolveId = (id: string | null): Enemy | "player" | null => {
      if (!id) return null;
      if (id === "player" && e.team !== this.playerTeam) return "player";
      return this.enemies.find((o) => o.alive && o.brainId === id) ?? null;
    };
    const top = resolveId(e.threat.top());
    if (top) {
      const tp = top === "player" ? this.player.position : top.inst.group.position;
      const fromSpawn = Math.hypot(pos.x - e.spawnX, pos.z - e.spawnZ);
      if (!aggro || fromSpawn <= aggro.leashRadius) {
        const d = Math.hypot(tp.x - pos.x, tp.z - pos.z);
        if (!aggro || d <= aggro.leashRadius) return top;
      }
    }
    let best: Enemy | "player" | null = null;
    let bestD = Infinity;
    if (e.team !== this.playerTeam && this.phase === "playing") {
      const d = pos.distanceToSquared(this.player.position);
      best = "player";
      bestD = d;
    }
    for (const o of this.enemies) {
      if (o === e || !o.alive || o.team === e.team) continue;
      const d = pos.distanceToSquared(o.inst.group.position);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    if (!best || !aggro) return best;
    const dist = Math.sqrt(bestD);
    const ring = aggroState(
      dist,
      Math.hypot(pos.x - e.spawnX, pos.z - e.spawnZ),
      aggro,
    );
    if (ring === "leash") return null;
    if (ring === "idle") return e.threat.top() ? best : null;
    return best;
  }

  /** Route damage to a unit (null = the player) with team-aware handling. */
  private damageUnit(target: Enemy | null, amount: number, attacker: Enemy): void {
    if (target === null) {
      this.damagePlayer(amount, attacker);
    } else if (target.alive) {
      // Cross-faction AI hit: apply directly (bypasses the player's
      // block/parry/i-frame logic, which only defends the player).
      this.damageEnemy(target, amount, attacker.factionColor);
    }
  }

  /**
   * True when a healer should pulse: the healer itself, or any living same-team
   * ally within the heal radius, is below the trigger hp fraction. Never heals
   * across factions (same-team only). Player-team allies also consider the
   * player's own health so they support the champion.
   */
  private shouldHeal(e: Enemy): boolean {
    const pos = e.inst.group.position;
    if (e.health < e.maxHealth * HEAL_TRIGGER) return true;
    // Player-team healers also react to a wounded player in range.
    if (
      e.team === this.playerTeam &&
      this.phase === "playing" &&
      pos.distanceTo(this.player.position) <= HEAL_RADIUS &&
      this.health < this.maxHealth * HEAL_TRIGGER
    ) {
      return true;
    }
    for (const o of this.enemies) {
      if (o === e || !o.alive || o.gone || o.team !== e.team) continue;
      if (o.health >= o.maxHealth * HEAL_TRIGGER) continue;
      if (pos.distanceTo(o.inst.group.position) <= HEAL_RADIUS) return true;
    }
    return false;
  }

  /**
   * AoE heal pulse: restore HEAL_AMOUNT to every living SAME-TEAM ally (and, for
   * player-team healers, the player) within HEAL_RADIUS, capped at max hp. Never
   * heals other factions. Spawns a green/gold VFX pulse and plants the healer
   * briefly (healCast) while it resolves.
   */
  private pulseHeal(e: Enemy): void {
    e.healCooldown = HEAL_CD_MIN + Math.random() * (HEAL_CD_MAX - HEAL_CD_MIN);
    e.healCast = HEAL_CAST;
    const pos = e.inst.group.position;
    // Player-team healers mend the champion too.
    if (
      e.team === this.playerTeam &&
      this.phase === "playing" &&
      this.health < this.maxHealth &&
      pos.distanceTo(this.player.position) <= HEAL_RADIUS
    ) {
      this.health = Math.min(this.maxHealth, this.health + HEAL_AMOUNT);
      this.emit();
    }
    for (const o of this.enemies) {
      if (!o.alive || o.gone || o.team !== e.team) continue;
      if (pos.distanceTo(o.inst.group.position) > HEAL_RADIUS) continue;
      if (o.health >= o.maxHealth) continue;
      o.health = Math.min(o.maxHealth, o.health + HEAL_AMOUNT);
      this.drawHealthBar(o);
      // Small mote on each mended ally.
      this.spawnImpact(
        o.inst.group.position.clone().add(new THREE.Vector3(0, 1.6, 0)),
        "hit",
        HEAL_COLOR,
        1.1,
      );
    }
    // Central heal burst on the healer + a wide green pulse that expands to the
    // heal radius so the AoE footprint reads clearly (green/gold, not the red
    // warning telegraph which would misread as a threat).
    this.spawnImpact(
      pos.clone().add(new THREE.Vector3(0, 1.4, 0)),
      "crit",
      HEAL_COLOR,
      2.4,
    );
    this.spawnImpact(
      pos.clone().add(new THREE.Vector3(0, 0.4, 0)),
      "hit",
      0xffe08a, // warm gold overlay
      HEAL_RADIUS * 0.8,
    );
    this.cameraShake(0.15, 120);
  }

  /** True when every rival (non-team-0) unit is dead (Faction War victory). */
  private factionVictory(): boolean {
    return !this.enemies.some((e) => e.alive && e.team !== this.playerTeam);
  }

  private resizeHandler = () => this.resize();

  private keyDown = (e: KeyboardEvent) => {
    if (!this.keys[e.code]) {
      const now = performance.now() / 1000;
      if (
        (e.code === "KeyW" ||
          e.code === "KeyA" ||
          e.code === "KeyS" ||
          e.code === "KeyD") &&
        now - (this.lastTap[e.code] ?? -1) < DASH_WINDOW
      ) {
        this.dashRequested = true;
      }
      this.lastTap[e.code] = now;
      // Skill / cast hotkeys are catalog-driven (rebindable in the Studio).
      // Defaults reproduce Q -> skill 0, E -> skill 1, 1..6 -> casts 0..5.
      const skillIdx = catalog.hotkeys.skill.indexOf(e.code);
      const castIdx = catalog.hotkeys.cast.indexOf(e.code);
      if (skillIdx >= 0) this.castSkill(skillIdx);
      else if (castIdx >= 0) this.castElemental(castIdx);
      else if (e.code === "Tab") this.cycleTarget();
      else if (e.code === "KeyR") this.forcePush();
      else if (e.code === "Space" && !this.grounded && !this.doubleJumpUsed) {
        // Second Space press mid-air requests a Force Jump (resolved in
        // updatePlayer so it shares the force/grounded checks with movement).
        this.forceJumpRequested = true;
      }
    }
    this.keys[e.code] = true;
    if (e.code === "Space" || e.code === "Tab") e.preventDefault();
  };

  private keyUp = (e: KeyboardEvent) => {
    this.keys[e.code] = false;
  };

  private preventContext = (e: Event) => e.preventDefault();

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    // While drawing a slash/guard path, mouse deltas move the gesture cursor
    // instead of the camera (the view holds still so the stroke is precise).
    if (this.drawMode !== "none") {
      this.extendDraw(e.movementX, e.movementY);
      return;
    }
    // Mouse drives the orbit camera: X yaws around the character, Y tilts the
    // pitch. Pitch is clamped in updateCamera.
    this.camYaw -= e.movementX * 0.0022;
    this.camPitch += e.movementY * 0.0022;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (this.phase !== "playing") return;
    if (this.uiMouse) return; // a HUD menu / UI-edit session owns the mouse
    if (!this.pointerLocked) {
      this.requestPointerLock();
      return;
    }
    if (e.button === 0) {
      this.mouseDown = true;
      this.lmbDownAt = performance.now() / 1000;
      this.drawTried = false;
      // Shift+LMB is a heavy strike; plain LMB is a light (combo) strike.
      // Keeping the hold past DRAW_HOLD_T starts a drawn slash (see updatePlayer).
      this.tryAttack(e.shiftKey);
    } else if (e.button === 1) {
      // MMB: hip-pistol quick-draw → tentacle hook at the crosshair → dash.
      e.preventDefault();
      this.middleDown = true;
      this.firePistolGrapple();
    } else if (e.button === 2) {
      this.rightDown = true;
      // Plain RMB toggles lock-on (focus the target under the crosshair).
      // Shift+RMB is a held block (handled in updatePlayer via rightDown+Shift).
      if (!e.shiftKey) this.focusTarget();
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.lmbDownAt = -1;
      if (this.drawMode === "slash") this.finishDraw();
    } else if (e.button === 1) {
      this.middleDown = false;
    } else if (e.button === 2) this.rightDown = false;
  };

  private onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    // Losing pointer lock clears all transient input so reacquiring the lock
    // can't resume a stale attack/draw/block without a fresh physical press.
    if (!this.pointerLocked) {
      this.resetPointerState();
      this.keys = {};
    }
  };

  /** Clear transient mouse/gesture state (lock loss, run reset). */
  private resetPointerState(): void {
    this.mouseDown = false;
    this.middleDown = false;
    this.lmbDownAt = -1;
    this.drawTried = false;
    this.cancelDraw();
  }

  private bindEvents(): void {
    window.addEventListener("resize", this.resizeHandler);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    this.canvas.addEventListener("contextmenu", this.preventContext);
  }

  /** While true the HUD owns the mouse: no pointer lock, no combat clicks. */
  private uiMouse = false;

  /** HUD menus / UI-edit mode call this to borrow or return the mouse. */
  setUiMouse(on: boolean): void {
    this.uiMouse = on;
    if (on) this.exitPointerLock();
    else if (this.phase === "playing") this.requestPointerLock();
  }

  private requestPointerLock(): void {
    if (this.uiMouse) return;
    if (document.pointerLockElement !== this.canvas) {
      // Browsers return a Promise and reject it when called outside a user
      // gesture (e.g. re-locking from a React effect after ESC-closing a
      // menu). Swallow that rejection — the player just clicks the canvas to
      // resume, exactly like after any other pointer-lock loss.
      try {
        const p = this.canvas.requestPointerLock?.() as unknown;
        (p as Promise<void> | undefined)?.catch?.(() => {});
      } catch {
        // Older engines throw synchronously instead; same recovery path.
      }
    }
  }

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock?.();
    }
  }

  /** Lazily build the downward-chevron lock-on marker (billboarded sprite). */
  private ensureTargetMarker(): THREE.Sprite {
    if (this.targetMarker) return this.targetMarker;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = "#ff5566";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(10, 12);
    ctx.lineTo(54, 12);
    ctx.lineTo(32, 52);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.9, 0.9, 0.9);
    sprite.renderOrder = 999;
    sprite.visible = false;
    this.scene.add(sprite);
    this.targetMarker = sprite;
    return sprite;
  }

  /** Tab through alive enemies (nearest-first), locking the next one. */
  private cycleTarget(): void {
    if (this.phase !== "playing") return;
    const list = this.enemies
      .filter((e) => this.isPlayerFoe(e))
      .sort(
        (a, b) =>
          a.inst.group.position.distanceToSquared(this.player.position) -
          b.inst.group.position.distanceToSquared(this.player.position),
      );
    if (list.length === 0) {
      this.setTarget(null);
      return;
    }
    const i = this.targetEnemy ? list.indexOf(this.targetEnemy) : -1;
    this.setTarget(list[(i + 1) % list.length]);
  }

  /** RMB: toggle lock-on. Locks the enemy nearest the crosshair, else nearest. */
  private focusTarget(): void {
    if (this.phase !== "playing") return;
    if (this.targetEnemy && this.targetEnemy.alive) {
      this.setTarget(null);
      return;
    }
    this.setTarget(this.bestTargetInView());
  }

  /** Pick the alive enemy closest to the camera's aim (forward cone), else nearest. */
  private bestTargetInView(coneOnly = false): Enemy | null {
    const fwd = this.camera.getWorldDirection(this.tmpV).clone();
    const camPos = this.camera.position;
    let best: Enemy | null = null;
    let bestDot = -Infinity;
    let nearest: Enemy | null = null;
    let nearestD = Infinity;
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e)) continue;
      const to = this.tmpV2.copy(e.inst.group.position).sub(camPos);
      const d = to.length();
      if (d < nearestD) {
        nearestD = d;
        nearest = e;
      }
      if (d < 1e-3) continue;
      to.multiplyScalar(1 / d);
      const dot = to.dot(fwd);
      if (dot > 0.55 && dot > bestDot) {
        bestDot = dot;
        best = e;
      }
    }
    // coneOnly: the mouse decides — never fall back to an enemy off-reticle.
    return coneOnly ? best : best ?? nearest;
  }

  /** Nearest alive enemy within melee approach range, for attack auto-aim. */
  private nearestEnemyForAttack(): Enemy | null {
    let best: Enemy | null = null;
    let bestD = 6 * 6;
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e)) continue;
      const d = e.inst.group.position.distanceToSquared(this.player.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * Soft focus: continuously track the enemy under the reticle (camera-aim
   * cone only) and hover a subtle dim ring over it. Swings and casts aim at
   * this target when no hard lock is active — the highlight always tells the
   * player exactly what the next strike will hit.
   */
  private updateSoftFocus(dt: number): void {
    const hardLocked = !!(this.targetEnemy && this.targetEnemy.alive);
    this.softTarget =
      this.phase === "playing" && !hardLocked
        ? this.bestTargetInView(true)
        : null;
    const m = this.ensureSoftMarker();
    if (!this.softTarget) {
      m.visible = false;
      return;
    }
    const p = this.softTarget.inst.group.position;
    const y = p.y + 2.35 + Math.sin(this.clock.elapsedTime * 3) * 0.06;
    if (!m.visible) {
      m.visible = true;
      m.position.set(p.x, y, p.z);
    } else {
      // Ease between targets/positions so the highlight never snaps.
      const k = 1 - Math.exp(-14 * dt);
      m.position.x += (p.x - m.position.x) * k;
      m.position.y += (y - m.position.y) * k;
      m.position.z += (p.z - m.position.z) * k;
    }
  }

  private ensureSoftMarker(): THREE.Sprite {
    if (this.softMarker) return this.softMarker;
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, 64, 64);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
      opacity: 0.38,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.55, 0.55, 0.55);
    sprite.renderOrder = 998;
    sprite.visible = false;
    this.scene.add(sprite);
    this.softMarker = sprite;
    return sprite;
  }

  private setTarget(e: Enemy | null): void {
    const next = e && e.alive ? e : null;
    const changed = this.targetEnemy !== next;
    this.targetEnemy = next;
    if (this.targetMarker && !next) this.targetMarker.visible = false;
    if (changed) this.emit();
  }

  /** Keep the lock-on marker over the target; drop a dead/removed target. */
  private updateTargetMarker(): void {
    if (this.targetEnemy && !this.targetEnemy.alive) this.setTarget(null);
    const t = this.targetEnemy;
    if (!t) {
      if (this.targetMarker) this.targetMarker.visible = false;
      return;
    }
    const m = this.ensureTargetMarker();
    m.visible = true;
    const p = t.inst.group.position;
    m.position.set(p.x, p.y + 3.1, p.z);
  }

  /** Bow LMB: draw clip scaled to the GRUDGE6 / catalog draw timer, then loose. */
  private startBowShot(): void {
    if (this.attackTimer > 0 || this.arcaneCharge > 0 || this.pendingCasts.length) {
      return;
    }
    this.facing = this.castAimYaw();
    const profile = weaponCombatProfile(this.playerWeapon);
    const arrow = rangedShot("arrow") as ArrowShotParams;
    const drawT = Math.max(
      profile.windup + profile.active,
      (arrow.releaseMs || RANGED_RELEASE_MS) / 1000,
    );
    this.pendingShot = "arrow";
    this.rangedChargeDur = drawT;
    this.castAnimDur = drawT;
    this.castAnimT = drawT;
    this.attackDur = drawT;
    this.attackTimer = drawT;
    this.attackActive = false;
    this.attackHeavy = false;
    this.attackAir = false;
    this.lungeRemain = 0;
    this.swingId++;
  }

  /** Staff LMB: HUD cast bar + magic_cast clip scaled to catalog / GRUDGE6 time. */
  private startArcaneCast(): void {
    if (this.attackTimer > 0 || this.arcaneCharge > 0 || this.pendingCasts.length) {
      return;
    }
    this.facing = this.castAimYaw();
    const profile = weaponCombatProfile(this.playerWeapon);
    const orb = rangedShot("orb") as OrbShotParams;
    const fallback = profile.windup + profile.active + profile.recovery;
    const castT = orb.castT > 0 ? orb.castT : fallback;
    this.pendingShot = "orb";
    this.arcaneCharge = castT;
    this.rangedChargeDur = castT;
    this.castAnimDur = castT;
    this.castAnimT = castT;
    this.attackDur = 0;
    this.attackTimer = 0;
    this.attackActive = false;
    this.attackHeavy = false;
    this.attackAir = false;
    this.lungeRemain = 0;
    this.swingId++;
  }

  /** Loose an arrow or arcane orb from the player toward the current aim. */
  private firePlayerShot(kind: "arrow" | "orb"): void {
    // Re-read the aim at release (like releaseCast) and face the shot.
    this.facing = this.castAimYaw();
    const dir = this.facingDir();
    // Slight lift toward a locked/aimed enemy's chest for a natural arc.
    const target =
      this.targetEnemy && this.targetEnemy.alive
        ? this.targetEnemy
        : this.softTarget && this.softTarget.alive
          ? this.softTarget
          : null;
    const origin = this.player.position
      .clone()
      .add(new THREE.Vector3(0, 1.35, 0))
      .addScaledVector(dir, 0.6);
    const vel = dir.clone();
    if (target) {
      const chest = target.inst.group.position.clone();
      chest.y += 1.2;
      vel.copy(chest.sub(origin).normalize());
    }
    const isOrb = kind === "orb";
    const params = rangedShot(kind);
    const color = params.color;
    const node = isOrb ? this.makeOrbNode(color) : makeArrowNode(color);
    if (!isOrb) orientAlong(node, vel);
    node.position.copy(origin);
    this.scene.add(node);
    this.playerShots.push({
      node,
      velocity: vel.multiplyScalar(params.speed),
      origin: origin.clone(),
      range: params.range,
      damage: params.damage,
      color,
      kind,
      radius: params.radius,
    });
  }

  private tryAttack(heavy: boolean): void {
    // Pressing during a swing's tail buffers the next strike (combo flow).
    if (this.attackTimer > 0) {
      if (this.attackTimer <= COMBO_CANCEL) {
        this.bufferedAttack = true;
        this.bufferedHeavy = heavy;
      }
      return;
    }
    this.startSwing(heavy);
  }

  /** Begin a swing: advance/reset the light chain, set heavy/air variants. */
  private startSwing(heavy: boolean): void {
    // Bow and staff wielders shoot instead of swinging: LMB is a ranged
    // attack aimed like a cast (lock > soft focus > camera), with the
    // projectile released on the attack animation's timing.
    if (this.playerCategory === "bow") {
      this.startBowShot();
      return;
    }
    if (this.playerCategory === "magic") {
      this.startArcaneCast();
      return;
    }
    // Sword follows mouse: swings go where the reticle points. Aim assist only
    // snaps to a locked target or an enemy actually inside the camera-aim cone
    // — never to an off-screen "nearest" enemy behind the player.
    const aim =
      this.targetEnemy && this.targetEnemy.alive
        ? this.targetEnemy
        : this.softTarget && this.softTarget.alive
          ? this.softTarget
          : null;
    this.swingAim = aim ?? null;
    this.lungeRemain = 0;
    this.swingWarp = resolveWarp(
      this.player.position.x,
      this.player.position.z,
      this.facing,
      aim ? aim.inst.group.position.x : null,
      aim ? aim.inst.group.position.z : null,
      heavy ? HEAVY_WARP : LIGHT_WARP,
    );
    if (aim && this.grounded && this.swingWarp.active) {
      this.facing = this.swingWarp.toYaw;
      this.lungeDir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    } else if (!aim) {
      this.facing = this.camHeading;
      this.swingWarp.active = false;
    }
    const airborne = !this.grounded;
    // Heavy and air strikes stand alone; light strikes advance the 3-step chain.
    if (heavy || airborne) {
      this.comboStep = 0;
    } else {
      this.comboStep = this.comboChainTimer > 0 ? Math.min(this.comboStep + 1, 2) : 0;
    }
    this.comboChainTimer = 0;
    this.attackHeavy = heavy;
    this.attackAir = airborne;
    const profile = weaponCombatProfile(this.playerWeapon);
    this.meleeWindup = profile.windup * (heavy ? 1.15 : 1);
    this.meleeActive = profile.active * (heavy ? 1.1 : 1);
    const recover = profile.recovery * (heavy || airborne ? 1.4 : 1);
    this.attackDur = this.meleeWindup + this.meleeActive + recover;
    this.strikeClip =
      heavy || airborne
        ? "attack3"
        : ((["attack", "attack2", "attack3"] as const)[this.comboStep] ?? "attack");
    // IK-ready stance: with the weapon hand already presented (RMB held or a
    // locked focus), strikes start from optimal placement and land snappier.
    if (this.rightDown || (this.targetEnemy && this.targetEnemy.alive)) {
      this.attackDur *= 0.85;
    }
    this.attackTimer = this.attackDur;
    this.attackActive = true;
    this.attackHitSet.clear();
    this.swingId++;
    if (heavy) this.cameraShake(0.25, 120);
    // Air strike: dive downward for a plunging hit.
    if (airborne) this.velocityY = Math.min(this.velocityY, -7);
  }

  private resolveAttack(): void {
    const heavy = this.attackHeavy;
    const profile = weaponCombatProfile(this.playerWeapon);
    const reach = (heavy ? profile.range * 1.15 : profile.range) + 0.35;
    // Sweep the blade across a short arc over the active window; alternate the
    // arc direction per chain step so a combo reads as distinct strikes.
    const progress = 1 - this.attackTimer / this.attackDur;
    const dirSign = this.comboStep % 2 === 0 ? 1 : -1;
    const ang = this.facing + dirSign * (progress - 0.5) * 1.2;
    const dir = this.tmpV.set(Math.sin(ang), 0, Math.cos(ang));
    let base: THREE.Vector3;
    let tip: THREE.Vector3;
    // Blade-point awareness: if the player wields an attached blade (Lucy /
    // Racalvin / capsule), use the weapon's real world segment so the hitbox
    // tracks the animated blade point, then extend the tip to `reach` so the
    // effective range matches the intended feel.
    const bBase = new THREE.Vector3();
    const bTip = new THREE.Vector3();
    if (this.playerInst && bladeSegmentWorld(this.playerInst, bBase, bTip)) {
      base = bBase.clone();
      const along = bTip.clone().sub(bBase);
      const len = along.length();
      if (len > 1e-3) along.multiplyScalar(1 / len);
      else along.copy(dir);
      tip = base.clone().add(along.multiplyScalar(Math.max(len, reach)));
    } else {
      // Champions wear embedded kit weapons: anchor the collider at the animated
      // hand and sweep along the swing arc, falling back to a chest offset.
      const hand = this.playerInst
        ? attackHandWorld(this.playerInst, this.tmpHand)
        : null;
      base = (
        hand
          ? hand.clone()
          : this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0))
      ).add(dir.clone().multiplyScalar(0.4));
      tip = base.clone().add(dir.clone().multiplyScalar(reach));
    }
    const flatDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e) || this.attackHitSet.has(e)) continue;
      // Broadphase: skip enemies well outside blade range. Measured from the
      // blade base (the animated hand), matching the narrowphase segment origin
      // so a hand displaced from the body root can't reject valid hits.
      if (e.inst.group.position.distanceTo(base) > reach + 1.6) {
        continue;
      }
      let hitPoint: THREE.Vector3 | null = null;
      if (e.hitter) {
        try {
          if (e.hitterSwing !== this.swingId) {
            e.inst.group.updateWorldMatrix(true, true);
            e.hitter.refit();
            e.hitterSwing = this.swingId;
          }
          hitPoint = e.hitter.segmentHit(base, tip);
        } catch {
          hitPoint = null;
        }
      }
      if (!hitPoint) {
        // Fallback: closest point on the blade segment to the enemy center.
        const center = e.inst.group.position.clone().setY(1.0);
        const cp = closestPointOnSegment(base, tip, center);
        if (cp.distanceTo(center) <= ENEMY_RADIUS + 0.55) hitPoint = cp;
      }
      if (!hitPoint) continue;
      this.attackHitSet.add(e);
      const dmg =
        (heavy ? 52 : 22 + this.comboStep * 6) + this.combo * 2;
      const knock = heavy ? 18 : this.attackAir ? 13 : 9;
      // Knockback before damage so a killing blow ragdolls with this impulse.
      this.applyKnockback(e, flatDir, knock);
      this.damageEnemy(e, dmg, this.colorHex(this.factionColor));
      this.spawnImpact(
        hitPoint,
        heavy ? "crit" : "hit",
        this.colorHex(this.factionColor),
        heavy ? 1.6 : 1.1,
      );
      this.cameraShake(heavy ? 0.7 : 0.4, heavy ? 240 : 180);
      // Impact hit-stop: a brief slow-mo frame-freeze on a landed hit makes
      // strikes feel weighty. Everything (physics, animation, timers) shares
      // the scaled dt, so the whole scene freezes together for a beat.
      this.hitStop = Math.max(this.hitStop, heavy ? 0.09 : 0.06);
      this.bumpCombo();
    }
  }

  /** Add decaying knockback to an enemy along a horizontal direction. */
  private applyKnockback(e: Enemy, dir: THREE.Vector3, power: number): void {
    // Bruisers are heavy: they only take half the shove.
    const k = e.archetype === "bruiser" ? 0.5 : 1;
    e.knockback.x += dir.x * power * k;
    e.knockback.z += dir.z * power * k;
  }

  /** Apply damage to an enemy, flash it, spark, and kill if depleted. */
  private damageEnemy(
    e: Enemy,
    dmg: number,
    sparkColor: number,
    buffs?: BuffDef[],
  ): void {
    if (!e.alive) return;
    e.health -= dmg;
    e.hitFlash = 0.18;
    // Bruisers have poise: hits barely stagger them (their telegraphed blow
    // can still be interrupted, but it takes real pressure).
    e.stagger = Math.max(e.stagger, e.archetype === "bruiser" ? 0.12 : 0.35);
    // A landed hit ends a parry stun early ("...or until next hit").
    e.stunTimer = 0;
    this.drawHealthBar(e);
    this.spawnSparks(
      e.inst.group.position.clone().add(new THREE.Vector3(0, 1.5, 0)),
      sparkColor,
    );
    if (buffs) this.applyBuffsToEnemy(e, buffs);
    const mul = catalog.ai?.threat.damageMul ?? 1;
    e.threat.add("player", dmg * mul);
    const assist = catalog.ai?.aggro.assistRadius ?? 30;
    for (const o of this.enemies) {
      if (o === e || !o.alive || o.team !== e.team) continue;
      if (o.inst.group.position.distanceTo(e.inst.group.position) <= assist) {
        o.threat.add("player", dmg * mul * 0.35);
      }
    }
    if (e.health <= 0) this.killEnemy(e);
  }

  /**
   * Apply buff/debuff riders from a skill or cast to a single enemy target.
   * Stacks with existing effects of the same type (refreshes duration if longer).
   */
  private applyBuffsToEnemy(e: Enemy, buffs: BuffDef[]): void {
    for (const b of buffs) {
      if (b.target !== "enemies") continue;
      if (!e.alive) continue;
      const type = b.type;
      // Refresh existing effect if this cast has a longer remaining duration.
      const existing = e.statusEffects.find((s) => s.type === type);
      if (existing) {
        existing.remaining = Math.max(existing.remaining, b.duration);
        existing.magnitude = Math.max(existing.magnitude, b.magnitude);
        continue;
      }
      // Spawn a small floating icon above the enemy.
      const color = STATUS_COLORS[type] ?? 0xffffff;
      const vfx = this.makeVfxSprite("hit", color, 0.7);
      vfx.material.opacity = 0.8;
      vfx.position
        .copy(e.inst.group.position)
        .add(new THREE.Vector3(0, 2.2, 0));
      this.scene.add(vfx);
      const se: StatusEffect = {
        type,
        magnitude: b.magnitude,
        remaining: b.duration,
        dotTimer: 0.5,
        vfx,
      };
      // Stun: immediately extend stunTimer to the effect duration.
      if (type === "stun") {
        e.stunTimer = Math.max(e.stunTimer, b.duration);
      }
      e.statusEffects.push(se);
    }
  }

  /**
   * Apply self-targeted buffs (heal, haste) to the player character.
   * Called immediately when a skill fires (castSkill / castElemental).
   */
  private applyBuffsToSelf(buffs: BuffDef[]): void {
    for (const b of buffs) {
      if (b.target !== "self") continue;
      const type = b.type;
      const existing = this.playerStatusEffects.find((s) => s.type === type);
      if (existing) {
        existing.remaining = Math.max(existing.remaining, b.duration);
        existing.magnitude = Math.max(existing.magnitude, b.magnitude);
        continue;
      }
      this.playerStatusEffects.push({
        type,
        magnitude: b.magnitude,
        remaining: b.duration,
        dotTimer: 0.5,
        vfx: null, // player self-effects have no world VFX
      });
      // Instant heal tick
      if (type === "heal") {
        this.health = Math.min(this.maxHealth, this.health + b.magnitude);
        this.emit();
      }
    }
  }

  /**
   * Effective speed multiplier for an enemy, accounting for active slow effects.
   * Returns a value in [0.1, 1.0].
   */
  private enemySpeedMult(e: Enemy): number {
    let mult = 1;
    for (const se of e.statusEffects) {
      if (se.type === "slow") mult *= Math.max(0.1, 1 - Math.min(0.9, se.magnitude));
    }
    return mult;
  }

  private bumpCombo(): void {
    this.combo++;
    this.comboTimer = 2.5;
    this.emit();
  }

  private killEnemy(e: Enemy): void {
    e.alive = false;
    this.spawnSparks(
      e.inst.group.position.clone().add(new THREE.Vector3(0, 1.5, 0)),
      e.inst.accent,
      26,
    );
    this.spawnCorpse(e);
    if (this.mode === "factions") {
      // Faction War: an ally death never ends the match; victory triggers when
      // every rival (non-team-0) unit is dead.
      if (!e.ally) this.score += 120;
      if (this.phase === "playing" && this.factionVictory()) {
        this.phase = "victory";
        this.setMessage("Your faction stands alone", 3);
        this.exitPointerLock();
      }
      this.emit();
      return;
    }
    if (this.mode !== "waves") {
      // Sandbox: no scoring, no wave progression.
      this.emit();
      return;
    }
    this.score += 100 + this.wave * 25;
    if (this.enemiesAlive() === 0) {
      this.setMessage("Wave cleared", 1.6);
      this.schedule(() => {
        if (!this.disposed && this.phase === "playing") this.spawnWave();
      }, 1400);
    }
    this.emit();
  }

  private damagePlayer(amount: number, attacker?: Enemy): void {
    // Dodge i-frames: ignore the hit entirely.
    if (this.iFrames > 0) {
      this.spawnImpact(this.guardPoint(), "hit", 0xffffff, 0.7);
      return;
    }
    // Timing parry (RMB tap): a hit inside the window is fully negated, clashes,
    // and stuns the attacker.
    if (this.parryTimer > 0) {
      this.parrySuccess(attacker);
      return;
    }
    // Drawn guard: if a guard ribbon lies between the attacker and the player,
    // the area defense absorbs the blow (no damage, no pushback).
    if (attacker && this.guards.length > 0) {
      const aPos = attacker.inst.group.position.clone().setY(1.1);
      const pPos = this.player.position.clone().setY(1.1);
      const blockedAt = this.guardIntercepts(aPos, pPos);
      if (blockedAt) {
        this.spawnImpact(blockedAt, "hit", 0x9fd0ff, 1.2);
        attacker.stagger = Math.max(attacker.stagger, 0.3);
        return;
      }
    }
    // Block (Shift+RMB held): no damage taken — instead the blow shoves the
    // player back (physics pushback) and drains force.
    if (this.blocking) {
      this.force = Math.max(0, this.force - amount * 0.6);
      // Weapon-contact impact: anchor the clash where the guarding blade
      // actually is (mid-blade of the attached weapon) instead of a fixed
      // chest offset, so the block visibly lands on steel.
      this.spawnImpact(this.bladeContactPoint(), "hit", 0x9fd0ff, 1.0);
      this.spawnSparks(this.bladeContactPoint(), 0x9fd0ff, 10);
      if (attacker) {
        const away = this.player.position
          .clone()
          .sub(attacker.inst.group.position)
          .setY(0);
        if (away.lengthSq() > 1e-4) away.normalize();
        else away.copy(this.facingDir()).negate();
        this.pushPlayer(away, BLOCK_PUSHBACK);
        // Route the shove through the dash-bleed path so the accel-to-desired
        // smoothing doesn't immediately wash out the block recoil.
        this.dashTimer = Math.max(this.dashTimer, 0.14);
        attacker.stagger = Math.max(attacker.stagger, 0.4);
      }
      this.cameraShake(0.3, 200);
      this.emit();
      return;
    }
    // Unguarded hit: take full damage and drop the combo.
    this.health -= amount;
    this.combo = 0;
    this.cameraShake(0.7, 220);
    if (this.health <= 0) {
      if (this.mode === "waves" || this.mode === "factions") {
        // Waves / Faction War: the player's death is game over.
        this.health = 0;
        this.phase = "gameover";
        this.exitPointerLock();
        this.clearVfx(); // guards/slash/bullets don't linger over the death screen
      } else {
        // Testing Grounds / Animation Test: no death — top the player back up.
        this.health = this.maxHealth;
      }
    }
    this.emit();
  }

  /** Add a horizontal impulse to the player's velocity (block pushback). */
  private pushPlayer(dir: THREE.Vector3, power: number): void {
    this.velocity.x += dir.x * power;
    this.velocity.z += dir.z * power;
  }

  /** A successful parry: negate damage, reward force, clash + flash, stun. */
  private parrySuccess(attacker?: Enemy): void {
    this.parryTimer = 0;
    this.force = Math.min(this.maxForce, this.force + 14);
    this.setMessage("Parry!", 0.7);
    this.cameraShake(0.6, 240);
    this.spawnClash(this.bladeContactPoint(), 0xfff0a0);
    if (attacker) {
      // Stunned for STUN_TIME, or until the next player hit (see damageEnemy).
      attacker.stunTimer = STUN_TIME;
      attacker.swing = 0;
      this.applyKnockback(attacker, this.facingDir(), 14);
    }
    this.emit();
  }

  /** Bright two-blade clash: white core + tinted flash, ring shock, sparks. */
  private spawnClash(pos: THREE.Vector3, color: number): void {
    this.spawnImpact(pos, "crit", 0xffffff, 2.4);
    this.spawnImpact(pos, "crit", color, 1.7);
    this.spawnSparks(pos, color, 22);
    this.spawnSparks(pos, 0xffffff, 12);
    const obj = new THREE.Group();
    obj.position.copy(pos).setY(0.06);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.5, 40),
      new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    obj.add(ring);
    const flash = this.makeVfxSprite("hit", color, 2.4);
    flash.position.set(0, 0.9, 0);
    obj.add(flash);
    this.scene.add(obj);
    this.novas.push({ obj, ring, flash, radius: 3.2, life: 0.45, maxLife: 0.45 });
  }

  /**
   * Where the guarding weapon meets an incoming blow: the midpoint of the
   * attached blade's real animated segment when available, else the chest-front
   * guard point. Grounds block/parry impacts on the actual steel.
   */
  private bladeContactPoint(): THREE.Vector3 {
    const base = new THREE.Vector3();
    const tip = new THREE.Vector3();
    if (this.playerInst && bladeSegmentWorld(this.playerInst, base, tip)) {
      return base.lerp(tip, 0.55);
    }
    return this.guardPoint();
  }

  /** A point just in front of the player at chest height (clash VFX anchor). */
  private guardPoint(): THREE.Vector3 {
    return this.player.position
      .clone()
      .add(this.facingDir().multiplyScalar(0.9))
      .setY(1.3);
  }

  /** Cast skill at slot index (0 = Q, 1 = E) if ready and affordable. */
  private castSkill(index: number): void {
    if (this.phase !== "playing") return;
    const skill = this.skills[index];
    if (!skill) return;
    if (this.pendingSkill && !this.pendingSkill.resolved) {
      this.setMessage("Already casting", 0.6);
      return;
    }
    if (this.cooldowns[index] > 0) {
      this.setMessage(`${skill.name} cooling down`, 0.8);
      return;
    }
    if (this.force < skill.forceCost) {
      this.setMessage("Not enough force", 0.8);
      return;
    }
    this.force = Math.max(0, this.force - skill.forceCost);
    this.cooldowns[index] = skill.cooldown;

    if ((skill.castT ?? 0) > 0) {
      this.beginSkillCast(skill);
      this.emit();
      return;
    }

    // Play the strike (cast) pose without enabling the melee hit window.
    this.attackTimer = ATTACK_DUR;
    this.attackActive = false;

    if (skill.kind === "projectile") this.spawnProjectile(skill);
    else if (skill.kind === "boomerang") this.spawnBoomerang(skill);
    else if (skill.kind === "dash") this.startSpinDash(skill);
    else this.spawnNova(skill);

    // Apply self-targeted buffs immediately on cast (heal, haste, etc.).
    if (skill.buffs?.length) this.applyBuffsToSelf(skill.buffs);

    this.cameraShake(0.3, 160);
    this.emit();
  }

  /**
   * Timed signature skill (Warcry): HUD cast bar + circle on terrain with the
   * warrior in the middle. If mobility, the same castT is the dash-blur window.
   * Blast + taunt fire when the timer ends.
   */
  private beginSkillCast(skill: SkillDef): void {
    const dur = Math.max(0.2, skill.castT ?? 1);
    this.clearSkillCast();
    this.pendingSkill = {
      skill,
      t: dur,
      dur,
      resolved: false,
      fade: 0,
      root: null,
      mixer: null,
    };
    this.castAnimDur = dur;
    this.castAnimT = dur;
    if (skill.mobility) {
      this.trailTimer = Math.max(this.trailTimer, dur);
    }
    this.setMessage(skill.name, 0.8);
    void this.attachSkillMesh(skill);
  }

  private async attachSkillMesh(skill: SkillDef): Promise<void> {
    const id = skill.meshId;
    if (!id || !this.pendingSkill || this.pendingSkill.skill.id !== skill.id) {
      return;
    }
    const proto = await this.ensureWarcryProto(id);
    if (!proto || !this.pendingSkill || this.pendingSkill.skill.id !== skill.id) {
      return;
    }
    const root = proto.scene.clone(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.depthWrite = false;
        return c;
      });
      mesh.material = cloned.length === 1 ? cloned[0] : cloned;
    });
    const diam = Math.max(2, skill.radius * 2);
    const s = diam / Math.max(proto.extent, 0.25);
    root.scale.setScalar(s);
    const p = this.player.position;
    root.position.set(p.x, this.groundAt(p.x, p.z) + 0.03, p.z);
    this.scene.add(root);
    let mixer: THREE.AnimationMixer | null = null;
    if (proto.clip) {
      mixer = new THREE.AnimationMixer(root);
      const act = mixer.clipAction(proto.clip);
      act.setLoop(THREE.LoopOnce, 1);
      act.clampWhenFinished = true;
      const clipDur = Math.max(0.05, proto.clip.duration);
      act.timeScale = clipDur / Math.max(this.pendingSkill.dur, 0.05);
      act.play();
    }
    this.pendingSkill.root = root;
    this.pendingSkill.mixer = mixer;
  }

  private async ensureWarcryProto(
    meshId: string,
  ): Promise<{ scene: THREE.Object3D; clip: THREE.AnimationClip | null; extent: number } | null> {
    if (this.warcryProto) return this.warcryProto;
    const url = `${import.meta.env.BASE_URL}models/vfx/${meshId}.glb`;
    try {
      const gltf = await new GLTFLoader().loadAsync(url);
      const scene = gltf.scene;
      const clip = gltf.animations[0] ?? null;
      const extent = this.measureClipExtent(scene, clip);
      this.warcryProto = { scene, clip, extent };
      return this.warcryProto;
    } catch (err) {
      console.warn("Warcry VFX failed to load; using ring fallback.", err);
      return null;
    }
  }

  /** Peak XZ footprint of a Sketchfab VFX after its scale-up clip plays. */
  private measureClipExtent(
    scene: THREE.Object3D,
    clip: THREE.AnimationClip | null,
  ): number {
    const root = scene.clone(true);
    if (!clip) {
      root.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
      return Math.max(size.x, size.z, 0.5);
    }
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
    let maxE = 0.5;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      mixer.setTime((clip.duration * i) / steps);
      root.updateMatrixWorld(true);
      const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
      maxE = Math.max(maxE, size.x, size.z);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    return maxE;
  }

  private updateSkillCast(dt: number): void {
    const p = this.pendingSkill;
    if (!p) return;
    p.mixer?.update(dt);
    const pos = this.player.position;
    if (p.root) {
      p.root.position.set(pos.x, this.groundAt(pos.x, pos.z) + 0.03, pos.z);
    }
    if (!p.resolved) {
      p.t -= dt;
      if (p.t <= 0) {
        p.t = 0;
        p.resolved = true;
        p.fade = 0.45;
        this.resolveSkillCast(p.skill);
      }
      return;
    }
    p.fade -= dt;
    const k = THREE.MathUtils.clamp(p.fade / 0.45, 0, 1);
    if (p.root) {
      p.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const mat = m as THREE.Material & { opacity?: number };
          if (typeof mat.opacity === "number") mat.opacity = k;
        }
      });
    }
    if (p.fade <= 0) this.clearSkillCast();
  }

  private resolveSkillCast(skill: SkillDef): void {
    if (skill.kind === "projectile") this.spawnProjectile(skill);
    else if (skill.kind === "boomerang") this.spawnBoomerang(skill);
    else if (skill.kind === "dash") this.startSpinDash(skill);
    else this.spawnNova(skill);
    if (skill.buffs?.length) this.applyBuffsToSelf(skill.buffs);
    if (skill.mobility) this.trailTimer = Math.max(this.trailTimer, 0.35);
    this.cameraShake(0.55, 240);
  }

  private clearSkillCast(): void {
    const p = this.pendingSkill;
    if (!p) return;
    if (p.mixer && p.root) {
      p.mixer.stopAllAction();
      p.mixer.uncacheRoot(p.root);
    }
    if (p.root) {
      this.scene.remove(p.root);
      p.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.dispose();
      });
    }
    this.pendingSkill = null;
  }

  /** Get (and cache) a VFX texture; loads async, never blocks gameplay. */
  private vfxTexture(name: string): THREE.Texture | null {
    const cached = this.vfxTextures.get(name);
    if (cached) return cached;
    const tex = this.vfxLoader.load(
      `https://assets.grudge-studio.com/effects/custom/${name}.png`,
      undefined,
      undefined,
      () => {
        // Texture missing/unreachable: keep the tinted fallback sprite.
      },
    );
    this.vfxTextures.set(name, tex);
    return tex;
  }

  /** Build an additive billboard sprite, tinted, with an optional R2 texture. */
  private makeVfxSprite(name: string, color: number, scale: number): THREE.Sprite {
    const mat = new THREE.SpriteMaterial({
      color,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const tex = this.vfxTexture(name);
    if (tex) mat.map = tex;
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(scale);
    return sprite;
  }

  /** Forward direction (XZ) the player is currently facing. */
  private facingDir(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  private spawnProjectile(skill: SkillDef): void {
    const dir = this.facingDir();
    const origin = this.player.position
      .clone()
      .add(new THREE.Vector3(0, 1.3, 0))
      .add(dir.clone().multiplyScalar(1.2));
    const sprite = this.makeVfxSprite(skill.texture, skill.color, 1.6);
    sprite.position.copy(origin);
    this.scene.add(sprite);
    this.projectiles.push({
      sprite,
      velocity: dir.multiplyScalar(skill.speed),
      origin: origin.clone(),
      def: skill,
    });
  }

  /** Boomerang Blade: a spinning thrown blade that flies out then homes back. */
  private spawnBoomerang(skill: SkillDef): void {
    const dir = this.facingDir();
    const origin = this.player.position
      .clone()
      .add(new THREE.Vector3(0, 1.2, 0))
      .add(dir.clone().multiplyScalar(1.0));
    const sprite = this.makeVfxSprite(skill.texture, skill.color, 1.9);
    sprite.position.copy(origin);
    this.scene.add(sprite);
    this.projectiles.push({
      sprite,
      velocity: dir.multiplyScalar(skill.speed),
      origin: origin.clone(),
      def: skill,
      boomerang: true,
      returning: false,
      hitCd: new Map(),
      age: 0,
    });
  }

  /** Whirlwind Dash: fling forward and open a following damage cyclone. */
  private startSpinDash(skill: SkillDef): void {
    // Tear down any in-flight cyclone so a re-cast can't orphan its visual.
    this.clearSpinDash();
    const dir = this.facingDir();
    // Launch at the skill's speed and hold it constant for the dash (the dash
    // movement branch skips the dodge-roll bleed while a spin is active), plus
    // dodge i-frames so the whirlwind is an offensive gap-closer.
    this.velocity.copy(dir).multiplyScalar(skill.speed);
    const dur = Math.max(0.28, skill.range / Math.max(1, skill.speed));
    this.dashTimer = Math.max(this.dashTimer, dur);
    this.iFrames = Math.max(this.iFrames, dur);
    this.spinTimer = dur + 0.06;
    this.spinDef = skill;
    this.spinHits.clear();
    const obj = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(skill.radius * 0.5, skill.radius, 40),
      new THREE.MeshBasicMaterial({
        color: skill.color,
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    obj.add(ring);
    const blade = this.makeVfxSprite(skill.texture, skill.color, 2.2);
    blade.position.y = 1.1;
    obj.add(blade);
    obj.position.copy(this.player.position).setY(0.06);
    this.scene.add(obj);
    this.spinObj = obj;
    this.spinRing = ring;
    this.cameraShake(0.4, 180);
  }

  /** Tear down the whirlwind-dash cyclone visual and clear its state. */
  private clearSpinDash(): void {
    this.spinTimer = 0;
    this.spinDef = null;
    this.spinHits.clear();
    if (this.spinObj) {
      this.scene.remove(this.spinObj);
      if (this.spinRing) {
        this.spinRing.geometry.dispose();
        (this.spinRing.material as THREE.Material).dispose();
      }
      this.spinObj.traverse((o) => {
        const sp = o as THREE.Sprite;
        if (sp.isSprite) this.disposeSprite(sp);
      });
      this.spinObj = null;
      this.spinRing = null;
    }
  }

  private spawnNova(skill: SkillDef): void {
    const center = this.player.position.clone();
    const now = performance.now() / 1000;
    // Immediate AoE: hit every living foe within the radius right now.
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e)) continue;
      const d = e.inst.group.position.distanceTo(center);
      if (d <= skill.radius) {
        const dir = e.inst.group.position
          .clone()
          .sub(center)
          .setY(0)
          .normalize();
        // Knockback before damage so a killing blow ragdolls with the impulse.
        this.applyKnockback(e, dir, 10);
        this.damageEnemy(e, skill.damage, skill.color, skill.buffs);
        if (skill.taunt) e.threat.taunt("player", now);
      }
    }
    this.cameraShake(0.5, 220);

    const obj = new THREE.Group();
    obj.position.copy(center).setY(0.06);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.6, 40),
      new THREE.MeshBasicMaterial({
        color: skill.color,
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    obj.add(ring);
    const flash = this.makeVfxSprite(skill.impact ?? skill.texture, skill.color, 3);
    flash.position.set(0, 1.2, 0);
    obj.add(flash);
    this.scene.add(obj);
    this.novas.push({ obj, ring, flash, radius: skill.radius, life: 0.6, maxLife: 0.6 });
  }

  /**
   * Force Push (R): a radial force shockwave that hurls every enemy in range
   * back and away from the player. Universal — every character has it.
   */
  /**
   * Cast an elemental line skill (keys 1..3). Ground-line skillshot: aims down
   * the current facing (or at the locked target, clamping range to it) and
   * hands (origin, direction, distance) to the casting system.
   */
  private castElemental(index: number): void {
    if (this.phase !== "playing") return;
    const live = CAST_DEFS[index];
    if (!live) return;
    // Snapshot the def the moment the cast begins so a live Studio edit (which
    // rewrites CAST_DEFS in place) only affects the NEXT cast — never this one
    // while it winds up, travels or resolves. All downstream references
    // (pending aura, releaseCast, CastingSystem effect) use this frozen copy.
    const def = snapshotCastDef(live);
    if (this.castCooldowns[index] > 0) {
      this.setMessage(`${def.name} cooling down`, 0.8);
      return;
    }
    if (this.force < def.cost) {
      this.setMessage("Not enough force", 0.8);
      return;
    }
    // One cast at a time (reference AbilityManager arm/aim/fire flow): a
    // stacked second wind-up would neither restart the cast animation nor own
    // the single aim line, so it is refused before any cost is paid.
    if (this.pendingCasts.length > 0) {
      this.setMessage("Already casting", 0.6);
      return;
    }
    // Orchestrated cast -> release (reference-repo pattern): pay up front, show
    // a building aura, then release the effect after the wind-up. Aim is
    // re-read at release so the mouse steers the cast until the last moment.
    this.force = Math.max(0, this.force - def.cost);
    this.castCooldowns[index] = def.cooldown;
    this.pendingCasts.push({ def, t: def.windup, aura: this.makeCastAura(def) });
    // MOBA linear aim indicator (reference AimController): a ground strip as
    // long as the real cast, steered by the aim until release.
    this.castAimLine ??= new CastAimLine(this.scene, (x, z) => this.groundAt(x, z));
    this.castAimLine.show(def.color);
    // Cast animation window: the dedicated cast clip is time-scaled to span
    // the wind-up plus a short release tail (cast -> release pattern).
    this.castAnimDur = def.windup + 0.35;
    this.castAnimT = this.castAnimDur;
    this.setMessage(def.name, 0.7);
    this.emit();
  }

  /**
   * Resolve the linear aim (reference pattern: targeting lives in the host,
   * effects only receive origin/direction/distance). Hard lock first, then the
   * soft-focus target — either clamps the line to the target; otherwise the
   * full range straight ahead. `commit` also turns the caster to face it.
   */
  private resolveCastAim(
    def: CastDef,
    commit = false,
  ): { dir: THREE.Vector3; distance: number } {
    let dir = this.facingDir();
    let distance = def.range;
    const target =
      this.targetEnemy && this.targetEnemy.alive
        ? this.targetEnemy
        : this.softTarget && this.softTarget.alive
          ? this.softTarget
          : null;
    if (target) {
      const to = target.inst.group.position.clone().sub(this.player.position).setY(0);
      const d = to.length();
      if (d > 0.5) {
        dir = to.normalize();
        // Line skillshots overshoot slightly so the travelling front carries
        // through the target; a zone cast must land EXACTLY on the point the
        // circle telegraphs — no overshoot.
        const overshoot = (def.castShape ?? "line") === "zone" ? 0 : 1.5;
        distance = Math.min(def.range, d + overshoot);
        if (commit) this.facing = Math.atan2(dir.x, dir.z);
      }
    }
    return { dir, distance };
  }

  /** Current cast aim heading: hard lock > soft focus > facing. */
  private castAimYaw(): number {
    const target =
      this.targetEnemy && this.targetEnemy.alive
        ? this.targetEnemy
        : this.softTarget && this.softTarget.alive
          ? this.softTarget
          : null;
    if (target) {
      const to = target.inst.group.position
        .clone()
        .sub(this.player.position);
      if (to.x * to.x + to.z * to.z > 0.25) return Math.atan2(to.x, to.z);
    }
    return this.facing;
  }

  /** Player-following wind-up aura sprite for a pending cast. */
  private makeCastAura(def: CastDef): THREE.Sprite {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(0.4, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c),
        color: def.color,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sprite.scale.set(0.6, 0.6, 0.6);
    sprite.renderOrder = 997;
    sprite.position.copy(this.player.position).y += 1.1;
    this.scene.add(sprite);
    return sprite;
  }

  private disposeCastAura(aura: THREE.Sprite): void {
    const mat = aura.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.scene.remove(aura);
  }

  /**
   * Wind-up timers: the aura rides the caster (follows the player every sim
   * step, growing/brightening over the wind-up), then the cast releases.
   */
  private updatePendingCasts(dt: number): void {
    if (this.castAnimT > 0) this.castAnimT = Math.max(0, this.castAnimT - dt);
    // Steer the aim strip with the live aim while any cast winds up.
    const pending = this.pendingCasts[this.pendingCasts.length - 1];
    if (pending && this.castAimLine) {
      const { dir, distance } = this.resolveCastAim(pending.def);
      const k = THREE.MathUtils.clamp(1 - pending.t / pending.def.windup, 0, 1);
      const shape = pending.def.castShape ?? "line";
      this.castAimLine.set(
        this.player.position,
        dir,
        distance,
        k,
        shape === "zone" ? (pending.def.zoneRadius ?? pending.def.radius) : pending.def.radius,
        pending.def.range,
        shape,
      );
    } else if (!pending) {
      this.castAimLine?.hide();
    }
    for (let i = this.pendingCasts.length - 1; i >= 0; i--) {
      const p = this.pendingCasts[i];
      p.t -= dt;
      const k = THREE.MathUtils.clamp(1 - p.t / p.def.windup, 0, 1);
      p.aura.position.copy(this.player.position).y += 1.1;
      const s = 0.6 + k * 1.6;
      p.aura.scale.set(s, s, s);
      (p.aura.material as THREE.SpriteMaterial).opacity = 0.15 + k * 0.55;
      if (p.t <= 0) {
        this.pendingCasts.splice(i, 1);
        this.disposeCastAura(p.aura);
        this.releaseCast(p.def);
      }
    }
  }

  /** Release phase: aim (lock > soft focus > camera) and launch the effect. */
  private releaseCast(def: CastDef): void {
    if (this.phase !== "playing") return;
    // Store the active cast def so the shared onDamage closure can read its buffs.
    this._activeCastDef = def;
    this.casting ??= new CastingSystem(this.scene, {
      onDamage: (pos, radius, damage, color, knock, dedupe) => {
        const castBuffs = (this._activeCastDef as CastDef | null)?.buffs;
        for (const e of this.enemies) {
          if (!this.isPlayerFoe(e)) continue;
          if (dedupe?.has(e)) continue;
          const d = e.inst.group.position.distanceTo(pos);
          if (d > radius) continue;
          dedupe?.add(e);
          const away = e.inst.group.position.clone().sub(pos).setY(0);
          if (away.lengthSq() > 1e-4) away.normalize();
          else away.copy(this.facingDir());
          // Knockback first so a killing blow ragdolls with the blast impulse.
          this.applyKnockback(e, away, knock);
          this.damageEnemy(e, damage, color, castBuffs);
        }
      },
      onShake: (strength, ms) => this.cameraShake(strength, ms),
      // Trajectory follows the mesh ground, not the flat y=0 plane.
      groundY: (x, z) => this.groundAt(x, z),
      // Billboard the ribbon trails toward the viewer.
      cameraPosition: () => this.camera.position,
    });
    // Apply self-targeted cast buffs immediately on release.
    if (def.buffs?.length) this.applyBuffsToSelf(def.buffs);
    const { dir, distance } = this.resolveCastAim(def, true);
    // Line casts leave from a muzzle point ~1 unit ahead of the body; a zone
    // cast is measured from the player so its landing point matches the
    // telegraphed circle exactly (the telegraph is placed from player.position).
    const zone = (def.castShape ?? "line") === "zone";
    const origin = zone
      ? this.player.position.clone()
      : this.player.position.clone().add(dir.clone().multiplyScalar(1.0));
    this.casting.cast(def, origin, dir, distance);
    this.cameraShake(0.2, 120);
  }

  private forcePush(): void {
    if (this.phase !== "playing") return;
    if (this.pushCooldown > 0) {
      this.setMessage("Force Push cooling down", 0.8);
      return;
    }
    if (this.force < PUSH_COST) {
      this.setMessage("Not enough force", 0.8);
      return;
    }
    this.force = Math.max(0, this.force - PUSH_COST);
    this.pushCooldown = PUSH_CD;
    const center = this.player.position;
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e)) continue;
      const d = e.inst.group.position.distanceTo(center);
      if (d > PUSH_RADIUS) continue;
      const away = e.inst.group.position.clone().sub(center).setY(0);
      if (away.lengthSq() > 1e-4) away.normalize();
      else away.copy(this.facingDir());
      // Closer enemies get launched harder.
      const falloff = 1 - (d / PUSH_RADIUS) * 0.5;
      this.applyKnockback(e, away, PUSH_POWER * falloff);
      e.stagger = Math.max(e.stagger, 0.6);
      e.swing = 0;
    }
    // Expanding shock ring + flash, reusing the nova VFX lifecycle.
    const obj = new THREE.Group();
    obj.position.copy(center).setY(0.06);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.7, 48),
      new THREE.MeshBasicMaterial({
        color: this.colorHex(this.factionColor),
        side: THREE.DoubleSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    obj.add(ring);
    const flash = this.makeVfxSprite("hit", this.colorHex(this.factionColor), 3.4);
    flash.position.set(0, 1.1, 0);
    obj.add(flash);
    this.scene.add(obj);
    this.novas.push({
      obj,
      ring,
      flash,
      radius: PUSH_RADIUS,
      life: 0.55,
      maxLife: 0.55,
    });
    this.cameraShake(0.6, 260);
    this.emit();
  }

  private spawnImpact(pos: THREE.Vector3, name: string, color: number, scale: number): void {
    const sprite = this.makeVfxSprite(name, color, scale);
    sprite.position.copy(pos);
    this.scene.add(sprite);
    this.flashes.push({ sprite, life: 0.3, maxLife: 0.3, grow: scale * 1.6 });
  }

  /** A gunner fires a tracer at the player's chest; resolved in updateVfx. */
  private fireBullet(e: Enemy, targetUnit: Enemy | null = null): void {
    const color = e.factionColor ?? e.inst.accent ?? 0xffb347;
    const origin = e.inst.group.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    const target = this.unitPos(targetUnit)
      .clone()
      .add(new THREE.Vector3(0, 1.1, 0));
    const dir = target.sub(origin).normalize();
    origin.addScaledVector(dir, 0.7);
    let node: THREE.Object3D;
    if (e.shotKind === "arrow") {
      node = makeArrowNode(color);
      orientAlong(node, dir);
    } else if (e.shotKind === "orb") {
      node = this.makeOrbNode(color);
    } else {
      // Gunner tracer keeps its muzzle flash; arrows/orbs release silently at
      // the animation's loose point so nothing pops in ahead of the shot.
      this.spawnImpact(origin.clone(), "hit", color, 0.9);
      node = this.makeVfxSprite("hit", color, 0.7);
    }
    node.position.copy(origin);
    this.scene.add(node);
    this.enemyShots.push({
      node,
      velocity: dir.multiplyScalar(
        e.shotKind === "arrow" ? BULLET_SPEED * 1.25 : BULLET_SPEED,
      ),
      origin: origin.clone(),
      range: BULLET_RANGE,
      damage: 8 + this.wave * 2,
      shooter: e,
      color,
      target: targetUnit,
    });
  }

  /** Glowing magic orb: layered glow sprites so it reads as a sphere. */
  private makeOrbNode(color: number): THREE.Group {
    const g = new THREE.Group();
    const core = this.makeVfxSprite("hit", 0xffffff, 0.45);
    const glow = this.makeVfxSprite("hit", color, 1.0);
    g.add(glow, core);
    return g;
  }

  /**
   * Advance a boomerang: fly straight out to `def.range`, then home back to the
   * player and vanish when caught (or after a safety timeout). It spins fast and
   * can strike each enemy repeatedly on a short per-enemy cooldown, so it hits
   * on both the outbound and return legs.
   */
  private updateBoomerang(p: Projectile, i: number, dt: number): void {
    p.age = (p.age ?? 0) + dt;
    const traveled = p.sprite.position.distanceTo(p.origin);
    if (!p.returning && traveled >= p.def.range) p.returning = true;
    if (p.returning) {
      const playerC = this.player.position
        .clone()
        .add(new THREE.Vector3(0, 1.2, 0));
      const toP = playerC.sub(p.sprite.position);
      const dist = toP.length();
      if (dist < 1.3 || (p.age ?? 0) > 4) {
        this.scene.remove(p.sprite);
        this.disposeSprite(p.sprite);
        this.projectiles.splice(i, 1);
        return;
      }
      const home = toP.multiplyScalar((p.def.speed * 1.2) / Math.max(dist, 1e-3));
      p.velocity.lerp(home, Math.min(1, dt * 6));
    }
    p.sprite.position.addScaledVector(p.velocity, dt);
    p.sprite.material.rotation += dt * 24;
    if (p.hitCd) {
      for (const [e, t] of p.hitCd) {
        const nt = t - dt;
        if (nt <= 0) p.hitCd.delete(e);
        else p.hitCd.set(e, nt);
      }
    }
    for (const e of this.enemies) {
      if (!this.isPlayerFoe(e) || p.hitCd?.has(e)) continue;
      if (
        e.inst.group.position.distanceTo(p.sprite.position) <=
        p.def.radius + 0.6
      ) {
        const dir = p.velocity.clone().setY(0);
        if (dir.lengthSq() > 1e-4) dir.normalize();
        this.applyKnockback(e, dir, 7);
        this.damageEnemy(e, p.def.damage, p.def.color, p.def.buffs);
        this.spawnImpact(
          p.sprite.position.clone(),
          p.def.impact ?? p.def.texture,
          p.def.color,
          p.def.radius,
        );
        p.hitCd?.set(e, 0.4);
      }
    }
  }

  private updateVfx(dt: number): void {
    // Drawn slash sweep + drawn guard ribbons.
    this.updateDrawnSlash(dt);
    this.updateGuards(dt);
    // Projectiles: travel, expire at range, detonate (splash) on enemy contact.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      if (p.boomerang) {
        this.updateBoomerang(p, i, dt);
        continue;
      }
      p.sprite.position.addScaledVector(p.velocity, dt);
      p.sprite.material.rotation += dt * 8;
      const traveled = p.sprite.position.distanceTo(p.origin);
      let hit: THREE.Vector3 | null = null;
      for (const e of this.enemies) {
        if (!this.isPlayerFoe(e)) continue;
        if (e.inst.group.position.distanceTo(p.sprite.position) <= p.def.radius + 0.6) {
          hit = p.sprite.position.clone();
          break;
        }
      }
      if (hit || traveled >= p.def.range) {
        const center = hit ?? p.sprite.position.clone();
        if (hit) {
          for (const e of this.enemies) {
            if (!this.isPlayerFoe(e)) continue;
            if (e.inst.group.position.distanceTo(center) <= p.def.radius) {
              const dir = p.velocity.clone().setY(0).normalize();
              this.applyKnockback(e, dir, 8);
              this.damageEnemy(e, p.def.damage, p.def.color, p.def.buffs);
            }
          }
          this.spawnImpact(
            center.clone().setY(1.2),
            p.def.impact ?? p.def.texture,
            p.def.color,
            p.def.radius * 1.4,
          );
        }
        this.scene.remove(p.sprite);
        this.disposeSprite(p.sprite);
        this.projectiles.splice(i, 1);
      }
    }

    // Whirlwind Dash: sweep damage around the moving player for the dash, hitting
    // each enemy once, and keep the cyclone visual glued to the player.
    if (this.spinTimer > 0 && this.spinDef) {
      this.spinTimer -= dt;
      const def = this.spinDef;
      const center = this.player.position;
      for (const e of this.enemies) {
        if (!this.isPlayerFoe(e) || this.spinHits.has(e)) continue;
        if (e.inst.group.position.distanceTo(center) <= def.radius) {
          const dir = e.inst.group.position.clone().sub(center).setY(0);
          if (dir.lengthSq() > 1e-4) dir.normalize();
          else dir.copy(this.facingDir());
          this.applyKnockback(e, dir, 9);
          this.damageEnemy(e, def.damage, def.color, def.buffs);
          this.spinHits.add(e);
          this.spawnImpact(
            e.inst.group.position.clone().setY(1.1),
            def.impact ?? def.texture,
            def.color,
            1.2,
          );
        }
      }
      if (this.spinObj) {
        this.spinObj.position.copy(center).setY(0.06);
        if (this.spinRing) this.spinRing.rotation.z += dt * 18;
        this.spinObj.scale.setScalar(0.85 + Math.sin(this.spinTimer * 30) * 0.12);
      }
      if (this.spinTimer <= 0) this.clearSpinDash();
    }

    // Enemy bullets: travel toward the player and resolve through damagePlayer,
    // so the existing block/parry/i-frame logic intercepts them automatically.
    for (let i = this.enemyShots.length - 1; i >= 0; i--) {
      const b = this.enemyShots[i];
      // Swept test: check the whole segment travelled this frame against the
      // player's chest sphere so fast bullets cannot tunnel through at low FPS.
      const from = this.tmpV.copy(b.node.position);
      b.node.position.addScaledVector(b.velocity, dt);
      const traveled = b.node.position.distanceTo(b.origin);
      // Resolve against the unit this shot was aimed at (null = the player).
      const aimedAtPlayer = b.target === null;
      const targetDead = b.target !== null && !b.target.alive;
      const chest = this.unitPos(b.target).clone();
      chest.y += 1.1;
      const seg = this.tmpV2.copy(b.node.position).sub(from);
      const segLenSq = seg.lengthSq();
      let t = 0;
      if (segLenSq > 1e-8) {
        t = THREE.MathUtils.clamp(chest.clone().sub(from).dot(seg) / segLenSq, 0, 1);
      }
      const closest = from.clone().addScaledVector(seg, t);
      // Drawn guard ribbons only protect the player; intercept bullets aimed at
      // the player before they can reach them.
      const to = b.node.position;
      const blockedAt = aimedAtPlayer ? this.guardIntercepts(from, to) : null;
      if (blockedAt) {
        this.spawnImpact(blockedAt, "hit", 0x9fd0ff, 1.1);
        this.scene.remove(b.node);
        disposeShotNode(b.node);
        this.enemyShots.splice(i, 1);
        continue;
      }
      const hit = !targetDead && closest.distanceTo(chest) <= 0.9;
      if (hit) {
        if (this.phase === "playing") {
          this.damageUnit(b.target, b.damage, b.shooter);
        }
        this.spawnImpact(b.node.position.clone(), "hit", b.color, 1.0);
      }
      if (hit || traveled >= b.range) {
        this.scene.remove(b.node);
        disposeShotNode(b.node);
        this.enemyShots.splice(i, 1);
      }
    }

    // Player arrows / arcane orbs: swept segment against every living enemy.
    for (let i = this.playerShots.length - 1; i >= 0; i--) {
      const shot = this.playerShots[i];
      const from = this.tmpV.copy(shot.node.position);
      shot.node.position.addScaledVector(shot.velocity, dt);
      if (shot.kind === "orb") {
        // Slow pulse so the orb reads as living magic, not a static sprite.
        const k = 1 + Math.sin(performance.now() / 90) * 0.12;
        shot.node.scale.setScalar(k);
      }
      const traveled = shot.node.position.distanceTo(shot.origin);
      const seg = this.tmpV2.copy(shot.node.position).sub(from);
      const segLenSq = seg.lengthSq();
      let struck: Enemy | null = null;
      for (const e of this.enemies) {
        if (!this.isPlayerFoe(e)) continue;
        const chest = e.inst.group.position.clone();
        chest.y += 1.2;
        let t = 0;
        if (segLenSq > 1e-8) {
          t = THREE.MathUtils.clamp(
            chest.clone().sub(from).dot(seg) / segLenSq,
            0,
            1,
          );
        }
        const closest = from.clone().addScaledVector(seg, t);
        if (closest.distanceTo(chest) <= 0.9) {
          struck = e;
          break;
        }
      }
      if (struck) {
        const dir = shot.velocity.clone().setY(0);
        if (dir.lengthSq() > 1e-4) dir.normalize();
        if (shot.kind === "orb") {
          // Arcane splash: full damage to the struck enemy, falloff around it.
          const orb = rangedShot("orb") as OrbShotParams;
          this.spawnImpact(shot.node.position.clone(), "hit", shot.color, 1.6);
          this.cameraShake(0.12, 90);
          for (const e of this.enemies) {
            if (!this.isPlayerFoe(e)) continue;
            const d = e.inst.group.position.distanceTo(shot.node.position);
            if (d > shot.radius) continue;
            this.applyKnockback(e, e === struck ? dir : e.inst.group.position.clone().sub(shot.node.position).setY(0).normalize(), e === struck ? orb.knock : orb.splashKnock);
            this.damageEnemy(e, e === struck ? shot.damage : shot.damage * 0.5, shot.color);
          }
        } else {
          const arrow = rangedShot("arrow") as ArrowShotParams;
          this.spawnImpact(shot.node.position.clone(), "hit", shot.color, 1.0);
          this.applyKnockback(struck, dir, arrow.knock);
          this.damageEnemy(struck, shot.damage, shot.color);
        }
      }
      if (struck || traveled >= shot.range) {
        this.scene.remove(shot.node);
        disposeShotNode(shot.node);
        this.playerShots.splice(i, 1);
      }
    }

    // Novas: expand the ring and fade.
    for (let i = this.novas.length - 1; i >= 0; i--) {
      const n = this.novas[i];
      n.life -= dt;
      const t = 1 - n.life / n.maxLife;
      const s = 0.4 + t * n.radius;
      n.ring.scale.setScalar(s);
      const mat = n.ring.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, 1 - t);
      n.flash.material.opacity = Math.max(0, 1 - t);
      n.flash.scale.setScalar(3 + t * 2);
      if (n.life <= 0) {
        this.scene.remove(n.obj);
        n.ring.geometry.dispose();
        (n.ring.material as THREE.Material).dispose();
        this.disposeSprite(n.flash);
        this.novas.splice(i, 1);
      }
    }

    // Impact flashes: grow and fade.
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      const t = 1 - f.life / f.maxLife;
      f.sprite.scale.setScalar(f.grow * (0.6 + t));
      f.sprite.material.opacity = Math.max(0, 1 - t);
      if (f.life <= 0) {
        this.scene.remove(f.sprite);
        this.disposeSprite(f.sprite);
        this.flashes.splice(i, 1);
      }
    }

    // Elemental line casts advance their phase machines here.
    this.casting?.update(dt);
    // Snapshot entries (not just values) before iterating so that a
    // disposeEnemy call triggered inside sys.update (e.g. cascade kill via
    // onDamage) cannot cause a skip or double-visit on the live Map iterator.
    // The get(e) === sys check skips any entry that was removed and disposed
    // mid-pass, preventing update() from running on an already-disposed system.
    for (const [e, sys] of [...this.enemyCastSystems]) {
      if (this.enemyCastSystems.get(e) !== sys) continue;
      sys.update(dt);
      // Once a dead caster's system has no active effects or decals left,
      // dispose it and drop the Map entry so it no longer receives update()
      // calls. This prevents long matches from accumulating dozens of spent
      // systems that each burn a full update pass every frame.
      if (!e.alive && sys.isSpent) {
        sys.dispose();
        this.enemyCastSystems.delete(e);
      }
    }

    // Motion-blur trail (Force Jump): drop fading afterimage sprites along the
    // character's recent path while the trail window is open.
    if (this.trailTimer > 0) {
      this.trailTimer -= dt;
      this.trailSpawnT -= dt;
      if (this.trailSpawnT <= 0) {
        this.trailSpawnT = 0.035;
        const s = this.makeVfxSprite(
          "hit",
          this.colorHex(this.factionColor),
          1.9,
        );
        s.material.opacity = 0.55;
        s.position
          .copy(this.player.position)
          .add(new THREE.Vector3(0, 1.1, 0));
        this.scene.add(s);
        this.trail.push({ sprite: s, life: TRAIL_LIFE, maxLife: TRAIL_LIFE });
      }
    }
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const t = this.trail[i];
      t.life -= dt;
      const k = Math.max(0, t.life / t.maxLife);
      t.sprite.material.opacity = 0.55 * k;
      t.sprite.scale.setScalar(1.9 * (0.7 + 0.3 * k));
      if (t.life <= 0) {
        this.scene.remove(t.sprite);
        this.disposeSprite(t.sprite);
        this.trail.splice(i, 1);
      }
    }
  }

  private disposeSprite(sprite: THREE.Sprite): void {
    // Material only — the shared VFX texture is cached and disposed in dispose().
    sprite.material.dispose();
  }

  /** Remove all active VFX (projectiles, novas, flashes) from the scene. */
  private clearVfx(): void {
    for (const p of this.projectiles) {
      this.scene.remove(p.sprite);
      this.disposeSprite(p.sprite);
    }
    this.projectiles = [];
    for (const n of this.novas) {
      this.scene.remove(n.obj);
      n.ring.geometry.dispose();
      (n.ring.material as THREE.Material).dispose();
      this.disposeSprite(n.flash);
    }
    this.novas = [];
    for (const f of this.flashes) {
      this.scene.remove(f.sprite);
      this.disposeSprite(f.sprite);
    }
    this.flashes = [];
    for (const b of this.enemyShots) {
      this.scene.remove(b.node);
      disposeShotNode(b.node);
    }
    this.enemyShots = [];
    for (const shot of this.playerShots) {
      this.scene.remove(shot.node);
      disposeShotNode(shot.node);
    }
    this.playerShots = [];
    this.arcaneCharge = 0;
    this.clearSpinDash();
    this.cancelDraw();
    if (this.slashExec) {
      this.scene.remove(this.slashExec.ribbon);
      this.slashExec.ribbon.geometry.dispose();
      (this.slashExec.ribbon.material as THREE.Material).dispose();
      this.slashExec = null;
    }
    for (const g of this.guards) {
      this.scene.remove(g.mesh);
      g.mesh.geometry.dispose();
      (g.mesh.material as THREE.Material).dispose();
    }
    this.guards = [];
    for (const t of this.trail) {
      this.scene.remove(t.sprite);
      this.disposeSprite(t.sprite);
    }
    this.trail = [];
    this.trailTimer = 0;
    this.trailSpawnT = 0;
  }

  private spawnSparks(pos: THREE.Vector3, color: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 6, 6),
        new THREE.MeshBasicMaterial({ color }),
      );
      mesh.position.copy(pos);
      const vel = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(3 + Math.random() * 5);
      vel.y = Math.abs(vel.y) + 2;
      this.scene.add(mesh);
      this.sparks.push({
        mesh,
        velocity: vel,
        life: 0,
        maxLife: 0.5 + Math.random() * 0.3,
      });
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    let dt = Math.min(this.clock.getDelta(), 0.05);
    // Hit-stop: drain the freeze off real time, but feed the rest of the frame a
    // heavily-slowed dt so the whole scene briefly hangs on impact.
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.1;
    }

    // Guard the whole update so a physics/BVH (or any gameplay) error can never
    // stop the render below -- the loop keeps drawing and degrades to math.
    try {
      if (this.phase === "playing") {
        // Deterministic combat ticker: mixer + hits + AI on COMBAT_DT only.
        const steps = this.ticker.steps(dt);
        this.simAccum = this.ticker.accum;
        for (let i = 0; i < steps; i++) {
          this.stepPhysics();
          this.updatePlayer(COMBAT_DT);
          this.updateGrapple(COMBAT_DT);
          this.updateCombat(COMBAT_DT);
          this.updateEnemies(COMBAT_DT);
          this.updateTimers(COMBAT_DT);
          this.updateAnimTest(COMBAT_DT);
          this.updatePendingCasts(COMBAT_DT);
          this.updateSkillCast(COMBAT_DT);
          this.telegraphs?.update(COMBAT_DT);
          this.updateVfx(COMBAT_DT);
          this.updatePlayerAnim(COMBAT_DT);
          this.hudAccum += COMBAT_DT;
        }
        // Smooth force/cooldown bars without emitting every frame.
        if (this.hudAccum >= 0.1) {
          this.hudAccum = 0;
          this.emit();
        }
      }
      this.updateSoftFocus(dt);
      // Corpses keep tumbling/settling even on game-over and victory screens,
      // so bodies never freeze mid-air and always finish their cleanup timer.
      this.updateCorpses(dt);
      this.updateSparks(dt);

      this.updateCamera(dt);

      let hasDead = false;
      for (const e of this.enemies) {
        if (e.alive) e.bar.quaternion.copy(this.camera.quaternion);
        else hasDead = true;
      }
      // Compact out dead enemies so an endless sandbox session does not grow
      // this array without bound. Note: killEnemy does NOT call disposeEnemy;
      // disposeEnemy is called explicitly (e.g. resetRun, dispose) or deferred
      // to wave cleanup. Spent caster systems are cleaned up in updateCombat.
      if (hasDead) this.enemies = this.enemies.filter((e) => e.alive);
      // Lock-on marker tracks the focused target (and drops it if it died).
      this.updateTargetMarker();
      // Crosshair follows the animated weapon point while a swing is active.
      this.updateAimCrosshair();
    } catch (err) {
      this.disablePhysics(err);
      this.disableWorldBvh(err);
    }

    this.renderer.render(this.scene, this.camera);
  };

  /**
   * While a swing is active, project the weapon's world tip (real blade point
   * for attached blades, animated hand for embedded-kit champions) into screen
   * space and report it so the HUD crosshair rides the swing. Reports the
   * centered/inactive state exactly once when the swing ends.
   */
  /**
   * Sword follows mouse: the crosshair IS the aim point, so it stays fixed at
   * screen center (where the mouse steers the camera) and only pulses while a
   * swing is active. The blade is driven toward the reticle, never the
   * reticle toward the blade.
   */
  private updateAimCrosshair(): void {
    const cb = this.onAim;
    if (!cb) return;
    const swinging =
      this.phase === "playing" && this.attackTimer > 0 && !!this.playerInst;
    if (swinging !== this.aimActive) {
      this.aimActive = swinging;
      cb(0.5, 0.5, swinging);
    }
  }

  /**
   * Third-person orbit follow camera. Positions the camera behind/above the
   * player along the current yaw/pitch, pulls it in when an arena wall would
   * occlude it, smoothly chases the target, and looks at the player's upper
   * body so the view always frames what the character is aiming at.
   */
  private updateCamera(dt: number): void {
    const MIN_P = 0.05;
    const MAX_P = 1.25;
    if (this.camPitch < MIN_P) this.camPitch = MIN_P;
    if (this.camPitch > MAX_P) this.camPitch = MAX_P;

    const cosP = Math.cos(this.camPitch);
    const sinP = Math.sin(this.camPitch);
    // Horizontal forward the character/camera looks along (matches camHeading).
    const fwdX = Math.sin(this.camYaw);
    const fwdZ = Math.cos(this.camYaw);

    // Point the camera frames: the player's upper body.
    const target = this.camTmpTarget.set(
      this.player.position.x,
      this.player.position.y + 2.0,
      this.player.position.z,
    );

    // Direction from the target back to the camera (behind + above).
    const dir = this.camTmpDir
      .set(-fwdX * cosP, sinP, -fwdZ * cosP)
      .normalize();

    // Keep the camera from clipping through pillars / boundary wall.
    let dist = this.camDist;
    this.camRay.set(target, dir);
    this.camRay.far = this.camDist;
    const hits = this.camRay.intersectObjects(this.camOccluders, true);
    if (hits.length && hits[0].distance < dist) {
      dist = Math.max(1.6, hits[0].distance - 0.4);
    }

    const desired = this.camTmpDesired.set(
      target.x + dir.x * dist,
      target.y + dir.y * dist,
      target.z + dir.z * dist,
    );
    if (desired.y < 0.6) desired.y = 0.6;

    // Smooth, frame-rate-independent follow.
    this.camera.position.lerp(desired, 1 - Math.exp(-9 * dt));

    // Decaying impact feedback: smooth dual-sine sway instead of per-frame
    // random jitter, so hits read as a thump — never a shaky, noisy camera.
    if (this.camShakeT > 0) {
      this.camShakeT -= dt;
      const k = this.camShakeDur > 0 ? Math.max(0, this.camShakeT / this.camShakeDur) : 0;
      const amp = this.camShakeAmp * k * k;
      const t = (this.camShakeDur - this.camShakeT) * 34;
      this.camera.position.x += Math.sin(t) * amp;
      this.camera.position.y += Math.sin(t * 1.7 + 1.3) * amp * 0.6;
    }

    this.camera.lookAt(target);
  }

  /** Trigger a decaying camera shake (amp in world units, dur in ms). */
  private cameraShake(amp: number, ms: number): void {
    const scaled = amp * 0.4;
    if (scaled >= this.camShakeAmp || this.camShakeT <= 0) {
      this.camShakeAmp = scaled;
      this.camShakeDur = ms / 1000;
      this.camShakeT = this.camShakeDur;
    }
  }

  private updatePlayer(dt: number): void {
    // Block: Ctrl is the dedicated auto-guard hotkey (the weapon hand snaps to
    // a defensive pose); Shift+RMB still works as the classic held block.
    this.blocking =
      (this.keys.ControlLeft ||
        this.keys.ControlRight ||
        (this.rightDown &&
          (this.keys.ShiftLeft || this.keys.ShiftRight))) &&
      this.force > 0;
    // Perfect-guard parry: the instant a block is engaged, open a brief parry
    // window. A hit landing inside it is fully negated + stuns the attacker
    // (damagePlayer resolves parry before block); hold the guard past the window
    // and it resolves as a normal damage-absorbing block. One parry per press.
    if (this.blocking && !this.prevBlocking) this.parryTimer = PARRY_WINDOW;
    this.prevBlocking = this.blocking;
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.iFrames > 0) this.iFrames -= dt;
    if (this.parryTimer > 0) this.parryTimer -= dt;
    if (this.pushCooldown > 0) this.pushCooldown -= dt;
    for (let i = 0; i < this.castCooldowns.length; i++) {
      if (this.castCooldowns[i] > 0) this.castCooldowns[i] -= dt;
    }

    // Camera-relative basis. forward = camera -> player (into the screen).
    const camForward = this.tmpV
      .set(
        this.player.position.x - this.camera.position.x,
        0,
        this.player.position.z - this.camera.position.z,
      )
      .normalize();
    // right = forward x up  (correct left/right strafing).
    const camRight = this.tmpV2
      .set(-camForward.z, 0, camForward.x)
      .normalize();
    // Capture the camera heading now (camForward aliases a scratch vector that is
    // reused below); animtest uses it to keep the body strafe-locked.
    const camHeading = Math.atan2(camForward.x, camForward.z);
    this.camHeading = camHeading;

    const move = new THREE.Vector3();
    if (this.keys["KeyW"]) move.add(camForward);
    if (this.keys["KeyS"]) move.sub(camForward);
    if (this.keys["KeyD"]) move.add(camRight);
    if (this.keys["KeyA"]) move.sub(camRight);
    const hasInput = move.lengthSq() > 0;
    if (hasInput) move.normalize();

    // Dash: double-tap a direction for a force burst. Allowed on the ground, or
    // once in the air (jump dash) — air dashes neutralize the fall for a blink.
    const canDash =
      this.dashRequested &&
      this.dashCooldown <= 0 &&
      this.force >= DASH_COST &&
      (this.grounded || !this.airDashUsed);
    if (canDash) {
      const dir = hasInput
        ? move.clone()
        : new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing));
      this.velocity.copy(dir).multiplyScalar(DASH_SPEED);
      this.dashTimer = DASH_TIME;
      this.dashCooldown = 0.5;
      // Dodge-roll grants brief invulnerability.
      this.iFrames = DODGE_IFRAMES;
      this.force = Math.max(0, this.force - DASH_COST);
      this.facing = Math.atan2(dir.x, dir.z);
      this.cameraShake(0.35, 140);
      if (!this.grounded) {
        this.airDashUsed = true;
        this.velocityY = 0;
      }
      this.spawnSparks(
        this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0)),
        this.colorHex(this.factionColor),
        10,
      );
    }
    this.dashRequested = false;

    const sprint = this.keys["ShiftLeft"] || this.keys["ShiftRight"];
    const targetSpeed = this.blocking
      ? GUARD_SPEED
      : sprint
        ? SPRINT_SPEED
        : WALK_SPEED;

    // Motion warp (Samurai TPS): turn first, then close to standoff inside
    // the swing. Destination locked at press — no per-frame skate-home.
    if (this.attackTimer > 0 && this.swingWarp?.active && this.dashTimer <= 0) {
      const dur = Math.max(1e-3, this.attackDur);
      const phase = 1 - this.attackTimer / dur;
      advanceWarp(this.swingWarp, phase);
      const wx = this.swingWarp.x - this.player.position.x;
      const wz = this.swingWarp.z - this.player.position.z;
      if (dt > 1e-5) {
        this.velocity.x = wx / dt;
        this.velocity.z = wz / dt;
      }
      this.facing = this.swingWarp.yaw;
    } else if (this.attackTimer <= 0 && this.swingWarp) {
      this.swingWarp.active = false;
    }

    if (this.dashTimer > 0) {
      this.dashTimer -= dt;
      if (this.spinTimer > 0 && this.spinDef) {
        // Whirlwind Dash travels at near-constant speed so its integrated
        // displacement matches skill.range; the dodge-roll's exponential bleed
        // below would fall well short of the configured dash distance.
      } else {
        // Dodge-roll dash: keep the burst velocity and bleed it off quickly.
        this.velocity.multiplyScalar(1 - Math.min(1, dt * 6));
      }
    } else {
      // Accelerate toward the desired velocity for a fluid, momentum feel.
      const desired = move.multiplyScalar(targetSpeed);
      const accel = hasInput ? 18 : 14;
      this.velocity.x += (desired.x - this.velocity.x) * Math.min(1, dt * accel);
      this.velocity.z += (desired.z - this.velocity.z) * Math.min(1, dt * accel);
    }

    // Horizontal: collide-and-slide through the physics controller, or direct.
    const dx = this.velocity.x * dt;
    const dz = this.velocity.z * dt;
    const m = this.moveBody(
      this.playerBody,
      this.player.position.x,
      this.player.position.y,
      this.player.position.z,
      dx,
      dz,
      PLAYER_RADIUS,
      PLAYER_HEIGHT,
    );
    this.player.position.x = m.x;
    this.player.position.z = m.z;

    // Turn-to-face / lock-on facing (survival controller). The Weapon Skill
    // Studio (animtest) shares this exact behavior so edited skills read the
    // same as in the live game.
    if (this.attackTimer > 0 && this.swingWarp?.active) {
      // Blade IK: facing is the warp yaw (clip assumed this heading at hitAt).
    } else if (this.targetEnemy && this.targetEnemy.alive) {
      // Lock-on: square up to the focused target only inside fighting range
      // (or while standing still). When the target is far away and the player
      // is running, face the run direction — otherwise the character reads as
      // permanently running sideways toward a distant lock.
      const tp = this.targetEnemy.inst.group.position;
      const far =
        Math.hypot(
          tp.x - this.player.position.x,
          tp.z - this.player.position.z,
        ) > 10;
      if (far && this.velocity.lengthSq() > 0.5) {
        this.facing = Math.atan2(this.velocity.x, this.velocity.z);
      } else {
        this.facing = Math.atan2(
          tp.x - this.player.position.x,
          tp.z - this.player.position.z,
        );
      }
    } else if (this.blocking) {
      // Guard turn-to-contact: square the weapon up to the nearest threat so
      // the auto-guard hand meets the incoming blow.
      const threat = this.nearestEnemyForAttack();
      if (threat) {
        const tp = threat.inst.group.position;
        if (tp.distanceTo(this.player.position) < 8) {
          this.facing = Math.atan2(
            tp.x - this.player.position.x,
            tp.z - this.player.position.z,
          );
        }
      }
    } else if (this.rightDown) {
      // IK-ready stance (RMB held): strafe-lock to the camera heading so the
      // weapon hand stays presented and A/D read as true strafes.
      this.facing = camHeading;
    } else if (this.velocity.lengthSq() > 0.5) {
      this.facing = Math.atan2(this.velocity.x, this.velocity.z);
    }
    {
      let diff = this.facing - this.player.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.player.rotation.y += diff * Math.min(1, dt * 14);
    }

    // Arena boundary is now real wall geometry (see buildArena): moveBody's
    // Rapier + world-BVH wall constraint keeps the player inside the ring, so no
    // hand-rolled radius clamp is needed here.

    // Vertical: gravity + jump, grounded against the mesh-accurate floor BVH.
    if (this.keys["Space"] && this.grounded) {
      this.velocityY = 10;
      this.grounded = false;
    } else if (this.forceJumpRequested) {
      // Force Jump: a second Space press mid-air spends force for another leap
      // and leaves a motion-blur afterimage trail.
      if (!this.grounded && !this.doubleJumpUsed && this.force >= FJUMP_COST) {
        this.velocityY = FJUMP_VEL;
        this.doubleJumpUsed = true;
        this.force = Math.max(0, this.force - FJUMP_COST);
        this.trailTimer = 0.55;
        this.iFrames = Math.max(this.iFrames, 0.15);
        this.cameraShake(0.25, 120);
        this.spawnSparks(
          this.player.position.clone().add(new THREE.Vector3(0, 0.6, 0)),
          this.colorHex(this.factionColor),
          14,
        );
      } else if (!this.grounded && !this.doubleJumpUsed) {
        this.setMessage("Not enough force", 0.8);
      }
      this.forceJumpRequested = false;
    }
    this.velocityY -= 28 * dt;
    this.player.position.y += this.velocityY * dt;
    this.groundY = this.groundAt(
      this.player.position.x,
      this.player.position.z,
    );
    if (this.player.position.y <= this.groundY) {
      this.player.position.y = this.groundY;
      this.velocityY = 0;
      this.grounded = true;
      this.airDashUsed = false;
      this.doubleJumpUsed = false;
      this.forceJumpRequested = false;
    }

    if (!this.blocking) {
      this.force = Math.min(this.maxForce, this.force + 14 * dt);
    }

    // Tick self-targeted weapon-skill status effects (heal, haste, etc.).
    let hasteBonus = 0;
    for (let si = this.playerStatusEffects.length - 1; si >= 0; si--) {
      const se = this.playerStatusEffects[si];
      se.remaining -= dt;
      if (se.type === "heal") {
        se.dotTimer -= dt;
        if (se.dotTimer <= 0) {
          se.dotTimer = 0.5;
          this.health = Math.min(this.maxHealth, this.health + se.magnitude * 0.5);
          this.emit();
        }
      }
      if (se.type === "haste") {
        hasteBonus = Math.max(hasteBonus, se.magnitude);
      }
      if (se.remaining <= 0) {
        this.playerStatusEffects.splice(si, 1);
      }
    }
    // Apply haste bonus to this frame's velocity. The velocity vector is already
    // computed by the time we reach here, so scale it up if haste is active.
    if (hasteBonus > 0 && this.velocity.lengthSq() > 0.01) {
      const boost = 1 + Math.min(1, hasteBonus);
      this.velocity.multiplyScalar(boost);
    }

    // Holding LMB past the threshold starts a drawn slash — the stroke you
    // trace becomes the sword's path on release. A short hold still auto-swings.
    if (this.mouseDown && this.drawMode === "none") {
      const held =
        this.lmbDownAt >= 0
          ? performance.now() / 1000 - this.lmbDownAt
          : 0;
      // The Weapon Skill Studio (animtest) uses the real survival controller
      // for attacks/casts, but skips the drawn-slash gesture (no draw stroke
      // overlay) so LMB is a plain swing there.
      if (held >= DRAW_HOLD_T && this.mode !== "animtest") this.beginDraw("slash");
      else if (this.attackTimer <= 0) {
        this.tryAttack(this.keys["ShiftLeft"] || this.keys["ShiftRight"]);
      }
    }
  }

  private beginDraw(mode: "slash" | "guard"): void {
    if (this.phase !== "playing" || this.drawMode !== "none") return;
    // One attempt per press, so an out-of-force hold doesn't spam the message.
    if (this.drawTried) return;
    this.drawTried = true;
    const cost = mode === "slash" ? SLASH_COST : GUARD_COST;
    if (this.force < cost) {
      this.setMessage("Not enough force", 0.8);
      return;
    }
    // Drawing supersedes the ordinary swing: cancel the in-flight attack and
    // any buffered follow-ups so the gesture is a clean alternative input,
    // not a layer on top of the combo system.
    this.attackTimer = 0;
    this.attackActive = false;
    this.bufferedAttack = false;
    this.bufferedHeavy = false;
    this.comboStep = 0;
    this.comboChainTimer = 0;
    this.drawMode = mode;
    this.drawPts = [{ x: 0.5, y: 0.5 }];
    this.drawInk = 0;
    this.emitDraw();
  }

  /** Feed pointer-lock mouse deltas into the gesture cursor (limited ink). */
  private extendDraw(dx: number, dy: number): void {
    const maxInk =
      this.drawMode === "slash" ? DRAW_INK_SLASH : DRAW_INK_GUARD;
    if (this.drawInk >= maxInk) return;
    const last = this.drawPts[this.drawPts.length - 1];
    const nx = THREE.MathUtils.clamp(last.x + dx * DRAW_SENS, 0.03, 0.97);
    const ny = THREE.MathUtils.clamp(last.y + dy * DRAW_SENS, 0.03, 0.97);
    const step = Math.hypot(nx - last.x, ny - last.y);
    if (step < 0.008) return;
    const allowed = Math.min(step, maxInk - this.drawInk);
    const k = allowed / step;
    this.drawPts.push({
      x: last.x + (nx - last.x) * k,
      y: last.y + (ny - last.y) * k,
    });
    this.drawInk += allowed;
    this.emitDraw();
  }

  private emitDraw(): void {
    if (!this.onDraw || this.drawMode === "none") return;
    const flat: number[] = [];
    for (const p of this.drawPts) flat.push(p.x, p.y);
    this.onDraw(flat, this.drawMode);
  }

  /** Cancel an in-progress gesture without executing it. */
  private cancelDraw(): void {
    if (this.drawMode === "none") return;
    const mode = this.drawMode;
    this.drawMode = "none";
    this.drawPts = [];
    this.onDraw?.(null, mode);
  }

  /** Release: turn the drawn screen path into a world path and execute it. */
  private finishDraw(): void {
    const mode = this.drawMode;
    if (mode === "none") return;
    const pts = this.drawPts;
    this.drawMode = "none";
    this.drawPts = [];
    this.onDraw?.(null, mode);
    if (this.phase !== "playing" || this.drawInk < DRAW_MIN_LEN || pts.length < 2)
      return;
    const cost = mode === "slash" ? SLASH_COST : GUARD_COST;
    if (this.force < cost) {
      this.setMessage("Not enough force", 0.8);
      return;
    }
    this.force -= cost;
    // Project each screen point onto a curtain at sword reach in front of the
    // camera, so the drawn stroke becomes a world-space path near the player.
    const ray = new THREE.Raycaster();
    const dist =
      this.camera.position.distanceTo(this.player.position) + 2.4;
    const world: THREE.Vector3[] = [];
    for (const p of pts) {
      ray.setFromCamera(
        new THREE.Vector2(p.x * 2 - 1, -(p.y * 2 - 1)),
        this.camera,
      );
      const w = ray.ray.at(dist, new THREE.Vector3());
      // Keep the path above the floor so ground strokes stay usable.
      const floor = this.groundAt(w.x, w.z);
      w.y = Math.max(w.y, floor + 0.25);
      world.push(w);
    }
    if (mode === "slash") this.executeDrawnSlash(world);
    else this.placeGuard(world);
    this.emit();
  }

  /** The sword sweeps the drawn world path over SLASH_EXEC_T seconds. */
  private executeDrawnSlash(world: THREE.Vector3[]): void {
    const geo = new THREE.BufferGeometry().setFromPoints(world);
    const mat = new THREE.LineBasicMaterial({
      color: this.colorHex(this.factionColor),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ribbon = new THREE.Line(geo, mat);
    ribbon.renderOrder = 900;
    this.scene.add(ribbon);
    this.slashExec = {
      pts: world,
      t: 0,
      dur: SLASH_EXEC_T,
      hit: new Set(),
      ribbon,
      fade: 0.45,
    };
    // Drive the attack animation so the character visibly swings with the path.
    if (this.playerInst) this.playerInst.prevStrike = false;
    this.attackDur = Math.max(SLASH_EXEC_T, 0.3);
    this.attackTimer = this.attackDur;
    this.attackActive = false; // damage comes from the path sweep, not resolveAttack
    this.cameraShake(0.3, 160);
  }

  /** Advance an executing drawn slash: damage enemies near the swept span. */
  private updateDrawnSlash(dt: number): void {
    const s = this.slashExec;
    if (!s) return;
    if (s.t < s.dur) {
      const u0 = s.t / s.dur;
      s.t = Math.min(s.dur, s.t + dt);
      const u1 = s.t / s.dur;
      const n = s.pts.length;
      const i0 = Math.max(0, Math.floor(u0 * (n - 1)));
      const i1 = Math.min(n - 1, Math.ceil(u1 * (n - 1)));
      const chest = this.player.position.clone();
      chest.y += 1.1;
      for (const e of this.enemies) {
        if (!this.isPlayerFoe(e) || s.hit.has(e)) continue;
        const center = e.inst.group.position.clone().setY(1.0);
        for (let i = i0; i <= i1; i++) {
          const p = s.pts[i];
          // The blade extends from the player toward the path point: test the
          // enemy against that segment so bodies between also get carved.
          const cp = closestPointOnSegment(chest, p, center);
          if (cp.distanceTo(center) <= ENEMY_RADIUS + 0.6) {
            s.hit.add(e);
            const dir = center.clone().sub(chest).setY(0).normalize();
            this.applyKnockback(e, dir, 11);
            this.damageEnemy(e, SLASH_DMG + this.combo * 2, this.colorHex(this.factionColor));
            this.spawnImpact(cp, "hit", this.colorHex(this.factionColor), 1.2);
            break;
          }
        }
      }
    } else {
      // Sweep done: fade the ribbon out, then dispose it.
      s.fade -= dt;
      const mat = s.ribbon.material as THREE.LineBasicMaterial;
      mat.opacity = Math.max(0, (s.fade / 0.45) * 0.95);
      if (s.fade <= 0) {
        this.scene.remove(s.ribbon);
        s.ribbon.geometry.dispose();
        mat.dispose();
        this.slashExec = null;
      }
    }
  }

  /** Build a translucent vertical ribbon along the drawn path that guards. */
  private placeGuard(world: THREE.Vector3[]): void {
    const n = world.length;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const p = world[i];
      pos[i * 6 + 0] = p.x;
      pos[i * 6 + 1] = p.y + GUARD_HALF_H;
      pos[i * 6 + 2] = p.z;
      pos[i * 6 + 3] = p.x;
      pos[i * 6 + 4] = p.y - GUARD_HALF_H;
      pos[i * 6 + 5] = p.z;
    }
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fd0ff,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 890;
    this.scene.add(mesh);
    this.guards.push({ pts: world, life: GUARD_LIFE, mesh });
    this.setMessage("Guard raised", 0.7);
  }

  /** Fade and expire drawn guard ribbons. */
  private updateGuards(dt: number): void {
    for (let i = this.guards.length - 1; i >= 0; i--) {
      const g = this.guards[i];
      g.life -= dt;
      const mat = g.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.32 * Math.min(1, g.life / 0.8);
      if (g.life <= 0) {
        this.scene.remove(g.mesh);
        g.mesh.geometry.dispose();
        mat.dispose();
        this.guards.splice(i, 1);
      }
    }
  }

  /**
   * Does any drawn guard ribbon intersect the segment a->b? Each ribbon span
   * (consecutive path points) is sampled at <=0.25-world-unit steps so fast
   * strokes with widely spaced vertices leave no gaps in the defense, and the
   * test capsule matches the rendered ribbon height.
   */
  private guardIntercepts(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
    const sample = this.tmpV3;
    for (const g of this.guards) {
      for (let i = 0; i < g.pts.length - 1; i++) {
        const p0 = g.pts[i];
        const p1 = g.pts[i + 1];
        const segLen = p0.distanceTo(p1);
        const steps = Math.max(1, Math.ceil(segLen / 0.25));
        for (let s = 0; s <= steps; s++) {
          sample.copy(p0).lerp(p1, s / steps);
          const cp = closestPointOnSegment(a, b, sample);
          const dy = Math.abs(cp.y - sample.y);
          const dxz = Math.hypot(cp.x - sample.x, cp.z - sample.z);
          if (dxz <= GUARD_BLOCK_R && dy <= GUARD_HALF_H + 0.2) {
            return cp.clone();
          }
        }
      }
    }
    return null;
  }

  private updateCombat(dt: number): void {
    if (this.arcaneCharge > 0) {
      this.arcaneCharge -= dt;
      if (this.arcaneCharge <= 0) {
        this.arcaneCharge = 0;
        this.pendingShot = null;
        if (this.phase === "playing") this.firePlayerShot("orb");
      }
    }
    if (this.attackTimer > 0) {
      this.attackTimer -= dt;
      const elapsed = this.attackDur - this.attackTimer;
      if (
        this.attackActive &&
        elapsed >= this.meleeWindup &&
        elapsed <= this.meleeWindup + this.meleeActive
      ) {
        this.resolveAttack();
      }
      if (this.attackTimer <= 0) {
        this.attackActive = false;
        if (this.pendingShot === "arrow") {
          this.pendingShot = null;
          if (this.phase === "playing") this.firePlayerShot("arrow");
        }
        // Open the chain-continue window and fire any buffered next strike.
        this.comboChainTimer = COMBO_CHAIN_WINDOW;
        if (this.bufferedAttack) {
          this.bufferedAttack = false;
          this.startSwing(this.bufferedHeavy);
        }
      }
    } else if (this.comboChainTimer > 0) {
      this.comboChainTimer -= dt;
      if (this.comboChainTimer <= 0) this.comboStep = 0;
    }
  }

  private updateEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.hitFlash > 0) e.hitFlash -= dt;
      if (e.stagger > 0) e.stagger -= dt;
      if (e.stunTimer > 0) e.stunTimer -= dt;
      if (e.swing > 0) e.swing -= dt;
      if (e.healCast > 0) e.healCast -= dt;
      if (e.healCooldown > 0) e.healCooldown -= dt;

      // Tick weapon-skill status effects (slow, burn, poison, stun, etc.).
      for (let si = e.statusEffects.length - 1; si >= 0; si--) {
        const se = e.statusEffects[si];
        se.remaining -= dt;
        // DoT types: burn and poison tick every 0.5 s.
        if (se.type === "burn" || se.type === "poison") {
          se.dotTimer -= dt;
          if (se.dotTimer <= 0) {
            se.dotTimer = 0.5;
            if (e.alive) this.damageEnemy(e, se.magnitude * 0.5, STATUS_COLORS[se.type] ?? 0xff5500);
          }
        }
        // Stun: keep the stun timer alive for the effect's remaining duration.
        if (se.type === "stun" && se.remaining > 0) {
          e.stunTimer = Math.max(e.stunTimer, Math.min(se.remaining, 0.1));
        }
        // Float VFX above the target.
        if (se.vfx) {
          se.vfx.position.copy(e.inst.group.position).add(new THREE.Vector3(0, 2.2, 0));
          (se.vfx.material as THREE.SpriteMaterial).opacity =
            0.75 * Math.min(1, se.remaining * 4);
        }
        if (se.remaining <= 0) {
          if (se.vfx) {
            this.scene.remove(se.vfx);
            this.disposeSprite(se.vfx);
          }
          e.statusEffects.splice(si, 1);
        }
      }
      // Support healers: pulse an AoE heal to nearby same-team allies when the
      // healer or a wounded ally in range drops below the trigger threshold.
      // Interrupted by stagger/stun (shares the same plant window as casts).
      if (
        e.healer &&
        e.healCooldown <= 0 &&
        e.healCast <= 0 &&
        e.stagger <= 0 &&
        e.stunTimer <= 0 &&
        !e.pendingCast &&
        this.shouldHeal(e)
      ) {
        this.pulseHeal(e);
      }
      // A healer plants while its pulse resolves (counts as "frozen" for AI).
      const frozen = e.stagger > 0 || e.stunTimer > 0 || e.healCast > 0;
      if (e.knockback.lengthSq() > 1e-4) {
        e.knockback.multiplyScalar(Math.max(0, 1 - KNOCKBACK_DECAY * dt));
      }

      // Weapon Skill Studio target dummies never move or attack — they only
      // absorb hits and flash. Keep them planted (with any knockback bleed),
      // playing idle/hit so damage numbers and impact VFX still read clearly.
      if (e.passive) {
        const dp = e.inst.group.position;
        if (e.knockback.lengthSq() > 1e-6) {
          const m = this.moveBody(
            e.body,
            dp.x,
            dp.y,
            dp.z,
            e.knockback.x * dt,
            e.knockback.z * dt,
            ENEMY_RADIUS,
            ENEMY_HEIGHT,
          );
          dp.x = m.x;
          dp.z = m.z;
        }
        dp.y = this.groundAt(dp.x, dp.z);
        updateCharacterAnim(e.inst, dt, {
          speed01: 0,
          strafe: 0,
          grounded: true,
          airborne01: 0,
          strike01: -1,
          strikeDur: ATTACK_DUR,
          guard: false,
          hitFlash: e.hitFlash,
        });
        continue;
      }

      const pos = e.inst.group.position;
      // Target the nearest LIVING unit on another team (player + allies + rival
      // squads). `targetUnit` is null when the player is the target; damage is
      // routed through damageUnit so it hits whichever unit was struck.
      const picked = this.nearestTargetFor(e);
      const targetUnit: Enemy | null = picked === "player" ? null : picked;
      const targetPos = picked ? this.unitPos(targetUnit) : null;

      // Allies with no enemy nearby loosely follow the player so they stay
      // with the squad instead of wandering (Faction War nicety).
      let followPos: THREE.Vector3 | null = null;
      if (
        e.ally &&
        (!targetPos ||
          this.tmpV.copy(targetPos).sub(pos).setY(0).length() > 25)
      ) {
        followPos = this.player.position;
      }

      const aimPos = followPos ?? targetPos;
      if (!aimPos) {
        // No target and no follow (rare): idle in place.
        updateCharacterAnim(e.inst, dt, {
          speed01: 0,
          strafe: 0,
          grounded: true,
          airborne01: 0,
          strike01: -1,
          strikeDur: ATTACK_DUR,
          guard: e.stunTimer > 0,
          hitFlash: e.hitFlash,
        });
        pos.y = this.groundAt(pos.x, pos.z);
        continue;
      }

      const toPlayer = this.tmpV.copy(aimPos).sub(pos);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      toPlayer.normalize();

      // When following (no enemy nearby), only close in while the ally is
      // outside the follow radius; once inside, idle so allies gather near the
      // player instead of perpetually shoving into them.
      const FOLLOW_RADIUS = 6;
      if (followPos && dist <= FOLLOW_RADIUS) {
        updateCharacterAnim(e.inst, dt, {
          speed01: 0,
          strafe: 0,
          grounded: true,
          airborne01: 0,
          strike01: -1,
          strikeDur: ATTACK_DUR,
          guard: e.stunTimer > 0,
          hitFlash: e.hitFlash,
        });
        e.inst.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
        pos.y = this.groundAt(pos.x, pos.z);
        continue;
      }

      e.inst.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
      // Distance to the actual attack target (may differ from follow aim).
      const targetDist = targetPos
        ? this.tmpV2.copy(targetPos).sub(pos).setY(0).length()
        : Infinity;

      e.moving = false;
      let vx = e.knockback.x;
      let vz = e.knockback.z;
      const spd = e.speed * this.enemySpeedMult(e);
      const fromSpawn = Math.hypot(pos.x - e.spawnX, pos.z - e.spawnZ);
      const ring = catalog.ai
        ? aggroState(dist, fromSpawn, catalog.ai.aggro)
        : "aggro";
      if (!frozen && e.pendingCast) {
        e.steer.setMode("idle");
      } else if (!frozen) {
        let mode: SteerMode = "idle";
        let tx = aimPos.x;
        let tz = aimPos.z;
        if (ring === "leash") {
          mode = "seek";
          tx = e.spawnX;
          tz = e.spawnZ;
        } else if (followPos && dist > 6) {
          mode = "arrive";
        } else if (e.archetype === "flanker" && dist <= FLANKER_ORBIT_BAND && dist > e.desiredRange) {
          const sx = -toPlayer.z * e.strafeDir;
          const sz = toPlayer.x * e.strafeDir;
          tx = pos.x + toPlayer.x * 0.55 + sx * 0.85;
          tz = pos.z + toPlayer.z * 0.55 + sz * 0.85;
          mode = "seek";
        } else if (dist > e.desiredRange) {
          mode = "seek";
        } else if (e.ranged && dist < e.desiredRange - KITE_BAND) {
          mode = "flee";
        } else if (e.ranged) {
          const sx = -toPlayer.z * e.strafeDir;
          const sz = toPlayer.x * e.strafeDir;
          tx = pos.x + sx;
          tz = pos.z + sz;
          mode = "seek";
        } else if (ring === "alert" && catalog.ai?.defaultBehavior === "wander") {
          mode = "wander";
        } else if (ring === "idle" && catalog.ai?.defaultBehavior === "wander") {
          mode = "wander";
        }
        e.steer.syncFrom(pos.x, pos.z, spd);
        e.steer.setMode(mode, tx, tz);
        const yv = e.steer.step(dt);
        vx += yv.vx;
        vz += yv.vz;
        e.moving = mode !== "idle" && (yv.vx * yv.vx + yv.vz * yv.vz) > 0.04;
      }
      const m = this.moveBody(
        e.body,
        pos.x,
        pos.y,
        pos.z,
        vx * dt,
        vz * dt,
        ENEMY_RADIUS,
        ENEMY_HEIGHT,
      );
      pos.x = m.x;
      pos.z = m.z;

      // Separation nudge so crowded enemies do not stack.
      for (const o of this.enemies) {
        if (o === e || !o.alive) continue;
        const d = this.tmpV2.copy(pos).sub(o.inst.group.position);
        d.y = 0;
        const dd = d.length();
        if (dd < 1.6 && dd > 0.001) {
          pos.addScaledVector(d.normalize(), (1.6 - dd) * 0.5);
        }
      }

      // Snap to the mesh-accurate ground under the enemy.
      pos.y = this.groundAt(pos.x, pos.z);

      e.attackCooldown -= dt;
      if (e.archetype === "caster") {
        this.updateEnemyCaster(e, targetDist, frozen, dt, targetUnit);
      } else if (e.archetype === "bruiser") {
        if (targetDist <= 3.4 && e.attackCooldown <= 0 && !frozen) {
          e.attackCooldown = 2.6 + Math.random() * 0.9;
          e.swing = BRUISER_TELEGRAPH;
          // Long, readable warning ring — the payoff hits much harder.
          this.telegraphs ??= new TelegraphSystem(this.scene);
          this.telegraphs.spawn({
            kind: "warning",
            ttl: BRUISER_TELEGRAPH,
            size: 3.6,
            position: e.inst.group.position.clone(),
            follow: (out) =>
              e.alive && !e.gone ? out.copy(e.inst.group.position) : null,
          });
          this.schedule(() => {
            if (this.disposed || !e.alive || this.phase !== "playing") return;
            if (e.stagger > 0 || e.stunTimer > 0) return; // interrupted
            if (targetUnit && !targetUnit.alive) return;
            const tp = this.unitPos(targetUnit);
            const d2 = e.inst.group.position.distanceTo(tp);
            if (d2 <= 4.0) {
              this.damageUnit(targetUnit, 18 + this.wave * 3, e);
              // The blow shoves the target even through a successful hit.
              const away = tp.clone().sub(e.inst.group.position).setY(0);
              if (away.lengthSq() > 1e-4) {
                away.normalize();
                if (targetUnit === null) {
                  this.pushPlayer(away, BRUISER_KNOCKBACK);
                  this.dashTimer = Math.max(this.dashTimer, 0.12);
                  this.cameraShake(0.5, 220);
                } else {
                  this.applyKnockback(targetUnit, away, BRUISER_KNOCKBACK);
                }
              }
            }
          }, BRUISER_TELEGRAPH * 1000 - 150);
        }
      } else if (e.ranged) {
        if (targetDist <= GUNNER_FIRE_RANGE && e.attackCooldown <= 0 && !frozen) {
          e.attackCooldown = GUNNER_FIRE_CD + Math.random() * 0.8;
          // Drive the bow-shot / spell-cast animation, then release the
          // projectile at the clip's loose point instead of instantly, so
          // the arrow leaves as the string is released (gunners still hip-fire).
          e.swing = ATTACK_DUR;
          if (e.shotKind === "bolt") {
            this.fireBullet(e, targetUnit);
          } else {
            this.schedule(() => {
              if (this.disposed || !e.alive || e.gone) return;
              if (this.phase !== "playing") return;
              if (e.stagger > 0 || e.stunTimer > 0) return; // interrupted
              this.fireBullet(e, targetUnit);
            }, RANGED_RELEASE_MS);
          }
        }
      } else if (targetDist <= 2.6 && e.attackCooldown <= 0 && !frozen) {
        // Flankers swing faster but lighter than grunts.
        const flanker = e.archetype === "flanker";
        e.attackCooldown = flanker
          ? FLANKER_ATTACK_CD + Math.random() * 0.5
          : 1.4 + Math.random() * 0.8;
        e.swing = ATTACK_DUR;
        // Warning ring under the enemy for the strike's wind-up window.
        this.telegraphs ??= new TelegraphSystem(this.scene);
        this.telegraphs.spawn({
          kind: "warning",
          ttl: 0.45,
          size: 2.6,
          position: e.inst.group.position.clone(),
          follow: (out) =>
            e.alive && !e.gone ? out.copy(e.inst.group.position) : null,
        });
        this.schedule(() => {
          if (this.disposed || !e.alive || this.phase !== "playing") return;
          if (targetUnit && !targetUnit.alive) return;
          const d2 = e.inst.group.position.distanceTo(this.unitPos(targetUnit));
          if (d2 <= 3.0) {
            this.damageUnit(
              targetUnit,
              e.archetype === "flanker" ? 6 + this.wave : 10 + this.wave * 2,
              e,
            );
          }
        }, 240);
      }

      updateCharacterAnim(e.inst, dt, {
        speed01: e.moving ? Math.min(1, e.speed / SPRINT_SPEED) : 0,
        strafe: 0,
        grounded: true,
        airborne01: 0,
        strike01: e.swing > 0 ? 1 - e.swing / ATTACK_DUR : -1,
        strikeDur: ATTACK_DUR,
        guard: e.stunTimer > 0,
        hitFlash: e.hitFlash,
      });
    }
  }

  /**
   * Caster archetype attack: plant, grow a wind-up aura over the staff, then
   * release a telegraphed elemental line cast at the player through the
   * enemy-owned CastingSystem (stagger/stun interrupts the wind-up).
   */
  private updateEnemyCaster(
    e: Enemy,
    dist: number,
    frozen: boolean,
    dt: number,
    targetUnit: Enemy | null,
  ): void {
    if (e.pendingCast) {
      const p = e.pendingCast;
      if (frozen) {
        // Interrupted: the cast fizzles.
        this.disposeCastAura(p.aura);
        e.pendingCast = null;
        e.attackCooldown = 1.2;
        return;
      }
      p.t -= dt;
      const k = THREE.MathUtils.clamp(1 - p.t / p.def.windup, 0, 1);
      p.aura.position.copy(e.inst.group.position).y += 1.6;
      const s = 0.6 + k * 1.8;
      p.aura.scale.set(s, s, s);
      (p.aura.material as THREE.SpriteMaterial).opacity = 0.2 + k * 0.6;
      if (p.t <= 0) {
        this.disposeCastAura(p.aura);
        e.pendingCast = null;
        this.releaseEnemyCast(e, p.def, targetUnit);
      }
      return;
    }
    if (dist <= CASTER_RANGE && e.attackCooldown <= 0 && !frozen) {
      e.attackCooldown = CASTER_CD + Math.random() * 1.2;
      const baseDef = e.castDef ?? ENEMY_CAST_DEF;
      e.swing = baseDef.windup; // drives the spell-cast clip
      const def: CastDef = {
        ...baseDef,
        damage: baseDef.damage + this.wave * 2,
      };
      const aura = this.makeCastAura(def);
      aura.position.copy(e.inst.group.position).y += 1.6;
      e.pendingCast = { def, t: def.windup, aura };
      // Warning line telegraph on the ground toward the target.
      this.telegraphs ??= new TelegraphSystem(this.scene);
      this.telegraphs.spawn({
        kind: "warning",
        ttl: def.windup,
        size: 2.4,
        position: this.unitPos(targetUnit).clone(),
      });
    }
  }

  /** Release the caster's line cast, aimed at its target's current position. */
  private releaseEnemyCast(e: Enemy, def: CastDef, targetUnit: Enemy | null): void {
    if (this.phase !== "playing" || !e.alive || e.gone) return;
    // Each enemy caster owns its own CastingSystem so concurrent faction
    // casters (multiple teams casting in the same frame) never share target
    // state. The onDamage closure captures `e` directly and does a spatial
    // AoE sweep against all living units not on e's team — safe for any mix
    // of faction-war squads or wave casters.
    if (!this.enemyCastSystems.has(e)) {
      this.enemyCastSystems.set(
        e,
        new CastingSystem(this.scene, {
          onDamage: (pos, radius, damage, _color, _knock, dedupe) => {
            // Hit the player only when the caster is on a rival team.
            if (e.team !== this.playerTeam) {
              const pd = this.player.position.distanceTo(pos);
              if (pd <= radius + PLAYER_RADIUS && !dedupe?.has("player")) {
                dedupe?.add("player");
                this.damagePlayer(damage, e);
              }
            }
            // Hit every living enemy NOT on the caster's team.
            for (const o of this.enemies) {
              if (o === e || !o.alive || o.gone || o.team === e.team) continue;
              if (dedupe?.has(o)) continue;
              const d = o.inst.group.position.distanceTo(pos);
              if (d <= radius + ENEMY_RADIUS) {
                dedupe?.add(o);
                this.damageEnemy(o, damage, e.factionColor);
              }
            }
          },
          onShake: (strength, ms) => this.cameraShake(strength * 0.5, ms),
          groundY: (x, z) => this.groundAt(x, z),
          cameraPosition: () => this.camera.position,
        }),
      );
    }
    const sys = this.enemyCastSystems.get(e)!;
    const origin = e.inst.group.position.clone();
    const dir = this.unitPos(targetUnit).clone().sub(origin).setY(0);
    const d = dir.length();
    if (d < 0.5) return;
    dir.normalize();
    origin.addScaledVector(dir, 1.0);
    sys.cast(def, origin, dir, Math.min(def.range, d + 2));
  }

  private updatePlayerAnim(dt: number): void {
    if (!this.playerInst) return;
    // Animation Test: a forced clip overrides the movement-derived state so each
    // locomotion clip can be inspected in isolation via a synthetic AnimState.
    if (this.mode === "animtest" && this.forcedClip) {
      const s = animStateForClip(this.forcedClip);
      this.lastSpeed01 = s.speed01;
      this.lastStrafe = s.strafe;
      updateCharacterAnim(this.playerInst, dt, {
        ...s,
        groundAt: (x, z) => this.groundAt(x, z),
      });
      return;
    }
    const horiz = Math.hypot(this.velocity.x, this.velocity.z);
    const speed01 = Math.min(1, horiz / SPRINT_SPEED);
    // Lateral component relative to facing for strafe roll. "right" must match
    // the camera/movement right basis (forward rotated +90 about Y) or the
    // strafeLeft/strafeRight clips play opposite to the actual sidestep.
    const right = this.tmpV.set(-Math.cos(this.facing), 0, Math.sin(this.facing));
    const strafe = THREE.MathUtils.clamp(
      (this.velocity.x * right.x + this.velocity.z * right.z) / SPRINT_SPEED,
      -1,
      1,
    );
    this.lastSpeed01 = speed01;
    this.lastStrafe = strafe;
    updateCharacterAnim(this.playerInst, dt, {
      speed01,
      strafe,
      grounded: this.grounded,
      airborne01: THREE.MathUtils.clamp(
        (this.player.position.y - this.groundY) / 2.5,
        0,
        1,
      ),
      strike01: this.attackTimer > 0 && this.attackActive ? 1 - this.attackTimer / this.attackDur : -1,
      strikeDur: this.attackDur,
      strikeClip: this.strikeClip,
      cast01: this.castAnimT > 0 ? 1 - this.castAnimT / this.castAnimDur : -1,
      castDur: this.castAnimDur,
      guard: this.blocking,
      hitFlash: 0,
      groundAt: (x, z) => this.groundAt(x, z),
    });
  }

  /** Advance the Animation Test auto clip-cycle (animtest only). */
  private updateAnimTest(dt: number): void {
    if (this.mode !== "animtest" || !this.animTestAuto) return;
    this.animTestTimer -= dt;
    if (this.animTestTimer > 0) return;
    this.animTestTimer = 1.6;
    const cycle: ClipName[] = [
      "idle",
      "walk",
      "run",
      "strafeLeft",
      "strafeRight",
      "jump",
    ];
    const i = this.forcedClip ? cycle.indexOf(this.forcedClip) : -1;
    this.forcedClip = cycle[(i + 1) % cycle.length];
    this.emit();
  }

  /** Force-play a single clip on the player model. No-op outside animtest. */
  animTestPlay(clip: ClipName): void {
    if (this.phase !== "playing" || this.mode !== "animtest") return;
    this.animTestAuto = false;
    this.forcedClip = clip;
    // A held forced "attack" keeps strike01 active, so updateMixamo won't restart
    // the swing on a re-click; clear prevStrike to retrigger it each press.
    if (
      (clip === "attack" || clip === "attack2" || clip === "attack3") &&
      this.playerInst
    ) {
      this.playerInst.prevStrike = false;
    }
    if (clip === "cast" && this.playerInst) this.playerInst.prevCast = false;
    this.emit();
  }

  /** Return to live WASD-driven locomotion (clear any forced clip). */
  animTestFree(): void {
    if (this.mode !== "animtest") return;
    this.animTestAuto = false;
    this.forcedClip = null;
    this.emit();
  }

  /** Toggle the auto clip-cycle. */
  animTestToggleAuto(): void {
    if (this.phase !== "playing" || this.mode !== "animtest") return;
    this.animTestAuto = !this.animTestAuto;
    this.animTestTimer = 0;
    if (!this.animTestAuto) this.forcedClip = null;
    this.emit();
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life += dt;
      s.velocity.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      const k = 1 - s.life / s.maxLife;
      s.mesh.scale.setScalar(Math.max(0.01, k));
      if (s.life >= s.maxLife) {
        this.disposeObject(s.mesh);
        this.sparks.splice(i, 1);
      }
    }
  }

  private updateTimers(dt: number): void {
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0 && this.combo !== 0) {
        this.combo = 0;
        this.emit();
      }
    }
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) {
        this.message = "";
        this.emit();
      }
    }
    for (let i = 0; i < this.cooldowns.length; i++) {
      if (this.cooldowns[i] > 0) {
        this.cooldowns[i] = Math.max(0, this.cooldowns[i] - dt);
      }
    }
  }

  private hipPistolPos(out = new THREE.Vector3()): THREE.Vector3 {
    const right = new THREE.Vector3(-Math.cos(this.facing), 0, Math.sin(this.facing));
    return out
      .copy(this.player.position)
      .addScaledVector(right, 0.28)
      .add(new THREE.Vector3(0, 0.95, 0));
  }

  private placeTentacle(
    mesh: THREE.Object3D,
    from: THREE.Vector3,
    to: THREE.Vector3,
    nativeLen: number,
  ): void {
    const dir = to.clone().sub(from);
    const dist = Math.max(0.15, dir.length());
    dir.multiplyScalar(1 / dist);
    mesh.position.copy(from);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const s = dist / Math.max(0.2, nativeLen);
    mesh.scale.set(Math.min(1.2, 0.35 + s * 0.15), Math.min(1.2, 0.35 + s * 0.15), s);
  }

  private ensureTentacle(): Promise<THREE.Object3D> {
    if (this.tentacleTpl) return Promise.resolve(this.tentacleTpl);
    const url = `${import.meta.env.BASE_URL}models/vfx/tentacle_color_pack.glb`;
    return new Promise((resolve, reject) => {
      new GLTFLoader().load(
        url,
        (gltf) => {
          let best: THREE.Mesh | null = null;
          let bestN = 0;
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const n = m.geometry.getAttribute("position")?.count ?? 0;
            if (n > bestN && n > 200) {
              best = m;
              bestN = n;
            } else {
              m.visible = false;
            }
          });
          if (!best) {
            reject(new Error("tentacle pack has no arm mesh"));
            return;
          }
          best.visible = true;
          const box = new THREE.Box3().setFromObject(best);
          const size = box.getSize(new THREE.Vector3());
          this.tentacleLen = Math.max(size.x, size.y, size.z, 1);
          this.tentacleTpl = best;
          resolve(best);
        },
        undefined,
        reject,
      );
    });
  }

  private aimPointAtCrosshair(): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const origin = this.camera.position.clone();
    this.camRay.set(origin, dir);
    const targets: THREE.Object3D[] = [];
    if (this.camOccluders.length) targets.push(...this.camOccluders);
    for (const e of this.enemies) {
      if (e.alive && !e.gone) targets.push(e.inst.group);
    }
    let hit: THREE.Vector3 | null = null;
    if (targets.length) {
      const hits = this.camRay.intersectObjects(targets, true);
      for (const h of hits) {
        if (h.distance > GRAPPLE_RANGE) break;
        if (this.playerInst && h.object.parent === this.playerInst.group) continue;
        hit = h.point.clone();
        break;
      }
    }
    if (!hit) hit = origin.clone().addScaledVector(dir, GRAPPLE_RANGE);
    hit.y = this.groundAt(hit.x, hit.z);
    const from = this.player.position;
    const flat = Math.hypot(hit.x - from.x, hit.z - from.z);
    if (flat > GRAPPLE_RANGE) {
      const k = GRAPPLE_RANGE / flat;
      hit.x = from.x + (hit.x - from.x) * k;
      hit.z = from.z + (hit.z - from.z) * k;
      hit.y = this.groundAt(hit.x, hit.z);
    }
    return hit;
  }

  private firePistolGrapple(): void {
    if (this.phase !== "playing" || this.grappleCd > 0 || this.grapple) return;
    if (this.force < GRAPPLE_COST) {
      this.setMessage("Not enough force", 0.7);
      return;
    }
    this.force -= GRAPPLE_COST;
    this.grappleCd = GRAPPLE_CD;
    this.castAnimDur = 0.28;
    this.castAnimT = 0.28;
    const to = this.aimPointAtCrosshair();
    const from = this.hipPistolPos();
    this.facing = Math.atan2(to.x - from.x, to.z - from.z);
    void this.ensureTentacle()
      .then((tpl) => {
        if (this.disposed || this.phase !== "playing") return;
        const mesh = cloneSkeleton(tpl);
        mesh.visible = true;
        this.scene.add(mesh);
        this.placeTentacle(mesh, from, from.clone().lerp(to, 0.08), this.tentacleLen);
        this.grapple = {
          mesh,
          from,
          to,
          nativeLen: this.tentacleLen,
          t: 0,
          flying: false,
        };
        this.spawnSparks(from, 0xc9a04e, 8);
      })
      .catch(() => {
        this.grappleCd = 0.2;
        this.setMessage("Grapple mesh missing", 1);
      });
  }

  private updateGrapple(dt: number): void {
    if (this.grappleCd > 0) this.grappleCd = Math.max(0, this.grappleCd - dt);
    const g = this.grapple;
    if (!g) return;
    g.t += dt;
    this.hipPistolPos(g.from);
    const grow = Math.min(1, g.t / GRAPPLE_SHOOT);
    const tip = g.from.clone().lerp(g.to, grow);
    this.placeTentacle(g.mesh, g.from, tip, g.nativeLen);
    if (!g.flying && grow >= 1) {
      g.flying = true;
      const dist = Math.hypot(
        g.to.x - this.player.position.x,
        g.to.z - this.player.position.z,
      );
      this.dashTimer = Math.max(0.1, dist / GRAPPLE_SPEED);
      this.iFrames = Math.max(this.iFrames, 0.14);
      this.cameraShake(0.3, 110);
    }
    if (g.flying) {
      const remain = new THREE.Vector3(
        g.to.x - this.player.position.x,
        0,
        g.to.z - this.player.position.z,
      );
      const d = remain.length();
      if (d < 0.5 || this.dashTimer <= 0) {
        this.clearGrapple();
        return;
      }
      remain.multiplyScalar(GRAPPLE_SPEED / d);
      this.velocity.x = remain.x;
      this.velocity.z = remain.z;
      this.dashTimer = Math.max(this.dashTimer, dt * 2);
    }
  }

  private clearGrapple(): void {
    if (!this.grapple) return;
    this.scene.remove(this.grapple.mesh);
    this.grapple = null;
  }

  private resetRun(): void {
    this.clearGrapple();
    this.clearTimers();
    for (const e of this.enemies) this.disposeEnemy(e);
    this.enemies = [];
    for (const s of this.sparks) this.disposeObject(s.mesh);
    this.sparks = [];
    this.clearVfx();
    for (const c of this.corpses) disposeInstance(c.inst);
    this.corpses = [];
    this.casting?.clear();
    for (const sys of this.enemyCastSystems.values()) sys.clear();
    this.enemyCastSystems.clear();
    this.castAimLine?.hide();
    this.castAnimT = 0;
    this.arcaneCharge = 0;
    this.pendingShot = null;
    this.rangedChargeDur = 0;
    this.strikeClip = "attack";
    this.telegraphs?.clear();
    for (const p of this.pendingCasts) this.disposeCastAura(p.aura);
    this.pendingCasts = [];
    this.clearSkillCast();
    this.castCooldowns = CAST_DEFS.map(() => 0);
    this.simAccum = 0;
    this.ticker.accum = 0;
    this.ticker.queue.length = 0;
    this.swingWarp = null;
    this.softTarget = null;
    if (this.softMarker) this.softMarker.visible = false;
    this.cooldowns = this.skills.map(() => 0);
    this.hudAccum = 0;
    this.health = this.maxHealth;
    this.force = this.maxForce;
    this.score = 0;
    this.wave = 0;
    this.combo = 0;
    this.velocity.set(0, 0, 0);
    this.velocityY = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.attackTimer = 0;
    this.attackDur = ATTACK_DUR;
    this.attackHeavy = false;
    this.attackAir = false;
    this.comboStep = 0;
    this.comboChainTimer = 0;
    this.bufferedAttack = false;
    this.bufferedHeavy = false;
    this.airDashUsed = false;
    this.doubleJumpUsed = false;
    this.forceJumpRequested = false;
    this.pushCooldown = 0;
    this.lungeRemain = 0;
    this.swingAim = null;
    this.iFrames = 0;
    this.parryTimer = 0;
    this.rightDown = false;
    this.blocking = false;
    this.prevBlocking = false;
    this.resetPointerState();
    this.swingId = 0;
    this.targetEnemy = null;
    if (this.targetMarker) this.targetMarker.visible = false;
    this.player.position.set(0, 0, 0);
    // Face away from the camera on respawn (camera resets behind at camYaw).
    this.facing = this.camYaw;
    this.player.rotation.y = this.camYaw;
    this.forcedClip = null;
    this.animTestAuto = false;
    this.animTestTimer = 0;
    this.lastSpeed01 = 0;
    this.lastStrafe = 0;
  }

  private setMessage(msg: string, time: number): void {
    this.message = msg;
    this.messageTimer = time;
    this.emit();
  }

  private snapshot(): HudState {
    return {
      phase: this.phase,
      mode: this.mode,
      playerHealth: Math.round(this.health),
      playerMaxHealth: this.maxHealth,
      forceEnergy: Math.round(this.force),
      forceMaxEnergy: this.maxForce,
      score: this.score,
      wave: this.wave,
      totalWaves: this.totalWaves,
      enemiesRemaining: this.enemiesAlive(),
      combo: this.combo,
      blocking: this.blocking,
      message: this.message,
      playerName: this.playerName,
      playerTitle: this.playerTitle,
      factionColor: this.factionColor,
      skills: [
        ...this.skills.map((s, i) => {
          const cd = this.cooldowns[i] ?? 0;
          const bind = catalog.hotkeys.skill[i];
          return {
            id: s.id,
            name: s.name,
            key: bind ? keyLabel(bind) : s.key,
            cost: s.forceCost,
            cooldownPct: s.cooldown > 0 ? cd / s.cooldown : 0,
            ready: cd <= 0 && this.force >= s.forceCost,
          };
        }),
        // Universal skill: every character can Force Push.
        {
          id: "force-push",
          name: "Force Push",
          key: "R",
          cost: PUSH_COST,
          cooldownPct: Math.max(0, this.pushCooldown) / PUSH_CD,
          ready: this.pushCooldown <= 0 && this.force >= PUSH_COST,
        },
        // Universal elemental casts (keys 1..5: Cinder Fall, Frost Lance,
        // Storm Lance, Nova Beam, Voltaic Snare).
        ...CAST_DEFS.map((d, i) => ({
          id: `cast-${d.element}`,
          name: d.name,
          key: catalog.hotkeys.cast[i] ? keyLabel(catalog.hotkeys.cast[i]) : d.key,
          cost: d.cost,
          cooldownPct: Math.max(0, this.castCooldowns[i] ?? 0) / d.cooldown,
          ready: (this.castCooldowns[i] ?? 0) <= 0 && this.force >= d.cost,
        })),
      ],
      targetLocked: !!this.targetEnemy && this.targetEnemy.alive,
      target: (() => {
        const t =
          this.targetEnemy && this.targetEnemy.alive
            ? this.targetEnemy
            : this.softTarget && this.softTarget.alive
              ? this.softTarget
              : null;
        return t
          ? {
              name: t.label,
              healthPct: Math.max(0, t.health / t.maxHealth),
              locked: t === this.targetEnemy,
            }
          : undefined;
      })(),
      castBar: (() => {
        if (this.pendingSkill && !this.pendingSkill.resolved) {
          const s = this.pendingSkill;
          return {
            name: s.skill.name,
            t01: THREE.MathUtils.clamp(1 - s.t / Math.max(s.dur, 0.01), 0, 1),
            color: `#${s.skill.color.toString(16).padStart(6, "0")}`,
          };
        }
        if (this.arcaneCharge > 0) {
          const dur = this.rangedChargeDur || this.castAnimDur || ARCANE_CAST_T;
          return {
            name: "Arcane Bolt",
            t01: THREE.MathUtils.clamp(1 - this.arcaneCharge / dur, 0, 1),
            color: "#7fd0ff",
          };
        }
        if (
          this.playerCategory === "bow" &&
          this.castAnimT > 0 &&
          this.pendingCasts.length === 0
        ) {
          return {
            name: "Draw",
            t01: THREE.MathUtils.clamp(
              1 - this.castAnimT / Math.max(this.castAnimDur, 0.01),
              0,
              1,
            ),
            color: "#e8c36a",
          };
        }
        const p = this.pendingCasts[this.pendingCasts.length - 1];
        return p
          ? {
              name: p.def.name,
              t01: THREE.MathUtils.clamp(1 - p.t / p.def.windup, 0, 1),
              color: `#${p.def.color.toString(16).padStart(6, "0")}`,
            }
          : undefined;
      })(),
      diag: this.mode === "animtest" ? this.animDiag() : undefined,
    };
  }

  /** Build the live Animation Test diagnostics readout. */
  private animDiag(): AnimDiag {
    const k = this.keys;
    const keys = [
      k["KeyW"] ? "W" : "-",
      k["KeyA"] ? "A" : "-",
      k["KeyS"] ? "S" : "-",
      k["KeyD"] ? "D" : "-",
    ].join(" ");
    const skeletal = !!this.playerInst?.mixer;
    let facingDeg = (this.facing * 180) / Math.PI;
    facingDeg = Math.round(((facingDeg % 360) + 360) % 360);
    return {
      animMode: this.playerAnimMode || "(loading)",
      skeletal,
      currentClip: this.playerInst?.currentClip ?? "-",
      forcedClip: this.forcedClip,
      auto: this.animTestAuto,
      keys,
      speed01: Math.round(this.lastSpeed01 * 100) / 100,
      strafe: Math.round(this.lastStrafe * 100) / 100,
      facingDeg,
    };
  }

  private emit(): void {
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }

  /** Elemental line casts fired BY enemies (damages the player on impact). */
  /** Per-caster CastingSystems: each enemy caster owns its own system so
   * concurrent faction casters never share target state. */
  private enemyCastSystems = new Map<Enemy, CastingSystem>();
}

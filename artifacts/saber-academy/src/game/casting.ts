import * as THREE from "three";
import {
  AimIndicator,
  ZoneIndicator,
  Ribbon,
  BurstSystem,
  BurstMode,
  LightningBolt,
  NovaBeam,
  SnareCage,
  IceCrystalField,
  MeteorRock,
  ArrowVolley,
  ICE_MAX_CRYSTALS,
} from "./castvfx";

/**
 * Elemental line-cast ("skillshot") system, ported from the MolochDaGod
 * ability-casting reference repos (LinearAbiltyCastingThreeJS /
 * CastingAbilitiesThreeJS / threejs-rapier-react-three-controller).
 *
 * Architecture (their most portable pattern): each cast is a phase machine —
 * TRAVEL (a front advances along the aimed line at a fixed speed) → IMPACT
 * (one-shot payoff at the end point) → FADE (VFX wind-down) → DONE — with the
 * gameplay side (damage, force costs, cooldowns, camera shake) injected as
 * host hooks so the effect code stays pure three.js. Targeting is separated
 * from the effect: the host supplies (origin, direction, distance) and the
 * system never raycasts or reads game state itself.
 */

export type CastElement =
  | "fire"
  | "ice"
  | "thunder"
  | "nova"
  | "snare"
  | "volley";

export interface CastDef {
  element: CastElement;
  name: string;
  key: string; // HUD label ("1".."5")
  range: number;
  speed: number; // front travel speed (world units/s); thunder is instant
  damage: number;
  radius: number; // damage radius around the front/impact
  knock: number;
  cost: number; // force cost
  cooldown: number; // seconds
  color: number;
  /** Cast wind-up in seconds: aura builds, then the effect releases. */
  windup: number;
  /**
   * Aim telegraph shape: "line" (skillshot, arrow) or "zone" (far-cast, circle
   * placed at the clamped aim point). Defaults to "line" when absent.
   */
  castShape?: "line" | "zone";
  /** Footprint radius for zone-targeted casts (Voltaic Snare). */
  zoneRadius?: number;
  /**
   * Held channel duration in seconds after the effect lands (Nova Beam holds
   * its burning column; Voltaic Snare holds its cage). 0/absent = no hold.
   */
  hold?: number;
  /**
   * Optional buff/debuff riders applied on hit or cast.
   * Absent / empty → no status effect (defaults keep current gameplay).
   */
  buffs?: import("./buffs").BuffDef[];
}

/**
 * Register (or replace, by element) a cast ability at runtime — the reference
 * repos' "abilities editor" pattern: definitions are pure data, the engine
 * owns costs/cooldowns, so adding a skill is just registering a new def.
 * Returns its index (HUD slot / cooldown index).
 */
export function registerCastAbility(def: CastDef): number {
  const i = CAST_DEFS.findIndex((d) => d.element === def.element);
  if (i >= 0) {
    CAST_DEFS[i] = def;
    return i;
  }
  CAST_DEFS.push(def);
  return CAST_DEFS.length - 1;
}

export const CAST_DEFS: CastDef[] = [
  {
    element: "fire",
    name: "Cinder Fall",
    key: "1",
    range: 16,
    speed: 22,
    damage: 26,
    radius: 3.4,
    knock: 16,
    cost: 22,
    cooldown: 5,
    color: 0xff7733,
    windup: 0.22,
    castShape: "line",
  },
  {
    element: "ice",
    name: "Frost Lance",
    key: "2",
    range: 13,
    speed: 14,
    damage: 18,
    radius: 2.2,
    knock: 8,
    cost: 20,
    cooldown: 6,
    color: 0x8fd8ff,
    windup: 0.28,
    castShape: "line",
  },
  {
    element: "thunder",
    name: "Storm Lance",
    key: "3",
    range: 18,
    speed: 0, // instant strike down the whole line
    damage: 22,
    radius: 2.0,
    knock: 10,
    cost: 26,
    cooldown: 7,
    color: 0xcfa9ff,
    windup: 0.16,
    castShape: "line",
  },
  {
    element: "nova",
    name: "Nova Beam",
    key: "4",
    range: 20,
    speed: 60, // column races downrange fast, then holds
    damage: 10, // per damage tick in the beam line during the hold
    radius: 1.8,
    knock: 6,
    cost: 30,
    cooldown: 9,
    color: 0x5fc8ff,
    windup: 0.55, // longer charge: the orb winds up in the hands
    castShape: "line",
    hold: 1.2,
  },
  {
    element: "snare",
    name: "Voltaic Snare",
    key: "5",
    range: 15,
    speed: 46, // leash whips out to the aim point
    damage: 20,
    radius: 3.2,
    knock: 9,
    cost: 26,
    cooldown: 8,
    color: 0x8a5cff,
    windup: 0.2,
    castShape: "zone",
    zoneRadius: 3.2,
    hold: 1.0,
  },
  {
    element: "volley",
    name: "Rain of Arrows",
    key: "6",
    range: 16,
    speed: 40, // signal arrow flies up fast then the barrage rains down
    damage: 9, // per-volley tick (4 volleys = 36 max)
    radius: 3.5,
    knock: 4, // small trapping knock, no root system
    cost: 24,
    cooldown: 9,
    color: 0xffd65a,
    windup: 0.2,
    castShape: "zone",
    zoneRadius: 3.5,
    hold: 1.4, // barrage duration: 4 volleys ~0.35s apart
  },
];

export interface CastHooks {
  /**
   * Damage + knock back every enemy within `radius` of `pos` (away from it).
   * When `dedupe` is given, enemies already in the set must be skipped and
   * newly hit ones added — this is how a travelling front damages each enemy
   * once as it sweeps the line instead of multi-hitting per tick.
   */
  onDamage(
    pos: THREE.Vector3,
    radius: number,
    damage: number,
    color: number,
    knock: number,
    dedupe?: Set<unknown>,
  ): void;
  onShake(strength: number, ms: number): void;
  /**
   * Terrain height under (x, z). The reference sandbox casts on a flat floor
   * (y = 0); our arena is mesh ground, so every effect placed "on the floor"
   * must ask the host where the floor actually is.
   */
  groundY?(x: number, z: number): number;
  /**
   * Current camera position, needed to billboard the fire/thunder ribbon
   * trails toward the viewer. Optional: without it the trails are hidden.
   */
  cameraPosition?(): THREE.Vector3;
}

type Phase = "travel" | "impact" | "hold" | "fade" | "done";

interface IceSpike {
  mesh: THREE.Mesh;
  along: number; // 0..1 position along the line
  erupted: boolean;
  seed: number;
  baseY: number; // terrain height at the spike's spot
}

interface CastEffect {
  def: CastDef;
  phase: Phase;
  age: number;
  phaseAge: number;
  front: number; // 0..1 along the line
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  distance: number;
  group: THREE.Group;
  light: THREE.PointLight;
  // fire
  core?: THREE.Mesh;
  trail?: { sprite: THREE.Sprite; life: number; maxLife: number }[];
  trailT?: number;
  /** Fire projectile core ribbon trail (billboard, tapering). */
  ribbon?: Ribbon;
  /** Recent core positions feeding the ribbon (head = last). */
  ribbonPts?: THREE.Vector3[];
  /** Thunder afterglow ribbon along the struck line. */
  boltRibbon?: Ribbon;
  /** Travelling AoE readout riding the front during TRAVEL. */
  frontZone?: ZoneIndicator;
  // ice
  spikes?: IceSpike[];
  // thunder (Storm Lance)
  bolt?: THREE.LineSegments;
  boltSeed?: number;
  lightning?: LightningBolt;
  // fire (Cinder Fall) — arcing meteor + detonation chunks
  meteor?: MeteorRock;
  meteorLaunch?: THREE.Vector3;
  meteorApex?: number; // arc height
  detonated?: boolean;
  // ice (Frost Lance) — procedural crystal field
  crystals?: IceCrystalField;
  crystalTicked?: Set<string>;
  // nova (Nova Beam) — held column
  beam?: NovaBeam;
  novaTicked?: Set<unknown>;
  // snare (Voltaic Snare) — zone cage
  snare?: SnareCage;
  snareCentre?: THREE.Vector3;
  snareHand?: THREE.Vector3;
  snareSnap?: number; // 0..1 ring snap ease
  snareApplied?: boolean;
  // volley (Rain of Arrows) — signal shot then a raining barrage
  volley?: ArrowVolley;
  volleyCentre?: THREE.Vector3;
  volleyLaunchFrom?: THREE.Vector3; // player hand height, arrow launch origin
  volleyApex?: THREE.Vector3; // where the signal arrow pops
  volleyPopped?: boolean; // apex burst fired
  volleysFired?: number; // how many rain volleys spawned so far
  volleyNextT?: number; // countdown to the next volley (during hold)
  perimeterSet?: boolean;
  // impact payoff (shared)
  ring?: THREE.Mesh;
  flash?: THREE.Sprite;
  damageTicked?: Set<number>; // ice: spike indices already damaged
  /** Enemies already damaged by this cast's travelling front (fire sweep). */
  sweptEnemies?: Set<unknown>;
  /** Additive impact light punch that decays on its own (reference behavior). */
  lightBoost: number;
  baseLightIntensity: number;
}

const MAX_ACTIVE = 6;
/** Cap on ribbon trail segments so rapid casting can't grow buffers. */
const RIBBON_MAX_SEGMENTS = 40;
const FADE_T = 0.45;
const IMPACT_T = 0.35;
/** Ground-mark lifetime (reference "ground marks": SCORCH/FROST/ARC decals). */
const DECAL_TTL = 3.5;
const MAX_DECALS = 14;

/** Element palette for the SDF indicators, ribbons and burst shells. */
interface ElementPalette {
  /** Bright interior/lines colour (indicator core). */
  core: THREE.Color;
  /** Element hue (indicator edge, ribbon tail, burst mid). */
  edge: THREE.Color;
  /** Ribbon head / burst hot core. */
  hot: THREE.Color;
  /** Burst dark tail. */
  dark: THREE.Color;
  /** BurstSystem mode. */
  burst: number;
}

function elementPalette(def: CastDef): ElementPalette {
  const edge = new THREE.Color(def.color);
  const hot = edge.clone().lerp(new THREE.Color(0xffffff), 0.55);
  const core = edge.clone().lerp(new THREE.Color(0xffffff), 0.8);
  const dark = edge.clone().multiplyScalar(0.15);
  const burst =
    def.element === "fire" || def.element === "nova"
      ? BurstMode.FIRE
      : def.element === "ice"
        ? BurstMode.FROST
        : BurstMode.STORM;
  return { core, edge, hot, dark, burst };
}

export class CastingSystem {
  private scene: THREE.Scene;
  private hooks: CastHooks;
  private active: CastEffect[] = [];
  private texture: THREE.Texture;
  /** Fading ground marks left by impacts (SCORCH / FROST / ARC). */
  private decals: { mesh: THREE.Mesh; t: number }[] = [];
  /** Pooled expanding impact shells shared by all active casts. */
  private bursts: BurstSystem;

  constructor(scene: THREE.Scene, hooks: CastHooks) {
    this.scene = scene;
    this.hooks = hooks;
    this.texture = makeRadialTexture();
    this.bursts = new BurstSystem(scene);
  }

  cast(
    def: CastDef,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    distance: number,
  ): void {
    // Retire the oldest cast when at capacity (reference-manager behavior).
    if (this.active.length >= MAX_ACTIVE) {
      const oldest = this.active.shift();
      if (oldest) this.disposeEffect(oldest);
    }
    const flatDir = dir.clone().setY(0);
    if (flatDir.lengthSq() < 1e-6) flatDir.set(0, 0, 1);
    flatDir.normalize();
    const fx: CastEffect = {
      def,
      phase: "travel",
      age: 0,
      phaseAge: 0,
      front: 0,
      origin: origin.clone().setY(0),
      dir: flatDir,
      distance: Math.max(2, distance),
      group: new THREE.Group(),
      light: new THREE.PointLight(def.color, 0, 9, 2),
      lightBoost: 0,
      baseLightIntensity: 0,
    };
    fx.group.add(fx.light);
    this.scene.add(fx.group);
    if (def.element === "fire") this.buildFire(fx);
    else if (def.element === "ice") this.buildIce(fx);
    else if (def.element === "thunder") this.buildThunder(fx);
    else if (def.element === "nova") this.buildNova(fx);
    else if (def.element === "snare") this.buildSnare(fx);
    else this.buildVolley(fx);
    this.active.push(fx);
  }

  /**
   * Leave a fading ground mark at an impact point — the reference repos'
   * SCORCH/FROST/ARC decal practice. Shares the radial texture; oldest mark
   * retires at the cap so long fights don't accumulate meshes.
   */
  private spawnDecal(pos: THREE.Vector3, radius: number, color: number): void {
    if (this.decals.length >= MAX_DECALS) {
      const oldest = this.decals.shift();
      if (oldest) this.removeDecal(oldest.mesh);
    }
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 28),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        color,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * Math.PI * 2;
    mesh.position.copy(pos).setY(pos.y + 0.04);
    this.scene.add(mesh);
    this.decals.push({ mesh, t: 0 });
  }

  private removeDecal(mesh: THREE.Mesh): void {
    // Geometry is per-decal; material shares this.texture, so only the
    // material itself is disposed (never the shared map).
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.scene.remove(mesh);
  }

  /* ---------- per-element builders ---------- */

  private buildFire(fx: CastEffect): void {
    // Cinder Fall: an arcing cratered meteor with lava seams that heats up as
    // it bears down, then detonates into cooling chunks. The meteor replaces
    // the old plain sphere core; the ember puffs remain as extra debris.
    const meteor = new MeteorRock({
      rock: 0x352822,
      char: 0x140b08,
      crack: 0xff5a1e,
      hot: 0xffd27a,
    });
    fx.meteor = meteor;
    fx.group.add(meteor.group);
    fx.meteorApex = Math.min(9, 3 + fx.distance * 0.35);
    fx.detonated = false;
    fx.trail = [];
    fx.trailT = 0;
    fx.light.intensity = 14;
    fx.baseLightIntensity = 14;
    // Billboard ribbon core trail (additive, tapering width/alpha toward the
    // tail) — the reference RibbonGeometry look, replacing the sprite puffs as
    // the primary trail (puffs remain as extra embers).
    if (this.hooks.cameraPosition) {
      const pal = elementPalette(fx.def);
      const ribbon = new Ribbon(RIBBON_MAX_SEGMENTS);
      ribbon.setColors(pal.hot, pal.edge);
      fx.ribbon = ribbon;
      fx.ribbonPts = [];
      fx.group.add(ribbon.mesh);
    }
    // Live AoE readout riding the front (fainter than the armed zone).
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
  }

  private buildIce(fx: CastEffect): void {
    // Frost Lance: a fracture front runs down the line, erupting a procedural
    // crystal field (three instanced shape tiers, patched ice material).
    fx.crystalTicked = new Set();
    const field = new IceCrystalField({
      deep: 0x1d5a8c,
      ice: 0xbfeaff,
      rim: 0xe8fbff,
      core: 0x9fe4ff,
    });
    const side = new THREE.Vector3(-fx.dir.z, 0, fx.dir.x);
    const count = Math.min(
      ICE_MAX_CRYSTALS,
      Math.max(9, Math.floor(fx.distance * 2.4)),
    );
    field.build(count, (t) => this.pointAt(fx, t), side);
    fx.crystals = field;
    fx.group.add(field.group);
    fx.light.intensity = 8;
    fx.baseLightIntensity = 8;
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
  }

  private buildThunder(fx: CastEffect): void {
    // Storm Lance: an instanced filament-bundle bolt struck down the whole line
    // at once. `origin` is lifted to the caster's hand height; `target` sits on
    // the line's end. The strike-front (progress) snaps out near-instantly.
    const start = this.pointAt(fx, 0);
    const end = this.pointAt(fx, 1);
    // Hand height, not overhead: +3.0 made the bolt visibly start above and
    // behind the caster's head instead of leaving the casting hand.
    const originHi = start.clone().setY(start.y + 1.45);
    const bolt = new LightningBolt(9);
    bolt.setColors({
      core: 0xffffff,
      inner: 0xe8ddff,
      outer: 0xa878ff,
      halo: 0x3a1f8c,
    });
    bolt.set(originHi, end, new THREE.Vector3(-fx.dir.z, 0, fx.dir.x));
    bolt.setProgress(1);
    fx.lightning = bolt;
    fx.group.add(bolt.group);
    fx.light.intensity = 22;
    fx.baseLightIntensity = 22;
    fx.lightBoost = 10;
    const mid = this.pointAt(fx, 0.5);
    fx.light.position.copy(mid).setY(mid.y + 2);
    // Instant strike: damage in steps along the line immediately.
    const steps = Math.max(3, Math.floor(fx.distance / 2));
    for (let i = 1; i <= steps; i++) {
      this.hooks.onDamage(
        this.pointAt(fx, i / steps),
        fx.def.radius,
        fx.def.damage,
        fx.def.color,
        fx.def.knock,
      );
    }
    this.hooks.onShake(0.5, 200);
    fx.phase = "impact";
    fx.front = 1;
    this.spawnDecal(end, fx.def.radius, fx.def.color);
    // Zone marker sits at max range for the instant strike, fading with impact.
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
    // Storm burst shell at the far end.
    const pal = elementPalette(fx.def);
    this.bursts.spawn(pal.burst, end.clone().setY(end.y + 0.6), {
      radius: 0.5,
      endRadius: fx.def.radius * 1.6,
      life: 0.75,
      intensity: 1.4,
      colorA: pal.hot,
      colorB: pal.edge,
      colorC: pal.core,
    });
  }

  private buildNova(fx: CastEffect): void {
    // Nova Beam: the orb winds up in the caster's hands during the (longer)
    // windup, then the column races downrange and holds burning. The front
    // starts at 0; the orb charge is driven up in updateElement during travel.
    const beam = new NovaBeam(4, 6);
    beam.setColors({
      core: 0xffffff,
      inner: 0xd4f2ff,
      outer: 0x49b8ff,
      halo: 0x0d3aa8,
      coil: 0xffe08a,
      coilEdge: 0xff7a1e,
      ring: 0x9fe8ff,
    });
    const start = this.pointAt(fx, 0);
    const end = this.pointAt(fx, 1);
    const originHi = start.clone().setY(start.y + 1.1);
    const targetHi = end.clone().setY(end.y + 0.8);
    beam.set(originHi, targetHi, new THREE.Vector3(-fx.dir.z, 0, fx.dir.x));
    beam.setProgress(0);
    beam.setCharge(0);
    fx.beam = beam;
    fx.novaTicked = new Set();
    fx.group.add(beam.group);
    fx.light.intensity = 10;
    fx.baseLightIntensity = 10;
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
  }

  private buildSnare(fx: CastEffect): void {
    // Voltaic Snare: a FAR CAST. The aim point is already clamped to range by
    // the host; the leash whips out from the caster's hand to that point, then
    // the ring snaps open (outCubic overshoot in updateElement) and the cage
    // stands and holds. All ground roles hug the mesh floor via snareCentre.y.
    const centre = this.pointAt(fx, 1);
    const hand = this.pointAt(fx, 0);
    hand.y += 1.1;
    const radius = fx.def.zoneRadius ?? 3.2;
    const cage = new SnareCage({ leash: 3, column: 8, tendril: 12, rim: 7 });
    cage.setColors({
      core: 0xffffff,
      inner: 0xdcccff,
      outer: 0x8f6bff,
      halo: 0x2a0d8c,
      field: 0x8a5cff,
      fieldEdge: 0xffffff,
    });
    // Start collapsed at the caster: leash tip at the hand, radius 0.
    cage.set(centre, hand, hand.clone(), 0.01, 0.01);
    fx.snare = cage;
    fx.snareCentre = centre;
    fx.snareHand = hand;
    fx.snareSnap = 0;
    fx.snareApplied = false;
    fx.group.add(cage.group);
    fx.light.intensity = 10;
    fx.baseLightIntensity = 10;
    fx.light.position.copy(centre).setY(centre.y + 1.5);
    // The zone footprint is armed at the aim point (the far-cast telegraph).
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
  }

  private buildVolley(fx: CastEffect): void {
    // Rain of Arrows: a FAR CAST. A single signal arrow fires steeply UP from
    // the caster during TRAVEL; at its apex it pops (enterImpact), then over
    // the HOLD it rains 4 volleys of arrows over the telegraphed zone.
    const centre = this.pointAt(fx, 1);
    const hand = this.pointAt(fx, 0);
    hand.y += 1.2;
    // The signal arrow launches steeply up-and-toward the zone.
    const toZone = centre.clone().sub(hand).setY(0);
    if (toZone.lengthSq() < 1e-5) toZone.copy(fx.dir);
    toZone.normalize();
    const apex = hand
      .clone()
      .addScaledVector(toZone, fx.distance * 0.4)
      .setY(hand.y + 8.5);

    const volley = new ArrowVolley(
      { head: 0xffd65a, shaft: 0xd8c9a3 },
      72,
      Math.max(10, Math.round((fx.def.zoneRadius ?? 3.5) * 6)),
    );
    volley.setSignal(hand, apex.clone().sub(hand).normalize(), true);
    fx.volley = volley;
    fx.group.add(volley.group);
    fx.volleyCentre = centre;
    fx.volleyLaunchFrom = hand;
    fx.volleyApex = apex;
    fx.volleyPopped = false;
    fx.volleysFired = 0;
    fx.volleyNextT = 0;
    fx.perimeterSet = false;
    fx.novaTicked = new Set(); // reused: per-volley damage dedupe set

    fx.light.intensity = 8;
    fx.baseLightIntensity = 8;
    fx.light.position.copy(hand);

    // Billboard ribbon trail behind the rising signal arrow.
    if (this.hooks.cameraPosition) {
      const pal = elementPalette(fx.def);
      const ribbon = new Ribbon(RIBBON_MAX_SEGMENTS);
      ribbon.setColors(pal.hot, pal.edge);
      fx.ribbon = ribbon;
      fx.ribbonPts = [];
      fx.group.add(ribbon.mesh);
    }

    // Armed zone footprint at the aim point (far-cast telegraph).
    const fz = new ZoneIndicator();
    const palz = elementPalette(fx.def);
    fz.setColors(palz.core, palz.edge);
    fz.setVisible(true);
    fx.frontZone = fz;
    this.scene.add(fz.mesh);
  }

  /* ---------- update ---------- */

  update(dt: number): void {
    this.bursts.update(dt);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const fx = this.active[i];
      fx.age += dt;
      fx.phaseAge += dt;
      switch (fx.phase) {
        case "travel":
          this.updateTravel(fx, dt);
          break;
        case "impact":
          this.updateImpact(fx, dt);
          break;
        case "hold":
          this.updateHold(fx, dt);
          break;
        case "fade":
          this.updateFade(fx, dt);
          break;
      }
      this.updateElement(fx, dt);
      if (fx.phase === "done") {
        this.disposeEffect(fx);
        this.active.splice(i, 1);
      }
    }
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.t += dt;
      if (d.t >= DECAL_TTL) {
        this.removeDecal(d.mesh);
        this.decals.splice(i, 1);
        continue;
      }
      const k = 1 - d.t / DECAL_TTL;
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * k * k;
    }
  }

  private updateTravel(fx: CastEffect, dt: number): void {
    // 80ms outQuad ease-in on the front speed (reference `Easing.outQuad`,
    // keyed off elapsed time, not progress) so casts "launch" with weight.
    const k = Math.min(1, fx.age / 0.08);
    const ease = k * (2 - k);
    fx.front += ((fx.def.speed * ease) / fx.distance) * dt;
    // Fire is a rushing front: it damages each enemy once as it passes over
    // them, not only at the endpoint. The dedupe set makes the sweep hit each
    // enemy a single time across all ticks of the same cast.
    if (fx.def.element === "fire") {
      fx.sweptEnemies ??= new Set();
      this.hooks.onDamage(
        this.pointAt(fx, Math.min(1, fx.front)),
        fx.def.radius * 0.7,
        fx.def.damage * 0.6,
        fx.def.color,
        fx.def.knock * 0.6,
        fx.sweptEnemies,
      );
    }
    if (fx.front >= 1) {
      fx.front = 1;
      this.enterImpact(fx);
    }
  }

  private enterImpact(fx: CastEffect): void {
    fx.phase = "impact";
    fx.phaseAge = 0;
    const end = this.pointAt(fx, 1);
    if (fx.def.element === "fire") {
      this.hooks.onDamage(end, fx.def.radius, fx.def.damage, fx.def.color, fx.def.knock);
      this.hooks.onShake(0.7, 280);
      // Detonate the meteor: hide the rock, throw the cooling chunks.
      if (fx.meteor && !fx.detonated) {
        fx.detonated = true;
        fx.meteor.hideMeteor();
        fx.meteor.detonate(
          end,
          this.hooks.groundY ?? ((x, z) => (void x, void z, 0)),
        );
      }
      // Expanding shockwave ring + flash at the impact point.
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.3, 0.55, 40),
        new THREE.MeshBasicMaterial({
          color: fx.def.color,
          side: THREE.DoubleSide,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(end).setY(end.y + 0.06);
      fx.ring = ring;
      fx.group.add(ring);
      const flash = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.texture,
          color: fx.def.color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      flash.scale.setScalar(3.2);
      flash.position.copy(end).setY(end.y + 1.0);
      fx.flash = flash;
      fx.group.add(flash);
      fx.light.position.copy(end).setY(end.y + 1.2);
      // Impact light punch (reference `lightBoost`): a transient additive
      // spike that decays on its own instead of a hard-set brighter value.
      fx.lightBoost = 14;
      // BurstSphere expanding fire shell at the impact.
      const pal = elementPalette(fx.def);
      this.bursts.spawn(pal.burst, end.clone().setY(end.y + 0.6), {
        radius: 0.5,
        endRadius: fx.def.radius * 1.7,
        life: 0.85,
        intensity: 1.5,
        colorA: pal.hot,
        colorB: pal.edge,
        colorC: pal.dark,
      });
    } else if (fx.def.element === "ice") {
      // Frost shell tearing into plates at the line's end.
      const pal = elementPalette(fx.def);
      this.bursts.spawn(pal.burst, end.clone().setY(end.y + 0.6), {
        radius: 0.4,
        endRadius: fx.def.radius * 1.5,
        life: 0.9,
        intensity: 1.2,
        colorA: pal.edge,
        colorB: pal.core,
        colorC: pal.hot,
      });
    } else if (fx.def.element === "nova") {
      // Column has landed. It now HOLDS, burning into the floor.
      this.hooks.onShake(0.5, 220);
      fx.lightBoost = 12;
      fx.light.position.copy(end).setY(end.y + 1.2);
      const pal = elementPalette(fx.def);
      this.bursts.spawn(pal.burst, end.clone().setY(end.y + 0.6), {
        radius: 0.4,
        endRadius: fx.def.radius * 1.6,
        life: 0.7,
        intensity: 1.4,
        colorA: pal.hot,
        colorB: pal.edge,
        colorC: pal.core,
      });
      this.spawnDecal(end, fx.def.radius * 0.9, fx.def.color);
      fx.phase = "hold";
      fx.phaseAge = 0;
      return;
    } else if (fx.def.element === "snare") {
      // The leash has reached the aim point — the ring snaps open into a cage
      // that holds. Apply the damage + knock once (a brief root via knock=low).
      this.hooks.onShake(0.4, 200);
      fx.lightBoost = 10;
      const pal = elementPalette(fx.def);
      this.bursts.spawn(pal.burst, end.clone().setY(end.y + 0.6), {
        radius: 0.5,
        endRadius: (fx.def.zoneRadius ?? 3.2) * 1.4,
        life: 0.6,
        intensity: 1.3,
        colorA: pal.hot,
        colorB: pal.edge,
        colorC: pal.core,
      });
      this.spawnDecal(end, fx.def.zoneRadius ?? 3.2, fx.def.color);
      fx.phase = "hold";
      fx.phaseAge = 0;
      return;
    } else if (fx.def.element === "volley") {
      // APEX POP: the signal arrow bursts at its apex, then the barrage HOLDS
      // and rains volleys down over the zone.
      this.hooks.onShake(0.28, 160);
      if (fx.volley) fx.volley.setSignal(new THREE.Vector3(), new THREE.Vector3(0, 1, 0), false);
      fx.volleyPopped = true;
      const apex = fx.volleyApex ?? end.clone().setY(end.y + 8);
      const pal = elementPalette(fx.def);
      this.bursts.spawn(pal.burst, apex, {
        radius: 0.35,
        endRadius: 2.6,
        life: 0.6,
        intensity: 1.4,
        colorA: new THREE.Color(0xfff2c0),
        colorB: new THREE.Color(0xffd65a),
        colorC: new THREE.Color(0xffa22e),
      });
      // Plant the perimeter "trap" ring of stuck arrows now.
      const centre = fx.volleyCentre ?? end;
      const R = fx.def.zoneRadius ?? 3.5;
      if (fx.volley && !fx.perimeterSet) {
        fx.perimeterSet = true;
        fx.volley.setPerimeter(
          centre,
          R,
          12,
          this.hooks.groundY ?? ((x, z) => (void x, void z, 0)),
        );
      }
      fx.volleysFired = 0;
      fx.volleyNextT = 0; // first volley fires immediately at hold start
      this.spawnDecal(centre, R, fx.def.color);
      fx.phase = "hold";
      fx.phaseAge = 0;
      return;
    }
    // Ground mark at the line's end for every element (SCORCH/FROST/ARC).
    this.spawnDecal(end, fx.def.radius * 0.9, fx.def.color);
  }

  private updateHold(fx: CastEffect, dt: number): void {
    void dt;
    const holdT = fx.def.hold ?? 0;
    if (fx.def.element === "nova") {
      // Damage ticks along the beam line while it burns. A FRESH dedupe set
      // per simulation step: adjacent samples overlap, and without it an enemy
      // straddling two samples would take the DoT twice (or more) per frame.
      const tickedThisStep = new Set<unknown>();
      const steps = Math.max(3, Math.floor(fx.distance / 2.5));
      for (let i = 1; i <= steps; i++) {
        this.hooks.onDamage(
          this.pointAt(fx, i / steps),
          fx.def.radius,
          fx.def.damage * dt, // per-second tick
          fx.def.color,
          fx.def.knock * dt,
          tickedThisStep,
        );
      }
    } else if (fx.def.element === "snare" && !fx.snareApplied && fx.phaseAge > 0.12) {
      // Snap-open lands the damage + brief knock/root once.
      fx.snareApplied = true;
      const centre = fx.snareCentre ?? this.pointAt(fx, 1);
      this.hooks.onDamage(
        centre,
        fx.def.zoneRadius ?? 3.2,
        fx.def.damage,
        fx.def.color,
        fx.def.knock,
      );
    } else if (fx.def.element === "volley" && fx.volley) {
      // Fire 4 volleys spaced ~0.35s apart across the hold; each spawns a
      // batch of raining arrows AND lands one damage tick over the zone.
      const VOLLEYS = 4;
      const SPACING = 0.35;
      const centre = fx.volleyCentre ?? this.pointAt(fx, 1);
      const R = fx.def.zoneRadius ?? 3.5;
      const groundY = this.hooks.groundY ?? ((x, z) => (void x, void z, 0));
      fx.volleyNextT = (fx.volleyNextT ?? 0) - dt;
      if ((fx.volleysFired ?? 0) < VOLLEYS && (fx.volleyNextT ?? 0) <= 0) {
        fx.volleysFired = (fx.volleysFired ?? 0) + 1;
        fx.volleyNextT = SPACING;
        const arrowsPerVolley = 12;
        fx.volley.spawnVolley(centre, R, arrowsPerVolley, groundY);
        this.hooks.onShake(0.18, 120);
        fx.lightBoost = Math.max(fx.lightBoost, 6);
        fx.light.position.copy(centre).setY(groundY(centre.x, centre.z) + 1.0);
        // One damage tick per volley, with a per-volley dedupe set so each
        // enemy in the zone takes exactly one hit from this volley (the
        // trapping damage). Small knock keeps them pinned, no root system.
        const tickedThisVolley = new Set<unknown>();
        this.hooks.onDamage(
          centre.clone().setY(groundY(centre.x, centre.z)),
          R,
          fx.def.damage,
          fx.def.color,
          fx.def.knock,
          tickedThisVolley,
        );
      }
    }
    if (fx.phaseAge >= holdT) {
      fx.phase = "fade";
      fx.phaseAge = 0;
    }
  }

  private updateImpact(fx: CastEffect, dt: number): void {
    void dt;
    if (fx.phaseAge >= IMPACT_T) {
      fx.phase = "fade";
      fx.phaseAge = 0;
    }
  }

  private updateFade(fx: CastEffect, dt: number): void {
    void dt;
    if (fx.phaseAge >= FADE_T) fx.phase = "done";
  }

  private updateElement(fx: CastEffect, dt: number): void {
    const fadeK =
      fx.phase === "fade" ? Math.max(0, 1 - fx.phaseAge / FADE_T) : 1;
    // Decaying additive boost on top of the element's base intensity — the
    // reference's `lightBoost` impact punch, frame-rate independent.
    fx.lightBoost = Math.max(0, fx.lightBoost - fx.lightBoost * 4.5 * dt - 0.5 * dt);
    fx.light.intensity =
      fx.baseLightIntensity * (fx.phase === "fade" ? fadeK * 0.35 : 1) +
      fx.lightBoost;

    // ---- shared: travelling AoE readout at the live damage radius ----
    if (fx.frontZone) {
      fx.frontZone.update(dt);
      const yaw = Math.atan2(fx.dir.x, fx.dir.z);
      const isZone = (fx.def.castShape ?? "line") === "zone";
      // Thunder + zone casts (snare/volley) sit at the aim point; fire/ice ride
      // the travelling front.
      const along =
        fx.def.element === "thunder" || isZone ? 1 : Math.min(1, fx.front);
      const p = this.pointAt(fx, along);
      p.y += 0.05;
      // Reveal snaps out over the first stretch of travel; fainter than the
      // armed aim zone so it reads as a live readout, not the target marker.
      const reveal =
        fx.phase === "travel"
          ? THREE.MathUtils.clamp(fx.phaseAge / 0.12 + fx.front, 0, 1)
          : 1;
      const op =
        (fx.phase === "fade" ? fadeK : fx.phase === "impact" ? 0.85 : 0.6);
      const zr = isZone ? (fx.def.zoneRadius ?? fx.def.radius) : fx.def.radius;
      fx.frontZone.place(p, yaw, zr, reveal, true, op);
    }

    if (fx.def.element === "fire") {
      if (fx.meteor) fx.meteor.update(dt, this.hooks.groundY);
      if (fx.meteor && fx.phase === "travel") {
        // The meteor rides an arc above the aimed line: charge (heat) builds as
        // it bears down, heading drives the compression heat on leading facets.
        const p = this.pointAt(fx, fx.front);
        const arc = (fx.meteorApex ?? 5) * Math.sin(Math.min(1, fx.front) * Math.PI);
        const pos = p.clone().setY(p.y + 0.7 + arc);
        // Heading: from the previous sample toward this one.
        const prev = this.pointAt(fx, Math.max(0, fx.front - 0.03));
        const prevArc =
          (fx.meteorApex ?? 5) * Math.sin(Math.max(0, fx.front - 0.03) * Math.PI);
        const prevPos = prev.clone().setY(prev.y + 0.7 + prevArc);
        const heading = pos.clone().sub(prevPos);
        if (heading.lengthSq() < 1e-5) heading.copy(fx.dir);
        heading.normalize();
        const charge = Math.min(1, fx.front + 0.15);
        fx.meteor.setMeteor(pos, 0.7, heading, charge);
        fx.light.position.copy(pos);
        // Billboard ribbon burning wake behind the meteor.
        if (fx.ribbon && fx.ribbonPts && this.hooks.cameraPosition) {
          fx.ribbonPts.push(pos.clone());
          if (fx.ribbonPts.length > RIBBON_MAX_SEGMENTS + 1) fx.ribbonPts.shift();
          if (fx.ribbonPts.length >= 2) {
            fx.ribbon.build(
              fx.ribbonPts,
              1.0,
              this.hooks.cameraPosition(),
              (t) => 0.12 + 0.88 * t,
            );
          }
        }
        // Trailing embers.
        fx.trailT = (fx.trailT ?? 0) - dt;
        if (fx.trailT <= 0) {
          fx.trailT = 0.03;
          const s = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: this.texture,
              color: fx.def.color,
              transparent: true,
              opacity: 0.7,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          s.scale.setScalar(0.9 + Math.random() * 0.6);
          s.position.copy(pos);
          fx.group.add(s);
          fx.trail!.push({ sprite: s, life: 0.3, maxLife: 0.3 });
        }
      }
      // Ribbon fades quickly once the meteor lands.
      if (fx.ribbon) {
        const rk = fx.phase === "travel" ? 1 : fadeK * fadeK;
        fx.ribbon.setOpacity(rk);
      }
      if (fx.trail) {
        for (let i = fx.trail.length - 1; i >= 0; i--) {
          const t = fx.trail[i];
          t.life -= dt;
          const k = Math.max(0, t.life / t.maxLife);
          t.sprite.material.opacity = 0.7 * k;
          if (t.life <= 0) {
            fx.group.remove(t.sprite);
            t.sprite.material.dispose();
            fx.trail.splice(i, 1);
          }
        }
      }
      if (fx.ring) {
        const t = Math.min(1, (fx.phaseAge + (fx.phase === "fade" ? IMPACT_T : 0)) / (IMPACT_T + FADE_T));
        const r = 0.4 + t * fx.def.radius * 1.4;
        fx.ring.scale.setScalar(r / 0.4);
        (fx.ring.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      }
      if (fx.flash) {
        (fx.flash.material as THREE.SpriteMaterial).opacity = fadeK;
        fx.flash.scale.setScalar(3.2 + fx.phaseAge * 4);
      }
    } else if (fx.def.element === "ice" && fx.crystals) {
      // The fracture front is `fx.front`; crystals whose birth-t has been
      // passed erupt. Each newly-erupted crystal deals one damage tick.
      const front = Math.min(1, fx.front);
      const sink = fx.phase === "fade";
      fx.crystals.update(dt, front, fadeK, sink);
      if (fx.phase === "travel" || fx.phase === "impact") {
        const erupted = fx.crystals.eruptedThisStep(front, fx.crystalTicked!);
        for (const c of erupted) {
          this.hooks.onDamage(
            c,
            fx.def.radius,
            fx.def.damage,
            fx.def.color,
            fx.def.knock,
          );
        }
      }
      if (fx.phase === "travel") {
        const lp = this.pointAt(fx, fx.front);
        fx.light.position.copy(lp).setY(lp.y + 0.8);
      }
      // Ice completes when the front arrives; skip fire's impact payoff.
      if (fx.phase === "impact" && fx.phaseAge >= IMPACT_T) {
        fx.phase = "fade";
        fx.phaseAge = 0;
      }
    } else if (fx.def.element === "thunder" && fx.lightning) {
      // Quantized flicker (reference behavior) then fade.
      const flicker = Math.random() > 0.4 ? 1 : 0.5;
      fx.lightning.update(dt);
      fx.lightning.setFade((fx.phase === "fade" ? fadeK : 1) * flicker);
      fx.light.intensity =
        fx.baseLightIntensity * (fx.phase === "fade" ? fadeK : flicker) +
        fx.lightBoost;
    } else if (fx.def.element === "nova" && fx.beam) {
      fx.beam.update(dt);
      if (fx.phase === "travel") {
        // Column races downrange; the orb spins up to full charge as it goes.
        fx.beam.setProgress(Math.min(1, fx.front));
        fx.beam.setCharge(Math.min(1, fx.front * 1.4));
        const lp = this.pointAt(fx, fx.front);
        fx.light.position.copy(lp).setY(lp.y + 1.0);
      } else if (fx.phase === "hold") {
        fx.beam.setProgress(1);
        fx.beam.setCharge(1);
        // A little breathing on the column width while it burns.
        const holdT = fx.def.hold ?? 1;
        const k = Math.min(1, fx.phaseAge / holdT);
        fx.beam.setWidthFade(1);
        fx.beam.setFade(1);
        void k;
      } else if (fx.phase === "fade") {
        fx.beam.setFade(fadeK);
        fx.beam.setWidthFade(fadeK);
      }
    } else if (fx.def.element === "snare" && fx.snare) {
      fx.snare.update(dt);
      const centre = fx.snareCentre ?? this.pointAt(fx, 1);
      const hand = fx.snareHand ?? this.pointAt(fx, 0);
      const R = fx.def.zoneRadius ?? 3.2;
      if (fx.phase === "travel") {
        // Leash whips toward the aim point (front eases out); ring stays small.
        const tip = hand.clone().lerp(centre, Math.min(1, fx.front));
        fx.snare.set(centre, hand, tip, 0.05 + 0.15 * fx.front, 0.05);
        fx.snare.setFade(1);
      } else if (fx.phase === "hold") {
        // Ring snaps open with an outCubic overshoot, then settles.
        const holdT = fx.def.hold ?? 1;
        const t = Math.min(1, fx.phaseAge / Math.min(0.35, holdT));
        const e = 1 - Math.pow(1 - t, 3);
        const overshoot = e + Math.sin(t * Math.PI) * 0.12;
        fx.snareSnap = e;
        fx.snare.set(centre, hand, centre.clone(), R * overshoot, 1.0 * e);
        fx.snare.setFade(1);
      } else if (fx.phase === "fade") {
        fx.snare.set(centre, hand, centre.clone(), R, 1.0);
        fx.snare.setFade(fadeK);
      }
      fx.light.position.copy(centre).setY(centre.y + 1.4);
    } else if (fx.def.element === "volley" && fx.volley) {
      const groundY = this.hooks.groundY ?? ((x, z) => (void x, void z, 0));
      // Advance falling arrows every frame; each landing pops a small dust
      // spark burst on the mesh floor.
      fx.volley.update(dt, groundY, (pos) => {
        const pal = elementPalette(fx.def);
        this.bursts.spawn(pal.burst, pos.clone().setY(pos.y + 0.15), {
          radius: 0.1,
          endRadius: 0.55,
          life: 0.35,
          intensity: 1.1,
          colorA: new THREE.Color(0xfff2c0),
          colorB: new THREE.Color(0xffd65a),
          colorC: new THREE.Color(0x8a6a2e),
        });
      });
      if (fx.phase === "travel") {
        // The signal arrow flies from the hand up to its apex along `front`.
        const from = fx.volleyLaunchFrom ?? this.pointAt(fx, 0);
        const apex = fx.volleyApex ?? from.clone().setY(from.y + 8);
        const t = Math.min(1, fx.front);
        const pos = from.clone().lerp(apex, t);
        // Slight ballistic slow-down near the apex.
        pos.y = from.y + (apex.y - from.y) * (t * (2 - t));
        const prevT = Math.max(0, t - 0.05);
        const prev = from.clone().lerp(apex, prevT);
        prev.y = from.y + (apex.y - from.y) * (prevT * (2 - prevT));
        const dir = pos.clone().sub(prev);
        if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
        fx.volley.setSignal(pos, dir.normalize(), true);
        fx.light.position.copy(pos);
        // Billboard ribbon trail behind the rising signal arrow.
        if (fx.ribbon && fx.ribbonPts && this.hooks.cameraPosition) {
          fx.ribbonPts.push(pos.clone());
          if (fx.ribbonPts.length > RIBBON_MAX_SEGMENTS + 1) fx.ribbonPts.shift();
          if (fx.ribbonPts.length >= 2) {
            fx.ribbon.build(
              fx.ribbonPts,
              0.6,
              this.hooks.cameraPosition(),
              (rt) => 0.12 + 0.88 * rt,
            );
          }
        }
      } else if (fx.phase === "fade") {
        fx.volley.setFade(fadeK);
        if (fx.ribbon) fx.ribbon.setOpacity(fadeK * fadeK);
      }
    }
  }

  /**
   * A point on the cast line, lifted to the actual terrain height when the
   * host provides one — the trajectory follows the ground, it does not slice
   * through rises or float over dips on the flat y=0 plane.
   */
  private pointAt(fx: CastEffect, t: number): THREE.Vector3 {
    const p = fx.origin.clone().addScaledVector(fx.dir, fx.distance * t);
    if (this.hooks.groundY) p.y = this.hooks.groundY(p.x, p.z);
    return p;
  }

  /* ---------- teardown ---------- */

  private disposeEffect(fx: CastEffect): void {
    // Ribbons live in the group; dispose their shader material + geometry
    // explicitly (traverse below disposes plain meshes but ShaderMaterials are
    // owned by the Ribbon/ZoneIndicator wrappers).
    if (fx.ribbon) fx.ribbon.dispose();
    if (fx.boltRibbon) fx.boltRibbon.dispose();
    if (fx.frontZone) {
      this.scene.remove(fx.frontZone.mesh);
      fx.frontZone.dispose();
    }
    // Wrapper classes own InstancedMeshes / ShaderMaterials: detach their
    // groups from fx.group and dispose explicitly so the traverse below can't
    // double-dispose (or touch) buffers they manage.
    const wrapperGroups: THREE.Object3D[] = [];
    if (fx.lightning) {
      wrapperGroups.push(fx.lightning.group);
      fx.lightning.dispose();
    }
    if (fx.beam) {
      wrapperGroups.push(fx.beam.group);
      fx.beam.dispose();
    }
    if (fx.snare) {
      wrapperGroups.push(fx.snare.group);
      fx.snare.dispose();
    }
    if (fx.crystals) {
      wrapperGroups.push(fx.crystals.group);
      fx.crystals.dispose();
    }
    if (fx.meteor) {
      wrapperGroups.push(fx.meteor.group);
      fx.meteor.dispose();
    }
    if (fx.volley) {
      wrapperGroups.push(fx.volley.group);
      fx.volley.dispose();
    }
    for (const g of wrapperGroups) g.removeFromParent();
    this.scene.remove(fx.group);
    fx.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      // Skip meshes owned by wrapper classes (their geo/mat already disposed).
      if (mesh === fx.ribbon?.mesh || mesh === fx.boltRibbon?.mesh) return;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) mat.dispose();
    });
  }

  clear(): void {
    for (const fx of this.active) this.disposeEffect(fx);
    this.active = [];
    for (const d of this.decals) this.removeDecal(d.mesh);
    this.decals = [];
  }

  /**
   * True when no cast effects are in flight and no ground decals remain.
   * Used by the host to cull an enemy's CastingSystem after it dies so that
   * spent systems do not keep receiving update() calls every frame.
   */
  get isSpent(): boolean {
    return this.active.length === 0 && this.decals.length === 0;
  }

  dispose(): void {
    this.clear();
    this.bursts.dispose();
    this.texture.dispose();
  }
}

/** Soft radial glow texture (self-contained; no external assets). */
function makeRadialTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * MOBA-style linear aim telegraph + AoE identifier shown while a cast winds up.
 *
 * Ported from the reference AimIndicator (SDF arrow silhouette with edge glow,
 * scrolling chevrons, base ring, tip glyph, range arc and an armed reveal
 * sweep) and ZoneIndicator (SDF footprint with boundary band, inner liner,
 * contour rings, rotating ticks, radar sweep and pulse). Both are metre-true
 * and driven live from the aim so the mouse steers them until release. Pure
 * presentation — the host still owns targeting and hands it
 * (origin, direction, length, radius, range).
 */
export class CastAimLine {
  private scene: THREE.Scene;
  private groundY?: (x: number, z: number) => number;
  private aim: AimIndicator;
  private zone: ZoneIndicator;
  private visible = false;
  /** Wall-clock seconds at the last set(), for frame-rate-independent uTime. */
  private lastMs = 0;
  /** Seconds since show(), for the reveal sweep (settings.aim.reveal ≈ 0.06). */
  private revealAge = 0;

  constructor(scene: THREE.Scene, groundY?: (x: number, z: number) => number) {
    this.scene = scene;
    this.groundY = groundY;
    this.aim = new AimIndicator();
    this.zone = new ZoneIndicator();
    scene.add(this.aim.mesh);
    scene.add(this.zone.mesh);
  }

  show(color: number): void {
    const edge = new THREE.Color(color);
    const core = edge.clone().lerp(new THREE.Color(0xffffff), 0.82);
    this.aim.setColors(core, edge);
    this.zone.setColors(core, edge);
    this.aim.setVisible(true);
    this.zone.setVisible(true);
    this.visible = true;
    this.revealAge = 0;
    this.lastMs = performance.now();
  }

  /**
   * Update the telegraph each frame while aiming.
   * @param k wind-up progress 0..1 (kept for API compat / opacity ramp)
   * @param radius the ability's damage radius (footprint), metres
   * @param range  the ability's maximum reach, metres (defaults to length)
   */
  set(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    length: number,
    k: number,
    radius?: number,
    range?: number,
    shape: "line" | "zone" = "line",
  ): void {
    if (!this.visible) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    this.revealAge += dt;
    this.aim.update(dt);
    this.zone.update(dt);

    const flat = dir.clone().setY(0);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, 1);
    flat.normalize();
    const yaw = Math.atan2(flat.x, flat.z);
    const dist = Math.max(1, length);
    const reveal = THREE.MathUtils.clamp(this.revealAge / 0.06 + k, 0, 1);

    if (shape === "zone") {
      // Far-cast telegraph: no arrow, a footprint circle sits at the clamped
      // aim point (origin + dir * distance).
      this.aim.setVisible(false);
      const end = origin.clone().addScaledVector(flat, dist);
      end.y = (this.groundY ? this.groundY(end.x, end.z) : 0) + 0.05;
      const r = radius ?? (range ? Math.min(range, 3.2) : 3.2);
      this.zone.place(end, yaw, r, reveal, true, 0.85 + 0.15 * k);
      return;
    }

    // The arrow sweeps out over ~0.06 s when armed (settings.aim.reveal), then
    // holds; `k` nudges it fully open near release.
    this.aim.setVisible(true);
    this.aim.place(origin, yaw, dist, this.groundY, reveal, true);

    // AoE footprint at the line's end, sized to the damage radius.
    const r = radius ?? 2;
    const end = origin.clone().addScaledVector(flat, dist);
    end.y = (this.groundY ? this.groundY(end.x, end.z) : 0) + 0.05;
    void range;
    this.zone.place(end, yaw, r, reveal, true, 0.85 + 0.15 * k);
  }

  hide(): void {
    this.visible = false;
    this.aim.setVisible(false);
    this.zone.setVisible(false);
  }

  dispose(): void {
    this.scene.remove(this.aim.mesh);
    this.scene.remove(this.zone.mesh);
    this.aim.dispose();
    this.zone.dispose();
  }
}

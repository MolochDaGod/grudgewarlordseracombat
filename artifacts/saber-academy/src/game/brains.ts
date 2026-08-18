/**
 * Grudge AI brains for this arena — Yuka steers the ROOT only.
 * One mixer stays on the kit. Rapier/moveBody still owns collision.
 *
 * Numbers copy fleet AGGRO_CONFIG / THREAT_CONFIG (grudge-ai-brains).
 * Do not invent new metres. Do not import Actor.js (second mixer).
 */
import {
  ArriveBehavior,
  FleeBehavior,
  SeekBehavior,
  Vector3 as YukaVec3,
  Vehicle,
  WanderBehavior,
} from "yuka";

/** Fleet aggro rings (metres). */
export const AGGRO_CONFIG = {
  detectionRadius: 25,
  aggroRadius: 15,
  assistRadius: 30,
  leashRadius: 50,
  losTimeoutSeconds: 8,
  checkIntervalMs: 500,
} as const;

/** ThreeFlow / uMMORPG threat defaults. */
export const THREAT_CONFIG = {
  damageMul: 1,
  healMul: 0.5,
  tankMul: 1.5,
  decayPerSec: 4,
  tauntThreat: 10000,
  tauntLockSec: 3,
} as const;

export type BrainBehavior =
  | "idle"
  | "wander"
  | "patrol"
  | "follow"
  | "pursue"
  | "flee";

export type TelegraphVariant = "aoe" | "cone" | "incoming";

export interface MmoCombatStamp {
  aggro: {
    detectionRadius: number;
    aggroRadius: number;
    assistRadius: number;
    leashRadius: number;
    losTimeoutSeconds: number;
  };
  threat: { tankMul: number; decayPerSec: number };
  cast: { castTimeSec: number; interruptWindowSec: number; skillId: string };
  telegraph: {
    variant: TelegraphVariant;
    telegraphSec: number;
    range: number;
    arc: number;
  };
  behavior: BrainBehavior;
}

export function defaultMmoCombat(
  partial?: Partial<MmoCombatStamp>,
): MmoCombatStamp {
  return {
    aggro: { ...AGGRO_CONFIG },
    threat: {
      tankMul: THREAT_CONFIG.tankMul,
      decayPerSec: THREAT_CONFIG.decayPerSec,
    },
    cast: { castTimeSec: 1.6, interruptWindowSec: 0.8, skillId: "" },
    telegraph: { variant: "cone", telegraphSec: 0.45, range: 3.2, arc: 1.2 },
    behavior: "pursue",
    ...partial,
    aggro: { ...AGGRO_CONFIG, ...partial?.aggro },
    threat: {
      tankMul: THREAT_CONFIG.tankMul,
      decayPerSec: THREAT_CONFIG.decayPerSec,
      ...partial?.threat,
    },
    cast: {
      castTimeSec: 1.6,
      interruptWindowSec: 0.8,
      skillId: "",
      ...partial?.cast,
    },
    telegraph: {
      variant: "cone",
      telegraphSec: 0.45,
      range: 3.2,
      arc: 1.2,
      ...partial?.telegraph,
    },
  };
}

export function pickWarningVariant(opts: {
  slam?: boolean;
  range: number;
  bow?: boolean;
  arc?: number;
}): TelegraphVariant {
  if (opts.slam || (opts.arc ?? 0) >= 1.6 * Math.PI) return "aoe";
  if (opts.range >= 12 || opts.bow) return "incoming";
  return "cone";
}

export class ThreatTable {
  private readonly entries = new Map<string, number>();
  lockUntil = 0;
  lockedId: string | null = null;

  add(id: string, amount: number): void {
    if (amount <= 0) return;
    this.entries.set(id, (this.entries.get(id) ?? 0) + amount);
  }

  taunt(id: string, nowSec: number, amount = THREAT_CONFIG.tauntThreat): void {
    this.add(id, amount);
    this.lockedId = id;
    this.lockUntil = nowSec + THREAT_CONFIG.tauntLockSec;
  }

  tick(dt: number, decayPerSec: number, nowSec: number): void {
    if (this.lockedId && nowSec >= this.lockUntil) this.lockedId = null;
    for (const [id, v] of this.entries) {
      const next = v - decayPerSec * dt;
      if (next <= 0) this.entries.delete(id);
      else this.entries.set(id, next);
    }
  }

  top(): string | null {
    if (this.lockedId && this.entries.has(this.lockedId)) return this.lockedId;
    let best: string | null = null;
    let bestV = 0;
    for (const [id, v] of this.entries) {
      if (v > bestV) {
        bestV = v;
        best = id;
      }
    }
    return best;
  }

  topValue(): number {
    const id = this.top();
    return id ? (this.entries.get(id) ?? 0) : 0;
  }

  snapshot(): { id: string; v: number }[] {
    return [...this.entries.entries()]
      .map(([id, v]) => ({ id, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 6);
  }
}

export type SteerMode = "idle" | "wander" | "seek" | "arrive" | "flee";

/**
 * One Yuka Vehicle per fighter. Writes desired XZ only — never bones, never
 * a second mixer, never a second physics world.
 */
export class CombatSteering {
  readonly vehicle = new Vehicle();
  private readonly seekTarget = new YukaVec3();
  private readonly seek = new SeekBehavior(this.seekTarget);
  private readonly arrive = new ArriveBehavior(this.seekTarget);
  private readonly flee = new FleeBehavior(this.seekTarget);
  private readonly wander = new WanderBehavior();
  private mode: SteerMode = "idle";

  constructor() {
    this.vehicle.maxForce = 40;
    this.vehicle.maxSpeed = 4;
    this.wander.wanderRadius = 4;
    this.wander.wanderDistance = 6;
  }

  syncFrom(x: number, z: number, maxSpeed: number): void {
    this.vehicle.position.set(x, 0, z);
    this.vehicle.maxSpeed = Math.max(0.4, maxSpeed);
  }

  setMode(mode: SteerMode, targetX?: number, targetZ?: number): void {
    if (targetX !== undefined && targetZ !== undefined) {
      this.seekTarget.set(targetX, 0, targetZ);
    }
    if (mode === this.mode) return;
    const sm = this.vehicle.steering as {
      clear?: () => void;
      _behaviors?: unknown[];
    };
    if (typeof sm.clear === "function") sm.clear();
    else if (Array.isArray(sm._behaviors)) sm._behaviors.length = 0;
    this.mode = mode;
    if (mode === "seek") this.vehicle.steering.add(this.seek);
    else if (mode === "arrive") this.vehicle.steering.add(this.arrive);
    else if (mode === "flee") this.vehicle.steering.add(this.flee);
    else if (mode === "wander") this.vehicle.steering.add(this.wander);
  }

  getMode(): SteerMode {
    return this.mode;
  }

  /** Desired XZ velocity after a Yuka step. */
  step(dt: number): { vx: number; vz: number } {
    if (this.mode === "idle") {
      this.vehicle.velocity.set(0, 0, 0);
      return { vx: 0, vz: 0 };
    }
    this.vehicle.update(dt);
    return { vx: this.vehicle.velocity.x, vz: this.vehicle.velocity.z };
  }
}

export function aggroState(
  dist: number,
  fromSpawn: number,
  cfg: MmoCombatStamp["aggro"],
): "leash" | "idle" | "alert" | "aggro" {
  if (fromSpawn > cfg.leashRadius) return "leash";
  if (dist <= cfg.aggroRadius) return "aggro";
  if (dist <= cfg.detectionRadius) return "alert";
  return "idle";
}

export interface AiCatalog {
  aggro: MmoCombatStamp["aggro"];
  threat: { tankMul: number; decayPerSec: number; damageMul: number };
  defaultBehavior: BrainBehavior;
  meleeTelegraphSec: number;
  spellTelegraphSec: number;
}

/** Ally squad — follow slots + peel. Metres from AGGRO_CONFIG, not new rings. */
export const ALLY_AI = {
  followStart: 4.5,
  followHold: 2.8,
  fleeHp: 0.22,
  peelThreat: 48,
} as const;

/** Fan behind the player so allies do not stack on the capsule. */
export function allyFormationOffset(
  slot: number,
  count: number,
  yaw: number,
): { x: number; z: number } {
  const i = slot - (count - 1) * 0.5;
  const back = 2.6;
  const side = i * 1.35;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return { x: -s * back + c * side, z: -c * back + s * side };
}

export function defaultAiCatalog(): AiCatalog {
  return {
    aggro: { ...AGGRO_CONFIG },
    threat: {
      tankMul: THREAT_CONFIG.tankMul,
      decayPerSec: THREAT_CONFIG.decayPerSec,
      damageMul: THREAT_CONFIG.damageMul,
    },
    defaultBehavior: "pursue",
    meleeTelegraphSec: 0.45,
    spellTelegraphSec: 1.6,
  };
}

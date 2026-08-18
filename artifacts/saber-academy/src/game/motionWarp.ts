/**
 * Samurai TPS motion-warp (Attack.js) — numbers only.
 * Controller still owns position. One mixer. No samurai mesh / HUD / ragdoll.
 *
 * Turn first (turnAt), then close to standoff. Heavy can passThrough.
 */
export interface WarpConfig {
  standoff: number;
  maxWarp: number;
  warpAt: number;
  turnAt: number;
  passThrough: number;
  passAt: number;
  reach: number;
  coneDot: number;
}

export const LIGHT_WARP: WarpConfig = {
  standoff: 2.15,
  maxWarp: 4.6,
  warpAt: 0.42,
  turnAt: 0.35,
  passThrough: 0,
  passAt: 1,
  reach: 3.1,
  coneDot: 0.35,
};

export const HEAVY_WARP: WarpConfig = {
  standoff: 1.7,
  maxWarp: 6.2,
  warpAt: 0.38,
  turnAt: 0.28,
  passThrough: 2.4,
  passAt: 0.92,
  reach: 3.4,
  coneDot: 0.22,
};

export interface MotionWarp {
  active: boolean;
  x: number;
  z: number;
  yaw: number;
  fromX: number;
  fromZ: number;
  fromYaw: number;
  toX: number;
  toZ: number;
  toYaw: number;
  pastX: number;
  pastZ: number;
  cfg: WarpConfig;
}

export function emptyWarp(cfg: WarpConfig): MotionWarp {
  return {
    active: false,
    x: 0,
    z: 0,
    yaw: 0,
    fromX: 0,
    fromZ: 0,
    fromYaw: 0,
    toX: 0,
    toZ: 0,
    toYaw: 0,
    pastX: 0,
    pastZ: 0,
    cfg,
  };
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function shortestYaw(from: number, to: number): number {
  return (
    ((((to - from + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
    Math.PI
  );
}

export function resolveWarp(
  px: number,
  pz: number,
  yaw: number,
  tx: number | null,
  tz: number | null,
  cfg: WarpConfig,
): MotionWarp {
  const w = emptyWarp(cfg);
  w.fromX = px;
  w.fromZ = pz;
  w.fromYaw = yaw;
  w.x = px;
  w.z = pz;
  w.yaw = yaw;
  if (tx === null || tz === null) return w;
  const dx = tx - px;
  const dz = tz - pz;
  const dist = Math.hypot(dx, dz);
  w.toYaw = dist > 1e-4 ? Math.atan2(dx, dz) : yaw;
  const step = Math.min(cfg.maxWarp, Math.max(0, dist - cfg.standoff));
  const k = dist > 1e-4 ? step / dist : 0;
  w.toX = px + dx * k;
  w.toZ = pz + dz * k;
  const ux = dist > 1e-4 ? dx / dist : Math.sin(w.toYaw);
  const uz = dist > 1e-4 ? dz / dist : Math.cos(w.toYaw);
  const beyond = cfg.passThrough > 0 ? cfg.standoff + cfg.passThrough : 0;
  w.pastX = w.toX + ux * beyond;
  w.pastZ = w.toZ + uz * beyond;
  w.active = true;
  return w;
}

/** Advance warp for clip phase 0..1. Writes x/z/yaw. */
export function advanceWarp(w: MotionWarp, phase: number): void {
  if (!w.active) return;
  const cfg = w.cfg;
  const warpAt = Math.max(0.01, cfg.warpAt);
  const t = Math.min(1, Math.max(0, phase / warpAt));
  const turn = smootherstep(Math.min(1, t / Math.max(0.05, cfg.turnAt)));
  w.yaw = w.fromYaw + shortestYaw(w.fromYaw, w.toYaw) * turn;

  if (cfg.passThrough > 0) {
    if (phase <= warpAt) {
      const move = t * t;
      w.x = w.fromX + (w.toX - w.fromX) * move;
      w.z = w.fromZ + (w.toZ - w.fromZ) * move;
    } else {
      const passAt = Math.max(warpAt + 0.01, cfg.passAt);
      const u = Math.min(1, Math.max(0, (phase - warpAt) / (passAt - warpAt)));
      const move = 1 - (1 - u) * (1 - u);
      w.x = w.toX + (w.pastX - w.toX) * move;
      w.z = w.toZ + (w.pastZ - w.toZ) * move;
    }
  } else {
    const move = smootherstep(t);
    w.x = w.fromX + (w.toX - w.fromX) * move;
    w.z = w.fromZ + (w.toZ - w.fromZ) * move;
  }
}

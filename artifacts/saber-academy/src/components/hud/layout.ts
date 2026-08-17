/**
 * HUD layout persistence for the movable-panel system.
 *
 * Each panel stores its top-left anchor as a fraction of the viewport
 * (0..1), so a layout survives window resizes and different screens.
 * Layouts are saved to localStorage when the player drags a panel in
 * "Edit UI" mode and restored on load; "Reset Layout" clears the store.
 */

export type PanelId =
  | "player"
  | "target"
  | "actionbar"
  | "castbar"
  | "info"
  | "combo";

export interface PanelPos {
  /** Fraction of viewport width for the panel's anchor (0..1). */
  x: number;
  /** Fraction of viewport height for the panel's anchor (0..1). */
  y: number;
}

export type HudLayout = Record<PanelId, PanelPos>;

const STORE_KEY = "saber-hud-layout-v1";

/** Default MMO-style arrangement (fractions of the viewport). */
export const DEFAULT_LAYOUT: HudLayout = {
  player: { x: 0.015, y: 0.02 },
  target: { x: 0.5, y: 0.02 },
  actionbar: { x: 0.5, y: 0.86 },
  castbar: { x: 0.5, y: 0.68 },
  info: { x: 0.985, y: 0.02 },
  combo: { x: 0.85, y: 0.4 },
};

/** Panels whose anchor is their top-center rather than top-left. */
export const CENTERED: ReadonlySet<PanelId> = new Set([
  "target",
  "actionbar",
  "castbar",
]);

/** Panels anchored by their top-right corner. */
export const RIGHT_ANCHORED: ReadonlySet<PanelId> = new Set(["info"]);

export function loadLayout(): HudLayout {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<HudLayout>;
    const out = { ...DEFAULT_LAYOUT };
    for (const id of Object.keys(out) as PanelId[]) {
      const p = parsed[id];
      if (
        p &&
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        isFinite(p.x) &&
        isFinite(p.y)
      ) {
        out[id] = { x: clamp01(p.x), y: clamp01(p.y) };
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: HudLayout): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  } catch {
    // Storage unavailable (private mode); layout just won't persist.
  }
}

export function clearLayout(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

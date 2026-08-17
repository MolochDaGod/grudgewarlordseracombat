import { useCallback, useRef } from "react";
import type { ReactNode } from "react";
import {
  CENTERED,
  RIGHT_ANCHORED,
  clamp01,
  type HudLayout,
  type PanelId,
} from "./layout";

interface HudPanelProps {
  id: PanelId;
  label: string;
  layout: HudLayout;
  editing: boolean;
  onMove: (id: PanelId, x: number, y: number) => void;
  children: ReactNode;
  /** Hide the panel entirely when not editing (e.g. empty cast bar). */
  hidden?: boolean;
}

/**
 * Positioned HUD panel. In Edit UI mode it gets a dashed outline + name tag
 * and can be dragged anywhere; positions snap to a 0.5%-of-viewport grid and
 * are reported to the layout store on drop.
 */
export function HudPanel({
  id,
  label,
  layout,
  editing,
  onMove,
  children,
  hidden,
}: HudPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(
    null,
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      const p = layout[id];
      drag.current = { px: e.clientX, py: e.clientY, x: p.x, y: p.y };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

      const move = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const nx = d.x + (ev.clientX - d.px) / window.innerWidth;
        const ny = d.y + (ev.clientY - d.py) / window.innerHeight;
        // Snap to a fine grid so aligned panels stay aligned.
        const snap = (v: number) => Math.round(clamp01(v) * 200) / 200;
        onMove(id, snap(nx), snap(ny));
      };
      const up = () => {
        drag.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [editing, id, layout, onMove],
  );

  if (hidden && !editing) return null;

  const p = layout[id];
  const style: React.CSSProperties = {
    left: `${p.x * 100}%`,
    top: `${p.y * 100}%`,
    transform: CENTERED.has(id)
      ? "translateX(-50%)"
      : RIGHT_ANCHORED.has(id)
        ? "translateX(-100%)"
        : undefined,
  };

  return (
    <div
      ref={ref}
      className={`mmo-panel${editing ? " editing" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
    >
      {editing && <span className="mmo-panel-tag">{label}</span>}
      {children}
    </div>
  );
}

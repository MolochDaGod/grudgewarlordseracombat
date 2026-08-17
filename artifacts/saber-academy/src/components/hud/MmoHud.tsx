import { useCallback, useEffect, useState } from "react";
import type { HudState, SkillHud } from "../../game/SaberGame";
import { HudPanel } from "./HudPanel";
import {
  DEFAULT_LAYOUT,
  clearLayout,
  loadLayout,
  saveLayout,
  type HudLayout,
  type PanelId,
} from "./layout";
import "./hud.css";

const UI = (import.meta.env.BASE_URL || "/") + "ui/";

/** Per-skill icon from the kit's 128x128 icon set (fallback: sword). */
function skillIcon(s: SkillHud): string {
  const id = s.id;
  if (id === "cast-fire") return "Icon_Fireball_128.png";
  if (id === "cast-ice") return "Icon_Leafs_128.png";
  if (id === "cast-thunder") return "Icon_Deathkiss_128.png";
  if (id === "force-push") return "Icon_Shield_128.png";
  if (/boomerang|blade|arrow|bow/i.test(s.name)) return "Icon_Arrows_128.png";
  return "Icon_Sword_128.png";
}

export interface EquipmentInfo {
  name: string;
  title: string;
  weapon: string;
  faction: string;
}

/** Equipment slots shown in the character window, in display order. */
const EQUIP_SLOTS: { key: string; art: string }[] = [
  { key: "Head", art: "Head" },
  { key: "Necklace", art: "Necklace" },
  { key: "Shoulders", art: "Shoulders" },
  { key: "Chest", art: "Chest" },
  { key: "Shirt", art: "Shirt" },
  { key: "Bracers", art: "Bracers" },
  { key: "Gloves", art: "Gloves" },
  { key: "Belt", art: "Belt" },
  { key: "Pants", art: "Pants" },
  { key: "Boots", art: "Boots" },
  { key: "Finger", art: "Finger" },
  { key: "Trinket", art: "Trinket" },
  { key: "Weapon", art: "Weapon" },
  { key: "Shield", art: "Shield" },
];

/** Which kit icon represents the hero's weapon in the equipment window. */
function weaponIcon(weapon: string): string {
  const w = weapon.toLowerCase();
  if (w.includes("bow")) return "Icon_Arrows_128.png";
  if (w.includes("staff")) return "Icon_Fireball_128.png";
  return "Icon_Sword_128.png";
}

interface MmoHudProps {
  hud: HudState;
  equipment: EquipmentInfo | null;
  /** HUD menus borrow the mouse from the game (pointer lock) while open. */
  onUiMouse: (on: boolean) => void;
  sandboxControls?: React.ReactNode;
}

/**
 * The in-combat RPG/MMO HUD, skinned with the uploaded UI kit:
 * unit frames, action bar with globes and cooldown sweeps, cast bar,
 * game menu window, equipment window, and a movable-panel Edit UI mode.
 */
export function MmoHud({ hud, equipment, onUiMouse, sandboxControls }: MmoHudProps) {
  const [layout, setLayout] = useState<HudLayout>(() => loadLayout());
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [charOpen, setCharOpen] = useState(false);

  const uiOwnsMouse = editing || menuOpen || charOpen;
  useEffect(() => {
    onUiMouse(uiOwnsMouse);
  }, [uiOwnsMouse, onUiMouse]);
  // Return the mouse if the HUD unmounts mid-menu (round ended).
  useEffect(() => () => onUiMouse(false), [onUiMouse]);

  // Hotkeys: O = game menu, C = character sheet (while playing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "KeyO") setMenuOpen((v) => !v);
      else if (e.code === "KeyC") setCharOpen((v) => !v);
      else if (e.code === "Escape" && (menuOpen || charOpen || editing)) {
        setMenuOpen(false);
        setCharOpen(false);
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, charOpen, editing]);

  const onMove = useCallback((id: PanelId, x: number, y: number) => {
    setLayout((prev) => {
      const next = { ...prev, [id]: { x, y } };
      saveLayout(next);
      return next;
    });
  }, []);

  const resetLayout = useCallback(() => {
    clearLayout();
    setLayout({ ...DEFAULT_LAYOUT });
  }, []);

  const healthPct = Math.max(0, hud.playerHealth / hud.playerMaxHealth);
  const forcePct = Math.max(0, hud.forceEnergy / hud.forceMaxEnergy);
  const xpPct = (hud.score % 1000) / 1000;

  const panel = (id: PanelId, label: string, node: React.ReactNode, hidden = false) => (
    <HudPanel
      id={id}
      label={label}
      layout={layout}
      editing={editing}
      onMove={onMove}
      hidden={hidden}
    >
      {node}
    </HudPanel>
  );

  // CSS background images must respect the artifact base path, so they are
  // injected as custom properties instead of hardcoded /ui/ urls in the css.
  const uiVars = {
    "--ui-uf-bg": `url("${UI}UnitFrame_Background.png")`,
    "--ui-uf-red": `url("${UI}UnitFrame_Red_Border.png")`,
    "--ui-win-bg": `url("${UI}Window_Background.png")`,
    "--ui-win-header": `url("${UI}Window_Header_Background.png")`,
    "--ui-close-bg": `url("${UI}Window_CloseBtn_Background.png")`,
    "--ui-menu-btn": `url("${UI}GameMenu_Button_Foreground_Yellow.png")`,
    "--ui-menu-btn-hover": `url("${UI}GameMenu_Button_Hover_Yellow.png")`,
  } as React.CSSProperties;

  return (
    <div className={`mmo-hud${editing ? " edit-mode" : ""}`} style={uiVars}>
      {editing && (
        <div className="mmo-edit-banner">
          Edit UI — drag panels where you want them. Press ESC or the button to
          finish.
          <button className="mmo-btn" onClick={() => setEditing(false)}>
            Done
          </button>
          <button className="mmo-btn" onClick={resetLayout}>
            Reset Layout
          </button>
        </div>
      )}

      {/* ---- player unit frame ---- */}
      {panel(
        "player",
        "Player Frame",
        <div className="unit-frame">
          <div className="uf-avatar">
            <span
              className="uf-avatar-glyph"
              style={{ color: hud.factionColor }}
            >
              {(hud.playerName || "?").charAt(0)}
            </span>
            <img src={`${UI}UnitFrame_Avatar_Overlay.png`} alt="" />
          </div>
          <div className="uf-body">
            <div className="uf-name">
              {hud.playerName || "Guardian"}
              {hud.blocking && <span className="uf-guard">GUARD</span>}
            </div>
            <div className="uf-bar hp">
              <div className="uf-fill" style={{ width: `${healthPct * 100}%` }}>
                <img src={`${UI}UnitFrame_HP_Fill_Red.png`} alt="" />
              </div>
              <span className="uf-bar-text">
                {hud.playerHealth} / {hud.playerMaxHealth}
              </span>
            </div>
            <div className="uf-bar mp">
              <div className="uf-fill" style={{ width: `${forcePct * 100}%` }}>
                <img src={`${UI}UnitFrame_MP_Fill_Green.png`} alt="" />
              </div>
              <span className="uf-bar-text">{Math.round(hud.forceEnergy)}</span>
            </div>
          </div>
          <div className="uf-level">
            <img src={`${UI}UnitFrame_Level_Background.png`} alt="" />
            <span>{hud.wave}</span>
          </div>
        </div>,
      )}

      {/* ---- target frame ---- */}
      {panel(
        "target",
        "Target Frame",
        hud.target ? (
          <div className={`unit-frame target${hud.target.locked ? " locked" : ""}`}>
            <div className="uf-body">
              <div className="uf-name">
                {hud.target.name}
                {hud.target.locked && <span className="uf-lock">LOCKED</span>}
              </div>
              <div className="uf-bar hp">
                <div
                  className="uf-fill"
                  style={{ width: `${hud.target.healthPct * 100}%` }}
                >
                  <img src={`${UI}UnitFrame_HP_Fill_Red.png`} alt="" />
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="unit-frame target placeholder">
            <div className="uf-body">
              <div className="uf-name">No Target</div>
            </div>
          </div>
        ),
        !hud.target,
      )}

      {/* ---- cast bar ---- */}
      {panel(
        "castbar",
        "Cast Bar",
        hud.castBar ? (
          <div className="cast-bar">
            <img className="cb-bg" src={`${UI}CastBar_Background.png`} alt="" />
            <div
              className="cb-fill"
              style={{
                width: `${hud.castBar.t01 * 100}%`,
                background: hud.castBar.color,
              }}
            />
            <span className="cb-name">{hud.castBar.name}</span>
          </div>
        ) : (
          <div className="cast-bar empty" />
        ),
        !hud.castBar,
      )}

      {/* ---- action bar with globes + xp ---- */}
      {panel(
        "actionbar",
        "Action Bar",
        <div className="action-dock">
          <div className="xp-bar">
            <img className="xp-bg" src={`${UI}ActionBar_XP_Background.png`} alt="" />
            <div className="xp-fill" style={{ width: `${xpPct * 100}%` }}>
              <img src={`${UI}ActionBar_XP_Fill.png`} alt="" />
            </div>
          </div>
          <div className="action-row">
            <Globe pct={healthPct} fill="ActionBar_Globe_Fill_Red.png" label={`${hud.playerHealth}`} />
            <div className="slot-row">
              {hud.skills.map((s) => (
                <div
                  key={s.id}
                  className={`ab-slot${s.ready ? " ready" : ""}`}
                  title={`${s.name} (${s.cost} force)`}
                >
                  <img className="ab-bg" src={`${UI}ActionBar_Slot_Background.png`} alt="" />
                  <img className="ab-icon" src={UI + skillIcon(s)} alt={s.name} />
                  {s.cooldownPct > 0 && (
                    <div
                      className="ab-cd"
                      style={{ height: `${Math.round(s.cooldownPct * 100)}%` }}
                    />
                  )}
                  <img className="ab-overlay" src={`${UI}ActionBar_Slot_Overlay.png`} alt="" />
                  <span className="ab-key">{s.key}</span>
                </div>
              ))}
            </div>
            <Globe pct={forcePct} fill="ActionBar_Globe_Fill_Blue.png" label={`${Math.round(hud.forceEnergy)}`} />
          </div>
        </div>,
      )}

      {/* ---- score / wave info ---- */}
      {panel(
        "info",
        "Score Panel",
        <div className="info-panel">
          <div className="info-score">{hud.score.toLocaleString()}</div>
          <div className="info-line">
            Wave {hud.wave} / {hud.totalWaves}
          </div>
          <div className="info-line dim">{hud.enemiesRemaining} hostiles</div>
        </div>,
      )}

      {/* ---- combo ---- */}
      {panel(
        "combo",
        "Combo",
        hud.combo > 1 ? (
          <div className="mmo-combo">
            <span className="mmo-combo-num">{hud.combo}</span>
            <span className="mmo-combo-text">COMBO</span>
          </div>
        ) : (
          <div className="mmo-combo placeholder">
            <span className="mmo-combo-num">0</span>
            <span className="mmo-combo-text">COMBO</span>
          </div>
        ),
        hud.combo <= 1,
      )}

      {hud.message && <div className="center-msg">{hud.message}</div>}

      {/* ---- fixed menu button (not movable; it opens the mover) ---- */}
      <button
        className="mmo-menu-btn"
        title="Game Menu (O)"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <img src={`${UI}Minimap_Menu_Button_Background.png`} alt="" />
        <img className="mmb-icon" src={`${UI}Minimap_Menu_Button_Icon.png`} alt="Menu" />
      </button>

      {sandboxControls}

      {/* ---- game menu window ---- */}
      {menuOpen && (
        <div className="mmo-window game-menu">
          <div className="mmo-window-header">
            <span>Game Menu</span>
            <button className="mmo-close" onClick={() => setMenuOpen(false)}>
              ×
            </button>
          </div>
          <div className="mmo-window-body menu-body">
            <button
              className="menu-btn"
              onClick={() => {
                setMenuOpen(false);
                setCharOpen(true);
              }}
            >
              Character (C)
            </button>
            <button
              className="menu-btn"
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              Edit UI
            </button>
            <button className="menu-btn" onClick={resetLayout}>
              Reset UI Layout
            </button>
            <button className="menu-btn" onClick={() => setMenuOpen(false)}>
              Resume
            </button>
          </div>
        </div>
      )}

      {/* ---- character / equipment window ---- */}
      {charOpen && (
        <div className="mmo-window char-window">
          <div className="mmo-window-header">
            <span>{equipment?.name ?? hud.playerName ?? "Character"}</span>
            <button className="mmo-close" onClick={() => setCharOpen(false)}>
              ×
            </button>
          </div>
          <div className="mmo-window-body">
            <div className="char-title">{equipment?.title ?? hud.playerTitle}</div>
            <div className="char-faction" style={{ color: hud.factionColor }}>
              {equipment?.faction ?? ""}
            </div>
            <div className="equip-grid">
              {EQUIP_SLOTS.map((slot) => {
                const isWeapon = slot.key === "Weapon";
                const isShield =
                  slot.key === "Shield" &&
                  /shield/i.test(equipment?.weapon ?? "");
                const filled = isWeapon || isShield;
                return (
                  <div key={slot.key} className={`equip-slot${filled ? " filled" : ""}`} title={slot.key}>
                    <img
                      className="es-bg"
                      src={`${UI}CharacterWindow_Slot_${slot.art}.png`}
                      alt={slot.key}
                    />
                    {isWeapon && equipment && (
                      <img className="es-icon" src={UI + weaponIcon(equipment.weapon)} alt={equipment.weapon} />
                    )}
                    {isShield && (
                      <img className="es-icon" src={`${UI}Icon_Shield_128.png`} alt="Shield" />
                    )}
                  </div>
                );
              })}
            </div>
            {equipment && (
              <div className="char-weapon-line">
                Armed with: <b>{equipment.weapon}</b>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Health/force orb: kit globe background with a bottom-up clipped fill. */
function Globe({ pct, fill, label }: { pct: number; fill: string; label: string }) {
  const clip = Math.round((1 - Math.max(0, Math.min(1, pct))) * 100);
  return (
    <div className="mmo-globe" title={label}>
      <img className="globe-empty" src={`${UI}ActionBar_Globe_Fill_Empty.png`} alt="" />
      <img
        className="globe-fill"
        src={UI + fill}
        alt=""
        style={{ clipPath: `inset(${clip}% 0 0 0)` }}
      />
      <img className="globe-frame" src={`${UI}ActionBar_Globe_Background.png`} alt="" />
      <span className="globe-label">{label}</span>
    </div>
  );
}

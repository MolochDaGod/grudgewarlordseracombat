import { useEffect, useMemo, useRef, useState } from "react";
import type { SaberGame } from "@/game/SaberGame";
import type { WeaponSkillCatalog } from "@/game/skillcatalog";
import {
  SPRITE_EFFECTS,
  CAST_EFFECTS,
  SKILL_KINDS,
  CAST_ELEMENTS,
  CLIP_NAMES,
  keyLabel,
} from "@/game/skillcatalog";
import { studioSaveAvailable } from "@/game/studio";
import {
  BUFF_TYPES,
  BUFF_TARGETS,
  BUFF_TYPE_LABELS,
  BUFF_TARGET_LABELS,
  DEFAULT_BUFF,
  type BuffDef,
  type BuffType,
  type BuffTarget,
} from "@/game/buffs";

/**
 * Weapon Skill Studio admin panel (React HUD, dev editor). Edits the live,
 * in-memory weapon-skill catalog the running game reads; every change is
 * applied to the studio player instantly (studioApplyCatalog) so pressing the
 * skill's hotkey shows the new behavior immediately. Save writes the JSON back
 * to the game files via the dev-only endpoint.
 */

type Tab = "skill" | "cast" | "ranged";

// ---- Buff/Debuff sub-editor ------------------------------------------------

/** Inline list editor for an array of BuffDef riders on a skill or cast. */
function BuffEditor({
  buffs,
  onChange,
}: {
  buffs: BuffDef[];
  onChange: (next: BuffDef[]) => void;
}) {
  function update(i: number, patch: Partial<BuffDef>) {
    const next = buffs.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    onChange(next);
  }
  function add() {
    onChange([...buffs, { ...DEFAULT_BUFF }]);
  }
  function remove(i: number) {
    onChange(buffs.filter((_, idx) => idx !== i));
  }

  return (
    <div className="wss-buff-list">
      {buffs.length === 0 && (
        <div className="wss-buff-empty">No buffs — click + to add one.</div>
      )}
      {buffs.map((b, i) => (
        <div key={i} className="wss-buff-entry">
          <label className="wss-field">
            <span>Type</span>
            <select
              value={b.type}
              onChange={(e) => update(i, { type: e.target.value as BuffType })}
            >
              {BUFF_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BUFF_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="wss-field">
            <span>Target</span>
            <select
              value={b.target}
              onChange={(e) => update(i, { target: e.target.value as BuffTarget })}
            >
              {BUFF_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {BUFF_TARGET_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="wss-field">
            <span>Magnitude</span>
            <input
              type="number"
              value={b.magnitude}
              step={b.type === "slow" || b.type === "haste" ? 0.05 : 1}
              min={0}
              max={b.type === "slow" || b.type === "haste" ? 0.9 : 10000}
              onChange={(e) => update(i, { magnitude: parseFloat(e.target.value) || 0 })}
            />
          </label>
          <label className="wss-field">
            <span>Duration (s)</span>
            <input
              type="number"
              value={b.duration}
              step={0.5}
              min={0.1}
              max={30}
              onChange={(e) => update(i, { duration: parseFloat(e.target.value) || 1 })}
            />
          </label>
          <button className="wss-buff-remove" onClick={() => remove(i)}>
            ✕
          </button>
        </div>
      ))}
      <button className="wss-buff-add" onClick={add}>
        + Add buff
      </button>
    </div>
  );
}

/**
 * KeyboardEvent.code values that may NOT be rebound: movement, jump, sprint/
 * block modifiers, target cycle, and mouse-critical / browser control keys.
 * Keeping these off-limits stops the Studio from clobbering core controls.
 */
const RESERVED_CODES = new Set<string>([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "Tab",
  "Escape",
  "Enter",
  "CapsLock",
  "ContextMenu",
]);

/** Convert an integer color to a #rrggbb string for <input type=color>. */
function toHex(n: number): string {
  return "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);
}
function fromHex(s: string): number {
  return parseInt(s.replace("#", ""), 16) || 0;
}

export function WeaponSkillStudioPanel({
  game,
  onUiMouse,
}: {
  game: SaberGame;
  onUiMouse: (on: boolean) => void;
}) {
  const [cat, setCat] = useState<WeaponSkillCatalog>(() =>
    game.studioGetCatalog(),
  );
  const [tab, setTab] = useState<Tab>("skill");
  const [classId] = useState<string>(() => game.studioPlayerClass());
  const [skillIdx, setSkillIdx] = useState(0);
  const [castIdx, setCastIdx] = useState(0);
  const [rebinding, setRebinding] = useState<null | { kind: "skill" | "cast"; i: number }>(
    null,
  );
  const [rebindMsg, setRebindMsg] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const catRef = useRef(cat);
  catRef.current = cat;

  const canSave = studioSaveAvailable();

  // Push edits to the running game on every change (live preview).
  useEffect(() => {
    game.studioApplyCatalog(cat);
  }, [cat, game]);

  // Click-to-rebind: capture the next physical key for the pending binding.
  // Escape cancels; reserved control keys and codes already bound elsewhere are
  // rejected with a brief inline message (the panel keeps capturing).
  useEffect(() => {
    if (!rebinding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const code = e.code;
      if (code === "Escape") {
        setRebinding(null);
        setRebindMsg("");
        return;
      }
      if (RESERVED_CODES.has(code)) {
        setRebindMsg(`${keyLabel(code)} is reserved`);
        return;
      }
      // Reject a code already bound to a different skill/cast slot.
      const cur = catRef.current;
      const taken =
        cur.hotkeys.skill.some(
          (b, i) => b === code && !(rebinding.kind === "skill" && i === rebinding.i),
        ) ||
        cur.hotkeys.cast.some(
          (b, i) => b === code && !(rebinding.kind === "cast" && i === rebinding.i),
        );
      if (taken) {
        setRebindMsg(`${keyLabel(code)} already bound`);
        return;
      }
      setCat((c) => {
        const next = structuredClone(c);
        if (rebinding.kind === "skill") next.hotkeys.skill[rebinding.i] = code;
        else next.hotkeys.cast[rebinding.i] = code;
        return next;
      });
      setRebinding(null);
      setRebindMsg("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rebinding]);

  const skills = cat.classSkills[classId.toLowerCase()] ?? cat.classSkills.warrior;
  const skill = skills[skillIdx];
  const cast = cat.elementalCasts[castIdx];

  // Mutate a class skill field immutably and restage.
  function editSkill(patch: Partial<(typeof skills)[number]>) {
    setCat((c) => {
      const next = structuredClone(c);
      const list = next.classSkills[classId.toLowerCase()] ?? next.classSkills.warrior;
      list[skillIdx] = { ...list[skillIdx], ...patch };
      return next;
    });
  }
  function editCast(patch: Partial<(typeof cat.elementalCasts)[number]>) {
    setCat((c) => {
      const next = structuredClone(c);
      next.elementalCasts[castIdx] = { ...next.elementalCasts[castIdx], ...patch };
      return next;
    });
  }
  function editRanged(kind: "arrow" | "orb", patch: Record<string, number>) {
    setCat((c) => {
      const next = structuredClone(c);
      next.rangedShots[kind] = { ...next.rangedShots[kind], ...patch } as never;
      return next;
    });
  }

  async function onSave() {
    setSaving(true);
    setStatus("Saving...");
    const res = await game.studioSaveCatalog(catRef.current);
    setStatus(res.message);
    setSaving(false);
  }

  function onReset() {
    setCat(game.studioGetCatalog());
    setStatus("Reverted to the last loaded catalog.");
  }

  const num = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    step = 1,
  ) => (
    <label className="wss-field" key={label}>
      <span>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );

  const skillBind = cat.hotkeys.skill[skillIdx];
  const castBind = cat.hotkeys.cast[castIdx];

  const spriteOptions = useMemo(
    () => SPRITE_EFFECTS.map((e) => ({ id: e.id, label: e.label })),
    [],
  );

  return (
    <div
      className="wss-panel"
      onMouseEnter={() => onUiMouse(true)}
      onMouseLeave={() => onUiMouse(false)}
    >
      <div className="wss-head">
        <span className="wss-title">Weapon Skill Studio</span>
        <span className="wss-class">class: {classId}</span>
      </div>

      <div className="wss-dummies">
        <button onClick={() => game.studioSpawnDummies(3)}>Spawn Dummies</button>
        <button onClick={() => game.studioClearDummies()}>Clear</button>
      </div>

      <div className="wss-tabs">
        <button className={tab === "skill" ? "on" : ""} onClick={() => setTab("skill")}>
          Signature
        </button>
        <button className={tab === "cast" ? "on" : ""} onClick={() => setTab("cast")}>
          Elemental
        </button>
        <button className={tab === "ranged" ? "on" : ""} onClick={() => setTab("ranged")}>
          Ranged LMB
        </button>
      </div>

      {tab === "skill" && skill && (
        <div className="wss-body">
          <div className="wss-row">
            {skills.map((s, i) => (
              <button
                key={s.id}
                className={i === skillIdx ? "on" : ""}
                onClick={() => setSkillIdx(i)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <label className="wss-field">
            <span>Hotkey</span>
            <button
              className="wss-rebind"
              onClick={() => {
                setRebindMsg("");
                setRebinding({ kind: "skill", i: skillIdx });
              }}
            >
              {rebinding?.kind === "skill" && rebinding.i === skillIdx
                ? "press a key (Esc cancels)..."
                : keyLabel(skillBind ?? skill.key)}
            </button>
          </label>
          {rebinding?.kind === "skill" && rebinding.i === skillIdx && rebindMsg && (
            <div className="wss-status warn">{rebindMsg}</div>
          )}

          <label className="wss-field">
            <span>Kind</span>
            <select
              value={skill.kind}
              onChange={(e) => editSkill({ kind: e.target.value as typeof skill.kind })}
            >
              {SKILL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <label className="wss-field">
            <span>Trail VFX</span>
            <select
              value={skill.texture}
              onChange={(e) => editSkill({ texture: e.target.value })}
            >
              {spriteOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="wss-field">
            <span>Impact VFX</span>
            <select
              value={skill.impact ?? skill.texture}
              onChange={(e) => editSkill({ impact: e.target.value })}
            >
              {spriteOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <label className="wss-field">
            <span>Color</span>
            <input
              type="color"
              value={toHex(skill.color)}
              onChange={(e) => editSkill({ color: fromHex(e.target.value) })}
            />
          </label>

          {num("Damage", skill.damage, (v) => editSkill({ damage: v }))}
          {num("Cooldown (s)", skill.cooldown, (v) => editSkill({ cooldown: v }), 0.1)}
          {num("Force cost", skill.forceCost, (v) => editSkill({ forceCost: v }))}
          {num("Radius", skill.radius, (v) => editSkill({ radius: v }), 0.1)}
          {num("Range", skill.range, (v) => editSkill({ range: v }))}
          {num("Speed", skill.speed, (v) => editSkill({ speed: v }))}

          <div className="wss-subhead">Buffs / Debuffs on hit</div>
          <BuffEditor
            buffs={skill.buffs ?? []}
            onChange={(buffs) => editSkill({ buffs })}
          />
        </div>
      )}

      {tab === "cast" && cast && (
        <div className="wss-body">
          <div className="wss-row">
            {cat.elementalCasts.map((c, i) => (
              <button
                key={c.element}
                className={i === castIdx ? "on" : ""}
                onClick={() => setCastIdx(i)}
              >
                {c.name}
              </button>
            ))}
          </div>

          <label className="wss-field">
            <span>Hotkey</span>
            <button
              className="wss-rebind"
              onClick={() => {
                setRebindMsg("");
                setRebinding({ kind: "cast", i: castIdx });
              }}
            >
              {rebinding?.kind === "cast" && rebinding.i === castIdx
                ? "press a key (Esc cancels)..."
                : keyLabel(castBind ?? cast.key)}
            </button>
          </label>
          {rebinding?.kind === "cast" && rebinding.i === castIdx && rebindMsg && (
            <div className="wss-status warn">{rebindMsg}</div>
          )}

          <label className="wss-field">
            <span>Effect</span>
            <select
              value={cast.element}
              onChange={(e) =>
                editCast({ element: e.target.value as typeof cast.element })
              }
            >
              {CAST_ELEMENTS.map((el) => {
                const meta = CAST_EFFECTS.find((c) => c.id === el);
                return (
                  <option key={el} value={el}>
                    {meta?.label ?? el}
                  </option>
                );
              })}
            </select>
          </label>

          <label className="wss-field">
            <span>Cast shape</span>
            <select
              value={cast.castShape ?? "line"}
              onChange={(e) =>
                editCast({ castShape: e.target.value as "line" | "zone" })
              }
            >
              <option value="line">line</option>
              <option value="zone">zone</option>
            </select>
          </label>

          <label className="wss-field">
            <span>Color</span>
            <input
              type="color"
              value={toHex(cast.color)}
              onChange={(e) => editCast({ color: fromHex(e.target.value) })}
            />
          </label>

          {num("Damage", cast.damage, (v) => editCast({ damage: v }))}
          {num("Radius", cast.radius, (v) => editCast({ radius: v }), 0.1)}
          {num("Knockback", cast.knock, (v) => editCast({ knock: v }))}
          {num("Range", cast.range, (v) => editCast({ range: v }))}
          {num("Speed", cast.speed, (v) => editCast({ speed: v }))}
          {num("Wind-up (s)", cast.windup, (v) => editCast({ windup: v }), 0.05)}
          {num("Cost", cast.cost, (v) => editCast({ cost: v }))}
          {num("Cooldown (s)", cast.cooldown, (v) => editCast({ cooldown: v }), 0.1)}
          {num("Zone radius", cast.zoneRadius ?? 0, (v) => editCast({ zoneRadius: v }), 0.1)}
          {num("Hold (s)", cast.hold ?? 0, (v) => editCast({ hold: v }), 0.1)}

          <div className="wss-subhead">Buffs / Debuffs on hit</div>
          <BuffEditor
            buffs={cast.buffs ?? []}
            onChange={(buffs) => editCast({ buffs })}
          />
        </div>
      )}

      {tab === "ranged" && (
        <div className="wss-body">
          <div className="wss-subhead">Bow — Arrow</div>
          {num("Release (ms)", cat.rangedShots.arrow.releaseMs, (v) => editRanged("arrow", { releaseMs: v }))}
          {num("Damage", cat.rangedShots.arrow.damage, (v) => editRanged("arrow", { damage: v }))}
          {num("Speed", cat.rangedShots.arrow.speed, (v) => editRanged("arrow", { speed: v }))}
          {num("Range", cat.rangedShots.arrow.range, (v) => editRanged("arrow", { range: v }))}
          {num("Knockback", cat.rangedShots.arrow.knock, (v) => editRanged("arrow", { knock: v }))}
          <label className="wss-field">
            <span>Arrow color</span>
            <input
              type="color"
              value={toHex(cat.rangedShots.arrow.color)}
              onChange={(e) => editRanged("arrow", { color: fromHex(e.target.value) })}
            />
          </label>

          <div className="wss-subhead">Staff — Arcane Orb</div>
          {num("Cast time (s)", cat.rangedShots.orb.castT, (v) => editRanged("orb", { castT: v }), 0.1)}
          {num("Damage", cat.rangedShots.orb.damage, (v) => editRanged("orb", { damage: v }))}
          {num("Speed", cat.rangedShots.orb.speed, (v) => editRanged("orb", { speed: v }))}
          {num("Range", cat.rangedShots.orb.range, (v) => editRanged("orb", { range: v }))}
          {num("Splash radius", cat.rangedShots.orb.radius, (v) => editRanged("orb", { radius: v }), 0.1)}
          {num("Knockback", cat.rangedShots.orb.knock, (v) => editRanged("orb", { knock: v }))}
          {num("Splash knock", cat.rangedShots.orb.splashKnock, (v) => editRanged("orb", { splashKnock: v }))}
          <label className="wss-field">
            <span>Orb color</span>
            <input
              type="color"
              value={toHex(cat.rangedShots.orb.color)}
              onChange={(e) => editRanged("orb", { color: fromHex(e.target.value) })}
            />
          </label>
        </div>
      )}

      {/* Clip reference: available animation clips (drives skill/attack poses). */}
      <details className="wss-clips">
        <summary>Available clips</summary>
        <div className="wss-cliplist">{CLIP_NAMES.join(", ")}</div>
      </details>

      <div className="wss-actions">
        <button className="wss-save" disabled={saving || !canSave} onClick={onSave}>
          {canSave ? "Save to game files" : "Save (dev only)"}
        </button>
        <button className="wss-reset" onClick={onReset}>
          Revert
        </button>
      </div>
      {status && <div className="wss-status">{status}</div>}
      {!canSave && (
        <div className="wss-status warn">
          Production build — edits apply live but cannot be written to disk.
        </div>
      )}
    </div>
  );
}

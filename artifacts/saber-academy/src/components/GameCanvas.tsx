import { useCallback, useEffect, useRef, useState } from "react";
import { MmoHud } from "./hud/MmoHud";
import {
  SaberGame,
  type HudState,
  type HeroInfo,
  type GameMode,
  type FactionConfig,
  type FactionMap,
} from "@/game/SaberGame";
import { getSkills } from "@/game/skills";
import { WeaponSkillStudioPanel } from "./WeaponSkillStudioPanel";
import { toonRaceKitUrl } from "@/lib/fleetAssets";

const INITIAL: HudState = {
  phase: "menu",
  mode: "waves",
  playerHealth: 100,
  playerMaxHealth: 100,
  forceEnergy: 100,
  forceMaxEnergy: 100,
  score: 0,
  wave: 0,
  totalWaves: 5,
  enemiesRemaining: 0,
  combo: 0,
  blocking: false,
  message: "",
  playerName: "",
  playerTitle: "",
  factionColor: "#46d7ff",
  skills: [],
  targetLocked: false,
};

interface RosterHero {
  id: string;
  name: string;
  title: string;
  raceId: string;
  classId: string;
  faction: string;
  stars: number;
  level: number;
  weapon: string;
  factionColor: string;
  modelUrl: string;
  /**
   * "mixamo" => real skeletal-animated FBX (Lucy); "racalvin" => the secret
   * Pirate King unlocked at the select screen.
   */
  rig?: "mixamo" | "racalvin" | "meshy" | "toonrts";
}

interface Roster {
  heroes: RosterHero[];
}

// Lucy is a real mixamorig-rigged character (FBX + Mixamo clips), injected on the
// client alongside the Grudge roster. She is playable only; her assets live in
// /public/models/lucy and she is excluded from the enemy pool.
const LUCY_HERO: RosterHero = {
  id: "lucy",
  name: "Lucy",
  title: "The Wanderer",
  raceId: "human",
  classId: "blade dancer",
  faction: "ronin",
  stars: 5,
  level: 30,
  weapon: "saber",
  factionColor: "#e0729f",
  modelUrl: "lucy",
  rig: "mixamo",
};

// Racalvin is a secret player-only champion: a self-contained rigged FBX with
// its own bundled clips (assets in /public/models/racalvin). He is hidden until
// the player holds R + SHIFT on the select screen, and never joins the enemy
// pool.
const RACALVIN_HERO: RosterHero = {
  id: "racalvin",
  name: "Racalvin",
  title: "The Pirate King",
  raceId: "human",
  classId: "blade dancer",
  faction: "outlaws",
  stars: 5,
  level: 50,
  weapon: "sword",
  factionColor: "#d4a017",
  modelUrl: "racalvin",
  rig: "racalvin",
};

// The Meshy Academy recruits: AI-generated auto-rigged RPG characters (assets
// in /public/models/meshy, produced by scripts/meshy-pipeline.mjs). Player-only
// like Lucy/Racalvin — they never join the enemy pool.
const MESHY_HEROES: RosterHero[] = [
  {
    id: "meshy-knight",
    name: "Aldric",
    title: "The Bulwark",
    raceId: "human",
    classId: "guardian",
    faction: "academy",
    stars: 4,
    level: 20,
    weapon: "sword",
    factionColor: "#7fa8e8",
    modelUrl: `${import.meta.env.BASE_URL}models/meshy/knight/knight-rigged.glb`,
    rig: "meshy",
  },
  {
    id: "meshy-mage",
    name: "Sylvara",
    title: "The Runeweaver",
    raceId: "human",
    classId: "mage",
    faction: "academy",
    stars: 4,
    level: 20,
    weapon: "saber",
    factionColor: "#b07fe8",
    modelUrl: `${import.meta.env.BASE_URL}models/meshy/mage/mage-rigged.glb`,
    rig: "meshy",
  },
  {
    id: "meshy-rogue",
    name: "Corvin",
    title: "The Whisper",
    raceId: "human",
    classId: "blade dancer",
    faction: "academy",
    stars: 4,
    level: 20,
    weapon: "dagger",
    factionColor: "#8fe87f",
    modelUrl: `${import.meta.env.BASE_URL}models/meshy/rogue/rogue-rigged.glb`,
    rig: "meshy",
  },
  {
    id: "meshy-ranger",
    name: "Kaela",
    title: "The Farstrider",
    raceId: "human",
    classId: "ranger",
    faction: "academy",
    stars: 4,
    level: 20,
    weapon: "sword",
    factionColor: "#e8c77f",
    modelUrl: `${import.meta.env.BASE_URL}models/meshy/ranger/ranger-rigged.glb`,
    rig: "meshy",
  },
];

// The Toon RTS army: 6 race kits from the fleet CDN (assets.grudge-studio.com),
// one GLB per race. Class (knight/warrior/ranger/mage) is a prune + clip map
// on that kit — not 24 SPA-bundled class GLBs.
// Knights fight sword & shield, warriors swing the two-handed greatsword,
// rangers shoot bows, and mages cast — all playable, and they form the enemy
// pool (bow/mage units spawn as ranged attackers).

interface ToonRace {
  file: string; // model filename prefix, e.g. "human" -> human_knight.glb
  raceId: string;
  raceName: string;
  faction: string;
  color: string;
  names: [string, string, string, string]; // knight, warrior, ranger, mage
}

const TOON_RACES: ToonRace[] = [
  {
    file: "human",
    raceId: "human",
    raceName: "Western Kingdoms",
    faction: "crusade",
    color: "#7fa8e8",
    names: ["Ser Roland", "Aldric", "Wren", "Maelis"],
  },
  {
    file: "barbarian",
    raceId: "barbarian",
    raceName: "Barbarian",
    faction: "crusade",
    color: "#e8a05f",
    names: ["Torvald", "Skarde", "Eyva", "Grimhild"],
  },
  {
    file: "dwarf",
    raceId: "dwarf",
    raceName: "Dwarven",
    faction: "fabled",
    color: "#e8c77f",
    names: ["Brokk", "Durgan", "Ketta", "Ovric"],
  },
  {
    file: "highelf",
    raceId: "high elf",
    raceName: "High Elf",
    faction: "fabled",
    color: "#9fe8d8",
    names: ["Aelrion", "Vaelis", "Sylwen", "Ithrandil"],
  },
  {
    file: "orc",
    raceId: "orc",
    raceName: "Orc",
    faction: "legion",
    color: "#8fe87f",
    names: ["Drakk", "Gruma", "Snagga", "Zulmak"],
  },
  {
    file: "undead",
    raceId: "undead",
    raceName: "Undead",
    faction: "legion",
    color: "#b07fe8",
    names: ["Mortis", "Vharok", "Sythe", "Nekhara"],
  },
];

// class file suffix, display title, roster classId (skill kit), weapon string.
const TOON_CLASSES: Array<[string, string, string, string]> = [
  ["knight", "Knight", "warrior", "sword and shield"],
  ["warrior", "Warrior", "warrior", "greatsword"],
  ["ranger", "Ranger", "ranger", "bow"],
  ["mage", "Mage", "mage", "staff"],
];

const TOON_HEROES: RosterHero[] = TOON_RACES.flatMap((race) =>
  TOON_CLASSES.map(([cls, clsTitle, classId, weapon], i) => ({
    id: `toon-${race.file}-${cls}`,
    name: race.names[i],
    title: `${race.raceName} ${clsTitle}`,
    raceId: race.raceId,
    classId,
    faction: race.faction,
    stars: 5,
    level: 25,
    weapon,
    factionColor: race.color,
    modelUrl: toonRaceKitUrl(race.file),
    rig: "toonrts" as const,
  })),
);

type Screen = "menu" | "select";

type AccentStyle = React.CSSProperties & { [key: `--${string}`]: string };

function accentVar(color: string): AccentStyle {
  return { ["--accent"]: color };
}

function Stars({ n, max = 5 }: { n: number; max?: number }) {
  const filled = Math.max(0, Math.min(Math.round(n), max));
  return (
    <span className="stars" aria-label={`${filled} of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`star${i < filled ? " on" : ""}`} />
      ))}
    </span>
  );
}

export default function GameCanvas({ admin = false }: { admin?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<SaberGame | null>(null);
  const crosshairRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState<HudState>(INITIAL);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(admin ? "select" : "menu");
  const [roster, setRoster] = useState<RosterHero[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<GameMode>("waves");
  // Faction War squad size (fighters per faction): 2 or 3.
  const [squadSize, setSquadSize] = useState<2 | 3>(3);
  // Faction War battleground. Default: Highlands (outdoor + terrain).
  const [factionMap, setFactionMap] = useState<FactionMap>("highlands");
  const [racalvinUnlocked, setRacalvinUnlocked] = useState(false);

  // The roster as shown/selectable: the secret Pirate King is appended only once
  // unlocked via the R + SHIFT chord on the select screen.
  const displayRoster = roster
    ? [
        ...roster,
        ...(import.meta.env.DEV ? MESHY_HEROES : []),
        ...(racalvinUnlocked ? [RACALVIN_HERO] : []),
      ]
    : roster;

  // Secret unlock: hold R + SHIFT together on the select screen.
  useEffect(() => {
    if (screen !== "select" || racalvinUnlocked) return;
    const held = new Set<string>();
    const check = () => {
      if (held.has("r") && held.has("shift")) {
        setRacalvinUnlocked(true);
        setSelectedId(RACALVIN_HERO.id);
      }
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "r" || k === "shift") {
        held.add(k);
        check();
      }
    };
    const up = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase());
    };
    const clear = () => held.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
    };
  }, [screen, racalvinUnlocked]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let game: SaberGame;
    try {
      game = new SaberGame(canvasRef.current);
    } catch {
      setError(
        "This game needs WebGL, which is not available in this browser or environment. Try a modern desktop browser with hardware acceleration enabled.",
      );
      return;
    }
    gameRef.current = game;
    const off = game.onUpdate(setHud);
    // Swing-aim: the engine reports the weapon point's screen position every
    // frame while a swing is active; move the crosshair via the DOM directly
    // (no React re-render at 60fps).
    game.onAim = (x01, y01, active) => {
      const el = crosshairRef.current;
      if (!el) return;
      el.classList.toggle("swing", active);
      el.style.left = `${x01 * 100}%`;
      el.style.top = `${y01 * 100}%`;
    };
    // Gesture trail: paint the drawn slash/guard stroke on a 2D overlay canvas.
    game.onDraw = (pts, mode) => {
      const c = trailRef.current;
      const ctx = c?.getContext("2d");
      if (!c || !ctx) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.clearRect(0, 0, w, h);
      if (!pts || pts.length < 4) return;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = mode === "guard" ? "#9fd0ff" : "#ffd166";
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(pts[0] * w, pts[1] * h);
      for (let i = 2; i < pts.length; i += 2) {
        ctx.lineTo(pts[i] * w, pts[i + 1] * h);
      }
      ctx.stroke();
      // Gesture cursor dot at the stroke head.
      const cx = pts[pts.length - 2] * w;
      const cy = pts[pts.length - 1] * h;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    };
    if (admin) {
      const player = TOON_HEROES[0];
      const pool = TOON_HEROES.slice(1, 8);
      const toInfo = (h: RosterHero): HeroInfo => ({
        id: h.id,
        name: h.name,
        title: h.title,
        faction: h.faction,
        factionColor: h.factionColor,
        modelUrl: h.modelUrl,
        weapon: h.weapon,
        raceId: h.raceId,
        classId: h.classId,
        rig: h.rig,
      });
      setRoster([...TOON_HEROES, LUCY_HERO]);
      setSelectedId(player.id);
      setMode("animtest");
      setScreen("select");
      void game.start(toInfo(player), pool.map(toInfo), "animtest");
    }
    return () => {
      off();
      game.onAim = null;
      game.dispose();
      gameRef.current = null;
    };
  }, [admin]);

  async function openSelect(m: GameMode) {
    setMode(m);
    setScreen("select");
    if (roster) return;
    try {
      const res = await fetch("/api/saber/roster");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Roster = await res.json();
      const heroes = [...TOON_HEROES, LUCY_HERO, ...data.heroes];
      setRoster(heroes);
      // Default to the Toon RTS knight, but never clobber a selection already
      // made (e.g. the R + SHIFT chord auto-selecting Racalvin while loading).
      setSelectedId((prev) => prev ?? TOON_HEROES[0].id);
    } catch {
      // The Toon RTS cast ships with the client, so the game stays fully
      // playable even when the roster API is unreachable.
      setRoster([...TOON_HEROES, LUCY_HERO]);
      setSelectedId((prev) => prev ?? TOON_HEROES[0].id);
    }
  }

  function beginDuel() {
    if (!roster || !displayRoster || !selectedId) return;
    const player = displayRoster.find((h) => h.id === selectedId);
    if (!player) return;
    const toInfo = (h: RosterHero): HeroInfo => ({
      id: h.id,
      name: h.name,
      title: h.title,
      faction: h.faction,
      factionColor: h.factionColor,
      modelUrl: h.modelUrl,
      weapon: h.weapon,
      raceId: h.raceId,
      classId: h.classId,
      rig: h.rig,
    });
    // The Toon RTS factions ARE the enemy cast: every toon hero except the
    // player's own joins the pool. The rigged FBX heroes (Lucy, Racalvin) stay
    // player-only, and Meshy heroes join only in the Testing Grounds.
    // Shuffle then interleave melee (knight/warrior) with ranged (ranger/mage)
    // so the 5-def enemy cap always yields a mix of sword-line and bow/mage
    // units, from varied races each run.
    const shuffle = <T,>(a: T[]): T[] => {
      const r = [...a];
      for (let i = r.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [r[i], r[j]] = [r[j], r[i]];
      }
      return r;
    };
    const toonAll = roster.filter(
      (h) => h.rig === "toonrts" && h.id !== player.id,
    );
    const isRanged = (h: RosterHero) => /bow|staff/.test(h.weapon);
    const melee = shuffle(toonAll.filter((h) => !isRanged(h)));
    const rangedUnits = shuffle(toonAll.filter(isRanged));
    const toonEnemies: RosterHero[] = [];
    for (let i = 0; i < Math.max(melee.length, rangedUnits.length); i++) {
      if (i < melee.length) toonEnemies.push(melee[i]);
      if (i < rangedUnits.length) toonEnemies.push(rangedUnits[i]);
    }
    // Faction War: resolve EXACTLY six squads (one champion per supported race)
    // and hand the config to the engine. The player's champion decides their
    // faction; the other five races become rival AI squads.
    if (mode === "factions") {
      const isRangedH = (h: RosterHero) => /bow|staff/.test(h.weapon);
      // The six supported factions, in a fixed order.
      const supported = TOON_RACES.map((r) => r.raceId);
      // Build the final race set: always six race IDs. If the player's race is
      // one of the six, their squad replaces that race's AI squad. If the
      // player's race is outside the six, drop the last supported race so the
      // total stays six (player race + five supported).
      const raceIds: string[] = supported.includes(player.raceId)
        ? supported
        : [player.raceId, ...supported.slice(0, 5)];

      const heroesByRace: Record<string, HeroInfo> = {};
      // Player's own race always uses the player's champion so team 0 matches
      // the pick (this also covers the case where the player's race is one of
      // the six supported races — no duplicate squad is created).
      heroesByRace[player.raceId] = toInfo(player);
      for (const raceId of raceIds) {
        if (heroesByRace[raceId]) continue;
        const candidates = roster.filter(
          (h) => h.rig === "toonrts" && h.raceId === raceId,
        );
        // Prefer a melee (sword-line) champion for this faction; fall back to
        // any candidate of the race, then to ANY toon hero so every one of the
        // six squads always spawns even on an incomplete roster. The faction
        // color/label still come from the race in the engine, and the capsule
        // fallback in spawnFactionUnit covers model-load failures.
        const anyToon = roster.filter((h) => h.rig === "toonrts");
        const champ =
          candidates.find((h) => !isRangedH(h)) ??
          candidates[0] ??
          anyToon.find((h) => !isRangedH(h)) ??
          anyToon[0] ??
          player;
        // Reuse the fallback hero's model but stamp this faction's race id so
        // the engine tints/labels the squad correctly.
        heroesByRace[raceId] = { ...toInfo(champ), raceId };
      }
      const config: FactionConfig = { heroesByRace, squadSize, map: factionMap };
      void gameRef.current?.startFactions(toInfo(player), config);
      return;
    }

    const enemies = (
      toonEnemies.length > 0
        ? toonEnemies
        : roster.filter(
            (h) =>
              h.id !== player.id &&
              (!h.rig || (h.rig === "meshy" && mode === "sandbox")),
          )
    ).map(toInfo);
    void gameRef.current?.start(toInfo(player), enemies, mode);
  }

  // HUD menus / Edit UI borrow the mouse from the game (exits pointer lock).
  const uiMouse = useCallback(
    (on: boolean) => gameRef.current?.setUiMouse(on),
    [],
  );

  const healthPct = (hud.playerHealth / hud.playerMaxHealth) * 100;
  const forcePct = (hud.forceEnergy / hud.forceMaxEnergy) * 100;
  const selected = displayRoster?.find((h) => h.id === selectedId) ?? null;

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      {error && (
        <Overlay>
          <p className="eyebrow">System Fault</p>
          <h1 className="title defeat">WEBGL UNAVAILABLE</h1>
          <p className="subtitle">{error}</p>
        </Overlay>
      )}

      {hud.phase === "loading" && (
        <Overlay accent={hud.factionColor}>
          <p className="eyebrow">Linking to the temple</p>
          <h1 className="title small">SUMMONING</h1>
          <p className="subtitle">
            Calling {hud.playerName || "the guardian"} into the arena...
          </p>
          <div className="loader-bar">
            <div className="loader-fill" />
          </div>
        </Overlay>
      )}

      {/* RPG/MMO HUD (uploaded UI kit): unit frames, action bar, cast bar,
          game menu, equipment window, and movable panels via Edit UI. The
          Animation Lab keeps the old diagnostic HUD below. */}
      {hud.phase === "playing" && hud.mode !== "animtest" && (
        <MmoHud
          hud={hud}
          equipment={
            selected
              ? {
                  name: selected.name,
                  title: selected.title,
                  weapon: selected.weapon,
                  faction: selected.faction,
                }
              : null
          }
          onUiMouse={uiMouse}
          sandboxControls={
            hud.mode === "sandbox" ? (
              <div className="sandbox-panel">
                <span className="sandbox-title">Testing Grounds</span>
                <button onClick={() => gameRef.current?.sandboxSpawn(3)}>
                  Spawn Dummies
                </button>
                <button onClick={() => gameRef.current?.sandboxClear()}>
                  Clear
                </button>
                <button onClick={() => gameRef.current?.sandboxRefill()}>
                  Refill
                </button>
              </div>
            ) : undefined
          }
        />
      )}

      {hud.phase === "playing" && hud.mode === "animtest" && (
        <div className="hud" style={accentVar(hud.factionColor)}>
          <div className="hud-topleft panel bracket">
            {hud.playerName && (
              <div className="hero-tag">
                <span className="hero-name">{hud.playerName}</span>
                <span className="hero-title">{hud.playerTitle}</span>
              </div>
            )}
            <div className="stat-label">
              <span className="label-text">Health</span>
              <span>{hud.playerHealth}</span>
            </div>
            <div className="bar">
              <div className="bar-fill health" style={{ width: `${healthPct}%` }} />
            </div>
            <div className="stat-label force-label">
              <span className="label-text">
                Force {hud.blocking ? <span className="blocking">/ GUARD</span> : null}
              </span>
              <span>{Math.round(hud.forceEnergy)}</span>
            </div>
            <div className="bar">
              <div className="bar-fill force" style={{ width: `${forcePct}%` }} />
            </div>
          </div>

          <div className="hud-topright panel bracket">
            <div className="score">{hud.score.toLocaleString()}</div>
            <div className="score-label">Score</div>
            <div className="wave-pill">
              Wave {hud.wave} / {hud.totalWaves}
            </div>
            <div className="enemy-pill">{hud.enemiesRemaining} Hostiles</div>
          </div>

          {hud.combo > 1 && (
            <div className="combo">
              <span className="combo-num">{hud.combo}</span>
              <span className="combo-text">Combo</span>
            </div>
          )}

          {hud.message && <div className="center-msg">{hud.message}</div>}

          {hud.skills.length > 0 && (
            <div className="skill-bar">
              {hud.skills.map((s) => (
                <div
                  key={s.id}
                  className={`skill${s.ready ? " ready" : ""}`}
                  title={s.name}
                >
                  <span className="skill-key">{s.key}</span>
                  <span className="skill-name">{s.name}</span>
                  <span className="skill-cost">{s.cost}</span>
                  {s.cooldownPct > 0 && (
                    <span
                      className="skill-cd"
                      style={{ height: `${Math.round(s.cooldownPct * 100)}%` }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {gameRef.current && (
            <WeaponSkillStudioPanel
              game={gameRef.current}
              onUiMouse={uiMouse}
              layout={admin ? "admin" : "dock"}
            />
          )}

          <canvas ref={trailRef} className="draw-trail" />
          <div
            ref={crosshairRef}
            className={`crosshair${hud.targetLocked ? " locked" : ""}`}
          />
          <div className="controls-hint">
            <b>WASD</b> move &middot; <b>SHIFT</b> sprint &middot; <b>TAB</b> target
            &middot; <b>RMB</b> focus / lock-on &middot; <b>LMB</b> attack &middot;{" "}
            <b>Q</b>/<b>E</b> skills &middot; <b>1-6</b> casts &middot; edit &amp;
            save skills in the studio panel
          </div>
        </div>
      )}

      {admin && (
        <div className="admin-bar">
          <a href="/">Arena arena</a>
          <span>Admin / Yuka / linear / effects</span>
        </div>
      )}

      {hud.phase === "menu" && screen === "menu" && !admin && (
        <Overlay>
          <img
            className="brand-logo"
            src={`${import.meta.env.BASE_URL}brand/grudge-logo.png`}
            alt="Grudge Studio"
          />
          <p className="eyebrow">A Grudge Studio Arena Brawler</p>
          <h1 className="title">
            GRUDGE<span>GLADIATORS</span>
          </h1>
          <p className="subtitle">
            One gladiator. Five waves of the fallen. Hold the arena.
          </p>
          <div className="mode-buttons">
            <button className="play-btn" onClick={() => openSelect("waves")}>
              Survival
            </button>
            <button
              className="play-btn"
              onClick={() => openSelect("factions")}
            >
              Faction War
            </button>
            <button
              className="play-btn ghost"
              onClick={() => openSelect("sandbox")}
            >
              Testing Grounds
            </button>
            <button
              className="play-btn ghost"
              onClick={() => openSelect("animtest")}
            >
              Weapon Skill Studio
            </button>
            <a className="play-btn ghost" href="/admin">
              /admin Editor
            </a>
          </div>
          <p className="tip mode-tip">
            Survival: five escalating waves. Faction War: six race squads clash
            in a free-for-all — pick a champion and lead your faction. Testing
            Grounds: free practice with spawnable dummies, no death. Weapon
            Skill Studio: an admin editor — play the real character and tune
            weapon skills live, then save them into the game.
          </p>
          <div className="legend">
            <span>
              <b>WASD</b> Move
            </span>
            <span>
              <b>SHIFT</b> Sprint
            </span>
            <span>
              <b>2x TAP</b> Dodge / Air Dash
            </span>
            <span>
              <b>SPACE</b> Jump
            </span>
            <span>
              <b>TAB</b> Target
            </span>
            <span>
              <b>RMB</b> Focus / Lock-On
            </span>
            <span>
              <b>LMB</b> Attack
            </span>
            <span>
              <b>SHIFT+LMB</b> Heavy
            </span>
            <span>
              <b>SHIFT+RMB</b> Block / Parry
            </span>
          </div>
          <p className="tip">Click the arena to capture your mouse and look around.</p>
        </Overlay>
      )}

      {hud.phase === "menu" && screen === "select" && (
        <Overlay wide accent={selected?.factionColor}>
          <div className="select-head">
            <img
              className="brand-banner"
              src={`${import.meta.env.BASE_URL}brand/grudge-banner.png`}
              alt="Grudge Studio"
            />
            <p className="eyebrow">Select Roster</p>
            <h1 className="title small">CHOOSE YOUR CHAMPION</h1>
            <p className="tip">
              {racalvinUnlocked
                ? "A secret champion has joined the roster."
                : "Hold R + SHIFT to summon a secret champion."}
            </p>
          </div>

          {rosterError && <p className="subtitle">{rosterError}</p>}
          {!roster && !rosterError && (
            <p className="subtitle">Reading the roster...</p>
          )}

          {displayRoster && (
            <>
              <div className="select-layout">
                <div className="roster-grid">
                  {displayRoster.map((h) => (
                    <button
                      key={h.id}
                      className={`hero-card${h.id === selectedId ? " selected" : ""}`}
                      style={{ ["--card-accent"]: h.factionColor } as AccentStyle}
                      onClick={() => setSelectedId(h.id)}
                    >
                      <span className="hero-card-name">{h.name}</span>
                      <span className="hero-card-title">{h.title}</span>
                      <span className="hero-card-stars">
                        <Stars n={h.stars} />
                      </span>
                    </button>
                  ))}
                </div>

                {selected ? (
                  <aside
                    className="hero-detail panel bracket"
                    style={{ ["--detail-accent"]: selected.factionColor } as AccentStyle}
                  >
                    <div className="detail-faction">{selected.faction}</div>
                    <h2 className="detail-name">{selected.name}</h2>
                    <div className="detail-title">{selected.title}</div>
                    <Stars n={selected.stars} />
                    <dl className="detail-stats">
                      <div>
                        <dt>Race</dt>
                        <dd>{selected.raceId}</dd>
                      </div>
                      <div>
                        <dt>Class</dt>
                        <dd>{selected.classId}</dd>
                      </div>
                      <div>
                        <dt>Weapon</dt>
                        <dd>{selected.weapon}</dd>
                      </div>
                      <div>
                        <dt>Level</dt>
                        <dd>{selected.level}</dd>
                      </div>
                    </dl>
                    <div className="detail-skills">
                      <div className="detail-skills-label">Signature Skills</div>
                      {getSkills(selected.classId).map((s) => (
                        <div key={s.id} className="detail-skill">
                          <span className="detail-skill-key">{s.key}</span>
                          <div className="detail-skill-body">
                            <span className="detail-skill-name">{s.name}</span>
                            <span className="detail-skill-blurb">{s.blurb}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {mode === "factions" && (
                      <div className="squad-size">
                        <div className="detail-skills-label">Squad Size</div>
                        <div className="mode-buttons">
                          <button
                            className={`play-btn ${squadSize === 2 ? "" : "ghost"}`}
                            onClick={() => setSquadSize(2)}
                          >
                            2 per squad
                          </button>
                          <button
                            className={`play-btn ${squadSize === 3 ? "" : "ghost"}`}
                            onClick={() => setSquadSize(3)}
                          >
                            3 per squad
                          </button>
                        </div>
                        <div className="detail-skills-label">Battleground</div>
                        <div className="mode-buttons">
                          <button
                            className={`play-btn ${factionMap === "highlands" ? "" : "ghost"}`}
                            onClick={() => setFactionMap("highlands")}
                          >
                            Highlands
                          </button>
                          <button
                            className={`play-btn ${factionMap === "colosseum" ? "" : "ghost"}`}
                            onClick={() => setFactionMap("colosseum")}
                          >
                            Colosseum
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="detail-actions">
                      <button className="play-btn block" onClick={beginDuel}>
                        {mode === "sandbox"
                          ? "Enter Testing Grounds"
                          : mode === "animtest"
                            ? "Enter Weapon Skill Studio"
                            : mode === "factions"
                              ? "Enter Faction War"
                              : "Enter The Duel"}
                      </button>
                    </div>
                  </aside>
                ) : (
                  <aside className="hero-detail panel bracket empty">
                    Select a champion
                  </aside>
                )}
              </div>

              <div className="select-actions">
                <button className="ghost-btn" onClick={() => setScreen("menu")}>
                  Back
                </button>
              </div>
            </>
          )}
        </Overlay>
      )}

      {hud.phase === "gameover" && (
        <Overlay>
          <p className="eyebrow">Run Ended</p>
          <h1 className="title defeat">YOU HAVE FALLEN</h1>
          <p className="subtitle">
            {hud.mode === "factions"
              ? `Your faction is broken. Final score ${hud.score.toLocaleString()}.`
              : `You held until wave ${hud.wave}. Final score ${hud.score.toLocaleString()}.`}
          </p>
          <button className="play-btn" onClick={() => gameRef.current?.restart()}>
            Rise Again
          </button>
        </Overlay>
      )}

      {hud.phase === "victory" && (
        <Overlay accent="#ffd34d">
          <p className="eyebrow">
            {hud.mode === "factions" ? "Faction Triumphant" : "Temple Secured"}
          </p>
          <h1 className="title victory">
            {hud.mode === "factions"
              ? "YOUR FACTION STANDS ALONE"
              : "THE TEMPLE STANDS"}
          </h1>
          <p className="subtitle">
            {hud.mode === "factions"
              ? `Every rival squad has fallen. Final score ${hud.score.toLocaleString()}.`
              : `All ${hud.totalWaves} waves repelled. Final score ${hud.score.toLocaleString()}.`}
          </p>
          <button className="play-btn" onClick={() => gameRef.current?.restart()}>
            Duel Again
          </button>
        </Overlay>
      )}
    </div>
  );
}

function Overlay({
  children,
  wide,
  accent,
}: {
  children: React.ReactNode;
  wide?: boolean;
  accent?: string;
}) {
  return (
    <div className="overlay" style={accent ? accentVar(accent) : undefined}>
      <div className={`overlay-inner${wide ? " wide" : ""}`}>{children}</div>
    </div>
  );
}

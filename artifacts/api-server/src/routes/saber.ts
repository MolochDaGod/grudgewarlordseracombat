import { Router, type IRouter } from "express";
import { d1Query } from "../lib/cloudflare";

const router: IRouter = Router();

type HeroRow = {
  id: string;
  name: string;
  title: string;
  race_id: string;
  class_id: string;
  faction: string;
  stars: number;
  level: number;
  weapon: string;
};

type ModelRow = {
  id: string;
  race_id: string;
  name: string;
  faction_name: string;
  faction_color: string;
  r2_url: string;
  skeleton_type: string;
};

type Race = {
  raceId: string;
  name: string;
  factionName: string;
  factionColor: string;
  modelUrl: string;
};

type Hero = {
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
};

type Roster = { heroes: Hero[]; races: Race[] };

let cache: { data: Roster; at: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function loadRoster(): Promise<Roster> {
  // Real character data: GRUDGE.heroes joined to grudge-models.models by race.
  const [heroRows, modelRows] = await Promise.all([
    d1Query<HeroRow>(
      "GRUDGE",
      "SELECT id, name, title, race_id, class_id, faction, stars, level, weapon FROM heroes ORDER BY stars DESC, name ASC",
    ),
    d1Query<ModelRow>(
      "grudge-models",
      "SELECT id, race_id, name, faction_name, faction_color, r2_url, skeleton_type FROM models",
    ),
  ]);

  const byRace = new Map<string, ModelRow>();
  for (const m of modelRows) byRace.set(m.race_id, m);

  const races: Race[] = modelRows.map((m) => ({
    raceId: m.race_id,
    name: m.name,
    factionName: m.faction_name,
    factionColor: m.faction_color,
    modelUrl: m.r2_url,
  }));

  const heroes: Hero[] = heroRows
    .map((h) => {
      const model = byRace.get(h.race_id);
      if (!model) return null;
      return {
        id: h.id,
        name: h.name,
        title: h.title,
        raceId: h.race_id,
        classId: h.class_id,
        faction: h.faction,
        stars: h.stars,
        level: h.level,
        weapon: h.weapon,
        factionColor: model.faction_color,
        modelUrl: model.r2_url,
      } satisfies Hero;
    })
    .filter((h): h is Hero => h !== null);

  return { heroes, races };
}

router.get("/saber/roster", async (req, res) => {
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { data: await loadRoster(), at: Date.now() };
    }
    res.json(cache.data);
  } catch (err) {
    req.log.error({ err }, "failed to load saber roster from Cloudflare D1");
    res.status(502).json({ error: "Failed to load character roster" });
  }
});

export default router;

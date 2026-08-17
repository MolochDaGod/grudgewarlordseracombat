/**
 * GET /api/saber/roster
 * Optional Cloudflare D1 join (GRUDGE.heroes + grudge-models.models).
 * Always 200: empty heroes when secrets/D1 are missing so the client
 * Toon RTS CDN roster stays playable.
 */
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
  race_id: string;
  name: string;
  faction_name: string;
  faction_color: string;
  r2_url: string;
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

async function d1Query<T>(dbName: string, sql: string): Promise<T[]> {
  const account = env("CF_ACCOUNT_ID") || env("CLOUDFLARE_ACCOUNT_ID");
  const token =
    env("CF_API_TOKEN") ||
    env("CLOUDFLARE_USER_API") ||
    env("CF_WORKER_R2_API");
  if (!account || !token) throw new Error("missing CF account/token");

  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const listJson = (await listRes.json()) as {
    success: boolean;
    result?: Array<{ name: string; uuid: string }>;
  };
  const db = listJson.result?.find((d) => d.name === dbName);
  if (!db) throw new Error(`D1 not found: ${dbName}`);

  const qRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db.uuid}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params: [] }),
    },
  );
  const qJson = (await qRes.json()) as {
    success: boolean;
    result?: Array<{ results: T[] }>;
  };
  if (!qJson.success) throw new Error(`D1 query failed: ${dbName}`);
  return qJson.result?.[0]?.results ?? [];
}

export default async function handler(
  req: { method?: string },
  res: {
    setHeader: (k: string, v: string) => void;
    status: (n: number) => { json: (b: unknown) => void };
  },
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60");
  if (req.method === "OPTIONS") {
    res.status(204).json({});
    return;
  }

  try {
    const [heroRows, modelRows] = await Promise.all([
      d1Query<HeroRow>(
        "GRUDGE",
        "SELECT id, name, title, race_id, class_id, faction, stars, level, weapon FROM heroes ORDER BY stars DESC, name ASC",
      ),
      d1Query<ModelRow>(
        "grudge-models",
        "SELECT race_id, name, faction_name, faction_color, r2_url FROM models",
      ),
    ]);
    const byRace = new Map(modelRows.map((m) => [m.race_id, m]));
    const races = modelRows.map((m) => ({
      raceId: m.race_id,
      name: m.name,
      factionName: m.faction_name,
      factionColor: m.faction_color,
      modelUrl: m.r2_url,
    }));
    const heroes = heroRows
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
        };
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
    res.status(200).json({ heroes, races });
  } catch {
    res.status(200).json({ heroes: [], races: [] });
  }
}

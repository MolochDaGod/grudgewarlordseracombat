// Cloudflare D1 via account token (local env / Vercel / Railway).
// Replaces the Replit connectors-sdk proxy. Token is never exposed to the client.
import { logger } from "./logger";

function cfAccount(): string {
  const id = (
    process.env.CF_ACCOUNT_ID ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    ""
  ).trim();
  if (!id) throw new Error("CF_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID is not set");
  return id;
}

function cfToken(): string {
  const token = (
    process.env.CF_API_TOKEN ||
    process.env.CLOUDFLARE_USER_API ||
    process.env.CF_WORKER_R2_API ||
    ""
  ).trim();
  if (!token) throw new Error("CF_API_TOKEN / CLOUDFLARE_USER_API is not set");
  return token;
}

async function cfProxy<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `https://api.cloudflare.com/client/v4${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfToken()}`,
      "Content-Type": "application/json",
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = (await res.json()) as T;
  return json;
}

type CfList<T> = { success: boolean; result: T[] | null; errors?: unknown[] };

let accountIdCache: string | null = null;
async function getAccountId(): Promise<string> {
  if (accountIdCache) return accountIdCache;
  try {
    accountIdCache = cfAccount();
    return accountIdCache;
  } catch {
    const data = await cfProxy<CfList<{ id: string; name: string }>>(
      "/accounts",
    );
    const id = data.result?.[0]?.id;
    if (!id) throw new Error("Cloudflare: no accounts available");
    accountIdCache = id;
    return id;
  }
}

const d1UuidCache = new Map<string, string>();
async function getD1Uuid(dbName: string): Promise<string> {
  const cached = d1UuidCache.get(dbName);
  if (cached) return cached;
  const acc = await getAccountId();
  const data = await cfProxy<CfList<{ name: string; uuid: string }>>(
    `/accounts/${acc}/d1/database`,
  );
  const db = data.result?.find((d) => d.name === dbName);
  if (!db) throw new Error(`Cloudflare D1 database not found: ${dbName}`);
  d1UuidCache.set(dbName, db.uuid);
  return db.uuid;
}

type D1QueryResult<Row> = {
  success: boolean;
  result?: Array<{ results: Row[]; success: boolean }>;
  errors?: Array<{ code: number; message: string }>;
};

export async function d1Query<Row = Record<string, unknown>>(
  dbName: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const acc = await getAccountId();
  const uuid = await getD1Uuid(dbName);
  const data = await cfProxy<D1QueryResult<Row>>(
    `/accounts/${acc}/d1/database/${uuid}/query`,
    { method: "POST", body: { sql, params } },
  );
  if (!data.success) {
    const msg = data.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    logger.error({ dbName, msg }, "Cloudflare D1 query failed");
    throw new Error(`D1 query failed: ${msg}`);
  }
  return data.result?.[0]?.results ?? [];
}

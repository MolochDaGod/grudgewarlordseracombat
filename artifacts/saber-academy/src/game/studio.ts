// Weapon Skill Studio — engine-side glue (kept out of SaberGame to avoid
// bloating it). This module owns the "save to game files" transport and small
// helpers the Studio needs; the live-apply / catalog data itself lives in
// skillcatalog.ts. The React admin panel lives in GameCanvas.tsx.

import type { WeaponSkillCatalog } from "./skillcatalog";

/** Dev-only endpoint exposed by the Vite plugin in vite.config.ts. */
export const SAVE_ENDPOINT = "/__save-skills";

export interface SaveResult {
  ok: boolean;
  /** Human-readable status/error for the Studio toast. */
  message: string;
}

/** True only under the Vite dev server; the save endpoint never exists in a
 * production build, so the Studio Save button warns instead of POSTing. */
export function studioSaveAvailable(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * Persist the current catalog to the JSON file inside the project via the
 * dev-only Vite endpoint. On a production build (no dev server) this refuses
 * with a clear message instead of hitting a route that isn't mounted.
 */
export async function saveCatalog(
  next: WeaponSkillCatalog,
): Promise<SaveResult> {
  if (!studioSaveAvailable()) {
    return {
      ok: false,
      message:
        "Saving is only available under the dev server. Run the game in development to write skill edits back to the game files.",
    };
  }
  try {
    const base = import.meta.env.BASE_URL || "/";
    const url = `${base.replace(/\/$/, "")}${SAVE_ENDPOINT}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next, null, 2),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, message: `Save failed (HTTP ${res.status}). ${text}`.trim() };
    }
    return { ok: true, message: "Saved to weapon-skills.json — now the source of truth for all modes." };
  } catch (err) {
    return {
      ok: false,
      message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

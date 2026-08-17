/** Fleet CDN SSOT — binaries on assets.grudge-studio.com, never SPA-bundled race kits. */
export const ASSETS_CDN =
  (import.meta.env.VITE_ASSETS_URL as string | undefined)?.replace(/\/$/, "") ||
  "https://assets.grudge-studio.com";

export const TOON_RTS_CDN = `${ASSETS_CDN}/asset-packs/toon-rts-characters/glb/characters`;

/** Local filename prefix -> CDN race kit id (highelf ships as elf.glb). */
export const TOON_CDN_RACE: Record<string, string> = {
  human: "human",
  barbarian: "barbarian",
  dwarf: "dwarf",
  highelf: "elf",
  orc: "orc",
  undead: "undead",
};

export function toonRaceKitUrl(localFile: string): string {
  const id = TOON_CDN_RACE[localFile] ?? localFile;
  return `${TOON_RTS_CDN}/${id}.glb`;
}

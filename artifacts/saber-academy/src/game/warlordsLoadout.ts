import * as THREE from "three";

/**
 * Warlords-era kit visibility (mesh_ids style) on Toon RTS race packs.
 * One body/arms/legs/head/shoulders letter + one weapon. No GLB swap.
 * Names from race-models.json: {PREFIX}Units_Body_{A..} / _weapon_sword_A
 */

export type LoadoutRace =
  | "human"
  | "barbarian"
  | "highelf"
  | "dwarf"
  | "orc"
  | "undead";

export interface WarlordsLoadout {
  id: string;
  label: string;
  race: LoadoutRace;
  weapon: string;
  body: string;
  arms: string;
  legs: string;
  head: string;
  shoulders: string;
}

export const RACE_PREFIX: Record<LoadoutRace, string> = {
  human: "WK_",
  barbarian: "BRB_",
  highelf: "ELF_",
  dwarf: "DWF_",
  orc: "ORC_",
  undead: "UD_",
};

/** Wide test matrix: every race × knight / warrior / ranger / mage. */
export const WARLORDS_TEST_LOADOUTS: WarlordsLoadout[] = (
  [
    ["human", "Crusade"],
    ["barbarian", "Fabled"],
    ["highelf", "High Elf"],
    ["dwarf", "Dwarf"],
    ["orc", "Orc"],
    ["undead", "Undead"],
  ] as const
).flatMap(([race, faction], ri) => {
  const letter = String.fromCharCode(65 + (ri % 5));
  const r = race as LoadoutRace;
  return [
    {
      id: `${r}-knight`,
      label: `${faction} Knight`,
      race: r,
      weapon: "sword and shield",
      body: letter,
      arms: letter,
      legs: "A",
      head: letter,
      shoulders: "A",
    },
    {
      id: `${r}-warrior`,
      label: `${faction} Warrior`,
      race: r,
      weapon: "greatsword",
      body: "B",
      arms: "B",
      legs: "B",
      head: "B",
      shoulders: "B",
    },
    {
      id: `${r}-ranger`,
      label: `${faction} Ranger`,
      race: r,
      weapon: "bow",
      body: "C",
      arms: "C",
      legs: "C",
      head: "C",
      shoulders: "A",
    },
    {
      id: `${r}-mage`,
      label: `${faction} Mage`,
      race: r,
      weapon: "staff",
      body: "D",
      arms: "D",
      legs: "A",
      head: "D",
      shoulders: "B",
    },
  ];
});

function slotLetter(name: string, slot: string): string | null {
  const m = name.match(new RegExp(`${slot}[_\\s-]*([a-i])\\b`, "i"));
  return m ? m[1].toUpperCase() : null;
}

/**
 * Hide extra kit parts; show one letter per slot + matching weapon/staff.
 */
export function applyWarlordsLoadout(
  root: THREE.Object3D,
  loadout: WarlordsLoadout,
): void {
  const wantWeapon = /bow/i.test(loadout.weapon)
    ? "bow"
    : /staff|wand/i.test(loadout.weapon)
      ? "staff"
      : /axe/i.test(loadout.weapon)
        ? "axe"
        : /hammer|maul/i.test(loadout.weapon)
          ? "hammer"
          : /spear|lance/i.test(loadout.weapon)
            ? "spear"
            : "sword";
  const keepShield = /shield/i.test(loadout.weapon);
  const slotWant: Record<string, string> = {
    body: loadout.body,
    arms: loadout.arms,
    legs: loadout.legs,
    head: loadout.head,
    shoulder: loadout.shoulders,
  };

  const weaponMeshes: THREE.Object3D[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const n = o.name.toLowerCase();
    if (/weapon/i.test(n)) {
      o.visible = false;
      weaponMeshes.push(o);
      return;
    }
    if (/quiver|_bag|_wood|xtra/.test(n)) {
      o.visible = false;
      return;
    }
    if (/shield/i.test(n)) {
      o.visible = keepShield;
      return;
    }
    for (const slot of Object.keys(slotWant)) {
      if (!n.includes(slot)) continue;
      const letter = slotLetter(n, slot);
      if (letter) o.visible = letter === slotWant[slot];
      return;
    }
  });

  const re = new RegExp(`weapon[_ ]?${wantWeapon}`, "i");
  let chosen = weaponMeshes.find((m) => re.test(m.name));
  if (!chosen) chosen = weaponMeshes.find((m) => /weapon[_ ]?sword/i.test(m.name));
  if (chosen) chosen.visible = true;

  root.userData.warlordsLoadout = loadout;
}

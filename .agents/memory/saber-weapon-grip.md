---
name: Saber Academy weapon grip attachment
description: How attached (non-embedded) weapons are oriented on hand bones, and why orientation is skeleton-derived rather than a fixed Euler.
---

# Skeleton-derived weapon grip

Two kinds of weapons in Saber Academy:
- **Champions (Bip001 GLB kits):** weapon mesh is embedded as a child of an
  artist-authored hand container (`R_hand_container`). No runtime attach — it
  rides the bone hierarchy for free. `pruneKit` just reveals the right mesh.
- **FBX rigs with no embedded weapon (Lucy, Racalvin, the Heavy's rifle):** a
  procedural prop (`makeBlade`/`makeGun`) is attached and re-placed onto the
  hand bone each frame (`updateSaberFollow` via a `gripMatrix`).

**Rule:** for the FBX rigs, the grip orientation is derived from the skeleton,
not a hardcoded Euler. `gripFromHandBone` reads the hand bone's real "down the
fingers" direction (the hand-local vector to its first child bone) and rotates
the weapon's modeled length axis (+Y) onto it with `setFromUnitVectors`. A small
per-weapon `roll` (spin about the length axis) and `seat` (slide into the palm)
are layered on top, both no-op by default.

**Why:** a single fixed `Euler(PI/2,0,0)` grip cannot fit every rig — each FBX
hand bone has a different bind orientation, so one guess leaves the blade/rifle
dangling at a wrong angle (seen on Lucy). Reading the bone's own child direction
adapts per-rig automatically. None of these rigs has a Bip001 `R_hand_container`,
so they always hit this fallback path.

**How to apply / tune:** if a weapon's flat/edge or sights face wrong, set the
per-weapon `*_GRIP_ROLL` (about +Y); to seat the handle deeper, set `*_GRIP_SEAT`
(note: seat is in hand-LOCAL units, so it gets scaled by the bone's world scale —
on heavily-scaled mixamo armatures a local seat barely moves the prop; prefer
adjusting the geometry layout in `makeBlade`/`makeGun` for a visible world-space
shift). Orientation can only be confirmed visually (WebGL does not render
headless), so changes here need the user's eyes.

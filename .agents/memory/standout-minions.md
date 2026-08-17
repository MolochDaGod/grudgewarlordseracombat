---
name: Standout minion FBX rigs
description: Lessons from integrating itch.io "Standout" low-poly FBX packs (marauders/elves) as retargeted minions.
---

- These packs are rigged on a Blender "basic human" skeleton (spine..spine006, upper_armL/forearmL/handL, thighL/shinL/footL) with NO embedded clips; weapons are separate static FBX meshes with grip at origin and length along +Y (same convention as the game's makeBlade), plus a shared palette texture (use NearestFilter to avoid swatch bleed).
- **Duplicate-named nested bone chains:** each skinned mesh in these FBX files binds to its own copy of the skeleton, and copies appear as nested chains of identical-named bones. Rule: bake AND bind against the FIRST depth-first match per name (three's PropertyBinding resolves first-DFS) — inner duplicates inherit the rotation. `collectBonesNormalized` in retarget.ts must keep-first, not overwrite.
  - **Why:** keeping the last match made the bake target a different bone than the mixer drives; verified numerically that first-DFS driving cascades to the deepest chain (equal world rotation deltas).
- **Shared weapon clones must not be disposed per instance:** minion weapons are `clone(true)` of a cached template — geometry/material/palette texture are shared. `CharacterInstance.sharedWeapon` flags this so disposeInstance skips disposeTree, or the first death corrupts every survivor's weapon.
- Facing is read from the skeleton (toeL vs heel02L world z; game forward is +Z at yaw 0) instead of trusting the export convention.

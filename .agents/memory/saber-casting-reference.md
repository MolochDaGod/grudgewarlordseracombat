---
name: Saber casting reference repos
description: MolochDaGod GitHub repos are the design reference for ability casting, VFX, and HUD work in Saber Academy.
---

The user designated three GitHub repos as required references for skills/casting/HUD/gameplay work:
- `MolochDaGod/LinearAbiltyCastingThreeJS` — cleanest portable pattern: ability phase machine (TRAVEL→IMPACT→FADE→DONE), pooled manager, ground-line aim `(origin, direction, distance)` separated from effect code, per-element cooldowns living in the host app not the ability.
- `MolochDaGod/CastingAbilitiesThreeJS` — extensive `docs/*_SSOT.md` design docs (10 spells, linear skillshots, element presentation meshes, CraftPix HUD, melee combos, mastery/drop systems).
- `MolochDaGod/threejs-rapier-react-three-controller` — pnpm monorepo with AbilityDef sequencer (cast→release→travel→impact→status with host hook closures), GLB VFX cloning rules (never dispose shared maps per instance), instanced billboard particles (quaternion w packs billboard mode, premultiplied additive to skip depth sort), HUD editor (DOM-side config, engine-authoritative cooldown timestamps, rAF sweep interpolation).

Dependencies: nothing to install — their transferable patterns need only three (~0.185) + @dimforge/rapier3d-compat (~0.19), both already present. lil-gui/xstate/React/postprocessing in those repos are optional authoring/host-shell tooling, not prerequisites.

Abilities-editor pattern (ported to casting.ts as `registerCastAbility`): AbilityDef is pure lifecycle data (cast→release→travel→impact→status), a plain registry keyed by id with `registerAbility(def)` for runtime additions; economy (damage/cost/cooldown) and rendering live in the engine host, never in the def. Adding a skill = register a def + host hooks; HUD reads engine-authoritative cooldowns.

**How to apply:** clone to `/tmp/refsrc` when needed (shallow). Saber Academy's `casting.ts` is the v1 port (fire/ice/thunder on keys 1-3). Future skill/HUD work should mine these repos before inventing new patterns — especially the SSOT docs for spell rosters and the controller repo's particle/HUD implementations.

---
name: Saber Academy real-character models
description: Loading Grudge GLB characters (Cloudflare D1/R2) into the three.js game, animation strategy, and disposal pitfalls.
---

# Real character models (Cloudflare D1/R2)

## Data source
- Heroes live in Cloudflare D1 (DB `GRUDGE`, table `heroes`); model metadata in D1 `grudge-models`.
- 6 race GLBs (human/barbarian/elf/dwarf/orc/undead) are PUBLIC at `https://assets.grudge-studio.com/models/characters/{race}.glb` (9-11MB each).
- The api-server `/api/saber/roster` joins heroes to their race GLB URL + faction color (via `@replit/connectors-sdk` Cloudflare proxy, path prefix `/v4/...`).

## Models are Bip001 "kits"
- 3ds-Max Biped, identical 25-bone `Bip001` skeleton across all races. **No embedded animations; no clip-compatible anim packs** (zero bone overlap with Mixamo/kaykit).
- Each GLB contains MANY variant meshes per slot (body/head/arms/legs/shoulderpad, prefixed per race) plus weapon/shield meshes. Keep one mesh per slot, hide the rest + weapons, then attach your own saber.

## Animation decision (important)
- For the **Bip001 Grudge kits**, animate **procedurally at the model-group + saber-pivot level, NOT on skeleton bones.**
- **Why:** the Bip001 bone local axes are unknown, and WebGL cannot render in this environment to validate bone rotations — wrong-axis bone rotation would look broken with no way to catch it. Group bob/lean/twist + a fully-controlled saber pivot is safe and reliable.
- **How to apply:** if you later add skeletal animation to Bip001, retarget Mixamo clips via `SkeletonUtils.retargetClip` and have the user visually confirm.
- **Exception — mixamorig characters (Lucy):** real skeletal animation IS used (Mixamo clips play directly, no retarget). See `saber-academy-mixamo.md`. The two paths coexist via `CharacterInstance.rig` (`bip001` | `mixamo` | `capsule`) branched in `updateCharacterAnim`.

## Disposal pitfall (caused a code-review FAIL once)
- `SkeletonUtils.clone` shares geometry/material with the cached template and sibling clones.
- **Never** recursively dispose a cloned GLB body — it frees GPU resources still used by other clones/the template, corrupting rendering over waves/restarts.
- Only dispose per-instance resources: the saber, and (enemies) the health-bar texture + SpriteMaterial. Capsule fallbacks DO own their meshes, so dispose those. See `disposeInstance` (`isModel` gate) and `disposeEnemy`.

## Async start race
- `start()` loads models async. Guard with a `startVersion` token: build instances WITHOUT mutating scene state, and after each `await` bail (disposing the freshly-built instance) if `disposed` or the token is stale. Commit (attach + assign defs) only for the winning token.

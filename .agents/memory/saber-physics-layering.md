---
name: Saber physics layering
description: How physics/collision is layered in Saber Academy's three.js engine and why it must stay optional.
---

# Saber Academy physics + collision layering

The combat/movement engine (`artifacts/saber-academy/src/game/SaberGame.ts`) runs on plain math first. Rapier (`physics.ts`) and three-mesh-bvh (`worldbvh.ts`) are **optional acceleration/accuracy layers**, not hard dependencies.

**Rule:** every physics/BVH call must be null-guarded; if init fails the game must still play on the math path.

**Why:** Rapier is a WASM module (`@dimforge/rapier3d-compat`) that can fail to load, and BVH baking can throw on odd geometry. WebGL/3D cannot be verified in the headless screenshot environment, so the game must degrade gracefully without a human in the loop.

**How to apply:**
- Rapier resolves **horizontal collide-and-slide only**. Gravity, jump, and vertical velocity stay engine-owned — do not move grounding into Rapier.
- `StaticWorldBVH.groundHeight` is the authoritative floor in *both* the physics and fallback paths; fall back to flat ground (`?? 0`) when it (or the BVH) is null.
- `StaticWorldBVH.resolveWalls` is a mesh-accurate wall constraint (capsule-vs-triangle `bvh.shapecast` + `ExtendedTriangle.closestPointToSegment`) layered in `moveBody` **on top of** the Rapier result, so pillars stay un-clippable even when Rapier is down. The pushout is HORIZONTAL-only (`push.y = 0`) so the flat floor (which shares the same baked BVH) is a no-op and gravity stays engine-owned. `moveBody` now takes per-entity `radius`/`height`.
- Melee = blade world-segment vs per-enemy baked `BodyHitter` BVH (`refit()` once per swing), with a segment-vs-capsule fallback.
- Init lives in `ensurePhysics(token)`, startVersion-guarded and wrapped in try/catch; dispose a partially-built `PhysicsWorld` in the catch so a failed init does not leak.
- Cloned GLB instances share geometry with the cached template — only dispose per-instance baked BVH geometry, never the shared body. Enemy bodies/hitters are created only when physics exists and freed in `disposeEnemy`; player body + world + static BVH freed in `teardownPhysics`.

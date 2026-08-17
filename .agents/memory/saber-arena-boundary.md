---
name: Saber Academy arena boundary
description: How the playable-area boundary is enforced and why it must be geometry, not a math clamp
---

# Arena boundary (saber-academy)

The arena edge is enforced by a **real boundary-wall collider** (a tall,
open-ended cylinder built in `buildArena` and pushed to `staticColliders`), not a
hand-rolled radius clamp on the player position.

**Why:** the project's stated direction is that world bounds come from real
geometry through the physics/BVH layer (Rapier collide-and-slide + the world
BVH `resolveWalls`). A `r > N` position clamp short-circuits that layer, only
bounds the player (not enemies), and feels like a hard snap rather than a wall.

**How to apply:**
- The wall must be in `staticColliders` so BOTH the Rapier static-mesh build and
  the `StaticWorldBVH` (built from the same array) include it.
- A character's capsule stops at roughly `wallRadius - capsuleRadius`; size the
  wall radius inside the floor disc so characters never walk off the visible
  floor. Make the wall tall enough to cover jump apex so the capsule spine always
  intersects it.
- Do not reintroduce a position clamp as a "safety net"; if characters escape,
  fix/extend the collision geometry instead.

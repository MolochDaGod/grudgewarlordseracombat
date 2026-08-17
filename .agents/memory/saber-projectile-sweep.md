---
name: Saber Academy projectile collision
description: Why bullets/projectiles use swept-segment collision instead of per-frame point tests
---

Fast in-flight projectiles (e.g. the Heavy gunner's tracer bullets) must test the
whole segment travelled this frame against the target sphere, not just the bullet's
new point position.

**Why:** the render loop caps dt (~0.05s). A bullet at speed ~34 moves up to ~1.7
units/frame, which is larger than the ~0.9 hit sphere, so a discrete point-vs-point
distance check skips (tunnels) right past the player and the hit never registers —
breaking block/parry interception that depends on the bullet reaching the player.

**How to apply:** before moving, capture `from`; after moving, find the closest
point on segment `[from, new]` to the target (clamped projection), then test that
distance against the radius. This applies to any new fast projectile, not just bullets.

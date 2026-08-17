---
name: Saber Academy enemy lifecycle & VFX disposal
description: Non-obvious rules for killing/removing enemies and disposing VFX sprites in SaberGame, especially under the endless sandbox mode.
---

# Enemy lifecycle

`killEnemy` only marks `alive = false` and disposes per-enemy resources — it does **NOT** splice the enemy out of `this.enemies`. Removal happens once per render frame by compacting `this.enemies = this.enemies.filter(e => e.alive)`.

**Why:** `killEnemy` can be invoked *while iterating* `this.enemies` (e.g. nova/projectile AoE loops call `damageEnemy` → `killEnemy`). Splicing during iteration would skip elements. Deferring removal to a single compaction at frame end avoids mutation-during-iteration.

**How to apply:** wave logic that asks "are all enemies dead?" must use `enemiesAlive()` (filters by `alive`), never `this.enemies.length`. If you add another endless/free-play mode, make sure the per-frame compaction still runs or the array leaks disposed enemy refs.

# Sandbox clear and pending attack timers

Enemy melee uses a delayed-hit timeout (`schedule(..., ~240ms)`) whose closure bails on `this.disposed || !e.alive || phase !== "playing"`. `sandboxClear()` must set `e.alive = false` **before** disposing each enemy, otherwise a pending closure passes its guard and calls `damagePlayer` after the arena was cleared. (Waves restart is safe because `resetRun` calls `clearTimers`; sandboxClear does not.)

# VFX sprite disposal

VFX sprites (projectiles/novas/flashes) own per-instance `SpriteMaterial`s that must be disposed, but the underlying **texture cache is shared** and is disposed once in `dispose()` — never per-sprite. Disposing a shared VFX texture per-sprite would blank later effects.

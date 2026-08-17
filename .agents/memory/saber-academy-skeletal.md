---
name: Saber Academy skeletal animation paths
description: How real skeletal animation is wired and the most reliable path to add a new animated character
---

# Skeletal animation paths (saber-academy)

There are three skeletal paths; the most reliable one for a NEW character is the
self-contained rigged FBX.

- **Bip001 retarget** (the live D1-roster champions): GLB kits ship no animations,
  so the remote Mixamo clip library is baked onto their Bip001 rig at load
  (`retarget.ts`). Depends on the remote host `assets.grudge-studio.com`. The
  retarget math is sound; failures here are almost always the remote fetch, not
  the baker. It silently falls back to procedural animation on any failure.
- **Direct mixamorig** (Lucy): a mixamorig FBX driven by the remote clip library
  directly (same rig, no retargeting). Still depends on the remote host.
- **Self-contained rigged FBX (Racalvin)** — BEST path, no remote dependency.
  The character FBX AND its clip FBX files come from the SAME export (identical
  skeleton, mixamo-style bone names with NO `mixamorig:` prefix), so the clips
  bind by bone name and play directly through the mixer. No retargeting, all
  assets local in `public/models/<name>/`.

**Why this matters:** when "skeletal not applying" is reported and the remote
hosts are reachable, the failure is environmental/remote, not the code. The
robust fix is a self-contained local rigged-FBX character (clips bundled in the
same skeleton), mirroring the Lucy/Heavy direct-mixer pattern.

**How to apply (new local animated character):** mirror the Lucy/Heavy
direct-mixer pattern — local rigged FBX + per-clip FBX in `public/models/<name>/`,
a `rig` discriminant with a branch in `SaberGame.loadPlayerInstance`, and clips
loaded via `loadClip` (strips `Hips.position` so the engine keeps world position).
Key gotchas:
- Locomotion clips must NOT carry root translation, or the character slides.
- Missing clips (jump/guard/hit/death) are safe: `crossfadeTo` no-ops when the
  action is absent, holding the current pose.
- Player-only heroes must be excluded from the enemy pool (filter on `!h.rig`).
- If the hero is auto-selected at unlock time, post-fetch default-selection must
  not clobber an existing selection (use `prev ?? default`), or the auto-select
  is lost to a roster-load race.

**Headless limit:** WebGL cannot render in the screenshot/headless env, so
animation correctness and model facing/scale must be confirmed by the user.
Always build defensively (capsule fallback, embedded-texture fallback, tunable
yaw).

**Clips play at fixed authored speed unless time-scaled — and `crossfadeTo`
resets it.** Mixer actions default to `timeScale=1`, so attack clips drift out of
sync with the gameplay hit window and locomotion clips foot-slide when world
speed != authored stride. Fix in `updateMixamo`: scale the attack action to
`clipDuration/strikeDur` (clamped) so the swing fills `attackDur`, and scale
run/walk/strafe by `speed01`. Critical gotcha: `crossfadeTo` calls
`setEffectiveTimeScale(1)` on the incoming action, so any per-clip timeScale
override must be **re-applied every frame** after `crossfadeTo`, not set once.
`AnimState.strikeDur` threads the swing duration from the engine to the mixer.

**Root between feet:** `normalize()` roots a model at the world midpoint of its
foot bones (any bone whose sanitized name ends in `foot`), not the bbox center,
so arms/capes/weapons don't skew the stance pivot. Falls back to bbox center for
rigs without foot bones.

**Strafe-clip basis must match movement right:** the animation "right" vector in
`updatePlayerAnim` must equal the camera/movement right basis
`camRight = (-fwd.z, 0, fwd.x)`, i.e. `(-cos(facing), 0, sin(facing))`. The
opposite sign silently swaps the `strafeLeft`/`strafeRight` clips. Strafe clips
only fire when the body is strafe-locked (facing decoupled from velocity) — true
in animtest AND while lock-on is active; the default turn-to-face combat makes
strafe ~0 so those clips never play.

## Toon RTS faction GLBs
Self-contained Bip001 rigs with UNDERSCORE bone names — only normalized (non-alphanumeric-stripped) bone matching works; never add exact-name lookups. Their embedded clips play directly on their own skeleton (no retarget) — the most robust path. "attack" on ranger/mage rigs is the class shot/cast and those rigs have NO guard clip, so every action lookup must tolerate missing clips. Ranged enemies must set the swing timer when firing or the shot animation never plays.

- Model facing is skeleton-derived in normalize(): toe-vs-foot/heel heading snapped to nearest quarter turn (toonrts GLBs face +X, i.e. 90 deg off; standout packs vary). Never hardcode per-pack yaw constants.

---
name: Mixamo to Bip001 retargeting (Saber Academy)
description: How/why Mixamo clips are baked onto the Grudge Bip001 rig, and the headless-verification gotchas that make this hard to redo.
---

# Mixamo -> Grudge Bip001 retargeting

The Grudge champion GLBs use a 3ds Max Biped (Bip001) skeleton with NO embedded
animations and no clip-compatible packs. The Mixamo clip library (mixamorig rig)
is **retargeted/baked** onto Bip001 at load time so champions get real skeletal
animation. Lucy is a real mixamorig FBX and plays the same clips directly.

## Non-obvious facts (cost real effort to discover)

- **FBXLoader strips the colon.** `mixamorig:Hips` becomes `mixamorigHips` on both
  bone names AND clip track names. Any exact `"mixamorig:..."` lookup silently
  misses. Always match bones colon-insensitively: `s.replace(/[^a-z0-9]/gi,"").toLowerCase()`.
  This was also a latent bug in the original Lucy saber-hand attach.
- **WebGL cannot render in the headless screenshot env** ("BindToCurrentSequence
  failed"). Retarget correctness (pose, saber/blade orientation) is NOT visually
  verifiable here — only numerically. Final look needs the user's eyes.
- The Bip001 skin has only **18 skinned joints** (single `Bip001 Spine`, NO
  Spine1/2; toes not skinned). Map Mixamo `Spine1` -> Bip001 `Spine`.
- All six races (human/barbarian/elf/dwarf/orc/undead) share **one identical**
  Bip001 rig, so bake clips ONCE and cache globally.
- **The remote Mixamo clip host (`assets.grudge-studio.com/animations`) and the
  champion GLB host go up and down.** When they 404, the engine silently falls
  back to procedural animation and prints stale "library failed / using
  procedural" logs. Before assuming the retarget code is broken, curl a clip URL
  (URL-encode each path segment, e.g. `locomotion/idle.fbx`) and check for 200.
  `playerInst.mixer` present == real skeletal; absent == procedural/capsule.
- **Strafe clips only fire when the body is strafe-locked.** The combat modes are
  turn-to-face (`facing = atan2(velocity)` every moving frame), so the strafe
  value is ~0 and `strafeLeft`/`strafeRight` never play. The Animation Test mode
  locks `facing` to the camera heading to exercise/inspect them.

## Bake method (world-delta) — why this and not built-in retargetClip

SkeletonUtils.retargetClip needs per-bone bind offsets for mismatched binds.
Instead use a world-space delta bake (in `retarget.ts`):
`delta = qSrcAnimWorld * qSrcBindWorld^-1`; `qTgtWorld = (F*delta*F^-1)*qTgtBindWorld`;
`qTgtLocal = qTgtParentWorld^-1 * qTgtWorld`, bones processed **parent-first**.
Delta is identity at the source bind, so each skeleton keeps its own bind pose
with no manual offsets; rotations only, so bone lengths are preserved. `F` is a
small basis-alignment correction (head-pelvis up, R-L upperarm right); measured
~2.8deg here, i.e. the two rigs already share a global frame.

**Output track names are node-name based (`<bone>.quaternion`), not `.bones[...]`,**
so the mixer binds against the model Group (three track node names allow spaces),
matching the Lucy path and keeping `disposeInstance`/`uncacheRoot` uniform.

## Saber grip

Per-instance `gripMatrix` (hand-bone local). Bip001 grip is derived from the
artist locator `R_hand_container` (`inv(hand.world)*container.world`, scale
stripped) — deterministic, not guessed. `BIP_GRIP_ADJUST`/`SABER_GRIP_QUAT` are
the tunable knobs if the blade points the wrong way (user must confirm visually).

## Headless numeric verification harness (recreate if needed)

A throwaway Node harness validated the math (deleted after use). To rebuild: run
FROM the artifact dir; `globalThis.self=globalThis`; import three via explicit
path `node_modules/.pnpm/three@0.160.1/.../three.module.js`; build the target
bone tree directly from GLB JSON node hierarchy (avoid GL/texture loading);
`FBXLoader.parse` works for the source. Sanity checks that pass: arm length
preserved exactly (rotations-only), head above pelvis, idle hands hang at sides.

---
name: Bip001 retarget bake is healthy (verified numerically)
description: Evidence that the mixamorig->Bip001 world-delta retarget bake is mathematically sound; how to probe it headless when WebGL can't render.
---

# Bip001 retarget bake health

The champion animation pipeline (mixamorig FBX clips baked onto the Bip001 GLB
skeleton via the world-space delta method in `retarget.ts`) is **sound**. When a
user reports champion animations look broken (twisted/stiff/barely-moving), the
most likely cause is NOT the bake math — it is the procedural fallback kicking in
because the real retarget threw (e.g. a bone-name lookup miss). Check that the
retarget actually runs before touching the bake.

**Why:** Measured headless on `dwarf.glb` + `sword_shield` clips (three 0.184):
- The global basis correction `F` between the two rigs is ~1.66° (≈ identity):
  both rigs are authored facing the same way (up +Y, right -X, fwd -Z). `F` is
  harmless — it is NOT the source of any tilt/wrong-facing.
- Per-bone bind WORLD-quaternion differences are large (100–150°), but world-delta
  retargeting cancels this by design (it transfers world-space rotation *change*,
  preserving each rig's own bind roll), so the big bind diff is expected and fine.
- A full bake of the run clip produced clean, full-range, NaN-free motion
  (thighs 60–75°, calves 78–88°, feet 68–74°, arms 38–58°). Not stiff, not collapsed.

**How to apply:** WebGL can't render headless ("BindToCurrentSequence failed"), but
the bake is pure numeric three.js and CAN run in the code_execution sandbox:
- `globalThis.self = globalThis` before importing jsm loaders.
- FBX loads fine via `FBXLoader.parse(arrayBuffer, '')`.
- GLTFLoader chokes on textures in Node ("self is not defined" / unsupported asset
  after stripping). Easiest path: don't use GLTFLoader at all — parse the GLB JSON
  chunk (bytes at offset 20, length at offset 12) and rebuild the Bip001 bind pose
  as a `THREE.Bone` tree directly from `json.nodes` (TRS or matrix + children).
- Then replicate the `bakeOne` formula inline to inspect motion magnitude / NaN.

Residual feel issues that are real but NOT bake bugs: foot sliding during
locomotion is inherent to in-place mixamo clips (engine translates the body); fix
by speed-syncing clip `timeScale`, not by changing the bake.

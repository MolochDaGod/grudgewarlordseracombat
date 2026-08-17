---
name: GLTFLoader node-name sanitization breaks exact bone lookups
description: three's GLTFLoader rewrites spaces in node/bone names to underscores; exact-string bone matching against the raw GLB names silently fails.
---

# GLTFLoader sanitizes node names

`THREE.GLTFLoader` runs every node name through `THREE.PropertyBinding.sanitizeNodeName`,
which replaces whitespace with `_` (and strips `.[]` etc). So a GLB bone authored as
`Bip001 Pelvis` (spaces — what you see in the raw glTF JSON) loads into the scene as
`Bip001_Pelvis`.

**Why this bites:** any code that matches bones by the *raw* name with spaces (e.g. a
`BONE_MAP` keyed `"Bip001 Pelvis"`, or a `QuaternionKeyframeTrack` named
`"Bip001 Pelvis.quaternion"`) will silently find no target. A throwing lookup falls back
to a non-animated path; a non-throwing one (mixer track binding) plays but moves nothing.

**How to apply:**
- Always match GLB bones by a *normalized* name (strip all non-alphanumerics + lowercase),
  the same way FBX `mixorig:` colon names are handled. Don't trust the names in the raw
  glTF JSON (what `python`/a hex dump shows) — they are pre-sanitization.
- When emitting animation tracks for a GLB skeleton, build the track path from the
  *loaded* bone's `.name` (already sanitized), not from your canonical map key.
- Debugging trap: a substring/`startsWith("Bip001")` check matches BOTH `Bip001 Pelvis`
  and `Bip001_Pelvis`, so it will NOT reveal the mismatch. Print the exact `bone.name`
  or compare with `sanitizeNodeName(rawName)`.

This was the root cause of the saber-academy champions (Bip001 GLB kits) showing only the
procedural fallback instead of real skeletal animation: the retarget bake threw
"missing target Bip001 Pelvis" and dropped to `instantiateModel`.

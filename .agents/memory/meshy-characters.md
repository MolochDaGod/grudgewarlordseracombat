---
name: Meshy character pipeline
description: How Meshy AI-generated rigged characters integrate with the retarget system, and their rig naming.
---
- Meshy auto-rig emits a Mixamo-style skeleton WITHOUT the `mixamorig:` prefix (`Hips`, `Spine01/02`, lowercase `neck`, `Left/RightForeArm`, ...). It is a distinct rig kind — detect it and retarget the Mixamo library onto it with a Meshy-specific bone map; never assume it plays mixamorig clips directly.
- Meshy characters have per-character bind poses, so retarget bake caches must key per model × category (Bip001 rigs share one skeleton, so per-category is fine there). Keep the bake cache bounded — per-model keys grow unbounded otherwise.
- Meshy models may legitimately carry shields/bags/quivers; kit-pruning logic written for Grudge champions hides them. Fallback paths need a Meshy-specific instantiator (no pruneKit, blade on `RightHand`).
- The generation pipeline script is resumable via a state file; that state file contains signed asset URLs (credentials in query strings) — keep it gitignored, never commit it.
**Why:** these lessons came from integrating 4 Meshy heroes; the naming/bind-pose facts are not visible in code without parsing GLBs.
**How to apply:** whenever adding more AI-generated characters or touching the retarget/caching path.

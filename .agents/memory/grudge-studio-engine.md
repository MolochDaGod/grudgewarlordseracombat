---
name: grudge-studio engine
description: Quirks of the grudge-studio npm 3D SDK when building a three.js browser game
---

# grudge-studio (npm) quirks

The `grudge-studio` package is a thin three.js-based 3D game SDK. Practical classes live under
the `grudge-studio/tools` subpath export (e.g. `ThirdPersonCameraController`,
`AdvancedLightingSystem`, `Helpers.createCharacter`), not the root export.

- **Ships no TypeScript types.** Needs an ambient `declare module "grudge-studio/tools"` to typecheck.
- **Bundles/loads its own copy of three.** Without `resolve.dedupe: ["three"]` in vite config you
  get "Multiple instances of Three.js" and cross-instance `instanceof` failures (e.g. the camera
  controller not recognizing your `THREE.Vector3`). Always dedupe three.
- **Keyboard input is incomplete.** `UnifiedInputManager.processBindings` only wires gamepad for
  movement, so do keyboard yourself with a key-state map. `ThirdPersonCameraController.update(dt, im)`
  calls `im.getLookDelta()` (expects a `THREE.Vector2`) — pass a minimal stub that returns accumulated
  pointer-lock mouse delta and resets it.
- It targets an older three internally → harmless deprecation warnings (THREE.Clock, PCFSoftShadowMap).

**Why:** these cost real debugging time; the dedupe issue in particular silently breaks the camera.
**How to apply:** when building any game on grudge-studio, import from `/tools`, add the ambient
d.ts, dedupe three in vite, and own the keyboard input.

# WebGL in the headless screenshot env

The `screenshot` tool's headless browser cannot create a WebGL context ("BindToCurrentSequence
failed"). A three.js / WebGL app will throw on `new THREE.WebGLRenderer`. This is an environment
limitation, NOT an app bug — it works in the user's real browser. Verify such apps by checking the
menu/DOM UI renders and that typecheck passes; do not chase the WebGL error as a real defect.

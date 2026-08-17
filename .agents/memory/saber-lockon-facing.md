---
name: Saber lock-on facing
description: Recurring "character faces the wrong way while running" reports were lock-on strafe-lock design, not a model/animation bug.
---
The rule: with a hard-locked target, the player body squares up to the target (strafe-lock). Users read this as "my character runs sideways," especially when the lock is far away or off-screen.

**Why:** Three separate user reports blamed the model/retarget pipeline; headless measurement (toe-vs-ankle world heading + pelvis quaternion on the instantiated animated rig) proved every race model and the run clip face forward within ~5°. The visible sideways run came from `updatePlayer`'s lock-on facing branch.

**How to apply:** Current behavior: strafe-lock only when the locked target is within 10 units or the player is (nearly) stationary; otherwise face the run direction. Before touching facing math again, reproduce with lock-on state known — and measure the rig headlessly rather than trusting screenshots. `facing` convention is `atan2(x, z)` with model forward +Z; it is consistent everywhere.

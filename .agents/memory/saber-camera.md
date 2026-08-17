---
name: Saber Academy third-person camera
description: Why the SDK camera controller was dropped for a self-owned orbit follow camera, and the invariant that keeps movement working.
---

# Self-owned orbit follow camera

The game does NOT use grudge-studio's `ThirdPersonCameraController` — it was
opaque/unreliable for a follow-and-aim feel, so it was replaced by an in-engine
orbit camera (mouse yaw/pitch, smooth chase, raycast occlusion pull-in,
`lookAt` the player's upper body). Only the SDK's lighting is still used.

**Why:** the user wanted a camera that follows the character and looks where the
character aims; the SDK controller's behavior couldn't be tuned to that.

**Invariant (do not break):** `camYaw` must equal the camera heading
`atan2(camForward.x, camForward.z)`, where `camForward = normalize(player -
camera)` on XZ. All movement/strafe/facing code derives its basis from
`camForward`/`camRight`/`camHeading`, so as long as the orbit geometry keeps
`camYaw` and the actual camera-to-player direction aligned, WASD stays
camera-relative without touching the movement code.

**Camera occlusion gotcha:** the arena boundary wall lives in `staticColliders`,
not `collidables`. The camera occlusion raycast must test BOTH (assembled into
`camOccluders`), or the camera clips through the boundary wall near the arena
edge.

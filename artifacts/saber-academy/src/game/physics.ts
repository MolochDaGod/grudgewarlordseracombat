// Rapier physics wrapper for Grudge Gladiators.
//
// Rapier ships as WebAssembly, so init is async; `initRapier()` is idempotent
// and resolves to null (never throws) when the WASM cannot load, so the engine
// can fall back to its hand-rolled math movement. The world is used only to
// resolve HORIZONTAL collide-and-slide for kinematic character capsules against
// mesh-accurate static colliders (the arena floor + pillars). Gravity, jumping
// and grounding are handled by the engine using the three-mesh-bvh ground query
// (see worldbvh.ts), so the controller is configured minimally.
//
// The `-compat` build inlines the WASM as base64, so no extra Vite/bundler
// config or separate .wasm fetch is required.

import * as THREE from "three";
import type * as RAPIER from "@dimforge/rapier3d-compat";

type RapierModule = typeof import("@dimforge/rapier3d-compat");

let rapierPromise: Promise<RapierModule | null> | null = null;

/** Load + init Rapier once. Resolves to null (never rejects) on failure. */
export function initRapier(): Promise<RapierModule | null> {
  if (!rapierPromise) {
    rapierPromise = (async () => {
      try {
        const mod = await import("@dimforge/rapier3d-compat");
        await mod.init();
        return mod;
      } catch (err) {
        console.warn(
          "Grudge Gladiators: Rapier physics unavailable; using math movement.",
          err,
        );
        return null;
      }
    })();
  }
  return rapierPromise;
}

/** A kinematic capsule body driven by the engine. */
export interface CharacterBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Capsule center height above the group origin (feet at group y). */
  yOffset: number;
}

export class PhysicsWorld {
  private RAPIER: RapierModule;
  readonly world: RAPIER.World;
  private controller: RAPIER.KinematicCharacterController;

  constructor(mod: RapierModule) {
    this.RAPIER = mod;
    this.world = new mod.World({ x: 0, y: -30, z: 0 });
    // Shared, stateless-between-calls controller for every character.
    this.controller = this.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
  }

  /**
   * Build fixed trimesh colliders from world meshes. The vertices are baked in
   * world space so the colliders match the rendered geometry exactly
   * (mesh-accurate). Skips meshes without a position attribute.
   */
  addStaticMeshes(meshes: THREE.Mesh[]): void {
    const R = this.RAPIER;
    const v = new THREE.Vector3();
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const pos = geo.getAttribute("position") as
        | THREE.BufferAttribute
        | undefined;
      if (!pos) continue;
      mesh.updateWorldMatrix(true, false);
      const verts = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        verts[i * 3] = v.x;
        verts[i * 3 + 1] = v.y;
        verts[i * 3 + 2] = v.z;
      }
      const index = geo.getIndex();
      let indices: Uint32Array;
      if (index) {
        indices = new Uint32Array(index.count);
        for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
      } else {
        indices = new Uint32Array(pos.count);
        for (let i = 0; i < pos.count; i++) indices[i] = i;
      }
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
      this.world.createCollider(R.ColliderDesc.trimesh(verts, indices), body);
    }
  }

  /** Create a kinematic capsule at feet position `pos`. */
  createCharacter(
    pos: THREE.Vector3,
    radius: number,
    height: number,
  ): CharacterBody {
    const R = this.RAPIER;
    const halfHeight = Math.max(0.05, height / 2 - radius);
    const yOffset = height / 2;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(
        pos.x,
        pos.y + yOffset,
        pos.z,
      ),
    );
    const collider = this.world.createCollider(
      R.ColliderDesc.capsule(halfHeight, radius),
      body,
    );
    return { body, collider, yOffset };
  }

  /**
   * Resolve a horizontal move with collide-and-slide against the static world
   * (and other character capsules). Returns the corrected world x/z. Vertical
   * motion is intentionally ignored here (the engine owns gravity/grounding).
   */
  moveHorizontal(
    c: CharacterBody,
    px: number,
    py: number,
    pz: number,
    dx: number,
    dz: number,
  ): { x: number; z: number } {
    // Resync the collider to the engine's authoritative position, then slide.
    c.body.setTranslation({ x: px, y: py + c.yOffset, z: pz }, false);
    this.controller.computeColliderMovement(c.collider, { x: dx, y: 0, z: dz });
    const m = this.controller.computedMovement();
    return { x: px + m.x, z: pz + m.z };
  }

  /** Advance the simulation one tick (keeps the query pipeline current). */
  step(): void {
    this.world.step();
  }

  removeCharacter(c: CharacterBody): void {
    try {
      // Removing the body also removes its attached collider.
      this.world.removeRigidBody(c.body);
    } catch {
      /* world already torn down */
    }
  }

  dispose(): void {
    try {
      this.world.free();
    } catch {
      /* already freed */
    }
  }
}

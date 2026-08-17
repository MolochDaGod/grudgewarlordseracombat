// three-mesh-bvh helpers for Grudge Gladiators.
//
// Two jobs:
//   1. StaticWorldBVH -- a mesh-accurate BVH over the arena floor + props
//      (pillars). It serves two queries against the same baked geometry:
//        a. groundHeight() raycasts straight down for the true floor Y. This
//           drives gravity grounding for the player and enemies in BOTH the
//           physics and the math-fallback paths.
//        b. resolveWalls() pushes a character capsule out of any wall it is
//           penetrating (mesh-accurate, via a capsule-vs-triangle shapecast),
//           applying a HORIZONTAL-only correction so the flat floor (whose
//           contact normal points straight up) never affects it. This layers
//           on top of the Rapier capsule path so movement around pillars/edges
//           stays tight even when Rapier is unavailable.
//   2. BodyHitter -- a per-enemy baked-geometry BVH used for PRECISE
//      weapon-vs-body melee: the player's swung blade is a world-space segment
//      raycast against the enemy's actual (posed) body mesh. Re-baked + refit
//      once per swing. Callers fall back to a segment-vs-capsule test when a
//      hitter is unavailable or a query throws.

import * as THREE from "three";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";

export class StaticWorldBVH {
  private bvh: MeshBVH;
  private geom: THREE.BufferGeometry;
  private ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

  // Scratch objects reused by resolveWalls (no per-frame allocation).
  private seg = new THREE.Line3();
  private box = new THREE.Box3();
  private triPt = new THREE.Vector3();
  private capPt = new THREE.Vector3();
  private push = new THREE.Vector3();

  constructor(meshes: THREE.Mesh[]) {
    const gen = new StaticGeometryGenerator(meshes);
    gen.attributes = ["position"];
    gen.applyWorldTransforms = true;
    this.geom = gen.generate();
    this.bvh = new MeshBVH(this.geom);
  }

  /** World-space ground height directly under (x, z), or null if nothing. */
  groundHeight(x: number, z: number, top = 80): number | null {
    this.ray.origin.set(x, top, z);
    this.ray.direction.set(0, -1, 0);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, top + 10);
    return hit ? hit.point.y : null;
  }

  /**
   * Mesh-accurate wall constraint. Treats the character as a vertical capsule
   * (radius `radius`, feet at `y`, total `height`) and pushes it out of any
   * wall geometry it penetrates, returning the corrected world x/z.
   *
   * The push is HORIZONTAL only: the floor's contact normal points straight up,
   * so zeroing the vertical component makes the flat ground a no-op here while
   * vertical pillar walls (horizontal normals) resolve fully. Two settle passes
   * give stable behaviour in pillar corners. World space == BVH space (geometry
   * is baked with world transforms), so no matrix mapping is needed.
   */
  resolveWalls(
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
  ): { x: number; z: number } {
    // Capsule spine: sphere centers at feet+radius and head-radius.
    const bottom = y + radius;
    const top = Math.max(bottom, y + height - radius);
    this.seg.start.set(x, bottom, z);
    this.seg.end.set(x, top, z);

    for (let pass = 0; pass < 2; pass++) {
      this.box.makeEmpty();
      this.box.expandByPoint(this.seg.start);
      this.box.expandByPoint(this.seg.end);
      this.box.min.addScalar(-radius);
      this.box.max.addScalar(radius);

      this.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(this.box),
        intersectsTriangle: (tri) => {
          const dist = tri.closestPointToSegment(
            this.seg,
            this.triPt,
            this.capPt,
          );
          if (dist < radius) {
            this.push.copy(this.capPt).sub(this.triPt);
            this.push.y = 0; // horizontal-only: ignore the flat floor.
            const len = this.push.length();
            if (len > 1e-6) {
              const depth = radius - dist;
              this.push.multiplyScalar(depth / len);
              this.seg.start.add(this.push);
              this.seg.end.add(this.push);
            }
          }
          return false;
        },
      });
    }

    return { x: this.seg.start.x, z: this.seg.start.z };
  }

  dispose(): void {
    this.geom.dispose();
  }
}

/** Precise weapon-vs-body hit tester for a single enemy. */
export class BodyHitter {
  private gen: StaticGeometryGenerator;
  private geom: THREE.BufferGeometry;
  private bvh: MeshBVH;
  private ray = new THREE.Ray();
  private dir = new THREE.Vector3();

  constructor(meshes: THREE.Mesh[]) {
    this.gen = new StaticGeometryGenerator(meshes);
    this.gen.attributes = ["position"];
    this.gen.applyWorldTransforms = true;
    this.geom = this.gen.generate();
    this.bvh = new MeshBVH(this.geom);
  }

  /** Re-bake the current posed geometry and refit the tree (once per swing). */
  refit(): void {
    this.gen.generate(this.geom);
    this.bvh.refit();
  }

  /** First intersection of world segment a->b with the body, or null. */
  segmentHit(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
    this.dir.copy(b).sub(a);
    const len = this.dir.length();
    if (len < 1e-4) return null;
    this.dir.multiplyScalar(1 / len);
    this.ray.origin.copy(a);
    this.ray.direction.copy(this.dir);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, len);
    return hit ? hit.point.clone() : null;
  }

  dispose(): void {
    this.geom.dispose();
  }
}

/** Build a BodyHitter, or null if construction fails / no usable meshes. */
export function makeBodyHitter(meshes: THREE.Mesh[]): BodyHitter | null {
  if (meshes.length === 0) return null;
  try {
    return new BodyHitter(meshes);
  } catch {
    return null;
  }
}

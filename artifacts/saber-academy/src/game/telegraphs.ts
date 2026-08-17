import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * RTS-style ground telegraphs built from the uploaded Sketchfab indicator
 * props: a circular warning marker ("zhengbei") flashed under enemies as they
 * wind up a strike, and a directional arrow marker ("zhunbei") laid along the
 * player's aim while an elemental cast charges.
 *
 * Both GLBs are unskinned animated meshes with a single looping "Take 001"
 * clip; instances are plain clones with their own mixer. Assets load lazily —
 * spawns requested before the load resolves are dropped silently (telegraphs
 * are best-effort garnish, never gameplay-critical).
 */

export type TelegraphKind = "warning" | "arrow";

export interface TelegraphSpawn {
  kind: TelegraphKind;
  /** Seconds the telegraph stays alive (fades in the final 20%). */
  ttl: number;
  /** Ground footprint diameter in world units. */
  size: number;
  position: THREE.Vector3;
  /** Facing (radians, world Y) — matters for the arrow. */
  yaw?: number;
  /**
   * Optional per-step tracker: return the position (and optionally mutate the
   * handle's yaw) so the telegraph follows a moving caster/enemy. Return null
   * to end the telegraph early.
   */
  follow?: (out: THREE.Vector3) => THREE.Vector3 | null;
}

interface ActiveTelegraph {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  t: number;
  ttl: number;
  spawn: TelegraphSpawn;
  materials: THREE.Material[];
}

interface ProtoAsset {
  scene: THREE.Object3D;
  clip: THREE.AnimationClip | null;
  /** Raw model footprint (max XZ extent) used to normalize spawn size. */
  extent: number;
}

const MAX_ACTIVE = 10;

/** Texture map slots a material may own (disposed with the prototype only). */
const MAP_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
  "alphaMap",
  "lightMap",
] as const;

/**
 * Fully release a prototype's GPU resources: geometries, materials, and their
 * texture maps. Instance removal must NOT use this — cloned instance materials
 * share the prototype's textures.
 */
function disposeObjectResources(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const anyMat = m as unknown as Record<string, unknown>;
      for (const slot of MAP_SLOTS) {
        const tex = anyMat[slot] as THREE.Texture | null | undefined;
        tex?.dispose();
      }
      m.dispose();
    }
  });
}

export class TelegraphSystem {
  private scene: THREE.Scene;
  private protos: Partial<Record<TelegraphKind, ProtoAsset>> = {};
  private loading = false;
  private active: ActiveTelegraph[] = [];
  private disposed = false;
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    void this.preload();
  }

  private async preload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const loader = new GLTFLoader();
    const base = import.meta.env.BASE_URL;
    const files: [TelegraphKind, string][] = [
      ["warning", `${base}models/telegraph_warning.glb`],
      ["arrow", `${base}models/telegraph_arrow.glb`],
    ];
    await Promise.all(
      files.map(async ([kind, url]) => {
        try {
          const gltf = await loader.loadAsync(url);
          const scene = gltf.scene;
          if (this.disposed) {
            // The system was torn down while loading — free immediately.
            disposeObjectResources(scene);
            return;
          }
          const box = new THREE.Box3().setFromObject(scene);
          const sz = box.getSize(new THREE.Vector3());
          this.protos[kind] = {
            scene,
            clip: gltf.animations[0] ?? null,
            extent: Math.max(sz.x, sz.z, 0.001),
          };
        } catch (err) {
          console.warn(`Telegraph asset failed to load (${kind}):`, err);
        }
      }),
    );
  }

  /** Spawn a telegraph; silently no-ops if assets are not ready or at cap. */
  spawn(spawn: TelegraphSpawn): void {
    if (this.disposed) return;
    const proto = this.protos[spawn.kind];
    if (!proto || this.active.length >= MAX_ACTIVE) return;
    const root = proto.scene.clone(true);
    const materials: THREE.Material[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Clone materials so per-instance fade never bleeds across instances.
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const cloned = mats.map((m) => {
        const c = m.clone();
        c.transparent = true;
        c.depthWrite = false;
        materials.push(c);
        return c;
      });
      mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
      mesh.renderOrder = 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });
    const s = spawn.size / proto.extent;
    root.scale.multiplyScalar(s);
    root.position.copy(spawn.position);
    root.position.y += 0.06; // hover just above the ground to avoid z-fighting
    root.rotation.y = spawn.yaw ?? 0;
    this.scene.add(root);
    let mixer: THREE.AnimationMixer | null = null;
    if (proto.clip) {
      mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(proto.clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }
    this.active.push({ root, mixer, t: 0, ttl: spawn.ttl, spawn, materials });
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.t += dt;
      a.mixer?.update(dt);
      if (a.spawn.follow) {
        const p = a.spawn.follow(this.tmp);
        if (!p) {
          this.remove(i);
          continue;
        }
        a.root.position.set(p.x, p.y + 0.06, p.z);
        if (a.spawn.yaw !== undefined) a.root.rotation.y = a.spawn.yaw;
      }
      const left = a.ttl - a.t;
      if (left <= 0) {
        this.remove(i);
        continue;
      }
      // Quick fade-in, fade-out over the final 20% of the lifetime.
      const fadeIn = Math.min(1, a.t / 0.08);
      const fadeOut = Math.min(1, left / (a.ttl * 0.2));
      const op = fadeIn * fadeOut;
      for (const m of a.materials) m.opacity = op;
    }
  }

  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.remove(i);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    for (const kind of Object.keys(this.protos) as TelegraphKind[]) {
      const proto = this.protos[kind];
      if (proto) disposeObjectResources(proto.scene);
    }
    this.protos = {};
  }

  private remove(i: number): void {
    const a = this.active[i];
    this.active.splice(i, 1);
    this.scene.remove(a.root);
    a.mixer?.stopAllAction();
    for (const m of a.materials) m.dispose();
    // Geometry is shared with the prototype — only the prototype disposes it.
  }
}

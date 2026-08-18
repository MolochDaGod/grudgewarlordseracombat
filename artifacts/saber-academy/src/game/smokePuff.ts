/**
 * Combat smoke — threejs-games Smoke (examples/20-particles/smoke, core/Particles.js)
 * as an EffectPrimitive, not a second particle engine.
 *
 * Behavior from upstream Smoke:
 *   - Points in a small sphere
 *   - Rise on +Y (axis 1)
 *   - rotateY
 *   - fade
 *   - colorable (NormalBlending grey default; we tint for damage / element)
 *
 * Extra (requested): ride a CatmullRom spline or a live trail head so smoke
 * can wrap linear / ribbon / slash paths.
 *
 * SI: size in metres. No smoke.png fetch — procedural soft disk shader.
 */
import * as THREE from "three";

const SMOKE_VERT = /* glsl */ `
  attribute float aSeed;
  uniform float uSize;
  uniform float uTime;
  varying float vSeed;
  void main() {
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = 1.0 + 0.18 * sin(uTime * 2.4 + aSeed * 6.28);
    gl_PointSize = uSize * pulse * (180.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const SMOKE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vSeed;
  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float d = length(uv);
    if (d > 1.0) discard;
    float soft = pow(1.0 - d, 1.6);
    float mottled = 0.75 + 0.25 * fract(sin(vSeed * 91.17) * 43758.5453);
    float a = soft * uOpacity * mottled;
    if (a < 0.02) discard;
    gl_FragColor = vec4(uColor * (0.55 + 0.45 * soft), a);
  }
`;

export type SmokeStyle = "puff" | "rise" | "trail" | "spline";

export interface SmokeOpts {
  color?: number | string;
  size?: number;
  count?: number;
  duration?: number;
  intensity?: number;
  radius?: number;
  style?: SmokeStyle;
  /** World points for CatmullRom travel (trail / spline). */
  spline?: THREE.Vector3[];
}

export class SmokeCloud {
  readonly mesh: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private positions: Float32Array;
  private velocities: Float32Array;
  private life = 0;
  private maxLife: number;
  private curve: THREE.CatmullRomCurve3 | null = null;
  private style: SmokeStyle;
  private count: number;
  private tmp = new THREE.Vector3();

  constructor(origin: THREE.Vector3, opts: SmokeOpts = {}) {
    const count = Math.max(8, Math.min(80, opts.count ?? 28));
    this.count = count;
    this.maxLife = Math.max(0.2, opts.duration ?? 0.7);
    this.style = opts.style ?? "puff";
    const radius = Math.max(0.04, opts.radius ?? 0.22);
    const color = new THREE.Color(opts.color ?? 0x999999);
    const intensity = opts.intensity ?? 1;
    const sizePx = Math.max(8, (opts.size ?? 0.55) * 42);

    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const velocities = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const u = Math.random();
      const r = radius * Math.cbrt(u);
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = (Math.random() - 0.15) * radius;
      positions[i * 3 + 2] = Math.sin(a) * r;
      seeds[i] = Math.random();
      velocities[i] = 0.6 + Math.random() * 1.8;
    }
    this.positions = positions;
    this.velocities = velocities;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: 0.55 * intensity },
        uSize: { value: sizePx },
        uTime: { value: 0 },
      },
      vertexShader: SMOKE_VERT,
      fragmentShader: SMOKE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.position.copy(origin);
    this.mesh.frustumCulled = false;
    this.mesh.rotation.x = Math.PI;

    if (opts.spline && opts.spline.length >= 2) {
      this.curve = new THREE.CatmullRomCurve3(opts.spline.map((p) => p.clone()));
      this.style = opts.style ?? "spline";
    }
  }

  setSpline(points: THREE.Vector3[]): void {
    if (points.length < 2) return;
    this.curve = new THREE.CatmullRomCurve3(points.map((p) => p.clone()));
    this.style = "spline";
  }

  follow(head: THREE.Vector3): void {
    this.mesh.position.copy(head);
    this.style = "trail";
  }

  setColor(color: number | string): void {
    (this.material.uniforms.uColor.value as THREE.Color).set(color);
  }

  /** @returns false when finished (caller should dispose). */
  update(dt: number): boolean {
    this.life += dt;
    const u = this.life / this.maxLife;
    if (u >= 1) return false;

    this.material.uniforms.uTime.value = this.life;
    this.material.uniforms.uOpacity.value = 0.62 * (1 - u) * (1 - u);

    const pos = this.positions;
    const vel = this.velocities;
    for (let i = 0; i < this.count; i++) {
      const y = i * 3 + 1;
      pos[y] += vel[i] * dt;
      pos[i * 3] += Math.sin(this.life * 3 + i) * dt * 0.08;
      pos[i * 3 + 2] += Math.cos(this.life * 2.4 + i) * dt * 0.08;
    }
    this.geometry.attributes.position!.needsUpdate = true;
    this.mesh.rotateY(0.009 + dt * 0.4);

    if (this.curve) {
      const t = this.style === "spline" ? Math.min(0.999, u) : Math.min(0.999, u * 0.85);
      this.curve.getPointAt(t, this.tmp);
      this.mesh.position.copy(this.tmp);
    }
    return true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/** Catalog helper: first smoke primitive (kind or meshId). */
export function findSmokePrimitive(
  effects: { kind: string; meshId?: string; color?: string; size?: number; duration?: number; intensity?: number; aoe?: number; speed?: number }[] | undefined,
) {
  return effects?.find((e) => e.kind === "smoke" || e.meshId === "smoke");
}

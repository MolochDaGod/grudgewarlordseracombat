import * as THREE from "three";

/**
 * High-quality casting VFX ported from the MolochDaGod
 * LinearAbiltyCastingThreeJS reference (plain-JS, vanilla three) to TypeScript:
 *
 *  - AimIndicator  — SDF shader linear telegraph (shaft + arrowhead + base ring
 *                    + tip glyph + range arc, metre-true widths, reveal sweep,
 *                    scrolling chevrons, invalid tint).
 *  - ZoneIndicator — SDF shader AoE footprint (boundary band + inner liner,
 *                    contour rings, rotating ticks, radar sweep, crosshair,
 *                    pulse, ridged noise crawl).
 *  - Ribbon        — dynamic billboard trail geometry (pre-allocated,
 *                    per-frame rebuild, tapering width/alpha).
 *  - BurstSphere   — pooled expanding icosphere impact shells (fire/frost/storm
 *                    compile-time modes).
 *
 * The reference's FrameUniforms / Layers / postprocessing infrastructure is
 * intentionally NOT ported: a single `uTime` uniform, advanced by each class's
 * `update(dt)`, replaces the shared frame uniforms, and the soft-particle depth
 * fade (which needed a scene depth prepass) is stubbed out. Everything is
 * additive, depthWrite:false, transparent; geometries and materials are
 * disposed in each class's dispose().
 */

/* ---------------------------------------------------------------------- */
/* GLSL libraries (ported from shaders/lib/*.glsl.js)                      */
/* ---------------------------------------------------------------------- */

const NOISE_GLSL = /* glsl */ `
#ifndef NOISE_LIB_INCLUDED
#define NOISE_LIB_INCLUDED

vec3 mod289v3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289v4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute289(vec4 x) { return mod289v4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec2 hash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289v3(i);
  vec4 p = permute289(permute289(permute289(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

float fbm4(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * snoise(p);
    p = p * 2.03 + vec3(17.3, 5.1, 9.7);
    a *= 0.5;
  }
  return v;
}

float ridged(vec3 p, int unusedOctaves) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * (1.0 - abs(snoise(p)));
    p *= 2.06;
    a *= 0.5;
  }
  return v;
}

vec2 voronoi2(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float minDist = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < minDist) { minDist = d; id = hash11(dot(n + g, vec2(31.7, 57.1))); }
    }
  }
  return vec2(sqrt(minDist), id);
}
#endif
`;

const COMMON_GLSL = /* glsl */ `
#ifndef COMMON_LIB_INCLUDED
#define COMMON_LIB_INCLUDED

float fresnelTerm(vec3 viewDir, vec3 normal, float power, float scale) {
  return clamp(scale * pow(1.0 - abs(dot(normalize(viewDir), normalize(normal))), power), 0.0, 4.0);
}

vec2 dissolveMask(float noiseValue, float threshold, float edgeWidth) {
  float mask = step(threshold, noiseValue);
  float edge = smoothstep(threshold, threshold + edgeWidth, noiseValue) - mask;
  return vec2(mask, clamp(edge, 0.0, 1.0));
}

vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
  vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
  return mix(b, c3, smoothstep(0.64, 1.0, t));
}
#endif
`;

/* ---------------------------------------------------------------------- */
/* Per-element tuned defaults (mined from config/settings.js)              */
/* ---------------------------------------------------------------------- */

/** Aim telegraph geometry/style constants (settings.aim). */
export interface AimStyle {
  colorCore: THREE.Color;
  colorEdge: THREE.Color;
}

/** Zone footprint style constants (settings.zone). */
export interface ZoneStyle {
  colorCore: THREE.Color;
  colorEdge: THREE.Color;
}

/** outCubic / outQuint / outQuad easings the reference uses on reveals. */
const Easing = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  outQuint: (t: number) => 1 - Math.pow(1 - t, 5),
};

const _invalidColor = new THREE.Color(1, 0.41, 0.36);

/* ---------------------------------------------------------------------- */
/* AimIndicator — SDF linear telegraph                                     */
/* ---------------------------------------------------------------------- */

const AIM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const AIM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadLength;
  uniform float uQuadWidth;
  uniform float uQuadBack;
  uniform float uLength;
  uniform float uStart;
  uniform float uShaftWidth;
  uniform float uHeadLength;
  uniform float uHeadWidth;
  uniform float uRound;
  uniform float uEdge;
  uniform float uEdgeGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uStripes;
  uniform float uStripeSharp;
  uniform float uStripeDepth;
  uniform float uScrollSpeed;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uCrystals;
  uniform float uCrystalScale;
  uniform float uBaseRing;
  uniform float uBaseRingWidth;
  uniform float uTipGlyph;
  uniform float uTipGlyphSize;
  uniform float uTipSpin;
  uniform float uRangeArc;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${NOISE_GLSL}
  ${COMMON_GLSL}

  #define TAU 6.28318530718

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;

    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);

    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
  }

  void main() {
    vec2 p = vec2((vUv.x - 0.5) * uQuadWidth,
                  (1.0 - vUv.y) * uQuadLength - uQuadBack);

    float length_ = max(uLength, uStart + 0.05);
    float headLen = min(uHeadLength, length_ - uStart);
    float headBase = length_ - headLen;

    float shaft = sdBox(p - vec2(0.0, (uStart + headBase) * 0.5),
                        vec2(uShaftWidth, max(0.001, (headBase - uStart) * 0.5)));
    float head = sdTriangle(p,
                            vec2(-uHeadWidth, headBase),
                            vec2( uHeadWidth, headBase),
                            vec2( 0.0,        length_));
    float d = min(shaft, head) - uRound;

    float aa = fwidth(d) + uSoftness;
    float body = 1.0 - smoothstep(-aa, aa, d);
    float outline = 1.0 - smoothstep(uEdge, uEdge + aa, abs(d));

    float depth = clamp(-d / max(uShaftWidth, 0.05), 0.0, 1.0);
    float interior = pow(1.0 - depth, uFillFalloff);

    float phase = (p.y - abs(p.x) * 0.55 - uTime * uScrollSpeed) * uStripes;
    float band = 0.5 + 0.5 * cos(phase * TAU);
    band = pow(band, mix(1.0, 9.0, uStripeSharp));

    float frost = fbm3(vec3(p * uNoiseScale, uTime * uNoiseSpeed)) * 0.5 + 0.5;
    vec2 cell = voronoi2(p * uCrystalScale + 13.7);
    float plates = smoothstep(0.32, 0.0, cell.x);

    float wash = interior;
    wash *= mix(1.0, band, uStripeDepth);
    wash *= mix(1.0, frost, uNoise);
    wash += plates * uCrystals * 0.35 * interior;
    wash *= 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);

    float radius = length(p);
    float ring = smoothstep(uBaseRingWidth, 0.0, abs(radius - uBaseRing));

    float arc = smoothstep(0.05, 0.0, abs(radius - length_)) *
                smoothstep(uHeadWidth * 2.2, uHeadWidth * 1.1, abs(p.x)) * uRangeArc;

    vec2 q = p - vec2(0.0, length_);
    float qr = length(q);
    float qa = atan(q.y, q.x) + uTime * uTipSpin * TAU;
    float spokes = smoothstep(0.86, 1.0, abs(cos(qa * 3.0))) *
                   smoothstep(uTipGlyphSize, 0.0, qr);
    float glyphRing = smoothstep(0.045, 0.0, abs(qr - uTipGlyphSize * 0.5));
    float glyph = max(spokes, glyphRing) * uTipGlyph;

    float front = uReveal * (length_ + uTipGlyphSize);
    float sweep = smoothstep(front + 0.25, front - 0.15, p.y);
    float sweepEdge = smoothstep(0.35, 0.0, abs(p.y - front)) * step(uReveal, 0.999);

    float fill = body * wash * uFill;
    float lines = outline * uEdgeGlow + ring + arc + glyph;

    float alpha = clamp(fill + lines + sweepEdge * 0.6, 0.0, 1.0) * sweep * uOpacity;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * (lines + sweepEdge);
    color = mix(color, uColorInvalid * (fill + lines + sweepEdge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/** The ground arrow drawn while a cast is armed (settings.aim defaults). */
export class AimIndicator {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.translate(0, 0, 0.5);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uQuadLength: { value: 10 },
        uQuadWidth: { value: 6 },
        uQuadBack: { value: 1 },
        uLength: { value: 8 },
        uStart: { value: 0.9 },
        uShaftWidth: { value: 0.42 },
        uHeadLength: { value: 2.6 },
        uHeadWidth: { value: 1.35 },
        uRound: { value: 0.12 },
        uEdge: { value: 0.09 },
        uEdgeGlow: { value: 2.6 },
        uSoftness: { value: 0.06 },
        uFill: { value: 0.3 },
        uFillFalloff: { value: 1.1 },
        uStripes: { value: 0.55 },
        uStripeSharp: { value: 0.62 },
        uStripeDepth: { value: 0.55 },
        uScrollSpeed: { value: 2.4 },
        uPulse: { value: 0.28 },
        uPulseSpeed: { value: 2.2 },
        uNoise: { value: 0.45 },
        uNoiseScale: { value: 1.6 },
        uNoiseSpeed: { value: 0.35 },
        uCrystals: { value: 0.55 },
        uCrystalScale: { value: 2.4 },
        uBaseRing: { value: 0.62 },
        uBaseRingWidth: { value: 0.06 },
        uTipGlyph: { value: 0.9 },
        uTipGlyphSize: { value: 1.15 },
        uTipSpin: { value: 0.45 },
        uRangeArc: { value: 0.55 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new THREE.Color(0.92, 0.98, 1) },
        uColorEdge: { value: new THREE.Color(0.24, 0.7, 1) },
        uColorInvalid: { value: _invalidColor.clone() },
        uGlobalGlow: { value: 1 },
      },
      vertexShader: AIM_VERTEX,
      fragmentShader: AIM_FRAGMENT,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "AimIndicator";
    this.mesh.renderOrder = 996;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setColors(core: THREE.Color, edge: THREE.Color): void {
    this.material.uniforms.uColorCore.value.copy(core);
    this.material.uniforms.uColorEdge.value.copy(edge);
  }

  update(dt: number): void {
    this.material.uniforms.uTime.value += dt;
  }

  /**
   * Place/reshape the arrow.
   * @param origin caster feet (world)
   * @param yaw    heading, radians about +Y
   * @param distance cast distance, metres
   * @param groundYFn terrain height sampler
   * @param reveal 0..1 sweep-out
   * @param valid  false tints invalid
   */
  place(
    origin: THREE.Vector3,
    yaw: number,
    distance: number,
    groundYFn: ((x: number, z: number) => number) | undefined,
    reveal: number,
    valid: boolean,
  ): void {
    const u = this.material.uniforms;
    const shaftWidth = 0.42;
    const headWidth = 1.35;
    const baseRing = 0.62;
    const tipGlyphSize = 1.15;
    const edge = 0.09;
    const round = 0.12;

    const back = Math.max(baseRing, 0.2) + 0.4;
    const forward = distance + Math.max(tipGlyphSize, 0.3) + 0.5;
    const halfWidth =
      Math.max(headWidth, shaftWidth, baseRing, tipGlyphSize) + edge + round + 0.5;

    const quadLength = back + forward;
    const quadWidth = halfWidth * 2;

    u.uQuadLength.value = quadLength;
    u.uQuadWidth.value = quadWidth;
    u.uQuadBack.value = back;
    u.uLength.value = distance;
    u.uReveal.value = reveal;
    u.uInvalid.value = valid ? 0 : 1;

    const bx = origin.x - Math.sin(yaw) * back;
    const bz = origin.z - Math.cos(yaw) * back;
    const y = (groundYFn ? groundYFn(origin.x, origin.z) : 0) + 0.05;
    this.mesh.position.set(bx, y, bz);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(quadWidth, 1, quadLength);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* ZoneIndicator — SDF AoE footprint                                       */
/* ---------------------------------------------------------------------- */

const ZONE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ZONE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uBoundary;
  uniform float uBias;
  uniform float uBoundaryGlow;
  uniform float uLiner;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uFillFalloff;
  uniform float uRings;
  uniform float uRingWidth;
  uniform float uRingSpeed;
  uniform float uCrawl;
  uniform float uCrawlScale;
  uniform float uCrawlSpeed;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uTicks;
  uniform float uTickLength;
  uniform float uTickWidth;
  uniform float uTickSpin;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uCrosshair;
  uniform float uCrosshairLength;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uReveal;
  uniform float uInvalid;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorInvalid;
  uniform float uGlobalGlow;

  varying vec2 vUv;

  ${NOISE_GLSL}
  ${COMMON_GLSL}

  #define TAU 6.28318530718

  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);

    float outer = uRadius + uBoundary * uBias;
    float inner = max(0.01, uRadius - uBoundary * (1.0 - uBias));

    float aa = fwidth(d) + uSoftness;
    if (d > outer + aa * 3.0) discard;

    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float liner = 1.0 - smoothstep(uLiner, uLiner + aa, abs(d - inner));

    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);

    float wash = pow(radial, uFillFalloff);
    float n = fbm3(vec3(p * uNoiseScale, uTime * 0.2)) * 0.5 + 0.5;
    wash *= mix(1.0, n, uNoise);

    float ringPhase = radial * uRings - uTime * uRingSpeed;
    float ring = smoothstep(1.0 - uRingWidth, 1.0, 0.5 + 0.5 * cos(ringPhase * TAU));

    float warp = fbm3(vec3(p * 0.4, uTime * 0.15 + 3.1)) * 0.6;
    float fil = ridged(vec3(p * uCrawlScale + warp, uTime * uCrawlSpeed), 4);
    float veins = smoothstep(0.68, 0.95, fil);

    wash += ring * 0.4;
    wash += veins * uCrawl * (0.3 + 0.7 * radial);

    float ang = atan(p.y, p.x) / TAU + 0.5;

    float tickPhase = fract(ang * uTicks + uTime * uTickSpin * uTicks);
    float tick = 1.0 - smoothstep(uTickWidth, uTickWidth + 0.06, tickPhase);
    tick *= smoothstep(inner - uTickLength, inner, d) * smoothstep(outer, inner, d);

    float sweepPhase = fract(ang - uTime * uSweepSpeed);
    float sweep = pow(1.0 - sweepPhase, 6.0) * smoothstep(0.0, 0.05, sweepPhase) * uSweep * interior;

    float core = smoothstep(uCoreSize, 0.0, d) * uCore;
    float coreRing = (1.0 - smoothstep(0.02, 0.045, abs(d - uCoreSize * 0.8))) * uCore * 0.8;

    float armLength = uCrosshairLength * mix(1.0, 1.8, step(0.0, p.y) * step(abs(p.x), abs(p.y)));
    float arms = max(1.0 - smoothstep(0.02, 0.05, abs(p.x)), 1.0 - smoothstep(0.02, 0.05, abs(p.y)));
    arms *= smoothstep(armLength, armLength * 0.25, d) * smoothstep(uCoreSize * 0.5, uCoreSize, d);
    arms *= uCrosshair;

    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float fill = interior * wash * uFill * breathe;
    float lines = (liner * 1.3 + tick + core + coreRing + arms + sweep) * breathe;
    float edge = band * uBoundaryGlow * breathe;

    float alpha = clamp(fill + lines + edge, 0.0, 1.0) * uOpacity * uReveal;
    if (alpha < 0.004) discard;

    vec3 color = uColorEdge * fill + uColorCore * lines + mix(uColorEdge, uColorCore, 0.5) * edge;
    color = mix(color, uColorInvalid * (fill + lines + edge), uInvalid);

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/** The ground AoE footprint at the impact point (settings.zone defaults). */
export class ZoneIndicator {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.PlaneGeometry;
  private material: THREE.ShaderMaterial;

  constructor() {
    this.geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this.geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uQuadSize: { value: 12 },
        uRadius: { value: 4.4 },
        uBoundary: { value: 0.34 },
        uBias: { value: 0.35 },
        uBoundaryGlow: { value: 1.8 },
        uLiner: { value: 0.05 },
        uSoftness: { value: 0.05 },
        uFill: { value: 0.22 },
        uFillFalloff: { value: 1.5 },
        uRings: { value: 2 },
        uRingWidth: { value: 0.05 },
        uRingSpeed: { value: 0.35 },
        uCrawl: { value: 0.75 },
        uCrawlScale: { value: 1.3 },
        uCrawlSpeed: { value: 0.45 },
        uNoise: { value: 0.4 },
        uNoiseScale: { value: 1.2 },
        uTicks: { value: 24 },
        uTickLength: { value: 0.42 },
        uTickWidth: { value: 0.2 },
        uTickSpin: { value: 0.06 },
        uSweep: { value: 0.55 },
        uSweepSpeed: { value: 0.4 },
        uCore: { value: 0.85 },
        uCoreSize: { value: 0.4 },
        uCrosshair: { value: 0.5 },
        uCrosshairLength: { value: 1.1 },
        uPulse: { value: 0.22 },
        uPulseSpeed: { value: 2 },
        uReveal: { value: 0 },
        uInvalid: { value: 0 },
        uOpacity: { value: 1 },
        uColorCore: { value: new THREE.Color(0.92, 0.97, 1) },
        uColorEdge: { value: new THREE.Color(0.49, 0.42, 1) },
        uColorInvalid: { value: _invalidColor.clone() },
        uGlobalGlow: { value: 1 },
      },
      vertexShader: ZONE_VERTEX,
      fragmentShader: ZONE_FRAGMENT,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = "ZoneIndicator";
    this.mesh.renderOrder = 995;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setColors(core: THREE.Color, edge: THREE.Color): void {
    this.material.uniforms.uColorCore.value.copy(core);
    this.material.uniforms.uColorEdge.value.copy(edge);
  }

  update(dt: number): void {
    this.material.uniforms.uTime.value += dt;
  }

  /**
   * Place/reshape the footprint disc at a world point.
   * @param center impact point (world; y already terrain-lifted by caller)
   * @param yaw    aim heading (aligns the crosshair downrange)
   * @param radius footprint radius, metres
   * @param reveal 0..1 snap-out
   * @param valid  false tints invalid
   * @param opacity overall multiplier (0..1) for travelling/fading zones
   */
  place(
    center: THREE.Vector3,
    yaw: number,
    radius: number,
    reveal: number,
    valid: boolean,
    opacity = 1,
  ): void {
    const u = this.material.uniforms;
    const boundary = 0.34;
    const snap = 1.18;

    const t = THREE.MathUtils.clamp(reveal, 0, 1);
    const bump = Math.sin(Math.PI * Math.pow(t, 1.7));
    const snapped = radius * Easing.outCubic(t) * (1 + (snap - 1) * bump);

    const quadSize = (radius * Math.max(1, snap) + boundary + 0.6) * 2;

    u.uQuadSize.value = quadSize;
    u.uRadius.value = Math.max(0.05, snapped);
    u.uReveal.value = t;
    u.uInvalid.value = valid ? 0 : 1;
    u.uOpacity.value = opacity;

    this.mesh.position.copy(center);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.scale.set(quadSize, 1, quadSize);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Ribbon — dynamic billboard trail (ported from RibbonGeometry.js)        */
/* ---------------------------------------------------------------------- */

const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();
const _view = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _pv = new THREE.Vector3();

const RIBBON_VERTEX = /* glsl */ `
  attribute float aDist;
  attribute float aSide;
  varying float vDist;
  varying float vSide;
  void main() {
    vDist = aDist;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  uniform vec3 uColorHead;
  uniform vec3 uColorTail;
  uniform float uOpacity;
  varying float vDist;
  varying float vSide;
  void main() {
    // vDist: 0 at tail (oldest), 1 at head (newest). Fade toward the tail.
    float along = clamp(vDist, 0.0, 1.0);
    float across = 1.0 - clamp(abs(vSide), 0.0, 1.0);
    across = pow(across, 1.4);
    float a = along * across * uOpacity;
    if (a < 0.004) discard;
    vec3 color = mix(uColorTail, uColorHead, along);
    gl_FragColor = vec4(color, a);
  }
`;

/**
 * A pre-allocated, per-frame-rebuilt billboard trail. `build()` rewrites only
 * the vertices it needs and moves the draw range — no per-frame allocation.
 * `uv.x`/`aDist` runs 0 (tail) → 1 (head); width tapers with the profile.
 */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private maxSegments: number;
  private positions: Float32Array;
  private uvs: Float32Array;
  private dists: Float32Array;
  private sides: Float32Array;

  constructor(maxSegments = 48) {
    this.maxSegments = maxSegments;
    const vertexCount = (maxSegments + 1) * 2;

    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(vertexCount * 3);
    this.uvs = new Float32Array(vertexCount * 2);
    this.dists = new Float32Array(vertexCount);
    this.sides = new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) this.sides[i] = i % 2 === 0 ? -1 : 1;

    const indices = new Uint16Array(maxSegments * 6);
    for (let s = 0; s < maxSegments; s++) {
      const a = s * 2;
      indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], s * 6);
    }

    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "uv",
      new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aDist",
      new THREE.BufferAttribute(this.dists, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.geometry.setAttribute("aSide", new THREE.BufferAttribute(this.sides, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uColorHead: { value: new THREE.Color(1, 1, 1) },
        uColorTail: { value: new THREE.Color(1, 0.4, 0.1) },
        uOpacity: { value: 1 },
      },
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
  }

  setColors(head: THREE.Color, tail: THREE.Color): void {
    this.material.uniforms.uColorHead.value.copy(head);
    this.material.uniforms.uColorTail.value.copy(tail);
  }

  setOpacity(o: number): void {
    this.material.uniforms.uOpacity.value = o;
  }

  /**
   * Rebuild the billboard ribbon from a polyline (index 0 = tail/oldest,
   * last = head/newest). Width tapers by `widthProfile(t)` where t is 0..1
   * along the ribbon.
   */
  build(
    points: THREE.Vector3[],
    width: number,
    cameraPosition: THREE.Vector3,
    widthProfile?: (t: number) => number,
  ): void {
    const count = Math.min(points.length, this.maxSegments + 1);
    if (count < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }

    for (let i = 0; i < count; i++) {
      const point = points[i];
      const t = i / (count - 1);

      if (i === 0) _tangent.copy(points[1]).sub(points[0]);
      else if (i === count - 1) _tangent.copy(points[count - 1]).sub(points[count - 2]);
      else _tangent.copy(points[i + 1]).sub(points[i - 1]);
      if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 0, 1);
      _tangent.normalize();

      _view.copy(cameraPosition).sub(point);
      _side.crossVectors(_tangent, _view);
      if (_side.lengthSq() < 1e-10) _side.copy(_up);
      _side.normalize();

      const scaled = width * (widthProfile ? widthProfile(t) : 1);
      const i2 = i * 2;

      _pv.copy(point).addScaledVector(_side, -scaled * 0.5);
      this.positions[i2 * 3 + 0] = _pv.x;
      this.positions[i2 * 3 + 1] = _pv.y;
      this.positions[i2 * 3 + 2] = _pv.z;

      _pv.copy(point).addScaledVector(_side, scaled * 0.5);
      this.positions[(i2 + 1) * 3 + 0] = _pv.x;
      this.positions[(i2 + 1) * 3 + 1] = _pv.y;
      this.positions[(i2 + 1) * 3 + 2] = _pv.z;

      this.uvs[i2 * 2 + 0] = t;
      this.uvs[i2 * 2 + 1] = 0;
      this.uvs[(i2 + 1) * 2 + 0] = t;
      this.uvs[(i2 + 1) * 2 + 1] = 1;

      this.dists[i2] = t;
      this.dists[i2 + 1] = t;
    }

    const vertexCount = count * 2;
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const uv = this.geometry.attributes.uv as THREE.BufferAttribute;
    const dist = this.geometry.attributes.aDist as THREE.BufferAttribute;
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    dist.needsUpdate = true;
    void vertexCount;

    this.geometry.setDrawRange(0, (count - 1) * 6);
  }

  clear(): void {
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* BurstSphere — pooled expanding impact shells                            */
/* ---------------------------------------------------------------------- */

export const BurstMode = {
  FIRE: 0,
  FROST: 4,
  STORM: 5,
} as const;
export type BurstModeValue = (typeof BurstMode)[keyof typeof BurstMode];

const BURST_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uDisplace;
  uniform float uSeed;
  uniform float uTurbulence;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;
  varying vec2  vUv;

  ${NOISE_GLSL}

  void main() {
    vUv = uv;
    vec3 np = normal * (1.6 + uAge * 1.4) + vec3(uSeed * 13.0) - vec3(0.0, uTime * 0.6, 0.0);
    float n = fbm4(np) * 0.6 + ridged(np * 1.3, 4) * 0.4;
    vDisp = n;

    float amount = uDisplace * (0.35 + uAge * 0.9) * uTurbulence;
    vec3 pos = position + normal * n * amount;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const BURST_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uAge;
  uniform float uSeed;
  uniform float uIntensity;
  uniform float uFresnel;
  uniform float uOpacity;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform float uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vDisp;
  varying vec2  vUv;

  ${NOISE_GLSL}
  ${COMMON_GLSL}

  void main() {
    float fres = fresnelTerm(vViewDir, vNormalW, 2.2, 1.0) * uFresnel;
    float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);
    vec2 dis = dissolveMask(heat, uAge * 1.15 - 0.15, 0.3);

    float alpha = uOpacity;
    vec3 color;

    #if BURST_MODE == 0                     /* FIRE */
      color = gradient4(uColorA, uColorB, uColorC, uColorC * 0.15, 1.0 - heat);
      color += dis.y * uColorA * 3.0;
      alpha *= (1.0 - uAge) * (0.55 + fres * 0.8) * dis.x;

    #elif BURST_MODE == 4                   /* FROST */
      float plates = smoothstep(0.42, 0.95, heat);
      float rime = smoothstep(0.55, 0.05, voronoi2(vNormalW.xy * 9.0 + vNormalW.z * 3.0 + uSeed).x);
      color = mix(uColorA, uColorB, heat * 0.9);
      color = mix(color, uColorC * (0.7 + 0.6 * rime), plates);
      color += uColorC * fres * 1.3;
      alpha *= (1.0 - uAge) * (0.16 + fres * 0.95 + plates * 0.7) * dis.x;

    #else                                   /* STORM */
      float fil = ridged(vNormalW * (5.0 + uAge * 7.0) + vec3(uSeed * 9.0) +
                         vec3(0.0, uTime * 3.4, 0.0), 4);
      float arcs = smoothstep(0.80, 0.97, fil) * (1.0 - uAge * 0.6);
      float rim = pow(fres, 1.6);
      color = mix(uColorA, uColorB, heat * 0.5);
      color = mix(color, uColorC, arcs);
      color += uColorC * rim * 1.2 + uColorC * arcs * 2.4;
      alpha *= (1.0 - uAge) * (rim * 0.55 + arcs * 0.9) * dis.x;
    #endif

    alpha = clamp(alpha, 0.0, 1.0);
    if (alpha < 0.004) discard;
    color *= uIntensity * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

interface Burst {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  mode: number;
  age: number;
  life: number;
  radius: number;
  endRadius: number;
}

export interface BurstOptions {
  radius?: number;
  endRadius?: number;
  life?: number;
  intensity?: number;
  opacity?: number;
  fresnel?: number;
  displace?: number;
  turbulence?: number;
  colorA?: THREE.Color;
  colorB?: THREE.Color;
  colorC?: THREE.Color;
}

/** Pooled expanding icosphere shells for impacts (fire/frost/storm modes). */
export class BurstSystem {
  readonly group: THREE.Group;
  private scene: THREE.Scene;
  private geometry: THREE.IcosahedronGeometry;
  private pools = new Map<number, Burst[]>();
  private active: Burst[] = [];
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "CastBursts";
    this.scene.add(this.group);
    this.geometry = new THREE.IcosahedronGeometry(1, 4);
  }

  private create(mode: number): Burst {
    const material = new THREE.ShaderMaterial({
      defines: { BURST_MODE: mode },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uAge: { value: 0 },
        uSeed: { value: Math.random() },
        uDisplace: { value: 0.45 },
        uTurbulence: { value: 1 },
        uIntensity: { value: 1 },
        uFresnel: { value: 1 },
        uOpacity: { value: 1 },
        uColorA: { value: new THREE.Color(1, 0.9, 0.6) },
        uColorB: { value: new THREE.Color(1, 0.45, 0.1) },
        uColorC: { value: new THREE.Color(0.4, 0.08, 0.03) },
        uGlobalGlow: { value: 1 },
      },
      vertexShader: BURST_VERTEX,
      fragmentShader: BURST_FRAGMENT,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.renderOrder = 14;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return { mesh, material, mode, age: 0, life: 1, radius: 1, endRadius: 2 };
  }

  private acquire(mode: number): Burst {
    let pool = this.pools.get(mode);
    if (!pool) {
      pool = [];
      this.pools.set(mode, pool);
    }
    const b = pool.pop();
    return b ?? this.create(mode);
  }

  private release(b: Burst): void {
    b.mesh.visible = false;
    this.group.remove(b.mesh);
    const pool = this.pools.get(b.mode);
    if (pool) pool.push(b);
  }

  spawn(mode: number, position: THREE.Vector3, options: BurstOptions = {}): void {
    const {
      radius = 0.4,
      endRadius = 3,
      life = 0.9,
      intensity = 1,
      opacity = 1,
      fresnel = 1,
      displace = 0.45,
      turbulence = 1,
      colorA,
      colorB,
      colorC,
    } = options;

    const burst = this.acquire(mode);
    const u = burst.material.uniforms;
    burst.age = 0;
    burst.life = Math.max(0.05, life);
    burst.radius = radius;
    burst.endRadius = endRadius;

    u.uAge.value = 0;
    u.uSeed.value = Math.random() * 10;
    u.uIntensity.value = intensity;
    u.uOpacity.value = opacity;
    u.uFresnel.value = fresnel;
    u.uDisplace.value = displace;
    u.uTurbulence.value = turbulence;
    if (colorA) u.uColorA.value.copy(colorA);
    if (colorB) u.uColorB.value.copy(colorB);
    if (colorC) u.uColorC.value.copy(colorC);

    burst.mesh.position.copy(position);
    burst.mesh.scale.setScalar(radius);
    burst.mesh.visible = true;
    this.group.add(burst.mesh);
    this.active.push(burst);
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const burst = this.active[i];
      burst.age += dt;
      const t = Math.min(1, burst.age / burst.life);
      burst.material.uniforms.uAge.value = t;
      burst.material.uniforms.uTime.value = this.time;
      const scale =
        burst.radius + (burst.endRadius - burst.radius) * Easing.outQuint(t);
      burst.mesh.scale.setScalar(scale);
      if (t >= 1) {
        this.active.splice(i, 1);
        this.release(burst);
      }
    }
  }

  clear(): void {
    for (const b of this.active) this.release(b);
    this.active.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const pool of this.pools.values()) {
      for (const b of pool) b.material.dispose();
    }
    this.pools.clear();
    this.geometry.dispose();
    this.scene.remove(this.group);
  }
}

/* ====================================================================== */
/* Phase-2: Elemental Sandbox ability visuals                              */
/*                                                                         */
/* Ported from the reference materials (LightningMaterial, BeamMaterial,   */
/* SnareMaterial, IceMaterial, MeteorMaterial) + ProceduralGeometry.       */
/* The reference's FrameUniforms/settings editor and depth-prepass soft    */
/* fade are replaced with a per-instance `uTime` uniform (advanced in      */
/* update(dt)) and the tuned settings.* defaults inlined as constants —    */
/* every knob keeps the reference value, it just stops being a live        */
/* slider. `uSceneDepth`/`softFade` and the HDR env probe are dropped       */
/* (this game has neither a depth prepass nor an environment map); the      */
/* materials are otherwise the reference shaders verbatim.                  */
/* ====================================================================== */

/* ---------------------------------------------------------------------- */
/* Parameter-space geometries (assets/ProceduralGeometry.js)               */
/* ---------------------------------------------------------------------- */

/** JS mirror of the GLSL hash11 — deterministic 0..1 from a scalar. */
function jsHash11(p: number): number {
  let x = (p * 0.1031) % 1;
  if (x < 0) x += 1;
  x *= x + 33.33;
  x *= x + x;
  return x - Math.floor(x);
}

/**
 * The strip a lightning filament / snare filament / beam coil is drawn on — a
 * flat ladder of quads in parameter space. `position = (t, side, 0)`; one
 * instance is one filament, `aStrand` is its index. Placed in world space by
 * the vertex shader, so its own bounds are meaningless.
 */
function createBoltRibbonGeometry(
  nodes = 72,
  strands = 24,
): THREE.InstancedBufferGeometry {
  const steps = Math.max(2, Math.round(nodes));
  const count = Math.max(1, Math.round(strands));

  const positions = new Float32Array(steps * 2 * 3);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const o = i * 6;
    positions[o + 0] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }

  const indices = new Uint16Array((steps - 1) * 6);
  for (let i = 0; i < steps - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o + 0] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }

  const strandIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) strandIndex[i] = i;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute(
    "aStrand",
    new THREE.InstancedBufferAttribute(strandIndex, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/** Beam column tube in parameter space: `position = (t, a, 0)`. */
function createBeamTubeGeometry(nodes = 96, sides = 26): THREE.BufferGeometry {
  const steps = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;

  const positions = new Float32Array(steps * columns * 3);
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    for (let j = 0; j < columns; j++) {
      positions[v++] = t;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array((steps - 1) * facets * 6);
  let k = 0;
  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < facets; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

/** Instanced shock-disc annulus: `position = (band, a, 0)`, `aRing` = index. */
function createBeamRingGeometry(
  rings = 10,
  segments = 44,
): THREE.InstancedBufferGeometry {
  const count = Math.max(1, Math.round(rings));
  const facets = Math.max(6, Math.round(segments));
  const columns = facets + 1;

  const positions = new Float32Array(2 * columns * 3);
  let v = 0;
  for (let band = 0; band < 2; band++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = band;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array(facets * 6);
  let k = 0;
  for (let j = 0; j < facets; j++) {
    const a = j;
    const b = columns + j;
    indices[k++] = a;
    indices[k++] = b;
    indices[k++] = a + 1;
    indices[k++] = b;
    indices[k++] = b + 1;
    indices[k++] = a + 1;
  }

  const ringIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) ringIndex[i] = i;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute(
    "aRing",
    new THREE.InstancedBufferAttribute(ringIndex, 1),
  );
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geometry;
}

const CRYSTAL_RINGS = [0, 0.22, 0.5, 0.75, 0.92];

function crystalProfileRadius(t: number, taper: number): number {
  return taper + (1 - taper) * Math.pow(1 - t, 1.15);
}

/**
 * A single ice crystal: a tapered, faceted, slightly bent prism in unit space
 * (base ring y=0, radius 0.5, apex y=1). Deterministic in `seed`.
 */
function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22,
}: {
  seed?: number;
  sides?: number;
  taper?: number;
  roughness?: number;
  bend?: number;
} = {}): THREE.BufferGeometry {
  const TAU = Math.PI * 2;
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = Math.min(0.9, Math.max(0.01, taper));

  const bendAngle = jsHash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);
  const axisOffset = (t: number) => bend * 0.5 * Math.pow(t, 1.6);

  const angles: number[] = [];
  for (let i = 0; i < facets; i++) {
    const jitter =
      (jsHash11(seed * 3.13 + i * 7.7) - 0.5) *
      (TAU / facets) *
      0.55 *
      roughness *
      3;
    angles.push((i / facets) * TAU + jitter);
  }

  const rings = CRYSTAL_RINGS.map((t, ringIndex) => {
    const baseR = crystalProfileRadius(t, tipRadius) * 0.5;
    const drift = axisOffset(t);
    const y =
      t +
      (jsHash11(seed * 5.9 + ringIndex * 2.3) - 0.5) *
        0.06 *
        roughness *
        (t > 0 ? 1 : 0);
    return angles.map((angle, i) => {
      const wobble =
        1 +
        (jsHash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) *
          roughness *
          1.3 *
          (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [
        Math.cos(angle) * r + bendX * drift,
        y,
        Math.sin(angle) * r + bendZ * drift,
      ] as [number, number, number];
    });
  });

  const apexDrift = axisOffset(1);
  const apex: [number, number, number] = [
    bendX * apexDrift + (jsHash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (jsHash11(seed * 19.7) - 0.5) * 0.09 * roughness,
  ];
  const floorCentre: [number, number, number] = [0, 0, 0];

  const positions: number[] = [];
  const push = (p: [number, number, number]) =>
    positions.push(p[0], p[1], p[2]);

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]);
      push(lower[j]);
      push(upper[i]);
      push(lower[j]);
      push(upper[j]);
      push(upper[i]);
    }
  }
  const top = rings[rings.length - 1];
  const base = rings[0];
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(top[i]);
    push(top[j]);
    push(apex);
    push(floorCentre);
    push(base[j]);
    push(base[i]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function jsValueNoise3(
  x: number,
  y: number,
  z: number,
  seed: number,
): number {
  const lattice = (ix: number, iy: number, iz: number) =>
    jsHash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const c000 = lattice(ix, iy, iz);
  const c100 = lattice(ix + 1, iy, iz);
  const c010 = lattice(ix, iy + 1, iz);
  const c110 = lattice(ix + 1, iy + 1, iz);
  const c001 = lattice(ix, iy, iz + 1);
  const c101 = lattice(ix + 1, iy, iz + 1);
  const c011 = lattice(ix, iy + 1, iz + 1);
  const c111 = lattice(ix + 1, iy + 1, iz + 1);
  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return y0 + (y1 - y0) * uz;
}

function jsFbmValue(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value +=
      amplitude *
      (jsValueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) *
        2 -
        1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

/** A meteor: a fractured, cratered ball of rock in unit space (radius ~1). */
function createAsteroidGeometry({
  seed = 1,
  detail = 3,
  lumpiness = 0.26,
  noiseScale = 1.5,
  roughness = 0.16,
  cuts = 7,
  cutDepth = 0.2,
  craters = 5,
  craterDepth = 0.18,
  craterSize = 0.5,
}: {
  seed?: number;
  detail?: number;
  lumpiness?: number;
  noiseScale?: number;
  roughness?: number;
  cuts?: number;
  cutDepth?: number;
  craters?: number;
  craterDepth?: number;
  craterSize?: number;
} = {}): THREE.BufferGeometry {
  const TAU = Math.PI * 2;
  const clampN = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  const smooth = (a: number, b: number, x: number) => {
    const t = clampN((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // IcosahedronGeometry is already non-indexed; converting again only spams
  // the console with warnings.
  const geometry = new THREE.IcosahedronGeometry(
    1,
    clampN(Math.round(detail), 0, 3),
  );
  const array = geometry.attributes.position.array as Float32Array;

  const direction = (a: number, b: number) => {
    const phi = Math.acos(2 * jsHash11(a) - 1);
    const theta = jsHash11(b) * TAU;
    const sinPhi = Math.sin(phi);
    return {
      x: sinPhi * Math.cos(theta),
      y: Math.cos(phi),
      z: sinPhi * Math.sin(theta),
    };
  };

  const planes: { x: number; y: number; z: number; offset: number }[] = [];
  for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
    const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
    const offset = 1 - cutDepth * (0.35 + 0.9 * jsHash11(seed * 13.1 + i * 6.7));
    planes.push({ ...n, offset });
  }
  const bowls: {
    x: number;
    y: number;
    z: number;
    radius: number;
    depth: number;
  }[] = [];
  for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
    const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
    const radius = Math.max(
      0.08,
      craterSize * (0.45 + 0.8 * jsHash11(seed * 11.3 + i * 3.7)),
    );
    const depth = craterDepth * (0.5 + jsHash11(seed * 17.9 + i * 2.1));
    bowls.push({ ...c, radius, depth });
  }

  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    let radius = 1;
    radius +=
      jsFbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) *
      lumpiness;
    radius +=
      jsFbmValue(
        x * noiseScale * 4.3,
        y * noiseScale * 4.3,
        z * noiseScale * 4.3,
        seed + 31.7,
        2,
      ) *
      roughness *
      0.5;
    for (const bowl of bowls) {
      const angle = Math.acos(
        clampN(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1),
      );
      const q = angle / bowl.radius;
      if (q >= 1.4) continue;
      radius -= bowl.depth * Math.max(0, 1 - q * q);
      radius +=
        bowl.depth * 0.5 * smooth(0.72, 1.0, q) * (1 - smooth(1.0, 1.4, q));
    }
    radius = Math.max(0.35, radius);
    let px = x * radius;
    let py = y * radius;
    let pz = z * radius;
    for (const plane of planes) {
      const along = px * plane.x + py * plane.y + pz * plane.z;
      const over = along - plane.offset;
      if (over <= 0) continue;
      px -= plane.x * over;
      py -= plane.y * over;
      pz -= plane.z * over;
    }
    array[i] = px;
    array[i + 1] = py;
    array[i + 2] = pz;
  }
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* Storm Lance — instanced filament-bundle bolt (materials/LightningMaterial) */
/* ---------------------------------------------------------------------- */

/** Hard cap on filaments in one bolt bundle. */
export const BOLT_MAX_FILAMENTS = 24;

const BOLT_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSag;
  uniform float uSeed;
  uniform float uRestrike;
  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;
  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;
  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;

  ${NOISE_GLSL}

  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);
    axis.y += uSag * sin(t * PI);
    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));
    vec2 offset = kink(t, seed, span) * uJitter * ends;
    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;
    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    vec3 here = boltPoint(t, seed, radial, n1, n2, span);
    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = boltPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= mix(uCoreWidth, 1.0, radial);
    halfWidth *= flash * uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const BOLT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;

  ${NOISE_GLSL}

  void main() {
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef BOLT_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);
    alpha *= drawn * flicker * vFlash * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);
    if (alpha < 0.003) discard;

    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Colour family for a bolt (Storm Lance thunder-violet by default). */
export interface BoltColors {
  core: THREE.ColorRepresentation;
  inner: THREE.ColorRepresentation;
  outer: THREE.ColorRepresentation;
  halo: THREE.ColorRepresentation;
}

function createLightningMaterial(glow: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: glow ? { BOLT_GLOW: "" } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uTarget: { value: new THREE.Vector3(0, 0, 1) },
      uSide: { value: new THREE.Vector3(1, 0, 0) },
      uSag: { value: 0.2 },
      uSeed: { value: 0 },
      uRestrike: { value: 24 },
      uProgress: { value: 0 },
      uFade: { value: 1 },
      uStrands: { value: 9 },
      uSpread: { value: 0.75 },
      uSpreadNear: { value: 0.05 },
      uSpreadCurve: { value: 1.6 },
      uTwist: { value: 0.45 },
      uTwistSpeed: { value: 0.8 },
      uBranchDim: { value: 0.72 },
      uJitter: { value: 0.34 },
      uJitterScale: { value: 0.85 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 3.2 },
      uPinch: { value: 0.14 },
      uConverge: { value: 0.8 },
      uWidth: { value: 0.085 },
      uWidthTip: { value: 0.5 },
      uWidthCurve: { value: 1 },
      uCoreWidth: { value: 2.1 },
      uCoreSharp: { value: 3.4 },
      uGlowFalloff: { value: 2.4 },
      uWidthScale: { value: glow ? 8 : 1 },
      uPassOpacity: { value: glow ? 0.32 : 1 },
      uFlicker: { value: 0.3 },
      uFlickerSpeed: { value: 34 },
      uStrandFlash: { value: 0.5 },
      uTipGlow: { value: 2 },
      uTipLength: { value: 0.08 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.3 },
      uColorCore: { value: new THREE.Color(1, 1, 1) },
      uColorInner: { value: new THREE.Color(0.78, 0.92, 1) },
      uColorOuter: { value: new THREE.Color(0.22, 0.62, 1) },
      uColorHalo: { value: new THREE.Color(0.04, 0.24, 0.78) },
    },
    vertexShader: BOLT_VERTEX,
    fragmentShader: BOLT_FRAGMENT,
  });
}

/**
 * A bolt bundle: one instanced ribbon strip drawn twice (hot CORE + wide GLOW),
 * every filament shaped in the vertex shader from `(origin, target)`. `progress`
 * clips how much of the whole shape exists so the strike-front travels.
 */
export class LightningBolt {
  readonly group: THREE.Group;
  private geometry: THREE.InstancedBufferGeometry;
  private core: THREE.Mesh;
  private glow: THREE.Mesh;
  private coreMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private time = 0;

  constructor(filaments = 9) {
    const count = Math.min(BOLT_MAX_FILAMENTS, Math.max(1, filaments));
    this.geometry = createBoltRibbonGeometry(72, count);
    this.coreMat = createLightningMaterial(false);
    this.glowMat = createLightningMaterial(true);
    this.coreMat.uniforms.uStrands.value = count;
    this.glowMat.uniforms.uStrands.value = count;
    const seed = Math.random() * 100;
    this.coreMat.uniforms.uSeed.value = seed;
    this.glowMat.uniforms.uSeed.value = seed;
    this.core = new THREE.Mesh(this.geometry, this.coreMat);
    this.glow = new THREE.Mesh(this.geometry, this.glowMat);
    this.core.frustumCulled = false;
    this.glow.frustumCulled = false;
    this.core.renderOrder = 13;
    this.glow.renderOrder = 12;
    this.group = new THREE.Group();
    this.group.add(this.glow, this.core);
  }

  setColors(c: BoltColors): void {
    for (const m of [this.coreMat, this.glowMat]) {
      (m.uniforms.uColorCore.value as THREE.Color).set(c.core);
      (m.uniforms.uColorInner.value as THREE.Color).set(c.inner);
      (m.uniforms.uColorOuter.value as THREE.Color).set(c.outer);
      (m.uniforms.uColorHalo.value as THREE.Color).set(c.halo);
    }
  }

  /** Aim the bolt. `side` is a lateral reference (perpendicular-ish to dir). */
  set(origin: THREE.Vector3, target: THREE.Vector3, side: THREE.Vector3): void {
    for (const m of [this.coreMat, this.glowMat]) {
      (m.uniforms.uOrigin.value as THREE.Vector3).copy(origin);
      (m.uniforms.uTarget.value as THREE.Vector3).copy(target);
      (m.uniforms.uSide.value as THREE.Vector3).copy(side);
    }
  }

  setProgress(p: number): void {
    this.coreMat.uniforms.uProgress.value = p;
    this.glowMat.uniforms.uProgress.value = p;
  }

  setFade(f: number): void {
    this.coreMat.uniforms.uFade.value = f;
    this.glowMat.uniforms.uFade.value = f;
  }

  update(dt: number): void {
    this.time += dt;
    this.coreMat.uniforms.uTime.value = this.time;
    this.glowMat.uniforms.uTime.value = this.time;
  }

  dispose(): void {
    this.geometry.dispose();
    this.coreMat.dispose();
    this.glowMat.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Nova Beam — parametric column tube (3 radii) + coils + shock discs + orb */
/* ---------------------------------------------------------------------- */

export const BeamPass = {
  CORE: 0,
  SHELL: 1,
  HALO: 2,
  COIL: 3,
  RING: 4,
  ORB: 5,
} as const;

const BEAM_UNIFORMS = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uFade;
  uniform float uWidthFade;
  uniform float uCharge;
  uniform float uRadius;
  uniform float uRadiusNear;
  uniform float uRadiusCurve;
  uniform float uRadiusScale;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uThrob;
  uniform float uThrobScale;
  uniform float uThrobSpeed;
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uRipple;
  uniform float uRippleBands;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uStreak;
  uniform float uStreakSharp;
  uniform float uStreakScale;
  uniform float uStreakBands;
  uniform float uStreakGlow;
  uniform float uFlowSpeed;
  uniform float uCoreSharp;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uShellRim;
  uniform float uShellFill;
  uniform float uHaloRim;
  uniform float uPassOpacity;
  uniform float uMouthGlow;
  uniform float uMouthLength;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoils;
  uniform float uCoilTurns;
  uniform float uCoilSpeed;
  uniform float uCoilRadius;
  uniform float uCoilFlare;
  uniform float uCoilWidth;
  uniform float uCoilWidthTip;
  uniform float uCoilSharp;
  uniform float uCoilPulse;
  uniform float uCoilPulseFreq;
  uniform float uCoilPulseSpeed;
  uniform float uRingCount;
  uniform float uRingSpeed;
  uniform float uRingInner;
  uniform float uRingOuter;
  uniform float uRingSwell;
  uniform float uRingFade;
  uniform float uRingSharp;
  uniform float uOrbTurbulence;
  uniform float uOrbScale;
  uniform float uOrbFlow;
  uniform float uOrbBands;
  uniform float uOrbRim;
  uniform float uOpacity;
  uniform float uGlow;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;
  uniform vec3  uColorCoil;
  uniform vec3  uColorCoilEdge;
  uniform vec3  uColorRing;
`;

const BEAM_VARYINGS = /* glsl */ `
  varying float vT;
  #if BEAM_PASS <= 2
    varying float vA;
    varying float vFacing;
  #elif BEAM_PASS == 3
    varying float vSide;
  #elif BEAM_PASS == 4
    varying float vBand;
    varying float vPhase;
  #else
    varying vec3  vNormalW;
    varying vec3  vViewDir;
    varying float vDisp;
  #endif
`;

const BEAM_SHAPE = /* glsl */ `
  float beamRadius(float t) {
    float u = clamp(t, 0.0, 1.0);
    float r = mix(uRadiusNear, uRadius, pow(u, max(uRadiusCurve, 0.01)));
    r *= 1.0 + uThrob * sin((u * uThrobScale - uTime * uThrobSpeed) * TAU);
    r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, u);
    return max(r * uRadiusScale * uWidthFade, 1e-4);
  }
  void beamFrame(out vec3 dir, out vec3 n1, out vec3 n2) {
    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    dir = delta / span;
    vec3 lateral = uSide - dir * dot(uSide, dir);
    n1 = length(lateral) > 1e-4 ? normalize(lateral) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    n2 = normalize(cross(dir, n1));
  }
  vec3 beamAxis(float t, vec3 n1, vec3 n2) {
    vec3 p = mix(uOrigin, uTarget, t);
    float ends = sin(clamp(t, 0.0, 1.0) * PI);
    float dx = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, uSeed));
    float dy = snoise(vec3(t * uWanderScale + 31.7, uTime * uWanderSpeed, uSeed + 7.3));
    return p + (n1 * dx + n2 * dy) * uWander * ends;
  }
`;

const BEAM_VERTEX = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}
  #if BEAM_PASS == 3
    attribute float aStrand;
  #endif
  #if BEAM_PASS == 4
    attribute float aRing;
  #endif
  ${NOISE_GLSL}
  ${BEAM_SHAPE}
  #if BEAM_PASS == 3
    vec3 coilPoint(float t, float phase, vec3 n1, vec3 n2) {
      float angle = (t * uCoilTurns + uTime * uCoilSpeed + phase) * TAU;
      float r = beamRadius(t) * uCoilRadius * (1.0 + uCoilFlare * pow(clamp(t, 0.0, 1.0), 3.0));
      return beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
    }
  #endif
  void main() {
    vec3 dir, n1, n2;
    #if BEAM_PASS != 5
      beamFrame(dir, n1, n2);
    #endif
    #if BEAM_PASS <= 2
      float t = position.x;
      float a = position.y;
      float angle = a * TAU;
      vec3 nrm = n1 * cos(angle) + n2 * sin(angle);
      float rip = snoise(vec3(cos(angle) * uRippleBands, sin(angle) * uRippleBands,
        t * uRippleScale - uTime * uRippleSpeed + uSeed));
      float r = beamRadius(t) * (1.0 + uRipple * rip);
      vec3 here = beamAxis(t, n1, n2) + nrm * r;
      vT = t; vA = a;
      vFacing = abs(dot(normalize(cameraPosition - here), nrm));
    #elif BEAM_PASS == 3
      float t = position.x;
      vSide = position.y; vT = t;
      float phase = uCoils <= 1.0 ? 0.0 : aStrand / uCoils;
      phase += hash11(aStrand * 5.31 + uSeed) * 0.12;
      vec3 here = coilPoint(t, phase, n1, n2);
      float step_ = 0.015;
      float ahead = t + step_;
      float flip = 1.0;
      if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
      vec3 tangent = (coilPoint(ahead, phase, n1, n2) - here) * flip;
      tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;
      vec3 binormal = cross(tangent, normalize(cameraPosition - here));
      float bl = length(binormal);
      binormal = bl > 1e-4 ? binormal / bl : n1;
      float halfWidth = uCoilWidth * mix(1.0, uCoilWidthTip, clamp(t, 0.0, 1.0));
      halfWidth *= smoothstep(0.0, 0.05, t) * uWidthFade * uFade;
      here += binormal * position.y * halfWidth;
    #elif BEAM_PASS == 4
      float phase = fract(aRing / max(uRingCount, 1.0) + uTime * uRingSpeed + uSeed * 0.37);
      float t = phase;
      float angle = position.y * TAU;
      float r = beamRadius(t) * mix(uRingInner, uRingOuter, position.x) * (1.0 + uRingSwell * phase);
      vec3 here = beamAxis(t, n1, n2) + (n1 * cos(angle) + n2 * sin(angle)) * r;
      vT = t; vBand = position.x; vPhase = phase;
    #else
      vec3 np = normal * uOrbScale + vec3(uSeed * 3.1) - vec3(0.0, uTime * uOrbFlow, 0.0);
      float n = fbm4(np) * 0.6 + ridged(np * 1.4, 4) * 0.4;
      vDisp = n;
      vec4 world = modelMatrix * vec4(position + normal * n * uOrbTurbulence, 1.0);
      vec3 here = world.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vViewDir = cameraPosition - here;
      vT = 0.0;
    #endif
    vec4 mv = viewMatrix * vec4(here, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  ${BEAM_UNIFORMS}
  ${BEAM_VARYINGS}
  ${NOISE_GLSL}
  void main() {
    vec3 color = vec3(0.0);
    float alpha = 0.0;
    #if BEAM_PASS == 5
      float facing = abs(dot(normalize(vViewDir), normalize(vNormalW)));
      float rim = pow(1.0 - facing, max(uOrbRim, 0.05));
      float heat = clamp(vDisp * 0.5 + 0.5, 0.0, 1.0);
      float fil = smoothstep(0.74, 0.98,
        ridged(vNormalW * uOrbBands + vec3(0.0, uTime * uOrbFlow * 2.0, 0.0) + uSeed, 4));
      color = mix(uColorOuter, uColorInner, heat);
      color = mix(color, uColorCore, clamp(fil + rim * 0.35, 0.0, 1.0));
      color += uColorCore * fil * 1.6;
      alpha = (0.2 + rim * 0.9 + fil * 0.75) * uCharge;
    #else
      float tip = max(uTipLength, 1e-3);
      float drawn = smoothstep(uProgress, uProgress - tip, vT);
      if (drawn <= 0.002) discard;
      #if BEAM_PASS <= 2
        float angle = vA * TAU;
        float flow = ridged(vec3(vT * uStreakScale - uTime * uFlowSpeed,
          cos(angle) * uStreakBands, sin(angle) * uStreakBands + uSeed), 4);
        float streak = smoothstep(mix(0.42, 0.86, clamp(uStreakSharp, 0.0, 1.0)), 0.99, flow) * uStreak;
        float facing = clamp(vFacing, 0.0, 1.0);
        float axisward = pow(facing, max(uCoreSharp, 0.05));
        float rim = pow(1.0 - facing, max(uEdgePower, 0.05));
        #if BEAM_PASS == 0
          color = mix(uColorInner, uColorCore, clamp(0.35 + streak, 0.0, 1.0));
          alpha = uCoreFill * mix(0.28, 1.0, axisward) + streak * 0.35;
        #elif BEAM_PASS == 1
          color = mix(uColorOuter, uColorInner, clamp(rim * 0.55 + streak, 0.0, 1.0));
          color += uColorCore * streak * uStreakGlow;
          alpha = rim * uShellRim + uShellFill * mix(0.12, 1.0, axisward) + streak * 0.4;
        #else
          float wide = pow(1.0 - facing, max(uHaloRim, 0.05));
          color = mix(uColorHalo, uColorOuter, wide);
          alpha = wide;
        #endif
        float mouth = smoothstep(uMouthLength, 0.0, vT);
        color += uColorCore * mouth * uMouthGlow;
        alpha += mouth * uMouthGlow * 0.2;
        float lead = smoothstep(uProgress - tip * 2.0, uProgress, vT);
        color += uColorCore * lead * uTipGlow;
        alpha += lead * uTipGlow * 0.18;
      #elif BEAM_PASS == 3
        float v = clamp(abs(vSide), 0.0, 1.0);
        float profile = pow(1.0 - v, max(uCoilSharp, 0.05));
        float pulse = 0.5 + 0.5 * sin((vT * uCoilPulseFreq - uTime * uCoilPulseSpeed) * TAU);
        color = mix(uColorCoilEdge, uColorCoil, profile);
        color += uColorCore * pulse * profile * uCoilPulse;
        alpha = profile * mix(1.0 - clamp(uCoilPulse, 0.0, 0.9) * 0.5, 1.0, pulse);
      #else
        float band = 1.0 - abs(vBand * 2.0 - 1.0);
        float profile = pow(clamp(band, 0.0, 1.0), max(uRingSharp, 0.05));
        color = mix(uColorRing, uColorCore, profile);
        alpha = profile * mix(1.0, uRingFade, vPhase);
      #endif
      alpha *= drawn;
    #endif
    alpha *= uFade * uOpacity * uPassOpacity;
    if (alpha < 0.003) discard;
    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createBeamMaterial(pass: number): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    defines: { BEAM_PASS: pass },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uTarget: { value: new THREE.Vector3(0, 0, 1) },
      uSide: { value: new THREE.Vector3(1, 0, 0) },
      uSeed: { value: Math.random() * 100 },
      uProgress: { value: 0 },
      uFade: { value: 1 },
      uWidthFade: { value: 1 },
      uCharge: { value: 0 },
      uRadius: { value: 0.62 },
      uRadiusNear: { value: 0.22 },
      uRadiusCurve: { value: 0.7 },
      uRadiusScale: { value: 1 },
      uFlare: { value: 0.9 },
      uFlareWidth: { value: 0.22 },
      uThrob: { value: 0.06 },
      uThrobScale: { value: 2.4 },
      uThrobSpeed: { value: 1.6 },
      uWander: { value: 0.06 },
      uWanderScale: { value: 0.9 },
      uWanderSpeed: { value: 0.7 },
      uRipple: { value: 0.12 },
      uRippleBands: { value: 1.6 },
      uRippleScale: { value: 3.2 },
      uRippleSpeed: { value: 2.4 },
      uStreak: { value: 0.9 },
      uStreakSharp: { value: 0.45 },
      uStreakScale: { value: 5.5 },
      uStreakBands: { value: 2.6 },
      uStreakGlow: { value: 1.1 },
      uFlowSpeed: { value: 7 },
      uCoreSharp: { value: 1.4 },
      uCoreFill: { value: 0.85 },
      uEdgePower: { value: 2.2 },
      uShellRim: { value: 0.9 },
      uShellFill: { value: 0.18 },
      uHaloRim: { value: 3.4 },
      uPassOpacity: { value: 1 },
      uMouthGlow: { value: 1.5 },
      uMouthLength: { value: 0.1 },
      uTipGlow: { value: 1.6 },
      uTipLength: { value: 0.06 },
      uCoils: { value: 4 },
      uCoilTurns: { value: 2.2 },
      uCoilSpeed: { value: 0.9 },
      uCoilRadius: { value: 1.35 },
      uCoilFlare: { value: 0.8 },
      uCoilWidth: { value: 0.1 },
      uCoilWidthTip: { value: 1.8 },
      uCoilSharp: { value: 2.2 },
      uCoilPulse: { value: 0.6 },
      uCoilPulseFreq: { value: 3 },
      uCoilPulseSpeed: { value: 1.6 },
      uRingCount: { value: 6 },
      uRingSpeed: { value: 1.3 },
      uRingInner: { value: 1.15 },
      uRingOuter: { value: 2.1 },
      uRingSwell: { value: 0.5 },
      uRingFade: { value: 0.15 },
      uRingSharp: { value: 1.6 },
      uOrbTurbulence: { value: 0.22 },
      uOrbScale: { value: 2.2 },
      uOrbFlow: { value: 0.8 },
      uOrbBands: { value: 5 },
      uOrbRim: { value: 1.8 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new THREE.Color(1, 1, 1) },
      uColorInner: { value: new THREE.Color(0.82, 0.96, 1) },
      uColorOuter: { value: new THREE.Color(0.29, 0.78, 1) },
      uColorHalo: { value: new THREE.Color(0.05, 0.2, 0.85) },
      uColorCoil: { value: new THREE.Color(1, 0.86, 0.5) },
      uColorCoilEdge: { value: new THREE.Color(1, 0.45, 0.12) },
      uColorRing: { value: new THREE.Color(0.6, 0.94, 1) },
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
  });
  // Per-pass tube radius / opacity / glow (from settings.beam pass table).
  const u = material.uniforms;
  switch (pass) {
    case BeamPass.CORE:
      u.uRadiusScale.value = 0.32;
      break;
    case BeamPass.SHELL:
      u.uRadiusScale.value = 0.72;
      u.uPassOpacity.value = 0.7;
      break;
    case BeamPass.HALO:
      u.uRadiusScale.value = 1.6;
      u.uPassOpacity.value = 0.4;
      u.uGlow.value = 2.2 * 0.8;
      break;
    case BeamPass.COIL:
      u.uPassOpacity.value = 0.85;
      u.uGlow.value = 2.4;
      break;
    case BeamPass.RING:
      u.uPassOpacity.value = 0.8;
      u.uGlow.value = 2.2;
      break;
    default:
      u.uPassOpacity.value = 1;
      u.uGlow.value = 2.6;
      break;
  }
  return material;
}

export interface BeamColors {
  core: THREE.ColorRepresentation;
  inner: THREE.ColorRepresentation;
  outer: THREE.ColorRepresentation;
  halo: THREE.ColorRepresentation;
  coil: THREE.ColorRepresentation;
  coilEdge: THREE.ColorRepresentation;
  ring: THREE.ColorRepresentation;
}

/**
 * Nova Beam — a held column of light. One parametric tube drawn three times at
 * three radii (HALO/SHELL/CORE), the bolt ribbon strip bent into helix COILs,
 * an instanced annulus of shock RINGs sliding downrange, and a noise-eroded ORB
 * charge in the caster's hands. `charge` runs up during wind-up, `progress`
 * races the column downrange, then it holds and collapses.
 */
export class NovaBeam {
  readonly group: THREE.Group;
  private tubeGeo: THREE.BufferGeometry;
  private coilGeo: THREE.InstancedBufferGeometry;
  private ringGeo: THREE.InstancedBufferGeometry;
  private orbGeo: THREE.IcosahedronGeometry;
  private materials: THREE.ShaderMaterial[] = [];
  private orb: THREE.Mesh;
  private time = 0;

  constructor(coils = 4, rings = 6) {
    this.tubeGeo = createBeamTubeGeometry(96, 26);
    this.coilGeo = createBoltRibbonGeometry(128, Math.min(8, coils));
    this.ringGeo = createBeamRingGeometry(Math.min(12, rings), 44);
    this.orbGeo = new THREE.IcosahedronGeometry(1, 4);
    this.group = new THREE.Group();

    const seed = Math.random() * 100;
    const defs: [number, THREE.BufferGeometry, number][] = [
      [BeamPass.HALO, this.tubeGeo, 11],
      [BeamPass.SHELL, this.tubeGeo, 12],
      [BeamPass.CORE, this.tubeGeo, 13],
      [BeamPass.COIL, this.coilGeo, 13],
      [BeamPass.RING, this.ringGeo, 13],
      [BeamPass.ORB, this.orbGeo, 14],
    ];
    let orbMesh: THREE.Mesh | null = null;
    for (const [pass, geometry, renderOrder] of defs) {
      const material = createBeamMaterial(pass);
      material.uniforms.uSeed.value = seed;
      material.uniforms.uCoils.value = Math.min(8, coils);
      material.uniforms.uRingCount.value = Math.min(12, rings);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = renderOrder;
      this.materials.push(material);
      this.group.add(mesh);
      if (pass === BeamPass.ORB) orbMesh = mesh;
    }
    this.orb = orbMesh!;
    this.orb.scale.setScalar(0.4);
  }

  setColors(c: BeamColors): void {
    for (const m of this.materials) {
      (m.uniforms.uColorCore.value as THREE.Color).set(c.core);
      (m.uniforms.uColorInner.value as THREE.Color).set(c.inner);
      (m.uniforms.uColorOuter.value as THREE.Color).set(c.outer);
      (m.uniforms.uColorHalo.value as THREE.Color).set(c.halo);
      (m.uniforms.uColorCoil.value as THREE.Color).set(c.coil);
      (m.uniforms.uColorCoilEdge.value as THREE.Color).set(c.coilEdge);
      (m.uniforms.uColorRing.value as THREE.Color).set(c.ring);
    }
  }

  set(origin: THREE.Vector3, target: THREE.Vector3, side: THREE.Vector3): void {
    for (const m of this.materials) {
      (m.uniforms.uOrigin.value as THREE.Vector3).copy(origin);
      (m.uniforms.uTarget.value as THREE.Vector3).copy(target);
      (m.uniforms.uSide.value as THREE.Vector3).copy(side);
    }
    // The orb sits at the muzzle.
    this.orb.position.copy(origin);
  }

  /** 0..1 how far the column has raced downrange. */
  setProgress(p: number): void {
    for (const m of this.materials) m.uniforms.uProgress.value = p;
  }

  /** 0..1 orb energy (drives the orb pass and shows during wind-up). */
  setCharge(c: number): void {
    for (const m of this.materials) m.uniforms.uCharge.value = c;
    this.orb.scale.setScalar(0.35 + 0.5 * c);
  }

  /** 0..1 column width; collapse pulls this to 0 while the beam thins out. */
  setWidthFade(w: number): void {
    for (const m of this.materials) m.uniforms.uWidthFade.value = w;
  }

  setFade(f: number): void {
    for (const m of this.materials) m.uniforms.uFade.value = f;
  }

  update(dt: number): void {
    this.time += dt;
    for (const m of this.materials) m.uniforms.uTime.value = this.time;
  }

  dispose(): void {
    this.tubeGeo.dispose();
    this.coilGeo.dispose();
    this.ringGeo.dispose();
    this.orbGeo.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Voltaic Snare — role-per-instance cage strip + burnt ground field       */
/* ---------------------------------------------------------------------- */

/** Hard cap on filaments across all four snare roles. */
export const SNARE_MAX_FILAMENTS = 56;

export const SnareRole = {
  LEASH: 0,
  COLUMN: 1,
  TENDRIL: 2,
  RIM: 3,
} as const;

export interface SnareCounts {
  leash: number;
  column: number;
  tendril: number;
  rim: number;
}

const CAGE_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform vec3  uCentre;
  uniform vec3  uHand;
  uniform vec3  uFront;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uSeed;
  uniform float uRestrike;
  uniform float uFade;
  uniform float uCountLeash;
  uniform float uCountColumn;
  uniform float uCountTendril;
  uniform float uCountRim;
  uniform float uLeashSag;
  uniform float uLeashSpread;
  uniform float uLeashCling;
  uniform float uLeashKink;
  uniform float uLeashWidth;
  uniform float uHeightCurve;
  uniform float uThroat;
  uniform float uColumnSpread;
  uniform float uColumnCurve;
  uniform float uColumnFlare;
  uniform float uColumnTwist;
  uniform float uColumnSpin;
  uniform float uColumnKink;
  uniform float uColumnWidth;
  uniform float uColumnTaper;
  uniform float uTendrilInner;
  uniform float uTendrilReach;
  uniform float uTendrilCurve;
  uniform float uTendrilWander;
  uniform float uTendrilArch;
  uniform float uTendrilHug;
  uniform float uTendrilSpin;
  uniform float uTendrilKink;
  uniform float uTendrilWidth;
  uniform float uTendrilDim;
  uniform float uRimSpan;
  uniform float uRimSpeed;
  uniform float uRimHeight;
  uniform float uRimJitter;
  uniform float uRimKink;
  uniform float uRimWidth;
  uniform float uRimDim;
  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vDim;
  varying float vFlash;

  ${NOISE_GLSL}

  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }
  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }
  vec3 pathAt(float role, float f, float seed, float t) {
    if (role < 0.5) {
      vec3 p = mix(uHand, uFront, t);
      p.y += uLeashSag * sin(t * PI);
      p.y = max(p.y, uLeashCling);
      return p;
    }
    if (role < 1.5) {
      float a = f * TAU + (t * uColumnTwist + uTime * uColumnSpin) * TAU;
      float r = uRadius * (mix(uThroat, uColumnSpread, pow(t, max(uColumnCurve, 0.01)))
                           + uColumnFlare * smoothstep(0.72, 1.0, t));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = pow(t, max(uHeightCurve, 0.01)) * uHeight + uCentre.y;
      return p;
    }
    if (role < 2.5) {
      float veer = (hash11(seed + 5.0) - 0.5) * 2.0 * uTendrilWander;
      float a = f * TAU + uTime * uTendrilSpin * TAU + hash11(seed) * 0.4 + veer * pow(t, 1.4);
      float r = uRadius * mix(uTendrilInner, uTendrilReach, pow(t, max(uTendrilCurve, 0.01)));
      vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
      p.y = uTendrilHug + uTendrilArch * sin(t * PI) + uCentre.y;
      return p;
    }
    float a = (f + uTime * uRimSpeed) * TAU + hash11(seed) * 0.3 + t * uRimSpan * TAU;
    float r = uRadius * (1.0 + uRimJitter * 0.25 * sin(t * 6.0 + seed));
    vec3 p = uCentre + vec3(cos(a), 0.0, sin(a)) * r;
    p.y = uTendrilHug + uRimHeight * sin(t * PI) + uCentre.y;
    return p;
  }
  void main() {
    float t = position.x;
    float side = position.y;
    vT = t; vSide = side;

    float b1 = uCountLeash;
    float b2 = b1 + uCountColumn;
    float b3 = b2 + uCountTendril;
    float role = 0.0;
    float local = aStrand;
    float count = max(uCountLeash, 1.0);
    if (aStrand >= b3) { role = 3.0; local = aStrand - b3; count = max(uCountRim, 1.0); }
    else if (aStrand >= b2) { role = 2.0; local = aStrand - b2; count = max(uCountTendril, 1.0); }
    else if (aStrand >= b1) { role = 1.0; local = aStrand - b1; count = max(uCountColumn, 1.0); }
    float f = local / count;

    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;

    float amp = uLeashKink;
    float widthMul = uLeashWidth;
    float span = max(length(uFront - uHand), 0.01);
    float dim = 1.0;
    if (role > 2.5) {
      amp = uRimKink; widthMul = uRimWidth; dim = uRimDim;
      span = max(uRadius * uRimSpan * TAU, 0.01);
    } else if (role > 1.5) {
      amp = uTendrilKink; widthMul = uTendrilWidth; dim = uTendrilDim;
      span = max(uRadius * max(uTendrilReach - uTendrilInner, 0.05), 0.01);
    } else if (role > 0.5) {
      amp = uColumnKink; widthMul = uColumnWidth;
      span = max(uHeight, 0.01);
    }
    vDim = dim;

    float step_ = 0.02;
    vec3 here = pathAt(role, f, seed, t);
    vec3 behind = pathAt(role, f, seed, max(t - step_, 0.0));
    vec3 ahead = pathAt(role, f, seed, min(t + step_, 1.0));
    vec3 tangent = ahead - behind;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
    vec3 upRef = abs(tangent.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 n1 = normalize(cross(tangent, upRef));
    vec3 n2 = normalize(cross(tangent, n1));

    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);
    vec2 k = kink(t, seed, span) * amp * uJitter * ends;
    if (role < 0.5) {
      float fan = (f - 0.5) * 2.0 * uLeashSpread;
      k += vec2(cos(seed), sin(seed)) * fan * ends;
    }
    vec3 offset = n1 * k.x + n2 * k.y;
    if (role > 1.5) offset.y *= 0.3;

    vec3 world = here + offset;
    vec3 nextWorld = ahead + offset;
    if (role > 1.5) {
      world.y = max(world.y, uCentre.y + uTendrilHug * 0.4);
      nextWorld.y = max(nextWorld.y, uCentre.y + uTendrilHug * 0.4);
    }

    vec3 tan2 = nextWorld - world;
    tan2 = length(tan2) > 1e-5 ? normalize(tan2) : tangent;
    vec3 toCamera = normalize(cameraPosition - world);
    vec3 binormal = cross(tan2, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale * widthMul;
    halfWidth *= mix(1.0, pow(sin(clamp(t, 0.0, 1.0) * PI), 0.35), 0.85);
    if (role > 0.5 && role < 1.5) halfWidth *= mix(1.0, uColumnTaper, t);
    halfWidth *= flash * uFade;

    vec4 mv = viewMatrix * vec4(world + binormal * side * halfWidth, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const CAGE_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793
  uniform float uTime;
  uniform float uSeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;
  varying float vT;
  varying float vSide;
  varying float vDim;
  varying float vFlash;
  ${NOISE_GLSL}
  void main() {
    float v = clamp(abs(vSide), 0.0, 1.0);
    #ifdef CAGE_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif
    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);
    alpha *= pow(sin(clamp(vT, 0.0, 1.0) * PI), 0.35);
    alpha *= flicker * vFlash * vDim * uFade * uPassOpacity * uOpacity;
    if (alpha < 0.003) discard;
    color *= uGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createSnareCageMaterial(glow: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: glow ? { CAGE_GLOW: "" } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uCentre: { value: new THREE.Vector3() },
      uHand: { value: new THREE.Vector3() },
      uFront: { value: new THREE.Vector3(0, 0, 1) },
      uRadius: { value: 4.4 },
      uHeight: { value: 6.2 },
      uSeed: { value: 0 },
      uRestrike: { value: 21 },
      uFade: { value: 1 },
      uCountLeash: { value: 3 },
      uCountColumn: { value: 8 },
      uCountTendril: { value: 12 },
      uCountRim: { value: 7 },
      uLeashSag: { value: -0.35 },
      uLeashSpread: { value: 0.22 },
      uLeashCling: { value: 0.12 },
      uLeashKink: { value: 0.3 },
      uLeashWidth: { value: 1 },
      uHeightCurve: { value: 0.85 },
      uThroat: { value: 0.07 },
      uColumnSpread: { value: 0.17 },
      uColumnCurve: { value: 1.35 },
      uColumnFlare: { value: 0.12 },
      uColumnTwist: { value: 0.55 },
      uColumnSpin: { value: 0.4 },
      uColumnKink: { value: 0.24 },
      uColumnWidth: { value: 1.6 },
      uColumnTaper: { value: 0.55 },
      uTendrilInner: { value: 0.06 },
      uTendrilReach: { value: 1 },
      uTendrilCurve: { value: 0.8 },
      uTendrilWander: { value: 0.9 },
      uTendrilArch: { value: 0.22 },
      uTendrilHug: { value: 0.05 },
      uTendrilSpin: { value: 0.05 },
      uTendrilKink: { value: 0.18 },
      uTendrilWidth: { value: 0.75 },
      uTendrilDim: { value: 0.8 },
      uRimSpan: { value: 0.19 },
      uRimSpeed: { value: 0.28 },
      uRimHeight: { value: 0.35 },
      uRimJitter: { value: 0.16 },
      uRimKink: { value: 0.12 },
      uRimWidth: { value: 0.7 },
      uRimDim: { value: 0.9 },
      uJitter: { value: 1 },
      uJitterScale: { value: 1.4 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.55 },
      uCrawl: { value: 2.4 },
      uPinch: { value: 0.16 },
      uWidth: { value: 0.032 },
      uWidthScale: { value: glow ? 6.2 : 1 },
      uPassOpacity: { value: glow ? 0.44 : 1 },
      uStrandFlash: { value: 0.45 },
      uFlickerSpeed: { value: 30 },
      uFlicker: { value: 0.26 },
      uCoreSharp: { value: 4.4 },
      uGlowFalloff: { value: 2.3 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new THREE.Color(1, 1, 1) },
      uColorInner: { value: new THREE.Color(0.86, 0.82, 1) },
      uColorOuter: { value: new THREE.Color(0.56, 0.42, 1) },
      uColorHalo: { value: new THREE.Color(0.16, 0.05, 0.55) },
    },
    vertexShader: CAGE_VERTEX,
    fragmentShader: CAGE_FRAGMENT,
  });
}

const FIELD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FIELD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uQuadSize;
  uniform float uRadius;
  uniform float uBoundary;
  uniform float uBoundaryGlow;
  uniform float uFill;
  uniform float uFalloff;
  uniform float uVeins;
  uniform float uVeinScale;
  uniform float uVeinSharp;
  uniform float uWarp;
  uniform float uCrawl;
  uniform float uRings;
  uniform float uRingSpeed;
  uniform float uSpokes;
  uniform float uSpokeLength;
  uniform float uSpin;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uSeed;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3  uColorField;
  uniform vec3  uColorEdge;
  varying vec2 vUv;
  ${NOISE_GLSL}
  #define TAU 6.28318530718
  void main() {
    vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
    float d = length(p);
    float outer = uRadius + uBoundary * 0.4;
    float inner = max(0.01, uRadius - uBoundary * 0.6);
    float aa = fwidth(d) + 0.02;
    if (d > outer + aa * 4.0) discard;
    float band = smoothstep(outer + aa, outer - aa, d) * smoothstep(inner - aa, inner + aa, d);
    float interior = smoothstep(inner + aa, inner - aa, d);
    float radial = clamp(d / inner, 0.0, 1.0);
    float warp = fbm3(vec3(p * 0.5, uTime * 0.2 + uSeed)) * uWarp;
    float fil = ridged(vec3(p * uVeinScale + warp, uSeed * 11.0 + uTime * uCrawl), 4);
    float veins = smoothstep(mix(0.55, 0.86, uVeinSharp), 0.98, fil) * interior * uVeins;
    float ring = 0.5 + 0.5 * cos((radial * uRings - uTime * uRingSpeed) * TAU);
    ring = pow(ring, 8.0) * interior;
    float ang = atan(p.y, p.x) / TAU + 0.5;
    float spokePhase = fract(ang * uSpokes + uTime * uSpin * uSpokes);
    float spoke = 1.0 - smoothstep(0.22, 0.3, spokePhase);
    spoke *= smoothstep(inner - uSpokeLength, inner, d) * smoothstep(outer, inner, d);
    float core = smoothstep(uCoreSize * uRadius, 0.0, d) * uCore;
    float breathe = 1.0 + uPulse * sin(uTime * uPulseSpeed * TAU);
    float wash = interior * pow(radial, uFalloff) * uFill;
    float lines = (band * uBoundaryGlow + spoke + core + ring * 0.35) * breathe;
    float body = (wash + veins * 0.9) * breathe;
    float alpha = clamp(body + lines, 0.0, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;
    vec3 color = uColorField * body + uColorEdge * lines;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createSnareFieldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uQuadSize: { value: 12 },
      uRadius: { value: 4.4 },
      uBoundary: { value: 0.4 },
      uBoundaryGlow: { value: 2.6 },
      uFill: { value: 0.3 },
      uFalloff: { value: 1.7 },
      uVeins: { value: 1 },
      uVeinScale: { value: 1.5 },
      uVeinSharp: { value: 0.72 },
      uWarp: { value: 0.55 },
      uCrawl: { value: 0.5 },
      uRings: { value: 2.4 },
      uRingSpeed: { value: 0.8 },
      uSpokes: { value: 20 },
      uSpokeLength: { value: 0.5 },
      uSpin: { value: 0.05 },
      uCore: { value: 1.3 },
      uCoreSize: { value: 0.22 },
      uPulse: { value: 0.3 },
      uPulseSpeed: { value: 3.4 },
      uSeed: { value: Math.random() * 100 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorField: { value: new THREE.Color(0.56, 0.42, 1) },
      uColorEdge: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader: FIELD_VERTEX,
    fragmentShader: FIELD_FRAGMENT,
  });
}

export interface SnareColors {
  core: THREE.ColorRepresentation;
  inner: THREE.ColorRepresentation;
  outer: THREE.ColorRepresentation;
  halo: THREE.ColorRepresentation;
  field: THREE.ColorRepresentation;
  fieldEdge: THREE.ColorRepresentation;
}

/**
 * Voltaic Snare — a zone-targeted trap. One instanced ribbon strip draws all
 * four roles (leash whip, column, tendrils, rim arcs) selected by instance
 * index against the live counts, plus a burnt-in ground field quad. `hand` and
 * `front` place the leash; `centre`/`radius` place the trap on the floor.
 */
export class SnareCage {
  readonly group: THREE.Group;
  private geometry: THREE.InstancedBufferGeometry;
  private coreMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private fieldMat: THREE.ShaderMaterial;
  private field: THREE.Mesh;
  private counts: SnareCounts;
  private time = 0;

  constructor(counts: SnareCounts = { leash: 3, column: 8, tendril: 12, rim: 7 }) {
    const total = Math.min(
      SNARE_MAX_FILAMENTS,
      counts.leash + counts.column + counts.tendril + counts.rim,
    );
    this.counts = counts;
    this.geometry = createBoltRibbonGeometry(64, total);
    this.coreMat = createSnareCageMaterial(false);
    this.glowMat = createSnareCageMaterial(true);
    const seed = Math.random() * 100;
    this.applyCounts();
    for (const m of [this.coreMat, this.glowMat]) m.uniforms.uSeed.value = seed;

    const core = new THREE.Mesh(this.geometry, this.coreMat);
    const glow = new THREE.Mesh(this.geometry, this.glowMat);
    core.frustumCulled = false;
    glow.frustumCulled = false;
    core.renderOrder = 13;
    glow.renderOrder = 12;

    this.fieldMat = createSnareFieldMaterial();
    this.field = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.fieldMat);
    this.field.rotation.x = -Math.PI / 2;
    this.field.renderOrder = 10;

    this.group = new THREE.Group();
    this.group.add(this.field, glow, core);
  }

  private applyCounts(): void {
    for (const m of [this.coreMat, this.glowMat]) {
      m.uniforms.uCountLeash.value = this.counts.leash;
      m.uniforms.uCountColumn.value = this.counts.column;
      m.uniforms.uCountTendril.value = this.counts.tendril;
      m.uniforms.uCountRim.value = this.counts.rim;
    }
  }

  setCounts(counts: SnareCounts): void {
    this.counts = counts;
    this.applyCounts();
  }

  setColors(c: SnareColors): void {
    for (const m of [this.coreMat, this.glowMat]) {
      (m.uniforms.uColorCore.value as THREE.Color).set(c.core);
      (m.uniforms.uColorInner.value as THREE.Color).set(c.inner);
      (m.uniforms.uColorOuter.value as THREE.Color).set(c.outer);
      (m.uniforms.uColorHalo.value as THREE.Color).set(c.halo);
    }
    (this.fieldMat.uniforms.uColorField.value as THREE.Color).set(c.field);
    (this.fieldMat.uniforms.uColorEdge.value as THREE.Color).set(c.fieldEdge);
  }

  set(
    centre: THREE.Vector3,
    hand: THREE.Vector3,
    front: THREE.Vector3,
    radius: number,
    height: number,
  ): void {
    for (const m of [this.coreMat, this.glowMat]) {
      (m.uniforms.uCentre.value as THREE.Vector3).copy(centre);
      (m.uniforms.uHand.value as THREE.Vector3).copy(hand);
      (m.uniforms.uFront.value as THREE.Vector3).copy(front);
      m.uniforms.uRadius.value = radius;
      m.uniforms.uHeight.value = height;
    }
    this.fieldMat.uniforms.uRadius.value = radius;
    const quad = radius * 2.6;
    this.fieldMat.uniforms.uQuadSize.value = quad;
    this.field.scale.set(quad, quad, quad);
    this.field.position.copy(centre).setY(centre.y + 0.04);
  }

  setFade(f: number): void {
    this.coreMat.uniforms.uFade.value = f;
    this.glowMat.uniforms.uFade.value = f;
    this.fieldMat.uniforms.uFade.value = f;
  }

  update(dt: number): void {
    this.time += dt;
    this.coreMat.uniforms.uTime.value = this.time;
    this.glowMat.uniforms.uTime.value = this.time;
    this.fieldMat.uniforms.uTime.value = this.time;
  }

  dispose(): void {
    this.geometry.dispose();
    this.coreMat.dispose();
    this.glowMat.dispose();
    this.field.geometry.dispose();
    this.fieldMat.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Frost Lance — procedural ice-crystal field (patched MeshStandardMaterial) */
/* ---------------------------------------------------------------------- */

/** Hard cap on crystals across the three instanced meshes. */
export const ICE_MAX_CRYSTALS = 288;

export interface IceColors {
  deep: THREE.ColorRepresentation;
  ice: THREE.ColorRepresentation;
  rim: THREE.ColorRepresentation;
  core: THREE.ColorRepresentation;
}

/**
 * Procedurally shaded ice, injected onto MeshStandardMaterial so the crystals
 * receive the arena's lights. The reference's HDR env probe and shadow-caster
 * registration are dropped (this game has neither); the stylisation shader is
 * otherwise the reference verbatim. Per-instance `aSeed`/`aBirth` arrive as
 * instanced attributes, so it is only ever used on an InstancedMesh.
 */
function createIceMaterial(colors: IceColors): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.16,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true,
    opacity: 0.9,
  });

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uColorDeep: { value: new THREE.Color(colors.deep) },
    uColorIce: { value: new THREE.Color(colors.ice) },
    uColorRim: { value: new THREE.Color(colors.rim) },
    uColorCore: { value: new THREE.Color(colors.core) },
    uDensity: { value: 1.15 },
    uFresnel: { value: 2.3 },
    uFresnelPower: { value: 2.4 },
    uTranslucency: { value: 1.5 },
    uFacetSharp: { value: 0.68 },
    uFracture: { value: 0.62 },
    uFractureScale: { value: 6.5 },
    uVeins: { value: 0.45 },
    uVeinScale: { value: 3.2 },
    uSparkle: { value: 1.6 },
    uSparkleScale: { value: 34 },
    uSparkleSpeed: { value: 0.7 },
    uFrostLine: { value: 0.5 },
    uGlow: { value: 1.35 },
    uEdgeGlow: { value: 2.0 },
    uBirthGlow: { value: 3.2 },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vIceLocal = transformed;
         vIceSeed = aSeed;
         vIceBirth = aBirth;
         #ifdef USE_INSTANCING
           vIceWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vIceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorIce;
         uniform vec3  uColorRim;
         uniform vec3  uColorCore;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uTranslucency;
         uniform float uFacetSharp;
         uniform float uFracture;
         uniform float uFractureScale;
         uniform float uVeins;
         uniform float uVeinScale;
         uniform float uSparkle;
         uniform float uSparkleScale;
         uniform float uSparkleSpeed;
         uniform float uFrostLine;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBirthGlow;
         varying vec3  vIceLocal;
         varying vec3  vIceWorld;
         varying float vIceSeed;
         varying float vIceBirth;
         ${NOISE_GLSL}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;
           vec3  fp     = vIceWorld * uFractureScale + vIceSeed * 37.0;
           float cracks = smoothstep(0.55, 0.98, ridged(fp, 4));
           float veins = fbm3(vIceLocal * uVeinScale * 4.0 + vIceSeed * 11.0) * 0.5 + 0.5;
           veins = smoothstep(0.45, 0.92, veins);
           vec3 body = mix(uColorIce, uColorDeep, thickness);
           body = mix(body, uColorRim, veins * uVeins * 0.55);
           body = mix(body, uColorRim, cracks * uFracture * 0.4);
           float rime = smoothstep(0.55, 0.0, vIceLocal.y) *
                        (0.5 + 0.5 * fbm3(vIceLocal * 9.0 + vIceSeed * 5.0));
           body = mix(body, uColorRim, clamp(rime, 0.0, 1.0) * uFrostLine);
           body *= mix(1.0, 0.55 + 0.9 * ndv, uFacetSharp);
           float sp = snoise(vIceWorld * uSparkleScale +
                             vec3(0.0, uTime * uSparkleSpeed, 0.0) + vIceSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 14.0) * smoothstep(0.0, 0.7, fres + 0.3);
           diffuseColor.rgb *= body;
           float rimAmount = pow(1.0 - ndv, uFresnelPower);
           vec3 glow = uColorRim * rimAmount * uEdgeGlow;
           glow += uColorCore * (cracks * uFracture * 0.8 + veins * uVeins * 0.35) * uTranslucency;
           glow += uColorRim * sp * uSparkle * 1.5;
           glow += uColorCore * vIceBirth * uBirthGlow;
           glow *= uGlow;
           glow /= 1.0 + glow * 0.22;
           totalEmissiveRadiance += glow;
           diffuseColor.a = clamp(diffuseColor.a * (0.62 + 0.5 * fres) + cracks * 0.12, 0.0, 1.0);
         }`,
      );
  };
  return material;
}

interface IceCrystal {
  along: number; // 0..1 position down the line
  side: number;
  seed: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  yaw: number;
  scaleXZ: number;
  height: number;
  erupted: boolean;
  grow: number; // 0..1
  birth: number; // birth-flash 1..0
}

/**
 * A field of ice crystals erupting along the aimed line. Three instanced meshes
 * (tall spikes, mid spikes, ankle shards) share the ice material; each crystal
 * pops up and grows with a birth flash, then sinks on fade. `aSeed`/`aBirth`
 * per instance drive the shader's fracture/veining/birth glow.
 */
export class IceCrystalField {
  readonly group: THREE.Group;
  private meshes: THREE.InstancedMesh[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mat: THREE.MeshStandardMaterial;
  private crystals: IceCrystal[][] = [];
  private dummy = new THREE.Object3D();
  private time = 0;

  constructor(colors: IceColors) {
    this.group = new THREE.Group();
    this.mat = createIceMaterial(colors);
    // Three shape tiers, capped at ICE_MAX_CRYSTALS total.
    const tiers = [
      createCrystalGeometry({ seed: 3, sides: 6, taper: 0.12, roughness: 0.26, bend: 0.2 }),
      createCrystalGeometry({ seed: 9, sides: 5, taper: 0.16, roughness: 0.34, bend: 0.28 }),
      createCrystalGeometry({ seed: 21, sides: 5, taper: 0.22, roughness: 0.55, bend: 0.35 }),
    ];
    for (const geo of tiers) {
      this.geos.push(geo);
      const cap = Math.floor(ICE_MAX_CRYSTALS / 3);
      const mesh = new THREE.InstancedMesh(geo, this.mat, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      // Per-instance seed + birth attributes.
      const seeds = new Float32Array(cap);
      const births = new Float32Array(cap);
      geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
      geo.setAttribute("aBirth", new THREE.InstancedBufferAttribute(births, 1));
      this.meshes.push(mesh);
      this.crystals.push([]);
      this.group.add(mesh);
    }
  }

  /**
   * Populate the field along a line. `pointAt(t)` returns the world point on the
   * (ground-following) line, `side` is the lateral unit vector.
   */
  build(
    count: number,
    pointAt: (t: number) => THREE.Vector3,
    side: THREE.Vector3,
  ): void {
    const perTier = Math.min(
      Math.floor(ICE_MAX_CRYSTALS / 3),
      Math.ceil(count / 3),
    );
    for (let tier = 0; tier < 3; tier++) {
      const arr = this.crystals[tier];
      arr.length = 0;
      const heightScale = tier === 0 ? 1 : tier === 1 ? 0.7 : 0.4;
      const widthScale = tier === 2 ? 1.4 : 1;
      for (let i = 0; i < perTier; i++) {
        const along = (i + 0.5 + (tier * 0.33)) / perTier;
        const seed = Math.random();
        const p = pointAt(Math.min(1, along));
        const scatter = (seed - 0.5) * (tier === 0 ? 1.4 : 2.2);
        arr.push({
          along,
          side: scatter,
          seed: seed * 40,
          baseX: p.x + side.x * scatter,
          baseY: p.y,
          baseZ: p.z + side.z * scatter,
          yaw: seed * Math.PI * 2,
          scaleXZ: (0.35 + seed * 0.4) * widthScale,
          height: (1.4 + seed * 1.6) * heightScale,
          erupted: false,
          grow: 0,
          birth: 0,
        });
      }
    }
  }

  setColors(colors: IceColors): void {
    const u = this.mat.userData.uniforms as Record<string, THREE.IUniform>;
    (u.uColorDeep.value as THREE.Color).set(colors.deep);
    (u.uColorIce.value as THREE.Color).set(colors.ice);
    (u.uColorRim.value as THREE.Color).set(colors.rim);
    (u.uColorCore.value as THREE.Color).set(colors.core);
  }

  /**
   * Erupt crystals whose `along` is behind the front; grow eruptions; on fade
   * sink and dim. `front` 0..1, `fade` 0..1 (drops opacity as it goes to 0),
   * `sink` true once the ability is winding down. Returns indices newly erupted
   * for the caller to tick damage.
   */
  update(dt: number, front: number, fade: number, sink: boolean): void {
    this.time += dt;
    const u = this.mat.userData.uniforms as Record<string, THREE.IUniform>;
    u.uTime.value = this.time;
    this.mat.opacity = 0.9 * fade;
    for (let tier = 0; tier < 3; tier++) {
      const arr = this.crystals[tier];
      const mesh = this.meshes[tier];
      const seedAttr = this.geos[tier].getAttribute(
        "aSeed",
      ) as THREE.InstancedBufferAttribute;
      const birthAttr = this.geos[tier].getAttribute(
        "aBirth",
      ) as THREE.InstancedBufferAttribute;
      mesh.count = arr.length;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (!sink && !c.erupted && c.along <= front) {
          c.erupted = true;
          c.birth = 1;
        }
        if (c.erupted && !sink) {
          c.grow = Math.min(1, c.grow + dt * 5);
          c.birth = Math.max(0, c.birth - dt * 2.5);
        } else if (sink) {
          c.grow = Math.max(0, c.grow - dt * 2.6);
        }
        // ease-out pop
        const g = c.grow * (2 - c.grow);
        this.dummy.position.set(c.baseX, c.baseY - (1 - g) * 0.6, c.baseZ);
        this.dummy.rotation.set(
          (c.seed % 1 - 0.5) * 0.4,
          c.yaw,
          (c.seed % 1 - 0.5) * 0.4,
        );
        this.dummy.scale.set(c.scaleXZ * g, c.height * g, c.scaleXZ * g);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
        seedAttr.setX(i, c.seed);
        birthAttr.setX(i, c.birth);
      }
      mesh.instanceMatrix.needsUpdate = true;
      seedAttr.needsUpdate = true;
      birthAttr.needsUpdate = true;
    }
  }

  /** Erupt-crossing test for damage: crystals that crossed the front this frame. */
  eruptedThisStep(front: number, ticked: Set<string>): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let tier = 0; tier < 3; tier++) {
      const arr = this.crystals[tier];
      for (let i = 0; i < arr.length; i++) {
        const key = `${tier}:${i}`;
        if (arr[i].along <= front && !ticked.has(key)) {
          ticked.add(key);
          out.push(new THREE.Vector3(arr[i].baseX, arr[i].baseY, arr[i].baseZ));
        }
      }
    }
    return out;
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose();
    for (const geo of this.geos) geo.dispose();
    this.mat.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Cinder Fall — asteroid meteor + chunks (patched MeshStandardMaterial)    */
/* ---------------------------------------------------------------------- */

export interface MeteorColors {
  rock: THREE.ColorRepresentation;
  char: THREE.ColorRepresentation;
  crack: THREE.ColorRepresentation;
  hot: THREE.ColorRepresentation;
}

/**
 * Burning rock — the meteor and the chunks it breaks into. Injected onto
 * MeshStandardMaterial (lava seams as the zero-crossing of an fbm field, soot
 * haloes, leading-face heat, per-chunk cooling). The reference's env probe /
 * shadow-caster registration are dropped; the shader is otherwise verbatim.
 * `aSeed`/`aHeat` per instance, so only used on an InstancedMesh.
 */
function createMeteorMaterial(colors: MeteorColors): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: true,
  });
  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uColorRock: { value: new THREE.Color(colors.rock) },
    uColorChar: { value: new THREE.Color(colors.char) },
    uColorCrack: { value: new THREE.Color(colors.crack) },
    uColorHot: { value: new THREE.Color(colors.hot) },
    uCrackScale: { value: 2.4 },
    uCrackWidth: { value: 0.1 },
    uCrackBranches: { value: 0.65 },
    uCrackGlow: { value: 3.2 },
    uFlow: { value: 0.7 },
    uFlowSpeed: { value: 0.9 },
    uRockScale: { value: 3.4 },
    uFacetTint: { value: 0.35 },
    uCavity: { value: 0.45 },
    uSoot: { value: 0.8 },
    uRimHeat: { value: 1.1 },
    uLead: { value: 1.6 },
    uLeadSharp: { value: 2.6 },
    uHeading: { value: new THREE.Vector3(0, 0, 1) },
    uCharge: { value: 0 },
    uGlow: { value: 1 },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute float aSeed;
         attribute float aHeat;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vRockLocal = transformed;
         vRockSeed = aSeed;
         vRockHeat = aHeat;
         #ifdef USE_INSTANCING
           vRockNormalW = normalize(mat3(modelMatrix) * (instanceMatrix * vec4(objectNormal, 0.0)).xyz);
         #else
           vRockNormalW = normalize(mat3(modelMatrix) * objectNormal);
         #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorRock;
         uniform vec3  uColorChar;
         uniform vec3  uColorCrack;
         uniform vec3  uColorHot;
         uniform float uCrackScale;
         uniform float uCrackWidth;
         uniform float uCrackBranches;
         uniform float uCrackGlow;
         uniform float uFlow;
         uniform float uFlowSpeed;
         uniform float uRockScale;
         uniform float uFacetTint;
         uniform float uCavity;
         uniform float uSoot;
         uniform float uRimHeat;
         uniform float uLead;
         uniform float uLeadSharp;
         uniform vec3  uHeading;
         uniform float uCharge;
         uniform float uGlow;
         varying vec3  vRockLocal;
         varying vec3  vRockNormalW;
         varying float vRockSeed;
         varying float vRockHeat;
         ${NOISE_GLSL}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);
           float rim = pow(1.0 - ndv, 2.2);
           vec3  p  = vRockLocal * uCrackScale + vRockSeed * 19.0;
           float f1 = fbm3(p);
           float f2 = fbm3(p * 2.7 + 11.3);
           float width = max(0.004, uCrackWidth * (1.0 + uCharge * 0.8));
           float distance = min(abs(f1), abs(f2) / max(uCrackBranches, 0.05));
           float fissure = 1.0 - smoothstep(width * 0.35, width, distance);
           float lip     = 1.0 - smoothstep(width, width * 2.0, distance);
           float core    = 1.0 - smoothstep(0.0, width * 0.45, distance);
           float pulse = snoise(vRockLocal * 4.0 + vec3(0.0, uTime * uFlowSpeed, 0.0) + vRockSeed * 7.0);
           float flow  = mix(1.0, 0.45 + 0.75 * (pulse * 0.5 + 0.5), uFlow);
           float mottle = fbm3(vRockLocal * uRockScale + vRockSeed * 31.0) * 0.5 + 0.5;
           vec3  rock   = mix(uColorRock, uColorChar, smoothstep(0.3, 0.85, mottle));
           vec3  faceN = normalize(cross(dFdx(vRockLocal), dFdy(vRockLocal)));
           float facet = hash13(faceN * 37.0 + vRockSeed + 0.5);
           rock *= 1.0 + (facet - 0.5) * uFacetTint;
           float cavity = smoothstep(0.55, 1.0, length(vRockLocal));
           rock *= mix(1.0 - uCavity, 1.0, cavity);
           rock = mix(rock, uColorChar, lip * uSoot);
           rock *= 1.0 - fissure * 0.92;
           rock *= mix(0.55, 1.15, ndv);
           diffuseColor.rgb *= rock;
           float heat = fissure * flow * vRockHeat;
           vec3  glow = mix(uColorCrack, uColorHot, core * core) * heat * uCrackGlow;
           float charge2 = uCharge * uCharge;
           glow += uColorCrack * rim * uRimHeat * vRockHeat * charge2;
           float lead = pow(clamp(dot(normalize(vRockNormalW), uHeading), 0.0, 1.0), uLeadSharp);
           glow += uColorHot * lead * uLead * vRockHeat * charge2;
           glow *= uGlow;
           glow /= 1.0 + glow * 0.22;
           totalEmissiveRadiance += glow;
         }`,
      );
  };
  return material;
}

interface MeteorChunk {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  scale: number;
  seed: number;
  heat: number;
}

/**
 * Cinder Fall — an arcing cratered meteor that detonates into cooling chunks.
 * The meteor is one asteroid geometry on an InstancedMesh(count 1) so it shares
 * the lava-seam material; chunks are a second InstancedMesh. `charge` heats the
 * rock as it bears down, `heading` drives the compression heat on leading facets.
 */
export class MeteorRock {
  readonly group: THREE.Group;
  private meteorGeo: THREE.BufferGeometry;
  private chunkGeo: THREE.BufferGeometry;
  private mat: THREE.MeshStandardMaterial;
  private meteor: THREE.InstancedMesh;
  private chunkMesh: THREE.InstancedMesh;
  private chunks: MeteorChunk[] = [];
  private dummy = new THREE.Object3D();
  private time = 0;
  private meteorHeat = 1;
  readonly maxChunks = 18;

  constructor(colors: MeteorColors) {
    this.group = new THREE.Group();
    this.mat = createMeteorMaterial(colors);
    this.meteorGeo = createAsteroidGeometry({
      seed: Math.random() * 40,
      detail: 3,
      lumpiness: 0.28,
      cuts: 7,
      craters: 5,
    });
    this.chunkGeo = createAsteroidGeometry({
      seed: Math.random() * 40 + 7,
      detail: 1,
      lumpiness: 0.34,
      cuts: 4,
      craters: 2,
    });

    this.meteor = new THREE.InstancedMesh(this.meteorGeo, this.mat, 1);
    this.meteor.frustumCulled = false;
    const ms = new Float32Array([Math.random() * 20]);
    const mh = new Float32Array([1]);
    this.meteorGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(ms, 1));
    this.meteorGeo.setAttribute("aHeat", new THREE.InstancedBufferAttribute(mh, 1));

    this.chunkMesh = new THREE.InstancedMesh(this.chunkGeo, this.mat, this.maxChunks);
    this.chunkMesh.count = 0;
    this.chunkMesh.frustumCulled = false;
    const cs = new Float32Array(this.maxChunks);
    const ch = new Float32Array(this.maxChunks);
    for (let i = 0; i < this.maxChunks; i++) cs[i] = Math.random() * 30;
    this.chunkGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(cs, 1));
    this.chunkGeo.setAttribute("aHeat", new THREE.InstancedBufferAttribute(ch, 1));

    this.group.add(this.meteor, this.chunkMesh);
  }

  setColors(colors: MeteorColors): void {
    const u = this.mat.userData.uniforms as Record<string, THREE.IUniform>;
    (u.uColorRock.value as THREE.Color).set(colors.rock);
    (u.uColorChar.value as THREE.Color).set(colors.char);
    (u.uColorCrack.value as THREE.Color).set(colors.crack);
    (u.uColorHot.value as THREE.Color).set(colors.hot);
  }

  /** Place the meteor mid-flight. `charge` 0..1, `heading` unit travel dir. */
  setMeteor(pos: THREE.Vector3, radius: number, heading: THREE.Vector3, charge: number): void {
    const u = this.mat.userData.uniforms as Record<string, THREE.IUniform>;
    (u.uHeading.value as THREE.Vector3).copy(heading);
    u.uCharge.value = charge;
    this.dummy.position.copy(pos);
    this.dummy.rotation.set(this.time * 2.1, this.time * 1.4, this.time * 1.7);
    this.dummy.scale.setScalar(radius);
    this.dummy.updateMatrix();
    this.meteor.setMatrixAt(0, this.dummy.matrix);
    this.meteor.instanceMatrix.needsUpdate = true;
    (this.meteorGeo.getAttribute("aHeat") as THREE.InstancedBufferAttribute).setX(
      0,
      this.meteorHeat,
    );
    (this.meteorGeo.getAttribute("aHeat") as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  hideMeteor(): void {
    this.meteor.count = 0;
    this.meteorHeat = 0;
  }

  /** Spawn the detonation chunks at the impact. */
  detonate(at: THREE.Vector3, groundY: (x: number, z: number) => number): void {
    this.chunks.length = 0;
    const n = this.maxChunks;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random();
      const speed = 4 + Math.random() * 7;
      this.chunks.push({
        pos: at.clone().setY(at.y + 0.4),
        vel: new THREE.Vector3(
          Math.cos(a) * speed,
          4 + Math.random() * 6,
          Math.sin(a) * speed,
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
        ),
        rot: new THREE.Euler(),
        scale: 0.25 + Math.random() * 0.45,
        seed: Math.random() * 30,
        heat: 1,
      });
    }
    this.chunkMesh.count = n;
    (this.chunkGeo.getAttribute("aHeat") as THREE.InstancedBufferAttribute).needsUpdate = true;
    void groundY;
  }

  update(dt: number, groundY?: (x: number, z: number) => number): void {
    this.time += dt;
    const u = this.mat.userData.uniforms as Record<string, THREE.IUniform>;
    u.uTime.value = this.time;
    if (this.chunks.length === 0) return;
    const heatAttr = this.chunkGeo.getAttribute("aHeat") as THREE.InstancedBufferAttribute;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.vel.y -= 22 * dt;
      c.pos.addScaledVector(c.vel, dt);
      const floor = groundY ? groundY(c.pos.x, c.pos.z) + c.scale * 0.4 : c.scale * 0.4;
      if (c.pos.y < floor) {
        c.pos.y = floor;
        c.vel.y *= -0.35;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
      }
      c.rot.x += c.spin.x * dt;
      c.rot.y += c.spin.y * dt;
      c.rot.z += c.spin.z * dt;
      c.heat = Math.max(0, c.heat - dt * 0.55);
      this.dummy.position.copy(c.pos);
      this.dummy.rotation.copy(c.rot);
      this.dummy.scale.setScalar(c.scale);
      this.dummy.updateMatrix();
      this.chunkMesh.setMatrixAt(i, this.dummy.matrix);
      heatAttr.setX(i, c.heat);
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;
    heatAttr.needsUpdate = true;
  }

  dispose(): void {
    this.meteor.dispose();
    this.chunkMesh.dispose();
    this.meteorGeo.dispose();
    this.chunkGeo.dispose();
    this.mat.dispose();
  }
}

/* ---------------------------------------------------------------------- */
/* Rain of Arrows — signal shot + pooled falling-arrow InstancedMesh        */
/* ---------------------------------------------------------------------- */

export interface VolleyColors {
  /** Arrow head / signal glow (bright gold). */
  head: THREE.ColorRepresentation;
  /** Arrow shaft (muted). */
  shaft: THREE.ColorRepresentation;
}

interface FallingArrow {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  landed: boolean;
  life: number; // seconds since landing (for the stuck-arrow fade)
}

/**
 * A single reusable arrow-shaft geometry (thin stretched shaft + cone head,
 * oriented so +Y is the flight direction) shared by the InstancedMesh: falling
 * arrows are oriented via per-instance matrices toward their velocity.
 */
function createArrowShaftGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.018, 0.018, 0.62, 5);
  const head = new THREE.ConeGeometry(0.05, 0.16, 6);
  head.translate(0, 0.39, 0);
  const geos: THREE.BufferGeometry[] = [shaft, head];
  const merged = mergeSimpleGeometries(geos);
  shaft.dispose();
  head.dispose();
  return merged;
}

/** Minimal position/normal geometry merge (no external BufferGeometryUtils). */
function mergeSimpleGeometries(
  geos: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  let vertCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    const pos = g.getAttribute("position");
    vertCount += pos.count;
    const idx = g.getIndex();
    indexCount += idx ? idx.count : pos.count;
  }
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const indices = new Uint16Array(indexCount);
  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const pos = g.getAttribute("position");
    const nrm = g.getAttribute("normal");
    positions.set((pos.array as Float32Array).subarray(0, pos.count * 3), vOff * 3);
    if (nrm) normals.set((nrm.array as Float32Array).subarray(0, nrm.count * 3), vOff * 3);
    const idx = g.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices[iOff + i] = vOff + idx.getX(i);
      iOff += idx.count;
    } else {
      for (let i = 0; i < pos.count; i++) indices[iOff + i] = vOff + i;
      iOff += pos.count;
    }
    vOff += pos.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

export class ArrowVolley {
  readonly group = new THREE.Group();
  private maxArrows: number;
  private shaftGeo: THREE.BufferGeometry;
  private fallMesh: THREE.InstancedMesh;
  private stuckMesh: THREE.InstancedMesh;
  private shaftMat: THREE.MeshStandardMaterial;
  private stuckMat: THREE.MeshStandardMaterial;
  private arrows: FallingArrow[] = [];
  private dummy = new THREE.Object3D();
  private up = new THREE.Vector3(0, 1, 0);
  private static scratchDir = new THREE.Vector3();

  // Signal arrow (flies up) + its billboard ribbon.
  readonly signal = new THREE.Group();
  private signalMat: THREE.MeshBasicMaterial;
  private headMat: THREE.MeshBasicMaterial;

  constructor(colors: VolleyColors, maxArrows = 72, maxStuck = 20) {
    this.maxArrows = maxArrows;
    this.shaftGeo = createArrowShaftGeometry();

    this.shaftMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors.shaft),
      emissive: new THREE.Color(colors.head),
      emissiveIntensity: 0.9,
      roughness: 0.5,
      metalness: 0.2,
      transparent: true,
      opacity: 1,
    });
    this.fallMesh = new THREE.InstancedMesh(this.shaftGeo, this.shaftMat, maxArrows);
    this.fallMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fallMesh.count = 0;
    this.fallMesh.frustumCulled = false;
    this.group.add(this.fallMesh);

    this.stuckMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors.shaft),
      emissive: new THREE.Color(colors.head),
      emissiveIntensity: 0.6,
      roughness: 0.6,
      metalness: 0.15,
      transparent: true,
      opacity: 1,
    });
    this.stuckMesh = new THREE.InstancedMesh(this.shaftGeo, this.stuckMat, maxStuck);
    this.stuckMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.stuckMesh.count = 0;
    this.stuckMesh.frustumCulled = false;
    this.group.add(this.stuckMesh);

    for (let i = 0; i < maxArrows; i++) {
      this.arrows.push({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        landed: false,
        life: 0,
      });
    }

    // Signal arrow: a scaled-up single arrow node (gold), oriented +Z.
    this.signalMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.shaft) });
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colors.head) });
    const sShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6),
      this.signalMat,
    );
    sShaft.rotation.x = Math.PI / 2;
    const sHead = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.22, 8), this.headMat);
    sHead.rotation.x = Math.PI / 2;
    sHead.position.z = 0.52;
    this.signal.add(sShaft, sHead);
    this.signal.visible = false;
    this.group.add(this.signal);
  }

  /** Place + show the signal arrow flying along `dir` from `pos`. */
  setSignal(pos: THREE.Vector3, dir: THREE.Vector3, visible: boolean): void {
    this.signal.visible = visible;
    if (!visible) return;
    this.signal.position.copy(pos);
    const d = dir.clone();
    if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
    d.normalize();
    this.signal.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
  }

  /**
   * Spawn a volley of falling arrows over a circular zone. Arrows start high
   * above the zone and streak down at a steep angle with slight jitter.
   */
  spawnVolley(
    centre: THREE.Vector3,
    radius: number,
    count: number,
    groundY: (x: number, z: number) => number,
  ): void {
    let spawned = 0;
    for (let i = 0; i < this.arrows.length && spawned < count; i++) {
      const a = this.arrows[i];
      if (a.active) continue;
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const tx = centre.x + Math.cos(ang) * r;
      const tz = centre.z + Math.sin(ang) * r;
      const ty = groundY(tx, tz);
      // Steep incoming angle: small lateral offset over the drop height.
      const h = 9 + Math.random() * 2.5;
      const lateral = (Math.random() - 0.5) * 1.6;
      const lateral2 = (Math.random() - 0.5) * 1.6;
      a.pos.set(tx + lateral, ty + h, tz + lateral2);
      const fall = new THREE.Vector3(tx - a.pos.x, ty - a.pos.y, tz - a.pos.z);
      const t = 0.42 + Math.random() * 0.08; // seconds to impact
      a.vel.copy(fall).multiplyScalar(1 / t);
      a.active = true;
      a.landed = false;
      a.life = 0;
      spawned++;
    }
  }

  /** Plant a ring of stuck perimeter arrows around the zone (the "trap"). */
  setPerimeter(
    centre: THREE.Vector3,
    radius: number,
    count: number,
    groundY: (x: number, z: number) => number,
  ): void {
    for (let i = 0; i < count; i++) {
      const ang = (i / count) * Math.PI * 2;
      const x = centre.x + Math.cos(ang) * radius;
      const z = centre.z + Math.sin(ang) * radius;
      const y = groundY(x, z);
      // Stuck at a slight outward lean.
      const lean = new THREE.Vector3(Math.cos(ang) * 0.35, 1, Math.sin(ang) * 0.35).normalize();
      this.dummy.position.set(x, y + 0.28, z);
      this.dummy.quaternion.setFromUnitVectors(this.up, lean);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.stuckMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.stuckMesh.count = count;
    this.stuckMesh.instanceMatrix.needsUpdate = true;
  }

  /** Global opacity for the fade-out. */
  setFade(f: number): void {
    this.shaftMat.opacity = f;
    this.stuckMat.opacity = f;
    (this.signalMat as THREE.MeshBasicMaterial).opacity = f;
    (this.headMat as THREE.MeshBasicMaterial).opacity = f;
    this.signalMat.transparent = true;
    this.headMat.transparent = true;
  }

  /**
   * Advance falling arrows. `onLand(pos)` is called once per arrow the frame it
   * hits the ground (for dust/spark bursts). Returns nothing.
   */
  update(
    dt: number,
    groundY: (x: number, z: number) => number,
    onLand?: (pos: THREE.Vector3) => void,
  ): void {
    let count = 0;
    for (let i = 0; i < this.arrows.length; i++) {
      const a = this.arrows[i];
      if (!a.active) continue;
      if (!a.landed) {
        a.vel.y -= 9 * dt; // slight gravity accent
        a.pos.addScaledVector(a.vel, dt);
        const floor = groundY(a.pos.x, a.pos.z);
        if (a.pos.y <= floor + 0.02) {
          a.pos.y = floor + 0.02;
          a.landed = true;
          a.life = 0;
          if (onLand) onLand(a.pos.clone());
        }
      } else {
        a.life += dt;
        if (a.life > 0.9) {
          a.active = false;
          continue;
        }
      }
      // Orient the shaft along its velocity (or straight up once stuck).
      // Scratch vector: up to 48 airborne arrows per 1/120s step — no clones.
      const dir = a.landed
        ? this.up
        : ArrowVolley.scratchDir.copy(a.vel).normalize();
      this.dummy.position.copy(a.pos);
      this.dummy.quaternion.setFromUnitVectors(this.up, dir);
      this.dummy.scale.set(1, 1, 1);
      this.dummy.updateMatrix();
      this.fallMesh.setMatrixAt(count, this.dummy.matrix);
      count++;
      if (count >= this.maxArrows) break;
    }
    this.fallMesh.count = count;
    this.fallMesh.instanceMatrix.needsUpdate = true;
  }

  /** Any falling arrows still airborne or fading? */
  get busy(): boolean {
    return this.arrows.some((a) => a.active);
  }

  dispose(): void {
    this.fallMesh.dispose();
    this.stuckMesh.dispose();
    this.shaftGeo.dispose();
    this.shaftMat.dispose();
    this.stuckMat.dispose();
    this.signalMat.dispose();
    this.headMat.dispose();
    this.signal.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }
}

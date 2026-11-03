// The beach. World units are metres; the camera sits near the origin looking down -z
// (toward the sunset and the sea), so "d" (distance ahead) is -z and x is sideways.
// The shoreline and seabed are analytic so the ocean shader can use the same shape.
import * as THREE from 'three';
import { Noise2D, type Rng, clamp, lerp, range, smoothstep } from './rng';
import { cloudNoise } from './noise';
import { COMMON_GLSL, NOISE_GLSL, shared } from './shared';

type RGB = [number, number, number];

/** A regular heightfield grid for fast bilinear lookups. */
export class Grid {
  readonly data: Float32Array;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly x1: number,
    readonly z1: number,
    readonly nx: number,
    readonly nz: number,
  ) {
    this.data = new Float32Array(nx * nz);
  }
  fill(fn: (x: number, z: number) => number) {
    for (let j = 0; j < this.nz; j++) {
      const z = this.z0 + ((this.z1 - this.z0) * j) / (this.nz - 1);
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + ((this.x1 - this.x0) * i) / (this.nx - 1);
        this.data[j * this.nx + i] = fn(x, z);
      }
    }
  }
  contains(x: number, z: number) {
    return x >= this.x0 && x <= this.x1 && z >= this.z0 && z <= this.z1;
  }
  sample(x: number, z: number): number {
    const fx = clamp(((x - this.x0) / (this.x1 - this.x0)) * (this.nx - 1), 0, this.nx - 1.001);
    const fz = clamp(((z - this.z0) / (this.z1 - this.z0)) * (this.nz - 1), 0, this.nz - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const d = this.data;
    const k = j * this.nx + i;
    return lerp(lerp(d[k], d[k + 1], tx), lerp(d[k + this.nx], d[k + this.nx + 1], tx), tz);
  }
}

/** Shoreline and seabed shape, shared with the ocean shader. */
export interface Shore {
  /** Mean distance (m) from the camera to the waterline. */
  dist: number;
  a1: number;
  l1: number;
  p1: number;
  a2: number;
  l2: number;
  p2: number;
  /** Slope of the wet foreshore (rise per metre). */
  foreshore: number;
  /** Dean profile coefficient: depth = seabed * u^(2/3). Bigger means a steeper beach. */
  seabed: number;
}

/** Depth the seabed levels off toward (m). */
export const MAX_DEPTH = 60;

export function shoreline(s: Shore, x: number): number {
  return s.dist + s.a1 * Math.sin(x / s.l1 + s.p1) + s.a2 * Math.sin(x / s.l2 + s.p2);
}

/** Water depth (m) at offshore distance u (m): an equilibrium (Dean) profile, levelling off. */
export function seabedDepth(s: Shore, u: number): number {
  const d = s.seabed * Math.pow(Math.max(u, 0), 2 / 3);
  return d / (1 + d / MAX_DEPTH);
}

/** GLSL matching shoreline() and seabedDepth(). Needs uniforms uShoreA, uShoreB, uShoreC. */
export const SHORE_GLSL = /* glsl */ `
uniform vec4 uShoreA; // dist, a1, l1, p1
uniform vec4 uShoreB; // a2, l2, p2, foreshore
uniform vec4 uShoreC; // Dean coefficient, max depth, max runup, unused
float shoreDist(float x) {
  return uShoreA.x + uShoreA.y * sin(x / uShoreA.z + uShoreA.w) + uShoreB.x * sin(x / uShoreB.y + uShoreB.z);
}
// Offshore distance from the waterline (negative on the beach).
float offshore(vec2 xz) { return -xz.y - shoreDist(xz.x); }
float seabedDepth(float u) {
  float d = uShoreC.x * pow(max(u, 0.0), 2.0 / 3.0);
  return d / (1.0 + d / uShoreC.y);
}
// Sand height near the waterline (no dunes or headland).
float sandHeight(float u) { return u > 0.0 ? -seabedDepth(u) : -u * uShoreB.w; }

// Swash: after each wave reaches the beach, a thin sheet runs up the sand and back.
// The ocean draws the sheet and the sand shades where it has been, so both use these.
uniform vec4 uSwashA;       // main swell: omega, alongshore k, phase, unused
uniform vec4 uSwashB;       // group swell: omega, alongshore k, unused, unused
uniform sampler2D uFoamTex; // tiling noise
// Continuous count of swashes at x: the integer part numbers each swash, the fraction is
// its phase. Different stretches of beach are reached at slightly different moments.
float swashOffset(float x) { return (textureLod(uFoamTex, vec2(x / 170.0 + 0.11, 0.37), 0.0).r - 0.5) * 0.12; }
float swashCount(float x, float t) {
  float th = uSwashA.y * x - uSwashA.x * t + uSwashA.z;
  return (1.5708 - th) / 6.2832 + swashOffset(x);
}
// Fraction of its full reach a swash covers at phase psi: up to 0.3, back by 0.92.
float swashRise(float psi) {
  return psi < 0.3 ? sin(psi / 0.3 * 1.5708) : (psi < 0.92 ? pow(1.0 - (psi - 0.3) / 0.62, 1.6) : 0.0);
}
// How far up the beach (m) swash n runs at x. Each swash keeps its shape while it runs:
// broad lobes, narrower tongues, small fingers, and the scalloped rhythm of beach cusps.
// Bigger wave groups run further.
float swashReach(float x, float n) {
  float wPeak = 6.2832 * (n + 0.3 - swashOffset(x)) - 1.5708 + uSwashA.y * x + uSwashA.z;
  float group = 0.65 + 0.35 * sin(uSwashB.y * x * 0.5 - (uSwashB.x / uSwashA.x - 1.0) * wPeak + 1.3);
  vec4 nA = textureLod(uFoamTex, vec2(x / 45.0 + n * 0.618, n * 0.37), 0.0);
  vec4 nB = textureLod(uFoamTex, vec2(x / 11.0 - n * 0.41, 0.53 + n * 0.29), 0.0);
  float lobes = 0.4 + 0.9 * clamp((nA.g - 0.3) / 0.45, 0.0, 1.0);
  float tongues = 0.75 + 0.5 * clamp((nB.g - 0.3) / 0.45, 0.0, 1.0);
  float fingers = 1.0 + 0.8 * (textureLod(uFoamTex, vec2(x / 40.0 + n * 0.29, 0.21 + n * 0.53), 0.0).a - 0.5);
  float cusps = 1.0 + 0.14 * sin(x * 6.2832 / 26.0 + 1.7 + 0.6 * sin(x / 61.0));
  return uShoreC.z * group * lobes * tongues * fingers * cusps / uShoreB.w;
}
// How far up the beach (m) the water's edge sits between swashes: the backwash and the
// next bore keep a shallow, ragged margin of water over the sand that wanders slowly,
// so the sea never ends along the bare still-water line.
float swashBase(float x, float t) {
  float a = textureLod(uFoamTex, vec2(x / 23.0 + t * 0.006, 0.83 + t * 0.011), 0.0).g;
  float b = textureLod(uFoamTex, vec2(x / 5.0 - t * 0.017, 0.17 + t * 0.023), 0.0).b;
  return uShoreC.z / uShoreB.w * (0.04 + 0.22 * clamp(a * 1.6 - 0.4, 0.0, 1.0) + 0.06 * b);
}
`;

export function shoreUniforms(s: Shore, maxRunup: number) {
  return {
    uShoreA: { value: new THREE.Vector4(s.dist, s.a1, s.l1, s.p1) },
    uShoreB: { value: new THREE.Vector4(s.a2, s.l2, s.p2, s.foreshore) },
    uShoreC: { value: new THREE.Vector4(s.seabed, MAX_DEPTH, maxRunup, 0) },
    uSwashA: { value: new THREE.Vector4() },
    uSwashB: { value: new THREE.Vector4() },
    uFoamTex: { value: cloudNoise().tex2 },
  };
}

/**
 * CPU twin of the swash functions in SHORE_GLSL, for things on the beach that have to
 * keep out of the water. Reads the same noise texture and swell timing the shaders do.
 */
export class SwashEdge {
  private tex: Uint8Array;
  constructor(
    private shore: Shore,
    private maxRunup: number,
    private swash: { a: THREE.Vector4; b: THREE.Vector4 },
  ) {
    this.tex = cloudNoise().tex2.image.data as Uint8Array;
  }

  /** Bilinear, repeating lookup of one channel of the foam texture, like textureLod(..., 0). */
  private foam(u: number, v: number, c: number): number {
    const N = 256;
    const fx = u * N - 0.5;
    const fy = v * N - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const w = (k: number) => ((k % N) + N) % N;
    const i0 = w(i), i1 = w(i + 1), j0 = w(j), j1 = w(j + 1);
    const d = this.tex;
    const at = (x: number, y: number) => d[(y * N + x) * 4 + c];
    return lerp(lerp(at(i0, j0), at(i1, j0), tx), lerp(at(i0, j1), at(i1, j1), tx), ty) / 255;
  }

  private offset(x: number) {
    return (this.foam(x / 170 + 0.11, 0.37, 0) - 0.5) * 0.12;
  }

  private count(x: number, t: number) {
    const a = this.swash.a;
    return (1.5708 - (a.y * x - a.x * t + a.z)) / 6.2832 + this.offset(x);
  }

  private static rise(psi: number) {
    return psi < 0.3 ? Math.sin((psi / 0.3) * 1.5708) : psi < 0.92 ? Math.pow(1 - (psi - 0.3) / 0.62, 1.6) : 0;
  }

  private reach(x: number, n: number) {
    const { a, b } = this.swash;
    const wPeak = 6.2832 * (n + 0.3 - this.offset(x)) - 1.5708 + a.y * x + a.z;
    const group = 0.65 + 0.35 * Math.sin(b.y * x * 0.5 - (b.x / a.x - 1) * wPeak + 1.3);
    const lobes = 0.4 + 0.9 * clamp((this.foam(x / 45 + n * 0.618, n * 0.37, 1) - 0.3) / 0.45, 0, 1);
    const tongues = 0.75 + 0.5 * clamp((this.foam(x / 11 - n * 0.41, 0.53 + n * 0.29, 1) - 0.3) / 0.45, 0, 1);
    const fingers = 1 + 0.8 * (this.foam(x / 40 + n * 0.29, 0.21 + n * 0.53, 3) - 0.5);
    const cusps = 1 + 0.14 * Math.sin((x * 6.2832) / 26 + 1.7 + 0.6 * Math.sin(x / 61));
    return (this.maxRunup * group * lobes * tongues * fingers * cusps) / this.shore.foreshore;
  }

  private base(x: number, t: number) {
    const a = this.foam(x / 23 + t * 0.006, 0.83 + t * 0.011, 1);
    const b = this.foam(x / 5 - t * 0.017, 0.17 + t * 0.023, 2);
    return (this.maxRunup / this.shore.foreshore) * (0.04 + 0.22 * clamp(a * 1.6 - 0.4, 0, 1) + 0.06 * b);
  }

  /** How far up the beach (m from the still-water line) the water reaches at x, time t. */
  at(x: number, t: number): number {
    const cnt = this.count(x, t);
    const n = Math.floor(cnt);
    return Math.max(this.reach(x, n) * SwashEdge.rise(cnt - n), this.base(x, t));
  }
}

const mix3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const srgb = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

const SAND = srgb(0xc9b28f);
const DRY_GRASS = srgb(0x9a8a55);
const GRASS = srgb(0x55613a);
const ROCK = srgb(0x6e6660);
const DARK_ROCK = srgb(0x4a4440);
const SCRUB = srgb(0x7a7350);

export class Terrain {
  readonly noise: Noise2D;
  readonly shore: Shore;
  readonly near: Grid;
  readonly far: Grid;
  readonly cameraGround: number;
  readonly mesh: THREE.Mesh;
  readonly haze: number;
  private heightFn: (x: number, z: number) => number;

  constructor(rng: Rng, readonly sunAz: THREE.Vector2, maxRunup: number) {
    this.noise = new Noise2D(rng);
    const n = this.noise;
    this.shore = {
      dist: 0,
      a1: range(rng, 4, 12),
      l1: range(rng, 60, 140),
      p1: range(rng, 0, 6.28),
      a2: range(rng, 1, 3),
      l2: range(rng, 18, 40),
      p2: range(rng, 0, 6.28),
      foreshore: range(rng, 0.05, 0.08),
      seabed: range(rng, 0.22, 0.32),
    };
    // Anchor the waterline straight ahead of the camera, wherever the curves put it elsewhere.
    this.shore.dist = range(rng, 22, 32) - (shoreline(this.shore, 0) - this.shore.dist);
    this.haze = range(rng, 1.6, 3.0);
    const shore = this.shore;

    // A rocky headland reaching out to sea on one side, and sometimes a far island.
    const side = rng() < 0.5 ? -1 : 1;
    const headW = range(rng, 260, 900);
    const headSlope = range(rng, 0.15, 0.6);
    const headEnd = range(rng, 1500, 6000);
    const headH = range(rng, 40, 160);
    const island = rng() < 0.5;
    const ix = range(rng, -6000, 6000);
    const id = range(rng, 9000, 18000);
    const ir = range(rng, 800, 2000);
    const ih = range(rng, 120, 400);
    const duneH = range(rng, 2.5, 5);

    this.heightFn = (x, z) => {
      const d = -z;
      const u = d - shoreline(shore, x);
      let h: number;
      if (u >= 0) {
        h = -seabedDepth(shore, u);
      } else {
        // Wet foreshore, then a gentler dry beach rising to dunes behind the camera.
        const w = -u;
        h = Math.min(w, 22) * shore.foreshore + Math.max(w - 22, 0) * 0.02;
        h += 0.12 * n.fbm(x / 7, z / 7, 2) * smoothstep(25, 40, w);
        h += duneH * smoothstep(-8, -40, d) * (0.6 + 0.4 * n.fbm(x / 60, z / 60, 3));
      }
      const hu = side * x - (headW + d * headSlope);
      const mask = smoothstep(-40, 220, hu) * (1 - smoothstep(headEnd * 0.7, headEnd, d));
      if (mask > 0) {
        const hh = headH * (0.55 + 0.45 * n.ridged(x / 700, z / 700, 6)) * smoothstep(0, 0.35, mask);
        h = Math.max(h, hh * mask - 4 * (1 - mask));
      }
      if (island) {
        const ex = (x - ix) / ir;
        const ed = (d - id) / (ir * 0.6);
        const e = Math.sqrt(ex * ex + ed * ed) + 0.25 * n.fbm(x / 900, z / 900, 3);
        if (e < 1) h = Math.max(h, ih * smoothstep(1, 0.25, e) * (0.6 + 0.4 * n.ridged(x / 900, z / 900, 5)) - 5);
      }
      return h;
    };

    this.near = new Grid(-1600, -3200, 1600, 200, 320, 320);
    this.near.fill((x, z) => this.height(x, z));
    this.far = new Grid(-50000, -90000, 50000, 2000, 320, 320);
    this.far.fill((x, z) => this.height(x, z));
    this.cameraGround = Math.max(this.height(0, 0), 0.5);
    this.mesh = this.buildMesh(maxRunup);
  }

  height(x: number, z: number): number {
    return this.heightFn(x, z);
  }

  sampleHeight(x: number, z: number): number {
    return this.near.contains(x, z) ? this.near.sample(x, z) : this.far.sample(x, z);
  }

  /** Elevation angle of the terrain horizon seen from (x, y, z) toward the setting sun. */
  horizonAngle(x: number, y: number, z: number): number {
    const az = this.sunAz;
    let best = -0.2;
    for (let t = 6; t < 70000; t *= 1.16) {
      const h = Math.max(this.sampleHeight(x + az.x * t, z + az.y * t), 0) - (t * t) / (2 * 6371000);
      const a = (h - y) / t;
      if (a > best) best = a;
    }
    return Math.atan(best);
  }

  private color(z: number, h: number, slope: number): RGB {
    if (h > 6) return mix3(mix3(SCRUB, GRASS, 0.5), mix3(ROCK, DARK_ROCK, 0.5), smoothstep(0.25, 0.55, slope));
    let c = SAND;
    if (-z < this.shore.dist * 0.3) c = mix3(c, DRY_GRASS, 0.35 * smoothstep(1.5, 3.5, h));
    return mix3(c, mix3(ROCK, DARK_ROCK, 0.5), smoothstep(0.35, 0.6, slope));
  }

  private buildMesh(maxRunup: number): THREE.Mesh {
    const NA = 360;
    const NR = 340;
    const A0 = (-88 * Math.PI) / 180;
    const A1 = (88 * Math.PI) / 180;
    const R0 = 1.2;
    const R1 = 90000;
    const k = Math.log(R1 / R0) / (NR - 1);
    const count = NA * NR;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const hor = new Float32Array(count);
    // The beach meets the seabed in a sharp corner at the waterline. A triangle spanning
    // it would sag a few centimetres below the sand, enough for a grazing line of sight to
    // slip under the beach and see the seabed through the thin water, so each column of
    // the grid gets a vertex exactly on the waterline.
    const ringR = (j: number) => R0 * Math.exp(k * j);
    const snapJ = new Int32Array(NA).fill(-1);
    const snapR = new Float32Array(NA);
    for (let i = 0; i < NA; i++) {
      const a = A0 + ((A1 - A0) * i) / (NA - 1);
      const uAt = (r: number) => Math.cos(a) * r - shoreline(this.shore, Math.sin(a) * r);
      for (let j = 1; j < NR; j++) {
        let lo = ringR(j - 1);
        let hi = ringR(j);
        if (!(uAt(lo) < 0 && uAt(hi) >= 0)) continue;
        snapJ[i] = -uAt(lo) < uAt(hi) ? j - 1 : j;
        for (let it = 0; it < 30; it++) {
          const mid = (lo + hi) / 2;
          if (uAt(mid) < 0) lo = mid;
          else hi = mid;
        }
        snapR[i] = (lo + hi) / 2;
        break;
      }
    }
    for (let j = 0; j < NR; j++) {
      for (let i = 0; i < NA; i++) {
        const a = A0 + ((A1 - A0) * i) / (NA - 1);
        const r = snapJ[i] === j ? snapR[i] : ringR(j);
        const x = Math.sin(a) * r;
        const z = -Math.cos(a) * r;
        const v = j * NA + i;
        pos[v * 3] = x;
        pos[v * 3 + 1] = this.height(x, z);
        pos[v * 3 + 2] = z;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const idx: number[] = [];
    for (let j = 0; j < NR - 1; j++) {
      for (let i = 0; i < NA - 1; i++) {
        const a = j * NA + i;
        const b = a + 1;
        const c = a + NA;
        const d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let v = 0; v < count; v++) {
      const y = pos[v * 3 + 1];
      const z = pos[v * 3 + 2];
      const c = this.color(z, y, 1 - nrm.getY(v));
      col[v * 3] = c[0];
      col[v * 3 + 1] = c[1];
      col[v * 3 + 2] = c[2];
      hor[v] = this.horizonAngle(pos[v * 3], y + 0.5, z);
    }
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aHorizon', new THREE.BufferAttribute(hor, 1));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, terrainMaterial(this.shore, maxRunup));
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Swell timing from the ocean, so the sand shades where the swash has been. */
  setSwash(swash: { a: THREE.Vector4; b: THREE.Vector4 }) {
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uSwashA.value.copy(swash.a);
    u.uSwashB.value.copy(swash.b);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function terrainMaterial(shore: Shore, maxRunup: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, ...shoreUniforms(shore, maxRunup) },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aHorizon;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vHorizon;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normal;
        vColor = aColor;
        vHorizon = aHorizon;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${NOISE_GLSL}
      ${SHORE_GLSL}
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying float vHorizon;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorld);
        float dist = length(vWorld - cameraPosition);
        float detail = 1.0;
        if (dist < 600.0) {
          float g = snoise(vWorld.xz * 0.35) * 0.5 + snoise(vWorld.xz * 1.7) * 0.3 + snoise(vWorld.xz * 0.05) * 0.4;
          detail = mix(1.0 + 0.16 * g, 1.0, smoothstep(80.0, 600.0, dist));
        }
        vec3 albedo = vColor * detail;

        // Underwater sand is dark; sand up to the highest run-up stays damp.
        float u = offshore(vWorld.xz);
        float upB = -u; // metres up the beach from still water
        float reached = 1.0 - smoothstep(uShoreC.z, uShoreC.z + 0.3, vWorld.y);
        reached *= 1.0 - smoothstep(-30.0, 0.0, upB - 60.0);
        float wet = max(step(0.0, u + swashBase(vWorld.x, uTime)), reached * mix(0.3, 0.8, smoothstep(250.0, 450.0, dist)));

        // Where recent swashes have been. Sand a swash covered is saturated; once the
        // water drains off, a glassy film lingers a few seconds and breaks into streaks
        // running back down the slope, while the darkness fades slowly as the water soaks
        // in. Foam is stranded along each swash's highest reach, and water lingers in hollows.
        float sheen = 0.0;
        float stranded = 0.0;
        if (u < 0.5 && upB < uShoreC.z * 2.4 / uShoreB.w && dist < 450.0) {
          float cnt = swashCount(vWorld.x, uTime);
          float sw = floor(cnt);
          float psi = cnt - sw;
          float T = 6.2832 / uSwashA.x;
          // Drainage rills: noise stretched down the slope, drying from the troughs out.
          float rill = 0.5 + (textureLod(uFoamTex, vec2(vWorld.x / 3.0, upB / 30.0), 0.0).r - 0.5) * 1.4
            + (textureLod(uFoamTex, vec2(vWorld.x / 1.1, upB / 9.0 + 0.4), 0.0).b - 0.5) * 0.9;
          // Shallow hollows hold a skin of water for a while after the swash leaves.
          const mat2 RH = mat2(0.8, 0.6, -0.6, 0.8);
          float hollow = smoothstep(0.58, 0.68, textureLod(uFoamTex, RH * vWorld.xz / 7.0 + 0.27, 0.0).g) * 0.8;
          // Patches that hold their water a little longer or shorter than their neighbours.
          float patchy = clamp(textureLod(uFoamTex, RH * vWorld.xz / 1.7 + 0.41, 0.0).r * 0.7 + rill * 0.3, 0.0, 1.0);
          for (int k = 0; k < 4; k++) {
            float R = swashReach(vWorld.x, sw - float(k));
            float tk = psi + float(k); // swashes since swash sw-k began
            float f = max(upB, 0.0) / max(R, 0.01);
            // The oldest swash fades out before it drops off the end of the history.
            float keep = k == 3 ? 1.0 - psi : 1.0;
            if (f < 1.0) {
              // Inverse of swashRise: when the uprush arrived here, and when it left.
              float psiUp = asin(f) / 1.5708 * 0.3;
              float psiDown = 0.3 + 0.62 * (1.0 - pow(f, 0.625));
              float a = tk >= psiDown ? (tk - psiDown) * T : (tk >= psiUp ? 0.0 : 1e4);
              // The last few tens of centimetres of a swash only dampen the sand.
              float edge = 1.0 - smoothstep(R - 0.6, R, upB);
              // Soaking in: the glassy skin goes first where the sheet was thinnest, near
              // the top of the run-up, winking out patch by patch down the slope; the
              // darkness follows more slowly, drying from the top down too.
              float shineFor = mix(5.0, 1.2, f) * (0.4 + 1.2 * patchy);
              float dryFor = mix(30.0, 9.0, f) * (0.7 + 0.6 * patchy);
              wet = max(wet, mix(0.5, 1.0, edge) * (1.0 - smoothstep(0.15 * dryFor, dryFor, a)) * keep);
              float film = max(edge * (1.0 - smoothstep(0.55 * shineFor, shineFor, a)), hollow * exp(-a / 25.0));
              sheen = max(sheen, film * keep);
            }
            // Foam left along the top of the run-up as the water turned back.
            if (tk > 0.3) {
              float line = smoothstep(R - 0.9, R - 0.15, upB) * (1.0 - smoothstep(R - 0.15, R + 0.05, upB));
              stranded = max(stranded, line * smoothstep(0.3, 0.45, tk) * exp(-(tk - 0.3) * T / 7.0) * keep);
            }
          }
          float speck = textureLod(uFoamTex, RH * vWorld.xz / 1.9 + 0.61, 0.0).g;
          stranded *= smoothstep(0.35, 0.6, speck * 0.7 + stranded * 0.4);
        }
        albedo *= mix(1.0, 0.55, wet);
        albedo = mix(albedo, vec3(0.88, 0.87, 0.85), stranded * 0.85);

        float sunEl = asin(clamp(uSunDir.y, -1.0, 1.0));
        float vis = smoothstep(vHorizon - 0.004, vHorizon + 0.006, sunEl);
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 col = albedo * (uSunColor * ndl * vis + ambientLight(n));

        // Wet sand reflects a little sky at grazing angles; the draining film is a mirror
        // for the sky and sun, roughening as it thins.
        float shine = max(sheen, wet * 0.25);
        if (shine > 0.01 && vWorld.y > -0.3) {
          float rough = mix(0.03, 0.003, sheen);
          vec2 ws = (textureLod(uFoamTex, vWorld.xz / 5.0 + 0.33, 0.0).rb - 0.5) * 4.0;
          vec3 wn = normalize(vec3(ws.x * rough, 1.0, ws.y * rough));
          vec3 R = reflect(-V, wn);
          float F = 0.02 + 0.98 * pow(1.0 - max(dot(wn, V), 0.0), 5.0);
          float glint = exp(-(1.0 - max(dot(R, uSunDir), 0.0)) / mix(0.004, 0.0008, sheen));
          vec3 g = uSunColor * vis * glint * 1.5;
          float gm = max(g.r, max(g.g, g.b)) * uExposure;
          g *= gm > 8.0 ? 8.0 / gm : 1.0;
          col = mix(col, skyReflection(R) * 0.8 + g, shine * F);
        }
        col = applyAtmosphere(col, vWorld);
        gl_FragColor = vec4(col * uExposure, 1.0);
      }`,
  });
}

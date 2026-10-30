// The beach. World units are metres; the camera sits near the origin looking down -z
// (toward the sunset and the sea), so "d" (distance ahead) is -z and x is sideways.
// The shoreline and seabed are analytic so the ocean shader can use the same shape.
import * as THREE from 'three';
import { Noise2D, type Rng, clamp, lerp, range, smoothstep } from './rng';
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
`;

export function shoreUniforms(s: Shore, maxRunup: number) {
  return {
    uShoreA: { value: new THREE.Vector4(s.dist, s.a1, s.l1, s.p1) },
    uShoreB: { value: new THREE.Vector4(s.a2, s.l2, s.p2, s.foreshore) },
    uShoreC: { value: new THREE.Vector4(s.seabed, MAX_DEPTH, maxRunup, 0) },
  };
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
    for (let j = 0; j < NR; j++) {
      const r = R0 * Math.exp(k * j);
      for (let i = 0; i < NA; i++) {
        const a = A0 + ((A1 - A0) * i) / (NA - 1);
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

        // Sand the swash reaches is darker and glassy; underwater sand is darker still.
        float wet = 1.0 - smoothstep(uShoreC.z, uShoreC.z + 0.3, vWorld.y);
        wet *= 1.0 - smoothstep(-30.0, 0.0, -offshore(vWorld.xz) - 60.0);
        albedo *= mix(1.0, 0.55, wet);

        float sunEl = asin(clamp(uSunDir.y, -1.0, 1.0));
        float vis = smoothstep(vHorizon - 0.004, vHorizon + 0.006, sunEl);
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 col = albedo * (uSunColor * ndl * vis + ambientLight(n));

        // Only the strip the last swash just left is glassy; higher up it is merely damp.
        float glassy = wet * (1.0 - smoothstep(uShoreC.z * 0.15, uShoreC.z * 0.5, vWorld.y)) * 0.6;
        if (glassy > 0.01 && vWorld.y > -0.3) {
          vec3 wn = normalize(vec3(snoise(vWorld.xz * 0.8) * 0.012, 1.0, snoise(vWorld.xz * 0.8 + 7.0) * 0.012));
          vec3 R = reflect(-V, wn);
          float F = 0.02 + 0.98 * pow(1.0 - max(dot(wn, V), 0.0), 5.0);
          float glint = exp(-(1.0 - max(dot(R, uSunDir), 0.0)) / 0.0015);
          vec3 g = uSunColor * vis * glint * 1.5;
          float gm = max(g.r, max(g.g, g.b)) * uExposure;
          g *= gm > 8.0 ? 8.0 / gm : 1.0;
          col += glassy * F * (skyReflection(R) * 0.7 + g);
        }
        col = applyAtmosphere(col, vWorld);
        gl_FragColor = vec4(col * uExposure, 1.0);
      }`,
  });
}

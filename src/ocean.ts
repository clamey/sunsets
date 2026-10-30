// The ocean: a displaced surface made of swell trains that feel the seabed (they slow,
// bend toward the beach, steepen and break), plus wind chop, whitewater, swash running
// up the sand, sun/moon glitter and light shining through backlit crests.
//
// Swell components are refracted analytically for straight, parallel depth contours:
// the alongshore wavenumber is conserved (Snell's law) and the onshore phase is the
// integral of the local onshore wavenumber, precomputed per component into a table.
import * as THREE from 'three';
import { cloudNoise } from './noise';
import { type Rng, range } from './rng';
import { COMMON_GLSL, NOISE_GLSL, shared } from './shared';
import { SHORE_GLSL, type Shore, seabedDepth, shoreUniforms } from './terrain';

const G = 9.81;
const N_SWELL = 6;
const N_WIND = 12;
/** Table samples along the offshore axis, spaced by sqrt so the surf zone gets detail. */
const NU = 1024;
const UMAX = 3000;
/** Breaking limit: significant height relative to depth. */
const GAMMA = 0.5;
/** How far (m) whitewater lingers shoreward of where it was made. */
const FOAM_DECAY = 45;

export interface SeaState {
  /** Significant wave height arriving from offshore (m). */
  height: number;
  /** Peak period (s). */
  period: number;
  /** Wind-sea significant height (m). */
  windHeight: number;
  whitecaps: number;
}

/** Wavenumber for angular frequency w in depth h (linear dispersion, Newton's method). */
function solveK(w: number, h: number): number {
  let k = (w * w) / G;
  if (h < 1) k = Math.max(k, w / Math.sqrt(G * Math.max(h, 0.05)));
  for (let i = 0; i < 30; i++) {
    const th = Math.tanh(k * h);
    const f = G * k * th - w * w;
    const df = G * th + G * k * h * (1 - th * th);
    const nk = k - f / df;
    if (Math.abs(nk - k) < 1e-7 * k) return nk;
    k = Math.max(nk, 1e-6);
  }
  return k;
}

function groupVelocity(w: number, k: number, h: number): number {
  const kh = Math.min(k * h, 20);
  return 0.5 * (w / k) * (1 + (2 * kh) / Math.sinh(2 * kh));
}

const uAt = (j: number) => UMAX * Math.pow(j / (NU - 1), 2);

/** Runup height (m above still water) of the biggest swashes, after Stockdon-style scaling. */
export function maxRunup(sea: SeaState): number {
  const L0 = (G * sea.period * sea.period) / (2 * Math.PI);
  return 0.05 * Math.sqrt(sea.height * L0) + 0.06;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  private table: THREE.DataTexture;

  constructor(rng: Rng, shore: Shore, sea: SeaState) {
    const swellDir = range(rng, -0.3, 0.3);
    const periods = [0.84, 0.93, 1.0, 1.03, 1.1, 1.22].map((f) => f * sea.period);
    // Crossing directions make crests interfere into peaks and lulls along the beach.
    const dirs = [-16, -7, 0, 5, 12, 21].map((d) => swellDir + (d * Math.PI) / 180);
    const weights = [0.55, 0.85, 1.0, 0.9, 0.7, 0.45];
    const norm = Math.sqrt(weights.reduce((s, w) => s + w * w, 0) / 2);
    const amps = weights.map((w) => (w * sea.height) / 4 / norm);

    // Per component: deep-water reference taken at the far end of the table.
    const hEnd = seabedDepth(shore, UMAX);
    const data = new Float32Array(NU * (N_SWELL + 1) * 4);
    const swellU: THREE.Vector4[] = [];
    const hsUnc = new Float32Array(NU);
    for (let i = 0; i < N_SWELL; i++) {
      const w = (2 * Math.PI) / periods[i];
      const kEnd = solveK(w, hEnd);
      const kt = kEnd * Math.sin(dirs[i]);
      const cgEnd = groupVelocity(w, kEnd, hEnd);
      const cosEnd = Math.cos(dirs[i]);
      let phi = 0;
      let prevU = 0;
      let prevKn = 0;
      for (let j = 0; j < NU; j++) {
        const u = uAt(j);
        const h = Math.max(seabedDepth(shore, u), 0.05);
        const k = solveK(w, h);
        const kn = Math.sqrt(Math.max(k * k - kt * kt, (0.05 * k) ** 2));
        if (j > 0) phi += 0.5 * (kn + prevKn) * (u - prevU);
        prevU = u;
        prevKn = kn;
        const shoal = Math.sqrt(cgEnd / groupVelocity(w, k, h));
        const refr = Math.sqrt(cosEnd / (kn / k));
        const a = amps[i] * shoal * refr;
        const o = (i * NU + j) * 4;
        data[o] = phi;
        data[o + 1] = a;
        data[o + 2] = kn;
        data[o + 3] = k;
        if (i === 2) hsUnc[j] = sea.height * shoal * refr;
      }
      swellU.push(new THREE.Vector4(w, kt, range(rng, 0, Math.PI * 2), prevKn));
    }

    // Breaking: cap height to a fraction of depth, and track where whitewater forms
    // and how it lingers shoreward.
    const summary = N_SWELL * NU * 4;
    let foam = 0;
    for (let j = NU - 1; j >= 0; j--) {
      const h = Math.max(seabedDepth(shore, uAt(j)), 0.02);
      const ratio = hsUnc[j] / (GAMMA * h);
      const scale = Math.min(1, 1 / ratio);
      for (let i = 0; i < N_SWELL; i++) data[(i * NU + j) * 4 + 1] *= scale;
      // Strongest where waves first break; broken bores carry on as trailing foam.
      const breaking = Math.min(1, Math.max(0, (ratio - 0.85) / 0.25)) * (1 - 0.65 * Math.min(1, Math.max(0, (ratio - 1.4) / 1.5)));
      if (j < NU - 1) foam *= Math.exp(-(uAt(j + 1) - uAt(j)) / FOAM_DECAY);
      foam = Math.max(foam, breaking);
      const approach = Math.min(1, Math.max(0, (ratio - 0.55) / 0.45));
      const o = summary + j * 4;
      data[o] = breaking;
      data[o + 1] = foam;
      data[o + 2] = approach;
      data[o + 3] = h;
    }
    this.table = new THREE.DataTexture(data, NU, N_SWELL + 1, THREE.RGBAFormat, THREE.FloatType);
    this.table.minFilter = THREE.NearestFilter;
    this.table.magFilter = THREE.NearestFilter;
    this.table.needsUpdate = true;

    // Wind chop: short deep-water waves, roughly from one direction.
    const windDir = range(rng, -1.2, 1.2);
    const windWaves: THREE.Vector4[] = [];
    const windPhase: number[] = [];
    const wWeights: number[] = [];
    for (let i = 0; i < N_WIND; i++) {
      const T = 0.8 * Math.pow(3.2 / 0.8, i / (N_WIND - 1));
      const dir = windDir + range(rng, -0.8, 0.8);
      const k = (4 * Math.PI * Math.PI) / (G * T * T);
      windWaves.push(new THREE.Vector4(Math.sin(dir), Math.cos(dir), k, Math.pow(T, 1.4)));
      windPhase.push(range(rng, 0, Math.PI * 2));
      wWeights.push(Math.pow(T, 1.4));
    }
    const wNorm = Math.sqrt(wWeights.reduce((s, w) => s + w * w, 0) / 2);
    windWaves.forEach((v, i) => (v.w = (wWeights[i] * sea.windHeight) / 4 / wNorm));

    const { tex2 } = cloudNoise();
    const uniforms = {
      ...shared,
      ...shoreUniforms(shore, maxRunup(sea)),
      uTable: { value: this.table },
      uSwell: { value: swellU },
      uWind: { value: windWaves },
      uWindPhase: { value: windPhase },
      uSea: { value: new THREE.Vector4(sea.height, sea.windHeight, sea.whitecaps, sea.period) },
      uFoamTex: { value: tex2 },
      uSunVis: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: true,
      vertexShader: /* glsl */ `
        ${COMMON_GLSL}
        ${SHORE_GLSL}
        ${OCEAN_GLSL}
        varying vec3 vWorld;
        varying vec2 vRest;
        void main() {
          vec2 xz = (modelMatrix * vec4(position, 1.0)).xz;
          float r = length(xz - cameraPosition.xz);
          float h = max(cameraPosition.y, 1.0);
          OceanSample o = oceanAt(xz, r * 0.02 * max(1.0, r / (h * 25.0)), false);
          vec3 p = vec3(xz.x, 0.0, xz.y) + o.disp;
          vWorld = p;
          vRest = xz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON_GLSL}
        ${NOISE_GLSL}
        ${SHORE_GLSL}
        ${OCEAN_GLSL}
        uniform sampler2D uFoamTex;
        uniform float uSunVis;
        varying vec3 vWorld;
        varying vec2 vRest;

        float microfacet(vec3 N, vec3 V, vec3 L, float s2) {
          vec3 H = normalize(V + L);
          float nh = max(dot(N, H), 1e-3);
          float t2 = (1.0 - nh * nh) / (nh * nh);
          return exp(-t2 / s2) / (PI * s2 * nh * nh * nh * nh) / (4.0 * max(dot(N, V), 0.08));
        }

        void main() {
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          // A pixel covers a long stretch of sea at grazing angles: filter by that length.
          OceanSample o = oceanAt(vRest, dist * 0.0012 / max(V.y, 0.04), true);
          vec3 N = o.normal;
          float uF = offshore(vRest);
          float filmThick = max(vWorld.y - sandHeight(uF), 0.0);
          // Capillary ripples close by (not on the thin swash film, which is nearly glassy).
          if (dist < 120.0 && filmThick > 0.25) {
            vec2 q = vRest * 1.7 + uTime * vec2(0.3, 0.5);
            float e = 0.15;
            float n0 = snoise(q);
            vec2 g = vec2(snoise(q + vec2(e, 0.0)) - n0, snoise(q + vec2(0.0, e)) - n0) / e;
            N = normalize(N + vec3(-g.x, 0.0, -g.y) * 0.012 * (0.3 + uSea.y * 3.0) * (1.0 - smoothstep(30.0, 120.0, dist)));
          }
          if (dot(N, V) < 0.02) N = normalize(N + V * (0.02 - dot(N, V)));

          float cosV = clamp(dot(N, V), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
          vec3 R = reflect(-V, N);
          vec3 refl = skyReflection(R);

          // Sun and moon glitter, with roughness from waves too small to see.
          float s2 = 0.0015 + o.slopeVar + uSea.y * 0.01;
          vec3 glitter = uSunColor * uSunVis * microfacet(N, V, uSunDir, s2) * F;
          vec3 moonIrr = vec3(0.85, 0.9, 1.0) * 0.0004 * uMoonBright;
          glitter += moonIrr * microfacet(N, V, uMoonDir, s2) * F;
          // Soft knee: tame the brightest glints for bloom while keeping the variation
          // across wave faces (a hard ceiling flattens the whole sunward sea into a sheet).
          float gl = max(glitter.r, max(glitter.g, glitter.b)) * uExposure;
          glitter *= 6.0 / (6.0 + gl);

          // Water body, and light shining through backlit wave crests.
          vec3 amb = ambientLight(vec3(0.0, 1.0, 0.0));
          vec3 body = vec3(0.004, 0.02, 0.025) * (amb + uSunColor * uSunVis * 0.25);
          vec3 Lh = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.0) + 0.05, uSunDir.z));
          float back = pow(max(dot(-V, Lh), 0.0), 3.0);
          float thin = clamp(o.crest, 0.0, 1.0);
          vec3 sss = vec3(0.06, 0.32, 0.26) * uSunColor * uSunVis * back * thin * 0.35;

          vec3 col = refl * F + glitter + (1.0 - F) * (body + sss);

          // See the sand through thin water near the shore.
          float u = offshore(vRest);
          float thick = max(vWorld.y - sandHeight(u), 0.0);
          float alpha = mix(1.0 - exp(-thick * 2.2 / max(V.y, 0.15)), 1.0, F);

          // Whitewater: lacy foam advected with the surface.
          float foamAmt = o.foam;
          foamAmt = max(foamAmt, smoothstep(0.08, 0.0, thick) * step(u, 2.0) * smoothstep(0.0, 0.02, thick) * 0.9);
          vec2 fuv = vRest + vec2(0.0, o.disp.z * 0.5);
          float lace = textureLod(uFoamTex, fuv / 9.0, 0.0).g * 0.6 + textureLod(uFoamTex, fuv / 3.1 + 0.3, 0.0).g * 0.4;
          lace = clamp((lace - 0.3) / 0.45, 0.0, 1.0);
          // Large holes and patches so foam fields aren't uniform.
          float patches = clamp((textureLod(uFoamTex, fuv / 40.0 + 0.7, 0.0).g - 0.3) / 0.45, 0.0, 1.0);
          foamAmt = clamp(foamAmt * (0.55 + 0.7 * patches) * 1.7, 0.0, 1.0);
          float foam = smoothstep(1.0 - foamAmt - 0.15, 1.0 - foamAmt + 0.15, lace) * smoothstep(0.03, 0.2, foamAmt);
          foam *= 1.0 - smoothstep(500.0, 2500.0, dist) * 0.7;
          float ndl = max(dot(N, uSunDir), 0.0);
          vec3 foamCol = vec3(0.85) * (uSunColor * uSunVis * (ndl * 0.6 + 0.2) + amb);
          col = mix(col, foamCol, foam);
          alpha = max(alpha, foam);

          col = applyAtmosphere(col, vWorld);
          gl_FragColor = vec4(col * uExposure * alpha, alpha);
        }`,
    });

    // Polar grid around the camera: fine near the shore, coarse toward the horizon.
    const NA = 480;
    const NR = 360;
    const A0 = (-89 * Math.PI) / 180;
    const A1 = (89 * Math.PI) / 180;
    const R0 = 1.0;
    const R1 = 60000;
    const kr = Math.log(R1 / R0) / (NR - 1);
    const pos = new Float32Array(NA * NR * 3);
    for (let j = 0; j < NR; j++) {
      const r = R0 * Math.exp(kr * j);
      for (let i = 0; i < NA; i++) {
        const a = A0 + ((A1 - A0) * i) / (NA - 1);
        const v = (j * NA + i) * 3;
        pos[v] = Math.sin(a) * r;
        pos[v + 2] = -Math.cos(a) * r;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < NR - 1; j++) {
      for (let i = 0; i < NA - 1; i++) {
        const a = j * NA + i;
        idx.push(a, a + 1, a + NA, a + 1, a + NA + 1, a + NA);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  setSunVisibility(v: number) {
    ((this.mesh.material as THREE.ShaderMaterial).uniforms.uSunVis as THREE.IUniform).value = v;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.table.dispose();
  }
}

const OCEAN_GLSL = /* glsl */ `
uniform sampler2D uTable;
uniform vec4 uSwell[${N_SWELL}]; // omega, alongshore k, phase, deep onshore k
uniform vec4 uWind[${N_WIND}];   // dir x, dir z, k, amplitude
uniform float uWindPhase[${N_WIND}];
uniform vec4 uSea;              // swell Hs, wind Hs, whitecaps, period

struct OceanSample {
  vec3 disp;
  vec3 normal;
  float crest;    // height relative to local wave height, ~0..1 near crests
  float foam;     // whitewater amount 0..1
  float slopeVar; // slope variance of waves too small to resolve
};

vec4 tableAt(int row, float u) {
  float f = sqrt(clamp(u / ${UMAX.toFixed(1)}, 0.0, 1.0)) * ${(NU - 1).toFixed(1)};
  int i = min(int(f), ${NU - 2});
  float t = f - float(i);
  return mix(texelFetch(uTable, ivec2(i, row), 0), texelFetch(uTable, ivec2(i + 1, row), 0), t);
}

// footprint: size (m) below which waves are filtered out.
OceanSample oceanAt(vec2 xz, float footprint, bool full) {
  OceanSample o;
  float u = offshore(xz);
  float uc = clamp(u, 0.0, ${UMAX.toFixed(1)});
  vec4 summ = tableAt(${N_SWELL}, uc);
  float approach = summ.z;
  float depth = summ.w;
  vec3 disp = vec3(0.0);
  vec3 dx = vec3(1.0, 0.0, 0.0);
  vec3 dz = vec3(0.0, 0.0, 1.0);
  float var = 0.0;
  float swellY = 0.0;
  float localH = 0.0;
  float mainPhase = 0.0;
  vec2 env = vec2(0.0);
  float sumA = 0.0;
  vec2 dSwellY = vec2(0.0); // d(swell height)/dx, /dz
  float mainK = 0.1;

  for (int i = 0; i < ${N_SWELL}; i++) {
    vec4 s = uSwell[i];
    vec4 t = tableAt(i, uc);
    float phi = t.x + (u > ${UMAX.toFixed(1)} ? s.w * (u - ${UMAX.toFixed(1)}) : 0.0) + (u < 0.0 ? t.z * u : 0.0);
    float A = u < 0.0 ? 0.0 : t.y;
    float k = t.w;
    float kx = s.y;
    float kz = t.z;
    float th = kx * xz.x - phi - s.x * uTime + s.z;
    if (i == 2) { mainPhase = th; mainK = t.w; }
    float wl = 6.2832 / k;
    float fade = smoothstep(2.0 * footprint, 5.0 * footprint, wl);
    var += (1.0 - fade) * 0.5 * (k * A) * (k * A);
    A *= fade;
    float q = min(mix(0.45, 0.95, approach) / (${N_SWELL}.0 * k * max(A, 1e-4)), 1.0);
    float c = cos(th), sn = sin(th);
    float QA = q * A;
    disp += vec3(QA * kx / k * c, A * sn, QA * kz / k * c);
    swellY += A * sn;
    localH += A * A;
    env += A * vec2(c, sn);
    sumA += A;
    dSwellY += A * c * vec2(kx, kz);
    dx += vec3(-QA * kx * kx / k * sn, A * kx * c, -QA * kx * kz / k * sn);
    dz += vec3(-QA * kx * kz / k * sn, A * kz * c, -QA * kz * kz / k * sn);
  }
  localH = sqrt(localH * 2.0);
  // Waves feeling the bottom pitch forward: shift each point shoreward in proportion
  // to its height, scaled to the wavelength, so front faces steepen toward breaking.
  float lean = approach * min(0.32 * 6.2832 / mainK / max(sumA, 0.15), 14.0);
  // Never fold the surface over itself (that would turn faces inside out).
  lean = min(lean, 0.8 / max(abs(dSwellY.y), 1e-3));
  disp.z += lean * swellY;
  dx.z += lean * dSwellY.x;
  dz.z += lean * dSwellY.y;

  float shallow = smoothstep(0.3, 3.0, depth) * (1.0 - 0.7 * summ.y);
  for (int i = 0; i < ${N_WIND}; i++) {
    vec4 w = uWind[i];
    float k = w.z;
    float wl = 6.2832 / k;
    float fade = smoothstep(2.0 * footprint, 5.0 * footprint, wl) * shallow;
    float A = w.w;
    var += (1.0 - fade) * 0.5 * (k * A) * (k * A) * shallow;
    A *= fade;
    float th = k * dot(w.xy, xz) - sqrt(9.81 * k) * uTime + uWindPhase[i];
    float c = cos(th), sn = sin(th);
    float QA = min(0.6 / (${N_WIND}.0 * k * max(A, 1e-4)), 1.0) * A;
    disp += vec3(QA * w.x * c, A * sn, QA * w.y * c);
    dx += vec3(-QA * w.x * w.x * k * sn, A * w.x * k * c, -QA * w.x * w.y * k * sn);
    dz += vec3(-QA * w.x * w.y * k * sn, A * w.y * k * c, -QA * w.y * w.y * k * sn);
  }

  // Swash: after each wave reaches the beach, a thin sheet runs up the sand and back.
  if (u < 8.0) {
    float thS = uSwell[2].y * xz.x - uSwell[2].x * uTime + uSwell[2].z;
    float psi = fract((1.5708 - thS) / 6.2832);
    float group = 0.65 + 0.35 * sin(uSwell[4].y * xz.x * 0.5 - (uSwell[4].x - uSwell[2].x) * uTime + 1.3);
    float rise = psi < 0.3 ? sin(psi / 0.3 * 1.5708) : (psi < 0.92 ? pow(1.0 - (psi - 0.3) / 0.62, 1.6) : 0.0);
    // A thin film hugging the sloping sand, thinning to nothing at its leading edge.
    float reach = uShoreC.z * group * rise / uShoreB.w;
    if (u < 0.0) {
      float frac = -u / max(reach, 0.01);
      float film = frac < 1.0 ? (0.015 + uShoreC.z * 0.12 * pow(1.0 - frac, 0.8)) : -0.08;
      disp = vec3(0.0, sandHeight(u) + film, 0.0);
    } else {
      disp.y = max(disp.y, uShoreC.z * 0.12 * group * rise * (1.0 - smoothstep(0.0, 8.0, u)));
    }
  }

  o.disp = disp;
  o.normal = normalize(cross(dz, dx));
  o.crest = localH > 1e-3 ? swellY / localH + 0.3 : 0.0;
  o.slopeVar = var;
  o.foam = 0.0;
  if (full) {
    // Whitewater: on breaking crests, trailing behind them through the surf zone,
    // and whitecaps on wind waves offshore.
    // The wave-group envelope: where the swells line up, waves are bigger and break
    // first, so whitewater comes in sections rather than unbroken lines.
    float group = sumA > 1e-4 ? length(env) / sumA : 0.0;
    float sect = 0.3 + 0.7 * smoothstep(0.3, 0.75, group);
    float sinceCrest = fract((1.5708 - mainPhase) / 6.2832);
    float crestNorm = sumA > 1e-4 ? swellY / sumA : 0.0;
    float crestFoam = summ.x * smoothstep(0.2, 0.6, crestNorm) * sect * 1.3;
    float trail = summ.y * (exp(-sinceCrest * 2.2) * sect + 0.22);
    float caps = uSea.z * smoothstep(0.75, 1.0, disp.y / max(uSea.y, 0.05)) * smoothstep(5.0, 20.0, depth);
    o.foam = clamp(max(max(crestFoam, trail), caps), 0.0, 1.0) * step(0.0, u + 1.0);
  }
  return o;
}
`;

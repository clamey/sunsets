// The ocean: a displaced surface made of swell trains that feel the seabed (they slow,
// bend toward the beach, steepen and break), plus wind chop, whitewater, swash running
// up the sand, sun/moon glitter and light shining through backlit crests.
//
// Swell components are refracted analytically for straight, parallel depth contours:
// the alongshore wavenumber is conserved (Snell's law) and the onshore phase is the
// integral of the local onshore wavenumber, precomputed per component into a table.
import * as THREE from 'three';
import { cloudNoise } from './noise';
import { type Rng, makeRng, range } from './rng';
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

/** Wave timing and size, for the sound of the surf to follow what's on screen. */
export interface Surf {
  /** Main swell: angular frequency, alongshore wavenumber and phase (as uSwashA). */
  omega: number;
  ky: number;
  phase: number;
  /** Group swell (as uSwashB), which makes some swashes run further than others. */
  groupOmega: number;
  groupKy: number;
  /** Seconds from a crest breaking to its swash starting up the sand. */
  lead: number;
  /** Offshore distance (m) where waves break hardest, or -1 if they never break. */
  breakU: number;
  height: number;
  period: number;
  /** Wind-sea height (m) and whitecap amount. */
  windHeight: number;
  whitecaps: number;
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  /** Swell timing the swash follows, for the sand to know where it has been. */
  readonly swash: { a: THREE.Vector4; b: THREE.Vector4 };
  readonly surf: Surf;
  private table: THREE.DataTexture;
  private spray: THREE.Points | null;

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
    let breakLo = Infinity;
    let breakHi = -Infinity;
    let breakMax = 0;
    let breakJ = -1;
    for (let j = NU - 1; j >= 0; j--) {
      const h = Math.max(seabedDepth(shore, uAt(j)), 0.02);
      const ratio = hsUnc[j] / (GAMMA * h);
      const scale = Math.min(1, 1 / ratio);
      for (let i = 0; i < N_SWELL; i++) data[(i * NU + j) * 4 + 1] *= scale;
      // Strongest where waves first break; broken bores carry on as trailing foam.
      const breaking = Math.min(1, Math.max(0, (ratio - 0.85) / 0.25)) * (1 - 0.65 * Math.min(1, Math.max(0, (ratio - 1.4) / 1.5)));
      if (j < NU - 1) foam *= Math.exp(-(uAt(j + 1) - uAt(j)) / FOAM_DECAY);
      foam = Math.max(foam, breaking);
      if (breaking > breakMax) {
        breakMax = breaking;
        breakJ = j;
      }
      const approach = Math.min(1, Math.max(0, (ratio - 0.55) / 0.45));
      if (breaking > 0.005) {
        breakLo = Math.min(breakLo, uAt(j));
        breakHi = Math.max(breakHi, uAt(j));
      }
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
      uSwashA: { value: new THREE.Vector4(swellU[2].x, swellU[2].y, swellU[2].z, 0) },
      uSwashB: { value: new THREE.Vector4(swellU[4].x, swellU[4].y, 0, 0) },
      uSunVis: { value: 1 },
    };

    this.swash = { a: uniforms.uSwashA.value, b: uniforms.uSwashB.value };
    this.surf = {
      omega: swellU[2].x,
      ky: swellU[2].y,
      phase: swellU[2].z,
      groupOmega: swellU[4].x,
      groupKy: swellU[4].y,
      lead: breakJ >= 0 ? data[(2 * NU + breakJ) * 4] / swellU[2].x : 0,
      breakU: breakJ >= 0 ? uAt(breakJ) : -1,
      height: sea.height,
      period: sea.period,
      windHeight: sea.windHeight,
      whitecaps: sea.whitecaps,
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
          // Where the film is cut away the view carries on to the sand behind it, unless
          // this point sits high enough over the sand that the line of sight would skim
          // past the waterline and down on to the seabed. Keep the film there, or the
          // seabed shows through as dark slivers along the water's edge.
          float uW = offshore(vWorld.xz);
          float above = vWorld.y - sandHeight(uW);
          float descent = V.y / max(length(V.xz), 1e-3) - uShoreB.w;
          float skims = uW >= 0.0 || descent <= 0.0 ? 1.0 : smoothstep(0.6, 1.0, above / (descent * -uW));
          o.cover = max(o.cover, skims);
          if (o.cover < 0.01) discard;
          vec3 N = o.normal;
          float uF = offshore(vRest);
          float filmThick = max(vWorld.y - sandHeight(uF), 0.0);
          if (dist < 120.0) {
            float near = 1.0 - smoothstep(30.0, 120.0, dist);
            // Capillary ripples, dying away as the water shoals on to the sand.
            float ripW = smoothstep(0.03, 0.4, filmThick);
            vec2 g = vec2(0.0);
            if (ripW > 0.0) {
              vec2 q = vRest * 1.7 + uTime * vec2(0.3, 0.5);
              float e = 0.15;
              float n0 = snoise(q);
              g = vec2(snoise(q + vec2(e, 0.0)) - n0, snoise(q + vec2(0.0, e)) - n0) / e
                * 0.012 * (0.3 + uSea.y * 3.0) * ripW;
            }
            // The swash sheet is never still: streaks and wrinkles stretched along the flow
            // ride up the beach with the uprush and back down with the backwash, churned
            // most behind the front and smoothing to glass only where the sheet is thinnest.
            // They start a little out to sea so the surf runs into the sheet without a seam.
            if (uF < 4.0) {
              float cnt = swashCount(vRest.x, uTime);
              float n = floor(cnt);
              float psi = cnt - n;
              float rise = swashRise(psi);
              float reach = max(swashReach(vRest.x, n) * rise, swashBase(vRest.x, uTime));
              float upward = 1.0 - smoothstep(0.22, 0.36, psi);
              float frac = clamp(-uF / max(reach, 0.01), 0.0, 1.0);
              float amp = mix(0.5, 1.0, smoothstep(0.0, 0.12, rise)) * (1.0 - smoothstep(0.0, 4.0, uF))
                * smoothstep(0.02, 0.07, filmThick) * mix(0.6, 1.0 + 0.8 * smoothstep(0.4, 0.85, frac), upward);
              if (amp > 0.0) {
                // Flow coordinates: across the streaks, and along them moving with the sheet.
                // (Nothing here may jump from one swash to the next: the margin of water
                // between swashes shows it.)
                vec2 p = vec2(vRest.x / 0.9 + uTime * 0.004, (uF + reach * 0.8) / 4.5);
                vec2 p2 = vec2(vRest.x / 0.35 - uTime * 0.003, (uF + reach * 0.95) / 1.6 - uTime * 0.07);
                const float E = 0.02;
                float s0 = textureLod(uFoamTex, p, 0.0).g;
                float t0 = textureLod(uFoamTex, p2, 0.0).r;
                vec2 gs = vec2(
                  (textureLod(uFoamTex, p + vec2(E, 0.0), 0.0).g - s0) / (E * 0.9),
                  (textureLod(uFoamTex, p + vec2(0.0, E), 0.0).g - s0) / (E * 4.5));
                vec2 gt = vec2(
                  (textureLod(uFoamTex, p2 + vec2(E, 0.0), 0.0).r - t0) / (E * 0.35),
                  (textureLod(uFoamTex, p2 + vec2(0.0, E), 0.0).r - t0) / (E * 1.6));
                // Offshore is -z, so a gradient in u is minus one in z.
                g += (gs * 0.05 + gt * 0.012) * vec2(1.0, -1.0) * amp;
              }
            }
            N = normalize(N + vec3(-g.x, 0.0, -g.y) * near);
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
          // Light refracts steeply into the water, so its path through shallow water is
          // short even when the surface is seen at a grazing angle.
          float cosT = sqrt(1.0 - (1.0 - cosV * cosV) / 1.78);
          float alpha = mix(1.0 - exp(-thick * 2.2 / cosT), 1.0, F);
          // The surface reflection is there however thin the water is; only the light
          // from inside it fades with depth. (Output is premultiplied by alpha below.)
          col = (refl * F + glitter + (alpha - F) * (body + sss)) / max(alpha, 1e-3);

          // Whitewater: lacy foam advected with the surface.
          float foamAmt = o.foam;
          vec2 fuv = vRest + vec2(0.0, o.disp.z * 0.5);
          // The noise texture tiles every unit, so warp it with non-repeating noise and
          // give each lookup its own rotation; otherwise the foam shows a grid.
          // Warps tile at 211 m and 37 m, both rotated, so nothing lines up nearby.
          const mat2 R1 = mat2(0.866, 0.5, -0.5, 0.866);
          const mat2 R2 = mat2(0.309, -0.951, 0.951, 0.309);
          const mat2 R3 = mat2(-0.643, 0.766, -0.766, -0.643);
          fuv += (textureLod(uFoamTex, R3 * fuv / 211.0 + 0.41, 0.0).rb - 0.5) * 30.0;
          fuv += (textureLod(uFoamTex, R2 * fuv / 37.0 + 0.77, 0.0).br - 0.5) * 5.0;
          float lace = textureLod(uFoamTex, R1 * fuv / 9.0, 0.0).g * 0.6 + textureLod(uFoamTex, R2 * fuv / 3.1 + 0.3, 0.0).g * 0.4;
          lace = clamp((lace - 0.3) / 0.45, 0.0, 1.0);
          // Large holes and patches so foam fields aren't uniform.
          float patches = clamp((textureLod(uFoamTex, R1 * fuv / 97.0 + 0.7, 0.0).g - 0.3) / 0.45, 0.0, 1.0);
          foamAmt = clamp(foamAmt * (0.55 + 0.7 * patches) * 1.7, 0.0, 1.0);
          // Fresh whitewater is solid; as it ages it thins into a web of filaments
          // (contour lines of noise), the marbled lace you see behind breaking waves.
          float solid = smoothstep(1.0 - foamAmt - 0.15, 1.0 - foamAmt + 0.15, lace) * smoothstep(0.45, 0.85, foamAmt);
          float n1 = textureLod(uFoamTex, R3 * fuv / 6.5 + 0.13, 0.0).r;
          float n2 = textureLod(uFoamTex, R1 * R2 * fuv / 2.2 + 0.57, 0.0).b;
          float w = 0.03 + 0.12 * foamAmt;
          float web = max(1.0 - smoothstep(0.0, w, abs(n1 - 0.5)),
                          0.6 * smoothstep(0.35, 0.7, foamAmt) * (1.0 - smoothstep(0.0, w * 0.6, abs(n2 - 0.5))));
          float foam = max(solid, web * smoothstep(0.12, 0.35, foamAmt));
          // Far away the pattern is finer than a pixel: show its average instead.
          foam = mix(foam, foamAmt * 0.55, smoothstep(40.0, 160.0, dist));
          // Where a crest is breaking right now the whitewater is a thick tumbling mass,
          // pouring over the lip and down the front face, not lace. It's big enough to
          // keep its shape at any distance the surf is seen from.
          float onFace = smoothstep(0.55, 0.9, o.crest) + smoothstep(0.7, 0.95, o.since) * smoothstep(0.2, 0.6, o.crest);
          float fresh = smoothstep(0.12, 0.7, o.breaking) * clamp(onFace, 0.0, 1.0);
          foam = max(foam, fresh * smoothstep(0.25, 0.6, lace * 0.6 + patches * 0.5));
          foam *= 1.0 - smoothstep(500.0, 2500.0, dist) * 0.7;
          float ndl = max(dot(N, uSunDir), 0.0);
          vec3 foamCol = vec3(0.85) * (uSunColor * uSunVis * (ndl * 0.6 + 0.2) + amb);
          col = mix(col, foamCol, foam);
          alpha = max(alpha, foam);

          alpha *= o.cover;
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

    this.spray = makeSpray(uniforms, breakLo, breakHi);
    if (this.spray) this.mesh.add(this.spray);
  }

  setSunVisibility(v: number) {
    ((this.mesh.material as THREE.ShaderMaterial).uniforms.uSunVis as THREE.IUniform).value = v;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    if (this.spray) {
      this.spray.geometry.dispose();
      (this.spray.material as THREE.Material).dispose();
    }
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
  float cover;    // 0 where the swash film hasn't reached (soft edge, per pixel)
  float breaking; // how hard the wave here is breaking right now (full only)
  float since;    // fraction of a wave period since the main crest passed (full only)
  float height;   // local swell height (m)
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
  // Peeling: the line where waves break wanders along the beach and differs from wave
  // to wave, so each wave breaks first at a peak and the break runs along the crest.
  // It moves the breaking and the height cap (not the phase), and is a smooth field
  // in both position and wave count so the surface never tears.
  float th2 = uSwell[2].y * xz.x - tableAt(2, uc).x - uSwell[2].x * uTime + uSwell[2].z;
  float waveC = (1.5708 - th2) / 6.2832;
  float pn = textureLod(uFoamTex, vec2(xz.x / 230.0 + 0.31, waveC * 0.37 + 0.13), 0.0).r * 0.7
    + textureLod(uFoamTex, vec2(xz.x / 67.0 - waveC * 0.23, 0.71 - waveC * 0.31), 0.0).b * 0.3;
  float L0 = 61.64 / (uSwell[2].x * uSwell[2].x);
  float peel = clamp((pn - 0.5) * 4.0, -1.0, 1.0) * clamp(0.11 * L0, 3.0, 32.0);
  float ub = clamp(u + peel, 0.0, ${UMAX.toFixed(1)});
  vec4 summ = tableAt(${N_SWELL}, ub);
  float approach = summ.z;
  float depth = tableAt(${N_SWELL}, uc).w;
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
    float A = u < 0.0 ? 0.0 : tableAt(i, ub).y;
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

  // Broken waves carry a tumbling, lumpy bore of whitewater just behind the crest.
  float sinceMain = fract((1.5708 - mainPhase) / 6.2832);
  float lumps = textureLod(uFoamTex, vec2(xz.x / 11.0 + waveC * 0.41, waveC * 0.29 + sinceMain * 0.6), 0.0).g;
  float bore = summ.y * smoothstep(0.0, 0.04, sinceMain) * exp(-sinceMain * 5.0)
    * localH * 0.22 * (0.4 + 1.2 * lumps) * step(0.0, u);
  disp.y += bore;

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

  // Swash running up the beach and back (see SHORE_GLSL).
  float swashFoam = 0.0;
  float cover = 1.0;
  if (u < 8.0) {
    float cnt = swashCount(xz.x, uTime);
    float n = floor(cnt);
    float psi = cnt - n;
    float rise = swashRise(psi);
    float furthest = swashReach(xz.x, n);
    float reach = max(furthest * rise, swashBase(xz.x, uTime));
    if (u < 0.0) {
      float frac = -u / max(reach, 0.01);
      // A thin film hugging the sloping sand, thinning to nothing at its leading edge.
      // It always sits just above the sand; its edge is cut per pixel (cover) so the
      // outline follows the lobes smoothly instead of the mesh rows.
      float film = 0.02 + (frac < 1.0 ? uShoreC.z * 0.12 * pow(1.0 - frac, 0.8) : 0.0);
      disp = vec3(0.0, sandHeight(u) + film, 0.0);
      dx = vec3(1.0, 0.0, 0.0);
      dz = vec3(0.0, 0.0, 1.0);
      // Draining back, the thinnest parts of the sheet go first, so its edge breaks up
      // into ragged tongues and stranded patches.
      float drain = smoothstep(0.3, 0.6, psi);
      float holes = textureLod(uFoamTex, vec2(xz.x / 6.0 + n * 0.37, xz.y / 2.5 + n * 0.71), 0.0).g;
      float edge = 1.0 - drain * 0.45 * smoothstep(0.25, 0.75, holes);
      cover = 1.0 - smoothstep(0.92 * edge, edge, frac);
      if (u < -60.0) disp.y = -3.0;
      // Bubbly foam front on the way up; a ragged, thinner fringe as it drains back,
      // popping away as the sheet thins out.
      float ragged = textureLod(uFoamTex, vec2(xz.x / 17.0 - n * 0.41, 0.53 + n * 0.29), 0.0).b;
      float front = smoothstep(0.55, 0.97, frac) * smoothstep(0.0, 0.3, rise);
      float fringe = smoothstep(0.75, 1.0, frac) * 0.55 * ragged * smoothstep(0.0, 0.35, rise);
      swashFoam = frac < 1.0 ? mix(front, fringe, smoothstep(0.24, 0.42, psi)) : 0.0;
    } else {
      float size = clamp(furthest * uShoreB.w / uShoreC.z, 0.0, 1.3);
      disp.y = max(disp.y, uShoreC.z * 0.12 * size * rise * (1.0 - smoothstep(0.0, 8.0, u)));
    }
  }

  // A trough can't drain below the seabed: the water thins to a film over it instead.
  if (u >= 0.0 && u < 40.0) disp.y = max(disp.y, sandHeight(offshore(xz + disp.xz)) + 0.03);
  // The last few metres of sea settle into the foot of the swash sheet, so the surf
  // runs on into the sheet instead of ending in a step along the still-water line.
  float settle = uShoreC.z / uShoreB.w * 0.35;
  if (u >= 0.0 && u < settle) {
    float w = smoothstep(0.0, settle, u);
    vec3 foot = vec3(0.0, sandHeight(u) + 0.02 + uShoreC.z * 0.12, 0.0);
    disp = mix(foot, disp, w);
    dx = mix(vec3(1.0, 0.0, 0.0), dx, w);
    dz = mix(vec3(0.0, uShoreB.w, 1.0), dz, w);
  }

  o.disp = disp;
  o.normal = normalize(cross(dz, dx));
  o.crest = localH > 1e-3 ? swellY / localH + 0.3 : 0.0;
  o.slopeVar = var;
  o.cover = cover;
  o.foam = 0.0;
  o.breaking = 0.0;
  o.since = 0.0;
  o.height = localH;
  if (full) {
    // Whitewater: on breaking crests, trailing behind them through the surf zone,
    // and whitecaps on wind waves offshore.
    // The wave-group envelope: where the swells line up, waves are bigger and break
    // first, so whitewater comes in sections rather than unbroken lines.
    float group = sumA > 1e-4 ? length(env) / sumA : 0.0;
    float sect = 0.3 + 0.7 * smoothstep(0.3, 0.75, group);
    float sinceCrest = fract((1.5708 - mainPhase) / 6.2832);
    float crestNorm = sumA > 1e-4 ? swellY / sumA : 0.0;
    // Each broken wave's whitewater comes in sections that differ from wave to wave.
    float waveNo = (1.5708 - mainPhase) / 6.2832;
    vec4 bn = textureLod(uFoamTex, vec2(xz.x / 45.0 + floor(waveNo) * 0.37, floor(waveNo) * 0.61 + 0.2), 0.0);
    float sections = mix(0.12, 1.0, smoothstep(0.35, 0.62, bn.g * 0.7 + bn.r * 0.5 - 0.1));
    float crestFoam = summ.x * smoothstep(0.2, 0.6, crestNorm) * sect * 1.3 * sections;
    float trail = summ.y * (exp(-sinceCrest * 2.2) * sect * sections + 0.16);
    float caps = uSea.z * smoothstep(0.75, 1.0, disp.y / max(uSea.y, 0.05)) * smoothstep(5.0, 20.0, depth);
    o.foam = max(clamp(max(max(crestFoam, trail), caps), 0.0, 1.0) * step(0.0, u + 1.0), swashFoam);
    o.breaking = summ.x * sect * sections * step(0.0, u);
    o.since = sinceCrest;
  }
  return o;
}
`;

/** Alongshore half-width (m) and spacing of the spray anchors. */
const SPRAY_HALF = 150;
const SPRAY_DX = 0.35;
const SPRAY_MAX_ROWS = 120;
/** Furthest the peel moves the break line (matches the clamp in oceanAt). */
const PEEL_MAX = 32;

/**
 * Spray thrown off breaking lips: points anchored on a grid over the surf zone. Each
 * one launches shoreward and up as a breaking crest passes over it, arcs under
 * gravity and fades, so together they form a curtain that runs along with the peel.
 */
function makeSpray(uniforms: Record<string, THREE.IUniform>, lo: number, hi: number): THREE.Points | null {
  if (!(hi > lo)) return null;
  lo = Math.max(0, lo - PEEL_MAX);
  hi = hi + PEEL_MAX;
  const rows = Math.min(SPRAY_MAX_ROWS, Math.ceil((hi - lo) / 0.5));
  const du = (hi - lo) / rows;
  const cols = Math.round((2 * SPRAY_HALF) / SPRAY_DX);
  const seed = new Float32Array(rows * cols * 4);
  const rand = makeRng(9173);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      seed[k++] = -SPRAY_HALF + (i + 0.5) * SPRAY_DX;
      seed[k++] = lo + (j + 0.5) * du;
      seed[k++] = rand();
      seed[k++] = rand();
    }
  }
  const geo = new THREE.BufferGeometry();
  // Positions are computed in the shader; three.js still wants a position attribute.
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows * cols * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const pointScale = { value: 500 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPointScale: pointScale, uCell: { value: new THREE.Vector2(SPRAY_DX, du) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      ${COMMON_GLSL}
      ${SHORE_GLSL}
      ${OCEAN_GLSL}
      attribute vec4 aSeed; // x along the beach, offshore u, two randoms
      uniform float uPointScale;
      uniform float uSunVis;
      uniform vec2 uCell;
      varying float vAlpha;
      varying vec3 vCol;
      varying vec3 vWorld;
      void main() {
        gl_PointSize = 0.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vAlpha = 0.0;
        float r1 = aSeed.z, r2 = aSeed.w;
        // Only some anchors throw spray, which keeps it from looking like a sheet.
        if (r1 > 0.8) return;
        float x = aSeed.x + (fract(r2 * 17.3) - 0.5) * uCell.x;
        float u0 = aSeed.y + (fract(r1 * 23.9) - 0.5) * uCell.y;
        vec2 xz = vec2(x, -(u0 + shoreDist(x)));
        OceanSample o = oceanAt(xz, 0.5, true);
        // Spray comes off the crest of breaking sections, so it rides the lip you see.
        float atCrest = smoothstep(0.7, 1.05, o.crest);
        // Small waves spill quietly; bigger ones throw more.
        float strength = smoothstep(0.03, 0.6, o.breaking) * atCrest * smoothstep(0.4, 1.6, o.height);
        if (strength < 0.03) return;
        // Each droplet loops through short arcs: up off the lip, forward and down.
        float life = mix(0.5, 1.2, r2);
        float t = fract(uTime / life + fract(r1 * 31.7)) * life;
        float H = max(o.height, 0.15);
        float c = sqrt(9.81 * 2.0 * H);
        vec2 shore = normalize(vec2(shoreDist(x + 0.5) - shoreDist(x - 0.5), 1.0));
        float vh = c * mix(0.15, 0.6, fract(r1 * 7.7));
        float vu = mix(0.6, 2.4, fract(r2 * 5.3)) * sqrt(H);
        vec3 p = vec3(xz.x, 0.0, xz.y) + o.disp
          + vec3(shore.x, 0.0, shore.y) * vh * t + vec3(0.0, vu * t - 4.9 * t * t, 0.0);
        if (p.y < o.disp.y - H * 0.6) return;
        vWorld = p;
        vAlpha = strength * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(life * 0.3, life, t)) * 0.16;
        // Backlit droplets glow; front-lit spray is plain white.
        vec3 v = normalize(p - cameraPosition);
        float g = 0.6, cosT = dot(v, uSunDir);
        float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5) / (4.0 * PI);
        vCol = 0.9 * (uSunColor * uSunVis * (0.2 + hg * 1.5) + ambientLight(vec3(0.0, 1.0, 0.0)));
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = mix(0.35, 0.9, fract(r1 * 3.1)) * sqrt(H) * (1.0 + 2.0 * t);
        gl_PointSize = min(size * uPointScale / max(-mv.z, 0.1), 64.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      varying float vAlpha;
      varying vec3 vCol;
      varying vec3 vWorld;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = vAlpha * exp(-d * d * 3.0) * (1.0 - smoothstep(0.7, 1.0, d));
        if (a < 0.003) discard;
        gl_FragColor = vec4(applyAtmosphere(vCol, vWorld) * uExposure * a, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    renderer.getDrawingBufferSize(size);
    pointScale.value = size.y * 0.5 * (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
  };
  return points;
}

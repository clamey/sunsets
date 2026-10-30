// The sky: a small scattering lookup table recomputed every frame, and a dome that
// draws sky colour, the sun, moon, stars, Milky Way and up to three cloud layers.
import * as THREE from 'three';
import {
  MIE_EXTINCT, MIE_H, MIE_SCATTER, NIGHT_SKY, OZONE, RAYLEIGH, RAYLEIGH_H, RG, RT, SUN_INTENSITY,
} from './atmosphere';
import { COMMON_GLSL, NOISE_GLSL, shared } from './shared';

const v3 = (a: number[]) => `vec3(${a.map((x) => x.toExponential(6)).join(', ')})`;

export const ATMO_GLSL = /* glsl */ `
const float RG = ${RG.toFixed(1)};
const float RT = ${RT.toFixed(1)};
const vec3 BETA_R = ${v3(RAYLEIGH)};
const vec3 BETA_O = ${v3(OZONE)};
const float BETA_MS = ${MIE_SCATTER.toExponential(6)};
const float BETA_ME = ${MIE_EXTINCT.toExponential(6)};
const float H_R = ${RAYLEIGH_H.toFixed(2)};
const float H_M = ${MIE_H.toFixed(2)};
const float SUN_I = ${SUN_INTENSITY.toFixed(2)};
const vec3 NIGHT_SKY = ${v3(NIGHT_SKY)};
`;

const LUT_W = 256;
const LUT_H = 128;

export class SkyLUT {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared, uMieScale: { value: 1 }, uCamAlt: { value: 0.01 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${COMMON_GLSL}
        ${ATMO_GLSL}
        uniform float uMieScale;
        uniform float uCamAlt;
        varying vec2 vUv;

        void main() {
          float az = (vUv.x - 0.5) * 2.0 * PI;
          float l = vUv.y * 2.0 - 1.0;
          float el = sign(l) * l * l * 0.5 * PI;
          vec3 d = vec3(sin(az) * cos(el), sin(el), -cos(az) * cos(el));
          float r0 = RG + uCamAlt;
          float mu = d.y;
          float len = -r0 * mu + sqrt(max(0.0, r0 * r0 * (mu * mu - 1.0) + RT * RT));
          float discG = r0 * r0 * (mu * mu - 1.0) + RG * RG;
          if (mu < 0.0 && discG >= 0.0) len = min(len, -r0 * mu - sqrt(discG));

          float cosT = dot(d, uSunDir);
          float pR = 3.0 / (16.0 * PI) * (1.0 + cosT * cosT);
          float g = 0.8;
          float g2 = g * g;
          float pM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosT * cosT)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosT, 1.5));
          float ms = 0.12 / (4.0 * PI);

          vec3 sum = vec3(0.0);
          vec3 od = vec3(0.0);
          const int N = 32;
          float tPrev = 0.0;
          for (int i = 0; i < N; i++) {
            float x = (float(i) + 0.5) / float(N);
            float t = len * x * x;
            float dt = len * 2.0 * x / float(N);
            vec3 p = vec3(0.0, r0, 0.0) + d * t;
            float pr = length(p);
            float h = pr - RG;
            float dR = exp(-h / H_R);
            float dM = exp(-h / H_M) * uMieScale;
            float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
            vec3 ext = BETA_R * dR + BETA_ME * dM + BETA_O * dO;
            od += ext * dt;
            float muS = dot(p / pr, uSunDir);
            vec3 sunT = transLut(h, asin(clamp(muS, -1.0, 1.0)));
            vec3 scat = BETA_R * dR * (pR + ms) + BETA_MS * dM * (pM + ms);
            sum += exp(-od) * sunT * scat * dt;
          }
          gl_FragColor = vec4(sum * SUN_I + NIGHT_SKY, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  render(renderer: THREE.WebGLRenderer) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
  }
}

export function makeSkyDome(): { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform> } {
  const uniforms: Record<string, THREE.IUniform> = {
    ...shared,
    uCamAlt: { value: 0.01 },
    uCelestial: { value: new THREE.Matrix3() },
    uGalPole: { value: new THREE.Vector3(0, 1, 0) },
    uStarSeed: { value: 0 },
    uMoonLight: { value: new THREE.Vector3(0, 1, 0) },
    uMoonOn: { value: 0 },

  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${ATMO_GLSL}
      ${NOISE_GLSL}
      uniform float uCamAlt;
      uniform mat3 uCelestial;
      uniform vec3 uGalPole;
      uniform float uStarSeed;
      uniform vec3 uMoonLight;
      uniform float uMoonOn;

      varying vec3 vDir;

      vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }

      // Atmospheric refraction lifts objects near the horizon (and squashes the sun).
      float refraction(float elev) {
        float hDeg = max(degrees(elev), -1.5);
        float arcmin = 1.02 / tan(radians(hDeg + 10.3 / (hDeg + 5.11)));
        return radians(arcmin / 60.0) * smoothstep(-2.0, -0.5, degrees(elev));
      }

      vec3 trueDir(vec3 d) {
        float el = asin(clamp(d.y, -1.0, 1.0));
        float t = el - refraction(el);
        vec2 h = normalize(d.xz + 1e-6);
        return vec3(h.x * cos(t), sin(t), h.y * cos(t));
      }

      vec3 starColor(float t) {
        return mix(vec3(1.0, 0.72, 0.5), vec3(0.72, 0.82, 1.0), t);
      }

      vec3 stars(vec3 d) {
        vec3 c = uCelestial * d;
        float pix = max(length(fwidth(c)), 1e-5);
        vec3 col = vec3(0.0);
        for (int layer = 0; layer < 3; layer++) {
          float S = layer == 0 ? 45.0 : layer == 1 ? 110.0 : 260.0;
          vec3 p = c * S;
          vec3 cell = floor(p);
          vec3 h = hash33(cell + uStarSeed);
          vec3 sp = cell + 0.25 + 0.5 * h;
          if (abs(length(sp) - S) > 0.5) continue;
          vec3 sd = normalize(sp);
          float dist = length(c - sd);
          float m = hash12(cell.xy * 1.7 + cell.z + uStarSeed);
          float b = layer == 0 ? pow(m, 10.0) * 0.05 : layer == 1 ? pow(m, 12.0) * 0.012 : pow(m, 9.0) * 0.0007;
          float twinkle = 1.0 + 0.3 * sin(uTime * (2.0 + 5.0 * h.y) + h.z * 40.0);
          float r = pix * 0.75;
          col += starColor(h.x) * b * twinkle * exp(-dist * dist / (r * r));
        }
        // Milky Way: a soft band with dark dust lanes.
        float gb = dot(c, uGalPole);
        vec3 gx = normalize(cross(uGalPole, vec3(0.31, 0.77, 0.55)));
        vec3 gy = cross(uGalPole, gx);
        vec2 gp = vec2(atan(dot(c, gy), dot(c, gx)) * 3.0, gb * 9.0);
        float band = exp(-gb * gb / 0.03) * (0.55 + 0.45 * fbm(gp * 1.5, 5));
        float dust = smoothstep(0.1, 0.5, fbm(gp * 2.5 + 7.0, 5)) * exp(-gb * gb / 0.004);
        col += vec3(0.85, 0.85, 1.0) * max(band * (1.0 - 0.8 * dust), 0.0) * 0.0009;
        return col;
      }

      vec3 moon(vec3 d, float pixAng, out float coverage) {
        coverage = 0.0;
        if (uMoonOn < 0.5) return vec3(0.0);
        const float R = 0.0058;
        float cd = dot(d, uMoonDir);
        vec3 glow = vec3(0.0);
        float ang = acos(clamp(cd, -1.0, 1.0));
        float lit0 = clamp(0.5 + 0.5 * dot(-uMoonDir, uMoonLight), 0.0, 1.0);
        glow = vec3(0.9, 0.92, 1.0) * lit0 * 0.004 * exp(-ang / 0.03);
        if (ang > R * 1.2) return glow;
        vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
        vec3 t2 = cross(t1, uMoonDir);
        vec3 off = d - uMoonDir * cd;
        vec2 q = vec2(dot(off, t1), dot(off, t2)) / R;
        float rr = dot(q, q);
        coverage = 1.0 - smoothstep(1.0 - 2.0 * pixAng / R, 1.0, sqrt(rr));
        vec3 n = q.x * t1 + q.y * t2 - sqrt(max(0.0, 1.0 - rr)) * uMoonDir;
        float lit = smoothstep(-0.03, 0.08, dot(n, uMoonLight));
        float maria = 0.72 + 0.28 * smoothstep(-0.3, 0.4, fbm(q * 1.6 + 3.0, 5));
        float shine = 0.006;
        return glow + vec3(1.0, 0.97, 0.92) * (lit * 0.55 * maria + shine * maria) * coverage;
      }

      vec3 sunDisc(vec3 d, float pixAng) {
        vec3 td = trueDir(d);
        float ang = acos(clamp(dot(td, uSunDir), -1.0, 1.0));
        const float R = 0.0058;
        float edge = 1.0 - smoothstep(R - pixAng, R + pixAng, ang);
        if (edge <= 0.0) return vec3(0.0);
        float x = clamp(ang / R, 0.0, 1.0);
        float limb = 0.6 + 0.4 * sqrt(1.0 - x * x);
        vec3 T = transLut(uCamAlt, asin(clamp(td.y, -1.0, 1.0)));
        vec3 c = T * SUN_I * 9.0 * limb * edge;
        // Keep the disc within what bloom can render gracefully.
        float m = max(c.r, max(c.g, c.b)) * uExposure;
        return m > 24.0 ? c * (24.0 / m) : c;
      }

      void main() {
        vec3 d = normalize(vDir);
        float pixAng = max(length(fwidth(d)), 1e-5);
        vec3 col = skyLut(d);
        float elev = asin(clamp(d.y, -1.0, 1.0));
        vec3 ext = transLut(uCamAlt, max(elev, 0.0));
        if (d.y > -0.01) {
          float mc;
          vec3 m = moon(d, pixAng, mc);
          col += stars(d) * ext * (1.0 - mc) * smoothstep(-0.005, 0.03, d.y);
          col += m * ext;
          col += sunDisc(d, pixAng);
        }
        // Stars are thousands of times brighter than a night cloud, so the background
        // must be fully hidden where the cloud is opaque.
        vec4 cl = cloudsAt(d);
        float trans = 1.0 - cl.a;
        trans = trans < 0.02 ? 0.0 : trans;
        col = col * trans + cl.rgb;
        gl_FragColor = vec4(col * uExposure, 1.0);
      }`,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(90000, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

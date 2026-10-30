// Uniforms and GLSL shared by every material, so lighting and haze agree across the scene.
import * as THREE from 'three';
import { T_ELEV_MAX, T_ELEV_MIN, T_LUT_H, T_LUT_W } from './atmosphere';

export const shared = {
  uSkyLUT: { value: null as THREE.Texture | null },
  uTransLUT: { value: null as THREE.Texture | null },
  uSunDir: { value: new THREE.Vector3(0, 0.2, -1).normalize() },
  /** Direct sunlight reaching the ground (before terrain shadowing). */
  uSunColor: { value: new THREE.Vector3() },
  uAmbTop: { value: new THREE.Vector3() },
  uAmbSide: { value: new THREE.Vector3() },
  uExposure: { value: 1 },
  /** Haze extinction per metre at sea level. */
  uHaze: { value: 2e-5 },
  uFogHeight: { value: 900 },
  uTime: { value: 0 },
  /** Cloud pass output (premultiplied light, coverage) and its direction projection. */
  uClouds: { value: null as THREE.Texture | null },
  uCloudVP: { value: new THREE.Matrix4() },
  uCloudsOn: { value: 0 },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Moon disc brightness (0 when there is no moon). */
  uMoonBright: { value: 0 },
};

export const COMMON_GLSL = /* glsl */ `
uniform sampler2D uSkyLUT;
uniform sampler2D uTransLUT;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbTop;
uniform vec3 uAmbSide;
uniform float uExposure;
uniform float uHaze;
uniform float uFogHeight;
uniform float uTime;
uniform sampler2D uClouds;
uniform mat4 uCloudVP;
uniform float uCloudsOn;
uniform vec3 uMoonDir;
uniform float uMoonBright;

#define PI 3.14159265359

vec2 skyLutUV(vec3 d) {
  float u = atan(d.x, -d.z) / (2.0 * PI) + 0.5;
  float el = asin(clamp(d.y, -1.0, 1.0));
  float l = sign(el) * sqrt(abs(el) / (0.5 * PI));
  return vec2(u, 0.5 + 0.5 * l);
}

vec3 skyLut(vec3 d) {
  return texture2D(uSkyLUT, skyLutUV(d)).rgb;
}

// Sun transmittance from altitude hKm along elevation angle elev (radians).
vec3 transLut(float hKm, float elev) {
  float u = (elev - (${T_ELEV_MIN.toFixed(6)})) / (${(T_ELEV_MAX - T_ELEV_MIN).toFixed(6)});
  float v = sqrt(clamp(hKm / 100.0, 0.0, 1.0));
  u = clamp(u, 0.0, 1.0) * ${((T_LUT_W - 1) / T_LUT_W).toFixed(6)} + ${(0.5 / T_LUT_W).toFixed(6)};
  v = v * ${((T_LUT_H - 1) / T_LUT_H).toFixed(6)} + ${(0.5 / T_LUT_H).toFixed(6)};
  return texture2D(uTransLUT, vec2(u, v)).rgb;
}

vec3 ambientLight(vec3 n) {
  return mix(uAmbSide, uAmbTop, clamp(0.5 + 0.5 * n.y, 0.0, 1.0));
}

// Aerial perspective: haze between the camera and a surface, coloured like the sky
// near the horizon in that direction.
vec3 applyAtmosphere(vec3 col, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 d = v / max(dist, 1e-3);
  vec3 fogDir = normalize(vec3(d.x, max(d.y, 0.035), d.z));
  vec3 inscatter = skyLut(fogDir);
  float k = 1.0 / uFogHeight;
  float h0 = max(cameraPosition.y, 0.0);
  float h1 = max(worldPos.y, 0.0);
  float dh = h1 - h0;
  float avgDensity = abs(dh) < 1.0 ? exp(-h0 * k) : (exp(-h0 * k) - exp(-h1 * k)) / (k * dh);
  vec3 od = uHaze * vec3(0.62, 0.8, 1.0) * avgDensity * dist;
  vec3 T = exp(-od);
  return col * T + inscatter * (1.0 - T);
}

// Clouds in direction d: rgb = light (premultiplied), a = coverage.
vec4 cloudsAt(vec3 d) {
  if (uCloudsOn < 0.5) return vec4(0.0);
  vec4 cc = uCloudVP * vec4(d, 1.0);
  if (cc.w <= 0.0) return vec4(0.0);
  vec2 cuv = cc.xy / cc.w * 0.5 + 0.5;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.015), cuv) * smoothstep(vec2(0.0), vec2(0.015), 1.0 - cuv);
  // Small tent filter hides the raymarch's dither pattern after upsampling.
  vec2 px = 0.6 / vec2(textureSize(uClouds, 0));
  vec2 c0 = clamp(cuv, 0.0, 1.0);
  vec4 cl = texture2D(uClouds, c0 + px) + texture2D(uClouds, c0 + vec2(-px.x, px.y))
    + texture2D(uClouds, c0 + vec2(px.x, -px.y)) + texture2D(uClouds, c0 - px);
  return cl * 0.25 * edge.x * edge.y;
}

// What a mirror-like surface sees in direction d: sky plus clouds (no sun/stars).
vec3 skyReflection(vec3 d) {
  d.y = max(d.y, 0.004);
  d = normalize(d);
  vec4 c = cloudsAt(d);
  return skyLut(d) * (1.0 - c.a) + c.rgb;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Simplex-style value noise helpers for shaders that need them. */
export const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * snoise(p);
    p = r * p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
`;

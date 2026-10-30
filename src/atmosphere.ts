// Earth atmosphere model (Rayleigh + Mie + ozone), in kilometres.
// The CPU side builds the sun transmittance lookup table and estimates ambient light
// and exposure; the GPU side (sky.ts) uses the same constants for the sky itself.
import * as THREE from 'three';

export const RG = 6360; // ground radius
export const RT = 6460; // top of atmosphere
export const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3];
export const RAYLEIGH_H = 8;
export const MIE_SCATTER = 3.996e-3;
export const MIE_EXTINCT = 4.44e-3;
export const MIE_H = 1.2;
export const OZONE = [0.65e-3, 1.881e-3, 0.085e-3];
export const SUN_INTENSITY = 22;

// Transmittance LUT parameterisation: x = elevation angle in [-12°, 90°], y = sqrt(altitude / 100 km).
export const T_LUT_W = 256;
export const T_LUT_H = 64;
export const T_ELEV_MIN = (-12 * Math.PI) / 180;
export const T_ELEV_MAX = Math.PI / 2;

type Vec3 = [number, number, number];

function densities(h: number, mieScale: number): Vec3 {
  const r = Math.exp(-h / RAYLEIGH_H);
  const m = Math.exp(-h / MIE_H) * mieScale;
  const o = Math.max(0, 1 - Math.abs(h - 25) / 15);
  return [r, m, o];
}

/** Transmittance from altitude h (km) along a ray with the given elevation angle, to space. */
export function transmittance(h: number, elev: number, mieScale = 1, steps = 40): Vec3 {
  const r = RG + h;
  const mu = Math.sin(elev);
  // Ground intersection.
  const discG = r * r * (mu * mu - 1) + RG * RG;
  if (mu < 0 && discG >= 0) return [0, 0, 0];
  const discT = r * r * (mu * mu - 1) + RT * RT;
  const len = -r * mu + Math.sqrt(Math.max(0, discT));
  const dt = len / steps;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const hh = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG;
    const [dr, dm, dO] = densities(hh, mieScale);
    odR += dr * dt;
    odM += dm * dt;
    odO += dO * dt;
  }
  return [0, 1, 2].map((c) => Math.exp(-(RAYLEIGH[c] * odR + MIE_EXTINCT * odM + OZONE[c] * odO))) as Vec3;
}

export function buildTransmittanceTexture(mieScale: number): THREE.DataTexture {
  const data = new Float32Array(T_LUT_W * T_LUT_H * 4);
  for (let j = 0; j < T_LUT_H; j++) {
    const v = j / (T_LUT_H - 1);
    const h = v * v * 100;
    for (let i = 0; i < T_LUT_W; i++) {
      const elev = T_ELEV_MIN + (i / (T_LUT_W - 1)) * (T_ELEV_MAX - T_ELEV_MIN);
      const t = transmittance(h, elev, mieScale);
      const k = (j * T_LUT_W + i) * 4;
      data[k] = t[0];
      data[k + 1] = t[1];
      data[k + 2] = t[2];
      data[k + 3] = 1;
    }
  }
  // Half floats filter linearly everywhere WebGL 2 runs (full floats often don't on mobile).
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, T_LUT_W, T_LUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const rayleighPhase = (c: number) => (3 / (16 * Math.PI)) * (1 + c * c);
const miePhase = (c: number, g = 0.8) => {
  const g2 = g * g;
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + c * c))) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
};

/**
 * Single-scattered sky radiance for a view direction from altitude camH (km), with a
 * cheap isotropic multiple-scattering term. Mirrors the GLSL in sky.ts; used on the CPU
 * for ambient light and exposure only.
 */
export function skyRadiance(dir: THREE.Vector3, sun: THREE.Vector3, mieScale: number, camH = 0.01, steps = 24): Vec3 {
  const r0 = RG + camH;
  const mu = dir.y;
  const discT = r0 * r0 * (mu * mu - 1) + RT * RT;
  let len = -r0 * mu + Math.sqrt(Math.max(0, discT));
  const discG = r0 * r0 * (mu * mu - 1) + RG * RG;
  if (mu < 0 && discG >= 0) len = Math.min(len, -r0 * mu - Math.sqrt(discG));
  const cosT = dir.dot(sun);
  const pR = rayleighPhase(cosT);
  const pM = miePhase(cosT);
  const ms = 0.12 / (4 * Math.PI);
  const out: Vec3 = [0, 0, 0];
  const od: Vec3 = [0, 0, 0];
  const dt = len / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = dir.x * t;
    const py = r0 + dir.y * t;
    const pz = dir.z * t;
    const pr = Math.sqrt(px * px + py * py + pz * pz);
    const h = pr - RG;
    const [dr, dm, dO] = densities(h, mieScale);
    const muS = (px * sun.x + py * sun.y + pz * sun.z) / pr;
    const sunT = transmittance(h, Math.asin(Math.max(-1, Math.min(1, muS))), mieScale, 12);
    for (let c = 0; c < 3; c++) {
      od[c] += (RAYLEIGH[c] * dr + MIE_EXTINCT * dm + OZONE[c] * dO) * dt;
      const viewT = Math.exp(-od[c]);
      const scat = RAYLEIGH[c] * dr * (pR + ms) + MIE_SCATTER * dm * (pM + ms);
      out[c] += viewT * sunT[c] * scat * dt * SUN_INTENSITY;
    }
  }
  return out;
}

/** Faint night-sky floor (airglow + starlight), linear radiance. */
export const NIGHT_SKY: Vec3 = [0.00022, 0.00034, 0.00062];

export const luminance = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

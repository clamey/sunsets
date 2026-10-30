// Tiling noise textures for the volumetric clouds, generated once and shared.
//  2D (256²): R = value fbm, G = inverted Worley fbm (puffy cells), B = a second fbm,
//             A = fine fbm (cirrus fibres).
//  3D (64³):  R = Perlin-Worley mix used to erode cloud edges into billows.
import * as THREE from 'three';
import { makeRng } from './rng';

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

function valueLattice(period: number, dims: 2 | 3, rng: () => number) {
  const n = dims === 2 ? period * period : period * period * period;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = rng();
  return v;
}

function value2(lat: Float32Array, P: number, x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = fade(x - xi), ty = fade(y - yi);
  const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P;
  const x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
  const a = lat[y0 * P + x0], b = lat[y0 * P + x1], c = lat[y1 * P + x0], d = lat[y1 * P + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

function value3(lat: Float32Array, P: number, x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const tx = fade(x - xi), ty = fade(y - yi), tz = fade(z - zi);
  const w = (i: number) => ((i % P) + P) % P;
  const x0 = w(xi), y0 = w(yi), z0 = w(zi), x1 = w(xi + 1), y1 = w(yi + 1), z1 = w(zi + 1);
  const at = (X: number, Y: number, Z: number) => lat[(Z * P + Y) * P + X];
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(at(x0, y0, z0), at(x1, y0, z0), tx), l(at(x0, y1, z0), at(x1, y1, z0), tx), ty),
    l(l(at(x0, y0, z1), at(x1, y0, z1), tx), l(at(x0, y1, z1), at(x1, y1, z1), tx), ty),
    tz,
  );
}

/** Inverted periodic Worley noise in [0, 1] (1 at feature points). */
function worley(points: Float32Array, C: number, dims: 2 | 3, x: number, y: number, z = 0) {
  const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
  let best = 9;
  const zr = dims === 3 ? 1 : 0;
  for (let dz = -zr; dz <= zr; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const X = cx + dx, Y = cy + dy, Z = cz + dz;
        const wx = ((X % C) + C) % C, wy = ((Y % C) + C) % C, wz = ((Z % C) + C) % C;
        const k = (dims === 3 ? (wz * C + wy) * C + wx : wy * C + wx) * 3;
        const px = X + points[k] - x, py = Y + points[k + 1] - y, pz = dims === 3 ? Z + points[k + 2] - z : 0;
        const d = px * px + py * py + pz * pz;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

function featurePoints(C: number, dims: 2 | 3, rng: () => number) {
  const n = (dims === 3 ? C * C * C : C * C) * 3;
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = rng();
  return p;
}

let cached: { tex2: THREE.DataTexture; tex3: THREE.Data3DTexture } | null = null;

export function cloudNoise() {
  if (cached) return cached;
  const rng = makeRng(1234567);

  const N2 = 256;
  const d2 = new Uint8Array(N2 * N2 * 4);
  const fbmSpec = (periods: number[]) => periods.map((P) => ({ P, lat: valueLattice(P, 2, rng) }));
  const fA = fbmSpec([4, 8, 16, 32, 64]);
  const fB = fbmSpec([4, 8, 16, 32, 64]);
  const fC = fbmSpec([16, 32, 64, 128]);
  const wSpec = [4, 8, 16].map((C) => ({ C, pts: featurePoints(C, 2, rng) }));
  const fbm2 = (spec: { P: number; lat: Float32Array }[], u: number, v: number) => {
    let s = 0, a = 0.5, norm = 0;
    for (const { P, lat } of spec) {
      s += a * value2(lat, P, u * P, v * P);
      norm += a;
      a *= 0.5;
    }
    return s / norm;
  };
  for (let j = 0; j < N2; j++) {
    for (let i = 0; i < N2; i++) {
      const u = i / N2, v = j / N2;
      let w = 0, a = 0.6, norm = 0;
      for (const { C, pts } of wSpec) {
        w += a * worley(pts, C, 2, u * C, v * C);
        norm += a;
        a *= 0.45;
      }
      const k = (j * N2 + i) * 4;
      d2[k] = Math.round(255 * fbm2(fA, u, v));
      d2[k + 1] = Math.round(255 * (w / norm));
      d2[k + 2] = Math.round(255 * fbm2(fB, u, v));
      d2[k + 3] = Math.round(255 * fbm2(fC, u, v));
    }
  }
  const tex2 = new THREE.DataTexture(d2, N2, N2, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex2.wrapS = tex2.wrapT = THREE.RepeatWrapping;
  tex2.minFilter = THREE.LinearMipmapLinearFilter;
  tex2.magFilter = THREE.LinearFilter;
  tex2.generateMipmaps = true;
  tex2.needsUpdate = true;

  const N3 = 64;
  const d3 = new Uint8Array(N3 * N3 * N3);
  const lat3 = [4, 8, 16].map((P) => ({ P, lat: valueLattice(P, 3, rng) }));
  const w3 = [4, 8, 16].map((C) => ({ C, pts: featurePoints(C, 3, rng) }));
  for (let z = 0; z < N3; z++) {
    for (let y = 0; y < N3; y++) {
      for (let x = 0; x < N3; x++) {
        const u = x / N3, v = y / N3, t = z / N3;
        let p = 0, a = 0.5, norm = 0;
        for (const { P, lat } of lat3) {
          p += a * value3(lat, P, u * P, v * P, t * P);
          norm += a;
          a *= 0.5;
        }
        p /= norm;
        let w = 0;
        a = 0.6;
        norm = 0;
        for (const { C, pts } of w3) {
          w += a * worley(pts, C, 3, u * C, v * C, t * C);
          norm += a;
          a *= 0.45;
        }
        w /= norm;
        // Perlin-Worley: billowy cells with soft variation.
        const pw = Math.min(1, Math.max(0, w * 0.75 + p * 0.45 - 0.1));
        d3[(z * N3 + y) * N3 + x] = Math.round(255 * pw);
      }
    }
  }
  const tex3 = new THREE.Data3DTexture(d3, N3, N3, N3);
  tex3.format = THREE.RedFormat;
  tex3.type = THREE.UnsignedByteType;
  tex3.wrapS = tex3.wrapT = tex3.wrapR = THREE.RepeatWrapping;
  tex3.minFilter = THREE.LinearFilter;
  tex3.magFilter = THREE.LinearFilter;
  tex3.unpackAlignment = 1;
  tex3.needsUpdate = true;

  cached = { tex2, tex3 };
  return cached;
}

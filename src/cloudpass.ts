// Volumetric clouds, raymarched at reduced resolution into a texture that the sky dome
// (and therefore the water reflection) samples. The texture is rendered from a "cloud
// camera" at the viewer's position whose frustum covers the visible sky plus the steeper
// directions that nearby water reflects.
import * as THREE from 'three';
import { type CloudLayer } from './clouds';
import { cloudNoise } from './noise';
import { COMMON_GLSL, shared } from './shared';
import { ATMO_GLSL } from './sky';

export const MAX_CLOUD_LAYERS = 3;
const DEG = Math.PI / 180;
const BOTTOM_ELEV = -4 * DEG;
const TOP_ELEV = 72 * DEG;

const FRAG = /* glsl */ `
${COMMON_GLSL}
${ATMO_GLSL}
precision highp sampler3D;
uniform sampler2D uNoise2D;
uniform sampler3D uNoise3D;
uniform vec2 uTanHalf;
uniform mat3 uCamRot;
uniform float uCamAlt;
uniform vec2 uSunAz;
uniform int uLayerCount;
uniform vec4 uLA[${MAX_CLOUD_LAYERS}]; // base km, thickness km, coverage, sigma
uniform vec4 uLB[${MAX_CLOUD_LAYERS}]; // type, scale km, gap km, erode
uniform vec4 uLC[${MAX_CLOUD_LAYERS}]; // wind offset x, z (km), evolve, wind angle
varying vec2 vUv;

float sat(float x) { return clamp(x, 0.0, 1.0); }
float hgRel(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }

vec4 n2(vec2 uv) { return textureLod(uNoise2D, uv, 0.0); }

// Horizontal coverage in [0, 1] at wind-shifted position w (km).
float coverageAt(vec2 w, vec4 A, vec4 B, vec4 C) {
  vec2 wd = vec2(cos(C.w), sin(C.w));
  vec2 r = vec2(dot(w, wd), dot(w, vec2(-wd.y, wd.x)));
  vec2 uv = r / (B.y * 8.0);
  float ev = C.z;
  float c;
  if (B.x < 0.5) {
    vec4 a = n2(uv + vec2(ev, -ev * 0.6));
    vec4 b = n2(mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.31 + 0.31 - ev * 0.4);
    c = a.g * 0.6 + a.r * 0.3 + (b.r - 0.5) * 0.7 + 0.05;
  } else if (B.x < 2.5) {
    // Cloudlets in loose rows across the wind, clumped into patches.
    vec2 u2 = vec2(uv.x, uv.y * 1.6) * 2.0;
    u2 += (n2(uv * 0.7 + ev).rb - 0.5) * 0.35;
    vec4 a = n2(u2 + ev);
    vec4 b = n2(uv * 0.22 - ev * 0.3 + 0.5);
    c = (a.g * 0.6 + a.r * 0.5 - 0.05) * mix(0.45, 1.15, smoothstep(0.3, 0.65, b.r));
  } else {
    // Stratocumulus deck: lumpy cells with thin spots and the odd gap.
    vec2 u2 = uv * 2.2 + (n2(uv * 0.6 + ev).rb - 0.5) * 0.3;
    vec4 a = n2(u2 + ev);
    vec4 b = n2(uv * 0.27 - ev * 0.5 + 0.21);
    c = 0.2 + 0.7 * a.g + 0.25 * a.r + 0.35 * (b.b - 0.5);
  }
  return sat((c - (1.0 - A.z)) / max(A.z, 0.05));
}

float density(vec3 p, float h, vec4 A, vec4 B, vec4 C, bool detail) {
  float hf = (h - A.x) / A.y;
  if (hf < 0.0 || hf > 1.0) return 0.0;
  vec2 w = p.xz + C.xy;
  float base = coverageAt(w, A, B, C);
  if (B.z > 0.0) {
    float along = dot(p.xz, uSunAz) + (n2(p.xz / 60.0).r - 0.5) * B.z * 0.35;
    base *= 1.0 - smoothstep(B.z * 0.75, B.z, along);
  }
  if (base <= 0.0) return 0.0;
  float prof;
  if (B.x < 0.5) {
    // Flat bases, domed tops: stronger coverage builds taller heaps.
    float top = 0.2 + 0.8 * pow(base, 0.65);
    prof = smoothstep(0.0, 0.06, hf) * (1.0 - smoothstep(top * 0.7, top, hf));
  } else if (B.x < 2.5) {
    float top = 0.45 + 0.55 * base;
    prof = smoothstep(0.0, 0.25, hf) * (1.0 - smoothstep(top * 0.55, top, hf));
  } else {
    // Lumpy base and top so the underside catches light unevenly.
    float lift = 0.35 * (1.0 - base);
    prof = smoothstep(lift, lift + 0.15, hf) * (1.0 - smoothstep(0.55 + 0.4 * base, 1.0, hf));
  }
  // Keep a gradient from edge to core so erosion carves billows, not just a fringe.
  float d = sat(base * 1.6) * sqrt(prof);
  if (d <= 0.0 || !detail) return d;
  vec3 q = vec3(w.x, h * 1.3, w.y) / (B.y * 0.45) + vec3(C.z * 4.0, C.z * 6.0, 0.0);
  // Big billows shape the silhouette; small ones roughen it.
  float big = textureLod(uNoise3D, q * 0.33, 0.0).r;
  float small = textureLod(uNoise3D, q * 1.3 + 0.37, 0.0).r;
  // Wispier toward the top, firmer near the flat base.
  float e = B.w * (0.55 + 0.9 * hf) * (0.6 * (1.0 - big) + 0.4 * (1.0 - small));
  return sat((d - e) / max(1.0 - e, 0.05)) * 1.6;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uCamRot * vec3(ndc.x * uTanHalf.x, ndc.y * uTanHalf.y, -1.0));
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 skyCol = skyLut(dir);
  float cosT = dot(dir, uSunDir);
  float phase = mix(hgRel(cosT, 0.6), hgRel(cosT, -0.15), 0.5) / (4.0 * PI);
  float sunEl0 = asin(clamp(uSunDir.y, -1.0, 1.0));
  float r0 = RG + uCamAlt;
  float b = r0 * dir.y;

  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < ${MAX_CLOUD_LAYERS}; i++) {
    if (i >= uLayerCount) break;
    vec4 A = uLA[i], B = uLB[i], C = uLC[i];
    float rb = RG + A.x;
    float t0 = -b + sqrt(b * b - (r0 * r0 - rb * rb));
    if (t0 > 300.0) continue;
    vec3 lcol = vec3(0.0);
    float lT = 1.0;

    if (A.y <= 0.0) {
      // Thin sheet (cirrus): fibrous streaks along the wind.
      vec3 p = dir * t0;
      vec2 w = p.xz + C.xy;
      vec2 wd = vec2(cos(C.w), sin(C.w));
      vec2 r = vec2(dot(w, wd), dot(w, vec2(-wd.y, wd.x))) / (B.y * 8.0);
      float lod = clamp(log2(t0 / (B.y * 8.0) * 256.0 * 0.004), 0.0, 6.0);
      r.y += (textureLod(uNoise2D, r * 0.5 + C.z, lod).b - 0.5) * 0.25;
      float base = textureLod(uNoise2D, r * vec2(0.5, 0.9) + C.z * 0.5, lod).r;
      float fib = textureLod(uNoise2D, vec2(r.x * 0.9, r.y * 7.0) + C.z, lod).a;
      float fib2 = textureLod(uNoise2D, vec2(r.x * 1.7, r.y * 19.0) - C.z, lod + 1.0).a;
      float n = base * 0.62 + fib * 0.3 + fib2 * 0.18 - 0.08;
      float dens = smoothstep(1.0 - A.z, 1.0 - A.z + 0.32, n) * A.w;
      float alpha = 1.0 - exp(-dens * 1.6);
      float sunEl = sunEl0 + dot(p.xz, uSunAz) / RG;
      vec3 sunT = transLut(A.x, sunEl) * SUN_I;
      vec3 S = sunT * phase * 2.2 + (uAmbTop * 0.6 + uAmbSide * 0.4) / PI * 0.7;
      lcol = S * alpha;
      lT = 1.0 - alpha;
    } else {
      // Volumetric slab.
      float rt = rb + A.y;
      float t1 = -b + sqrt(b * b - (r0 * r0 - rt * rt));
      // Steps sized to the slab, so shallow rays through distant clouds aren't undersampled.
      float len = min(t1 - t0, A.y * 6.0);
      int N = int(clamp(len / (A.y * 0.06), 10.0, 40.0));
      float dt = len / float(N);
      for (int s = 0; s < 40; s++) {
        if (s >= N) break;
        float t = t0 + (float(s) + jitter) * dt;
        vec3 p = dir * t;
        float h = length(p + vec3(0.0, r0, 0.0)) - RG;
        float d = density(p, h, A, B, C, true);
        if (d < 0.004) continue;
        // Light reaching this point: march toward the sun through the cloud.
        float od = 0.0;
        float ls = A.y * 0.06;
        vec3 lp = p;
        for (int k = 0; k < 4; k++) {
          lp += uSunDir * ls;
          float lh = length(lp + vec3(0.0, r0, 0.0)) - RG;
          od += density(lp, lh, A, B, C, false) * A.w * ls;
          ls *= 2.0;
        }
        float hf = sat((h - A.x) / A.y);
        float sunEl = sunEl0 + dot(p.xz, uSunAz) / RG;
        vec3 sunT = transLut(max(h, 0.0), sunEl) * SUN_I;
        // Beer's law with a long tail standing in for multiple scattering.
        float beer = max(exp(-od), 0.65 * exp(-od * 0.22));
        vec3 amb = mix(uAmbSide * 0.45, uAmbTop, hf) / PI * 0.85;
        vec3 S = sunT * phase * beer * 3.0 + amb;
        float a = exp(-d * A.w * dt);
        lcol += lT * S * (1.0 - a);
        lT *= a;
        if (lT < 0.01) break;
      }
    }

    // Aerial perspective: distant clouds take on the colour of the air in front.
    float fog = exp(-t0 / (A.x < 3.0 ? 90.0 : 170.0));
    lcol = lcol * fog + skyCol * (1.0 - lT) * (1.0 - fog);
    col += T * lcol;
    T *= lT;
    if (T < 0.01) break;
  }
  gl_FragColor = vec4(col, 1.0 - T);
}`;

export class CloudPass {
  readonly target: THREE.WebGLRenderTarget;
  /** Projects a world direction (as a point at unit distance) into the cloud texture. */
  readonly viewProj = new THREE.Matrix4();
  private camera = new THREE.PerspectiveCamera();
  private scene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;

  constructor(private layers: CloudLayer[], camAltKm: number, sunAz: THREE.Vector2) {
    this.target = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const { tex2, tex3 } = cloudNoise();
    this.uniforms = {
      ...shared,
      uNoise2D: { value: tex2 },
      uNoise3D: { value: tex3 },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uCamRot: { value: new THREE.Matrix3() },
      uCamAlt: { value: camAltKm },
      uSunAz: { value: sunAz },
      uLayerCount: { value: Math.min(layers.length, MAX_CLOUD_LAYERS) },
      uLA: { value: Array.from({ length: MAX_CLOUD_LAYERS }, () => new THREE.Vector4()) },
      uLB: { value: Array.from({ length: MAX_CLOUD_LAYERS }, () => new THREE.Vector4()) },
      uLC: { value: Array.from({ length: MAX_CLOUD_LAYERS }, () => new THREE.Vector4()) },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  get hasClouds() {
    return this.layers.length > 0;
  }

  /** Fit the cloud camera around the main camera's view. quality ~ fraction of screen resolution. */
  configure(main: THREE.PerspectiveCamera, drawWidth: number, quality: number) {
    const tanMainH = Math.tan((main.fov * DEG) / 2) * main.aspect;
    const hfov = Math.min(2 * Math.atan(tanMainH) + 24 * DEG, 150 * DEG);
    const vfov = TOP_ELEV - BOTTOM_ELEV;
    const tx = Math.tan(hfov / 2);
    const ty = Math.tan(vfov / 2);
    const cam = this.camera;
    cam.position.copy(main.position);
    cam.rotation.set((TOP_ELEV + BOTTOM_ELEV) / 2, 0, 0, 'YXZ');
    cam.fov = vfov / DEG;
    cam.aspect = tx / ty;
    cam.near = 0.1;
    cam.far = 10;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
    this.uniforms.uCamRot.value.setFromMatrix4(rot);
    (this.uniforms.uTanHalf.value as THREE.Vector2).set(tx, ty);
    this.viewProj.copy(cam.projectionMatrix).multiply(rot.clone().transpose());

    const width = THREE.MathUtils.clamp(Math.round(quality * drawWidth * (tx / tanMainH)), 64, 2048);
    const height = THREE.MathUtils.clamp(Math.round((width * ty) / tx), 64, 2048);
    this.target.setSize(width, height);
  }

  /** cloudTime: seconds of (accelerated) cloud time. */
  update(cloudTime: number) {
    this.layers.slice(0, MAX_CLOUD_LAYERS).forEach((l, i) => {
      (this.uniforms.uLA.value[i] as THREE.Vector4).set(l.base, l.thickness, l.coverage, l.sigma);
      (this.uniforms.uLB.value[i] as THREE.Vector4).set(l.type, l.scale, l.gap, l.erode);
      const wx = Math.cos(l.windAngle) * l.windSpeed * cloudTime;
      const wz = Math.sin(l.windAngle) * l.windSpeed * cloudTime;
      (this.uniforms.uLC.value[i] as THREE.Vector4).set(-wx, -wz, l.evolve * cloudTime, l.windAngle);
    });
  }

  render(renderer: THREE.WebGLRenderer) {
    if (!this.hasClouds) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.quadCam);
    renderer.setRenderTarget(prev);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

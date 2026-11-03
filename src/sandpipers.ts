// Sandpipers working the swash: little flocks that chase each backwash down the sand,
// pecking at what it leaves, and scurry back up ahead of the next wave. Like the birds
// overhead they live in real time, and they leave the beach as the light goes.
import * as THREE from 'three';
import type { Sandpipers as SandpiperSetting } from './config';
import { type Rng, clamp, range, smoothstep } from './rng';
import { COMMON_GLSL, shared } from './shared';
import { type Shore, type SwashEdge, shoreline } from './terrain';

const MAX_PIPERS = 64;
/** Leg length (m): the hip is here, the feet at 0. */
const LEG = 0.05;

interface Piper {
  x: number;
  /** Metres up the beach from the still-water line. */
  up: number;
  vx: number;
  vUp: number;
  heading: number;
  /** Which way it turns to face while standing. */
  face: number;
  /** How far above the water this bird likes to stay (m). */
  gap: number;
  /** Place in the flock, alongshore (m). */
  lane: number;
  /** How far ahead (s) it sees a wave coming. */
  lookahead: number;
  stride: number;
  peckT: number;
  nextPeck: number;
  scale: number;
}

interface Group {
  cx: number;
  home: number;
  wander: number;
  /** Which way it runs off, and how dark it gets before it does. */
  side: number;
  leaveAt: number;
  birds: Piper[];
}

function piperGeometry(): THREE.BufferGeometry {
  // Body along +x (heading), feet at the origin.
  const pos: number[] = [];
  const col: number[] = [];
  const leg: number[] = [];
  const BACK = [0.6, 0.57, 0.52];
  const BELLY = [0.93, 0.92, 0.9];
  const DARK = [0.05, 0.045, 0.04];
  const blob = (sx: number, sy: number, sz: number, cx: number, cy: number, tilt: number) => {
    const g = new THREE.SphereGeometry(1, 8, 6).toNonIndexed();
    const p = g.getAttribute('position');
    const c = Math.cos(tilt), s = Math.sin(tilt);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) * sx, y = p.getY(i) * sy, z = p.getZ(i) * sz;
      pos.push(cx + x * c - y * s, cy + x * s + y * c, z);
      col.push(...(p.getY(i) > 0.05 ? BACK : BELLY));
      leg.push(0);
    }
    g.dispose();
  };
  blob(0.085, 0.032, 0.03, -0.01, LEG + 0.03, 0.12); // body, tail a little low
  blob(0.021, 0.02, 0.019, 0.07, LEG + 0.058, 0); // head
  // Beak: a thin black wedge.
  const bx = 0.086, by = LEG + 0.055;
  for (const [a, b, c] of [
    [[bx, by + 0.005, 0.004], [bx, by - 0.004, 0.004], [bx + 0.03, by - 0.006, 0]],
    [[bx, by + 0.005, -0.004], [bx + 0.03, by - 0.006, 0], [bx, by - 0.004, -0.004]],
    [[bx, by + 0.005, 0.004], [bx + 0.03, by - 0.006, 0], [bx, by + 0.005, -0.004]],
  ]) {
    pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) {
      col.push(...DARK);
      leg.push(0);
    }
  }
  // Legs: thin dark quads, swung in the vertex shader.
  for (const side of [1, -1]) {
    const z = side * 0.012, w = 0.006;
    const quad = [[-w, 0], [w, 0], [w, LEG + 0.01], [-w, 0], [w, LEG + 0.01], [-w, LEG + 0.01]];
    for (const [x, y] of quad) {
      pos.push(x, y, z);
      col.push(...DARK);
      leg.push(side);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aLeg', new THREE.Float32BufferAttribute(leg, 1));
  g.computeVertexNormals();
  return g;
}

export class SandpiperSystem {
  readonly mesh: THREE.InstancedMesh;
  private groups: Group[] = [];
  private placed = false;
  private animAttr: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(
    private rng: Rng,
    setting: SandpiperSetting,
    private shore: Shore,
    private edge: SwashEdge,
  ) {
    const geo = piperGeometry();
    this.animAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIPERS * 2), 2);
    geo.setAttribute('iAnim', this.animAttr);
    this.mesh = new THREE.InstancedMesh(geo, piperMaterial(), MAX_PIPERS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;

    // Flocks spread across the near shore, where they're in view (about ±12 m across).
    const flocks = setting === 'none' ? 0 : setting === 'some' ? 1 : 2 + (rng() < 0.5 ? 1 : 0);
    let total = 0;
    for (let f = 0; f < flocks; f++) {
      const size = setting === 'some' ? 3 + Math.floor(rng() * 5) : 8 + Math.floor(rng() * 9);
      const home = flocks === 1 ? range(rng, -6, 6) : -8 + (16 * (f + range(rng, 0.2, 0.8))) / flocks;
      const birds: Piper[] = [];
      for (let i = 0; i < size && total < MAX_PIPERS; i++, total++) {
        birds.push({
          x: 0,
          up: 0,
          vx: 0,
          vUp: 0,
          heading: rng() * Math.PI * 2,
          face: rng() * Math.PI * 2,
          gap: range(rng, 0.2, 1.1),
          lane: (i - size / 2) * range(rng, 0.35, 0.7) + range(rng, -0.3, 0.3),
          lookahead: range(rng, 0.4, 0.9),
          stride: rng() * 6.28,
          peckT: 0,
          nextPeck: range(rng, 0.2, 1.5),
          scale: range(rng, 0.95, 1.15),
        });
      }
      this.groups.push({ cx: home, home, wander: rng() * 6.28, side: home < 0 ? -1 : 1, leaveAt: range(rng, 0.15, 0.4), birds });
    }
  }

  /** time: the scene clock (s), which the swash runs on; dt: real seconds; daylight 0..1. */
  update(time: number, dt: number, daylight: number, sunVis: number) {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uSunVis.value = sunVis;
    if (!this.groups.length) return;
    const rng = this.rng;
    const first = !this.placed;
    this.placed = true;
    let n = 0;
    for (const g of this.groups) {
      // Flocks drift slowly along the beach, and run off it once it gets dark.
      const leaving = daylight < g.leaveAt;
      const gx = leaving ? g.side * 60 : g.home + 3 * Math.sin(time * 0.03 + g.wander);
      if (first) g.cx = gx;
      const drift = leaving ? 1.6 : 0.25;
      g.cx += clamp(gx - g.cx, -drift * dt, drift * dt);

      for (const b of g.birds) {
        const water = this.edge.at(b.x, time);
        if (first) {
          b.x = g.cx + b.lane;
          b.up = water + b.gap + 0.5;
        }
        // Keep just above the water: scurry up ahead of a wave that's coming (they see it
        // a moment before it arrives), and follow the backwash down at a trot.
        const target = Math.max(water, this.edge.at(b.x, time + b.lookahead)) + b.gap;
        const dUp = target - b.up;
        const wantUp = Math.abs(dUp) < 0.12 ? 0 : clamp(dUp * 3, -1.4, 4.5);
        const dX = g.cx + b.lane - b.x;
        const runX = leaving ? 2.5 : 0.7;
        const wantX = Math.abs(dX) < 0.25 ? 0 : clamp(dX * 1.5, -runX, runX);
        b.vUp += clamp(wantUp - b.vUp, -18 * dt, 18 * dt);
        b.vx += clamp(wantX - b.vx, -8 * dt, 8 * dt);
        const x0 = b.x, up0 = b.up;
        b.x += b.vx * dt;
        // The water never catches them.
        b.up = Math.max(b.up + b.vUp * dt, water + 0.12);
        const mx = (b.x - x0) / Math.max(dt, 1e-3);
        const mUp = (b.up - up0) / Math.max(dt, 1e-3);
        const speed = Math.hypot(mx, mUp);

        // Face where they're running. Standing, they turn now and then, mostly side-on to
        // the slope (along the beach) and sometimes toward the water.
        if (speed < 0.15 && rng() < dt * 0.35) {
          b.face = rng() < 0.7 ? (rng() < 0.5 ? 0 : Math.PI) + range(rng, -0.5, 0.5) : Math.PI / 2 + range(rng, -0.8, 0.8);
        }
        const want = speed > 0.15 ? Math.atan2(-mUp, mx) : b.face;
        const turn = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
        b.heading += turn * Math.min(1, dt * (speed > 0.15 ? 14 : 5));

        // Legs whirr when running; standing still, they probe the wet sand.
        const run = smoothstep(0.05, 0.4, speed);
        b.stride += dt * Math.min(speed / 0.1, 13) * Math.PI * 2;
        let peck = 0;
        if (speed < 0.1) {
          b.nextPeck -= dt;
          if (b.nextPeck <= 0 && b.peckT <= 0) {
            b.peckT = 0.35;
            b.nextPeck = range(rng, 0.25, 1.6);
          }
        }
        if (b.peckT > 0) {
          b.peckT -= dt;
          peck = Math.sin(Math.PI * (1 - Math.max(b.peckT, 0) / 0.35));
        }

        if (Math.abs(b.x) > 45 || n >= MAX_PIPERS) continue;
        const ground = b.up * this.shore.foreshore;
        const bob = Math.abs(Math.sin(b.stride)) * 0.008 * run;
        this.p.set(b.x, ground + bob, -shoreline(this.shore, b.x) + b.up);
        this.e.set(0, b.heading, -0.75 * peck);
        this.q.setFromEuler(this.e);
        this.s.setScalar(b.scale);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        this.animAttr.setXY(n, b.stride, run);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.animAttr.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function piperMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSunVis: { value: 1 } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aLeg;
      attribute vec2 iAnim; // stride phase, how much it's running
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        vec3 p = position;
        if (aLeg != 0.0) {
          // Each leg swings from the hip, opposite the other; feet lift on the way forward.
          float ph = iAnim.x + (aLeg > 0.0 ? 0.0 : 3.1416);
          float down = 1.0 - p.y / ${(LEG + 0.01).toFixed(3)};
          p.x += sin(ph) * 0.035 * iAnim.y * down;
          p.y += max(cos(ph), 0.0) * 0.012 * iAnim.y * down;
        }
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vColor = aColor;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      uniform float uSunVis;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorld);
        if (dot(n, V) < 0.0) n = -n;
        float ndl = max(dot(n, uSunDir), 0.0);
        // Against the low sun they're mostly silhouettes, with a bright rim.
        float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0) * pow(max(dot(-V, uSunDir), 0.0), 4.0);
        vec3 col = vColor * (uSunColor * uSunVis * (ndl + rim * 0.8) + ambientLight(n));
        col = applyAtmosphere(col, vWorld);
        gl_FragColor = vec4(col * uExposure, 1.0);
      }`,
  });
}

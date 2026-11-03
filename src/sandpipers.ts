// Sandpipers working the swash: little flocks that chase each backwash down the sand,
// pecking at what it leaves, and scurry back up ahead of the next wave, or flutter up over
// one that would catch them. Now and then a whole flock takes off together, swings out over
// the water and lands further along the beach, or leaves for a while. Like the birds
// overhead they live in real time, and they fly off as the light goes.
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
  /** How far ahead (s) it sees a wave coming, and how slow it is to follow one back. */
  lookahead: number;
  lag: number;
  /** Its own pace: sprint up, trot down, how eagerly it closes the gap, how fast it turns. */
  sprint: number;
  trot: number;
  eager: number;
  turnRate: number;
  /** Each run angles a little along the beach, differently every time. */
  slant: number;
  running: boolean;
  /** How far off its spot it lets itself get before it bothers to move. */
  slack: number;
  /** Wandering from its place in the flock, and when it next changes its mind. */
  roam: number;
  fidget: number;
  stride: number;
  peckT: number;
  nextPeck: number;
  scale: number;
  /** Height above the sand (m) while flying. */
  alt: number;
  /** How far the wings are spread (0 folded, 1 flying), and the wingbeat phase. */
  fly: number;
  flap: number;
  /** A short flutter up over a wave, and how long until it will do that again. */
  hop: { t: number; dur: number; x0: number; up0: number; x1: number; up1: number; h: number } | null;
  hopCool: number;
  /** Where it took off from, and how long after the first bird, when the flock flies. */
  sx: number;
  sUp: number;
  delay: number;
}

/** A flock's flight: out over the water and back in at x1, or off out of view. */
interface Flight {
  t: number;
  dur: number;
  x1: number;
  out: number;
  h: number;
  away: boolean;
}

interface Group {
  cx: number;
  home: number;
  wander: number;
  /** Which way it leaves, and how dark it gets before it does. */
  side: number;
  leaveAt: number;
  flight: Flight | null;
  /** Gone from the beach, and for how much longer. */
  away: boolean;
  awayFor: number;
  nextFlush: number;
  birds: Piper[];
}

const OFFSCREEN = 70;

function piperGeometry(): THREE.BufferGeometry {
  // Body along +x (heading), feet at the origin.
  const pos: number[] = [];
  const col: number[] = [];
  const leg: number[] = [];
  const wing: number[] = [];
  const legP: number[] = [];
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
      wing.push(0, 0, 0);
      legP.push(0, 0, 0);
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
      wing.push(0, 0, 0);
      legP.push(0, 0, 0);
    }
  }
  // Legs: two thin segments each, hip to ankle to foot, posed in the vertex shader. As
  // (segment, distance along it, side to side).
  const LEGC = [0.24, 0.22, 0.2];
  for (const side of [1, -1]) {
    for (const seg of [0, 1]) {
      for (const [t, a] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]) {
        pos.push(0, LEG * (1 - (seg + t) / 2), side * 0.012);
        col.push(...LEGC);
        leg.push(side);
        wing.push(0, 0, 0);
        legP.push(seg, t, a);
      }
    }
  }
  // Wings, as (span, chord) from the shoulder; the vertex shader folds them along the
  // back or spreads and beats them.
  const WING = [0.34, 0.32, 0.3];
  for (const side of [1, -1]) {
    for (const [a, c] of [[0, 0], [0, 0.05], [0.1, 0.045], [0, 0], [0.1, 0.045], [0.1, 0], [0.1, 0], [0.1, 0.045], [0.2, 0.04]]) {
      pos.push(-c, LEG + 0.048, side * a);
      col.push(...WING);
      leg.push(0);
      wing.push(a, c, side);
      legP.push(0, 0, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aLeg', new THREE.Float32BufferAttribute(leg, 1));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 3));
  g.setAttribute('aLegP', new THREE.Float32BufferAttribute(legP, 3));
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
    this.animAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PIPERS * 4), 4);
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
          lookahead: range(rng, 0.2, 1.2),
          lag: range(rng, 0, 0.6),
          sprint: range(rng, 3.2, 5),
          trot: range(rng, 0.8, 1.8),
          eager: range(rng, 2, 4.5),
          turnRate: range(rng, 8, 18),
          slant: 0,
          running: false,
          slack: range(rng, 0.2, 0.7),
          roam: 0,
          fidget: range(rng, 0, 6),
          stride: rng() * 6.28,
          peckT: 0,
          nextPeck: range(rng, 0.2, 1.5),
          scale: range(rng, 0.95, 1.15),
          alt: 0,
          fly: 0,
          flap: rng() * 6.28,
          hop: null,
          hopCool: 0,
          sx: 0,
          sUp: 0,
          delay: 0,
        });
      }
      this.groups.push({
        cx: home,
        home,
        wander: rng() * 6.28,
        side: home < 0 ? -1 : 1,
        leaveAt: range(rng, 0.15, 0.4),
        flight: null,
        away: false,
        awayFor: 0,
        nextFlush: range(rng, 20, 80),
        birds,
      });
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
      const leaving = daylight < g.leaveAt;
      if (first && leaving) g.away = true;

      // Now and then the flock takes off: to land further along the beach, or to go
      // somewhere else for a while. They all fly off as it gets dark.
      if (!g.flight) {
        if (!g.away) {
          g.nextFlush -= dt;
          if (leaving) this.takeoff(g, g.side * OFFSCREEN, true);
          else if (g.nextFlush <= 0) {
            if (rng() < 0.35) {
              g.side = rng() < 0.5 ? -1 : 1;
              this.takeoff(g, g.side * OFFSCREEN, true);
            } else {
              this.takeoff(g, clamp(g.home + range(rng, 4, 9) * (rng() < 0.5 ? -1 : 1), -9, 9), false);
            }
          }
        } else if (!leaving && (g.awayFor -= dt) <= 0) {
          // Back from wherever they went, landing somewhere new.
          g.away = false;
          g.home = range(rng, -8, 8);
          for (const b of g.birds) {
            b.x = g.side * OFFSCREEN + b.lane;
            b.up = range(rng, 0, 6);
          }
          this.takeoff(g, g.home, false);
        }
      }
      if (g.away && !g.flight) continue;

      const f = g.flight;
      if (f) {
        f.t += dt;
        if (f.t > f.dur + 0.5) {
          g.flight = null;
          g.nextFlush = range(rng, 30, 100);
          if (f.away) {
            g.away = true;
            g.awayFor = range(rng, 20, 60);
          } else {
            g.home = g.cx = f.x1;
          }
        }
      } else {
        // Flocks drift slowly along the beach.
        const gx = g.home + 3 * Math.sin(time * 0.03 + g.wander);
        if (first) g.cx = gx;
        g.cx += clamp(gx - g.cx, -0.25 * dt, 0.25 * dt);
      }

      for (const b of g.birds) {
        const x0 = b.x, up0 = b.up;
        let airborne = false;
        let water = 0;
        if (f) {
          // Out over the water in a long curve, and back in to land above the swash.
          const s = clamp((f.t - b.delay) / f.dur, 0, 1);
          const e = s * s * (3 - 2 * s);
          const xEnd = f.x1 + b.lane;
          const upEnd = f.away ? 3 : this.edge.at(xEnd, time) + b.gap + 0.3;
          b.x = b.sx + (xEnd - b.sx) * e;
          b.up = b.sUp + (upEnd - b.sUp) * e - f.out * Math.sin(Math.PI * s);
          b.alt = f.h * Math.sin(Math.PI * s);
          airborne = s > 0 && s < 1;
          if (s >= 1) {
            b.vx = b.vUp = 0;
            b.alt = 0;
          }
        } else if (b.hop) {
          const h = b.hop;
          h.t += dt;
          const s = Math.min(h.t / h.dur, 1);
          b.x = h.x0 + (h.x1 - h.x0) * s;
          b.up = h.up0 + (h.up1 - h.up0) * s;
          b.alt = h.h * Math.sin(Math.PI * s);
          airborne = true;
          if (s >= 1) {
            b.hop = null;
            b.alt = 0;
            b.vx = b.vUp = 0;
          }
        } else {
          water = this.edge.at(b.x, time);
          if (first) {
            b.x = g.cx + b.lane;
            b.up = water + b.gap + 0.5;
          }
          // Every few seconds it changes its mind about where to be: nearer the water or
          // further, a bit along the beach.
          b.fidget -= dt;
          if (b.fidget <= 0) {
            b.fidget = range(rng, 3, 9);
            b.gap = range(rng, 0.15, 1.3);
            b.roam = range(rng, -1.2, 1.2);
          }
          // Keep just above the water: scurry up ahead of a wave that's coming (each sees it
          // a different moment before it arrives), and follow the backwash down at a trot,
          // some promptly and some a while later.
          const target = Math.max(water, this.edge.at(b.x, time - b.lag), this.edge.at(b.x, time + b.lookahead)) + b.gap;
          const dUp = target - b.up;
          // A wave coming in fast, or one about to catch it: sometimes it flutters up and
          // over instead, landing above where the water will reach.
          b.hopCool -= dt;
          if (b.hopCool <= 0 && (dUp > 1.6 || water + 0.15 > b.up)) {
            b.hopCool = range(rng, 2, 6);
            if (rng() < 0.3 || water + 0.15 > b.up) {
              const dur = range(rng, 0.5, 0.9);
              const x1 = b.x + range(rng, -0.6, 0.6);
              const land = Math.max(this.edge.at(x1, time + dur), this.edge.at(x1, time + dur + 0.6));
              b.hop = { t: 0, dur, x0: b.x, up0: b.up, x1, up1: Math.max(land, b.up) + b.gap + range(rng, 0.3, 0.8), h: range(rng, 0.25, 0.55) };
              b.peckT = 0;
            }
          }
          if (!b.hop) {
            // Following the water down, each stops now and then to probe the sand, and one
            // busy pecking finishes before it carries on.
            if (dUp < -0.1 && b.peckT <= 0 && rng() < dt * 1.2) b.peckT = 0.35 + range(rng, 0, 0.5);
            // It stays put until it's a fair way off its spot (each its own way), then runs
            // until it's nearly there: stop-start, not smooth tracking.
            const off = Math.abs(dUp) > (b.running ? 0.1 : b.slack) || water + 0.3 > b.up;
            const wantUp = !off || (dUp < 0 && b.peckT > 0) ? 0 : clamp(dUp * b.eager, -b.trot, b.sprint);
            if (wantUp !== 0 && !b.running) b.slant = range(rng, -0.45, 0.45);
            b.running = wantUp !== 0;
            b.vUp = b.running ? b.vUp : b.vUp * Math.max(0, 1 - dt * 12);
            const dX = g.cx + b.lane + b.roam - b.x;
            const wantX = (Math.abs(dX) < 0.25 ? 0 : clamp(dX * 1.5, -0.7, 0.7)) + b.slant * Math.abs(wantUp);
            b.vUp += clamp(wantUp - b.vUp, -18 * dt, 18 * dt);
            b.vx += clamp(wantX - b.vx, -8 * dt, 8 * dt);
            b.x += b.vx * dt;
            // The water never catches them.
            b.up = Math.max(b.up + b.vUp * dt, water + 0.12);
          }
        }
        const mx = (b.x - x0) / Math.max(dt, 1e-3);
        const mUp = (b.up - up0) / Math.max(dt, 1e-3);
        const speed = Math.hypot(mx, mUp);

        // Face where they're going. Standing, they turn now and then, mostly side-on to
        // the slope (along the beach) and sometimes toward the water.
        if (speed < 0.15 && rng() < dt * 0.35) {
          b.face = rng() < 0.7 ? (rng() < 0.5 ? 0 : Math.PI) + range(rng, -0.5, 0.5) : Math.PI / 2 + range(rng, -0.8, 0.8);
        }
        const want = speed > 0.15 ? Math.atan2(-mUp, mx) : b.face;
        const turn = Math.atan2(Math.sin(want - b.heading), Math.cos(want - b.heading));
        b.heading += turn * Math.min(1, dt * (speed > 0.15 ? b.turnRate : 5));

        // Wings open for flight and beat fast, with short glides when the flock is flying.
        b.fly += ((airborne ? 1 : 0) - b.fly) * Math.min(1, dt * 12);
        const glide = f && Math.sin(time * 1.1 + b.lane * 3) > 0.55;
        if (!glide) b.flap += dt * (f ? 9 : 12) * Math.PI * 2;

        // Legs whirr when running; standing still, they probe the wet sand.
        const run = airborne ? 0 : smoothstep(0.05, 0.4, speed);
        b.stride += dt * Math.min(speed / 0.1, 13) * Math.PI * 2;
        let peck = 0;
        if (!airborne && speed < 0.1) {
          b.nextPeck -= dt;
          if (b.nextPeck <= 0 && b.peckT <= 0) {
            b.peckT = 0.35;
            b.nextPeck = range(rng, 0.25, 1.6);
          }
        }
        if (b.peckT > 0) {
          b.peckT -= dt;
          // A longer stop is a pause, then the peck.
          peck = b.peckT < 0.35 ? Math.sin(Math.PI * (1 - Math.max(b.peckT, 0) / 0.35)) : 0;
        }

        if (Math.abs(b.x) > 45 || n >= MAX_PIPERS) continue;
        const ground = Math.max(b.up, 0) * this.shore.foreshore;
        const bob = Math.abs(Math.sin(b.stride)) * 0.008 * run;
        this.p.set(b.x, ground + bob + b.alt, -shoreline(this.shore, b.x) + b.up);
        this.e.set(0, b.heading, -0.75 * peck);
        this.q.setFromEuler(this.e);
        this.s.setScalar(b.scale);
        this.m.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(n, this.m);
        this.animAttr.setXYZW(n, b.stride, run, b.fly, b.flap);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.animAttr.needsUpdate = true;
  }

  private takeoff(g: Group, x1: number, away: boolean) {
    const rng = this.rng;
    let mean = 0;
    for (const b of g.birds) {
      b.sx = b.x;
      b.sUp = b.up;
      b.delay = range(rng, 0, 0.4);
      b.hop = null;
      b.peckT = 0;
      mean += b.x / g.birds.length;
    }
    const out = range(rng, 2, 7);
    g.flight = { t: 0, dur: Math.max(3, (Math.abs(x1 - mean) + 2 * out) / range(rng, 8, 10)), x1, out, h: range(rng, 1.2, 2.5), away };
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
      attribute vec3 aWing;
      attribute vec3 aLegP;
      attribute vec4 iAnim; // stride phase, how much it's running, wings spread, wingbeat phase
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vColor;
      void main() {
        vec3 p = position;
        vec3 nrm = normal;
        if (aLeg != 0.0) {
          // Feet plant and push back while the body passes over them, then lift and swing
          // forward; the ankle bends backward between hip and foot, as a bird's does.
          float u = fract((iAnim.x + (aLeg > 0.0 ? 0.0 : 3.1416)) / 6.2832);
          float R = 0.03 * iAnim.y;
          vec2 foot = u < 0.6
            ? vec2(mix(R, -R, u / 0.6), 0.0)
            : vec2(mix(-R, R, (u - 0.6) / 0.4), 0.02 * iAnim.y * sin(3.1416 * (u - 0.6) / 0.4));
          // Tucked up behind in flight.
          foot = mix(foot, vec2(-0.05, ${(LEG - 0.012).toFixed(3)}), iAnim.z);
          vec2 hip = vec2(0.0, ${(LEG + 0.01).toFixed(3)});
          const float L1 = 0.029, L2 = 0.035;
          vec2 dir = normalize(foot - hip);
          float len = clamp(length(foot - hip), 0.012, L1 + L2 - 0.0005);
          float along = (L1 * L1 - L2 * L2 + len * len) / (2.0 * len);
          vec2 ankle = hip + dir * along + vec2(dir.y, -dir.x) * sqrt(max(L1 * L1 - along * along, 0.0));
          vec2 A = aLegP.x < 0.5 ? hip : ankle;
          vec2 B = aLegP.x < 0.5 ? ankle : hip + dir * len;
          vec2 sd = normalize(B - A);
          p = vec3(mix(A, B, aLegP.y) + vec2(-sd.y, sd.x) * 0.0028 * aLegP.z, aLeg * 0.012);
          nrm = vec3(0.0, 0.4, aLeg);
        }
        if (aWing.z != 0.0) {
          // Folded along the back (mostly inside the body), or spread and beating.
          float a = aWing.x, c = aWing.y;
          vec3 folded = vec3(0.015 - a * 0.6 - c * 0.5, 0.008 - a * 0.03, aWing.z * 0.027);
          float ang = 0.1 + 0.75 * sin(iAnim.w);
          vec3 spread = vec3(-c - a * 0.15, a * sin(ang), aWing.z * (0.02 + a * cos(ang)));
          p = vec3(0.01, ${(LEG + 0.048).toFixed(3)}, 0.0) + mix(folded, spread, iAnim.z);
          nrm = normalize(mix(vec3(0.0, 1.0, 0.0), vec3(0.0, cos(ang), -aWing.z * sin(ang)), iAnim.z));
        }
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(modelMatrix * instanceMatrix) * nrm);
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

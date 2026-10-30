// Birds crossing the sky: geese in V formation, loose flocks, and lone gliders.
// They move in real time (not time-lapse) and head home as the light fades.
import * as THREE from 'three';
import type { Birds as BirdSetting } from './config';
import { type Rng, gauss, range } from './rng';
import { COMMON_GLSL, shared } from './shared';

const MAX_BIRDS = 240;

interface Bird {
  offset: THREE.Vector3;
  phase: number;
  flapRate: number;
  scale: number;
}

interface Flock {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  birds: Bird[];
  age: number;
  life: number;
  glide: number;
  wander: number;
}

function birdGeometry(): THREE.BufferGeometry {
  // Body along +x (heading), wings along ±z. aWing: 0 at the body, 1 at the tips.
  const v: number[] = [];
  const w: number[] = [];
  const tri = (a: number[], b: number[], c: number[], wa: number, wb: number, wc: number) => {
    v.push(...a, ...b, ...c);
    w.push(wa, wb, wc);
  };
  // body
  tri([0.35, 0, 0], [-0.3, 0.03, 0.05], [-0.3, 0.03, -0.05], 0, 0, 0);
  tri([0.35, 0, 0], [-0.3, -0.03, 0], [-0.3, 0.03, 0.05], 0, 0, 0);
  tri([0.35, 0, 0], [-0.3, 0.03, -0.05], [-0.3, -0.03, 0], 0, 0, 0);
  // tail
  tri([-0.25, 0.01, 0], [-0.48, 0.01, 0.09], [-0.48, 0.01, -0.09], 0, 0, 0);
  for (const s of [1, -1]) {
    // inner wing
    tri([0.12, 0, 0], [-0.1, 0, 0], [0.02, 0, 0.45 * s], 0, 0, 0.5);
    tri([-0.1, 0, 0], [-0.12, 0, 0.42 * s], [0.02, 0, 0.45 * s], 0, 0.5, 0.5);
    // outer wing, swept back to a point
    tri([0.02, 0, 0.45 * s], [-0.12, 0, 0.42 * s], [-0.22, 0, 0.95 * s], 0.5, 0.5, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(w, 1));
  return g;
}

export class BirdSystem {
  readonly mesh: THREE.InstancedMesh;
  private flocks: Flock[] = [];
  private nextSpawn: number;
  private phaseAttr: THREE.InstancedBufferAttribute;
  private rateAttr: THREE.InstancedBufferAttribute;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(private rng: Rng, private setting: BirdSetting) {
    const geo = birdGeometry();
    this.phaseAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS), 1);
    this.rateAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS), 1);
    geo.setAttribute('iPhase', this.phaseAttr);
    geo.setAttribute('iRate', this.rateAttr);
    this.mesh = new THREE.InstancedMesh(geo, birdMaterial(), MAX_BIRDS);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.nextSpawn = range(rng, 2, 6);
  }

  /** dt in real seconds; daylight in [0, 1] controls how often birds appear. */
  update(dt: number, daylight: number) {
    if (this.setting === 'none') return;
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0) {
      if (this.rng() < daylight) this.spawn();
      const gap = this.setting === 'flocks' ? range(this.rng, 8, 22) : range(this.rng, 18, 45);
      this.nextSpawn = gap;
    }
    let n = 0;
    for (const f of this.flocks) {
      f.age += dt;
      f.vel.y += Math.sin(f.age * 0.3 + f.wander) * 0.02 * dt;
      f.pos.addScaledVector(f.vel, dt);
      const heading = Math.atan2(-f.vel.z, f.vel.x);
      const bank = Math.sin(f.age * 0.5 + f.wander) * 0.15;
      this.q.setFromEuler(new THREE.Euler(bank, heading, Math.atan2(f.vel.y, f.vel.length()), 'YXZ'));
      for (const b of f.birds) {
        if (n >= MAX_BIRDS) break;
        const p = b.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), heading).add(f.pos);
        p.y += Math.sin(f.age * 0.7 + b.phase) * 0.6;
        this.m.compose(p, this.q, new THREE.Vector3(b.scale, b.scale, b.scale));
        this.mesh.setMatrixAt(n, this.m);
        this.phaseAttr.setX(n, b.phase);
        this.rateAttr.setX(n, b.flapRate * (f.glide > 0 && Math.sin(f.age * 0.4 + b.phase) > 0.3 ? 0 : 1));
        n++;
      }
    }
    this.flocks = this.flocks.filter((f) => f.age < f.life);
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.phaseAttr.needsUpdate = true;
    this.rateAttr.needsUpdate = true;
  }

  private spawn() {
    const rng = this.rng;
    const roll = rng();
    const kind = this.setting === 'few' ? (roll < 0.65 ? 'single' : roll < 0.9 ? 'loose' : 'v') : roll < 0.4 ? 'v' : roll < 0.8 ? 'loose' : 'single';
    const dist = kind === 'v' ? range(rng, 150, 650) : kind === 'loose' ? range(rng, 120, 500) : range(rng, 40, 260);
    const elevation = range(rng, 0.04, 0.3);
    const side = rng() < 0.5 ? -1 : 1;
    const ahead = new THREE.Vector3(range(rng, -0.3, 0.3), 0, -1).normalize();
    const across = new THREE.Vector3(-ahead.z, 0, ahead.x);
    const speed = kind === 'v' ? range(rng, 13, 17) : kind === 'loose' ? range(rng, 9, 13) : range(rng, 7, 11);
    const span = dist * 1.6;
    const pos = ahead.clone().multiplyScalar(dist).addScaledVector(across, -side * span);
    pos.y = dist * Math.tan(elevation) + 2;
    const dir = across.clone().multiplyScalar(side).addScaledVector(ahead, range(rng, -0.35, 0.35)).normalize();
    const vel = dir.multiplyScalar(speed);
    vel.y = range(rng, -0.3, 0.3);

    const birds: Bird[] = [];
    if (kind === 'v') {
      const count = 7 + Math.floor(rng() * 16);
      const arm = range(rng, 0.45, 0.7);
      for (let i = 0; i < count; i++) {
        const k = Math.ceil(i / 2);
        const s = i % 2 === 0 ? 1 : -1;
        birds.push({
          offset: new THREE.Vector3(-k * 3.2 + gauss(rng) * 0.3, gauss(rng) * 0.3, s * k * 3.2 * arm + gauss(rng) * 0.3),
          phase: rng() * 6.28,
          flapRate: range(rng, 4.5, 5.5),
          scale: range(rng, 1.4, 1.7),
        });
      }
    } else if (kind === 'loose') {
      const count = 10 + Math.floor(rng() * 30);
      for (let i = 0; i < count; i++) {
        birds.push({
          offset: new THREE.Vector3(gauss(rng) * 9, gauss(rng) * 4, gauss(rng) * 9),
          phase: rng() * 6.28,
          flapRate: range(rng, 10, 14),
          scale: range(rng, 0.45, 0.6),
        });
      }
    } else {
      const count = 1 + (rng() < 0.35 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        birds.push({
          offset: new THREE.Vector3(-i * 4, i * 1.5, i * 3),
          phase: rng() * 6.28,
          flapRate: range(rng, 3.5, 5),
          scale: range(rng, 1.1, 1.4),
        });
      }
    }
    this.flocks.push({
      pos,
      vel,
      birds,
      age: 0,
      life: (span * 2.2) / speed,
      glide: kind === 'single' ? 1 : 0,
      wander: rng() * 6.28,
    });
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function birdMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      attribute float aWing;
      attribute float iPhase;
      attribute float iRate;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float flap = sin(uTime * iRate + iPhase);
        float lift = iRate > 0.0 ? flap : 0.15;
        p.y += lift * 0.55 * aWing * abs(p.z) + aWing * aWing * lift * 0.15;
        p.z *= 1.0 - 0.15 * aWing * max(lift, 0.0);
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      varying vec3 vWorld;
      void main() {
        vec3 V = normalize(cameraPosition - vWorld);
        float rim = pow(max(dot(-V, uSunDir), 0.0), 8.0) * 0.4;
        vec3 col = vec3(0.04, 0.035, 0.035) * (ambientLight(vec3(0.0, -1.0, 0.0)) + uSunColor * rim);
        col = applyAtmosphere(col, vWorld);
        gl_FragColor = vec4(col * uExposure, 1.0);
      }`,
  });
}

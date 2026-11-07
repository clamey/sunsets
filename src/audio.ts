// Sound: surf timed to the waves on screen, and birds calling as they cross the view.
// Everything is synthesised with Web Audio; nothing is downloaded.
import * as THREE from 'three';
import type { FlockKind } from './birds';
import { renderGullPhrase } from './gullcall';
import type { Surf } from './ocean';

export interface SoundInfo {
  surf: Surf;
  /** Distance (m) from the camera to the waterline. */
  shoreDist: number;
  flocks: { id: number; kind: FlockKind; pos: THREE.Vector3; size: number }[];
  camera: THREE.Camera;
  daylight: number;
}

const TAU = Math.PI * 2;
const MASTER = 1.2;
/** Alongshore positions (m) of the surf voices, so a break is heard running along the beach. */
const SURF_X = [-120, -40, 40, 120];

interface SurfVoice {
  x: number;
  crash: GainNode;
  crashTone: BiquadFilterNode;
  wash: GainNode;
  washTone: BiquadFilterNode;
  pan: StereoPannerNode;
}

interface BirdVoice {
  gain: GainNode;
  tone: BiquadFilterNode;
  pan: StereoPannerNode;
  next: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function noiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const len = ctx.sampleRate * 6;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      b = (b + 0.02 * w) / 1.02;
      d[i] = b * 3.5;
    } else d[i] = w;
  }
  // Cross-fade the ends so the loop has no click.
  const fade = Math.floor(ctx.sampleRate * 0.05);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[len - fade + i] = d[len - fade + i] * (1 - k) + d[i] * k;
  }
  return buf;
}

/** How big swash n at x is, relative to the biggest (matches swashReach's group term). */
function group(s: Surf, x: number, n: number): number {
  const wPeak = TAU * (n + 0.3) - Math.PI / 2 + s.ky * x + s.phase;
  return 0.65 + 0.35 * Math.sin(s.groupKy * x * 0.5 - (s.groupOmega / s.omega - 1) * wPeak + 1.3);
}

export class Soundscape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private roar!: GainNode;
  private birdBus!: GainNode;
  private wind!: GainNode;
  private windTone!: BiquadFilterNode;
  private caps!: GainNode;
  private surf: SurfVoice[] = [];
  private birds = new Map<number, BirdVoice>();
  /** Gull phrases rendered ahead of time; one is re-rendered in idle time after each use. */
  private gulls: AudioBuffer[] = [];
  private hidden = false;
  private volume = 1;
  private v = new THREE.Vector3();

  constructor(private on: boolean) {}

  get enabled() {
    return this.on;
  }

  /** Call from a user gesture: browsers only let audio start from one. */
  start() {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return;
      this.build();
    }
    this.refresh();
  }

  setEnabled(on: boolean) {
    this.on = on;
    this.start();
  }

  /** v in [0, 1], heard on a squared curve so the slider feels even. */
  setVolume(v: number) {
    this.volume = clamp(v, 0, 1);
    const ctx = this.ctx;
    if (ctx && this.on && !this.hidden) {
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.setTargetAtTime(this.level(), ctx.currentTime, 0.05);
    }
  }

  private level() {
    return MASTER * this.volume * this.volume;
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden;
    this.refresh();
  }

  private refresh() {
    const ctx = this.ctx;
    if (!ctx) return;
    const play = this.on && !this.hidden;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(play ? this.level() : 0, ctx.currentTime, play ? 0.6 : 0.15);
    if (play) void ctx.resume();
    else window.setTimeout(() => !(this.on && !this.hidden) && void ctx.suspend(), 600);
  }

  private build() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    const white = noiseBuffer(ctx, false);
    const brown = noiseBuffer(ctx, true);
    const loop = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start(0, Math.random() * buf.duration);
      return src;
    };

    // The far-off roar of the whole surf zone.
    const roarTone = ctx.createBiquadFilter();
    roarTone.type = 'lowpass';
    roarTone.frequency.value = 260;
    this.roar = ctx.createGain();
    this.roar.gain.value = 0;
    loop(brown).connect(roarTone).connect(this.roar).connect(this.master);

    for (const x of SURF_X) {
      const pan = ctx.createStereoPanner();
      pan.connect(this.master);
      // Breaking: a low thump and rumble that opens up bright as the lip comes down.
      const crashTone = ctx.createBiquadFilter();
      crashTone.type = 'lowpass';
      crashTone.Q.value = 0.4;
      const crash = ctx.createGain();
      crash.gain.value = 0;
      loop(brown).connect(crashTone).connect(crash).connect(pan);
      // The swash: a hiss running up the sand, fizzing as it drains back.
      const washTone = ctx.createBiquadFilter();
      washTone.type = 'bandpass';
      washTone.Q.value = 0.5;
      const wash = ctx.createGain();
      wash.gain.value = 0;
      loop(white).connect(washTone).connect(wash).connect(pan);
      this.surf.push({ x, crash, crashTone, wash, washTone, pan });
    }

    // Wind over the water, gusting, and whitecaps fizzing out on the sea.
    this.windTone = ctx.createBiquadFilter();
    this.windTone.type = 'bandpass';
    this.windTone.Q.value = 0.7;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(white).connect(this.windTone).connect(this.wind).connect(this.master);
    const capsTone = ctx.createBiquadFilter();
    capsTone.type = 'highpass';
    capsTone.frequency.value = 3200;
    this.caps = ctx.createGain();
    this.caps.gain.value = 0;
    loop(white).connect(capsTone).connect(this.caps).connect(this.master);

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 3.5;
    this.birdBus.connect(this.master);

    document.addEventListener('visibilitychange', () => this.setHidden(document.hidden));
  }

  /** time: the scene clock (s), the same one the waves move to. */
  update(time: number, info: SoundInfo) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const set = (p: AudioParam, v: number, tc = 0.04) => p.setTargetAtTime(v, now, tc);
    const s = info.surf;
    const T = TAU / s.omega;
    const breaks = s.breakU >= 0;
    // Bigger waves thump lower; long-period swell carries more energy and breaks with a
    // slower, deeper boom and a longer roll, short swell with quicker, brighter slaps.
    const heavy = smooth(0.2, 2.4, s.height);
    const deep = smooth(6, 13, s.period);
    const crashLevel = breaks ? (1.2 + 2.6 * heavy) * (0.8 + 0.45 * deep) : 0;
    const washLevel = (0.4 + 0.3 * smooth(0.1, 1.5, s.height)) * (0.85 + 0.3 * deep);
    const floor = 260 - 140 * (0.6 * heavy + 0.4 * deep);
    const bright = 1700 * (1.15 - 0.55 * heavy) * (1.2 - 0.45 * deep);
    const attack = 0.2 + 0.2 * deep;
    const decay = (0.7 + 0.5 * s.height) * (0.8 + 0.7 * deep);
    const washPitch = 1.15 - 0.3 * deep;
    // Wind: still air leaves the surf glassy and a touch quieter; wind adds gusts and fizz.
    const windy = smooth(0.03, 0.2, s.windHeight);
    set(this.roar.gain, (0.12 + 0.31 * heavy) * (0.85 + 0.3 * windy), 0.5);
    const gust = 0.55 + 0.45 * (Math.sin(time * 0.13) + Math.sin(time * 0.31 + 1) + Math.sin(time * 0.071 + 2)) / 3;
    set(this.wind.gain, 1.1 * windy * windy * gust, 0.3);
    set(this.windTone.frequency, 350 + 700 * gust * (0.6 + 0.4 * windy), 0.3);
    const fizz = Math.max(0, Math.sin(time * 1.7) * Math.sin(time * 0.53 + 2) * Math.sin(time * 2.9 + 1));
    set(this.caps.gain, 0.12 * s.whitecaps * (0.3 + 2 * fizz), 0.08);

    for (const vc of this.surf) {
      const d = info.shoreDist + Math.max(s.breakU, 0) * 0.5;
      const dist = Math.hypot(vc.x, d);
      const near = 80 / (40 + dist);
      set(vc.pan.pan, (vc.x / dist) * 0.9, 0.1);
      // Swash count as in swashCount: the integer numbers each swash, the fraction is its phase.
      const cnt = (Math.PI / 2 - (s.ky * vc.x - s.omega * time + s.phase)) / TAU;
      const n = Math.floor(cnt);
      const psi = cnt - n;
      // The wave that will make the next swash broke `lead` seconds before it reaches the sand.
      const cntB = cnt + s.lead / T;
      const nB = Math.floor(cntB);
      const since = (cntB - nB) * T;
      const gB = group(s, vc.x, nB);
      const hit = since < attack ? (since / attack) ** 2 : Math.exp(-(since - attack) / decay);
      const rumble = Math.exp(-since / (T * 0.35));
      const crash = crashLevel * gB * gB * (0.8 * hit + 0.25 * rumble) * near;
      set(vc.crash.gain, crash);
      set(vc.crashTone.frequency, floor + bright * hit * gB);
      set(vc.crashTone.Q, 0.4 + 1.6 * heavy * deep, 0.5);

      // Up the sand to psi 0.3, then back down by 0.92 (as swashRise).
      const g = group(s, vc.x, n);
      const up = psi < 0.3;
      const rise = up ? Math.sin((psi / 0.3) * (Math.PI / 2)) : psi < 0.92 ? Math.pow(1 - (psi - 0.3) / 0.62, 1.6) : 0;
      const flow = up ? 0.4 + 0.6 * rise : 0.75 * Math.pow(rise, 0.6);
      set(vc.wash.gain, washLevel * g * flow * near * 1.6, 0.08);
      set(vc.washTone.frequency, (up ? 900 + 700 * rise : 2600 - 900 * rise) * washPitch, 0.1);
    }

    this.updateBirds(info, now);
  }

  private updateBirds(info: SoundInfo, now: number) {
    const ctx = this.ctx!;
    const cam = info.camera;
    const seen = new Set<number>();
    for (const f of info.flocks) {
      seen.add(f.id);
      let b = this.birds.get(f.id);
      if (!b) {
        const tone = ctx.createBiquadFilter();
        tone.type = 'lowpass';
        const gain = ctx.createGain();
        gain.gain.value = 0;
        const pan = ctx.createStereoPanner();
        tone.connect(gain).connect(pan).connect(this.birdBus);
        b = { gain, tone, pan, next: now + Math.random() * 2 };
        this.birds.set(f.id, b);
      }
      // Heard while in view, fading in and out as the flock crosses the edges of the frame.
      this.v.copy(f.pos).project(cam);
      const inFront = this.v.z < 1;
      const vis = inFront ? (1 - smooth(0.8, 1.25, Math.abs(this.v.x))) * (1 - smooth(0.9, 1.3, Math.abs(this.v.y))) : 0;
      const dist = f.pos.distanceTo(cam.position);
      const carry = f.kind === 'v' ? 220 : f.kind === 'loose' ? 90 : 120;
      const level = vis * Math.min(1, carry / dist) * (0.35 + 0.65 * info.daylight);
      b.gain.gain.setTargetAtTime(level, now, 0.7);
      b.pan.pan.setTargetAtTime(clamp(this.v.x, -1, 1) * 0.85, now, 0.3);
      b.tone.frequency.setTargetAtTime(clamp((9000 * 80) / dist, 1800, 9000), now, 0.5);
      if (level > 0.03 && now >= b.next) {
        const t0 = now + 0.02;
        if (f.kind === 'v') {
          this.honk(b.tone, t0);
          if (Math.random() < 0.4) this.honk(b.tone, t0 + 0.22 + Math.random() * 0.1);
          b.next = t0 + (0.5 + Math.random() * 1.8) * (12 / (6 + f.size));
        } else if (f.kind === 'loose') {
          const peeps = 1 + Math.floor(Math.random() * 3);
          for (let i = 0; i < peeps; i++) this.peep(b.tone, t0 + i * (0.1 + Math.random() * 0.05));
          b.next = t0 + 0.4 + Math.random() * 1.4;
        } else {
          this.cry(b.tone, t0);
          b.next = t0 + 3 + Math.random() * 6;
        }
      }
    }
    for (const [id, b] of this.birds) {
      if (seen.has(id)) continue;
      b.gain.gain.setTargetAtTime(0, now, 0.3);
      window.setTimeout(() => b.pan.disconnect(), 2000);
      this.birds.delete(id);
    }
  }

  private envelope(t0: number, attack: number, hold: number, release: number, peak: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.linearRampToValueAtTime(0, t0 + attack + hold + release);
    return g;
  }

  /** A goose's nasal honk, soft with distance. */
  private honk(dest: AudioNode, t0: number) {
    const ctx = this.ctx!;
    const f = 280 + Math.random() * 80;
    const dur = 0.14 + Math.random() * 0.1;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.82, t0);
    o.frequency.linearRampToValueAtTime(f, t0 + 0.05);
    o.frequency.linearRampToValueAtTime(f * 0.92, t0 + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 950;
    bp.Q.value = 1.4;
    const g = this.envelope(t0, 0.025, dur - 0.07, 0.05, 0.22);
    o.connect(bp).connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** A shorebird's thin peep. */
  private peep(dest: AudioNode, t0: number) {
    const ctx = this.ctx!;
    const f = 3000 + Math.random() * 1600;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 0.9, t0);
    o.frequency.exponentialRampToValueAtTime(f * 1.12, t0 + 0.035);
    o.frequency.exponentialRampToValueAtTime(f * 0.95, t0 + 0.08);
    const g = this.envelope(t0, 0.01, 0.04, 0.035, 0.06);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + 0.1);
  }

  private gullPhrase(): AudioBuffer {
    // Rendered at a low rate (the voice has nothing above 9 kHz) to keep it cheap.
    const rate = 22050;
    const buf = (data: Float32Array) => {
      const b = this.ctx!.createBuffer(1, data.length, rate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      return b;
    };
    while (this.gulls.length < 2) this.gulls.push(buf(renderGullPhrase(rate, Math.random)));
    const i = Math.floor(Math.random() * this.gulls.length);
    const phrase = this.gulls[i];
    const refill = () => {
      const fresh = buf(renderGullPhrase(rate, Math.random));
      if (this.gulls.length < 6) this.gulls.push(fresh);
      else this.gulls[i] = fresh;
    };
    if ('requestIdleCallback' in window) requestIdleCallback(refill, { timeout: 2000 });
    else setTimeout(refill, 200);
    return phrase;
  }

  /** A gull's cry: a "kee-ow", a long call or a laugh, each bird a little higher or lower. */
  private cry(dest: AudioNode, t0: number) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.gullPhrase();
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    src.connect(dest);
    src.start(t0);
  }
}

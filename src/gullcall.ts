// Gull calls, rendered sample by sample. A gull's voice is a harsh, nasal, wavering
// tone: its pitch jitters, it breaks into rough subharmonics, it carries breath noise,
// and its vowel slides from a bright "kee" to a dark "ow". Calls come in phrases: a lone
// "kee-ow", the long call (a drawn-out note and a run of yelps) and the "ha-ha-ha" laugh.
import type { Rng } from './rng';
import { range } from './rng';

/** One note of a phrase. Times are seconds from the start of the phrase. */
interface Note {
  t: number;
  dur: number;
  /** Pitch (Hz) at the peak of the note. */
  f: number;
  /** Fraction of the peak pitch it starts and ends at. */
  from: number;
  to: number;
  /** When the pitch peaks, as a fraction of the note. */
  peakAt: number;
  level: number;
  /** How far the vowel slides from "ee" to "ow" by the end (0..1). */
  ow: number;
  /** How rough it is: subharmonics and buzz. */
  rough: number;
}

/** A low-passed random walk: the slow, irregular wander of a living voice. */
function wander(rng: Rng, rate: number, smooth: number) {
  let v = 0;
  let target = 0;
  let left = 0;
  return () => {
    if (left-- <= 0) {
      target = rng() * 2 - 1;
      left = Math.floor(rate * (0.5 + rng()));
    }
    v += (target - v) * smooth;
    return v;
  };
}

function phrase(rng: Rng): Note[] {
  const F = range(rng, 820, 1050);
  const kind = rng();
  const notes: Note[] = [];
  const keeow = (t: number, dur: number, level: number) =>
    notes.push({ t, dur, f: F * range(rng, 0.97, 1.08), from: 0.62, to: range(rng, 0.5, 0.62), peakAt: range(rng, 0.18, 0.3), level, ow: range(rng, 0.7, 1), rough: range(rng, 0.25, 0.55) });
  const yelp = (t: number, f: number, level: number) =>
    notes.push({ t, dur: range(rng, 0.13, 0.19), f, from: 0.7, to: 0.72, peakAt: 0.35, level, ow: range(rng, 0.5, 0.8), rough: range(rng, 0.3, 0.7) });
  if (kind < 0.4) {
    // A lone "kee-ow", sometimes answered by a second.
    keeow(0, range(rng, 0.42, 0.62), 1);
    if (rng() < 0.35) keeow(range(rng, 0.7, 0.9), range(rng, 0.35, 0.5), range(rng, 0.7, 0.9));
  } else if (kind < 0.75) {
    // The long call: one or two drawn-out notes, then a run of yelps that speeds up,
    // drops in pitch and fades.
    let t = 0;
    const longs = rng() < 0.5 ? 1 : 2;
    for (let i = 0; i < longs; i++) {
      const d = range(rng, 0.4, 0.58);
      keeow(t, d, 1 - i * 0.1);
      t += d + range(rng, 0.1, 0.18);
    }
    const n = 3 + Math.floor(rng() * 5);
    let gap = range(rng, 0.24, 0.3);
    for (let i = 0; i < n; i++) {
      yelp(t, F * (1.02 - i * 0.025) * range(rng, 0.97, 1.03), 0.85 * (1 - (i / n) * 0.45));
      t += gap;
      gap *= 0.95;
    }
  } else {
    // The laugh: short, flat, rapid "ha"s, lower than the cry.
    const n = 3 + Math.floor(rng() * 4);
    let t = 0;
    for (let i = 0; i < n; i++) {
      notes.push({ t, dur: range(rng, 0.09, 0.12), f: F * range(rng, 0.68, 0.76), from: 0.85, to: 0.82, peakAt: 0.4, level: 0.8 * (1 - (i / n) * 0.3), ow: 0.6, rough: range(rng, 0.5, 0.8) });
      t += range(rng, 0.15, 0.19);
    }
  }
  return notes;
}

/** Vowel formants (Hz) and bandwidths, for "ee" and "ow". */
const EE = [1150, 2900, 4200];
const OW = [900, 1500, 3000];
const BW = [260, 420, 700];
const MAXH = 16;

/** Renders a random phrase of gull calls at the given sample rate, peaking at about `peak`. */
export function renderGullPhrase(rate: number, rng: Rng, peak = 0.2): Float32Array {
  const notes = phrase(rng);
  const end = notes.reduce((m, n) => Math.max(m, n.t + n.dur), 0) + 0.1;
  const out = new Float32Array(Math.ceil(end * rate));
  const nyq = Math.min(rate / 2, 9000);
  const amp = new Float32Array(MAXH + 1);
  const subAmp = new Float32Array(MAXH + 1);

  for (const n of notes) {
    const i0 = Math.floor(n.t * rate);
    const len = Math.floor(n.dur * rate);
    const jitterSlow = wander(rng, rate / 9, 0.0015);
    const jitterFast = wander(rng, rate / 70, 0.02);
    const shimmer = wander(rng, rate / 120, 0.03);
    const roughness = wander(rng, rate / 14 / 32, 0.06);
    let phase = rng() * Math.PI * 2;
    // Breath noise through a two-pole resonator near the upper formant.
    let y1 = 0;
    let y2 = 0;
    let F2 = EE[1];
    let sub = 0;
    for (let i = 0; i < len; i++) {
      const s = i / len;
      // Pitch: a quick rise to the peak, a held top, then the fall into "ow".
      let p: number;
      if (s < n.peakAt) {
        const k = s / n.peakAt;
        p = n.from + (1 - n.from) * (1 - (1 - k) * (1 - k));
      } else {
        const k = (s - n.peakAt) / (1 - n.peakAt);
        p = 1 - (1 - n.to) * k * k;
      }
      const f = n.f * p * (1 + 0.025 * jitterSlow() + 0.012 * jitterFast());
      phase += (Math.PI * 2 * f) / rate;
      if (phase > Math.PI * 4) phase -= Math.PI * 4;

      // Vowel: "ee" through most of the note, sliding to "ow" as the pitch falls. The
      // harmonic weights change slowly, so they're worked out every few samples.
      const nh = Math.floor(nyq / f);
      if (i % 32 === 0) {
        const v = n.ow * Math.max(0, (s - n.peakAt * 0.8) / (1 - n.peakAt * 0.8));
        const F1 = EE[0] + (OW[0] - EE[0]) * v;
        F2 = EE[1] + (OW[1] - EE[1]) * v;
        const F3 = EE[2] + (OW[2] - EE[2]) * v;
        const formant = (hz: number) =>
          1 / (1 + ((hz - F1) / BW[0]) ** 2) + 0.8 / (1 + ((hz - F2) / BW[1]) ** 2) + 0.35 / (1 + ((hz - F3) / BW[2]) ** 2) + 0.04;
        // Harmonics, then a subharmonic series at half the pitch (odd multiples of f/2).
        for (let k = 1; k <= MAXH; k++) {
          amp[k] = formant(k * f) / Math.pow(k, 0.6);
          subAmp[k] = (0.5 * formant((k - 0.5) * f)) / Math.pow(2 * k - 1, 0.6);
        }
        sub = n.rough * (0.35 + 0.65 * Math.max(0, roughness())) * (s < 0.15 ? 1.4 : 1);
      }

      // The subharmonics swell and fade: the rasp that makes a gull sound like a gull.
      let x = 0;
      const half = phase * 0.5;
      const top = Math.min(nh, MAXH);
      for (let k = 1; k <= top; k++) x += amp[k] * Math.sin(k * phase) + sub * subAmp[k] * Math.sin((2 * k - 1) * half);

      // Breath: noise near the second formant, strongest at the onset (the "k").
      const w = rng() * 2 - 1;
      const r = 0.96;
      const c = 2 * r * Math.cos((Math.PI * 2 * F2) / rate);
      const y = w * (1 - r) * 2 + c * y1 - r * r * y2;
      y2 = y1;
      y1 = y;
      const breath = y * (0.25 + 1.2 * Math.exp(-s * n.dur / 0.02));

      // Envelope: a fast but not instant attack, a sagging hold and a soft tail.
      const tSec = s * n.dur;
      const att = 1 - Math.exp(-tSec / 0.012);
      const rel = Math.min(1, (n.dur - tSec) / Math.min(0.08, n.dur * 0.4));
      const env = att * Math.max(0, rel) ** 1.5 * (1 - 0.25 * s) * (1 + 0.18 * shimmer());
      out[i0 + i] += (x * 0.25 + breath) * env * n.level;
    }
  }

  let max = 0;
  for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
  const g = max > 0 ? peak / max : 0;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

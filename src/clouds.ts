// Cloud presets: each style becomes one to three layers with seeded variation.
import type { CloudStyle } from './config';
import { type Rng, range } from './rng';

export const CUMULUS = 0;
export const CIRRUS = 1;
export const ALTOCUMULUS = 2;
export const STRATUS = 3;

export interface CloudLayer {
  type: number;
  /** Cloud base, km above ground. */
  base: number;
  /** Slab thickness in km; 0 draws a thin sheet (cirrus). */
  thickness: number;
  coverage: number;
  /** Extinction per km inside the cloud (or sheet opacity for cirrus). */
  sigma: number;
  /** km per noise unit (horizontal size of features). */
  scale: number;
  /** km toward the sun where the layer ends (0 = no gap). */
  gap: number;
  /** How strongly 3D noise erodes edges into billows. */
  erode: number;
  windAngle: number;
  /** km per second of cloud time. */
  windSpeed: number;
  /** How quickly shapes change, in noise units per second of cloud time. */
  evolve: number;
}

/** Layers ordered lowest first. */
export function makeClouds(style: CloudStyle, rng: Rng): CloudLayer[] {
  const wind = range(rng, 0, Math.PI * 2);
  const cumulus = (cov: number): CloudLayer => ({
    type: CUMULUS,
    base: range(rng, 1.1, 1.7),
    thickness: range(rng, 0.9, 1.6),
    coverage: cov,
    sigma: 28,
    scale: range(rng, 1.3, 2.0),
    gap: 0,
    erode: 0.75,
    windAngle: wind,
    windSpeed: range(rng, 0.008, 0.014),
    evolve: 0.0009,
  });
  const cirrus = (cov: number): CloudLayer => ({
    type: CIRRUS,
    base: range(rng, 7.5, 10),
    thickness: 0,
    coverage: cov,
    sigma: range(rng, 0.6, 1.0),
    scale: range(rng, 5, 9),
    gap: 0,
    erode: 0,
    windAngle: wind + range(rng, -0.6, 0.6),
    windSpeed: range(rng, 0.02, 0.035),
    evolve: 0.0006,
  });
  const altocumulus = (cov: number): CloudLayer => ({
    type: ALTOCUMULUS,
    base: range(rng, 3.6, 5),
    thickness: range(rng, 0.25, 0.45),
    coverage: cov,
    sigma: 22,
    scale: range(rng, 0.55, 0.9),
    gap: 0,
    erode: 0.4,
    windAngle: wind + range(rng, -0.3, 0.3),
    windSpeed: range(rng, 0.012, 0.02),
    evolve: 0.0008,
  });

  switch (style) {
    case 'clear':
      return [];
    case 'wispy':
      return [cirrus(range(rng, 0.4, 0.55))];
    case 'puffy':
      return [cumulus(range(rng, 0.42, 0.56)), ...(rng() < 0.5 ? [cirrus(range(rng, 0.25, 0.4))] : [])];
    case 'mackerel':
      return [altocumulus(range(rng, 0.45, 0.6)), ...(rng() < 0.6 ? [cirrus(range(rng, 0.25, 0.4))] : [])];
    case 'dramatic':
      return [cumulus(range(rng, 0.25, 0.36)), altocumulus(range(rng, 0.35, 0.5)), cirrus(range(rng, 0.4, 0.55))];
    case 'moody':
      return [
        {
          type: STRATUS,
          base: range(rng, 1.8, 2.6),
          thickness: range(rng, 0.5, 0.9),
          coverage: range(rng, 0.82, 0.92),
          sigma: 14,
          scale: range(rng, 2.5, 4),
          gap: range(rng, 28, 55),
          erode: 0.3,
          windAngle: wind,
          windSpeed: range(rng, 0.008, 0.012),
          evolve: 0.0006,
        },
        cirrus(range(rng, 0.3, 0.45)),
      ];
  }
}

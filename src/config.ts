// Scene settings: the choices a person makes before pressing Go, plus URL round-tripping.

export type Waves = 'calm' | 'gentle' | 'moderate' | 'big';
export type Swell = 'short' | 'medium' | 'long';
export type Wind = 'still' | 'breezy' | 'windy';
export type CloudStyle = 'clear' | 'wispy' | 'puffy' | 'mackerel' | 'dramatic' | 'moody';
export type Birds = 'none' | 'few' | 'flocks';
export type Moon = 'none' | 'crescent' | 'half' | 'full';
export type Pace = 'fast' | 'medium' | 'slow';

export interface Settings {
  waves: Waves;
  swell: Swell;
  wind: Wind;
  clouds: CloudStyle;
  birds: Birds;
  moon: Moon;
  pace: Pace;
  seed: number;
}

export interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export const WAVES: Option<Waves>[] = [
  { value: 'calm', label: 'Calm', hint: 'Lapping ripples' },
  { value: 'gentle', label: 'Gentle', hint: 'Knee-high' },
  { value: 'moderate', label: 'Moderate', hint: 'Head-high' },
  { value: 'big', label: 'Big', hint: 'Booming surf' },
];

export const SWELLS: Option<Swell>[] = [
  { value: 'short', label: 'Short', hint: 'Close together' },
  { value: 'medium', label: 'Medium' },
  { value: 'long', label: 'Long', hint: 'Far-travelled' },
];

export const WINDS: Option<Wind>[] = [
  { value: 'still', label: 'Still', hint: 'Glassy' },
  { value: 'breezy', label: 'Breezy', hint: 'Some chop' },
  { value: 'windy', label: 'Windy', hint: 'Whitecaps' },
];

/** Significant wave height (m) arriving from offshore. */
export const WAVE_HEIGHT: Record<Waves, number> = { calm: 0.25, gentle: 0.7, moderate: 1.4, big: 2.4 };
/** Peak swell period (s). */
export const SWELL_PERIOD: Record<Swell, number> = { short: 6, medium: 9, long: 13 };
/** Wind-sea height (m) and whitecap amount. */
export const WIND_SEA: Record<Wind, { height: number; whitecaps: number; clouds: number }> = {
  still: { height: 0.03, whitecaps: 0, clouds: 0.6 },
  breezy: { height: 0.08, whitecaps: 0.12, clouds: 1 },
  windy: { height: 0.2, whitecaps: 0.55, clouds: 1.7 },
};

export const CLOUDS: Option<CloudStyle>[] = [
  { value: 'clear', label: 'Clear', hint: 'Not a cloud' },
  { value: 'wispy', label: 'Wispy', hint: 'High cirrus' },
  { value: 'puffy', label: 'Puffy', hint: 'Fair-weather cumulus' },
  { value: 'mackerel', label: 'Mackerel', hint: 'Rippled altocumulus' },
  { value: 'dramatic', label: 'Dramatic', hint: 'A bit of everything' },
  { value: 'moody', label: 'Moody', hint: 'Overcast, gap at the horizon' },
];

export const BIRDS: Option<Birds>[] = [
  { value: 'none', label: 'None' },
  { value: 'few', label: 'A few' },
  { value: 'flocks', label: 'Flocks' },
];

export const MOONS: Option<Moon>[] = [
  { value: 'none', label: 'None' },
  { value: 'crescent', label: 'Crescent' },
  { value: 'half', label: 'Half' },
  { value: 'full', label: 'Full' },
];

export const PACES: Option<Pace>[] = [
  { value: 'fast', label: 'Fast', hint: '~1 min' },
  { value: 'medium', label: 'Medium', hint: '~5 min' },
  { value: 'slow', label: 'Slow', hint: '~15 min' },
];

/** Real seconds the whole sunset (sun at +8° down to -18°) takes to play. */
export const PACE_SECONDS: Record<Pace, number> = { fast: 60, medium: 300, slow: 900 };

export const DEFAULT_SETTINGS: Settings = {
  waves: 'gentle',
  swell: 'medium',
  wind: 'breezy',
  clouds: 'wispy',
  birds: 'few',
  moon: 'crescent',
  pace: 'fast',
  seed: 1,
};

const KEYS: Record<keyof Omit<Settings, 'seed'>, readonly Option<string>[]> = {
  waves: WAVES,
  swell: SWELLS,
  wind: WINDS,
  clouds: CLOUDS,
  birds: BIRDS,
  moon: MOONS,
  pace: PACES,
};

export function settingsToQuery(s: Settings): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) p.set(k, s[k]);
  p.set('seed', String(s.seed));
  return p.toString();
}

/** Reads settings from a query string, ignoring anything unknown. */
export function settingsFromQuery(query: string, base: Settings): Settings {
  const p = new URLSearchParams(query);
  const out: Settings = { ...base };
  for (const k of Object.keys(KEYS) as (keyof typeof KEYS)[]) {
    const v = p.get(k);
    if (v && KEYS[k].some((o) => o.value === v)) (out as unknown as Record<string, string>)[k] = v;
  }
  const seed = Number(p.get('seed'));
  if (Number.isFinite(seed) && seed > 0) out.seed = Math.floor(seed);
  return out;
}

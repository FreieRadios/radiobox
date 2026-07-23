/** Shared DSP scalar helpers. */

export const DB_EPS = 1e-9; // ~ -180 dBFS, avoids log10(0)

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, DB_EPS));

/** One-pole smoothing coefficient for a given time constant (ms). 0 ms => instant. */
export function msToCoef(ms: number, sampleRate: number): number {
  if (ms <= 0) return 0;
  return Math.exp(-1 / ((ms / 1000) * sampleRate));
}

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Denormal guard for feedback paths. */
export const dn = (x: number): number => (Math.abs(x) < 1e-15 ? 0 : x);

import { SR } from './config';

// Jest runs tests in a vm context where every `Math.x` lookup is slow; these
// generators call them tens of millions of times.
const { sin, min, floor, round, sqrt, pow, PI } = Math;

/** Deterministic noise (tests must not flake): a small LCG in [-1, 1). */
export function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** White noise at the given RMS level (dBFS). */
export function noise(rmsDb: number, seconds: number, seed = 7): Float32Array {
  const r = rng(seed);
  // Uniform [-1,1) has an RMS of 1/sqrt(3).
  const amp = Math.pow(10, rmsDb / 20) * Math.sqrt(3);
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * r();
  return out;
}

export interface VoiceOptions {
  /** Fundamental in Hz. */
  f0?: number;
  /** RMS of the voiced stretches in dBFS. */
  rmsDb?: number;
  seconds?: number;
  /** Add sibilant bursts ("s") after every syllable. */
  sibilants?: boolean;
  seed?: number;
}

/**
 * A crude but speech-shaped test voice: a harmonic series on `f0` with a
 * falling spectrum, chopped into syllables (220 ms on, 80 ms off). With
 * `sibilants`, every third syllable ends in 60 ms of high-frequency noise
 * (an "s"). `rmsDb` is the level of the sounding stretches, which is what the
 * setup assistant measures (it only collects speech frames).
 */
export function voice(o: VoiceOptions = {}): Float32Array {
  const f0 = o.f0 ?? 120;
  const seconds = o.seconds ?? 8;
  const n = round(seconds * SR);
  const out = new Float32Array(n);
  const r = rng(o.seed ?? 3);
  const harmonics = min(20, floor(3500 / f0));
  const on = round(0.22 * SR);
  const period = round(0.3 * SR);
  const ramp = round(0.01 * SR);
  const ess = round(0.06 * SR);
  const w0 = (2 * PI * f0) / SR;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const pos = i % period;
    if (pos >= on) continue;
    const env = min(1, pos / ramp, (on - pos) / ramp);
    if (o.sibilants && floor(i / period) % 3 === 0 && pos >= on - ess) {
      // High-passed noise burst: first difference of white noise.
      const w = r();
      out[i] = 0.6 * (w - prev) * env;
      prev = w;
      continue;
    }
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += sin(w0 * h * i) / h;
    out[i] = v * env;
  }
  // Scale so the voiced stretches sit at rmsDb.
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (i % period < on) {
      s += out[i] * out[i];
      c++;
    }
  }
  const g = pow(10, (o.rmsDb ?? -20) / 20) / sqrt(s / c);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** The sounding stretches of a `voice()` only — what the setup session
 *  collects as speech frames. */
export function speechOnly(x: Float32Array): Float32Array {
  const period = round(0.3 * SR);
  const on = round(0.22 * SR);
  const out = new Float32Array(x.length);
  let o = 0;
  for (let i = 0; i < x.length; i++) if (i % period < on) out[o++] = x[i];
  return out.subarray(0, o);
}

export function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)));
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i];
  return out;
}

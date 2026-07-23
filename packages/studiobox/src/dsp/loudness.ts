import { Biquad } from './biquad';

/**
 * ITU-R BS.1770 loudness building blocks.
 *
 * NOTE: the K-weighting coefficients below are the standard values for
 * 48 kHz (studiobox runs at 48 kHz by default). Other sample rates require
 * recomputing these via the bilinear transform — guarded at construction.
 */

const ABS_OFFSET = -0.691; // BS.1770 absolute calibration offset

function kWeightStage1(): Biquad {
  const b = new Biquad();
  b.setCoeffs(
    1.53512485958697,
    -2.69169618940638,
    1.19839281085285,
    1,
    -1.69065929318241,
    0.73248077421585
  );
  return b;
}
function kWeightStage2(): Biquad {
  const b = new Biquad();
  b.setCoeffs(1.0, -2.0, 1.0, 1, -1.99004745483398, 0.99007225036621);
  return b;
}

function assert48k(sampleRate: number): void {
  if (sampleRate !== 48000) {
    throw new Error(
      `loudness: K-weighting coefficients are calibrated for 48 kHz, got ${sampleRate}. ` +
        `Recompute the biquad coefficients for this rate before using the loudness meter.`
    );
  }
}

/** Circular running sum, for sliding mean-square windows. */
class SlidingSum {
  private buf: Float32Array;
  private idx = 0;
  private sum = 0;
  constructor(public readonly n: number) {
    this.buf = new Float32Array(n);
  }
  push(x: number): void {
    this.sum += x - this.buf[this.idx];
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.n;
  }
  get mean(): number {
    return this.sum / this.n;
  }
}

const msToLufs = (meanSq: number): number =>
  meanSq <= 0 ? -Infinity : ABS_OFFSET + 10 * Math.log10(meanSq);

/** Stereo loudness meter: momentary (400 ms) and short-term (3 s). */
export class StereoLoudness {
  private k1L = kWeightStage1();
  private k2L = kWeightStage2();
  private k1R = kWeightStage1();
  private k2R = kWeightStage2();
  private mom: SlidingSum;
  private short: SlidingSum;

  constructor(sampleRate: number) {
    assert48k(sampleRate);
    this.mom = new SlidingSum(Math.round(0.4 * sampleRate));
    this.short = new SlidingSum(Math.round(3.0 * sampleRate));
  }

  process(l: number, r: number): void {
    const kl = this.k2L.process(this.k1L.process(l));
    const kr = this.k2R.process(this.k1R.process(r));
    const s = kl * kl + kr * kr; // stereo channel weights = 1.0
    this.mom.push(s);
    this.short.push(s);
  }

  get momentaryLufs(): number {
    return msToLufs(this.mom.mean);
  }
  get shortTermLufs(): number {
    return msToLufs(this.short.mean);
  }
}

/** Mono short-term loudness estimate, used by the per-channel leveler. */
export class MonoLoudness {
  private k1 = kWeightStage1();
  private k2 = kWeightStage2();
  private short: SlidingSum;

  constructor(sampleRate: number, windowSec = 3.0) {
    assert48k(sampleRate);
    this.short = new SlidingSum(Math.round(windowSec * sampleRate));
  }

  process(x: number): number {
    const k = this.k2.process(this.k1.process(x));
    this.short.push(k * k);
    return this.short.mean;
  }

  get shortTermLufs(): number {
    return msToLufs(this.short.mean);
  }
}

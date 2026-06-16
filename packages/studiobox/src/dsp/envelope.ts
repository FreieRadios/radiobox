import { msToCoef } from './dsp-math';

/** Peak envelope follower with independent attack/release one-pole smoothing. */
export class EnvelopeFollower {
  private atk: number;
  private rel: number;
  private env = 0;

  constructor(sampleRate: number, attackMs: number, releaseMs: number) {
    this.atk = msToCoef(attackMs, sampleRate);
    this.rel = msToCoef(releaseMs, sampleRate);
  }

  /** Feed a (already rectified or signed) sample; tracks its magnitude. */
  process(x: number): number {
    const m = Math.abs(x);
    const c = m > this.env ? this.atk : this.rel;
    this.env = c * (this.env - m) + m;
    return this.env;
  }

  get value(): number {
    return this.env;
  }

  reset(): void {
    this.env = 0;
  }
}

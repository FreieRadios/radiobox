import { dbToGain, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

/**
 * Dan Dugan-style gain-sharing automixer.
 *
 * Each member's applied gain = its amplitude / (sum of all member amplitudes
 * + noise floor). The summed gain of open mics stays ~constant, so a single
 * talker is fully open, N equal talkers share 1/N each, and during silence the
 * floor term pulls everything down. Smoother than gating: no first-syllable loss.
 */
export class Automix {
  private envs: EnvelopeFollower[];
  private gains: Float32Array;
  private amps: Float32Array;
  private floorAmp: number;
  private smooth: number;

  constructor(
    private n: number,
    sampleRate: number,
    responseMs: number,
    floorDb: number
  ) {
    this.envs = Array.from({ length: n }, () => new EnvelopeFollower(sampleRate, 5, responseMs));
    this.gains = new Float32Array(n).fill(0);
    this.amps = new Float32Array(n);
    this.floorAmp = dbToGain(floorDb);
    this.smooth = msToCoef(responseMs, sampleRate);
  }

  /** Feed one sample per member; returns the per-member gains (live array). */
  process(samples: ArrayLike<number>): Float32Array {
    let sum = this.floorAmp;
    for (let i = 0; i < this.n; i++) {
      const a = this.envs[i].process(samples[i]);
      this.amps[i] = a;
      sum += a;
    }
    for (let i = 0; i < this.n; i++) {
      const target = this.amps[i] / sum;
      this.gains[i] = this.smooth * (this.gains[i] - target) + target;
    }
    return this.gains;
  }

  get currentGains(): Float32Array {
    return this.gains;
  }
}

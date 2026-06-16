import { DeesserParams } from '../config/schema';
import { Biquad } from './biquad';
import { Compressor } from './compressor';

/** Split-band de-esser: compress only the high band keyed on its own energy,
 *  then recombine with the untouched low band. */
export class Deesser {
  private hp: Biquad;
  private lp: Biquad;
  private comp: Compressor;
  private enabled: boolean;

  constructor(p: DeesserParams, sampleRate: number) {
    this.enabled = p.enabled;
    this.hp = Biquad.design('highpass', sampleRate, p.freq, 0.707, 0);
    this.lp = Biquad.design('lowpass', sampleRate, p.freq, 0.707, 0);
    this.comp = new Compressor(
      {
        enabled: true,
        thresholdDb: p.thresholdDb,
        ratio: p.ratio,
        kneeDb: 3,
        attackMs: 1,
        releaseMs: 60,
        makeupDb: 0,
      },
      sampleRate,
    );
  }

  process(x: number): number {
    if (!this.enabled) return x;
    const high = this.hp.process(x);
    const low = this.lp.process(x);
    return low + this.comp.process(high);
  }
}

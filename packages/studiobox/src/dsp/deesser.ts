import { DeesserParams } from '../config/schema';
import { Biquad } from './biquad';
import { Compressor } from './compressor';

/** Split-band de-esser: compress only the high band keyed on its own energy.
 *  The rest is the input minus that band, so with no gain reduction the output
 *  is the input exactly. (A low-pass + high-pass pair at the same frequency
 *  does not add back up: two 2nd-order Butterworths cancel at the split and
 *  cut a deep notch there, a hole at 6.5-7 kHz in every voice.) */
export class Deesser {
  private hp: Biquad;
  private comp: Compressor;
  private enabled: boolean;

  constructor(p: DeesserParams, sampleRate: number) {
    this.enabled = p.enabled;
    this.hp = Biquad.design('highpass', sampleRate, p.freq, 0.707, 0);
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
      sampleRate
    );
  }

  process(x: number): number {
    if (!this.enabled) return x;
    const high = this.hp.process(x);
    return x - high + this.comp.process(high);
  }
}

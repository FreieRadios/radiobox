import { CompressorParams } from '../config/schema';
import { dbToGain, gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

/** Feed-forward compressor with soft knee. Optional external sidechain key. */
export class Compressor {
  private det: EnvelopeFollower;
  private atk: number;
  private rel: number;
  private grDb = 0; // current (smoothed) gain reduction, >= 0

  constructor(
    private p: CompressorParams,
    sampleRate: number
  ) {
    this.det = new EnvelopeFollower(sampleRate, 1, 10);
    this.atk = msToCoef(p.attackMs, sampleRate);
    this.rel = msToCoef(p.releaseMs, sampleRate);
  }

  /** Static gain-reduction curve (dB) for a detector level (dB). */
  private targetGr(levelDb: number): number {
    const { thresholdDb: t, ratio, kneeDb } = this.p;
    const over = levelDb - t;
    if (over <= -kneeDb / 2) return 0;
    const slope = 1 - 1 / ratio;
    if (kneeDb > 0 && over < kneeDb / 2) {
      const x = over + kneeDb / 2;
      return (slope * x * x) / (2 * kneeDb);
    }
    return slope * over;
  }

  /** `key` defaults to the input sample; pass a separate signal for sidechaining. */
  process(x: number, key: number = x): number {
    if (!this.p.enabled) return x;
    const levelDb = gainToDb(this.det.process(key));
    const target = this.targetGr(levelDb);
    const c = target > this.grDb ? this.atk : this.rel;
    this.grDb = c * (this.grDb - target) + target;
    return x * dbToGain(this.p.makeupDb - this.grDb);
  }

  get gainReductionDb(): number {
    return this.grDb;
  }
}

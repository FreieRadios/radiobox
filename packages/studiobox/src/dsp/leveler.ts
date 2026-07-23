import { LevelerParams } from '../config/schema';
import { clamp, dbToGain, msToCoef } from './dsp-math';
import { MonoLoudness } from './loudness';

/**
 * Slow auto-leveler (AGC). Nudges channel gain toward a loudness target based
 * on short-term loudness, so mics of different sensitivity/quality all land at
 * a consistent level — this is what delivers "perfect output volume for all
 * channels". Gentle and bounded; does not boost silence.
 */
export class Leveler {
  private meter: MonoLoudness;
  private coef: number;
  private gainDb = 0;
  private readonly gateLufs = -60; // below this we assume silence and hold gain

  constructor(
    private p: LevelerParams,
    sampleRate: number
  ) {
    this.meter = new MonoLoudness(sampleRate, 3.0);
    this.coef = msToCoef(p.responseMs, sampleRate);
  }

  process(x: number): number {
    if (!this.p.enabled) return x;
    const lufs = this.meter.process(x) > 0 ? this.meter.shortTermLufs : -Infinity;
    if (Number.isFinite(lufs) && lufs > this.gateLufs) {
      const want = clamp(this.p.targetLufs - lufs, -this.p.rangeDb, this.p.maxGainDb);
      this.gainDb = this.coef * (this.gainDb - want) + want;
    }
    return x * dbToGain(this.gainDb);
  }

  get gainDbValue(): number {
    return this.gainDb;
  }
}

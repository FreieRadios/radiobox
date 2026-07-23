import { GateParams } from '../config/schema';
import { dbToGain, gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

/** Downward expander / noise gate. Opens fast, holds, then closes to `rangeDb`. */
export class Gate {
  private det: EnvelopeFollower;
  private openCoef: number;
  private closeCoef: number;
  private holdSamples: number;
  private gainDb: number;
  private held = 0;

  constructor(
    private p: GateParams,
    sampleRate: number
  ) {
    this.det = new EnvelopeFollower(sampleRate, 1, 10);
    this.openCoef = msToCoef(p.attackMs, sampleRate);
    this.closeCoef = msToCoef(p.releaseMs, sampleRate);
    this.holdSamples = Math.round((p.holdMs / 1000) * sampleRate);
    this.gainDb = p.rangeDb;
  }

  /** Returns linear gain to apply to the sample. */
  process(x: number): number {
    if (!this.p.enabled) return 1;
    const lvlDb = gainToDb(this.det.process(x));
    const open = lvlDb >= this.p.thresholdDb;
    if (open) this.held = this.holdSamples;
    else if (this.held > 0) this.held--;

    const target = open || this.held > 0 ? 0 : this.p.rangeDb;
    const c = target > this.gainDb ? this.openCoef : this.closeCoef;
    this.gainDb = c * (this.gainDb - target) + target;
    return dbToGain(this.gainDb);
  }

  /** 0 = fully closed, 1 = fully open. */
  get openness(): number {
    return this.p.rangeDb === 0 ? 1 : 1 - this.gainDb / this.p.rangeDb;
  }
}

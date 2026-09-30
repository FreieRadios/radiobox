import { PriorityConfig } from '../config/schema';
import { gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

/**
 * Host priority: while the priority mic talks, the other listed mics are
 * turned down by `depthDb`. A slow attack and a slower release keep it a
 * gentle lean-back, never a mute — a guest who talks over the host stays
 * audible, just behind.
 */
export class Priority {
  private det: EnvelopeFollower;
  private atk: number;
  private rel: number;
  private holdSamples: number;
  private held = 0;
  private gainDb = 0;
  private depth: number;

  /** @param extraHoldMs added to the hold; the graph passes its mix look-ahead
   *  so an early decision doesn't also release early. */
  constructor(
    private p: PriorityConfig,
    sampleRate: number,
    extraHoldMs = 0
  ) {
    this.det = new EnvelopeFollower(sampleRate, 5, 80);
    this.atk = msToCoef(p.attackMs, sampleRate);
    this.rel = msToCoef(p.releaseMs, sampleRate);
    this.holdSamples = Math.round(((p.holdMs + extraHoldMs) / 1000) * sampleRate);
    this.depth = Math.min(0, p.depthDb);
  }

  /** `key` = the priority mic's signal as it enters the mix. Returns the
   *  attenuation for the other mics in dB (0 = none, negative = turned down). */
  process(key: number): number {
    if (!this.p.enabled) return 0;
    const trigger = gainToDb(this.det.process(key)) > this.p.thresholdDb;
    if (trigger) this.held = this.holdSamples;
    else if (this.held > 0) this.held--;
    const target = trigger || this.held > 0 ? this.depth : 0;
    const c = target < this.gainDb ? this.atk : this.rel;
    this.gainDb = c * (this.gainDb - target) + target;
    return this.gainDb;
  }

  /** Change the depth live (technician view). Clamped to [-24, 0] dB. */
  set depthDb(db: number) {
    this.depth = Math.max(-24, Math.min(0, db));
  }

  get depthDb(): number {
    return this.depth;
  }

  /** Current attenuation in dB (0 = the priority mic is quiet). */
  get attenuationDb(): number {
    return this.gainDb;
  }
}

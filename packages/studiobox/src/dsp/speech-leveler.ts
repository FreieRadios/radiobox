import { LevelerParams } from '../config/schema';
import { clamp, dbToGain, msToCoef } from './dsp-math';
import { KWeighting, powerToLufs } from './loudness';
import { DelayLine } from './delay-line';

/** Loudness below which a sample never counts as speech evidence, whatever the
 *  caller's key says (the old leveler's silence gate). */
const GATE_LUFS = -60;
/** Time constant of the speech-loudness estimate, in seconds of *active* time. */
const ESTIMATE_SEC = 1.0;
/** Evidence needed (as estimator weight, ~50 ms of speech) before the estimate
 *  is trusted enough to move the gain. */
const MIN_WEIGHT = 0.05;
/** Weight a seed gain enters the estimate with: a measured prior that the
 *  first seconds of real speech still outvote. */
const SEED_WEIGHT = 0.5;

/**
 * Voice-keyed mic leveler with look-ahead.
 *
 * The loudness of a mic is estimated **only while that mic is the active
 * talker** (the caller supplies the key — the graph derives it from the gate
 * and from which mic dominates), so a neighbour's bleed or room noise never
 * pumps the gain. The estimate is a K-weighted mean power over the last
 * second or so of active speech, which makes it independent of the pauses
 * between phrases.
 *
 * The audio itself leaves through a delay of `lookaheadSamples`: by the time
 * the first word of a phrase comes out, the analysis has already heard the
 * seconds that follow it and the gain has settled — a quiet voice is at
 * target from its first syllable instead of fading up over a sentence. With a
 * look-ahead of 0 it is a plain (still voice-keyed) causal leveler.
 *
 * In steady state the gain is `targetLufs - loudness`, clamped to
 * [-rangeDb, maxGainDb] — the same law as the windowed `Leveler`.
 */
export class SpeechLeveler {
  private kw = new KWeighting();
  private delay: DelayLine | null;
  private estCoef: number;
  private fastCoef: number;
  private gainCoef: number;
  private power = 0; // weighted K-power accumulator
  private weight = 0; // accumulated evidence, 0..1 (bias correction)
  private fast = 0; // fast K-power, for the absolute silence gate
  private wantDb: number;
  private gainDb: number;
  private gain = 1; // linear form of gainDb, as applied to the last sample
  private readonly gatePower = Math.pow(10, (GATE_LUFS + 0.691) / 10);

  constructor(
    private p: LevelerParams,
    sampleRate: number,
    lookaheadSamples = 0,
    seedDb = 0
  ) {
    this.delay = lookaheadSamples > 0 ? new DelayLine(lookaheadSamples) : null;
    this.estCoef = msToCoef(ESTIMATE_SEC * 1000, sampleRate);
    this.fastCoef = msToCoef(10, sampleRate);
    // With look-ahead the gain has to be home before the audio it was measured
    // on leaves the delay: cap the response at a quarter of the look-ahead.
    const lookMs = (lookaheadSamples / sampleRate) * 1000;
    const responseMs = lookMs > 0 ? Math.min(p.responseMs, lookMs / 4) : p.responseMs;
    this.gainCoef = msToCoef(responseMs, sampleRate);
    this.wantDb = 0;
    this.gainDb = 0;
    if (seedDb !== 0) this.seed(seedDb);
  }

  /** Start from a known gain (the setup assistant's measurement) instead of
   *  0 dB. Enters the estimate as a prior, so real speech still corrects it. */
  seed(gainDb: number): void {
    const g = clamp(gainDb, -this.p.rangeDb, this.p.maxGainDb);
    this.wantDb = g;
    this.gainDb = g;
    this.gain = dbToGain(g);
    // The loudness this gain implies: target - gain.
    this.power = SEED_WEIGHT * Math.pow(10, (this.p.targetLufs - g + 0.691) / 10);
    this.weight = SEED_WEIGHT;
  }

  /**
   * Process one sample. `active` says whether this mic is the active talker
   * right now; only then does the sample count as evidence for its loudness.
   * Returns the (delayed) sample with the leveler gain applied.
   */
  process(x: number, active = true): number {
    if (!this.p.enabled) return this.delay ? this.delay.process(x) : x;
    const k = this.kw.process(x);
    const k2 = k * k;
    this.fast = this.fastCoef * (this.fast - k2) + k2;
    if (active && this.fast > this.gatePower) {
      this.power = this.estCoef * this.power + (1 - this.estCoef) * k2;
      this.weight = this.estCoef * this.weight + (1 - this.estCoef);
      if (this.weight >= MIN_WEIGHT) {
        const lufs = powerToLufs(this.power / this.weight);
        if (Number.isFinite(lufs)) {
          this.wantDb = clamp(this.p.targetLufs - lufs, -this.p.rangeDb, this.p.maxGainDb);
        }
      }
    }
    // The gain keeps settling while the mic is quiet: a short "ja" is measured
    // in 300 ms but only leaves the delay seconds later, at the settled gain.
    this.gainDb = this.gainCoef * (this.gainDb - this.wantDb) + this.wantDb;
    this.gain = dbToGain(this.gainDb);
    const y = this.delay ? this.delay.process(x) : x;
    return y * this.gain;
  }

  /** Linear gain applied to the last sample. */
  get linearGain(): number {
    return this.gain;
  }

  /** Current gain in dB. With look-ahead this is the gain of the audio leaving
   *  the delay now, i.e. of what was said `lookahead` ago. */
  get gainDbValue(): number {
    return this.gainDb;
  }

  /** The gain the estimate is heading for (equals the gain once settled). */
  get targetGainDb(): number {
    return this.wantDb;
  }
}

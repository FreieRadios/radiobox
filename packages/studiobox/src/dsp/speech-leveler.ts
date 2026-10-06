import { LevelerParams } from '../config/schema';
import { clamp, dbToGain, msToCoef } from './dsp-math';
import { KWeighting, powerToLufs } from './loudness';
import { DelayLine } from './delay-line';

/** Loudness below which a sample never counts as speech evidence, whatever the
 *  caller's key says (the old leveler's silence gate). */
const GATE_LUFS = -60;
/** Analysis frame, in ms. */
const FRAME_MS = 10;
/** Half-width of the rider window, in ms: the fast stage follows changes over
 *  about half a second — a child turning away in the middle of a sentence. */
const RIDER_MS = 250;
/** Share of the rider's measured deviation it corrects: the rest is prosody. */
const RIDER_AMOUNT = 0.7;
/** Default limit of the rider correction, dB (`riderDb`). */
const DEFAULT_RIDER_DB = 6;
/** Time constant the applied gain glides with, in ms. */
const SMOOTH_MS = 40;
/** Time constant of the long-term loudness (the prior), in seconds of speech. */
const LONG_SEC = 10;
/** Weight of the long-term loudness in a phrase estimate, in seconds of
 *  speech, less the speech the window holds: a phrase full of speech stands
 *  on its own, a lone "ja" leans on it. */
const PRIOR_SEC = 0.5;
/** Weight of the phrase loudness in a rider estimate, in seconds of speech. */
const RIDER_PRIOR_SEC = 0.03;
/** Evidence needed (seconds of speech) before the gain moves at all. */
const MIN_EVIDENCE_SEC = 0.05;

/**
 * Voice-keyed mic leveler with a look-ahead window centred on the audio.
 *
 * The loudness of a mic is measured **only while that mic is the active
 * talker** (the caller supplies the key — the graph derives it from the gate,
 * the voice detector and which mic dominates), so a neighbour's bleed or
 * room noise never pumps the gain. Evidence is collected on 10 ms frames of
 * K-weighted power.
 *
 * The audio leaves through a delay of `lookaheadSamples`, and the gain for
 * each moment is computed from the speech **around** it — `responseMs`
 * before and after (as far as the look-ahead reaches) — rather than from the
 * speech that came before. Two stages:
 *
 *  - **phrase**: loudness over ±`responseMs`, leaning on the long-term
 *    loudness when the window holds little speech. This sets the talker's
 *    level from the first syllable on.
 *  - **rider**: loudness over ±250 ms against the phrase, corrected by 70 %
 *    and at most ±`riderDb` — catches a talker turning away from the mic or
 *    leaning in mid-sentence without flattening every syllable.
 *
 * The gain is limited to [-rangeDb, maxGainDb] and, when the caller reports
 * the mic's noise floor, to what keeps that floor under `noiseCeilingDb`.
 * With a look-ahead of 0 it is a causal leveler over the past 2 × responseMs.
 */
export class SpeechLeveler {
  private kw = new KWeighting();
  private delay: DelayLine | null;
  private readonly frame: number;
  private readonly sr: number;
  // Cumulative frame sums (energy, evidence samples), ring-indexed by frame.
  private cumE: Float64Array;
  private cumN: Float64Array;
  private readonly ring: number;
  private f = 0; // completed frames
  private accE = 0;
  private accN = 0;
  private inFrame = 0;
  private readonly lookF: number;
  private readonly smoothF: number;
  private readonly phrasePast: number;
  private readonly phraseFuture: number;
  private readonly riderPast: number;
  private readonly riderFuture: number;
  private fastCoef: number;
  private gainCoef: number;
  private fast = 0; // fast K-power, for the absolute silence gate
  private ltPow = 0; // long-term loudness (power), bias-corrected by ltW
  private ltW = 0;
  private wantDb = 0;
  private gainDb = 0;
  private gain = 1; // linear form of gainDb, as applied to the last sample
  private cap: number;
  private readonly gatePower = Math.pow(10, (GATE_LUFS + 0.691) / 10);

  constructor(
    private p: LevelerParams,
    sampleRate: number,
    lookaheadSamples = 0,
    seedDb = 0
  ) {
    this.sr = sampleRate;
    this.delay = lookaheadSamples > 0 ? new DelayLine(lookaheadSamples) : null;
    this.frame = Math.round((FRAME_MS / 1000) * sampleRate);
    this.lookF = Math.floor(lookaheadSamples / this.frame);
    // The glide lags the target by about its time constant: aim that far ahead.
    this.smoothF = this.lookF > 0 ? Math.round(SMOOTH_MS / FRAME_MS) : 0;
    const reach = Math.max(0, this.lookF - this.smoothF);
    const half = Math.max(1, Math.round(p.responseMs / 2 / FRAME_MS));
    this.phraseFuture = Math.min(half, reach);
    this.phrasePast = 2 * half - this.phraseFuture;
    const rHalf = Math.round(RIDER_MS / FRAME_MS);
    this.riderFuture = Math.min(rHalf, reach);
    this.riderPast = 2 * rHalf - this.riderFuture;
    this.ring = this.lookF + this.phrasePast + 4;
    this.cumE = new Float64Array(this.ring);
    this.cumN = new Float64Array(this.ring);
    this.fastCoef = msToCoef(10, sampleRate);
    this.gainCoef = msToCoef(SMOOTH_MS, sampleRate);
    this.cap = p.maxGainDb;
    if (seedDb !== 0) this.seed(seedDb);
  }

  /** Start from a known gain (the setup assistant's measurement) instead of
   *  0 dB. Enters as the long-term loudness, so real speech still corrects it. */
  seed(gainDb: number): void {
    const g = clamp(gainDb, -this.p.rangeDb, this.p.maxGainDb);
    this.wantDb = g;
    this.gainDb = g;
    this.gain = dbToGain(g);
    // The loudness this gain implies: target - gain.
    this.ltPow = Math.pow(10, (this.p.targetLufs - g + 0.691) / 10);
    this.ltW = 1;
  }

  /** The mic's noise floor (dBFS RMS, before the leveler) as the caller
   *  measures it: the gain is held where it keeps that floor under
   *  `noiseCeilingDb`. Never forces a cut, only limits the boost. */
  setNoiseFloor(db: number): void {
    const ceiling = this.p.noiseCeilingDb;
    this.cap =
      ceiling === undefined || !Number.isFinite(db)
        ? this.p.maxGainDb
        : Math.min(this.p.maxGainDb, Math.max(0, ceiling - db));
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
      this.accE += k2;
      this.accN++;
    }
    if (++this.inFrame >= this.frame) this.endFrame();
    this.gainDb = this.gainCoef * (this.gainDb - this.wantDb) + this.wantDb;
    this.gain = dbToGain(this.gainDb);
    const y = this.delay ? this.delay.process(x) : x;
    return y * this.gain;
  }

  private endFrame(): void {
    const R = this.ring;
    const f = this.f;
    const e = this.accE;
    const n = this.accN;
    this.cumE[(f + 1) % R] = this.cumE[f % R] + e;
    this.cumN[(f + 1) % R] = this.cumN[f % R] + n;
    this.f = f + 1;
    this.accE = 0;
    this.accN = 0;
    this.inFrame = 0;
    if (n > 0) {
      const a = 1 - Math.exp(-n / (LONG_SEC * this.sr));
      this.ltPow += a * (e / n - this.ltPow);
      this.ltW += a * (1 - this.ltW);
    }
    this.update();
  }

  /** Sums over frames [a, b) of the window, clipped to what has been seen. */
  private window(center: number, past: number, future: number): [number, number] {
    const top = this.f;
    const b = Math.min(top, center + future);
    const a = Math.max(0, center - past, top - this.ring + 1);
    if (b <= a) return [0, 0];
    const R = this.ring;
    return [this.cumE[b % R] - this.cumE[a % R], this.cumN[b % R] - this.cumN[a % R]];
  }

  private update(): void {
    const sr = this.sr;
    // Frame the audio leaving the delay belongs to, plus the glide's lag.
    const c = this.f - this.lookF + this.smoothF;
    const [pe, pn] = this.window(c, this.phrasePast, this.phraseFuture);
    // The long-term loudness only fills in for speech the window lacks: from
    // PRIOR_SEC of speech in the window on, the window speaks for itself.
    const prior = this.ltW > 0 ? this.ltPow / this.ltW : 0;
    const priorN = this.ltW > 0 ? Math.max(0, PRIOR_SEC * sr - pn) : 0;
    const n = pn + priorN;
    if (n < MIN_EVIDENCE_SEC * sr) return; // nothing to go on: hold
    const phrasePow = (pe + prior * priorN) / n;
    const phrase = powerToLufs(phrasePow);
    if (!Number.isFinite(phrase)) return;
    let want = this.p.targetLufs - phrase;
    const riderMax = this.p.riderDb ?? DEFAULT_RIDER_DB;
    if (riderMax > 0) {
      const [re, rn] = this.window(c, this.riderPast, this.riderFuture);
      if (rn > 0) {
        const rp = RIDER_PRIOR_SEC * sr;
        const rider = powerToLufs((re + phrasePow * rp) / (rn + rp));
        if (Number.isFinite(rider)) {
          want += clamp((phrase - rider) * RIDER_AMOUNT, -riderMax, riderMax);
        }
      }
    }
    this.wantDb = clamp(want, -this.p.rangeDb, Math.max(-this.p.rangeDb, this.cap));
  }

  /** Linear gain applied to the last sample. */
  get linearGain(): number {
    return this.gain;
  }

  /** Current gain in dB: the gain of the audio leaving the delay now, i.e. of
   *  what was said `lookahead` ago. */
  get gainDbValue(): number {
    return this.gainDb;
  }

  /** The gain the leveler is heading for. */
  get targetGainDb(): number {
    return this.wantDb;
  }

  /** The highest gain allowed now (maxGainDb, or less for a noisy mic). */
  get capDb(): number {
    return this.cap;
  }
}

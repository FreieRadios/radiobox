import { ChannelProcessing } from '../config/schema';
import { Biquad } from './biquad';
import { Gate } from './gate';
import { Deesser } from './deesser';
import { Compressor } from './compressor';
import { SpeechLeveler } from './speech-leveler';
import { EnvelopeFollower } from './envelope';
import { DelayLine } from './delay-line';
import { dbToGain, gainToDb, msToCoef } from './dsp-math';

/** Speech level the guest indicator calls "passt", and the tolerance around
 *  it, when a channel doesn't configure its own zone. */
export const DEFAULT_ZONE = { centerDb: -20, widthDb: 6 };
/** How long a measured speech level stays valid after the talker stopped. */
const SPEECH_HOLD_SEC = 2;

export type Zone = 'low' | 'ok' | 'high' | null;

export interface StripMeters {
  /** Level of the strip's output (after the leveler), in room time. */
  outDb: number;
  gateOpen: number;
  compGrDb: number;
  levelerDb: number;
  /** Speech level at the mic: RMS after the input trim, before gate,
   *  compressor and leveler, measured only while this mic is the active
   *  talker. Follows mouth distance, not the processed output. Null when the
   *  mic hasn't been the talker for a moment. */
  speechDb: number | null;
  /** `speechDb` against the channel's zone; null along with it. */
  zone: Zone;
  /** The zone itself: "passt" is `zoneCenterDb` +/- `zoneWidthDb` (dB, on the
   *  `speechDb` scale), so a view can draw the target band. */
  zoneCenterDb: number;
  zoneWidthDb: number;
}

/** Look-ahead lengths of a strip, in samples (0 = none). */
export interface StripLookahead {
  /** The gate opens this long before the onset that triggers it. */
  gate: number;
  /** The leveler hears this far ahead of the audio it sets the gain for. */
  leveler: number;
}

/**
 * Full mic channel chain:
 * trim -> HPF -> gate -> EQ -> de-esser -> compressor -> leveler -> gain.
 *
 * It runs in two halves so the graph can key the leveler: `pre()` is
 * everything up to the compressor, in (almost) room time; `level()` is the
 * voice-keyed look-ahead leveler and the output gain, which delay the audio
 * by the look-ahead. `process()` chains both for callers without a key.
 */
export class ChannelStrip {
  private trim!: number;
  private hpf!: Biquad | null;
  private gate!: Gate;
  private gateDelay: DelayLine | null;
  private gateLookMs: number;
  private eq!: Biquad[];
  private deesser!: Deesser;
  private comp!: Compressor;
  private leveler: SpeechLeveler;
  private outGain!: number;
  private outEnv: EnvelopeFollower;
  private zone!: { centerDb: number; widthDb: number };

  // Speech-level meter (mean square after trim + HPF, only while active).
  private speechCoef: number;
  private speechPower = 0;
  private speechWeight = 0;
  private lastIn = 0; // the sample pre() last saw, after trim + HPF
  private sinceActive = Infinity; // samples since the mic last was the talker
  private readonly speechHold: number;

  /** Samples the strip's output runs behind its input. */
  readonly latency: number;

  constructor(
    p: ChannelProcessing,
    private sampleRate: number,
    look: StripLookahead = { gate: 0, leveler: 0 }
  ) {
    this.gateDelay = look.gate > 0 ? new DelayLine(look.gate) : null;
    this.gateLookMs = (look.gate / sampleRate) * 1000;
    this.leveler = new SpeechLeveler(p.leveler, sampleRate, look.leveler);
    this.outEnv = new EnvelopeFollower(sampleRate, 1, 150);
    this.speechCoef = msToCoef(300, sampleRate);
    this.speechHold = Math.round(SPEECH_HOLD_SEC * sampleRate);
    this.latency = look.gate + look.leveler;
    this.configure(p);
  }

  /** (Re)build the blocks a parameter change affects. Delay lines and the
   *  leveler's state are kept, so retuning a live strip (setup assistant,
   *  trims) doesn't drop audio; the rebuilt detectors settle within ms. */
  private configure(p: ChannelProcessing): void {
    const sr = this.sampleRate;
    this.trim = dbToGain(p.trimDb ?? 0);
    this.hpf = p.hpfHz > 0 ? Biquad.design('highpass', sr, p.hpfHz, 0.707, 0) : null;
    // The gate's decision leads the audio by the look-ahead, so it would also
    // close that much early: give the hold the same head start back.
    this.gate = new Gate({ ...p.gate, holdMs: p.gate.holdMs + this.gateLookMs }, sr);
    this.eq = p.eq.map((b) => Biquad.design(b.type, sr, b.freq, b.q, b.gainDb));
    this.deesser = new Deesser(p.deesser, sr);
    this.comp = new Compressor(p.compressor, sr);
    this.outGain = dbToGain(p.gainDb);
    this.zone = p.zone ?? DEFAULT_ZONE;
  }

  /** Apply new processing parameters to the running strip. `seedDb`, when
   *  given, restarts the leveler from that gain. */
  retune(p: ChannelProcessing, seedDb?: number): void {
    this.configure(p);
    if (seedDb !== undefined) this.leveler.seed(seedDb);
  }

  /** First half: trim -> HPF -> gate -> EQ -> de-esser -> compressor.
   *  The result runs `look.gate` samples behind the input. */
  pre(x: number): number {
    let y = x * this.trim;
    if (this.hpf) y = this.hpf.process(y);
    this.lastIn = y;
    const g = this.gate.process(y);
    if (this.gateDelay) y = this.gateDelay.process(y);
    y *= g;
    for (const b of this.eq) y = b.process(y);
    y = this.deesser.process(y);
    return this.comp.process(y);
  }

  /** Second half: leveler (keyed by `active`, delayed by the look-ahead) and
   *  output gain. Also feeds the speech-level meter from the sample `pre()`
   *  last saw. */
  level(c: number, active: boolean): number {
    if (active) {
      const p2 = this.lastIn * this.lastIn;
      this.speechPower = this.speechCoef * this.speechPower + (1 - this.speechCoef) * p2;
      this.speechWeight = this.speechCoef * this.speechWeight + (1 - this.speechCoef);
      this.sinceActive = 0;
    } else if (this.sinceActive < this.speechHold) {
      this.sinceActive++;
      if (this.sinceActive >= this.speechHold) {
        // Stale: the next phrase starts a fresh measurement.
        this.speechPower = 0;
        this.speechWeight = 0;
      }
    }
    const y = this.leveler.process(c, active) * this.outGain;
    // Metered in room time: what this sample will come out as once it has
    // passed the look-ahead delay with the gain as it stands now.
    this.outEnv.process(c * this.leveler.linearGain * this.outGain);
    return y;
  }

  /** Both halves, for callers without a talker key: the mic counts as active
   *  whenever its gate is open. */
  process(x: number): number {
    const c = this.pre(x);
    return this.level(c, this.gate.openness > 0.5);
  }

  /** The sample `pre()` last saw, after trim and HPF (before the gate). */
  get input(): number {
    return this.lastIn;
  }

  /** Tell the leveler the mic's noise floor (dBFS RMS after the trim). */
  setNoiseFloor(db: number): void {
    this.leveler.setNoiseFloor(db);
  }

  /** True while the gate is (mostly) open. */
  get gateIsOpen(): boolean {
    return this.gate.openness > 0.5;
  }

  /** The gain the leveler is heading for (its gain once settled), in dB. */
  get levelerTargetDb(): number {
    return this.leveler.targetGainDb;
  }

  /** Linear leveler x output gain as it stands now (room time). */
  get roomGain(): number {
    return this.leveler.linearGain * this.outGain;
  }

  meters(): StripMeters {
    const speechDb =
      this.speechWeight > 0.05 && this.sinceActive < this.speechHold
        ? 10 * Math.log10(Math.max(this.speechPower / this.speechWeight, 1e-18))
        : null;
    let zone: Zone = null;
    if (speechDb !== null) {
      const d = speechDb - this.zone.centerDb;
      zone = d < -this.zone.widthDb ? 'low' : d > this.zone.widthDb ? 'high' : 'ok';
    }
    return {
      outDb: gainToDb(this.outEnv.value),
      gateOpen: this.gate.openness,
      compGrDb: this.comp.gainReductionDb,
      levelerDb: this.leveler.gainDbValue,
      speechDb,
      zone,
      zoneCenterDb: this.zone.centerDb,
      zoneWidthDb: this.zone.widthDb,
    };
  }
}

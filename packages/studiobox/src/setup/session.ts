import { ChannelProcessing } from '../config/schema';
import { MicCapture, MicResult, analyseMic, automixFloorDb } from './measure';

/**
 * The setup assistant ("Einmessen") as a state machine over raw capture
 * blocks:
 *
 *   idle -> silence (room noise per mic) -> speakers (each voice in turn)
 *        -> result (before/after per mic, waiting for apply or discard)
 *
 * It only listens — the programme is not touched until the pipeline applies a
 * result. Who is talking is detected from the audio, so the order doesn't
 * matter; the `current` mic is merely who is asked to talk next, and it
 * settles the rare frame in which two mics hear a voice about equally.
 */

export type SetupPhase = 'idle' | 'silence' | 'speakers' | 'result';

/** Text the speakers read aloud, so everybody talks about the same way. */
export const SETUP_SENTENCE =
  'Sechs fleißige Gäste testen zwischen zwölf und sieben Uhr das Studio. ' +
  'Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich.';

export interface SetupMic {
  label: string;
  /** 0-based capture channel. */
  source: number;
  processing: ChannelProcessing;
  /** Leveler gain the strip stands at now (for the "before" column). */
  seedDb?: number;
}

export interface SetupOptions {
  /** Room silence to collect, seconds. */
  silenceSec?: number;
  /** Speech to collect per mic, seconds. */
  speechSec?: number;
}

export interface SetupStatus {
  phase: SetupPhase;
  /** Label of the mic whose speaker is asked to talk now (speakers phase). */
  current: string | null;
  /** The sentence to read aloud. */
  sentence: string;
  /** Progress of the silence phase, 0..1. */
  silence: number;
  /** Per mic being measured: how much speech has been collected, 0..1. */
  mics: { label: string; channel: number; progress: number; done: boolean }[];
  /** Filled in the result phase. */
  results: MicResult[] | null;
  /** Automix floor the results suggest (dB), result phase. */
  automixFloorDb: number | null;
}

interface MicState {
  mic: SetupMic;
  measured: boolean; // part of this run (false: left alone in a re-measure)
  noise: Float32Array;
  noiseLen: number;
  noiseDb: number; // robust noise level, set when the silence phase ends
  frameDbs: number[]; // per-frame level during silence
  speech: Float32Array;
  speechLen: number;
  /** Per other mic (index): this mic while *that* mic's speaker talked. */
  bleed: Map<number, { buf: Float32Array; len: number }>;
}

/** Analysis frame: 20 ms. */
const FRAME_SEC = 0.02;
/** A frame is speech when the best mic is this far above its noise floor. */
const SPEECH_SNR_DB = 12;
/** The best mic wins a frame outright with this lead over the runner-up. */
const CLEAR_MARGIN_DB = 6;
/** Bleed kept per neighbour, seconds. */
const BLEED_SEC = 2;

const frameDb = (x: Float32Array, from: number, n: number): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s += x[from + i] * x[from + i];
  return 10 * Math.log10(Math.max(s / n, 1e-20));
};

export class SetupSession {
  private phase: SetupPhase = 'idle';
  private mics: MicState[] = [];
  private results: MicResult[] | null = null;
  /** Results carried over for the mics a re-measure leaves alone. */
  private kept: MicResult[] | null = null;
  private readonly frame: number;
  private readonly silenceLen: number;
  private readonly speechLen: number;
  private readonly bleedLen: number;
  // Frame assembly across capture blocks.
  private pending: Float32Array[] = [];
  private pendingLen = 0;

  constructor(
    private sampleRate: number,
    opts: SetupOptions = {}
  ) {
    this.frame = Math.round(FRAME_SEC * sampleRate);
    this.silenceLen = Math.round((opts.silenceSec ?? 5) * sampleRate);
    this.speechLen = Math.round((opts.speechSec ?? 6) * sampleRate);
    this.bleedLen = Math.round(BLEED_SEC * sampleRate);
  }

  get active(): boolean {
    return this.phase === 'silence' || this.phase === 'speakers';
  }

  /**
   * Start a run over `mics`. With `only`, just those labels are measured
   * again ("Nur diesen Kanal neu messen" after a knob change); the others
   * keep their previous result.
   */
  start(mics: SetupMic[], only?: string[]): void {
    const keep = only && this.results ? this.results : null;
    this.mics = mics.map((mic) => ({
      mic,
      measured: !only || only.includes(mic.label),
      noise: new Float32Array(this.silenceLen),
      noiseLen: 0,
      noiseDb: -120,
      frameDbs: [],
      speech: new Float32Array(this.speechLen),
      speechLen: 0,
      bleed: new Map(),
    }));
    this.kept = keep;
    this.results = null;
    this.pending = mics.map(() => new Float32Array(this.frame));
    this.pendingLen = 0;
    this.phase = this.mics.some((m) => m.measured) ? 'silence' : 'idle';
  }

  /** Abort a running measurement or drop a result. */
  cancel(): void {
    this.phase = 'idle';
    this.results = null;
    this.kept = null;
  }

  /** End the speakers phase now and compute results from what was collected
   *  (mics without enough speech come out as "kein Signal"). */
  finish(): void {
    if (this.phase === 'speakers') this.compute();
  }

  /** Feed one capture block (de-interleaved, index = capture channel). */
  feed(input: Float32Array[], frames: number): void {
    if (!this.active) return;
    let at = 0;
    while (at < frames && this.active) {
      const take = Math.min(this.frame - this.pendingLen, frames - at);
      for (let i = 0; i < this.mics.length; i++) {
        const src = input[this.mics[i].mic.source];
        this.pending[i].set(src.subarray(at, at + take), this.pendingLen);
      }
      this.pendingLen += take;
      at += take;
      if (this.pendingLen === this.frame) {
        this.pendingLen = 0;
        if (this.phase === 'silence') this.silenceFrame();
        else this.speechFrame();
      }
    }
  }

  private silenceFrame(): void {
    let done = true;
    for (let i = 0; i < this.mics.length; i++) {
      const m = this.mics[i];
      if (m.noiseLen < this.silenceLen) {
        const n = Math.min(this.frame, this.silenceLen - m.noiseLen);
        m.noise.set(this.pending[i].subarray(0, n), m.noiseLen);
        m.noiseLen += n;
        m.frameDbs.push(frameDb(this.pending[i], 0, this.frame));
      }
      if (m.noiseLen < this.silenceLen) done = false;
    }
    if (!done) return;
    for (const m of this.mics) {
      // The median frame: a cough or a chair during the "silence" must not
      // pass for the noise floor.
      const sorted = [...m.frameDbs].sort((a, b) => a - b);
      m.noiseDb = sorted[Math.floor(sorted.length / 2)];
      // Keep only the frames that really are floor for the peak statistics.
      let o = 0;
      const clean = new Float32Array(m.noiseLen);
      for (let f = 0; f < m.frameDbs.length; f++) {
        if (m.frameDbs[f] <= m.noiseDb + 6) {
          const from = f * this.frame;
          const n = Math.min(this.frame, m.noiseLen - from);
          clean.set(m.noise.subarray(from, from + n), o);
          o += n;
        }
      }
      m.noise = clean.subarray(0, o);
      m.noiseLen = o;
    }
    this.phase = 'speakers';
  }

  /** Index of the mic whose speaker is asked to talk now, or -1. */
  private currentIndex(): number {
    return this.mics.findIndex((m) => m.measured && m.speechLen < this.speechLen);
  }

  private speechFrame(): void {
    // Level of every mic above its own noise floor.
    let best = -1;
    let bestSnr = -Infinity;
    let second = -Infinity;
    for (let i = 0; i < this.mics.length; i++) {
      const snr = frameDb(this.pending[i], 0, this.frame) - this.mics[i].noiseDb;
      if (snr > bestSnr) {
        second = bestSnr;
        bestSnr = snr;
        best = i;
      } else if (snr > second) {
        second = snr;
      }
    }
    if (best < 0 || bestSnr < SPEECH_SNR_DB) return; // nobody talks
    let talker = best;
    if (bestSnr - second < CLEAR_MARGIN_DB) {
      // Two mics hear this voice about equally (a sensitive mic next to a
      // deaf one). The mic that was asked to talk gets the benefit of the
      // doubt if it is one of them; otherwise the frame is dropped.
      const cur = this.currentIndex();
      if (cur < 0) return;
      const curSnr = frameDb(this.pending[cur], 0, this.frame) - this.mics[cur].noiseDb;
      if (bestSnr - curSnr >= CLEAR_MARGIN_DB) return;
      talker = cur;
    }
    const t = this.mics[talker];
    if (t.measured && t.speechLen < this.speechLen) {
      const n = Math.min(this.frame, this.speechLen - t.speechLen);
      t.speech.set(this.pending[talker].subarray(0, n), t.speechLen);
      t.speechLen += n;
    }
    // What the others pick up of this voice.
    for (let i = 0; i < this.mics.length; i++) {
      if (i === talker || !this.mics[i].measured) continue;
      let b = this.mics[i].bleed.get(talker);
      if (!b) {
        b = { buf: new Float32Array(this.bleedLen), len: 0 };
        this.mics[i].bleed.set(talker, b);
      }
      if (b.len < this.bleedLen) {
        const n = Math.min(this.frame, this.bleedLen - b.len);
        b.buf.set(this.pending[i].subarray(0, n), b.len);
        b.len += n;
      }
    }
    if (this.currentIndex() < 0) this.compute();
  }

  private compute(): void {
    const results: MicResult[] = [];
    for (let i = 0; i < this.mics.length; i++) {
      const m = this.mics[i];
      if (!m.measured) {
        const old = this.kept?.find((r) => r.label === m.mic.label);
        if (old) results.push(old);
        continue;
      }
      // The loudest neighbour as heard on this mic.
      let bleed = new Float32Array(0);
      let bleedFrom: string | null = null;
      let loudest = -Infinity;
      for (const [from, b] of m.bleed) {
        if (b.len < this.frame * 5) continue;
        const lvl = frameDb(b.buf, 0, b.len);
        if (lvl > loudest) {
          loudest = lvl;
          bleed = b.buf.subarray(0, b.len);
          bleedFrom = this.mics[from].mic.label;
        }
      }
      const capture: MicCapture = {
        label: m.mic.label,
        channel: m.mic.source + 1,
        noise: m.noise.subarray(0, m.noiseLen),
        speech: m.speech.subarray(0, m.speechLen),
        bleed,
        bleedFrom,
        processing: m.mic.processing,
      };
      results.push(analyseMic(capture, this.sampleRate, m.mic.seedDb ?? 0));
    }
    this.results = results;
    this.kept = null;
    this.phase = 'result';
  }

  /** Results of the last run (result phase), else null. */
  getResults(): MicResult[] | null {
    return this.phase === 'result' ? this.results : null;
  }

  status(): SetupStatus {
    const cur = this.phase === 'speakers' ? this.currentIndex() : -1;
    const measured = this.mics.filter((m) => m.measured);
    const silence =
      this.phase === 'silence'
        ? Math.min(...measured.map((m) => m.noiseLen / this.silenceLen))
        : this.phase === 'idle'
          ? 0
          : 1;
    const results = this.getResults();
    return {
      phase: this.phase,
      current: cur >= 0 ? this.mics[cur].mic.label : null,
      sentence: SETUP_SENTENCE,
      silence,
      mics:
        this.phase === 'idle'
          ? []
          : measured.map((m) => ({
              label: m.mic.label,
              channel: m.mic.source + 1,
              progress: Math.min(1, m.speechLen / this.speechLen),
              done: m.speechLen >= this.speechLen,
            })),
      results,
      automixFloorDb: results ? automixFloorDb(results) : null,
    };
  }
}

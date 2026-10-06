import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { Log } from '../util/log';

/**
 * Plays a network stream (another studiobox's `/stream`, an Icecast mount)
 * into the file player's block, the way a file plays (roadmap M1c.2):
 *
 *   - **Jitter buffer.** Playback starts once `bufferMs` of audio is queued.
 *     The two ends run on different clocks (the sender's sound card, ours);
 *     a slow servo resamples by up to ±500 ppm so the buffer holds its depth
 *     over a show of any length, with a windowed-sinc interpolator that is
 *     transparent at these ratios. Nothing is dropped or repeated, so it
 *     works in continuous music too.
 *   - **Dropouts.** When the buffer runs dry it fades out (no click) and says
 *     'lost'; the decoder reconnects with back-off. Once the buffer has
 *     filled again it fades back in and says 'back'. The caller plays the
 *     bed in between (see `StreamFallback`).
 *   - **State in words** for the page: `status()`.
 */
export interface StreamSpec {
  label: string;
  url: string;
  bufferMs: number;
}

/** What `spawn` gives back (structural, so tests can drive a fake decoder). */
export interface StreamDecoder {
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  on(ev: 'close', fn: () => void): unknown;
}

export interface StreamStatus {
  label: string;
  /** `connecting`: the first fill. `playing`: on the output. `refilling`:
   *  data is back after a loss, the buffer fills. `gone`: silent, waiting for
   *  the stream (the bed may be playing). */
  state: 'connecting' | 'playing' | 'refilling' | 'gone';
  /** Data arrived within the last two seconds. */
  connected: boolean;
  /** Epoch ms since the output went silent (`gone`, `refilling`), else null. */
  goneSinceMs: number | null;
  /** Why the last connection ended, when the sender said: `off` (503, the
   *  sender switched its stream off), `refused` (401/403, wrong token),
   *  `missing` (404), else `unreachable`. Null while connected. */
  reason: 'off' | 'refused' | 'missing' | 'unreachable' | null;
  /** Audio queued, ms. */
  bufferMs: number;
  /** Current resampling correction, ppm (+ = playing faster). */
  ppm: number;
}

export interface StreamPlayerOptions {
  spawn?: (args: string[]) => StreamDecoder;
  now?: () => number;
}

const HALF = 16; // taps on each side of the interpolation point
const TAPS = 2 * HALF;
const PHASES = 512;
const FADE_IN_FIRST_MS = 50;
const FADE_IN_BACK_MS = 1000;
const FADE_OUT_MS = 20;
const SKIP_FADE_MS = 20;
/** Queued audio beyond target + this is skipped (a burst after a stall). */
const OVERFLOW_MS = 3000;
/** No data for this long on an open connection: it hangs, reconnect. */
const STALL_MS = 5000;
const BACKOFF_MS = [1000, 2000, 3000, 5000];

/** The resampling servo: from the buffer's fill to a playback ratio. Slow on
 *  purpose (a ~2000 s loop), so it follows a clock difference and never the
 *  network's jitter. */
export class FillServo {
  private smooth: number | null = null;
  static readonly MAX = 500e-6;
  /** ppm per second of error. */
  static readonly GAIN = 5e-4;
  constructor(
    private targetSec: number,
    private tauSec = 10
  ) {}

  reset(): void {
    this.smooth = null;
  }

  /** Feed the fill (seconds) seen at a block of `dtSec`; returns the ratio. */
  update(fillSec: number, dtSec: number): number {
    const a = Math.min(1, dtSec / this.tauSec);
    this.smooth = this.smooth === null ? fillSec : this.smooth + a * (fillSec - this.smooth);
    const err = this.smooth - this.targetSec;
    const c = Math.max(-FillServo.MAX, Math.min(FillServo.MAX, err * FillServo.GAIN));
    return 1 + c;
  }
}

/** Kaiser-windowed sinc table: PHASES rows of TAPS, each row summing to 1. */
function sincTable(): Float32Array {
  const bessel = (x: number): number => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const beta = 9;
  const cutoff = 0.94; // of Nyquist: flat to ~20 kHz, little aliasing
  const i0b = bessel(beta);
  const t = new Float32Array(PHASES * TAPS);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const x = k - (HALF - 1) - frac; // distance from the interpolation point
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const r = x / HALF;
      const w = Math.abs(r) >= 1 ? 0 : bessel(beta * Math.sqrt(1 - r * r)) / i0b;
      t[p * TAPS + k] = sinc * w;
      sum += sinc * w;
    }
    for (let k = 0; k < TAPS; k++) t[p * TAPS + k] /= sum;
  }
  return t;
}
let TABLE: Float32Array | null = null;

const defaultSpawn = (args: string[]): StreamDecoder => spawn('ffmpeg', args);

export class StreamPlayer extends EventEmitter {
  private readonly cap: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  /** Samples written so far (absolute), and the read position (fractional). */
  private written = 0;
  private pos = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly target: number; // samples
  private readonly servo: FillServo;
  private ratio = 1;
  private state: StreamStatus['state'] = 'connecting';
  private gain = 0;
  private fadeStep = 0; // per sample, + while fading in
  private goneSince: number | null = null;
  private reason: StreamStatus['reason'] = null;
  private proc: StreamDecoder | null = null;
  private lastData = 0;
  private spawnedAt = 0;
  private stopped = false;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly spawnFn: (args: string[]) => StreamDecoder;
  private readonly table: Float32Array;

  constructor(
    readonly spec: StreamSpec,
    private sampleRate: number,
    private log: Log,
    opts: StreamPlayerOptions = {}
  ) {
    super();
    this.now = opts.now ?? Date.now;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.target = Math.round((Math.max(200, spec.bufferMs) / 1000) * sampleRate);
    this.cap = this.target + Math.round(((OVERFLOW_MS + 4000) / 1000) * sampleRate) + 4 * TAPS;
    this.bufL = new Float32Array(this.cap);
    this.bufR = new Float32Array(this.cap);
    // History for the first interpolation: silence before the stream.
    this.written = HALF;
    this.pos = HALF;
    this.servo = new FillServo(this.target / sampleRate);
    this.table = TABLE ??= sincTable();
  }

  /** Connect (and keep reconnecting until `stop()`). */
  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkStall(), 1000);
    this.watchdog.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retry = null;
    this.watchdog = null;
    const p = this.proc;
    this.proc = null;
    p?.kill();
  }

  /** Audio queued, in samples. */
  get fill(): number {
    return this.written - this.pos;
  }

  status(): StreamStatus {
    const now = this.now();
    const connected = !!this.proc && this.lastData > 0 && now - this.lastData < 2000;
    return {
      label: this.spec.label,
      state: this.state,
      connected,
      goneSinceMs: this.goneSince,
      reason: connected ? null : this.reason,
      bufferMs: Math.round((Math.max(0, this.fill) / this.sampleRate) * 1000),
      ppm: Math.round((this.ratio - 1) * 1e6),
    };
  }

  // ---------------------------------------------------------------- input

  private connect(): void {
    if (this.stopped) return;
    const proc = this.spawnFn([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      this.spec.url,
      '-map',
      '0:a',
      '-ar',
      String(this.sampleRate),
      '-ac',
      '2',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ]);
    this.proc = proc;
    this.spawnedAt = this.now();
    let flowedAt = 0;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) return;
      if (!flowedAt) {
        flowedAt = this.now();
        this.log.info(`stream ${this.spec.label}: connected`);
      }
      this.lastData = this.now();
      this.reason = null;
      this.push(chunk);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      // ffmpeg names 4xx codes, but all of 5xx only as "5XX".
      if (/\b503\b|\b5XX\b/.test(s)) this.reason = 'off';
      else if (/\b40[13]\b/.test(s)) this.reason = 'refused';
      else if (/\b404\b/.test(s)) this.reason = 'missing';
      const line = s.trim();
      if (line) this.log.warn(`stream ${this.spec.label}: ${line.split('\n')[0]}`);
    });
    proc.on('close', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      if (!this.reason) this.reason = 'unreachable';
      // A connection that carried audio for a while starts the back-off over.
      if (flowedAt && this.now() - flowedAt > 10_000) this.attempt = 0;
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt++;
      this.log.warn(`stream ${this.spec.label}: ended (${this.reason}), again in ${wait / 1000} s`);
      this.retry = setTimeout(() => {
        this.retry = null;
        this.connect();
      }, wait);
      this.retry.unref?.();
    });
  }

  /** No data for STALL_MS since the last data or since this connection
   *  started (a hung connect counts too): end it, which reconnects. */
  private checkStall(): void {
    if (!this.proc) return;
    const since = Math.max(this.lastData, this.spawnedAt);
    if (this.now() - since > STALL_MS) {
      this.log.warn(`stream ${this.spec.label}: no data for ${STALL_MS / 1000} s, reconnecting`);
      this.reason = 'unreachable';
      this.proc.kill(); // 'close' schedules the reconnect
    }
  }

  /** Append decoded f32le stereo. */
  push(chunk: Buffer): void {
    let b = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const frames = Math.floor(b.length / 8);
    // Never overwrite what is still to be read: drop the oldest instead
    // (only after a long stall with the reader gone).
    const room = this.cap - TAPS - (this.written - Math.floor(this.pos) + HALF);
    if (frames > room) this.pos += frames - room;
    for (let n = 0; n < frames; n++) {
      const i = this.written % this.cap;
      this.bufL[i] = b.readFloatLE(8 * n);
      this.bufR[i] = b.readFloatLE(8 * n + 4);
      this.written++;
    }
    b = b.subarray(frames * 8);
    this.carry = b.length ? Buffer.from(b) : Buffer.alloc(0);
  }

  // ---------------------------------------------------------------- output

  /** Fill `frames` samples of output (silence while there is nothing). */
  read(outL: Float32Array, outR: Float32Array, frames: number): void {
    const fill = this.fill;
    if (this.state !== 'playing') {
      if (fill >= this.target) {
        const back = this.state !== 'connecting';
        this.state = 'playing';
        this.servo.reset();
        this.ratio = 1;
        this.gain = 0;
        const ms = back ? FADE_IN_BACK_MS : FADE_IN_FIRST_MS;
        this.fadeStep = 1 / Math.max(1, (ms / 1000) * this.sampleRate);
        if (back) {
          this.goneSince = null;
          this.log.info(`stream ${this.spec.label}: back`);
          this.emit('back');
        }
      } else {
        if (this.state === 'gone' && this.proc && this.lastData > (this.goneSince ?? 0)) {
          this.state = 'refilling';
        }
        outL.fill(0, 0, frames);
        outR.fill(0, 0, frames);
        return;
      }
    }

    // A burst after a stall: skip back to the target depth, faded.
    if (fill > this.target + (OVERFLOW_MS / 1000) * this.sampleRate) {
      const n = Math.min(frames, Math.round((SKIP_FADE_MS / 1000) * this.sampleRate));
      this.render(outL, outR, 0, n, -this.gain / n);
      this.pos = this.written - this.target;
      this.servo.reset();
      this.fadeStep = 1 / Math.max(1, (SKIP_FADE_MS / 1000) * this.sampleRate);
      this.render(outL, outR, n, frames, this.fadeStep);
      return;
    }

    this.ratio = this.servo.update(fill / this.sampleRate, frames / this.sampleRate);
    // Enough for this block plus a fade-out in reserve?
    const reserve = Math.round((FADE_OUT_MS / 1000) * this.sampleRate);
    const need = Math.ceil(frames * this.ratio) + HALF + 1;
    if (fill >= need + reserve) {
      this.render(outL, outR, 0, frames, this.fadeStep);
      return;
    }
    // Running dry: fade out over what is left, then silence.
    const can = Math.max(0, Math.floor((fill - HALF - 1) / this.ratio));
    const n = Math.min(frames, can);
    const ramp = Math.max(1, Math.min(n, reserve));
    this.render(outL, outR, 0, n - ramp, this.fadeStep);
    this.render(outL, outR, n - ramp, n, -this.gain / ramp);
    outL.fill(0, n, frames);
    outR.fill(0, n, frames);
    this.state = 'gone';
    this.goneSince = this.now();
    this.servo.reset();
    this.ratio = 1;
    this.log.warn(`stream ${this.spec.label}: buffer empty, silent`);
    this.emit('lost');
  }

  /** Resample samples [from, to) of the output; the gain moves by `step`
   *  per sample (fades), clamped to 0..1. */
  private render(
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    step: number
  ): void {
    const t = this.table;
    const cap = this.cap;
    const bl = this.bufL;
    const br = this.bufR;
    let pos = this.pos;
    let g = this.gain;
    for (let n = from; n < to; n++) {
      const i = Math.floor(pos);
      let p = Math.round((pos - i) * PHASES);
      let base = i - (HALF - 1);
      if (p === PHASES) {
        p = 0;
        base++;
      }
      let l = 0;
      let r = 0;
      const row = p * TAPS;
      for (let k = 0; k < TAPS; k++) {
        const j = (base + k) % cap;
        const h = t[row + k];
        l += bl[j] * h;
        r += br[j] * h;
      }
      g += step;
      if (g > 1) g = 1;
      else if (g < 0) g = 0;
      outL[n] = l * g;
      outR[n] = r * g;
      pos += this.ratio;
    }
    this.pos = pos;
    this.gain = g;
    if (g >= 1 && step > 0) this.fadeStep = 0;
  }
}

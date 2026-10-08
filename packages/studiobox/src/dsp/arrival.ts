import { Biquad } from './biquad';
import { Fft } from './fft';

/**
 * Who is talking, from **arrival time**: a voice reaches its own mic first
 * and every other mic a little later (≈ 3 ms per metre). The lead between
 * two mics comes from a phase-only cross-correlation (GCC-PHAT), which does
 * not care how loud either mic is — so the answer stays right however the
 * gain knobs and trims are set. A level comparison can't promise that: with
 * a stale trim the hot mic "wins" every overlap (see the 2026-10-07 show).
 *
 * Works in hops of 40 ms on a 16 kHz copy of the mics (enough for speech and
 * for a lag resolution of 2 cm; about a twentieth of the cost at 48 kHz).
 * For each hop it reports each mic's raw level (dBFS RMS, before any trim —
 * the same measure as the setup assistant's), its noise floor, and the
 * talker: the mic that leads every other mic it correlates clearly with, or
 * -1 when nobody talks or it is unclear.
 */

export interface ArrivalOptions {
  /** Largest lead looked for, ms: the farthest two mics apart (10 ms ≈ 3.4 m). */
  maxLagMs?: number;
  /** A mic leads only by at least this much, ms. Rejects the zero-lag peak of
   *  electrical crosstalk and mics closer than ~17 cm to each other. */
  minLeadMs?: number;
  /** Peak over the mean of the correlation that counts as clear. */
  confidence?: number;
}

export interface ArrivalHop {
  /** The talker's mic (index), or -1. */
  talker: number;
  /** Raw level per mic over the hop, dBFS RMS (no trim, no filter). */
  levelDb: Float64Array;
  /** Noise floor per mic, dBFS: a low percentile of the last 10 s of hops. */
  floorDb: Float64Array;
  /** Length of the hop, seconds. */
  dtSec: number;
}

/** A mic's level has to stand this far over its floor to count as speech
 *  (the setup assistant's rule). */
export const SPEECH_SNR_DB = 12;
/** Without a clear arrival order, one mic still wins outright with this lead
 *  in SNR over every other mic (also the setup assistant's rule). */
const CLEAR_MARGIN_DB = 6;
/** A partner needs this much SNR for its correlation to be worth computing. */
const PARTNER_SNR_DB = 3;
const ANALYSIS_RATE = 16000;
const HOP_SEC = 0.04;
const FLOOR_SEC = 10;
const FLOOR_PERCENTILE = 0.1;
const BAND_LO_HZ = 150;
const BAND_HI_HZ = 4000;

export class ArrivalTalker {
  private readonly step: number; // decimation factor
  private readonly hop: number; // hop at the analysis rate
  private readonly win: number; // window at the analysis rate
  private readonly fft: Fft;
  private readonly maxLag: number;
  private readonly minLead: number;
  private readonly conf: number;
  private readonly binLo: number;
  private readonly binHi: number;
  private readonly hann: Float64Array;
  private readonly lp: Biquad[][];
  private readonly ring: Float64Array[]; // analysis-rate history (window long)
  private ringPos = 0;
  private phase = 0; // samples into the current decimation step
  private inHop = 0; // analysis samples into the current hop
  private readonly sumSq: Float64Array; // full-rate energy of the current hop
  private fullN = 0;
  private readonly specRe: Float64Array[];
  private readonly specIm: Float64Array[];
  private readonly has: boolean[];
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly floors: Float64Array[]; // per mic, ring of hop levels
  private floorPos = 0;
  private floorFill = 0;
  private readonly sorted: Float64Array;
  private readonly lagCache: Float64Array; // n x n, NaN = no clear peak
  private readonly lagDone: Uint8Array; // n x n, 1 = computed this hop
  private readonly out: ArrivalHop;

  constructor(
    private readonly n: number,
    sampleRate: number,
    opts: ArrivalOptions = {}
  ) {
    this.step = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
    const rate = sampleRate / this.step;
    this.hop = Math.round(HOP_SEC * rate);
    let w = 1;
    while (w < this.hop * 1.5) w <<= 1;
    this.win = w;
    this.fft = new Fft(2 * w); // zero-padded: no circular wrap of the lags
    this.maxLag = Math.min(w - 1, Math.round(((opts.maxLagMs ?? 10) / 1000) * rate));
    this.minLead = Math.max(1, Math.round(((opts.minLeadMs ?? 0.5) / 1000) * rate));
    this.conf = opts.confidence ?? 6;
    this.binLo = Math.max(1, Math.floor((BAND_LO_HZ / rate) * 2 * w));
    this.binHi = Math.min(w, Math.ceil((BAND_HI_HZ / rate) * 2 * w));
    this.hann = new Float64Array(w);
    for (let i = 0; i < w; i++) this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (w - 1));
    // 4th-order Butterworth low-pass ahead of the decimation.
    const cut = Math.min(0.4 * rate, 6000);
    this.lp = Array.from({ length: n }, () =>
      this.step > 1
        ? [
            Biquad.design('lowpass', sampleRate, cut, 0.5412, 0),
            Biquad.design('lowpass', sampleRate, cut, 1.3066, 0),
          ]
        : []
    );
    this.ring = Array.from({ length: n }, () => new Float64Array(w));
    this.sumSq = new Float64Array(n);
    this.specRe = Array.from({ length: n }, () => new Float64Array(2 * w));
    this.specIm = Array.from({ length: n }, () => new Float64Array(2 * w));
    this.has = new Array(n).fill(false);
    this.re = new Float64Array(2 * w);
    this.im = new Float64Array(2 * w);
    const floorLen = Math.round(FLOOR_SEC / HOP_SEC);
    this.floors = Array.from({ length: n }, () => new Float64Array(floorLen));
    this.sorted = new Float64Array(floorLen);
    this.lagCache = new Float64Array(n * n);
    this.lagDone = new Uint8Array(n * n);
    this.out = {
      talker: -1,
      levelDb: new Float64Array(n),
      floorDb: new Float64Array(n),
      dtSec: this.hop / rate,
    };
  }

  /** Feed one block (one array per mic, raw capture). `onHop` is called for
   *  every hop that completes; the object it gets is reused. */
  push(chans: Float32Array[], frames: number, onHop: (h: ArrivalHop) => void): void {
    const n = this.n;
    for (let s = 0; s < frames; s++) {
      for (let i = 0; i < n; i++) {
        const x = chans[i][s];
        this.sumSq[i] += x * x;
        let y = x;
        const f = this.lp[i];
        for (let k = 0; k < f.length; k++) y = f[k].process(y);
        if (this.phase === 0) this.ring[i][this.ringPos] = y;
      }
      this.fullN++;
      if (++this.phase < this.step) continue;
      this.phase = 0;
      this.ringPos = (this.ringPos + 1) % this.win;
      if (++this.inHop < this.hop) continue;
      this.inHop = 0;
      this.analyse();
      onHop(this.out);
    }
  }

  private analyse(): void {
    const n = this.n;
    const o = this.out;
    const floorLen = this.floors[0].length;
    for (let i = 0; i < n; i++) {
      o.levelDb[i] = 10 * Math.log10(Math.max(this.sumSq[i] / Math.max(1, this.fullN), 1e-20));
      this.sumSq[i] = 0;
      this.floors[i][this.floorPos] = o.levelDb[i];
    }
    this.fullN = 0;
    this.floorPos = (this.floorPos + 1) % floorLen;
    if (this.floorFill < floorLen) this.floorFill++;
    for (let i = 0; i < n; i++) {
      const m = this.floorFill;
      for (let k = 0; k < m; k++) this.sorted[k] = this.floors[i][k];
      const part = this.sorted.subarray(0, m);
      part.sort();
      o.floorDb[i] = part[Math.floor(FLOOR_PERCENTILE * (m - 1))];
    }
    o.talker = this.decide();
  }

  private decide(): number {
    const n = this.n;
    const o = this.out;
    let best = -1;
    let bestSnr = -Infinity;
    let second = -Infinity;
    let candidates = 0;
    for (let i = 0; i < n; i++) {
      const snr = o.levelDb[i] - o.floorDb[i];
      if (snr >= SPEECH_SNR_DB) candidates++;
      if (snr > bestSnr) {
        second = bestSnr;
        bestSnr = snr;
        best = i;
      } else if (snr > second) second = snr;
    }
    // Too little history for a floor, or nobody talks.
    if (this.floorFill < 10 || candidates === 0) return -1;
    if (n === 1) return 0;

    // A partner counts by its level over the whole correlation window, not
    // just this hop: at a syllable's end the near mic is already quiet while
    // the far ones still carry the delayed tail, and must not win for it.
    for (let i = 0; i < n; i++) {
      this.has[i] = this.windowDb(i) - o.floorDb[i] >= PARTNER_SNR_DB;
      if (this.has[i]) this.spectrum(i);
    }
    this.lagDone.fill(0);
    let talker = -1;
    let talkerSnr = -Infinity;
    let ordered = false; // some candidate had a clear arrival order
    for (let i = 0; i < n; i++) {
      const snr = o.levelDb[i] - o.floorDb[i];
      if (snr < SPEECH_SNR_DB) continue;
      let clear = 0;
      let leads = true;
      for (let j = 0; j < n && leads; j++) {
        if (j === i || !this.has[j]) continue;
        const lag = this.lag(i, j);
        if (Number.isNaN(lag)) continue;
        clear++;
        if (lag > -this.minLead) leads = false;
      }
      if (clear > 0) ordered = true;
      if (clear > 0 && leads && snr > talkerSnr) {
        talker = i;
        talkerSnr = snr;
      }
    }
    if (talker >= 0) return talker;
    // No arrival order to go by at all (mics far apart, a single loud mic):
    // only an outright winner on SNR. Never against a clear order — at a
    // syllable's end the far mics' delayed tail is the loudest thing left.
    if (ordered) return -1;
    return bestSnr - second >= CLEAR_MARGIN_DB ? best : -1;
  }

  /** Level of mic `i` over the correlation window (analysis rate), dBFS RMS. */
  private windowDb(i: number): number {
    const ring = this.ring[i];
    let e = 0;
    for (let k = 0; k < this.win; k++) e += ring[k] * ring[k];
    return 10 * Math.log10(Math.max(e / this.win, 1e-20));
  }

  /** Windowed, zero-padded spectrum of mic `i`'s last window. */
  private spectrum(i: number): void {
    const w = this.win;
    const re = this.specRe[i];
    const im = this.specIm[i];
    const ring = this.ring[i];
    for (let k = 0; k < w; k++) re[k] = ring[(this.ringPos + k) % w] * this.hann[k];
    re.fill(0, w);
    im.fill(0);
    this.fft.transform(re, im);
  }

  /** Lag of mic i behind mic j in analysis samples (negative: i is earlier),
   *  or NaN when the correlation has no clear peak. */
  private lag(i: number, j: number): number {
    const n = this.n;
    if (this.lagDone[i * n + j]) return this.lagCache[i * n + j];
    const N = 2 * this.win;
    const re = this.re;
    const im = this.im;
    re.fill(0);
    im.fill(0);
    const ar = this.specRe[i];
    const ai = this.specIm[i];
    const br = this.specRe[j];
    const bi = this.specIm[j];
    for (let k = this.binLo; k <= this.binHi; k++) {
      // X_i · conj(X_j), phase only; the mirrored bin keeps the result real.
      const cr = ar[k] * br[k] + ai[k] * bi[k];
      const ci = ai[k] * br[k] - ar[k] * bi[k];
      const mag = Math.sqrt(cr * cr + ci * ci);
      if (mag < 1e-20) continue;
      re[k] = cr / mag;
      im[k] = ci / mag;
      if (k < N - k) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }
    this.fft.transform(re, im, true);
    let peak = -Infinity;
    let at = 0;
    let sum = 0;
    for (let l = -this.maxLag; l <= this.maxLag; l++) {
      const v = re[(l + N) % N];
      sum += Math.abs(v);
      if (v > peak) {
        peak = v;
        at = l;
      }
    }
    const mean = sum / (2 * this.maxLag + 1);
    const lag = mean > 0 && peak / mean >= this.conf ? at : NaN;
    this.lagCache[i * n + j] = lag;
    this.lagCache[j * n + i] = -lag;
    this.lagDone[i * n + j] = this.lagDone[j * n + i] = 1;
    return lag;
  }
}

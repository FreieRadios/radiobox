import { LevelerParams } from '../config/schema';
import { clamp, dbToGain, msToCoef } from './dsp-math';
import { KWeighting, powerToLufs } from './loudness';

/** Frames below this loudness are silence, not evidence (LUFS). */
const GATE_LUFS = -60;
/** Analysis frame, in ms. */
const FRAME_MS = 10;
/** Frames whose momentary loudness (400 ms) lies this far below the item's
 *  level so far don't count (LU): BS.1770's relative gate, so the quiet
 *  passages of a jingle don't make it louder. */
const REL_GATE_LU = 10;
/** Momentary window, in frames (400 ms). */
const MOMENTARY_FRAMES = 40;
/** This much silence (ms) ends an item: what comes after is a new one. */
const GAP_MS = 1500;
/** An item's loudness is measured over at most this much of its past (s). */
const PAST_SECONDS = 60;
/** Evidence needed before the gain moves (s of sound). */
const MIN_EVIDENCE_SEC = 0.05;
/** Time constant the gains glide with, in ms. */
const GLIDE_MS = 10;

/**
 * Music leveler: one gain per item, known before the item airs.
 *
 * The music reaches the programme through the look-ahead delay of the mic
 * path, so its first seconds are heard before they air. The leveler measures
 * the loudness of the **current item** — a file (the graph says when one
 * starts), or for a live input whatever follows 1.5 s of silence — from its
 * start (at most 60 s back) to as far ahead as the delay reaches, and sets
 * the gain to bring that to `targetLufs`. A jingle gets its own gain from its
 * first sample, a song a steady one that settles as it plays, like a
 * ReplayGain measured on the fly: the dynamics within a song stay.
 *
 * The room (the music return to the headphones) has no look-ahead: it gets
 * the same measurement made causally (`roomGain`).
 */
export class MusicLeveler {
  private kwL = new KWeighting();
  private kwR = new KWeighting();
  private readonly frame: number;
  private readonly delayF: number;
  private readonly smoothF: number;
  private readonly pastF: number;
  private readonly gapF: number;
  private readonly minN: number;
  private readonly ring: number;
  private cumE: Float64Array;
  private cumN: Float64Array;
  private f = 0; // completed frames
  private accE = 0;
  private accN = 0;
  private inFrame = 0;
  private silent = 0; // silent frames in a row
  private mom: Float64Array = new Float64Array(MOMENTARY_FRAMES); // frame powers
  private momSum = 0;
  private itemLufs: number | null = null; // the item's level so far (causal)
  private starts: number[] = [0]; // first frames of the items, ascending
  private pendingStart = false;
  private glide: number;
  private progWant = 0;
  private progDb = 0;
  private progLin = 1;
  private roomWant = 0;
  private roomDb = 0;
  private roomLin = 1;
  private readonly gatePower = Math.pow(10, (GATE_LUFS + 0.691) / 10);

  constructor(
    private p: LevelerParams,
    sampleRate: number,
    delaySamples = 0
  ) {
    this.frame = Math.round((FRAME_MS / 1000) * sampleRate);
    this.delayF = Math.floor(delaySamples / this.frame);
    // Aim three glide time constants ahead: the gain has arrived when the
    // sample it was measured for airs (a new item starts at its own gain).
    this.smoothF = this.delayF > 0 ? Math.round((3 * GLIDE_MS) / FRAME_MS) : 0;
    this.pastF = Math.round((PAST_SECONDS * 1000) / FRAME_MS);
    this.gapF = Math.round(GAP_MS / FRAME_MS);
    this.minN = MIN_EVIDENCE_SEC * sampleRate;
    this.ring = this.delayF + this.pastF + 4;
    this.cumE = new Float64Array(this.ring);
    this.cumN = new Float64Array(this.ring);
    this.glide = msToCoef(GLIDE_MS, sampleRate);
  }

  /** A new item (file) starts with the next sample. */
  newItem(): void {
    this.pendingStart = true;
  }

  /** Feed one room-time stereo sample. Loudness as BS.1770 measures it: the
   *  power of both channels summed (a mono mix would read 3-6 dB low,
   *  depending on how wide the stereo is). */
  process(l: number, r: number): void {
    if (!this.p.enabled) return;
    const kl = this.kwL.process(l);
    const kr = this.kwR.process(r);
    this.accE += kl * kl + kr * kr;
    if (++this.inFrame >= this.frame) this.endFrame();
    this.progDb = this.glide * (this.progDb - this.progWant) + this.progWant;
    this.roomDb = this.glide * (this.roomDb - this.roomWant) + this.roomWant;
    this.progLin = dbToGain(this.progDb);
    this.roomLin = dbToGain(this.roomDb);
  }

  private endFrame(): void {
    const f = this.f;
    const R = this.ring;
    const pw = this.accE / this.inFrame;
    const loud = pw > this.gatePower;
    if (this.pendingStart || (loud && this.silent >= this.gapF)) this.markStart(f);
    this.pendingStart = false;
    this.silent = loud ? 0 : this.silent + 1;
    const mi = f % MOMENTARY_FRAMES;
    this.momSum += pw - this.mom[mi];
    this.mom[mi] = pw;
    const counts =
      loud &&
      (this.itemLufs === null ||
        powerToLufs(this.momSum / MOMENTARY_FRAMES) >= this.itemLufs - REL_GATE_LU);
    this.cumE[(f + 1) % R] = this.cumE[f % R] + (counts ? this.accE : 0);
    this.cumN[(f + 1) % R] = this.cumN[f % R] + (counts ? this.inFrame : 0);
    this.f = f + 1;
    this.accE = 0;
    this.inFrame = 0;
    // Programme: the frame leaving the delay (plus the glide's lag), measured
    // over its item up to the look-ahead. Room: now, measured over the past.
    const c = this.f - this.delayF + this.smoothF;
    const p = this.loudness(c);
    if (p !== null) this.progWant = this.gainFor(p);
    const r = this.loudness(this.f - 1);
    this.itemLufs = r;
    if (r !== null) this.roomWant = this.gainFor(r);
  }

  private gainFor(lufs: number): number {
    return clamp(this.p.targetLufs - lufs, -this.p.rangeDb, this.p.maxGainDb);
  }

  private markStart(frame: number): void {
    const s = this.starts;
    if (s[s.length - 1] !== frame) s.push(frame);
    // Forget items that have left the ring for good.
    while (s.length > 1 && s[1] <= this.f - this.ring) s.shift();
  }

  /** The loudness of the item frame `c` belongs to, over its frames up to
   *  what has been heard, or null while it has no evidence yet. */
  private loudness(c: number): number | null {
    const s = this.starts;
    let start = 0;
    let end = this.f;
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] <= c) {
        start = s[i];
        if (i + 1 < s.length) end = Math.min(end, s[i + 1]);
        break;
      }
    }
    const a = Math.max(start, c - this.pastF, this.f - this.ring + 1, 0);
    const b = end;
    if (b <= a) return null;
    const R = this.ring;
    const n = this.cumN[b % R] - this.cumN[a % R];
    if (n < this.minN) return null;
    const lufs = powerToLufs((this.cumE[b % R] - this.cumE[a % R]) / n);
    return Number.isFinite(lufs) ? lufs : null;
  }

  /** Linear gain for the programme sample leaving the delay now. */
  get programmeGain(): number {
    return this.progLin;
  }

  /** Linear gain for the room (no look-ahead). */
  get roomGain(): number {
    return this.roomLin;
  }

  /** Programme gain in dB. */
  get gainDbValue(): number {
    return this.progDb;
  }
}

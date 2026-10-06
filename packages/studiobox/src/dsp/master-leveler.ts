import { clamp, dbToGain, msToCoef } from './dsp-math';

/** Momentary loudness below which a frame never counts (LUFS). */
const ABS_GATE_LUFS = -50;
/** Frames this far below the running estimate don't count either (LU): the
 *  pause between two sentences is not the talk getting quieter. */
const REL_GATE_LU = 15;
/** Time constant of the estimate, in seconds of talk. */
const TALK_SECONDS = 10;
/** Time constant the applied gain glides with, in ms. */
const GLIDE_MS = 3000;

/**
 * Master leveler keyed on talk.
 *
 * The mic levelers already put every talker at their target; what is left
 * for the master is a slow trim of the whole programme so that **talk** airs
 * at `targetLufs`. So the estimate only learns while talk is on air (the duck
 * planner says when, in programme time), from the momentary loudness of the
 * mix — with a ten-second memory of talk, gated against pauses — and the gain
 * holds everywhere else: music, jingles and silence pass at the gain the talk
 * set. The balance between music and talk is the music leveler's target, not
 * something the master rides back and forth at every change.
 *
 * It starts from `seedLufs`, the loudness the talk is expected at (the mic
 * levelers' target), so the first sentence is already at the right level.
 * That starting gain (`baseGain`) is the programme's; what the leveler learns
 * on top of it is a correction of the talk and belongs to the mics alone
 * (`next()`): the talk measured on air includes the pauses between words
 * and whatever automix and priority take away, the music does neither, and
 * its balance against the talk stays the music leveler's target.
 */
export class MasterLeveler {
  private estPow: number;
  private estW = 1;
  private wantDb: number;
  private gainDb: number;
  private gain: number;
  private glide: number;
  /** The starting gain, linear: what the whole programme gets. */
  readonly baseGain: number;

  constructor(
    private targetLufs: number,
    seedLufs: number,
    sampleRate: number,
    private rangeDb = 12
  ) {
    this.estPow = Math.pow(10, (seedLufs + 0.691) / 10);
    this.wantDb = clamp(targetLufs - seedLufs, -rangeDb, rangeDb);
    this.gainDb = this.wantDb;
    this.gain = dbToGain(this.gainDb);
    this.baseGain = this.gain;
    this.glide = msToCoef(GLIDE_MS, sampleRate);
  }

  /** One 10 ms frame: `talk` = talk is on air in it, `momentaryLufs` = the
   *  momentary loudness of the mix before this leveler. */
  frame(talk: boolean, momentaryLufs: number): void {
    if (!talk || !(momentaryLufs > ABS_GATE_LUFS)) return;
    if (momentaryLufs < this.estimateLufs - REL_GATE_LU) return;
    const a = 1 - Math.exp(-0.01 / TALK_SECONDS);
    this.estPow += a * (Math.pow(10, (momentaryLufs + 0.691) / 10) - this.estPow);
    this.estW += a * (1 - this.estW);
    this.wantDb = clamp(this.targetLufs - this.estimateLufs, -this.rangeDb, this.rangeDb);
  }

  /** Advance one sample; returns the linear gain for the talk (the mic bus). */
  next(): number {
    const d = this.gainDb - this.wantDb;
    if (d > 1e-4 || d < -1e-4) {
      this.gainDb = this.glide * d + this.wantDb;
      this.gain = dbToGain(this.gainDb);
    }
    return this.gain;
  }

  /** The talk loudness the leveler has learned (LUFS, before its gain). */
  get estimateLufs(): number {
    return -0.691 + 10 * Math.log10(this.estPow / this.estW);
  }

  /** Gain applied now, dB. */
  get gainDbValue(): number {
    return this.gainDb;
  }
}

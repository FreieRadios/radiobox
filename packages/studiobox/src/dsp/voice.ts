/** Analysis frame of the voice detector and the duck planner, in ms. */
export const FRAME_MS = 10;

/** A frame counts as voiced only this far above the mic's noise floor (dB) … */
const SNR_DB = 12;
/** … and no further than this below the mic's learned speech level (dB): a
 *  child murmuring next to the mic is not the child talking into it. */
const BELOW_SPEECH_DB = 18;
/** Never voiced below this absolute level (dBFS RMS of a 10 ms frame, after
 *  the trim). Talk into a mic sits far above it (the setup assistant trims
 *  speech to -20; untrimmed children far from the mic were at -45 ± 10);
 *  breathing, handling noise and chair creaks next to a quiet mic sit below. */
const ABS_FLOOR_DB = -60;
/** A stretch of talk has syllables at least this loud (dBFS RMS) … */
const STRONG_DB = -50;
/** … or this close to the mic's learned speech level (dB), whichever is
 *  lower. A whisper or a breath stays below both. */
const STRONG_BELOW_SPEECH_DB = 10;
/** Before the floor is known it is assumed to be this (dBFS RMS). */
const START_FLOOR_DB = -70;
/** The noise floor is the minimum frame level over this many seconds. A
 *  10 ms frame is steady enough on noise and short enough to fit into the
 *  gaps between syllables. */
const FLOOR_SECONDS = 8;
/** Time constant of the learned speech level, in seconds of talking. */
const SPEECH_SECONDS = 10;
/** Talking needed before the learned speech level is used, in seconds. */
const SPEECH_MIN_SECONDS = 2;

/**
 * Per-mic voice activity on 10 ms frames.
 *
 * Tracks the mic's noise floor (minimum statistics over the last few
 * seconds) and the level at which its talker usually speaks (learned only
 * while this mic is the talker). A frame is **voiced** when it stands clear
 * of the noise and is not far below that speech level, so a rustle, a
 * cough's tail or a whisper next to the mic is not mistaken for talk.
 *
 * Fed with the mic signal after trim and HPF, before the gate (room time).
 */
export class VoiceDetector {
  readonly frame: number;
  private acc = 0;
  private n = 0;
  private subMins: Float32Array;
  private subIdx = 0;
  private subFrames = 0;
  private readonly subLen: number;
  private filled = 0; // sub-windows filled so far
  private floor = START_FLOOR_DB;
  private speechPow = 0;
  private speechW = 0; // talking seen, in seconds (saturating)
  private seededSpeech: number | null = null;
  private lastDb = -Infinity;
  private on = false;
  private loud = false;

  constructor(sampleRate: number) {
    this.frame = Math.round((FRAME_MS / 1000) * sampleRate);
    // Eight sub-windows of one second each: the floor is their minimum.
    this.subLen = Math.round(1000 / FRAME_MS);
    this.subMins = new Float32Array(FLOOR_SECONDS).fill(Infinity);
  }

  /**
   * Feed one sample. `talker` says whether this mic is the active talker now
   * (only then does a voiced frame teach the speech level). Returns true when
   * the sample completed a frame; `voiced` then holds that frame's decision.
   */
  process(x: number, talker: boolean): boolean {
    this.acc += x * x;
    if (++this.n < this.frame) return false;
    const p = this.acc / this.n;
    this.acc = 0;
    this.n = 0;
    this.endFrame(p, talker);
    return true;
  }

  private endFrame(p: number, talker: boolean): void {
    const db = 10 * Math.log10(p + 1e-20);
    this.lastDb = db;

    // Noise floor: minimum frame level over the last seconds.
    if (db < this.subMins[this.subIdx]) this.subMins[this.subIdx] = db;
    if (++this.subFrames >= this.subLen) {
      this.subFrames = 0;
      this.subIdx = (this.subIdx + 1) % this.subMins.length;
      this.subMins[this.subIdx] = Infinity;
      if (this.filled < this.subMins.length) this.filled++;
    }
    let min = Infinity;
    for (let i = 0; i < this.subMins.length; i++) if (this.subMins[i] < min) min = this.subMins[i];
    // For the first two seconds a floor above the assumed start value isn't
    // trusted (they may be all talk); after that every phrase has had a pause.
    this.floor = this.filled < 2 ? Math.min(min, START_FLOOR_DB) : min;

    const speech = this.speechDb;
    this.on =
      db > ABS_FLOOR_DB &&
      db > this.floor + SNR_DB &&
      (speech === null || db > speech - BELOW_SPEECH_DB);

    this.loud =
      this.on &&
      db > (speech === null ? STRONG_DB : Math.min(STRONG_DB, speech - STRONG_BELOW_SPEECH_DB));

    if (this.on && talker) {
      const dt = FRAME_MS / 1000;
      const a = 1 - Math.exp(-dt / SPEECH_SECONDS);
      this.speechPow += a * (p - this.speechPow);
      this.speechW = Math.min(SPEECH_SECONDS * 10, this.speechW + dt);
    }
  }

  /** The last frame was voiced. */
  get voiced(): boolean {
    return this.on;
  }

  /** The last frame was voiced and as loud as a syllable of talk. */
  get strong(): boolean {
    return this.loud;
  }

  /** Noise floor (dBFS RMS of a 10 ms frame). */
  get floorDb(): number {
    return this.floor;
  }

  /** Level of the last frame (dBFS RMS). */
  get levelDb(): number {
    return this.lastDb;
  }

  /** The learned speech level (dBFS RMS), or the seeded one, or null while
   *  this mic hasn't talked long enough to know. */
  get speechDb(): number | null {
    if (this.speechW >= SPEECH_MIN_SECONDS) {
      // Bias-correct the exponential average for the evidence seen so far.
      const w = 1 - Math.exp(-this.speechW / SPEECH_SECONDS);
      return 10 * Math.log10(this.speechPow / w + 1e-20);
    }
    return this.seededSpeech;
  }

  /** Start from a known speech level (e.g. the setup assistant's), used until
   *  the mic has talked long enough to learn its own. */
  seedSpeech(db: number | null): void {
    this.seededSpeech = db;
  }
}

/** Config of the duck planner (a subset of DuckConfig). */
export interface DuckPlan {
  /** Talk has to go on this long (ms) before it ducks anything. */
  minSpeechMs: number;
  /** A stretch needs this much (ms) of talk-level frames in it (`strong`). */
  minStrongMs: number;
  /** Gaps up to this long (ms) don't break a stretch of talk. */
  gapMs: number;
  /** The music starts going down this long (ms) before the talk. */
  leadMs: number;
  /** … and stays down this long (ms) after it. */
  holdMs: number;
}

/**
 * Decides **when** the programme music ducks, from the voiced frames of all
 * mics, with the look-ahead the mic path runs behind the room.
 *
 * Only a stretch of talk of at least `minSpeechMs` with some talk-level
 * syllables in it counts — a bump, a click, a breath or a whisper does not. Once a stretch qualifies it is marked from its
 * very first frame, so the duck still lands `leadMs` before the first word:
 * the decision is made in room time and acted on `delayFrames` later, when
 * that word reaches the programme.
 */
export class DuckPlanner {
  private flags: Uint8Array;
  private f = 0; // frames pushed so far
  private runStart: Int32Array;
  private lastOn: Int32Array;
  private marked: Int32Array; // per mic: frames before this are marked already
  private strongN: Int32Array; // per mic: strong frames in the current stretch
  private readonly minF: number;
  private readonly strongF: number;
  private readonly gapF: number;
  private readonly leadF: number;
  private readonly holdF: number;
  private on = false;
  private talk = false;

  constructor(
    p: DuckPlan,
    mics: number,
    private readonly delayFrames: number
  ) {
    const fr = (ms: number) => Math.max(0, Math.round(ms / FRAME_MS));
    this.minF = Math.max(1, fr(p.minSpeechMs));
    this.strongF = fr(p.minStrongMs);
    this.gapF = fr(p.gapMs);
    this.leadF = fr(p.leadMs);
    this.holdF = fr(p.holdMs);
    this.flags = new Uint8Array(delayFrames + this.holdF + this.leadF + 8);
    this.runStart = new Int32Array(mics).fill(-1);
    this.lastOn = new Int32Array(mics).fill(-1_000_000);
    this.marked = new Int32Array(mics);
    this.strongN = new Int32Array(mics);
  }

  /** Push one room-time frame: `voiced[i]` and `strong[i]` per mic (strong
   *  defaults to voiced). Afterwards `ducking` says whether the programme
   *  frame leaving the look-ahead now (the room frame `delayFrames` ago) is
   *  ducked. */
  push(voiced: ArrayLike<boolean>, strong: ArrayLike<boolean> = voiced): void {
    const f = this.f;
    const len = this.flags.length;
    this.flags[f % len] = 0;
    for (let i = 0; i < voiced.length; i++) {
      if (!voiced[i]) continue;
      if (f - this.lastOn[i] > this.gapF + 1) {
        this.runStart[i] = f;
        this.strongN[i] = 0;
      }
      this.lastOn[i] = f;
      if (strong[i]) this.strongN[i]++;
      if (f - this.runStart[i] + 1 >= this.minF && this.strongN[i] >= this.strongF) {
        // A real stretch of talk: mark it back to its first frame.
        const from = Math.max(this.runStart[i], this.marked[i], f - len + 1);
        for (let k = from; k <= f; k++) this.flags[k % len] = 1;
        this.marked[i] = f + 1;
      }
    }
    this.f = f + 1;

    // The programme frame now: duck if talk lies within [g - hold, g + lead].
    const g = f - this.delayFrames;
    const lo = Math.max(0, g - this.holdF, f - len + 1);
    const hi = Math.min(f, g + this.leadF);
    let on = false;
    for (let k = lo; k <= hi; k++) {
      if (this.flags[k % len]) {
        on = true;
        break;
      }
    }
    this.on = on;
    this.talk = g >= 0 && g > f - len && this.flags[g % len] === 1;
  }

  get ducking(): boolean {
    return this.on;
  }

  /** The programme frame leaving the look-ahead now is confirmed talk
   *  (without the lead and hold of `ducking`). */
  get talking(): boolean {
    return this.talk;
  }
}

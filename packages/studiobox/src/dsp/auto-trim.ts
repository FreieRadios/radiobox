import { AutoTrimConfig } from '../config/schema';

/**
 * "Auto-Pegel": one mic's input trim, found during the show instead of in a
 * setup run before it. Shows start on time and nobody is free to turn the
 * desk's gain knobs while people talk; the digital trim has the range
 * (24-bit capture: on 2026-10-07 the preamp floor sat ~20 dB under the room
 * noise even at the lowest knob setting, and +28 dB of trim stayed clean).
 *
 * It learns the speech level of the person at this mic — measured exactly as
 * the setup assistant does: raw RMS (before trim and filters) of the frames
 * in which this mic's own talker speaks, at least 12 dB over the floor — and
 * moves the trim so that speech sits at `targetDb`. Which frames are this
 * mic's talker comes from arrival time (`arrival.ts`), not from levels, so a
 * wrong trim cannot mislead its own correction.
 *
 * The speech level is the power mean of this mic's last 10 s of talk (a
 * sliding window of its talker frames, so it lets go of a loud past as fast
 * as of a quiet one). A gain-knob turn shows as the last 2 s standing more
 * than 6 dB off that mean for a second of talk: the window then keeps only
 * those 2 s. The trim glides at `rateDbPerSec`, three times that for a new
 * voice, after a knob turn and while it is more than 6 dB off, ignores
 * differences under half a dB, and moves only while the voice is talking
 * (1.5 s of it within the last 10 s).
 */

/** Talk the speech level is averaged over (s). */
const WINDOW_SEC = 10;
/** Recent talk compared against it to notice a knob turn (s). */
const RECENT_SEC = 2;
/** Talk needed before the trim moves at all. */
const MIN_TALK_SEC = 1.5;
/** Talk during which the trim may move faster (a new voice, a knob turn). */
const FAST_TALK_SEC = 6;
const FAST_FACTOR = 3;
const JUMP_DB = 6;
const JUMP_SEC = 1;
const DEADBAND_DB = 0.5;
/** The trim moves only with `MIN_TALK_SEC` of talk within this much time (s). */
const RECENT_WALL_SEC = 10;
/** Talker frames kept (hops of 40 ms; more than the window needs at any hop). */
const RING = 1024;

const toDb = (p: number): number => 10 * Math.log10(Math.max(p, 1e-20));

export class AutoTrim {
  /** False: the trim is the technician's (a hand trim switched this off). */
  on = true;
  private trim: number;
  // Talker frames, newest last: power and duration.
  private readonly pow = new Float64Array(RING);
  private readonly dur = new Float64Array(RING);
  private readonly when = new Float64Array(RING); // clock at the frame (s)
  private clock = 0; // seconds of hops seen, talk or not
  private head = 0; // next write
  private count = 0;
  private talkSec = 0;
  private disagreeSec = 0;
  private level: number | null = null; // power mean over the window
  /** Talk time up to which the trim may glide fast (a new voice, a knob turn). */
  private fastUntil = FAST_TALK_SEC;

  constructor(
    private readonly cfg: AutoTrimConfig,
    startTrimDb: number
  ) {
    this.trim = this.clamp(startTrimDb);
  }

  private clamp(db: number): number {
    return Math.min(this.cfg.maxDb, Math.max(this.cfg.minDb, db));
  }

  /** The trim in force (dB). */
  get trimDb(): number {
    return this.trim;
  }

  /** The speech level learned so far (raw dBFS RMS), or null. */
  get speechDb(): number | null {
    return this.level === null ? null : toDb(this.level);
  }

  /** Seconds of this mic's speech heard. */
  get talkSeconds(): number {
    return this.talkSec;
  }

  /** Power mean of the newest frames covering `sec` of talk (null: none). */
  private mean(sec: number): number | null {
    let p = 0;
    let t = 0;
    for (let k = 1; k <= this.count && t < sec; k++) {
      const i = (this.head - k + RING) % RING;
      p += this.pow[i] * this.dur[i];
      t += this.dur[i];
    }
    return t > 0 ? p / t : null;
  }

  /** Talk heard within the last `sec` seconds of clock. */
  private recentTalk(sec: number): number {
    let t = 0;
    for (let k = 1; k <= this.count; k++) {
      const i = (this.head - k + RING) % RING;
      if (this.when[i] < this.clock - sec) break;
      t += this.dur[i];
    }
    return t;
  }

  private push(p: number, sec: number): void {
    this.pow[this.head] = p;
    this.dur[this.head] = sec;
    this.when[this.head] = this.clock;
    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
  }

  /** Start from a trim someone set (setup assistant, restored state): the
   *  learned speech level becomes what that trim implies, worth `sec`
   *  seconds of talk. 0 = only the starting point, the next voice decides. */
  seed(trimDb: number, sec = 0): void {
    this.trim = this.clamp(trimDb);
    this.count = 0;
    this.head = 0;
    this.disagreeSec = 0;
    this.talkSec = Math.max(0, sec);
    if (sec > 0)
      this.push(Math.pow(10, (this.cfg.targetDb - trimDb) / 10), Math.min(sec, WINDOW_SEC));
    this.level = this.mean(WINDOW_SEC);
    this.fastUntil = sec > 0 ? 0 : FAST_TALK_SEC;
  }

  /**
   * One analysis hop. `levelDb`: the mic's raw level; `talker`: this mic's
   * talker speaks in this hop (and stands clear of the floor). Returns the
   * trim to apply now (dB).
   */
  update(levelDb: number, talker: boolean, dtSec: number): number {
    this.clock += dtSec;
    if (talker && Number.isFinite(levelDb)) {
      this.push(Math.pow(10, levelDb / 10), dtSec);
      this.talkSec += dtSec;
      const all = this.mean(WINDOW_SEC)!;
      const recent = this.mean(RECENT_SEC)!;
      if (this.talkSec >= RECENT_SEC && Math.abs(toDb(recent) - toDb(all)) > JUMP_DB) {
        this.disagreeSec += dtSec;
        if (this.disagreeSec >= JUMP_SEC) {
          // A knob turn: forget what came before the last 2 s.
          let t = 0;
          let k = 0;
          while (k < this.count && t < RECENT_SEC) {
            t += this.dur[(this.head - 1 - k + RING) % RING];
            k++;
          }
          this.count = k;
          this.disagreeSec = 0;
          this.fastUntil = this.talkSec + FAST_TALK_SEC;
        }
      } else {
        this.disagreeSec = 0;
      }
      this.level = this.mean(WINDOW_SEC);
    }
    if (!this.on || this.talkSec < MIN_TALK_SEC || this.level === null) return this.trim;
    // Only on a voice that is talking now: a few stray frames over minutes
    // (bleed taken for this mic's talker) must not move the trim.
    if (this.recentTalk(RECENT_WALL_SEC) < MIN_TALK_SEC) return this.trim;
    const want = this.clamp(this.cfg.targetDb - toDb(this.level));
    const d = want - this.trim;
    if (Math.abs(d) < DEADBAND_DB) return this.trim;
    // Fast while a voice is new or after a knob turn, and whenever the trim
    // is far off; slow for the small corrections of a running show.
    const fast = this.talkSec < this.fastUntil || Math.abs(d) > JUMP_DB;
    const rate = this.cfg.rateDbPerSec * (fast ? FAST_FACTOR : 1);
    const step = rate * dtSec;
    this.trim = Math.abs(d) <= step ? want : this.trim + Math.sign(d) * step;
    return this.trim;
  }
}

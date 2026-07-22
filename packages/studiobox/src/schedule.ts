import { AutoPlayConfig } from './config/schema';
import { Log } from './util/log';

/**
 * Scheduled auto-play by filename timestamp — a TypeScript port of the
 * liquidsoap `play_by_filename.liq` repeat scheduling.
 *
 * Filenames carrying a `YYYYMMDD-HHMMSS` timestamp anywhere in the name are
 * played automatically when that local wallclock time arrives. Differences
 * from the liquidsoap original, on purpose:
 *
 *  - No prefetch queue: the liquidsoap version pushed requests into a
 *    buffered queue ahead of time because remote resolution/decoding takes a
 *    while. Here the files are local and ffmpeg decode starts instantly, so
 *    we simply start playback at the target time.
 *  - Full-date parsing: liquidsoap 2.2.5 lacked a usable mktime, so the
 *    original reconstructed the epoch from seconds-of-day deltas and only
 *    honoured today/tomorrow. We build the Date directly from the filename's
 *    full date, which yields the same behaviour (past dates never fire, the
 *    near-midnight tomorrow case works naturally).
 *  - Preemption is implicit: firing an entry calls `onPlay`, and
 *    `FilePlayer.play()` replaces whatever is currently playing — the same
 *    outcome as the original's `q_prefetch.skip()` overrun handling.
 */

/** One auto-playable file: where it lives and when it should start. */
export interface ScheduleEntry {
  /** Index into the configured file-player folders. */
  folder: number;
  /** Bare filename inside that folder. */
  name: string;
  /** Epoch milliseconds of the moment the file should start playing. */
  playAtMs: number;
}

const TIMESTAMP_RE = /(\d{8})-(\d{6})/;

/**
 * Parse a `YYYYMMDD-HHMMSS` timestamp out of `name` into epoch milliseconds
 * (local time), or null when the name carries no (valid) timestamp. Bogus
 * component values (month 13, minute 61, Feb 30, …) are rejected by
 * round-tripping the constructed Date back to its components.
 */
export function parsePlayAtMs(name: string): number | null {
  const m = TIMESTAMP_RE.exec(name);
  if (!m) return null;
  const [date, time] = [m[1], m[2]];
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(2, 4));
  const second = Number(time.slice(4, 6));
  const d = new Date(year, month - 1, day, hour, minute, second);
  // Date() silently rolls over out-of-range components (Feb 30 -> Mar 2);
  // treat any rollover as "not a timestamp".
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute ||
    d.getSeconds() !== second
  ) {
    return null;
  }
  return d.getTime();
}

/** How long a fired entry is remembered (prevents a re-trigger while the same
 *  file/target is still inside the grace window). One day is plenty: after
 *  that the grace window has long closed on its own. */
const FIRED_RETENTION_MS = 24 * 3600 * 1000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** key -> epoch ms the entry fired; pruned by retention. */
  private fired = new Map<string, number>();

  constructor(
    private opts: AutoPlayConfig,
    /** Lists every timestamped file across the configured folders. */
    private list: () => ScheduleEntry[],
    /** Starts playback of a due entry (replaces current playback). */
    private onPlay: (entry: ScheduleEntry) => void,
    private log: Log
  ) {}

  private key(e: ScheduleEntry): string {
    return `${e.folder}:${e.name}:${e.playAtMs}`;
  }

  /** Begin periodic scanning. An immediate first tick catches entries already
   *  inside the grace window at startup. */
  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.scanSeconds * 1000);
    // Don't let the scan timer keep the process alive on its own.
    this.timer.unref?.();
    this.log.info(
      `auto-play armed: scan every ${this.opts.scanSeconds}s, grace ${this.opts.graceSeconds}s`
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan pass. Exposed (with an injectable clock) for tests. */
  tick(nowMs: number = Date.now()): void {
    for (const [k, at] of this.fired) {
      if (nowMs - at > FIRED_RETENTION_MS) this.fired.delete(k);
    }

    const graceMs = this.opts.graceSeconds * 1000;
    const due = this.list()
      .filter((e) => {
        const age = nowMs - e.playAtMs;
        return age >= 0 && age <= graceMs && !this.fired.has(this.key(e));
      })
      .sort((a, b) => a.playAtMs - b.playAtMs);
    if (!due.length) return;

    // Everything due is consumed; only the *latest* target actually plays.
    // With several targets inside one window (e.g. a late daemon start) the
    // earlier ones are already superseded — this matches the liquidsoap
    // preemption outcome (skip the overrun track, honour the schedule).
    for (const e of due) this.fired.set(this.key(e), nowMs);
    const play = due[due.length - 1];
    for (const skipped of due.slice(0, -1)) {
      this.log.info(`auto-play: skipping superseded ${skipped.name}`);
    }
    this.log.info(
      `auto-play: starting ${play.name} (target ${new Date(play.playAtMs).toISOString()})`
    );
    this.onPlay(play);
  }

  /** Entries whose target is still in the future, soonest first. */
  upcoming(nowMs: number = Date.now()): ScheduleEntry[] {
    return this.list()
      .filter((e) => e.playAtMs > nowMs)
      .sort((a, b) => a.playAtMs - b.playAtMs);
  }

  /** The next future entry, or null. */
  next(nowMs: number = Date.now()): ScheduleEntry | null {
    return this.upcoming(nowMs)[0] ?? null;
  }
}

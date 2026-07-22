import { Scheduler, ScheduleEntry, parsePlayAtMs } from '../src/schedule';
import { Log } from '../src/util/log';

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

const opts = { enabled: true, scanSeconds: 10, graceSeconds: 30 };

const entry = (name: string, playAtMs: number, folder = 0): ScheduleEntry => ({
  folder,
  name,
  playAtMs,
});

describe('parsePlayAtMs', () => {
  it('parses a YYYYMMDD-HHMMSS timestamp as local time', () => {
    const ms = parsePlayAtMs('radioz-stream-20260722-143000.flac');
    expect(ms).toBe(new Date(2026, 6, 22, 14, 30, 0).getTime());
  });

  it('finds the timestamp anywhere in the name', () => {
    expect(parsePlayAtMs('a_20260101-000000_b.mp3')).toBe(new Date(2026, 0, 1).getTime());
  });

  it('returns null without a timestamp', () => {
    expect(parsePlayAtMs('jingle.mp3')).toBeNull();
    expect(parsePlayAtMs('20260722.flac')).toBeNull();
  });

  it('rejects rolled-over component values', () => {
    expect(parsePlayAtMs('x-20260230-120000.flac')).toBeNull(); // Feb 30
    expect(parsePlayAtMs('x-20261301-120000.flac')).toBeNull(); // month 13
    expect(parsePlayAtMs('x-20260722-256100.flac')).toBeNull(); // hour 25 / min 61
  });
});

describe('Scheduler', () => {
  it('fires an entry once its target time arrives, exactly once', () => {
    const t0 = new Date(2026, 6, 22, 12, 0, 0).getTime();
    const files = [entry('a-20260722-120010.flac', t0 + 10_000)];
    const played: string[] = [];
    const s = new Scheduler(
      opts,
      () => files,
      (e) => played.push(e.name),
      silentLog
    );

    s.tick(t0); // before target
    expect(played).toEqual([]);
    s.tick(t0 + 10_000); // at target
    expect(played).toEqual(['a-20260722-120010.flac']);
    s.tick(t0 + 20_000); // still inside grace — must not re-fire
    expect(played).toEqual(['a-20260722-120010.flac']);
  });

  it('never fires entries older than the grace window', () => {
    const t0 = Date.now();
    const files = [entry('old.flac', t0 - 31_000)]; // grace is 30 s
    const played: string[] = [];
    const s = new Scheduler(
      opts,
      () => files,
      (e) => played.push(e.name),
      silentLog
    );
    s.tick(t0);
    expect(played).toEqual([]);
  });

  it('plays only the latest of several targets due in the same window', () => {
    // e.g. a late daemon start: two files became due while we were down.
    const t0 = Date.now();
    const files = [entry('early.flac', t0 - 20_000), entry('late.flac', t0 - 5_000)];
    const played: string[] = [];
    const s = new Scheduler(
      opts,
      () => files,
      (e) => played.push(e.name),
      silentLog
    );
    s.tick(t0);
    expect(played).toEqual(['late.flac']); // earlier target superseded
    s.tick(t0 + 1_000); // superseded entry stays consumed
    expect(played).toEqual(['late.flac']);
  });

  it('fires a later target even while an earlier file would still be playing (preemption)', () => {
    const t0 = Date.now();
    const files = [entry('first.flac', t0), entry('second.flac', t0 + 60_000)];
    const played: string[] = [];
    const s = new Scheduler(
      opts,
      () => files,
      (e) => played.push(e.name),
      silentLog
    );
    s.tick(t0);
    s.tick(t0 + 60_000); // second target arrives mid-playback of first
    expect(played).toEqual(['first.flac', 'second.flac']);
  });

  it('fires a file that appears late but inside the grace window (late drop)', () => {
    const t0 = Date.now();
    const files: ScheduleEntry[] = [];
    const played: string[] = [];
    const s = new Scheduler(
      opts,
      () => files,
      (e) => played.push(e.name),
      silentLog
    );
    s.tick(t0);
    files.push(entry('dropped.flac', t0 + 5_000)); // synced in after the scan
    s.tick(t0 + 15_000); // 10 s late, grace 30 s
    expect(played).toEqual(['dropped.flac']);
  });

  it('reports upcoming entries soonest-first via next()/upcoming()', () => {
    const t0 = Date.now();
    const files = [
      entry('b.flac', t0 + 7200_000),
      entry('a.flac', t0 + 3600_000),
      entry('past.flac', t0 - 3600_000),
    ];
    const s = new Scheduler(
      opts,
      () => files,
      () => {},
      silentLog
    );
    expect(s.upcoming(t0).map((e) => e.name)).toEqual(['a.flac', 'b.flac']);
    expect(s.next(t0)?.name).toBe('a.flac');
    expect(s.next(t0 + 8000_000)).toBeNull();
  });
});

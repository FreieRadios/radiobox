import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileDirs, PRUNE_CONCURRENCY } from '../../src/audio/file-dirs';
import { Log } from '../../src/util/log';

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

/** Build a temp tree:
 *  root/
 *    a-20260722-130000.flac
 *    plain.flac
 *    notes.txt            (not audio)
 *    .hidden/             (dot-dir, skipped)
 *    Musik/
 *      song.mp3
 *      Sub/
 *        b-20260723-094200.flac
 */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdirs-'));
  fs.writeFileSync(path.join(root, 'a-20260722-130000.flac'), '');
  fs.writeFileSync(path.join(root, 'plain.flac'), '');
  fs.writeFileSync(path.join(root, 'notes.txt'), '');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.mkdirSync(path.join(root, 'Musik', 'Sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Musik', 'song.mp3'), '');
  fs.writeFileSync(path.join(root, 'Musik', 'Sub', 'b-20260723-094200.flac'), '');
  return root;
}

describe('FileDirs', () => {
  const root = makeTree();
  const dirs = new FileDirs([{ path: root, label: 'Repeat', hasScheduled: true }], silentLog);

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists subdirectory rows first, then audio files; hides dotfiles and non-audio', () => {
    expect(dirs.entries(0)).toEqual([
      { name: 'Musik', playAtMs: null, dir: true },
      { name: 'a-20260722-130000.flac', playAtMs: new Date(2026, 6, 22, 13, 0, 0).getTime() },
      { name: 'plain.flac', playAtMs: null },
    ]);
  });

  it('lists a subdirectory via the sub path', () => {
    expect(dirs.entries(0, 'Musik')).toEqual([
      { name: 'Sub', playAtMs: null, dir: true },
      { name: 'song.mp3', playAtMs: null },
    ]);
  });

  it('rejects traversal in the sub path', () => {
    expect(dirs.entries(0, '../..')).toEqual([]);
    expect(dirs.entries(0, '/etc')).toEqual([]);
  });

  it('finds timestamped files recursively, named by their relative path', () => {
    const sched = dirs.scheduled().sort((a, b) => a.playAtMs - b.playAtMs);
    expect(sched).toEqual([
      {
        folder: 0,
        name: 'a-20260722-130000.flac',
        playAtMs: new Date(2026, 6, 22, 13, 0, 0).getTime(),
      },
      {
        folder: 0,
        name: 'Musik/Sub/b-20260723-094200.flac',
        playAtMs: new Date(2026, 6, 23, 9, 42, 0).getTime(),
      },
    ]);
  });

  it('never scans dirs without hasScheduled for auto-play files', () => {
    const unflagged = new FileDirs(
      [{ path: root, label: 'Musik', hasScheduled: false }],
      silentLog
    );
    expect(unflagged.scheduled()).toEqual([]);
    // Browsing and playback stay available regardless.
    expect(unflagged.entries(0).length).toBeGreaterThan(0);
  });

  it('resolves relative-path names from scheduled()/subdir listings', () => {
    expect(dirs.resolve(0, 'Musik/Sub/b-20260723-094200.flac')).toBe(
      path.join(root, 'Musik', 'Sub', 'b-20260723-094200.flac')
    );
    expect(dirs.resolve(0, '../outside.flac')).toBeNull();
  });

  it('locate() reverses resolve(), so the UI can jump to a playing file', () => {
    const abs = path.join(root, 'Musik', 'Sub', 'b-20260723-094200.flac');
    expect(dirs.locate(abs)).toEqual({ folder: 0, name: 'Musik/Sub/b-20260723-094200.flac' });
    expect(dirs.locate(path.join(root, 'plain.flac'))).toEqual({ folder: 0, name: 'plain.flac' });
    // Repeated calls (the snapshot asks many times a second) stay correct.
    expect(dirs.locate(abs)).toEqual({ folder: 0, name: 'Musik/Sub/b-20260723-094200.flac' });
    // Outside every configured folder, and the folder root itself: no location.
    expect(dirs.locate(path.join(os.tmpdir(), 'elsewhere.flac'))).toBeNull();
    expect(dirs.locate(root)).toBeNull();
  });

  it('list() matches entries() when every subfolder holds audio', async () => {
    // Musik has audio directly, so it is kept — same rows as entries().
    expect(await dirs.list(0)).toEqual(dirs.entries(0));
  });
});

describe('FileDirs.list empty-folder pruning', () => {
  /** root/
   *    keep.mp3                 (direct audio)
   *    Empty/                   (no audio anywhere -> hidden)
   *      docs/report.txt
   *    DeepMusic/               (audio buried a few levels down -> kept)
   *      a/b/track.flac
   *    TooDeep/                 (audio below PRUNE_DEPTH=4 -> hidden)
   *      l1/l2/l3/l4/l5/deep.mp3
   */
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbprune-'));
    fs.writeFileSync(path.join(root, 'keep.mp3'), '');
    fs.mkdirSync(path.join(root, 'Empty', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Empty', 'docs', 'report.txt'), '');
    fs.mkdirSync(path.join(root, 'DeepMusic', 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'DeepMusic', 'a', 'b', 'track.flac'), '');
    fs.mkdirSync(path.join(root, 'TooDeep', 'l1', 'l2', 'l3', 'l4', 'l5'), { recursive: true });
    fs.writeFileSync(path.join(root, 'TooDeep', 'l1', 'l2', 'l3', 'l4', 'l5', 'deep.mp3'), '');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('hides folders with no audio within the depth cap; keeps the rest', async () => {
    const pruned = new FileDirs([{ path: root, label: 'M', hasScheduled: false }], silentLog);
    const rows = await pruned.list(0);
    expect(rows).toEqual([
      { name: 'DeepMusic', playAtMs: null, dir: true },
      { name: 'keep.mp3', playAtMs: null },
    ]);
  });

  it('lists every subfolder unconditionally when hideEmpty is false', async () => {
    const unpruned = new FileDirs(
      [{ path: root, label: 'M', hasScheduled: false, hideEmpty: false }],
      silentLog
    );
    const names = (await unpruned.list(0)).filter((r) => r.dir).map((r) => r.name);
    expect(names.sort()).toEqual(['DeepMusic', 'Empty', 'TooDeep']);
  });
});

describe('FileDirs.list probe is bounded', () => {
  // A wide, audio-free tree: 8 folders x 6 subfolders forces the probe to walk
  // ~57 dirs, enough to overrun the concurrency cap if it were unbounded.
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcap-'));
    for (let a = 0; a < 8; a++)
      for (let b = 0; b < 6; b++)
        fs.mkdirSync(path.join(root, 'd' + a, 's' + b), { recursive: true });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('never runs more than PRUNE_CONCURRENCY readdirs at once', async () => {
    const real = fs.promises.readdir;
    let inFlight = 0;
    let maxInFlight = 0;
    // Delay each readdir so probes genuinely overlap, then measure the peak.
    const spy = jest.spyOn(fs.promises, 'readdir').mockImplementation(((...args: unknown[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          (real as (...a: unknown[]) => Promise<unknown>)(...args).then(
            (v) => {
              inFlight--;
              resolve(v);
            },
            (e) => {
              inFlight--;
              reject(e);
            }
          );
        }, 8);
      });
    }) as unknown as typeof fs.promises.readdir);
    try {
      const d = new FileDirs([{ path: root, label: 'M', hasScheduled: false }], silentLog);
      const rows = await d.list(0);
      // No audio anywhere -> every subfolder is pruned away.
      expect(rows).toEqual([]);
      // Parallel (peak > 1) but never above the cap.
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(PRUNE_CONCURRENCY);
    } finally {
      spy.mockRestore();
    }
  });
});

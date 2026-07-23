import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileDirs } from '../../src/audio/file-dirs';
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
});

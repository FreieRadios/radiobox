import * as fs from 'node:fs';
import * as path from 'node:path';
import { FilePlayerDir } from '../config/schema';
import { ScheduleEntry, parsePlayAtMs } from '../schedule';
import { Log } from '../util/log';
import { AUDIO_EXTENSIONS } from './file-player';

/** One configured browsable folder, as served to the meters page. */
export interface FolderEntry {
  label: string;
  /** Emoji shown in the ⋮ menu and on the welcome tiles. */
  icon: string;
}

/** One row of a folder listing served to the meters page. */
export interface FileEntry {
  name: string;
  /** Epoch ms parsed from a `YYYYMMDD-HHMMSS` filename timestamp, or null. */
  playAtMs: number | null;
  /** True for a browsable subdirectory row (not playable). */
  dir?: boolean;
}

/** Where a file lives in the browsable folders: which configured dir, and the
 *  folder-relative path inside it (`Musik/x.flac`) — the same form `playFile`,
 *  the queue and the schedule use. */
export interface FileLocation {
  folder: number;
  name: string;
}

/** Recursion guard for scheduled(): deeper trees are ignored, not an error. */
const MAX_WALK_DEPTH = 8;

/** How many subfolder levels the "does this folder hold audio?" probe (used to
 *  hide empty folders in the browser) descends before giving up. Bounds the
 *  cost of proving a non-music folder empty over a slow (e.g. SMB) mount. */
const PRUNE_DEPTH = 4;

/** How long a folder's audio/no-audio probe result is cached, so re-browsing
 *  and back/forth navigation stay instant. Short enough that a changing share
 *  is reflected within a minute. */
const AUDIO_CACHE_TTL_MS = 60_000;

/** Max concurrent readdir()s the empty-folder probe issues at once. Bounds the
 *  fan-out so a wide tree on a slow (e.g. SMB) mount can't flood the client
 *  with thousands of simultaneous requests and stall the machine. */
export const PRUNE_CONCURRENCY = 6;

/** Wall-clock budget for probing one folder listing. Once it's spent the
 *  remaining probes fail open (their folders are shown), so a huge/slow tree
 *  costs bounded latency instead of hanging the listing forever. */
const PRUNE_BUDGET_MS = 2500;

/** Minimal FIFO counting semaphore (no external deps): bounds how many probe
 *  readdir()s run at once. A permit is held only around the readdir syscall,
 *  never across recursion, so it throttles I/O without deadlocking. */
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
}

/**
 * The configured browsable file-player folders: listing, timestamp parsing and
 * path-traversal-safe resolution. Shared by the live `Pipeline` and the
 * playout-only `PlayoutPipeline` (both expose the same `/folders`, `/files`
 * and `playFile` surface).
 */
export class FileDirs {
  /** absolute dir -> whether it holds audio within PRUNE_DEPTH, with expiry. */
  private audioCache = new Map<string, { has: boolean; expiry: number }>();
  /** Throttles the empty-folder probe's readdir fan-out (see PRUNE_CONCURRENCY). */
  private probeSem = new Semaphore(PRUNE_CONCURRENCY);

  constructor(
    private dirs: FilePlayerDir[],
    private log: Log
  ) {}

  /** The configured browsable folders (menu order), each with the emoji the
   *  UI shows for it in the ⋮ menu and on the welcome tiles. */
  folders(): FolderEntry[] {
    return this.dirs.map((d) => ({ label: d.label, icon: d.icon || '📁' }));
  }

  /** Memo for `locate()` (input path -> location), see there. */
  private locateKey: string | null = null;
  private locateHit: FileLocation | null = null;

  /** Absolute path of the folder at `index`, or null. */
  private root(index: number): string | null {
    const dir = this.dirs[index];
    return dir ? path.resolve(dir.path) : null;
  }

  /** Absolute path of the subdirectory `sub` (posix-relative, may be '')
   *  inside the folder at `index`, traversal-safe, or null. */
  private subdir(index: number, sub: string): string | null {
    const root = this.root(index);
    if (!root) return null;
    if (!sub) return root;
    const resolved = path.resolve(root, sub);
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  }

  /** List the folder at `index` (optionally a subdirectory `sub` inside it):
   *  subdirectory rows first, then playable audio files, each file with its
   *  parsed auto-play timestamp (when the name carries one). Dotfiles and
   *  dot-directories are hidden. */
  entries(index: number, sub = ''): FileEntry[] {
    const dir = this.subdir(index, sub);
    if (!dir) return [];
    try {
      const listed = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'));
      const dirs: FileEntry[] = listed
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, playAtMs: null, dir: true }));
      const files: FileEntry[] = listed
        .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, playAtMs: parsePlayAtMs(e.name) }));
      const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name);
      return [...dirs.sort(byName), ...files.sort(byName)];
    } catch (err) {
      this.log.warn(`cannot list ${dir}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Browse listing for the meters page: like {@link entries}, but async
   *  (non-blocking readdir, important on network mounts) and — unless the
   *  folder opts out with `hideEmpty: false` — subfolders holding no audio
   *  anywhere within PRUNE_DEPTH are dropped, so only folders with useful
   *  contents are shown. Audio files are always listed; probing a subfolder
   *  fails open (the folder is shown) so a transient error never hides real
   *  content. Sorted subdirectory rows first, then audio files. */
  async list(index: number, sub = ''): Promise<FileEntry[]> {
    const dir = this.subdir(index, sub);
    if (!dir) return [];
    const prune = this.dirs[index]?.hideEmpty !== false;
    let listed: fs.Dirent[];
    try {
      listed = (await fs.promises.readdir(dir, { withFileTypes: true })).filter(
        (e) => !e.name.startsWith('.')
      );
    } catch (err) {
      this.log.warn(`cannot list ${dir}: ${(err as Error).message}`);
      return [];
    }
    const subdirs = listed.filter((e) => e.isDirectory());
    const files: FileEntry[] = listed
      .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
      .map((e) => ({ name: e.name, playAtMs: parsePlayAtMs(e.name) }));

    let dirRows: FileEntry[];
    if (prune) {
      // Probe children concurrently but bounded (Semaphore) and under one
      // shared wall-clock budget, so a wide tree on a slow mount throttles
      // instead of flooding, and overrunning probes fail open (folder shown)
      // rather than hanging the listing.
      const deadline = Date.now() + PRUNE_BUDGET_MS;
      const keep = await Promise.all(
        subdirs.map((e) => this.hasAudio(path.join(dir, e.name), deadline))
      );
      dirRows = subdirs
        .filter((_, i) => keep[i])
        .map((e) => ({ name: e.name, playAtMs: null, dir: true }));
    } else {
      dirRows = subdirs.map((e) => ({ name: e.name, playAtMs: null, dir: true }));
    }
    const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name);
    return [...dirRows.sort(byName), ...files.sort(byName)];
  }

  /** Cached "does `absDir` hold an audio file within PRUNE_DEPTH?", computed
   *  under the caller's shared `deadline` (fail open once it passes). */
  private async hasAudio(absDir: string, deadline: number): Promise<boolean> {
    const now = Date.now();
    const cached = this.audioCache.get(absDir);
    if (cached && cached.expiry > now) return cached.has;
    const has = await this.hasAudioWithin(absDir, PRUNE_DEPTH, deadline);
    this.audioCache.set(absDir, { has, expiry: now + AUDIO_CACHE_TTL_MS });
    return has;
  }

  /** Semaphore-limited readdir for the probe, so at most PRUNE_CONCURRENCY run
   *  at once no matter how wide the tree. */
  private async probeReaddir(absDir: string): Promise<fs.Dirent[]> {
    await this.probeSem.acquire();
    try {
      return await fs.promises.readdir(absDir, { withFileTypes: true });
    } finally {
      this.probeSem.release();
    }
  }

  /** True as soon as any audio file is found at `absDir` or (up to `remaining`
   *  levels) below it; false only after the bounded subtree is exhausted.
   *  Reads fail open (return true) so an unreadable folder is never hidden, and
   *  once the shared `deadline` passes the probe stops descending and fails
   *  open too — bounding cost on huge/slow trees. Symlinked directories are not
   *  followed (isDirectory() excludes them). */
  private async hasAudioWithin(
    absDir: string,
    remaining: number,
    deadline: number
  ): Promise<boolean> {
    if (Date.now() > deadline) return true;
    let listed: fs.Dirent[];
    try {
      listed = await this.probeReaddir(absDir);
    } catch {
      return true;
    }
    const subdirs: string[] = [];
    for (const e of listed) {
      if (e.name.startsWith('.')) continue;
      if (e.isFile()) {
        if (AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) return true;
      } else if (e.isDirectory()) {
        subdirs.push(e.name);
      }
    }
    if (remaining <= 0 || !subdirs.length) return false;
    if (Date.now() > deadline) return true;
    const deeper = await Promise.all(
      subdirs.map((n) => this.hasAudioWithin(path.join(absDir, n), remaining - 1, deadline))
    );
    return deeper.some(Boolean);
  }

  /** Every timestamped file across the folders marked `hasScheduled`,
   *  recursing into subdirectories, as scheduler entries. `name` is the
   *  posix-relative path inside its folder (e.g.
   *  "Musik/x-20260722-130000.flac"), which `resolve()` accepts as-is.
   *  Symlinked directories are not followed (cycle safety); depth is capped
   *  at MAX_WALK_DEPTH. */
  scheduled(): ScheduleEntry[] {
    const out: ScheduleEntry[] = [];
    for (let folder = 0; folder < this.dirs.length; folder++) {
      if (this.dirs[folder].hasScheduled) this.walkScheduled(folder, '', 0, out);
    }
    return out;
  }

  private walkScheduled(folder: number, sub: string, depth: number, out: ScheduleEntry[]): void {
    if (depth > MAX_WALK_DEPTH) return;
    for (const e of this.entries(folder, sub)) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.dir) this.walkScheduled(folder, rel, depth + 1, out);
      else if (e.playAtMs !== null) out.push({ folder, name: rel, playAtMs: e.playAtMs });
    }
  }

  /** Reverse of `resolve()`: the configured folder an absolute path sits in,
   *  plus its folder-relative name — so the UI can offer "jump to the folder
   *  this is playing from" no matter how playback was started (click, queue,
   *  schedule). Single-entry memo: the snapshot asks for the same path many
   *  times per second while one file plays. */
  locate(abs: string): FileLocation | null {
    if (abs === this.locateKey) return this.locateHit;
    const target = path.resolve(abs);
    let hit: FileLocation | null = null;
    for (let folder = 0; folder < this.dirs.length && !hit; folder++) {
      const root = this.root(folder);
      if (!root) continue;
      const rel = path.relative(root, target);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      hit = { folder, name: rel.split(path.sep).join('/') };
    }
    this.locateKey = abs;
    this.locateHit = hit;
    return hit;
  }

  /** Resolve a requested filename to an absolute path inside the folder at
   *  `index`, rejecting path traversal and disallowed extensions. */
  resolve(index: number, name: string): string | null {
    const root = this.root(index);
    if (!root || !name) return null;
    const resolved = path.resolve(root, name);
    const rel = path.relative(root, resolved);
    // Reject anything that escapes the root ("..") or is absolute elsewhere.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!AUDIO_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  }
}

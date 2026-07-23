import * as fs from 'node:fs';
import * as path from 'node:path';
import { FilePlayerDir } from '../config/schema';
import { ScheduleEntry, parsePlayAtMs } from '../schedule';
import { Log } from '../util/log';
import { AUDIO_EXTENSIONS } from './file-player';

/** One row of a folder listing served to the meters page. */
export interface FileEntry {
  name: string;
  /** Epoch ms parsed from a `YYYYMMDD-HHMMSS` filename timestamp, or null. */
  playAtMs: number | null;
  /** True for a browsable subdirectory row (not playable). */
  dir?: boolean;
}

/** Recursion guard for scheduled(): deeper trees are ignored, not an error. */
const MAX_WALK_DEPTH = 8;

/**
 * The configured browsable file-player folders: listing, timestamp parsing and
 * path-traversal-safe resolution. Shared by the live `Pipeline` and the
 * playout-only `PlayoutPipeline` (both expose the same `/folders`, `/files`
 * and `playFile` surface).
 */
export class FileDirs {
  constructor(
    private dirs: FilePlayerDir[],
    private log: Log
  ) {}

  /** Labels of the configured browsable folders (dropdown order). */
  folders(): string[] {
    return this.dirs.map((d) => d.label);
  }

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

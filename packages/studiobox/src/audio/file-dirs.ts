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
}

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

  /** List playable audio files directly inside the folder at `index`, each
   *  with its parsed auto-play timestamp (when the name carries one). */
  entries(index: number): FileEntry[] {
    const root = this.root(index);
    if (!root) return [];
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
        .map((e) => ({ name: e.name, playAtMs: parsePlayAtMs(e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      this.log.warn(`cannot list ${root}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Every timestamped file across all folders, as scheduler entries. */
  scheduled(): ScheduleEntry[] {
    const out: ScheduleEntry[] = [];
    for (let folder = 0; folder < this.dirs.length; folder++) {
      for (const e of this.entries(folder)) {
        if (e.playAtMs !== null) out.push({ folder, name: e.name, playAtMs: e.playAtMs });
      }
    }
    return out;
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

import * as path from 'node:path';
import { BedConfig } from '../config/schema';
import { Log } from '../util/log';
import { FileEntry, FileLocation } from './file-dirs';

/** The slice of FilePlayer the bed needs (structural, so tests can stub it). */
export interface BedPlayer {
  readonly playing: string | null;
  play(file: string, opts?: { loop?: boolean; fadeInMs?: number }): void;
  fadeOut(ms: number): void;
  read(outL: Float32Array, outR: Float32Array, frames: number): void;
  on(event: 'ended', listener: () => void): unknown;
}

/** The slice of FileDirs the bed needs. */
export interface BedDirs {
  folders(): { label: string }[];
  entries(index: number, sub?: string): FileEntry[];
  resolve(index: number, name: string): string | null;
}

export interface BedStatus {
  on: boolean;
  /** Name of the selected bed file, or null when the folder holds none. */
  name: string | null;
  at: FileLocation | null;
}

/**
 * The audio bed ("Bett"): a second deck that loops one file until it is
 * switched off, faded in and out. The host's emergency fallback, so it has to
 * work with one tap and no browsing: the first audio file of the configured
 * folder is selected by itself, another one can be chosen at any time.
 *
 * `mixInto()` adds the bed onto the file player's block, so the graph levels
 * and ducks it like any other played file.
 */
export class BedDeck {
  private selected: FileLocation | null = null;
  private wanted = false; // on, as the operator last asked for
  private gain: number;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);

  constructor(
    private player: BedPlayer,
    private dirs: BedDirs,
    private cfg: BedConfig,
    private log: Log
  ) {
    this.gain = Math.pow(10, cfg.gainDb / 20);
    // The loop only ends when its decoder dies (file gone, share dropped) or
    // after a fade-out; either way the bed is off then.
    player.on('ended', () => {
      this.wanted = false;
    });
  }

  /** The bed file: the chosen one, else the first audio file of the folder. */
  private current(): FileLocation | null {
    if (this.selected) return this.selected;
    const folder = this.dirs.folders().findIndex((f) => f.label === this.cfg.dir);
    if (folder < 0) return null;
    const first = this.dirs.entries(folder).find((e) => !e.dir);
    return first ? { folder, name: first.name } : null;
  }

  /** Choose which file is the bed. Switches over at once if the bed is on. */
  select(folder: number, name: string): boolean {
    if (!this.dirs.resolve(folder, name)) return false;
    this.selected = { folder, name };
    if (this.wanted) this.start();
    return true;
  }

  private start(): boolean {
    const at = this.current();
    const file = at ? this.dirs.resolve(at.folder, at.name) : null;
    if (!file) {
      this.log.warn(`bed: no audio file in "${this.cfg.dir}"`);
      this.wanted = false;
      return false;
    }
    this.log.info(`bed on: ${path.basename(file)}`);
    this.player.play(file, { loop: true, fadeInMs: this.cfg.fadeInMs });
    this.wanted = true;
    return true;
  }

  /** Switch the bed on (fade in, loop) or off (fade out). */
  set(on: boolean): void {
    if (on) {
      if (!this.wanted) this.start();
    } else if (this.wanted) {
      this.wanted = false;
      this.log.info('bed off');
      this.player.fadeOut(this.cfg.fadeOutMs);
    }
  }

  get on(): boolean {
    return this.wanted;
  }

  /** Add one block of the bed onto `l`/`r` (the file player's block). */
  mixInto(l: Float32Array, r: Float32Array, frames: number): void {
    if (!this.player.playing) return;
    if (this.bufL.length < frames) {
      this.bufL = new Float32Array(frames);
      this.bufR = new Float32Array(frames);
    }
    this.player.read(this.bufL, this.bufR, frames);
    for (let i = 0; i < frames; i++) {
      l[i] += this.bufL[i] * this.gain;
      r[i] += this.bufR[i] * this.gain;
    }
  }

  status(): BedStatus {
    const at = this.current();
    return { on: this.wanted, name: at ? path.basename(at.name) : null, at };
  }
}

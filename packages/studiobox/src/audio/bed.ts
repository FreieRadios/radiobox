import * as path from 'node:path';
import { BedConfig } from '../config/schema';
import { Log } from '../util/log';
import { FileEntry, FileLocation } from './file-dirs';

/** The slice of FilePlayer the bed needs (structural, so tests can stub it). */
export interface BedPlayer {
  readonly playing: string | null;
  /** Seconds into the file (counting on past its end while looping). */
  readonly position?: number;
  /** The file's length in seconds, once known. */
  readonly duration?: number | null;
  play(file: string, opts?: { loop?: boolean; fadeInMs?: number; startSec?: number }): void;
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
  /** On by itself after silence ("Havarie"), not by the host. */
  havarie: boolean;
  /** Whether the havarie watch is switched on; null when not configured. */
  havarieArmed: boolean | null;
}

/** Sound has to last this long before it ends a havarie (a click doesn't). */
const HAVARIE_SOUND_MS = 250;

/**
 * The audio bed ("Bett"): a second deck that loops one file until it is
 * switched off, faded in and out. The host's emergency fallback, so it has to
 * work with one tap and no browsing: the first audio file of the configured
 * folder is selected by itself, another one can be chosen at any time.
 *
 * `mixInto()` adds the bed onto the file player's block, so the graph levels
 * and ducks it like any other played file.
 *
 * Switched off and on again, the bed goes on where it was (per file, in
 * memory), and at the end of the file it starts over: an endless loop that
 * doesn't repeat its first minute every time. Choosing a file starts it from
 * the top.
 *
 * Havarie: `watch()` is told every block whether anything but the bed makes a
 * sound. After `havarie.afterSeconds` of silence the bed fades in by itself;
 * the first sound fades it out again. Switching the bed by hand ends it.
 */
export class BedDeck {
  private selected: FileLocation | null = null;
  private wanted = false; // on, as the operator last asked for
  private gain: number;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  private havarie = false;
  private watching: boolean; // the technician's switch (starts as configured)
  private silentMs = 0;
  private soundMs = 0;
  // Where each file was switched off (s into the file), to resume there.
  private resumeAt = new Map<string, number>();
  private fading = false; // our own fade-out is running (its 'ended' is no failure)

  constructor(
    private player: BedPlayer,
    private dirs: BedDirs,
    private cfg: BedConfig,
    private log: Log
  ) {
    this.gain = Math.pow(10, cfg.gainDb / 20);
    this.watching = cfg.havarie.enabled;
    // The loop only ends when its decoder dies (file gone, share dropped) or
    // after a fade-out; either way the bed is off then.
    player.on('ended', () => {
      // Not our fade: the decoder died (file gone, share dropped). Start
      // that file from the top next time.
      if (!this.fading) this.resumeAt.clear();
      this.fading = false;
      this.wanted = false;
      this.havarie = false;
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
    const file = this.dirs.resolve(folder, name);
    if (!file) return false;
    this.selected = { folder, name };
    this.resumeAt.delete(file); // a file chosen starts from the top
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
    const startSec = this.resumeAt.get(file) ?? 0;
    this.log.info(
      `bed on: ${path.basename(file)}${startSec > 0 ? ` from ${startSec.toFixed(1)} s` : ''}`
    );
    this.fading = false;
    this.player.play(file, { loop: true, fadeInMs: this.cfg.fadeInMs, startSec });
    this.wanted = true;
    return true;
  }

  /** Switch the bed on (fade in, loop) or off (fade out). By hand, or by the
   *  stream fallback: either way it is no havarie any more. */
  set(on: boolean): void {
    if (this.havarie) {
      this.havarie = false;
      this.silentMs = 0;
      if (on) return; // already playing; it just stops being a havarie
    }
    if (on) {
      if (!this.wanted) this.start();
    } else if (this.wanted) {
      this.wanted = false;
      this.remember();
      this.log.info('bed off');
      this.fading = true;
      this.player.fadeOut(this.cfg.fadeOutMs);
    }
  }

  /** Note where the playing file will be once the fade-out is over: that is
   *  where it goes on next time, wrapped into the file. */
  private remember(): void {
    const file = this.player.playing;
    const pos = this.player.position;
    const dur = this.player.duration;
    if (!file || pos === undefined) return;
    const at = pos + this.cfg.fadeOutMs / 1000;
    if (dur && dur > 0) this.resumeAt.set(file, at % dur);
    else this.resumeAt.delete(file); // length unknown: can't wrap, start over
  }

  get on(): boolean {
    return this.wanted;
  }

  /**
   * One block of `ms` milliseconds: did anything but the bed make a sound?
   * `armed` false (no show on) ends a havarie and starts no new one.
   */
  watch(sound: boolean, armed: boolean, ms: number): void {
    if (!this.watching) return;
    if (!armed) {
      if (this.havarie) this.endHavarie('show over');
      this.silentMs = 0;
      return;
    }
    if (this.havarie) {
      this.soundMs = sound ? this.soundMs + ms : 0;
      if (this.soundMs >= HAVARIE_SOUND_MS) this.endHavarie('sound is back');
      return;
    }
    this.silentMs = sound || this.wanted ? 0 : this.silentMs + ms;
    if (this.silentMs < this.cfg.havarie.afterSeconds * 1000) return;
    this.silentMs = 0;
    this.log.warn(`havarie: ${this.cfg.havarie.afterSeconds} s of silence`);
    if (this.start()) {
      this.havarie = true;
      this.soundMs = 0;
    }
  }

  /** The technician's switch for the havarie watch. Only where it is
   *  configured; switching it off ends a running havarie. */
  setHavarieWatch(on: boolean): boolean {
    if (!this.cfg.havarie.enabled) return false;
    if (on === this.watching) return true;
    this.watching = on;
    this.silentMs = 0;
    this.log.info(`havarie watch ${on ? 'on' : 'off'}`);
    if (!on && this.havarie) this.endHavarie('watch switched off');
    return true;
  }

  get havarieWatch(): boolean {
    return this.watching;
  }

  private endHavarie(why: string): void {
    this.havarie = false;
    this.silentMs = 0;
    this.log.info(`havarie over: ${why}`);
    this.set(false);
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
    return {
      on: this.wanted,
      name: at ? path.basename(at.name) : null,
      at,
      havarie: this.havarie,
      havarieArmed: this.cfg.havarie.enabled ? this.watching : null,
    };
  }
}

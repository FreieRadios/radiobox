import { StreamSourceConfig } from '../config/schema';
import { Log } from '../util/log';
import { StreamPlayerOptions } from './stream-player';

/** The slice of the bed deck the fallback needs. */
export interface FallbackBed {
  readonly on: boolean;
  set(on: boolean): void;
}

/** The player's stream events (FilePlayer). */
export interface StreamEvents {
  on(ev: 'streamLost' | 'streamBack' | 'streamEnd', fn: () => void): unknown;
}

/**
 * While a stream is gone, the bed plays (roadmap M1c.2): switched on when
 * the stream's audio drops out, off again when it is back or stopped — but
 * only a bed this switched on. One the host started by hand stays theirs.
 * With `fallback: silence`, or without a bed, nothing happens: the output is
 * silent until the stream is back.
 */
export class StreamFallback {
  private ours = false;

  constructor(
    private bed: FallbackBed | null,
    private log: Log
  ) {}

  /** `mode` names the playing stream's fallback when it drops out. */
  attach(player: StreamEvents, mode: () => 'bed' | 'silence' | null): void {
    player.on('streamLost', () => {
      if (mode() !== 'bed' || !this.bed || this.bed.on) return;
      this.log.info('stream gone: the bed plays');
      this.bed.set(true);
      this.ours = this.bed.on;
    });
    player.on('streamBack', () => this.release());
    player.on('streamEnd', () => this.release());
  }

  private release(): void {
    if (!this.ours) return;
    this.ours = false;
    if (this.bed?.on) {
      this.log.info('stream back: the bed fades out');
      this.bed.set(false);
    }
  }
}

/** The pieces `setupStreams` connects (FilePlayer, FileDirs, BedDeck). */
export interface StreamWiring {
  player: StreamEvents & {
    setStreams(
      lookup: (
        file: string
      ) => { label: string; url: string; bufferMs: number; format?: string } | null,
      opts?: StreamPlayerOptions
    ): void;
    play(file: string): void;
    readonly playing: string | null;
  };
  dirs: {
    streamOf(token: string): StreamSourceConfig | null;
    resolve(index: number, name: string): string | null;
    readonly streamsFolder: number;
  };
  streams: readonly StreamSourceConfig[];
  bed: FallbackBed | null;
  log: Log;
  opts?: StreamPlayerOptions;
}

/**
 * Let the file player play the configured streams, with the bed as fallback.
 * Returns `autoStart()`, to call once the output runs: it starts the stream
 * marked `autoStart`, so a box at the desk plays without a tablet.
 */
export function setupStreams(w: StreamWiring): { autoStart(): void } {
  w.player.setStreams((file) => {
    const s = w.dirs.streamOf(file);
    return s ? { label: s.label, url: s.url, bufferMs: s.bufferMs, format: s.format } : null;
  }, w.opts);
  const fallback = new StreamFallback(w.bed, w.log);
  fallback.attach(w.player, () => {
    const p = w.player.playing;
    return p ? (w.dirs.streamOf(p)?.fallback ?? null) : null;
  });
  return {
    autoStart: () => {
      const s = w.streams.find((x) => x.autoStart);
      const token = s ? w.dirs.resolve(w.dirs.streamsFolder, s.label) : null;
      if (!s || !token) return;
      w.log.info(`stream ${s.label}: starting at boot`);
      w.player.play(token);
    },
  };
}

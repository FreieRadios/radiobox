import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaptureConfig, BackupConfig } from '../config/schema';
import { Log } from '../util/log';

/** How long ffmpeg gets to finalize a file after its input was closed before
 *  it is told to quit. */
const FINALIZE_MS = 5000;

/** FLAC's channel layout per channel count, in ffmpeg's names. */
const FLAC_LAYOUTS: Record<number, string> = {
  3: '3.0',
  4: 'quad',
  5: '5.0',
  6: '5.1',
  7: '6.1',
  8: '7.1',
};

export interface RecorderOptions {
  /** Channels in the blocks handed to `write()`. Default 2. */
  channels?: number;
  /** Inserted before `.flac` in the file name (e.g. `.multitrack`). */
  suffix?: string;
}

export interface RecordingStart {
  /** Time the file is named by: the on-air time ("Sendezeit") of its first
   *  sample. Defaults to now. */
  startMs?: number;
  /** Vorbis comments (TITLE, DATE, ...) written into the file. */
  tags?: Record<string, string>;
}

/** `YYYYMMDD-HHMMSS` in the server's time zone — the same shape the
 *  auto-play scheduler reads, so a recording dropped into a scheduled folder
 *  carries a valid (past) timestamp. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Writes a float stream to a local FLAC file (24 bit) via its own ffmpeg
 * process, independent of the harbor encoder, so the meters page can start and
 * stop recording without interrupting the live stream.
 *
 * By default a recording is **one continuous file**, named by the time its
 * first sample goes on air and tagged — the form a session is handed out in.
 * `backup.segmentSeconds > 0` instead rolls strftime-named segments (an
 * always-on safety copy). The same class writes the stereo programme and the
 * multitrack file; the pipeline feeds both from the same block, which keeps
 * them sample-aligned.
 *
 * Events: 'exit' (code) on termination.
 */
export class Recorder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private file: string | null = null;
  private readonly channels: number;
  private readonly suffix: string;

  constructor(
    private backup: BackupConfig,
    private capture: CaptureConfig,
    private log: Log,
    opts: RecorderOptions = {}
  ) {
    super();
    this.channels = opts.channels ?? 2;
    this.suffix = opts.suffix ?? '';
  }

  /** True while a recording ffmpeg process is running. */
  get active(): boolean {
    return this.proc !== null;
  }

  /** Path of the file being written (continuous mode), else null. */
  get currentFile(): string | null {
    return this.proc ? this.file : null;
  }

  private args(start: RecordingStart): string[] {
    fs.mkdirSync(this.backup.dir, { recursive: true });
    const a = [
      '-hide_banner',
      '-loglevel',
      'error',
      // input: raw float from our DSP graph
      '-f',
      'f32le',
      '-ar',
      String(this.capture.sampleRate),
      '-ac',
      String(this.channels),
      // FLAC only knows its own layout per channel count; name it, or ffmpeg
      // complains about the one it guessed. The channels are discrete tracks
      // anyway (see the channel map written beside a multitrack file).
      ...(FLAC_LAYOUTS[this.channels] ? ['-channel_layout', FLAC_LAYOUTS[this.channels]] : []),
      '-i',
      'pipe:0',
      '-map',
      '0:a',
      '-c:a',
      'flac',
      '-compression_level',
      '8',
    ];
    for (const [k, v] of Object.entries(start.tags ?? {})) {
      if (v) a.push('-metadata', `${k}=${v}`);
    }
    if (this.backup.segmentSeconds > 0) {
      this.file = null;
      a.push(
        '-f',
        'segment',
        '-segment_time',
        String(this.backup.segmentSeconds),
        '-strftime',
        '1',
        '-reset_timestamps',
        '1',
        path.join(this.backup.dir, `studiobox-%Y%m%d-%H%M%S${this.suffix}.flac`)
      );
    } else {
      this.file = path.join(
        this.backup.dir,
        `studiobox-${stamp(start.startMs ?? Date.now())}${this.suffix}.flac`
      );
      a.push('-f', 'flac', '-y', this.file);
    }
    return a;
  }

  /** Start (or restart) the recording ffmpeg process. No-op if already active. */
  start(start: RecordingStart = {}): void {
    if (this.proc) return;
    const args = this.args(start);
    this.log.info('ffmpeg recorder:', 'ffmpeg', args.join(' '));
    const proc = spawn('ffmpeg', args);
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('recorder ffmpeg:', s);
    });
    // If ffmpeg dies (disk full, bad path), the next write races the 'close'
    // event and the pipe emits EPIPE on stdin. Unhandled, that 'error' would
    // take the whole service down; 'close' -> 'exit' drives the restart.
    proc.stdin.on('error', (err) => this.log.warn('recorder ffmpeg stdin:', err.message));
    proc.on('error', (err) => this.log.error('recorder spawn error:', err.message));
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      this.emit('exit', code);
    });
  }

  /** Feed one block. Returns false when not recording. */
  write(buf: Buffer): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false;
    return this.proc.stdin.write(buf);
  }

  /** Stop recording. The input is closed and ffmpeg finalizes the file on its
   *  own (every block written so far is kept, the header gets its length);
   *  only if it hangs is it told to quit. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    proc.stdin.end();
    const t = setTimeout(() => proc.kill('SIGTERM'), FINALIZE_MS);
    t.unref?.();
    proc.once('close', () => clearTimeout(t));
  }
}

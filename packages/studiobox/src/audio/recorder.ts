import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaptureConfig, BackupConfig } from '../config/schema';
import { Log } from '../util/log';

/**
 * Writes the finished stereo float stream to a rolling local FLAC backup via
 * its own ffmpeg process (segmented, strftime-named), independent of the harbor
 * encoder. Keeping it separate lets the meters page start/stop recording
 * without interrupting the live stream.
 *
 * Events: 'exit' (code) on unexpected termination.
 */
export class Recorder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private backup: BackupConfig,
    private capture: CaptureConfig,
    private log: Log
  ) {
    super();
  }

  /** True while a recording ffmpeg process is running. */
  get active(): boolean {
    return this.proc !== null;
  }

  private args(): string[] {
    fs.mkdirSync(this.backup.dir, { recursive: true });
    const pattern = path.join(this.backup.dir, 'studiobox-%Y%m%d-%H%M%S.flac');
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      // input: raw stereo float from our DSP graph
      '-f',
      'f32le',
      '-ar',
      String(this.capture.sampleRate),
      '-ac',
      '2',
      '-i',
      'pipe:0',
      '-map',
      '0:a',
      '-c:a',
      'flac',
      '-compression_level',
      '8',
      '-f',
      'segment',
      '-segment_time',
      String(this.backup.segmentSeconds),
      '-strftime',
      '1',
      '-reset_timestamps',
      '1',
      pattern,
    ];
  }

  /** Start (or restart) the recording ffmpeg process. No-op if already active. */
  start(): void {
    if (this.proc) return;
    const args = this.args();
    this.log.info('ffmpeg recorder:', 'ffmpeg', args.join(' '));
    const proc = spawn('ffmpeg', args);
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('recorder ffmpeg:', s);
    });
    proc.on('error', (err) => this.log.error('recorder spawn error:', err.message));
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      this.emit('exit', code);
    });
  }

  /** Feed one encoded stereo block. Returns false when not recording. */
  write(buf: Buffer): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false;
    return this.proc.stdin.write(buf);
  }

  /** Stop recording, flushing and finalizing the current segment. */
  stop(): void {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

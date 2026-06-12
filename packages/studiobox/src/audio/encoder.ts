import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaptureConfig, OutputConfig } from '../config/schema';
import { Log } from '../util/log';

/**
 * Encodes the finished stereo float stream to lossless FLAC and fans it out to
 * (a) a Liquidsoap harbor via the Icecast source protocol and (b) a rolling
 * local FLAC backup — both from a single ffmpeg process (one stdin, two outputs).
 *
 * Events: 'exit' (code). The pipeline restarts the encoder on unexpected exit
 * (e.g. harbor connection drop).
 */
export class Encoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private out: OutputConfig,
    private capture: CaptureConfig,
    private log: Log,
  ) {
    super();
  }

  private args(): string[] {
    const a: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      // input: raw stereo float from our DSP graph
      '-f', 'f32le',
      '-ar', String(this.capture.sampleRate),
      '-ac', '2',
      '-i', 'pipe:0',
    ];

    if (this.out.harbor.enabled) {
      if (this.out.harbor.format === 'ogg-flac') {
        a.push('-map', '0:a', '-c:a', 'flac', '-f', 'ogg');
      } else {
        a.push('-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3');
      }
      a.push('-content_type', this.out.harbor.contentType, this.out.harbor.url);
    }

    if (this.out.backup.enabled) {
      fs.mkdirSync(this.out.backup.dir, { recursive: true });
      const pattern = path.join(this.out.backup.dir, 'studiobox-%Y%m%d-%H%M%S.flac');
      a.push(
        '-map', '0:a',
        '-c:a', 'flac', '-compression_level', '8',
        '-f', 'segment',
        '-segment_time', String(this.out.backup.segmentSeconds),
        '-strftime', '1',
        '-reset_timestamps', '1',
        pattern,
      );
    }

    return a;
  }

  start(): void {
    if (!this.out.harbor.enabled && !this.out.backup.enabled) {
      throw new Error('output: at least one of harbor or backup must be enabled');
    }
    const args = this.args();
    this.log.info('ffmpeg encoder:', 'ffmpeg', args.join(' ').replace(/\/\/[^@]*@/, '//***@'));
    const proc = spawn('ffmpeg', args);
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('encoder ffmpeg:', s);
    });
    proc.on('error', (err) => this.log.error('encoder spawn error:', err.message));
    proc.on('close', (code) => {
      this.proc = null;
      this.emit('exit', code);
    });
  }

  /** Feed one encoded stereo block. Returns false on backpressure. */
  write(buf: Buffer): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false;
    return this.proc.stdin.write(buf);
  }

  stop(): void {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

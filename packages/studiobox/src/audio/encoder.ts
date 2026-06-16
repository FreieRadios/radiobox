import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CaptureConfig, OutputConfig } from '../config/schema';
import { Log } from '../util/log';

/**
 * Encodes the finished stereo float stream and streams it to a Liquidsoap
 * harbor via the Icecast source protocol. The rolling local FLAC backup runs
 * in its own process (see `Recorder`) so it can be toggled independently.
 *
 * Events: 'exit' (code). The pipeline restarts the encoder on unexpected exit
 * (e.g. harbor connection drop).
 */
export class Encoder extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private out: OutputConfig,
    private capture: CaptureConfig,
    private log: Log
  ) {
    super();
  }

  /** True while the harbor encoder ffmpeg process is running. */
  get active(): boolean {
    return this.proc !== null;
  }

  private args(): string[] {
    const a: string[] = [
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
    ];

    if (this.out.harbor.enabled) {
      // Flush every packet so the stream isn't held back in ffmpeg's ~512 KB
      // avio buffer — critical for live latency, especially on quiet content
      // where FLAC compresses small and the buffer would take minutes to fill.
      a.push('-flush_packets', '1');
      if (this.out.harbor.format === 'ogg-flac') {
        a.push('-map', '0:a', '-c:a', 'flac', '-f', 'ogg');
      } else {
        a.push('-map', '0:a', '-c:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3');
      }
      a.push('-content_type', this.out.harbor.contentType, this.out.harbor.url);
    }

    return a;
  }

  start(): void {
    if (!this.out.harbor.enabled) return;
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

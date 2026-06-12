import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CaptureConfig } from '../config/schema';
import { Log } from '../util/log';
import { BYTES_PER_SAMPLE, deinterleave } from './format';

/**
 * Captures discrete channels from an audio device via ffmpeg and emits
 * de-interleaved float blocks. ffmpeg owns the device (ALSA/PulseAudio), which
 * keeps Node free of native audio addons — the same pattern radiobox already
 * uses in BroadcastRecorder.
 *
 * Events: 'block' (Float32Array[]), 'error' (Error), 'exit' (code).
 */
export class Capture extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private leftover: Buffer = Buffer.alloc(0);
  private readonly blockBytes: number;

  constructor(private cfg: CaptureConfig, private log: Log) {
    super();
    this.blockBytes = cfg.blockSize * cfg.channels * BYTES_PER_SAMPLE;
  }

  private args(): string[] {
    const c = this.cfg;
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', c.backend, // alsa | pulse
      '-i', c.device,
      '-ar', String(c.sampleRate),
      '-ac', String(c.channels),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ];
  }

  start(): void {
    const args = this.args();
    this.log.info('ffmpeg capture:', 'ffmpeg', args.join(' '));
    const proc = spawn('ffmpeg', args);
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('capture ffmpeg:', s);
    });
    proc.on('error', (err) => this.emit('error', err));
    proc.on('close', (code) => this.emit('exit', code));
  }

  private onData(chunk: Buffer): void {
    let buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const { channels, blockSize } = this.cfg;
    let offset = 0;
    while (buf.length - offset >= this.blockBytes) {
      const block = buf.subarray(offset, offset + this.blockBytes);
      const out: Float32Array[] = Array.from({ length: channels }, () => new Float32Array(blockSize));
      deinterleave(block, channels, blockSize, out);
      this.emit('block', out);
      offset += this.blockBytes;
    }
    this.leftover = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  stop(): void {
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}

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

  private command(): { bin: string; args: string[] } {
    const c = this.cfg;
    if (c.backend === 'alsa') {
      // ffmpeg's ALSA input silently falls back to stereo on multichannel USB
      // mixers (it can't open the device's native S32_LE multichannel config),
      // so we'd only ever see 2 of N channels. `arecord` opens the device
      // directly and reliably delivers all channels. We request 32-bit float
      // (plughw converts from the device's native S32_LE) so the raw stream is
      // already the f32le the graph consumes — no extra transcode needed.
      return {
        bin: 'arecord',
        args: [
          '-D', c.device,
          '-f', 'FLOAT_LE',
          '-r', String(c.sampleRate),
          '-c', String(c.channels),
          '-t', 'raw',
          '-q',
          '-', // stdout
        ],
      };
    }
    // PulseAudio/PipeWire: ffmpeg. Device options go BEFORE -i so they
    // configure the input (after -i they would apply to the output instead).
    return {
      bin: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'pulse',
        '-ar', String(c.sampleRate),
        '-ac', String(c.channels),
        '-i', c.device,
        '-f', 'f32le',
        '-acodec', 'pcm_f32le',
        'pipe:1',
      ],
    };
  }

  start(): void {
    const { bin, args } = this.command();
    this.log.info('capture:', bin, args.join(' '));
    const proc = spawn(bin, args);
    this.proc = proc;

    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error(`capture ${bin}:`, s);
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

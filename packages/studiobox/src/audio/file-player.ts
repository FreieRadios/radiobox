import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Log } from '../util/log';
import { BYTES_PER_SAMPLE } from './format';

/** Audio file extensions the player will decode/expose. */
export const AUDIO_EXTENSIONS = [
  '.mp3',
  '.flac',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
];

const FRAME_BYTES = 2 * BYTES_PER_SAMPLE; // stereo f32le

/**
 * Decodes a local audio file to 48 kHz stereo float via ffmpeg and exposes it
 * one DSP block at a time through `read()`, mirroring the capture/encoder
 * ffmpeg pattern. The decoded stream feeds the graph's music path, so it gets
 * the same loudness normalization and ducking as a real music input.
 *
 * Events: 'ended' (playback finished and buffer drained).
 */
export class FilePlayer extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Buffer[] = [];
  private leftover: Buffer = Buffer.alloc(0);
  private current: string | null = null;
  // Smooth fade-out state: total/remaining samples of the linear gain ramp.
  // fadeTotal === 0 means no fade is in progress.
  private fadeTotal = 0;
  private fadeRemaining = 0;

  constructor(
    private sampleRate: number,
    private log: Log
  ) {
    super();
  }

  /** Absolute path of the file currently playing, or null when idle. */
  get playing(): string | null {
    return this.current;
  }

  /** Start playing `file` (absolute path), replacing any current playback. */
  play(file: string): void {
    this.stop();
    this.fadeTotal = 0;
    this.fadeRemaining = 0;
    this.current = file;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // Decode in real time (pace input to native rate) so ffmpeg trickles the
      // audio out one block at a time instead of dumping the whole file at
      // once. The burst would flood the event loop at playback start and starve
      // the arecord capture read loop (arecord "Überlauf!!!" / overflow).
      '-re',
      '-i',
      file,
      '-ar',
      String(this.sampleRate),
      '-ac',
      '2',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ];
    this.log.info('file player:', 'ffmpeg', '-i', file);
    const proc = spawn('ffmpeg', args);
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => this.queue.push(chunk));
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('file player ffmpeg:', s);
    });
    proc.on('error', (err) => this.log.error('file player spawn error:', err.message));
    proc.on('close', () => {
      // Decode finished; remaining audio still drains via read().
      if (this.proc === proc) this.proc = null;
    });
  }

  /**
   * Fill `outL`/`outR` with the next `frames` samples, zero-padding when no
   * audio is available. Emits 'ended' once the decoder has exited and the
   * buffered audio is exhausted.
   */
  read(outL: Float32Array, outR: Float32Array, frames: number): void {
    if (this.queue.length) {
      this.leftover = this.leftover.length
        ? Buffer.concat([this.leftover, ...this.queue])
        : Buffer.concat(this.queue);
      this.queue = [];
    }
    const avail = Math.floor(this.leftover.length / FRAME_BYTES);
    const have = Math.min(frames, avail);
    for (let n = 0; n < frames; n++) {
      if (n < have) {
        outL[n] = this.leftover.readFloatLE(n * FRAME_BYTES);
        outR[n] = this.leftover.readFloatLE(n * FRAME_BYTES + BYTES_PER_SAMPLE);
      } else {
        outL[n] = 0;
        outR[n] = 0;
      }
    }
    const consumed = have * FRAME_BYTES;
    this.leftover =
      consumed < this.leftover.length
        ? Buffer.from(this.leftover.subarray(consumed))
        : Buffer.alloc(0);

    // Apply the smooth fade-out gain ramp (linear to silence) when stopping.
    if (this.fadeTotal > 0) {
      for (let n = 0; n < frames; n++) {
        const g = this.fadeRemaining > 0 ? this.fadeRemaining / this.fadeTotal : 0;
        outL[n] *= g;
        outR[n] *= g;
        if (this.fadeRemaining > 0) this.fadeRemaining--;
      }
      // Ramp complete: hard-stop and report end of playback.
      if (this.fadeRemaining <= 0) {
        const finished = this.current;
        this.stop();
        if (finished) {
          this.log.info('file player: faded out', finished);
          this.emit('ended');
        }
        return;
      }
    }

    // End-of-playback: decoder gone and nothing left to play.
    if (
      this.current &&
      !this.proc &&
      this.leftover.length < FRAME_BYTES &&
      this.queue.length === 0
    ) {
      const finished = this.current;
      this.current = null;
      this.leftover = Buffer.alloc(0);
      this.log.info('file player: finished', finished);
      this.emit('ended');
    }
  }

  /**
   * Smoothly fade the current playback out to silence over `ms` milliseconds,
   * then stop and emit 'ended'. With nothing playing (or `ms <= 0`) this is a
   * plain hard stop. Calling it again while a fade is in progress is a no-op.
   */
  fadeOut(ms: number): void {
    if (!this.current || ms <= 0) {
      this.stop();
      return;
    }
    if (this.fadeTotal > 0) return; // fade already running
    this.fadeTotal = Math.max(1, Math.round((ms / 1000) * this.sampleRate));
    this.fadeRemaining = this.fadeTotal;
    // The decoder keeps running during the ramp so real audio (paced via `-re`)
    // is what gets faded down; stop() tears it down once the ramp completes.
  }

  /** Stop playback and discard any buffered audio. */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    this.queue = [];
    this.leftover = Buffer.alloc(0);
    this.current = null;
    this.fadeTotal = 0;
    this.fadeRemaining = 0;
  }
}

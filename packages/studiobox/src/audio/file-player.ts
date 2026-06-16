import { ChildProcessWithoutNullStreams, spawn, execFile } from 'node:child_process';
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

// Default jitter buffer: hold playout until this much audio is queued so a slow
// decoder startup (or producer/consumer timing jitter under `-re` real-time
// pacing) doesn't underrun and crackle. The buffer then stays ~this deep,
// absorbing jitter. ~250 ms is inaudible as start latency for a manual "play"
// action. Overridable per setup via `filePlayer.prebufferMs`.
const DEFAULT_PREBUFFER_MS = 250;
// Short ramp applied when playout begins so audio doesn't start on a waveform
// discontinuity (a click), independent of where the file's first sample sits.
const FADE_IN_MS = 12;

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
  // Playback position: real (non-padded) audio frames delivered via read().
  private playedFrames = 0;
  // Total file duration in seconds, probed async via ffprobe; null until known
  // (or if ffprobe is unavailable / the probe fails).
  private durationSec: number | null = null;
  // Jitter-buffer state: true while filling the prebuffer before playout.
  private buffering = false;
  // Fade-in ramp remaining (samples) once playout begins.
  private fadeInRemaining = 0;
  private readonly prebufferBytes: number;
  private readonly fadeInSamples: number;

  constructor(
    private sampleRate: number,
    private log: Log,
    prebufferMs: number = DEFAULT_PREBUFFER_MS
  ) {
    super();
    const preMs = Number.isFinite(prebufferMs) && prebufferMs >= 0 ? prebufferMs : DEFAULT_PREBUFFER_MS;
    this.prebufferBytes = Math.ceil((sampleRate * preMs) / 1000) * FRAME_BYTES;
    this.fadeInSamples = Math.max(1, Math.ceil((sampleRate * FADE_IN_MS) / 1000));
  }

  /** Absolute path of the file currently playing, or null when idle. */
  get playing(): string | null {
    return this.current;
  }

  /** Elapsed playback position in seconds (real audio delivered so far). */
  get position(): number {
    return this.playedFrames / this.sampleRate;
  }

  /** Total duration in seconds, or null when not yet probed / unknown. */
  get duration(): number | null {
    return this.durationSec;
  }

  /** Seconds left to play, or null when nothing is playing or the duration is
   *  unknown. Clamped at 0. */
  get remaining(): number | null {
    if (!this.current || this.durationSec === null) return null;
    return Math.max(0, this.durationSec - this.position);
  }

  /** Start playing `file` (absolute path), replacing any current playback. */
  play(file: string): void {
    this.stop();
    this.fadeTotal = 0;
    this.fadeRemaining = 0;
    this.playedFrames = 0;
    this.durationSec = null;
    this.buffering = true;
    this.fadeInRemaining = 0;
    this.current = file;
    this.probeDuration(file);
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

    // Prebuffer (jitter buffer): while filling, emit silence and don't advance
    // playback. Start once we have PREBUFFER_MS queued, or sooner if the decoder
    // already finished (a file shorter than the prebuffer). Ramp playout in to
    // avoid a startup click.
    if (this.buffering) {
      if (this.leftover.length >= this.prebufferBytes || !this.proc) {
        this.buffering = false;
        this.fadeInRemaining = this.fadeInSamples;
      } else {
        outL.fill(0, 0, frames);
        outR.fill(0, 0, frames);
        return;
      }
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
    // Count only real (non-padded) frames so position tracks actual playback.
    this.playedFrames += have;
    const consumed = have * FRAME_BYTES;
    this.leftover =
      consumed < this.leftover.length
        ? Buffer.from(this.leftover.subarray(consumed))
        : Buffer.alloc(0);

    // Apply the short fade-in ramp (silence -> unity) at the start of playout.
    if (this.fadeInRemaining > 0) {
      for (let n = 0; n < frames && this.fadeInRemaining > 0; n++) {
        const g = 1 - this.fadeInRemaining / this.fadeInSamples;
        outL[n] *= g;
        outR[n] *= g;
        this.fadeInRemaining--;
      }
    }

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
    // Nothing to fade if idle, no fade requested, or still prefilling the
    // jitter buffer (no audio has played out yet) — just hard stop.
    if (!this.current || ms <= 0 || this.buffering) {
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
    this.playedFrames = 0;
    this.durationSec = null;
    this.buffering = false;
    this.fadeInRemaining = 0;
  }

  /** Probe the file's duration via ffprobe and cache it. Best-effort: on any
   *  failure (ffprobe missing, unreadable metadata) the duration stays null and
   *  the UI simply shows elapsed time instead of remaining. The result is
   *  ignored if playback has since moved on to another file. */
  private probeDuration(file: string): void {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file,
      ],
      (err, stdout) => {
        if (err || this.current !== file) return;
        const sec = parseFloat(String(stdout).trim());
        if (Number.isFinite(sec) && sec > 0) this.durationSec = sec;
      }
    );
  }
}

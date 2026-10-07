import { ChildProcessWithoutNullStreams, spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Log } from '../util/log';
import { BYTES_PER_SAMPLE } from './format';
import { StreamPlayer, StreamPlayerOptions, StreamSpec, StreamStatus } from './stream-player';

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
// Ramp applied to whatever is playing just before a cued file takes over, so
// the cut onto the second doesn't click (only without a crossfade).
const CUE_FADE_MS = 8;

/** A file decoding ahead of its start time (see `FilePlayer.cue`). */
interface Cue {
  file: string;
  startAtMs: number;
  proc: ChildProcessWithoutNullStreams | null;
  chunks: Buffer[];
}

/** The file that was playing when another one took over: it plays on, fading
 *  out under the new one (see `FilePlayer` crossfade). */
interface Tail {
  proc: ChildProcessWithoutNullStreams | null;
  stream: StreamPlayer | null;
  chunks: Buffer[];
  buf: Buffer;
  total: number; // ramp length (samples)
  remaining: number; // samples left of the ramp
}

/**
 * Decodes a local audio file to 48 kHz stereo float via ffmpeg and exposes it
 * one DSP block at a time through `read()`, mirroring the capture/encoder
 * ffmpeg pattern. The decoded stream feeds the graph's music path, so it gets
 * the same loudness normalization and ducking as a real music input.
 *
 * A file can also be **cued** for an exact start time (`cue()`): it decodes
 * ahead and takes over from whatever is playing on the sample that carries
 * that time — this is what lets a scheduled jingle air on the second instead
 * of "when the decoder got going".
 *
 * A **network stream** plays the same way (`play()` with a token that
 * `setStreams` knows, see `StreamPlayer`): it never ends by itself, and it
 * says 'streamLost' / 'streamBack' when its audio drops out and returns, and
 * 'streamEnd' when it is stopped.
 *
 * With a **crossfade** (`crossfadeMs` > 0) a file that takes over — a cue on
 * its second, or `play()` while something plays — doesn't cut the old one
 * off: the old one plays on as the *tail*, fading out over the crossfade
 * while the new one starts as it would have. `read()` returns the tail
 * separately when asked (the graph keeps the old item's leveler gain on it),
 * else mixed in.
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
  // Where in the file playback started (s), for a resumed loop.
  private startSec = 0;
  // A loop that started mid-file: once the decoder of the rest of the file
  // ends, the endless loop from the top takes over (see `play`).
  private loopFile: string | null = null;
  // Total file duration in seconds, probed async via ffprobe; null until known
  // (or if ffprobe is unavailable / the probe fails).
  private durationSec: number | null = null;
  // Jitter-buffer state: true while filling the prebuffer before playout.
  private buffering = false;
  // Fade-in ramp remaining (samples) once playout begins.
  private fadeInRemaining = 0;
  private readonly prebufferBytes: number;
  // Length of the fade-in ramp of the current playback (samples).
  private fadeInSamples: number;
  private readonly defaultFadeIn: number;
  private readonly cueFadeSamples: number;
  // A file decoding ahead of its start time, or null.
  private pending: Cue | null = null;
  // Network streams: which `play()` names are streams, and the one playing.
  private streamLookup: ((file: string) => StreamSpec | null) | null = null;
  private streamOpts: StreamPlayerOptions = {};
  private stream: StreamPlayer | null = null;
  // The file fading out under the one that took over, or null.
  private tail: Tail | null = null;
  private readonly xfadeSamples: number;
  private tailL = new Float32Array(0);
  private tailR = new Float32Array(0);

  constructor(
    private sampleRate: number,
    private log: Log,
    prebufferMs: number = DEFAULT_PREBUFFER_MS,
    crossfadeMs = 0
  ) {
    super();
    const preMs =
      Number.isFinite(prebufferMs) && prebufferMs >= 0 ? prebufferMs : DEFAULT_PREBUFFER_MS;
    this.prebufferBytes = Math.ceil((sampleRate * preMs) / 1000) * FRAME_BYTES;
    this.defaultFadeIn = Math.max(1, Math.ceil((sampleRate * FADE_IN_MS) / 1000));
    this.fadeInSamples = this.defaultFadeIn;
    this.cueFadeSamples = Math.max(1, Math.ceil((sampleRate * CUE_FADE_MS) / 1000));
    this.xfadeSamples =
      Number.isFinite(crossfadeMs) && crossfadeMs > 0
        ? Math.ceil((sampleRate * crossfadeMs) / 1000)
        : 0;
  }

  /** Let `play()` take stream tokens (see `FileDirs.resolve`). */
  setStreams(lookup: (file: string) => StreamSpec | null, opts: StreamPlayerOptions = {}): void {
    this.streamLookup = lookup;
    this.streamOpts = opts;
  }

  /** The playing stream's state, or null when no stream plays. */
  get streamStatus(): StreamStatus | null {
    return this.stream ? this.stream.status() : null;
  }

  /** The file cued for a timed start and its start time, or null. */
  get cued(): { file: string; startAtMs: number } | null {
    return this.pending ? { file: this.pending.file, startAtMs: this.pending.startAtMs } : null;
  }

  /** Absolute path of the file currently playing, or null when idle. */
  get playing(): string | null {
    return this.current;
  }

  /** Elapsed playback position in seconds (real audio delivered so far),
   *  counted from the start of the file (a resumed loop starts mid-file and
   *  goes on counting past its end). */
  get position(): number {
    return this.startSec + this.playedFrames / this.sampleRate;
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

  /**
   * Start playing `file` (absolute path), replacing any current playback
   * (which fades out under it with a crossfade). `loop` repeats it without a
   * gap until stopped (an audio bed); `fadeInMs` replaces the short
   * anti-click ramp with a real fade-in; `startSec` starts that far into the
   * file (a bed resuming where it was switched off).
   */
  play(file: string, opts: { loop?: boolean; fadeInMs?: number; startSec?: number } = {}): void {
    this.handOff();
    this.fadeTotal = 0;
    this.fadeRemaining = 0;
    this.playedFrames = 0;
    this.durationSec = null;
    this.buffering = true;
    this.fadeInRemaining = 0;
    this.fadeInSamples =
      opts.fadeInMs && opts.fadeInMs > 0
        ? Math.ceil((this.sampleRate * opts.fadeInMs) / 1000)
        : this.defaultFadeIn;
    this.current = file;
    const spec = this.streamLookup?.(file) ?? null;
    if (spec) {
      // The stream buffers and fades by itself.
      this.buffering = false;
      const st = new StreamPlayer(spec, this.sampleRate, this.log, this.streamOpts);
      st.on('lost', () => this.emit('streamLost'));
      st.on('back', () => this.emit('streamBack'));
      this.stream = st;
      st.start();
      return;
    }
    this.probeDuration(file);
    const at = Number.isFinite(opts.startSec) && opts.startSec! > 0 ? opts.startSec! : 0;
    this.startSec = at;
    if (opts.loop && at > 0) {
      // ffmpeg's -ss with -stream_loop skips into the second pass as well, so
      // the rest of the file plays once, then the loop from the top follows
      // (spawned when this decoder ends; the jitter buffer covers the seam).
      this.loopFile = file;
      this.proc = this.spawnDecoder(file, false, at);
    } else {
      this.proc = this.spawnDecoder(file, !!opts.loop, at);
    }
  }

  /** Spawn the ffmpeg decode of `file`. Its output lands in the playing queue
   *  or in the cue, whichever the process belongs to when the data arrives. */
  private spawnDecoder(file: string, loop = false, startSec = 0): ChildProcessWithoutNullStreams {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      // Loop the input endlessly (decoder-side, so there is no gap at the seam).
      ...(loop ? ['-stream_loop', '-1'] : []),
      ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
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
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc === proc) this.queue.push(chunk);
      else if (this.pending?.proc === proc) this.pending.chunks.push(chunk);
      else if (this.tail?.proc === proc) this.tail.chunks.push(chunk);
    });
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error('file player ffmpeg:', s);
    });
    proc.on('error', (err) => this.log.error('file player spawn error:', err.message));
    proc.on('close', () => {
      // Decode finished; remaining audio still drains via read(). A resumed
      // loop goes on from the top of the file.
      if (this.proc === proc) {
        this.proc = null;
        if (this.loopFile === file && this.current === file) {
          this.loopFile = null;
          this.proc = this.spawnDecoder(file, true);
        }
      } else if (this.pending?.proc === proc) this.pending.proc = null;
      else if (this.tail?.proc === proc) this.tail.proc = null;
    });
    return proc;
  }

  /**
   * Cue `file` to start at `startAtMs` on the clock `read()` is called with.
   * Decoding starts now, so the audio is ready; playback switches over inside
   * the block that carries the start time; whatever is playing then fades out
   * under it (crossfade) or is cut off (no 'ended' for it — same as `play()`). A later `cue()` replaces an
   * earlier one; `play()` and `stop()` leave a cue alone, so an operator
   * click before the second can't cancel a scheduled item.
   */
  cue(file: string, startAtMs: number): void {
    this.cancelCue();
    const cue: Cue = { file, startAtMs, proc: null, chunks: [] };
    this.pending = cue;
    cue.proc = this.spawnDecoder(file);
  }

  /** Drop a cued file that hasn't started yet. */
  cancelCue(): void {
    const c = this.pending;
    this.pending = null;
    c?.proc?.kill('SIGKILL');
  }

  /** Move what is playing to the tail, where it fades out under the file that
   *  takes over; without a crossfade (or with nothing audible yet) just stop. */
  private handOff(): void {
    this.dropTail();
    const audible =
      this.current !== null &&
      !this.buffering &&
      (this.proc !== null ||
        this.stream !== null ||
        this.queue.length > 0 ||
        this.leftover.length >= FRAME_BYTES);
    if (this.xfadeSamples > 0 && audible) {
      // An operator fade in progress goes on from where it is.
      const g = this.fadeTotal > 0 ? this.fadeRemaining / this.fadeTotal : 1;
      const st = this.stream;
      if (st) {
        st.removeAllListeners('lost');
        st.removeAllListeners('back');
      }
      this.tail = {
        proc: this.proc,
        stream: st,
        chunks: this.queue,
        buf: this.leftover,
        total: this.xfadeSamples,
        remaining: Math.round(this.xfadeSamples * g),
      };
      this.proc = null;
      this.stream = null;
      this.queue = [];
      this.leftover = Buffer.alloc(0);
      if (st) this.emit('streamEnd');
    }
    this.stop();
  }

  /** Stop the tail at once. */
  private dropTail(): void {
    const t = this.tail;
    this.tail = null;
    t?.proc?.kill('SIGKILL');
    t?.stream?.stop();
  }

  /** Fill `outL`/`outR` with the tail's next samples, faded (silence when
   *  there is no tail). The tail ends with its ramp. */
  private readTail(outL: Float32Array, outR: Float32Array, frames: number): void {
    const t = this.tail;
    if (!t) {
      outL.fill(0, 0, frames);
      outR.fill(0, 0, frames);
      return;
    }
    if (t.stream) {
      t.stream.read(outL, outR, frames);
    } else {
      if (t.chunks.length) {
        t.buf = Buffer.concat([t.buf, ...t.chunks]);
        t.chunks = [];
      }
      const have = Math.min(frames, Math.floor(t.buf.length / FRAME_BYTES));
      for (let n = 0; n < frames; n++) {
        outL[n] = n < have ? t.buf.readFloatLE(n * FRAME_BYTES) : 0;
        outR[n] = n < have ? t.buf.readFloatLE(n * FRAME_BYTES + BYTES_PER_SAMPLE) : 0;
      }
      t.buf = t.buf.subarray(have * FRAME_BYTES);
    }
    for (let n = 0; n < frames; n++) {
      const g = t.remaining > 0 ? t.remaining / t.total : 0;
      outL[n] *= g;
      outR[n] *= g;
      if (t.remaining > 0) t.remaining--;
    }
    if (t.remaining <= 0) this.dropTail();
  }

  /** Whether a file is fading out under the playing one. */
  get fadingOut(): boolean {
    return this.tail !== null;
  }

  /** Make the cued file the playing one (its decoder keeps running). */
  private adoptCue(): void {
    const c = this.pending!;
    this.pending = null;
    this.handOff();
    this.fadeInSamples = this.defaultFadeIn;
    this.current = c.file;
    this.proc = c.proc;
    this.queue = c.chunks;
    // Normally a second or two is decoded by now; if not (slow share, late
    // cue) fall back to the ordinary prebuffer instead of stuttering.
    const have = c.chunks.reduce((n, b) => n + b.length, 0);
    this.buffering = have < this.prebufferBytes && c.proc !== null;
    this.probeDuration(c.file);
  }

  /**
   * Fill `outL`/`outR` with the next `frames` samples, zero-padding when no
   * audio is available. Emits 'ended' once the decoder has exited and the
   * buffered audio is exhausted.
   *
   * `blockTimeMs` is the time of the block's first sample on the caller's
   * clock (the on-air time in live mode); a cued file starts on the sample
   * that carries its start time. Defaults to the wall clock.
   *
   * With `tailL`/`tailR` the file fading out under the playing one (the
   * crossfade tail) goes there, the old file's samples before a cue's start
   * included, so `outL`/`outR` hold only the playing item; without them the
   * tail is mixed into `outL`/`outR`.
   */
  read(
    outL: Float32Array,
    outR: Float32Array,
    frames: number,
    blockTimeMs?: number,
    tailL?: Float32Array,
    tailR?: Float32Array
  ): void {
    const split = !!tailL && !!tailR;
    if (!split && this.tailL.length < frames) {
      this.tailL = new Float32Array(frames);
      this.tailR = new Float32Array(frames);
    }
    const tl = split ? tailL : this.tailL;
    const tr = split ? tailR! : this.tailR;
    this.readBlock(outL, outR, tl, tr, frames, blockTimeMs);
    if (!split) {
      for (let i = 0; i < frames; i++) {
        outL[i] += tl[i];
        outR[i] += tr[i];
      }
    }
  }

  private readBlock(
    outL: Float32Array,
    outR: Float32Array,
    tl: Float32Array,
    tr: Float32Array,
    frames: number,
    blockTimeMs?: number
  ): void {
    if (this.pending) {
      const t = blockTimeMs ?? Date.now();
      const at = Math.round(((this.pending.startAtMs - t) * this.sampleRate) / 1000);
      if (at < frames) {
        // The start falls into this block (or is already past): the old
        // playback gets the samples before it, the cue the rest; with a
        // crossfade the old one goes on in the tail, else it is cut.
        const k = Math.max(0, at);
        if (k > 0) {
          this.readTail(tl.subarray(0, k), tr.subarray(0, k), k);
          this.readCurrent(outL.subarray(0, k), outR.subarray(0, k), k);
          if (this.xfadeSamples > 0) {
            for (let i = 0; i < k; i++) {
              tl[i] += outL[i];
              tr[i] += outR[i];
              outL[i] = 0;
              outR[i] = 0;
            }
          } else {
            const fade = Math.min(k, this.cueFadeSamples);
            for (let i = 0; i < fade; i++) {
              const g = (fade - 1 - i) / fade;
              outL[k - fade + i] *= g;
              outR[k - fade + i] *= g;
            }
          }
        }
        this.adoptCue();
        this.readCurrent(outL.subarray(k), outR.subarray(k), frames - k);
        this.readTail(tl.subarray(k), tr.subarray(k), frames - k);
        return;
      }
    }
    this.readCurrent(outL, outR, frames);
    this.readTail(tl, tr, frames);
  }

  private readCurrent(outL: Float32Array, outR: Float32Array, frames: number): void {
    if (this.stream) {
      this.stream.read(outL, outR, frames);
      this.playedFrames += frames;
      this.applyFadeOut(outL, outR, frames);
      return;
    }
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

    if (this.applyFadeOut(outL, outR, frames)) return;

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

  /** Apply the smooth fade-out ramp (linear to silence) while stopping.
   *  True once it has completed: playback is stopped and 'ended' said. */
  private applyFadeOut(outL: Float32Array, outR: Float32Array, frames: number): boolean {
    if (this.fadeTotal <= 0) return false;
    for (let n = 0; n < frames; n++) {
      const g = this.fadeRemaining > 0 ? this.fadeRemaining / this.fadeTotal : 0;
      outL[n] *= g;
      outR[n] *= g;
      if (this.fadeRemaining > 0) this.fadeRemaining--;
    }
    if (this.fadeRemaining > 0) return false;
    // Ramp complete: hard-stop and report end of playback.
    const finished = this.current;
    this.stop();
    if (finished) {
      this.log.info('file player: faded out', finished);
      this.emit('ended');
    }
    return true;
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

  /** Stop playback and discard any buffered audio. A cued file is kept (it
   *  still starts at its time); `shutdown()` drops that too. */
  stop(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
      this.proc = null;
    }
    if (this.stream) {
      this.stream.stop();
      this.stream = null;
      this.emit('streamEnd');
    }
    this.queue = [];
    this.leftover = Buffer.alloc(0);
    this.current = null;
    this.loopFile = null;
    this.startSec = 0;
    this.fadeTotal = 0;
    this.fadeRemaining = 0;
    this.playedFrames = 0;
    this.durationSec = null;
    this.buffering = false;
    this.fadeInRemaining = 0;
  }

  /** Stop everything, including a cued file and a fading tail (service
   *  shutdown). */
  shutdown(): void {
    this.cancelCue();
    this.dropTail();
    this.stop();
  }

  /** Probe the file's duration via ffprobe and cache it. Best-effort: on any
   *  failure (ffprobe missing, unreadable metadata) the duration stays null and
   *  the UI simply shows elapsed time instead of remaining. The result is
   *  ignored if playback has since moved on to another file. */
  private probeDuration(file: string): void {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
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

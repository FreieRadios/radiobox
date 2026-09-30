import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CaptureConfig, MonitorConfig } from '../config/schema';
import { Log } from '../util/log';
import { BYTES_PER_SAMPLE, widenStereo } from './format';

/** aplay's own default device buffer, in ms. */
const APLAY_BUFFER_MS = 500;
/** A Linux pipe holds 64 KiB; a pull-driven writer keeps it full. */
const PIPE_BYTES = 65536;

/**
 * Time from handing a block to the output process until it is heard, in ms.
 * `latencyMs` in the config wins (calibrate it in the rehearsal); otherwise an
 * estimate from the buffers in the way:
 *  - `pull` (the producer waits for 'drain', so the pipe into the process is
 *    always full): device buffer + pipe;
 *  - `push` (blocks are written as they are captured, the pipe stays nearly
 *    empty): the device buffer alone.
 */
export function outputLatencyMs(
  m: MonitorConfig,
  sampleRate: number,
  mode: 'pull' | 'push'
): number {
  if (m.latencyMs !== undefined) return m.latencyMs;
  const device = m.backend === 'alsa' ? (m.bufferMs ?? APLAY_BUFFER_MS) : 200;
  if (mode === 'push') return device;
  const frameBytes = Math.max(2, m.channels ?? 2) * BYTES_PER_SAMPLE;
  return device + (PIPE_BYTES / frameBytes / sampleRate) * 1000;
}

/**
 * Plays the finished stereo float stream out of a locally plugged audio device
 * (a sound card / USB interface such as a Focusrite Scarlett) for direct local
 * playout or monitoring. Runs in its own process so it can be toggled live from
 * the meters page without disturbing the harbor encoder or the FLAC backup.
 *
 * ALSA uses `aplay` rather than ffmpeg's ALSA output: it opens the device
 * directly and reliably, mirroring why `Capture` uses `arecord` (ffmpeg's ALSA
 * layer mis-negotiates some USB device configurations). PulseAudio/PipeWire
 * goes through ffmpeg, matching the capture pulse path.
 *
 * Events: 'exit' (code). The pipeline restarts the monitor on unexpected exit
 * (e.g. device unplugged) while it is armed.
 */
/** Blocks `writeThen` hands over back to back before yielding to the event
 *  loop: enough to refill an empty pipe (8 stereo blocks of 1024 frames). */
const MAX_BURST = 8;

export class Monitor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private burst = 0;

  constructor(
    private monitor: MonitorConfig,
    private capture: CaptureConfig,
    private log: Log
  ) {
    super();
  }

  /** True while the playout process is running. */
  get active(): boolean {
    return this.proc !== null;
  }

  /** Channels the device is opened with (the programme uses the first two). */
  private get channels(): number {
    return Math.max(2, this.monitor.channels ?? 2);
  }

  private command(): { bin: string; args: string[] } {
    const rate = String(this.capture.sampleRate);
    if (this.monitor.backend === 'alsa') {
      // aplay reads raw f32le from stdin and plays it to the device, symmetric
      // with Capture's use of arecord.
      const args = [
        '-D',
        this.monitor.device,
        '-f',
        'FLOAT_LE',
        '-r',
        rate,
        '-c',
        String(this.channels),
        '-t',
        'raw',
        '-q',
      ];
      // A shorter device buffer than aplay's ~500 ms default: less latency on
      // an output the room listens to. Only passed when configured.
      if (this.monitor.bufferMs) {
        args.push('--buffer-time', String(Math.round(this.monitor.bufferMs * 1000)));
      }
      if (this.monitor.periodMs) {
        args.push('--period-time', String(Math.round(this.monitor.periodMs * 1000)));
      }
      args.push('-'); // stdin
      return { bin: 'aplay', args };
    }
    // PulseAudio/PipeWire via ffmpeg. Input options precede -i; the output is
    // the named pulse sink (empty string selects the default sink).
    return {
      bin: 'ffmpeg',
      args: [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'f32le',
        '-ar',
        rate,
        '-ac',
        String(this.channels),
        '-i',
        'pipe:0',
        '-f',
        'pulse',
        this.monitor.device || 'studiobox',
      ],
    };
  }

  /** Start (or restart) the playout process. No-op if already active. */
  start(): void {
    if (!this.monitor.enabled || this.proc) return;
    const { bin, args } = this.command();
    this.log.info('monitor playout:', bin, args.join(' '));
    const proc = spawn(bin, args);
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) this.log.error(`monitor ${bin}:`, s);
    });
    // If the process dies (e.g. the device is missing/unplugged), the next
    // write races the 'close' event and the pipe emits EPIPE on stdin. Without
    // a listener that 'error' is thrown and crashes the whole service; swallow
    // it and let 'close' -> 'exit' drive the restart instead.
    proc.stdin.on('error', (err) => this.log.warn(`monitor ${bin} stdin:`, err.message));
    proc.on('error', (err) => this.log.error('monitor spawn error:', err.message));
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null;
      this.emit('exit', code);
    });
  }

  /** Feed one stereo block. Returns false when not playing or on backpressure. */
  write(buf: Buffer): boolean {
    if (!this.proc || !this.proc.stdin.writable) return false;
    return this.proc.stdin.write(widenStereo(buf, this.channels));
  }

  /**
   * Feed one stereo block and invoke `cb` once the playout process's pipe has
   * taken it — the pull side of a buffer in front of the sound card. Unlike
   * `write()` + `waitWritable()`, nothing queues up inside Node: the only
   * audio between the caller and the device is the (full) pipe and the device
   * buffer, which makes the latency behind the caller a known constant
   * (`outputLatencyMs(…, 'pull')`). `cb` fires exactly once: a watchdog
   * covers a process that dies mid-write, and with no process at all it
   * fires after `idleMs`, so the caller's loop keeps turning.
   */
  writeThen(buf: Buffer, cb: () => void, timeoutMs = 1000, idleMs = 100): void {
    const stdin = this.proc?.stdin;
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      cb();
    };
    const usable = !!stdin && stdin.writable;
    const watchdog = setTimeout(fire, usable ? timeoutMs : Math.min(timeoutMs, idleMs));
    watchdog.unref?.();
    // The write callback runs when the chunk has been handed to the kernel,
    // i.e. when the pipe had room for it — and also (with an error) when the
    // stream is torn down, which the 'error' listener already reports.
    // While the pipe has room the next block follows at once, so after the
    // process was held up the whole pipe (and with it the device buffer) is
    // refilled in one go instead of one block per event-loop turn; every few
    // blocks the loop gets its turn, so an output that swallows data faster
    // than real time can't monopolize it.
    if (usable) {
      stdin.write(widenStereo(buf, this.channels), () => {
        if (++this.burst < MAX_BURST) fire();
        else {
          this.burst = 0;
          setImmediate(fire);
        }
      });
    }
  }

  /** Bytes written but not yet taken by the playout process (0 when idle).
   *  A push-driven writer checks this to skip blocks instead of piling them
   *  up behind a stalled device. */
  get backlogBytes(): number {
    return this.proc?.stdin.writableLength ?? 0;
  }

  /**
   * Invoke `cb` once the playout process is ready for the next block. While
   * backpressured this waits for stdin's 'drain', which makes the sound card
   * itself the pacing clock for a pull-driven producer (the playout-only
   * pipeline). A watchdog timeout keeps the producer loop alive when the
   * process dies mid-wait or no process is running at all — `cb` always fires
   * exactly once.
   */
  waitWritable(cb: () => void, timeoutMs = 1000): void {
    const stdin = this.proc?.stdin;
    if (stdin && stdin.writable && !stdin.writableNeedDrain) {
      // Not backpressured — yield to the event loop, don't spin synchronously.
      setImmediate(cb);
      return;
    }
    if (stdin && stdin.writable) {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        stdin.removeListener('drain', fire);
        clearTimeout(watchdog);
        cb();
      };
      const watchdog = setTimeout(fire, timeoutMs);
      watchdog.unref?.();
      stdin.once('drain', fire);
      return;
    }
    // No usable process (device unplugged / restarting): retry at roughly
    // block cadence so the producer keeps consuming its upstream (the file
    // player decodes in real time regardless) and playback resumes promptly
    // once the monitor is back.
    const t = setTimeout(cb, Math.min(timeoutMs, 100));
    t.unref?.();
  }

  /** Stop playout, closing the device. */
  stop(): void {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

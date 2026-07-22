import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { CaptureConfig, MonitorConfig } from '../config/schema';
import { Log } from '../util/log';

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
export class Monitor extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;

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

  private command(): { bin: string; args: string[] } {
    const rate = String(this.capture.sampleRate);
    if (this.monitor.backend === 'alsa') {
      // aplay reads raw f32le stereo from stdin and plays it to the device,
      // symmetric with Capture's use of arecord.
      return {
        bin: 'aplay',
        args: [
          '-D',
          this.monitor.device,
          '-f',
          'FLOAT_LE',
          '-r',
          rate,
          '-c',
          '2',
          '-t',
          'raw',
          '-q',
          '-', // stdin
        ],
      };
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
        '2',
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
    return this.proc.stdin.write(buf);
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

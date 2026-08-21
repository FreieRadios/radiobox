import * as path from 'node:path';
import { StudioboxConfig } from './config/schema';
import { Monitor } from './audio/monitor';
import { FilePlayer } from './audio/file-player';
import { FileDirs } from './audio/file-dirs';
import { interleaveStereo } from './audio/format';
import { MeterSnapshot } from './dsp/graph';
import { MeterServer } from './meters/server';
import { Scheduler } from './schedule';
import { makeLog } from './util/log';

const log = makeLog('playout');

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Playout-only pipeline (`mode: playout`): no capture, no DSP graph, no
 * encoder/recorder. The file player decodes straight into the local hardware
 * output, the web UI shows the file list plus playback state (no metering),
 * and the filename-timestamp scheduler starts files automatically.
 *
 * Pacing: the pump is pull-driven by the monitor process — each block is
 * written to aplay/ffmpeg stdin and the next one is produced when the stream
 * drains, so the sound card clocks playback. When idle the pump emits
 * silence, keeping the device open and the clock running (a scheduled start
 * is then at most one block away). CPU cost is a couple of buffer copies per
 * ~85 ms block; memory stays at the node baseline — this is the
 * whole point of the mode on a thermally constrained Pi.
 */
export class PlayoutPipeline {
  private monitor: Monitor;
  private filePlayer: FilePlayer;
  private fileDirs: FileDirs;
  private meters: MeterServer | null;
  private scheduler: Scheduler | null;
  private outL: Float32Array;
  private outR: Float32Array;
  private metersTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private monitorArmed = false;

  constructor(private cfg: StudioboxConfig) {
    if (!cfg.filePlayer?.enabled) {
      throw new Error('mode "playout" requires filePlayer.enabled');
    }
    this.filePlayer = new FilePlayer(
      cfg.capture.sampleRate,
      makeLog('fileplayer'),
      cfg.filePlayer.prebufferMs
    );
    this.fileDirs = new FileDirs(cfg.filePlayer.dirs, log);
    this.monitor = new Monitor(cfg.output.monitor, cfg.capture, makeLog('monitor'));
    this.meters = cfg.meters.enabled ? new MeterServer(cfg.meters.port, makeLog('meters')) : null;
    this.meters?.onCommand((cmd) => this.onCommand(cmd.type, cmd.value));
    this.meters?.onListFolders(() => this.fileDirs.folders());
    this.meters?.onListFiles((folder, sub) => this.fileDirs.list(folder, sub));
    this.meters?.onListScheduled(() => this.scheduler?.upcoming() ?? []);
    this.meters?.onResolveFile((folder, name) => this.fileDirs.resolve(folder, name));
    this.scheduler = cfg.filePlayer.autoPlay.enabled
      ? new Scheduler(
          cfg.filePlayer.autoPlay,
          () => this.fileDirs.scheduled(),
          (e) => this.playScheduled(e.folder, e.name),
          log
        )
      : null;
    this.outL = new Float32Array(cfg.capture.blockSize);
    this.outR = new Float32Array(cfg.capture.blockSize);
  }

  private playScheduled(folder: number, name: string): void {
    const resolved = this.fileDirs.resolve(folder, name);
    if (!resolved) {
      log.warn(`scheduled file vanished before start: ${name}`);
      return;
    }
    this.filePlayer.play(resolved);
  }

  /** Handle a control message from the web UI. */
  private onCommand(type: string, value: unknown): void {
    if (type === 'playFile') {
      const req = isObj(value) ? value : {};
      const folder = Number((req as { folder?: unknown }).folder ?? 0);
      const name = String((req as { name?: unknown }).name ?? '');
      const resolved = this.fileDirs.resolve(folder, name);
      if (!resolved) {
        log.warn(`rejected file request: folder ${folder} / ${name}`);
        return;
      }
      log.info(`playing file: ${path.basename(resolved)}`);
      this.filePlayer.play(resolved);
    } else if (type === 'stopFile') {
      const fadeMs = this.cfg.filePlayer?.fadeOutMs ?? 0;
      log.info(`stopping file playback${fadeMs > 0 ? ` (fade ${fadeMs}ms)` : ''}`);
      this.filePlayer.fadeOut(fadeMs);
    }
    // recording / streaming / mute / monitor commands don't exist in playout
    // mode; the UI hides those controls (their snapshot state is null /
    // channels empty). Monitor in particular: it is the *only* output here,
    // so a stop control would just be a way to silence the station.
  }

  /** UI snapshot: playback + schedule state, no metering (channels: []). */
  private snapshot(): MeterSnapshot {
    const playing = this.filePlayer.playing;
    const next = this.scheduler?.next() ?? null;
    return {
      channels: [],
      duckDepthDb: 0,
      limiterGrDb: 0,
      momentaryLufs: -Infinity,
      shortTermLufs: -Infinity,
      outPeakDb: -Infinity,
      micsMuted: false,
      filePlaying: playing ? path.basename(playing) : null,
      filePosition: playing ? this.filePlayer.position : null,
      fileDuration: playing ? this.filePlayer.duration : null,
      recording: null,
      streaming: null,
      // Deliberately not exposed as a toggle: in playout-only mode the
      // monitor *is* the program output.
      monitor: null,
      nextScheduled: next ? { name: next.name, playAtMs: next.playAtMs } : null,
      serverNowMs: Date.now(),
    };
  }

  /** Produce one block (file audio or silence) and hand it to the monitor;
   *  re-armed by the monitor's drain so the sound card paces the loop. */
  private pump = (): void => {
    if (this.stopping) return;
    const frames = this.cfg.capture.blockSize;
    this.filePlayer.read(this.outL, this.outR, frames);
    this.monitor.write(interleaveStereo(this.outL, this.outR, frames));
    // Watchdog a little above the block duration: long enough to normally be
    // beaten by 'drain', short enough to keep near-real-time consumption when
    // the device is gone.
    const blockMs = (frames / this.cfg.capture.sampleRate) * 1000;
    this.monitor.waitWritable(this.pump, Math.ceil(blockMs * 4));
  };

  start(): void {
    log.info(
      `starting playout-only: ${this.cfg.filePlayer!.dirs.map((d) => d.label).join(', ')} ` +
        `-> ${this.cfg.output.monitor.backend}:${this.cfg.output.monitor.device}`
    );
    this.monitorArmed = true;
    this.monitor.start();
    this.monitor.on('exit', (code) => {
      if (this.stopping || !this.monitorArmed) return;
      log.warn(`monitor exited (code ${code}); restarting in 1s`);
      setTimeout(() => {
        if (this.stopping || !this.monitorArmed) return;
        this.monitor.start();
      }, 1000);
    });
    this.pump();
    this.scheduler?.start();

    if (this.meters) {
      this.meters.start();
      const interval = Math.max(1, Math.round(1000 / this.cfg.meters.fps));
      this.metersTimer = setInterval(() => this.meters!.broadcast(this.snapshot()), interval);
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.metersTimer) clearInterval(this.metersTimer);
    this.scheduler?.stop();
    this.meters?.stop();
    this.filePlayer.stop();
    this.monitor.stop();
    log.info('stopped');
  }
}

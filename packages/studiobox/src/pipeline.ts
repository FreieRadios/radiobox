import * as fs from 'node:fs';
import * as path from 'node:path';
import { StudioboxConfig } from './config/schema';
import { Capture } from './audio/capture';
import { Encoder } from './audio/encoder';
import { Recorder } from './audio/recorder';
import { Monitor } from './audio/monitor';
import { FilePlayer, AUDIO_EXTENSIONS } from './audio/file-player';
import { interleaveStereo } from './audio/format';
import { Graph } from './dsp/graph';
import { MeterServer } from './meters/server';
import { makeLog } from './util/log';

const log = makeLog('pipeline');

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Owns the live audio path: Capture -> Graph -> Encoder, plus meter pushing
 *  and encoder auto-restart on harbor/connection drops. */
export class Pipeline {
  private capture: Capture;
  private encoder: Encoder;
  private recorder: Recorder | null;
  private monitor: Monitor | null;
  private graph: Graph;
  private meters: MeterServer | null;
  private filePlayer: FilePlayer | null;
  private outL: Float32Array;
  private outR: Float32Array;
  private fileL: Float32Array;
  private fileR: Float32Array;
  private metersTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  // Whether recording should be running (used to auto-restart after ffmpeg
  // segment rolls / crashes, but not after a deliberate stop).
  private recordingArmed = false;
  // Whether harbor streaming should be running (used to auto-restart after a
  // harbor connection drop, but not after a deliberate stop).
  private harborArmed = false;
  // Whether local hardware playout should be running (used to auto-restart
  // after a device drop, but not after a deliberate stop).
  private monitorArmed = false;

  constructor(private cfg: StudioboxConfig) {
    this.graph = new Graph(cfg);
    this.capture = new Capture(cfg.capture, makeLog('capture'));
    this.encoder = new Encoder(cfg.output, cfg.capture, makeLog('encoder'));
    this.recorder = cfg.output.backup.enabled
      ? new Recorder(cfg.output.backup, cfg.capture, makeLog('recorder'))
      : null;
    this.monitor = cfg.output.monitor.enabled
      ? new Monitor(cfg.output.monitor, cfg.capture, makeLog('monitor'))
      : null;
    this.filePlayer = cfg.filePlayer?.enabled
      ? new FilePlayer(cfg.capture.sampleRate, makeLog('fileplayer'), cfg.filePlayer.prebufferMs)
      : null;
    this.meters = cfg.meters.enabled ? new MeterServer(cfg.meters.port, makeLog('meters')) : null;
    this.meters?.onCommand((cmd) => this.onCommand(cmd.type, cmd.value));
    this.meters?.onListFolders(() => this.listFolders());
    this.meters?.onListFiles((folder) => this.listFiles(folder));
    this.outL = new Float32Array(cfg.capture.blockSize);
    this.outR = new Float32Array(cfg.capture.blockSize);
    this.fileL = new Float32Array(cfg.capture.blockSize);
    this.fileR = new Float32Array(cfg.capture.blockSize);
  }

  /** Handle a control message from the meters page. */
  private onCommand(type: string, value: unknown): void {
    if (type === 'micsMuted') {
      const muted = !!value;
      this.graph.setMicsMuted(muted);
      log.info(`mics ${muted ? 'muted (music only)' : 'unmuted'}`);
    } else if (type === 'channelMuted') {
      const req = isObj(value) ? value : {};
      const label = String((req as { label?: unknown }).label ?? '');
      const muted = !!(req as { muted?: unknown }).muted;
      if (label) {
        this.graph.setChannelMuted(label, muted);
        log.info(`channel ${label} ${muted ? 'muted' : 'unmuted'}`);
      }
    } else if (type === 'recording' && this.recorder) {
      this.recordingArmed = !!value;
      if (this.recordingArmed) this.recorder.start();
      else this.recorder.stop();
      this.graph.setRecording(this.recorder.active);
      log.info(`recording ${this.recorder.active ? 'started' : 'stopped'}`);
    } else if (type === 'streaming' && this.cfg.output.harbor.enabled) {
      this.harborArmed = !!value;
      if (this.harborArmed) this.encoder.start();
      else this.encoder.stop();
      this.graph.setStreaming(this.encoder.active);
      log.info(`harbor streaming ${this.encoder.active ? 'started' : 'stopped'}`);
    } else if (type === 'monitor' && this.monitor) {
      this.monitorArmed = !!value;
      if (this.monitorArmed) this.monitor.start();
      else this.monitor.stop();
      this.graph.setMonitor(this.monitor.active);
      log.info(`local playout ${this.monitor.active ? 'started' : 'stopped'}`);
    } else if (type === 'playFile' && this.filePlayer) {
      const req = isObj(value) ? value : {};
      const folder = Number((req as { folder?: unknown }).folder ?? 0);
      const name = String((req as { name?: unknown }).name ?? '');
      const resolved = this.resolveFile(folder, name);
      if (!resolved) {
        log.warn(`rejected file request: folder ${folder} / ${name}`);
        return;
      }
      log.info(`playing file: ${path.basename(resolved)}`);
      this.filePlayer.play(resolved);
    } else if (type === 'stopFile' && this.filePlayer) {
      const fadeMs = this.cfg.filePlayer?.fadeOutMs ?? 0;
      log.info(`stopping file playback${fadeMs > 0 ? ` (fade ${fadeMs}ms)` : ''}`);
      this.filePlayer.fadeOut(fadeMs);
    }
  }

  /** Absolute path of the configured file-player folder at `index`, or null. */
  private fileRoot(index: number): string | null {
    const dirs = this.cfg.filePlayer?.enabled ? this.cfg.filePlayer.dirs : [];
    const dir = dirs[index];
    return dir ? path.resolve(dir.path) : null;
  }

  /** Labels of the configured browsable folders (dropdown order). */
  private listFolders(): string[] {
    return this.cfg.filePlayer?.enabled ? this.cfg.filePlayer.dirs.map((d) => d.label) : [];
  }

  /** List playable audio files directly inside the folder at `index`. */
  private listFiles(index: number): string[] {
    const root = this.fileRoot(index);
    if (!root) return [];
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      log.warn(`cannot list ${root}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Resolve a requested filename to an absolute path inside the folder at
   *  `index`, rejecting path traversal and disallowed extensions. */
  private resolveFile(index: number, name: string): string | null {
    const root = this.fileRoot(index);
    if (!root || !name) return null;
    const resolved = path.resolve(root, name);
    const rel = path.relative(root, resolved);
    // Reject anything that escapes the root ("..") or is absolute elsewhere.
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!AUDIO_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  }

  start(): void {
    log.info(
      `starting: ${this.cfg.channels.length} channels @ ${this.cfg.capture.sampleRate} Hz, ` +
        `block ${this.cfg.capture.blockSize}`
    );
    // Harbor streaming starts automatically when configured (going live is the
    // primary purpose), but can be toggled live from the meters page. The
    // encoder is a no-op when harbor is disabled, in which case the control is
    // hidden (null state).
    this.harborArmed = this.cfg.output.harbor.enabled;
    this.graph.setStreaming(this.cfg.output.harbor.enabled ? false : null);
    if (this.harborArmed) {
      this.encoder.start();
      this.graph.setStreaming(this.encoder.active);
    }
    this.encoder.on('exit', (code) => {
      if (this.stopping || !this.harborArmed) return;
      log.warn(`encoder exited (code ${code}); restarting in 1s`);
      setTimeout(() => {
        if (this.stopping || !this.harborArmed) return;
        this.encoder.start();
        this.graph.setStreaming(this.encoder.active);
      }, 1000);
    });

    // Recording does not start automatically; it begins only after the
    // operator presses the record button on the meters page. We still report
    // the (inactive) state so the control is shown, and keep recording alive
    // across segment rolls / unexpected ffmpeg exits while armed.
    if (this.recorder) {
      this.recordingArmed = false;
      this.graph.setRecording(false);
      this.recorder.on('exit', (code) => {
        if (this.stopping || !this.recorder || !this.recordingArmed) return;
        log.warn(`recorder exited (code ${code}); restarting in 1s`);
        setTimeout(() => {
          if (this.stopping || !this.recordingArmed) return;
          this.recorder?.start();
          this.graph.setRecording(this.recorder?.active ?? null);
        }, 1000);
      });
    }

    // Local hardware playout starts automatically when configured (it is a
    // primary output, like the harbor), but can be toggled live from the meters
    // page. It is a no-op / hidden control (null state) when not configured.
    this.monitorArmed = this.monitor !== null;
    this.graph.setMonitor(this.monitor ? false : null);
    if (this.monitor) {
      this.monitor.start();
      this.graph.setMonitor(this.monitor.active);
      this.monitor.on('exit', (code) => {
        if (this.stopping || !this.monitorArmed) return;
        log.warn(`monitor exited (code ${code}); restarting in 1s`);
        setTimeout(() => {
          if (this.stopping || !this.monitorArmed) return;
          this.monitor?.start();
          this.graph.setMonitor(this.monitor?.active ?? null);
        }, 1000);
      });
    }

    this.capture.on('block', (input: Float32Array[]) => {
      const frames = this.cfg.capture.blockSize;
      if (this.filePlayer) {
        this.filePlayer.read(this.fileL, this.fileR, frames);
        // Report only the basename: the snapshot field is the file *name* (the
        // meters page shows it and matches it against the file-list rows).
        const playingName = this.filePlayer.playing
          ? path.basename(this.filePlayer.playing)
          : null;
        this.graph.setFileBlock(
          this.fileL,
          this.fileR,
          playingName,
          this.filePlayer.position,
          this.filePlayer.duration
        );
      }
      this.graph.process(input, this.outL, this.outR, frames);
      const out = interleaveStereo(this.outL, this.outR, frames);
      this.encoder.write(out);
      this.recorder?.write(out);
      this.monitor?.write(out);
    });
    this.capture.on('error', (err) => log.error('capture error:', err.message));
    this.capture.on('exit', (code) => {
      if (this.stopping) return;
      log.warn(`capture exited (code ${code}); restarting in 1s`);
      setTimeout(() => this.capture.start(), 1000);
    });
    this.capture.start();

    if (this.meters) {
      this.meters.start();
      const interval = Math.max(1, Math.round(1000 / this.cfg.meters.fps));
      this.metersTimer = setInterval(
        () => this.meters!.broadcast(this.graph.getMeters()),
        interval
      );
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.metersTimer) clearInterval(this.metersTimer);
    this.meters?.stop();
    this.filePlayer?.stop();
    this.capture.stop();
    this.encoder.stop();
    this.recorder?.stop();
    this.monitor?.stop();
    log.info('stopped');
  }
}

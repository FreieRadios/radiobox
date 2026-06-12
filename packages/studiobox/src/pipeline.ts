import { StudioboxConfig } from './config/schema';
import { Capture } from './audio/capture';
import { Encoder } from './audio/encoder';
import { interleaveStereo } from './audio/format';
import { Graph } from './dsp/graph';
import { MeterServer } from './meters/server';
import { makeLog } from './util/log';

const log = makeLog('pipeline');

/** Owns the live audio path: Capture -> Graph -> Encoder, plus meter pushing
 *  and encoder auto-restart on harbor/connection drops. */
export class Pipeline {
  private capture: Capture;
  private encoder: Encoder;
  private graph: Graph;
  private meters: MeterServer | null;
  private outL: Float32Array;
  private outR: Float32Array;
  private metersTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private cfg: StudioboxConfig) {
    this.graph = new Graph(cfg);
    this.capture = new Capture(cfg.capture, makeLog('capture'));
    this.encoder = new Encoder(cfg.output, cfg.capture, makeLog('encoder'));
    this.meters = cfg.meters.enabled ? new MeterServer(cfg.meters.port, makeLog('meters')) : null;
    this.meters?.onCommand((cmd) => {
      if (cmd.type === 'micsMuted') {
        const muted = !!cmd.value;
        this.graph.setMicsMuted(muted);
        log.info(`mics ${muted ? 'muted (music only)' : 'unmuted'}`);
      }
    });
    this.outL = new Float32Array(cfg.capture.blockSize);
    this.outR = new Float32Array(cfg.capture.blockSize);
  }

  start(): void {
    log.info(
      `starting: ${this.cfg.channels.length} channels @ ${this.cfg.capture.sampleRate} Hz, ` +
        `block ${this.cfg.capture.blockSize}`,
    );
    this.encoder.start();
    this.encoder.on('exit', (code) => {
      if (this.stopping) return;
      log.warn(`encoder exited (code ${code}); restarting in 1s`);
      setTimeout(() => this.encoder.start(), 1000);
    });

    this.capture.on('block', (input: Float32Array[]) => {
      const frames = this.cfg.capture.blockSize;
      this.graph.process(input, this.outL, this.outR, frames);
      this.encoder.write(interleaveStereo(this.outL, this.outR, frames));
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
      this.metersTimer = setInterval(() => this.meters!.broadcast(this.graph.getMeters()), interval);
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.metersTimer) clearInterval(this.metersTimer);
    this.meters?.stop();
    this.capture.stop();
    this.encoder.stop();
    log.info('stopped');
  }
}

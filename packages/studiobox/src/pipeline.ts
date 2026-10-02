import * as fs from 'node:fs';
import * as path from 'node:path';
import { IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks';
import { StudioboxConfig } from './config/schema';
import { Capture } from './audio/capture';
import { Encoder } from './audio/encoder';
import { Recorder, stamp } from './audio/recorder';
import { Monitor, outputLatencyMs } from './audio/monitor';
import { FilePlayer } from './audio/file-player';
import { FileDirs } from './audio/file-dirs';
import { QueuePlayer } from './audio/play-queue';
import { BedDeck, BedStatus } from './audio/bed';
import { AirFifo } from './audio/air-fifo';
import { SampleClock } from './audio/sample-clock';
import { BYTES_PER_SAMPLE, interleave, interleaveStereo } from './audio/format';
import { AirStatus, Graph, MeterSnapshot } from './dsp/graph';
import { MeterServer } from './meters/server';
import { ListenerFeed } from './listeners/feed';
import { Scheduler } from './schedule';
import { SetupSession, SetupStatus } from './setup/session';
import { applySettings, settingsOf } from './setup/measure';
import { SessionState, loadState, saveState } from './setup/state';
import { makeLog } from './util/log';

const log = makeLog('pipeline');

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** How far ahead of its on-air time a scheduled file is cued (decode start). */
const CUE_LEAD_MS = 3000;
/** A programme block below this peak may be dropped or repeated unheard when
 *  the air delay is nudged back to its target. */
const QUIET_PEAK = Math.pow(10, -50 / 20);
/** Test tone: 1 kHz at -18 dBFS (EBU R68 alignment level). */
const TONE_HZ = 1000;
const TONE_AMP = Math.pow(10, -18 / 20);
/** Extra wait after the computed end of a drain, so the last block is out. */
const DRAIN_MARGIN_MS = 500;
/** The music return skips blocks once this much audio is stuck behind it. */
const RETURN_BACKLOG_SEC = 0.5;

/** What the live pipeline adds to the graph's meter snapshot. */
export interface LiveStatus {
  air: AirStatus;
  musicReturn: boolean | null;
  /** Switched on but the device keeps failing (missing, unplugged): the
   *  pipeline retries every second. */
  musicReturnFault: boolean;
  /** The same for the local output (`monitor`). */
  monitorFault: boolean;
  multitrack: boolean | null;
  /** Setup assistant ("Einmessen") state. */
  setup: SetupStatus;
  /** True once the assistant's result (or a saved state) is in force. */
  setupApplied: boolean;
  /** Queue mode: 'single' ("einzeln") | 'chain' ("durchlaufen"). */
  queueMode: 'single' | 'chain' | null;
  /** 1 kHz alignment tone on the local output instead of the programme. */
  testTone: boolean;
  /** Audio bed state; null when no bed is configured. */
  bed: BedStatus | null;
}

/** Owns the live audio path:
 *
 *   Capture -> Graph (look-ahead DSP) -> air-delay FIFO -> Monitor / Encoder
 *                 |         '-> recorders (stereo + multitrack)
 *                 '-> music return (room time)
 *
 *  The graph is clocked by the capture card. The FIFO behind it is emptied by
 *  the output card at its own clock (pull), which keeps the programme a fixed
 *  time D behind the room; the measured delay is the on-air clock
 *  ("Sendezeit") every view shows and the scheduler fires on. */
export class Pipeline {
  private capture: Capture;
  private encoder: Encoder;
  private recorder: Recorder | null;
  private multitrack: Recorder | null = null;
  private monitor: Monitor | null;
  private ret: Monitor | null;
  private graph: Graph;
  private meters: MeterServer | null;
  /** Listener feedback from eve for the show on air (see ListenerFeed). */
  private listeners: ListenerFeed | null = null;
  private filePlayer: FilePlayer | null;
  private fileDirs: FileDirs | null;
  private playQueue: QueuePlayer | null;
  private bedPlayer: FilePlayer | null = null;
  private bed: BedDeck | null = null;
  private scheduler: Scheduler | null;
  private setup: SetupSession;
  private setupApplied = false;
  private state: SessionState;
  private outL: Float32Array;
  private outR: Float32Array;
  private retL: Float32Array;
  private retR: Float32Array;
  private fileL: Float32Array;
  private fileR: Float32Array;
  private taps: Float32Array[];
  private silence: Buffer;
  private metersTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  // Whether recording should be running (used to auto-restart after an ffmpeg
  // crash, but not after a deliberate stop).
  private recordingArmed = false;
  // Sample count at which a requested recording stop takes effect: the
  // recorders keep running for the look-ahead, so what was said up to the
  // button press is in the file.
  private recordStopAt: number | null = null;
  // Whether harbor streaming should be running (used to auto-restart after a
  // harbor connection drop, but not after a deliberate stop).
  private harborArmed = false;
  // Whether local hardware playout should be running (used to auto-restart
  // after a device drop, but not after a deliberate stop).
  private monitorArmed = false;
  private returnArmed = false;

  // --- air delay ---
  private clock: SampleClock;
  private fifo: AirFifo;
  private samples = 0; // capture samples processed so far
  private readonly sr: number;
  private readonly blockMs: number;
  private readonly graphLatencyMs: number;
  private readonly captureLatencyMs: number;
  private readonly monitorLatencyMs: number;
  private readonly delayMs: number; // target D, as enforced
  private show: 'live' | 'draining' | 'ended' = 'live';
  private drainEndsMs: number | null = null;
  private testTone = false;
  private tonePhase = 0;
  // Health probe: a stalled event loop starves both sound cards.
  private loopDelay: IntervalHistogram | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private blockMaxMs = 0; // longest single onBlock() since the last report
  private pumpGapMaxMs = 0; // longest pause between two output blocks
  private lastPumpMs = 0;
  private returnDropped = 0;

  constructor(private cfg: StudioboxConfig) {
    const sr = (this.sr = cfg.capture.sampleRate);
    const frames = cfg.capture.blockSize;
    this.blockMs = (frames / sr) * 1000;

    this.ret = cfg.output.return.enabled
      ? new Monitor(cfg.output.return, cfg.capture, makeLog('return'))
      : null;
    // The room hears the music through the return with its latency and talks
    // to what it hears; the programme's music is delayed by the same amount.
    const returnMs = this.ret
      ? outputLatencyMs(cfg.output.return, sr, 'push') + (cfg.capture.latencyMs ?? 20)
      : 0;
    this.graph = new Graph(cfg, { musicDelayMs: returnMs });
    this.capture = new Capture(cfg.capture, makeLog('capture'));
    this.encoder = new Encoder(cfg.output, cfg.capture, makeLog('encoder'));
    this.recorder = cfg.output.backup.enabled
      ? new Recorder(cfg.output.backup, cfg.capture, makeLog('recorder'))
      : null;
    const layout = this.graph.tapLayout;
    if (this.recorder && layout) {
      this.multitrack = new Recorder(cfg.output.backup, cfg.capture, makeLog('multitrack'), {
        channels: layout.length,
        suffix: '.multitrack',
      });
    }
    this.monitor = cfg.output.monitor.enabled
      ? new Monitor(cfg.output.monitor, cfg.capture, makeLog('monitor'))
      : null;
    this.filePlayer = cfg.filePlayer?.enabled
      ? new FilePlayer(sr, makeLog('fileplayer'), cfg.filePlayer.prebufferMs)
      : null;
    this.fileDirs = cfg.filePlayer?.enabled ? new FileDirs(cfg.filePlayer.dirs, log) : null;
    if (cfg.filePlayer?.enabled && cfg.filePlayer.bed.enabled && this.fileDirs) {
      this.bedPlayer = new FilePlayer(sr, makeLog('bed'), cfg.filePlayer.prebufferMs);
      this.bed = new BedDeck(this.bedPlayer, this.fileDirs, cfg.filePlayer.bed, makeLog('bed'));
    }
    this.meters = cfg.meters.enabled
      ? new MeterServer(cfg.meters.port, makeLog('meters'), cfg.meters.roles)
      : null;

    // --- air delay ---
    this.graphLatencyMs = (this.graph.latencySamples / sr) * 1000;
    this.captureLatencyMs = cfg.capture.latencyMs ?? 20;
    // Behind the FIFO: the pipe, the device buffer and the one block that is
    // on its way into the pipe (unless the latency was calibrated by hand).
    this.monitorLatencyMs = this.monitor
      ? outputLatencyMs(cfg.output.monitor, sr, 'pull') +
        (cfg.output.monitor.latencyMs === undefined ? this.blockMs : 0)
      : 0;
    // D can't be shorter than what the chain needs anyway.
    const floorMs = this.graphLatencyMs + this.captureLatencyMs + this.monitorLatencyMs;
    this.delayMs = Math.max(cfg.airDelay.seconds * 1000, floorMs + this.blockMs);
    this.clock = new SampleClock(sr);
    this.fifo = new AirFifo({
      delayMs: this.delayMs - this.captureLatencyMs,
      outputLatencyMs: this.monitorLatencyMs,
      toleranceMs: cfg.airDelay.toleranceSeconds * 1000,
      blockMs: this.blockMs,
    });

    // Pending play list: chains the next file when one ends by itself. Never
    // starts audio on its own (see QueuePlayer).
    this.playQueue = this.filePlayer
      ? new QueuePlayer({
          player: this.filePlayer,
          resolve: (folder, name) => this.resolveFile(folder, name),
          onChange: () => this.meters?.broadcastQueue(this.playQueue!.list()),
          log,
        })
      : null;
    // A talk with music breaks wants one track, then the talk again.
    if (this.playQueue) this.playQueue.autoAdvance = false;
    this.meters?.onCommand((cmd) => this.onCommand(cmd.type, cmd.value));
    this.meters?.onListQueue(() => this.playQueue?.list() ?? []);
    this.meters?.onListFolders(() => this.fileDirs?.folders() ?? []);
    this.meters?.onListFiles((folder, sub) => this.fileDirs?.list(folder, sub) ?? []);
    this.meters?.onListScheduled(() => this.scheduler?.upcoming() ?? []);
    this.meters?.onResolveFile((folder, name) => this.resolveFile(folder, name));
    // Listener feedback for the host: read-only from eve, on the page only.
    // Sendezeit: the plan says what is on air, not what the room is doing now.
    if (cfg.listeners.enabled && !this.meters) {
      log.warn('listeners.enabled needs meters.enabled (the feedback is shown on the page)');
    } else if (cfg.listeners.enabled) {
      this.listeners = new ListenerFeed({
        cfg: cfg.listeners,
        clock: () => Date.now() + this.airDelayMs(),
        onChange: (s) => this.meters?.broadcastListeners(s),
        log: makeLog('listeners'),
      });
      const feed = this.listeners;
      this.meters?.onListListeners(() => feed.status());
    }
    // Filename-timestamp auto-play. The timestamps are on-air times: an entry
    // is cued a few seconds ahead and the player starts it on the sample that
    // airs at the timestamp (so a jingle stamped 13:00:00 airs at 13:00:00,
    // i.e. leaves the player D early in wall time).
    this.scheduler =
      cfg.filePlayer?.enabled && cfg.filePlayer.autoPlay.enabled
        ? new Scheduler(
            cfg.filePlayer.autoPlay,
            () => this.fileDirs?.scheduled() ?? [],
            (e) => {
              const resolved = this.resolveFile(e.folder, e.name);
              if (resolved) this.filePlayer?.cue(resolved, e.playAtMs);
              else log.warn(`scheduled file vanished before start: ${e.name}`);
            },
            log,
            { now: () => Date.now() + this.musicDelayMs(), leadMs: CUE_LEAD_MS }
          )
        : null;

    this.setup = new SetupSession(sr);
    this.state = { savedAt: 0, mics: {} };
    this.restoreState();

    const block = () => new Float32Array(frames);
    this.outL = block();
    this.outR = block();
    this.retL = block();
    this.retR = block();
    this.fileL = block();
    this.fileR = block();
    this.taps = (layout ?? []).map(block);
    this.silence = Buffer.alloc(frames * 2 * BYTES_PER_SAMPLE);
  }

  // ---------------------------------------------------------------- clocks

  /** Delay from a sound in the room to the same sound at the output, in ms:
   *  measured once audio flows, the target until then. */
  private airDelayMs(): number {
    const m = this.fifo.measuredDelayMs;
    return m === null ? this.delayMs : m + this.captureLatencyMs;
  }

  /** Delay from a file sample entering the graph to the same sample at the
   *  output, in ms (the music is delayed a little more than the mics, see the
   *  constructor). */
  private musicDelayMs(): number {
    const extra = ((this.graph.musicLatencySamples - this.graph.latencySamples) / this.sr) * 1000;
    return this.airDelayMs() - this.captureLatencyMs + extra;
  }

  private airStatus(): AirStatus {
    const now = Date.now();
    const measured = this.fifo.measuredDelayMs;
    return {
      targetMs: Math.round(this.delayMs),
      delayMs: measured === null ? null : Math.round(measured + this.captureLatencyMs),
      nowMs: Math.round(now + this.airDelayMs()),
      state: this.show !== 'live' ? this.show : this.fifo.state,
      drainEndsMs: this.drainEndsMs === null ? null : Math.round(this.drainEndsMs),
      underruns: this.fifo.underruns,
      resyncs: this.fifo.resyncs,
    };
  }

  // ---------------------------------------------------------------- state

  /** Bring back what the setup assistant (or a hand trim) set before a
   *  restart, if it is recent enough. */
  private restoreState(): void {
    const s = loadState(this.cfg.stateFile);
    if (!s) return;
    let n = 0;
    for (const [label, settings] of Object.entries(s.mics)) {
      const base = this.graph.getProcessing(label);
      if (!base) continue;
      if (this.graph.retune(label, applySettings(base, settings), settings.seedDb)) n++;
    }
    if (s.automixFloorDb !== undefined) this.graph.setAutomixFloor(s.automixFloorDb);
    if (s.priorityDepthDb !== undefined) this.graph.setPriorityDepth(s.priorityDepthDb);
    if (s.queueMode && this.playQueue) this.playQueue.autoAdvance = s.queueMode === 'chain';
    this.state = s;
    this.setupApplied = n > 0;
    log.info(
      `restored live settings for ${n} mic(s) from ${path.basename(this.cfg.stateFile)} ` +
        `(saved ${new Date(s.savedAt).toISOString()})`
    );
  }

  private persist(): void {
    this.state.savedAt = Date.now();
    if (this.playQueue) this.state.queueMode = this.playQueue.autoAdvance ? 'chain' : 'single';
    if (!saveState(this.cfg.stateFile, this.state)) {
      log.warn(`could not write ${this.cfg.stateFile}`);
    }
  }

  // ---------------------------------------------------------------- commands

  /** Handle a control message from the meters page. */
  private onCommand(type: string, value: unknown): void {
    if (type === 'micsMuted') {
      const muted = !!value;
      this.graph.setMicsMuted(muted);
      // Opening the mics again takes the show back on air.
      if (!muted && this.show !== 'live') {
        this.show = 'live';
        this.drainEndsMs = null;
      }
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
      if (value) this.startRecording();
      else this.stopRecording();
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
    } else if (type === 'musicReturn' && this.ret) {
      this.returnArmed = !!value;
      if (this.returnArmed) this.ret.start();
      else this.ret.stop();
      log.info(`music return ${this.ret.active ? 'started' : 'stopped'}`);
    } else if (type === 'endShow') {
      if (value === false) this.cancelEndShow();
      else this.endShow();
    } else if (type === 'testTone' && this.monitor) {
      this.testTone = !!value;
      log.info(`test tone ${this.testTone ? 'on (1 kHz, -18 dBFS, local output only)' : 'off'}`);
    } else if (type === 'bed' && this.bed) {
      this.bed.set(!!value);
    } else if (type === 'bedSelect' && this.bed) {
      const req = isObj(value) ? value : {};
      const ok = this.bed.select(Number(req.folder ?? 0) || 0, String(req.name ?? ''));
      if (!ok) log.warn(`rejected bed file: folder ${req.folder} / ${req.name}`);
    } else if (type === 'priorityDepth') {
      const db = Number(value);
      if (Number.isFinite(db) && this.graph.priorityDepthDb !== null) {
        this.graph.setPriorityDepth(db);
        this.state.priorityDepthDb = this.graph.priorityDepthDb;
        this.persist();
      }
    } else if (type === 'trim') {
      const req = isObj(value) ? value : {};
      this.setTrim(String(req.label ?? ''), Number(req.trimDb));
    } else if (type.startsWith('setup')) {
      this.onSetupCommand(type, value);
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
    } else if (type === 'stopFile' && this.playQueue) {
      const fadeMs = this.cfg.filePlayer?.fadeOutMs ?? 0;
      log.info(`stopping file playback${fadeMs > 0 ? ` (fade ${fadeMs}ms)` : ''}`);
      // Through the queue player: an operator stop must not roll into the
      // next pending item (the list itself is kept).
      this.playQueue.stop(fadeMs);
    } else if (this.playQueue?.handleCommand(type, value)) {
      // queue* command, handled there.
      if (type === 'queueMode') this.persist();
    }
  }

  /** Setup assistant ("Einmessen") commands. */
  private onSetupCommand(type: string, value: unknown): void {
    if (type === 'setupStart') {
      // Optionally only some mics ("Nur diesen Kanal neu messen").
      const req = isObj(value) ? value : {};
      const only = Array.isArray(req.only) ? req.only.map(String) : undefined;
      const mics = this.graph.micLabels.map((label, i) => ({
        label,
        source: this.graph.micSources[i],
        // What is in force now (the "before" column). Every value the
        // assistant sets is absolute, so a second run doesn't stack on it.
        processing: this.graph.getProcessing(label)!,
        seedDb: this.graph.levelerDb(label) ?? 0,
      }));
      this.setup.start(mics, only?.length ? only : undefined);
      log.info(`setup assistant started${only?.length ? ` (only ${only.join(', ')})` : ''}`);
    } else if (type === 'setupFinish') {
      this.setup.finish();
    } else if (type === 'setupCancel' || type === 'setupDiscard') {
      this.setup.cancel();
      log.info('setup assistant: discarded');
    } else if (type === 'setupApply') {
      const results = this.setup.getResults();
      if (!results) return;
      const status = this.setup.status();
      let n = 0;
      for (const r of results) {
        if (!r.processing || !r.after) continue;
        if (this.graph.retune(r.label, r.processing, r.after.seedDb)) {
          this.state.mics[r.label] = r.after;
          n++;
        }
      }
      if (status.automixFloorDb !== null) {
        this.graph.setAutomixFloor(status.automixFloorDb);
        this.state.automixFloorDb = status.automixFloorDb;
      }
      this.setupApplied = this.setupApplied || n > 0;
      this.persist();
      this.setup.cancel();
      log.info(`setup assistant: applied to ${n} mic(s)`);
    }
  }

  /** Technician's hand trim: change one mic's input trim live. */
  private setTrim(label: string, trimDb: number): void {
    const cur = this.graph.getProcessing(label);
    if (!cur || !Number.isFinite(trimDb)) return;
    const next = { ...cur, trimDb: Math.max(-20, Math.min(40, trimDb)) };
    this.graph.retune(label, next);
    this.state.mics[label] = settingsOf(next, this.graph.levelerDb(label) ?? 0);
    this.persist();
    log.info(`trim ${label}: ${next.trimDb} dB`);
  }

  // ---------------------------------------------------------------- recording

  private startRecording(): void {
    if (!this.recorder) return;
    this.recordingArmed = true;
    this.recordStopAt = null;
    if (this.recorder.active) return;
    // The file is named by the on-air time of its first sample: the block
    // leaving the graph now was said `graphLatency` ago and airs D after that.
    const startMs = Date.now() - this.graphLatencyMs + this.airDelayMs();
    const date = new Date(startMs);
    const b = this.cfg.output.backup;
    const tags: Record<string, string> = {
      TITLE: b.title ?? `studiobox ${stamp(startMs)}`,
      DATE: date.toISOString().slice(0, 10),
      ORGANIZATION: b.station ?? '',
      COMMENT: `processed by studiobox ${version()}`,
    };
    this.recorder.start({ startMs, tags });
    const layout = this.graph.tapLayout;
    if (this.multitrack && layout) {
      const source = this.cfg.output.multitrack.source;
      this.multitrack.start({
        startMs,
        tags: { ...tags, COMMENT: `${tags.COMMENT}; ${source} multitrack: ${layout.join(' | ')}` },
      });
      this.writeChannelMap(startMs, layout);
    }
    this.graph.setRecording(this.recorder.active);
    log.info(`recording started${this.multitrack ? ' (stereo + multitrack)' : ''}`);
  }

  /** The channel map beside the multitrack file, for whoever opens it later. */
  private writeChannelMap(startMs: number, layout: string[]): void {
    const b = this.cfg.output.backup;
    const base = `studiobox-${stamp(startMs)}`;
    const mics = this.graph.micLabels.length;
    const source = this.cfg.output.multitrack.source;
    const map = {
      file: `${base}.multitrack.flac`,
      stereo: `${base}.flac`,
      sampleRate: this.sr,
      bitsPerSample: 24,
      startedAt: new Date(startMs).toISOString(),
      source,
      note:
        source === 'dry'
          ? 'Mics and music are the unprocessed sources, delayed so that every channel is ' +
            'sample-aligned with the programme (the last two channels = the stereo file).'
          : 'Mics and music are as they enter the mix (strip, leveler, automix, priority, ' +
            'ducking), sample-aligned with the programme (the last two channels = the stereo file).',
      channels: layout.map((name, i) => ({
        channel: i + 1,
        name,
        kind: i < mics ? 'mic' : i >= layout.length - 2 ? 'programme' : 'music',
      })),
    };
    try {
      fs.mkdirSync(b.dir, { recursive: true });
      fs.writeFileSync(path.join(b.dir, `${base}.multitrack.json`), JSON.stringify(map, null, 2));
    } catch (err) {
      log.warn(`could not write the channel map: ${(err as Error).message}`);
    }
  }

  /** Stop recording once the look-ahead has played out into the files. */
  private stopRecording(): void {
    if (!this.recorder || !this.recordingArmed) return;
    this.recordingArmed = false;
    this.recordStopAt = this.samples + this.graph.latencySamples;
    log.info(
      `recording stops in ${(this.graphLatencyMs / 1000).toFixed(1)} s (look-ahead plays out)`
    );
  }

  private finishRecording(): void {
    this.recordStopAt = null;
    this.recorder?.stop();
    this.multitrack?.stop();
    this.graph.setRecording(this.recorder ? false : null);
    log.info('recording stopped');
  }

  // ---------------------------------------------------------------- end of show

  /** "Sendung beenden": close the mics now, let everything already said (and
   *  a file still playing) air, then stop the recording. The output keeps
   *  running; opening the mics again goes back on air. */
  private endShow(): void {
    if (this.show === 'draining') return;
    this.graph.setMicsMuted(true);
    if (this.playQueue) this.playQueue.autoAdvance = false;
    this.show = 'draining';
    this.drainEndsMs = Date.now() + this.airDelayMs() + DRAIN_MARGIN_MS;
    log.info(
      `end of show: mics closed, buffer plays out until ` +
        `${new Date(this.drainEndsMs).toLocaleTimeString()}`
    );
  }

  private cancelEndShow(): void {
    if (this.show === 'live') return;
    this.show = 'live';
    this.drainEndsMs = null;
    log.info('end of show cancelled (mics stay closed until opened)');
  }

  private tickShow(now: number): void {
    if (this.show !== 'draining' || this.drainEndsMs === null) return;
    // A file still playing in the room has its own tail to air.
    if (this.filePlayer?.playing) {
      this.drainEndsMs = now + this.musicDelayMs() + DRAIN_MARGIN_MS;
      return;
    }
    if (now < this.drainEndsMs) return;
    this.show = 'ended';
    this.drainEndsMs = null;
    if (this.recorder?.active) {
      this.recordingArmed = false;
      this.finishRecording();
    }
    log.info('end of show: buffer played out');
  }

  /** Resolve a requested filename to an absolute path inside the folder at
   *  `index` (path-traversal-safe; see FileDirs). */
  private resolveFile(index: number, name: string): string | null {
    return this.fileDirs?.resolve(index, name) ?? null;
  }

  // ---------------------------------------------------------------- audio

  /** One capture block: file player -> graph -> return, recorders, FIFO. */
  private onBlock(input: Float32Array[]): void {
    const t0 = performance.now();
    this.processBlock(input);
    const took = performance.now() - t0;
    if (took > this.blockMaxMs) this.blockMaxMs = took;
  }

  private processBlock(input: Float32Array[]): void {
    const frames = this.cfg.capture.blockSize;
    const start = this.samples;
    this.samples += frames;
    const now = Date.now();
    this.clock.mark(this.samples, now);
    const roomMs = this.clock.timeOf(start, now);

    if (this.filePlayer) {
      // The player's clock is the on-air time of the block it fills, so a
      // cued file starts on the sample that airs at its timestamp.
      this.filePlayer.read(this.fileL, this.fileR, frames, roomMs + this.musicDelayMs());
      // The bed rides on the file player's source: leveled and ducked with it.
      this.bed?.mixInto(this.fileL, this.fileR, frames);
      // Report only the basename: the snapshot field is the file *name* (the
      // meters page shows it and matches it against the file-list rows).
      const playingName = this.filePlayer.playing ? path.basename(this.filePlayer.playing) : null;
      this.graph.setFileBlock(
        this.fileL,
        this.fileR,
        playingName,
        this.filePlayer.position,
        this.filePlayer.duration,
        // Where it came from (memoized in FileDirs): the page uses it for
        // "jump back to the folder this is playing from".
        this.filePlayer.playing ? (this.fileDirs?.locate(this.filePlayer.playing) ?? null) : null
      );
    }

    if (this.setup.active) this.setup.feed(input, frames);
    this.tickShow(now);

    this.graph.process(input, this.outL, this.outR, frames, {
      retL: this.retL,
      retR: this.retR,
      taps: this.taps,
    });

    // Music return: room time, no air delay. If the device stalls, skip
    // blocks rather than queue them up (a late return is worse than a gap).
    if (this.ret?.active) {
      const limit = RETURN_BACKLOG_SEC * this.sr * (this.cfg.output.return.channels ?? 2) * 4;
      if (this.ret.backlogBytes > limit) this.returnDropped++;
      else this.ret.write(interleaveStereo(this.retL, this.retR, frames));
    }

    const out = interleaveStereo(this.outL, this.outR, frames);
    if (this.recorder?.active) {
      this.recorder.write(out);
      if (this.multitrack?.active) this.multitrack.write(interleave(this.taps, frames));
      if (this.recordStopAt !== null && this.samples >= this.recordStopAt) this.finishRecording();
    }

    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(this.outL[i]);
      const b = Math.abs(this.outR[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    this.fifo.push({
      buf: out,
      // Room time of the speech this programme block carries.
      capturedMs: this.clock.timeOf(start - this.graph.latencySamples, now),
      quiet: peak < QUIET_PEAK,
    });

    // Without a sound card pulling, release what has fallen due (the FIFO is
    // then a plain delay line in front of the harbor encoder).
    if (!this.monitor?.active) {
      this.fifo.setOutputLatency(0);
      for (const b of this.fifo.drain(now)) this.encoder.write(b.buf);
    }
  }

  /** The output card asks for the next block (pull side of the FIFO). */
  private pump = (): void => {
    if (this.stopping || !this.monitor) return;
    const frames = this.cfg.capture.blockSize;
    // Watchdog a little above the block duration: long enough to normally be
    // beaten by the pipe taking the block, short enough to notice a dead device.
    const watchdog = Math.ceil(this.blockMs * 4);
    if (!this.monitor.active) {
      // No device right now (stopped, or restarting): the capture side
      // releases the blocks meanwhile; just keep looking.
      const t = setTimeout(this.pump, 100);
      t.unref?.();
      return;
    }
    this.fifo.setOutputLatency(this.monitorLatencyMs);
    const nowMs = performance.now();
    if (this.lastPumpMs && nowMs - this.lastPumpMs > this.pumpGapMaxMs) {
      this.pumpGapMaxMs = nowMs - this.lastPumpMs;
    }
    this.lastPumpMs = nowMs;
    const b = this.fifo.pop(Date.now());
    const buf = b ? b.buf : this.silence;
    this.encoder.write(buf);
    this.monitor.writeThen(this.testTone ? this.toneBlock(frames) : buf, this.pump, watchdog);
  };

  /** One block of the alignment tone (phase-continuous across blocks). */
  private toneBlock(frames: number): Buffer {
    const buf = Buffer.allocUnsafe(frames * 2 * BYTES_PER_SAMPLE);
    const step = (2 * Math.PI * TONE_HZ) / this.sr;
    for (let i = 0; i < frames; i++) {
      const v = TONE_AMP * Math.sin(this.tonePhase);
      this.tonePhase += step;
      buf.writeFloatLE(v, i * 2 * BYTES_PER_SAMPLE);
      buf.writeFloatLE(v, (i * 2 + 1) * BYTES_PER_SAMPLE);
    }
    this.tonePhase %= 2 * Math.PI;
    return buf;
  }

  // ---------------------------------------------------------------- lifecycle

  /** The snapshot the views render: the graph's meters plus everything the
   *  pipeline knows (air delay, recorders, setup assistant, queue mode). */
  snapshot(): MeterSnapshot & LiveStatus {
    const next = this.scheduler?.next() ?? null;
    this.graph.setNextScheduled(next ? { name: next.name, playAtMs: next.playAtMs } : null);
    const now = Date.now();
    if (this.monitor) this.graph.setMonitor(this.monitor.up(now));
    return {
      ...this.graph.getMeters(),
      air: this.airStatus(),
      musicReturn: this.ret ? this.ret.up(now) : null,
      musicReturnFault: !!this.ret && this.returnArmed && this.ret.failing(now),
      monitorFault: !!this.monitor && this.monitorArmed && this.monitor.failing(now),
      multitrack: this.multitrack ? this.multitrack.active : null,
      setup: this.setup.status(),
      setupApplied: this.setupApplied,
      queueMode: this.playQueue ? (this.playQueue.autoAdvance ? 'chain' : 'single') : null,
      testTone: this.testTone,
      bed: this.bed ? this.bed.status() : null,
    };
  }

  start(): void {
    const c = this.cfg;
    log.info(
      `starting: ${c.channels.length} channels @ ${this.sr} Hz, block ${c.capture.blockSize}; ` +
        `look-ahead ${(this.graphLatencyMs / 1000).toFixed(2)} s, ` +
        `air delay ${(this.delayMs / 1000).toFixed(1)} s`
    );
    if (this.delayMs > c.airDelay.seconds * 1000 + 1) {
      log.warn(
        `airDelay.seconds (${c.airDelay.seconds}) is shorter than the chain itself; ` +
          `running at ${(this.delayMs / 1000).toFixed(2)} s`
      );
    }
    // Harbor streaming starts automatically when configured (going live is the
    // primary purpose), but can be toggled live from the meters page. The
    // encoder is a no-op when harbor is disabled, in which case the control is
    // hidden (null state).
    this.harborArmed = c.output.harbor.enabled;
    this.graph.setStreaming(c.output.harbor.enabled ? false : null);
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
    // the (inactive) state so the control is shown, and start a fresh file if
    // ffmpeg dies while armed.
    if (this.recorder) {
      this.recordingArmed = false;
      this.graph.setRecording(false);
      this.recorder.on('exit', (code) => {
        if (this.stopping || !this.recorder || !this.recordingArmed) return;
        log.warn(`recorder exited (code ${code}); restarting in 1s`);
        // Keep stereo and multitrack in step: both start over together.
        this.multitrack?.stop();
        setTimeout(() => {
          if (this.stopping || !this.recordingArmed) return;
          this.startRecording();
        }, 1000);
      });
      this.multitrack?.on('exit', (code) => {
        if (this.stopping || !this.recordingArmed || this.recordStopAt !== null) return;
        log.error(`multitrack recorder exited (code ${code}); the stereo recording continues`);
      });
    }

    // Local hardware playout starts automatically when configured (it is a
    // primary output, like the harbor), but can be toggled live from the meters
    // page. It is a no-op / hidden control (null state) when not configured.
    this.monitorArmed = this.monitor !== null;
    this.graph.setMonitor(this.monitor ? false : null);
    if (this.monitor) {
      const mon = this.monitor;
      mon.start();
      this.graph.setMonitor(mon.active);
      // The page's state follows `up()` in snapshot(), not these restarts.
      mon.on('exit', (code) => {
        if (this.stopping || !this.monitorArmed) return;
        log.warn(`monitor exited (code ${code}); restarting in 1s`);
        this.graph.setMonitor(false);
        setTimeout(() => {
          if (this.stopping || !this.monitorArmed) return;
          mon.start();
        }, 1000);
      });
      this.pump();
    }

    // Music return to the room: starts with the service, restarts on a drop.
    this.returnArmed = this.ret !== null;
    if (this.ret) {
      const ret = this.ret;
      ret.start();
      ret.on('exit', (code) => {
        if (this.stopping || !this.returnArmed) return;
        log.warn(`music return exited (code ${code}); restarting in 1s`);
        setTimeout(() => {
          if (this.stopping || !this.returnArmed) return;
          ret.start();
        }, 1000);
      });
    }

    this.capture.on('block', (input: Float32Array[]) => this.onBlock(input));
    this.capture.on('error', (err) => log.error('capture error:', err.message));
    this.capture.on('exit', (code) => {
      if (this.stopping) return;
      log.warn(`capture exited (code ${code}); restarting in 1s`);
      setTimeout(() => this.capture.start(), 1000);
    });
    this.capture.start();

    this.scheduler?.start();
    this.startHealthProbe();
    this.listeners?.start();

    if (this.meters) {
      this.meters.start();
      const interval = Math.max(1, Math.round(1000 / c.meters.fps));
      this.metersTimer = setInterval(() => this.meters!.broadcast(this.snapshot()), interval);
    }
  }

  /** Every 10 s: say so when the event loop stalled, a block took too long or
   *  the output was left waiting — the three ways this process can make a
   *  sound card run dry. Silent while all is well. */
  private startHealthProbe(): void {
    this.loopDelay = monitorEventLoopDelay({ resolution: 10 });
    this.loopDelay.enable();
    this.healthTimer = setInterval(() => {
      const loopMs = this.loopDelay ? this.loopDelay.max / 1e6 : 0;
      this.loopDelay?.reset();
      const blockMs = this.blockMaxMs;
      const gapMs = this.pumpGapMaxMs;
      this.blockMaxMs = 0;
      this.pumpGapMaxMs = 0;
      if (loopMs > 150 || blockMs > this.blockMs || gapMs > 300) {
        log.warn(
          `slow: event loop stalled up to ${loopMs.toFixed(0)} ms, longest block ` +
            `${blockMs.toFixed(1)} ms (budget ${this.blockMs.toFixed(1)}), longest pause ` +
            `between output blocks ${gapMs.toFixed(0)} ms`
        );
      }
    }, 10_000);
    this.healthTimer.unref?.();
  }

  stop(): void {
    this.stopping = true;
    if (this.metersTimer) clearInterval(this.metersTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.loopDelay?.disable();
    this.scheduler?.stop();
    this.listeners?.stop();
    this.meters?.stop();
    this.filePlayer?.shutdown();
    this.bedPlayer?.shutdown();
    this.capture.stop();
    this.encoder.stop();
    this.recorder?.stop();
    this.multitrack?.stop();
    this.monitor?.stop();
    this.ret?.stop();
    if (this.returnDropped) log.warn(`music return skipped ${this.returnDropped} block(s)`);
    log.info('stopped');
  }
}

let cachedVersion: string | null = null;
/** studiobox's version, for the recording tags. */
function version(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
      cachedVersion = String(pkg.version ?? '');
    } catch {
      cachedVersion = '';
    }
  }
  return cachedVersion;
}

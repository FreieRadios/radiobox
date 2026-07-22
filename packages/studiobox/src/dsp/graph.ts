import { StudioboxConfig } from '../config/schema';
import { ChannelStrip, StripMeters } from './channel-strip';
import { Automix } from './automix';
import { Ducker } from './duck';
import { Leveler } from './leveler';
import { Limiter } from './limiter';
import { StereoLoudness } from './loudness';
import { clamp, dbToGain, gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

export interface ChannelMeter extends StripMeters {
  label: string;
  role: string;
  automixGainDb: number;
  muted: boolean;
}

export interface MeterSnapshot {
  channels: ChannelMeter[];
  duckDepthDb: number;
  limiterGrDb: number;
  momentaryLufs: number;
  shortTermLufs: number;
  outPeakDb: number;
  micsMuted: boolean;
  /** Name of the file currently playing via the local file player, if any. */
  filePlaying: string | null;
  /** Elapsed playback position of the current file, in seconds (null when idle). */
  filePosition: number | null;
  /** Total duration of the current file, in seconds (null when idle/unknown). */
  fileDuration: number | null;
  /** Local FLAC recording state: true/false when available, null when the
   *  backup recorder is not configured (so the UI can hide the control). */
  recording: boolean | null;
  /** Harbor streaming state: true/false when available, null when the harbor
   *  output is not configured (so the UI can hide the control). */
  streaming: boolean | null;
  /** Local hardware playout state: true/false when available, null when no
   *  monitor output is configured (so the UI can hide the control). */
  monitor: boolean | null;
  /** Next scheduled auto-play (soonest future filename timestamp), or null
   *  when none is pending / the scheduler is disabled. */
  nextScheduled: { name: string; playAtMs: number } | null;
  /** Server wallclock (epoch ms) when the snapshot was taken, so the page can
   *  mark upcoming files against the server's clock rather than its own. */
  serverNowMs: number;
}

interface MicNode {
  label: string;
  strip: ChannelStrip;
  source: number; // 0-based
  automixSlot: number; // index into automix members, or -1
  muted: boolean; // per-channel mute (independent of the global mic mute)
}

interface MusicNode {
  label: string;
  left: number; // 0-based capture channel (-1 when virtual)
  right: number;
  gain: number;
  ducked: boolean;
  leveler: Leveler | null; // AGC normalizing music loudness (applied pre-duck)
  virtual: boolean; // true for the local file player (fed via setFileBlock)
  meter: EnvelopeFollower; // tracks the channel's post-leveler/gain peak level
  muted: boolean; // per-channel mute
}

/**
 * The full studiobox processing graph. Stateful; one instance per run.
 * `process()` consumes a block of de-interleaved input channels and writes a
 * stereo block to `outL`/`outR`.
 */
export class Graph {
  private mics: MicNode[] = [];
  private music: MusicNode[] = [];
  private automix: Automix | null = null;
  private automixBuf: Float32Array;
  private ducker: Ducker;
  private limiter: Limiter;
  private outMeter: StereoLoudness;
  private preMeter: StereoLoudness;
  private outPeak: EnvelopeFollower;

  // master leveler state
  private masterGainDb = 0;
  private masterCoef: number;
  private targetLufs: number;

  // "music only" mode: mutes the mic bus (set live from the meters page)
  private micsMuted = false;

  // Local file player: a virtual music source fed one block at a time.
  private fileL: Float32Array;
  private fileR: Float32Array;
  private filePlaying: string | null = null;
  private filePosition: number | null = null;
  private fileDuration: number | null = null;

  // Local FLAC recording state, reported live to the meters page. null means
  // the backup recorder is not configured (the UI then hides the control).
  private recording: boolean | null = null;

  // Harbor streaming state, reported live to the meters page. null means the
  // harbor output is not configured (the UI then hides the control).
  private streaming: boolean | null = null;

  // Local hardware playout state, reported live to the meters page. null means
  // no monitor output is configured (the UI then hides the control).
  private monitor: boolean | null = null;

  // Next scheduled auto-play, reported to the meters page (null when the
  // filename-timestamp scheduler is disabled or nothing is pending).
  private nextScheduled: { name: string; playAtMs: number } | null = null;

  private snapshot: MeterSnapshot;

  constructor(private cfg: StudioboxConfig) {
    const sr = cfg.capture.sampleRate;
    const members = cfg.automix.enabled ? cfg.automix.members : [];

    for (const ch of cfg.channels) {
      if (ch.role === 'mic') {
        this.mics.push({
          label: ch.label,
          strip: new ChannelStrip(ch.processing, sr),
          source: (ch.source as number) - 1,
          automixSlot: members.indexOf(ch.label),
          muted: false,
        });
      } else if (ch.role === 'music') {
        const [l, r] = ch.source as [number, number];
        this.music.push({
          label: ch.label,
          left: l - 1,
          right: r - 1,
          gain: dbToGain(ch.processing.gainDb),
          ducked: cfg.duck.targets.includes(ch.label),
          leveler: ch.processing.leveler.enabled ? new Leveler(ch.processing.leveler, sr) : null,
          virtual: false,
          meter: new EnvelopeFollower(sr, 1, 200),
          muted: false,
        });
      }
    }

    const memberCount = members.filter((m) => this.mics.some((x) => x.label === m)).length;
    if (cfg.automix.enabled && memberCount > 0) {
      this.automix = new Automix(members.length, sr, cfg.automix.responseMs, cfg.automix.floorDb);
    }
    this.automixBuf = new Float32Array(members.length);

    if (cfg.filePlayer?.enabled) {
      const fp = cfg.filePlayer;
      this.music.push({
        label: fp.label,
        left: -1,
        right: -1,
        gain: dbToGain(fp.processing.gainDb),
        ducked: fp.ducked,
        leveler: fp.processing.leveler.enabled ? new Leveler(fp.processing.leveler, sr) : null,
        virtual: true,
        meter: new EnvelopeFollower(sr, 1, 200),
        muted: false,
      });
    }
    this.fileL = new Float32Array(cfg.capture.blockSize);
    this.fileR = new Float32Array(cfg.capture.blockSize);

    this.ducker = new Ducker(cfg.duck, sr);
    this.limiter = new Limiter(
      sr,
      cfg.master.truePeakDb,
      cfg.master.limiterLookaheadMs,
      cfg.master.limiterReleaseMs
    );
    this.outMeter = new StereoLoudness(sr);
    this.preMeter = new StereoLoudness(sr);
    this.outPeak = new EnvelopeFollower(sr, 1, 200);
    this.masterCoef = msToCoef(4000, sr);
    this.targetLufs = cfg.master.targetLufs;

    this.snapshot = this.emptySnapshot();
  }

  private emptySnapshot(): MeterSnapshot {
    return {
      channels: [
        ...this.mics.map((m) => ({
          label: m.label,
          role: 'mic',
          outDb: -Infinity,
          gateOpen: 0,
          compGrDb: 0,
          levelerDb: 0,
          automixGainDb: 0,
          muted: false,
        })),
        ...this.music.map((m) => ({
          label: m.label,
          role: 'music',
          outDb: -Infinity,
          gateOpen: 1,
          compGrDb: 0,
          levelerDb: 0,
          automixGainDb: 0,
          muted: false,
        })),
      ],
      duckDepthDb: 0,
      limiterGrDb: 0,
      momentaryLufs: -Infinity,
      shortTermLufs: -Infinity,
      outPeakDb: -Infinity,
      micsMuted: false,
      filePlaying: null,
      filePosition: null,
      fileDuration: null,
      recording: null,
      streaming: null,
      monitor: null,
      nextScheduled: null,
      serverNowMs: Date.now(),
    };
  }

  /** @param input de-interleaved channels (index = capture channel, 0-based) */
  process(input: Float32Array[], outL: Float32Array, outR: Float32Array, frames: number): void {
    const micProc = new Float32Array(this.mics.length);
    const stereoOut: [number, number] = [0, 0];
    let lastAutomixGains: Float32Array | null = null;
    let lastDuck = 0;

    for (let n = 0; n < frames; n++) {
      // --- mic strips ---
      let micBus = 0;
      for (let i = 0; i < this.mics.length; i++) {
        const m = this.mics[i];
        const s = m.strip.process(input[m.source][n]);
        // Per-channel mute: keep the strip (and its meters) running, but drop
        // the channel from the automix and the bus so it's truly silent.
        micProc[i] = m.muted ? 0 : s;
      }

      // --- gain-sharing automix ---
      let gains: Float32Array | null = null;
      if (this.automix) {
        for (let i = 0; i < this.mics.length; i++) {
          const slot = this.mics[i].automixSlot;
          if (slot >= 0) this.automixBuf[slot] = micProc[i];
        }
        gains = this.automix.process(this.automixBuf);
        lastAutomixGains = gains;
      }
      for (let i = 0; i < this.mics.length; i++) {
        const slot = this.mics[i].automixSlot;
        const g = gains && slot >= 0 ? gains[slot] : 1;
        micBus += micProc[i] * g;
      }
      // "music only" mode: drop the mic bus (also un-arms ducking, since the
      // ducker now sees a silent mic bus, so music plays at full level).
      if (this.micsMuted) micBus = 0;

      // --- music buses (duckable vs. not) ---
      let tgtL = 0,
        tgtR = 0,
        othL = 0,
        othR = 0;
      for (const mu of this.music) {
        let l = (mu.virtual ? this.fileL[n] : input[mu.left][n]) * mu.gain;
        let r = (mu.virtual ? this.fileR[n] : input[mu.right][n]) * mu.gain;
        // Auto-level music to a consistent loudness. Drive the AGC from the
        // mono sum and apply one gain to both sides so the stereo image is
        // preserved. Runs before ducking, so speech still pulls music down.
        if (mu.leveler) {
          mu.leveler.process((l + r) * 0.5);
          const g = dbToGain(mu.leveler.gainDbValue);
          l *= g;
          r *= g;
        }
        // Track this channel's own output level (post-leveler/gain, pre-duck)
        // so the meters page shows a real "out dB" for music/file sources.
        mu.meter.process(Math.max(Math.abs(l), Math.abs(r)));
        // Per-channel mute: meter still tracks the source, but it contributes
        // nothing to the mix.
        if (mu.muted) continue;
        if (mu.ducked) {
          tgtL += l;
          tgtR += r;
        } else {
          othL += l;
          othR += r;
        }
      }
      const duckGain = this.ducker.process(micBus, (tgtL + tgtR) * 0.5);
      lastDuck = this.ducker.depthDb;
      const musicL = tgtL * duckGain + othL;
      const musicR = tgtR * duckGain + othR;

      // --- master sum + slow leveler ---
      let mL = micBus + musicL;
      let mR = micBus + musicR;
      this.preMeter.process(mL, mR);
      const stLufs = this.preMeter.shortTermLufs;
      if (Number.isFinite(stLufs) && stLufs > -50) {
        const want = clamp(this.targetLufs - stLufs, -12, 12);
        this.masterGainDb = this.masterCoef * (this.masterGainDb - want) + want;
      }
      const mg = dbToGain(this.masterGainDb);
      mL *= mg;
      mR *= mg;

      // --- brick-wall limiter + output metering ---
      this.limiter.process(stereoOut, mL, mR);
      outL[n] = stereoOut[0];
      outR[n] = stereoOut[1];
      this.outMeter.process(stereoOut[0], stereoOut[1]);
      this.outPeak.process(Math.max(Math.abs(stereoOut[0]), Math.abs(stereoOut[1])));
    }

    this.updateSnapshot(lastAutomixGains, lastDuck);
  }

  private updateSnapshot(gains: Float32Array | null, duckDepth: number): void {
    const channels: ChannelMeter[] = [];
    for (const m of this.mics) {
      const sm = m.strip.meters();
      channels.push({
        label: m.label,
        role: 'mic',
        ...sm,
        automixGainDb: gains && m.automixSlot >= 0 ? gainToDb(gains[m.automixSlot]) : 0,
        muted: m.muted,
      });
    }
    for (const mu of this.music) {
      channels.push({
        label: mu.label,
        role: 'music',
        outDb: gainToDb(mu.meter.value),
        gateOpen: 1,
        compGrDb: 0,
        levelerDb: mu.leveler ? mu.leveler.gainDbValue : 0,
        automixGainDb: 0,
        muted: mu.muted,
      });
    }
    this.snapshot = {
      channels,
      duckDepthDb: duckDepth,
      limiterGrDb: this.limiter.gainReductionDb,
      momentaryLufs: this.outMeter.momentaryLufs,
      shortTermLufs: this.outMeter.shortTermLufs,
      outPeakDb: gainToDb(this.outPeak.value),
      micsMuted: this.micsMuted,
      filePlaying: this.filePlaying,
      filePosition: this.filePosition,
      fileDuration: this.fileDuration,
      recording: this.recording,
      streaming: this.streaming,
      monitor: this.monitor,
      nextScheduled: this.nextScheduled,
      serverNowMs: Date.now(),
    };
  }

  /** Toggle "music only" mode (mutes all mics). Driven from the meters page. */
  setMicsMuted(muted: boolean): void {
    this.micsMuted = muted;
  }

  /** Mute/unmute a single channel (mic or music) by its label. */
  setChannelMuted(label: string, muted: boolean): void {
    const mic = this.mics.find((m) => m.label === label);
    if (mic) {
      mic.muted = muted;
      return;
    }
    const mu = this.music.find((m) => m.label === label);
    if (mu) mu.muted = muted;
  }

  /** Report the local FLAC recording state to the meters page. Pass null when
   *  the backup recorder is not configured so the control stays hidden. */
  setRecording(recording: boolean | null): void {
    this.recording = recording;
  }

  /** Report the harbor streaming state to the meters page. Pass null when the
   *  harbor output is not configured so the control stays hidden. */
  setStreaming(streaming: boolean | null): void {
    this.streaming = streaming;
  }

  /** Report the local hardware playout state to the meters page. Pass null when
   *  no monitor output is configured so the control stays hidden. */
  setMonitor(monitor: boolean | null): void {
    this.monitor = monitor;
  }

  /** Report the next scheduled auto-play to the meters page (null when the
   *  scheduler is disabled or nothing is pending). */
  setNextScheduled(next: { name: string; playAtMs: number } | null): void {
    this.nextScheduled = next;
  }

  /** Feed one block of the local file player into the virtual music source,
   *  along with its current playback position/duration (seconds) for the UI. */
  setFileBlock(
    l: Float32Array,
    r: Float32Array,
    playing: string | null,
    position: number | null = null,
    duration: number | null = null
  ): void {
    this.fileL.set(l);
    this.fileR.set(r);
    this.filePlaying = playing;
    this.filePosition = playing ? position : null;
    this.fileDuration = playing ? duration : null;
  }

  getMeters(): MeterSnapshot {
    return this.snapshot;
  }
}

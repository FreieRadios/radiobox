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
}

export interface MeterSnapshot {
  channels: ChannelMeter[];
  duckDepthDb: number;
  limiterGrDb: number;
  momentaryLufs: number;
  shortTermLufs: number;
  outPeakDb: number;
  micsMuted: boolean;
}

interface MicNode {
  label: string;
  strip: ChannelStrip;
  source: number; // 0-based
  automixSlot: number; // index into automix members, or -1
}

interface MusicNode {
  label: string;
  left: number; // 0-based
  right: number;
  gain: number;
  ducked: boolean;
  leveler: Leveler | null; // AGC normalizing music loudness (applied pre-duck)
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
        });
      }
    }

    const memberCount = members.filter((m) => this.mics.some((x) => x.label === m)).length;
    if (cfg.automix.enabled && memberCount > 0) {
      this.automix = new Automix(members.length, sr, cfg.automix.responseMs, cfg.automix.floorDb);
    }
    this.automixBuf = new Float32Array(members.length);

    this.ducker = new Ducker(cfg.duck, sr);
    this.limiter = new Limiter(
      sr,
      cfg.master.truePeakDb,
      cfg.master.limiterLookaheadMs,
      cfg.master.limiterReleaseMs,
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
          label: m.label, role: 'mic', outDb: -Infinity,
          gateOpen: 0, compGrDb: 0, levelerDb: 0, automixGainDb: 0,
        })),
        ...this.music.map((m) => ({
          label: m.label, role: 'music', outDb: -Infinity,
          gateOpen: 1, compGrDb: 0, levelerDb: 0, automixGainDb: 0,
        })),
      ],
      duckDepthDb: 0, limiterGrDb: 0,
      momentaryLufs: -Infinity, shortTermLufs: -Infinity, outPeakDb: -Infinity,
      micsMuted: false,
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
        micProc[i] = m.strip.process(input[m.source][n]);
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
      let tgtL = 0, tgtR = 0, othL = 0, othR = 0;
      for (const mu of this.music) {
        let l = input[mu.left][n] * mu.gain;
        let r = input[mu.right][n] * mu.gain;
        // Auto-level music to a consistent loudness. Drive the AGC from the
        // mono sum and apply one gain to both sides so the stereo image is
        // preserved. Runs before ducking, so speech still pulls music down.
        if (mu.leveler) {
          mu.leveler.process((l + r) * 0.5);
          const g = dbToGain(mu.leveler.gainDbValue);
          l *= g;
          r *= g;
        }
        if (mu.ducked) { tgtL += l; tgtR += r; } else { othL += l; othR += r; }
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
      mL *= mg; mR *= mg;

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
        label: m.label, role: 'mic', ...sm,
        automixGainDb: gains && m.automixSlot >= 0 ? gainToDb(gains[m.automixSlot]) : 0,
      });
    }
    for (const mu of this.music) {
      channels.push({
        label: mu.label, role: 'music',
        outDb: 0, gateOpen: 1, compGrDb: 0,
        levelerDb: mu.leveler ? mu.leveler.gainDbValue : 0,
        automixGainDb: 0,
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
    };
  }

  /** Toggle "music only" mode (mutes all mics). Driven from the meters page. */
  setMicsMuted(muted: boolean): void {
    this.micsMuted = muted;
  }

  getMeters(): MeterSnapshot {
    return this.snapshot;
  }
}

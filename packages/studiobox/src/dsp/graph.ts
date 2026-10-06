import { ChannelProcessing, StudioboxConfig } from '../config/schema';
import { ChannelStrip, StripMeters } from './channel-strip';
import { Automix } from './automix';
import { Ducker } from './duck';
import { Limiter } from './limiter';
import { MasterLeveler } from './master-leveler';
import { MusicLeveler } from './music-leveler';
import { Priority } from './priority';
import { StereoLoudness } from './loudness';
import { DelayLine } from './delay-line';
import { dbToGain, gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';
import { DuckPlanner, FRAME_MS, VoiceDetector } from './voice';
import type { StreamStatus } from '../audio/stream-player';

export interface ChannelMeter extends StripMeters {
  label: string;
  role: string;
  /** Marker colour from the channel config (CSS hex), or null when unset. */
  color: string | null;
  automixGainDb: number;
  muted: boolean;
  /** Mics: true while this mic is the active talker (its gate is open and it
   *  is not just picking up a louder neighbour). Always false for music. */
  active: boolean;
  /** Mics: attenuation host priority applies to this mic right now (dB, <= 0). */
  priorityDb: number;
  /** Mics: the input trim in force (dB). */
  trimDb: number;
}

/** Air-delay state, filled in by the pipeline (the graph has no clock). */
export interface AirStatus {
  /** Configured target delay D between the room and the output, in ms. */
  targetMs: number;
  /** Measured delay in ms: from a sound in the room to the same sound at the
   *  output. Null until the first buffered block has reached the output. */
  delayMs: number | null;
  /** "Sendezeit" (epoch ms): when what is said in the room *now* goes on air,
   *  i.e. server wall clock + measured delay. */
  nowMs: number;
  /** `filling`: the buffer is still building up after a start (output is
   *  silent). `live`: on air. `draining`: "Sendung beenden" was pressed, the
   *  mics are closed and the buffer is playing out. `ended`: drained. */
  state: 'filling' | 'live' | 'draining' | 'ended';
  /** While draining: server wall clock (epoch ms) at which the last buffered
   *  audio will have aired. */
  drainEndsMs: number | null;
  /** Output blocks replaced by silence because the buffer ran dry. */
  underruns: number;
  /** One-step re-centrings of the buffer (audible; after a device stall). */
  resyncs: number;
}

export interface MeterSnapshot {
  channels: ChannelMeter[];
  duckDepthDb: number;
  /** Gain of the talk-keyed master leveler (dB), programme time. */
  masterGainDb?: number;
  limiterGrDb: number;
  momentaryLufs: number;
  shortTermLufs: number;
  outPeakDb: number;
  micsMuted: boolean;
  /** Name of the file currently playing via the local file player, if any. */
  filePlaying: string | null;
  /** Where that file lives in the browsable folders, so the page can offer a
   *  jump back to it after browsing elsewhere. Null when nothing is playing
   *  or the file sits outside the configured dirs. */
  filePlayingAt: { folder: number; name: string } | null;
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
   *  when none is pending / the scheduler is disabled. With an air delay the
   *  timestamp is a **Sendezeit**: the file airs at `playAtMs`, so count down
   *  against `air.nowMs`, not `serverNowMs`. */
  nextScheduled: { name: string; playAtMs: number } | null;
  /** Server wallclock (epoch ms) when the snapshot was taken, so the page can
   *  mark upcoming files against the server's clock rather than its own. */
  serverNowMs: number;
  /** How far the programme runs behind the room inside the DSP graph, in ms
   *  (the look-ahead). Everything per-channel in this snapshot is in room
   *  time; the master meters (LUFS, limiter, duck, peak) are this much later. */
  lookaheadMs?: number;
  /** Host priority, when configured: who has it, how deep, and whether it is
   *  acting right now. */
  priority?: { label: string; depthDb: number; active: boolean } | null;
  /** Air delay and Sendezeit. Absent in playout mode (no delay there). */
  air?: AirStatus;
  /** Music-return output (to the mixer's USB playback): true/false when
   *  configured, null when not. */
  musicReturn?: boolean | null;
  /** Whether the multitrack file is written along with the stereo recording;
   *  null when multitrack is not configured. */
  multitrack?: boolean | null;
  /** The network stream the file player plays, or null (roadmap M1c.2). */
  stream?: StreamStatus | null;
}

interface MicNode {
  label: string;
  strip: ChannelStrip;
  processing: ChannelProcessing;
  source: number; // 0-based
  automixSlot: number; // index into automix members, or -1
  muted: boolean; // per-channel mute (independent of the global mic mute)
  muteGain: number; // 0..1, slewed toward the mute state (click-free)
  actEnv: EnvelopeFollower; // pre-leveler level, to tell the talker from bleed
  voice: VoiceDetector; // noise floor, speech level, voiced frames
  active: boolean;
  mixDelay: DelayLine | null; // audio delay of the mix look-ahead
  gainLead: DelayLine | null; // automix gain, delayed to line up with the audio
  prioritised: boolean; // gives way to the priority mic
  dryDelay: DelayLine | null; // dry tap (multitrack, listening): raw input, programme-aligned
  tapDelay: DelayLine | null; // multitrack tap (processed): limiter alignment
  tap: number; // last processed-tap sample
}

interface MusicNode {
  label: string;
  left: number; // 0-based capture channel (-1 when virtual)
  right: number;
  gain: number;
  ducked: boolean;
  leveler: MusicLeveler | null; // one gain per item, with the look-ahead (pre-duck)
  itemStart: boolean; // a new file starts with this block
  virtual: boolean; // true for the local file player (fed via setFileBlock)
  meter: EnvelopeFollower; // tracks the channel's post-leveler/gain peak level
  muted: boolean; // per-channel mute
  delayL: DelayLine | null; // programme path: lines the music up with the mics
  delayR: DelayLine | null;
  dryL: DelayLine | null; // multitrack tap (dry): undecorated source
  dryR: DelayLine | null;
  tapL: DelayLine | null; // multitrack tap (processed): limiter alignment
  tapR: DelayLine | null;
  progL: number; // this tick's sample in the programme path (pre-duck)
  progR: number;
}

/** Extra outputs of one `process()` call. All optional. */
export interface GraphAux {
  /** Music return for the room: the music mix, ducked as on air but without
   *  mics, in room time (no look-ahead). */
  retL?: Float32Array;
  retR?: Float32Array;
  /** Multitrack channels, sample-aligned with outL/outR: one per mic, two per
   *  music source, then the programme L/R (see `Graph.tapLayout`). Only
   *  written when the graph was built with `output.multitrack.enabled`. */
  taps?: Float32Array[];
  /** One per mic: the raw input, sample-aligned with outL/outR (listening,
   *  "Roh"). Only written when the graph was built with `dryTaps`. */
  dry?: Float32Array[];
}

export interface GraphOptions {
  /** Extra delay of the music in the programme path, in ms. The room hears
   *  the music through the return output with that output's latency and
   *  talks to what it hears; delaying the programme's music by the same
   *  amount keeps talk and music lined up on air as they were in the room. */
  musicDelayMs?: number;
  /** Keep a dry tap per mic, aligned with the programme, whether or not the
   *  multitrack is on (listening on the tablet compares the two). */
  dryTaps?: boolean;
}

/** A mic counts as the talker only within this many dB of the loudest mic … */
const DOMINANCE_DB = 10;
/** … and above this absolute level (linear; -60 dBFS). */
const ACTIVE_FLOOR = 1e-3;
/** Loudness of a mono signal sent to both channels, over the signal itself. */
const MONO_ON_BOTH_DB = 10 * Math.log10(2);
/** Host-priority key level above which the priority mic counts as acting. */
const PRIORITY_ACTIVE_DB = -0.5;
/** Range of the live music level on air (dB) and how fast a change glides. */
const MUSIC_GAIN_MIN_DB = -12;
const MUSIC_GAIN_MAX_DB = 6;
const MUSIC_GAIN_SLEW_MS = 50;

/**
 * The full studiobox processing graph. Stateful; one instance per run.
 * `process()` consumes a block of de-interleaved input channels and writes a
 * stereo block to `outL`/`outR`.
 *
 * Timing. The mic path runs behind its own analysis (config `lookahead`):
 * the gate by a few ms, the leveler and the duck plan by seconds, automix
 * shares and host priority by ~150 ms. The music is delayed by the same
 * total so it stays lined up with the talk. The programme therefore leaves
 * the graph `latencySamples` behind the room — a delay the buffered design
 * wants anyway (see `audio/air-fifo.ts`). Per-channel meters are reported in
 * room time, the master meters in programme time.
 */
export class Graph {
  private mics: MicNode[] = [];
  /** Channel label -> configured marker colour, for the snapshot. */
  private colors = new Map<string, string>();
  private music: MusicNode[] = [];
  private automix: Automix | null = null;
  private automixBuf: Float32Array;
  private micOut: Float32Array; // per-mic levelled sample of the current tick
  private priority: Priority | null = null;
  private priorityMic = -1; // index into mics
  private priorityLead: DelayLine | null = null;
  private priorityDb = 0; // attenuation applied to the prioritised mics now
  private ducker: Ducker;
  private planner: DuckPlanner;
  private voiced: boolean[];
  private strong: boolean[];
  private readonly frame: number;
  private inFrame = 0;
  private returnDucker: Ducker;
  private returnGainDb: number; // output.return.gainDb, live from the page
  private returnGain: number;
  private musicGainDb = 0; // "Musik-Lautstärke": music on air, live from the page
  private musicGainTarget = 1;
  private musicGainNow = 1; // slewed toward the target (click-free)
  private musicGainCoef: number;
  private limiter: Limiter;
  private outMeter: StereoLoudness;
  private preMeter: StereoLoudness;
  private outPeak: EnvelopeFollower;
  private muteCoef: number;
  private dominance = dbToGain(-DOMINANCE_DB);

  private master: MasterLeveler;

  // "music only" mode: mutes the mic bus (set live from the meters page)
  private micsMuted = false;

  // Local file player: a virtual music source fed one block at a time.
  private fileL: Float32Array;
  private fileR: Float32Array;
  private filePlaying: string | null = null;
  private filePlayingAt: { folder: number; name: string } | null = null;
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

  /** Samples the mic path runs behind the room before the limiter. */
  private readonly mixLatency: number;
  /** Samples the programme output runs behind the room (mic path). */
  readonly latencySamples: number;
  /** Samples the music runs behind its input in the programme. */
  readonly musicLatencySamples: number;
  private readonly tapSource: 'dry' | 'processed' | null;

  constructor(
    private cfg: StudioboxConfig,
    opts: GraphOptions = {}
  ) {
    const sr = cfg.capture.sampleRate;
    const members = cfg.automix.enabled ? cfg.automix.members : [];
    const look = cfg.lookahead ?? { seconds: 0, gateMs: 0, mixMs: 0 };
    const gateN = Math.max(0, Math.round((look.gateMs / 1000) * sr));
    const levN = Math.max(0, Math.round(look.seconds * sr));
    const mixN = Math.max(0, Math.round((look.mixMs / 1000) * sr));
    const limN = Math.max(1, Math.round((cfg.master.limiterLookaheadMs / 1000) * sr));
    const musicExtra = Math.max(0, Math.round(((opts.musicDelayMs ?? 0) / 1000) * sr));
    this.mixLatency = gateN + levN + mixN;
    this.latencySamples = this.mixLatency + limN;
    this.musicLatencySamples = this.mixLatency + musicExtra + limN;
    const musicN = this.mixLatency + musicExtra;
    const mt = cfg.output?.multitrack;
    this.tapSource = mt?.enabled ? mt.source : null;
    const dry = this.tapSource === 'dry';
    const processed = this.tapSource === 'processed';
    const micDry = dry || !!opts.dryTaps;

    const pri = cfg.automix.priority;
    const priOn = !!pri?.enabled;

    for (const ch of cfg.channels) {
      if (ch.color) this.colors.set(ch.label, ch.color);
      if (ch.role === 'mic') {
        this.mics.push({
          label: ch.label,
          strip: new ChannelStrip(ch.processing, sr, { gate: gateN, leveler: levN }),
          processing: ch.processing,
          source: (ch.source as number) - 1,
          automixSlot: members.indexOf(ch.label),
          muted: false,
          muteGain: 1,
          actEnv: new EnvelopeFollower(sr, 5, 200),
          voice: new VoiceDetector(sr),
          active: false,
          mixDelay: mixN > 0 ? new DelayLine(mixN) : null,
          gainLead: mixN > 0 ? new DelayLine(mixN) : null,
          prioritised: priOn && pri.attenuate.includes(ch.label),
          dryDelay: micDry ? new DelayLine(this.latencySamples) : null,
          tapDelay: processed ? new DelayLine(limN) : null,
          tap: 0,
        });
      } else if (ch.role === 'music') {
        const [l, r] = ch.source as [number, number];
        this.music.push(
          this.musicNode(
            ch.label,
            l - 1,
            r - 1,
            ch.processing,
            cfg.duck.targets.includes(ch.label),
            false,
            musicN,
            limN
          )
        );
      }
    }

    const memberCount = members.filter((m) => this.mics.some((x) => x.label === m)).length;
    if (cfg.automix.enabled && memberCount > 0) {
      this.automix = new Automix(members.length, sr, cfg.automix.responseMs, cfg.automix.floorDb);
    }
    this.automixBuf = new Float32Array(members.length);
    this.micOut = new Float32Array(this.mics.length);

    if (priOn) {
      this.priorityMic = this.mics.findIndex((m) => m.label === pri.label);
      if (this.priorityMic >= 0) {
        this.priority = new Priority(pri, sr, look.mixMs);
        this.priorityLead = mixN > 0 ? new DelayLine(mixN) : null;
      }
    }

    if (cfg.filePlayer?.enabled) {
      const fp = cfg.filePlayer;
      this.music.push(
        this.musicNode(fp.label, -1, -1, fp.processing, fp.ducked, true, musicN, limN)
      );
    }
    this.fileL = new Float32Array(cfg.capture.blockSize);
    this.fileR = new Float32Array(cfg.capture.blockSize);

    // The programme ducks on confirmed talk, planned in room time and acted
    // on when that talk reaches the programme (the mic path's latency). The
    // planner holds; the ducker only glides. The music starts down three
    // attack time constants ahead, so it is (nearly) there at the first word.
    this.frame = Math.round((FRAME_MS / 1000) * sr);
    this.planner = new DuckPlanner(
      {
        minSpeechMs: cfg.duck.minSpeechMs ?? 300,
        minStrongMs: 30,
        gapMs: 150,
        leadMs: 3 * cfg.duck.attackMs,
        holdMs: cfg.duck.holdMs,
      },
      this.mics.length,
      Math.round(this.mixLatency / this.frame)
    );
    this.voiced = this.mics.map(() => false);
    this.strong = this.mics.map(() => false);
    this.ducker = new Ducker({ ...cfg.duck, holdMs: 0 }, sr);
    this.returnDucker = new Ducker(cfg.duck, sr);
    this.returnGainDb = cfg.output?.return?.gainDb ?? 0;
    this.returnGain = dbToGain(this.returnGainDb);
    this.limiter = new Limiter(
      sr,
      cfg.master.truePeakDb,
      cfg.master.limiterLookaheadMs,
      cfg.master.limiterReleaseMs
    );
    this.outMeter = new StereoLoudness(sr);
    this.preMeter = new StereoLoudness(sr);
    this.outPeak = new EnvelopeFollower(sr, 1, 200);
    // The master learns how loud the talk comes out of the mic levelers and
    // starts from their target, so the first sentence airs at the right level.
    // The levelers measure one mic; on air it is on both channels, +3 dB.
    const targets = cfg.channels
      .filter((c) => c.role === 'mic' && c.processing.leveler.enabled)
      .map((c) => c.processing.leveler.targetLufs);
    const seed = targets.length
      ? targets.reduce((a, b) => a + b, 0) / targets.length + MONO_ON_BOTH_DB
      : cfg.master.targetLufs;
    this.master = new MasterLeveler(cfg.master.targetLufs, seed, sr);
    this.muteCoef = msToCoef(5, sr);
    this.musicGainCoef = msToCoef(MUSIC_GAIN_SLEW_MS, sr);

    this.snapshot = this.buildSnapshot(null, 0);
  }

  private musicNode(
    label: string,
    left: number,
    right: number,
    processing: ChannelProcessing,
    ducked: boolean,
    virtual: boolean,
    delayN: number,
    limN: number
  ): MusicNode {
    const sr = this.cfg.capture.sampleRate;
    const line = (n: number): DelayLine | null => (n > 0 ? new DelayLine(n) : null);
    const dry = this.tapSource === 'dry';
    const processed = this.tapSource === 'processed';
    return {
      label,
      left,
      right,
      gain: dbToGain(processing.gainDb),
      ducked,
      leveler: processing.leveler.enabled ? new MusicLeveler(processing.leveler, sr, delayN) : null,
      itemStart: false,
      virtual,
      meter: new EnvelopeFollower(sr, 1, 200),
      muted: false,
      delayL: line(delayN),
      delayR: line(delayN),
      dryL: dry ? line(delayN + limN) : null,
      dryR: dry ? line(delayN + limN) : null,
      tapL: processed ? line(limN) : null,
      tapR: processed ? line(limN) : null,
      progL: 0,
      progR: 0,
    };
  }

  /** Channel order of `GraphAux.taps`, or null when multitrack is off. */
  get tapLayout(): string[] | null {
    if (!this.tapSource) return null;
    return [
      ...this.mics.map((m) => m.label),
      ...this.music.flatMap((m) => [`${m.label} L`, `${m.label} R`]),
      'Programm L',
      'Programm R',
    ];
  }

  /**
   * @param input de-interleaved channels (index = capture channel, 0-based)
   * @param aux optional extra outputs (music return, multitrack taps)
   */
  process(
    input: Float32Array[],
    outL: Float32Array,
    outR: Float32Array,
    frames: number,
    aux: GraphAux = {}
  ): void {
    const mics = this.mics;
    const micOut = this.micOut;
    const stereoOut: [number, number] = [0, 0];
    const taps = this.tapSource ? aux.taps : undefined;
    const dryTaps = this.tapSource === 'dry';
    const nMics = mics.length;
    let lastAutomixGains: Float32Array | null = null;
    let lastDuck = 0;

    for (let n = 0; n < frames; n++) {
      // --- mic strips, first half (room time): trim .. compressor ---
      let loudest = 0;
      for (let i = 0; i < nMics; i++) {
        const m = mics[i];
        const x = input[m.source][n];
        if (m.dryDelay) {
          const d = m.dryDelay.process(x);
          if (dryTaps && taps) taps[i][n] = d;
          if (aux.dry) aux.dry[i][n] = d;
        }
        micOut[i] = m.strip.pre(x);
        const e = m.actEnv.process(micOut[i]);
        if (e > loudest) loudest = e;
      }

      // --- who is talking -> leveler key; mutes; leveler + look-ahead delay ---
      // A mute acts here, in room time: what is said after "Mikros zu" never
      // reaches the air, while what was said before it still plays out.
      // The talker is the mic whose gate is open, that is not just bleed of a
      // louder neighbour, and whose voice detector hears talk (not noise).
      let roomKey = 0; // the mic bus as it stands in the room (for the return)
      const need = Math.max(ACTIVE_FLOOR, loudest * this.dominance);
      const frameDone = ++this.inFrame >= this.frame;
      if (frameDone) this.inFrame = 0;
      for (let i = 0; i < nMics; i++) {
        const m = mics[i];
        const off = m.muted || this.micsMuted;
        const target = off ? 0 : 1;
        m.muteGain = this.muteCoef * (m.muteGain - target) + target;
        const talker = !off && m.strip.gateIsOpen && m.actEnv.value >= need;
        if (m.voice.process(m.strip.input, talker)) m.strip.setNoiseFloor(m.voice.floorDb);
        m.active = talker && m.voice.voiced;
        if (frameDone) {
          this.voiced[i] = !off && m.voice.voiced;
          this.strong[i] = !off && m.voice.strong;
        }
        const c = micOut[i] * m.muteGain;
        roomKey += c * m.strip.roomGain;
        micOut[i] = m.strip.level(c, m.active);
      }

      // --- gain-sharing automix (decided on the not-yet-delayed signal) ---
      // The shares compare the mics as they come in (after the trim, without
      // the leveler's gain): a quiet mic's leveler boosts its bleed and noise
      // too, and that must not take the share from the mic someone talks into.
      let gains: Float32Array | null = null;
      if (this.automix) {
        for (let i = 0; i < nMics; i++) {
          const slot = mics[i].automixSlot;
          if (slot < 0) continue;
          const rg = mics[i].strip.roomGain;
          this.automixBuf[slot] = micOut[i] / (rg > 1e-6 ? rg : 1e-6);
        }
        gains = this.automix.process(this.automixBuf);
        lastAutomixGains = gains;
      }

      // --- host priority (keyed on the priority mic as it enters the mix) ---
      if (this.priority) {
        const pm = mics[this.priorityMic];
        const pg = gains && pm.automixSlot >= 0 ? gains[pm.automixSlot] : 1;
        const now = this.priority.process(micOut[this.priorityMic] * pg);
        // Lead: down as soon as the decision is made, up again only when the
        // audio that ended the priority has actually passed.
        const aligned = this.priorityLead ? this.priorityLead.process(now) : now;
        this.priorityDb = Math.min(now, aligned);
      }
      const priGain = this.priorityDb < -0.01 ? dbToGain(this.priorityDb) : 1;

      // --- talk confirmed in room time -> the duck plan ---
      if (frameDone) this.planner.push(this.voiced, this.strong);

      // --- mic bus: the audio runs `mixMs` behind the decisions above ---
      let micBus = 0;
      for (let i = 0; i < nMics; i++) {
        const m = mics[i];
        const gNow = gains && m.automixSlot >= 0 ? gains[m.automixSlot] : 1;
        let g = gNow;
        let a = micOut[i];
        if (m.mixDelay) {
          a = m.mixDelay.process(a);
          // Shares rise ahead of the speech and fall with it, never before.
          const gAligned = m.gainLead!.process(gNow);
          if (gAligned > g) g = gAligned;
        }
        const s = a * g * (m.prioritised ? priGain : 1);
        micBus += s;
        if (m.tapDelay && taps) taps[i][n] = m.tapDelay.process(s);
      }

      // --- music sources: leveler + meters in room time ---
      let retTgtL = 0,
        retTgtR = 0,
        retOthL = 0,
        retOthR = 0,
        tgtL = 0,
        tgtR = 0,
        othL = 0,
        othR = 0;
      let tapIdx = nMics;
      // Music on air: one gain for every music source, after its leveler and
      // before the duck (the room's return keeps its own level).
      const mt = this.musicGainTarget;
      this.musicGainNow = this.musicGainCoef * (this.musicGainNow - mt) + mt;
      const mg = this.musicGainNow;
      for (const mu of this.music) {
        const rawL = mu.virtual ? this.fileL[n] : input[mu.left][n];
        const rawR = mu.virtual ? this.fileR[n] : input[mu.right][n];
        if (dryTaps && taps) {
          taps[tapIdx][n] = mu.dryL ? mu.dryL.process(rawL) : rawL;
          taps[tapIdx + 1][n] = mu.dryR ? mu.dryR.process(rawR) : rawR;
        }
        let l = rawL * mu.gain;
        let r = rawR * mu.gain;
        // Level each item by its stereo loudness, one gain for both sides so
        // the stereo image stays. The room (return, meter) gets the causal gain
        // now; the programme gets the look-ahead gain where the music leaves
        // its delay. Both before ducking, so speech still pulls music down.
        let rg = 1;
        if (mu.leveler) {
          if (mu.itemStart && n === 0) mu.leveler.newItem();
          mu.leveler.process(l, r);
          rg = mu.leveler.roomGain;
        }
        // Track this channel's own output level (post-leveler/gain, pre-duck)
        // so the meters page shows a real "out dB" for music/file sources.
        mu.meter.process(Math.max(Math.abs(l), Math.abs(r)) * rg);
        // Per-channel mute: meter still tracks the source, but it contributes
        // nothing to the mix.
        if (mu.muted) {
          l = 0;
          r = 0;
        }
        if (mu.ducked) {
          retTgtL += l * rg;
          retTgtR += r * rg;
        } else {
          retOthL += l * rg;
          retOthR += r * rg;
        }
        // Programme path: the same music, delayed to line up with the mics.
        const pg = (mu.leveler ? mu.leveler.programmeGain : 1) * mg;
        const dl = (mu.delayL ? mu.delayL.process(l) : l) * pg;
        const dr = (mu.delayR ? mu.delayR.process(r) : r) * pg;
        mu.progL = dl;
        mu.progR = dr;
        if (mu.ducked) {
          tgtL += dl;
          tgtR += dr;
        } else {
          othL += dl;
          othR += dr;
        }
        tapIdx += 2;
      }

      // --- music return for the room: ducked like on air, but now ---
      if (aux.retL && aux.retR) {
        const rg = this.returnDucker.process(roomKey, (retTgtL + retTgtR) * 0.5);
        aux.retL[n] = (retTgtL * rg + retOthL) * this.returnGain;
        aux.retR[n] = (retTgtR * rg + retOthR) * this.returnGain;
      }

      // --- programme ducking (planned on confirmed talk, see the planner) ---
      const duckGain = this.ducker.step(this.planner.ducking, (tgtL + tgtR) * 0.5);
      lastDuck = this.ducker.depthDb;
      const musicL = tgtL * duckGain + othL;
      const musicR = tgtR * duckGain + othR;
      if (this.tapSource === 'processed' && taps) {
        let t = nMics;
        for (const mu of this.music) {
          const g = mu.ducked ? duckGain : 1;
          taps[t][n] = mu.tapL!.process(mu.progL * g);
          taps[t + 1][n] = mu.tapR!.process(mu.progR * g);
          t += 2;
        }
      }

      // --- master sum + talk-keyed master leveler ---
      // The music gets the master's starting gain, the talk that plus what
      // the master learned about the talk (see MasterLeveler).
      this.preMeter.process(micBus + musicL, micBus + musicR);
      if (frameDone) this.master.frame(this.planner.talking, this.preMeter.momentaryLufs);
      const tg = this.master.next();
      const bg = this.master.baseGain;
      const mL = micBus * tg + musicL * bg;
      const mR = micBus * tg + musicR * bg;

      // --- brick-wall limiter + output metering ---
      this.limiter.process(stereoOut, mL, mR);
      outL[n] = stereoOut[0];
      outR[n] = stereoOut[1];
      if (taps) {
        taps[tapIdx][n] = stereoOut[0];
        taps[tapIdx + 1][n] = stereoOut[1];
      }
      this.outMeter.process(stereoOut[0], stereoOut[1]);
      this.outPeak.process(Math.max(Math.abs(stereoOut[0]), Math.abs(stereoOut[1])));
    }

    for (const mu of this.music) mu.itemStart = false;
    this.snapshot = this.buildSnapshot(lastAutomixGains, lastDuck);
  }

  private buildSnapshot(gains: Float32Array | null, duckDepth: number): MeterSnapshot {
    const channels: ChannelMeter[] = [];
    for (const m of this.mics) {
      const sm = m.strip.meters();
      channels.push({
        label: m.label,
        role: 'mic',
        color: this.colors.get(m.label) ?? null,
        ...sm,
        automixGainDb: gains && m.automixSlot >= 0 ? gainToDb(gains[m.automixSlot]) : 0,
        muted: m.muted,
        active: m.active,
        priorityDb: m.prioritised ? this.priorityDb : 0,
        trimDb: m.processing.trimDb ?? 0,
      });
    }
    for (const mu of this.music) {
      channels.push({
        label: mu.label,
        role: 'music',
        color: this.colors.get(mu.label) ?? null,
        outDb: gainToDb(mu.meter.value),
        gateOpen: 1,
        compGrDb: 0,
        levelerDb: mu.leveler ? mu.leveler.gainDbValue : 0,
        speechDb: null,
        zone: null,
        zoneCenterDb: 0,
        zoneWidthDb: 0,
        automixGainDb: 0,
        muted: mu.muted,
        active: false,
        priorityDb: 0,
        trimDb: 0,
      });
    }
    return {
      channels,
      duckDepthDb: duckDepth,
      masterGainDb: this.master ? this.master.gainDbValue : 0,
      limiterGrDb: this.limiter.gainReductionDb,
      momentaryLufs: this.outMeter.momentaryLufs,
      shortTermLufs: this.outMeter.shortTermLufs,
      outPeakDb: gainToDb(this.outPeak.value),
      micsMuted: this.micsMuted,
      filePlaying: this.filePlaying,
      filePlayingAt: this.filePlayingAt,
      filePosition: this.filePosition,
      fileDuration: this.fileDuration,
      recording: this.recording,
      streaming: this.streaming,
      monitor: this.monitor,
      nextScheduled: this.nextScheduled,
      serverNowMs: Date.now(),
      lookaheadMs: (this.latencySamples / this.cfg.capture.sampleRate) * 1000,
      priority: this.priority
        ? {
            label: this.mics[this.priorityMic].label,
            depthDb: this.priority.depthDb,
            active: this.priorityDb < PRIORITY_ACTIVE_DB,
          }
        : null,
    };
  }

  /** Toggle "music only" mode (mutes all mics). Driven from the meters page.
   *  Takes effect in room time: see the mute note in `process()`. */
  setMicsMuted(muted: boolean): void {
    this.micsMuted = muted;
  }

  get micsAreMuted(): boolean {
    return this.micsMuted;
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

  /** Labels of the mic channels, in channel order. */
  get micLabels(): string[] {
    return this.mics.map((m) => m.label);
  }

  /** 0-based capture channel of each mic, in channel order. */
  get micSources(): number[] {
    return this.mics.map((m) => m.source);
  }

  /** The processing parameters a mic currently runs with. */
  getProcessing(label: string): ChannelProcessing | null {
    return this.mics.find((m) => m.label === label)?.processing ?? null;
  }

  /** Retune a running mic strip (setup assistant, live trims). `seedDb`
   *  restarts its leveler from that gain. Returns false for an unknown label. */
  retune(label: string, processing: ChannelProcessing, seedDb?: number): boolean {
    const mic = this.mics.find((m) => m.label === label);
    if (!mic) return false;
    mic.processing = processing;
    mic.strip.retune(processing, seedDb);
    // Visible at once, not only with the next audio block.
    const ch = this.snapshot.channels.find((c) => c.role === 'mic' && c.label === label);
    if (ch) Object.assign(ch, mic.strip.meters(), { trimDb: processing.trimDb ?? 0 });
    return true;
  }

  /** Change the automix noise floor live (setup assistant). */
  setAutomixFloor(db: number): void {
    if (this.automix) this.automix.floorDb = db;
  }

  /** Leveler gain a mic stands at now (dB), or null for an unknown label. */
  levelerDb(label: string): number | null {
    const mic = this.mics.find((m) => m.label === label);
    return mic ? mic.strip.meters().levelerDb : null;
  }

  /** Level of the music return (dB, clamped to -60..+12). The room's
   *  headphones only; the programme is untouched. */
  setReturnGain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.returnGainDb = Math.min(12, Math.max(-60, db));
    this.returnGain = dbToGain(this.returnGainDb);
  }

  get returnLevelDb(): number {
    return this.returnGainDb;
  }

  /** Level of the music on air (dB, clamped to -12..+6): every music source
   *  after its leveler, before the duck. The mics and the return stay put. */
  setMusicGain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.musicGainDb = Math.min(MUSIC_GAIN_MAX_DB, Math.max(MUSIC_GAIN_MIN_DB, db));
    this.musicGainTarget = dbToGain(this.musicGainDb);
  }

  get musicLevelDb(): number {
    return this.musicGainDb;
  }

  /** Change the host-priority depth live. No-op when priority is not configured. */
  setPriorityDepth(db: number): void {
    if (this.priority) this.priority.depthDb = db;
  }

  get priorityDepthDb(): number | null {
    return this.priority ? this.priority.depthDb : null;
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
    duration: number | null = null,
    at: { folder: number; name: string } | null = null
  ): void {
    this.fileL.set(l);
    this.fileR.set(r);
    // A different file (or the first after a pause) is a new item for the
    // music leveler.
    if (playing !== null && playing !== this.filePlaying) {
      for (const mu of this.music) if (mu.virtual) mu.itemStart = true;
    }
    this.filePlaying = playing;
    this.filePlayingAt = playing ? at : null;
    this.filePosition = playing ? position : null;
    this.fileDuration = playing ? duration : null;
  }

  /** The latest snapshot, with the live status fields (recording, schedule,
   *  file position, clock) as they stand now rather than as of the last block. */
  getMeters(): MeterSnapshot {
    return {
      ...this.snapshot,
      micsMuted: this.micsMuted,
      filePlaying: this.filePlaying,
      filePlayingAt: this.filePlayingAt,
      filePosition: this.filePosition,
      fileDuration: this.fileDuration,
      recording: this.recording,
      streaming: this.streaming,
      monitor: this.monitor,
      nextScheduled: this.nextScheduled,
      serverNowMs: Date.now(),
    };
  }
}

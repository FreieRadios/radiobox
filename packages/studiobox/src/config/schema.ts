/** Configuration types for studiobox. The YAML is parsed and normalized
 *  into these fully-resolved shapes (profiles merged into each channel). */

export type Role = 'mic' | 'music' | 'line' | 'unused';
export type CaptureBackend = 'alsa' | 'pulse';
export type OutputFormat = 'ogg-flac' | 'mp3';

export type EqType = 'highpass' | 'lowpass' | 'peaking' | 'lowshelf' | 'highshelf';

export interface EqBand {
  type: EqType;
  freq: number;
  gainDb: number;
  q: number;
}

export interface GateParams {
  enabled: boolean;
  thresholdDb: number;
  rangeDb: number; // attenuation applied when closed (negative dB)
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface CompressorParams {
  enabled: boolean;
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface DeesserParams {
  enabled: boolean;
  freq: number;
  thresholdDb: number;
  ratio: number;
}

export interface LevelerParams {
  enabled: boolean;
  targetLufs: number;
  maxGainDb: number;
  rangeDb: number;
  responseMs: number;
}

/** Fully-resolved per-channel processing chain. */
export interface ChannelProcessing {
  hpfHz: number;
  gate: GateParams;
  eq: EqBand[];
  deesser: DeesserParams;
  compressor: CompressorParams;
  leveler: LevelerParams;
  gainDb: number;
}

export interface ChannelConfig {
  /** 1-based capture channel index; a [L,R] pair for stereo sources. */
  source: number | [number, number];
  role: Role;
  label: string;
  profile?: string;
  processing: ChannelProcessing;
}

export interface CaptureConfig {
  backend: CaptureBackend;
  device: string;
  sampleRate: number;
  channels: number;
  blockSize: number;
}

export interface AutomixConfig {
  enabled: boolean;
  members: string[];
  responseMs: number;
  floorDb: number;
}

export interface DuckConfig {
  enabled: boolean;
  targets: string[];
  thresholdDb: number;
  musicPresentDb: number;
  depthDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface MasterConfig {
  targetLufs: number;
  truePeakDb: number;
  limiterLookaheadMs: number;
  limiterReleaseMs: number;
}

export interface HarborConfig {
  enabled: boolean;
  url: string;
  format: OutputFormat;
  contentType: string;
}

export interface BackupConfig {
  enabled: boolean;
  dir: string;
  segmentSeconds: number;
}

/** Direct local hardware playout: the finished program stream is sent to a
 *  locally plugged audio device (sound card / USB interface) for monitoring or
 *  to feed a transmitter/PA. Independent of the harbor stream and FLAC backup. */
export interface MonitorConfig {
  enabled: boolean;
  /** Output driver: `alsa` (via aplay) or `pulse` (PulseAudio/PipeWire via ffmpeg). */
  backend: CaptureBackend;
  /** Device name: an ALSA PCM (e.g. `hw:CARD=USB`) or a PulseAudio sink name
   *  (empty selects the default sink). */
  device: string;
}

export interface OutputConfig {
  harbor: HarborConfig;
  backup: BackupConfig;
  monitor: MonitorConfig;
}

export interface MetersConfig {
  enabled: boolean;
  port: number;
  fps: number;
}

/** One browsable folder exposed by the file player. The meters page shows a
 *  dropdown of these and lists only the audio files directly inside the
 *  selected one (no traversal). */
export interface FilePlayerDir {
  /** Filesystem path of the browsable directory. */
  path: string;
  /** Human-friendly name shown in the folder dropdown. */
  label: string;
  /** Whether this directory is scanned (recursively) for timestamped
   *  auto-play files. Off by default: a music library full of arbitrary
   *  filenames should never be able to preempt the program. */
  hasScheduled: boolean;
  /** Hide subfolders that contain no audio anywhere beneath them (bounded
   *  probe), so the browser only shows folders with useful contents. On by
   *  default; set `false` to list every subfolder unconditionally (e.g. on a
   *  pathological network share where the probe is too costly). */
  hideEmpty?: boolean;
  /** Emoji shown for this folder in the ⋮ menu and on the welcome tiles.
   *  The loader always fills this in (guessed from the label/path when the
   *  config omits it — see `guessDirIcon`); optional so callers constructing a
   *  dir directly, e.g. tests, don't have to. */
  icon?: string;
}

/** Scheduled auto-play by filename timestamp. Files named `*YYYYMMDD-HHMMSS*`
 *  in the file-player folders start playing automatically when their embedded
 *  wallclock time arrives (TypeScript port of the liquidsoap
 *  `play_by_filename.liq` repeat scheduling, minus the prefetch machinery —
 *  local files decode instantly, so there is nothing to prefetch). */
export interface AutoPlayConfig {
  enabled: boolean;
  /** How often the folders are rescanned for due/new files, in seconds. */
  scanSeconds: number;
  /** How long after its timestamp a file still auto-starts, in seconds.
   *  Covers scan-tick granularity and late daemon starts; a file older than
   *  this never auto-plays (matching the liquidsoap lead-window semantics
   *  where past targets are skipped). */
  graceSeconds: number;
}

/** Optional local audio file player exposed on the meters page. Files from the
 *  configured `dirs` are decoded to 48 kHz stereo and routed into the music
 *  path so they share the music AGC loudness normalization and sidechain
 *  ducking. */
export interface FilePlayerConfig {
  enabled: boolean;
  /** Browsable root directories; only audio files directly inside are exposed. */
  dirs: FilePlayerDir[];
  /** Meter/label shown for the virtual music source. */
  label: string;
  /** Whether the player is a ducking target (pulled under live speech). */
  ducked: boolean;
  /** Fade-out duration (ms) applied when the operator stops playback so the
   *  audio is ramped to silence instead of cut abruptly. */
  fadeOutMs: number;
  /** Jitter-buffer depth (ms) filled before playout starts. Higher values
   *  resist startup/underrun crackle on slow hardware at the cost of more
   *  start latency. */
  prebufferMs: number;
  /** Scheduled auto-play of timestamped files (see AutoPlayConfig). */
  autoPlay: AutoPlayConfig;
  /** Music-style processing (leveler/gain) applied to the decoded audio. */
  processing: ChannelProcessing;
}

/** Top-level operating mode.
 *  - `live` (default): the full capture -> DSP -> outputs pipeline.
 *  - `playout`: no capture, no DSP graph, no encoder/recorder — only the file
 *    player feeding the local hardware output, plus the web UI and the
 *    filename-timestamp scheduler. Built for low-memory machines (Pi) that
 *    only need scheduled playout. */
export type Mode = 'live' | 'playout';

export interface StudioboxConfig {
  mode: Mode;
  capture: CaptureConfig;
  channels: ChannelConfig[];
  automix: AutomixConfig;
  duck: DuckConfig;
  master: MasterConfig;
  output: OutputConfig;
  meters: MetersConfig;
  filePlayer?: FilePlayerConfig;
}

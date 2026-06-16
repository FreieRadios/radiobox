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

export interface OutputConfig {
  harbor: HarborConfig;
  backup: BackupConfig;
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
  /** Music-style processing (leveler/gain) applied to the decoded audio. */
  processing: ChannelProcessing;
}

export interface StudioboxConfig {
  capture: CaptureConfig;
  channels: ChannelConfig[];
  automix: AutomixConfig;
  duck: DuckConfig;
  master: MasterConfig;
  output: OutputConfig;
  meters: MetersConfig;
  filePlayer?: FilePlayerConfig;
}

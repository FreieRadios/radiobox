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

export interface StudioboxConfig {
  capture: CaptureConfig;
  channels: ChannelConfig[];
  automix: AutomixConfig;
  duck: DuckConfig;
  master: MasterConfig;
  output: OutputConfig;
  meters: MetersConfig;
}

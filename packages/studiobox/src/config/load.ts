import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  AutoPlayConfig,
  ChannelConfig,
  ChannelProcessing,
  FilePlayerConfig,
  FilePlayerDir,
  Mode,
  MonitorConfig,
  OutputConfig,
  StudioboxConfig,
} from './schema';

/** Default processing chain; profiles and per-channel overrides merge on top. */
const DEFAULT_PROCESSING: ChannelProcessing = {
  hpfHz: 80,
  gate: { enabled: true, thresholdDb: -50, rangeDb: -18, attackMs: 3, holdMs: 120, releaseMs: 150 },
  eq: [],
  deesser: { enabled: false, freq: 6500, thresholdDb: -28, ratio: 4 },
  compressor: {
    enabled: true,
    thresholdDb: -20,
    ratio: 3,
    kneeDb: 6,
    attackMs: 10,
    releaseMs: 120,
    makeupDb: 3,
  },
  leveler: { enabled: true, targetLufs: -23, maxGainDb: 12, rangeDb: 12, responseMs: 3000 },
  gainDb: 0,
};

/** Music-channel baseline (merged over DEFAULT before profile/inline overrides).
 *  Music sits a few dB hotter than mics and gets more boost headroom, so a quiet
 *  source still reaches a strong level; ducking still pulls it under speech. */
const MUSIC_OVERRIDES = {
  leveler: { enabled: true, targetLufs: -18, maxGainDb: 24, rangeDb: 12, responseMs: 2000 },
};

type Dict = Record<string, unknown>;
const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `src` onto a clone of `base` (arrays replace, not concat). */
function deepMerge<T>(base: T, src: unknown): T {
  if (!isObj(src)) return base;
  const out: Dict = isObj(base) ? { ...(base as Dict) } : {};
  for (const [k, v] of Object.entries(src)) {
    const prev = out[k];
    out[k] = isObj(v) && isObj(prev) ? deepMerge(prev, v) : v;
  }
  return out as T;
}

/** Normalize EQ bands so every band satisfies the EqBand type: shelves in
 *  particular routinely omit `q`, and an undefined Q would yield NaN biquad
 *  coefficients. Default to a maximally-flat 0.707 and 0 dB. */
function normalizeEq(processing: ChannelProcessing): ChannelProcessing {
  return {
    ...processing,
    eq: (processing.eq ?? []).map((b) => ({
      type: b.type,
      freq: b.freq,
      gainDb: b.gainDb ?? 0,
      q: b.q ?? 0.707,
    })),
  };
}

/** Normalize the configured browsable folders. Accepts the new `dirs` array
 *  (each entry a string or `{ path, label }`) and the legacy single `dir`
 *  string for backward compatibility. Labels default to the folder basename. */
function resolveFilePlayerDirs(raw: Dict): FilePlayerDir[] {
  const toDir = (entry: unknown): FilePlayerDir | null => {
    if (typeof entry === 'string') {
      const p = entry.trim();
      if (!p) return null;
      return { path: p, label: path.basename(p.replace(/[/\\]+$/, '')) || p };
    }
    if (isObj(entry) && typeof entry.path === 'string') {
      const p = entry.path.trim();
      if (!p) return null;
      const label =
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim()
          : path.basename(p.replace(/[/\\]+$/, '')) || p;
      return { path: p, label };
    }
    return null;
  };

  const dirs: FilePlayerDir[] = [];
  if (Array.isArray(raw.dirs)) {
    for (const e of raw.dirs) {
      const d = toDir(e);
      if (d) dirs.push(d);
    }
  }
  // Legacy single-directory form.
  if (!dirs.length && raw.dir !== undefined) {
    const d = toDir(raw.dir);
    if (d) dirs.push(d);
  }
  if (!dirs.length) dirs.push({ path: './music', label: 'music' });
  return dirs;
}

/** Normalize the optional filename-timestamp auto-play block. Defaults to
 *  disabled; scan/grace fall back to sensible values when enabled. */
function resolveAutoPlay(raw: unknown): AutoPlayConfig {
  if (!isObj(raw) || !raw.enabled) return { enabled: false, scanSeconds: 10, graceSeconds: 30 };
  const num = (v: unknown, def: number): number =>
    Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def;
  return {
    enabled: true,
    scanSeconds: num(raw.scanSeconds, 10),
    graceSeconds: num(raw.graceSeconds, 30),
  };
}

/** Resolve the optional local file player into a music-style source. */
function resolveFilePlayer(raw: unknown): FilePlayerConfig | undefined {
  if (!isObj(raw) || !raw.enabled) return undefined;
  let processing = deepMerge(DEFAULT_PROCESSING, MUSIC_OVERRIDES);
  if (raw.processing) processing = deepMerge(processing, raw.processing);
  processing = normalizeEq(processing);
  return {
    enabled: true,
    dirs: resolveFilePlayerDirs(raw),
    label: String(raw.label ?? 'FilePlayer'),
    ducked: raw.ducked !== false,
    fadeOutMs: Number.isFinite(Number(raw.fadeOutMs)) ? Number(raw.fadeOutMs) : 800,
    prebufferMs:
      Number.isFinite(Number(raw.prebufferMs)) && Number(raw.prebufferMs) >= 0
        ? Number(raw.prebufferMs)
        : 250,
    autoPlay: resolveAutoPlay(raw.autoPlay),
    processing,
  };
}

/** Normalize the optional local hardware playout (monitor) block. Defaults to
 *  disabled; backend falls back to ALSA. The device is required when enabled
 *  (checked in validate). */
function resolveMonitor(raw: unknown): MonitorConfig {
  if (!isObj(raw)) return { enabled: false, backend: 'alsa', device: '' };
  const backend = raw.backend === 'pulse' ? 'pulse' : 'alsa';
  return {
    enabled: !!raw.enabled,
    backend,
    device: typeof raw.device === 'string' ? raw.device.trim() : '',
  };
}

/** Resolve the output block, filling in the monitor sub-config defaults so it
 *  is always present (harbor/backup are taken from YAML as-is). */
function resolveOutput(raw: unknown): OutputConfig {
  const out = (isObj(raw) ? raw : {}) as unknown as OutputConfig;
  return { ...out, monitor: resolveMonitor(isObj(raw) ? raw.monitor : undefined) };
}

function readYaml(file: string): Dict {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(raw);
  if (!isObj(parsed)) throw new Error(`${file}: expected a YAML mapping at the top level`);
  return parsed;
}

/** Resolve one channel: DEFAULT <- profile <- inline `processing` override. */
function resolveChannel(raw: Dict, profiles: Dict): ChannelConfig {
  const profileName = raw.profile as string | undefined;
  let processing = DEFAULT_PROCESSING;

  if (raw.role === 'music') processing = deepMerge(processing, MUSIC_OVERRIDES);
  if (profileName) {
    const p = profiles[profileName];
    if (!p) throw new Error(`channel "${raw.label}": unknown profile "${profileName}"`);
    processing = deepMerge(processing, p);
  }
  if (raw.processing) processing = deepMerge(processing, raw.processing);

  processing = normalizeEq(processing);

  return {
    source: raw.source as number | [number, number],
    role: (raw.role as ChannelConfig['role']) ?? 'unused',
    label: String(raw.label),
    profile: profileName,
    processing,
  };
}

export interface LoadOptions {
  /** Path to studiobox.yaml; defaults to config/studiobox.yaml then the example. */
  configPath?: string;
  /** Path to profiles.yaml; defaults to config/profiles.yaml. */
  profilesPath?: string;
}

export function loadConfig(opts: LoadOptions = {}): StudioboxConfig {
  const configDir = path.resolve(__dirname, '../../config');
  const configPath =
    opts.configPath ??
    (fs.existsSync(path.join(configDir, 'studiobox.yaml'))
      ? path.join(configDir, 'studiobox.yaml')
      : path.join(configDir, 'studiobox.example.yaml'));
  const profilesPath = opts.profilesPath ?? path.join(configDir, 'profiles.yaml');

  const root = readYaml(configPath);
  const profiles = (readYaml(profilesPath).profiles as Dict) ?? {};

  const rawChannels = Array.isArray(root.channels) ? (root.channels as Dict[]) : [];
  const channels = rawChannels.map((c) => resolveChannel(c, profiles));

  const mode: Mode = root.mode === 'playout' ? 'playout' : 'live';
  const filePlayer = resolveFilePlayer(root.filePlayer);
  const output = resolveOutput(root.output);
  const cfg = { ...root, mode, channels, filePlayer, output } as unknown as StudioboxConfig;
  // Playout-only machines don't capture; the capture block then only supplies
  // the block clock (sample rate / block size) and may be omitted entirely.
  if (mode === 'playout' && !cfg.capture) {
    cfg.capture = { backend: 'alsa', device: '', sampleRate: 48000, channels: 2, blockSize: 4096 };
  }
  validate(cfg, configPath);
  return cfg;
}

/** Cheap structural validation with actionable messages. */
function validate(cfg: StudioboxConfig, file: string): void {
  const fail = (msg: string): never => {
    throw new Error(`${file}: ${msg}`);
  };
  if (cfg.mode === 'playout') {
    // No capture in playout mode: only the file player -> monitor path runs.
    if (!cfg.filePlayer?.enabled) fail('mode "playout" requires filePlayer.enabled');
    if (!cfg.output?.monitor?.enabled) fail('mode "playout" requires output.monitor.enabled');
    if (cfg.output.monitor.backend === 'alsa' && !cfg.output.monitor.device) {
      fail('output.monitor.device is required when monitor is enabled with the alsa backend');
    }
    return;
  }
  if (!cfg.capture?.device) fail('capture.device is required');
  if (!cfg.capture.channels || cfg.capture.channels < 1) fail('capture.channels must be >= 1');
  if (!cfg.channels?.length) fail('at least one channel is required');

  const labels = new Set<string>();
  for (const ch of cfg.channels) {
    if (labels.has(ch.label)) fail(`duplicate channel label "${ch.label}"`);
    labels.add(ch.label);
    const srcs = Array.isArray(ch.source) ? ch.source : [ch.source];
    for (const s of srcs) {
      if (!Number.isInteger(s) || s < 1 || s > cfg.capture.channels) {
        fail(`channel "${ch.label}": source ${s} out of range 1..${cfg.capture.channels}`);
      }
    }
    if (ch.role === 'music' && !Array.isArray(ch.source)) {
      fail(`channel "${ch.label}": music role needs a [left, right] source pair`);
    }
  }
  for (const m of cfg.automix?.members ?? []) {
    if (!labels.has(m)) fail(`automix.members references unknown channel "${m}"`);
  }
  for (const t of cfg.duck?.targets ?? []) {
    if (!labels.has(t)) fail(`duck.targets references unknown channel "${t}"`);
  }
  if (
    cfg.output?.monitor?.enabled &&
    cfg.output.monitor.backend === 'alsa' &&
    !cfg.output.monitor.device
  ) {
    fail('output.monitor.device is required when monitor is enabled with the alsa backend');
  }
}

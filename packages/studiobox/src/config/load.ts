import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  ChannelConfig,
  ChannelProcessing,
  StudioboxConfig,
} from './schema';

/** Default processing chain; profiles and per-channel overrides merge on top. */
const DEFAULT_PROCESSING: ChannelProcessing = {
  hpfHz: 80,
  gate: { enabled: true, thresholdDb: -50, rangeDb: -18, attackMs: 3, holdMs: 120, releaseMs: 150 },
  eq: [],
  deesser: { enabled: false, freq: 6500, thresholdDb: -28, ratio: 4 },
  compressor: {
    enabled: true, thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 120, makeupDb: 3,
  },
  leveler: { enabled: true, targetLufs: -23, maxGainDb: 12, rangeDb: 12, responseMs: 3000 },
  gainDb: 0,
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

  if (profileName) {
    const p = profiles[profileName];
    if (!p) throw new Error(`channel "${raw.label}": unknown profile "${profileName}"`);
    processing = deepMerge(processing, p);
  }
  if (raw.processing) processing = deepMerge(processing, raw.processing);

  // Normalize EQ bands so every band satisfies the EqBand type: shelves in
  // particular routinely omit `q`, and an undefined Q would yield NaN biquad
  // coefficients. Default to a maximally-flat 0.707 and 0 dB.
  processing = {
    ...processing,
    eq: (processing.eq ?? []).map((b) => ({
      type: b.type,
      freq: b.freq,
      gainDb: b.gainDb ?? 0,
      q: b.q ?? 0.707,
    })),
  };

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

  const cfg = { ...root, channels } as unknown as StudioboxConfig;
  validate(cfg, configPath);
  return cfg;
}

/** Cheap structural validation with actionable messages. */
function validate(cfg: StudioboxConfig, file: string): void {
  const fail = (msg: string): never => {
    throw new Error(`${file}: ${msg}`);
  };
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
}

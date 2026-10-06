import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  AirDelayConfig,
  AutomixConfig,
  AutoPlayConfig,
  BackupConfig,
  BedConfig,
  ChannelConfig,
  ChannelProcessing,
  FilePlayerConfig,
  FilePlayerDir,
  ListenersConfig,
  LookaheadConfig,
  MetersConfig,
  Mode,
  MonitorConfig,
  MultitrackConfig,
  ServeConfig,
  StreamFormatName,
  StreamSourceConfig,
  OutputConfig,
  PriorityConfig,
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
 *  Music (measured in stereo) sits 1 LU over the talk, which comes out of the
 *  mic levelers at their target (-23, one mic) + 3 dB for being on both
 *  channels = -20; music gets more boost headroom, so a quiet source still
 *  reaches a strong level; ducking still pulls it under speech. The master
 *  leveler only follows the talk, so this target *is* the balance between
 *  music and talk on air (it was ~1 LU in the sessions of 2026-10-04, when the
 *  master still chased both). */
const MUSIC_OVERRIDES = {
  leveler: { enabled: true, targetLufs: -19, maxGainDb: 24, rangeDb: 12, responseMs: 2000 },
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

/** Keyword -> emoji for the folder icon guess. First match on the label or path
 *  wins, so order matters: put the specific words before the generic ones.
 *  German and English both appear — the stations running this are German. */
const DIR_ICONS: Array<[RegExp, string]> = [
  [/jingle|trailer|sweeper|station.?id/i, '🔔'],
  [/unterleger|instrumental|bed\b|beds\b|underscore/i, '🛏️'],
  [/wiederhol|repeat|replay|nachhör|nachhoer/i, '🔁'],
  [/sendung|programm|show|broadcast|sendeplan/i, '📻'],
  [/nachricht|news|wetter|weather|magazin/i, '📰'],
  [/werbung|spot|promo|advert/i, '📢'],
  [/interview|beitrag|feature|wort|talk|podcast/i, '🎙️'],
  [/thema|themen|sampler|rubrik/i, '🗂️'],
  [/archiv|archive|alt\b|old\b/i, '📦'],
  [/eingang|inbox|import|upload|neu\b|new\b/i, '📥'],
  [/live|studio|mitschnitt/i, '🎛️'],
  [/musik|music|mp3|song|track|album|playlist/i, '🎵'],
  [/cloud|nextcloud|owncloud|sync|share|freigabe/i, '☁️'],
];

/** Guess a folder's emoji from its label (preferred) or path. Falls back to a
 *  neutral folder glyph so every dir always has an icon. */
export function guessDirIcon(label: string, dirPath: string): string {
  for (const [re, icon] of DIR_ICONS) {
    if (re.test(label) || re.test(dirPath)) return icon;
  }
  return '📁';
}

/** Channel marker colours by name (English and German, as for the icons).
 *  Saturated cable/tape tones; the page outlines every swatch, so black stays
 *  visible on the dark theme. */
const CHANNEL_COLORS: Record<string, string> = {
  red: '#e53935',
  rot: '#e53935',
  yellow: '#fdd835',
  gelb: '#fdd835',
  blue: '#1e88e5',
  blau: '#1e88e5',
  green: '#43a047',
  grün: '#43a047',
  gruen: '#43a047',
  black: '#000000',
  schwarz: '#000000',
  white: '#f5f5f5',
  weiß: '#f5f5f5',
  weiss: '#f5f5f5',
  orange: '#fb8c00',
  purple: '#8e24aa',
  violet: '#8e24aa',
  lila: '#8e24aa',
  pink: '#ec407a',
  rosa: '#ec407a',
  grey: '#9e9e9e',
  gray: '#9e9e9e',
  grau: '#9e9e9e',
  brown: '#795548',
  braun: '#795548',
};

/** Resolve a channel's `color` to CSS hex: a name from CHANNEL_COLORS or
 *  `#rgb`/`#rrggbb`. Undefined when unset; throws on anything else, so a typo
 *  fails at load instead of silently showing no colour. */
export function resolveChannelColor(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = String(raw).trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) return v;
  const named = CHANNEL_COLORS[v];
  if (named) return named;
  throw new Error(
    `channel "${label}": unknown color "${raw}" (use #rrggbb or one of ${Object.keys(CHANNEL_COLORS).join(', ')})`
  );
}

/** Normalize the configured browsable folders. Accepts the new `dirs` array
 *  (each entry a string or `{ path, label, hasScheduled, hideEmpty, icon }`)
 *  and the legacy single `dir` string for backward compatibility. Labels
 *  default to the folder basename, icons to a keyword guess; only dirs with
 *  `hasScheduled: true` are scanned for timestamped auto-play files. */
function resolveFilePlayerDirs(raw: Dict): FilePlayerDir[] {
  const toDir = (entry: unknown): FilePlayerDir | null => {
    if (typeof entry === 'string') {
      const p = entry.trim();
      if (!p) return null;
      const label = path.basename(p.replace(/[/\\]+$/, '')) || p;
      return { path: p, label, hasScheduled: false, hideEmpty: true, icon: guessDirIcon(label, p) };
    }
    if (isObj(entry) && typeof entry.path === 'string') {
      const p = entry.path.trim();
      if (!p) return null;
      const label =
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim()
          : path.basename(p.replace(/[/\\]+$/, '')) || p;
      // Prune empty subfolders by default; only an explicit `false` disables it.
      return {
        path: p,
        label,
        hasScheduled: entry.hasScheduled === true,
        hideEmpty: entry.hideEmpty !== false,
        icon:
          typeof entry.icon === 'string' && entry.icon.trim()
            ? entry.icon.trim()
            : guessDirIcon(label, p),
      };
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
  if (!dirs.length)
    dirs.push({
      path: './music',
      label: 'music',
      hasScheduled: false,
      hideEmpty: true,
      icon: '🎵',
    });
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

/** The audio bed: on as soon as a `dir` label is given. */
function resolveBed(raw: unknown): BedConfig {
  const r = isObj(raw) ? raw : {};
  const dir = typeof r.dir === 'string' ? r.dir.trim() : '';
  const num = (v: unknown, def: number): number =>
    v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : def;
  return {
    enabled: r.enabled !== false && dir !== '',
    dir,
    gainDb: num(r.gainDb, -6),
    fadeInMs: Math.max(0, num(r.fadeInMs, 1500)),
    fadeOutMs: Math.max(0, num(r.fadeOutMs, 2500)),
  };
}

/** Resolve the optional local file player into a music-style source. */
const STREAM_FORMATS: readonly StreamFormatName[] = ['mp3', 'ogg', 'flac', 'aac'];

/** The stream's container: as configured, else from the URL (a studiobox
 *  `/stream?format=…`, or the file extension). Naming it spares ffmpeg its
 *  probe (~128 KB read in real time: 5–7 s on a Pi for a 192 kbit/s MP3). */
export function streamFormat(raw: unknown, url: string, label = ''): StreamFormatName | undefined {
  if (raw !== undefined && raw !== null && raw !== '') {
    if (!STREAM_FORMATS.includes(raw as StreamFormatName)) {
      throw new Error(
        `filePlayer.streams "${label}": format must be one of ${STREAM_FORMATS.join(', ')}`
      );
    }
    return raw as StreamFormatName;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const q = u.searchParams.get('format');
  if (u.pathname.endsWith('/stream') && (q === 'flac' || q === null)) return 'ogg';
  if (u.pathname.endsWith('/stream') && q === 'mp3') return 'mp3';
  const ext = path.extname(u.pathname).toLowerCase();
  if (ext === '.mp3') return 'mp3';
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'ogg';
  if (ext === '.flac') return 'flac';
  if (ext === '.aac') return 'aac';
  return undefined;
}

/** Network streams. Only http(s): the URL goes to ffmpeg, which would also
 *  open local files and other protocols. Labels must be unique (they name
 *  the rows). */
function resolveStreams(raw: unknown): StreamSourceConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamSourceConfig[] = [];
  for (const e of raw) {
    if (!isObj(e) || typeof e.url !== 'string' || !/^https?:\/\//i.test(e.url.trim())) {
      throw new Error('filePlayer.streams: every entry needs an http(s) url');
    }
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : 'Stream';
    if (out.some((s) => s.label === label)) {
      throw new Error(`filePlayer.streams: the label "${label}" is used twice`);
    }
    out.push({
      label,
      url: e.url.trim(),
      bufferMs: Math.min(30000, Math.max(500, finite(e.bufferMs, 2000))),
      fallback: e.fallback === 'silence' ? 'silence' : 'bed',
      autoStart: e.autoStart === true,
      format: streamFormat(e.format, e.url.trim(), label),
    });
  }
  if (out.filter((s) => s.autoStart).length > 1) {
    throw new Error('filePlayer.streams: only one stream can have autoStart');
  }
  return out;
}

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
    bed: resolveBed(raw.bed),
    streams: resolveStreams(raw.streams),
    processing,
  };
}

const finite = (v: unknown, def: number): number =>
  v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : def;

/** Normalize a local hardware output block (`output.monitor` — the programme
 *  — or `output.return` — the music return to the room). Defaults to
 *  disabled; backend falls back to ALSA. The device is required when enabled
 *  (checked in validate). */
function resolveMonitor(raw: unknown): MonitorConfig {
  if (!isObj(raw)) return { enabled: false, backend: 'alsa', device: '' };
  const backend = raw.backend === 'pulse' ? 'pulse' : 'alsa';
  const out: MonitorConfig = {
    enabled: !!raw.enabled,
    backend,
    device: typeof raw.device === 'string' ? raw.device.trim() : '',
  };
  const channels = finite(raw.channels, 2);
  if (channels > 2) out.channels = Math.floor(channels);
  if (finite(raw.bufferMs, 0) > 0) out.bufferMs = finite(raw.bufferMs, 0);
  if (finite(raw.periodMs, 0) > 0) out.periodMs = finite(raw.periodMs, 0);
  if (raw.latencyMs !== undefined) out.latencyMs = Math.max(0, finite(raw.latencyMs, 0));
  if (raw.gainDb !== undefined) out.gainDb = Math.min(12, Math.max(-60, finite(raw.gainDb, 0)));
  return out;
}

/** The stereo recording. `segmentSeconds` defaults to 0: one continuous file
 *  per recording. */
function resolveBackup(raw: unknown): BackupConfig {
  const r = isObj(raw) ? raw : {};
  const out: BackupConfig = {
    enabled: !!r.enabled,
    dir: typeof r.dir === 'string' && r.dir.trim() ? r.dir.trim() : './recordings',
    segmentSeconds: Math.max(0, finite(r.segmentSeconds, 0)),
  };
  if (typeof r.station === 'string' && r.station.trim()) out.station = r.station.trim();
  if (typeof r.title === 'string' && r.title.trim()) out.title = r.title.trim();
  return out;
}

function resolveServe(raw: unknown): ServeConfig {
  const r = isObj(raw) ? raw : {};
  return { enabled: !!r.enabled, mp3Kbps: Math.min(320, Math.max(64, finite(r.mp3Kbps, 320))) };
}

function resolveMultitrack(raw: unknown): MultitrackConfig {
  const r = isObj(raw) ? raw : {};
  return { enabled: !!r.enabled, source: r.source === 'processed' ? 'processed' : 'dry' };
}

/** Resolve the output block, filling in the sub-config defaults so every
 *  output is always present (harbor is taken from YAML as-is). */
function resolveOutput(raw: unknown): OutputConfig {
  const r = isObj(raw) ? raw : {};
  const out = r as unknown as OutputConfig;
  return {
    ...out,
    harbor: out.harbor ?? { enabled: false, url: '', format: 'ogg-flac', contentType: '' },
    serve: resolveServe(r.serve),
    backup: resolveBackup(r.backup),
    multitrack: resolveMultitrack(r.multitrack),
    monitor: resolveMonitor(r.monitor),
    return: resolveMonitor(r.return),
  };
}

/** Look-ahead defaults: 6 s for the leveler and the duck plan, 15 ms for the
 *  gate, 150 ms for automix and host priority. `lookahead: { seconds: 0,
 *  gateMs: 0, mixMs: 0 }` gives the old real-time chain. */
function resolveLookahead(raw: unknown): LookaheadConfig {
  const r = isObj(raw) ? raw : {};
  return {
    seconds: Math.min(10, Math.max(0, finite(r.seconds, 6))),
    gateMs: Math.min(100, Math.max(0, finite(r.gateMs, 15))),
    mixMs: Math.min(1000, Math.max(0, finite(r.mixMs, 150))),
  };
}

/** Air delay: 10 s unless configured, 0..60 s. */
function resolveAirDelay(raw: unknown): AirDelayConfig {
  const r = isObj(raw) ? raw : {};
  return {
    seconds: Math.min(60, Math.max(0, finite(r.seconds, 10))),
    toleranceSeconds: Math.min(5, Math.max(0.2, finite(r.toleranceSeconds, 1))),
  };
}

/** Host priority inside the automix block. Off unless a label is given. */
function resolvePriority(raw: unknown): PriorityConfig {
  const r = isObj(raw) ? raw : {};
  const label = typeof r.label === 'string' ? r.label : '';
  return {
    enabled: r.enabled !== false && label !== '',
    label,
    attenuate: Array.isArray(r.attenuate) ? r.attenuate.map(String) : [],
    depthDb: Math.min(0, Math.max(-24, finite(r.depthDb, -8))),
    thresholdDb: finite(r.thresholdDb, -35),
    attackMs: Math.max(0, finite(r.attackMs, 120)),
    holdMs: Math.max(0, finite(r.holdMs, 300)),
    releaseMs: Math.max(0, finite(r.releaseMs, 800)),
  };
}

/** Image types the header logo may be. */
export const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function resolveLogo(raw: unknown, baseDir: string): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const file = path.resolve(baseDir, raw.trim());
  if (!LOGO_TYPES[path.extname(file).toLowerCase()]) {
    throw new Error(`meters.logo: ${raw} is not an .svg, .png, .webp or .jpg`);
  }
  if (!fs.existsSync(file)) throw new Error(`meters.logo: ${file} does not exist`);
  return file;
}

function resolveMeters(raw: unknown, baseDir = process.cwd()): MetersConfig {
  const r = isObj(raw) ? raw : {};
  const roles = isObj(r.roles) ? r.roles : {};
  const t = isObj(roles.tokens) ? roles.tokens : {};
  const tok = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    enabled: !!r.enabled,
    port: finite(r.port, 4445),
    fps: Math.max(1, finite(r.fps, 20)),
    logo: resolveLogo(r.logo, baseDir),
    logoAlt: typeof r.logoAlt === 'string' && r.logoAlt.trim() ? r.logoAlt.trim() : 'studiobox',
    roles: {
      enabled: !!roles.enabled,
      tokens: { tech: tok(t.tech), host: tok(t.host), guest: tok(t.guest), stream: tok(t.stream) },
    },
  };
}

/** Listener feedback from eve. Off unless enabled; the password may come
 *  from the environment so it need not sit in the YAML. */
function resolveListeners(raw: unknown): ListenersConfig {
  const r = isObj(raw) ? raw : {};
  const str = (v: unknown, d = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const show = str(r.show);
  return {
    enabled: !!r.enabled,
    url: str(r.url),
    app: str(r.app, 'radio-z'),
    username: str(r.username),
    password:
      process.env.STUDIOBOX_EVE_PASSWORD || (typeof r.password === 'string' ? r.password : ''),
    pollSeconds: Math.min(300, Math.max(30, finite(r.pollSeconds, 45))),
    ...(show ? { show } : {}),
  };
}

function resolveAutomix(raw: unknown): AutomixConfig {
  const r = isObj(raw) ? raw : {};
  return {
    enabled: !!r.enabled,
    members: Array.isArray(r.members) ? r.members.map(String) : [],
    responseMs: finite(r.responseMs, 120),
    floorDb: finite(r.floorDb, -60),
    priority: resolvePriority(r.priority),
  };
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
    color: resolveChannelColor(raw.color, String(raw.label)),
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
  const cfg = {
    ...root,
    mode,
    channels,
    filePlayer,
    output,
    automix: resolveAutomix(root.automix),
    lookahead: resolveLookahead(root.lookahead),
    airDelay: resolveAirDelay(root.airDelay),
    meters: resolveMeters(root.meters, path.dirname(configPath)),
    listeners: resolveListeners(root.listeners),
    stateFile:
      typeof root.stateFile === 'string' && root.stateFile.trim()
        ? path.resolve(path.dirname(configPath), root.stateFile.trim())
        : path.resolve(path.dirname(configPath), 'session-state.json'),
  } as unknown as StudioboxConfig;
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
  const lis = cfg.listeners;
  if (lis.enabled) {
    if (!/^https?:\/\/[^/]/.test(lis.url)) fail('listeners.url must be an http(s) URL of eve');
    if (!lis.username) fail('listeners.username is required');
    if (!lis.password) fail('listeners.password (or STUDIOBOX_EVE_PASSWORD) is required');
  }
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
  const bed = cfg.filePlayer?.bed;
  if (bed?.enabled && !cfg.filePlayer!.dirs.some((d) => d.label === bed.dir)) {
    fail(`filePlayer.bed.dir: no filePlayer.dirs entry is labelled "${bed.dir}"`);
  }
  const pri = cfg.automix.priority;
  if (pri.enabled) {
    if (!labels.has(pri.label)) fail(`automix.priority.label: unknown channel "${pri.label}"`);
    for (const a of pri.attenuate) {
      if (!labels.has(a)) fail(`automix.priority.attenuate references unknown channel "${a}"`);
    }
  }
  for (const key of ['monitor', 'return'] as const) {
    const o = cfg.output[key];
    if (o.enabled && o.backend === 'alsa' && !o.device) {
      fail(`output.${key}.device is required when ${key} is enabled with the alsa backend`);
    }
  }
  if (cfg.output.multitrack.enabled) {
    // FLAC carries at most 8 channels: mics + 2 per music source + programme.
    const mics = cfg.channels.filter((c) => c.role === 'mic').length;
    const music =
      cfg.channels.filter((c) => c.role === 'music').length + (cfg.filePlayer?.enabled ? 1 : 0);
    const total = mics + 2 * music + 2;
    if (total > 8) {
      fail(
        `output.multitrack: ${mics} mics + ${music} stereo sources + programme = ${total} ` +
          `channels, but one FLAC holds at most 8`
      );
    }
  }
}

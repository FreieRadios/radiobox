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
  /** Mics: the phrase window, centred on the audio as far as the look-ahead
   *  reaches (±responseMs/2). Music: the AGC's time constant. */
  responseMs: number;
  /** Mics only: limit of the fast "rider" stage that follows a talker turning
   *  away from the mic mid-sentence (dB, 0 = off). 6 when omitted. */
  riderDb?: number;
  /** Mics only: the boost stops where the mic's noise floor (after the trim)
   *  would rise above this (dBFS). Unlimited when omitted. */
  noiseCeilingDb?: number;
}

/** Fully-resolved per-channel processing chain. */
export interface ChannelProcessing {
  /** Digital input trim (dB) applied before everything else. The setup
   *  assistant sets it so speech sits at a common reference level ahead of the
   *  gate and compressor, whatever the mic's sensitivity. Optional: 0 when
   *  omitted. */
  trimDb?: number;
  hpfHz: number;
  gate: GateParams;
  eq: EqBand[];
  deesser: DeesserParams;
  compressor: CompressorParams;
  leveler: LevelerParams;
  gainDb: number;
  /** Guest level indicator: the speech level (dBFS RMS after the trim, before
   *  gate, compressor and leveler — so it follows mouth distance, not the
   *  processed output) that counts as "passt", and how far either side of it
   *  still does. Optional: -20 dB +/- 6 dB when omitted. */
  zone?: { centerDb: number; widthDb: number };
}

export interface ChannelConfig {
  /** 1-based capture channel index; a [L,R] pair for stereo sources. */
  source: number | [number, number];
  role: Role;
  label: string;
  /** Marker colour on the page (CSS hex), e.g. the colour of the mic's cable,
   *  so a row maps to the hardware at a glance. Accepts a name (`red`/`rot`,
   *  `blue`/`blau`, …) or `#rgb`/`#rrggbb` in the YAML; the loader normalises
   *  names to hex. Always shown next to the label, never instead of it. */
  color?: string;
  profile?: string;
  processing: ChannelProcessing;
}

export interface CaptureConfig {
  backend: CaptureBackend;
  device: string;
  sampleRate: number;
  channels: number;
  blockSize: number;
  /** Time from a sound at the mic until its samples reach studiobox, in ms
   *  (USB + the ALSA reader). Part of the air-delay measurement. Default 20. */
  latencyMs?: number;
  /** ALSA capture buffer in ms (`arecord --buffer-time`). How long studiobox
   *  may be held up (a busy machine) before samples are lost. Unset keeps
   *  arecord's default (~500 ms). Adds no latency. */
  bufferMs?: number;
  /** ALSA capture period in ms (`arecord --period-time`): how much audio
   *  arrives at once. Unset keeps arecord's default, a quarter of the buffer
   *  (~125 ms) — coarse for the meters and for the music return; 20 is good. */
  periodMs?: number;
}

/** Look-ahead of the mic processing. The audio runs this far behind its own
 *  analysis, so every automatic gain can act *before* the sound it reacts to:
 *  the gate is open on the first consonant, the leveler has the right gain on
 *  the first word, music ducks just before speech starts. The cost is delay,
 *  which the buffered design spends freely (see AirDelayConfig). */
export interface LookaheadConfig {
  /** Leveler look-ahead in seconds (0 = causal leveler, still voice-keyed).
   *  The duck plan sees this far ahead too: talk is confirmed in room time
   *  and the music goes down when it reaches the programme. */
  seconds: number;
  /** Gate look-ahead in ms: the gate opens this long before speech onset. */
  gateMs: number;
  /** Mix look-ahead in ms: automix shares and host priority move this long
   *  before the speech that triggers them. */
  mixMs: number;
}

/** Air delay: the programme leaves studiobox a fixed time behind the room.
 *  Nobody monitors studiobox's output while talking (headphones hang on the
 *  mixer), so latency is a resource: it pays for the look-ahead and is
 *  reported as the on-air clock ("Sendezeit" = wall clock + measured delay). */
export interface AirDelayConfig {
  /** Target delay D between the room and the output, in seconds (0..60).
   *  Values below the look-ahead are raised to it (nothing to buffer then). */
  seconds: number;
  /** Deviation of the measured delay from D, in seconds, beyond which the
   *  FIFO is re-centred in one step (audible; only happens after a device
   *  stall). Smaller drifts are corrected during silence. */
  toleranceSeconds: number;
}

/** Host priority: while the priority mic talks, the listed mics are turned
 *  down by `depthDb` — gently, never muted. */
export interface PriorityConfig {
  enabled: boolean;
  /** Label of the mic that has priority (the host). */
  label: string;
  /** Labels of the mics that give way. */
  attenuate: string[];
  /** Attenuation while the priority mic talks (negative dB). */
  depthDb: number;
  thresholdDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface AutomixConfig {
  enabled: boolean;
  members: string[];
  responseMs: number;
  floorDb: number;
  /** Optional host priority (see PriorityConfig). */
  priority: PriorityConfig;
}

export interface DuckConfig {
  enabled: boolean;
  targets: string[];
  /** Level of the mic bus (after the leveler) that ducks the **music return**
   *  in the headphones, which has no look-ahead. The programme ducks on
   *  confirmed talk instead (see `minSpeechMs`). */
  thresholdDb: number;
  /** Programme: talk has to go on this long (ms, in any one mic) before the
   *  music ducks — a bump, a click or a short laugh doesn't. Decided with the
   *  look-ahead, so the music is still down before the first word. 300 when
   *  omitted. */
  minSpeechMs?: number;
  musicPresentDb: number;
  depthDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface MasterConfig {
  /** Loudness of the talk on air (LUFS). The master leveler learns it from
   *  confirmed talk only; music airs at its own leveler's target relative to
   *  it (default 1 LU over), see MasterLeveler. */
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
  /** Length of one file in seconds. 0 (the default) writes **one continuous
   *  file per recording** — the form a session is handed out in; a positive
   *  value restores the rolling segments of an always-on safety copy. */
  segmentSeconds: number;
  /** Optional Vorbis comments written into the file. */
  station?: string;
  title?: string;
}

/** Multitrack recording next to the processed stereo file: one FLAC holding
 *  every mic, every stereo music source and the programme, sample-aligned
 *  with the stereo recording (both are written from the same block). FLAC
 *  carries at most 8 channels. */
export interface MultitrackConfig {
  enabled: boolean;
  /** `dry`: the raw mic capture and the undecorated music, delayed to line up
   *  with the programme — the material to remix from. `processed`: each mic
   *  as it enters the mix bus (strip, leveler, automix, priority) and the
   *  music after leveling and ducking. */
  source: 'dry' | 'processed';
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
  /** Channels the device is opened with. The stereo programme goes to the
   *  first two; any further ones carry silence. Default 2. */
  channels?: number;
  /** ALSA buffer length in ms (`aplay --buffer-time`). Unset keeps aplay's
   *  own default (~500 ms), which is what the playout box has always run.
   *  Behind the air delay a long buffer costs nothing (its latency is part of
   *  D) and is what keeps the output from running dry when the machine is
   *  busy: 2000 for the programme output of a live session. */
  bufferMs?: number;
  /** ALSA period in ms (`aplay --period-time`). Unset: a quarter of the buffer. */
  periodMs?: number;
  /** Time from a block being handed to the output process until it is heard,
   *  in ms: the pipe and the device buffer. Feeds the air-delay measurement;
   *  calibrate it in the rehearsal against a reference clock. */
  latencyMs?: number;
  /** Fixed level of the music return in dB (`output.return` only; -60..+12,
   *  default 0). The return arrives at the mixer leveled like the programme
   *  music, usually far hotter than the direct mics in the headphones; this
   *  pulls it down without touching the programme. */
  gainDb?: number;
}

export interface OutputConfig {
  harbor: HarborConfig;
  backup: BackupConfig;
  multitrack: MultitrackConfig;
  monitor: MonitorConfig;
  /** Music return to the room: the music/jingle/bed mix, ducked as on air but
   *  **without the mics**, in room time (no look-ahead, no air delay). Sent
   *  to the mixer's USB playback so the room hears the music in the
   *  headphones next to the direct mics. Same shape as the monitor. */
  return: MonitorConfig;
}

/** Role tokens for the web views. With `enabled`, a connection may only send
 *  the commands of the role its token stands for (`?k=<token>` in the URL);
 *  without a token it is read-only. Off by default: every connection may do
 *  everything, as on a playout box in a trusted network. */
export interface RolesConfig {
  enabled: boolean;
  /** Fixed tokens; any left out is generated at start and printed. */
  tokens: { tech?: string; host?: string; guest?: string };
}

export interface MetersConfig {
  enabled: boolean;
  port: number;
  fps: number;
  roles: RolesConfig;
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

/** Audio bed ("Bett"): a second deck that loops one file under the talk, for
 *  the host to switch on at any moment — the emergency fallback when a track
 *  fails or a pause needs filling. It is summed into the file-player source,
 *  so it is leveled and ducked with it and needs no channel of its own. */
export interface BedConfig {
  enabled: boolean;
  /** Label of the `filePlayer.dirs` entry that holds the bed; its first audio
   *  file is the bed until another one is selected. */
  dir: string;
  /** Level of the bed relative to the player's other material (dB). */
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
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
  /** Audio bed: a second, looping deck next to the player (see BedConfig). */
  bed: BedConfig;
  /** Music-style processing (leveler/gain) applied to the decoded audio. */
  processing: ChannelProcessing;
}

/** Listener feedback from eve (the station's database): the comments a
 *  moderator released for the show on air and its heart count, shown to the
 *  host on the operators' page. studiobox signs in as a read-only device
 *  account and writes nothing to eve; moderation happens in eve. */
export interface ListenersConfig {
  enabled: boolean;
  /** eve's API, e.g. `https://eve.example.org` (Socket.IO on the same host). */
  url: string;
  /** The eve app the exports belong to (`/exports/<app>/…`). */
  app: string;
  username: string;
  /** From the YAML, or the `STUDIOBOX_EVE_PASSWORD` environment variable. */
  password: string;
  /** Fallback poll when the change socket is down, seconds (30–300). */
  pollSeconds: number;
  /** Pin a show slug instead of reading it from the schedule and the clock —
   *  for a rehearsal outside the show's slot. Unset in a real session. */
  show?: string;
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
  lookahead: LookaheadConfig;
  airDelay: AirDelayConfig;
  channels: ChannelConfig[];
  automix: AutomixConfig;
  duck: DuckConfig;
  master: MasterConfig;
  output: OutputConfig;
  meters: MetersConfig;
  filePlayer?: FilePlayerConfig;
  listeners: ListenersConfig;
  /** Where live settings (setup-assistant results, trims) are kept between
   *  restarts. Never the YAML: that stays the hand-written baseline. */
  stateFile: string;
}

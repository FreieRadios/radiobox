/**
 * Replay harness: feeds the dry tracks of a recorded session through the real
 * live `Graph` (src/dsp/graph.ts), block by block, and logs what Auto-Pegel,
 * the automix and the levelers did per 40 ms arrival hop.
 *
 *   npx ts-node -T tools/replay/replay.ts --out <dir> \
 *     --mics g1.flac,g2.flac,host.flac[,tech.flac] [--music player.flac] \
 *     [--seed seed.json] [--law power|alpha=0.5|floor=-6|alpha=0.7,floor=-6] \
 *     [--start 0] [--dur 0] [--no-programme]
 *
 * Config: the session preset (config/studiobox.flow8-session.example.yaml) and
 * config/profiles.yaml through the production loader, so every default is the
 * one a live box runs with. Mics are relabelled G1, G2, Host, Tech in that
 * order (profiles by position: condenser, condenser, dynamic-broadcast, ...).
 * Differences to a live run, all deliberate:
 *  - block size 1920 (= one arrival hop of 40 ms) instead of 1024; the DSP is
 *    per sample, only the trim updates land on hop instead of block edges;
 *  - the player track of a multitrack recording is already in room time (the
 *    dry tap is delayed by the return latency), so it is fed as the file
 *    player with `musicDelayMs: 0`; the graph's room-music hold for
 *    Auto-Pegel sees it exactly as the room heard it;
 *  - a file "item" for the music leveler is a run of player audio after at
 *    least 1 s of silence (the recording carries no file names);
 *  - no mutes: the mics were closed for the songs live, the replay keeps them
 *    open (the room-music hold still stops Auto-Pegel learning there);
 *  - seeding (`--seed`, `{label: trimDb}`) retunes only the trim, trusted as 6 s
 *    of talk like an applied Einmessen; gate/compressor/leveler seed are not
 *    re-measured.
 *
 * `--law` swaps the automix share law for an experiment (production code is
 * untouched; the graph's private automix is replaced from here):
 *  - `power` (default): the production `Automix` (share ∝ power);
 *  - `alpha=a`: share ∝ power^a (a = 0.5 is amplitude sharing);
 *  - `floor=d`: a member whose voice detector calls it the voiced talker
 *    (`active`) is never cut deeper than d dB.
 *
 * Output in `--out`:
 *  - hops.f32 + hops.json: a float32 matrix, one row per 40 ms hop, columns
 *    named in hops.json. Every column is aligned to room time (the time the
 *    sound was made), whatever the graph's internal delay;
 *  - programme.flac: the replayed programme, aligned sample for sample with
 *    the input (the graph's latency removed), unless --no-programme;
 *  - summary.json.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../../src/config/load';
import { ChannelConfig, StudioboxConfig } from '../../src/config/schema';
import { Graph } from '../../src/dsp/graph';
import { dbToGain, msToCoef } from '../../src/dsp/dsp-math';
import { EnvelopeFollower } from '../../src/dsp/envelope';

const SR = 48000;
const HOP = 1920; // 40 ms: the arrival hop
const LABELS = ['G1', 'G2', 'Host', 'Tech'];
const ITEM_GAP_SEC = 1; // player silence that ends a music item
const ITEM_SILENT = dbToGain(-60);

// ---------------------------------------------------------------- arguments

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : 'true';
    out[k] = v;
  }
  return out;
}

const opt = args();
if (!opt.out || !opt.mics) {
  console.error(
    'usage: replay.ts --out DIR --mics a.flac,b.flac,... [--music m.flac] [--seed s.json] [--law L]'
  );
  process.exit(2);
}
const micFiles = opt.mics.split(',');
const nMics = micFiles.length;
if (nMics < 1 || nMics > LABELS.length) throw new Error(`1..${LABELS.length} mics`);
const labels = LABELS.slice(0, nMics);
const startSec = Number(opt.start ?? 0);
const durSec = Number(opt.dur ?? 0);
const writeProgramme = opt['no-programme'] !== 'true';
fs.mkdirSync(opt.out, { recursive: true });

// ---------------------------------------------------------------- config

const pkg = path.resolve(__dirname, '../..');
function sessionConfig(): StudioboxConfig {
  const cfg = loadConfig({
    configPath: opt.config ?? path.join(pkg, 'config/studiobox.flow8-session.example.yaml'),
    profilesPath: path.join(pkg, 'config/profiles.yaml'),
  });
  const presetMics = cfg.channels.filter((c) => c.role === 'mic');
  const channels: ChannelConfig[] = labels.map((label, i) => ({
    ...presetMics[Math.min(i, presetMics.length - 1)],
    source: i + 1,
    label,
  }));
  cfg.channels = channels;
  cfg.capture = { ...cfg.capture, channels: nMics, blockSize: HOP };
  cfg.automix = {
    ...cfg.automix,
    members: [...labels],
    priority: {
      ...cfg.automix.priority,
      enabled: cfg.automix.priority.enabled && labels.includes('Host'),
      label: 'Host',
      attenuate: labels.filter((l) => l.startsWith('G')),
    },
  };
  cfg.output = { ...cfg.output, multitrack: { ...cfg.output.multitrack, enabled: false } };
  return cfg;
}
const cfg = sessionConfig();

// ---------------------------------------------------------------- share laws

interface Law {
  alpha: number;
  floorDb: number | null;
}
function parseLaw(s: string | undefined): Law | null {
  if (!s || s === 'power') return null;
  const law: Law = { alpha: 1, floorDb: null };
  for (const part of s.split(',')) {
    const [k, v] = part.split('=');
    if (k === 'alpha') law.alpha = Number(v);
    else if (k === 'floor') law.floorDb = Number(v);
    else throw new Error(`unknown law part ${part}`);
  }
  return law;
}

/** Same envelope, smoothing and floor term as the production `Automix`, with
 *  an exponent on the power share and an optional cut floor for a member its
 *  voice detector calls the voiced talker. α = 1 without a floor is the
 *  production law. */
class ShareLawAutomix {
  private envs: EnvelopeFollower[];
  private gains: Float32Array;
  private w: Float64Array;
  private floorW: number;
  private smooth: number;
  private floorLin: number;
  constructor(
    private n: number,
    responseMs: number,
    floorDb: number,
    private law: Law,
    private isActive: (slot: number) => boolean
  ) {
    this.envs = Array.from({ length: n }, () => new EnvelopeFollower(SR, 5, responseMs));
    this.gains = new Float32Array(n);
    this.w = new Float64Array(n);
    this.floorW = Math.pow(dbToGain(floorDb), 2 * law.alpha);
    this.smooth = msToCoef(responseMs, SR);
    this.floorLin = law.floorDb === null ? 0 : dbToGain(law.floorDb);
  }
  process(samples: ArrayLike<number>): Float32Array {
    const a2 = 2 * this.law.alpha;
    let sum = this.floorW;
    for (let i = 0; i < this.n; i++) {
      const a = this.envs[i].process(samples[i]);
      const w = a2 === 2 ? a * a : Math.pow(a, a2);
      this.w[i] = w;
      sum += w;
    }
    for (let i = 0; i < this.n; i++) {
      let target = this.w[i] / sum;
      if (this.floorLin > 0 && target < this.floorLin && this.isActive(i)) target = this.floorLin;
      this.gains[i] = this.smooth * (this.gains[i] - target) + target;
    }
    return this.gains;
  }
  set floorDb(db: number) {
    this.floorW = Math.pow(dbToGain(db), 2 * this.law.alpha);
  }
  get currentGains(): Float32Array {
    return this.gains;
  }
}

// ---------------------------------------------------------------- graph + probes

const graph = new Graph(cfg, { musicDelayMs: 0 });
// Private parts the harness reads (production code stays as it is).
/* eslint-disable @typescript-eslint/no-explicit-any */
const G = graph as any;
const mics: any[] = G.mics;
const look = cfg.lookahead;
const gateN = Math.round((look.gateMs / 1000) * SR);
const levN = Math.round(look.seconds * SR);
const mixN = Math.round((look.mixMs / 1000) * SR);
const mixLatency: number = G.mixLatency;
const latency: number = graph.latencySamples;
if (mixLatency !== gateN + levN + mixN) throw new Error('latency bookkeeping changed in graph.ts');
const slotToMic = new Int32Array(nMics).fill(-1);
mics.forEach((m, i) => {
  if (m.automixSlot >= 0) slotToMic[m.automixSlot] = i;
});

const law = parseLaw(opt.law);
if (law) {
  G.automix = new ShareLawAutomix(
    cfg.automix.members.length,
    cfg.automix.responseMs,
    cfg.automix.floorDb,
    law,
    (slot) => mics[slotToMic[slot]].active
  );
}

// Seed (Einmessen-like): the trim only, trusted as 6 s of talk.
let seed: Record<string, number> | null = null;
if (opt.seed) {
  seed = JSON.parse(fs.readFileSync(opt.seed, 'utf8')) as Record<string, number>;
  for (const [label, trimDb] of Object.entries(seed)) {
    const p = graph.getProcessing(label);
    if (!p) throw new Error(`seed: unknown mic ${label}`);
    graph.retune(label, { ...p, trimDb }, undefined, 6);
  }
}

// Duration -> number of hops.
function durationSec(file: string): number {
  const r = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(String(r.stdout).trim());
}
const totalSec = durSec > 0 ? durSec : durationSec(micFiles[0]) - startSec;
const nHops = Math.ceil((totalSec * SR) / HOP) + 2;

// Per-hop accumulators, room-time bins.
const cols: string[] = ['t', 'talker', 'musicHold', 'outE', 'busE'];
const perMic = [
  'lev',
  'floor',
  'trim',
  'amxDec',
  'amxApp',
  'amxAppDb',
  'contribE',
  'active',
  'voiced',
  'gate',
  'levelerDb',
  'talkSec',
];
for (const l of labels) for (const f of perMic) cols.push(`${l}.${f}`);
const C = cols.length;
const M = new Float32Array(nHops * C);
const col = (name: string): number => cols.indexOf(name);
const cT = col('t');
const cTalker = col('talker');
const cHold = col('musicHold');
const cOutE = col('outE');
const cBusE = col('busE');
const cm = (i: number, f: string): number => col(`${labels[i]}.${f}`);
const cLev = labels.map((_, i) => cm(i, 'lev'));
const cFloor = labels.map((_, i) => cm(i, 'floor'));
const cTrim = labels.map((_, i) => cm(i, 'trim'));
const cTalk = labels.map((_, i) => cm(i, 'talkSec'));
const cLevDb = labels.map((_, i) => cm(i, 'levelerDb'));
// Sums over samples, divided at the end.
const decSum = new Float64Array(nHops * nMics);
const decN = new Float64Array(nHops);
const appSum = new Float64Array(nHops * nMics);
const appDbSum = new Float64Array(nHops * nMics);
const appN = new Float64Array(nHops);
const contrib = new Float64Array(nHops * nMics);
const busE = new Float64Array(nHops);
const actSum = new Float64Array(nHops * nMics);
const voiSum = new Float64Array(nHops * nMics);
const gateSum = new Float64Array(nHops * nMics);
const roomN = new Float64Array(nHops);
const outE = new Float64Array(nHops);

let sample = 0; // global sample index of the tick being processed (room time)
const decShift = gateN + levN; // the automix decides on the leveler's output
const appShift = mixLatency; // ... and its gain meets the audio mixN later

// Probe 1: the automix call, once per sample, after the talker flags are set.
{
  const amx = G.automix;
  const inner = amx.process.bind(amx);
  amx.process = (s: ArrayLike<number>): Float32Array => {
    const g: Float32Array = inner(s);
    const r = sample;
    for (let i = 0; i < nMics; i++) {
      const m = mics[i];
      if (m.active) actSum[Math.floor(r / HOP) * nMics + i]++;
      if (m.voice.voiced) voiSum[Math.floor(r / HOP) * nMics + i]++;
      if (m.strip.gateIsOpen) gateSum[Math.floor(r / HOP) * nMics + i]++;
    }
    roomN[Math.floor(r / HOP)]++;
    const d = r - decShift;
    if (d >= 0) {
      const b = Math.floor(d / HOP);
      for (let k = 0; k < g.length; k++) decSum[b * nMics + slotToMic[k]] += g[k];
      decN[b]++;
    }
    sample++;
    return g;
  };
}

// Probe 2: each mic's look-ahead delay and gain lead -> the gain applied to
// the audio and the mic's contribution to the bus (programme time).
{
  let bus = 0;
  mics.forEach((m, i) => {
    const md = m.mixDelay;
    const gl = m.gainLead;
    if (!md || !gl) throw new Error('replay expects lookahead.mixMs > 0');
    let lastA = 0;
    const mdp = md.process.bind(md);
    md.process = (x: number): number => (lastA = mdp(x));
    const glp = gl.process.bind(gl);
    gl.process = (gNow: number): number => {
      const ga = glp(gNow);
      const g = ga > gNow ? ga : gNow;
      const r = sample - 1 - appShift; // `sample` was advanced in probe 1
      const s = lastA * g;
      bus += s;
      if (r >= 0) {
        const b = Math.floor(r / HOP);
        appSum[b * nMics + i] += g;
        appDbSum[b * nMics + i] += 20 * Math.log10(g > 1e-6 ? g : 1e-6);
        contrib[b * nMics + i] += s * s;
        if (i === nMics - 1) {
          busE[b] += bus * bus;
          appN[b]++;
        }
      }
      if (i === nMics - 1) bus = 0;
      return ga;
    };
  });
}

// Probe 3: the arrival hop (talker, levels, floors) and the trims after it.
let hopIdx = 0;
{
  const inner = G.onArrivalHop as (h: any) => void;
  G.onArrivalHop = (h: any): void => {
    inner(h);
    if (hopIdx < nHops) {
      const o = hopIdx * C;
      M[o + cT] = (hopIdx * HOP) / SR;
      M[o + cTalker] = h.talker;
      M[o + cHold] = G.musicHoldSec > 0 ? 1 : 0;
      for (let i = 0; i < nMics; i++) {
        M[o + cLev[i]] = h.levelDb[i];
        M[o + cFloor[i]] = h.floorDb[i];
        M[o + cTrim[i]] = G.autoTrims[i].trimDb;
        M[o + cTalk[i]] = G.autoTrims[i].talkSeconds;
      }
    }
    hopIdx++;
  };
}

// ---------------------------------------------------------------- I/O

function decoder(): ReturnType<typeof spawn> {
  const inputs: string[] = [];
  const files = [...micFiles, ...(opt.music ? [opt.music] : [])];
  for (const f of files)
    inputs.push('-ss', String(startSec), ...(durSec > 0 ? ['-t', String(durSec)] : []), '-i', f);
  const pre = micFiles.map((_, i) => `[${i}:a]aformat=channel_layouts=mono[m${i}]`);
  let merge = micFiles.map((_, i) => `[m${i}]`).join('');
  let n = nMics;
  if (opt.music) {
    pre.push(`[${nMics}:a]aformat=channel_layouts=stereo[mu]`);
    merge += '[mu]';
    n++;
  }
  const filter = `${pre.join(';')};${merge}amerge=inputs=${n}[out]`;
  return spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-f',
      'f32le',
      '-ar',
      String(SR),
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
}

function encoder(file: string): ReturnType<typeof spawn> {
  return spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'f32le',
      '-ar',
      String(SR),
      '-ac',
      '2',
      '-i',
      'pipe:0',
      '-c:a',
      'flac',
      '-sample_fmt',
      's32',
      '-bits_per_raw_sample',
      '24',
      file,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const inCh = nMics + (opt.music ? 2 : 0);
  const frameBytes = inCh * 4;
  const blockBytes = HOP * frameBytes;
  const input = Array.from({ length: nMics }, () => new Float32Array(HOP));
  const mL = new Float32Array(HOP);
  const mR = new Float32Array(HOP);
  const outL = new Float32Array(HOP);
  const outR = new Float32Array(HOP);
  const inter = new Float32Array(HOP * 2);
  const enc = writeProgramme ? encoder(path.join(opt.out, 'programme.flac')) : null;
  let outSamples = 0; // programme samples produced (incl. the latency head)
  let item = 0;
  let silentBlocks = Infinity;
  let blocks = 0;

  const write = async (n: number): Promise<void> => {
    // Drop the graph's latency so the programme lines up with the input.
    for (let s = 0; s < n; s++) {
      const r = outSamples - latency;
      outSamples++;
      if (r < 0) continue;
      const b = Math.floor(r / HOP);
      if (b < nHops) outE[b] += outL[s] * outL[s] + outR[s] * outR[s];
    }
    if (!enc) return;
    const skip = Math.max(0, Math.min(n, latency - (outSamples - n)));
    if (skip >= n) return;
    let k = 0;
    for (let s = skip; s < n; s++) {
      inter[k++] = outL[s];
      inter[k++] = outR[s];
    }
    const buf = Buffer.from(inter.buffer, 0, k * 4);
    if (!enc.stdin!.write(Buffer.from(buf))) await new Promise((r) => enc.stdin!.once('drain', r));
  };

  const frame = new Float32Array(HOP * inCh);
  const frameU8 = new Uint8Array(frame.buffer);
  const runBlock = async (bytes: Buffer | null, off: number): Promise<void> => {
    let peak = 0;
    if (bytes) frameU8.set(bytes.subarray(off, off + blockBytes));
    else frame.fill(0);
    for (let s = 0; s < HOP; s++) {
      const base = s * inCh;
      for (let c = 0; c < nMics; c++) input[c][s] = frame[base + c];
      if (opt.music) {
        const l = frame[base + nMics];
        const r = frame[base + nMics + 1];
        mL[s] = l;
        mR[s] = r;
        const p = Math.max(Math.abs(l), Math.abs(r));
        if (p > peak) peak = p;
      }
    }
    if (opt.music) {
      if (peak > ITEM_SILENT) {
        if (silentBlocks * HOP >= ITEM_GAP_SEC * SR) item++;
        silentBlocks = 0;
      } else silentBlocks++;
      const playing = silentBlocks * HOP < ITEM_GAP_SEC * SR ? `item-${item}` : null;
      graph.setFileBlock(mL, mR, playing);
    }
    graph.process(input, outL, outR, HOP);
    const b = blocks++;
    if (b - 150 >= 0 && b - 150 < nHops) {
      // Leveler gain applies to audio levN + gateN behind the room (150.4 hops).
      for (let i = 0; i < nMics; i++)
        M[(b - 150) * C + cLevDb[i]] = mics[i].strip.meters().levelerDb;
    }
    await write(HOP);
  };

  const dec = decoder();
  let pending = Buffer.alloc(0);
  for await (const chunk of dec.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let off = 0;
    while (pending.length - off >= blockBytes) {
      await runBlock(pending, off);
      off += blockBytes;
    }
    pending = pending.subarray(off);
    if (blocks % 7500 === 0) {
      const sec = (blocks * HOP) / SR;
      process.stderr.write(
        `  ${(sec / 60).toFixed(1)} min, ${(sec / ((Date.now() - t0) / 1000)).toFixed(1)}x\n`
      );
    }
  }
  const inBlocks = blocks;
  // Flush: silence through the graph's delay so every bin is complete.
  const flush = Math.ceil(latency / HOP) + 2;
  for (let k = 0; k < flush; k++) await runBlock(null, 0);
  if (enc) {
    enc.stdin!.end();
    await new Promise((r) => enc.on('close', r));
  }

  // Finish the per-hop matrix.
  const used = Math.min(nHops, inBlocks);
  for (let b = 0; b < used; b++) {
    const o = b * C;
    M[o + cOutE] = outE[b] / (2 * HOP);
    M[o + cBusE] = appN[b] ? busE[b] / appN[b] : 0;
    for (let i = 0; i < nMics; i++) {
      const k = b * nMics + i;
      M[o + cm(i, 'amxDec')] = decN[b] ? decSum[k] / decN[b] : NaN;
      M[o + cm(i, 'amxApp')] = appN[b] ? appSum[k] / appN[b] : NaN;
      M[o + cm(i, 'amxAppDb')] = appN[b] ? appDbSum[k] / appN[b] : NaN;
      M[o + cm(i, 'contribE')] = appN[b] ? contrib[k] / appN[b] : NaN;
      M[o + cm(i, 'active')] = roomN[b] ? actSum[k] / roomN[b] : 0;
      M[o + cm(i, 'voiced')] = roomN[b] ? voiSum[k] / roomN[b] : 0;
      M[o + cm(i, 'gate')] = roomN[b] ? gateSum[k] / roomN[b] : 0;
    }
  }
  fs.writeFileSync(path.join(opt.out, 'hops.f32'), Buffer.from(M.buffer, 0, used * C * 4));
  fs.writeFileSync(
    path.join(opt.out, 'hops.json'),
    JSON.stringify({ columns: cols, rows: used, hopSec: HOP / SR, labels }, null, 1)
  );
  const summary = {
    mics: Object.fromEntries(labels.map((l, i) => [l, path.basename(micFiles[i])])),
    music: opt.music ? path.basename(opt.music) : null,
    seed,
    law: opt.law ?? 'power',
    startSec,
    seconds: (inBlocks * HOP) / SR,
    latencySamples: latency,
    finalTrims: Object.fromEntries(labels.map((l, i) => [l, G.autoTrims[i].trimDb])),
    talkSeconds: Object.fromEntries(labels.map((l, i) => [l, G.autoTrims[i].talkSeconds])),
    processing: Object.fromEntries(labels.map((l, i) => [l, cfg.channels[i].profile])),
    autoTrim: cfg.autoTrim,
    automix: { responseMs: cfg.automix.responseMs, floorDb: cfg.automix.floorDb },
    wallSec: (Date.now() - t0) / 1000,
  };
  fs.writeFileSync(path.join(opt.out, 'summary.json'), JSON.stringify(summary, null, 1));
  process.stderr.write(
    `done: ${summary.seconds.toFixed(0)} s in ${summary.wallSec.toFixed(0)} s\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

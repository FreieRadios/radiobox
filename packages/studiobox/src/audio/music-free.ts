import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { MusicFreeConfig } from '../config/schema';
import { Log } from '../util/log';

/**
 * The music-free version of a recording ("ohne Musik"), for platforms that
 * may carry no third-party music. While the recording runs, the graph writes
 * a talk stem beside the programme (mics after leveler, automix and master,
 * plus files from `musicFree` folders) and `TalkLog` keeps the level of both
 * per 100 ms. When the recording stops, `planKeep` decides from those levels
 * what stays — talk, also talk over music (the stem has no music under it) —
 * and what goes: stretches where only music played (songs, the bed, a jingle
 * that is not `musicFree`) and dead air. `exportMusicFree` then cuts the stem
 * with short fades, normalises it in two passes (loudnorm, linear) and
 * encodes the MP3.
 */

export const FRAME_SEC = 0.1;
/** The programme counts as music-only when it is this much louder than the
 *  talk stem (the difference is what the stem doesn't carry) … */
const MUSIC_OVER_TALK_DB = 10;
/** … and louder than this at all (dBFS RMS). */
const MUSIC_MIN_DB = -50;
/** The talk stem carries talk above this (dBFS RMS). */
const TALK_MIN_DB = -45;
/** Silence on both longer than this is dead air (s) … */
const MAX_PAUSE_SEC = 4;
/** … cut down to twice this (s). */
const PAUSE_PAD_SEC = 0.5;
/** What stays on each side of a cut-out music stretch (s). */
const MUSIC_PAD_SEC = 0.3;
/** Kept before the first and after the last talk (s). */
const LEAD_SEC = 0.5;
const TAIL_SEC = 1;
/** Fade in and out of every kept piece (s). */
const FADE_SEC = 0.02;

const toDb = (meanSq: number): number => 10 * Math.log10(Math.max(meanSq, 1e-20));

/** Level of the programme and the talk stem per 100 ms, while recording. */
export class TalkLog {
  private readonly frame: number;
  private n = 0;
  private prog = 0;
  private talk = 0;
  readonly progDb: number[] = [];
  readonly talkDb: number[] = [];

  constructor(sampleRate: number) {
    this.frame = Math.round(FRAME_SEC * sampleRate);
  }

  push(
    progL: Float32Array,
    progR: Float32Array,
    talkL: Float32Array,
    talkR: Float32Array,
    frames: number
  ): void {
    for (let i = 0; i < frames; i++) {
      this.prog += 0.5 * (progL[i] * progL[i] + progR[i] * progR[i]);
      this.talk += 0.5 * (talkL[i] * talkL[i] + talkR[i] * talkR[i]);
      if (++this.n === this.frame) {
        this.progDb.push(Math.round(toDb(this.prog / this.n) * 10) / 10);
        this.talkDb.push(Math.round(toDb(this.talk / this.n) * 10) / 10);
        this.n = 0;
        this.prog = 0;
        this.talk = 0;
      }
    }
  }
}

export interface Segment {
  /** Seconds into the recording. */
  from: number;
  to: number;
}

export interface Plan {
  keep: Segment[];
  /** What was taken out and why, for the sidecar and the log. */
  cuts: (Segment & { why: 'music' | 'pause' })[];
}

/**
 * What stays in the music-free version. Pure: levels in, seconds out.
 * Everything before the first and after the last talk goes (but `LEAD_SEC` /
 * `TAIL_SEC`); in between, a stretch without talk is cut when it holds at
 * least `minCutSec` of music-only frames (keeping `MUSIC_PAD_SEC` each side)
 * or is longer than `MAX_PAUSE_SEC` (keeping `PAUSE_PAD_SEC` each side).
 */
export function planKeep(talkDb: number[], progDb: number[], minCutSec: number): Plan {
  const n = Math.min(talkDb.length, progDb.length);
  const kind: ('talk' | 'music' | 'quiet')[] = [];
  for (let i = 0; i < n; i++) {
    const music = progDb[i] > MUSIC_MIN_DB && progDb[i] - talkDb[i] >= MUSIC_OVER_TALK_DB;
    kind.push(music ? 'music' : talkDb[i] > TALK_MIN_DB ? 'talk' : 'quiet');
  }
  const first = kind.indexOf('talk');
  const last = kind.lastIndexOf('talk');
  const total = n * FRAME_SEC;
  if (first < 0) return { keep: [], cuts: [{ from: 0, to: total, why: 'music' }] };
  const r = (x: number): number => Math.round(x * 1000) / 1000;
  const start = Math.max(0, first * FRAME_SEC - LEAD_SEC);
  const end = Math.min(total, (last + 1) * FRAME_SEC + TAIL_SEC);
  const cuts: Plan['cuts'] = [];
  if (start > 0)
    cuts.push({
      from: 0,
      to: r(start),
      why: kind.slice(0, first).includes('music') ? 'music' : 'pause',
    });
  const keep: Segment[] = [];
  let at = start;
  let i = first;
  while (i <= last) {
    if (kind[i] === 'talk') {
      i++;
      continue;
    }
    let j = i;
    let music = 0;
    while (j <= last && kind[j] !== 'talk') {
      if (kind[j] === 'music') music++;
      j++;
    }
    const a = i * FRAME_SEC;
    const b = j * FRAME_SEC;
    let cut: Plan['cuts'][number] | null = null;
    if (music * FRAME_SEC >= minCutSec)
      cut = { from: a + MUSIC_PAD_SEC, to: b - MUSIC_PAD_SEC, why: 'music' };
    else if (b - a > MAX_PAUSE_SEC)
      cut = { from: a + PAUSE_PAD_SEC, to: b - PAUSE_PAD_SEC, why: 'pause' };
    if (cut && cut.to > cut.from) {
      keep.push({ from: r(at), to: r(cut.from) });
      cuts.push({ ...cut, from: r(cut.from), to: r(cut.to) });
      at = cut.to;
    }
    i = j;
  }
  keep.push({ from: r(at), to: r(end) });
  if (end < total)
    cuts.push({
      from: r(end),
      to: r(total),
      why: kind.slice(last + 1).includes('music') ? 'music' : 'pause',
    });
  return { keep: keep.filter((s) => s.to - s.from > 2 * FADE_SEC), cuts };
}

/** ffmpeg filter graph: the kept pieces, faded, joined, into `[cat]`. */
export function buildFilter(keep: Segment[]): string {
  const parts = keep.map((s, k) => {
    const len = s.to - s.from;
    return (
      `[0:a]atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${FADE_SEC},afade=t=out:st=${(len - FADE_SEC).toFixed(3)}:d=${FADE_SEC}[s${k}]`
    );
  });
  const join =
    keep.length === 1
      ? '[s0]anull[cat]'
      : `${keep.map((_, k) => `[s${k}]`).join('')}concat=n=${keep.length}:v=0:a=1[cat]`;
  return [...parts, join].join(';');
}

export interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/** The JSON block loudnorm prints at the end of its first pass. */
export function parseLoudnorm(stderr: string): LoudnormMeasure | null {
  const at = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (at < 0 || end < at) return null;
  try {
    const j = JSON.parse(stderr.slice(at, end + 1)) as Record<string, string>;
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;
    if (!keys.every((k) => typeof j[k] === 'string' && Number.isFinite(Number(j[k])))) return null;
    return j as unknown as LoudnormMeasure;
  } catch {
    return null;
  }
}

export type Runner = (args: string[]) => Promise<{ code: number | null; stderr: string }>;

/** ffmpeg at low priority (an export never competes with a show). */
export const runFfmpeg: Runner = (args) =>
  new Promise((resolve) => {
    const p = spawn('nice', ['-n', '10', 'ffmpeg', ...args]);
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 16));
    });
    p.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    p.on('close', (code) => resolve({ code, stderr }));
  });

export interface ExportJob {
  /** The talk stem (`….wort.flac`). */
  input: string;
  /** The MP3 to write. */
  output: string;
  plan: Plan;
  cfg: MusicFreeConfig;
  tags: Record<string, string>;
  log: Log;
  run?: Runner;
}

/** Cut, normalise and encode. Resolves to the MP3's path, or null. Writes a
 *  `.json` beside it listing every cut. */
export async function exportMusicFree(job: ExportJob): Promise<string | null> {
  const { input, output, plan, cfg, log } = job;
  const run = job.run ?? runFfmpeg;
  if (!plan.keep.length) {
    log.warn(`music-free export: no talk in ${input}, nothing written`);
    return null;
  }
  const filter = buildFilter(plan.keep);
  const ln = `I=${cfg.targetLufs}:TP=${cfg.truePeakDb}:LRA=20`;
  const pass1 = await run([
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-filter_complex',
    `${filter};[cat]loudnorm=${ln}:print_format=json[out]`,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
  ]);
  const m = pass1.code === 0 ? parseLoudnorm(pass1.stderr) : null;
  if (!m) {
    log.error(`music-free export: measuring failed (${pass1.stderr.trim().split('\n').pop()})`);
    return null;
  }
  const measured =
    `measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:` +
    `measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const tagArgs = Object.entries(job.tags).flatMap(([k, v]) =>
    v ? ['-metadata', `${k}=${v}`] : []
  );
  const pass2 = await run([
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-i',
    input,
    '-filter_complex',
    `${filter};[cat]loudnorm=${ln}:${measured},aresample=48000[out]`,
    '-map',
    '[out]',
    '-c:a',
    'libmp3lame',
    '-b:a',
    `${cfg.mp3Kbps}k`,
    '-id3v2_version',
    '3',
    ...tagArgs,
    '-y',
    output,
  ]);
  if (pass2.code !== 0) {
    log.error(`music-free export failed: ${pass2.stderr.trim().split('\n').pop()}`);
    return null;
  }
  try {
    fs.writeFileSync(
      output.replace(/\.mp3$/, '.json'),
      JSON.stringify({ source: input, keep: plan.keep, cuts: plan.cuts }, null, 2)
    );
  } catch (err) {
    log.warn(`music-free export: could not write the cut list: ${(err as Error).message}`);
  }
  const kept = plan.keep.reduce((a, s) => a + s.to - s.from, 0);
  log.info(
    `music-free export: ${output} (${(kept / 60).toFixed(1)} min, ` +
      `${plan.cuts.filter((c) => c.why === 'music').length} music cuts)`
  );
  return output;
}

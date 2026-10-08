import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Pipeline } from '../src/pipeline';
import { StudioboxConfig } from '../src/config/schema';
import { SR, bypass, config, mic, rmsDb, scale, silence, tone } from '../test-support/config';
import { mix, noise, voice } from '../test-support/voice';

/**
 * Wiring tests for the live pipeline. No sound card and no capture process:
 * the blocks are fed straight into the block handler and time is virtual
 * (Date.now advances with the samples), so an air delay of seconds costs
 * nothing. The recorders are real ffmpeg processes.
 */

const FRAMES = 1024;
const BLOCK_MS = (FRAMES / SR) * 1000;

/** The private surface these tests drive. */
interface Internals {
  onBlock(input: Float32Array[]): void;
  onCommand(type: string, value?: unknown): void;
  encoder: { write(buf: Buffer): boolean };
  recorder: { active: boolean; once(e: 'exit', f: () => void): void } | null;
  multitrack: { active: boolean; once(e: 'exit', f: () => void): void } | null;
  talkRecorder: { active: boolean; once(e: 'exit', f: () => void): void } | null;
  onScheduledStart(e: { folder: number; name: string; playAtMs: number }): void;
}

let now = 0;
let dateSpy: jest.SpyInstance;
beforeEach(() => {
  now = new Date(2026, 9, 5, 19, 0, 0).getTime();
  dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => dateSpy.mockRestore());

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pipe-'));

function make(over: Partial<StudioboxConfig> = {}, mics = [mic(1, 'Gast'), mic(2, 'Host')]) {
  const dir = tmp();
  const base = config(mics, {
    lookahead: { seconds: 1, gateMs: 10, mixMs: 100 },
    airDelay: { seconds: 4, toleranceSeconds: 1 },
    stateFile: path.join(dir, 'session-state.json'),
  });
  const cfg: StudioboxConfig = {
    ...base,
    ...over,
    output: {
      ...base.output,
      ...(over.output ?? {}),
      backup: {
        enabled: true,
        dir,
        segmentSeconds: 0,
        station: 'Radio Z',
        ...(over.output?.backup?.autoArm ? { autoArm: true } : {}),
      },
    },
  };
  const pipeline = new Pipeline(cfg);
  const p = pipeline as unknown as Internals;
  const aired: { atMs: number; buf: Buffer }[] = [];
  p.encoder.write = (buf: Buffer) => {
    aired.push({ atMs: now, buf });
    return true;
  };
  /** Feed per-channel signals; virtual time advances one block per block. */
  const feed = (channels: Float32Array[]) => {
    const n = Math.floor(channels[0].length / FRAMES) * FRAMES;
    for (let o = 0; o < n; o += FRAMES) {
      now += BLOCK_MS;
      p.onBlock(channels.map((c) => c.slice(o, o + FRAMES)));
    }
  };
  const quiet = (seconds: number) => feed(cfg.channels.map(() => silence(seconds)));
  return { pipeline, p, cfg, dir, aired, feed, quiet };
}

/** Left channel of everything that went to the output, as one array. */
const airedLeft = (aired: { buf: Buffer }[]): Float32Array => {
  const out = new Float32Array(aired.length * FRAMES);
  aired.forEach((a, b) => {
    for (let i = 0; i < FRAMES; i++) out[b * FRAMES + i] = a.buf.readFloatLE(i * 8);
  });
  return out;
};

/** Decode a recording to raw float, one Float32Array per channel. */
function decode(file: string, channels: number): Float32Array[] {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-'], {
    maxBuffer: 1 << 28,
  });
  const raw = new Float32Array(res.stdout.buffer, res.stdout.byteOffset, res.stdout.length / 4);
  const frames = raw.length / channels;
  return Array.from({ length: channels }, (_, c) => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = raw[i * channels + c];
    return ch;
  });
}

const exited = (r: { once(e: 'exit', f: () => void): void } | null) =>
  new Promise<void>((resolve) => (r ? r.once('exit', () => resolve()) : resolve()));

describe('Pipeline: air delay and Sendezeit (roadmap M1.2)', () => {
  it('airs the programme D after the room and reports the measured delay', () => {
    const { pipeline, aired, feed } = make();
    expect(pipeline.snapshot().air).toMatchObject({
      targetMs: 4000,
      delayMs: null,
      state: 'filling',
    });

    // A click at a known moment of room time, then 6 s of room tone.
    const t0 = now;
    const click = silence(6);
    click[0] = 0.5;
    feed([click, silence(6)]);

    const snap = pipeline.snapshot();
    expect(snap.air!.state).toBe('live');
    // capture latency (20 ms) is part of D; blocks are released on block boundaries.
    expect(Math.abs(snap.air!.delayMs! - 4000)).toBeLessThan(BLOCK_MS + 1);
    expect(Math.abs(snap.air!.nowMs - (now + 4000))).toBeLessThan(BLOCK_MS + 1);

    // The click airs D after it was made in the room. Its sample arrived at
    // t0 (the clock pins sample 0 to the start of the stream); the 20 ms
    // capture latency is part of D.
    const left = airedLeft(aired);
    let peak = 0;
    for (let i = 1; i < left.length; i++) if (Math.abs(left[i]) > Math.abs(left[peak])) peak = i;
    const airedAt = aired[Math.floor(peak / FRAMES)].atMs + ((peak % FRAMES) / SR) * 1000;
    expect(Math.abs(airedAt - t0 - (4000 - 20))).toBeLessThan(BLOCK_MS + 1);
    // Before that only the graph's pre-roll (silence) went out.
    expect(rmsDb(left, 0, peak - 100)).toBeLessThan(-100);
  });

  it('cannot be shorter than the chain: D is raised to the look-ahead', () => {
    const { pipeline } = make({ airDelay: { seconds: 0, toleranceSeconds: 1 } });
    const target = pipeline.snapshot().air!.targetMs;
    expect(target).toBeGreaterThan(1100); // 1 s leveler + gate + mix + limiter
    expect(target).toBeLessThan(1300);
  });

  it('"Sendung beenden" closes the mics, plays the buffer out, then stops the recording', async () => {
    const { pipeline, p, aired, feed, quiet } = make();
    p.onCommand('recording', true);
    feed([tone(-20, 5), silence(5)]);
    expect(pipeline.snapshot().recording).toBe(true);

    const pressed = now;
    p.onCommand('endShow');
    let snap = pipeline.snapshot();
    expect(snap.micsMuted).toBe(true);
    expect(snap.air!.state).toBe('draining');
    expect(snap.air!.drainEndsMs! - pressed).toBeGreaterThan(4000);

    // The room keeps talking; none of it may air.
    const rec = exited(p.recorder);
    feed([tone(-20, 3), silence(3)]);
    expect(pipeline.snapshot().air!.state).toBe('draining'); // 3 s in: still playing out
    const stillAiring = airedLeft(
      aired.filter((a) => a.atMs > pressed + 1000 && a.atMs < pressed + 3000)
    );
    expect(rmsDb(stillAiring)).toBeGreaterThan(-40); // what was said before the press

    feed([tone(-20, 3), silence(3)]);
    snap = pipeline.snapshot();
    expect(snap.air!.state).toBe('ended');
    expect(snap.recording).toBe(false);
    await rec;
    const after = airedLeft(aired.filter((a) => a.atMs > pressed + 4500));
    expect(rmsDb(after)).toBeLessThan(-90); // nothing said after the press aired

    // Opening the mics again goes back on air.
    p.onCommand('micsMuted', false);
    expect(pipeline.snapshot().air!.state).toBe('live');
    quiet(0.1);
  }, 20000);

  it('endShow can be cancelled', () => {
    const { pipeline, p, quiet } = make();
    quiet(5);
    p.onCommand('endShow');
    p.onCommand('endShow', false);
    expect(pipeline.snapshot().air!.state).toBe('live');
    expect(pipeline.snapshot().micsMuted).toBe(true); // stays closed until opened
  });
});

describe('Pipeline: recording (roadmap M1.6)', () => {
  it('writes stereo + multitrack from the same blocks: aligned, programme identical', async () => {
    const { pipeline, p, dir, feed } = make({
      output: { ...config([]).output, multitrack: { enabled: true, source: 'dry' } },
    });
    expect(pipeline.snapshot().multitrack).toBe(false);
    p.onCommand('recording', true);
    expect(pipeline.snapshot().multitrack).toBe(true);
    const startedAt = now;

    // A click on the guest mic 0.5 s in, the host talking all along.
    const click = silence(3);
    click[Math.round(0.5 * SR)] = 0.4;
    feed([click, tone(-30, 3, 300)]);

    // Stop: the recording keeps running until the look-ahead has played out.
    const done = Promise.all([exited(p.recorder), exited(p.multitrack)]);
    p.onCommand('recording', false);
    expect(pipeline.snapshot().recording).toBe(true);
    feed([silence(1.5), silence(1.5)]);
    expect(pipeline.snapshot().recording).toBe(false);
    await done;

    const files = fs.readdirSync(dir).sort();
    expect(files.length).toBe(3);
    const stereoFile = files.find((f) => /^studiobox-\d{8}-\d{6}\.flac$/.test(f))!;
    const multiFile = files.find((f) => f.endsWith('.multitrack.flac'))!;
    const mapFile = files.find((f) => f.endsWith('.multitrack.json'))!;
    expect(multiFile).toBe(stereoFile.replace('.flac', '.multitrack.flac'));
    // Named by the on-air time of the first sample: now - look-ahead + D.
    const map = JSON.parse(fs.readFileSync(path.join(dir, mapFile), 'utf8'));
    const expectStart = startedAt - 1115 + 4000;
    expect(Math.abs(new Date(map.startedAt).getTime() - expectStart)).toBeLessThan(50);
    expect(map.channels.map((c: { name: string }) => c.name)).toEqual([
      'Gast',
      'Host',
      'Programm L',
      'Programm R',
    ]);
    expect(map.source).toBe('dry');
    expect(map.stereo).toBe(stereoFile);

    const stereo = decode(path.join(dir, stereoFile), 2);
    const multi = decode(path.join(dir, multiFile), 4);
    expect(multi[0].length).toBe(stereo[0].length);
    // Everything said up to the stop is in the file: 3 s + the flushed look-ahead.
    expect(stereo[0].length / SR).toBeGreaterThan(3 + 1.1);
    // The programme channels of the multitrack are the stereo file (24 bit).
    let worst = 0;
    for (let i = 0; i < stereo[0].length; i++) {
      worst = Math.max(
        worst,
        Math.abs(multi[2][i] - stereo[0][i]),
        Math.abs(multi[3][i] - stereo[1][i])
      );
    }
    expect(worst).toBeLessThan(1e-6);
    // The dry click and the click in the programme sit on the same sample.
    const peakOf = (x: Float32Array) =>
      x.reduce((b, v, i) => (Math.abs(v) > Math.abs(x[b]) ? i : b), 0);
    const dryAt = peakOf(multi[0]);
    expect(multi[0][dryAt]).toBeCloseTo(0.4, 4);
    const hostless = stereo[0].map((v, i) => Math.abs(v) - Math.abs(multi[1][i]) * 0); // programme
    const win = hostless.subarray(dryAt - 50, dryAt + 50);
    expect(peakOf(win)).toBe(50);
  }, 30000);

  it('tags the stereo file', async () => {
    const { p, dir, quiet } = make();
    p.onCommand('recording', true);
    quiet(0.5);
    const done = exited(p.recorder);
    p.onCommand('recording', false);
    quiet(1.5);
    await done;
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.flac'))!);
    const res = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags',
      '-of',
      'json',
      file,
    ]);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(JSON.parse(res.stdout.toString()).format.tags)) {
      tags[k.toUpperCase()] = String(v);
    }
    expect(tags.ORGANIZATION).toBe('Radio Z');
    expect(tags.DATE).toBe('2026-10-05');
    expect(tags.COMMENT).toMatch(/^processed by studiobox \d+\.\d+\.\d+$/);
    expect(tags.TITLE).toMatch(/^studiobox 20261005-1900\d\d$/);
  }, 20000);
});

const player = (dirs: { path: string; label: string; hasScheduled: boolean }[]) => ({
  enabled: true,
  dirs,
  label: 'Zuspieler',
  ducked: true,
  fadeOutMs: 0,
  prebufferMs: 0,
  autoPlay: { enabled: false, scanSeconds: 10, graceSeconds: 30 },
  bed: {
    enabled: false,
    dir: '',
    gainDb: -6,
    fadeInMs: 1500,
    fadeOutMs: 2500,
    havarie: { enabled: false, afterSeconds: 10, belowDb: -50 },
  },
  streams: [],
  processing: bypass(),
});

const until = async (ok: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await new Promise((r) => setTimeout(r, 50));
};

describe('Pipeline: auto-arm and the music-free export', () => {
  it('a scheduled file arms the recording when nobody has (backup.autoArm)', async () => {
    const jdir = tmp();
    const name = '20261005-190010 Intro.wav';
    spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', path.join(jdir, name)]);
    const filePlayer = player([{ path: jdir, label: 'Jingles', hasScheduled: true }]);
    const off = make({ filePlayer });
    off.p.onScheduledStart({ folder: 0, name, playAtMs: now + 3000 });
    expect(off.p.recorder!.active).toBe(false);
    off.pipeline.stop();

    const on = make({
      filePlayer,
      output: { ...config([]).output, backup: { autoArm: true } as never },
    });
    on.p.onScheduledStart({ folder: 0, name, playAtMs: now + 3000 });
    expect(on.pipeline.snapshot().recording).toBe(true);
    // A missing file arms nothing (and nothing breaks).
    const again = make({
      filePlayer,
      output: { ...config([]).output, backup: { autoArm: true } as never },
    });
    again.p.onScheduledStart({ folder: 0, name: 'gone.wav', playAtMs: now + 3000 });
    expect(again.p.recorder!.active).toBe(false);
    const done = exited(on.p.recorder);
    on.p.onCommand('recording', false);
    on.quiet(1.5);
    await done;
    on.pipeline.stop();
    again.pipeline.stop();
  }, 30000);

  it('writes the talk stem and, after the stop, an MP3 without the music', async () => {
    const musicCh = {
      source: [3, 4] as [number, number],
      role: 'music' as const,
      label: 'Musik',
      processing: bypass(),
    };
    const { p, dir, feed } = make(
      {
        output: {
          ...config([]).output,
          musicFree: {
            enabled: true,
            targetLufs: -16,
            truePeakDb: -1.5,
            mp3Kbps: 128,
            minCutSec: 2,
          },
        },
      },
      [mic(1, 'Gast'), mic(2, 'Host'), musicCh]
    );
    p.onCommand('recording', true);
    expect(p.talkRecorder!.active).toBe(true);
    const talk = voice({ seconds: 3, rmsDb: -20 });
    // Talk, a 4 s song with nobody talking, talk again.
    feed([silence(3), talk, silence(3), silence(3)]);
    feed([silence(4), silence(4), tone(-20, 4, 440), tone(-20, 4, 440)]);
    feed([silence(3), talk, silence(3), silence(3)]);
    const done = Promise.all([exited(p.recorder), exited(p.talkRecorder)]);
    p.onCommand('recording', false);
    feed([silence(1.5), silence(1.5), silence(1.5), silence(1.5)]);
    await done;
    const mp3 = () => fs.readdirSync(dir).find((f) => f.endsWith('.ohne-musik.mp3'));
    const json = () => fs.readdirSync(dir).find((f) => f.endsWith('.ohne-musik.json'));
    await until(() => !!json(), 20000);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.endsWith('.wort.flac'))).toBe(true);
    expect(mp3()).toBeDefined();
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, json()!), 'utf8'));
    const music = sidecar.cuts.filter((c: { why: string }) => c.why === 'music');
    expect(music.length).toBe(1);
    expect(music[0].to - music[0].from).toBeGreaterThan(3);
    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=title',
      '-of',
      'json',
      path.join(dir, mp3()!),
    ]);
    const info = JSON.parse(probe.stdout.toString());
    // 3 s + 3 s of talk, the song gone.
    expect(Number(info.format.duration)).toBeGreaterThan(5.5);
    expect(Number(info.format.duration)).toBeLessThan(8);
    expect(info.format.tags.title).toMatch(/ohne Musik/);
  }, 40000);
});

describe('Pipeline: Auto-Pegel', () => {
  it('a hand trim switches the mic to manual; autoTrim switches it back; both persist', () => {
    const { pipeline, p, cfg } = make({
      autoTrim: {
        enabled: true,
        targetDb: -20,
        minDb: -10,
        maxDb: 30,
        rateDbPerSec: 2,
        maxLagMs: 10,
      },
    });
    const ch = (l: string) => pipeline.snapshot().channels.find((c) => c.label === l)!;
    expect(ch('Gast').autoTrim).toBe(true);
    p.onCommand('trim', { label: 'Gast', trimDb: 6 });
    expect(ch('Gast').autoTrim).toBe(false);
    expect(ch('Gast').trimDb).toBe(6);
    expect(ch('Host').autoTrim).toBe(true);
    let saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    expect(saved.manualTrim).toEqual(['Gast']);
    // After a restart the hand trim is still the technician's.
    const again = new Pipeline(cfg);
    const ch2 = again.snapshot().channels.find((c) => c.label === 'Gast')!;
    expect(ch2.autoTrim).toBe(false);
    expect(ch2.trimDb).toBe(6);
    p.onCommand('autoTrim', { label: 'Gast', on: true });
    expect(ch('Gast').autoTrim).toBe(true);
    saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    expect(saved.manualTrim).toEqual([]);
    // Without a label: every mic.
    p.onCommand('autoTrim', { on: false });
    expect([ch('Gast').autoTrim, ch('Host').autoTrim]).toEqual([false, false]);
  });
});

describe('Pipeline: setup assistant and live settings (roadmap M1.1)', () => {
  const profile = () =>
    bypass({
      hpfHz: 80,
      gate: {
        enabled: true,
        thresholdDb: -50,
        rangeDb: -15,
        attackMs: 3,
        holdMs: 150,
        releaseMs: 180,
      },
      deesser: { enabled: true, freq: 6500, thresholdDb: -26, ratio: 4 },
      compressor: {
        enabled: true,
        thresholdDb: -22,
        ratio: 3,
        kneeDb: 6,
        attackMs: 8,
        releaseMs: 140,
        makeupDb: 4,
      },
      leveler: { enabled: true, targetLufs: -23, maxGainDb: 18, rangeDb: 15, responseMs: 1500 },
    });
  const mics = () => [mic(1, 'Gast', profile()), mic(2, 'Host', profile())];
  const floor = (s: number, seed: number) => noise(-90, s, seed);

  it('measures, applies live, persists, and comes back after a restart', () => {
    const { pipeline, p, cfg, feed } = make({}, mics());
    p.onCommand('setupStart');
    expect(pipeline.snapshot().setup.phase).toBe('silence');
    feed([floor(5.2, 1), floor(5.2, 2)]);
    expect(pipeline.snapshot().setup).toMatchObject({ phase: 'speakers', current: 'Gast' });

    const guest = voice({ rmsDb: -33, f0: 120, seconds: 9, sibilants: true });
    feed([mix(guest, floor(9, 3)), mix(scale(guest, -25), floor(9, 4))]);
    expect(pipeline.snapshot().setup.current).toBe('Host');
    const host = voice({ rmsDb: -48, f0: 200, seconds: 9, sibilants: true, seed: 9 });
    feed([mix(scale(host, -25), floor(9, 5)), mix(host, floor(9, 6))]);

    const setup = pipeline.snapshot().setup;
    expect(setup.phase).toBe('result');
    expect(setup.results!.map((r) => r.label)).toEqual(['Gast', 'Host']);
    expect(setup.results![1].after!.trimDb).toBeCloseTo(28, 0);
    // Nothing is applied before "Übernehmen".
    expect(pipeline.snapshot().channels.map((c) => c.trimDb)).toEqual([0, 0]);
    expect(pipeline.snapshot().setupApplied).toBe(false);
    expect(fs.existsSync(cfg.stateFile)).toBe(false);

    p.onCommand('setupApply');
    const snap = pipeline.snapshot();
    expect(snap.setup.phase).toBe('idle');
    expect(snap.setupApplied).toBe(true);
    expect(snap.channels[0].trimDb).toBeCloseTo(13, 0);
    expect(snap.channels[1].trimDb).toBeCloseTo(28, 0);
    // The YAML-side config object is untouched; the state file has the result.
    expect(cfg.channels[1].processing.trimDb).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    expect(saved.mics.Host.trimDb).toBeCloseTo(28, 0);

    // The guest indicator reads "passt" at the distance that was measured.
    feed([mix(guest, floor(9, 3)).subarray(0, 3 * SR), floor(3, 4)]);
    expect(pipeline.snapshot().channels[0].zone).toBe('ok');

    // A restart (crash mid-show) comes back with the mics as they were.
    const again = new Pipeline(cfg);
    const back = again.snapshot();
    expect(back.setupApplied).toBe(true);
    expect(back.channels[1].trimDb).toBeCloseTo(28, 0);
    expect(back.channels[1].levelerDb).toBeCloseTo(setup.results![1].after!.seedDb, 1);
  }, 30000);

  it('discard leaves everything as it was', () => {
    const { pipeline, p, cfg, feed } = make({}, mics());
    p.onCommand('setupStart');
    feed([floor(5.2, 1), floor(5.2, 2)]);
    p.onCommand('setupDiscard');
    expect(pipeline.snapshot().setup.phase).toBe('idle');
    expect(pipeline.snapshot().channels.map((c) => c.trimDb)).toEqual([0, 0]);
    expect(fs.existsSync(cfg.stateFile)).toBe(false);
  });

  it('a hand trim applies live and persists', () => {
    const { pipeline, p, cfg } = make({}, mics());
    p.onCommand('trim', { label: 'Host', trimDb: 12 });
    expect(pipeline.snapshot().channels[1].trimDb).toBe(12);
    p.onCommand('trim', { label: 'Host', trimDb: 99 }); // clamped
    expect(pipeline.snapshot().channels[1].trimDb).toBe(40);
    p.onCommand('trim', { label: 'Nobody', trimDb: 3 }); // ignored
    expect(JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).mics.Host.trimDb).toBe(40);
  });
});

describe('Pipeline: music return level', () => {
  it('starts from the config, changes live and comes back after a restart', () => {
    const ret = { enabled: true, backend: 'alsa' as const, device: 'null', gainDb: -12 };
    const { pipeline, p, cfg } = make({ output: { return: ret } as StudioboxConfig['output'] });
    expect(pipeline.snapshot().returnGainDb).toBe(-12);
    p.onCommand('returnGain', -20);
    expect(pipeline.snapshot().returnGainDb).toBe(-20);
    expect(JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).returnGainDb).toBe(-20);
    expect(new Pipeline(cfg).snapshot().returnGainDb).toBe(-20);
  });

  it('is null and ignores the command without a return', () => {
    const { pipeline, p } = make();
    p.onCommand('returnGain', -20);
    expect(pipeline.snapshot().returnGainDb).toBeNull();
  });
});

describe('Pipeline: Abhören (roadmap M1c.4)', () => {
  /** A fake MP3 encoder that keeps the left channel it was fed. */
  const encoders: { left: number[]; killed: boolean }[] = [];
  const spawn = () => {
    const e = { left: [] as number[], killed: false };
    encoders.push(e);
    const stdin = new PassThrough();
    stdin.on('data', (b: Buffer) => {
      for (let i = 0; i + 7 < b.length; i += 8) e.left.push(b.readFloatLE(i));
    });
    return { stdin, stdout: new PassThrough(), kill: () => (e.killed = true), on: () => {} };
  };
  const client = () =>
    Object.assign(new EventEmitter(), { write: () => true, writableLength: 0, destroy() {} });

  it('runs no encoder while nobody listens; a listener hears the dry mics with their trim', async () => {
    encoders.length = 0;
    const dir = tmp();
    const base = config([mic(1, 'Gast'), mic(2, 'Host')], {
      lookahead: { seconds: 0.5, gateMs: 10, mixMs: 100 },
      stateFile: path.join(dir, 'session-state.json'),
    });
    const cfg = { ...base, meters: { ...base.meters, enabled: true } };
    const pipeline = new Pipeline(cfg, { listenSpawn: spawn });
    const p = pipeline as unknown as Internals & {
      listen: { attach(id: string, src: string, c: unknown): string; count: number };
      encoder: { write(b: Buffer): boolean };
    };
    p.encoder.write = () => true;
    const block = (v: number) => new Float32Array(FRAMES).fill(v);
    const run = (blocks: number) => {
      for (let i = 0; i < blocks; i++) {
        now += BLOCK_MS;
        p.onBlock([block(0), block(0.05)]);
      }
    };
    run(20);
    expect(encoders).toHaveLength(0);
    p.onCommand('trim', { label: 'Host', trimDb: 6 });
    expect(p.listen.attach('tab-1', 'mic:Host', client())).toBe('ok');
    run(60); // past the look-ahead: the dry tap carries the 0.05 by now
    await new Promise((r) => setImmediate(r));
    expect(encoders[0].left[encoders[0].left.length - 1]).toBeCloseTo(
      0.05 * Math.pow(10, 6 / 20),
      4
    );
    p.onCommand('listen', { id: 'tab-1', src: 'rec' });
    run(4);
    await new Promise((r) => setImmediate(r));
    expect(encoders).toHaveLength(1); // the same stream, switched on the box
    pipeline.stop();
    expect(encoders[0].killed).toBe(true);
  });
});

describe('Pipeline: output target (roadmap M1c.3)', () => {
  function build(target?: 'usb' | 'stream' | 'both') {
    const dir = tmp();
    const base = config([mic(1, 'Host')], {
      lookahead: { seconds: 0.5, gateMs: 10, mixMs: 100 },
      airDelay: { seconds: 6, toleranceSeconds: 1 },
      stateFile: path.join(dir, 'session-state.json'),
    });
    const cfg: StudioboxConfig = {
      ...base,
      meters: { ...base.meters, enabled: true },
      output: {
        ...base.output,
        monitor: { enabled: true, backend: 'alsa', device: 'null', latencyMs: 2000 },
        serve: { enabled: true, mp3Kbps: 320, latencyMs: 2600 },
        target,
      },
    };
    const spawn = () => ({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: () => {},
      on: () => {},
    });
    const pipeline = new Pipeline(cfg, { listenSpawn: spawn });
    const p = pipeline as unknown as Internals & {
      monitor: { start(): void; stop(): void; proc: unknown };
      monitorArmed: boolean;
    };
    // A sound card that "runs" without aplay.
    p.monitor.start = () => {
      p.monitor.proc = {};
    };
    p.monitor.stop = () => {
      p.monitor.proc = null;
    };
    p.monitorArmed = target !== 'stream'; // as start() arms it
    if (p.monitorArmed) p.monitor.start();
    if (target === 'usb') p.onCommand('serve', false);
    const sent: number[] = [];
    p.encoder.write = (buf: Buffer) => {
      let peak = 0;
      for (let i = 0; i < buf.length; i += 4) peak = Math.max(peak, Math.abs(buf.readFloatLE(i)));
      if (peak > 0.01) sent.push(now);
      return true;
    };
    return { pipeline, p, sent };
  }

  it('switches between USB, stream and both without a restart', () => {
    const { pipeline, p } = build('usb');
    expect(pipeline.snapshot().outputTarget).toBe('usb');
    expect(pipeline.snapshot().air.path).toBe('usb');
    p.onCommand('outputTarget', 'stream');
    expect(pipeline.snapshot()).toMatchObject({ outputTarget: 'stream', monitor: false });
    expect(pipeline.snapshot().serve).toMatchObject({ on: true });
    expect(pipeline.snapshot().air.path).toBe('stream');
    p.onCommand('outputTarget', 'both');
    expect(pipeline.snapshot().outputTarget).toBe('both');
    expect(pipeline.snapshot().air.path).toBe('usb'); // the card is the reference
    p.onCommand('outputTarget', 'nonsense');
    expect(pipeline.snapshot().outputTarget).toBe('both');
    p.onCommand('serve', false);
    p.onCommand('monitor', false);
    expect(pipeline.snapshot().outputTarget).toBe('none');
    expect(pipeline.snapshot().air.path).toBeNull();
    pipeline.stop();
  });

  it('hands the stream its blocks early by its latency, so they air at Sendezeit', () => {
    const { pipeline, p, sent } = build('stream');
    // Talk starts in the room at t0; the stream should get it at
    // t0 + D - 2.6 s, so the desk plays it at t0 + D.
    const talk = tone(-20, 1);
    const t0 = now;
    for (let i = 0; i < Math.round((8 * SR) / FRAMES); i++) {
      now += BLOCK_MS;
      const o = i * FRAMES;
      p.onBlock([o < talk.length ? talk.slice(o, o + FRAMES) : new Float32Array(FRAMES)]);
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0] - t0).toBeGreaterThan(6000 - 2600 - 2 * BLOCK_MS);
    expect(sent[0] - t0).toBeLessThan(6000 - 2600 + 2 * BLOCK_MS + 650);
    expect(pipeline.snapshot().outputTarget).toBe('stream');
    pipeline.stop();
  });

  it('is null unless both a sound card and the stream are configured', () => {
    expect(make().pipeline.snapshot().outputTarget).toBeNull();
  });
});

describe('Pipeline: programme stream (roadmap M1c.1)', () => {
  it('is null unless configured', () => {
    expect(make().pipeline.snapshot().serve).toBeNull();
  });

  it('serves what leaves the box, and the technician switches it', async () => {
    const encoders: { bytes: number; killed: boolean }[] = [];
    const spawn = () => {
      const e = { bytes: 0, killed: false };
      encoders.push(e);
      const stdin = new PassThrough();
      stdin.on('data', (b: Buffer) => (e.bytes += b.length));
      return { stdin, stdout: new PassThrough(), kill: () => (e.killed = true), on: () => {} };
    };
    const dir = tmp();
    const base = config([mic(1, 'Host')], {
      lookahead: { seconds: 0.5, gateMs: 10, mixMs: 100 },
      airDelay: { seconds: 2, toleranceSeconds: 1 },
      stateFile: path.join(dir, 'session-state.json'),
    });
    const cfg = {
      ...base,
      meters: { ...base.meters, enabled: true },
      output: { ...base.output, serve: { enabled: true, mp3Kbps: 320, latencyMs: 2600 } },
    };
    const pipeline = new Pipeline(cfg, { listenSpawn: spawn });
    const p = pipeline as unknown as Internals & {
      serve: { attach(f: string, c: unknown): string };
    };
    p.encoder.write = () => true;
    expect(pipeline.snapshot().serve).toEqual({ on: true, clients: 0 });
    const client = Object.assign(new EventEmitter(), {
      write: () => true,
      writableLength: 0,
      destroy() {
        this.emit('close');
      },
    });
    expect(p.serve.attach('flac', client)).toBe('ok');
    expect(pipeline.snapshot().serve).toEqual({ on: true, clients: 1 });
    for (let i = 0; i < 200; i++) {
      now += BLOCK_MS;
      p.onBlock([new Float32Array(FRAMES)]);
    }
    await new Promise((r) => setImmediate(r));
    // The stream alone feeds the desk: blocks leave its latency (2.6 s)
    // ahead of their Sendezeit. D is raised to just fit it (look-ahead +
    // capture + 2.6 s), so a block leaves about as soon as the graph has
    // it: nearly all of the 4.3 s fed.
    const seconds = encoders[0].bytes / 8 / SR;
    expect(seconds).toBeGreaterThan(3.9);
    expect(seconds).toBeLessThan(4.3);
    expect(pipeline.snapshot().air.targetMs).toBeGreaterThan(3100);
    p.onCommand('serve', false);
    expect(pipeline.snapshot().serve).toEqual({ on: false, clients: 0 });
    expect(encoders[0].killed).toBe(true);
    pipeline.stop();
  });
});

describe('Pipeline: music level on air', () => {
  it('starts at 0 dB, changes live and comes back after a restart', () => {
    const { pipeline, p, cfg } = make();
    expect(pipeline.snapshot().musicGainDb).toBe(0);
    p.onCommand('musicGain', -4);
    expect(pipeline.snapshot().musicGainDb).toBe(-4);
    p.onCommand('musicGain', 'loud'); // ignored
    expect(pipeline.snapshot().musicGainDb).toBe(-4);
    expect(JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')).musicGainDb).toBe(-4);
    expect(new Pipeline(cfg).snapshot().musicGainDb).toBe(-4);
  });
});

describe('Pipeline: live status', () => {
  it('reports queue mode, tone, return, bed and priority state', () => {
    const { pipeline, p } = make();
    const s = pipeline.snapshot();
    expect(s.queueMode).toBeNull(); // no file player in this config
    expect(s.testTone).toBe(false);
    expect(s.musicReturn).toBeNull();
    expect(s.multitrack).toBeNull();
    expect(s.bed).toBeNull();
    expect(s.priority).toBeNull();
    p.onCommand('testTone', true); // no monitor configured: ignored
    expect(pipeline.snapshot().testTone).toBe(false);
  });
});

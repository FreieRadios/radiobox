import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
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
      backup: { enabled: true, dir, segmentSeconds: 0, station: 'Radio Z' },
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

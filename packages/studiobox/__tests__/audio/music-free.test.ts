import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FRAME_SEC,
  Runner,
  TalkLog,
  buildFilter,
  exportMusicFree,
  parseLoudnorm,
  planKeep,
} from '../../src/audio/music-free';
import { MusicFreeConfig } from '../../src/config/schema';
import { Log } from '../../src/util/log';

const CFG: MusicFreeConfig = {
  enabled: true,
  targetLufs: -16,
  truePeakDb: -1.5,
  mp3Kbps: 192,
  minCutSec: 2,
};
const quietLog: Log = { info: () => {}, warn: () => {}, error: () => {} };

/** A level track from `[seconds, talkDb, progDb]` stretches. */
function track(...parts: [number, number, number][]): { talk: number[]; prog: number[] } {
  const talk: number[] = [];
  const prog: number[] = [];
  for (const [sec, t, p] of parts) {
    for (let i = 0; i < Math.round(sec / FRAME_SEC); i++) {
      talk.push(t);
      prog.push(p);
    }
  }
  return { talk, prog };
}

const TALK: [number, number, number] = [0, -22, -22]; // talk, no music
const SONG: [number, number, number] = [0, -70, -18]; // music only
const SILENT: [number, number, number] = [0, -80, -80];
const OVER: [number, number, number] = [0, -22, -21]; // talk over ducked music
const s = (sec: number, k: [number, number, number]): [number, number, number] => [sec, k[1], k[2]];

describe('planKeep', () => {
  it('cuts a song out between two talk stretches, keeping a short pause', () => {
    const { talk, prog } = track(s(10, TALK), s(180, SONG), s(10, TALK));
    const plan = planKeep(talk, prog, 2);
    expect(plan.keep).toEqual([
      { from: 0, to: 10.3 },
      { from: 189.7, to: 200 },
    ]);
    expect(plan.cuts).toEqual([{ from: 10.3, to: 189.7, why: 'music' }]);
  });

  it('keeps talk over the end of a song (the stem has no music under it)', () => {
    const { talk, prog } = track(s(10, TALK), s(60, SONG), s(20, OVER), s(10, TALK));
    const plan = planKeep(talk, prog, 2);
    expect(plan.keep[1]).toEqual({ from: 69.7, to: 100 });
  });

  it('drops the music before the first and after the last word (the bed, twice)', () => {
    const { talk, prog } = track(
      s(14, SONG),
      s(30, TALK),
      s(10, SILENT),
      s(10, SONG),
      s(20, SILENT),
      s(30, SONG)
    );
    const plan = planKeep(talk, prog, 2);
    expect(plan.keep).toEqual([{ from: 13.5, to: 45 }]);
    expect(plan.cuts[0]).toEqual({ from: 0, to: 13.5, why: 'music' });
    expect(plan.cuts[plan.cuts.length - 1].why).toBe('music');
  });

  it('shortens dead air, but leaves an ordinary pause alone', () => {
    const { talk, prog } = track(s(5, TALK), s(3, SILENT), s(5, TALK), s(9, SILENT), s(5, TALK));
    const plan = planKeep(talk, prog, 2);
    expect(plan.cuts).toEqual([{ from: 13.5, to: 21.5, why: 'pause' }]);
  });

  it('a short sting between sentences stays (shorter than minCutSec)', () => {
    const { talk, prog } = track(s(5, TALK), s(1.5, SONG), s(5, TALK));
    expect(planKeep(talk, prog, 2).cuts).toEqual([]);
  });

  it('nothing to keep without any talk', () => {
    const { talk, prog } = track(s(30, SONG));
    expect(planKeep(talk, prog, 2).keep).toEqual([]);
  });
});

describe('TalkLog', () => {
  it('logs both levels per 100 ms', () => {
    const log = new TalkLog(48000);
    const a = new Float32Array(4800).fill(0.1); // -20 dBFS
    const z = new Float32Array(4800);
    log.push(a, a, z, z, 4800);
    log.push(a, a, a, a, 4800);
    expect(log.progDb).toEqual([-20, -20]);
    expect(log.talkDb[0]).toBeLessThan(-150);
    expect(log.talkDb[1]).toBe(-20);
  });
});

describe('buildFilter / parseLoudnorm', () => {
  it('trims, fades and joins the kept pieces', () => {
    const f = buildFilter([
      { from: 0, to: 10.3 },
      { from: 189.7, to: 200 },
    ]);
    expect(f).toContain('[0:a]atrim=start=0.000:end=10.300');
    expect(f).toContain('afade=t=out:st=10.280:d=0.02[s0]');
    expect(f).toContain('[s0][s1]concat=n=2:v=0:a=1[cat]');
    expect(buildFilter([{ from: 1, to: 2 }])).toContain('[s0]anull[cat]');
  });

  it('reads the measurement loudnorm prints', () => {
    const err =
      'size=N/A\n[Parsed_loudnorm_3 @ 0x1]\n{\n\t"input_i" : "-23.41",\n\t"input_tp" : "-4.20",\n' +
      '\t"input_lra" : "5.10",\n\t"input_thresh" : "-33.80",\n\t"output_i" : "-16.0",\n' +
      '\t"target_offset" : "0.12"\n}\n';
    expect(parseLoudnorm(err)).toMatchObject({ input_i: '-23.41', target_offset: '0.12' });
    expect(parseLoudnorm('no json here')).toBeNull();
  });
});

describe('exportMusicFree', () => {
  const t = track(s(5, TALK), s(5, SONG), s(5, TALK));
  const plan = planKeep(t.talk, t.prog, 2);

  it('measures, then encodes with the measured values and the tags', async () => {
    const calls: string[][] = [];
    const run: Runner = async (args) => {
      calls.push(args);
      return calls.length === 1
        ? {
            code: 0,
            stderr:
              '{"input_i":"-24.0","input_tp":"-6.0","input_lra":"4.0","input_thresh":"-34.0","target_offset":"0.1"}',
          }
        : { code: 0, stderr: '' };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mf-'));
    const out = path.join(dir, 'x.ohne-musik.mp3');
    const res = await exportMusicFree({
      input: 'x.wort.flac',
      output: out,
      plan,
      cfg: CFG,
      tags: { TITLE: 'Sendung (ohne Musik)' },
      log: quietLog,
      run,
    });
    expect(res).toBe(out);
    expect(calls).toHaveLength(2);
    expect(calls[1].join(' ')).toContain('measured_I=-24.0');
    expect(calls[1].join(' ')).toContain('linear=true');
    expect(calls[1]).toContain('TITLE=Sendung (ohne Musik)');
    expect(calls[1]).toContain('192k');
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'x.ohne-musik.json'), 'utf8'));
    expect(sidecar.cuts).toEqual(plan.cuts);
  });

  it('gives up cleanly when the measurement fails', async () => {
    const run: Runner = async () => ({ code: 1, stderr: 'boom' });
    const res = await exportMusicFree({
      input: 'x',
      output: 'y.mp3',
      plan,
      cfg: CFG,
      tags: {},
      log: quietLog,
      run,
    });
    expect(res).toBeNull();
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  (hasFfmpeg ? it : it.skip)(
    'really cuts: 5 s talk + 5 s cut + 5 s talk come out ~10.6 s at -16 LUFS',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mf-'));
      const input = path.join(dir, 'x.wort.flac');
      spawnSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=d=15:a=0.05:c=pink:r=48000',
        '-ac',
        '2',
        input,
      ]);
      const out = path.join(dir, 'x.ohne-musik.mp3');
      const res = await exportMusicFree({
        input,
        output: out,
        plan,
        cfg: CFG,
        tags: {},
        log: quietLog,
      });
      expect(res).toBe(out);
      const probe = spawnSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        out,
      ]);
      expect(Number(probe.stdout.toString())).toBeCloseTo(10.6, 0);
      const meas = spawnSync('ffmpeg', [
        '-hide_banner',
        '-nostats',
        '-i',
        out,
        '-af',
        'ebur128',
        '-f',
        'null',
        '-',
      ]);
      const m = /I:\s+(-?[\d.]+) LUFS/.exec(meas.stderr.toString().split('Summary')[1] ?? '');
      expect(Math.abs(Number(m?.[1]) + 16)).toBeLessThan(1);
    },
    30000
  );
});

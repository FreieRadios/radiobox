import { Graph } from '../../src/dsp/graph';
import { AutoTrimConfig, StudioboxConfig } from '../../src/config/schema';
import { SR, bypass, config, mic, rmsDb, silence, tone } from '../../test-support/config';
import { noise } from '../../test-support/voice';

const FRAMES = 1024;
const AUTO: AutoTrimConfig = {
  enabled: true,
  targetDb: -20,
  minDb: -10,
  maxDb: 30,
  rateDbPerSec: 2,
  maxLagMs: 10,
};

const player = (over: Partial<NonNullable<StudioboxConfig['filePlayer']>> = {}) => ({
  enabled: true,
  dirs: [],
  label: 'Zuspieler',
  ducked: false,
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
  ...over,
});

/** Speech-like noise at `db` dBFS RMS in phrases (2 s on, 1 s off; no
 *  pitch, see arrival.test.ts), after `leadSec` of nothing. Long phrases, so
 *  nearly every 40 ms hop is all voice or all pause. */
function talk(db: number, seconds: number, seed = 9, leadSec = 2): Float32Array {
  const x = noise(db, seconds, seed);
  const period = Math.round(3 * SR);
  const on = Math.round(2 * SR);
  const lead = Math.round(leadSec * SR);
  for (let i = 0; i < x.length; i++) if (i < lead || (i - lead) % period >= on) x[i] = 0;
  return x;
}

const plus = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
const floor = (sec: number, seed: number) => noise(-75, sec, seed);

interface Out {
  l: Float32Array;
  talkL: Float32Array;
}

function run(graph: Graph, inputs: Float32Array[], file?: Float32Array, free = false): Out {
  const total = Math.floor(inputs[0].length / FRAMES) * FRAMES;
  const out = { l: new Float32Array(total), talkL: new Float32Array(total) };
  const b = () => new Float32Array(FRAMES);
  const [outL, outR, talkL, talkR] = [b(), b(), b(), b()];
  for (let o = 0; o < total; o += FRAMES) {
    if (file) {
      const f = file.subarray(o, o + FRAMES);
      graph.setFileBlock(f, f, 'file.flac');
      graph.setFileMusicFree(free, false);
    }
    graph.process(
      inputs.map((c) => c.subarray(o, o + FRAMES)),
      outL,
      outR,
      FRAMES,
      { talkL, talkR }
    );
    out.l.set(outL, o);
    out.talkL.set(talkL, o);
  }
  return out;
}

const trimOf = (g: Graph, label: string) =>
  g.getMeters().channels.find((c) => c.label === label)!.trimDb;

describe('Graph: Auto-Pegel', () => {
  it('brings a quiet mic up to the target during the talk, no setup run', () => {
    const g = new Graph(config([mic(1, 'A')], { autoTrim: AUTO }));
    // Speech at -42 dBFS: needs +22 dB.
    run(g, [plus(talk(-42, 20), floor(20, 1))]);
    expect(Math.abs(trimOf(g, 'A') - 22)).toBeLessThan(1.5);
    expect(g.getMeters().channels[0].autoTrim).toBe(true);
    expect(g.getProcessing('A')!.trimDb).toBe(trimOf(g, 'A'));
  });

  it('trims each mic by its own talker, however deaf the near mic is', () => {
    // The voice is next to mic A, whose gain is 20 dB too low; mic B (2 ms
    // farther) hears it louder. A gets the boost, B is never the talker.
    const src = talk(-30, 20);
    const shift = Math.round(0.002 * SR);
    const a = src.map((v) => v * 0.1); // -20 dB
    const b = new Float32Array(src.length);
    for (let i = shift; i < b.length; i++) b[i] = src[i - shift] * 0.5;
    const g = new Graph(config([mic(1, 'A'), mic(2, 'B')], { autoTrim: AUTO }));
    run(g, [plus(a, floor(20, 1)), plus(b, floor(20, 2))]);
    expect(Math.abs(trimOf(g, 'A') - 30)).toBeLessThan(1.5); // speech at -50 -> +30
    expect(trimOf(g, 'B')).toBe(0);
  });

  it('a mic switched to manual keeps its trim', () => {
    const g = new Graph(config([mic(1, 'A')], { autoTrim: AUTO }));
    expect(g.setAutoTrim('A', false)).toBe(true);
    expect(g.autoTrimOn('A')).toBe(false);
    run(g, [plus(talk(-42, 15), floor(15, 1))]);
    expect(trimOf(g, 'A')).toBe(0);
    expect(g.getMeters().channels[0].autoTrim).toBe(false);
    expect(g.setAutoTrim('nobody', true)).toBe(false);
  });

  it('learns nothing while music plays in the room', () => {
    const g = new Graph(config([mic(1, 'A')], { autoTrim: AUTO, filePlayer: player() }));
    const n = 15;
    run(g, [plus(talk(-42, n), floor(n, 1))], tone(-20, n, 440));
    expect(trimOf(g, 'A')).toBe(0);
  });

  it('learns nothing while the mics are muted', () => {
    const g = new Graph(config([mic(1, 'A')], { autoTrim: AUTO }));
    g.setMicsMuted(true);
    run(g, [plus(talk(-42, 15), floor(15, 1))]);
    expect(trimOf(g, 'A')).toBe(0);
  });

  it('is absent without the config, and every API says so', () => {
    const g = new Graph(config([mic(1, 'A')]));
    expect(g.autoTrimEnabled).toBe(false);
    expect(g.autoTrimOn('A')).toBeNull();
    expect(g.getMeters().channels[0].autoTrim).toBeNull();
  });

  it('a setup-assistant trim is its new starting point', () => {
    const g = new Graph(config([mic(1, 'A')], { autoTrim: AUTO }));
    g.retune('A', { ...g.getProcessing('A')!, trimDb: 22 }, undefined, 6);
    // The voice is where the measurement put it: nothing to correct.
    run(g, [plus(talk(-42, 15), floor(15, 1))]);
    expect(Math.abs(trimOf(g, 'A') - 22)).toBeLessThan(0.6);
  });
});

describe('Graph: talk stem (music-free export)', () => {
  const mk = () => new Graph(config([mic(1, 'A')], { filePlayer: player() }), { talkStem: true });

  it('is the programme without the music, sample for sample where no music plays', () => {
    const g = mk();
    const n = 4;
    const speech = plus(talk(-20, n, 9, 0.5), floor(n, 1));
    const out = run(g, [speech], silence(n));
    let diff = 0;
    for (let i = 0; i < out.l.length; i++) diff = Math.max(diff, Math.abs(out.l[i] - out.talkL[i]));
    expect(diff).toBeLessThan(1e-6);
    expect(rmsDb(out.talkL)).toBeGreaterThan(-40);
  });

  it('leaves the music out', () => {
    const g = mk();
    const n = 4;
    const out = run(g, [floor(n, 1)], tone(-20, n, 440));
    expect(rmsDb(out.l, SR, out.l.length)).toBeGreaterThan(-26);
    expect(rmsDb(out.talkL, SR, out.talkL.length)).toBeLessThan(-60);
  });

  it("keeps a file from a musicFree folder (the show's own jingle)", () => {
    const g = mk();
    const n = 4;
    const out = run(g, [floor(n, 1)], tone(-20, n, 440), true);
    const prog = rmsDb(out.l, SR, out.l.length);
    expect(Math.abs(rmsDb(out.talkL, SR, out.talkL.length) - prog)).toBeLessThan(0.1);
  });

  it('is not written without the option', () => {
    const g = new Graph(config([mic(1, 'A')], { filePlayer: player() }));
    const out = run(g, [floor(2, 1)], tone(-20, 2, 440));
    expect(out.talkL.every((v) => v === 0)).toBe(true);
  });
});

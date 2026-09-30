import { ChannelStrip } from '../../src/dsp/channel-strip';
import { Graph } from '../../src/dsp/graph';
import { ChannelProcessing } from '../../src/config/schema';
import {
  SR,
  bypass,
  concat,
  config,
  mic,
  rmsDb,
  scale,
  silence,
  tone,
} from '../../test-support/config';

const GATE = Math.round(0.015 * SR);
const LEV = 3 * SR;

/** A realistic strip: every stage on. */
const full = (over: Partial<ChannelProcessing> = {}): ChannelProcessing =>
  bypass({
    hpfHz: 80,
    gate: {
      enabled: true,
      thresholdDb: -50,
      rangeDb: -18,
      attackMs: 3,
      holdMs: 120,
      releaseMs: 150,
    },
    compressor: {
      enabled: true,
      thresholdDb: -20,
      ratio: 3,
      kneeDb: 6,
      attackMs: 10,
      releaseMs: 120,
      makeupDb: 3,
    },
    leveler: { enabled: true, targetLufs: -23, maxGainDb: 24, rangeDb: 24, responseMs: 1500 },
    ...over,
  });

function run(strip: ChannelStrip, x: Float32Array, tail = 0): Float32Array {
  const out = new Float32Array(x.length + tail);
  for (let i = 0; i < out.length; i++) out[i] = strip.process(i < x.length ? x[i] : 0);
  return out;
}

/** Run one block-aligned signal per capture channel through a graph. */
function runGraph(
  graph: Graph,
  inputs: Float32Array[],
  frames = 1024
): { l: Float32Array; r: Float32Array } {
  const total = Math.floor(inputs[0].length / frames) * frames;
  const l = new Float32Array(total);
  const r = new Float32Array(total);
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  for (let o = 0; o < total; o += frames) {
    graph.process(
      inputs.map((c) => c.subarray(o, o + frames)),
      outL,
      outR,
      frames
    );
    l.set(outL, o);
    r.set(outR, o);
  }
  return { l, r };
}

describe('look-ahead mic chain (roadmap M1.3)', () => {
  it('(a) has a quiet voice within 2 dB of its settled level in its first 500 ms', () => {
    const strip = new ChannelStrip(full(), SR, { gate: GATE, leveler: LEV });
    const onset = SR; // 1 s of room silence first
    const out = run(strip, concat(silence(1), tone(-45, 5)), strip.latency);
    const at = onset + strip.latency;
    const first = rmsDb(out, at, at + SR / 2);
    const settled = rmsDb(out, at + 4 * SR, at + 5 * SR);
    expect(Math.abs(first - settled)).toBeLessThan(2);
    // ... and that level is the target (1 kHz at -23 LUFS ~ -22.3 dBFS RMS).
    expect(Math.abs(settled - -22.3)).toBeLessThan(2);
  });

  it('(b) leaves the leveler of a mic alone that only hears bleed 20 dB down', () => {
    const graph = new Graph(
      config([mic(1, 'Talker', full()), mic(2, 'Neighbour', full())], {
        lookahead: { seconds: 3, gateMs: 15, mixMs: 150 },
      })
    );
    const voice = tone(-30, 6);
    runGraph(graph, [voice, scale(voice, -20)]);
    const [talker, neighbour] = graph.getMeters().channels;
    expect(talker.active).toBe(true);
    expect(talker.levelerDb).toBeGreaterThan(2);
    expect(neighbour.active).toBe(false);
    expect(neighbour.levelerDb).toBe(0);
  });

  it('(c) has the gate fully open when the onset comes out', () => {
    const p = bypass({
      gate: {
        enabled: true,
        thresholdDb: -50,
        rangeDb: -18,
        attackMs: 3,
        holdMs: 120,
        releaseMs: 150,
      },
    });
    const look = new ChannelStrip(p, SR, { gate: GATE, leveler: 0 });
    const plain = new ChannelStrip(p, SR);
    const x = concat(silence(0.5), tone(-20, 0.5));
    const onset = SR / 2;
    const a = run(look, x, GATE);
    const b = run(plain, x);
    // First 2 ms after the onset, against the fully open level of -20 dBFS.
    const ms2 = Math.round(0.002 * SR);
    expect(rmsDb(a, onset + GATE, onset + GATE + ms2)).toBeGreaterThan(-20.5);
    // Without look-ahead the same gate is still opening there.
    expect(rmsDb(b, onset, onset + ms2)).toBeLessThan(-26);
  });

  it('(c) does not close the gate early at the end of a word either', () => {
    const p = bypass({
      gate: {
        enabled: true,
        thresholdDb: -50,
        rangeDb: -18,
        attackMs: 3,
        holdMs: 120,
        releaseMs: 150,
      },
    });
    const look = new ChannelStrip(p, SR, { gate: GATE, leveler: 0 });
    const x = concat(tone(-20, 0.5), silence(0.5));
    const a = run(look, x, GATE);
    const end = SR / 2 + GATE;
    const ms5 = Math.round(0.005 * SR);
    expect(rmsDb(a, end - ms5, end)).toBeGreaterThan(-20.5);
  });

  it('(d) equals the chain without look-ahead in steady state, except for the delay', () => {
    const look = new ChannelStrip(full(), SR, { gate: GATE, leveler: LEV });
    const plain = new ChannelStrip(full(), SR);
    const x = tone(-30, 12);
    const a = run(look, x);
    const b = run(plain, x);
    const d = look.latency;
    let worst = 0;
    for (let i = 11 * SR; i < 12 * SR; i++) worst = Math.max(worst, Math.abs(a[i] - b[i - d]));
    // Both sit at ~ -22 dBFS RMS (peak ~0.11); agree to well under 0.1 dB.
    expect(worst).toBeLessThan(0.001);
  });

  it('reports its latency: gate + leveler look-ahead', () => {
    const strip = new ChannelStrip(bypass(), SR, { gate: GATE, leveler: LEV });
    expect(strip.latency).toBe(GATE + LEV);
    const out = run(strip, concat(new Float32Array([1]), silence(4)));
    expect(out[strip.latency]).toBe(1);
  });
});

describe('guest level indicator (roadmap M1.5)', () => {
  const level = (db: number) => {
    const strip = new ChannelStrip(full(), SR, { gate: GATE, leveler: LEV });
    run(strip, tone(db, 8));
    return strip.meters();
  };

  it('moves through the zones with the voice while the output level stays put', () => {
    const near = level(-10);
    const ok = level(-20);
    const far = level(-30);
    expect([far.zone, ok.zone, near.zone]).toEqual(['low', 'ok', 'high']);
    expect(far.speechDb!).toBeCloseTo(-30, 0);
    expect(near.speechDb!).toBeCloseTo(-10, 0);
    // The leveler makes up the 20 dB between them (the compressor sees very
    // different levels, hence the tolerance).
    expect(Math.abs(near.outDb - ok.outDb)).toBeLessThan(1.5);
    expect(Math.abs(far.outDb - ok.outDb)).toBeLessThan(1.5);
  });

  it('measures only while the mic is the talker and lets the value expire', () => {
    const strip = new ChannelStrip(full(), SR, { gate: GATE, leveler: LEV });
    expect(strip.meters().speechDb).toBeNull();
    run(strip, tone(-20, 2));
    expect(strip.meters().zone).toBe('ok');
    run(strip, silence(1)); // holds for a moment after the phrase ...
    expect(strip.meters().zone).toBe('ok');
    run(strip, silence(2)); // ... then expires instead of reading "too quiet"
    expect(strip.meters().speechDb).toBeNull();
    expect(strip.meters().zone).toBeNull();
  });

  it('honours a configured zone', () => {
    const strip = new ChannelStrip(full({ zone: { centerDb: -30, widthDb: 3 } }), SR);
    run(strip, tone(-20, 2));
    expect(strip.meters().zone).toBe('high');
  });

  it('follows the input trim (the zone is measured after it)', () => {
    const strip = new ChannelStrip(full({ trimDb: 10 }), SR);
    run(strip, tone(-30, 2));
    expect(strip.meters().speechDb!).toBeCloseTo(-20, 0);
  });
});

import { Graph } from '../../src/dsp/graph';
import { ChannelConfig, StudioboxConfig } from '../../src/config/schema';
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
import { noise, voice } from '../../test-support/voice';

const FRAMES = 1024;

interface Run {
  l: Float32Array;
  r: Float32Array;
  retL: Float32Array;
  retR: Float32Array;
  taps: Float32Array[];
}

/** Drive a graph block by block. `inputs` are capture channels (0-based);
 *  `file` optionally feeds the file player source. */
function run(graph: Graph, inputs: Float32Array[], file?: Float32Array): Run {
  const total = Math.floor(inputs[0].length / FRAMES) * FRAMES;
  const mk = () => new Float32Array(total);
  const out: Run = {
    l: mk(),
    r: mk(),
    retL: mk(),
    retR: mk(),
    taps: (graph.tapLayout ?? []).map(mk),
  };
  const b = () => new Float32Array(FRAMES);
  const [outL, outR, retL, retR] = [b(), b(), b(), b()];
  const taps = out.taps.map(b);
  for (let o = 0; o < total; o += FRAMES) {
    if (file) {
      const f = file.subarray(o, o + FRAMES);
      graph.setFileBlock(f, f, 'file.flac');
    }
    graph.process(
      inputs.map((c) => c.subarray(o, o + FRAMES)),
      outL,
      outR,
      FRAMES,
      { retL, retR, taps }
    );
    out.l.set(outL, o);
    out.r.set(outR, o);
    out.retL.set(retL, o);
    out.retR.set(retR, o);
    taps.forEach((t, i) => out.taps[i].set(t, o));
  }
  return out;
}

const player = (over: Partial<NonNullable<StudioboxConfig['filePlayer']>> = {}) => ({
  enabled: true,
  dirs: [],
  label: 'Zuspieler',
  ducked: true,
  fadeOutMs: 0,
  prebufferMs: 0,
  autoPlay: { enabled: false, scanSeconds: 10, graceSeconds: 30 },
  bed: { enabled: false, dir: '', gainDb: -6, fadeInMs: 1500, fadeOutMs: 2500 },
  processing: bypass(),
  ...over,
});

const music = (l: number, r: number, label: string): ChannelConfig => ({
  source: [l, r],
  role: 'music',
  label,
  processing: bypass(),
});

const LOOK = { seconds: 0.5, gateMs: 10, mixMs: 100 };
const allFinite = (x: Float32Array) => x.every((v) => Number.isFinite(v));

describe('Graph wiring', () => {
  it('mixes every configured mic and music channel into the programme', () => {
    // One channel at a time carries signal; each must reach the output.
    const channels = [mic(1, 'A'), mic(2, 'B'), mic(3, 'C'), music(5, 6, 'Deck')];
    for (const live of [0, 1, 2, 4, 5]) {
      const graph = new Graph(config(channels));
      const inputs = Array.from({ length: 6 }, (_, c) => (c === live ? tone(-20, 1) : silence(1)));
      const out = run(graph, inputs);
      expect(rmsDb(live === 5 ? out.r : out.l, SR / 2)).toBeGreaterThan(-40);
    }
    // ... and an unmapped capture channel must not.
    const graph = new Graph(config(channels));
    const inputs = Array.from({ length: 6 }, (_, c) => (c === 3 ? tone(-20, 1) : silence(1)));
    expect(rmsDb(run(graph, inputs).l, SR / 2)).toBeLessThan(-150);
  });

  it('stays finite and reports the latency it really has', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK }));
    const click = concat(new Float32Array([0.5]), silence(2));
    const out = run(graph, [click]);
    expect(allFinite(out.l)).toBe(true);
    let peak = 0;
    for (let i = 1; i < out.l.length; i++) if (Math.abs(out.l[i]) > Math.abs(out.l[peak])) peak = i;
    expect(peak).toBe(graph.latencySamples);
    expect(graph.getMeters().lookaheadMs).toBeCloseTo((graph.latencySamples / SR) * 1000, 6);
  });

  it('keeps the music lined up with the mics through the look-ahead', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player() }));
    const click = concat(new Float32Array([0.5]), silence(2));
    const viaMic = run(graph, [click]);
    const graph2 = new Graph(config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player() }));
    const viaFile = run(graph2, [silence(2)], click);
    const peakOf = (x: Float32Array) =>
      x.reduce((p, v, i) => (Math.abs(v) > Math.abs(x[p]) ? i : p), 0);
    expect(peakOf(viaFile.l)).toBe(peakOf(viaMic.l));
    expect(graph.musicLatencySamples).toBe(graph.latencySamples);
  });

  it('delays the programme music further by the return latency it is told', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player() }), {
      musicDelayMs: 250,
    });
    expect(graph.musicLatencySamples - graph.latencySamples).toBe(0.25 * SR);
  });
});

describe('Graph mutes act in room time', () => {
  it('"Mikros zu" lets what was already said play out and drops what comes after', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK }));
    const lat = graph.latencySamples;
    const x = tone(-20, 3);
    const a = run(graph, [x.subarray(0, SR)]); // 1 s said with open mics
    graph.setMicsMuted(true);
    const b = run(graph, [x.subarray(SR)]); // 2 s said after the mute
    const out = concat(a.l, b.l);
    const said = Math.floor(SR / FRAMES) * FRAMES; // the mute took effect here
    // The tail of the open second still airs after the button was pressed ...
    expect(rmsDb(out, said, said + lat - 2048)).toBeGreaterThan(-40);
    // ... and nothing spoken after it does.
    expect(rmsDb(out, said + lat + 2048)).toBeLessThan(-100);
    expect(graph.getMeters().micsMuted).toBe(true);
  });

  it('mutes a single channel by label and leaves the others alone', () => {
    const graph = new Graph(config([mic(1, 'A'), mic(2, 'B')]));
    graph.setChannelMuted('A', true);
    const out = run(graph, [tone(-20, 1), silence(1)]);
    expect(rmsDb(out.l, SR / 2)).toBeLessThan(-100);
    const out2 = run(graph, [silence(1), tone(-20, 1)]);
    expect(rmsDb(out2.l, SR / 2)).toBeGreaterThan(-40);
    expect(graph.getMeters().channels.map((c) => c.muted)).toEqual([true, false]);
  });
});

describe('Graph music return (roadmap M1.7)', () => {
  const duck = {
    enabled: true,
    targets: [],
    thresholdDb: -40,
    musicPresentDb: -45,
    depthDb: -15,
    attackMs: 20,
    holdMs: 100,
    releaseMs: 100,
  };

  it('carries the music in room time and never the mics', () => {
    const graph = new Graph(
      config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player({ ducked: false }) })
    );
    const onlyMic = run(graph, [tone(-20, 1)]);
    expect(rmsDb(onlyMic.retL)).toBeLessThan(-150);
    const file = concat(new Float32Array([0.5]), silence(1));
    const onlyFile = run(graph, [silence(1)], file);
    expect(onlyFile.retL[0]).toBeCloseTo(0.5, 6); // no look-ahead on the return
  });

  it('is ducked under speech like the programme', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player(), duck }));
    const out = run(graph, [concat(silence(1), tone(-20, 1))], tone(-20, 2, 440));
    const before = rmsDb(out.retL, SR / 2, SR - 2048);
    const under = rmsDb(out.retL, SR + SR / 2, 2 * SR - 2048);
    expect(before).toBeCloseTo(-20, 0);
    expect(before - under).toBeGreaterThan(13);
  });

  it('takes output.return.gainDb on the return only, not the programme', () => {
    const base = config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player({ ducked: false }) });
    const graph = new Graph({
      ...base,
      output: { ...base.output, return: { ...base.output.return, gainDb: -12 } },
    });
    graph.setMicsMuted(true);
    const out = run(graph, [silence(1)], tone(-20, 1, 440));
    expect(rmsDb(out.retL, SR / 2)).toBeCloseTo(-32, 0);
    expect(rmsDb(out.l, SR / 2)).toBeGreaterThan(-25);
  });

  it('changes the return level live and clamps it', () => {
    const graph = new Graph(
      config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player({ ducked: false }) })
    );
    graph.setMicsMuted(true);
    graph.setReturnGain(-6);
    expect(graph.returnLevelDb).toBe(-6);
    const out = run(graph, [silence(1)], tone(-20, 1, 440));
    expect(rmsDb(out.retL, SR / 2)).toBeCloseTo(-26, 0);
    graph.setReturnGain(-100);
    expect(graph.returnLevelDb).toBe(-60);
    graph.setReturnGain(NaN);
    expect(graph.returnLevelDb).toBe(-60);
  });

  it('comes back up as soon as the mics are closed', () => {
    const graph = new Graph(config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player(), duck }));
    graph.setMicsMuted(true);
    const out = run(graph, [tone(-20, 1)], tone(-20, 1, 440));
    expect(rmsDb(out.retL, SR / 2)).toBeCloseTo(-20, 0);
  });
});

describe('Graph ducking with look-ahead', () => {
  const duck = {
    enabled: true,
    targets: [],
    thresholdDb: -40,
    musicPresentDb: -45,
    depthDb: -15,
    attackMs: 20,
    holdMs: 100,
    releaseMs: 100,
  };

  it('has the music down before the first word airs', () => {
    const cfg = config([mic(1, 'A')], { lookahead: LOOK, filePlayer: player(), duck });
    const graph = new Graph(cfg);
    // Music alone, then speech from t = 1 s. Look at the music-only output:
    // subtract a run that is identical except the music is silent.
    const speech = concat(silence(1), tone(-20, 1.5));
    const musicSig = tone(-20, 2.5, 440);
    const both = run(graph, [speech], musicSig);
    const dry = run(new Graph(cfg), [speech], silence(2.5));
    const musicOnly = both.l.map((v, i) => v - dry.l[i]);
    const onset = SR + graph.latencySamples;
    const ms10 = Math.round(0.01 * SR);
    // The master leveler scales both runs alike only roughly, so compare the
    // music level just before the onset with its level well before.
    const early = rmsDb(musicOnly, onset - SR / 2, onset - SR / 2 + ms10 * 10);
    const atOnset = rmsDb(musicOnly, onset - ms10, onset);
    expect(early - atOnset).toBeGreaterThan(10);
  });

  it('lets a bump or a click during a jingle pass, but ducks real talk', () => {
    // The processed taps show the music as it enters the mix (after the
    // duck, before the master leveler).
    const cfg = config([mic(1, 'A')], {
      lookahead: { seconds: 1, gateMs: 10, mixMs: 100 },
      filePlayer: player(),
      duck: { ...duck, holdMs: 400, releaseMs: 600 },
      output: { ...config([]).output, multitrack: { enabled: true, source: 'processed' } },
    });
    // A 100 ms bump on the mic at 1 s, then 1.5 s of talk at 3 s.
    const room = concat(
      silence(1),
      noise(-30, 0.1),
      silence(1.9),
      voice({ rmsDb: -30, seconds: 1.5 }),
      silence(1.5)
    );
    const graph = new Graph(cfg);
    const music = run(graph, [room], tone(-20, 6, 440)).taps[1];
    const lat = graph.latencySamples;
    const ref = rmsDb(music, lat + SR / 2, lat + 0.9 * SR);
    // Around the bump: the music stays where it was.
    expect(ref - rmsDb(music, lat + SR, lat + 1.6 * SR)).toBeLessThan(0.5);
    // In the talk: ducked, already at the first word.
    expect(ref - rmsDb(music, lat + 3 * SR, lat + 3.05 * SR)).toBeGreaterThan(10);
    expect(ref - rmsDb(music, lat + 3.2 * SR, lat + 4.2 * SR)).toBeGreaterThan(14);
  });
});

describe('Graph host priority (roadmap M1.8)', () => {
  const priority = {
    enabled: true,
    label: 'Host',
    attenuate: ['Gast'],
    depthDb: -8,
    thresholdDb: -35,
    attackMs: 20,
    holdMs: 50,
    releaseMs: 100,
  };
  // Processed multitrack taps show each mic as it enters the mix, before the
  // master leveler moves the sum.
  const cfg = () =>
    config([mic(1, 'Gast'), mic(2, 'Host')], {
      automix: { enabled: false, members: [], responseMs: 120, floorDb: -60, priority },
      output: { ...config([]).output, multitrack: { enabled: true, source: 'processed' } },
    });

  it('turns the guest down by the depth while the host talks, never to silence', () => {
    const graph = new Graph(cfg());
    const guestAlone = run(graph, [tone(-20, 1, 300), silence(1)]);
    expect(rmsDb(guestAlone.taps[0], SR / 2)).toBeCloseTo(-20, 0);
    expect(graph.getMeters().priority).toMatchObject({ label: 'Host', depthDb: -8, active: false });

    const both = run(new Graph(cfg()), [tone(-20, 1, 300), tone(-20, 1, 1000)]);
    expect(rmsDb(both.taps[0], SR / 2)).toBeCloseTo(-28, 0); // guest: 8 dB down
    expect(rmsDb(both.taps[1], SR / 2)).toBeCloseTo(-20, 0); // host: untouched
  });

  it('reports the attenuation per mic and lets the depth be changed live', () => {
    const graph = new Graph(cfg());
    graph.setPriorityDepth(-4);
    run(graph, [tone(-20, 1, 300), tone(-20, 1, 1000)]);
    const snap = graph.getMeters();
    expect(snap.priority).toMatchObject({ depthDb: -4, active: true });
    expect(snap.channels[0].priorityDb).toBeCloseTo(-4, 0);
    expect(snap.channels[1].priorityDb).toBe(0);
  });
});

describe('Graph multitrack taps (roadmap M1.6)', () => {
  const mt = (source: 'dry' | 'processed') =>
    config([mic(1, 'A', bypass({ gainDb: 6 })), mic(2, 'B')], {
      lookahead: LOOK,
      filePlayer: player({ ducked: false }),
      output: { ...config([]).output, multitrack: { enabled: true, source } },
    });

  it('has no taps unless multitrack is configured', () => {
    expect(new Graph(config([mic(1, 'A')])).tapLayout).toBeNull();
  });

  it('lays the channels out as mics, music pairs, programme', () => {
    expect(new Graph(mt('dry')).tapLayout).toEqual([
      'A',
      'B',
      'Zuspieler L',
      'Zuspieler R',
      'Programm L',
      'Programm R',
    ]);
  });

  it('dry: raw sources, sample-aligned with the programme', () => {
    const graph = new Graph(mt('dry'));
    const click = concat(silence(0.1), new Float32Array([0.25]), silence(1.5));
    const out = run(graph, [click, silence(1.7)], scale(click, -6));
    const at = Math.round(0.1 * SR) + graph.latencySamples;
    expect(out.taps[0][at]).toBeCloseTo(0.25, 6); // dry: before the +6 dB strip gain
    expect(out.taps[2][at]).toBeCloseTo(0.25 * Math.pow(10, -6 / 20), 6);
    // Programme channels are the stereo output itself.
    expect(Array.from(out.taps[4])).toEqual(Array.from(out.l));
    expect(Array.from(out.taps[5])).toEqual(Array.from(out.r));
    // ... and its click sits on the same sample as the dry ones.
    const peak = out.l.reduce((p, v, i) => (Math.abs(v) > Math.abs(out.l[p]) ? i : p), 0);
    expect(peak).toBe(at);
  });

  it('processed: each source as it enters the mix', () => {
    const graph = new Graph(mt('processed'));
    const click = concat(silence(0.1), new Float32Array([0.25]), silence(1.5));
    const out = run(graph, [click, silence(1.7)]);
    const at = Math.round(0.1 * SR) + graph.latencySamples;
    expect(out.taps[0][at]).toBeCloseTo(0.25 * Math.pow(10, 6 / 20), 5); // with strip gain
    expect(rmsDb(out.taps[1])).toBeLessThan(-150);
  });
});

describe('Graph live retune', () => {
  it('applies new processing to a running strip', () => {
    const graph = new Graph(
      config([mic(1, 'A')], {
        output: { ...config([]).output, multitrack: { enabled: true, source: 'processed' } },
      })
    );
    expect(rmsDb(run(graph, [tone(-30, 1)]).taps[0], SR / 2)).toBeCloseTo(-30, 0);
    expect(graph.retune('A', bypass({ trimDb: 10 }))).toBe(true);
    expect(rmsDb(run(graph, [tone(-30, 1)]).taps[0], SR / 2)).toBeCloseTo(-20, 0);
    expect(graph.getMeters().channels[0].trimDb).toBe(10);
    expect(graph.getProcessing('A')!.trimDb).toBe(10);
    expect(graph.retune('nope', bypass())).toBe(false);
  });
});

import { AirStatus, ChannelMeter, MeterSnapshot } from '../../src/dsp/graph';
import { Snapshot, guestSnapshot, onAirOf, spectatorSnapshot } from '../../src/meters/wire';

const air = (state: AirStatus['state']): AirStatus => ({
  targetMs: 10000,
  delayMs: 10020,
  nowMs: 1_000_010_020,
  state,
  drainEndsMs: null,
  underruns: 0,
  resyncs: 0,
});

const channel = (label: string, role: string, over: Partial<ChannelMeter> = {}): ChannelMeter =>
  ({
    label,
    role,
    outDb: -18,
    gateOpen: 1,
    compGrDb: 3,
    levelerDb: 2,
    automixGainDb: -4,
    muted: false,
    active: true,
    speechDb: -22,
    zone: 'ok',
    priorityDb: 0,
    trimDb: 12,
    ...over,
  }) as ChannelMeter;

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  channels: [channel('Gast 1', 'mic'), channel('Host', 'mic'), channel('Player', 'music')],
  duckDepthDb: -9,
  limiterGrDb: 1,
  momentaryLufs: -15,
  shortTermLufs: -16,
  outPeakDb: -4,
  micsMuted: false,
  filePlaying: 'jingle.mp3',
  filePlayingAt: { folder: 0, name: 'Jingles/jingle.mp3' },
  filePosition: 3,
  fileDuration: 12,
  recording: true,
  streaming: false,
  monitor: true,
  nextScheduled: null,
  serverNowMs: 1_000_000_000,
  lookaheadMs: 3000,
  priority: { label: 'Host', depthDb: -8, active: true },
  air: air('live'),
  ...over,
});

describe('onAirOf — "programme is leaving the box"', () => {
  it('is unknown without an air delay (playout mode)', () => {
    expect(onAirOf(snapshot({ air: undefined }))).toBeNull();
  });

  it('needs the show to be live and an output to be running', () => {
    expect(onAirOf(snapshot())).toBe(true);
    expect(onAirOf(snapshot({ monitor: false, streaming: true }))).toBe(true);
    expect(onAirOf(snapshot({ monitor: false, streaming: false }))).toBe(false);
    expect(onAirOf(snapshot({ monitor: null, streaming: null }))).toBe(false);
  });

  it("counts the box's own stream only while somebody pulls it", () => {
    const off = { monitor: false, streaming: false };
    expect(onAirOf(snapshot({ ...off, serve: { on: true, clients: 1 } }))).toBe(true);
    expect(onAirOf(snapshot({ ...off, serve: { on: true, clients: 0 } }))).toBe(false);
    expect(onAirOf(snapshot({ ...off, serve: { on: false, clients: 0 } }))).toBe(false);
  });

  it('is off while the buffer fills and once the show has ended', () => {
    expect(onAirOf(snapshot({ air: air('filling') }))).toBe(false);
    expect(onAirOf(snapshot({ air: air('ended') }))).toBe(false);
  });

  it('stays on while "Sendung beenden" plays the buffer out', () => {
    expect(onAirOf(snapshot({ air: air('draining') }))).toBe(true);
  });

  it('does not count a local output that carries the test tone', () => {
    expect(onAirOf(snapshot({ testTone: true }))).toBe(false);
    // The harbor still gets the programme.
    expect(onAirOf(snapshot({ testTone: true, streaming: true }))).toBe(true);
  });
});

describe('the cut a guest tablet gets', () => {
  const cut = guestSnapshot(
    snapshot({
      setup: {
        phase: 'result',
        current: null,
        sentence: 'Satz.',
        silence: 1,
        mics: [],
        results: [{ label: 'Host' } as never],
        automixFloorDb: -18,
      },
    }),
    true
  ) as Record<string, any>;

  it('holds the mics only, with state and speech level but no processing meters', () => {
    expect(cut.channels.map((c: ChannelMeter) => c.label)).toEqual(['Gast 1', 'Host']);
    expect(Object.keys(cut.channels[0]).sort()).toEqual(
      ['active', 'label', 'muted', 'priorityDb', 'role', 'speechDb', 'zone'].sort()
    );
  });

  it('passes the zone band along once the box reports it', () => {
    const s = snapshot();
    Object.assign(s.channels[0], { zoneCenterDb: -20, zoneWidthDb: 6 });
    const c = (guestSnapshot(s, true) as Record<string, any>).channels[0];
    expect(c.zoneCenterDb).toBe(-20);
    expect(c.zoneWidthDb).toBe(6);
  });

  it('carries what plays, the clocks and on air — nothing about outputs or the file tree', () => {
    expect(cut.filePlaying).toBe('jingle.mp3');
    expect(cut.fileDuration).toBe(12);
    expect(cut.air.nowMs).toBe(1_000_010_020);
    expect(cut.onAir).toBe(true);
    expect(cut.priority).toEqual({ label: 'Host', active: true });
    for (const k of [
      'recording',
      'streaming',
      'monitor',
      'filePlayingAt',
      'limiterGrDb',
      'nextScheduled',
    ]) {
      expect(cut).not.toHaveProperty(k);
    }
  });

  it('says where the setup assistant stands, without its results', () => {
    expect(cut.setup.phase).toBe('result');
    expect(cut.setup.sentence).toBe('Satz.');
    expect(cut.setup).not.toHaveProperty('results');
    expect(cut.setup).not.toHaveProperty('automixFloorDb');
  });
});

describe('the cut a spectator gets', () => {
  it('is on air, the title, the programme level and the clock', () => {
    const cut = spectatorSnapshot(snapshot(), true) as Record<string, unknown>;
    expect(Object.keys(cut).sort()).toEqual(
      [
        'air',
        'fileDuration',
        'filePlaying',
        'filePosition',
        'lookaheadMs',
        'onAir',
        'outPeakDb',
        'serverNowMs',
        'shortTermLufs',
      ].sort()
    );
  });

  it('works for a playout box too (no air, no channels)', () => {
    const s: MeterSnapshot = {
      ...snapshot(),
      channels: [],
      air: undefined,
      lookaheadMs: undefined,
    };
    const cut = spectatorSnapshot(s, onAirOf(s)) as Record<string, unknown>;
    expect(cut.onAir).toBeNull();
    expect(cut).not.toHaveProperty('air');
    expect(cut.filePlaying).toBe('jingle.mp3');
  });
});

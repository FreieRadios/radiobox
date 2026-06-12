import { ChannelStrip } from '../../src/dsp/channel-strip';
import { ChannelProcessing } from '../../src/config/schema';
import { dbToGain } from '../../src/dsp/dsp-math';

const SR = 48000;

/** A fully-bypassed processing chain; override one field at a time to isolate a stage. */
const processing = (over: Partial<ChannelProcessing> = {}): ChannelProcessing => ({
  hpfHz: 0,
  gate: { enabled: false, thresholdDb: -40, rangeDb: -40, attackMs: 5, holdMs: 20, releaseMs: 20 },
  eq: [],
  deesser: { enabled: false, freq: 6000, thresholdDb: -30, ratio: 4 },
  compressor: {
    enabled: false,
    thresholdDb: -20,
    ratio: 4,
    kneeDb: 0,
    attackMs: 1,
    releaseMs: 10,
    makeupDb: 0,
  },
  leveler: { enabled: false, targetLufs: -16, maxGainDb: 12, rangeDb: 12, responseMs: 50 },
  gainDb: 0,
  ...over,
});

describe('ChannelStrip', () => {
  it('is a unity passthrough when every stage is bypassed', () => {
    const strip = new ChannelStrip(processing(), SR);
    for (const x of [0.2, -0.5, 0.9, -0.1]) {
      expect(strip.process(x)).toBeCloseTo(x, 9);
    }
  });

  it('applies the output trim gain', () => {
    const strip = new ChannelStrip(processing({ gainDb: 6 }), SR);
    expect(strip.process(0.3)).toBeCloseTo(0.3 * dbToGain(6), 9);
  });

  it('removes DC when the high-pass filter is enabled', () => {
    const strip = new ChannelStrip(processing({ hpfHz: 80 }), SR);
    let y = 0;
    for (let i = 0; i < 8000; i++) y = strip.process(1);
    expect(Math.abs(y)).toBeLessThan(0.01);
  });

  it('exposes finite meter values', () => {
    const strip = new ChannelStrip(processing(), SR);
    for (let i = 0; i < 1000; i++) strip.process(0.3 * Math.sin(i / 10));
    const m = strip.meters();
    expect(Number.isFinite(m.outDb)).toBe(true);
    expect(Number.isFinite(m.gateOpen)).toBe(true);
    expect(Number.isFinite(m.compGrDb)).toBe(true);
    expect(Number.isFinite(m.levelerDb)).toBe(true);
  });
});

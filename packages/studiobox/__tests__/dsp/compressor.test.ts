import { Compressor } from '../../src/dsp/compressor';
import { CompressorParams } from '../../src/config/schema';
import { dbToGain, gainToDb } from '../../src/dsp/dsp-math';

const SR = 48000;

const params = (over: Partial<CompressorParams> = {}): CompressorParams => ({
  enabled: true,
  thresholdDb: -20,
  ratio: 4,
  kneeDb: 0,
  attackMs: 1,
  releaseMs: 10,
  makeupDb: 0,
  ...over,
});

function run(comp: Compressor, x: number, key?: number, n = 4000): number {
  let y = 0;
  for (let i = 0; i < n; i++) y = comp.process(x, key);
  return y;
}

describe('Compressor', () => {
  it('passes the input through unchanged when disabled', () => {
    const comp = new Compressor(params({ enabled: false }), SR);
    expect(comp.process(0.42)).toBe(0.42);
  });

  it('does not reduce gain below threshold', () => {
    const comp = new Compressor(params(), SR);
    const y = run(comp, 0.01); // -40 dBFS, below -20 dB threshold
    expect(comp.gainReductionDb).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(0.01, 4);
  });

  it('applies makeup gain to a sub-threshold signal', () => {
    const comp = new Compressor(params({ makeupDb: 6 }), SR);
    const y = run(comp, 0.01);
    expect(y).toBeCloseTo(0.01 * dbToGain(6), 4);
  });

  it('matches the static gain-reduction curve above threshold (hard knee)', () => {
    const comp = new Compressor(params(), SR);
    run(comp, 0.5); // -6.02 dBFS, 13.98 dB over a -20 dB threshold
    const over = gainToDb(0.5) - -20;
    const expectedGr = (1 - 1 / 4) * over; // slope * over ~= 10.49 dB
    expect(comp.gainReductionDb).toBeCloseTo(expectedGr, 1);
  });

  it('keys off the sidechain signal, not the input', () => {
    const comp = new Compressor(params(), SR);
    const y = run(comp, 0.01, 0.5); // tiny input, loud key -> heavy reduction
    expect(comp.gainReductionDb).toBeGreaterThan(8);
    expect(Math.abs(y)).toBeLessThan(0.01); // input attenuated by the key
  });
});

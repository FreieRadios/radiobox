import { Deesser } from '../../src/dsp/deesser';
import { DeesserParams } from '../../src/config/schema';

const SR = 48000;
const CUTOFF = 6000;

const params = (over: Partial<DeesserParams> = {}): DeesserParams => ({
  enabled: true,
  freq: CUTOFF,
  thresholdDb: -30,
  ratio: 4,
  ...over,
});

/** RMS of a tone passed through `fn`, measured over the settled tail. */
function toneRms(fn: (x: number) => number, freq: number, amp: number, n = 8000): number {
  let sumSq = 0;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const y = fn(amp * Math.sin((2 * Math.PI * freq * i) / SR));
    if (i >= n / 2) {
      sumSq += y * y;
      counted++;
    }
  }
  return Math.sqrt(sumSq / counted);
}

describe('Deesser', () => {
  it('passes the input through unchanged when disabled', () => {
    const de = new Deesser(params({ enabled: false }), SR);
    expect(de.process(0.33)).toBe(0.33);
  });

  it('leaves low-frequency content (well below the split) essentially intact', () => {
    const de = new Deesser(params(), SR);
    const inRms = 0.3 / Math.SQRT2;
    const outRms = toneRms((x) => de.process(x), 200, 0.3);
    expect(outRms).toBeCloseTo(inRms, 2);
  });

  it('attenuates a loud high-frequency tone (the sibilance band)', () => {
    const de = new Deesser(params(), SR);
    const inRms = 0.8 / Math.SQRT2;
    const outRms = toneRms((x) => de.process(x), 9000, 0.8);
    expect(outRms).toBeLessThan(inRms * 0.9);
  });
});

import { DelayLine } from '../../src/dsp/delay-line';

describe('DelayLine', () => {
  it('delays the signal by exactly `length` samples (zeros first)', () => {
    const dl = new DelayLine(3);
    const out = [10, 20, 30, 40, 50].map((x) => dl.process(x));
    expect(out).toEqual([0, 0, 0, 10, 20]);
  });

  it('clamps a length of 0 up to a 1-sample delay', () => {
    const dl = new DelayLine(0);
    expect(dl.length).toBe(1);
    const out = [5, 6, 7].map((x) => dl.process(x));
    expect(out).toEqual([0, 5, 6]);
  });

  it('reset() clears the buffer', () => {
    const dl = new DelayLine(2);
    dl.process(1);
    dl.process(2);
    dl.reset();
    expect(dl.process(9)).toBe(0);
    expect(dl.process(9)).toBe(0);
  });
});

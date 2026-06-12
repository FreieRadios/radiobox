import { Biquad } from '../../src/dsp/biquad';

const SR = 48000;

/** Feed a constant for `n` samples and return the final (settled) output. */
function settleDC(bq: Biquad, value: number, n = 4000): number {
  let y = 0;
  for (let i = 0; i < n; i++) y = bq.process(value);
  return y;
}

describe('Biquad.setCoeffs', () => {
  it('is an exact passthrough for {b0=1, rest=0, a0=1}', () => {
    const bq = new Biquad();
    bq.setCoeffs(1, 0, 0, 1, 0, 0);
    for (const x of [0.3, -0.7, 1, -1, 0.123]) {
      expect(bq.process(x)).toBeCloseTo(x, 12);
    }
  });

  it('normalizes by a0', () => {
    const bq = new Biquad();
    bq.setCoeffs(2, 0, 0, 2, 0, 0); // == unity after /a0
    expect(bq.process(0.5)).toBeCloseTo(0.5, 12);
  });
});

describe('Biquad.design — DC response', () => {
  it('lowpass passes DC (constant settles near input)', () => {
    const lp = Biquad.design('lowpass', SR, 1000, 0.707, 0);
    expect(settleDC(lp, 1)).toBeCloseTo(1, 2);
  });

  it('highpass rejects DC (constant settles near zero)', () => {
    const hp = Biquad.design('highpass', SR, 1000, 0.707, 0);
    expect(Math.abs(settleDC(hp, 1))).toBeLessThan(0.01);
  });

  it('peaking filter with 0 dB gain is exact unity', () => {
    const pk = Biquad.design('peaking', SR, 1000, 1, 0);
    for (const x of [0.2, -0.5, 0.9, -0.1, 0.4]) {
      expect(pk.process(x)).toBeCloseTo(x, 9);
    }
  });

  it('lowshelf/highshelf with 0 dB gain leave DC unchanged', () => {
    expect(settleDC(Biquad.design('lowshelf', SR, 200, 0.707, 0), 1)).toBeCloseTo(1, 2);
    expect(settleDC(Biquad.design('highshelf', SR, 8000, 0.707, 0), 1)).toBeCloseTo(1, 2);
  });
});

describe('Biquad stability', () => {
  it('produces a finite, decaying impulse response', () => {
    const lp = Biquad.design('lowpass', SR, 2000, 0.707, 0);
    let first = lp.process(1);
    let last = first;
    let max = Math.abs(first);
    for (let i = 0; i < 8000; i++) {
      last = lp.process(0);
      max = Math.max(max, Math.abs(last));
      expect(Number.isFinite(last)).toBe(true);
    }
    expect(max).toBeLessThan(2); // bounded, no blow-up
    expect(Math.abs(last)).toBeLessThan(Math.abs(first)); // decayed toward 0
  });

  it('reset() clears state so the response repeats identically', () => {
    const hp = Biquad.design('highpass', SR, 500, 0.707, 0);
    const run = () => {
      const out: number[] = [];
      for (let i = 0; i < 5; i++) out.push(hp.process(i === 0 ? 1 : 0));
      return out;
    };
    const a = run();
    hp.reset();
    const b = run();
    expect(b).toEqual(a);
  });
});

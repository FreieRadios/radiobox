import { DB_EPS, dbToGain, gainToDb, msToCoef, clamp, dn } from '../../src/dsp/dsp-math';

describe('dbToGain / gainToDb', () => {
  it('maps 0 dB to unity gain', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 12);
    expect(gainToDb(1)).toBeCloseTo(0, 12);
  });

  it('maps +20 dB to 10x and -20 dB to 0.1x', () => {
    expect(dbToGain(20)).toBeCloseTo(10, 9);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 9);
  });

  it('halving voltage is about -6.02 dB', () => {
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it('round-trips dB -> gain -> dB', () => {
    for (const db of [-48, -12, -3, 0, 6, 18]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9);
    }
  });

  it('clamps log10(0) to the DB_EPS floor instead of -Infinity', () => {
    const floor = gainToDb(0);
    expect(Number.isFinite(floor)).toBe(true);
    expect(floor).toBeCloseTo(20 * Math.log10(DB_EPS), 9);
  });
});

describe('msToCoef', () => {
  it('returns 0 for a non-positive time constant (instant)', () => {
    expect(msToCoef(0, 48000)).toBe(0);
    expect(msToCoef(-5, 48000)).toBe(0);
  });

  it('returns a coefficient in (0,1) for positive times', () => {
    const c = msToCoef(10, 48000);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  it('grows toward 1 as the time constant lengthens', () => {
    expect(msToCoef(100, 48000)).toBeGreaterThan(msToCoef(1, 48000));
  });

  it('matches the closed-form one-pole formula', () => {
    expect(msToCoef(10, 48000)).toBeCloseTo(Math.exp(-1 / (0.01 * 48000)), 12);
  });
});

describe('clamp', () => {
  it('bounds values to [lo, hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-2, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe('dn (denormal guard)', () => {
  it('flushes sub-1e-15 magnitudes to zero', () => {
    expect(dn(1e-16)).toBe(0);
    expect(dn(-1e-20)).toBe(0);
  });

  it('passes ordinary values through unchanged', () => {
    expect(dn(0.5)).toBe(0.5);
    expect(dn(-3)).toBe(-3);
  });
});

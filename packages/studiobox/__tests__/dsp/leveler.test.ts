import { Leveler } from '../../src/dsp/leveler';
import { LevelerParams } from '../../src/config/schema';

const SR = 48000;

const params = (over: Partial<LevelerParams> = {}): LevelerParams => ({
  enabled: true,
  targetLufs: -16,
  maxGainDb: 12,
  rangeDb: 12,
  responseMs: 50,
  ...over,
});

/** Feed enough of a tone to fill the 3 s loudness window and let the AGC settle. */
function feedTone(lev: Leveler, amp: number, seconds = 5): void {
  const n = Math.round(seconds * SR);
  for (let i = 0; i < n; i++) lev.process(amp * Math.sin((2 * Math.PI * 1000 * i) / SR));
}

describe('Leveler (AGC)', () => {
  it('passes the input through unchanged when disabled', () => {
    const lev = new Leveler(params({ enabled: false }), SR);
    expect(lev.process(0.3)).toBe(0.3);
  });

  it('holds its gain during silence (does not boost the noise floor)', () => {
    const lev = new Leveler(params(), SR);
    for (let i = 0; i < SR; i++) lev.process(0);
    expect(lev.gainDbValue).toBe(0);
  });

  it('attenuates a signal that is louder than the target', () => {
    const lev = new Leveler(params(), SR);
    feedTone(lev, 0.5); // ~-10 LUFS, above the -16 LUFS target
    expect(lev.gainDbValue).toBeLessThan(0);
    expect(lev.gainDbValue).toBeGreaterThanOrEqual(-12.001); // bounded by rangeDb
  });

  it('boosts a quiet (but above-gate) signal toward the target', () => {
    const lev = new Leveler(params(), SR);
    feedTone(lev, 0.02); // quiet, well above the -60 LUFS gate
    expect(lev.gainDbValue).toBeGreaterThan(0);
    expect(lev.gainDbValue).toBeLessThanOrEqual(12.001); // bounded by maxGainDb
  });
});

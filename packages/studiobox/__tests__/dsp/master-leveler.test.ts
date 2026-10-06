import { MasterLeveler } from '../../src/dsp/master-leveler';

const SR = 48000;

/** Run `seconds` of 10 ms frames at a momentary loudness; returns the gain. */
function feed(m: MasterLeveler, seconds: number, talk: boolean, lufs: number): number {
  for (let f = 0; f < seconds * 100; f++) {
    m.frame(talk, lufs);
    for (let i = 0; i < 480; i++) m.next();
  }
  return m.gainDbValue;
}

describe('MasterLeveler (talk-keyed)', () => {
  it("starts at the gain the mic levelers' target implies", () => {
    const m = new MasterLeveler(-16, -23, SR);
    expect(m.gainDbValue).toBeCloseTo(7, 6);
    expect(m.next()).toBeCloseTo(Math.pow(10, 7 / 20), 6);
  });

  it('holds through music, jingles and silence', () => {
    const m = new MasterLeveler(-16, -23, SR);
    expect(feed(m, 20, false, -12)).toBeCloseTo(7, 6); // loud music, no talk
    expect(feed(m, 5, true, -70)).toBeCloseTo(7, 6); // "talk" below the gate
  });

  it('learns from talk slowly and settles on it', () => {
    const m = new MasterLeveler(-16, -23, SR);
    // The talk comes out 3 dB quieter than the levelers aim for.
    const after2 = feed(m, 2, true, -26);
    expect(after2).toBeGreaterThan(7);
    expect(after2).toBeLessThan(8); // a sentence doesn't move it much ...
    expect(feed(m, 60, true, -26)).toBeCloseTo(10, 0); // ... a minute does
  });

  it('ignores the pauses between sentences', () => {
    const m = new MasterLeveler(-16, -23, SR);
    for (let i = 0; i < 20; i++) {
      feed(m, 1, true, -23);
      feed(m, 0.3, true, -45); // 22 LU down: a pause still flagged as talk
    }
    expect(m.gainDbValue).toBeCloseTo(7, 1);
  });

  it('stays within its range', () => {
    const m = new MasterLeveler(-16, -23, SR, 12);
    expect(feed(m, 120, true, -45)).toBeLessThanOrEqual(12.001);
  });
});

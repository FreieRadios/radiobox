import { SpeechLeveler } from '../../src/dsp/speech-leveler';
import { Leveler } from '../../src/dsp/leveler';
import { LevelerParams } from '../../src/config/schema';
import { SR, rmsDb, tone } from '../../test-support/config';

const params = (over: Partial<LevelerParams> = {}): LevelerParams => ({
  enabled: true,
  targetLufs: -23,
  maxGainDb: 24,
  rangeDb: 24,
  responseMs: 1500,
  ...over,
});

const LOOK = 3 * SR;

describe('SpeechLeveler (voice-keyed, look-ahead)', () => {
  it('is a plain delay when disabled', () => {
    const lev = new SpeechLeveler(params({ enabled: false }), SR, 4);
    const out = [1, 2, 3, 4, 5, 6].map((x) => lev.process(x));
    expect(out).toEqual([0, 0, 0, 0, 1, 2]);
    expect(new SpeechLeveler(params({ enabled: false }), SR).process(0.3)).toBe(0.3);
  });

  it('settles on the same gain as the windowed leveler for a steady signal', () => {
    const a = new SpeechLeveler(params({ responseMs: 50 }), SR);
    const b = new Leveler(params({ responseMs: 50 }), SR);
    for (const x of tone(-35, 8)) {
      a.process(x);
      b.process(x);
    }
    expect(a.gainDbValue).toBeCloseTo(b.gainDbValue, 1);
    expect(a.gainDbValue).toBeGreaterThan(8);
  });

  it('has the gain in place when the first word leaves the look-ahead', () => {
    const lev = new SpeechLeveler(params(), SR, LOOK);
    const voice = tone(-43, 4); // 20 dB under target
    const out = new Float32Array(voice.length + LOOK);
    for (let i = 0; i < out.length; i++) out[i] = lev.process(i < voice.length ? voice[i] : 0);
    // The voice comes out LOOK samples later; its first 500 ms must already
    // sit at the target (a 1 kHz tone at -23 LUFS is ~ -22.3 dBFS RMS).
    const first = rmsDb(out, LOOK, LOOK + SR / 2);
    const settled = rmsDb(out, LOOK + 3 * SR, LOOK + 4 * SR);
    expect(Math.abs(first - settled)).toBeLessThan(2);
    expect(settled).toBeGreaterThan(-24.5);
    expect(settled).toBeLessThan(-21);
  });

  it('a causal leveler (no look-ahead) is still fading up during the first 500 ms', () => {
    const lev = new SpeechLeveler(params(), SR, 0);
    const voice = tone(-43, 6);
    const out = voice.map((x) => lev.process(x));
    expect(rmsDb(out, 5 * SR, 6 * SR) - rmsDb(out, 0, SR / 2)).toBeGreaterThan(6);
  });

  it('does not adapt while the mic is not the active talker', () => {
    const lev = new SpeechLeveler(params(), SR, LOOK);
    for (const x of tone(-43, 4)) lev.process(x, false);
    expect(lev.gainDbValue).toBe(0);
  });

  it('holds its gain through silence and through inactive bleed', () => {
    const lev = new SpeechLeveler(params(), SR, LOOK);
    for (const x of tone(-35, 5)) lev.process(x, true);
    const settled = lev.gainDbValue;
    for (let i = 0; i < 3 * SR; i++) lev.process(0, true); // silence, key still on
    for (const x of tone(-55, 3)) lev.process(x, false); // a neighbour's bleed
    // Only the few ms the level detector needs to notice the silence count.
    expect(Math.abs(lev.gainDbValue - settled)).toBeLessThan(0.5);
  });

  it('starts from a seed gain and lets real speech correct it', () => {
    const lev = new SpeechLeveler(params(), SR, LOOK, 12);
    expect(lev.gainDbValue).toBe(12);
    for (let i = 0; i < SR; i++) lev.process(0, true);
    expect(lev.gainDbValue).toBeCloseTo(12, 3); // no evidence, no change
    for (const x of tone(-29, 8)) lev.process(x, true); // really needs ~ +6
    expect(lev.gainDbValue).toBeGreaterThan(5);
    expect(lev.gainDbValue).toBeLessThan(8);
  });

  it('stays within its configured range', () => {
    const lev = new SpeechLeveler(params({ maxGainDb: 10, rangeDb: 6 }), SR);
    for (const x of tone(-60, 6)) lev.process(x, true);
    expect(lev.gainDbValue).toBeLessThanOrEqual(10.001);
    const loud = new SpeechLeveler(params({ maxGainDb: 10, rangeDb: 6 }), SR);
    for (const x of tone(-6, 6)) loud.process(x, true);
    expect(loud.gainDbValue).toBeGreaterThanOrEqual(-6.001);
  });
});

import { SpeechLeveler } from '../../src/dsp/speech-leveler';
import { LevelerParams } from '../../src/config/schema';
import { SR, concat, rmsDb, tone } from '../../test-support/config';

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

  it('settles on target minus loudness for a steady signal', () => {
    const a = new SpeechLeveler(params({ responseMs: 50 }), SR);
    for (const x of tone(-35, 8)) a.process(x);
    // A 1 kHz tone reads the same in LUFS as in dBFS RMS: +12 dB to -23.
    expect(a.gainDbValue).toBeCloseTo(12, 0);
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

  it('a causal leveler (no look-ahead) is late by the evidence it needs', () => {
    const lev = new SpeechLeveler(params(), SR, 0);
    const voice = tone(-43, 6);
    const out = voice.map((x) => lev.process(x));
    const settled = rmsDb(out, 5 * SR, 6 * SR);
    // The first 40 ms go out unlevelled ...
    expect(settled - rmsDb(out, 0, 0.04 * SR)).toBeGreaterThan(10);
    // ... from 200 ms on it is there.
    expect(Math.abs(settled - rmsDb(out, 0.2 * SR, SR))).toBeLessThan(1);
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

  /** Run `x` through a leveler with look-ahead; the output is re-aligned
   *  with the input (the delay taken off). */
  const aligned = (lev: SpeechLeveler, x: Float32Array, look: number): Float32Array => {
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length + look; i++) {
      const y = lev.process(i < x.length ? x[i] : 0);
      if (i >= look) out[i - look] = y;
    }
    return out;
  };

  it('changes the gain around a change of level, not seconds before it', () => {
    // A talker 10 dB louder for 5 s, then quieter for 5 s (moved away).
    const x = concat(tone(-30, 5), tone(-40, 5));
    const out = aligned(new SpeechLeveler(params({ riderDb: 0 }), SR, LOOK), x, LOOK);
    const at = 5 * SR;
    // Up to 1 s before the step the louder part is still at target …
    expect(rmsDb(out, at - SR, at - SR / 2)).toBeLessThan(-21);
    expect(rmsDb(out, at - SR, at - SR / 2)).toBeGreaterThan(-24.5);
    // … and 1 s after it the quieter part is at target too.
    expect(rmsDb(out, at + SR, at + 2 * SR)).toBeGreaterThan(-24.5);
    expect(rmsDb(out, at + SR, at + 2 * SR)).toBeLessThan(-21);
  });

  it('rides a short dip (talker turned away) back up, within riderDb', () => {
    // 3 s at -30, 600 ms at -40, 3 s at -30.
    const x = concat(tone(-30, 3), tone(-40, 0.6), tone(-30, 3));
    const dip = (riderDb: number) => {
      const out = aligned(new SpeechLeveler(params({ riderDb }), SR, LOOK), x, LOOK);
      return rmsDb(out, 1 * SR, 2.5 * SR) - rmsDb(out, 3.2 * SR, 3.5 * SR);
    };
    const plain = dip(0);
    const ridden = dip(6);
    expect(plain).toBeGreaterThan(8); // the phrase stage barely sees 600 ms
    expect(plain - ridden).toBeGreaterThan(3.5);
    expect(plain - ridden).toBeLessThan(6.5); // never more than riderDb
  });

  it('keeps a noisy mic from being boosted beyond its noise ceiling', () => {
    const lev = new SpeechLeveler(params({ noiseCeilingDb: -50 }), SR);
    lev.setNoiseFloor(-60); // 10 dB of room
    for (const x of tone(-55, 4)) lev.process(x, true);
    expect(lev.capDb).toBe(10);
    expect(lev.gainDbValue).toBeLessThanOrEqual(10.001);
    expect(lev.gainDbValue).toBeGreaterThan(9);
    lev.setNoiseFloor(-80); // a quiet mic gets the full range again
    expect(lev.capDb).toBe(24);
    lev.setNoiseFloor(-40); // never forces a cut
    expect(lev.capDb).toBe(0);
  });
});

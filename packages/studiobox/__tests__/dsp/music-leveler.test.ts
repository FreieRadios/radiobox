import { MusicLeveler } from '../../src/dsp/music-leveler';
import { LevelerParams } from '../../src/config/schema';
import { SR, concat, silence, tone } from '../../test-support/config';

const params = (over: Partial<LevelerParams> = {}): LevelerParams => ({
  enabled: true,
  targetLufs: -22,
  maxGainDb: 24,
  rangeDb: 12,
  responseMs: 2000,
  ...over,
});

const DELAY = 3 * SR;

/** Run a signal through; returns the programme gain (dB) for every sample
 *  of the input as it leaves the delay, and the room gain as it was then. */
function run(lev: MusicLeveler, x: Float32Array, starts: number[] = []) {
  const prog = new Float32Array(x.length);
  const room = new Float32Array(x.length);
  for (let i = 0; i < x.length + DELAY; i++) {
    if (starts.includes(i)) lev.newItem();
    // Mono material on one channel: reads as the tone's own level.
    lev.process(i < x.length ? x[i] : 0, 0);
    if (i < x.length) room[i] = 20 * Math.log10(lev.roomGain);
    if (i >= DELAY) prog[i - DELAY] = lev.gainDbValue;
  }
  return { prog, room };
}

describe('MusicLeveler (per item, with look-ahead)', () => {
  it('is a no-op when disabled', () => {
    const lev = new MusicLeveler(params({ enabled: false }), SR, DELAY);
    lev.process(0.5, 0.5);
    expect(lev.programmeGain).toBe(1);
    expect(lev.roomGain).toBe(1);
  });

  it('has a jingle at target from its first sample on air', () => {
    // A loud 4 s jingle after quiet music (a 1 kHz tone reads the same in
    // LUFS as in dBFS RMS).
    const x = concat(tone(-30, 5), tone(-10, 4));
    const { prog } = run(new MusicLeveler(params(), SR, DELAY), x, [5 * SR]);
    expect(prog[5 * SR + Math.round(0.02 * SR)]).toBeCloseTo(-12, 0);
    expect(prog[8 * SR]).toBeCloseTo(-12, 0);
    // ... while the quiet item before it kept its own gain until 30 ms
    // before its end (where the glide to the next gain starts).
    expect(prog[5 * SR - Math.round(0.05 * SR)]).toBeCloseTo(8, 0);
  });

  it('keeps one gain through an item instead of riding its dynamics', () => {
    // A song: 6 s quiet verse, 6 s loud chorus (12 dB apart).
    const x = concat(tone(-34, 6), tone(-22, 6));
    const { prog } = run(new MusicLeveler(params(), SR, DELAY), x, [0]);
    const verse = prog[3 * SR];
    const chorus = prog[9 * SR];
    // It learns the item as it plays (the verse alone first, then verse and
    // chorus), but the chorus still comes out louder than the verse.
    expect(verse).toBeCloseTo(12, 0);
    expect(-22 + chorus - (-34 + verse)).toBeGreaterThan(2.5);
  });

  it('starts a new item after a gap of silence (live inputs)', () => {
    const x = concat(tone(-30, 4), silence(2), tone(-15, 4));
    const { prog } = run(new MusicLeveler(params(), SR, DELAY), x);
    expect(prog[2 * SR]).toBeCloseTo(8, 0);
    expect(prog[6 * SR + SR / 10]).toBeCloseTo(-7, 0);
  });

  it('gives the room the causal measurement', () => {
    const x = concat(tone(-30, 5), tone(-10, 4));
    const { room } = run(new MusicLeveler(params(), SR, DELAY), x, [5 * SR]);
    expect(room[4 * SR]).toBeCloseTo(8, 0);
    expect(room[8 * SR]).toBeCloseTo(-12, 0); // caught up within the item
  });

  it("leaves the quiet passages out of an item's loudness (relative gate)", () => {
    // 2 s loud, 2 s 20 dB quieter: the item reads as its loud part (-15),
    // not as the mean of both (~ -18).
    const x = concat(tone(-15, 2), tone(-35, 2));
    const { prog } = run(new MusicLeveler(params(), SR, DELAY), x, [0]);
    expect(prog[3 * SR]).toBeLessThan(-6); // ungated it would be ~ -4
    expect(prog[3 * SR]).toBeGreaterThan(-7.5);
  });

  it('measures stereo loudness, not the mono mix', () => {
    // The same tone on both channels is 3 dB louder than on one.
    const x = tone(-30, 3);
    const both = new MusicLeveler(params(), SR, 0);
    for (const v of x) both.process(v, v);
    expect(both.gainDbValue).toBeCloseTo(5, 0);
  });

  it('stays within its range and holds through silence', () => {
    const lev = new MusicLeveler(params({ maxGainDb: 10, rangeDb: 6 }), SR, 0);
    run(lev, tone(-50, 3));
    expect(lev.gainDbValue).toBeLessThanOrEqual(10.001);
    const g = lev.gainDbValue;
    for (let i = 0; i < 3 * SR; i++) lev.process(0, 0);
    expect(lev.gainDbValue).toBeCloseTo(g, 3);
  });
});

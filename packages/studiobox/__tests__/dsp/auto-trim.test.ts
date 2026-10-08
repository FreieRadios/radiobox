import { AutoTrim } from '../../src/dsp/auto-trim';
import { AutoTrimConfig } from '../../src/config/schema';

const CFG: AutoTrimConfig = {
  enabled: true,
  targetDb: -20,
  minDb: -10,
  maxDb: 30,
  rateDbPerSec: 2,
  maxLagMs: 10,
};
const DT = 0.04;
/** The trim stops within the deadband (0.5 dB) of where it wants to be. */
const near = (x: number, want: number) => expect(Math.abs(x - want)).toBeLessThan(0.5);

/** `sec` seconds of hops at `levelDb`, as this mic's talker or not. */
function feed(t: AutoTrim, sec: number, levelDb: number, talker = true): number {
  let trim = t.trimDb;
  for (let i = 0; i < Math.round(sec / DT); i++) trim = t.update(levelDb, talker, DT);
  return trim;
}

describe('AutoTrim', () => {
  it('trims a quiet speaker up to the target', () => {
    const t = new AutoTrim(CFG, 0);
    // Speech at -42 dBFS needs +22 dB.
    near(feed(t, 20, -42), 22);
    expect(t.speechDb).toBeCloseTo(-42, 1);
  });

  it('waits for 1.5 s of speech before it moves', () => {
    const t = new AutoTrim(CFG, 0);
    expect(feed(t, 1.4, -40)).toBe(0);
    expect(feed(t, 0.2, -40)).toBeGreaterThan(0);
  });

  it('glides: fast at the start of a voice, then at rateDbPerSec', () => {
    const t = new AutoTrim(CFG, 0);
    const start = feed(t, 1.6, -50); // wants +30
    const a = feed(t, 1, -50) - start;
    // In the first seconds 3 x 2 dB/s.
    expect(a).toBeGreaterThan(5.5);
    expect(a).toBeLessThanOrEqual(6 + 1e-9);
    const s = new AutoTrim(CFG, 0);
    s.seed(0, 30); // plenty of talk heard already: normal rate
    feed(s, 2, -26); // the long average moves towards -26 slowly
    const before = s.trimDb;
    const after = feed(s, 1, -26);
    expect(after - before).toBeLessThanOrEqual(2 + 1e-9);
  });

  it('only learns from frames of its own talker', () => {
    const t = new AutoTrim(CFG, 5);
    feed(t, 30, -60, false); // bleed of somebody else
    expect(t.trimDb).toBe(5);
    expect(t.speechDb).toBeNull();
  });

  it('follows a gain knob turned up in the middle of the show within seconds', () => {
    const t = new AutoTrim(CFG, 0);
    feed(t, 30, -40);
    near(t.trimDb, 20);
    // Knob +15 dB: speech now arrives at -25. Within 10 s of talk the trim
    // is back to within 3 dB (the leveler takes the rest), within 20 s there.
    feed(t, 10, -25);
    expect(Math.abs(t.trimDb - 5)).toBeLessThan(3);
    feed(t, 10, -25);
    near(t.trimDb, 5);
  });

  it('follows a gain knob turned down just as well', () => {
    const t = new AutoTrim(CFG, 0);
    feed(t, 30, -25);
    near(t.trimDb, 5);
    // Knob -15 dB: the loud past would hold a power average up for long;
    // the jump detection lets go of it.
    feed(t, 6, -40);
    near(t.trimDb, 20);
  });

  it('does not move on a few stray frames spread over minutes', () => {
    const t = new AutoTrim(CFG, 10);
    // One quiet "talker" frame every 2 s for 3 minutes: 3.6 s of evidence,
    // never 1.5 s within 10 s.
    for (let i = 0; i < 90; i++) {
      t.update(-60, true, DT);
      feed(t, 2 - DT, -60, false);
    }
    expect(t.trimDb).toBe(10);
  });

  it('stays within its limits', () => {
    const t = new AutoTrim(CFG, 0);
    near(feed(t, 60, -70), 30);
    near(feed(t, 60, 0), -10);
  });

  it('ignores differences under half a dB (no constant fiddling)', () => {
    const t = new AutoTrim(CFG, 0);
    t.seed(20, 30);
    expect(feed(t, 10, -40.3)).toBe(20);
  });

  it('switched off it keeps listening but leaves the trim alone', () => {
    const t = new AutoTrim(CFG, 3);
    t.on = false;
    expect(feed(t, 20, -40)).toBe(3);
    t.on = true;
    near(feed(t, 20, -40), 20);
  });

  it('a seeded trim (setup assistant) is kept until the voices say otherwise', () => {
    const t = new AutoTrim(CFG, 0);
    t.seed(14, 6);
    // Speech exactly where the measured trim puts it: nothing moves.
    expect(feed(t, 10, -34)).toBe(14);
  });
});

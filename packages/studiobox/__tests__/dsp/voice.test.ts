import { DuckPlanner, VoiceDetector } from '../../src/dsp/voice';
import { SR } from '../../test-support/config';
import { mix, noise, voice } from '../../test-support/voice';

/** Run a signal through a detector; returns the voiced flag per 10 ms frame. */
function frames(det: VoiceDetector, x: Float32Array, talker = true): boolean[] {
  const out: boolean[] = [];
  for (const v of x) if (det.process(v, talker)) out.push(det.voiced);
  return out;
}
const share = (f: boolean[]) => f.filter(Boolean).length / Math.max(1, f.length);

describe('VoiceDetector', () => {
  it('learns the noise floor and does not call noise talk', () => {
    const det = new VoiceDetector(SR);
    const f = frames(det, noise(-55, 6));
    expect(det.floorDb).toBeGreaterThan(-57);
    expect(det.floorDb).toBeLessThan(-54);
    // After the first two seconds nothing of it is voiced.
    expect(share(f.slice(200))).toBe(0);
  });

  it('hears a voice above the noise', () => {
    const det = new VoiceDetector(SR);
    frames(det, noise(-60, 3));
    const f = frames(det, mix(voice({ rmsDb: -35, seconds: 3 }), noise(-60, 3)));
    // Syllables are 220 ms of every 300 ms.
    expect(share(f)).toBeGreaterThan(0.6);
  });

  it("learns the talker's level and ignores a murmur far below it", () => {
    const det = new VoiceDetector(SR);
    const bg = (s: number) => noise(-75, s, 9);
    frames(det, mix(voice({ rmsDb: -25, seconds: 6 }), bg(6)));
    expect(det.speechDb!).toBeGreaterThan(-28);
    expect(det.speechDb!).toBeLessThan(-22);
    // 25 dB under the talker: a whisper next to the mic.
    expect(share(frames(det, mix(voice({ rmsDb: -50, seconds: 2 }), bg(2))))).toBeLessThan(0.05);
    // 12 dB under: the same talker, turned away — still talk.
    expect(share(frames(det, mix(voice({ rmsDb: -37, seconds: 2 }), bg(2))))).toBeGreaterThan(0.6);
  });

  it('tells a talk-level syllable from a breath', () => {
    const det = new VoiceDetector(SR);
    frames(det, noise(-80, 3, 5));
    let strong = 0;
    for (const v of noise(-55, 0.5, 6)) if (det.process(v, false) && det.strong) strong++;
    expect(strong).toBe(0); // voiced (above -60), but no syllable
    for (const v of noise(-40, 0.5, 6)) if (det.process(v, false) && det.strong) strong++;
    expect(strong).toBeGreaterThan(40);
  });

  it('learns the speech level only while its mic is the talker', () => {
    const det = new VoiceDetector(SR);
    frames(det, voice({ rmsDb: -25, seconds: 4 }), false);
    expect(det.speechDb).toBeNull();
    det.seedSpeech(-20);
    expect(det.speechDb).toBe(-20);
  });
});

describe('DuckPlanner', () => {
  const plan = { minSpeechMs: 300, minStrongMs: 30, gapMs: 150, leadMs: 100, holdMs: 400 };
  /** Drive a planner with one mic's voiced frames; returns ducking per frame. */
  const drive = (p: DuckPlanner, voiced: boolean[]) => voiced.map((v) => (p.push([v]), p.ducking));
  const pattern = (...runs: [boolean, number][]) => runs.flatMap(([v, n]) => Array(n).fill(v));

  it('never ducks for a short burst', () => {
    const p = new DuckPlanner(plan, 1, 100);
    const d = drive(p, pattern([false, 50], [true, 15], [false, 300]));
    expect(d.some(Boolean)).toBe(false);
  });

  it('ducks talk from lead before its first word to hold after its last', () => {
    const delay = 100; // 1 s look-ahead
    const p = new DuckPlanner(plan, 1, delay);
    const d = drive(p, pattern([false, 200], [true, 50], [false, 300]));
    // Programme frame g is room frame g - delay: talk spans room 200..249.
    const on = d.map((v, i) => (v ? i - delay : null)).filter((v) => v !== null) as number[];
    expect(on[0]).toBe(200 - 10); // 100 ms lead
    expect(on[on.length - 1]).toBe(249 + 40); // 400 ms hold
  });

  it('bridges the gaps between syllables', () => {
    const p = new DuckPlanner(plan, 1, 100);
    // 22 frames on, 8 off (the test voice's rhythm), ten times.
    const syl = pattern(
      ...Array.from(
        { length: 10 },
        () =>
          [
            [true, 22],
            [false, 8],
          ] as [boolean, number][]
      ).flat()
    );
    const d = drive(
      p,
      pattern([false, 100], ...syl.map((v) => [v, 1] as [boolean, number]), [false, 200])
    );
    const first = d.indexOf(true);
    const last = d.lastIndexOf(true);
    expect(first).toBeGreaterThan(0);
    // One duck over all ten syllables (300 frames) plus lead and hold.
    expect(last - first + 1).toBe(10 + 292 + 40);
    expect(d.slice(first, last + 1).every(Boolean)).toBe(true);
  });

  it('needs talk-level syllables in a stretch, not just a long breath', () => {
    const p = new DuckPlanner(plan, 1, 100);
    const on = pattern([false, 50], [true, 60], [false, 300]);
    const weak = on.map(() => false);
    expect(on.map((v, i) => (p.push([v], [weak[i]]), p.ducking)).some(Boolean)).toBe(false);
    const q = new DuckPlanner(plan, 1, 100);
    const strong = on.map((v, i) => v && i >= 80 && i < 84); // 40 ms of syllable
    expect(on.map((v, i) => (q.push([v], [strong[i]]), q.ducking)).some(Boolean)).toBe(true);
  });

  it('counts talk on any one mic, not bursts spread over several', () => {
    const p = new DuckPlanner(plan, 2, 100);
    // 100 ms bursts, one mic after the other, then 100 ms of quiet: together
    // they would bridge into one stretch, but neither mic alone reaches 300 ms.
    const f: boolean[][] = [];
    for (let i = 0; i < 120; i++) f.push([i % 30 < 10, i % 30 >= 10 && i % 30 < 20]);
    for (let i = 0; i < 300; i++) f.push([false, false]);
    expect(f.map((v) => (p.push(v), p.ducking)).some(Boolean)).toBe(false);
  });
});

import { Limiter } from '../../src/dsp/limiter';
import { dbToGain } from '../../src/dsp/dsp-math';

const SR = 48000;

describe('Limiter', () => {
  it('passes a signal below the ceiling through unchanged (after the look-ahead delay)', () => {
    const lim = new Limiter(SR, 6, 5, 50); // ceiling +6 dB
    const out: [number, number] = [0, 0];
    const look = Math.round((5 / 1000) * SR);
    let tail: [number, number] = [0, 0];
    for (let i = 0; i < look + 500; i++) tail = [...lim.process(out, 0.5, 0.5)] as [number, number];
    expect(tail[0]).toBeCloseTo(0.5, 4);
    expect(tail[1]).toBeCloseTo(0.5, 4);
    expect(lim.gainReductionDb).toBeCloseTo(0, 4);
  });

  it('never lets the output exceed the ceiling for a sustained loud signal', () => {
    const lim = new Limiter(SR, -1, 5, 50); // ceiling -1 dBFS
    const ceiling = dbToGain(-1);
    const out: [number, number] = [0, 0];
    let maxAbs = 0;
    for (let i = 0; i < 4000; i++) {
      lim.process(out, 1, 1); // +0 dBFS, above the -1 dB ceiling
      if (i > 1000) maxAbs = Math.max(maxAbs, Math.abs(out[0]), Math.abs(out[1]));
    }
    expect(maxAbs).toBeLessThanOrEqual(ceiling + 0.01);
    expect(lim.gainReductionDb).toBeGreaterThan(0);
  });

  it('brick-walls a sudden sustained transient with no overshoot', () => {
    // The linear attack reaches the required reduction within the look-ahead
    // window, so even the very first loud output sample is already at the ceiling.
    const lim = new Limiter(SR, -1, 5, 50);
    const ceiling = dbToGain(-1);
    const look = Math.round((5 / 1000) * SR);
    const out: [number, number] = [0, 0];
    let maxAbs = 0;
    for (let i = 0; i < look; i++) lim.process(out, 0, 0); // silence fills the look-ahead
    for (let i = 0; i < look + 2000; i++) {
      lim.process(out, 4, 4); // abrupt 4x-over-ceiling block
      maxAbs = Math.max(maxAbs, Math.abs(out[0]), Math.abs(out[1]));
    }
    expect(maxAbs).toBeLessThanOrEqual(ceiling + 1e-3);
  });

  it('catches a lone single-sample impulse without overshoot (sliding window-max)', () => {
    // A 1-sample spike amid quiet audio: the window-max keeps the gain low for the
    // whole time the spike is in flight, so it surfaces clamped to the ceiling.
    const lim = new Limiter(SR, -1, 5, 50);
    const ceiling = dbToGain(-1);
    const out: [number, number] = [0, 0];
    let maxAbs = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i === 500 ? 5 : 0.1; // lone 5.0 spike, otherwise below the ceiling
      lim.process(out, x, x);
      maxAbs = Math.max(maxAbs, Math.abs(out[0]), Math.abs(out[1]));
    }
    expect(maxAbs).toBeLessThanOrEqual(ceiling + 1e-3);
  });

  it('is stereo-linked — both channels share one gain', () => {
    const lim = new Limiter(SR, -1, 5, 50);
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 4000; i++) lim.process(out, 1, 0.2); // L drives, R quieter
    // Both delayed inputs are scaled by the same gain, so their ratio is preserved.
    expect(out[1] / out[0]).toBeCloseTo(0.2, 3);
  });
});

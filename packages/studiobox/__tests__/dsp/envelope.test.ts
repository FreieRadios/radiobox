import { EnvelopeFollower } from '../../src/dsp/envelope';

const SR = 48000;

describe('EnvelopeFollower', () => {
  it('tracks the magnitude of a constant signal', () => {
    const env = new EnvelopeFollower(SR, 1, 50);
    let v = 0;
    for (let i = 0; i < 4000; i++) v = env.process(0.5);
    expect(v).toBeCloseTo(0.5, 3);
  });

  it('rectifies — negative input is tracked by absolute value', () => {
    const env = new EnvelopeFollower(SR, 1, 50);
    let v = 0;
    for (let i = 0; i < 4000; i++) v = env.process(-0.5);
    expect(v).toBeCloseTo(0.5, 3);
  });

  it('with 0 ms attack jumps to the input magnitude instantly', () => {
    const env = new EnvelopeFollower(SR, 0, 100);
    expect(env.process(1)).toBeCloseTo(1, 12);
    expect(env.process(-2)).toBeCloseTo(2, 12);
  });

  it('releases gradually after the signal drops to zero', () => {
    const env = new EnvelopeFollower(SR, 0, 50);
    env.process(1); // env == 1
    const afterOne = env.process(0);
    expect(afterOne).toBeLessThan(1);
    expect(afterOne).toBeGreaterThan(0.9); // 50 ms release is slow at 48 kHz
    for (let i = 0; i < 50000; i++) env.process(0);
    expect(env.value).toBeLessThan(1e-3); // eventually decays to ~0
  });

  it('reset() returns the envelope to zero', () => {
    const env = new EnvelopeFollower(SR, 1, 50);
    env.process(1);
    env.reset();
    expect(env.value).toBe(0);
  });
});

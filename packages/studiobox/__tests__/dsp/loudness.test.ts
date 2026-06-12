import { StereoLoudness, MonoLoudness } from '../../src/dsp/loudness';

const SR = 48000;

/** Feed `seconds` of a stereo (dual-mono) sine into a fresh meter. */
function feedSine(meter: StereoLoudness, amp: number, freq = 1000, seconds = 4): void {
  const n = Math.round(seconds * SR);
  for (let i = 0; i < n; i++) {
    const s = amp * Math.sin((2 * Math.PI * freq * i) / SR);
    meter.process(s, s);
  }
}

describe('loudness — sample-rate guard', () => {
  it('throws unless constructed at 48 kHz', () => {
    expect(() => new StereoLoudness(44100)).toThrow(/48 kHz/);
    expect(() => new MonoLoudness(96000)).toThrow(/48 kHz/);
    expect(() => new StereoLoudness(48000)).not.toThrow();
  });
});

describe('StereoLoudness', () => {
  it('reports -Infinity LUFS for silence', () => {
    const m = new StereoLoudness(SR);
    for (let i = 0; i < 1000; i++) m.process(0, 0);
    expect(m.momentaryLufs).toBe(-Infinity);
    expect(m.shortTermLufs).toBe(-Infinity);
  });

  it('momentary and short-term agree for a steady tone', () => {
    const m = new StereoLoudness(SR);
    feedSine(m, 0.5);
    expect(Number.isFinite(m.shortTermLufs)).toBe(true);
    expect(m.momentaryLufs).toBeCloseTo(m.shortTermLufs, 1);
  });

  it('scales by ~6 dB when the amplitude doubles', () => {
    const quiet = new StereoLoudness(SR);
    feedSine(quiet, 0.1);
    const loud = new StereoLoudness(SR);
    feedSine(loud, 0.2);
    expect(loud.shortTermLufs - quiet.shortTermLufs).toBeCloseTo(6.02, 1);
  });
});

describe('MonoLoudness', () => {
  it('returns a finite short-term LUFS for a steady tone', () => {
    const m = new MonoLoudness(SR, 3.0);
    const n = 4 * SR;
    for (let i = 0; i < n; i++) m.process(0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    expect(Number.isFinite(m.shortTermLufs)).toBe(true);
  });
});

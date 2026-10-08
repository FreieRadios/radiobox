import { ArrivalHop, ArrivalTalker } from '../../src/dsp/arrival';
import { Fft } from '../../src/dsp/fft';
import { SR } from '../../test-support/config';
import { noise, rng } from '../../test-support/voice';

describe('Fft', () => {
  it('matches a plain DFT and inverts back', () => {
    const n = 64;
    const r = rng(5);
    const x = Array.from({ length: n }, () => r() - 0.5);
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    new Fft(n).transform(re, im);
    for (const k of [0, 1, 7, 31, 32, 50]) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t++) {
        dr += x[t] * Math.cos((2 * Math.PI * k * t) / n);
        di -= x[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
    new Fft(n).transform(re, im, true);
    for (let t = 0; t < n; t++) expect(re[t]).toBeCloseTo(x[t], 9);
  });

  it('refuses a size that is not a power of two', () => {
    expect(() => new Fft(48)).toThrow();
  });
});

/** Speech-like source without a pitch: noise in syllables (220 ms on, 80 ms
 *  off) at about -20 dBFS while on. A harmonic test voice would correlate
 *  at multiples of its period and blur the lag. */
function talk(seconds: number, seed: number): Float32Array {
  const x = noise(-17, seconds, seed);
  const period = Math.round(0.3 * SR);
  const on = Math.round(0.22 * SR);
  for (let i = 0; i < x.length; i++) if (i % period >= on) x[i] = 0;
  return x;
}

/** One talker heard on every mic: delayed by `delayMs[i]`, scaled by
 *  `gainDb[i]` (distance and the mic's own gain), plus each mic's own noise. */
function room(
  src: Float32Array,
  delayMs: number[],
  gainDb: number[],
  floorDb = -70
): Float32Array[] {
  return delayMs.map((d, i) => {
    const out = noise(floorDb, src.length / SR, 100 + i);
    const shift = Math.round((d / 1000) * SR);
    const g = Math.pow(10, gainDb[i] / 20);
    for (let t = shift; t < out.length; t++) out[t] += src[t - shift] * g;
    return out;
  });
}

function run(chans: Float32Array[], at = new ArrivalTalker(chans.length, SR)): ArrivalHop[] {
  const hops: ArrivalHop[] = [];
  const B = 1024;
  for (let o = 0; o + B <= chans[0].length; o += B) {
    at.push(
      chans.map((c) => c.subarray(o, o + B)),
      B,
      (h) => hops.push({ ...h, levelDb: h.levelDb.slice(), floorDb: h.floorDb.slice() })
    );
  }
  return hops;
}

const silent = (sec: number) => new Float32Array(Math.round(sec * SR));
const join = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

describe('ArrivalTalker', () => {
  it('names the mic the voice reaches first, even when that mic is 26 dB less sensitive', () => {
    // Mic 0 is next to the talker but its gain is far too low; mics 1 and 2
    // hear the voice later and, after their gain, much louder.
    const src = join(silent(2), talk(6, 9));
    const hops = run(room(src, [0, 2, 3], [-26, -10, -12]));
    const voiced = hops.slice(Math.round(2.5 / 0.04)).filter((h) => h.talker >= 0);
    expect(voiced.length).toBeGreaterThan(60);
    const right = voiced.filter((h) => h.talker === 0).length / voiced.length;
    expect(right).toBeGreaterThan(0.95);
    // On levels alone mic 1 would have won every one of these hops.
    expect(voiced.every((h) => h.levelDb[1] > h.levelDb[0])).toBe(true);
  });

  it('follows the talk from one mic to another', () => {
    const a = talk(4, 11);
    const b = talk(4, 12);
    const first = room(join(silent(2), a), [0, 2.5], [0, -8]);
    const second = room(join(silent(2), b), [2.5, 0], [-8, 0]);
    const chans = first.map((c, i) => join(c, second[i]));
    const hops = run(chans);
    const at = (fromSec: number, toSec: number) =>
      hops.slice(Math.round(fromSec / 0.04), Math.round(toSec / 0.04)).filter((h) => h.talker >= 0);
    const one = at(2.5, 6);
    const two = at(8.5, 12);
    expect(one.filter((h) => h.talker === 0).length / one.length).toBeGreaterThan(0.95);
    expect(two.filter((h) => h.talker === 1).length / two.length).toBeGreaterThan(0.95);
  });

  it('says nobody while only the noise floor is there', () => {
    const hops = run(room(silent(6), [0, 2, 3], [0, 0, 0]));
    expect(hops.filter((h) => h.talker >= 0).length).toBe(0);
    // The floor is the noise (-70 dBFS RMS), within a few dB.
    const last = hops[hops.length - 1];
    for (const f of last.floorDb) expect(Math.abs(f + 70)).toBeLessThan(3);
  });

  it('does not take the zero-lag copy of electrical crosstalk for a lead', () => {
    // The same signal on both mics at the same time and the same level: no
    // arrival order, no clear SNR winner -> nobody.
    const src = join(silent(2), talk(4, 13));
    const hops = run(room(src, [0, 0], [0, 0]));
    const named = hops.slice(Math.round(2.5 / 0.04)).filter((h) => h.talker >= 0);
    expect(named.length).toBe(0);
  });

  it('reports raw levels: a 1 kHz sine at -20 dBFS RMS reads -20', () => {
    const x = new Float32Array(SR * 2);
    const a = Math.pow(10, -20 / 20) * Math.SQRT2;
    for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const hops = run([x]);
    expect(hops[hops.length - 1].levelDb[0]).toBeCloseTo(-20, 1);
  });
});

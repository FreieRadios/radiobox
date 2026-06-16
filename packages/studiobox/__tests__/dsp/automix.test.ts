import { Automix } from '../../src/dsp/automix';

const SR = 48000;

/** Drive the automix with a fixed per-member amplitude vector until it settles. */
function settle(mix: Automix, samples: number[], n = 12000): Float32Array {
  let g = mix.currentGains;
  for (let i = 0; i < n; i++) g = mix.process(samples);
  return g;
}

describe('Automix (Dugan gain-sharing)', () => {
  it('gives a lone talker essentially the full bus', () => {
    const mix = new Automix(3, SR, 20, -60);
    const g = settle(mix, [0.5, 0, 0]);
    expect(g[0]).toBeGreaterThan(0.95);
    expect(g[1]).toBeLessThan(0.05);
    expect(g[2]).toBeLessThan(0.05);
  });

  it('shares the bus ~equally between two equal talkers', () => {
    const mix = new Automix(3, SR, 20, -60);
    const g = settle(mix, [0.5, 0.5, 0]);
    expect(g[0]).toBeCloseTo(0.5, 1);
    expect(g[1]).toBeCloseTo(0.5, 1);
    expect(g[2]).toBeLessThan(0.05);
    expect(g[0] + g[1]).toBeCloseTo(1, 1); // summed gain stays ~constant
  });

  it('pulls everything down toward the floor during silence', () => {
    const mix = new Automix(3, SR, 20, -60);
    const g = settle(mix, [0, 0, 0]);
    for (let i = 0; i < 3; i++) expect(g[i]).toBeLessThan(0.01);
  });
});

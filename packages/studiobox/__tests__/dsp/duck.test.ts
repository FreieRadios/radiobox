import { Ducker } from '../../src/dsp/duck';
import { DuckConfig } from '../../src/config/schema';
import { dbToGain } from '../../src/dsp/dsp-math';

const SR = 48000;

const params = (over: Partial<DuckConfig> = {}): DuckConfig => ({
  enabled: true,
  targets: ['music'],
  thresholdDb: -30,
  musicPresentDb: -40,
  depthDb: -12,
  attackMs: 5,
  holdMs: 50,
  releaseMs: 100,
  ...over,
});

function run(duck: Ducker, micBus: number, musicBus: number, n = 8000): number {
  let g = 1;
  for (let i = 0; i < n; i++) g = duck.process(micBus, musicBus);
  return g;
}

describe('Ducker', () => {
  it('returns unity gain when disabled', () => {
    const duck = new Ducker(params({ enabled: false }), SR);
    expect(duck.process(0.5, 0.5)).toBe(1);
  });

  it('attenuates music to the configured depth when a mic talks over it', () => {
    const duck = new Ducker(params(), SR);
    const g = run(duck, 0.5, 0.5); // mic active AND music present
    expect(g).toBeCloseTo(dbToGain(-12), 1);
    expect(duck.depthDb).toBeCloseTo(-12, 0);
  });

  it('does not duck when no music is present (avoids pumping the noise floor)', () => {
    const duck = new Ducker(params(), SR);
    const g = run(duck, 0.5, 0); // loud mic, but music bus silent
    expect(g).toBeCloseTo(1, 2);
  });

  it('does not duck when the mics are silent', () => {
    const duck = new Ducker(params(), SR);
    const g = run(duck, 0, 0.5); // music present, no mic activity
    expect(g).toBeCloseTo(1, 2);
  });
});

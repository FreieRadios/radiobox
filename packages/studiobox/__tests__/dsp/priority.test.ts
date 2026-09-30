import { Priority } from '../../src/dsp/priority';
import { PriorityConfig } from '../../src/config/schema';
import { SR } from '../../test-support/config';

const cfg = (over: Partial<PriorityConfig> = {}): PriorityConfig => ({
  enabled: true,
  label: 'Host',
  attenuate: ['Gast'],
  depthDb: -8,
  thresholdDb: -35,
  attackMs: 20,
  holdMs: 50,
  releaseMs: 50,
  ...over,
});

const run = (p: Priority, x: number, seconds: number): number => {
  let g = 0;
  for (let i = 0; i < seconds * SR; i++) g = p.process(x);
  return g;
};

describe('Priority (host priority)', () => {
  it('does nothing when disabled or while the priority mic is quiet', () => {
    expect(run(new Priority(cfg({ enabled: false }), SR), 0.5, 0.5)).toBe(0);
    expect(run(new Priority(cfg(), SR), 0.001, 0.5)).toBeCloseTo(0, 5);
  });

  it('turns the others down to the depth while the priority mic talks', () => {
    const p = new Priority(cfg(), SR);
    expect(run(p, 0.3, 0.5)).toBeCloseTo(-8, 1);
    expect(p.attenuationDb).toBeCloseTo(-8, 1);
  });

  it('holds, then lets go', () => {
    const p = new Priority(cfg({ holdMs: 200 }), SR);
    run(p, 0.3, 0.5);
    expect(run(p, 0, 0.15)).toBeCloseTo(-8, 1); // inside detector release + hold
    expect(run(p, 0, 1)).toBeCloseTo(0, 1);
  });

  it('never mutes: the depth is limited and adjustable live', () => {
    const p = new Priority(cfg({ depthDb: -60 }), SR);
    p.depthDb = -60;
    expect(p.depthDb).toBe(-24);
    p.depthDb = 3;
    expect(p.depthDb).toBe(0);
    p.depthDb = -6;
    expect(run(p, 0.3, 0.5)).toBeCloseTo(-6, 1);
  });
});

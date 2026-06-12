import { Gate } from '../../src/dsp/gate';
import { GateParams } from '../../src/config/schema';
import { gainToDb } from '../../src/dsp/dsp-math';

const SR = 48000;

const params = (over: Partial<GateParams> = {}): GateParams => ({
  enabled: true,
  thresholdDb: -40,
  rangeDb: -40,
  attackMs: 5,
  holdMs: 20,
  releaseMs: 20,
  ...over,
});

function run(gate: Gate, x: number, n: number): number {
  let g = 1;
  for (let i = 0; i < n; i++) g = gate.process(x);
  return g;
}

describe('Gate', () => {
  it('is a unity passthrough when disabled', () => {
    const gate = new Gate(params({ enabled: false }), SR);
    expect(gate.process(0)).toBe(1);
    expect(gate.process(0.5)).toBe(1);
  });

  it('opens to ~0 dB for a signal above threshold', () => {
    const gate = new Gate(params(), SR);
    const g = run(gate, 0.5, 8000); // -6 dBFS, well above -40 dB threshold
    expect(gainToDb(g)).toBeCloseTo(0, 1);
    expect(gate.openness).toBeGreaterThan(0.95);
  });

  it('stays closed at the range floor for silence', () => {
    const gate = new Gate(params(), SR);
    const g = run(gate, 0, 8000);
    expect(gainToDb(g)).toBeCloseTo(-40, 1); // attenuated to rangeDb
    expect(gate.openness).toBeLessThan(0.05);
  });

  it('holds open briefly after the signal stops (hold time)', () => {
    const gate = new Gate(params({ holdMs: 50 }), SR);
    run(gate, 0.5, 8000); // open
    const justAfter = gate.process(0); // first silent sample
    expect(gate.openness).toBeGreaterThan(0.95); // still held open
    expect(gainToDb(justAfter)).toBeGreaterThan(-5);
  });
});

import { AirBlock, AirFifo } from '../../src/audio/air-fifo';
import { SampleClock } from '../../src/audio/sample-clock';

const BLOCK_MS = 20;
const blk = (capturedMs: number, quiet = false): AirBlock => ({
  buf: Buffer.alloc(8),
  capturedMs,
  quiet,
});
const fifo = (over = {}) =>
  new AirFifo({
    delayMs: 10000,
    outputLatencyMs: 500,
    toleranceMs: 1000,
    blockMs: BLOCK_MS,
    ...over,
  });

/** Run producer and consumer on a fake clock. `outRate` is the output card's
 *  speed relative to the capture card (1 = same clock). Returns what aired. */
function simulate(f: AirFifo, seconds: number, outRate = 1, quiet = false) {
  const aired: { atMs: number; block: AirBlock | null }[] = [];
  let nextPush = 0;
  let nextPop = 0;
  for (let t = 0; t <= seconds * 1000; t++) {
    while (nextPush <= t) {
      f.push(blk(nextPush, quiet));
      nextPush += BLOCK_MS;
    }
    while (nextPop <= t) {
      aired.push({ atMs: nextPop, block: f.pop(nextPop) });
      nextPop += BLOCK_MS / outRate;
    }
  }
  return aired;
}

describe('AirFifo (pull)', () => {
  it('plays silence while it fills, then airs every block D after it was captured', () => {
    const f = fifo();
    const aired = simulate(f, 30);
    expect(f.state).toBe('live');
    const first = aired.findIndex((a) => a.block);
    // due = captured + D - output latency: the first block is handed over 9.5 s in.
    expect(aired[first].atMs).toBeCloseTo(9500, -2);
    expect(aired.slice(0, first).every((a) => a.block === null)).toBe(true);
    for (const a of aired.slice(first)) {
      expect(a.block).not.toBeNull();
      expect(a.atMs + 500 - a.block!.capturedMs).toBeCloseTo(10000, -2);
    }
    expect(f.measuredDelayMs!).toBeCloseTo(10000, -2);
    expect(f.underruns + f.resyncs + f.nudges).toBe(0);
  });

  it('reports no measured delay before anything aired', () => {
    const f = fifo();
    expect(f.measuredDelayMs).toBeNull();
    expect(f.pop(0)).toBeNull();
    expect(f.state).toBe('filling');
    expect(f.underruns).toBe(0); // filling is not an underrun
  });

  it('absorbs the drift of two sound cards over a 3 h show without touching the audio', () => {
    // 50 ppm apart: about half a second over three hours.
    for (const rate of [1 + 50e-6, 1 - 50e-6]) {
      const f = fifo();
      simulate(f, 3 * 3600, rate);
      expect(f.resyncs).toBe(0);
      expect(f.underruns).toBe(0);
      expect(f.nudges).toBe(0); // programme never silent in this run
      expect(Math.abs(f.measuredDelayMs! - 10000)).toBeLessThan(1000);
    }
  });

  it('nudges the delay back during silence instead of letting it wander', () => {
    // A fast and a slow output card, 400 ppm apart from the capture (extreme),
    // programme silent: the delay is held near the target with no resync.
    for (const rate of [1 + 400e-6, 1 - 400e-6]) {
      const f = fifo();
      simulate(f, 3600, rate, true);
      expect(f.resyncs).toBe(0);
      expect(f.nudges).toBeGreaterThan(0);
      expect(Math.abs(f.measuredDelayMs! - 10000)).toBeLessThan(250);
    }
  });

  it('re-centres in one step after the output stalled', () => {
    const f = fifo();
    simulate(f, 12);
    // The device is gone for 3 s: blocks pile up ...
    for (let t = 12020; t <= 15000; t += BLOCK_MS) f.push(blk(t));
    // ... and on its return the backlog is skipped, not aired 3 s late.
    const b = f.pop(15000)!;
    expect(f.resyncs).toBe(1);
    expect(15000 + 500 - b.capturedMs).toBeCloseTo(10000, -2);
  });

  it('rebuilds the delay with silence when it collapsed', () => {
    const f = fifo();
    simulate(f, 12);
    // Something ate 2 s of buffer (e.g. a restarted output filling its own).
    for (let i = 0; i < 100; i++) f.pop(12000);
    expect(f.pop(12001)).toBeNull();
    expect(f.state).toBe('filling');
    expect(f.resyncs).toBeGreaterThanOrEqual(1);
  });

  it('counts an underrun when the producer stops', () => {
    const f = fifo({ delayMs: 600, toleranceMs: 300 });
    simulate(f, 3);
    let t = 3000;
    while (f.length) f.pop((t += BLOCK_MS));
    expect(f.pop(t + BLOCK_MS)).toBeNull();
    expect(f.underruns).toBe(1);
  });

  it('bounds its memory when nobody takes blocks', () => {
    const f = fifo();
    for (let t = 0; t < 120000; t += BLOCK_MS) f.push(blk(t));
    expect(f.length).toBeLessThanOrEqual(Math.ceil((10000 + 2000 + 5000) / BLOCK_MS));
  });
});

describe('AirFifo (push: a plain delay line)', () => {
  it('releases each block when it falls due', () => {
    const f = fifo({ outputLatencyMs: 0 });
    const out: number[] = [];
    for (let t = 0; t <= 20000; t += BLOCK_MS) {
      f.push(blk(t));
      for (const b of f.drain(t)) out.push(t - b.capturedMs);
    }
    expect(out.length).toBeGreaterThan(400);
    expect(Math.min(...out)).toBe(10000);
    expect(Math.max(...out)).toBe(10000);
    expect(f.state).toBe('live');
    expect(f.measuredDelayMs!).toBeCloseTo(10000, 0);
  });
});

describe('SampleClock', () => {
  const SR = 48000;

  it('ignores the burstiness of block arrival', () => {
    const c = new SampleClock(SR);
    // 1024-sample blocks handed over six at a time, as an ALSA period delivers them.
    let samples = 0;
    for (let burst = 0; burst < 200; burst++) {
      const now = 1_000_000 + burst * 128;
      for (let i = 0; i < 6; i++) {
        samples += 1024;
        c.mark(samples, now);
      }
    }
    // Sample n was captured n/48 ms after sample 0, whatever the burst pattern.
    const t0 = c.timeOf(0);
    expect(c.timeOf(48000) - t0).toBeCloseTo(1000, 6);
    // Pinned to the earliest arrivals: the last sample of a burst arrives "now".
    expect(c.timeOf(samples)).toBeLessThanOrEqual(1_000_000 + 199 * 128 + 0.5);
    expect(c.timeOf(samples)).toBeGreaterThan(1_000_000 + 199 * 128 - 5);
  });

  it('follows a sound card that runs slow or fast against the system clock', () => {
    for (const ppm of [-100, 100]) {
      const c = new SampleClock(SR);
      let samples = 0;
      let now = 0;
      for (let i = 0; i < 60 * 47; i++) {
        samples += 1024;
        now = (samples / SR) * 1000 * (1 + ppm * 1e-6); // wall time of this many samples
        c.mark(samples, now);
      }
      expect(Math.abs(c.timeOf(samples) - now)).toBeLessThan(1);
    }
  });

  it('re-pins after a stall (capture restart)', () => {
    const c = new SampleClock(SR);
    c.mark(1024, 1000);
    c.mark(2048, 1000 + 21.3);
    c.mark(3072, 5000); // 4 s gap
    expect(c.timeOf(3072)).toBeCloseTo(5000, 3);
  });

  it('falls back to the given time before the first mark, and after reset', () => {
    const c = new SampleClock(SR);
    expect(c.timeOf(0, 42)).toBe(42);
    c.mark(1024, 1000);
    c.reset();
    expect(c.timeOf(0, 43)).toBe(43);
  });
});

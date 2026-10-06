import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FillServo, StreamDecoder, StreamPlayer } from '../../src/audio/stream-player';

const SR = 48000;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const BLOCK = 1024;

class FakeDecoder extends EventEmitter implements StreamDecoder {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  constructor(readonly args: string[]) {
    super();
  }
  kill(): void {
    this.killed = true;
    this.emit('close');
  }
  /** Send `frames` of a stereo sine, continuing its phase. */
  sine(frames: number, phase: { v: number }, freq = 440, amp = 0.5): void {
    const b = Buffer.alloc(frames * 8);
    for (let n = 0; n < frames; n++) {
      const v = amp * Math.sin(phase.v);
      phase.v += (2 * Math.PI * freq) / SR;
      b.writeFloatLE(v, 8 * n);
      b.writeFloatLE(v, 8 * n + 4);
    }
    this.stdout.emit('data', b);
  }
}

function setup(bufferMs = 500) {
  let now = 1_000_000;
  const decoders: FakeDecoder[] = [];
  const sp = new StreamPlayer(
    { label: 'Studio', url: 'http://maik:4445/stream', bufferMs },
    SR,
    quiet,
    {
      now: () => now,
      spawn: (args) => {
        const d = new FakeDecoder(args);
        decoders.push(d);
        return d;
      },
    }
  );
  const out = { l: [] as number[], events: [] as string[] };
  sp.on('lost', () => out.events.push('lost'));
  sp.on('back', () => out.events.push('back'));
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  const read = (blocks: number) => {
    for (let i = 0; i < blocks; i++) {
      now += (BLOCK / SR) * 1000;
      sp.read(l, r, BLOCK);
      for (const v of l) out.l.push(v);
    }
  };
  return { sp, decoders, out, read, advance: (ms: number) => (now += ms) };
}

const maxJump = (x: number[], from = 1): number => {
  let m = 0;
  for (let i = Math.max(1, from); i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

describe('StreamPlayer', () => {
  afterEach(() => jest.useRealTimers());

  it('decodes the URL to 48 kHz stereo float and waits for the buffer', () => {
    const { sp, decoders, out, read } = setup(500);
    sp.start();
    expect(decoders[0].args.join(' ')).toContain('-i http://maik:4445/stream');
    expect(decoders[0].args.join(' ')).toContain('-ar 48000 -ac 2 -f f32le');
    const ph = { v: 0 };
    decoders[0].sine(SR / 4, ph); // 250 ms: not enough yet
    read(5);
    expect(out.l.every((v) => v === 0)).toBe(true);
    expect(sp.status().state).toBe('connecting');
    decoders[0].sine(SR / 2, ph);
    read(10);
    expect(sp.status()).toMatchObject({ state: 'playing', connected: true, reason: null });
    expect(Math.max(...out.l.map(Math.abs))).toBeGreaterThan(0.45);
    sp.stop();
  });

  it('passes a tone through unchanged in level and without distortion', () => {
    const { sp, decoders, out, read } = setup(500);
    sp.start();
    const ph = { v: 0 };
    decoders[0].sine(SR, ph, 1000, 0.5);
    for (let i = 0; i < 40; i++) {
      decoders[0].sine(BLOCK, ph, 1000, 0.5);
      read(1);
    }
    // After the fade-in: compare against the best-fitting sine. The servo
    // may play a few ppm fast or slow, so the frequency is fitted too.
    const x = out.l.slice(out.l.length - 4096);
    const fit = (ppm: number) => {
      const w = (2 * Math.PI * 1000 * (1 + ppm / 1e6)) / SR;
      // Least squares for v ≈ p·sin + q·cos (exact for any window length).
      let ss = 0;
      let cc = 0;
      let sc = 0;
      let vs = 0;
      let vc = 0;
      x.forEach((v, n) => {
        const si = Math.sin(w * n);
        const co = Math.cos(w * n);
        ss += si * si;
        cc += co * co;
        sc += si * co;
        vs += v * si;
        vc += v * co;
      });
      const det = ss * cc - sc * sc;
      const p = (vs * cc - vc * sc) / det;
      const q = (vc * ss - vs * sc) / det;
      let err = 0;
      x.forEach((v, n) => (err += (v - p * Math.sin(w * n) - q * Math.cos(w * n)) ** 2));
      const a = Math.hypot(p, q);
      return { a, snrDb: 10 * Math.log10((a * a) / 2 / (err / x.length)) };
    };
    let best = fit(0);
    for (let ppm = -600; ppm <= 600; ppm += 2) {
      const f = fit(ppm);
      if (f.snrDb > best.snrDb) best = f;
    }
    const { a, snrDb } = best;
    expect(a).toBeCloseTo(0.5, 2);
    expect(snrDb).toBeGreaterThan(70);
    sp.stop();
  });

  it('fades out when the buffer runs dry, says lost, and fades back in on its return', () => {
    const { sp, decoders, out, read } = setup(500);
    sp.start();
    const ph = { v: 0 };
    decoders[0].sine(SR / 2, ph);
    for (let i = 0; i < 50; i++) {
      decoders[0].sine(BLOCK, ph);
      read(1);
    }
    // The stream stops delivering (10 s); the buffer plays out, then silence.
    read(Math.round((10 * SR) / BLOCK));
    expect(out.events).toEqual(['lost']);
    expect(sp.status().state).toBe('gone');
    expect(sp.status().goneSinceMs).not.toBeNull();
    // It comes back.
    decoders[0].sine(SR / 2, ph);
    for (let i = 0; i < 120; i++) {
      decoders[0].sine(BLOCK, ph);
      read(1);
    }
    expect(out.events).toEqual(['lost', 'back']);
    expect(sp.status().state).toBe('playing');
    // 440 Hz at 0.5 moves at most ~0.029 per sample; a cut would jump ~0.5.
    expect(maxJump(out.l, 20 * BLOCK)).toBeLessThan(0.035);
    sp.stop();
  });

  it('reconnects with back-off and says why the connection ended', () => {
    jest.useFakeTimers();
    const { sp, decoders, read } = setup(500);
    sp.start();
    decoders[0].stderr.emit('data', Buffer.from('Server returned 503 Service Unavailable'));
    decoders[0].emit('close');
    expect(sp.status().reason).toBe('off');
    jest.advanceTimersByTime(999);
    expect(decoders).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(decoders).toHaveLength(2);
    decoders[1].stderr.emit('data', Buffer.from('HTTP error 403 Forbidden'));
    decoders[1].emit('close');
    expect(sp.status().reason).toBe('refused');
    jest.advanceTimersByTime(1999);
    expect(decoders).toHaveLength(2); // 2 s the second time
    jest.advanceTimersByTime(1);
    expect(decoders).toHaveLength(3);
    read(1);
    sp.stop();
    decoders[2].emit('close');
    jest.advanceTimersByTime(60_000);
    expect(decoders).toHaveLength(3); // stopped: no more attempts
  });

  it('reconnects a connection that hangs without closing', () => {
    jest.useFakeTimers();
    const { sp, decoders, advance } = setup(500);
    sp.start();
    decoders[0].sine(1000, { v: 0 });
    advance(6000);
    jest.advanceTimersByTime(1000); // the watchdog sees the stall
    expect(decoders[0].killed).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(decoders).toHaveLength(2);
    sp.stop();
  });

  it('does not end a fresh attempt for the silence of the last connection', () => {
    jest.useFakeTimers();
    const { sp, decoders, advance } = setup(500);
    sp.start();
    decoders[0].sine(1000, { v: 0 });
    // ffmpeg's words for a 503: the sender's stream is off.
    decoders[0].stderr.emit('data', Buffer.from('Server returned 5XX Server Error reply'));
    decoders[0].emit('close');
    expect(sp.status().reason).toBe('off');
    advance(4000);
    jest.advanceTimersByTime(1000); // the retry starts
    expect(decoders).toHaveLength(2);
    advance(2000); // 6 s since the last data, 2 s into the new attempt
    jest.advanceTimersByTime(1000);
    expect(decoders[1].killed).toBe(false);
    advance(4000); // the new attempt itself hangs
    jest.advanceTimersByTime(1000);
    expect(decoders[1].killed).toBe(true);
    sp.stop();
  });

  it('skips a burst that would push it far behind, without a click', () => {
    const { sp, decoders, out, read } = setup(500);
    sp.start();
    const ph = { v: 0 };
    decoders[0].sine(SR / 2, ph);
    for (let i = 0; i < 30; i++) {
      decoders[0].sine(BLOCK, ph);
      read(1);
    }
    decoders[0].sine(5 * SR, ph); // 5 s at once
    read(3);
    expect(sp.status().bufferMs).toBeLessThan(700);
    expect(maxJump(out.l, 10 * BLOCK)).toBeLessThan(0.035);
    sp.stop();
  });
});

describe('FillServo', () => {
  it('holds the buffer against a 0.01 % clock difference over three hours', () => {
    // Model: the sender delivers 1.0001 s of audio per second of our clock;
    // we consume `ratio` s per second. One step per 1024-sample block.
    const target = 2;
    const servo = new FillServo(target);
    const dt = BLOCK / SR;
    let fill = target;
    let lo = fill;
    let hi = fill;
    let jitter = 0;
    for (let t = 0; t < 3 * 3600; t += dt) {
      // Network chunks: the fill seen at a block wobbles by ±50 ms.
      jitter = 0.05 * Math.sin(t * 7.3) * Math.sin(t * 0.37);
      const ratio = servo.update(fill + jitter, dt);
      fill += (1.0001 - ratio) * dt;
      lo = Math.min(lo, fill);
      hi = Math.max(hi, fill);
    }
    expect(hi - target).toBeLessThan(0.5);
    expect(target - lo).toBeLessThan(0.5);
    expect(lo).toBeGreaterThan(1);
  });

  it('never steps outside ±500 ppm', () => {
    const servo = new FillServo(2);
    expect(servo.update(30, 1)).toBeCloseTo(1.0005, 9);
    servo.reset();
    expect(servo.update(0, 1)).toBeCloseTo(0.9995, 9);
  });
});

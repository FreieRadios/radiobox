import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ListenClient, ListenEncoder, ListenHub, frameSync } from '../../src/audio/listen';

const SR = 48000;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** An encoder that keeps what it was fed as floats; "MP3" out is whatever
 *  the test emits on stdout. */
class FakeEncoder extends EventEmitter implements ListenEncoder {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  fed: number[] = [];
  constructor(readonly args: string[]) {
    super();
    this.stdin.on('data', (b: Buffer) => {
      for (let i = 0; i + 3 < b.length; i += 4) this.fed.push(b.readFloatLE(i));
    });
  }
  kill(): void {
    this.killed = true;
  }
  /** Left channel of what was fed. */
  get left(): number[] {
    return this.fed.filter((_, i) => i % 2 === 0);
  }
}

class FakeClient extends EventEmitter implements ListenClient {
  got: Buffer[] = [];
  writableLength = 0;
  destroyed = false;
  write(chunk: Buffer): boolean {
    this.got.push(Buffer.from(chunk));
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

/** An MPEG-1 layer III frame header (128 kbit/s, 44.1 kHz). */
const HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

const flush = () => new Promise((r) => setImmediate(r));

function setup(over: Partial<ConstructorParameters<typeof ListenHub>[0]> = {}) {
  const encoders: FakeEncoder[] = [];
  const hub = new ListenHub({
    sampleRate: SR,
    mics: ['Host', 'Gast'],
    log: quiet,
    graceMs: 50,
    spawn: (args) => {
      const e = new FakeEncoder(args);
      encoders.push(e);
      return e;
    },
    ...over,
  });
  return { hub, encoders };
}

const FRAMES = 4800; // 100 ms
const fill = (v: number) => new Float32Array(FRAMES).fill(v);

/** Programme at 0.5/0.25 (L/R), dry Host 0.1, dry Gast 0.01. */
function room(hub: ListenHub, trims = [0, 0], blocks = 1): void {
  for (let i = 0; i < blocks; i++) {
    hub.room(fill(0.5), fill(0.25), [fill(0.1), fill(0.01)], trims, FRAMES);
  }
}

describe('ListenHub', () => {
  it('runs no encoder and does nothing while nobody listens', () => {
    const { hub, encoders } = setup();
    room(hub);
    hub.air(Buffer.alloc(FRAMES * 8));
    expect(encoders).toHaveLength(0);
    expect(hub.wantsRoom).toBe(false);
    expect(hub.wantsAir).toBe(false);
  });

  it('streams MP3 at 48 kHz stereo and refuses bad ids and sources', () => {
    const { hub, encoders } = setup();
    expect(hub.attach('ab', 'rec', new FakeClient())).toBe('bad');
    expect(hub.attach('tablet-1', 'everything', new FakeClient())).toBe('bad');
    expect(hub.attach('tablet-1', 'mic:Nobody', new FakeClient())).toBe('bad');
    expect(encoders).toHaveLength(0);
    expect(hub.attach('tablet-1', 'rec', new FakeClient())).toBe('ok');
    expect(encoders).toHaveLength(1);
    const a = encoders[0].args.join(' ');
    expect(a).toContain('-f f32le -ar 48000 -ac 2 -i pipe:0');
    expect(a).toContain('libmp3lame');
  });

  it('feeds the recording point: programme, dry sum with trims, one mic', async () => {
    const { hub, encoders } = setup();
    hub.attach('rec-1', 'rec', new FakeClient());
    hub.attach('raw-1', 'raw', new FakeClient());
    hub.attach('mic-1', 'mic:Gast', new FakeClient());
    room(hub, [0, 20], 2); // Gast trimmed +20 dB
    await flush();
    const last = (e: FakeEncoder) => e.fed.slice(-2);
    expect(last(encoders[0])[0]).toBeCloseTo(0.5, 6);
    expect(last(encoders[0])[1]).toBeCloseTo(0.25, 6);
    expect(last(encoders[1])[0]).toBeCloseTo(0.1 + 0.1, 6); // mono on both
    expect(last(encoders[1])[1]).toBeCloseTo(0.2, 6);
    expect(last(encoders[2])[0]).toBeCloseTo(0.1, 6);
    // Fades in at the start: no click.
    expect(encoders[0].left[0]).toBeLessThan(0.01);
  });

  it('feeds `air` only from what leaves the box', async () => {
    const { hub, encoders } = setup();
    hub.attach('air-1', 'air', new FakeClient());
    expect(hub.wantsRoom).toBe(false);
    expect(hub.wantsAir).toBe(true);
    room(hub);
    await flush();
    expect(encoders[0].fed).toHaveLength(0);
    const buf = Buffer.alloc(FRAMES * 8);
    for (let n = 0; n < FRAMES; n++) buf.writeFloatLE(0.3, 8 * n);
    hub.air(buf);
    hub.air(buf);
    await flush();
    expect(encoders[0].fed.slice(-2)[0]).toBeCloseTo(0.3, 6);
  });

  it('switches source inside the stream with a fade, never a jump', async () => {
    const { hub, encoders } = setup();
    hub.attach('tab-1', 'rec', new FakeClient());
    room(hub, [0, 0], 2);
    expect(hub.select('tab-1', 'raw')).toBe(true);
    room(hub, [0, 0], 3);
    await flush();
    const l = encoders[0].left;
    let jump = 0;
    for (let i = 1; i < l.length; i++) jump = Math.max(jump, Math.abs(l[i] - l[i - 1]));
    expect(jump).toBeLessThan(0.001); // 0.5 -> 0.11 in 20 ms steps
    expect(l[l.length - 1]).toBeCloseTo(0.11, 6);
    expect(encoders).toHaveLength(1); // the same stream
    expect(hub.select('tab-1', 'bogus')).toBe(false);
    expect(hub.select('nobody', 'rec')).toBe(false);
  });

  it('moves a listener between the room and the air feed', async () => {
    const { hub, encoders } = setup();
    hub.attach('tab-1', 'rec', new FakeClient());
    room(hub, [0, 0], 2);
    hub.select('tab-1', 'air');
    room(hub); // fades out on the room feed, then hands over
    expect(hub.wantsRoom).toBe(false);
    expect(hub.wantsAir).toBe(true);
    const buf = Buffer.alloc(FRAMES * 8);
    for (let n = 0; n < FRAMES; n++) buf.writeFloatLE(0.3, 8 * n);
    hub.air(buf);
    hub.air(buf);
    await flush();
    expect(encoders[0].left.slice(-1)[0]).toBeCloseTo(0.3, 6);
  });

  it('joins a client at a frame header and drops one that falls behind', () => {
    const { hub, encoders } = setup();
    const a = new FakeClient();
    hub.attach('tab-1', 'rec', a);
    const e = encoders[0];
    e.stdout.emit('data', Buffer.from([1, 2, 3])); // no header yet
    expect(a.got).toHaveLength(0);
    e.stdout.emit('data', Buffer.concat([Buffer.from([7, 7]), HEADER, Buffer.from([9])]));
    expect(a.got[0][0]).toBe(0xff);
    e.stdout.emit('data', Buffer.from([5]));
    expect(a.got).toHaveLength(2);
    a.writableLength = 10 * 1024 * 1024;
    e.stdout.emit('data', Buffer.from([5]));
    expect(a.destroyed).toBe(true);
  });

  it('a second request with the same id joins the running stream (Safari probes)', () => {
    const { hub, encoders } = setup();
    hub.attach('tab-1', 'rec', new FakeClient());
    hub.attach('tab-1', 'rec', new FakeClient());
    expect(encoders).toHaveLength(1);
    expect(hub.count).toBe(1);
  });

  it('ends the encoder a moment after the last client left, not before', async () => {
    const { hub, encoders } = setup();
    const a = new FakeClient();
    hub.attach('tab-1', 'rec', a);
    a.destroy();
    expect(encoders[0].killed).toBe(false);
    hub.attach('tab-1', 'rec', new FakeClient()); // the reconnect keeps it
    await new Promise((r) => setTimeout(r, 80));
    expect(encoders[0].killed).toBe(false);
    const { hub: hub2, encoders: enc2 } = setup();
    const b = new FakeClient();
    hub2.attach('tab-2', 'rec', b);
    b.destroy();
    await new Promise((r) => setTimeout(r, 80));
    expect(enc2[0].killed).toBe(true);
    expect(hub2.count).toBe(0);
  });

  it('caps the number of listeners and ends them all on stop', () => {
    const { hub, encoders } = setup({ maxListeners: 2 });
    expect(hub.attach('tab-1', 'rec', new FakeClient())).toBe('ok');
    expect(hub.attach('tab-2', 'raw', new FakeClient())).toBe('ok');
    expect(hub.attach('tab-3', 'air', new FakeClient())).toBe('full');
    hub.stopAll();
    expect(encoders.every((e) => e.killed)).toBe(true);
    expect(hub.count).toBe(0);
  });

  it('a dying encoder ends its stream', () => {
    const { hub, encoders } = setup();
    const a = new FakeClient();
    hub.attach('tab-1', 'rec', a);
    encoders[0].emit('exit');
    expect(a.destroyed).toBe(true);
    expect(hub.count).toBe(0);
  });
});

describe('frameSync', () => {
  it('finds an MPEG audio frame header and skips false syncs', () => {
    expect(frameSync(Buffer.concat([Buffer.from([0, 0xff, 0xff, 0xf0, 0]), HEADER]))).toBe(5);
    expect(frameSync(HEADER)).toBe(0);
    expect(frameSync(Buffer.from([0xff, 0xe0, 0, 0]))).toBe(-1);
  });
});

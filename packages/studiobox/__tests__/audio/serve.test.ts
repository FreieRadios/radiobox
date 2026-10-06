import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ListenClient, ListenEncoder } from '../../src/audio/listen';
import { OggPager, ProgrammeStream } from '../../src/audio/serve';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

class FakeEncoder extends EventEmitter implements ListenEncoder {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  fedBytes = 0;
  constructor(readonly args: string[]) {
    super();
    this.stdin.on('data', (b: Buffer) => (this.fedBytes += b.length));
  }
  kill(): void {
    this.killed = true;
  }
  out(b: Buffer): void {
    this.stdout.emit('data', b);
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  get bytes(): Buffer {
    return Buffer.concat(this.got);
  }
}

/** An Ogg page with one segment of `body` (CRC not checked here). */
function page(granule: number, body: string): Buffer {
  const h = Buffer.alloc(28);
  h.write('OggS', 0);
  h.writeBigInt64LE(BigInt(granule), 6);
  h[26] = 1;
  h[27] = body.length;
  return Buffer.concat([h, Buffer.from(body)]);
}

const flush = () => new Promise((r) => setImmediate(r));

function setup(over: Partial<ConstructorParameters<typeof ProgrammeStream>[0]> = {}) {
  const encoders: FakeEncoder[] = [];
  const ps = new ProgrammeStream({
    sampleRate: 48000,
    log: quiet,
    graceMs: 30,
    spawn: (args) => {
      const e = new FakeEncoder(args);
      encoders.push(e);
      return e;
    },
    ...over,
  });
  return { ps, encoders };
}

describe('ProgrammeStream', () => {
  it('runs no encoder until somebody pulls, then one per format however many', async () => {
    const { ps, encoders } = setup();
    ps.write(Buffer.alloc(800));
    expect(encoders).toHaveLength(0);
    expect(ps.attach('flac', new FakeClient())).toBe('ok');
    expect(ps.attach(undefined, new FakeClient())).toBe('ok'); // flac by default
    expect(ps.attach('mp3', new FakeClient())).toBe('ok');
    expect(ps.attach('wav', new FakeClient())).toBe('bad');
    expect(encoders).toHaveLength(2);
    expect(encoders[0].args.join(' ')).toContain('-c:a flac -sample_fmt s32');
    expect(encoders[0].args.join(' ')).toContain('-f ogg');
    expect(encoders[1].args.join(' ')).toContain('-b:a 320k');
    expect(ps.status()).toEqual({ on: true, clients: 3 });
    ps.write(Buffer.alloc(800));
    await flush();
    expect(encoders.map((e) => e.fedBytes)).toEqual([800, 800]);
  });

  it('gives a late Ogg client the header pages first, then joins at a page', () => {
    const { ps, encoders } = setup();
    const early = new FakeClient();
    ps.attach('flac', early);
    const e = encoders[0];
    const h1 = page(0, 'FLAC-info');
    const h2 = page(0, 'comments');
    const a1 = page(4800, 'audio-1');
    const a2 = page(9600, 'audio-2');
    // Pages arrive cut anywhere.
    const all = Buffer.concat([h1, h2, a1]);
    e.out(all.subarray(0, 10));
    e.out(all.subarray(10, 40));
    e.out(all.subarray(40));
    expect(early.bytes).toEqual(all);
    const late = new FakeClient();
    ps.attach('flac', late);
    e.out(Buffer.concat([a2.subarray(0, 5)]));
    expect(late.got).toHaveLength(0); // not before a whole page
    e.out(a2.subarray(5));
    expect(late.bytes).toEqual(Buffer.concat([h1, h2, a2]));
    expect(early.bytes).toEqual(Buffer.concat([h1, h2, a1, a2]));
  });

  it('starts an MP3 client at a frame header', () => {
    const { ps, encoders } = setup();
    const c = new FakeClient();
    ps.attach('mp3', c);
    encoders[0].out(Buffer.from([1, 2, 0xff, 0xfb, 0x90, 0x00, 7]));
    expect([...c.bytes]).toEqual([0xff, 0xfb, 0x90, 0x00, 7]);
  });

  it('switched off: ends every client and encoder and refuses new ones', () => {
    const { ps, encoders } = setup();
    const c = new FakeClient();
    ps.attach('flac', c);
    ps.set(false);
    expect(c.destroyed).toBe(true);
    expect(encoders[0].killed).toBe(true);
    expect(ps.status()).toEqual({ on: false, clients: 0 });
    expect(ps.attach('flac', new FakeClient())).toBe('off');
    ps.set(true);
    expect(ps.attach('flac', new FakeClient())).toBe('ok');
  });

  it('keeps the encoder for a reconnect, ends it when nobody came back', async () => {
    const { ps, encoders } = setup();
    const a = new FakeClient();
    ps.attach('flac', a);
    a.destroy();
    ps.attach('flac', new FakeClient());
    await new Promise((r) => setTimeout(r, 50));
    expect(encoders[0].killed).toBe(false);
    expect(encoders).toHaveLength(1);
    const { ps: ps2, encoders: enc2 } = setup();
    const b = new FakeClient();
    ps2.attach('mp3', b);
    b.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(enc2[0].killed).toBe(true);
  });

  it('drops a client that falls far behind, and caps the clients', () => {
    const { ps, encoders } = setup({ maxClients: 2 });
    const slow = new FakeClient();
    ps.attach('mp3', slow);
    ps.attach('mp3', new FakeClient());
    expect(ps.attach('flac', new FakeClient())).toBe('full');
    slow.writableLength = 64 * 1024 * 1024;
    encoders[0].out(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    expect(slow.destroyed).toBe(true);
    expect(ps.status().clients).toBe(1);
  });

  it('a dying encoder ends its clients (the box at the desk reconnects)', () => {
    const { ps, encoders } = setup();
    const c = new FakeClient();
    ps.attach('flac', c);
    encoders[0].emit('exit');
    expect(c.destroyed).toBe(true);
    expect(ps.status().clients).toBe(0);
  });
});

describe('OggPager', () => {
  it('splits whole pages and skips garbage in front of them', () => {
    const pager = new OggPager();
    const p1 = page(0, 'a');
    const p2 = page(10, 'bcd');
    expect(pager.push(Buffer.concat([Buffer.from('xx'), p1, p2.subarray(0, 3)]))).toEqual([p1]);
    expect(pager.push(p2.subarray(3))).toEqual([p2]);
  });
});

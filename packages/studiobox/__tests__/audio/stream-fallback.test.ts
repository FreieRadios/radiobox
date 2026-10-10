import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { FileDirs } from '../../src/audio/file-dirs';
import { FilePlayer } from '../../src/audio/file-player';
import { BedDeck, BedPlayer } from '../../src/audio/bed';
import { StreamFallback, setupStreams } from '../../src/audio/stream-fallback';
import { StreamDecoder } from '../../src/audio/stream-player';
import { StreamSourceConfig } from '../../src/config/schema';

const SR = 48000;
const BLOCK = 1024;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const streams: StreamSourceConfig[] = [
  {
    label: 'Studio',
    url: 'http://studio-pc:4445/stream?format=flac&k=SECRET',
    bufferMs: 500,
    fallback: 'bed',
    autoStart: true,
  },
  { label: 'Still', url: 'http://x/y', bufferMs: 500, fallback: 'silence', autoStart: false },
];

function dirs(): FileDirs {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-streams-'));
  fs.writeFileSync(path.join(d, 'bett.flac'), '');
  return new FileDirs(
    [{ path: d, label: 'Bett', hasScheduled: false, hideEmpty: false, icon: '🛏' }],
    quiet,
    streams
  );
}

describe('FileDirs: the "Streams" folder', () => {
  it('lists the streams as one more folder and never shows a URL', async () => {
    const fd = dirs();
    expect(fd.folders().map((f) => f.label)).toEqual(['Bett', 'Streams']);
    expect(fd.streamsFolder).toBe(1);
    const rows = await fd.list(1);
    expect(rows).toEqual([
      { name: 'Studio', playAtMs: null, stream: true },
      { name: 'Still', playAtMs: null, stream: true },
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(fd.entries(1, 'sub')).toEqual([]);
    const token = fd.resolve(1, 'Studio')!;
    expect(token).toBe('stream:0');
    expect(fd.resolve(1, 'Nope')).toBeNull();
    expect(fd.streamOf(token)?.url).toContain('SECRET');
    expect(fd.displayName(token)).toBe('Studio');
    expect(fd.locate(token)).toEqual({ folder: 1, name: 'Studio' });
    expect(fd.scheduled()).toEqual([]);
    // Files still resolve as before.
    expect(fd.displayName(fd.resolve(0, 'bett.flac')!)).toBe('bett.flac');
  });

  it('has no extra folder without streams', () => {
    const fd = new FileDirs([], quiet);
    expect(fd.folders()).toEqual([]);
    expect(fd.streamsFolder).toBe(-1);
  });
});

/** A fake ffmpeg for the stream: emits a sine on demand. */
class FakeDecoder extends EventEmitter implements StreamDecoder {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): void {
    this.emit('close');
  }
  sine(frames: number, ph: { v: number }): void {
    const b = Buffer.alloc(frames * 8);
    for (let n = 0; n < frames; n++) {
      const v = 0.4 * Math.sin(ph.v);
      ph.v += (2 * Math.PI * 440) / SR;
      b.writeFloatLE(v, 8 * n);
      b.writeFloatLE(v, 8 * n + 4);
    }
    this.stdout.emit('data', b);
  }
}

/** A bed player with real linear fades over a 220 Hz tone. */
class FakeBed extends EventEmitter implements BedPlayer {
  playing: string | null = null;
  private g = 0;
  private step = 0;
  private ph = 0;
  play(file: string, opts: { fadeInMs?: number } = {}): void {
    this.playing = file;
    this.g = 0;
    this.step = 1 / (((opts.fadeInMs ?? 10) / 1000) * SR);
  }
  fadeOut(ms: number): void {
    this.step = -1 / ((ms / 1000) * SR);
  }
  read(l: Float32Array, r: Float32Array, frames: number): void {
    for (let n = 0; n < frames; n++) {
      this.g = Math.min(1, Math.max(0, this.g + this.step));
      l[n] = r[n] = 0.3 * this.g * Math.sin(this.ph);
      this.ph += (2 * Math.PI * 220) / SR;
    }
    if (this.step < 0 && this.g === 0) {
      this.playing = null;
      this.emit('ended');
    }
  }
}

describe('A stream with the bed as fallback (roadmap M1c.2)', () => {
  it('drops for 10 s and comes back: the bed in between, never a click', () => {
    const fd = dirs();
    let now = 1_000_000;
    const decoders: FakeDecoder[] = [];
    const player = new FilePlayer(SR, quiet);
    const bedPlayer = new FakeBed();
    const bed = new BedDeck(
      bedPlayer,
      fd,
      {
        enabled: true,
        dir: 'Bett',
        gainDb: 0,
        fadeInMs: 1500,
        fadeOutMs: 2500,
        havarie: { enabled: false, afterSeconds: 10, belowDb: -50 },
      },
      quiet
    );
    const { autoStart } = setupStreams({
      player,
      dirs: fd,
      streams,
      bed,
      log: quiet,
      opts: {
        now: () => now,
        spawn: () => {
          const d = new FakeDecoder();
          decoders.push(d);
          return d;
        },
      },
    });
    autoStart();
    expect(player.playing).toBe('stream:0');
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    const out: number[] = [];
    const bedOn: boolean[] = [];
    const ph = { v: 0 };
    // As the playout pump does: player, then the bed on top.
    const tick = (deliver: boolean) => {
      if (deliver) decoders[0].sine(BLOCK, ph);
      now += (BLOCK / SR) * 1000;
      player.read(l, r, BLOCK);
      bed.mixInto(l, r, BLOCK);
      for (const v of l) out.push(v);
      bedOn.push(bed.on);
    };
    decoders[0].sine(SR / 2, ph);
    const blocks = (s: number) => Math.round((s * SR) / BLOCK);
    for (let i = 0; i < blocks(5); i++) tick(true);
    expect(bed.on).toBe(false);
    for (let i = 0; i < blocks(10); i++) tick(false); // gone for 10 s
    expect(bed.on).toBe(true);
    expect(player.streamStatus?.state).toBe('gone');
    decoders[0].sine(SR / 2, ph); // back, with its buffer
    for (let i = 0; i < blocks(8); i++) tick(true);
    expect(player.streamStatus?.state).toBe('playing');
    expect(bed.on).toBe(false);
    // The bed played while the stream was away ...
    const mid = Math.round(10 * SR);
    expect(Math.max(...out.slice(mid, mid + SR).map(Math.abs))).toBeGreaterThan(0.25);
    // ... and nothing jumped: 440 Hz at 0.4 plus 220 Hz at 0.3 move at most
    // ~0.032 per sample; a cut of either would jump by ~0.3.
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i] - out[i - 1]));
    expect(jump).toBeLessThan(0.04);
    expect(bedOn.lastIndexOf(true)).toBeGreaterThan(bedOn.indexOf(true));
    player.shutdown();
  });

  it('leaves a bed the host started alone, and does nothing with fallback "silence"', () => {
    const player = new EventEmitter();
    const bed = { on: true, set: jest.fn() };
    const fb = new StreamFallback(bed, quiet);
    fb.attach(player, () => 'bed');
    player.emit('streamLost');
    player.emit('streamBack');
    expect(bed.set).not.toHaveBeenCalled();
    const bed2 = { on: false, set: jest.fn((v: boolean) => (bed2.on = v)) };
    const fb2 = new StreamFallback(bed2, quiet);
    fb2.attach(player, () => 'silence');
    player.emit('streamLost');
    expect(bed2.set).not.toHaveBeenCalled();
  });

  it('turns its bed off when the stream is stopped while gone', () => {
    const player = new EventEmitter();
    const bed = { on: false, set: jest.fn((v: boolean) => (bed.on = v)) };
    new StreamFallback(bed, quiet).attach(player, () => 'bed');
    player.emit('streamLost');
    expect(bed.on).toBe(true);
    player.emit('streamEnd');
    expect(bed.on).toBe(false);
  });

  it('a stream stops like a file: faded, then "ended", and its decoder goes', () => {
    const fd = dirs();
    const decoders: FakeDecoder[] = [];
    const player = new FilePlayer(SR, quiet);
    setupStreams({
      player,
      dirs: fd,
      streams,
      bed: null,
      log: quiet,
      opts: {
        spawn: () => {
          const d = new FakeDecoder();
          decoders.push(d);
          return d;
        },
      },
    });
    const events: string[] = [];
    player.on('ended', () => events.push('ended'));
    player.on('streamEnd', () => events.push('streamEnd'));
    player.play(fd.resolve(1, 'Studio')!);
    decoders[0].sine(SR, { v: 0 });
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let i = 0; i < 20; i++) player.read(l, r, BLOCK);
    player.fadeOut(100);
    for (let i = 0; i < 10; i++) player.read(l, r, BLOCK);
    expect(events).toEqual(['streamEnd', 'ended']);
    expect(player.playing).toBeNull();
    expect(player.streamStatus).toBeNull();
  });
});

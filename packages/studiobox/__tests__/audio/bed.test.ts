import { EventEmitter } from 'node:events';
import { BedDeck, BedDirs, BedPlayer } from '../../src/audio/bed';
import { BedConfig } from '../../src/config/schema';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

class FakePlayer extends EventEmitter implements BedPlayer {
  playing: string | null = null;
  calls: string[] = [];
  play(file: string, opts: { loop?: boolean; fadeInMs?: number } = {}): void {
    this.playing = file;
    this.calls.push(`play ${file} loop=${!!opts.loop} fadeIn=${opts.fadeInMs}`);
  }
  fadeOut(ms: number): void {
    this.calls.push(`fadeOut ${ms}`);
    this.playing = null;
    this.emit('ended');
  }
  read(outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0.5, 0, frames);
    outR.fill(-0.5, 0, frames);
  }
}

const cfg: BedConfig = {
  enabled: true,
  dir: 'Audio-Bett',
  gainDb: -6,
  fadeInMs: 1500,
  fadeOutMs: 2500,
};

const dirs = (files: string[] = ['bed.flac', 'other.flac']): BedDirs => ({
  folders: () => [{ label: 'Jingles' }, { label: 'Audio-Bett' }],
  entries: (i) =>
    i === 1
      ? [
          { name: 'sub', playAtMs: null, dir: true },
          ...files.map((name) => ({ name, playAtMs: null })),
        ]
      : [],
  resolve: (i, name) =>
    i === 1 && files.includes(name)
      ? `/bed/${name}`
      : i === 0 && name === 'j.flac'
        ? '/j/j.flac'
        : null,
});

const setup = (files?: string[]) => {
  const player = new FakePlayer();
  const bed = new BedDeck(player, dirs(files), cfg, makeLog());
  return { player, bed };
};

describe('BedDeck', () => {
  it('selects the first audio file of its folder by itself', () => {
    const { bed } = setup();
    expect(bed.status()).toEqual({
      on: false,
      name: 'bed.flac',
      at: { folder: 1, name: 'bed.flac' },
    });
  });

  it('one command switches it on: looped, faded in', () => {
    const { player, bed } = setup();
    bed.set(true);
    expect(player.calls).toEqual(['play /bed/bed.flac loop=true fadeIn=1500']);
    expect(bed.status().on).toBe(true);
    bed.set(true); // already on: not restarted
    expect(player.calls.length).toBe(1);
  });

  it('fades out when switched off', () => {
    const { player, bed } = setup();
    bed.set(true);
    bed.set(false);
    expect(player.calls[1]).toBe('fadeOut 2500');
    expect(bed.status().on).toBe(false);
    bed.set(false); // already off
    expect(player.calls.length).toBe(2);
  });

  it('can be pointed at another file, switching over at once when on', () => {
    const { player, bed } = setup();
    expect(bed.select(1, 'nope.flac')).toBe(false);
    expect(bed.select(0, 'j.flac')).toBe(true);
    expect(bed.status().at).toEqual({ folder: 0, name: 'j.flac' });
    expect(player.calls).toEqual([]); // selecting alone plays nothing
    bed.set(true);
    bed.select(1, 'other.flac');
    expect(player.calls).toEqual([
      'play /j/j.flac loop=true fadeIn=1500',
      'play /bed/other.flac loop=true fadeIn=1500',
    ]);
  });

  it('reports off when the loop dies (file gone) and does not pretend otherwise', () => {
    const { player, bed } = setup();
    bed.set(true);
    player.playing = null;
    player.emit('ended');
    expect(bed.status().on).toBe(false);
  });

  it('stays off, with a status that says why, when the folder holds no audio', () => {
    const { player, bed } = setup([]);
    expect(bed.status()).toEqual({ on: false, name: null, at: null });
    bed.set(true);
    expect(player.calls).toEqual([]);
    expect(bed.on).toBe(false);
  });

  it('adds itself onto the file player block at its gain, only while playing', () => {
    const { bed } = setup();
    const l = new Float32Array(4).fill(0.1);
    const r = new Float32Array(4).fill(0.1);
    bed.mixInto(l, r, 4);
    expect(Array.from(l)).toEqual(Array.from(new Float32Array(4).fill(0.1))); // off: untouched
    bed.set(true);
    bed.mixInto(l, r, 4);
    const g = Math.pow(10, -6 / 20);
    expect(l[0]).toBeCloseTo(0.1 + 0.5 * g, 6);
    expect(r[0]).toBeCloseTo(0.1 - 0.5 * g, 6);
  });
});

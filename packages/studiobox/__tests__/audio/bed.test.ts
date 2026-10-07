import { EventEmitter } from 'node:events';
import { BedDeck, BedDirs, BedPlayer } from '../../src/audio/bed';
import { BedConfig } from '../../src/config/schema';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

class FakePlayer extends EventEmitter implements BedPlayer {
  playing: string | null = null;
  position = 0;
  duration: number | null = null;
  calls: string[] = [];
  play(file: string, opts: { loop?: boolean; fadeInMs?: number; startSec?: number } = {}): void {
    this.playing = file;
    this.calls.push(
      `play ${file} loop=${!!opts.loop} fadeIn=${opts.fadeInMs}` +
        (opts.startSec ? ` from=${opts.startSec}` : '')
    );
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
  havarie: { enabled: false, afterSeconds: 10, belowDb: -50 },
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
      havarie: false,
      havarieArmed: null,
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

  it('goes on where it was switched off (after the fade), wrapping at the end', () => {
    const { player, bed } = setup();
    bed.set(true);
    player.duration = 100;
    player.position = 30; // 30 s in; the 2.5 s fade-out plays on from there
    bed.set(false);
    bed.set(true);
    expect(player.calls.at(-1)).toBe('play /bed/bed.flac loop=true fadeIn=1500 from=32.5');
    player.position = 198.5; // looped once: 98.5 s into the file, + 2.5 s fade
    bed.set(false);
    bed.set(true);
    expect(player.calls.at(-1)).toBe('play /bed/bed.flac loop=true fadeIn=1500 from=1');
  });

  it('starts from the top when a file is chosen, its length is unknown, or the loop died', () => {
    const { player, bed } = setup();
    player.duration = 100;
    bed.set(true);
    player.position = 40;
    bed.set(false);
    bed.select(1, 'bed.flac'); // chosen (again): from the top
    bed.set(true);
    expect(player.calls.at(-1)).toBe('play /bed/bed.flac loop=true fadeIn=1500');
    player.duration = null;
    player.position = 40;
    bed.set(false);
    bed.set(true);
    expect(player.calls.at(-1)).toBe('play /bed/bed.flac loop=true fadeIn=1500');
    player.duration = 100;
    player.position = 40;
    bed.set(false);
    bed.set(true);
    player.playing = null;
    player.emit('ended'); // the decoder died, not our fade
    bed.set(true);
    expect(player.calls.at(-1)).toBe('play /bed/bed.flac loop=true fadeIn=1500');
  });

  it('stays off, with a status that says why, when the folder holds no audio', () => {
    const { player, bed } = setup([]);
    expect(bed.status()).toEqual({
      on: false,
      name: null,
      at: null,
      havarie: false,
      havarieArmed: null,
    });
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

describe('BedDeck havarie', () => {
  const BLOCK = 100; // ms
  const make = (havarie = true) => {
    const player = new FakePlayer();
    const bed = new BedDeck(
      player,
      dirs(),
      { ...cfg, havarie: { enabled: havarie, afterSeconds: 10, belowDb: -50 } },
      makeLog()
    );
    const run = (ms: number, sound: boolean, armed = true) => {
      for (let t = 0; t < ms; t += BLOCK) bed.watch(sound, armed, BLOCK);
    };
    return { player, bed, run };
  };

  it('comes on by itself after 10 s of silence and says so', () => {
    const { player, bed, run } = make();
    run(9900, false);
    expect(bed.on).toBe(false);
    run(100, false);
    expect(bed.status()).toMatchObject({ on: true, havarie: true });
    expect(player.calls).toEqual(['play /bed/bed.flac loop=true fadeIn=1500']);
  });

  it('starts counting again whenever there is sound', () => {
    const { bed, run } = make();
    run(9000, false);
    run(100, true);
    run(9000, false);
    expect(bed.on).toBe(false);
  });

  it('fades out once sound is back, but not on a click', () => {
    const { player, bed, run } = make();
    run(10000, false);
    run(100, true); // a click
    run(100, false);
    expect(bed.status().havarie).toBe(true);
    run(300, true);
    expect(bed.status()).toMatchObject({ on: false, havarie: false });
    expect(player.calls[1]).toBe('fadeOut 2500');
  });

  it('is no havarie any more once the host switches the bed', () => {
    const { player, bed, run } = make();
    run(10000, false);
    bed.set(true); // the host keeps it on: now an ordinary bed
    expect(bed.status()).toMatchObject({ on: true, havarie: false });
    run(1000, true);
    expect(bed.on).toBe(true);
    expect(player.calls).toHaveLength(1);
  });

  it('does nothing unarmed, and ends a havarie when the show ends', () => {
    const { bed, run } = make();
    run(20000, false, false);
    expect(bed.on).toBe(false);
    run(10000, false);
    expect(bed.status().havarie).toBe(true);
    run(100, false, false);
    expect(bed.status()).toMatchObject({ on: false, havarie: false });
  });

  it('can be switched off and on by the technician; off ends a running one', () => {
    const { bed, run } = make();
    expect(bed.status().havarieArmed).toBe(true);
    run(10000, false);
    expect(bed.setHavarieWatch(false)).toBe(true);
    expect(bed.status()).toMatchObject({ on: false, havarie: false, havarieArmed: false });
    run(30000, false);
    expect(bed.on).toBe(false);
    bed.setHavarieWatch(true);
    run(10000, false);
    expect(bed.status().havarie).toBe(true);
    // Not configured: no switch at all.
    const off = make(false);
    expect(off.bed.setHavarieWatch(true)).toBe(false);
    expect(off.bed.status().havarieArmed).toBe(null);
  });

  it('never fires while a bed the host started is on, or when disabled', () => {
    const { bed, run } = make();
    bed.set(true);
    run(30000, false);
    expect(bed.status().havarie).toBe(false);
    const off = make(false);
    off.run(30000, false);
    expect(off.bed.on).toBe(false);
  });
});

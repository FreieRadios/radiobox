import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FilePlayer } from '../../src/audio/file-player';

const SR = 48000;
const BLOCK = 1024;

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/** Generate a short test tone WAV via ffmpeg (skips the suite if unavailable). */
function makeToneFile(seconds: number): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')), 'tone.wav');
  const res = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}:sample_rate=${SR}`,
    file,
  ]);
  if (res.status !== 0) throw new Error('ffmpeg unavailable');
  return file;
}

describe('FilePlayer', () => {
  it('outputs silence when idle', () => {
    const fp = new FilePlayer(SR, makeLog());
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    l.fill(1);
    r.fill(1);
    fp.read(l, r, BLOCK);
    expect(fp.playing).toBeNull();
    expect(l.every((v) => v === 0)).toBe(true);
    expect(r.every((v) => v === 0)).toBe(true);
  });

  it('decodes a file to stereo audio and ends after the buffer drains', async () => {
    const file = makeToneFile(0.5); // ~0.5 s of 440 Hz
    const fp = new FilePlayer(SR, makeLog());
    const ended = new Promise<void>((resolve) => fp.once('ended', resolve));

    fp.play(file);
    expect(fp.playing).toBe(file);

    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    let sawAudio = false;

    // Pump blocks at a generous cadence until playback reports it finished.
    for (let i = 0; i < 2000 && fp.playing; i++) {
      fp.read(l, r, BLOCK);
      if (l.some((v) => v !== 0)) sawAudio = true;
      await new Promise((res) => setTimeout(res, 1));
    }

    await ended;
    expect(sawAudio).toBe(true);
    expect(fp.playing).toBeNull();

    // After ending, further reads are silent.
    fp.read(l, r, BLOCK);
    expect(l.every((v) => v === 0)).toBe(true);
  });

  it('tracks playback position and probes duration; remaining counts down', async () => {
    const file = makeToneFile(1); // ~1 s of audio
    const fp = new FilePlayer(SR, makeLog());

    expect(fp.position).toBe(0);
    expect(fp.duration).toBeNull();
    expect(fp.remaining).toBeNull();

    fp.play(file);
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);

    // Pump for a generous budget: ffmpeg's `-re` paces decode at real time, so
    // delivering real audio takes wall-clock time, and the async ffprobe needs
    // a moment to report the duration. Loop until both have happened (or we hit
    // a comfortable ceiling) so the test stays robust under parallel CPU load.
    let lastRemaining = Infinity;
    let remainingDecreased = false;
    for (let i = 0; i < 400 && fp.playing; i++) {
      fp.read(l, r, BLOCK);
      const rem = fp.remaining;
      if (rem !== null) {
        if (rem < lastRemaining) remainingDecreased = true;
        lastRemaining = rem;
      }
      if (fp.position > 0.2 && fp.duration !== null && remainingDecreased) break;
      await new Promise((res) => setTimeout(res, 5));
    }

    expect(fp.position).toBeGreaterThan(0.2);
    expect(fp.duration).not.toBeNull();
    expect(fp.duration!).toBeCloseTo(1, 0);
    expect(remainingDecreased).toBe(true);

    fp.stop();
    expect(fp.position).toBe(0);
    expect(fp.duration).toBeNull();
    expect(fp.remaining).toBeNull();
  });

  it('stop() halts playback and clears the current file', () => {
    const file = makeToneFile(0.5);
    const fp = new FilePlayer(SR, makeLog());
    fp.play(file);
    fp.stop();
    expect(fp.playing).toBeNull();
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    fp.read(l, r, BLOCK);
    expect(l.every((v) => v === 0)).toBe(true);
  });
});

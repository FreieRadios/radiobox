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

  it('prebuffers before playout: the first read is silent and position stays 0', () => {
    const file = makeToneFile(1);
    const fp = new FilePlayer(SR, makeLog());
    fp.play(file);

    // Immediately after play(), the decoder has produced little/nothing and the
    // jitter buffer is still filling, so playout is gated to silence and the
    // position has not advanced.
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    l.fill(1);
    r.fill(1);
    fp.read(l, r, BLOCK);
    expect(l.every((v) => v === 0)).toBe(true);
    expect(r.every((v) => v === 0)).toBe(true);
    expect(fp.position).toBe(0);

    fp.stop();
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

  /** Pump blocks on a fake block clock until `done()`; returns all samples. */
  async function pump(
    fp: FilePlayer,
    startMs: number,
    done: (blocks: number) => boolean,
    wait = 2
  ): Promise<Float32Array> {
    const out: number[] = [];
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let b = 0; b < 4000 && !done(b); b++) {
      fp.read(l, r, BLOCK, startMs + (b * BLOCK * 1000) / SR);
      for (let i = 0; i < BLOCK; i++) out.push(l[i]);
      await new Promise((res) => setTimeout(res, wait));
    }
    return Float32Array.from(out);
  }

  it('starts a cued file on the sample that carries its start time', async () => {
    const file = makeToneFile(1);
    const fp = new FilePlayer(SR, makeLog());
    const t0 = 1_000_000;
    const startAt = t0 + 700.5; // in the middle of a block
    fp.cue(file, startAt);
    expect(fp.cued).toEqual({ file, startAtMs: startAt });
    expect(fp.playing).toBeNull();
    // Give the decoder a moment (the pipeline cues 3 s ahead).
    await new Promise((res) => setTimeout(res, 400));

    const out = await pump(fp, t0, (b) => (b * BLOCK) / SR > 1.0);
    const first = out.findIndex((v) => v !== 0);
    const want = Math.round(((startAt - t0) * SR) / 1000);
    // A sine starts at 0: its first non-zero sample is the one after the start.
    expect(Math.abs(first - want)).toBeLessThanOrEqual(1);
    expect(fp.cued).toBeNull();
    expect(fp.playing).toBe(file);
    fp.shutdown();
  });

  it('a cued file takes over from the one that is playing, on time', async () => {
    const music = makeToneFile(3);
    const jingle = makeToneFile(1);
    const fp = new FilePlayer(SR, makeLog(), 50);
    const t0 = 2_000_000;
    fp.play(music);
    fp.cue(jingle, t0 + 600);
    await new Promise((res) => setTimeout(res, 400));
    let switchedAt = -1;
    await pump(fp, t0, (b) => {
      if (switchedAt < 0 && fp.playing === jingle) switchedAt = b;
      return (b * BLOCK) / SR > 0.9;
    });
    // The block holding t0+600 ms is block floor(0.6*48000/1024) = 28; the
    // switch is visible from the next loop iteration.
    expect(switchedAt).toBe(29);
    fp.shutdown();
  });

  it('play() and stop() leave a cue alone; shutdown() drops it', async () => {
    const file = makeToneFile(0.5);
    const fp = new FilePlayer(SR, makeLog());
    fp.cue(file, Date.now() + 60_000);
    fp.play(file);
    fp.stop();
    expect(fp.cued).not.toBeNull();
    fp.cue(file, Date.now() + 90_000); // a later cue replaces the earlier one
    expect(fp.cued!.startAtMs).toBeGreaterThan(Date.now() + 80_000);
    fp.shutdown();
    expect(fp.cued).toBeNull();
  });

  it('loops a file without ending (audio bed) until it is faded out', async () => {
    const file = makeToneFile(0.3);
    const fp = new FilePlayer(SR, makeLog(), 50);
    let ended = 0;
    fp.on('ended', () => ended++);
    fp.play(file, { loop: true, fadeInMs: 100 });
    // Three times the file's length and it is still going.
    const out = await pump(fp, 0, (b) => (b * BLOCK) / SR > 0.9, 22);
    expect(fp.playing).toBe(file);
    expect(ended).toBe(0);
    const tail = out.subarray(out.length - 4 * BLOCK);
    expect(tail.some((v) => Math.abs(v) > 0.05)).toBe(true);
    // The fade-in really ramps: the first 20 ms are far below full level.
    const first = out.findIndex((v) => v !== 0);
    const early = Math.max(...Array.from(out.subarray(first, first + 960)).map(Math.abs));
    const late = Math.max(...Array.from(tail).map(Math.abs));
    expect(early).toBeLessThan(late * 0.4);
    fp.fadeOut(50);
    await pump(fp, 0, () => !fp.playing, 22);
    expect(ended).toBe(1);
    fp.shutdown();
  });
});

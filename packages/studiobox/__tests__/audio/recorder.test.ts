import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Recorder, stamp } from '../../src/audio/recorder';
import { BackupConfig, CaptureConfig } from '../../src/config/schema';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

const CAPTURE: CaptureConfig = {
  backend: 'alsa',
  device: 'null',
  sampleRate: 48000,
  channels: 2,
  blockSize: 1024,
};

/** Build a few blocks of stereo float silence (one DSP block worth). */
function block(frames: number): Buffer {
  return Buffer.alloc(frames * 2 * 4); // stereo f32le
}

describe('Recorder', () => {
  it('is inactive until started and reports active while running', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const backup: BackupConfig = { enabled: true, dir, segmentSeconds: 3600 };
    const rec = new Recorder(backup, CAPTURE, makeLog());
    expect(rec.active).toBe(false);
    rec.start();
    expect(rec.active).toBe(true);
    rec.stop();
    expect(rec.active).toBe(false);
  });

  it('accepts written blocks while active and emits exit on stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const backup: BackupConfig = { enabled: true, dir, segmentSeconds: 3600 };
    const rec = new Recorder(backup, CAPTURE, makeLog());

    rec.start();
    // Feed ~1 s of silence; at least one write should be accepted while
    // recording. The generous window keeps this robust when the suite runs in
    // parallel and ffmpeg is slow to become ready under CPU contention.
    let accepted = false;
    for (let i = 0; i < 100 && !accepted; i++) {
      if (rec.write(block(CAPTURE.blockSize)) !== false) accepted = true;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(accepted).toBe(true);

    const exited = new Promise<void>((resolve) => rec.once('exit', () => resolve()));
    rec.stop();
    await exited;
    expect(rec.active).toBe(false);
  });

  it('write() returns false when not recording', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const backup: BackupConfig = { enabled: true, dir, segmentSeconds: 3600 };
    const rec = new Recorder(backup, CAPTURE, makeLog());
    expect(rec.write(block(CAPTURE.blockSize))).toBe(false);
  });
});

/** ffprobe a file into { stream, tags }. */
function probe(file: string): { stream: Record<string, string>; tags: Record<string, string> } {
  const res = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=channels,sample_rate,bits_per_raw_sample,duration:format_tags',
    '-of',
    'json',
    file,
  ]);
  const j = JSON.parse(res.stdout.toString());
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(j.format?.tags ?? {})) tags[k.toUpperCase()] = String(v);
  return { stream: j.streams[0], tags };
}

/** `seconds` of a 440 Hz tone on every one of `channels`, as f32le blocks. */
function toneBlocks(channels: number, seconds: number): Buffer[] {
  const blocks: Buffer[] = [];
  const total = Math.round(seconds * 48000);
  for (let o = 0; o < total; o += 1024) {
    const n = Math.min(1024, total - o);
    const b = Buffer.alloc(n * channels * 4);
    for (let i = 0; i < n; i++) {
      const v = 0.25 * Math.sin((2 * Math.PI * 440 * (o + i)) / 48000);
      for (let c = 0; c < channels; c++) b.writeFloatLE(v * (c + 1) * 0.1, (i * channels + c) * 4);
    }
    blocks.push(b);
  }
  return blocks;
}

async function record(rec: Recorder, blocks: Buffer[], start: Parameters<Recorder['start']>[0]) {
  rec.start(start);
  const file = rec.currentFile!;
  for (const b of blocks) rec.write(b);
  const exited = new Promise<void>((resolve) => rec.once('exit', () => resolve()));
  rec.stop();
  await exited;
  return file;
}

describe('Recorder: one continuous, tagged file per recording (roadmap M1.6)', () => {
  const startMs = new Date(2026, 9, 5, 19, 0, 7).getTime();

  it('names the file by the given (on-air) start time', () => {
    expect(stamp(startMs)).toBe('20261005-190007');
  });

  it('writes 24 bit / 48 kHz FLAC, keeps every block up to the stop, and tags it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const rec = new Recorder({ enabled: true, dir, segmentSeconds: 0 }, CAPTURE, makeLog());
    const file = await record(rec, toneBlocks(2, 2), {
      startMs,
      tags: {
        TITLE: 'Probe',
        DATE: '2026-10-05',
        ORGANIZATION: 'Radio Beispiel',
        COMMENT: 'processed by studiobox 0.1.0',
      },
    });
    expect(path.basename(file)).toBe('studiobox-20261005-190007.flac');
    expect(fs.readdirSync(dir)).toEqual(['studiobox-20261005-190007.flac']); // one file, no segments
    const { stream, tags } = probe(file);
    expect(stream.channels).toBe(2);
    expect(stream.sample_rate).toBe('48000');
    expect(stream.bits_per_raw_sample).toBe('24');
    // Nothing lost at the end: stop() lets ffmpeg drain its input.
    expect(Number(stream.duration)).toBeCloseTo(2, 2);
    expect(tags).toMatchObject({
      TITLE: 'Probe',
      DATE: '2026-10-05',
      ORGANIZATION: 'Radio Beispiel',
      COMMENT: 'processed by studiobox 0.1.0',
    });
  }, 20000);

  it('writes an 8-channel multitrack file beside it, same length', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const backup: BackupConfig = { enabled: true, dir, segmentSeconds: 0 };
    const stereo = new Recorder(backup, CAPTURE, makeLog());
    const multi = new Recorder(backup, CAPTURE, makeLog(), { channels: 8, suffix: '.multitrack' });
    const [a, b] = await Promise.all([
      record(stereo, toneBlocks(2, 1), { startMs }),
      record(multi, toneBlocks(8, 1), { startMs }),
    ]);
    expect(path.basename(b)).toBe('studiobox-20261005-190007.multitrack.flac');
    const pa = probe(a).stream;
    const pb = probe(b).stream;
    expect(pb.channels).toBe(8);
    expect(pb.bits_per_raw_sample).toBe('24');
    expect(Number(pb.duration)).toBeCloseTo(Number(pa.duration), 3);
  }, 20000);

  it('still rolls segments when segmentSeconds is set (safety copy)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const rec = new Recorder({ enabled: true, dir, segmentSeconds: 3600 }, CAPTURE, makeLog());
    rec.start();
    expect(rec.currentFile).toBeNull();
    for (const b of toneBlocks(2, 0.5)) rec.write(b);
    const exited = new Promise<void>((resolve) => rec.once('exit', () => resolve()));
    rec.stop();
    await exited;
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^studiobox-\d{8}-\d{6}\.flac$/);
  }, 20000);
});

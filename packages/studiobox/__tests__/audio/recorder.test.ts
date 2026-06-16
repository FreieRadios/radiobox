import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Recorder } from '../../src/audio/recorder';
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
    // Feed ~0.5 s of silence; writes should be accepted while recording.
    let accepted = false;
    for (let i = 0; i < 25; i++) {
      if (rec.write(block(CAPTURE.blockSize)) !== false) accepted = true;
      await new Promise((res) => setTimeout(res, 5));
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

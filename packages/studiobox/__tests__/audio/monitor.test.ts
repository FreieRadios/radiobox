import { spawnSync } from 'node:child_process';
import { Monitor } from '../../src/audio/monitor';
import { CaptureConfig, MonitorConfig } from '../../src/config/schema';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

const CAPTURE: CaptureConfig = {
  backend: 'alsa',
  device: 'null',
  sampleRate: 48000,
  channels: 2,
  blockSize: 1024,
};

// Play to the ALSA "null" PCM so the suite needs no real hardware.
const MONITOR: MonitorConfig = { enabled: true, backend: 'alsa', device: 'null' };

/** True when `aplay` is installed (else the spawn-based cases are skipped). */
function hasAplay(): boolean {
  try {
    return spawnSync('aplay', ['--version']).status === 0;
  } catch {
    return false;
  }
}

/** One DSP block worth of stereo float silence. */
function block(frames: number): Buffer {
  return Buffer.alloc(frames * 2 * 4); // stereo f32le
}

describe('Monitor', () => {
  it('write() returns false when not playing', () => {
    const mon = new Monitor(MONITOR, CAPTURE, makeLog());
    expect(mon.active).toBe(false);
    expect(mon.write(block(CAPTURE.blockSize))).toBe(false);
  });

  it('start() is a no-op when disabled', () => {
    const mon = new Monitor({ ...MONITOR, enabled: false }, CAPTURE, makeLog());
    mon.start();
    expect(mon.active).toBe(false);
  });

  const maybe = hasAplay() ? it : it.skip;

  maybe('is inactive until started and reports active while running', () => {
    const mon = new Monitor(MONITOR, CAPTURE, makeLog());
    expect(mon.active).toBe(false);
    mon.start();
    expect(mon.active).toBe(true);
    mon.stop();
    expect(mon.active).toBe(false);
  });

  maybe('accepts written blocks while active and emits exit on stop', async () => {
    const mon = new Monitor(MONITOR, CAPTURE, makeLog());
    mon.start();
    // Feed ~0.5 s of silence; writes should be accepted while playing.
    let accepted = false;
    for (let i = 0; i < 25; i++) {
      if (mon.write(block(CAPTURE.blockSize)) !== false) accepted = true;
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(accepted).toBe(true);

    const exited = new Promise<void>((resolve) => mon.once('exit', () => resolve()));
    mon.stop();
    await exited;
    expect(mon.active).toBe(false);
  });
});

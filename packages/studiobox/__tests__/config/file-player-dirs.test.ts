import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../src/config/load';

/** Minimal valid studiobox config; the test overrides only `filePlayer`. */
function writeConfig(filePlayer: string): { configPath: string; profilesPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
  const configPath = path.join(dir, 'studiobox.yaml');
  const profilesPath = path.join(dir, 'profiles.yaml');
  fs.writeFileSync(profilesPath, 'profiles: {}\n');
  fs.writeFileSync(
    configPath,
    [
      'capture: { backend: alsa, device: "hw:0", sampleRate: 48000, channels: 2, blockSize: 1024 }',
      'channels:',
      '  - { source: 1, role: mic, label: Host }',
      'automix: { enabled: false, members: [], responseMs: 120, floorDb: -60 }',
      'duck: { enabled: false, targets: [], thresholdDb: -40, musicPresentDb: -45, depthDb: -15, attackMs: 40, holdMs: 400, releaseMs: 600 }',
      'master: { targetLufs: -16, truePeakDb: -1, limiterLookaheadMs: 5, limiterReleaseMs: 100 }',
      'output:',
      '  harbor: { enabled: false, url: "", format: ogg-flac, contentType: application/ogg }',
      '  backup: { enabled: false, dir: "./rec", segmentSeconds: 3600 }',
      'meters: { enabled: false, port: 4445, fps: 20 }',
      filePlayer,
    ].join('\n') + '\n'
  );
  return { configPath, profilesPath };
}

describe('filePlayer dirs resolution', () => {
  it('resolves a dirs array of { path, label } entries in order', () => {
    const { configPath, profilesPath } = writeConfig(
      [
        'filePlayer:',
        '  enabled: true',
        '  dirs:',
        '    - { path: "./music", label: Music }',
        '    - { path: "./jingles", label: Jingles }',
      ].join('\n')
    );
    const cfg = loadConfig({ configPath, profilesPath });
    expect(cfg.filePlayer?.dirs).toEqual([
      { path: './music', label: 'Music' },
      { path: './jingles', label: 'Jingles' },
    ]);
  });

  it('accepts bare path strings and defaults the label to the basename', () => {
    const { configPath, profilesPath } = writeConfig(
      ['filePlayer:', '  enabled: true', '  dirs:', '    - "/srv/audio/beds/"'].join('\n')
    );
    const cfg = loadConfig({ configPath, profilesPath });
    expect(cfg.filePlayer?.dirs).toEqual([{ path: '/srv/audio/beds/', label: 'beds' }]);
  });

  it('falls back to the legacy single `dir` string', () => {
    const { configPath, profilesPath } = writeConfig(
      ['filePlayer:', '  enabled: true', '  dir: "./music"'].join('\n')
    );
    const cfg = loadConfig({ configPath, profilesPath });
    expect(cfg.filePlayer?.dirs).toEqual([{ path: './music', label: 'music' }]);
  });
});

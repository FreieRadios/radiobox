import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, streamFormat } from '../../src/config/load';

/** A minimal live config; `extra` lines are appended, `over` replaces blocks. */
function load(extra: string[] = [], over: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcfg-'));
  const configPath = path.join(dir, 'studiobox.yaml');
  const profilesPath = path.join(dir, 'profiles.yaml');
  fs.writeFileSync(profilesPath, 'profiles: {}\n');
  const blocks: Record<string, string> = {
    capture:
      'capture: { backend: alsa, device: "hw:0", sampleRate: 48000, channels: 10, blockSize: 1024 }',
    channels: [
      'channels:',
      '  - { source: 1, role: mic, label: Gast }',
      '  - { source: 2, role: mic, label: Host }',
    ].join('\n'),
    automix: 'automix: { enabled: true, members: [Gast, Host], responseMs: 120, floorDb: -60 }',
    duck: 'duck: { enabled: false, targets: [], thresholdDb: -40, musicPresentDb: -45, depthDb: -15, attackMs: 40, holdMs: 400, releaseMs: 600 }',
    master:
      'master: { targetLufs: -16, truePeakDb: -1, limiterLookaheadMs: 5, limiterReleaseMs: 100 }',
    output: 'output:\n  backup: { enabled: true, dir: "./rec" }',
    meters: 'meters: { enabled: false, port: 4445, fps: 20 }',
    ...over,
  };
  fs.writeFileSync(configPath, [...Object.values(blocks), ...extra].join('\n') + '\n');
  return { cfg: () => loadConfig({ configPath, profilesPath }), dir };
}

describe('config: buffered-design blocks and their defaults', () => {
  it('defaults to a 6 s look-ahead and a 10 s air delay', () => {
    const c = load().cfg();
    expect(c.lookahead).toEqual({ seconds: 6, gateMs: 15, mixMs: 150 });
    expect(c.airDelay).toEqual({ seconds: 10, toleranceSeconds: 1 });
  });

  it('takes both from the file and keeps them in range', () => {
    const c = load([
      'lookahead: { seconds: 0, gateMs: 0, mixMs: 0 }',
      'airDelay: { seconds: 600 }',
    ]).cfg();
    expect(c.lookahead).toEqual({ seconds: 0, gateMs: 0, mixMs: 0 });
    expect(c.airDelay.seconds).toBe(60);
  });

  it('records one continuous file unless segments are asked for', () => {
    expect(load().cfg().output.backup).toMatchObject({ enabled: true, segmentSeconds: 0 });
    const seg = load([], {
      output:
        'output:\n  backup: { enabled: true, dir: "./rec", segmentSeconds: 3600, station: "Radio Z" }',
    }).cfg();
    expect(seg.output.backup).toMatchObject({ segmentSeconds: 3600, station: 'Radio Z' });
  });

  it('fills in every output so none is ever undefined', () => {
    const o = load().cfg().output;
    expect(o.harbor.enabled).toBe(false);
    expect(o.monitor).toEqual({ enabled: false, backend: 'alsa', device: '' });
    expect(o.return).toEqual({ enabled: false, backend: 'alsa', device: '' });
    expect(o.multitrack).toEqual({ enabled: false, source: 'dry' });
  });

  it('reads the music return with its channel count, buffer and latency', () => {
    const c = load([], {
      output: [
        'output:',
        '  return: { enabled: true, backend: alsa, device: "plughw:CARD=F8", channels: 4, bufferMs: 100, latencyMs: 120 }',
      ].join('\n'),
    }).cfg();
    expect(c.output.return).toEqual({
      enabled: true,
      backend: 'alsa',
      device: 'plughw:CARD=F8',
      channels: 4,
      bufferMs: 100,
      latencyMs: 120,
    });
  });

  it('reads and bounds the level of the music return', () => {
    const level = (v: string) =>
      load([], {
        output: `output:\n  return: { enabled: true, backend: alsa, device: "hw:F8", gainDb: ${v} }`,
      }).cfg().output.return.gainDb;
    expect(level('-12')).toBe(-12);
    expect(level('-200')).toBe(-60);
    expect(level('40')).toBe(12);
  });

  it('requires a device for an enabled return', () => {
    const l = load([], { output: 'output:\n  return: { enabled: true, backend: alsa }' });
    expect(l.cfg).toThrow(/output\.return\.device is required/);
  });

  it('rejects a multitrack that does not fit into one FLAC', () => {
    const l = load([], {
      channels: [
        'channels:',
        ...[1, 2, 3, 4, 5].map((n) => `  - { source: ${n}, role: mic, label: M${n} }`),
        '  - { source: [7, 8], role: music, label: Deck }',
      ].join('\n'),
      automix: 'automix: { enabled: false, members: [] }',
      output: 'output:\n  multitrack: { enabled: true }',
    });
    expect(l.cfg).toThrow(/5 mics \+ 1 stereo sources \+ programme = 9 channels/);
  });

  it('host priority: off without a label, gentle defaults with one, validated', () => {
    expect(load().cfg().automix.priority.enabled).toBe(false);
    const on = load([], {
      automix:
        'automix: { enabled: true, members: [Gast, Host], priority: { label: Host, attenuate: [Gast] } }',
    }).cfg();
    expect(on.automix.priority).toMatchObject({ enabled: true, label: 'Host', depthDb: -8 });
    expect(on.automix.responseMs).toBe(120);
    const bad = load([], {
      automix: 'automix: { enabled: true, members: [Gast, Host], priority: { label: Moderator } }',
    });
    expect(bad.cfg).toThrow(/automix\.priority\.label: unknown channel "Moderator"/);
    const deep = load([], {
      automix:
        'automix: { enabled: true, members: [Gast, Host], priority: { label: Host, depthDb: -60 } }',
    }).cfg();
    expect(deep.automix.priority.depthDb).toBe(-24); // never a mute
  });

  it('the programme stream is off by default; the MP3 bitrate is kept sane', () => {
    expect(load().cfg().output.serve).toEqual({ enabled: false, mp3Kbps: 320 });
    const c = load([], {
      output: 'output:\n  serve: { enabled: true, mp3Kbps: 32 }',
    }).cfg();
    expect(c.output.serve).toEqual({ enabled: true, mp3Kbps: 64 });
    const t = load([], {
      meters: 'meters: { enabled: true, roles: { enabled: true, tokens: { stream: pi } } }',
    }).cfg();
    expect(t.meters.roles.tokens.stream).toBe('pi');
  });

  it('the header logo is a picture next to the config, checked at load', () => {
    const m = (logo: string) => ({
      meters: `meters: { enabled: true, logo: "${logo}", logoAlt: Radio Z }`,
    });
    const none = load().cfg().meters;
    expect(none.logo).toBeUndefined();
    expect(none.logoAlt).toBe('studiobox');
    const ok = load([], m('z.svg'));
    fs.writeFileSync(path.join(ok.dir, 'z.svg'), '<svg/>');
    expect(ok.cfg().meters).toMatchObject({ logo: path.join(ok.dir, 'z.svg'), logoAlt: 'Radio Z' });
    expect(load([], m('nowhere.svg')).cfg).toThrow(/does not exist/);
    expect(load([], m('z.gif')).cfg).toThrow(/not an \.svg/);
  });

  it('roles are off by default; tokens can be fixed', () => {
    expect(load().cfg().meters.roles).toEqual({ enabled: false, tokens: {} });
    const c = load([], {
      meters:
        'meters: { enabled: true, port: 4445, fps: 20, roles: { enabled: true, tokens: { host: abc } } }',
    }).cfg();
    expect(c.meters.roles).toEqual({ enabled: true, tokens: { host: 'abc' } });
  });

  it('the bed needs a folder that exists among the dirs', () => {
    const fp = (bed: string) => [
      'filePlayer:',
      '  enabled: true',
      '  dirs:',
      '    - { path: "./bed", label: Bett }',
      `  bed: ${bed}`,
    ];
    expect(load(fp('{ dir: Bett }')).cfg().filePlayer!.bed).toEqual({
      enabled: true,
      dir: 'Bett',
      gainDb: -6,
      fadeInMs: 1500,
      fadeOutMs: 2500,
    });
    expect(load(['filePlayer:', '  enabled: true']).cfg().filePlayer!.bed.enabled).toBe(false);
    expect(load(fp('{ dir: Nirgends }')).cfg).toThrow(/filePlayer\.bed\.dir/);
  });

  it('streams: http(s) only, unique labels, one autoStart, defaults filled in', () => {
    const fp = (...streams: string[]) => [
      'filePlayer:',
      '  enabled: true',
      '  streams:',
      ...streams.map((s) => `    - ${s}`),
    ];
    expect(load(['filePlayer:', '  enabled: true']).cfg().filePlayer!.streams).toEqual([]);
    expect(
      load(fp('{ label: Studio, url: "http://maik:4445/stream?format=flac&k=S" }')).cfg()
        .filePlayer!.streams
    ).toEqual([
      {
        label: 'Studio',
        url: 'http://maik:4445/stream?format=flac&k=S',
        bufferMs: 2000,
        fallback: 'bed',
        autoStart: false,
        format: 'ogg', // a studiobox /stream?format=flac is Ogg/FLAC
      },
    ]);
    const s = load(
      fp('{ label: A, url: "https://x/a", bufferMs: 100, fallback: silence, autoStart: true }')
    ).cfg().filePlayer!.streams[0];
    expect(s).toMatchObject({ bufferMs: 500, fallback: 'silence', autoStart: true });
    expect(load(fp('{ label: A, url: "file:///etc/passwd" }')).cfg).toThrow(/http\(s\) url/);
    expect(
      load(fp('{ label: A, url: "http://x/a" }', '{ label: A, url: "http://x/b" }')).cfg
    ).toThrow(/used twice/);
    expect(
      load(
        fp(
          '{ label: A, url: "http://x/a", autoStart: true }',
          '{ label: B, url: "http://x/b", autoStart: true }'
        )
      ).cfg
    ).toThrow(/only one stream/);
  });

  it('streams: the container is named, or taken from the URL', () => {
    expect(streamFormat(undefined, 'http://maik:4445/stream?format=flac&k=S')).toBe('ogg');
    expect(streamFormat(undefined, 'http://maik:4445/stream?k=S')).toBe('ogg');
    expect(streamFormat(undefined, 'http://maik:4445/stream?format=mp3&k=S')).toBe('mp3');
    expect(streamFormat(undefined, 'https://streaming.fueralle.org/corax_192.mp3')).toBe('mp3');
    expect(streamFormat(undefined, 'https://x/live.ogg')).toBe('ogg');
    expect(streamFormat(undefined, 'https://stream.rdl.de/rdl')).toBeUndefined(); // ffmpeg probes
    expect(streamFormat('mp3', 'https://stream.rdl.de/rdl')).toBe('mp3');
    expect(() => streamFormat('wav', 'http://x/y', 'A')).toThrow(/format must be one of/);
  });

  it('keeps the live state next to the config file unless told otherwise', () => {
    const a = load();
    expect(a.cfg().stateFile).toBe(path.join(a.dir, 'session-state.json'));
    const b = load(['stateFile: state/live.json']);
    expect(b.cfg().stateFile).toBe(path.join(b.dir, 'state', 'live.json'));
  });
});

import {
  Env,
  cardOfDevice,
  formatDoctor,
  parseCards,
  parseMixerDb,
  parseOwner,
  parseStreamChannels,
  runDoctor,
} from '../src/doctor';
import { StudioboxConfig } from '../src/config/schema';
import { bypass, config, mic } from '../test-support/config';

const CARDS = ` 0 [HDMI           ]: HDA-Intel - HDA ATI HDMI
                      HDA ATI HDMI at 0xfcd20000 irq 113
 3 [F8             ]: USB-Audio - FLOW 8
                      Behringer FLOW 8 at usb-0000:0e:00.3-2, high speed
 4 [USB            ]: USB-Audio - MAYA22 USB
                      ESI Audiotechnik GmbH MAYA22 USB at usb-0000:02:00.0-9, full speed
`;

const F8_STREAM = `Behringer FLOW 8 at usb-0000:0e:00.3-2, high speed : USB Audio

Playback:
  Status: Stop
  Interface 1
    Altset 1
    Format: S32_LE
    Channels: 4
    Rates: 48000

Capture:
  Status: Stop
  Interface 2
    Altset 1
    Format: S32_LE
    Channels: 10
    Rates: 48000
`;

const MAYA_STREAM = `ESI MAYA22 : USB Audio

Playback:
  Status: Stop
  Interface 1
    Altset 1
    Channels: 2

Capture:
  Status: Stop
  Interface 2
    Altset 1
    Channels: 2
`;

const amixer = (db: string) => `Simple mixer control 'PCM',0
  Limits: Playback 0 - 110
  Front Left: Playback 63 [57%] [${db}dB] [on]
  Front Right: Playback 63 [57%] [${db}dB] [on]
`;

/** The session rig with everything in order; tests break one thing at a time. */
function env(
  over: Partial<Env> & { files?: Record<string, string | null>; mixerDb?: string } = {}
): Env {
  const files: Record<string, string | null> = {
    '/proc/asound/cards': CARDS,
    '/proc/asound/card3/stream0': F8_STREAM,
    '/proc/asound/card4/stream0': MAYA_STREAM,
    '/proc/asound/card3/pcm0c/sub0/status': 'closed\n',
    '/proc/asound/card3/pcm0p/sub0/status': 'closed\n',
    '/proc/asound/card4/pcm0p/sub0/status': 'closed\n',
    ...over.files,
  };
  return {
    read: (f) => files[f] ?? null,
    run: (cmd, args) => {
      if (cmd === 'amixer') return { status: 0, stdout: amixer(over.mixerDb ?? '0.00') };
      if (cmd === 'timedatectl')
        return { status: 0, stdout: 'Timezone=Europe/Berlin\nNTPSynchronized=yes\n' };
      return { status: 0, stdout: `${cmd} ${args.join(' ')}` };
    },
    list: (dir) =>
      dir === '/s/jingles'
        ? ['opener-20991005-190000.flac', 'notes.txt']
        : dir === '/s/bed'
          ? ['bed.flac']
          : null,
    freeBytes: () => 300 * 1024 ** 3,
    lanAddress: () => '192.168.1.20',
    now: () => new Date(2026, 9, 5, 18, 0, 0).getTime(),
    ...over,
  };
}

function rig(over: Partial<StudioboxConfig> = {}): StudioboxConfig {
  const base = config(
    [1, 2, 3, 4].map((n) => mic(n, `M${n}`)),
    {
      lookahead: { seconds: 3, gateMs: 15, mixMs: 150 },
      airDelay: { seconds: 10, toleranceSeconds: 1 },
    }
  );
  return {
    ...base,
    capture: { ...base.capture, device: 'plughw:CARD=F8,DEV=0', channels: 10 },
    output: {
      ...base.output,
      backup: { enabled: true, dir: '/rec', segmentSeconds: 0 },
      multitrack: { enabled: true, source: 'dry' },
      monitor: { enabled: true, backend: 'alsa', device: 'plughw:CARD=USB' },
      return: { enabled: true, backend: 'alsa', device: 'plughw:CARD=F8,DEV=0', channels: 4 },
    },
    meters: { enabled: true, port: 4445, fps: 20, roles: { enabled: true, tokens: {} } },
    filePlayer: {
      enabled: true,
      dirs: [
        { path: '/s/jingles', label: 'Jingles', hasScheduled: true },
        { path: '/s/bed', label: 'Bett', hasScheduled: false },
      ],
      label: 'Zuspieler',
      ducked: true,
      fadeOutMs: 800,
      prebufferMs: 250,
      autoPlay: { enabled: true, scanSeconds: 10, graceSeconds: 30 },
      bed: { enabled: true, dir: 'Bett', gainDb: -6, fadeInMs: 1500, fadeOutMs: 2500 },
      streams: [],
      processing: bypass(),
    },
    ...over,
  };
}

const find = (checks: ReturnType<typeof runDoctor>, name: string) =>
  checks.find((c) => c.name === name);

describe('doctor: parsing', () => {
  it('reads the card list', () => {
    expect(parseCards(CARDS)).toEqual([
      { index: 0, id: 'HDMI', name: 'HDA ATI HDMI' },
      { index: 3, id: 'F8', name: 'FLOW 8' },
      { index: 4, id: 'USB', name: 'MAYA22 USB' },
    ]);
  });

  it('reads the channel counts per direction', () => {
    expect(parseStreamChannels(F8_STREAM)).toEqual({ playback: 4, capture: 10 });
  });

  it('maps every device spelling to its card', () => {
    const cards = parseCards(CARDS);
    for (const d of ['hw:CARD=F8,DEV=0', 'plughw:CARD=F8', 'plughw:F8,0', 'hw:3,0', 'plughw:3']) {
      expect(cardOfDevice(d, cards)!.id).toBe('F8');
    }
    expect(cardOfDevice('plughw:CARD=FLOW8', cards)).toBeNull();
    expect(cardOfDevice('default', cards)).toBeNull();
  });

  it('reads the holder of a PCM and the mixer level', () => {
    expect(parseOwner('state: RUNNING\nowner_pid   : 1827091\n')).toBe(1827091);
    expect(parseOwner('closed\n')).toBeNull();
    expect(parseOwner(null)).toBeNull();
    expect(parseMixerDb(amixer('-23.50'))).toEqual([-23.5, -23.5]);
  });
});

describe('doctor: checks', () => {
  it('passes a rig that is in order', () => {
    const checks = runDoctor(rig(), env());
    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    const { text, code } = formatDoctor(checks);
    expect(code).toBe(0);
    expect(text).toMatch(/Ready\.$/);
    expect(find(checks, 'capture')!.detail).toBe('FLOW 8 (card F8), 10 capture channels');
    expect(find(checks, 'folder Jingles')!.detail).toMatch(
      /1 audio file\(s\).*next scheduled: opener-20991005-190000\.flac/
    );
    expect(find(checks, 'network')!.detail).toMatch(/http:\/\/192\.168\.1\.20:4445/);
    expect(find(checks, 'disk')!.detail).toMatch(/300 GB free/);
  });

  it('names the cards that are there when the configured one is not', () => {
    const c = runDoctor(rig({ capture: { ...rig().capture, device: 'plughw:CARD=FLOW8' } }), env());
    const cap = find(c, 'capture')!;
    expect(cap.status).toBe('fail');
    expect(cap.fix).toMatch(/F8 \(FLOW 8\)/);
    expect(formatDoctor(c).code).toBe(1);
  });

  it('catches a channel count the card does not have', () => {
    const c = runDoctor(rig({ capture: { ...rig().capture, channels: 12 } }), env());
    expect(find(c, 'capture')).toMatchObject({
      status: 'fail',
      detail: 'FLOW 8 offers 10 capture channels, the config asks for 12',
    });
  });

  it('says who holds a busy device and what to do', () => {
    const busy = env({
      files: {
        '/proc/asound/card3/pcm0c/sub0/status': 'state: RUNNING\nowner_pid   : 4711\n',
        '/proc/4711/comm': 'pipewire\n',
      },
    });
    const b = find(runDoctor(rig(), busy), 'capture: busy')!;
    expect(b).toMatchObject({ status: 'fail', detail: 'held by pipewire (pid 4711)' });
    expect(b.fix).toMatch(/profile to "Off"/);
    const other = env({
      files: {
        '/proc/asound/card4/pcm0p/sub0/status': 'state: RUNNING\nowner_pid   : 99\n',
        '/proc/99/comm': 'aplay\n',
      },
    });
    expect(find(runDoctor(rig(), other), 'programme output: busy')!.fix).toMatch(
      /another studiobox/
    );
  });

  it('warns when the output card is turned down', () => {
    const c = find(runDoctor(rig(), env({ mixerDb: '-23.50' })), 'programme output: level')!;
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/-23\.5 dB/);
    expect(c.fix).toBe('amixer -c USB sset PCM 0dB');
  });

  it('warns about a raw hw device, a missing folder, an empty bed, an unsynchronised clock', () => {
    const e = env({
      list: (dir) => (dir === '/s/bed' ? [] : null),
      run: (cmd) =>
        cmd === 'timedatectl'
          ? { status: 0, stdout: 'Timezone=Europe/Berlin\nNTPSynchronized=no\n' }
          : { status: 0, stdout: amixer('0.00') },
    });
    const cfg = rig();
    cfg.output.monitor.device = 'hw:CARD=USB';
    const c = runDoctor(cfg, e);
    expect(find(c, 'programme output: format')!.fix).toBe(
      'use plughw:CARD=USB so ALSA converts the format'
    );
    expect(find(c, 'folder Jingles')!.status).toBe('fail');
    expect(find(c, 'folder Bett')).toMatchObject({ status: 'warn' });
    expect(find(c, 'clock')!.status).toBe('warn');
    expect(find(c, 'time zone')!.detail).toMatch(/^Europe\/Berlin/);
  });

  it('warns when the room would not hear the music, or hear it from another clock', () => {
    const off = rig();
    off.output.return.enabled = false;
    expect(find(runDoctor(off, env()), 'music return')!.status).toBe('warn');
    const wrong = rig();
    wrong.output.return = { enabled: true, backend: 'alsa', device: 'plughw:CARD=USB' };
    expect(find(runDoctor(wrong, env()), 'music return: clock')!.detail).toMatch(/two clocks/);
  });

  it('warns about open commands on a shared network, a full disk, a missing tool', () => {
    const open = rig();
    open.meters.roles.enabled = false;
    expect(find(runDoctor(open, env()), 'roles')!.status).toBe('warn');
    expect(find(runDoctor(rig(), env({ freeBytes: () => 2 * 1024 ** 3 })), 'disk')!.status).toBe(
      'warn'
    );
    const noTool = env({ run: (cmd) => (cmd === 'arecord' ? null : { status: 0, stdout: '' }) });
    expect(find(runDoctor(rig(), noTool), 'tool arecord')).toMatchObject({
      status: 'fail',
      fix: 'sudo apt install alsa-utils',
    });
    expect(find(runDoctor(rig(), env({ lanAddress: () => null })), 'network')!.status).toBe('fail');
  });

  it('prints fixes under what is wrong and sums up', () => {
    const { text, code } = formatDoctor(runDoctor(rig(), env({ mixerDb: '-23.50' })));
    expect(code).toBe(0);
    expect(text).toMatch(/\[WARN\] programme output: level: .*\n\s+-> amixer -c USB sset PCM 0dB/);
    expect(text).toMatch(/Ready, with 1 warning\(s\) to look at\.$/);
  });

  it('checks a playout box without asking for capture or a return', () => {
    const c = runDoctor({ ...rig(), mode: 'playout' }, env());
    expect(c.some((x) => x.name.startsWith('capture'))).toBe(false);
    expect(c.some((x) => x.name.startsWith('music return'))).toBe(false);
    expect(c.some((x) => x.name === 'tool arecord')).toBe(false);
    expect(find(c, 'programme output')!.status).toBe('ok');
  });
});

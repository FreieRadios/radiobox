import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MonitorConfig, StudioboxConfig } from './config/schema';
import { AUDIO_EXTENSIONS } from './audio/file-player';
import { outputLatencyMs } from './audio/monitor';
import { parsePlayAtMs } from './schedule';
import { pickLanAddress } from './util/lan';

/**
 * `studiobox doctor` — the preflight: everything that has to be true before a
 * session, checked in a few seconds and reported with what to do about it.
 * Tools, sound cards and their channel counts, who holds a device, the output
 * level, folders, clock and time zone, disk space, the address the tablets
 * open.
 *
 * The checks are pure functions over an `Env` (files, commands, disk), so
 * they are tested against canned system output; `systemEnv()` is the real one.
 */

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: Status;
  detail: string;
  /** What to do about a warn/fail. */
  fix?: string;
}

/** The system as the doctor sees it. */
export interface Env {
  /** File contents, or null when it can't be read. */
  read(file: string): string | null;
  /** Run a command; null when it can't be started. */
  run(cmd: string, args: string[]): { status: number; stdout: string } | null;
  /** Names in a directory, or null when it doesn't exist / can't be listed. */
  list(dir: string): string[] | null;
  /** Free bytes on the filesystem holding `dir` (or its nearest existing parent). */
  freeBytes(dir: string): number | null;
  /** First non-internal IPv4 address, or null. */
  lanAddress(): string | null;
  now(): number;
}

export function systemEnv(): Env {
  return {
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
      if (r.error) return null;
      return { status: r.status ?? 1, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    },
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return null;
      }
    },
    freeBytes: (dir) => {
      let d = path.resolve(dir);
      for (;;) {
        try {
          const s = fs.statfsSync(d);
          return s.bavail * s.bsize;
        } catch {
          const up = path.dirname(d);
          if (up === d) return null;
          d = up;
        }
      }
    },
    lanAddress: () => pickLanAddress(),
    now: () => Date.now(),
  };
}

// ------------------------------------------------------------------ parsing

export interface Card {
  index: number;
  id: string;
  name: string;
}

/** Parse /proc/asound/cards (` 3 [F8             ]: USB-Audio - FLOW 8`). */
export function parseCards(text: string): Card[] {
  const out: Card[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+\[(\S+)\s*\]:\s*\S+\s+-\s+(.*)$/.exec(line);
    if (m) out.push({ index: Number(m[1]), id: m[2], name: m[3].trim() });
  }
  return out;
}

/** Channel counts a USB card offers, from /proc/asound/cardN/stream0. */
export function parseStreamChannels(text: string): { playback: number; capture: number } {
  const out = { playback: 0, capture: 0 };
  let dir: 'playback' | 'capture' | null = null;
  for (const line of text.split('\n')) {
    if (/^Playback:/.test(line)) dir = 'playback';
    else if (/^Capture:/.test(line)) dir = 'capture';
    const m = /^\s+Channels:\s*(\d+)/.exec(line);
    if (m && dir) out[dir] = Math.max(out[dir], Number(m[1]));
  }
  return out;
}

/** The card a device string names: `hw:CARD=F8,DEV=0`, `plughw:F8`, `hw:3,0`. */
export function cardOfDevice(device: string, cards: Card[]): Card | null {
  const m = /^(?:plug)?hw:(?:CARD=)?([^,]+)/.exec(device.trim());
  if (!m) return null;
  const key = m[1];
  return cards.find((c) => c.id === key || String(c.index) === key) ?? null;
}

/** PID holding a PCM substream, from its /proc status file; null when closed. */
export function parseOwner(status: string | null): number | null {
  if (!status) return null;
  const m = /owner_pid\s*:\s*(\d+)/.exec(status);
  return m ? Number(m[1]) : null;
}

/** Playback level in dB from `amixer sget` output (`[-23.50dB]`), per channel. */
export function parseMixerDb(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/Playback\s+\d+\s+\[\d+%\]\s+\[(-?[\d.]+)dB\]/g)) {
    out.push(Number(m[1]));
  }
  return out;
}

// ------------------------------------------------------------------ checks

const GB = 1024 ** 3;

function toolChecks(cfg: StudioboxConfig, env: Env): Check[] {
  const needs: [string, string[], string][] = [
    ['ffmpeg', ['-version'], 'decodes files, encodes the recordings and the stream'],
    ['ffprobe', ['-version'], 'reads file durations'],
  ];
  const alsa =
    cfg.capture.backend === 'alsa' ||
    (cfg.output.monitor.enabled && cfg.output.monitor.backend === 'alsa') ||
    (cfg.output.return.enabled && cfg.output.return.backend === 'alsa');
  if (alsa) {
    if (cfg.mode === 'live') needs.push(['arecord', ['--version'], 'captures the mixer']);
    needs.push(['aplay', ['--version'], 'plays to the sound card']);
  }
  return needs.map(([tool, args, what]) => {
    const r = env.run(tool, args);
    return r && r.status === 0
      ? { name: `tool ${tool}`, status: 'ok' as const, detail: what }
      : {
          name: `tool ${tool}`,
          status: 'fail' as const,
          detail: `not found (${what})`,
          fix: tool.startsWith('ff') ? 'sudo apt install ffmpeg' : 'sudo apt install alsa-utils',
        };
  });
}

function deviceCheck(
  name: string,
  device: string,
  dir: 'capture' | 'playback',
  wantChannels: number,
  cards: Card[],
  env: Env
): Check[] {
  const card = cardOfDevice(device, cards);
  if (!card) {
    const known = cards.map((c) => `${c.id} (${c.name})`).join(', ') || 'none';
    return [
      {
        name,
        status: 'fail',
        detail: `"${device}" names no sound card that is plugged in`,
        fix: `cards present: ${known}. Use e.g. plughw:CARD=<id>,DEV=0`,
      },
    ];
  }
  const out: Check[] = [];
  const stream = env.read(`/proc/asound/card${card.index}/stream0`);
  const have = stream ? parseStreamChannels(stream)[dir] : 0;
  if (stream && have < wantChannels) {
    out.push({
      name,
      status: 'fail',
      detail: `${card.name} offers ${have} ${dir} channels, the config asks for ${wantChannels}`,
      fix:
        dir === 'capture'
          ? 'set capture.channels to what the card offers'
          : `set the output's channels to ${have} or less`,
    });
  } else {
    out.push({
      name,
      status: 'ok',
      detail: `${card.name} (card ${card.id})${stream ? `, ${have} ${dir} channels` : ''}`,
    });
  }
  if (!device.startsWith('plughw:')) {
    out.push({
      name: `${name}: format`,
      status: 'warn',
      detail: `"${device}" is a raw hw device; studiobox reads and writes 32-bit float`,
      fix: `use plughw:${device.replace(/^hw:/, '')} so ALSA converts the format`,
    });
  }
  const sub = dir === 'capture' ? 'pcm0c' : 'pcm0p';
  const owner = parseOwner(env.read(`/proc/asound/card${card.index}/${sub}/sub0/status`));
  if (owner !== null) {
    const who = env.read(`/proc/${owner}/comm`)?.trim() ?? 'unknown';
    out.push({
      name: `${name}: busy`,
      status: 'fail',
      detail: `held by ${who} (pid ${owner})`,
      fix: /pipewire|pulse|wireplumber/.test(who)
        ? `set the card's profile to "Off" in the desktop sound settings (pavucontrol -> Configuration)`
        : who === 'arecord' || who === 'aplay'
          ? 'another studiobox is running — stop it first'
          : `stop that process (fuser -v /dev/snd/*)`,
    });
  }
  return out;
}

function mixerCheck(name: string, m: MonitorConfig, cards: Card[], env: Env): Check[] {
  const card = cardOfDevice(m.device, cards);
  if (!card) return [];
  const r = env.run('amixer', ['-c', card.id, 'sget', 'PCM']);
  if (!r || r.status !== 0) return [];
  const db = parseMixerDb(r.stdout);
  if (!db.length) return [];
  const low = Math.min(...db);
  if (low > -0.5) return [{ name: `${name}: level`, status: 'ok', detail: 'mixer at 0 dB' }];
  return [
    {
      name: `${name}: level`,
      status: 'warn',
      detail: `the card's PCM control stands at ${low.toFixed(1)} dB — the output is that much too quiet`,
      fix: `amixer -c ${card.id} sset PCM 0dB`,
    },
  ];
}

function folderChecks(cfg: StudioboxConfig, env: Env): Check[] {
  const fp = cfg.filePlayer;
  if (!fp?.enabled) return [];
  const out: Check[] = [];
  const isAudio = (n: string) => AUDIO_EXTENSIONS.includes(path.extname(n).toLowerCase());
  for (const d of fp.dirs) {
    const names = env.list(d.path);
    if (!names) {
      out.push({
        name: `folder ${d.label}`,
        status: 'fail',
        detail: `${d.path} does not exist or can't be read`,
        fix: `mkdir -p '${d.path}' (or mount the share)`,
      });
      continue;
    }
    const audio = names.filter(isAudio);
    let detail = `${audio.length} audio file(s) in ${d.path}`;
    let status: Status = 'ok';
    if (d.hasScheduled) {
      const now = env.now();
      const upcoming = audio
        .map((n) => ({ n, at: parsePlayAtMs(n) }))
        .filter((e): e is { n: string; at: number } => e.at !== null && e.at > now)
        .sort((a, b) => a.at - b.at);
      detail += upcoming.length
        ? `; next scheduled: ${upcoming[0].n}`
        : '; no file with a future timestamp';
    }
    if (fp.bed.enabled && fp.bed.dir === d.label && !audio.length) {
      status = 'warn';
      detail += ' — the bed has nothing to play';
    }
    out.push({ name: `folder ${d.label}`, status, detail });
  }
  return out;
}

function clockChecks(env: Env): Check[] {
  const r = env.run('timedatectl', ['show', '-p', 'Timezone', '-p', 'NTPSynchronized']);
  if (!r || r.status !== 0) {
    return [
      {
        name: 'clock',
        status: 'warn',
        detail: 'timedatectl not available — check clock and time zone by hand',
      },
    ];
  }
  const tz = /Timezone=(.*)/.exec(r.stdout)?.[1]?.trim() ?? '?';
  const ntp = /NTPSynchronized=(\w+)/.exec(r.stdout)?.[1] === 'yes';
  return [
    {
      name: 'time zone',
      status: 'ok',
      detail: `${tz} — filename timestamps (YYYYMMDD-HHMMSS) and all clocks are in this zone`,
    },
    ntp
      ? { name: 'clock', status: 'ok', detail: 'synchronised (NTP)' }
      : {
          name: 'clock',
          status: 'warn',
          detail: 'not synchronised — scheduled items air by this clock',
          fix: 'timedatectl set-ntp true (needs a network with internet), or set the time by hand',
        },
  ];
}

function diskCheck(cfg: StudioboxConfig, env: Env): Check[] {
  const b = cfg.output.backup;
  if (!b.enabled) return [];
  const free = env.freeBytes(b.dir);
  if (free === null) {
    return [{ name: 'disk', status: 'warn', detail: `can't tell the free space for ${b.dir}` }];
  }
  // 24-bit FLAC, talk: about 0.5 GB/h stereo, 0.3 GB/h per further channel.
  const mics = cfg.channels.filter((c) => c.role === 'mic').length;
  const music =
    cfg.channels.filter((c) => c.role === 'music').length + (cfg.filePlayer?.enabled ? 1 : 0);
  const perHour = 0.5 + (cfg.output.multitrack.enabled ? 0.3 * (mics + 2 * music + 2) : 0);
  const hours = free / GB / perHour;
  const detail = `${(free / GB).toFixed(0)} GB free in ${b.dir} — about ${Math.floor(hours)} h of recording`;
  return [
    hours >= 4
      ? { name: 'disk', status: 'ok', detail }
      : { name: 'disk', status: 'warn', detail, fix: 'free some space: a 3 h session has to fit' },
  ];
}

function timingChecks(cfg: StudioboxConfig): Check[] {
  const look = cfg.lookahead.seconds + (cfg.lookahead.gateMs + cfg.lookahead.mixMs) / 1000;
  // The output card's buffer is part of the delay too: what is left over is
  // the FIFO that absorbs the two cards' drift and a stalled machine.
  const mon = cfg.output.monitor;
  const cardS = mon?.enabled ? outputLatencyMs(mon, cfg.capture.sampleRate, 'pull') / 1000 : 0;
  // The stream to the desk (output.serve) counts the same way: its latency
  // is spent inside the air delay. The longer path decides.
  const serve = cfg.output.serve;
  const streamS = serve?.enabled ? serve.latencyMs / 1000 : 0;
  const outS = Math.max(cardS, streamS);
  const out: Check[] = [];
  if (cfg.airDelay.seconds < look + outS + 1) {
    out.push({
      name: 'air delay',
      status: 'warn',
      detail:
        `airDelay.seconds (${cfg.airDelay.seconds}) leaves less than 1 s over the ` +
        `${look.toFixed(2)} s look-ahead` +
        (outS > 0
          ? streamS > cardS
            ? ` and the stream's ${outS.toFixed(1)} s to the desk`
            : ` and the ${outS.toFixed(1)} s output buffer`
          : ''),
      fix: 'raise airDelay.seconds or lower lookahead.seconds (10 s / 6 s is the default pair)',
    });
  } else {
    out.push({
      name: 'air delay',
      status: 'ok',
      detail: `${cfg.airDelay.seconds} s behind the room, ${look.toFixed(2)} s of it look-ahead`,
    });
  }
  return out;
}

function networkChecks(cfg: StudioboxConfig, env: Env): Check[] {
  if (!cfg.meters.enabled) return [];
  const addr = env.lanAddress();
  const out: Check[] = [];
  out.push(
    addr
      ? {
          name: 'network',
          status: 'ok',
          detail: `the tablets open http://${addr}:${cfg.meters.port} (role links are printed at start)`,
        }
      : {
          name: 'network',
          status: 'fail',
          detail: 'no network address — the tablets cannot reach this machine',
          fix: 'join the Wi-Fi',
        }
  );
  if (cfg.mode === 'live' && !cfg.meters.roles.enabled) {
    out.push({
      name: 'roles',
      status: 'warn',
      detail:
        'meters.roles is off: every device on this network can mute mics and stop the recording',
      fix: 'set meters.roles.enabled: true on a shared Wi-Fi',
    });
  }
  return out;
}

/** Run every check that applies to this config. */
export function runDoctor(cfg: StudioboxConfig, env: Env = systemEnv()): Check[] {
  const out: Check[] = [...toolChecks(cfg, env)];
  const cardsText = env.read('/proc/asound/cards');
  const cards = cardsText ? parseCards(cardsText) : [];
  const alsaOut = (m: MonitorConfig) => m.enabled && m.backend === 'alsa';

  if (cfg.mode === 'live' && cfg.capture.backend === 'alsa') {
    out.push(
      ...deviceCheck('capture', cfg.capture.device, 'capture', cfg.capture.channels, cards, env)
    );
  }
  if (alsaOut(cfg.output.monitor)) {
    const m = cfg.output.monitor;
    out.push(...deviceCheck('programme output', m.device, 'playback', m.channels ?? 2, cards, env));
    out.push(...mixerCheck('programme output', m, cards, env));
  } else if (cfg.mode === 'live' && !cfg.output.harbor?.enabled) {
    out.push({
      name: 'programme output',
      status: 'warn',
      detail:
        'neither output.monitor nor output.harbor is enabled: the programme goes nowhere but the recording',
    });
  }
  if (cfg.mode === 'live') {
    if (alsaOut(cfg.output.return)) {
      const r = cfg.output.return;
      out.push(...deviceCheck('music return', r.device, 'playback', r.channels ?? 2, cards, env));
      const cap = cardOfDevice(cfg.capture.device, cards);
      const ret = cardOfDevice(r.device, cards);
      if (cap && ret && cap.index !== ret.index) {
        out.push({
          name: 'music return: clock',
          status: 'warn',
          detail: `goes to ${ret.name}, not to the capture card (${cap.name}): two clocks, the return will slowly drift and skip`,
          fix: 'send the return to the mixer the mics come from',
        });
      }
    } else if (cfg.filePlayer?.enabled) {
      out.push({
        name: 'music return',
        status: 'warn',
        detail: 'output.return is off: the room does not hear jingles, music or the bed',
        fix: "enable output.return to the mixer's USB playback",
      });
    }
    out.push(...timingChecks(cfg));
  }
  out.push(...folderChecks(cfg, env), ...clockChecks(env), ...diskCheck(cfg, env));
  out.push(...networkChecks(cfg, env));
  return out;
}

/** Render the checks for a terminal. Returns the text and the exit code
 *  (1 when anything failed). */
export function formatDoctor(checks: Check[]): { text: string; code: number } {
  const mark: Record<Status, string> = { ok: ' ok ', warn: 'WARN', fail: 'FAIL' };
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`[${mark[c.status]}] ${c.name}: ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`       -> ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    fails
      ? `${fails} problem(s) to fix before the session${warns ? `, ${warns} warning(s)` : ''}.`
      : warns
        ? `Ready, with ${warns} warning(s) to look at.`
        : 'Ready.'
  );
  return { text: lines.join('\n'), code: fails ? 1 : 0 };
}

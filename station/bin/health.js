#!/usr/bin/env node
// The box's health at a glance, for the kiosk screen and any tablet on the
// studio WLAN: studiobox (on air, recording, stream), eve and the listeners,
// the signal, the WLAN (which card, which devices), sound cards, network
// ports, temperatures, load, memory, disk, the software, services.
//
//   health.js        (settings from the station env, see studiobox-health.service.in)
//
// Serves the page on / and the numbers on /health.json at HEALTH_PORT. Its own
// process on purpose: when studiobox is down, this is what says so. It reads
// studiobox's snapshots over the meters WebSocket like a page would and never
// sends a command. Read-only throughout. /codes.json has the WLAN's name,
// password and join QR code and the technician's link as a QR code - the same
// as the printed station card, for whoever can open this page.
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const appDir = path.resolve(__dirname, '../..');
const need = (m) => require(require.resolve(m, { paths: [appDir] }));
const yaml = need('js-yaml');
const WebSocket = need('ws');
const QRCode = need('qrcode');

const env = process.env;
const PORT = Number(env.HEALTH_PORT || 4446);
const CONFIG = env.STUDIOBOX_CONFIG || '/var/lib/studiobox/studiobox.yaml';
const RECORDINGS = env.RECORDINGS_DIR || '/var/lib/studiobox/recordings';
const AP_IF = env.AP_IFACE || '';
const AP_FALLBACK_IF = env.AP_FALLBACK_IFACE || '';
const PAGE = path.join(__dirname, 'health.html');
const TICK_MS = 3000;
/** A recording's size per hour (stereo FLAC 24 bit + multitrack), for "hours left". */
const GB_PER_HOUR = 2.9;

/** The page's version: a screen that has it open reloads when it changes
 *  (the kiosk never reloads by itself). */
const pageStamp = () => {
  try {
    return String(fs.statSync(PAGE).mtimeMs);
  } catch {
    return '';
  }
};

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
const read = (f) => fsp.readFile(f, 'utf8').catch(() => null);
const worst = (states) =>
  states.includes('fail') ? 'fail' : states.includes('warn') ? 'warn' : 'ok';
const level = (v, warn, fail) => (v >= fail ? 'fail' : v >= warn ? 'warn' : 'ok');
const de = (x, digits) => x.toFixed(digits).replace('.', ',');
/** "USB-Stick" or "eingebaut", from where the card hangs (a wlx… name is USB too). */
const cardKind = (dev) => {
  let p = '';
  try {
    p = fs.realpathSync(`/sys/class/net/${dev}/device`);
  } catch {}
  return p.includes('/usb') || dev.startsWith('wlx') ? 'USB-Stick' : 'eingebaut';
};

/** Per-second rate of a counter since the last call; null the first time. */
const prev = new Map();
function rate(key, value) {
  const now = Date.now();
  const p = prev.get(key);
  prev.set(key, { value, now });
  if (!p || now === p.now || value < p.value) return null;
  return ((value - p.value) * 1000) / (now - p.now);
}
/** Bytes per second as bit/s, German. */
const bits = (bps) => {
  const b = bps * 8;
  if (b >= 1e9) return `${de(b / 1e9, 1)} Gbit/s`;
  if (b >= 1e6) return `${de(b / 1e6, 1)} Mbit/s`;
  return `${Math.round(b / 1e3)} kbit/s`;
};
const bytes = (bps) => (bps >= 1e6 ? `${de(bps / 1e6, 1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
const hhmm = (ms) =>
  new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const httpGet = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });

// --- studiobox, over its meters WebSocket --------------------------------------

const box = { connected: false, snap: null, at: 0, config: null, listeners: null };

function studioboxConfig() {
  try {
    return yaml.load(fs.readFileSync(CONFIG, 'utf8')) || {};
  } catch {
    return {};
  }
}

/** Connect as a page would, with the technician's token (the recording state
 *  is not in the spectator's cut). Reconnects every 3 s while studiobox is
 *  away; the config is read again each time, it is rendered at every start. */
function watchStudiobox() {
  const cfg = studioboxConfig();
  box.config = cfg;
  const m = cfg.meters || {};
  const tok = m.roles && m.roles.enabled && m.roles.tokens ? m.roles.tokens.tech : '';
  const url = `ws://127.0.0.1:${m.port || 4445}/${tok ? `?k=${encodeURIComponent(tok)}` : ''}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(watchStudiobox, 3000);
    return;
  }
  ws.on('open', () => (box.connected = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // Meter frames are the bare snapshot; everything else carries a `type`.
    if (msg && !msg.type && Array.isArray(msg.channels)) {
      box.snap = msg;
      box.at = Date.now();
    } else if (msg && msg.type === 'listeners') {
      // eve's feed, only sent when `listeners` is on in studiobox's config.
      box.listeners = msg.status;
    }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    box.connected = false;
    box.listeners = null;
    setTimeout(watchStudiobox, 3000);
  });
}

// --- the machine ----------------------------------------------------------------

let lastCpu = null;
/** Underrun count seen last, and when it last went up. */
const sig = { underruns: null, lastUnderrunAt: 0 };
async function cpuUse() {
  const t = await read('/proc/stat');
  if (!t) return null;
  const v = t.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] || 0);
  const total = v.reduce((a, b) => a + b, 0);
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return null;
  return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
}

/** hwmon sensors worth showing, by driver name: label, warn, fail (°C). */
const SENSORS = {
  k10temp: ['Prozessor', 85, 95],
  amdgpu: ['Grafik', 85, 95],
  nvme: ['SSD', 65, 75],
  mt7921_phy0: ['WLAN intern', 80, 90],
};
async function temps() {
  const out = [];
  let dirs = [];
  try {
    dirs = await fsp.readdir('/sys/class/hwmon');
  } catch {
    return out;
  }
  for (const d of dirs) {
    const base = `/sys/class/hwmon/${d}`;
    const name = ((await read(`${base}/name`)) || '').trim();
    const s = SENSORS[name];
    if (!s) continue;
    // The first sensor is the one that matters (Tctl, edge, Composite).
    const v = Number(await read(`${base}/temp1_input`));
    if (!Number.isFinite(v) || v <= 0) continue;
    const c = Math.round(v / 1000);
    out.push({ label: s[0], value: `${c} °C`, state: level(c, s[1], s[2]) });
  }
  const order = Object.values(SENSORS).map((x) => x[0]);
  return out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

async function memory() {
  const t = await read('/proc/meminfo');
  if (!t) return null;
  const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t) || [])[1] || 0);
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (!total) return null;
  const used = Math.round(100 * (1 - avail / total));
  return { used, freeGb: avail / 1048576, state: level(used, 85, 95) };
}

async function disk() {
  try {
    const s = await fsp.statfs(RECORDINGS);
    const gb = (s.bavail * s.bsize) / 1e9;
    return { gb, hours: gb / GB_PER_HOUR, state: gb < 5 ? 'fail' : gb < 30 ? 'warn' : 'ok' };
  } catch {
    return null;
  }
}

/** ` 2 [F8     ]: USB-Audio - FLOW 8` → [{id, desc}] */
async function soundCards() {
  const t = (await read('/proc/asound/cards')) || '';
  const out = [];
  for (const line of t.split('\n')) {
    const m = /^\s*\d+\s+\[([^\]\s]+)\s*\]:\s*(.*)$/.exec(line);
    if (m) out.push({ id: m[1], desc: m[2].replace(/^USB-Audio - /, '') });
  }
  return out;
}
const cardOf = (dev) => (/CARD=([^,\s]+)/.exec(dev || '') || [])[1] || null;

async function wifi() {
  const act = (await run('nmcli', ['-t', '-f', 'NAME,DEVICE', 'con', 'show', '--active'])) || '';
  const ap = act
    .split('\n')
    .map((l) => l.split(':'))
    .find(([name]) => name === 'studiobox-ap' || name === 'studiobox-ap-fallback');
  if (!ap) return { up: false };
  const [name, dev] = ap;
  const info = (await run('/usr/sbin/iw', ['dev', dev, 'info'])) || '';
  const ch = /channel (\d+) \((\d+) MHz\)/.exec(info);
  const ssid = (/\tssid (.*)/.exec(info) || [])[1] || '';
  const width = (/width: (\d+) MHz/.exec(info) || [])[1];
  const dump = (await run('/usr/sbin/iw', ['dev', dev, 'station', 'dump'])) || '';
  // One block per device: its MAC, signal, rate to it, time joined.
  const stations = dump
    .split(/^(?=Station )/m)
    .filter((b) => b.startsWith('Station '))
    .map((b) => ({
      mac: (/^Station (\S+)/.exec(b) || [])[1] || '',
      signal: Number((/\tsignal:\s*(-?\d+)/.exec(b) || [])[1]),
      tx: Number((/\ttx bitrate:\s*([\d.]+)/.exec(b) || [])[1]),
      secs: Number((/\tconnected time:\s*(\d+)/.exec(b) || [])[1]),
    }));
  return {
    up: true,
    dev,
    ssid,
    band: ch ? (Number(ch[2]) > 4000 ? '5 GHz' : '2,4 GHz') : '',
    channel: ch ? Number(ch[1]) : null,
    width: width ? Number(width) : null,
    clients: stations.length,
    stations,
  };
}

/** Icecast's mounts with their listeners (status-json.xsl, no login). */
async function icecast() {
  const t = await httpGet('http://127.0.0.1:8000/status-json.xsl');
  if (!t) return null;
  try {
    const src = [].concat(JSON.parse(t).icestats.source || []);
    return src.map((x) => ({
      mount: String(x.listenurl || '').replace(/^\w+:\/\/[^/]+/, ''),
      listeners: Number(x.listeners) || 0,
      peak: Number(x.listener_peak) || 0,
    }));
  } catch {
    return null;
  }
}

/** The capture card's ALSA format while it is open ("closed" otherwise). */
async function hwParams(card) {
  if (!card) return null;
  const t = await read(`/proc/asound/${card}/pcm0c/sub0/hw_params`);
  if (!t || t.trim() === 'closed') return null;
  const v = (k) => (new RegExp(`^${k}: (\\S+)`, 'm').exec(t) || [])[1];
  return {
    format: v('format'),
    channels: Number(v('channels')),
    rate: Number(v('rate')),
    period: Number(v('period_size')),
    buffer: Number(v('buffer_size')),
  };
}

/** Ports with hardware behind them: state, link speed, addresses, traffic. */
async function ports() {
  let names = [];
  try {
    names = await fsp.readdir('/sys/class/net');
  } catch {
    return [];
  }
  const addrs = require('node:os').networkInterfaces();
  const out = [];
  for (const n of names.sort()) {
    if (!fs.existsSync(`/sys/class/net/${n}/device`)) continue; // lo, docker, veth
    const st = `/sys/class/net/${n}/statistics`;
    const rx = rate(`rx:${n}`, Number(await read(`${st}/rx_bytes`)));
    const tx = rate(`tx:${n}`, Number(await read(`${st}/tx_bytes`)));
    const speed = Number(await read(`/sys/class/net/${n}/speed`));
    out.push({
      name: n,
      up: ((await read(`/sys/class/net/${n}/operstate`)) || '').trim() === 'up',
      wifi: fs.existsSync(`/sys/class/net/${n}/wireless`),
      speed: speed > 0 ? speed : null,
      ipv4: (addrs[n] || []).filter((a) => a.family === 'IPv4').map((a) => a.address),
      rx,
      tx,
    });
  }
  return out;
}

/** The port the default route leaves by (/proc/net/route), or null. */
async function defaultRoute() {
  const t = (await read('/proc/net/route')) || '';
  const r = t.split('\n').find((l) => l.split('\t')[1] === '00000000');
  return r ? r.split('\t')[0] : null;
}

/** Disk throughput of the system's NVMe/SATA disks (sectors of 512 bytes). */
async function diskIo() {
  const t = (await read('/proc/diskstats')) || '';
  let rd = 0;
  let wr = 0;
  for (const l of t.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (!/^(nvme\d+n\d+|sd[a-z]|vd[a-z]|mmcblk\d+)$/.test(f[2] || '')) continue;
    rd += Number(f[5]) * 512;
    wr += Number(f[9]) * 512;
  }
  return { read: rate('disk:r', rd), write: rate('disk:w', wr) };
}

/** Mean clock of all cores, MHz. */
async function cpuClock() {
  const n = require('node:os').cpus().length;
  let sum = 0;
  let got = 0;
  for (let i = 0; i < n; i++) {
    const v = Number(await read(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`));
    if (v > 0) {
      sum += v;
      got++;
    }
  }
  return { cores: n, mhz: got ? sum / got / 1000 : null };
}

/** studiobox's main process: CPU (% of one core) and resident memory. */
async function proc(pid) {
  if (!pid) return null;
  const st = await read(`/proc/${pid}/stat`);
  const status = await read(`/proc/${pid}/status`);
  if (!st || !status) return null;
  // After the ")" of the name, utime and stime are the 12th and 13th field.
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  const cpu = rate(`proc:${pid}`, Number(f[11]) + Number(f[12])); // ticks/s, USER_HZ 100
  const rss = Number((/^VmRSS:\s+(\d+)/m.exec(status) || [])[1]) / 1024;
  return { cpu: cpu === null ? null : Math.round(cpu), rssMb: Math.round(rss) };
}

/** The checkout studiobox runs from; git is asked once a minute. */
let gitInfo = { at: 0, text: null, branch: null };
async function git() {
  if (Date.now() - gitInfo.at < 60000) return gitInfo;
  const [d, b] = await Promise.all([
    run('git', ['-C', appDir, 'describe', '--always', '--dirty', '--tags']),
    run('git', ['-C', appDir, 'branch', '--show-current']),
  ]);
  gitInfo = { at: Date.now(), text: d && d.trim(), branch: b && b.trim() };
  return gitInfo;
}

/** One `systemctl show` for all units: Id → {active, result, since}. */
async function units(ids) {
  const t = await run('systemctl', [
    'show',
    '--timestamp=unix',
    '-p',
    'Id,LoadState,ActiveState,SubState,Result,InactiveEnterTimestamp,MainPID',
    ...ids,
  ]);
  const out = {};
  for (const block of (t || '').split('\n\n')) {
    const kv = Object.fromEntries(
      block
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
    if (kv.Id && kv.LoadState === 'loaded') out[kv.Id] = kv;
  }
  return out;
}

const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `vor ${s} s`;
  if (s < 5400) return `vor ${Math.round(s / 60)} min`;
  return `vor ${Math.round(s / 3600)} h`;
};
const fmtUptime = (sec) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} T ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

// --- one picture ------------------------------------------------------------------

async function collect() {
  const [cpu, t, mem, dsk, cards, w, u, ntp, up, load, ice, net, route, io, clk, gi, deb] =
    await Promise.all([
      cpuUse(),
      temps(),
      memory(),
      disk(),
      soundCards(),
      wifi(),
      units([
        'studiobox.service',
        'icecast2.service',
        'nextcloud-sync.service',
        'nextcloud-sync.timer',
        'studiobox-ap-watch.service',
      ]),
      run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']),
      read('/proc/uptime'),
      read('/proc/loadavg'),
      icecast(),
      ports(),
      defaultRoute(),
      diskIo(),
      cpuClock(),
      git(),
      read('/etc/debian_version'),
    ]);
  const groups = [];
  const item = (label, value, state, detail) => ({ label, value, state, detail: detail || '' });

  // Sendung: studiobox itself.
  const sb = u['studiobox.service'];
  const fresh = box.snap && Date.now() - box.at < 5000;
  const s = fresh ? box.snap : null;
  const send = [];
  send.push(
    !sb
      ? item('studiobox', 'nicht eingerichtet', 'fail')
      : sb.ActiveState === 'active'
        ? item('studiobox', fresh ? 'läuft' : 'läuft, antwortet nicht', fresh ? 'ok' : 'fail')
        : item('studiobox', sb.ActiveState === 'activating' ? 'startet' : 'aus', 'fail')
  );
  if (s) {
    send.push(
      s.onAir === null || s.onAir === undefined
        ? item('Auf Sendung', '–', 'info')
        : item('Auf Sendung', s.onAir ? 'JA' : 'nein', s.onAir ? 'onair' : 'info')
    );
    if (s.recording !== null && s.recording !== undefined)
      send.push(item('Aufnahme', s.recording ? 'läuft' : 'aus', s.recording ? 'rec' : 'info'));
    if (s.streaming !== null && s.streaming !== undefined)
      send.push(item('Stream', s.streaming ? 'läuft' : 'aus', s.streaming ? 'ok' : 'info'));
    if (s.air) {
      const a = s.air;
      const words = {
        filling: 'Puffer füllt',
        live: 'live',
        draining: 'läuft aus',
        ended: 'beendet',
      };
      const late = a.targetMs && Math.abs(a.delayMs - a.targetMs) > 1000;
      send.push(
        item(
          'Sendeverzögerung',
          `${de(a.delayMs / 1000, 1)} s`,
          late || a.underruns ? 'warn' : 'ok',
          `${words[a.state] || a.state}${a.underruns ? ` · ${a.underruns} Aussetzer` : ''}`
        )
      );
    }
  }
  groups.push({ title: 'Sendung', items: send });

  // eve and the listeners: who listens (Icecast), what eve says about the show.
  const cfg = box.config || {};
  const ev = [];
  for (const m of ice || [])
    ev.push(item('Hörer im Stream', String(m.listeners), 'info', `${m.mount} · Spitze ${m.peak}`));
  if (!ice) ev.push(item('Icecast-Statistik', 'keine Antwort', 'info'));
  const L = box.listeners;
  const eveHost = (() => {
    try {
      return new URL(cfg.listeners.url).host;
    } catch {
      return '';
    }
  })();
  if (!cfg.listeners || !cfg.listeners.enabled) {
    ev.push(item('eve', 'nicht eingerichtet', 'info', '`listeners` in studiobox.yaml'));
  } else if (!L) {
    ev.push(item('eve', box.connected ? 'wartet' : '–', 'info', eveHost));
  } else {
    const word = {
      ok: ['verbunden', 'ok'],
      connecting: ['verbindet', 'info'],
      offline: ['nicht erreichbar', 'warn'],
      denied: ['Anmeldung abgelehnt', 'warn'],
    }[L.state] || [L.state, 'info'];
    ev.push(
      item(
        'eve',
        word[0],
        word[1],
        [eveHost, L.updatedMs ? `zuletzt ${ago(Date.now() - L.updatedMs)}` : '']
          .filter(Boolean)
          .join(' · ')
      )
    );
    ev.push(
      L.show
        ? item(
            'Sendung laut Plan',
            L.show.name,
            'info',
            L.show.startMs
              ? `${hhmm(L.show.startMs)}–${hhmm(L.show.endMs)}${L.pinned ? ' · fest eingestellt' : ''}`
              : L.pinned
                ? 'fest eingestellt'
                : ''
          )
        : item('Sendung laut Plan', 'nichts im Plan', 'info')
    );
    ev.push(item('Herzen · Kommentare', `♥ ${L.hearts} · ${L.comments.length}`, 'info'));
    const guide = {
      ok: 'da',
      none: 'keine Folge',
      unavailable: 'nicht abrufbar',
      pending: 'wird geholt',
    };
    ev.push(
      item(
        'Gesprächsleitfaden',
        guide[L.guide] || L.guide,
        'info',
        L.episode && L.episode.title ? L.episode.title : ''
      )
    );
  }
  groups.push({ title: 'eve & Hörer', items: ev });

  // Signal: the programme's meters and the capture card as ALSA runs it.
  const sg = [];
  const capId = cardOf(cfg.capture && cfg.capture.device);
  const hw = await hwParams(capId);
  const db = (x, d = 1) => (Number.isFinite(x) ? de(x, d) : '–');
  if (s) {
    sg.push(
      item(
        'Lautheit (kurz)',
        `${db(s.shortTermLufs)} LUFS`,
        'info',
        `momentan ${db(s.momentaryLufs)} LUFS`
      )
    );
    sg.push(
      item(
        'Spitze',
        `${db(s.outPeakDb)} dBFS`,
        Number.isFinite(s.outPeakDb) && s.outPeakDb > -1 ? 'warn' : 'info',
        `Limiter ${db(s.limiterGrDb)} dB · Summe ${db(s.masterGainDb)} dB`
      )
    );
    if (s.air) {
      if (s.air.underruns > (sig.underruns ?? s.air.underruns)) sig.lastUnderrunAt = Date.now();
      sig.underruns = s.air.underruns;
      const recent = sig.lastUnderrunAt && Date.now() - sig.lastUnderrunAt < 300000;
      sg.push(
        item(
          'Aussetzer · Nachst.',
          `${s.air.underruns} · ${s.air.resyncs}`,
          recent ? 'warn' : 'info',
          recent ? `Aussetzer ${ago(Date.now() - sig.lastUnderrunAt)}` : 'seit dem Start'
        )
      );
    }
    if (s.lookaheadMs) sg.push(item('Vorausschau', `${db(s.lookaheadMs / 1000)} s`, 'info'));
  }
  if (hw)
    sg.push(
      item(
        'Mischpult-Format',
        `${de(hw.rate / 1000, 0)} kHz`,
        'info',
        `${hw.channels} Kanäle · ${hw.format} · Periode ${de((hw.period / hw.rate) * 1000, 0)} ms · Puffer ${de((hw.buffer / hw.rate) * 1000, 0)} ms`
      )
    );
  if (sg.length) groups.push({ title: 'Signal', items: sg });

  // WLAN.
  const wl = [];
  if (!w.up) {
    wl.push(item('Studio-WLAN', 'AUS', 'fail', 'kein Zugangspunkt aktiv'));
  } else {
    // With a fallback configured, anything but the primary card is a warning.
    const spare = AP_FALLBACK_IF && w.dev !== AP_IF;
    wl.push(
      item(
        'Studio-WLAN',
        w.ssid || 'an',
        spare ? 'warn' : 'ok',
        `${spare ? 'Ersatzkarte, ' : ''}${cardKind(w.dev)} · ${w.band}${w.channel ? ` Kanal ${w.channel}` : ''}`
      )
    );
    wl.push(
      item(
        'Verbundene Geräte',
        String(w.clients),
        'info',
        w.width ? `Kanalbreite ${w.width} MHz · ${w.dev}` : w.dev
      )
    );
    // Each device: signal (≥ -67 dBm is good for audio on a tablet) and rate.
    for (const st of w.stations)
      wl.push(
        item(
          `Gerät …${st.mac.slice(-5)}`,
          Number.isFinite(st.signal) ? `${st.signal} dBm` : '–',
          Number.isFinite(st.signal) && st.signal < -75 ? 'warn' : 'info',
          [
            Number.isFinite(st.tx) ? `${de(st.tx, 0)} Mbit/s` : '',
            Number.isFinite(st.secs) ? `seit ${fmtUptime(st.secs)}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        )
      );
  }
  if (AP_FALLBACK_IF) {
    const there = fs.existsSync(`/sys/class/net/${AP_IF}`);
    wl.push(
      item(`Hauptkarte (${cardKind(AP_IF)})`, there ? 'steckt' : 'fehlt', there ? 'ok' : 'warn')
    );
  }
  groups.push({ title: 'WLAN', items: wl });

  // Audio: the cards studiobox is configured for, and what is plugged in.
  const outDev =
    cfg.output && cfg.output.monitor && cfg.output.monitor.enabled !== false
      ? cfg.output.monitor.device
      : null;
  const outId = cardOf(outDev);
  const has = (id) => cards.find((c) => c.id === id);
  const au = [];
  if (capId)
    au.push(
      item(
        'Mischpult',
        has(capId) ? has(capId).desc : 'nicht eingesteckt',
        has(capId) ? 'ok' : 'fail',
        capId
      )
    );
  if (outId && outId !== capId)
    au.push(
      item(
        'Ausgang',
        has(outId) ? has(outId).desc : 'nicht eingesteckt',
        has(outId) ? 'ok' : 'warn',
        outId
      )
    );
  const others = cards.filter((c) => c.id !== capId && c.id !== outId && !/^Generic/.test(c.id));
  for (const c of others) au.push(item('Soundkarte', c.desc, 'info', c.id));
  if (!au.length) au.push(item('Soundkarten', 'keine USB-Karte', 'info'));
  groups.push({ title: 'Audio', items: au });

  // Rechner.
  const pc = [...t.map((x) => item(x.label, x.value, x.state))];
  if (cpu !== null)
    pc.push(
      item(
        'Prozessorlast',
        `${cpu} %`,
        level(cpu, 80, 95),
        load
          ? `Last ${load
              .split(' ')
              .slice(0, 3)
              .map((x) => de(Number(x), 2))
              .join(' · ')}`
          : ''
      )
    );
  if (mem)
    pc.push(item('Arbeitsspeicher', `${mem.used} %`, mem.state, `${de(mem.freeGb, 1)} GB frei`));
  if (dsk)
    pc.push(
      item(
        'Platz für Aufnahmen',
        `${Math.round(dsk.gb)} GB`,
        dsk.state,
        `≈ ${Math.floor(dsk.hours)} h Aufnahme`
      )
    );
  groups.push({ title: 'Rechner', items: pc });

  // Netz: every port with hardware behind it.
  const nz = [];
  for (const n of net) {
    const traffic = n.rx !== null && n.tx !== null ? `↓ ${bits(n.rx)} · ↑ ${bits(n.tx)}` : '';
    nz.push(
      item(
        n.name,
        n.up ? n.ipv4[0] || 'ohne IPv4' : n.wifi ? 'aus' : 'kein Kabel',
        'info',
        [n.speed && !n.wifi ? `${n.speed} Mbit/s` : '', n.up ? traffic : '']
          .filter(Boolean)
          .join(' · ')
      )
    );
  }
  nz.push(
    item('Standardroute', route || 'keine', 'info', route ? 'Internet über diesen Port' : '')
  );
  groups.push({ title: 'Netz', items: nz });

  // System: what runs here.
  const sy = [];
  const os = require('node:os');
  sy.push(
    item(
      'Kernel',
      os.release().split(/[+-]/)[0],
      'info',
      [os.release(), deb ? `Debian ${deb.trim()}` : ''].filter(Boolean).join(' · ')
    )
  );
  sy.push(item('Node', process.version, 'info', `${os.arch()} · ${clk.cores} Kerne`));
  if (gi.text)
    sy.push(item('studiobox-Stand', gi.text, 'info', gi.branch ? `Zweig ${gi.branch}` : ''));
  if (clk.mhz)
    sy.push(item('Prozessortakt', `${de(clk.mhz / 1000, 2)} GHz`, 'info', 'Mittel aller Kerne'));
  const pid = sb && Number(sb.MainPID);
  const pr = await proc(pid);
  if (pr)
    sy.push(
      item(
        'studiobox-Prozess',
        pr.cpu === null ? '–' : `${pr.cpu} %`,
        pr.cpu === null ? 'info' : level(pr.cpu, 70, 90),
        `eines Kerns · ${pr.rssMb} MB · PID ${pid}`
      )
    );
  if (io.read !== null)
    sy.push(item('Datenträger schreibt', bytes(io.write), 'info', `liest ${bytes(io.read)}`));
  groups.push({ title: 'System', items: sy });

  // Dienste.
  const sv = [];
  const ic = u['icecast2.service'];
  if (ic)
    sv.push(
      item(
        'Icecast',
        ic.ActiveState === 'active' ? 'läuft' : 'aus',
        ic.ActiveState === 'active' ? 'ok' : 'warn'
      )
    );
  const nt = u['nextcloud-sync.timer'];
  const ns = u['nextcloud-sync.service'];
  if (nt) {
    const busy = ns && ns.ActiveState === 'activating';
    const okRun = ns && ns.Result === 'success';
    // `--timestamp=unix`: "@1760000000".
    const when = ns ? Number((ns.InactiveEnterTimestamp || '').slice(1)) * 1000 : NaN;
    sv.push(
      item(
        'Nextcloud-Abgleich',
        busy ? 'läuft gerade' : nt.ActiveState !== 'active' ? 'aus' : okRun ? 'ok' : 'Fehler',
        busy ? 'info' : nt.ActiveState !== 'active' || !okRun ? 'warn' : 'ok',
        when > 0 && !busy ? `zuletzt ${ago(Date.now() - when)}` : ''
      )
    );
  }
  const aw = u['studiobox-ap-watch.service'];
  if (aw)
    sv.push(
      item(
        'WLAN-Wächter',
        aw.ActiveState === 'active' ? 'läuft' : 'aus',
        aw.ActiveState === 'active' ? 'ok' : 'warn'
      )
    );
  if (ntp !== null)
    sv.push(
      item(
        'Uhrzeit',
        ntp.trim() === 'yes' ? 'synchron' : 'nicht synchron',
        ntp.trim() === 'yes' ? 'ok' : 'warn'
      )
    );
  if (up) sv.push(item('Läuft seit', fmtUptime(Number(up.split(' ')[0])), 'info'));
  groups.push({ title: 'Dienste', items: sv });

  const all = groups.flatMap((g) => g.items.map((i) => i.state));
  return {
    host: require('node:os').hostname(),
    page: pageStamp(),
    state: worst(all),
    groups,
  };
}

// --- QR codes: the studio WLAN and the technician's page ----------------------------

const wifiEsc = (x) => String(x).replace(/([\\;,:"])/g, '\\$1');
const qr = (data) => QRCode.toString(data, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
const AP_HOST = (env.AP_ADDRESS || '10.42.0.1/24').split('/')[0];

/** The technician's link as studiobox prints it at start (the tablets reach
 *  it at the AP address); null without studiobox's config. */
function techUrl() {
  const m = box.config && box.config.meters;
  if (!m) return null;
  const base = `http://${AP_HOST}:${m.port || 4445}`;
  const tok = m.roles && m.roles.enabled && m.roles.tokens ? m.roles.tokens.tech : '';
  return tok ? `${base}/tech?k=${encodeURIComponent(tok)}` : `${base}/`;
}

/** Rendered again only when something changed (the token is new after a
 *  config without pinned tokens restarted). */
let codes = { key: '', body: null };
async function qrCodes() {
  const tech = techUrl();
  const key = `${env.AP_SSID}|${env.AP_PASSPHRASE}|${tech}`;
  if (codes.key !== key) {
    const wifi =
      env.AP_SSID && env.AP_PASSPHRASE
        ? {
            ssid: env.AP_SSID,
            password: env.AP_PASSPHRASE,
            svg: await qr(`WIFI:T:WPA;S:${wifiEsc(env.AP_SSID)};P:${wifiEsc(env.AP_PASSPHRASE)};;`),
          }
        : null;
    codes = { key, body: { wifi, tech: tech ? { url: tech, svg: await qr(tech) } : null } };
  }
  return codes.body;
}

// --- serve ------------------------------------------------------------------------

let current = null;
async function loop() {
  try {
    current = await collect();
  } catch (err) {
    console.error(`health: ${err.message}`);
  }
  setTimeout(loop, TICK_MS);
}

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health.json') {
      res.writeHead(current ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      // `now` at the moment of the answer, not of the last measurement (up to
      // TICK_MS old): the page sets its clock by it.
      res.end(JSON.stringify({ ...(current || { state: 'wait', groups: [] }), now: Date.now() }));
    } else if (url === '/codes.json') {
      qrCodes().then(
        (body) => {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(JSON.stringify(body));
        },
        () => {
          res.writeHead(500);
          res.end();
        }
      );
    } else if (url === '/' || url === '/index.html') {
      fs.readFile(PAGE, (err, body) => {
        res.writeHead(err ? 500 : 200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(err ? 'health.html missing' : body);
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`health: http://localhost:${PORT}`));

watchStudiobox();
loop();

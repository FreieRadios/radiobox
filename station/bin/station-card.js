#!/usr/bin/env node
// A printable page with the QR codes a session needs: join the studio WLAN,
// open the technician and host views. Reads /etc/studiobox/station.env (or
// the file given) and the role tokens from the generated config.
//
//   station-card.js [station.env] > station-card.html
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.resolve(__dirname, '../..');
const req = (m) => require(require.resolve(m, { paths: [appDir, path.join(appDir, 'packages/studiobox')] }));
const yaml = req('js-yaml');
const QRCode = req('qrcode');

function readEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return env;
}

const env = readEnv(process.argv[2] || '/etc/studiobox/station.env');
const stateDir = env.STATE_DIR || '/var/lib/studiobox';
const cfg = yaml.load(fs.readFileSync(path.join(stateDir, 'studiobox.template.yaml'), 'utf8'));
const port = (cfg.meters && cfg.meters.port) || 4445;
const tokens = (cfg.meters && cfg.meters.roles && cfg.meters.roles.tokens) || {};
const host = (env.AP_ADDRESS || '10.42.0.1/24').split('/')[0];
const base = `http://${host}:${port}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const wifiEsc = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

const cards = [
  {
    title: '1 · WLAN',
    text: `${env.AP_SSID} / ${env.AP_PASSPHRASE}`,
    data: `WIFI:T:WPA;S:${wifiEsc(env.AP_SSID)};P:${wifiEsc(env.AP_PASSPHRASE)};;`,
  },
];
if (tokens.tech) cards.push({ title: '2 · Technik', text: `${base}/?k=${tokens.tech}`, data: `${base}/?k=${tokens.tech}` });
if (tokens.host) cards.push({ title: '3 · Host', text: `${base}/host?k=${tokens.host}`, data: `${base}/host?k=${tokens.host}` });

(async () => {
  const blocks = [];
  for (const c of cards) {
    const svg = await QRCode.toString(c.data, { type: 'svg', margin: 1 });
    blocks.push(`<section><h2>${esc(c.title)}</h2>${svg}<p>${esc(c.text)}</p></section>`);
  }
  process.stdout.write(`<!doctype html><meta charset="utf-8"><title>studiobox</title>
<style>body{font-family:system-ui,sans-serif;margin:16px}main{display:flex;flex-wrap:wrap;gap:24px}
section{width:260px}svg{width:240px;height:240px}p{font-size:13px;word-break:break-all}</style>
<h1>studiobox · ${esc(env.AP_SSID || '')}</h1>
<p>Erst ins WLAN, dann die Ansicht öffnen. Gäste-Codes gibt es auf dem Technik-Gerät unter ⋮ → Geräte verbinden.</p>
<main>${blocks.join('')}</main>\n`);
})();

#!/usr/bin/env node
// Renders the studiobox config for this start of the service.
//
//   prestart.js <template.yaml> <studiobox.yaml>
//
// Copies the template and points `output.monitor` at the first sound card
// from OUTPUT_CARDS that is plugged in now (`plughw:CARD=<id>,DEV=0`); with
// none of them present the local output is switched off and the stream
// carries the programme alone. Runs as ExecStartPre, so the choice is made
// again at every (re)start.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.resolve(__dirname, '../..');
const yaml = require(require.resolve('js-yaml', { paths: [appDir] }));

const [templatePath, outPath] = process.argv.slice(2);
if (!templatePath || !outPath) {
  console.error('usage: prestart.js <template.yaml> <studiobox.yaml>');
  process.exit(2);
}

/** Cards from /proc/asound/cards: ` 2 [MAYA22 ]: USB-Audio - MAYA22 USB`. */
function cards() {
  let text = '';
  try {
    text = fs.readFileSync('/proc/asound/cards', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\d+\s+\[([^\]\s]+)\s*\]:\s*(.*)$/.exec(line);
    if (m) out.push({ id: m[1], desc: m[2] });
  }
  return out;
}

const cfg = yaml.load(fs.readFileSync(templatePath, 'utf8'));
const wanted = (process.env.OUTPUT_CARDS || '').split(/\s+/).filter(Boolean);

if (wanted.length) {
  cfg.output = cfg.output || {};
  const monitor = cfg.output.monitor || {};
  const present = cards();
  const captureDevice = (cfg.capture && cfg.capture.device) || '';
  let hit = null;
  for (const name of wanted) {
    const n = name.toLowerCase();
    hit = present.find(
      (c) =>
        (c.id.toLowerCase() === n || c.desc.toLowerCase().includes(n)) &&
        !captureDevice.includes(`CARD=${c.id},`) &&
        !captureDevice.endsWith(`CARD=${c.id}`)
    );
    if (hit) break;
  }
  if (hit) {
    cfg.output.monitor = {
      ...monitor,
      enabled: true,
      backend: 'alsa',
      device: `plughw:CARD=${hit.id},DEV=0`,
    };
    console.log(`studiobox prestart: programme output -> ${hit.id} (${hit.desc.trim()})`);
  } else {
    cfg.output.monitor = { ...monitor, enabled: false };
    console.log(
      `studiobox prestart: none of [${wanted.join(', ')}] plugged in -> local output off` +
        (cfg.output.harbor && cfg.output.harbor.enabled ? ', programme goes to the stream' : '')
    );
  }
}

const header =
  '# GENERATED at every start of studiobox.service by station/bin/prestart.js.\n' +
  `# Edit ${templatePath} instead; changes here are overwritten.\n`;
fs.writeFileSync(outPath + '.tmp', header + yaml.dump(cfg, { lineWidth: 120 }), { mode: 0o600 });
fs.renameSync(outPath + '.tmp', outPath);

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StripSettings } from './measure';

/**
 * Live settings that outlive a restart: what the setup assistant measured and
 * what the technician trimmed by hand. Kept in a small JSON file next to the
 * config — never in `studiobox.yaml`, which stays the hand-written baseline —
 * so a crash in the middle of a show comes back with the mics as they were.
 */
export interface SessionState {
  /** Epoch ms of the last save. */
  savedAt: number;
  /** Per mic label: the settings applied on top of the configured profile. */
  mics: Record<string, StripSettings>;
  automixFloorDb?: number;
  priorityDepthDb?: number;
  /** Level of the music return in the headphones (dB). */
  returnGainDb?: number;
  /** Level of the music on air ("Musik-Lautstärke", dB). */
  musicGainDb?: number;
  /** 'single' ("einzeln") | 'chain' ("durchlaufen"). */
  queueMode?: 'single' | 'chain';
}

/** State older than this is last week's guests: start from the config. */
export const STATE_MAX_AGE_MS = 12 * 3600 * 1000;

const SETTING_KEYS: (keyof StripSettings)[] = [
  'trimDb',
  'hpfHz',
  'gateThresholdDb',
  'compThresholdDb',
  'deessThresholdDb',
  'seedDb',
  'zoneCenterDb',
];

/** Read the state file. Null when it is missing, unreadable, malformed or
 *  older than `maxAgeMs` — a bad state file must never stop the service. */
export function loadState(
  file: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = STATE_MAX_AGE_MS
): SessionState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const savedAt = Number(r.savedAt);
  if (!Number.isFinite(savedAt) || nowMs - savedAt > maxAgeMs) return null;
  const mics: Record<string, StripSettings> = {};
  if (typeof r.mics === 'object' && r.mics !== null) {
    for (const [label, v] of Object.entries(r.mics as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null) continue;
      const s = v as Record<string, unknown>;
      // Every number has to be there and finite: a half-written entry could
      // put NaN into a filter.
      if (SETTING_KEYS.every((k) => Number.isFinite(s[k]))) {
        mics[label] = Object.fromEntries(
          SETTING_KEYS.map((k) => [k, s[k]])
        ) as unknown as StripSettings;
      }
    }
  }
  const out: SessionState = { savedAt, mics };
  if (Number.isFinite(r.automixFloorDb)) out.automixFloorDb = Number(r.automixFloorDb);
  if (Number.isFinite(r.priorityDepthDb)) out.priorityDepthDb = Number(r.priorityDepthDb);
  if (Number.isFinite(r.returnGainDb)) out.returnGainDb = Number(r.returnGainDb);
  if (Number.isFinite(r.musicGainDb)) out.musicGainDb = Number(r.musicGainDb);
  if (r.queueMode === 'single' || r.queueMode === 'chain') out.queueMode = r.queueMode;
  return out;
}

/** Write the state file atomically (temp file + rename), so a crash while
 *  saving leaves the previous state intact. Returns false on failure. */
export function saveState(file: string, state: SessionState): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

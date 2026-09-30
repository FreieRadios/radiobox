import { MeterSnapshot } from '../dsp/graph';
import { SetupStatus } from '../setup/session';

/**
 * What goes over the WebSocket, per role.
 *
 * The technician and the host get the whole snapshot plus `onAir`. A guest
 * tablet and a spectator get a cut-down one: they sit on the venue's Wi-Fi,
 * often on a weak signal, and have no business seeing the rest of the desk.
 */

/** The snapshot as the pipeline hands it over: the graph's meters plus
 *  whatever the pipeline adds (setup assistant, test tone, bed, …). */
export type Snapshot = MeterSnapshot & {
  setup?: SetupStatus;
  testTone?: boolean;
};

/**
 * "On air", as far as the box can know it: **programme is leaving the box**.
 * The desk's extern fader is out of its sight, so this is the most it can
 * honestly claim.
 *
 *  - `null` without an air delay (playout mode): there the monitor is the
 *    output and it always runs, so the chip would say nothing.
 *  - `false` while the buffer is still filling (the output is silent) and
 *    once a show has ended; `true` while it is live and while "Sendung
 *    beenden" lets the buffer play out — that is still going out.
 *  - An output has to be running: the harbor stream, or the local output
 *    unless the alignment tone has taken the programme's place on it.
 */
export function onAirOf(s: Snapshot): boolean | null {
  if (!s.air) return null;
  if (s.air.state !== 'live' && s.air.state !== 'draining') return false;
  const local = s.monitor === true && !s.testTone;
  return local || s.streaming === true;
}

const pick = <T extends object>(o: T, keys: readonly string[]): Partial<T> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
};

/** Per mic, what a guest tablet shows: state and mouth distance — no dB of
 *  the processing chain. */
const GUEST_MIC = [
  'label',
  'role',
  'muted',
  'active',
  'speechDb',
  'zone',
  'zoneCenterDb',
  'zoneWidthDb',
  'priorityDb',
] as const;

const GUEST = [
  'micsMuted',
  'setupApplied',
  'filePlaying',
  'filePosition',
  'fileDuration',
  'serverNowMs',
  'air',
] as const;

/** Guest view: the mics' state and speech level, what plays and for how long,
 *  the clocks, and where the setup assistant stands (without its results). */
export function guestSnapshot(s: Snapshot, onAir: boolean | null): object {
  return {
    ...pick(s, GUEST),
    onAir,
    channels: s.channels.filter((c) => c.role === 'mic').map((c) => pick(c, GUEST_MIC)),
    priority: s.priority ? { label: s.priority.label, active: s.priority.active } : null,
    setup: s.setup ? pick(s.setup, ['phase', 'current', 'sentence', 'silence', 'mics']) : undefined,
  };
}

const SPECTATOR = [
  'filePlaying',
  'filePosition',
  'fileDuration',
  'shortTermLufs',
  'outPeakDb',
  'lookaheadMs',
  'serverNowMs',
  'air',
] as const;

/** Spectator view: on air or not, what plays, the programme level, the clock. */
export function spectatorSnapshot(s: Snapshot, onAir: boolean | null): object {
  return { ...pick(s, SPECTATOR), onAir };
}

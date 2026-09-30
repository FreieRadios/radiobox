import { markdownToHtml } from './markdown';

/**
 * The episode on air and its conversation guide, from eve.
 *
 * eve serves the episodes of every show from yesterday to tomorrow
 * (`/exports/<app>/episodes`), each with the show's slug and its air date;
 * studiobox keeps the one that belongs to the slot it has on air. Its topics
 * and must-ask questions come from two more exports keyed by the episode's id.
 * The scripts and notes are markdown in eve and leave here as sanitized HTML.
 */

export interface GuideTopic {
  id: string;
  title: string;
  /** One line to steer to this topic with; the cues in order are the path. */
  cue: string;
  /** The notes, as HTML (empty when there are none). */
  html: string;
}

export interface GuideQuestion {
  id: string;
  text: string;
  asked: boolean;
}

export interface EpisodeGuide {
  id: string;
  title: string;
  /** When eve says it airs, ms. */
  airMs: number | null;
  /** eve's editorial state (`entwurf`, `freigegeben`, `gesendet`). */
  status: string;
  /** Anmoderation / Abmoderation, as HTML. */
  opening: string;
  closing: string;
  topics: GuideTopic[];
  questions: GuideQuestion[];
}

/** One row of the `episodes` export. */
export interface EpisodeRow {
  id: string;
  slug: string;
  title: string;
  airMs: number | null;
  status: string;
  repeat: boolean;
  opening: string;
  closing: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A date-only value (`2026-10-05`) is that day in the local zone, not UTC. */
function parseAir(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

const rowsOf = (doc: unknown): Record<string, unknown>[] => {
  const r = (doc as { rows?: unknown } | null)?.rows;
  return Array.isArray(r) ? (r.filter((x) => x && typeof x === 'object') as never) : [];
};

export function parseEpisodes(doc: unknown): EpisodeRow[] {
  return rowsOf(doc)
    .filter((r) => str(r.id) && str(r.slug))
    .map((r) => ({
      id: str(r.id),
      slug: str(r.slug),
      title: str(r.title),
      airMs: parseAir(r.airDate),
      status: str(r.status),
      repeat: r.repeat === true,
      opening: str(r.opening),
      closing: str(r.closing),
    }));
}

const sameDay = (a: number, b: number): boolean => {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
};

/**
 * The episode of `slug` that airs in the slot `[startMs, endMs)`: one whose
 * air date lies in the slot, or falls on the day the slot began (an air date
 * is often just a day). Reruns are skipped — nobody hosts them. Several
 * candidates: the one nearest the slot's start. Without a slot (a show pinned
 * for a rehearsal) today's episode, else the one nearest `nowMs` within the
 * window eve served.
 */
export function pickEpisode(
  rows: EpisodeRow[],
  slug: string,
  slot: { startMs: number; endMs: number } | null,
  nowMs: number
): EpisodeRow | null {
  const ref = slot ? slot.startMs : nowMs;
  let best: EpisodeRow | null = null;
  let bestDist = Infinity;
  for (const r of rows) {
    if (r.slug !== slug || r.repeat || r.airMs === null) continue;
    if (slot) {
      const inSlot = r.airMs >= slot.startMs && r.airMs < slot.endMs;
      if (!inSlot && !sameDay(r.airMs, slot.startMs)) continue;
    }
    // A pinned show: an episode dated today beats a nearer one tomorrow.
    const dist = Math.abs(r.airMs - ref) + (slot || sameDay(r.airMs, nowMs) ? 0 : 7 * 86_400_000);
    if (dist < bestDist) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}

export function buildGuide(ep: EpisodeRow, topics: unknown, questions: unknown): EpisodeGuide {
  return {
    id: ep.id,
    title: ep.title,
    airMs: ep.airMs,
    status: ep.status,
    opening: markdownToHtml(ep.opening),
    closing: markdownToHtml(ep.closing),
    topics: rowsOf(topics)
      .filter((r) => str(r.title))
      .map((r) => ({
        id: str(r.id),
        title: str(r.title),
        cue: str(r.cue),
        html: markdownToHtml(str(r.body)),
      })),
    questions: rowsOf(questions)
      .filter((r) => str(r.text))
      .map((r) => ({ id: str(r.id), text: str(r.text), asked: r.asked === true })),
  };
}

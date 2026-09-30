/**
 * Which show is on air, from eve's schedule rules and studiobox's own clock.
 *
 * eve serves one row per regular slot (`GET /exports/<app>/schedule-rules`):
 * an ISO weekday, a start hour and a duration in the station's time zone,
 * the weeks of the month (`1-5`, `2,4`, `-1` = the last one) and the months of
 * the year it runs in. eve does not know what is on air — studiobox does, so
 * the rules are evaluated here, against Sendezeit, in the server's time zone
 * (the same zone the filename timestamps are read in).
 *
 * Repeats (`repeatOffset`) are deliberately not slots: a rerun has nobody at
 * the microphone, so there is nobody to show listener feedback to.
 */

export interface ScheduleRule {
  slug: string;
  name: string;
  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  weekday: number;
  startHour: number;
  durationHours: number;
  /** Weeks of the month the slot runs in; -1 is the last such weekday. */
  weeks: number[];
  months: number[];
  /** A special edition that takes the hour from the regular show. */
  overrides: boolean;
}

/** One broadcast: a rule on a particular day. */
export interface Slot {
  slug: string;
  name: string;
  startMs: number;
  endMs: number;
}

/** `1-5`, `2,4`, `-1`, `2,4,6,8,10,12` -> numbers. Anything unreadable is
 *  dropped, so a broken rule matches nothing rather than everything. */
export function parseList(raw: unknown): number[] {
  if (typeof raw === 'number') return [raw];
  if (typeof raw !== 'string') return [];
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(p);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(n);
    } else if (/^-?\d+$/.test(p)) {
      out.push(Number(p));
    }
  }
  return out;
}

/** The rows of the `schedule-rules` export, as rules. Rows without a slug or
 *  with an impossible time are skipped. */
export function parseRules(rows: unknown): ScheduleRule[] {
  if (!Array.isArray(rows)) return [];
  const out: ScheduleRule[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const slug = typeof o.slug === 'string' ? o.slug : '';
    const weekday = Number(o.weekday);
    const startHour = Number(o.startHour);
    const durationHours = Number(o.durationHours);
    if (!slug || !(weekday >= 1 && weekday <= 7)) continue;
    if (!(startHour >= 0 && startHour < 24) || !(durationHours > 0 && durationHours <= 24))
      continue;
    out.push({
      slug,
      name: typeof o.name === 'string' && o.name ? o.name : slug,
      weekday,
      startHour,
      durationHours,
      weeks: parseList(o.weeksOfMonth ?? '1-5'),
      months: parseList(o.monthsOfYear ?? '1-12'),
      overrides: o.overrides === true,
    });
  }
  return out;
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** Does the rule run on this (local) day? */
function runsOn(rule: ScheduleRule, day: Date): boolean {
  if ((day.getDay() || 7) !== rule.weekday) return false;
  if (!rule.months.includes(day.getMonth() + 1)) return false;
  const date = day.getDate();
  const nth = Math.ceil(date / 7);
  const last = date + 7 > daysInMonth(day);
  return rule.weeks.includes(nth) || (last && rule.weeks.includes(-1));
}

/**
 * The slot on air at `atMs`, or null when the plan has nothing then.
 *
 * A slot may have started on an earlier day (a show from 23:00 to 01:00 is
 * still on at 00:30). When several cover the instant, a special edition
 * (`overrides`) wins over the regular show, and otherwise the one that began
 * last — the same hour-by-hour reading the station's printed schedule has.
 */
export function slotAt(rules: ScheduleRule[], atMs: number): Slot | null {
  if (!rules.length) return null;
  const maxHours = Math.max(...rules.map((r) => r.startHour + r.durationHours));
  const daysBack = Math.ceil(maxHours / 24);
  const at = new Date(atMs);
  let best: { slot: Slot; overrides: boolean } | null = null;
  for (let back = 0; back < daysBack; back++) {
    // Local midnight `back` days ago (built from the date, so DST days work).
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - back);
    for (const rule of rules) {
      if (!runsOn(rule, day)) continue;
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), rule.startHour);
      const startMs = start.getTime();
      const endMs = startMs + rule.durationHours * 3_600_000;
      if (atMs < startMs || atMs >= endMs) continue;
      const better =
        !best ||
        (rule.overrides && !best.overrides) ||
        (rule.overrides === best.overrides && startMs > best.slot.startMs);
      if (better) {
        best = {
          slot: { slug: rule.slug, name: rule.name, startMs, endMs },
          overrides: rule.overrides,
        };
      }
    }
  }
  return best?.slot ?? null;
}

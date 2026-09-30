import { parseList, parseRules, slotAt } from '../../src/listeners/schedule-rules';

// Local wall-clock instants: the rules are read in the server's time zone.
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

const row = (o: Record<string, unknown>) => ({
  name: 'Show',
  slug: 'show',
  weekday: 3,
  startHour: 18,
  durationHours: 1,
  weeksOfMonth: '1-5',
  monthsOfYear: '1-12',
  repeatOffset: 17,
  overrides: false,
  noMerge: false,
  ...o,
});

describe('parseList', () => {
  it('reads ranges, lists and the last week', () => {
    expect(parseList('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseList('2,4,6')).toEqual([2, 4, 6]);
    expect(parseList('-1')).toEqual([-1]);
    expect(parseList('1, 3-4')).toEqual([1, 3, 4]);
  });
  it('drops what it cannot read, so a broken rule matches nothing', () => {
    expect(parseList('x')).toEqual([]);
    expect(parseList(null)).toEqual([]);
  });
});

describe('parseRules', () => {
  it('skips rows without a slug or with an impossible time', () => {
    const rules = parseRules([
      row({ slug: '' }),
      row({ weekday: 8 }),
      row({ startHour: 24 }),
      row({ durationHours: 0 }),
      row({ slug: 'ok' }),
    ]);
    expect(rules.map((r) => r.slug)).toEqual(['ok']);
  });
});

describe('slotAt', () => {
  // September 2026: Wednesdays are the 2nd, 9th, 16th, 23rd and 30th.
  it('finds the show on air, with the start and end of its slot', () => {
    const rules = parseRules([row({ slug: 'gruenfunk', name: 'Grünfunk' })]);
    const s = slotAt(rules, at(2026, 9, 30, 18, 20));
    expect(s).toEqual({
      slug: 'gruenfunk',
      name: 'Grünfunk',
      startMs: at(2026, 9, 30, 18),
      endMs: at(2026, 9, 30, 19),
    });
    expect(slotAt(rules, at(2026, 9, 30, 17, 59))).toBeNull();
    expect(slotAt(rules, at(2026, 9, 30, 19))).toBeNull(); // end is exclusive
    expect(slotAt(rules, at(2026, 10, 1, 18, 20))).toBeNull(); // Thursday
  });

  it('honours the weeks of the month, the last one included', () => {
    const third = parseRules([row({ weeksOfMonth: '3' })]);
    expect(slotAt(third, at(2026, 9, 16, 18, 30))?.slug).toBe('show');
    expect(slotAt(third, at(2026, 9, 23, 18, 30))).toBeNull();
    const last = parseRules([row({ weeksOfMonth: '-1' })]);
    expect(slotAt(last, at(2026, 9, 30, 18, 30))?.slug).toBe('show');
    expect(slotAt(last, at(2026, 9, 23, 18, 30))).toBeNull();
  });

  it('honours the months of the year', () => {
    const even = parseRules([row({ monthsOfYear: '2,4,6,8,10,12' })]);
    expect(slotAt(even, at(2026, 9, 30, 18, 30))).toBeNull();
    expect(slotAt(even, at(2026, 10, 7, 18, 30))?.slug).toBe('show');
  });

  it('keeps a show that runs across midnight on air after it', () => {
    // Sunday 27 September, 23:00 for two hours.
    const rules = parseRules([row({ weekday: 7, startHour: 23, durationHours: 2 })]);
    const s = slotAt(rules, at(2026, 9, 28, 0, 30));
    expect(s?.startMs).toBe(at(2026, 9, 27, 23));
    expect(slotAt(rules, at(2026, 9, 28, 1, 0))).toBeNull();
  });

  it('lets a special edition take the hour from the regular show', () => {
    const rules = parseRules([
      row({ slug: 'regular', startHour: 18, durationHours: 2 }),
      row({ slug: 'special', startHour: 18, weeksOfMonth: '-1', overrides: true }),
    ]);
    expect(slotAt(rules, at(2026, 9, 30, 18, 30))?.slug).toBe('special');
    // The special edition is one hour: the second hour is the regular show's.
    expect(slotAt(rules, at(2026, 9, 30, 19, 30))?.slug).toBe('regular');
    expect(slotAt(rules, at(2026, 9, 23, 18, 30))?.slug).toBe('regular');
  });

  it('prefers the slot that began last when two overlap', () => {
    const rules = parseRules([
      row({ slug: 'long', startHour: 16, durationHours: 3 }),
      row({ slug: 'late', startHour: 18 }),
    ]);
    expect(slotAt(rules, at(2026, 9, 30, 17))?.slug).toBe('long');
    expect(slotAt(rules, at(2026, 9, 30, 18, 10))?.slug).toBe('late');
  });

  it('is not fooled by repeats: a rerun has nobody at the microphone', () => {
    // 18:00 + 17 h would be Thursday 11:00.
    const rules = parseRules([row({})]);
    expect(slotAt(rules, at(2026, 10, 1, 11, 30))).toBeNull();
  });
});

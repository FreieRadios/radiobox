import { buildGuide, parseEpisodes, pickEpisode } from '../../src/listeners/episode';

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

// Monday 5 October 2026, Meine Sendung 20–21.
const SLOT = { startMs: at(2026, 10, 5, 20), endMs: at(2026, 10, 5, 21) };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  slug: 'meine-sendung',
  title: 'Folge 12',
  airDate: '2026-10-05',
  status: 'entwurf',
  repeat: null,
  opening: '*Jingle*',
  closing: null,
  ...over,
});

describe('parseEpisodes', () => {
  it('reads a bare air date as that day here, not in UTC', () => {
    const [ep] = parseEpisodes({ rows: [row()] });
    expect(ep.airMs).toBe(at(2026, 10, 5, 0));
    expect(ep.repeat).toBe(false);
    expect(ep.closing).toBe('');
  });

  it('skips rows without an id or a show', () => {
    expect(parseEpisodes({ rows: [row({ id: null }), row({ slug: null }), null, 'x'] })).toEqual(
      []
    );
    expect(parseEpisodes(null)).toEqual([]);
  });
});

describe('pickEpisode', () => {
  const eps = (...rows: Record<string, unknown>[]) => parseEpisodes({ rows });

  it('takes the episode of the show whose air date is the day of the slot', () => {
    const got = pickEpisode(eps(row()), 'meine-sendung', SLOT, SLOT.startMs);
    expect(got?.id).toBe('e1');
  });

  it('takes one whose air instant lies in the slot, even across midnight', () => {
    const late = { startMs: at(2026, 10, 5, 23), endMs: at(2026, 10, 6, 1) };
    const iso = new Date(at(2026, 10, 6, 0, 30)).toISOString();
    expect(pickEpisode(eps(row({ airDate: iso })), 'meine-sendung', late, 0)?.id).toBe('e1');
  });

  it('ignores other shows, other days and reruns', () => {
    const rows = eps(
      row({ id: 'other', slug: 'andere-sendung' }),
      row({ id: 'yesterday', airDate: '2026-10-04' }),
      row({ id: 'rerun', repeat: true })
    );
    expect(pickEpisode(rows, 'meine-sendung', SLOT, SLOT.startMs)).toBeNull();
  });

  it('prefers the one nearest the start of the slot', () => {
    const rows = eps(
      row({ id: 'far', airDate: new Date(at(2026, 10, 5, 9)).toISOString() }),
      row({ id: 'near', airDate: new Date(at(2026, 10, 5, 20)).toISOString() })
    );
    expect(pickEpisode(rows, 'meine-sendung', SLOT, SLOT.startMs)?.id).toBe('near');
  });

  it('without a slot (a pinned show) takes the one nearest now', () => {
    const rows = eps(row({ id: 'today' }), row({ id: 'tomorrow', airDate: '2026-10-06' }));
    expect(pickEpisode(rows, 'meine-sendung', null, at(2026, 10, 5, 14))?.id).toBe('today');
  });
});

describe('buildGuide', () => {
  it('keeps the order eve serves and renders the notes', () => {
    const [ep] = parseEpisodes({ rows: [row()] });
    const g = buildGuide(
      ep,
      {
        rows: [
          { id: 'r1', title: 'Die Gäste', cue: 'Wer seid ihr?', body: '### Vorstellung' },
          { id: 'r2', title: 'Die Idee', cue: null, body: null },
          { id: 'r3', title: null },
        ],
      },
      {
        rows: [
          { id: 'q1', text: 'Was ist Erfolg?', asked: true },
          { id: 'q2', text: '' },
        ],
      }
    );
    expect(g.opening).toBe('<p><em>Jingle</em></p>');
    expect(g.closing).toBe('');
    expect(g.topics).toEqual([
      { id: 'r1', title: 'Die Gäste', cue: 'Wer seid ihr?', html: '<h4>Vorstellung</h4>' },
      { id: 'r2', title: 'Die Idee', cue: '', html: '' },
    ]);
    expect(g.questions).toEqual([{ id: 'q1', text: 'Was ist Erfolg?', asked: true }]);
  });
});

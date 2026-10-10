import { ListenersConfig } from '../../src/config/schema';
import { FetchLike } from '../../src/listeners/eve-session';
import {
  ListenerFeed,
  ListenerStatus,
  SocketFactory,
  selectFeedback,
} from '../../src/listeners/feed';

const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).getTime();

// Wednesday 30 September 2026: Wochenmarkt 18–19, Stadtgeflüster 19–20.
const RULES = [
  {
    name: 'Wochenmarkt',
    slug: 'wochenmarkt',
    weekday: 3,
    startHour: 18,
    durationHours: 1,
    weeksOfMonth: '1-5',
    monthsOfYear: '1-12',
    overrides: false,
  },
  {
    name: 'Stadtgeflüster',
    slug: 'stadtgefluester',
    weekday: 3,
    startHour: 19,
    durationHours: 1,
    weeksOfMonth: '1-5',
    monthsOfYear: '1-12',
    overrides: false,
  },
];

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** eve's three exports behind a login; `down` makes it unreachable. */
function fakeEve() {
  const urls: string[] = [];
  const data = {
    comments: [
      {
        id: 'c1',
        slug: 'wochenmarkt',
        text: 'Grüße aus Gostenhof!',
        receivedAt: '2026-09-30T16:11:00.000Z',
      },
      {
        id: 'c2',
        slug: 'stadtgefluester',
        text: 'Nicht für Wochenmarkt',
        receivedAt: '2026-09-30T16:12:00.000Z',
      },
    ],
    hearts: [
      { slug: 'wochenmarkt', hearts: 7 },
      { slug: 'stadtgefluester', hearts: 2 },
    ],
    /** The guide's exports; null: an eve that does not have them (404). */
    episodes: null as Record<string, unknown>[] | null,
    topics: {} as Record<string, Record<string, unknown>[]>,
    questions: {} as Record<string, Record<string, unknown>[]>,
  };
  let down = false;
  const res = (status: number, body: unknown) => ({
    ok: status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  const fetch: FetchLike = async (url) => {
    const path = url.replace('http://eve', '');
    urls.push(path);
    if (down) throw new Error('ECONNREFUSED');
    if (path === '/auth/login') return res(200, { token: 'h.e30.s', refreshToken: 'r' });
    if (path.startsWith('/exports/station/schedule-rules')) return res(200, { rows: RULES });
    if (path.startsWith('/exports/station/listener-comments'))
      return res(200, { rows: data.comments });
    if (path.startsWith('/exports/station/listener-hearts')) return res(200, { rows: data.hearts });
    const ep = decodeURIComponent(path.split('?episode=')[1] ?? '');
    if (data.episodes && path === '/exports/station/episodes')
      return res(200, { rows: data.episodes });
    if (data.episodes && path.startsWith('/exports/station/episode-topics?'))
      return res(200, { rows: data.topics[ep] ?? [] });
    if (data.episodes && path.startsWith('/exports/station/episode-questions?'))
      return res(200, { rows: data.questions[ep] ?? [] });
    return res(404, {});
  };
  return {
    fetch,
    urls,
    data,
    setDown: (d: boolean) => (down = d),
    exports: () => urls.filter((u) => u.includes('/listener-')),
    guide: () => urls.filter((u) => u.includes('/episode')),
  };
}

/** A socket the test drives by hand. */
function fakeSocket() {
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const s = {
    active: true,
    connects: 0,
    disconnected: false,
    authed: null as object | null,
    on: (e: string, fn: (...a: unknown[]) => void) => (handlers[e] = fn),
    connect: () => s.connects++,
    disconnect: () => (s.disconnected = true),
    emit: (e: string, ...a: unknown[]) => handlers[e]?.(...a),
  };
  const factory: SocketFactory = (_url, auth) => {
    auth((d) => (s.authed = d));
    return s as never;
  };
  return { s, factory };
}

function setup(over: Partial<ListenersConfig> = {}, start = at(2026, 9, 30, 18, 20)) {
  let clock = start;
  const eve = fakeEve();
  const sock = fakeSocket();
  const pushed: ListenerStatus[] = [];
  const feed = new ListenerFeed({
    cfg: {
      enabled: true,
      url: 'http://eve',
      app: 'station',
      username: 'studiobox',
      password: 'demo1234',
      pollSeconds: 45,
      ...over,
    },
    clock: () => clock,
    onChange: (s) => pushed.push(s),
    log: quiet,
    fetch: eve.fetch,
    socket: sock.factory,
  });
  return {
    feed,
    eve,
    sock,
    pushed,
    last: () => pushed[pushed.length - 1],
    setClock: (ms: number) => (clock = ms),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const settle = () => jest.advanceTimersByTimeAsync(0);

describe('selectFeedback', () => {
  it("keeps only the show's rows; no heart row is zero", () => {
    const out = selectFeedback(
      'x',
      {
        rows: [
          { id: '1', slug: 'x', text: 'a', receivedAt: '2026-09-30T10:00:00Z' },
          { id: '2', slug: 'y', text: 'b' },
        ],
      },
      { rows: [{ slug: 'y', hearts: 3 }] }
    );
    expect(out.comments.map((c) => c.id)).toEqual(['1']);
    expect(out.hearts).toBe(0);
  });
});

describe('ListenerFeed', () => {
  it('shows the released comments and hearts of the show on air, since its slot began', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    const s = t.last();
    expect(s.state).toBe('ok');
    expect(s.show).toMatchObject({
      slug: 'wochenmarkt',
      name: 'Wochenmarkt',
      startMs: at(2026, 9, 30, 18),
    });
    expect(s.hearts).toBe(7);
    expect(s.comments).toEqual([
      { id: 'c1', text: 'Grüße aus Gostenhof!', receivedAtMs: Date.parse('2026-09-30T16:11:00Z') },
    ]);
    const since = encodeURIComponent(new Date(at(2026, 9, 30, 18)).toISOString());
    expect(t.eve.exports()).toEqual([
      `/exports/station/listener-comments?since=${since}`,
      `/exports/station/listener-hearts?since=${since}`,
    ]);
    // The socket signs in with the device token.
    expect(t.sock.s.authed).toEqual({ token: 'h.e30.s' });
    t.feed.stop();
    expect(t.sock.s.disconnected).toBe(true);
  });

  it('refetches once for a burst of change events', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    const before = t.eve.exports().length;
    t.eve.data.hearts[0].hearts = 8;
    for (let i = 0; i < 5; i++)
      t.sock.s.emit('element:changed', { kind: 'created', id: String(i), aspects: ['status'] });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.eve.exports().length - before).toBe(2);
    expect(t.last().hearts).toBe(8);
    t.feed.stop();
  });

  it('pushes nothing when nothing the page shows changed', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    const n = t.pushed.length;
    await jest.advanceTimersByTimeAsync(45_000); // a poll with the same answer
    expect(t.pushed.length).toBe(n);
    t.feed.stop();
  });

  it('starts empty when the next show goes on air', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    t.setClock(at(2026, 9, 30, 19));
    // The screen empties on the slot check, before eve has answered.
    jest.advanceTimersByTime(5_000);
    const cleared = t.pushed.find((s) => s.show?.slug === 'stadtgefluester');
    expect(cleared).toMatchObject({ hearts: 0, comments: [] });
    await settle();
    expect(t.last()).toMatchObject({ show: { slug: 'stadtgefluester' }, hearts: 2 });
    expect(t.last().comments.map((c) => c.id)).toEqual(['c2']);
    const since = encodeURIComponent(new Date(at(2026, 9, 30, 19)).toISOString());
    expect(t.eve.exports().slice(-1)[0]).toBe(`/exports/station/listener-hearts?since=${since}`);
    t.feed.stop();
  });

  it('asks eve for nothing when the plan has no show on air', async () => {
    const t = setup({}, at(2026, 9, 30, 12));
    t.feed.start();
    await settle();
    expect(t.last()).toMatchObject({ show: null, state: 'ok' });
    expect(t.eve.exports()).toEqual([]);
    t.feed.stop();
  });

  it("uses eve's own window for a pinned show the plan does not have on air", async () => {
    const t = setup({ show: 'stadtgefluester' });
    t.feed.start();
    await settle();
    expect(t.last()).toMatchObject({
      pinned: true,
      show: { slug: 'stadtgefluester', name: 'Stadtgeflüster', startMs: null },
    });
    expect(t.eve.exports()).toEqual([
      '/exports/station/listener-comments',
      '/exports/station/listener-hearts',
    ]);
    t.feed.stop();
  });

  it('says so when eve is unreachable, keeps the last answer, and recovers', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    t.eve.setDown(true);
    await jest.advanceTimersByTimeAsync(46_000); // the poll, then the debounce
    expect(t.last()).toMatchObject({ state: 'offline', hearts: 7 });
    expect(t.last().comments).toHaveLength(1);
    t.eve.setDown(false);
    await jest.advanceTimersByTimeAsync(46_000);
    expect(t.last().state).toBe('ok');
    t.feed.stop();
  });

  it('knocks again, slower, when eve refuses the socket handshake', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    t.sock.s.active = false;
    t.sock.s.emit('connect_error', new Error('Invalid token'));
    await jest.advanceTimersByTimeAsync(4_999);
    expect(t.sock.s.connects).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(t.sock.s.connects).toBe(1);
    t.sock.s.emit('connect_error', new Error('Invalid token'));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(t.sock.s.connects).toBe(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(t.sock.s.connects).toBe(2);
    t.feed.stop();
  });

  it('never writes to eve', async () => {
    const t = setup();
    t.feed.start();
    await settle();
    t.sock.s.emit('element:changed', { kind: 'updated', id: 'x' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.eve.urls.filter((u) => !u.startsWith('/exports/') && u !== '/auth/login')).toEqual([]);
    t.feed.stop();
  });
});

describe('ListenerFeed — the episode guide', () => {
  const withGuide = (t: ReturnType<typeof setup>) => {
    t.eve.data.episodes = [
      {
        id: 'ep-markt',
        slug: 'wochenmarkt',
        title: 'Stadtbäume',
        airDate: '2026-09-30',
        status: 'freigegeben',
        repeat: null,
        opening: '*Jingle*',
        closing: 'Tschüss',
      },
      { id: 'ep-korn', slug: 'stadtgefluester', title: 'Herbst', airDate: '2026-09-30' },
      {
        id: 'ep-rerun',
        slug: 'stadtgefluester',
        title: 'Alt',
        airDate: '2026-09-30',
        repeat: true,
      },
    ];
    t.eve.data.topics['ep-markt'] = [
      { id: 't1', title: 'Linden', cue: 'Wer kennt die Linde?', body: '> Frage' },
      { id: 't2', title: 'Wasser', cue: null, body: null },
    ];
    t.eve.data.questions['ep-markt'] = [{ id: 'q1', text: 'Wer gießt?', asked: false }];
  };

  it('serves the episode of the show on air with its topics and questions', async () => {
    const t = setup();
    withGuide(t);
    t.feed.start();
    await settle();
    expect(t.last()).toMatchObject({
      guide: 'ok',
      episode: {
        id: 'ep-markt',
        title: 'Stadtbäume',
        opening: '<p><em>Jingle</em></p>',
        closing: '<p>Tschüss</p>',
        topics: [
          {
            id: 't1',
            title: 'Linden',
            cue: 'Wer kennt die Linde?',
            html: '<blockquote>Frage</blockquote>',
          },
          { id: 't2', title: 'Wasser', cue: '', html: '' },
        ],
        questions: [{ id: 'q1', text: 'Wer gießt?', asked: false }],
      },
    });
    expect(t.eve.guide()).toEqual([
      '/exports/station/episodes',
      '/exports/station/episode-topics?episode=ep-markt',
      '/exports/station/episode-questions?episode=ep-markt',
    ]);
    t.feed.stop();
  });

  it("switches to the next show's episode, empty until eve has answered", async () => {
    const t = setup();
    withGuide(t);
    t.feed.start();
    await settle();
    t.setClock(at(2026, 9, 30, 19));
    jest.advanceTimersByTime(5_000);
    const cleared = t.pushed.find((s) => s.show?.slug === 'stadtgefluester');
    expect(cleared).toMatchObject({ episode: null, guide: 'pending' });
    await settle();
    // The rerun is not the episode on air.
    expect(t.last()).toMatchObject({ guide: 'ok', episode: { id: 'ep-korn', topics: [] } });
    t.feed.stop();
  });

  it('says so when eve has no episode for the show', async () => {
    const t = setup();
    withGuide(t);
    t.eve.data.episodes = [];
    t.feed.start();
    await settle();
    expect(t.last()).toMatchObject({ guide: 'none', episode: null, state: 'ok' });
    t.feed.stop();
  });

  it('costs the listener feedback nothing on an eve without the exports', async () => {
    const t = setup(); // episodes: null -> 404
    t.feed.start();
    await settle();
    expect(t.last()).toMatchObject({ state: 'ok', hearts: 7, guide: 'unavailable' });
    // …and is not asked for again with every refetch.
    const n = t.eve.guide().length;
    t.sock.s.emit('element:changed', { kind: 'updated', id: 'x' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(t.eve.guide().length).toBe(n);
    t.feed.stop();
  });

  it('shows an edit of the episode at once, and hearts do not refetch it one by one', async () => {
    const t = setup();
    withGuide(t);
    t.feed.start();
    await settle();
    const n = t.eve.guide().length;
    // Three hearts: new elements and links, all within the guide's minimum age.
    for (let i = 0; i < 3; i++) {
      t.sock.s.emit('element:changed', {
        kind: 'created',
        id: `h${i}`,
        aspects: ['kind', 'status'],
      });
      t.sock.s.emit('relation:changed', { kind: 'created', id: `r${i}`, fromElementId: `h${i}` });
      await jest.advanceTimersByTimeAsync(1_000);
    }
    expect(t.eve.guide().length).toBe(n);
    // A question marked as asked in eve: the element is not the episode, so
    // it waits out the minimum age…
    t.eve.data.questions['ep-markt'][0].asked = true;
    t.sock.s.emit('element:changed', { kind: 'updated', id: 'q-elem', aspects: ['asked'] });
    await jest.advanceTimersByTimeAsync(10_000);
    t.sock.s.emit('element:changed', { kind: 'updated', id: 'q-elem', aspects: ['asked'] });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.last().episode?.questions[0].asked).toBe(true);
    // …while a topic added to the episode itself shows on the next fetch.
    t.eve.data.topics['ep-markt'].push({ id: 't3', title: 'Laub' });
    t.sock.s.emit('relation:changed', { kind: 'created', id: 'r9', fromElementId: 'ep-markt' });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(t.last().episode?.topics.map((x) => x.id)).toEqual(['t1', 't2', 't3']);
    t.feed.stop();
  });
});

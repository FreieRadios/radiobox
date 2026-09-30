import { EveError, EveSession, FetchLike, jwtExpiryMs } from '../../src/listeners/eve-session';

/** A JWT whose payload carries `exp` (the signature is never checked here). */
const jwt = (expSec: number, n = 0) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSec, n })).toString('base64url')}.s`;

interface Call {
  url: string;
  method: string;
  body?: unknown;
  auth?: string;
}

/** A tiny eve: /auth/login, single-use /auth/refresh, and one GET route that
 *  wants a token it issued. */
function fakeEve(now: () => number) {
  const calls: Call[] = [];
  let seq = 0;
  const live = new Set<string>();
  const refresh = new Set<string>();
  let password = 'demo1234';
  let down = false;
  const pair = () => {
    const token = jwt(Math.floor(now() / 1000) + 900, ++seq);
    const refreshToken = `r${seq}`;
    live.add(token);
    refresh.add(refreshToken);
    return { token, refreshToken };
  };
  const res = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  const fetch: FetchLike = async (url, init = {}) => {
    const path = url.replace('http://eve', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({
      url: path,
      method: init.method ?? 'GET',
      body,
      auth: init.headers?.authorization,
    });
    if (down) throw new Error('ECONNREFUSED');
    if (path === '/auth/login') {
      return body.password === password ? res(200, pair()) : res(401, { error: 'invalid' });
    }
    if (path === '/auth/refresh') {
      if (!refresh.delete(body.refreshToken)) return res(401, { error: 'invalid-session' });
      return res(200, pair());
    }
    const token = (init.headers?.authorization ?? '').replace('Bearer ', '');
    if (!live.has(token)) return res(401, { error: 'Unauthorized' });
    return res(200, { rows: [] });
  };
  return {
    fetch,
    calls,
    paths: () => calls.map((c) => c.url),
    revokeAll: () => live.clear(),
    forgetRefresh: () => refresh.clear(),
    setPassword: (p: string) => (password = p),
    setDown: (d: boolean) => (down = d),
  };
}

function setup() {
  let t = Date.UTC(2026, 8, 30, 12);
  const now = () => t;
  const eve = fakeEve(now);
  const session = new EveSession({
    url: 'http://eve/',
    username: 'studiobox',
    password: 'demo1234',
    fetch: eve.fetch,
    now,
  });
  return { eve, session, advance: (ms: number) => (t += ms) };
}

describe('jwtExpiryMs', () => {
  it('reads exp, and gives up quietly on anything else', () => {
    expect(jwtExpiryMs(jwt(1000))).toBe(1_000_000);
    expect(jwtExpiryMs('nonsense')).toBeNull();
  });
});

describe('EveSession', () => {
  it('signs in once and reuses the token', async () => {
    const { eve, session } = setup();
    await session.get('/exports/radio-z/listener-hearts');
    await session.get('/exports/radio-z/listener-hearts');
    expect(eve.paths()).toEqual([
      '/auth/login',
      '/exports/radio-z/listener-hearts',
      '/exports/radio-z/listener-hearts',
    ]);
    expect(eve.calls[1].auth).toMatch(/^Bearer h\./);
  });

  it('shares one sign-in between requests that start together', async () => {
    const { eve, session } = setup();
    await Promise.all([session.get('/a'), session.get('/b')]);
    expect(eve.paths().filter((p) => p === '/auth/login')).toHaveLength(1);
  });

  it('refreshes before the access token runs out', async () => {
    const { eve, session, advance } = setup();
    await session.get('/a');
    advance(14.5 * 60_000); // inside the last minute of 15
    await session.get('/a');
    expect(eve.paths()).toEqual(['/auth/login', '/a', '/auth/refresh', '/a']);
  });

  it('signs in again when the refresh token was already used', async () => {
    const { eve, session, advance } = setup();
    await session.get('/a');
    eve.forgetRefresh();
    advance(15 * 60_000);
    await session.get('/a');
    expect(eve.paths()).toEqual(['/auth/login', '/a', '/auth/refresh', '/auth/login', '/a']);
  });

  it('renews once on a 401 and retries the request', async () => {
    const { eve, session } = setup();
    await session.get('/a');
    eve.revokeAll();
    await session.get('/a');
    expect(eve.paths()).toEqual(['/auth/login', '/a', '/a', '/auth/refresh', '/a']);
  });

  it('reports refused credentials as denied, an unreachable eve as offline', async () => {
    const { eve, session } = setup();
    eve.setPassword('changed1');
    await expect(session.get('/a')).rejects.toMatchObject({ kind: 'denied' });
    eve.setDown(true);
    const err = await session.get('/a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EveError);
    expect((err as EveError).kind).toBe('offline');
  });

  it('only ever GETs outside of signing in', async () => {
    const { eve, session } = setup();
    await session.get('/a');
    const writes = eve.calls.filter((c) => c.method !== 'GET' && !c.url.startsWith('/auth/'));
    expect(writes).toEqual([]);
  });
});

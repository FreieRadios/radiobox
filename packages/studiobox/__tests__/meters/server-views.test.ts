import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { MeterSnapshot } from '../../src/dsp/graph';
import { MAX_BUFFERED_BYTES, MeterServer, toWire } from '../../src/meters/server';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

const get = (port: number, url: string): Promise<{ status: number; type: string; body: string }> =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: url }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body })
        );
      })
      .on('error', reject);
  });

/** Which view a response is, from its <title>. */
const view = (body: string): string => /<title>([^<]*)<\/title>/.exec(body)?.[1] ?? '?';

/** Open a socket; resolves once the hello arrived, collecting what follows. */
function connect(port: number, query: string): Promise<{ ws: WebSocket; got: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    const got: any[] = [];
    ws.once('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      got.push(msg);
      if (msg.type === 'hello') resolve({ ws, got });
    });
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));

const SNAPSHOT = {
  channels: [
    {
      label: 'Host',
      role: 'mic',
      outDb: -18,
      gateOpen: 1,
      compGrDb: 3,
      levelerDb: 2,
      automixGainDb: 0,
    },
    {
      label: 'Player',
      role: 'music',
      outDb: -12,
      gateOpen: 1,
      compGrDb: 0,
      levelerDb: 0,
      automixGainDb: 0,
    },
  ],
  limiterGrDb: 1,
  shortTermLufs: -16,
  outPeakDb: -4,
  micsMuted: false,
  filePlaying: 'a.mp3',
  recording: true,
  streaming: null,
  monitor: true,
  serverNowMs: 1000,
  air: { targetMs: 10000, delayMs: 10000, nowMs: 11000, state: 'live', drainEndsMs: null },
} as unknown as MeterSnapshot;

describe('MeterServer — views and what each role gets', () => {
  let server: MeterServer;
  let port: number;

  const boot = async (enabled: boolean) => {
    server = new MeterServer(0, makeLog(), {
      enabled,
      tokens: { tech: 'T', host: 'H', guest: 'G' },
    });
    server.onListFolders(() => [{ label: 'Programm', icon: '📻' }]);
    server.onListFiles(() => []);
    server.onListScheduled(() => []);
    server.onListQueue(() => [{ id: 1, folder: 0, name: 'a.mp3' }]);
    server.onResolveFile(() => null);
    server.start();
    const s = (server as unknown as { server: http.Server }).server;
    await new Promise<void>((r) => (s.listening ? r() : s.once('listening', () => r())));
    port = (s.address() as AddressInfo).port;
  };

  afterEach(() => server.stop());

  it('lets the token pick the view — the route alone opens nothing', async () => {
    await boot(true);
    const title = async (url: string) => view((await get(port, url)).body);
    expect(await title('/')).toBe('studiobox – Zuschauer');
    expect(await title('/tech')).toBe('studiobox – Zuschauer');
    expect(await title('/host?k=nope')).toBe('studiobox – Zuschauer');
    expect(await title('/tech?k=T')).toBe('studiobox');
    expect(await title('/host?k=H')).toBe('studiobox');
    expect(await title('/?k=T')).toBe('studiobox');
    expect(await title('/guest?k=G')).toBe('studiobox – Gast');
    // A guest token never gets the operators' page, whatever it asks for.
    expect(await title('/tech?k=G')).toBe('studiobox – Gast');
    // An operator may look at the other views.
    expect(await title('/guest?k=T')).toBe('studiobox – Gast');
    expect(await title('/spectator?k=T')).toBe('studiobox – Zuschauer');
  });

  it('keeps the box as it was with roles disabled: / is the page', async () => {
    await boot(false);
    expect(view((await get(port, '/')).body)).toBe('studiobox');
    expect(view((await get(port, '/guest')).body)).toBe('studiobox – Gast');
    expect(view((await get(port, '/spectator')).body)).toBe('studiobox – Zuschauer');
    expect((await get(port, '/folders')).status).toBe(200);
  });

  it('serves what the views share, and nothing else from the folder', async () => {
    await boot(true);
    const css = await get(port, '/tokens.css');
    expect(css.status).toBe(200);
    expect(css.type).toContain('text/css');
    expect(css.body).toContain('--onair');
    const js = await get(port, '/meter.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('javascript');
    expect((await get(port, '/guest.html')).status).toBe(404); // views only via their routes
    expect((await get(port, '/../roles.ts')).status).toBe(404);
    expect((await get(port, '/public/meter.js')).status).toBe(404);
  });

  it('hands the role links and their QR codes to the technician only', async () => {
    await boot(true);
    server.setMics(['Host', 'Gast 1']);
    for (const q of ['', '?k=nope', '?k=H', '?k=G']) {
      expect((await get(port, `/connect${q}`)).status).toBe(403);
    }
    const res = await get(port, '/connect?k=T');
    expect(res.status).toBe(200);
    const d = JSON.parse(res.body);
    expect(d).toMatchObject({ enabled: true, pinned: true });
    expect(d.links.map((l: any) => l.label)).toEqual([
      'Technik',
      'Host',
      'Gäste',
      'Gäste: Host',
      'Gäste: Gast 1',
      'Zuschauer',
    ]);
    for (const l of d.links) expect(l.svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    // A scanned guest code opens the guest view with its mic chosen.
    const guest = new URL(d.links.find((l: any) => l.mic === 'Gast 1').url);
    expect(guest.pathname).toBe('/guest');
    expect(guest.searchParams.get('mic')).toBe('Gast 1');
    expect(view((await get(port, guest.pathname + guest.search)).body)).toBe('studiobox – Gast');
  });

  it('points the codes at the address the technician used, unless that is the box', async () => {
    await boot(true);
    const linksVia = (host: string): Promise<string[]> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/connect?k=T', headers: { host } }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(JSON.parse(body).links.map((l: any) => l.url)));
          })
          .on('error', reject);
      });
    expect((await linksVia('studio.local:4445'))[0]).toBe('http://studio.local:4445/tech?k=T');
    const viaLocal = (await linksVia(`localhost:${port}`))[0];
    expect(viaLocal).not.toContain('localhost:');
    expect(viaLocal).toMatch(new RegExp(`:${port}/tech\\?k=T$`));
    // Nothing odd from the header makes it into a link.
    expect((await linksVia('evil"/x'))[0]).not.toContain('evil');
  });

  it('shows the configured logo in the headers, or the word without one', async () => {
    await boot(false);
    expect((await get(port, '/logo')).status).toBe(404);
    expect((await get(port, '/')).body).toContain('title="Quellen anzeigen">studiobox</button>');
    server.stop();
    const logo = path.join(__dirname, '../../config/logo-z.svg');
    server = new MeterServer(
      0,
      makeLog(),
      { enabled: true, tokens: { tech: 'T' } },
      {
        logo,
        logoAlt: 'Radio Z <live>',
      }
    );
    server.start();
    const s = (server as unknown as { server: http.Server }).server;
    await new Promise<void>((r) => (s.listening ? r() : s.once('listening', () => r())));
    port = (s.address() as AddressInfo).port;
    const img = '<img class="brand" src="logo" alt="Radio Z &#60;live&#62;">';
    expect((await get(port, '/tech?k=T')).body).toContain(img);
    expect((await get(port, '/')).body).toContain(`<h1 id="brand">${img}</h1>`); // spectator
    // Every view shows it, so nobody needs a token for it.
    const res = await get(port, '/logo');
    expect(res.status).toBe(200);
    expect(res.type).toBe('image/svg+xml');
    expect(res.body).toContain('<svg');
  });

  it('streams "Abhören" to the technician only', async () => {
    await boot(true);
    expect((await get(port, '/listen?id=tab-1&src=rec&k=T')).status).toBe(404); // no hub
    const asked: string[] = [];
    server.onListen((id, src, res) => {
      asked.push(`${id} ${src}`);
      if (src === 'nope') return 'bad';
      if (src === 'air') return 'full';
      setImmediate(() => res.end('ID3'));
      return 'ok';
    });
    for (const q of ['', '&k=nope', '&k=H', '&k=G']) {
      expect((await get(port, `/listen?id=tab-1&src=rec${q}`)).status).toBe(403);
    }
    expect(asked).toEqual([]);
    const ok = await get(port, '/listen?id=tab-1&src=rec&k=T');
    expect(ok.status).toBe(200);
    expect(ok.type).toBe('audio/mpeg');
    expect(ok.body).toBe('ID3');
    expect((await get(port, '/listen?id=tab-1&src=nope&k=T')).status).toBe(400);
    expect((await get(port, '/listen?id=tab-1&src=air&k=T')).status).toBe(503);
    expect(asked).toEqual(['tab-1 rec', 'tab-1 nope', 'tab-1 air']);
  });

  it('serves the programme stream to the stream token and operators, never open', async () => {
    server = new MeterServer(0, makeLog(), {
      enabled: true,
      tokens: { tech: 'T', host: 'H', guest: 'G', stream: 'S' },
    });
    server.start();
    const s = (server as unknown as { server: http.Server }).server;
    await new Promise<void>((r) => (s.listening ? r() : s.once('listening', () => r())));
    port = (s.address() as AddressInfo).port;
    expect((await get(port, '/stream?k=S')).status).toBe(404); // not configured
    let on = true;
    server.onStream(
      (format, res) => {
        if (format === 'wav') return 'bad';
        if (!on) return 'off';
        setImmediate(() => res.end('OggS'));
        return 'ok';
      },
      (format) => (format === 'mp3' ? 'audio/mpeg' : 'audio/ogg')
    );
    for (const q of ['', '?k=nope', '?k=G']) {
      expect((await get(port, `/stream${q}`)).status).toBe(403);
    }
    for (const k of ['S', 'T', 'H']) {
      const r = await get(port, `/stream?format=flac&k=${k}`);
      expect(r.status).toBe(200);
      expect(r.type).toBe('audio/ogg');
      expect(r.body).toBe('OggS');
    }
    expect((await get(port, '/stream?format=mp3&k=S')).type).toBe('audio/mpeg');
    expect((await get(port, '/stream?format=wav&k=S')).status).toBe(400);
    on = false;
    const off = await get(port, '/stream?k=S');
    expect(off.status).toBe(503);
    expect(off.body).toBe('stream off\n');
  });

  it('answers 403 on the file tree without an operator token', async () => {
    await boot(true);
    for (const url of [
      '/folders',
      '/files?folder=0',
      '/scheduled',
      '/preview?folder=0&name=a.mp3',
    ]) {
      expect((await get(port, url)).status).toBe(403);
      expect((await get(port, url + (url.includes('?') ? '&' : '?') + 'k=G')).status).toBe(403);
    }
    expect((await get(port, '/folders?k=H')).status).toBe(200);
    expect((await get(port, '/files?folder=0&k=T')).status).toBe(200);
    expect((await get(port, '/scheduled?k=H')).status).toBe(200);
    // Allowed through the gate; the (stub) resolver then finds no such file.
    expect((await get(port, '/preview?folder=0&name=a.mp3&k=H')).status).toBe(404);
  });

  it('sends each role its cut of the snapshot, and the play list to operators only', async () => {
    await boot(true);
    const tech = await connect(port, 'tech?k=T');
    const guest = await connect(port, 'guest?k=G');
    const spec = await connect(port, '');
    await settle();
    server.broadcast(SNAPSHOT);
    server.broadcastQueue([{ id: 2, folder: 0, name: 'b.mp3' }]);
    await settle();

    expect(tech.got.map((m) => m.type ?? 'snapshot')).toEqual([
      'hello',
      'queue',
      'snapshot',
      'queue',
    ]);
    expect(tech.got[0]).toMatchObject({ role: 'tech', tz: expect.any(String) });
    expect(tech.got[2].recording).toBe(true);
    expect(tech.got[2].onAir).toBe(true);
    expect(tech.got[2].channels).toHaveLength(2);

    expect(guest.got.map((m) => m.type ?? 'snapshot')).toEqual(['hello', 'snapshot']);
    expect(guest.got[1].channels.map((c: { label: string }) => c.label)).toEqual(['Host']);
    expect(guest.got[1].channels[0]).not.toHaveProperty('compGrDb');
    expect(guest.got[1]).not.toHaveProperty('recording');
    expect(guest.got[1].onAir).toBe(true);

    expect(spec.got.map((m) => m.type ?? 'snapshot')).toEqual(['hello', 'snapshot']);
    expect(spec.got[1]).not.toHaveProperty('channels');
    expect(spec.got[1].filePlaying).toBe('a.mp3');
    expect(spec.got[1].onAir).toBe(true);

    for (const c of [tech, guest, spec]) c.ws.close();
  });
});

describe('MeterServer — meter frames on a slow link', () => {
  /** A connection as broadcast() sees it, with a send buffer we control. */
  const fakeClient = (bufferedAmount: number) => ({
    readyState: WebSocket.OPEN,
    bufferedAmount,
    sent: [] as string[],
    send(m: string) {
      this.sent.push(m);
    },
  });

  it('skips a frame for a connection that has not taken the last one', () => {
    const server = new MeterServer(0, makeLog());
    const wss = (server as unknown as { wss: { clients: Set<unknown> } }).wss;
    const fast = fakeClient(0);
    const slow = fakeClient(MAX_BUFFERED_BYTES + 1);
    wss.clients.add(fast);
    wss.clients.add(slow);
    server.broadcast(SNAPSHOT);
    expect(fast.sent).toHaveLength(1);
    expect(slow.sent).toHaveLength(0);
    // Caught up: it gets the newest frame, not the ones it missed.
    slow.bufferedAmount = 0;
    server.broadcast({ ...SNAPSHOT, outPeakDb: -6 } as MeterSnapshot);
    expect(slow.sent.map((m) => JSON.parse(m).outPeakDb)).toEqual([-6]);
    server.stop();
  });

  it('cuts fractions to two decimals and keeps whole numbers', () => {
    expect(
      JSON.parse(toWire({ a: -18.123456, b: 1759400000123, c: [0.005, -0.004], d: 'x' }))
    ).toEqual({
      a: -18.12,
      b: 1759400000123,
      c: [0.01, 0],
      d: 'x',
    });
  });
});

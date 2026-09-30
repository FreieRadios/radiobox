import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { MeterCommand, MeterServer } from '../../src/meters/server';
import { ListenerStatus } from '../../src/listeners/feed';

const makeLog = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/** Open a socket and resolve with it once the server's hello arrived. */
function connect(port: number, query: string): Promise<{ ws: WebSocket; role: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
    ws.once('error', reject);
    ws.once('message', (raw) => resolve({ ws, role: JSON.parse(raw.toString()).role }));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('MeterServer role enforcement', () => {
  let server: MeterServer;
  let port: number;
  let got: MeterCommand[];

  const boot = async (enabled: boolean) => {
    server = new MeterServer(0, makeLog(), {
      enabled,
      tokens: { tech: 'T', host: 'H', guest: 'G' },
    });
    got = [];
    server.onCommand((c) => got.push(c));
    server.start();
    // `port` 0 = any free port; read back what the OS gave us.
    const http = (server as unknown as { server: import('node:http').Server }).server;
    await new Promise<void>((r) => (http.listening ? r() : http.once('listening', () => r())));
    port = (http.address() as AddressInfo).port;
  };

  afterEach(() => server.stop());

  it('a guest connection sending micsMuted changes nothing', async () => {
    await boot(true);
    const { ws, role } = await connect(port, 'guest?k=G');
    expect(role).toBe('guest');
    ws.send(JSON.stringify({ type: 'micsMuted', value: true }));
    ws.send(JSON.stringify({ type: 'playFile', value: { folder: 0, name: 'x.flac' } }));
    await settle();
    expect(got).toEqual([]);
    ws.close();
  });

  it('a connection without a token is read-only', async () => {
    await boot(true);
    const { ws, role } = await connect(port, '');
    expect(role).toBe('spectator');
    ws.send(JSON.stringify({ type: 'recording', value: true }));
    await settle();
    expect(got).toEqual([]);
    ws.close();
  });

  it('the host may mute the mics but not stop the recording', async () => {
    await boot(true);
    const { ws, role } = await connect(port, 'host?k=H');
    expect(role).toBe('host');
    ws.send(JSON.stringify({ type: 'micsMuted', value: true }));
    ws.send(JSON.stringify({ type: 'recording', value: false }));
    await settle();
    expect(got).toEqual([{ type: 'micsMuted', value: true }]);
    ws.close();
  });

  it('the technician may do everything; malformed messages are ignored', async () => {
    await boot(true);
    const { ws } = await connect(port, 'tech?k=T');
    ws.send('not json');
    ws.send(JSON.stringify({ value: 1 }));
    ws.send(JSON.stringify({ type: 'recording', value: true }));
    await settle();
    expect(got).toEqual([{ type: 'recording', value: true }]);
    ws.close();
  });

  it('listener feedback reaches the operators only, on connect and on change', async () => {
    const status: ListenerStatus = {
      show: null,
      pinned: false,
      hearts: 3,
      comments: [],
      episode: null,
      guide: 'none',
      state: 'ok',
      updatedMs: 1,
    };
    server = new MeterServer(0, makeLog(), {
      enabled: true,
      tokens: { tech: 'T', host: 'H', guest: 'G' },
    });
    server.onListListeners(() => status);
    server.start();
    const http = (server as unknown as { server: import('node:http').Server }).server;
    await new Promise<void>((r) => (http.listening ? r() : http.once('listening', () => r())));
    port = (http.address() as AddressInfo).port;
    // Collect from the first frame on: the push follows the hello at once.
    const open = (query: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
      const types: string[] = [];
      ws.on('message', (raw) => types.push(JSON.parse(raw.toString()).type));
      return new Promise<{ ws: WebSocket; types: string[] }>((r) =>
        ws.once('open', () => r({ ws, types }))
      );
    };
    const host = await open('host?k=H');
    const guest = await open('guest?k=G');
    const spectator = await open('');
    await settle();
    server.broadcastListeners({ ...status, hearts: 4 });
    await settle();
    expect(host.types.filter((t) => t === 'listeners')).toHaveLength(2);
    expect(guest.types).toEqual(['hello']);
    expect(spectator.types).toEqual(['hello']);
    [host, guest, spectator].forEach((c) => c.ws.close());
  });

  it('with roles disabled every connection may send commands (playout box)', async () => {
    await boot(false);
    const { ws, role } = await connect(port, '');
    expect(role).toBe('tech');
    ws.send(JSON.stringify({ type: 'stopFile' }));
    await settle();
    expect(got).toEqual([{ type: 'stopFile' }]);
    ws.close();
  });
});

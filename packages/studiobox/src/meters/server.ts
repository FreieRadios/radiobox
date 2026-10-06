import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { MeterSnapshot } from '../dsp/graph';
import { FileEntry, FolderEntry } from '../audio/file-dirs';
import { QueueItem } from '../audio/play-queue';
import { ListenerStatus } from '../listeners/feed';
import { ScheduleEntry } from '../schedule';
import { RolesConfig } from '../config/schema';
import { pickLanAddress } from '../util/lan';
import { Log } from '../util/log';
import { RoleLink, Roles, ViewRole } from './roles';
import { Snapshot, guestSnapshot, onAirOf, spectatorSnapshot } from './wire';

/** Routes that serve a view (see `Roles.urls`, and `viewFor` for which one). */
const VIEW_ROUTES = new Set(['/', '/index.html', '/tech', '/host', '/guest', '/spectator']);

/** Routes that expose the file tree: operators only (technician, host). */
const DATA_ROUTES = new Set(['/folders', '/files', '/scheduled', '/preview']);

/** The role links with their QR codes ("Geräte verbinden"): the keys to the
 *  session, so the technician's alone. */
const CONNECT_ROUTE = '/connect';

/** "Abhören": the technician's MP3 stream of what is recorded or aired. */
const LISTEN_ROUTE = '/listen';

/** The guest and spectator views and what they share, as real files (no
 *  build step; the technician/host page still lives in `PAGE` below until it
 *  moves out too). Only these names are ever read — nothing from the request
 *  reaches the filesystem. */
const PUBLIC_FILES: Record<string, string> = {
  '/tokens.css': 'text/css; charset=utf-8',
  '/meter.js': 'text/javascript; charset=utf-8',
  '/guest.html': 'text/html; charset=utf-8',
  '/spectator.html': 'text/html; charset=utf-8',
};

/** `public/` beside this file: under ts-node that is the source folder, in a
 *  build it is the copy in `dist/` — or, if the build didn't copy it, the
 *  source folder of the checkout the build runs from. */
const PUBLIC_DIR =
  [path.join(__dirname, 'public'), path.join(__dirname, '../../src/meters/public')].find((d) =>
    fs.existsSync(d)
  ) ?? path.join(__dirname, 'public');

const isOperator = (role: ViewRole): boolean => role === 'tech' || role === 'host';

/** Unsent bytes a connection may hold before it skips meter frames: about
 *  one snapshot, so a slow client is never more than a frame behind. */
export const MAX_BUFFERED_BYTES = 16 * 1024;

/** A snapshot as JSON with its fractions cut to two decimals: the meters are
 *  dB and seconds, and the DSP's full float precision only made every frame
 *  several times longer on the air. Whole numbers (clock times) are kept. */
export const toWire = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === 'number' && !Number.isInteger(x) && Number.isFinite(x)
      ? Math.round(x * 100) / 100
      : x
  );

/** Content types for the "Vorhören" (browser preview) route. Every one of
 *  these plays natively in current browsers, so preview streams the file's own
 *  bytes — no transcode, no extra ffmpeg, ~zero CPU on a small box, and the
 *  browser gets real seeking and duration via HTTP range requests. Formats not
 *  listed here (.aiff/.wma) are not previewable and the UI says so rather than
 *  spending a Pi's CPU budget transcoding them next to the on-air chain. */
const PREVIEW_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
};

/** True when the browser can play this file directly (see PREVIEW_TYPES). */
export function isPreviewable(name: string): boolean {
  return path.extname(name).toLowerCase() in PREVIEW_TYPES;
}

/** Headless metering: serves a tiny self-contained page and pushes meter
 *  snapshots over WebSocket at the configured frame rate. In playout mode the
 *  snapshot carries no channels and the page hides the metering section,
 *  showing only the file list (with auto-play schedule marks) and transport.
 *
 *  Control protocol (client -> server, JSON over WebSocket):
 *   - { type: 'micsMuted', value: boolean }  toggle "music only" mode
 *   - { type: 'channelMuted', value: { label, muted } } mute/unmute one channel
 *   - { type: 'recording', value: boolean }  start/stop the local FLAC recording
 *   - { type: 'streaming', value: boolean }  start/stop shipping to the harbor
 *   - { type: 'monitor', value: boolean }    start/stop local hardware playout
 *   - { type: 'playFile', value: { folder, name } } play a file from a folder
 *   - { type: 'stopFile' }                    stop local file playback
 *   - { type: 'queueAdd', value: { folder, name } | { items: [...] } } enqueue
 *   - { type: 'queueRemove', value: { id } }   drop one pending item
 *   - { type: 'queueMove', value: { id, delta } } reorder one pending item
 *   - { type: 'queueClear' }                  drop the whole pending list
 *   - { type: 'queuePlay', value: { id } }     jump to a pending item now
 *   - { type: 'queueStart' }                  start the head of the queue
 *   - { type: 'queueMode', value: 'single' | 'chain' } "einzeln" / "durchlaufen"
 *  Live mode only:
 *   - { type: 'musicReturn', value: boolean } start/stop the music return output
 *   - { type: 'returnGain', value: dB }       level of the music return
 *   - { type: 'musicGain', value: dB }        level of the music on air
 *   - { type: 'listen', value: { id, src } }  "Abhören": switch a listener's
 *                                             source (rec | raw | mic:<label> | air)
 *   - { type: 'endShow', value?: false }      "Sendung beenden" (false cancels)
 *   - { type: 'testTone', value: boolean }    1 kHz alignment tone on the monitor
 *   - { type: 'priorityDepth', value: dB }    host-priority depth
 *   - { type: 'trim', value: { label, trimDb } } one mic's input trim
 *   - { type: 'setupStart', value?: { only: [label] } } start "Einmessen"
 *   - { type: 'setupFinish' | 'setupApply' | 'setupDiscard' | 'setupCancel' }
 *  Every connection has a role (tech | host | guest | spectator), taken from
 *  the `?k=<token>` of its WebSocket URL and announced as the first message,
 *  { type: 'hello', role, tz }; commands outside the role's allowlist are
 *  dropped (see `roles.ts`). With `meters.roles` disabled everybody is `tech`.
 *  The role also decides what a connection is told: guests and spectators get
 *  a cut-down snapshot and no play list (see `wire.ts`), and the HTTP routes
 *  that expose the file tree answer 403 without an operator's token.
 *  Every snapshot carries `onAir` (see `onAirOf`).
 *  The pending play list is pushed to every client as { type: 'queue', items }
 *  whenever it changes (and once per new connection), rather than riding along
 *  in the meter frames — it changes rarely and the frames are hot. Listener
 *  feedback from eve (released comments and the heart count of the show on
 *  air) travels the same way, as { type: 'listeners', status }, to operators
 *  only; nothing on the page writes back to eve.
 *  The configured folders are served over HTTP at `/folders`, the listing of
 *  one folder (or a subdirectory inside it) at `/files?folder=N&path=REL`
 *  (subdirectory rows carry `dir:true`; file rows the parsed auto-play
 *  timestamp; plus the server clock for skew-free comparison), and every
 *  future-scheduled file across all folders at `/scheduled`. */
export interface MeterCommand {
  type: string;
  value?: unknown;
}

export class MeterServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private onCmd: ((cmd: MeterCommand) => void) | null = null;
  private onList: ((folder: number, sub: string) => FileEntry[] | Promise<FileEntry[]>) | null =
    null;
  private onFolders: (() => FolderEntry[]) | null = null;
  private onScheduled: (() => ScheduleEntry[]) | null = null;
  private onResolve: ((folder: number, name: string) => string | null) | null = null;
  private onQueue: (() => QueueItem[]) | null = null;
  private onListeners: (() => ListenerStatus) | null = null;
  private onListenReq:
    | ((id: string, src: string, res: http.ServerResponse) => 'ok' | 'bad' | 'full')
    | null = null;
  /** Role tokens and the links to hand out (see `Roles`). */
  readonly roles: Roles;
  /** The role each open connection was given when it connected. */
  private roleOfWs = new WeakMap<WebSocket, ViewRole>();
  /** Mic labels, for one guest link per mic (`setMics`). */
  private mics: string[] = [];

  constructor(
    private port: number,
    private log: Log,
    roles: RolesConfig = { enabled: false, tokens: {} }
  ) {
    this.roles = new Roles(roles);
    this.server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      const role = this.roles.roleOf(req.url);
      if (VIEW_ROUTES.has(url)) {
        this.serveView(url, role, res);
      } else if (url in PUBLIC_FILES && !url.endsWith('.html')) {
        this.servePublic(url, res);
      } else if (url === CONNECT_ROUTE) {
        this.serveConnect(req, role, res);
      } else if (url === LISTEN_ROUTE) {
        this.serveListen(req, role, res);
      } else if (DATA_ROUTES.has(url) && !isOperator(role)) {
        // Hiding the file browser is not the protection — this is.
        res.writeHead(403);
        res.end();
      } else if (url === '/folders') {
        const folders = this.onFolders ? this.onFolders() : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ folders }));
      } else if (url === '/files') {
        const q = new URL(req.url ?? '/', 'http://localhost');
        const folder = Number(q.searchParams.get('folder') ?? '0') || 0;
        const sub = q.searchParams.get('path') ?? '';
        Promise.resolve(this.onList ? this.onList(folder, sub) : [])
          .then((files) => {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ files, now: Date.now() }));
          })
          .catch((err: unknown) => {
            this.log.warn(`file listing failed: ${(err as Error).message}`);
            res.writeHead(500);
            res.end();
          });
      } else if (url === '/scheduled') {
        const scheduled = this.onScheduled ? this.onScheduled() : [];
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ scheduled, now: Date.now() }));
      } else if (url === '/preview') {
        this.servePreview(req, res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => {
      // The role comes from the token in the connection URL (`?k=…`), never
      // from what the page claims: commands outside its allowlist are dropped.
      const role = this.roles.roleOf(req.url);
      this.roleOfWs.set(ws, role);
      ws.send(JSON.stringify({ type: 'hello', role, tz: SERVER_TZ }));
      // A fresh page knows nothing about the pending list until it changes,
      // so hand it over on connect (to those who get to see it).
      if (this.onQueue && isOperator(role)) {
        ws.send(JSON.stringify({ type: 'queue', items: this.onQueue() }));
      }
      if (this.onListeners && isOperator(role)) {
        ws.send(JSON.stringify({ type: 'listeners', status: this.onListeners() }));
      }
      ws.on('message', (raw) => {
        let cmd: MeterCommand;
        try {
          cmd = JSON.parse(raw.toString()) as MeterCommand;
        } catch {
          return; // ignore malformed control messages
        }
        if (!cmd || typeof cmd.type !== 'string') return;
        if (!this.roles.allows(role, cmd.type)) {
          this.log.warn(`dropped "${cmd.type}" from a ${role} connection`);
          return;
        }
        this.onCmd?.(cmd);
      });
    });
  }

  /** "Abhören": hand a listening request (`/listen?id=…&src=…`) to the
   *  pipeline, which streams MP3 into the response. */
  onListen(fn: (id: string, src: string, res: http.ServerResponse) => 'ok' | 'bad' | 'full'): void {
    this.onListenReq = fn;
  }

  /** `/listen`: the technician's alone — it carries the room, unprocessed. */
  private serveListen(req: http.IncomingMessage, role: ViewRole, res: http.ServerResponse): void {
    if (role !== 'tech') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (!this.onListenReq) {
      res.writeHead(404);
      res.end();
      return;
    }
    const q = new URL(req.url ?? '/', 'http://localhost');
    // The hub only writes once the encoder has output, so the head can
    // follow the decision.
    const ok = this.onListenReq(
      q.searchParams.get('id') ?? '',
      q.searchParams.get('src') ?? '',
      res
    );
    if (ok !== 'ok') {
      res.writeHead(ok === 'full' ? 503 : 400);
      res.end();
      return;
    }
    // A live stream: no length, no ranges (Safari's `bytes=0-1` probe gets
    // the stream too, as from an Icecast), never cached.
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  }

  /** The mics a guest can sit at: each gets its own guest link. */
  setMics(labels: readonly string[]): void {
    this.mics = [...labels];
  }

  /** The links to hand out, for the address the tablets reach this box at. */
  links(base = `http://${lanAddress()}:${this.listenPort()}`): RoleLink[] {
    return this.roles.links(base, this.mics);
  }

  /** The port actually listened on (the configured one may be 0 = any). */
  private listenPort(): number {
    const a = this.server.address();
    return a && typeof a === 'object' ? a.port : this.port;
  }

  /** `/connect`: every role link with its QR code as SVG, for the
   *  technician's "Geräte verbinden". The address is the one the technician's
   *  browser used, so the codes lead where the page came from — unless that
   *  was the box itself (localhost), which no tablet can reach. */
  private serveConnect(req: http.IncomingMessage, role: ViewRole, res: http.ServerResponse): void {
    if (role !== 'tech') {
      res.writeHead(403);
      res.end();
      return;
    }
    const host = req.headers.host ?? '';
    const local = /^(localhost|127\.[\d.]+|\[::1\])(:\d+)?$/i.test(host);
    const base =
      !local && /^[\w.-]+(:\d+)?$|^\[[\da-f:.]+\](:\d+)?$/i.test(host)
        ? `http://${host}`
        : undefined;
    const links = this.links(base);
    Promise.all(
      links.map((l) =>
        QRCode.toString(l.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
      )
    )
      .then((svgs) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(
          JSON.stringify({
            enabled: this.roles.enabled,
            pinned: this.roles.pinned,
            links: links.map((l, i) => ({ ...l, svg: svgs[i] })),
          })
        );
      })
      .catch((err: unknown) => {
        this.log.warn(`QR codes failed: ${(err as Error).message}`);
        res.writeHead(500);
        res.end();
      });
  }

  /** Which view a route shows. The token decides, never the route alone:
   *  the operators' page only goes to a technician or host connection, a
   *  guest token gets the guest view whatever it asks for, and everything
   *  else is the spectator view. With roles disabled every connection is a
   *  technician: `/` is then the page (as on a playout box) and `/guest` and
   *  `/spectator` show those views. */
  private viewFor(url: string, role: ViewRole): 'page' | '/guest.html' | '/spectator.html' {
    if (url === '/spectator' || role === 'spectator') return '/spectator.html';
    if (url === '/guest' || role === 'guest') return '/guest.html';
    return 'page';
  }

  private serveView(url: string, role: ViewRole, res: http.ServerResponse): void {
    const view = this.viewFor(url, role);
    if (view !== 'page') {
      this.servePublic(view, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE.replace('__SERVER_TZ__', SERVER_TZ));
  }

  /** One of the `PUBLIC_FILES`, read per request: they are a few kB, asked
   *  for once per page load, and an edit shows up without a restart. */
  private servePublic(name: string, res: http.ServerResponse): void {
    fs.readFile(path.join(PUBLIC_DIR, name), (err, body) => {
      if (err) {
        this.log.warn(`view file missing: ${name} (${err.message})`);
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': PUBLIC_FILES[name], 'cache-control': 'no-store' });
      res.end(body);
    });
  }

  /** Register a handler for control messages sent from the meters page. */
  onCommand(fn: (cmd: MeterCommand) => void): void {
    this.onCmd = fn;
  }

  /** Register the provider for the `/files` directory listing. */
  onListFiles(fn: (folder: number, sub: string) => FileEntry[] | Promise<FileEntry[]>): void {
    this.onList = fn;
  }

  /** Register the provider for the `/folders` dropdown listing. */
  onListFolders(fn: () => FolderEntry[]): void {
    this.onFolders = fn;
  }

  /** Register the provider for the `/scheduled` upcoming-files listing. */
  onListScheduled(fn: () => ScheduleEntry[]): void {
    this.onScheduled = fn;
  }

  /** Register the provider for the pending play list (sent on connect). */
  onListQueue(fn: () => QueueItem[]): void {
    this.onQueue = fn;
  }

  /** Push the pending play list to every connected operator page. */
  broadcastQueue(items: QueueItem[]): void {
    const msg = JSON.stringify({ type: 'queue', items });
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (isOperator(this.roleOfWs.get(client) ?? 'spectator')) client.send(msg);
    }
  }

  /** Register the provider for listener feedback (sent on connect). */
  onListListeners(fn: () => ListenerStatus): void {
    this.onListeners = fn;
  }

  /** Push listener feedback to every connected operator page. */
  broadcastListeners(status: ListenerStatus): void {
    const msg = JSON.stringify({ type: 'listeners', status });
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (isOperator(this.roleOfWs.get(client) ?? 'spectator')) client.send(msg);
    }
  }

  /** Register the traversal-safe folder+name -> absolute path resolver that
   *  `/preview` uses (the same one that starts real playout). */
  onResolveFile(fn: (folder: number, name: string) => string | null): void {
    this.onResolve = fn;
  }

  /** "Vorhören": stream a file to the operator's browser for pre-listening.
   *  Deliberately a plain byte range server, NOT a transcode: the browser
   *  decodes the file itself, so this costs no CPU next to the on-air chain
   *  and cannot disturb playout (it never touches the file player, the DSP
   *  graph or the monitor). Honours Range so seeking works. */
  private servePreview(req: http.IncomingMessage, res: http.ServerResponse): void {
    const q = new URL(req.url ?? '/', 'http://localhost');
    const folder = Number(q.searchParams.get('folder') ?? '0') || 0;
    const name = q.searchParams.get('name') ?? '';
    const file = this.onResolve && name ? this.onResolve(folder, name) : null;
    const type = file ? PREVIEW_TYPES[path.extname(file).toLowerCase()] : undefined;
    if (!file || !type) {
      res.writeHead(404);
      res.end();
      return;
    }
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    // Range: "bytes=start-[end]" — the only form browsers send for <audio>.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    };
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        // Suffix form ("last N bytes").
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (!(start >= 0) || start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    // A reload or a skip to the next file aborts the request mid-flight; tear
    // the read down so a slow (e.g. SMB) source isn't left streaming.
    const close = () => stream.destroy();
    res.on('close', close);
    stream.on('error', (err: Error) => {
      this.log.warn(`preview failed for ${path.basename(file)}: ${err.message}`);
      res.destroy();
    });
    stream.pipe(res);
  }

  start(): void {
    this.server.listen(this.port, () => {
      this.log.info(`meters on http://localhost:${this.port}`);
      if (!this.roles.enabled) return;
      // Role links for the tablets. Anything opened without a token is
      // read-only, so these lines are the keys to the session.
      const links = this.links();
      const w = Math.max(...links.map((l) => l.label.length)) + 1;
      this.log.info(`role links (a connection without a token is read-only):`);
      for (const l of links) this.log.info(`  ${`${l.label}:`.padEnd(w)} ${l.url}`);
      this.log.info(
        this.roles.pinned
          ? `QR codes: ⋮ → Geräte verbinden on the technician's page`
          : `QR codes: ⋮ → Geräte verbinden; the tokens are new at every start ` +
              `(pin meters.roles.tokens so printed codes stay good)`
      );
    });
  }

  /** Push a meter snapshot to every connection, each in the cut its role
   *  gets (serialized once per cut, and only for cuts somebody listens to).
   *  A connection that has not taken the last frame yet (a tablet on a slow
   *  WLAN) skips this one: snapshots are state, not events, so it gets the
   *  newest when it catches up instead of a queue that falls ever further
   *  behind — and the queue/listener pushes behind it are not held up. */
  broadcast(snapshot: MeterSnapshot): void {
    const s: Snapshot = snapshot;
    const onAir = onAirOf(s);
    const cuts: { full?: string; guest?: string; spectator?: string } = {};
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      const role = this.roleOfWs.get(client) ?? 'spectator';
      if (role === 'guest') {
        client.send((cuts.guest ??= toWire(guestSnapshot(s, onAir))));
      } else if (role === 'spectator') {
        client.send((cuts.spectator ??= toWire(spectatorSnapshot(s, onAir))));
      } else {
        client.send((cuts.full ??= toWire({ ...s, onAir })));
      }
    }
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}

/** The address the tablets reach this machine at (`pickLanAddress`),
 *  `localhost` when there is none. */
const lanAddress = (): string => pickLanAddress() ?? 'localhost';

/** The server's IANA timezone. Filename timestamps are parsed in this zone
 *  (schedule.ts builds local Dates), so the page renders all schedule times
 *  and the footer clock with it — a browser in another zone must not disagree
 *  with the clock that actually fires auto-play. */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>studiobox</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23101214'/%3E%3Ccircle cx='32' cy='40' r='7' fill='%237cc8ff'/%3E%3Cpath d='M19 30a18 18 0 0 1 26 0' stroke='%237cc8ff' stroke-width='5' fill='none' stroke-linecap='round'/%3E%3Cpath d='M10 21a31 31 0 0 1 44 0' stroke='%237cc8ff' stroke-width='5' fill='none' stroke-linecap='round' opacity='.6'/%3E%3C/svg%3E">
<style>
 /* Design tokens (docs/design-guidelines.md, section 4; docs/design/). Dark is
    the default — the page is used in a dim studio; the light set follows the
    system setting for a daylight session. Every colour below comes from here. */
 :root{color-scheme:dark;
  --bg:#101214;--surface:#1a1d21;--raised:#24282e;--pressed:#33383f;--line:#33383f;--border:#3a3f47;
  --text:#e8eaed;--muted:#a3aab3;--accent:#7cc8ff;--on-accent:#101214;
  --ok:#5fd08a;--warn:#ffc94d;--cue:#ffb347;--on-cue:#101214;--onair:#ff5c5c;--info:#b9a6ff;--duck:#4fc3c7;--off:#3a3f47;
  --chip-red:#c62828;--chip-green:#1e7d46;--stop-bg:var(--raised);--stop-edge:#ff5c5c;
  --m-ok:#5fd08a;--m-warn:#ffc94d;--m-hot:#ff5c5c;--m-edge:transparent;
  --inv-bg:#e8eaed;--inv-fg:#101214}
 @media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#f6f7f8;--surface:#ffffff;--raised:#eceef1;--pressed:#dde1e6;--line:#dde1e6;--border:#858d97;
  --text:#15181c;--muted:#4d5560;--accent:#0a5fb4;--on-accent:#ffffff;
  --ok:#1a7a41;--warn:#8a5a00;--cue:#9a4d00;--on-cue:#ffffff;--onair:#c62828;--info:#5b3fc4;--duck:#0b7285;--off:#d5d9df;
  --stop-bg:#c62828;--stop-edge:#8e1c1c;
  --m-ok:#2e9e5b;--m-warn:#b07800;--m-hot:#d93636;--m-edge:#858d97;
  --inv-bg:#15181c;--inv-fg:#ffffff}}
 *{box-sizing:border-box}
 body{margin:0;height:100vh;height:100dvh;overflow:hidden;display:flex;flex-direction:column;
  background:var(--bg);color:var(--text);
  font:1rem/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums}
 h1,h2,h3{margin:0;font-size:1rem;font-weight:600}
 /* Buttons: 44 px targets, 8 px radius, separation by surface tone (no
    shadows). "On" states are filled and say so in words (aria-pressed). */
 button{margin:0;min-height:44px;padding:0 16px;font:inherit;font-size:.9375rem;font-weight:600;
  background:var(--raised);color:var(--text);border:1px solid var(--border);border-radius:8px;cursor:pointer}
 button:hover,button:active{background:var(--pressed)}
 button:disabled{background:transparent;color:var(--muted);border:1px dashed var(--border);cursor:default}
 :focus-visible{outline:3px solid var(--accent);outline-offset:2px}
 button.icon{flex:0 0 auto;width:44px;padding:0;font-size:1.0625rem;font-weight:700}
 .panel{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px;background:var(--surface);border-radius:12px}
 /* ---- header: title, output toggles, connection, clock, tools ------------ */
 .topbar{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-height:60px;
  padding:8px max(24px,env(safe-area-inset-right)) 8px max(24px,env(safe-area-inset-left));background:var(--surface)}
 /* Clickable title -> welcome screen. */
 .logo{min-height:44px;padding:0 4px;border:0;background:transparent;color:var(--muted);font-size:1rem}
 .logo:hover,.logo:active{background:transparent;color:var(--text)}
 /* Not a box of its own: a hidden toggle must not leave a gap in the bar. */
 .toggles{display:contents}
 /* The connection/clock/tools cluster: an auto left margin keeps it hard
    right in every layout; it wraps as a unit and stays right-aligned when it
    does. */
 .hright{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px 20px}
 .tools,.status{display:flex;align-items:center;gap:12px}
 /* Recording / streaming: a status chip that is also the switch. Running is
    outlined in its colour, with the state in capitals — red outlined means
    "recording", green "stream up" (filled red is reserved for on air). */
 .tog.on{background:transparent;border-width:2px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
 .tog.on:hover{background:var(--raised)}
 .rec.on{color:var(--onair);border-color:var(--onair)}
 .ship.on{color:var(--ok);border-color:var(--ok)}
 .mon.on{background:var(--chip-green);color:#fff;border:2px solid var(--ok)}
 .conn{display:inline-flex;align-items:center;gap:8px;font-size:.875rem;color:var(--muted);white-space:nowrap}
 .conn .dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--warn)}
 .conn.ok .dot{background:var(--ok)}
 .conn.lost{color:var(--onair);font-weight:600}
 .conn.lost .dot{background:var(--onair)}
 .clockbox{display:flex;flex-direction:column;align-items:flex-end;line-height:1.1}
 #clock{font-size:1.75rem;font-weight:700;white-space:nowrap}
 .tz{font-size:.8125rem;color:var(--muted);white-space:nowrap}
 .tz.warn{color:var(--warn);font-weight:600}
 /* "Vorhören" (browser pre-listen) toggle. When on it must be unmistakable:
    filled amber button, amber rule under the header, amber-framed file list. */
 button.cue{background:transparent;color:var(--cue);border-color:var(--cue)}
 button.cue:hover{background:var(--raised)}
 button.cue.on{background:var(--cue);color:var(--on-cue);font-weight:700}
 body.cueing .topbar{box-shadow:inset 0 -3px 0 var(--cue)}
 /* Top-right ⋮ menu: transport toggles that don't need to sit in the bar. */
 .menuwrap{position:relative}
 .menu{position:absolute;right:0;top:calc(100% + 8px);z-index:20;width:260px;display:flex;flex-direction:column;gap:8px;
  padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:12px}
 .menu button{width:100%;text-align:left}
 /* Status chips in the header: state in words, not switches. Filled red is
    reserved for "on air" — programme is leaving the box. */
 .chip{display:inline-flex;align-items:center;gap:8px;min-height:32px;padding:2px 12px;border-radius:8px;
  border:2px solid var(--border);color:var(--muted);font-size:.9375rem;font-weight:700;letter-spacing:.04em;
  text-transform:uppercase;white-space:nowrap}
 .chip .dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;border:2px solid currentColor}
 .chip.on{background:var(--chip-red);border-color:var(--chip-red);color:#fff}
 .chip.on .dot{background:#fff}
 .chip.warn{border-color:var(--warn);color:var(--warn)}
 .chip.info{border-color:var(--accent);color:var(--accent)}
 /* Press-and-hold for everything that ends output: the fill runs for the hold
    time and the button acts when it is full; letting go earlier cancels. A
    short tap arms a confirm instead ("nochmal tippen"), ringed in red. */
 .hold{position:relative;overflow:hidden;isolation:isolate;touch-action:manipulation;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
 .hold::before{content:"";position:absolute;z-index:-1;left:0;top:0;bottom:0;width:0;background:currentColor;opacity:.3}
 .hold.holding::before{width:100%;transition:width .8s linear}
 .hold.armed{outline:3px solid var(--onair);outline-offset:2px}
 #tone.on{border:2px solid var(--warn);color:var(--warn)}
 /* Announcements for a screen reader only (one polite live region). */
 .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
 /* One line for everybody who is not the technician while the setup assistant
    runs: who is up and what to read. */
 .banner{flex:0 0 auto;margin:16px max(24px,env(safe-area-inset-right)) 0 max(24px,env(safe-area-inset-left));
  padding:12px 16px;border-radius:12px;background:var(--surface);box-shadow:inset 0 0 0 2px var(--accent);font-size:1.125rem}
 /* ---- main: metering left (mixer mode only), playout right --------------- */
 .content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:16px;overflow-y:auto;
  padding:16px max(24px,env(safe-area-inset-right)) 16px max(24px,env(safe-area-inset-left))}
 /* The metering column only exists once a snapshot with channels has arrived
    (body.live) — a playout-only box never flashes an empty meter panel. */
 .metering{display:none;flex:0 0 auto;flex-direction:column;gap:16px;min-width:0}
 body.live .metering{display:flex}
 /* Right-hand column: the browser (file list) above, the pending play list
    below — they belong together and share the space next to the metering.
    Stacked under the metering it keeps a usable height of its own and the
    page scrolls; alone (playout-only) it simply fills the screen. */
 .col2{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:16px;min-width:0}
 body.live .col2{flex:0 0 auto;height:min(640px,85vh);height:min(640px,85dvh)}
 /* Channel meters: one grid row per channel, a bar per processing stage. */
 .chscroll{overflow-x:auto}
 .chgrid{display:grid;grid-template-columns:minmax(88px,1.6fr) 56px minmax(64px,2fr) repeat(4,minmax(52px,1fr)) 68px;
  gap:8px;align-items:center;min-width:540px}
 .chhead{align-items:end;padding-bottom:8px;border-bottom:1px solid var(--line);font-size:.8125rem;color:var(--muted)}
 .chrow{min-height:48px;border-bottom:1px solid var(--raised)}
 .chname{display:flex;flex-direction:column;min-width:0}
 /* Channel colour (config "color", e.g. the mic's cable) as a tape stripe left
    of the name — beside the label, never instead of it. Outlined so a black
    cable still shows on the dark theme. */
 .chname.cc{position:relative;padding-left:14px}
 .chname.cc::before{content:'';position:absolute;left:0;top:2px;bottom:2px;width:6px;border-radius:3px;
  background:var(--chc);box-shadow:0 0 0 1px var(--muted)}
 .chname b{font-size:.9375rem;font-weight:600;line-height:1.15;overflow:hidden;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}
 /* Channel state as a word (OFFEN / PAUSE / STUMM / AN), coloured on top. */
 .chstate{font-size:.75rem;font-weight:700;letter-spacing:.05em;color:var(--muted)}
 .chstate.open{color:var(--ok)}
 .chstate.pause{color:var(--info)}
 .chstate.duck{color:var(--duck)}
 /* Input trim: the value is the button that opens its stepper below the grid. */
 .trimbtn{min-height:44px;width:100%;padding:0;font-size:.875rem;background:transparent;border-color:transparent}
 .trimbtn:hover,.trimbtn.on{border-color:var(--border)}
 .trimrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
 .trimrow .who{flex:1 1 120px;min-width:0}
 .trimrow output{min-width:7ch;text-align:center;font-size:1.125rem;font-weight:700}
 .trimrow button{min-width:56px;padding:0 8px}
 .stage{display:flex;flex-direction:column;gap:4px;min-width:0}
 .stage .val{font-size:.8125rem;color:var(--muted);white-space:nowrap;overflow:hidden}
 /* Level meter, −60…0 dB: the zones (ok below −10, attention to −3, too loud
    above) are a fixed gradient; a cover slides back from the right and a tick
    holds the peak. No transitions — they would lag behind the audio; the
    bar rises at once and falls back gently instead (setLevel). */
 .meter{position:relative;height:10px;border-radius:3px;background:var(--bg);overflow:hidden;
  outline:1px solid var(--m-edge);outline-offset:-1px}
 .meter .fill{position:absolute;top:0;bottom:0;left:0;right:0;
  background:linear-gradient(to right,var(--m-ok) 0 83.33%,var(--m-warn) 83.33% 95%,var(--m-hot) 95% 100%)}
 .meter .cover{position:absolute;top:0;bottom:0;right:0;width:100%;background:var(--bg)}
 .meter .peak{position:absolute;top:0;bottom:0;left:-4px;width:2px;background:var(--text)}
 /* Gate openness and gain reduction are amounts, not levels: one plain colour. */
 .meter.plain .fill{background:var(--accent)}
 .s-gate .meter.plain .fill{background:var(--m-ok)}
 /* Leveler gain goes both ways: the bar grows out of the centre. */
 .meter.bi .fill{right:auto;left:50%;width:0;background:var(--accent)}
 .meter.bi::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--muted)}
 /* Sticky: when a narrow screen scrolls the grid sideways, the mute button
    stays in reach at the right edge. */
 .mtbtn{position:sticky;right:0;z-index:1;padding:0;font-size:.875rem}
 .mtbtn.on{background:var(--inv-bg);color:var(--inv-fg);border-color:var(--inv-bg)}
 /* Programme loudness: the short-term value large, the rest as tiles. */
 .lufs{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:4px 12px}
 .lufs .big{font-size:3rem;font-weight:700;line-height:1}
 .lufs .unit{font-size:1.125rem;color:var(--muted)}
 .lufs .sub{font-size:.875rem;color:var(--muted)}
 .meter.lg{height:12px}
 .scale{position:relative;height:1.7em;font-size:.8125rem;color:var(--muted)}
 .scale span{position:absolute;top:0;padding:6px 0 0 4px;border-left:1px solid var(--muted);line-height:1}
 .scale span:last-child{right:0;padding:6px 4px 0 0;border-left:0;border-right:1px solid var(--muted)}
 .stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
 .stat{padding:8px 12px;border-radius:8px;background:var(--raised);min-width:0}
 .stat .sl{font-size:.8125rem;color:var(--muted)}
 .stat .sv{font-size:1.125rem;font-weight:700;white-space:nowrap}
 .stat .act{font-size:.8125rem;color:var(--warn)}
 .hintline{margin:0;font-size:.8125rem;color:var(--muted)}
 .hintline .act{color:var(--warn);font-weight:600}
 /* Host priority: how far the other mics lean back, as a plain slider. */
 .prio{display:flex;align-items:center;gap:12px}
 .abh{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:6px}
 .abh select{min-height:44px;max-width:100%}
 .prio input{flex:1 1 auto;min-width:0;height:44px;margin:0;accent-color:var(--accent)}
 .prio output{flex:0 0 auto;min-width:5ch;text-align:right;font-size:1.125rem;font-weight:700}
 /* Setup assistant ("Einmessen"): the steps as tiles, each with its state as
    a word; the result as one before -> after row per mic. */
 .suhead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 12px}
 .steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}
 .steps li{display:flex;flex-direction:column;gap:2px;min-width:0;padding:8px 12px;border-radius:8px;background:var(--raised)}
 .steps .sn{font-size:.8125rem;font-weight:700;letter-spacing:.04em;color:var(--muted)}
 .steps b{font-size:.9375rem;overflow-wrap:anywhere}
 .steps .sd{font-size:.8125rem;color:var(--muted)}
 .steps li.done .sn{color:var(--ok)}
 .steps li.now{box-shadow:inset 0 0 0 2px var(--accent)}
 .steps li.now .sn{color:var(--accent)}
 .sunow{font-size:1.125rem;font-weight:600}
 .susent{margin:0;padding:12px 16px;border-radius:8px;background:var(--raised);font-size:1.25rem;line-height:1.4}
 .subtns{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:12px}
 button.go{border:2px solid var(--ok);font-weight:700}
 /* While nothing is being measured the panel is one line and sits below the
    meters; a run or a result brings it up under the channels. */
 #setupBox.idle{order:1;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between}
 #setupBox.idle .hintline{flex:1 1 100%}
 /* Result: one card per mic — verdict in words, what was measured, then each
    setting as "vorher → nachher" (no table to scroll sideways on a tablet). */
 .sures{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
 .sures li{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;background:var(--raised)}
 .srh{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
 .srh b{font-size:.9375rem}
 .sures .was{font-size:.8125rem;color:var(--muted)}
 .verd{margin-left:auto;font-size:.8125rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
 .verd.ok{color:var(--ok)}
 .verd.warn{color:var(--warn)}
 .verd.bad{color:var(--onair)}
 .sset{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;font-size:.875rem}
 .sset div{display:flex;gap:6px;white-space:nowrap}
 .sset dt{color:var(--muted)}
 .sset dd{margin:0}
 .sures .adv{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding-top:6px;border-top:1px solid var(--line)}
 .sures .adv span{flex:1 1 220px;min-width:0}
 .sures .adv button{background:var(--pressed)}
 /* File browser: folder tabs, breadcrumb, one raised row per entry. */
 .files{flex:1 1 0;min-height:200px;gap:8px;overflow:hidden}
 body.cueing .files{box-shadow:inset 0 0 0 2px var(--cue)}
 /* What a click on a file does right now, in words. */
 .fbar .hint{flex:0 1 auto;font-size:.8125rem;color:var(--muted)}
 body.cueing .fbar .hint{color:var(--cue);font-weight:600}
 /* Folder picker: a flat one-click row of tabs (no nested <select>),
    highlighting the current folder; absent when there is only one. */
 .folderlist{flex:0 0 auto;display:flex;gap:8px;overflow-x:auto;padding:3px}
 .folderlist:empty{display:none}
 .fbtn{flex:0 0 auto;border-color:transparent;white-space:nowrap}
 .fbtn.on,.fbtn.on:hover{background:var(--accent);color:var(--on-accent)}
 .fbar{flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:0 12px}
 #crumbs{flex:1 1 120px;min-width:0;color:var(--accent);font-size:.9375rem;white-space:nowrap;overflow-x:auto}
 #crumbs .seg{display:inline-block;padding:10px 0;cursor:pointer}
 #crumbs .seg:hover{text-decoration:underline}
 #crumbs .seg.cur{color:var(--text);font-weight:600;cursor:default;text-decoration:none}
 #crumbs .sep{color:var(--muted);margin:0 6px}
 /* "＋ alle" appends exactly the files listed below it — never the tree — so
    it carries the count and is hidden when there is nothing to add. */
 #addall{flex:0 0 auto;padding:0 12px;font-size:.875rem;background:var(--pressed);border-color:transparent}
 #flist,#qlist,#mlist{list-style:none;margin:0;display:flex;flex-direction:column;gap:4px;overflow-y:auto}
 #flist,#qlist{flex:1 1 auto;min-height:0;padding:0}
 .files li{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:48px;padding:0 2px 0 12px;
  border-radius:8px;background:var(--raised);cursor:pointer}
 .files li:hover{background:color-mix(in srgb,var(--raised),var(--pressed))}
 .files li:focus-visible{outline-offset:-3px}
 .files li.none{background:transparent;color:var(--muted);cursor:default}
 .files li .fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.9375rem}
 .files li .when{flex:0 0 auto;margin-right:8px;font-size:.875rem;color:var(--muted);white-space:nowrap}
 .files li.dir .fname{color:var(--accent);font-weight:600}
 /* Scheduled (timestamped) files: their start time in the schedule colour;
    the next one to fire also gets a bar on its left edge. */
 .files li.sched .when{color:var(--warn)}
 .files li.next{box-shadow:inset 4px 0 0 var(--warn)}
 .files li.next .when{font-weight:700}
 /* The file on air: framed in the "playing" colour and named as such. */
 .files li.playing{box-shadow:inset 0 0 0 2px var(--info)}
 .files li.playing .fname{font-weight:600}
 .files li.playing .when{color:var(--info);font-weight:700}
 .files li.playing .when::after{content:" läuft"}
 /* The row currently being pre-listened to (Vorhören). Amber like the rest of
    the cue chrome. It has to win over .playing/.sched/.next and their
    combinations, hence last and with the class doubled. */
 .files li.cued.cued{box-shadow:inset 0 0 0 2px var(--cue)}
 .files li.cued.cued .when{color:var(--cue);font-weight:700}
 .files li.cued.cued .when::after{content:" Vorhören"}
 /* Row the jump landed on: flashes until the next listing refresh. */
 .files li.focus{outline:3px solid var(--accent);outline-offset:-3px}
 /* In the bed's folder: which file is the bed (the chosen one is filled). */
 .files li .bedbtn[aria-pressed="true"]{background:var(--chip-green);border-color:var(--ok)}
 /* Row action ＋ (enqueue): a quiet secondary button, fixed width so rows line
    up and the button never resizes with its glyph. */
 .files li .addbtn,.files li .bedbtn{flex:0 0 auto;width:44px;padding:0;font-size:1.125rem;background:var(--pressed);border-color:transparent}
 .files li .addbtn:hover,.files li .bedbtn:hover{border-color:var(--border)}
 /* Pending play list. Same panel for both modes: on air it mirrors the box's
    server-side queue, in Vorhören it is the browser's own audition list. */
 .queue{flex:0 1 auto;min-height:0;max-height:34vh;gap:8px}
 body.cueing .queue{box-shadow:inset 0 0 0 2px var(--cue)}
 .qhead{flex:0 0 auto;display:flex;align-items:center;gap:8px}
 .qhead h2{flex:1 1 auto;min-width:0;display:flex}
 .qhead .qt{flex:1 1 auto;min-width:0;padding:0;border:0;background:transparent;font-size:1rem;text-align:left;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .qhead .qt:hover{background:transparent;color:var(--accent)}
 body.cueing .qhead .qt{color:var(--cue)}
 .qhead button{flex:0 0 auto}
 /* "einzeln | laufend": does the list stop after each title or run through. */
 .segc{flex:0 0 auto;display:flex;gap:3px;padding:3px;border-radius:8px;background:var(--bg)}
 .segc button{min-height:38px;padding:0 12px;border:0;background:transparent;font-size:.875rem}
 .segc button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent)}
 /* Start is the one button that puts audio out: outlined in the "go" colour
    (amber while it only starts a pre-listen). */
 #qplay{border:2px solid var(--ok);font-weight:700}
 body.cueing #qplay{border-color:var(--cue)}
 #qlist li{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 0 0 12px;
  border-radius:8px;background:var(--raised)}
 #qlist .qn{flex:0 0 auto;min-width:2ch;text-align:right;font-size:.8125rem;color:var(--muted)}
 #qlist .fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:.9375rem;line-height:44px;cursor:pointer}
 #qlist .fname:hover{color:var(--accent)}
 #qlist .fld,#mlist .fld{color:var(--muted)}
 #qlist .qb{flex:0 0 auto;display:flex}
 #qlist .qb button{width:40px;padding:0;border-color:transparent;background:transparent}
 #qlist .qb button:hover{background:var(--pressed)}
 /* ---- footer: pre-listen player, then the always-there transport --------- */
 .footer{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;background:var(--surface);
  padding:12px max(24px,env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
 /* Transport: what is playing and its remaining time sit right beside the
    mic switch and Stop, so the operator reads the countdown and acts in one
    glance. It is always there (idle: "Keine Datei läuft") — a bar that came
    and went with playback would move everything above it on every start. */
 .prog{height:8px;border-radius:4px;background:var(--bg);overflow:hidden;outline:1px solid var(--m-edge);outline-offset:-1px}
 .prog div{width:0;height:100%;background:var(--info)}
 .footer .ctl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px}
 .now{flex:1 1 320px;min-width:0}
 .nowplaying{display:flex;align-items:center;gap:8px;min-height:44px;min-width:0;font-size:1.25rem;font-weight:600}
 .nowplaying .ic{flex:0 0 auto;color:var(--info)}
 .now.idle .nowplaying{color:var(--muted);font-weight:400}
 /* Long names lose their middle, not their end: the numbering prefix and the
    file ending both stay readable. */
 .nowplaying .nm{display:flex;flex:0 1 auto;min-width:0;overflow:hidden}
 .nowplaying .nh{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:pre}
 .nowplaying .nt{flex:0 0 auto;white-space:pre}
 #next{font-size:.875rem;color:var(--warn);overflow-wrap:anywhere}
 #next .dim{color:var(--muted)}
 /* The remaining time is what the operator acts on: the biggest type here. */
 .nowtime{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end}
 .nowtime .lbl{margin-right:8px;font-size:1.125rem;color:var(--muted)}
 .nowtime .rem{font-size:2.75rem;font-weight:700;line-height:1}
 .now.idle+.nowtime .rem{color:var(--muted)}
 .nowtime .elapsed{min-height:1.2em;font-size:.875rem;line-height:1.2;color:var(--muted)}
 .footer .btns{flex:0 0 auto;display:flex;gap:12px;margin-left:auto}
 .footer .btns button{min-height:56px;min-width:150px;padding:0 20px;font-size:1.0625rem;font-weight:700}
 /* "Jump to where this is playing from" buttons (now-playing line, cue bar). */
 button.jump{flex:0 0 auto;width:44px;padding:0;background:transparent}
 button.jump:hover{background:var(--raised)}
 /* "Reinhören" belongs to the pre-listen family, so it wears its amber. */
 button.jump.tune{border-color:var(--cue)}
 /* Stop never moves or disappears (it is the emergency control); with nothing
    playing it is merely disabled. */
 #stop{background:var(--stop-bg);border:2px solid var(--stop-edge)}
 #stop:disabled{background:transparent;border:1px dashed var(--border)}
 @media (prefers-color-scheme:light){#stop:enabled{color:#fff}}
 /* Global mic switch: state in words and colour — open is filled green. */
 #mute.mic-live{background:var(--chip-green);color:#fff;border:2px solid var(--ok)}
 #mute.muted{background:var(--off);border-color:var(--off)}
 /* Audio bed: running is filled green and says so. */
 #bed.on{background:var(--chip-green);color:#fff;border:2px solid var(--ok)}
 /* Preview player: only present while pre-listening. */
 .cuebar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
 .cuebar .cname{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--cue);font-weight:600}
 .cuebar audio{flex:1 1 140px;min-width:0;max-width:100%;height:44px}
 #cueStop{background:transparent;color:var(--cue);border-color:var(--cue)}
 #cueStop:hover{background:var(--raised)}
 /* ---- modals: scheduled files, help, welcome ----------------------------- */
 .modal{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px}
 .mbox{display:flex;flex-direction:column;width:100%;max-width:640px;max-height:85vh;overflow:hidden;
  background:var(--surface);border:1px solid var(--border);border-radius:12px}
 .mhead{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 12px 12px 16px;
  border-bottom:1px solid var(--line)}
 #mlist{padding:12px}
 #mlist li{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:44px;padding:4px 12px;
  border-radius:8px;background:var(--raised)}
 #mlist li.none{background:transparent;color:var(--muted)}
 #mlist .fname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 #mlist .when{flex:0 0 auto;color:var(--warn);font-weight:600;white-space:nowrap}
 /* "Geräte verbinden": one card per role link, its QR code always dark on
    white (an inverted code scans badly), the link beneath to read or copy. */
 #connList{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;padding:16px;overflow-y:auto}
 #connList .none{grid-column:1/-1;color:var(--muted)}
 .qr{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px;background:var(--raised)}
 .qr h4{margin:0;font-size:1rem}
 .qr .code{background:#fff;border-radius:6px;line-height:0}
 .qr .code svg{width:100%;height:auto}
 .qr .url{font-size:.8125rem;color:var(--muted);overflow-wrap:anywhere;user-select:all}
 #connNote{margin:0}
 #connNote.warn{color:var(--warn)}
 /* Welcome screen: the configured sources as big clickable tiles. */
 .mbox .sub{padding:12px 16px 0;color:var(--muted)}
 .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:16px;overflow-y:auto}
 .tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:104px;
  padding:16px 10px;border-color:transparent;text-align:center}
 .tile.on{box-shadow:inset 0 0 0 2px var(--accent)}
 .tile .ic{font-size:1.875rem;line-height:1}
 .tile .nm{overflow-wrap:anywhere}
 /* Help modal: a short German manual, so a new operator can work the page
    without being shown around. Sections that only exist in mixer mode are
    hidden on a playout-only box (body.playout, set from the snapshot). */
 .help{padding:4px 20px 20px;overflow-y:auto;line-height:1.5}
 .help h4{margin:16px 0 4px;color:var(--accent);font-size:1rem}
 .help p{margin:4px 0}
 .help ul{margin:4px 0;padding-left:20px}
 .help li{margin:4px 0}
 .help .k{padding:1px 6px;border-radius:4px;background:var(--raised);font-weight:600;white-space:nowrap}
 .help .note{color:var(--muted)}
 body.playout .liveonly{display:none}
 body:not(.listeners) .lisonly{display:none}
 /* Hörer:innen: released listener comments and a heart count from eve. Quiet
    by design — the host decides when to look: folded by default, no motion,
    no sound, the hearts a number and never a feed. */
 .lis{flex:0 0 auto;gap:8px}
 .lishead{display:flex;align-items:center;gap:12px;min-height:44px}
 .lishead h2{flex:1 1 auto;min-width:0;display:flex}
 .lishead .qt{flex:0 1 auto;min-width:0;padding:0;border:0;background:transparent;font-size:1rem;text-align:left}
 .lishead .qt:hover{background:transparent;color:var(--accent)}
 .lishead .qt::before{content:"▸ ";color:var(--muted)}
 .lishead .qt[aria-expanded="true"]::before{content:"▾ "}
 .lisshow{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:.875rem}
 .lishearts{flex:0 0 auto;font-weight:700;white-space:nowrap}
 .lissum{flex:0 0 auto;color:var(--muted);font-size:.875rem;white-space:nowrap}
 .lisstate.warn{color:var(--warn);font-weight:600}
 .lislist{margin:0;padding:0;list-style:none;max-height:30vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
 .lislist li{display:flex;gap:12px;padding:8px 12px;border-radius:8px;background:var(--raised)}
 .lislist li.none{background:transparent;color:var(--muted);padding:4px 0}
 .lislist .lt{flex:0 0 auto;color:var(--muted);font-size:.875rem;line-height:1.5}
 /* Sendung: the episode on air and its conversation guide from eve, for the
    host. Read-only. The topics' cues in order are the planned path and stay in
    view; the scripts and the notes fold out. */
 .guide{flex:0 0 auto;gap:8px}
 .gdbody{display:flex;flex-direction:column;gap:12px;max-height:50vh;overflow-y:auto}
 .gdep{margin:0;font-weight:600}
 .gdparts{display:flex;flex-direction:column;gap:12px}
 .gdparts h3{margin:0;color:var(--muted);font-size:.875rem;font-weight:600}
 .gdparts summary{display:flex;flex-direction:column;justify-content:center;min-height:44px;cursor:pointer}
 .gdtopics{margin:0;padding-left:24px;display:flex;flex-direction:column;gap:8px}
 .gdtopics .tt{font-weight:600}
 .gdtopics .tc{display:block;color:var(--muted)}
 .gdq{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}
 .gdq li{padding:8px 12px;border-radius:8px;background:var(--raised)}
 .gdq li.asked{background:transparent;color:var(--muted)}
 .gdq .ok{color:var(--ok);font-weight:700}
 .gdmd{line-height:1.5}
 .gdmd p{margin:4px 0}
 .gdmd h4{margin:12px 0 4px;font-size:1rem}
 .gdmd blockquote{margin:4px 0;padding-left:12px;border-left:3px solid var(--info)}
 .gdmd ul,.gdmd ol{margin:4px 0;padding-left:20px}
 .lislist .ltx{min-width:0;white-space:pre-line;overflow-wrap:anywhere}
 /* Host layout (role from the connection's token): playout and the mics as
    compact bars; everything that tunes or routes belongs to the technician.
    The server drops a host's technician commands anyway — this only keeps
    controls that would do nothing off the screen. */
 body.host .techonly,body.host .td{display:none!important}
 body.host .chgrid{grid-template-columns:minmax(88px,1fr) minmax(0,3fr);min-width:0}
 body.host .chrow .meter{height:16px;border-radius:4px}
 body.host #rec{pointer-events:none}
 /* Wide screens (tablet landscape, laptop): two columns — metering left,
    files right, each scrolling on its own so the page itself never moves. */
 @media (min-width:1000px) and (min-height:560px){
  .content{flex-direction:row;overflow:hidden}
  .metering{flex:1.15 1 0;overflow-y:auto}
  body.live .col2{flex:1 1 0;height:auto}
 }
 /* Small portrait (phones): tighter chrome, full-width transport, and let the
    meter grid scroll sideways instead of crushing its columns. */
 @media (max-width:520px){
  .topbar{padding:8px 12px;gap:8px}
  .logo{padding:0}
  .hright,.tools,.status{gap:8px}
  .tog{padding:0 10px;font-size:.8125rem}
  .tog.on{letter-spacing:0;text-transform:none}
  .content{padding:12px;gap:12px}
  .metering,.col2{gap:12px}
  .panel{padding:12px}
  .footer{padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
  /* Title on its own line, then the countdown beside the transport buttons. */
  .now{flex:1 1 100%}
  .nowtime{align-items:flex-start}
  .nowtime .rem{font-size:2.25rem}
  .footer .btns{flex:1 1 0;justify-content:flex-end}
  .footer .btns button{flex:0 1 150px;min-width:0;min-height:48px;padding:0 12px}
  .chip{min-height:28px;padding:2px 8px;gap:6px;font-size:.8125rem;letter-spacing:0}
  .banner{margin:12px 12px 0;font-size:1rem}
  /* Mixer mode has more than one button: a row of their own, shared evenly. */
  body.live .footer .btns{flex-basis:100%}
  body.live .footer .btns button{flex:1 1 0}
  .fbar .hint{order:3;flex-basis:100%;padding-bottom:4px}
  #clock{font-size:1.125rem}
  .tz{display:none}
  /* The words stay for a screen reader; sighted, the dot (and the amber
     chrome of Vorhören) carry it — a lost connection still spells it out. */
  .conn.ok .ct,#cue .lbl{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
  #cue{width:44px;padding:0}
  .nowplaying{font-size:1.0625rem}
  /* One line, start time first: on a phone the footer must stay short. */
  #next{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #cueStop{padding:0 12px}
  /* Leave the file browser more of a small screen, and keep the queue row
     controls thumb-sized without eating the filename. */
  .queue{max-height:30vh}
  #qlist .qb button{width:36px}
  .qhead button{padding:0 12px}
 }
 /* More contrast asked for: drop the surface tints, draw borders instead. */
 @media (prefers-contrast:more){
  :root{--surface:var(--bg);--raised:var(--bg);--m-edge:var(--text)}
  .panel,.mbox,.menu{border:2px solid var(--text)}
  .topbar{border-bottom:2px solid var(--text)}
  .footer{border-top:2px solid var(--text)}
  button,.fbtn,#addall,.tile,.files li .addbtn,.files li .bedbtn{border:2px solid var(--text)}
  .banner{box-shadow:none;border:2px solid var(--text)}
  .files li,#qlist li,#mlist li,.stat{border:1px solid var(--text)}
 }
</style></head><body>
<header class="topbar">
 <h1><button id="logo" class="logo" title="Quellen anzeigen">studiobox</button></h1>
 <span id="air" class="chip" role="status" style="display:none"><span class="dot"></span><span id="airText"></span></span>
 <span id="setupChip" class="chip info" style="display:none">Einmessen läuft</span>
 <span id="toneChip" class="chip warn" style="display:none">Testton</span>
 <div class="toggles">
  <button id="rec" class="tog rec hold" style="display:none">Aufnahme aus</button>
  <button id="ship" class="tog ship hold techonly" style="display:none">Stream aus</button>
 </div>
 <div class="hright">
 <div class="status">
  <span id="conn" class="conn" role="status"><span class="dot"></span><span class="ct" id="connText">Verbinde …</span></span>
  <div class="clockbox"><span id="clock"></span><span id="tz" class="tz"></span></div>
 </div>
 <div class="tools">
  <button id="cue" class="cue" aria-pressed="false" title="Vorhören: Dateien im Browser abhören, ohne die Ausspielung zu stören"><span aria-hidden="true">🎧</span> <span class="lbl" id="cueLbl">Vorhören</span></button>
  <button id="helpBtn" class="icon" title="Hilfe / Kurzanleitung" aria-label="Hilfe">?</button>
  <div class="menuwrap">
   <button id="menuBtn" class="icon" title="Mehr" aria-label="Mehr" aria-haspopup="true">⋮</button>
   <div id="menu" class="menu" style="display:none">
    <button id="mon" class="mon hold techonly" style="display:none">Lokale Ausgabe aus</button>
    <button id="ret" class="mon techonly" style="display:none">Musik-Rückweg aus</button>
    <div id="retLvlBox" class="techonly" style="display:none">
     <label for="retLvl">Musik im Kopfhörer</label>
     <div class="prio"><input id="retLvl" type="range" min="-40" max="6" step="1" value="0"><output id="retLvlVal" for="retLvl"></output></div>
    </div>
    <button id="tone" class="hold techonly" style="display:none">Testton aus</button>
    <button id="endShow" class="hold techonly" style="display:none">Sendung beenden</button>
    <button id="schedBtn">⏰ Geplante Sendungen</button>
    <button id="connBtn" class="techonly">📱 Geräte verbinden</button>
   </div>
  </div>
 </div>
 </div>
</header>
<div id="setupLine" class="banner" role="status" style="display:none"></div>
<div id="say" class="sr" role="status"></div>
<main class="content">
<div class="metering" id="metering">
 <section class="panel" aria-labelledby="chTitle">
  <h2 id="chTitle">Kanäle</h2>
  <div class="chscroll">
   <div class="chgrid chhead"><span>Kanal</span><span class="td">Trim</span><span>Pegel</span><span class="td">Gate</span><span class="td">Comp</span><span class="td">Automix</span><span class="td">Leveler</span><span class="td"></span></div>
   <div id="rows"></div>
  </div>
  <div id="trimEd" class="trimrow techonly" style="display:none">
   <span class="who">Trim <b id="trimWho"></b></span>
   <button id="trimDn3" aria-label="Trim 3 dB leiser">−3</button>
   <button id="trimDn" aria-label="Trim 1 dB leiser">−1</button>
   <output id="trimVal"></output>
   <button id="trimUp" aria-label="Trim 1 dB lauter">+1</button>
   <button id="trimUp3" aria-label="Trim 3 dB lauter">+3</button>
   <button id="trimClose" class="icon" aria-label="Trim schließen">✕</button>
  </div>
 </section>
 <section class="panel techonly" id="setupBox" style="display:none" aria-labelledby="suTitle">
  <div class="suhead"><h2 id="suTitle">Einmessen</h2><span class="hintline" id="suInfo"></span></div>
  <ol class="steps" id="suSteps" style="display:none"></ol>
  <div id="suNow" class="sunow" style="display:none"></div>
  <blockquote id="suSent" class="susent" style="display:none"></blockquote>
  <ul class="sures" id="suRows" style="display:none"></ul>
  <div class="subtns">
   <button id="suCancel" style="display:none">Abbrechen</button>
   <button id="suFinish" style="display:none">Fertig – auswerten</button>
   <button id="suDiscard" style="display:none">Verwerfen</button>
   <button id="suApply" class="go" style="display:none">Übernehmen</button>
   <button id="suStart" class="go">Einmessen starten</button>
  </div>
  <p class="hintline" id="suIntro" style="display:none">Misst alle Mikrofone in etwa einer Minute: erst 5 Sekunden Stille, dann liest
  jede Person kurz einen Satz vor. Am Programm ändert sich nichts, bis du „Übernehmen“ drückst.</p>
 </section>
 <section class="panel techonly" aria-labelledby="pgTitle">
  <div class="lufs">
   <div><h2 id="pgTitle">Programm</h2><div class="sub">Momentan <span id="mom">–</span> LUFS</div></div>
   <div><span class="big" id="st">–</span> <span class="unit">LUFS kurz</span></div>
  </div>
  <div>
   <div class="meter lg" id="pkm" role="meter" aria-label="Programm Spitzenpegel" aria-valuemin="-60" aria-valuemax="0"><div class="fill"></div><div class="cover"></div><div class="peak"></div></div>
   <div class="scale" aria-hidden="true"><span style="left:0">−60</span><span style="left:33.33%">−40</span><span style="left:66.67%">−20</span><span style="left:83.33%">−10</span><span>0 dB</span></div>
  </div>
  <div class="stats">
   <div class="stat"><div class="sl">Spitze</div><div class="sv"><span id="pk">–</span> dB</div></div>
   <div class="stat"><div class="sl">Limiter</div><div class="sv"><span id="lgr">–</span> dB</div></div>
   <div class="stat"><div class="sl">Duck (Musik)</div><div class="sv"><span id="duck">–</span> dB <span class="act" id="duckOn" style="display:none">aktiv</span></div></div>
  </div>
 </section>
 <section class="panel techonly" id="prioBox" style="display:none">
  <h2><label for="prio">Moderations-Vorrang</label></h2>
  <div class="prio"><input id="prio" type="range" min="0" max="24" step="1" value="8"><output id="prioVal" for="prio"></output></div>
  <p class="hintline">So viel leiser werden die anderen Mikrofone, solange <b id="prioWho">die Moderation</b> spricht.
  <span class="act" id="prioAct" style="display:none">wirkt gerade</span></p>
 </section>
 <section class="panel" id="musLvlBox" style="display:none">
  <h2><label for="musLvl">Musik-Lautstärke</label></h2>
  <div class="prio"><input id="musLvl" type="range" min="-12" max="6" step="1" value="0"><output id="musLvlVal" for="musLvl"></output><button id="musLvlReset" style="display:none">Zurücksetzen</button></div>
  <p class="hintline">Wie laut Musik, Jingles und Bett auf Sendung neben den Stimmen stehen. 0 dB = automatisch eingepegelt.</p>
 </section>
 <section class="panel techonly" id="abhBox" style="display:none" aria-labelledby="abhTitle">
  <h2 id="abhTitle">Abhören</h2>
  <div class="abh">
   <button id="abhPlay" aria-pressed="false">▶ Abhören</button>
   <div class="segc" role="group" aria-label="Was hören"><button id="abhRec" aria-pressed="true">Aufnahme</button><button id="abhRaw" aria-pressed="false">Roh</button><button id="abhAir" aria-pressed="false">Auf Sendung</button></div>
   <select id="abhMic" aria-label="Rohsignal von" style="display:none"><option value="raw">alle Mikros</option></select>
  </div>
  <p class="hintline" id="abhState" aria-live="polite"></p>
  <audio id="abhAudio" preload="none"></audio>
 </section>
</div>
<div class="col2">
 <section class="panel guide" id="guidebox" style="display:none" aria-labelledby="gdTitle">
  <div class="lishead">
   <h2><button class="qt" id="gdTitle" aria-expanded="true" aria-controls="gdBody" title="ein-/ausklappen">Sendung</button></h2>
   <span class="lisshow" id="gdShow"></span>
  </div>
  <p class="hintline lisstate" id="gdState" style="display:none"></p>
  <div class="gdbody" id="gdBody" style="display:none">
   <p class="gdep" id="gdEp"></p>
   <div class="gdparts" id="gdParts"></div>
  </div>
 </section>
 <section class="panel lis" id="lisbox" style="display:none" aria-labelledby="lisTitle">
  <div class="lishead">
   <h2><button class="qt" id="lisTitle" aria-expanded="false" aria-controls="lisList" title="ein-/ausklappen">Hörer:innen</button></h2>
   <span class="lisshow" id="lisShow"></span>
   <span class="lissum" id="lisSum"></span>
   <span class="lishearts" id="lisHearts"></span>
  </div>
  <p class="hintline lisstate" id="lisState" style="display:none"></p>
  <ul class="lislist" id="lisList" style="display:none"></ul>
 </section>
 <section class="panel files" id="files" style="display:none" aria-label="Dateien">
  <nav id="folderList" class="folderlist" aria-label="Ordner"></nav>
  <div class="fbar"><div id="crumbs"></div><span class="hint" id="fhint">Klick spielt sofort aus</span><button id="addall" title="alle Dateien dieser Liste anhängen">＋ alle</button></div>
  <ul id="flist"></ul>
 </section>
 <section class="panel queue" id="queuebox" style="display:none">
  <div class="qhead">
   <h2><button class="qt" id="qtitle" title="ein-/ausklappen" aria-expanded="true">Warteschlange</button></h2>
   <div class="segc" id="qmode" role="group" aria-label="Ablauf der Liste" style="display:none"><button id="qmSingle" aria-pressed="false" title="Nach jedem Titel anhalten – der nächste startet erst mit ▶ Start">einzeln</button><button id="qmChain" aria-pressed="false" title="Titel für Titel durchlaufen">laufend</button></div>
   <button id="qsend" class="cue" title="diese Liste an die Ausspielung übergeben" style="display:none">→ Playout</button>
   <button id="qplay" title="nächsten Titel jetzt starten">▶ Start</button>
   <button id="qclear" class="icon" title="Liste leeren" aria-label="Liste leeren">✕</button>
  </div>
  <ul id="qlist"></ul>
 </section>
</div>
</main>
<footer class="footer">
 <div class="cuebar" id="cuebar" style="display:none">
  <span class="cname" id="cname"></span>
  <button class="jump" id="cuejump" title="Ordner dieses Titels öffnen" aria-label="Ordner dieses Titels öffnen" style="display:none">📂</button>
  <audio id="cueAudio" controls preload="none"></audio>
  <button id="cueStop">■ Vorhören stoppen</button>
 </div>
 <div class="prog"><div id="pbar"></div></div>
 <div class="ctl">
  <section class="now idle" id="nowbox" aria-label="Jetzt läuft">
   <div class="nowplaying" id="nowplaying">Keine Datei läuft</div>
   <div id="next" style="display:none"></div>
  </section>
  <div class="nowtime"><div><span class="lbl" id="remlbl"></span><span class="rem" id="rem">–:––</span></div><span class="elapsed" id="ftime"></span></div>
  <div class="btns">
   <button id="mute" style="display:none">Mikros zu</button>
   <button id="bed" style="display:none" aria-pressed="false">Bett aus</button>
   <button id="stop" class="hold" title="Wiedergabe beenden: gedrückt halten — die Warteschlange bleibt erhalten" disabled>■ Stopp</button>
  </div>
 </div>
</footer>
<div id="modal" class="modal" style="display:none">
 <div class="mbox" role="dialog" aria-modal="true" aria-labelledby="mTitle">
  <div class="mhead"><h3 id="mTitle">⏰ Geplante Sendungen</h3><button id="mclose" class="icon" aria-label="Schließen">✕</button></div>
  <ul id="mlist"></ul>
 </div>
</div>
<div id="connect" class="modal" style="display:none">
 <div class="mbox" role="dialog" aria-modal="true" aria-labelledby="cTitle">
  <div class="mhead"><h3 id="cTitle">📱 Geräte verbinden</h3><button id="cclose" class="icon" aria-label="Schließen">✕</button></div>
  <p class="sub" id="connNote"></p>
  <div id="connList"></div>
 </div>
</div>
<div id="help" class="modal" style="display:none">
 <div class="mbox" role="dialog" aria-modal="true" aria-labelledby="hTitle">
  <div class="mhead"><h3 id="hTitle">studiobox — Kurzanleitung</h3><button id="hclose" class="icon" aria-label="Schließen">✕</button></div>
  <div class="help">
   <h4>Was ist studiobox?</h4>
   <p>studiobox ist der Ausspielrechner des Senders. <b>Diese Seite ist nur die
   Fernbedienung dazu</b> — abgespielt, aufgenommen und gestreamt wird auf dem
   Gerät. Die Seite kann jederzeit geschlossen oder neu geladen werden, ohne die
   Sendung zu unterbrechen. Mehrere Geräte (Tablet, Laptop) dürfen gleichzeitig
   offen sein und zeigen denselben Stand.</p>
   <p class="note">Einzige Ausnahme: <span class="k">Vorhören</span> und
   <span class="k">Reinhören</span> laufen im Browser, also auf dem Kopfhörer
   des Geräts, an dem du gerade sitzt.</p>

   <h4>Dateien und Ordner</h4>
   <ul>
    <li>Ordner wechseln: über die Ordner-Leiste über der Dateiliste, oder oben
    links auf <span class="k">studiobox</span> klicken (Kachelübersicht der
    Quellen).</li>
    <li>Zeilen mit <span class="k">📁</span> sind Unterordner — Klick öffnet
    sie, die Pfadzeile darüber führt wieder zurück.</li>
    <li><b>Klick auf eine Datei startet sie sofort</b> — im Normalbetrieb also
    on air. Läuft schon etwas, wird es ersetzt.</li>
    <li>Unten stehen der laufende Titel und groß die Restzeit
    (<span class="k">noch 2:34</span>); in der Liste ist er umrahmt und mit
    „läuft“ markiert.</li>
   </ul>

   <h4>Warteschlange</h4>
   <ul>
    <li><span class="k">＋</span> hängt eine Datei an,
    <span class="k">＋ alle (n)</span> alle Dateien der angezeigten Liste
    (nur diese Liste, keine Unterordner).</li>
    <li><b>Anhängen startet nie von selbst.</b> Die Liste beginnt erst mit
    <span class="k">▶ Start</span> — oder automatisch, sobald der gerade
    laufende Titel zu Ende ist.</li>
    <li class="liveonly"><span class="k">einzeln</span> /
    <span class="k">laufend</span>: bei „einzeln“ hält die Liste nach jedem
    Titel an und wartet auf <span class="k">▶ Start</span> (ein Gespräch mit
    Musikpausen), bei „laufend“ spielt sie Titel für Titel durch.</li>
    <li><span class="k">↑ ↓</span> sortieren, <span class="k">✕</span> entfernt,
    <span class="k">📂</span> springt zum Ordner des Titels.</li>
    <li>Klick auf den Namen spielt ihn sofort — die Titel darüber fallen dabei
    aus der Liste.</li>
    <li><span class="k">■ Stopp</span> (unten rechts) beendet die Wiedergabe,
    ohne weiterzuschalten; die Liste bleibt erhalten. Damit ein verirrter
    Finger nichts abschneidet: <b>gedrückt halten</b>, bis die Taste gefüllt
    ist (knapp eine Sekunde) — oder zweimal tippen, wenn sie nachfragt.</li>
    <li class="note">Die Liste lebt nur im Arbeitsspeicher: nach einem Neustart
    des Geräts ist sie leer. Für garantierte Sendungen die Zeitsteuerung
    benutzen (siehe unten).</li>
   </ul>

   <div class="lisonly">
    <h4>Sendung</h4>
    <p>Oben rechts steht, welche Sendung laut Sendeplan gerade läuft. Ist die
    Ausgabe in eve vorbereitet, steht darunter ihr Ablauf:</p>
    <ul>
     <li><b>Anmoderation</b> und <b>Abmoderation</b> zum Ablesen – zum
     Aufklappen antippen.</li>
     <li><b>Themen</b> in der geplanten Reihenfolge, jeweils mit einer Zeile zum
     Überleiten; die Notizen klappen auf.</li>
     <li><b>Pflichtfragen</b> – die Fragen, die auf jeden Fall gestellt werden.
     Ein <span class="k">✓</span> heißt: in eve als gestellt markiert.</li>
     <li>Geändert wird der Ablauf in eve, nicht hier; Änderungen erscheinen
     nach einigen Sekunden von selbst.</li>
    </ul>
    <h4>Hörer:innen</h4>
    <p>Hörer:innen können der laufenden Sendung auf der Website einen Kommentar
    oder ein Herz schicken. Hier erscheinen nur <b>freigegebene</b> Kommentare
    — freigegeben wird in eve, von jemandem, der nicht am Mikrofon sitzt.
    Die Herzen sind nur eine Zahl.</p>
    <ul>
     <li>Der Kasten ist zugeklappt, bis du ihn öffnest; <span class="k">neu</span>
     zählt, was seit dem letzten Aufklappen dazukam. Nichts blinkt, nichts
     klingelt.</li>
     <li>Welche Sendung gerade läuft, weiß studiobox aus dem Sendeplan und der
     Uhr. Mit jeder Sendung beginnt der Kasten leer.</li>
     <li>Von hier aus lässt sich nichts freigeben, löschen oder beantworten.</li>
     <li class="note">„eve nicht erreichbar“: gezeigt wird der letzte Stand;
     neue Kommentare kommen an, sobald die Verbindung wieder steht.</li>
    </ul>
   </div>

   <h4>Vorhören und Reinhören</h4>
   <ul>
    <li><span class="k">🎧 Vorhören</span> einschalten: ein Klick auf eine Datei
    spielt sie dann <b>nur im Browser</b> ab. Die Ausspielung bleibt völlig
    unberührt. Kopfzeile und Dateiliste bekommen dazu einen orangefarbenen
    Rahmen, der Knopf zeigt „Vorhören an“.</li>
    <li>Ist die Vorhören-Liste leer, läuft der Ordner einfach weiter — Titel für
    Titel. Mit <span class="k">＋</span> gebaute Listen haben Vorrang.</li>
    <li><span class="k">→ Playout</span> übergibt die vorgehörte Liste an die
    Ausspielung.</li>
    <li><span class="k">👂</span> neben dem laufenden Titel ist
    <b>Reinhören</b>: du hörst die laufende Ausspielung an genau der Stelle mit,
    an der sie gerade ist. Ein gerade vorgehörter Titel rutscht dabei oben in
    die Vorhören-Liste und kommt danach zurück.</li>
    <li class="note">Formate, die Browser nicht abspielen (.wma, .aiff), werden
    zum Vorhören nicht angeboten — auf dem Gerät laufen sie trotzdem.</li>
   </ul>

   <h4>Zeitgesteuerte Sendungen</h4>
   <ul>
    <li>Dateien mit einem Zeitstempel im Namen
    (<span class="k">JJJJMMTT-HHMMSS</span>, z. B.
    <span class="k">magazin-20260722-130000.flac</span>) starten automatisch zu
    dieser Zeit und haben Vorrang vor allem, was gerade läuft.</li>
    <li>Solche Dateien tragen <span class="k">⏰</span> und ihre Startzeit; der
    nächste Start steht unten unter dem laufenden Titel, alle kommenden unter
    <span class="k">⋮ → Geplante Sendungen</span>.</li>
    <li>Danach läuft die Warteschlange normal weiter.</li>
    <li class="note">Alle Zeiten sind die Uhrzeit des Geräts — sie steht mit
    Zeitzone oben rechts.</li>
   </ul>

   <div class="liveonly">
    <h4>Auf Sendung und Sendezeit</h4>
    <ul>
     <li>studiobox sendet <b>einige Sekunden zeitversetzt</b>: was im Studio
     gesagt wird, geht erst nach dieser Verzögerung hinaus. Die große Uhr oben
     ist deshalb die <b>Sendezeit</b> — die Uhrzeit, zu der das jetzt Gesagte
     auf Sendung ist. Darunter stehen klein die Studio-Uhr und die
     Verzögerung.</li>
     <li>Zeitstempel in Dateinamen meinen die Sendezeit: ein Jingle mit
     <span class="k">130000</span> ist um 13:00:00 auf Sendung.</li>
     <li><span class="k">● AUF SENDUNG</span> (rot gefüllt) heißt: das Programm
     verlässt das Gerät. Ob der Regler am Sendepult offen ist, sieht studiobox
     nicht. <span class="k">PUFFER FÜLLT</span> steht nach dem Start, bis die
     Verzögerung aufgebaut ist; <span class="k">NICHT AUF SENDUNG</span>, wenn
     kein Ausgang läuft.</li>
     <li class="techonly"><span class="k">⋮ → Sendung beenden</span> (gedrückt
     halten) schließt die Mikros, lässt alles schon Gesagte noch hinauslaufen
     und beendet danach die Aufnahme. Ein einfaches Stoppen würde die letzten
     Sekunden abschneiden. Solange der Puffer ausläuft, nimmt dieselbe Taste
     das Beenden zurück.</li>
    </ul>

    <h4>Aufnahme, Stream, Ausspielung</h4>
    <p class="note">Diese Schalter zeigen den <b>Zustand</b> an. Starten ist ein
    Klick; <b>Beenden heißt gedrückt halten</b> (oder zweimal tippen, wenn die
    Taste nachfragt).</p>
    <ul>
     <li><span class="k">Aufnahme aus</span> / <span class="k">● AUFNAHME
     LÄUFT</span> (oben links): die lokale Sicherheitsaufnahme (FLAC). Sie läuft
     <b>nicht</b> automatisch.</li>
     <li class="techonly"><span class="k">Stream aus</span> / <span class="k">STREAM LÄUFT</span>:
     schickt das fertige Programm an den Server (Icecast/Harbor).</li>
     <li class="techonly"><span class="k">⋮ → Lokale Ausgabe</span> gibt das Programm
     auf der angeschlossenen Soundkarte aus, <span class="k">⋮ →
     Musik-Rückweg</span> schickt die Musik (ohne Mikros) zurück ins Studio,
     damit man sie im Kopfhörer hört. Der Regler <span class="k">Musik im
     Kopfhörer</span> darunter stellt ein, wie laut sie dort neben den
     Mikrofonen ist — die Sendung bleibt davon unberührt.</li>
     <li class="techonly"><span class="k">⋮ → Testton</span> (gedrückt halten)
     legt 1 kHz bei −18 dBFS auf die lokale Ausgabe, um den Eingang am Pult
     einzupegeln. Er <b>ersetzt dort das Programm</b>; oben steht so lange
     <span class="k">TESTTON</span>.</li>
     <li class="techonly"><span class="k">⋮ → Geräte verbinden</span> zeigt
     für jede Rolle einen QR-Code (Technik, Host, Gäste — für Gäste auch einen
     je Mikro, das Tablet zeigt dann gleich dessen Pegel — und Zuschauer). Wer
     ihn scannt, bekommt genau diese Ansicht und darf nur, was sie erlaubt.</li>
     <li><span class="k">Bett aus</span> / <span class="k">Bett läuft</span>
     (unten): ein Musikbett, das in Schleife läuft und unter Sprache leiser
     wird — auch als Notnagel, wenn nichts anderes bereit ist. Im Bett-Ordner
     wählt <span class="k">🛏</span> an einer Datei, welche es ist.</li>
    </ul>

    <h4>Pegel</h4>
    <ul>
     <li>Pro Kanal: <b>Pegel</b> (grün bis −10 dB, gelb bis −3 dB, darüber rot;
     der Strich hält den Spitzenwert)<span class="techonly">, <b>Gate</b>
     (offen/zu), <b>Comp</b> (Kompressor-Absenkung), <b>Automix</b>
     (automatische Mikrofonmischung), <b>Leveler</b> (Lautstärke-Ausgleich) und
     rechts die Taste <span class="k">Offen</span> /
     <span class="k">Stumm</span></span>.</li>
     <li>Unter dem Namen steht der Zustand als Wort: <span class="k">OFFEN</span>,
     <span class="k">LEISER</span> (die Moderation spricht, dieses Mikro tritt
     zurück), <span class="k">PAUSE</span> (alle Mikros zu),
     <span class="k">STUMM</span> (von der Technik abgeschaltet).</li>
     <li class="techonly"><b>Trim</b>: ein Klick auf den Wert öffnet die
     Schritt-Tasten (±1, ±3 dB) für die Eingangsverstärkung dieses Mikros.</li>
     <li class="techonly"><b>Moderations-Vorrang</b>: so viel leiser werden die
     anderen Mikros, solange die Moderation spricht — sanft, nie stumm.</li>
     <li><b>Musik-Lautstärke</b>: wie laut Musik, Jingles und Bett auf Sendung
     neben den Stimmen stehen (−12 bis +6 dB). Die Musik wird ohnehin
     automatisch eingepegelt; der Regler verschiebt sie nur gegenüber den
     Stimmen. Der Kopfhörer im Studio bleibt davon unberührt
     (<span class="k">Musik im Kopfhörer</span>).</li>
     <li class="techonly"><b>Abhören</b>: hört auf diesem Gerät (Kopfhörer, auch
     Bluetooth) mit, was gerade aufgenommen wird — <span class="k">Aufnahme</span>
     verarbeitet, <span class="k">Roh</span> unverarbeitet (alle Mikros oder
     eins) — oder was das Gerät verlässt (<span class="k">Auf Sendung</span>).
     Umschalten zwischen Aufnahme und Roh springt nicht in der Zeit, so lässt
     sich die Bearbeitung direkt vergleichen. Wie weit das hinter dem Raum
     liegt, steht darunter.</li>
     <li><b>Programm</b>: Lautheit kurz und momentan (LUFS), <b>Spitze</b>,
     <b>Limiter</b> und <b>Duck</b> — die Absenkung der Musik, sobald jemand
     ins Mikro spricht (nicht bei Klopfen, Räuspern, Atmen oder Flüstern).</li>
     <li><span class="k">● Mikros offen</span> / <span class="k">Mikros zu</span>
     (unten rechts) schaltet alle Mikrofone stumm bzw. wieder auf; bei
     „Mikros zu“ läuft nur Musik, die Kanäle zeigen PAUSE.</li>
    </ul>

    <div class="techonly">
     <h4>Einmessen</h4>
     <ul>
      <li><span class="k">Einmessen starten</span> misst alle Mikrofone in etwa
      einer Minute: erst 5 Sekunden <b>Stille</b>, dann liest jede Person den
      angezeigten Satz vor. Die Reihenfolge ist egal — wer spricht, wird
      erkannt; alle anderen Ansichten zeigen, wer dran ist.</li>
      <li>Das Ergebnis zeigt pro Mikro ein Urteil (<span class="k">GUT</span>,
      <span class="k">ZU LEISE</span>, <span class="k">ÜBERSTEUERT</span> …) und
      jede Einstellung als <b>vorher → nachher</b>. Erst
      <span class="k">Übernehmen</span> stellt die Kanäle ein;
      <span class="k">Verwerfen</span> lässt alles, wie es war.</li>
      <li>Was studiobox nicht selbst stellen kann — den Gain-Regler am
      Mischpult — steht als Anweisung dabei („Kanal 3: Gain um etwa +18 dB
      aufdrehen“). Danach <span class="k">Nur diesen Kanal neu messen</span>.</li>
      <li class="note">Das Ergebnis übersteht einen Neustart des Geräts; in der
      Konfigurationsdatei ändert es nichts.</li>
     </ul>
    </div>

    <h4>Ansichten</h4>
    <ul>
     <li>Es gibt vier Ansichten: <b>Technik</b> (alles), <b>Moderation</b>
     (Ausspielung, Warteschlange, Mikros, Bett), <b>Gast</b> (nur Anzeige: eigenes
     Mikro, Abstand, Restzeit) und <b>Zuschauer</b> (On Air, Titel, Uhr).</li>
     <li class="note">Sind die Rollen eingeschaltet, entscheidet der Link, mit
     dem die Seite geöffnet wurde: ohne den Schlüssel im Link gibt es nur die
     Zuschauer-Ansicht, und das Gerät nimmt von dort auch keine Befehle an.</li>
    </ul>
   </div>

   <h4>Wenn etwas nicht stimmt</h4>
   <ul>
    <li>Steht oben <span class="k">Verbindung weg</span>, verbindet sich die
    Seite von selbst neu — einfach kurz warten oder neu laden. Die Sendung
    läuft dabei weiter.</li>
    <li>Netzwerkordner können langsam sein: eine Liste kann einen Moment
    brauchen, das stört die Ausspielung aber nicht.</li>
   </ul>
  </div>
 </div>
</div>
<div id="welcome" class="modal" style="display:none">
 <div class="mbox" role="dialog" aria-modal="true" aria-labelledby="wTitle">
  <div class="mhead"><h3 id="wTitle">studiobox — Quellen</h3><button id="wclose" class="icon" aria-label="Schließen">✕</button></div>
  <div class="sub">Ordner wählen:</div>
  <div id="tiles" class="tiles"></div>
 </div>
</div>
<script>
 // Numbers the German way: decimal comma and a real minus sign. A value that
 // rounds to zero loses its sign ("−0,0" reads like a glitch).
 const fmt=(v,d=1)=>{if(v===null||v===undefined||!isFinite(v))return '–';
  let t=v.toFixed(d);if(Number(t)===0)t=t.replace('-','');
  return t.replace('-','−').replace('.',',');};
 // Gain reduction (compressor, limiter, duck) always reads as a cut, whichever
 // sign the DSP block reports it with.
 const fmtGr=(v,d)=>fmt(typeof v==='number'?-Math.abs(v):v,d);
 // Digital silence has no loudness and no peak worth a number: below the
 // BS.1770 absolute gate (−70 LUFS) and below −120 dB the readout is a dash.
 const fmtLufs=(v,d)=>typeof v==='number'&&v<-70?'–':fmt(v,d);
 const fmtPeak=(v,d)=>typeof v==='number'&&v<-120?'–':fmt(v,d);
 const grPct=v=>isFinite(v)?Math.max(0,Math.min(1,Math.abs(v)/20))*100:0;
 const mmss=v=>{if(v===null||v===undefined||!isFinite(v))return '–';const s=Math.max(0,Math.round(v));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
 const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const setPressed=(b,on)=>b.setAttribute('aria-pressed',on?'true':'false');
 const $=id=>document.getElementById(id);
 const show=(el,on)=>{el.style.display=on?'':'none';};
 // A value with its sign spelled out ("+4,1" / "−3,0"), for trims and gains.
 const sgn=(v,d)=>(v>=0.05?'+':'')+fmt(v,d);
 // One polite live region for the few things worth announcing.
 const say=t=>{$('say').textContent=t;};
 // With role tokens on, the HTTP routes want the same ?k= the page was opened
 // with (the WebSocket carries it too).
 const K=new URLSearchParams(location.search||'').get('k');
 const withK=u=>K?u+(u.indexOf('?')<0?'?':'&')+'k='+encodeURIComponent(K):u;
 // The role comes from the connection's token; the server enforces it, the
 // page only decides what to put on screen. A technician who opens /host gets
 // the host's layout, to see what the host sees.
 let role='tech';
 const tech=()=>role==='tech';
 function setRole(r){role=r==='tech'&&location.pathname==='/host'?'host':r;
  document.body.classList.toggle('host',!tech());
  $('chTitle').textContent=tech()?'Kanäle':'Mikrofone';}
 // Level meters span −60…0 dB. The zone colours are a fixed gradient in the
 // bar; per frame only the cover (and the peak tick) move.
 const pct=db=>isFinite(db)?Math.max(0,Math.min(100,(db+60)/60*100)):0;
 const HOLD_MS=1500;
 // Meter ballistics: the bar follows a rise at once and falls back at
 // FALL_DB_S, so it breathes with the voice instead of flickering between
 // frames (and does not drop to nothing when a slow link skips a frame).
 const FALL_DB_S=20;
 function setLevel(m,db,now){
  const fell=m.bar-FALL_DB_S*Math.max(0,now-m.barAt)/1000;
  m.bar=isFinite(db)&&!(db<fell)?db:fell;m.barAt=now;
  m.cover.style.width=(100-pct(m.bar))+'%';
  // Peak-hold tick: the highest level of the last 1.5 s.
  if(!(db<m.pk)||now-m.pkAt>HOLD_MS){m.pk=db;m.pkAt=now;}
  m.peak.style.left=m.pk>-60?'calc('+pct(m.pk)+'% - 2px)':'-4px';
  // For a screen reader: whole dB and the zone in a word, written only when
  // it changes (and never aria-live — 20 updates a second would flood it).
  const v=Math.round(Math.max(-60,Math.min(0,isFinite(db)?db:-60)));
  if(v!==m.now){m.now=v;m.el.setAttribute('aria-valuenow',v);
   m.el.setAttribute('aria-valuetext',fmt(v,0)+' dB, '+(v>-3?'zu laut':v>-10?'Achtung':'ok'));}
 }
 const levelMeter=(el,cover,peak)=>({el:el,cover:cover,peak:peak,pk:-Infinity,pkAt:0,now:null,bar:-Infinity,barAt:0});
 // The numbers beside the bars change at most once per NUM_MS, in whole dB
 // (only the large short-term loudness keeps its decimal): the bars carry the
 // motion, the digits are there to be read. Levels and gain reductions show
 // the highest value since the last reading, so a peak in between is not lost.
 const NUM_MS=1000;
 const hiOf=(acc,k,v)=>{if(typeof v==='number'&&isFinite(v)&&!(acc[k]>=v))acc[k]=v;return acc[k];};
 // One meter cell of a channel row: a bar plus its value in words/numbers.
 const stage=(k,level)=>'<div class="stage s-'+k+(level?'':' td')+'"><div class="meter'+(level?'"'+
  ' role="meter" aria-valuemin="-60" aria-valuemax="0"':' plain"')+'><div class="fill"></div><div class="cover"></div>'+
  (level?'<div class="peak"></div>':'')+'</div><span class="val"></span></div>';
 // Build the meter rows once (rebuilding only when the channel set changes) and
 // update cell contents in place each frame. Rebuilding the rows every frame
 // would destroy the per-row mute buttons mid-click, breaking the toggle.
 const rowsEl=document.getElementById('rows');
 let rowEls=null;
 function ensureRows(channels){
  if(rowEls&&rowEls.length===channels.length&&rowEls.every((r,i)=>r.label===channels[i].label))return;
  rowsEl.innerHTML='';
  rowEls=channels.map(c=>{const row=document.createElement('div');const mic=c.role==='mic';
   row.className='chgrid chrow';
   // gate / comp GR / automix are mic-only concepts — music rows leave them blank.
   row.innerHTML='<div class="chname'+(c.color?' cc" style="--chc:'+esc(c.color):'')+'"><b title="'+esc(c.label)+'">'+esc(c.label)+'</b><span class="chstate"></span></div>'+
    (mic?'<button class="trimbtn td" title="Trim (Eingangsverstärkung) ändern"></button>':'<span class="td"></span>')+
    stage('lvl',true)+(mic?stage('gate')+stage('comp')+stage('mix'):'<span class="td"></span><span class="td"></span><span class="td"></span>')+
    '<div class="stage s-lev td"><div class="meter bi"><div class="fill"></div></div><span class="val"></span></div>'+
    '<button class="mtbtn td" data-label="'+esc(c.label)+'"></button>';
   rowsEl.appendChild(row);
   const q=s=>row.querySelector(s);
   const lvl=levelMeter(q('.s-lvl .meter'),q('.s-lvl .cover'),q('.s-lvl .peak'));
   lvl.el.setAttribute('aria-label','Pegel '+c.label);
   const trim=mic?q('.trimbtn'):null;
   if(trim)trim.onclick=()=>openTrim(trimLabel===c.label?null:c.label);
   return {label:c.label,mic:mic,st:'',hi:{},fresh:true,state:q('.chstate'),lvl:lvl,lvlVal:q('.s-lvl .val'),trim:trim,trimDb:null,
    gate:q('.s-gate .cover'),gateVal:q('.s-gate .val'),comp:q('.s-comp .cover'),compVal:q('.s-comp .val'),
    mix:q('.s-mix .cover'),mixVal:q('.s-mix .val'),lev:q('.s-lev .fill'),levVal:q('.s-lev .val'),mbtn:q('.mtbtn')};});
 }
 function updateRows(channels,now,nums){
  ensureRows(channels);
  channels.forEach((c,i)=>{const r=rowEls[i];
   setLevel(r.lvl,c.outDb,now);
   const lvlHi=hiOf(r.hi,'lvl',c.outDb),compHi=hiOf(r.hi,'comp',Math.abs(c.compGrDb));
   // A row built mid-window gets its numbers at once, not a second later.
   const n=nums||r.fresh;r.fresh=false;
   if(n){r.hi={};r.lvlVal.textContent=fmt(lvlHi,0)+' dB';}
   if(r.mic){
    r.gate.style.width=(100-Math.max(0,Math.min(1,c.gateOpen))*100)+'%';
    r.gateVal.textContent=c.gateOpen>=0.5?'offen':'zu';
    r.comp.style.width=(100-grPct(c.compGrDb))+'%';
    r.mix.style.width=(100-grPct(c.automixGainDb))+'%';
    if(n){r.compVal.textContent=fmtGr(compHi,0)+' dB';
     r.mixVal.textContent=fmt(c.automixGainDb,0)+' dB';}
    const t=typeof c.trimDb==='number'?c.trimDb:0;
    if(t!==r.trimDb){r.trimDb=t;r.trim.textContent=sgn(t);
     r.trim.setAttribute('aria-label','Trim '+c.label+': '+sgn(t)+' dB, ändern');
     if(trimLabel===c.label)showTrim();}
   }
   // Leveler gain goes both ways (±20 dB across the bar), out of the centre.
   const lv=isFinite(c.levelerDb)?Math.max(-20,Math.min(20,c.levelerDb)):0;
   r.lev.style.left=(lv<0?50+lv*2.5:50)+'%';
   r.lev.style.width=Math.abs(lv)*2.5+'%';
   if(n)r.levVal.textContent=(c.levelerDb>=0.5?'+':'')+fmt(c.levelerDb,0)+' dB';
   // The channel's state as a word, not only a colour. PAUSE = this mic is
   // fine but all mics are closed (music only); LEISER = host priority is
   // holding it back right now. Written only on change so the mute button is
   // not re-rendered under a finger.
   const st=c.muted?'STUMM':r.mic?(muted?'PAUSE':c.priorityDb<-1?'LEISER':'OFFEN'):'AN';
   if(st!==r.st){r.st=st;
    r.state.textContent=st;
    r.state.className='chstate'+(st==='STUMM'?'':st==='PAUSE'?' pause':st==='LEISER'?' duck':' open');
    r.mbtn.className='mtbtn td'+(c.muted?' on':'');
    r.mbtn.textContent=c.muted?'Stumm':r.mic?'Offen':'An';
    setPressed(r.mbtn,c.muted);}
  });
 }
 // Hand trim: the value in a mic's row opens one stepper under the grid. Steps
 // of 1 and 3 dB rather than a slider — on air a slipped finger must not be
 // able to jump a gain by 20 dB.
 let trimLabel=null,trimSent=null,trimAt=0;
 const trimRow=()=>rowEls?rowEls.find(r=>r.label===trimLabel):null;
 function showTrim(){const r=trimRow();
  show($('trimEd'),!!r);
  if(rowEls)rowEls.forEach(x=>{if(x.trim)x.trim.classList.toggle('on',x===r);});
  if(!r)return;
  $('trimWho').textContent=r.label;$('trimVal').textContent=sgn(r.trimDb)+' dB';}
 function openTrim(label){trimLabel=label;trimSent=null;showTrim();}
 function trimBy(d){const r=trimRow();if(!r||!tech())return;
  // Taps faster than the snapshot comes back build on what was just sent.
  const base=trimSent!==null&&Date.now()-trimAt<1500?trimSent:r.trimDb;
  trimSent=Math.max(-20,Math.min(40,Math.round((base+d)*10)/10));trimAt=Date.now();
  send({type:'trim',value:{label:r.label,trimDb:trimSent}});}
 [['trimDn3',-3],['trimDn',-1],['trimUp',1],['trimUp3',3]].forEach(a=>{$(a[0]).onclick=()=>trimBy(a[1]);});
 $('trimClose').onclick=()=>openTrim(null);
 // Programme peak meter and the master readouts.
 const pkmEl=document.getElementById('pkm');
 const pkm=levelMeter(pkmEl,pkmEl.querySelector('.cover'),pkmEl.querySelector('.peak'));
 const duckOn=document.getElementById('duckOn');
 // prefers-reduced-motion: the meters tick at 5 fps instead of every frame.
 const calm=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 let meterAt=0,numAt=-Infinity,pgHi={};
 let ws, muted=false, playing=null, recording=null, streaming=null, monitor=null;
 // Where the playing file lives ({folder,name}), so the page can jump back to
 // it — the server reports it because only the box knows how playback started.
 let playingAt=null, playingAtKey='';
 // Its playback position (seconds) and when that frame arrived, so Reinhören
 // can seek to where the box is *now*, not where it was one frame ago.
 let playPos=null, playPosAt=0;
 // Toggles say their *state* in words ("Mikros offen" / "Mikros zu",
 // "Aufnahme läuft" / "Aufnahme aus") plus aria-pressed — never a label that
 // flips between an action and a state. The tooltip names what a click does.
 const mbtn=document.getElementById('mute');
 function setBtn(){
  if(muted){mbtn.textContent='Mikros zu';mbtn.className='muted';mbtn.title='Alle Mikrofone sind zu (nur Musik) — Klick öffnet sie';}
  else{mbtn.textContent='● Mikros offen';mbtn.className='mic-live';mbtn.title='Mikrofone sind offen — Klick schließt alle (nur Musik)';}
  setPressed(mbtn,!muted);
 }
 mbtn.onclick=()=>{muted=!muted;setBtn();if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'micsMuted',value:muted}));};
 function send(cmd){if(ws&&ws.readyState===1)ws.send(JSON.stringify(cmd));}
 function setTog(b,cls,on,onText,offText,what,held){if(on===null||on===undefined){b.style.display='none';return;}b.style.display='';
  b.textContent=on?onText:offText;b.className=cls+(on?' on':'');
  b.title=what+(on?(held?' läuft — zum Beenden gedrückt halten':' läuft — Klick beendet'):' ist aus — Klick startet');setPressed(b,on);}
 // Press-and-hold for everything that ends output (Stopp, recording, stream,
 // local output, end of show): a stray tap must not cut the programme. The
 // button fills for PRESS_MS and acts when the fill is complete; letting go
 // earlier cancels. It works the same from the keyboard (hold Enter or Space).
 // A short tap does not act either, it arms a confirm: the label asks, and a
 // second tap — not a bounce, so at least CONFIRM_MIN_MS later — acts. That
 // second path is what a screen reader's activate gesture (a bare click, no
 // press to hold) and anybody who cannot hold a press get to use.
 // needsHold() says whether the button is in its guarded state right now;
 // outside it (starting something) a single tap acts. render() repaints the
 // normal label.
 const PRESS_MS=800,CONFIRM_MIN_MS=400,CONFIRM_MS=4000;
 function holdBtn(b,needsHold,act,render,ask){
  let timer=0,disarm=0,armedAt=0,done=false,keyDown=false;
  const unarm=()=>{if(!armedAt)return;armedAt=0;clearTimeout(disarm);b.classList.remove('armed');render();};
  const release=()=>{if(timer){clearTimeout(timer);timer=0;}b.classList.remove('holding');};
  const fire=()=>{unarm();if(needsHold())act();};
  const press=()=>{done=false;
   if(timer||b.disabled||!needsHold())return;
   b.classList.add('holding');
   timer=setTimeout(()=>{timer=0;b.classList.remove('holding');done=true;fire();},PRESS_MS);};
  const tap=()=>{
   if(!needsHold()){act();return;}    // starting is a single tap
   const now=Date.now();
   if(armedAt&&now-armedAt<=CONFIRM_MS){if(now-armedAt>=CONFIRM_MIN_MS)fire();return;}
   armedAt=now;b.classList.add('armed');b.textContent=ask+' Nochmal tippen';
   say(ask+' Gedrückt halten oder nochmal tippen.');
   clearTimeout(disarm);disarm=setTimeout(unarm,CONFIRM_MS);};
  b.addEventListener('pointerdown',press);
  ['pointerup','pointerleave','pointercancel','blur'].forEach(t=>b.addEventListener(t,release));
  b.addEventListener('keydown',e=>{if(e.repeat||(e.key!=='Enter'&&e.key!==' '))return;keyDown=true;press();});
  // Enter clicks on keydown (and again on every key repeat), Space on keyup:
  // clicks while the key is down are swallowed, and a short Enter is turned
  // into the tap it was meant as here.
  b.addEventListener('keyup',e=>{if(!keyDown)return;keyDown=false;
   const early=!!timer;release();
   if(e.key==='Enter'){if(done)done=false;else if(early)tap();}});
  b.addEventListener('contextmenu',e=>{if(e.preventDefault)e.preventDefault();});
  b.onclick=()=>{
   if(done){done=false;return;}       // the hold has acted; this click is its release
   if(timer||keyDown)return;          // a hold is under way
   tap();};
  return unarm;
 }
 const rbtn=document.getElementById('rec');
 // After a stop the box keeps writing for the look-ahead (about 3 s), so what
 // was said up to the button press is in the file — and keeps reporting
 // "recording" that long. Here that reads "endet …", not as a stop that failed.
 let recEndAt=0;
 const recEnding=()=>recording===false&&Date.now()-recEndAt<5000;
 function setRec(){setTog(rbtn,'tog rec hold',recording,'● Aufnahme läuft',recEnding()?'Aufnahme endet …':'Aufnahme aus','Die lokale Aufnahme (FLAC)',true);}
 holdBtn(rbtn,()=>tech()&&recording===true,()=>{if(recording===null||!tech())return;
  recording=!recording;recEndAt=recording?0:Date.now();setRec();send({type:'recording',value:recording});},setRec,'Aufnahme beenden?');
 const sbtn=document.getElementById('ship');
 function setShip(){setTog(sbtn,'tog ship hold techonly',streaming,'Stream läuft','Stream aus','Der Stream zum Server',true);}
 holdBtn(sbtn,()=>streaming===true,()=>{if(streaming===null||!tech())return;
  streaming=!streaming;setShip();send({type:'streaming',value:streaming});},setShip,'Stream beenden?');
 const mbtn2=document.getElementById('mon');
 let monFault=false;
 function setMon(){setTog(mbtn2,'mon hold techonly',monitor,'Lokale Ausgabe läuft',monFault?'Lokale Ausgabe: Gerät fehlt':'Lokale Ausgabe aus','Die Ausgabe auf der Soundkarte',true);
  if(monFault&&monitor===false)mbtn2.title='Die Soundkarte antwortet nicht — studiobox versucht es jede Sekunde neu';}
 holdBtn(mbtn2,()=>monitor===true,()=>{if(monitor===null||!tech())return;
  monitor=!monitor;setMon();send({type:'monitor',value:monitor});},setMon,'Ausgabe beenden?');
 // Music return to the room (the mixer's USB playback): no programme hangs on
 // it, so it is a plain switch.
 const retBtn=$('ret');let musicReturn=null,retFault=false;
 function setRet(){setTog(retBtn,'mon techonly',musicReturn,'Musik-Rückweg läuft',retFault?'Musik-Rückweg: Gerät fehlt':'Musik-Rückweg aus','Der Musik-Rückweg ins Studio');
  if(retFault&&musicReturn===false)retBtn.title='Das Pult antwortet nicht — studiobox versucht es jede Sekunde neu';}
 retBtn.onclick=()=>{if(musicReturn===null||!tech())return;musicReturn=!musicReturn;setRet();send({type:'musicReturn',value:musicReturn});};
 // Alignment tone: it replaces the programme on the local output, so here it
 // is *starting* that is guarded; a chip in the header says it is on.
 const toneBtn=$('tone');let testTone=null;
 function setTone(){show(toneBtn,testTone!==null);show($('toneChip'),!!testTone);
  toneBtn.textContent=testTone?'Testton läuft (1 kHz, −18 dBFS)':'Testton aus';
  toneBtn.className='hold techonly'+(testTone?' on':'');setPressed(toneBtn,!!testTone);
  toneBtn.title=testTone?'Testton läuft statt des Programms auf der lokalen Ausgabe — Klick beendet'
   :'1 kHz bei −18 dBFS auf die lokale Ausgabe, zum Einpegeln des Pults. Ersetzt dort das Programm — gedrückt halten';}
 holdBtn(toneBtn,()=>testTone===false,()=>{if(testTone===null||!tech())return;
  testTone=!testTone;setTone();send({type:'testTone',value:testTone});},setTone,'Testton statt Programm?');
 const filesBox=document.getElementById('files'),flist=document.getElementById('flist'),folderList=document.getElementById('folderList');
 const crumbs=document.getElementById('crumbs');
 let folder=0,subPath='',folderLabels=[],folders=[];
 const tiles=document.getElementById('tiles'),welcome=document.getElementById('welcome');
 const stopBtn=document.getElementById('stop');
 // Stop only makes sense while a file is playing — but it keeps its place
 // (disabled) so the emergency control is always where the thumb expects it.
 function setStop(){stopBtn.disabled=!playing;stopBtn.textContent='■ Stopp';stopUnarm();}
 const stopUnarm=holdBtn(stopBtn,()=>!!playing,()=>send({type:'stopFile'}),()=>{stopBtn.textContent='■ Stopp';},'Stoppen?');
 // Per-row mute toggles: delegate the click to the persistent rows container
 // and read the channel label from the button.
 rowsEl.addEventListener('click',e=>{
  const b=e.target.closest('.mtbtn');if(!b)return;
  send({type:'channelMuted',value:{label:b.dataset.label,muted:!b.classList.contains('on')}});
 });
 // Reflect the active folder in the tab row (highlight the current one).
 function markFolderActive(){[...folderList.children].forEach(b=>{const on=Number(b.dataset.i)===folder;
  b.classList.toggle('on',on);setPressed(b,on);});}
 function selectFolder(i){folder=i;subPath='';menu.style.display='none';markFolderActive();
  [...tiles.children].forEach(t=>t.classList.toggle('on',Number(t.dataset.i)===folder));loadFiles();}
 const npbox=document.getElementById('nowplaying'),nowbox=document.getElementById('nowbox');
 // A long name is cut in its middle: head (ellipsized by CSS) + fixed tail.
 const midName=n=>{n=String(n);const cut=n.length>28?n.length-14:n.length;
  return '<span class="nh">'+esc(n.slice(0,cut))+'</span>'+(cut<n.length?'<span class="nt">'+esc(n.slice(cut))+'</span>':'');};
 function markPlaying(){[...flist.children].forEach(li=>{if(li.classList.contains('dir'))return;
  li.classList.toggle('playing',li.dataset.name===playing);});
  // The box moved on to another file: what is being listened in to is not the
  // on-air file any more, so stop calling it that.
  if(cueLive&&(!playingAt||playingAt.folder!==cueFolder||playingAt.name!==cueRel)){
   cueLive=false;cueLabel();}
  nowbox.classList.toggle('idle',!playing);
  if(playing){
   // Reinhören needs a location to fetch from and a format the browser plays.
   const canTune=!!playingAt&&cuePlayable(playing);
   npbox.innerHTML='<span class="ic" aria-hidden="true">▶</span><span class="nm" title="'+esc(playing)+'">'+midName(playing)+'</span>'+
    (playingAt?'<button class="jump" title="Ordner des laufenden Titels öffnen" aria-label="Ordner des laufenden Titels öffnen">📂</button>':'')+
    (canTune?'<button class="jump tune" title="Reinhören: die laufende Ausspielung an der aktuellen Stelle im Browser mithören" aria-label="Reinhören">👂</button>':'');
   if(playingAt)npbox.querySelector('.jump').onclick=()=>gotoFile(playingAt.folder,playingAt.name);
   if(canTune)npbox.querySelector('.tune').onclick=tuneIn;}
  else{npbox.innerHTML='Keine Datei läuft';}
  setStop();}
 // Footer transport: remaining time large, elapsed small, and a progress bar;
 // a file of unknown length shows how long it has been running instead.
 const remEl=document.getElementById('rem'),remLbl=document.getElementById('remlbl'),
  ftimeEl=document.getElementById('ftime'),pbar=document.getElementById('pbar');
 function updateFileTime(pos,dur){
  const hasPos=pos!==null&&pos!==undefined&&isFinite(pos);
  if(dur!==null&&dur!==undefined&&isFinite(dur)){const p=hasPos?pos:0;
   remLbl.textContent='noch';remEl.textContent=mmss(dur-p);
   ftimeEl.textContent=mmss(p)+' von '+mmss(dur);
   pbar.style.width=(dur>0?Math.max(0,Math.min(100,p/dur*100)):0)+'%';}
  else{remLbl.textContent=hasPos?'läuft seit':'';remEl.textContent=hasPos?mmss(pos):'–:––';
   ftimeEl.textContent='';pbar.style.width='0%';}}
 function loadFolders(){fetch(withK('folders')).then(r=>r.json()).then(d=>{
  // Entries are {label,icon}; tolerate bare strings from an older server.
  const fl=(d.folders||[]).map(f=>typeof f==='string'?{label:f,icon:'📁'}:f);
  folders=fl;
  folderLabels=fl.map(f=>f.label);
  folderList.innerHTML='';
  // One tab per configured dir, right above the listing — no nested select.
  // With a single folder there's nothing to pick, so the row stays empty
  // (and collapses via :empty).
  if(fl.length>1)fl.forEach((f,i)=>{const b=document.createElement('button');
   b.className='fbtn';b.dataset.i=i;b.textContent=(f.icon||'📁')+' '+f.label;
   b.onclick=()=>selectFolder(i);folderList.appendChild(b);});
  if(folder>=fl.length)folder=0;
  // Nothing to browse (file player off) -> nothing to pre-listen to either.
  cueBtn.style.display=fl.length?'':'none';
  renderQueue();
  markFolderActive();
  renderTiles();
  loadFiles();
 }).catch(()=>{loadFiles();});}
 // Welcome screen: the same sources as the tab row, as big one-click tiles.
 function renderTiles(){
  tiles.innerHTML='';
  if(!folders.length){tiles.innerHTML='<div class="sub">keine Ordner konfiguriert</div>';return;}
  folders.forEach((f,i)=>{const t=document.createElement('button');
   t.className='tile'+(i===folder?' on':'');t.dataset.i=i;
   t.innerHTML='<span class="ic">'+esc(f.icon||'📁')+'</span><span class="nm">'+esc(f.label)+'</span>';
   t.onclick=()=>{welcome.style.display='none';selectFolder(i);};
   tiles.appendChild(t);});
 }
 // Server-clock skew (serverNow - clientNow): schedule marks compare against
 // the *server's* clock, which is what actually triggers auto-play.
 let clockSkew=0;
 const srvNow=()=>Date.now()+clockSkew;
 // With an air delay the programme runs a few seconds behind the room. What
 // is said now airs at "Sendezeit" = server clock + measured delay, and that
 // is the clock filename timestamps mean: a file stamped 13:00:00 airs at
 // 13:00:00. Without a delay (playout mode) the two are the same clock.
 let air=null,airDelayMs=0;
 const airNow=()=>srvNow()+airDelayMs;
 // All schedule times render in the *server's* timezone: filename timestamps
 // are parsed there, so a browser sitting in another zone must still show the
 // wallclock the operator wrote into the filename.
 const serverTz='__SERVER_TZ__';
 const mkFmt=o=>{try{return new Intl.DateTimeFormat('de-DE',Object.assign({timeZone:serverTz},o));}
  catch(e){return new Intl.DateTimeFormat('de-DE',o);}};
 const dayFmt=mkFmt({day:'2-digit',month:'2-digit'});
 const timeFmt=mkFmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 const fmtWhen=ms=>{const sameDay=dayFmt.format(ms)===dayFmt.format(airNow());
  return (sameDay?'':dayFmt.format(ms)+' ')+timeFmt.format(ms);};
 // Live clock in the header — the clock auto-play actually fires on. With an
 // air delay that is Sendezeit, labelled as such, with the studio's own clock
 // and the delay small beneath it; a delay off its target by more than a
 // second is called out.
 const clockEl=document.getElementById('clock'),tzEl=document.getElementById('tz');
 const tickClock=()=>{clockEl.textContent=timeFmt.format(airNow());
  if(!air){tzEl.className='tz';tzEl.textContent=serverTz;return;}
  const d=air.delayMs===null?air.targetMs:air.delayMs;
  const off=air.delayMs!==null&&Math.abs(air.delayMs-air.targetMs)>1000;
  tzEl.className='tz'+(off?' warn':'');
  tzEl.textContent=air.state==='draining'&&air.drainEndsMs
   ?'Sendezeit · Puffer läuft aus, noch '+mmss((air.drainEndsMs-srvNow())/1000)
   :'Sendezeit · Studio '+timeFmt.format(srvNow())+(off?' · Verzögerung '+fmt(d/1000)+' s':' · +'+fmt(d/1000)+' s');};
 tickClock();setInterval(tickClock,1000);
 // Re-apply schedule marks to the existing rows (which timestamps are still in
 // the future changes as time passes, without any new fetch).
 function markSchedule(){
  const rows=[...flist.children].filter(li=>li.dataset.name);
  let next=null;
  rows.forEach(li=>{const at=Number(li.dataset.playat);
   const up=isFinite(at)&&at>0&&at>airNow();
   li.classList.toggle('sched',up);
   li.classList.remove('next');
   if(up&&(next===null||at<Number(next.dataset.playat)))next=li;});
  if(next)next.classList.add('next');
 }
 // Breadcrumb over the current position: folder label + each subPath segment,
 // every non-current segment clickable to jump back up.
 function renderCrumbs(){
  const segs=subPath?subPath.split('/'):[];
  let html='<span class="seg'+(segs.length?'':' cur')+'" data-i="-1">'+esc(folderLabels[folder]||'Dateien')+'</span>';
  segs.forEach((s,i)=>{html+='<span class="sep">/</span><span class="seg'+(i===segs.length-1?' cur':'')+'" data-i="'+i+'">'+esc(s)+'</span>';});
  crumbs.innerHTML=html;
 }
 crumbs.onclick=e=>{const s=e.target.closest('.seg');if(!s||s.classList.contains('cur'))return;
  const i=Number(s.dataset.i);
  subPath=i<0?'':subPath.split('/').slice(0,i+1).join('/');
  loadFiles();};
 // Rows are clickable list items; make them reachable by keyboard too. Enter
 // on the row itself acts — not on the ＋ button inside it.
 const rowAct=(li,fn)=>{li.onclick=fn;li.tabIndex=0;
  li.onkeydown=e=>{if(e.key==='Enter'&&e.target===li)fn();};};
 // The optional focus argument (a bare filename) marks the row a jump landed
 // on, so the file you came looking for is visible instead of somewhere down a
 // long listing.
 function loadFiles(focus){fetch(withK('files?folder='+folder+'&path='+encodeURIComponent(subPath))).then(r=>r.json()).then(d=>{
  const fs=d.files||[];
  if(typeof d.now==='number')clockSkew=d.now-Date.now();
  filesBox.style.display='';
  renderCrumbs();
  addall.style.display='none';
  flist.innerHTML='';
  if(!fs.length){flist.innerHTML='<li class="none">Keine Audiodateien in diesem Ordner</li>';cueSync([]);return;}
  // Files this browser could pre-listen to, in listing order — the queue
  // Vorhören auto-advances through.
  const cueable=[];
  fs.forEach(f=>{
   // Backward compatible: entries are {name,playAtMs} objects (or bare strings).
   const name=typeof f==='string'?f:f.name;
   const li=document.createElement('li');
   if(typeof f==='object'&&f&&f.dir){
    // Subdirectory row: descend instead of playing.
    li.className='dir';
    li.innerHTML='<span class="fname">📁 '+esc(name)+'</span><span class="when">›</span>';
    rowAct(li,()=>{subPath=subPath?subPath+'/'+name:name;loadFiles();});
    flist.appendChild(li);return;
   }
   const at=typeof f==='object'&&f&&isFinite(f.playAtMs)?f.playAtMs:null;
   const rel=subPath?subPath+'/'+name:name;
   li.dataset.name=name;
   li.dataset.rel=rel;
   if(at!==null)li.dataset.playat=at;
   const when=at!==null?'⏰ '+fmtWhen(at):(cueing?'🎧':'▶');
   const idx=cuePlayable(name)?cueable.push({rel:rel,name:name})-1:-1;
   // A ＋ per row appends to the pending list of whichever mode is active;
   // in Vorhören a file the browser can't decode gets no ＋ at all.
   const canAdd=!cueing||idx>=0;
   // In the folder the bed comes from, every file can be made the bed.
   const bedRow=!cueing&&!!bed&&!!bed.at&&bed.at.folder===folder;
   const isBed=bedRow&&bed.at.name===rel;
   li.innerHTML='<span class="fname" title="'+esc(name)+'">'+esc(name)+'</span><span class="when">'+when+'</span>'+
    (bedRow?'<button class="bedbtn" aria-pressed="'+isBed+'" title="'+(isBed?'ist das Bett':'als Bett wählen')+
     '" aria-label="'+(isBed?'ist das Bett':'als Bett wählen')+'">🛏</button>':'')+
    (canAdd?'<button class="addbtn" title="an die Warteschlange anhängen" aria-label="an die Warteschlange anhängen">＋</button>':'');
   if(bedRow)li.querySelector('.bedbtn').onclick=e=>{e.stopPropagation();send({type:'bedSelect',value:{folder:folder,name:rel}});};
   if(canAdd)li.querySelector('.addbtn').onclick=e=>{e.stopPropagation();enqueue(folder,rel);};
   // In Vorhören mode a click pre-listens in the browser and leaves the
   // on-air playout completely untouched; otherwise it starts real playout.
   rowAct(li,()=>{if(cueing)cueStart(folder,subPath,cueable,idx,name);
    else send({type:'playFile',value:{folder:folder,name:rel}});});
   flist.appendChild(li);});
  // "＋ alle" appends what is listed here — subdirectory rows are not files,
  // so a folder holding only subfolders (or, in Vorhören, only formats the
  // browser can't decode) offers no button at all.
  const addable=cueing?cueable.length:flist.children.length-fs.filter(f=>f&&f.dir).length;
  if(addable>0){addall.style.display='';addall.textContent='＋ alle ('+addable+')';}
  cueSync(cueable);
  markSchedule();
  markPlaying();
  markCue();
  if(focus){const li=[...flist.children].find(l=>l.dataset.name===focus);
   if(li){li.classList.add('focus');if(li.scrollIntoView)li.scrollIntoView({block:'center'});}}
 }).catch(()=>{});}
 // Jump to where a file lives (the file on air, the one being pre-listened to,
 // or a queue row) and flash its row: after browsing around, finding the way
 // back to it is otherwise a hunt through the tree.
 function gotoFile(f,rel){
  if(f===null||f===undefined||!rel)return;
  const p=String(rel).split('/');const base=p.pop();
  folder=Number(f);subPath=p.join('/');
  markFolderActive();
  [...tiles.children].forEach(t=>t.classList.toggle('on',Number(t.dataset.i)===folder));
  welcome.style.display='none';menu.style.display='none';
  loadFiles(base);}
 // Keep the listing and its future/past marks fresh (new synced files appear,
 // elapsed timestamps lose their highlight).
 setInterval(loadFiles,30000);
 setInterval(markSchedule,5000);
 const nextBox=document.getElementById('next');
 function setNext(n){
  if(n&&n.name){nextBox.style.display='';
   // Folder-relative names: show the directory part dimmed, keep the (long,
   // wrappable) filename prominent instead of ellipsizing the whole line.
   const parts=String(n.name).split('/');
   const base=parts.pop();
   const dir=parts.length?'<span class="dim">'+esc(parts.join(' / '))+' /</span> ':'';
   nextBox.innerHTML='⏰ Nächster Start <b>'+fmtWhen(n.playAtMs)+'</b> · '+dir+esc(base);}
  else nextBox.style.display='none';
 }
 // "Auf Sendung", as far as the box can know it: the server derives it as
 // "programme is leaving the box" (onAir) — the desk's fader is out of its
 // sight. The chip says the state in words; only on air is it filled red.
 const airEl=$('air');let airKey='',hadAir=false;
 function setAir(s){
  air=s.air||null;
  airDelayMs=air?air.nowMs-s.serverNowMs:0;
  // The clock's label depends on it: repaint at once, not at the next second.
  if(!!air!==hadAir){hadAir=!!air;tickClock();}
  let text='',on=false;
  if(air){const st=air.state;
   if(st==='filling')text='Puffer füllt';
   else if(st==='ended')text='Sendung beendet';
   else if(!s.onAir)text='Nicht auf Sendung';
   // Still on air while "Sendung beenden" plays the buffer out — the
   // countdown for that is under the clock.
   else{on=true;text='Auf Sendung';}}
  if(text+on===airKey)return;
  airKey=text+on;show(airEl,!!text);airEl.className='chip'+(on?' on':'');$('airText').textContent=text;
 }
 // "Sendung beenden": closes the mics, lets the buffer play out, then stops
 // the recording — the clean way to end a show (a plain stop cuts the last
 // seconds). While it drains, the same button takes it back.
 const endBtn=$('endShow');let endKey=null;
 const ending=()=>!!air&&air.state==='draining';
 function setEnd(){show(endBtn,!!air);if(!air)return;
  endBtn.disabled=air.state==='ended';
  endBtn.textContent=ending()?'Beenden abbrechen':air.state==='ended'?'Sendung beendet':'Sendung beenden';
  endBtn.title=ending()?'Der Puffer läuft aus — Klick bricht das Beenden ab (die Mikros bleiben zu)'
   :air.state==='ended'?'Mikros öffnen geht wieder auf Sendung'
   :'Schließt die Mikros, lässt den Puffer auslaufen und beendet dann die Aufnahme; die Warteschlange steht danach auf „einzeln“ — gedrückt halten';}
 holdBtn(endBtn,()=>!!air&&!ending(),()=>{if(tech())send({type:'endShow',value:!ending()});},setEnd,'Sendung beenden?');
 // Audio bed (a looping second deck, ducked like the music): one switch that
 // says its state. The box fades it; the button follows the snapshot.
 const bedBtn=$('bed');let bed=null,bedKey='';
 function setBed(){show(bedBtn,!!bed);if(!bed)return;
  bedBtn.textContent=bed.on?'Bett läuft':'Bett aus';bedBtn.className=bed.on?'on':'';setPressed(bedBtn,bed.on);
  bedBtn.disabled=!bed.on&&!bed.name;
  bedBtn.title=!bed.name?'Kein Bett gefunden — im Bett-Ordner liegt keine Audiodatei'
   :'Bett: '+bed.name+(bed.on?' — Klick blendet es aus':' — Klick blendet es ein');}
 bedBtn.onclick=()=>{if(bed)send({type:'bed',value:!bed.on});};
 // Host priority: the slider is the depth as a positive number of dB.
 const prio=$('prio'),prioVal=$('prioVal');let prioAt=0,prioSentAt=0;
 const prioText=v=>Number(v)>0?'−'+v+' dB':'aus';
 function sendPrio(){prioSentAt=Date.now();send({type:'priorityDepth',value:-Number(prio.value)});}
 // Dragging sends at most every 150 ms; letting go always sends the final value.
 prio.oninput=()=>{prioAt=Date.now();prioVal.textContent=prioText(prio.value);if(prioAt-prioSentAt>=150)sendPrio();};
 prio.onchange=()=>{prioAt=Date.now();sendPrio();};
 function setPrio(p){show($('prioBox'),!!p);if(!p)return;
  $('prioWho').textContent=p.label;show($('prioAct'),!!p.active);
  // Not while a finger is on it: the echo of an older value would pull the
  // thumb back.
  if(Date.now()-prioAt<1500)return;
  const v=String(Math.round(-p.depthDb));
  if(prio.value!==v)prio.value=v;
  const t=prioText(v);if(prioVal.textContent!==t)prioVal.textContent=t;}
 // Music return level: what the room hears of the music in the headphones,
 // next to the direct mics. Same drag rules as the priority slider.
 const retLvl=$('retLvl'),retLvlVal=$('retLvlVal');let retLvlAt=0,retLvlSentAt=0;
 const retLvlText=v=>Number(v)>0?'+'+v+' dB':Number(v)<0?'−'+(-Number(v))+' dB':'0 dB';
 function sendRetLvl(){retLvlSentAt=Date.now();send({type:'returnGain',value:Number(retLvl.value)});}
 retLvl.oninput=()=>{retLvlAt=Date.now();retLvlVal.textContent=retLvlText(retLvl.value);if(retLvlAt-retLvlSentAt>=150)sendRetLvl();};
 retLvl.onchange=()=>{retLvlAt=Date.now();sendRetLvl();};
 function setRetLvl(db){show($('retLvlBox'),typeof db==='number');if(typeof db!=='number')return;
  if(Date.now()-retLvlAt<1500)return;
  const v=String(Math.round(db));
  if(retLvl.value!==v)retLvl.value=v;
  const t=retLvlText(v);if(retLvlVal.textContent!==t)retLvlVal.textContent=t;}
 // Music on air ("Musik-Lautstärke"): every music source next to the voices.
 // Same drag rules as the sliders above.
 const musLvl=$('musLvl'),musLvlVal=$('musLvlVal'),musLvlReset=$('musLvlReset');let musLvlAt=0,musLvlSentAt=0;
 function showMusLvl(v){musLvlVal.textContent=retLvlText(v);show(musLvlReset,Number(v)!==0);}
 function sendMusLvl(){musLvlSentAt=Date.now();send({type:'musicGain',value:Number(musLvl.value)});}
 musLvl.oninput=()=>{musLvlAt=Date.now();showMusLvl(musLvl.value);if(musLvlAt-musLvlSentAt>=150)sendMusLvl();};
 musLvl.onchange=()=>{musLvlAt=Date.now();sendMusLvl();};
 musLvlReset.onclick=()=>{musLvl.value='0';musLvlAt=Date.now();showMusLvl('0');sendMusLvl();};
 function setMusLvl(db){show($('musLvlBox'),typeof db==='number');if(typeof db!=='number')return;
  if(Date.now()-musLvlAt<1500)return;
  const v=String(Math.round(db));
  if(musLvl.value!==v)musLvl.value=v;
  if(musLvlVal.textContent!==retLvlText(v))showMusLvl(v);}
 // ---- Einmessen (setup assistant) ----------------------------------------
 // The box listens and measures; the page only shows where it is. The buttons
 // are fixed elements switched by phase, and the step tiles are built once per
 // run and updated in place — rebuilding them per frame would pull a button
 // away from under a finger.
 const su={box:$('setupBox'),info:$('suInfo'),intro:$('suIntro'),steps:$('suSteps'),now:$('suNow'),sent:$('suSent'),
  rows:$('suRows'),start:$('suStart'),cancel:$('suCancel'),finish:$('suFinish'),
  apply:$('suApply'),discard:$('suDiscard'),chip:$('setupChip'),line:$('setupLine')};
 let suKey=null,suTileKey='',suTiles=[];
 const put=(el,t)=>{if(el.textContent!==t)el.textContent=t;};
 const pctTxt=p=>Math.round(Math.max(0,Math.min(1,p))*100)+' %';
 function suTile(name){const li=document.createElement('li'),sn=document.createElement('span'),
  b=document.createElement('b'),sd=document.createElement('span');
  sn.className='sn';sd.className='sd';b.textContent=name;
  li.appendChild(sn);li.appendChild(b);li.appendChild(sd);su.steps.appendChild(li);
  return {li:li,sn:sn,sd:sd,state:''};}
 // A tile's state is a word (ERLEDIGT / JETZT / OFFEN), not only its frame.
 function suSet(i,state,detail){const t=suTiles[i];if(!t)return;
  if(t.state!==state){t.state=state;t.li.className=state;
   t.sn.textContent=(i+1)+' · '+(state==='done'?'ERLEDIGT':state==='now'?'JETZT':'OFFEN');}
  put(t.sd,detail);}
 const VERD={'gut':'ok','zu leise':'warn','rauscht':'warn','übersteuert':'bad','kein Signal':'bad'};
 // One setting as "vorher → nachher". Only a change gets the arrow: a value
 // the assistant leaves alone (or a mic without a usable measurement) just
 // shows what it is.
 function suCell(name,a,b,unit,f,d){
  const was=f(a,d),now=b===null||b===undefined?was:f(b,d);
  return '<div><dt>'+name+'</dt><dd>'+(was===now?was+' '+unit:'<span class="was">'+was+' →</span> <b>'+now+' '+unit+'</b>')+'</dd></div>';}
 // One card per mic. What studiobox cannot set itself — the analog gain — is
 // a concrete instruction, with the way to check it again right beside it.
 function suResult(st){
  su.rows.innerHTML='';
  st.results.forEach(r=>{const a=r.after||{},b=r.before,notes=r.notes||[];
   const li=document.createElement('li');
   li.innerHTML='<div class="srh"><b>'+esc(r.label)+'</b><span class="was">Kanal '+r.channel+' · '+
    (r.speechDb===null?'keine Sprache':'Sprache '+fmt(r.speechDb)+' dB'+(r.snrDb===null?'':' · Abstand '+fmt(r.snrDb,0)+' dB'))+'</span>'+
    '<span class="verd '+(VERD[r.verdict]||'warn')+'">'+esc(r.verdict)+'</span></div>'+
    '<dl class="sset">'+suCell('Trim',b.trimDb,a.trimDb,'dB',sgn)+suCell('Hochpass',b.hpfHz,a.hpfHz,'Hz',fmt,0)+
    suCell('Gate',b.gateThresholdDb,a.gateThresholdDb,'dB',fmt)+suCell('Comp',b.compThresholdDb,a.compThresholdDb,'dB',fmt)+
    suCell('De-Esser',b.deessThresholdDb,a.deessThresholdDb,'dB',fmt)+suCell('Leveler-Start',b.seedDb,a.seedDb,'dB',sgn)+'</dl>';
   if(r.advice||notes.length){
    const adv=document.createElement('div'),btn=document.createElement('button');
    adv.className='adv';
    adv.innerHTML='<span>'+(r.advice?'<b>'+esc(r.advice)+'</b> ':'')+esc(notes.join(' '))+'</span>';
    btn.textContent='Nur diesen Kanal neu messen';
    btn.onclick=()=>send({type:'setupStart',value:{only:[r.label]}});
    adv.appendChild(btn);li.appendChild(adv);}
   su.rows.appendChild(li);});
 }
 function setSetup(s){
  const st=s.setup;
  // No assistant on this box (playout mode): no panel, no chip.
  if(!st){if(suKey!==''){suKey='';show(su.box,false);show(su.chip,false);show(su.line,false);}return;}
  const sil=st.phase==='silence',running=sil||st.phase==='speakers',result=st.phase==='result'&&!!st.results;
  const key=st.phase+'|'+st.mics.map(m=>m.label).join('|')+'|'+
   (result?st.results.map(r=>r.label+':'+r.verdict+':'+(r.after?r.after.trimDb:'')).join('|'):'');
  if(key!==suKey){suKey=key;
   show(su.box,true);show(su.chip,running);
   su.box.classList.toggle('idle',!running&&!result);
   show(su.start,!running&&!result);
   show(su.steps,running);show(su.now,running);show(su.cancel,running);show(su.finish,st.phase==='speakers');
   show(su.rows,result);show(su.apply,result);show(su.discard,result);
   if(result)suResult(st);
  }
  // The tiles belong to a run, not to a phase: they stay put from the silence
  // through the last speaker.
  const tk=running?st.mics.map(m=>m.label).join('|'):'';
  if(tk!==suTileKey||(running&&!suTiles.length)){suTileKey=tk;
   su.steps.innerHTML='';
   suTiles=running?['Stille'].concat(st.mics.map(m=>m.label),['Ergebnis']).map(suTile):[];}
  put(su.info,running?'läuft …':result
   ?'Ergebnis — noch nicht übernommen'+(st.automixFloorDb===null?'':' · Automix-Boden '+fmt(st.automixFloorDb,0)+' dB')
   :s.setupApplied?'Eingemessen ✓':'Noch nicht eingemessen');
  // What it does is only worth a paragraph until it has been done once.
  show(su.intro,!running&&!result&&!s.setupApplied);
  show(su.sent,running&&!sil&&!!st.current);
  // Everybody but the technician gets one line: who is up, what to read.
  show(su.line,running&&!tech());
  if(!running)return;
  suSet(0,sil?'now':'done',sil?'Raumgeräusch · '+pctTxt(st.silence):'gemessen');
  st.mics.forEach((m,i)=>suSet(i+1,m.done?'done':!sil&&m.label===st.current?'now':'open','Kanal '+m.channel+' · '+pctTxt(m.progress)));
  suSet(st.mics.length+1,'open','vorher / nachher');
  // The order does not matter — whoever talks is recognised; "Jetzt" is just
  // who is asked next.
  const now=sil?'Jetzt: Stille — bitte 5 Sekunden nicht sprechen.'
   :st.current?'Jetzt: '+st.current+' — bitte diesen Satz vorlesen:':'Auswertung …';
  put(su.now,now);put(su.sent,st.sentence||'');
  if(!tech())put(su.line,sil?'Einmessen: bitte kurz still sein.'
   :st.current?'Einmessen — jetzt: '+st.current+'. Bitte vorlesen: „'+(st.sentence||'')+'“':'Einmessen: Auswertung …');
 }
 su.start.onclick=()=>send({type:'setupStart'});
 su.cancel.onclick=()=>send({type:'setupCancel'});
 su.finish.onclick=()=>send({type:'setupFinish'});
 su.apply.onclick=()=>send({type:'setupApply'});
 su.discard.onclick=()=>send({type:'setupDiscard'});
 // Connection state in words: a dead page must not look like a quiet studio.
 const conn=document.getElementById('conn'),connText=document.getElementById('connText');
 function setConn(state){conn.className='conn '+state;
  connText.textContent=state==='ok'?'Verbunden':state==='lost'?'Verbindung weg – verbinde neu …':'Verbinde …';}
 function connect(){
  ws=new WebSocket('ws://'+location.host+'/'+(location.search||''));
  ws.onopen=()=>setConn('ok');
  ws.onmessage=e=>{const s=JSON.parse(e.data);
   // The pending play list is pushed separately (on change / on connect).
   if(s.type==='queue'){qItems=s.items||[];renderQueue();return;}
   // Listener feedback from eve, pushed on change (operators only).
   if(s.type==='listeners'){setListeners(s.status||null);return;}
   // First message of a connection: the role its token stands for.
   if(s.type==='hello'){setRole(s.role);return;}
   if(typeof s.serverNowMs==='number')clockSkew=s.serverNowMs-Date.now();
   // Playout-only mode: no channels -> hide the whole metering/mute surface.
   const playoutOnly=!s.channels||!s.channels.length;
   // The help text only describes controls this box actually has.
   document.body.classList.toggle('playout',playoutOnly);
   document.body.classList.toggle('live',!playoutOnly);
   mbtn.style.display=playoutOnly?'none':'';
   if(typeof s.micsMuted==='boolean'&&s.micsMuted!==muted){muted=s.micsMuted;setBtn();}
   if(s.recording!==recording){
    // Still "recording" right after our own stop: the tail is being written.
    if(!(s.recording===true&&recEnding())){recording=s.recording;recEndAt=0;setRec();}}
   else if(recEndAt&&!recording){recEndAt=0;setRec();}
   if(s.streaming!==streaming){streaming=s.streaming;setShip();}
   const mf=s.monitorFault===true;
   if(s.monitor!==monitor||mf!==monFault){monitor=s.monitor;monFault=mf;setMon();}
   setAir(s);
   const ek=air?air.state:'';
   if(ek!==endKey){endKey=ek;setEnd();}
   const mr=typeof s.musicReturn==='boolean'?s.musicReturn:null;
   const rf=s.musicReturnFault===true;
   if(mr!==musicReturn||rf!==retFault){musicReturn=mr;retFault=rf;setRet();}
   // The tone only exists where there is a local output to put it on.
   const tt=typeof s.testTone==='boolean'&&typeof s.monitor==='boolean'?s.testTone:null;
   if(tt!==testTone){testTone=tt;setTone();}
   const qm=s.queueMode||null;
   if(qm!==queueMode){queueMode=qm;renderQueue();}
   const bk=s.bed?(s.bed.on?'1':'0')+(s.bed.name||''):'';
   if(bk!==bedKey){bedKey=bk;
    // Which file is the bed is marked in its folder's listing.
    const moved=(s.bed&&s.bed.at?s.bed.at.folder+':'+s.bed.at.name:'')!==(bed&&bed.at?bed.at.folder+':'+bed.at.name:'');
    bed=s.bed||null;setBed();if(moved)loadFiles();}
   setSetup(s);
   setPrio(playoutOnly?null:s.priority||null);
   setRetLvl(playoutOnly?null:s.returnGainDb);
   setMusLvl(playoutOnly?null:s.musicGainDb);
   setAbh(s);
   // Two files in different folders can share a basename, so the location is
   // part of what makes the now-playing line stale, not just the name.
   const atKey=s.filePlayingAt?s.filePlayingAt.folder+':'+s.filePlayingAt.name:'';
   if(s.filePlaying!==playing||atKey!==playingAtKey){
    playing=s.filePlaying;playingAt=s.filePlayingAt||null;playingAtKey=atKey;markPlaying();}
   setNext(s.nextScheduled||null);
   playPos=typeof s.filePosition==='number'&&isFinite(s.filePosition)?s.filePosition:null;
   playPosAt=Date.now();
   updateFileTime(s.filePosition,s.fileDuration);
   if(!playoutOnly&&(!calm||playPosAt-meterAt>=200)){
    meterAt=playPosAt;
    const nums=playPosAt-numAt>=NUM_MS;if(nums)numAt=playPosAt;
    updateRows(s.channels,playPosAt,nums);
    const pkHi=hiOf(pgHi,'pk',s.outPeakDb),lgrHi=hiOf(pgHi,'lgr',Math.abs(s.limiterGrDb)),
     duckHi=hiOf(pgHi,'duck',Math.abs(s.duckDepthDb));
    if(nums){pgHi={};
     document.getElementById('mom').textContent=fmtLufs(s.momentaryLufs,0);
     document.getElementById('st').textContent=fmtLufs(s.shortTermLufs);
     document.getElementById('pk').textContent=fmtPeak(pkHi,0);
     document.getElementById('lgr').textContent=fmtGr(lgrHi,0);
     document.getElementById('duck').textContent=fmtGr(duckHi,0);
     duckOn.style.display=duckHi>0.5?'':'none';}
    setLevel(pkm,s.outPeakDb,playPosAt);
   }
  };
  ws.onclose=()=>{setConn('lost');setTimeout(connect,1000);};
 }
 // ⋮ menu (top-right): local-playout toggle + scheduled-files modal; more to come.
 const menu=document.getElementById('menu'),menuBtn=document.getElementById('menuBtn');
 menuBtn.onclick=e=>{e.stopPropagation();menu.style.display=menu.style.display==='none'?'':'none';};
 document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.style.display='none';});
 // Scheduled-files modal: every future timestamped file across all folders.
 const modal=document.getElementById('modal'),mlist=document.getElementById('mlist');
 function openSched(){modal.style.display='';
  mlist.innerHTML='<li class="none">lädt …</li>';
  fetch(withK('scheduled')).then(r=>r.json()).then(d=>{
   if(typeof d.now==='number')clockSkew=d.now-Date.now();
   const up=(d.scheduled||[]).filter(e=>e.playAtMs>airNow()).sort((a,b)=>a.playAtMs-b.playAtMs);
   if(!up.length){mlist.innerHTML='<li class="none">Nichts geplant</li>';return;}
   mlist.innerHTML='';
   up.forEach(e=>{const li=document.createElement('li');
    const fl=folderLabels.length>1?'<span class="fld">'+esc(folderLabels[e.folder]||'')+' / </span>':'';
    li.innerHTML='<span class="fname">'+fl+esc(e.name)+'</span><span class="when">'+fmtWhen(e.playAtMs)+'</span>';
    mlist.appendChild(li);});
  }).catch(()=>{mlist.innerHTML='<li class="none">Der Plan konnte nicht geladen werden</li>';});}
 // "Geräte verbinden" (technician): the role links as QR codes, the guest
 // link once per mic. The server renders the codes; the page only lays them out.
 const connBox=document.getElementById('connect'),connList=document.getElementById('connList'),
  connNote=document.getElementById('connNote');
 function openConnect(){connBox.style.display='';connNote.textContent='';connNote.className='sub';
  connList.innerHTML='<div class="none">lädt …</div>';
  fetch(withK('connect')).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).then(d=>{
   if(!d.enabled){connNote.className='sub warn';
    connNote.textContent='Rollen sind aus (meters.roles): jedes Gerät mit der Adresse darf alles.';}
   else if(!d.pinned){connNote.className='sub warn';
    connNote.textContent='Diese Links gelten nur bis zum nächsten Neustart. Für gedruckte Codes '+
     'die Schlüssel in meters.roles.tokens festlegen.';}
   else connNote.textContent='Mit der Kamera scannen. Der Link entscheidet, was das Gerät sieht und darf.';
   connList.innerHTML='';
   (d.links||[]).forEach(l=>{const c=document.createElement('section');c.className='qr';
    c.innerHTML='<h4>'+esc(l.label)+'</h4><div class="code" role="img" aria-label="QR-Code '+esc(l.label)+'">'+
     l.svg+'</div><div class="url">'+esc(l.url)+'</div>';
    connList.appendChild(c);});
  }).catch(()=>{connList.innerHTML='<div class="none">Die Links konnten nicht geladen werden</div>';});}
 document.getElementById('connBtn').onclick=()=>{menu.style.display='none';if(tech())openConnect();};
 document.getElementById('cclose').onclick=()=>{connBox.style.display='none';};
 connBox.onclick=e=>{if(e.target===connBox)connBox.style.display='none';};
 // Help modal (header "?"): a short German manual for new operators.
 const help=document.getElementById('help');
 document.getElementById('helpBtn').onclick=e=>{e.stopPropagation();menu.style.display='none';help.style.display='';};
 document.getElementById('hclose').onclick=()=>{help.style.display='none';};
 help.onclick=e=>{if(e.target===help)help.style.display='none';};
 document.getElementById('schedBtn').onclick=()=>{menu.style.display='none';openSched();};
 document.getElementById('mclose').onclick=()=>{modal.style.display='none';};
 modal.onclick=e=>{if(e.target===modal)modal.style.display='none';};
 // Welcome screen from the title: pick a source as a tile.
 document.getElementById('logo').onclick=()=>{renderTiles();welcome.style.display='';};
 document.getElementById('wclose').onclick=()=>{welcome.style.display='none';};
 welcome.onclick=e=>{if(e.target===welcome)welcome.style.display='none';};
 document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;
  welcome.style.display='none';modal.style.display='none';menu.style.display='none';
  help.style.display='none';connBox.style.display='none';});
 // ---- Hörer:innen / listener feedback from eve ------------------------------
 // Released comments and the heart count of the show on air. The host decides
 // when to look: the panel is folded unless opened (remembered per browser),
 // and folded it only says how many are new since it was last open. Nothing
 // moves, nothing sounds, and nothing here writes back to eve.
 const lis={box:$('lisbox'),title:$('lisTitle'),show:$('lisShow'),sum:$('lisSum'),
  hearts:$('lisHearts'),state:$('lisState'),list:$('lisList')};
 const store=(()=>{try{return window.localStorage||null;}catch(e){return null;}})();
 const sget=k=>{try{return store?store.getItem(k):null;}catch(e){return null;}};
 const sset=(k,v)=>{try{if(store)store.setItem(k,v);}catch(e){}};
 // ---- Abhören: the technician listens on this device ----------------------
 // One MP3 stream per device from the box. The source is switched inside the
 // running stream (the box fades out and in), so Aufnahme ↔ Roh compares the
 // same moment of the show without a reconnect. Which source is remembered
 // per browser; playing starts only from a tap (browsers want a gesture).
 const abh={box:$('abhBox'),play:$('abhPlay'),mic:$('abhMic'),state:$('abhState'),audio:$('abhAudio'),
  seg:{rec:$('abhRec'),raw:$('abhRaw'),air:$('abhAir')}};
 let abhKind=(()=>{const v=sget('sb.abhSrc');return v==='raw'||v==='air'?v:'rec';})();
 let abhMic=sget('sb.abhMic')||'raw'; // 'raw' = all mics, or 'mic:<label>'
 let abhId=null,abhErr=false,abhMics=null,abhLook=null,abhAirMs=null;
 const abhSrc=()=>abhKind==='raw'?abhMic:abhKind;
 function abhLine(){let t;
  if(!abhId)t='Hört auf diesem Gerät mit: Aufnahme = verarbeitet, Roh = die Mikros unverarbeitet, Auf Sendung = was das Gerät verlässt.';
  else if(abhErr)t='Verbindung unterbrochen — ▶ Abhören startet neu.';
  else{const base=abhKind==='air'?abhAirMs:abhLook;let buf=0;
   // What the browser holds on top of the box's own delay.
   try{const b=abh.audio.buffered;if(b&&b.length)buf=Math.max(0,b.end(b.length-1)-abh.audio.currentTime);}catch(e){}
   t=typeof base==='number'?'Etwa '+Math.round(base/1000+buf)+' s hinter dem Raum':'Verbindet …';}
  if(abh.state.textContent!==t)abh.state.textContent=t;}
 function abhRender(){for(const k in abh.seg)setPressed(abh.seg[k],k===abhKind);
  show(abh.mic,abhKind==='raw');
  abh.play.textContent=abhId?'■ Abhören stoppen':'▶ Abhören';setPressed(abh.play,!!abhId);abhLine();}
 function abhStart(){abhId=Math.random().toString(36).slice(2,10)+Date.now().toString(36);abhErr=false;
  abh.audio.src=withK('listen?id='+abhId+'&src='+encodeURIComponent(abhSrc()));
  const pr=abh.audio.play();if(pr&&pr.catch)pr.catch(()=>{abhErr=true;abhLine();});abhRender();}
 function abhStop(){abhId=null;abh.audio.pause();abh.audio.removeAttribute('src');abh.audio.load();abhRender();}
 abh.play.onclick=()=>{if(abhId)abhStop();else abhStart();};
 function abhPick(){sset('sb.abhSrc',abhKind);sset('sb.abhMic',abhMic);
  if(abhId)send({type:'listen',value:{id:abhId,src:abhSrc()}});abhRender();}
 for(const k in abh.seg)abh.seg[k].onclick=()=>{if(abhKind!==k){abhKind=k;abhPick();}};
 abh.mic.onchange=()=>{abhMic=abh.mic.value;abhPick();};
 abh.audio.onerror=()=>{if(abhId){abhErr=true;abhLine();}};
 // Live mode and the technician only: the box refuses everybody else anyway.
 function setAbh(s){const on=tech()&&!!s.air;show(abh.box,on);
  if(!on){if(abhId)abhStop();return;}
  abhLook=typeof s.lookaheadMs==='number'?s.lookaheadMs:null;
  abhAirMs=s.air&&typeof s.air.delayMs==='number'?s.air.delayMs:null;
  const mics=(s.channels||[]).filter(c=>c.role==='mic').map(c=>c.label);
  const key=JSON.stringify(mics);
  if(key!==abhMics){abhMics=key;abh.mic.innerHTML='';
   for(const v of ['raw'].concat(mics.map(l=>'mic:'+l))){const o=document.createElement('option');
    o.value=v;o.textContent=v==='raw'?'alle Mikros':v.slice(4);abh.mic.appendChild(o);}
   if(abhMic!=='raw'&&mics.indexOf(abhMic.slice(4))<0)abhMic='raw';
   abh.mic.value=abhMic;}
  abhLine();}
 abhRender();
 const hmFmt=mkFmt({hour:'2-digit',minute:'2-digit',hour12:false});
 let lisStatus=null,lisOpen=sget('sb.lisOpen')==='1';
 let lisSeen=new Set((()=>{try{return JSON.parse(sget('sb.lisSeen')||'[]');}catch(e){return [];}})());
 function setListeners(st){lisStatus=st;
  document.body.classList.toggle('listeners',!!st);renderListeners();renderGuide();}
 function renderListeners(){const st=lisStatus;
  show(lis.box,!!st);if(!st)return;
  const cs=st.comments||[],sh=st.show;
  put(lis.show,sh?sh.name:'');
  lis.hearts.textContent=sh?'♥ '+(st.hearts||0):'';
  lis.hearts.setAttribute('aria-label',(st.hearts||0)+' Herzen');
  // An empty list must never look like quiet listeners when eve is away.
  const old=st.updatedMs?' – Stand '+hmFmt.format(st.updatedMs):'';
  const words=st.state==='denied'?'Anmeldung bei eve abgelehnt – bitte die Technik fragen'
   :st.state==='offline'?'eve nicht erreichbar'+old
   :st.state==='connecting'?'Verbinde mit eve …'
   :!sh?'Laut Sendeplan läuft gerade keine Sendung':'';
  put(lis.state,words);show(lis.state,!!words);
  lis.state.classList.toggle('warn',st.state==='denied'||st.state==='offline');
  // Open, everything listed counts as seen (and only what this broadcast can
  // still show is worth remembering).
  if(lisOpen){lisSeen=new Set(cs.map(c=>c.id));sset('sb.lisSeen',JSON.stringify([...lisSeen]));}
  const fresh=cs.filter(c=>!lisSeen.has(c.id)).length;
  put(lis.sum,!sh?'':(cs.length===1?'1 Kommentar':cs.length+' Kommentare')+(!lisOpen&&fresh?' · '+fresh+' neu':''));
  lis.title.setAttribute('aria-expanded',lisOpen?'true':'false');
  show(lis.list,lisOpen&&!!sh);
  if(!lisOpen||!sh)return;
  lis.list.innerHTML=cs.length?'':'<li class="none">Noch keine freigegebenen Kommentare</li>';
  cs.forEach(c=>{const li=document.createElement('li');
   li.innerHTML='<span class="lt">'+(c.receivedAtMs?hmFmt.format(c.receivedAtMs):'')+'</span><span class="ltx">'+esc(c.text)+'</span>';
   lis.list.appendChild(li);});}
 lis.title.onclick=()=>{lisOpen=!lisOpen;sset('sb.lisOpen',lisOpen?'1':'0');renderListeners();};
 // ---- Sendung / the episode on air and its guide from eve ------------------
 // For the host: the show and its slot and, when the episode is prepared in
 // eve, the opening and closing to read out, the topics in their planned order
 // (a cue line readable mid-sentence; the notes fold out) and the questions
 // that get asked whatever happens. Read-only. The sections are rebuilt only
 // when eve's guide changes, and an open one stays open.
 const gd={box:$('guidebox'),title:$('gdTitle'),show:$('gdShow'),state:$('gdState'),
  body:$('gdBody'),ep:$('gdEp'),parts:$('gdParts')};
 let gdOpen=sget('sb.gdOpen')!=='0',gdKey='';
 function renderGuide(){const st=lisStatus,sh=st&&st.show;
  show(gd.box,!!sh);if(!sh)return;
  put(gd.show,sh.name+(sh.startMs&&sh.endMs?' · '+hmFmt.format(sh.startMs)+'–'+hmFmt.format(sh.endMs):''));
  const ep=st.episode||null,g=st.guide;
  const words=g==='pending'?'Lade den Ablauf aus eve …'
   :g==='none'?'Für diese Sendung ist in eve kein Ablauf vorbereitet'
   :g==='unavailable'?(ep?'Stand von vorhin – eve liefert den Ablauf gerade nicht':'Der Ablauf aus eve ist nicht abrufbar'):'';
  put(gd.state,words);show(gd.state,!!words);
  gd.state.classList.toggle('warn',g==='unavailable');
  gd.title.setAttribute('aria-expanded',gdOpen?'true':'false');
  show(gd.body,gdOpen&&!!ep);
  if(!ep){gdKey='';return;}
  const key=JSON.stringify(ep);if(key===gdKey)return;gdKey=key;
  put(gd.ep,ep.title||'');
  const was=new Set();
  try{gd.parts.querySelectorAll('details[open]').forEach(d=>{if(d.dataset&&d.dataset.k)was.add(d.dataset.k);});}catch(e){}
  // The HTML of scripts and notes is sanitized on the box (listeners/markdown.ts).
  const fold=(k,head,html)=>'<details data-k="'+esc(k)+'"'+(was.has(k)?' open':'')+'><summary>'+head+'</summary><div class="gdmd">'+html+'</div></details>';
  let h='';
  if(ep.opening)h+=fold('opening','<span class="tt">Anmoderation</span>',ep.opening);
  const ts=ep.topics||[],qs=ep.questions||[];
  if(ts.length)h+='<h3>Themen</h3><ol class="gdtopics">'+ts.map(t=>{
   const head='<span class="tt">'+esc(t.title)+'</span>'+(t.cue?'<span class="tc">'+esc(t.cue)+'</span>':'');
   return '<li>'+(t.html?fold('t'+t.id,head,t.html):head)+'</li>';}).join('')+'</ol>';
  if(qs.length)h+='<h3>Pflichtfragen</h3><ul class="gdq">'+qs.map(q=>'<li'+(q.asked?' class="asked"':'')+'>'
   +(q.asked?'<span class="ok" aria-label="gestellt">✓</span> ':'')+esc(q.text)+'</li>').join('')+'</ul>';
  if(ep.closing)h+=fold('closing','<span class="tt">Abmoderation</span>',ep.closing);
  gd.parts.innerHTML=h;}
 gd.title.onclick=()=>{gdOpen=!gdOpen;sset('sb.gdOpen',gdOpen?'1':'0');renderGuide();};
 // ---- Warteschlange / pending play list ----------------------------------
 // One panel, two lists: on air it mirrors the *server's* queue (the box is
 // the player, so the list lives there and every open page sees the same one,
 // pushed over the WebSocket); in Vorhören it is this browser's own audition
 // list (the <audio> element is the player, so it can only live here).
 // Enqueuing never starts audio by itself — like the recorder, playout is
 // armed by the operator (▶ Start), and a running file chains on when it ends.
 const queuebox=document.getElementById('queuebox'),qlist=document.getElementById('qlist'),
  qtitle=document.getElementById('qtitle'),qplayBtn=document.getElementById('qplay'),
  qsend=document.getElementById('qsend'),qclear=document.getElementById('qclear'),
  addall=document.getElementById('addall');
 let qItems=[],cueList=[],cueSeq=0,qOpen=true;
 // "einzeln | laufend" — whether the box rolls on into the next title by
 // itself. Null where the box does not offer the choice (it then runs through).
 let queueMode=null;
 const qmSingle=$('qmSingle'),qmChain=$('qmChain');
 qmSingle.onclick=()=>send({type:'queueMode',value:'single'});
 qmChain.onclick=()=>send({type:'queueMode',value:'chain'});
 const curQueue=()=>cueing?cueList:qItems;
 // "Musik / Sub / track.flac" with everything but the filename dimmed.
 function qName(it){const p=String(it.name).split('/');const base=p.pop();
  const fld=(!cueing&&folderLabels.length>1)?esc(folderLabels[it.folder]||'')+' / ':'';
  const dir=p.length?esc(p.join(' / '))+' / ':'';
  return (fld||dir?'<span class="fld">'+fld+dir+'</span>':'')+esc(base);}
 function renderQueue(){
  const items=curQueue();
  // An empty queue has nothing to show and nothing to start — the panel only
  // exists once something is in it (the ＋ buttons bring it back).
  queuebox.style.display=folders.length&&items.length?'':'none';
  qtitle.textContent=(cueing?'🎧 Vorhören-Queue':'Warteschlange')+' ('+items.length+')'+(qOpen?' ▾':' ▸');
  qtitle.setAttribute('aria-expanded',qOpen?'true':'false');
  qsend.style.display=cueing?'':'none';
  // The browser's own audition list always runs through; the choice is the box's.
  show($('qmode'),!!queueMode&&!cueing);
  setPressed(qmSingle,queueMode==='single');setPressed(qmChain,queueMode==='chain');
  qlist.style.display=qOpen?'':'none';
  qlist.innerHTML='';
  if(!items.length)return;
  items.forEach((it,i)=>{const li=document.createElement('li');
   li.innerHTML='<span class="qn">'+(i+1)+'</span>'+
    '<span class="fname" title="jetzt abspielen (übersprungene Titel fallen raus)">'+qName(it)+'</span>'+
    '<span class="qb"><button data-a="go" title="Ordner dieses Titels öffnen" aria-label="Ordner dieses Titels öffnen">📂</button>'+
    '<button data-a="up" title="nach oben" aria-label="nach oben">↑</button>'+
    '<button data-a="dn" title="nach unten" aria-label="nach unten">↓</button>'+
    '<button data-a="rm" title="entfernen" aria-label="entfernen">✕</button></span>';
   li.querySelector('.fname').onclick=()=>qJump(it);
   [...li.querySelectorAll('.qb button')].forEach(b=>{b.onclick=e=>{e.stopPropagation();qAct(b.dataset.a,it);};});
   qlist.appendChild(li);});
 }
 // Append one file to the active queue. On air the server owns the list, so we
 // only send the command and re-render when it echoes back.
 function enqueue(f,rel){
  if(cueing){cueList.push({id:++cueSeq,folder:f,name:rel});renderQueue();cueLabel();}
  else send({type:'queueAdd',value:{folder:f,name:rel}});}
 // Jumping means the entries above it are dropped, not silently played later.
 function qJump(it){
  if(!cueing){send({type:'queuePlay',value:{id:it.id}});return;}
  const i=cueList.findIndex(e=>e.id===it.id);
  if(i<0)return;
  cueList.splice(0,i+1);cuePlayItem(it);renderQueue();}
 function qAct(a,it){
  if(a==='go'){gotoFile(it.folder,it.name);return;}
  if(!cueing){send(a==='rm'?{type:'queueRemove',value:{id:it.id}}
   :{type:'queueMove',value:{id:it.id,delta:a==='up'?-1:1}});return;}
  const i=cueList.findIndex(e=>e.id===it.id);
  if(i<0)return;
  if(a==='rm')cueList.splice(i,1);
  else{const to=Math.max(0,Math.min(cueList.length-1,i+(a==='up'?-1:1)));
   if(to!==i)cueList.splice(to,0,cueList.splice(i,1)[0]);}
  renderQueue();cueLabel();}
 qtitle.onclick=()=>{qOpen=!qOpen;renderQueue();};
 qplayBtn.onclick=()=>{if(!cueing){send({type:'queueStart'});return;}
  if(cueList.length){cuePlayItem(cueList.shift());renderQueue();}};
 qclear.onclick=()=>{if(cueing){cueList=[];renderQueue();cueLabel();}else send({type:'queueClear'});};
 // Hand the audition list over to the box in one message. The cue list is kept
 // (it is the operator's working set), the on-air list simply grows by it.
 qsend.onclick=()=>{if(!cueList.length)return;
  send({type:'queueAdd',value:{items:cueList.map(i=>({folder:i.folder,name:i.name}))}});
  qsend.textContent='✓ übernommen';setTimeout(()=>{qsend.textContent='→ Playout';},1500);};
 // "＋ alle": every file of the listing on screen, in one go (in Vorhören only
 // the ones this browser can actually decode).
 addall.onclick=()=>{const rows=[...flist.children].filter(li=>li.dataset.rel&&(!cueing||cuePlayable(li.dataset.name)));
  if(!rows.length)return;
  if(cueing){rows.forEach(li=>cueList.push({id:++cueSeq,folder:folder,name:li.dataset.rel}));renderQueue();cueLabel();}
  else send({type:'queueAdd',value:{items:rows.map(li=>({folder:folder,name:li.dataset.rel}))}});};
 // ---- Vorhören (browser pre-listen) -------------------------------------
 // The browser fetches the file itself from /preview and decodes it locally,
 // so pre-listening costs the box no audio work and can never interrupt the
 // USB/on-air playout. Extensions browsers can't decode are refused up front.
 const CUE_OK=['.mp3','.m4a','.aac','.wav','.flac','.ogg','.oga','.opus'];
 const cueBtn=document.getElementById('cue'),cueLbl=document.getElementById('cueLbl'),
  cuebar=document.getElementById('cuebar'),fhint=document.getElementById('fhint'),
  cueAudio=document.getElementById('cueAudio'),cname=document.getElementById('cname'),
  cueStop=document.getElementById('cueStop'),cuejump=document.getElementById('cuejump');
 cuejump.onclick=()=>gotoFile(cueFolder,cueRel);
 let cueing=false;
 // Two things drive pre-listen auto-advance, in this order:
 //  1. cueList — the *explicit* Vorhören queue the operator built with ＋.
 //  2. cueRoll — a snapshot of the listing a click started in, pinned to the
 //     folder/subpath it came from, so simply clicking a file auditions that
 //     folder straight through. Browsing elsewhere meanwhile changes nothing;
 //     the highlight only shows while that same folder is on screen.
 let cueRoll=[],cueRollIdx=-1,cueFolder=-1,cueSub='',cueRel=null,cueName='';
 // Reinhören state: seconds to seek to once the browser knows the duration,
 // and whether what is being pre-listened to is the on-air file itself.
 let cueSeek=0,cueLive=false;
 const cuePlayable=n=>{const dot=n.lastIndexOf('.');return CUE_OK.indexOf(dot<0?'':n.slice(dot).toLowerCase())>=0;};
 function setCue(){cueBtn.className='cue'+(cueing?' on':'');
  cueLbl.textContent=cueing?'Vorhören an':'Vorhören';
  setPressed(cueBtn,cueing);
  document.body.classList.toggle('cueing',cueing);
  // What a click on a file does right now, in words above the listing.
  fhint.textContent=cueing?'Vorhören: nur im Browser':'Klick spielt sofort aus';
  if(!cueing)cueStopPlay();
  // The panel shows the queue of whichever mode is active.
  renderQueue();
  // The ▶/🎧 hint on every row depends on the mode.
  loadFiles();}
 // Highlight the row being pre-listened to — only when the listing on screen is
 // the one the queue belongs to.
 function markCue(){const here=cueing&&cueRel!==null&&cueFolder===folder&&cueSub===subPath;
  [...flist.children].forEach(li=>li.classList.toggle('cued',here&&li.dataset.rel===cueRel));}
 // A refresh (30 s poll, or navigating back) of the queue's *own* folder adopts
 // the fresh listing so newly synced files join the queue; the position follows
 // the file that is playing. Listings of any other folder are ignored.
 function cueSync(list){
  if(cueRel===null||cueFolder!==folder||cueSub!==subPath)return;
  const i=list.findIndex(e=>e.rel===cueRel);
  if(i<0)return; // the current file vanished — keep the old roll rather than jump
  cueRoll=list;cueRollIdx=i;cueLabel();}
 // "🎧 <file> (n/total) · N in der Queue" for the footer.
 function cueLabel(){if(!cueName)return;
  const roll=cueRollIdx>=0&&cueRoll.length>1?' ('+(cueRollIdx+1)+'/'+cueRoll.length+')':'';
  const q=cueList.length?' · '+cueList.length+' in der Queue':'';
  cname.textContent=(cueLive?'👂 on air: ':'🎧 ')+cueName+roll+q;}
 function cueStopPlay(){cueRoll=[];cueRollIdx=-1;cueFolder=-1;cueSub='';cueRel=null;cueName='';
  cueSeek=0;cueLive=false;
  cueAudio.pause();cueAudio.removeAttribute('src');cueAudio.load();
  cuebar.style.display='none';cuejump.style.display='none';cname.textContent='';markCue();}
 function cueStart(f,sub,roll,idx,name){
  if(idx<0){ // not a format the browser decodes — say so instead of burning CPU
   cueStopPlay();cuebar.style.display='';
   cname.textContent='⚠ '+name+' — dieses Format kann der Browser nicht abspielen';
   return;}
  cueFolder=f;cueSub=sub;cueRoll=roll;cueRollIdx=idx;cuePlayCurrent();}
 function cuePlayCurrent(){const e=cueRoll[cueRollIdx];
  if(!e){cueStopPlay();return;}
  cueName=e.name;cuePlay(cueFolder,e.rel);}
 // Play one entry of the *explicit* queue. It may live in another folder, so
 // it takes over: the folder roll is dropped and auto-advance continues down
 // the queue (and stops when it runs out).
 function cuePlayItem(it,seek){const p=String(it.name).split('/');
  cueRoll=[];cueRollIdx=-1;cueFolder=it.folder;cueSub=p.slice(0,-1).join('/');
  cueName=p[p.length-1];cuePlay(it.folder,it.name,seek);}
 function cuePlay(f,rel,seek){cueRel=rel;cueSeek=seek>0?seek:0;cueLive=false;
  cuebar.style.display='';cuejump.style.display='';
  cueLabel();
  cueAudio.src=withK('preview?folder='+f+'&name='+encodeURIComponent(rel));
  cueAudio.play().catch(()=>{});
  markCue();renderQueue();}
 // Auto-advance when a preview finishes (or the browser chokes on a file):
 // the explicit queue wins, otherwise walk on through the folder roll; running
 // out of both stops. The cueRel guard makes this a no-op once nothing is
 // cued, so the 'error' the <audio> may emit while being torn down can't
 // bounce back in here.
 function cueNext(){
  if(cueRel===null)return;
  if(cueList.length){cuePlayItem(cueList.shift());renderQueue();return;}
  if(cueRollIdx>=0&&cueRollIdx+1<cueRoll.length){cueRollIdx++;cuePlayCurrent();return;}
  cueStopPlay();}
 cueAudio.addEventListener('ended',cueNext);
 cueAudio.addEventListener('error',cueNext);
 // Seeking is only possible once the browser has the file's duration; /preview
 // serves byte ranges, so this is a real seek, not a re-download.
 cueAudio.addEventListener('loadedmetadata',()=>{
  if(cueSeek<=0)return;
  const dur=cueAudio.duration;
  const t=isFinite(dur)&&dur>0?Math.min(cueSeek,dur-0.25):cueSeek;
  cueSeek=0;
  try{cueAudio.currentTime=Math.max(0,t);}catch(e){/* not seekable: play from the top */}});
 // "Reinhören": listen in to what is on air, at the position the box is at.
 // Whatever was being auditioned is parked at the head of the Vorhören queue
 // so it comes back when the on-air file's preview runs out.
 function tuneIn(){
  if(!playingAt)return;
  const p=String(playingAt.name).split('/');const base=p[p.length-1];
  if(!cuePlayable(base)){cuebar.style.display='';cueName='';
   cname.textContent='⚠ '+base+' — dieses Format kann der Browser nicht abspielen';return;}
  if(cueRel!==null&&cueName)cueList.unshift({id:++cueSeq,folder:cueFolder,name:cueRel});
  if(!cueing){cueing=true;setCue();}
  // The frame is up to one meter tick old; add its age so the seek lands on
  // what is on air now rather than a moment ago.
  const at=playPos===null?0:playPos+(Date.now()-playPosAt)/1000;
  cuePlayItem({folder:playingAt.folder,name:playingAt.name},at);
  cueLive=true;cueLabel();
  renderQueue();}
 cueBtn.onclick=()=>{cueing=!cueing;setCue();};
 cueStop.onclick=()=>cueStopPlay();
 setBtn();
 setRec();
 setShip();
 setMon();
 setRet();
 setTone();
 setEnd();
 setBed();
 setStop();
 loadFolders();
 connect();
</script></body></html>`;

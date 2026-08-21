import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MeterSnapshot } from '../dsp/graph';
import { FileEntry, FolderEntry } from '../audio/file-dirs';
import { QueueItem } from '../audio/play-queue';
import { ScheduleEntry } from '../schedule';
import { Log } from '../util/log';

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
 *  The pending play list is pushed to every client as { type: 'queue', items }
 *  whenever it changes (and once per new connection), rather than riding along
 *  in the meter frames — it changes rarely and the frames are hot.
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

  constructor(
    private port: number,
    private log: Log
  ) {
    this.server = http.createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE.replace('__SERVER_TZ__', SERVER_TZ));
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
    this.wss.on('connection', (ws) => {
      // A fresh page knows nothing about the pending list until it changes,
      // so hand it over on connect.
      if (this.onQueue) ws.send(JSON.stringify({ type: 'queue', items: this.onQueue() }));
      ws.on('message', (raw) => {
        try {
          this.onCmd?.(JSON.parse(raw.toString()) as MeterCommand);
        } catch {
          /* ignore malformed control messages */
        }
      });
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

  /** Push the pending play list to every connected page. */
  broadcastQueue(items: QueueItem[]): void {
    const msg = JSON.stringify({ type: 'queue', items });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
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
    this.server.listen(this.port, () => this.log.info(`meters on http://localhost:${this.port}`));
  }

  broadcast(snapshot: MeterSnapshot): void {
    const msg = JSON.stringify(snapshot);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  stop(): void {
    this.wss.close();
    this.server.close();
  }
}

/** The server's IANA timezone. Filename timestamps are parsed in this zone
 *  (schedule.ts builds local Dates), so the page renders all schedule times
 *  and the footer clock with it — a browser in another zone must not disagree
 *  with the clock that actually fires auto-play. */
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>studiobox meters</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111'/%3E%3Ccircle cx='32' cy='40' r='7' fill='%238df'/%3E%3Cpath d='M19 30a18 18 0 0 1 26 0' stroke='%238df' stroke-width='5' fill='none' stroke-linecap='round'/%3E%3Cpath d='M10 21a31 31 0 0 1 44 0' stroke='%237cf' stroke-width='5' fill='none' stroke-linecap='round' opacity='.6'/%3E%3C/svg%3E">
<style>
 body{background:#111;color:#ddd;font:13px monospace;margin:0;height:100vh;height:100dvh;overflow:hidden;display:flex;flex-direction:column}
 h1{font-size:16px;color:#8df;font-weight:bold;letter-spacing:.3px}
 .content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;padding:14px 18px;overflow:hidden}
 .metering{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;max-width:760px}
 table{border-collapse:collapse;width:100%;max-width:760px;table-layout:fixed;flex:0 0 auto}
 td,th{padding:8px 8px;text-align:right;border-bottom:1px solid #222;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 th:first-child,td:first-child{text-align:left}
 col.c-ch{width:20%}col.c-role{width:11%}col.c-out{width:22%}col.c-gate{width:10%}col.c-comp{width:15%}col.c-mix{width:10%}col.c-mute{width:12%}
 td.mute{text-align:center;overflow:visible}
 .mtbtn{margin:0;padding:3px 0;width:58px;font:12px monospace;background:#2a2a2a;color:#9c9;border:1px solid #4a4a4a;border-radius:4px}
 .mtbtn:hover{border-color:#7cf}
 .mtbtn.on{background:#3a2f1c;color:#e6c878;border-color:#8a6d2f}
 .bar{display:inline-block;height:10px;background:#3a7;vertical-align:middle}
 .gr{background:#c64}.duck{background:#c4a}
 .master{margin:12px 0;font-size:14px;flex:0 0 auto}
 .master .lbl{color:#7cf;margin:0 5px 0 14px}
 .master .lbl:first-child{margin-left:0}
 .master .v{display:inline-block;width:6.5ch;text-align:right;color:#ddd}
 button{margin:0;padding:8px 12px;font:13px monospace;background:#223;color:#cde;border:1px solid #456;border-radius:5px;cursor:pointer;transition:background .12s,border-color .12s}
 button:hover{border-color:#7cf}
 button.mic-live{background:#c33;color:#fff;border-color:#e66;font-weight:bold}
 button.muted{background:#333;color:#9ab;border-color:#555}
 button.rec{background:#622;color:#fdd;border-color:#a44}
 button.rec.on{background:#c33;color:#fff;border-color:#c33}
 button.ship{background:#264;color:#dfd;border-color:#4a6}
 button.ship.on{background:#2a7;color:#fff;border-color:#2a7}
 button.mon{background:#234;color:#cdf;border-color:#46a}
 button.mon.on{background:#37a;color:#fff;border-color:#37a}
 /* Right-hand column: the browser (file list) above, the pending play list
    below — they belong together and share the space next to the metering. */
 .col2{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;max-width:760px}
 .files{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;margin-top:10px}
 #flist{list-style:none;margin:0;padding:0;flex:1 1 auto;overflow-y:auto;border-top:1px solid #222}
 .files li{padding:9px 8px;border-bottom:1px solid #222;cursor:pointer;display:flex;justify-content:space-between;gap:10px}
 .files li:hover{background:#1a1a1a}
 .files li.playing{background:#2a1830;color:#fbe}
 .files .none{color:#666}
 .files li .fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .files li .when{flex:0 0 auto;color:#667;white-space:nowrap}
 .files li.dir{color:#8df}
 .files li.dir .when{color:#556}
 .fbar{flex:0 0 auto;display:flex;align-items:center;gap:8px}
 .fbar #crumbs{flex:1 1 auto;min-width:0}
 /* "＋ alle" appends exactly the files listed below it — never the tree — so
    it carries the count and is hidden when there is nothing to add. */
 .fbar #addall{flex:0 0 auto;width:auto;margin:0;padding:3px 9px;font:12px monospace;
  background:transparent;color:#7a8a7a;border:1px solid #3a4a3a;border-radius:4px;cursor:pointer}
 .fbar #addall:hover{color:#cfc;border-color:#4a6a4a;background:#1d261d}
 #crumbs{flex:0 0 auto;padding:7px 8px;color:#8df;white-space:nowrap;overflow-x:auto}
 #crumbs .seg{cursor:pointer}
 #crumbs .seg:hover{text-decoration:underline}
 #crumbs .seg.cur{color:#ddd;cursor:default;text-decoration:none}
 #crumbs .sep{color:#555;margin:0 5px}
 .files li.sched .when{color:#ffd24a}
 .files li.sched{background:#201c0e}
 .files li.sched.playing{background:#2a1830}
 .files li.next .when{font-weight:bold}
 .files li.next{border-left:3px solid #ffd24a;padding-left:5px}
 /* The row currently being pre-listened to (Vorhören). Amber like the rest of
    the cue chrome. It has to win over .playing/.sched/.next and their
    combinations, hence last in the file and with the class doubled to outweigh
    the two-class .sched.playing rule above. */
 .files li.cued.cued{background:#4a3a16;color:#ffe2ab;border-left:3px solid #e6a52e;padding-left:5px}
 .files li.cued .when{color:#ffd24a}
 #next{color:#ffd24a;overflow-wrap:anywhere}
 #next .dim{color:#997}
 /* Pending play list. Same panel for both modes: on air it mirrors the box's
    server-side queue, in Vorhören it is the browser's own audition list. */
 .queue{flex:0 1 auto;min-height:0;display:flex;flex-direction:column;max-height:38vh;
  margin-top:10px;border-top:1px solid #333}
 .qhead{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 4px}
 .qhead .qt{flex:1 1 auto;min-width:0;color:#7cf;cursor:pointer;user-select:none;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .qhead .qt:hover{color:#adf}
 .qhead button{flex:0 0 auto;width:auto;padding:4px 9px;font-size:12px}
 #qlist{list-style:none;margin:0;padding:0;flex:1 1 auto;overflow-y:auto}
 #qlist li{display:flex;align-items:center;gap:8px;padding:7px 8px;border-bottom:1px solid #222}
 #qlist li:hover{background:#1a1a1a}
 #qlist .qn{flex:0 0 auto;width:2.5ch;text-align:right;color:#667}
 #qlist .fname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
 #qlist .fname:hover{color:#fff}
 #qlist .fld{color:#667}
 #qlist .qb{flex:0 0 auto;display:flex;gap:4px}
 #qlist .qb button{width:28px;padding:3px 0;font-size:12px;text-align:center}
 #qlist .none{color:#666;padding:9px 8px;display:block}
 /* Row actions stay quiet: the ⏰/🎧/▶ hint is what the eye should catch, the
    ＋ is only an affordance. Fixed width so rows line up and the button never
    resizes with its glyph. */
 .files li .addbtn{flex:0 0 auto;width:26px;margin:0;padding:2px 0;font:13px monospace;text-align:center;
  background:transparent;color:#6a7f6a;border:1px solid transparent;border-radius:4px;cursor:pointer}
 .files li:hover .addbtn{color:#9c9}
 .files li .addbtn:hover{color:#cfc;border-color:#4a6a4a;background:#1d261d}
 body.cueing .queue{border-top-color:#6a5320}
 body.cueing .qhead .qt{color:#e6c878}
 .nowplaying{color:#fbe;font-size:15px}
 .nowplaying b{color:#7cf}
 .bar-panel{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 18px;
  background:linear-gradient(#1f1f1f,#171717);box-shadow:0 0 10px rgba(0,0,0,.55)}
 .topbar{border-bottom:1px solid #333;flex-wrap:wrap}
 .footer{border-top:1px solid #333;flex-direction:column;align-items:stretch;gap:8px}
 .footer .ctl{display:flex;align-items:center;gap:10px}
 .topbar h1{margin:0}
 .topbar .dot{color:#3c8;margin-right:6px}
 /* The rec/ship/⋮ cluster: an auto left margin keeps it hard right in every
    layout (a flex spacer vanished when hidden on small screens, letting ⋮
    drift left); it wraps as a unit and stays right-aligned when it does. */
 .topbar .topright{margin-left:auto;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px}
 .bar-panel button{width:172px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 /* Top-right ⋮ menu: transport toggles that don't need to sit in the bar. */
 .menuwrap{position:relative}
 #menuBtn{width:44px;padding:8px 0;font-size:17px;font-weight:bold}
 .menu{position:absolute;right:0;top:calc(100% + 6px);z-index:20;width:230px;display:flex;flex-direction:column;gap:6px;
  background:#1c1c1c;border:1px solid #444;border-radius:6px;padding:8px;box-shadow:0 5px 18px rgba(0,0,0,.65)}
 .menu button{width:100%;flex:none;text-align:left}
 /* Folder picker: a flat one-click list (no nested <select>), divided from the
    action buttons below and highlighting the current folder. */
 .menu .folderlist{display:flex;flex-direction:column;gap:6px}
 .menu .folderlist:not(:empty){border-bottom:1px solid #333;padding-bottom:8px}
 .menu .fbtn.on{background:#2a3550;color:#cfe4ff;border-color:#4a6aa0}
 /* Clickable logo -> welcome screen. */
 .topbar h1{cursor:pointer;user-select:none}
 .topbar h1:hover{color:#adf}
 .topbar h1:hover .dot{color:#5fd}
 /* "Vorhören" (browser pre-listen) toggle. When on it must be unmistakable:
    amber button, amber rule under the top bar, amber-framed file list. */
 button.cue{background:#3a2f1c;color:#e6c878;border-color:#8a6d2f}
 button.cue.on{background:#e6a52e;color:#201603;border-color:#ffd24a;font-weight:bold}
 body.cueing .topbar{border-bottom:2px solid #e6a52e}
 body.cueing .files{outline:1px solid #6a5320;outline-offset:6px;border-radius:4px}
 /* Preview player: only present while pre-listening. */
 .cuebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
 /* "Jump to where this is playing from" buttons (now-playing line, cue bar,
    queue rows). Declared after .bar-panel button so the footer's fixed button
    width doesn't apply to them. */
 button.jump{flex:0 0 auto;width:30px;margin:0 0 0 8px;padding:2px 0;font:13px monospace;text-align:center;
  background:transparent;color:#6d8496;border:1px solid #33475a;border-radius:4px;cursor:pointer;
  vertical-align:middle}
 button.jump:hover{color:#cfe;border-color:#7cf;background:#1b2733}
 /* "Reinhören" belongs to the pre-listen family, so it wears its amber. */
 button.jump.tune{color:#a98a4a;border-color:#4d3f1e}
 button.jump.tune:hover{color:#ffd24a;border-color:#8a6d2f;background:#2a2211}
 /* Row the jump landed on: flashes until the next listing refresh. */
 .files li.focus{outline:2px solid #7cf;outline-offset:-2px}
 .cuebar .cname{color:#e6c878;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 1 160px}
 .cuebar audio{height:34px;max-width:100%;flex:1 1 240px}
 /* Welcome screen: the configured sources as big clickable tiles. */
 .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:14px;overflow-y:auto}
 .tile{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;
  padding:18px 10px;background:#20242c;border:1px solid #3a4150;border-radius:8px;cursor:pointer;
  color:#cde;text-align:center;transition:background .12s,border-color .12s,transform .08s}
 .tile:hover{background:#27303c;border-color:#7cf;transform:translateY(-1px)}
 .tile.on{border-color:#8df;background:#26313f}
 .tile .ic{font-size:30px;line-height:1}
 .tile .nm{overflow-wrap:anywhere}
 .mbox .sub{padding:0 14px 4px;color:#8a93a0}
 /* Help modal: a short German manual, so a new operator can work the page
    without being shown around. Sections that only exist in mixer mode are
    hidden on a playout-only box (body.playout, set from the snapshot). */
 #helpBtn{width:44px;padding:8px 0;font-size:17px;font-weight:bold}
 .help{padding:2px 16px 16px;overflow-y:auto;line-height:1.5;color:#cbd2d9}
 .help h4{margin:15px 0 5px;color:#8df;font-size:14px}
 .help h4:first-child{margin-top:8px}
 .help p{margin:5px 0}
 .help ul{margin:5px 0;padding-left:17px}
 .help li{margin:3px 0}
 .help b{color:#eef}
 .help .k{color:#e6c878;white-space:nowrap}
 .help .note{color:#8a93a0}
 body.playout .liveonly{display:none}
 /* Scheduled-files modal (opened from the ⋮ menu). */
 .modal{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px}
 .mbox{background:#191919;border:1px solid #444;border-radius:8px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 6px 24px rgba(0,0,0,.7)}
 .mhead{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #333;color:#ffd24a}
 .mhead button{width:auto;padding:4px 10px}
 #mlist{list-style:none;margin:0;padding:0;overflow-y:auto}
 #mlist li{padding:9px 14px;border-bottom:1px solid #222;display:flex;justify-content:space-between;gap:12px}
 #mlist li:last-child{border-bottom:none}
 #mlist .fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 #mlist .fname .fld{color:#667}
 #mlist .when{color:#ffd24a;white-space:nowrap}
 #mlist .none{color:#666}
 #clock{color:#8df;white-space:nowrap}
 #clock .tz{color:#667;margin-left:7px}
 #ftime{margin-right:auto;text-align:left}
 #ftime .rem{font-size:22px;font-weight:bold;color:#ffd24a;vertical-align:middle}
 /* Landscape (e.g. iPad rotated): two columns — metering left, files right. */
 @media (orientation:landscape) and (min-width:700px){
  .content{flex-direction:row;gap:22px}
  .metering{flex:1 1 0;min-width:0;max-width:none}
  .col2{flex:1 1 0;min-width:0;max-width:none}
  .files{margin-top:0}
 }
 /* Small portrait (phones): tighter chrome, full-width controls, and let the
    meter table scroll sideways instead of crushing its columns. */
 @media (max-width:520px){
  .content{padding:8px 10px}
  .bar-panel{padding:8px 10px;gap:8px}
  .bar-panel button{flex:1 1 auto;width:auto;min-width:0}
  #menuBtn,#helpBtn{flex:0 0 auto;width:44px}
  .menu button{flex:none;width:100%}
  .metering{overflow-x:auto}
  table{min-width:540px}
  td,th{padding:6px 5px}
  .master .lbl{margin:0 4px 0 8px}
  .footer .ctl{flex-wrap:wrap}
  #ftime{flex:1 1 100%}
  /* The footer's full-width button rule must not stretch the icon buttons. */
  .bar-panel button.jump{flex:0 0 auto;width:30px}
  /* Leave the file browser more of a small screen, and keep the queue row
     controls thumb-sized without eating the filename. */
  .queue{max-height:32vh}
  .qhead{padding:6px 2px}
  .qhead button{padding:4px 7px}
  #qlist li{gap:6px;padding:8px 4px}
  #qlist .qb{gap:3px}
  #qlist .qb button{width:26px;padding:6px 0}
  .fbar #addall{padding:3px 7px}
  /* Finger-sized tap target for the row ＋ (no hover to help on touch). */
  .files li .addbtn{width:34px;padding:6px 0}
 }
</style></head><body>
<div class="topbar bar-panel">
 <h1 id="logo" title="Quellen / sources"><span class="dot">●</span>studiobox</h1>
 <div class="topright">
  <button id="cue" class="cue" title="Vorhören: Dateien im Browser abhören, ohne die Ausspielung zu stören">🎧 Vorhören</button>
  <button id="rec" class="rec" style="display:none">● Start recording</button>
  <button id="ship" class="ship" style="display:none">● Start streaming</button>
  <button id="helpBtn" title="Hilfe / Kurzanleitung">?</button>
  <div class="menuwrap">
   <button id="menuBtn" title="more">⋮</button>
   <div id="menu" class="menu" style="display:none">
    <div id="folderList" class="folderlist"></div>
    <button id="mon" class="mon" style="display:none">● Start local playout</button>
    <button id="schedBtn">⏰ Scheduled files</button>
   </div>
  </div>
 </div>
</div>
<div class="content">
<div class="metering" id="metering">
<table id="t"><colgroup><col class="c-ch"><col class="c-role"><col class="c-out"><col class="c-gate"><col class="c-comp"><col class="c-mix"><col class="c-mute"></colgroup><thead><tr>
 <th>channel</th><th>role</th><th>out dB</th><th>gate</th><th>comp GR</th><th>automix</th><th>mute</th>
</tr></thead><tbody></tbody></table>
<div class="master">
 <span class="lbl">M</span><span class="v" id="mom">–</span>
 <span class="lbl">S</span><span class="v" id="st">–</span>
 <span class="lbl">Pk</span><span class="v" id="pk">–</span>
 <span class="lbl">Lim</span><span class="v" id="lgr">–</span>
 <span class="lbl">Duck</span><span class="v" id="duck">–</span>
</div>
</div>
<div class="col2">
<div class="files" id="files" style="display:none">
 <div class="fbar"><div id="crumbs"></div><button id="addall" title="alle Dateien dieser Liste anhängen">＋ alle</button></div>
 <ul id="flist"></ul>
</div>
<div class="queue" id="queuebox" style="display:none">
 <div class="qhead">
  <span class="qt" id="qtitle" title="ein-/ausklappen">▶ Warteschlange</span>
  <button id="qplay" title="nächsten Titel jetzt starten">▶ Start</button>
  <button id="qsend" title="diese Liste an die Ausspielung übergeben" style="display:none">→ Playout</button>
  <button id="qclear" title="Liste leeren">✕</button>
 </div>
 <ul id="qlist"></ul>
</div>
</div>
</div>
<div class="footer bar-panel">
 <div class="cuebar" id="cuebar" style="display:none">
  <span class="cname" id="cname"></span>
  <button class="jump" id="cuejump" title="Ordner dieses Titels öffnen" style="display:none">📂</button>
  <audio id="cueAudio" controls preload="none"></audio>
  <button id="cueStop">■ Vorhören stoppen</button>
 </div>
 <div class="nowplaying" id="nowplaying" style="display:none"></div>
 <div class="nowplaying" id="next" style="display:none"></div>
 <div class="ctl">
  <span id="clock"></span>
  <span id="ftime"></span>
  <button id="stop">■ Stop file</button>
  <button id="mute">Mute mics</button>
 </div>
</div>
<div id="modal" class="modal" style="display:none">
 <div class="mbox">
  <div class="mhead"><b>⏰ Scheduled files</b><button id="mclose">✕</button></div>
  <ul id="mlist"></ul>
 </div>
</div>
<div id="help" class="modal" style="display:none">
 <div class="mbox">
  <div class="mhead"><b>❓ studiobox — Kurzanleitung</b><button id="hclose">✕</button></div>
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
    <li>Ordner wechseln: <span class="k">⋮</span> oben rechts, oder auf das
    studiobox-Logo klicken (Kachelübersicht der Quellen).</li>
    <li>Zeilen mit <span class="k">📁</span> sind Unterordner — Klick öffnet
    sie, die Pfadzeile darüber führt wieder zurück.</li>
    <li><b>Klick auf eine Datei startet sie sofort</b> — im Normalbetrieb also
    on air. Läuft schon etwas, wird es ersetzt.</li>
   </ul>

   <h4>Warteschlange</h4>
   <ul>
    <li><span class="k">＋</span> hängt eine Datei an,
    <span class="k">＋ alle (n)</span> alle Dateien der angezeigten Liste
    (nur diese Liste, keine Unterordner).</li>
    <li><b>Anhängen startet nie von selbst.</b> Die Liste beginnt erst mit
    <span class="k">▶ Start</span> — oder automatisch, sobald der gerade
    laufende Titel zu Ende ist.</li>
    <li><span class="k">↑ ↓</span> sortieren, <span class="k">✕</span> entfernt,
    <span class="k">📂</span> springt zum Ordner des Titels.</li>
    <li>Klick auf den Namen spielt ihn sofort — die Titel darüber fallen dabei
    aus der Liste.</li>
    <li><span class="k">■ Stop file</span> beendet die Wiedergabe, ohne
    weiterzuschalten; die Liste bleibt erhalten.</li>
    <li class="note">Die Liste lebt nur im Arbeitsspeicher: nach einem Neustart
    des Geräts ist sie leer. Für garantierte Sendungen die Zeitsteuerung
    benutzen (siehe unten).</li>
   </ul>

   <h4>Vorhören und Reinhören</h4>
   <ul>
    <li><span class="k">🎧 Vorhören</span> einschalten: ein Klick auf eine Datei
    spielt sie dann <b>nur im Browser</b> ab. Die Ausspielung bleibt völlig
    unberührt. Die Seite bekommt dazu einen gelben Rahmen.</li>
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
    <li>Solche Dateien sind gelb markiert; der nächste Start steht in der
    Fußzeile, alle kommenden unter
    <span class="k">⋮ → Scheduled files</span>.</li>
    <li>Danach läuft die Warteschlange normal weiter.</li>
    <li class="note">Alle Zeiten sind die Uhrzeit des Geräts — sie steht mit
    Zeitzone unten links.</li>
   </ul>

   <div class="liveonly">
    <h4>Aufnahme, Stream, Ausspielung</h4>
    <ul>
     <li><span class="k">● Start recording</span> schreibt eine lokale
     Sicherheitsaufnahme (FLAC). Sie läuft <b>nicht</b> automatisch.</li>
     <li><span class="k">● Start streaming</span> schickt das fertige Programm
     an den Server (Icecast/Harbor).</li>
     <li><span class="k">⋮ → Start local playout</span> gibt das Programm
     zusätzlich auf der angeschlossenen Soundkarte aus.</li>
    </ul>

    <h4>Pegel</h4>
    <ul>
     <li>Pro Kanal: Aussteuerung, <b>gate</b> (offen/zu),
     <b>comp GR</b> (Kompressor-Absenkung), <b>automix</b> (automatische
     Mikrofonmischung) und <span class="k">mute</span>.</li>
     <li>Unten: <b>M</b>/<b>S</b> Lautheit (LUFS), <b>Pk</b> Spitzenpegel,
     <b>Lim</b> Limiter, <b>Duck</b> Absenkung der Musik unter Sprache.</li>
     <li><span class="k">● Mics open</span> / <span class="k">▶ Music only</span>
     schaltet alle Mikrofone stumm bzw. wieder auf.</li>
    </ul>
   </div>

   <h4>Wenn etwas nicht stimmt</h4>
   <ul>
    <li>Zeigt die Seite nichts mehr an, verbindet sie sich von selbst neu —
    einfach kurz warten oder neu laden. Die Sendung läuft dabei weiter.</li>
    <li>Netzwerkordner können langsam sein: eine Liste kann einen Moment
    brauchen, das stört die Ausspielung aber nicht.</li>
   </ul>
  </div>
 </div>
</div>
<div id="welcome" class="modal" style="display:none">
 <div class="mbox">
  <div class="mhead"><b>👋 studiobox — Quellen</b><button id="wclose">✕</button></div>
  <div class="sub">Ordner wählen:</div>
  <div id="tiles" class="tiles"></div>
 </div>
</div>
<script>
 const fmt=(v,d=1)=>(v===null||v===undefined||!isFinite(v))?'–':v.toFixed(d);
 const mmss=v=>{if(v===null||v===undefined||!isFinite(v))return '–';const s=Math.max(0,Math.round(v));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
 const bar=(v,max,cls)=>{const w=Math.max(0,Math.min(1,v/max))*60;return '<span class="bar '+(cls||'')+'" style="width:'+w+'px"></span>'};
 const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 // Build the meter rows once (rebuilding only when the channel set changes) and
 // update cell contents in place each frame. Rebuilding the whole tbody every
 // frame would destroy the per-row mute buttons mid-click, breaking the toggle.
 let rowEls=null;
 function ensureRows(channels){
  const tb=document.querySelector('#t tbody');
  if(rowEls&&rowEls.length===channels.length&&rowEls.every((r,i)=>r.label===channels[i].label))return;
  tb.innerHTML='';
  rowEls=channels.map(c=>{const tr=document.createElement('tr');
   tr.innerHTML='<td>'+esc(c.label)+'</td><td>'+esc(c.role)+'</td>'+
    '<td class="cout"></td><td class="cgate"></td><td class="ccomp"></td><td class="cmix"></td>'+
    '<td class="mute"><button class="mtbtn" data-label="'+esc(c.label)+'">mute</button></td>';
   tb.appendChild(tr);
   return {label:c.label,out:tr.querySelector('.cout'),gate:tr.querySelector('.cgate'),
    comp:tr.querySelector('.ccomp'),mix:tr.querySelector('.cmix'),mbtn:tr.querySelector('.mtbtn')};});
 }
 function updateRows(channels){
  ensureRows(channels);
  channels.forEach((c,i)=>{const r=rowEls[i];const mic=c.role==='mic';
   r.out.innerHTML=fmt(c.outDb)+' '+bar(c.outDb+60,60);
   // gate / comp GR / automix are mic-only concepts — blank them for music rows.
   r.gate.innerHTML=mic?bar(c.gateOpen,1):'';
   r.comp.innerHTML=mic?fmt(c.compGrDb)+' '+bar(c.compGrDb,20,'gr'):'';
   r.mix.textContent=mic?fmt(c.automixGainDb):'';
   r.mbtn.className='mtbtn'+(c.muted?' on':'');
   r.mbtn.textContent=c.muted?'unmute':'mute';});
 }
 let ws, muted=false, playing=null, recording=null, streaming=null, monitor=null;
 // Where the playing file lives ({folder,name}), so the page can jump back to
 // it — the server reports it because only the box knows how playback started.
 let playingAt=null, playingAtKey='';
 // Its playback position (seconds) and when that frame arrived, so Reinhören
 // can seek to where the box is *now*, not where it was one frame ago.
 let playPos=null, playPosAt=0;
 const mbtn=document.getElementById('mute');
 function setBtn(){
  if(muted){mbtn.textContent='▶ Music only';mbtn.className='muted';mbtn.title='Mics muted — click to open mics';}
  else{mbtn.textContent='● Mics open';mbtn.className='mic-live';mbtn.title='Mics are live — click for music only';}
 }
 mbtn.onclick=()=>{muted=!muted;setBtn();if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'micsMuted',value:muted}));};
 function send(cmd){if(ws&&ws.readyState===1)ws.send(JSON.stringify(cmd));}
 const rbtn=document.getElementById('rec');
 function setRec(){if(recording===null){rbtn.style.display='none';return;}rbtn.style.display='';rbtn.textContent=recording?'■ Stop recording':'● Start recording';rbtn.className='rec'+(recording?' on':'');}
 rbtn.onclick=()=>{if(recording===null)return;recording=!recording;setRec();send({type:'recording',value:recording});};
 const sbtn=document.getElementById('ship');
 function setShip(){if(streaming===null){sbtn.style.display='none';return;}sbtn.style.display='';sbtn.textContent=streaming?'■ Stop streaming':'● Start streaming';sbtn.className='ship'+(streaming?' on':'');}
 sbtn.onclick=()=>{if(streaming===null)return;streaming=!streaming;setShip();send({type:'streaming',value:streaming});};
 const mbtn2=document.getElementById('mon');
 function setMon(){if(monitor===null){mbtn2.style.display='none';return;}mbtn2.style.display='';mbtn2.textContent=monitor?'■ Stop local playout':'● Start local playout';mbtn2.className='mon'+(monitor?' on':'');}
 mbtn2.onclick=()=>{if(monitor===null)return;monitor=!monitor;setMon();send({type:'monitor',value:monitor});};
 const filesBox=document.getElementById('files'),flist=document.getElementById('flist'),folderList=document.getElementById('folderList');
 const crumbs=document.getElementById('crumbs');
 let folder=0,subPath='',folderLabels=[],folders=[];
 const tiles=document.getElementById('tiles'),welcome=document.getElementById('welcome');
 const stopBtn=document.getElementById('stop');
 // The Stop-file button only makes sense while a file is playing.
 function setStop(){stopBtn.style.display=playing?'':'none';}
 stopBtn.onclick=()=>send({type:'stopFile'});
 // Per-row mute toggles: the tbody is rebuilt every frame, so delegate the
 // click to the persistent tbody and read the channel label from the button.
 document.querySelector('#t tbody').addEventListener('click',e=>{
  const b=e.target.closest('.mtbtn');if(!b)return;
  send({type:'channelMuted',value:{label:b.dataset.label,muted:!b.classList.contains('on')}});
 });
 // Reflect the active folder in the flat picker (highlight the current row).
 function markFolderActive(){[...folderList.children].forEach(b=>{b.classList.toggle('on',Number(b.dataset.i)===folder);});}
 function selectFolder(i){folder=i;subPath='';menu.style.display='none';markFolderActive();
  [...tiles.children].forEach(t=>t.classList.toggle('on',Number(t.dataset.i)===folder));loadFiles();}
 const npbox=document.getElementById('nowplaying');
 function markPlaying(){[...flist.children].forEach(li=>{if(li.classList.contains('dir'))return;
  li.classList.toggle('playing',li.dataset.name===playing);});
  // The box moved on to another file: what is being listened in to is not the
  // on-air file any more, so stop calling it that.
  if(cueLive&&(!playingAt||playingAt.folder!==cueFolder||playingAt.name!==cueRel)){
   cueLive=false;cueLabel();}
  if(playing){npbox.style.display='';
   // Reinhören needs a location to fetch from and a format the browser plays.
   const canTune=!!playingAt&&cuePlayable(playing);
   npbox.innerHTML='♪ now playing: <b>'+esc(playing)+'</b>'+
    (playingAt?'<button class="jump" title="Ordner des laufenden Titels öffnen">📂</button>':'')+
    (canTune?'<button class="jump tune" title="Reinhören: die laufende Ausspielung an der aktuellen Stelle im Browser mithören">👂</button>':'');
   if(playingAt)npbox.querySelector('.jump').onclick=()=>gotoFile(playingAt.folder,playingAt.name);
   if(canTune)npbox.querySelector('.tune').onclick=tuneIn;}
  else{npbox.style.display='none';}
  setStop();}
 function updateFileTime(pos,dur){const el=document.getElementById('ftime');if(!el)return;
  if(dur!==null&&dur!==undefined&&isFinite(dur)){el.innerHTML='<span class="rem">'+mmss(dur-(pos||0))+' left</span>';}
  else if(pos!==null&&pos!==undefined&&isFinite(pos)){el.innerHTML='<span class="rem">'+mmss(pos)+'</span>';}
  else el.innerHTML='';}
 function loadFolders(){fetch('folders').then(r=>r.json()).then(d=>{
  // Entries are {label,icon}; tolerate bare strings from an older server.
  const fl=(d.folders||[]).map(f=>typeof f==='string'?{label:f,icon:'📁'}:f);
  folders=fl;
  folderLabels=fl.map(f=>f.label);
  folderList.innerHTML='';
  // One button per configured dir, straight in the ⋮ menu — no nested select.
  // With a single folder there's nothing to pick, so the list stays empty
  // (and its divider collapses via :not(:empty)).
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
 // Welcome screen: the same sources as the ⋮ menu, as big one-click tiles.
 function renderTiles(){
  tiles.innerHTML='';
  if(!folders.length){tiles.innerHTML='<div class="sub">keine Ordner konfiguriert</div>';return;}
  folders.forEach((f,i)=>{const t=document.createElement('div');
   t.className='tile'+(i===folder?' on':'');t.dataset.i=i;
   t.innerHTML='<span class="ic">'+esc(f.icon||'📁')+'</span><span class="nm">'+esc(f.label)+'</span>';
   t.onclick=()=>{welcome.style.display='none';selectFolder(i);};
   tiles.appendChild(t);});
 }
 // Server-clock skew (serverNow - clientNow): schedule marks compare against
 // the *server's* clock, which is what actually triggers auto-play.
 let clockSkew=0;
 const srvNow=()=>Date.now()+clockSkew;
 // All schedule times render in the *server's* timezone: filename timestamps
 // are parsed there, so a browser sitting in another zone must still show the
 // wallclock the operator wrote into the filename.
 const serverTz='__SERVER_TZ__';
 const mkFmt=o=>{try{return new Intl.DateTimeFormat('de-DE',Object.assign({timeZone:serverTz},o));}
  catch(e){return new Intl.DateTimeFormat('de-DE',o);}};
 const dayFmt=mkFmt({day:'2-digit',month:'2-digit'});
 const timeFmt=mkFmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 const fmtWhen=ms=>{const sameDay=dayFmt.format(ms)===dayFmt.format(srvNow());
  return (sameDay?'':dayFmt.format(ms)+' ')+timeFmt.format(ms);};
 // Live server clock in the footer — the clock auto-play actually fires on.
 const clockEl=document.getElementById('clock');
 const tickClock=()=>{clockEl.innerHTML='⏱ '+timeFmt.format(srvNow())+' <span class="tz">'+esc(serverTz)+'</span>';};
 tickClock();setInterval(tickClock,1000);
 // Re-apply schedule marks to the existing rows (which timestamps are still in
 // the future changes as time passes, without any new fetch).
 function markSchedule(){
  const rows=[...flist.children].filter(li=>li.dataset.name);
  let next=null;
  rows.forEach(li=>{const at=Number(li.dataset.playat);
   const up=isFinite(at)&&at>0&&at>srvNow();
   li.classList.toggle('sched',up);
   li.classList.remove('next');
   if(up&&(next===null||at<Number(next.dataset.playat)))next=li;});
  if(next)next.classList.add('next');
 }
 // Breadcrumb over the current position: folder label + each subPath segment,
 // every non-current segment clickable to jump back up.
 function renderCrumbs(){
  const segs=subPath?subPath.split('/'):[];
  let html='<span class="seg'+(segs.length?'':' cur')+'" data-i="-1">'+esc(folderLabels[folder]||'files')+'</span>';
  segs.forEach((s,i)=>{html+='<span class="sep">/</span><span class="seg'+(i===segs.length-1?' cur':'')+'" data-i="'+i+'">'+esc(s)+'</span>';});
  crumbs.innerHTML=html;
 }
 crumbs.onclick=e=>{const s=e.target.closest('.seg');if(!s||s.classList.contains('cur'))return;
  const i=Number(s.dataset.i);
  subPath=i<0?'':subPath.split('/').slice(0,i+1).join('/');
  loadFiles();};
 // The optional focus argument (a bare filename) marks the row a jump landed
 // on, so the file you came looking for is visible instead of somewhere down a
 // long listing.
 function loadFiles(focus){fetch('files?folder='+folder+'&path='+encodeURIComponent(subPath)).then(r=>r.json()).then(d=>{
  const fs=d.files||[];
  if(typeof d.now==='number')clockSkew=d.now-Date.now();
  filesBox.style.display='';
  renderCrumbs();
  addall.style.display='none';
  flist.innerHTML='';
  if(!fs.length){flist.innerHTML='<li class="none">no audio files in this folder</li>';cueSync([]);return;}
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
    li.onclick=()=>{subPath=subPath?subPath+'/'+name:name;loadFiles();};
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
   li.innerHTML='<span class="fname">'+esc(name)+'</span><span class="when">'+when+'</span>'+
    (canAdd?'<button class="addbtn" title="an die Warteschlange anhängen">＋</button>':'');
   if(canAdd)li.querySelector('.addbtn').onclick=e=>{e.stopPropagation();enqueue(folder,rel);};
   // In Vorhören mode a click pre-listens in the browser and leaves the
   // on-air playout completely untouched; otherwise it starts real playout.
   li.onclick=()=>{if(cueing)cueStart(folder,subPath,cueable,idx,name);
    else send({type:'playFile',value:{folder:folder,name:rel}});};
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
   nextBox.innerHTML='⏰ next auto-play: '+dir+'<b>'+esc(base)+'</b> @ '+fmtWhen(n.playAtMs);}
  else nextBox.style.display='none';
 }
 function connect(){
  ws=new WebSocket('ws://'+location.host);
  ws.onmessage=e=>{const s=JSON.parse(e.data);
   // The pending play list is pushed separately (on change / on connect).
   if(s.type==='queue'){qItems=s.items||[];renderQueue();return;}
   if(typeof s.serverNowMs==='number')clockSkew=s.serverNowMs-Date.now();
   // Playout-only mode: no channels -> hide the whole metering/mute surface.
   const playoutOnly=!s.channels||!s.channels.length;
   // The help text only describes controls this box actually has.
   document.body.classList.toggle('playout',playoutOnly);
   document.getElementById('metering').style.display=playoutOnly?'none':'';
   mbtn.style.display=playoutOnly?'none':'';
   if(typeof s.micsMuted==='boolean'&&s.micsMuted!==muted){muted=s.micsMuted;setBtn();}
   if(s.recording!==recording){recording=s.recording;setRec();}
   if(s.streaming!==streaming){streaming=s.streaming;setShip();}
   if(s.monitor!==monitor){monitor=s.monitor;setMon();}
   // Two files in different folders can share a basename, so the location is
   // part of what makes the now-playing line stale, not just the name.
   const atKey=s.filePlayingAt?s.filePlayingAt.folder+':'+s.filePlayingAt.name:'';
   if(s.filePlaying!==playing||atKey!==playingAtKey){
    playing=s.filePlaying;playingAt=s.filePlayingAt||null;playingAtKey=atKey;markPlaying();}
   setNext(s.nextScheduled||null);
   playPos=typeof s.filePosition==='number'&&isFinite(s.filePosition)?s.filePosition:null;
   playPosAt=Date.now();
   updateFileTime(s.filePosition,s.fileDuration);
   if(!playoutOnly){
    updateRows(s.channels);
    document.getElementById('mom').textContent=fmt(s.momentaryLufs);
    document.getElementById('st').textContent=fmt(s.shortTermLufs);
    document.getElementById('pk').textContent=fmt(s.outPeakDb);
    document.getElementById('lgr').textContent=fmt(s.limiterGrDb);
    document.getElementById('duck').textContent=fmt(s.duckDepthDb);
   }
  };
  ws.onclose=()=>setTimeout(connect,1000);
 }
 // ⋮ menu (top-right): local-playout toggle + scheduled-files modal; more to come.
 const menu=document.getElementById('menu'),menuBtn=document.getElementById('menuBtn');
 menuBtn.onclick=e=>{e.stopPropagation();menu.style.display=menu.style.display==='none'?'':'none';};
 document.addEventListener('click',e=>{if(!menu.contains(e.target))menu.style.display='none';});
 // Scheduled-files modal: every future timestamped file across all folders.
 const modal=document.getElementById('modal'),mlist=document.getElementById('mlist');
 function openSched(){modal.style.display='';
  mlist.innerHTML='<li class="none">loading…</li>';
  fetch('scheduled').then(r=>r.json()).then(d=>{
   if(typeof d.now==='number')clockSkew=d.now-Date.now();
   const up=(d.scheduled||[]).filter(e=>e.playAtMs>srvNow()).sort((a,b)=>a.playAtMs-b.playAtMs);
   if(!up.length){mlist.innerHTML='<li class="none">nothing scheduled</li>';return;}
   mlist.innerHTML='';
   up.forEach(e=>{const li=document.createElement('li');
    const fl=folderLabels.length>1?'<span class="fld">'+esc(folderLabels[e.folder]||'')+' / </span>':'';
    li.innerHTML='<span class="fname">'+fl+esc(e.name)+'</span><span class="when">'+fmtWhen(e.playAtMs)+'</span>';
    mlist.appendChild(li);});
  }).catch(()=>{mlist.innerHTML='<li class="none">could not load the schedule</li>';});}
 // Help modal (header "?"): a short German manual for new operators.
 const help=document.getElementById('help');
 document.getElementById('helpBtn').onclick=e=>{e.stopPropagation();menu.style.display='none';help.style.display='';};
 document.getElementById('hclose').onclick=()=>{help.style.display='none';};
 help.onclick=e=>{if(e.target===help)help.style.display='none';};
 document.getElementById('schedBtn').onclick=()=>{menu.style.display='none';openSched();};
 document.getElementById('mclose').onclick=()=>{modal.style.display='none';};
 modal.onclick=e=>{if(e.target===modal)modal.style.display='none';};
 // Welcome screen from the logo: pick a source as a tile.
 document.getElementById('logo').onclick=()=>{renderTiles();welcome.style.display='';};
 document.getElementById('wclose').onclick=()=>{welcome.style.display='none';};
 welcome.onclick=e=>{if(e.target===welcome)welcome.style.display='none';};
 document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;
  welcome.style.display='none';modal.style.display='none';menu.style.display='none';
  help.style.display='none';});
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
  qtitle.textContent=(cueing?'🎧 Vorhören-Queue':'▶ Warteschlange')+' ('+items.length+')'+(qOpen?'':' ▸');
  qsend.style.display=cueing?'':'none';
  qlist.style.display=qOpen?'':'none';
  qlist.innerHTML='';
  if(!items.length)return;
  items.forEach((it,i)=>{const li=document.createElement('li');
   li.innerHTML='<span class="qn">'+(i+1)+'</span>'+
    '<span class="fname" title="jetzt abspielen (übersprungene Titel fallen raus)">'+qName(it)+'</span>'+
    '<span class="qb"><button data-a="go" title="Ordner dieses Titels öffnen">📂</button>'+
    '<button data-a="up" title="nach oben">↑</button>'+
    '<button data-a="dn" title="nach unten">↓</button>'+
    '<button data-a="rm" title="entfernen">✕</button></span>';
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
 const cueBtn=document.getElementById('cue'),cuebar=document.getElementById('cuebar'),
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
  cueBtn.textContent=cueing?'🎧 Vorhören AN':'🎧 Vorhören';
  document.body.classList.toggle('cueing',cueing);
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
  cueAudio.src='preview?folder='+f+'&name='+encodeURIComponent(rel);
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
 setStop();
 loadFolders();
 connect();
</script></body></html>`;

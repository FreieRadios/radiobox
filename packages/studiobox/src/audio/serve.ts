import { spawn } from 'node:child_process';
import { Log } from '../util/log';
import { ListenClient, ListenEncoder, frameSync } from './listen';

/**
 * The programme as a stream from studiobox itself (`/stream`, roadmap
 * M1c.1): what leaves the box — behind the air delay, like the harbor
 * encoder — served over plain HTTP, so a Pi at the desk or any player on the
 * LAN pulls it without an Icecast in between.
 *
 * Ogg/FLAC (`flac`, 24 bit, lossless) for a box, MP3 (`mp3`) for a browser.
 * One encoder per format however many listen, started with the first client
 * and ended a few seconds after the last one left. A client that joins a
 * running Ogg stream first gets the stream's header pages (kept from the
 * start, as an Icecast does) and then the stream from the next page on; an
 * MP3 client starts at a frame header.
 */
export type StreamFormat = 'flac' | 'mp3';

export const STREAM_TYPES: Record<StreamFormat, string> = {
  flac: 'audio/ogg',
  mp3: 'audio/mpeg',
};

export interface StreamStatus {
  /** Serving (switched on); off refuses and ends every client. */
  on: boolean;
  /** Clients connected right now, all formats. */
  clients: number;
}

export interface ProgrammeStreamOptions {
  sampleRate: number;
  log: Log;
  mp3Kbps?: number;
  maxClients?: number;
  graceMs?: number;
  spawn?: (args: string[]) => ListenEncoder;
}

/** A client further behind than this (~20 s of FLAC) is dropped. */
const MAX_CLIENT_BACKLOG = 4 * 1024 * 1024;
/** Encoder input queued beyond this many seconds is dropped, not queued. */
const MAX_ENCODER_BACKLOG_SEC = 2;

interface Feed {
  format: StreamFormat;
  enc: ListenEncoder;
  clients: Set<ListenClient>;
  /** Clients that still need their first page / frame. */
  joining: Set<ListenClient>;
  /** Ogg only: the header pages (granule position 0) and whether they are
   *  complete (the first audio page has been seen). */
  headers: Buffer[];
  headersDone: boolean;
  pager: OggPager | null;
  idle: NodeJS.Timeout | null;
}

const defaultSpawn = (args: string[]): ListenEncoder => spawn('ffmpeg', args);

export class ProgrammeStream {
  private feeds = new Map<StreamFormat, Feed>();
  private onState = true;

  constructor(private opts: ProgrammeStreamOptions) {}

  parse(format: unknown): StreamFormat | null {
    if (format === undefined || format === null || format === '' || format === 'flac') {
      return 'flac';
    }
    return format === 'mp3' ? 'mp3' : null;
  }

  get on(): boolean {
    return this.onState;
  }

  /** Switch serving on or off. Off ends every client and encoder. */
  set(on: boolean): void {
    this.onState = on;
    if (!on) this.stopAll();
    this.opts.log.info(`programme stream ${on ? 'on' : 'off'}`);
  }

  status(): StreamStatus {
    let clients = 0;
    for (const f of this.feeds.values()) clients += f.clients.size;
    return { on: this.onState, clients };
  }

  /** Attach an HTTP response. 'bad' format, 'off', or 'full'. */
  attach(format: unknown, client: ListenClient): 'ok' | 'bad' | 'off' | 'full' {
    const fmt = this.parse(format);
    if (!fmt) return 'bad';
    if (!this.onState) return 'off';
    if (this.status().clients >= (this.opts.maxClients ?? 16)) return 'full';
    const f = this.feeds.get(fmt) ?? this.start(fmt);
    if (f.idle) {
      clearTimeout(f.idle);
      f.idle = null;
    }
    f.clients.add(client);
    f.joining.add(client);
    client.on('close', () => this.detach(f, client));
    return 'ok';
  }

  /** One block of what leaves the box (interleaved f32 stereo). */
  write(buf: Buffer): void {
    if (!this.feeds.size) return;
    const limit = MAX_ENCODER_BACKLOG_SEC * this.opts.sampleRate * 8;
    for (const f of this.feeds.values()) {
      if (f.enc.stdin.writableLength > limit) continue; // encoder stalled: drop
      f.enc.stdin.write(buf);
    }
  }

  /** End every client and encoder (shutdown, or switched off). */
  stopAll(): void {
    for (const f of [...this.feeds.values()]) this.end(f);
  }

  // ----------------------------------------------------------------

  private start(format: StreamFormat): Feed {
    const sr = String(this.opts.sampleRate);
    const codec =
      format === 'flac'
        ? // 24 bit; pages of 100 ms so a client is not held back by the muxer.
          ['-c:a', 'flac', '-sample_fmt', 's32', '-compression_level', '5'].concat([
            '-f',
            'ogg',
            '-page_duration',
            '100000',
          ])
        : ['-c:a', 'libmp3lame', '-b:a', `${this.opts.mp3Kbps ?? 320}k`, '-f', 'mp3'];
    const enc = (this.opts.spawn ?? defaultSpawn)([
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'f32le',
      '-ar',
      sr,
      '-ac',
      '2',
      '-i',
      'pipe:0',
      '-map',
      '0:a',
      ...codec,
      '-flush_packets',
      '1',
      'pipe:1',
    ]);
    const f: Feed = {
      format,
      enc,
      clients: new Set(),
      joining: new Set(),
      headers: [],
      headersDone: false,
      pager: format === 'flac' ? new OggPager() : null,
      idle: null,
    };
    enc.stdout.on('data', (chunk: Buffer) => {
      if (f.pager) for (const page of f.pager.push(chunk)) this.page(f, page);
      else this.frames(f, chunk);
    });
    enc.stdin.on('error', () => {}); // an encoder that died is handled on exit
    enc.on('exit', () => {
      if (this.feeds.get(format) !== f) return;
      this.opts.log.warn(`programme stream encoder (${format}) exited`);
      this.end(f);
    });
    this.feeds.set(format, f);
    this.opts.log.info(`programme stream: ${format} encoder started`);
    return f;
  }

  /** Ogg: keep the header pages; a joining client gets them first. */
  private page(f: Feed, page: Buffer): void {
    if (!f.headersDone) {
      if (granuleIsZero(page)) {
        f.headers.push(page);
        return;
      }
      f.headersDone = true;
    }
    for (const c of f.clients) {
      if (f.joining.has(c)) {
        f.joining.delete(c);
        for (const h of f.headers) this.send(c, h);
      }
      this.send(c, page);
    }
  }

  /** MP3: a joining client starts at a frame header. */
  private frames(f: Feed, chunk: Buffer): void {
    for (const c of f.clients) {
      let data = chunk;
      if (f.joining.has(c)) {
        const at = frameSync(chunk);
        if (at < 0) continue;
        data = chunk.subarray(at);
        f.joining.delete(c);
      }
      this.send(c, data);
    }
  }

  private send(c: ListenClient, data: Buffer): void {
    if (c.writableLength > MAX_CLIENT_BACKLOG) {
      c.destroy(); // too far behind; 'close' detaches it
      return;
    }
    c.write(data);
  }

  private detach(f: Feed, c: ListenClient): void {
    f.clients.delete(c);
    f.joining.delete(c);
    if (f.clients.size || f.idle || this.feeds.get(f.format) !== f) return;
    f.idle = setTimeout(() => this.end(f), this.opts.graceMs ?? 3000);
    f.idle.unref?.();
  }

  private end(f: Feed): void {
    if (this.feeds.get(f.format) !== f) return;
    this.feeds.delete(f.format);
    if (f.idle) clearTimeout(f.idle);
    for (const c of [...f.clients]) c.destroy();
    f.clients.clear();
    try {
      f.enc.stdin.end();
    } catch {
      /* already gone */
    }
    f.enc.kill();
    this.opts.log.info(`programme stream: ${f.format} encoder ended`);
  }
}

/** Splits a byte stream into whole Ogg pages. */
export class OggPager {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const pages: Buffer[] = [];
    for (;;) {
      const at = this.buf.indexOf('OggS');
      if (at < 0) {
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3));
        break;
      }
      if (at > 0) this.buf = this.buf.subarray(at);
      if (this.buf.length < 27) break;
      const segs = this.buf[26];
      if (this.buf.length < 27 + segs) break;
      let body = 0;
      for (let i = 0; i < segs; i++) body += this.buf[27 + i];
      const len = 27 + segs + body;
      if (this.buf.length < len) break;
      pages.push(Buffer.from(this.buf.subarray(0, len)));
      this.buf = this.buf.subarray(len);
    }
    return pages;
  }
}

/** Header pages carry granule position 0. */
function granuleIsZero(page: Buffer): boolean {
  for (let i = 6; i < 14; i++) if (page[i] !== 0) return false;
  return true;
}

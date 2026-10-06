import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { Log } from '../util/log';

/**
 * "Abhören": the technician listens on a tablet to what is being recorded,
 * processed or not, or to what leaves the box.
 *
 * Every listener gets its own MP3 stream over plain HTTP (an `<audio>`
 * element plays it, also with the screen locked) and picks what feeds it:
 *
 *   - `rec`: the programme as it goes into the recording (the look-ahead
 *     behind the room);
 *   - `raw`: the dry mics, summed (mono), each after its input trim — the
 *     same moment as `rec`, so switching between the two compares the
 *     processing and not the gain staging; `mic:<label>` is one mic alone;
 *   - `air`: what leaves the box, one air delay behind the room.
 *
 * A switch happens inside the running stream (a short fade out and in),
 * so A/B needs no reconnect and lands on the same moment of the show. An
 * encoder runs only while somebody listens; `room()` and `air()` cost
 * nothing otherwise.
 */
export type ListenSource = 'rec' | 'raw' | 'air' | `mic:${string}`;

/** What `spawn` has to give back: an encoder that reads interleaved f32
 *  stereo on stdin and writes MP3 on stdout. */
export interface ListenEncoder {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
  on(ev: 'exit', fn: () => void): unknown;
}

/** The part of an HTTP response the hub writes to. */
export interface ListenClient {
  write(chunk: Buffer): boolean;
  readonly writableLength: number;
  destroy(): void;
  on(ev: 'close', fn: () => void): unknown;
}

export interface ListenHubOptions {
  sampleRate: number;
  /** Mic labels in graph order (for `mic:<label>` and the dry taps). */
  mics: readonly string[];
  log: Log;
  bitrateKbps?: number;
  /** At most this many listeners at a time (each is one encoder). */
  maxListeners?: number;
  /** An encoder stays this long after its last connection closed, so a
   *  browser that reconnects (Safari probes first) finds it running. */
  graceMs?: number;
  spawn?: (args: string[]) => ListenEncoder;
}

/** Length of the fade out and in when a listener switches source. */
const FADE_MS = 20;
/** A client further behind than this is dropped (its browser reconnects). */
const MAX_CLIENT_BACKLOG = 512 * 1024;
/** Encoder input queued beyond this many seconds is dropped, not queued. */
const MAX_ENCODER_BACKLOG_SEC = 1;

interface Listener {
  id: string;
  src: ListenSource;
  /** Source to switch to once the fade-out reached silence. */
  next: ListenSource | null;
  gain: number; // 0..1, ramps during a switch
  enc: ListenEncoder;
  clients: Set<ListenClient>;
  /** Clients still waiting for the first MP3 frame header. */
  unsynced: Set<ListenClient>;
  idle: NodeJS.Timeout | null;
}

const defaultSpawn = (args: string[]): ListenEncoder => spawn('ffmpeg', args);

export class ListenHub {
  private listeners = new Map<string, Listener>();
  private readonly fadeStep: number;
  private readonly max: number;
  private readonly graceMs: number;
  private readonly spawn: (args: string[]) => ListenEncoder;
  private buf: Float32Array = new Float32Array(0);

  constructor(private opts: ListenHubOptions) {
    this.fadeStep = 1 / Math.max(1, Math.round((FADE_MS / 1000) * opts.sampleRate));
    this.max = opts.maxListeners ?? 4;
    this.graceMs = opts.graceMs ?? 3000;
    this.spawn = opts.spawn ?? defaultSpawn;
  }

  /** A source name from a request, or null when it names nothing. */
  parse(src: unknown): ListenSource | null {
    if (src === 'rec' || src === 'raw' || src === 'air') return src;
    if (typeof src === 'string' && src.startsWith('mic:')) {
      return this.opts.mics.includes(src.slice(4)) ? (src as ListenSource) : null;
    }
    return null;
  }

  /** Listeners right now. */
  get count(): number {
    return this.listeners.size;
  }

  /** Whether `room()` has anybody to feed. */
  get wantsRoom(): boolean {
    for (const l of this.listeners.values()) if (l.src !== 'air') return true;
    return false;
  }

  /** Whether `air()` has anybody to feed. */
  get wantsAir(): boolean {
    for (const l of this.listeners.values()) if (l.src === 'air') return true;
    return false;
  }

  /**
   * Attach an HTTP response to listener `id` (started on first use). A second
   * request with the same id joins the running stream. Returns 'ok', 'bad'
   * (id or source not valid) or 'full'.
   */
  attach(id: string, src: unknown, client: ListenClient): 'ok' | 'bad' | 'full' {
    const source = this.parse(src);
    if (!source || !/^[\w-]{4,64}$/.test(id)) return 'bad';
    let l = this.listeners.get(id);
    if (!l) {
      if (this.listeners.size >= this.max) return 'full';
      l = this.start(id, source);
    } else if (l.src !== source && l.next !== source) {
      this.select(id, source);
    }
    if (l.idle) {
      clearTimeout(l.idle);
      l.idle = null;
    }
    const lis = l;
    lis.clients.add(client);
    lis.unsynced.add(client);
    client.on('close', () => this.detach(lis, client));
    return 'ok';
  }

  /** Switch listener `id` to another source (fade out, switch, fade in). */
  select(id: string, src: unknown): boolean {
    const l = this.listeners.get(id);
    const source = this.parse(src);
    if (!l || !source) return false;
    if (source === l.src) {
      l.next = null; // fade back in
    } else {
      l.next = source;
    }
    return true;
  }

  /**
   * One block at the recording's point: the programme and the dry mics,
   * sample-aligned. `trimsDb` per mic, in the order of `opts.mics`.
   */
  room(
    outL: Float32Array,
    outR: Float32Array,
    dry: readonly Float32Array[],
    trimsDb: readonly number[],
    frames: number
  ): void {
    if (!this.listeners.size) return;
    const trims = trimsDb.map((db) => Math.pow(10, db / 20));
    for (const l of this.listeners.values()) {
      if (l.src === 'air') continue;
      const out = this.block(frames);
      const mic = l.src.startsWith('mic:') ? this.opts.mics.indexOf(l.src.slice(4)) : -1;
      for (let n = 0; n < frames; n++) {
        let a: number;
        let b: number;
        if (l.src === 'rec') {
          a = outL[n];
          b = outR[n];
        } else if (mic >= 0) {
          a = b = dry[mic] ? dry[mic][n] * trims[mic] : 0;
        } else {
          let s = 0;
          for (let i = 0; i < dry.length; i++) s += dry[i][n] * (trims[i] ?? 1);
          a = b = s;
        }
        const g = this.ramp(l);
        out[2 * n] = a * g;
        out[2 * n + 1] = b * g;
        if (l.gain === 0 && l.next) {
          l.src = l.next;
          l.next = null;
          // The rest of this block belongs to the new source; with `air` it
          // comes from the other feed.
          out.fill(0, 2 * (n + 1));
          break;
        }
      }
      this.feed(l, out, frames);
    }
  }

  /** One block of what leaves the box (interleaved f32 stereo). */
  air(buf: Buffer): void {
    if (!this.listeners.size) return;
    const frames = buf.length / 8;
    for (const l of this.listeners.values()) {
      if (l.src !== 'air') continue;
      const out = this.block(frames);
      for (let n = 0; n < frames; n++) {
        const g = this.ramp(l);
        out[2 * n] = buf.readFloatLE(8 * n) * g;
        out[2 * n + 1] = buf.readFloatLE(8 * n + 4) * g;
        if (l.gain === 0 && l.next) {
          l.src = l.next;
          l.next = null;
          out.fill(0, 2 * (n + 1));
          break;
        }
      }
      this.feed(l, out, frames);
    }
  }

  /** End every stream (shutdown). */
  stopAll(): void {
    for (const l of [...this.listeners.values()]) this.end(l);
  }

  // ----------------------------------------------------------------

  private start(id: string, src: ListenSource): Listener {
    const sr = String(this.opts.sampleRate);
    const kbps = this.opts.bitrateKbps ?? 192;
    const enc = this.spawn([
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
      '-c:a',
      'libmp3lame',
      '-b:a',
      `${kbps}k`,
      '-flush_packets',
      '1',
      '-f',
      'mp3',
      'pipe:1',
    ]);
    const l: Listener = {
      id,
      src,
      next: null,
      gain: 0, // fades in
      enc,
      clients: new Set(),
      unsynced: new Set(),
      idle: null,
    };
    enc.stdout.on('data', (chunk: Buffer) => this.deliver(l, chunk));
    enc.stdin.on('error', () => {}); // an encoder that died is handled on exit
    enc.on('exit', () => {
      if (this.listeners.get(id) !== l) return;
      this.opts.log.warn(`listen encoder for ${id} exited`);
      this.end(l);
    });
    this.listeners.set(id, l);
    this.opts.log.info(`listening: ${id} on ${src} (${this.listeners.size} now)`);
    return l;
  }

  /** Gain for the next sample: towards 0 while a switch is pending, else 1. */
  private ramp(l: Listener): number {
    if (l.next) l.gain = Math.max(0, l.gain - this.fadeStep);
    else if (l.gain < 1) l.gain = Math.min(1, l.gain + this.fadeStep);
    return l.gain;
  }

  private block(frames: number): Float32Array {
    if (this.buf.length < 2 * frames) this.buf = new Float32Array(2 * frames);
    return this.buf.subarray(0, 2 * frames);
  }

  private feed(l: Listener, out: Float32Array, frames: number): void {
    const limit = MAX_ENCODER_BACKLOG_SEC * this.opts.sampleRate * 8;
    if (l.enc.stdin.writableLength > limit) return; // encoder stalled: drop
    // A copy: the scratch block is reused for the next listener.
    l.enc.stdin.write(Buffer.from(new Float32Array(out.subarray(0, 2 * frames)).buffer));
  }

  private deliver(l: Listener, chunk: Buffer): void {
    for (const c of l.clients) {
      let data = chunk;
      if (l.unsynced.has(c)) {
        // Join at a frame header, so a browser's first bytes decode.
        const at = frameSync(chunk);
        if (at < 0) continue;
        data = chunk.subarray(at);
        l.unsynced.delete(c);
      }
      if (c.writableLength > MAX_CLIENT_BACKLOG) {
        c.destroy(); // too far behind; 'close' detaches it
        continue;
      }
      c.write(data);
    }
  }

  private detach(l: Listener, c: ListenClient): void {
    l.clients.delete(c);
    l.unsynced.delete(c);
    if (l.clients.size || l.idle || this.listeners.get(l.id) !== l) return;
    l.idle = setTimeout(() => this.end(l), this.graceMs);
    l.idle.unref?.();
  }

  private end(l: Listener): void {
    if (this.listeners.get(l.id) !== l) return;
    this.listeners.delete(l.id);
    if (l.idle) clearTimeout(l.idle);
    for (const c of l.clients) c.destroy();
    l.clients.clear();
    try {
      l.enc.stdin.end();
    } catch {
      /* already gone */
    }
    l.enc.kill();
    this.opts.log.info(`listening: ${l.id} ended (${this.listeners.size} left)`);
  }
}

/** Offset of the first MPEG audio frame header in `b` (11 sync bits, a
 *  valid layer and bitrate), or -1. */
export function frameSync(b: Buffer): number {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const layer = (b[i + 1] >> 1) & 3;
    const rate = b[i + 2] >> 4;
    const sr = (b[i + 2] >> 2) & 3;
    if (layer !== 0 && rate !== 0 && rate !== 15 && sr !== 3) return i;
  }
  return -1;
}

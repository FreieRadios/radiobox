import { Log } from '../util/log';

/** One queued file. `id` is server-assigned and stable for the item's whole
 *  life, so a remove/move sent from a page that has a slightly stale list can
 *  never hit the wrong row (indices would). */
export interface QueueItem {
  id: number;
  /** Index into the configured file-player folders. */
  folder: number;
  /** Folder-relative name, e.g. `Musik/x.flac` — same form as `playFile`. */
  name: string;
}

/** What a client asks to enqueue. */
export interface QueueRequest {
  folder: number;
  name: string;
}

/** Upper bound on pending items. Guards against an "add all" on a huge
 *  network share turning into an unbounded list (and an unbounded broadcast)
 *  on a small box; adds beyond it are dropped with a warning. */
export const MAX_QUEUE = 500;

/**
 * The pending play list: a plain ordered set of files, no audio knowledge.
 * Kept pure so it can be reasoned about (and tested) on its own; the glue to
 * the file player lives in `QueuePlayer` below.
 */
export class PlayQueue {
  private items: QueueItem[] = [];
  private seq = 0;

  /** A copy of the pending items, in play order. */
  list(): QueueItem[] {
    return this.items.slice();
  }

  get length(): number {
    return this.items.length;
  }

  /** Append items, up to `MAX_QUEUE` in total. Returns the ones accepted. */
  add(reqs: QueueRequest[]): QueueItem[] {
    const added: QueueItem[] = [];
    for (const req of reqs) {
      if (this.items.length >= MAX_QUEUE) break;
      if (!req || !req.name) continue;
      const item: QueueItem = { id: ++this.seq, folder: req.folder | 0, name: req.name };
      this.items.push(item);
      added.push(item);
    }
    return added;
  }

  /** Drop one item by id. */
  remove(id: number): boolean {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }

  /** Move one item by `delta` positions (-1 up, +1 down), clamped to the ends. */
  move(id: number, delta: number): boolean {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0 || !delta) return false;
    const to = Math.max(0, Math.min(this.items.length - 1, i + Math.trunc(delta)));
    if (to === i) return false;
    const [item] = this.items.splice(i, 1);
    this.items.splice(to, 0, item);
    return true;
  }

  clear(): void {
    this.items = [];
  }

  /** Remove and return the head. */
  shift(): QueueItem | null {
    return this.items.shift() ?? null;
  }

  /** Jump to an item: remove it *and everything queued before it*, and return
   *  it. Skipping ahead in a play list means the passed-over entries are gone,
   *  not silently played later. */
  take(id: number): QueueItem | null {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0) return null;
    const [item] = this.items.splice(0, i + 1).slice(i);
    return item ?? null;
  }
}

/** The slice of FilePlayer the queue needs (kept structural so tests can drive
 *  it with a stub instead of a real ffmpeg decode). */
export interface QueuePlayerTarget {
  readonly playing: string | null;
  play(file: string): void;
  fadeOut(ms: number): void;
  on(event: 'ended', listener: () => void): unknown;
}

export interface QueuePlayerDeps {
  player: QueuePlayerTarget;
  /** Traversal-safe folder+name -> absolute path (FileDirs.resolve). */
  resolve(folder: number, name: string): string | null;
  /** Called whenever the pending list changed, so the UI can be told. */
  onChange(): void;
  log: Log;
}

/**
 * Drives the file player from a `PlayQueue`.
 *
 * Deliberate behaviours, all of them on-air safety calls:
 *  - **Enqueuing never starts audio.** Like the recorder, playout is armed by
 *    the operator: a queued list waits for an explicit start (or for the file
 *    that is already playing to end). Building a list while the mics are live
 *    must not put music on air by itself.
 *  - **Auto-advance chains only from playback that ended by itself.** An
 *    operator stop (`stopFile`) ends playback, full stop — it does not roll
 *    into the next item — while the queue itself is kept, so the list can be
 *    picked up again.
 *  - **A scheduled auto-play preempts as before and the queue survives it.**
 *    Since the scheduled file ends like any other, the queue continues with
 *    its next item afterwards; the timestamp schedule stays the authority on
 *    what interrupts what.
 *  - **Vanished files are skipped, not fatal.** Files on a network share can
 *    disappear between queuing and playing.
 */
export class QueuePlayer {
  readonly queue = new PlayQueue();
  /** Set while an operator-requested stop is fading out, so the 'ended' it
   *  emits doesn't start the next queued item. */
  private suppressAdvance = false;

  constructor(private deps: QueuePlayerDeps) {
    deps.player.on('ended', () => {
      if (this.suppressAdvance) {
        this.suppressAdvance = false;
        return;
      }
      this.startNext();
    });
  }

  list(): QueueItem[] {
    return this.queue.list();
  }

  /** Start the head of the queue, skipping entries whose file has vanished.
   *  Returns true when something started playing. */
  startNext(): boolean {
    let started = false;
    let changed = false;
    while (!started) {
      const item = this.queue.shift();
      if (!item) break;
      changed = true;
      const file = this.deps.resolve(item.folder, item.name);
      if (!file) {
        this.deps.log.warn(`queue: skipping vanished file ${item.name}`);
        continue;
      }
      this.deps.log.info(`queue: playing ${item.name} (${this.queue.length} left)`);
      this.deps.player.play(file);
      started = true;
    }
    if (changed) this.deps.onChange();
    return started;
  }

  /** Operator stop: fade out the current file without advancing the queue. */
  stop(fadeMs: number): void {
    const wasPlaying = this.deps.player.playing !== null;
    this.deps.player.fadeOut(fadeMs);
    // fadeOut() only emits 'ended' when it really ramps; while idle (or still
    // prebuffering) it hard-stops silently. Arm the suppression only for the
    // case that will actually emit, so the flag can't linger and swallow the
    // *next* natural end of playback.
    this.suppressAdvance = wasPlaying && this.deps.player.playing !== null;
  }

  /**
   * Handle a `queue*` control message from the meters page. Returns true when
   * the message was a queue command (handled), false when it wasn't ours.
   */
  handleCommand(type: string, value: unknown): boolean {
    const req = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    if (type === 'queueAdd') {
      // Accepts one {folder,name} or a batch {items:[…]} (an "add all folder"
      // must not turn into one WebSocket message per file).
      const raw = Array.isArray(req.items) ? req.items : [req];
      const reqs: QueueRequest[] = [];
      for (const r of raw) {
        if (typeof r !== 'object' || r === null) continue;
        const name = String((r as { name?: unknown }).name ?? '');
        if (name) reqs.push({ folder: Number((r as { folder?: unknown }).folder ?? 0) || 0, name });
      }
      const added = this.queue.add(reqs);
      if (added.length < reqs.length) {
        this.deps.log.warn(`queue: full (${MAX_QUEUE}), dropped ${reqs.length - added.length}`);
      }
      if (added.length) this.deps.onChange();
      return true;
    }
    if (type === 'queueRemove') {
      if (this.queue.remove(Number(req.id))) this.deps.onChange();
      return true;
    }
    if (type === 'queueMove') {
      if (this.queue.move(Number(req.id), Number(req.delta) || 0)) this.deps.onChange();
      return true;
    }
    if (type === 'queueClear') {
      if (this.queue.length) {
        this.queue.clear();
        this.deps.onChange();
      }
      return true;
    }
    if (type === 'queuePlay') {
      const item = this.queue.take(Number(req.id));
      this.deps.onChange();
      if (!item) return true;
      const file = this.deps.resolve(item.folder, item.name);
      if (file) {
        this.deps.log.info(`queue: jumping to ${item.name}`);
        this.deps.player.play(file);
      } else {
        this.deps.log.warn(`queue: file vanished ${item.name}`);
        this.startNext();
      }
      return true;
    }
    if (type === 'queueStart') {
      this.startNext();
      return true;
    }
    return false;
  }
}

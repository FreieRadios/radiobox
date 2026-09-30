import { io } from 'socket.io-client';
import { ListenersConfig } from '../config/schema';
import { Log } from '../util/log';
import { EpisodeGuide, buildGuide, parseEpisodes, pickEpisode } from './episode';
import { EveError, EveSession, FetchLike } from './eve-session';
import { ScheduleRule, Slot, parseRules, slotAt } from './schedule-rules';

/**
 * Listener feedback from eve, for the show on air.
 *
 * Listeners send comments and hearts to a show on eve's public page; a
 * comment waits there until somebody who is not at the microphone releases
 * it. studiobox reads what was released and how many hearts came in, for the
 * show its own clock says is on air, from the start of that slot on — so the
 * screen starts empty at every broadcast. It signs in as a read-only device
 * and writes nothing to eve.
 *
 * Alongside, the episode on air and its conversation guide (opening and
 * closing, topics, must-ask questions — see `episode.ts`), for the host. It
 * is fetched when the show changes, when eve announces an edit, and every few
 * minutes; an eve without those exports costs the feedback nothing.
 *
 * eve announces changes over Socket.IO (`element:changed`,
 * `relation:changed`, notifications without data); each one triggers a
 * debounced refetch of the small exports. A slow poll covers a socket that is
 * down.
 */

export interface ListenerComment {
  id: string;
  text: string;
  receivedAtMs: number;
}

export interface ListenerShow {
  slug: string;
  name: string;
  /** The slot on air; null for a pinned show the plan has not on air now. */
  startMs: number | null;
  endMs: number | null;
}

export type ListenerState = 'connecting' | 'ok' | 'offline' | 'denied';

/** `none`: eve has no episode for the show on air. `unavailable`: eve could
 *  not say (the exports are missing, or it is away) — `episode` is then the
 *  last one it served for this broadcast, if any. */
export type GuideState = 'pending' | 'ok' | 'none' | 'unavailable';

/** What the operators' page gets (pushed on change, and on connect). */
export interface ListenerStatus {
  /** The show on air, or null when the plan has nothing now. */
  show: ListenerShow | null;
  /** The show was pinned in the config rather than read from the plan. */
  pinned: boolean;
  hearts: number;
  /** Released comments, newest first. */
  comments: ListenerComment[];
  /** The episode on air and its conversation guide. */
  episode: EpisodeGuide | null;
  guide: GuideState;
  /** `offline`/`denied`: what is shown is the last thing eve said (if any). */
  state: ListenerState;
  /** When eve last answered, ms. */
  updatedMs: number | null;
}

/** The part of a socket.io client this uses. */
export interface SocketLike {
  on(event: string, fn: (...args: never[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
  readonly active: boolean;
}

export type SocketFactory = (url: string, auth: (cb: (data: object) => void) => void) => SocketLike;

const defaultSocket: SocketFactory = (url, auth) =>
  io(url, { auth, reconnectionDelayMax: 30_000 }) as unknown as SocketLike;

export interface ListenerFeedOptions {
  cfg: ListenersConfig;
  /** Sendezeit: the clock the schedule is read on. */
  clock: () => number;
  onChange: (status: ListenerStatus) => void;
  log: Log;
  fetch?: FetchLike;
  /** null: no socket, poll only. */
  socket?: SocketFactory | null;
}

/** Collapse a burst of change events (a release is several writes). */
const DEBOUNCE_MS = 1_000;
/** How often the clock is compared with the plan. */
const SLOT_CHECK_MS = 5_000;
/** Schedule rules are refetched this often… */
const RULES_MAX_AGE_MS = 5 * 60_000;
/** …and after a change event, if older than this. */
const RULES_MIN_AGE_MS = 30_000;
/** The guide is refetched this often… */
const GUIDE_MAX_AGE_MS = 5 * 60_000;
/** …and after a change event that may concern it, if older than this (hearts
 *  arrive as edits too, and must not refetch the guide one by one). */
const GUIDE_MIN_AGE_MS = 10_000;
/** Back-off when eve refuses the socket handshake. */
const SOCKET_RETRY_MS = [5_000, 15_000, 60_000];

/** Pick this show's rows out of the two exports. */
export function selectFeedback(
  slug: string,
  comments: unknown,
  hearts: unknown
): { comments: ListenerComment[]; hearts: number } {
  const rows = (d: unknown): Record<string, unknown>[] => {
    const r = (d as { rows?: unknown } | null)?.rows;
    return Array.isArray(r) ? (r as Record<string, unknown>[]) : [];
  };
  const list = rows(comments)
    .filter((r) => r.slug === slug && typeof r.text === 'string')
    .map((r) => ({
      id: String(r.id ?? ''),
      text: String(r.text),
      receivedAtMs: Date.parse(String(r.receivedAt ?? '')),
    }))
    .map((c) => ({ ...c, receivedAtMs: Number.isFinite(c.receivedAtMs) ? c.receivedAtMs : 0 }))
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const h = rows(hearts).find((r) => r.slug === slug);
  const n = Number(h?.hearts ?? 0);
  return { comments: list, hearts: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 };
}

export class ListenerFeed {
  private readonly session: EveSession;
  private readonly base: string;
  private rules: ScheduleRule[] = [];
  private rulesAt = 0;
  private rulesStale = false;
  private slot: Slot | null = null;
  private state: ListenerStatus = {
    show: null,
    pinned: false,
    hearts: 0,
    comments: [],
    episode: null,
    guide: 'pending',
    state: 'connecting',
    updatedMs: null,
  };
  /** Which broadcast (`slug@start`) the guide was fetched for, and when. */
  private guideFor = '';
  private guideAt = 0;
  private guideStale = false;
  /** After eve answered the guide with an error: not before then. */
  private guideRetryAt = 0;
  private guideWarned = false;
  private lastSent = '';
  private socket: SocketLike | null = null;
  private socketRetry = 0;
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private opts: ListenerFeedOptions) {
    this.session = new EveSession({
      url: opts.cfg.url,
      username: opts.cfg.username,
      password: opts.cfg.password,
      fetch: opts.fetch,
    });
    this.base = `/exports/${encodeURIComponent(opts.cfg.app)}`;
    this.state.pinned = !!opts.cfg.show;
  }

  status(): ListenerStatus {
    return this.state;
  }

  start(): void {
    this.stopped = false;
    const { cfg, log } = this.opts;
    log.info(
      `listener feedback from ${this.session.url} (${cfg.app})` +
        (cfg.show ? `, show pinned to "${cfg.show}"` : ', show from the schedule')
    );
    void this.refresh();
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(SLOT_CHECK_MS, () => this.checkSlot());
    every(cfg.pollSeconds * 1000, () => this.request());
    const make = this.opts.socket === undefined ? defaultSocket : this.opts.socket;
    if (make) this.openSocket(make);
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.disconnect();
    this.socket = null;
  }

  /** Refetch soon, once, however many times this is called meanwhile. */
  request(): void {
    if (this.stopped || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.refresh();
    }, DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /** Fetch now (queued behind a fetch that is still running). */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.fetchAll()
      .catch((err: unknown) => this.failed(err))
      .finally(() => {
        this.running = null;
        if (this.again && !this.stopped) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.running;
  }

  private openSocket(make: SocketFactory): void {
    const { log } = this.opts;
    const socket = make(this.session.url, (cb) => {
      this.session.token().then(
        (token) => cb({ token }),
        () => cb({})
      );
    });
    this.socket = socket;
    socket.on('connect', () => {
      this.socketRetry = 0;
      log.info('eve: listening for changes');
      // Whatever happened while the socket was down was not announced.
      this.request();
    });
    socket.on('element:changed', ((n: { aspects?: unknown }) => {
      // New comments and hearts, releases and dismissals carry `status`; an
      // event without aspects might be anything. Schedule edits come as
      // other aspects, so those refresh the rules too.
      const aspects = Array.isArray(n?.aspects) ? (n.aspects as string[]) : null;
      if (!aspects || aspects.some((a) => a !== 'status')) {
        this.rulesStale = true;
        this.guideStale = true;
      }
      // An edit of the episode on air is shown at once.
      if (n && (n as { id?: unknown }).id === this.state.episode?.id) this.guideAt = 0;
      this.request();
    }) as never);
    // Links: a topic or question added to or moved in the episode, a new
    // episode for a show, a slot moved to another show.
    socket.on('relation:changed', ((n: { fromElementId?: unknown }) => {
      this.rulesStale = true;
      this.guideStale = true;
      if (n?.fromElementId === undefined || n.fromElementId === this.state.episode?.id) {
        this.guideAt = 0;
      }
      this.request();
    }) as never);
    socket.on('connect_error', ((err: Error) => {
      if (socket.active) return; // a network error: socket.io retries by itself
      // eve refused the handshake (token expired or revoked): renew the token
      // and knock again, slower each time.
      this.session.invalidate();
      const ms = SOCKET_RETRY_MS[Math.min(this.socketRetry++, SOCKET_RETRY_MS.length - 1)];
      log.warn(`eve socket refused (${err?.message ?? 'unknown'}); retrying in ${ms / 1000} s`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.stopped) socket.connect();
      }, ms);
      this.retryTimer.unref?.();
    }) as never);
  }

  /** The plan may have moved on to the next show: switch at once. */
  private checkSlot(): void {
    if (this.pickSlot()) void this.refresh();
  }

  /** Re-read the plan against the clock; true when the show changed. */
  private pickSlot(): boolean {
    const now = this.opts.clock();
    const pinned = this.opts.cfg.show;
    let slot = slotAt(this.rules, now);
    if (pinned && slot?.slug !== pinned) slot = null;
    const show: ListenerShow | null = slot
      ? { slug: slot.slug, name: slot.name, startMs: slot.startMs, endMs: slot.endMs }
      : pinned
        ? {
            slug: pinned,
            name: this.rules.find((r) => r.slug === pinned)?.name ?? pinned,
            startMs: null,
            endMs: null,
          }
        : null;
    this.slot = slot;
    const key = (s: ListenerShow | null) => (s ? `${s.slug}@${s.startMs}` : '');
    if (key(show) === key(this.state.show)) {
      // Same broadcast; the name may have been edited.
      if (show && this.state.show && show.name !== this.state.show.name) {
        this.update({ show });
      }
      return false;
    }
    // A new broadcast starts with an empty screen.
    this.update({ show, comments: [], hearts: 0, episode: null, guide: 'pending' });
    return true;
  }

  private async fetchAll(): Promise<void> {
    const t = Date.now();
    const age = t - this.rulesAt;
    if (age > RULES_MAX_AGE_MS || (this.rulesStale && age > RULES_MIN_AGE_MS)) {
      const doc = (await this.session.get(`${this.base}/schedule-rules`)) as { rows?: unknown };
      this.rules = parseRules(doc?.rows);
      this.rulesAt = t;
      this.rulesStale = false;
    }
    this.pickSlot();
    const show = this.state.show;
    if (!show) {
      this.update({ state: 'ok', updatedMs: Date.now() });
      return;
    }
    // From the start of the slot on air; a pinned show off the plan gets
    // eve's default window (yesterday and today).
    const since = this.slot
      ? `?since=${encodeURIComponent(new Date(this.slot.startMs).toISOString())}`
      : '';
    const [comments, hearts] = await Promise.all([
      this.session.get(`${this.base}/listener-comments${since}`),
      this.session.get(`${this.base}/listener-hearts${since}`),
      this.fetchGuide(show),
    ]);
    // The show may have changed while we waited; that answer is not for it.
    if (this.state.show?.slug !== show.slug || this.state.show.startMs !== show.startMs) return;
    this.update({
      ...selectFeedback(show.slug, comments, hearts),
      state: 'ok',
      updatedMs: Date.now(),
    });
  }

  /**
   * The episode of the broadcast on air, when it is due. Never throws: the
   * guide is an extra, and an eve without its exports (or one that fails on
   * them) must not turn the listener feedback into "unreachable".
   */
  private async fetchGuide(show: ListenerShow): Promise<void> {
    const key = `${show.slug}@${show.startMs}`;
    const age = Date.now() - this.guideAt;
    const due =
      key !== this.guideFor ||
      (Date.now() >= this.guideRetryAt &&
        (age > GUIDE_MAX_AGE_MS || (this.guideStale && age > GUIDE_MIN_AGE_MS)));
    if (!due) return;
    this.guideFor = key;
    this.guideAt = Date.now();
    this.guideStale = false;
    const current = () =>
      this.state.show?.slug === show.slug && this.state.show.startMs === show.startMs;
    try {
      const rows = parseEpisodes(await this.session.get(`${this.base}/episodes`));
      const slot = this.slot && this.slot.slug === show.slug ? this.slot : null;
      const ep = pickEpisode(rows, show.slug, slot, this.opts.clock());
      let guide: EpisodeGuide | null = null;
      if (ep) {
        const q = `?episode=${encodeURIComponent(ep.id)}`;
        const [topics, questions] = await Promise.all([
          this.session.get(`${this.base}/episode-topics${q}`),
          this.session.get(`${this.base}/episode-questions${q}`),
        ]);
        guide = buildGuide(ep, topics, questions);
      }
      this.guideWarned = false;
      this.guideRetryAt = 0;
      if (current()) this.update({ episode: guide, guide: guide ? 'ok' : 'none' });
    } catch (err) {
      // No answer: again with the next fetch. An answer (an eve without these
      // exports, or one refusing them): again in a few minutes.
      const answered = err instanceof EveError && err.status !== undefined;
      this.guideAt = answered ? Date.now() : 0;
      this.guideRetryAt = answered ? Date.now() + GUIDE_MAX_AGE_MS : 0;
      if (!this.guideWarned) {
        this.guideWarned = true;
        this.opts.log.warn(`eve: no episode guide (${(err as Error).message})`);
      }
      if (current()) this.update({ guide: 'unavailable' });
    }
  }

  private failed(err: unknown): void {
    const kind = err instanceof EveError ? err.kind : 'offline';
    if (kind !== this.state.state) {
      this.opts.log.warn(
        `eve ${kind === 'denied' ? 'refused access' : 'unreachable'}: ${(err as Error).message}`
      );
    }
    this.update({ state: kind });
  }

  private update(patch: Partial<ListenerStatus>): void {
    const prev = this.state.state;
    this.state = { ...this.state, ...patch };
    if (prev !== 'ok' && this.state.state === 'ok' && prev !== 'connecting') {
      this.opts.log.info('eve reachable again');
    }
    // Only a change the page can see is sent (updatedMs alone is not one).
    const { updatedMs: _t, ...visible } = this.state;
    const json = JSON.stringify(visible);
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.opts.onChange(this.state);
  }
}

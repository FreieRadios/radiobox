import { randomBytes } from 'node:crypto';
import { RolesConfig } from '../config/schema';

/**
 * Roles of the web views and what each may do.
 *
 * Sessions run on a venue's shared Wi-Fi, so hiding a button is not the
 * protection: the server keeps a command allowlist per role and drops
 * everything else. The role comes from a per-session token in the URL
 * (`/host?k=…`), handed out as a link or QR code — never from the route alone.
 * A connection without a (valid) token is a spectator: read-only.
 */
export type ViewRole = 'tech' | 'host' | 'guest' | 'spectator';

/** What the host may do: playout, the queue, the bed, the music level on air,
 *  and the mics as a whole. */
const HOST_COMMANDS = [
  'playFile',
  'stopFile',
  'queueAdd',
  'queueRemove',
  'queueMove',
  'queueClear',
  'queuePlay',
  'queueStart',
  'queueMode',
  'micsMuted',
  'bed',
  'bedSelect',
  'musicGain',
];

const ALLOW: Record<ViewRole, ReadonlySet<string> | 'all'> = {
  tech: 'all',
  host: new Set(HOST_COMMANDS),
  guest: new Set(),
  spectator: new Set(),
};

export interface RoleTokens {
  tech: string;
  host: string;
  guest: string;
  /** Only for `/stream` (a Pi at the desk): no view, no commands. */
  stream: string;
}

/** 96 random bits, URL-safe: short enough for a QR code, long enough that
 *  nobody on the same Wi-Fi guesses it. */
const newToken = (): string => randomBytes(12).toString('base64url');

/** One link to hand out: who it is for and where it leads. */
export interface RoleLink {
  role: ViewRole;
  /** What the link is for, in German (the label printed beside its QR code). */
  label: string;
  url: string;
  /** The mic a guest link opens with (`&mic=<label>`). */
  mic?: string;
}

const ROLE_LABEL: Record<ViewRole, string> = {
  tech: 'Technik',
  host: 'Host',
  guest: 'Gäste',
  spectator: 'Zuschauer',
};

export class Roles {
  readonly enabled: boolean;
  readonly tokens: RoleTokens;
  /** Every token comes from the config: the links survive a restart, so a
   *  printed QR code stays good. Otherwise they change at every start. */
  readonly pinned: boolean;
  /** The stream token comes from the config (the Pi's URL stays good). */
  readonly streamPinned: boolean;

  constructor(cfg: RolesConfig) {
    this.enabled = cfg.enabled;
    this.pinned = !!(cfg.tokens.tech && cfg.tokens.host && cfg.tokens.guest);
    this.streamPinned = !!cfg.tokens.stream;
    this.tokens = {
      tech: cfg.tokens.tech ?? newToken(),
      host: cfg.tokens.host ?? newToken(),
      guest: cfg.tokens.guest ?? newToken(),
      stream: cfg.tokens.stream ?? newToken(),
    };
  }

  /** Role of a connection from its request URL (`…?k=<token>`). With roles
   *  disabled every connection is the technician. */
  roleOf(url: string | undefined): ViewRole {
    if (!this.enabled) return 'tech';
    let k: string | null = null;
    try {
      k = new URL(url ?? '/', 'http://localhost').searchParams.get('k');
    } catch {
      /* malformed URL: no token */
    }
    if (!k) return 'spectator';
    for (const role of ['tech', 'host', 'guest'] as const) {
      if (safeEqual(k, this.tokens[role])) return role;
    }
    return 'spectator';
  }

  /** May this request pull the programme (`/stream`)? The stream token, or
   *  an operator's; never without one (it is the whole programme). With
   *  roles disabled everybody may, like everything else. */
  mayStream(url: string | undefined): boolean {
    if (!this.enabled) return true;
    const role = this.roleOf(url);
    if (role === 'tech' || role === 'host') return true;
    try {
      const k = new URL(url ?? '/', 'http://localhost').searchParams.get('k');
      return !!k && safeEqual(k, this.tokens.stream);
    } catch {
      return false;
    }
  }

  /** The stream URL for a box at the desk (Ogg/FLAC). */
  streamUrl(base: string): string {
    return `${base.replace(/\/+$/, '')}/stream?format=flac&k=${this.tokens.stream}`;
  }

  /** May a connection with this role send a command of this type? */
  allows(role: ViewRole, type: string): boolean {
    const a = ALLOW[role];
    return a === 'all' || a.has(type);
  }

  /** The links to hand out, one per role. */
  urls(base: string): Record<ViewRole, string> {
    const b = base.replace(/\/+$/, '');
    return {
      tech: `${b}/tech?k=${this.tokens.tech}`,
      host: `${b}/host?k=${this.tokens.host}`,
      guest: `${b}/guest?k=${this.tokens.guest}`,
      spectator: `${b}/`,
    };
  }

  /** The links for "Geräte verbinden" and the start log: one per role, and
   *  the guest link once more per mic, so a guest scans the code at their
   *  seat and lands on the guest view with their mic chosen. */
  links(base: string, mics: readonly string[] = []): RoleLink[] {
    const u = this.urls(base);
    const one = (role: ViewRole): RoleLink => ({ role, label: ROLE_LABEL[role], url: u[role] });
    return [
      one('tech'),
      one('host'),
      one('guest'),
      ...mics.map((mic) => ({
        role: 'guest' as const,
        label: `${ROLE_LABEL.guest}: ${mic}`,
        url: `${u.guest}&mic=${encodeURIComponent(mic)}`,
        mic,
      })),
      one('spectator'),
    ];
  }
}

/** Compare without leaking the matching prefix length through timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

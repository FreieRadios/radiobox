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

/** What the host may do: playout, the queue, the bed, and the mics as a whole. */
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
}

/** 96 random bits, URL-safe: short enough for a QR code, long enough that
 *  nobody on the same Wi-Fi guesses it. */
const newToken = (): string => randomBytes(12).toString('base64url');

export class Roles {
  readonly enabled: boolean;
  readonly tokens: RoleTokens;

  constructor(cfg: RolesConfig) {
    this.enabled = cfg.enabled;
    this.tokens = {
      tech: cfg.tokens.tech ?? newToken(),
      host: cfg.tokens.host ?? newToken(),
      guest: cfg.tokens.guest ?? newToken(),
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
}

/** Compare without leaking the matching prefix length through timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

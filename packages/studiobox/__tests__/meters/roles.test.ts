import { Roles } from '../../src/meters/roles';

const on = (tokens = {}) => new Roles({ enabled: true, tokens });

describe('Roles', () => {
  it('makes everybody the technician while roles are disabled', () => {
    const r = new Roles({ enabled: false, tokens: {} });
    expect(r.roleOf('/')).toBe('tech');
    expect(r.roleOf(undefined)).toBe('tech');
    expect(r.allows(r.roleOf('/'), 'recording')).toBe(true);
  });

  it('takes the role from the token, never from the route', () => {
    const r = on({ tech: 'T', host: 'H', guest: 'G' });
    expect(r.roleOf('/?k=T')).toBe('tech');
    expect(r.roleOf('/host?k=H')).toBe('host');
    expect(r.roleOf('/guest?k=G')).toBe('guest');
    expect(r.roleOf('/tech')).toBe('spectator'); // the route alone opens nothing
    expect(r.roleOf('/tech?k=G')).toBe('guest');
    expect(r.roleOf('/?k=nope')).toBe('spectator');
    expect(r.roleOf('/?k=')).toBe('spectator');
    expect(r.roleOf(undefined)).toBe('spectator');
  });

  it('lets a guest and a spectator send nothing at all', () => {
    const r = on();
    for (const role of ['guest', 'spectator'] as const) {
      for (const cmd of ['micsMuted', 'playFile', 'stopFile', 'recording', 'queueAdd', 'endShow']) {
        expect(r.allows(role, cmd)).toBe(false);
      }
    }
  });

  it('gives the host playout, the queue, the bed and the mics as a whole — not the rest', () => {
    const r = on();
    for (const cmd of [
      'playFile',
      'stopFile',
      'queueAdd',
      'queueStart',
      'queueMode',
      'micsMuted',
      'bed',
    ]) {
      expect(r.allows('host', cmd)).toBe(true);
    }
    for (const cmd of [
      'recording',
      'streaming',
      'monitor',
      'channelMuted',
      'trim',
      'setupStart',
      'endShow',
      'testTone',
    ]) {
      expect(r.allows('host', cmd)).toBe(false);
    }
  });

  it('gives the technician everything', () => {
    const r = on();
    for (const cmd of ['recording', 'trim', 'setupApply', 'endShow', 'anythingNew']) {
      expect(r.allows('tech', cmd)).toBe(true);
    }
  });

  it('generates distinct tokens per session unless they are configured', () => {
    const a = on();
    const b = on();
    expect(new Set([a.tokens.tech, a.tokens.host, a.tokens.guest]).size).toBe(3);
    expect(a.tokens.tech).not.toBe(b.tokens.tech);
    expect(a.tokens.tech.length).toBeGreaterThanOrEqual(16);
    expect(on({ host: 'fixed' }).tokens.host).toBe('fixed');
  });

  it('builds the links to hand out', () => {
    const r = on({ tech: 'T', host: 'H', guest: 'G' });
    expect(r.urls('http://10.0.0.5:4445/')).toEqual({
      tech: 'http://10.0.0.5:4445/tech?k=T',
      host: 'http://10.0.0.5:4445/host?k=H',
      guest: 'http://10.0.0.5:4445/guest?k=G',
      spectator: 'http://10.0.0.5:4445/',
    });
  });
});

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
      for (const cmd of [
        'micsMuted',
        'playFile',
        'stopFile',
        'recording',
        'queueAdd',
        'endShow',
        'musicGain',
      ]) {
        expect(r.allows(role, cmd)).toBe(false);
      }
    }
  });

  it('gives the host playout, the queue, the bed, the music level and the mics as a whole — not the rest', () => {
    const r = on();
    for (const cmd of [
      'playFile',
      'stopFile',
      'queueAdd',
      'queueStart',
      'queueMode',
      'micsMuted',
      'bed',
      'musicGain',
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
      'returnGain',
      'priorityDepth',
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

  it('adds a guest link per mic, with the mic chosen', () => {
    const r = on({ tech: 'T', host: 'H', guest: 'G' });
    const links = r.links('http://10.0.0.5:4445', ['Gast 1', 'A&B']);
    expect(links.map((l) => [l.role, l.label, l.url])).toEqual([
      ['tech', 'Technik', 'http://10.0.0.5:4445/tech?k=T'],
      ['host', 'Host', 'http://10.0.0.5:4445/host?k=H'],
      ['guest', 'Gäste', 'http://10.0.0.5:4445/guest?k=G'],
      ['guest', 'Gäste: Gast 1', 'http://10.0.0.5:4445/guest?k=G&mic=Gast%201'],
      ['guest', 'Gäste: A&B', 'http://10.0.0.5:4445/guest?k=G&mic=A%26B'],
      ['spectator', 'Zuschauer', 'http://10.0.0.5:4445/'],
    ]);
    // The guest view reads the mic back from exactly this parameter.
    expect(new URL(links[4].url).searchParams.getAll('mic')).toEqual(['A&B']);
  });

  it('knows whether the links survive a restart', () => {
    expect(on({ tech: 'T', host: 'H', guest: 'G' }).pinned).toBe(true);
    expect(on({ tech: 'T', host: 'H' }).pinned).toBe(false);
    expect(on().pinned).toBe(false);
  });
});

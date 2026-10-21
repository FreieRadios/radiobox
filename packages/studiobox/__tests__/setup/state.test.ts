import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionState, cleanName, loadState, saveState } from '../../src/setup/state';

const tmp = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-state-')), 'session-state.json');

const state = (savedAt: number): SessionState => ({
  savedAt,
  mics: {
    Host: {
      trimDb: 18,
      hpfHz: 100,
      gateThresholdDb: -42,
      compThresholdDb: -16,
      deessThresholdDb: -30,
      seedDb: -3.5,
      zoneCenterDb: -20,
    },
  },
  automixFloorDb: -55,
  priorityDepthDb: -6,
  returnGainDb: -12,
  musicGainDb: -3,
  queueMode: 'single',
});

describe('session state', () => {
  it('round-trips', () => {
    const f = tmp();
    const now = Date.now();
    expect(saveState(f, state(now))).toBe(true);
    expect(loadState(f, now)).toEqual(state(now));
    expect(fs.existsSync(`${f}.tmp`)).toBe(false); // written via rename
  });

  it('ignores a missing, broken or foreign file instead of failing the start', () => {
    const f = tmp();
    expect(loadState(f)).toBeNull();
    fs.writeFileSync(f, '{ not json');
    expect(loadState(f)).toBeNull();
    fs.writeFileSync(f, '[]');
    expect(loadState(f)).toEqual(null);
    fs.writeFileSync(f, '"x"');
    expect(loadState(f)).toBeNull();
  });

  it("ignores state older than the limit (last week's guests)", () => {
    const f = tmp();
    const now = Date.now();
    saveState(f, state(now - 13 * 3600 * 1000));
    expect(loadState(f, now)).toBeNull();
    expect(loadState(f, now, 24 * 3600 * 1000)).not.toBeNull();
  });

  it('drops a mic entry with a missing or non-finite number (no NaN into a filter)', () => {
    const f = tmp();
    const now = Date.now();
    const s = state(now) as unknown as { mics: Record<string, Record<string, unknown>> };
    s.mics.Bad = { ...s.mics.Host, hpfHz: null };
    s.mics.Worse = { trimDb: 3 };
    fs.writeFileSync(f, JSON.stringify(s));
    const loaded = loadState(f, now)!;
    expect(Object.keys(loaded.mics)).toEqual(['Host']);
  });

  it('reports a failed save', () => {
    // The parent "directory" is a regular file.
    const f = tmp();
    fs.writeFileSync(f, 'x');
    expect(saveState(path.join(f, 'session-state.json'), state(Date.now()))).toBe(false);
  });

  it('keeps live names, colours and heard mics, and drops what is malformed', () => {
    const file = tmp();
    fs.writeFileSync(
      file,
      JSON.stringify({
        savedAt: 1000,
        mics: {},
        names: { 'Mikro 5': 'Lea', 'Mikro 6': 42, Host: '   ' },
        colors: { 'Mikro 5': '#1e88e5', Host: 'url(x)' },
        heard: ['Mikro 5'],
      })
    );
    expect(loadState(file, 2000)).toEqual({
      savedAt: 1000,
      mics: {},
      names: { 'Mikro 5': 'Lea' },
      colors: { 'Mikro 5': '#1e88e5' },
      heard: ['Mikro 5'],
    });
  });

  it('cleans a name to one short line', () => {
    expect(cleanName('  Lea \n  Maria ')).toBe('Lea Maria');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
    expect(cleanName(undefined)).toBe('');
  });
});

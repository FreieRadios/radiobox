import { SetupMic, SetupSession } from '../../src/setup/session';
import { SR, bypass, concat, scale, silence } from '../../test-support/config';
import { mix, noise, voice } from '../../test-support/voice';

const FRAMES = 1024;
const LABELS = ['Gast 1', 'Gast 2', 'Host', 'Technik'];
const mics = (): SetupMic[] =>
  LABELS.map((label, i) => ({ label, source: i, processing: bypass() }));

/** Feed per-channel signals block by block; stops early once `until` holds. */
function feed(s: SetupSession, channels: Float32Array[], until?: () => boolean): void {
  const n = Math.min(...channels.map((c) => c.length));
  for (let o = 0; o + FRAMES <= n; o += FRAMES) {
    s.feed(
      channels.map((c) => c.subarray(o, o + FRAMES)),
      FRAMES
    );
    if (until?.()) return;
  }
}

const floor = (seconds: number, seed: number) => noise(-90, seconds, seed);
const room = (seconds: number) => LABELS.map((_, i) => floor(seconds, 20 + i));

/** `talker` speaks at `level`; the others pick the voice up `bleed` dB lower. */
function talk(talker: number, level: number, bleed = -22, seconds = 9, f0 = 120): Float32Array[] {
  const v = voice({ rmsDb: level, f0, seconds, sibilants: true, seed: talker + 1 });
  return LABELS.map((_, i) =>
    mix(i === talker ? v : scale(v, bleed), floor(seconds, 40 + i + 10 * talker))
  );
}

describe('SetupSession', () => {
  it('is idle until started and ignores audio meanwhile', () => {
    const s = new SetupSession(SR);
    feed(s, room(1));
    expect(s.status()).toMatchObject({ phase: 'idle', current: null, mics: [], results: null });
    expect(s.active).toBe(false);
  });

  it('runs silence -> each speaker -> result, prompting the next unfinished mic', () => {
    const s = new SetupSession(SR);
    s.start(mics());
    expect(s.status().phase).toBe('silence');
    feed(s, room(2.5));
    expect(s.status().silence).toBeCloseTo(0.5, 1);
    feed(s, room(2.6));
    expect(s.status()).toMatchObject({ phase: 'speakers', current: 'Gast 1', silence: 1 });

    const levels = [-30, -34, -42, -38];
    for (let t = 0; t < 4; t++) {
      expect(s.status().current).toBe(LABELS[t]);
      feed(s, talk(t, levels[t]), () => s.status().current !== LABELS[t]);
      if (t < 3) expect(s.status().mics[t]).toMatchObject({ progress: 1, done: true });
    }
    const st = s.status();
    expect(st.phase).toBe('result');
    expect(st.results!.map((r) => r.label)).toEqual(LABELS);
    st.results!.forEach((r, i) => {
      expect(r.channel).toBe(i + 1);
      expect(r.speechDb!).toBeCloseTo(levels[i], 0);
      expect(r.noiseDb).toBeCloseTo(-90, 0);
      expect(r.after!.trimDb).toBeCloseTo(-20 - levels[i], 0);
      // The loudest neighbour, 22 dB down on this mic, against the own voice.
      const others = levels.filter((_, j) => j !== i);
      expect(r.bleedDb!).toBeCloseTo(Math.max(...others) - 22 - levels[i], 0);
    });
    expect(typeof st.automixFloorDb).toBe('number');
    expect(s.active).toBe(false);
  });

  it('detects the talking mic by itself: the order does not matter', () => {
    const s = new SetupSession(SR);
    s.start(mics());
    feed(s, room(5.1));
    // Prompted: Gast 1. The host starts talking instead.
    feed(s, talk(2, -40, -22, 4));
    const st = s.status();
    expect(st.current).toBe('Gast 1'); // still waiting for Gast 1 ...
    expect(st.mics[0].progress).toBe(0); // ... who got none of it
    expect(st.mics[2].progress).toBeGreaterThan(0.3); // the host's mic did
  });

  it('measures how loud each voice arrives on the other mics', () => {
    const s = new SetupSession(SR, { speechSec: 2 });
    s.start(mics());
    feed(s, room(5.1));
    for (let t = 0; t < 4; t++) {
      // The host (2) is heard especially well on the technician's mic (3).
      const sig = talk(t, -30, -25, 4);
      if (t === 2)
        sig[3] = mix(
          scale(voice({ rmsDb: -30, seconds: 4, sibilants: true, seed: 3 }), -12),
          floor(4, 99)
        );
      feed(s, sig, () => s.status().current !== LABELS[t]);
    }
    const tech = s.status().results![3];
    expect(tech.bleedFrom).toBe('Host');
    expect(tech.bleedDb!).toBeCloseTo(-12, 0);
  });

  it('lets the prompted mic settle a frame two mics hear equally', () => {
    const s = new SetupSession(SR, { speechSec: 2 });
    s.start(mics());
    feed(s, room(5.1));
    // Gast 1 is prompted; its voice arrives just as loud on Gast 2's mic.
    const sig = talk(0, -30, -30, 4);
    sig[1] = mix(voice({ rmsDb: -30, seconds: 4, sibilants: true, seed: 1 }), floor(4, 98));
    feed(s, sig, () => s.status().current !== 'Gast 1');
    const st = s.status();
    expect(st.mics[0].done).toBe(true);
    expect(st.mics[1].progress).toBe(0);
  });

  it('is not fooled by a cough during the silence', () => {
    const s = new SetupSession(SR, { speechSec: 2 });
    s.start(mics());
    const r = room(5.1);
    const cough = scale(voice({ rmsDb: -25, seconds: 0.3 }), 0);
    r[0] = mix(r[0], concat(silence(2), cough));
    feed(s, r);
    feed(s, talk(0, -30, -22, 4), () => s.status().current !== 'Gast 1');
    s.finish();
    expect(s.status().results![0].noiseDb).toBeCloseTo(-90, 0);
  });

  it('finish() computes with what it has; mics without speech read "kein Signal"', () => {
    const s = new SetupSession(SR, { speechSec: 2 });
    s.start(mics());
    feed(s, room(5.1));
    feed(s, talk(0, -30, -22, 4), () => s.status().current !== 'Gast 1');
    s.finish();
    const res = s.status().results!;
    expect(res[0].verdict).not.toBe('kein Signal');
    expect(res.slice(1).map((r) => r.verdict)).toEqual([
      'kein Signal',
      'kein Signal',
      'kein Signal',
    ]);
  });

  it('re-measures one mic and keeps the other results', () => {
    const s = new SetupSession(SR, { speechSec: 2, silenceSec: 2 });
    s.start(mics());
    feed(s, room(2.1));
    for (let t = 0; t < 4; t++)
      feed(s, talk(t, t === 2 ? -62 : -32, -22, 4), () => s.status().current !== LABELS[t]);
    const first = s.status().results!;
    expect(first[2].verdict).toBe('zu leise');

    // The technician turns the host's gain up by 30 dB and measures again.
    s.start(mics(), ['Host']);
    expect(s.status()).toMatchObject({ phase: 'silence', mics: [{ label: 'Host', progress: 0 }] });
    feed(s, room(2.1));
    expect(s.status().current).toBe('Host');
    feed(s, talk(2, -32, -22, 4), () => s.status().phase === 'result');
    const second = s.status().results!;
    expect(second.map((r) => r.label)).toEqual(LABELS);
    expect(second[2].verdict).toBe('gut');
    expect(second[2].speechDb!).toBeCloseTo(-32, 0);
    expect(second[0]).toBe(first[0]); // untouched
  });

  it('cancel() drops a run and its results', () => {
    const s = new SetupSession(SR);
    s.start(mics());
    feed(s, room(1));
    s.cancel();
    expect(s.status().phase).toBe('idle');
    expect(s.getResults()).toBeNull();
  });
});

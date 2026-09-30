/**
 * The guest and spectator views are static files (`src/meters/public/`); what
 * they decide — which word, which zone, how far back to look — lives in
 * `meter.js` as pure functions of a snapshot, so it is tested here without a
 * browser. The HTML files only bind the results to the DOM.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SB = require('../../src/meters/public/meter.js');

const mic = (over: Record<string, unknown> = {}) => ({
  label: 'Gast 1',
  role: 'mic',
  muted: false,
  active: true,
  speechDb: -20,
  zone: 'ok',
  priorityDb: 0,
  ...over,
});
const snap = (over: Record<string, unknown> = {}) => ({
  channels: [mic()],
  micsMuted: false,
  filePlaying: null,
  filePosition: null,
  fileDuration: null,
  serverNowMs: 1_000_000,
  onAir: true,
  ...over,
});

describe('guest view — the mic state as a word', () => {
  it('OFFEN, and says whether that is on air yet', () => {
    expect(SB.guestMic(mic(), snap())).toMatchObject({
      state: 'OFFEN',
      sub: 'Dein Mikro ist auf Sendung',
      live: true,
    });
    expect(SB.guestMic(mic(), snap({ onAir: false })).sub).toBe('Dein Mikro ist offen');
  });

  it('LEISER while host priority holds the mic back', () => {
    expect(SB.guestMic(mic({ priorityDb: -6 }), snap())).toMatchObject({
      state: 'LEISER',
      sub: 'Moderation spricht – du bist leiser',
      live: true,
    });
    // A fraction of a dB on the way in or out is not worth a word.
    expect(SB.guestMic(mic({ priorityDb: -0.4 }), snap()).state).toBe('OFFEN');
  });

  it('PAUSE when the host closed all mics, STUMM when the technician muted this one', () => {
    expect(SB.guestMic(mic(), snap({ micsMuted: true, filePlaying: 'a.mp3' }))).toMatchObject({
      state: 'PAUSE',
      sub: 'Pause – gerade läuft nur Musik',
      live: false,
    });
    expect(SB.guestMic(mic(), snap({ micsMuted: true })).sub).toBe('Pause – die Mikros sind zu');
    // Muted by the technician wins: opening the mics will not bring it back.
    expect(SB.guestMic(mic({ muted: true }), snap({ micsMuted: true }))).toMatchObject({
      state: 'STUMM',
      sub: 'Die Technik hat dein Mikro stumm geschaltet',
    });
  });

  it('has an answer for a mic the box does not have', () => {
    expect(SB.guestMic(undefined, snap())).toMatchObject({ state: '—', zone: 'none', fill: 0 });
  });
});

describe('guest view — mouth distance in three words, never a dB value', () => {
  it('names the zone and what to do about it', () => {
    expect(SB.guestMic(mic({ zone: 'low' }), snap())).toMatchObject({
      zone: 'low',
      word: 'Näher ran',
    });
    expect(SB.guestMic(mic({ zone: 'ok' }), snap())).toMatchObject({ zone: 'ok', word: 'Passt' });
    expect(SB.guestMic(mic({ zone: 'high' }), snap())).toMatchObject({
      zone: 'high',
      word: 'Etwas weiter weg',
    });
    const all = ['low', 'ok', 'high'].map((zone) => SB.guestMic(mic({ zone }), snap()));
    for (const m of all) expect(m.word + m.hint + m.sub).not.toMatch(/dB/);
  });

  it('says the reading is rough until the mics have been measured', () => {
    const m = SB.guestMic(mic({ zone: 'low' }), snap({ setupApplied: false }));
    expect(m.word).toBe('Näher ran');
    expect(m.hint).toBe('Noch nicht eingemessen –\ndie Anzeige ist nur grob.');
    expect(SB.guestMic(mic({ zone: 'low' }), snap({ setupApplied: true })).hint).toContain('näher');
  });

  it('goes to "—" when the guest is not talking, not to "näher ran"', () => {
    expect(SB.guestMic(mic({ speechDb: null, zone: null }), snap())).toMatchObject({
      zone: 'none',
      word: '—',
      hint: 'Sprich einfach los.',
      fill: 0,
    });
  });

  it('shows no level on a mic that is not on air', () => {
    const m = SB.guestMic(mic({ zone: 'high' }), snap({ micsMuted: true }));
    expect(m).toMatchObject({ zone: 'none', word: '—', fill: 0 });
    expect(m.hint).toBe('Dein Mikro ist gerade nicht auf Sendung.');
  });

  it('places the speech level against the drawn target band when the box reports the zone', () => {
    const at = (speechDb: number, zone: string) =>
      SB.zoneFill(mic({ speechDb, zone, zoneCenterDb: -20, zoneWidthDb: 6 }));
    const top = SB.BAND.bottom + SB.BAND.height;
    expect(at(-20, 'ok')).toBe(64); // centre of the band
    expect(at(-26, 'ok')).toBe(SB.BAND.bottom); // the zone's edges are the band's edges
    expect(at(-14, 'ok')).toBe(top);
    expect(at(-32, 'low')).toBeLessThan(SB.BAND.bottom);
    expect(at(-8, 'high')).toBeGreaterThan(top);
    expect(at(40, 'high')).toBe(100);
    expect(at(-90, 'low')).toBe(4); // never an empty bar while somebody talks
  });

  it('falls back to three fixed heights without the zone band', () => {
    expect(SB.zoneFill(mic({ zone: 'low' }))).toBe(26);
    expect(SB.zoneFill(mic({ zone: 'ok' }))).toBe(64);
    expect(SB.zoneFill(mic({ zone: 'high' }))).toBe(90);
  });
});

describe('guest view — music and setup', () => {
  it('counts down the running file, and promises the talk only while the mics are closed', () => {
    expect(SB.guestMusic(snap())).toBeNull();
    const playing = { filePlaying: 'a.mp3', filePosition: 26, fileDuration: 180 };
    expect(SB.guestMusic(snap({ ...playing, micsMuted: true }))).toEqual({
      label: 'Musik – noch',
      time: '2:34',
      after: 'dann geht’s weiter',
    });
    expect(SB.guestMusic(snap(playing)).after).toBe('');
    expect(SB.guestMusic(snap({ filePlaying: 'a.mp3', filePosition: 5 }))).toEqual({
      label: 'Musik läuft',
      time: '',
      after: '',
    });
  });

  const setup = (over: Record<string, unknown>) =>
    snap({
      setup: {
        phase: 'speakers',
        current: 'Gast 1',
        sentence: 'Sechs fleißige Gäste.',
        silence: 1,
        mics: [
          { label: 'Gast 1', channel: 1, progress: 0.4, done: false },
          { label: 'Host', channel: 3, progress: 0, done: false },
        ],
        ...over,
      },
    });

  it('stays out of the way while the assistant is not running', () => {
    expect(SB.guestSetup(snap(), ['Gast 1'])).toBeNull();
    expect(SB.guestSetup(setup({ phase: 'idle' }), ['Gast 1'])).toBeNull();
    expect(SB.guestSetup(setup({ phase: 'result' }), ['Gast 1'])).toBeNull();
  });

  it('asks for silence, then tells the guest it is their turn with the sentence to read', () => {
    expect(SB.guestSetup(setup({ phase: 'silence', silence: 0.5 }), ['Gast 1'])).toMatchObject({
      kind: 'silence',
      text: 'Bitte kurz still sein',
      progress: 0.5,
    });
    expect(SB.guestSetup(setup({}), ['Gast 1'])).toEqual({
      kind: 'you',
      title: 'Jetzt du: Gast 1',
      text: 'Bitte diesen Satz vorlesen:',
      sentence: 'Sechs fleißige Gäste.',
      progress: 0.4,
    });
  });

  it('says who is up while it is somebody else, and thanks the guest once done', () => {
    expect(SB.guestSetup(setup({ current: 'Host' }), ['Gast 1'])).toMatchObject({
      kind: 'wait',
      text: 'Jetzt: Host – du bist gleich dran',
    });
    const done = setup({
      current: 'Host',
      mics: [
        { label: 'Gast 1', channel: 1, progress: 1, done: true },
        { label: 'Host', channel: 3, progress: 0.2, done: false },
      ],
    });
    expect(SB.guestSetup(done, ['Gast 1'])).toMatchObject({
      kind: 'thanks',
      title: 'Danke!',
      text: 'Jetzt: Host',
    });
  });

  it('with two mics at one tablet, either of them being up is "you"', () => {
    expect(SB.guestSetup(setup({ current: 'Host' }), ['Gast 1', 'Host'])).toMatchObject({
      kind: 'you',
      title: 'Jetzt du: Host',
    });
  });
});

describe('clocks', () => {
  it('is Sendezeit where there is an air delay, the plain clock otherwise', () => {
    const s = snap({ air: { nowMs: 1_010_000, targetMs: 10000, delayMs: 10000, state: 'live' } });
    // The browser's clock runs 250 ms behind the server's.
    expect(SB.clockOf(s, 250, 2_000_000)).toEqual({ ms: 2_010_250, label: 'Sendezeit' });
    expect(SB.clockOf(snap(), 250, 2_000_000)).toEqual({ ms: 2_000_250, label: 'Uhrzeit' });
  });
});

describe('spectator view — what listeners hear now', () => {
  const air = { nowMs: 0, targetMs: 10000, delayMs: 10000, state: 'live' };
  const at = (t: number, over: Record<string, unknown>) => ({
    s: { air, lookaheadMs: 3000, onAir: true, shortTermLufs: -16, outPeakDb: -6, ...over },
    t,
  });

  it('shows the title the room started one air delay ago', () => {
    const hist = new SB.History();
    const frames = [
      at(0, { filePlaying: 'jingle.mp3' }),
      at(5000, { filePlaying: 'musik.flac' }),
      at(12000, { filePlaying: 'musik.flac' }),
    ];
    for (const f of frames) hist.push(f.t, f.s);
    // The room is on the music since 5 s; listeners still hear the jingle.
    expect(SB.spectator(hist, frames[2].s, 12000).title).toBe('jingle.mp3');
    hist.push(15000, frames[2].s);
    expect(SB.spectator(hist, frames[2].s, 15000).title).toBe('musik.flac');
  });

  it('looks back less far for the level — the master meters already sit behind the room', () => {
    const hist = new SB.History();
    hist.push(0, at(0, { outPeakDb: -30 }).s);
    hist.push(4000, at(4000, { outPeakDb: -6 }).s);
    const now = at(10000, { outPeakDb: -12 }).s;
    hist.push(10000, now);
    // 10 s of delay minus 3 s of look-ahead: the frame from 7 s ago -> the one at 4 s.
    expect(SB.spectator(hist, now, 11000).peakDb).toBe(-6);
  });

  it('shows no loudness for digital silence', () => {
    const quiet = at(0, { shortTermLufs: -159.2 }).s;
    const hist = new SB.History();
    hist.push(0, quiet);
    expect(SB.spectator(hist, quiet, 0).lufs).toBeNull();
    expect(SB.fmt(SB.spectator(hist, quiet, 0).lufs, 0)).toBe('–');
  });

  it('says on air from the newest frame, and nothing at all on a playout box', () => {
    const hist = new SB.History();
    const live = at(0, {}).s;
    hist.push(0, live);
    expect(SB.spectator(hist, live, 0).onAir).toBe(true);
    const playout = { filePlaying: 'a.mp3', shortTermLufs: null, outPeakDb: null, onAir: null };
    expect(SB.spectator(new SB.History(), playout, 0)).toMatchObject({
      onAir: null,
      title: 'a.mp3',
    });
  });

  it('forgets what is older than it could ever need', () => {
    const hist = new SB.History(1000);
    for (let t = 0; t <= 5000; t += 100) hist.push(t, { t });
    expect(hist.items.length).toBeLessThanOrEqual(12);
    expect(hist.at(0).t).toBe(hist.items[0].s.t); // older than the history: the oldest it has
  });
});

describe('formatting', () => {
  it('writes numbers the German way and times as M:SS', () => {
    expect(SB.fmt(-16.34)).toBe('−16,3');
    expect(SB.fmt(-0.01)).toBe('0,0');
    expect(SB.fmt(null)).toBe('–');
    expect(SB.mmss(154)).toBe('2:34');
    expect(SB.mmss(-3)).toBe('0:00');
  });

  it('cuts a long title in its middle', () => {
    const n = SB.midName('04_Musik_Titel_Extended_Club_Mix_2026_Remaster_final_v3.mp3');
    expect(n.startsWith('04_Musik_Titel')).toBe(true);
    expect(n.endsWith('final_v3.mp3')).toBe(true);
    expect(n).toContain('…');
    expect(SB.midName('kurz.mp3')).toBe('kurz.mp3');
  });
});

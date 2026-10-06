import {
  MicCapture,
  REFERENCE_DB,
  analyseMic,
  automixFloorDb,
  fundamentalHz,
  peakDb,
  rmsDb,
  sibilanceDb,
} from '../../src/setup/measure';
import { ChannelStrip } from '../../src/dsp/channel-strip';
import { ChannelProcessing } from '../../src/config/schema';
import { SR, bypass, scale } from '../../test-support/config';
import { mix, noise, speechOnly, voice } from '../../test-support/voice';

/** The dynamic-broadcast profile, as the strips run it. */
const profile = (): ChannelProcessing =>
  bypass({
    hpfHz: 70,
    gate: {
      enabled: true,
      thresholdDb: -52,
      rangeDb: -15,
      attackMs: 3,
      holdMs: 150,
      releaseMs: 180,
    },
    deesser: { enabled: true, freq: 6500, thresholdDb: -26, ratio: 4 },
    compressor: {
      enabled: true,
      thresholdDb: -22,
      ratio: 3,
      kneeDb: 6,
      attackMs: 8,
      releaseMs: 140,
      makeupDb: 4,
    },
    leveler: { enabled: true, targetLufs: -23, maxGainDb: 18, rangeDb: 15, responseMs: 1500 },
  });

function capture(over: Partial<MicCapture> & { speechDb?: number; noiseDb?: number; f0?: number }) {
  const noiseDb = over.noiseDb ?? -85;
  const v = voice({ rmsDb: over.speechDb ?? -35, f0: over.f0 ?? 120, seconds: 4, sibilants: true });
  const c: MicCapture = {
    label: 'Host',
    channel: 3,
    noise: noise(noiseDb, 2),
    speech: speechOnly(mix(v, noise(noiseDb, 4, 11))),
    bleed: new Float32Array(0),
    bleedFrom: null,
    processing: profile(),
    ...over,
  };
  return c;
}

describe('setup measurement: levels', () => {
  it('measures noise, speech and their distance', () => {
    const r = analyseMic(capture({ speechDb: -35, noiseDb: -85 }), SR);
    expect(r.noiseDb).toBeCloseTo(-85, 0);
    expect(r.speechDb!).toBeCloseTo(-35, 0);
    expect(r.snrDb!).toBeCloseTo(50, 0);
    expect(r.verdict).toBe('gut');
    expect(r.advice).toBeNull();
    expect(r.gainChangeDb).toBe(0);
  });

  it('trims the speech to the reference level', () => {
    for (const level of [-45, -35, -25]) {
      const r = analyseMic(capture({ speechDb: level, noiseDb: level - 50 }), SR);
      expect(r.after!.trimDb).toBeCloseTo(REFERENCE_DB - level, 0);
      expect(r.after!.zoneCenterDb).toBeCloseTo(REFERENCE_DB, 0);
      expect(r.processing!.trimDb).toBe(r.after!.trimDb);
    }
  });

  it('puts the gate between the noise and the quiet end of the speech', () => {
    const r = analyseMic(capture({ speechDb: -35, noiseDb: -85 }), SR);
    const t = r.after!.gateThresholdDb;
    // After the +15 dB trim the noise sits at -70 dBFS RMS, speech at -20.
    expect(t).toBeGreaterThan(-70 + 6);
    expect(t).toBeLessThanOrEqual(-35);
  });

  it('keeps the gate above a loud neighbour and says so when it cannot', () => {
    const near = voice({ rmsDb: -35, f0: 200, seconds: 4, seed: 5 });
    const quiet = analyseMic(
      capture({ bleed: speechOnly(scale(near, -30)), bleedFrom: 'Gast 1' }),
      SR
    );
    const loud = analyseMic(
      capture({ bleed: speechOnly(scale(near, -8)), bleedFrom: 'Gast 1' }),
      SR
    );
    expect(quiet.bleedDb!).toBeCloseTo(-30, 0);
    expect(quiet.bleedFrom).toBe('Gast 1');
    expect(quiet.notes).toEqual([]);
    // Bleed 30 dB under the own voice: -50 dBFS RMS after the trim.
    expect(quiet.after!.gateThresholdDb).toBeGreaterThan(-50);
    expect(loud.after!.gateThresholdDb).toBeCloseTo(-35, 0); // never chops the own voice
    expect(loud.notes.join(' ')).toMatch(/Übersprechen: Gast 1/);
  });

  it('sets the compressor relative to the trimmed speech level', () => {
    const r = analyseMic(capture({ speechDb: -41 }), SR);
    expect(r.after!.compThresholdDb).toBeCloseTo(REFERENCE_DB + 4, 0);
    expect(r.before.compThresholdDb).toBe(-22);
  });
});

describe('setup measurement: gain advice (the knob studiobox cannot turn)', () => {
  it('asks for about +30 dB when the voice is 30 dB too quiet', () => {
    // A voice whose peaks sit right at the -12 dBFS the knob should give ...
    const v = speechOnly(voice({ rmsDb: -20, seconds: 4 }));
    const good = scale(v, -12 - peakDb(v));
    expect(analyseMic(capture({ speech: good, noise: noise(-80, 5) }), SR).advice).toBeNull();
    // ... and the same voice 30 dB down.
    const r = analyseMic(capture({ speech: scale(good, -30), noise: noise(-110, 5) }), SR);
    expect(r.verdict).toBe('zu leise');
    expect(r.gainChangeDb).toBe(30);
    expect(r.advice).toBe('Kanal 3 (Host): Gain um etwa +30 dB aufdrehen.');
  });

  it('asks to turn down when anything clipped', () => {
    const v = speechOnly(voice({ rmsDb: -12, seconds: 4 }));
    for (let i = 0; i < v.length; i++) v[i] = Math.max(-1, Math.min(1, v[i] * 2));
    const r = analyseMic(capture({ speech: v }), SR);
    expect(r.verdict).toBe('übersteuert');
    expect(r.gainChangeDb).toBeLessThan(0);
    expect(r.advice).toMatch(/^Kanal 3 \(Host\): Gain um etwa \d+ dB zurückdrehen\.$/);
  });

  it('asks for gain when the noise is close and the peaks have room', () => {
    const r = analyseMic(capture({ speechDb: -40, noiseDb: -72 }), SR);
    expect(r.snrDb!).toBeLessThan(40);
    expect(r.verdict).toBe('zu leise');
    expect(r.advice).toMatch(/aufdrehen/);
  });

  it('blames the room, not the knob, when the level is fine but noisy', () => {
    const v = speechOnly(voice({ rmsDb: -20, seconds: 4 }));
    const good = scale(v, -12 - peakDb(v)); // no room left on the knob
    const r = analyseMic(capture({ speech: good, noise: noise(rmsDb(good) - 30, 5) }), SR);
    expect(r.verdict).toBe('rauscht');
    expect(r.gainChangeDb).toBe(0);
    expect(r.advice).toMatch(/Rauschen/);
  });

  it('reports a mic nobody spoke into and sets nothing', () => {
    const r = analyseMic(capture({ speech: new Float32Array(1000) }), SR);
    expect(r.verdict).toBe('kein Signal');
    expect(r.after).toBeNull();
    expect(r.processing).toBeNull();
    expect(r.advice).toMatch(/kein Sprachsignal/);
  });

  it('notes a trim at its limit', () => {
    const r = analyseMic(capture({ speechDb: -70, noiseDb: -120 }), SR);
    expect(r.after!.trimDb).toBe(40);
    expect(r.notes.join(' ')).toMatch(/Trim am Anschlag/);
  });
});

describe('setup measurement: voice character', () => {
  it('finds the fundamental', () => {
    for (const f0 of [95, 120, 180, 220]) {
      const est = fundamentalHz(speechOnly(voice({ f0, seconds: 4 })), SR)!;
      expect(Math.abs(est - f0) / f0).toBeLessThan(0.05);
    }
    expect(fundamentalHz(noise(-20, 2), SR)).toBeNull();
  });

  it('sets the high-pass from it: ~100 Hz for a high voice, lower for a low one', () => {
    const high = analyseMic(capture({ f0: 190 }), SR);
    const low = analyseMic(capture({ f0: 110 }), SR);
    expect(high.fundamentalHz!).toBeGreaterThan(180);
    expect(high.after!.hpfHz).toBeGreaterThanOrEqual(100);
    expect(high.after!.hpfHz).toBeLessThanOrEqual(110);
    expect(low.after!.hpfHz).toBeGreaterThanOrEqual(60);
    expect(low.after!.hpfHz).toBeLessThanOrEqual(70);
  });

  it('measures sibilance and places the de-esser under its peaks', () => {
    const plain = speechOnly(voice({ rmsDb: -35, seconds: 4 }));
    const hissy = speechOnly(voice({ rmsDb: -35, seconds: 4, sibilants: true }));
    expect(sibilanceDb(hissy, SR)).toBeGreaterThan(sibilanceDb(plain, SR) + 5);
    const a = analyseMic(capture({ speech: hissy }), SR);
    const b = analyseMic(capture({ speech: plain }), SR);
    // More sibilance -> the threshold sits higher (it tracks the peaks).
    expect(a.after!.deessThresholdDb).toBeGreaterThan(b.after!.deessThresholdDb + 6);
  });
});

describe('setup measurement: the result works on the strip', () => {
  it('seeds the leveler so the first word is at target, and the zone reads "passt"', () => {
    const raw = mix(voice({ rmsDb: -38, f0: 190, seconds: 4, sibilants: true }), noise(-90, 4, 11));
    const r = analyseMic(capture({ speech: speechOnly(raw), noise: noise(-90, 5) }), SR);
    expect(Number.isFinite(r.after!.seedDb)).toBe(true);

    // A strip with the result, seeded: no look-ahead, so nothing but the seed
    // can have the gain right at the start.
    const seeded = new ChannelStrip(r.processing!, SR);
    seeded.retune(r.processing!, r.after!.seedDb);
    const unseeded = new ChannelStrip(r.processing!, SR);
    const a = new Float32Array(SR);
    const b = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      a[i] = seeded.process(raw[i]);
      b[i] = unseeded.process(raw[i]);
    }
    const settled = new ChannelStrip(r.processing!, SR);
    const last = new Float32Array(SR);
    for (let i = 0; i < raw.length; i++) {
      const y = settled.process(raw[i]);
      if (i >= raw.length - SR) last[i - (raw.length - SR)] = y;
    }
    expect(Math.abs(rmsDb(a) - rmsDb(last))).toBeLessThan(2);
    expect(seeded.meters().zone).toBe('ok');
    // Moving 10 dB away from the mic leaves the zone.
    const far = new ChannelStrip(r.processing!, SR);
    for (let i = 0; i < 2 * SR; i++) far.process(raw[i] * Math.pow(10, -10 / 20));
    expect(far.meters().zone).toBe('low');
    // Without the seed the same strip starts at 0 dB and is off by the seed
    // until it has heard enough of the voice (the first few dozen ms).
    expect(Math.abs(r.after!.seedDb)).toBeGreaterThan(1);
    const head = Math.round(0.06 * SR);
    expect(Math.abs(rmsDb(b.subarray(0, head)) - rmsDb(last))).toBeGreaterThan(
      Math.abs(rmsDb(a.subarray(0, head)) - rmsDb(last))
    );
  });

  it('derives an automix floor from the results', () => {
    const r = analyseMic(capture({ speechDb: -35, noiseDb: -85 }), SR);
    const floor = automixFloorDb([r])!;
    expect(floor).toBeGreaterThanOrEqual(-75);
    expect(floor).toBeLessThanOrEqual(-40);
    expect(automixFloorDb([analyseMic(capture({ speech: new Float32Array(10) }), SR)])).toBeNull();
  });
});

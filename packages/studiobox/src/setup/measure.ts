import { ChannelProcessing } from '../config/schema';
import { Biquad } from '../dsp/biquad';
import { ChannelStrip } from '../dsp/channel-strip';

/**
 * The arithmetic of the setup assistant ("Einmessen"): from a few seconds of
 * room silence and a few seconds of each voice — raw capture, before any
 * processing — to the settings of that mic's strip. Pure functions, no I/O;
 * `session.ts` collects the audio, the pipeline applies the result.
 */

/** Speech level every mic is trimmed to ahead of gate and compressor (dBFS RMS). */
export const REFERENCE_DB = -20;
/** Where the analog gain should put the speech peaks (dBFS). */
export const TARGET_PEAK_DB = -12;
/** Speech peaks below this are too quiet for the converter: turn the gain up. */
export const QUIET_PEAK_DB = -30;
/** A speech-to-noise ratio below this is too little. */
export const MIN_SNR_DB = 40;
/** Anything above this counts as clipped: turn the gain down. */
export const CLIP_DB = -3;
/** Digital trim limits: beyond them the knob has to do the work. */
export const TRIM_MIN_DB = -20;
export const TRIM_MAX_DB = 40;
/** Compressor threshold above the trimmed speech level. */
const COMP_OVER_SPEECH_DB = 4;
/** De-esser threshold below the loudest sibilants. */
const DEESS_BELOW_PEAK_DB = 8;

const db = (power: number): number => 10 * Math.log10(Math.max(power, 1e-20));
const ampDb = (a: number): number => 20 * Math.log10(Math.max(a, 1e-10));
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const round1 = (x: number): number => Math.round(x * 10) / 10;

export function rmsDb(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return db(s / Math.max(1, x.length));
}

export function peakDb(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > p) p = a;
  }
  return ampDb(p);
}

/** The level `fraction` of the samples stay below (dBFS of |x|), e.g. 0.999
 *  for "the peaks" without the single loudest click. */
export function percentileDb(x: ArrayLike<number>, fraction: number): number {
  if (!x.length) return -200;
  const a = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) a[i] = Math.abs(x[i]);
  a.sort();
  return ampDb(a[Math.min(a.length - 1, Math.floor(fraction * a.length))]);
}

/**
 * Median fundamental of a voice in Hz, or null when nothing voiced was found.
 * Normalised autocorrelation on 40 ms frames over 70..350 Hz; only clearly
 * periodic frames vote.
 */
export function fundamentalHz(x: Float32Array, sampleRate: number): number | null {
  // Work at ~8 kHz: plenty for a fundamental and 36x cheaper.
  const step = Math.max(1, Math.round(sampleRate / 8000));
  const sr = sampleRate / step;
  const lp = Biquad.design('lowpass', sampleRate, 900, 0.707, 0);
  const y = new Float32Array(Math.floor(x.length / step));
  for (let i = 0, o = 0; i < x.length; i++) {
    const v = lp.process(x[i]);
    if (i % step === 0 && o < y.length) y[o++] = v;
  }
  const frame = Math.round(0.04 * sr);
  const minLag = Math.floor(sr / 350);
  const maxLag = Math.ceil(sr / 70);
  const votes: number[] = [];
  for (let start = 0; start + frame + maxLag < y.length; start += frame) {
    let e0 = 0;
    for (let i = 0; i < frame; i++) e0 += y[start + i] * y[start + i];
    if (e0 <= 1e-12) continue;
    let best = 0;
    let bestLag = 0;
    const corr = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let c = 0;
      let e1 = 0;
      for (let i = 0; i < frame; i++) {
        c += y[start + i] * y[start + i + lag];
        e1 += y[start + i + lag] * y[start + i + lag];
      }
      corr[lag] = e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
    }
    // The first strong peak, not the strongest: multiples of the period
    // correlate just as well and would halve the pitch.
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corr[lag] > corr[lag - 1] && corr[lag] >= corr[lag + 1] && corr[lag] > 0.7) {
        if (bestLag !== 0 && lag > bestLag * 1.5) break;
        if (bestLag === 0 || corr[lag] > best) {
          best = corr[lag];
          bestLag = lag;
        }
      }
    }
    if (bestLag > 0) votes.push(sr / bestLag);
  }
  if (votes.length < 3) return null;
  votes.sort((a, b) => a - b);
  return votes[Math.floor(votes.length / 2)];
}

/** Level of the 5..9 kHz band (sibilance) relative to the whole signal, in dB. */
export function sibilanceDb(x: Float32Array, sampleRate: number): number {
  const hp = Biquad.design('highpass', sampleRate, 5000, 0.707, 0);
  const lp = Biquad.design('lowpass', sampleRate, 9000, 0.707, 0);
  let band = 0;
  let all = 0;
  for (let i = 0; i < x.length; i++) {
    const v = lp.process(hp.process(x[i]));
    band += v * v;
    all += x[i] * x[i];
  }
  return db(band / Math.max(all, 1e-20));
}

export type Verdict = 'gut' | 'zu leise' | 'übersteuert' | 'rauscht' | 'kein Signal';

/** What the assistant collected for one mic (raw capture, before processing). */
export interface MicCapture {
  label: string;
  /** 1-based capture channel (the number printed on the mixer). */
  channel: number;
  /** Room silence on this mic. */
  noise: Float32Array;
  /** This mic while its own speaker talked (speech frames only). */
  speech: Float32Array;
  /** The loudest neighbour's voice as it arrives on this mic, or empty. */
  bleed: Float32Array;
  /** Whose voice that was. */
  bleedFrom: string | null;
  /** The processing the strip runs with now. */
  processing: ChannelProcessing;
}

/** The settings the assistant touches, as one flat row of the before/after table. */
export interface StripSettings {
  trimDb: number;
  hpfHz: number;
  gateThresholdDb: number;
  compThresholdDb: number;
  deessThresholdDb: number;
  /** Leveler gain to start from (dB). */
  seedDb: number;
  zoneCenterDb: number;
}

export interface MicResult {
  label: string;
  channel: number;
  verdict: Verdict;
  /** What to do at the mixer, in German, or null when the gain knob is fine. */
  advice: string | null;
  /** Suggested change of the analog gain in dB (0 = leave it). */
  gainChangeDb: number;
  /** Notes that don't block applying (e.g. loud crosstalk). */
  notes: string[];
  /** Measurements, raw capture (dBFS). */
  noiseDb: number;
  speechDb: number | null;
  peakDb: number | null;
  snrDb: number | null;
  /** The loudest neighbour on this mic, relative to this mic's own speech (dB). */
  bleedDb: number | null;
  bleedFrom: string | null;
  fundamentalHz: number | null;
  sibilanceDb: number | null;
  before: StripSettings;
  /** Null when there was no usable speech: nothing to set. */
  after: StripSettings | null;
  /** `after` as a complete processing block, ready for `Graph.retune`. */
  processing: ChannelProcessing | null;
}

export function settingsOf(p: ChannelProcessing, seedDb = 0): StripSettings {
  return {
    trimDb: p.trimDb ?? 0,
    hpfHz: p.hpfHz,
    gateThresholdDb: p.gate.thresholdDb,
    compThresholdDb: p.compressor.thresholdDb,
    deessThresholdDb: p.deesser.thresholdDb,
    seedDb,
    zoneCenterDb: p.zone?.centerDb ?? REFERENCE_DB,
  };
}

/** Put a row of settings onto a processing block (the inverse of
 *  `settingsOf`; the seed is not part of the block). */
export function applySettings(p: ChannelProcessing, s: StripSettings): ChannelProcessing {
  return {
    ...p,
    trimDb: s.trimDb,
    hpfHz: s.hpfHz,
    gate: { ...p.gate, thresholdDb: s.gateThresholdDb },
    compressor: { ...p.compressor, thresholdDb: s.compThresholdDb },
    deesser: { ...p.deesser, thresholdDb: s.deessThresholdDb },
    zone: { centerDb: s.zoneCenterDb, widthDb: p.zone?.widthDb ?? 6 },
  };
}

/** Least speech (seconds) a result is computed from. */
export const MIN_SPEECH_SEC = 1.5;

/**
 * Turn one mic's capture into its result.
 * @param currentSeedDb the leveler gain the strip stands at now (for "before").
 */
export function analyseMic(c: MicCapture, sampleRate: number, currentSeedDb = 0): MicResult {
  const before = settingsOf(c.processing, currentSeedDb);
  const noiseDb = c.noise.length ? rmsDb(c.noise) : -120;
  const base: MicResult = {
    label: c.label,
    channel: c.channel,
    verdict: 'kein Signal',
    advice: `Kanal ${c.channel} (${c.label}): kein Sprachsignal – Mikrofon, Kabel und Gain prüfen.`,
    gainChangeDb: 0,
    notes: [],
    noiseDb: round1(noiseDb),
    speechDb: null,
    peakDb: null,
    snrDb: null,
    bleedDb: null,
    bleedFrom: null,
    fundamentalHz: null,
    sibilanceDb: null,
    before,
    after: null,
    processing: null,
  };
  if (c.speech.length < MIN_SPEECH_SEC * sampleRate) return base;

  const speechDb = rmsDb(c.speech);
  const peak = peakDb(c.speech);
  const snrDb = speechDb - noiseDb;
  const f0 = fundamentalHz(c.speech, sampleRate);
  const sib = sibilanceDb(c.speech, sampleRate);

  // --- the knob studiobox cannot turn ---
  let verdict: Verdict = 'gut';
  let advice: string | null = null;
  let gainChangeDb = 0;
  const ch = `Kanal ${c.channel} (${c.label})`;
  if (peak > CLIP_DB) {
    verdict = 'übersteuert';
    gainChangeDb = Math.round(TARGET_PEAK_DB - peak);
    advice = `${ch}: Gain um etwa ${Math.abs(gainChangeDb)} dB zurückdrehen.`;
  } else if (peak < QUIET_PEAK_DB) {
    verdict = 'zu leise';
    gainChangeDb = Math.round(TARGET_PEAK_DB - peak);
    advice = `${ch}: Gain um etwa +${gainChangeDb} dB aufdrehen.`;
  } else if (snrDb < MIN_SNR_DB) {
    // Quiet enough to be noisy, but not so quiet that the first rule caught
    // it: more gain helps only as far as the peaks have room.
    const room = Math.round(TARGET_PEAK_DB - peak);
    if (room >= 3) {
      verdict = 'zu leise';
      gainChangeDb = room;
      advice = `${ch}: Gain um etwa +${room} dB aufdrehen.`;
    } else {
      verdict = 'rauscht';
      advice = `${ch}: zu viel Rauschen (${Math.round(snrDb)} dB Abstand) – näher ans Mikrofon, Raum leiser.`;
    }
  }

  // --- everything after the knob ---
  const trimDb = round1(clamp(REFERENCE_DB - speechDb, TRIM_MIN_DB, TRIM_MAX_DB));
  const trimmedSpeech = speechDb + trimDb; // REFERENCE_DB unless the trim hit its limit

  // Gate: above what the mic hears when its speaker is silent, below the
  // quiet end of the speech. The gate's detector follows peaks, so the floor
  // is taken from the peaks of noise and bleed, not their RMS.
  const noisePeak = c.noise.length ? percentileDb(c.noise, 0.999) : -120;
  const bleedPeak = c.bleed.length ? percentileDb(c.bleed, 0.999) : -200;
  const floor = Math.max(noisePeak, bleedPeak) + trimDb + 3;
  const ceiling = trimmedSpeech - 15;
  const gateThresholdDb = round1(floor <= ceiling ? (floor + ceiling) / 2 : ceiling);

  const notes: string[] = [];
  let bleedDb: number | null = null;
  if (c.bleed.length) {
    bleedDb = round1(rmsDb(c.bleed) - speechDb);
    if (floor > ceiling && bleedPeak > noisePeak) {
      notes.push(
        `Übersprechen: ${c.bleedFrom ?? 'Nachbar'} kommt hier nur ${Math.round(-bleedDb)} dB leiser an ` +
          `als die eigene Stimme – Mikrofone weiter auseinander oder näher besprechen.`
      );
    }
  }
  if (trimDb >= TRIM_MAX_DB || trimDb <= TRIM_MIN_DB) {
    notes.push('Trim am Anschlag – den Pegel am Gain-Regler korrigieren.');
  }

  // HPF: a bit more than half the fundamental keeps the voice and drops rumble.
  const hpfHz = f0 ? Math.round(clamp(f0 * 0.55, 60, 120) / 5) * 5 : c.processing.hpfHz;

  // De-esser: only the loudest sibilants cross its threshold. Measured in the
  // band the de-esser itself splits off.
  const hp = Biquad.design('highpass', sampleRate, c.processing.deesser.freq, 0.707, 0);
  const high = new Float32Array(c.speech.length);
  for (let i = 0; i < high.length; i++) high[i] = hp.process(c.speech[i]);
  const deessThresholdDb = round1(percentileDb(high, 0.999) + trimDb - DEESS_BELOW_PEAK_DB);

  const compThresholdDb = round1(trimmedSpeech + COMP_OVER_SPEECH_DB);

  const processing: ChannelProcessing = {
    ...c.processing,
    trimDb,
    hpfHz,
    gate: { ...c.processing.gate, thresholdDb: gateThresholdDb },
    compressor: { ...c.processing.compressor, thresholdDb: compThresholdDb },
    deesser: { ...c.processing.deesser, thresholdDb: deessThresholdDb },
    zone: { centerDb: round1(trimmedSpeech), widthDb: c.processing.zone?.widthDb ?? 6 },
  };

  // Leveler seed: run the recorded voice through the retuned strip and read
  // off the gain its leveler arrives at.
  const strip = new ChannelStrip(processing, sampleRate);
  for (let i = 0; i < c.speech.length; i++) strip.level(strip.pre(c.speech[i]), true);
  const seedDb = round1(strip.levelerTargetDb);

  return {
    ...base,
    verdict,
    advice,
    gainChangeDb,
    notes,
    speechDb: round1(speechDb),
    peakDb: round1(peak),
    snrDb: round1(snrDb),
    bleedDb,
    bleedFrom: c.bleed.length ? c.bleedFrom : null,
    fundamentalHz: f0 ? Math.round(f0) : null,
    sibilanceDb: round1(sib),
    after: settingsOf(processing, seedDb),
    processing,
  };
}

/** Automix floor from the measured results: a little above the loudest
 *  mic's noise as it arrives at the mix (after trim and leveler seed). */
export function automixFloorDb(results: MicResult[]): number | null {
  const levels = results
    .filter((r) => r.after)
    .map((r) => r.noiseDb + r.after!.trimDb + r.after!.seedDb);
  if (!levels.length) return null;
  return round1(clamp(Math.max(...levels) + 6, -75, -40));
}

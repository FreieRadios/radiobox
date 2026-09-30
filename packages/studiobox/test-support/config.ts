import { ChannelConfig, ChannelProcessing, StudioboxConfig } from '../src/config/schema';

export const SR = 48000;

/** A fully-bypassed processing chain; override one field at a time to isolate a stage. */
export const bypass = (over: Partial<ChannelProcessing> = {}): ChannelProcessing => ({
  hpfHz: 0,
  gate: { enabled: false, thresholdDb: -40, rangeDb: -40, attackMs: 5, holdMs: 20, releaseMs: 20 },
  eq: [],
  deesser: { enabled: false, freq: 6000, thresholdDb: -30, ratio: 4 },
  compressor: {
    enabled: false,
    thresholdDb: -20,
    ratio: 4,
    kneeDb: 0,
    attackMs: 1,
    releaseMs: 10,
    makeupDb: 0,
  },
  leveler: { enabled: false, targetLufs: -23, maxGainDb: 24, rangeDb: 24, responseMs: 1500 },
  gainDb: 0,
  ...over,
});

export const mic = (
  source: number,
  label: string,
  processing: ChannelProcessing = bypass()
): ChannelConfig => ({ source, role: 'mic', label, processing });

/** A minimal live config around the given channels. Everything that colours
 *  the sound (automix, ducking, look-ahead, air delay) is off unless a test
 *  switches it on, and the limiter ceiling is out of the way. */
export function config(
  channels: ChannelConfig[],
  over: Partial<StudioboxConfig> = {}
): StudioboxConfig {
  const srcs = channels.flatMap((c) => (Array.isArray(c.source) ? c.source : [c.source]));
  return {
    mode: 'live',
    capture: {
      backend: 'alsa',
      device: 'null',
      sampleRate: SR,
      channels: Math.max(2, ...srcs),
      blockSize: 1024,
    },
    lookahead: { seconds: 0, gateMs: 0, mixMs: 0 },
    airDelay: { seconds: 0, toleranceSeconds: 1 },
    channels,
    automix: {
      enabled: false,
      members: [],
      responseMs: 120,
      floorDb: -60,
      priority: {
        enabled: false,
        label: '',
        attenuate: [],
        depthDb: -8,
        thresholdDb: -35,
        attackMs: 120,
        holdMs: 300,
        releaseMs: 800,
      },
    },
    duck: {
      enabled: false,
      targets: [],
      thresholdDb: -40,
      musicPresentDb: -45,
      depthDb: -15,
      attackMs: 40,
      holdMs: 400,
      releaseMs: 600,
    },
    master: { targetLufs: -16, truePeakDb: 0, limiterLookaheadMs: 5, limiterReleaseMs: 100 },
    output: {
      harbor: { enabled: false, url: '', format: 'ogg-flac', contentType: '' },
      backup: { enabled: false, dir: './recordings', segmentSeconds: 0 },
      multitrack: { enabled: false, source: 'dry' },
      monitor: { enabled: false, backend: 'alsa', device: '' },
      return: { enabled: false, backend: 'alsa', device: '' },
    },
    meters: { enabled: false, port: 0, fps: 20, roles: { enabled: false, tokens: {} } },
    listeners: {
      enabled: false,
      url: '',
      app: 'radio-z',
      username: '',
      password: '',
      pollSeconds: 45,
    },
    stateFile: '/nonexistent/session-state.json',
    ...over,
  };
}

/** Sine with the given RMS level in dBFS. */
export function tone(rmsDb: number, seconds: number, freq = 1000): Float32Array {
  const amp = Math.pow(10, rmsDb / 20) * Math.SQRT2;
  const out = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

export const silence = (seconds: number): Float32Array =>
  new Float32Array(Math.round(seconds * SR));

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function scale(x: Float32Array, db: number): Float32Array {
  const g = Math.pow(10, db / 20);
  return x.map((v) => v * g);
}

/** RMS level in dBFS of x[from..to). */
export function rmsDb(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return 10 * Math.log10(Math.max(s / Math.max(1, to - from), 1e-20));
}

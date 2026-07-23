import { DuckConfig } from '../config/schema';
import { dbToGain, gainToDb, msToCoef } from './dsp-math';
import { EnvelopeFollower } from './envelope';

/**
 * Sidechain ducker: mic-bus activity attenuates the music bus.
 * Only armed while music is actually present (per spec), so it never pumps
 * the noise floor when nothing is playing.
 */
export class Ducker {
  private micDet: EnvelopeFollower;
  private musicDet: EnvelopeFollower;
  private atk: number;
  private rel: number;
  private holdSamples: number;
  private held = 0;
  private gainDb = 0;

  constructor(
    private p: DuckConfig,
    sampleRate: number
  ) {
    this.micDet = new EnvelopeFollower(sampleRate, 5, 80);
    this.musicDet = new EnvelopeFollower(sampleRate, 10, 300);
    this.atk = msToCoef(p.attackMs, sampleRate);
    this.rel = msToCoef(p.releaseMs, sampleRate);
    this.holdSamples = Math.round((p.holdMs / 1000) * sampleRate);
  }

  /** `micBus` = summed processed mics, `musicBus` = current music sample.
   *  Returns the linear gain to apply to the music bus. */
  process(micBus: number, musicBus: number): number {
    if (!this.p.enabled) return 1;
    const micDb = gainToDb(this.micDet.process(micBus));
    const musicDb = gainToDb(this.musicDet.process(musicBus));

    const armed = musicDb > this.p.musicPresentDb;
    const trigger = armed && micDb > this.p.thresholdDb;
    if (trigger) this.held = this.holdSamples;
    else if (this.held > 0) this.held--;

    const target = armed && (trigger || this.held > 0) ? this.p.depthDb : 0;
    const c = target < this.gainDb ? this.atk : this.rel;
    this.gainDb = c * (this.gainDb - target) + target;
    return dbToGain(this.gainDb);
  }

  /** Current attenuation in dB (0 = no duck). */
  get depthDb(): number {
    return this.gainDb;
  }
}

import { ChannelProcessing } from '../config/schema';
import { Biquad } from './biquad';
import { Gate } from './gate';
import { Deesser } from './deesser';
import { Compressor } from './compressor';
import { Leveler } from './leveler';
import { EnvelopeFollower } from './envelope';
import { dbToGain, gainToDb } from './dsp-math';

export interface StripMeters {
  outDb: number;
  gateOpen: number;
  compGrDb: number;
  levelerDb: number;
}

/** Full mic channel chain: HPF -> gate -> EQ -> de-esser -> compressor -> leveler -> gain. */
export class ChannelStrip {
  private hpf: Biquad | null;
  private gate: Gate;
  private eq: Biquad[];
  private deesser: Deesser;
  private comp: Compressor;
  private leveler: Leveler;
  private outGain: number;
  private outEnv: EnvelopeFollower;

  constructor(p: ChannelProcessing, sampleRate: number) {
    this.hpf = p.hpfHz > 0 ? Biquad.design('highpass', sampleRate, p.hpfHz, 0.707, 0) : null;
    this.gate = new Gate(p.gate, sampleRate);
    this.eq = p.eq.map((b) => Biquad.design(b.type, sampleRate, b.freq, b.q, b.gainDb));
    this.deesser = new Deesser(p.deesser, sampleRate);
    this.comp = new Compressor(p.compressor, sampleRate);
    this.leveler = new Leveler(p.leveler, sampleRate);
    this.outGain = dbToGain(p.gainDb);
    this.outEnv = new EnvelopeFollower(sampleRate, 1, 150);
  }

  process(x: number): number {
    let y = this.hpf ? this.hpf.process(x) : x;
    y *= this.gate.process(y);
    for (const b of this.eq) y = b.process(y);
    y = this.deesser.process(y);
    y = this.comp.process(y);
    y = this.leveler.process(y);
    y *= this.outGain;
    this.outEnv.process(y);
    return y;
  }

  meters(): StripMeters {
    return {
      outDb: gainToDb(this.outEnv.value),
      gateOpen: this.gate.openness,
      compGrDb: this.comp.gainReductionDb,
      levelerDb: this.leveler.gainDbValue,
    };
  }
}

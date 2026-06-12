import { EqType } from '../config/schema';
import { dn } from './dsp-math';

/** RBJ-cookbook biquad, Direct Form I. Used for HPF, EQ bands and K-weighting. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  /** Set normalized (a0 == 1) coefficients directly. */
  setCoeffs(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y =
      this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = dn(y);
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  static design(type: EqType, sampleRate: number, freq: number, q: number, gainDb: number): Biquad {
    const bq = new Biquad();
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(q, 1e-4));
    const A = Math.pow(10, gainDb / 40);

    switch (type) {
      case 'highpass': {
        const b0 = (1 + cw) / 2;
        bq.setCoeffs(b0, -(1 + cw), b0, 1 + alpha, -2 * cw, 1 - alpha);
        break;
      }
      case 'lowpass': {
        const b0 = (1 - cw) / 2;
        bq.setCoeffs(b0, 1 - cw, b0, 1 + alpha, -2 * cw, 1 - alpha);
        break;
      }
      case 'peaking': {
        bq.setCoeffs(
          1 + alpha * A, -2 * cw, 1 - alpha * A,
          1 + alpha / A, -2 * cw, 1 - alpha / A,
        );
        break;
      }
      case 'lowshelf': {
        const ap = A + 1;
        const am = A - 1;
        const tsa = 2 * Math.sqrt(A) * alpha;
        bq.setCoeffs(
          A * (ap - am * cw + tsa),
          2 * A * (am - ap * cw),
          A * (ap - am * cw - tsa),
          ap + am * cw + tsa,
          -2 * (am + ap * cw),
          ap + am * cw - tsa,
        );
        break;
      }
      case 'highshelf': {
        const ap = A + 1;
        const am = A - 1;
        const tsa = 2 * Math.sqrt(A) * alpha;
        bq.setCoeffs(
          A * (ap + am * cw + tsa),
          -2 * A * (am + ap * cw),
          A * (ap + am * cw - tsa),
          ap - am * cw + tsa,
          2 * (am - ap * cw),
          ap - am * cw - tsa,
        );
        break;
      }
    }
    return bq;
  }
}

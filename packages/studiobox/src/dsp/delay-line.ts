/** Fixed-length circular delay line over Float32Array, used for look-ahead. */
export class DelayLine {
  private buf: Float32Array;
  private idx = 0;
  readonly length: number;

  constructor(samples: number) {
    this.length = Math.max(1, samples | 0);
    this.buf = new Float32Array(this.length);
  }

  /** Push `x`, return the sample delayed by `length` samples. */
  process(x: number): number {
    const out = this.buf[this.idx];
    this.buf[this.idx] = x;
    this.idx = (this.idx + 1) % this.length;
    return out;
  }

  reset(): void {
    this.buf.fill(0);
    this.idx = 0;
  }
}

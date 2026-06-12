import { dbToGain, msToCoef } from './dsp-math';
import { DelayLine } from './delay-line';

/**
 * Sliding maximum over the last `win` samples, via a monotonic deque
 * (O(1) amortized). Lets the limiter see the loudest sample anywhere in the
 * look-ahead window, so the gain can be ramped down to meet a peak before it
 * reaches the output — on both the leading and trailing edge of a loud burst.
 */
class SlidingMax {
  private val: Float64Array;
  private dq: Int32Array; // ring of `val` indices, values decreasing front -> back
  private head = 0;
  private tail = 0; // exclusive
  private count = 0;
  private ring = 0; // next write slot in `val`

  constructor(private win: number) {
    this.val = new Float64Array(win);
    this.dq = new Int32Array(win);
  }

  push(v: number): number {
    const W = this.win;
    // The slot about to be overwritten is the sample leaving the window; if it
    // is still the running max it sits at the deque front, so drop it.
    if (this.count > 0 && this.dq[this.head] === this.ring) {
      this.head = (this.head + 1) % W;
      this.count--;
    }
    // Keep the deque monotonic: discard tail entries no larger than the new value.
    while (this.count > 0) {
      const back = (this.tail - 1 + W) % W;
      if (this.val[this.dq[back]] <= v) {
        this.tail = back;
        this.count--;
      } else break;
    }
    this.val[this.ring] = v;
    this.dq[this.tail] = this.ring;
    this.tail = (this.tail + 1) % W;
    this.count++;
    this.ring = (this.ring + 1) % W;
    return this.val[this.dq[this.head]];
  }
}

/**
 * Stereo-linked look-ahead brick-wall limiter (sample-peak).
 *
 * The signal is delayed by the look-ahead window while a sliding-maximum
 * detector tracks the loudest sample within it. The gain ramps down linearly to
 * meet an upcoming peak and reaches the required reduction before that peak
 * exits the delay, so sample peaks never exceed the ceiling. True-peak (4x
 * oversampled, inter-sample) detection is a planned enhancement; the
 * look-ahead/delay structure here feeds it directly.
 */
export class Limiter {
  private dl: DelayLine;
  private dr: DelayLine;
  private smax: SlidingMax;
  private ceiling: number;
  private attackStep: number;
  private rel: number;
  private gain = 1;

  constructor(sampleRate: number, ceilingDb: number, lookaheadMs: number, releaseMs: number) {
    const look = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
    this.dl = new DelayLine(look);
    this.dr = new DelayLine(look);
    // Window spans the look-ahead plus the sample currently leaving the delay.
    this.smax = new SlidingMax(look + 1);
    this.ceiling = dbToGain(ceilingDb);
    // Linear attack: a step of 1/look per sample lets the gain fall from unity to
    // any required value within the look-ahead window, so it always settles in time.
    this.attackStep = 1 / look;
    this.rel = msToCoef(releaseMs, sampleRate);
  }

  /** Process one stereo frame; mutates and returns `[l, r]`. */
  process(out: [number, number], l: number, r: number): [number, number] {
    const windowPeak = this.smax.push(Math.max(Math.abs(l), Math.abs(r)));
    const required = windowPeak > this.ceiling ? this.ceiling / windowPeak : 1;
    if (required < this.gain) {
      // Ramp down, never overshooting past the target reduction.
      this.gain = Math.max(required, this.gain - this.attackStep);
    } else {
      // Release upward, but never above what the current window allows.
      this.gain = this.rel * (this.gain - required) + required;
    }
    out[0] = this.dl.process(l) * this.gain;
    out[1] = this.dr.process(r) * this.gain;
    return out;
  }

  get gainReductionDb(): number {
    return -20 * Math.log10(Math.max(this.gain, 1e-6));
  }
}

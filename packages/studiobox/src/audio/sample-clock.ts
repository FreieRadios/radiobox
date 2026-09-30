/**
 * Maps the capture's sample counter to wall-clock time.
 *
 * Capture blocks arrive in bursts (the ALSA reader hands over a period at a
 * time), so "the time this block arrived" jitters by a period and is no clock
 * for anything that has to land on a given second. The sample counter is
 * smooth, though: sample `n` was captured `n / rate` after sample 0. This
 * class pins that line to the wall clock by its *earliest* observations — a
 * block can arrive late, never before it was recorded — and lets the pin
 * creep forward slowly so it follows a sound card whose clock runs slower
 * than the system's.
 */
export class SampleClock {
  private baseMs: number | null = null; // wall time of sample 0
  private lastMarkMs = 0;
  private readonly msPerSample: number;

  /**
   * @param leakPpm how fast the pin may creep forward (ppm of elapsed time);
   *   has to exceed any real clock drift (USB audio stays within ~100 ppm).
   * @param jumpMs an observation this much later than expected means the
   *   stream stalled (capture restart, suspend): re-pin instead of creeping.
   */
  constructor(
    sampleRate: number,
    private leakPpm = 500,
    private jumpMs = 250
  ) {
    this.msPerSample = 1000 / sampleRate;
  }

  /** Note that `totalSamples` samples have arrived by wall time `nowMs`. */
  mark(totalSamples: number, nowMs: number): void {
    const obs = nowMs - totalSamples * this.msPerSample;
    if (this.baseMs === null || obs - this.baseMs > this.jumpMs) {
      this.baseMs = obs;
    } else {
      const leak = Math.max(0, nowMs - this.lastMarkMs) * this.leakPpm * 1e-6;
      this.baseMs = Math.min(this.baseMs + leak, obs);
    }
    this.lastMarkMs = nowMs;
  }

  /** Wall-clock time (epoch ms) at which sample index `sample` was captured.
   *  Before the first mark it falls back to the current time. */
  timeOf(sample: number, fallbackNowMs: number = Date.now()): number {
    if (this.baseMs === null) return fallbackNowMs;
    return this.baseMs + sample * this.msPerSample;
  }

  /** Forget the pin (the capture was restarted). */
  reset(): void {
    this.baseMs = null;
  }
}

/**
 * The air-delay buffer between the DSP graph and the outputs.
 *
 * studiobox airs a fixed time D behind the room (roadmap, section 2). Every
 * programme block is stamped with the room time of the sound it carries and
 * becomes *due* at `capturedMs + D - outputLatency`. The buffer is driven
 * from the consumer side:
 *
 *  - **pull** (`pop`): a sound card asks for the next block at its own clock.
 *    The capture card and the output card drift apart, so the head block is
 *    rarely due to the millisecond; within `toleranceMs` it is simply handed
 *    over — the buffer absorbs the drift and the measured delay wanders by
 *    that much. Beyond `softMs` the delay is nudged back one block at a time,
 *    but only in blocks that are silent anyway (dropping or repeating
 *    silence is inaudible). Beyond `toleranceMs` — after a device stall — it
 *    is re-centred in one step.
 *  - **push** (`drain`): without a sound card there is no second clock; the
 *    blocks are released as they fall due, which makes the buffer a plain
 *    delay line.
 *
 * After a start the buffer has to fill for D before the first block is due;
 * until then `pop` answers null and the caller plays silence.
 */
export interface AirBlock {
  /** Interleaved stereo f32le programme block. */
  buf: Buffer;
  /** Room time (epoch ms) of the sound at the start of this block. */
  capturedMs: number;
  /** True when the block is silent enough to be dropped or repeated unheard. */
  quiet: boolean;
}

export interface AirFifoOptions {
  /** Target delay D from the room to the output, in ms. */
  delayMs: number;
  /** Latency after the buffer (pipe + device), in ms. */
  outputLatencyMs: number;
  /** Re-centre in one step beyond this deviation, in ms. */
  toleranceMs: number;
  /** Nudge back during silence beyond this deviation, in ms. */
  softMs?: number;
  /** Duration of one block in ms (bounds the memory the buffer may take). */
  blockMs: number;
}

export type AirState = 'filling' | 'live';

export class AirFifo {
  private q: AirBlock[] = [];
  private st: AirState = 'filling';
  private delayMs: number;
  private outLatMs: number;
  private readonly tolMs: number;
  private readonly softMs: number;
  private readonly maxBlocks: number;
  /** Smoothed measured delay (room -> output), null until the first block aired. */
  private measured: number | null = null;
  underruns = 0;
  resyncs = 0;
  nudges = 0;

  constructor(o: AirFifoOptions) {
    this.delayMs = o.delayMs;
    this.outLatMs = o.outputLatencyMs;
    this.tolMs = o.toleranceMs;
    this.softMs = o.softMs ?? Math.min(150, o.toleranceMs / 2);
    // Room for the delay, the tolerance and a stalled consumer's backlog.
    this.maxBlocks = Math.ceil((o.delayMs + 2 * o.toleranceMs + 5000) / o.blockMs);
  }

  get state(): AirState {
    return this.st;
  }

  get length(): number {
    return this.q.length;
  }

  /** Measured delay from the room to the output in ms (smoothed), or null
   *  while nothing has aired yet. */
  get measuredDelayMs(): number | null {
    return this.measured;
  }

  /** The output behind the buffer changed (e.g. sound card <-> none). */
  setOutputLatency(ms: number): void {
    this.outLatMs = ms;
  }

  push(block: AirBlock): void {
    this.q.push(block);
    if (this.q.length > this.maxBlocks) {
      // Nobody is taking blocks. Keep the newest; the consumer re-centres
      // when it comes back.
      this.q.splice(0, this.q.length - this.maxBlocks);
    }
  }

  /** Wall time the block should be handed to the output. */
  private dueMs(b: AirBlock): number {
    return b.capturedMs + this.delayMs - this.outLatMs;
  }

  private note(b: AirBlock, nowMs: number): void {
    const d = nowMs + this.outLatMs - b.capturedMs;
    this.measured = this.measured === null ? d : this.measured + 0.02 * (d - this.measured);
  }

  /**
   * Pull: the output wants one block now. Returns null when it has to play
   * silence instead (still filling, run dry, or stretching the delay).
   */
  pop(nowMs: number): AirBlock | null {
    let head = this.q[0];
    if (!head) {
      if (this.st === 'live') this.underruns++;
      return null;
    }
    let err = nowMs - this.dueMs(head); // > 0: late (delay too long), < 0: early
    if (this.st === 'filling') {
      if (err < 0) return null;
      this.st = 'live';
    } else if (err < -this.tolMs) {
      // Far too early: the delay has collapsed (the output ate a backlog).
      // Rebuild it with silence.
      this.resyncs++;
      this.st = 'filling';
      return null;
    }
    if (err > this.tolMs) {
      // Far too late: the output stalled. Skip ahead to the block due now.
      this.resyncs++;
      while (this.q.length > 1 && nowMs - this.dueMs(this.q[1]) >= 0) this.q.shift();
      head = this.q[0];
      err = nowMs - this.dueMs(head);
    } else if (err > this.softMs && head.quiet && this.q.length > 1) {
      this.nudges++;
      this.q.shift(); // drop one silent block: the delay shrinks by a block
      head = this.q[0];
    } else if (err < -this.softMs && head.quiet) {
      this.nudges++;
      return null; // play one extra block of silence: the delay grows
    }
    this.q.shift();
    this.note(head, nowMs);
    return head;
  }

  /** Push mode: release every block that has fallen due by `nowMs`. */
  drain(nowMs: number): AirBlock[] {
    const out: AirBlock[] = [];
    while (this.q.length && nowMs - this.dueMs(this.q[0]) >= 0) {
      const b = this.q.shift()!;
      this.note(b, nowMs);
      out.push(b);
    }
    if (out.length) this.st = 'live';
    return out;
  }

  /** Drop everything and start filling again. */
  reset(): void {
    this.q = [];
    this.st = 'filling';
    this.measured = null;
  }
}

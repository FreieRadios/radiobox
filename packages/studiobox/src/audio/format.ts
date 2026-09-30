/** Raw PCM helpers. studiobox works internally in 32-bit float (f32le),
 *  which is also what ffmpeg emits/consumes on the pipes. */

export const BYTES_PER_SAMPLE = 4;

/** De-interleave one block of f32le into per-channel buffers. */
export function deinterleave(
  block: Buffer,
  channels: number,
  frames: number,
  out: Float32Array[]
): void {
  for (let n = 0; n < frames; n++) {
    const base = n * channels;
    for (let c = 0; c < channels; c++) {
      out[c][n] = block.readFloatLE((base + c) * BYTES_PER_SAMPLE);
    }
  }
}

/** Interleave a stereo block into an f32le Buffer. */
export function interleaveStereo(l: Float32Array, r: Float32Array, frames: number): Buffer {
  const buf = Buffer.allocUnsafe(frames * 2 * BYTES_PER_SAMPLE);
  for (let n = 0; n < frames; n++) {
    buf.writeFloatLE(l[n], n * 2 * BYTES_PER_SAMPLE);
    buf.writeFloatLE(r[n], (n * 2 + 1) * BYTES_PER_SAMPLE);
  }
  return buf;
}

/** Interleave any number of equally long channels into an f32le Buffer. */
export function interleave(channels: Float32Array[], frames: number): Buffer {
  const n = channels.length;
  const buf = Buffer.allocUnsafe(frames * n * BYTES_PER_SAMPLE);
  for (let c = 0; c < n; c++) {
    const ch = channels[c];
    for (let i = 0; i < frames; i++) buf.writeFloatLE(ch[i], (i * n + c) * BYTES_PER_SAMPLE);
  }
  return buf;
}

/** Spread an interleaved stereo f32le block over `channels` device channels:
 *  the programme on the first two, silence on the rest. */
export function widenStereo(stereo: Buffer, channels: number): Buffer {
  if (channels <= 2) return stereo;
  const frames = stereo.length / (2 * BYTES_PER_SAMPLE);
  const out = Buffer.alloc(frames * channels * BYTES_PER_SAMPLE);
  const frameBytes = channels * BYTES_PER_SAMPLE;
  for (let i = 0; i < frames; i++) {
    stereo.copy(out, i * frameBytes, i * 2 * BYTES_PER_SAMPLE, (i + 1) * 2 * BYTES_PER_SAMPLE);
  }
  return out;
}

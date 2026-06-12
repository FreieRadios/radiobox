/** Raw PCM helpers. studiobox works internally in 32-bit float (f32le),
 *  which is also what ffmpeg emits/consumes on the pipes. */

export const BYTES_PER_SAMPLE = 4;

/** De-interleave one block of f32le into per-channel buffers. */
export function deinterleave(
  block: Buffer,
  channels: number,
  frames: number,
  out: Float32Array[],
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

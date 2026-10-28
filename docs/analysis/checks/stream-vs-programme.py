#!/usr/bin/env python3
"""Where does the aired level go? Compare studiobox's recorded programme with
a recording of the station's stream of the same show.

    python3 -I stream-vs-programme.py PROGRAMME.flac STREAM.mp3 \
        [--jingle FILE@HH:MM:SS ...] [--stream-start HH:MM:SS]

Prints the offset of the programme inside the stream and its drift (ppm), the
level difference stream - programme per 3 s window (median, p10/p90, by
programme level and over time) and, for each jingle given with the second it
was stamped for, where it starts in the stream and how late that is against
its stamp (assuming the stream file starts at --stream-start).
Needs ffmpeg and numpy. Decodes to 8 kHz mono; run it under nice.
"""
import argparse
import subprocess

import numpy as np

SR = 8000


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.float32).astype(np.float64)


def lag(a, b):
    """Lag L (samples) with a[t] ~ b[t + L], and the normalised peak."""
    n = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    c = np.fft.irfft(np.conj(np.fft.rfft(a, n)) * np.fft.rfft(b, n), n)
    k = int(np.argmax(np.abs(c)))
    if k > n // 2:
        k -= n
    return k, c[k] / np.sqrt((a * a).sum() * (b * b).sum() + 1e-20)


def find(tpl, sig, lo, hi):
    """Start of template tpl inside sig[lo:hi] (seconds)."""
    tpl = tpl[: 8 * SR]
    seg = sig[int(lo * SR) : int(hi * SR)]
    n = 1 << int(np.ceil(np.log2(len(seg) + len(tpl))))
    c = np.fft.irfft(np.conj(np.fft.rfft(tpl, n)) * np.fft.rfft(seg, n), n)[: len(seg) - len(tpl)]
    k = int(np.argmax(c))
    return lo + k / SR


def hms(s):
    h, m, x = (int(v) for v in s.split(":"))
    return h * 3600 + m * 60 + x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("programme")
    ap.add_argument("stream")
    ap.add_argument("--jingle", action="append", default=[], help="FILE@HH:MM:SS (the second it was stamped for)")
    ap.add_argument("--stream-start", help="wall time of the stream file's first sample, HH:MM:SS")
    a = ap.parse_args()

    p, s = decode(a.programme), decode(a.stream)
    dur = len(p) / SR

    # coarse offset from a minute in the middle, then refine at several points
    mid = min(600, dur / 2)
    k, _ = lag(p[int(mid * SR) : int((mid + 60) * SR)], s)
    off = k / SR - mid
    pts, offs = [], []
    for t in np.linspace(60, dur - 60, 6):
        lo = int((t + off - 5) * SR)
        if lo < 0 or lo + 40 * SR > len(s):
            continue
        k, r = lag(p[int(t * SR) : int((t + 30) * SR)], s[lo : lo + 40 * SR])
        pts.append(t)
        offs.append(lo / SR + k / SR - t)
        print(f"programme {t:7.1f} s -> stream +{offs[-1]:.3f} s (r={r:.2f})")
    drift, off0 = np.polyfit(pts, offs, 1)
    print(f"offset {off0:.3f} s, drift {drift * 1e6:.0f} ppm (stream vs programme sample timeline)")

    rows, w = [], int(3 * SR)
    for i in range(0, len(p) - w, w):
        t = i / SR
        j = int((t + off0 + drift * t) * SR)
        if j < 0 or j + w > len(s):
            continue
        x, y = p[i : i + w], s[j : j + w]
        rows.append((t, 10 * np.log10((x * x).mean() + 1e-12), 10 * np.log10((y * y).mean() + 1e-12)))
    R = np.array(rows)
    R = R[R[:, 1] > -40]
    d = R[:, 2] - R[:, 1]
    print(f"stream - programme: median {np.median(d):.2f} dB, p10 {np.percentile(d, 10):.2f}, p90 {np.percentile(d, 90):.2f} ({len(d)} windows)")
    for lo, hi in [(-40, -25), (-25, -20), (-20, -15), (-15, 0)]:
        m = (R[:, 1] >= lo) & (R[:, 1] < hi)
        if m.sum():
            print(f"  programme {lo}..{hi} dB: n={m.sum()}, median {np.median(d[m]):.2f} dB")
    for q in range(0, len(R), 100):
        print(f"  t={R[q, 0]:6.0f} s: median {np.median(d[q : q + 100]):.2f} dB")

    for spec in a.jingle:
        path, stamp = spec.rsplit("@", 1)
        j = decode(path)
        # search the whole stream in 10-minute pieces, keep the best
        best, where = -1.0, None
        for lo in range(0, int(len(s) / SR), 540):
            hi = min(lo + 600, len(s) / SR)
            if hi - lo < 10:
                continue
            t = find(j, s, lo, hi)
            seg = s[int(t * SR) : int(t * SR) + 8 * SR]
            r = (seg * j[: len(seg)]).sum() / np.sqrt((seg**2).sum() * (j[: len(seg)] ** 2).sum() + 1e-20)
            if r > best:
                best, where = r, t
        line = f"jingle {stamp}: in stream at {where:.3f} s (r={best:.2f})"
        if a.stream_start:
            line += f", {where - (hms(stamp) - hms(a.stream_start)):+.3f} s against its stamp"
        print(line)


if __name__ == "__main__":
    main()

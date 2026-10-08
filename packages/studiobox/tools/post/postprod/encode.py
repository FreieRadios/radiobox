"""MP3 encoding with an oversampled true-peak limiter, tags and a loudness check."""
import json
import os
import re
import subprocess

from . import SR

BITRATE = "256k"
LIMIT = 0.84  # ≈ -1.5 dBTP at 4x oversampling


def encode_mp3(f32_path: str, out_path: str, tags: dict[str, str], bitrate=BITRATE):
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", f32_path]
    cmd += ["-af", f"aresample=192000:resampler=soxr,alimiter=limit={LIMIT}:attack=3:release=80:level=false:asc=true,aresample={SR}:resampler=soxr"]
    cmd += ["-c:a", "libmp3lame", "-b:a", bitrate, "-id3v2_version", "3"]
    for k, v in tags.items():
        if v:
            cmd += ["-metadata", f"{k}={v}"]
    cmd.append(out_path)
    subprocess.run(cmd, check=True)


def measure(path: str) -> dict:
    """Integrated loudness (LUFS), loudness range and true peak (dBTP) via ebur128."""
    r = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    err = r.stderr
    out = {}
    m = re.search(r"Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS", err)
    if m:
        out["lufs"] = float(m.group(1))
    m = re.search(r"Loudness range:\s+LRA:\s+(-?[\d.]+) LU", err)
    if m:
        out["lra"] = float(m.group(1))
    m = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+) dBFS", err)
    if m:
        out["true_peak"] = float(m.group(1))
    return out


def duration(path: str) -> float | None:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except ValueError:
        return None

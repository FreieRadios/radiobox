"""A studiobox recording: the channel map, the files beside it, decoding."""
import json
import os
import subprocess
from dataclasses import dataclass, field

import numpy as np

from . import SR
from .levels import db


@dataclass
class Channel:
    index: int  # 0-based column in the multitrack file
    name: str
    kind: str  # mic | music | programme


@dataclass
class Recording:
    json_path: str
    flac: str
    stereo: str | None
    wort: str | None
    ohne_musik_json: str | None
    sample_rate: int
    started_at: str
    channels: list[Channel]
    tags: dict[str, str] = field(default_factory=dict)

    @property
    def base(self) -> str:
        """`studiobox-20261101-180000` — the recording's name without suffixes."""
        return os.path.basename(self.json_path).removesuffix(".multitrack.json")

    @property
    def date(self) -> str | None:
        """`2026-10-07` from the file name's stamp (local time), else the tag."""
        parts = self.base.split("-")
        if len(parts) >= 3 and len(parts[1]) == 8 and parts[1].isdigit():
            s = parts[1]
            return f"{s[:4]}-{s[4:6]}-{s[6:]}"
        return self.tags.get("DATE")

    @property
    def mics(self) -> list[Channel]:
        return [c for c in self.channels if c.kind == "mic"]

    @property
    def music(self) -> list[Channel]:
        return [c for c in self.channels if c.kind == "music"]

    @property
    def programme(self) -> list[Channel]:
        return [c for c in self.channels if c.kind == "programme"]


def _ffprobe_tags(path: str) -> dict[str, str]:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", path],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return dict(json.loads(out).get("format", {}).get("tags", {}))
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
        return {}


def load(json_path: str) -> Recording:
    """Read `<name>.multitrack.json` and find the files that belong to it."""
    with open(json_path) as f:
        meta = json.load(f)
    d = os.path.dirname(os.path.abspath(json_path))
    flac = os.path.join(d, meta["file"])
    if not os.path.exists(flac):
        raise FileNotFoundError(f"multitrack file missing: {flac}")
    base = os.path.basename(json_path).removesuffix(".multitrack.json")

    def opt(suffix):
        p = os.path.join(d, base + suffix)
        return p if os.path.exists(p) else None

    channels = [
        Channel(index=int(c["channel"]) - 1, name=str(c["name"]), kind=str(c["kind"]))
        for c in meta["channels"]
    ]
    sr = int(meta.get("sampleRate", SR))
    if sr != SR:
        raise ValueError(f"the tool assumes {SR} Hz, the recording says {sr}")
    return Recording(
        json_path=os.path.abspath(json_path),
        flac=flac,
        stereo=opt(".flac"),
        wort=opt(".wort.flac"),
        ohne_musik_json=opt(".ohne-musik.json"),
        sample_rate=sr,
        started_at=str(meta.get("startedAt", "")),
        channels=channels,
        tags=_ffprobe_tags(flac),
    )


def raw_path(work: str, ch: Channel) -> str:
    return os.path.join(work, f"c{ch.index + 1}.raw")


def decode(rec: Recording, work: str, seconds: tuple[float, float] | None = None, force=False) -> None:
    """Decode the multitrack FLAC into one `<work>/c<n>.raw` (f32 mono) per channel.
    `seconds=(a, b)` decodes only that span (for trying the pipeline on a piece)."""
    paths = [raw_path(work, c) for c in rec.channels]
    marker = os.path.join(work, "decode.json")
    want = {"flac": rec.flac, "seconds": list(seconds) if seconds else None}
    if not force and os.path.exists(marker) and all(os.path.exists(p) for p in paths):
        with open(marker) as f:
            if json.load(f) == want:
                return
    n = len(rec.channels)
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if seconds:
        cmd += ["-ss", f"{seconds[0]:.3f}", "-t", f"{seconds[1] - seconds[0]:.3f}"]
    cmd += ["-i", rec.flac, "-f", "f32le", "-acodec", "pcm_f32le", "-ar", str(SR), "-"]
    outs = [open(p, "wb") for p in paths]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    chunk = SR * 10 * n * 4  # 10 s
    try:
        while True:
            buf = proc.stdout.read(chunk)
            if not buf:
                break
            a = np.frombuffer(buf, dtype="<f4")
            a = a[: len(a) // n * n].reshape(-1, n)
            for k, f in enumerate(outs):
                f.write(np.ascontiguousarray(a[:, k]).tobytes())
    finally:
        for f in outs:
            f.close()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg failed decoding " + rec.flac)
    with open(marker, "w") as f:
        json.dump(want, f)


def channel(work: str, ch: Channel) -> np.ndarray:
    """Memory-mapped f32 samples of one decoded channel."""
    return np.memmap(raw_path(work, ch), dtype="<f4", mode="r")


def length(work: str, rec: Recording) -> int:
    return len(channel(work, rec.channels[0]))


def used_mics(rec: Recording, work: str, min_db=-65.0) -> list[Channel]:
    """The mics that carried a signal: a mic whose loudest second (95th
    percentile of 1 s RMS) stays under `min_db` dBFS was not in use."""
    out = []
    for m in rec.mics:
        x = channel(work, m)
        n = len(x) // SR
        if n == 0:
            continue
        lev = db((np.asarray(x[: n * SR], dtype=np.float64).reshape(n, SR) ** 2).mean(1))
        if np.percentile(lev, 95) > min_db:
            out.append(m)
    return out

"""Music in the recording: what the file player put out, when, and whether
it was a song (cut in the music-free versions) or a jingle (kept)."""
import json
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d

from . import SR
from .levels import FPS, FRAME, db, rms_level, runs

MUSIC_MIN_DB = -50.0  # the file player's output counts as playing above this
GAP_SEC = 2.0  # quieter stretches shorter than this stay inside one item
MIN_ITEM_SEC = 1.0


@dataclass
class Item:
    start: float  # seconds, recording time
    end: float
    kind: str  # song | jingle
    lufs: float | None = None

    @property
    def duration(self):
        return self.end - self.start


def find_items(music_l, music_r, jingle_max_sec=30.0, sidecar=None, offset=0.0) -> list[Item]:
    """Items from the music channels' level (100 ms frames). A song is an item
    longer than `jingle_max_sec`, or — when studiobox's `.ohne-musik.json`
    sidecar exists — an item that overlaps one of its `music` cuts (`offset`:
    where in the recording these channels start, for a decoded span)."""
    H = SR // 10
    n = min(len(music_l), len(music_r))
    lev = np.maximum(rms_level(music_l[:n], H), rms_level(music_r[:n], H))
    on = lev > MUSIC_MIN_DB
    g = int(GAP_SEC * 10)
    on = minimum_filter1d(maximum_filter1d(on.astype(np.uint8), g), g).astype(bool) | on
    items = []
    cuts = []
    if sidecar:
        try:
            with open(sidecar) as f:
                cuts = [(c["from"] - offset, c["to"] - offset) for c in json.load(f).get("cuts", []) if c.get("why") == "music"]
        except (OSError, ValueError, KeyError):
            cuts = []
    for a, b in runs(on):
        s, e = a / 10, b / 10
        if e - s < MIN_ITEM_SEC:
            continue
        if cuts:
            overlap = sum(max(0.0, min(e, y) - max(s, x)) for x, y in cuts)
            kind = "song" if overlap >= 0.5 * (e - s) else "jingle"
        else:
            kind = "song" if e - s > jingle_max_sec else "jingle"
        items.append(Item(round(s, 2), round(e, 2), kind))
    return items


def closed_frames(items: list[Item], anytalk: np.ndarray, kinds=("song",), edge_sec=1.0, gap_sec=1.5):
    """Mask (50 ms frames) of where the mics are closed: inside every item of
    the given kinds, except talk runs that continue into / out of the item
    across its start or end (announcing over the intro, talking over the end).
    `anytalk`: any mic is the talker, per frame."""
    F = len(anytalk)
    g = int(gap_sec * FPS)
    talk = minimum_filter1d(maximum_filter1d(anytalk.astype(np.uint8), g), g).astype(bool) | anytalk
    closed = np.zeros(F, bool)
    e = int(edge_sec * FPS)
    for it in items:
        if it.kind not in kinds:
            continue
        a, b = int(it.start * FPS), min(F, int(it.end * FPS))
        if b <= a:
            continue
        closed[a:b] = True
        for ra, rb in runs(talk[a:b]):
            if ra <= e or rb >= (b - a) - e:
                closed[a + ra : a + rb] = False
    return closed


def item_dict(it: Item):
    return dict(start=it.start, end=it.end, kind=it.kind, lufs=it.lufs)


ON_AIR_RESIDUAL_DB = -40.0  # a frame with this much of the mics in the programme …
ON_AIR_DENSITY = 0.2  # … in at least this share of a 5 s window: voices, not a stray noise


def on_air(prog_l, prog_r, music_l, music_r, items=None):
    """Per 50 ms frame: the mics were on air. The dry music channel is fitted
    to the programme with one gain per frame and channel (the live leveler
    and the duck are gains, which the fit absorbs); what remains is what the
    mics put on air. Only music on air leaves a residual under -70 dBFS,
    voices -15..-30 dBFS in most frames; a stray noise in a few frames does
    not count. Chatter into muted mics leaves nothing."""
    n = min(len(prog_l), len(prog_r), len(music_l), len(music_r)) // FRAME * FRAME
    res = None
    for p, m in ((prog_l, music_l), (prog_r, music_r)):
        out = []
        step = FRAME * 1200  # 1 min
        for a in range(0, n, step):
            b = min(a + step, n)
            pp = np.asarray(p[a:b], dtype=np.float64).reshape(-1, FRAME)
            mm = np.asarray(m[a:b], dtype=np.float64).reshape(-1, FRAME)
            g = np.clip((pp * mm).sum(1) / np.maximum((mm * mm).sum(1), 1e-9), 0, None)
            r = pp - g[:, None] * mm
            out.append(db((r**2).mean(1)))
        lev = np.concatenate(out) if out else np.zeros(0)
        res = lev if res is None else np.maximum(res, lev)
    air = res > ON_AIR_RESIDUAL_DB
    dense = uniform_filter1d(air.astype(np.float64), 5 * FPS, mode="constant") >= ON_AIR_DENSITY
    return maximum_filter1d((air & dense).astype(np.uint8), int(1.0 * FPS) * 2 + 1) > 0

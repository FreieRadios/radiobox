"""Filler cuts ("äh", "ähm") from CrisperWhisper's per-token timestamps.

Only the hesitation sounds are cut — never words. Dialect particles (fei,
gell, halt, …) are words and are not matched. Each cut is snapped to the
quietest 10 ms within 60 ms of the token's edges, between the neighbouring
tokens, and must stay 0.08–1.2 s long.
"""
import re

import numpy as np

from .levels import rms_level

FILL = re.compile(r"^\W*(\[UH\]|\[UM\]|äh|ähm|äm|öh|öhm|ähh|ähhm)\W*$", re.I)
MIN_SEC, MAX_SEC = 0.08, 1.2


def is_filler(token: str) -> bool:
    return bool(FILL.match(token.strip()))


def cuts_from_tokens(tokens, level_10ms):
    """`tokens`: [{w, s, e}] in recording seconds, sorted; `level_10ms`: dB per
    10 ms of the audio they were taken from. Returns [[from, to], …]."""
    lev = level_10ms

    def snap(t, lo, hi):
        a, b = int(max(lo, t - 0.06) * 100), int(min(hi, t + 0.06) * 100)
        b = min(b, len(lev) - 1)
        if b <= a:
            return t
        return (a + int(np.argmin(lev[a : b + 1]))) / 100

    cuts = []
    toks = sorted(tokens, key=lambda t: t["s"])
    for i, t in enumerate(toks):
        w = t["w"].strip()
        if not is_filler(w):
            continue
        s, e = t["s"], t["e"]
        if i + 1 < len(toks) and toks[i + 1]["w"].strip().strip(",.").lower() == "m" and w.lower().startswith("äh"):
            e = toks[i + 1]["e"]
            nxt = toks[i + 2] if i + 2 < len(toks) else None
        else:
            nxt = toks[i + 1] if i + 1 < len(toks) else None
        prv = toks[i - 1] if i > 0 else None
        if e - s > MAX_SEC or e - s < MIN_SEC:
            continue
        lo = prv["e"] if prv else s - 0.1
        hi = nxt["s"] if nxt else e + 0.1
        a = max(snap(s, lo, e - 0.05), lo)
        b = min(snap(e, s + 0.05, hi), hi)
        if b - a >= MIN_SEC:
            cuts.append([round(a, 3), round(b, 3)])
    # overlapping cuts merge
    out = []
    for a, b in sorted(cuts):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def levels_10ms(bus48k):
    return rms_level(bus48k, 480)

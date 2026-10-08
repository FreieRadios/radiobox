"""The rendered versions: the talk bus plus the music, leveled and ducked,
assembled along a timeline (cuts, dropped songs) and normalised to -16 LUFS.

  full   everything: talk, jingles, songs
  talk   the songs dropped (0.5 s pause instead), jingles kept — "ohne Musik, mit Jingles"
  words  songs and jingles dropped — "nur Wort"
"""
import numpy as np
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, minimum_filter1d

from . import SR
from .levels import FPS, integrated_lufs, runs
from .mix import TARGET, frames_to_samples
from .music import Item, closed_frames
from .timeline import CROSSFADE, Segment, Timeline, split_segment

MODES = {"full": ("song", "jingle"), "talk": ("jingle",), "words": ()}
DUCK_DB = -14.0
TARGET_LUFS = -16.0
PAUSE_SEC = 0.5


def level_items(music, items: list[Item], talk_lufs: float, log=print):
    """Gain per item (linear) that brings it to the talk loudness."""
    gains = {}
    for i, it in enumerate(items):
        a, b = int(it.start * SR), int(it.end * SR)
        lufs = integrated_lufs(music[a:b])
        if not np.isfinite(lufs):
            gains[i] = 1.0
            continue
        it.lufs = round(lufs, 1)
        gains[i] = float(10 ** ((talk_lufs - lufs) / 20))
        log(f"{it.kind} {it.start:.0f}-{it.end:.0f} s: {lufs:.1f} LUFS -> {talk_lufs - lufs:+.1f} dB")
    return gains


def music_bed(music, items, gains, kinds, act, T):
    """The music of the given kinds, leveled and ducked under talk (stereo)."""
    duck = np.where(act > 0, DUCK_DB, 0.0)
    duck = np.minimum(duck, np.roll(duck, -6))  # lead 300 ms
    duck = gaussian_filter1d(duck, 4)
    duck_s = frames_to_samples(duck, T)
    out = np.zeros((T, 2), np.float32)
    for i, it in enumerate(items):
        if it.kind not in kinds:
            continue
        a, b = int(it.start * SR), min(T, int(it.end * SR))
        out[a:b] = music[a:b] * (gains[i] * duck_s[a:b, None])
    return out


def _join(a, b, cf):
    w = np.linspace(0, 1, cf, dtype=np.float32)[:, None]
    mid = a[-cf:] * (1 - w) + b[:cf] * w
    return np.concatenate([a[:-cf], mid, b[cf:]])


def assemble(prog, segments: list[Segment], cuts, cf=CROSSFADE):
    """Stereo audio of the segments, cuts crossfaded, fades and pauses applied."""
    CF = int(cf * SR)
    parts = []
    for seg in segments:
        subs = split_segment(seg, cuts, cf)
        y = None
        for a, b in subs:
            x = prog[int(round(a * SR)) : int(round(b * SR))]
            y = x if y is None else _join(y, x, CF)
        y = np.array(y, dtype=np.float32)
        fi, fo = int(seg.fade_in * SR), int(seg.fade_out * SR)
        if fi:
            y[:fi] *= np.linspace(0, 1, fi, dtype=np.float32)[:, None]
        if fo:
            y[-fo:] *= np.linspace(1, 0, fo, dtype=np.float32)[:, None]
        if seg.pause_before:
            parts.append(np.zeros((int(seg.pause_before * SR), 2), np.float32))
        parts.append(y)
    return np.concatenate(parts) if parts else np.zeros((0, 2), np.float32)


def plan_segments(mode, items, anytalk, music_on, T, lead=0.5, tail=1.5, show_talk=None):
    """Kept segments of the recording for a mode: from the first signal to the
    end of the show, with every dropped item (song; in `words` also jingle)
    taken out between the talk before and after it. `show_talk`: the talk
    that was on air (default: all of it) — decides where the show ends."""
    kinds = MODES[mode]
    F = len(anytalk)
    drop_kinds = tuple(k for k in ("song", "jingle") if k not in kinds)
    closed = closed_frames(items, anytalk, kinds=drop_kinds) if drop_kinds else np.zeros(F, bool)
    sig = anytalk.copy()
    for it in items:
        if it.kind in kinds:
            sig[int(it.start * FPS) : int(it.end * FPS)] = True
    sig &= ~closed
    on = np.flatnonzero(sig)
    if not len(on):
        return [], closed
    start = max(0.0, on[0] / FPS - lead)
    end = min(T / SR, show_end(items, anytalk if show_talk is None else show_talk, T / SR) + tail)
    # talk runs with gaps closed, to find the last word before / first after a drop
    g = int(1.5 * FPS)
    talk = minimum_filter1d(maximum_filter1d(anytalk.astype(np.uint8), g), g).astype(bool) | anytalk
    talk_runs = [(a / FPS, b / FPS) for a, b in runs(talk)]
    segs = []
    at = start
    first = True
    for ca, cb in runs(closed):
        ca, cb = ca / FPS, cb / FPS
        if cb <= start or ca >= end:
            continue
        before = [b for a, b in talk_runs if b <= ca + 0.05]
        after = [a for a, b in talk_runs if a >= cb - 0.05]
        d_from = max(ca - 3.0, before[-1] + 0.3) if before else ca
        d_to = min(cb + 3.0, after[0] - 0.5) if after else cb
        d_from, d_to = min(d_from, ca), max(d_to, cb)
        if d_from > at + 0.1:
            segs.append(Segment(at, d_from, fade_in=0.01 if first else 0.1, fade_out=0.2, pause_before=0.0 if first else PAUSE_SEC))
            first = False
        at = d_to
    if end > at + 0.1:
        segs.append(Segment(at, end, fade_in=0.01 if first else 0.1, fade_out=0.3, pause_before=0.0 if first else PAUSE_SEC))
    return segs, closed


def show_end(items, anytalk, total):
    """Where the show ends: with the first jingle after the last talk (the
    outro) — music the file player put out after that, while the recording
    still ran, is not part of the show. Without such a jingle: after the last
    talk or music item, whichever is later."""
    # talk the room speakers trigger during a song does not count
    talk = np.flatnonzero(anytalk & ~closed_frames(items, anytalk, kinds=("song",)))
    last_talk = (talk[-1] + 1) / FPS if len(talk) else 0.0
    after = [it for it in items if it.kind == "jingle" and it.start >= last_talk]
    if after:
        return min(total, after[0].end)
    return min(total, max([last_talk] + [it.end for it in items]))


def render(mode, bus, act, music, items, gains, anytalk, music_on, cuts, log=print, show_talk=None):
    """Returns (stereo f32 at -16 LUFS, Timeline, closed-frames mask)."""
    T = len(bus)
    kinds = MODES[mode]
    prog = np.repeat(bus[:, None], 2, 1)
    if kinds:
        prog += music_bed(music, items, gains, kinds, act, T)
    segments, closed = plan_segments(mode, items, anytalk, music_on, T, show_talk=show_talk)
    if not segments:
        raise RuntimeError(f"{mode}: nothing to keep")
    tl = Timeline.build(segments, cuts)
    audio = assemble(prog, segments, cuts)
    lufs = integrated_lufs(audio)
    gain = 10 ** ((TARGET_LUFS - lufs) / 20) if np.isfinite(lufs) else 1.0
    audio = (audio * gain).astype(np.float32)
    log(f"{mode}: {len(audio) / SR / 60:.1f} min, {len(segments)} segments, {lufs:.1f} LUFS -> {TARGET_LUFS - lufs:+.1f} dB")
    return audio, tl, closed

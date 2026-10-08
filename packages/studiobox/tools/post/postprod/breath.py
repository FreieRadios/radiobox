"""Acoustic breath detection per mic on the dry tracks (10 ms frames).

A breath: 0.22–0.9 s without voicing, clearly above the floor, 10..40 dB
under that speaker's voice, while that mic's person is the talker (own
voiced speech within 1.5 s). Output per mic: a gain envelope in dB that is
-10 dB on every breath (50 ms ramps), and the list of breaths.
"""
import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
from scipy.signal import resample_poly

from . import SR
from .levels import db, highpass

H = 480  # 10 ms
DEPTH_DB = -10.0


def voicing(y8k, F):
    """Normalised autocorrelation peak in 70..400 Hz per 10 ms (8 kHz input)."""
    N, hop = 320, 80
    nf = max(0, (len(y8k) - N) // hop)
    v = np.zeros(F)
    for a in range(0, nf, 20000):
        b = min(nf, a + 20000)
        idx = np.arange(a, b)[:, None] * hop + np.arange(N)[None, :]
        fr = y8k[idx] * np.hanning(N)
        sp = np.fft.rfft(fr, 2 * N)
        ac = np.fft.irfft(np.abs(sp) ** 2)[:, :N]
        r = ac[:, 20:115].max(1) / np.maximum(ac[:, 0], 1e-20)
        v[a : min(b, F)] = r[: max(0, min(b, F) - a)]
    return v


def detect(mic: np.ndarray, talker_frames: np.ndarray):
    """`talker_frames`: bool per 50 ms frame, this mic's person talks.
    Returns (envelope dB per 10 ms, breaths [(start s, end s, depth dB)])."""
    x = highpass(mic).astype(np.float64)
    F = len(x) // H
    lev = db((x[: F * H].reshape(F, H) ** 2).mean(1))
    voiced = voicing(resample_poly(x, 1, 6), F)
    floor = minimum_filter1d(uniform_filter1d(lev, 20), 3000) + 3
    v = (voiced > 0.5) & (lev > floor + 12)
    talker = np.repeat(talker_frames, 5)[:F]
    talker = np.pad(talker, (0, F - len(talker)))
    own = v & talker
    lv = np.where(own, lev, np.nan)
    sp = np.full(F, np.nan)
    for a in range(0, F, 500):
        s = lv[max(0, a - 2000) : a + 2000]
        if np.isfinite(s).sum() > 50:
            sp[a : a + 500] = np.nanmedian(s)
    overall = np.nanmedian(lv) if np.isfinite(lv).any() else -40.0
    sp = np.nan_to_num(sp, nan=overall)
    near = maximum_filter1d(own.astype(np.uint8), 301) > 0
    unv = ~(voiced > 0.45)
    cand = unv & near & (lev > floor + 6) & (lev < sp - 10) & (lev > sp - 40)
    c = maximum_filter1d(minimum_filter1d(cand.astype(np.uint8), 3), 3).astype(bool) & cand | cand
    env = np.zeros(F, np.float32)
    breaths = []
    for i, j in _runs(c):
        if 22 <= j - i <= 90:
            env[i + 3 : j - 3] = DEPTH_DB
            breaths.append((i / 100, j / 100, float(np.median(lev[i:j] - sp[i:j]))))
    env = uniform_filter1d(env, 5)
    return env, breaths


def _runs(mask):
    from .levels import runs

    return runs(mask)


def envelope_to_samples(env_db: np.ndarray, T: int) -> np.ndarray:
    """Linear gain per sample from the 10 ms envelope."""
    t10 = (np.arange(len(env_db)) + 0.5) * H
    return (10 ** (np.interp(np.arange(T), t10, env_db.astype(np.float64)) / 20)).astype(np.float32)

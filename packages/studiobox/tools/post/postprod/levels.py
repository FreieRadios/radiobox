"""Shared level helpers (dB, K-weighted frame levels, noise floors)."""
import numpy as np
from scipy.signal import butter, lfilter, sosfilt

from . import SR

FRAME = 2400  # 50 ms frames at 48 kHz, the hop of the talker labels
FPS = SR // FRAME  # frames per second (20)


def db(x):
    return 10 * np.log10(np.asarray(x, dtype=np.float64) + 1e-12)


def highpass(x, hz=80.0):
    sos = butter(2, hz, btype="high", fs=SR, output="sos")
    return sosfilt(sos, np.asarray(x, dtype=np.float32)).astype(np.float32)


_K_FILTERS = None


def _k_filters():
    global _K_FILTERS
    if _K_FILTERS is None:
        import pyloudnorm as pyln

        _K_FILTERS = [(f.b, f.a) for f in pyln.Meter(SR)._filters.values()]
    return _K_FILTERS


def k_level(x, frame=FRAME):
    """K-weighted (BS.1770) mean-square level per frame, dB."""
    y = np.asarray(x, dtype=np.float64)
    for b, a in _k_filters():
        y = lfilter(b, a, y)
    n = len(y) // frame
    return db((y[: n * frame].reshape(n, frame) ** 2).mean(1))


def rms_level(x, frame):
    """Plain mean-square level per frame, dB."""
    y = np.asarray(x, dtype=np.float64)
    n = len(y) // frame
    return db((y[: n * frame].reshape(n, frame) ** 2).mean(1))


def noise_floor(lev, win=600, hop=20):
    """10th percentile of the level over a sliding window of `win` frames
    (30 s at 50 ms), evaluated every `hop` frames."""
    n = len(lev)
    out = np.empty(n)
    for i in range(0, n, hop):
        a, b = max(0, i - win // 2), min(n, i + win // 2)
        out[i : i + hop] = np.percentile(lev[a:b], 10) if b > a else -120.0
    return out


def integrated_lufs(stereo):
    import pyloudnorm as pyln

    x = np.asarray(stereo, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    return float(pyln.Meter(SR).integrated_loudness(x))


def runs(mask):
    """[(start, end)) index pairs of the True runs of a boolean array."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate([[0], m.astype(np.int8), [0]]))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))

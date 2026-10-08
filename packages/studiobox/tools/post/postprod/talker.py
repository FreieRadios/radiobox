"""Who talks, per 50 ms frame, from arrival time on the dry mics.

Same idea as studiobox's live `dsp/arrival.ts`: for every pair of mics the
GCC-PHAT lag (150 Hz – 4 kHz, 100 ms window); the talker is the mic that is
clearly over its noise floor and leads every other mic with signal by more
than `LEAD` samples (zero-lag crosstalk never leads). -1 = nobody.

Output `talker.npz`: `cls` (talker index per frame, into the list of used
mics, -1 = none), `lev` (band level per frame and mic, dB), `names`.
"""
import numpy as np
from scipy.signal import butter, sosfilt

from . import SR
from .levels import FRAME, db, noise_floor

WIN = 2 * FRAME  # 100 ms analysis window
MAX_LAG = 240  # ±5 ms
LEAD = 60  # 1.25 ms: a talker leads the other mics by at least this
SNR_DB = 10  # the talker is this much over its floor …
OTHER_SNR_DB = 6  # … and compared only with mics that carry a signal


def gcc_phat(mics: list[np.ndarray], progress=None):
    """Per frame: band level per mic and, per mic pair (i<j), the lag (samples,
    negative = i leads) and the PHAT peak height."""
    sos = butter(4, [150, 4000], btype="band", fs=SR, output="sos")
    T = len(mics[0])
    F = max(0, (T - WIN) // FRAME)
    n = len(mics)
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    lev = np.zeros((F, n))
    lag = np.zeros((F, len(pairs)))
    pk = np.zeros((F, len(pairs)))
    win = np.hanning(WIN)
    CH = SR * 60
    for c0 in range(0, T, CH):
        f0, f1 = c0 // FRAME, min(F, (c0 + CH) // FRAME)
        if f1 <= f0:
            break
        seg = [sosfilt(sos, np.asarray(m[c0 : c0 + CH + WIN], dtype=np.float64)) for m in mics]
        idx = (np.arange(f0, f1) - f0)[:, None] * FRAME + np.arange(WIN)[None, :]
        frames = [s[idx] for s in seg]  # (frames, WIN)
        for i, fr in enumerate(frames):
            lev[f0:f1, i] = db((fr**2).mean(1))
        X = [np.fft.rfft(fr * win, 2 * WIN) for fr in frames]
        for p, (i, j) in enumerate(pairs):
            G = X[i] * np.conj(X[j])
            G /= np.abs(G) + 1e-12
            r = np.fft.irfft(G)
            r = np.concatenate([r[:, -MAX_LAG:], r[:, : MAX_LAG + 1]], 1)
            k = r.argmax(1)
            lag[f0:f1, p] = k - MAX_LAG
            pk[f0:f1, p] = r[np.arange(len(k)), k]
        if progress:
            progress(min(f1 * FRAME, T) / T)
    return lev, lag, pk, pairs


def classify(lev, lag, pairs):
    """Talker per frame: over its floor by SNR_DB and leading every other mic
    with signal by LEAD samples; -1 where no mic qualifies."""
    F, n = lev.shape
    floor = np.stack([noise_floor(lev[:, k]) for k in range(n)], 1)
    over = lev - floor
    # lead[k, j]: mic k leads mic j (frames,)
    leads = np.zeros((F, n, n), bool)
    for p, (i, j) in enumerate(pairs):
        leads[:, i, j] = lag[:, p] < -LEAD
        leads[:, j, i] = lag[:, p] > LEAD
    cls = np.full(F, -1)
    for k in range(n):
        ok = over[:, k] > SNR_DB
        for j in range(n):
            if j == k:
                continue
            # a quiet mic is not in the race
            ok &= leads[:, k, j] | (over[:, j] <= OTHER_SNR_DB)
        cls[ok & (cls < 0)] = k
    return cls, floor


def label(mics: list[np.ndarray], progress=None):
    lev, lag, pk, pairs = gcc_phat(mics, progress)
    cls, floor = classify(lev, lag, pairs)
    return dict(cls=cls, lev=lev, floor=floor, lag=lag, pk=pk)

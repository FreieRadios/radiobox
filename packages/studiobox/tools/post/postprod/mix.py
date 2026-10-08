"""The talk bus: per-mic leveler, expander, compressor, breath reduction and a
non-causal gain-sharing automix of the dry mics, with the mics closed while a
song plays (except talk that runs into or out of it).

Offline it can look ahead and back as far as it likes: the leveler averages
each talker's own frames with a Gaussian window (2 s fast, 30 s slow) and
three passes correct every talker's loudness as measured on the bus.
"""
import numpy as np
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, uniform_filter1d

from . import SR
from .levels import FPS, FRAME, db, highpass, k_level, noise_floor

TARGET = -26.0  # talker frame level (dB, K-weighted, 50 ms) after leveling
BL = 120  # 2.5 ms blocks for the compressor and the automix


def leveler_gain(levk, talk, sigma_fast=2.0, sigma_slow=30.0, lo=-12, hi=30):
    """Gain (dB per frame) that brings the talker frames to TARGET: a
    non-causal Gaussian average of the talker-frame levels; where few talker
    frames are near, it leans on the slow estimate."""
    w = talk.astype(np.float64)
    x = np.where(talk, levk, 0.0)
    num_f = gaussian_filter1d(x, sigma_fast * FPS, mode="nearest")
    den_f = gaussian_filter1d(w, sigma_fast * FPS, mode="nearest")
    num_s = gaussian_filter1d(x, sigma_slow * FPS, mode="nearest")
    den_s = gaussian_filter1d(w, sigma_slow * FPS, mode="nearest")
    slow = num_s / np.maximum(den_s, 1e-9)
    k0 = FPS / (np.sqrt(2 * np.pi) * sigma_fast * FPS)
    fast = num_f / np.maximum(den_f, 1e-9)
    a = den_f / (den_f + k0 * 0.5)
    est = a * fast + (1 - a) * slow
    est = np.where(den_s > 1e-6, est, TARGET)
    return np.clip(TARGET - est, lo, hi), est


def compress(x, thr=-20.0, ratio=3.0, att=0.005, rel=0.150, look=0.004):
    """Feed-forward RMS compressor with look-ahead, gain per 2.5 ms block."""
    NB = len(x) // BL
    p = (x[: NB * BL].reshape(NB, BL).astype(np.float64) ** 2).mean(1)
    gr = -np.maximum(db(p) - thr, 0) * (1 - 1 / ratio)
    aa = np.exp(-BL / SR / att)
    ar = np.exp(-BL / SR / rel)
    out = np.empty(NB)
    s = 0.0
    for i in range(NB):
        v = gr[i]
        s = aa * s + (1 - aa) * v if v < s else ar * s + (1 - ar) * v
        out[i] = s
    sh = int(look * SR / BL)
    out = np.concatenate([out[sh:], np.zeros(sh)])
    tb = (np.arange(NB) + 0.5) * BL
    return x * (10 ** (np.interp(np.arange(len(x)), tb, out) / 20)).astype(np.float32)


def frames_to_samples(gdb, T):
    t_fr = (np.arange(len(gdb)) + 0.5) * FRAME
    return (10 ** (np.interp(np.arange(T), t_fr, gdb) / 20)).astype(np.float32)


class Mixer:
    def __init__(self, mics, cls, open_frames, breath_env=None, log=print):
        """`mics`: raw dry tracks (same length); `cls`: talker per 50 ms frame;
        `open_frames`: bool per frame, mics open; `breath_env`: per mic gain
        per sample (linear) or None."""
        self.log = log
        self.mics = [highpass(m) for m in mics]
        self.T = T = len(self.mics[0])
        self.NF = NF = T // FRAME
        self.cls = np.concatenate([cls, np.full(max(0, NF - len(cls)), -1)])[:NF]
        self.open = np.concatenate([open_frames, np.zeros(max(0, NF - len(open_frames)), bool)])[:NF]
        self.breath = breath_env
        self.lev = np.stack([k_level(m)[:NF] for m in self.mics], 1)
        n = len(mics)
        self.floor = np.stack([noise_floor(self.lev[:, k]) for k in range(n)], 1)
        # talk: this mic's talker frames, clearly over the floor
        self.talks = [(self.cls == k) & (self.lev[:, k] > self.floor[:, k] + 8) for k in range(n)]
        self.gains = []
        for k in range(n):
            talk = self.talks[k] & self.open & (self.lev[:, k] > self.floor[:, k] + 10)
            g, _ = leveler_gain(self.lev[:, k], talk)
            self.gains.append(g)
            if talk.any():
                log(f"mic {k}: {talk.sum() / FPS:.0f} s of talk, gain p5/p95 {np.percentile(g[talk], 5):.1f}/{np.percentile(g[talk], 95):.1f} dB")
            else:
                log(f"mic {k}: no talk found")
        NB = T // BL
        ob = np.repeat(self.open.astype(np.float64), FRAME // BL)[:NB]
        ob = np.concatenate([ob, np.zeros(NB - len(ob))])
        self.open_blocks = uniform_filter1d(ob, 12)  # 30 ms ramps
        self.tb = (np.arange(NB) + 0.5) * BL
        self.NB = NB
        self.leveled = None

    def expander(self, k, g):
        """-15 dB unless this mic carries talk (its talker, or loud); opens
        150 ms early and holds 500 ms."""
        a = self.talks[k] | (self.lev[:, k] + g > TARGET - 10)
        a = maximum_filter1d(a.astype(np.float64), 1 + 3 + 10, origin=(10 - 3) // 2)
        return gaussian_filter1d(np.where(a > 0, 0.0, -15.0), 1.5)

    def _leveled(self):
        out = []
        for k, m in enumerate(self.mics):
            y = m * frames_to_samples(self.gains[k] + self.expander(k, self.gains[k]), self.T)
            if self.breath is not None and self.breath[k] is not None:
                y *= self.breath[k]
            out.append(compress(y))
        return out

    def mix(self):
        leveled = self._leveled()
        NB, BL_ = self.NB, BL
        P = np.stack([(y[: NB * BL_].reshape(NB, BL_).astype(np.float64) ** 2).mean(1) for y in leveled], 1)
        P = uniform_filter1d(P, 8, axis=0)
        share = P / (P.sum(1, keepdims=True) + 1e-12)
        pre, hold = 12, 120  # open 30 ms early, hold 300 ms
        share = maximum_filter1d(share, pre + hold + 1, axis=0, origin=(hold - pre) // 2)
        share = np.minimum(uniform_filter1d(share, 8, axis=0), 1.0)
        bus = np.zeros(self.T, np.float32)
        t_s = np.arange(self.T)
        for k in range(len(leveled)):
            bus += leveled[k] * np.interp(t_s, self.tb, share[:, k] * self.open_blocks).astype(np.float32)
        self.leveled = leveled
        return bus

    def run(self, passes=3):
        """Mix, then correct each talker's loudness as measured on the bus."""
        for it in range(passes):
            bus = self.mix()
            blev = k_level(bus)[: self.NF]
            devs = []
            for k in range(len(self.mics)):
                sel = self.talks[k] & self.open & (blev > TARGET - 15)
                g, _ = leveler_gain(blev, sel, sigma_fast=6.0, sigma_slow=40.0, lo=-12, hi=12)
                devs.append(float(np.abs(g[sel]).mean()) if sel.any() else 0.0)
                self.gains[k] = self.gains[k] + g
            self.log(f"pass {it}: mean |deviation| per mic {np.round(devs, 2).tolist()} dB")
        bus = self.mix()
        blev = k_level(bus)[: self.NF]
        act = (blev > TARGET - 22) & self.open
        act = maximum_filter1d(act.astype(np.float64), 1 + 2 + 8, origin=(8 - 2) // 2) > 0  # 100 ms early, 400 ms hold
        return bus, act

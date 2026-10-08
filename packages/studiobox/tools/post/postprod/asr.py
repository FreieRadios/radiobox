"""Speech recognition with faster-whisper.

Two passes: large-v3-turbo per speaker on that person's gated mic (words
with probabilities, vocabulary as hotwords), and CrisperWhisper per token on
the talk bus for the filler cuts (it transcribes "äh" verbatim and times
every token; slow, ~0.25x real time on 8 cores).

The audio is decoded with ffmpeg into a numpy array — faster-whisper's own
PyAV decoding breaks on some machines.
"""
import json
import os
import subprocess
import time

import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d, uniform_filter1d
from scipy.signal import resample_poly

from . import SR
from .levels import FPS, FRAME

TURBO = "large-v3-turbo"
CRISPER = "nyrahealth/faster_CrisperWhisper"


def to_16k(x48: np.ndarray) -> np.ndarray:
    return resample_poly(np.asarray(x48, dtype=np.float32), 1, 3).astype(np.float32)


def load_vocab(paths):
    """One term per line, '#' comments; order kept, duplicates dropped."""
    terms = []
    for p in paths:
        with open(p) as f:
            terms += [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    return list(dict.fromkeys(terms))


def gated_track(leveled_mic: np.ndarray, talk_frames: np.ndarray, hold_sec=0.4) -> np.ndarray:
    """This speaker's leveled mic, silent where the person is not the talker
    (with `hold_sec` around every talk frame), at 16 kHz."""
    T = len(leveled_mic)
    g = int(hold_sec * FPS)
    m = maximum_filter1d(talk_frames.astype(np.uint8), 2 * g + 1) > 0
    gain = np.repeat(m.astype(np.float32), FRAME)[:T]
    gain = np.concatenate([gain, np.zeros(T - len(gain), np.float32)])
    gain = uniform_filter1d(gain, int(0.05 * SR))  # 50 ms ramps
    return to_16k(leveled_mic * gain)


_models = {}


def model(name, threads):
    from faster_whisper import WhisperModel

    key = (name, threads)
    if key not in _models:
        _models[key] = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    return _models[key]


def transcribe_words(audio16k, name=TURBO, hotwords=None, prompt=None, threads=8, vad=True, beam=5, log=print):
    """Words [{w, s, e, p}] (seconds in the audio) and the segment texts."""
    t0 = time.time()
    m = model(name, threads)
    segs, _info = m.transcribe(
        audio16k,
        language="de",
        word_timestamps=True,
        beam_size=beam,
        vad_filter=vad,
        condition_on_previous_text=False,
        initial_prompt=prompt,
        hotwords=hotwords,
    )
    words, lines = [], []
    for s in segs:
        lines.append(f"[{s.start:8.2f}] {s.text.strip()}")
        for w in s.words or []:
            words.append({"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3), "p": round(w.probability, 3)})
    log(f"{name}: {len(audio16k) / 16000 / 60:.1f} min in {time.time() - t0:.0f} s, {len(words)} words")
    return words, lines


def transcribe_tokens(audio16k, threads=8, beam=1, log=print):
    """CrisperWhisper per token: its tokenizer has no leading-space words, so
    every token gets its own time (needed for usable filler timestamps)."""
    from faster_whisper.tokenizer import Tokenizer

    Tokenizer.split_to_word_tokens = Tokenizer.split_tokens_on_unicode
    return transcribe_words(audio16k, name=CRISPER, threads=threads, vad=False, beam=beam, log=log)


def chunks_for_tokens(talk_frames, min_gap_sec=20.0, pad_sec=1.0):
    """Stretches of the recording (seconds) with talk (gaps under
    `min_gap_sec` bridged), so the slow token pass skips music and silence."""
    from .levels import runs

    open_frames = talk_frames

    g = int(min_gap_sec * FPS)
    o = minimum_filter1d(maximum_filter1d(open_frames.astype(np.uint8), g), g).astype(bool) | open_frames
    F = len(open_frames)
    return [(max(0.0, a / FPS - pad_sec), min(F / FPS, b / FPS + pad_sec)) for a, b in runs(o)]


def write_wav16(path, audio16k):
    import wave

    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes((np.clip(audio16k, -1, 1) * 32767).astype("<i2").tobytes())

"""The per-speaker transcript, merged by time, in a rendered version's time.

Every speaker was transcribed from their own mic, so what the other voices
left on it (bleed) must go: a word whose speaker hardly talks in that moment
(by the arrival-time labels) while someone else says the same word at the
same time is the other voice. Short fragments the audio hardly attributes to
that person go too. Uncertain words (probability under LOW) are marked
[? … ?] and listed for proofreading.
"""
import re
from collections import Counter

import numpy as np

from .levels import FPS
from .timeline import Timeline

LOW = 0.5
GAP_SEC = 1.0  # words of one speaker closer than this form one utterance


def norm(t):
    return re.sub(r"[^a-zäöüß0-9]", "", t.lower())


def hms(x, ms=False):
    h, r = divmod(max(0.0, x), 3600)
    m, s = divmod(r, 60)
    if ms:
        return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"
    return f"{int(h)}:{int(m):02d}:{int(s):02d}" if h else f"{int(m):02d}:{int(s):02d}"


class Utterance:
    __slots__ = ("start", "end", "speaker", "words", "text", "marked")

    def __init__(self, start, end, speaker, words):
        self.start, self.end, self.speaker, self.words = start, end, speaker, words
        self.text = self.marked = ""


def build(words_by_speaker, cls, open_frames, speakers, log=print):
    """`words_by_speaker`: {name: [{w,s,e,p}]} in recording seconds;
    `speakers`: {name: talker index in cls}. Returns utterances and the
    review list [(time, speaker, text)]."""
    F = len(cls)

    def share(name, a, b):
        c = cls[max(0, int(a * FPS)) : max(0, min(F, int(b * FPS)))]
        c = c[c >= 0]
        return float((c == speakers[name]).mean()) if len(c) else 0.0

    def is_open(s, e):
        a, b = max(0, int(s * FPS)), max(0, min(F, int(e * FPS)) + 1)
        return bool(open_frames[a:b].any()) if b > a else False

    allw = {}
    for name, ws in words_by_speaker.items():
        allw[name] = [
            (w["s"], w["e"], w["w"], w.get("p", 1.0))
            for w in ws
            if is_open(w["s"], w["e"]) and "Untertitelung" not in w["w"] and w["w"].strip()
        ]
    index = {n: [(s, norm(t)) for s, e, t, p in ws] for n, ws in allw.items()}
    removed = 0
    for name, ws in allw.items():
        kept = []
        for s, e, t, p in ws:
            k = norm(t)
            if k and share(name, s - 0.25, e + 0.25) < 0.3 and any(
                abs(s2 - s) < 1.0 and k2 == k for o in allw if o != name for s2, k2 in index[o]
            ):
                removed += 1
                continue
            kept.append((s, e, t, p))
        allw[name] = kept
    log(f"transcript: {removed} bleed words removed")
    utts = []
    for name, ws in allw.items():
        cur = None
        for s, e, t, p in ws:
            if cur and s - cur.end < GAP_SEC:
                cur.end = e
                cur.words.append((t, p, s))
            else:
                if cur:
                    utts.append(cur)
                cur = Utterance(s, e, name, [(t, p, s)])
        if cur:
            utts.append(cur)

    def garbled(u):
        n = len(u.words)
        if n > 8:
            return False
        mean_p = sum(p for _, p, _ in u.words) / n
        sh = share(u.speaker, u.start - 0.3, u.end + 0.3)
        if mean_p < 0.55 or sh < 0.15:
            return True
        return sh < 0.4 and (mean_p < 0.85 or n < 2)

    dropped = [u for u in utts if garbled(u)]
    utts = [u for u in utts if not garbled(u)]
    log(f"transcript: {len(dropped)} garbled fragments dropped")
    review = []
    for u in utts:
        u.text = re.sub(r"\s+", " ", "".join(t for t, _, _ in u.words)).strip()
        out, run, at = [], [], None
        for t, p, s in u.words + [("", 1.0, None)]:
            if p < LOW and t.strip():
                if not run:
                    at = s
                run.append(t)
                continue
            if run:
                txt = "".join(run).strip()
                out.append(" [? " + txt + " ?]")
                if len(txt.split()) >= 2 or len(re.sub(r"\W", "", txt)) >= 5:
                    review.append((at, u.speaker, txt))
                run = []
            out.append(t)
        u.marked = re.sub(r"\s+", " ", "".join(out)).strip()
    utts = [u for u in utts if u.text]
    dropped_lines = [f"{u.start:8.1f} {u.speaker:9s} p={sum(p for _, p, _ in u.words) / len(u.words):.2f}  {''.join(t for t, _, _ in u.words).strip()}" for u in dropped]
    return sorted(utts, key=lambda u: u.start), sorted(review), dropped_lines


def apply_fixes(utts, review, fixes):
    for a, b in fixes:
        for u in utts:
            u.text = u.text.replace(a, b)
            u.marked = u.marked.replace(a, b)
        review[:] = [(t, s, x.replace(a, b)) for t, s, x in review]


def rows_for(utts, items, labels, tl: Timeline):
    """Transcript rows (out_start, out_end, speaker|None, text, marked) in the
    version's time: utterances and the music/jingle marks that are in it."""
    rows = []
    for u in utts:
        if not tl.kept(u.start, u.end):
            continue
        rows.append((tl.to_out(u.start), tl.to_out(u.end), u.speaker, u.text, u.marked))
    for i, it in enumerate(items):
        if not tl.kept(it.start, it.end):
            continue
        name = labels.get(i + 1)
        kind = "Musik" if it.kind == "song" else "Jingle"
        text = f"[{kind}: {name}]" if name else f"[{kind}]"
        rows.append((tl.to_out(it.start), tl.to_out(it.end), None, text, text))
    return sorted(rows, key=lambda r: r[0])


def write(rows, review, tl: Timeline, out_base: str, header: str, intro: str):
    md = out_base + ".md"
    with open(md, "w") as f:
        f.write(f"# {header}\n\n{intro}\n\n")
        f.write("Unsichere Stellen (Wortwahrscheinlichkeit unter 50 %) sind mit [? … ?] markiert; die Liste am Ende führt sie mit Zeit auf.\n")
        cur = None
        for a, b, sp, text, marked in rows:
            if sp is None:
                f.write(f"\n\n**[{hms(a)}]** {text}\n")
                cur = None
                continue
            if sp != cur:
                f.write(f"\n\n**{sp}** [{hms(a)}]: ")
                cur = sp
            else:
                f.write(" ")
            f.write(marked)
        f.write("\n\n## Zum Gegenlesen\n\n")
        if not review:
            f.write("(keine)\n")
        for at, sp, txt in review:
            f.write(f"- [{hms(tl.to_out(at))}] {sp}: „{txt}“\n")
    with open(md) as f:
        text = f.read()
    with open(out_base + ".txt", "w") as f:
        f.write(re.sub(r"\*\*|^## ", "", re.sub(r"^# ", "", text, flags=re.M), flags=re.M))
    with open(out_base + ".vtt", "w") as f:
        f.write("WEBVTT\n\n")
        for a, b, sp, text, marked in rows:
            for s0, s1, part in split_cue(a, b, text):
                f.write(f"{hms(s0, True)} --> {hms(s1, True)}\n" + (f"<v {sp}>{part}" if sp else part) + "\n\n")


def split_cue(a, b, text, max_chars=90):
    """Cues of at most ~`max_chars`, split at word boundaries, times spread evenly."""
    words = text.split(" ")
    n = max(1, -(-len(text) // max_chars))
    per = -(-len(words) // n)
    out = []
    for k in range(n):
        part = " ".join(words[k * per : (k + 1) * per])
        if part:
            out.append((a + (b - a) * k / n, a + (b - a) * (k + 1) / n, part))
    return out


def plain(rows):
    """`Name [mm:ss]: text` per row, for the summary model."""
    lines = []
    for a, b, sp, text, marked in rows:
        lines.append(f"[{hms(a)}] {text}" if sp is None else f"{sp} [{hms(a)}]: {text}")
    return "\n\n".join(lines) + "\n"


def stats(rows, review):
    c = Counter(r[2] for r in rows if r[2])
    words = sum(len(r[3].split()) for r in rows if r[2])
    return f"{len(rows)} rows, {words} words, {dict(c)}, {len(review)} uncertain passages"

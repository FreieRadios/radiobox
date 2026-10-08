"""Where a moment of the recording ends up in a rendered version.

A version is a row of kept pieces of the recording (seconds), with short
crossfades where a filler was cut out and a pause plus fades where a song was
dropped. The same piece list drives the audio assembly and the transcript
times, so both agree to the sample.
"""
import bisect
import json
from dataclasses import asdict, dataclass, field

CROSSFADE = 0.015  # s, at a cut inside a segment


@dataclass
class Segment:
    """A continuous stretch of the recording that stays, with what happens at
    its edges. `cuts` inside it are joined with crossfades."""
    start: float
    end: float
    fade_in: float = 0.01
    fade_out: float = 0.3
    pause_before: float = 0.0


@dataclass
class Piece:
    src_a: float
    src_b: float
    out_a: float
    out_b: float


def split_segment(seg: Segment, cuts, cf=CROSSFADE):
    """The sub-pieces [(a, b), …] of a segment after taking out the cuts that
    fall inside it (a cut too close to the edge or to the previous cut is
    skipped, so every crossfade has room)."""
    pieces = []
    at = seg.start
    for a, b in sorted(cuts):
        if b <= seg.start or a >= seg.end or a < at + cf:
            continue
        b = min(b, seg.end - cf)
        if b <= a:
            continue
        pieces.append((at, a))
        at = b
    pieces.append((at, seg.end))
    return pieces


class Timeline:
    def __init__(self, pieces: list[Piece], length: float):
        self.pieces = pieces
        self.length = length
        self._src = [p.src_a for p in pieces]

    @classmethod
    def build(cls, segments: list[Segment], cuts, cf=CROSSFADE):
        pieces = []
        pos = 0.0
        for seg in segments:
            pos += seg.pause_before
            subs = split_segment(seg, cuts, cf)
            for i, (a, b) in enumerate(subs):
                pieces.append(Piece(a, b, pos, pos + (b - a)))
                pos += (b - a) - (cf if i + 1 < len(subs) else 0.0)
        return cls(pieces, pos)

    def to_out(self, t: float) -> float:
        """Output time of recording time `t`; a moment that was cut out maps
        to where the cut closes."""
        i = bisect.bisect_right(self._src, t) - 1
        if i < 0:
            return 0.0
        p = self.pieces[i]
        if t < p.src_b:
            return p.out_a + (t - p.src_a)
        return self.pieces[i + 1].out_a if i + 1 < len(self.pieces) else p.out_b

    def kept(self, a: float, b: float) -> bool:
        """Whether any of [a, b) is in the output."""
        return any(p.src_a < b and a < p.src_b for p in self.pieces)

    def to_json(self):
        return dict(length=self.length, pieces=[asdict(p) for p in self.pieces])

    @classmethod
    def from_json(cls, d):
        return cls([Piece(**p) for p in d["pieces"]], d["length"])

    def save(self, path, **extra):
        with open(path, "w") as f:
            json.dump(dict(self.to_json(), **extra), f, indent=1)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            d = json.load(f)
        return cls.from_json(d), d

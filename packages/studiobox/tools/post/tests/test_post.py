"""Pure-logic tests: python3 -m unittest discover -s tools/post/tests (needs numpy/scipy)."""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from postprod import fillers, music, transcript  # noqa: E402
from postprod.timeline import Segment, Timeline, split_segment  # noqa: E402


class FillerTests(unittest.TestCase):
    def test_only_hesitations_match(self):
        for w in ["äh", "Ähm,", "ähm.", "[UH]", "[UM]", "öhm"]:
            self.assertTrue(fillers.is_filler(w), w)
        for w in ["fei", "gell", "halt", "ja", "also", "ähnlich", "Ähre"]:
            self.assertFalse(fillers.is_filler(w), w)

    def test_cuts_snap_between_neighbours(self):
        lev = np.full(1000, -30.0)
        lev[150:156] = -80  # the quietest moment just before the "äh"
        toks = [
            {"w": "ich", "s": 1.0, "e": 1.4},
            {"w": "äh", "s": 1.6, "e": 1.9},
            {"w": "meine", "s": 2.1, "e": 2.4},
        ]
        cuts = fillers.cuts_from_tokens(toks, lev)
        self.assertEqual(len(cuts), 1)
        a, b = cuts[0]
        self.assertGreaterEqual(a, 1.4)
        self.assertLessEqual(b, 2.1)
        self.assertGreaterEqual(b - a, fillers.MIN_SEC)

    def test_aeh_m_joins(self):
        lev = np.full(1000, -30.0)
        toks = [{"w": "äh", "s": 1.0, "e": 1.2}, {"w": "m", "s": 1.2, "e": 1.4}, {"w": "so", "s": 1.8, "e": 2.0}]
        cuts = fillers.cuts_from_tokens(toks, lev)
        self.assertEqual(len(cuts), 1)
        self.assertGreaterEqual(cuts[0][1], 1.3)  # past the "äh" (1.2), snapped near the "m"


class TimelineTests(unittest.TestCase):
    def test_split_skips_cuts_at_edges(self):
        seg = Segment(10.0, 20.0)
        self.assertEqual(split_segment(seg, [[5, 6], [10.005, 10.5], [15, 15.2], [19.99, 20.5]]), [(10.0, 15.0), (15.2, 20.0)])

    def test_mapping_through_cuts_and_pauses(self):
        segs = [Segment(0.0, 10.0, pause_before=0.0), Segment(20.0, 30.0, pause_before=0.5)]
        tl = Timeline.build(segs, [[4.0, 5.0]], cf=0.015)
        self.assertAlmostEqual(tl.to_out(2.0), 2.0)
        self.assertAlmostEqual(tl.to_out(4.5), tl.to_out(5.0))  # inside the cut: where it closes
        self.assertAlmostEqual(tl.to_out(6.0), 6.0 - 1.0 - 0.015)
        self.assertAlmostEqual(tl.to_out(15.0), tl.to_out(20.0))  # the dropped song
        self.assertAlmostEqual(tl.to_out(20.0), 10.0 - 1.0 - 0.015 + 0.5)
        self.assertAlmostEqual(tl.length, 10 - 1 - 0.015 + 0.5 + 10)
        self.assertTrue(tl.kept(3.0, 4.0))
        self.assertFalse(tl.kept(12.0, 18.0))
        tl2 = Timeline.from_json(tl.to_json())
        self.assertAlmostEqual(tl2.to_out(25.0), tl.to_out(25.0))


class MusicTests(unittest.TestCase):
    def test_items_by_length(self):
        sr = 48000
        t = np.arange(sr * 100) / sr
        x = np.zeros(sr * 100, np.float32)
        tone = (0.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        x[sr * 10 : sr * 15] = tone[sr * 10 : sr * 15]  # 5 s jingle
        x[sr * 30 : sr * 90] = tone[sr * 30 : sr * 90]  # 60 s song
        items = music.find_items(x, x, jingle_max_sec=30)
        self.assertEqual([i.kind for i in items], ["jingle", "song"])
        self.assertAlmostEqual(items[1].start, 30.0, delta=0.2)
        self.assertAlmostEqual(items[1].end, 90.0, delta=0.2)

    def test_closed_frames_keep_talk_over_the_ends(self):
        items = [music.Item(10.0, 20.0, "song")]
        anytalk = np.zeros(30 * 20, bool)
        anytalk[8 * 20 : 11 * 20] = True  # announcing into the song
        anytalk[18 * 20 : 25 * 20] = True  # talking over the end
        anytalk[14 * 20 : 15 * 20] = True  # bleed in the middle
        closed = music.closed_frames(items, anytalk)
        self.assertFalse(closed[10 * 20 + 5])
        self.assertTrue(closed[14 * 20 + 10])
        self.assertFalse(closed[19 * 20])
        self.assertFalse(closed[5 * 20])


class OnAirTests(unittest.TestCase):
    def test_residual_finds_the_mics(self):
        sr = 48000
        rng = np.random.default_rng(1)
        N = sr * 30 + 1234  # not a whole number of frames
        m = (0.1 * rng.standard_normal(N)).astype(np.float32)  # dry music
        voice = (0.05 * rng.standard_normal(N)).astype(np.float32)
        gain = np.linspace(2.0, 0.5, N, dtype=np.float32)  # the live leveler glides
        prog = m * gain
        prog[sr * 10 : sr * 20] = prog[sr * 10 : sr * 20] * 0.2 + voice[sr * 10 : sr * 20]  # ducked, voice on air
        prog[sr * 25 :] = 0  # mics and music off air (chatter into muted mics)
        air = music.on_air(prog, prog, m, m)
        self.assertFalse(air[5 * 20 : 9 * 20 - 20].any())
        self.assertTrue(air[11 * 20 : 19 * 20].all())
        self.assertFalse(air[27 * 20 :].any())


class ShowEndTests(unittest.TestCase):
    def test_outro_ends_the_show(self):
        from postprod.render import show_end

        anytalk = np.zeros(400 * 20, bool)
        anytalk[10 * 20 : 100 * 20] = True
        anytalk[250 * 20 : 260 * 20] = True  # the room speakers during a post-show song
        items = [music.Item(100, 200, "song"), music.Item(205, 215, "jingle"), music.Item(220, 300, "song"), music.Item(310, 320, "jingle")]
        self.assertEqual(show_end(items, anytalk, 400.0), 215)
        self.assertEqual(show_end([items[0], items[2]], anytalk, 400.0), 300)  # no jingle: the last item
        self.assertEqual(show_end([], anytalk, 400.0), 260)  # no items: the last talk


class TranscriptTests(unittest.TestCase):
    def test_bleed_and_marks(self):
        cls = np.full(20 * 20, -1)
        cls[0 : 10 * 20] = 0  # A talks 0-10 s
        cls[10 * 20 : 20 * 20] = 1  # B talks 10-20 s
        open_ = np.ones(20 * 20, bool)
        words = {
            "A": [{"w": " Hallo", "s": 1.0, "e": 1.4, "p": 0.9}, {"w": " Welt", "s": 1.5, "e": 1.9, "p": 0.3}, {"w": " hier", "s": 2.0, "e": 2.3, "p": 0.9}],
            "B": [{"w": " Hallo", "s": 1.1, "e": 1.4, "p": 0.9}, {"w": " ja", "s": 12.0, "e": 12.3, "p": 0.95}, {"w": " genau", "s": 12.4, "e": 12.9, "p": 0.95}],
        }
        utts, review, dropped = transcript.build(words, cls, open_, {"A": 0, "B": 1}, log=lambda m: None)
        self.assertEqual([(u.speaker, u.text) for u in utts], [("A", "Hallo Welt hier"), ("B", "ja genau")])
        self.assertIn("[? Welt ?]", utts[0].marked)
        self.assertEqual(review, [])  # one short word is marked but not listed

    def test_vtt_split(self):
        cues = transcript.split_cue(0.0, 10.0, " ".join(["wort"] * 40))
        self.assertEqual(len(cues), 3)
        self.assertAlmostEqual(cues[-1][1], 10.0)


if __name__ == "__main__":
    unittest.main()

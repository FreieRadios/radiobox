# studiobox: lessons from the first live sessions (2026-10-28)

What the first two real sessions on studiobox taught, and the questions they
left open, worked through on their recordings. The shows themselves don't
matter here; the principles do. Two kinds of session:

| | Session A | Session B |
|---|---|---|
| Format | talk: host + 2 adult guests | children's show: an adult moderator + 3 children |
| Mics | 3 recorded (Flow 8) | 4 recorded, a 5th wanted |
| Raw speech level (before trim) | about −34…−39 dBFS | children −57, adult −45 dBFS |
| Raw peaks | up to −2.7 dBFS | up to −10.7 dBFS (shouts, laughter) |
| Raw noise floor | preamp −93, room −63…−75 dBFS | −86…−90 dBFS |

Both left dry, sample-aligned stems: mics, file player, programme. The
replay harness is `packages/studiobox/tools/replay/`, and the check behind
the stream comparison is `checks/stream-vs-programme.py`.

## What the sessions taught (already acted on)

- **Nothing is restarted while a recording runs**, and offline analysis on the
  box runs short and niced → `packages/studiobox/AGENTS.md`, "During a show".
- **A forgotten recording** cost a show its first minutes →
  `output.backup.autoArm`, and the host may arm the recording.
- **Uneven trims cause both "word endings cut" and "ducking when two talk".**
  The automix compares mics after the trim, so the mic trimmed hottest wins
  every overlap. The trims have to bring every mic's speech to the same level
  (−20 dBFS, Einmessen's target) → Auto-Pegel.
- **Shows start on time without Einmessen, and nobody can reach the mixer's
  gain while people talk** → Auto-Pegel follows each voice.
- **The analog gain was never the bottleneck**: digital trims of +19…29 dB
  stayed clean, because the noise floor sits 30 dB or more under the speech
  even at low gain (see the gain section below).
- **Channel count**: 5 mics + player + programme don't fit an 8-channel FLAC
  multitrack, and the service crash-looped → `output.multitrack.programme`
  defaults to false, the station preset has 6 inputs (an unused one reads
  FREI and stays in the mix), config errors show as `cannot start: …` on
  the health page.
- **Children swap seats** → live mic names and cable colours in the state file.
- **`hasScheduled` on a shared sync root** fires the same file on every box.
- **PipeWire** must leave the studio cards alone; **2 s buffers** on capture
  and output on a loaded machine.
- **Post-production** became `tools/post/`. Editorial cuts follow a checklist
  (third parties' names out, length against the slot), and the pitfalls
  (`cp -al`, Whisper's ±0.5 s) are in its README.
- **Recorded level ≠ aired level.** The programme left the box on target
  (−15.8 LUFS); the station's stream measured 9 dB lower, a constant gain
  after the box. `checks/stream-vs-programme.py` tells such a loss from a
  processor riding the level.

Session B shows how far the live chain has come: the recorded programme came
out at −16.0 LUFS integrated, the four speakers' median loudness within
0.4 LU of each other (a careful offline remaster: 0.7 LU), LRA 4.4 LU. What
the offline remaster still does better: true peak (live −0.2 dBTP; the
limiter is sample-peak only, the open roadmap item), quieter breaths, mics
safely closed during songs, the cuts.

## Gain staging on the Flow 8, and who sets it

### The Flow 8's gain can be set over USB MIDI

The Flow 8's Quick Start Guide (section "MIDI Implementation") documents MIDI
control over the USB connection the box already uses for audio. Every input
channel has its own MIDI channel (input 1–4 = MIDI ch 1–4, 5/6 = 5,
7/8 = 6, USB/BT = 7; busses 8–12, FX 13/14, global 16), and per input:

| CC | parameter | range |
|---|---|---|
| **8** | **GAIN** (not on USB/BT) | 0…127 = −20…+60 dB, 0.63 dB per step |
| 7 | level to main | 0 = off, 1…127 = −70…+10 dB |
| 5 / 6 | mute / solo | 0 = off, 1…127 = on |
| 9 | low cut | 20…600 Hz |
| 1–4 | EQ low / low mid / hi mid / hi | ±15 dB, 64 = 0 dB |
| 11 | compressor | 0…100 % |
| 12 | 48 V (inputs 1 + 2 only) | 0 = off |
| 14–17 | sends to MON1, MON2, FX1, FX2 | like CC 7 |

Snapshots load by program change on MIDI ch 16. So studiobox can set the
preamp gain of every input itself: `B0+(ch−1) 08 v` with
`v = round((gainDb + 20) × 127 / 80)`. Still to verify on the hardware:

- that Linux sees the Flow 8's MIDI port (`amidi -l`; it is class-compliant
  USB MIDI on paper) and that `amidi -p hw:F8 -S 'B0 08 40'` moves input
  1's level by the expected amount;
- whether the mixer **reports** anything back. Community reports say it
  does not (no feedback of control changes), so a gain changed in the
  mixer's own app or on the hardware stays invisible to the box;
- how a MIDI gain change sounds (a step, a click, or a ramp) and how fast
  it takes effect.

### What the two sessions say about where the gain should be

The ADC clips at 0 dBFS; everything after it (trim, leveler) is floating
point. So the analog gain has exactly two jobs: no clipping on the loudest
moment, and the noise far enough under the speech. Measured:

- **Children's shouts and laughter are 20–38 dB over their speech** (hop
  level), with sample peaks up to 46 dB over the median speech level. In
  session B the gains that put the children's speech at −57 dBFS put their
  shouts at −10.7 dBFS peak: **only about 4–6 dB of room upward**. The post
  analysis' "10–15 dB more gain does no harm" would have clipped those
  shouts.
- **Noise is no reason for more gain**: the raw floor of −88 dBFS at that low
  gain plus +36 dB of trim is −52 dBFS, still under the mic leveler's noise
  ceiling of −50 dBFS (which stops the boost anyway).
- Adults (session A) had their peaks at −2.7 dBFS with speech at −34…−39:
  already at the top, if anything 3 dB too hot.

**Rule: set each channel's gain so that the loudest thing that mic will see
(a shout, a laugh, a cough close to the mic) peaks around −6 dBFS, and let
the trim do the rest.** That puts adult speech at about −35…−40 dBFS (trim
+15…20 dB) and children at about −50…−57 (trim +30…37 dB). Hence:

- **`autoTrim.maxDb: 36` in the station preset** (default 30, the loader
  allows 40). Session B's children sat at the 30 dB ceiling 24–53 % of the
  show; with 36 they reach the −20 dBFS target. Not more desk gain.
- **Without MIDI**, a fixed gain per input, written on the desk, with the
  same mic always on the same input: set once in a rehearsal by the rule
  above, saved as a Flow 8 snapshot so it can be restored. That plus
  Auto-Pegel needs no hand on the gain during a show. Children and adults
  differ by ~20 dB in speech, but a gain set for an adult's peaks leaves a
  child's speech at about −55…−60, which +36 dB of trim still covers.

### Proposal: studiobox owns the gain

Since the Flow 8 accepts gain over MIDI, the manual step can go:

1. **Gain per input in the config** (`channels[].gainDb`, plus an optional
   `capture.midi` device). At start, studiobox sends CC 8 for every
   configured input, so the mixer is always in a known state, whatever
   somebody did in the app the day before. Lowest risk, biggest gain: it
   ends "which gain was set?".
2. **Einmessen sets the gain.** Today Einmessen gives advice for the knob
   ("2 dB more gain"); with MIDI it can apply it: gain for the peaks
   (−6 dBFS headroom target from the loudest frames it heard), trim for the
   speech. Persisted in the state file like the trims.
3. **During a show the gain stays put.** Auto-Pegel keeps working on the
   digital trim. Riding the analog gain live would put steps into the dry
   multitrack and needs the MIDI latency against the audio to compensate
   the trim on the same sample. Only a clip guard is worth considering:
   if a mic clips repeatedly, drop its gain by 6 dB and raise its trim by
   6 dB, timed into a pause.

Since the mixer doesn't report back, the box has to be the only one that
sets the gain: whoever uses the Flow 8 app during a session undoes it
unnoticed. `doctor` can at least check that the MIDI port is there.

## Does Auto-Pegel hold up with children and fast speaker changes?

**Yes, except for shouts and laughter.** Method: the replay feeds the dry
stems through the real `Graph`, configured by the production loader from the
session preset and the profiles (look-ahead 6 s, Auto-Pegel −20 dB target,
−10…+30 dB, automix power share). It logs per 40 ms hop the arrival talker
and every mic's trim, automix and leveler gain. The reference is
`tools/post`'s offline (non-causal) talker labelling, which is an estimate,
not ground truth. Session B has 672 speaker changes in 59 minutes.

| talker label agrees with the offline one | session A | session B |
|---|---|---|
| overall (where both name a talker) | 95.7 % | 93.4 % |
| steady talk | | 98.8 % |
| first second after a speaker change | | 96.8 % |
| very short interjections / real overlaps | | 84.8 % / 66 % |

Labels on the wrong mic stay under 4 % of any mic's talk. Most misses are the
live detector saying nothing; where it names a talker and the offline one
doesn't, 87–98 % of those hops are speech by level.

Trims in session B, replayed without a seed, i.e. as a show without Einmessen:

- **Start without Einmessen**: within 26–108 s of show time (4–9 s of each
  mic's own talk) the trims match a run seeded from Einmessen-like levels.
- **On target**: the final trims sit next to an ideal computed from each
  mic's talk level (27.5 vs 27.6, 24.5 vs 24.7, 20.9 vs 19.9 dB). Ranges
  after the first 2 minutes: 21–30, 11–30, 18–30, 16–28 dB.
- **Music**: 0.0 dB of movement over 441 s of room music. Nothing runs away.
- **A speaker who only ever talks over others** (37 s alone in the whole
  show) still gets 357 s of labels; only 10 s of that talk had a trim more
  than 6 dB off.
- **Speaker spread**, median 3 s loudness over single-talker windows: replay
  0.24 LU against 0.45 LU live (session A: 0.14 vs 0.12).
- Session A: trims 9–29 dB; the second-half medians (12.2 / 13.8 / 20.8 dB)
  sit next to the final hand trims (+14 / +15.4 / +19), and a gain change
  at the mixer mid-show was tracked.

Two problems:

1. **A shout reads as a new level.** One child's trim dropped by 6–17 dB
   within 3 s seven times (worst 26.2 → 9.6 dB) and took 13–59 s to recover.
   A half-second shout 20–38 dB over normal dominates the 10 s power mean,
   and the "knob turned" rule (last 2 s more than 6 dB off for 1 s) then
   throws away the history and glides fast. On air the leveler (look-ahead,
   ±24 dB) absorbs most of it, which is why the spread stays small; the cost
   lands on the gate and the automix, which see the trimmed signal. In a
   Python port of `auto-trim.ts` (it reproduces the TS trims exactly from
   the replay log), **clipping each frame at the running estimate + 10 dB**
   before it enters the mean left 2 drops instead of 6 (as the port counts
   them), raised that mic's minimum trim from 11 to 20 dB, and still
   followed session A's real gain change. Clipping at +6 dB removes every
   drop but biases trims up by up to 2 dB. Candidate fix in
   `src/dsp/auto-trim.ts`, with a test built from such a shout.
2. **The +30 dB ceiling binds for children**: they sat at `maxDb` 43 %, 53 %
   and 24 % of the show. See the gain section: `maxDb: 36`, not more gain.

## Two people talking at once: is the automix dip acceptable?

Overlap here means both mics carry their own voice and the arrival labels
name both (music excluded): session A 83 s in 183 stretches, session B 252 s
in 553. With the power share, two equal talkers would each get −6 dB.

| production automix | session A | session B |
|---|---|---|
| quieter talker, median / p10 | −8.9 / −36.7 dB | −7.0 / −16.2 dB |
| louder talker, median | −4.1 dB | −3.9 dB |
| quieter one more than 10 dB down | 44 % | 26 % |
| quieter vs. louder on air | −11.7 dB | −8.6 dB |

With a level test alone instead of the arrival labels, the median comes out
at −18.7 (A) and −7.9 dB (B), so the numbers depend on how an overlap is
defined. Alternatives tried inside the harness, with their cost measured as
the bleed energy of the other mics relative to the talker while one person
talks (production: A −24.0, B −27.7 dB):

| share law | quieter one > 10 dB down (A / B) | other effect | more bleed (A / B) |
|---|---|---|---|
| power^0.75 | – / 26→24 % | | – / +1.5 dB |
| power^0.5 | 44→40 % / 26→22 % | p10 −37→−21 / −16→−13 dB; the louder talker loses 2 dB | +5.9 / +4.4 dB |
| floor −6 dB for a voiced talker | 44→30 % / 26→18 % | B's median −7.0→−6.1 dB; A's deep tail untouched | +5.0 / +4.4 dB |
| floor −10 dB for a voiced talker | – / 26→23 % | | – / +2.3 dB |

The floor misses session A's deep tail because a talker more than 10 dB
under the loudest mic does not count as voiced (`DOMINANCE_DB`), so it never
engages. Noise in pauses is the same under every law.

**Assessment:** the dip is mostly what a gain-sharing automix is for. The
median quieter talker is 1–3 dB below an even share. What hurts is the tail:
in session A, 44 % of the overlaps put the quieter talker more than 10 dB
down, largely because its trims were uneven (hand trims, no Auto-Pegel yet).
Even trims remove the main cause. Every alternative trades fewer swallowed
interjections for 2–6 dB more bleed. If anything changes, the mildest are
power^0.75 or a −10 dB floor. Re-measure after the shout fix on the next
session's multitrack before touching the law.

The replay has no mutes, and the seed sets only the trims, not Einmessen's
gate and automix floor. Its pauses are therefore 6–11 dB noisier than the
live mix: compare the laws with each other, not with the live noise figures.

## Calibrating `latencyMs`

Not possible offline. One rough data point: two stamped jingles appeared in a
station stream recording +1.09 s and +0.59 s after their stamps, if that
recorder started its file exactly on the second (unverified). The sum covers
the box's output latency error, the desk, the processing, the stream encoder
and the recorder.

**Clocks drift by hundreds of ppm.** The programme's sample timeline (the
Flow 8's clock) and that stream drifted apart by −289 ppm (1.0 s per hour);
if the stamps aired on time, the Flow 8 ran about +150 ppm against the wall
clock. That is above the ~100 ppm `SampleClock` assumes for USB audio, still
inside its `leakPpm` of 500. The air FIFO absorbs the drift between the two
cards; `air.resyncs` in a session's snapshots would tell how much that is.

**Proposal: let the box measure its own output latency.** The Flow 8 has
inputs to spare. A short cable from the MAYA22 (or the desk's monitor out)
into a spare input, a click emitted at a known Sendezeit, and its arrival on
the capture timeline (which `SampleClock` maps to wall time) give
`output.monitor.latencyMs` to the millisecond against the box's own NTP
clock, with no reference clock needed. The same works for the return. Entry: a
`doctor`/Einmessen step "Ausgang messen".

## Show length against the slot

An overrun (61:44 in an hour's slot) came from post-production, not from the
live show, which ended inside the hour: the cut version got a closing song.
So:

- **Post first (small):** `tools/post` should warn when a rendered version is
  longer than the slot (`--slot-minutes`, later the slot from the schedule).
  It is on the editorial checklist meanwhile.
- **Live (once the schedule is connected):** the box knows the slot from the
  schedule rules (`slotAt` in `src/listeners/`) and the stamped outro; a
  "noch mm:ss bis Sendeende" on the host and guest views (R14: "time left")
  is the live counterpart. It needs the slot, not the listener feedback.

## The listener connection in a children's show

The **Sendung** panel (topics, questions, Abmoderation from blyxa) is worth it
for any planned show, because the moderator often runs it alone. **Hörer:innen**
feedback goes to technician and host connections only, never to the guest
view the children's tablets show, and comments are released in blyxa by
somebody not at the mic. The remaining risk is a child at the host view; a
per-show switch that keeps the feedback on the technician's view would cover
it, if the station wants it.

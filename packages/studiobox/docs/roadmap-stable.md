# studiobox — roadmap to a stable version

**Written:** 2026-09-30 · **Updated:** 2026-10-02 (audit, see section 3),
2026-10-06 (beginner-friendly, M1b; remote output and listening, M1c;
internal mic, M2.13) ·
**First target:** the live session in the week of
2026-10-05 · **Basis:** `docs/analysis/studiobox-audit-2026-09-29.md`, the
code on branch `studiobox`, a first run on the test rig and the Radio Z
signal chain as documented in eve (`apps/radio-z/radioz-technik/Aufbau.md`).

The design rules for all screens are in
[design-guidelines.md](design-guidelines.md). Decisions taken so far are in
section 6.

---

## 1. The session, as the goal

| Topic      | Requirement                                                                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People     | 4 speakers on the Flow 8: ch 1 **Gast 1** and ch 2 **Gast 2** (phantom-powered, unknown voices), ch 3 **Host** (female voice, loud and clear), ch 4 **Technik**/side-show (loud and clear); ch 3 and 4 without phantom                                                                                      |
| Length     | Up to **3 hours**                                                                                                                                                                                                                                                                                           |
| Soundcheck | A **setup assistant** that measures all four mics and configures them in about a minute of test talking                                                                                                                                                                                                     |
| Devices    | a) **host**: playout, prepared playlist, scheduled start/end jingles, an audio bed available at any time as an emergency fallback · b) **technician**: all levels, all functions, live fine-tuning · c) **guests**: display only — "is my mic open, is my level right", the running track and the time left |
| Mix        | Quieter voices raised automatically, **with look-ahead**. **Host priority**: guests go down gently when the host speaks. Music, jingles and bed are **ducked** under any speech; the host mutes the mics by hand around jingles.                                                                            |
| Timing     | **Buffered, not real-time**: up to a minute of delay is fine. The UI shows the **on-air time** ("Sendezeit") so the host can say "it's exactly 13:00" when it will air at 13:00.                                                                                                                            |
| Output     | The finished mix as analog audio from the **ESI MAYA22** into the **"extern 2× cinch"** input of the analog desk in the Großes Studio. Later: lossless to a Liquidsoap harbor.                                                                                                                              |
| Monitoring | Headphones on the **Flow 8** (direct, zero latency)                                                                                                                                                                                                                                                         |
| Recording  | **Processed stereo FLAC** (to share as a lossless reference, the more important one) **and** a **multichannel** file for later processing (dry by default, configurable)                                                                                                                                    |
| Network    | The venue's Wi-Fi (Radio Z), shared with other people                                                                                                                                                                                                                                                       |
| UIs        | Host, technician, guest, spectator. Good-looking, mobile-first, **accessible** (German: _barrierefrei_; target WCAG 2.2 AA)                                                                                                                                                                                 |

### Where the output goes

From eve's Radio Z Sendetechnik:

```
            headphones ◄─ Flow 8 (direct mics + music return from studiobox)
                              │ USB, 10 ch
                              ▼
                   studiobox ── air delay (seconds) ──► MAYA22 ─cinch─► desk "Großes Studio", extern input
                                                                           │ (+ desk mics, CD, phone, mAirlist, …)
                                                                           ▼
                                                             Orban Optimod (AGC + noise gate)
                                                    ┌──────────────────┼──────────────────────┐
                                              radiobox Pi        DCF switch ─► Jünger     USB PC ─► Icecast
                                              (recording/        limiters ─► UKW, DAB+    + mp3 archive
                                               repeat)
```

Consequences:

- **Studiobox is not the last processor.** The Optimod applies AGC and a noise
  gate after it, then the Jünger limiters. Studiobox delivers a **clean,
  consistently levelled mix at a calibrated reference level**, not a loud one.
- **The desk channel sets the final level.** A test tone from studiobox
  calibrates the extern input (M1.9).
- **The desk's own mics stay closed** during the session, and nothing else on
  the desk plays while studiobox is on air: studiobox is delayed, the desk's
  other sources are not.
- **Handover at the end** happens by on-air time. When the host says goodbye,
  the last seconds are still in the buffer; studiobox has to play them out
  before the next programme starts on the desk (M1.2, "Sendung beenden").

## 2. Architecture: buffered instead of real-time

Because the headphones hang on the Flow 8, nobody hears studiobox's output
while talking. That turns latency from a problem into a resource: the whole
mix can be computed with **look-ahead**, and the output simply runs a fixed
delay behind the room.

```
room time (now)                                         air time (now + D)
Flow 8 ──► capture ──► analysis & DSP with look-ahead L ──► FIFO ──► MAYA22
               │                    ▲                        │
               └─ dry multitrack    └─ file player, bed      └─ processed FLAC
                                        (started D early for scheduled items)
               Flow 8 USB return ◄── music/jingles/bed, room time, no mics
```

- **D = air delay**, configurable 0–60 s, **recommended 10 s**. The DSP needs
  L ≈ 3 s of look-ahead; the rest is margin. A longer D doesn't improve the
  sound, it only moves the on-air clock further away from the wall clock and
  makes the end-of-show drain longer. D = 60 s is allowed if it helps.
- **The output is pulled by the MAYA22** (the pattern `playout.ts` already
  uses), the input is clocked by the Flow 8. The two USB clocks drift apart;
  the FIFO absorbs it (about half a second over 3 hours at 50 ppm). The
  **measured** delay (FIFO fill + ALSA buffer) drives the on-air clock, so it
  stays exact even while the fill wanders.
- **Sendezeit = wall clock + measured D.** It is the main clock on every view;
  the wall clock is shown small. A scheduled jingle stamped `13:00:00` is
  started when the Sendezeit clock reads 13:00:00 (i.e. D early in wall time),
  so it airs on the second.
- **The room hears the music through the Flow 8's USB return.** The Flow 8
  offers 4 playback channels that share the capture clock (implicit feedback,
  so no drift). Studiobox sends the music/jingle/bed mix, ducked as on air but
  **without mics**, in room time, so the talk and the music line up in the
  headphones. Without this return nobody in the room hears the music, except
  from the desk, D seconds late.
- **With look-ahead, everything can act ahead of time:** the gate opens before
  the first consonant, the leveler has the right gain on the first word, music
  ducks a moment before speech starts (the way a human pulls the fader), and
  host priority lowers guests before the host's first syllable airs.
- **What each view shows:** host, technician and guests live in **room time**
  (what they hear, what they're doing); the spectator view shows **air time**
  (what listeners hear now). Every view shows the Sendezeit clock.
- **If studiobox crashes**, the buffered D seconds are lost and the desk's
  extern input goes silent; the station's analog silence detector takes over
  after its timeout. `systemd` restarts studiobox; it needs D seconds to fill
  the buffer before it airs again.

## 3. Where we stand (test rig, 2026-09-30)

Rig: this desktop, Flow 8 = ALSA card `F8` (10 capture channels: 1–8 inputs,
9/10 main L/R; 4 USB playback channels; a USB MIDI port), MAYA22 = ALSA card
`USB` (stereo out). Config: `config/studiobox.local.yaml` (git-ignored).

- **[checked]** Live mode starts with the four labelled mics: `arecord`
  captures 10 ch, `aplay` plays to the MAYA22, the meters page answers on
  `:4445`.
- **[checked]** With the Flow 8 gains at 0 dB and nobody talking: noise floor
  −89 to −100 dBFS RMS on ch 1–4, −123 dBFS on ch 5–8.
- **[checked]** The current output path already runs ~0.6–0.7 s behind (a full
  24 000-frame `aplay` buffer: 496 ms). Irrelevant now that the headphones hang
  on the Flow 8, but it means the "real-time" path was never real-time.
- **[checked]** The MAYA22's ALSA `PCM` control stands at **−23.5 dB**.
- **[checked]** The stereo recorder writes **FLAC 24 bit / 48 kHz**. An
  8-channel 24-bit FLAC also encodes fine.
- **[not verified yet]** Levels while speaking. With the gains at 0 dB the two
  dynamic mics (Host, Technik) will probably be far too quiet; the assistant
  will say by how much.

Carried over unchanged: per-mic chain, Dugan gain-sharing automix, ducking,
"Mute mics", master leveler + limiter, BS.1770 metering, file player, queue,
filename-timestamp scheduling, Vorhören and Reinhören, stereo FLAC recording,
harbor encoder, local hardware output.

### Progress on M1 (backend, 2026-09-30)

The server side of M1 is written and tested, and so are the views (technician
and host page, guest and spectator view — page logic against a DOM stub, the
layouts in headless Chromium, not yet on a real phone or tablet; see
`AGENTS.md`). "Tested" means unit tests plus an end-to-end run of the real process
against **fake sound cards** (`arecord`/`aplay` replaced by paced stand-ins).
**Nothing below has run on the Flow 8 and the MAYA22 yet** — a studiobox
instance was holding both devices while this was written.

| Item                      | Backend                                                                                            | Still to do                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M1.1 Einmessen            | Done: measurement (`src/setup/`), live apply, `session-state.json`; commands `setup*`, `trim`      | A run with four real voices (the technician panel and the prompts on the host and guest views are built)           |
| M1.2 Air delay, Sendezeit | Done: FIFO, pull-driven output, measured delay, schedule on Sendezeit, `endShow`                   | **Calibrate `output.monitor.latencyMs`** against a reference clock; 3 h soak (the Sendezeit clock is on the views) |
| M1.3 Look-ahead DSP       | Done: tests (a)–(d) pass (`__tests__/dsp/lookahead.test.ts`)                                       | Listen to it                                                                                                       |
| M1.4 Roles                | Done: tokens, allowlist per role, links printed at start (`meters.roles`), QR codes (M1.18)        | The four views on a real phone and tablet (built, so far only checked in headless Chromium)                        |
| M1.5 Guest indicator      | Done: `speechDb`, `zone`, `zoneCenterDb`/`zoneWidthDb` per mic                                     | In the rehearsal: "passt" at a normal speaking distance (the guest view is built)                                  |
| M1.6 Recording            | Done: one continuous tagged stereo FLAC + 8-channel multitrack + channel map, sample-aligned       | Open the multitrack in Audacity/Reaper once                                                                        |
| M1.7 Music return         | Done: `output.return`, room time, no mics, ducked; programme music delayed by the return's latency | **Open point 9** on the hardware; set `output.return.latencyMs`                                                    |
| M1.8 Host priority        | Done: `automix.priority`, `priorityDepth` live                                                     | Listen to it (slider, LEISER and "Moderation spricht" are built)                                                   |
| M1.9 Test tone            | Done: `testTone` (1 kHz, −18 dBFS, local output only)                                              | MAYA22 mixer to 0 dB (`doctor` says how); the button is in the ⋮ menu                                              |
| M1.10 Bed                 | Done: `filePlayer.bed`, commands `bed` / `bedSelect`                                               | A run with a real bed file (button and the 🛏 file picker are built)                                               |
| M1.11 Host mic toggle     | `micsMuted` acts in room time; the remaining time is in the snapshot                               | Try it on the tablet (footer of the host layout)                                                                   |
| M1.12 Queue mode          | Done: `queueMode`, live mode defaults to "einzeln"                                                 |                                                                                                                    |
| M1.13 `doctor`            | Done, except the QR codes and the Wi-Fi reachability test (not possible from the box itself)       | Run it on the session laptop                                                                                       |
| M1.14 Safeguards          | Done: `error` listeners on encoder and recorder stdin                                              |                                                                                                                    |

Measured in the end-to-end run (fake cards, D = 10 s): the measured delay held
at 10.00–10.03 s with no underrun and no resync; a jingle stamped for a given
second came out of the output 53 ms after it, with the output latency guessed
rather than calibrated; "Sendung beenden" played the buffer out in 10.6 s and
stopped the recording. The ±50 ms criterion of M1.2 therefore hinges on the
calibration in the rehearsal, not on the mechanism.

**First run on the hardware (2026-09-30, afternoon).** The old instance was
stopped and the new code started on the Flow 8 and the MAYA22 with
`studiobox.local.yaml`:

- **[checked]** Capture (10 ch), programme output and the 4-channel music
  return to the Flow 8 all open and run; `doctor` passes except for the
  MAYA22 mixer (still −23.5 dB) and roles being off on the rig.
- **[checked]** With ALSA's default buffers `aplay` underran several times a
  minute — the desktop was at load 29 from other jobs and a descheduled
  process can't feed a sound card. With 2 s buffers and 20 ms periods on
  capture and programme output (both cards grant them) the same machine ran
  without a single underrun, the measured delay within 10.01–10.04 s. The
  session preset sets them. On the session laptop: nothing else running.
- **[checked]** An 8 s recording yields the stereo file and the 8-channel
  multitrack, both 11.2 s long (the look-ahead plays out into the file), 24
  bit, named by Sendezeit, with the channel map.
- **[not verified]** Anything audible: no file was played and nobody was
  measured — where the return lands in the Flow 8, the timing of a scheduled
  jingle at the MAYA22, Einmessen with voices.

Two things the hardware will decide:

- **Capture bursts.** `arecord` hands over ~125 ms at a time with its default
  period. The sample clock and the FIFO don't care; the music return (no
  buffer to speak of between capture and playback) might. If it crackles:
  give the return a buffer (`output.return.bufferMs: 300`) and set its
  `latencyMs` to match.
- **Talker detection without trims.** Before the first Einmessen the mics'
  sensitivities differ by up to 20 dB, so "the loudest mic is the talker" can
  be wrong between a condenser and a dynamic mic. The assistant handles its
  own run (it compares each mic to its own noise floor and lets the prompted
  mic settle ties); the leveler key is only reliable _after_ the trims are
  applied. Run Einmessen before judging the leveler.

### Audit of 2026-10-02

Checked on the rig the day before the freeze. Typecheck and the 46 suites
(444 tests) are green. A fresh clone of `main` installs
(`yarn install --frozen-lockfile`), builds and runs `doctor`. The eve adapter
ran against eve dev: read-only login, `schedule-rules`, `listener-comments`,
`listener-hearts`, `episodes` and the change socket all answered, and the show
on air was picked from the plan. No correctness bug turned up in the DSP core,
the air FIFO or the role allowlist.

What it did find, and the item that takes it up (section 5):

| Finding                                                                                                                                                                        | Taken up in          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| GitHub is behind: `main` was 28 commits ahead of `origin/main`, and the commits with M1 and eve are on neither remote branch                                                   | M1.15                |
| The eve feed works but is off in every config (no `listeners` block in the rig config or the session preset); the only eve known is dev on the desktop                         | M1.16, open point 12 |
| The episode guide was never seen with data (eve dev has no episode from yesterday to tomorrow); `episode-topics` / `episode-questions` are covered by tests only               | M1.16                |
| Role tokens are new at every start (the preset does not pin `meters.roles.tokens`): after a restart every tablet is a read-only spectator until it gets the new link           | M1.17                |
| ~~No QR codes~~ — done: ⋮ → "Geräte verbinden" shows a QR code per role and per guest mic (`/connect`, technician only)                                                        | M1.18                |
| Nothing audible is verified: the music return was never listened to, and no Einmessen ran with voices (there is no `session-state.json` on the rig)                            | Rehearsal            |
| In the headphones the music ducks about 0.3 s after the first word (the return's 300 ms buffer); on air it ducks ahead of the speech                                           | Rehearsal            |
| A lost Flow 8 is not said on the page — the meters just freeze (a lost output card is, since `monitorFault` / `musicReturnFault`)                                              | M1.19                |
| `doctor` does not check eve, and the address for the tablets is the first non-internal IPv4, which on a machine with Docker or a VPN can be a bridge                           | M1.20                |
| The README still describes the "Phase 1 scaffold" and recommends `hw:` where the code needs `plughw:`; `scripts/studiobox.service` is the Pi's playout unit (`MemoryMax=300M`) | M1.21                |
| Sound cards are not found by themselves: device names are typed into the YAML                                                                                                  | M2.11                |
| The capture card clocks everything: file player, bed, scheduler, recorders and return advance only on capture blocks, so they stop with the Flow 8                             | M2.8                 |
| A crash loses the queue, the recording's arming and the tokens; there is no `uncaughtException` handler                                                                        | M2.2, M2.9           |
| One Node thread does DSP, web and file work; the scheduler's rescan reads folders synchronously (`FileDirs.entries`), which can stall audio on a slow share                    | M2.10                |
| Unknown config keys are ignored: `listeners.enable: true` just leaves the feature off                                                                                          | M2.12                |
| Plain HTTP with the tokens in the URL, and no Origin check on the WebSocket                                                                                                    | M2.6                 |
| `server.ts` is 2 323 lines, about 1 900 of them the page as a template string                                                                                                  | M2.1                 |

## 4. Requirement → gap

| #   | Requirement                           | Today                                                                         | Gap                                                                      |
| --- | ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Mics listening, 4 channels            | Works, labels set                                                             | Rehearse with voices                                                     |
| R2  | Measured auto-setup in ~1 minute      | Tuning = editing YAML + restart; the Flow 8 gains are analog and out of reach | **Setup assistant** + live trims                                         |
| R3  | Quieter voices raised                 | Per-mic leveler, 1.5 s response; starts at 0 dB; adapts to bleed              | **Look-ahead leveler**, keyed on voice activity, seeded by the assistant |
| R4  | Buffered processing                   | Real-time push pipeline                                                       | **Air delay FIFO**, pull-driven output, look-ahead DSP                   |
| R5  | On-air time in the UI                 | Server wall clock only                                                        | **Sendezeit clock**; scheduler on air time                               |
| R6  | Guests down (gently) for the host     | Automix treats all mics as equal                                              | **Host priority**                                                        |
| R7  | Music, jingles, bed ducked            | File player ducked; "Mute mics" releases ducking                              | Bed deck; big host mic toggle                                            |
| R8  | The room hears the music              | Nothing goes back to the Flow 8                                               | **Music return** to the Flow 8 USB playback, room time, no mics          |
| R9  | Playlist                              | Server-side queue, in memory                                                  | "einzeln / durchlaufen"                                                  |
| R10 | Jingles at fixed times                | Works on wall time                                                            | Run on Sendezeit (R5)                                                    |
| R11 | Emergency audio bed                   | One player only                                                               | **Second deck "Bett"**                                                   |
| R12 | Host / technician / guest / spectator | One page; every device can do everything; no auth                             | **Role views** + allowlist per connection — required on the shared Wi-Fi |
| R13 | Guest level indicator                 | `outDb` is post-processing, so it does **not** show mouth distance            | **Pre-leveler speech level** + zone from the assistant                   |
| R14 | Guests see track and time left        | Snapshot has it                                                               | Guest view                                                               |
| R15 | Analog out via MAYA22                 | Works; mixer at −23.5 dB                                                      | Calibrated reference level, test tone                                    |
| R16 | Processed FLAC + multichannel         | Processed stereo FLAC, 24 bit, cut into 1 h segments                          | One continuous tagged file per session + **multitrack** (dry default)    |
| R17 | Lossless to a Liquidsoap harbor       | Encoder exists                                                                | Test against the real harbor                                             |
| R18 | Plug and play                         | Device names by hand                                                          | `doctor` preflight, QR codes (M1.18), cards found by themselves (M2.11)  |

## 5. Milestones

### M1 — Session-ready (code freeze Sat 2026-10-03, rehearsal Sun 2026-10-04)

M1 is more than three days of work for one person. It is therefore split: the
**must** items go into the session; each **should** item has a fallback, and
whatever is not finished by the freeze stays out.

#### Must

1. **Setup assistant "Einmessen"** (R2, R13). Technician view, about one
   minute for all four mics:

   1. **Room silence, 5 s** — noise floor per mic.
   2. **Each speaker in turn, until 6 s of speech are collected** (usually
      8–10 s). The assistant shows "Jetzt: Host" on every view, including the
      guest tablet, and a sentence to read aloud so everybody speaks the same
      way. It detects the talking mic by itself, so the order doesn't matter,
      and it measures **bleed**: how loud each voice arrives on the other
      three mics.
   3. **Result per mic**, computed from the raw capture (pre-DSP):
      - **Flow 8 gain advice** (the only thing studiobox can't set): if speech
        peaks sit below −30 dBFS or the speech-to-noise ratio is under 40 dB,
        "Kanal 3 (Host): Gain um etwa +18 dB aufdrehen"; if anything clipped
        (> −3 dBFS), turn it down. After a knob change, "Nur diesen Kanal neu
        messen" (10 s).
      - **Set automatically, live:** input trim (speech at −20 dBFS before the
        compressor), gate threshold between the louder of noise/bleed + 6 dB and
        speech − 15 dB, compressor threshold relative to the measured speech
        level, **leveler seed gain**, HPF from the voice's fundamental (e.g.
        ~100 Hz for the host's voice, ~70 Hz for a low one), de-esser
        threshold from the sibilance energy (5–9 kHz), guest-zone centre,
        automix floor.
   4. **Before/after table, "Übernehmen" / "Verwerfen".** Applied live, kept in
      `session-state.json`, never written into `studiobox.yaml`.

   Pure measurement code (`src/setup/`) with Jest tests: synthetic voices at
   known levels over known noise land in the expected settings; a clipped
   voice produces "turn down"; a voice 30 dB too quiet produces "+30 dB".
   _Done when:_ in the rehearsal the four mics are measured and applied in
   under two minutes including one knob correction, and the guest level
   indicator reads "passt" at a normal speaking distance afterwards.

2. **Air delay and Sendezeit** (R4, R5, R10). Config `airDelay: { seconds: 10
}`. A FIFO between the graph and the MAYA22; the monitor process pulls from
   it at its own clock. The measured delay is in the snapshot; every view shows
   Sendezeit (= wall + measured delay). The scheduler fires on Sendezeit. A
   **"Sendung beenden"** action on the technician view closes the mics, lets
   the buffer play out, then stops cleanly (a plain stop cuts the last D
   seconds).
   _Done when:_ a scheduled jingle stamped for a given second airs within
   ±50 ms of it at the MAYA22 (measured against a reference clock), and a 3 h
   run keeps the measured delay within D ± 1 s with no underrun.

3. **Look-ahead DSP** (R3, R4). The mic strips analyse the signal L = 3 s
   ahead of what they output:

   - **Leveler**: gain from the loudness of the upcoming phrase, adapting only
     while the mic is the active talker (keyed on the automix share, so
     neighbours' bleed doesn't pump it), starting from the assistant's seed.
   - **Gate**: opens a few ms before speech onset, so no consonants get
     clipped.
   - **Ducker**: starts pulling music down ~150 ms before speech arrives.
   - _Done when:_ DSP tests show (a) the first 500 ms of a quiet voice within
     2 dB of the target, (b) no leveler change on a mic fed only bleed 20 dB
     below the talker, (c) the gate fully open at speech onset, (d) the output
     identical to the non-look-ahead chain in steady state except for the
     delay.

4. **Role views and read-only connections** (R12, R14). Routes `/host`,
   `/tech`, `/guest`, `/` (spectator). A per-session token in the URL
   (`/guest?k=…`) selects the role, printed at start as URLs and QR codes; the
   server keeps a **command allowlist per role** and ignores everything else;
   without a token, read-only. New views are real static files
   (`src/meters/public/`); the existing page becomes the technician view.
   _Done when:_ a guest connection sending `micsMuted` changes nothing (test);
   all four views render on a phone and a tablet.

5. **Guest level indicator** (R13). Per mic `speechDb` (level before leveler
   and compressor, only while that mic is the active talker) and `zone: 'low' |
'ok' | 'high' | null`, zone centre from the assistant.
   _Done when:_ a test voice moved by ±10 dB changes the zone while the
   programme level stays the same.

6. **Recording: processed FLAC + multitrack** (R16). One record button arms
   both, both written from the same block, so they stay sample-aligned.

   - **Processed stereo** (priority): FLAC 24 bit / 48 kHz, **one continuous
     file per session** (no 1 h split), named by Sendezeit, Vorbis comments
     (title, date, station, "processed by studiobox <version>"), ready to hand
     out as the lossless reference.
   - **Multitrack**: `output.multitrack: { enabled, source: dry | processed }`,
     **dry by default**: 4 mics + file player L/R + programme L/R = **8
     channels** (FLAC's maximum), 24 bit, a `.json` channel map beside it.
     About 2.5 GB per hour.
   - _Done when:_ a 60 s recording yields both; the 8 tracks open in
     Audacity/Reaper in the documented order; the programme channels match the
     stereo file.

7. **Music return to the Flow 8** (R8). A second output: the ducked
   music/jingle/bed mix without mics, in room time, to Flow 8 USB playback
   ch 1/2. Check in the rehearsal where the Flow 8 routes its USB return
   (headphone bus).
   _Fallback:_ none good — without it the room doesn't hear the music.

#### Should (each with a fallback)

8. **Host priority** (R6). `automix.priority: { label: Host, attenuate:
['Gast 1 (+ Phantom)', 'Gast 2 (+ Phantom)'], depthDb: -8 }`, gentle, never a
   mute, adjustable live; with look-ahead it acts before the host's first
   syllable airs. Shown on the guest view ("Moderation spricht").
   _Fallback:_ the plain gain-sharing automix.
9. **Test tone and reference level** (R15). 1 kHz at −18 dBFS (EBU R68) to the
   MAYA22 only, for setting the desk's extern input. MAYA22 mixer to 0 dB.
   _Fallback:_ set the desk by ear with a music track.
10. **Audio-bed deck** (R11). A second player "Bett": loops, own folder, fades,
    ducked, a permanent big button on the host view.
    _Fallback:_ the bed file in the normal player (it replaces the track).
11. **Host mic toggle and countdowns** (R7). A big "Mikros offen / zu" next to
    the remaining time of the running item; the guest view mirrors "Mikros zu
    – Jingle".
    _Fallback:_ the existing "Mute mics" button.
12. **Queue "einzeln / durchlaufen"** (R9). _Fallback:_ press stop.
13. **Preflight `studiobox doctor`** (R18): tools, cards and channel counts,
    device holders, MAYA22 at 0 dB, folders, time zone and NTP, disk space,
    reachability over the Wi-Fi (client isolation), QR codes.
    _Fallback:_ the rehearsal checklist.
14. **Safeguards** from the audit: `error` listeners on encoder/recorder stdin.

#### From the audit of 2026-10-02

Found the day before the freeze (section 3, "Audit of 2026-10-02"). 15–17 are
housekeeping and configuration and go in before the rehearsal; 18–21 are
should-items, each with a fallback.

15. **Push.** The commits with M1 and eve exist only on the desktop.
    _Done when:_ a fresh clone from GitHub on the session machine builds and
    `doctor` runs there.
16. **eve in the session config.** Add a `listeners` block to
    `config/studiobox.flow8-session.example.yaml` (off, marked ADAPT) and
    switch it on in the session's `studiobox.yaml`: the URL of an eve the
    session machine reaches (open point 12), the `studiodevice` account, the
    password through `STUDIOBOX_EVE_PASSWORD`. For the rehearsal pin the show
    (`show: <slug>`) — outside its slot the plan has another show on air —
    and take the pin out for the broadcast.
    _Done when:_ in the rehearsal the host tablet shows the episode prepared
    in eve with its topics and questions, and a heart sent from eve's public
    page raises the count within a few seconds.
    _Fallback:_ `listeners` stays off; the host reads eve on a second device.
17. **Role tokens that survive a restart.** Pin `meters.roles.tokens`
    (`tech`, `host`, `guest`) in the session's `studiobox.yaml`; the loader
    takes them already. Generated once and kept is M2.2.
    _Done when:_ after a restart the tablets come back in their roles without
    a new link.
18. **QR codes for the role links** (R18; open since M1.4 and M1.13). **Done
    2026-10-02**, still to scan with a real phone. A
    technician-only "Geräte verbinden" in the ⋮ menu: link and QR code per
    role, the guest link once per mic (`/guest?k=…&mic=<label>`), so a guest
    scans and sees their own level, the running track and the time left. The
    same links at start in the terminal. Entry: `Roles.urls` in
    `src/meters/roles.ts`, a route in `src/meters/server.ts` that only a
    technician token gets, a QR encoder (none among the dependencies yet).
    Needs 17, or a printed code goes stale at the next start.
    _Done when:_ a phone scanning a guest code lands on the guest view with
    its mic chosen, and a test shows a host, guest or spectator connection is
    refused the links.
    _Fallback:_ the pinned links (17) sent by messenger, or turned into QR
    codes by hand and printed.
19. **A lost mixer is said on the page.** `captureFault` in `LiveStatus`,
    like `monitorFault` and `musicReturnFault`, and a "Pult fehlt" state on
    the technician and host layouts. Entry: the capture's `exit` handler in
    `src/pipeline.ts`, `setAir` in the page.
    _Done when:_ pulling the Flow 8 is said on both layouts within 2 s
    (pipeline test and page test).
    _Fallback:_ frozen meters and the log.
20. **`doctor`: eve and the address.** With `listeners.enabled`: reach the
    URL, sign in, ask for the exports — a refused login fails, missing episode
    exports warn. The address for the tablets from the interface with the
    default route (or a `meters.publicUrl` in the YAML) instead of the first
    non-internal IPv4. Entry: `src/doctor.ts` (the `Env` gets a `fetch`),
    `src/listeners/eve-session.ts`, `lanAddress` in `src/meters/server.ts`.
    _Fallback:_ open the page and read the panel's state line; type the
    address by hand.
21. **Install notes for the session machine.** In
    `packages/studiobox/README.md`: system packages (Node 20, Yarn 1, ffmpeg
    with ffprobe, alsa-utils), clone, `yarn install`, build, copy the session
    preset, `doctor`, start; `plughw:` throughout. A unit for live mode
    beside the Pi's (`scripts/`): `Nice=-10`, no `MemoryMax=300M`, user and
    path not hard-coded.
    _Fallback:_ started by hand in a terminal, as on the rig.

#### Rehearsal in the Großes Studio

MAYA22 into the extern cinch input; tone calibrated; desk mics closed; Flow 8
USB return on the headphones; assistant run with four people; a jingle
scheduled on Sendezeit and checked against the station clock; Optimod reaction
to the studiobox level; 60 minutes with a playlist and bed; pull and replug
both USB devices; "Sendung beenden"; all three tablets on the venue Wi-Fi.

Added by the audit of 2026-10-02: listen to the music return on the Flow 8
headphones while talking (open point 9) — the duck arrives about 0.3 s after
the first word; if that irritates, lower `output.return.bufferMs` as far as
the machine stays clean and set its `latencyMs` to match; check how four
people get headphones from the Flow 8; pull the Flow 8 while the bed plays
(today the bed stops with it, see M2.8) and decide what the host does then;
Sendung and Hörer:innen on the host tablet with the show pinned (M1.16);
restart studiobox once and see the tablets come back (M1.17); a guest scans
their code (M1.18).

### M1b — Beginner-friendly (field tests from 2026-10-07)

studiobox is tested in several live situations from 2026-10-07, by people
who get no long explanation. The page grew one control at a time: live
sliders sit in different places (Musik im Kopfhörer under ⋮, Vorrang as a
panel, trims in the Kanäle grid), setup steps are spread over ⋮, Einmessen
and the terminal, and much that matters lives only in the YAML. 1 is small
enough to land before the tests; 2 and 3 take what the tests show (4) into
account.

1. **Music level on air ("Musik-Lautstärke").** **Done 2026-10-06**: a
   "Musik-Lautstärke" panel under the meters (tech and host), `musicGain` in
   `Graph` (slewed over 50 ms), tests in `graph.test.ts`, `pipeline.test.ts`,
   `roles.test.ts`, `page-queue.test.ts`; still to hear on the rig. Before: no
   control for how loud music sits against the voices: music is auto-levelled
   to `leveler.targetLufs` (−22 LUFS by default, `MUSIC_OVERRIDES` in
   `src/config/load.ts`; per music channel or `filePlayer.processing` in the
   YAML), the bed sits `filePlayer.bed.gainDb` under it, speech ducks it by
   `duck.depthDb`, and the master levels the sum to `master.targetLufs`. The
   only live music slider, `returnGain`, changes the headphones, not the air.
   Add one gain for the whole music path (file player, bed, music pairs),
   after the leveler and before the duck, −12…+6 dB, default 0; `musicGain`
   command, `musicGainDb` in the snapshot, kept in `session-state.json` like
   `returnGainDb`. Allowed for tech and host (the host runs the music).
   _Done when:_ a graph test shows the programme's music moving by the set
   dB while the mics stay put, the change is click-free, and it survives a
   restart within 12 h.
2. **One settings view for the technician ("Einstellungen").** Its own view
   (a file in `src/meters/public/` like `guest.html`, building on M2.1),
   reached from the header, that bundles everything that is set rather than
   operated during a show. The main page keeps only what is operated live.
   Structure, each section with its state in words:

   - **Vor der Sendung**, a checklist in the order of a setup, every step
     with its state and the next one marked (JETZT): devices found (the
     `doctor` checks, live), the Flow 8 gains (the Einmessen advice),
     Einmessen, test tone to the desk, Geräte verbinden (QR codes), eve
     connected, recording armed. A beginner works down the list and is done.
   - **Pegel**: music on air (1), music in the headphones (`returnGain`),
     bed level, host priority (`priorityDepth`), duck depth; each with a
     one-line explanation in plain German, its default and "Zurücksetzen".
   - **Mikros**: per mic label, colour, trim, profile, mute, internal
     (M2.13), host priority yes/no.
   - **Ausgänge**: stream, local output, recording, music return, with their
     faults.
   - **Konfiguration** (read-only): what comes from the YAML and needs a
     restart to change (devices, air delay, look-ahead, folders, roles,
     eve), with the file's path, so nobody searches for why a value cannot
     be changed here.

   The difference between a live setting (kept in `session-state.json`,
   gone after 12 h) and a configuration (YAML) is visible on every value.
   Same allowlist as today: only the tech token gets the view and its
   commands. ⋮ shrinks to what is not a setting (Sendung beenden).
   _Done when:_ someone who has never seen studiobox sets up a session from
   the checklist alone, without the terminal except for the start; every
   live slider of the main page and ⋮ is reachable here; the design
   checklist passes.

3. **Switch down to a lower role ("Ansicht").** One person often takes all
   three roles in a live situation: a distraction-free music player one
   moment, a technician outside the show who surveys every signal the next.
   A tech connection can switch its view to host, guest (with a mic chosen)
   or spectator and back; a host connection to guest or spectator and back;
   guest and spectator get no switch at all.

   - **Never upward.** The token stays the authority: a connection can take
     any role at or below its token's role, never above it. The server
     checks every switch against the token (`Roles.roleOf`) and refuses the
     rest; a `?view=` in a guest's or host's URL can lower but not raise.
   - **The lower role is real, not cosmetic.** While switched down, the
     server applies the lower role's allowlist and snapshot cut
     (`guestSnapshot` / `spectatorSnapshot`), so a stray tap in the player
     view cannot stop the stream. Going back up needs only the switch (the
     token is still the connection's), no new link.
   - The chosen view is remembered per browser; the switch sits in the same
     place on every view and names the role in words ("Ansicht: Host").
   - Open: is the host layout the distraction-free music player, or does
     it need a "Musik" view of its own (browser, queue, transport, music
     level, nothing else)? Decide after the field tests.

   _Done when:_ server tests show a tech connection switched to host is
   refused a tech-only command and gets it again after switching back; a
   host token asking for tech, and a guest token asking for anything, are
   refused; the guest view shows no switch.

4. **Field tests: write down where people stumble.** For every test: who
   ran it (beginner or not), which roles one person held, what they looked
   for and did not find, what they asked, which setting they wanted live
   that is only in the YAML. The list decides the details of 2 and 3 and
   which help texts are missing (the "?" modal included).

### M1c — Record in one room, air from another; listen from anywhere

The recording session of 2026-10-07 runs on a strong machine (maik). Where
it stands is open until the day:

- **a) Separate room.** maik records and streams over the LAN; the Pi
  studiobox in the studio, wired to a channel of the legacy desk, plays that
  stream.
- **b) The studio itself.** maik plays the programme out over USB (sound
  card) straight into the desk.

In both cases the technician sits in the tech room behind the glass, not
hearing the room, with a tablet in the tech role and Bluetooth headphones,
and wants to hear what is being recorded right now, processed and
unprocessed, with a small delay.

Today: the programme goes to an Icecast-protocol server
(`output.harbor`, ffmpeg `icecast://`, Ogg/FLAC or MP3 320; never verified,
see M3) and/or a local sound card (`output.monitor`); both are switched live
on the page (Stream / lokale Ausgabe) and can run at the same time. No
studiobox can play a stream, and nobody can listen on a tablet.

**For 2026-10-07 without new code** (to try on 2026-10-06):

- a) Run an Icecast on maik (`docker compose up icecast` at the repo root,
  or the `icecast2` package), `output.harbor.enabled: true` with
  `url: icecast://source:<pw>@localhost:8000/live`, `format: mp3`,
  `contentType: audio/mpeg` (MP3 because Safari on the iPad plays it; Ogg/FLAC
  it may not). On the Pi stop `studiobox.service` and play the URL straight
  into the card: `ffmpeg -i http://<maik>:8000/live -f alsa plughw:<card>`
  (or `mpv --no-video`). Check that the Pi's playback does not underrun
  over an hour.
- b) `output.monitor` to the USB card, as in the session preset.
- Listening: the tablet opens `http://<maik>:8000/live` in Safari — the
  processed programme, one air delay (10 s) plus Safari's buffer behind the
  room. There is no way to hear the unprocessed signal remotely yet.

Items:

1. **The programme as a stream from studiobox itself** (`/stream`).
   **Built 2026-10-06**: `output.serve` (off by default), `src/audio/serve.ts`,
   the token `meters.roles.tokens.stream` (or an operator's), ⋮ →
   Studio-Stream with the number of connected devices, held to end. A late
   Ogg/FLAC client gets the cached header pages and then the stream. Checked
   over HTTP with ffmpeg as the client; the three-hour run on the Pi waits
   for M1c.2. On maik's side, switching it off ends every connection and
   later requests get 503 "stream off". The Pi's side is M1c.2. maik
   serves the on-air programme (behind the air-delay FIFO, like the harbor
   encoder) over HTTP, so a Pi or any player on the LAN pulls it without an
   Icecast in between. Ogg/FLAC for a box, MP3 for a browser, one encoder
   per format however many listen, started only while someone does. A
   `stream` role token (or the tech/host token), never open.
   _Done when:_ the Pi plays `http://<maik>:4445/stream?k=…&format=flac` for
   three hours without a gap, and stopping maik's output is said on both
   sides.
2. **Play a stream on every studiobox** (playout and live mode).
   **Built 2026-10-06**: `filePlayer.streams` (folder "📡 Streams"),
   `src/audio/stream-player.ts`, `stream-fallback.ts`; playout mode gained
   the bed. Deviation: the clock difference is held by slow resampling only
   (windowed sinc, ±500 ppm, a ~2000 s servo loop), never by dropping or
   repeating, because the programme often has no silence (music under the
   talk). Tested: a 10 s dropout with the bed in between and no click, a
   0.01 % clock difference over 3 h within ±0.5 s of the target (servo
   model), an interpolation SNR above 70 dB. End to end over HTTP with
   ffmpeg: the sender switched off for 6 s → "weg … dort ist der Stream
   aus", reconnect, fade back in. Still to do: three hours on the Pi.
   Streams as
   a source next to the file folders (`filePlayer.streams: [{label, url}]`),
   shown as a row that plays like a file, with its state in words
   ("verbunden", "verbindet neu …", "weg seit 12 s"). Reconnects with
   back-off; while the stream is gone the bed plays (or silence, by config),
   and when it is back it fades in. A jitter buffer (`bufferMs`, default 2 s)
   that holds its fill against the drift between maik's clock and the Pi's
   sound card by slow resampling or by dropping/repeating a block in silence
   (as `AirFifo` does). An option to start the stream at boot, so a Pi wired
   to the desk needs no tablet.
   _Done when:_ in a test the stream drops for 10 s and comes back, and the
   output has the bed in between and no click; a 0.01 % clock difference
   over three hours keeps the buffer within its tolerance.
3. **Output target on the screen and in the config.** **Built
   2026-10-06**: in the ⋮ menu for now (until Einstellungen, M1b.2, exists).
   `output.serve.latencyMs` (default 2600) is the stream path's latency.
   With `both`, Sendezeit follows USB. A switch that moves Sendezeit
   between paths makes the FIFO release up to their latency difference at
   once (≈0.4 s with the defaults). After `both` → `stream`, the desk box's
   buffer holds that much extra until its servo works it off. `output.target`:
   `usb` | `stream` | `both` (the default from the YAML; the session
   presets get one each for a) and b)), switched in Einstellungen →
   Ausgänge (M1b.2) with a press-and-hold, like any end of output. Each path
   keeps its own `latencyMs`, and Sendezeit is computed for the one that
   goes to the desk. The page says which path is on air.
   _Done when:_ switching from USB to stream during a show changes the
   output without a restart and the Sendezeit follows the path's latency.
4. **Listen on the tablet ("Abhören")**, for the tech role (and host?).
   **Built 2026-10-06, not yet tried on an iPad**: `src/audio/listen.ts`
   (`ListenHub`), `/listen` (tech only), panel "Abhören" under the meters.
   One deviation: **one encoder per listener**, not per source. The box
   switches the source inside the running stream (20 ms fade out and in,
   command `listen {id, src}`), because an `<audio>` element that changes
   its URL reconnects and rebuffers. That would be a gap and a jump in time
   for A/B. At most 4 listeners. Roh is the dry mics after their input trim,
   so A/B compares the processing and not the gain staging. Host access is
   still open (today tech only).
   A panel with a play button and a source picker:
   - **Aufnahme** (processed): the programme as it goes into the recording,
     i.e. the look-ahead (6 s) behind the room, not the air delay.
   - **Roh** (unprocessed): the dry sum of the mics, or one mic alone,
     taken from the dry taps at the same point, so switching between the two
     compares the same moment (A/B). The dry taps then run whether or not
     the multitrack is armed.
   - **Auf Sendung**: what leaves the box (= item 1).
     Served as HTTP MP3 (or AAC) from the box: Safari on iOS plays it in an
     `<audio>` element, and it keeps playing with the screen locked. Expected
     delay: the source point + ~1–3 s of browser buffer + Bluetooth (~0.2 s);
     the panel says how far behind the room the listener is. Encoders run
     only while someone listens, one per source. Later, if the delay matters:
     PCM over the WebSocket into Web Audio (well under a second).
     _Done when:_ on an iPad in the tech role with Bluetooth headphones,
     Aufnahme and Roh switch without a gap at the same moment of the show,
     a guest or spectator token gets 403 on the listen URLs, and an idle box
     runs no listen encoder.

### M2 — Stable 1.0 (after the session, target end of 2026-10)

1. **Move the existing page out of `server.ts`** into real files (audit,
   section 5).
2. **Persistence**: queue, trims and assistant results survive a restart, and
   so do the role tokens (generated once, kept beside the session state) and
   the recording's arming (after a crash it resumes in a new file);
   **voice profiles per person**, so regulars start pre-tuned.
3. **Drift correction**: slow resampling (±0.01 %) to hold the FIFO at exactly
   D over any length of show.
4. **Wiring tests** for `pipeline.ts`, `playout.ts` and `graph.ts`.
5. **True-peak limiter** and **music loudness normalisation** (existing TODOs).
6. **HTTPS on the LAN** (Screen Wake Lock needs it; tokens then not readable on
   the shared Wi-Fi). An Origin check on the WebSocket. Automatic reconnect on
   all views.
7. **Multitrack beyond 8 channels** (RF64/WAV or per-channel FLAC).
8. **Playout that survives a lost mixer.** The capture card clocks
   everything: file player, bed, scheduler, recorders and the return advance
   only on capture blocks (`Pipeline.processBlock`), so when the Flow 8 drops
   out the emergency bed and the scheduled jingles stop with it and the
   output plays silence. While the capture is away, clock the blocks from a
   timer (or the output card's pull) with silent mic inputs.
   _Done when:_ in `__tests__/pipeline.test.ts` the capture stops while the
   bed plays and the bed keeps reaching the output; when the capture returns
   the mics are back without a restart.
9. **Fail cleanly.** An `uncaughtException` / `unhandledRejection` handler in
   `src/index.ts`: log, finalise the recordings, exit non-zero for systemd.
   With item 2 a restart then costs the refill of the buffer (D seconds) and
   nothing else.
   _Done when:_ a test that throws inside a block leaves a readable FLAC, and
   the restarted process has the queue, the tokens and the recording back.
10. **Blocking work off the audio thread.** The scheduler's rescan walks the
    folders with `readdirSync` (`FileDirs.entries` under `scheduled()`), and
    `FileDirs.resolve` and `/preview` stat synchronously — on a stalled SMB
    share that holds up the DSP. Make them async like the listing; then
    measure whether the DSP should move to a worker thread.
    _Done when:_ with a file-system stub that blocks for 2 s no block
    overruns its budget, and a soak with the share unplugged logs no `slow:`
    line.
11. **Sound cards found by themselves** (R18). `device: auto`, or
    `doctor --suggest` printing the lines for the YAML: the capture card by
    its channel count, the outputs by name, from `/proc/asound/cards`
    (`parseCards` and `parseStreamChannels` in `src/doctor.ts` exist).
    _Done when:_ on a machine studiobox has never run on, with the Flow 8 and
    one output card plugged in, the session preset starts without a device
    name being edited.
12. **Config typos are reported.** Unknown keys warn at load
    (`listeners.enable: true` today just leaves the feature off). Entry:
    `src/config/load.ts`.
    _Done when:_ a config with a misspelt key produces a warning that names
    it.
13. **Internal mic ("Intern")**: a channel that is heard in the room but not
    on air, so the technician can talk to host and guests without being
    broadcast. The headphones hang on the Flow 8 (direct mics), so the room
    already hears every mic; studiobox only has to keep the channel off the
    programme. Set per channel in the YAML (`internal: true`, default
    `false`; the session preset sets it on `Technik`). Host and technician
    views get a toggle per mic, "Intern" ↔ "Auf Sendung", so the technician
    can go on air spontaneously (a poem, a song with the guests) and back.

    - **Separate from mute.** Its own flag next to `muted`, so "Mikros zu" /
      unmute and the per-row mute never flip it. It reuses the mute path in
      `graph.ts` `process()` (room time, `muteGain` slew, `off` excludes the
      mic from talker, voice detector, ducking, host priority and the
      return's `roomKey`), i.e.
      `off = m.muted || m.internal || this.micsMuted`.
    - **Bleed check.** `loudest` is taken over all mics before the mute, so
      a loud internal mic raises the dominance threshold and can cost
      another mic its talker status (leveler key, ducking). Decide whether
      internal mics are left out of `loudest` and test it with the
      technician talking over the host.
    - **Recordings.** The processed stereo FLAC follows the air (internal
      talk is not in it). The dry multitrack taps before the mute, so the
      internal talk lands on the Technik track. Open: keep it (useful for
      the edit) or silence the track while internal? Default proposal: keep,
      and write the internal on/off times as markers beside the recording.
    - **UI.** The state is shown on every mic row in all operator views
      (clearly distinct from "muted", e.g. its own colour and label, see
      design-guidelines.md); the guest view shows a guest whose mic is
      internal that they are not on air. Commands `channelInternal`
      (`{ label, internal }`) for the `tech` and `host` roles in
      `src/meters/roles.ts`; the state goes out in the meters snapshot.
    - **Persistence:** the live toggle survives a restart with item 2;
      without it the YAML default comes back.

    _Done when:_ in a graph test a channel with `internal: true` contributes
    nothing to the programme, does not duck the music and does not take the
    automix share or host priority; toggling it off brings it on air
    click-free in room time; a mute/unmute of all mics leaves the flag as it
    was; the config loader accepts and validates `internal`.

14. **Definition of stable**: three real sessions in a row without a restart;
    a 4-hour soak without underrun; all four views pass the design checklist;
    tests green; a README that describes the product as it is.

### M3 — Later

- **Harbor feed** (R17): verify the Ogg/FLAC encoder against the station's
  Liquidsoap harbor, reconnect with backoff, stream health on the technician
  view. A harbor feed skips the desk and the Optimod, so studiobox's master
  processing is then the last stage.
- **Dump button**: drop the last seconds of the buffer (the classic broadcast
  delay), then rebuild the delay slowly.
- **Flow 8 over MIDI**: the Flow 8 exposes a USB MIDI port. Check its MIDI
  implementation for mutes and faders (the gain knobs are analog and will
  stay manual).
- Offline re-render of a session from the dry multitrack with changed
  settings.
- Per-mic spectral noise suppression; `packages/core` extraction (existing
  TODOs).

## 6. Decisions

Answered 2026-09-30:

1. **Host priority:** turn guests down **gently, never mute** (M1.8, −8 dB).
2. **The MAYA22 output** goes into the **extern 2× cinch** input of the analog
   desk in the Großes Studio (then Optimod → limiters → UKW/DAB+, stream,
   archive).
3. **Jingles are ducked** like everything else; the host mutes the mics by
   hand. A jingle with a long tail can serve as an intentional bed.
4. **Recording:** configurable, **dry multitrack by default**, plus the
   **processed stereo FLAC**, which matters slightly more (M1.6).
5. **Network:** the venue's Wi-Fi → role tokens mandatory.
6. **Headphones on the Flow 8** → latency doesn't matter. **Buffering is
   preferred over real-time**: up to a minute of delay, with the on-air time
   shown in the UI (section 2). Shows last up to 3 hours.
7. **Flow 8 gains** are analog and manual; all four start at 0 dB. The setup
   assistant measures and advises; studiobox sets everything after the gain.

Still open:

8. **Air delay D:** 10 s recommended (enough for the look-ahead, short
   end-of-show drain). Or a full minute?
9. **Flow 8 USB return:** can the Flow 8 route USB playback into the
   headphone bus without it also going to the Flow 8 main out? (Check in the
   rehearsal or the manual.)
10. **Output latency of the MAYA22 path** (`output.monitor.latencyMs`): the
    pipe and the device buffer behind the FIFO, estimated at ~2190 ms with
    the 2 s buffer of the session preset (~690 ms with ALSA's default). Play a
    jingle stamped for a full minute and compare with the station clock; the
    difference goes into `latencyMs`. Same for the return (`output.return`),
    by ear: talk along to a click.
11. **Roles on the test rig** are off (`meters.roles.enabled: false` in
    `studiobox.local.yaml`) so `http://localhost:4445` keeps working; the
    session preset has them on.
12. **Which eve does the session machine talk to?** Only eve dev on the
    desktop (`http://localhost:3000`) is known. The session needs an eve the
    machine reaches from the venue's Wi-Fi, with the `radio-z` exports and a
    `studiodevice` account, and its public page reachable for the listeners
    (M1.16).
13. **Do guests and spectators see the show from eve?** Today the show, the
    episode and the comments go to host and technician only; a guest sees
    their mic, the running track and the time left. The show's name on the
    guest and spectator views would be harmless; the comments stay with the
    operators.

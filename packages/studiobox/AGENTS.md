# AGENTS.md — packages/studiobox

Agent guidance for the **studiobox** live multichannel auto-mixer. Read the
repo-root `AGENTS.md` first for monorepo setup and conventions; this file covers
the runtime, hardware, and DSP specifics. Package name: `@freieradios/studiobox`.

## What it does

Captures the discrete channels of a USB mixer, applies per-mic DSP, a Dan
Dugan-style gain-sharing automix across the mics (with optional host priority),
and sidechain ducking of music under speech, then sends the programme to a local
sound card and/or as **one lossless Ogg/FLAC** to a Liquidsoap harbor, while
recording it (stereo FLAC + optional multitrack). Reference hardware: Behringer
**Flow 8** (8 inputs + main bus over USB) in, ESI **MAYA22** out.

The live chain is **buffered, not real-time** (see "Buffered live chain" under
Status, and `docs/roadmap-stable.md` section 2): the mics are analysed seconds
ahead of the audio, and the programme leaves a fixed air delay behind the room.

```
room time                                                          air time (room + D)
USB (N ch) ─arecord─► strip, 1st half (trim·HPF·gate·EQ·de-ess·comp)
                        ├─► voice detector (noise floor, speech level) ─► duck plan ─┐
                        └─► leveler: analysis now, audio 6 s later (voice-keyed)    │
                              └─► automix · host priority (decided 150 ms ahead) ─┐ │
file player + bed ─► leveler ─┬─► delay (= mic latency) ─► duck ◄─────────────────┼─┘
                              │                              └────────────────────┴─► master
music pairs ────────► gain ───┤                                        leveler ─► limiter
                              └─► duck (room time, no mics) ─► music return           │
                                                   (mixer USB playback)               │
              stereo FLAC + multitrack FLAC (same blocks, sample-aligned) ◄───────────┤
                                                                                      ▼
                                  air-delay FIFO ─► output card pulls (aplay) / harbor (ffmpeg)
                                                    └─► /stream (Ogg/FLAC, MP3) · Abhören „Auf Sendung“
```

## Commands

```bash
yarn workspace @freieradios/studiobox build      # tsc
yarn workspace @freieradios/studiobox typecheck  # tsc --noEmit
yarn workspace @freieradios/studiobox test        # Jest (DSP unit tests)
yarn workspace @freieradios/studiobox dev         # ts-node, watches .ts/.yaml
yarn workspace @freieradios/studiobox start       # node dist/index.js
yarn workspace @freieradios/studiobox doctor      # preflight, see below
```

`doctor` (also `node dist/index.js doctor [--config …]`) checks the machine
against the config and starts nothing: tools, sound cards and their channel
counts, who holds a device, the output card's mixer level, folders, time zone
and NTP, disk space, the address for the tablets. Exit code 1 when something
has to be fixed. Logic in `src/doctor.ts` (pure checks over an `Env`, tested
against canned `/proc/asound` output in `__tests__/doctor.test.ts`).

Live meters: `http://localhost:4445`.

## Configuration

- Setup-specific config lives in `config/studiobox.yaml` (copy from
  `config/studiobox.example.yaml`). The channel map is fully data-driven: any
  number of mics, optional music pairs, any class-compliant device.
- Per-mic DSP defaults come from named **profiles** in `config/profiles.yaml`,
  overridable per channel.
- Live-mode blocks beyond the channel map, all documented in the example:
  `lookahead`, `airDelay`, `automix.priority`, `output.multitrack`,
  `output.return` (music return), `meters.roles`, `filePlayer.bed`,
  `stateFile`, `listeners` (listener feedback and the episode guide from eve,
  both modes), `autoTrim` (Auto-Pegel), `output.backup.autoArm`,
  `output.musicFree` and `filePlayer.dirs[].musicFree`.
  `config/studiobox.flow8-session.example.yaml` is the preset for a talk
  session (4 mics, MAYA22 out, return, multitrack, roles, bed).
- **Live settings never go into the YAML.** What the setup assistant measured
  and what was trimmed by hand lives in `session-state.json` next to the config
  (`src/setup/state.ts`; git-ignored, restored at start, ignored after 12 h).
- **`hasScheduled` arms every box that reads the folder.** It is scanned
  *recursively* (`FileDirs.scheduled()`), so putting it on a shared sync root
  arms every timestamped file anywhere beneath it — and when two boxes sync the
  same share (the desk box and a playout Pi both pulling the station's
  Nextcloud audio folder), both fire the same file at the same second. Point
  `hasScheduled` at the one subfolder a box is responsible for and give it its
  own `dirs` entry; the share itself stays browsable with `hasScheduled: false`.
  Seen on a playout Pi 2026-10-07: `hasScheduled` on the whole rclone target
  made the Pi play the show folder's intro alongside the studio box.

## Hardware / runtime (the non-inferable bits)

- **Capture device:** use the raw multichannel ALSA device, **not** the
  `*.analog-stereo` PulseAudio node (that one carries only the 2-channel main
  mix). Find it with `arecord -l`. The device name varies by machine/profile —
  the README example is `hw:CARD=FLOW8`; this reference machine exposes it as
  `hw:CARD=F8,DEV=0` (10 channels @ 48 kHz). On PipeWire, set the card to its
  **"Pro Audio"** profile to expose all inputs.
- **Sample rate is 48 kHz, fixed.** The BS.1770 K-weighting coefficients are
  calibrated for it (and guarded at construction). Don't introduce other rates
  without recalibrating loudness.
- **Harbor output:** a Liquidsoap harbor mount that accepts **Ogg/FLAC**, set via
  `output.harbor.url` (reference harbor seen on `http://…:4445`). The stream
  must be flushed so the harbor doesn't stall.
- If capture fails with a device-busy error, check for other holders with
  `fuser -v /dev/snd/*` (or run `doctor`, which names the holder).
- **Two sound cards, two clocks.** The capture card clocks the DSP graph; the
  output card pulls from the air-delay FIFO (`Monitor.writeThen`: the next
  block is written when the pipe took the last one, so nothing queues inside
  Node). The FIFO absorbs the drift; never write the programme to the output
  card push-style from the capture callback again.
- **Latency constants are calibration, not truth.** `output.monitor.latencyMs`
  (pipe + device buffer behind the FIFO; estimated as aplay's 500 ms buffer +
  a full 64 KiB pipe + one block when unset), `output.return.latencyMs` and
  `capture.latencyMs` (default 20) feed the on-air clock. They decide whether
  a jingle stamped 13:00:00 airs at 13:00:00.0 or .3 — measure against a
  reference clock in the rehearsal and set `latencyMs`. The estimate follows
  `bufferMs` when that is set (2000 ms buffer -> ~2190 ms).
- **Give the sound cards long buffers and the process a quiet machine.** With
  ALSA's defaults (500 ms buffers, 125 ms periods) a loaded machine (load 29
  on 16 cores during the first hardware run) made `aplay` underrun several
  times a minute: a Node process that is descheduled for 200 ms can't feed a
  sound card. The session configs therefore set `capture.bufferMs: 2000` /
  `periodMs: 20` and `output.monitor.bufferMs: 2000` / `periodMs: 20` (both
  granted by the Flow 8 and the MAYA22; the output buffer's latency is simply
  part of the air delay) and `output.return.bufferMs: 300`; with those the
  same machine ran clean. The pipeline logs a `slow:` line every 10 s in which
  the event loop stalled, a block overran its budget or the output was left
  waiting (`startHealthProbe` in `pipeline.ts`) — if that shows up in a
  rehearsal, something else on the machine is eating the CPU. Under systemd,
  `Nice=-10` is worth setting; an ordinary user can't raise the priority.
- The **music return** has to go to the card the mics come from (same clock:
  the Flow 8's USB playback is implicit-feedback synced to its capture).
  Open all of its playback channels (`channels: 4` on the Flow 8); the return
  is on 1/2.

## DSP code map (`src/dsp/`)

`graph.ts` wires the chain; per-block files: `biquad`, `channel-strip` (two
halves: `pre()` up to the compressor, `level()` = keyed leveler + gain),
`gate`, `deesser`, `compressor`, `speech-leveler` (mics: voice-keyed, with
look-ahead), `music-leveler` (one gain per item, with look-ahead),
`master-leveler` (talk-keyed), `automix` (Dugan gain-share by power),
`priority` (host priority), `voice` (per-mic voice detector and the duck
planner), `arrival` (who talks, by arrival time: GCC-PHAT on a 16 kHz copy),
`auto-trim` (Auto-Pegel, one controller per mic), `fft`, `duck` (glide and
arming of the duck), `limiter`, `loudness` (BS.1770), `envelope`,
`delay-line`, `dsp-math`. Audio I/O in `src/audio/` (`capture`, `encoder`,
`recorder`, `monitor`, `format`, `file-player`, `bed`, `play-queue`,
`air-fifo`, `sample-clock`, `music-free`); the setup assistant in `src/setup/`
(`measure` = the arithmetic, `session` = the state machine, `state` = the
persisted live settings); config in `src/config/`; web views in `src/meters/`
(`server.ts`, `roles.ts`, `public/`); preflight in `src/doctor.ts`;
listener feedback and the episode guide from eve in `src/listeners/`
(`schedule-rules` = which show is on air, `eve-session` = the read-only login,
`feed` = fetch, socket, poll, `episode` = which episode and its guide,
`markdown` = the guide's text as escaped HTML);
orchestration in `src/pipeline.ts` (live) and `src/playout.ts` (playout-only).

### Gotchas when editing DSP

- **Guard against NaN/denormals.** A prior EQ NaN bug came from unguarded
  coefficient math; verify filters stay finite across the audio range.
- The **limiter** is a sample-peak brick-wall (sliding window-max detector +
  linear attack that settles within the look-ahead window). **True-peak
  (oversampled) limiting is still planned** — sample peaks are bounded, but
  inter-sample peaks are not yet.
- Capture **all** channels declared in the config; silently dropping channels is
  a class of regression that has bitten this code before.
- Keep changes covered by the Jest DSP tests (one suite per block under
  `__tests__/dsp/`; `graph.test.ts` and `lookahead.test.ts` cover the wiring
  and the roadmap's look-ahead criteria, `__tests__/pipeline.test.ts` the live
  pipeline on a virtual clock with no sound card).
- **Latency is part of the graph's contract.** Everything that enters the mix
  has to arrive `Graph.latencySamples` after the room: a new source or tap
  needs a delay line of the right length (mics: gate + leveler + mix
  look-ahead; music: the same plus the return compensation). The click tests
  in `graph.test.ts` fail on a misalignment of one sample.
- **Decisions may lead the audio, never trail it.** A control computed ahead
  (automix share, priority, gate) is combined with its delayed copy so it
  rises early and falls on time — otherwise word endings get cut. Detectors
  that lead get the look-ahead added to their hold.
- **Mutes act in room time** (before the look-ahead delay): what is said after
  "Mikros zu" never airs, what was said before still plays out.
- **Room time vs. programme time in the snapshot:** per-channel fields (levels,
  gate, `speechDb`/`zone`, `active`) are room time; the master meters (LUFS,
  limiter, duck, peak) are `lookaheadMs` later; `air.nowMs` is the on-air time
  of what is said now.
- Test helpers live in `test-support/` (not under `__tests__/`, where Jest
  would run them as suites). Hot loops bind `Math.*` once (`dsp-math.ts`,
  `test-support/voice.ts`): under Jest's vm sandbox a `Math.x` lookup per
  sample makes the DSP suites several times slower.

## Post-production (`tools/post/`, Python)

After a show, `tools/post/post.py <name>.multitrack.json` makes the remaster
(full / ohne Musik, mit Jingles / nur Wort; -16 LUFS), the per-speaker
transcript (md/txt/vtt) and a Mediathek text draft from the dry multitrack
alone — see `tools/post/README.md` for the steps, flags and timings. It is
the hand-made post-production of 2026-10-07 (`recordings/remaster-20261007/`)
as a tool: talker labels by GCC-PHAT like `dsp/arrival.ts`, offline
(non-causal) leveler/automix, acoustic breath detection, faster-whisper per
speaker on the gated dry mic, CrisperWhisper per token for the "äh" cuts
(never words: fei, gell, halt stay), a timeline that maps recording time to
every version. Own venv (`tools/post/setup.sh`), own tests
(`python -m unittest discover -s tools/post/tests`); not part of the Node
build. Runs on the workstation, not on the Pi.

## Status

Implemented: capture, full per-mic DSP chain, gain-sharing automix, ducking,
master leveler + look-ahead limiter, BS.1770 loudness metering, Ogg/FLAC harbor
streaming + rolling FLAC backup, web meters, music auto-leveling, a music-only
mute control, a local audio file player on the meters page (browsing the
configured `filePlayer.dirs` — any local path, including an SMB/CIFS network
share mounted read-only via `/etc/fstab` and pointed at by its mountpoint,
see `studiobox.example.yaml`; the selected folder's files decode to
48 kHz stereo and route into the music path; folders are browsable
recursively — subdirectory rows descend, a breadcrumb shows/changes the
current position; the listing is served async (non-blocking readdir, so a
slow network mount can't stall metering) by `FileDirs.list` and, unless a dir
sets `hideEmpty: false`, subfolders with no audio anywhere within a bounded
depth are hidden (short-circuit probe, per-dir TTL-cached, with bounded readdir
concurrency + a wall-clock budget that fails open — a wide tree on a slow mount
throttles instead of flooding) so only folders with useful contents show — on
a tiny box browsing a big SMB library the probe is best turned off per-dir with
`hideEmpty: false` (see the studiobox Pi config);
`playFile`/schedule names are folder-relative paths like
`Musik/x.flac`; the configured folders are a flat row of tabs above the
listing (`#folderList`, absent with a single folder); the top-right ⋮ menu
holds the local-playout toggle (live mode only) and a "Geplante Sendungen" modal
listing every future timestamped file, served by HTTP `/scheduled`; only dirs marked
`hasScheduled: true` are scanned for auto-play timestamps, so e.g. a music
library can never preempt the program; each dir carries an `icon` emoji —
configurable, else guessed from the label by `guessDirIcon` in `config/load.ts` —
shown on the folder tabs and on the welcome screen, an overlay of the configured
sources as clickable tiles opened by clicking the studiobox title; `/folders`
therefore serves `{label, icon}` objects, not bare strings),
and **"Vorhören"** — browser pre-listening (header toggle, meters page). While
on, clicking a file streams it to the _browser_ from HTTP `/preview` instead of
sending `playFile`, so the operator can audition without touching the on-air
playout. It is deliberately **not** a transcode: `/preview` is a plain
byte-range server (`Accept-Ranges`, 206/416, HEAD) handing over the file's own
bytes, so the browser decodes it and the box spends ~no CPU — measured on the
Pi 3, an mp3 transcode costs ~40% of a core at 1x realtime, which is not worth
spending next to the air chain. Only formats browsers decode natively are
offered (`PREVIEW_TYPES`/`isPreviewable` in `meters/server.ts`: mp3, m4a, aac,
wav, flac, ogg, oga, opus); `.aiff`/`.wma` are refused in the UI rather than
transcoded. Paths resolve through the same traversal-safe `FileDirs.resolve`
as real playout. The pre-listened row is highlighted in the listing (amber
`.cued`, distinct from the on-air `.playing` mark), and when a preview ends the
page auto-advances to the next previewable file. The queue is a _snapshot_ of
the listing Vorhören was started in, pinned to its folder/subpath, so browsing
elsewhere meanwhile neither redirects nor stops the auto-advance; only a
refresh of that same folder adopts the fresh listing (keeping the position on
the file that is playing), and the highlight shows only while that folder is on
screen,
and a **Warteschlange** — a pending play list for both modes, in one panel under
the file browser. On air it lives on the **server** (`src/audio/play-queue.ts`:
`PlayQueue` is the pure ordered list, `QueuePlayer` the glue to `FilePlayer`,
wired identically in `pipeline.ts` and `playout.ts`), because the box is the
player: every open page sees the same list, pushed as a `{type:'queue',items}`
WebSocket message on change and on connect (deliberately _not_ inside the hot
meter frames). The server list is authoritative — the page only sends commands
(`queueAdd`, one file or a batch, `queueRemove`, `queueMove`, `queueClear`,
`queuePlay` = jump, `queueStart`) and renders what comes back. Items carry a
stable server-assigned `id`, so a command from a slightly stale page can never
hit the wrong row (indices would); the list is capped at `MAX_QUEUE` (500) so
"＋ alle" on a big SMB folder stays bounded; and it is **in-memory only** — a
restart comes up empty, the filename-timestamp schedule remains the guarantee
for program playout. The semantics are on-air safety calls, not defaults:
enqueuing **never** starts audio (the operator arms playout with ▶ Start, the
same way the recorder is armed), auto-advance chains only from playback that
ended by itself, an operator ■ Stop ends playback without rolling into the next
item (the list itself survives), a scheduled auto-play preempts as before and
the queue continues once it ends, and files that vanished from the share are
skipped instead of stalling the list. The panel is only on screen while the active list holds something (an empty
queue has nothing to start), and "＋ alle" appends exactly the files of the
listing on screen — it carries their count and is absent for a folder that only
holds subfolders, so it can never read as "add the whole tree".
In Vorhören the same panel holds the
_browser's_ own audition list (the `<audio>` element is the player, so it can
only live there); it takes priority over the folder-roll auto-advance above, and
`→ Playout` hands the whole audition list to the box in one `queueAdd` batch.
**Reinhören** (👂 next to the now-playing name) is the counterpart to Vorhören:
it opens the file that is _on air_ in the browser and seeks to where the box
currently is — the snapshot's `filePosition` plus the age of that frame, so the
seek lands on now, not on the last meter tick. It switches Vorhören on by
itself, and whatever was being auditioned is unshifted onto the head of the cue
queue so it comes back when the on-air preview runs out. It is offered only for
a locatable file in a browser-decodable format, costs the box nothing beyond a
second read of the file (`/preview` byte ranges), and never touches playout.
Seeking is only as accurate as the browser's own byte-offset estimate for the
container (exact for wav/flac/CBR mp3, approximate for header-less VBR mp3).

A **German help modal** sits behind the header "?" (`#help`): a short manual —
what the page is (a remote control; closing it doesn't stop the show), folders,
the queue's arm-then-play rule, Vorhören/Reinhören, filename-timestamp
scheduling, and the recorder/stream/monitor and metering sections, which are
marked `.liveonly` and hidden via `body.playout` (set from `channels: []`) so a
playout-only box never describes controls it doesn't have. Keep it in sync when
operator-facing behaviour changes — it is the only user documentation the
operators see.

**Hörer:innen** — listener feedback from eve (`listeners` in the YAML, off by
default; `src/listeners/`). Listeners send comments and hearts to a show from
eve's public page; a comment waits in eve until somebody who is _not_ at the
microphone releases it (moderation lives in eve, never here). studiobox signs
in as a read-only `studiodevice` account (`EveSession`: 15-min token, single-use
refresh token, sign in again on `invalid-session`) and only ever GETs three
exports of the eve app: `schedule-rules`, `listener-comments` (released only)
and `listener-hearts` (a count per show). **The show on air comes from
studiobox's clock** — Sendezeit in live mode, the wall clock in playout — read
against the schedule rules (`slotAt`: weekday/start hour/duration, weeks of
the month incl. `-1` = last, months, `overrides` beats the regular show,
slots running past midnight; repeats are _not_ slots, a rerun has nobody at
the mic), and both feedback exports are asked with `?since=<slot start>`, so
the screen starts empty at every broadcast. `show:` pins a slug for a
rehearsal outside the slot. Changes arrive over eve's Socket.IO
(`element:changed`, handshake `auth: {token}`; a notification without data →
debounced refetch; a refused handshake renews the token and retries with
back-off), with a slow poll (`pollSeconds`) as fallback; rules are refetched
every 5 min. `ListenerFeed` pushes `{type:'listeners', status}` to operator
connections (technician and host; never guest/spectator) on change and on
connect — not in the meter frames. The page's **Hörer:innen** panel (top of
the right column, both layouts) is deliberately quiet — the earlier
experiment distracted the hosts by pushing every heart and every
raw message onto their screen: folded by default (remembered per browser),
folded it shows only "n Kommentare · k neu" and "♥ n"; no animation, no
sound, no row per heart; nothing on it writes to eve. An unreachable eve or a
refused login is said in words with the time of the last answer, so an empty
list never passes for quiet listeners. Covered by `__tests__/listeners/` and
the Hörer:innen block in `page-queue.test.ts`.

**Sendung** — the episode on air and its conversation guide, from the same
feed and login (`src/listeners/episode.ts`). Three more eve exports:
`episodes` (every show's episodes from yesterday to tomorrow, with the show's
`slug`, `airDate`, `repeat`, `opening`/`closing` markdown), and
`episode-topics` / `episode-questions` (`?episode=<id>`, in the planned
order). `pickEpisode` keeps the one of the show on air whose air date lies in
the slot or on its day (a bare `YYYY-MM-DD` is the local day), never a rerun;
for a pinned show today's. The markdown is turned into HTML **on the box**
(`markdown.ts`: everything escaped, a fixed tag set, links keep their text
only) and the page inserts it as is. The guide travels in the same
`listeners` status (`episode`, `guide`: `pending` · `ok` · `none` ·
`unavailable`) and is fetched on a show change, after an eve edit (at once
for the episode itself or a link from it — `relation:changed` with its
`fromElementId` — otherwise at most every 10 s, so a heart storm does not
refetch it one by one) and every 5 min. It is an extra: an eve without these
exports, or one failing on them, leaves the feedback alone and is asked again
in 5 min (`guideRetryAt`). The page's **Sendung** panel sits above
Hörer:innen, open by default (remembered per browser): show and slot, episode
title, Anmoderation, the topics with their cue lines (notes fold out),
Pflichtfragen (✓ = marked asked in eve), Abmoderation; the sections are
rebuilt only when the guide changes and an open one stays open. Read-only —
questions are ticked in eve. Covered by `episode.test.ts`, `markdown.test.ts`,
the guide block in `feed.test.ts` and the Sendung block in
`page-queue.test.ts`.

**Logo**: `meters.logo` (svg/png/webp/jpg next to the config, checked at
load) replaces the word "studiobox" in the header of the page and the
spectator view (`brandHtml`, `__BRAND__` in `PAGE`, `<h1 id="brand">` in
`spectator.html`); `/logo` serves it to everybody (no token), with a CSP so
an SVG can't run script. `meters.logoAlt` is its alt text. `config/logo-example.svg`
is a placeholder (a waveform in a circle).

**Look and layout** of the page follow `docs/design-guidelines.md` and the
Claude Design mock-ups in `docs/design/studiobox.html` (a bundled artifact —
open it in a browser). What is implemented: the colour tokens as CSS variables
at the top of the page's `<style>` (dark by default, the light set via
`prefers-color-scheme`, plus a `prefers-contrast: more` variant), system UI
font with tabular numerals, 44 px controls, panels separated by surface tone
(no shadows), German labels throughout. Header: title, the recording/stream
toggles as status chips (they say their **state** — "Aufnahme aus" /
"● Aufnahme läuft" — with `aria-pressed`, never an action label), the
connection state in words (`setConn`), the server clock, Vorhören, "?" and ⋮.
Metering (mixer mode only, `body.live`): a **Kanäle** grid — one row per
channel with its state as a word (OFFEN / PAUSE = all mics closed / STUMM /
AN), the channel's optional config `color` (e.g. the mic cable; named or hex,
normalised by `resolveChannelColor` in `config/load.ts`, carried per channel
in the snapshot) as an outlined stripe beside the name, a −60…0 dB level meter with fixed green/yellow/red zones and a 1.5 s
peak-hold tick (`setLevel`, `role="meter"`), gate, comp, automix and leveler
bars, and the Offen/Stumm button — and a **Programm** panel (short-term LUFS
large, peak meter with scale, Spitze/Limiter/Duck tiles). Calm on purpose:
level bars rise at once and fall back at 20 dB/s (`FALL_DB_S`), and the
numbers change once a second (`NUM_MS`) in whole dB — levels and gain
reductions as the highest value of that second, only the large short-term
LUFS with a decimal. A connection whose send buffer still holds the last
frame skips meter frames (`MAX_BUFFERED_BYTES` in `broadcast`), so a tablet
on slow WLAN shows the newest state instead of falling behind; snapshots go
out with two decimals (`toWire`). Footer: the
always-present **transport** — progress bar, the playing title (cut in its
middle, `midName`), the remaining time large, then "Mikros offen/zu" and
"■ Stopp", which is disabled rather than hidden while nothing plays so the
layout never jumps. Unlike the mock-up's "Jetzt läuft" panel, now-playing sits
in the footer: on this combined page the file browser and queue need the
column height.

What the page adds for a live session (each is driven by the snapshot and
hidden where the box does not report it, so a playout box shows none of it):

- **"AUF SENDUNG" chip** (`setAir`). The box cannot see the desk's fader, so
  "on air" is defined once, on the server, as _programme is leaving the box_:
  `onAirOf` in `src/meters/wire.ts` — `air.state` is `live` or `draining` (what
  was said is still going out) **and** an output runs (the harbor stream, or
  the local output unless the test tone has taken the programme's place).
  `MeterServer.broadcast` adds it to every snapshot as `onAir`; it is `null`
  without `air` (playout mode) and the chip is then absent. Filled red is
  reserved for it; the other states are words on an outline ("Puffer füllt",
  "Nicht auf Sendung", "Sendung beendet").
- **Sendezeit.** With `air` the header clock is `air.nowMs` (labelled, with the
  studio clock and the delay small beneath; a delay more than 1 s off target is
  called out), and everything that compares against a filename timestamp uses
  `airNow()` instead of `srvNow()` — timestamps are on-air times.
- **Press-and-hold to end output** (`holdBtn`): ■ Stopp, ending the recording,
  the stream and the local output, "Sendung beenden", and _starting_ the test
  tone. 800 ms with a visible fill (`.hold.holding`), also from the keyboard
  (hold Enter/Space). A short tap never acts: it arms a confirm ("… Nochmal
  tippen", 4 s), and a second tap at least 400 ms later acts — the path for a
  screen reader's activate gesture and for anybody who cannot hold a press.
  Starting stays a single tap. Never a `confirm()`.
  After a recording stop the box keeps writing for the look-ahead (~6 s) and
  reports `recording: true` that long; the chip reads "Aufnahme endet …"
  meanwhile (`recEnding`), so it does not look like a stop that failed.
- **Einstellungen** and **Einmessen** — the technician's own two screens,
  `/einstellungen` (`public/einstellungen.html`, ⋮ → "⚙ Einstellungen") and
  `/einmessen` (`public/einmessen.html`, ⋮ → "🎤 Einmessen"), with tabs
  between them and "← Zum Pult"; both live mode only (`.liveonly` in the
  menu). A host token gets the desk page there, guest/spectator their views.
  What is set once per session rather than played during it, so nothing on
  air can be pressed by mistake while the room reads its sentences.
  `/einmessen`:
  - **Einmessen** on `snapshot.setup`: step tiles with their state as a word
    (ERLEDIGT / JETZT / OFFEN), who is up and the sentence to read, then one
    card per mic (verdict, "vorher → nachher" per setting, the gain advice
    with "Nur diesen Kanal neu messen") and Übernehmen / Verwerfen. The
    buttons are fixed elements switched by phase and the tiles are updated
    in place — nothing is rebuilt under a finger.
  - **Mikrofone jetzt**: per mic the live level, the target zone and the
    current speech level on one −60…0 dB bar, with a ±1 dB trim.

  `/einstellungen` (three sliders, same drag rules: throttled while
  dragging, the final value on release, stale echoes ignored for 1.5 s):
  - **Moderations-Vorrang** (shown when `snapshot.priority` is set): a 0…24
    slider sent as `priorityDepth` (negative dB, throttled while dragging);
    0 = "aus", the session preset's default (only for a guest who talks
    over everybody). A mic held back by it reads **LEISER** on the desk
    (`priorityDb < -1`, `--duck`).
  - **Musik-Lautstärke** (on `snapshot.musicGainDb`): −12…+6 dB sent as
    `musicGain`, one gain on every music source after its leveler and
    before the duck (`Graph.setMusicGain`, slewed over 50 ms). Programme
    only: the return keeps its own `returnGain`. "Zurücksetzen" → 0 dB.
  - **Musik im Kopfhörer** (on `snapshot.returnGainDb`, absent without a
    return): −40…+6 dB sent as `returnGain`, the music return's level only.
  All of it is kept in the state file. On the desk only a header chip
  remains while a run is on or a result waits (a link to the page), and for
  the host the one line on who is up. **Trim** column on the desk: the value
  opens a ±1/±3 dB stepper (`trim`). Tested in `page-queue.test.ts`
  (`boot(…, 'einstellungen' | 'einmessen')` runs that page's script with
  `meter.js`).
- **Bett** button in the footer (`snapshot.bed`, command `bed`; it follows the
  snapshot, no optimistic flip), and in the bed's own folder a 🛏 per file
  (`bedSelect`). While the bed is on by itself (`bed.havarie`) the button
  reads "⚠ Havarie — Bett läuft" in red; a click ends it. **einzeln |
  laufend** in the queue head (`queueMode`).
- ⋮ menu (technician), as rows in groups — **Ausgänge** (local output,
  Ausgang ans Pult, Studio-Stream, Musik-Rückweg), **Sendung**, then the
  ways to other screens; a switch says its state in words plus a dot on the
  right (filled = on; `::before` is the hold fill), and a group whose
  switches the box doesn't have is hidden with its heading when the menu
  opens (`menuGroups`). Sendung: Testton, **Havarie-Bett** an/aus
  (`havarie`; only where `bed.havarie` is configured, `bed.havarieArmed`
  is `null` otherwise), Sendung beenden; then Geplante Sendungen,
  **Geräte verbinden** — the role links as QR codes (`/connect`, technician
  token only, 403 otherwise; SVGs rendered on the box with `qrcode`): one per
  role plus a guest link per mic (`&mic=<label>`, so the guest view opens with
  that mic chosen). The codes point at the address the technician's browser
  used, or the LAN address when that was `localhost`. Unpinned tokens are
  called out: the codes then die at the next start (`Roles.pinned`).

**Views and roles.** `MeterServer` picks the view from the request's role
(`Roles.roleOf`, the `?k=` token — never the route alone, see `viewFor`): a
technician or host token gets this page, a guest token the guest view, anything
else the spectator view; with roles disabled everybody is a technician, `/` is
the page as before and `/guest`, `/spectator` show those views. The page takes
its role from the WebSocket `hello` (`setRole`): `body.host` hides everything
marked `.techonly` / `.td` (processing meters, trims, per-mic mute, Programm,
Vorrang, Einmessen, stream/output switches) and shows the mics as compact
bars — the host layout is this page, not a fourth file; a technician opening
`/host` gets it too. Hiding is convenience: the server's allowlist is the
protection, the file-tree routes (`/folders`, `/files`, `/scheduled`,
`/preview`) answer 403 without an operator token (the page appends its `k` via
`withK`), and guest/spectator connections get a cut-down snapshot and no queue
pushes (`guestSnapshot` / `spectatorSnapshot` in `wire.ts`).
The guest and spectator views are real files in `src/meters/public/`
(`guest.html`, `spectator.html`, shared `tokens.css` and `meter.js`; copied to
`dist/` by `build`, read per request, no build step). Their decisions — mic
state word, zone word and bar height, whose turn it is in the setup assistant,
how far back the spectator looks (it shows what listeners hear _now_, one air
delay behind the room) — are pure functions in `meter.js`, tested in
`__tests__/meters/page-views.test.ts`; the HTML only binds them. The guest view
has no controls during a show: which mic is "mine" comes from `?mic=` in the
link or a one-time chooser (localStorage), one or two mics per tablet.
Until Einmessen has been applied (`setupApplied: false`) the zone is only as
good as the mics' raw sensitivities, and the guest hint says so.
`tokens.css` duplicates the page's tokens until the page moves out of
`server.ts` too (roadmap M2.1) — change both. Routing, gating and the per-role
cuts are covered by `__tests__/meters/server-views.test.ts` and
`wire.test.ts`.

Still open from the mock-ups: a recording timer on the chip, L/R programme
meters and integrated LUFS (the snapshot has neither), and the host mock-up's
per-row "Vorhören / Einreihen" buttons (the page keeps its one Vorhören mode).

Everything that names a file also offers a **jump to where it plays from** —
the now-playing line, the Vorhören bar and every queue row carry a 📂 that
switches the browser to that file's folder/subfolder and flashes its row
(`gotoFile` + the optional focus argument of `loadFiles`). For the on-air file
only the box knows how playback started (click, queue, or schedule), so the
snapshot carries `filePlayingAt: {folder,name}` alongside `filePlaying`, filled
from `FileDirs.locate()` — the reverse of `resolve()`, single-entry memoized
because the snapshot asks per frame; it returns null for files outside the
configured dirs and the page then shows no jump.
Covered by `__tests__/audio/play-queue.test.ts` and
`__tests__/meters/page-queue.test.ts` — the latter boots the meters page's own
script against a small DOM stub (no browser stack, no new dependency) and drives
both queues black-box; it is the place to add regression tests for page logic,
and it re-reads `server.ts`, so a change to the page script can fail it,
and a start/stop recording control on the meters page (the rolling FLAC backup
runs in its own ffmpeg `Recorder` process so it can be toggled live without
disrupting the harbor stream; recording does **not** start automatically — the
operator arms it from the button),
and a start/stop harbor-streaming control on the meters page (the `streaming`
WebSocket command toggles the `Encoder` ffmpeg process; harbor streaming **does**
start automatically when `output.harbor.enabled`, but can be stopped/restarted
live, and the button is hidden when harbor is disabled),
and direct local hardware playout (the finished program is sent to a locally
plugged audio device — sound card / USB interface — via `output.monitor`; the
`Monitor` process uses **aplay** for ALSA and **ffmpeg** for pulse, runs
independently of the harbor encoder and FLAC backup, starts automatically when
`output.monitor.enabled`, and is toggled live with the `monitor` WebSocket
command / meters-page button — except in playout-only mode, where the monitor
_is_ the program output and the toggle is removed),
and scheduled auto-play by filename timestamp (`filePlayer.autoPlay`; a
TypeScript port of the liquidsoap `play_by_filename.liq` semantics in
`src/schedule.ts` — files named `*YYYYMMDD-HHMMSS*` in the file-player folders
start automatically at that local wallclock time — folders are rescanned every
`scanSeconds`, but the nearest upcoming entry is armed on a precise one-shot
timer so playback starts on the timestamp, not on the next poll — preempting
current playback;
the web page marks upcoming files and shows the next pending start; timestamps
are parsed in the **server's** timezone, so the page renders all schedule times
and a live header clock in that zone — keep the box's system TZ set to the
zone operators use in filenames, e.g. `timedatectl set-timezone Europe/Berlin`),
and a **playout-only mode** (`mode: playout` in `studiobox.yaml`): no capture,
no DSP graph, no encoder/recorder — only FilePlayer -> Monitor plus the web UI
(metering hidden, `channels: []` in the snapshot) and the auto-play scheduler.
Orchestrated by `src/playout.ts` (`PlayoutPipeline`); pacing is pull-driven by
the monitor process's stdin drain, so the sound card clocks playback and idle
periods stream silence. Built for the memory/thermally constrained studiobox
Pi 3, which runs this mode as `studiobox.service` (systemd) with the docker
stack (liquidsoap/icecast/radiobox containers) disabled.

### Auto-Pegel, auto-arm, music-free export (2026-10-08)

Lessons of the show of 2026-10-07 (shows start on time without Einmessen;
nobody can reach the Flow 8's gain knobs while people talk; the recording
button was forgotten for 2 minutes; the Mediathek needed a version without
music). All live mode, all on by default from the loader (tests build
configs by hand, so absent = off there).

- **Auto-Pegel** (`autoTrim`, `dsp/arrival.ts`, `dsp/auto-trim.ts`): every
  mic's trim follows the voice in front of it. *Who talks* comes from arrival
  time, not level: per 40 ms hop, GCC-PHAT (150 Hz–4 kHz, ±`maxLagMs`) between
  every pair of mics with signal; the talker is a mic ≥ 12 dB over its floor
  that leads every mic it correlates clearly with by ≥ 0.5 ms (zero-lag
  crosstalk never leads). Only without any clear arrival order does a 6 dB SNR
  lead decide — never against one (at a syllable's end the far mics' delayed
  tail is the loudest thing left). Levels are Einmessen's: raw RMS, no trim,
  frames ≥ 12 dB over the floor (10th percentile of 10 s). `AutoTrim`: power
  mean over the last 10 s of that mic's talk (a sliding window, symmetric up
  and down), a knob turn = last 2 s more than 6 dB off for 1 s → the window
  keeps only those 2 s; trim moves only with ≥ 1.5 s of talk in the last 10 s,
  glides `rateDbPerSec` (3× for a new voice, after a knob turn, or > 6 dB
  off), deadband 0.5 dB, clamped `minDb`..`maxDb`. The graph applies it with
  `ChannelStrip.setTrim` (50 ms glide, nothing rebuilt). **No learning while
  music plays in the room** (the return mix above -45 dBFS, + 1 s) or the mics
  are muted: room speakers reach one mic first too (in the replay a song
  pulled a trim to +29.5 dB before this). A hand trim (`trim`) makes that mic
  manual (`state.manualTrim`, survives a restart); `autoTrim {label?, on}`
  switches back. An applied Einmessen seeds it as 6 s of measured talk.
  Snapshot: per mic `autoTrim` (true/false, null without the feature); trims
  are persisted every 30 s while they change. Validated by replaying the dry
  multitrack of 2026-10-07: 95 % agreement with an offline (numpy) talker
  labelling, trims G1 ≈ 12–22, G2 ≈ 10–25, Host ≈ 15–26 dB over the show
  (the hand trims had ended at 14 / 15.4 / 19), < 1 % of a core for 4 mics.
- **Auto-arm** (`output.backup.autoArm`): `Pipeline.onScheduledStart` arms
  the recording when the scheduler cues a file and nobody has armed it.
- **Music-free export** (`output.musicFree`, `audio/music-free.ts`): the graph
  writes a **talk stem** (`GraphOptions.talkStem`, `aux.talkL/R`): mic bus ×
  master talk gain plus the file player's audio while it plays a file from a
  `musicFree` dir (flag delayed with the audio; the crossfade tail has its
  own flag), through its own limiter — sample-identical to the programme
  where no music plays. Recorded as `<name>.wort.flac`; `TalkLog` keeps
  programme and stem level per 100 ms; after the stop `planKeep` cuts every
  talk-free stretch with ≥ `minCutSec` of music-only frames (programme ≥ 10 dB
  over the stem; 0.3 s kept each side), dead air over 4 s (to 1 s), and
  everything before the first / after the last talk; `exportMusicFree` runs
  ffmpeg (nice 10) twice — loudnorm measure, then linear loudnorm + MP3 —
  into `<name>.ohne-musik.mp3` with a `.json` of the cuts. Talk over music
  stays (the stem has no music under it). The bed rides on the file source,
  so a bed under a musicFree jingle would stay in too.

### Buffered live chain (roadmap M1, backend — 2026-09-30)

Everything below is live mode only (`src/pipeline.ts`); playout mode is
unchanged. Verified by unit tests and an end-to-end run against fake sound
cards; **not yet run on the Flow 8 / MAYA22** (see the roadmap's status table).

- **Look-ahead** (`lookahead`, default 6 s / 15 ms / 150 ms; 6 s + the 2 s
  output buffer leave ~2 s of FIFO in a 10 s air delay, `doctor` checks it).
  Each mic has a **voice detector** (`voice.ts`, 10 ms frames, room time):
  noise floor by minimum statistics over 8 s, the talker's speech level
  learned while the mic is the talker; a frame is _voiced_ above -60 dBFS,
  12 dB over the floor and no more than 18 dB under the speech level. The mic
  leveler (`SpeechLeveler`) counts evidence only while its mic is the _active
  talker_ — gate open, within 10 dB of the loudest mic (`DOMINANCE_DB` in
  `graph.ts`) and voiced, so bleed, rustle and room noise don't pump it. Its
  gain for each moment comes from the speech **around** it: a phrase window
  of ±`responseMs`/2 centred on the audio (as far as the look-ahead reaches),
  leaning on the long-term level when the window holds little speech, plus a
  fast **rider** (±250 ms, 70 %, at most ±`riderDb`, default 6) for a child
  turning away mid-sentence. The boost stops at `maxGainDb` (profiles: +24)
  or where the mic's noise floor would pass `noiseCeilingDb` (profiles: -50).
  The gate opens 15 ms before an onset. Automix shares (by power, compared on
  the input after the trim — without the leveler's gain, so a quiet mic's
  boosted bleed doesn't take the share from the talker) and host priority are
  decided 150 ms ahead of the audio. The **programme duck** is planned
  (`DuckPlanner`): only a stretch of at least `duck.minSpeechMs` (300) of
  voice on one mic, bridging gaps up to 150 ms, with 30 ms of talk-level
  syllables in it (above -50 dBFS or within 10 dB of the mic's speech level)
  counts; it is marked back to its first frame and the music goes down
  3 × `attackMs` before the first word reaches the programme and stays down
  `holdMs` after the last. A bump, a click, a breath or a whisper during a
  jingle doesn't duck. The music return keeps the causal ducker on
  `duck.thresholdDb`.
  **Loudness of the programme**: the music leveler (`MusicLeveler`) gives each
  item (a file; on a live input whatever follows 1.5 s of silence) one gain,
  from its stereo BS.1770 loudness (relative gate -10 LU) from the item's start
  to as far as the look-ahead reaches — a jingle airs at its gain from the
  first sample, a song is not ridden; the music return gets the same causally.
  Music targets -19 LUFS (default), 1 LU over the talk, which comes out of
  the mic levelers at -23 + 3 dB (mono on both channels). The master
  (`MasterLeveler`) starts at `master.targetLufs` minus that (+4 dB), applies
  it to everything, and learns only from confirmed talk (the planner's
  `talking`, 10 s memory, gated against pauses) a correction it applies to
  the mic bus alone — so talk airs at the target and the music keeps its
  relation to it. Tuned on the multitrack recordings of 2026-10-04 by
  replaying the dry channels through the graph (the replay matches the
  recorded programme within ~1 dB).
- **Host priority** (`automix.priority`): listed mics go down by `depthDb`
  (default −8, never below −24: not a mute) while the priority mic talks;
  `priorityDepth` command, `priority` + per-mic `priorityDb` in the snapshot.
- **Air delay and Sendezeit** (`airDelay`, default 10 s). `AirFifo` stamps
  every programme block with the room time of its sound (`SampleClock` maps
  the capture's sample counter to wall time, immune to bursty block arrival)
  and releases it when due. With a sound card it is pull-driven and absorbs
  the two cards' drift within `toleranceSeconds`, nudging back one block at a
  time during silence; without one it is a plain delay line in front of the
  harbor encoder. Snapshot `air`: `targetMs`, measured `delayMs`, `nowMs`
  (= Sendezeit), `state` (`filling` after a start · `live` · `draining` ·
  `ended`), `underruns`, `resyncs`.
- **The schedule runs on Sendezeit.** `Scheduler` takes a clock and a lead;
  an entry is cued 3 s ahead (`FilePlayer.cue`: decodes ahead, starts on the
  sample that carries the timestamp), so a file stamped 13:00:00 _airs_ at
  13:00:00. `nextScheduled`/`/scheduled` times are therefore on-air times.
- **Crossfade** (`filePlayer.fadeOutMs`, default 800): a file that takes over
  from another — a cue on its second, ▶ while one plays, a bed switch —
  doesn't cut it: the old one goes on as the player's _tail_, fading out
  under the new one, which starts as it would have. In live mode the tail
  reaches the graph separately (`FilePlayer.read(…, tailL, tailR)`,
  `Graph.setFileTail`) and keeps the gain its item had
  (`MusicLeveler.tailProgrammeGain` / `tailRoomGain`), so neither item's
  level moves the other's. A track ending by itself in "durchlaufen" mode
  still doesn't overlap the next.
- **"Sendung beenden"** (`endShow`; `false` cancels): closes the mics in room
  time, lets the buffer (and a file still playing) air, then stops the
  recording; `air.state` goes `draining` → `ended`. The output keeps running;
  opening the mics returns to `live`.
- **Music return** (`output.return`): the music/jingle/bed mix, ducked by a
  second, causal ducker, without mics, in room time, to the mixer's USB
  playback. The programme's music is delayed by the return's latency on top of
  the mic latency, so talk and music line up on air as they did in the room.
  `output.return.gainDb` (-60..+12) sets the return's level on its own: the
  music arrives leveled like the programme's, usually far hotter than the
  direct mics in the headphones, and the Flow 8 has no ALSA volume for it.
  Live: `returnGain` command, `returnGainDb` in the snapshot, kept in the
  state file (so it beats the YAML for 12 h).
- **Recording** (`recording` command arms both files): stereo FLAC 24 bit as
  **one continuous file** named by the on-air time of its first sample, with
  Vorbis comments; with `output.multitrack` an N-channel FLAC (mics, stereo
  sources, programme; ≤ 8 channels) written from the same blocks plus a
  `.multitrack.json` channel map. `dry` taps are the raw sources delayed to
  line up with the programme. A stop keeps recording for the look-ahead, so
  what was said up to the button press is in the file (`recording` stays true
  for those ~6 s). `Recorder.stop()` closes stdin and lets ffmpeg finalize.
- **Setup assistant "Einmessen"** (`src/setup/`): `setupStart` (optionally
  `{only:[label]}` to re-measure after a gain-knob change) → 5 s room silence →
  each voice until 6 s of speech are collected (the talking mic is detected
  from the audio; the prompted mic only settles ambiguous frames; bleed onto
  the other mics is measured) → per-mic result: verdict and German gain-knob
  advice (the knob is the one thing studiobox can't set), and the settings it
  _can_ set — input trim (speech to −20 dBFS RMS), gate threshold, compressor
  threshold, HPF from the fundamental, de-esser threshold, leveler seed
  (simulated through the retuned strip), guest-zone centre, automix floor.
  Nothing changes until `setupApply` (`Graph.retune`, click-free, then
  persisted); `setupDiscard` drops it. Snapshot `setup` (`SetupStatus`) shows
  phase, who is up, the sentence to read, progress and results on every view.
  `trim {label, trimDb}` is the hand trim.
- **Guest level indicator**: per mic `speechDb` (RMS after trim, before gate,
  compressor and leveler, only while that mic is the talker; expires 2 s
  after) and `zone` (`low`/`ok`/`high` against `zoneCenterDb` ± `zoneWidthDb`).
- **Bed deck** (`filePlayer.bed`, `src/audio/bed.ts`): a second, looping
  `FilePlayer` summed into the file-player source (leveled and ducked with
  it); `bed` on/off with fades, `bedSelect {folder,name}`, snapshot `bed`.
  **Havarie** (`bed.havarie`, off unless set; `afterSeconds` 10, `belowDb`
  -50): `BedDeck.watch(sound, armed, ms)` is told per block whether anything
  but the bed made a sound — live: an open, unmuted mic gate or a music
  channel from the desk (`Graph.blockSound`) or the file player incl. its
  crossfade tail above `belowDb`, measured before the bed is mixed in;
  playout: the player's block. After `afterSeconds` of silence the bed fades
  in by itself and `bed.havarie` is true; 250 ms of continuous sound (not a
  click) fades it out again. Live mode is armed only while the recording runs
  and the show is `live` (not draining/ended) — "Sendung beenden" ends a
  havarie; playout mode is always armed, so with it on, the gaps between
  scheduled files get the bed. Switching the bed by hand or the stream
  fallback (`set`) turns a havarie into an ordinary bed. The technician's
  switch (`havarie` command, `setHavarieWatch`) is kept in the state file;
  `bedSelect`/`set` are untouched. Tests: `bed.test.ts` ("havarie").
  Switched off and on, it resumes where it was (per file, in memory: the
  position when the fade-out ends, wrapped into the file); choosing a file,
  an unknown length or a dead decoder start it from the top. A mid-file
  start plays the rest once (`-ss`, no `-stream_loop`: combined, ffmpeg cuts
  into the second pass too), then the endless loop from the top takes over
  when that decoder ends (`FilePlayer.play(…, {loop, startSec})`).
- **Queue mode** `queueMode` `single`/`chain` ("einzeln / durchlaufen"); live
  mode starts in `single` (one track, then the talk), playout mode keeps
  chaining. **Test tone** `testTone`: 1 kHz at −18 dBFS on the local output
  only (not recorded, not streamed).
- **Abhören** (`src/audio/listen.ts`, roadmap M1c.4): the technician listens
  on a tablet over `/listen?id=…&src=…` (MP3, tech token only; 400 for a bad
  id/source, 503 beyond 4 listeners). One ffmpeg encoder per listener id,
  spawned on the first request and ended 3 s after its last connection (a
  second request with the same id, e.g. Safari's probe, joins the stream;
  new clients start at an MP3 frame header). Sources: `rec` (the graph
  output, i.e. what the recorder gets), `raw` (dry mics summed, each after
  its trim) and `mic:<label>`, both from the graph's dry taps
  (`GraphOptions.dryTaps`, `aux.dry`: always on with the meters, aligned
  with the programme), and `air` (the blocks that go to the encoder/output
  after the FIFO). The `listen {id, src}` command switches inside the
  running stream with a 20 ms fade out and in, so A/B lands on the same
  moment. `room()`/`air()` return at once while nobody listens. Panel
  `setAbh` (techonly, top of the right column), source remembered per
  browser, the delay behind the room = look-ahead (or air delay) + the
  browser's buffer. **Playout mode too** (`PlayoutPipeline`): a hub with
  `sources: ['air']`, fed the block that goes to the sound card (file, bed
  or stream). The snapshot's `listen.sources` tells the page what a box
  offers; with only `air` the source picker is hidden. 👂 (Reinhören) on a
  playing stream opens Abhören on `air` (`tuneInStream`) rather than giving
  the browser the stream's URL, which may carry the sender's token. For
  files Reinhören stays the browser's own `/preview` fetch.
- **Streams that play like files** (`filePlayer.streams`, both modes,
  roadmap M1c.2): listed as one more folder "📡 Streams" (`FileDirs`;
  `resolve()` gives a `stream:<n>` token, never the URL, which may carry a
  token; `displayName()` gives the label for the snapshot).
  `FilePlayer.play(token)` runs a `StreamPlayer` (`src/audio/stream-player.ts`):
  ffmpeg decodes the URL, a jitter buffer of `bufferMs` (default 2000) fills
  before playback, and a `FillServo` (EMA 10 s, 5e-4 per second of error,
  ±500 ppm) resamples with a 32-tap Kaiser-windowed sinc (512 phases) so
  the buffer holds against the sender's clock. Nothing is ever dropped or
  repeated, except a burst beyond target + 3 s, which is skipped with a fade.
  When the buffer runs dry it fades out (20 ms) and says 'lost'. It
  reconnects with back-off (1, 2, 3, 5 s), and a watchdog ends a connection
  that has carried no data for 5 s once audio flowed, or none at all 15 s
  after it started (an Icecast MP3 takes 5–7 s to its first sample on a Pi
  while ffmpeg probes). The input format (`-f`) comes from the stream's
  `format` or its URL (`streamFormat` in `config/load.ts`), which spares
  ffmpeg the probe. Once refilled it fades in over 1 s and says 'back'.
  The reason comes from ffmpeg's stderr (503/5XX → `off`, 401/403 →
  `refused`, 404 → `missing`). `StreamFallback` (`setupStreams`, shared by
  both pipelines) switches the bed on at 'lost' and off at 'back' or stop,
  and only a bed it switched on itself. With `fallback: silence` it does
  nothing. `autoStart` starts one stream at boot. Snapshot `stream`; the
  page writes its state under the title (`streamWords`). Playout mode has
  a bed now (`filePlayer.bed`, mixed after the player, `bed`/`bedSelect`).
- **Output target** (`output.target`, roadmap M1c.3), with both a monitor
  (USB card) and `serve`: `usb` | `stream` | `both` (default `both`) decide
  which of the two run at start. The `outputTarget` command switches them
  live (`setOutputTarget` arms or stops the monitor and switches
  `serve`). The snapshot carries `outputTarget` (derived from what runs;
  `none` = both off; null without a choice) and `air.path`: the path
  Sendezeit is for, USB while the card runs, else the stream. Released
  through the drain path, blocks leave `serve.latencyMs` (default 2600)
  early while the stream feeds the desk, so they air at Sendezeit there.
  The air delay's floor and `doctor` count the slower of the two paths.
  Page: ⋮ → "Ausgang ans Pult" (USB | Stream | beides). A choice that ends
  a running path is held (`holdBtn`); one that only adds a path is a tap.
  The clock line says "über USB" / "über Stream".
- **Programme stream** (`output.serve`, `src/audio/serve.ts`, roadmap
  M1c.1): `/stream?format=flac|mp3` on the meters port serves what leaves
  the box (fed beside the harbor encoder, after the FIFO), for a Pi at the
  desk in another room. Ogg/FLAC 24 bit with 100 ms pages, or MP3
  (`mp3Kbps`, default 320). One encoder per format, started by the first
  client and ended 3 s after the last one. A late Ogg client gets the
  cached header pages (granule 0) and then whole pages from then on
  (`OggPager`); MP3 clients start at a frame header. Access: the stream
  token `meters.roles.tokens.stream` (no view, no commands;
  `Roles.mayStream`) or a tech/host token; the URL is printed at start.
  On when enabled; `serve` command (tech) switches it, and off ends every
  client and answers 503 "stream off". Snapshot `serve: {on, clients}`;
  `onAirOf` counts it only with a client. ⋮ → Studio-Stream on the page.
- **Roles** (`meters.roles`, `src/meters/roles.ts`): per-connection role from
  the `?k=` token, command allowlist enforced in `MeterServer`; off by default
  (playout boxes), role links (incl. one guest link per mic) printed at start
  when on, and as QR codes under ⋮ → Geräte verbinden.

## TODO / roadmap (pick up here)

Actionable backlog for continued development. Keep this list current as items
land. Each item names a likely entry point and how to know it's done.

The milestone plan toward a stable version (session-ready M1, stable M2) is in
`docs/roadmap-stable.md`; every UI view follows `docs/design-guidelines.md`
(roles, tokens, WCAG 2.2 AA checklist). Local test rigs use git-ignored
`config/*.local.yaml`.

- [x] **Local audio file player on the meters page.** Done: the meters page
      offers a folder dropdown over `filePlayer.dirs` (HTTP `/folders`) and
      lists the selected folder's audio files (HTTP `/files?folder=N`, audio
      extensions only) and `playFile {folder,name}`/`stopFile` WebSocket
      commands play them through a
      virtual "music" `MusicNode` in `src/dsp/graph.ts` (reusing the music
      `leveler`, applied pre-duck, ducked when configured). Decode to 48 kHz
      stereo f32 via ffmpeg lives in `src/audio/file-player.ts`; wiring and
      path-traversal-safe resolution in `src/pipeline.ts`; config in
      `src/config/schema.ts`/`load.ts` + `studiobox.example.yaml`. Covered by
      `__tests__/audio/file-player.test.ts`.
- [ ] **True-peak (oversampled) limiting.** The limiter is currently sample-peak
      only — see the note at `src/dsp/limiter.ts:55`. Add oversampled inter-sample
      peak detection so true peaks stay under the ceiling. _Done when:_ a unit
      test feeding signals with known inter-sample overshoot confirms the
      true-peak output never exceeds the ceiling; existing limiter tests stay
      green.
- [ ] **Pre-scanned file loudness.** The music leveler measures an item as
      it plays (plus the look-ahead), so a song with a quiet intro gets more
      gain until its loud part comes into view. Scanning a file's integrated
      loudness when it is cued/played (ffmpeg ebur128, cached by path + mtime;
      the look-ahead gives ~6 s for it) and handing it to `MusicLeveler` would
      make it a true ReplayGain. Entry: `src/audio/file-player.ts`,
      `src/dsp/music-leveler.ts`. _Done when:_ a file's first aired sample has
      its whole-file gain, with the progressive estimate as the fallback.
- [ ] **Per-mic spectral noise suppression.** New DSP block in `src/dsp/`, wired
      into the per-mic strip in `src/dsp/channel-strip.ts` / `src/dsp/graph.ts`,
      config-gated per channel via `config/profiles.yaml`. _Done when:_ a
      dedicated `__tests__/dsp/` suite passes and it can be toggled off without
      affecting the chain.
- [ ] **Phase 2 — extract shared ffmpeg/harbor helpers into `packages/core`.**
      The capture/encoder/harbor glue (`src/audio/*`) is duplicated in spirit
      with the classic radiobox recorder; factor the common parts into a new
      workspace both packages depend on. _Done when:_ studiobox builds and tests
      pass against the extracted package with no behavioural change.

When tackling any of these, follow the DSP gotchas above (NaN/denormal guards,
capture all configured channels, keep `__tests__/dsp/` green) and the root
AGENTS.md conventions (Prettier, Conventional Commits).

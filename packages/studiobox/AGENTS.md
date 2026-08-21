# AGENTS.md — packages/studiobox

Agent guidance for the **studiobox** live multichannel auto-mixer. Read the
repo-root `AGENTS.md` first for monorepo setup and conventions; this file covers
the runtime, hardware, and DSP specifics. Package name: `@freieradios/studiobox`.

## What it does

Captures the discrete channels of a USB mixer, applies per-mic DSP, a Dan
Dugan-style gain-sharing automix across the mics, and sidechain ducking of music
under speech, then streams **one lossless Ogg/FLAC** to a Liquidsoap harbor while
keeping a rolling local FLAC safety recording. Reference hardware: Behringer
**Flow 8** (8 inputs + main bus over USB).

```
USB (N ch) ─ffmpeg─► capture ─► per-mic strip (HPF·gate·EQ·de-ess·comp·leveler)
                                  ├─► Dugan gain-share automix ─┐
            music pairs ─► gain ──┴─► duck (sidechain on mics) ─┴─► master leveler
                                                                 ─► limiter ─► ffmpeg FLAC
                                                       ┌──────────────┴─────────────┐
                                                 Icecast→harbor               local .flac
```

## Commands

```bash
yarn workspace @freieradios/studiobox build      # tsc
yarn workspace @freieradios/studiobox typecheck  # tsc --noEmit
yarn workspace @freieradios/studiobox test        # Jest (DSP unit tests)
yarn workspace @freieradios/studiobox dev         # ts-node, watches .ts/.yaml
yarn workspace @freieradios/studiobox start       # node dist/index.js
```

Live meters: `http://localhost:4445`.

## Configuration

- Setup-specific config lives in `config/studiobox.yaml` (copy from
  `config/studiobox.example.yaml`). The channel map is fully data-driven: any
  number of mics, optional music pairs, any class-compliant device.
- Per-mic DSP defaults come from named **profiles** in `config/profiles.yaml`,
  overridable per channel.

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
  `fuser -v /dev/snd/*`.

## DSP code map (`src/dsp/`)

`graph.ts` wires the chain; per-block files: `biquad`, `channel-strip`, `gate`,
`deesser`, `compressor`, `leveler`, `automix` (Dugan gain-share), `duck`
(sidechain), `limiter`, `loudness` (BS.1770), `envelope`, `delay-line`,
`dsp-math`. Audio I/O in `src/audio/` (`capture`, `encoder`, `format`);
config in `src/config/`; web meters in `src/meters/server.ts`; orchestration in
`src/pipeline.ts`.

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
  `__tests__/dsp/`).

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
`Musik/x.flac`; the top-right ⋮ menu holds the flat folder list, the
local-playout toggle (live mode only) and a "Scheduled files" modal listing
every future timestamped file, served by HTTP `/scheduled`; only dirs marked
`hasScheduled: true` are scanned for auto-play timestamps, so e.g. a music
library can never preempt the program; each dir carries an `icon` emoji —
configurable, else guessed from the label by `guessDirIcon` in `config/load.ts` —
shown in the ⋮ menu and on the welcome screen, an overlay of the configured
sources as clickable tiles opened by clicking the studiobox logo; `/folders`
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
and a live footer clock in that zone — keep the box's system TZ set to the
zone operators use in filenames, e.g. `timedatectl set-timezone Europe/Berlin`),
and a **playout-only mode** (`mode: playout` in `studiobox.yaml`): no capture,
no DSP graph, no encoder/recorder — only FilePlayer -> Monitor plus the web UI
(metering hidden, `channels: []` in the snapshot) and the auto-play scheduler.
Orchestrated by `src/playout.ts` (`PlayoutPipeline`); pacing is pull-driven by
the monitor process's stdin drain, so the sound card clocks playback and idle
periods stream silence. Built for the memory/thermally constrained studiobox
Pi 3, which runs this mode as `studiobox.service` (systemd) with the docker
stack (liquidsoap/icecast/radiobox containers) disabled.

## TODO / roadmap (pick up here)

Actionable backlog for continued development. Keep this list current as items
land. Each item names a likely entry point and how to know it's done.

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
- [ ] **Fuller music loudness normalization.** Build on the existing music
      auto-leveling toward proper BS.1770-targeted normalization of music pairs
      (entry: `src/dsp/leveler.ts`, `src/dsp/loudness.ts`). _Done when:_ music
      sources converge to the configured target LUFS with tests covering the
      gain trajectory.
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

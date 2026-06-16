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
mute control.

## TODO / roadmap (pick up here)

Actionable backlog for continued development. Keep this list current as items
land. Each item names a likely entry point and how to know it's done.

- [ ] **Local audio file player on the meters page.** Add, alongside the input
      channel level indicators, a list of audio files from a configured local
      directory; clicking a filename plays that file through the mix as if it
      arrived on a Flow8 input channel dedicated to **music** — i.e. routed into
      the existing music path so it gets the same AGC loudness normalization and
      sidechain ducking. *Entry points:* the self-contained page + WebSocket
      control protocol in `src/meters/server.ts` (extend `MeterCommand` with
      list/play/stop commands and add an HTTP route that returns the directory
      listing — restrict to audio extensions, never expose paths outside the
      configured root); a virtual "music" source feeding the music bus in
      `src/dsp/graph.ts` (reuse `MusicNode` + its `leveler`, applied pre-duck)
      wired in `src/pipeline.ts`; file decode to 48 kHz stereo f32 via ffmpeg in
      `src/audio/` (mirror `capture.ts`/`encoder.ts`). Add the browsable
      directory to `config/schema.ts` + `studiobox.example.yaml`. *Done when:*
      the page lists audio files from the configured directory, clicking one
      plays it into the mix at a consistent normalized loudness (same target as a
      music input), it ducks correctly under live mic speech and honors the
      "music only" mute, playback can be stopped/switched, and path traversal
      outside the configured root is rejected.
- [ ] **True-peak (oversampled) limiting.** The limiter is currently sample-peak
      only — see the note at `src/dsp/limiter.ts:55`. Add oversampled inter-sample
      peak detection so true peaks stay under the ceiling. *Done when:* a unit
      test feeding signals with known inter-sample overshoot confirms the
      true-peak output never exceeds the ceiling; existing limiter tests stay
      green.
- [ ] **Fuller music loudness normalization.** Build on the existing music
      auto-leveling toward proper BS.1770-targeted normalization of music pairs
      (entry: `src/dsp/leveler.ts`, `src/dsp/loudness.ts`). *Done when:* music
      sources converge to the configured target LUFS with tests covering the
      gain trajectory.
- [ ] **Per-mic spectral noise suppression.** New DSP block in `src/dsp/`, wired
      into the per-mic strip in `src/dsp/channel-strip.ts` / `src/dsp/graph.ts`,
      config-gated per channel via `config/profiles.yaml`. *Done when:* a
      dedicated `__tests__/dsp/` suite passes and it can be toggled off without
      affecting the chain.
- [ ] **Phase 2 — extract shared ffmpeg/harbor helpers into `packages/core`.**
      The capture/encoder/harbor glue (`src/audio/*`) is duplicated in spirit
      with the classic radiobox recorder; factor the common parts into a new
      workspace both packages depend on. *Done when:* studiobox builds and tests
      pass against the extracted package with no behavioural change.

When tackling any of these, follow the DSP gotchas above (NaN/denormal guards,
capture all configured channels, keep `__tests__/dsp/` green) and the root
AGENTS.md conventions (Prettier, Conventional Commits).

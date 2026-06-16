# studiobox

Live multichannel auto-mixer for community radio. Captures the discrete
channels of a USB mixer (reference hardware: Behringer **Flow 8**, which exposes
its 8 inputs + main bus over USB), applies per-channel DSP, a Dan Dugan-style
gain-sharing automix across the mics, and sidechain ducking of music under
speech, then streams **one lossless FLAC** to a Liquidsoap harbor — with a local
FLAC safety recording.

Part of the [radiobox](../../) workspace. Shares its stack (TypeScript +
ffmpeg + Liquidsoap/Icecast) but runs as a separate long-lived service on the
machine physically connected to the mixer.

## Signal flow

```
USB (N ch) ──ffmpeg──► capture ──► per-mic strip (HPF·gate·EQ·de-ess·comp·leveler)
                                     │
                                     ├─► Dugan gain-share automix ─┐
                                     │                              ├─► master leveler
              music pairs ──► gain ──┴─► duck (sidechain on mics) ──┘     → true-peak limiter
                                                                          → ffmpeg FLAC
                                                          ┌───────────────┴──────────────┐
                                                    Icecast→harbor                local .flac
```

## Configuration

Everything setup-specific lives in `config/studiobox.yaml` (copy from
`studiobox.example.yaml`). The channel map is fully data-driven: any number of
mics, optional music pairs, any class-compliant device. Per-mic DSP defaults
come from named **profiles** in `config/profiles.yaml` and can be overridden
per channel.

> Find the multichannel capture device with `arecord -l`. Use the raw
> multichannel device (`hw:CARD=FLOW8`), **not** the `*.analog-stereo`
> PulseAudio node — that one only carries the 2-channel main mix. On PipeWire,
> set the card to its "Pro Audio" profile to expose all inputs.

## Run

```bash
yarn workspace @freieradios/studiobox build
yarn workspace @freieradios/studiobox start        # uses config/studiobox.yaml
# or during development:
yarn workspace @freieradios/studiobox dev --config config/studiobox.example.yaml
```

Open `http://localhost:4445` for live meters.

## Requirements

- Node.js 20+, ffmpeg on `PATH` (built with FLAC + ALSA/PulseAudio support).
- A harbor mount configured to accept **Ogg/FLAC** (set `output.harbor.url`).
- Runs at **48 kHz** (the BS.1770 loudness coefficients are calibrated for it).

## Status — Phase 1 scaffold

Implemented: capture, full per-mic DSP chain, gain-sharing automix, ducking,
master leveler + look-ahead limiter, BS.1770 loudness metering, Ogg/FLAC harbor
streaming + rolling FLAC backup, web meters.

Planned: true-peak (oversampled) limiting, music loudness normalization,
per-mic spectral noise suppression, unit tests for each DSP block, and (Phase 2)
extracting the shared ffmpeg/harbor helpers into `packages/core`.

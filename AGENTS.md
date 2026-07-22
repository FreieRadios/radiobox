# AGENTS.md

Guidance for AI agents (Claude Code, JetBrains Junie, Codex, Copilot, …) working
in this repository. Human-facing overviews live in the `README.md` files; this
file is the operational source of truth for agents. Keep it current.

## What this repo is

**radiobox** — a TypeScript toolbox for community radio stations. A single
deployment can act as a schedule manager/exporter, a recorder, an
autopilot/publisher, or (via the bundled `liquidsoap/` container) the on-air
streaming brain. Most behaviour is toggled through `.env` flags rather than code
changes; see `README.md` for the role presets.

It is a **Yarn 1 workspaces monorepo** (`packages/*`). The root package is the
classic radiobox library; `packages/studiobox` is a newer live multichannel
auto-mixer that shares the stack but runs as its own long-lived service.
studiobox also has a low-footprint `mode: playout` (file player + web UI +
timestamp-scheduled auto-play, no capture/DSP) that replaces the liquidsoap
play-by-filename container on machines too small for the docker stack — see
`packages/studiobox/AGENTS.md`.

## Setup

- **Node.js 20+** (developed on v20.20.x). **Yarn 1.x** (`yarn@1.22.22`,
  pinned via `packageManager`). Do **not** use npm to install.
- `ffmpeg` must be on `PATH`, built with FLAC + ALSA/PulseAudio support.
- Install once at the repo root: `yarn install` (hydrates all workspaces).

## Commands

Root workspace (classic radiobox library):

| Task | Command |
|------|---------|
| Build | `yarn build` (`tsc`) |
| Dev | `yarn dev` |
| Tests | `yarn test` (Jest) · coverage: `yarn test-coverage` |
| Format | `yarn format` (write) · `yarn format:check` |
| Autopilot | `yarn autopilot` / `yarn dev:autopilot` |

Target a specific workspace with `yarn workspace <name> <script>`, e.g.
`yarn workspace @freieradios/studiobox test`. See
`packages/studiobox/AGENTS.md` for studiobox-specific commands and runtime
details.

## Conventions

- **Language:** TypeScript throughout. Match the style of surrounding code.
- **Formatting:** Prettier. Run `yarn format` before finishing; don't hand-format.
- **Tests:** Jest. DSP and pure-logic changes should come with/keep unit tests
  green. Run the relevant workspace's `test` script before declaring done.
- **Commits:** Conventional Commits with a scope, e.g.
  `feat(studiobox): …`, `fix(studiobox): …`. Co-authored commits append the
  trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
  Only commit/push when the user asks; branch first if on `main`.

## Layout

```
radiobox/
├── src/                     classic radiobox library (schema, schedule, recorder, autopilot)
├── liquidsoap/              on-air mixer container (.liq presets, mounts)
├── packages/studiobox/      live multichannel auto-mixer (see its own AGENTS.md)
└── docker-compose.yml       services (liquidsoap, icecast2, …) toggled via .env
```

## Gotchas

- All roles share one root `.env`; switching behaviour usually means flipping
  flags, not editing code. Don't hardcode what belongs in `.env`.
- Server-side only — this code assumes a Node environment with ffmpeg, not a
  browser.
- studiobox runs at **48 kHz** by design (loudness coefficients are calibrated
  for it) — see its AGENTS.md before touching sample-rate assumptions.

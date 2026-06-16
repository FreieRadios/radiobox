# Project guidelines (JetBrains Junie)

Follow the instructions in the repository's `AGENTS.md` (root) and
`packages/studiobox/AGENTS.md` (the studiobox live auto-mixer). They are the
single source of truth for setup, commands, conventions, and the
hardware/DSP-specific gotchas — read them before making changes.

Quick reference:

- Yarn 1 workspaces monorepo; install with `yarn install` at the root (not npm).
- Node 20+, `ffmpeg` on `PATH` (FLAC + ALSA/PulseAudio).
- Build `yarn build`, test `yarn test` (Jest), format `yarn format` (Prettier).
- studiobox: `yarn workspace @freieradios/studiobox <build|test|dev|start>`;
  runs at 48 kHz; live meters on `http://localhost:4445`.
- Commits: Conventional Commits with a scope, e.g. `feat(studiobox): …`.

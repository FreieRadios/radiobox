# Replay harness

Feeds the dry tracks of a recorded session (the multitrack's mics and the
player track) through the real live `Graph` (`src/dsp/graph.ts`) and logs,
per 40 ms arrival hop, what Auto-Pegel, the automix and the levelers did.
It answers questions like "does Auto-Pegel find the trims for this show?"
or "what does the automix do while two people talk at once?" with the
production code instead of a model of it. Nothing in `src/` is changed; the
harness reads a few private fields of the graph and wraps them.

```bash
cd packages/studiobox
nice -n 15 npx ts-node -T tools/replay/replay.ts --out /tmp/replay/show \
  --mics "g1.flac,g2.flac,host.flac,tech.flac" --music "player.flac" \
  [--seed seed.json] [--law power|alpha=0.5|floor=-6] [--start S --dur S] [--no-programme]
```

- `--mics`: 1–4 mono dry tracks, sample-aligned (as studiobox writes them),
  labelled G1, G2, Host, Tech in that order. Profiles come from the session
  preset by position (condenser, condenser, dynamic-broadcast, ...).
- `--music`: the player track (stereo). Fed as the file player; it also
  drives the room-music hold of Auto-Pegel.
- `--seed`: JSON `{ "G1": 27.7, ... }`, start trims trusted as 6 s of talk,
  as an applied Einmessen would leave them (trim only).
- `--law`: automix share law for experiments: `power` (production),
  `alpha=a` (share ∝ power^a), `floor=d` (a voiced talker is never cut more
  than d dB); combine with a comma.

Config is the session preset `config/studiobox.flow8-session.example.yaml`
plus `config/profiles.yaml` through the production loader (`--config` for
another file). Runs at about 6–8x real time per process (one core plus
ffmpeg); an hour-long show takes 8–10 min.

## Output

- `hops.f32` / `hops.json`: float32 matrix, one row per 40 ms hop; columns
  in `hops.json`. All columns are aligned to room time. Per hop: `t`,
  `talker` (arrival label, -1 = none), `musicHold` (Auto-Pegel paused for
  room music), `outE` / `busE` (programme / mic bus mean square), and per
  mic `lev` / `floor` (raw dBFS, as Auto-Pegel sees them), `trim`,
  `talkSec`, `amxDec` (automix gain as decided), `amxApp` / `amxAppDb`
  (gain applied to the audio, mean linear / mean dB), `contribE` (the mic's
  mean-square contribution to the bus), `active` / `voiced` / `gate`
  (fractions of the hop), `levelerDb`.
- `programme.flac`: the replayed programme, aligned with the input (the
  graph's latency removed).
- `summary.json`: final trims, talk seconds, config bits.

Read the matrix with numpy:

```python
import json, numpy as np
meta = json.load(open('hops.json'))
M = np.fromfile('hops.f32', np.float32).reshape(meta['rows'], len(meta['columns']))
```

## Differences to a live run

Block size 1920 (one hop) instead of 1024; no mutes (the mics were closed
for songs live; the room-music hold still stops Auto-Pegel learning
there); music items are runs of player audio after 1 s of silence (the
recording carries no file names); the player track is already in room time,
so it goes in with `musicDelayMs: 0`.

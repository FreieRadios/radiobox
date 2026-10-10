# studiobox post — post-production of a recording

After a show, `post.py` turns studiobox's own files — the dry multitrack
(`<name>.multitrack.flac` + `.multitrack.json`) and, when there is one, the
`.ohne-musik.json` sidecar of the music-free export — into what the editors
hand on:

| File | What |
|------|------|
| `<Title> <date> – <subtitle>.mp3` | the show, remastered: every voice re-leveled from its own dry mic, breaths −10 dB, "äh"/"ähm" cut, music leveled and ducked, −16 LUFS, true peak ≤ −1 dBTP |
| `… (ohne Musik, mit Jingles).mp3` | the songs dropped (0.5 s pause instead), the station's jingles kept |
| `… (nur Wort).mp3` | songs and jingles dropped |
| `… – Transkript.md / .txt / .vtt` | per-speaker transcript, times of the full version; uncertain words `[? … ?]` and a list "Zum Gegenlesen" |
| `… – Mediathek-Text.txt` | draft of the Mediathek text (teaser + text) from a local LLM, with `--facts` |
| `work/` | every step's result (see below) |

It was built from the hand-made post-production of a show on 2026-10-07
(`recordings/remaster-20261007/`, prototypes there, git-ignored) and produces
the same filler cuts and talker labels on that show. The programme channels
tell it when the mics were on air (what is left after fitting the dry music
channel to the programme), so chatter into muted mics — during songs, after
the outro — never reaches the output, and the show ends with the outro.

## Setup

```sh
./setup.sh                       # python3 -m venv .venv + requirements.txt
.venv/bin/python -I post.py --help
```

Needs `ffmpeg` on PATH. Whisper models download from Hugging Face on first
use (`~/.cache/huggingface`): `large-v3-turbo` (per speaker) and
`nyrahealth/faster_CrisperWhisper` (per-token times for the fillers). The
summary needs llama.cpp's `llama-server` and a GGUF model (default
`~/models/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`, `~/opt/llama.cpp/vulkan-x64`; the
GPU needs the user in the `render` group — `sg render -c '…'`).

## Run

```sh
.venv/bin/python -I post.py recordings/studiobox-20261101-180000.multitrack.json \
  --title "Meine Sendung" --subtitle "Folge 12" \
  --speaker "Gast 1=Maria" --speaker "Gast 2=Jonas" --speaker "Host=Lena" \
  --vocab show-vocab.txt --music "2=David Bowie – Changes" \
  --facts facts.txt
```

- `--speaker CHANNEL=NAME` names the person at a mic (channel names from the
  `.multitrack.json`); unnamed mics keep their channel name. Mics without a
  signal are left out (`--mics` to choose by hand).
- `--vocab FILE` (repeatable): names and terms of the episode, one per line,
  given to Whisper as hotwords; `vocab/default.txt` (radio words) and, if
  present, `vocab/local.txt` (the station, its region and dialect; git-ignored,
  kept per machine) are always included, as are the speaker names.
- `--music N=LABEL` labels the Nth item of `work/items.json` in the transcript.
- `--fix FROM=TO` replaces text in the transcript (e.g. a misheard name).
- `--facts FILE`: the fact block for the Mediathek text — German, one line
  each: `Sendung:`, `Datum:`, `Sendeplatz:`, `Moderation:`, `Gäste:`,
  `Links:`, `Musik:`, `Technik:` (first names only; the model is told to use
  nothing but this block and the transcript). Without it the summary step is
  skipped.
- `--seconds FROM TO` uses only that span of the recording — the way to try
  settings in minutes instead of hours, or to trim by hand. Without it the
  show ends with the first jingle after the last talk that was on air (the
  outro); music the file player put out after that, and chatter into the
  muted mics, while the recording still ran, are dropped.
- `--steps a,b,…` runs only those steps; `--force` redoes them. A step whose
  result is already in `work/` is skipped, so a run can be resumed.
- `--threads N` for Whisper (default half the cores), `--token-beam` for the
  per-token pass (1 = fastest; 5 was the prototype).

Time for a one-hour show on the Ryzen AI 7 350 (8 threads,
`nice`): audio steps 3 min, Whisper 4 min per speaker, the per-token pass
46 min for 53 min of talk (beam 1), render + encode 3 min, summary 4 min on
the GPU — 65 min in all. The box runs at its thermal limit meanwhile; at night
or with `--threads 4` it stays cooler. Skip `tokens`/`fillers` for a quick
version without filler cuts.

## Steps and `work/`

| Step | Result | What |
|------|--------|------|
| decode | `c<n>.raw` | the multitrack's channels as f32 mono |
| talker | `talker.npz` | who talks per 50 ms frame: GCC-PHAT arrival time between the dry mics (same rule as live `dsp/arrival.ts`) |
| music | `items.json`, `onair.npy` | what the file player put out: start/end, `song` or `jingle` (sidecar cuts, else longer than `--jingle-max-sec`); when the mics were on air (what is left of the programme after fitting the dry music channel to it) |
| breath | `breath.npz` | breaths per mic (0.22–0.9 s unvoiced, 10–40 dB under the voice, own speech within 1.5 s) → −10 dB envelope |
| mix | `bus.f32`, `mic-<k>.f32`, `mix.npz` | per-mic leveler (talker frames to −26 dB K-weighted, Gaussian 2 s / 30 s), expander, compressor, breath reduction, gain-sharing automix; mics closed during songs except talk running into or out of them, and wherever they were off air for 10 s or more; three correction passes on the bus |
| asr | `asr-<k>.json/.txt/.wav` | large-v3-turbo on each speaker's gated leveled mic, words with probabilities |
| tokens | `tokens.json/.txt` | CrisperWhisper per token on the talk bus, only where the mics are open |
| fillers | `cuts.json` | "äh"/"ähm" cuts snapped to the quietest 10 ms between the neighbouring tokens (never words — dialect particles like fei, gell, halt stay) |
| render | `render-<mode>.f32/.json` | the three versions along a timeline (cuts with 15 ms crossfades, dropped items with 0.5 s pause and fades), −16 LUFS |
| encode | the MP3s, `loudness.json` | 256 kbit/s, 4× oversampled limiter, ID3 tags, ebur128 check |
| transcript | the transcript files, `transcript-llm.txt`, `dropped-fragments.txt` | words merged by time; bleed (same word on another mic at the same time while this person hardly talks) and garbled fragments removed; times mapped through the full version's timeline |
| summary | the Mediathek text, `summary.json` timings, `summary.server.log` | llama-server with `prompts/mediathek-system.txt` + facts + transcript |

`render-<mode>.json` holds the timeline (kept pieces of the recording →
output seconds), so any recording time can be mapped to the MP3.

## Tests

```sh
.venv/bin/python -I -m unittest discover -s tests
```

## Known limits

- One show = one recording. The show of 2026-10-07 missed its first two
  minutes (recording started late); the prototype patched them in from the
  aired stream, the tool does not (auto-arm now starts the recording with the
  scheduler).
- Talk over a song's middle (not running into or out of it) is treated as
  bleed from the room speakers and stays closed.
- Cough/laughter cuts: not built (list them for the editor, never cut blindly).
- Vocabulary from eve's episode guide: planned; today `--vocab`.

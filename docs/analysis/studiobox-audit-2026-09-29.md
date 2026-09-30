# radiobox / studiobox — audit and readiness for the live session

**Date:** 2026-09-29 · **Status:** audit, no code changed · **Session:** week of
2026-10-05

Scope: state of the repository, what is missing for the planned live session
(three mics on a Behringer Flow 8, a laptop, two iPads, scheduled jingles,
click-to-play files, a prepared playlist), repository cleanup, where to host,
and the overlap with AURA.

Statements are marked the same way as in the AURA comparison:

- **[checked]** — read in the source or run on 2026-09-29.
- **[judgement]** — an assessment, not a fact.
- **[not verified]** — could not be tested here. No Flow 8 and no iPad were
  connected to the machine this audit ran on.

---

## 1. Summary

1. **The Pi and the repository are in sync.** Vorhören, Reinhören and the
   Warteschlange are all on `origin/studiobox`; the Pi reports a clean tree and
   nothing unpushed. **[checked]**
2. **studiobox is healthy.** 23 test suites, 153 tests, typecheck and Prettier
   all pass. **[checked]**
3. **The session is feasible, but three things are missing in the code** and
   one in the setup:
   - what the room hears (section 3.1) — the biggest open point,
   - a display-only page for the guests (3.2),
   - a playlist that plays **one** track and then stops (3.3),
   - a preflight check so the laptop really is plug and play (3.5).
4. **Live mode has not run since June.** All work since July was done on the
   Pi in `playout` mode. The combination "live mode + file player + monitor
   output" has never run on hardware. **[judgement from the config history]**
   A rehearsal with the real Flow 8 is not optional.
5. **Keep the monorepo, keep GitHub, add the Gitea as a mirror** (sections 6
   and 7). **[judgement]**
6. **studiobox and the eve bridge do not reinvent AURA** as long as both stay
   narrow (section 8). **[judgement]**

---

## 2. State of the code

| Check                                  | Result                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| studiobox tests                        | 23 suites / 153 tests pass **[checked]**                       |
| studiobox typecheck                    | passes **[checked]**                                           |
| Prettier, root and studiobox           | clean **[checked]**                                            |
| Root (classic radiobox) tests          | **3 of 4 suites fail** on a fresh checkout **[checked]**       |
| Root typecheck                         | passes **[checked]**                                           |
| `yarn audit` (runtime dependencies)    | 3 "high", all in `js-yaml` **[checked]**                       |
| CI                                     | none **[checked]**                                             |
| Harbor drop while streaming            | encoder exits, service survives (simulated) **[checked]**      |
| Recorder ffmpeg killed while recording | recorder exits, service survives (simulated) **[checked]**     |
| Session preset                         | loads, runs through the DSP graph, output finite **[checked]** |
| Anything on a Flow 8 or an iPad        | **[not verified]**                                             |

Notes:

- **The root test failures are environmental.** The three suites read
  `schema/radio-z.xlsx` under `RADIOBOX_BASEDIR=/app`; that file is station
  data and git-ignored. They would pass inside the container. On a fresh clone
  `yarn test` is red, which hides real failures.
- **The `js-yaml` advisories are CPU exhaustion on hostile YAML.** studiobox
  only parses its own config files, so the practical risk is low.
- **The encoder and recorder have no `error` listener on ffmpeg's stdin.** The
  monitor got one in `f6d2c5d` after a missing device crashed playout. Two
  simulated failures did not reproduce a crash for the encoder or recorder, so
  this is a cheap safeguard, not a known bug.
- **`packages/studiobox/dist` on this machine is from 2026-07-23.** Run
  `yarn workspace @freieradios/studiobox build` on the session laptop, or use
  `dev`.
- **Test gaps:** `pipeline.ts`, `playout.ts` and `dsp/graph.ts` have no suite
  of their own. The blocks are tested, the wiring is not.

---

## 3. Readiness for the live session

| Requirement                                   | State                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Three mics, two with phantom power            | Works by config; phantom power is switched on the Flow 8 (ch 1 and 2)  |
| Automix, per-mic processing, limiter          | Implemented and tested                                                 |
| FLAC and mp3 start on click                   | Implemented (`playFile`, ffmpeg decode)                                |
| Jingles at a fixed time                       | Implemented, also in live mode (`Scheduler` is wired in `pipeline.ts`) |
| Host tablet: input meters and current playout | Implemented (landscape: meters left, files and queue right)            |
| Host tablet: prepared playlist                | Implemented, but it lives in memory only                               |
| Host tablet: "one track further"              | **Partly** — the queue keeps playing after the track (3.3)             |
| Guest tablet: display only                    | **Missing** (3.2)                                                      |
| The room hears jingles and music              | **Open** (3.1)                                                         |
| Plug and play                                 | **Partly** (3.5)                                                       |

### 3.1 What the room hears — the biggest open point

In June the music came from players plugged into the Flow 8, so the Flow 8
mixed the headphones itself and studiobox only produced the stream. Now the
music comes from studiobox's file player, so it has to get back into the room.
**[checked in the June config, `radiobox.bak2`]**

The only way back today is `output.monitor`, and it carries the **finished
programme, mics included** (`pipeline.ts` writes the same block to encoder,
recorder and monitor). That block is late: one capture block (21 ms), the
limiter look-ahead (5 ms) and the buffers of `arecord` and `aplay`. The total
was not measured; expect 0.1 to 0.5 s. **[checked in code; delay not
verified]**

Consequences **[judgement]**:

- Sent to the Flow 8's USB return, every voice arrives in the headphones
  twice: directly, and again delayed. Speaking against one's own delayed voice
  is very hard.
- Sent to loudspeakers in the room, the mics pick the programme up again.

**Recommended fix:** a monitor mix without the mics, e.g.
`output.monitor.mix: music` (file player and music inputs only, after ducking).
The Flow 8 then mixes direct mics and returned music, as a studio desk would.
Entry points: `Graph.process` (second stereo bus), `pipeline.ts` (write it to
the monitor), `config/schema.ts`, one test. About half a day.

**Without that fix:** only the host wears headphones, fed from the laptop's own
output, and listens to the music only.

### 3.2 Guest tablet

There is one page, and every device that opens it can do everything: mute
mics, stop the stream, start files. There is no read-only mode and no
authentication; the server listens on all interfaces. **[checked]**

Needed **[judgement]**:

- A view such as `/?view=guest`: one large tile per mic (name, level bar with a
  green "good" zone, open or muted), the running title with time left, the
  clock. No controls.
- The server ignores commands from a connection opened as read-only, so a
  stray tap cannot do anything.

The snapshot already carries everything this view needs (`outDb`, `gateOpen`,
`muted`, `micsMuted`, `filePlaying`, position and duration). About a day.

**Workaround without code:** open the normal page on the guest iPad and lock
it with iPadOS _Guided Access_ with touch disabled.

### 3.3 Host tablet: one track, then back to the talk

`▶ Start` plays the head of the queue, and pressing it again skips to the next
one — that part works. But when a track ends by itself, the queue starts the
next one (`QueuePlayer`, the `ended` handler). For a talk with music breaks the
music has to stop after one track. **[checked]**

**Recommended fix:** a queue switch "einzeln / durchlaufen" (`autoAdvance`),
default "einzeln" in live mode. Entry points: `play-queue.ts`, the queue header
in `meters/server.ts`, both existing queue test suites. A few hours.

**Workaround without code:** press `■ Stop file` before the track ends.

Also: **the queue is lost on restart.** Number the files in a `playlist`
folder (`01-…`, `02-…`); `＋ alle` rebuilds the list in one tap.

### 3.4 Scheduled jingles

Works as on the Pi. Points to settle in the rehearsal **[judgement]**:

- **Time zone and clock.** Timestamps are read in the laptop's time zone. Check
  `timedatectl` and that the clock is synchronised.
- **Ducking.** The file player is ducked, so an opener is pulled down 15 dB as
  soon as someone talks. Use `Mute mics` until the opener is over, or decide
  that jingles should not be ducked.
- **Levelling.** The music leveller reacts over about two seconds. Listen to
  whether a short jingle pumps.
- **Preemption.** A scheduled jingle replaces whatever is playing. With an
  end-of-session jingle, the last music track must be over by then.

### 3.5 Plug and play

Today the operator has to know the ALSA device name, write it into the config,
make sure nothing else holds the card, build, start, and find the laptop's IP
address for the tablets. **[checked]**

Missing **[judgement]**:

- **A preflight command** (`studiobox doctor`): are ffmpeg, arecord and aplay
  there; is the card there and how many channels does it offer; who holds it;
  do the folders exist; what is the time zone; which address do the tablets
  open.
- **Card detection.** The card has been seen as `F8` and as `FLOW8`. A
  `device: auto` that picks the card by name pattern would remove the most
  likely failure.
- **The desktop sound server.** On a laptop, PipeWire or PulseAudio may hold
  the card. Set the card's profile to "Off" there, or studiobox gets
  "device busy".
- **The address for the tablets**, printed at start, ideally as a QR code.

Provided with this audit: a preset,
`packages/studiobox/config/studiobox.flow8-session.example.yaml`.

**The laptop has to run Linux.** Capture and monitor use `arecord` and `aplay`.

### 3.6 Rehearsal checklist

1. `arecord -l` shows the Flow 8; note the card name.
2. Start studiobox; all three mics show level; no "device busy".
3. Pull a mic fader down on the Flow 8: does the level in studiobox stay? (Is
   the USB send before or after the fader? **[not verified]**)
4. Phantom power on for channels 1 and 2 only.
5. Play a FLAC and an mp3 by click. Listen in the room and in the headphones.
6. Talk over music: ducking depth and release.
7. A test jingle with a timestamp two minutes ahead.
8. Both iPads on the same network as the laptop; Auto-Lock set to "Never".
9. Pull the USB cable, plug it back in: does capture recover by itself?
10. Arm the recording and check that the file plays.
11. Run for 60 minutes; watch for `arecord` overruns in the log.
12. Laptop: suspend and screen lock off, power supply plugged in.
13. A network of your own (travel router). On a venue network anyone can open
    the page.

---

## 4. Proposed work for this week

| #   | Item                                              | Effort        | Why                   |
| --- | ------------------------------------------------- | ------------- | --------------------- |
| 1   | Monitor mix without mics                          | half a day    | Usable headphones     |
| 2   | Queue: "einzeln / durchlaufen"                    | a few hours   | Music breaks          |
| 3   | Guest view, read-only connections                 | about a day   | Second iPad           |
| 4   | `doctor` preflight, card detection, address print | half a day    | Plug and play         |
| 5   | `error` listeners on encoder and recorder stdin   | under an hour | Safeguard             |
| 6   | Rehearsal with the real hardware                  | an evening    | Live mode is untested |

Freeze the code two days before the session. After the session: the existing
roadmap (true-peak limiting, music loudness normalisation, noise suppression).

---

## 5. Repository cleanup

Safe and small **[checked]**:

| Item                                                            | Action                                              |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `.idea/` is tracked although ignored, including `workspace.xml` | `git rm -r --cached .idea`                          |
| Root tests need station data                                    | Point them at `schema/example.xlsx`                 |
| Root package is still called `zapi`                             | Rename to `radiobox`                                |
| `@types/node-osc` sits in `dependencies`                        | Move to `devDependencies`                           |
| `scripts/ffmpeg-playout.service`, `ffmpeg-capture.service`      | Retired per the Pi config; remove or mark as legacy |
| studiobox `README.md` says "Phase 1 scaffold"                   | Rewrite; it omits playout mode, player, queue       |
| `AGENTS.md` "Status" is one paragraph of about 100 lines        | Split into sections per feature                     |
| `AGENTS.md` TODO points at `limiter.ts:55`                      | Reference the comment, not the line                 |
| Three stale Dependabot branches on origin                       | Delete                                              |
| No CI                                                           | One workflow: install, typecheck, test              |
| `docs/` and the `AGENTS.md` line about it are uncommitted       | Commit                                              |

**One finding that needs action:** commit `363907f` (2026-04-28) added an
Icecast source URL with a real-looking password to
`scripts/ffmpeg-capture.service`; `01ec8a3` removed it a day later. It is still
in the public history. **Change that password** if it is or was in use.
Rewriting history is not worth it. The `radiobox.bak*` folders next to the
repository also contain a harbor password in plain text.

Larger, after the session **[judgement]**:

- **`meters/server.ts` is 1,174 lines, about 900 of them a web page inside a
  template string** — no syntax check, no linting, no highlighting. Move the
  page to real `.html`, `.css` and `.js` files. Do this before adding the guest
  view if time allows, otherwise right after the session.

---

## 6. Is studiobox well placed as a package?

Facts **[checked]**:

- studiobox imports nothing from the classic library; the planned
  `packages/core` has not been started.
- What they share is tooling: Jest, Prettier, `yarn.lock`.
- The layout is lopsided: the classic library **is** the repository root,
  studiobox is a package beneath it. Hence the test script's
  `--config ../../jest.config.ts --rootDir ../..`.
- A playout Pi has to clone the Docker and Liquidsoap material and install the
  root dependencies it never uses.

Assessment **[judgement]**:

- **Keep one repository.** One contributor, one station, one story. Two
  repositories double the upkeep and gain nothing today.
- **Make it symmetric, later.** Move the classic library to
  `packages/radiobox`, leave the root as a pure workspace. Half a day, low
  risk, not before the session.
- **Split off only if** someone wants studiobox without the rest.

---

## 7. GitHub (FreieRadios) or the own Gitea

Facts **[checked]**: the repository is public, one star, no forks, three open
issues; eve already lives on the Gitea.

Recommendation **[judgement]**: **GitHub stays the public home, the Gitea
becomes a mirror.**

- Moving to hide costs effort and gains nothing: nobody is watching now either.
  Say "experimental" in the README.
- For the meeting next month a link under `github.com/FreieRadios` is the
  better address. That organisation also hosts _Comba_, the Radio Z project
  AURA's playout grew from.
- The Gitea gives what is missing: a second copy, CI, and room for private
  branches.

---

## 8. Overlap with AURA

Basis: the two documents in this folder. They rest on web research; nothing
was tested on a running AURA, and nothing was re-researched for this audit.

| Area                                  | Overlap                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| Live auto-mixing of mics (studiobox)  | None. AURA treats the studio as a line input.                      |
| Publishing to WeLocal, Nextcloud, FTP | None. AURA publishes to cba.media only.                            |
| Harbor input, lossless mount          | None in AURA today.                                                |
| Recording per broadcast               | Both do it.                                                        |
| Playout by schedule                   | Both, at very different scale.                                     |
| Programme planning, people, roles     | **Here is the real overlap** — with eve's Sendeplan, not studiobox |

Assessment **[judgement]**:

- **studiobox is not a duplicate.**
- **The eve bridge is not a duplicate if it stays a bridge.** Reading the
  schedule from eve and writing broadcasts back is glue. Building a calendar
  with collision handling, or a recurrence engine, would be rebuilding AURA's
  Steering. eve's roadmap already postponed the recurrence engine (item 17).
- **Keep studiobox's playout small.** Fallback programme, silence detection
  and music rotation are what Liquidsoap and AURA are for.
- **Build the `BroadcastSource` interface so that a second adapter can read
  AURA's public API.** That turns the question "why not AURA?" into "works
  with AURA too".

What the comparison underweights **[judgement]**:

- It counts AURA's dependence on four developers as a risk. radiobox depends
  on one. For the station that is the larger risk, and the meeting is the
  place to address it.
- Michael Liebler of Radio Z is listed as an AURA contributor. Expect the
  question "why not AURA?" and bring the table above.

---

## 9. Open questions

1. Where does the programme go: to the Radio Z harbor, into a recording, or
   both?
2. Who wears headphones, and is there a loudspeaker in the room?
3. Does the laptop run Linux, and which sound server?
4. Should jingles be ducked under speech?
5. Is the Icecast password from section 5 still in use?

---

## 10. How the checks were done

```bash
yarn install --frozen-lockfile
yarn test                                         # root: 3 suites fail, see section 2
yarn workspace @freieradios/studiobox test        # 23 suites, 153 tests
yarn workspace @freieradios/studiobox typecheck
yarn format:check
yarn audit --groups dependencies
git ls-files -ci --exclude-standard               # tracked although ignored
```

The harbor drop was simulated with a local TCP listener that accepts the
source connection and closes it after 1.5 s while blocks keep being written;
the recorder failure by killing its ffmpeg with SIGKILL while recording. The
preset was loaded with `loadConfig` and 200 blocks of test tones were run
through `Graph`.

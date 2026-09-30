# studiobox — design guidelines

**Written:** 2026-09-30 · **Applies to:** every web view studiobox serves
(host, technician, guest, spectator) · **Roadmap:**
[roadmap-stable.md](roadmap-stable.md)

studiobox is used live, in a dim room, on phones and tablets held by people
who are also talking on air. Every screen has to be readable at a glance from
an arm's length, work with one thumb, and never let a stray tap disturb the
broadcast.

"Barrierefrei" in English is **accessible**; the field is called
**accessibility** (a11y). The target is **WCAG 2.2 level AA**, the level the EU
standard EN 301 549 and the German BITV 2.0 refer to.

---

## 1. Principles

1. **Glanceable first.** Each view answers one question in under a second
   ("Is my mic open and am I at the right level?", "What plays next?"). Status
   is big; detail is secondary.
2. **Safe on air.** Nothing that affects the broadcast happens on a single
   accidental tap. Start is armed, not implied. Stop and mute are reversible.
   Actions that end output (stop stream, stop recording) need a confirmation
   or a press-and-hold.
3. **Show the role's world, hide the rest.** A guest never sees a button. A
   host sees playout, not DSP. The technician sees everything.
4. **Never colour alone.** Every state has colour **and** a word, icon or
   position. Red/green colour blindness affects about 1 in 12 men.
5. **Calm by default.** Motion only where it carries information (meters).
   Nothing blinks except an alarm, and even that respects reduced motion.
6. **German first.** The operators and guests read German. UI text is German,
   `lang="de"`, short verbs ("Start", "Stopp", "Bett an"). Code and docs stay
   English.

## 2. Roles and permissions

| Role           | Device (typical)              | Sees                                                                                                                   | Can do                                                                                                           |
| -------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Host**       | Tablet, landscape             | Own mic and all mics (compact), now playing + time left, next jingle, playlist, folders, bed                           | Play, queue, skip, stop file, **bed on/off**, mute mics (all), Vorhören                                          |
| **Technician** | Tablet or laptop              | Everything: full meters (in, gate, comp, automix, leveler), master loudness, limiter, duck, outputs, recording, stream | Everything the host can, plus trims, soundcheck, per-mic mute, host-priority depth, recording, streaming, output |
| **Guest**      | Tablet on the table, portrait | **Own mic, large**: open/closed, level zone. Now playing + countdown. Clock. "Host speaks" hint                        | **Nothing.** Optionally pick "which mic am I" once (stored locally)                                              |
| **Spectator**  | Any browser                   | On-air state, now playing, clock, programme level                                                                      | Nothing                                                                                                          |

The server enforces this: each WebSocket connection carries a role, and
commands outside that role's allowlist are dropped and logged. Hiding a button
is a convenience, not the protection. Sessions run on the venue's shared Wi-Fi,
so the role comes from a per-session token in the URL (handed out as a QR
code), never from the route alone.

## 3. Layout per view

All views: a **status strip** at the top (on air / recording / Sendezeit
clock) and content below. Safe-area insets respected (`env(safe-area-inset-*)`). Works
from 320 px wide up; no horizontal scrolling at 320 px.

### Host (tablet landscape; phone portrait falls back to one column)

```
┌ ON AIR ● REC ● ───────────── 19:42:10 ┐
│ Mics (4 compact bars) │ Jetzt: Titel   │
│                       │ ████████░ 2:34 │
│ Playlist (queue)      │ Ordner / Files │
│  ▶ Start  einzeln|lauf│                │
├───────────────────────┴────────────────┤
│ [ ■ Stopp ] [ 🛏 Bett an ] [ Mics zu ] │  ← always visible, thumb zone
└────────────────────────────────────────┘
```

- **Bed and stop sit bottom right and are never hidden** (emergency controls).
- **The mic toggle is the host's job, by hand** (jingles and music are ducked
  under open mics, so the host closes them for a jingle and reopens them a few
  seconds before it ends). So it is the biggest control on the screen, shows
  its state in words ("Mikros offen" / "Mikros zu") and colour, and sits next
  to the countdown of the running item, so the host sees both at once.
- Now playing shows the remaining time **large** (it is what the host acts on).

### Technician

The current meters page, cleaned up: meter table left, controls right, the
setup assistant ("Einmessen") as a step-by-step panel (see section 5), and
the air delay with its measured value next to the Sendezeit clock.

### Guest (portrait, one mic per tablet, or two side by side)

```
┌──────────────────────────┐
│  Gast 1          ● OFFEN │  ← name + state, words + colour
│                          │
│   ▲ zu laut              │
│  ████  ← target band     │  ← big vertical bar
│  ████   "Passt"          │
│   ▼ näher ran            │
│                          │
│  ♪ Musik – noch 2:34     │  ← countdown until talk resumes
│  19:42                   │
└──────────────────────────┘
```

### Spectator

One screen: large "ON AIR" / "OFF AIR", title playing, programme level as a
slim bar, clock.

## 4. Visual language

### Colour tokens (dark theme, default)

Contrast measured against the background tokens (WCAG ratio; AA needs 4.5:1
for text, 3:1 for large text and UI parts).

| Token       | Value     | Use                                     | on `bg` | on `surface` | on `raised` |
| ----------- | --------- | --------------------------------------- | ------- | ------------ | ----------- |
| `--bg`      | `#101214` | page                                    |         |              |             |
| `--surface` | `#1a1d21` | panels                                  |         |              |             |
| `--raised`  | `#24282e` | buttons, rows                           |         |              |             |
| `--text`    | `#e8eaed` | body text                               | 15.6    | 14.0         | 12.3        |
| `--muted`   | `#a3aab3` | secondary text                          | 8.0     | 7.2          | 6.3         |
| `--accent`  | `#7cc8ff` | links, focus, selection                 | 10.3    | 9.3          | 8.2         |
| `--ok`      | `#5fd08a` | level in zone, mic open, running        | 9.7     | 8.8          | 7.7         |
| `--warn`    | `#ffc94d` | scheduled, too quiet, attention         | 12.3    | 11.1         | 9.7         |
| `--cue`     | `#ffb347` | Vorhören / pre-listen (amber, as today) | 10.5    | 9.5          | 8.3         |
| `--onair`   | `#ff5c5c` | on air, recording, too loud             | 6.2     | 5.6          | 4.9         |
| `--info`    | `#b9a6ff` | playing file (violet, as today)         | 8.9     | 8.0          | 7.0         |

Filled status chips: white on `#c62828` (5.6:1), white on `#1e7d46` (5.2:1),
`--bg` on `--warn` (12.3:1).

The page used to set secondary text in `#555` and `#667` on `#111` (2.5:1 and
3.4:1, **below AA**); since the 2026-09-30 restyle it uses `--muted`, and the
tokens live as CSS variables at the top of the page's `<style>` in
`src/meters/server.ts`.

Also support `prefers-color-scheme: light` (a daylight open-air session) and
`prefers-contrast: more` (drop the surface tints, thicken borders).

### Typography

- **System UI font** (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)
  for text; the current all-monospace look is hard to read at a distance.
- **Tabular numerals** (`font-variant-numeric: tabular-nums`) for dB, times and
  counters so digits don't jitter.
- Base size **16 px** (never below 14 px). Guest view: status 28–40 px,
  countdown 48 px+. Use `rem` so the browser's text size setting works. The
  layout must survive **200 % zoom**.

### Spacing and shape

4 px grid (4, 8, 12, 16, 24, 32). Radius 8 px for controls, 12 px for panels.
No drop shadows; separation by surface tone.

### Icons

Emoji are fine as decoration (folder icons) but **every icon-only button has a
text label** (`aria-label`, and a visible label where space allows). Don't
rely on the emoji rendering the same on every device.

## 5. Components

### Level meter

- Scale in dBFS, −60 to 0, with ticks at −40, −20, −10, −6, 0.
- Colour by zone **and** position: `--ok` below −10, `--warn` −10 to −3,
  `--onair` above −3. A peak-hold tick for 1.5 s.
- Update at the snapshot rate (up to 20 fps), with no CSS transitions on the
  bar (they lag). `prefers-reduced-motion`: 5 fps and no peak-hold decay
  animation.
- Accessible: `role="meter"` with `aria-valuemin/max/now` and a text
  `aria-valuetext` ("−18 dB, passt"), but **not** `aria-live`; 20 updates a
  second would flood a screen reader. Announce only **zone changes**, at most
  once per 2 s.

### Guest level indicator (the key component)

- Shows **speech level at the mic before automatic gain**, so it reflects mouth
  distance, not the processed output (see roadmap M1.2).
- Three zones with words: **"näher ran"** (too far/quiet) · **"passt"** ·
  **"etwas weiter weg"** (too close/loud). The target band is drawn on the bar,
  so position alone tells the story.
- Holds the last value for 2 s after the guest stops talking, then fades to
  "—" (it does not jump to "näher ran" while they listen).
- States of the mic, each with a word: **OFFEN** (open), **LEISER** (host
  priority active: "Moderation spricht"), **STUMM** (muted by the technician),
  **ZU** (all mics closed by the host, e.g. "Mikros zu – Jingle läuft").

### Sendezeit clock

studiobox airs a few seconds behind the room (roadmap, section 2). The clock
that matters to anyone talking is therefore the **on-air time of what is said
now**, not the wall clock.

- The big clock on every view is **Sendezeit**, labelled as such ("Sendezeit
  13:00:00"). The wall clock sits small beneath it ("Studio 12:59:50 · +10 s").
- Countdowns to scheduled items count down to their **Sendezeit**; when the
  host reads "noch 0:05" they have five seconds of talk left before it airs.
- The spectator view is the exception: it shows what listeners hear now, so
  its "now playing" is in air time, and its clock is the ordinary one.
- If the measured delay leaves D ± 1 s, the clock shows a warning chip
  ("Verzögerung 11,4 s") — the numbers stay correct, the chip just says why.

### Setup assistant ("Einmessen")

One panel on the technician view, one line of big type on every other view.

- **Steps as a progress row:** "Stille · Gast 1 · Gast 2 · Host · Technik ·
  Ergebnis". The current step is named in words, not only highlighted.
- **Who is up** is shown on all views, on the guest tablet as the whole
  screen: "Jetzt du: Gast 1 — bitte diesen Satz vorlesen" with the sentence in
  large type and a filling ring that shows how much speech has been collected.
  "Danke!" when done.
- **Knob advice** is concrete and physical: "Flow 8, Kanal 3 (Host): GAIN etwa
  +18 dB aufdrehen, dann ‚Neu messen'". The channel number and the colour of
  the Flow 8 channel strip both appear, so it maps to the hardware at a glance.
- **Result** as a before/after table per mic, with plain-language verdicts
  ("gut", "zu leise – Gain", "übersteuert") and two buttons, "Übernehmen" and
  "Verwerfen". Nothing applies without "Übernehmen".
- During the assistant the programme output stays as it was (it usually isn't
  on air yet); a chip says "Einmessen läuft".

### Now playing

Title (truncated in the middle, not the end, so the numbering prefix and file
ending stay visible), a progress bar, **remaining time** large, elapsed small.
For guests the label is "Musik – noch 2:34, dann geht's weiter".

### Buttons

- Minimum target **44 × 44 CSS px** (WCAG 2.5.8 requires 24; 44 matches iOS
  and is what a nervous thumb needs), at least 8 px apart.
- States: default, pressed, **active/on** (filled + word change, e.g. "● Aufnahme
  läuft"), disabled (with a reason in the tooltip or next to it).
- Toggles use `aria-pressed`. The label says the **state**, the action is
  implied ("Bett läuft" pressed, "Bett aus" not pressed) — never a label that
  flips between action and state.
- Destructive or output-ending actions: press-and-hold 800 ms with a visible
  fill, or a confirm step. Never a browser `confirm()` dialog on air.

### Modals

Real `<dialog>` elements, focus moved into them, Escape closes, focus returns
to the trigger. Never a modal on the guest or spectator view.

## 6. Accessibility checklist (every view, every PR)

- [ ] `lang="de"` on `<html>`; page `<title>` names the view ("studiobox –
      Gast").
- [ ] Landmarks: `header`, `main`, `nav` where relevant; headings in order.
- [ ] All text ≥ 4.5:1, large text and UI parts ≥ 3:1 (tokens above).
- [ ] State never shown by colour alone.
- [ ] Everything works by keyboard; visible focus ring (`--accent`, 3 px,
      `:focus-visible`); no keyboard traps.
- [ ] Touch targets ≥ 44 px; nothing hover-only.
- [ ] Icon-only buttons have an accessible name.
- [ ] Status changes that matter (on air, recording, track started, mic
      muted) go to one polite `aria-live` region, rate-limited.
- [ ] Works at 320 px width and at 200 % zoom; portrait and landscape.
- [ ] `prefers-reduced-motion`, `prefers-contrast`, `prefers-color-scheme`
      honoured.
- [ ] Tested with VoiceOver on iPad and with TalkBack or Orca once per
      milestone.
- [ ] Connection loss is shown in words ("Verbindung weg – verbinde neu …"),
      and the page reconnects on its own.
- [ ] Tablets: Screen Wake Lock requested on views meant to stay on (guest,
      host); an "Anzeige bleibt an" hint if the browser refuses. The API only
      works on HTTPS, so until studiobox serves HTTPS (roadmap M2) the
      rehearsal checklist sets iPad Auto-Lock to "Nie".

## 7. Content and tone

- Short, concrete, German. "Stopp", not "Wiedergabe beenden".
- Say what happens on air: "Startet sofort auf Sendung", "Nur im Browser".
- Times in the **server's** time zone (as today), 24 h, `HH:MM:SS` for the
  clock, `M:SS` for countdowns.
- Units always visible (dB, LUFS). For guests: no dB at all, only the zone
  words.
- The help modal (`#help`) stays the single operator manual; update it with
  every change operators see.

## 8. Implementation notes

- New views are **real files** (`src/meters/public/`), share one `tokens.css`
  and one small `meter.js`; no framework and no build step (the Pi has to
  serve them too).
- The snapshot is the single source of truth; views only render it. A guest
  view receives a **trimmed snapshot** (its own mic, now playing, clock) to
  save bandwidth on weak Wi-Fi.
- Page logic gets the same black-box tests as the current page
  (`__tests__/meters/page-*.test.ts`).

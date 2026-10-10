# radiobox and AURA — comparison, scheduling check, and what follows

**Date:** 2026-09-29 · **Status:** analysis, no decision taken yet

This document records a comparison of radiobox (including studiobox) with
[AURA](https://aura.radio), the open-source suite for community radios, and
the discussion that followed: whether radiobox stays necessary, what a move to
AURA would cost the station, whether AURA can express the station's scheduling rules,
how eve fits in, and how studiobox could relate to AURA.

**How to read it.** Statements are marked by how they were established:

- **[checked]** — read in source code or run as a test on 2026-09-29.
- **[researched]** — taken from AURA's documentation, release notes, issue
  tracker or public API through web research on 2026-09-29. The full evidence,
  with a source link and date for every fact, is in
  [`aura-technical-profile-2026-09-29.md`](./aura-technical-profile-2026-09-29.md).
- **[judgement]** — an assessment, not a fact.
- **[not verified]** — looked for and not confirmed.

Nothing here was tested on a running AURA installation.

---

## 1. Summary

1. **radiobox stays necessary** for the station and for any station that does not
   replace its whole setup with AURA. The two are different kinds of thing:
   AURA is a full station suite a station migrates to; radiobox is lightweight
   tooling around a setup that already exists. **[judgement]**
2. **AURA is stronger in programme planning and people management** (web
   calendar, accounts, roles). That is radiobox's weakest part, and the part
   eve is already planned to take over (eve roadmap item 15).
3. **radiobox is stronger in publishing and flexibility**: WeLocal, Nextcloud
   and FTP upload, harbor input, a lossless mount, running beside an existing
   setup, and live mixing with studiobox. AURA has none of these.
4. **AURA can express the scheduling edge cases asked about**, including
   "fifth Sunday of odd-numbered months" **[checked]**, but with limits: one
   position per rule, no month lists, no override or no-merge flags.
5. **AURA has no overwhelming advantage for the station.** **[judgement]**
6. **studiobox is unlikely to be accepted into AURA's core** (estimated below
   10 %). It can work as a companion without any change to AURA.
   **[judgement]**
7. **AI-assisted contributions should be disclosed**, and the question should
   be raised with the AURA team before any code is written. AURA has no stated
   policy on AI. **[researched]**

---

## 2. Function comparison

| Function                                  | radiobox                                      | AURA 1.2                                                            |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| Programme planning                        | Rules in an `.xlsx` sheet, no UI              | Web calendar, recurrence rules, collision handling                  |
| People, roles, login                      | None                                          | Roles with field-level permissions, OIDC and LDAP                   |
| Playout                                   | Relay, scheduled repeats, crossfade           | Automation with fallback and silence detection; fades, no crossfade |
| Studio line-in                            | Through studiobox (USB mixer capture)         | Up to 5 line-in channels, switched by schedule                      |
| Remote input, pulled from a stream URL    | Yes (`MAIN_STREAM_URL`)                       | Yes, as a media source                                              |
| Remote DJ input pushed to a harbor        | Yes                                           | No (engine-core#17, backlog since 2022)                             |
| Lossless stream mount                     | Yes                                           | No, mp3 and Ogg Vorbis only                                         |
| Recording per broadcast                   | Yes, files named after the show               | Yes, files named by start and end time only                         |
| Publishing recordings                     | WeLocal, Nextcloud, FTP                       | Cultural Broadcasting Archive (cba.media) only                      |
| Schedule import from a spreadsheet        | Yes                                           | No                                                                  |
| Public programme API                      | Export as `welocal-json` and `m3u`            | Public JSON API, track service                                      |
| Relay-and-record beside an existing setup | Yes (`light` preset)                          | Not documented                                                      |
| Live auto-mixing of studio microphones    | Yes (studiobox)                               | No counterpart                                                      |
| Footprint                                 | Node, ffmpeg, optional Liquidsoap and Icecast | About ten services, three PostgreSQL databases, PipeWire            |

All AURA entries are **[researched]**; the radiobox entries describe this
repository.

---

## 3. AURA in brief

All **[researched]** unless marked.

- **What it is.** "The Open Source Software Suite for Community Radios", AGPL
  3.0. Code at `gitlab.servus.at/aura`.
- **Who builds it.** Started in 2017 by five Austrian stations (Radiofabrik,
  FRO, Freistadt, ORANGE 94.0, Helsinki). Financial contributors also include
  Freirad, Proton, and the German stations Wüste Welle (Tübingen) and free FM
  (Ulm).
- **Releases.** 1.0.0 on 2026-05-20, 1.1.0 on 2026-06-04, 1.2.0 on 2026-08-11,
  backport 1.1.1 in September 2026.
- **Stack.** Python/Django (steering, battery, engine-api), Vue 3 dashboard,
  Liquidsoap 2.4.2 playout, NATS messaging, three PostgreSQL databases. Icecast
  is not included.
- **Activity.** 1,528 commits on default branches in 2026 across ten
  repositories; four people produce about 97 % of them. Monthly commits fell
  from about 300 (February to April) to 74 (September).
- **Funding.** Austrian RTR digital-transformation fund; the documented
  completion project ran "until mid-2026". Financing after that is
  **[not verified]**.
- **Adoption.** Verified live at ORANGE 94.0 (Vienna) and Radio FRO (Linz).
  No German station was verified running it in production.
- **Acknowledged problems.** Installation is a "frequently reported
  pain-point" (epic aura#641). Schedules must be prolonged by hand once a year.
  A playout re-architecture is planned for 2.0.
- **Link to the station.** AURA's playout concept builds on _Comba_, written by
  a member of the station, who is listed as a code contributor. No evidence
  was found that the station runs AURA.

---

## 4. Scheduling: can AURA express the station's rules?

### 4.1 AURA's recurrence model [checked]

Read in `steering/program/models.py` and `steering/program/services.py`,
steering commit `db6f9210` (2026-09-21).

A recurrence rule has five stored fields:

| Field         | Allowed values                       |
| ------------- | ------------------------------------ |
| `freq`        | once, monthly, weekly, daily         |
| `interval`    | any integer                          |
| `by_set_pos`  | **one** of 1, 2, 3, 4, 5, -1 (last)  |
| `by_weekdays` | business days, or weekends, or empty |
| `count`       | any integer                          |

Timeslots are generated with `dateutil.rrule` from exactly these fields. The
weekday of a monthly rule is taken from the schedule's first date. There is
**no month field**. The default installation ships 31 rules
(`fixtures/program/rrule.json`): once, daily, weekly, business days, weekends,
every two and every four weeks, and "monthly / every 2 / 3 / 4 months on the
first … fifth / last".

A repetition is a second schedule that points at the original
(`repetition_of`), with its own start time and a day offset (`add_days_no`,
optionally counting business days only).

### 4.2 Mapping from radiobox's grammar

| radiobox pattern                             | AURA                        | How                                                            |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------- |
| `D:[5]` with odd months                      | Works **[checked]**         | Rule "bi-monthly on the fifth", first date in an odd month     |
| `D:[-1]` with `M:[2,4,6,8,10,12]`            | Works                       | Rule "bi-monthly on the last", first date in an even month     |
| `D:[1-5]` (every week)                       | Works                       | Rule "weekly"                                                  |
| Single position, `D:[1]` … `D:[5]`, `D:[-1]` | Works                       | Rules "monthly on the first … last"                            |
| Several positions, e.g. `D:[1,3,5]`          | Only by splitting           | One schedule per position, so 2 to 4 schedules per show        |
| Arbitrary month list, e.g. `M:[1,3,5]`       | Not possible                | No month field                                                 |
| `R:<hours>` repeat offset                    | Works, modelled differently | A repetition schedule with its own start time and a day offset |
| `O:true` override                            | No equivalent               | Collisions are resolved by hand when a schedule is saved       |
| `N:true` no-merge                            | No equivalent               | AURA stores individual timeslots; it does not merge slots      |

A difference in kind: radiobox computes the grid from rules every time, AURA
materialises timeslots once and stores them. Timeslots are generated only to
the end of the calendar year, and a programme manager has to start the "annual
timeslot prolongation" by hand; AURA's docs say it "cannot be easily reversed".
**[researched]**

### 4.3 The fifth-Sunday check [checked]

[`checks/aura-rrule-fifth-sunday.py`](./checks/aura-rrule-fifth-sunday.py)
feeds `dateutil` the parameters of AURA's rule "bi-monthly on the fifth" with a
first date of 2026-03-29 and compares the result with a brute-force list of all
fifth Sundays in odd months up to the end of 2028. Result:

```
2026-03-29  2026-05-31  2026-11-29  2027-01-31
2027-05-30  2028-01-30  2028-07-30
matches reference: True
```

Months without a fifth Sunday are skipped, and the two-month interval stays
anchored to the first date. This tests the library AURA uses with AURA's
parameters, not AURA itself.

### 4.4 The station's actual patterns [checked]

[`checks/pattern-tally.py`](./checks/pattern-tally.py) was run
against eve's transcription of the station's sheet
(a script in eve's backend, 106 patterns).

| Property                           | Count  | Consequence in AURA                             |
| ---------------------------------- | ------ | ----------------------------------------------- |
| All months (`M:[1-12]`)            | 105    | None                                            |
| Even months only                   | 1      | Two-month interval, first date in an even month |
| Every week (`D:[1-5]`)             | 31     | Rule "weekly"                                   |
| One position (first … fifth, last) | 56     | One monthly rule each                           |
| **2 to 4 positions combined**      | **19** | **2 to 4 schedules per show**                   |
| Repeat offset present              | 106    | One repetition schedule per show                |
| Override flag                      | 2      | Resolve by hand                                 |
| No-merge flag                      | 1      | No equivalent                                   |

Repeat offsets in use are 17 h (60 patterns), 5 h (27), 12 h (17), 7 h (1) and
16 h (1).

So every pattern of the station can be represented in AURA, but not one-to-one: the
106 patterns would become roughly 250 schedules (originals, split positions
and repetitions), entered through the API or by hand, since AURA has no
spreadsheet import and "no official migration tool". **[judgement on the
number; researched on the import]**

### 4.5 What adding the missing pieces to AURA would take [judgement]

To support month lists and several positions in one rule:

1. Two model changes in Steering: a `by_month` field, and `by_set_pos` as a
   list in place of a single integer; a database migration.
2. Pass `bymonth` and the list to `dateutil.rrule`, which supports both
   natively, in the two places that build rules (`services.py`).
3. Adjust the uniqueness constraint on rules, the serializer and the API docs.
4. Dashboard form for the new fields (Vue 3).
5. Tests, changelog entry, documentation.

The backend part is a few days of work. The dashboard part and the review by a
small team are the slow parts. AURA's contribution guide asks for changes of
this size to be discussed with the team beforehand.

---

## 5. eve as the source for schedule and programme listings

Context: eve roadmap items 15 (Sendeplan as source of truth, endpoint for
radiobox), 17 (recurrence as a core primitive, postponed) and 28 (tiny CMS).

- **The pattern carries over.** eve's website app renders the Impressum by
  reading the member register. The same mechanism can render the weekly grid,
  show pages and "who makes this show" from the Sendeplan. **[judgement]**
- **The gap is dated listings.** eve stores scheduling rules but cannot expand
  them into occurrences (item 17, postponed). A listing like "what is on
  tonight" is not possible from eve alone.
- **Proposal: radiobox writes occurrences back.** radiobox already expands the
  rules and cuts one recording per broadcast. After each broadcast it could
  create or update an `Ausgabe` in eve, with the recording attached. eve would
  then hold a richer record per broadcast (people, topics, links, file) and
  could render dated listings, while radiobox stays the only system that
  computes the grid. **[judgement]**
- **What this needs in radiobox:** the `BroadcastSource` adapter from item 15
  (read), and a small write connector in the style of the existing
  `ApiConnectorWelocal` and `ApiConnectorNextcloud`, called from the
  recorder's `finished` event.

---

## 6. If the station moved to AURA

| The station would gain                           | The station would lose or have to pay for         |
| ------------------------------------------------ | ------------------------------------------------- |
| Web calendar with collision handling             | Publishing to WeLocal, Nextcloud and FTP          |
| Accounts, roles, uploads by the hosts themselves | Harbor input and the lossless mount               |
| Playout fallback with silence detection          | Show names in recording file names                |
| Track service and a public programme API         | Re-entering 106 patterns as roughly 250 schedules |
| A codebase shared with other stations            | Yearly manual prolongation of all schedules       |
| Publishing to cba.media                          | Operating about ten services and three databases  |

Also to weigh **[judgement]**:

- radiobox's schedule part and eve's Sendeplan app would both become
  redundant.
- The station would depend on the priorities of a four-person team whose funding
  after mid-2026 is unclear.
- A bridge from AURA to WeLocal would have to be written in any case, because
  AURA has no WeLocal support.

---

## 7. AI-assisted contributions to AURA

**Findings [researched / checked]:**

- AURA's contribution guide and code of conduct do not mention AI, LLMs or
  generated code.
- A search of the public issue tracker for "LLM", "Copilot", "ChatGPT",
  "AI-generated" and "artificial intelligence" returned no relevant issue.
- No agent instruction files (`AGENTS.md`, `CLAUDE.md` or similar) exist in the
  repositories that were cloned.
- The commit history could not be checked for AI co-author trailers, because
  the clones were shallow.
- The guide contains this clause: "By contributing your code you agree to these
  licenses and confirm that you are the copyright owner of the supplied
  contribution."

So the team's position is **unknown**.

**Position taken [judgement]:** disclose AI assistance, and do not disguise it.

- The copyright clause makes AI assistance material to what a contributor
  confirms.
- It is a small community that meets in person; being found out later would
  cost radiobox and eve their credibility as well.
- Asking first is cheap. The guide asks for discussion before big changes, and
  the project has a Matrix space (`#aura:freie-radios.de`).
- If the team declines AI-assisted code on principle, that is theirs to decide.
  The answer then is integration from outside (section 8), not a contribution.

radiobox itself is open about it: commits carry a `Co-Authored-By` trailer
(see `AGENTS.md`).

---

## 8. studiobox and AURA

**The idea.** About 90 % of the station's broadcasts are a few people talking, with
jingles and a little music. studiobox, with radiobox, is meant to be a tablet-
and table-friendly assistant for exactly that, so hosts can keep their
attention on the conversation and not on a mixer, CD players and turntables.
The first live broadcast with studiobox is planned for the week of 2026-10-05.

**Chance of acceptance as a pull request into AURA's core: below 10 %.**
**[judgement]** Reasons:

- **Stack.** studiobox is TypeScript with its own DSP chain; AURA's playout is
  Python and Liquidsoap. It would arrive as a new component in a language the
  playout team does not use.
- **Scope.** AURA treats the studio as an external line-in. Mixing is outside
  what it does, and no issue in its tracker asks for it (searches for
  "automix" and "mixer" found nothing related).
- **Capacity.** Commits are declining, funding is unclear, P1 bugs are open,
  and a playout re-architecture is planned for 2.0.

**The realistic path needs no pull request.** AURA accepts two inputs that
studiobox can feed **[researched]**:

| Route   | How                                                                                                               |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| Stream  | studiobox sends its stream to an Icecast mount; AURA plays that URL as a stream media source assigned to the show |
| Line-in | studiobox plays to local hardware (its direct playout output); AURA takes it as a line-in channel                 |

Two limits to keep in mind: AURA switches inputs by schedule and has no "go
live now" button yet (epic aura#180, milestone 2.0), and it has no harbor, so
studiobox cannot push to AURA directly.

A middle way would be a repository in AURA's `aura-contrib` group, or a link
from AURA's documentation to studiobox as a companion tool.

---

## 9. Suggested next steps

1. **Record and document the live broadcast** in the week of 2026-10-05:
   setup, signal chain, what the hosts had to touch, what went wrong. It is
   the best argument for studiobox, towards the station and towards AURA.
2. **Keep radiobox's core narrow**: recorder, publishing connectors,
   Liquidsoap presets, studiobox. Invest in the schedule logic only as far as
   eve needs it.
3. **Build the `BroadcastSource` interface** planned in eve roadmap item 15. A
   second adapter reading AURA's public programme API would make radiobox's
   recorder and connectors usable by AURA stations.
4. **Talk to the AURA team** in their Matrix space before writing code for
   them: about AI-assisted contributions, and about studiobox as a companion.
5. **Decide on the write-back to eve** (section 5) once the read endpoint
   exists.

---

## 10. Open questions and limits

- Nothing was tested on a running AURA installation.
- AURA's financing after mid-2026, and the involvement of the Austrian and
  German associations (VFRÖ, BFR), are **[not verified]**.
- Whether any German station runs AURA in production is **[not verified]**.
- Whether AURA's dashboard lets a station administrator create new recurrence
  rules beyond the 31 defaults without touching fixtures was not tested. The
  docs say administrators manage the available rules; the model restricts the
  values as listed in 4.1.
- A BFR congress in Stuttgart around the end of October 2026 was mentioned in
  the research as a place to meet the AURA developers; date and place are
  **[not verified]**.
- The estimate of roughly 250 schedules in 4.4 is arithmetic on the pattern
  tally, not a migration plan.

---

## 11. How to repeat the checks

```bash
# Fifth Sunday of odd months, with AURA's rule parameters
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install python-dateutil
/tmp/venv/bin/python docs/analysis/checks/aura-rrule-fifth-sunday.py

# Tally of a station's schedule patterns
python3 docs/analysis/checks/pattern-tally.py \
  <eve's transcription of the sheet>
```

AURA's source, for re-reading the recurrence model:

```bash
git clone https://gitlab.servus.at/aura/steering.git
# program/models.py        class RRule, class Schedule
# program/services.py      generate_timeslots, get_next_first_date
# fixtures/program/rrule.json
```

---

## 12. Sources

- Full AURA evidence with links:
  [`aura-technical-profile-2026-09-29.md`](./aura-technical-profile-2026-09-29.md)
- AURA documentation: <https://docs.aura.radio/en/latest/>
- AURA release notes: <https://docs.aura.radio/en/latest/release-notes.html>
- AURA contribution guide:
  <https://docs.aura.radio/en/latest/contribute/contributions.html>
- AURA code: <https://gitlab.servus.at/aura>
- eve roadmap items 15, 17 and 28 (`eve/ROADMAP.md`)
- radiobox: `README.md`, `AGENTS.md`, `packages/studiobox/AGENTS.md`

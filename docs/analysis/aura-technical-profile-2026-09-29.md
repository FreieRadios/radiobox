# AURA ("AUtomated RAdio") - Technical Profile

Research date: 2026-09-29. Method: web research only (project docs, public GitLab API and repositories, station and conference websites, read-only GET requests against public API endpoints).

Conventions used in this document

- **[IMPL]** = stated as implemented in docs / release notes / code.
- **[PLAN]** = planned, open issue, or announced for the future.
- **[NOT VERIFIED]** = could not be confirmed; what was tried is stated.
- "accessed" always means 2026-09-29. Where a source carries its own date, that date is given as well.
- "docs latest" = https://docs.aura.radio/en/latest/ which is built from the `main` branch of `aura/aura` (last commit on main seen: 2026-09-28). It therefore describes a state at or slightly after release 1.2.0, and in places is internally inconsistent (see section 7).

---

## 1. Identity and governance

### 1.1 What it is

| Fact | Source | Date |
|---|---|---|
| "AURA is a software suite for community radio stations. All code is Open Source and licensed under AGPL 3.0." | https://docs.aura.radio/en/latest/ | accessed 2026-09-29 |
| Source code AGPL v3.0; other assets and text CC BY-NC-SA 3.0; sponsor logos copyrighted by owners | https://docs.aura.radio/en/latest/contribute/contributions.html | accessed 2026-09-29 |
| Tagline "The Open Source Software Suite for Community Radios"; links to docs, Matrix, code, API, demo | https://aura.radio/ | accessed 2026-09-29 |
| Docs copyright line "Copyright 2017-2026, the AURA Team" | https://docs.aura.radio/en/latest/ | accessed 2026-09-29 |
| Motivation: replace Y.A.R.M. ("yet another radio manager"), a monolithic Java application dependent on a single developer, still in use at several Austrian stations | https://docs.aura.radio/en/latest/about.html | accessed 2026-09-29 |

### 1.2 Where the code lives

| Fact | Source | Date |
|---|---|---|
| GitLab instance gitlab.servus.at, group `aura` (group id 7, public, created 2017-08-28). `code.aura.radio` and `gitlab.aura.radio` both redirect to https://gitlab.servus.at/aura | https://gitlab.servus.at/api/v4/groups/aura ; redirects tested with curl | accessed 2026-09-29 |
| Hosting/infrastructure contributed by servus.at, Jointech and the Cultural Broadcasting Archive (listed as "Infrastructure" contributors) | https://docs.aura.radio/en/latest/ (contributors table) | accessed 2026-09-29 |
| Container images published on Docker Hub under `autoradio/` (steering, battery, dashboard, dashboard-clock, can, engine, engine-core, engine-api, engine-recorder; legacy tank, tank-cut-glue) | https://hub.docker.com/v2/repositories/autoradio/ | accessed 2026-09-29 |
| API specs at https://api.aura.radio (Steering, Battery, Engine) | https://api.aura.radio/ | accessed 2026-09-29 |
| Communication: Matrix space (rooms on freie-radios.de homeserver), mailing list users@aura.radio | https://docs.aura.radio/en/latest/communicate/matrix.html | accessed 2026-09-29 |

Repositories in the group (19 projects incl. subgroup `aura-contrib`), from the GitLab API on 2026-09-29:

| Repository | Created | Last activity | Archived | Open issues |
|---|---|---|---|---|
| aura/aura (meta repo: compose bundles, docs) | 2017-11-29 | 2026-09-29 | no | 132 |
| aura/steering | 2017-09-28 | 2026-09-25 | no | 21 |
| aura/dashboard | 2017-12-29 | 2026-09-28 | no | 60 |
| aura/battery | 2025-11-20 | 2026-09-25 | no | 9 |
| aura/engine | 2017-08-22 | 2026-09-23 | no | 8 |
| aura/engine-core | 2021-02-19 | 2026-09-29 | no | 21 |
| aura/engine-api | 2020-06-19 | 2026-07-29 | no | 5 |
| aura/engine-recorder | 2022-04-15 | 2026-09-17 | no | 2 |
| aura/dashboard-clock | 2020-08-25 | 2026-09-07 | no | 12 |
| aura/can | 2025-10-16 | 2026-05-19 | no | 0 |
| aura/aura-website | 2022-04-08 | 2026-04-27 | no | - |
| aura/aura-contrib/oidc-client-stubs | 2020-06-22 | 2026-05-28 | no | - |
| aura/aura-contrib/migration-freirad | 2024-11-15 | 2026-03-30 | no | 0 |
| aura/aura-contrib/pipewire-docker | 2024-05-23 | 2024-05-23 | no | 0 |
| aura/aura-contrib/presentations | 2022-11-16 | 2024-05-23 | no | - |
| aura/aura-tests | 2024-03-11 | 2025-09-08 | yes | 0 |
| aura/engine-castor | 2025-04-16 | 2025-09-05 | yes | 16 |
| aura/aura-test-server | 2024-01-23 | 2024-01-23 | yes | 0 |
| aura/aura-web | 2021-05-13 | 2023-02-07 | yes | - |

Source: https://gitlab.servus.at/api/v4/groups/aura/projects?include_subgroups=true (accessed 2026-09-29).

### 1.3 Who develops and funds it

| Fact | Source | Date |
|---|---|---|
| Initiative started by five Austrian stations: Radiofabrik (Salzburg), Radio FRO (Linz), Freies Radio Freistadt, ORANGE 94.0 (Vienna), Radio Helsinki (Graz). Based on Radio Helsinki's programme management module and the playout software "Comba" by a member of the partner station | https://digital.danubestreamwaves.org/en/2020/11/automated-radio-en/ | published 2020-11-12 |
| "5 Radios im Jahr 2017" joined forces; developed as free software under (A)GPL | https://www.community-media.net/aura-ueberblick-und-ausblick-zum-automated-radio-projekt/ | published 2020-10-26 |
| "In 2021 haben sich drei deutsche freie Radios dem österreichischen AuRa Konsortium angeschlossen." (names of the three are not given in this source) | https://www.community-media.net/aura-automated-radio/ | published 2022-10-23 |
| Organisations listed as **financial** contributors in the docs: Radio FRO (Freies Radio Oberösterreich), Freies Radio Freistadt, Freies Radio Wüste Welle (DE, Tübingen), Freirad (Freies Radio Innsbruck), ORANGE 94.0 (Vienna), Proton - das Freie Radio, Radio Helsinki, Radio free FM (DE, Ulm), Radiofabrik | https://docs.aura.radio/en/latest/ (contributors table) | accessed 2026-09-29 |
| "Current sponsors and patrons": logos of AK Zukunftsfonds (Arbeiterkammer Oberösterreich) and RTR | https://docs.aura.radio/en/latest/#sponsors | accessed 2026-09-29 |
| A "current project for completion with a runtime until mid-2026" is funded by the RTR "Fond zur Förderung der Digitalen Transformation" and carried by a consortium of four Austrian stations: Radio FRO (Linz), Radio Orange (Vienna), Radio Helsinki (Graz), FREIRAD (Innsbruck). Goal: implementation of requirements and commissioning of AURA at the four partner radios. The same posting states AURA was then "im fortgeschrittenen Alpha-Stadium" | LinkedIn copy of Radio FRO job posting "Ausschreibung Projektmanagement für AURA": https://at.linkedin.com/jobs/view/ausschreibung-projektmanagement-f%C3%BCr-aura-at-radio-fro-105-0-mhz-4121358741 (original fro.at page now returns 404) | posted approx. January 2025 (application deadline 4 Feb 2025 according to search-engine snippet); accessed 2026-09-29 |
| Earlier funding: AURA development and project management were part of project STROM ("Software Technologien für Radios und Offene Medien"), "ein kumulatives und kooperatives Projekt, an dem 9 österreichische freie Radios beteiligt sind", funded by the RTR Fonds zur Förderung der Digitalen Transformation | https://www.fro.at/ausschreibung-it-projektmanagement-fuer-aura/ | published 2022-11-25, modified 2023-01-03 |
| Radio FRO's own AURA introduction is funded by "AK Zukunftsfonds Arbeit - Menschen - Digital" | https://www.fro.at/aura-radioautomation/ | published 2026-05-06, modified 2026-05-19 |
| The 2020 presentation of AURA to German stations was financially supported by the Staatsministerium Baden-Württemberg within project "danube streamwaves digital" (Radio free FM) | https://www.community-media.net/aura-ueberblick-und-ausblick-zum-automated-radio-projekt/ | published 2020-10-26 |
| Funding amounts granted by RTR | **[NOT VERIFIED]** - RTR decision pages (rtr.at/medien/was_wir_tun/foerderungen/digitaletransformation/...) and the RTR press release of 2023 were fetched; no mention of AURA/STROM found in the retrievable text | accessed 2026-09-29 |
| Role of Verband Freier Rundfunk Österreich (VFRÖ) as developer or funder | **[NOT VERIFIED]** - a site search for "aura" on freier-rundfunk.at returned nothing; the AURA docs do not list VFRÖ as contributor or sponsor. (Web search quota was exhausted before a dedicated search could be completed.) | accessed 2026-09-29 |
| Role of Bundesverband Freier Radios (BFR, DE) | BFR is not listed as contributor/sponsor. AURA is presented regularly at the BFR-related conference "Zukunftswerkstatt Community Media" (2020, 2022, 2023, 2024, 2025). A search for "aura" on freie-radios.de returned no relevant hit. An open epic "AURA API Compatiblity with BFR API" exists (aura/aura#32, created 2020-11-03, milestone "2.0 [Scope TBD]") | https://www.community-media.net/?s=aura ; https://gitlab.servus.at/aura/aura/-/work_items/32 | accessed 2026-09-29 |

### 1.4 Paid maintainers / staffing

| Fact | Source | Date |
|---|---|---|
| Radio FRO advertised a paid IT project manager for AURA: EUR 932.10 gross for 12.5 h/week until end of 2023, or approx. 550 hours for EUR 18,000 gross as contract | https://www.fro.at/ausschreibung-it-projektmanagement-fuer-aura/ | published 2022-11-25 |
| Radio FRO advertised a paid project manager, 8-10 h/week until end of August 2026 (approx. 700 hours), free service contract; text mentions "angestellten und externen Entwickler*innen" | LinkedIn URL above | approx. January 2025 |
| Paid contract developer (Python/C++) sought, "rund 300 Stunden Zeit dieses Jahr", Werkvertrag, applications until 2 May 2025 to pm@aura.radio | https://www.fro.at/wir-suchen-einen-python-c-entwicklerin-fuer-das-radio-management-programm-aura/ | published 2025-04-25 |
| Conclusion: development is done by paid (part-time / contract) staff financed through project grants and station contributions plus volunteers; the grant project mentioned above ran "until mid-2026". Financing after mid-2026 | **[NOT VERIFIED]** - no public statement found | - |
| Documentation on governance does not exist yet: open issue "Info in docs on product governance and maintainance" (aura/aura#621, empty description) | https://gitlab.servus.at/aura/aura/-/work_items/621 | created 2026-06-04 |

### 1.5 Contributors and commit activity

| Fact | Source | Date |
|---|---|---|
| Docs front page lists 51 contributor entries (all-contributors format); of these 12 are organisations (9 stations as "Financial", plus CBA, Jointech, servus.at as "Infrastructure") and 39 are individuals. README badge of aura/aura says "all_contributors-49" | https://docs.aura.radio/en/latest/ ; https://gitlab.servus.at/aura/aura/-/raw/main/README.md | accessed 2026-09-29 |
| Commits on default branches, 2026-01-01 to 2026-09-29, counted via GitLab API over the 10 active code repos: **1,528 commits in total**. Per repo: aura 487, battery 320, steering 252, dashboard 202, dashboard-clock 110, engine 71, engine-core 37, engine-api 34, engine-recorder 11, can 4 | https://gitlab.servus.at/api/v4/projects/:id/repository/commits?since=2026-01-01 (own count) | accessed 2026-09-29 |
| Per month 2026: Jan 15, Feb 297, Mar 328, Apr 301, May 174, Jun 147, Jul 104, Aug 88, Sep 74 | same | same |
| Distinct commit author names in 2026: 11 strings, which correspond to about 8 persons. Four persons account for about 97 % of commits (about 661, 477, 188 and 156); the other four together for under 50 | same | same |
| Issue tracker (group level): 270 open, 1,817 closed issues; 338 issues created since 2026-01-01 | https://gitlab.servus.at/api/v4/groups/aura/issues (x-total header) | accessed 2026-09-29 |

Caveat: counts cover default branches only; merge commits are included; author-name variants were not deduplicated by e-mail.

### 1.6 Roadmap

| Fact | Source | Date |
|---|---|---|
| No public roadmap document was found in the docs. The release procedure text refers to "the roadmap" internally | https://docs.aura.radio/en/latest/developer/release/release-bundle.html | accessed 2026-09-29 |
| Planning is visible through GitLab milestones. Open issues per milestone: Backlog 196, "1.4 [Scope TBD]" 29, "2.0 [Scope TBD]" 25, "1.5 [Scope TBD]" 7, "1.3" 5, "1.3.1" 4, none 4. No milestone carries a due date | GitLab API, group issues | accessed 2026-09-29 |
| Release cycle: code freeze "Monday evening of the 6th week", release Thursday of 6th week (i.e. about 6-week cycles) | https://docs.aura.radio/en/latest/developer/release/release-overview.html | accessed 2026-09-29 |
| The group milestones API endpoint requires authentication (401) | https://gitlab.servus.at/api/v4/groups/aura/milestones | accessed 2026-09-29 |

---

## 2. Releases

### 2.1 Full release history of the bundle (repo aura/aura)

| Version | Codename | Date in release notes | Git tag date |
|---|---|---|---|
| 1.0.0-alpha1 | - | 2023-03-02 | 2023-03-02 |
| 1.0.0-alpha2 | - | 2023-06-29 | 2023-06-29 |
| 1.0.0-alpha3 | - | 2024-02-29 | 2024-02-29 |
| 1.0.0-alpha4 | - | 2024-04-18 | 2024-04-18 |
| 1.0.0-alpha5 | Capable Capybara | 2024-11-05 | 2024-11-22 |
| 1.0.0-alpha5-hotfix1 | - | 2024-11-18 | 2024-11-22 |
| 1.0.0-alpha6 | - | 2025-02-26 | 2025-02-26 |
| 1.0.0-alpha7 | - | 2025-05-23 | 2025-05-23 |
| 1.0.0-alpha8 | - | 2025-10-01 | 2025-10-01 |
| 1.0.0-alpha9 | - | 2025-12-19 | 2025-12-19 |
| 1.0.0-beta1 | Bold Bison | 2026-03-12 | 2026-03-12 |
| 1.0.0-beta1-hotfix1 | - | 2026-03-21 | 2026-03-21 |
| 1.0.0-beta2 | Wiggling Waterbear | 2026-04-30 | 2026-04-30 |
| **1.0.0** | **Majestic Mole** | **2026-05-20** | 2026-05-20 (tag `v1.0.0`) |
| 1.1.0 | Savvy Seagull | 2026-06-04 | 2026-06-04 (tag `v1.1.0`) |
| **1.2.0** | **Creative Crab** | **2026-08-11** | 2026-08-11 (tag `v1.2.0`) |
| 1.1.1 | - (backport) | 2026-09-03 | 2026-09-07 (tag `v1.1.1`) |

Sources: https://docs.aura.radio/en/latest/release-notes.html ; https://gitlab.servus.at/api/v4/projects/20/repository/tags ; https://gitlab.servus.at/api/v4/projects/20/releases (all accessed 2026-09-29).

Notes:
- Both reported dates are confirmed: 1.0.0 = 2026-05-20, 1.2.0 = 2026-08-11.
- Date discrepancy for 1.1.1: release notes say 2026-09-03, CHANGELOG.md and Git tag say 2026-09-07.
- The latest feature release is 1.2.0. 1.1.1 is newer by date but is a backport of fixes to the 1.1 line.
- Codenames for alpha6 to alpha9 were not extracted.

### 2.2 Content of the releases around 1.0.0

Source for all rows: https://docs.aura.radio/en/latest/release-notes.html (accessed 2026-09-29).

**1.0.0-beta1 (2026-03-12)**
- Go-based service **Tank** (uploader) and `tank-cut-glue` replaced by the new Python service **Battery** (Media Store + Cut & Glue). "Migrating files is currently not supported."
- Media Store is built on `filerohr` (audio processing pipeline by contributor kmohrf, hosted on Codeberg).
- Engine API endpoints renamed from `/engine/api/v1/trackservice` to `/engine/api/v1/playlog` (filter `containsMusic=true` for music tracks only).
- Liquidsoap updated 2.4.0 to 2.4.1.
- Sample script for RTR reporting contributed by Radio ORANGE 94.0 (`contrib/rtr-reporting`).

**1.0.0-beta2 (2026-04-30)**
- Reporting management command (yearly CSV reports).
- Enhanced playout control: add/replace media on the fly during a broadcast, extend the current timeslot; Engine now uses NATS so changes in Dashboard are "almost immediately reflected in the playout scheduler".
- Episode recording guardrails: Cut & Glue prepares missing episode recordings for repetitions scheduled within the next 24 h; retention periods configurable in radio settings.
- Show storage quota, "number of people involved" field.
- Liquidsoap updated 2.4.1 to 2.4.2.
- Breaking: file format env vars no longer prefixed with ".".

**1.0.0 "Majestic Mole" (2026-05-20)**
- Declared stable: "the Community Radio Software Suite has officially reached its stable milestone."
- Content is small: Git tags now prefixed with `v`; consolidated make targets; squashed Steering migrations; documentation additions (API design guidelines, media source types); fixes for annual prolongation (steering#395), playlog start-time rounding in engine, several dashboard fixes; page titles in dashboard; M3U media sources handled by type instead of URI prefix.
- Component versions in the bundle: all nine services at 1.0.0 (sample.env at tag v1.0.0).

**1.1.0 "Savvy Seagull" (2026-06-04)**
- New calendar UI for the fallback programme ("Music Grid").
- New media source type **Music Pool**; M3U media sources can be played linear or random.
- New permissions for fallback slots and pool media sources.
- Breaking: `AURA_ENGINE_FALLBACK_FOLDER` renamed to `AURA_ENGINE_FALLBACK_PATH`; `AURA_ENGINE_FALLBACK_TYPE` removed.
- Deprecation: pool configuration in radio settings (removed in 1.2).

**1.2.0 "Creative Crab" (2026-08-11)**
- **Enhanced CBA integration**: hosts can upload episodes to the Cultural Broadcasting Archive (cba.media) from the episode detail page, also before broadcast (pre-production upload); linking an existing CBA post by ID with preview; programme managers can enable **automatic CBA uploads per show**.
- **Direct downloads and audio playback**: recordings can be downloaded from the episode detail page; uploaded files and recordings can be played in an integrated player.
- `aura-env` command-line utility for environment variables and secrets.
- Battery: new fsio endpoints (browse m3u and pool directories), v2 recordings endpoint, download support.
- Dashboard: auto-completion for M3U and pool sources.
- Fixes, among others: engine - "the live program was interrupted with fallback when aura-web was not reachable".
- Browser note: only Chrome and Firefox are supported; Safari issues were reported; mobile browser support "limited for now".
- Migration notes: in distributed setups all Audio Store directories (pool, m3u) must be mounted for the AURA Web services; CBA ID migration command has to be run; default fallback pool moved to the fallback show's default media source.
- Component versions at tag v1.2.0: steering 1.2.1, battery 1.1.3, dashboard 1.2.1, dashboard-clock 1.0.0, can 1.0.0, engine 1.2.0, engine-api 1.2.0, engine-core 1.1.0, engine-recorder 1.0.0 (https://gitlab.servus.at/aura/aura/-/raw/v1.2.0/config/aura-web/sample.env and .../aura-playout/sample.env).

**1.1.1 (2026-09-03 / tag 2026-09-07)**
- Backport: steering - "Basic program view fails around start/end of daylight saving time" (steering#406); engine - live programme interrupted with fallback when aura-web not reachable (engine#183).

### 2.3 What is planned next

| Item | Status | Source | Date |
|---|---|---|---|
| **1.3.0** is in preparation: aura/CHANGELOG.md has a section "[1.3.0] - UNRELEASED" (documentation items only so far). Component releases already cut: dashboard 1.3.0 (2026-09-23), battery 1.2.0 (2026-09-23), steering 1.2.2 (2026-09-21), engine 1.2.1 (2026-09-22) | [PLAN] | https://gitlab.servus.at/aura/aura/-/raw/main/CHANGELOG.md and component CHANGELOG.md files | accessed 2026-09-29 |
| Content of those component releases: show "isPublic" toggle, download of uploaded files from the media source dialog, better CBA post-ID conflict handling, deletion of media files from disk when a media source is removed, redirect to login after session timeout (dashboard 1.3.0); multiple conflict resolution strategies for CBA post IDs (battery 1.2.0); fixes for DST and prolongation problems (steering 1.2.2); fixes for skipped media sources with quotes in metadata and for invalid media sources (engine 1.2.1) | [IMPL in component releases, bundle not yet released] | component CHANGELOG.md files | accessed 2026-09-29 |
| Open issues on milestones 1.3 / 1.3.1: steering#413 "Prolongation problems" (Bug, P1), steering#412 "End date of schedules can not be changed/deleted" (Bug, P1), aura#626 "Migrating cba id's to AURA 1.2 failed" (Bug, P1), dashboard-clock#74 "dashboard-clock freezes from time to time" (Bug, P1), dashboard-clock#73 "Different fallback pools are not shown in clock" (Bug, P2), documentation tasks | [PLAN] | GitLab API, group issues | accessed 2026-09-29 |
| Milestone "1.4 [Scope TBD]": **Subscribe to podcasts via RSS feed** for re-broadcasts (epic aura#540 plus battery#33, steering#401, dashboard#556); **Jingle and Interlude Management "JIM"** / micro programme foundation (epic aura#22); dashboard UI to upload and manage music pool files (aura#620) and JIM files (aura#612); extend CBA import to episode data (aura#562); episode search in broadcast view (dashboard#571); fix "Audio Burst when Switching to Fallback" (engine-core#119) | [PLAN, scope explicitly "TBD"] | same | same |
| Milestone "1.5 [Scope TBD]": artist separation for fallback pools (engine-core#110); jingles after n minutes / x tracks in fallback (engine#25); accessibility testing (dashboard#544); resolve ambiguous "active show" status (steering#405) | [PLAN] | same | same |
| Milestone "2.0 [Scope TBD]": playout architecture change - Liquidsoap to self-manage scheduling, merging Engine and Engine Core (epic aura#596, engine-core#116/#117); HTTP APIs for media files instead of the filesystem-based Audio Store (epic aura#609); BFR API compatibility (aura#32); RadioDNS (aura#33); GraphQL (aura#347); web audio editing (aura#371); mono-repo (aura#234); real-time interface to control Engine (aura#180); Spinitron support (aura#398) | [PLAN] | same | same |
| Backlog epic "Simplify overall AURA installation and configuration" (aura#641, P1) | [PLAN] | https://gitlab.servus.at/aura/aura/-/work_items/641 | created 2026-09-21 |
| No release date for 1.3 or later is published | - | - | - |

---

## 3. Architecture

### 3.1 Naming scheme and bundles

- Components are named after car parts: Steering, Battery, Dashboard, Engine. Source: https://docs.aura.radio/en/latest/developer/architecture/overview.html (accessed 2026-09-29).
- Three Docker Compose **deployment bundles**: **AURA Web**, **AURA Playout**, **AURA Recorder** (called "AURA Record" on one page). Source: https://docs.aura.radio/en/latest/administration/aura-overview.html (accessed 2026-09-29).
- "All components offer OpenAPI 3 REST interfaces". Source: same.
- The component diagram in the architecture docs is marked "TODO - Update diagram. The following component diagram doesn't reflect all the details of the current implementation." Source: https://docs.aura.radio/en/latest/developer/architecture/principals.html (accessed 2026-09-29).

### 3.2 Components

Languages from the GitLab languages API (accessed 2026-09-29); frameworks from `pyproject.toml` / `package.json` on `main` (accessed 2026-09-29); roles from the install manuals.

| Component | Bundle | Required | Role | Language / framework | Database |
|---|---|---|---|---|---|
| **steering** | AURA Web | yes | "Single-source of truth, holding all radio, show, user and scheduling data"; also the OpenID Connect provider | Python >= 3.13, Django >= 5.2.5 < 6, Django REST framework, django-oidc-provider, django-auth-ldap, huey (background tasks) | PostgreSQL (compose default image `postgres:16`) |
| steering-worker | AURA Web | (part of steering) | background worker for Steering tasks (e.g. publishing NATS messages, prolongation, cleanup of unused episodes) | same image | - |
| **battery** | AURA Web | yes | Service container for media asset management, audio processing and background jobs. Packages: media-store, cut-glue, fsio, cba-integration, aura-common, aura-nats | Python >= 3.13/3.14, Django < 6, DRF, django-tasks, mozilla-django-oidc, filerohr, nats-py | PostgreSQL (compose image `postgres:18`) |
| **dashboard** | AURA Web | yes | "Backend user interface" for hosts, programme managers, admins | Vue 3 (^3.5), TypeScript, Vite, Pinia, Tailwind CSS, FullCalendar | none (uses APIs) |
| **dashboard-clock** | AURA Web | optional | Studio clock web app at `/clock` ("only available in LAN") | SvelteKit / Svelte 5, JavaScript | none |
| **nats** | AURA Web | yes | Message broker (image `nats:2-alpine`) | third party | - |
| **can** | AURA Web | yes | HTTP Server-Sent-Events proxy for NATS, for browsers | Python >= 3.12, FastAPI, nats-py | - |
| nginx | AURA Web | yes | Pre-configured reverse proxy; optional Let's Encrypt via certbot | third party | - |
| **engine** | AURA Playout | yes | "Control and scheduling for the play-out"; polls Steering (calendar) and Battery, keeps a local cache, commands engine-core | Python ^3.11, requests, nats-py | - |
| **engine-core** | AURA Playout | yes | Multi-channel playout server based on Liquidsoap; outputs to audio interface and Icecast; silence detector and fallback | Liquidsoap scripts, shell; Docker base image `savonet/liquidsoap:v2.4.2` | - |
| **engine-api** | AURA Playout | yes | "API for playlogs and track service" | Python >= 3.14, Django, DRF | PostgreSQL (compose default image `postgres:14`) |
| **engine-recorder** | AURA Playout (optional profile) or AURA Recorder (standalone bundle) | optional in Playout; the only service in Recorder | 24/7 block recorder using FFmpeg, optional rsync sync and deletion | Python >= 3.10, FFmpeg | - |

Sources:
- https://docs.aura.radio/en/latest/administration/aura-web/install-manual.html
- https://docs.aura.radio/en/latest/administration/aura-playout/install-manual.html
- https://docs.aura.radio/en/latest/administration/aura-recorder/install-manual.html
- https://gitlab.servus.at/aura/aura/-/raw/main/config/aura-web/docker-compose.yml , .../aura-playout/docker-compose.yml , .../aura-recorder/docker-compose.yml
- component READMEs, e.g. https://gitlab.servus.at/aura/engine-core/-/raw/main/README.md

Components named in the request that do **not** exist as current components:
- **tank**: legacy Go service, replaced by battery in 1.0.0-beta1 (2026-03-12). An open issue asks to archive the repo (aura#567). Note that the READMEs of `engine` and `engine-core` on main still refer to "Tank".
- **aura-web**: today the name of a Compose bundle; the repository `aura/aura-web` is archived (last activity 2023-02-07, "WIP! temporary project").
- **play / aura-play**: no repository or service with this name found in the GitLab group **[NOT VERIFIED as ever existing]**. The playout bundle is called "AURA Playout" (`config/aura-playout`).
- **engine-castor**: archived repository (created 2025-04-16, last activity 2025-09-05), description is only a shrug emoticon; purpose not documented.

### 3.3 Communication between components

| Path | Mechanism | Source |
|---|---|---|
| Dashboard / Clock to Steering, Battery, Engine API | REST (OpenAPI 3), JSON | https://docs.aura.radio/en/latest/administration/aura-overview.html |
| Authentication | OpenID Connect, Steering is the OIDC provider, Authorization Code Flow; Dashboard (public client) and Battery (confidential client) are registered as OIDC clients. Service-to-service: static auth tokens (`Authorization: Token ...`) | https://docs.aura.radio/en/latest/developer/api/api-auth.html |
| Engine to Steering / Battery | Polling of REST endpoints (`/steering/api/v1/program/playout`, fetch frequency 30 s in sample config) plus NATS events since 1.0.0-beta2 | https://gitlab.servus.at/aura/aura/-/raw/main/config/services/sample-config/engine.yaml ; release notes 1.0.0-beta2 |
| Engine to Engine Core | UNIX socket (Liquidsoap server / telnet-style commands) | https://gitlab.servus.at/aura/engine/-/raw/main/README.md |
| Engine / Engine Core to Engine API | REST POST of playlogs and health data | same; engine-core.yaml sample config |
| Messaging | NATS (JetStream streams `resource` and `program`); `can` forwards to browsers via SSE. Docs state: "Currently, only steering is producing messages and only the dashboard is consuming them." This sentence conflicts with the beta2 release notes stating that the Playout Engine also uses NATS | https://docs.aura.radio/en/latest/developer/services/messaging-system.html |
| Audio files between Web and Playout | Shared filesystem "Audio Store Directory" (`audio/upload`, `audio/record/block`, `audio/record/show`, `audio/pool`, `audio/m3u`); in distributed setups via NFS, SSHFS or GlusterFS | https://docs.aura.radio/en/latest/administration/deployment-preparation.html |
| Heartbeat | Engine sends UDP heartbeat to a configurable monitoring server | playout install manual; engine.yaml |

### 3.4 Databases

Three separate PostgreSQL instances (one each for steering, battery, engine-api). No MySQL/MariaDB, no Redis in the compose files. Source: compose files cited above (accessed 2026-09-29).

### 3.5 Liquidsoap and Icecast

| Fact | Source | Date |
|---|---|---|
| Liquidsoap is used (engine-core). Version **2.4.2** (Docker base image `savonet/liquidsoap:v2.4.2`; `liquidsoap_min_version: "2.4.2"` in sample config; "Updated Liquidsoap 2.4.1 to 2.4.2" in 1.0.0-beta2) | engine-core Dockerfile and README on main; https://gitlab.servus.at/aura/aura/-/raw/main/config/services/sample-config/engine-core.yaml ; release notes | accessed 2026-09-29 |
| Version history: 2.2.5 (alpha5, 2024-11), 2.4.0 (alpha9), 2.4.1 (beta1), 2.4.2 (beta2) | release notes | accessed 2026-09-29 |
| **Icecast is not included** in any Compose bundle (no occurrence of "icecast" in `config/` of aura/aura). AURA connects as a source client to an external Icecast server ("Icecast connectivity: Stream to an Icecast Server") | grep over repository clone at commit e0a5c3c7 (2026-09-28); https://docs.aura.radio/en/latest/administration/aura-playout/features.html | accessed 2026-09-29 |

---

## 4. Functions in detail

### 4.1 Programme schedule / calendar management

| Function | Supported | How | Source |
|---|---|---|---|
| Visual calendar | yes [IMPL] | Week view and day view; "Free slots" view; schedules can be created by clicking an unscheduled area | https://docs.aura.radio/en/latest/administration/aura-web/features.html ; https://docs.aura.radio/en/latest/user/schedule/schedule-overview.html |
| Month view | no - requested by ORANGE 94.0 in aura#434 | [PLAN/backlog] | https://gitlab.servus.at/aura/aura/-/work_items/434 (created 2025-01-31) |
| Recurrence rules | yes [IMPL] | Based on `dateutil.rrule`. Default fixture has 31 rules: once, daily, weekly, business days, weekends, every two weeks, every four weeks, monthly in the 1st/2nd/3rd/4th/5th/last week, and the same six variants for every two, three and four months. Admins manage the available rules; the weekday is derived from the first date | https://docs.aura.radio/en/latest/user/admin/manage-recurrence-rules.html ; https://docs.aura.radio/en/latest/developer/api/api-recurrence-rules.html |
| Timeslots only generated until end of calendar year | yes (limitation by design) | Schedules without end date get timeslots only until the end of the current calendar year; an "Annual Timeslot Prolongation" must be started once a year by a programme manager; "cannot be easily reversed"; conflicts must then be solved manually | https://docs.aura.radio/en/latest/user/schedule/timeslot-prolongation.html |
| Schedule conflicts | yes [IMPL] | Collision detection when creating/editing schedules; three collision types (fully overlapping, partly overlapping, superset/subset); resolution dialog offers options such as truncating or splitting; conflict resolution log in admin area | https://docs.aura.radio/en/latest/user/schedule/timeslot-collision-detection.html |
| Repetitions / reruns | yes [IMPL] | (a) **Repetition schedules** linked to an original schedule: repetition broadcasts are created chronologically; deleting/changing the original propagates. (b) Assigning an already aired episode to further broadcast dates. In both cases "the play-out will use the recording of the broadcast" of the original | https://docs.aura.radio/en/latest/user/schedule/repetition-schedules.html ; https://docs.aura.radio/en/latest/user/episode-and-broadcasts/broadcasts.html |
| Moving / deleting single broadcasts, ending a schedule after a broadcast | yes [IMPL] | via burger menu; by default programme managers only | https://docs.aura.radio/en/latest/user/schedule/schedule-edit.html |
| Fallback programme calendar ("Music Grid") | yes [IMPL since 1.1.0] | Weekly grid assigning music pools or M3U playlists to gaps | https://docs.aura.radio/en/latest/user/calendar/fallback-program.html |
| Micro programme (jingles, interludes) | partly | A "micro show" can be defined in radio settings; full "JIM" feature is [PLAN] (epic aura#22, milestone 1.4) | https://docs.aura.radio/en/latest/user/admin/station-settings.html ; GitLab |

### 4.2 Shows, hosts/people, roles, permissions, authentication

| Function | Supported | How | Source |
|---|---|---|---|
| Show management | yes [IMPL] | Title, slug, descriptions, logo/image, categories, topics, languages, music focus, type, funding category, predecessor, internal note, number of people involved, public visibility, storage quota (default 10240 MiB), deactivate/delete | https://docs.aura.radio/en/latest/user/show/show-settings.html |
| Episode management | yes [IMPL] | Title, summary, content, image, contributors, topics, languages, tags, links, CBA ID, media sources | https://docs.aura.radio/en/latest/user/episode-and-broadcasts/episode-details.html |
| People | yes [IMPL] | Public **profiles** (editorial staff, contributors/guests) separate from **user accounts** (show administrators who can log in) | https://docs.aura.radio/en/latest/user/profile-and-user/user-and-role.html |
| Roles | yes [IMPL] | Default roles Host (two flavours: Host and Host+), Programme Manager, Administrator (superuser). Implemented as Django groups | https://docs.aura.radio/en/latest/user/admin/roles-and-permissions.html |
| Permissions | yes [IMPL] | Entity-level permissions, **field-level** permissions, and permissions by ownership (show administrators); managed in the Django admin | same |
| Authentication | yes [IMPL] | **OIDC**: Steering is the built-in OpenID Connect provider (django-oidc-provider); clients use Authorization Code Flow. **LDAP** can be configured as user source (django-auth-ldap, group mirroring) | https://docs.aura.radio/en/latest/developer/api/api-auth.html ; https://docs.aura.radio/en/latest/administration/aura-web/install-manual.html |
| Use of an **external** OIDC identity provider (e.g. Keycloak) for login | **[NOT VERIFIED]** - docs only describe Steering as provider and LDAP as external directory; no documentation of federating to an external IdP was found | docs search |
| Multi-language content and UI | yes [IMPL] | Content translations per field; Dashboard UI; studio clock in English and German | https://docs.aura.radio/en/latest/user/admin/station-settings.html ; https://docs.aura.radio/en/latest/user/studio-clock/index.html |
| Multi-tenancy (several stations in one instance) | no | Epic "Modify data model for multi-tenant SaaS capabilities" aura#239 in backlog | https://gitlab.servus.at/aura/aura/-/work_items/239 |
| Public visibility | note | "almost all data is visible via public APIs" (read-only for anonymous users); exceptions listed | roles-and-permissions page |

### 4.3 Media upload and playlist management

| Function | Supported | How | Source |
|---|---|---|---|
| Upload of audio files by hosts | yes [IMPL] | Drag and drop or button in the episode's media source area; metadata extracted; import logs; retry | https://docs.aura.radio/en/latest/user/media/media-source.html (page exists on main; source file docs/user/media/media-source.md) |
| Import from URL | yes [IMPL] | Direct media URLs; CBA media URLs are resolved to file + licence (needs CBA API key) | same |
| Normalisation / conversion | optional [IMPL] | Off by default ("original files are kept as is"); optional conversion (fallback format FLAC; allowed formats opus, flac, mp3, vorbis) and loudnorm normalisation with ffmpeg-normalize preset "podcast" | https://docs.aura.radio/en/latest/administration/aura-web/install-manual.html |
| Media source types | yes [IMPL] | File upload, import, **stream URL**, **line input**, **M3U playlist** (linear or random), **music pool** (folder, random) | media-source page; https://docs.aura.radio/en/latest/developer/architecture/media-sources.html |
| Playlists | partly | There is no playlist editor entity; an episode holds an ordered list of media sources (can mix file, stream, line-in). M3U files and pools are maintained **on the filesystem of the server**; "music editors simply edit music pool directory on the playout server". M3U entries must be file paths - "streams are not supported as M3U file entries" | media-source page |
| Web UI for managing music pool files | no | [PLAN] aura#620 (milestone 1.4); docs: "Enhanced music library management coming ... tight integrations for 3rd party software" | media-source page; GitLab |
| Default media sources | yes [IMPL] | Per show and per schedule; inheritance order episode > schedule > show > fallback programme; "all or nothing" - inherited sources do not fill remaining time | https://docs.aura.radio/en/latest/user/media/alt-media-sources.html |
| Licences | yes [IMPL] | Licence and rights holder per image and media file, incl. Creative Commons | features page |
| Storage quota per show | yes [IMPL since beta2] | default 10 GiB | station-settings page |

### 4.4 Playout automation, fallback, silence detection, crossfading

| Function | Supported | How | Source |
|---|---|---|---|
| Scheduled playout | yes [IMPL] | Engine pulls schedule into a local cache; playout keeps working if AURA Web is unreachable; preload offset 15 s; scheduling window 60 s before start | https://docs.aura.radio/en/latest/administration/aura-playout/features.html ; sample engine.yaml |
| Intervention during broadcast | yes [IMPL since beta2] | Add/replace media on the fly, extend timeslot; by default programme managers only; "intended only for emergency use" | media-source page; https://docs.aura.radio/en/latest/user/media/playout-and-recording.html |
| Fallback handling | yes [IMPL] | Fallback programme fills schedule gaps and remaining time of too-short episodes; random play from `audio/pool/fallback` or an M3U playlist; folder is watched for changes; per-time-of-week pools via Music Grid | alt-media-sources page; playout install manual |
| Silence detection | yes [IMPL] | Liquidsoap `blank.strip`; sample config: `max_blank: 15.` (seconds), `threshold: -80.` (dB), `min_noise: 0.`; enabled by default, can be turned off | engine-core.yaml sample config; engine-core `src/engine.liq` |
| Per-timeslot override of the silence detector | no | backlog story aura#38 | GitLab |
| Fading | yes [IMPL] | Fade in/out when the mixer switches input; defaults `AURA_ENGINE_FADE_IN_TIME=1.5`, `AURA_ENGINE_FADE_OUT_TIME=1.5` seconds; media exceeding the timeslot "is faded-out right at the end of the timeslot" | https://gitlab.servus.at/aura/aura/-/raw/main/config/aura-playout/sample.env ; media-source page |
| **Crossfading** between tracks | **not documented as implemented**. No crossfade operator found in engine-core Liquidsoap sources (only `fadeTo` for mixer channels). Open epics: "Add Liquidsoap server functions to perform fading (fade in, fade out, crossfade of channels)" (engine-core#47, P3, backlog) and "Powerful cueing and fading features" (aura#357, backlog) | [PLAN] | code search in engine-core clone (commit 1c384260, 2026-06-02); GitLab |
| ReplayGain | partly | Feature list claims ReplayGain support; code applies `amplify(..., override="replay_gain")` on queue and playlist inputs; a settings comment says "FIXME: the function enable_replaygain_metadata does not exist" and the resolver is commented out | features page; engine-core `src/settings.liq`, `src/in_queue.liq` |
| Heartbeat monitoring | yes [IMPL] | UDP heartbeat; sample monitor app in `engine/contrib/heartbeat-monitor` | playout install manual |
| High availability (two engines) | not implemented | Engine API README lists "Data Synchronization: In high-availability deployment scenarios" under "Currently not implemented" | https://gitlab.servus.at/aura/engine-api/-/raw/main/README.md |

### 4.5 Live studio input, switching, remote input

| Function | Supported | How | Source |
|---|---|---|---|
| Studio line-in | yes [IMPL] | Up to 5 line-in channels (`aura_engine_line_in_0..4`) routed via PipeWire/JACK; studios defined in radio settings ("Line-in channels" JSON); media source `line:///2` | https://docs.aura.radio/en/latest/developer/architecture/media-sources.html ; engine-core.yaml |
| Switching between automation and studio | yes, **schedule-driven** [IMPL] | A line-in media source is assigned to an episode, schedule or show (default media source); Engine switches the mixer at the scheduled time with fades; sources without length expand to the rest of the timeslot. A new-show default line-in channel can be preset in radio settings | media-source page; station-settings page |
| Manual real-time switching (button "go live now") | not documented. Possible only indirectly by editing media sources of the running timeslot. Epic "Real-time interface to control Engine" aura#180 on milestone 2.0 | [PLAN] | GitLab |
| Remote live input via stream **pull** | yes [IMPL] | Media source type stream: http(s) URL of a live stream (e.g. from a remote studio's Icecast) | media-source page |
| Remote DJ **harbor** input (source client pushes to the playout) | **no**. No `input.harbor` in engine-core sources; open issue "Allow pro-active connections for external live sources (input harbor)" engine-core#17, created 2022-06-07, backlog, empty description | [PLAN/backlog] | https://gitlab.servus.at/aura/engine-core/-/work_items/17 ; code search |
| Backup stream URL for a stream source | no | Epic aura#549 (requested by o94), backlog | https://gitlab.servus.at/aura/aura/-/work_items/549 (created 2026-02-06) |

### 4.6 Recording of the broadcast

| Function | Supported | How | Source |
|---|---|---|---|
| Continuous block recording | yes [IMPL] | engine-recorder runs 24/7 using FFmpeg; records from an ALSA device (default) or PipeWire/JACK, **or from an HTTP audio stream** (`AURA_ENGINE_RECORDER_AUDIO_SOURCE`: "Set an ALSA audio device or HTTP audio stream"; example in OPTIONS.md: `http://stream.freirad.at:8002/live.ogg`) | https://gitlab.servus.at/aura/engine-recorder/-/raw/main/README.md ; .../OPTIONS.md ; https://gitlab.servus.at/aura/aura/-/raw/main/config/aura-recorder/sample.env |
| Block length and naming | [IMPL] | Default segment length 3600 s; path `{store_dir}/{%Y/%m/%d}/{strftime}.{format}`, default `audio/record/block/YYYY/MM/DD/%Y%m%d-%H%M%S.flac` | https://gitlab.servus.at/aura/aura/-/raw/main/config/services/sample-config/engine-recorder.yaml |
| Formats | [IMPL] | Default **FLAC**; configurable codec/format: flac, ogg (libvorbis), mp3 (libmp3lame). The 1.2 release test plan explicitly tested mp3 | same; https://gitlab.servus.at/aura/aura/-/work_items/623 |
| Per-show (per-episode) cutting | yes [IMPL] | **Cut & Glue** (part of Battery) crops and concatenates block recordings into "second-by-second episode recordings" in the background (check interval 600 s); output in `audio/record/show` | features page; https://docs.aura.radio/en/latest/administration/aura-web/install-manual.html |
| Per-show file naming | [IMPL] | File name is `<start>--<end>.<format>` using the pattern `%Y%m%d-%H%M%S`, e.g. `20260929-160000--20260929-165700.flac`. **The show name is not part of the file name**: the code has `enable_show_name: True` but the branch is a `TODO` with `pass`. Association to the episode is kept in the Battery database (recording record with episode id) | https://gitlab.servus.at/aura/battery - `packages/cut_glue/src/cut_glue/cut_glue.py` and `base/settings.py` at commit 8551c86c (2026-09-23) |
| Metadata tags / cue sheets in recordings | no | Epic "Recorder and Cut&Glue to support writing Cue Sheets to disk" aura#610, backlog | GitLab (created 2026-05-05) |
| Download / listening in the web UI | yes [IMPL since 1.2.0] | Episode detail page: recording can be played and downloaded | release notes 1.2.0; episode-details page |
| Archive / retention | partly | Radio settings "Max age block recording" and "Max age episode recording" (days) are declarative only: "no automatic deletion is performed by AURA". engine-recorder itself can delete files older than N days (`DELETE`, default off, 7 days) and can **rsync** blocks to a destination (`SYNC`, default off). Docs alternatively suggest an rsync cron job. Open issue: delete option leaves empty directories (engine-recorder#50) | station-settings page; recorder sample.env; recorder install manual |
| Audit log (legal logging) | yes [IMPL] | Described purpose of the block recorder: "archiving, audit-logging or further processing" | https://docs.aura.radio/en/latest/administration/aura-recorder/features.html |
| Web-based editing of recordings (cut out mistakes) | no | [PLAN] aura#585, dashboard#175, epic aura#371 | GitLab |

### 4.7 Automatic publishing to external archives or CMS

| Target | Supported | Details | Source |
|---|---|---|---|
| **Cultural Broadcasting Archive (cba.media)** | **yes [IMPL since 1.2.0]** | Manual upload of recording or pre-produced file from the episode page; **automatic upload per show** after broadcast. Automatic upload is skipped on "unplanned playback of the fallback program" or missing credentials. Credentials per show or per user. Licence mapping AURA to CBA (manual mapping may be needed). Import direction: CBA media URL to AURA file | https://docs.aura.radio/en/latest/user/show/show-settings.html ; .../user/episode-and-broadcasts/episode-details.html ; .../user/admin/cba.html |
| freie-radios.net (German audio portal) | **no** - no mention in docs (other than a link on the About page), code or issue tracker (issue search "freie-radios.net" returned no result) | - | docs and GitLab search, accessed 2026-09-29 |
| Nextcloud | no - no mention found | - | word-boundary grep over docs on main |
| FTP / SFTP | no - no mention found. Only generic rsync of block recordings | - | same |
| WordPress | no built-in plugin or push. Docs: "So far radio stations have integrated AURA with Wordpress and Directus CMS" - these are station-side integrations that **pull** from the AURA API | https://docs.aura.radio/en/latest/developer/api/api-migration-and-integration.html |
| WeLocal | no - no mention found | - | grep over docs |
| Podcast RSS feed **output** | no - not found | - | grep over docs |
| Podcast RSS **input** (subscribe and re-broadcast) | [PLAN] epic aura#540, milestone 1.4 | - | GitLab (created 2026-01-21) |
| Transfer of programmes between AURA instances | mentioned as a topic of the ZWCM 2025 talk ("Transfer von Sendungen zwischen Instanzen"); implementation status **[NOT VERIFIED]** (only the talk abstract was read, the audio recording was not evaluated) | https://www.community-media.net/aura/ (published 2025-10-08) |

### 4.8 Import of a schedule from spreadsheet; export to m3u / json / ical

| Function | Supported | Details | Source |
|---|---|---|---|
| Import of schedule from xlsx / spreadsheet | **no**. No occurrence of xlsx/openpyxl/spreadsheet in docs or Steering code. Initial data can be loaded via JSON **fixtures** (Django) and via the REST API; "there is no official migration tool" | - | https://docs.aura.radio/en/latest/developer/api/api-migration-and-integration.html ; grep over steering clone |
| Export JSON | yes [IMPL] via REST API (e.g. `/steering/api/v1/program/basic/`, `/program/calendar/`, `/program/playout/`, shows, episodes, timeslots); `pickFields` / `omitFields` and `ids` query parameters | - | https://docs.aura.radio/en/latest/developer/api/api-design-and-usage.html ; live API root at https://aura.o94.at/steering/api/v1/ |
| Export iCal | **no**. Open story aura#434 "iCal feed for the calendar" (backlog, created 2025-01-31) | [PLAN/backlog] | https://gitlab.servus.at/aura/aura/-/work_items/434 |
| Export M3U | no export found. M3U is an **input** format for playout | - | media-source page |
| CSV reports | yes [IMPL since beta2] via command line only: `docker compose run --rm steering generatereport category|funding_category|people <year>`. A UI for reports is [PLAN] (epic aura#370; dashboard#37) | - | https://docs.aura.radio/en/latest/user/admin/reporting.html |
| Playlog reports | manual: "These reports have to be manually generated and aggregated for now" via the Engine API playlog endpoint | - | same |

### 4.9 Public website widgets / API, track service

| Function | Supported | Details | Source |
|---|---|---|---|
| Public read API for programme display | yes [IMPL] | Steering API is readable without authentication for public data. Verified: `https://aura.o94.at/steering/api/v1/program/basic/?limit=3` returned today's programme without token | roles-and-permissions page; own GET request 2026-09-29 |
| Ready-made website widgets / embeds | **no** - none documented (word search for widget/iframe/embed in docs gave no relevant hit). Stations build their own website integration | docs grep |
| Track service / now playing | yes [IMPL] | Engine API: `/engine/api/v1/playlog` and `/engine/api/v1/playlog/current`, filter `containsMusic=true`. Verified: `https://aura.o94.at/engine/api/v1/playlog/current` returned artist/title/album, show name, `playoutStatus` without token. Note: engine-api README on main still shows the old `/trackservice` URLs | release notes beta1; own GET request 2026-09-29 |
| Playlogs from external sources | yes [IMPL] | API "also allows submitting playlogs from other data sources, like hardware music players" | playout features page |
| Live updates for websites | partly | NATS messages via `can` (SSE); intended mainly for Dashboard and Clock | messaging-system page |
| Studio clock | yes [IMPL] | Browser app with analog/digital clock, countdown, current and next two episodes, media source list, service status dots | https://docs.aura.radio/en/latest/user/studio-clock/index.html |
| RDS, RadioDNS | no | Epics aura#10 (RDS) backlog, aura#33 (RadioDNS) milestone 2.0 | GitLab |

### 4.10 Stream mounts, lossless, relaying

| Function | Supported | Details | Source |
|---|---|---|---|
| Multiple stream mounts | yes [IMPL] | "Multiple Icecast endpoints can be configured" as a list in `engine-core.yaml` (host, port, mountpoint, encoding, bitrate, channels, credentials, metadata) | https://docs.aura.radio/en/latest/administration/aura-playout/install-manual.html |
| Encodings for streaming | **mp3 and ogg (Vorbis) only** in the current stream output script: `out_stream.liq` handles `stream.encoding == "mp3"` and `"ogg"`; any other value falls back to the default Vorbis encoder. Files for aac, flac and opus exist in `src/outgoing_streams/` but are not included by `out_stream.liq` | engine-core `src/out_stream.liq` at commit 1c384260 (2026-06-02) |
| **Lossless mounts** (FLAC/Ogg-FLAC) | **not available in current code**; `outgoing_streams/flac.liq` contains the comment "TODO: how do we include flac for streaming?" and is not wired in. Open issue engine-core#27 "Use variables in encoders to simplify outgoing streams" | same |
| Known problem with stream outputs | code comment in `out_stream.liq`: "FIXME: Every time this function gets called the playout is interrupted" (on Icecast connection error handler) | same |
| Relaying an existing external stream | yes [IMPL] as a media source: a stream URL can be assigned to an episode, a schedule or a show (default); two stream input channels (`in_stream_0/1`); buffer 3-5 s, timeout 10 s in sample configs | media-sources page; engine-core.yaml; engine.yaml |
| Line output to FM transmitter | yes [IMPL] | "Broadcast to one or more line-out channels" via audio interface | playout features page |

---

## 5. Deployment and operations

| Topic | Finding | Source | Date |
|---|---|---|---|
| Docker Compose | yes; the documented production deployment. Three bundles in `config/aura-web`, `config/aura-playout`, `config/aura-recorder`, driven by `make` targets (`make aura-web.init`, `aura-web.configure`, `aura-web.fixtures-create`, `aura-web.fixtures-import`, `aura-web.up`, `aura-playout.pw.install`, `aura-playout.init`, `aura-playout.up`) | https://docs.aura.radio/en/latest/administration/aura-web/quick-install.html ; .../aura-playout/quick-install.html | accessed 2026-09-29 |
| Software prerequisites | Git, make, Docker Engine 25.0.2 or later, Docker Compose 2.15.1 or later | https://docs.aura.radio/en/latest/administration/deployment-preparation.html | accessed 2026-09-29 |
| Operating system | Component READMEs name Debian/Ubuntu (engine: Debian 12 / Ubuntu 23.10 or newer; engine-core: Debian 11 / Ubuntu 20.04 or newer; recorder tested on Debian and Ubuntu). Windows/macOS audio is an open issue (engine-core#53) | component READMEs | accessed 2026-09-29 |
| Audio for playout | "ALSA compatible audio interface"; **PipeWire 1.0.0 or higher** on the host, **WirePlumber**, `pipewire-jack` plugin; recommended to run PipeWire as system-wide daemon under user `aura`; engine-core sound system setting is `jack` (through PipeWire's JACK layer). README: "ALSA support for the complete AURA system was dropped in favour of JACK but might be added back in." PulseAudio must be removed (causes 15-20 s delays). Routing with `pw-link` or `qpwgraph` | https://docs.aura.radio/en/latest/administration/aura-playout/install-manual.html ; engine-core README ; FAQ | accessed 2026-09-29 |
| Audio for recorder | pure ALSA by default, PipeWire optional via compose override | https://docs.aura.radio/en/latest/administration/aura-recorder/install-manual.html | accessed 2026-09-29 |
| Playout without sound card | Virtual PipeWire devices exist (`AURA_ENGINE_VIRTUAL_OUTPUT`, `AURA_ENGINE_VIRTUAL_INPUTS`), documented under "Playout Development & Testing", i.e. as a test facility, not as a production mode | https://docs.aura.radio/en/latest/developer/services/playout.html | accessed 2026-09-29 |
| **Minimum server specs (CPU, RAM, disk)** | **Not stated in the docs.** A search of the docs for RAM/CPU/GB/cores/minimum found no sizing information. Only qualitative advice (set CPU and memory limits for web containers when sharing a host with the engine; consider a real-time kernel) | grep over docs on main; FAQ | accessed 2026-09-29 |
| Deployment scenarios | "Single Instance" (all on one machine) or "Advanced" (at least two machines: AURA Web and AURA Playout). Separate staging instance "highly recommended" | https://docs.aura.radio/en/latest/administration/system-planning-and-provisioning.html | accessed 2026-09-29 |
| Shared storage | Distributed setups need a network share for the Audio Store (NFS, SSHFS or GlusterFS; Gluster called "the ideal approach") | deployment-preparation page | accessed 2026-09-29 |
| TLS / proxy | Bundled Nginx; optional Let's Encrypt. Limitations: a second reverse proxy on the same host is "not yet supported"; URL rewrites not supported | https://docs.aura.radio/en/latest/administration/aura-web/advanced-config.html | accessed 2026-09-29 |
| Monitoring / backup | Docker health checks, log files, optional Sentry/Glitchtip; backup and restore make targets for Docker volumes | https://docs.aura.radio/en/latest/administration/update-and-maintain.html | accessed 2026-09-29 |
| **How hard is installation?** | The docs give no rating. Indicators: multi-step procedure with many environment variables and secrets, fixtures, OIDC client registration, host-level PipeWire setup and a reboot; FAQ covers permission errors and blank pages after install. The project itself states in epic aura#641 (P1): "Getting started with a fresh AURA installation is one of the bigger frequently reported pain-points due to it's complexity and related learning curve", with feedback "FRO: Install complicated; container vs host path can be mixed up" | https://gitlab.servus.at/aura/aura/-/work_items/641 ; FAQ https://docs.aura.radio/en/latest/administration/frequently-asked-questions.html | issue created 2026-09-21 |
| Upgrade effort | Every release 1.0.0-beta1 to 1.2.0 lists breaking changes or manual migration steps (env var renames, fixtures, mounts, CBA migration) | release notes | accessed 2026-09-29 |
| **"Light" mode that only relays an existing stream and records it** | **No such mode is documented.** What is possible with documented features: (a) run the **AURA Recorder** bundle alone and point it at an HTTP stream, which yields hourly block files only; (b) in a full installation, schedule a stream URL as default media source. Per-episode cutting, download and CBA upload require AURA Web (Steering + Battery) plus a shared Audio Store. Whether Cut & Glue works correctly with AURA Web + Recorder but **without** AURA Playout is **[NOT VERIFIED]** (not described in docs; automatic CBA upload checks playlogs for fallback playback, which come from the Engine API) | recorder docs; show-settings page | accessed 2026-09-29 |
| **Standalone use of single components** | Officially: "AURA adopts a modular approach, affording you the flexibility to mix and match components ... we recommend installing all of these packages simultaneously". Concretely: **engine-recorder** is standalone (own bundle, no dependency on other services). **can** "can be used independently for any other NATS-based project". **AURA Web** (steering, battery, dashboard, nats, can) runs without AURA Playout as programme management; the staged migration plan in the docs implies this use. **engine** needs steering, battery, engine-core and engine-api. **steering alone** without dashboard/battery: possible in principle as Django app with REST API and admin, but the compose bundle marks steering, nats, can, battery and dashboard all as required | https://docs.aura.radio/en/latest/administration/aura-overview.html ; install manuals; can README; engine README | accessed 2026-09-29 |
| Demo / test instances | demo.aura.radio (latest release), dashboard.aura.radio (main branch) | https://docs.aura.radio/en/latest/developer/environments.html | accessed 2026-09-29 |
| Supported browsers | Chrome 115+, Firefox 122+; "basic support" for mobile browsers; Safari not officially supported | https://docs.aura.radio/en/latest/user/overview/getting-started.html ; release notes 1.2.0 | accessed 2026-09-29 |

---

## 6. Adoption

### 6.1 Evidence per station

| Station | Country | Status found | Evidence | Date of evidence |
|---|---|---|---|---|
| **Radio ORANGE 94.0**, Vienna | AT | **In production use (2026).** Instance `aura.o94.at`: public API returns today's programme and the current playlog; 811 shows in the database. Issue steering#413 by an o94 staff member reports problems "on aura-stage as well as aura.o94.at" affecting "the shows on the website". An o94 workshop page (now 404, content known only from a search-engine snippet) announced that from 14 July the whole workflow "from entering broadcast data and uploading pre-produced shows to playback on the radio" runs through AURA; the weekdays given (Thursday 2 July, Tuesday 7 July) match the year 2026 | https://aura.o94.at/steering/api/v1/ ; https://aura.o94.at/engine/api/v1/playlog/current ; https://gitlab.servus.at/aura/steering/-/work_items/413 ; https://o94.at/de/vertiefungskurse/aura-workshop (404 on 2026-09-29) | API probed 2026-09-29; issue created 2026-09-15 |
| **Radio FRO**, Linz | AT | **Phased go-live in 2026.** "Im Frühjahr 2026 erfolgt die Inbetriebnahme für das Kernteam ... Ab Herbst 2026 erfolgt das schrittweise Rollout für die ehrenamtlichen Sendungsmacher*innen" (about 250 volunteers). Migration from YARM. Instance `aura.fro.at`: public API returns today's programme and current playlog; 202 shows | https://www.fro.at/aura-radioautomation/ ; https://aura.fro.at/steering/api/v1/ ; https://aura.fro.at/engine/api/v1/playlog/current | page published 2026-05-06, modified 2026-05-19; API probed 2026-09-29 |
| **Radio Helsinki**, Graz | AT | Consortium partner and financial contributor; its programme management module was the basis of Steering; used as example for recurrence rules and report file names in the docs. **Production use of AURA in 2026: [NOT VERIFIED]** - no public instance found under guessed host names (aura.helsinki.at, program.helsinki.at have no DNS record); host `pv.helsinki.at` exists and is aliased `rdimport.helsinki.at`, its `/steering/api/v1/` returns 404 | docs; DNS and HTTP probes | 2026-09-29 |
| **FREIRAD**, Innsbruck | AT | Consortium partner and financial contributor; migration scripts exist (`aura-contrib/migration-freirad`, last activity 2026-03-30); "Probebetrieb" in Nov 2023. **Production use in 2026: [NOT VERIFIED]** (aura.freirad.at has no DNS record) | https://gitlab.servus.at/aura/aura-contrib/migration-freirad ; https://www.commit.at/veranstaltungen/details/studio-und-sendetechnik-update-und-austausch-1 | repo 2026-03-30; event page Nov 2023 |
| **Radio Proton**, Dornbirn | AT | Financial contributor; "Probebetrieb" in Nov 2023; DNS record `aura.proton.at` exists but the host did not answer HTTPS requests. **Production use: [NOT VERIFIED]** | COMMIT page above; DNS probe | Nov 2023; 2026-09-29 |
| Freies Radio Freistadt | AT | Initiating station and financial contributor; requirements labelled in issues. Production use **[NOT VERIFIED]** | docs contributors; GitLab labels | accessed 2026-09-29 |
| Radiofabrik, Salzburg | AT | Initiating station and financial contributor. Production use **[NOT VERIFIED]** | docs contributors; danube streamwaves article | accessed 2026-09-29 |
| **Freies Radio Wüste Welle**, Tübingen | **DE** | Financial contributor; contributor Frieder Strohmaier presented AURA test installations at ZWCM 2022, 2024, 2025. In 2020 it was announced that the system "will be established" there. **Production use in 2026: [NOT VERIFIED]** | https://www.community-media.net/aura-automated-radio/ ; https://www.community-media.net/aura-kennenlernen/ ; https://www.community-media.net/aura/ | 2022-10-23; 2024-10-18; 2025-10-08 |
| **Radio free FM**, Ulm | **DE** | Financial contributor; staff member listed for talks/promotion; ran project "danube streamwaves digital". **Production use: [NOT VERIFIED]** | docs contributors; danube streamwaves article | accessed 2026-09-29 |
| **Querfunk**, Karlsruhe | **DE** | 2020: "probably" to be established. Host `aura.querfunk.de` exists and serves a page titled "AURA Dashboard", but `/steering/api/v1/...` returned HTTP 400 and `/engine/api/v1/playlog/current` returned 502. This shows an installation exists; it does **not** show production use | https://digital.danubestreamwaves.org/en/2020/11/automated-radio-en/ ; own probes | 2020-11-12; 2026-09-29 |
| **bermudafunk**, Mannheim | **DE** | 2020: "probably". DNS record `aura.bermudafunk.org` exists; host did not answer. **[NOT VERIFIED]** | same | same |
| Radio network in eastern Germany (unnamed) using calcms | DE | In Oct 2023 the collectives rokoli and UNI:CODE considered a commission of approx. EUR 35,000 gross to extend AURA for a "Radioverbund aus Ostdeutschland" (multi-tenancy, sharing content between stations). Outcome **[NOT VERIFIED]**; the multi-tenancy epic aura#239 is still open in the backlog. Note: the author of that issue is the most active committer in 2026 | https://gitlab.servus.at/aura/aura/-/work_items/235 | created 2023-10-11 |

Historic status statements:
- Nov 2020: test instance aura-test.o94.at; production testing planned for early 2021 (https://www.community-media.net/aura-ueberblick-und-ausblick-zum-automated-radio-projekt/).
- Oct 2023: "Aura läuft derzeit bereits im Probebetrieb bei den freien Radios in Linz und Wien und soll kommendes Jahr in den Produktivebetrieb gehen" (https://www.community-media.net/aura-automated-radio-2/, published 2023-10-30).
- Nov 2023: trial operation at "o94, Radio Proton, Freirad und Radio FRO" (COMMIT page).
- Oct 2024: "Derzeit ist sie noch im Alpha(-End)Stadium" (https://www.community-media.net/aura-kennenlernen/, published 2024-10-18).
- Oct 2025: ZWCM talk on "Stand der Einführung in Österreich und Deutschland" (abstract only; audio at http://mp3.radiocorax.de/mp3/098_ZWCM/zwcm2025_20251031_AURA.mp3 was not evaluated).

### 6.2 Summary on German stations

Two German stations (Wüste Welle, free FM) are listed as financial contributors, and installations or DNS entries exist for Querfunk and bermudafunk. **No verified evidence was found that any German station runs AURA in production as of 2026-09-29.**

### 6.3 The partner station

| Fact | Source | Date |
|---|---|---|
| AURA's playout concept builds on **Comba**, written by a member of the partner station: the original AuRa concept builds on an idea from a BfR tech meeting that was implemented in the Comba project (Comba: https://github.com/FreieRadios/comba) | https://www.community-media.net/aura-automated-radio/ ; https://digital.danubestreamwaves.org/en/2020/11/automated-radio-en/ | 2022-10-23; 2020-11-12 |
| The author of Comba is listed as code contributor in the AURA docs | https://docs.aura.radio/en/latest/ | accessed 2026-09-29 |
| The station is **not** listed as financial contributor or sponsor | same | same |
| The station running AURA: **[NOT VERIFIED] - no evidence found.** A guessed AURA host name under the station's domain has no DNS record. A GitLab issue search for the station's name returns only fuzzy matches. A dedicated web search could not be completed because the search quota was exhausted | own probes | 2026-09-29 |

### 6.4 Migration stories and problems

| Fact | Source | Date |
|---|---|---|
| No official migration tool; stations write their own scripts against the Steering API; audio can be referenced from mounted legacy storage | https://docs.aura.radio/en/latest/developer/api/api-migration-and-integration.html | accessed 2026-09-29 |
| Recommended staged migration: sync schedule/show data, integrate website, long test run of playout, then switch | https://docs.aura.radio/en/latest/administration/system-planning-and-provisioning.html | accessed 2026-09-29 |
| FREIRAD migration: fixtures written from legacy database, tables synchronised; "timeslot and episode tables ... will require some SQL-wizard" | https://gitlab.servus.at/aura/aura-contrib/migration-freirad | last activity 2026-03-30 |
| Tank to Battery (beta1): "Migrating files is currently not supported" | release notes 1.0.0-beta1 | 2026-03-12 |
| ORANGE 94.0, Sept 2026: annual prolongation for 2027 failed for shows "Sc until Z"; shows with special characters regrouped; "We are a bit desperate because we superurgently need to generate the list of Sendeminuten for our funding application"; website programme "in quite a chaos". Fix listed in steering 1.2.2 (2026-09-21); issue still open on 2026-09-29 | https://gitlab.servus.at/aura/steering/-/work_items/413 | created 2026-09-15 |
| CBA ID migration to 1.2 failed on a staging system with 810 shows (aura#626, Bug P1, open) | https://gitlab.servus.at/aura/aura/-/work_items/626 | created 2026-08-26 |
| Radio FRO feedback: "Install complicated" | https://gitlab.servus.at/aura/aura/-/work_items/641 | 2026-09-21 |

---

## 7. Limitations and open issues acknowledged by the project

There is **no "known issues" page** in the current docs. The items below come from docs admonitions, release notes, READMEs, code comments and the issue tracker (all accessed 2026-09-29).

### 7.1 Stated in docs / release notes

1. Browser support limited to Chrome and Firefox; Safari problems reported; mobile support "limited for now" (release notes 1.2.0).
2. Dark mode hidden "as it is not yet fully implemented" (release notes 1.0.0-beta2).
3. Timeslots are generated only to the end of the calendar year; yearly manual prolongation, "cannot be easily reversed" (timeslot-prolongation page).
4. Deleted timeslots are only respected by the engine until the start of the scheduling window (playout install manual, "Last minute changes").
5. Inherited default media sources do not fill the remaining duration ("all or nothing") (alt-media-sources page).
6. M3U entries must be files; streams inside M3U not supported. Fallback show default sources are limited to Pool and M3U (media-source page; fallback-program page).
7. Music pools and M3U files are maintained on the server filesystem, no web UI (media-source page).
8. Retention settings for recordings are informational only; "no automatic deletion is performed by AURA" (station-settings page).
9. Once a recording exists, only the recording can be uploaded to CBA; licence mappings may need manual admin work; failed uploads must be debugged through Django admin task IDs, and "the list doesn't allow users to search for the task id" (episode-details page; admin/cba page).
10. "The API key in the radio station settings is currently unused"; CBA key must be set by environment variable (station-settings page).
11. Second reverse proxy on the same host not supported; URL rewrites not supported; advanced Steering configuration cannot be started with the normal `make aura-web.up` ("will be simplified in a coming release") (advanced-config and install manual).
12. Changing host name or protocol after installation requires manual repair of OIDC clients (install manual).
13. "Active show" definition was inconsistent; "To avoid further issues this behaviour will be improved in future releases" (release notes 1.2.0; steering#405).
14. Playlog/playout reports must be generated and aggregated manually; schedule reports are command line only (reporting page).
15. Studio clock uses browser time, so client clocks must be in sync with the playout server (studio-clock page).
16. Engine API: health information history and data synchronisation for high availability are "Currently not implemented" (engine-api README).
17. Messaging: "The messaging infrastructure is fairly new in AURA, and not all services ... have added support for it yet" (messaging-system page).
18. Architecture diagram outdated ("TODO - Update diagram") (architecture page).
19. No hardware sizing guidance in the docs.

### 7.2 Documentation inconsistencies observed (relevant for anyone evaluating the docs)

- "Playout and recording" user page still says: "At a later stage, we plan to make these recordings available directly via the Dashboard interface for download", while release 1.2.0 states downloads are implemented.
- Messaging page says only Steering produces and only Dashboard consumes messages, while beta2 notes say Engine uses NATS.
- READMEs of `engine` and `engine-core` still refer to Tank; `engine-api` README still shows `/trackservice` endpoints; `dashboard` README still calls itself "an early development prototype".
- Several README links point to documentation pages that no longer exist (e.g. `administration/install-docker-compose.html`).
- Quick install pages list only tags `v1.0.0 v1.1.0` as example output.
- Older documentation versions (e.g. 1.0.0-alpha builds, still indexed by search engines) state that the project is in alpha status and should not be used in production. This is outdated since 1.0.0 (2026-05-20).

### 7.3 Open bugs and technical debt in the tracker (selection)

| Issue | Title | Priority / milestone | Created |
|---|---|---|---|
| steering#413 | Prolongation problems | Bug P1, 1.3 | 2026-09-15 |
| steering#412 | End date of schedules can not be changed/deleted | Bug P1, 1.3.1 | 2026-08-26 |
| aura#626 | Migrating cba id's to AURA 1.2 failed | Bug P1, 1.3 | 2026-08-26 |
| dashboard-clock#74 | dashboard-clock freezes from time to time | Bug P1, 1.3 | 2026-09-03 |
| engine-core#111 | Engine posts playlog with fallback show id/name, even though another, valid show is scheduled | P1, 2.0 | 2026-03-02 |
| engine-core#119 | Audio Burst when Switching to Fallback | Bug P2, 1.4 | 2026-04-14 |
| engine-core#120 | Since latest liquidsoap update 'possible source leak' is logged | P3, 1.4 | 2026-04-27 |
| engine-core#6 | Latency issues for live audio when running Engine Core in Docker (ALSA) | Bug P2, backlog | 2021-02-26 |
| aura#582 | System resource limit - Scheduled in:stream on dashboard.aura.radio keeps stopping at out:stream | P2, backlog | 2026-03-06 |
| engine-api#72 | filename sent to engine-api is missing directory separator and extension | Bug, backlog | 2026-05-13 |
| battery#14 | Uploading an mp4 file containing video and audio fails silently | Bug P3, backlog | 2026-03-01 |
| dashboard#563 | URLs to specific Dashboard views do not open when user is logged out | Bug P2, 1.4 | 2026-08-27 |
| dashboard#544 | Accessibility testing and fixes | Bug P2, 1.5 | 2026-05-19 |
| aura#396 | Internal Server Error in Playout when Fallback Show is not set | Bug P3, backlog | 2024-10-16 |
| aura#641 | Simplify overall AURA installation and configuration | Epic P1, backlog | 2026-09-21 |
| aura#609 | HTTP APIs for media files instead of filesystem-based Audio Store (to avoid sync/availability and permission problems in distributed installs) | Epic, 2.0 | 2026-05-04 |
| aura#596 | Playout architecture: current split of state between Engine and Engine Core is "potentially error-prone" | Epic P1, 2.0 | 2026-04-11 |

Source: https://gitlab.servus.at/api/v4/groups/aura/issues?state=opened (270 open issues retrieved), accessed 2026-09-29. Of the 270 open issues, 19 carry the label "Bug", 52 "EPIC", 88 "open-decision", 66 "requires-refinement".

### 7.4 Code-level remarks found

- `engine-core/src/out_stream.liq`: "FIXME: Every time this function gets called the playout is interrupted" (Icecast error handler) and "TODO: make enc more flexible, read bitrate etc from settings".
- `engine-core/src/settings.liq`: "FIXME: the function enable_replaygain_metadata does not exist".
- `battery/packages/cut_glue/src/cut_glue/cut_glue.py`: show name in recording file names is a TODO.

---

## 8. Items that could not be verified (consolidated)

| Item | What was tried |
|---|---|
| RTR grant amounts and exact grant periods | Fetched RTR pages for Fonds Digitale Transformation and a 2023 press release; no AURA/STROM text retrievable |
| Involvement of Verband Freier Rundfunk Österreich | Site search on freier-rundfunk.at; AURA docs; no mention. Dedicated web search blocked by exhausted search quota |
| Financing after mid-2026 / long-term maintenance model | Docs, issue aura#621 (empty), station pages |
| Production use at Radio Helsinki, FREIRAD, Proton, Freistadt, Radiofabrik | DNS/HTTP probes of guessed host names, web search, docs |
| Production use at any German station | DNS/HTTP probes, conference pages, web search |
| The partner station using AURA | DNS probe of guessed host, GitLab search; only the Comba origin is documented |
| Names of the "three German free radios" that joined in 2021 | Source gives no names; Wüste Welle and free FM are listed as financial contributors, the third is unknown |
| Exact date and content of the ORANGE 94.0 switch-over announcement | Page returns 404; archive.org lookup was rate-limited (HTTP 429); only a search-engine snippet is available; year 2026 inferred from weekdays |
| Content of the ZWCM 2025 talk (roll-out status AT/DE, transfer between instances) | Only the abstract was read; audio not evaluated |
| Support for external OIDC identity providers | Docs search |
| Cut & Glue operation without AURA Playout | Docs search |
| Existence of a component named "play" / "aura-play" | GitLab group project list |
| Whether the public instances aura.o94.at and aura.fro.at feed the actual FM/on-air signal | The APIs return live playlogs and programme data, which is consistent with production playout, but the probe cannot prove the signal path |
| Minimum hardware requirements | Not present in docs |

---

## 9. Source list

Project
- https://aura.radio/
- https://docs.aura.radio/en/latest/ (and sub-pages cited above)
- https://docs.aura.radio/en/latest/release-notes.html
- https://api.aura.radio/
- https://gitlab.servus.at/aura (group), GitLab REST API v4 at https://gitlab.servus.at/api/v4/
- Repositories: aura/aura, aura/steering, aura/dashboard, aura/battery, aura/engine, aura/engine-core, aura/engine-api, aura/engine-recorder, aura/dashboard-clock, aura/can, aura/aura-contrib/migration-freirad
- https://hub.docker.com/u/autoradio

Stations, funding, conferences
- https://www.fro.at/aura-radioautomation/ (2026-05-06)
- https://www.fro.at/ausschreibung-it-projektmanagement-fuer-aura/ (2022-11-25)
- https://www.fro.at/wir-suchen-einen-python-c-entwicklerin-fuer-das-radio-management-programm-aura/ (2025-04-25)
- https://at.linkedin.com/jobs/view/ausschreibung-projektmanagement-f%C3%BCr-aura-at-radio-fro-105-0-mhz-4121358741 (approx. January 2025)
- https://digital.danubestreamwaves.org/en/2020/11/automated-radio-en/ (2020-11-12)
- https://www.community-media.net/aura-ueberblick-und-ausblick-zum-automated-radio-projekt/ (2020-10-26)
- https://www.community-media.net/aura-automated-radio/ (2022-10-23)
- https://www.community-media.net/aura-automated-radio-2/ (2023-10-30)
- https://www.community-media.net/aura-kennenlernen/ (2024-10-18)
- https://www.community-media.net/aura/ (2025-10-08)
- https://www.commit.at/veranstaltungen/details/studio-und-sendetechnik-update-und-austausch-1 (event 20-21 Nov 2023)
- https://pretalx.linuxtage.at/glt24/talk/9WTAQH/ (talk 2024-04-06)
- https://www.jungewelt.de/artikel/465324.projekt-aura-der-open-source-gedanke.html (2023-12-15, paywalled, only teaser read)

Live instances probed (read-only GET, 2026-09-29)
- https://aura.o94.at/steering/api/v1/ , https://aura.o94.at/engine/api/v1/playlog/current
- https://aura.fro.at/steering/api/v1/ , https://aura.fro.at/engine/api/v1/playlog/current
- https://aura.querfunk.de/
- https://demo.aura.radio/

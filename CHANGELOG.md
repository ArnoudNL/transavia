# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**This software is in beta.** It parses rosters heuristically and its totals
should be checked against the printed roster before being relied on. Version
numbers stay below `1.0.0` until the parser has been verified against every
roster format in use.

The service worker cache version (`VERSION` in `sw.js`) is bumped with every
release so installed copies pick the release up; it is listed against each
entry below.

## [0.13.1-beta] — 2026-07-29 · sw v14

### Fixed
- **The app could hang on "Loading Transavia Roster…" after a refresh.** Adding
  the notes store raised the database version, and a schema upgrade cannot run
  while another connection holds the old one — a second tab, or the page's own
  predecessor kept alive in the back/forward cache. IndexedDB reports that with
  a `blocked` event and then fires neither `success` nor `error`, so the promise
  waiting on those two never settled. `blocked` is now handled, an open
  connection stands aside when another tab needs to upgrade, and every startup
  step is bounded so a stall becomes a message with a Try again button rather
  than an endless splash.
- Running an older build after a newer one no longer refuses to start: the app
  reopens at whatever schema the device holds, provided the stores it needs are
  there.
- A failure while rendering a view no longer leaves the splash covering an app
  that is otherwise working.

### Changed
- The service worker serves the app shell strictly from its versioned cache and
  no longer refreshes individual files into it in the background. That could
  leave `index.html` and `app.js` from different builds, which breaks the app in
  ways that look nothing like a caching problem. A release is now adopted as one
  atomic set when `VERSION` changes.

## [0.13.0-beta] — 2026-07-29 · sw v13

### Added
- **Notes.** Notes can be attached to any flight or ground duty from an inline
  marker on the row, with as many notes per activity as needed. Each note is
  tagged with the activity's date, time and flight number or duty code.
- **Notes tab** between Crew and Data, listing every note with a search that
  filters on note text, flight number, duty code, date and time as you type.
- **Export** to HTML, TXT, JSON or CSV, each carrying the note text and its
  activity metadata.
- **Import** from the same four formats, matching each entry back to its
  activity on date + time + flight number or duty code, and reporting how many
  were imported and how many linked.
- **Local folder storage.** Where the browser supports it, a folder can be
  appointed and notes are mirrored to it on every change. Notes never leave the
  device either way; see the privacy note in `README.md`.
- MIT licence, this changelog, and a version shown on the Data tab.

## [0.12.0-beta] — 2026-07-29 · sw v12

### Changed
- Duty is the sum of a day's duty periods rather than first check-in to last
  check-out. Anything explicitly not duty — a hotel, a standby call-out, the
  tail of a weekend — ends the period it interrupts, so a day with a hotel in
  the middle counts as two duties instead of one impossible one.
- Duty time fell from 13,747 h to 11,976 h across nine rosters as a result;
  average duty day 8:34.

### Added
- Codes confirmed by crew: `SBC` (standby call-out, not duty), `Z06`/`Z14`/`Z22`
  (tail of a weekend), plus `A22`, `WV3` and the `Sxx` standbys extended from
  families the published list establishes.

### Fixed
- Days with no duty figure are reported by reason. "Runs past 20 hours" was
  being applied to days whose only fault was a single timestamp with nothing to
  measure to.

## [0.11.0-beta] — 2026-07-29 · sw v11

### Added
- Transavia's published 97-code list, giving each code a meaning and a category.
  Duty classification follows it instead of inferring from whether a code
  occupies time on the roster.
- Ground-duty rows show the documented meaning with the raw code beside it.

### Fixed
- `A06`/`A14` (weekend) and `VE1`–`VE3` (vacation) were counted as duty because
  they carry an 8-hour span. So were `CIR`, `CT8`, `CG8`, `NI` and `ZB`.

## [0.10.0-beta] — 2026-07-29 · sw v10

### Fixed
- A leg whose STD falls after midnight prints its departure time on the
  following day's row. The merge took the destination but never the departure,
  leaving the leg with no off-blocks time. Legs gained `depDate`.

## [0.9.0-beta] — 2026-07-29 · sw v9

### Fixed
- A leg spanning a printed page break was split in two: the 2013/2014 page
  header carries `C/I LE` rather than `C/I ATD ATA LE`, so it was read as a
  ground duty and closed the open leg. Rows naming neither a place nor a time
  are now ignored outright.

### Added
- Flights search matches the words on screen, so "taxi" finds `TAX`/`PIC`/`HTR`
  and "lisbon" finds `LIS`.
- Tapping the title bar returns the current list to the top.

## [0.8.0-beta] — 2026-07-28 · sw v8

### Fixed
- Flight numbers compare on their unpadded form, so the crew list's `HV97`
  matches the operating row's `HV097` — for both the crew join and deduplication.
- Designators may mix a letter and a digit; `U28882` is easyJet U2 flight 8882.
- `L,4` was read as an activity, swallowing its row's flight. A single-letter
  token is now always a qualifier, which also fixes `L TAX …` (Taxco is a real
  IATA code).

### Added
- Flights tab filter: Flights / Ground duties / Both.
- `TAX`, `PIC`, `HTR` labelled Taxi; `HTL` labelled Hotel.
- Legs left out of block totals are listed with the reason.

## [0.7.0-beta] — 2026-07-28 · sw v7

### Fixed
- Dutch month abbreviations (`OKT`, `MRT`, `MEI`) resolved to nothing, silently
  discarding 78 of 235 crew rows in the 2010 roster — every March, May and
  October.

## [0.6.0-beta] — 2026-07-28 · sw v6

### Added
- The detail sheet can be dragged down to dismiss; a long pull reloads.

## [0.5.0-beta] — 2026-07-28 · sw v5

### Added
- Airport names under the IATA pair in the Flights tab.
- Hours drill-through lists each day's actual legs and ground duties.
- Aircraft icon adopted; earlier icon versions removed.

## [0.4.0-beta] — 2026-07-28 · sw v4

### Added
- Every IATA code, not just currently served airports — 9,753 including 476
  retired ones. `AHU` and `HRK` had been dropped by a `scheduled_service`
  filter, which encodes present-day status.

## [0.3.0-beta] — 2026-07-28 · sw v3

### Added
- Hours tab: block and duty time by week, month or year.
- Retired airport codes (`TXL`, `THF`, `SXF`) recovered from closed fields.

### Fixed
- Roster times are UTC, not local station time. Reading them as local put 104
  legs outside a plausible block speed, `KEF→AMS` at 2038 km/h.

## [0.2.0-beta] — 2026-07-28 · sw v2

### Changed
- Restyled on the transavia.com design system.

## [0.1.0-beta] — 2026-07-28 · sw v1

### Added
- First release: PDF roster parsing, map, routes, flights, crew overlap
  analytics, offline PWA shell.

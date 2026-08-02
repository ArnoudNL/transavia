# Transavia Roster

An offline-first PWA that turns a Crew Roster Portal "Individual Roster" PDF into
a searchable map of everywhere you've flown, who you flew with, and how often.

**Your roster never leaves the device.** The PDF is parsed in the browser, stored
in IndexedDB, and no request is ever made with roster data in it. There is no
account, no sync, no analytics.

## Look and feel

The UI is built on the design tokens published by transavia.com — the same
colour, radius, shadow and type scales, read straight off the live site:

| | |
|---|---|
| Product green | `#00ab61` (dark `#047c42`, darkest `#02391e`) |
| Navy | `#140d8a` (accent `#0b074c`, subtle `#625db1`) |
| Fuchsia | `#e20076` — primary actions only, exactly as on the site |
| Champagne | `#f8f0e9` — used for landmass on the map |
| Ink | `#222` / `#444` / `#6a6a6a` / `#b0b0b0` |
| Canvas | `#fff` / `#f7f7f7`, cards `16px` radius + `0 1px 2px rgba(34,34,34,.05)` |
| Weights | 400 and 600 — the only two the system defines |
| Type scale | heading 24/36 · 20/32, body 18/28 · 16/24 · 14/20 · 12/18 |

Buttons are full pills: fuchsia filled for the primary action, white with a navy
outline for secondary — the same hierarchy as the booking flow.

**The typeface is Söhne**, which Transavia licenses from Klim Type Foundry. It is
*not* bundled here, because redistributing a commercial font file isn't ours to
do. The site's own declared fallback is Arial, so the stack is
`Sohne, "Sohne Fallback", -apple-system, …, Arial` — which renders as SF Pro on
an iPhone. If you have a Söhne licence, drop the woff2 files in `vendor/fonts/`
and add an `@font-face` block; the first entry in the stack already points at it.

**This is not an official Transavia app.** It is an independent personal tool,
not affiliated with, endorsed by, or connected to Transavia. It deliberately does
*not* use the Transavia logo or the "t" mark; the icon is drawn from scratch and
only the brand colours are borrowed. All trademarks belong to their owners.

### Data-visualisation colours

Chart and map colours are derived from the same brand hues and checked for
colour-vision deficiency rather than picked by eye:

* **Route frequency** — a sequential green ramp (`#8fd9b8 → #02391e`), one hue,
  light to dark, five of six steps being real Transavia tokens.
* **Selection** — navy `#140d8a`. Fuchsia was the obvious first choice but
  fuchsia↔green separates by only ΔE 5.9 under deuteranopia; navy clears every
  ramp step by ΔE 29–54. Selected airports also invert to a white fill with a
  thick navy ring, so selection never rests on hue alone.

## Notes

Notes can be attached to any flight or ground duty from the marker on its row,
as many per activity as you like. Each carries the activity's date, time and
flight number or duty code, which is also how an imported note finds its way
back to the right activity.

They are held in this device's IndexedDB. Where the browser supports the File
System Access API — Chrome and Edge on desktop — a folder can be appointed as
well, and the full set is mirrored to `notes.json` inside it after every
change. **iOS Safari has no directory picker**, so on an iPhone the folder step
is hidden; notes stay in the app's private storage and Export puts a copy
wherever you want it.

Either way nothing is uploaded. The notes module makes no network calls at all
— verified by instrumenting `fetch`, `XMLHttpRequest`, `sendBeacon` and
`WebSocket` while adding, listing, exporting, importing and deleting notes.

Export and import both handle HTML, TXT, JSON and CSV. The HTML export doubles
as the printable copy and repeats every field in `data-` attributes, so a round
trip through it loses nothing.

## Version and licence

Released under the [MIT licence](LICENSE). Changes are recorded in
[CHANGELOG.md](CHANGELOG.md), which lists the service-worker cache version
against each release so you can tell what an installed copy is running.

**This is beta software.** It reads rosters heuristically; check its totals
against the printed roster before relying on them.

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell — six tabs, filter sheet, detail sheet |
| `styles.css` | Transavia-styled UI, iPhone safe-area aware |
| `app.js` | Roster parser, IndexedDB layer, map, analytics |
| `manifest.json` | PWA manifest (standalone, icons) |
| `sw.js` | Service worker — precaches the shell, caches map tiles |
| `LICENSE`, `CHANGELOG.md` | MIT licence and release history |
| `vendor/` | Leaflet 1.9.4 and pdf.js 3.11 (legacy build), served locally |
| `data/airports.json` | 9,753 IATA airports — coordinates, time zone, closed flag |
| `data/world.geo.json` | Simplified world outline, so the map works with no network |
| `icons/` | App icons, including maskable and apple-touch |

Nothing is loaded from a CDN. The only optional network use is the *online map
tiles* toggle, which is **off** by default.

## Run it locally

```bash
python3 .claude/serve.py 8765 roster-atlas
```

Then open <http://localhost:8765>. A plain `python3 -m http.server` also works
for browsing, but it is single-threaded and stalls the pdf.js worker request —
use the threaded `serve.py` above.

## Put it on an iPhone home screen

Service workers require a **secure context**: `https://` or `localhost`. A LAN
address like `http://192.168.1.5:8765` is *not* secure, so the app will run but
will not install or work offline.

1. Publish this folder to any static host over HTTPS — GitHub
   Pages, Netlify, Cloudflare Pages. The host only ever serves the app; it never
   sees a roster, because parsing happens on the phone.
2. Open the URL in Safari on the iPhone.
3. Share → **Add to Home Screen**.
4. Launch from the home screen. It opens without Safari chrome, and after the
   first launch it works in airplane mode.

Import your PDFs from the **Data** tab — the file picker reaches iCloud Drive,
On My iPhone, and anything else in Files.

## What it reads from the roster

* **Flight legs** — date, flight number, origin/destination, check-in, off/on
  blocks, check-out, aircraft type, and qualifier codes. Legs printed across
  midnight (departure on one day's row, arrival on the next) are stitched back
  into one leg.
* **Ground duties** — standby, simulator, bus/taxi positioning, hotels, and so
  on, kept separately and shown in the Flights tab behind a toggle.
* **Crew onboard** — the per-flight crew list at the back of the roster. This is
  what makes the overlap analytics work from a single person's PDF.
* **Day notes** — attached to the matching date.

Dates are reconstructed from the day-of-month + weekday columns by walking
forward from the reporting period, which is why a full-year roster resolves
without ambiguity.

### Deduplication

A leg's identity is `date | flight number | origin | destination`. Re-importing
the same PDF, or importing overlapping years, updates the existing record and
unions the crew lists instead of creating a duplicate. The import log reports
how many legs were new and how many were merged.

### Other formats

If you'd rather not use a PDF, the importer also accepts CSV/JSON with columns
`date, flightNo, from, to, dep, arr, crew` (crew separated by `;`).

## Notes on accuracy

* Roster times are **UTC (Zulu)** — the roster's own day notes say so
  (`1350z-2110z`). They are shown exactly as printed, and block/duty totals are
  therefore plain arithmetic. Local station times shown in the leg detail are
  derived from the airport's IANA time zone.
  *(Verified empirically: treating the times as local station times instead puts
  the implied block speed of 104 legs outside 350–950 km/h, KEF→AMS at
  2038 km/h. Read as UTC, only one leg falls outside that band.)*
* Distances are great-circle between airport coordinates.
* The airport table carries **every IATA code**, not just the currently busy
  ones — 9,753 of them, covering 100% of the IATA codes in both upstream
  sources plus 476 retired codes. Two filters were deliberately *not* applied,
  because both encode a *present-day* status and silently drop airports that
  were perfectly normal destinations when the roster was flown:
  * `scheduled_service` — Kharkiv (HRK) and Al Hoceima (AHU) both read `no`
    today. Filtering on it dropped 5,004 IATA-coded airports.
  * airport size/type — small fields and seaplane bases hold real codes.
* **Retired codes** (TXL, THF, SXF …) are recovered from OurAirports' keywords
  on closed fields, since the `iata_code` column is blanked once an airport
  shuts. A code that is live today always resolves to its current holder — that
  is what stops Tempelhof from claiming `BER`. Closed airports are labelled in
  the UI. The one case this cannot resolve is a code retired *and later
  reassigned*: it resolves to the current holder.
* Airports not in `data/airports.json` are still stored, but cannot be mapped —
  the import log lists them.

## Third-party components

Vendored locally rather than pulled from a CDN, so the app works offline and
makes no third-party requests:

| Component | Licence |
|---|---|
| [Leaflet](https://leafletjs.com) 1.9.4 | BSD-2-Clause |
| [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 (legacy build) | Apache-2.0 |
| Airport coordinates — [OurAirports](https://ourairports.com/data/) | Public domain |
| World outline — [Natural Earth](https://www.naturalearthdata.com) | Public domain |

Söhne is *not* included; see the typography note above.

## Updating a deployed copy

`sw.js` serves the shell stale-while-revalidate, so a redeployed file is picked
up on the *next* launch. To force every client to refresh immediately, bump
`VERSION` in `sw.js` (and `SW_TAG` in `app.js`, which only feeds the status line
on the Data tab).

/* ============================================================================
   Transavia Roster — offline-first crew roster mapper
   Everything runs on-device. No network calls are made with roster data.
   ========================================================================== */
'use strict';

/* ── 1. small utilities ─────────────────────────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmtInt = n => n.toLocaleString('en-GB');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const WEEKDAY = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };

const utc  = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);
const iso  = dt => dt.toISOString().slice(0, 10);
const parseIso = s => { const [y,m,d] = s.split('-').map(Number); return utc(y, m - 1, d); };

const DAY_FMT   = new Intl.DateTimeFormat('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
const SHORT_FMT = new Intl.DateTimeFormat('en-GB', { day:'2-digit', month:'short', year:'2-digit', timeZone:'UTC' });
const fmtDay   = s => DAY_FMT.format(parseIso(s));
const fmtShort = s => SHORT_FMT.format(parseIso(s));

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/** Great-circle distance in km. */
function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))));
}

/** Great-circle path, split at the antimeridian so Leaflet never draws a seam. */
function gcSegments(a, b, n = 48) {
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const φ1 = a[0] * rad, λ1 = a[1] * rad, φ2 = b[0] * rad, λ2 = b[1] * rad;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (!isFinite(d) || d === 0) return [[a, b]];

  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([Math.atan2(z, Math.hypot(x, y)) * deg, Math.atan2(y, x) * deg]);
  }
  const segs = [[pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][1] - pts[i - 1][1]) > 180) segs.push([]);
    segs[segs.length - 1].push(pts[i]);
  }
  return segs.filter(s => s.length > 1);
}

/* ── 2. IndexedDB ───────────────────────────────────────────────────────── */

/* Do NOT rename DB_NAME. It is the IndexedDB database key: changing it points
   the app at a fresh, empty database and orphans every roster already imported
   on someone's phone. The app's display name is independent of it. */
const DB_NAME = 'roster-atlas', DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ev => {
      const d = ev.target.result;
      if (!d.objectStoreNames.contains('flights')) {
        const s = d.createObjectStore('flights', { keyPath: 'id' });
        s.createIndex('date', 'date');
        s.createIndex('route', 'route');
        s.createIndex('crew', 'crew', { multiEntry: true });
      }
      if (!d.objectStoreNames.contains('duties')) {
        d.createObjectStore('duties', { keyPath: 'id' }).createIndex('date', 'date');
      }
      if (!d.objectStoreNames.contains('people'))  d.createObjectStore('people',  { keyPath: 'key' });
      if (!d.objectStoreNames.contains('sources')) d.createObjectStore('sources', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))    d.createObjectStore('meta',    { keyPath: 'k' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

const tx = (stores, mode) => db.transaction(stores, mode);
function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbDone(t) { return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
const getAll = store => idbReq(tx([store], 'readonly').objectStore(store).getAll());

async function putAll(store, items) {
  if (!items.length) return;
  const t = tx([store], 'readwrite'), os = t.objectStore(store);
  for (const it of items) os.put(it);
  await idbDone(t);
}
async function clearAll() {
  const names = ['flights', 'duties', 'people', 'sources', 'meta'];
  const t = tx(names, 'readwrite');
  names.forEach(n => t.objectStore(n).clear());
  await idbDone(t);
}
async function metaGet(k, dflt) {
  const v = await idbReq(tx(['meta'], 'readonly').objectStore('meta').get(k));
  return v ? v.v : dflt;
}
const metaSet = (k, v) => putAll('meta', [{ k, v }]);

/* ── 3. reference data ──────────────────────────────────────────────────── */

/* Airport table: IATA -> [lat, lon, name, city, country, zoneIndex, closed]
   It deliberately includes *retired* codes (TXL, THF, SXF …) recovered from
   OurAirports' keywords on closed fields, so a roster flown while the airport
   was open still maps. A code that is live today always resolves to its
   current holder — that is what keeps Tempelhof from claiming BER. */
let AIRPORTS = {};
let ZONES = [];
let WORLD = null;           // bundled coastline GeoJSON

async function loadReference() {
  const [ap, w] = await Promise.all([
    fetch('data/airports.json').then(r => r.json()).catch(() => null),
    fetch('data/world.geo.json').then(r => r.json()).catch(() => null),
  ]);
  if (ap && ap.airports) { AIRPORTS = ap.airports; ZONES = ap.zones || []; }
  else if (ap) { AIRPORTS = ap; ZONES = []; }          // tolerate the old flat file
  WORLD = w;
}
const apPos  = c => (AIRPORTS[c] ? [AIRPORTS[c][0], AIRPORTS[c][1]] : null);
const apName = c => { const a = AIRPORTS[c]; return a ? (a[3] || a[2] || c) : c; };
const apFull = c => { const a = AIRPORTS[c]; return a ? [a[2] || a[3], a[3] && a[2] ? a[3] : '', a[4]].filter(Boolean).join(', ') : 'Unknown airport'; };
const apCountry = c => (AIRPORTS[c] ? AIRPORTS[c][4] : null);
const apTz      = c => { const a = AIRPORTS[c]; return a && a[5] >= 0 ? ZONES[a[5]] : null; };
const apClosed  = c => !!(AIRPORTS[c] && AIRPORTS[c][6]);

/* ── times ──────────────────────────────────────────────────────────────── */
/* Crew Roster Portal prints every time in UTC (Zulu) — the roster's own day
   notes spell it out ("1350z-2110z"). Durations are therefore plain
   subtraction; converting through station time zones inflates every
   zone-crossing leg by the offset (it put KEF→AMS at 2038 km/h).
   The zone table is still carried so local arrival times can be shown. */

const _tzFmt = new Map();
function tzOffset(ts, tz) {
  let f = _tzFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _tzFmt.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(ts)) if (x.type !== 'literal') p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ts;
}
/** A roster date + Zulu time -> UTC milliseconds. */
function rosterInstant(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  if ([y, m, d, hh, mm].some(n => !isFinite(n))) return null;
  return Date.UTC(y, m - 1, d, hh, mm);
}
/** Format a UTC instant as wall-clock time at an airport. */
function localAt(ts, code) {
  const tz = apTz(code);
  if (ts == null || !tz) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(ts);
}
const MAXDUR = 20 * 3600000;

/** Block time (off blocks -> on blocks) in minutes, or null when unknowable. */
function legBlock(f) {
  const a = rosterInstant(f.date, f.dep);
  const b = rosterInstant(f.arrDate || f.date, f.arr);
  if (a == null || b == null) return null;
  let d = b - a;
  if (d < 0) d += 86400000;               // arrival rolled past midnight
  return (d < 0 || d > MAXDUR) ? null : Math.round(d / 60000);
}
const fmtHM = min => (min == null ? '—' : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`);
const fmtHours = min => (min == null ? '—' : (min / 60).toFixed(min >= 6000 ? 0 : 1) + ' h');

/* ── 4. roster parser ───────────────────────────────────────────────────── */
/* Tuned against Crew Roster Portal "Individual Roster" exports.
   Rows look like:
     28THU U,K HV5105 08:05 EIN 09:18 VLC 11:40 73H
            │   │      │    │   │     │   │     └ aircraft
            │   │      │    │   │     │   └ arrival (or check-out on the last leg)
            │   │      │    │   │     └ destination
            │   │      │    │   └ departure
            │   │      │    └ origin
            │   │      └ check-in
            │   └ activity (flight number, or a ground-duty code)
            └ qualifier flags
   The "Crew onboard" section then lists, per date + flight, everyone else aboard. */

const RE = {
  dayRow:   /^(\d{2})(MON|TUE|WED|THU|FRI|SAT|SUN)\b/,
  period:   /^(\d{2})([A-Z]{3})(\d{2})\s*-\s*(\d{2})([A-Z]{3})(\d{2})$/,
  flightNo: /^[A-Z]{2}\d{2,4}[A-Z]?$/,
  time:     /^([01]\d|2[0-3]):([0-5]\d)$/,
  iata:     /^[A-Z]{3}$/,
  acType:   /^\d{2}[A-Z0-9]$/,
  flags:    /^[A-Z]{1,2}(,[A-Z]{1,2})*$/,
  crewRow:  /^(\d{2})([A-Z]{3})(\d{2})\s+([A-Z]{2}\d{2,4}[A-Z]?)\s+(.+)$/,
  noteRow:  /^(\d{2})([A-Z]{3})(\d{2})\s+(.+)$/,
  /* Owner banner: "<surname> <first name> <code> <staff no> <licences> <phone>",
     e.g. "Doe John ABC 12345 XXX;YY;ZZ 1234". The licence block is sometimes
     absent, so it is optional. */
  owner:    /^(.{3,40}?)\s+([A-Z]{2,3})\s+(\d{4,6})(?:\s+[A-Z]{1,3};|\s*$)/,
  ownerAlt: /^(\d{4,6})([A-Z]{2,3})(.{3,40}?)\s+\d{3,5}[A-Z]{1,3};/,
  personSplit: /^[A-Za-z]?[a-z]?\.$/,
};

const SECTION = {
  'Crew onboard': 'crew',
  'Hotels': 'hotel',
  'Day Notes': 'daynote',
  'Activity Notes': 'actnote',
  'Activity related information': 'info',
};

function isChrome(s) {
  return /^Individual Roster/.test(s)
      || /^Page \d+ of/.test(s)
      || /^Crew Roster Portal/.test(s)
      || /^\d+\.\d+\.\d+(\.\d+)?$/.test(s)
      || /^\d{2}[A-Z]{3}\d{2}\s+\d{2}:\d{2}$/.test(s)
      || /^[A-Z]{3}-[A-Z]{2}\s+\d+$/.test(s)
      || /^C\/I\s+ATD/.test(s)
      || /^Date\s+\S+\s+Activity/.test(s)
      || /^(ATA|Rq\s*AC|RqAC)/.test(s);
}

const normKey = s => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9. ']/g, '').trim();

/** "R. van der Weijden C. Tuin (U,K)" -> [{name, tags}] */
function splitCrewNames(str) {
  const out = [];
  let cur = null;
  for (const tok of str.split(/\s+/)) {
    if (!tok) continue;
    if (RE.personSplit.test(tok) && !/^(e\.v\.|ev\.)$/i.test(tok)) { if (cur) out.push(cur); cur = [tok]; }
    else if (!cur) cur = [tok];
    else cur.push(tok);
  }
  if (cur) out.push(cur);
  return out.map(parts => {
    const raw  = parts.join(' ');
    const tags = (raw.match(/\(([^)]*)\)/g) || []).map(t => t.slice(1, -1));
    const name = raw.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    return { name, tags: tags.join(',').split(',').filter(Boolean) };
  }).filter(p => p.name && p.name !== '.');
}

function parseDayRow(rest) {
  const toks = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  const flags = [];
  /* Leading 1–2 letter tokens are qualifier flags ("V", "U,K") — but a bare
     two-letter token can also BE the activity ("FA AMS 08:00 AMS 11:45").
     It is the activity when what follows is a real airport plus a time; it is
     a flag when what follows is another duty code ("L HOS AMS 07:00 …"). */
  while (i < toks.length && RE.flags.test(toks[i])) {
    const nxt = toks[i + 1], nxt2 = toks[i + 2];
    if (!nxt) break;
    if (RE.time.test(nxt)) break;
    if (RE.iata.test(nxt) && AIRPORTS[nxt] && nxt2 && RE.time.test(nxt2)) break;
    flags.push(toks[i]); i++;
  }
  if (i >= toks.length) return null;
  const activity = toks[i++];

  const pairs = []; let ci = null, co = null, ac = null; const notes = [];
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (RE.time.test(t)) {
      if (!pairs.length) ci = ci || t;
      else if (pairs[pairs.length - 1].t == null) pairs[pairs.length - 1].t = t;
      else co = t;
    } else if (RE.acType.test(t)) ac = t;
    else if (RE.iata.test(t)) pairs.push({ ap: t, t: null });
    else notes.push(t);
  }
  return { flags: flags.join(',').split(',').filter(Boolean), activity, pairs, ci, co, ac, notes };
}

/**
 * @param {string[]} lines  visual lines, top-to-bottom, in reading order
 * @returns {{owner, ownerKey, period, flights, duties, warnings, crewRows}}
 */
function parseRoster(lines) {
  const res = {
    owner: null, ownerKey: null, period: null,
    flights: [], duties: [], people: new Map(),
    dayNotes: new Map(), hotels: [], warnings: [], crewRows: 0,
  };
  let cursor = null, hardEnd = null, mode = 'roster', lastCrewRow = null, openLeg = null;

  const noteDate = (dd, mmm, yy) => {
    const m = MONTHS.indexOf(mmm);
    return m < 0 ? null : iso(utc(2000 + +yy, m, +dd));
  };
  const addPerson = (name, tags) => {
    const key = normKey(name);
    if (!key) return null;
    const p = res.people.get(key) || { key, name, tags: new Set() };
    if (name.length > p.name.length) p.name = name;      // prefer the fuller spelling
    (tags || []).forEach(t => p.tags.add(t));
    res.people.set(key, p);
    return key;
  };

  for (const raw of lines) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s) continue;

    if (SECTION[s]) { mode = SECTION[s]; lastCrewRow = null; continue; }

    const per = RE.period.exec(s);
    if (per) {
      const a = utc(2000 + +per[3], MONTHS.indexOf(per[2]), +per[1]);
      const b = utc(2000 + +per[6], MONTHS.indexOf(per[5]), +per[4]);
      if (!res.period) { res.period = [iso(a), iso(b)]; cursor = a; hardEnd = addDays(b, 40); }
      continue;
    }
    /* The owner banner repeats on every page — always consume it, otherwise the
       later copies get parsed as ground duties. */
    const o = RE.owner.exec(s) || RE.ownerAlt.exec(s);
    if (o) {
      if (!res.owner) {
        res.owner = (RE.owner.test(s) ? o[1] : o[3]).trim();
        res.ownerKey = normKey(res.owner);
        res.people.set(res.ownerKey, { key: res.ownerKey, name: res.owner, tags: new Set(), isOwner: true });
      }
      continue;
    }
    if (isChrome(s)) continue;

    /* ---- crew-composition section ---- */
    if (mode === 'crew') {
      const m = RE.crewRow.exec(s);
      if (m) {
        const date = noteDate(m[1], m[2], m[3]);
        if (!date) continue;
        lastCrewRow = { date, flightNo: m[4], names: splitCrewNames(m[5]) };
        res.crewRows++;
        (res.crewByFlight ||= new Map()).set(date + '|' + m[4], lastCrewRow.names);
      } else if (lastCrewRow) {                       // wrapped continuation line
        const extra = splitCrewNames(s);
        lastCrewRow.names.push(...extra);
        res.crewByFlight.set(lastCrewRow.date + '|' + lastCrewRow.flightNo, lastCrewRow.names);
      }
      continue;
    }
    if (mode === 'daynote' || mode === 'actnote') {
      const m = RE.noteRow.exec(s);
      if (m) { const d = noteDate(m[1], m[2], m[3]); if (d) res.dayNotes.set(d, (res.dayNotes.get(d) ? res.dayNotes.get(d) + ' · ' : '') + m[4]); }
      continue;
    }
    if (mode === 'hotel') {
      const m = /^(\d{2})([A-Z]{3})(\d{2})\s*-\s*(\d{2})([A-Z]{3})(\d{2})\s+(.+)$/.exec(s);
      if (m) { const d = noteDate(m[1], m[2], m[3]); if (d) res.hotels.push({ date: d, text: m[7] }); }
      continue;
    }
    if (mode !== 'roster') continue;

    /* ---- roster rows ---- */
    let body = s;
    const dm = RE.dayRow.exec(s);
    if (dm) {
      if (!cursor) { res.warnings.push('Roster rows appear before the reporting period was found.'); continue; }
      const dd = +dm[1], wd = WEEKDAY[dm[2]];
      let found = null;
      for (let k = 0; k < 400; k++) {
        const d = addDays(cursor, k);
        if (d.getUTCDate() === dd && d.getUTCDay() === wd) { found = d; break; }
      }
      if (!found || found > hardEnd) { res.warnings.push(`Could not place date "${dm[0]}".`); continue; }
      cursor = found;
      body = s.slice(dm[0].length).trim();
      /* openLeg deliberately survives a date change: a leg that lands after
         midnight is printed as the first row of the following day. */
    }
    if (!cursor || !body) continue;

    const row = parseDayRow(body);
    if (!row) continue;
    const date = iso(cursor);

    if (RE.flightNo.test(row.activity)) {
      /* A leg printed across midnight arrives on the next roster row. */
      if (row.pairs.length === 1 && openLeg && openLeg.flightNo === row.activity && !openLeg.to) {
        openLeg.to = row.pairs[0].ap; openLeg.arr = row.pairs[0].t;
        openLeg.arrDate = date; openLeg.co = row.co || openLeg.co;
        openLeg = null; continue;
      }
      const from = row.pairs[0] ? row.pairs[0].ap : null;
      const to   = row.pairs[1] ? row.pairs[1].ap : null;
      if (!from) continue;
      const f = {
        date, flightNo: row.activity, from, to,
        dep: row.pairs[0] ? row.pairs[0].t : null,
        arr: row.pairs[1] ? row.pairs[1].t : null,
        arrDate: date, ci: row.ci, co: row.co, ac: row.ac,
        tags: [...row.flags, ...row.notes.filter(n => /^[A-Z]/.test(n))],
        passive: row.flags.includes('P') || row.notes.includes('P'),
      };
      if (f.arr && f.dep && f.arr < f.dep) f.arrDate = iso(addDays(cursor, 1));
      res.flights.push(f);
      openLeg = to ? null : f;
    } else {
      const from = row.pairs[0] ? row.pairs[0].ap : null;
      res.duties.push({
        date, code: row.activity, from,
        to: row.pairs[1] ? row.pairs[1].ap : null,
        start: row.pairs[0] ? row.pairs[0].t : row.ci,
        end: row.pairs[1] ? row.pairs[1].t : row.co,
        ci: row.ci, co: row.co,
      });
      openLeg = null;
    }
  }

  /* attach crew composition + day notes to the legs */
  const byFlight = res.crewByFlight || new Map();
  for (const f of res.flights) {
    const names = byFlight.get(f.date + '|' + f.flightNo) || [];
    const keys = [];
    for (const p of names) { const k = addPerson(p.name, p.tags); if (k) keys.push(k); }
    if (res.ownerKey) keys.unshift(res.ownerKey);
    f.crew = [...new Set(keys)];
    f.note = res.dayNotes.get(f.date) || null;
  }
  for (const d of res.duties) { d.owner = res.ownerKey; d.note = res.dayNotes.get(d.date) || null; }

  if (!res.flights.length) res.warnings.push('No flight legs were recognised in this file.');
  return res;
}

/* ── 5. file readers ────────────────────────────────────────────────────── */

let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = (async () => {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf.min.js';
      s.onload = res;
      s.onerror = () => rej(new Error('Could not load vendor/pdf.min.js'));
      document.head.appendChild(s);
    });
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('pdf.js failed to initialise');
    /* Hand pdf.js the worker as a blob URL rather than a path: some embedded
       WebViews never resolve a worker fetched by URL, and this also keeps the
       worker on the same origin when the app is opened from a home screen. */
    try {
      const src = await fetch('vendor/pdf.worker.min.js').then(r => {
        if (!r.ok) throw new Error('worker HTTP ' + r.status);
        return r.text();
      });
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch (err) {
      console.warn('[pdf] falling back to worker path', err);
      lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    return lib;
  })();
  return pdfjsReady;
}

/* One worker for the whole session. Spawning a worker per document exhausts the
   browser's dedicated-worker budget when several rosters are imported at once,
   and new documents then stall silently. */
let pdfWorker = null;
async function getPdfWorker() {
  const lib = await loadPdfJs();
  if (!pdfWorker || pdfWorker.destroyed) pdfWorker = new lib.PDFWorker({ name: 'roster-atlas' });
  return { lib, worker: pdfWorker };
}

/** Rebuild visual lines from a PDF's text layer: group by baseline, sort by x. */
async function pdfToLines(file, onProgress) {
  const { lib, worker } = await getPdfWorker();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: new Uint8Array(buf), worker, isEvalSupported: false }).promise;
  const lines = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = Math.round(it.transform[5] * 2) / 2;
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push([it.transform[4], it.str]);
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const line = rows.get(y).sort((a, b) => a[0] - b[0]).map(x => x[1]).join(' ').replace(/\s+/g, ' ').trim();
        if (line) lines.push(line);
      }
      page.cleanup();
      onProgress && onProgress(p / doc.numPages);
    }
  } finally {
    await doc.destroy();      // frees the document; the shared worker stays up
  }
  return lines;
}

const readText = file => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload  = () => res(String(fr.result));
  fr.onerror = () => rej(fr.error);
  fr.readAsText(file);
});

/** CSV/JSON escape hatch: date,flightNo,from,to,dep,arr,crew(;-separated) */
function parseTabular(text, filename) {
  const t = text.trim();
  let rows;
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    rows = Array.isArray(j) ? j : (j.flights || []);
  } else {
    const lines = t.split(/\r?\n/).filter(Boolean);
    const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
    const head = lines[0].split(delim).map(h => h.trim().toLowerCase());
    rows = lines.slice(1).map(l => {
      const c = l.split(delim); const o = {};
      head.forEach((h, i) => o[h] = (c[i] || '').trim());
      return o;
    });
  }
  const pick = (o, ...names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; return null; };
  const out = { owner: null, ownerKey: null, period: null, flights: [], duties: [], people: new Map(), warnings: [], crewRows: 0, dayNotes: new Map(), hotels: [] };
  for (const r of rows) {
    const date = String(pick(r, 'date', 'day', 'datum') || '').slice(0, 10);
    const from = String(pick(r, 'from', 'orig', 'origin', 'dep_ap') || '').toUpperCase();
    const to   = String(pick(r, 'to', 'dest', 'destination', 'arr_ap') || '').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !RE.iata.test(from) || !RE.iata.test(to)) continue;
    const crewRaw = pick(r, 'crew', 'crewmembers', 'bemanning') || '';
    const names = Array.isArray(crewRaw) ? crewRaw : String(crewRaw).split(/[;|]/);
    const keys = [];
    for (const n of names.map(x => String(x).trim()).filter(Boolean)) {
      const k = normKey(n);
      if (!out.people.has(k)) out.people.set(k, { key: k, name: n, tags: new Set() });
      keys.push(k);
    }
    out.flights.push({
      date, arrDate: date, flightNo: String(pick(r, 'flightno', 'flight', 'flight_no', 'vlucht') || 'N/A').toUpperCase(),
      from, to, dep: pick(r, 'dep', 'std', 'departure'), arr: pick(r, 'arr', 'sta', 'arrival'),
      ci: pick(r, 'ci', 'checkin'), co: pick(r, 'co', 'checkout'), ac: pick(r, 'ac', 'aircraft'),
      tags: [], passive: String(pick(r, 'passive') || '').toLowerCase() === 'true', crew: [...new Set(keys)], note: null,
    });
  }
  if (!out.flights.length) out.warnings.push(`No usable rows found in ${filename}.`);
  return out;
}

/* ── 6. import pipeline (parse → normalise → dedupe → store) ────────────── */

const flightId = f => `${f.date}|${f.flightNo}|${f.from}|${f.to || '???'}`;
const dutyId   = d => `${d.owner || '?'}|${d.date}|${d.code}|${d.from || ''}|${d.start || ''}`;
const routeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

async function importFiles(fileList) {
  const log = $('#importLog');
  log.hidden = false; log.innerHTML = '';
  const line = (cls, html) => { const p = el('div', cls); p.innerHTML = html; log.appendChild(p); return p; };

  const [existingFlights, existingDuties, existingPeople] = await Promise.all(
    ['flights', 'duties', 'people'].map(getAll));
  const fMap = new Map(existingFlights.map(f => [f.id, f]));
  const dMap = new Map(existingDuties.map(d => [d.id, d]));
  const pMap = new Map(existingPeople.map(p => [p.key, p]));

  let totalNew = 0, totalMerged = 0;
  const sources = [];

  for (const file of fileList) {
    const head = line('', `<b>${esc(file.name)}</b> — reading…`);
    const bar  = el('div', 'progress'); const barIn = el('i'); bar.appendChild(barIn); head.appendChild(bar);
    try {
      let parsed;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const lines = await pdfToLines(file, p => { barIn.style.width = (p * 100).toFixed(0) + '%'; });
        parsed = parseRoster(lines);
      } else {
        const text = await readText(file);
        barIn.style.width = '100%';
        parsed = /^\s*[[{]/.test(text) || /[,;]/.test(text.split('\n')[0] || '')
          ? (/^\s*[[{]/.test(text) || /(^|[,;])\s*(from|orig|origin)\s*([,;]|$)/i.test(text.split('\n')[0] || '')
              ? parseTabular(text, file.name)
              : parseRoster(text.split(/\r?\n/)))
          : parseRoster(text.split(/\r?\n/));
        if (!parsed.flights.length && !/^\s*[[{]/.test(text)) {
          const alt = parseTabular(text, file.name);
          if (alt.flights.length) parsed = alt;
        }
      }

      /* people */
      for (const p of parsed.people.values()) {
        const prev = pMap.get(p.key);
        pMap.set(p.key, {
          key: p.key,
          name: prev && prev.name.length > p.name.length ? prev.name : p.name,
          isOwner: !!(p.isOwner || (prev && prev.isOwner)),
          tags: [...new Set([...(prev ? prev.tags || [] : []), ...p.tags])],
        });
      }

      /* flights — merge on identity, union the crew lists */
      let neu = 0, merged = 0, unknown = new Set(), retired = new Set();
      for (const f of parsed.flights) {
        const id = flightId(f);
        const rec = fMap.get(id);
        [f.from, f.to].forEach(c => {
          if (!c) return;
          if (!AIRPORTS[c]) unknown.add(c);
          else if (apClosed(c)) retired.add(c);
        });
        const km = (f.from && f.to && apPos(f.from) && apPos(f.to)) ? haversine(apPos(f.from), apPos(f.to)) : null;
        if (rec) {
          rec.crew    = [...new Set([...(rec.crew || []), ...(f.crew || [])])];
          rec.sources = [...new Set([...(rec.sources || []), file.name])];
          rec.owners  = [...new Set([...(rec.owners || []), ...(parsed.ownerKey ? [parsed.ownerKey] : [])])];
          rec.note    = rec.note || f.note;
          merged++;
        } else {
          fMap.set(id, {
            ...f, id, km,
            route: (f.from && f.to) ? routeKey(f.from, f.to) : null,
            owners: parsed.ownerKey ? [parsed.ownerKey] : [],
            sources: [file.name],
          });
          neu++;
        }
      }
      let dNew = 0;
      for (const d of parsed.duties) {
        const id = dutyId(d);
        if (dMap.has(id)) {
          const r = dMap.get(id);
          r.sources = [...new Set([...(r.sources || []), file.name])];
        } else { dMap.set(id, { ...d, id, owners: d.owner ? [d.owner] : [], sources: [file.name] }); dNew++; }
      }
      totalNew += neu; totalMerged += merged;

      sources.push({
        id: `${file.name}|${file.size}`, name: file.name, size: file.size,
        imported: Date.now(), owner: parsed.owner || null,
        period: parsed.period ? parsed.period.join(' → ') : null,
        flights: parsed.flights.length, duties: parsed.duties.length, crewRows: parsed.crewRows,
      });

      bar.remove();
      head.innerHTML = `<b>${esc(file.name)}</b><br>` +
        `<span class="ok">✓ ${fmtInt(neu)} new leg${neu === 1 ? '' : 's'}</span>` +
        (merged ? ` · ${fmtInt(merged)} already known (merged)` : '') +
        (dNew ? ` · ${fmtInt(dNew)} ground duties` : '') +
        (parsed.owner ? `<br>Roster of <b>${esc(parsed.owner)}</b>` : '') +
        (parsed.period ? ` · ${esc(parsed.period.join(' → '))}` : '') +
        (parsed.crewRows ? `<br>${fmtInt(parsed.crewRows)} crew-composition rows → ${fmtInt(parsed.people.size)} people` : '');
      if (retired.size) head.innerHTML += `<br>Closed airports resolved: ${[...retired].map(c => {
        const a = AIRPORTS[c];
        return `<b>${esc(c)}</b> ${esc(a && a[2] ? a[2] : apName(c))}`;   // prefer the distinctive name over the city
      }).join(', ')}`;
      if (unknown.size) head.innerHTML += `<br><span class="warn">⚠ Not in the airport table, so not mapped: ${[...unknown].join(', ')}</span>`;
      for (const w of parsed.warnings.slice(0, 4)) head.innerHTML += `<br><span class="warn">⚠ ${esc(w)}</span>`;
    } catch (err) {
      bar.remove();
      head.innerHTML = `<b>${esc(file.name)}</b><br><span class="err">✗ ${esc(err.message || String(err))}</span>`;
      console.error(err);
    }
  }

  await putAll('people', [...pMap.values()]);
  await putAll('flights', [...fMap.values()]);
  await putAll('duties', [...dMap.values()]);
  await putAll('sources', sources);

  line('', `<b>Done.</b> ${fmtInt(totalNew)} new, ${fmtInt(totalMerged)} deduplicated.`);
  await loadData();
  refreshAll();
  toast(totalNew ? `${fmtInt(totalNew)} flights imported` : 'Nothing new — already up to date');
}

/* ── 7. in-memory state ─────────────────────────────────────────────────── */

/* Ground codes not counted as duty out of the box. Hotel is rest; everything
   else is judged by whether it occupies real time (see isWorkItem), and the
   user can override any of it from the Hours tab. */
const REST_CODES_DEFAULT = ['HTL'];

const S = {
  flights: [], duties: [], people: new Map(), sources: [], aliases: {},
  filter: { from: null, to: null, crew: [], passive: true },
  overlap: { crew: [], from: null, to: null },
  view: 'map', selectedRoute: null, tiles: false, labels: true,
  routeSort: 'count', flightLimit: 200, hoursMode: 'month',
  excluded: new Set(REST_CODES_DEFAULT),   // ground codes the user says aren't duty
};

const alias = k => S.aliases[k] || k;
const personName = k => { const p = S.people.get(alias(k)); return p ? p.name : k; };
const isOwner = k => { const p = S.people.get(alias(k)); return !!(p && p.isOwner); };

async function loadData() {
  const [f, d, p, s] = await Promise.all([getAll('flights'), getAll('duties'), getAll('people'), getAll('sources')]);
  S.aliases = await metaGet('aliases', {});
  S.people = new Map();
  for (const x of p) if (!S.aliases[x.key]) S.people.set(x.key, x);
  S.flights = f.map(x => ({ ...x, crew: [...new Set((x.crew || []).map(alias))] }))
               .sort((a, b) => (a.date === b.date ? (a.dep || '').localeCompare(b.dep || '') : a.date.localeCompare(b.date)));
  S.duties = d.sort((a, b) => a.date.localeCompare(b.date));
  S.sources = s.sort((a, b) => b.imported - a.imported);

  /* Legs imported against an older airport table may have no route/distance —
     a retired code like TXL used to resolve to nothing. Backfill them now that
     the table knows about closed airports, and persist so it happens once. */
  const healed = [];
  for (const x of S.flights) {
    if (!x.from || !x.to || x.from === x.to) continue;
    if (!apPos(x.from) || !apPos(x.to)) continue;
    const route = routeKey(x.from, x.to);
    const km = haversine(apPos(x.from), apPos(x.to));
    if (x.route !== route || x.km !== km) { x.route = route; x.km = km; healed.push(x); }
  }
  if (healed.length) {
    await putAll('flights', healed);
    console.info(`[transavia-roster] backfilled route/distance on ${healed.length} leg(s)`);
  }

  const saved = await metaGet('ui', null);
  if (saved) { S.tiles = !!saved.tiles; S.labels = saved.labels !== false; }
  S.excluded = new Set(await metaGet('excludedCodes', REST_CODES_DEFAULT));
}
const saveUi = () => metaSet('ui', { tiles: S.tiles, labels: S.labels });

/* ── 8. filtering & aggregation ─────────────────────────────────────────── */

function inRange(date, from, to) {
  return (!from || date >= from) && (!to || date <= to);
}
function filtered() {
  const { from, to, crew, passive } = S.filter;
  return S.flights.filter(f =>
    inRange(f.date, from, to) &&
    (passive || !f.passive) &&
    (!crew.length || crew.every(k => f.crew.includes(k))));
}
const filteredDuties = () => S.duties.filter(d => inRange(d.date, S.filter.from, S.filter.to));

/** Aggregate legs into undirected routes. */
function aggregateRoutes(list) {
  const map = new Map();
  for (const f of list) {
    /* Air-turnbacks (EIN→EIN) are real legs but not a drawable route. */
    if (!f.route || f.from === f.to || !apPos(f.from) || !apPos(f.to)) continue;
    let r = map.get(f.route);
    if (!r) {
      const [a, b] = f.route.split('-');
      r = { key: f.route, a, b, count: 0, first: f.date, last: f.date, km: haversine(apPos(a), apPos(b)),
            crew: new Set(), dirs: new Map(), flights: [] };
      map.set(f.route, r);
    }
    r.count++;
    if (f.date < r.first) r.first = f.date;
    if (f.date > r.last)  r.last = f.date;
    r.dirs.set(`${f.from}→${f.to}`, (r.dirs.get(`${f.from}→${f.to}`) || 0) + 1);
    f.crew.forEach(k => r.crew.add(k));
    r.flights.push(f);
  }
  return [...map.values()];
}

function aggregateAirports(list) {
  const map = new Map();
  const bump = (code, isDest, f) => {
    if (!code || !apPos(code)) return;
    let a = map.get(code);
    if (!a) { a = { code, visits: 0, dep: 0, arr: 0, first: f.date, last: f.date, partners: new Set() }; map.set(code, a); }
    a.visits++; isDest ? a.arr++ : a.dep++;
    if (f.date < a.first) a.first = f.date;
    if (f.date > a.last)  a.last = f.date;
    a.partners.add(isDest ? f.from : f.to);
  };
  for (const f of list) { bump(f.from, false, f); bump(f.to, true, f); }
  return [...map.values()];
}

function summarise(list) {
  const routes = aggregateRoutes(list);
  const aps = new Set(), countries = new Set();
  let km = 0;
  for (const f of list) {
    if (f.from) { aps.add(f.from); const c = apCountry(f.from); if (c) countries.add(c); }
    if (f.to)   { aps.add(f.to);   const c = apCountry(f.to);   if (c) countries.add(c); }
    km += f.km || 0;
  }
  return { legs: list.length, routes: routes.length, airports: aps.size, countries: countries.size, km };
}

const statTiles = pairs => pairs.map(([v, l]) =>
  `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`).join('');

/* ── 8b. duty days & block hours ────────────────────────────────────────── */
/* A duty day is every leg and ground duty carrying the same roster date — a
   report at 22:00 landing at 02:00 stays one duty. Report/off-duty come from
   the check-in of the first item and the check-out of the last; block time is
   the sum of the legs' off-blocks → on-blocks. */

function itemBounds(x) {
  const isLeg = !!x.flightNo;
  const startT = x.ci || (isLeg ? x.dep : x.start);
  const endT   = x.co || (isLeg ? x.arr : x.end);
  const start = rosterInstant(x.date, startT);
  let end = rosterInstant(isLeg ? (x.arrDate || x.date) : x.date, endT);
  if (start != null && end != null && end < start) end += 86400000;   // over midnight
  if (start != null && end != null && end - start > MAXDUR) end = null;
  return { start, end };
}

/* Which roster entries are actually work.
   Codes are not interpreted by meaning — that would be guessing at an airline's
   internal vocabulary. Instead: a ground entry counts only if it occupies a real
   span of time. Day-off / leave markers (V06, V14, V22, WV1 …) are always
   printed with an identical start and end, so they fall out on their own. Hotel
   is rest, not duty, and is the one code named explicitly. */
function isWorkItem(x) {
  if (x.flightNo) return true;
  if (S.excluded.has(x.code)) return false;
  const b = itemBounds(x);
  return b.start != null && b.end != null && b.end > b.start;
}

/** @returns [{date, blockMin, dutyMin, sectors, start, end, legs, items}] newest first */
function dutyDays(legs, duties) {
  const byDate = new Map();
  const add = x => {
    if (!isWorkItem(x)) return;
    if (!byDate.has(x.date)) byDate.set(x.date, []);
    byDate.get(x.date).push(x);
  };
  legs.forEach(add);
  (duties || []).forEach(add);

  const out = [];
  for (const [date, items] of byDate) {
    let blockMin = 0, sectors = 0, blockKnown = false;
    let start = null, end = null;
    for (const x of items) {
      if (x.flightNo) {
        sectors++;
        const b = legBlock(x);
        if (b != null) { blockMin += b; blockKnown = true; }
      }
      const bd = itemBounds(x);
      if (bd.start != null && (start == null || bd.start < start)) start = bd.start;
      if (bd.end   != null && (end   == null || bd.end   > end))   end   = bd.end;
    }
    const dutyMin = (start != null && end != null && end >= start && end - start <= MAXDUR)
      ? Math.round((end - start) / 60000) : null;
    /* Legs and ground duties arrive in separate passes — put the day back in
       chronological order so drilling into it reads like the roster page. */
    items.sort((a, b) => (itemBounds(a).start ?? 0) - (itemBounds(b).start ?? 0));
    out.push({
      date, sectors, start, end, dutyMin,
      blockMin: blockKnown ? blockMin : null,
      legs: items.filter(x => x.flightNo), items,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

/** ISO-8601 week — Monday start, week 1 holds the first Thursday. */
function isoWeek(dateStr) {
  const d = parseIso(dateStr);
  const t = new Date(d.getTime());
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return { key: `${y}-W${String(week).padStart(2, '0')}`, year: y, week };
}
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Roll duty days up into weeks / months / years, newest first. */
function groupPeriods(days, mode) {
  const map = new Map();
  for (const d of days) {
    let key, label;
    if (mode === 'year')       { key = d.date.slice(0, 4); label = key; }
    else if (mode === 'month') { key = d.date.slice(0, 7); label = MONTH_FMT.format(parseIso(d.date)); }
    else                       { const w = isoWeek(d.date); key = w.key; label = `Week ${w.week}, ${w.year}`; }
    let p = map.get(key);
    if (!p) { p = { key, label, days: [], blockMin: 0, dutyMin: 0, sectors: 0, dutyDays: 0, flyDays: 0 }; map.set(key, p); }
    p.days.push(d);
    p.dutyDays++;
    if (d.sectors) p.flyDays++;
    p.sectors += d.sectors;
    if (d.blockMin != null) p.blockMin += d.blockMin;
    if (d.dutyMin  != null) p.dutyMin  += d.dutyMin;
  }
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/* Leaflet's canvas renderer needs literal colours — resolve the tokens once. */
const cssv = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
/* Transavia green ramp, light → dark: route frequency (magnitude, one hue). */
const SEQ = ['--seq-1','--seq-2','--seq-3','--seq-4','--seq-5','--seq-6']
  .map((v, i) => cssv(v, ['#8fd9b8','#5cc79b','#2eb47f','#00ab61','#047c42','#02391e'][i]));
const C = {
  sel:       cssv('--select', '#140d8a'),        /* navy — selection */
  ap:        cssv('--navy',   '#140d8a'),        /* airport dots, like the site's route pins */
  apRing:    '#ffffff',
  land:      cssv('--map-land', '#f8f0e9'),      /* champagne */
  landLine:  cssv('--map-land-line', '#e2dad4'),
};
/** log2 buckets — magnitude on one hue, low → high on a dark surface */
const seqBin = c => c <= 1 ? 0 : c <= 2 ? 1 : c <= 4 ? 2 : c <= 8 ? 3 : c <= 16 ? 4 : 5;

/* ── 9. map ─────────────────────────────────────────────────────────────── */

let map = null, layers = {};

function initMap() {
  map = L.map('map', {
    zoomControl: false, attributionControl: true,
    worldCopyJump: true, minZoom: 2, maxZoom: 11,
    preferCanvas: true, tap: true,
  }).setView([46, 6], 4);

  layers.base   = L.layerGroup().addTo(map);          // bundled vector world
  layers.tiles  = null;
  layers.routes = L.layerGroup().addTo(map);
  layers.hits   = L.layerGroup().addTo(map);
  layers.aps    = L.layerGroup().addTo(map);
  layers.labels = L.layerGroup().addTo(map);

  if (WORLD) {
    L.geoJSON(WORLD, {
      style: { color: C.landLine, weight: 0.6, fillColor: C.land, fillOpacity: 1, interactive: false },
    }).addTo(layers.base);
  }
  map.attributionControl.setPrefix('');
  map.attributionControl.addAttribution('Coastlines: Natural Earth · Airports: OurAirports');
  map.on('click', () => selectRoute(null));
  map.on('zoomend', drawLabels);
  applyTiles();
}

function applyTiles() {
  /* Tiles live in Leaflet's tilePane, always beneath the overlay pane the
     bundled world sits in — so the vector base has to step aside for them. */
  if (layers.base) {
    if (S.tiles) map.removeLayer(layers.base);
    else if (!map.hasLayer(layers.base)) layers.base.addTo(map);
  }
  if (S.tiles && !layers.tiles) {
    layers.tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 11, attribution: '© OpenStreetMap · © CARTO',
    });
    layers.tiles.addTo(map);
    layers.tiles.bringToBack();
  } else if (!S.tiles && layers.tiles) {
    map.removeLayer(layers.tiles); layers.tiles = null;
  }
  $('#btnTiles').classList.toggle('is-on', S.tiles);
  $('#btnLabels').classList.toggle('is-on', S.labels);
}

let routeCache = [], apCache = [];

function drawMap(fit = false) {
  if (!map) return;
  const list = filtered();
  routeCache = aggregateRoutes(list).sort((a, b) => a.count - b.count);
  apCache = aggregateAirports(list);

  layers.routes.clearLayers(); layers.hits.clearLayers(); layers.aps.clearLayers();

  const maxCount = routeCache.reduce((m, r) => Math.max(m, r.count), 1);
  const maxVisit = apCache.reduce((m, a) => Math.max(m, a.visits), 1);

  for (const r of routeCache) {
    const sel = S.selectedRoute === r.key;
    const bin = seqBin(r.count);
    const style = {
      color: sel ? C.sel : SEQ[bin],
      weight: sel ? 3.4 : 1.2 + (bin / 5) * 2.2,
      opacity: sel ? 1 : 0.5 + (bin / 5) * 0.45,
      lineCap: 'round', interactive: false,
    };
    for (const seg of gcSegments(apPos(r.a), apPos(r.b))) {
      L.polyline(seg, style).addTo(layers.routes);
      L.polyline(seg, { color: '#fff', weight: 22, opacity: 0, interactive: true })
        .on('click', ev => { L.DomEvent.stop(ev); selectRoute(r.key); })
        .addTo(layers.hits);
    }
  }

  for (const a of apCache) {
    const sel = S.selectedRoute && S.selectedRoute.split('-').includes(a.code);
    L.circleMarker(apPos(a.code), {
      radius: 2.6 + Math.sqrt(a.visits / maxVisit) * 6,
      /* Selected endpoints invert (white fill, thick navy ring) rather than
         changing hue — readable with any colour-vision deficiency. */
      color: sel ? C.sel : C.apRing,
      weight: sel ? 3 : 1.5, opacity: 1,
      fillColor: sel ? '#ffffff' : C.ap,
      fillOpacity: 1,
    }).on('click', ev => { L.DomEvent.stop(ev); showAirportSheet(a.code); }).addTo(layers.aps);
  }

  drawLabels();

  const sum = summarise(list);
  $('#mapStats').innerHTML = statTiles([
    [fmtInt(sum.legs), 'legs'], [fmtInt(sum.routes), 'routes'],
    [fmtInt(sum.airports), 'airports'], [fmtInt(sum.countries), 'countries'],
    [fmtInt(Math.round(sum.km / 1000)) + 'k', 'km flown'],
  ]);
  $('#mapEmpty').hidden = list.length > 0;
  $('#mapLegend').hidden = routeCache.length === 0;
  $('#legendMin').textContent = '1';
  $('#legendMax').textContent = fmtInt(maxCount);

  if (fit && apCache.length) {
    const b = L.latLngBounds(apCache.map(a => apPos(a.code)));
    map.fitBounds(b, { padding: [40, 70], maxZoom: 7, animate: false });
  }
}

function drawLabels() {
  if (!map) return;
  layers.labels.clearLayers();
  if (!S.labels) return;
  const z = map.getZoom();
  const maxVisit = apCache.reduce((m, a) => Math.max(m, a.visits), 1);
  for (const a of apCache) {
    const hub = a.visits > maxVisit * 0.12;
    if (!hub && z < 5) continue;
    if (!hub && a.visits < 3 && z < 6) continue;
    L.marker(apPos(a.code), {
      interactive: false,
      icon: L.divIcon({ className: '', html: `<div class="ap-label${hub ? ' is-hub' : ''}">${a.code}</div>`, iconSize: [0, 0], iconAnchor: [-6, 6] }),
    }).addTo(layers.labels);
  }
}

function selectRoute(key, frame = false) {
  S.selectedRoute = key;
  drawMap(false);
  if (!key) return hideSheet();
  showRouteSheet(key);
  if (frame) {
    const [a, b] = key.split('-');
    if (apPos(a) && apPos(b)) {
      /* Frame the route inside the strip of map the sheet does not cover:
         pick the zoom for that strip's height, then slide the view so the
         strip's centre — not the viewport's — lands on the route. */
      const box = map.getContainer().getBoundingClientRect();
      const sheetTop = $('#detailSheet').getBoundingClientRect().top;
      const strip = Math.max(140, sheetTop - box.top);
      const b2 = L.latLngBounds([apPos(a), apPos(b)]);
      const pad = L.point(80, (box.height - strip) + 80);
      const z = Math.min(6, map.getBoundsZoom(b2, false, pad));
      map.setView(b2.getCenter(), z, { animate: false });
      map.panBy([0, Math.round((box.height - strip) / 2)], { animate: false });
    }
  }
}

/* ── 10. shared row renderers ───────────────────────────────────────────── */

function flightRowHTML(f, opts = {}) {
  const times = [f.dep, f.arr].filter(Boolean).join('–') || (f.ci ? 'C/I ' + f.ci : '');
  const tags = [];
  if (f.passive) tags.push('<span class="tag pax">pax</span>');
  if (opts.showDate) tags.push(`<span class="tag">${esc(fmtShort(f.date))}</span>`);
  const crewN = (f.crew || []).length;

  /* Spell the airports out, as the Routes tab does — a bare IATA pair is not
     much use for anywhere you only visited once. Suppressed when neither end
     resolves, so it can't just echo the codes back. */
  const named = c => { const n = apName(c); return n && n !== c ? n : null; };
  const cities = (named(f.from) || named(f.to))
    ? `${esc(apName(f.from))} <span class="arrow">→</span> ${esc(f.to ? apName(f.to) : '??')}`
    : '';

  const block = legBlock(f);
  const metric = opts.showBlock
    ? `${fmtHM(block)}<small>block</small>`
    : `${f.km ? fmtInt(f.km) : '—'}<small>km</small>`;

  return `<button class="row-item" data-flight="${esc(f.id)}">
    <div class="row-main">
      <div class="row-title"><span class="iata">${esc(f.from)}</span><span class="arrow">→</span>
        <span class="iata">${esc(f.to || '??')}</span>${tags.join('')}</div>
      ${cities ? `<div class="row-sub cities">${cities}</div>` : ''}
      <div class="row-sub">${esc(f.flightNo)} · <span class="times">${esc(times)}</span>${f.ac ? ' · ' + esc(f.ac) : ''}${crewN ? ` · ${crewN} crew` : ''}</div>
    </div>
    <div class="row-num">${metric}</div>
  </button>`;
}

function dutyRowHTML(d) {
  const t = [d.start, d.end].filter(Boolean).join('–');
  const named = c => { const n = apName(c); return n && n !== c ? n : null; };
  const where = [d.from, d.to].filter(Boolean);
  const cities = where.some(named) ? where.map(c => apName(c)).join(' → ') : '';
  return `<div class="row-item">
    <div class="row-main">
      <div class="row-title">${esc(d.code)} <span class="tag duty">duty</span></div>
      ${cities ? `<div class="row-sub cities">${esc(cities)}</div>` : ''}
      <div class="row-sub">${esc(where.join(' → ') || '—')}${t ? ' · ' : ''}<span class="times">${esc(t)}</span></div>
    </div></div>`;
}

/** Group flight/duty records into day sections, newest first. */
function groupByDay(items, limit) {
  const byDate = new Map();
  for (const it of items) { if (!byDate.has(it.date)) byDate.set(it.date, []); byDate.get(it.date).push(it); }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));
  let used = 0; const out = [];
  for (const d of dates) {
    if (limit && used >= limit) break;
    out.push([d, byDate.get(d)]); used += byDate.get(d).length;
  }
  return { groups: out, shown: used, total: items.length };
}

function renderDayGroups(node, items, limit, opts = {}) {
  const { groups, shown, total } = groupByDay(items, limit);
  if (!groups.length) { node.innerHTML = `<div class="nothing">${esc(opts.empty || 'Nothing here for the current filter.')}</div>`; return { shown, total }; }
  node.innerHTML = groups.map(([date, list]) => {
    const note = list.find(x => x.note);
    return `<div class="daygroup">
      <div class="dayhead">${esc(fmtDay(date))}${note ? `<small>${esc(note.note)}</small>` : ''}</div>
      <div class="list">${list.map(x => x.flightNo ? flightRowHTML(x) : dutyRowHTML(x)).join('')}</div>
    </div>`;
  }).join('');
  return { shown, total };
}

/* ── 11. detail sheets ──────────────────────────────────────────────────── */

function openSheet(html) {
  const s = $('#detailSheet');
  $('#sheetBody').innerHTML = html;
  s.hidden = false;
}
const hideSheet = () => { $('#detailSheet').hidden = true; };

function showRouteSheet(key) {
  const r = routeCache.find(x => x.key === key) || aggregateRoutes(filtered()).find(x => x.key === key);
  if (!r) return hideSheet();
  const dirs = [...r.dirs.entries()].sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `<div class="kv"><span>${esc(d.replace('→', ' → '))}</span><b>${fmtInt(n)}</b></div>`).join('');
  const crew = [...r.crew].filter(k => !isOwner(k));
  const recent = r.flights.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

  openSheet(`
    <div class="sheet-title"><span class="iata">${esc(r.a)}</span><span class="arrow">⇄</span><span class="iata">${esc(r.b)}</span></div>
    <p class="sheet-sub">${esc(apFull(r.a))} — ${esc(apFull(r.b))}</p>
    <div class="sheet-stats">${statTiles([
      [fmtInt(r.count), 'times flown'], [fmtInt(r.km), 'km each way'],
      [fmtInt(Math.round(r.count * r.km / 1000)) + 'k', 'km total'],
      [fmtInt(crew.length), 'crew met'],
    ])}</div>
    ${dirs}
    <div class="kv"><span>First</span><b>${esc(fmtShort(r.first))}</b></div>
    <div class="kv"><span>Most recent</span><b>${esc(fmtShort(r.last))}</b></div>
    <h2 class="section-h">Latest legs</h2>
    <div class="list">${recent.map(f => flightRowHTML(f, { showDate: true })).join('')}</div>`);
}

function showAirportSheet(code) {
  const list = filtered();
  const a = aggregateAirports(list).find(x => x.code === code);
  if (!a) return;
  const routes = aggregateRoutes(list).filter(r => r.a === code || r.b === code)
    .sort((x, y) => y.count - x.count);
  const max = routes.reduce((m, r) => Math.max(m, r.count), 1);
  openSheet(`
    <div class="sheet-title"><span class="iata">${esc(code)}</span> ${esc(apName(code))}${apClosed(code) ? ' <span class="tag closed">closed</span>' : ''}</div>
    <p class="sheet-sub">${esc(apFull(code))}${apClosed(code) ? ' — this airport has since closed; the code is kept so rosters flown while it was open still map.' : ''}</p>
    <div class="sheet-stats">${statTiles([
      [fmtInt(a.visits), 'movements'], [fmtInt(a.dep), 'departures'],
      [fmtInt(a.arr), 'arrivals'], [fmtInt(routes.length), 'routes'],
    ])}</div>
    <div class="kv"><span>First</span><b>${esc(fmtShort(a.first))}</b></div>
    <div class="kv"><span>Most recent</span><b>${esc(fmtShort(a.last))}</b></div>
    <h2 class="section-h">Routes from here</h2>
    <div class="list">${routes.map(r => {
      const other = r.a === code ? r.b : r.a;
      return `<button class="row-item" data-route="${esc(r.key)}">
        <div class="row-main"><div class="row-title"><span class="iata">${esc(other)}</span> ${esc(apName(other))}</div>
        <div class="freqbar"><i style="width:${(r.count / max * 100).toFixed(1)}%"></i></div></div>
        <div class="row-num">${fmtInt(r.count)}<small>legs</small></div></button>`;
    }).join('')}</div>`);
}

/** Who someone flies with, and how often. */
function companionsOf(key, list) {
  const c = new Map();
  for (const f of list) {
    if (!f.crew.includes(key)) continue;
    for (const k of f.crew) if (k !== key) c.set(k, (c.get(k) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1]);
}

function showPersonSheet(key) {
  const list = S.flights.filter(f => inRange(f.date, S.filter.from, S.filter.to) && f.crew.includes(key));
  const sum = summarise(list);
  const mates = companionsOf(key, list).slice(0, 12);
  const max = mates.length ? mates[0][1] : 1;
  const days = new Set(list.map(f => f.date)).size;
  openSheet(`
    <div class="sheet-title">${esc(personName(key))}${isOwner(key) ? ' <span class="tag you">roster owner</span>' : ''}</div>
    <p class="sheet-sub">${list.length ? `${esc(fmtShort(list[0].date))} — ${esc(fmtShort(list[list.length - 1].date))}` : 'No flights in range'}</p>
    <div class="sheet-stats">${statTiles([
      [fmtInt(sum.legs), 'legs'], [fmtInt(days), 'days'],
      [fmtInt(sum.routes), 'routes'], [fmtInt(sum.airports), 'airports'],
      [fmtInt(Math.round(sum.km / 1000)) + 'k', 'km'],
    ])}</div>
    <div class="row-btns">
      <button class="btn-primary" data-act="filter-person" data-key="${esc(key)}">Filter app to this person</button>
      <button class="btn-ghost" data-act="overlap-person" data-key="${esc(key)}">Add to overlap</button>
      <button class="btn-ghost" data-act="rename-person" data-key="${esc(key)}">Rename / merge</button>
    </div>
    <h2 class="section-h">Flew most with</h2>
    <div class="list">${mates.length ? mates.map(([k, n]) => `
      <button class="row-item" data-person="${esc(k)}">
        <div class="row-main"><div class="row-title">${esc(personName(k))}</div>
        <div class="freqbar"><i style="width:${(n / max * 100).toFixed(1)}%"></i></div></div>
        <div class="row-num">${fmtInt(n)}<small>legs</small></div></button>`).join('')
      : '<div class="nothing">No crew data on these flights.</div>'}</div>`);
}

function showFlightSheet(id) {
  const f = S.flights.find(x => x.id === id);
  if (!f) return;
  const crew = (f.crew || []).slice().sort((a, b) => (isOwner(b) ? 1 : 0) - (isOwner(a) ? 1 : 0));
  const locDep = localAt(rosterInstant(f.date, f.dep), f.from);
  const locArr = localAt(rosterInstant(f.arrDate || f.date, f.arr), f.to);
  openSheet(`
    <div class="sheet-title"><span class="iata">${esc(f.from)}</span><span class="arrow">→</span><span class="iata">${esc(f.to || '??')}</span></div>
    <p class="sheet-sub">${esc(f.flightNo)} · ${esc(fmtDay(f.date))}${f.ac ? ' · ' + esc(f.ac) : ''}</p>
    ${f.note ? `<div class="kv"><span>Roster note</span><b>${esc(f.note)}</b></div>` : ''}
    <div class="kv"><span>Check-in</span><b>${esc(f.ci || '—')}</b></div>
    <div class="kv"><span>Off blocks</span><b>${esc(f.dep || '—')}${locDep ? ` <small>(${esc(locDep)} local ${esc(f.from)})</small>` : ''}</b></div>
    <div class="kv"><span>On blocks</span><b>${esc(f.arr || '—')}${f.arrDate !== f.date ? ' <small>+1</small>' : ''}${locArr ? ` <small>(${esc(locArr)} local ${esc(f.to)})</small>` : ''}</b></div>
    <div class="kv"><span>Check-out</span><b>${esc(f.co || '—')}</b></div>
    <div class="kv"><span>Block time</span><b>${fmtHM(legBlock(f))}</b></div>
    <div class="kv"><span>Distance</span><b>${f.km ? fmtInt(f.km) + ' km' : '—'}</b></div>
    ${f.tags && f.tags.length ? `<div class="kv"><span>Codes</span><b>${esc(f.tags.join(' '))}</b></div>` : ''}
    <div class="kv"><span>From file</span><b>${esc((f.sources || []).join(', ') || '—')}</b></div>
    <h2 class="section-h">Crew on board (${crew.length})</h2>
    <div class="list">${crew.length ? crew.map(k => `
      <button class="row-item" data-person="${esc(k)}">
        <div class="row-main"><div class="row-title">${esc(personName(k))}${isOwner(k) ? ' <span class="tag you">roster owner</span>' : ''}</div></div>
      </button>`).join('') : '<div class="nothing">This roster lists no crew for the leg.</div>'}</div>
    <p class="hint" style="margin-top:14px">Roster times are UTC (Zulu), exactly as printed; local station times are derived.</p>`);
}

/* ── 12. views ──────────────────────────────────────────────────────────── */

function renderRoutes() {
  const list = filtered();
  const q = $('#routeSearch').value.trim().toUpperCase();
  let routes = aggregateRoutes(list);
  if (q) routes = routes.filter(r => r.key.includes(q) || apName(r.a).toUpperCase().includes(q) || apName(r.b).toUpperCase().includes(q));
  const sorters = {
    count:  (a, b) => b.count - a.count || a.key.localeCompare(b.key),
    recent: (a, b) => b.last.localeCompare(a.last),
    dist:   (a, b) => b.km - a.km,
  };
  routes.sort(sorters[S.routeSort]);
  const max = routes.reduce((m, r) => Math.max(m, r.count), 1);

  const sum = summarise(list);
  $('#routeStats').innerHTML = statTiles([
    [fmtInt(sum.routes), 'routes'], [fmtInt(sum.legs), 'legs'],
    [fmtInt(sum.airports), 'airports'], [fmtInt(Math.round(sum.km / 1000)) + 'k', 'km'],
  ]);

  $('#routeList').innerHTML = routes.length ? routes.map(r => `
    <button class="row-item${S.selectedRoute === r.key ? ' is-on' : ''}" data-route="${esc(r.key)}">
      <div class="row-main">
        <div class="row-title"><span class="iata">${esc(r.a)}</span><span class="arrow">⇄</span><span class="iata">${esc(r.b)}</span></div>
        <div class="row-sub">${esc(apName(r.a))} — ${esc(apName(r.b))} · ${fmtInt(r.km)} km · last ${esc(fmtShort(r.last))}</div>
        <div class="freqbar"><i style="width:${(r.count / max * 100).toFixed(1)}%"></i></div>
      </div>
      <div class="row-num">${fmtInt(r.count)}<small>legs</small></div>
    </button>`).join('') : '<div class="nothing">No routes match.</div>';

  let aps = aggregateAirports(list).sort((a, b) => b.visits - a.visits);
  if (q) aps = aps.filter(a => a.code.includes(q) || apName(a.code).toUpperCase().includes(q));
  const amax = aps.reduce((m, a) => Math.max(m, a.visits), 1);
  $('#airportList').innerHTML = aps.length ? aps.map(a => `
    <button class="row-item" data-airport="${esc(a.code)}">
      <div class="row-main">
        <div class="row-title"><span class="iata">${esc(a.code)}</span> ${esc(apName(a.code))}${apClosed(a.code) ? ' <span class="tag closed">closed</span>' : ''}</div>
        <div class="row-sub">${esc(apCountry(a.code) || '')} · ${fmtInt(a.partners.size)} route${a.partners.size === 1 ? '' : 's'}</div>
        <div class="freqbar"><i style="width:${(a.visits / amax * 100).toFixed(1)}%"></i></div>
      </div>
      <div class="row-num">${fmtInt(a.visits)}<small>visits</small></div>
    </button>`).join('') : '<div class="nothing">No airports match.</div>';
}

function renderFlights() {
  const q = $('#flightSearch').value.trim().toLowerCase();
  let list = filtered();
  if ($('#showDuties').checked) list = list.concat(filteredDuties());
  if (q) {
    list = list.filter(x => {
      const hay = [x.flightNo, x.code, x.from, x.to, x.date, x.ac].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) return true;
      return (x.crew || []).some(k => personName(k).toLowerCase().includes(q));
    });
  }
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.dep || '').localeCompare(a.dep || ''));

  const flightsOnly = list.filter(x => x.flightNo);
  const sum = summarise(flightsOnly);
  const days = new Set(flightsOnly.map(x => x.date)).size;   // flying days, not duty days
  $('#flightStats').innerHTML = statTiles([
    [fmtInt(sum.legs), 'legs'], [fmtInt(days), 'days'],
    [fmtInt(sum.routes), 'routes'], [fmtInt(Math.round(sum.km / 1000)) + 'k', 'km'],
  ]);
  const { shown, total } = renderDayGroups($('#flightList'), list, S.flightLimit,
    { empty: 'No flights match the current filter.' });
  const more = $('#flightMore');
  more.hidden = shown >= total;
  more.textContent = `Show more (${fmtInt(total - shown)} left)`;
}

function renderHours() {
  const legs = filtered();
  const days = dutyDays(legs, filteredDuties());
  const periods = groupPeriods(days, S.hoursMode);

  const tot = periods.reduce((a, p) => ({
    block: a.block + p.blockMin, duty: a.duty + p.dutyMin,
    days: a.days + p.dutyDays, fly: a.fly + p.flyDays, sectors: a.sectors + p.sectors,
  }), { block: 0, duty: 0, days: 0, fly: 0, sectors: 0 });

  const unknownBlock = legs.filter(f => legBlock(f) == null).length;
  const avgDuty = tot.days ? Math.round(tot.duty / tot.days) : null;

  $('#hoursStats').innerHTML = statTiles([
    [fmtHours(tot.block), 'block time'],
    [fmtHours(tot.duty), 'duty time'],
    [fmtInt(tot.days), 'duty days'],
    [fmtInt(tot.fly), 'flying days'],
    [fmtInt(tot.sectors), 'sectors'],
    [fmtHM(avgDuty), 'avg duty day'],
  ]);

  const max = periods.reduce((m, p) => Math.max(m, p.blockMin), 1);
  $('#hoursList').innerHTML = periods.length ? periods.map(p => `
    <button class="row-item" data-period="${esc(p.key)}">
      <div class="row-main">
        <div class="row-title">${esc(p.label)}</div>
        <div class="row-sub">${fmtInt(p.dutyDays)} duty day${p.dutyDays === 1 ? '' : 's'} (${fmtInt(p.flyDays)} flying) · ${fmtInt(p.sectors)} sector${p.sectors === 1 ? '' : 's'} · duty ${fmtHM(p.dutyMin)}</div>
        <div class="freqbar"><i style="width:${clamp(p.blockMin / max * 100, 0, 100).toFixed(1)}%"></i></div>
      </div>
      <div class="row-num">${fmtHM(p.blockMin)}<small>block</small></div>
    </button>`).join('') : '<div class="nothing">No duty days match the current filter.</div>';

  /* Ground codes are classified by whether they occupy real time, not by what
     they mean — the app has no way to know an airline's vocabulary. Anything
     with a time span is counted, and you can switch a code off if it is really
     leave or rest. */
  const seen = new Map();      // code -> minutes it currently contributes
  for (const d of filteredDuties()) {
    const b = itemBounds(d);
    const mins = (b.start != null && b.end != null && b.end > b.start) ? Math.round((b.end - b.start) / 60000) : 0;
    const e = seen.get(d.code) || { n: 0, mins: 0 };
    e.n++; e.mins += mins;
    seen.set(d.code, e);
  }
  const chips = [...seen.entries()]
    .filter(([, e]) => e.mins > 0)                       // zero-span markers can never count
    .sort((a, b) => b[1].mins - a[1].mins)
    .map(([code, e]) => {
      const on = !S.excluded.has(code);
      return `<button class="codechip${on ? '' : ' is-off'}" data-code="${esc(code)}"
        title="${on ? 'Counted' : 'Not counted'} — ${fmtHM(e.mins)} over ${e.n}">${esc(code)}</button>`;
    }).join('');
  const zeroSpan = [...seen.entries()].filter(([, e]) => e.mins === 0).map(([c]) => c).sort();

  $('#hoursNote').innerHTML =
    'Roster times are UTC (Zulu), so block time is simply off blocks → on blocks, with legs landing after midnight carried into the next day. ' +
    'A duty day runs from the first check-in to the last check-out of that roster date. ' +
    'Ground duties add to duty time but not block time.' +
    '<br><br><b>Which ground codes count as duty?</b> Tap to switch one off if it is really leave or rest — the totals above update immediately.' +
    `<div class="codechips">${chips}</div>` +
    (zeroSpan.length ? `<br>Always ignored, because they have no time span at all (day-off / leave markers): ${esc(zeroSpan.join(' '))}.` : '') +
    (unknownBlock ? `<br><br>${fmtInt(unknownBlock)} leg${unknownBlock === 1 ? '' : 's'} could not be timed and ${unknownBlock === 1 ? 'is' : 'are'} left out of block totals.` : '');
}

function showPeriodSheet(key) {
  const days = groupPeriods(dutyDays(filtered(), filteredDuties()), S.hoursMode)
    .find(p => p.key === key);
  if (!days) return;
  const timeAt = ts => (ts == null ? '—'
    : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(ts));
  openSheet(`
    <div class="sheet-title">${esc(days.label)}</div>
    <p class="sheet-sub">${fmtInt(days.dutyDays)} duty days · ${fmtInt(days.sectors)} sectors</p>
    <div class="sheet-stats">${statTiles([
      [fmtHM(days.blockMin), 'block'], [fmtHM(days.dutyMin), 'duty'],
      [fmtHM(days.dutyDays ? Math.round(days.blockMin / days.dutyDays) : null), 'block / day'],
      [fmtHM(days.dutyDays ? Math.round(days.dutyMin / days.dutyDays) : null), 'duty / day'],
    ])}</div>
    <h2 class="section-h">Days</h2>
    ${days.days.map(d => `
      <div class="daygroup">
        <div class="dayhead">
          <span>${esc(fmtDay(d.date))}</span>
          <small><span class="times">${esc(timeAt(d.start))}–${esc(timeAt(d.end))}</span> UTC · duty ${fmtHM(d.dutyMin)} · block ${fmtHM(d.blockMin)}</small>
        </div>
        <div class="list">${
          d.items.length
            ? d.items.map(x => x.flightNo ? flightRowHTML(x, { showBlock: true }) : dutyRowHTML(x)).join('')
            : '<div class="nothing">Nothing recorded for this day.</div>'
        }</div>
      </div>`).join('')}`);
}

function crewCounts() {
  const list = S.flights.filter(f => inRange(f.date, S.filter.from, S.filter.to));
  const c = new Map();
  for (const f of list) for (const k of f.crew) c.set(k, (c.get(k) || 0) + 1);
  return c;
}

function renderCrew() {
  const q = $('#crewSearch').value.trim().toLowerCase();
  const counts = crewCounts();
  let people = [...S.people.values()].map(p => ({ ...p, n: counts.get(p.key) || 0 }));
  if (q) people = people.filter(p => p.name.toLowerCase().includes(q));
  people.sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || b.n - a.n || a.name.localeCompare(b.name));
  /* Roster owners are on every leg, so scale the bars to the busiest colleague
     instead — otherwise every other bar collapses to a sliver. */
  const max = people.reduce((m, p) => (p.isOwner ? m : Math.max(m, p.n)), 1);

  $('#crewList').innerHTML = people.length ? people.map(p => `
    <button class="row-item${S.filter.crew.includes(p.key) ? ' is-on' : ''}" data-person="${esc(p.key)}">
      <div class="row-main">
        <div class="row-title">${esc(p.name)}${p.isOwner ? ' <span class="tag you">you</span>' : ''}</div>
        <div class="freqbar"><i style="width:${clamp(p.n / max * 100, 0, 100).toFixed(1)}%"></i></div>
      </div>
      <div class="row-num">${fmtInt(p.n)}<small>legs</small></div>
    </button>`).join('') : '<div class="nothing">No crew names yet. Import a roster PDF that includes the “Crew onboard” section.</div>';
}

function renderOverlap() {
  const sel = S.overlap.crew;
  $('#overlapChips').innerHTML = sel.map(k =>
    `<span class="chip${isOwner(k) ? ' owner' : ''}">${esc(personName(k))}<button data-unpick="${esc(k)}" aria-label="Remove">×</button></span>`).join('');

  const box = $('#overlapResult'), stats = $('#overlapStats');
  if (sel.length < 2) {
    stats.innerHTML = '';
    box.innerHTML = '<div class="nothing">Pick at least two people to see the flights they shared.</div>';
    return;
  }
  const list = S.flights.filter(f =>
    inRange(f.date, S.overlap.from, S.overlap.to) && sel.every(k => f.crew.includes(k)));
  const sum = summarise(list);
  const days = new Set(list.map(f => f.date)).size;
  const years = new Map();
  for (const f of list) years.set(f.date.slice(0, 4), (years.get(f.date.slice(0, 4)) || 0) + 1);

  stats.innerHTML = statTiles([
    [fmtInt(sum.legs), 'legs together'], [fmtInt(days), 'days together'],
    [fmtInt(sum.routes), 'routes'], [fmtInt(Math.round(sum.km / 1000)) + 'k', 'km'],
  ]);

  const yearMax = Math.max(1, ...years.values());
  const yearRows = [...years.entries()].sort().map(([y, n]) => `
    <div class="row-item"><div class="row-main"><div class="row-title">${esc(y)}</div>
      <div class="freqbar"><i style="width:${(n / yearMax * 100).toFixed(1)}%"></i></div></div>
      <div class="row-num">${fmtInt(n)}<small>legs</small></div></div>`).join('');

  if (!list.length) {
    box.innerHTML = `<div class="nothing">${esc(sel.map(personName).join(' and '))} have no shared legs in this period.</div>`;
    return;
  }
  box.innerHTML = `<h2 class="section-h">Per year</h2><div class="list">${yearRows}</div><h2 class="section-h">Shared legs</h2>`;
  const wrap = el('div');
  renderDayGroups(wrap, list.slice().sort((a, b) => b.date.localeCompare(a.date)), 400);
  box.appendChild(wrap);
}

function renderData() {
  $('#sourceList').innerHTML = S.sources.length ? S.sources.map(s => `
    <div class="row-item">
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        <div class="row-sub">${esc(s.owner || 'unknown owner')}${s.period ? ' · ' + esc(s.period) : ''} · ${fmtInt(s.flights)} legs${s.crewRows ? ` · ${fmtInt(s.crewRows)} crew rows` : ''}</div>
      </div>
      <div class="row-num">${fmtInt(Math.round(s.size / 1024))}<small>kB</small></div>
    </div>`).join('') : '<div class="nothing">Nothing imported yet.</div>';

  $('#dbFlights').textContent = fmtInt(S.flights.length);
  $('#dbDuties').textContent  = fmtInt(S.duties.length);
  $('#dbPeople').textContent  = fmtInt(S.people.size);
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(e => {
      $('#dbSize').textContent = e.usage ? (e.usage / 1048576).toFixed(1) + ' MB' : '—';
    });
  }
}

function updateFilterSummary() {
  const f = S.filter, bits = [];
  if (f.crew.length) bits.push(f.crew.map(personName).join(' + '));
  if (f.from || f.to) bits.push(`${f.from ? fmtShort(f.from) : '…'} → ${f.to ? fmtShort(f.to) : '…'}`);
  if (!f.passive) bits.push('operating only');
  const n = (f.crew.length ? 1 : 0) + (f.from || f.to ? 1 : 0) + (f.passive ? 0 : 1);
  const badge = $('#filterBadge');
  badge.hidden = n === 0; badge.textContent = String(n);
  const sum = $('#filterSummary');
  sum.textContent = bits.length ? bits.join(' · ') : 'All data';
  sum.classList.toggle('is-on', bits.length > 0);
}

function refreshAll() {
  updateFilterSummary();
  drawMap(false);
  renderRoutes(); renderFlights(); renderHours(); renderCrew(); renderOverlap(); renderData();
  buildQuickRanges();
}

/* ── 13. filter + picker wiring ─────────────────────────────────────────── */

function dataYears() {
  const y = new Set(S.flights.map(f => f.date.slice(0, 4)));
  return [...y].sort();
}

function buildQuickRanges() {
  const years = dataYears();
  for (const [host, target] of [[$('#quickRange'), 'filter'], [$('#ovQuick'), 'overlap']]) {
    const st = target === 'filter' ? S.filter : S.overlap;
    host.innerHTML = `<button data-yr="all">All time</button>` +
      years.map(y => `<button data-yr="${y}">${y}</button>`).join('');
    const active = (!st.from && !st.to) ? 'all'
      : (st.from && st.to && st.from === `${st.from.slice(0, 4)}-01-01` && st.to === `${st.from.slice(0, 4)}-12-31` ? st.from.slice(0, 4) : null);
    $$('button', host).forEach(b => b.classList.toggle('is-on', b.dataset.yr === active));
  }
}

function setRange(target, from, to) {
  const st = target === 'filter' ? S.filter : S.overlap;
  st.from = from; st.to = to;
  if (target === 'filter') { $('#fFrom').value = from || ''; $('#fTo').value = to || ''; }
  else { $('#ovFrom').value = from || ''; $('#ovTo').value = to || ''; }
  refreshAll();
}

/** Type-ahead over the people list, shared by the filter sheet and overlap tab. */
function wireSuggest(inputSel, boxSel, onPick, excluded) {
  const input = $(inputSel), box = $(boxSel);
  const close = () => { box.hidden = true; box.innerHTML = ''; };
  const open = () => {
    const q = input.value.trim().toLowerCase();
    const counts = crewCounts();
    const ex = excluded();
    let people = [...S.people.values()].filter(p => !ex.includes(p.key));
    if (q) people = people.filter(p => p.name.toLowerCase().includes(q));
    people.sort((a, b) => (b.isOwner ? 1 : 0) - (a.isOwner ? 1 : 0) || (counts.get(b.key) || 0) - (counts.get(a.key) || 0));
    people = people.slice(0, 25);
    if (!people.length) return close();
    box.innerHTML = people.map(p =>
      `<button data-pick="${esc(p.key)}">${esc(p.name)}${p.isOwner ? ' <span class="tag you">you</span>' : ''}<small>${fmtInt(counts.get(p.key) || 0)} legs</small></button>`).join('');
    box.hidden = false;
  };
  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  box.addEventListener('click', ev => {
    const b = ev.target.closest('[data-pick]');
    if (!b) return;
    onPick(b.dataset.pick);
    input.value = ''; close();
  });
  document.addEventListener('click', ev => {
    if (!box.contains(ev.target) && ev.target !== input) close();
  });
}

function addFilterCrew(key) {
  if (!S.filter.crew.includes(key)) S.filter.crew.push(key);
  renderFilterChips(); refreshAll();
}
function renderFilterChips() {
  $('#fCrewChips').innerHTML = S.filter.crew.map(k =>
    `<span class="chip${isOwner(k) ? ' owner' : ''}">${esc(personName(k))}<button data-unfilter="${esc(k)}" aria-label="Remove">×</button></span>`).join('');
}

/* ── 14. events ─────────────────────────────────────────────────────────── */

function switchView(name) {
  S.view = name;
  $$('.view').forEach(v => v.classList.toggle('is-active', v.id === 'view-' + name));
  $$('#tabbar button').forEach(b => b.classList.toggle('is-active', b.dataset.view === name));
  $('#viewTitle').textContent = { map:'Map', routes:'Routes', flights:'Flights', hours:'Hours', crew:'Crew', data:'Data' }[name];
  if (name === 'map' && map) setTimeout(() => map.invalidateSize(), 60);
  if (name !== 'map') hideSheet();
}

function wireEvents() {
  $('#tabbar').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-view]'); if (b) switchView(b.dataset.view);
  });
  document.addEventListener('click', ev => {
    const g = ev.target.closest('[data-goto]'); if (g) switchView(g.dataset.goto);
  });

  /* filter sheet */
  const sheet = $('#filterSheet');
  $('#openFilters').addEventListener('click', () => { renderFilterChips(); sheet.hidden = false; });
  sheet.addEventListener('click', ev => { if (ev.target.closest('[data-close]')) sheet.hidden = true; });
  $('#fFrom').addEventListener('change', e => { S.filter.from = e.target.value || null; refreshAll(); });
  $('#fTo').addEventListener('change',   e => { S.filter.to   = e.target.value || null; refreshAll(); });
  $('#fPassive').addEventListener('change', e => { S.filter.passive = e.target.checked; refreshAll(); });
  $('#quickRange').addEventListener('click', ev => {
    const b = ev.target.closest('[data-yr]'); if (!b) return;
    b.dataset.yr === 'all' ? setRange('filter', null, null)
                           : setRange('filter', `${b.dataset.yr}-01-01`, `${b.dataset.yr}-12-31`);
  });
  $('#fCrewChips').addEventListener('click', ev => {
    const b = ev.target.closest('[data-unfilter]'); if (!b) return;
    S.filter.crew = S.filter.crew.filter(k => k !== b.dataset.unfilter);
    renderFilterChips(); refreshAll();
  });
  $('#btnClearFilters').addEventListener('click', () => {
    S.filter = { from: null, to: null, crew: [], passive: true };
    $('#fFrom').value = ''; $('#fTo').value = ''; $('#fPassive').checked = true;
    renderFilterChips(); refreshAll();
  });
  wireSuggest('#fCrewSearch', '#fCrewSuggest', addFilterCrew, () => S.filter.crew);

  /* map controls */
  $('#btnFit').addEventListener('click', () => drawMap(true));
  $('#btnTiles').addEventListener('click', () => { S.tiles = !S.tiles; applyTiles(); saveUi(); toast(S.tiles ? 'Online tiles on' : 'Offline vector map'); });
  $('#btnLabels').addEventListener('click', () => { S.labels = !S.labels; applyTiles(); drawLabels(); saveUi(); });

  /* routes */
  $('#routeSearch').addEventListener('input', renderRoutes);
  $('#routeSort').addEventListener('click', ev => {
    const b = ev.target.closest('[data-sort]'); if (!b) return;
    S.routeSort = b.dataset.sort;
    $$('#routeSort button').forEach(x => x.classList.toggle('is-on', x === b));
    renderRoutes();
  });

  /* flights */
  $('#flightSearch').addEventListener('input', () => { S.flightLimit = 200; renderFlights(); });
  $('#showDuties').addEventListener('change', renderFlights);
  $('#flightMore').addEventListener('click', () => { S.flightLimit += 400; renderFlights(); });

  /* hours */
  $('#hoursNote').addEventListener('click', async ev => {
    const b = ev.target.closest('[data-code]'); if (!b) return;
    const code = b.dataset.code;
    S.excluded.has(code) ? S.excluded.delete(code) : S.excluded.add(code);
    await metaSet('excludedCodes', [...S.excluded]);
    renderHours();
    toast(S.excluded.has(code) ? `${code} no longer counts as duty` : `${code} counts as duty`);
  });
  $('#hoursMode').addEventListener('click', ev => {
    const b = ev.target.closest('[data-hmode]'); if (!b) return;
    S.hoursMode = b.dataset.hmode;
    $$('#hoursMode button').forEach(x => x.classList.toggle('is-on', x === b));
    renderHours();
  });

  /* crew */
  $('#crewSearch').addEventListener('input', renderCrew);
  $('#crewMode').addEventListener('click', ev => {
    const b = ev.target.closest('[data-mode]'); if (!b) return;
    $$('#crewMode button').forEach(x => x.classList.toggle('is-on', x === b));
    $('#crewPane-people').hidden  = b.dataset.mode !== 'people';
    $('#crewPane-overlap').hidden = b.dataset.mode !== 'overlap';
  });
  wireSuggest('#overlapSearch', '#overlapSuggest', k => {
    if (!S.overlap.crew.includes(k)) S.overlap.crew.push(k);
    renderOverlap();
  }, () => S.overlap.crew);
  $('#overlapChips').addEventListener('click', ev => {
    const b = ev.target.closest('[data-unpick]'); if (!b) return;
    S.overlap.crew = S.overlap.crew.filter(k => k !== b.dataset.unpick);
    renderOverlap();
  });
  $('#ovFrom').addEventListener('change', e => { S.overlap.from = e.target.value || null; renderOverlap(); buildQuickRanges(); });
  $('#ovTo').addEventListener('change',   e => { S.overlap.to   = e.target.value || null; renderOverlap(); buildQuickRanges(); });
  $('#ovQuick').addEventListener('click', ev => {
    const b = ev.target.closest('[data-yr]'); if (!b) return;
    b.dataset.yr === 'all' ? setRange('overlap', null, null)
                           : setRange('overlap', `${b.dataset.yr}-01-01`, `${b.dataset.yr}-12-31`);
  });

  /* data */
  $('#fileInput').addEventListener('change', async ev => {
    const files = [...ev.target.files];
    ev.target.value = '';
    if (files.length) await importFiles(files);
  });
  $('#btnExport').addEventListener('click', exportBackup);
  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('Delete every imported roster from this device? This cannot be undone.')) return;
    await clearAll(); await loadData();
    S.filter = { from: null, to: null, crew: [], passive: true }; S.overlap = { crew: [], from: null, to: null };
    S.selectedRoute = null;
    refreshAll(); toast('All local data deleted');
  });

  /* delegated: rows and sheet actions */
  document.addEventListener('click', async ev => {
    const route = ev.target.closest('[data-route]');
    if (route) {
      const fromList = S.view !== 'map';
      if (fromList) switchView('map');
      selectRoute(route.dataset.route, fromList);
      renderRoutes();
      return;
    }

    const ap = ev.target.closest('[data-airport]');
    if (ap) { showAirportSheet(ap.dataset.airport); switchView('map'); return; }

    const per = ev.target.closest('[data-person]');
    if (per) { showPersonSheet(per.dataset.person); return; }

    const fl = ev.target.closest('[data-flight]');
    if (fl) { showFlightSheet(fl.dataset.flight); return; }

    const pe = ev.target.closest('[data-period]');
    if (pe) { showPeriodSheet(pe.dataset.period); return; }

    const act = ev.target.closest('[data-act]');
    if (!act) return;
    const key = act.dataset.key;
    if (act.dataset.act === 'filter-person') {
      S.filter.crew = [key]; renderFilterChips(); hideSheet(); refreshAll();
      switchView('map'); drawMap(true); toast(`Filtered to ${personName(key)}`);
    } else if (act.dataset.act === 'overlap-person') {
      if (!S.overlap.crew.includes(key)) S.overlap.crew.push(key);
      hideSheet(); switchView('crew');
      $$('#crewMode button').forEach(x => x.classList.toggle('is-on', x.dataset.mode === 'overlap'));
      $('#crewPane-people').hidden = true; $('#crewPane-overlap').hidden = false;
      renderOverlap(); toast(`${personName(key)} added to overlap`);
    } else if (act.dataset.act === 'rename-person') {
      await renamePerson(key);
    }
  });

  $('#sheetGrab').addEventListener('click', hideSheet);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { hideSheet(); $('#filterSheet').hidden = true; } });
}

/** Rename a person; renaming onto an existing name merges the two records. */
async function renamePerson(key) {
  const current = personName(key);
  const next = prompt('Name for this person (use an existing name to merge duplicates):', current);
  if (next == null) return;
  const name = next.trim();
  if (!name || name === current) return;
  const newKey = normKey(name);

  const people = await getAll('people');
  const map = new Map(people.map(p => [p.key, p]));
  const target = map.get(newKey);

  if (target && newKey !== key) {                       // merge into an existing person
    const aliases = await metaGet('aliases', {});
    aliases[key] = newKey;
    for (const [from, to] of Object.entries(aliases)) if (to === key) aliases[from] = newKey;
    await metaSet('aliases', aliases);
    target.isOwner = target.isOwner || (map.get(key) || {}).isOwner;
    await putAll('people', [target]);
    const flights = await getAll('flights');
    const touched = flights.filter(f => (f.crew || []).includes(key))
      .map(f => ({ ...f, crew: [...new Set(f.crew.map(k => k === key ? newKey : k))] }));
    await putAll('flights', touched);
    toast(`Merged into ${name}`);
  } else {
    const p = map.get(key);
    if (!p) return;
    await putAll('people', [{ ...p, key: newKey, name }]);
    if (newKey !== key) {
      const aliases = await metaGet('aliases', {});
      aliases[key] = newKey; await metaSet('aliases', aliases);
      const t = tx(['people'], 'readwrite'); t.objectStore('people').delete(key); await idbDone(t);
      const flights = await getAll('flights');
      const touched = flights.filter(f => (f.crew || []).includes(key))
        .map(f => ({ ...f, crew: [...new Set(f.crew.map(k => k === key ? newKey : k))] }));
      await putAll('flights', touched);
    }
    toast('Renamed');
  }
  S.filter.crew = S.filter.crew.map(k => k === key ? newKey : k);
  S.overlap.crew = [...new Set(S.overlap.crew.map(k => k === key ? newKey : k))];
  await loadData(); hideSheet(); refreshAll();
}

async function exportBackup() {
  const payload = {
    app: 'transavia-roster', version: 1, exported: new Date().toISOString(),
    flights: S.flights, duties: S.duties,
    people: [...S.people.values()].map(p => ({ ...p, tags: [...(p.tags || [])] })),
    sources: S.sources,
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const name = `transavia-roster-backup-${iso(new Date())}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── 15. boot ───────────────────────────────────────────────────────────── */

const SW_TAG = '5';   // keep in step with VERSION in sw.js

async function boot() {
  try {
    await loadReference();
    db = await openDB();
    await loadData();
  } catch (err) {
    console.error(err);
    $('#boot').innerHTML = `<p style="max-width:280px;text-align:center">Could not open local storage.<br><small>${esc(err.message || err)}</small><br><br>Private browsing blocks IndexedDB — open the app in a normal tab.</p>`;
    return;
  }
  initMap();
  wireEvents();
  $('#fPassive').checked = S.filter.passive;
  refreshAll();
  if (S.flights.length) drawMap(true); else switchView('data');
  $('#boot').classList.add('is-gone');
  setTimeout(() => { $('#boot').hidden = true; }, 350);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(r => { $('#swStatus').textContent = `Service worker: active — the app opens offline (v${SW_TAG}).`; return r; })
      .catch(e => { $('#swStatus').textContent = 'Service worker: not registered — serve the app over http(s), not file://'; console.warn(e); });
  } else {
    $('#swStatus').textContent = 'Service worker: unsupported in this browser.';
  }
}

document.addEventListener('DOMContentLoaded', boot);




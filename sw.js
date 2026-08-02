/* ============================================================================
   Transavia Roster — service worker
   Precaches the whole app shell (including the PDF parser and the offline
   world outline) so the app opens and imports rosters with no network at all.
   Map tiles, when the user turns them on, are cached opportunistically.
   ========================================================================== */

const VERSION    = 'v17';
const SHELL      = `roster-atlas-shell-${VERSION}`;
const TILES      = `roster-atlas-tiles-${VERSION}`;
const TILE_LIMIT = 700;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './LICENSE',
  './CHANGELOG.md',
  './vendor/leaflet.js',
  './vendor/leaflet.css',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './data/airports.json',
  './data/world.geo.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Add individually so one failure can't abort the whole install.
    await Promise.all(SHELL_FILES.map(u =>
      cache.add(new Request(u, { cache: 'reload' })).catch(err => console.warn('[sw] skip', u, err))));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('roster-atlas-') && k !== SHELL && k !== TILES)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/** Keep the tile cache from growing without bound (FIFO). */
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Map tiles — cache first, then network, bounded. Only reached when the user
     has explicitly switched online tiles on. */
  if (/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/.test(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          cache.put(req, res.clone());
          trimCache(TILES, TILE_LIMIT);
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'Offline — tile not cached' });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;   // never touch anything else

  /* App shell — cache first, and deliberately WITHOUT background revalidation.
     Refreshing individual files into the running cache used to mean index.html
     and app.js could come from different builds, which breaks the app in ways
     that look nothing like a caching problem. The whole shell is precached
     together at install under a versioned cache name, so a release is adopted
     as one atomic set when VERSION changes and never half-applied. */
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      /* Anything reaching here was not in the versioned shell cache, so caching
         it cannot mix generations. */
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }
      return new Response('Offline and not cached', { status: 504 });
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

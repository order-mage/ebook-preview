/*
 * App-shell service worker: the staff app must OPEN with no connectivity, not
 * just keep working once it is open (the data layer is already offline-first).
 *
 * Strategy
 *  - navigations: network first, cache fallback (online users always get the
 *    freshest HTML; offline they get the last one that loaded)
 *  - hashed build assets (/assets/*): cache first, they never change content
 *  - icons/manifest: stale-while-revalidate
 *  - /api/*, /r/*: never touched — those are live data and guest pages
 */
const VERSION = 'ebook-v2';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;
const APP_ENTRY = '/private-login';

/**
 * Precache the shell AND the build assets it references. Reading the asset
 * URLs out of the cached HTML keeps this file free of build-time knowledge —
 * and it matters: the worker only starts controlling requests after the page
 * has loaded, so without this the very first visit would cache the HTML but
 * none of the scripts, and an offline start would render a blank page.
 */
async function precacheShell() {
  const shell = await caches.open(SHELL);
  await Promise.allSettled(
    [APP_ENTRY, '/manifest.webmanifest', '/icon.svg'].map((u) => shell.add(u)),
  );
  const entry = await shell.match(APP_ENTRY);
  if (!entry) return;
  const html = await entry.clone().text();
  const refs = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map(
    (m) => new URL(m[1], self.location.origin).pathname,
  );
  if (refs.length === 0) return;
  const assets = await caches.open(ASSETS);
  await Promise.allSettled(refs.map((u) => assets.add(u)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Same-origin GET only; live endpoints are always passed through untouched. */
function handled(url, request) {
  if (request.method !== 'GET') return false;
  if (url.origin !== self.location.origin) return false;
  return !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/r/');
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached =
      (await cache.match(request, { ignoreVary: true })) ??
      (await cache.match(APP_ENTRY, { ignoreVary: true }));
    if (cached) return cached;
    throw new Error('offline and nothing cached');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!handled(url, event.request)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
  }
});

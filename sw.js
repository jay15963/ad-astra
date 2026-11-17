// Ad Astra service worker: network-first for every same-origin GET, so a phone never runs a mix of old
// and new modules after a deploy. Each request is revalidated with the server (cache: 'no-cache' → the
// HTTP cache must send If-None-Match / If-Modified-Since). The last good copy of each file is kept in
// Cache Storage only as an offline fallback.
// Keep SW_VERSION equal to APP_VERSION in src/ui/settings.js (tests/sw.test.mjs checks it).
const SW_VERSION = '0.3.0';
const CACHE = `adastra-${SW_VERSION}`;

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('adastra-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ type: 'sw-version', version: SW_VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // partial content: let the browser handle it
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    // navigations keep their mode; everything else is revalidated against the server
    const res = await fetch(req, { cache: 'no-cache' });
    if (!res || !res.ok || res.type !== 'basic' || res.status !== 200) return res;
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => { /* quota: ignore */ });
    // The page's memory cache (scripts, styles) would otherwise reuse a module it thinks is still fresh
    // (GitHub Pages sends max-age=600) without asking this worker: mark every response as must-revalidate.
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-cache');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./')) || (await cache.match('./index.html'));
      if (shell) return shell;
    }
    throw err;
  }
}

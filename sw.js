// Ad Astra service worker: network-first for every same-origin GET, so a phone never runs a mix of old
// and new modules after a deploy. Each request is revalidated with the server (cache: 'no-cache' → the
// HTTP cache must send If-None-Match / If-Modified-Since). The last good copy of each file is kept in
// Cache Storage as the offline fallback.
// On install the app shell is precached (index, styles, every module reachable from app.js — static and
// dynamic imports, found by following the import statements — the game data and the icons), so the app
// opens offline from the second visit on, including screens never opened online (Mapa, Dia de Lançamento).
// Keep SW_VERSION equal to APP_VERSION in src/ui/settings.js (tests/sw.test.mjs checks it).
const SW_VERSION = '0.9.21';
const CACHE = `adastra-${SW_VERSION}`;

// entry points of the crawl; everything they import or link is added (same origin only)
const SHELL = [
  './', './index.html', './manifest.webmanifest', './styles.css', './src/ui/app.js',
  './src/ui/techtree.css', './src/ui/worldmap.css', './src/ui/map.css', './src/ui/launch-scene.css',
  './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/icon-maskable-192.png',
  './assets/icon-maskable-512.png', './assets/apple-touch-icon.png', './assets/favicon-32.png',
];
// = DATA_FILES in src/core/data.js + the lazily loaded world map + the pack manifest and scenario list
// (tests/sw-pwa.test.mjs checks it), plus two files the UI fetches outside the manifest: world-eras (épocas do
// mapa-múndi, worldmap.js) and core/stars (setor e galáxia, starmap.js). The crawl adds, from data/packs.json
// (packFiles), the always-loaded packs, each era's era.json and the scenarios; the rest of an era pack is cached per
// era when the page asks ('precache-eras'), so new era packs need no edit here.
const DATA = ['scenario', 'actors', 'vehicles', 'spacecraft', 'destinations', 'calendar', 'politics', 'geopolitics',
  'tech', 'events', 'crew', 'bodies', 'world', 'packs', 'scenarios/index',
  'world-eras', 'core/stars'];
const MAX_PRECACHE = 250;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // never fail the install: a file missing now is cached the first time the page asks for it
  event.waitUntil(precache().catch(() => { /* offline or partial: network-first fills the gaps */ }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('adastra-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ type: 'sw-version', version: SW_VERSION });
  if (event.data?.type === 'precache-eras' && Array.isArray(event.data.eras)) event.waitUntil?.(precacheEras(event.data.eras.map(String)).catch(() => {}));
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
      // start_url may carry a query (?source=pwa): any navigation inside the scope gets the shell
      const shell = (await cache.match('./')) || (await cache.match('./index.html')) || (await cache.match(req, { ignoreSearch: true }));
      if (shell) return shell;
    }
    throw err;
  }
}

// ------------------------------------------------------------------ precache

/** Same-origin URLs referenced by a file: ES module imports, <link>/<script> in HTML, url() in CSS. */
function referencesOf(text, base, type) {
  const specs = [];
  if (type === 'js') {
    for (const m of text.matchAll(/(?:^|[;\s])import\s*(?:[\w$*{}\s,]+\s*from\s*)?['"]([^'"]+)['"]/g)) specs.push(m[1]);
    for (const m of text.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) specs.push(m[1]); // export … from
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of text.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g)) specs.push(m[1]);
  } else if (type === 'html') {
    for (const m of text.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)) specs.push(m[1]);
  } else if (type === 'css') {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (!m[1].startsWith('data:')) specs.push(m[1]);
  }
  const out = [];
  for (const s of specs) {
    try {
      const u = new URL(s, base);
      u.hash = '';
      if (u.origin === self.location.origin) out.push(u.href);
    } catch { /* bad spec */ }
  }
  return out;
}

/**
 * data/packs.json -> pack files to precache (absolute URLs, same folder as the manifest). Per-era lazy precache
 * (EXPANSION.md §10, Phase D4): the install takes the packs that are always loaded, every era's era.json (title,
 * palettes) and the scenarios; the content of an era pack (and of a pack bound to eras, like colonies) only when
 * `eras` lists it — the page asks for the current and the next era with a 'precache-eras' message (src/ui/store.js).
 */
function packFiles(text, base, eras = null) {
  const out = [];
  try {
    const m = JSON.parse(text);
    const want = new Set(eras || []);
    for (const p of m.packs || []) {
      const bound = p.era ? [p.era] : Array.isArray(p.eras) ? p.eras : [];
      const all = p.always || bound.some((e) => want.has(e));
      for (const f of p.files || []) if (all || (eras === null && p.era && f === 'era')) out.push(new URL(`${p.dir || ''}${f}.json`, base).href);
    }
    if (eras === null) for (const f of Object.values(m.scenarios || {})) out.push(new URL(f, base).href);
  } catch { /* bad manifest: the loader reports it */ }
  return out;
}

/** Cache the content of some era packs (message from the page; failures are ignored: network-first fills gaps). */
async function precacheEras(eras) {
  const scope = self.registration?.scope || new URL('./', self.location.href).href;
  const manifestUrl = new URL('./data/packs.json', scope).href;
  const cache = await caches.open(CACHE);
  let text = '';
  try { const r = await fetch(manifestUrl, { cache: 'no-cache' }); text = r.ok ? await r.text() : ''; } catch { /* offline */ }
  if (!text) { const hit = await cache.match(manifestUrl); text = hit ? await hit.text() : ''; }
  for (const href of packFiles(text, manifestUrl, eras)) {
    if (await cache.match(href)) continue;
    try { const res = await fetch(href, { cache: 'no-cache' }); if (res.ok && res.type === 'basic') await cache.put(href, res); } catch { /* offline */ }
  }
}

const typeOf = (href) => (/\.m?js(\?|$)/.test(href) ? 'js' : /\.css(\?|$)/.test(href) ? 'css' : /(\/|\.html)(\?|$)/.test(href) ? 'html' : '');

async function precache() {
  const cache = await caches.open(CACHE);
  const scope = self.registration?.scope || new URL('./', self.location.href).href;
  const queue = [...SHELL, ...DATA.map((n) => `./data/${n}.json`)].map((u) => new URL(u, scope).href);
  const seen = new Set(queue);
  let i = 0;
  const worker = async () => {
    while (i < queue.length && seen.size <= MAX_PRECACHE) {
      const href = queue[i++];
      let res;
      try { res = await fetch(href, { cache: 'no-cache' }); } catch { continue; }
      if (!res || !res.ok || res.type !== 'basic') continue;
      const type = typeOf(href);
      if (/\/data\/packs\.json(\?|$)/.test(href)) {
        const text = await res.clone().text().catch(() => '');
        for (const ref of packFiles(text, href)) {
          if (!seen.has(ref) && seen.size < MAX_PRECACHE) { seen.add(ref); queue.push(ref); }
        }
      }
      if (type) {
        const text = await res.clone().text().catch(() => '');
        for (const ref of referencesOf(text, href, type)) {
          if (!seen.has(ref) && seen.size < MAX_PRECACHE) { seen.add(ref); queue.push(ref); }
        }
      }
      await cache.put(href, res).catch(() => { /* quota */ });
    }
  };
  // a few parallel fetches; the queue grows while the crawl finds new modules
  await Promise.all([worker(), worker(), worker(), worker()]);
  // workers that found the queue empty early may have exited while others kept adding: drain the rest
  while (i < queue.length) await worker();
}

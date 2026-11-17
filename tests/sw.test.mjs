// Service worker: version in sync with the app, network-first with revalidation, registered from app.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('sw.js version matches APP_VERSION and package.json', () => {
  const sw = read('sw.js');
  const swVer = sw.match(/SW_VERSION\s*=\s*'([^']+)'/)?.[1];
  const appVer = read('src/ui/settings.js').match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
  assert.ok(swVer, 'SW_VERSION missing');
  assert.equal(swVer, appVer);
  assert.equal(JSON.parse(read('package.json')).version, appVer);
});

test('sw.js is network-first with revalidation and an offline cache fallback', () => {
  const sw = read('sw.js');
  assert.match(sw, /cache:\s*'no-cache'/, 'network requests must revalidate the HTTP cache');
  assert.match(sw, /req\.method !== 'GET'/);
  assert.match(sw, /self\.location\.origin/, 'only same-origin requests');
  assert.match(sw, /caches\.match|cache\.match/, 'offline fallback');
  assert.match(sw, /'Cache-Control', 'no-cache'/, 'responses must not be reused from the page memory cache');
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
  // the network is tried before the cache
  assert.ok(sw.indexOf('await fetch(') < sw.indexOf('cache.match(req)'), 'fetch must come before cache lookup');
  assert.doesNotThrow(() => new Function(sw.replace(/self\./g, 'globalThis.')), 'sw.js must parse');
});

test('app.js registers ./sw.js without the HTTP cache for the worker script', () => {
  const app = read('src/ui/app.js');
  assert.match(app, /serviceWorker\.register\('\.\/sw\.js'/);
  assert.match(app, /updateViaCache:\s*'none'/);
  assert.match(app, /planMission:/, 'store.ui.planMission hook for the space map');
  assert.match(read('src/ui/settings.js'), /export const BUILD\s*=/);
});

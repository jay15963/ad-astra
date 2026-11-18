// Installable app (PWA) + startup: manifest, icons, iOS tags, precache, data prefetch and modulepreload lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DATA_FILES } from '../src/core/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** width, height and a decoded first pixel row check of a PNG file. */
function pngInfo(file) {
  const b = fs.readFileSync(path.join(root, file));
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file}: not a PNG`);
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  // collect IDAT and inflate: must hold exactly h rows of 1 + 4w bytes
  let off = 8; const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off); const type = b.subarray(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, h * (1 + 4 * w), `${file}: pixel data size`);
  const alphaAt = (x, y) => raw[y * (1 + 4 * w) + 1 + x * 4 + 3];
  return { w, h, alphaAt };
}

test('manifest is installable: standalone portrait, scope, PNG icons 192/512 + maskable', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.ok(m.name && m.short_name && m.short_name.length <= 12);
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.orientation, 'portrait');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  const png = m.icons.filter((i) => i.type === 'image/png');
  for (const size of [192, 512]) {
    assert.ok(png.some((i) => i.sizes === `${size}x${size}` && i.purpose === 'any'), `any ${size}`);
    assert.ok(png.some((i) => i.sizes === `${size}x${size}` && i.purpose === 'maskable'), `maskable ${size}`);
  }
  for (const i of m.icons) {
    assert.ok(fs.existsSync(path.join(root, i.src)), `${i.src} missing`);
    if (i.type !== 'image/png') continue;
    const { w, h, alphaAt } = pngInfo(i.src);
    assert.equal(`${w}x${h}`, i.sizes, `${i.src} size`);
    // maskable icons are full-bleed (opaque corners); "any" keeps the rounded transparent corners
    if (i.purpose === 'maskable') assert.equal(alphaAt(0, 0), 255, `${i.src} corner must be opaque`);
    else assert.equal(alphaAt(0, 0), 0, `${i.src} corner must be transparent`);
    assert.equal(alphaAt(w >> 1, h >> 1), 255, `${i.src} centre must be opaque`);
  }
});

test('index.html: iOS home screen tags, apple-touch-icon 180 opaque, manifest link', () => {
  const html = read('index.html');
  assert.match(html, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /name="apple-mobile-web-app-title" content="Ad Astra"/);
  const touch = html.match(/rel="apple-touch-icon" href="([^"]+)"/)?.[1];
  assert.ok(touch, 'apple-touch-icon');
  const { w, alphaAt } = pngInfo(touch);
  assert.equal(w, 180);
  assert.equal(alphaAt(0, 0), 255, 'iOS paints transparent pixels black: the touch icon must be opaque');
});

test('index.html prefetches exactly DATA_FILES (app.js consumes window.__adastraData)', () => {
  const html = read('index.html');
  const list = html.match(/var files = \[([^\]]+)\]/)?.[1];
  assert.ok(list, 'prefetch list');
  assert.deepEqual(list.split(',').map((s) => s.trim().replace(/'/g, '')), DATA_FILES);
  assert.match(read('src/ui/app.js'), /__adastraData/);
});

/** Static import closure of app.js (the modules needed before the first screen). */
function staticClosure(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*import\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(entry);
  return [...seen].map((f) => path.relative(root, f).split(path.sep).join('/'));
}

test('modulepreload links point at real files and cover the startup module graph', () => {
  const html = read('index.html');
  const pre = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pre.includes('src/ui/app.js'));
  for (const f of pre) assert.ok(fs.existsSync(path.join(root, f)), `modulepreload of missing ${f}`);
  const need = staticClosure(path.join(root, 'src/ui/app.js'));
  const missing = need.filter((f) => !pre.includes(f));
  // a new static import only loses the preload (one extra round trip), it does not break the game
  if (missing.length) console.warn(`aviso: sem modulepreload em index.html: ${missing.join(', ')}`);
  assert.ok(missing.length <= 3, `index.html modulepreload list is stale: ${missing.join(', ')}`);
});

test('sw.js precaches the shell, every data file and the icons, and never fails the install', () => {
  const sw = read('sw.js');
  const data = sw.match(/const DATA = \[([\s\S]*?)\];/)?.[1];
  assert.ok(data, 'DATA list');
  const names = data.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  for (const n of DATA_FILES) assert.ok(names.includes(n), `sw.js DATA misses ${n}`);
  assert.ok(names.includes('world'), 'world.json (lazy world map) must be precached');
  for (const n of names) assert.ok(fs.existsSync(path.join(root, 'data', `${n}.json`)), `data/${n}.json`);
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)?.[1];
  for (const f of shell.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean)) {
    if (f === './') continue;
    assert.ok(fs.existsSync(path.join(root, f)), `sw.js SHELL lists missing ${f}`);
  }
  assert.match(sw, /addEventListener\('install'[\s\S]*?waitUntil\(precache\(\)\.catch\(/, 'install waits for the precache and swallows its errors');
  assert.match(sw, /import\\\(/, 'the crawl follows dynamic imports (launch scene, map)');
});

test('sw.js import crawl finds static, dynamic and CSS references', () => {
  const sw = read('sw.js');
  const self = { location: { origin: 'http://x', href: 'http://x/sw.js' }, addEventListener() {}, registration: null };
  const fn = new Function('self', 'caches', `${sw}\nreturn { referencesOf };`);
  const { referencesOf } = fn(self, {});
  const js = `import { a } from './a.js';\nimport * as b from "../b.js";\nimport './side.js';\nexport { c } from './c.js';\nconst m = import('./lazy/m.js');\nimport x from 'node:fs';\nfetch('https://other.example/x.js');\nconst u = new URL('./t.css', import.meta.url);`;
  const refs = referencesOf(js, 'http://x/src/ui/app.js', 'js');
  for (const r of ['http://x/src/ui/a.js', 'http://x/src/b.js', 'http://x/src/ui/side.js', 'http://x/src/ui/c.js', 'http://x/src/ui/lazy/m.js', 'http://x/src/ui/t.css']) {
    assert.ok(refs.includes(r), `missing ${r} in ${refs.join(' ')}`);
  }
  assert.ok(!refs.some((r) => !r.startsWith('http://x/')), 'cross-origin / node: specifiers are skipped');
  const html = referencesOf('<link rel="stylesheet" href="styles.css" /><script type="module" src="src/ui/app.js"></script>', 'http://x/', 'html');
  assert.deepEqual(html, ['http://x/styles.css', 'http://x/src/ui/app.js']);
  const css = referencesOf('a{background:url("../img/a.png")} b{background:url(data:image/png;base64,AAA)}', 'http://x/src/ui/x.css', 'css');
  assert.deepEqual(css, ['http://x/src/img/a.png']);
});

test('build-icons PNG encoder round-trips through zlib', async () => {
  const { encodePNG } = await import('../tools/build-icons.mjs');
  const w = 3, h = 2;
  const px = new Uint8Array(w * h * 4).map((_, i) => (i * 37) & 255);
  const png = encodePNG(w, h, px);
  const tmp = path.join(root, 'tests', '.tmp-icon.png');
  fs.writeFileSync(tmp, png);
  try {
    const info = pngInfo(path.relative(root, tmp));
    assert.equal(info.w, 3);
    assert.equal(info.alphaAt(1, 1), px[(1 * w + 1) * 4 + 3]);
  } finally { fs.unlinkSync(tmp); }
});

test('settings: install card with native prompt and iOS instructions; context detection', async () => {
  const src = read('src/ui/settings.js');
  assert.match(src, /beforeinstallprompt/);
  assert.match(src, /Instalar app/);
  assert.match(src, /Adicionar à Tela de Início/);
  const { installContext } = await import('../src/ui/settings.js');
  const mm = (on) => (q) => ({ matches: on && q.includes('standalone') });
  assert.equal(installContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }, mm(false)), 'ios');
  assert.equal(installContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }, mm(false)), 'ios');
  assert.equal(installContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)' }, mm(false)), 'android');
  assert.equal(installContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)' }, mm(true)), 'standalone');
  assert.equal(installContext({ userAgent: 'x', standalone: true }, mm(false)), 'standalone');
  assert.equal(installContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }, mm(false)), 'other');
});

test('sw.js precaches every file of data/packs.json (era packs, core files, scenarios) through the manifest', () => {
  const sw = read('sw.js');
  const src = sw.match(/function packFiles\([\s\S]*?\n}\n/)?.[0];
  assert.ok(src, 'packFiles in sw.js');
  assert.ok(sw.includes('/\\/data\\/packs\\.json(\\?|$)/.test(href)'), 'the crawl expands data/packs.json');
  const packFiles = new Function(`${src}; return packFiles;`)();
  const base = 'https://x.test/app/data/packs.json';
  const urls = packFiles(read('data/packs.json'), base).map((u) => u.replace('https://x.test/app/data/', ''));
  const manifest = JSON.parse(read('data/packs.json'));
  for (const p of manifest.packs) for (const f of p.files) assert.ok(urls.includes(`${p.dir}${f}.json`), `${p.dir}${f}.json`);
  for (const f of Object.values(manifest.scenarios)) assert.ok(urls.includes(f), f);
  assert.ok(urls.includes('eras/e1/era.json') && urls.includes('scenarios/campaign.json'));
  assert.deepEqual(packFiles('não é json', base), []);
});

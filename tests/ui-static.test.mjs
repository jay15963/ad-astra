// UI shell tests: import graph of src/ui resolves (files + named exports), DOM-free helpers work in Node,
// portraits are valid/deterministic, and the store drives the engine with save/load.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(root, 'src', 'ui');
const OWNED = ['app', 'store', 'components', 'portrait', 'dashboard', 'missions-tab', 'research-tab', 'world-tab', 'crew-view', 'decisions', 'newgame', 'settings', 'worldmap', 'map', 'launch-scene', 'audio', 'screens', 'drawer', 'screen-views', 'era-scene', 'infra-tab'];

/** Names exported by a module source (regex, good enough for our code style). */
function exportsOf(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const nm = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (nm) names.add(nm);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

/** Static + dynamic imports: [{spec, names: [..] | null (namespace/side effect), dynamic}] */
function importsOf(src) {
  const out = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1];
    const named = clause.match(/\{([\s\S]*?)\}/);
    const names = named ? named[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean) : null;
    out.push({ spec: m[2], names, dynamic: false });
  }
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], names: null, dynamic: true });
  return out;
}

test('every owned UI file exists and parses its imports', () => {
  for (const f of OWNED) assert.ok(fs.existsSync(path.join(UI, `${f}.js`)), `${f}.js missing`);
});

test('imports between src/ui files resolve to existing files and exports', () => {
  const problems = [];
  for (const f of OWNED) {
    const file = path.join(UI, `${f}.js`);
    const src = fs.readFileSync(file, 'utf8');
    for (const imp of importsOf(src)) {
      if (!imp.spec.startsWith('.')) { problems.push(`${f}.js: non-relative import ${imp.spec}`); continue; }
      if (!imp.spec.endsWith('.js')) problems.push(`${f}.js: import without .js extension ${imp.spec}`);
      const target = path.resolve(path.dirname(file), imp.spec);
      if (!fs.existsSync(target)) {
        // dynamic imports of other agents' modules are guarded with try/catch in app.js
        if (imp.dynamic) { console.warn(`aviso: ${imp.spec} ainda não existe (import dinâmico protegido)`); continue; }
        problems.push(`${f}.js: ${imp.spec} not found`);
        continue;
      }
      if (imp.names) {
        const ex = exportsOf(fs.readFileSync(target, 'utf8'));
        for (const n of imp.names) if (!ex.has(n)) problems.push(`${f}.js: ${imp.spec} does not export ${n}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('other-agent contracts used by app.js are present when those files exist', () => {
  const ls = path.join(UI, 'launch-scene.js');
  if (fs.existsSync(ls)) assert.ok(exportsOf(fs.readFileSync(ls, 'utf8')).has('openLaunchScene'), 'launch-scene.js must export openLaunchScene');
  const mp = path.join(UI, 'map.js');
  if (fs.existsSync(mp)) assert.ok(exportsOf(fs.readFileSync(mp, 'utf8')).has('render'), 'map.js must export render');
});

test('UI code never touches engine internals besides the public API', () => {
  for (const f of OWNED) {
    const src = fs.readFileSync(path.join(UI, `${f}.js`), 'utf8');
    for (const imp of importsOf(src)) {
      if (imp.spec.includes('/sim/')) assert.fail(`${f}.js imports a sim module directly (${imp.spec}); use store.query`);
    }
  }
});

test('formatters (pt-BR, US$ millions)', async () => {
  const c = await import('../src/ui/components.js');
  assert.equal(c.fmtMoney(350), 'US$ 350 mi');
  assert.equal(c.fmtMoney(1200), 'US$ 1,2 bi');
  assert.equal(c.fmtMoney(1000), 'US$ 1 bi');
  assert.equal(c.fmtMoney(2.5), 'US$ 2,5 mi');
  assert.equal(c.fmtMoney(-20), '−US$ 20 mi');
  assert.equal(c.fmtMoney(null), 'US$ —');
  assert.equal(c.fmtMoneyDelta(20), '+US$ 20 mi');
  assert.equal(c.fmtPct(0.62), '62%');
  assert.equal(c.fmtBand(0.62, 0.78), '62 a 78%');
  assert.equal(c.fmtBand(0.7, 0.7), '70%');
  assert.equal(c.fmtDate(0, 2026), 'sem 1 · jan/2026');
  assert.equal(c.fmtIn(10, 10), 'esta semana');
  assert.match(c.fmtIn(13, 10), /^em 3 sem$/);
  assert.equal(c.esc('<a&"b">'), '&lt;a&amp;&quot;b&quot;&gt;');
  assert.equal(c.fmtEffect('reliability', 0.05), '+5% Confiabilidade');
  assert.equal(c.fmtEffect('commandPoints', 1), '+1 Pontos de Comando');
  assert.match(c.sparklineSVG([1, 3, 2, 5]), /^<svg[\s\S]*polyline[\s\S]*<\/svg>$/);
  assert.equal(c.attempt(() => { throw new Error('x'); }, 7), 7);
});

test('portraits: valid, deterministic, varied, all parts and moods', async () => {
  const { portraitSVG, portraitFromSeed, emblemSVG, iconPortraitSVG } = await import('../src/ui/portrait.js');
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const p = portraitFromSeed(`crew_${i}`);
    for (const mood of ['neutral', 'happy', 'sad', 'tense', 'dead']) {
      const svg = portraitSVG(p, { size: 64, mood });
      assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100"/);
      assert.ok(svg.endsWith('</svg>'));
      assert.ok(!/undefined|NaN|null/.test(svg), `bad svg for ${i}/${mood}`);
      assert.equal((svg.match(/<g/g) || []).length, (svg.match(/<\/g>/g) || []).length, 'balanced groups');
      if (mood === 'dead') assert.match(svg, /feColorMatrix/);
    }
    const a = portraitSVG(p);
    assert.equal(a, portraitSVG(p), 'deterministic');
    seen.add(a);
  }
  assert.ok(seen.size >= 55, `portraits should vary (${seen.size} distinct of 60)`);
  // explicit full part ranges, out-of-range clamped, missing portrait falls back to seed
  for (let hair = 0; hair < 10; hair++) assert.ok(portraitSVG({ skin: 5, hair, hairColor: 5, eyes: 4, brows: 3, mouth: 4, accessory: 5, suit: 3, bg: 5 }).length > 500);
  assert.ok(!/NaN|undefined/.test(portraitSVG({ skin: 99, hair: -3 })));
  assert.ok(portraitSVG(undefined).startsWith('<svg'));
  assert.ok(portraitSVG('some-id', { title: '<x>' }).includes('<title>x</title>'));
  assert.ok(!emblemSVG({ short: '<b>', color: 'javascript:' }).includes('<b>'));
  assert.match(emblemSVG({ short: 'NASA', color: '#0b3d91' }), /NASA/);
  for (const k of ['launch/ready', 'contract/offer', 'diplomacy/proposal', 'politics/x', 'briefing', 'event/x', '']) assert.ok(iconPortraitSVG(k).startsWith('<svg'));
});

test('decision queue ordering: blocking, urgency, expiry', async () => {
  const { sortDecisions, kindLabel } = await import('../src/ui/decisions.js');
  const list = [
    { id: 'a', urgency: 1, createdTurn: 0 },
    { id: 'b', urgency: 3, createdTurn: 2 },
    { id: 'c', urgency: 1, blocking: true },
    { id: 'd', urgency: 3, expiresTurn: 5 },
  ];
  assert.deepEqual(sortDecisions(list).map((d) => d.id), ['c', 'd', 'b', 'a']);
  assert.equal(kindLabel('launch/ready'), 'Dia de Lançamento');
  assert.equal(kindLabel('???'), 'Decisão');
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('store: new game, dispatch, autosave, load, settings, trends', async () => {
  const data = await loadDataNode(root);
  const { createStore, SAVE_KEY, SETTINGS_KEY } = await import('../src/ui/store.js');
  const storage = memStorage();
  const store = createStore(data, { storage });
  assert.equal(store.hasSave(), false);
  const playerId = data.scenario.playableActors[0];
  store.newGame({ playerId, seed: 42 });
  assert.equal(store.state.playerId, playerId);
  assert.ok(store.hasSave());
  let notified = 0;
  const unsub = store.subscribe(() => { notified++; });
  // resolve whatever is pending so time can move, then advance
  for (let i = 0; i < 6; i++) {
    for (const d of store.state.decisions.slice()) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      store.dispatch({ type: 'decision/resolve', id: d.id, choiceId: c?.id });
    }
    if (store.state.activeLaunch) break;
    const r = store.dispatch({ type: 'time/advance', weeks: 2, stopOnEvent: false });
    assert.equal(r.ok, true, r.error);
  }
  assert.ok(notified > 0);
  assert.ok(store.state.turn > 0);
  assert.equal(typeof store.trend('cash'), 'number');
  assert.ok(store.series('cash').length >= 1);
  // tryQuery never throws
  assert.equal(store.tryQuery('nope/unknown', 'fb'), 'fb');
  assert.throws(() => store.query('nope/unknown'));
  // unknown action returns an error instead of throwing
  assert.equal(store.dispatch({ type: 'nope/x' }).ok, false);
  // save/load roundtrip
  const turn = store.state.turn;
  const json = storage.getItem(SAVE_KEY);
  assert.ok(json && JSON.parse(json).turn === turn);
  const store2 = createStore(data, { storage });
  assert.equal(store2.saveInfo().turn, turn);
  assert.ok(store2.load());
  assert.equal(store2.state.turn, turn);
  assert.deepEqual(JSON.parse(JSON.stringify(store2.state)), store2.state);
  // settings persist
  store.setSettings({ textScale: 1.3, colorblind: true });
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).textScale, 1.3);
  assert.equal(createStore(data, { storage }).settings.colorblind, true);
  assert.equal(store.vibrate(10), false); // no navigator in Node
  unsub();
  store.deleteSave();
  assert.equal(store.hasSave(), false);
  assert.equal(store.state, null);
  assert.equal(store.dispatch({ type: 'time/advance' }).ok, false);
});

test('store survives a corrupt save', async () => {
  const data = await loadDataNode(root);
  const { createStore, SAVE_KEY } = await import('../src/ui/store.js');
  const storage = memStorage();
  storage.setItem(SAVE_KEY, '{not json');
  const store = createStore(data, { storage });
  assert.equal(store.load(), false);
  assert.ok(store.saveError);
  assert.equal(store.saveInfo(), null);
});

test('settings exports version info; manifest and icon are valid', async () => {
  const s = fs.readFileSync(path.join(UI, 'settings.js'), 'utf8');
  const ver = s.match(/APP_VERSION\s*=\s*'([^']+)'/)?.[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(ver, pkg.version, 'APP_VERSION must match package.json version');
  assert.match(s, /BUILD_DATE\s*=\s*'\d{4}-\d{2}-\d{2}'/);
  const man = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(man.lang, 'pt-BR');
  assert.equal(man.orientation, 'portrait');
  for (const ic of man.icons) assert.ok(fs.existsSync(path.join(root, ic.src)), ic.src);
  assert.match(fs.readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8'), /^<svg[\s\S]*<\/svg>\s*$/);
});

test('styles.css: era theme, safe areas, tap targets, accessibility hooks', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  for (const needle of ['data-era="4"', 'safe-area-inset-bottom', '--tap: 44px', '--text-scale', 'body.colorblind', 'body.reduce-motion', '.tabbar', '.ticker', '.modal']) {
    assert.ok(css.includes(needle), `styles.css missing ${needle}`);
  }
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, 'balanced braces');
});

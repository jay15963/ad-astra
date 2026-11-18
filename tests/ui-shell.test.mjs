// UI shell of the 1950-3000 expansion (docs/EXPANSION.md §12-13 item 11): screen registry, drawer contract,
// 5-slot bottom bar, step labels, save slots / rejection / v1 migration in the store, new-game actor list from
// the start date, era scene and ending stub texts, and the item-9 UI helpers. DOM-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as screens from '../src/ui/screens.js';
import { ICONS } from '../src/ui/components.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const data = await loadDataNode(root);

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('registry: every screen has a pt-BR title, a real icon and a way to open', async () => {
  const all = screens.screens();
  assert.ok(all.length >= 20, `${all.length} screens`);
  const ids = new Set();
  for (const d of all) {
    assert.ok(!ids.has(d.id), `duplicate ${d.id}`);
    ids.add(d.id);
    assert.ok(d.title && !/undefined|null|NaN/.test(d.title), `${d.id}: title`);
    assert.ok(/[a-zà-ú]/i.test(d.title) && d.title[0] === d.title[0].toUpperCase(), `${d.id}: sentence-case pt-BR title`);
    assert.ok(ICONS[d.icon], `${d.id}: icon ${d.icon} exists`);
    assert.ok(['bottom', 'drawer', 'hidden'].includes(d.nav), `${d.id}: nav`);
    if (d.nav === 'drawer') assert.ok(screens.GROUPS.some((g) => g.id === d.group), `${d.id}: group ${d.group}`);
    const ways = [d.go, d.action, d.load].filter(Boolean).length;
    assert.equal(ways, 1, `${d.id}: exactly one of go/action/load`);
    if (d.go) {
      const [tab] = d.go.split('/');
      assert.ok(screens.screenById(tab)?.load, `${d.id}: shortcut target ${tab} is a screen`);
    }
    if (d.load) {
      const m = await d.load();
      assert.equal(typeof (m?.render || m?.default), 'function', `${d.id}: load() gives a module with render()`);
    }
  }
  // the screens the user asked for are reachable from the drawer (built or "em breve")
  for (const id of ['identidade', 'conselho', 'hangar', 'lancamentos', 'tabela', 'memorial', 'album', 'ajustes', 'sobre', 'salvar', 'equipe', 'pesquisa', 'financas', 'noticias', 'diplomacia', 'anais', 'titulo']) {
    assert.equal(screens.screenById(id)?.nav, 'drawer', `${id} in the drawer`);
  }
});

test('bottom bar: 4 destinations, the disc in the middle = 5 equal slots', () => {
  assert.deepEqual(screens.bottomScreens().map((d) => d.id), ['painel', 'missoes', 'mapa', 'mundo']);
  const app = read('src/ui/app.js');
  assert.match(app, /const DISC_AT = 2;/);
  assert.ok(!/const TABS = |SCREEN_TITLES|VIEW_PARENT/.test(app), 'app.js has no screen list of its own');
  assert.match(app, /bottomScreens\(\)/);
});

test('registry: availability, drawer sections, routes and badges', () => {
  const st = { missions: [], decisions: [], news: [] };
  const sec = screens.drawerSections(st, data);
  assert.ok(sec.length >= 4);
  for (const s of sec) assert.ok(s.items.length && s.label);
  const flat = sec.flatMap((s) => s.items.map((d) => d.id));
  assert.ok(!flat.includes('colonias'), 'colonies hidden before they exist');
  assert.ok(!flat.includes('veiculo'), 'no "falta o veículo" item without such missions');
  const st2 = { ...st, missions: [{ id: 'm1', status: 'planning', vehicleId: null, source: 'calendar' }, { id: 'm2', status: 'planning', vehicleId: null, source: 'cert' }] };
  assert.ok(screens.drawerSections(st2, data).flatMap((s) => s.items.map((d) => d.id)).includes('veiculo'));
  assert.equal(screens.missionsNeedingVehicle(st2).length, 1, 'certification flights keep their locked rocket');
  assert.equal(screens.badgeOf(screens.screenById('missoes'), st2), true, 'amber dot on Missões');
  assert.equal(screens.badgeOf(screens.screenById('painel'), { decisions: [{}, {}] }), 2);
  assert.equal(screens.badgeOf({ badge: () => { throw new Error('x'); } }, st), 0, 'a throwing badge is 0');
  // routes
  assert.deepEqual(screens.resolveRoute('#noticias', st, data), { tab: 'mundo', sub: 'noticias' });
  assert.deepEqual(screens.resolveRoute('#memorial', st, data), { tab: 'equipe', sub: 'memorial' });
  assert.deepEqual(screens.resolveRoute('#missoes/m/abc', st, data), { tab: 'missoes', sub: 'm/abc' });
  assert.deepEqual(screens.resolveRoute('#nada', st, data), { tab: 'painel', sub: '' });
  assert.deepEqual(screens.resolveRoute('#titulo', st, data), { tab: 'painel', sub: '' }, 'actions are not routes');
  assert.deepEqual(screens.resolveRoute('#colonias', st, data), { tab: 'painel', sub: '' }, 'unavailable screens fall back');
  assert.equal(screens.bottomOwner('missoes'), 'missoes');
  assert.equal(screens.bottomOwner('ajustes'), null);
  assert.equal(screens.drawerCurrent({ tab: 'mundo', sub: 'tabela' }), 'tabela');
  assert.equal(screens.drawerCurrent({ tab: 'pesquisa', sub: '' }), 'pesquisa');
  assert.equal(screens.drawerCurrent({ tab: 'painel', sub: '' }), null);
  // a later phase adds a screen with one line, and can replace a stub by id
  screens.registerScreen({ id: 'teste_b', title: 'Tela de teste', icon: 'info', group: 'sistema', order: 99, load: async () => ({ render() {} }) });
  assert.ok(screens.drawerSections(st, data).find((s) => s.group === 'sistema').items.some((d) => d.id === 'teste_b'));
  assert.throws(() => screens.registerScreen({ id: 'Bad Id', title: 'x' }));
});

test('drawer: CSmanager gaveta contract (classes, aria, focus trap, swipe, Esc, back)', async () => {
  const { isCloseSwipe, SWIPE_CLOSE_PX } = await import('../src/ui/drawer.js');
  assert.equal(SWIPE_CLOSE_PX, 64);
  assert.equal(isCloseSwipe(300, 100, 200, 110), true, 'left swipe closes');
  assert.equal(isCloseSwipe(300, 100, 250, 100), false, 'short swipe does not');
  assert.equal(isCloseSwipe(300, 100, 200, 300), false, 'scrolling the list does not');
  assert.equal(isCloseSwipe(100, 100, 300, 100), false, 'right swipe does not');
  const src = read('src/ui/drawer.js');
  for (const n of ["'gaveta'", "'veu'", "'aberta'", "'visivel'", "'Escape'", "'Tab'", 'aria-current', 'inert', 'touchend']) assert.ok(src.includes(n), `drawer.js: ${n}`);
  const app = read('src/ui/app.js');
  for (const n of ["'aria-expanded'", "'aria-controls': 'gaveta'", 'popstate', 'pushState({ adastraDrawer: 1 }', "iconSVG('menu'"]) assert.ok(app.includes(n), `app.js: ${n}`);
  const css = read('src/ui/css/shell.css');
  for (const n of ['.gaveta', '.gaveta.aberta', '.veu', '.veu.visivel', 'var(--safe-t)', 'var(--safe-b)', 'var(--safe-l)', 'translateX(-104%)', 'reduce-motion', '.data-chip', '.menu-ponto']) assert.ok(css.includes(n), `shell.css: ${n}`);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, 'balanced braces');
  assert.match(read('index.html'), /href="src\/ui\/css\/shell\.css"/);
  assert.match(read('docs/DESIGN.md'), /### 3\.6 Drawer/);
});

test('time: disc label for every step length, run budget, passed-time text', async () => {
  const { stepLabelFor, runMaxSteps, RUN_MAX_STEPS } = await import('../src/ui/store.js');
  const { passedText } = await import('../src/ui/components.js');
  assert.deepEqual([1, 2, 4, 13, 26, 52].map(stepLabelFor), ['+1 semana', '+2 sem', '+4 sem', '+1 trimestre', '+1 semestre', '+1 ano']);
  assert.equal(RUN_MAX_STEPS, 12);
  assert.equal(runMaxSteps(1), 26, 'Corrida Lunar: 26 weekly turns, as before');
  assert.equal(runMaxSteps(2), 13);
  assert.equal(runMaxSteps(13), 12);
  assert.equal(runMaxSteps(52), 12);
  assert.equal(passedText(1), '1 semana');
  assert.equal(passedText(4), '4 semanas');
  assert.equal(passedText(13), '3 meses');
  assert.equal(passedText(52), '1 ano');
  assert.equal(passedText(78), '1,5 anos');
});

test('components: fmtDate has no 2026 default; era info from the clock or the scenario', async () => {
  const c = await import('../src/ui/components.js');
  assert.equal(c.fmtDate(0), '—');
  assert.equal(c.fmtDate(0, 1950), 'sem 1 · jan/1950');
  assert.equal(c.fmtMonth(52 * 12 + 9, 1950), 'mar/1962');
  assert.equal(c.eraInfo(null, data).id, 'e4', 'Corrida Lunar is era 4');
  const e = c.eraInfo({ clock: { eraId: 'e1' } }, data);
  assert.equal(e.id, 'e1');
  assert.equal(e.n, 1);
  assert.equal(e.name, 'A Corrida');
});

test('store: manual slots, era checkpoints (last 2), slot list', async () => {
  const { createStore, slotKey, SAVE_KEY } = await import('../src/ui/store.js');
  const storage = memStorage();
  const store = createStore(data, { storage });
  store.newGame({ playerId: data.scenario.playableActors[0], seed: 3 });
  assert.equal(SAVE_KEY, 'adastra.save.auto');
  assert.ok(storage.getItem(SAVE_KEY));
  assert.equal(store.saveSlot('slot2'), true);
  assert.ok(storage.getItem(slotKey('slot2')));
  for (const e of ['e1', 'e2', 'e3']) assert.equal(store.eraCheckpoint(e), true);
  assert.equal(storage.getItem(slotKey('era.e1')), null, 'only the last 2 era checkpoints are kept');
  assert.ok(storage.getItem(slotKey('era.e3')));
  const slots = store.slots();
  assert.deepEqual(slots.filter((s) => s.kind === 'slot').map((s) => !!s.info), [false, true, false]);
  assert.deepEqual(slots.filter((s) => s.kind === 'era').map((s) => s.name), ['era.e3', 'era.e2']);
  // load a slot into a fresh store: the game continues in the auto slot
  const s2 = createStore(data, { storage });
  assert.equal(await s2.loadSlot('slot2'), true);
  assert.equal(s2.state.seed, 3);
  assert.equal(s2.saveSlot('auto'), false, 'auto is written by the game, not by hand');
});

test('store: rejected saves keep their text and give the pt-BR message', async () => {
  const { createStore, SAVE_KEY, SAVE_MESSAGES } = await import('../src/ui/store.js');
  const engine = await import('../src/core/engine.js');
  const cases = [
    ['{not json', SAVE_MESSAGES.unreadable],
    [JSON.stringify({ version: 99, turn: 1 }), SAVE_MESSAGES.newer],
  ];
  if (Number(engine.SAVE_VERSION) >= 2) {
    const s = engine.newGame(data, { seed: 1, playerId: data.scenario.playableActors[0] });
    cases.push([JSON.stringify({ ...s, scenarioId: 'nao_existe' }), SAVE_MESSAGES.scenario]);
  }
  for (const [raw, msg] of cases) {
    const storage = memStorage();
    storage.setItem(SAVE_KEY, raw);
    const store = createStore(data, { storage });
    assert.equal(store.load(), false);
    assert.equal(store.rejection?.message, msg, raw.slice(0, 20));
    assert.equal(store.saveError, msg);
    assert.ok([...storage._m.keys()].some((k) => k.startsWith('adastra.save.backup.')), 'raw text kept in a backup key');
    assert.equal(store.rawSave(store.rejection.slot), raw, 'Exportar o save gets the raw text');
    store.dismissRejected();
    assert.equal(store.rejection, null);
    assert.equal(storage.getItem(SAVE_KEY), null, 'Começar de novo frees the slot');
  }
});

test('store: a v1 save under adastra.save.v1 moves to the auto slot on first boot', async () => {
  const { createStore, SAVE_KEY, LEGACY_SAVE_KEY } = await import('../src/ui/store.js');
  const fx = path.join(root, 'tests', 'fixtures', 'save-v1-t120.json');
  const engine = await import('../src/core/engine.js');
  const raw = fs.existsSync(fx) ? fs.readFileSync(fx, 'utf8')
    : engine.serialize(engine.newGame(data, { seed: 5, playerId: data.scenario.playableActors[0] }));
  const storage = memStorage();
  storage.setItem(LEGACY_SAVE_KEY, raw);
  const store = createStore(data, { storage });
  assert.equal(store.rejection, null, store.saveError || '');
  assert.ok(storage.getItem(SAVE_KEY), 'written to the auto slot');
  assert.equal(storage.getItem(LEGACY_SAVE_KEY), null, 'old key deleted after the write');
  assert.equal(store.saveInfo().turn, JSON.parse(raw).turn);
  assert.equal(await store.loadSlot('auto'), true);
  assert.equal(store.state.version, engine.SAVE_VERSION);
});

test('new game: agencies alive at the start date (lifecycle), scenario list for the title', async () => {
  const { playableAtStart, createStore } = await import('../src/ui/store.js');
  const { titleModes, yearsOf } = await import('../src/ui/newgame.js');
  const lunar = playableAtStart(data);
  assert.deepEqual(lunar.map((a) => a.id), data.scenario.playableActors);
  for (const a of lunar) assert.ok(a.name, `${a.id} has a name`);
  const store = createStore(data, { storage: memStorage() });
  const modes = titleModes(store.scenarios());
  assert.ok(modes.scenarios.some((s) => s.id === 'lunar_race'), 'Corrida Lunar is offered as a Cenário');
  assert.equal(yearsOf({ start: { year: 1950 }, end: { year: 3000 } }), '1950 a 3000');
  assert.equal(yearsOf({ startYear: 2026, endYear: 2030 }), '2026 a 2030');
  // the campaign (when its data is present): 1950 names, nobody who is not born yet
  let camp = null;
  try { camp = await loadDataNode(root, { scenarioId: 'campaign' }); } catch { camp = null; }
  if (camp?.scenario?.id === 'campaign') {
    assert.ok(modes.campaign, 'Campanha on the title screen');
    const list = playableAtStart(camp);
    assert.ok(list.length >= 1, 'someone to play in 1950');
    const ids = list.map((a) => a.id);
    assert.ok(!ids.includes('spacex') && !ids.includes('esa'), `born later: ${ids.join(',')}`);
    const nasa = list.find((a) => a.id === 'nasa');
    if (nasa) assert.match(nasa.short || nasa.name, /NACA/, 'NASA is NACA in 1950');
    for (const a of list) assert.ok(a.name && !/undefined/.test(a.name));
    // the store switches scenarios through loadScenario and starts a 1950 game
    const s2 = createStore(data, { storage: memStorage(), loadScenario: async (id) => loadDataNode(root, { scenarioId: id }) });
    assert.equal(await s2.useScenario('campaign'), true);
    s2.newGame({ playerId: list[0].id, seed: 9, scenarioId: 'campaign' });
    assert.equal(s2.state.startYear, 1950);
    assert.notEqual(s2.stepLabel(), '', 'disc label');
  } else {
    console.warn('aviso: campanha ainda sem dados; teste parcial');
  }
});

test('era scene and ending stub: texts are complete for every transition', async () => {
  const { eraSceneModel, endingOptions } = await import('../src/ui/era-scene.js');
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
  for (let i = 0; i < ids.length - 1; i++) {
    const st = {
      playerId: 'nasa', turn: 1000, startYear: 1950,
      clock: { eraId: ids[i], eraStartTurn: 0, pendingEra: { from: ids[i], to: ids[i + 1] } },
      actors: { nasa: { id: 'nasa', short: 'NASA', prestige: 50 }, cnsa: { id: 'cnsa', short: 'CNSA', prestige: 70 } },
      firsts: { first_satellite: { actorId: 'nasa', turn: 10 } }, missions: [{ result: { outcome: 'total' }, launchTurn: 20 }],
      album: [], memorial: [{ name: 'Ana Souza', turn: 30 }],
    };
    const m = eraSceneModel(st, data);
    assert.equal(m.cards.length, 4);
    const text = JSON.stringify(m);
    assert.ok(!/undefined|NaN|null\b(?!")/.test(text.replace(/"(fromId|toId)":null/g, '')), `${ids[i]}: ${text}`);
    assert.match(m.cards[0].title, new RegExp(`Fim da Era ${i + 1}`));
    assert.match(m.cta, new RegExp(`Começar a Era ${i + 2}`));
    assert.ok(m.cards[1].lines.some((l) => /Primeiro/.test(l)));
  }
  const opts = endingOptions({ choices: [] }, data);
  assert.deepEqual(opts.map((o) => o.id), ['contato', 'silencio', 'heranca'], 'the three endings are always offered');
  for (const o of opts) assert.ok(o.title && o.text);
});

test('item 9 UI: nothing preselected, suggestion shown, accept leads to the vehicle step', async () => {
  const { needsHardware, hardwareUpdate } = await import('../src/ui/missions-tab.js');
  const { choiceLabel, afterResolveTarget } = await import('../src/ui/decisions.js');
  const { missionsWithoutVehicle } = await import('../src/ui/dashboard.js');
  assert.ok(needsHardware({ status: 'planning', vehicleId: null, source: 'calendar' }));
  assert.equal(needsHardware({ status: 'planning', vehicleId: null, source: 'cert' }), null, 'certification demo stays locked');
  assert.equal(needsHardware({ status: 'scheduled', vehicleId: null }), null);
  assert.equal(needsHardware({ status: 'planning', vehicleId: 'falcon9' }), null);
  assert.deepEqual(hardwareUpdate('m1', { vehicleId: 'v', spacecraftId: null }), { type: 'mission/update', missionId: 'm1', patch: { vehicleId: 'v', spacecraftId: null, secondarySpacecraftId: null } });
  assert.equal(choiceLabel({ kind: 'briefing' }, { id: 'accept', label: 'Aprovar o plano' }), 'Aceitar e escolher o veículo');
  assert.equal(choiceLabel({ kind: 'briefing' }, { id: 'delay', label: 'Adiar' }), 'Adiar');
  assert.equal(choiceLabel({ kind: 'diplomacy/proposal' }, { id: 'accept', label: 'Aceitar' }), 'Aceitar');
  assert.deepEqual(afterResolveTarget({ ok: true, openBuilder: 'm7', step: 2 }), { tab: 'missoes', sub: 'm/m7', step: 2 });
  assert.equal(afterResolveTarget({ ok: true }), null);
  assert.equal(missionsWithoutVehicle({ missions: [{ status: 'planning', vehicleId: null, source: 'opportunity' }] }).length, 1);
  const src = read('src/ui/missions-tab.js');
  assert.ok(!/preselect the cheapest compatible one/.test(src), 'builder no longer preselects a spacecraft');
  assert.match(src, /Sugestão dos engenheiros/);
  assert.match(src, /'falta o veículo'/);
  assert.match(src, /Escolha o foguete e a nave antes de agendar\./);
});

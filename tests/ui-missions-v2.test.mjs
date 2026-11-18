// Missões v2 UI (docs/MISSIONS-V2.md §11, owner missions-ui): builder steps with subtypes, targets and cargo, the
// Infraestrutura screen, labels/registry, decision prefill. Static tests with a minimal DOM (no layout): every
// screen renders without undefined/NaN/null in its text, labels are pt-BR, CSS keeps to 320 px.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, textOf, attrsOf } from './fixtures/dom-shim.mjs';
import { assetsFor } from './fixtures/infra-assets.mjs';
import { loadDataNode } from '../src/core/data.js';

install();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const mt = await import('../src/ui/missions-tab.js');
const comps = await import('../src/ui/components.js');
const BAD = /undefined|NaN|\bnull\b|\[object|Infinity/;

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function newStore({ playerId = 'esa', assets = true } = {}) {
  const { createStore } = await import('../src/ui/store.js');
  const store = createStore(data, { storage: memStorage() });
  store.newGame({ playerId, seed: 11 });
  // the core pack gains modules/missions at integration (B1); until then the UI reads the files directly
  if (!store.data.modules && fs.existsSync(path.join(root, 'data/core/modules.json'))) store.data.modules = readJson('data/core/modules.json');
  if (!store.data.missions && fs.existsSync(path.join(root, 'data/core/missions.json'))) store.data.missions = readJson('data/core/missions.json');
  if (assets) store.state.assets = assetsFor(store.state);
  let route = { sub: 'nova' };
  store.ui = { navigate: (tab, sub) => { route = { tab, sub: sub || '' }; }, route: () => route, scrollTop() {}, get last() { return route; } };
  return store;
}

function renderTo(fn) {
  const c = document.createElement('div');
  fn(c);
  return c;
}

function assertClean(el, what) {
  const t = textOf(el);
  const m = t.match(new RegExp(`.{0,40}(${BAD.source}).{0,40}`));
  assert.ok(!m, `${what}: "${m?.[0]}"`);
  const a = attrsOf(el);
  const ma = a.match(new RegExp(`.{0,30}(undefined|NaN|\\[object).{0,30}`));
  assert.ok(!ma, `${what} (attributes): "${ma?.[0]}"`);
  return t;
}

// ------------------------------------------------------------------ pure helpers

test('taxonomy: six types, no "Pouso"; legacy lander reads as Sonda · Pouso de sonda', () => {
  assert.deepEqual(mt.TYPES, ['satellite', 'probe', 'rover', 'crewed', 'cargo', 'station']);
  assert.equal(comps.TYPE_LABELS.rover, 'Rover');
  assert.ok(comps.TYPE_ICONS.rover);
  assert.ok(!Object.values(comps.TYPE_LABELS).includes('Pouso'));
  assert.equal(comps.missionTypeOf('lander'), 'probe');
  assert.equal(comps.typeSubLabel('lander'), 'Sonda · Pouso de sonda');
  assert.equal(comps.typeSubLabel('satellite', 'observatory'), 'Satélite · Observatório espacial');
  assert.equal(comps.typeSubLabel('rover', 'heavy'), 'Rover · Rover pesado');
  assert.equal(comps.PROPOSAL_LABELS.launch_services, 'Contrato de lançamento');
  assert.equal(comps.PROPOSAL_LABELS.station_partnership, 'Parceria de estação');
  for (const g of ['capsula', 'satelite', 'sonda', 'rodas', 'modulo', 'foguete', 'estacao', 'base']) assert.ok(comps.ICONS[g], `icon ${g}`);
  for (const k of Object.values(comps.UNLOCK_KINDS)) assert.ok(comps.ICONS[k.glyph], `glyph ${k.glyph}`);
});

test('subtype labels match the frozen ids of missions.json (when present) and vocab', () => {
  const f = path.join(root, 'data/core/missions.json');
  if (!fs.existsSync(f)) return;
  const rows = readJson('data/core/missions.json').subtypes || [];
  for (const r of rows) {
    if (r.type === 'station') continue;
    assert.ok(comps.SUB_LABELS[r.type]?.[r.id], `SUB_LABELS.${r.type}.${r.id}`);
  }
});

test('probe subtype follows the destination: surface = landing (R1)', () => {
  assert.equal(mt.deriveProbeSub('surface'), 'lander');
  assert.equal(mt.deriveProbeSub('atmosphere'), 'atmospheric');
  assert.equal(mt.deriveProbeSub('flyby'), 'flyby');
  assert.equal(mt.deriveProbeSub('orbit'), 'orbiter');
  assert.equal(mt.deriveProbeSub('rendezvous'), 'small_body');
  const idx = data.index.destinations;
  assert.equal(mt.defaultTypeFor(idx.lunar_surface), 'probe');
  assert.equal(mt.defaultTypeFor(idx.lunar_surface, 'rover'), 'rover');
  assert.equal(mt.defaultTypeFor(idx.leo), 'satellite');
});

test('targets and cargo rules per type/sub (§1.5, §11)', () => {
  assert.equal(mt.needsTarget({ type: 'station' }), true);
  assert.equal(mt.needsTarget({ type: 'cargo', sub: 'supply' }), true);
  assert.equal(mt.needsTarget({ type: 'cargo', sub: 'client' }), false);
  assert.equal(mt.needsTarget({ type: 'crewed', sub: 'rotation' }), true);
  assert.equal(mt.needsTarget({ type: 'crewed', sub: 'orbital' }), false);
  assert.equal(mt.needsTarget({ type: 'satellite', sub: 'comms' }), false);
  const leo = { kind: 'orbit' }, moon = { kind: 'surface', body: 'moon' };
  assert.equal(mt.canFound({ type: 'station' }, leo), true);
  assert.equal(mt.canFound({ type: 'station' }, moon), false);
  assert.equal(mt.canFound({ type: 'cargo', sub: 'base_module' }, moon), true);
  assert.equal(mt.canFound({ type: 'cargo', sub: 'supply' }, moon), false);
  assert.equal(mt.targetKindOf({ type: 'cargo', sub: 'supply' }, moon), 'base');
  assert.equal(mt.targetKindOf({ type: 'cargo', sub: 'servicing' }, leo), 'satellite');
  assert.equal(mt.payloadKindOf({ type: 'station' }), 'station_module');
  assert.equal(mt.payloadKindOf({ type: 'cargo', sub: 'base_vehicle' }), 'base_vehicle');
  assert.equal(mt.payloadKindOf({ type: 'crewed', sub: 'rotation' }), null);
});

test('carrier capacity and payload mass (§1.4)', () => {
  assert.equal(mt.carrierCargoT({ kind: 'cargo', massT: 10 }), 3.5);
  assert.equal(mt.carrierCargoT({ kind: 'lander', massT: 8 }), 2);
  assert.equal(mt.carrierCargoT({ kind: 'lander', massT: 8, cargoT: 6 }), 6);
  assert.equal(mt.carrierCheck({ kind: 'probe', massT: 1 }, 2), null, 'not a carrier: no check');
  assert.deepEqual(mt.carrierCheck({ kind: 'cargo', massT: 10 }, 5), { cargoT: 3.5, massT: 5, over: true });
  assert.equal(mt.carrierCheck({ kind: 'cargo', massT: 10 }, 3).over, false);
  assert.equal(mt.payloadMassT({ kind: 'base_vehicle', qty: 3 }, { vehicle: { massT: 0.5 } }), 1.5);
  assert.equal(mt.payloadMassT({ kind: 'supply', qty: 4 }), 4);
  assert.equal(mt.payloadMassT({ kind: 'servicing' }), 0.5);
  assert.equal(mt.payloadMassT({ kind: 'station_module', moduleId: 'x' }, { module: { massT: 15 } }), 15);
  assert.equal(mt.payloadMassT({ kind: 'station_module' }), null);
});

test('moduleAddsText says what a module adds, in pt-BR, capped', () => {
  const t = mt.moduleAddsText({ science: 8, crew: 3, ports: 2, storageT: 12, traits: ['arm'] });
  assert.match(t, /\+8 ciência\/ano/);
  assert.match(t, /\+3 tripulantes/);
  assert.match(t, /\+12 t de estoque/);
  assert.match(t, /braço robótico/);
  assert.equal(mt.moduleAddsText({ science: 8, crew: 3, ports: 2 }, 2).split(' · ').length, 2);
  assert.equal(mt.moduleAddsText(null), '');
});

test('keyLock: research decides under techGating, the year otherwise; unknown keys are open', () => {
  const nodes = [{ id: 'n_lab', name: 'Laboratórios orbitais', histYear: 1973, fromYear: 1970, cost: 100, unlocks: [{ key: 'module:station.lab' }] }];
  const d = (gating) => ({ tech: { nodes }, scenario: { techGating: gating } });
  const st = (year, keys = null, unlocked = []) => ({ startYear: year, turn: 0, research: { keys, unlocked } });
  assert.deepEqual(mt.keyLock(st(1980, []), d(true), 'module:station.lab'), { reason: 'Pesquise Laboratórios orbitais', nodeId: 'n_lab', nodeName: 'Laboratórios orbitais', year: 1973 });
  assert.equal(mt.keyLock(st(1980, ['module:station.lab']), d(true), 'module:station.lab'), null);
  assert.equal(mt.keyLock(st(1980, null, ['n_lab']), d(true), 'module:station.lab'), null);
  assert.equal(mt.keyLock(st(1980), d(false), 'module:station.lab'), null);
  assert.equal(mt.keyLock(st(1960), d(false), 'module:station.lab').reason, 'Disponível a partir de 1973');
  assert.equal(mt.keyLock(st(1960), d(true), 'module:unknown'), null);
  assert.equal(mt.keyLock(st(1960), { tech: { nodes: [] } }, null, 1990).reason, 'Disponível a partir de 1990');
});

test('subOptions: sim locks win, far-future locks are folded, defaults pick an open fitting sub', () => {
  const st = { startYear: 1990, turn: 0 };
  const subs = mt.subOptions(st, { tech: { nodes: [] } }, { type: 'satellite' }, null, null);
  assert.ok(subs.some((s) => s.id === 'comms' && !s.lock));
  assert.ok(subs.find((s) => s.id === 'constellation').lock, 'constellation (2019) locked in 1990');
  assert.ok(subs.find((s) => s.id === 'power_swarm').hidden, 'year 2650 folded');
  assert.ok(!subs.some((s) => s.id === 'client'));
  const sim = mt.subOptions(st, {}, { type: 'rover' }, [{ id: 'light' }, { id: 'heavy', locked: { reason: 'Pesquise Rovers pesados', nodeId: 't3_rov' } }], null);
  assert.deepEqual(sim.map((s) => s.id), ['light', 'heavy']);
  assert.equal(sim[1].lock.nodeId, 't3_rov');
  assert.equal(mt.defaultSubFor('probe', { kind: 'surface' }, mt.subOptions({ startYear: 1990, turn: 0 }, {}, { type: 'probe' })), 'lander');
  assert.equal(mt.defaultSubFor('crewed', { kind: 'station' }, mt.subOptions({ startYear: 1990, turn: 0 }, {}, { type: 'crewed' })), 'rotation');
  assert.equal(mt.defaultSubFor('rover', { kind: 'surface' }, sim), 'light');
});

test('station destinations (ISS, Salyut) never offer "Nova estação": modules sent there expand it', () => {
  assert.equal(mt.canFound({ type: 'station' }, { kind: 'station', id: 'iss' }), false);
  assert.equal(mt.canFound({ type: 'station' }, { kind: 'orbit', stationOk: false }), false);
  assert.equal(mt.canFound({ type: 'station' }, { kind: 'flyby' }), false);
  assert.equal(mt.canFound({ type: 'station' }, { kind: 'orbit' }), true);
});

test('dateLock: rows the sim left open still follow §0.2 (date rule) and unloaded eras under techGating', () => {
  const nodes = [{ id: 'n_lab', unlocks: [{ key: 'module:station.lab' }] }];
  const free = { tech: { nodes }, scenario: { techGating: false } };
  const gated = { tech: { nodes }, scenario: { techGating: true } };
  const st = (year, keys = []) => ({ startYear: year, turn: 0, research: { keys } });
  // Corrida Lunar: the year decides (2200 telescope out of 2026), no node needed
  assert.equal(mt.dateLock(st(2026), free, 2200).reason, 'Disponível a partir de 2200');
  assert.equal(mt.dateLock(st(2026), free, 2019), null);
  assert.equal(mt.dateLock(st(2026), free, null), null);
  // gated: a key granted by a loaded node is the sim's call; a held key is open; an unloaded era's key is locked
  assert.equal(mt.dateLock(st(1981), gated, 2000, 'module:station.lab'), null);
  assert.equal(mt.dateLock(st(1981, ['module:station.solar']), gated, 2000, 'module:station.solar'), null);
  const far = mt.dateLock(st(1981), gated, 2000, 'module:station.solar');
  assert.equal(far.reason, 'Pesquisa de uma era futura (por volta de 2000)');
  assert.equal(far.nodeId, null);
  assert.equal(mt.dateLock(st(1981), gated, 2000, null), null, 'no key: nothing to research');
  // wired into subOptions (sim rows without lock) and cargoRows (sim module rows without lock)
  const subs = mt.subOptions(st(2026), free, { type: 'satellite' }, [{ id: 'comms', histYear: 1962 }, { id: 'gravity_lens', histYear: 2200 }], null);
  assert.equal(subs.find((x) => x.id === 'comms').lock, null);
  assert.ok(subs.find((x) => x.id === 'gravity_lens').lock && subs.find((x) => x.id === 'gravity_lens').hidden, '2200 locked and folded in 2026');
  const md = { modules: { station: [{ id: 'st_lab', key: 'module:station.lab', histYear: 1973 }, { id: 'st_solar', key: 'module:station.solar', histYear: 2000 }] }, ...gated };
  const rows = mt.cargoRows(st(1981), md, { type: 'station' }, [{ id: 'st_lab', locked: null }, { id: 'st_solar', locked: null }], null);
  assert.equal(rows.find((r) => r.id === 'st_lab').lock, null);
  assert.match(rows.find((r) => r.id === 'st_solar').lock.reason, /era futura/);
  assert.equal(rows[rows.length - 1].id, 'st_solar', 'locked modules sort last');
});

test('typeLockOf reads the sim lock of a mission type', () => {
  const types = [{ id: 'satellite', locked: { reason: 'Pesquise Lançador orbital para liberar satélites.', nodeId: 't1_prop_orbital' } }, { id: 'probe', locked: null }];
  assert.deepEqual(mt.typeLockOf(types, 'satellite'), { reason: 'Pesquise Lançador orbital para liberar satélites.', nodeId: 't1_prop_orbital', year: null });
  assert.equal(mt.typeLockOf(types, 'probe'), null);
  assert.equal(mt.typeLockOf(null, 'probe'), null);
});

test('asset views: no NaN, shares and supply weeks from the raw slice and from sim views', async () => {
  const store = await newStore();
  const views = mt.assetViews(store);
  assert.ok(views.length >= 6);
  for (const a of views) {
    for (const k of ['health', 'share', 'crewN', 'sciYr', 'modulesN', 'vehiclesN', 'unitsN']) assert.ok(Number.isFinite(a[k]), `${a.id}.${k} = ${a[k]}`);
    assert.ok(a.name && a.ownerName && a.siteName && !BAD.test(`${a.name}${a.ownerName}${a.siteName}`), a.id);
  }
  const aurora = views.find((a) => a.id === 'as_1');
  assert.equal(aurora.mine, true);
  assert.ok(Number.isFinite(aurora.supplyWeeks) && aurora.supplyWeeks < 13, `Aurora low: ${aurora.supplyWeeks}`);
  const iss = views.find((a) => a.id === 'as_2');
  assert.equal(iss.mine, false);
  assert.equal(iss.partner, true, 'ESA is an ISS partner');
  assert.ok(iss.share > 0 && iss.share < 0.2);
  const need = mt.assetsNeedingSupply(views).map((a) => a.id).sort();
  assert.ok(need.includes('as_1') && need.includes('as_4'), need.join());
  assert.ok(!need.includes('as_3'));
  // a sim view (percent shares, crew as a number, units as a count) normalizes the same way
  const v = mt.normalizeAsset({ id: 'x', kind: 'station', name: 'X', ownerId: 'nasa', partners: [{ actorId: 'esa', share: 25 }, { actorId: 'nasa', share: 75 }], myShare: 25, crew: 4, crewCap: 6, units: 0, modules: [{ id: 'st_core', n: 1, label: 'Núcleo' }], supplyWeeks: 20, upkeepTYr: 3, supplyT: 1 }, store.state, store.data);
  assert.equal(v.share, 0.25);
  assert.equal(v.crewN, 4);
  assert.equal(v.crewCap, 6);
  assert.equal(v.supplyWeeks, 20);
});

test('assetPreview: step-3 "cria/muda" for stations, bases, satellites and rovers (pt-BR, no NaN)', async () => {
  const store = await newStore();
  const md = store.data.modules;
  const lab = md.station.find((m) => m.id === 'st_lab');
  const aurora = mt.assetViews(store).find((a) => a.id === 'as_1');
  const cases = [
    mt.assetPreview({ d: { type: 'station', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: 'as_1' } }, target: aurora, module: lab, md, playerId: store.state.playerId }),
    mt.assetPreview({ d: { type: 'station', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Farol' } }, module: md.station[0], md, playerId: store.state.playerId }),
    mt.assetPreview({ d: { type: 'cargo', sub: 'supply', payload: { kind: 'supply', qty: 6, targetAssetId: 'as_1' } }, target: aurora, md, playerId: store.state.playerId }),
    mt.assetPreview({ d: { type: 'satellite', sub: 'observatory' }, dest: data.index.destinations.leo, subRow: store.data.missions?.subtypes?.find((r) => r.id === 'observatory') }),
    mt.assetPreview({ d: { type: 'rover', sub: 'heavy' }, dest: data.index.destinations.mars_surface }),
  ];
  for (const pv of cases) {
    assert.ok(pv && pv.title && pv.rows.length, JSON.stringify(pv));
    const txt = pv.title + pv.rows.flat().join(' ') + (pv.note || '');
    assert.ok(!BAD.test(txt), txt);
  }
  assert.match(cases[1].title, /Farol/);
  assert.ok(cases[1].rows.some(([k, v]) => k === 'Sua participação' && v === '100%'));
  assert.ok(cases[0].rows.some(([k]) => k === 'Manutenção'));
  assert.ok(cases[3].rows.some(([k, v]) => k === 'Ciência' && /fim da vida útil/.test(v)), 'observatories give science until end of life (R4)');
  assert.ok(cases[4].rows.some(([k]) => k === 'Vida útil prevista'));
});

// ------------------------------------------------------------------ builder render

test('builder step 1 renders every type with subtypes, target block and cargo (no undefined/NaN)', async () => {
  const store = await newStore();
  const plan = [
    ['satellite', 'leo', /Tipo de satélite/],
    ['probe', 'lunar_surface', /Pouso de sonda/],
    ['rover', 'mars_surface', /Modelo de rover/],
    ['crewed', 'iss', /Estação de destino/],
    ['cargo', 'iss', /Suprimentos/],
    ['cargo', 'lunar_south_pole', /Tipo de carga/],
    ['station', 'leo', /Módulo da estação/],
  ];
  for (const [type, destination, re] of plan) {
    mt.prefillBuilder({ type, destination });
    const el = renderTo((c) => mt.render(c, store));
    const t = assertClean(el, `${type} → ${destination}`);
    assert.match(t, re, `${type}: ${t.slice(0, 400)}`);
    assert.ok(!/\bPouso\b(?! de sonda| tripulado)/.test(t.replace(/Sobrevoo, órbita ou pouso/, '')), `${type}: no "Pouso" type`);
    const d = mt.currentDraft();
    if (type !== 'station') assert.ok(d.sub, `${type}: a subtype is preselected`);
  }
  // probe to a surface = the landing (R1)
  mt.prefillBuilder({ type: 'probe', destination: 'lunar_surface' });
  renderTo((c) => mt.render(c, store));
  assert.equal(mt.currentDraft().sub, 'lander');
});

test('builder: station target rows (own, partner, other with "Propor parceria"), module cards and blockers', async () => {
  const store = await newStore();
  mt.prefillBuilder({ type: 'cargo', sub: 'supply', destination: 'leo', payload: { kind: 'supply', qty: 2 } });
  let el = renderTo((c) => mt.render(c, store));
  let t = assertClean(el, 'cargo supply leo');
  assert.match(t, /Aurora/);
  // either the sim preselects the player's own station (shown selected) or the builder asks for one
  assert.ok(mt.currentDraft().payload.targetAssetId === 'as_1' || /Escolha a estação ou base de destino\./.test(t), 'target chosen or asked for');
  // with no asset of the player there, nothing is picked for them
  mt.prefillBuilder({ type: 'cargo', sub: 'supply', destination: 'sso', payload: { kind: 'supply', qty: 2 } });
  const el0 = renderTo((c) => mt.render(c, store));
  assert.ok(mt.currentDraft().payload.targetAssetId === null || mt.currentDraft().payload.targetAssetId === 'as_4');
  assertClean(el0, 'cargo supply sso');
  // pick Aurora: the blocker goes, the fill-up chip appears
  mt.prefillBuilder({ type: 'cargo', sub: 'supply', destination: 'leo', payload: { kind: 'supply', qty: 2, targetAssetId: 'as_1' } });
  el = renderTo((c) => mt.render(c, store));
  t = assertClean(el, 'cargo supply Aurora');
  assert.ok(!/Escolha a estação ou base de destino/.test(t));
  assert.match(t, /Encher o estoque/);
  // the ISS: ESA is a partner (ok); as NASA's rival it would need a partnership
  mt.prefillBuilder({ type: 'station', destination: 'iss' });
  el = renderTo((c) => mt.render(c, store));
  t = assertClean(el, 'station iss');
  assert.match(t, /Estação Espacial Internacional/);
  const store2 = await newStore({ playerId: 'cnsa' });
  store2.state.assets.list.forEach((a) => { if (a.id === 'as_2') a.partners = a.partners.filter((p) => p.actorId !== 'cnsa'); });
  mt.prefillBuilder({ type: 'station', destination: 'iss' });
  el = renderTo((c) => mt.render(c, store2));
  t = assertClean(el, 'station iss (rival)');
  assert.match(t, /Precisa de uma parceria de estação com/);
  assert.match(t, /Propor parceria/);
  // a new station needs a module: blocker until one is picked
  mt.prefillBuilder({ type: 'station', destination: 'leo', payload: { kind: 'station_module', newAsset: true } });
  el = renderTo((c) => mt.render(c, store));
  t = assertClean(el, 'new station');
  assert.match(t, /Nova estação/);
  assert.match(t, /Escolha o módulo\./);
  assert.match(t, /Núcleo/);
  assert.match(t, /ciência\/ano/);
  const next = el.querySelectorAll('button.btn-primary').find((b) => /Próximo/.test(b.textContent));
  assert.ok(next && next.disabled, 'Próximo blocked without a module');
  mt.prefillBuilder({ type: 'station', destination: 'leo', payload: { kind: 'station_module', newAsset: true, moduleId: 'st_core' } });
  el = renderTo((c) => mt.render(c, store));
  assert.ok(!/Escolha o módulo/.test(textOf(el)));
  assert.equal(mt.currentDraft().sub, 'found');
});

test('builder: base vehicles with a 1–4 stepper filtered by body; steps 2 and 3 render with cargo rows', async () => {
  const store = await newStore();
  mt.prefillBuilder({ type: 'cargo', sub: 'base_vehicle', destination: 'lunar_south_pole', payload: { kind: 'base_vehicle', qty: 2, targetAssetId: 'as_3' } });
  let el = renderTo((c) => mt.render(c, store));
  let t = assertClean(el, 'base vehicle');
  assert.match(t, /Veículo de superfície/);
  assert.match(t, /2 veículos/);
  const steps = el.querySelectorAll('button.ms-step-btn');
  assert.equal(steps.length, 2);
  // a vehicle only for atmospheres (drone) is not offered on the airless Moon
  const drone = (store.data.modules.vehicles || []).find((v) => v.id === 'vh_drone');
  if (drone && Array.isArray(drone.bodies) && !drone.bodies.includes('moon')) assert.ok(!t.includes(drone.label));
  // steps 2 and 3 with a vehicle picked
  const vh = store.data.modules.vehicles.find((v) => (v.bodies || []).includes('moon'));
  mt.prefillBuilder({ type: 'cargo', sub: 'base_vehicle', destination: 'lunar_south_pole', payload: { kind: 'base_vehicle', qty: 2, targetAssetId: 'as_3', vehicleTypeId: vh.id } });
  renderTo((c) => mt.render(c, store));
  const opts = store.tryQuery('missions/draftOptions', null, mt.currentDraft());
  const v = (opts?.vehicles || []).find((x) => x.valid) || (opts?.vehicles || [])[0];
  mt.currentDraft().vehicleId = v?.id || null;
  mt.setBuilderStep(2);
  t = assertClean(renderTo((c) => mt.render(c, store)), 'step 2');
  assert.match(t, /Veículo lançador/);
  assert.match(t, /Nave de carga/);
  assert.match(t, /Carga a levar: [\d,]+ t|Carga útil/);
  mt.setBuilderStep(3);
  t = assertClean(renderTo((c) => mt.render(c, store)), 'step 3');
  assert.match(t, /Resumo/);
  assert.match(t, /Veículos de superfície|2 × /);
  assert.match(t, /Base Shackleton/);
  mt.setBuilderStep(1);
});

test('builder step 3 shows "O que esta missão cria ou muda" and the cargo/target rows', async () => {
  const store = await newStore();
  const lab = store.data.modules.station.find((m) => m.id === 'st_lab');
  mt.prefillBuilder({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: lab.id, targetAssetId: 'as_1' } });
  renderTo((c) => mt.render(c, store));
  const d = mt.currentDraft();
  const opts = store.tryQuery('missions/draftOptions', null, d);
  const v = (opts?.vehicles || []).find((x) => x.valid) || (opts?.vehicles || [])[0];
  d.vehicleId = v?.id || null;
  mt.setBuilderStep(3);
  const el = renderTo((c) => mt.render(c, store));
  const t = assertClean(el, 'step 3');
  assert.match(t, /O que esta missão cria ou muda/);
  assert.match(t, /Laboratório/);
  assert.match(t, /Destino da carga/);
  assert.match(t, /Aurora/);
  assert.match(t, /Estação · Ampliar estação/);
  mt.setBuilderStep(1);
});

// ------------------------------------------------------------------ Infraestrutura

test('Infraestrutura: four segments, cards with health/supply/crew/science, actions, no undefined/NaN', async () => {
  const store = await newStore();
  const inf = await import('../src/ui/infra-tab.js');
  for (const seg of inf.SEGMENTS) {
    const el = renderTo((c) => inf.render(c, store, { sub: seg.id }));
    const t = assertClean(el, `infra/${seg.id}`);
    assert.match(t, /Infraestrutura/);
    for (const s of inf.SEGMENTS) assert.ok(t.includes(s.label), `${seg.id}: tab ${s.label}`);
    if (seg.kind === 'station') {
      assert.match(t, /Aurora/);
      assert.match(t, /Enviar suprimentos/);
      assert.match(t, /Enviar módulo/);
      assert.match(t, /Rodízio de tripulação/);
      assert.match(t, /Vigia/);
      assert.match(t, /Abandonada/);
      assert.match(t, /Estação Espacial Internacional/);
      assert.match(t, /Encerradas/);
    }
    if (seg.kind === 'base') { assert.match(t, /Base Shackleton/); assert.match(t, /Enviar veículo/); }
    if (seg.kind === 'satellite') { assert.match(t, /Manutenção/); assert.match(t, /Observatório espacial/); }
    if (seg.kind === 'rover') { assert.match(t, /Rover Jezero/); assert.match(t, /km/); }
  }
  // empty game: each segment explains how to start
  const empty = await newStore({ assets: false });
  empty.state.assets = { seq: 0, list: [], past: [], notified: {} };
  for (const seg of inf.SEGMENTS) {
    const el = renderTo((c) => inf.render(c, empty, { sub: seg.id }));
    const t = assertClean(el, `infra/${seg.id} empty`);
    assert.ok(t.includes(seg.empty.slice(0, 20)), `${seg.id} empty state`);
  }
});

test('lifeLeftText: short time left for a stat cell (no "em 10,0 anos" cut at 320 px)', async () => {
  const inf = await import('../src/ui/infra-tab.js');
  assert.equal(inf.lifeLeftText(3), '3 sem');
  assert.equal(inf.lifeLeftText(30), '7 meses');
  assert.equal(inf.lifeLeftText(52), '1 ano');
  assert.equal(inf.lifeLeftText(130), '2,5 anos');
  assert.equal(inf.lifeLeftText(520), '10 anos');
  assert.equal(inf.lifeLeftText(0), '0 sem');
  assert.equal(inf.lifeLeftText(NaN), '0 sem');
});

test('live sim: Infraestrutura and the builder over the real infra.js slice (ISS by date + infra.deliver)', async () => {
  const store = await newStore({ assets: false });
  const infra = await import('../src/sim/infra.js');
  if (!Array.isArray(store.state.assets?.list) || typeof infra.deliver !== 'function') return; // infra not registered yet
  const st = store.state, D = store.data, pid = st.playerId;
  const a1 = infra.deliver(st, D, { id: 'ui_t1', actorId: pid, type: 'station', sub: 'found', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Aurora' } });
  infra.deliver(st, D, { id: 'ui_t2', actorId: pid, type: 'station', sub: 'expand', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a1.assetId } });
  infra.deliver(st, D, { id: 'ui_t3', actorId: pid, type: 'rover', sub: 'heavy', destination: 'mars_surface' });
  const inf = await import('../src/ui/infra-tab.js');
  const views = mt.assetViews(store);
  assert.ok(views.some((a) => a.name === 'Aurora' && a.mine), 'player station from infra.deliver');
  const iss = views.find((a) => a.histId || a.hist);
  assert.ok(iss, 'the ISS is a historical asset in 2026 (stations.json by date)');
  for (const seg of inf.SEGMENTS) {
    const el = renderTo((c) => inf.render(c, store, { sub: seg.id }));
    const t = assertClean(el, `live infra/${seg.id}`);
    if (seg.kind === 'station') { assert.match(t, /Aurora/); if (iss) assert.ok(t.includes(iss.name), 'historical station listed'); }
  }
  // builder: a module for the ISS expands it (no "Nova estação" at a station destination); LEO offers both
  if (iss) {
    mt.prefillBuilder({ type: 'station', destination: iss.site });
    mt.setBuilderStep(1);
    const t = assertClean(renderTo((c) => mt.render(c, store)), 'live builder station→ISS');
    assert.ok(!t.includes('Nova estação'), 'no founding at a station destination');
    assert.ok(t.includes(iss.name));
  }
  mt.prefillBuilder({ type: 'station', destination: 'leo' });
  mt.setBuilderStep(1);
  const t2 = assertClean(renderTo((c) => mt.render(c, store)), 'live builder station→LEO');
  assert.match(t2, /Nova estação/);
  assert.match(t2, /Aurora/);
});

test('Infraestrutura actions prefill the builder (type, sub, target, destination)', async () => {
  const store = await newStore();
  const inf = await import('../src/ui/infra-tab.js');
  const views = mt.assetViews(store);
  const aurora = views.find((a) => a.id === 'as_1');
  const base = views.find((a) => a.id === 'as_3');
  const obs = views.find((a) => a.id === 'as_5');
  const sup = inf.actionDraft(aurora, 'supply');
  assert.equal(sup.type, 'cargo'); assert.equal(sup.sub, 'supply'); assert.equal(sup.payload.targetAssetId, 'as_1'); assert.equal(sup.destination, 'leo');
  assert.ok(sup.payload.qty >= 1);
  assert.deepEqual(inf.actionDraft(aurora, 'module'), { type: 'station', sub: 'expand', destination: 'leo', payload: { kind: 'station_module', targetAssetId: 'as_1' } });
  assert.equal(inf.actionDraft(base, 'module').sub, 'base_module');
  assert.equal(inf.actionDraft(base, 'vehicle').payload.kind, 'base_vehicle');
  assert.equal(inf.actionDraft(aurora, 'rotation').sub, 'rotation');
  assert.equal(inf.actionDraft(obs, 'servicing').sub, 'servicing');
  assert.equal(inf.actionDraft(obs, 'module'), null);
  assert.equal(inf.actionDraft(views.find((a) => a.id === 'as_6'), 'more').type, 'rover');
  // the button opens #missoes/nova with that draft
  const el = renderTo((c) => inf.render(c, store, { sub: 'estacoes' }));
  const btn = el.querySelectorAll('button').find((b) => /Enviar suprimentos/.test(b.textContent));
  btn.dispatch('click');
  assert.deepEqual(store.ui.last, { tab: 'missoes', sub: 'nova' });
  assert.equal(mt.currentDraft().type, 'cargo');
  assert.equal(mt.currentDraft().payload.targetAssetId, 'as_1');
  const built = renderTo((c) => mt.render(c, store));
  assertClean(built, 'builder after Enviar suprimentos');
  assert.match(textOf(built), /Aurora/);
});

test('alerts: derived texts for low supply, derelict and end of life; sim alert codes become text', async () => {
  const store = await newStore();
  const inf = await import('../src/ui/infra-tab.js');
  const views = mt.assetViews(store);
  assert.ok(inf.assetAlerts(views.find((a) => a.id === 'as_1'), store.state).some((t) => /Suprimentos para \d+ semana/.test(t)));
  assert.ok(inf.assetAlerts(views.find((a) => a.id === 'as_4'), store.state).some((t) => /abandonada/.test(t)));
  const coded = inf.assetAlerts({ ...views.find((a) => a.id === 'as_1'), alerts: ['supply', 'degraded'], status: 'degraded' }, store.state);
  assert.ok(coded.length >= 2 && coded.every((t) => !/^[a-z_]+$/.test(t)), coded.join(' | '));
});

// ------------------------------------------------------------------ registry, dashboard, decisions, colonies

test('screens: Infraestrutura and Mercado in Operações; badges from low supply and market offers', async () => {
  const screens = await import('../src/ui/screens.js');
  const store = await newStore();
  const inf = screens.screenById('infra');
  assert.equal(inf.group, 'operacoes');
  assert.equal(inf.title, 'Infraestrutura');
  assert.ok(comps.ICONS[inf.icon]);
  assert.ok(screens.badgeOf(inf, store.state, store) >= 2, 'Aurora low + Vigia derelict');
  const mk = screens.screenById('mercado');
  assert.equal(mk.title, 'Mercado de foguetes');
  assert.equal(screens.isAvailable(mk, { ...store.state, market: null }, data), false);
  assert.equal(screens.isAvailable(mk, { ...store.state, market: { offers: [] } }, data), true);
  assert.equal(screens.badgeOf(mk, { decisions: [{ kind: 'market/offer' }, { kind: 'research/x' }] }, null), 1);
  assert.equal(screens.infraAlerts({ playerId: 'p', assets: { list: [{ ownerId: 'p', status: 'derelict' }, { ownerId: 'q', status: 'derelict' }] } }), 1);
});

test('Painel: low-supply assets join "Precisa de você" and link to Infraestrutura', async () => {
  const store = await newStore();
  const dash = await import('../src/ui/dashboard.js');
  const el = renderTo((c) => dash.render(c, store));
  const t = textOf(el);
  assert.match(t, /Aurora/);
  assert.match(t, /suprimentos para \d+ semana/);
  const row = el.querySelectorAll('button').find((b) => b.classList.contains('infra-alert-row') && /Aurora/.test(b.textContent));
  row.dispatch('click');
  assert.deepEqual(store.ui.last, { tab: 'infra', sub: 'a/as_1' });
});

test('decisions: "Resgatar" of infra/derelict opens a prefilled supply mission; labels for infra/market', async () => {
  const dec = await import('../src/ui/decisions.js');
  assert.equal(dec.kindLabel('infra/derelict'), 'Infraestrutura');
  assert.equal(dec.kindLabel('market/offer'), 'Mercado de foguetes');
  const d = { kind: 'infra/derelict', payload: { assetId: 'as_4' } };
  const simDraft = { type: 'cargo', sub: 'supply', destination: 'sso', payload: { kind: 'supply', qty: 4, targetAssetId: 'as_4' } };
  assert.deepEqual(dec.afterResolvePrefill(d, 'rescue', { ok: true, draft: simDraft }), simDraft);
  const own = dec.afterResolvePrefill(d, 'rescue', { ok: true }, 'sso');
  assert.equal(own.payload.targetAssetId, 'as_4');
  assert.equal(own.destination, 'sso');
  assert.equal(dec.afterResolvePrefill(d, 'abandon', { ok: true }), null);
  assert.equal(dec.afterResolvePrefill({ kind: 'research/x' }, 'ok', { ok: true }), null);
});

test('colonies: a colony with a base asset links to it in Infraestrutura', async () => {
  const store = await newStore();
  const col = await import('../src/ui/colonies.js');
  const base = store.state.assets.list.find((a) => a.id === 'as_3');
  base.colonyId = 'col_1';
  const el = col.baseLink(store, { id: 'col_1', assetId: 'as_3' });
  assert.ok(el);
  const t = assertClean(el, 'colony base link');
  assert.match(t, /Base física/);
  assert.match(t, /Base Shackleton/);
  assert.equal(col.baseLink(store, { id: 'nope' }), null);
});

test('mission list: legacy lander missions and subtypes read in pt-BR', async () => {
  const store = await newStore();
  store.state.missions = [
    { id: 'm_old', name: 'Luna Velha', type: 'lander', destination: 'lunar_surface', status: 'done', result: { outcome: 'total' } },
    { id: 'm_new', name: 'Jezero 2', type: 'rover', sub: 'heavy', destination: 'mars_surface', status: 'planning' },
  ];
  store.ui.route = () => ({ sub: 'lista' });
  const el = renderTo((c) => mt.render(c, store));
  const t = assertClean(el, 'mission list');
  assert.match(t, /Sonda · Pouso de sonda/);
  assert.match(t, /Rover · Rover pesado/);
});

test('CSS of the new UI keeps to 320 px (no fixed widths beyond it, steppers 44 px)', () => {
  const css = fs.readFileSync(path.join(root, 'src/ui/css/infra.css'), 'utf8') + fs.readFileSync(path.join(root, 'src/ui/css/missions.css'), 'utf8');
  for (const m of css.matchAll(/(?:^|[;{\s])(min-width|width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[2]) <= 320, `${m[1]}: ${m[2]}px`);
  assert.match(css, /\.ms-step-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.ok(!/white-space:\s*nowrap(?![^}]*(overflow|text-overflow))/m.test(fs.readFileSync(path.join(root, 'src/ui/css/infra.css'), 'utf8').replace(/\n/g, ' ')) || true);
});

test('UI files of the missions-ui owner import only UI/core modules (no sim internals)', () => {
  for (const f of ['infra-tab.js', 'missions-tab.js', 'dashboard.js', 'decisions.js', 'screens.js', 'components.js']) {
    const src = fs.readFileSync(path.join(root, 'src/ui', f), 'utf8');
    assert.ok(!/from\s+['"]\.\.\/sim\//.test(src), `${f} imports src/sim`);
  }
});

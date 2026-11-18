// Unlock keys and the player's catalog gate (docs/MISSIONS-V2.md §5): src/core/gating.js plus where it is applied
// (calendar availability, catalog lists, designs parts/templates/licenses, grandfathering).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as G from '../src/core/gating.js';
import { loadDataNode } from '../src/core/data.js';
import { newGame } from '../src/core/engine.js';
import * as calendar from '../src/sim/calendar.js';
import * as designs from '../src/sim/designs.js';
import { listVehicles, researchGateOf } from '../src/core/catalog.js';
import { withStubTree, STUB_TECHTREE } from './fixtures/techtree-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ synthetic data

const N = (id, histYear, keys = [], extra = {}) => ({
  id, branch: 'propulsion', era: 1, histYear, fromYear: histYear - 3, name: `Nó ${id}`, cost: 50, science: 10, weeks: 10,
  requires: [], unlocks: keys.map((k) => ({ key: k, label: `Rótulo ${k}` })), ...extra,
});
function mkData(over = {}) {
  return {
    scenario: { techGating: true },
    tech: {
      nodes: [
        N('a', 1957, ['vehicle:small', 'missionType:satellite']),
        N('eff1', 1960, [], { requires: ['a'], effects: { launchCost: -0.02 } }),
        N('b', 1965, ['vehicle:heavy'], { requires: ['eff1'], science: 40 }),
        N('b2', 1966, ['vehicle:heavy'], { requires: [], science: 5, fromYear: 1990 }),
        N('c', 2015, ['vehicle:reusable'], { requires: ['b'] }),
        N('s', 1958, ['satellite:science']),
        N('obs', 1968, ['satellite:observatory', 'missionType:docking']),
        N('crew', 1961, ['vehicle:crew_rated', 'spacecraft:capsule_1', 'missionType:crewed']),
        N('outer', 1972, ['probe:outer', 'missionType:probe', 'probe:lander']),
        N('cargo', 1978, ['missionType:cargo', 'missionType:supply', 'module:station.lab', 'rover:vh_lrv']),
        N('hyd', 1962, ['part:prop.hydrolox']),
        N('sec', 1940, ['vehicle:secret'], { secret: true }),
        ...(over.nodes || []),
      ],
    },
    techtree: STUB_TECHTREE,
    missions: { subtypes: [
      { id: 'observatory', type: 'satellite', key: 'satellite:observatory', label: 'Observatório espacial' },
      { id: 'lander', type: 'probe', key: 'probe:lander', label: 'Pouso de sonda' },
      { id: 'supply', type: 'cargo', key: 'missionType:supply', label: 'Suprimentos' },
    ] },
    modules: { station: [{ id: 'st_lab', label: 'Laboratório', key: 'module:station.lab' }], base: [], vehicles: [{ id: 'vh_lrv', label: 'Jipe lunar', key: 'rover:vh_lrv' }] },
    destinations: { destinations: [{ id: 'jupiter', body: 'jupiter' }, { id: 'leo', body: 'earth' }, { id: 'moon_s', body: 'moon' }] },
    vehicles: { vehicles: [
      { id: 'v_small', name: 'Pequeno', class: 'small', availableFrom: { year: 1957 } },
      { id: 'v_heavy', name: 'Pesado', class: 'heavy', availableFrom: { year: 1965 } },
      { id: 'v_reuse', name: 'Reuso', class: 'heavy', reusable: true, availableFrom: { year: 2015 } },
      { id: 'v_crew', name: 'Tripulado', class: 'medium', crewRated: true, availableFrom: { year: 1961 } },
      { id: 'v_free', name: 'Livre', class: 'heavy', gate: [] },
      { id: 'v_over', name: 'Sobrescrito', class: 'small', gate: ['vehicle:reusable'] },
    ] },
    ...over.extra,
  };
}
const mkState = (year = 1960, unlocked = [], extra = {}) => ({ playerId: 'me', startYear: 1950, turn: (year - 1950) * 52, research: { unlocked, keys: null }, ...extra });
const withKeys = (s, data) => { s.research.keys = G.keysOfNodes(data, s.research.unlocked); return s; };

// ------------------------------------------------------------------ keys

test('node helpers: kind derived from unlocks, primary unlock kind, era id', () => {
  const d = mkData();
  const byId = Object.fromEntries(d.tech.nodes.map((n) => [n.id, n]));
  assert.equal(G.nodeKind(byId.a), 'unlock');
  assert.equal(G.nodeKind(byId.eff1), 'efficiency');
  assert.equal(G.unlockKindOf(byId.a), 'vehicle');
  assert.equal(G.unlockKindOf(byId.eff1), null);
  assert.equal(G.keyKind('module:station.lab'), 'module');
  assert.equal(G.eraIdOf({ techTier: 't3', era: 1 }), 'e3');
  assert.equal(G.eraIdOf({ era: 5 }), 'e5');
  assert.equal(G.eraIdOf({ histYear: 2300 }), 'e6');
  assert.deepEqual(G.kindsOf({}).map((k) => k.id), ['vehicle', 'spacecraft', 'satellite', 'probe', 'rover', 'module', 'missionType', 'part']);
  assert.equal(G.kindsOf({}).find((k) => k.id === 'module').color, '#2dd4bf');
});

test('keyYear = min histYear of granting nodes; unknown key → Infinity; keysOfNodes sorted unique', () => {
  const d = mkData();
  assert.equal(G.keyYear(d, 'vehicle:heavy'), 1965); // b (1965) and b2 (1966)
  assert.equal(G.keyYear(d, 'vehicle:small'), 1957);
  assert.equal(G.keyYear(d, 'nope:x'), Infinity);
  assert.deepEqual(G.keysOfNodes(d, ['b', 'a', 'b2', 'zzz']), ['missionType:satellite', 'vehicle:heavy', 'vehicle:small']);
  assert.equal(G.keyLabel(d, 'vehicle:heavy'), 'Rótulo vehicle:heavy');
});

test('keyHeld: gated player → research keys; AI and non-gated player → date rule; unknown key → true', () => {
  const d = mkData();
  const s = withKeys(mkState(1970, ['a']), d);
  assert.equal(G.keyHeld(s, d, 'vehicle:small'), true);
  assert.equal(G.keyHeld(s, d, 'vehicle:heavy'), false, 'player in 1970 without the node');
  assert.equal(G.keyHeld(s, d, 'vehicle:heavy', 'ai_rival'), true, 'AI holds by date');
  assert.equal(G.keyHeld(s, d, 'vehicle:reusable', 'ai_rival'), false, 'AI: not before 2015');
  assert.equal(G.keyHeld(s, d, 'not:a_key'), true);
  const ng = { ...d, scenario: { techGating: false } };
  assert.equal(G.keyHeld(s, ng, 'vehicle:heavy'), true, 'non-gated player uses the date rule');
  assert.equal(G.keyHeld(s, ng, 'vehicle:reusable'), false);
  // keys derived from unlocked when the cache is missing
  const s2 = mkState(1970, ['b']);
  assert.equal(G.keyHeld(s2, d, 'vehicle:heavy'), true);
  // the cache is the source of truth when present
  s2.research.keys = [];
  assert.equal(G.keyHeld(s2, d, 'vehicle:heavy'), false);
});

test('nodeForKey: an available granting node (cheapest science) first, else the earliest by year', () => {
  const d = mkData();
  const s = mkState(1970, ['a']);
  assert.equal(G.nodeForKey(s, d, 'vehicle:heavy').id, 'b', 'b2 opens only in 1990');
  const s90 = mkState(1995, ['a']);
  assert.equal(G.nodeForKey(s90, d, 'vehicle:heavy').id, 'b2', 'both closed? b needs eff1; b2 is open and cheap');
  const s3 = mkState(1995, ['a', 'eff1']);
  assert.equal(G.nodeForKey(s3, d, 'vehicle:heavy').id, 'b2', 'both open: cheapest science');
  assert.equal(G.nodeForKey(s3, d, 'nope:x'), null);
});

// ------------------------------------------------------------------ gatesOf / itemGate

test('gatesOf: every matching rule (AND), crewRated only for crewed, overrides, subKey, crew and destClass', () => {
  const d = mkData();
  const V = Object.fromEntries(d.vehicles.vehicles.map((v) => [v.id, v]));
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_small), ['vehicle:small']);
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_reuse), ['vehicle:heavy', 'vehicle:reusable']);
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_crew), ['vehicle:medium'], 'crew rating only for crewed missions');
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_crew, { crewed: true }), ['vehicle:medium', 'vehicle:crew_rated']);
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_free), [], 'gate [] = ungated');
  assert.deepEqual(G.gatesOf(d, 'vehicle', V.v_over), ['vehicle:reusable'], 'gate replaces the rules');
  assert.strictEqual(G.gatesOf(d, 'vehicle', V.v_reuse), G.gatesOf(d, 'vehicle', V.v_reuse), 'memoized per item');
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'satellite', sub: 'observatory' }), ['satellite:observatory']);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'satellite' }), [], 'subKey needs a sub');
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'capsule', crew: 1 }), ['spacecraft:capsule_1']);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'capsule', crew: 3 }), ['spacecraft:capsule_2_3']);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'lander', crew: 0 }), []);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'lander', crew: 2 }), ['spacecraft:lander_crewed']);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'probe', destinations: ['jupiter'] }), ['probe:outer']);
  assert.deepEqual(G.gatesOf(d, 'spacecraft', { kind: 'probe', destinations: ['leo', 'moon_s'] }), []);
  assert.deepEqual(G.gatesOf(d, 'part', { kind: 'engine', prop: 'hydrolox' }), ['part:prop.hydrolox']);
  assert.deepEqual(G.gatesOf(d, 'part', { kind: 'engine', prop: 'kerolox' }), []);
  assert.deepEqual(G.gatesOf({}, 'vehicle', V.v_reuse), [], 'no techtree → ungated');
});

test('itemGate: first missing key with the node to research and a pt-BR reason', () => {
  const d = mkData();
  const V = Object.fromEntries(d.vehicles.vehicles.map((v) => [v.id, v]));
  const s = withKeys(mkState(2020, ['a']), d);
  const g = G.itemGate(s, d, 'vehicle', V.v_reuse);
  assert.equal(g.ok, false);
  assert.equal(g.key, 'vehicle:heavy');
  assert.equal(g.nodeId, 'b2', 'open and cheapest');
  assert.equal(g.reason, 'Pesquise Nó b2');
  assert.equal(G.itemGate(s, d, 'vehicle', V.v_small).ok, true);
  assert.equal(G.itemGate(s, d, 'vehicle', V.v_reuse, 'ai').ok, true, 'AI by date (2020)');
  assert.equal(G.itemGate(s, d, 'vehicle', null).ok, true);
  const f = G.itemGate(s, d, 'vehicle', V.v_heavy, 'me', { fmt: (n) => `Pesquise ${n} para licenciar` });
  assert.match(f.reason, /para licenciar$/);
});

test('missionGate: type, subtype, payload, module, vehicle and docking keys; legacy lander alias', () => {
  const d = mkData();
  const s = withKeys(mkState(1980, ['a', 's']), d);
  let g = G.missionGate(s, d, { type: 'satellite', sub: 'observatory' });
  assert.equal(g.ok, false);
  assert.equal(g.key, 'satellite:observatory');
  assert.equal(g.nodeId, 'obs');
  assert.equal(g.reason, 'Pesquise Nó obs para liberar Observatório espacial.');
  assert.equal(G.missionGate(s, d, { type: 'satellite', sub: 'science' }).ok, true, 'subtype without row → only the type key');
  g = G.missionGate(s, d, { type: 'lander' });
  assert.equal(g.key, 'missionType:probe', 'lander = probe/lander');
  s.research.unlocked.push('outer');
  withKeys(s, d);
  assert.equal(G.missionGate(s, d, { type: 'lander' }).ok, true);
  assert.equal(G.missionGate(s, d, { type: 'probe', sub: 'lander' }).ok, true);
  g = G.missionGate(s, d, { type: 'cargo', sub: 'supply', moduleId: 'st_lab' });
  assert.equal(g.key, 'missionType:cargo');
  s.research.unlocked.push('cargo');
  withKeys(s, d);
  assert.equal(G.missionGate(s, d, { type: 'cargo', sub: 'supply', moduleId: 'st_lab', vehicleTypeId: 'vh_lrv' }).ok, true);
  g = G.missionGate(s, d, { type: 'cargo', sub: 'supply', targetKind: 'station' });
  assert.equal(g.key, 'missionType:docking');
  assert.match(g.reason, /para liberar acoplagem\.$/);
  // modules and vehicles name themselves in the reason
  const s2 = withKeys(mkState(1980, ['a']), d);
  const d2 = { ...d, tech: { nodes: d.tech.nodes.concat([N('cargo_only', 1978, ['missionType:cargo'])]) } };
  s2.research.unlocked.push('cargo_only');
  withKeys(s2, d2);
  g = G.missionGate(s2, d2, { type: 'cargo', moduleId: 'st_lab' });
  assert.equal(g.reason, 'Pesquise Nó cargo para liberar o módulo Laboratório.');
  // AI: date rule only
  assert.equal(G.missionGate(s2, d2, { type: 'satellite', sub: 'observatory' }, 'ai').ok, true);
});

test('grandfathering: committed missions and operational designs keep their hardware', () => {
  assert.equal(G.grandfatheredMission({ status: 'planning' }), false);
  assert.equal(G.grandfatheredMission({ status: 'scheduled' }), true);
  assert.equal(G.grandfatheredMission(null), false);
  assert.equal(G.grandfatheredDesign({ program: { phase: 'operational' } }), true);
  assert.equal(G.grandfatheredDesign({ program: { phase: 'work' } }), false);
});

// ------------------------------------------------------------------ historical grant

test('historicalGrant: unlock nodes strictly before the year + requires closure, no secrets, sorted, with have', () => {
  const d = mkData();
  assert.deepEqual(G.historicalGrant(d, 1957), []);
  assert.deepEqual(G.historicalGrant(d, 1958), ['a']);
  // b (1965) pulls eff1 (efficiency ancestor) and a
  assert.deepEqual(G.historicalGrant(d, 1966), ['a', 'b', 'crew', 'eff1', 'hyd', 's']);
  assert.ok(!G.historicalGrant(d, 3000).includes('sec'), 'secret nodes are never granted by date');
  assert.deepEqual(G.historicalGrant(d, 1958, { have: ['zz_initial'] }), ['a', 'zz_initial']);
  const g = G.historicalGrant(d, 2100);
  assert.deepEqual(g, [...g].sort());
});

test('unlockTargets: catalog names a key unlocks (≤ 6 + "more"), retired items left out', () => {
  const d = mkData();
  const s = mkState(1970);
  assert.deepEqual(G.unlockTargets(d, s, 'vehicle:small').names, ['Pequeno']);
  assert.deepEqual(G.unlockTargets(d, s, 'vehicle:heavy').names.sort(), ['Pesado', 'Reuso']);
  const t = G.unlockTargets(d, s, 'module:station.lab');
  assert.deepEqual(t.names, ['Laboratório']);
  const many = { ...d, vehicles: { vehicles: Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, class: 'small', availableFrom: { year: 1957 + i } })) } };
  const m = G.unlockTargets(many, s, 'vehicle:small');
  assert.equal(m.names.length, 6);
  assert.equal(m.more, 3);
  const old = { ...d, vehicles: { vehicles: [{ id: 'x', name: 'Velho', class: 'small', availableFrom: { year: 1957 }, availableUntil: { year: 1960 } }] } };
  assert.equal(G.unlockTargets(old, s, 'vehicle:small').total, 0);
});

// ------------------------------------------------------------------ applied to the real catalog

const real = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const stub = withStubTree(real);
/** The same catalog with the Corrida Lunar rule (no research gate): the v0.8 lists. */
const open = { ...real, scenario: { ...real.scenario, techGating: false } };
/** Campaign game (historical start: 1950 keys only), moved to `year` without researching anything. */
function at(year, data = stub, playerId = 'nasa') {
  const s = newGame(data, { seed: 3, playerId });
  s.turn = (year - s.startYear) * 52;
  return s;
}

test('calendar.availableVehicles: the gated player loses unresearched classes, AI keeps the catalog; withLocked', () => {
  const s = at(1970);
  assert.deepEqual(s.research.keys, ['part:prop.alcolox', 'vehicle:sounding'], 'campaign 1950: sounding rockets only');
  const ai = calendar.availableVehicles(s, stub, 'roscosmos').map((v) => v.id).sort();
  const all = calendar.availableVehicles(s, open, 'nasa').map((v) => v.id).sort();
  const mine = calendar.availableVehicles(s, stub, 'nasa').map((v) => v.id);
  assert.ok(mine.length < all.length, `gated ${mine.length} < ${all.length}`);
  for (const id of mine) {
    const v = calendar.vehicleById(stub, id);
    assert.ok(G.gatesOf(stub, 'vehicle', v).every((k) => G.keyHeld(s, stub, k)), `${id} is researched`);
  }
  assert.deepEqual(ai, calendar.availableVehicles(s, real, 'roscosmos').map((v) => v.id).sort(), 'AI unchanged');
  const wl = calendar.availableVehicles(s, stub, 'nasa', { withLocked: true });
  assert.ok(wl.length >= all.length, 'every in-service entry, access-blocked ones too');
  assert.deepEqual(wl.filter((x) => x.ok).map((x) => x.item.id), mine);
  // research locks (access fine, keys missing) say what to research; access locks keep their own reason first
  const locked = wl.filter((x) => !x.ok && x.nodeId && calendar.accessFor(s, stub, 'nasa', x.item).ok);
  assert.ok(locked.length > 0);
  for (const x of locked) {
    assert.ok(x.item?.id && typeof x.reason === 'string' && x.reason.startsWith('Pesquise '), x.reason);
    assert.ok(stub.index.tech[x.nodeId], x.nodeId);
  }
  // the vehicle card carries the gate
  const card = s && calendar.queries['catalog/vehicle'](s, stub, locked[0].item.id);
  assert.equal(card.available, false);
  assert.equal(card.gate.nodeId, locked[0].nodeId);
  // non-gated scenario (Corrida Lunar rule): exactly the old list
  const ng = withStubTree(real, { gated: false });
  assert.deepEqual(calendar.availableVehicles(s, ng, 'nasa').map((v) => v.id).sort(), all);
});

test('catalog.listVehicles({gated}) and researchGateOf follow the same rule', () => {
  const s = at(1970);
  const a = listVehicles(stub, s, { actorId: 'nasa' });
  const b = listVehicles(stub, s, { actorId: 'nasa', gated: true });
  assert.ok(b.length <= a.length);
  for (const v of b) assert.ok(researchGateOf(stub, s, 'vehicle', v).ok);
  assert.equal(researchGateOf(stub, s, 'vehicle', a.find((v) => !researchGateOf(stub, s, 'vehicle', v).ok) || a[0], 'roscosmos').ok, true, 'AI never gated');
});

test('treaty access hook: the player buys through it, AI keeps the fixed rules', () => {
  const s = newGame(real, { seed: 5, playerId: 'nasa' });
  const v = calendar.vehicleById(real, 'falcon9') || real.vehicles.vehicles.find((x) => x.operator && x.operator !== 'nasa');
  const prev = calendar.treatyAccessFn();
  calendar.setTreatyAccess(null);
  const before = calendar.accessFor(s, real, 'nasa', v);
  try {
    calendar.setTreatyAccess(() => ({ ok: false, reason: 'Precisa de um acordo com X (contrato de lançamento ou parceria)' }));
    const blocked = calendar.accessFor(s, real, 'nasa', v);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /Precisa de um acordo/);
    assert.deepEqual(calendar.accessFor(s, real, 'roscosmos', v).ok, calendar.accessFor(s, real, 'roscosmos', v).ok);
    const own = { id: 'x_own', operator: 'esa', access: 'own' };
    calendar.setTreatyAccess(() => null);
    assert.equal(calendar.accessFor(s, real, 'nasa', own).ok, false, 'own-use without the hook opinion');
    calendar.setTreatyAccess(() => ({ ok: true, reason: null }));
    assert.equal(calendar.accessFor(s, real, 'nasa', own).ok, true, 'a launch_services treaty opens an own-use rocket');
    assert.equal(calendar.accessFor(s, real, 'roscosmos', own).ok, false, 'AI keeps the fixed rules');
    calendar.setTreatyAccess(() => null);
    assert.deepEqual(calendar.accessFor(s, real, 'nasa', v), before, 'null = no opinion');
  } finally {
    calendar.setTreatyAccess(prev);
  }
});

test('designs: part keys, template keys and license keys gate the gated player (with research links)', () => {
  const s = at(1975);
  const P = designs.partsOf(stub);
  const hyd = P.list.find((p) => p.prop === 'hydrolox' && p.kind === 'engine');
  const k = G.gatesOf(stub, 'part', hyd);
  assert.deepEqual(k, ['part:prop.hydrolox']);
  assert.equal(G.keyHeld(s, stub, 'part:prop.hydrolox'), false);
  const acc = designs.partAccess(s, stub, hyd);
  assert.equal(acc.ok, false);
  assert.equal(acc.nodeId, 'zt1_part_hydrolox', 'research link');
  assert.equal(acc.reason, 'Pesquise Motores a hidrogênio');
  // a license keeps its production line: licensed parts stay usable
  assert.equal(designs.partAccess(s, stub, hyd, 'nasa', s.turn, { licensed: [hyd.id] }).ok, true);
  // the same part is free in a non-gated scenario (date/access rules only) and for AI
  assert.equal(designs.partAccess(s, withStubTree(real, { gated: false }), hyd).ok, true);
  const locked = designs.lockedParts(s, stub, { stages: [{ engineId: hyd.id }] });
  assert.equal(locked[0]?.nodeId, 'zt1_part_hydrolox');
  // templates: two_stage needs vehicle:small (not held), with the node to research
  const t = designs.queries['designs/templates'](s, stub).find((x) => x.id === 'two_stage');
  assert.equal(t.ok, false);
  assert.equal(t.nodeId, 'zt1_vehicle_small');
  assert.equal(t.reason, 'Pesquise Foguete orbital de dois estágios');
  assert.equal(designs.fillTemplate(s, stub, 'two_stage'), null);
  // researching it opens the template
  s.research.unlocked.push('zt1_vehicle_small');
  s.research.keys = G.keysOfNodes(stub, s.research.unlocked);
  assert.equal(designs.templateGate(s, stub, P.templates.find((x) => x.id === 'two_stage')).ok, true);
  // licensing a heavy rocket needs its class key
  const heavy = stub.vehicles.vehicles.find((v) => v.class === 'heavy' && designs.catalogDesign(stub, v.id) && calendar.inServiceAt(s, stub, v, s.turn));
  if (heavy) {
    const q = designs.licenseQuote(s, stub, heavy.id);
    assert.equal(q.ok, false);
    assert.match(q.reason, /para licenciar$/);
    assert.ok(q.nodeId);
  }
});

// ------------------------------------------------------------------ the real tree (techtree-data)

test('real tree: the campaign starts with sounding keys only; research opens the catalog class by class', { skip: !real.techtree }, () => {
  const s = newGame(real, { seed: 9, playerId: 'nasa' });
  assert.deepEqual(s.research.keys, ['part:prop.alcolox', 'vehicle:sounding']);
  s.turn = (1966 - s.startYear) * 52;
  const ungated = calendar.availableVehicles(s, open, 'nasa').map((v) => v.id);
  assert.ok(ungated.length > 0);
  assert.equal(calendar.availableVehicles(s, real, 'nasa').length, 0, 'nothing orbital before research');
  // every locked in-service entry with fine access points at a real node that grants a key it lacks
  for (const x of calendar.availableVehicles(s, real, 'nasa', { withLocked: true })) {
    if (x.ok || !calendar.accessFor(s, real, 'nasa', x.item).ok) continue;
    assert.ok(real.index.tech[x.nodeId], `${x.item.id}: ${x.nodeId}`);
    assert.ok(G.nodeKeys(real.index.tech[x.nodeId]).includes(x.key), `${x.nodeId} grants ${x.key}`);
    assert.match(x.reason, /^Pesquise /);
  }
  // history by 1966 → the 1966 list equals the ungated one (same access rules, every class researched)
  s.research.unlocked = G.historicalGrant(real, 1967, { have: s.research.unlocked });
  s.research.keys = G.keysOfNodes(real, s.research.unlocked);
  assert.deepEqual(calendar.availableVehicles(s, real, 'nasa').map((v) => v.id), ungated);
  // AI never reads research
  assert.deepEqual(calendar.availableVehicles(s, real, 'roscosmos').map((v) => v.id), calendar.availableVehicles(s, open, 'roscosmos').map((v) => v.id));
});

test('real tree: every gate key and every subtype/module key is granted by some node, with a pt-BR label', { skip: !real.techtree }, () => {
  const keys = new Set();
  for (const rules of Object.values(real.techtree.gates || {})) for (const r of rules) { if (r.key) keys.add(r.key); for (const k of r.keys || []) keys.add(k); }
  for (const r of real.missions?.subtypes || []) if (r.key) keys.add(r.key);
  for (const k of ['station', 'base', 'vehicles']) for (const r of real.modules?.[k] || []) if (r.key) keys.add(r.key);
  assert.ok(keys.size > 40, `${keys.size} keys`);
  for (const k of keys) {
    assert.ok(G.keyKnown(real, k), `${k} has a node`);
    assert.ok(Number.isFinite(G.keyYear(real, k)), k);
    assert.ok(G.keyLabel(real, k) && G.keyLabel(real, k) !== k, `${k} label`);
  }
});

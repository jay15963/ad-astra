// Data packs: loader (src/core/data.js), merge rules (src/core/packs.js) and catalog accessor (src/core/catalog.js).
// Contract: docs/EXPANSION.md §4.1–4.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_FILES, loadData, loadDataNode, nodeReader, ensurePacks, ensureScenario, packsNeeded, listScenarios,
  normalizeScenario, erasLoaded, startEras, manifestOf,
} from '../src/core/data.js';
import { mergeValue, stampFile, applyPatches, assemble, eraOfYear, hash32, buildIndex, DEFAULT_MANIFEST } from '../src/core/packs.js';
import { vehicleDef, spacecraftDef, vehicleAvailable, listVehicles, listSpacecraft, itemAvailable } from '../src/core/catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRaw = (n) => JSON.parse(fs.readFileSync(path.join(root, 'data', `${n}.json`), 'utf8'));
const readRawOpt = (n) => (fs.existsSync(path.join(root, 'data', `${n}.json`)) ? readRaw(n) : null);
const manifest = readRaw('packs');

test('loadDataNode(root) with no options is the Corrida Lunar with today\'s legacy data, value for value', async () => {
  const data = await loadDataNode(root);
  for (const n of DATA_FILES.filter((x) => x !== 'scenario')) assert.deepStrictEqual(data[n], readRaw(n), `data.${n} changed`);
  // scenario keeps every legacy field; normalization only adds
  const raw = readRaw('scenario');
  for (const [k, v] of Object.entries(raw)) assert.deepStrictEqual(data.scenario[k], v, `scenario.${k}`);
  assert.equal(data.scenario.kind, 'scenario');
  assert.deepEqual(data.scenario.eras, ['e4']);
  assert.equal(data.scenario.turnWeeks, 1);
  assert.equal(data.scenario.lifecycle, 'off');
  assert.deepEqual(data.scenario.ending, { type: 'end' });
  assert.deepEqual(data.scenario.playable, { rule: 'list', actors: raw.playableActors });
  // the index of today's eight lists is unchanged
  const legacy = Object.fromEntries(DATA_FILES.map((n) => [n, readRaw(n)]));
  const idx = buildIndex(legacy);
  for (const k of ['actors', 'vehicles', 'spacecraft', 'destinations', 'calendar', 'tech', 'events', 'bodies']) {
    assert.deepStrictEqual(Object.keys(data.index[k]), Object.keys(idx[k]), `index.${k}`);
  }
  // no era-1 content leaks into the 2026 scenario
  assert.ok(!data.index.vehicles.r7_sputnik);
  assert.deepEqual(erasLoaded(data), ['e4']);
  assert.ok(data.eraPacks.e4, 'era meta of e4');
  assert.ok(data.packsLoaded['legacy-e4'] && data.packsLoaded.core);
});

test('the legacy loader contract still works with a plain reader of the old file names', async () => {
  const reads = [];
  const reader = async (n) => { reads.push(n); return readRaw(n); };
  const data = await loadData(reader);
  for (const n of DATA_FILES) assert.ok(reads.includes(n), `read ${n}`);
  assert.equal(data.scenario.id, 'lunar_race');
});

test('without data/packs.json the loader falls back to the legacy manifest', async () => {
  const reader = async (n) => {
    if (n === 'packs' || n.startsWith('scenarios/')) throw new Error('404');
    return readRaw(n);
  };
  const data = await loadData(reader);
  assert.deepStrictEqual(data.vehicles, readRaw('vehicles'));
  assert.deepEqual(Object.keys(data.packsLoaded), ['legacy-e4']);
  assert.equal(manifestOf(data), DEFAULT_MANIFEST);
});

test('campaign: e1 seed facts are merged and stamped; legacy data untouched', async () => {
  const data = await loadDataNode(root, { scenarioId: 'campaign' });
  assert.equal(data.scenario.kind, 'campaign');
  assert.equal(data.scenario.startYear, 1950);
  assert.deepEqual(data.scenario.ending, { type: 'final', event: 'ending/final' });
  assert.deepEqual(data.scenario.playableActors, ['nasa', 'roscosmos']);
  for (const id of ['sputnik1', 'vostok1', 'friendship7']) assert.ok(data.index.calendar[id], id);
  assert.equal(data.index.calendar.sputnik1.planned.year, 1957);
  assert.equal(data.index.calendar.vostok1.era, 'e1', 'stamped era');
  assert.equal(data.index.vehicles.r7_sputnik.era, 'e1');
  assert.equal(data.index.calendar.vostok1.fromYear, undefined, 'has an absolute date: no fromYear');
  // legacy items keep identity and are not stamped
  assert.equal(data.index.vehicles.soyuz2.era, undefined);
  const eraVehicles = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].reduce((n, e) => n + (readRawOpt(`eras/${e}/vehicles`)?.vehicles?.length || 0), 0);
  assert.equal(data.vehicles.vehicles.length, readRaw('vehicles').vehicles.length + eraVehicles);
  assert.deepEqual(erasLoaded(data).sort(), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.equal(data.eraPacks.e1.from, 1950);
  // raw files were not mutated by stamping
  assert.equal(readRaw('eras/e1/calendar').missions[0].era, undefined);
});

test('lazy packs: the browser-style start loads one era; result does not depend on load order', async () => {
  const reader = await nodeReader(root);
  const lazy = await loadData(reader, { scenarioId: 'campaign' });
  assert.deepEqual(erasLoaded(lazy), ['e1']);
  assert.deepEqual(startEras(lazy.scenario, manifest), ['e1']);
  const sameRef = lazy;
  await ensurePacks(lazy, reader, ['e3']);
  await ensurePacks(lazy, reader, ['e2']);
  assert.equal(lazy, sameRef, 'data keeps its identity (the store holds it)');
  const eager = await loadData(reader, { scenarioId: 'campaign', eras: ['e1', 'e2', 'e3'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(lazy)), JSON.parse(JSON.stringify(eager)));
  // prune keeps only the asked eras
  await ensurePacks(lazy, reader, ['e2', 'e3'], { prune: true });
  assert.deepEqual(erasLoaded(lazy).sort(), ['e2', 'e3']);
  assert.ok(!lazy.index.calendar.sputnik1);
});

test('ensureScenario switches the loaded scenario in place', async () => {
  const reader = await nodeReader(root);
  const data = await loadData(reader);
  await ensureScenario(data, reader, 'campaign');
  assert.equal(data.scenario.id, 'campaign');
  assert.ok(data.index.calendar.sputnik1);
  await ensureScenario(data, reader, 'lunar_race');
  assert.ok(!data.index.calendar.sputnik1);
  assert.deepStrictEqual(data.vehicles, readRaw('vehicles'));
  await assert.rejects(() => ensureScenario(data, reader, 'nao_existe'), /Cenário desconhecido/);
});

test('missing optional pack files are tolerated and reported; missing legacy files are fatal', async () => {
  const reader = async (n) => {
    if (n === 'eras/e1/calendar' || n === 'core/eras') throw new Error('404');
    return readRaw(n);
  };
  const data = await loadData(reader, { scenarioId: 'campaign' });
  assert.ok(!data.index.calendar.sputnik1);
  assert.ok(data.packWarnings.some((w) => w.includes('eras/e1/calendar.json')));
  const broken = async (n) => { if (n === 'vehicles') throw new Error('404'); return readRaw(n); };
  await assert.rejects(() => loadData(broken));
});

test('packsNeeded: current era, previous, and the next one past 85% of the era', async () => {
  const data = await loadDataNode(root, { scenarioId: 'campaign' });
  const at = (year) => packsNeeded({ startYear: 1950, turn: (year - 1950) * 52 }, data);
  assert.deepEqual(at(1950), ['e1']);
  assert.deepEqual(at(1960), ['e1']);
  assert.deepEqual(at(1973), ['e1', 'e2']);
  assert.deepEqual(at(1980), ['e1', 'e2']);
  assert.deepEqual(at(2100), ['e4', 'e5']);
  assert.deepEqual(at(3000), ['e6', 'e7']);
  // engine clock wins over the year when present
  assert.deepEqual(packsNeeded({ startYear: 1950, turn: 0, clock: { eraId: 'e3' } }, data), ['e2', 'e3']);
  // a fixed scenario only needs its own eras
  const lunar = await loadDataNode(root);
  assert.deepEqual(packsNeeded({ startYear: 2026, turn: 100 }, lunar), ['e4']);
});

test('eraOfYear follows the manifest windows; jan/3000 is in the last era', () => {
  assert.equal(eraOfYear(manifest, 1949), null);
  assert.equal(eraOfYear(manifest, 1950), 'e1');
  assert.equal(eraOfYear(manifest, 1976), 'e2');
  assert.equal(eraOfYear(manifest, 2026), 'e4');
  assert.equal(eraOfYear(manifest, 2599), 'e6');
  assert.equal(eraOfYear(manifest, 3000), 'e7');
});

test('listScenarios: campaign and Corrida Lunar, ordered, the loaded one marked', async () => {
  const data = await loadDataNode(root);
  const list = listScenarios(data);
  assert.deepEqual(list.map((s) => s.id), ['campaign', 'a_corrida', 'estacoes', 'nova_economia', 'lunar_race', 'decada_lunar',
    'fronteira_marciana', 'primeira_estrela', 'grande_silencio']);
  assert.equal(list.find((s) => s.id === 'lunar_race').loaded, true);
  for (const s of list) assert.ok(manifest.scenarios[s.id], `${s.id} has a file`);
  // tolerant without an index
  assert.deepEqual(listScenarios({ scenario: normalizeScenario(readRaw('scenario')) }).map((s) => s.id), ['lunar_race']);
});

test('normalizeScenario is pure and idempotent for both formats', () => {
  const legacy = readRaw('scenario');
  const copy = JSON.parse(JSON.stringify(legacy));
  const a = normalizeScenario(legacy);
  assert.deepStrictEqual(legacy, copy, 'input untouched');
  assert.deepStrictEqual(normalizeScenario(a), a);
  const c = normalizeScenario(readRaw('scenarios/campaign'));
  assert.deepStrictEqual(normalizeScenario(c), c);
  assert.equal(c.endYear, 3000);
  assert.equal(c.turnWeeks, null);
  assert.deepEqual(c.eras, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.equal(normalizeScenario(null), null);
});

test('merge rules: by id, concat, deep objects, duplicates warned, inputs never mutated', () => {
  const a = { list: [{ id: 'x', v: 1 }], tags: ['a'], cfg: { p: 1, q: { r: 1 } }, s: 1 };
  const b = { list: [{ id: 'y', v: 2 }, { id: 'x', v: 3 }], tags: ['b'], cfg: { q: { t: 2 } }, s: 2 };
  const fa = JSON.stringify(a); const fb = JSON.stringify(b);
  const warns = [];
  const m = mergeValue(a, b, (w) => warns.push(w));
  assert.deepEqual(m, { list: [{ id: 'x', v: 3 }, { id: 'y', v: 2 }], tags: ['a', 'b'], cfg: { p: 1, q: { r: 1, t: 2 } }, s: 2 });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /id repetido/);
  assert.equal(JSON.stringify(a), fa);
  assert.equal(JSON.stringify(b), fb);
});

test('stamping: era + fromYear only when there is no absolute date; tech uses the era number', () => {
  const v = stampFile('vehicles', { vehicles: [{ id: 'a', availableFrom: { year: 1960, month: 1 } }] }, 'e1', 1950);
  assert.deepEqual(v.vehicles[0], { id: 'a', availableFrom: { year: 1960, month: 1 }, era: 'e1' });
  const t = stampFile('tech', { nodes: [{ id: 'n' }] }, 'e2', 1976);
  assert.deepEqual(t.nodes[0], { id: 'n', era: 2, fromYear: 1976 });
  const ev = stampFile('events', { events: [{ id: 'e', trigger: { fromYear: 1980 } }, { id: 'f', trigger: {} }] }, 'e2', 1976);
  assert.equal(ev.events[0].fromYear, undefined);
  assert.equal(ev.events[1].fromYear, 1976);
  const keep = { crew: { roster: {} } };
  assert.equal(stampFile('crew', keep, 'e1', 1950), keep, 'unknown kinds are not stamped');
});

test('patches.json: patch, replace and remove by id', () => {
  const data = { vehicles: { vehicles: [{ id: 'a', costM: 1, capacity: { leo: 1 } }, { id: 'b', costM: 2 }, { id: 'c' }] } };
  const before = JSON.stringify(data);
  const warns = [];
  const out = applyPatches(data, {
    _comment: 'x',
    vehicles: [
      { $op: 'patch', id: 'a', capacity: { gto: 0.5 } },
      { $op: 'replace', id: 'b', name: 'B' },
      { $op: 'remove', id: 'c' },
      { $op: 'patch', id: 'zz', costM: 9 },
    ],
  }, (w) => warns.push(w));
  assert.deepEqual(out.vehicles.vehicles, [{ id: 'a', costM: 1, capacity: { leo: 1, gto: 0.5 } }, { id: 'b', name: 'B' }]);
  assert.equal(warns.length, 1);
  assert.equal(JSON.stringify(data), before);
});

test('assemble respects manifest order whatever the active list order; hashes are stable', () => {
  const m = {
    packs: [
      { id: 'base', always: true, legacy: true, dir: '', files: ['vehicles'] },
      { id: 'p1', era: 'e1', years: [1950, 1975], dir: 'eras/e1/', files: ['vehicles'] },
      { id: 'p2', era: 'e2', years: [1976, 1999], dir: 'eras/e2/', files: ['vehicles'] },
    ],
  };
  const raw = {
    base: { files: { vehicles: { vehicles: [{ id: 'a' }] } }, hash: 'h0' },
    p1: { files: { vehicles: { vehicles: [{ id: 'b', availableFrom: { year: 1960 } }] } }, hash: 'h1' },
    p2: { files: { vehicles: { vehicles: [{ id: 'c', availableFrom: { year: 1980 } }] } }, hash: 'h2' },
  };
  const x = assemble(m, raw, ['p2', 'base', 'p1'], { scenario: { id: 's', startYear: 2026, endYear: 2030 } });
  assert.deepEqual(x.vehicles.vehicles.map((v) => v.id), ['a', 'b', 'c']);
  assert.deepEqual(x.packsLoaded, { base: 'h0', p1: 'h1', p2: 'h2' });
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  assert.match(hash32(''), /^[0-9a-f]{8}$/);
});

test('catalog: lookups go through the index, then player designs', async () => {
  const data = await loadDataNode(root);
  const first = data.vehicles.vehicles[0];
  assert.equal(vehicleDef(data, first.id), first);
  assert.equal(vehicleDef({ vehicles: { vehicles: [first] } }, first.id), first, 'works without an index');
  assert.equal(vehicleDef(data, null), null);
  assert.equal(vehicleDef(data, 'nope'), null);
  assert.equal(spacecraftDef(data, 'soyuz_ms').id, 'soyuz_ms');
  const state = { startYear: 2026, turn: 0, designs: { d1: { owner: 'nasa', asVehicle: { name: 'Meu foguete', availableFrom: { year: 2026, month: 1 }, capacity: { leo: 5 } } } } };
  assert.equal(vehicleDef(data, 'd1', state).name, 'Meu foguete');
  assert.ok(listVehicles(data, state, { actorId: 'nasa' }).some((v) => v.id === 'd1'));
  assert.ok(!listVehicles(data, state, { actorId: 'cnsa' }).some((v) => v.id === 'd1'));
});

test('catalog: availability by date, availableUntil, retired and dead operators', async () => {
  const data = await loadDataNode(root, { scenarioId: 'campaign' });
  const s = (year, extra = {}) => ({ startYear: 1950, turn: (year - 1950) * 52 + 26, ...extra });
  const at = (id, year, extra) => vehicleAvailable(data, s(year, extra), id, s(year).turn);
  assert.equal(at('r7_sputnik', 1956), false);
  assert.equal(at('r7_sputnik', 1957), false, 'oct/1957 debut, mid-1957 is before');
  assert.equal(vehicleAvailable(data, s(1957), 'r7_sputnik', (1957 - 1950) * 52 + 45), true);
  assert.equal(at('r7_sputnik', 1960), false, 'past availableUntil');
  assert.equal(at('vostok_8k72k', 1962), true);
  assert.equal(at('vostok_8k72k', 1962, { lifecycle: { tombstones: { roscosmos: { id: 'roscosmos' } } } }), false, 'dead operator');
  assert.equal(at('vostok_8k72k', 1962, { lifecycle: { aliases: { roscosmos: 'x' }, tombstones: { x: { id: 'x', into: 'y' } } } }), true, 'absorbed operator: hardware lives on');
  assert.equal(vehicleAvailable(data, s(1961), 'vostok_3ka', s(1961).turn, { kind: 'spacecraft' }), true);
  assert.equal(itemAvailable(data, s(2030), { retired: true }, 0), false);
  const in1962 = listVehicles(data, s(1962)).map((v) => v.id);
  assert.ok(in1962.includes('vostok_8k72k') && in1962.includes('atlas_lv3b'));
  assert.ok(!in1962.includes('falcon9'));
  assert.ok(listSpacecraft(data, s(1962)).some((c) => c.id === 'mercury_capsule'));
});

test('determinism: era 1 played with lazy packs equals the eager run (only state.dataPacks differs)', async () => {
  const { runFullCampaign } = await import('../tools/full-campaign.mjs');
  const lazy = await runFullCampaign({ seed: 101, toEra: 'e1' });
  const eager = await runFullCampaign({ seed: 101, toEra: 'e1', eager: true });
  assert.deepEqual(lazy.errors, []);
  assert.deepEqual(eager.errors, []);
  assert.ok(lazy.maxPacks <= 3, 'at most 3 era packs in memory');
  const sim = (json) => { const s = JSON.parse(json); delete s.dataPacks; return s; };
  assert.deepStrictEqual(sim(lazy.hash), sim(eager.hash));
  assert.ok(lazy.eras[0].turns > 0);
});

// Pack e1 "A Corrida" (1950–1975): content checks (docs/EXPANSION.md §14 Phase C, owner C1).
// data/packs.json belongs to the integrator and may not list every e1 file yet, so these tests build the manifest in
// memory with every JSON file of data/eras/e1/ (and the 'a_corrida' scenario) and validate/play that view.
import * as calendarMod from '../src/sim/calendar.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData } from '../tools/validate/rules.js';
import { loadData } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { validateEvent, validateEvents } from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E1 = path.join(ROOT, 'data', 'eras', 'e1');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const E1_FILES = ['era', 'snapshot', ...fs.readdirSync(E1).filter((f) => f.endsWith('.json') && !['era.json', 'snapshot.json', 'vocab-requests.json'].includes(f)).map((f) => f.replace(/\.json$/, '')).sort()];
const SCENARIO = 'a_corrida';
const SCENARIO_FILE = `scenarios/${SCENARIO}.json`;
const raw = Object.fromEntries(E1_FILES.map((f) => [f, readJson(`eras/e1/${f}`)]));
// the era-1 tree lives in its own pack since Missões v2 (data/tech/e1/tech.json, MISSIONS-V2 §4.3)
raw.tech = readJson('tech/e1/tech');

function withE1(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.packs.find((p) => p.id === 'e1').files = E1_FILES.slice();
  m.scenarios[SCENARIO] = SCENARIO_FILE;
  return m;
}

function e1Input() {
  const { input } = loadRepoInput(ROOT);
  input.manifest = withE1(input.manifest);
  for (const f of E1_FILES) input.packs.e1[f] = raw[f];
  input.sizes.e1 = Object.fromEntries(E1_FILES.map((f) => [f, fs.statSync(path.join(E1, `${f}.json`)).size]));
  input.scenarios[SCENARIO] = readJson(`scenarios/${SCENARIO}`);
  const idx = input.scenarioIndex ? JSON.parse(JSON.stringify(input.scenarioIndex)) : { scenarios: [] };
  if (!idx.scenarios.some((s) => s.id === SCENARIO)) idx.scenarios.push({ id: SCENARIO, kind: 'scenario', name: 'A Corrida', start: { year: 1957, month: 0 }, end: { year: 1969, month: 11 } });
  input.scenarioIndex = idx;
  return input;
}

let cache = {};
async function loadE1(scenarioId = 'campaign') {
  if (cache[scenarioId]) return cache[scenarioId];
  const manifest = withE1(readJson('packs'));
  const reader = async (name) => (name === 'packs' ? manifest : readJson(name));
  cache[scenarioId] = await loadData(reader, { scenarioId, eras: 'all' });
  return cache[scenarioId];
}

const result = checkData(e1Input(), {});
const ymKey = (d) => d.year * 12 + (d.month ?? 1);

test('e1: validator clean (pack e1, the A Corrida scenario and the vocabulary)', () => {
  const mine = (i) => i.pack === 'e1' || String(i.path).includes('eras/e1/') || String(i.path).includes(SCENARIO);
  const errors = result.issues.filter((i) => i.level === 'error' && mine(i));
  assert.deepEqual(errors.map((e) => `${e.path}: ${e.message}`), []);
  assert.ok(result.stats.packBytes.e1 <= 350 * 1024, `pacote e1 com ${result.stats.packBytes.e1} bytes`);
});

test('e1: the calendar is real history, on real months, with sources', () => {
  const cal = raw.calendar.missions;
  assert.ok(cal.length >= 60, `itens: ${cal.length}`);
  for (const m of cal) {
    assert.equal(m.truthLayer, 'fato', m.id);
    assert.match(m.source, /^https:\/\//, `${m.id}: source`);
    assert.ok(m.planned.year >= 1957 && m.planned.year <= 1975, `${m.id}: ${m.planned.year}`);
    assert.equal(m.delay.slipChance, 0, `${m.id}: fatos não escorregam`);
    assert.ok(['total', 'partial', 'failure'].includes(m.historicalOutcome), m.id);
  }
  const at = (id) => cal.find((m) => m.id === id)?.planned;
  // spot checks against the history books (launch month, monthBase 1)
  assert.deepEqual(at('sputnik1'), { year: 1957, month: 10 });
  assert.deepEqual(at('explorer1'), { year: 1958, month: 2 });
  assert.deepEqual(at('vostok1'), { year: 1961, month: 4 });
  assert.deepEqual(at('friendship7'), { year: 1962, month: 2 });
  assert.deepEqual(at('voskhod2'), { year: 1965, month: 3 });
  assert.deepEqual(at('apollo8'), { year: 1968, month: 12 });
  assert.deepEqual(at('apollo11'), { year: 1969, month: 7 });
  assert.deepEqual(at('salyut1'), { year: 1971, month: 4 });
  assert.deepEqual(at('astp'), { year: 1975, month: 7 });
  // dependent items carry canon; Apollo-Soyuz needs the Soviet partner alive and a calm sky
  for (const id of ['apollo11', 'apollo17', 'skylab2', 'astp']) assert.ok(cal.find((m) => m.id === id).canon?.onBreak, `${id}: canon`);
  assert.equal(cal.find((m) => m.id === 'astp').canon.requires.actorAlive, 'roscosmos');
  // planetary facts fly on their real date, not on a window computed from 1950
  for (const m of cal.filter((x) => /venus|mars|mercury|jupiter|solar_orbit/.test(x.destination))) assert.deepEqual(m.window, {}, m.id);
  // the calendar uses only hardware that exists on the date
  const v = Object.fromEntries(raw.vehicles.vehicles.map((x) => [x.id, x]));
  const s = Object.fromEntries(raw.spacecraft.spacecraft.map((x) => [x.id, x]));
  for (const m of cal) {
    const veh = v[m.vehicleId];
    assert.ok(veh, `${m.id}: veículo ${m.vehicleId}`);
    assert.ok(ymKey(veh.availableFrom) <= ymKey(m.planned) + 1 && ymKey(m.planned) <= ymKey(veh.availableUntil) + 1, `${m.id}: ${m.vehicleId} em ${m.planned.year}`);
    const sc = s[m.spacecraftId];
    assert.ok(sc, `${m.id}: nave ${m.spacecraftId}`);
    assert.ok(sc.compatibleVehicles.length === 0 || sc.compatibleVehicles.includes(m.vehicleId), `${m.id}: ${m.spacecraftId} no ${m.vehicleId}`);
  }
});

test('e1: vehicles and spacecraft are sourced facts; every launcher has a Hangar design that reproduces its capacity', async () => {
  const data = await loadE1();
  for (const list of [raw.vehicles.vehicles, raw.spacecraft.spacecraft]) {
    for (const x of list) {
      assert.equal(x.truthLayer, 'fato', x.id);
      assert.match(x.source, /^https:\/\//, `${x.id}: source`);
    }
  }
  const P = designs.partsOf(data);
  const coreDesigns = readJson('core/parts').vehicleDesigns;
  for (const v of raw.vehicles.vehicles) {
    const spec = v.design || coreDesigns[v.id];
    assert.ok(spec, `${v.id}: decomposição`);
    for (const pid of designs.specPartIds(spec)) {
      const part = P.byId[pid];
      assert.ok(part, `${v.id}: peça ${pid}`);
      assert.ok(ymKey(part.availableFrom) <= Math.max(ymKey(v.availableFrom), (spec.year ?? 0) * 12 + 12), `${v.id}: ${pid} existe na data`);
    }
    if (!v.design) continue;
    const s = designs.designStats(data, { ...spec, calib: 1 }, { year: spec.year ?? v.availableFrom.year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    const got = s.capacityRaw.leo * spec.calib;
    const tol = Math.max(0.1 * v.capacity.leo, 0.01);
    assert.ok(Math.abs(got - v.capacity.leo) <= tol, `${v.id}: LEO ${got} vs ${v.capacity.leo}`);
    assert.ok(spec.calib >= 0.35 && spec.calib <= 1.9, `${v.id}: calib ${spec.calib}`);
  }
  for (const p of raw.parts.parts) assert.ok(p.availableFrom.year >= 1950 && p.availableFrom.year <= 1975, `${p.id}: data`);
});

test('e1: ≥120 events with year triggers inside the era, all valid cards', async () => {
  const data = await loadE1();
  const list = raw.events.events;
  assert.ok(list.length >= 120, `eventos: ${list.length}`);
  const ids = new Set(data.events.events.map((e) => e.id));
  for (const e of list) {
    assert.match(e.id, /^e1_/, e.id);
    assert.ok(e.trigger.fromYear >= 1950 && e.trigger.untilYear <= 1975 && e.trigger.fromYear <= e.trigger.untilYear, `${e.id}: janela de anos`);
    assert.deepEqual(validateEvent(e, data, ids), [], e.id);
  }
  assert.deepEqual(validateEvents(data).filter((m) => /e1_|eco_e1/.test(m)), []);
  // the Eco of era 1: the main piece is reachable from probe milestones and the second one needs the first
  const eco = list.filter((e) => e.group === 'eco');
  assert.ok(eco.length >= 2);
  const flags = eco.flatMap((e) => e.choices.flatMap((c) => c.effects.map((x) => x.flag).filter(Boolean)));
  for (const f of ['eco_e1_anomalia_radio', 'eco_e1_fita_luna']) assert.ok(flags.includes(f), f);
  // agencies of the era have their own story beats
  for (const a of ['nasa', 'roscosmos', 'esa', 'cnes', 'isro', 'cnsa', 'isas', 'jaxa', 'dlr']) {
    assert.ok(list.some((e) => e.trigger.actors?.includes(a)), `eventos próprios de ${a}`);
  }
});

test('e1: tech tier t1, era meta with news tone, snapshot, crews, investors and palette', () => {
  for (const n of raw.tech.nodes) {
    assert.equal(n.techTier, 't1', n.id);
    assert.equal(n.era, 1, n.id);
    assert.ok(n.fromYear >= 1950 && n.fromYear <= 1975, `${n.id}: fromYear`);
    assert.ok(!n.initialFor, `${n.id}: sem initialFor (o resultado não pode depender do pacote carregado)`);
  }
  assert.equal(new Set(raw.tech.nodes.map((n) => n.branch)).size, 6, 'os seis ramos');
  const era = raw.era;
  assert.equal(era.palette, 'ferrugem');
  assert.ok(era.chapters.length >= 3 && era.chapters.length <= 4);
  for (const k of ['launched', 'success', 'failed', 'first', 'delayed']) assert.ok(era.news.calendar[k], `manchete ${k}`);
  for (const k of ['first', 'total', 'partial', 'recoverable', 'catastrophic', 'death', 'transit', 'rival']) assert.ok(era.news.missionHeadlines[k].length >= 2, `relatório ${k}`);
  assert.equal(raw.snapshot.era, 'e1');
  assert.deepEqual(raw.snapshot.date, { year: 1950, month: 0 });
  assert.deepEqual(raw.snapshot.blocs, []);
  const crewData = readJson('crew');
  const traits = new Set(crewData.traits.map((t) => t.id));
  const forbidden = new Set(crewData.forbiddenNames.map((n) => n.toLowerCase()));
  for (const [actor, people] of Object.entries(raw.crew.eraRosters.e1)) {
    assert.ok(people.length >= 6, `${actor}: elenco`);
    assert.deepEqual(new Set(people.map((p) => p.role)), new Set(['engineer', 'flight_director', 'astronaut']), `${actor}: papéis`);
    for (const p of people) {
      assert.ok(!forbidden.has(p.name.toLowerCase()), `${p.name}: nome real proibido`);
      for (const t of p.traits) assert.ok(traits.has(t), `${p.id}: traço ${t}`);
    }
  }
  for (const i of raw.investors.investors) assert.ok(i.untilYear <= 1975 && i.eras.includes('e1'), i.id);
  const css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'css', 'era-1.css'), 'utf8');
  assert.match(css, /body\[data-era="e1"\]/);
});

test('e1: the campaign plays 1950→1962 with the pack: Sputnik in oct/1957, Gagarin in apr/1961, save/load identical', async () => {
  const data = await loadE1();
  const s = engine.newGame(data, { seed: 1957, playerId: 'nasa' });
  let guard = 0;
  while (!s.gameOver && 1950 + Math.floor(s.turn / 52) < 1962 && guard++ < 1500) {
    for (const d of s.decisions.slice()) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    }
    engine.advance(s, data, 1, { stopOnEvent: false });
  }
  const inst = (id) => calendarMod.instanceOrPast(s, id); // compacted history counts (§10)
  const yearMonth = (t) => [1950 + Math.floor(t / 52), Math.floor((t % 52) / (52 / 12)) + 1];
  assert.equal(inst('sputnik1').status, 'success');
  assert.deepEqual(yearMonth(inst('sputnik1').launchTurn), [1957, 10]);
  assert.equal(inst('vostok1').status, 'success');
  assert.equal(yearMonth(inst('vostok1').launchTurn)[0], 1961);
  assert.equal(s.firsts.first_satellite.actorId, 'roscosmos');
  assert.ok(Object.keys(s.events.history).some((k) => k.startsWith('e1_')), 'eventos da era aparecem');
  assert.equal(s.actors.nasa.short, 'NASA');
  const json = engine.serialize(s);
  assert.equal(engine.serialize(engine.deserialize(json, data)), json);
});

test(`e1: scenario ${SCENARIO} (1957–1969) starts from the snapshot, plays a year and keeps save/load identical`, async () => {
  const data = await loadE1(SCENARIO);
  assert.equal(data.scenario.id, SCENARIO);
  const s = engine.newGame(data, { seed: 1969, playerId: 'abma' });
  assert.equal(s.startYear, 1957);
  for (const id of ['nasa', 'roscosmos', 'abma', 'cnsa']) assert.ok(s.actors[id], `${id} existe em 1957`);
  assert.ok(!s.actors.esa && !s.actors.isro, 'ESRO e INCOSPAR ainda não existem');
  assert.deepEqual(s.blocs, {});
  engine.advance(s, data, 52, { stopOnEvent: false });
  assert.ok(s.turn >= 52);
  const json = engine.serialize(s);
  assert.equal(engine.serialize(engine.deserialize(json, data)), json);
});

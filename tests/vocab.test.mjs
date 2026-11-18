// Shared vocabulary (data/core/vocab.json, EXPANSION.md §14 C0): the repo uses only frozen ids, unknown ids fail,
// interstellar families come from core/stars.json, and data/eras/eN/vocab-requests.json makes provisional ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput, validateRepo } from '../tools/validate-data.mjs';
import { checkData, errorsOf } from '../tools/validate/rules.js';
import { vocabSets, VOCAB_CATEGORIES } from '../tools/validate/vocab.js';
import { TYPES } from '../src/sim/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = () => JSON.parse(JSON.stringify(loadRepoInput(root).input));
const run = (input) => checkData(input).issues;
const has = (list, re) => list.some((i) => re.test(`${i.path} ${i.message}`));
const errs = (input) => errorsOf({ issues: run(input) });
const vocab = JSON.parse(fs.readFileSync(path.join(root, 'data/core/vocab.json'), 'utf8'));

test('vocab.json is loaded by the validator and the repo has no vocabulary errors', () => {
  const inp = base();
  assert.ok(inp.vocab && inp.stars, 'vocab + stars in the validator input');
  const r = validateRepo(root);
  assert.deepEqual(errorsOf(r), [], errorsOf(r).map((i) => `${i.path}: ${i.message}`).join('\n'));
  assert.ok(r.stats.vocab.counts.milestones >= 140, 'milestones for all eras');
  assert.ok(r.stats.vocab.counts.destinations > 200, 'explicit + interstellar destinations');
  for (const c of VOCAB_CATEGORIES) assert.ok(r.stats.vocab.counts[c] > 0, `category ${c} not empty`);
});

test('existing ids stay stable: every id the data uses today is frozen', () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
  const dests = read('destinations.json').destinations;
  for (const d of dests) {
    assert.ok(vocab.destinations[d.id], `destination ${d.id}`);
    assert.equal(vocab.destinations[d.id].body, d.body, `${d.id}.body`);
    assert.equal(vocab.destinations[d.id].kind, d.kind, `${d.id}.kind`);
  }
  for (const b of read('bodies.json').bodies) assert.ok(vocab.bodies[b.id], `body ${b.id}`);
  for (const m of Object.keys(read('events.json').milestones)) assert.ok(vocab.milestones[m], `milestone ${m}`);
  for (const m of Object.keys(read('scenario.json').historicalFirsts)) assert.ok(vocab.milestones[m], `historical first ${m}`);
  for (const t of TYPES) assert.ok(vocab.missionTypes[t] && !vocab.missionTypes[t].status, `active mission type ${t}`);
  for (const n of read('tech.json').branches) assert.ok(vocab.techBranches[n.id], `branch ${n.id}`);
  for (const p of read('core/parts.json').parts) if (p.family) assert.ok(vocab.partFamilies[p.family], `family ${p.family}`);
  for (const i of read('core/investors.json').investors) assert.ok(vocab.investorArchetypes[i.id], `investor ${i.id}`);
  for (const c of read('core/ending.json').choices) assert.ok(vocab.endings[c.id], `ending ${c.id}`);
});

test('every era has milestones, Eco fragments (one main), a tech tier and investor archetypes', () => {
  for (let n = 1; n <= 7; n++) {
    const e = `e${n}`;
    assert.ok(Object.values(vocab.milestones).filter((m) => m.era === e).length >= 7, `${e} milestones`);
    const eco = Object.values(vocab.ecoFragments).filter((f) => f.era === e);
    assert.ok(eco.length >= 1, `${e} eco`);
    assert.equal(eco.filter((f) => f.main).length, 1, `${e} has exactly one main Eco piece`);
    assert.equal(Object.values(vocab.techTiers).filter((t) => t.era === e).length, 1, `${e} tech tier`);
    assert.ok(Object.values(vocab.investorArchetypes).some((a) => a.eras.includes(e)), `${e} investors`);
  }
  assert.deepEqual(Object.values(vocab.colonyStages).map((s) => s.n), [1, 2, 3, 4, 5, 6]);
  for (const id of ['first_satellite', 'first_crewed_orbit', 'first_eva', 'first_docking', 'crewed_lunar_landing',
    'first_space_station', 'first_orbital_booster_landing', 'crewed_mars_landing', 'first_colony', 'autonomous_colony',
    'first_interstellar_probe_arrival', 'first_crewed_interstellar_arrival', 'exoplanet_crewed_landing']) {
    assert.ok(vocab.milestones[id], id);
  }
});

test('interstellar destinations derive from core/stars.json', () => {
  const inp = base();
  const V = vocabSets(inp.vocab, inp.stars, {});
  assert.ok(V.sets.destinations.has('proxima_centauri_system'));
  assert.ok(V.sets.destinations.has('proxima_b_surface'));
  assert.ok(V.sets.destinations.has('trappist_1e_orbit'));
  assert.ok(V.sets.destinations.has('region_pleiades'));
  assert.ok(!V.sets.destinations.has('sol_system'), 'home star excluded');
  assert.ok(!V.sets.destinations.has('region_bolha_local'), 'home region excluded');
  assert.equal(V.entry('destinations', 'proxima_b_surface').body, 'proxima_b');
  // an e6 pack destination on an exoplanet is valid without a bodies.json entry
  // (kept next to the pack's own destinations: its calendar and craft still reference them)
  const own = (inp.packs.e6.destinations?.destinations || []).filter((d) => d.id !== 'proxima_b_surface');
  inp.packs.e6.destinations = { monthBase: 1, destinations: [...own, { id: 'proxima_b_surface', name: 'Proxima b', body: 'proxima_b', kind: 'surface',
    capacityKey: 'outer', route: [{ from: 'earth', to: 'proxima_b', dv: 30 }], transitWeeks: 2000 }] };
  assert.deepEqual(errs(inp), []);
});

test('unknown ids fail: destination, milestone, mission type, event kind, investor, Eco, colony stage', () => {
  const inp = base();
  const m = inp.packs.e1.calendar.missions[0];
  m.milestone = 'primeiro_qualquer_coisa';
  inp.packs.e1.spacecraft.spacecraft[0].destinations.push('marte_baixo');
  inp.packs.e6.destinations = { monthBase: 1, destinations: [{ id: 'kepler_base', name: 'Base', body: 'mars', kind: 'surface', capacityKey: 'mars', route: [], transitWeeks: 30 }] };
  inp.packs.e5.events = { events: [{ id: 'ev_x', kind: 'drama', title: 'X', text: 'Y', trigger: { fromYear: 2060 }, weight: 1, choices: [], ecoPiece: 'eco_e9', needs: { colonyStage: 9 } }] };
  inp.packs.e5.investors = { investors: [{ id: 'banco_fantasma', kind: 'fund', eras: ['e5'], profile: 'retorno' }] };
  const e = errs(inp);
  assert.ok(has(e, /sputnik1\]\.milestone marco fora do vocabulário: primeiro_qualquer_coisa/));
  assert.ok(has(e, /destinations destino fora do vocabulário: marte_baixo/));
  assert.ok(has(e, /kepler_base destino fora do vocabulário/));
  assert.ok(has(e, /ev_x\.kind tipo de evento fora do vocabulário: drama/));
  assert.ok(has(e, /ecoPiece fragmento do Eco fora do vocabulário: eco_e9/));
  assert.ok(has(e, /colonyStage estágio de colônia 9 fora de 1\.\.6/));
  assert.ok(has(e, /banco_fantasma arquétipo de investidor fora do vocabulário/));
});

test('frozen definitions cannot drift: destination body/kind, investor kind/eras, tech era', () => {
  const inp = base();
  inp.packs.e2.destinations = { monthBase: 1, destinations: [{ id: 'halley', name: 'Halley', body: 'sun', kind: 'orbit', capacityKey: 'outer', route: [], transitWeeks: 40 }] };
  inp.packs.e2.investors = { investors: [{ id: 'estatal_telecom', kind: 'fund', eras: ['e2', 'e7'], profile: 'comunicacoes' }] };
  inp.packs.e2.tech = { nodes: [{ id: 'e2_teste', branch: 'propulsion', era: 3, name: 'T', cost: 1, weeks: 1, requires: [], effects: {} },
    { id: 'e2_ramo', branch: 'magia', era: 2, name: 'T', cost: 1, weeks: 1, requires: [], effects: {}, techTier: 't4' }] };
  const e = errs(inp);
  assert.ok(has(e, /halley\.body corpo sun difere do vocabulário \(halley\)/));
  assert.ok(has(e, /halley\.kind tipo orbit difere do vocabulário \(flyby\)/));
  assert.ok(has(e, /estatal_telecom\.kind tipo fund difere/));
  assert.ok(has(e, /estatal_telecom\.eras era e7 fora das eras do arquétipo/));
  assert.ok(has(e, /e2_teste\.era era 3 difere do pacote e2/));
  assert.ok(has(e, /e2_ramo\.branch ramo de tecnologia fora do vocabulário: magia/));
  assert.ok(has(e, /e2_ramo\.techTier nível t4 é da era e4/));
});

test('vocab-requests.json: pending ids are provisional (warning), conflicts and stale requests are errors', () => {
  const inp = base();
  inp.vocabRequests.e5 = { era: 'e5', requests: [
    { id: 'ceres_shipyard', category: 'destinations', entry: { body: 'ceres', kind: 'station', era: 'e5', label: 'Estaleiro de Ceres' }, reason: 'Estaleiro orbital da cooperativa do cinturão.' },
    { id: 'first_satellite', category: 'milestones', reason: 'Já existe, deve falhar.' },
    { id: 'x_y', category: 'feitiços', reason: 'Categoria inválida.' },
  ] };
  inp.vocabRequests.e6 = { era: 'e6', requests: [
    { id: 'ceres_shipyard', category: 'destinations', entry: { body: 'ceres', kind: 'orbit', era: 'e6', label: 'Outro' }, reason: 'Conflito com e5.' },
    { id: 'leo', category: 'destinations', reason: 'Marcado como aceito.', status: 'accepted' },
    { id: 'nao_existe', category: 'milestones', reason: 'Aceito mas ausente.', status: 'accepted' },
  ] };
  inp.packs.e5.destinations = { monthBase: 1, destinations: [{ id: 'ceres_shipyard', name: 'Estaleiro', body: 'ceres', kind: 'station', capacityKey: 'outer', route: [], transitWeeks: 60 }] };
  const issues = run(inp);
  const e = issues.filter((i) => i.level === 'error');
  const w = issues.filter((i) => i.level === 'warn');
  assert.ok(!has(e, /ceres_shipyard destino fora do vocabulário/), 'provisional id is accepted');
  assert.ok(has(w, /vocab-requests\.json#ceres_shipyard id provisório/));
  assert.ok(has(e, /#first_satellite first_satellite já existe no vocabulário/));
  assert.ok(has(e, /x_y\.category categoria desconhecida/));
  assert.ok(has(e, /e6\/vocab-requests\.json#ceres_shipyard ceres_shipyard também foi pedido por e5/));
  assert.ok(has(w, /#leo pedido já incorporado/));
  assert.ok(has(e, /#nao_existe pedido marcado como aceito/));
});

test('every era folder ships an empty, valid vocab-requests.json', () => {
  const inp = base();
  for (let n = 1; n <= 7; n++) {
    const r = inp.vocabRequests[`e${n}`];
    assert.ok(r, `e${n}/vocab-requests.json`);
    assert.equal(r.era, `e${n}`);
    assert.ok(Array.isArray(r.requests));
  }
});

test('reserved ids warn (code support pending), gen_ prefix is for generators only', () => {
  const inp = base();
  inp.packs.e5.destinations = { monthBase: 1, destinations: [{ id: 'gen_belt_7', name: 'X', body: 'ceres', kind: 'orbit', capacityKey: 'outer', route: [], transitWeeks: 1 }] };
  inp.packs.e5.parts = { parts: [{ id: 'e5_vela', kind: 'sail', name: 'Vela' }] };
  const issues = run(inp);
  assert.ok(has(issues.filter((i) => i.level === 'error'), /gen_belt_7 prefixo gen_ é reservado/));
  assert.ok(has(issues.filter((i) => i.level === 'warn'), /e5_vela\.kind tipo de peça sail está reservado/));
});

test('without vocab.json the vocabulary checks are skipped (in-memory callers keep working)', () => {
  const inp = base();
  delete inp.vocab;
  inp.packs.e1.calendar.missions[0].milestone = 'qualquer';
  assert.ok(!has(errs(inp), /fora do vocabulário/));
});

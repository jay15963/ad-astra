// Pack e2 "Estações e Sondas" (1976–1999): content checks (docs/EXPANSION.md §14 Phase C, owner C2).
// The real data/packs.json may not list every e2 file yet (the manifest belongs to the integrator), so these tests
// build the manifest in memory with every JSON file of data/eras/e2/ (and the 'estacoes' scenario) and validate
// that view. Destinations of the e1 vocabulary that e2 uses (salyut, venus_surface) come from the e1 pack; until
// it ships them the test adds neutral stand-ins so the e2 checks can run on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData } from '../tools/validate/rules.js';
import { loadData } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { validateEvent } from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E2 = path.join(ROOT, 'data', 'eras', 'e2');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const E2_FILES = ['era', ...fs.readdirSync(E2).filter((f) => f.endsWith('.json') && f !== 'era.json' && f !== 'vocab-requests.json').map((f) => f.replace(/\.json$/, '')).sort()];
const SCENARIO_FILE = 'scenarios/estacoes.json';
const E1_DESTS_NEEDED = ['salyut', 'venus_surface'];

const stubDest = (id) => ({
  salyut: { id, name: 'Estações Salyut', body: 'earth', kind: 'station', capacityKey: 'leo', capacityFactor: 1, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: id, dv: 0.2 }], transitWeeks: 0, window: null, arrivalMilestones: [], firsts: {} },
  venus_surface: { id, name: 'Superfície de Vênus', body: 'venus', kind: 'surface', capacityKey: 'mars', capacityFactor: 1, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: id, dv: 3.8 }], transitWeeks: 16, window: null, arrivalMilestones: [], firsts: {} },
}[id]);

/** Manifest with every e2 file listed and the estacoes scenario; e1 stand-ins for the e1 destinations e2 uses. */
function withE2(manifest, e1Destinations) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.packs.find((p) => p.id === 'e2').files = E2_FILES.slice();
  m.scenarios.estacoes = SCENARIO_FILE;
  const missing = E1_DESTS_NEEDED.filter((id) => !(e1Destinations || []).some((d) => d.id === id));
  const e1 = m.packs.find((p) => p.id === 'e1');
  if (missing.length && !e1.files.includes('destinations')) e1.files.push('destinations');
  return { manifest: m, missing };
}

function e2Input() {
  const { input, parseErrors } = loadRepoInput(ROOT);
  const e1d = input.packs.e1?.destinations?.destinations || [];
  const { manifest, missing } = withE2(input.manifest, e1d);
  input.manifest = manifest;
  for (const f of E2_FILES) input.packs.e2[f] = readJson(`eras/e2/${f}`);
  input.sizes.e2 = Object.fromEntries(E2_FILES.map((f) => [f, fs.statSync(path.join(E2, `${f}.json`)).size]));
  if (missing.length) {
    const cur = input.packs.e1.destinations || { monthBase: 1, destinations: [] };
    input.packs.e1.destinations = { ...cur, destinations: [...(cur.destinations || []), ...missing.map(stubDest)] };
  }
  input.scenarios.estacoes = readJson('scenarios/estacoes');
  const idx = input.scenarioIndex ? JSON.parse(JSON.stringify(input.scenarioIndex)) : { scenarios: [] };
  if (!idx.scenarios.some((s) => s.id === 'estacoes')) idx.scenarios.push({ id: 'estacoes', kind: 'scenario', name: 'Estações', start: { year: 1981, month: 0 }, end: { year: 1998, month: 11 } });
  input.scenarioIndex = idx;
  return { input, parseErrors, missing };
}

async function loadE2(scenarioId = 'campaign') {
  const manifest = withE2(readJson('packs'), []).manifest;
  const e1HasDest = fs.existsSync(path.join(ROOT, 'data', 'eras', 'e1', 'destinations.json'));
  const reader = async (name) => {
    if (name === 'packs') return manifest;
    if (name === 'eras/e1/destinations') {
      const cur = e1HasDest ? readJson(name) : { monthBase: 1, destinations: [] };
      const add = E1_DESTS_NEEDED.filter((id) => !cur.destinations.some((d) => d.id === id)).map(stubDest);
      return { ...cur, destinations: [...cur.destinations, ...add] };
    }
    return readJson(name);
  };
  return loadData(reader, { scenarioId, eras: 'all' });
}

const { input, missing } = e2Input();
const result = checkData(input, {});
const raw = Object.fromEntries(E2_FILES.map((f) => [f, readJson(`eras/e2/${f}`)]));
// the era-2 tree lives in its own pack since Missões v2 (data/tech/e2/tech.json, MISSIONS-V2 §4.3)
raw.tech = readJson('tech/e2/tech');

test('e2: validator clean (pack e2, scenarios and vocabulary)', () => {
  const errors = result.issues.filter((i) => i.level === 'error' && (i.pack === 'e2' || i.pack === 'scenarios' || String(i.path).includes('eras/e2/')));
  assert.deepEqual(errors.map((e) => `${e.path}: ${e.message}`), []);
  if (missing.length) console.log(`# e2: destinos do pacote e1 ainda ausentes, usados com substitutos no teste: ${missing.join(', ')}`);
});

test('e2: pack under its size budget (350 KB)', () => {
  const bytes = Object.values(input.sizes.e2).reduce((a, b) => a + b, 0);
  assert.ok(bytes <= 350 * 1024, `${(bytes / 1024).toFixed(0)} KB`);
});

test('e2: calendar is history (fato, sourced, dated 1976–1999, real outcome)', () => {
  const cal = raw.calendar.missions;
  assert.ok(cal.length >= 60, `${cal.length} itens`);
  for (const m of cal) {
    assert.equal(m.truthLayer, 'fato', m.id);
    assert.match(m.source, /^https:\/\//, m.id);
    assert.ok(['total', 'partial', 'failure'].includes(m.historicalOutcome), m.id);
    assert.ok(m.planned.year >= 1976 && m.planned.year <= 1999, `${m.id} ${m.planned.year}`);
    assert.ok(m.planned.month >= 1 && m.planned.month <= 12, `${m.id}: meses base 1`);
    assert.ok(m.description && m.description.length >= 40, `${m.id}: descrição`);
    if (m.inTransit) assert.ok(m.launched && m.launched.year * 12 + m.launched.month < m.planned.year * 12 + m.planned.month, `${m.id}: launched antes da chegada`);
  }
  // the era's firsts are all claimable by some item or destination
  const dests = Object.fromEntries(raw.destinations.destinations.map((d) => [d.id, d]));
  const claim = new Set(cal.map((m) => m.milestone).filter(Boolean));
  for (const m of cal) for (const f of [].concat(dests[m.destination]?.firsts?.robotic ?? [])) claim.add(f);
  for (const id of ['first_reusable_spaceplane', 'first_untethered_eva', 'first_satellite_repair', 'comet_flyby', 'comet_nucleus_flyby', 'first_modular_station',
    'first_year_in_orbit', 'first_private_orbital_launch', 'asteroid_flyby', 'solar_polar_orbit', 'jupiter_atmosphere_probe', 'mars_rover', 'international_station',
    'saturn_flyby', 'uranus_flyby']) assert.ok(claim.has(id), `marco da era sem item: ${id}`);
  // key dates (spot checks against the sources)
  const at = (id) => cal.find((m) => m.id === id)?.planned;
  assert.deepEqual(at('sts1'), { year: 1981, month: 4 });
  assert.deepEqual(at('sts51l'), { year: 1986, month: 1 });
  assert.deepEqual(at('mir_core'), { year: 1986, month: 2 });
  assert.deepEqual(at('zarya'), { year: 1998, month: 11 });
  assert.deepEqual(at('sts88'), { year: 1998, month: 12 });
  assert.equal(cal.find((m) => m.id === 'sts51l').historicalOutcome, 'failure');
  // fact-check pass: era milestones added and their real dates/outcomes
  assert.deepEqual(at('hipparcos'), { year: 1989, month: 8 });
  assert.equal(cal.find((m) => m.id === 'hipparcos').historicalOutcome, 'partial');
  assert.deepEqual(at('kristall'), { year: 1990, month: 5 });
  assert.deepEqual(at('sts37'), { year: 1991, month: 4 });
  assert.deepEqual(at('sts49'), { year: 1992, month: 5 });
  assert.deepEqual(at('deep_space_1'), { year: 1998, month: 10 });
  // the real launcher of each flight (not a stand-in of the same class)
  const rocket = (id) => cal.find((m) => m.id === id)?.vehicleId;
  for (const [id, v] of Object.entries({ mars_observer: 'titan_iii_com', clementine: 'titan_23g', lunar_prospector: 'athena_ii', kompsat1: 'taurus', bepposax: 'atlas_i', cassini: 'titan_iv', pathfinder: 'delta_ii', giotto: 'ariane1' })) assert.equal(rocket(id), v, id);
});

test('e2: every calendar owner and partner is alive on the date (lifecycle)', async () => {
  const data = await loadE2();
  const { aliveAt } = await import('../src/sim/lifecycle.js');
  for (const m of raw.calendar.missions) {
    const y = m.inTransit ? m.launched.year : m.planned.year;
    for (const a of [m.owner, ...m.partners]) {
      const turn = (y - 1950) * 52 + Math.floor(((m.inTransit ? m.launched.month : m.planned.month) - 1) * 52 / 12);
      assert.ok(aliveAt(data, a, turn, 1950), `${m.id}: ${a} não existe em ${y}`);
    }
  }
});

test('e2: ≥ 120 narrative events with year triggers inside the era, all valid for the event DSL', async () => {
  const data = await loadE2();
  const ev = raw.events.events;
  assert.ok(ev.length >= 120, `${ev.length} eventos`);
  const ids = new Set(data.events.events.map((e) => e.id));
  const errors = [];
  for (const e of ev) {
    const from = e.trigger?.fromYear ?? e.fromYear;
    const until = e.trigger?.untilYear ?? e.untilYear;
    assert.ok(Number.isInteger(from) && from >= 1976 && from <= 1999, `${e.id}: fromYear ${from}`);
    assert.ok(until == null || (until >= from && until <= 1999), `${e.id}: untilYear ${until}`);
    errors.push(...validateEvent(e, data, ids));
  }
  assert.deepEqual(errors, []);
  // chain steps that are scheduled exist in the pack
  for (const e of ev) for (const c of e.choices) for (const fx of c.effects) if (fx.schedule) assert.ok(ids.has(fx.schedule), `${e.id}: agenda ${fx.schedule}`);
});

test('e2: catalog rockets carry a Hangar design that reproduces their LEO capacity (±10%)', async () => {
  const data = await loadE2();
  const P = designs.partsOf(data);
  for (const v of raw.vehicles.vehicles) {
    assert.ok(v.design, `${v.id}: design`);
    const spec = v.design;
    for (const pid of designs.specPartIds(spec)) {
      const part = P.byId[pid];
      assert.ok(part, `${v.id}: peça ${pid}`);
      assert.ok(part.availableFrom.year * 12 + part.availableFrom.month <= (spec.year ?? v.availableFrom.year) * 12 + 12, `${v.id}: ${pid} existe na data`);
    }
    assert.ok(spec.calib >= 0.35 && spec.calib <= 1.9, `${v.id}: calib ${spec.calib}`);
    const s = designs.designStats(data, spec, { year: spec.year ?? v.availableFrom.year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    assert.ok(Math.abs(s.capacity.leo - v.capacity.leo) / v.capacity.leo <= 0.1, `${v.id}: LEO ${s.capacity.leo} vs ${v.capacity.leo}`);
  }
});

test('e2: tech tier t2 covers the six branches with era-2 nodes', () => {
  const nodes = raw.tech.nodes;
  const branches = new Set(nodes.map((n) => n.branch));
  for (const b of ['propulsion', 'structures', 'life_support', 'computing', 'energy', 'science']) assert.ok(branches.has(b), b);
  for (const n of nodes) {
    assert.equal(n.techTier, 't2', n.id);
    assert.ok(n.fromYear >= 1976 && n.fromYear <= 1999, `${n.id}: fromYear`);
  }
});

test('e2: era meta has news tone, starting crews and a snapshot of 1981', () => {
  assert.equal(raw.era.id, 'e2');
  assert.ok(raw.era.news && Array.isArray(raw.era.news.launched) && raw.era.news.launched.length >= 3);
  for (const id of ['nasa', 'roscosmos', 'esa', 'cnsa', 'isro', 'jaxa']) assert.ok((raw.crew.eraRosters.e2[id] || []).length >= 6, `tripulação ${id}`);
  assert.equal(raw.snapshot.era, 'e2');
  assert.deepEqual(raw.snapshot.date, { year: 1981, month: 0 });
});

test('e2: the Estações scenario starts in 1981 and plays a year headless', async () => {
  const data = await loadE2('estacoes');
  assert.equal(data.scenario.id, 'estacoes');
  const state = engine.newGame(data, { seed: 1981, playerId: 'nasa' });
  assert.equal(state.startYear, 1981);
  const before = state.turn;
  engine.advance(state, data, 13, { stopOnEvent: false });
  assert.ok(state.turn > before);
  assert.ok(state.actors.nasa && state.actors.roscosmos, 'NASA e o programa soviético existem');
  assert.ok(!state.actors.spacex, 'SpaceX ainda não existe em 1981');
});

test('e2: era palette css exists', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'css', 'era-2.css'), 'utf8');
  assert.match(css, /body\[data-era="e2"\]/);
});

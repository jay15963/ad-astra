// Pack e4 "A Década Lunar" (2026–2050): content checks (docs/EXPANSION.md §14 Phase C, owner C4).
// data/packs.json lists only eras/e4/era.json on purpose: the Corrida Lunar (legacy scenario, eras ['e4']) loads the
// e4 pack, so activating the 2031–2050 content there changes the golden fixture and the legacy-data assumptions of
// other test files (see the C4 report). These tests therefore build the manifest in memory with every JSON file of
// data/eras/e4/ (and the 'decada_lunar' scenario) and check that view, exactly as the integrator will switch it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData } from '../tools/validate/rules.js';
import { loadData, nodeReader, erasLoaded } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { validateEvent } from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';
import { hash32 } from '../src/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E4 = path.join(ROOT, 'data', 'eras', 'e4');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
// manifest order: meta and lifecycle first, then catalog, then content (same order as the activation line in the report)
const ORDER = ['era', 'snapshot', 'lineages', 'lifecycle', 'vehicles', 'spacecraft', 'destinations', 'calendar', 'tech', 'events', 'crew', 'investors', 'parts'];
const ON_DISK = fs.readdirSync(E4).filter((f) => f.endsWith('.json') && f !== 'vocab-requests.json').map((f) => f.replace(/\.json$/, ''));
const E4_FILES = [...ORDER.filter((f) => ON_DISK.includes(f)), ...ON_DISK.filter((f) => !ORDER.includes(f)).sort()];
const SCENARIO = 'decada_lunar';

/** Manifest with every e4 file listed and the decada_lunar scenario. */
function withE4(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.packs.find((p) => p.id === 'e4').files = E4_FILES.slice();
  m.scenarios[SCENARIO] = `scenarios/${SCENARIO}.json`;
  return m;
}

function e4Input() {
  const { input, parseErrors } = loadRepoInput(ROOT);
  input.manifest = withE4(input.manifest);
  for (const f of E4_FILES) input.packs.e4[f] = readJson(`eras/e4/${f}`);
  input.sizes.e4 = Object.fromEntries(E4_FILES.map((f) => [f, fs.statSync(path.join(E4, `${f}.json`)).size]));
  input.scenarios[SCENARIO] = readJson(`scenarios/${SCENARIO}`);
  const idx = input.scenarioIndex ? JSON.parse(JSON.stringify(input.scenarioIndex)) : { scenarios: [] };
  if (!idx.scenarios.some((s) => s.id === SCENARIO)) idx.scenarios.push({ id: SCENARIO, kind: 'scenario', name: 'A Década Lunar', subtitle: '2026 a 2040', start: { year: 2026, month: 0 }, end: { year: 2040, month: 11 }, order: 6 });
  input.scenarioIndex = idx;
  return { input, parseErrors };
}

/** Node reader that serves the activated manifest (and the scenario index entry) instead of the repo's. */
async function activeReader() {
  const base = await nodeReader(ROOT);
  const manifest = withE4(readJson('packs'));
  return async (name) => {
    if (name === 'packs') return JSON.parse(JSON.stringify(manifest));
    return base(name);
  };
}
async function loadE4(scenarioId = 'campaign', eras = 'all') {
  return loadData(await activeReader(), { scenarioId, eras });
}

const e4 = Object.fromEntries(E4_FILES.map((f) => [f, readJson(`eras/e4/${f}`)]));
// the era-4 tree lives in its own pack since Missões v2 (data/tech/e4/tech.json, MISSIONS-V2 §4.3)
e4.tech = readJson('tech/e4/tech');
const campaign = await loadE4('campaign');

test('e4: validator clean (pack e4, scenarios and vocabulary) with every e4 file listed', () => {
  const { input, parseErrors } = e4Input();
  const r = checkData(input);
  const mine = (i) => i.pack === 'e4' || String(i.path).includes('eras/e4/') || String(i.path).includes(SCENARIO);
  const errors = [...parseErrors, ...r.issues].filter((i) => i.level === 'error' && mine(i));
  assert.deepEqual(errors, [], errors.map((e) => `${e.path}: ${e.message}`).join('\n'));
  // only the documented warning remains: the provisional scenario id (vocab request)
  const warns = r.issues.filter((i) => i.level === 'warn' && mine(i) && !/id provisório/.test(i.message));
  assert.deepEqual(warns, [], warns.map((e) => `${e.path}: ${e.message}`).join('\n'));
  assert.ok(r.stats.packBytes.e4 <= 350 * 1024, `pacote e4 com ${r.stats.packBytes.e4} B`);
  assert.ok(r.stats.bootBytes <= 1.6 * 1024 * 1024, `dados de partida ${r.stats.bootBytes} B`);
});

test('e4: ≥ 120 narrative events with year triggers inside the era, all valid for the event DSL', () => {
  const list = e4.events.events;
  assert.ok(list.length >= 120, `${list.length} eventos`);
  const ids = new Set(campaign.events.events.map((e) => e.id));
  for (const ev of list) {
    assert.ok(ev.id.startsWith('e4_'), `${ev.id}: prefixo e4_`);
    const t = ev.trigger || {};
    assert.ok(t.fromYear >= 2026 && t.fromYear <= 2050, `${ev.id}: fromYear ${t.fromYear}`);
    assert.ok(t.untilYear >= t.fromYear && t.untilYear <= 2050, `${ev.id}: untilYear ${t.untilYear}`);
    assert.deepEqual(validateEvent(ev, campaign, ids), [], ev.id);
  }
  // spread over the whole era, both truth layers, operations and chains present
  const years = new Set(list.map((e) => e.trigger.fromYear));
  for (const y of [2031, 2036, 2040, 2045]) assert.ok([...years].some((x) => x <= y), `algum evento já vale em ${y}`);
  assert.ok(list.filter((e) => e.trigger.fromYear >= 2036).length >= 30, 'camada de projeção (2036+) com conteúdo');
  assert.ok(list.filter((e) => e.kind === 'operation').length >= 12, 'eventos de operação');
  const chains = new Set(list.filter((e) => e.chain).map((e) => e.chain.id));
  assert.ok(chains.size >= 3, 'cadeias');
});

test('e4: calendar 2031–2050 in the right truth layer, sourced official plans, valid hardware and canon', () => {
  const items = e4.calendar.missions;
  assert.ok(items.length >= 40, `${items.length} itens`);
  const idx = campaign.index;
  for (const m of items) {
    const y = m.planned.year;
    assert.ok(y >= 2031 && y <= 2050, `${m.id}: ${y} (2026–2030 fica no calendário legado)`);
    if (m.truthLayer === 'plano_oficial') {
      assert.ok(y <= 2040, `${m.id}: plano oficial em ${y}`);
      assert.match(m.source || '', /^https:\/\//, `${m.id}: plano oficial precisa de fonte`);
    } else assert.equal(m.truthLayer, 'projecao', `${m.id}: camada ${m.truthLayer}`);
    assert.ok(m.statusNov2026 && m.description, `${m.id}: textos`);
    assert.ok(idx.vehicles[m.vehicleId], `${m.id}: lançador ${m.vehicleId}`);
    assert.ok(idx.spacecraft[m.spacecraftId], `${m.id}: nave ${m.spacecraftId}`);
    if (m.secondarySpacecraftId) assert.ok(idx.spacecraft[m.secondarySpacecraftId], `${m.id}: nave ${m.secondarySpacecraftId}`);
    assert.ok(idx.destinations[m.destination], `${m.id}: destino ${m.destination}`);
    for (const p of m.prerequisites) assert.ok(idx.calendar[p], `${m.id}: pré-requisito ${p}`);
    if (m.canon) assert.ok(['drop', 'reassign', 'retarget'].includes(m.canon.onBreak), `${m.id}: canon.onBreak`);
    const craft = idx.spacecraft[m.spacecraftId];
    if (craft.compatibleVehicles?.length) assert.ok(craft.compatibleVehicles.includes(m.vehicleId), `${m.id}: ${m.spacecraftId} não voa no ${m.vehicleId}`);
  }
  // the era's story beats are on the calendar
  const ms = new Set(items.map((m) => m.milestone).filter(Boolean));
  for (const k of ['first_fission_surface_power', 'first_lunar_night_survival', 'far_side_observatory', 'lunar_base', 'lunar_station', 'crewed_mars_orbit', 'crewed_mars_landing']) assert.ok(ms.has(k), `marco ${k}`);
  const byOwner = new Set(items.map((m) => m.owner));
  for (const a of ['nasa', 'cnsa', 'isro', 'esa', 'jaxa', 'roscosmos', 'spacex', 'blueorigin']) assert.ok(byOwner.has(a), `programa de ${a}`);
});

test('e4: vehicles and craft carry sources when official, and every new launcher has a calibrated Hangar design', () => {
  for (const v of [...e4.vehicles.vehicles, ...e4.spacecraft.spacecraft]) {
    if (v.truthLayer === 'plano_oficial') assert.match(v.source || '', /^https:\/\//, `${v.id}: fonte`);
    assert.ok(v.availableFrom.year >= 2026 && v.availableFrom.year <= 2050, `${v.id}: data`);
  }
  for (const v of e4.vehicles.vehicles) {
    const spec = designs.catalogDesign(campaign, v.id);
    assert.ok(spec, `${v.id}: decomposição em peças`);
    const year = spec.year ?? v.availableFrom.year;
    const s = designs.designStats(campaign, spec, { year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    assert.ok(Math.abs(s.capacity.leo - v.capacity.leo) / v.capacity.leo <= 0.1, `${v.id}: LEO ${s.capacity.leo} vs ${v.capacity.leo}`);
    assert.ok(spec.calib >= 0.35 && spec.calib <= 1.9, `${v.id}: calib ${spec.calib}`);
  }
});

test('e4: tech tier t4 covers the six branches with era-4 nodes opening inside the tier (2026–2050)', () => {
  const nodes = e4.tech.nodes;
  const branches = new Set(nodes.map((n) => n.branch));
  assert.equal(branches.size, 6);
  for (const n of nodes) {
    assert.equal(n.era, 4);
    assert.equal(n.techTier, 't4');
    assert.ok(n.fromYear >= 2026 && n.fromYear <= 2050, `${n.id}: ${n.fromYear}`);
    assert.ok(n.histYear >= n.fromYear && n.histYear <= 2050, `${n.id}: histYear ${n.histYear}`);
    for (const r of n.requires) assert.ok(campaign.index.tech[r], `${n.id}: requer ${r}`);
  }
});

test('e4: era meta has chapters, news tone, palette css; snapshot of jan/2026; starting crews; investors of the era', () => {
  const era = e4.era;
  assert.ok(era.chapters.length >= 3 && era.chapters.length <= 4);
  for (const k of ['first', 'total', 'partial', 'recoverable', 'catastrophic', 'death', 'transit', 'rival']) assert.ok(era.news.missionHeadlines[k].length >= 2, `manchetes ${k}`);
  assert.equal(era.palette, 'prata');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'css', 'era-4.css'), 'utf8');
  assert.match(css, /body\[data-era="e4"\]/);
  assert.equal(e4.snapshot.era, 'e4');
  assert.deepEqual(e4.snapshot.date, { year: 2026, month: 0 });
  for (const id of Object.keys(e4.snapshot.actors)) assert.ok(campaign.index.lineages[id], `snapshot: linhagem ${id}`);
  for (const r of e4.snapshot.relations) assert.ok(e4.snapshot.actors[r.a] && e4.snapshot.actors[r.b], `relação ${r.a}-${r.b}`);
  const traits = new Set(campaign.crew.traits.map((t) => t.id));
  for (const [actor, list] of Object.entries(e4.crew.roster)) {
    assert.ok(list.length >= 5, `${actor}: elenco`);
    assert.deepEqual(new Set(list.map((p) => p.role)), new Set(['engineer', 'flight_director', 'astronaut']), `${actor}: papéis`);
    for (const p of list) for (const t of p.traits) assert.ok(traits.has(t), `${p.id}: traço ${t}`);
  }
  const inv = campaign.investors.investors.filter((i) => i.eras.includes('e4'));
  assert.ok(inv.length >= 6, 'arquétipos de investidor válidos na era 4');
  assert.ok(campaign.investors.profiles.manufatura.templates.length >= 2, 'perfil de manufatura');
});

test('e4: activating the pack does not change the 1950s of the campaign (dates honoured)', async () => {
  const plain = await loadData(await nodeReader(ROOT), { scenarioId: 'campaign', eras: 'all' });
  const run = (data) => {
    const s = engine.createState(data, { seed: 4242, playerId: 'nasa' });
    engine.advance(s, data, 60, { stopOnEvent: false });
    const { dataPacks, ...rest } = s;
    for (const k of ['calendar', 'vehicleStats', 'research']) delete rest[k]; // e4 entries exist (planned, untouched) but are inert
    // budget.js keeps a 0-paid ledger key per AI calendar program (bookkeeping only): drop the untouched ones
    const programs = Object.fromEntries(Object.entries(rest.finance?.programs || {}).filter(([, v]) => v));
    rest.finance = { ...rest.finance, programs };
    return hash32(JSON.stringify(rest));
  };
  assert.equal(run(campaign), run(plain));
});

test('e4: the Década Lunar scenario plays 2026→2032 headless, deterministic, no errors in the log', async () => {
  const data = await loadE4(SCENARIO, 'auto');
  // earlier eras come in as catalog only (places, hardware, lineages: src/core/data.js CATALOG_FILES)
  // + every tech pack (src/core/data.js: the whole tree is merged so unlock keys never depend on the loaded eras)
  assert.deepEqual(Object.keys(data.packsLoaded).sort(), ['core', 'e1', 'e2', 'e3', 'e4', 'legacy-e4', 'tech-e1', 'tech-e2', 'tech-e3', 'tech-e4', 'tech-e5', 'tech-e6', 'tech-e7']);
  assert.deepEqual(erasLoaded(data), ['e4']);
  assert.ok(!data.calendar.missions.some((m) => m.era === 'e3'), 'no dated content of the catalog eras');
  assert.equal(data.scenario.turnWeeks, 4);
  const play = () => {
    const s = engine.createState(data, { seed: 77, playerId: 'isro' });
    for (let i = 0; i < 90 && !s.gameOver; i++) {
      for (const d of s.decisions.slice()) {
        // this bot never flies, so it keeps control of the agency (no binding mandates from new shareholders)
        const pass = d.kind === 'investors/round' && d.choices?.find((x) => !x.disabled && /decline|recusar|pass|none/.test(x.id));
        const c = pass || d.choices?.find((x) => !x.disabled) || d.choices?.[0];
        engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
      }
      engine.advance(s, data, 1, { stopOnEvent: false });
    }
    return s;
  };
  const a = play();
  const b = play();
  assert.equal(engine.serialize(a), engine.serialize(b));
  assert.ok(a.startYear + Math.floor(a.turn / 52) >= 2031, 'passou de 2031');
  assert.ok(Object.keys(a.actors).length > 8, 'ciclo de vida ligado: atores menores existem');
  const bad = (a.log || []).map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).filter((l) => /\berro\b|NaN|undefined/i.test(l));
  assert.deepEqual(bad, []);
  assert.ok(engine.serialize(a).length < 400 * 1024, 'save ≤ 400 KB');
});

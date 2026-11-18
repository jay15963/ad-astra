// Era 3 pack "A Era Comercial" (2000–2025): data/eras/e3/**, data/scenarios/nova_economia.json, src/ui/css/era-3.css.
// docs/EXPANSION.md §14 Phase C. The tests read the pack files from disk; when data/packs.json does not list them yet
// (the integrator adds them), the manifest is augmented in memory so the validator and the sim see the whole pack.
import * as calendarMod from '../src/sim/calendar.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData, errorsOf, PACK_BUDGET } from '../tools/validate/rules.js';
import { loadData, nodeReader } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as narrative from '../src/sim/narrative.js';
import * as designs from '../src/sim/designs.js';
import { expand as expandTech } from '../src/core/techgen.js';
import { runCampaign, dataStartingAt } from '../tools/campaign.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'data', 'eras', 'e3');
const FILES = ['era', 'snapshot', 'vehicles', 'spacecraft', 'destinations', 'bodies', 'calendar', 'events', 'investors', 'crew', 'parts'];
const SCENARIO = 'nova_economia';
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, `${f}.json`), 'utf8'));
const P = Object.fromEntries(FILES.map((f) => [f, read(f)]));
// the era-3 tree lives in its own pack since Missões v2 (data/tech/e3/tech.json, MISSIONS-V2 §4.3)
const readTech = (e) => JSON.parse(fs.readFileSync(path.join(root, 'data', 'tech', e, 'tech.json'), 'utf8'));
P.tech = readTech('e3');
// authored + generated nodes of t1..t3 (prerequisites may come from earlier tiers, §4.4)
const TREE_UP_TO_T3 = new Set(['e1', 'e2', 'e3'].flatMap((e) => expandTech(readTech(e))).map((n) => n.id));
const FROM = 2000;
const TO = 2025;

// e3 items fly on vehicles of earlier eras (Delta II, ônibus espacial, M-V of e2): until the integrator lists every
// era file in data/packs.json, the packs this era builds on (e1, e2) and e3 itself are listed from disk.
const DEPENDS = ['e1', 'e2', 'e3'];
const onDisk = (era) => fs.readdirSync(path.join(root, 'data', 'eras', era))
  .filter((f) => f.endsWith('.json') && f !== 'vocab-requests.json').map((f) => f.replace(/\.json$/, ''));
function augment(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  for (const era of DEPENDS) {
    const p = m.packs.find((x) => x.id === era);
    const disk = onDisk(era);
    const listed = p.files || [];
    const extra = disk.filter((f) => !listed.includes(f) && f !== 'patches').sort();
    p.files = [...listed, ...extra, ...(disk.includes('patches') && !listed.includes('patches') ? ['patches'] : [])];
  }
  m.scenarios[SCENARIO] ??= `scenarios/${SCENARIO}.json`;
  return m;
}

async function e3Reader() {
  const base = await nodeReader(root);
  return async (name) => (name === 'packs' ? augment(await base(name)) : base(name));
}

let campaignData = null;
async function campaign() {
  campaignData ??= await loadData(await e3Reader(), { scenarioId: 'campaign', eras: 'all' });
  return campaignData;
}

test('e3: validator clean for the era pack and its scenario (manifest augmented if needed)', () => {
  const { input } = loadRepoInput(root);
  input.manifest = augment(input.manifest);
  for (const era of DEPENDS) {
    input.packs[era] ??= {};
    input.sizes[era] ??= {};
    for (const f of input.manifest.packs.find((x) => x.id === era).files) {
      const text = fs.readFileSync(path.join(root, 'data', 'eras', era, `${f}.json`), 'utf8');
      input.packs[era][f] = JSON.parse(text);
      input.sizes[era][f] = Buffer.byteLength(text);
    }
  }
  input.scenarios[SCENARIO] = JSON.parse(fs.readFileSync(path.join(root, 'data', 'scenarios', `${SCENARIO}.json`), 'utf8'));
  const r = checkData(input, {});
  const errs = errorsOf(r).filter((i) => i.pack === 'e3' || /e3|nova_economia/.test(i.path));
  assert.deepEqual(errs.map((e) => `${e.path}: ${e.message}`), []);
  const warns = r.issues.filter((i) => i.level === 'warn' && i.pack === 'e3');
  assert.deepEqual(warns.map((e) => `${e.path}: ${e.message}`), []);
  assert.ok(r.stats.packBytes.e3 <= PACK_BUDGET, `pacote e3 com ${r.stats.packBytes.e3} bytes`);
});

test('e3: era meta, chapters, palette and news tone', () => {
  const e = P.era;
  assert.equal(e.id, 'e3');
  assert.equal(e.from, FROM);
  assert.equal(e.to, TO);
  assert.equal(e.palette, 'aco');
  assert.ok(e.chapters.length >= 2 && e.chapters.length <= 4);
  for (const k of ['launched', 'success', 'failed', 'delayed', 'first']) assert.ok(e.newsTone.templates[k].length >= 2, k);
});

test('e3: calendar = real missions 2000–2025, fato with source, real outcome, canon on dependent items', () => {
  const items = P.calendar.missions;
  assert.ok(items.length >= 100, `${items.length} itens`);
  const ids = new Set(items.map((m) => m.id));
  for (const m of items) {
    assert.equal(m.truthLayer, 'fato', m.id);
    assert.match(m.source, /^https:\/\//, m.id);
    assert.ok(m.planned.year >= FROM && m.planned.year <= TO, m.id);
    assert.ok(m.planned.month >= 1 && m.planned.month <= 12, `${m.id}: meses base 1`);
    assert.ok(['total', 'partial', 'failure'].includes(m.historicalOutcome), m.id);
    assert.equal(m.delay.slipChance, 0, m.id);
    for (const p of m.prerequisites) {
      assert.ok(ids.has(p), `${m.id}: pré-requisito ${p} da própria era`);
      const pre = items.find((x) => x.id === p);
      assert.ok(pre.planned.year * 12 + pre.planned.month <= m.planned.year * 12 + m.planned.month, `${m.id} depois de ${p}`);
    }
    if (m.prerequisites.length || m.partners.length) assert.ok(m.canon?.onBreak, `${m.id}: canon`);
    assert.ok(m.description.length >= 40 && m.statusNov2026.startsWith('Histórica'), m.id);
  }
  // key moments of the era are on the calendar with the right date
  const at = (id) => { const m = items.find((x) => x.id === id); return m && `${m.planned.year}-${m.planned.month}`; };
  assert.equal(at('shenzhou5'), '2003-10');
  assert.equal(at('falcon1_f4'), '2008-9');
  assert.equal(at('orbcomm_og2'), '2015-12');
  assert.equal(at('crew_demo2'), '2020-5');
  assert.equal(at('jwst'), '2021-12');
  assert.equal(at('chandrayaan3'), '2023-7');
  assert.equal(at('starship_ift5'), '2024-10');
});

test('e3: vehicles and spacecraft: dates in the era, nothing outlives 2050, designs reproduce LEO ±10%', async () => {
  const data = await campaign();
  for (const v of P.vehicles.vehicles) {
    assert.ok(v.availableFrom.year >= FROM && v.availableFrom.year <= TO, v.id);
    assert.ok(v.availableUntil && v.availableUntil.year <= 2050, `${v.id}: availableUntil`);
    assert.match(v.source, /^https:\/\//, v.id);
    assert.equal(v.history.flights, 0, `${v.id}: voos contados dentro da era`);
    const spec = designs.catalogDesign(data, v.id);
    assert.ok(spec, `${v.id}: design`);
    const year = v.availableFrom.year;
    for (const pid of designs.specPartIds(spec)) {
      const part = designs.partsOf(data).byId[pid];
      assert.ok(part, `${v.id}: peça ${pid}`);
      assert.ok(part.availableFrom.year * 12 + part.availableFrom.month <= year * 12 + 12, `${v.id}: ${pid} existe na data`);
    }
    const s = designs.designStats(data, spec, { year });
    assert.ok(s.ok, `${v.id}: ${s.errors.join('; ')}`);
    assert.ok(Math.abs(s.capacity.leo - v.capacity.leo) / v.capacity.leo <= 0.1, `${v.id}: LEO ${s.capacity.leo} vs ${v.capacity.leo}`);
    assert.ok(spec.calib >= 0.35 && spec.calib <= 1.9, `${v.id}: calib ${spec.calib}`);
  }
  for (const s of P.spacecraft.spacecraft) {
    assert.ok(s.availableFrom.year >= FROM && s.availableFrom.year <= TO, s.id);
    assert.ok(s.availableUntil && s.availableUntil.year <= 2050, `${s.id}: availableUntil`);
    for (const vid of s.compatibleVehicles || []) assert.ok(data.index.vehicles[vid], `${s.id}: ${vid}`);
  }
  for (const p of P.parts.parts) assert.ok(p.availableUntil && p.availableUntil.year <= 2050, `${p.id}: availableUntil`);
  for (const d of P.destinations.destinations) assert.ok(d.availableUntil && d.availableUntil.year <= 2050, `${d.id}: availableUntil`);
});

test('e3: ≥ 120 events, all with year triggers inside the era, valid for the narrative DSL', async () => {
  const data = await campaign();
  const list = P.events.events;
  assert.ok(list.length >= 120, `${list.length} eventos`);
  for (const e of list) {
    assert.ok(e.id.startsWith('e3_'), e.id);
    const t = e.trigger;
    assert.ok(Number.isInteger(t.fromYear) && Number.isInteger(t.untilYear), `${e.id}: janela de anos`);
    assert.ok(t.fromYear >= FROM && t.untilYear <= TO && t.fromYear <= t.untilYear, `${e.id}: ${t.fromYear}–${t.untilYear}`);
    if (e.truthLayer === 'fato') assert.match(e.source, /^https:\/\//, e.id);
  }
  const errs = narrative.validateEvents({ ...data, events: { ...data.events, events: list } });
  assert.deepEqual(errs.filter((x) => /e3_/.test(x)), []);
  const hist = list.filter((e) => e.truthLayer === 'fato');
  assert.ok(hist.length >= 50, `${hist.length} cartas históricas`);
  // every year of the era has something to tell
  for (let y = FROM; y <= TO; y++) assert.ok(list.some((e) => e.trigger.fromYear <= y && e.trigger.untilYear >= y), `ano ${y} sem cartas`);
});

test('e3: tech tier t3, investors, crew flights and starting roster', () => {
  const nodes = P.tech.nodes;
  assert.ok(nodes.length >= 12);
  const branches = new Set(nodes.map((n) => n.branch));
  assert.equal(branches.size, 6, 'os seis ramos');
  for (const n of nodes) {
    assert.equal(n.era, 3, n.id);
    assert.equal(n.techTier, 't3', n.id);
    for (const r of n.requires) assert.ok(TREE_UP_TO_T3.has(r), `${n.id}: ${r}`);
  }
  for (const inv of P.investors.investors) assert.ok(inv.eras.includes('e3') && inv.untilYear <= 2050, inv.id);
  for (const f of P.crew.config.rivalCrewFlights.flights) assert.ok(f.fromYear >= FROM && f.toYear <= TO, f.id);
  const roster = P.crew.eraRosters.e3;
  for (const a of ['nasa', 'spacex', 'cnsa', 'isro', 'esa', 'jaxa', 'roscosmos']) {
    const people = roster[a];
    assert.ok(people.length >= 8, a);
    for (const role of ['engineer', 'flight_director', 'astronaut']) assert.ok(people.some((p) => p.role === role), `${a}: ${role}`);
  }
});

test('e3: snapshot of jan/2008 lists only actors alive then', async () => {
  const data = await campaign();
  const snap = P.snapshot;
  assert.deepEqual(snap.date, { year: 2008, month: 0 });
  const born = (id) => data.index.lineages?.[id]?.born;
  for (const id of Object.keys(snap.actors)) {
    const b = born(id);
    assert.ok(b && b.year * 12 + b.month <= 2008 * 12, `${id} nasceu antes de 2008`);
  }
  for (const r of snap.relations) assert.ok(snap.actors[r.a] && snap.actors[r.b], `${r.a}-${r.b}`);
});

test('e3: Nova Economia scenario starts in jan/2008 with the e3 pack and plays a year headless', async () => {
  const data = await loadData(await e3Reader(), { scenarioId: SCENARIO });
  assert.ok(data.packsLoaded.e3, 'pacote e3 carregado');
  assert.equal(data.scenario.startYear, 2008);
  const state = engine.newGame(data, { seed: 42, playerId: 'nasa' });
  assert.equal(state.clock.eraId, 'e3');
  assert.equal(state.clock.stepWeeks, 4);
  assert.ok(state.actors.spacex && state.actors.cnsa, 'atores vivos em 2008');
  assert.ok(!state.actors.rocketlab || state.actors.rocketlab.tier === 'minor');
  assert.ok(!state.actors.axiom, 'Axiom só nasce em 2016');
  for (let i = 0; i < 13 && !state.gameOver; i++) {
    for (const d of [...state.decisions]) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      if (c) engine.dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c.id });
    }
    engine.dispatch(state, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
  }
  assert.ok(state.startYear + Math.floor(state.turn / 52) >= 2009, `chegou a ${state.turn}`);
  assert.ok(!state.log.some((l) => /erro|falha ao processar/.test(l)), state.log.filter((l) => /erro|falha/.test(l)).join(' | '));
});

// §2.1: a scenario that starts mid-history is built from data, so calendar items dated before the start are history.
// Today src/sim/calendar.js instantiates them as 'planned' (rivals relaunch them at turn 0) or 'player' (the player
// inherits 1976–2007 missions as mandates and the board fires them by ~2011). Owner: calendar/missions (A3/B5).
test('e3: Nova Economia: calendar items before jan/2008 are settled history, not launches or mandates', async () => {
  const data = await loadData(await e3Reader(), { scenarioId: SCENARIO });
  const state = engine.newGame(data, { seed: 42, playerId: 'nasa' });
  engine.dispatch(state, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
  const start = 2008 * 12 + 1;
  const past = data.calendar.missions.filter((m) => m.truthLayer === 'fato' && m.planned.year * 12 + m.planned.month < start);
  const inst = (id) => calendarMod.instanceOrPast(state, id); // compacted history counts (§10)
  const open = past.filter((m) => ['planned', 'player'].includes(inst(m.id)?.status) || state.missions.some((x) => x.calendarId === m.id));
  assert.deepEqual(open.map((m) => m.id), []);
});

test('e3: the campaign runs the era 2000→2026 with real history and save/load identical', async () => {
  const data = dataStartingAt(await campaign(), 2000);
  const res = runCampaign(data, { seed: 7919, playerId: 'esa', fast: true, toEra: 'e3' });
  assert.deepEqual(res.errors, []);
  const state = res.state;
  assert.ok(state.startYear + Math.floor(state.turn / 52) >= 2026, `chegou a ${state.turn}`);
  const json = engine.serialize(state);
  assert.equal(engine.serialize(engine.deserialize(json, data)), json, 'save/load idêntico');
  const inst = (id) => calendarMod.instanceOrPast(state, id); // compacted history counts (§10)
  assert.equal(inst('shenzhou5')?.status, 'success');
  assert.equal(inst('falcon1_f4')?.status, 'success');
  // every rival mission of the era flew and was resolved by the end of 2025 (the player's own become mandates)
  const e3Items = data.calendar.missions.filter((m) => m.era === 'e3' && m.owner !== 'esa' && !(m.partners || []).includes('esa'));
  const open = e3Items.filter((m) => !['success', 'partial', 'failed', 'launched', 'player'].includes(inst(m.id)?.status));
  assert.deepEqual(open.map((m) => `${m.id}:${inst(m.id)?.status}`), []);
  assert.equal(state.firsts.first_orbital_booster_landing?.actorId, 'spacex');
  assert.equal(state.firsts.lunar_far_side_landing?.actorId, 'cnsa');
  assert.equal(state.firsts.first_booster_catch?.actorId, 'spacex');
  assert.ok(json.length < 400 * 1024, `save ${json.length} bytes`);
});

test('e3: era skin era-3.css only touches body[data-era="e3"]', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'ui', 'css', 'era-3.css'), 'utf8');
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@'));
  assert.ok(selectors.length > 0);
  for (const s of selectors) assert.ok(s.includes('body[data-era="e3"]'), `seletor fora da era: ${s}`);
  assert.match(css, /--act:/);
});

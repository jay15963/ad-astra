// Colônias (docs/EXPANSION.md §14 C10; GDD "Mapa do universo e colonização"): data against the vocabulary, the six
// stages, supply lines and reserve, population/needs/opinion, crises as decision cards, independence (allied or
// independent), rival colonies, interstellar seed ships with the fog of war of the map, the map hooks
// (explore.colonyList), dt-equivalence, determinism with save/load, and the Colônias screen in the registry.
// The engine registry may not list colonies.js yet (integration request of C10): the guarded splice below puts it
// after 'investors', which is where it belongs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as col from '../src/sim/colonies.js';
import { colonyList, exploredIds } from '../src/sim/explore.js';
import { rngFor } from '../src/core/rng.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!engine.MODULES.some(([n]) => n === 'colonies')) {
  const at = engine.MODULES.findIndex(([n]) => n === 'investors');
  engine.MODULES.splice(at >= 0 ? at + 1 : engine.MODULES.length, 0, ['colonies', col]);
}
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const COL = read('data/core/colonies.json');
const VOCAB = read('data/core/vocab.json');
const STARS = read('data/core/stars.json');

const lunar = await loadDataNode(ROOT);
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });

/** Campaign data starting at `year`, colonies only (no investor board that could fire the test director). */
function dataAt(year, patch = (c) => c) {
  const colonies = patch(JSON.parse(JSON.stringify(campaign.colonies || COL)));
  const scenario = { ...campaign.scenario, start: { year, month: 0 }, startYear: year, unlocks: { colonies: { fromYear: 2051 } } };
  return { ...campaign, scenario, colonies };
}
/** Colony data where every convoy arrives (risk-free tests of the stage logic). */
const safe = (c) => { c.tuning.found.success = 1; for (const s of c.sites) s.risk = 0; c.tuning.events.basePerYear = 0; c.tuning.events.lowWelfare = 0; c.tuning.ai.foundPerYear = 0; return c; };

function newGame(data, seed = 11, playerId = 'nasa') {
  const s = engine.newGame(data, { seed, playerId });
  s.actors[playerId].cash = 50000;
  s.actors[playerId].budget = 2500;
  return s;
}
function resolveAll(state, data) {
  for (const d of state.decisions.slice()) {
    const c = d.kind === 'era/transition' ? 'continue' : (d.choices?.find((x) => !x.disabled) || d.choices?.[0])?.id;
    engine.dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c });
  }
}
function advanceYears(state, data, years) {
  const end = state.turn + years * 52;
  let guard = 0;
  while (state.turn < end && !state.gameOver && guard++ < 5000) {
    resolveAll(state, data);
    state.actors[state.playerId].cash = Math.max(state.actors[state.playerId].cash, 20000);
    engine.dispatch(state, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
  }
}
const D = (state, data, a) => engine.dispatch(state, data, a);

// ------------------------------------------------------------------ data

test('colonies.json: stages are the vocabulary stages; sites, milestones and real surveys are valid and sourced', () => {
  assert.deepEqual(COL.stages.map((s) => s.id), Object.keys(VOCAB.colonyStages));
  for (const s of COL.stages) assert.equal(s.n, VOCAB.colonyStages[s.id].n, s.id);
  const planets = new Set(STARS.stars.flatMap((s) => (s.planets || []).map((p) => p.id)));
  const starIds = new Set(STARS.stars.map((s) => s.id));
  const destOk = (d) => !!VOCAB.destinations[d] || (/_surface$|_orbit$/.test(d) && planets.has(d.replace(/_(surface|orbit)$/, ''))) || (/_system$/.test(d) && starIds.has(d.replace(/_system$/, '')));
  const ids = new Set();
  for (const s of COL.sites) {
    assert.match(s.id, /^[a-z0-9_]+$/);
    assert.ok(!ids.has(s.id), `duplicado ${s.id}`); ids.add(s.id);
    assert.ok(destOk(s.destination), `${s.id}: destino ${s.destination}`);
    for (const d of s.surveyBy || []) assert.ok(destOk(d), `${s.id}: surveyBy ${d}`);
    assert.ok(s.maxStage >= 2 && s.maxStage <= 6, s.id);
    assert.ok(s.names?.length >= 2, `${s.id}: nomes`);
    assert.ok(s.desc && !/TODO|undefined/.test(s.desc), s.id);
    if (s.starId) { assert.ok(starIds.has(s.starId), s.id); assert.ok(s.ly > 0 && s.fromYear >= 2200, s.id); assert.equal(s.survey, null, `${s.id}: estrela não tem fato`); }
    else {
      // a fact (a spacecraft or a study really looked at the place) with its source
      assert.ok(s.survey?.year <= 2025 && /^https:\/\//.test(s.survey.source) && s.survey.by, `${s.id}: reconhecimento real com fonte`);
      assert.ok(s.fromYear >= 2051 && s.transitWeeks >= 1, s.id);
    }
  }
  for (const r of COL.milestones) assert.ok(VOCAB.milestones[r.milestone], `marco ${r.milestone}`);
  for (const p of COL.projects) for (const m of [p.milestone, p.startMilestone].filter(Boolean)) assert.ok(VOCAB.milestones[m], `projeto ${p.id}: ${m}`);
  for (const ev of COL.events) {
    if (ev.milestone) assert.ok(VOCAB.milestones[ev.milestone], ev.id);
    assert.ok(ev.choices.length >= 2 && ev.choices.filter((c) => c.default).length === 1, `${ev.id}: uma escolha padrão`);
    assert.ok(ev.title.includes('{name}') || ev.body.includes('{name}'), ev.id);
    for (const c of ev.choices) assert.ok(c.label && c.preview, `${ev.id}.${c.id}`);
  }
  assert.ok(COL.events.length >= 20, 'variedade de crises');
});

// ------------------------------------------------------------------ gating

test('Corrida Lunar: no colonies slice, actions refused, golden world untouched', () => {
  const s = engine.newGame(lunar, { seed: 7, playerId: 'nasa' });
  for (let i = 0; i < 20; i++) engine.dispatch(s, lunar, { type: 'time/advance', turns: 1, stopOnEvent: false });
  assert.equal(s.colonies, undefined);
  assert.equal(col.isActive(lunar), false);
  const r = D(s, lunar, { type: 'colonies/found', siteId: 'lua_shackleton' });
  assert.equal(r.ok, false);
  assert.match(r.error, /não tem colônias/);
});

test('campaign before 2051: the slice waits for the unlock year', () => {
  const data = dataAt(2040, safe);
  const s = newGame(data);
  advanceYears(s, data, 2);
  assert.equal(s.colonies, undefined);
  const r = D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
  assert.equal(r.ok, false);
  assert.match(r.error, /2051/);
});

// ------------------------------------------------------------------ the stages

test('found → outpost → base → colony: convoy, arrival, stage requirements, milestones and the map marker', () => {
  const data = dataAt(2051, safe);
  const s = newGame(data);
  const r = D(s, data, { type: 'colonies/found', siteId: 'marte_arcadia' });
  assert.ok(r.ok, r.error);
  assert.equal(s.colonies.transit.length, 1);
  assert.ok(engine.MODULES.find(([n]) => n === 'colonies')[1].appointments(s).includes(r.arriveTurn), 'arrival is a player appointment');
  assert.equal(colonyList(s).length, 0, 'no marker while the convoy travels');
  advanceYears(s, data, 1);
  const c = s.colonies.list.find((x) => x.siteId === 'marte_arcadia');
  assert.ok(c, 'colony founded');
  assert.equal(c.stage, 2);
  assert.equal(s.firsts.mars_outpost?.actorId, 'nasa');
  const mark = colonyList(s).find((x) => x.id === c.id);
  assert.deepEqual([mark.bodyId, mark.kind, mark.ownerId], ['mars', 'outpost', 'nasa']);
  // base: years at stage + systems
  let up = D(s, data, { type: 'colonies/upgrade', colonyId: c.id });
  assert.equal(up.ok, false);
  for (const need of ['vida', 'energia', 'alimento', 'moradia']) assert.ok(D(s, data, { type: 'colonies/invest', colonyId: c.id, need }).ok);
  D(s, data, { type: 'colonies/route', colonyId: c.id, level: 3 });
  advanceYears(s, data, 4);
  up = D(s, data, { type: 'colonies/upgrade', colonyId: c.id });
  assert.ok(up.ok, up.error);
  assert.equal(c.stage, 3);
  assert.equal(s.firsts.mars_base?.actorId, 'nasa');
  assert.equal(s.colonies.maxStage, 3, 'lifecycle reads maxStage (colony_gov needs stage 5)');
  // colony (stage 4) needs population, self-sufficiency and welfare
  const chk = col.upgradeCheck(s, data, c);
  assert.equal(chk.ok, false);
  assert.ok(chk.reasons.some((x) => /População/.test(x)));
});

test('supply line: without a route the reserve drains and welfare falls; a full route keeps the colony supplied', () => {
  const data = dataAt(2051, safe);
  const s = newGame(data);
  D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
  advanceYears(s, data, 1);
  const c = s.colonies.list[0];
  D(s, data, { type: 'colonies/route', colonyId: c.id, level: 0 });
  advanceYears(s, data, 2);
  assert.equal(c.reserve, 0);
  assert.ok(c.welfare < 80, `welfare ${c.welfare}`);
  const low = c.welfare;
  D(s, data, { type: 'colonies/route', colonyId: c.id, level: 3 });
  advanceYears(s, data, 1);
  assert.ok(c.reserve > 0 && c.welfare > low, 'route restores supply');
  assert.ok(col.routes(s, data).some((r) => r.colonyId === c.id && r.to === 'moon' && r.level === 3), 'supply line for the map');
  assert.ok(col.routeCost(s, data, c) > 0);
});

test('model: self-sufficiency from local systems; imports cover the rest only while supplied', () => {
  const data = dataAt(2051);
  const base = { siteId: 'marte_valles', stage: 3, population: 100, infra: { vida: 0, energia: 0, alimento: 0, moradia: 2 }, shock: {}, route: 0, reserve: 0 };
  const dry = col.model(data, base);
  assert.equal(dry.autonomy, 0);
  assert.ok(dry.needs.vida === 0 && dry.welfare < 30);
  const fed = col.model(data, { ...base, route: 3 });
  assert.equal(fed.needs.vida, 100);
  const self = col.model(data, { ...base, infra: { vida: 3, energia: 3, alimento: 3, moradia: 2 } });
  assert.equal(self.autonomy, 1);
  assert.ok(self.welfare > 90);
  const rich = { ...base, route: 3, infra: { vida: 3, energia: 3, alimento: 3, moradia: 3 } };
  assert.ok(col.opinionTarget(data, { ...rich, tax: 'pesada' }) < col.opinionTarget(data, { ...rich, tax: 'leve' }), 'heavy taxes cost opinion');
});

// ------------------------------------------------------------------ cards

test('crises are decision cards with costs in the preview; the default choice applies on expiry', () => {
  const data = dataAt(2051, (c) => { safe(c); c.tuning.events.basePerYear = 1; return c; });
  const s = newGame(data, 5);
  D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
  let card = null;
  for (let i = 0; i < 400 && !card; i++) {
    engine.dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    card = s.decisions.find((d) => d.kind === 'colonies/crisis');
    for (const d of s.decisions) if (d !== card && d.kind !== 'colonies/crisis') engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: (d.choices?.find((x) => !x.disabled) || d.choices?.[0])?.id });
  }
  assert.ok(card, 'a colony card appears');
  const c = s.colonies.list.find((x) => x.id === card.payload.colonyId);
  assert.equal(c.card, card.id);
  assert.ok(card.title && !/\{|undefined/.test(card.title + card.body));
  assert.ok(card.defaultChoice && card.expiresTurn > s.turn - 52);
  const ev = data.colonies.events.find((e) => e.id === card.payload.eventId);
  for (const ch of ev.choices) if (ch.effects?.cashM < 0) assert.match(card.choices.find((x) => x.id === ch.id).preview, /Custa US\$/);
  // expiry: the engine resolves it with the default choice
  let guard = 0;
  while (s.decisions.includes(card) && guard++ < 50) engine.dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
  assert.ok(!s.decisions.includes(card));
  assert.equal(c.card, null);
});

test('independence: a restless city-state asks for a referendum; allied needs opinion; independence pays a first', () => {
  const data = dataAt(2120, safe);
  const s = newGame(data, 3);
  D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
  advanceYears(s, data, 1);
  const c = s.colonies.list[0];
  Object.assign(c, { stage: 5, population: 9000, opinion: 30, stageTurn: s.turn - 52 * 30, infra: { vida: 6, energia: 6, alimento: 6, moradia: 6 } });
  c.tax = 'pesada';
  const ctx = { dt: 52, prevTurn: s.turn, turn: s.turn, rng: () => rngFor(1) };
  let dec = null;
  for (let y = 0; y < 40 && !dec; y++) {
    s.turn += 52;
    c.opinion = 30;
    col.onYear(s, data, { ...ctx, prevTurn: s.turn - 52, turn: s.turn });
    dec = s.decisions.find((d) => d.kind === 'colonies/independence');
  }
  assert.ok(dec, 'referendum card');
  assert.ok(dec.choices.find((x) => x.id === 'aliada').disabled, 'no alliance with opinion 30');
  const r = D(s, data, { type: 'decision/resolve', id: dec.id, choiceId: 'independente' });
  assert.ok(r.ok);
  assert.equal(c.status, 'independent');
  assert.equal(c.stage, 6);
  assert.equal(c.founderId, 'nasa');
  assert.notEqual(c.ownerId, 'nasa');
  assert.equal(s.firsts.first_independent_colony?.actorId, 'nasa');
  assert.equal(D(s, data, { type: 'colonies/route', colonyId: c.id, level: 2 }).ok, false, 'no orders to a sovereign world');
});

test('allied outcome keeps trade income; postponing once costs opinion and a second crisis can force the break', () => {
  const data = dataAt(2120, safe);
  const s = newGame(data, 4);
  D(s, data, { type: 'colonies/found', siteId: 'marte_arcadia' });
  advanceYears(s, data, 1);
  const c = s.colonies.list[0];
  Object.assign(c, { stage: 5, population: 8000, opinion: 70, welfare: 90, infra: { vida: 6, energia: 6, alimento: 6, moradia: 6 } });
  const h = col.decisionHandlers['colonies/independence'];
  h(s, data, { payload: { colonyId: c.id } }, 'adiar');
  assert.equal(c.indep.resisted, 1);
  assert.equal(c.opinion, 55);
  assert.ok(c.indep.cooldownTurn > s.turn);
  h(s, data, { payload: { colonyId: c.id } }, 'aliada');
  assert.equal(c.status, 'allied');
  assert.equal(c.ownerId, 'nasa');
  assert.ok(col.incomeOf(data, c) > 0, 'allies share the trade');
  assert.equal(col.upkeepCost(s, data, c), 0);
});

// ------------------------------------------------------------------ rivals, lifecycle

test('rivals found and run colonies on their own; a dissolved owner leaves orphans that govern themselves', () => {
  const data = dataAt(2051, (c) => { safe(c); c.tuning.ai.foundPerYear = 1; return c; });
  const s = newGame(data, 9);
  advanceYears(s, data, 12);
  const rivals = s.colonies.list.filter((c) => c.ownerId && c.ownerId !== 'nasa');
  assert.ok(rivals.length >= 3, `rival colonies: ${rivals.length}`);
  assert.ok(rivals.every((c) => c.route === data.colonies.tuning.ai.routeLevel || c.status !== 'active'));
  const c = rivals[0];
  c.stage = 4;
  const gone = c.ownerId;
  const goneName = s.actors[gone].short || s.actors[gone].name;
  col.onActorGone(s, data, {}, gone, {});
  assert.equal(c.status, 'independent');
  assert.equal(c.ownerId, null);
  assert.ok(s.colonies.list.every((x) => x.ownerId !== gone));
  // the news names the old owner, never its raw id
  const orphan = s.news.find((n) => /passa a se governar sozinha/.test(n.headline || ''));
  assert.ok(orphan && orphan.headline.includes(`da ${goneName}`), orphan?.headline);
});

test('variety: the player does not get the same colony card again within repeatYears', () => {
  const data = dataAt(2120, (c) => { safe(c); c.tuning.events.basePerYear = 1; c.tuning.events.maxOpenCards = 9; return c; });
  const s = newGame(data, 6);
  for (const site of ['lua_shackleton', 'marte_arcadia', 'lua_marius', 'fobos_stickney']) D(s, data, { type: 'colonies/found', siteId: site });
  const seen = [];
  const end = s.turn + 30 * 52;
  while (s.turn < end && !s.gameOver) {
    for (const d of s.decisions) if (d.kind === 'colonies/crisis' && !seen.some((x) => x.id === d.id)) seen.push({ id: d.id, ev: d.payload.eventId, year: Math.floor(s.turn / 52) });
    resolveAll(s, data);
    s.actors.nasa.cash = Math.max(s.actors.nasa.cash, 20000);
    engine.dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
  }
  assert.ok(seen.length >= 10, `cards: ${seen.length}`);
  const rep = data.colonies.tuning.events.repeatYears;
  for (const a of seen) for (const b of seen) if (a !== b && a.ev === b.ev && a.year < b.year) assert.ok(b.year - a.year >= rep - 1, `${a.ev} repeated after ${b.year - a.year} years`);
  assert.ok(Object.keys(s.colonies.recent).length <= data.colonies.events.length);
});

// ------------------------------------------------------------------ the stars

test('interstellar: a probe reveals the star (fog of war), a seed ship travels for decades and lands on another sun', () => {
  const data = dataAt(2200, safe);
  const s = newGame(data, 21);
  const site = data.colonies.sites.find((x) => x.id === 'proxima_b');
  let r = D(s, data, { type: 'colonies/found', siteId: 'proxima_b' });
  assert.equal(r.ok, false);
  assert.match(r.error, /sonda/);
  r = D(s, data, { type: 'colonies/survey', siteId: 'proxima_b' });
  assert.ok(r.ok, r.error);
  assert.equal(r.arriveTurn - s.turn, Math.ceil((site.ly / 0.1) * 52), '0,1 c');
  s.turn = r.arriveTurn - 1;
  advanceYears(s, data, 1);
  assert.ok(exploredIds(s, data).has('proxima_centauri'), 'the map knows the star');
  assert.ok(s.colonies.surveys.proxima_b != null);
  r = D(s, data, { type: 'colonies/found', siteId: 'proxima_b' });
  assert.ok(r.ok, r.error);
  const weeks = col.travelWeeks(s, data, site);
  assert.equal(r.arriveTurn - s.turn, weeks);
  assert.ok(weeks >= 52 * 80, `${weeks} weeks`);
  assert.equal(s.firsts.first_crewed_interstellar_launch?.actorId, 'nasa');
  assert.equal(s.firsts.first_generation_ship_launch?.actorId, 'nasa', 'e6 speeds are generation ships');
  s.turn = r.arriveTurn - 1;
  advanceYears(s, data, 1);
  const c = s.colonies.list.find((x) => x.siteId === 'proxima_b');
  assert.ok(c && c.stage === 3 && c.starId === 'proxima_centauri' && c.route === 0);
  assert.equal(s.firsts.exoplanet_crewed_landing?.actorId, 'nasa');
  assert.equal(D(s, data, { type: 'colonies/route', colonyId: c.id, level: 1 }).ok, false, 'no supply lines between stars');
  assert.ok(col.investWeeks(data, c) > 52 * 4, 'plans travel at light speed');
  assert.equal(colonyList(s).find((x) => x.id === c.id).starId, 'proxima_centauri', 'sector/galaxy marker');
});

// ------------------------------------------------------------------ time and saves

test('dt-equivalence: four years at dt 1 and at dt 52 give the same colony within tolerance', () => {
  const data = dataAt(2051, safe);
  const mk = () => {
    const s = newGame(data, 2);
    D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
    advanceYears(s, data, 1);
    const c = s.colonies.list[0];
    Object.assign(c, { stage: 4, population: 400, infra: { vida: 3, energia: 3, alimento: 2, moradia: 3 }, route: 1, reserve: 10, opinion: 50 });
    return s;
  };
  const run = (dt) => {
    const s = mk();
    const t0 = s.turn - (s.turn % 52);
    s.turn = t0;
    for (let t = t0; t < t0 + 208; t += dt) { col.tick(s, data, { dt, prevTurn: t, turn: t }); }
    return s.colonies.list[0];
  };
  const a = run(1), b = run(52);
  assert.ok(Math.abs(a.population - b.population) / a.population < 0.1, `${a.population} vs ${b.population}`);
  assert.ok(Math.abs(a.opinion - b.opinion) < 5, `${a.opinion} vs ${b.opinion}`);
  assert.ok(Math.abs(a.reserve - b.reserve) <= 2, `${a.reserve} vs ${b.reserve}`);
});

test('determinism and save/load: same seed and actions give the same colonies; a reload continues identically', () => {
  const data = dataAt(2051);
  const play = (reloadAt) => {
    let s = newGame(data, 17);
    D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
    D(s, data, { type: 'colonies/found', siteId: 'marte_arcadia' });
    for (let y = 0; y < 16; y++) {
      if (y === reloadAt) s = engine.deserialize(engine.serialize(s), data);
      for (const c of s.colonies?.list || []) if (c.ownerId === 'nasa' && c.status === 'active') {
        D(s, data, { type: 'colonies/route', colonyId: c.id, level: 2 });
        D(s, data, { type: 'colonies/invest', colonyId: c.id, need: ['vida', 'energia', 'alimento', 'moradia'][y % 4] });
        D(s, data, { type: 'colonies/upgrade', colonyId: c.id });
      }
      advanceYears(s, data, 1);
    }
    return s;
  };
  const a = play(-1), b = play(-1), c = play(7);
  assert.equal(JSON.stringify(a.colonies), JSON.stringify(b.colonies));
  assert.equal(JSON.stringify(a.colonies), JSON.stringify(c.colonies));
  assert.ok(a.colonies.list.length >= 2);
  assert.ok(JSON.stringify(a.colonies).length < 30 * 1024, 'slice stays small');
});

test('compaction: the list never passes its cap and the memory keeps 12 names', () => {
  const data = dataAt(2051);
  const s = newGame(data);
  const sl = col.slice(s);
  for (let i = 0; i < 60; i++) sl.list.push({ id: `col_x${i}`, name: `X${i}`, siteId: 'lua_shackleton', ownerId: 'cnsa', stage: 3, status: 'active', population: i, infra: {}, shock: {}, pending: [] });
  for (let i = 0; i < 20; i++) sl.past.push({ name: `P${i}`, place: 'Lua', year: 2060, cause: 'colapso' });
  col.compact(s, data);
  assert.ok(sl.list.length <= data.colonies.tuning.caps.list);
  assert.equal(sl.past.length, 12);
});

// ------------------------------------------------------------------ queries and screen

test('colonies/view: everything the screen needs, in pt-BR, without NaN', () => {
  const data = dataAt(2051, safe);
  const s = newGame(data);
  D(s, data, { type: 'colonies/found', siteId: 'lua_shackleton' });
  advanceYears(s, data, 1);
  const v = engine.query(s, data, 'colonies/view');
  assert.equal(v.active, true);
  assert.equal(v.colonies.length, 1);
  assert.equal(v.stages.length, 6);
  assert.ok(v.sites.length >= 20);
  const json = JSON.stringify(v);
  assert.ok(!/NaN|undefined/.test(json));
  const c = v.colonies[0];
  assert.equal(c.needs.length, 4);
  assert.ok(c.needs.every((n) => Number.isFinite(n.costM)));
  assert.ok(v.sites.find((x) => x.id === 'proxima_b').reason, 'stars explain why not yet');
});

test('Colônias screen: registered in the drawer (Universo), loads a module with render, badge counts colony cards', async () => {
  const scr = await import('../src/ui/screens.js');
  const d = scr.screenById('colonias');
  assert.equal(d.title, 'Colônias');
  assert.equal(d.group, 'universo');
  assert.equal(d.nav, 'drawer');
  assert.ok(!d.soon, 'no longer a stub');
  const data = dataAt(2051);
  assert.equal(d.available({ startYear: 1950, turn: 0 }, data), false);
  assert.equal(d.available({ startYear: 1950, turn: 101 * 52 }, data), true);
  assert.equal(d.available({ startYear: 2026, turn: 0 }, lunar), false);
  const m = await d.load();
  assert.equal(typeof m.render, 'function');
  const ui = await import('../src/ui/colonies.js');
  assert.equal(ui.coloniesBadge({ decisions: [{ kind: 'colonies/crisis' }], playerId: 'nasa' }), 1);
  assert.equal(ui.coloniesBadge({ decisions: [], playerId: 'nasa', colonies: { list: [{ ownerId: 'nasa', status: 'active', welfare: 20 }] } }), true);
  assert.equal(d.badge({ decisions: [{ kind: 'colonies/independence' }], playerId: 'nasa' }), 1);
});

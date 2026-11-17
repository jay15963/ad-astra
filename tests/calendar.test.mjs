// Tests for the catalog + living calendar module (src/sim/calendar.js and its data files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate, formatTurn } from '../src/core/time.js';
import { relKey } from '../src/core/helpers.js';
import * as cal from '../src/sim/calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const DEST_IDS = ['leo', 'sso', 'gto', 'iss', 'cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole', 'mars_orbit', 'mars_surface', 'jupiter', 'titan'];
const FIRSTS = ['crewed_lunar_flyby', 'crewed_lunar_orbit', 'crewed_lunar_landing', 'lunar_south_pole_landing', 'lunar_south_pole_crewed',
  'lunar_sample_return', 'lunar_resource_demo', 'lunar_base', 'mars_landing_robotic', 'mars_sample_return', 'titan_arrival', 'jupiter_arrival',
  'commercial_station', 'national_station', 'crewed_orbit_national', 'lunar_surface_robotic' /* scenario goal */];
const TRUTH = ['fato', 'plano_oficial', 'projecao', 'especulacao'];
const TYPES = ['satellite', 'probe', 'crewed', 'cargo', 'station', 'lander'];
const ACTORS = ['nasa', 'spacex', 'blueorigin', 'cnsa', 'isro', 'esa', 'roscosmos', 'jaxa'];

/** Run only the calendar module, exactly like the engine would (same ctx.rng derivation). */
function run(seed, playerId = 'spectator', weeks = null, setup = null) {
  const state = createState(data, { seed, playerId });
  const ctx = () => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'calendar', l), date: turnToDate(state.turn, state.startYear) });
  cal.init(state, data, ctx());
  if (setup) setup(state);
  const end = weeks == null ? state.endTurn : weeks - 1;
  while (state.turn <= end) {
    state.signals = state.signalsPending;
    state.signalsPending = [];
    cal.tick(state, data, ctx());
    state.turn++;
  }
  return state;
}

test('data: vehicles have the contract fields and sane numbers', () => {
  const vs = data.vehicles.vehicles;
  assert.ok(vs.length >= 18);
  for (const id of ['falcon9', 'falconheavy', 'starship', 'sls_b1', 'sls_b1b', 'new_glenn', 'vulcan', 'ariane6', 'h3', 'lvm3', 'long_march_5', 'long_march_7', 'long_march_10', 'soyuz2', 'angara_a5', 'electron', 'neutron']) {
    assert.ok(data.index.vehicles[id], `vehicle ${id}`);
  }
  for (const v of vs) {
    assert.ok(v.name && v.operator && v.country, v.id);
    assert.ok(TRUTH.includes(v.truthLayer), `${v.id} truthLayer`);
    assert.ok(v.availableFrom?.year && v.availableFrom?.month >= 1 && v.availableFrom.month <= 12, `${v.id} availableFrom`);
    assert.ok(v.costM > 0 && v.cadencePerYear >= 0, `${v.id} cost/cadence`);
    assert.ok(v.history.failures <= v.history.flights, `${v.id} history`);
    for (const k of ['leo', 'gto', 'tli', 'mars', 'outer']) assert.equal(typeof v.capacity[k], 'number', `${v.id} capacity.${k}`);
    assert.ok(v.capacity.leo >= v.capacity.gto && v.capacity.leo >= v.capacity.tli, `${v.id} LEO is the biggest`);
    if (v.history.flights < 5) assert.ok(v.estimatedReliability > 0 && v.estimatedReliability < 1, `${v.id} new vehicles need estimatedReliability`);
    if (v.debutCalendarId) assert.ok(data.index.calendar[v.debutCalendarId], `${v.id} debut item`);
    for (const a of v.embargo || []) assert.ok(ACTORS.includes(a), `${v.id} embargo ${a}`);
  }
});

test('data: spacecraft reference valid destinations and vehicles', () => {
  const ss = data.spacecraft.spacecraft;
  for (const id of ['orion', 'crew_dragon', 'starliner', 'cargo_dragon', 'mengzhou', 'lanyue', 'gaganyaan', 'starship_hls', 'blue_moon_mk1', 'blue_moon_mk2',
    'change7', 'change8', 'dragonfly', 'rosalind_franklin', 'tianwen3', 'tianwen4', 'generic_sat', 'generic_probe', 'generic_cargo', 'generic_station_module',
    'haven1', 'axiom_module', 'starlab', 'tiangong_module', 'bas_module']) assert.ok(data.index.spacecraft[id], `spacecraft ${id}`);
  for (const s of ss) {
    assert.ok(['capsule', 'lander', 'probe', 'cargo', 'station_module', 'rover', 'satellite'].includes(s.kind), `${s.id} kind`);
    assert.ok(s.massT > 0 && s.costM > 0 && s.estimatedReliability > 0 && s.estimatedReliability < 1, s.id);
    assert.ok(TRUTH.includes(s.truthLayer), s.id);
    for (const d of s.destinations) assert.ok(DEST_IDS.includes(d), `${s.id} dest ${d}`);
    for (const v of s.compatibleVehicles || []) assert.ok(data.index.vehicles[v], `${s.id} vehicle ${v}`);
  }
});

test('data: destinations use the fixed vocabulary, routes and milestones', () => {
  const ids = data.destinations.destinations.map((d) => d.id).sort();
  assert.deepEqual(ids, DEST_IDS.slice().sort());
  const nodes = new Set(data.destinations.routeNodes.map((n) => n.id));
  for (const d of data.destinations.destinations) {
    assert.ok(['leo', 'gto', 'tli', 'mars', 'outer'].includes(d.capacityKey), d.id);
    assert.ok(d.route.length >= 1 && d.route.every((r) => r.dv > 0 && nodes.has(r.from) && nodes.has(r.to)), `${d.id} route`);
    for (const m of d.arrivalMilestones) {
      assert.ok(m.id && m.label && m.pFail > 0 && m.pFail < 0.2 && m.radio?.length, `${d.id}/${m.id}`);
      const w = Object.values(m.failureWeights).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(w - 1) < 0.01, `${d.id}/${m.id} weights sum to 1`);
    }
    for (const f of Object.values(d.firsts)) assert.ok(FIRSTS.includes(f), `${d.id} first ${f}`);
  }
  const ms = data.index.destinations.mars_surface;
  assert.deepEqual(ms.arrivalMilestones.map((m) => m.id), ['entry', 'parachute', 'powered_descent', 'touchdown']);
  assert.deepEqual(data.index.destinations.lunar_surface.arrivalMilestones.map((m) => m.id), ['loi', 'descent', 'hazard_avoidance', 'touchdown']);
  assert.deepEqual(data.index.destinations.lunar_orbit.arrivalMilestones.map((m) => m.id), ['loi']);
});

test('data: calendar items are complete and consistent', () => {
  const items = data.calendar.missions;
  assert.ok(items.length >= 40);
  for (const id of ['artemis2', 'change7', 'gaganyaan_g1', 'gaganyaan_h1', 'artemis3', 'artemis4', 'artemis5', 'change8', 'dragonfly', 'rosalind_franklin',
    'tianwen3', 'tianwen4', 'china_crewed_landing', 'iss_deorbit', 'haven1', 'starship_prop_transfer', 'blue_moon_pathfinder', 'bas1']) {
    assert.ok(data.index.calendar[id], `calendar ${id}`);
  }
  for (const m of items) {
    assert.ok(ACTORS.includes(m.owner), `${m.id} owner`);
    for (const p of m.partners) assert.ok(ACTORS.includes(p), `${m.id} partner ${p}`);
    assert.ok(TYPES.includes(m.type), `${m.id} type`);
    assert.ok(DEST_IDS.includes(m.destination), `${m.id} destination`);
    assert.ok(data.index.vehicles[m.vehicleId], `${m.id} vehicle`);
    assert.ok(data.index.spacecraft[m.spacecraftId], `${m.id} spacecraft`);
    if (m.secondarySpacecraftId) assert.ok(data.index.spacecraft[m.secondarySpacecraftId], `${m.id} secondary`);
    assert.ok(TRUTH.includes(m.truthLayer), `${m.id} truthLayer`);
    assert.ok(m.planned.year >= 2026 && m.planned.year <= 2030 && m.planned.month >= 1 && m.planned.month <= 12, `${m.id} planned`);
    const d = m.delay;
    assert.ok(d.slipChance >= 0 && d.slipChance < 1 && d.meanMonths >= 0 && d.sdMonths >= 0 && d.maxMonths >= 0, `${m.id} delay`);
    for (const p of m.prerequisites) assert.ok(data.index.calendar[p], `${m.id} prereq ${p}`);
    if (m.milestone) assert.ok(FIRSTS.includes(m.milestone), `${m.id} milestone`);
    assert.ok(m.description?.length > 20 && m.statusNov2026 && m.source?.startsWith('https://'), `${m.id} texts`);
    // the vehicle can actually carry the spacecraft there
    const cap = cal.capacityTo(data, m.vehicleId, m.destination);
    assert.ok(cap >= data.index.spacecraft[m.spacecraftId].massT, `${m.id}: ${m.vehicleId} carries ${cap} t < ${data.index.spacecraft[m.spacecraftId].massT} t`);
    if (m.crewed) assert.ok(data.index.vehicles[m.vehicleId].crewRated, `${m.id} crew-rated vehicle`);
  }
  // no prerequisite cycles
  const seen = {};
  const visit = (id, stack) => {
    assert.ok(!stack.includes(id), `cycle ${stack.join('>')}>${id}`);
    if (seen[id]) return;
    seen[id] = true;
    for (const p of data.index.calendar[id].prerequisites) visit(p, [...stack, id]);
  };
  for (const m of items) visit(m.id, []);
  // Artemis II is a fact with no delay
  const a2 = data.index.calendar.artemis2;
  assert.equal(a2.truthLayer, 'fato');
  assert.equal(a2.delay.slipChance, 0);
});

test('official dates and mission names live only in data, not in code', async () => {
  const src = await readFile(path.join(root, 'src/sim/calendar.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\b20[2-9]\d\b/.test(code), 'no years in calendar.js');
  for (const m of data.calendar.missions) assert.ok(!code.includes(`'${m.id}'`) && !code.includes(m.name), `no "${m.id}" in code`);
  for (const v of data.vehicles.vehicles) assert.ok(!code.includes(`'${v.id}'`), `no vehicle "${v.id}" in code`);
  assert.ok(!/Math\.random|Date\.now/.test(code));
});

test('init: instances, vehicleStats from history, player-owned items', () => {
  const s = run(1, 'cnsa', 0);
  assert.equal(s.calendar.length, data.calendar.missions.length);
  assert.equal(s.vehicleStats.falcon9.flights, data.index.vehicles.falcon9.history.flights);
  const c7 = s.calendar.find((c) => c.id === 'change7');
  assert.equal(c7.status, 'player');
  assert.equal(s.calendar.find((c) => c.id === 'artemis4').status, 'planned');
  // planned month round-trips through formatTurn
  for (const c of s.calendar) {
    const m = data.index.calendar[c.id].planned;
    if (data.index.destinations[data.index.calendar[c.id].destination].window) continue;
    assert.equal(formatTurn(c.plannedTurn, 2026), `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][m.month - 1]}/${m.year}`, c.id);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s.calendar)), s.calendar);
});

test('determinism: same seed same world; different seeds diverge', () => {
  const a = run(7);
  const b = run(7);
  assert.equal(JSON.stringify(a.calendar), JSON.stringify(b.calendar));
  assert.equal(JSON.stringify(a.vehicleStats), JSON.stringify(b.vehicleStats));
  assert.equal(JSON.stringify(a.news), JSON.stringify(b.news));
  const c = run(8);
  assert.notEqual(JSON.stringify(a.calendar.map((x) => x.currentTurn)), JSON.stringify(c.calendar.map((x) => x.currentTurn)));
});

test('save/load mid-game does not change the outcome', () => {
  const full = run(11);
  const state = createState(data, { seed: 11, playerId: 'spectator' });
  let s = state;
  const ctx = () => ({ data, rng: (l = '') => rngFor(s.seed, s.turn, 'calendar', l), date: turnToDate(s.turn, s.startYear) });
  cal.init(s, data, ctx());
  while (s.turn <= s.endTurn) {
    if (s.turn === 100) s = JSON.parse(JSON.stringify(s));
    s.signals = s.signalsPending;
    s.signalsPending = [];
    cal.tick(s, data, ctx());
    s.turn++;
  }
  assert.equal(JSON.stringify(s.calendar), JSON.stringify(full.calendar));
});

test('delays are plausible across 20 seeds', () => {
  const runs = Array.from({ length: 20 }, (_, i) => run(1000 + i));
  const delayOf = (s, id) => {
    const c = s.calendar.find((x) => x.id === id);
    const launched = c.history[0]?.turn;
    return launched == null ? null : launched - c.plannedTurn;
  };
  // Artemis II: fact, flies on time and succeeds
  for (const s of runs) {
    const a2 = s.calendar.find((x) => x.id === 'artemis2');
    assert.equal(a2.status, 'success');
    assert.equal(delayOf(s, 'artemis2'), 0);
    assert.equal(s.firsts.crewed_lunar_flyby.actorId, 'nasa');
  }
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const d = (id) => runs.map((s) => delayOf(s, id)).filter((x) => x != null);
  // nothing launches before its official date; total delays bounded
  for (const s of runs) for (const c of s.calendar) if (c.history[0]) assert.ok(c.history[0].turn >= c.plannedTurn, c.id);
  // Chinese programs are methodical; Artemis slips more
  assert.ok(med(d('china_crewed_landing')) < 26, 'China lands close to plan');
  const a3 = d('artemis3');
  assert.ok(a3.length >= 15 && med(a3) > 0 && med(a3) < 104, `Artemis III median ${med(a3)}`);
  assert.ok(med(d('china_lunar_rehearsal')) <= med(a3) + 13);
  // the crewed landing race is open: both NASA and China win some seeds
  const winners = runs.map((s) => s.firsts.crewed_lunar_landing?.actorId).filter(Boolean);
  assert.ok(winners.length >= 15, 'someone lands with crew by 2030 in most seeds');
  assert.ok(new Set(winners).size >= 2, `race not decided in advance: ${winners.join(',')}`);
  // something slips in every world, but not everything
  for (const s of runs) {
    const slipped = s.calendar.filter((c) => c.delayWeeks > 0).length;
    assert.ok(slipped > 5 && slipped < s.calendar.length, `slipped ${slipped}`);
  }
  // Mars missions respect the windows (launch only while open)
  for (const s of runs) for (const id of ['rosalind_franklin', 'tianwen3', 'mmx']) {
    const c = s.calendar.find((x) => x.id === id);
    if (c.history[0]) assert.ok(cal.nextWindow(s, data, 'mars_surface', c.history[0].turn).isOpen, `${id} in window`);
  }
});

test('prerequisites gate launches', () => {
  // NASA is the player and never flies Artemis III: Artemis IV is player-owned too, but Starlab etc. keep going.
  // With the player as SpaceX that never flies the HLS demo, NASA's Artemis IV must wait forever.
  const s = run(3, 'spacex');
  const a4 = s.calendar.find((x) => x.id === 'artemis4');
  assert.equal(a4.status, 'planned');
  assert.equal(a4.history.length, 0);
  assert.ok(a4.currentTurn > s.endTurn - 10);
  const st = cal.prerequisiteStatus(s, data, 'artemis4');
  assert.equal(st.ok, false);
  assert.ok(st.pending.includes('starship_hls_demo'));
  // a player mission resolving its calendar item unlocks dependents
  const s2 = run(3, 'spacex', 60, (state) => {
    state.missions = [{ id: 'm1', calendarId: 'starship_prop_transfer', status: 'done', result: { outcome: 'total', phase: 'ascent' } },
      { id: 'm2', calendarId: 'starship_hls_demo', status: 'done', result: { outcome: 'total', phase: 'arrival' } },
      { id: 'm3', calendarId: 'starship_v3_debut', status: 'done', result: { outcome: 'total', phase: 'ascent' } }];
  });
  assert.ok(!cal.prerequisiteStatus(s2, data, 'artemis4').pending.includes('starship_hls_demo'));
});

test('catalog: reliability, capacity, windows', () => {
  const s = run(5, 'nasa', 0);
  const f9 = cal.vehicleReliability(s, data, 'falcon9');
  assert.ok(f9.mean > 0.98 && f9.low <= f9.mean && f9.mean <= f9.high);
  const ss = cal.vehicleReliability(s, data, 'starship');
  assert.ok(ss.mean < 0.85 && ss.high - ss.low > f9.high - f9.low, 'new vehicles are less certain');
  const lm10 = cal.vehicleReliability(s, data, 'long_march_10');
  assert.ok(lm10.flights === 0 && lm10.mean > 0.8 && lm10.mean < 0.9);
  assert.ok(cal.spacecraftReliability(s, data, 'crew_dragon').mean > 0.95);
  assert.equal(cal.capacityTo(data, 'sls_b1', 'cislunar'), 27);
  assert.equal(cal.capacityTo(data, 'falcon9', 'mars_surface'), 2.5);
  assert.equal(cal.capacityTo(data, 'electron', 'gto'), 0);
  assert.ok(cal.capacityTo(data, 'falcon9', 'iss') < cal.capacityTo(data, 'falcon9', 'leo'));
  // Mars windows: open around Oct-Dec 2026 and Nov 2028-Feb 2029
  const w1 = cal.nextWindow(s, data, 'mars_surface', 0);
  assert.equal(formatTurn(w1.openTurn, 2026), 'out/2026');
  const w2 = cal.nextWindow(s, data, 'mars_surface', w1.closeTurn);
  assert.equal(formatTurn(w2.openTurn, 2026), 'nov/2028');
  assert.ok(w2.openTurn - w1.openTurn >= 110 && w2.openTurn - w1.openTurn <= 115);
  const inside = cal.nextWindow(s, data, 'mars_surface', w1.openTurn + 2);
  assert.equal(inside.isOpen, true);
  assert.equal(inside.openTurn, w1.openTurn);
  const lunar = cal.nextWindow(s, data, 'lunar_surface', 17);
  assert.equal(lunar.openTurn, 17);
  assert.equal(lunar.closeTurn, Infinity);
});

test('catalog: access by operator, embargo, bloc and tension', () => {
  const s = run(5, 'esa', 0);
  const ids = (a) => cal.availableVehicles(s, data, a).map((v) => v.id);
  assert.ok(ids('nasa').includes('falcon9') && ids('nasa').includes('sls_b1'));
  assert.ok(!ids('cnsa').includes('falcon9'), 'US embargo on China');
  assert.ok(ids('cnsa').includes('long_march_5'));
  assert.ok(!ids('cnsa').includes('long_march_10'), 'not before its debut');
  assert.ok(!ids('nasa').includes('long_march_5'));
  assert.ok(ids('esa').includes('sls_b1'), 'Artemis Accords partner gets SLS (bloc from data)');
  assert.ok(!ids('cnsa').includes('sls_b1') && !ids('roscosmos').includes('sls_b1'));
  s.actors = { nasa: { id: 'nasa', bloc: 'x' }, esa: { id: 'esa', bloc: 'y' } };
  s.blocs = {};
  assert.ok(!ids('esa').includes('sls_b1'), 'leaving the bloc loses SLS');
  s.treaties = [{ id: 't1', type: 'mission_partnership', parties: ['esa', 'nasa'], status: 'active' }];
  assert.ok(ids('esa').includes('sls_b1'), 'an active treaty restores access');
  assert.ok(ids('esa').includes('falcon9'));
  s.tension[relKey('esa', 'spacex')] = 3;
  assert.ok(!ids('esa').includes('falcon9'), 'tension 3 blocks the launcher');
  const card = cal.queries['catalog/vehicles'](s, data, 'esa').find((v) => v.id === 'falcon9');
  assert.equal(card.available, false);
  assert.match(card.access.reason, /tensão/i);
  const sc = cal.availableSpacecraft(s, data, 'isro').map((x) => x.id);
  assert.ok(sc.includes('gaganyaan') && sc.includes('generic_sat') && !sc.includes('mengzhou'));
});

test('recordFlight updates stats and grounds the fleet on failure', () => {
  const s = run(5, 'nasa', 0);
  const before = s.vehicleStats.vulcan.flights;
  cal.recordFlight(s, 'vulcan', true);
  assert.equal(s.vehicleStats.vulcan.flights, before + 1);
  assert.equal(cal.isGrounded(s, 'vulcan'), false);
  const m0 = cal.vehicleReliability(s, data, 'vulcan').mean;
  cal.recordFlight(s, 'vulcan', false);
  assert.equal(cal.isGrounded(s, 'vulcan'), true);
  assert.ok(cal.vehicleReliability(s, data, 'vulcan').mean < m0);
  cal.recordFlight(s, 'unknown_vehicle', true); // never throws
});

test('rival launches: firsts, news, signals and stats', () => {
  const s = run(21);
  const resolved = s.calendar.filter((c) => ['success', 'partial', 'failed'].includes(c.status));
  assert.ok(resolved.length > 20);
  for (const c of resolved) assert.ok(c.outcome && c.resolvedTurn != null && c.history.length > 0);
  assert.ok(Object.keys(s.firsts).length >= 5);
  assert.ok(s.stats['calendar.backgroundLaunches'] > 500);
  assert.ok(s.news.some((n) => n.tags.includes('delay')));
  assert.ok(s.vehicleStats.falcon9.flights > data.index.vehicles.falcon9.history.flights + 500);
  // signals exist in the expected shape during the run
  const s2 = run(21, 'spectator', 60);
  const sig = [...s2.signals, ...s2.signalsPending];
  for (const x of sig) assert.ok(['calendar/delayed', 'mission/resolved', 'mission/launched', 'first'].includes(x.type));
});

test('open war suspends or cancels the owner programs', () => {
  const peace = run(31);
  const war = run(31, 'spectator', null, (state) => { state.tension[relKey('cnsa', 'nasa')] = 4; });
  const delay = (s) => s.calendar.filter((c) => ['cnsa', 'nasa'].includes(data.index.calendar[c.id].owner)).reduce((a, c) => a + c.delayWeeks + (c.status === 'cancelled' ? 100 : 0), 0);
  assert.ok(delay(war) > delay(peace) * 1.3, `war ${delay(war)} vs peace ${delay(peace)}`);
});

test('queries return UI-ready views', () => {
  const s = run(2, 'isro', 40);
  const up = cal.queries['calendar/upcoming'](s, data, 5);
  assert.equal(up.length, 5);
  for (let i = 1; i < up.length; i++) assert.ok(up[i].sortTurn >= up[i - 1].sortTurn);
  assert.ok(up.every((u) => u.name && u.truthLabel && u.currentText && u.statusLabel));
  const all = cal.queries['calendar/all'](s, data);
  assert.equal(all.length, data.calendar.missions.length);
  assert.ok(all.filter((x) => x.isPlayer).every((x) => x.owner === 'isro'));
  const dests = cal.queries['catalog/destinations'](s, data);
  assert.equal(dests.length, 12);
  assert.ok(dests.find((d) => d.id === 'mars_surface').windowInfo.text.length > 5);
  assert.ok(dests.every((d) => d.totalDv > 9));
  const w = cal.queries['catalog/window'](s, data, 'leo');
  assert.equal(w.alwaysOpen, true);
  assert.equal(cal.queries['calendar/get'](s, data, 'artemis4').name, 'Artemis IV');
  assert.ok(cal.queries['catalog/spacecraft'](s, data, 'isro').length === data.spacecraft.spacecraft.length);
  JSON.stringify(cal.queries['catalog/vehicles'](s, data)); // serializable
});

test('works with stub/missing data of other modules', () => {
  const thin = { ...data, actors: { actors: [] }, tech: { nodes: [] } };
  const state = createState(thin, { seed: 9, playerId: 'nasa' });
  delete state.tension;
  state.world = undefined;
  const ctx = () => ({ data: thin, rng: (l = '') => rngFor(state.seed, state.turn, 'calendar', l), date: turnToDate(state.turn, state.startYear) });
  cal.init(state, thin, ctx());
  for (let i = 0; i < 80; i++) { state.signals = []; cal.tick(state, thin, ctx()); state.turn++; }
  assert.ok(state.calendar.some((c) => c.history.length));
  assert.ok(!state.log.some((l) => l.includes('falha')));
});

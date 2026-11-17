// Tests for src/sim/risk.js and src/core/outcome.js (launch-core).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame } from '../src/core/engine.js';
import { makeRng } from '../src/core/rng.js';
import { missionRisk } from '../src/sim/risk.js';
import { quickOutcome, OUTCOMES, FAILURE_TYPES, FAILURE_LABELS, OUTCOME_LABELS, pickFailureType } from '../src/core/outcome.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const has = (kind, id) => !!data.index?.[kind]?.[id];

function crewOf(state, actorId) {
  const ppl = Object.values(state.crew || {}).filter((p) => p.actorId === actorId && (!p.status || p.status === 'active'));
  const best = (role) => ppl.filter((p) => p.role === role).sort((a, b) => b.skill - a.skill)[0]?.id || null;
  return { flightDirector: best('flight_director'), commander: best('astronaut') };
}

function plan(state, over = {}) {
  const c = crewOf(state, state.playerId);
  return {
    actorId: state.playerId, type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat',
    crew: { flightDirector: c.flightDirector, commander: null, astronauts: [] },
    config: { strategy: 'balanced', fuelMargin: 0.1 }, launchTurn: 20, createdTurn: 0, ...over,
  };
}

const nasa = newGame(data, { seed: 42, playerId: 'nasa' });

test('outcome vocabulary is complete and labelled in pt-BR', () => {
  assert.deepEqual(OUTCOMES, ['total', 'partial', 'recoverable', 'catastrophic']);
  assert.equal(FAILURE_TYPES.length, 5);
  for (const t of FAILURE_TYPES) assert.ok(FAILURE_LABELS[t]);
  for (const o of OUTCOMES) assert.ok(OUTCOME_LABELS[o]);
});

test('quickOutcome: total rate ~p, deterministic, all types reachable', () => {
  const rng = makeRng(123);
  let total = 0;
  const seen = new Set();
  const levels = new Set();
  for (let i = 0; i < 20000; i++) {
    const o = quickOutcome(rng, 0.8);
    if (o.level === 'total') total++;
    else { seen.add(o.failureType); levels.add(o.level); }
  }
  assert.ok(Math.abs(total / 20000 - 0.8) < 0.015, `rate ${total / 20000}`);
  assert.equal(seen.size, 5);
  assert.equal(levels.size, 3);
  const a = quickOutcome(makeRng(9), 0.5);
  const b = quickOutcome(makeRng(9), 0.5);
  assert.deepEqual(a, b);
  assert.equal(pickFailureType(() => 0.01, { propulsion: 0, structure: 1 }), 'structure');
});

test('Falcon 9 to LEO is very reliable and valid', () => {
  const r = missionRisk(nasa, data, plan(nasa));
  assert.equal(r.valid, true, r.errors.join(';'));
  assert.ok(r.p >= 0.95 && r.p <= 0.995, `p=${r.p}`);
  assert.ok(r.low <= r.p && r.p <= r.high);
  assert.ok(r.high - r.low < 0.08, 'experienced vehicle -> narrow band');
  assert.deepEqual(r.milestones.map((m) => m.id), ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit']);
  for (const m of r.milestones) {
    assert.ok(m.pFail > 0 && m.pFail < 0.2);
    assert.ok(m.anomalyBand > 0);
    const w = m.failureWeights;
    assert.deepEqual(Object.keys(w).sort(), [...FAILURE_TYPES].sort());
    assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 0.02);
  }
  // product of milestones = p
  const prod = r.milestones.reduce((p, m) => p * (1 - m.pFail), 1);
  assert.ok(Math.abs(prod - r.p) < 0.005);
});

test('missionRisk is pure (does not mutate state)', () => {
  const before = JSON.stringify(nasa);
  missionRisk(nasa, data, plan(nasa));
  missionRisk(nasa, data, plan(nasa, { destination: 'lunar_surface', vehicleId: 'sls_b1b', spacecraftId: 'generic_lander', type: 'lander' }));
  assert.equal(JSON.stringify(nasa), before);
});

test('new vehicles are noticeably riskier with wider bands', () => {
  const f9 = missionRisk(nasa, data, plan(nasa));
  for (const id of ['starship', 'new_glenn', 'sls_b1b'].filter((x) => has('vehicles', x))) {
    const r = missionRisk(nasa, data, plan(nasa, { vehicleId: id }));
    assert.ok(r.p < f9.p - 0.02, `${id} p=${r.p} vs f9 ${f9.p}`);
    assert.ok(r.high - r.low > f9.high - f9.low, `${id} band`);
  }
});

test('strategy: conservative safer and less prestige; aggressive the opposite', () => {
  const c = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship', config: { strategy: 'conservative', fuelMargin: 0.1 } }));
  const b = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship', config: { strategy: 'balanced', fuelMargin: 0.1 } }));
  const a = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship', config: { strategy: 'aggressive', fuelMargin: 0.1 } }));
  assert.ok(c.p > b.p && b.p > a.p);
  assert.ok(c.prestigeMult < b.prestigeMult && b.prestigeMult < a.prestigeMult);
});

test('fuel margin: more margin = safer but less payload', () => {
  const lo = missionRisk(nasa, data, plan(nasa, { config: { strategy: 'balanced', fuelMargin: 0 } }));
  const hi = missionRisk(nasa, data, plan(nasa, { config: { strategy: 'balanced', fuelMargin: 0.3 } }));
  assert.ok(hi.p > lo.p);
  assert.ok(hi.payload.effectiveT < lo.payload.effectiveT);
});

test('rushing, missing flight director and global tension lower the odds', () => {
  const base = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship' }));
  const rushed = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship', createdTurn: 19, launchTurn: 20 }));
  assert.ok(rushed.p < base.p);
  assert.ok(rushed.warnings.length > 0);
  const noFd = missionRisk(nasa, data, plan(nasa, { vehicleId: 'starship', crew: { flightDirector: null, commander: null, astronauts: [] } }));
  assert.ok(noFd.p < base.p);
  assert.ok(noFd.high - noFd.low > base.high - base.low, 'band is wider without flight director');
  const tense = JSON.parse(JSON.stringify(nasa));
  tense.world = { ...(tense.world || {}), globalTension: 4 };
  assert.ok(missionRisk(tense, data, plan(tense, { vehicleId: 'starship' })).p < base.p);
});

test('weather on launch day changes the odds', () => {
  const calm = missionRisk(nasa, data, plan(nasa, { weather: { label: 'Céu limpo', risk: 0.02 } }));
  const storm = missionRisk(nasa, data, plan(nasa, { weather: { label: 'Tempestade', risk: 0.6 } }));
  assert.ok(storm.p < calm.p);
  const mq = (r) => r.milestones.find((m) => m.id === 'maxq');
  assert.ok(mq(storm).failureWeights.environment > mq(calm).failureWeights.environment);
});

test('validation: payload, crew rating, destination and vehicle compatibility', () => {
  const heavy = missionRisk(nasa, data, plan(nasa, { config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: 500 } }));
  assert.equal(heavy.valid, false);
  assert.match(heavy.errors.join(' '), /excede/);
  if (has('spacecraft', 'starship_hls')) {
    const r = missionRisk(nasa, data, plan(nasa, { type: 'crewed', crewed: true, vehicleId: 'starship', spacecraftId: 'starship_hls', destination: 'lunar_surface' }));
    assert.equal(r.valid, false);
    assert.match(r.errors.join(' '), /certificado/);
  }
  if (has('spacecraft', 'crew_dragon')) {
    const r = missionRisk(nasa, data, plan(nasa, { type: 'crewed', crewed: true, spacecraftId: 'crew_dragon', destination: 'lunar_surface' }));
    assert.equal(r.valid, false);
    const r2 = missionRisk(nasa, data, plan(nasa, { type: 'crewed', crewed: true, vehicleId: 'atlas_v', spacecraftId: 'crew_dragon', destination: 'leo' }));
    assert.equal(r2.valid, false, 'crew_dragon only flies on falcon9');
  }
  const crewedSat = missionRisk(nasa, data, plan(nasa, { type: 'crewed', crewed: true, spacecraftId: 'generic_sat' }));
  assert.equal(crewedSat.valid, false);
  const electronMoon = missionRisk(nasa, data, plan(nasa, { vehicleId: 'electron', destination: 'mars_orbit', spacecraftId: 'generic_probe', type: 'probe' }));
  assert.equal(electronMoon.valid, false);
});

test('lunar destinations add TLI and data arrival milestones; crewedOnly filtered for robots', () => {
  const r = missionRisk(nasa, data, plan(nasa, { type: 'lander', destination: 'lunar_surface', vehicleId: 'sls_b1b', spacecraftId: 'generic_lander' }));
  const asc = r.milestones.filter((m) => m.phase === 'ascent').map((m) => m.id);
  const arr = r.milestones.filter((m) => m.phase === 'arrival').map((m) => m.id);
  assert.ok(asc.includes('tli'));
  const expected = (data.index.destinations.lunar_surface.arrivalMilestones || []).filter((m) => !m.crewedOnly).map((m) => m.id);
  assert.deepEqual(arr, expected);
  assert.ok(r.pArrival < 0.95);
  const fly = data.index.destinations.cislunar;
  if (fly?.arrivalMilestones?.some((m) => m.crewedOnly)) {
    const robot = missionRisk(nasa, data, plan(nasa, { type: 'probe', destination: 'cislunar', vehicleId: 'falconheavy', spacecraftId: 'generic_probe' }));
    assert.ok(robot.milestones.filter((m) => m.phase === 'arrival').every((m) => !fly.arrivalMilestones.find((x) => x.id === m.id)?.crewedOnly));
  }
});

test('first crewed lunar landing lands in the 60-85% range depending on choices', () => {
  if (!has('vehicles', 'long_march_10') || !has('spacecraft', 'lanyue')) return;
  const cn = newGame(data, { seed: 7, playerId: 'cnsa' });
  const c = crewOf(cn, 'cnsa');
  const p = (strategy) => missionRisk(cn, data, {
    actorId: 'cnsa', type: 'crewed', crewed: true, destination: 'lunar_surface', vehicleId: 'long_march_10', spacecraftId: 'lanyue',
    crew: { flightDirector: c.flightDirector, commander: c.commander, astronauts: [c.commander] }, config: { strategy, fuelMargin: 0.03 }, launchTurn: 200, createdTurn: 100,
  });
  const cons = p('conservative');
  const aggr = p('aggressive');
  assert.equal(cons.valid, true, cons.errors.join(';'));
  assert.ok(cons.p <= 0.88 && aggr.p >= 0.6, `cons ${cons.p} aggr ${aggr.p}`);
  // weaker crew lowers it
  const weak = missionRisk(cn, data, { ...p('balanced'), actorId: 'cnsa', type: 'crewed', crewed: true, destination: 'lunar_surface', vehicleId: 'long_march_10', spacecraftId: 'lanyue', crew: { flightDirector: null, commander: c.commander, astronauts: [c.commander] }, config: { strategy: 'balanced', fuelMargin: 0.03 }, launchTurn: 200, createdTurn: 100 });
  assert.ok(weak.p < p('balanced').p);
});

test('missing data never throws', () => {
  const r = missionRisk(nasa, data, { vehicleId: 'nope', destination: 'nowhere' });
  assert.equal(r.valid, false);
  assert.ok(Number.isFinite(r.p));
  const r2 = missionRisk({}, { index: {} }, {});
  assert.equal(r2.valid, false);
});

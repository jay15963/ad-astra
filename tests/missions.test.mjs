// Tests for src/sim/missions.js. Uses self-contained fixture catalogs (so they do not depend on the
// content of data/*.json) on top of the real scenario/politics/tech/events/crew files.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, createState, resolveDecision, dispatch } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as missions from '../src/sim/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = await loadDataNode(root);
const PID = 'nasa';

function fixtureData() {
  const actor = (id, name, kind, extra = {}) => ({
    id, name, short: name, kind, country: 'XX', flag: '', color: '#888888', bloc: null, budget: 5000, fixedCostShare: 0.5,
    support: 60, reputation: 60, culture: 10, prestige: 0, style: '', capabilities: { crewed: true, launchSites: ['X'] },
    ai: { cooperation: 0.5, aggression: 0.5, riskTolerance: 0.5, goals: [] }, ...extra,
  });
  const veh = (id, operator, costM, capacity, extra = {}) => ({
    id, name: id.toUpperCase(), operator, country: 'XX', availableFrom: { year: 2010, month: 1 }, truthLayer: 'fato', costM,
    cadencePerYear: 20, history: { flights: 100, failures: 2 }, reusable: false, crewRated: false, capacity, notes: '', ...extra,
  });
  const sc = (id, kind, crew, massT, costM, destinations, extra = {}) => ({
    id, name: id.toUpperCase(), operator: PID, kind, crew, massT, costM, availableFrom: { year: 2010, month: 1 }, truthLayer: 'fato',
    estimatedReliability: 0.97, destinations, notes: '', ...extra,
  });
  const dest = (id, body, capacityKey, transitWeeks, extra = {}) => ({
    id, name: id.replace(/_/g, ' '), body, kind: 'orbit', capacityKey, route: [], transitWeeks, window: null, arrivalMilestones: [], firsts: {}, ...extra,
  });
  const data = {
    ...real,
    actors: {
      actors: [actor('nasa', 'NASA', 'agency'), actor('spacex', 'SpaceX', 'company'), actor('cnsa', 'CNSA', 'agency')],
      relations: [{ a: 'nasa', b: 'cnsa', trust: -20, dependence: 0, rivalry: 70 }, { a: 'nasa', b: 'spacex', trust: 40, dependence: 30, rivalry: 20 }],
      blocs: [], treaties: [],
    },
    vehicles: { vehicles: [
      veh('t_small', PID, 60, { leo: 20, gto: 6, tli: 4, mars: 3, outer: 0 }),
      veh('t_heavy', PID, 900, { leo: 95, gto: 40, tli: 40, mars: 20, outer: 8 }, { crewRated: true, history: { flights: 6, failures: 0 }, estimatedReliability: 0.93 }),
      veh('t_rival', 'spacex', 55, { leo: 22, gto: 8, tli: 5, mars: 4, outer: 0 }, { crewRated: true }),
    ] },
    spacecraft: { spacecraft: [
      sc('t_sat', 'satellite', 0, 3, 40, []),
      sc('t_capsule', 'capsule', 4, 26, 600, ['leo', 'iss', 'cislunar', 'lunar_orbit', 'lunar_surface']),
      sc('t_lander', 'lander', 0, 2, 120, ['lunar_surface', 'lunar_south_pole']),
      sc('t_probe', 'probe', 0, 1.5, 200, ['mars_orbit', 'lunar_orbit', 'cislunar']),
      sc('t_cargo', 'cargo', 0, 6, 80, ['iss', 'leo']),
    ] },
    destinations: { destinations: [
      dest('leo', 'earth', 'leo', 0),
      dest('sso', 'earth', 'leo', 0),
      dest('gto', 'earth', 'gto', 0),
      dest('iss', 'earth', 'leo', 0),
      dest('cislunar', 'moon', 'tli', 1),
      dest('lunar_orbit', 'moon', 'tli', 1, { firsts: { crewed: 'crewed_lunar_orbit' } }),
      dest('lunar_surface', 'moon', 'tli', 1, {
        arrivalMilestones: [{ id: 'descent', label: 'Descida', pFail: 0.08, failureWeights: { propulsion: 1 } }],
        firsts: { crewed: 'crewed_lunar_landing' },
      }),
      dest('mars_orbit', 'mars', 'mars', 30, { window: { periodWeeks: 113, phaseTurn: 60, openWeeks: 8 } }),
    ] },
    calendar: { missions: [{
      id: 't_cal_lander', name: 'Pousador Teste', owner: PID, partners: [], type: 'lander', destination: 'lunar_surface',
      vehicleId: 't_small', spacecraftId: 't_lander', crewed: false, planned: { year: 2026, month: 4 }, truthLayer: 'plano_oficial',
      delay: { slipChance: 0, meanMonths: 0, sdMonths: 0, maxMonths: 0 }, prerequisites: [], milestone: 'lunar_resource_demo',
      statusNov2026: '', source: '', description: 'Pousador de teste do programa.',
    }] },
  };
  data.index = { ...(real.index || {}) };
  for (const [k, list] of Object.entries({
    actors: data.actors.actors, vehicles: data.vehicles.vehicles, spacecraft: data.spacecraft.spacecraft,
    destinations: data.destinations.destinations, calendar: data.calendar.missions,
  })) data.index[k] = Object.fromEntries(list.map((x) => [x.id, x]));
  return data;
}

const person = (id, role, name) => ({
  id, name, role, actorId: PID, skill: 60, experience: 1, traits: [], loyalty: 60, ambition: 40, morale: 70, status: 'active',
  bio: '', history: [], legend: false, salaryM: 0.1, hiredTurn: 0,
  portrait: { skin: 0, hair: 0, hairColor: 0, eyes: 0, brows: 0, mouth: 0, accessory: 0, suit: 0, bg: 0 },
});

function setup(seed = 1234) {
  const data = fixtureData();
  let state;
  try {
    state = newGame(data, { seed, playerId: PID });
  } catch {
    state = createState(data, { seed, playerId: PID });
    for (const a of data.actors.actors) state.actors[a.id] = { ...a, cash: a.budget * 0.25 };
    missions.init(state, data, {});
  }
  for (const a of data.actors.actors) if (!state.actors[a.id]) state.actors[a.id] = { ...a, cash: 1000 };
  state.actors[PID].cash = 50000;
  state.actors[PID].support = 60;
  state.actors[PID].reputation = 60;
  state.actors[PID].prestige = 0;
  state.crew = state.crew || {};
  for (const p of [person('t_fd', 'flight_director', 'Ana Diretora'), person('t_a1', 'astronaut', 'Bia Comandante'),
    person('t_a2', 'astronaut', 'Caio'), person('t_a3', 'astronaut', 'Duda'), person('t_a4', 'astronaut', 'Eli')]) state.crew[p.id] = p;
  // no stray decisions/missions from other modules' init: tests start clean
  state.decisions = [];
  state.missions = [];
  state.contracts = [];
  return { data, state };
}

const ctxFor = (state, data) => ({
  data, rng: (label = '') => rngFor(state.seed, state.turn, 'missions', label), date: turnToDate(state.turn, state.startYear),
});
const act = (state, data, action) => missions.actions[action.type](state, data, action, ctxFor(state, data));
const q = (state, data, name, ...args) => missions.queries[name](state, data, ...args);

const satDraft = { type: 'satellite', destination: 'leo', vehicleId: 't_small', spacecraftId: 't_sat', crew: { flightDirector: 't_fd' } };
const crewedDraft = {
  type: 'crewed', destination: 'leo', vehicleId: 't_heavy', spacecraftId: 't_capsule',
  crew: { flightDirector: 't_fd', commander: 't_a1', astronauts: ['t_a2'] }, config: { strategy: 'balanced', fuelMargin: 0.1 },
};

test('init creates slices and state stays JSON-serializable', () => {
  const { state } = setup();
  assert.ok(Array.isArray(state.missions));
  assert.ok(Array.isArray(state.contracts));
  assert.deepEqual(JSON.parse(JSON.stringify(state.missions)), state.missions);
});

test('create → schedule charges the cost and validates timing', () => {
  const { data, state } = setup();
  const r = act(state, data, { type: 'mission/create', draft: satDraft });
  assert.equal(r.ok, true);
  const m = state.missions.find((x) => x.id === r.missionId);
  assert.equal(m.status, 'planning');
  assert.ok(m.cost > 60, 'cost includes vehicle + spacecraft + ops');
  assert.equal(m.cost, missions.computeCost(state, data, m).total);
  assert.ok(m.estimate.p > 0 && m.estimate.p < 1);

  const tooEarly = act(state, data, { type: 'mission/schedule', missionId: m.id, launchTurn: state.turn });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /Preparação mínima/);

  const cash0 = state.actors[PID].cash;
  const ok = act(state, data, { type: 'mission/schedule', missionId: m.id });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(m.status, 'scheduled');
  assert.equal(m.paid, true);
  assert.ok(Math.abs(cash0 - state.actors[PID].cash - m.cost) < 0.01, 'cash reduced by the cost');

  // rescheduling does not charge again
  const cash1 = state.actors[PID].cash;
  const re = act(state, data, { type: 'mission/schedule', missionId: m.id, launchTurn: m.launchTurn + 2 });
  assert.equal(re.ok, true, re.error);
  assert.equal(state.actors[PID].cash, cash1);

  // unaffordable
  const r2 = act(state, data, { type: 'mission/create', draft: satDraft });
  state.actors[PID].cash = -1e9; // budget allows a credit line
  const poor = act(state, data, { type: 'mission/schedule', missionId: r2.missionId });
  assert.equal(poor.ok, false);
  assert.match(poor.error, /Caixa insuficiente/);
});

test('cancel refunds part of the cost; update recomputes cost', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: satDraft });
  const m = state.missions.find((x) => x.id === missionId);
  const up = act(state, data, { type: 'mission/update', missionId, patch: { vehicleId: 't_heavy' } });
  assert.equal(up.ok, true, up.error);
  assert.ok(m.cost > 900);
  act(state, data, { type: 'mission/update', missionId, patch: { vehicleId: 't_small' } });
  act(state, data, { type: 'mission/schedule', missionId });
  const cash = state.actors[PID].cash;
  const c = act(state, data, { type: 'mission/cancel', missionId });
  assert.equal(c.ok, true);
  assert.equal(m.status, 'cancelled');
  assert.ok(state.actors[PID].cash > cash && state.actors[PID].cash < cash + m.cost);
});

test('draftOptions: lists, validation errors in pt-BR, window, estimate', () => {
  const { data, state } = setup();
  const empty = q(state, data, 'missions/draftOptions', {});
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.includes('Escolha o tipo de missão.'));
  assert.equal(empty.types.length, 6);

  const sat = q(state, data, 'missions/draftOptions', { type: 'satellite' });
  assert.equal(sat.destinations.find((d) => d.id === 'leo').valid, true);
  assert.equal(sat.destinations.find((d) => d.id === 'lunar_surface').valid, false);

  const good = q(state, data, 'missions/draftOptions', satDraft);
  assert.equal(good.valid, true, good.errors.join(' | '));
  assert.ok(good.cost.total > 0 && good.cost.breakdown.length >= 3);
  assert.ok(good.estimate.p > 0 && good.estimate.low <= good.estimate.high);
  assert.ok(good.vehicles.some((v) => v.id === 't_small' && v.valid && v.reliability.band));
  assert.ok(good.earliestLaunchTurn > state.turn);

  // payload too heavy for the small rocket to the Moon
  const heavy = q(state, data, 'missions/draftOptions', { type: 'probe', destination: 'lunar_orbit', vehicleId: 't_small', spacecraftId: 't_probe', config: { payloadT: 10 } });
  assert.ok(heavy.errors.some((e) => /excede a capacidade/.test(e)), heavy.errors.join(' | '));
  assert.equal(heavy.vehicles.find((v) => v.id === 't_small').valid, false);

  // crewed: vehicle not rated, missing commander, too many seats
  const noRating = q(state, data, 'missions/draftOptions', { ...crewedDraft, vehicleId: 't_small' });
  assert.ok(noRating.errors.some((e) => /certificado/.test(e)));
  const noCmd = q(state, data, 'missions/draftOptions', { ...crewedDraft, crew: { flightDirector: 't_fd', commander: null, astronauts: [] } });
  assert.ok(noCmd.errors.includes('Escolha o comandante.'));
  assert.ok(noCmd.crew.commander.length >= 4 && noCmd.crew.flightDirector.length >= 1);
  const okCrew = q(state, data, 'missions/draftOptions', crewedDraft);
  assert.equal(okCrew.valid, true, okCrew.errors.join(' | '));
  assert.equal(okCrew.seats, 4);

  // incompatible spacecraft
  const wrongSc = q(state, data, 'missions/draftOptions', { ...satDraft, spacecraftId: 't_capsule' });
  assert.ok(wrongSc.errors.some((e) => /não serve/.test(e)));

  // planetary window
  const mars = q(state, data, 'missions/draftOptions', { type: 'probe', destination: 'mars_orbit', vehicleId: 't_heavy', spacecraftId: 't_probe' });
  assert.ok(mars.window && mars.window.closeTurn > mars.window.openTurn);
  assert.ok(mars.earliestLaunchTurn >= mars.window.openTurn);
  const w = q(state, data, 'missions/nextWindow', 'mars_orbit');
  assert.equal(w.destination, 'mars_orbit');
  assert.ok(q(state, data, 'missions/nextWindow'));
});

test('scheduling outside a planetary window fails; inside works', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: { type: 'probe', destination: 'mars_orbit', vehicleId: 't_heavy', spacecraftId: 't_probe' } });
  const opts = q(state, data, 'missions/draftOptions', { type: 'probe', destination: 'mars_orbit', vehicleId: 't_heavy', spacecraftId: 't_probe' });
  const bad = act(state, data, { type: 'mission/schedule', missionId, launchTurn: opts.window.closeTurn + 2 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /janela/);
  const good = act(state, data, { type: 'mission/schedule', missionId, launchTurn: opts.earliestLaunchTurn });
  assert.equal(good.ok, true, good.error);
});

test('mission/estimate does not mutate state', () => {
  const { data, state } = setup();
  const before = JSON.stringify(state);
  const r = act(state, data, { type: 'mission/estimate', draft: crewedDraft });
  assert.equal(r.ok, true);
  assert.ok(r.estimate.p > 0);
  assert.equal(JSON.stringify(state), before);
});

test('launch day pushes a blocking launch/ready decision', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: satDraft });
  act(state, data, { type: 'mission/schedule', missionId });
  const m = state.missions[0];
  state.turn = m.launchTurn;
  missions.tick(state, data, ctxFor(state, data));
  const d = state.decisions.find((x) => x.kind === 'launch/ready');
  assert.ok(d, 'launch card pushed');
  assert.equal(d.blocking, true);
  assert.deepEqual(d.payload, { missionId, phase: 'ascent' });
  assert.equal(m.status, 'launch');
  // not duplicated on the next tick
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(state.decisions.filter((x) => x.kind === 'launch/ready').length, 1);
});

test('onLaunchResolved: success in LEO → done, prestige, news, signal, flight record', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: satDraft });
  act(state, data, { type: 'mission/schedule', missionId });
  const p0 = state.actors[PID].prestige;
  const s0 = state.actors[PID].support;
  const news0 = state.news.length;
  const r = missions.onLaunchResolved(state, data, missionId, 'ascent', { level: 'total', failureType: null, causes: [] });
  const m = state.missions[0];
  assert.equal(r.final, true);
  assert.equal(m.status, 'done');
  assert.equal(m.result.outcome, 'total');
  assert.equal(m.attempts, 1);
  assert.ok(state.actors[PID].prestige > p0);
  assert.ok(state.actors[PID].support > s0);
  assert.ok(state.news.length > news0);
  assert.ok(m.result.headlines.length >= 1);
  const sig = state.signalsPending.find((s) => s.type === 'mission/resolved');
  assert.equal(sig.missionId, missionId);
  assert.equal(sig.outcome, 'total');
  assert.ok(state.signalsPending.some((s) => s.type === 'mission/launched'));
  // idempotent once done
  assert.equal(missions.onLaunchResolved(state, data, missionId, 'ascent', { level: 'total' }), null);
});

test('onLaunchResolved: lunar lander goes to transit, then arrival scene; first claimed via calendar milestone', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: { type: 'lander', destination: 'lunar_surface', vehicleId: 't_small', spacecraftId: 't_lander', milestone: 'lunar_resource_demo' } });
  const m = state.missions[0];
  m.status = 'launch';
  const r = missions.onLaunchResolved(state, data, missionId, 'ascent', { level: 'total' });
  assert.equal(r.final, false);
  assert.equal(m.status, 'transit');
  assert.equal(m.transit.arriveTurn, state.turn + 1);
  state.turn += 1;
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(m.status, 'arrival');
  const d = state.decisions.find((x) => x.kind === 'launch/ready');
  assert.deepEqual(d.payload, { missionId, phase: 'arrival' });
  state.decisions = [];
  const r2 = missions.onLaunchResolved(state, data, missionId, 'arrival', { level: 'total' });
  assert.equal(r2.final, true);
  assert.equal(m.status, 'operations');
  assert.equal(state.firsts.lunar_resource_demo?.actorId, PID);
  assert.ok(r2.firsts.includes('lunar_resource_demo'));
  assert.ok(state.signalsPending.some((s) => s.type === 'first' && s.milestoneId === 'lunar_resource_demo'));
  // operations end → done
  state.turn = m.ops.untilTurn;
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(m.status, 'done');
});

test('arrival without scene resolves with a simple roll', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: { type: 'probe', destination: 'lunar_orbit', vehicleId: 't_small', spacecraftId: 't_probe' } });
  missions.onLaunchResolved(state, data, missionId, 'ascent', { level: 'total' });
  const m = state.missions[0];
  state.turn = m.transit.arriveTurn;
  missions.tick(state, data, ctxFor(state, data));
  assert.ok(['operations', 'done'].includes(m.status));
  assert.equal(m.result.phase, 'arrival');
  assert.ok(['total', 'partial', 'recoverable', 'catastrophic'].includes(m.result.outcome));
});

test('crewed catastrophic failure costs support and reputation heavily', () => {
  const { data, state } = setup();
  const { missionId } = act(state, data, { type: 'mission/create', draft: crewedDraft });
  const s0 = state.actors[PID].support;
  const rep0 = state.actors[PID].reputation;
  missions.onLaunchResolved(state, data, missionId, 'ascent', { level: 'catastrophic', failureType: 'propulsion', causes: [{ kind: 'part', label: 'Motor', detail: '', weight: 1 }], crewLost: ['t_a1', 't_a2'] });
  const m = state.missions[0];
  assert.equal(m.status, 'done');
  assert.equal(m.result.crewLost.length >= 2, true);
  assert.ok(state.actors[PID].support <= s0 - 15, `support ${s0} → ${state.actors[PID].support}`);
  assert.ok(state.actors[PID].reputation <= rep0 - 10);
  assert.match(m.result.headlines[0], /Luto|Tragédia|perde astronautas/);
});

test('briefing from a player calendar item: accept / delay / cancel', () => {
  const { data, state } = setup();
  const target = state.turn + 10;
  let inst = state.calendar.find((c) => c.id === 't_cal_lander');
  if (!inst) { inst = { id: 't_cal_lander', plannedTurn: target, currentTurn: target, status: 'player', delayWeeks: 0, revisions: 0, outcome: null, resolvedTurn: null }; state.calendar.push(inst); }
  Object.assign(inst, { status: 'player', plannedTurn: target, currentTurn: target });
  missions.tick(state, data, ctxFor(state, data));
  const d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.calendarId === 't_cal_lander');
  assert.ok(d, 'briefing pushed');
  assert.deepEqual(d.choices.map((c) => c.id), ['accept', 'delay', 'cancel']);
  // only one briefing per item
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(state.decisions.filter((x) => x.payload?.calendarId === 't_cal_lander').length, 1);

  // delay (through the engine's decision routing)
  const sup0 = state.actors[PID].support;
  resolveDecision(state, data, d.id, 'delay');
  assert.equal(inst.currentTurn, target + 13);
  assert.ok(state.actors[PID].support < sup0);
  assert.ok(state.signalsPending.some((s) => s.type === 'calendar/delayed'));

  // approaching again → new briefing → accept creates a pre-filled planning mission
  state.turn = inst.currentTurn - 8;
  missions.tick(state, data, ctxFor(state, data));
  const d2 = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.calendarId === 't_cal_lander');
  assert.ok(d2);
  const r = resolveDecision(state, data, d2.id, 'accept');
  assert.equal(r.ok, true);
  const m = state.missions.find((x) => x.calendarId === 't_cal_lander');
  assert.ok(m);
  assert.equal(m.status, 'planning');
  assert.equal(m.source, 'calendar');
  assert.equal(m.vehicleId, 't_small');
  assert.equal(m.spacecraftId, 't_lander');
  assert.equal(m.milestone, 'lunar_resource_demo');
  // final result updates the calendar instance
  m.status = 'arrival';
  missions.onLaunchResolved(state, data, m.id, 'arrival', { level: 'partial', failureType: 'software' });
  assert.equal(inst.status, 'partial');
  assert.equal(inst.outcome.level, 'partial');
});

test('briefing cancel marks the calendar item cancelled', () => {
  const { data, state } = setup();
  let inst = state.calendar.find((c) => c.id === 't_cal_lander');
  if (!inst) { inst = { id: 't_cal_lander', status: 'player' }; state.calendar.push(inst); }
  Object.assign(inst, { status: 'player', plannedTurn: state.turn + 5, currentTurn: state.turn + 5 });
  missions.tick(state, data, ctxFor(state, data));
  const d = state.decisions.find((x) => x.payload?.calendarId === 't_cal_lander');
  resolveDecision(state, data, d.id, 'cancel');
  assert.equal(inst.status, 'cancelled');
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(state.decisions.filter((x) => x.payload?.calendarId === 't_cal_lander').length, 0);
});

test('contracts: offer, bid, auction, award, delivery pays revenue', () => {
  const { data, state } = setup();
  let offer = null;
  for (let i = 0; i < 80 && !offer; i++) {
    missions.tick(state, data, ctxFor(state, data));
    offer = state.decisions.find((x) => x.kind === 'contract/offer');
    if (!offer) state.turn++;
  }
  assert.ok(offer, 'a contract offer appeared');
  assert.deepEqual(offer.choices.map((c) => c.id), ['bid_low', 'bid_mid', 'bid_high', 'pass']);
  const c = state.contracts.find((x) => x.id === offer.payload.contractId);
  assert.ok(c.valueM > 0 && c.deadlineTurn > state.turn);
  assert.ok(offer.choices[0].preview.includes('%') || offer.choices[0].disabled);
  if (offer.choices[0].disabled) return; // no capable hardware in this fixture for this kind
  resolveDecision(state, data, offer.id, 'bid_low');
  assert.equal(c.status, 'bidding');
  c.rivals = []; // force the win
  state.decisions = state.decisions.filter((x) => x.kind !== 'contract/offer');
  state.turn = c.closeTurn;
  const cash0 = state.actors[PID].cash;
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(c.status, 'awarded');
  assert.equal(c.winner, PID);
  assert.ok(state.actors[PID].cash > cash0, 'advance payment received');
  const m = state.missions.find((x) => x.contractId === c.id);
  assert.ok(m, 'contract mission created');
  assert.equal(m.source, 'contract');
  assert.equal(m.deadlineTurn, c.deadlineTurn);
  const contracts = q(state, data, 'missions/contracts');
  assert.ok(contracts.some((x) => x.id === c.id));
  // deliver
  m.status = m.destination === 'lunar_surface' ? 'arrival' : 'launch';
  const cash1 = state.actors[PID].cash;
  missions.onLaunchResolved(state, data, m.id, m.status === 'arrival' ? 'arrival' : 'ascent', { level: 'total' });
  if (m.status === 'transit') { m.status = 'arrival'; missions.onLaunchResolved(state, data, m.id, 'arrival', { level: 'total' }); }
  assert.equal(c.status, 'delivered');
  assert.ok(state.actors[PID].cash > cash1);
});

test('contract default after the deadline costs reputation', () => {
  const { data, state } = setup();
  state.contracts.push({
    id: 'ctr_t', kind: 'gto_sat', title: 'Teste', client: 'Cliente', body: '', type: 'satellite', destination: 'gto', payloadT: 3,
    clientPayload: true, valueM: 200, createdTurn: 0, closeTurn: 4, deadlineTurn: 10, status: 'awarded', rivals: [], playerBid: { level: 'bid_mid', price: 200 },
    winner: PID, winningPrice: 200, missionId: null, advancePaidM: 40, late: false,
  });
  const rep0 = state.actors[PID].reputation;
  state.turn = 11;
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(state.contracts[0].status, 'late');
  state.turn = 25;
  missions.tick(state, data, ctxFor(state, data));
  assert.equal(state.contracts[0].status, 'defaulted');
  assert.ok(state.actors[PID].reputation < rep0 - 5);
});

test('queries list/get and engine dispatch routing', () => {
  const { data, state } = setup();
  const r = dispatch(state, data, { type: 'mission/create', draft: satDraft });
  assert.equal(r.ok, true, r.error);
  const list = q(state, data, 'missions/list');
  assert.equal(list.length, 1);
  assert.equal(list[0].statusLabel, 'Em planejamento');
  const g = q(state, data, 'missions/get', r.missionId);
  assert.ok(g.check && Array.isArray(g.check.errors));
  assert.equal(q(state, data, 'missions/get', 'nope'), null);
});

test('deterministic: same seed and actions give the same missions state', () => {
  const run = () => {
    const { data, state } = setup(77);
    for (let i = 0; i < 40; i++) { missions.tick(state, data, ctxFor(state, data)); state.turn++; }
    return JSON.stringify({ c: state.contracts, d: state.decisions.map((x) => [x.kind, x.title]) });
  };
  assert.equal(run(), run());
});

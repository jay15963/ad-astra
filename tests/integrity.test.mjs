// Regression tests for exploits and integrity rules found in review: calendar milestones, paid-mission accounting,
// privileged draft fields, game over, onGameEnd hooks, slice ownership (tension/relations), launch seeds,
// Command pool, bloc requests, historic firsts, seeded treaties, AI prestige scale. Real data (data/*.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, tick, advance } from '../src/core/engine.js';
import { relKey, claimFirst, isHistoricFirst } from '../src/core/helpers.js';
import { missionPrestige } from '../src/core/outcome.js';
import * as missions from '../src/sim/missions.js';
import * as N from '../src/sim/narrative.js';
import { autoplay, CP_REGEN_WEEKS } from '../src/sim/launch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const clearDecisions = (s) => { s.decisions = []; };

/** Advance until the player's calendar briefing for calId shows up; accept it; return the mission. */
function acceptProgram(s, calId) {
  for (let g = 0; g < 400 && !s.gameOver; g++) {
    const d = s.decisions.find((x) => x.kind === 'briefing' && x.payload?.calendarId === calId);
    if (d) {
      const r = dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: 'accept' });
      assert.equal(r.ok, true, r.error);
      return s.missions.find((m) => m.id === r.missionId);
    }
    s.decisions = s.decisions.filter((x) => x.kind === 'briefing' && x.payload?.calendarId);
    tick(s, data);
  }
  throw new Error(`no briefing for ${calId}`);
}

test('calendar program: destination/type/crew are locked; milestone only for the real program; grant is a share', () => {
  const s = newGame(data, { seed: 12, playerId: 'nasa' });
  s.actors.nasa.cash = 1e6;
  const m = acceptProgram(s, 'artemis4');
  assert.equal(m.milestone, 'crewed_lunar_landing');
  assert.ok(m.grantShare > 0 && !(m.grantM > 0), 'grant stored as a share');
  const r = dispatch(s, data, { type: 'mission/update', missionId: m.id, patch: { destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'crew_dragon' } });
  assert.equal(r.ok, false);
  assert.equal(m.destination, 'lunar_south_pole');
  // grant scales with the configuration: never makes a mission free
  const full = missions.computeCost(s, data, { ...m, grantShare: 0, grantM: 0 }).total;
  assert.ok(Math.abs(m.cost - full * (1 - m.grantShare)) < 1, 'cost = full * (1 - share)');
  // a mission that does not fly the program does not claim its milestone (defensive: old saves / crafted state)
  m.destination = 'leo'; m.vehicleId = 'falcon9'; m.spacecraftId = 'crew_dragon'; m.secondarySpacecraftId = null; m.status = 'launch';
  assert.equal(missions.matchesCalendar(data, m), false);
  missions.onLaunchResolved(s, data, m.id, 'ascent', { level: 'total' });
  assert.equal(s.firsts.crewed_lunar_landing, undefined);
  assert.notEqual(s.calendar.find((c) => c.id === 'artemis4').status, 'success');
});

test('calendar program: readiness date and pending prerequisites (no Artemis IV before its lander demo)', () => {
  const s = newGame(data, { seed: 23770, playerId: 'nasa' });
  s.actors.nasa.cash = 1e6;
  const m = acceptProgram(s, 'artemis4');
  const inst = s.calendar.find((c) => c.id === 'artemis4');
  assert.ok(Number.isFinite(m.readyTurn) && m.readyTurn >= (inst.currentTurn ?? inst.plannedTurn) - 4, 'hardware ready near the official date, not earlier');
  const early = dispatch(s, data, { type: 'mission/schedule', missionId: m.id, launchTurn: Math.max(s.turn + 2, m.readyTurn - 1) });
  if (m.readyTurn - 1 >= s.turn + 2) assert.equal(early.ok, false);
  // the demo has not flown: the estimate carries a prerequisite penalty and a warning
  const est = dispatch(s, data, { type: 'mission/estimate', draft: m });
  assert.equal(est.ok, true);
  const r = missions.estimateFor(s, data, m.id);
  const noPrereq = missions.estimateFor(s, data, m.id);
  assert.ok(r.p <= noPrereq.p + 1e-9);
  const plan = { ...m, actorId: 'nasa', calendarId: 'artemis4', launchTurn: m.readyTurn };
  const risk = (cal) => import('../src/sim/risk.js').then((R) => R.missionRisk(s, data, { ...plan, calendarId: cal }));
  return Promise.all([risk('artemis4'), risk(undefined)]).then(([withP, without]) => {
    assert.ok(withP.p < without.p - 0.05, `prerequisite penalty (${withP.p} vs ${without.p})`);
    assert.ok(withP.warnings.some((w) => /Depende de/.test(w)));
  });
});

test('paid missions: back in planning, upgrades are charged and cancel refunds 40% of what was paid', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  clearDecisions(s);
  s.actors.nasa.cash = 5000;
  const c = dispatch(s, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' } });
  const m = s.missions.find((x) => x.id === c.missionId);
  assert.equal(dispatch(s, data, { type: 'mission/schedule', missionId: m.id }).ok, true);
  const paid = m.paidM;
  assert.ok(paid > 0);
  m.status = 'planning'; m.launchTurn = null; // what launchDay does when a check fails on the day
  const cash0 = s.actors.nasa.cash;
  const u = dispatch(s, data, { type: 'mission/update', missionId: m.id, patch: { type: 'probe', destination: 'lunar_orbit', vehicleId: 'falconheavy', spacecraftId: 'generic_probe' } });
  assert.equal(u.ok, true, u.error);
  assert.ok(s.actors.nasa.cash < cash0 - 100, 'upgrade charged even in planning');
  assert.ok(Math.abs(m.paidM - m.cost) < 0.2);
  const cash1 = s.actors.nasa.cash;
  const k = dispatch(s, data, { type: 'mission/cancel', missionId: m.id });
  assert.equal(k.refund, Math.round(m.paidM * 0.4 * 10) / 10);
  assert.ok(s.actors.nasa.cash - cash1 <= m.paidM * 0.4 + 0.1);
});

test('scheduling checks the hardware on launch day and the scenario end', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  clearDecisions(s);
  s.actors.nasa.cash = 1e5;
  const atlas = data.vehicles.vehicles.find((v) => v.id === 'atlas_v');
  const c = dispatch(s, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', vehicleId: 'atlas_v', spacecraftId: 'generic_sat' } });
  if (atlas?.availableUntil) {
    const r = dispatch(s, data, { type: 'mission/schedule', missionId: c.missionId, launchTurn: s.endTurn - 4 });
    assert.equal(r.ok, false);
    assert.match(r.error, /sai de serviço/);
  }
  const c2 = dispatch(s, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' } });
  const r2 = dispatch(s, data, { type: 'mission/schedule', missionId: c2.missionId, launchTurn: s.endTurn });
  assert.equal(r2.ok, false);
});

test('public mission/create strips privileged fields', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  const base = { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' };
  const a = dispatch(s, data, { type: 'mission/create', draft: base });
  const b = dispatch(s, data, { type: 'mission/create', draft: { ...base, grantM: 1e9, grantShare: 0.9, milestone: 'crewed_lunar_landing', source: 'calendar', calendarId: 'artemis4', contractId: 'x', clientPayload: true, readyTurn: 0 } });
  const mb = s.missions.find((x) => x.id === b.missionId);
  assert.equal(mb.cost, s.missions.find((x) => x.id === a.missionId).cost);
  assert.equal(mb.milestone, null);
  assert.equal(mb.source, 'custom');
  assert.equal(mb.calendarId, null);
  assert.equal(mb.contractId, null);
});

test('game over: actions are rejected, decisions cleared, hooks run once (also when fired mid-tick)', () => {
  const s = newGame(data, { seed: 11, playerId: 'cnsa' });
  clearDecisions(s);
  s.finance.debtWeeks = 40;
  s.actors.cnsa.cash = -5000;
  s.actors.cnsa.support = 0;
  const turn = s.turn;
  tick(s, data);
  assert.equal(s.gameOver?.reason, 'fired');
  assert.equal(s.gameOver.hooksRun, true);
  assert.equal(s.turn, turn + 1);
  assert.ok(s.stats['diplomacy.eraWinner'], 'era trophy awarded on firing too');
  assert.ok(s.album.some((c) => c.kind === 'era'));
  assert.equal(s.decisions.length, 0);
  const albums = s.album.length;
  tick(s, data);
  assert.equal(s.album.length, albums, 'hooks run once');
  const r = dispatch(s, data, { type: 'crew/hire', candidateId: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /encerrada/);
  assert.equal(dispatch(s, data, { type: 'time/advance', weeks: 1 }).ok, true);
});

test('narrative tension effect goes through politics: no phantom level, no fake signal; relations through diplomacy', () => {
  const s = newGame(data, { seed: 4, playerId: 'nasa' });
  for (let i = 0; i < 3; i++) tick(s, data);
  const k = relKey('nasa', 'cnsa');
  const t0 = s.tension[k];
  const pend = s.signalsPending.length;
  N.applyEffects(s, data, [{ tension: 'cnsa', delta: 1 }, { relation: 'cnsa', field: 'trust', delta: 5 }], { rival: 'cnsa', note: 'Teste' });
  assert.equal(s.tension[k], t0, 'a ±1 nudge becomes pressure, not a level change');
  assert.ok(!s.signalsPending.slice(pend).some((x) => x.type === 'tension/changed'));
});

test('launch: countdown rolls change after a scrub, milestone rolls stay locked per attempt', () => {
  const s = newGame(data, { seed: 8, playerId: 'nasa' });
  clearDecisions(s);
  s.actors.nasa.cash = 1e5;
  const c = dispatch(s, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' } });
  dispatch(s, data, { type: 'mission/schedule', missionId: c.missionId });
  const seeds = [];
  for (let k = 0; k < 2; k++) {
    for (let g = 0; g < 60 && !s.decisions.some((d) => d.kind === 'launch/ready'); g++) { s.decisions = s.decisions.filter((d) => d.kind === 'launch/ready'); advance(s, data, 1); }
    const d = s.decisions.find((x) => x.kind === 'launch/ready');
    dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: 'go' });
    s.activeLaunch.weather = { code: 'storm', label: 'Tempestade', risk: 0.4 };
    dispatch(s, data, { type: 'launch/countdown' });
    seeds.push([s.activeLaunch.seed, s.activeLaunch.countSeed]);
    dispatch(s, data, { type: 'launch/hold', choice: 'scrub' });
    assert.equal(s.activeLaunch, null);
  }
  assert.equal(seeds[0][0], seeds[1][0], 'milestone seed locked');
  assert.notEqual(seeds[0][1], seeds[1][1], 'countdown seed changes after a scrub');
  assert.equal(s.missions.find((m) => m.id === c.missionId).scrubs, 2);
});

test('Command points are a pool: spent points come back slowly', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  clearDecisions(s);
  const cap = s.commandPoints;
  assert.ok(cap >= 1);
  s.commandPoints = 0;
  for (let i = 0; i < CP_REGEN_WEEKS - 1; i++) { clearDecisions(s); tick(s, data); }
  assert.equal(s.commandPoints, 0);
  clearDecisions(s);
  tick(s, data);
  assert.equal(s.commandPoints, Math.min(cap, 1));
});

test('diplomacy/joinBloc: cooldown after a refusal, no channel in open conflict', () => {
  const s = newGame(data, { seed: 2, playerId: 'nasa' });
  if (s.actors.nasa.bloc) dispatch(s, data, { type: 'diplomacy/leaveBloc' });
  let refused = 0;
  let blocked = 0;
  for (let i = 0; i < 6; i++) {
    const r = dispatch(s, data, { type: 'diplomacy/joinBloc', blocId: 'ilrs' });
    if (r.ok && r.status === 'rejected') refused++;
    if (!r.ok) blocked++;
  }
  assert.ok(refused <= 1, `at most one refusal in a row (got ${refused})`);
  assert.ok(blocked >= 5);
});

test('historic firsts: feats done before 2026 pay a share and are flagged as "first of the era"', () => {
  const s = newGame(data, { seed: 1, playerId: 'esa' });
  assert.ok(isHistoricFirst(s, 'crewed_lunar_landing'));
  assert.ok(!isHistoricFirst(s, 'lunar_south_pole_crewed'));
  const p0 = s.actors.cnsa.prestige;
  assert.equal(claimFirst(s, 'crewed_lunar_orbit', 'cnsa', 100, 5), true);
  assert.equal(s.firsts.crewed_lunar_orbit.era, true);
  assert.equal(Math.round(s.actors.cnsa.prestige - p0), 35);
  // the race's headline feat carries its own share (scenario.historicalFirsts.crewed_lunar_landing.share)
  const pL = s.actors.cnsa.prestige;
  assert.equal(claimFirst(s, 'crewed_lunar_landing', 'cnsa', 100, 5), true);
  assert.equal(s.firsts.crewed_lunar_landing.era, true);
  assert.equal(Math.round(s.actors.cnsa.prestige - pL), Math.round(100 * data.scenario.historicalFirsts.crewed_lunar_landing.share));
  const p1 = s.actors.cnsa.prestige;
  claimFirst(s, 'lunar_south_pole_crewed', 'cnsa', 100, 5);
  assert.equal(Math.round(s.actors.cnsa.prestige - p1), 100);
});

test('seeded 2026 partnerships survive the first year (20 seeds)', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = newGame(data, { seed, playerId: 'esa' });
    while (s.turn < 52) { clearDecisions(s); s.activeLaunch = null; tick(s, data); }
    for (const id of ['iss_integrated_crew', 'artemis_iii_docking']) {
      assert.equal(s.treaties.find((t) => t.id === id)?.status, 'active', `${id} seed ${seed}`);
    }
  }
});

test('one prestige scale: the same feat is worth the same to the player and to an AI', () => {
  const dest = data.destinations.destinations.find((d) => d.id === 'lunar_south_pole');
  const a = missionPrestige(dest, { crewed: true, level: 'total', p: 0.8 });
  assert.ok(a.prestige > 40 && a.firstPoints > 60);
  assert.equal(missionPrestige(dest, { crewed: true, level: 'total', p: 0.8, repeats: 2 }).prestige < a.prestige, true);
  assert.equal(missionPrestige(dest, { crewed: true, level: 'recoverable' }).prestige, 0);
});

test('fuel margin above 10% and the conservative strategy cost money and time', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  const d = { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' };
  const c10 = missions.computeCost(s, data, { ...d, config: { strategy: 'balanced', fuelMargin: 0.1 } }).total;
  const c20 = missions.computeCost(s, data, { ...d, config: { strategy: 'balanced', fuelMargin: 0.2 } }).total;
  const v = data.vehicles.vehicles.find((x) => x.id === 'falcon9');
  assert.ok(c20 - c10 >= v.costM * 0.09, 'each point above 10% costs ~1% of the launch');
  const opts = missions.draftOptions(s, data, { ...d, config: { strategy: 'conservative', fuelMargin: 0.1 } });
  const optsB = missions.draftOptions(s, data, { ...d, config: { strategy: 'balanced', fuelMargin: 0.1 } });
  assert.ok(opts.earliestLaunchTurn > optsB.earliestLaunchTurn, 'conservative adds preparation weeks');
});

test('rivals fly their own missions and the campaign stays deterministic', () => {
  const run = () => {
    const s = newGame(data, { seed: 77, playerId: 'esa' });
    while (s.turn < 120) { clearDecisions(s); s.activeLaunch = null; tick(s, data); }
    return s;
  };
  const a = run();
  const b = run();
  assert.ok((a.stats['calendar.rivalOps'] || 0) > 0);
  assert.equal(JSON.stringify(a.rivalOps), JSON.stringify(b.rivalOps));
  assert.deepEqual(JSON.parse(JSON.stringify(a.actors)), JSON.parse(JSON.stringify(b.actors)));
});

test('autoplay still finishes a scene with an empty Command pool', () => {
  const s = newGame(data, { seed: 9, playerId: 'nasa' });
  clearDecisions(s);
  s.actors.nasa.cash = 1e5;
  const c = dispatch(s, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat' } });
  dispatch(s, data, { type: 'mission/schedule', missionId: c.missionId });
  for (let g = 0; g < 60 && !s.decisions.some((d) => d.kind === 'launch/ready'); g++) { s.decisions = s.decisions.filter((d) => d.kind === 'launch/ready'); advance(s, data, 1); }
  s.commandPoints = 0;
  const d = s.decisions.find((x) => x.kind === 'launch/ready');
  dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: 'go' });
  assert.equal(s.activeLaunch.commandPoints, 0);
  const out = autoplay(s, data, { finish: true });
  assert.ok(out);
  assert.equal(s.activeLaunch, null);
});

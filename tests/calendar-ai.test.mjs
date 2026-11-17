// Tests for the rival AI planner in src/sim/calendar.js (rivalOps): goals, race pressure, targets, scenario end, news.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick } from '../src/core/engine.js';
import * as cal from '../src/sim/calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

function spectate(seed, playerId, untilTurn) {
  const s = newGame(data, { seed, playerId });
  while (!s.gameOver && s.turn < untilTurn) { s.decisions.length = 0; s.activeLaunch = null; tick(s, data); }
  return s;
}

test('every robotic goal of the rivals maps to a destination that awards it', () => {
  const destIds = new Set(data.destinations.destinations.map((d) => d.id));
  const robotic = new Set(data.destinations.destinations.flatMap((d) => [].concat(d.firsts?.robotic ?? [])));
  for (const a of data.actors.actors) {
    for (const g of a.ai?.goals || []) {
      if (!robotic.has(g)) continue;
      const dest = cal.goalDest(data, g);
      assert.ok(dest && destIds.has(dest), `${a.id}: ${g} -> ${dest}`);
    }
  }
  // the solar-system milestones are pursued by the agencies that really plan them
  const goals = (id) => data.actors.actors.find((a) => a.id === id).ai.goals;
  assert.ok(goals('esa').includes('mercury_orbit') && goals('esa').includes('apophis_rendezvous'));
  assert.ok(goals('jaxa').includes('phobos_landing'));
  assert.ok(goals('cnsa').includes('asteroid_sample_return'));
  assert.ok(goals('isro').includes('venus_orbit'));
  assert.ok(goals('nasa').includes('europa_arrival') && goals('nasa').includes('psyche_arrival'));
});

test('race pressure: the leader eases off, a trailing rival pushes', () => {
  const s = newGame(data, { seed: 5, playerId: 'isro' });
  for (const a of Object.values(s.actors)) a.prestige = 100;
  s.actors.nasa.prestige = 300;
  s.actors.cnsa.prestige = 250;
  assert.ok(cal.racePressure(s, data, 'nasa') < 1);
  assert.ok(cal.racePressure(s, data, 'cnsa') > 1);
  assert.ok(cal.racePressure(s, data, 'jaxa') > cal.racePressure(s, data, 'cnsa'));
});

test('rival targets never arrive after the end of the scenario and value open firsts', () => {
  const s = spectate(11, 'isro', 30);
  const opts = cal.opsOptions(s, data, 'esa');
  assert.ok(opts.length > 0);
  for (const o of opts) assert.ok(o.arriveTurn <= s.endTurn - 1 && o.launchTurn < s.endTurn, `${o.destination} ${o.arriveTurn}`);
  // a first nobody has yet is worth more than the same trip after it was claimed
  const open = cal.opsOptions(s, data, 'jaxa').find((o) => o.destination === 'mercury_flyby');
  if (open) {
    s.firsts.mercury_flyby = { actorId: 'nasa', turn: s.turn };
    const claimed = cal.opsOptions(s, data, 'jaxa').find((o) => o.destination === 'mercury_flyby');
    assert.ok(claimed.value < open.value);
  }
  // late in the campaign, nothing with a long transit is still offered
  s.turn = s.endTurn - 30;
  for (const o of cal.opsOptions(s, data, 'cnsa')) assert.ok((data.index.destinations[o.destination].transitWeeks || 0) <= 30);
});

test('rivals fly their own missions all campaign long, deterministically, and claim firsts', () => {
  const a = spectate(77, 'esa', 260);
  const b = spectate(77, 'esa', 260);
  assert.equal(JSON.stringify(a.rivalOps), JSON.stringify(b.rivalOps));
  assert.ok((a.stats['calendar.rivalOps'] || 0) >= 15, `only ${a.stats['calendar.rivalOps']} rival missions`);
  const scorers = Object.entries(a.rivalOps.score || {}).filter(([, v]) => v > 0);
  assert.ok(scorers.length >= 4, 'several rivals score with their own missions');
  // nothing is left committed past the end of the era
  for (const p of a.rivalOps.pending) assert.ok(p.launchTurn < a.endTurn);
  assert.deepEqual(JSON.parse(JSON.stringify(a.rivalOps)), a.rivalOps);
});

test('news: background test failures make the feed at most once a year per vehicle, with varied headlines', () => {
  const s = spectate(3, 'esa', 260);
  // state.news keeps only the latest items: check the vehicle stats bookkeeping instead
  for (const st of Object.values(s.vehicleStats)) {
    const turns = st.failNewsTurns || [];
    for (let i = 1; i < turns.length; i++) assert.ok(turns[i] - turns[i - 1] >= 13);
  }
  const variants = data.calendar.news.bgTestFailure;
  assert.ok(Array.isArray(variants) && variants.length >= 3);
  const success = data.calendar.news.success;
  assert.ok(Array.isArray(success) && success.every((t) => t.includes('{name}')));
});

test('balance review: re-dated player launches stop scaring rivals; one site is not visited over and over', () => {
  const s = spectate(104729, 'esa', 60);
  const dest = data.destinations.destinations.find((d) => d.id === 'venus_orbit');
  const mid = [].concat(dest.firsts.robotic)[0];
  const m = { id: 'mX', name: 'X', status: 'scheduled', destination: 'venus_orbit', crewed: false, launchTurn: s.turn + 30 };
  s.missions.push(m);
  assert.equal(cal.rivalEta(s, data, mid, 'cnsa')?.actorId, 'esa');
  m.redated = 1;
  assert.notEqual(cal.rivalEta(s, data, mid, 'cnsa')?.actorId, 'esa', 'a launch pushed back is not a credible threat');
  s.missions.pop();
  // the campaign cap per destination (goal destinations get one more)
  const ops = s.rivalOps;
  const before = cal.opsOptions(s, data, 'jaxa').some((o) => o.destination === 'lunar_orbit');
  ops.tries.jaxa = { ...(ops.tries.jaxa || {}), lunar_orbit: 9 };
  assert.ok(!cal.opsOptions(s, data, 'jaxa').some((o) => o.destination === 'lunar_orbit'), `capped (was offered: ${before})`);
});

test('balance review: companies weigh science targets outside their goals far less than agencies', () => {
  const s = spectate(104729, 'esa', 60);
  const val = (id, dest) => cal.opsOptions(s, data, id).find((o) => o.destination === dest);
  // same budget and position, different interest: blue origin (company, no Venus goal) vs an agency copy of it
  const bo = val('blueorigin', 'mercury_flyby');
  s.actors.blueorigin.kind = 'agency';
  s.actors.blueorigin.ai = { ...s.actors.blueorigin.ai, scienceInterest: undefined };
  const asAgency = val('blueorigin', 'mercury_flyby');
  assert.ok(bo && asAgency, 'mercury_flyby is on the menu at turn 60');
  assert.ok(bo.value < asAgency.value * 0.5, `${bo.value} vs ${asAgency.value}`);
});

test('balance review: a saving plan holds real money in the rivalOps slice and stays JSON-safe', () => {
  const s = spectate(104729, 'esa', 160);
  const ops = s.rivalOps;
  assert.ok(ops.saving && typeof ops.saving === 'object');
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), ops);
  for (const sv of Object.values(ops.saving)) {
    assert.ok(sv.banked >= 0 && sv.banked <= sv.cost + 1, JSON.stringify(sv));
    assert.ok(Number.isFinite(sv.untilTurn));
  }
  // small agencies get to fly: every AI committed something by mid-campaign
  for (const id of ['isro', 'jaxa', 'roscosmos']) {
    const n = Object.values(ops.tries[id] || {}).reduce((a, b) => a + b, 0);
    assert.ok(n >= 1, `${id} committed ${n}`);
  }
});

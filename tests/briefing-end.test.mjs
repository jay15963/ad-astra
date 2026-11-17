// Program briefings must not offer a mission that cannot launch before the scenario end
// (bug: starship_mars_cargo accepted with hardware ready only on the last turn, stuck in 'planning' forever).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, resolveDecision, serialize } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as missions from '../src/sim/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const ID = 'starship_mars_cargo';

const ctxFor = (state) => ({
  data, rng: (label = '') => rngFor(state.seed, state.turn, 'missions', label), date: turnToDate(state.turn, state.startYear),
});

function setup(seed = 5) {
  const state = newGame(data, { seed, playerId: 'spacex' });
  state.decisions = [];
  const inst = state.calendar.find((c) => c.id === ID);
  assert.ok(inst, 'calendar instance exists');
  return { state, inst };
}

test('program whose hardware is only ready at the end: no briefing, auto-declined with an explanation', () => {
  const { state, inst } = setup();
  // official date on the last week: ready turn (−4 weeks + slip) + Mars window cannot launch before endTurn
  Object.assign(inst, { status: 'player', plannedTurn: state.endTurn, currentTurn: state.endTurn });
  state.turn = state.endTurn - 6;
  const sup0 = state.actors.spacex.support;
  const rep0 = state.actors.spacex.reputation;
  missions.tick(state, data, ctxFor(state));
  assert.equal(state.decisions.filter((x) => x.kind === 'briefing' && x.payload?.calendarId === ID).length, 0, 'no briefing offered');
  assert.equal(inst.status, 'cancelled');
  assert.equal(inst.beyondEnd, true);
  const card = state.decisions.find((x) => x.kind === 'mission/issue' && /fica para depois de 2030/.test(x.title));
  assert.ok(card, 'explanation card');
  assert.match(card.body, /não fica pronto a tempo/);
  assert.equal(state.actors.spacex.support, sup0, 'no political cost');
  assert.equal(state.actors.spacex.reputation, rep0);
  assert.equal(state.missions.filter((m) => m.calendarId === ID).length, 0);
  // stays decided on later ticks, state still serializable
  missions.tick(state, data, ctxFor(state));
  assert.equal(state.decisions.filter((x) => x.kind === 'mission/issue').length, 1);
  assert.doesNotThrow(() => JSON.parse(serialize(state)));
});

test('stale briefing accepted after it stopped fitting the era: refused, no planning mission', () => {
  const { state, inst } = setup();
  Object.assign(inst, { status: 'player', plannedTurn: state.turn + 10, currentTurn: state.turn + 10 });
  missions.tick(state, data, ctxFor(state));
  const d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.calendarId === ID);
  assert.ok(d, 'briefing offered while the program still fits');
  // the briefing sits unanswered until the era is over
  inst.currentTurn = state.endTurn;
  state.turn = state.endTurn - 3;
  const r = resolveDecision(state, data, d.id, 'accept');
  assert.equal(r.ok, true);
  assert.equal(state.missions.filter((m) => m.calendarId === ID).length, 0, 'no mission created');
  assert.equal(inst.status, 'cancelled');
  assert.equal(inst.beyondEnd, true);
});

test('leftover program mission stuck in planning is cleaned up; custom ones are flagged once', () => {
  const { state, inst } = setup();
  Object.assign(inst, { status: 'player', plannedTurn: state.turn + 10, currentTurn: state.turn + 10 });
  missions.tick(state, data, ctxFor(state));
  const d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.calendarId === ID);
  assert.equal(resolveDecision(state, data, d.id, 'accept').ok, true);
  const m = state.missions.find((x) => x.calendarId === ID);
  assert.equal(m.status, 'planning');
  // an old save: the hardware date lands on the last turn
  m.readyTurn = state.endTurn;
  const custom = { ...structuredClone(m), id: 'mis_custom_x', source: 'custom', calendarId: null, readyTurn: null, name: 'Custom X' };
  state.missions.push(custom);
  state.turn = state.endTurn - 1;
  state.decisions = [];
  const sup0 = state.actors.spacex.support;
  missions.tick(state, data, ctxFor(state));
  assert.equal(m.status, 'cancelled');
  assert.equal(m.stranded, true);
  assert.equal(inst.status, 'cancelled');
  assert.equal(state.actors.spacex.support, sup0, 'no political cost for the cleanup');
  assert.equal(custom.status, 'planning');
  assert.equal(custom.stranded, true);
  const cards = state.decisions.filter((x) => x.kind === 'mission/issue');
  assert.ok(cards.some((c) => /não voa antes do fim de 2030/.test(c.title)));
  assert.ok(cards.some((c) => /Custom X: sem data possível/.test(c.title)));
  missions.tick(state, data, ctxFor(state));
  assert.equal(state.decisions.filter((x) => x.kind === 'mission/issue').length, cards.length, 'flagged once');
});

test('a program that still fits keeps its normal briefing', () => {
  const { state, inst } = setup();
  Object.assign(inst, { status: 'player', plannedTurn: state.turn + 10, currentTurn: state.turn + 10 });
  missions.tick(state, data, ctxFor(state));
  assert.ok(state.decisions.some((x) => x.kind === 'briefing' && x.payload?.calendarId === ID));
  assert.equal(inst.status, 'player');
  assert.ok(!inst.beyondEnd);
});

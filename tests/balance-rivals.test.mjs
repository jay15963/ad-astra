// Balance of the rivals: AI calendar programs cost cash (budget.js), background crewed rotations (crew.js),
// partner credit on joint programs (diplomacy.js), headline variety (budget.js, narrative.js, events.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick as engineTick, serialize, deserialize } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as budget from '../src/sim/budget.js';
import * as crew from '../src/sim/crew.js';
import { PLACEHOLDERS, validateEvent } from '../src/sim/narrative.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const fresh = (playerId = 'isro', seed = 7) => newGame(data, { seed, playerId });
const ctxFor = (s, mod) => ({ data, rng: (l = '') => rngFor(s.seed, s.turn, mod, l), date: turnToDate(s.turn, s.startYear) });

test('programBill: hardware minus appropriation, partners and paying customers', () => {
  const s = fresh();
  const art = data.index.calendar.artemis3;
  const hw = data.index.vehicles[art.vehicleId].costM + data.index.spacecraft[art.spacecraftId].costM;
  const bill = budget.programBill(s, data, art);
  assert.ok(bill > 0 && bill < hw, 'NASA pays part of the Artemis hardware');
  const haven = data.index.calendar.haven1; // SpaceX flying for Vast
  const hwH = data.index.vehicles[haven.vehicleId].costM + data.index.spacecraft[haven.spacecraftId].costM;
  assert.ok(budget.programBill(s, data, haven) <= hwH * 0.2, 'a customer pays most of a commercial flight');
  assert.equal(budget.programBill(s, data, null), 0);
});

test('AI programs draw cash before launch, never below the reserve, and it all stays JSON', () => {
  const s = fresh('isro');
  const ctx = ctxFor(s, 'budget');
  const inst = s.calendar.find((c) => c.id === 'tianwen3');
  const before = s.actors.cnsa.cash;
  for (let t = 0; t < 30; t++) { s.turn = t; budget.tick(s, data, ctx); }
  const paidKeys = Object.keys(s.finance.programs).filter((k) => k.startsWith('tianwen3#'));
  if (inst.currentTurn - 29 < 104) assert.ok(s.finance.programs[paidKeys[0]] > 0, 'Tianwen-3 accrues within two years of launch');
  assert.ok((s.finance.rivals.cnsa?.programs || 0) > 0, 'CNSA paid program bills');
  assert.ok(s.actors.cnsa.cash >= -1, 'programs never push an AI into the red');
  assert.ok(Number.isFinite(before));
  assert.deepEqual(JSON.parse(JSON.stringify(s.finance)), s.finance);
  // a broke AI pays nothing and owes the rest
  s.actors.cnsa.cash = 0;
  const owed = budget.programLoad(s, data, 'cnsa').owedNow;
  s.turn = 30; budget.tick(s, data, ctx);
  assert.ok(budget.programLoad(s, data, 'cnsa').owedNow >= owed - 1e-6 || s.actors.cnsa.cash >= 0);
  assert.ok(s.actors.cnsa.cash >= 0);
});

test('player programs are not billed by budget.js (missions.js charges the player)', () => {
  const s = fresh('nasa');
  const ctx = ctxFor(s, 'budget');
  for (let t = 0; t < 20; t++) { s.turn = t; budget.tick(s, data, ctx); }
  for (const k of Object.keys(s.finance.programs)) assert.notEqual(data.index.calendar[k.split('#')[0]]?.owner, 'nasa');
  assert.equal(s.finance.rivals.nasa, undefined);
});

test('old save without finance.programs still ticks', () => {
  const s = fresh('esa');
  delete s.finance.programs;
  const ctx = ctxFor(s, 'budget');
  s.turn = 3;
  budget.tick(s, data, ctx);
  assert.equal(typeof s.finance.programs, 'object');
});

test('rotationRisk: new vehicles start riskier and mature down to their floor', () => {
  const defs = data.crew.config.rivalCrewFlights.flights;
  const soyuz = defs.find((d) => d.id === 'soyuz_ms');
  const starliner = defs.find((d) => d.id === 'starliner');
  assert.ok(crew.rotationRisk(data, soyuz, 0) <= 0.006, 'mature capsule ~0.3-0.6%');
  assert.ok(crew.rotationRisk(data, starliner, 0) > crew.rotationRisk(data, soyuz, 0));
  assert.ok(crew.rotationRisk(data, starliner, 10) < crew.rotationRisk(data, starliner, 0));
  assert.ok(crew.rotationRisk(data, starliner, 50) >= starliner.riskMin - 1e-9);
});

test('background rotations fly on schedule, skip the player, and old saves get the slice', () => {
  const s = fresh('cnsa', 3);
  for (let i = 0; i < 60; i++) engineTick(s, data);
  const R = s.rivalCrew;
  assert.ok(R && R.flown.soyuz_ms >= 2, 'two Soyuz flights in the first year');
  assert.ok(R.flown.crew_dragon >= 2);
  assert.equal(R.flown.shenzhou || 0, 0, 'Shenzhou is the player\'s (CNSA): not a background flight');
  assert.deepEqual(JSON.parse(JSON.stringify(R)), R);
  // old save: no slice -> numbering counts the flights already behind us
  const old = deserialize(serialize(s));
  delete old.rivalCrew;
  engineTick(old, data);
  assert.ok(old.rivalCrew.flown.soyuz_ms >= 2);
});

test('rival crew loss: news, support/prestige hit, stand-down, signal; deterministic', () => {
  const d2 = JSON.parse(JSON.stringify({ crew: data.crew }));
  const cfg = d2.crew.config.rivalCrewFlights;
  cfg.flights = [{ ...cfg.flights.find((f) => f.id === 'soyuz_ms'), risk: 1, riskMin: 1, week: 0, perYear: 2 }];
  const dataL = { ...data, crew: d2.crew };
  const run = () => {
    const s = fresh('isro', 9);
    s.signalsPending = [];
    s.actors.roscosmos.prestige = 50;
    const sup = s.actors.roscosmos.support;
    const pre = s.actors.roscosmos.prestige;
    s.turn = 0;
    crew.tick(s, dataL, ctxFor(s, 'crew'));
    return { s, sup, pre };
  };
  const { s, sup, pre } = run();
  assert.equal(s.rivalCrew.losses.length, 1);
  assert.ok(s.actors.roscosmos.support < sup && s.actors.roscosmos.prestige < pre);
  assert.ok(s.news.some((n) => n.tags.includes('tragedy') && n.importance === 3));
  assert.ok(s.signalsPending.some((x) => x.type === 'crew/rivalLost' && x.actorId === 'roscosmos'));
  assert.ok(s.rivalCrew.standDown.soyuz_ms > 0);
  const forbidden = new Set(data.crew.forbiddenNames.map((x) => x.toLowerCase()));
  for (const nm of s.rivalCrew.losses[0].names) assert.ok(!forbidden.has(nm.toLowerCase()));
  // grounded: the next rotation (week 26) does not fly
  s.turn = 26; crew.tick(s, dataL, ctxFor(s, 'crew'));
  assert.equal(s.rivalCrew.losses.length, 1);
  const again = run().s;
  assert.deepEqual(again.rivalCrew.losses, [s.rivalCrew.losses[0]], 'same seed, same crew names');
});

test('joint programs credit their partners', () => {
  const s = fresh('isro', 4);
  const esa0 = s.actors.esa.prestige;
  const nasa0 = s.actors.nasa.prestige;
  s.signalsPending.push({ type: 'mission/resolved', calendarId: 'artemis2', actorId: 'nasa', crewed: true, outcome: 'total', phase: 'arrival', turn: s.turn });
  engineTick(s, data);
  assert.ok(s.actors.esa.prestige > esa0, 'ESA (Orion service module) shares the credit');
  assert.ok(s.actors.nasa.prestige >= nasa0);
});

test('one condolence round per tragedy, not per person', () => {
  const s = fresh('isro', 5);
  const before = s.news.length;
  for (let i = 0; i < 4; i++) s.signalsPending.push({ type: 'crew/rivalLost', actorId: 'cnsa', flightId: 'x', n: 3, turn: s.turn });
  // crew/died style burst
  engineTick(s, data);
  const cond = s.news.slice(0, s.news.length - before).filter((n) => /condol|homenag|solidári/i.test(n.headline));
  assert.ok(cond.length <= 1);
});

test('headline variety: rival_first variants are valid and use {milestone}', () => {
  assert.ok(PLACEHOLDERS.includes('milestone'));
  const ids = new Set(data.events.events.map((e) => e.id));
  for (const id of ['rival_first', 'rival_first_offer']) {
    const ev = data.events.events.find((e) => e.id === id);
    assert.ok(ev.variants.length >= 2);
    assert.deepEqual(validateEvent(ev, data, ids), []);
  }
  assert.ok(data.events.groups.rival_first >= 39);
});

test('year summary headline changes from one year to the next', () => {
  const s = fresh('nasa');
  const ctx = ctxFor(s, 'budget');
  const heads = [];
  for (let t = 0; t <= 52 * 3; t++) {
    s.turn = t;
    budget.tick(s, data, ctx);
    const n = s.news.find((x) => x.tags.includes('year') && x.turn === t);
    if (n) heads.push(n.headline.replace(/\d/g, '#'));
  }
  assert.equal(heads.length, 3);
  assert.ok(heads[0].startsWith('Balanço de'));
  assert.ok(new Set(heads).size === 3, 'no repeated year headline');
});

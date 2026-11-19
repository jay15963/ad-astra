// Tests for src/sim/budget.js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query } from '../src/core/engine.js';
import * as budget from '../src/sim/budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const fresh = (playerId = 'nasa') => newGame(data, { seed: 5, playerId });
const ctx = { data, rng: () => null, date: {} };

test('init: finance slice and actor cash', () => {
  const s = fresh();
  assert.ok(Array.isArray(s.finance.ledger));
  assert.equal(s.finance.debtWeeks, 0);
  for (const a of Object.values(s.actors)) assert.ok(Number.isFinite(a.cash));
  assert.deepEqual(JSON.parse(JSON.stringify(s.finance)), s.finance);
});

test('spend / earn / canAfford with credit line', () => {
  const s = fresh();
  const me = s.actors.nasa;
  me.cash = 100;
  assert.equal(budget.canAfford(s, 'nasa', 50), true);
  assert.equal(budget.spend(s, 'nasa', 50, 'missions', 'Teste'), true);
  assert.equal(me.cash, 50);
  // overdraft up to 10% of annual budget
  const line = me.budget * 0.1;
  assert.equal(budget.canAfford(s, 'nasa', 50 + line - 1), true);
  assert.equal(budget.canAfford(s, 'nasa', 50 + line + 1), false);
  assert.equal(budget.spend(s, 'nasa', 50 + line + 1, 'missions'), false);
  assert.equal(me.cash, 50, 'refused spend changes nothing');
  assert.equal(budget.earn(s, 'nasa', 30, 'contracts', 'Contrato'), true);
  assert.equal(me.cash, 80);
  assert.equal(s.finance.year.spent.missions, 50);
  assert.equal(s.finance.year.income, 30);
  const last = s.finance.ledger.at(-1);
  assert.deepEqual([last.amount, last.category], [30, 'contracts']);
  // AI actors: cash only, no ledger entries
  const n = s.finance.ledger.length;
  assert.equal(budget.spend(s, 'cnsa', 10, 'research'), true);
  assert.equal(s.finance.ledger.length, n);
  assert.equal(budget.spend(s, 'ghost', 10), false);
});

test('weekly tick: income and fixed costs for everyone, AI spends surplus', () => {
  const s = fresh();
  const before = Object.fromEntries(Object.values(s.actors).map((a) => [a.id, a.cash]));
  s.turn = 3;
  budget.tick(s, data, ctx);
  const me = s.actors.nasa;
  const expected = (me.budget * (1 - me.fixedCostShare)) / 52;
  assert.ok(Math.abs(me.cash - before.nasa - expected) < 1e-6);
  for (const a of Object.values(s.actors)) {
    if (a.id === 'nasa') continue;
    const net = (a.budget * (1 - a.fixedCostShare)) / 52;
    assert.ok(a.cash - before[a.id] <= net + 1e-6, `${a.id} should not gain more than its net income`);
  }
  assert.ok(s.finance.rivals.cnsa.income > 0);
});

// cap lowered from 300 to 120 (docs/EXPANSION.md §10: saves must stay small over 1,050 years)
test('ledger is capped at 120 entries', () => {
  const s = fresh();
  for (let i = 0; i < 400; i++) budget.earn(s, 'nasa', 1, 'grants');
  assert.equal(s.finance.ledger.length, 120);
});

test('year rollover closes the year, returns idle money, posts summary news', () => {
  const s = fresh();
  for (let t = 0; t < 52; t++) {
    s.turn = t;
    budget.tick(s, data, ctx);
  }
  budget.spend(s, 'nasa', 120, 'research', 'P&D');
  s.actors.nasa.cash = s.actors.nasa.budget * 2; // lots of idle money
  s.turn = 52;
  budget.tick(s, data, ctx);
  const ly = s.finance.lastYear;
  assert.equal(ly.year, s.startYear);
  assert.ok(ly.income > 0 && ly.spent.research === 120);
  assert.ok(ly.returned > 0, 'idle money goes back to the treasury');
  assert.equal(s.finance.year.year, s.startYear + 1);
  assert.equal(s.finance.history.length, 1);
  const n = s.news.find((x) => x.tags.includes('year'));
  assert.ok(n && n.headline.startsWith(`Balanço de ${s.startYear}`));
  assert.match(n.body, /US\$/);
});

test('prolonged debt erodes support and gets the player fired (the director, not the campaign)', () => {
  const s = fresh();
  s.actors.nasa.cash = -1e6;
  s.actors.nasa.support = 12;
  let t = 0;
  while (!s.director?.ousted && t < 200) {
    s.turn = t++;
    budget.tick(s, data, ctx);
  }
  assert.equal(s.gameOver, null, 'being fired never ends the campaign');
  assert.equal(s.director?.ousted?.reason, 'fired');
  assert.equal(s.director.ousted.actorId, 'nasa');
  assert.match(s.director.ousted.summary, /semanas no vermelho/);
  assert.ok(s.finance.debtWeeks >= 8);
  assert.ok(s.news.some((x) => x.tags.includes('director')));
});

test('short debt with healthy support does not fire; leaving the red resets', () => {
  const s = fresh();
  s.actors.nasa.cash = -50;
  for (let t = 1; t < 4; t++) { s.turn = t; budget.tick(s, data, ctx); }
  assert.equal(s.gameOver, null);
  assert.ok(!s.director?.ousted);
  s.actors.nasa.cash = 1000;
  s.turn = 5;
  budget.tick(s, data, ctx);
  assert.equal(s.finance.debtWeeks, 0);
});

test('emergency funds action with cooldown, and summary query', () => {
  const s = fresh();
  const cash0 = s.actors.nasa.cash;
  const sup0 = s.actors.nasa.support;
  const r = dispatch(s, data, { type: 'budget/requestFunds' });
  assert.equal(r.ok, true);
  assert.ok(s.actors.nasa.cash > cash0 && s.actors.nasa.support < sup0);
  assert.equal(dispatch(s, data, { type: 'budget/requestFunds' }).ok, false);
  const sum = query(s, data, 'budget/summary');
  for (const k of ['cash', 'budget', 'weeklyIncome', 'weeklyCost', 'yearSpent', 'lastYear', 'runwayWeeks']) assert.ok(k in sum, k);
  assert.ok(sum.fundsAvailableIn > 0);
  assert.equal(query(s, data, 'budget/summary', 'cnsa').budget, s.actors.cnsa.budget);
  assert.ok(Array.isArray(query(s, data, 'budget/ledger', 5)));
  assert.equal(budget.fmtMoney(1234), 'US$ 1,2 bi');
  assert.equal(budget.fmtMoney(350), 'US$ 350 mi');
});

test('full campaign keeps finance consistent and serializable', () => {
  const s = fresh('isro');
  dispatch(s, data, { type: 'time/advance', weeks: 60, stopOnEvent: false });
  // decisions may block; resolve and keep going a bit
  for (let i = 0; i < 20 && s.turn < 60; i++) {
    for (const d of s.decisions.slice()) dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: (d.choices.find((c) => !c.disabled) || d.choices[0])?.id });
    if (s.activeLaunch) break;
    dispatch(s, data, { type: 'time/advance', weeks: 10, stopOnEvent: false });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s.finance)), s.finance);
  for (const a of Object.values(s.actors)) assert.ok(Number.isFinite(a.cash), a.id);
});

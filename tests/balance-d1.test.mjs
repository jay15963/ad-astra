// Phase D1 — balance per era: investors' mandates the agency can pay, long steps that do not stop on every card,
// and the budget anchor of a founded agency following the eras (docs/EXPANSION.md §5.2, §1.2, PROGRESS Pendências).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import * as inv from '../src/sim/investors.js';
import * as budget from '../src/sim/budget.js';
import { foundingPayload } from '../tools/bot-b.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!engine.MODULES.some(([n]) => n === 'investors')) {
  engine.MODULES.splice(engine.MODULES.findIndex(([n]) => n === 'missions') + 1, 0, ['investors', inv]);
}
const INV = JSON.parse(readFileSync(join(ROOT, 'data/core/investors.json'), 'utf8'));
const withInv = (d) => (d.investors ? d : { ...d, investors: INV });
const lunarBase = await loadDataNode(ROOT);
const lunarInv = withInv({ ...lunarBase, scenario: { ...lunarBase.scenario, unlocks: { investors: { fromYear: 2026 } } } });
const campaign = withInv(await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' }));
const T = inv.tuning(lunarInv);

const ctxOf = (state, extra = {}) => ({
  data: lunarInv, dt: 1, prevTurn: state.turn, turn: state.turn, eraId: state.clock?.eraId,
  rng: (label = '') => rngFor(state.seed, state.turn, 'investors', label), ...extra,
});

function investorHeavy(seed = 21) {
  const s = engine.newGame(lunarInv, { seed, playerId: 'isro' });
  inv.acceptOffer(s, lunarInv, { id: 'o1', archetypeId: 'fundo_vc', holderKind: 'fund', name: 'Horizonte Capital', pct: 20, cashM: 50, profile: 'retorno', termYears: 5 });
  inv.acceptOffer(s, lunarInv, { id: 'o2', archetypeId: 'telecom', holderKind: 'corporation', name: 'Rede Estelar', pct: 20, cashM: 50, profile: 'comunicacoes', termYears: 6 });
  return s; // player 20%
}

// ------------------------------------------------------------------------------------------------ §5.2 agenda

test('agenda per stake follows §5.2 exactly (K = 6): 70% → 3 mandated/3 own, 50% → 4/2, 30% → 5/1, 10% → 5/1', () => {
  const want = { 70: [3, 3], 50: [4, 2], 30: [5, 1], 10: [5, 1] };
  for (const [pct, [M, own]] of Object.entries(want)) {
    assert.equal(inv.mandatedSlots(6, Number(pct), T), M, `M at ${pct}%`);
    assert.equal(6 - inv.mandatedSlots(6, Number(pct), T), own, `own at ${pct}%`);
  }
  // the agenda missions.js reads uses the same numbers; autonomy exactly from 50%
  const s = investorHeavy();
  for (const pct of [70, 50, 30, 10]) {
    s.cap.playerPct = pct;
    const a = inv.agenda(s, lunarInv);
    assert.equal(a.M, inv.mandatedSlots(a.K, pct, T));
    assert.equal(a.own, a.K - a.M);
    assert.ok(a.own >= 1);
    assert.equal(a.autonomous, pct >= 50);
  }
  assert.equal(T.investorCap, 90);
  assert.equal(T.autonomyPct, 50);
});

// ------------------------------------------------------------------------------------------------ mandates the agency can pay

test('mandates: each flight costs at most the yearly budget, all of them at most yearCostShare × budget; the prize covers half the flight', () => {
  for (const budgetM of [40, 120, 400, 5000]) {
    const s = investorHeavy(31);
    s.actors[s.playerId].budget = budgetM;
    s.turn = 52;
    s.cap.year.year = 2026;
    inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51, turn: 52 });
    const mds = s.mandates.filter((m) => m.source === 'investor');
    const K = inv.slotsPerYear(s, lunarInv);
    assert.ok(mds.length <= inv.mandatedSlots(K, s.cap.playerPct, T), 'never more than the M slots of §5.2');
    let total = 0;
    for (const md of mds) {
      assert.ok(Number.isFinite(md.costM), 'the estimated cost is kept on the mandate');
      assert.ok(md.costM <= T.mandate.maxCostShare * budgetM + 1e-9, `${md.title}: US$ ${md.costM} mi ≤ budget ${budgetM}`);
      assert.ok(md.rewardM + 1e-9 >= md.costM * T.mandate.rewardCostShare, 'prize ≥ half the flight');
      assert.ok(md.penalty.cashM <= md.rewardM, 'the fine never exceeds the prize');
      total += md.costM * (md.count || 1);
    }
    assert.ok(total <= T.mandate.yearCostShare * budgetM + 1e-9, `total US$ ${total} mi ≤ ${T.mandate.yearCostShare} × ${budgetM}`);
    if (budgetM >= 5000) assert.ok(mds.length >= 1, 'a rich agency still gets its mandates');
  }
});

test('mandates: deterministic for the same seed and budget', () => {
  const run = () => {
    const s = investorHeavy(41);
    s.actors[s.playerId].budget = 300;
    s.turn = 52;
    s.cap.year.year = 2026;
    inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51, turn: 52 });
    return JSON.stringify(s.mandates);
  };
  assert.equal(run(), run());
});

test('a full board (12 seats) takes no new holder: offers top up a sitting holder of the same archetype', () => {
  const s = engine.newGame(lunarInv, { seed: 71, playerId: 'isro' });
  s.cap.holders = s.cap.holders.filter((h) => h.anchor);
  const anchorPct = s.cap.holders.reduce((a, h) => a + h.pct, 0);
  s.cap.playerPct = 100 - anchorPct;
  const arch = ['fundo_vc', 'telecom', 'defesa_priv', 'mineradora', 'turismo'];
  for (let i = 0; i < 12; i++) {
    const r = inv.acceptOffer(s, lunarInv, { id: `o${i}`, archetypeId: arch[i % arch.length], holderKind: 'fund', name: `Sócio ${i}`, pct: 1, cashM: 1, profile: 'retorno', termYears: 5 });
    assert.equal(r.ok, true);
  }
  assert.equal(s.cap.holders.filter((h) => !h.anchor).length, 12);
  for (let k = 0; k < 20; k++) {
    for (const o of inv.makeOffers(s, lunarInv, rngFor(71, k, 'round'))) {
      const sit = s.cap.holders.find((h) => h.archetypeId === o.archetypeId && h.name === o.name);
      assert.ok(sit, `${o.name} (${o.archetypeId}) is a sitting holder`);
    }
  }
  assert.equal(T.maxHolders, 12);
});

// ------------------------------------------------------------------------------------------------ long steps

test('long steps: a mandate issued outside the attention step waits without a card, then shows with its full term', () => {
  const s = investorHeavy(51);
  s.actors[s.playerId].budget = 5000;
  s.clock.stepWeeks = 13;
  s.turn = 52;
  s.cap.year.year = 2026;
  s.finance.attn = { end: 65, on: false, last: 0 };
  inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 52, turn: 52, dt: 13, stepEnd: 65 });
  const mds = s.mandates.filter((m) => m.source === 'investor');
  assert.ok(mds.length >= 1);
  assert.ok(mds.every((m) => m.deferred && m.spanWeeks >= 52), 'deferred, term kept');
  assert.equal(s.decisions.filter((d) => d.kind === 'investors/mandate').length, 0, 'no card in a quiet step');
  // a quiet step never expires a deferred mandate, even past its first deadline
  s.turn = mds[0].deadlineTurn + 13;
  s.finance.attn = { end: s.turn + 13, on: false, last: 0 };
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: s.turn, turn: s.turn, dt: 13, stepEnd: s.turn + 13 });
  assert.ok(mds.every((m) => m.status === 'open'));
  // the attention step shows them, the deadline counts from here
  s.finance.attn = { end: s.turn + 13, on: true, last: s.turn };
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: s.turn, turn: s.turn, dt: 13, stepEnd: s.turn + 13 });
  for (const md of mds) {
    assert.ok(!md.deferred);
    assert.ok(md.deadlineTurn >= s.turn + 52);
    assert.ok(s.decisions.some((d) => d.kind === 'investors/mandate' && d.payload.mandateId === md.id));
  }
});

test('long steps: the yearly round waits for the attention step; short steps keep the §5.2 cadence', () => {
  const s = investorHeavy(61);
  s.clock.stepWeeks = 13;
  s.turn = 13 * 40;
  s.cap.lastRoundTurn = s.turn - 200;
  s.finance.attn = { end: s.turn + 13, on: false, last: 0 };
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: s.turn, turn: s.turn, dt: 13, stepEnd: s.turn + 13 });
  assert.equal(s.decisions.filter((d) => d.kind === 'investors/round').length, 0);
  s.finance.attn = { end: s.turn + 13, on: true, last: s.turn };
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: s.turn, turn: s.turn, dt: 13, stepEnd: s.turn + 13 });
  assert.equal(s.decisions.filter((d) => d.kind === 'investors/round').length, 1);
  assert.equal(budget.attentionPeriod(2), 0, 'steps of 2 weeks are never gated');
  assert.equal(budget.attentionPeriod(13), 78);
});

// ------------------------------------------------------------------------------------------------ founded agency budget

test('founded agency: the government reference budget follows the founding scale of the eras', () => {
  const s = engine.newGame(campaign, { seed: 7919, playerId: 'nasa' });
  const r = engine.dispatch(s, campaign, foundingPayload(s, campaign, { seed: 7919 }));
  assert.equal(r.ok, true, r.error);
  const pid = s.playerId;
  const base = s.actors[pid].budget;
  const scale = campaign.hqSites.founding.scale;
  let guard = 0;
  while (s.startYear + Math.floor(s.turn / 52) < 1961 && guard++ < 1000 && !s.gameOver) {
    for (const d of s.decisions.slice()) engine.dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: (d.choices?.find((c) => !c.disabled) || d.choices?.[0])?.id });
    engine.dispatch(s, campaign, { type: 'time/advance', turns: 1, stopOnEvent: false });
  }
  assert.ok(!s.gameOver);
  // the last rollover (1960 → 1961) may run in the closing substep of 1960: either year's factor
  const ks = [1960, 1961].map((y) => budget.curveAt(scale, y) / budget.curveAt(scale, 1950));
  assert.ok(ks[0] > 1.5);
  assert.ok(ks.some((k) => Math.abs(s.world.baseBudget[pid] - Math.round(base * k * 10) / 10) < 1), `${s.world.baseBudget[pid]} ≈ ${base} × ${ks.join(' | ')}`);
  assert.equal(s.finance.anchor.actorId, pid);
  // a real agency keeps its own series (no anchor slice)
  const n = engine.newGame(campaign, { seed: 7919, playerId: 'nasa' });
  engine.dispatch(n, campaign, { type: 'time/advance', turns: 30, stopOnEvent: false });
  assert.equal(n.finance.anchor, undefined);
});

test('curveAt: flat outside, linear inside', () => {
  const c = [[1950, 1], [2000, 3]];
  assert.equal(budget.curveAt(c, 1900), 1);
  assert.equal(budget.curveAt(c, 1975), 2);
  assert.equal(budget.curveAt(c, 2500), 3);
  assert.equal(budget.curveAt([], 2000), 1);
});

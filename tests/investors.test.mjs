// Investors, shareholding and mandates (docs/EXPANSION.md §5.1–5.2, Phase B2): the binding formula, the 90% cap,
// the 50% autonomy threshold, funding rounds, dilution, buy-back, mandates replacing story missions, penalties,
// the board removing the director, save migration v2 → v3 and determinism with save/load.
// The engine registry lists investors.js after 'missions' (it reads the missions' results of the same tick); the
// guarded splice below only matters for an engine build without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { migrate, targetVersion } from '../src/core/migrate.js';
import { hash32, rngFor } from '../src/core/rng.js';
import * as inv from '../src/sim/investors.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!engine.MODULES.some(([n]) => n === 'investors')) {
  engine.MODULES.splice(engine.MODULES.findIndex(([n]) => n === 'missions') + 1, 0, ['investors', inv]);
}
const INV = JSON.parse(readFileSync(join(ROOT, 'data/core/investors.json'), 'utf8'));
const withInv = (d) => (d.investors ? d : { ...d, investors: INV });

const lunarBase = await loadDataNode(ROOT);
const campaignBase = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
/** Corrida Lunar world (rich 2026 catalogue, 1-week steps) with investors switched on from 2026. */
const lunarInv = withInv({ ...lunarBase, scenario: { ...lunarBase.scenario, unlocks: { investors: { fromYear: 2026 } } } });
const campaign = withInv(campaignBase);
const T = inv.tuning(lunarInv);

const ctxOf = (state, extra = {}) => ({
  data: lunarInv, dt: 1, prevTurn: state.turn, turn: state.turn, eraId: state.clock?.eraId,
  rng: (label = '') => rngLike(state, label), ...extra,
});
const rngLike = (state, label) => rngFor(state.seed, state.turn, 'investors', label);

function resolveAll(state, data, pick = () => null) {
  for (const d of state.decisions.slice()) {
    if (d.kind === 'launch') continue;
    const c = pick(d) ?? (d.choices?.find((x) => !x.disabled) || d.choices?.[0])?.id;
    engine.dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c ?? 'continue' });
  }
}

function playLaunch(state, data) {
  let lg = 0;
  while (state.activeLaunch && lg++ < 300) {
    const al = state.activeLaunch;
    if (al.pendingIntervention) engine.dispatch(state, data, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
    else if (al.act === 'prelaunch') engine.dispatch(state, data, { type: 'launch/countdown' });
    else if (al.pendingHold) engine.dispatch(state, data, { type: 'launch/hold', choice: 'go' });
    else if (al.act === 'result') engine.dispatch(state, data, { type: 'launch/finish' });
    else engine.dispatch(state, data, { type: 'launch/step' });
  }
}

/** Bot: resolves cards (rounds via `round`), flies whatever is in planning with the engineers' suggestion. */
function play(state, data, turns, { round = () => 'none' } = {}) {
  const end = state.turn + turns;
  while (state.turn < end && !state.gameOver) {
    resolveAll(state, data, (d) => (d.kind === 'investors/round' ? round(d, state) : d.kind === 'era/transition' ? 'continue' : null));
    playLaunch(state, data);
    for (const m of (state.missions || []).filter((x) => x.status === 'planning')) {
      if ((!m.vehicleId || !m.spacecraftId) && m.suggestion) {
        const patch = {};
        if (!m.vehicleId && m.suggestion.vehicleId) patch.vehicleId = m.suggestion.vehicleId;
        if (!m.spacecraftId && m.suggestion.spacecraftId) patch.spacecraftId = m.suggestion.spacecraftId;
        if (Object.keys(patch).length) engine.dispatch(state, data, { type: 'mission/update', missionId: m.id, patch });
      }
      engine.dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
    }
    if (engine.isBlocked(state, data)) { resolveAll(state, data); playLaunch(state, data); if (engine.isBlocked(state, data)) continue; }
    engine.tick(state, data);
  }
  return state;
}

const fresh = (playerId = 'isro', seed = 11, data = lunarInv) => engine.newGame(data, { seed, playerId });
const noVersion = (s) => JSON.stringify({ ...JSON.parse(engine.serialize(s)), version: 0 });

// ------------------------------------------------------------------------------------------------ formula

test('mandated slots follow M = min(K − 1, round(K · s^0.6)) — the §5.2 reference table (K = 6)', () => {
  const table = { 100: 0, 90: 2, 75: 3, 60: 3, 50: 4, 30: 5, 10: 5 };
  for (const [pct, M] of Object.entries(table)) {
    assert.equal(inv.mandatedSlots(6, Number(pct), T), M, `player ${pct}%`);
    assert.ok(6 - inv.mandatedSlots(6, Number(pct), T) >= 1, 'always at least one own slot');
  }
  for (let K = 2; K <= 12; K++) for (let p = 10; p <= 100; p += 5) assert.ok(K - inv.mandatedSlots(K, p, T) >= 1);
  assert.equal(T.exponent, 0.6);
  assert.equal(T.minOwn, 1);
  assert.equal(T.investorCap, 90);
  assert.equal(T.autonomyPct, 50);
});

test('K (slots per year) is ≥ 2 and grows with launch pads', () => {
  const s = fresh();
  const K = inv.slotsPerYear(s, lunarInv);
  assert.ok(K >= 2 && K <= T.maxSlots);
  s.actors[s.playerId].capabilities = { ...(s.actors[s.playerId].capabilities || {}), launchSites: ['a', 'b', 'c'] };
  assert.ok(inv.slotsPerYear(s, lunarInv) >= K);
});

// ------------------------------------------------------------------------------------------------ set-up

test('starting stakes: national agency 60/40 (government), company 70/30 (founders), founded 100%', () => {
  const a = fresh('isro');
  assert.equal(a.cap.kind, 'agency');
  assert.equal(a.cap.playerPct, 60);
  assert.deepEqual(a.cap.holders.map((h) => [h.kind, h.pct, h.anchor]), [['government', 40, true]]);
  assert.match(a.cap.holders[0].name, /^Governo \(/);
  assert.ok(inv.isAutonomous(a, lunarInv));
  const c = fresh('spacex');
  assert.equal(c.cap.kind, 'company');
  assert.equal(c.cap.playerPct, 70);
  assert.equal(c.cap.holders[0].kind, 'founders');
  const f = fresh('isro');
  f.actors.isro.custom = true;
  inv.setupCap(f, lunarInv);
  assert.equal(f.cap.kind, 'founded');
  assert.equal(f.cap.playerPct, 100);
  assert.equal(f.cap.holders.length, 0);
  // every holder emblem is a small §5.4 spec
  for (const h of [...a.cap.holders, ...c.cap.holders]) {
    assert.ok(h.emblem && h.emblem.shape && h.emblem.glyph && h.emblem.field);
    assert.ok(JSON.stringify(h.emblem).length <= 200);
  }
});

test('the Corrida Lunar (no unlocks.investors) never builds a cap table', () => {
  const s = engine.newGame(lunarBase, { seed: 5, playerId: 'nasa' });
  for (let i = 0; i < 60; i++) { s.decisions = s.decisions.filter((d) => !d.blocking); engine.tick(s, lunarBase); }
  assert.equal(s.cap, undefined);
  assert.equal(s.mandates, undefined);
  assert.ok(!s.decisions.some((d) => String(d.kind).startsWith('investors/')));
});

test('a founded agency at turn 0 (new playerId) gets a fresh 100% table on the next tick', () => {
  const s = fresh('isro');
  s.actors.custom_ab12 = { ...s.actors.isro, id: 'custom_ab12', custom: true };
  s.playerId = 'custom_ab12';
  engine.tick(s, lunarInv);
  assert.equal(s.cap.actorId, 'custom_ab12');
  assert.equal(s.cap.playerPct, 100);
});

// ------------------------------------------------------------------------------------------------ rounds

test('offers never cross the 90% investor cap; none at the cap', () => {
  const s = fresh('isro');
  s.cap.holders[0].pct = 85;
  s.cap.playerPct = 15;
  for (let i = 0; i < 40; i++) {
    const offers = inv.makeOffers(s, lunarInv, rngFor(i, 'offers'));
    for (const o of offers) {
      assert.ok(o.pct >= 1 && o.pct <= 5, `offer ${o.pct}% with 5% room`);
      assert.ok(o.cashM > 0);
      assert.ok(o.name && o.profile && o.termYears > 0);
    }
  }
  s.cap.holders[0].pct = 90;
  s.cap.playerPct = 10;
  assert.deepEqual(inv.makeOffers(s, lunarInv, rngFor(1, 'offers')), []);
  const r = inv.acceptOffer(s, lunarInv, { id: 'x', archetypeId: 'fundo_vc', name: 'X', pct: 5, cashM: 10, holderKind: 'fund' });
  assert.equal(r.ok, false);
  assert.equal(s.cap.playerPct, 10);
});

test('yearly round: non-blocking card with 1–3 offers, expires in 8 weeks, offer pct 1..30 and valuation-based price', () => {
  const s = fresh('isro');
  play(s, lunarInv, 27);
  const d = s.decisions.find((x) => x.kind === 'investors/round');
  assert.ok(d, 'a round in July of the first year');
  assert.equal(d.blocking, false);
  assert.equal(d.expiresTurn - d.createdTurn, 8);
  assert.equal(d.defaultChoice, 'none');
  const offers = d.payload.offers;
  assert.ok(offers.length >= 1 && offers.length <= 3);
  const val = s.cap.valuationM;
  assert.ok(val > 0);
  for (const o of offers) {
    assert.ok(o.pct >= 1 && o.pct <= 30);
    // price ≈ pct × valuation × premium (0.9–1.1) × noise (±8%)
    const ratio = o.cashM / ((o.pct / 100) * val);
    assert.ok(ratio > 0.8 && ratio < 1.25, `price ratio ${ratio}`);
  }
  assert.equal(d.choices.at(-1).id, 'none');
  assert.ok(d.choices.every((c) => typeof c.label === 'string' && !/undefined|NaN/.test(c.label + (c.preview || ''))));
});

test('accepting an offer dilutes the player, brings cash (investors category) and may cost the autonomy', () => {
  const s = fresh('isro');
  const cash0 = s.actors.isro.cash;
  const r = inv.acceptOffer(s, lunarInv, { id: 'o1', archetypeId: 'fundo_vc', holderKind: 'fund', name: 'Horizonte Capital', pct: 12, cashM: 80, profile: 'retorno', termYears: 5, emblem: null });
  assert.ok(r.ok);
  assert.equal(s.cap.playerPct, 48);
  assert.equal(r.lostAutonomy, true);
  assert.ok(!inv.isAutonomous(s, lunarInv));
  assert.ok(Math.abs(s.actors.isro.cash - (cash0 + 80)) < 1e-6);
  assert.equal(inv.sumInvestors(s.cap) + s.cap.playerPct, 100);
  // same investor again: the stake grows, no duplicate holder
  inv.acceptOffer(s, lunarInv, { id: 'o2', archetypeId: 'fundo_vc', holderKind: 'fund', name: 'Horizonte Capital', pct: 3, cashM: 20, profile: 'retorno', termYears: 5 });
  assert.equal(s.cap.holders.filter((h) => h.name === 'Horizonte Capital').length, 1);
  assert.equal(s.cap.holders.find((h) => h.name === 'Horizonte Capital').pct, 15);
});

test('investors/accept from the Conselho keeps the other offers of the round open', () => {
  const s = fresh('isro');
  play(s, lunarInv, 27);
  const d = s.decisions.find((x) => x.kind === 'investors/round');
  assert.ok(d);
  const n = d.payload.offers.length;
  const first = d.payload.offers[0];
  const res = engine.dispatch(s, lunarInv, { type: 'investors/accept', offerId: first.id });
  assert.ok(res.ok, res.error);
  const after = s.decisions.find((x) => x.kind === 'investors/round');
  if (n > 1) {
    assert.ok(after);
    assert.ok(!after.payload.offers.some((o) => o.id === first.id));
    assert.equal(after.choices.length, after.payload.offers.length + 1);
  } else assert.equal(after, undefined);
});

// ------------------------------------------------------------------------------------------------ buy-back

test('buy-back costs pct × valuation × 1.15 and restores autonomy', () => {
  const s = fresh('isro');
  inv.acceptOffer(s, lunarInv, { id: 'o1', archetypeId: 'fundo_vc', holderKind: 'fund', name: 'Horizonte Capital', pct: 15, cashM: 50, profile: 'retorno', termYears: 5 });
  assert.equal(s.cap.playerPct, 45);
  const h = s.cap.holders.find((x) => x.name === 'Horizonte Capital');
  s.cap.valuationM = 1000;
  assert.equal(inv.buybackPrice(s, lunarInv, h.id, 10), 115);
  s.actors.isro.cash = -1e6;
  const poor = engine.dispatch(s, lunarInv, { type: 'investors/buyback', holderId: h.id, pct: 10 });
  assert.equal(poor.ok, false);
  assert.match(poor.error, /Caixa insuficiente/);
  s.actors.isro.cash = 5000;
  const ok = engine.dispatch(s, lunarInv, { type: 'investors/buyback', holderId: h.id, pct: 10 });
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.priceM, 115);
  assert.equal(s.cap.playerPct, 55);
  assert.equal(ok.regainedAutonomy, true);
  // buying everything back removes the holder
  engine.dispatch(s, lunarInv, { type: 'investors/buyback', holderId: h.id, pct: 5 });
  assert.ok(!s.cap.holders.some((x) => x.id === h.id));
  assert.equal(s.cap.playerPct, 60);
});

test('buy-back price is never set by the caller: premium in the action is ignored, no free or negative price', () => {
  const s = fresh('isro');
  s.cap.valuationM = 1000;
  s.actors.isro.cash = 5000;
  const h = s.cap.holders.find((x) => x.anchor);
  const free = engine.dispatch(s, lunarInv, { type: 'investors/buyback', holderId: h.id, pct: 10, premium: 0 });
  assert.ok(free.ok, free.error);
  assert.equal(free.priceM, 115);
  assert.equal(s.actors.isro.cash, 5000 - 115);
  const neg = engine.dispatch(s, lunarInv, { type: 'investors/buyback', holderId: h.id, pct: 5, premium: -5 });
  assert.equal(neg.priceM, 57.5);
  assert.equal(s.cap.playerPct, 75);
});

test('investors/setup: only before the first step, and the kind always comes from the actor', () => {
  const s = engine.newGame(lunarInv, { seed: 3, playerId: 'isro' });
  const r0 = engine.dispatch(s, lunarInv, { type: 'investors/setup', kind: 'founded' });
  assert.ok(r0.ok, r0.error);
  assert.equal(s.cap.kind, 'agency');
  assert.equal(s.cap.playerPct, 60);
  s.decisions = s.decisions.filter((d) => !d.blocking);
  engine.tick(s, lunarInv);
  const r1 = engine.dispatch(s, lunarInv, { type: 'investors/setup', kind: 'founded' });
  assert.equal(r1.ok, false);
  assert.equal(s.cap.playerPct, 60);
  assert.ok(s.cap.holders.some((x) => x.anchor));
});

// ------------------------------------------------------------------------------------------------ mandates

function investorHeavy(seed = 21) {
  const s = fresh('isro', seed);
  inv.acceptOffer(s, lunarInv, { id: 'o1', archetypeId: 'fundo_vc', holderKind: 'fund', name: 'Horizonte Capital', pct: 20, cashM: 50, profile: 'retorno', termYears: 5 });
  inv.acceptOffer(s, lunarInv, { id: 'o2', archetypeId: 'telecom', holderKind: 'corporation', name: 'Rede Estelar', pct: 20, cashM: 50, profile: 'comunicacoes', termYears: 6 });
  return s; // player 20%
}

test('below 50%: yearly mandates fill M slots (minus the government program due), binding cards', () => {
  const s = investorHeavy();
  const ctx = { ...ctxOf(s), dt: 1, prevTurn: 51, turn: 52 };
  s.turn = 52;
  s.cap.year.year = 2026;
  inv.onYear(s, lunarInv, ctx);
  const K = inv.slotsPerYear(s, lunarInv);
  const M = inv.mandatedSlots(K, 20, T);
  const investorMandates = s.mandates.filter((m) => m.source === 'investor');
  assert.ok(investorMandates.length >= 1, 'at least one investor mandate');
  assert.ok(investorMandates.length <= M, `${investorMandates.length} ≤ M ${M}`);
  for (const md of investorMandates) {
    assert.ok(md.deadlineTurn > s.turn);
    assert.ok(md.rewardM > 0);
    assert.ok(md.penalty.cashM > 0 && md.penalty.pct >= 1, 'binding mandates carry the holder penalty');
    const card = s.decisions.find((d) => d.kind === 'investors/mandate' && d.payload.mandateId === md.id);
    assert.ok(card);
    assert.equal(card.choices.find((c) => c.id === 'decline').disabled, true);
    assert.equal(card.choices.find((c) => c.id === 'postpone').disabled, true);
    assert.equal(card.defaultChoice, 'accept');
  }
  // binding: decline refused
  const r = engine.dispatch(s, lunarInv, { type: 'investors/mandate', mandateId: investorMandates[0].id, op: 'decline' });
  assert.equal(r.ok, false);
  assert.match(r.error, /obrigatório/);
});

test('accepting a mandate creates a mission in planning without hardware, linked to the mandate', () => {
  const s = investorHeavy();
  s.turn = 52;
  s.cap.year.year = 2026;
  inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51 });
  const card = s.decisions.find((d) => d.kind === 'investors/mandate');
  const md = s.mandates.find((m) => m.id === card.payload.mandateId);
  const res = engine.dispatch(s, lunarInv, { type: 'decision/resolve', id: card.id, choiceId: 'accept' });
  assert.ok(res.ok, res.error);
  assert.ok(res.openBuilder);
  const m = s.missions.find((x) => x.id === res.openBuilder);
  assert.ok(m);
  assert.equal(m.status, 'planning');
  assert.equal(m.vehicleId, null);
  assert.equal(m.mandateId, md.id);
  assert.ok(md.missionIds.includes(m.id));
  assert.equal(md.accepted, true);
});

test('delivering a mandate pays the reward and lifts the holder mood', () => {
  const s = investorHeavy();
  s.turn = 52;
  s.cap.year.year = 2026;
  inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51 });
  const md = s.mandates.find((m) => m.source === 'investor');
  const h = s.cap.holders.find((x) => x.id === md.holderId);
  const mood0 = h.mood;
  const cash0 = s.actors.isro.cash;
  s.missions.push({ id: 'mis_fake', mandateId: md.id, type: md.type, destination: md.destination, status: 'done', attempts: 1, createdTurn: s.turn, result: { outcome: 'total' } });
  inv.onMissionResolved(s, lunarInv, s.missions.at(-1));
  assert.equal(md.status, 'done');
  assert.equal(h.mood, Math.min(100, mood0 + T.mood.delivered));
  assert.ok(Math.abs(s.actors.isro.cash - (cash0 + md.rewardM)) < 1e-6);
  assert.equal(s.cap.year.delivered, 1);
});

test('missed deadline: below 50% mood −25 + cash fine + stake; autonomous only −15', () => {
  // binding
  const s = investorHeavy();
  s.turn = 52;
  s.cap.year.year = 2026;
  inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51 });
  const md = s.mandates.find((m) => m.source === 'investor');
  s.mandates = [md]; // only this one can expire now
  const h = s.cap.holders.find((x) => x.id === md.holderId);
  const [mood0, pct0, player0, cash0] = [h.mood, h.pct, s.cap.playerPct, s.actors.isro.cash];
  s.decisions = [];
  s.turn = md.deadlineTurn + 1;
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: md.deadlineTurn + 1, dt: 1 });
  assert.equal(md.status, 'expired');
  assert.equal(h.mood, Math.max(0, mood0 + T.mood.missed));
  assert.equal(h.pct, pct0 + md.penalty.pct);
  assert.equal(s.cap.playerPct, player0 - md.penalty.pct);
  assert.ok(s.actors.isro.cash < cash0);
  // autonomous
  const a = fresh('isro', 3);
  a.turn = 52;
  a.cap.year.year = 2026;
  a.cap.holders[0].profile = 'retorno';
  const md2 = { id: 'mnd_x', holderId: 'h_anchor', source: 'investor', title: 'Teste', type: 'satellite', destination: 'leo', count: 1, delivered: 0, deadlineTurn: 60, rewardM: 5, penalty: { mood: -25 }, missionIds: [], credited: [], failedFlights: 0, status: 'open', createdTurn: 52 };
  a.mandates.push(md2);
  const m0 = a.cap.holders[0].mood;
  a.turn = 62;
  inv.tick(a, lunarInv, { ...ctxOf(a), prevTurn: 62, dt: 1 });
  assert.equal(md2.status, 'expired');
  assert.equal(a.cap.holders[0].mood, m0 + T.mood.missedAutonomous);
  assert.equal(a.cap.playerPct, 60);
});

test('autonomous (≥ 50%): a mandate may be postponed once and declined (mood −15 each)', () => {
  const s = fresh('isro');
  s.mandates.push({ id: 'mnd_y', holderId: 'h_anchor', source: 'investor', title: 'Teste', type: 'satellite', destination: 'leo', count: 1, delivered: 0, deadlineTurn: 100, rewardM: 5, penalty: { mood: -25 }, missionIds: [], credited: [], failedFlights: 0, status: 'open', createdTurn: 0 });
  const h = s.cap.holders[0];
  const m0 = h.mood;
  let r = engine.dispatch(s, lunarInv, { type: 'investors/mandate', mandateId: 'mnd_y', op: 'postpone' });
  assert.ok(r.ok, r.error);
  assert.equal(r.deadlineTurn, 152);
  assert.equal(h.mood, m0 + T.mood.postpone);
  r = engine.dispatch(s, lunarInv, { type: 'investors/mandate', mandateId: 'mnd_y', op: 'postpone' });
  assert.equal(r.ok, false);
  r = engine.dispatch(s, lunarInv, { type: 'investors/mandate', mandateId: 'mnd_y', op: 'decline' });
  assert.ok(r.ok);
  assert.equal(s.mandates.find((m) => m.id === 'mnd_y').status, 'expired');
  assert.equal(h.mood, m0 + T.mood.postpone + T.mood.decline);
});

test('story missions become mandates of the anchor holder (calendar items of the player within 2 years)', () => {
  const s = fresh('isro');
  engine.tick(s, lunarInv);
  const own = s.calendar.filter((c) => c.status === 'player' && (c.currentTurn ?? c.plannedTurn) <= s.turn + T.mandate.calendarHorizonWeeks);
  assert.ok(own.length > 0, 'ISRO has program items in 2026–2027');
  for (const inst of own) {
    const md = s.mandates.find((m) => m.calendarId === inst.id);
    assert.ok(md, inst.id);
    assert.equal(md.holderId, 'h_anchor');
    assert.equal(md.source, 'calendar');
    assert.ok(md.deadlineTurn >= (inst.plannedTurn ?? 0));
  }
  // a founded agency (no anchor) has no program mandates
  const f = fresh('isro');
  f.actors.isro.custom = true;
  inv.setupCap(f, lunarInv);
  engine.tick(f, lunarInv);
  assert.equal(f.mandates.filter((m) => m.source === 'calendar').length, 0);
});

test('a program cancelled while binding is a missed mandate; while autonomous a decline', () => {
  const s = fresh('isro');
  engine.tick(s, lunarInv);
  const md = s.mandates.find((m) => m.source === 'calendar');
  const inst = s.calendar.find((c) => c.id === md.calendarId);
  const m0 = s.cap.holders[0].mood;
  inst.status = 'cancelled';
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: s.turn });
  assert.equal(md.status, 'expired');
  assert.equal(md.declined, true);
  assert.equal(s.cap.holders[0].mood, m0 + T.mood.decline);
  const b = investorHeavy(4);
  engine.tick(b, lunarInv);
  const mb = b.mandates.find((m) => m.source === 'calendar');
  b.calendar.find((c) => c.id === mb.calendarId).status = 'cancelled';
  const mb0 = b.cap.holders.find((x) => x.anchor).mood;
  inv.tick(b, lunarInv, { ...ctxOf(b), prevTurn: b.turn });
  assert.equal(mb.status, 'expired');
  assert.ok(!mb.declined);
  assert.equal(b.cap.holders.find((x) => x.anchor).mood, Math.max(0, mb0 + T.mood.missed));
});

// ------------------------------------------------------------------------------------------------ board

test('board: weighted mood < 20 at two consecutive rounds below 50% removes the director (warning first)', () => {
  const s = investorHeavy();
  for (const h of s.cap.holders) h.mood = 5;
  s.turn = 26;
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: 26, dt: 1 });
  assert.equal(s.cap.lowRounds, 1);
  assert.ok(s.decisions.some((d) => d.kind === 'investors/warning'));
  assert.equal(s.gameOver, null);
  s.turn = 78;
  inv.tick(s, lunarInv, { ...ctxOf(s), prevTurn: 78, dt: 1 });
  assert.equal(s.gameOver, null, 'the board removes the director, not the campaign');
  assert.equal(s.director?.ousted?.reason, 'board');
  assert.match(s.director.ousted.summary, /conselho/i);
  // autonomous: never removed
  const a = fresh('isro', 9);
  a.cap.holders[0].mood = 0;
  for (const t of [26, 78, 130]) { a.turn = t; inv.tick(a, lunarInv, { ...ctxOf(a), prevTurn: t, dt: 1 }); }
  assert.equal(a.gameOver, null);
  assert.ok(!a.director?.ousted);
  assert.equal(a.cap.lowRounds, 0);
});

test('dividends lift the board mood; boardView has everything the Conselho screen shows', () => {
  const s = investorHeavy();
  for (const h of s.cap.holders) h.mood = 30;
  s.actors.isro.cash = 5000;
  s.cap.valuationM = 1000;
  const r = engine.dispatch(s, lunarInv, { type: 'investors/dividend', amountM: 20 });
  assert.ok(r.ok);
  assert.equal(r.moodGain, 8);
  assert.ok(s.cap.holders.every((h) => h.mood === 38));
  const v = engine.query(s, lunarInv, 'investors/board');
  assert.equal(v.playerPct, 20);
  assert.equal(v.investorsPct, 80);
  assert.equal(v.autonomous, false);
  assert.ok(v.agenda.K >= 2 && v.agenda.own >= 1 && v.agenda.M === v.agenda.K - v.agenda.own);
  assert.equal(v.holders[0].pct >= v.holders.at(-1).pct, true);
  assert.equal(engine.query(s, lunarInv, 'investors/canFlyOwn').ok, true);
  assert.equal(engine.query(s, lunarInv, 'investors/autonomous'), false);
  assert.ok(!/undefined|NaN/.test(JSON.stringify(v)));
});

test('peer hooks for missions.js (B5): agenda, linkMandateMission, onMandateDeclined', () => {
  const s = investorHeavy();
  const a = inv.agenda(s, lunarInv);
  assert.equal(a.M, inv.mandatedSlots(a.K, 20, T));
  s.mandates.push({ id: 'mnd_z', holderId: s.cap.holders[1].id, source: 'investor', title: 'Z', type: 'satellite', destination: 'leo', count: 1, delivered: 0, deadlineTurn: 100, rewardM: 1, penalty: {}, missionIds: [], credited: [], failedFlights: 0, status: 'open', createdTurn: 0 });
  inv.linkMandateMission(s, lunarInv, 'mnd_z', 'mis_q');
  assert.deepEqual(s.mandates.at(-1).missionIds, ['mis_q']);
  const f = fresh('isro');
  engine.tick(f, lunarInv);
  const md = f.mandates.find((m) => m.source === 'calendar');
  const d0 = md.deadlineTurn;
  inv.onMandateDeclined(f, lunarInv, { holderId: 'h_anchor', calendarId: md.calendarId, choice: 'delay' });
  assert.equal(md.deadlineTurn, d0 + 13);
  inv.onMandateDeclined(f, lunarInv, { holderId: 'h_anchor', calendarId: md.calendarId, choice: 'cancel' });
  assert.equal(md.status, 'expired');
});

// ------------------------------------------------------------------------------------------------ whole game

test('a bot that sells every year: dilution stops at 10%, rounds stop at the cap, no errors, mandates fly', () => {
  const s = fresh('isro', 31);
  play(s, lunarInv, 4 * 52, { round: (d) => d.choices[0].id });
  assert.ok(s.cap.playerPct >= 10);
  assert.ok(inv.sumInvestors(s.cap) <= 90);
  assert.equal(inv.sumInvestors(s.cap) + s.cap.playerPct, 100);
  assert.ok(s.cap.history.length >= 3);
  assert.ok(s.mandates.some((m) => m.source === 'investor'));
  assert.ok(s.missions.some((m) => m.mandateId), 'mandate missions were created');
  assert.deepEqual(s.log.filter((l) => l.includes('erro')), []);
  for (const md of s.mandates) assert.ok(['open', 'flying', 'done', 'failed', 'expired'].includes(md.status));
  assert.ok(s.mandates.filter((m) => m.status === 'open' || m.status === 'flying').length + 24 >= s.mandates.length);
});

test('determinism: same seed and choices → same state; save/load mid-run changes nothing', () => {
  const run = (cut) => {
    let s = fresh('isro', 77);
    play(s, lunarInv, 70, { round: (d) => d.choices[0].id });
    if (cut) s = engine.deserialize(engine.serialize(s), lunarInv);
    play(s, lunarInv, 60, { round: (d) => d.choices[0].id });
    return noVersion(s);
  };
  const a = run(false);
  assert.equal(hash32(a), hash32(run(false)));
  assert.equal(hash32(a), hash32(run(true)));
});

test('campaign 1950: NACA starts 60/40 with the government; rounds and yearly history run over the 13-week steps', () => {
  const s = engine.newGame(campaign, { seed: 2, playerId: 'nasa' });
  assert.equal(s.cap.playerPct, 60);
  assert.match(s.cap.holders[0].name, /Governo \(EUA\)/);
  play(s, campaign, 7 * 52, { round: (d) => d.choices[0].id }); // 1950 → 1957 (13-week then 2-week steps)
  assert.ok(s.cap.history.length >= 5);
  assert.ok(s.cap.history.every((h, i, a) => i === 0 || h.year > a[i - 1].year), 'one history row per year');
  assert.ok(s.cap.playerPct < 60, 'sold stakes in the yearly rounds');
  // e1 investors are ministries (era archetypes)
  assert.ok(s.cap.holders.filter((h) => !h.anchor).every((h) => h.kind === 'government'));
  const back = engine.deserialize(engine.serialize(s), campaign);
  assert.equal(noVersion(back), noVersion(s));
});

// ------------------------------------------------------------------------------------------------ migration

test('save migration v2 → v3 adds cap and mandates (registered by investors.js)', () => {
  assert.equal(targetVersion(), 4); // + v3 → v4 (research.js, Missões v2)
  const s = engine.newGame(campaign, { seed: 4, playerId: 'nasa' });
  const raw = JSON.parse(engine.serialize(s));
  delete raw.cap;
  delete raw.mandates;
  raw.version = 2;
  const m = migrate(JSON.stringify(raw), campaign);
  assert.equal(m.version, 4);
  assert.equal(m.cap, null);
  assert.deepEqual(m.mandates, []);
  // the next tick rebuilds the table for the player
  engine.tick(m, campaign);
  assert.equal(m.cap.playerPct, 60);
});

test('compaction keeps open mandates and at most 24 resolved; history ≤ 60 rows', () => {
  const s = fresh('isro');
  for (let i = 0; i < 60; i++) s.mandates.push({ id: `old${i}`, holderId: 'h_anchor', status: 'done', resolvedTurn: i, missionIds: [], credited: [] });
  s.mandates.push({ id: 'live', holderId: 'h_anchor', status: 'open', missionIds: [], credited: [] });
  for (let y = 0; y < 90; y++) s.cap.history.push({ year: 1900 + y, playerPct: 50, raisedM: 1, delivered: 1, failed: 0 });
  inv.compact(s, lunarInv);
  assert.ok(s.mandates.some((m) => m.id === 'live'));
  assert.ok(s.mandates.filter((m) => m.status === 'done').length <= 24);
  assert.ok(s.cap.history.length <= 60);
  assert.ok(s.cap.history.some((h) => h.decade));
});

test('history stays ≤ 60 rows over a millennium (years → decades → centuries, means kept)', () => {
  let h = [];
  for (let y = 1950; y < 3000; y++) {
    h.push({ year: y, playerPct: y < 2500 ? 60 : 20, raisedM: 1, delivered: 1, failed: 0 });
    h = inv.foldHistory(h, 60);
    assert.ok(h.length <= 60);
  }
  assert.ok(h.some((r) => r.century) && h.some((r) => r.decade) && h.some((r) => !r.span));
  assert.equal(h.reduce((s, r) => s + (r.delivered || 0), 0), 1050, 'no year lost in the folding');
  assert.ok(h.every((r, i) => i === 0 || r.year > h[i - 1].year), 'chronological');
});

test('an unanswered mandate card is accepted on expiry without opening a mission', () => {
  const s = investorHeavy(8);
  s.turn = 52;
  s.cap.year.year = 2026;
  inv.onYear(s, lunarInv, { ...ctxOf(s), prevTurn: 51 });
  const card = s.decisions.find((d) => d.kind === 'investors/mandate');
  const md = s.mandates.find((m) => m.id === card.payload.mandateId);
  const n = s.missions.length;
  s.turn = card.expiresTurn;
  engine.tick(s, lunarInv);
  assert.equal(md.accepted, true);
  assert.equal(s.missions.filter((m) => m.mandateId === md.id).length, 0);
  assert.ok(s.missions.length >= n);
});

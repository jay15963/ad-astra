// Tender board (tela Contratos, docs/MISSIONS-V2.md §2.1): era-appropriate tenders that someone can fly, a reference
// price above the cost of flying it, live odds (price, reputation, reliability, record), the player's sealed bid,
// award with the advance, a second attempt after a failure with time left, fines on default or late failure, rivals
// flying their contracts, old push-offer cards retired, determinism and save/load. Real campaign data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCampaignData, dataStartingAt } from '../tools/campaign.mjs';
import * as engine from '../src/core/engine.js';
import * as missions from '../src/sim/missions.js';
import * as gating from '../src/core/gating.js';
import { tenderMove } from '../tools/golden.mjs';
import { chanceText, marginText, tenderFilter, resultChip } from '../src/ui/contracts.js';
import { contractsBadge } from '../src/ui/screens.js';

const campaign = await loadCampaignData();
const T = missions.boardTuning(campaign);
const at = (year) => dataStartingAt(campaign, year);

/** A fresh game at `year`, advanced `steps` player steps with every card answered by its default. */
function play(year, { seed = 7, playerId = 'nasa', steps = 12, bid = false } = {}) {
  const data = at(year);
  const s = engine.newGame(data, { seed, playerId });
  for (let i = 0; i < steps && !s.gameOver; i++) step(s, data, bid);
  return { s, data };
}
function step(s, data, bid = false) {
  for (const d of s.decisions.slice()) {
    const c = d.choices?.find((x) => x.id === d.defaultChoice) || d.choices?.find((x) => !x.disabled) || d.choices?.[0];
    const r = engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    if (!r.ok) s.decisions = s.decisions.filter((x) => x !== d);
  }
  s.activeLaunch = null;
  if (bid) tenderMove(s, data, engine);
  engine.dispatch(s, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
}
const rowOf = (kind) => campaign.contracts.contracts.find((r) => r.kind === kind);

test('board: several era-appropriate tenders, each flyable by someone, the reference price above the cost of flying it', () => {
  for (const year of [1962, 1990, 2030]) {
    const { s } = play(year, { steps: 14 });
    assert.ok(s.contracts.length >= 4, `${year}: ${s.contracts.length} tenders`);
    assert.ok(s.contracts.filter((c) => c.status === 'open' || c.status === 'bidding').length >= 2, `${year}: open tenders on the board`);
    for (const c of s.contracts) {
      const row = rowOf(c.kind);
      assert.ok(row, c.kind);
      const created = s.startYear + Math.floor(c.createdTurn / 52);
      if (row.needs?.fromYear) assert.ok(created >= row.needs.fromYear, `${c.kind} in ${created}`);
      if (row.needs?.untilYear) assert.ok(created <= row.needs.untilYear, `${c.kind} in ${created}`);
      // someone could fly it when it opened: a rival bid, or the player itself
      assert.ok(c.rivals.length > 0 || c.feasAtCreate, `${c.title}: nobody can fly it`);
      // the lowest bid still pays more than the typical cost of the job
      assert.ok(c.valueM * T.bidRange[0] > c.costM, `${c.title}: ref ${c.valueM}, cost ${c.costM}`);
      assert.ok(c.closeTurn > c.createdTurn && c.deadlineTurn > c.closeTurn + 7, `${c.title}: dates`);
      for (const r of c.rivals) assert.ok(r.price >= Math.ceil(c.valueM * T.bidRange[0]) - 1 && r.price <= Math.floor(c.valueM * T.bidRange[1]) + 1, `${c.title}: rival bid in range`);
    }
  }
});

test('1950 with no rocket in the world: no tenders (only what someone can fly is published)', () => {
  const { s } = play(1950, { steps: 6 });
  assert.equal(s.contracts.length, 0);
});

test('odds: probabilities sum to 1, a lower price, more reputation and a better record raise the chance', () => {
  const { s, data } = play(1990, { steps: 10 });
  const c = s.contracts.find((x) => (x.status === 'open' || x.status === 'bidding') && x.rivals.length && missions.tenderFeasibility(s, data, x).level !== 'bad');
  assert.ok(c, 'a tender the player can bid on');
  const o = (p) => missions.tenderOdds(s, data, c, p);
  const lo = o(c.valueM * 0.6);
  const mid = o(c.valueM);
  const hi = o(c.valueM * 1.4);
  assert.ok(lo.chance > mid.chance && mid.chance > hi.chance, `${lo.chance} > ${mid.chance} > ${hi.chance}`);
  assert.ok(Math.abs(mid.field.reduce((a, e) => a + e.p, 0) - 1) < 1e-9);
  assert.equal(o(c.valueM * 0.1).price, Math.ceil(c.valueM * 0.6), 'clamped to the range');
  const pid = s.playerId;
  const rep0 = s.actors[pid].reputation;
  s.actors[pid].reputation = Math.min(100, rep0 + 30);
  const repUp = o(c.valueM).chance;
  s.actors[pid].reputation = rep0;
  assert.ok(repUp > mid.chance, 'reputation helps');
  s.tenders.record[pid] = { won: 5, ok: 5, bad: 0 };
  assert.ok(o(c.valueM).chance > mid.chance, 'delivered contracts help');
  s.tenders.record[pid] = { won: 3, ok: 0, bad: 3 };
  assert.ok(o(c.valueM).chance < mid.chance, 'failed contracts hurt');
  s.tenders.record[pid] = { won: 0, ok: 0, bad: 0 };
  // economics shown in the sheet: the player's cost with its rocket, the margin and the money split
  assert.ok(mid.costM > 0);
  assert.equal(mid.marginM, Math.round((mid.price - mid.costM) * 10) / 10);
  assert.equal(mid.advanceM, Math.round(mid.price * T.advance));
  assert.equal(mid.fineM, Math.round(mid.price * T.finePct));
  // a better rocket (more reliable) never lowers the chance at the same price
  const f = missions.tenderFeasibility(s, data, c);
  const byRel = f.vehicles.slice().sort((a, b) => a.rel - b.rel);
  if (byRel.length > 1 && byRel[0].rel < byRel[byRel.length - 1].rel) {
    assert.ok(o(c.valueM).chance >= 0);
    assert.ok(missions.tenderOdds(s, data, c, c.valueM, byRel[byRel.length - 1].vehicleId).chance > missions.tenderOdds(s, data, c, c.valueM, byRel[0].vehicleId).chance);
  }
});

test('bids: range enforced, change and withdraw before the close, refused when the agency cannot deliver', () => {
  const { s, data } = play(1990, { steps: 10 });
  const c = s.contracts.find((x) => x.status === 'open' && missions.tenderFeasibility(s, data, x).level !== 'bad');
  assert.ok(c);
  const bid = (price, vehicleId) => engine.dispatch(s, data, { type: 'contract/bid', contractId: c.id, price, vehicleId });
  assert.equal(bid(Math.floor(c.valueM * 0.5)).ok, false);
  assert.equal(bid(Math.ceil(c.valueM * 1.5)).ok, false);
  const r = bid(Math.round(c.valueM * 0.9));
  assert.equal(r.ok, true, r.error);
  assert.equal(c.status, 'bidding');
  assert.ok(r.chance > 0 && r.chance < 1);
  assert.equal(bid(Math.round(c.valueM * 0.8)).ok, true);
  assert.equal(c.playerBid.price, Math.round(c.valueM * 0.8));
  assert.equal(engine.dispatch(s, data, { type: 'contract/withdraw', contractId: c.id }).ok, true);
  assert.equal(c.status, 'open');
  assert.equal(c.playerBid, null);
  // a job no rocket of the agency lifts: red, with the reason, and the bid is refused
  const big = { ...c, id: 'ctr_big', payloadT: 5000, clientPayload: true, rivals: [], playerBid: null };
  s.contracts.push(big);
  const f = missions.tenderFeasibility(s, data, big);
  assert.equal(f.level, 'bad');
  assert.match(f.text, /^Nenhum foguete seu leva 5000 t/);
  assert.equal(engine.dispatch(s, data, { type: 'contract/bid', contractId: big.id, price: big.valueM }).ok, false);
  // closed tenders take no bids
  c.status = 'closed';
  assert.equal(bid(Math.round(c.valueM * 0.9)).status, 'gone');
});

test('the investors\' agenda: a binding board blocks bids once the own slots are taken; contracts count as own missions', () => {
  const { s, data } = play(1990, { steps: 10 });
  assert.ok(s.cap, 'campaign agency with a cap table');
  const c = s.contracts.find((x) => x.status === 'open' && missions.tenderFeasibility(s, data, x).level !== 'bad');
  assert.ok(c);
  s.cap.playerPct = 20; // below 50%: the board's agenda is binding
  const ag = missions.agendaOf(s, data);
  assert.equal(ag.enforced, true);
  const year = ag.year;
  const created = s.turn;
  for (let i = 0; i < ag.left; i++) s.missions.push({ id: `mis_fill${i}`, source: 'custom', status: 'planning', createdTurn: created, name: 'x', type: 'satellite', destination: 'leo' });
  const f = missions.tenderFeasibility(s, data, c);
  assert.equal(f.level, 'bad');
  assert.match(f.text, /Agenda tomada pelos investidores/);
  // a contract mission is one own mission of the year (a second attempt of the same contract is not another one)
  s.missions = s.missions.filter((m) => !m.id.startsWith('mis_fill'));
  const used0 = missions.agendaOf(s, data).used;
  s.missions.push({ id: 'mis_c1', source: 'contract', contractId: 'ctr_x', status: 'planning', createdTurn: created, name: 'c', type: 'satellite', destination: 'leo' });
  s.missions.push({ id: 'mis_c2', source: 'contract', contractId: 'ctr_x', status: 'planning', createdTurn: created, name: 'c2', type: 'satellite', destination: 'leo' });
  assert.equal(missions.agendaOf(s, data).used, Math.max(used0 + 1, used0), `own missions of ${year}`);
});

function awardedContract(s, data, { deadlineIn = 80 } = {}) {
  const c = s.contracts.find((x) => x.status === 'open' && missions.tenderFeasibility(s, data, x).level !== 'bad');
  assert.ok(c);
  const r = engine.dispatch(s, data, { type: 'contract/bid', contractId: c.id, price: Math.round(c.valueM * 0.8) });
  assert.equal(r.ok, true, r.error);
  c.rivals = []; // sole bidder: certain win
  c.closeTurn = s.turn;
  c.deadlineTurn = s.turn + deadlineIn;
  const cash0 = s.actors[s.playerId].cash;
  missions.tick(s, data, { rng: () => ({ next: () => 0.5, int: (a) => a, range: (a) => a, chance: () => false, weighted: (x) => x[0], pick: (x) => x[0], shuffle: (x) => x }), stepEnd: s.turn + 1, dt: 1, prevTurn: s.turn, turn: s.turn });
  assert.equal(c.status, 'awarded');
  assert.equal(c.winner, s.playerId);
  assert.equal(c.advancePaidM, Math.round(c.winningPrice * T.advance));
  assert.ok(s.actors[s.playerId].cash > cash0 - 1e-9 + c.advancePaidM - 1, 'advance received');
  const m = s.missions.find((x) => x.id === c.missionId);
  assert.ok(m && m.source === 'contract' && m.vehicleId === null && m.suggestion?.vehicleId, 'mission without hardware, the bid rocket suggested');
  return { c, m };
}

test('award, a second attempt after a failure with time left, then a fine when it fails again', () => {
  const { s, data } = play(1990, { steps: 10 });
  const { c, m } = awardedContract(s, data, { deadlineIn: 80 });
  m.status = 'launch';
  missions.onLaunchResolved(s, data, m.id, 'ascent', { level: 'catastrophic' });
  assert.equal(c.status, 'awarded');
  assert.equal(c.failures, 1);
  const m2 = s.missions.find((x) => x.id === c.missionId);
  assert.ok(m2 && m2.id !== m.id && /2ª tentativa/.test(m2.name), 'a new mission for the retry');
  const cash = s.actors[s.playerId].cash;
  const rep = s.actors[s.playerId].reputation;
  m2.status = 'launch';
  missions.onLaunchResolved(s, data, m2.id, 'ascent', { level: 'catastrophic' });
  assert.equal(c.status, 'failed');
  assert.equal(c.fineM, Math.round(c.winningPrice * T.finePct));
  assert.ok(s.actors[s.playerId].cash < cash, 'fine paid');
  assert.ok(s.actors[s.playerId].reputation < rep, 'reputation lost');
  assert.equal(missions.recordOf(s, s.playerId).bad, 1);
  assert.ok(s.news.some((n) => /paga multa/.test(n.headline)));
});

test('a failure with no time left to fly again: fine and reputation at once', () => {
  const { s, data } = play(1990, { steps: 10 });
  const { c, m } = awardedContract(s, data, { deadlineIn: 3 });
  const cash = s.actors[s.playerId].cash;
  m.status = 'launch';
  missions.onLaunchResolved(s, data, m.id, 'ascent', { level: 'recoverable' });
  assert.equal(c.status, 'failed');
  assert.ok(s.actors[s.playerId].cash <= cash - c.fineM + 1e-6);
});

test('deadline: late at the deadline (pay cut), called off with the fine after the grace', () => {
  const { s, data } = play(1990, { steps: 10 });
  const { c } = awardedContract(s, data, { deadlineIn: 10 });
  const rep0 = s.actors[s.playerId].reputation;
  const ctx = () => ({ rng: () => ({ next: () => 0.99, int: (a) => a, range: (a) => a, chance: () => false, weighted: () => null, pick: (x) => x[0], shuffle: (x) => x }), stepEnd: s.turn + 1, dt: 1, prevTurn: s.turn, turn: s.turn });
  s.turn = c.deadlineTurn + 1;
  missions.tick(s, data, ctx());
  assert.equal(c.status, 'late');
  const cash = s.actors[s.playerId].cash;
  s.turn = c.deadlineTurn + Math.round(T.graceWeeks * Math.min(6, Math.max(1, (s.clock?.stepWeeks || 1) / 4))) + 1;
  missions.tick(s, data, ctx());
  assert.equal(c.status, 'defaulted');
  assert.equal(c.fineM, Math.round(c.winningPrice * T.finePct));
  assert.ok(s.actors[s.playerId].cash < cash);
  assert.ok(s.actors[s.playerId].reputation <= rep0 + T.rep.late + T.rep.default + 1);
});

test('rivals win and fly their contracts: delivered or failed by the deadline, with records and news', () => {
  const { s } = play(1990, { steps: 40 });
  const ai = s.contracts.filter((c) => c.status === 'closed' && c.ai);
  assert.ok(ai.length >= 3, `${ai.length} contracts won by rivals`);
  const done = ai.filter((c) => c.ai.done != null);
  assert.ok(done.length >= 1, 'some were flown');
  for (const c of done) {
    assert.equal(typeof c.ai.ok, 'boolean');
    assert.ok(c.ai.done <= c.deadlineTurn, `${c.title} flown by the deadline`);
    const rec = missions.recordOf(s, c.winner);
    assert.ok(rec.won >= 1 && rec.ok + rec.bad >= 1);
  }
});

test('determinism and save/load: same seed, same board; a saved game continues identically', () => {
  const a = play(1975, { seed: 11, steps: 20, bid: true });
  const b = play(1975, { seed: 11, steps: 20, bid: true });
  assert.equal(engine.serialize(a.s), engine.serialize(b.s));
  assert.ok(a.s.contracts.some((c) => c.playerBid), 'the bot bid');
  const json = engine.serialize(a.s);
  const c = engine.deserialize(json, a.data);
  assert.equal(engine.serialize(c), json);
  for (let i = 0; i < 12; i++) { step(a.s, a.data, true); step(c, a.data, true); }
  assert.equal(engine.serialize(c), engine.serialize(a.s));
});

test('old saves: push-offer cards are retired and their contract stays on the board as a tender', () => {
  const { s, data } = play(1990, { steps: 4 });
  const pid = s.playerId;
  const rival = Object.keys(s.actors).find((id) => id !== pid);
  // a contract of the push-offer system (before v0.9.12): no size, client kind, cost or record; its bid card on the table
  s.contracts.push({
    id: 'ctr_old', kind: 'gto_comms', title: 'Satélite de comunicações para GTO', client: 'Operadora', body: '', type: 'satellite', sub: 'comms', payloadKind: 'client',
    destination: 'gto', payloadT: 1, clientPayload: true, valueM: 200, createdTurn: s.turn, closeTurn: s.turn + 3, deadlineTurn: s.turn + 40, status: 'open',
    rivals: [{ actorId: rival, price: 190, reliability: 0.9, noise: 1.2 }], playerBid: null, winner: null, winningPrice: null, missionId: null, advancePaidM: 0, late: false,
  });
  s.decisions.push({ id: 'dec_old', kind: 'contract/offer', title: 'Contrato', body: '', choices: [{ id: 'bid_mid', label: 'x' }, { id: 'pass', label: 'y' }], payload: { contractId: 'ctr_old' }, createdTurn: s.turn, expiresTurn: s.turn + 3 });
  const back = engine.deserialize(engine.serialize(s), data);
  // a stale card still answers (as a bid at its level) until the first tick retires it
  assert.equal(engine.dispatch(back, data, { type: 'decision/resolve', id: 'dec_old', choiceId: 'pass' }).ok, true);
  back.decisions.push({ id: 'dec_old2', kind: 'contract/offer', title: 'Contrato', body: '', choices: [{ id: 'pass', label: 'y' }], payload: { contractId: 'ctr_old' }, createdTurn: back.turn });
  step(back, data);
  assert.ok(!back.decisions.some((d) => d.kind === 'contract/offer'));
  const old = back.contracts.find((c) => c.id === 'ctr_old');
  assert.ok(old && ['open', 'bidding', 'closed', 'expired', 'awarded'].includes(old.status));
  const board = engine.query(back, data, 'contracts/board');
  assert.ok(board && Array.isArray(board.open));
});

test('sounding contracts: a suborbital sounding flight needs sounding rockets, not the probe research', () => {
  const s = engine.newGame(campaign, { seed: 1, playerId: 'nasa' });
  assert.equal(gating.missionGate(s, campaign, { type: 'probe', sub: 'sounding' }).ok, true);
  assert.equal(gating.missionGate(s, campaign, { type: 'probe', sub: 'orbiter' }).ok, false);
  assert.equal(missions.resolveSub(s, campaign, { type: 'probe', destination: 'suborbital' }), 'sounding');
});

test('Contratos UI helpers and drawer badge', () => {
  assert.equal(chanceText(0.004), '<1%');
  assert.equal(chanceText(0.034), '3,4%');
  assert.equal(chanceText(0.5), '50%');
  assert.equal(marginText(24, 0.38), '+US$ 24 mi (+38%)');
  assert.equal(marginText(-8, -0.12), '−US$ 8 mi (−12%)');
  const list = [{ feas: { level: 'ok' } }, { feas: { level: 'bad' } }, { feas: { level: 'warn' }, playerBid: { price: 1 } }];
  assert.equal(tenderFilter(list, 'can').length, 2);
  assert.equal(tenderFilter(list, 'bid').length, 1);
  assert.deepEqual(resultChip({ status: 'closed', winnerName: 'ESA', ai: { done: false } }), ['ESA voa', 'info']);
  assert.deepEqual(resultChip({ status: 'delivered' }), ['entregue', 'good']);
  const st = { contracts: [{ status: 'open', feasAtCreate: true, playerBid: null }, { status: 'open', feasAtCreate: false }], missions: [] };
  assert.equal(contractsBadge(st), 1);
  st.contracts.push({ status: 'awarded', missionId: 'm1' });
  st.missions.push({ id: 'm1', status: 'planning', vehicleId: null });
  assert.equal(contractsBadge(st), true);
});

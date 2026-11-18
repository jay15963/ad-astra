// Rocket market (docs/MISSIONS-V2.md §8, R9): treaty-gated buying for the player (treatyAccess matrix), the AI's
// interest in the player's rockets (formula monotone in flights/reliability, decreasing with failures/price/tension),
// offers (caps, cooldown, counter chance shown = used), contracts and deliveries (they update the rocket's record),
// the production queue, the two new treaty types in diplomacy (launch_services, station_partnership) and
// determinism through save/load. The engine lists market.js after investors; the guarded splice below only matters
// for an engine build without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { relKey } from '../src/core/helpers.js';
import { rngFor } from '../src/core/rng.js';
import * as market from '../src/sim/market.js';
import * as diplomacy from '../src/sim/diplomacy.js';
import * as calendar from '../src/sim/calendar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!engine.MODULES.some(([n]) => n === 'market')) {
  const at = engine.MODULES.findIndex(([n]) => n === 'investors');
  engine.MODULES.splice(at >= 0 ? at + 1 : engine.MODULES.length, 0, ['market', market]);
}
const MARKET = JSON.parse(readFileSync(join(ROOT, 'data/core/market.json'), 'utf8'));
const withMarket = (d) => (d.market ? d : { ...d, market: MARKET });
const lunar = withMarket(await loadDataNode(ROOT));

const ctxOf = (state, data, extra = {}) => ({
  data, dt: 1, prevTurn: state.turn, turn: state.turn, eraId: state.clock?.eraId,
  rng: (label = '') => rngFor(state.seed, state.turn, 'market', label), ...extra,
});
/** A ctx whose rng says yes to every chance (to force an offer). */
const yesCtx = (state, data, extra = {}) => ctxOf(state, data, {
  rng: (label = '') => { const r = rngFor(state.seed, state.turn, 'market', label); return { ...r, chance: () => true }; }, ...extra,
});

function game(playerId = 'spacex', seed = 7) {
  const state = engine.newGame(lunar, { seed, playerId });
  state.decisions = [];
  return state;
}
const V = (id) => calendar.vehicleById(lunar, id);
const treaty = (type, parties, terms = {}) => ({ id: `t_${type}_${parties.join('_')}`, type, name: type, parties, status: 'active', signedTurn: 0, terms: { health: 60, ...terms } });

// ------------------------------------------------------------------ §8.1 treatyAccess

test('treatyAccess: no opinion for own lineage, generic hardware and AI buyers', () => {
  const s = game('isro');
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('pslv')), null);
  assert.equal(market.treatyAccess(s, lunar, 'isro', { id: 'x', access: 'generic' }), null);
  assert.equal(market.treatyAccess(s, lunar, 'esa', V('long_march_5')), null, 'AI keeps its rules');
});

test('treatyAccess matrix: company open, agency with/without agreement, bloc, own, embargo, tension, break', () => {
  const s = game('isro');
  s.treaties = [];
  // company + open = commercial market
  assert.deepEqual(market.treatyAccess(s, lunar, 'isro', V('falcon9')).ok, true);
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('falcon9')).via, 'market');
  // agency of another bloc (CNSA/ILRS) with access 'bloc': needs an agreement
  const lm5 = V('long_march_5');
  let r = market.treatyAccess(s, lunar, 'isro', lm5);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'agreement');
  assert.match(r.reason, /Precisa de um acordo com/);
  // launch_services naming it, or '*'
  s.treaties = [treaty('launch_services', ['cnsa', 'isro'], { seller: 'cnsa', buyer: 'isro', vehicleIds: ['long_march_5'], priceMult: 1.2 })];
  r = market.treatyAccess(s, lunar, 'isro', lm5);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'launch_services');
  assert.equal(market.priceMultFor(s, lunar, 'isro', lm5), 1.2);
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('long_march_7')).ok, false, 'only the named vehicle');
  s.treaties[0].terms.vehicleIds = '*';
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('long_march_7')).ok, true);
  // a working treaty also opens an agency's open/bloc rockets
  s.treaties = [treaty('mission_partnership', ['cnsa', 'isro'], { program: 'x' })];
  assert.equal(market.treatyAccess(s, lunar, 'isro', lm5).via, 'treaty');
  // access 'own': only a launch contract naming it, a partnership is not enough
  const lm2f = V('long_march_2f');
  r = market.treatyAccess(s, lunar, 'isro', lm2f);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'own');
  s.treaties.push(treaty('launch_services', ['cnsa', 'isro'], { seller: 'cnsa', buyer: 'isro', vehicleIds: ['long_march_2f'] }));
  assert.equal(market.treatyAccess(s, lunar, 'isro', lm2f).ok, true);
  // same bloc (ESA and ISRO in the Artemis Accords): ok without a treaty
  s.treaties = [];
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('ariane6')).ok, true);
  // embargo beats treaties; embargoUntil lifts it
  const emb = { ...V('falcon9'), embargo: ['isro'] };
  s.treaties = [treaty('launch_services', ['spacex', 'isro'], { seller: 'spacex', buyer: 'isro', vehicleIds: '*' })];
  assert.equal(market.treatyAccess(s, lunar, 'isro', emb).code, 'embargo');
  assert.equal(market.treatyAccess(s, lunar, 'isro', { ...emb, embargoUntil: 2000 }).ok, true);
  // tension ≥ 3 blocks
  s.treaties = [treaty('launch_services', ['cnsa', 'isro'], { seller: 'cnsa', buyer: 'isro', vehicleIds: '*' })];
  s.tension[relKey('cnsa', 'isro')] = 3;
  assert.equal(market.treatyAccess(s, lunar, 'isro', lm5).code, 'tension');
  s.tension[relKey('cnsa', 'isro')] = 0;
  assert.equal(market.treatyAccess(s, lunar, 'isro', lm5).ok, true);
  // a broken (or expired) treaty closes access at once
  s.treaties[0].status = 'broken';
  assert.equal(market.treatyAccess(s, lunar, 'isro', lm5).ok, false);
});

test('accessLostMissions: launches within 26 weeks keep the rocket, later ones lose it', () => {
  const s = game('isro');
  s.treaties = [];
  s.missions = [
    { id: 'm1', status: 'scheduled', vehicleId: 'long_march_5', launchTurn: s.turn + 10 },
    { id: 'm2', status: 'scheduled', vehicleId: 'long_march_5', launchTurn: s.turn + 40 },
    { id: 'm3', status: 'scheduled', vehicleId: 'pslv', launchTurn: s.turn + 40 },
  ];
  const lost = market.accessLostMissions(s, lunar);
  assert.deepEqual(lost.map((x) => [x.missionId, x.keep]), [['m1', true], ['m2', false]]);
  assert.match(lost[0].reason, /acordo/);
});

// ------------------------------------------------------------------ §8.3 interest

test('interestFormula: up with flights and reliability, down with failures, price and tension', () => {
  const base = { flights: 10, relMean: 0.9, fails: 0, ratio: 1, need: 1, trust: 20, bloc: false, tension: 0 };
  const f = (x) => market.interestFormula({ ...base, ...x });
  assert.ok(f({ flights: 40 }) > f({ flights: 10 }) && f({ flights: 10 }) > f({ flights: 0 }));
  assert.ok(f({ relMean: 0.97 }) > f({ relMean: 0.9 }) && f({ relMean: 0.9 }) > f({ relMean: 0.8 }));
  assert.ok(f({ fails: 1 }) < f({}) && f({ fails: 2 }) < f({ fails: 1 }));
  assert.ok(f({ ratio: 1.5 }) < f({ ratio: 1.1 }) && f({ ratio: 1.1 }) < f({ ratio: 1 }));
  assert.equal(f({ ratio: 0.8 }), f({ ratio: 1 }), 'cheaper than the reference does not add');
  assert.ok(f({ tension: 2 }) < f({ tension: 1 }) && f({ tension: 1 }) < f({}));
  assert.ok(f({ need: 0.3 }) < f({}));
  assert.ok(f({ bloc: true }) > f({}));
  // the binding numbers: 100·(0.35 + 0.35) at saturation, a failure costs 25
  assert.equal(Math.round(market.interestFormula({ flights: 40, relMean: 0.97, need: 1, trust: 0 })), 70);
  assert.equal(Math.round(f({}) - f({ fails: 1 })), 25);
});

test('interest grows with flights and reliability in a running game; failures drag it down', () => {
  const s = game('spacex');
  const ids = market.sellables(s, lunar).map((x) => x.vehicleId);
  assert.ok(ids.includes('falcon9'), `sellables: ${ids}`);
  const f9 = V('falcon9');
  market.tick(s, lunar, ctxOf(s, lunar)); // first sight: the record so far is history, not recent failures
  const before = market.interestInputs(s, lunar, f9, 'isro').target;
  s.vehicleStats.falcon9 = { ...s.vehicleStats.falcon9, failures: (s.vehicleStats.falcon9?.failures || 0) + 4, flights: (s.vehicleStats.falcon9?.flights || 0) + 4 };
  market.tick(s, lunar, ctxOf(s, lunar)); // records the new failures
  const after = market.interestInputs(s, lunar, f9, 'isro');
  assert.ok(after.fails >= 1);
  assert.ok(after.target < before, `${after.target} < ${before}`);
  // price: asking 2× the cost lowers the target
  const cheap = market.interestInputs(s, lunar, f9, 'isro').target;
  assert.equal(market.actions['market/setPrice'](s, lunar, { vehicleId: 'falcon9', mult: 2 }).ok, true);
  assert.ok(market.interestInputs(s, lunar, f9, 'isro').target < cheap);
  // smoothing: one quarterly update moves 35% of the way, values stay in 0..100
  market.updateInterest(s, lunar);
  for (const row of Object.values(s.market.interest)) for (const v of Object.values(row)) assert.ok(v >= 0 && v <= 100);
});

test('market slice is created only from scenario.unlocks.market.fromYear', () => {
  const late = { ...lunar, scenario: { ...lunar.scenario, unlocks: { ...(lunar.scenario.unlocks || {}), market: { fromYear: 2028 } } } };
  const s = engine.newGame(late, { seed: 3, playerId: 'spacex' });
  assert.equal(s.market, null);
  market.tick(s, late, ctxOf(s, late));
  assert.equal(s.market, null);
  s.turn = 2 * 52;
  market.tick(s, late, ctxOf(s, late));
  assert.ok(s.market && Array.isArray(s.market.contracts));
  assert.equal(market.unlockYear({ scenario: { kind: 'campaign' } }), 1962);
});

// ------------------------------------------------------------------ §8.3 offers, contracts, deliveries

function hot(s, vid = 'falcon9', buyers = ['isro', 'esa', 'jaxa']) {
  market.tick(s, lunar, ctxOf(s, lunar));
  s.market.interest = { [vid]: Object.fromEntries(buyers.map((b, i) => [b, 90 - i])) };
}

test('offers: interest ≥ 55, at most 2 open, no duplicates, one-year cooldown after a refusal', () => {
  const s = game('spacex');
  hot(s);
  for (let i = 0; i < 5; i++) market.tick(s, lunar, yesCtx(s, lunar));
  const open = s.market.offers.filter((o) => !o.fromPlayer);
  assert.equal(open.length, 2);
  assert.equal(new Set(open.map((o) => o.buyerId)).size, 2);
  const cards = s.decisions.filter((d) => d.kind === 'market/offer');
  assert.equal(cards.length, 2);
  const o = open[0];
  assert.equal(o.units, 2 + Math.floor(o.interest / 25));
  assert.match(cards[0].title, /quer comprar \d+ lançamentos do Falcon 9/);
  // decline → cooldown: the same buyer does not ask again within 52 weeks
  const r = engine.resolveDecision(s, lunar, o.decisionId, 'decline');
  assert.equal(r.status, 'declined');
  assert.ok(s.market.declined[`falcon9|${o.buyerId}`] != null);
  for (let i = 0; i < 4; i++) market.tick(s, lunar, yesCtx(s, lunar));
  assert.ok(!s.market.offers.some((x) => x.buyerId === o.buyerId), 'cooldown');
  // below the threshold nothing is offered
  const s2 = game('spacex');
  hot(s2);
  s2.market.interest.falcon9 = { isro: 54 };
  market.tick(s2, lunar, yesCtx(s2, lunar));
  assert.equal(s2.market.offers.length, 0);
});

test('counter: the chance shown on the card is the one used, rolled with rngFor(seed, market, counter, id)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const s = game('spacex', seed);
    hot(s);
    market.tick(s, lunar, yesCtx(s, lunar));
    const o = s.market.offers[0];
    const card = s.decisions.find((d) => d.id === o.decisionId);
    const shown = card.choices.find((c) => c.id === 'counter').preview;
    assert.ok(shown.includes(`${Math.round(o.counterP * 100)}%`), shown);
    assert.equal(o.counterP, market.counterChance(o.interest));
    const expect = rngFor(s.seed, 'market', 'counter', o.id).next() < o.counterP;
    const r = engine.resolveDecision(s, lunar, o.decisionId, 'counter');
    assert.equal(r.status === 'accepted', expect, `seed ${seed}`);
    if (expect) assert.equal(s.market.contracts[0].priceM, Math.round(o.priceM * 1.15));
  }
});

test('contract: advance on signing, deliveries are flights of the rocket, pay on success, refund and cancel on failures', () => {
  const s = game('spacex');
  hot(s);
  market.tick(s, lunar, yesCtx(s, lunar));
  const o = s.market.offers[0];
  const cash0 = s.actors.spacex.cash;
  const flights0 = s.vehicleStats.falcon9?.flights ?? V('falcon9').history.flights;
  const r = engine.resolveDecision(s, lunar, o.decisionId, 'accept');
  assert.equal(r.status, 'accepted');
  const c = s.market.contracts[0];
  assert.equal(c.advanceM, Math.round(o.priceM * o.units * 0.2 * 10) / 10);
  assert.ok(Math.abs(s.actors.spacex.cash - cash0 - c.advanceM) < 1e-6);
  // run until done
  let guard = 0;
  while (c.status === 'active' && guard++ < 400) {
    s.turn += 1;
    market.tick(s, lunar, ctxOf(s, lunar, { prevTurn: s.turn - 1, turn: s.turn }));
  }
  assert.notEqual(c.status, 'active');
  assert.equal(c.delivered + c.failed, c.status === 'done' ? c.units : c.delivered + c.failed);
  const flights1 = s.vehicleStats.falcon9.flights;
  assert.equal(flights1 - flights0, c.delivered + c.failed, 'each delivery is a flight in the record');
  assert.equal(s.market.sales.launches, c.delivered + c.failed);
});

test('deliveries: a failure costs trust and interest; two failures cancel the contract', () => {
  const s = game('spacex');
  hot(s);
  market.tick(s, lunar, yesCtx(s, lunar));
  const o = s.market.offers[0];
  engine.resolveDecision(s, lunar, o.decisionId, 'accept');
  const c = s.market.contracts[0];
  // make the rocket terrible: every delivery fails (reliability prior ~0)
  const orig = lunar.index.vehicles.falcon9;
  const bad = { ...orig, estimatedReliability: 0.001, history: { flights: 0, failures: 0 } };
  const data = { ...lunar, index: { ...lunar.index, vehicles: { ...lunar.index.vehicles, falcon9: bad } }, vehicles: { ...lunar.vehicles, vehicles: lunar.vehicles.vehicles.map((v) => (v.id === 'falcon9' ? bad : v)) } };
  s.vehicleStats.falcon9 = { flights: 0, failures: 0 };
  const trust0 = diplomacy.relation(s, 'spacex', c.buyerId).trust;
  let guard = 0;
  while (c.status === 'active' && guard++ < 400) {
    s.turn += 1;
    s.vehicleStats.falcon9.groundedUntil = null; // keep flying for the test
    market.tick(s, data, ctxOf(s, data, { prevTurn: s.turn - 1, turn: s.turn }));
  }
  assert.equal(c.status, 'cancelled');
  assert.equal(c.failed, 2);
  assert.ok(diplomacy.relation(s, 'spacex', c.buyerId).trust < trust0);
  assert.ok(s.news.some((n) => /cancela o contrato/.test(n.headline)));
});

test('player offers: chance from interest and price, answered in the next step', () => {
  const s = game('spacex');
  hot(s);
  const ref = market.queries['market/refPrice'](s, lunar, 'falcon9', 'isro');
  const fair = market.proposeChance(s, lunar, 'falcon9', 'isro', ref);
  const greedy = market.proposeChance(s, lunar, 'falcon9', 'isro', ref * 2);
  assert.ok(fair > greedy, `${fair} > ${greedy}`);
  assert.ok(fair <= 0.95 && greedy >= 0.05);
  const r = market.actions['market/propose'](s, lunar, { vehicleId: 'falcon9', buyerId: 'isro', units: 3, priceM: ref });
  assert.equal(r.ok, true);
  assert.equal(r.chance, fair);
  assert.equal(market.actions['market/propose'](s, lunar, { vehicleId: 'falcon9', buyerId: 'isro', units: 3, priceM: ref }).ok, false, 'one open offer per buyer');
  assert.equal(market.actions['market/propose'](s, lunar, { vehicleId: 'falcon9', buyerId: 'isro', units: 99, priceM: ref }).ok, false);
  const o = s.market.offers.find((x) => x.fromPlayer);
  const expect = rngFor(s.seed, 'market', 'propose', o.id).next() < o.p;
  s.turn += 1;
  market.tick(s, lunar, ctxOf(s, lunar, { prevTurn: s.turn - 1 }));
  assert.ok(!s.market.offers.some((x) => x.fromPlayer));
  assert.equal(s.market.contracts.length > 0, expect);
});

// ------------------------------------------------------------------ §8.4 production

test('productionQueue: cadence by catalog or class, scheduled missions and deliveries fill the line', () => {
  const s = game('spacex');
  const f9 = market.productionQueue(s, lunar, 'falcon9');
  assert.equal(f9.perYear, 170);
  assert.equal(f9.free, true);
  const st = market.productionQueue(s, lunar, 'starship');
  const per = st.perYear;
  s.missions = Array.from({ length: Math.ceil(per) + 1 }, (_, i) => ({ id: `m${i}`, status: 'scheduled', vehicleId: 'starship', launchTurn: s.turn + 2 + i }));
  const q = market.productionQueue(s, lunar, 'starship');
  assert.equal(q.used12m, Math.ceil(per) + 1);
  assert.equal(q.free, false);
  assert.ok(q.nextFreeTurn > s.turn);
  // the mission being re-validated is left out
  const q2 = market.productionQueue(s, lunar, 'starship', { excludeMissionId: 'm0' });
  assert.equal(q2.used12m, q.used12m - 1);
  // designs: by class, reusable × 1.5
  const t = market.tuning(lunar).production;
  assert.equal(market.perYearOf(s, lunar, { id: 'd1', designId: 'd1', class: 'heavy', reusable: true }), Math.round(t.byClass.heavy * 1.5 * 10) / 10);
});

// ------------------------------------------------------------------ §8.2 diplomacy: the two new treaty types

test('launch_services: proposal types list it; requestAccess sends it to the operator; signing opens access', () => {
  const s = game('isro');
  s.treaties = [];
  const types = diplomacy.queries['diplomacy/proposalTypes'](s, lunar, 'cnsa');
  const ls = types.find((t) => t.id === 'launch_services');
  assert.ok(ls, 'listed');
  assert.match(ls.termsText, /vende lançamentos/);
  assert.equal(ls.terms.seller, 'cnsa');
  assert.ok(Array.isArray(ls.terms.vehicleIds) && ls.terms.vehicleIds.length);
  const res = engine.dispatch(s, lunar, { type: 'market/requestAccess', vehicleId: 'long_march_5' });
  assert.equal(res.ok, true, res.error);
  assert.ok(['accepted', 'rejected', 'pending'].includes(res.status));
  // sign directly and check access
  diplomacy.signTreaty(s, lunar, { type: 'launch_services', parties: ['cnsa', 'isro'], terms: { seller: 'cnsa', buyer: 'isro', vehicleIds: ['long_march_5'], launches: 4, priceMult: 1.1 } }, rngFor(1, 'x'));
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('long_march_5')).ok, true);
  assert.equal(engine.dispatch(s, lunar, { type: 'market/requestAccess', vehicleId: 'long_march_5' }).ok, false, 'already open');
  const t = s.treaties.find((x) => x.type === 'launch_services' && x.status === 'active');
  assert.equal(t.terms.untilTurn, s.turn + 156);
  // expiry emits treaty/expired (missions-sim reassigns rockets on it)
  t.terms.untilTurn = s.turn;
  s.signalsPending = [];
  diplomacy.tick(s, lunar, { ...ctxOf(s, lunar), rng: (l = '') => rngFor(s.seed, s.turn, 'diplomacy', l) });
  assert.equal(t.status, 'expired');
  assert.ok(s.signalsPending.some((x) => x.type === 'treaty/expired' && x.treatyId === t.id));
  assert.equal(market.treatyAccess(s, lunar, 'isro', V('long_march_5')).ok, false);
});

test('launch_services utility: companies sell gladly, exclusive rockets weigh against', () => {
  const s = game('isro');
  const pre = (to, terms) => diplomacy.previewProposal(s, lunar, to, 'launch_services', terms);
  const company = pre('spacex', { vehicleIds: ['starship'] });
  const agencyOwn = pre('cnsa', { vehicleIds: ['long_march_2f'] });
  const agencyBloc = pre('cnsa', { vehicleIds: ['long_march_5'] });
  assert.ok(company.u > agencyBloc.u, `${company.u} > ${agencyBloc.u}`);
  assert.ok(agencyBloc.u > agencyOwn.u, `${agencyBloc.u} > ${agencyOwn.u}`);
  assert.equal(diplomacy.previewProposal(s, lunar, 'spacex', 'launch_services', { vehicleIds: ['pslv'] }).error, 'Você já tem contrato para esses foguetes.');
});

test('station_partnership: needs a station; the AI owner short of supplies asks the player', () => {
  const s = game('isro');
  s.assets = { seq: 0, list: [], past: [] }; // infra may seed historical stations (ISS): start from none
  let pre = diplomacy.previewProposal(s, lunar, 'nasa', 'station_partnership', {});
  assert.equal(pre.error, 'Nenhuma estação para essa parceria.');
  s.assets = { seq: 1, list: [{ id: 'as_1', kind: 'station', name: 'Aurora', ownerId: 'nasa', status: 'active', supplyT: 0.2, modules: [{ id: 'st_core', n: 1 }], partners: [] }], past: [] };
  pre = diplomacy.previewProposal(s, lunar, 'nasa', 'station_partnership', {});
  assert.equal(pre.error, undefined);
  assert.equal(pre.terms.assetId, 'as_1');
  assert.match(diplomacy.queries['diplomacy/proposalTypes'](s, lunar, 'nasa').find((t) => t.id === 'station_partnership').termsText, /Aurora/);
  // AI side: low reserve + trust ≥ 30 → a proposal card to the player (the quarterly pass)
  s.relations[relKey('isro', 'nasa')].trust = 60;
  s.proposals = [];
  s.stats['diplomacy.lastPlayerProposalTurn'] = null;
  let sent = false;
  for (let k = 0; k < 20 && !sent; k++) {
    diplomacy.serviceAgreementsAi(s, lunar, rngFor(k, 'svc'));
    sent = s.proposals.some((p) => p.type === 'station_partnership' && p.from === 'nasa' && p.to === 'isro');
  }
  assert.ok(sent, 'NASA asks for a partner');
  const card = s.decisions.find((d) => d.kind === 'diplomacy/proposal');
  assert.match(card.title, /Parceria de estação/);
  // full station: no ask
  const s2 = game('isro');
  s2.assets = { seq: 1, list: [{ ...s.assets.list[0], supplyT: 50 }], past: [] };
  s2.relations[relKey('isro', 'nasa')].trust = 60;
  s2.proposals = [];
  for (let k = 0; k < 10; k++) diplomacy.serviceAgreementsAi(s2, lunar, rngFor(k, 'svc'));
  assert.ok(!s2.proposals.some((p) => p.type === 'station_partnership'));
});

// ------------------------------------------------------------------ queries, compaction, determinism

test('market/view: sellables with buyers, buyable rows with reasons, sales', () => {
  const s = game('isro');
  s.treaties = [];
  market.tick(s, lunar, ctxOf(s, lunar));
  const v = engine.query(s, lunar, 'market/view');
  assert.equal(v.active, true);
  assert.ok(v.sellables.some((x) => x.vehicleId === 'pslv'));
  const lm5 = v.buyable.find((b) => b.vehicleId === 'long_march_5');
  assert.ok(lm5 && lm5.ok === false && /acordo/.test(lm5.reason));
  assert.equal(lm5.canRequest, true);
  assert.ok(v.buyable.find((b) => b.vehicleId === 'falcon9')?.ok);
  for (const b of v.buyable) assert.ok(b.ok || (typeof b.reason === 'string' && b.reason.length), b.vehicleId);
  assert.ok(JSON.stringify(v).indexOf('undefined') < 0 && JSON.stringify(v).indexOf('NaN') < 0);
});

test('compact and onActorGone keep the slice small and consistent', () => {
  const s = game('spacex');
  hot(s);
  market.tick(s, lunar, yesCtx(s, lunar));
  const o = s.market.offers[0];
  engine.resolveDecision(s, lunar, o.decisionId, 'accept');
  s.market.contracts.push({ ...s.market.contracts[0], id: 'old', status: 'done', endTurn: s.turn - 4 * 52 });
  s.market.declined['falcon9|x'] = s.turn - 100;
  s.market.interest.ghost = { isro: 40 };
  market.compact(s, lunar);
  assert.ok(!s.market.contracts.some((c) => c.id === 'old'));
  assert.equal(s.market.declined['falcon9|x'], undefined);
  assert.equal(s.market.interest.ghost, undefined);
  // the buyer leaves without a successor: its contract ends, its rows go
  const bid = s.market.contracts[0].buyerId;
  delete s.actors[bid];
  market.onActorGone(s, lunar, ctxOf(s, lunar), bid, {});
  assert.equal(s.market.contracts[0].status, 'cancelled');
  assert.ok(!Object.values(s.market.interest).some((row) => bid in row));
});

test('determinism: the same game twice and through save/load gives the same market', () => {
  const run = (cut) => {
    let s = engine.newGame(lunar, { seed: 11, playerId: 'spacex' });
    for (let i = 0; i < 60; i++) {
      for (const d of s.decisions.slice()) {
        if (d.kind === 'launch') continue;
        const c = d.kind === 'market/offer' ? 'accept' : (d.choices?.find((x) => !x.disabled) || d.choices?.[0])?.id;
        engine.dispatch(s, lunar, { type: 'decision/resolve', id: d.id, choiceId: c ?? 'continue' });
      }
      if (i === 5) s.market.interest = { falcon9: { isro: 90, esa: 88 } };
      engine.dispatch(s, lunar, { type: 'time/advance', turns: 1, stopOnEvent: false });
      if (i === cut) s = engine.deserialize(engine.serialize(s), lunar);
    }
    return s.market;
  };
  const a = run(-1);
  const b = run(30);
  assert.deepEqual(a, b);
  assert.ok(JSON.stringify(a).length < 4096, `market slice ${JSON.stringify(a).length} B`);
});

// ------------------------------------------------------------------ UI pure helpers

test('Mercado screen helpers (pure)', async () => {
  const ui = await import('../src/ui/market.js');
  assert.equal(ui.interestWord(80), 'quer muito');
  assert.equal(ui.interestWord(0), 'nenhum');
  assert.deepEqual(ui.buyFilter([{ ok: true }, { ok: false }], 'locked'), [{ ok: false }]);
  assert.equal(ui.multText(1.2), '×1,20');
  assert.equal(typeof ui.render, 'function');
});

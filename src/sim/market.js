// Rocket market (docs/MISSIONS-V2.md §8, request R9). Two halves:
//   1. The player as BUYER: treaty-gated access to other operators' rockets (`treatyAccess`, called by
//      calendar.accessFor for the player only; AI access rules stay as they were).
//   2. The player as SELLER: AI agencies grow an interest in each rocket the player builds (flights, reliability,
//      price, trust, bloc, tension), ask to buy launches (decision `market/offer`) and fly them on contract: every
//      delivery is an abstract flight that updates the rocket's record, so flying well sells more rockets.
// Plus the production cadence of the player's own rockets (`productionQueue`, used by missions.validate).
//
// Slice (created from scenario.unlocks.market.fromYear; null before):
//   state.market = { seq, interest: {[vehicleId]: {[buyerId]: 0..100}}, trend: {[vehicleId]: {[buyerId]: delta}},
//     prices: {[vehicleId]: askMult}, offers: [Offer], contracts: [Contract], declined: {['vid|bid']: turn},
//     track: {[vehicleId]: {f: failuresSeen, t: [turns of recent failures]}}, sales: {count, revenueM, launches} }
//   Offer    = { id, vehicleId, buyerId, units, priceM, everyWeeks, createdTurn, expiresTurn, interest, refPrice,
//                counterP, decisionId }   (AI → player, answered through the decision card)
//            | { id, fromPlayer: true, vehicleId, buyerId, units, priceM, everyWeeks, createdTurn, resolveTurn, p }
//   Contract = { id, vehicleId, buyerId, units, delivered, failed, priceM, advanceM, everyWeeks, nextTurn,
//                startTurn, untilTurn, status: 'active'|'done'|'cancelled', endTurn, paidM, owedM }
// Deterministic: ctx.rng / rngFor only, JSON state; dt-native up to a quarter (meta.maxDt 13).
// Tuning: data/core/market.json "tuning" (every number has a default below).

import { clamp, addNews, pushDecision, removeDecision, emitSignal, changeActor, every, chanceInStep, expiryIn, dueIn, liveActors, resolveActor } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import { turnToDate, MONTHS_PT, WEEKS_PER_YEAR } from '../core/time.js';
import { vehicleDef } from '../core/catalog.js';
import * as budget from './budget.js';
import * as calendar from './calendar.js';
import * as diplomacy from './diplomacy.js';
import * as designs from './designs.js';
import * as research from './research.js';

export const meta = { maxDt: 13 };

// calendar.accessFor asks us about the player's purchases (B2 hook; older calendars simply do not have it)
try { calendar.setTreatyAccess?.((state, data, buyerId, item) => treatyAccess(state, data, buyerId, item)); } catch { /* no hook */ }

// ---------------------------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_TUNING = {
  interest: {
    flightsRef: 40, relFloor: 0.8, relSpan: 0.17, wFlights: 0.35, wRel: 0.35, wTrust: 0.15, wBloc: 0.15,
    needNone: 1, needHas: 0.3, domesticHas: 0, domesticNone: 0.5, failPenalty: 25, failWindowWeeks: 104,
    pricePenalty: 40, tensionPenalty: 18, smoothing: 0.35, periodWeeks: 13, phase: 5, keepMin: 0.5, maxSellables: 8,
    refPriceFallback: 1.5, affordShare: 0.15, refAskCap: 1.25, cheapBoost: 1,
  },
  ask: { default: 1.2, min: 0.9, max: 2.0, step: 0.05 },
  offer: {
    minInterest: 55, pPerQuarter: 0.25, cooldownWeeks: 52, maxOpen: 2, maxContracts: 4, unitsBase: 2, unitsPerInterest: 25,
    spanWeeks: [52, 156], priceBase: 0.95, pricePerInterest: 400, expiryWeeks: 6, counterMult: 1.15,
    counterBase: 50, counterSpan: 40, counterMin: 0.1, counterMax: 0.9,
  },
  propose: { base: 40, span: 50, min: 0.05, max: 0.95, pricePenalty: 0.8, maxUnits: 8, spanWeeks: 104, maxPriceMult: 2 },
  contract: {
    advance: 0.2, trustOk: 2, repEvery: 3, trustFail: -6, interestFail: -30, refundShare: 0.5, maxFailures: 2,
    keepYears: 3, buildCostShare: 0.5, trustSigned: 2,
  },
  production: { byClass: { small: 10, medium: 6, heavy: 3, superheavy: 1.5 }, reusableMult: 1.5, horizonWeeks: 52, catalogDefault: 6 },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) {
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
}
const TUNING = new WeakMap();
export function tuning(data) {
  const src = data?.market?.tuning ?? data?.market;
  if (!isObj(src)) return DEFAULT_TUNING;
  let t = TUNING.get(src);
  if (!t) { t = deepMerge(DEFAULT_TUNING, src); TUNING.set(src, t); }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const yearAt = (state, turn = state?.turn ?? 0) => (state?.startYear ?? 0) + Math.floor(turn / WEEKS_PER_YEAR);
const pid = (state) => state?.playerId ?? null;
const shortOf = (state, id) => state?.actors?.[id]?.short || state?.actors?.[id]?.name || state?.lifecycle?.tombstones?.[id]?.short || id;
const fmtM = (m) => budget.fmtMoney(m);
const pctText = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
/** Reliability with one decimal near the top (99,6% is not 100%). */
const relText = (p) => { const x = (Number(p) || 0) * 100; return x >= 95 ? `${(Math.floor(x * 10) / 10).toFixed(1).replace('.', ',')}%` : `${Math.round(x)}%`; };
function monthText(state, turn) {
  const d = turnToDate(turn, state.startYear);
  return `${MONTHS_PT[d.month]}/${d.year}`;
}
const incomeCat = () => (budget.CATEGORIES?.includes('market') ? 'market' : 'contracts');
const keyOf = (vid, bid) => `${vid}|${bid}`;

/** First year the market exists: scenario.unlocks.market.fromYear (campaign 1962), else the scenario's start. */
export function unlockYear(data) {
  const y = Number(data?.scenario?.unlocks?.market?.fromYear);
  if (Number.isFinite(y)) return y;
  if (data?.scenario?.kind === 'campaign') return 1962;
  return -Infinity;
}
export const marketOpen = (state, data) => !!state && !!pid(state) && !!state.actors?.[pid(state)] && yearAt(state) >= unlockYear(data);

function emptySlice() {
  return { seq: 0, interest: {}, trend: {}, prices: {}, offers: [], contracts: [], declined: {}, track: {}, sales: { count: 0, revenueM: 0, launches: 0 } };
}

/** The slice, created on first use once the market is open (null before: no slice in the save). */
function ensure(state, data) {
  if (!marketOpen(state, data)) return null;
  if (!isObj(state.market)) state.market = emptySlice();
  const m = state.market;
  m.seq = num(m.seq, 0);
  for (const k of ['interest', 'trend', 'prices', 'declined', 'track']) if (!isObj(m[k])) m[k] = {};
  if (!Array.isArray(m.offers)) m.offers = [];
  if (!Array.isArray(m.contracts)) m.contracts = [];
  if (!isObj(m.sales)) m.sales = { count: 0, revenueM: 0, launches: 0 };
  return m;
}
const newId = (m, p) => { m.seq += 1; return `${p}${m.seq}`; };

// ---------------------------------------------------------------------------------------------------------------
// Operators, treaties and the player's access to other rockets (§8.1)
// ---------------------------------------------------------------------------------------------------------------

/** 'agency' | 'company' for an operator id (live actor, then lineage table, then tombstone). */
export function operatorKind(state, data, id) {
  const live = state?.actors?.[id]?.kind;
  if (live) return live;
  const lin = data?.index?.lineages?.[id] || (data?.lineages?.lineages || []).find((l) => l.id === id);
  if (lin?.kind) return lin.kind;
  return state?.lifecycle?.tombstones?.[id]?.kind || 'agency';
}

/** Working agreements that open an agency's hardware (global norms do not). */
export const ACCESS_TREATIES = ['mission_partnership', 'cost_sharing', 'crew_exchange', 'tech_transfer'];

const activeTreaties = (state) => (state?.treaties || []).filter((t) => t?.status === 'active');

/** Active launch_services treaty selling `vehicleId` (or '*') from one of `sellers` to `buyerId`, or null. */
export function launchServicesFor(state, buyerId, sellers, vehicleId) {
  const set = new Set((Array.isArray(sellers) ? sellers : [sellers]).filter(Boolean));
  for (const t of activeTreaties(state)) {
    if (t.type !== 'launch_services' || !t.parties?.includes(buyerId)) continue;
    const seller = t.terms?.seller ?? t.parties.find((p) => p !== buyerId);
    if (!set.has(seller)) continue;
    if (t.terms?.buyer && t.terms.buyer !== buyerId) continue;
    const ids = t.terms?.vehicleIds;
    if (ids === '*' || (Array.isArray(ids) && ids.includes(vehicleId))) return t;
  }
  return null;
}

function workingTreaty(state, a, others) {
  const set = new Set(others.filter(Boolean));
  return activeTreaties(state).find((t) => ACCESS_TREATIES.includes(t.type) && t.parties?.includes(a) && t.parties.some((p) => p !== a && set.has(p))) || null;
}

function blocId(state, data, id) {
  const b = diplomacy.blocOf(state, id);
  if (b) return b.id;
  return state?.actors?.[id]?.bloc ?? (data?.actors?.actors || []).find((x) => x.id === id)?.bloc ?? null;
}
function sameBloc(state, data, a, b) {
  const x = blocId(state, data, a);
  return !!x && x === blocId(state, data, b);
}

/**
 * Treaty-gated access of the PLAYER to a catalog rocket or craft (§8.1). → {ok, reason, via?} or null ("no opinion":
 * own lineage, generic hardware, or a buyer that is not the player — AI keeps the old rules).
 * Order: embargo (beats treaties; `embargoUntil` year lifts it) → tension ≥ 3 → access 'own' (only a launch contract
 * naming the vehicle) → company + open (commercial market) → launch contract / working treaty / same bloc.
 */
export function treatyAccess(state, data, buyerId, item) {
  if (!state || !item || buyerId == null || buyerId !== pid(state)) return null;
  if (item.access === 'generic' || !item.operator) return null;
  const op = resolveActor(state, item.operator);
  const ctrl = resolveActor(state, item.tensionActor || item.operator);
  if (op === buyerId || ctrl === buyerId) return null;
  const embargoed = (item.embargo || []).includes(buyerId) && !(Number.isFinite(item.embargoUntil) && yearAt(state) > item.embargoUntil);
  if (embargoed) return { ok: false, reason: 'Embargo: o operador não vende para você', code: 'embargo' };
  if (diplomacy.tensionOf(state, buyerId, ctrl) >= 3) return { ok: false, reason: `Bloqueado pela tensão com ${shortOf(state, ctrl)}`, code: 'tension' };
  const ls = launchServicesFor(state, buyerId, [op, ctrl], item.id);
  const access = item.access || 'open';
  if (access === 'own') {
    return ls ? { ok: true, reason: null, via: 'launch_services', treatyId: ls.id }
      : { ok: false, reason: `Uso exclusivo de ${shortOf(state, op)}: só com contrato de lançamento`, code: 'own' };
  }
  if (operatorKind(state, data, op) === 'company' && access === 'open') return { ok: true, reason: null, via: 'market' };
  if (ls) return { ok: true, reason: null, via: 'launch_services', treatyId: ls.id };
  const wt = workingTreaty(state, buyerId, [op, ctrl]);
  if (wt) return { ok: true, reason: null, via: 'treaty', treatyId: wt.id };
  if (sameBloc(state, data, buyerId, ctrl)) return { ok: true, reason: null, via: 'bloc' };
  return { ok: false, reason: `Precisa de um acordo com ${shortOf(state, ctrl)} (contrato de lançamento ou parceria)`, code: 'agreement' };
}

/** Price multiplier the player pays for a bought rocket (launch_services terms.priceMult, 0.9–1.3; else 1). */
export function priceMultFor(state, data, buyerId, item) {
  if (!item?.operator || buyerId !== pid(state)) return 1;
  const ls = launchServicesFor(state, buyerId, [resolveActor(state, item.operator), resolveActor(state, item.tensionActor || item.operator)], item.id);
  const pm = Number(ls?.terms?.priceMult);
  return Number.isFinite(pm) ? clamp(pm, 0.9, 1.3) : 1;
}

/**
 * Player missions whose rocket the player can no longer buy (a treaty broke or expired). Pure; missions-sim
 * applies it (§8.1): keep = launch within `graceWeeks` (26) keeps the rocket, the others go back to vehicleId null.
 */
export function accessLostMissions(state, data, { graceWeeks = 26 } = {}) {
  const out = [];
  for (const m of state?.missions || []) {
    if (!m?.vehicleId || !['scheduled', 'planning'].includes(m.status)) continue;
    const v = data?.index?.vehicles?.[m.vehicleId] || (data?.vehicles?.vehicles || []).find((x) => x.id === m.vehicleId);
    if (!v) continue;
    const r = treatyAccess(state, data, pid(state), v);
    if (!r || r.ok) continue;
    const lt = Number.isFinite(m.launchTurn) ? m.launchTurn : null;
    out.push({ missionId: m.id, vehicleId: v.id, keep: m.status === 'scheduled' && lt != null && lt - state.turn <= graceWeeks, reason: r.reason });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The player's rockets for sale
// ---------------------------------------------------------------------------------------------------------------

const isDesign = (state, v) => !!(v && (v.designId || state?.designs?.[v.id]));
export const flightsOf = (state, v) => num(state?.vehicleStats?.[v?.id]?.flights, num(v?.history?.flights, 0));
export function reliabilityOf(state, data, v) {
  if (!v) return 0.8;
  try {
    return isDesign(state, v) ? designs.designReliability(state, data, v.id).mean : calendar.vehicleReliability(state, data, v.id).mean;
  } catch { return num(v.estimatedReliability, 0.85); }
}
export function askMult(state, data, vehicleId) {
  const t = tuning(data);
  const m = Number(state?.market?.prices?.[vehicleId]);
  return Number.isFinite(m) ? clamp(m, t.ask.min, t.ask.max) : t.ask.default;
}
export const askPriceOf = (state, data, v) => round1(num(v?.costM, 0) * askMult(state, data, v?.id));

/** Raw sellable rockets of the player: operational designs + own-lineage catalog rockets in service. */
function sellableVehicles(state, data) {
  const me = pid(state);
  if (!me) return [];
  const out = [];
  for (const d of Object.values(state.designs || {})) {
    if (!d || d.owner !== me || d.retired || d.program?.phase !== 'operational' || !d.asVehicle) continue;
    out.push(d.asVehicle);
  }
  for (const v of data?.vehicles?.vehicles || []) {
    if (!v?.operator || v.access === 'generic' || v.calendarOnly) continue;
    if (resolveActor(state, v.operator) !== me) continue;
    try { if (!calendar.inServiceAt(state, data, v, state.turn)) continue; } catch { continue; }
    out.push(v);
  }
  const seen = new Set();
  return out.filter((v) => v?.id && !seen.has(v.id) && seen.add(v.id))
    .sort((a, b) => flightsOf(state, b) - flightsOf(state, a) || (a.id < b.id ? -1 : 1));
}

/** Rockets the AI may ask to buy: [{vehicleId, name, class, flights, rel, perYear, askPrice, mult, costM, design}]. */
export function sellables(state, data) {
  return sellableVehicles(state, data).map((v) => ({
    vehicleId: v.id, name: v.name || v.id, class: v.class || 'medium', flights: flightsOf(state, v), rel: round3(reliabilityOf(state, data, v)),
    perYear: productionQueue(state, data, v.id).perYear, askPrice: askPriceOf(state, data, v), mult: askMult(state, data, v.id),
    costM: num(v.costM, 0), design: isDesign(state, v),
  }));
}
const round3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------------------------------------------------------
// Production cadence (§8.4)
// ---------------------------------------------------------------------------------------------------------------

/** Units per year the player's line builds of a rocket (catalog cadence, or by class for designs) × tech. */
export function perYearOf(state, data, v) {
  const t = tuning(data).production;
  let base;
  if (isDesign(state, v)) {
    base = num(t.byClass?.[v?.class], t.byClass?.medium ?? 6) * (v?.reusable ? num(t.reusableMult, 1.5) : 1);
  } else base = num(v?.cadencePerYear, num(t.byClass?.[v?.class], t.catalogDefault ?? 6));
  const bonus = research.techBonus(state, pid(state), 'production');
  return Math.max(0.5, round1(base * (1 + bonus)));
}

/** Contract deliveries of a rocket due in [from, to). */
function dueDeliveries(m, vehicleId, from, to) {
  let n = 0;
  for (const c of m?.contracts || []) {
    if (c.status !== 'active' || c.vehicleId !== vehicleId) continue;
    const left = c.units - c.delivered - c.failed;
    for (let k = 0, t = c.nextTurn; k < left; k++, t += c.everyWeeks) {
      if (t >= to) break;
      if (t >= from) n++;
    }
  }
  return n;
}

/**
 * {perYear, used12m, nextFreeTurn, free}: used = player missions with this rocket scheduled in the next 52 weeks
 * + contract deliveries due; a new unit is free now while used + 1 ≤ perYear, else after the overflow is built
 * (one unit every 52/perYear weeks). `excludeMissionId` leaves a mission out (re-validating it).
 */
export function productionQueue(state, data, vehicleId, { excludeMissionId = null } = {}) {
  const v = vehicleDef(data, vehicleId, state);
  const turn = state?.turn ?? 0;
  const horizon = num(tuning(data).production.horizonWeeks, 52);
  const perYear = v ? perYearOf(state, data, v) : 0;
  let used = 0;
  for (const m of state?.missions || []) {
    if (!m || m.id === excludeMissionId || m.vehicleId !== vehicleId) continue;
    if (m.status !== 'scheduled' && m.status !== 'launch') continue;
    const lt = num(m.launchTurn, turn);
    if (lt >= turn && lt < turn + horizon) used++;
  }
  used += dueDeliveries(state?.market, vehicleId, turn, turn + horizon);
  if (!(perYear > 0)) return { perYear: 0, used12m: used, nextFreeTurn: turn, free: true };
  const over = Math.max(0, used + 1 - perYear);
  const nextFreeTurn = turn + Math.ceil(over * (WEEKS_PER_YEAR / perYear));
  return { perYear, used12m: used, nextFreeTurn, free: over <= 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Interest of the AI in the player's rockets (§8.3)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Pure target interest (0..100 before smoothing; may be negative, the caller clamps):
 * 100·need·(wF·f + wR·r + wT·trust/100 + wB·bloc) − 25·fails − 40·max(0, ratio − 1) − 18·tension + bonus.
 */
export function interestFormula({ flights = 0, relMean = 0.8, fails = 0, ratio = 1, need = 1, trust = 0, bloc = false, tension = 0, bonus = 0 } = {}, t = DEFAULT_TUNING.interest) {
  const f = Math.min(1, Math.log2(1 + Math.max(0, flights)) / Math.log2(1 + t.flightsRef));
  const r = clamp((relMean - t.relFloor) / t.relSpan, 0, 1);
  return 100 * need * (t.wFlights * f + t.wRel * r + t.wTrust * (trust / 100) + t.wBloc * (bloc ? 1 : 0))
    - t.failPenalty * fails - t.pricePenalty * Math.max(0, ratio - 1) - t.tensionPenalty * tension + bonus;
}

/** Buyers: live core AI actors, sorted. */
export function buyerIds(state) {
  const me = pid(state);
  return liveActors(state, { tier: 'core' }).filter((id) => id !== me && state.actors?.[id]).sort();
}

/**
 * What a buyer flies today (AI access rules; the player's rockets left out), by class: the cheapest launch
 * (`min`, US$ mi) and the cheapest tonne to low orbit (`perT`, US$ mi/t).
 */
function fleetOf(state, data, buyerId, cache) {
  if (cache?.has(buyerId)) return cache.get(buyerId);
  const me = pid(state);
  const min = {};
  const perT = {};
  let list = [];
  try { list = calendar.availableVehicles(state, data, buyerId) || []; } catch { list = []; }
  for (const v of list) {
    if (!v?.class || resolveActor(state, v.operator) === me) continue;
    const c = num(v.costM, 0);
    if (!(c > 0)) continue;
    if (min[v.class] == null || c < min[v.class]) min[v.class] = c;
    const leo = num(v.capacity?.leo, 0);
    if (leo > 0 && (perT[v.class] == null || c / leo < perT[v.class])) perT[v.class] = c / leo;
  }
  const out = { min, perT };
  cache?.set(buyerId, out);
  return out;
}

function recentFails(state, data, vehicleId) {
  const tr = state?.market?.track?.[vehicleId];
  const w = num(tuning(data).interest.failWindowWeeks, 104);
  return (tr?.t || []).filter((x) => state.turn - x < w).length;
}

/** Inputs and target of the interest of `buyerId` in rocket `v` (read-only). */
export function interestInputs(state, data, v, buyerId, cache = null) {
  const t = tuning(data).interest;
  const me = pid(state);
  const B = state.actors?.[buyerId];
  const fleet = fleetOf(state, data, buyerId, cache);
  const has = fleet.min[v.class] != null;
  const ask = askPriceOf(state, data, v);
  // price compared per tonne to low orbit when both sides have a figure (a "medium" rocket spans 2 to 20 t);
  // refPrice = what the same lift costs the buyer with its own options (per launch, capped near the ask)
  const leo = num(v.capacity?.leo, 0);
  let ratio, refEquiv;
  if (leo > 0 && fleet.perT[v.class] != null) {
    refEquiv = fleet.perT[v.class] * leo;
    ratio = ask / refEquiv;
  } else {
    refEquiv = has ? fleet.min[v.class] : num(v.costM, 1) * t.refPriceFallback;
    ratio = refEquiv > 0 ? ask / refEquiv : 1;
  }
  const refPrice = round1(Math.max(1, Math.min(refEquiv, ask * t.refAskCap)));
  // binding need (§8.3): 1 without a rocket of the class, 0.3 with one; a rocket much cheaper per tonne than the
  // buyer's own wins part of the way back (everyone buys the cheap workhorse)
  let need = has ? t.needHas + (1 - t.needHas) * clamp(1 - ratio, 0, 1) * t.cheapBoost : t.needNone;
  // domestic launch policy (NASA by law): foreign rockets only when there is no own rocket of the class
  const domestic = B?.launchPolicy === 'domestic' && !(v.country && B.country && String(v.country).includes(B.country));
  if (domestic) need *= has ? t.domesticHas : t.domesticNone;
  if ((v.embargo || []).includes(buyerId)) need = 0;
  // a launch that eats more than ~15% of the buyer's yearly budget is out of its league (ESRO does not buy Saturn Vs)
  const budgetM = num(B?.budget, 0);
  if (budgetM > 0 && refPrice > 0) need *= clamp((budgetM * t.affordShare) / refPrice, 0, 1);
  const tension = diplomacy.tensionOf(state, me, buyerId);
  const inputs = {
    flights: flightsOf(state, v), relMean: reliabilityOf(state, data, v), fails: recentFails(state, data, v.id),
    ratio: round3(ratio), need: round3(need), trust: diplomacy.relation(state, me, buyerId).trust || 0,
    bloc: sameBloc(state, data, me, buyerId), tension, bonus: research.techBonus(state, me, 'marketInterest'),
  };
  const target = tension >= 3 ? 0 : interestFormula(inputs, t);
  return { ...inputs, refPrice, askPrice: ask, target };
}

/** Quarterly update: interest ← interest + (target − interest)·0.35 (0..100, 0.1 steps); tiny rows are dropped. */
export function updateInterest(state, data) {
  const m = state.market;
  if (!m) return;
  const t = tuning(data).interest;
  const vs = sellableVehicles(state, data).slice(0, t.maxSellables);
  const buyers = buyerIds(state);
  const cache = new Map();
  const interest = {};
  const trend = {};
  for (const v of vs) {
    const row = {};
    const tr = {};
    for (const b of buyers) {
      const old = num(m.interest?.[v.id]?.[b], 0);
      const { target } = interestInputs(state, data, v, b, cache);
      const nv = round1(clamp(old + (clamp(target, 0, 100) - old) * t.smoothing, 0, 100));
      if (nv >= t.keepMin) {
        row[b] = nv;
        const d = round1(nv - old);
        if (Math.abs(d) >= 0.5) tr[b] = d;
      }
    }
    if (Object.keys(row).length) interest[v.id] = row;
    if (Object.keys(tr).length) trend[v.id] = tr;
  }
  m.interest = interest;
  m.trend = trend;
}

/** Track new failures of the sellable rockets (for the 104-week failure penalty). */
function trackFailures(state, data, m) {
  const w = num(tuning(data).interest.failWindowWeeks, 104);
  for (const v of sellableVehicles(state, data)) {
    const cur = num(state.vehicleStats?.[v.id]?.failures, num(v.history?.failures, 0));
    const tr = m.track[v.id];
    if (!tr) { m.track[v.id] = { f: cur, t: [] }; continue; }
    if (cur > tr.f) {
      for (let i = 0; i < Math.min(5, cur - tr.f); i++) tr.t.push(state.turn);
      tr.f = cur;
    } else if (cur < tr.f) tr.f = cur;
    tr.t = tr.t.filter((x) => state.turn - x < w).slice(-5);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Offers (AI → player) and the player's own proposals
// ---------------------------------------------------------------------------------------------------------------

const aiOffers = (m) => (m?.offers || []).filter((o) => !o.fromPlayer);
const activeContracts = (m) => (m?.contracts || []).filter((c) => c.status === 'active');

/** Chance that the buyer accepts a +15% counter: clamp((interest − 50)/40, 0.1, 0.9). Shown = used. */
export function counterChance(interest, t = DEFAULT_TUNING.offer) {
  return round3(clamp((interest - t.counterBase) / t.counterSpan, t.counterMin, t.counterMax));
}

/** Highest price per launch the player may ask a buyer: refPrice × propose.maxPriceMult (whole millions, ≥ 1). */
export function maxProposePrice(state, data, vehicleId, buyerId) {
  const v = vehicleDef(data, vehicleId, state);
  if (!v) return 0;
  const { refPrice } = interestInputs(state, data, v, buyerId, null);
  return Math.max(1, Math.round(num(refPrice, 0) * num(tuning(data).propose.maxPriceMult, 2)));
}

/**
 * Chance that a buyer accepts the player's own offer: clamp((interest − 40)/50 − 0.8·max(0, price/ref − 1), 0.05, 0.95);
 * 0 above maxProposePrice (nobody signs a price far above what the lift costs them).
 */
export function proposeChance(state, data, vehicleId, buyerId, priceM) {
  const t = tuning(data);
  const v = vehicleDef(data, vehicleId, state);
  if (!v) return 0;
  if (num(priceM, 0) > maxProposePrice(state, data, vehicleId, buyerId)) return 0;
  const inter = num(state.market?.interest?.[vehicleId]?.[buyerId], 0);
  const { refPrice } = interestInputs(state, data, v, buyerId, null);
  const over = refPrice > 0 ? Math.max(0, num(priceM, 0) / refPrice - 1) : 0;
  return round3(clamp((inter - t.propose.base) / t.propose.span - t.propose.pricePenalty * over, t.propose.min, t.propose.max));
}

function offerCandidates(state, data, m) {
  const t = tuning(data).offer;
  const out = [];
  for (const [vid, row] of Object.entries(m.interest || {})) {
    for (const [bid, val] of Object.entries(row)) {
      if (val < t.minInterest || !state.actors?.[bid]) continue;
      if (m.offers.some((o) => o.vehicleId === vid && o.buyerId === bid)) continue;
      if (activeContracts(m).some((c) => c.vehicleId === vid && c.buyerId === bid)) continue;
      const dk = m.declined[keyOf(vid, bid)];
      if (dk != null && state.turn - dk < t.cooldownWeeks) continue;
      out.push({ vid, bid, val });
    }
  }
  return out.sort((a, b) => b.val - a.val || (a.vid < b.vid ? -1 : a.vid > b.vid ? 1 : a.bid < b.bid ? -1 : 1));
}

function offerTerms(state, data, v, buyerId, interest, rng) {
  const t = tuning(data).offer;
  const units = t.unitsBase + Math.floor(interest / t.unitsPerInterest);
  const span = rng.int(t.spanWeeks[0], t.spanWeeks[1]);
  const { refPrice } = interestInputs(state, data, v, buyerId, null);
  const priceM = Math.max(1, Math.round(refPrice * (t.priceBase + interest / t.pricePerInterest)));
  return { units, everyWeeks: Math.max(4, Math.round(span / units)), priceM, refPrice };
}

function offerPreview(state, data, o, v) {
  const tc = tuning(data).contract;
  const adv = round1(o.priceM * o.units * tc.advance);
  const per = round1(o.priceM * (1 - tc.advance));
  const cost = round1(num(v?.costM, 0) * tc.buildCostShare);
  const years = Math.max(1, Math.round((o.units * o.everyWeeks) / WEEKS_PER_YEAR));
  const pq = productionQueue(state, data, o.vehicleId);
  return `Adiantamento de ${fmtM(adv)} agora e ${fmtM(per)} por lançamento entregue (montagem e voo custam ~${fmtM(cost)} cada). `
    + `Um voo a cada ${o.everyWeeks} semanas, por cerca de ${years} ${years === 1 ? 'ano' : 'anos'}. Linha de produção: ${String(pq.perYear).replace('.', ',')}/ano, ${pq.used12m} já reservados.`;
}

function pushOffer(state, data, ctx, m, cand) {
  const v = vehicleDef(data, cand.vid, state);
  if (!v) return null;
  const t = tuning(data).offer;
  const rng = ctx.rng(`offer:${cand.vid}:${cand.bid}`);
  const terms = offerTerms(state, data, v, cand.bid, cand.val, rng);
  const o = {
    id: newId(m, 'mo'), vehicleId: v.id, buyerId: cand.bid, ...terms, interest: cand.val,
    createdTurn: state.turn, expiresTurn: expiryIn(ctx, t.expiryWeeks), counterP: counterChance(cand.val, t), decisionId: null,
  };
  const B = shortOf(state, cand.bid);
  const counterPrice = Math.round(o.priceM * t.counterMult);
  const d = pushDecision(state, {
    kind: 'market/offer',
    title: `${B} quer comprar ${o.units} lançamentos do ${v.name}`,
    body: `${B} oferece ${fmtM(o.priceM)} por lançamento (${fmtM(o.priceM * o.units)} no total). Interesse ${Math.round(cand.val)} de 100, `
      + `${flightsOf(state, v)} voos e confiabilidade de ${relText(reliabilityOf(state, data, v))} pesaram a favor.`,
    portrait: { actorId: cand.bid },
    urgency: 2,
    expiresTurn: o.expiresTurn,
    defaultChoice: 'decline',
    payload: { offerId: o.id, vehicleId: v.id, buyerId: cand.bid, actorId: cand.bid },
    choices: [
      { id: 'accept', label: `Vender por ${fmtM(o.priceM)} cada`, preview: offerPreview(state, data, o, v) },
      { id: 'counter', label: `Pedir ${fmtM(counterPrice)} cada`, preview: `Contraproposta de +15%. Chance de ${B} aceitar: ${pctText(o.counterP)}. Se recusar, não volta a pedir este foguete por um ano.` },
      { id: 'decline', label: 'Recusar', preview: `Sem contrato. ${B} não volta a pedir o ${v.name} por um ano.` },
    ],
  });
  o.decisionId = d.id;
  m.offers.push(o);
  return o;
}

function maybeOffer(state, data, ctx, m) {
  const t = tuning(data).offer;
  if (aiOffers(m).length >= t.maxOpen || activeContracts(m).length >= t.maxContracts) return null;
  const cands = offerCandidates(state, data, m);
  if (!cands.length) return null;
  const rng = ctx.rng('offers');
  if (!rng.chance(chanceInStep(t.pPerQuarter / 13, ctx))) return null;
  return pushOffer(state, data, ctx, m, cands[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Contracts and deliveries
// ---------------------------------------------------------------------------------------------------------------

function signContract(state, data, m, o, priceM) {
  const tc = tuning(data).contract;
  const v = vehicleDef(data, o.vehicleId, state);
  const me = pid(state);
  const c = {
    id: newId(m, 'mc'), vehicleId: o.vehicleId, buyerId: o.buyerId, units: o.units, delivered: 0, failed: 0, priceM,
    advanceM: round1(priceM * o.units * tc.advance), everyWeeks: o.everyWeeks, nextTurn: state.turn + o.everyWeeks,
    startTurn: state.turn, untilTurn: state.turn + o.everyWeeks * o.units + 26, status: 'active', endTurn: null, paidM: 0, owedM: 0,
  };
  m.contracts.push(c);
  budget.earn(state, me, c.advanceM, incomeCat(), `Adiantamento: ${v?.name || c.vehicleId} para ${shortOf(state, c.buyerId)}`);
  c.paidM = c.advanceM;
  m.sales.count += 1;
  m.sales.revenueM = round1(m.sales.revenueM + c.advanceM);
  diplomacy.bumpRelation(state, me, c.buyerId, { trust: tc.trustSigned, dependence: 2 });
  emitSignal(state, 'market/sale', { contractId: c.id, vehicleId: c.vehicleId, buyerId: c.buyerId, units: c.units, priceM, actorId: me });
  addNews(state, {
    headline: `${shortOf(state, c.buyerId)} compra ${c.units} lançamentos do ${v?.name || c.vehicleId}`,
    body: `Contrato de ${fmtM(priceM * c.units)}; adiantamento de ${fmtM(c.advanceM)}. Primeira entrega em ${monthText(state, c.nextTurn)}.`,
    tags: ['mercado'], actors: [me, c.buyerId], importance: 2, icon: 'rocket',
  });
  return c;
}

function endContract(state, c, status) {
  c.status = status;
  c.endTurn = state.turn;
}

/** Money in (positive) or out, netting what the player still owes on this contract. */
function settle(state, c, amount, note) {
  const me = pid(state);
  let net = round1(amount - (c.owedM || 0));
  c.owedM = 0;
  if (net > 0) budget.earn(state, me, net, incomeCat(), note);
  else if (net < 0 && !budget.spend(state, me, -net, incomeCat(), note)) c.owedM = round1(-net);
  return net;
}

function deliver(state, data, ctx, m, c) {
  const tc = tuning(data).contract;
  const me = pid(state);
  const v = vehicleDef(data, c.vehicleId, state);
  const B = shortOf(state, c.buyerId);
  const design = state.designs?.[c.vehicleId];
  const gone = !v || (design ? design.retired || design.program?.phase !== 'operational' : !calendar.inServiceAt(state, data, v, state.turn));
  if (gone || !state.actors?.[c.buyerId]) {
    // out of production (or the buyer is gone): the undelivered units' advance goes back, half of it
    const left = c.units - c.delivered - c.failed;
    const refund = round1(c.priceM * tc.advance * tc.refundShare * left);
    if (refund > 0 && state.actors?.[c.buyerId]) settle(state, c, -refund, `Devolução: ${v?.name || c.vehicleId}`);
    endContract(state, c, 'cancelled');
    addNews(state, { headline: `${v?.name || c.vehicleId} sai de linha: contrato com ${B} encerrado`, tags: ['mercado'], actors: [me, c.buyerId], importance: 2, icon: 'rocket' });
    return;
  }
  if (calendar.isGrounded(state, c.vehicleId, c.nextTurn)) {
    c.nextTurn = Math.max(c.nextTurn + 1, num(state.vehicleStats?.[c.vehicleId]?.groundedUntil, c.nextTurn + 1));
    return;
  }
  const attempt = c.delivered + c.failed;
  const p = reliabilityOf(state, data, v);
  const ok = rngFor(state.seed, 'market', 'flight', c.id, attempt).next() < p;
  calendar.recordFlight(state, c.vehicleId, ok);
  if (design) { try { designs.onDesignFlight(state, data, c.vehicleId); } catch { /* mirror only */ } }
  const cost = round1(num(v.costM, 0) * tc.buildCostShare);
  m.sales.launches += 1;
  if (ok) {
    c.delivered += 1;
    const pay = round1(c.priceM * (1 - tc.advance));
    const net = settle(state, c, pay - cost, `Entrega: ${v.name} para ${B}`);
    c.paidM = round1(c.paidM + pay);
    m.sales.revenueM = round1(m.sales.revenueM + pay);
    diplomacy.bumpRelation(state, me, c.buyerId, { trust: tc.trustOk });
    if (c.delivered % tc.repEvery === 0) changeActor(state, me, 'reputation', 1);
    addNews(state, {
      headline: `${v.name} leva a carga de ${B} à órbita (${c.delivered + c.failed}/${c.units})`,
      body: `Recebido ${fmtM(pay)}; montagem e voo ${fmtM(cost)} (saldo ${fmtM(net)}).`,
      tags: ['mercado'], actors: [me, c.buyerId], importance: 1, icon: 'rocket',
    });
  } else {
    c.failed += 1;
    const refund = round1(c.priceM * tc.advance * tc.refundShare);
    settle(state, c, -(refund + cost), `Falha na entrega: ${v.name}`);
    diplomacy.bumpRelation(state, me, c.buyerId, { trust: tc.trustFail });
    const row = m.interest[c.vehicleId];
    if (row && row[c.buyerId] != null) row[c.buyerId] = round1(clamp(row[c.buyerId] + tc.interestFail, 0, 100));
    addNews(state, {
      headline: `${v.name} falha com a carga de ${B}`,
      body: `Sem pagamento por este voo e ${fmtM(refund)} do adiantamento devolvidos. Confiança de ${B} ${tc.trustFail}.`,
      tags: ['mercado', 'falha'], actors: [me, c.buyerId], importance: 2, icon: 'failure',
    });
  }
  emitSignal(state, 'market/delivery', { contractId: c.id, vehicleId: c.vehicleId, buyerId: c.buyerId, ok, actorId: me });
  c.nextTurn += c.everyWeeks;
  if (c.failed >= tc.maxFailures && c.delivered + c.failed < c.units) {
    endContract(state, c, 'cancelled');
    m.declined[keyOf(c.vehicleId, c.buyerId)] = state.turn;
    addNews(state, { headline: `${B} cancela o contrato do ${v.name} depois de ${c.failed} falhas`, tags: ['mercado', 'falha'], actors: [me, c.buyerId], importance: 2, icon: 'failure' });
  } else if (c.delivered + c.failed >= c.units) {
    endContract(state, c, 'done');
    addNews(state, { headline: `Contrato cumprido: ${c.delivered} de ${c.units} lançamentos do ${v.name} para ${B}`, tags: ['mercado'], actors: [me, c.buyerId], importance: 1, icon: 'rocket' });
  }
}

function resolveProposals(state, data, ctx, m) {
  for (const o of m.offers.slice()) {
    if (!o.fromPlayer || !dueIn(ctx, o.resolveTurn)) continue;
    m.offers = m.offers.filter((x) => x !== o);
    const v = vehicleDef(data, o.vehicleId, state);
    const B = shortOf(state, o.buyerId);
    if (!v || !state.actors?.[o.buyerId]) continue;
    const ok = rngFor(state.seed, 'market', 'propose', o.id).next() < o.p;
    if (ok && activeContracts(m).length < tuning(data).offer.maxContracts) {
      signContract(state, data, m, o, o.priceM);
    } else {
      m.declined[keyOf(o.vehicleId, o.buyerId)] = state.turn;
      addNews(state, {
        headline: `${B} recusa comprar o ${v.name}`, body: `A oferta de ${fmtM(o.priceM)} por lançamento não convenceu (chance era de ${pctText(o.p)}).`,
        tags: ['mercado', 'jogador'], actors: [pid(state), o.buyerId], importance: 2, icon: 'rocket',
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init(state, data) {
  if (state.market === undefined) state.market = null;
  ensure(state, data);
}

export function tick(state, data, ctx) {
  if (state.gameOver) return;
  const m = ensure(state, data);
  if (!m) return;
  trackFailures(state, data, m);
  resolveProposals(state, data, ctx, m);
  for (const c of m.contracts) {
    let guard = 0;
    while (c.status === 'active' && dueIn(ctx, c.nextTurn) && guard++ < 8) deliver(state, data, ctx, m, c);
  }
  // stale AI offers (their card is gone: answered elsewhere, or cleared by the engine)
  m.offers = m.offers.filter((o) => o.fromPlayer || state.decisions.some((d) => d.id === o.decisionId));
  const ti = tuning(data).interest;
  if (every(ctx, ti.periodWeeks, ti.phase) > 0) updateInterest(state, data);
  maybeOffer(state, data, ctx, m);
}

export function onYear() {}

/** Ended contracts after 3 years, expired offers, old refusals, rows of rockets no longer for sale. */
export function compact(state, data) {
  const m = state?.market;
  if (!isObj(m)) return;
  const t = tuning(data);
  const keep = num(t.contract.keepYears, 3) * WEEKS_PER_YEAR;
  m.contracts = (m.contracts || []).filter((c) => c.status === 'active' || state.turn - num(c.endTurn, state.turn) < keep);
  m.offers = (m.offers || []).filter((o) => o.fromPlayer || (state.decisions || []).some((d) => d.id === o.decisionId));
  for (const [k, turn] of Object.entries(m.declined || {})) if (state.turn - turn >= t.offer.cooldownWeeks) delete m.declined[k];
  const live = new Set(sellableVehicles(state, data).map((v) => v.id));
  for (const c of m.contracts) if (c.status === 'active') live.add(c.vehicleId);
  for (const k of ['interest', 'trend', 'track', 'prices']) for (const vid of Object.keys(m[k] || {})) if (!live.has(vid)) delete m[k][vid];
}

/** A buyer leaves the world: a merge hands its contracts to the survivor; otherwise they end. */
export function onActorGone(state, data, ctx, id, info = {}) {
  const m = state?.market;
  if (!isObj(m) || state.actors?.[id]) return;
  const into = info?.into && state.actors?.[info.into] && info.into !== pid(state) ? info.into : null;
  for (const c of m.contracts || []) {
    if (c.buyerId !== id || c.status !== 'active') continue;
    if (into) c.buyerId = into;
    else endContract(state, c, 'cancelled');
  }
  for (const o of (m.offers || []).filter((x) => x.buyerId === id)) if (o.decisionId) removeDecision(state, o.decisionId);
  m.offers = (m.offers || []).filter((x) => x.buyerId !== id);
  for (const k of ['interest', 'trend']) for (const row of Object.values(m[k] || {})) delete row[id];
}

// ---------------------------------------------------------------------------------------------------------------
// Actions and decisions
// ---------------------------------------------------------------------------------------------------------------

const closed = () => ({ ok: false, error: 'O mercado de foguetes ainda não abriu.' });

function sellableById(state, data, vehicleId) {
  return sellableVehicles(state, data).find((v) => v.id === vehicleId) || null;
}

export const actions = {
  /** Ask price of one of the player's rockets: multiple of its cost (0.9–2.0). */
  'market/setPrice': (state, data, action) => {
    const m = ensure(state, data);
    if (!m) return closed();
    const v = sellableById(state, data, action?.vehicleId);
    if (!v) return { ok: false, error: 'Esse foguete não está à venda.' };
    const t = tuning(data).ask;
    const raw = Number(action?.mult);
    if (!Number.isFinite(raw)) return { ok: false, error: 'Preço inválido.' };
    const mult = Math.round(clamp(raw, t.min, t.max) / t.step) * t.step;
    m.prices[v.id] = Math.round(mult * 100) / 100;
    return { ok: true, mult: m.prices[v.id], askPrice: askPriceOf(state, data, v) };
  },
  /** The player offers launches to a buyer; the answer comes in the next step. */
  'market/propose': (state, data, action) => {
    const m = ensure(state, data);
    if (!m) return closed();
    const t = tuning(data);
    const v = sellableById(state, data, action?.vehicleId);
    if (!v) return { ok: false, error: 'Esse foguete não está à venda.' };
    const bid = action?.buyerId;
    if (!bid || bid === pid(state) || !state.actors?.[bid]) return { ok: false, error: 'Comprador desconhecido.' };
    if ((v.embargo || []).includes(bid)) return { ok: false, error: 'Embargo: este foguete não pode ser vendido a eles.' };
    if (diplomacy.tensionOf(state, pid(state), bid) >= 3) return { ok: false, error: 'Conflito aberto: não há negociação.' };
    const units = Math.round(Number(action?.units));
    if (!(units >= 1 && units <= t.propose.maxUnits)) return { ok: false, error: `De 1 a ${t.propose.maxUnits} lançamentos.` };
    const priceM = Math.round(Number(action?.priceM));
    if (!(priceM >= 1)) return { ok: false, error: 'Preço inválido.' };
    const maxP = maxProposePrice(state, data, v.id, bid);
    if (priceM > maxP) return { ok: false, error: `Preço alto demais: ${shortOf(state, bid)} não paga mais que ${fmtM(maxP)} por lançamento.`, maxPriceM: maxP };
    if (m.offers.some((o) => o.vehicleId === v.id && o.buyerId === bid)) return { ok: false, error: 'Já existe uma oferta em aberto para eles.' };
    if (activeContracts(m).some((c) => c.vehicleId === v.id && c.buyerId === bid)) return { ok: false, error: 'Eles já têm contrato deste foguete.' };
    if (activeContracts(m).length >= t.offer.maxContracts) return { ok: false, error: `No máximo ${t.offer.maxContracts} contratos ao mesmo tempo.` };
    const dk = m.declined[keyOf(v.id, bid)];
    if (dk != null && state.turn - dk < 13) return { ok: false, error: `${shortOf(state, bid)} recusou há pouco. Espere alguns meses.` };
    const p = proposeChance(state, data, v.id, bid, priceM);
    const o = {
      id: newId(m, 'mp'), fromPlayer: true, vehicleId: v.id, buyerId: bid, units, priceM,
      everyWeeks: Math.max(4, Math.round(t.propose.spanWeeks / units)), createdTurn: state.turn, resolveTurn: state.turn, p,
    };
    m.offers.push(o);
    return { ok: true, offerId: o.id, chance: p, status: 'pending' };
  },
  /** Ask the operator of a rocket for a launch contract (a diplomacy proposal of type launch_services). */
  'market/requestAccess': (state, data, action, ctx) => {
    const m = ensure(state, data);
    if (!m) return closed();
    const v = data?.index?.vehicles?.[action?.vehicleId] || (data?.vehicles?.vehicles || []).find((x) => x.id === action?.vehicleId);
    if (!v?.operator) return { ok: false, error: 'Foguete desconhecido.' };
    const acc = treatyAccess(state, data, pid(state), v);
    if (!acc) return { ok: false, error: 'Esse foguete já é seu.' };
    if (acc.ok) return { ok: false, error: 'Você já pode comprar este foguete.' };
    if (acc.code === 'embargo' || acc.code === 'tension') return { ok: false, error: acc.reason };
    const to = resolveActor(state, v.tensionActor || v.operator);
    if (!state.actors?.[to]) return { ok: false, error: `${shortOf(state, to)} não negocia mais.` };
    if (typeof diplomacy.proposeTo !== 'function') return { ok: false, error: 'Diplomacia indisponível.' };
    return diplomacy.proposeTo(state, data, { to, proposalType: 'launch_services', terms: { vehicleIds: [v.id] } }, ctx);
  },
};

export const decisionHandlers = {
  'market/offer': (state, data, dec, choiceId) => {
    const m = state.market;
    const o = m?.offers?.find((x) => x.id === dec.payload?.offerId);
    if (!o) return { ok: true, status: 'gone' };
    m.offers = m.offers.filter((x) => x !== o);
    const t = tuning(data).offer;
    const v = vehicleDef(data, o.vehicleId, state);
    const B = shortOf(state, o.buyerId);
    if (!v || !state.actors?.[o.buyerId]) return { ok: true, status: 'gone' };
    if (choiceId === 'accept') {
      const c = signContract(state, data, m, o, o.priceM);
      return { ok: true, status: 'accepted', contractId: c.id };
    }
    if (choiceId === 'counter') {
      const ok = rngFor(state.seed, 'market', 'counter', o.id).next() < o.counterP;
      if (ok) {
        const c = signContract(state, data, m, o, Math.round(o.priceM * t.counterMult));
        return { ok: true, status: 'accepted', contractId: c.id, countered: true };
      }
      m.declined[keyOf(o.vehicleId, o.buyerId)] = state.turn;
      diplomacy.bumpRelation(state, pid(state), o.buyerId, { trust: -1 });
      addNews(state, { headline: `${B} recusa a contraproposta pelo ${v.name}`, tags: ['mercado', 'jogador'], actors: [pid(state), o.buyerId], importance: 2, icon: 'rocket' });
      return { ok: true, status: 'rejected' };
    }
    m.declined[keyOf(o.vehicleId, o.buyerId)] = state.turn;
    return { ok: true, status: 'declined' };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Queries (the Mercado screen)
// ---------------------------------------------------------------------------------------------------------------

// calendar.accessFor reasons (without the market hook) that a launch contract would lift
const TREATY_FIXABLE = ['Uso exclusivo do operador', 'Só para o bloco e parceiros do operador'];

function buyableRows(state, data) {
  const me = pid(state);
  const out = [];
  for (const v of data?.vehicles?.vehicles || []) {
    if (!v?.operator || v.access === 'generic' || v.calendarOnly) continue;
    const op = resolveActor(state, v.operator);
    if (op === me) continue;
    let inService = false;
    try { inService = calendar.inServiceAt(state, data, v, state.turn); } catch { inService = false; }
    if (!inService) continue;
    let base;
    try { base = calendar.accessFor(state, data, me, v); } catch { base = { ok: true, reason: null }; }
    const ta = treatyAccess(state, data, me, v);
    // the treaty rules decide whatever the calendar would say about "own"/"bloc" (with or without the hook)
    let blocked;
    if (!base?.ok) blocked = ta && TREATY_FIXABLE.includes(base?.reason) ? (ta.ok ? null : ta) : base;
    else blocked = ta && !ta.ok ? ta : null;
    const ctrl = resolveActor(state, v.tensionActor || v.operator);
    // a launch contract fixes "no agreement" and "exclusive use", not a national policy, an embargo or a war
    const fixable = !!ta && !ta.ok && ['agreement', 'own'].includes(ta.code) && !!state.actors?.[ctrl]
      && (base?.ok || base?.reason === ta.reason || TREATY_FIXABLE.includes(base?.reason));
    out.push({
      vehicleId: v.id, name: v.name || v.id, class: v.class || 'medium', costM: num(v.costM, 0), operator: op, operatorName: state.actors?.[op] ? shortOf(state, op) : (v.provider || shortOf(state, op)),
      operatorKind: operatorKind(state, data, op), access: v.access || 'open', ok: !blocked, reason: blocked?.reason || null,
      via: blocked ? null : ta?.via || 'open', priceMult: priceMultFor(state, data, me, v),
      canRequest: !!blocked && fixable,
      pending: (state.proposals || []).some((p) => p.from === me && p.to === ctrl && p.type === 'launch_services'),
    });
  }
  return out.sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name));
}

function contractView(state, data, c) {
  const v = vehicleDef(data, c.vehicleId, state);
  return {
    ...c, vehicleName: v?.name || c.vehicleId, buyerName: shortOf(state, c.buyerId), totalM: round1(c.priceM * c.units),
    left: c.units - c.delivered - c.failed, statusLabel: c.status === 'active' ? 'Em andamento' : c.status === 'done' ? 'Cumprido' : 'Cancelado',
  };
}

/** Everything the Mercado de foguetes screen shows (pure). */
export function marketView(state, data) {
  const m = state?.market;
  if (!isObj(m)) return { active: false, unlockYear: unlockYear(data) };
  const t = tuning(data);
  const buyers = buyerIds(state);
  const sell = sellables(state, data).map((s) => {
    const row = m.interest?.[s.vehicleId] || {};
    const pq = productionQueue(state, data, s.vehicleId);
    return {
      ...s, used12m: pq.used12m, nextFreeTurn: pq.nextFreeTurn, free: pq.free,
      buyers: buyers.map((b) => ({ buyerId: b, name: shortOf(state, b), flag: state.actors[b]?.flag || '', interest: num(row[b], 0), trend: num(m.trend?.[s.vehicleId]?.[b], 0) }))
        .sort((a, b) => b.interest - a.interest || (a.buyerId < b.buyerId ? -1 : 1)),
    };
  });
  const interest = [];
  for (const s of sell) for (const b of s.buyers) if (b.interest > 0) interest.push({ vehicleId: s.vehicleId, buyerId: b.buyerId, interest: b.interest, trend: b.trend });
  const offers = (m.offers || []).map((o) => {
    const v = vehicleDef(data, o.vehicleId, state);
    return { ...o, vehicleName: v?.name || o.vehicleId, buyerName: shortOf(state, o.buyerId), counterPrice: o.fromPlayer ? null : Math.round(o.priceM * t.offer.counterMult) };
  });
  return {
    active: true, unlockYear: unlockYear(data), sellables: sell, interest, offers,
    contracts: (m.contracts || []).map((c) => contractView(state, data, c)), buyable: buyableRows(state, data),
    sales: { ...m.sales }, ask: { ...t.ask }, maxUnits: t.propose.maxUnits, maxContracts: t.offer.maxContracts,
    minInterest: t.offer.minInterest,
  };
}

export const queries = {
  'market/view': (state, data) => marketView(state, data),
  'market/interest': (state, data, vehicleId) => {
    const row = state?.market?.interest?.[vehicleId] || {};
    return buyerIds(state).map((b) => ({ buyerId: b, interest: num(row[b], 0), trend: num(state.market?.trend?.[vehicleId]?.[b], 0) }));
  },
  'market/productionQueue': (state, data, vehicleId, opts) => productionQueue(state, data, vehicleId, opts || {}),
  'market/treatyAccess': (state, data, vehicleId) => {
    const v = vehicleDef(data, vehicleId, state);
    return v ? treatyAccess(state, data, pid(state), v) : null;
  },
  'market/proposeChance': (state, data, vehicleId, buyerId, priceM) => proposeChance(state, data, vehicleId, buyerId, priceM),
  'market/maxPrice': (state, data, vehicleId, buyerId) => maxProposePrice(state, data, vehicleId, buyerId),
  'market/refPrice': (state, data, vehicleId, buyerId) => {
    const v = vehicleDef(data, vehicleId, state);
    return v ? interestInputs(state, data, v, buyerId, null).refPrice : null;
  },
  'market/sellables': (state, data) => sellables(state, data),
};


// Investors, shareholding and mandates of the player's agency (docs/EXPANSION.md §5.1–5.2, Phase B2).
// Slices (player only; AI actors have no cap table):
//   state.cap      = { actorId, kind, playerPct 10..100, holders[], lastRoundTurn, valuationM, lowRounds, warned,
//                      year: {year, own, mandated, delivered, failed, raisedM}, lastPrestige, seen[], history[] }
//   state.mandates = [{ id, holderId, source: 'investor'|'calendar', calendarId?, templateId?, title, type,
//                      destination, crewed, count, delivered, deadlineTurn, rewardM, penalty: {mood, cashM?, pct?},
//                      missionIds[], credited[], failedFlights, status: open|flying|done|failed|expired,
//                      accepted, postponed, declined, createdTurn, resolvedTurn,
//                      costM? (estimated flight, D1), deferred?/spanWeeks? (long steps: card waits for attention) }]
// Rules (binding numbers in data/core/investors.json "tuning"):
//   - investors together hold at most 90% (playerPct ≥ 10); an offer that would cross it is never generated;
//   - playerPct ≥ 50 = autonomy: a mandate may be declined or postponed once (mood −15), the board cannot fire you;
//   - below 50 mandates are binding; a missed deadline costs mood −25 + the holder's penalty; a pct-weighted board
//     mood < 20 at two consecutive rounds removes the director (gameOver {reason: 'board'}, warning one round before);
//   - mandated slots per year M = min(K − 1, round(K · s^0.6)), s = 1 − playerPct/100; own slots K − M ≥ 1;
//   - the player's calendar program items (story missions) are mandates of the anchor holder (government for
//     national agencies, founders for real companies); a founded agency starts at 100% and must sell to grow.
// Active only when the scenario has `unlocks.investors` (the campaign); the Corrida Lunar never builds a cap table.
// Deterministic: ctx.rng / rngFor only, plain JSON state. dt-native (meta.maxDt 52).

import {
  addNews, changeActor, clamp, nextId, pushDecision, removeDecision, cadence, expiryIn, log, dueIn,
} from '../core/helpers.js';
import { rngFor, hash32 } from '../core/rng.js';
import { turnToDate, WEEKS_PER_YEAR } from '../core/time.js';
import * as budget from './budget.js';
import * as missions from './missions.js';
import * as self from './investors.js';
import '../core/migrations/v3.js'; // registers the v2 → v3 save migration (cap, mandates)

// missions.js (B5) calls back through late-bound peers (agenda, onMissionResolved, onMissionCancelled,
// onMandateDeclined, linkMandateMission) instead of importing this file: bind ourselves once loaded.
try { missions.bindPeers?.({ investors: self }); } catch { /* older missions.js: the tick scan covers it */ }

export const meta = { maxDt: 52 };

// ---------------------------------------------------------------------------------------------------------------
// Data (data/core/investors.json; tolerant defaults so a missing file never breaks a game)
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_TUNING = {
  investorCap: 90, autonomyPct: 50, exponent: 0.6, minOwn: 1, minSlots: 2, maxSlots: 12, maxHolders: 12,
  slotsByEra: { e1: 3, e2: 4, e3: 5, e4: 6, e5: 6, e6: 6, e7: 6 },
  round: { weeks: 52, minSteps: 5, phase: 26, expiryWeeks: 8, minOffers: 1, maxOffers: 3 },
  buybackPremium: 1.15, termBuybackPremium: 1.0,
  mood: {
    start: 60, decline: -15, postpone: -15, missed: -25, missedAutonomous: -15, delivered: 10, deliveredOthers: 2,
    flightFailed: -8, veto: -8, drift: 0.15, boardRemoval: 20, boardRounds: 2, dividendPerValuationShare: 400, dividendMax: 20,
  },
  mandate: { expiryWeeks: 8, minDeadlineSteps: 3, calendarGraceWeeks: 13, calendarHorizonWeeks: 104, maxOpenPerHolder: 2, keepResolved: 24, maxCostShare: 1, yearCostShare: 0.8, rewardCostShare: 0.5 },
  valuation: { budget: 2, prestige: 3, reputation: 4, fleet: 25, cash: 0.5, floorShareOfBudget: 1, trackStep: 0.04, trackMin: 0.7, trackMax: 1.4 },
  historyCap: 60,
  starting: { agency: { kind: 'government', pct: 40 }, company: { kind: 'founders', pct: 30 }, founded: null },
};

const DEFAULT_ANCHORS = {
  government: { name: 'Governo ({pais})', short: 'GOV', profile: 'estado', emblem: { shape: 'shield', division: 'band', glyph: 'star', stars: 0, glyphColor: '#f4f1e8' } },
  founders: { name: 'Fundadores e primeiros sócios', short: 'FUND', profile: 'fundadores', emblem: { shape: 'hex', division: 'none', glyph: 'rocket', stars: 0, field: '#3b4252', glyphColor: '#e3b341' } },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const tuningCache = new WeakMap();
/** Tunables (defaults deep-merged with data.investors.tuning). */
export function tuning(data) {
  const src = data?.investors?.tuning;
  if (!src || !data) return DEFAULT_TUNING;
  let t = tuningCache.get(src);
  if (!t) { t = deepMerge(DEFAULT_TUNING, src); tuningCache.set(src, t); }
  return t;
}
const archetypes = (data) => (Array.isArray(data?.investors?.investors) ? data.investors.investors : []);
const profiles = (data) => (isObj(data?.investors?.profiles) ? data.investors.profiles : {});
const anchors = (data) => ({ ...DEFAULT_ANCHORS, ...(isObj(data?.investors?.anchors) ? data.investors.anchors : {}) });

/** True when the scenario uses investors at all (campaign; never the Corrida Lunar). */
export function scenarioUsesInvestors(data) {
  return !!data?.scenario?.unlocks?.investors;
}
const unlockYear = (data) => Number(data?.scenario?.unlocks?.investors?.fromYear) || -Infinity;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const yearAt = (state, turn = state.turn) => turnToDate(turn, state.startYear).year;
const me = (state) => state.actors?.[state.playerId] || null;
const round1 = (x) => Math.round(x * 10) / 10;
const int = (x) => Math.round(Number(x) || 0);
const eraOf = (state) => state.clock?.eraId || 'e4';
const fmtM = (m) => budget.fmtMoney(m);
const pctText = (p) => `${int(p)}%`;
const incomeCat = () => (budget.CATEGORIES?.includes('investors') ? 'investors' : 'grants');
const dividendCat = () => (budget.CATEGORIES?.includes('dividends') ? 'dividends' : 'facilities');

function fill(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

/** 'agency' (national), 'company' (real company) or 'founded' (created by the player). */
export function playerKind(state, data) {
  const a = me(state);
  if (!a) return 'agency';
  const lin = data?.index?.lineages?.[a.lineage || state.playerId];
  if (a.custom || lin?.custom || String(state.playerId).startsWith('custom_')) return 'founded';
  return (a.kind || lin?.kind) === 'company' ? 'company' : 'agency';
}

export const sumInvestors = (cap) => (cap?.holders || []).reduce((s, x) => s + (x.pct || 0), 0);
export const isAutonomous = (state, data) => !state.cap || state.cap.playerPct >= tuning(data).autonomyPct;
const holderById = (state, id) => (state.cap?.holders || []).find((x) => x.id === id) || null;

/** Mandated slots per year: M = min(K − minOwn, round(K · s^exponent)), s = investors' share (EXPANSION §5.2). */
export function mandatedSlots(K, playerPct, t = DEFAULT_TUNING) {
  const k = Math.max(0, Math.round(K));
  const s = clamp(1 - (Number(playerPct) || 0) / 100, 0, 1);
  if (s <= 0 || k <= 0) return 0;
  return Math.max(0, Math.min(k - (t.minOwn ?? 1), Math.round(k * s ** (t.exponent ?? 0.6))));
}

/** K = mission slots per year: era base × launch pads × crews, clamped to [minSlots, maxSlots] (≥ 2). */
export function slotsPerYear(state, data) {
  const t = tuning(data);
  const a = me(state);
  const base = t.slotsByEra?.[eraOf(state)] ?? 6;
  const pads = Math.max(1, a?.capabilities?.launchSites?.length || 1);
  const astronauts = Object.values(state.crew || {}).filter((c) => c?.actorId === state.playerId && c.status === 'active' && c.role === 'astronaut').length;
  const padF = Math.min(1.5, 0.75 + 0.25 * pads);
  const crewF = astronauts >= 4 ? 1.15 : 1;
  return clamp(Math.round(base * padF * crewF), Math.max(2, t.minSlots ?? 2), t.maxSlots ?? 12);
}

/** Valuation (US$ mi) = f(prestige, reputation, fleet, cash) × track record, floored at a share of the budget. */
export function valuation(state, data) {
  const t = tuning(data).valuation;
  const a = me(state);
  if (!a) return 0;
  const fleet = new Set((state.missions || []).filter((m) => ['total', 'partial'].includes(m.result?.outcome) && m.vehicleId).map((m) => m.vehicleId)).size;
  const hist = state.cap?.history || [];
  const delivered = hist.reduce((s, h) => s + (h.delivered || 0), 0) + (state.cap?.year?.delivered || 0);
  const failed = hist.reduce((s, h) => s + (h.failed || 0), 0) + (state.cap?.year?.failed || 0);
  const track = clamp(1 + t.trackStep * (delivered - 2 * failed), t.trackMin, t.trackMax);
  const raw = (a.budget || 0) * t.budget + (a.prestige || 0) * t.prestige + (a.reputation || 0) * t.reputation
    + fleet * t.fleet + Math.max(0, a.cash || 0) * t.cash;
  return Math.round(Math.max((a.budget || 0) * t.floorShareOfBudget, raw * track, 10));
}

/** Pct-weighted mean mood of the holders (null without holders). */
export function boardMood(state) {
  const hs = state.cap?.holders || [];
  const tot = sumInvestors(state.cap);
  if (!hs.length || tot <= 0) return null;
  return Math.round(hs.reduce((s, x) => s + (x.pct || 0) * (x.mood ?? 50), 0) / tot);
}

const moodOf = (state, holderId, delta) => {
  const h = holderById(state, holderId);
  if (h) h.mood = clamp(Math.round((h.mood ?? 50) + delta), 0, 100);
};

/** Emblem spec (EXPANSION §5.4) for a holder, from an archetype grammar seeded by its name. */
function emblemFor(g = {}, name = '', fallbackColor = '#3b4252', labelOverride = null) {
  const r = rngFor(hash32(name), 'emblem');
  const fields = Array.isArray(g.fields) && g.fields.length ? g.fields : [g.field || fallbackColor];
  const words = String(name).replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => w.length > 2 && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/.test(w));
  const label = String(labelOverride || (words.length >= 2 ? words.map((w) => w[0]).join('') : String(name).slice(0, 4))).toUpperCase().slice(0, 4);
  const spec = {
    shape: g.shape || 'roundel', field: r.pick(fields), division: g.division || 'none',
    glyph: g.glyph || 'star', glyphColor: g.glyphColor || '#f4f1e8', stars: Number.isFinite(g.stars) ? g.stars : r.int(0, 3), label,
  };
  if (g.field2) spec.field2 = g.field2;
  if (g.ring) spec.ring = { color: isObj(g.ring) ? g.ring.color : spec.glyphColor };
  return spec;
}

// ---------------------------------------------------------------------------------------------------------------
// Cap table set-up
// ---------------------------------------------------------------------------------------------------------------

function anchorHolder(state, data, kind) {
  const t = tuning(data);
  const st = t.starting?.[kind];
  if (!st || !(st.pct > 0)) return null;
  const an = anchors(data)[st.kind];
  if (!an) return null;
  const a = me(state);
  const name = fill(an.name, { pais: a?.country || 'nacional' }).replace(' ()', '');
  return {
    id: 'h_anchor', kind: st.kind, name, short: an.short || name.slice(0, 4).toUpperCase(), pct: int(st.pct), sinceTurn: state.turn,
    profile: an.profile || null, mood: t.mood.start, anchor: true, archetypeId: null, untilTurn: null,
    emblem: emblemFor({ ...an.emblem, field: an.emblem?.field || a?.color || '#3b4252' }, name, '#3b4252', an.short || null),
  };
}

/** (Re)build the player's cap table from the starting stakes of its kind (turn 0 / founding / new player). */
export function setupCap(state, data, { kind } = {}) {
  if (!scenarioUsesInvestors(data) || !me(state)) return null;
  const k = kind || playerKind(state, data);
  const anchor = anchorHolder(state, data, k);
  state.cap = {
    actorId: state.playerId, kind: k, playerPct: anchor ? 100 - anchor.pct : 100, holders: anchor ? [anchor] : [],
    lastRoundTurn: null, valuationM: 0, lowRounds: 0, warned: false,
    year: { year: yearAt(state), own: 0, mandated: 0, delivered: 0, failed: 0, raisedM: 0 },
    lastPrestige: me(state)?.prestige || 0, seen: [], history: [],
  };
  state.mandates = (state.mandates || []).filter((m) => m.status !== 'open' && m.status !== 'flying');
  state.cap.valuationM = valuation(state, data);
  return state.cap;
}

/** Keep the cap table attached to the current player (founding at turn 0 rebuilds it; a merge carries it over). */
function ensureCap(state, data) {
  if (!scenarioUsesInvestors(data)) return null;
  if (!Array.isArray(state.mandates)) state.mandates = [];
  if (!state.cap) return setupCap(state, data);
  const c = state.cap;
  if (c.actorId !== state.playerId) {
    const fresh = !c.history?.length && !c.lastRoundTurn && (c.holders || []).every((x) => x.anchor);
    if (fresh) return setupCap(state, data);
    c.actorId = state.playerId; // lineage merge (§3.4): stakes, mandates and history move with the director
  }
  c.holders = Array.isArray(c.holders) ? c.holders : [];
  c.history = Array.isArray(c.history) ? c.history : [];
  c.seen = Array.isArray(c.seen) ? c.seen : [];
  c.year = c.year || { year: yearAt(state), own: 0, mandated: 0, delivered: 0, failed: 0, raisedM: 0 };
  if (!Number.isFinite(c.playerPct)) c.playerPct = 100 - sumInvestors(c);
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init(state, data) {
  if (!scenarioUsesInvestors(data)) return;
  state.mandates = Array.isArray(state.mandates) ? state.mandates : [];
}

/** After every module's init (lifecycle has reconciled the 1950 roster and the player's identity). */
export function postInit(state, data) {
  if (!scenarioUsesInvestors(data)) return;
  setupCap(state, data);
}

export function tick(state, data, ctx) {
  if (!scenarioUsesInvestors(data) || state.gameOver) return;
  const cap = ensureCap(state, data);
  if (!cap) return;
  syncCalendarMandates(state, data, ctx);
  syncMandates(state, data, ctx);
  countLaunches(state, data);
  const t = tuning(data);
  if (yearAt(state) >= unlockYear(data) && roundDue(state, ctx, t)) fundingRound(state, data, ctx);
  if (state.gameOver) return;
  termsDue(state, data, ctx);
  if (attentionNow(state, ctx)) showDeferredMandates(state, data, ctx);
}

// Long steps (D1, eras 5–7: a quarter or more per step): the board's non-urgent cards (rounds, new mandates, end of
// term) wait for the attention step of budget.js, like the event and market cards, so a long step does not stop on
// them almost every time. Short steps are never gated.
const gatedNow = (state) => budget.attentionPeriod?.(state.clock?.stepWeeks) > 0;
const attentionNow = (state, ctx) => !gatedNow(state) || budget.attentionStep?.(state, ctx) !== false;

/** Yearly round (§5.2 cadence); with long steps, in the first attention step after a full cadence period. */
function roundDue(state, ctx, t) {
  if (!gatedNow(state)) return cadence(ctx, { weeks: t.round.weeks, minSteps: t.round.minSteps, phase: t.round.phase });
  if (!attentionNow(state, ctx)) return false;
  const period = Math.max(t.round.weeks, t.round.minSteps * (ctx.dt || state.clock?.stepWeeks || 1));
  const last = state.cap?.lastRoundTurn;
  return !Number.isFinite(last) || state.turn + (ctx.dt || 0) - last >= period;
}

/**
 * Mandates issued in a long step outside the attention window wait (`deferred`) for the next attention step: then
 * the card shows and the deadline starts counting from there (the holder's years are never eaten by the wait).
 */
function showDeferredMandates(state, data, ctx) {
  for (const md of state.mandates) {
    if (!md.deferred) continue;
    delete md.deferred;
    if (!open(md)) continue;
    md.deadlineTurn = Math.max(md.deadlineTurn, state.turn + (md.spanWeeks || WEEKS_PER_YEAR));
    if (!md.accepted) pushMandateCard(state, data, ctx, md);
  }
}

/** Year boundary: close the year (history, veto, mood drift), then issue the new year's mandates. */
export function onYear(state, data, ctx) {
  if (!scenarioUsesInvestors(data) || state.gameOver) return;
  const cap = ensureCap(state, data);
  if (!cap) return;
  closeYear(state, data, ctx);
  if (yearAt(state) >= unlockYear(data)) issueMandates(state, data, ctx);
}

export function compact(state, data) {
  if (!state.cap) return;
  const t = tuning(data);
  const keep = t.mandate.keepResolved ?? 24;
  const live = (state.mandates || []).filter((m) => m.status === 'open' || m.status === 'flying');
  const done = (state.mandates || []).filter((m) => !(m.status === 'open' || m.status === 'flying'))
    .sort((a, b) => (b.resolvedTurn ?? 0) - (a.resolvedTurn ?? 0)).slice(0, keep);
  state.mandates = [...live, ...done.reverse()];
  const ids = new Set((state.missions || []).map((m) => m.id));
  state.cap.seen = (state.cap.seen || []).filter((id) => ids.has(id));
  state.cap.history = foldHistory(state.cap.history, t.historyCap ?? 60);
}

/** Fold rows (yearly, then decade rows, then century rows) into means of `span` years. */
function foldRows(rows, span) {
  const by = new Map();
  for (const e of rows) {
    const k = Math.floor((e.year ?? 0) / span) * span;
    const b = by.get(k) || { year: k, span, n: 0, playerPct: 0, raisedM: 0, delivered: 0, failed: 0 };
    const n = e.n || 1;
    b.n += n;
    b.playerPct += (e.playerPct || 0) * n;
    b.raisedM += e.raisedM || 0;
    b.delivered += e.delivered || 0;
    b.failed += e.failed || 0;
    by.set(k, b);
  }
  return [...by.values()].map((b) => ({ ...b, decade: span === 10, century: span === 100, playerPct: Math.round(b.playerPct / b.n), raisedM: round1(b.raisedM) }));
}

/** History cap (EXPANSION §5.1): ≤ `cap` rows; the oldest years become decade means, old decades century means. */
export function foldHistory(history, cap = 60) {
  if (!Array.isArray(history) || history.length <= cap) return history;
  const yearly = history.filter((e) => !e.span && !e.decade && !e.century);
  const decades = history.filter((e) => e.span === 10 || (e.decade && !e.span));
  const centuries = history.filter((e) => e.span === 100 || e.century);
  const keepYears = Math.max(10, Math.floor(cap * 0.5));
  const oldYears = yearly.splice(0, Math.max(0, yearly.length - keepYears));
  const dec = oldYears.length ? foldRows([...decades, ...oldYears], 10) : decades;
  const keepDec = Math.max(5, Math.floor(cap * 0.3));
  const oldDec = dec.splice(0, Math.max(0, dec.length - keepDec));
  const cen = foldRows([...centuries, ...oldDec], 100);
  return [...cen, ...dec, ...yearly].slice(-cap);
}

/** The director leaves (dismissal, board, ending): nothing else to do, but open cards go with the engine's clear. */
export function onGameEnd() {}

/** Scheduled mandate deadlines are not appointments (they never truncate the step); launches are missions'. */
export function appointments() { return []; }

// ---------------------------------------------------------------------------------------------------------------
// Mandates: calendar items of the player's lineage (story missions) belong to the anchor holder
// ---------------------------------------------------------------------------------------------------------------

const calDef = (data, id) => data?.index?.calendar?.[id] || (data?.calendar?.missions || []).find((c) => c.id === id) || null;

function syncCalendarMandates(state, data, ctx) {
  const anchor = (state.cap.holders || []).find((x) => x.anchor);
  if (!anchor) return;
  const t = tuning(data).mandate;
  const horizon = state.turn + (t.calendarHorizonWeeks ?? 104);
  const have = new Set(state.mandates.filter((m) => m.calendarId).map((m) => m.calendarId));
  for (const inst of state.calendar || []) {
    if (inst.status !== 'player' || have.has(inst.id)) continue;
    const target = inst.currentTurn ?? inst.plannedTurn;
    if (!Number.isFinite(target) || target > horizon) continue;
    const def = calDef(data, inst.id) || {};
    const base = (inst.plannedTurn ?? target) + (inst.programDelayWeeks || 0);
    state.mandates.push({
      id: `mnd_cal_${inst.id}`, holderId: anchor.id, source: 'calendar', calendarId: inst.id, templateId: null,
      title: String(def.name || inst.id).slice(0, 60), type: def.type || 'satellite', destination: def.destination || 'leo',
      crewed: !!def.crewed, count: 1, delivered: 0, deadlineTurn: Math.max(base + (t.calendarGraceWeeks ?? 26), state.turn + ctx.dt),
      rewardM: 0, penalty: { mood: tuning(data).mood.missed }, missionIds: [], credited: [], failedFlights: 0,
      status: 'open', accepted: true, postponed: false, declined: false, createdTurn: state.turn, resolvedTurn: null,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mandate progress, deadlines, penalties
// ---------------------------------------------------------------------------------------------------------------

const SUCCESS = new Set(['total', 'partial']);
const isFinalSuccess = (m) => SUCCESS.has(m?.result?.outcome) && (m.status === 'operations' || m.status === 'done');
const isFinalFailure = (m) => m?.status === 'done' && m.result?.outcome && !SUCCESS.has(m.result.outcome);
const isFlying = (m) => m && (m.status === 'transit' || m.status === 'operations');

function linkedMissions(state, md) {
  return (state.missions || []).filter((m) => m.mandateId === md.id || md.missionIds.includes(m.id) || (md.calendarId && m.calendarId === md.calendarId));
}

/** Missions already credited to some mandate (a flight counts once). */
function creditedSet(state) {
  const s = new Set();
  for (const md of state.mandates || []) for (const id of md.credited || []) s.add(id);
  return s;
}

function syncMandates(state, data, ctx) {
  const credited = creditedSet(state);
  for (const md of state.mandates) {
    if (md.status !== 'open' && md.status !== 'flying') continue;
    md.missionIds = md.missionIds || [];
    md.credited = md.credited || [];
    if (md.source === 'calendar') { syncCalendarMandate(state, data, ctx, md); continue; }
    const linked = linkedMissions(state, md);
    // an own mission to the same target flown after the mandate was issued also delivers it
    const matching = (state.missions || []).filter((m) => !m.mandateId && !m.calendarId && m.source !== 'cert' && m.source !== 'test'
      && m.type === md.type && m.destination === md.destination && (m.createdTurn ?? 0) >= md.createdTurn);
    for (const m of [...linked, ...matching]) {
      if (credited.has(m.id)) continue;
      if (isFinalSuccess(m)) {
        md.credited.push(m.id);
        credited.add(m.id);
        md.delivered = (md.delivered || 0) + 1;
      } else if (isFinalFailure(m) && linked.includes(m)) {
        md.credited.push(m.id);
        credited.add(m.id);
        md.failedFlights = (md.failedFlights || 0) + 1;
        mandateFlightFailed(state, data, md);
      }
    }
    if ((md.delivered || 0) >= (md.count || 1)) { deliverMandate(state, data, md); continue; }
    const flying = linked.some(isFlying);
    md.status = flying ? 'flying' : 'open';
    if (!flying && !md.deferred && dueIn(ctx, md.deadlineTurn + 1)) missMandate(state, data, md);
  }
}

function syncCalendarMandate(state, data, ctx, md) {
  const inst = (state.calendar || []).find((c) => c.id === md.calendarId);
  const st = inst?.status;
  if (!inst) { resolveQuiet(state, md, 'expired'); return; }
  if (st === 'success' || st === 'partial') { deliverMandate(state, data, md); return; }
  if (st === 'failed') {
    md.failedFlights = (md.failedFlights || 0) + 1;
    mandateFlightFailed(state, data, md);
    missMandate(state, data, md, { flown: true });
    return;
  }
  if (st === 'cancelled') {
    // cancelling a program the government asked for: a decline while autonomous, a missed mandate below 50%
    if (isAutonomous(state, data)) declineMandate(state, data, md, { quiet: true });
    else missMandate(state, data, md);
    return;
  }
  if (st !== 'player') { resolveQuiet(state, md, 'expired'); return; }
  const linked = linkedMissions(state, md);
  // the briefing (missions.js) shows the program's deadline: the mandate follows the one written on the mission
  const shown = linked.map((m) => m.mandate?.deadlineTurn ?? null).find((x) => Number.isFinite(x));
  if (Number.isFinite(shown)) md.deadlineTurn = shown;
  const flying = linked.some(isFlying);
  md.status = flying ? 'flying' : 'open';
  if (!flying && dueIn(ctx, md.deadlineTurn + 1)) missMandate(state, data, md);
}

function resolveQuiet(state, md, status) {
  md.status = status;
  md.resolvedTurn = state.turn;
}

function deliverMandate(state, data, md) {
  const t = tuning(data);
  md.status = 'done';
  md.resolvedTurn = state.turn;
  moodOf(state, md.holderId, t.mood.delivered);
  for (const h of state.cap.holders) if (h.id !== md.holderId) moodOf(state, h.id, t.mood.deliveredOthers);
  state.cap.year.delivered = (state.cap.year.delivered || 0) + 1;
  const h = holderById(state, md.holderId);
  if (md.rewardM > 0) budget.earn(state, state.playerId, md.rewardM, incomeCat(), `Mandato cumprido: ${md.title}`.slice(0, 60));
  if (md.source !== 'calendar') {
    addNews(state, {
      headline: `${h?.name || 'Investidor'} comemora: mandato "${md.title}" cumprido`,
      body: md.rewardM > 0 ? `O conselho libera ${fmtM(md.rewardM)} e o humor dos sócios melhora.` : 'O humor dos sócios melhora.',
      tags: ['investors', 'mandate'], actors: [state.playerId], importance: 1, icon: 'budget',
    });
  }
}

function mandateFlightFailed(state, data, md) {
  moodOf(state, md.holderId, tuning(data).mood.flightFailed);
}

function missMandate(state, data, md, { flown = false } = {}) {
  const t = tuning(data);
  const h = holderById(state, md.holderId);
  md.status = flown || md.failedFlights > 0 ? 'failed' : 'expired';
  md.resolvedTurn = state.turn;
  missions.closeMandateMissions?.(state, md.id); // drafts never flown go with the mandate
  state.cap.year.failed = (state.cap.year.failed || 0) + 1;
  const autonomous = isAutonomous(state, data);
  const lines = [];
  if (autonomous) {
    moodOf(state, md.holderId, t.mood.missedAutonomous);
  } else {
    moodOf(state, md.holderId, md.penalty?.mood ?? t.mood.missed);
    const cash = Number(md.penalty?.cashM) || 0;
    if (cash > 0) {
      if (!budget.spend(state, state.playerId, cash, dividendCat(), `Multa do mandato: ${md.title}`.slice(0, 60))) changeActor(state, state.playerId, 'cash', -cash);
      lines.push(`multa de ${fmtM(cash)}`);
    }
    const pct = int(md.penalty?.pct);
    if (pct > 0 && h) {
      const room = tuning(data).investorCap - sumInvestors(state.cap);
      const move = Math.max(0, Math.min(pct, room, state.cap.playerPct - (100 - tuning(data).investorCap)));
      if (move > 0) { h.pct += move; state.cap.playerPct -= move; lines.push(`${move}% das ações passam a ${h.name}`); }
    }
  }
  addNews(state, {
    headline: md.status === 'failed' ? `Mandato "${md.title}" fracassa; ${h?.name || 'o conselho'} cobra explicações` : `Prazo do mandato "${md.title}" vence sem lançamento`,
    body: (autonomous ? 'Com a maioria das ações, você segue no comando, mas o sócio não esquece.' : 'Sem a maioria, o conselho aplica a penalidade do contrato.') + (lines.length ? ` (${lines.join('; ')})` : ''),
    tags: ['investors', 'mandate'], actors: [state.playerId], importance: 2, icon: 'budget',
  });
}

function declineMandate(state, data, md, { quiet = false } = {}) {
  const t = tuning(data);
  md.status = 'expired';
  md.declined = true;
  md.resolvedTurn = state.turn;
  missions.closeMandateMissions?.(state, md.id);
  moodOf(state, md.holderId, t.mood.decline);
  if (!quiet) {
    const h = holderById(state, md.holderId);
    addNews(state, {
      headline: `${me(state)?.short || 'A agência'} recusa o mandato "${md.title}"`,
      body: `${h?.name || 'O sócio'} não gostou, mas quem manda é a maioria.`,
      tags: ['investors', 'mandate'], actors: [state.playerId], importance: 1, icon: 'budget',
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Launch accounting (own vs mandated flights of the year; "veto" when own flights exceed own slots below 50%)
// ---------------------------------------------------------------------------------------------------------------

function countLaunches(state) {
  const cap = state.cap;
  const seen = new Set(cap.seen);
  const mandatedIds = new Set();
  for (const md of state.mandates) { for (const id of md.missionIds || []) mandatedIds.add(id); for (const id of md.credited || []) mandatedIds.add(id); }
  const calMandates = new Set(state.mandates.filter((m) => m.calendarId).map((m) => m.calendarId));
  // contracts already counted (a mission seen earlier carried them)
  const ownContracts = new Set((state.missions || []).filter((m) => m.source === 'contract' && m.contractId && seen.has(m.id)).map((m) => m.contractId));
  for (const m of state.missions || []) {
    if (seen.has(m.id) || !(m.attempts > 0) || m.source === 'cert' || m.source === 'test') continue;
    seen.add(m.id);
    cap.seen.push(m.id);
    const mandated = m.mandateId || mandatedIds.has(m.id) || (m.calendarId && calMandates.has(m.calendarId)) || m.holderId;
    if (mandated) cap.year.mandated = (cap.year.mandated || 0) + 1;
    // own = the player's own pick (source 'custom') and the contracts won on the tender board (one per contract: a
    // second attempt after a failure is the same job), the same missions the agenda of missions.js counts; story
    // items and mandates are not own flights
    else if (m.source === 'custom' || (m.source === 'contract' && m.contractId && !ownContracts.has(m.contractId))) {
      if (m.source === 'contract') ownContracts.add(m.contractId);
      cap.year.own = (cap.year.own || 0) + 1;
    }
  }
}

/**
 * Peer hook (missions.js tellInvestors, B5): a player mission reached its final result. Mandate progress is
 * credited right away instead of at the next tick. Accepts the mission object or its id.
 */
export function onMissionResolved(state, data, mission) {
  if (!state?.cap || !Array.isArray(state.mandates)) return;
  const id = typeof mission === 'string' ? mission : mission?.id;
  if (!id || !(state.missions || []).some((x) => x.id === id)) return;
  // a window that ends now: progress only, no deadline is crossed mid-tick
  const ctx = { prevTurn: state.turn, dt: 0, turn: state.turn };
  syncMandates(state, data, ctx);
  countLaunches(state, data);
}

/** Peer hook: a mandate mission was cancelled. The mandate stays open until its deadline (a new mission can fly it). */
export function onMissionCancelled(state, data, mission) {
  if (!state?.cap || !Array.isArray(state.mandates)) return;
  const id = typeof mission === 'string' ? mission : mission?.id;
  for (const md of state.mandates) if (open(md) && md.missionIds?.includes(id)) md.status = 'open';
}

/** Peer hook (Missões › "Abrir missão do mandato"): the mission created for a mandate. */
export function linkMandateMission(state, data, mandateId, missionId) {
  const md = (state.mandates || []).find((m) => m.id === mandateId);
  if (!md) return;
  md.missionIds = md.missionIds || [];
  if (missionId && !md.missionIds.includes(missionId)) md.missionIds.push(missionId);
  md.accepted = true;
  for (const d of (state.decisions || []).filter((x) => x.kind === 'investors/mandate' && x.payload?.mandateId === mandateId)) removeDecision(state, d.id);
}

/**
 * Peer hook: the player delayed or cancelled the briefing of a program that is the anchor holder's mandate
 * (missions.js only offers it while the player is autonomous). delay = postpone (mood −15), cancel = decline.
 */
export function onMandateDeclined(state, data, { holderId, calendarId, choice } = {}) {
  if (!state?.cap) return;
  const t = tuning(data);
  const md = (state.mandates || []).find((m) => m.calendarId && m.calendarId === calendarId && open(m));
  if (choice === 'cancel') {
    if (md) declineMandate(state, data, md);
    else moodOf(state, holderId, t.mood.decline);
    return;
  }
  if (choice === 'delay') {
    moodOf(state, md?.holderId || holderId, t.mood.postpone);
    if (md) { md.postponed = true; md.deadlineTurn += 13; }
  }
}

/** Peer hook: K/M of the year for missions.agendaOf (B5), so both modules read the same numbers. */
export function agenda(state, data) {
  if (!state?.cap) return null;
  const K = slotsPerYear(state, data);
  const M = mandatedSlots(K, state.cap.playerPct, tuning(data));
  return { K, M, own: K - M, ownUsed: state.cap.year?.own || 0, autonomous: isAutonomous(state, data) };
}

// ---------------------------------------------------------------------------------------------------------------
// Year close and mandate issue
// ---------------------------------------------------------------------------------------------------------------

function closeYear(state, data) {
  const t = tuning(data);
  const cap = state.cap;
  const y = cap.year;
  // the tick that starts the campaign also starts its first year: nothing to close yet
  if (!Number.isFinite(y.year) || y.year >= yearAt(state)) {
    if (!Number.isFinite(y.year)) y.year = yearAt(state);
    return;
  }
  const K = slotsPerYear(state, data);
  const M = mandatedSlots(K, cap.playerPct, t);
  // veto: below 50% the board objects to every own flight beyond the own slots
  if (!isAutonomous(state, data) && cap.holders.length) {
    const excess = Math.max(0, (y.own || 0) - (K - M));
    if (excess > 0) {
      for (const h of cap.holders) moodOf(state, h.id, t.mood.veto * excess);
      addNews(state, {
        headline: `Conselho reclama: ${excess} voo${excess > 1 ? 's' : ''} próprio${excess > 1 ? 's' : ''} além da cota`,
        body: `Com ${pctText(cap.playerPct)} das ações, a agência tem direito a ${K - M} missão(ões) própria(s) por ano.`,
        tags: ['investors'], actors: [state.playerId], importance: 2, icon: 'budget',
      });
    }
  }
  // mood drifts toward a target set by the year's results
  const a = me(state);
  const gain = (a?.prestige || 0) - (cap.lastPrestige || 0);
  const target = clamp(50 + gain / 5 + 4 * (y.delivered || 0) - 6 * (y.failed || 0) - ((a?.cash || 0) < 0 ? 15 : 0), 10, 90);
  for (const h of cap.holders) h.mood = clamp(Math.round((h.mood ?? 50) + (target - (h.mood ?? 50)) * t.mood.drift), 0, 100);
  cap.lastPrestige = a?.prestige || 0;
  cap.history.push({ year: y.year, playerPct: cap.playerPct, raisedM: round1(y.raisedM || 0), delivered: y.delivered || 0, failed: y.failed || 0, own: y.own || 0, mandated: y.mandated || 0 });
  cap.year = { year: yearAt(state), own: 0, mandated: 0, delivered: 0, failed: 0, raisedM: 0 };
  cap.valuationM = valuation(state, data);
}

/** Largest-remainder allocation of `n` slots over holders by pct. */
function allocate(holders, n) {
  const tot = holders.reduce((s, x) => s + x.pct, 0);
  if (!tot || n <= 0) return new Map();
  const rows = holders.map((x) => ({ id: x.id, exact: (n * x.pct) / tot }));
  const out = new Map(rows.map((r) => [r.id, Math.floor(r.exact)]));
  let left = n - [...out.values()].reduce((s, v) => s + v, 0);
  for (const r of rows.slice().sort((a, b) => (b.exact % 1) - (a.exact % 1) || (a.id < b.id ? -1 : 1))) {
    if (left <= 0) break;
    out.set(r.id, out.get(r.id) + 1);
    left--;
  }
  return out;
}

const open = (md) => md.status === 'open' || md.status === 'flying';

/**
 * First destination of a template the player can fly now: {dest, costM} (costM = cheapest option, null when
 * missions.js cannot price it). A destination whose cheapest flight costs more than `maxCostShare` × the yearly
 * budget is not asked for (D1: investors of a US$ 90 mi/ano agency asked for three US$ 78 mi flights a year).
 */
function templateUsable(state, data, tpl, year) {
  if (tpl.fromYear && year < tpl.fromYear) return null;
  if (tpl.toYear && year > tpl.toYear) return null;
  const t = tuning(data).mandate;
  const budgetM = Math.max(0, me(state)?.budget || 0);
  const maxCost = Number.isFinite(t.maxCostShare) && budgetM > 0 ? t.maxCostShare * budgetM : Infinity;
  const dests = (tpl.destinations || []).filter((d) => data?.index?.destinations?.[d]);
  for (const destination of dests) {
    let r = null;
    try { r = missions.costRange?.(state, data, { type: tpl.type, destination, crewed: tpl.crewed ?? tpl.type === 'crewed' }); } catch { r = null; }
    if (!(r?.options > 0)) continue;
    const costM = Number.isFinite(r.minM) ? r.minM : null;
    if (costM != null && costM > maxCost) continue;
    return { dest: destination, costM };
  }
  return null;
}

/** Estimated cost (US$ mi) of the flights a mandate still owes. */
const owedCostM = (md) => (Number(md.costM) || 0) * Math.max(0, (md.count || 1) - (md.delivered || 0));

function issueMandates(state, data, ctx) {
  const cap = state.cap;
  if (!cap.holders.length) return;
  const t = tuning(data);
  const K = slotsPerYear(state, data);
  const M = mandatedSlots(K, cap.playerPct, t);
  if (M <= 0) return;
  const year = yearAt(state);
  const yearEnd = state.turn + WEEKS_PER_YEAR;
  const share = allocate(cap.holders, M);
  const rng = ctx.rng('mandates');
  const anchor = cap.holders.find((x) => x.anchor);
  // the government's program items due this year already fill its slots
  const calDue = state.mandates.filter((md) => md.source === 'calendar' && open(md) && md.deadlineTurn - (t.mandate.calendarGraceWeeks ?? 26) < yearEnd).length;
  if (anchor) share.set(anchor.id, Math.max(0, (share.get(anchor.id) || 0) - calDue));
  const pf = profiles(data);
  // the board asks for what the agency can pay: the flights still owed plus the new ones cost at most
  // `yearCostShare` × the yearly budget (D1). The slots of the formula (§5.2) stay the ceiling.
  const budgetM = Math.max(0, me(state)?.budget || 0);
  const yearShare = Number(t.mandate.yearCostShare);
  let room = Number.isFinite(yearShare) && budgetM > 0
    ? yearShare * budgetM - state.mandates.filter((md) => md.source !== 'calendar' && open(md)).reduce((s, md) => s + owedCostM(md), 0)
    : Infinity;
  for (const h of cap.holders) {
    let n = share.get(h.id) || 0;
    const openNow = state.mandates.filter((md) => md.holderId === h.id && md.source !== 'calendar' && open(md)).length;
    n = Math.min(n, Math.max(0, (t.mandate.maxOpenPerHolder ?? 2) - openNow));
    const tpls = (pf[h.profile]?.templates || []).map((tpl) => ({ tpl, use: templateUsable(state, data, tpl, year) })).filter((x) => x.use);
    for (let i = 0; i < n && tpls.length; i++) {
      const pick = rng.pick(tpls);
      const cost = (pick.use.costM || 0) * Math.max(1, pick.tpl.count || 1);
      if (cost > room) continue; // the rng draw stays the same whatever the budget: determinism per seed
      room -= cost;
      createMandate(state, data, ctx, h, pick.tpl, pick.use.dest, pick.use.costM);
    }
  }
}

function createMandate(state, data, ctx, h, tpl, destination, costM = null) {
  const t = tuning(data);
  const a = me(state);
  const deadline = state.turn + Math.max((tpl.years || 2) * WEEKS_PER_YEAR, (t.mandate.minDeadlineSteps ?? 3) * ctx.dt);
  // the holder's prize is a share of the budget; it also covers `rewardCostShare` of the flight it asks for (D1: a
  // US$ 7 mi prize for a US$ 78 mi flight made every mandate a loss). The cash penalty stays half the base prize.
  const baseM = round1((a?.budget || 0) * (tpl.reward || 0.08));
  const coverM = Number.isFinite(costM) ? round1(costM * Math.max(1, tpl.count || 1) * (Number(t.mandate.rewardCostShare) || 0)) : 0;
  const rewardM = Math.max(baseM, coverM);
  const binding = !isAutonomous(state, data);
  const md = {
    id: nextId(state, 'mnd'), holderId: h.id, source: 'investor', calendarId: null, templateId: tpl.id || null,
    title: String(tpl.title || 'Mandato').slice(0, 60), type: tpl.type, destination, crewed: !!(tpl.crewed ?? tpl.type === 'crewed'),
    count: Math.max(1, tpl.count || 1), delivered: 0, deadlineTurn: deadline, rewardM, ...(Number.isFinite(costM) ? { costM: round1(costM) } : {}),
    penalty: { mood: t.mood.missed, ...(binding ? { cashM: round1(baseM * 0.5), pct: tpl.penaltyPct ?? (h.pct >= 20 ? 2 : 1) } : {}) },
    missionIds: [], credited: [], failedFlights: 0, status: 'open', accepted: false, postponed: false, declined: false,
    createdTurn: state.turn, resolvedTurn: null,
  };
  state.mandates.push(md);
  if (attentionNow(state, ctx)) pushMandateCard(state, data, ctx, md);
  else { md.deferred = true; md.spanWeeks = deadline - state.turn; }
  return md;
}

function destName(data, id) {
  return data?.index?.destinations?.[id]?.name || id;
}

function pushMandateCard(state, data, ctx, md) {
  const t = tuning(data);
  const h = holderById(state, md.holderId);
  const auto = isAutonomous(state, data);
  const when = turnToDate(md.deadlineTurn, state.startYear);
  const prazo = `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][when.month]}/${when.year}`;
  const choices = [
    { id: 'accept', label: 'Aceitar e escolher o veículo', preview: `Cria a missão em planejamento. Prazo: ${prazo}. Prêmio: ${fmtM(md.rewardM)}.` },
    { id: 'postpone', label: 'Adiar um ano', preview: `Prazo vai para ${when.year + 1}. Humor de ${h?.name || 'sócio'} ${t.mood.postpone}.`, disabled: !auto, reason: auto ? null : 'Sem a maioria das ações, o conselho não aceita adiar.' },
    { id: 'decline', label: 'Recusar', preview: `O mandato some. Humor de ${h?.name || 'sócio'} ${t.mood.decline}.`, disabled: !auto, reason: auto ? null : 'Sem a maioria das ações, o mandato é obrigatório.' },
  ];
  pushDecision(state, {
    kind: 'investors/mandate',
    title: `Mandato de ${h?.name || 'investidor'}: ${md.title}`,
    body: `${h?.name || 'Um sócio'} (${pctText(h?.pct || 0)} das ações) quer ${md.title.toLowerCase()} em ${destName(data, md.destination)} até ${prazo}.`
      + (auto ? ' Com a maioria, você pode recusar ou adiar uma vez.' : ` Você tem ${pctText(state.cap.playerPct)}: sem autonomia, o mandato é obrigatório e perder o prazo custa caro.`),
    choices,
    urgency: auto ? 1 : 2,
    expiresTurn: expiryIn(ctx, t.mandate.expiryWeeks ?? 8),
    defaultChoice: 'accept',
    payload: { mandateId: md.id, holderId: md.holderId, emblem: h?.emblem || null },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Funding rounds
// ---------------------------------------------------------------------------------------------------------------

function eligibleArchetypes(state, data) {
  const era = eraOf(state);
  const year = yearAt(state);
  const kind = state.cap?.kind || playerKind(state, data);
  const pk = kind === 'founded' ? (me(state)?.kind === 'company' ? 'company' : 'agency') : kind;
  return archetypes(data).filter((a) => {
    if (Array.isArray(a.eras) && a.eras.length && !a.eras.includes(era)) return false;
    if (a.fromYear != null && year < a.fromYear) return false;
    if (a.untilYear != null && year > a.untilYear) return false;
    if (Array.isArray(a.playerKinds) && a.playerKinds.length && !a.playerKinds.includes(pk)) return false;
    return true;
  });
}

/** Offers for a round (pure given rng): [{id, archetypeId, holderKind, name, pct, cashM, profile, termYears, emblem}]. */
export function makeOffers(state, data, rng) {
  const t = tuning(data);
  const cap = state.cap;
  const room = t.investorCap - sumInvestors(cap);
  if (!cap || room < 1) return [];
  const pool = eligibleArchetypes(state, data);
  if (!pool.length) return [];
  const a = me(state);
  const val = valuation(state, data);
  const extra = ((a?.reputation || 0) >= 50 ? 1 : 0) + ((a?.prestige || 0) >= 100 ? 1 : 0);
  const n = clamp(t.round.minOffers + rng.int(0, 1) + extra - 1, t.round.minOffers, t.round.maxOffers);
  const offers = [];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const arch = rng.weighted(pool.filter((x) => !used.has(x.id)), (x) => x.weight ?? 1);
    if (!arch) break;
    used.add(arch.id);
    const [lo, hi] = Array.isArray(arch.pct) ? arch.pct : [1, 30];
    const want = rng.int(Math.max(1, lo), Math.min(30, hi));
    const pct = Math.min(want, room);
    if (pct < 1) break;
    let name = fill(rng.pick(arch.names || [arch.id]), { pais: a?.country || '' });
    // a full board (D1: 45 holders of 1–3% after a millennium of rounds): a new seat only while there is one free;
    // otherwise the offer comes from a sitting holder of the same archetype (acceptOffer adds to its stake)
    const seats = cap.holders.filter((x) => !x.anchor);
    if (seats.length >= (t.maxHolders ?? 12) && !seats.some((x) => x.archetypeId === arch.id && x.name === name)) {
      const same = seats.filter((x) => x.archetypeId === arch.id);
      if (!same.length) { i--; if (pool.every((x) => used.has(x.id))) break; continue; }
      name = rng.pick(same).name;
    }
    const cashM = round1((pct / 100) * val * (arch.premium ?? 1) * rng.range(0.92, 1.08));
    offers.push({
      id: `of${i + 1}`, archetypeId: arch.id, holderKind: arch.kind || 'fund', name, pct, cashM,
      profile: arch.profile || null, profileLabel: profiles(data)[arch.profile]?.label || null, termYears: arch.termYears || 5,
      emblem: emblemFor(arch.emblem || {}, name),
    });
  }
  return offers;
}

function offerChoice(state, data, o) {
  const t = tuning(data);
  const before = state.cap.playerPct;
  const after = before - o.pct;
  const lose = before >= t.autonomyPct && after < t.autonomyPct;
  const K = slotsPerYear(state, data);
  const mAfter = mandatedSlots(K, after, t);
  return {
    id: o.id,
    label: `${o.name}: ${o.pct}% por ${fmtM(o.cashM)}`,
    preview: `Você fica com ${pctText(after)}. ${lose ? 'Perde a autonomia: os mandatos passam a ser obrigatórios. ' : ''}`
      + `Mandatos por ano: ${mAfter} de ${K}. Perfil: ${o.profileLabel || 'sem exigências'}. Contrato de ${o.termYears} anos.`,
  };
}

function fundingRound(state, data, ctx) {
  const t = tuning(data);
  const cap = state.cap;
  cap.lastRoundTurn = state.turn;
  cap.valuationM = valuation(state, data);
  boardReview(state, data, ctx);
  if (state.gameOver) return;
  // an unanswered round is replaced by the new one
  for (const d of state.decisions.filter((x) => x.kind === 'investors/round')) removeDecision(state, d.id);
  const offers = makeOffers(state, data, ctx.rng('round'));
  if (!offers.length) return;
  const y = yearAt(state);
  pushDecision(state, {
    kind: 'investors/round',
    title: `Rodada de investimento de ${y}`,
    body: `A agência vale ${fmtM(cap.valuationM)}. Você tem ${pctText(cap.playerPct)} das ações`
      + `${cap.playerPct >= t.autonomyPct ? ' e a autonomia' : ', sem autonomia'}. Cada sócio novo traz dinheiro e mandatos.`,
    choices: [...offers.map((o) => offerChoice(state, data, o)), { id: 'none', label: 'Recusar todas', preview: 'Nenhuma ação é vendida este ano.' }],
    urgency: 1,
    expiresTurn: expiryIn(ctx, t.round.expiryWeeks ?? 8),
    defaultChoice: 'none',
    payload: { offers, year: y, valuationM: cap.valuationM },
  });
}

/** Sell `offer.pct` to a holder (new or existing of the same archetype/name). Returns {ok, holder}. */
export function acceptOffer(state, data, offer) {
  const t = tuning(data);
  const cap = state.cap;
  if (!cap || !offer) return { ok: false, error: 'Oferta inválida.' };
  const room = t.investorCap - sumInvestors(cap);
  const pct = Math.min(int(offer.pct), room);
  if (pct < 1) return { ok: false, error: `Investidores já têm ${t.investorCap}% (o máximo).` };
  const cashM = round1(offer.cashM * (pct / offer.pct));
  let h = cap.holders.find((x) => x.archetypeId === offer.archetypeId && x.name === offer.name);
  if (h) {
    h.pct += pct;
    h.mood = clamp((h.mood ?? 50) + 5, 0, 100);
  } else {
    h = {
      id: nextId(state, 'hld'), kind: offer.holderKind, name: offer.name, short: offer.emblem?.label || offer.name.slice(0, 4).toUpperCase(),
      pct, sinceTurn: state.turn, profile: offer.profile, mood: t.mood.start, anchor: false, archetypeId: offer.archetypeId,
      untilTurn: state.turn + (offer.termYears || 5) * WEEKS_PER_YEAR, emblem: offer.emblem || null,
    };
    cap.holders.push(h);
  }
  const before = cap.playerPct;
  cap.playerPct -= pct;
  cap.year.raisedM = (cap.year.raisedM || 0) + cashM;
  budget.earn(state, state.playerId, cashM, incomeCat(), `Venda de ${pct}% a ${offer.name}`.slice(0, 60));
  const lost = before >= t.autonomyPct && cap.playerPct < t.autonomyPct;
  addNews(state, {
    headline: `${offer.name} compra ${pct}% da ${me(state)?.short || 'agência'} por ${fmtM(cashM)}`,
    body: lost ? `Com ${pctText(cap.playerPct)}, a direção perde a autonomia: os mandatos do conselho passam a ser obrigatórios.`
      : `A direção fica com ${pctText(cap.playerPct)} das ações.`,
    tags: ['investors'], actors: [state.playerId], importance: lost ? 3 : 2, icon: 'budget',
  });
  return { ok: true, holderId: h.id, pct, cashM, lostAutonomy: lost };
}

/** Board review at each round: below 50%, a weighted mood < 20 twice in a row removes the director. */
function boardReview(state, data) {
  const t = tuning(data);
  const cap = state.cap;
  const mood = boardMood(state);
  if (mood == null || isAutonomous(state, data) || mood >= t.mood.boardRemoval) {
    cap.lowRounds = 0;
    cap.warned = false;
    return;
  }
  cap.lowRounds = (cap.lowRounds || 0) + 1;
  if (cap.lowRounds >= (t.mood.boardRounds ?? 2)) {
    const summary = `O conselho de acionistas (${pctText(sumInvestors(cap))} das ações, humor ${mood}) votou pela troca da direção da agência.`;
    state.gameOver = { reason: 'board', turn: state.turn, summary };
    addNews(state, { headline: 'Conselho de acionistas destitui a direção da agência', body: summary, tags: ['investors', 'gameover'], actors: [state.playerId], importance: 3, icon: 'budget' });
    return;
  }
  cap.warned = true;
  pushDecision(state, {
    kind: 'investors/warning',
    title: 'O conselho perdeu a paciência',
    body: `O humor dos acionistas está em ${mood} (abaixo de ${t.mood.boardRemoval}). Se não melhorar até a próxima rodada, o conselho troca a direção. `
      + 'Cumpra mandatos, pague dividendos ou recompre ações para voltar a ter a maioria.',
    choices: [{ id: 'ok', label: 'Entendi' }],
    urgency: 3,
    defaultChoice: 'ok',
    payload: { mood },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Buy-back, end of term, dividends
// ---------------------------------------------------------------------------------------------------------------

/** Price to buy back `pct` from a holder: pct × valuation × premium (1.15; 1.0 at the end of the holder's term). */
export function buybackPrice(state, data, holderId, pct, { premium } = {}) {
  const t = tuning(data);
  const h = holderById(state, holderId);
  if (!h) return null;
  const p = clamp(int(pct), 0, h.pct);
  const val = state.cap.valuationM || valuation(state, data);
  return round1((p / 100) * val * (premium ?? t.buybackPremium));
}

export function buyback(state, data, { holderId, pct, premium } = {}) {
  const cap = state.cap;
  const h = holderById(state, holderId);
  if (!cap || !h) return { ok: false, error: 'Acionista não encontrado.' };
  const p = clamp(int(pct), 0, h.pct);
  if (p < 1) return { ok: false, error: 'Escolha quanto recomprar.' };
  const price = buybackPrice(state, data, holderId, p, { premium });
  if (!(price > 0)) return { ok: false, error: 'Preço de recompra inválido.' };
  if (!budget.canAfford(state, state.playerId, price)) return { ok: false, error: `Caixa insuficiente: a recompra custa ${fmtM(price)}.` };
  if (!budget.spend(state, state.playerId, price, dividendCat(), `Recompra de ${p}% de ${h.name}`.slice(0, 60))) return { ok: false, error: `Caixa insuficiente: a recompra custa ${fmtM(price)}.` };
  const before = cap.playerPct;
  h.pct -= p;
  cap.playerPct += p;
  if (h.pct <= 0) {
    cap.holders = cap.holders.filter((x) => x.id !== h.id);
    for (const md of state.mandates) if (md.holderId === h.id && open(md)) resolveQuiet(state, md, 'expired');
    for (const d of state.decisions.filter((x) => x.kind === 'investors/mandate' && x.payload?.holderId === h.id)) removeDecision(state, d.id);
  }
  const gained = before < tuning(data).autonomyPct && cap.playerPct >= tuning(data).autonomyPct;
  addNews(state, {
    headline: `${me(state)?.short || 'A agência'} recompra ${p}% de ${h.name} por ${fmtM(price)}`,
    body: gained ? `Com ${pctText(cap.playerPct)}, a direção recupera a autonomia.` : `A direção passa a ter ${pctText(cap.playerPct)} das ações.`,
    tags: ['investors'], actors: [state.playerId], importance: gained ? 3 : 2, icon: 'budget',
  });
  return { ok: true, pct: p, priceM: price, regainedAutonomy: gained };
}

function termsDue(state, data, ctx) {
  // long steps: a term that ended outside the attention window is settled in the next attention step
  if (!attentionNow(state, ctx)) return;
  for (const h of state.cap.holders) {
    if (h.anchor || !Number.isFinite(h.untilTurn) || !dueIn(ctx, h.untilTurn)) continue;
    if (state.decisions.some((d) => d.kind === 'investors/term' && d.payload?.holderId === h.id)) continue;
    const price = buybackPrice(state, data, h.id, h.pct, { premium: tuning(data).termBuybackPremium });
    const arch = archetypes(data).find((a) => a.id === h.archetypeId);
    const renewTo = state.turn + Math.max(5, arch?.termYears || 5) * WEEKS_PER_YEAR;
    // without the cash to buy the stake back there is nothing to decide: the contract renews on its own
    // and while autonomous with a content partner the renewal is a formality (no card: fewer stops per turn)
    if (!budget.canAfford(state, state.playerId, price) || (isAutonomous(state, data) && (h.mood ?? 50) >= 40)) { h.untilTurn = renewTo; continue; }
    h.untilTurn = null; // one card per term
    pushDecision(state, {
      kind: 'investors/term',
      title: `Fim do contrato com ${h.name}`,
      body: `O contrato de ${h.name} (${pctText(h.pct)} das ações) chegou ao fim. Você pode recomprar a parte dele sem ágio ou renovar por mais alguns anos.`,
      choices: [
        { id: 'renew', label: 'Renovar o contrato', preview: 'O sócio fica, com os mesmos mandatos.' },
        { id: 'buyout', label: `Recomprar ${pctText(h.pct)} por ${fmtM(price)}`, preview: 'Sem o ágio de 15% da recompra normal.', disabled: !budget.canAfford(state, state.playerId, price), reason: 'Caixa insuficiente.' },
      ],
      urgency: 1,
      expiresTurn: expiryIn(ctx, tuning(data).round.expiryWeeks ?? 8),
      defaultChoice: 'renew',
      payload: { holderId: h.id },
    });
  }
}

export function payDividend(state, data, amountM) {
  const t = tuning(data);
  const cap = state.cap;
  const amt = round1(Number(amountM) || 0);
  if (!cap?.holders.length) return { ok: false, error: 'Não há acionistas para receber dividendos.' };
  if (amt <= 0) return { ok: false, error: 'Valor inválido.' };
  if (!budget.spend(state, state.playerId, amt, dividendCat(), 'Dividendos aos acionistas')) return { ok: false, error: `Caixa insuficiente para pagar ${fmtM(amt)}.` };
  const val = Math.max(1, cap.valuationM || valuation(state, data));
  const gain = Math.min(t.mood.dividendMax, Math.round((amt / val) * t.mood.dividendPerValuationShare));
  for (const h of cap.holders) moodOf(state, h.id, gain);
  addNews(state, { headline: `Agência paga ${fmtM(amt)} em dividendos`, body: `O humor do conselho sobe ${gain} pontos.`, tags: ['investors'], actors: [state.playerId], importance: 1, icon: 'budget' });
  return { ok: true, moodGain: gain };
}

// ---------------------------------------------------------------------------------------------------------------
// Mandate operations (decision card and Conselho screen)
// ---------------------------------------------------------------------------------------------------------------

function acceptMandate(state, data, md) {
  md.accepted = true;
  if (md.missionIds.length && (state.missions || []).some((m) => md.missionIds.includes(m.id) && m.status !== 'cancelled')) return { ok: true };
  let res = null;
  try { res = missions.createMandateMission?.(state, data, md); } catch (e) { log(state, `erro ao criar missão do mandato ${md.id}: ${e.message}`); }
  if (res?.ok) {
    md.missionIds.push(res.missionId);
    return { ok: true, missionId: res.missionId, openBuilder: res.openBuilder ?? res.missionId, step: res.step ?? 2 };
  }
  return { ok: true, missionError: res?.error || null };
}

export function mandateOp(state, data, { mandateId, op } = {}) {
  const md = (state.mandates || []).find((m) => m.id === mandateId);
  if (!md || !open(md)) return { ok: false, error: 'Mandato não encontrado.' };
  const auto = isAutonomous(state, data);
  const t = tuning(data);
  const clearCard = () => { for (const d of state.decisions.filter((x) => x.kind === 'investors/mandate' && x.payload?.mandateId === md.id)) removeDecision(state, d.id); };
  if (op === 'accept' || op === 'mission') { clearCard(); return acceptMandate(state, data, md); }
  if (op === 'decline') {
    if (!auto) return { ok: false, error: 'Sem a maioria das ações, o mandato é obrigatório.' };
    if (md.source === 'calendar') return { ok: false, error: 'Programas do governo se cancelam no briefing da missão.' };
    clearCard();
    declineMandate(state, data, md);
    return { ok: true };
  }
  if (op === 'postpone') {
    if (!auto) return { ok: false, error: 'Sem a maioria das ações, o conselho não aceita adiar.' };
    if (md.postponed) return { ok: false, error: 'Este mandato já foi adiado uma vez.' };
    md.postponed = true;
    md.deadlineTurn += WEEKS_PER_YEAR;
    moodOf(state, md.holderId, t.mood.postpone);
    return { ok: true, deadlineTurn: md.deadlineTurn };
  }
  return { ok: false, error: 'Operação desconhecida.' };
}

// ---------------------------------------------------------------------------------------------------------------
// Actions, decisions, queries
// ---------------------------------------------------------------------------------------------------------------

function roundDecision(state) {
  return state.decisions.find((d) => d.kind === 'investors/round') || null;
}

export const actions = {
  /** Accept one offer of the open round from the Conselho screen; the other offers stay open. */
  'investors/accept': (state, data, action) => {
    if (!state.cap) return { ok: false, error: 'Esta partida não tem investidores.' };
    const d = roundDecision(state);
    const offer = d?.payload?.offers?.find((o) => o.id === action.offerId);
    if (!offer) return { ok: false, error: 'Oferta não encontrada.' };
    const res = acceptOffer(state, data, offer);
    if (!res.ok) return res;
    const room = tuning(data).investorCap - sumInvestors(state.cap);
    d.payload.offers = d.payload.offers.filter((o) => o.id !== offer.id && o.pct <= room);
    if (!d.payload.offers.length) removeDecision(state, d.id);
    else d.choices = [...d.payload.offers.map((o) => offerChoice(state, data, o)), { id: 'none', label: 'Recusar todas', preview: 'Nenhuma ação é vendida este ano.' }];
    return res;
  },
  // the player never sets the price: only the holder and the stake come from the action (premium is internal)
  'investors/buyback': (state, data, action) => (state.cap ? buyback(state, data, { holderId: action?.holderId, pct: action?.pct }) : { ok: false, error: 'Esta partida não tem investidores.' }),
  'investors/mandate': (state, data, action) => (state.cap ? mandateOp(state, data, action) : { ok: false, error: 'Esta partida não tem investidores.' }),
  'investors/dividend': (state, data, action) => (state.cap ? payDividend(state, data, action.amountM) : { ok: false, error: 'Esta partida não tem investidores.' }),
  /** Founding (B1) may call this at turn 0 after agency/found; the tick also rebuilds the table on its own. */
  'investors/setup': (state, data, action) => {
    // only before the first step (a migrated or ticked save cannot rebuild its table) and the kind always comes
    // from the actor itself: a national agency cannot reset itself as 'founded' to drop the government anchor
    if ((state.clock?.steps ?? 0) > 0 || (state.cap && (state.cap.history?.length || state.cap.lastRoundTurn != null))) return { ok: false, error: 'Só no início da partida.' };
    return setupCap(state, data) ? { ok: true } : { ok: false, error: 'Esta partida não tem investidores.' };
  },
};

export const decisionHandlers = {
  'investors/round': (state, data, dec, choiceId) => {
    if (!state.cap || choiceId === 'none') return { ok: true };
    const offer = dec.payload?.offers?.find((o) => o.id === choiceId);
    return offer ? acceptOffer(state, data, offer) : { ok: true };
  },
  'investors/mandate': (state, data, dec, choiceId, ctx) => {
    const md = (state.mandates || []).find((m) => m.id === dec.payload?.mandateId);
    if (!md || !open(md)) return { ok: true };
    if (choiceId === 'decline' || choiceId === 'postpone') {
      const r = mandateOp(state, data, { mandateId: md.id, op: choiceId });
      // postponed, not yet accepted: the Conselho screen keeps an "Aceitar" button for it
      return r;
    }
    // left unanswered: accepted, but no mission is opened for an absent director (Conselho / Missões can open it)
    if (ctx?.expired) { md.accepted = true; return { ok: true }; }
    return acceptMandate(state, data, md);
  },
  'investors/warning': () => ({ ok: true }),
  'investors/term': (state, data, dec, choiceId) => {
    const h = holderById(state, dec.payload?.holderId);
    if (!h) return { ok: true };
    if (choiceId === 'buyout') {
      const r = buyback(state, data, { holderId: h.id, pct: h.pct, premium: tuning(data).termBuybackPremium });
      if (r.ok) return r;
    }
    const arch = archetypes(data).find((a) => a.id === h.archetypeId);
    h.untilTurn = state.turn + Math.max(5, arch?.termYears || 5) * WEEKS_PER_YEAR;
    return { ok: true, renewed: true };
  },
};

const STATUS_PT = { open: 'Em aberto', flying: 'Em voo', done: 'Cumprido', failed: 'Fracassou', expired: 'Venceu' };
const KIND_PT = { government: 'Governo', founders: 'Fundadores', fund: 'Fundo', corporation: 'Empresa', consortium: 'Consórcio', colony: 'Colônia' };

/** Everything the Conselho screen shows (pure). null when the game has no cap table. */
export function boardView(state, data) {
  if (!state?.cap) return null;
  const t = tuning(data);
  const cap = state.cap;
  const K = slotsPerYear(state, data);
  const M = mandatedSlots(K, cap.playerPct, t);
  const round = roundDecision(state);
  const holders = cap.holders.slice().sort((a, b) => b.pct - a.pct).map((x) => ({
    ...x, kindLabel: KIND_PT[x.kind] || x.kind, profileLabel: profiles(data)[x.profile]?.label || null,
    buyback1: buybackPrice(state, data, x.id, 1),
    openMandates: (state.mandates || []).filter((m) => m.holderId === x.id && open(m)).length,
  }));
  const mandates = (state.mandates || []).map((m) => ({
    ...m, statusLabel: STATUS_PT[m.status] || m.status, destName: destName(data, m.destination),
    holder: holderById(state, m.holderId) ? { id: m.holderId, name: holderById(state, m.holderId).name, emblem: holderById(state, m.holderId).emblem } : null,
    weeksLeft: m.deadlineTurn - state.turn,
    pendingCard: state.decisions.some((d) => d.kind === 'investors/mandate' && d.payload?.mandateId === m.id),
  }));
  return {
    playerPct: cap.playerPct, investorsPct: sumInvestors(cap), cap: t.investorCap, autonomyPct: t.autonomyPct,
    autonomous: isAutonomous(state, data), kind: cap.kind, valuationM: cap.valuationM || valuation(state, data),
    boardMood: boardMood(state), lowRounds: cap.lowRounds || 0, removalMood: t.mood.boardRemoval, warned: !!cap.warned,
    agenda: { K, M, own: K - M, ownUsed: cap.year?.own || 0, mandatedUsed: cap.year?.mandated || 0 },
    holders, mandates,
    openMandates: mandates.filter((m) => open(m)), pastMandates: mandates.filter((m) => !open(m)).reverse(),
    round: round ? { decisionId: round.id, offers: round.payload.offers.map((o) => ({ ...o, choice: offerChoice(state, data, o) })), expiresTurn: round.expiresTurn } : null,
    lastRoundTurn: cap.lastRoundTurn, history: cap.history.slice(-12), year: cap.year,
    buybackPremium: t.buybackPremium, unlocked: yearAt(state) >= unlockYear(data), unlockYear: unlockYear(data),
  };
}

export const queries = {
  'investors/board': (state, data) => boardView(state, data),
  'investors/agenda': (state, data) => {
    const a = agenda(state, data);
    return a ? { ...a, ownLeft: Math.max(0, a.own - a.ownUsed) } : null;
  },
  /** For missions (B5): may the player fly one more own mission this year without the board's objection? */
  'investors/canFlyOwn': (state, data) => {
    if (!state.cap || isAutonomous(state, data)) return { ok: true };
    const K = slotsPerYear(state, data);
    const left = K - mandatedSlots(K, state.cap.playerPct, tuning(data)) - (state.cap.year?.own || 0);
    return left > 0 ? { ok: true, left } : { ok: false, left: 0, reason: 'O conselho vetou: a cota de missões próprias deste ano acabou.' };
  },
  'investors/autonomous': (state, data) => isAutonomous(state, data),
  /** Mandate linked to a mission or a calendar item (briefings show the holder emblem and deadline). */
  'investors/mandateFor': (state, data, { missionId, calendarId } = {}) => (state.mandates || []).find((md) => (missionId && (md.missionIds?.includes(missionId) || md.credited?.includes(missionId)))
    || (calendarId && md.calendarId === calendarId)) || null,
  'investors/buybackPrice': (state, data, holderId, pct) => buybackPrice(state, data, holderId, pct),
  'investors/valuation': (state, data) => valuation(state, data),
};

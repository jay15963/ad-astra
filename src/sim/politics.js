// Politics & simulated wars (GDD "Política e guerras simuladas", Turno 5).
// Owns the slices `world`, `politics`, `tension` and `geo` (world map). Pure JS, deterministic (ctx.rng / rngFor only).
//
// Model in one paragraph: every nation (data/politics.json `nations`) has an economy (growth, inflation, debt,
// crises), a government made of factions (exec/legis) with a space stance and a program priority, and a real-ish
// election calendar. Nation pairs carry a tension level 0..4 driven by a leaky "pressure" integrator fed by
// rivalry/trust (diplomacy relations), hawkish governments, economic instability, exogenous events and treaties.
// Actor-level `state.tension[relKey(a,b)]` is a projection of the nation pair level. Companies (SpaceX, Blue Origin)
// get a market model (investor sentiment, funding rounds) instead of a government. Budgets are adjusted once a year.

import { clamp, relKey, addNews, pushDecision, emitSignal, changeActor, log } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import { turnToDate, dateToTurn, WEEKS_PER_YEAR } from '../core/time.js';
import { crossed, monthCrossed, dtOf } from './simtime.js';

/** Static content cache so setTension(state, ...) can phrase news without a data argument. */
let DATA = null;
const PD = (data) => (data || DATA)?.politics || {};

const LEVEL_LABELS = ['normal', 'tensão', 'crise', 'conflito regional', 'guerra aberta'];
const OUTCOME_SCORE = { total: 1, partial: 0.4, recoverable: -0.5, catastrophic: -1 };
const HISTORY_CAP = { tension: 150, events: 80, elections: 40, crises: 40, budgets: 80 };
// a 1950–3000 campaign (save budget 400 KB) keeps a shorter memory; the Corrida Lunar keeps HISTORY_CAP
const LONG_HISTORY_CAP = { tension: 50, events: 30, elections: 20, crises: 20, budgets: 60 };
const histCap = (state, k) => (Number.isFinite(state?.endTurn) && state.endTurn > 10 * WEEKS_PER_YEAR ? LONG_HISTORY_CAP : HISTORY_CAP)[k];

// ---------------------------------------------------------------- small utils

const r2 = (x) => Math.round(x * 100) / 100 || 0; // || 0 normalizes -0
const r3 = (x) => Math.round(x * 1000) / 1000 || 0;

function fmtMoney(m) {
  const v = Math.abs(m);
  const s = m < 0 ? '−' : '';
  if (v >= 1000) return `${s}US$ ${(v / 1000).toFixed(1).replace('.', ',')} bi`;
  return `${s}US$ ${Math.round(v)} mi`;
}
function fmtPct(p, signed = true) {
  const v = p * 100;
  const a = Math.abs(v);
  const str = a.toFixed(a < 10 ? 1 : 0).replace('.', ',').replace(',0', '');
  return (signed ? (v >= 0 ? '+' : '−') : '') + str + '%';
}
function fill(tpl, vars = {}) {
  return String(tpl ?? '')
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.:;])/g, '$1')
    .trim();
}
const capFirst = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const CONTRACT = { de: { o: 'do', a: 'da', os: 'dos', as: 'das' }, em: { o: 'no', a: 'na', os: 'nos', as: 'nas' } };
/** pt-BR article forms: forms('China','a') -> {the:'a China', of:'da China', in:'na China'} */
function forms(name, art) {
  const nm = name ?? '';
  if (!art || !CONTRACT.de[art]) return { the: nm, of: `de ${nm}`, in: `em ${nm}` };
  return { the: `${art} ${nm}`, of: `${CONTRACT.de[art]} ${nm}`, in: `${CONTRACT.em[art]} ${nm}` };
}
function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}
const monthKey = (turn, startYear) => {
  const d = turnToDate(turn, startYear);
  return d.year * 12 + d.month;
};
function isMonthStart(state) {
  return state.turn === 0 || monthKey(state.turn, state.startYear) !== monthKey(state.turn - 1, state.startYear);
}

// ---------------------------------------------------------------- lookups

const nations = (data) => PD(data).nations || [];
const NATION_IDX = new WeakMap(); // politics nations list -> Map(id -> first def), so nationDef is not a scan
function nationDef(data, id) {
  const list = nations(data);
  let m = NATION_IDX.get(list);
  if (!m) {
    m = new Map();
    for (const n of list) if (n && !m.has(n.id)) m.set(n.id, n);
    NATION_IDX.set(list, m);
  }
  return m.get(id) || genericNationDef(data, id);
}

// ---------------------------------------------------------------- nations through time (data/core/nations.json)

const coreNations = (data) => (data || DATA)?.nations?.nations || [];
const coreNation = (data, id) => (data || DATA)?.index?.nations?.[id] || coreNations(data).find((n) => n.id === id) || null;
const monthOf = (d, dflt) => (d == null ? dflt : (typeof d === 'number' ? d * 12 : (d.year ?? 0) * 12 + (d.month ?? 0)));
/** Is the nation alive at this turn? Unknown to the core table = always (the politics data predates it). */
export function nationAliveAt(state, data, nid, turn = state.turn) {
  const def = coreNation(data, nid);
  if (!def) return true;
  const dt = turnToDate(turn, state.startYear);
  const now = dt.year * 12 + dt.month;
  return monthOf(def.from, -Infinity) <= now && now <= monthOf(def.to, Infinity);
}
const GENERIC_CACHE = new WeakMap();
/** A politics definition for a nation the politics data does not describe (URSS 1950, a colony in 2300). */
function genericNationDef(data, id) {
  const src = coreNation(data, id);
  if (!src) return null;
  const d = data || DATA;
  let m = GENERIC_CACHE.get(d);
  if (!m) GENERIC_CACHE.set(d, (m = {}));
  if (m[id]) return m[id];
  const p = src.politics || {};
  m[id] = {
    id, name: src.name || id, flag: src.flag || '', art: src.art || p.art || 'o', capital: src.capital || p.capital || src.name || id,
    generic: true, actors: [], aliases: src.aliases || [], system: p.system || 'generic',
    legislature: p.legislature || 'parlamento', hearingBody: p.hearingBody || p.legislature || 'parlamento',
    economy: { growth: 2, trend: 2, inflation: 3, inflationTarget: 3, debt: 50, debtTolerance: 100, debtDrift: 0.5, volatility: 0.6, weight: 0.5, budgetBase: 0.02, budgetVolatility: 0.03, ...(p.economy || {}) },
    factions: p.factions || [{ id: 'gov', name: 'governo', short: 'o governo', gov: 'governo', spaceStance: 0.35, priority: 'crewed_prestige', hawk: 0.5, art: 'o' }],
    government: p.government || { exec: (p.factions?.[0]?.id) || 'gov' },
  };
  return m[id];
}
/** Nation of a lineage at this turn (data/core/lineages.json `nation: [{from, id}]`), or null. */
function lineageNationAt(state, data, actorId, turn = state.turn) {
  const d = data || DATA;
  const lin = d?.index?.lineages?.[actorId] || d?.lineages?.lineages?.find((l) => l.id === actorId);
  if (!Array.isArray(lin?.nation)) return null;
  const dt = turnToDate(turn, state.startYear);
  const now = dt.year * 12 + dt.month;
  let hit = null;
  for (const n of lin.nation) if (monthOf(n.from, -Infinity) <= now) hit = n.id;
  return hit;
}
const nationName = (data, id) => nationDef(data, id)?.name || id;
// first faction by id (same as factions.find), indexed once per data list
const FACTION_IDX = new WeakMap();
const factionDef = (nd, fid) => {
  const list = nd?.factions;
  if (!list) return null;
  let m = FACTION_IDX.get(list);
  if (!m) {
    m = new Map();
    for (const f of list) if (!m.has(f.id)) m.set(f.id, f);
    FACTION_IDX.set(list, m);
  }
  return m.get(fid) || list[0] || null;
};
const priorityLabel = (data, pid) => PD(data).priorities?.[pid]?.label || pid || '';
const levelLabel = (level) => PD().levels?.[level]?.label || LEVEL_LABELS[clamp(level | 0, 0, 4)];
export { levelLabel };

/** Template vars for a nation under key K: K, deK, emK, oK, capK (capital city, a singular journalistic subject). */
function nv(data, nid, K) {
  const nd = nationDef(data, nid);
  if (!nd) return {};
  const f = forms(nd.name, nd.art);
  return { [K]: nd.name, ['de' + K]: f.of, ['em' + K]: f.in, ['o' + K]: f.the, ['cap' + K]: nd.capital || nd.name };
}
function ev(e) {
  const f = forms(e?.name || 'votação', e?.art || (e?.name ? null : 'a'));
  return { election: f.the, Election: capFirst(e?.name || 'votação'), inElection: f.in, ofElection: f.of };
}
function legVars(nd) {
  const f = forms(nd?.legislature || 'parlamento', nd?.legislatureArt || 'o');
  return { legislature: f.the, ofLegislature: f.of, inLegislature: f.in };
}
function partyVars(fd) {
  return { party: fd?.name || '', ofParty: forms(fd?.name, fd?.art).of };
}

function actorShort(state, id) {
  const a = state.actors?.[id];
  return a?.short || a?.name || id;
}
function isCompany(state, data, id) {
  return state.actors?.[id]?.kind === 'company' || !!PD(data).markets?.[id];
}

/** Nation id of an actor (or null). Accepts nation ids too. */
export function nationOf(state, id) {
  if (!id) return null;
  const w = state.world || {};
  if (w.actorNation?.[id]) return w.actorNation[id];
  if (w.nations?.[id]) return id;
  return null;
}
/**
 * How warmly the actor's current government sees a bloc, -1..1 (faction `alignment` in data/politics.json),
 * or null when unknown (companies, actors without a nation, factions without the field). Read by diplomacy.
 */
export function blocAlignment(state, data, actorId, blocId) {
  const nid = nationOf(state, actorId);
  if (!nid || isCompany(state, data, actorId)) return null;
  const nd = nationDef(data, nid);
  const exec = state.world?.nations?.[nid]?.government?.exec;
  const v = factionDef(nd, exec)?.alignment?.[blocId];
  return typeof v === 'number' ? clamp(v, -1, 1) : null;
}

/** Known actor ids of a nation (data-listed + state actors mapped to it). */
// memo of the inverse map (not saved): rebuilt when the map object, the turn or its size changes, or on invalidate
const NATION_MEMO = { ref: null, turn: -1, n: -1, by: null };
const invalidateNations = () => { NATION_MEMO.ref = null; };
function actorsOfNation(state, nid) {
  const m = state.world?.actorNation || {};
  const n = Object.keys(m).length;
  if (NATION_MEMO.ref !== m || NATION_MEMO.turn !== state.turn || NATION_MEMO.n !== n) {
    const by = {};
    for (const k of Object.keys(m)) (by[m[k]] ||= []).push(k);
    Object.assign(NATION_MEMO, { ref: m, turn: state.turn, n, by });
  }
  return (NATION_MEMO.by[nid] || []).slice();
}
/** nation id -> actor ids, one pass (same order as actorsOfNation). */
function nationActorsMap(state) {
  const m = state.world?.actorNation || {};
  const out = {};
  for (const k of Object.keys(m)) (out[m[k]] ||= []).push(k);
  return out;
}
/** The nation's main agency present in the game (used as a/b in signals). */
function leadActor(state, data, nid) {
  const nd = nationDef(data, nid);
  const list = nd?.actors || actorsOfNation(state, nid);
  return list.find((id) => state.actors?.[id] && !isCompany(state, data, id)) || list.find((id) => state.actors?.[id]) || list[0] || nid;
}
function agenciesOf(state, data, nid) {
  return actorsOfNation(state, nid).filter((id) => state.actors?.[id] && !isCompany(state, data, id));
}

/** Map every known actor to a nation: data lists first, then actor.country aliases, then market.nation. */
function refreshActorNation(state, data) {
  const w = state.world;
  w.actorNation = w.actorNation || {};
  for (const n of nations(data)) for (const id of n.actors || []) w.actorNation[id] = n.id;
  for (const [id, m] of Object.entries(PD(data).markets || {})) if (!w.actorNation[id] && m.nation) w.actorNation[id] = m.nation;
  // the data lists describe 2026: an actor whose listed nation is not alive now (Roscosmos in 1950) follows its lineage
  for (const a of Object.values(state.actors || {})) {
    if (!a?.id) continue;
    const listed = w.actorNation[a.id];
    if (listed && (!w.nations || w.nations[listed])) continue;
    const ln = lineageNationAt(state, data, a.id) || (typeof a.nation === 'string' ? a.nation : null);
    if (ln && w.nations?.[ln]) { w.actorNation[a.id] = ln; continue; }
    if (listed) continue;
    const c = String(a.country || '').toLowerCase();
    const n = nations(data).find((x) => (x.aliases || []).some((al) => al.toLowerCase() === c) || x.name.toLowerCase() === c);
    if (n) w.actorNation[a.id] = n.id;
  }
  w.actorCount = Object.keys(state.actors || {}).length;
  invalidateNations();
}

// ---------------------------------------------------------------- news (capped, varied)

/**
 * Add a political news item from a template key. Respects the monthly cap (data.news.perMonth) unless `force`;
 * nothing ever passes hardMax except importance 3. Avoids repeating the last variant of the same key.
 */
function pnews(state, data, key, vars = {}, opts = {}) {
  const pd = PD(data);
  const list = opts.headlines || pd.templates?.[key];
  if (!list?.length) return null;
  const w = state.world;
  const mk = monthKey(state.turn, state.startYear);
  if (!w.newsMonth || w.newsMonth.key !== mk) w.newsMonth = { key: mk, count: 0 };
  const per = pd.news?.perMonth ?? 4;
  const hard = pd.news?.hardMax ?? 6;
  const importance = opts.importance ?? 1;
  // opts.always: rare structural changes (a country changing bloc) are never dropped by the monthly caps
  if (!opts.always && ((!opts.force && w.newsMonth.count >= per) || (w.newsMonth.count >= hard && importance < 3))) {
    state.stats['politics.newsDropped'] = (state.stats['politics.newsDropped'] || 0) + 1;
    return null;
  }
  const rng = rngFor(state.seed, state.turn, 'politics', 'tpl', key, w.newsMonth.count);
  let idx = Math.floor(rng.next() * list.length);
  const tplKey = opts.tplKey || key;
  // no-repeat window: none of the last `noRepeat` variants of this key (old saves only know the last one)
  w.tplLast = w.tplLast || {};
  w.tplRecent = w.tplRecent || {};
  const recent = w.tplRecent[tplKey] || (w.tplLast[tplKey] != null ? [w.tplLast[tplKey]] : []);
  const win = Math.min(recent.length, list.length - 1, pd.news?.noRepeat ?? 2);
  const banned = win > 0 ? recent.slice(-win) : [];
  for (let g = 0; g < list.length && banned.includes(idx); g++) idx = (idx + 1) % list.length;
  // a variant may be dated ({text, minYear}): in a 1950 campaign "Banda larga por satélite" waits for its era
  const year = turnToDate(state.turn, state.startYear ?? 0).year;
  const okAt = (e) => typeof e === 'string' || !(e?.minYear > year);
  for (let g = 0; g < list.length && !okAt(list[idx]); g++) idx = (idx + 1) % list.length;
  if (!okAt(list[idx])) return null;
  w.tplLast[tplKey] = idx;
  w.tplRecent[tplKey] = [...recent, idx].slice(-3);
  w.newsMonth.count += 1;
  return addNews(state, {
    headline: capFirst(fill(typeof list[idx] === 'string' ? list[idx] : list[idx]?.text, vars)),
    body: opts.body || '',
    tags: ['politics', ...(opts.tags || [])],
    actors: opts.actors || [],
    importance,
    icon: opts.icon || 'politics',
  });
}

// ---------------------------------------------------------------- init

export function init(state, data, ctx) {
  DATA = data;
  const pd = PD(data);
  const rng = ctx?.rng ? ctx.rng('init') : rngFor(state.seed, 'politics', 'init');
  state.world = {
    globalTension: 0,
    economy: {},     // view per actor: {kind, growth, inflation, debt, crisis, sentiment?}
    conflicts: [],   // [{id, pair, nations, place, startTurn, endTurn, level, peak}]
    nations: {},     // nid -> {government:{exec,legis}, econ, incumbentMod, pendingBudgetPct, divided}
    markets: {},     // companyId -> {sentiment, growth, crisis, nextRoundTurn, rounds}
    pairs: {},       // nationPairKey -> {a, b, level, pressure, sinceTurn, peak, changes}
    elections: [],   // schedule [{id, nation, turn, kind, name, weight, base, done, result}]
    actorNation: {},
    history: { tension: [], events: [], elections: [], crises: [], budgets: [] },
    cooldowns: {},   // key -> turn when available again
    eventCounts: {},
    newsMonth: null,
    tplLast: {},
    baseBudget: {},  // actorId -> first seen budget (floor reference)
    demand: null,    // player promise to the government/investors
    debrisRisk: 0,   // 0..1 orbital debris worry (risk/narrative may read it)
    shock: { growth: 0, inflation: 0 },
  };
  state.politics = {};
  state.tension = {};
  const w = state.world;
  refreshActorNation(state, data);

  for (const n of nations(data)) {
    if (!nationAliveAt(state, data, n.id, 0)) continue; // e.g. Russia in a 1950 start (the USSR comes from data/core/nations.json)
    const e = n.economy || {};
    const gov = { exec: n.government?.exec || n.factions?.[0]?.id, legis: n.government?.legis || n.government?.exec || n.factions?.[0]?.id };
    w.nations[n.id] = {
      government: gov,
      econ: { growth: e.growth ?? 2, inflation: e.inflation ?? 2, debt: e.debt ?? 80, crisis: null },
      incumbentMod: 0,
      pendingBudgetPct: 0,
      divided: gov.exec !== gov.legis,
    };
  }
  for (const [id, m] of Object.entries(pd.markets || {})) {
    w.markets[id] = { sentiment: m.sentiment ?? 55, growth: m.revenueGrowth ?? 0.1, crisis: null, nextRoundTurn: m.firstRoundWeek ?? 26, rounds: 0, demandChecked: false };
  }
  for (const p of pd.pairs || []) {
    if (!w.nations[p.a] || !w.nations[p.b] || p.a === p.b) continue;
    const lvl = Array.isArray(p.initial) ? rng.int(p.initial[0], p.initial[1]) : (p.initial ?? 0);
    w.pairs[relKey(p.a, p.b)] = { a: p.a, b: p.b, level: clamp(lvl, 0, 4), pressure: r3(rng.range(-0.2, 0.2)), sinceTurn: 0, peak: lvl, changes: 0 };
    PAIRS_VER++;
  }
  // ensure every nation pair exists (pairs missing from data get baseline 0)
  const ids = Object.keys(w.nations);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const k = relKey(ids[i], ids[j]);
    if (!w.pairs[k]) { w.pairs[k] = { a: ids[i], b: ids[j], level: 0, pressure: 0, sinceTurn: 0, peak: 0, changes: 0 }; PAIRS_VER++; }
  }
  // election schedule
  for (const e of pd.elections || []) {
    const turn = dateToTurn(e.year, e.month ?? 0, state.startYear) + Math.max(0, (e.week ?? 1) - 1);
    if (turn < 0 || !w.nations[e.nation]) continue;
    w.elections.push({ id: e.id, nation: e.nation, turn, kind: e.kind, name: e.name, weight: e.weight ?? 0.5, base: e.base ?? 0.5, stanceSwing: e.stanceSwing ?? 0.06, sensitivity: e.sensitivity ?? 1, art: e.art || null, done: false, result: null, demandChecked: false });
  }
  w.elections.sort((a, b) => a.turn - b.turn);
  ensureEntries(state, data);
  for (const k of Object.keys(w.pairs)) syncPair(state, k);
  updateViews(state, data);
  initGeo(state, data);
}

/** Per-actor political entry (contract: {government, stance, nextElectionTurn, priority}). */
function ensureEntries(state, data) {
  const pd = PD(data);
  const w = state.world;
  const ids = new Set([...Object.keys(state.actors || {}), ...Object.keys(w.actorNation || {})]);
  for (const id of ids) {
    if (state.politics[id]) continue;
    const nid = w.actorNation[id] || null;
    if (isCompany(state, data, id)) {
      const md = pd.markets?.[id] || {};
      if (!w.markets[id]) w.markets[id] = { sentiment: md.sentiment ?? 55, growth: md.revenueGrowth ?? 0.1, crisis: null, nextRoundTurn: state.turn + (md.firstRoundWeek ?? 26), rounds: 0, demandChecked: false };
      state.politics[id] = { kind: 'company', nation: nid, government: md.gov || 'investidores', stance: r3((w.markets[id].sentiment - 50) / 50), offset: 0, nextElectionTurn: w.markets[id].nextRoundTurn, nextElectionName: 'rodada de investimento', priority: 'growth' };
    } else if (nid && w.nations[nid]) {
      const t = stanceTarget(data, nid, state);
      state.politics[id] = { kind: 'agency', nation: nid, government: null, factions: null, stance: t, offset: 0, nextElectionTurn: null, nextElectionName: null, priority: null, stanceRef: t };
      refreshGovernment(state, data, nid);
    } else {
      state.politics[id] = { kind: 'other', nation: null, government: null, stance: 0, offset: 0, nextElectionTurn: null, nextElectionName: null, priority: null };
    }
  }
}

function stanceTarget(data, nid, state) {
  const nd = nationDef(data, nid);
  const g = state.world.nations[nid]?.government || {};
  const ex = factionDef(nd, g.exec);
  const lg = factionDef(nd, g.legis) || ex;
  return r3((ex?.spaceStance ?? 0.3) * 0.65 + (lg?.spaceStance ?? 0.3) * 0.35);
}

/** Copy nation government into the agency entries of that nation. */
function refreshGovernment(state, data, nid) {
  const nd = nationDef(data, nid);
  const ns = state.world.nations[nid];
  if (!ns) return;
  const ex = factionDef(nd, ns.government.exec);
  ns.divided = ns.government.exec !== ns.government.legis;
  for (const id of actorsOfNation(state, nid)) {
    const p = state.politics[id];
    if (!p || p.kind !== 'agency') continue;
    p.government = ex?.gov || ex?.name || null;
    p.factions = { ...ns.government };
    p.priority = ex?.priority || null;
  }
}

// ---------------------------------------------------------------- tension core

/** 0..4 tension between two actors (or nations). Same nation → 0. */
export function tensionBetween(state, a, b) {
  if (!state || !a || !b || a === b) return 0;
  const na = nationOf(state, a);
  const nb = nationOf(state, b);
  if (na && nb && na === nb) return 0;
  const v = state.tension?.[relKey(a, b)];
  if (typeof v === 'number') return clamp(Math.round(v), 0, 4);
  if (na && nb) return state.world?.pairs?.[relKey(na, nb)]?.level ?? 0;
  return 0;
}

/**
 * Set the tension between two actors (or nations) to `level`. Works at nation level when both sides map to
 * nations (all actor pairs follow). Emits 'tension/changed' and news; applies level effects. Returns the new level.
 */
export function setTension(state, a, b, level, reason = '', data = null) {
  if (data) DATA = data;
  if (!state || !a || !b || a === b) return 0;
  const na = nationOf(state, a);
  const nb = nationOf(state, b);
  if (na && nb && na === nb) return 0;
  const pk = na && nb ? relKey(na, nb) : null;
  if (pk && state.world?.pairs?.[pk]) return applyLevel(state, data || DATA, pk, level, reason);
  // actor pair outside the nation model
  const k = relKey(a, b);
  const from = tensionBetween(state, a, b);
  const to = clamp(Math.round(level), 0, 4);
  state.tension = state.tension || {};
  state.tension[k] = to;
  if (to !== from) emitSignal(state, 'tension/changed', { a, b, from, to, reason });
  return to;
}

/**
 * A provocation from another module (narrative card "+1 tension with the rival"). Same rule as reconcileExternal:
 * a nudge of ±1 becomes pressure on the nation pair (the monthly dynamics decide if the level really moves);
 * a jump of 2+ is deliberate and adopted at once. Only real level changes emit 'tension/changed'.
 * Returns the current level.
 */
export function nudgeTension(state, a, b, delta, reason = 'externo', data = null) {
  if (data) DATA = data;
  if (!state || !a || !b || a === b || !Number.isFinite(delta) || !delta) return tensionBetween(state, a, b);
  const na = nationOf(state, a);
  const nb = nationOf(state, b);
  if (na && nb && na === nb) return 0;
  const pk = na && nb ? relKey(na, nb) : null;
  const p = pk ? state.world?.pairs?.[pk] : null;
  if (p) {
    if (Math.abs(delta) >= 2) return applyLevel(state, data || DATA, pk, p.level + Math.round(delta), 'externo');
    const M = PD(data || DATA).tensionModel || {};
    p.pressure = r3((p.pressure || 0) + delta * (M.externalImpulse ?? 0.45));
    log(state, `politics: ${reason} em ${pk} vira pressão (${p.pressure})`);
    return p.level;
  }
  return setTension(state, a, b, tensionBetween(state, a, b) + Math.round(delta), reason, data);
}

// Pair list in insertion order (what for-in / Object.entries give), rebuilt only when this module adds or deletes a
// pair (PAIRS_VER) or another world object is in play (a loaded save). Walking 600 dictionary keys every week was a
// top cost of the late campaign.
let PAIRS_VER = 0;
const PAIRS_CACHE = { pairs: null, ver: -1, keys: [], objs: [] };
function pairList(w) {
  const pairs = w.pairs;
  if (PAIRS_CACHE.pairs !== pairs || PAIRS_CACHE.ver !== PAIRS_VER) {
    PAIRS_CACHE.pairs = pairs;
    PAIRS_CACHE.ver = PAIRS_VER;
    PAIRS_CACHE.keys = Object.keys(pairs);
    PAIRS_CACHE.objs = PAIRS_CACHE.keys.map((k) => pairs[k]);
  }
  return PAIRS_CACHE;
}

function syncPair(state, pk, byNation = null) {
  const p = state.world.pairs[pk];
  if (!p) return;
  const as = byNation ? byNation[p.a] || [] : actorsOfNation(state, p.a);
  const bs = byNation ? byNation[p.b] || [] : actorsOfNation(state, p.b);
  const T = state.tension;
  for (const x of as) for (const y of bs) { const k = relKey(x, y); if (T[k] !== p.level) T[k] = p.level; }
}

/**
 * Another module may have written state.tension directly (e.g. a narrative choice "+1 tension with the rival").
 * A small nudge (±1) becomes a pressure impulse on the nation pair: provocations matter, but one card does not
 * start a war by itself. A jump of 2+ levels is treated as deliberate and adopted.
 */
// nation pairs with actors on both sides (the only ones reconcileExternal can touch), memoized on the actor→nation
// map and the pair count: 630 pairs in a late campaign, most of them between nations with no agency
const LIVE_PAIRS = { sig: null, pairs: null, ver: -1, list: [], keys: new Map() };
function livePairs(state) {
  const an = state.world?.actorNation || {};
  const pairs = state.world.pairs;
  const PL = pairList(state.world);
  let sig = String(PL.keys.length);
  for (const k in an) sig += `|${k}:${an[k]}`;
  if (LIVE_PAIRS.sig !== sig || LIVE_PAIRS.pairs !== pairs || LIVE_PAIRS.ver !== PL.ver) {
    const byNation = nationActorsMap(state);
    LIVE_PAIRS.sig = sig;
    LIVE_PAIRS.pairs = pairs;
    LIVE_PAIRS.ver = PL.ver;
    LIVE_PAIRS.list = PL.keys.filter((pk) => (byNation[pairs[pk].a] || []).length && (byNation[pairs[pk].b] || []).length);
    // actor-pair keys of each live nation pair, in the order the nested actor loops visit them
    LIVE_PAIRS.keys = new Map();
    for (const pk of LIVE_PAIRS.list) {
      const ks = [];
      for (const x of byNation[pairs[pk].a] || []) for (const y of byNation[pairs[pk].b] || []) ks.push(relKey(x, y));
      LIVE_PAIRS.keys.set(pk, ks);
    }
  }
  return LIVE_PAIRS;
}

function reconcileExternal(state, data) {
  const M = PD(data).tensionModel || {};
  const live = livePairs(state);
  const T = state.tension;
  for (const pk of live.list) {
    const p = state.world.pairs[pk];
    if (!p) continue;
    const ks = live.keys.get(pk);
    let ext = null;
    let dirty = false;
    for (let i = 0; i < ks.length; i++) {
      const v = T[ks[i]];
      if (v !== p.level) dirty = true;
      if (typeof v === 'number' && Math.round(v) !== p.level) { ext = clamp(Math.round(v), 0, 4); break; }
    }
    // in step: nothing to write (the same writes, in the same order, as syncPair over the actor lists)
    if (ext == null) { if (dirty) for (const k of ks) if (T[k] !== p.level) T[k] = p.level; continue; }
    const delta = ext - p.level;
    if (Math.abs(delta) >= 2) applyLevel(state, data, pk, ext, 'externo');
    else {
      p.pressure = r3(p.pressure + delta * (M.externalImpulse ?? 0.45));
      for (const k of ks) if (T[k] !== p.level) T[k] = p.level;
      log(state, `politics: incidente externo em ${pk} vira pressão (${p.pressure})`);
    }
  }
}

function pairPlace(state, data, pk) {
  const p = state.world.pairs[pk];
  const def = pairDef(data, pk);
  const places = def?.places || [];
  if (!places.length) return '';
  const rng = rngFor(state.seed, 'politics', 'place', pk, p.changes || 0);
  return rng.pick(places);
}

// data pair definitions by key (first match wins, as with find)
const PAIR_DEFS = new WeakMap();
function pairDef(data, pk) {
  const list = PD(data).pairs || [];
  let m = PAIR_DEFS.get(list);
  if (!m) {
    m = new Map();
    for (const x of list) { const k = relKey(x.a, x.b); if (!m.has(k)) m.set(k, x); }
    PAIR_DEFS.set(list, m);
  }
  return m.get(pk);
}
function pairFloor(data, pk) {
  return pairDef(data, pk)?.floor ?? 0;
}

function applyLevel(state, data, pk, toLevel, reason = '', opts = {}) {
  const w = state.world;
  const p = w.pairs[pk];
  if (!p) return 0;
  let to = clamp(Math.round(toLevel), 0, 4);
  if (reason !== 'externo') to = Math.max(to, pairFloor(data, pk));
  const from = p.level;
  if (to === from) return from;
  p.level = to;
  p.sinceTurn = state.turn;
  p.pressure = 0;
  p.peak = Math.max(p.peak || 0, to);
  p.changes = (p.changes || 0) + 1;
  syncPair(state, pk);
  pushCapped(w.history.tension, { turn: state.turn, pair: pk, from, to, reason }, histCap(state, 'tension'));
  state.stats['politics.tensionChanges'] = (state.stats['politics.tensionChanges'] || 0) + 1;
  const la = leadActor(state, data, p.a);
  const lb = leadActor(state, data, p.b);
  emitSignal(state, 'tension/changed', { a: la, b: lb, from, to, nations: [p.a, p.b], reason });
  log(state, `politics: tensão ${pk} ${from}→${to} (${reason || 'dinâmica'})`);

  const place = pairPlace(state, data, pk);
  const playerNation = nationOf(state, state.playerId);
  const involved = playerNation === p.a || playerNation === p.b;
  const vars = { ...nv(data, p.a, 'A'), ...nv(data, p.b, 'B'), place };
  const key = to > from ? `tension_up_${to}` : `tension_down_${to}`;
  const importance = to >= 3 || from >= 3 ? 3 : to === 2 || from === 2 ? (involved ? 3 : 2) : involved ? 2 : 1;
  pnews(state, data, key, vars, {
    importance, force: to >= 2 || from >= 2 || involved, actors: [la, lb], tags: ['tension'],
    body: opts.body || `Escala de tensão ${vars.A}–${vars.B}: ${levelLabel(from)} → ${levelLabel(to)}.`,
  });

  if (to > from) for (let L = from + 1; L <= to; L++) enterLevel(state, data, pk, L, place);
  else for (let L = from; L > to; L--) exitLevel(state, data, pk, L, place);
  updateGlobalTension(state);
  return to;
}

/** Active partnerships across a nation pair (treaties or shared bloc), as actor pairs. */
function crossPartnerships(state, data, pk) {
  const p = state.world.pairs[pk];
  const as = actorsOfNation(state, p.a).filter((id) => state.actors?.[id]);
  const bs = actorsOfNation(state, p.b).filter((id) => state.actors?.[id]);
  const out = [];
  for (const x of as) for (const y of bs) {
    const treaty = (state.treaties || []).some((t) => t?.status === 'active' && !t.terms?.multilateral && t.parties?.includes(x) && t.parties?.includes(y));
    const bloc = Object.values(state.blocs || {}).some((bl) => bl?.members?.includes(x) && bl.members.includes(y));
    if (treaty || bloc) out.push([x, y]);
  }
  return out;
}

function budgetDelta(state, actorId, pct, note) {
  const a = state.actors?.[actorId];
  if (!a || typeof a.budget !== 'number') return 0;
  const from = a.budget;
  changeActor(state, actorId, 'budget', from * pct);
  const floor = (state.world.baseBudget[actorId] ?? from) * (PD().budgetModel?.floorShare ?? 0.4);
  if (a.budget < floor) a.budget = floor;
  a.budget = Math.max(1, Math.round(a.budget * 10) / 10);
  if (a.budget !== from) emitSignal(state, 'budget/changed', { actorId, from, to: a.budget, reason: note });
  return a.budget - from;
}

function enterLevel(state, data, pk, L, place) {
  const pd = PD(data);
  const fx = pd.levelEffects || {};
  const w = state.world;
  const p = w.pairs[pk];
  const vars = { ...nv(data, p.a, 'A'), ...nv(data, p.b, 'B'), place };
  const pid = state.playerId;
  const pNation = nationOf(state, pid);
  if (L === 2) {
    // sanctions: partnership money across the pair is frozen
    const cutPct = fx.partnershipCutPct ?? 0.03;
    const pairs = crossPartnerships(state, data, pk);
    let first = true;
    for (const [x, y] of pairs) {
      const amount = (state.actors[x].budget || 0) * cutPct + (state.actors[y].budget || 0) * cutPct;
      for (const id of [x, y]) {
        const lost = -budgetDelta(state, id, -cutPct, 'sanções');
        if (id === pid && lost > 0) offerDecision(state, data, 'partnership_freeze', {
          A: vars.A, B: vars.B, partner: actorShort(state, id === x ? y : x), amount: fmtMoney(lost), half: fmtMoney(lost / 2),
        }, { lost, pair: pk }, { urgency: 2 });
      }
      if (first) pnews(state, data, 'level2_partner_cut', { ...vars, actorA: actorShort(state, x), actorB: actorShort(state, y), amount: fmtMoney(amount) }, { importance: 2, actors: [x, y], tags: ['budget'] });
      first = false;
    }
  } else if (L === 3) {
    const c = { id: `conflict_${pk.replace('|', '_')}_${state.turn}`, pair: pk, nations: [p.a, p.b], place, startTurn: state.turn, endTurn: null, level: 3, peak: 3 };
    w.conflicts.push(c);
    if (w.conflicts.length > 20) w.conflicts.splice(0, w.conflicts.length - 20);
    state.stats['politics.conflicts'] = (state.stats['politics.conflicts'] || 0) + 1;
    pnews(state, data, 'level3_access', vars, { importance: pNation === p.a || pNation === p.b ? 3 : 2, actors: [leadActor(state, data, p.a), leadActor(state, data, p.b)], force: true, tags: ['conflict'] });
  } else if (L === 4) {
    const c = w.conflicts.find((x) => x.pair === pk && x.endTurn == null);
    if (c) { c.level = 4; c.peak = 4; }
    const cut = fx.warCutPct ?? 0.08;
    const agA = agenciesOf(state, data, p.a);
    const agB = agenciesOf(state, data, p.b);
    let total = 0;
    for (const id of [...agA, ...agB]) {
      total += -budgetDelta(state, id, -cut, 'prioridade militar');
      const pp = state.politics[id];
      if (pp) pp.offset = r3((pp.offset || 0) + (fx.warStance ?? -0.1));
    }
    emitSignal(state, 'politics/suspension', { a: leadActor(state, data, p.a), b: leadActor(state, data, p.b), nations: [p.a, p.b], turn: state.turn });
    pnews(state, data, 'level4_military', { ...vars, actorA: actorShort(state, agA[0] || p.a), actorB: actorShort(state, agB[0] || p.b), pct: fmtPct(cut, false) }, { importance: 3, force: true, tags: ['conflict', 'budget'] });
    // player decisions: own nation at war, or a partner at war
    if (pNation === p.a || pNation === p.b) {
      const lost = (state.actors[pid]?.budget || 0) * cut;
      offerDecision(state, data, 'suspension', { A: vars.A, B: vars.B, amount: fmtMoney(lost), chance: '40%' }, { pair: pk, lost, chance: 0.4 }, { urgency: 3, variant: 'agency', force: true });
    } else if (pid && state.actors?.[pid]) {
      const partners = [...agA, ...agB].filter((id) => (state.treaties || []).some((t) => t?.status === 'active' && !t.terms?.multilateral && t.parties?.includes(id) && t.parties?.includes(pid)));
      if (partners.length) offerDecision(state, data, 'suspension', { A: vars.A, B: vars.B, partner: actorShort(state, partners[0]), chance: '50%' }, { pair: pk, lost: 0, chance: 0.5, partner: partners[0] }, { urgency: 2, variant: 'partner' });
    }
  }
}

function exitLevel(state, data, pk, L) {
  const c = state.world.conflicts.find((x) => x.pair === pk && x.endTurn == null);
  if (!c) return;
  if (L === 4) c.level = 3;
  if (L === 3) { c.endTurn = state.turn; c.level = 2; }
}

function updateGlobalTension(state) {
  // the three highest levels in one pass (same result as sorting every pair each week)
  let t0 = -Infinity, t1 = -Infinity, t2 = -Infinity, n = 0;
  for (const pr of pairList(state.world).objs) {
    const x = pr.level;
    n++;
    if (x > t0) { t2 = t1; t1 = t0; t0 = x; } else if (x > t1) { t2 = t1; t1 = x; } else if (x > t2) t2 = x;
  }
  if (!n) { state.world.globalTension = 0; return; }
  const top = [t0, t1, t2].slice(0, Math.min(3, n));
  const avg = top.reduce((s, x) => s + x, 0) / top.length;
  state.world.globalTension = Math.round(clamp(0.5 * t0 + 0.5 * avg, 0, 4) * 10) / 10;
}

// ---------------------------------------------------------------- monthly dynamics

const EMPTY_DEF = Object.freeze({});
function tensionDynamics(state, data, rng) {
  const pd = PD(data);
  const M = pd.tensionModel || {};
  const up = M.up || [0.55, 0.7, 1.0, 1.35];
  const drag = M.levelDrag || [0, 0, 0, 0.05, 0.18];
  const w = state.world;
  // active treaties per actor pair, counted once (was a scan of every treaty for each of the 600+ pairs)
  const peaceIdx = new Map();
  for (const t of state.treaties || []) {
    if (t?.status !== 'active' || !Array.isArray(t.parties)) continue;
    const ps = [...new Set(t.parties)];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const k = relKey(ps[i], ps[j]);
      peaceIdx.set(k, (peaceIdx.get(k) || 0) + 1);
    }
  }
  // lead agency per nation, once per month (the actors do not change inside this loop)
  const leads = new Map();
  const lead = (nid) => { let x = leads.get(nid); if (x === undefined) { x = leadActor(state, data, nid); leads.set(nid, x); } return x; };
  // per nation, once per month (nothing in this loop changes governments or crises): the government's hawkishness
  // and the instability added by an economic crisis (null = none)
  const hawks = new Map();
  const hawk = (nid) => {
    let h = hawks.get(nid);
    if (h === undefined) { h = factionDef(nationDef(data, nid), w.nations[nid]?.government.exec)?.hawk ?? 0.5; hawks.set(nid, h); }
    return h;
  };
  const instab = new Map();
  const instability = (nid) => {
    let v = instab.get(nid);
    if (v === undefined) {
      const c = w.nations[nid]?.econ.crisis;
      v = c ? pd.crises?.[c.type]?.instability ?? 0.05 : null;
      instab.set(nid, v);
    }
    return v;
  };
  const PL = pairList(w);
  const st = pairStatics(PL, data);
  for (let pi = 0; pi < PL.keys.length; pi++) {
    const pk = PL.keys[pi], p = PL.objs[pi];
    const def = st.defs[pi];
    let drive = ((def.baseline ?? 0.2) - p.level) * (M.meanReversion ?? 0.12);
    // diplomacy relations between lead agencies (if diplomacy runs); the pair's last key is reused while the leads hold
    const la0 = lead(p.a), lb0 = lead(p.b);
    let rk = st.relKeys[pi];
    if (!rk || rk.a !== la0 || rk.b !== lb0) rk = st.relKeys[pi] = { a: la0, b: lb0, k: relKey(la0, lb0) };
    const rel = state.relations?.[rk.k];
    if (rel) drive += (((rel.rivalry ?? 30) - 40) / 100) * (M.rivalryFactor ?? 0.08) - ((rel.trust ?? 0) / 100) * (M.trustFactor ?? 0.05);
    // hawkish governments push up
    const ha = hawk(p.a);
    const hb = hawk(p.b);
    drive += (ha + hb - 1) * (M.hawkFactor ?? 0.08) * (p.level > 0 || def.baseline > 0.5 ? 1 : 0.3);
    // economic instability breeds friction
    const ia = instability(p.a);
    if (ia !== null) drive += ia;
    const ib = instability(p.b);
    if (ib !== null) drive += ib;
    // bilateral peaceful treaties dampen
    const la = la0;
    const lb = lb0;
    const peace = la === lb ? (state.treaties || []).filter((t) => t?.status === 'active' && t.parties?.includes(la)).length : (peaceIdx.get(relKey(la, lb)) || 0);
    drive -= Math.min(3, peace) * (M.peaceTreaty ?? 0.02);
    drive -= drag[p.level] || 0; // war exhaustion
    drive += rng.normal(0, (def.volatility ?? 0.2) * (M.noiseScale ?? 0.3));
    p.pressure = r3(p.pressure * (M.decay ?? 0.8) + drive);
    const dwell = state.turn - (p.sinceTurn ?? 0) >= (M.minDwellWeeks ?? 8);
    if (!dwell) continue;
    if (p.level < 4 && p.pressure > up[p.level]) applyLevel(state, data, pk, p.level + 1, 'escalada');
    else if (p.level > (def.floor ?? 0) && p.pressure < -(M.down ?? 0.55)) applyLevel(state, data, pk, p.level - 1, 'distensão');
  }
}

// data definition of each pair of the cached pair list (EMPTY_DEF when none; pairFloor reads def.floor the same way)
// and a slot for its lead-agency relation key, rebuilt with the list or when the data changes (not saved)
const PAIR_STATICS = { list: null, keys: null, data: null, defs: [], relKeys: [] };
function pairStatics(PL, data) {
  if (PAIR_STATICS.list !== PL || PAIR_STATICS.keys !== PL.keys || PAIR_STATICS.data !== data) {
    PAIR_STATICS.list = PL;
    PAIR_STATICS.keys = PL.keys;
    PAIR_STATICS.data = data;
    PAIR_STATICS.defs = PL.keys.map((pk) => pairDef(data, pk) || EMPTY_DEF);
    PAIR_STATICS.relKeys = new Array(PL.keys.length).fill(null);
  }
  return PAIR_STATICS;
}

function startCrisis(state, data, nid, type, rng, severity = 1) {
  const pd = PD(data);
  const ns = state.world.nations[nid];
  if (!ns || ns.econ.crisis) return false;
  const def = pd.crises?.[type] || {};
  const [lo, hi] = def.months || [6, 12];
  const months = rng.int(lo, hi);
  ns.econ.crisis = { type, startTurn: state.turn, untilTurn: state.turn + Math.round(months * WEEKS_PER_YEAR / 12), severity: r2(severity) };
  pushCapped(state.world.history.crises, { turn: state.turn, nation: nid, type, months }, histCap(state, 'crises'));
  state.stats['politics.crises'] = (state.stats['politics.crises'] || 0) + 1;
  for (const id of agenciesOf(state, data, nid)) {
    const p = state.politics[id];
    if (p) p.offset = r3((p.offset || 0) + (def.stance ?? -0.05));
  }
  const pNation = nationOf(state, state.playerId);
  pnews(state, data, `crisis_${type}`, nv(data, nid, 'N'), { importance: nid === pNation ? 3 : 2, force: nid === pNation || (nationDef(data, nid)?.economy?.weight ?? 0) >= 0.8, tags: ['economy'], actors: agenciesOf(state, data, nid) });
  // big economies drag everyone a bit (contagion)
  if (type === 'recession' && (nationDef(data, nid)?.economy?.weight ?? 0) >= 0.8) state.world.shock.growth = r2(state.world.shock.growth - 0.5);
  return true;
}

function updateEconomy(state, data, rng) {
  const pd = PD(data);
  const w = state.world;
  for (const n of nations(data)) {
    const ns = w.nations[n.id];
    if (!ns) continue;
    const e = ns.econ;
    const ed = n.economy || {};
    const c = e.crisis;
    const cd = c ? pd.crises?.[c.type] || {} : null;
    const sev = c?.severity ?? 1;
    const gTarget = (ed.trend ?? 2) + (cd?.growthHit ?? 0) * sev + w.shock.growth;
    e.growth = r2(e.growth + (gTarget - e.growth) * 0.18 + rng.normal(0, (ed.volatility ?? 0.5) * 0.3));
    const iTarget = (ed.inflationTarget ?? 2) + (cd?.inflationHit ?? 0) * sev + w.shock.inflation;
    e.inflation = r2(e.inflation + (iTarget - e.inflation) * 0.12 + rng.normal(0, 0.12));
    e.debt = r2(e.debt + ((ed.debtDrift ?? 0.5) + (cd?.debtHit ?? 0)) / 12);
    if (c && state.turn >= c.untilTurn) {
      e.crisis = null;
      pnews(state, data, 'crisis_end', { ...nv(data, n.id, 'N'), crisis: cd?.label || 'crise' }, { importance: 1, tags: ['economy'] });
    } else if (!c) {
      // hazards: one roll per crisis type, state-dependent
      const rec = pd.crises?.recession || {};
      const inf = pd.crises?.inflation_shock || {};
      const debt = pd.crises?.debt_crisis || {};
      const pRec = (rec.base ?? 0.0035) + Math.max(0, (ed.trend ?? 2) * 0.5 - e.growth) * (rec.lowGrowth ?? 0.01);
      const pInf = (inf.base ?? 0.0025) + Math.max(0, e.inflation - (ed.inflationTarget ?? 2) - 1) * (inf.highInflation ?? 0.006);
      const pDebt = (debt.base ?? 0.0005) + Math.max(0, e.debt - (ed.debtTolerance ?? 100)) / 100 * (debt.debtFactor ?? 0.02) + (e.inflation > 6 ? 0.002 : 0);
      const roll = rng.next();
      if (roll < pDebt) startCrisis(state, data, n.id, 'debt_crisis', rng, rng.range(0.8, 1.2));
      else if (roll < pDebt + pRec) startCrisis(state, data, n.id, 'recession', rng, rng.range(0.7, 1.2));
      else if (roll < pDebt + pRec + pInf) startCrisis(state, data, n.id, 'inflation_shock', rng, rng.range(0.7, 1.2));
    }
  }
  w.shock.growth = r2(w.shock.growth * 0.7);
  w.shock.inflation = r2(w.shock.inflation * 0.7);
  w.debrisRisk = r3(clamp(w.debrisRisk * 0.95, 0, 1));
}

function updateMarkets(state, data, rng) {
  const pd = PD(data);
  const w = state.world;
  for (const [id, m] of Object.entries(w.markets)) {
    const md = pd.markets?.[id] || {};
    const home = w.nations[md.nation || w.actorNation[id]]?.econ;
    const hd = nationDef(data, md.nation)?.economy || {};
    let target = md.baseSentiment ?? 55;
    if (home) target += (home.growth - (hd.trend ?? 2)) * 4 - Math.max(0, home.inflation - 3) * 3 - (home.crisis ? 6 : 0);
    if (m.crisis) target += pd.crises?.market_crash?.sentiment ?? -15;
    m.sentiment = r2(clamp(m.sentiment + (target - m.sentiment) * 0.08 + rng.normal(0, md.volatility ?? 2.5), 5, 95));
    m.growth = r3(clamp(m.growth + ((md.revenueGrowth ?? 0.1) + (m.sentiment - 50) / 400 - m.growth) * 0.1, -0.3, 0.6));
    if (m.crisis && state.turn >= m.crisis.untilTurn) m.crisis = null;
    const p = state.politics[id];
    if (p) p.stance = r3(clamp((m.sentiment - 50) / 50, -1, 1));
  }
}

function updateStances(state, data) {
  for (const [id, p] of Object.entries(state.politics)) {
    if (p.kind !== 'agency' || !p.nation) continue;
    const t = stanceTarget(data, p.nation, state);
    p.stance = r3(clamp(p.stance + (t + (p.offset || 0) - p.stance) * 0.2, -1, 1));
    p.offset = r3((p.offset || 0) * 0.85);
    // public opinion follows the political mood a little (other modules move support far more)
    const a = state.actors?.[id];
    if (a && typeof a.support === 'number') changeActor(state, id, 'support', (50 + p.stance * 30 - a.support) * 0.035);
    // partners' trust also fades back toward the middle without news to sustain it
    if (a && typeof a.reputation === 'number') changeActor(state, id, 'reputation', (55 - a.reputation) * 0.02);
  }
}

// ---------------------------------------------------------------- exogenous events

function pairCandidates(state, data, def) {
  const w = state.world;
  const lo = def.minLevel ?? 0, hi = def.maxLevel ?? 4, bias = def.levelBias ?? 0.4;
  const out = [];
  const add = (a, b, p = w.pairs[relKey(a, b)]) => {
    if (p.level >= lo && p.level <= hi) out.push({ a, b, p, weight: 1 + p.level * bias + Math.max(0, p.pressure) * 0.5 });
  };
  // one pass (a late campaign has 600+ pairs and this runs for every eligible event each month)
  if (def.pairs === 'any' || !def.pairs) for (const pr of pairList(w).objs) add(pr.a, pr.b, pr); // every pair is stored under relKey(a, b)
  else for (const [a, b] of def.pairs) if (w.pairs[relKey(a, b)]) add(a, b);
  return out;
}

function eventEligible(state, data, def) {
  const w = state.world;
  if ((w.cooldowns[`ev:${def.id}`] ?? -1) > state.turn) return false;
  if (def.once && w.eventCounts[def.id]) return false;
  if (def.minTurn != null && state.turn < def.minTurn) return false;
  // era gate (campaign 1950–3000): an event that only makes sense from/until a given year
  if (def.minYear != null || def.maxYear != null) {
    const y = turnToDate(state.turn, state.startYear ?? 0).year;
    if (def.minYear != null && y < def.minYear) return false;
    if (def.maxYear != null && y > def.maxYear) return false;
  }
  if (def.minGlobal != null && w.globalTension < def.minGlobal) return false;
  if (def.maxGlobal != null && w.globalTension > def.maxGlobal) return false;
  return true;
}

function resolveWho(who, ctx, data) {
  const all = nations(data).map((n) => n.id);
  if (Array.isArray(who)) return who;
  switch (who) {
    case 'a': return ctx.a ? [ctx.a] : [];
    case 'b': return ctx.b ? [ctx.b] : [];
    case 'both': return [ctx.a, ctx.b].filter(Boolean);
    case 'nation': return ctx.n ? [ctx.n] : [];
    case 'all': return all;
    default: return [];
  }
}

function applyEventEffects(state, data, def, tctx, rng) {
  const fx = def.effects || {};
  const w = state.world;
  const pk = tctx.a && tctx.b ? relKey(tctx.a, tctx.b) : null;
  if (pk && w.pairs[pk]) {
    const p = w.pairs[pk];
    if (fx.pressure) p.pressure = r3(p.pressure + fx.pressure);
    // events can move the level directly, but not in the opening weeks nor right after another change
    const settled = state.turn - (p.sinceTurn ?? 0) >= 6 && state.turn >= 6;
    if (fx.tension && settled && rng.chance(fx.tensionChance ?? 1)) {
      const target = clamp(p.level + fx.tension, 0, fx.tension > 0 ? (fx.maxResult ?? 3) : 4);
      if (target !== p.level) applyLevel(state, data, pk, target, def.id);
    }
  }
  if (fx.pressureAll) for (const p of Object.values(w.pairs)) if (p.level >= 1 || fx.pressureAll > 0) p.pressure = r3(p.pressure + fx.pressureAll);
  for (const e of fx.econ || []) {
    for (const nid of resolveWho(e.who, tctx, data)) {
      const ec = w.nations[nid]?.econ;
      if (!ec) continue;
      if (e.growth) ec.growth = r2(ec.growth + e.growth);
      if (e.inflation) ec.inflation = r2(ec.inflation + e.inflation);
      if (e.crisis && rng.chance(e.crisisChance ?? 1)) startCrisis(state, data, nid, e.crisis, rng, 1);
    }
  }
  for (const s of fx.stance || []) {
    for (const nid of resolveWho(s.who, tctx, data)) for (const id of agenciesOf(state, data, nid)) {
      const p = state.politics[id];
      if (p) p.offset = r3((p.offset || 0) + s.delta);
    }
  }
  for (const b of fx.budgetPct || []) {
    for (const nid of resolveWho(b.who, tctx, data)) for (const id of agenciesOf(state, data, nid)) budgetDelta(state, id, b.pct, def.id);
  }
  for (const inc of fx.incumbent || []) {
    for (const nid of resolveWho(inc.who, tctx, data)) if (w.nations[nid]) w.nations[nid].incumbentMod = r2(w.nations[nid].incumbentMod + inc.delta);
  }
  if (fx.sentiment) for (const m of Object.values(w.markets)) m.sentiment = r2(clamp(m.sentiment + fx.sentiment, 5, 95));
  if (fx.marketCrisis) {
    const md = PD(data).crises?.market_crash || {};
    const [lo, hi] = md.months || [4, 9];
    const until = state.turn + Math.round(rng.int(lo, hi) * WEEKS_PER_YEAR / 12);
    for (const m of Object.values(w.markets)) m.crisis = { type: 'market_crash', startTurn: state.turn, untilTurn: until };
  }
  if (fx.debris) w.debrisRisk = r3(clamp(w.debrisRisk + fx.debris, 0, 1));
}

function exogenousEvents(state, data, rng) {
  const pd = PD(data);
  const w = state.world;
  const defs = pd.events || [];
  let n = rng.chance(pd.eventsPerMonth ?? 0.6) ? 1 : 0;
  if (n && rng.chance(0.2)) n = 2;
  for (let i = 0; i < n; i++) {
    const options = [];
    for (const def of defs) {
      if (!eventEligible(state, data, def)) continue;
      if (def.target === 'pair') {
        const c = pairCandidates(state, data, def);
        if (c.length) options.push({ def, cands: c, weight: def.weight ?? 1 });
      } else if (def.target === 'nation') {
        let ns = def.nations === 'any' || !def.nations ? nations(data).map((x) => x.id).filter((x) => w.nations[x]) : def.nations.filter((x) => w.nations[x]);
        if (def.requiresDivided) ns = ns.filter((x) => w.nations[x]?.divided);
        if (ns.length) options.push({ def, nats: ns, weight: def.weight ?? 1 });
      } else options.push({ def, weight: def.weight ?? 1 });
    }
    const pick = rng.weighted(options);
    if (!pick) break;
    const def = pick.def;
    const tctx = {};
    if (pick.cands) {
      const c = rng.weighted(pick.cands);
      // listed pairs are ordered (a = actor of the event); 'any' pairs are randomly oriented
      const flip = def.pairs === 'any' && rng.chance(0.5);
      tctx.a = flip ? c.b : c.a;
      tctx.b = flip ? c.a : c.b;
    }
    if (pick.nats) tctx.n = rng.pick(pick.nats);
    w.cooldowns[`ev:${def.id}`] = state.turn + Math.round((def.cooldownMonths ?? 6) * WEEKS_PER_YEAR / 12);
    w.eventCounts[def.id] = (w.eventCounts[def.id] || 0) + 1;
    const place = tctx.a && tctx.b ? pairPlace(state, data, relKey(tctx.a, tctx.b)) : '';
    const vars = { ...nv(data, tctx.a, 'A'), ...nv(data, tctx.b, 'B'), ...nv(data, tctx.n, 'N'), place: place || 'na região' };
    const pNation = nationOf(state, state.playerId);
    const involved = [tctx.a, tctx.b, tctx.n].includes(pNation) || def.target === 'global';
    const item = pnews(state, data, `ev:${def.id}`, vars, {
      headlines: def.headlines, tplKey: `ev:${def.id}`, importance: def.importance ?? 2,
      force: (def.importance ?? 2) >= 3, tags: ['event', def.id],
      actors: [tctx.a, tctx.b, tctx.n].filter(Boolean).map((x) => leadActor(state, data, x)),
    });
    pushCapped(w.history.events, { turn: state.turn, id: def.id, a: tctx.a || null, b: tctx.b || null, n: tctx.n || null, headline: item?.headline || null, involved }, histCap(state, 'events'));
    state.stats['politics.events'] = (state.stats['politics.events'] || 0) + 1;
    applyEventEffects(state, data, def, tctx, rng);
  }
}

// ---------------------------------------------------------------- elections

function scheduleSnapElections(state, data, rng) {
  const w = state.world;
  const em = PD(data).electionModel || {};
  for (const n of nations(data)) {
    if (!n.snapElectionPerYear || !w.nations[n.id]) continue;
    const soon = w.elections.some((e) => e.nation === n.id && !e.done && (e.kind === 'executive' || e.kind === 'legislative') && e.turn - state.turn < WEEKS_PER_YEAR);
    if (soon || !rng.chance(n.snapElectionPerYear / 12)) continue;
    const [lo, hi] = em.snapLeadWeeks || [5, 8];
    const turn = state.turn + rng.int(lo, hi);
    if (turn > state.endTurn) continue;
    w.elections.push({ id: `snap_${n.id}_${state.turn}`, nation: n.id, turn, kind: 'executive', name: `eleição antecipada ${forms(n.name, n.art).in}`, art: 'a', weight: 0.6, base: 0.55, stanceSwing: 0.06, done: false, result: null, demandChecked: true });
    w.elections.sort((a, b) => a.turn - b.turn);
    pnews(state, data, 'snap_called', nv(data, n.id, 'N'), { importance: 2, tags: ['election'] });
  }
}

function incumbentChance(state, data, e) {
  const em = PD(data).electionModel || {};
  const nd = nationDef(data, e.nation);
  const ns = state.world.nations[e.nation];
  const ec = ns.econ;
  const ed = nd?.economy || {};
  // sensitivity: how much circumstances matter (low for managed systems like Russia/China)
  const k = e.sensitivity ?? 1;
  let p = 0;
  p += (ec.growth - (ed.trend ?? 2)) * (em.growthEffect ?? 0.03);
  if (ec.crisis) p -= em.crisisPenalty ?? 0.1;
  p -= Math.max(0, ec.inflation - (ed.inflationTarget ?? 2) - 1.5) * (em.inflationPenalty ?? 0.03);
  const atWar = Object.values(state.world.pairs).some((x) => (x.a === e.nation || x.b === e.nation) && x.level >= 3);
  if (atWar) p += em.rallyBonus ?? 0.05;
  p += ns.incumbentMod || 0;
  p = (e.base ?? 0.5) + p * k;
  return clamp(p, em.min ?? 0.04, em.max ?? 0.98);
}

function resolveElection(state, data, e, rng) {
  const w = state.world;
  const nd = nationDef(data, e.nation);
  const ns = w.nations[e.nation];
  e.done = true;
  if (!nd || !ns) return;
  const gov = ns.government;
  const before = { ...gov };
  const pNation = nationOf(state, state.playerId);
  const mine = pNation === e.nation;
  const imp = mine ? 3 : e.weight >= 0.8 ? 2 : 1;
  const force = e.weight >= 0.5 || mine;
  const other = (fid) => (nd.factions || []).find((f) => f.id !== fid)?.id || fid;
  let result = 'continuity';
  let key;
  const vars = { ...ev(e), ...legVars(nd) };

  if (e.kind === 'budget_summit') {
    const stance = state.politics[leadActor(state, data, e.nation)]?.stance ?? 0.3;
    const pct = clamp(0.03 + (stance - 0.3) * 0.1 + (ns.econ.growth - (nd.economy?.trend ?? 1)) * 0.01 + rng.normal(0, 0.04), -0.12, 0.15);
    ns.pendingBudgetPct = r3(pct);
    result = pct >= 0 ? 'increase' : 'cut';
    pnews(state, data, pct >= 0 ? 'budget_summit_up' : 'budget_summit_down', { ...vars, pct: fmtPct(Math.abs(pct), false) }, { importance: imp, force: true, tags: ['election', 'budget'] });
  } else if (e.kind === 'member') {
    const good = rng.chance(0.5 + (ns.econ.crisis ? -0.1 : 0.05));
    const d = (good ? 1 : -1) * (e.stanceSwing ?? 0.06);
    for (const id of agenciesOf(state, data, e.nation)) {
      const p = state.politics[id];
      if (p) p.offset = r3((p.offset || 0) + d * 2);
    }
    w.nations[e.nation].memberShift = r3((w.nations[e.nation].memberShift || 0) + d);
    result = good ? 'favorable' : 'unfavorable';
    pnews(state, data, good ? 'member_good' : 'member_bad', vars, { importance: imp, force, tags: ['election'] });
  } else {
    const p = incumbentChance(state, data, e);
    const keep = rng.chance(p);
    if (e.kind === 'legislative') {
      const holder = gov.exec; // governing party defends the chamber
      gov.legis = keep ? holder : other(holder);
      result = gov.legis !== before.legis ? 'change' : 'continuity';
      key = keep ? 'legislative_hold' : 'legislative_flip';
      Object.assign(vars, partyVars(factionDef(nd, gov.legis)));
    } else {
      // executive / congress / snap: executive changes hands (parliamentary systems take the chamber too)
      if (!keep) gov.exec = other(gov.exec);
      if (nd.system !== 'presidential') gov.legis = gov.exec;
      result = gov.exec !== before.exec ? 'change' : 'continuity';
      const party = factionDef(nd, gov.exec);
      Object.assign(vars, partyVars(party));
      vars.priority = priorityLabel(data, party?.priority);
      key = e.kind === 'congress' ? (result === 'change' ? 'congress_change' : 'congress_continuity') : result === 'change' ? 'election_change' : 'election_continuity';
    }
    ns.incumbentMod = 0;
    refreshGovernment(state, data, e.nation);
    pnews(state, data, key, vars, { importance: imp, force, tags: ['election'], actors: agenciesOf(state, data, e.nation) });
    // a new executive with a different priority asks the player's agency to revise its program
    if (mine && before.exec !== gov.exec && !isCompany(state, data, state.playerId)) {
      const oldP = factionDef(nd, before.exec)?.priority;
      const newP = factionDef(nd, gov.exec)?.priority;
      if (newP && newP !== oldP) {
        const pr = PD(data).priorities?.[newP] || {};
        const pct = clamp(0.02 + (pr.budgetBias ?? 0), 0.01, 0.05);
        const cb = pr.cultureBias ?? 0;
        offerDecision(state, data, 'program_review', {
          gov: factionDef(nd, gov.exec)?.gov, priority: priorityLabel(data, newP), pct: fmtPct(pct, false), culture: cb >= 0 ? `+${cb}` : `−${Math.abs(cb)}`,
        }, { priority: newP, prev: oldP, pct, culture: cb }, { urgency: 2, force: true });
      }
    }
  }
  e.result = result;
  pushCapped(w.history.elections, { turn: state.turn, id: e.id, nation: e.nation, kind: e.kind, name: e.name, result, exec: gov.exec, legis: gov.legis }, histCap(state, 'elections'));
  state.stats['politics.elections'] = (state.stats['politics.elections'] || 0) + 1;
  emitSignal(state, 'election', { actorId: leadActor(state, data, e.nation), result, nation: e.nation, electionId: e.id, kind: e.kind });
  // player's promise comes due
  const dm = w.demand;
  if (dm && dm.electionId === e.id) settleDemand(state, data, dm.fulfilled);
}

function electionsWeekly(state, data, ctx) {
  const w = state.world;
  const em = PD(data).electionModel || {};
  const dt = dtOf(ctx);
  for (const e of w.elections) {
    if (e.done) continue;
    // the announcement week falls inside this tick's window [turn, turn + dt) (dt = 1: turn === announce week)
    const at = e.turn - (em.announceWeeks ?? 4);
    if (at >= state.turn && at < state.turn + dt && e.weight >= 0.5 && e.kind !== 'budget_summit') {
      pnews(state, data, 'election_upcoming', ev(e), { importance: 1, tags: ['election'] });
    }
    if (state.turn >= e.turn) resolveElection(state, data, e, ctx.rng(`election:${e.id}`));
  }
}

// ---------------------------------------------------------------- companies: funding rounds

function fundingRounds(state, data, ctx) {
  const pd = PD(data);
  const w = state.world;
  for (const [id, m] of Object.entries(w.markets)) {
    if (state.turn < m.nextRoundTurn) continue;
    const a = state.actors?.[id];
    const md = pd.markets?.[id] || {};
    const rng = ctx.rng(`round:${id}`);
    const dm = w.demand && w.demand.actorId === id && w.demand.roundTurn === m.nextRoundTurn ? w.demand : null;
    let pOk = clamp(m.sentiment / 100 + (dm?.fulfilled ? 0.15 : 0) - (m.crisis ? 0.2 : 0), 0.05, 0.95);
    if (md.founderBacked) pOk = clamp(pOk + 0.2, 0.05, 0.97);
    const ok = rng.chance(pOk);
    m.rounds += 1;
    m.nextRoundTurn = state.turn + (md.roundEveryWeeks ?? 52) + rng.int(-6, 6);
    m.demandChecked = false;
    if (a && typeof a.budget === 'number') {
      if (ok) {
        const amount = Math.round(a.budget * rng.range(0.08, 0.22));
        changeActor(state, id, 'cash', amount);
        m.sentiment = r2(clamp(m.sentiment + 4, 5, 95));
        pnews(state, data, md.founderBacked ? 'funding_founder' : 'funding_up', { actor: actorShort(state, id), amount: fmtMoney(amount) }, { importance: id === state.playerId ? 3 : 1, force: id === state.playerId, actors: [id], tags: ['market'] });
      } else {
        budgetDelta(state, id, -0.05, 'rodada fraca');
        changeActor(state, id, 'support', -3);
        m.sentiment = r2(clamp(m.sentiment - 5, 5, 95));
        pnews(state, data, 'funding_down', { actor: actorShort(state, id) }, { importance: id === state.playerId ? 3 : 1, force: id === state.playerId, actors: [id], tags: ['market'] });
      }
    }
    if (dm) settleDemand(state, data, dm.fulfilled);
  }
}

// ---------------------------------------------------------------- annual budgets

/** Budget change (fraction) for an agency this year, with readable reasons. */
function agencyBudgetPct(state, data, id, rng) {
  const pd = PD(data);
  const bm = pd.budgetModel || {};
  const fx = pd.levelEffects || {};
  const p = state.politics[id];
  const nid = p?.nation;
  const nd = nationDef(data, nid);
  const ns = state.world.nations[nid];
  const a = state.actors[id];
  const reasons = [];
  const add = (label, d) => { if (Math.abs(d) >= 0.001) reasons.push({ label, delta: r3(d) }); return d; };
  let pct = add('Correção anual', nd?.economy?.budgetBase ?? 0.02);
  if (ns) {
    pct += add('Economia', (ns.econ.growth - (nd.economy?.trend ?? 2)) * (bm.growthEffect ?? 0.008));
    const c = ns.econ.crisis;
    if (c) pct += add(pd.crises?.[c.type]?.label || 'Crise', pd.crises?.[c.type]?.budgetPct ?? -0.04);
    if (ns.pendingBudgetPct) { pct += add('Conselho Ministerial', ns.pendingBudgetPct); ns.pendingBudgetPct = 0; }
    if (ns.memberShift) { pct += add('Eleições nos países-membros', ns.memberShift * 0.25); ns.memberShift = 0; }
  }
  pct += add('Humor político', ((p?.stance ?? 0.3) - (p?.stanceRef ?? 0.3)) * (bm.stanceEffect ?? 0.1));
  pct += add('Apoio público', (((a?.support ?? 50) - 50) / 50) * (bm.supportEffect ?? 0.03));
  // the player's agency left a quarter of the year's money unspent: the legislature trims next year's raise
  if (id === state.playerId) {
    const y = state.finance?.year;
    const spent = Object.values(y?.spent || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    if (y && a?.budget > 0 && (y.income - spent) / a.budget > (bm.unspentShare ?? 0.25)) pct += add('Verba parada no caixa', bm.unspentPct ?? -0.05);
  }
  const pri = pd.priorities?.[p?.priority];
  if (pri?.budgetBias) pct += add('Prioridade do governo', pri.budgetBias);
  // geopolitics: rivalry funds the race; conflict and war drain it; sanctions hit partnerships
  let race = 0, conflict = 0, war = 0, partner = 0;
  for (const pk of Object.keys(state.world.pairs)) {
    const pr = state.world.pairs[pk];
    if (pr.a !== nid && pr.b !== nid) continue;
    const pdef = (pd.pairs || []).find((x) => relKey(x.a, x.b) === pk);
    if (pdef?.race && (pr.level === 1 || pr.level === 2)) race = fx.raceBonusPct ?? 0.012;
    if (pr.level === 3) conflict += fx.rolloverConflictPct ?? -0.03;
    if (pr.level === 4) war += fx.rolloverWarPct ?? -0.07;
    if (pr.level >= 2) partner += crossPartnerships(state, data, pk).filter(([x, y]) => x === id || y === id).length * (fx.rolloverPartnerPct ?? -0.02);
  }
  pct += add('Corrida espacial', race);
  pct += add('Gastos com conflito', conflict);
  pct += add('Prioridade militar', war);
  pct += add('Parcerias sob sanção', Math.max(-0.06, partner));
  const dm = state.world.pendingPenalty?.[id];
  if (dm) { pct += add('Promessa não cumprida', dm); delete state.world.pendingPenalty[id]; }
  const vol = (nd?.economy?.budgetVolatility ?? 0.03) * (ns?.divided ? bm.dividedVolatility ?? 1.5 : 1);
  pct += add(ns?.divided ? 'Negociação no Legislativo' : 'Negociação política', rng.normal(0, vol));
  // legislatures rarely hand out big raises: good years are damped (cuts are not)
  if (pct > 0) pct *= bm.raiseDamping ?? 1;
  return { pct: clamp(pct, bm.min ?? -0.25, bm.max ?? 0.2), reasons };
}

function companyBudgetPct(state, data, id, rng) {
  const pd = PD(data);
  const md = pd.markets?.[id] || {};
  const m = state.world.markets[id];
  const home = state.world.nations[md.nation]?.econ;
  const reasons = [];
  const add = (label, d) => { if (Math.abs(d) >= 0.001) reasons.push({ label, delta: r3(d) }); return d; };
  let pct = add('Crescimento da receita', (m?.growth ?? 0.05) * 0.5);
  pct += add('Humor dos investidores', (((m?.sentiment ?? 50) - 50) / 50) * (md.budgetSensitivity ?? 0.12));
  if (home) pct += add('Economia dos EUA', (home.growth - 2) * 0.01);
  if (m?.crisis) pct += add('Crise no mercado', pd.crises?.market_crash?.budgetPct ?? -0.1);
  const dm = state.world.pendingPenalty?.[id];
  if (dm) { pct += add('Promessa não cumprida', dm); delete state.world.pendingPenalty[id]; }
  pct += add('Imprevistos', rng.normal(0, 0.035));
  const bm = pd.budgetModel || {};
  return { pct: clamp(pct, bm.min ?? -0.25, bm.companyMax ?? bm.max ?? 0.2), reasons };
}

/** Lineage budget series (data/core/lineages.json) at a year: linear interpolation, flat past the ends. */
function lineageBudget(data, id, year) {
  const raw = data?.lineages;
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.lineages) ? raw.lineages : [];
  const s = (list.find((l) => l?.id === id)?.budgetSeries || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (!s.length) return null;
  if (year <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (year <= s[i][0]) {
      const [y0, v0] = s[i - 1], [y1, v1] = s[i];
      return v0 + (v1 - v0) * ((year - y0) / Math.max(1, y1 - y0));
    }
  }
  return s[s.length - 1][1];
}

/**
 * Keeps a budget near its anchor over a 1050-year campaign: the lineage's budgetSeries for real agencies, the
 * birth budget for generated ones. Inside a dead zone (x0.67..x1.5) the yearly % runs free (a 5-year scenario is
 * not touched); outside it a third of the excess (in log scale) goes back each year, and x0.33..x3 is a hard limit.
 * Without this the yearly % compounds for centuries: some agencies grow without bound while others hit the floor.
 */
function anchorPull(state, data, id, year) {
  const a = state.actors?.[id];
  if (!a || typeof a.budget !== 'number' || !(a.budget > 0)) return;
  // only long campaigns: a short scenario (Corrida Lunar, 5 years) keeps its free-running budgets
  if (!(state.endTurn > (PD(data).budgetModel?.anchorMinWeeks ?? 10 * WEEKS_PER_YEAR))) return;
  const bm = PD(data).budgetModel || {};
  const anchor = lineageBudget(data, id, year) ?? state.world.baseBudget?.[id] ?? null;
  if (!(anchor > 0)) return;
  const lo = bm.anchorLow ?? 0.67, hi = bm.anchorHigh ?? 1.5;
  const r = a.budget / anchor;
  let target = r;
  if (r > hi) target = hi * Math.pow(r / hi, 1 - (bm.anchorPull ?? 0.33));
  else if (r < lo) target = lo * Math.pow(r / lo, 1 - (bm.anchorPull ?? 0.33));
  target = clamp(target, bm.anchorMin ?? 0.33, bm.anchorMax ?? 3);
  if (target === r) return;
  const from = a.budget;
  a.budget = Math.max(1, Math.round(anchor * target * 10) / 10);
  if (a.budget !== from) emitSignal(state, 'budget/changed', { actorId: id, from, to: a.budget, reason: 'orçamento anual' });
}

function annualRollover(state, data, ctx) {
  const pd = PD(data);
  const bm = pd.budgetModel || {};
  const w = state.world;
  const year = ctx.date.year;
  const rng = ctx.rng('rollover');
  const lines = [];
  const changes = [];
  const pid = state.playerId;
  for (const id of Object.keys(state.actors || {})) {
    const a = state.actors[id];
    if (!a || typeof a.budget !== 'number') continue;
    const r = isCompany(state, data, id) ? companyBudgetPct(state, data, id, rng) : state.politics[id]?.kind === 'agency' ? agencyBudgetPct(state, data, id, rng) : { pct: rng.normal(0.02, 0.02), reasons: [] };
    const from = a.budget;
    let pct = r.pct;
    // the player negotiates big cuts instead of taking them silently
    if (id === pid && pct <= (bm.playerCutThreshold ?? -0.035) && openPolitics(state) < 3) {
      const worst = r.reasons.filter((x) => x.delta < 0).sort((x, y) => x.delta - y.delta)[0];
      const amount = from * -pct;
      const chance = clamp(0.35 + ((a.support ?? 50) - 50) / 100 + (state.politics[id]?.stance ?? 0) * 0.2, 0.15, 0.85);
      const nd = nationDef(data, nationOf(state, id));
      const md = pd.markets?.[id];
      const card = offerDecision(state, data, 'budget_cut', {
        year, pct: fmtPct(-pct, false), amount: fmtMoney(amount), third: fmtMoney(amount / 3), chance: `${Math.round(chance * 100)}%`,
        reason: (worst?.label || 'contas apertadas').toLowerCase(), gov: factionDef(nd, w.nations[nationOf(state, id)]?.government.exec)?.gov || 'governo',
        backers: md?.backers ? md.backers[0].toUpperCase() + md.backers.slice(1) : 'Os investidores',
      }, { pct, year, chance, reasons: r.reasons }, { urgency: 3, force: true, expiresWeeks: 6, defaultChoice: 'accept' });
      if (card) {
        pushCapped(w.history.budgets, { turn: state.turn, year, actorId: id, from, to: from, pct: 0, proposed: r3(pct) }, histCap(state, 'budgets'));
        lines.push(`${actorShort(state, id)}: corte de ${fmtPct(-pct, false)} em negociação`);
        continue;
      }
    }
    budgetDelta(state, id, pct, 'orçamento anual');
    anchorPull(state, data, id, year);
    const to = a.budget;
    const real = from ? to / from - 1 : 0;
    changes.push({ id, real });
    pushCapped(w.history.budgets, { turn: state.turn, year, actorId: id, from: r2(from), to: r2(to), pct: r3(real) }, histCap(state, 'budgets'));
    lines.push(`${actorShort(state, id)}: ${fmtMoney(from)} → ${fmtMoney(to)} (${fmtPct(real)})`);
    if (id === pid) {
      const top = r.reasons.slice().sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 4).map((x) => `${x.label} ${fmtPct(x.delta)}`).join(' · ');
      pnews(state, data, real >= 0 ? 'budget_player_up' : 'budget_player_down', { actor: actorShort(state, id), amount: fmtMoney(to), year, pct: fmtPct(real) }, { importance: 3, force: true, actors: [id], tags: ['budget'], body: top ? `Principais fatores: ${top}.` : '' });
    }
  }
  if (changes.length) {
    const sorted = changes.slice().sort((x, y) => y.real - x.real);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    const summary = best.id === worst.id ? `${actorShort(state, best.id)} ${fmtPct(best.real)}`
      : `maior alta para ${actorShort(state, best.id)} (${fmtPct(best.real)}), ${worst.real < 0 ? 'maior corte' : 'menor alta'} para ${actorShort(state, worst.id)} (${fmtPct(worst.real)})`;
    pnews(state, data, 'budget_digest', { year, summary }, { importance: 2, force: true, tags: ['budget'], body: lines.join('\n') });
  }
}

// ---------------------------------------------------------------- signals (missions, firsts, treaties)

function processSignals(state, data, ctx) {
  const w = state.world;
  const pid = state.playerId;
  for (const s of state.signals || []) {
    if (!s || !s.type) continue;
    // defensive: core emitSignal spreads the payload after 'type', so a payload field 'type' (mission type) can mask it
    const isMission = s.type === 'mission/resolved' || (s.outcome != null && 'crewed' in s && s.phase !== undefined);
    if (isMission && s.actorId) {
      const score = OUTCOME_SCORE[s.outcome] ?? 0;
      const crewed = !!s.crewed;
      const p = state.politics[s.actorId];
      if (p?.kind === 'agency') p.offset = r3((p.offset || 0) + score * (crewed ? 0.06 : 0.035));
      const m = w.markets[s.actorId];
      // investors price in a streak: each extra success moves sentiment less once it is already high
      const room = score > 0 ? clamp((95 - m?.sentiment) / 45, 0.1, 1) : 1;
      if (m) m.sentiment = r2(clamp(m.sentiment + score * (crewed ? 7 : 4) * room, 5, 95));
      if (s.actorId === pid && w.demand && !w.demand.fulfilled && score > 0) {
        const t = w.demand.type;
        const lunar = String(s.destination || '').includes('lunar') || s.destination === 'cislunar';
        if (t === 'any_success' || (t === 'crewed_success' && crewed) || (t === 'lunar_success' && lunar)) w.demand.fulfilled = true;
      }
      const bad = s.outcome === 'catastrophic' || (crewed && s.outcome === 'recoverable');
      if (s.actorId === pid && bad && s.phase !== 'scrub') maybeHearing(state, data, s.missionId || s.calendarId);
    } else if (s.type === 'crew/died') {
      const owner = state.crew?.[s.crewId]?.actorId;
      if (owner === pid) maybeHearing(state, data, s.missionId);
      const p = state.politics[owner];
      if (p?.kind === 'agency') p.offset = r3((p.offset || 0) - 0.04);
    } else if (s.type === 'crew/rivalLost' && s.actorId) {
      // a rival's background crewed flight lost its crew (crew.js): the government behind it wavers
      const p = state.politics[s.actorId];
      if (p?.kind === 'agency') p.offset = r3((p.offset || 0) - 0.04);
      if (w.markets[s.operator]) w.markets[s.operator].sentiment = r2(clamp(w.markets[s.operator].sentiment - 8, 5, 95));
    } else if (s.type === 'first' && s.actorId) {
      const nid = nationOf(state, s.actorId);
      const p = state.politics[s.actorId];
      if (p?.kind === 'agency') p.offset = r3((p.offset || 0) + 0.06);
      if (w.markets[s.actorId]) w.markets[s.actorId].sentiment = r2(clamp(w.markets[s.actorId].sentiment + 6, 5, 95));
      if (s.actorId === pid && w.demand && !w.demand.fulfilled) w.demand.fulfilled = true;
      // "Sputnik moment": rivals in tension with the achiever push their own programs
      if (nid) for (const pr of Object.values(w.pairs)) {
        if (pr.level < 1 || (pr.a !== nid && pr.b !== nid)) continue;
        const rival = pr.a === nid ? pr.b : pr.a;
        for (const id of agenciesOf(state, data, rival)) {
          const rp = state.politics[id];
          if (rp) rp.offset = r3((rp.offset || 0) + 0.03 * pr.level);
        }
        if (nationOf(state, pid) === rival) pnews(state, data, 'sputnik_moment', { ...nv(data, rival, 'N'), rival: actorShort(state, s.actorId) }, { importance: 2, tags: ['race'] });
      }
    } else if (s.type === 'diplomacy/blocChanged') {
      if (!state.geo?.zones) initGeo(state, data);
      recordAgencyBlocChange(state, data, s);
    } else if (s.type === 'treaty/broken' || s.type === 'treaty/signed') {
      const t = (state.treaties || []).find((x) => x.id === s.treatyId);
      const parties = t?.parties || [];
      const dp = s.type === 'treaty/broken' ? 0.3 : -0.15;
      const seen = new Set();
      for (const x of parties) for (const y of parties) {
        const nx = nationOf(state, x), ny = nationOf(state, y);
        if (!nx || !ny || nx === ny) continue;
        const k = relKey(nx, ny);
        if (seen.has(k) || !w.pairs[k]) continue;
        if (s.type === 'treaty/broken' && s.by && nationOf(state, s.by) !== nx && nationOf(state, s.by) !== ny) continue;
        seen.add(k);
        w.pairs[k].pressure = r3(w.pairs[k].pressure + dp);
      }
    }
  }
}

function maybeHearing(state, data, missionId) {
  const w = state.world;
  if ((w.cooldowns.hearing ?? -1) > state.turn) return;
  w.cooldowns.hearing = state.turn + 20;
  const pid = state.playerId;
  const nd = nationDef(data, nationOf(state, pid));
  const mission = (state.missions || []).find((m) => m.id === missionId)?.name || data?.index?.calendar?.[missionId]?.name || 'uma missão recente';
  const bf = forms(nd?.hearingBody || 'Parlamento', nd?.hearingBodyArt || 'o');
  const bv = { body: bf.the, Body: capFirst(bf.the), inBody: bf.in };
  offerDecision(state, data, 'hearing', { mission, ...bv }, { missionId: missionId || null }, { urgency: 2, force: true });
  pnews(state, data, 'hearing_news', { ...bv, actor: actorShort(state, pid) }, { importance: 2, actors: [pid] });
}

// ---------------------------------------------------------------- player promises (election / funding round)

function demandWeekly(state, data, ctx) {
  const pd = PD(data);
  const dmod = pd.demandModel || {};
  const w = state.world;
  const pid = state.playerId;
  if (!pid || !state.actors?.[pid]) return;
  if (w.demand) {
    if (state.turn > (w.demand.deadlineTurn ?? Infinity) + 1) settleDemand(state, data, w.demand.fulfilled);
    return;
  }
  const lead = dmod.leadWeeks ?? 22;
  const minW = dmod.minWeeks ?? 8;
  const caps = state.actors[pid].capabilities || {};
  const rng = ctx.rng('demand');
  const goalType = () => {
    const opts = caps.crewed ? ['crewed_success', 'lunar_success', 'any_success'] : ['lunar_success', 'any_success', 'first'];
    return rng.pick(opts);
  };
  const company = isCompany(state, data, pid);
  if (company) {
    const m = w.markets[pid];
    if (!m || m.demandChecked) return;
    const weeks = m.nextRoundTurn - state.turn;
    if (weeks > lead || weeks < minW) return;
    m.demandChecked = true;
    if (!rng.chance((dmod.chance ?? 0.75) * 0.8) || openPolitics(state) >= 2) return;
    const md = pd.markets?.[pid] || {};
    const type = goalType();
    const pct = rng.range(...(dmod.rewardPct || [0.02, 0.04]));
    offerDecision(state, data, 'election_demand', {
      weeks, goal: pd.goals?.[type], pct: fmtPct(pct, false), backers: md.backers ? md.backers[0].toUpperCase() + md.backers.slice(1) : 'Os investidores',
    }, { type, pct, deadlineTurn: m.nextRoundTurn, roundTurn: m.nextRoundTurn, electionName: 'rodada de investimento', electionArt: 'a' }, { urgency: 2, variant: 'company' });
    return;
  }
  const nid = nationOf(state, pid);
  const e = w.elections.find((x) => !x.done && !x.demandChecked && x.nation === nid && (x.kind === 'executive' || x.kind === 'legislative') && x.weight >= 0.5 && x.turn - state.turn <= lead);
  if (!e) return;
  const weeks = e.turn - state.turn;
  e.demandChecked = true;
  if (weeks < minW) return;
  const stance = state.politics[pid]?.stance ?? 0.3;
  if (!rng.chance(clamp((dmod.chance ?? 0.75) + stance * 0.2, 0.2, 0.95)) || openPolitics(state) >= 2) return;
  const nd = nationDef(data, nid);
  const type = goalType();
  const pct = rng.range(...(dmod.rewardPct || [0.02, 0.04]));
  offerDecision(state, data, 'election_demand', {
    weeks, election: ev(e).election, goal: pd.goals?.[type], pct: fmtPct(pct, false), gov: factionDef(nd, w.nations[nid].government.exec)?.gov || 'governo',
  }, { type, pct, deadlineTurn: e.turn, electionId: e.id, electionName: e.name, electionArt: e.art || 'a' }, { urgency: 2, variant: 'agency' });
}

function settleDemand(state, data, ok) {
  const pd = PD(data);
  const dmod = pd.demandModel || {};
  const w = state.world;
  const dm = w.demand;
  if (!dm) return;
  w.demand = null;
  const id = dm.actorId;
  const p = state.politics[id];
  const vars = { actor: actorShort(state, id), ...ev({ name: dm.electionName, art: dm.electionArt || 'a' }) };
  if (ok) {
    changeActor(state, id, 'support', dmod.okSupport ?? 6);
    if (p) p.offset = r3((p.offset || 0) + (dmod.okStance ?? 0.06));
    pnews(state, data, 'demand_fulfilled', vars, { importance: 3, force: true, actors: [id] });
  } else {
    changeActor(state, id, 'support', dmod.failSupport ?? -7);
    if (p) p.offset = r3((p.offset || 0) + (dmod.failStance ?? -0.1));
    w.pendingPenalty = w.pendingPenalty || {};
    w.pendingPenalty[id] = (w.pendingPenalty[id] || 0) + (dmod.failBudgetPct ?? -0.04);
    pnews(state, data, 'demand_failed', vars, { importance: 3, force: true, actors: [id] });
  }
}

// ---------------------------------------------------------------- decisions

function openPolitics(state) {
  return (state.decisions || []).filter((d) => String(d.kind).startsWith('politics/')).length;
}

/** Push a 'politics/<kind>' card using data texts. Caps open political cards at 2 (3 when forced). */
function offerDecision(state, data, kind, vars, payload, opts = {}) {
  const pid = state.playerId;
  if (!pid || !state.actors?.[pid]) return null;
  if (openPolitics(state) >= (opts.force ? 3 : 2)) return null;
  if ((state.decisions || []).some((d) => d.kind === `politics/${kind}`)) return null;
  const pd = PD(data);
  const texts = pd.decisions?.[kind] || {};
  const variant = opts.variant || (isCompany(state, data, pid) ? 'company' : 'agency');
  const t = texts[variant] || texts.agency;
  if (!t) return null;
  const choices = (t.choices || []).map((c) => ({ id: c.id, label: fill(c.label, vars), preview: fill(c.preview, vars) }));
  state.stats['politics.decisions'] = (state.stats['politics.decisions'] || 0) + 1;
  return pushDecision(state, {
    kind: `politics/${kind}`,
    title: capFirst(fill(t.title, vars)),
    body: capFirst(fill(t.body, vars)),
    portrait: { actorId: pid },
    choices,
    urgency: opts.urgency ?? 2,
    blocking: false,
    expiresTurn: state.turn + (opts.expiresWeeks ?? 8),
    defaultChoice: opts.defaultChoice ?? choices[0]?.id,
    payload: { ...payload, variant },
  });
}

const HANDLERS = {
  election_demand(state, data, d, choice) {
    const pid = state.playerId;
    const pl = d.payload || {};
    if (choice === 'accept') {
      budgetDelta(state, pid, pl.pct ?? 0.03, 'promessa eleitoral');
      changeActor(state, pid, 'support', 2);
      state.world.demand = { actorId: pid, type: pl.type, deadlineTurn: pl.deadlineTurn, electionId: pl.electionId || null, roundTurn: pl.roundTurn ?? null, electionName: pl.electionName, electionArt: pl.electionArt || 'a', fulfilled: false, sinceTurn: state.turn };
      return { message: 'Promessa feita. O relógio corre até a votação.' };
    }
    changeActor(state, pid, 'support', -3);
    const p = state.politics[pid];
    if (p) p.offset = r3((p.offset || 0) - 0.04);
    return { message: 'Sem promessas. O governo não gostou.' };
  },
  budget_cut(state, data, d, choice, ctx) {
    const pid = state.playerId;
    const pl = d.payload || {};
    const pct = pl.pct ?? -0.05;
    let applied = pct;
    let message;
    if (choice === 'negotiate') {
      const ok = ctx.rng(`negotiate:${d.id}`).chance(pl.chance ?? 0.4);
      if (ok) { applied = pct / 2; message = 'Negociação bem-sucedida: o corte caiu pela metade.'; }
      else { changeActor(state, pid, 'support', -2); message = 'A negociação fracassou: corte integral.'; }
    } else if (choice === 'fight') {
      applied = pct / 3;
      changeActor(state, pid, 'support', -6);
      const p = state.politics[pid];
      if (p) p.offset = r3((p.offset || 0) - 0.08);
      message = 'A briga pública reduziu o corte, mas custou caro politicamente.';
    } else {
      changeActor(state, pid, 'support', 2);
      message = 'Corte aceito.';
    }
    const from = state.actors[pid]?.budget ?? 0;
    budgetDelta(state, pid, applied, 'corte negociado');
    const to = state.actors[pid]?.budget ?? 0;
    pushCapped(state.world.history.budgets, { turn: state.turn, year: pl.year, actorId: pid, from: r2(from), to: r2(to), pct: r3(from ? to / from - 1 : 0), negotiated: choice }, histCap(state, 'budgets'));
    pnews(state, data, 'budget_player_down', { actor: actorShort(state, pid), amount: fmtMoney(to), year: pl.year, pct: fmtPct(from ? to / from - 1 : 0) }, { importance: 2, force: true, actors: [pid], tags: ['budget'], body: message });
    return { message };
  },
  hearing(state, data, d, choice) {
    const pid = state.playerId;
    if (choice === 'own') { changeActor(state, pid, 'reputation', 4); changeActor(state, pid, 'support', -3); }
    else if (choice === 'review') { changeActor(state, pid, 'reputation', 2); changeActor(state, pid, 'support', -1); changeActor(state, pid, 'culture', -5); }
    else { changeActor(state, pid, 'support', 2); changeActor(state, pid, 'reputation', -6); }
    return {};
  },
  program_review(state, data, d, choice) {
    const pid = state.playerId;
    const pl = d.payload || {};
    if (choice === 'align') {
      budgetDelta(state, pid, pl.pct ?? 0.02, 'revisão de programa');
      changeActor(state, pid, 'support', 3);
      if (pl.culture) changeActor(state, pid, 'culture', pl.culture);
    } else if (choice === 'compromise') {
      budgetDelta(state, pid, 0.01, 'revisão de programa');
      changeActor(state, pid, 'support', 1);
    } else {
      changeActor(state, pid, 'support', -4);
      changeActor(state, pid, 'reputation', 2);
    }
    emitSignal(state, 'politics/program_review', { actorId: pid, priority: pl.priority, choice });
    return {};
  },
  partnership_freeze(state, data, d, choice) {
    const pid = state.playerId;
    const pl = d.payload || {};
    if (choice === 'shield') {
      const a = state.actors[pid];
      if (a?.budget) budgetDelta(state, pid, (pl.lost || 0) / 2 / a.budget, 'parceria protegida');
      changeActor(state, pid, 'support', -3);
      changeActor(state, pid, 'reputation', 2);
    } else {
      changeActor(state, pid, 'support', 1);
      changeActor(state, pid, 'reputation', -2);
    }
    return {};
  },
  suspension(state, data, d, choice, ctx) {
    const pid = state.playerId;
    const pl = d.payload || {};
    if (choice === 'appeal') {
      const ok = ctx.rng(`appeal:${d.id}`).chance(pl.chance ?? 0.4);
      if (ok) {
        changeActor(state, pid, 'reputation', 4);
        const a = state.actors[pid];
        if (pl.lost && a?.budget) budgetDelta(state, pid, pl.lost / 2 / a.budget, 'programa civil preservado');
        return { message: 'O programa civil foi parcialmente preservado.' };
      }
      changeActor(state, pid, 'support', -8);
      return { message: 'O apelo foi rejeitado e o governo ficou irritado.' };
    }
    changeActor(state, pid, 'support', pl.partner ? 3 : 4);
    changeActor(state, pid, 'reputation', -2);
    return {};
  },
};

export const decisionHandlers = {
  'politics/*': (state, data, d, choiceId, ctx) => {
    DATA = data || DATA;
    const kind = String(d.kind).split('/')[1];
    const h = HANDLERS[kind];
    if (!h) { log(state, `politics: decisão desconhecida ${d.kind}`); return {}; }
    return h(state, data, d, choiceId, ctx) || {};
  },
};

// ---------------------------------------------------------------- geopolitics (world map: zones, conflicts)
//
// Slice `state.geo` (owner: politics): the map state of real disputed / conflict-affected zones
// (data/geopolitics.json). Nothing is scripted: zones only change from turn 0 on, driven by the tension scale.
// - A nation pair reaching level 3 (world.conflicts) opens a geo conflict on the zones mapped to its `place`
//   (or an incident area from `placeAreas`); when the pair drops below 3 the zones go to ceasefire.
// - Conflicts already under way in the data (e.g. Russia–Ukraine) follow their `drivers` pairs: intensity, ceasefire,
//   treaty, resumption.
// - While a conflict runs, a `shiftable` zone may change controller (low monthly hazard by intensity, scaled by the
//   relative strength of the sides: economy, crisis, government). Capped by model.maxShifts per campaign.

const GD = (data) => (data || DATA)?.geopolitics || {};
const GEO_STATUS = ['stable', 'contested', 'conflict', 'ceasefire'];
const jsonCopy = (x) => JSON.parse(JSON.stringify(x));

function geoTurn(data, spec, startYear) {
  if (!spec?.year) return null;
  const mb = GD(data).monthBase ?? 1;
  return dateToTurn(spec.year, clamp((spec.month ?? mb) - mb, 0, 11), startYear);
}
const zoneDef = (data, id) => (GD(data).zones || []).find((z) => z.id === id) || null;
const factDef = (data, id) => (GD(data).conflicts || []).find((c) => c.id === id) || null;
const zonePairs = (zd) => (zd?.pairs || []).filter((p) => Array.isArray(p) && p.length === 2).map(([a, b]) => relKey(a, b));
function countryForms(data, iso) {
  const c = GD(data).countries?.[iso];
  return forms(c?.name || GD(data).countryNames?.[iso] || iso, c ? c.art : null);
}
function zoneVars(data, zd) {
  const f = forms(zd?.name || '', zd?.art || null);
  return { zone: zd?.name || '', Zone: capFirst(f.the), oZone: f.the, deZone: f.of, emZone: f.in };
}
function isoVars(data, iso, K) {
  const f = countryForms(data, iso);
  return { [K]: GD(data).countries?.[iso]?.name || iso, ['o' + K]: f.the, ['O' + K]: capFirst(f.the), ['de' + K]: f.of };
}

export function initGeo(state, data) {
  const G = GD(data);
  const geo = { zones: {}, conflicts: [], events: [], shifts: 0, blocChanges: [], blocNextTurn: null };
  state.geo = geo;
  activateGeoFacts(state, data, 0);
  return geo;
}

/**
 * The geopolitics facts are dated (data/geopolitics.json, as of 2026). A zone or a conflict whose `since` is after
 * the current turn does not exist yet (a 1950 campaign has no Kosovo and no Russia–Ukraine war): it is added when
 * its date arrives, a conflict only if its nations exist in that world. Zones that join later start contested,
 * not at war. A Corrida Lunar start (2026) gets every fact at turn 0, as before.
 */
function activateGeoFacts(state, data, turn) {
  const G = GD(data);
  const geo = state.geo;
  geo.factsDone = geo.factsDone || [];
  const done = new Set(geo.factsDone);
  for (const zd of G.zones || []) {
    if (!zd?.id || geo.zones[zd.id] || !Array.isArray(zd.claimants) || !zd.claimants.length) continue;
    const since = geoTurn(data, zd.since, state.startYear) ?? 0;
    if (since > turn) continue;
    const late = turn > 0;
    const controller = zd.claimants.includes(zd.controller) ? zd.controller : zd.claimants[0];
    const st = GEO_STATUS.includes(zd.status) ? zd.status : 'contested';
    geo.zones[zd.id] = {
      controller, status: late && st === 'conflict' ? 'contested' : st,
      since: late ? turn : since, conflictId: null, changedTurn: null, history: [],
    };
  }
  const nationIds = state.world?.nations ? new Set(Object.keys(state.world.nations)) : null;
  for (const f of G.conflicts || []) {
    if (!f?.id || done.has(f.id) || geo.conflicts.some((g) => g.id === f.id)) continue;
    const startTurn = geoTurn(data, f.since, state.startYear) ?? 0;
    if (startTurn > turn) continue;
    const nations = Object.keys(f.sides || {});
    geo.factsDone.push(f.id); // decided once: a fact whose nations do not exist in this world never happens
    if (nationIds && nations.some((n) => !nationIds.has(n))) continue;
    const zoneIds = (f.zoneIds || []).filter((id) => geo.zones[id]);
    const lv = clamp(f.intensity ?? 3, 1, 4);
    const g = {
      id: f.id, def: f.id, fact: true, src: null, pair: null, name: f.name || null, place: f.place || '', parties: [...(f.parties || [])],
      nations, zoneIds, area: null, startTurn: turn > 0 ? turn : startTurn, endTurn: null,
      intensity: lv, peak: lv, endCause: null, settled: false, shifted: [],
    };
    for (const id of zoneIds) { geo.zones[id].status = 'conflict'; geo.zones[id].conflictId = g.id; }
    geo.conflicts.push(g);
  }
}

function geoEvent(state, data, ev) {
  pushCapped(state.geo.events, { turn: state.turn, ...ev }, (Number.isFinite(state.endTurn) && state.endTurn > 10 * WEEKS_PER_YEAR ? 40 : GD(data).model?.eventsCap ?? 80));
}

function setZone(state, data, zoneId, field, to, cause) {
  const z = state.geo.zones[zoneId];
  if (!z || z[field] === to) return false;
  const from = z[field];
  z[field] = to;
  z.since = state.turn;
  pushCapped(z.history, { turn: state.turn, field, from, to, cause }, Number.isFinite(state.endTurn) && state.endTurn > 10 * WEEKS_PER_YEAR ? 6 : GD(data).model?.historyCap ?? 20);
  return true;
}

function activeGeoConflictOf(state, zoneId) {
  return (state.geo.conflicts || []).find((g) => g.endTurn == null && g.zoneIds.includes(zoneId)) || null;
}

function driverLevel(state, pairs) {
  let lv = 0;
  for (const k of pairs) lv = Math.max(lv, state.world.pairs?.[k]?.level ?? 0);
  return lv;
}
function conflictDrivers(data, g) {
  if (g.fact) return (factDef(data, g.def)?.drivers || []).map(([a, b]) => relKey(a, b));
  return g.pair ? [g.pair] : [];
}

/** Relative strength of a nation for the (rare) control shift: economy weight, growth, crisis, government posture. */
function geoStrength(state, data, nid) {
  const nd = nationDef(data, nid);
  const ns = state.world.nations?.[nid];
  if (!nd || !ns) return 0.3;
  const w = nd.economy?.weight ?? 0.5;
  const g = clamp(ns.econ?.growth ?? 2, -6, 10);
  const hawk = factionDef(nd, ns.government?.exec)?.hawk ?? 0.5;
  return w * (1 + g / 20) * (ns.econ?.crisis ? 0.75 : 1) * (0.8 + hawk * 0.4);
}

function conflictPlaceVars(data, g) {
  const names = g.fact ? g.parties.map((iso) => GD(data).countries?.[iso]?.name || iso) : (g.nations || []).map((n) => nationName(data, n));
  return { place: g.place || '', A: names[0] || '', B: names[1] || '' };
}

function openPairConflict(state, data, c) {
  const G = GD(data);
  const pk = c.pair;
  const mapped = (G.zones || []).filter((zd) => state.geo.zones[zd.id] && zonePairs(zd).includes(pk) && (zd.places || []).includes(c.place)).map((zd) => zd.id);
  const zoneIds = mapped.filter((id) => !activeGeoConflictOf(state, id));
  if (mapped.length && !zoneIds.length) {
    // the place is already at war (e.g. a fact conflict): the pair joins it, no second conflict on the map
    const host = activeGeoConflictOf(state, mapped[0]);
    state.geo.conflicts.push({ id: `geo_${c.id}`, src: c.id, pair: pk, joined: host?.id || null, fact: false, nations: [...(c.nations || [])], parties: [], zoneIds: [], area: null, place: c.place || '', startTurn: state.turn, endTurn: null, intensity: clamp(c.level ?? 3, 1, 4), peak: clamp(c.level ?? 3, 1, 4), endCause: null, settled: false, shifted: [] });
    return null;
  }
  const ar = zoneIds.length ? null : G.placeAreas?.[c.place] || null;
  const parties = [];
  for (const n of c.nations || []) { const iso = G.nationPrimary?.[n]; if (iso && !parties.includes(iso)) parties.push(iso); }
  for (const id of zoneIds) for (const n of c.nations || []) {
    const iso = zoneDef(data, id)?.sides?.[n];
    if (iso && !parties.includes(iso)) parties.push(iso);
  }
  const lv = clamp(c.level ?? 3, 1, 4);
  const g = {
    id: `geo_${c.id}`, def: null, fact: false, src: c.id, pair: pk, name: null, place: c.place || '', parties, nations: [...(c.nations || [])],
    zoneIds, area: ar ? { name: ar.name, lat: ar.lat, lon: ar.lon, radiusKm: ar.radiusKm } : null,
    startTurn: state.turn, endTurn: null, intensity: lv, peak: lv, endCause: null, settled: false, shifted: [],
  };
  state.geo.conflicts.push(g);
  for (const id of zoneIds) {
    setZone(state, data, id, 'status', 'conflict', 'conflito');
    state.geo.zones[id].conflictId = g.id;
  }
  const vars = conflictPlaceVars(data, g);
  geoEvent(state, data, { kind: 'conflict_start', conflictId: g.id, zoneIds, text: capFirst(fill(G.timeline?.[g.place ? 'conflict_start' : 'conflict_start_noplace'] || 'Conflito {place}', vars)) });
  state.stats['politics.geoConflicts'] = (state.stats['politics.geoConflicts'] || 0) + 1;
  log(state, `politics/geo: conflito ${g.id} em ${zoneIds.join(',') || g.area?.name || 'área sem zona'}`);
  return g;
}

function endGeoConflict(state, data, g, cause, { news = false } = {}) {
  const G = GD(data);
  g.endTurn = state.turn;
  g.endCause = cause;
  if (g.joined) { g.settled = true; return; }
  for (const id of g.zoneIds) {
    const z = state.geo.zones[id];
    if (z?.conflictId === g.id && z.status === 'conflict') setZone(state, data, id, 'status', 'ceasefire', cause === 'ceasefire' ? 'cessar-fogo' : cause);
  }
  const vars = conflictPlaceVars(data, g);
  geoEvent(state, data, { kind: 'ceasefire', conflictId: g.id, zoneIds: g.zoneIds, text: capFirst(fill(G.timeline?.ceasefire || 'Cessar-fogo {place}', vars)) });
  if (news) pnews(state, data, 'geo:fact_ceasefire', vars, { headlines: G.news?.fact_ceasefire, tplKey: 'geo:fact_ceasefire', importance: 3, force: true, tags: ['conflict', 'geo'] });
}

function settleConflict(state, data, g, rng) {
  const G = GD(data);
  const M = G.model || {};
  const zones = g.zoneIds.filter((id) => state.geo.zones[id]?.conflictId === g.id && state.geo.zones[id]?.status === 'ceasefire');
  if (!zones.length && g.zoneIds.length) { g.settled = true; return; }
  const lvl = driverLevel(state, conflictDrivers(data, g));
  const vars = conflictPlaceVars(data, g);
  // fact conflicts resume from the state of their drivers (pair conflicts resume through the tension scale itself)
  if (g.fact && rng.chance((M.resumeChance || [])[lvl] ?? 0)) {
    g.settled = true;
    const f = factDef(data, g.def) || {};
    const ng = {
      ...jsonCopy(g), id: `${g.def}_${state.turn}`, startTurn: state.turn, endTurn: null, endCause: null, settled: false, shifted: [],
      zoneIds: zones, intensity: clamp(lvl + 1, 2, 4), peak: clamp(lvl + 1, 2, 4), name: f.name || g.name,
    };
    state.geo.conflicts.push(ng);
    for (const id of zones) { setZone(state, data, id, 'status', 'conflict', 'retomada'); state.geo.zones[id].conflictId = ng.id; }
    geoEvent(state, data, { kind: 'resumed', conflictId: ng.id, zoneIds: zones, text: capFirst(fill(G.timeline?.resumed || 'Hostilidades retomadas {place}', vars)) });
    pnews(state, data, 'geo:resumed', vars, { headlines: G.news?.resumed, tplKey: 'geo:resumed', importance: 3, force: true, tags: ['conflict', 'geo'] });
    return;
  }
  if (!zones.length) { g.settled = true; return; } // incident areas without zones: nothing to sign
  if (state.turn - g.endTurn < (M.treatyMinWeeks ?? 26)) return;
  if (!rng.chance((M.treatyChance || [])[lvl] ?? 0)) return;
  g.settled = true;
  g.endCause = 'treaty';
  for (const id of zones) setZone(state, data, id, 'status', 'stable', 'acordo');
  geoEvent(state, data, { kind: 'treaty', conflictId: g.id, zoneIds: zones, text: capFirst(fill(G.timeline?.treaty || 'Acordo de paz {place}', vars)) });
  pnews(state, data, 'geo:treaty', vars, { headlines: G.news?.treaty, tplKey: 'geo:treaty', importance: 3, force: true, tags: ['conflict', 'geo'] });
}

function tryShift(state, data, g, zoneId, rng) {
  const G = GD(data);
  const M = G.model || {};
  const zd = zoneDef(data, zoneId);
  const z = state.geo.zones[zoneId];
  if (!zd || !z || !zd.shiftable || g.intensity < zd.shiftable || g.shifted.includes(zoneId)) return;
  if (state.geo.shifts >= (M.maxShifts ?? 3)) return;
  if (state.turn - Math.max(0, g.startTurn) < (M.minConflictWeeks ?? 12)) return;
  const f = g.fact ? factDef(data, g.def) : null;
  const sides = f?.sides || zd.sides || {};
  const sw = f?.sideWeights || {};
  const nats = (g.nations || []).filter((n) => sides[n]);
  const holders = nats.filter((n) => sides[n] === z.controller);
  const others = nats.filter((n) => sides[n] !== z.controller && zd.claimants.includes(sides[n]));
  if (!others.length) return;
  const sOf = (list) => list.reduce((s, n) => s + geoStrength(state, data, n) * (sw[n] ?? 1), 0);
  // the strongest challenger decides who would take over
  const lead = others.slice().sort((a, b) => sOf([b]) - sOf([a]))[0];
  const target = sides[lead];
  const sO = sOf(others.filter((n) => sides[n] === target));
  const sH = sOf(holders) || 0.3;
  const [lo, hi] = M.ratioClamp || [0.4, 1.6];
  // shiftBias: direction weight per new controller (retaking fortified ground is rarer than a slow advance)
  const p = (M.shiftHazard?.[g.intensity] ?? 0) * clamp(sO / sH, lo, hi) * (zd.shiftWeight ?? 1) * (zd.shiftBias?.[target] ?? 1);
  if (!rng.chance(p)) return;
  const from = z.controller;
  setZone(state, data, zoneId, 'controller', target, 'conflito');
  z.changedTurn = state.turn;
  g.shifted.push(zoneId);
  state.geo.shifts += 1;
  state.stats['politics.geoShifts'] = (state.stats['politics.geoShifts'] || 0) + 1;
  // the side that lost ground pushes the pair tension up a little (pressure, not a script)
  for (const k of conflictDrivers(data, g)) {
    const pr = state.world.pairs?.[k];
    if (pr) pr.pressure = r3(pr.pressure + (M.shiftPressure ?? 0.3));
  }
  const vars = { ...zoneVars(data, zd), ...isoVars(data, target, 'To'), ...isoVars(data, from, 'From'), ...conflictPlaceVars(data, g) };
  geoEvent(state, data, { kind: 'control_change', conflictId: g.id, zoneIds: [zoneId], zoneId, from, to: target, text: capFirst(fill(G.timeline?.control_change || '{Zone}: controle muda', vars)) });
  pnews(state, data, 'geo:control_change', vars, {
    headlines: G.news?.control_change, tplKey: 'geo:control_change', importance: 3, force: true, tags: ['conflict', 'geo'],
    actors: (g.nations || []).map((n) => leadActor(state, data, n)).filter((id) => state.actors?.[id]),
    body: zd.desc ? `Mapa atualizado. Contexto: ${zd.desc}` : '',
  });
  emitSignal(state, 'geo/zoneChanged', {
    zoneId, zoneName: zd.name || zoneId, from, to: target, conflictId: g.id,
    actorId: leadActor(state, data, lead), nations: [...(g.nations || [])],
  });
  log(state, `politics/geo: ${zoneId} ${from}→${target}`);
}

function geoTick(state, data, ctx) {
  const G = GD(data);
  if (!G.zones) return;
  if (!state.geo?.zones) initGeo(state, data);
  const geo = state.geo;
  if (monthCrossed(state, ctx)) activateGeoFacts(state, data, state.turn);
  const M = G.model || {};
  if (state.turn < (M.startTurn ?? 0)) return;
  // 1. pair conflicts born from the tension scale (world.conflicts, level 3+)
  for (const c of state.world.conflicts || []) {
    if (c.endTurn != null || geo.conflicts.some((g) => g.src === c.id)) continue;
    openPairConflict(state, data, c);
  }
  for (const g of geo.conflicts) {
    if (g.endTurn != null) continue;
    if (g.src) {
      const c = (state.world.conflicts || []).find((x) => x.id === g.src);
      if (c && c.endTurn == null) { g.intensity = clamp(c.level ?? 3, 1, 4); g.peak = Math.max(g.peak, g.intensity); }
      else endGeoConflict(state, data, g, 'ceasefire'); // the tension scale already published the ceasefire headline
    } else if (g.fact) {
      g.intensity = clamp(driverLevel(state, conflictDrivers(data, g)) + 1, 2, 4);
      g.peak = Math.max(g.peak, g.intensity);
    }
  }
  if (!monthCrossed(state, ctx)) return;
  const rng = ctx?.rng ? ctx.rng('geo') : rngFor(state.seed, state.turn, 'politics', 'geo');
  for (const g of geo.conflicts.slice()) {
    if (g.endTurn == null) {
      for (const id of g.zoneIds) tryShift(state, data, g, id, rng);
      if (g.fact && state.turn - Math.max(0, g.startTurn) >= (M.minConflictWeeks ?? 12)) {
        const lvl = driverLevel(state, conflictDrivers(data, g));
        let p = (M.factCeasefire || [])[lvl] ?? 0;
        // economic crises in the driving nations make a pause more likely
        if (p > 0 && (g.nations || []).some((n) => state.world.nations?.[n]?.econ?.crisis)) p *= 1.5;
        if (rng.chance(p)) endGeoConflict(state, data, g, 'ceasefire', { news: true });
      }
    } else if (!g.settled && g.endCause === 'ceasefire') settleConflict(state, data, g, rng);
  }
  geoBlocTick(state, data, rng);
  // keep the list short: drop the oldest settled conflicts
  if (geo.conflicts.length > 30) {
    const drop = new Set(geo.conflicts.filter((g) => g.endTurn != null && g.settled).slice(0, geo.conflicts.length - 30).map((g) => g.id));
    geo.conflicts = geo.conflicts.filter((g) => !drop.has(g.id));
  }
}

// ---------------------------------------------------------------- geo: living blocs (countries and agencies)
//
// Countries outside the game's agencies sign the Artemis Accords or the ILRS (or, under a crisis between the two
// bloc leaders, a country that sat in both picks a side). Monthly hazard from state: recent "firsts" of each bloc,
// the leader's prestige, global tension. Agencies that change bloc (diplomacy) are recorded here too, so the map
// can be scrubbed through time. Record shape (state.geo.blocChanges):
//   country: {turn, kind:'country', iso, bloc, joined, from, to, cause}   (bloc/from/to = map keys)
//   agency:  {turn, kind:'agency', actorId, blocId, bloc, joined, isos}   (blocId = state.blocs id)

const BLOC_CONTRACT = { o: 'ao', a: 'à', os: 'aos', as: 'às' };
const blocDyn = (data) => GD(data).blocDynamics || null;
const blocMapOf = (data) => GD(data).blocMap || { artemis_accords: 'artemis', ilrs: 'ilrs' };
function blocIdOfKey(data, key) {
  return Object.entries(blocMapOf(data)).find(([, k]) => k === key)?.[0] || null;
}
function blocKeyOfActor(state, data, actorId) {
  const b = state.actors?.[actorId]?.bloc;
  return b ? blocMapOf(data)[b] || null : null;
}
function blocVars(data, key, K = 'Bloc') {
  const bf = blocDyn(data)?.blocForms?.[key] || { name: GD(data).blocLabels?.[key] || key, art: null };
  const f = forms(bf.name, bf.art);
  return {
    [K]: bf.name, ['o' + K]: f.the, ['O' + K]: capFirst(f.the), ['de' + K]: f.of,
    ['a' + K]: bf.art ? `${BLOC_CONTRACT[bf.art]} ${bf.name}` : `a ${bf.name}`,
  };
}

/** Static map keys from the signatory lists (data), before any change. */
function staticCountryBlocs(data) {
  const G = GD(data);
  const out = {};
  for (const iso of G.blocs?.artemis || []) out[iso] = 'artemis';
  for (const iso of G.blocs?.ilrs || []) out[iso] = out[iso] === 'artemis' ? 'both' : 'ilrs';
  return out;
}
/** Map key of a country now (or at turn T): static lists + recorded country changes. */
function countryKeyAt(state, data, iso, T = state.turn) {
  let k = staticCountryBlocs(data)[iso] || 'neutral';
  for (const c of state.geo?.blocChanges || []) if (c.kind === 'country' && c.iso === iso && c.turn <= T) k = c.to;
  return k;
}
const memberOfKey = (mapKey, bloc) => mapKey === bloc || mapKey === 'both';
const addKey = (mapKey, bloc) => (mapKey === 'neutral' || mapKey === bloc ? bloc : 'both');
function dropKey(mapKey, bloc) {
  if (mapKey === 'both') return bloc === 'artemis' ? 'ilrs' : 'artemis';
  return mapKey === bloc ? 'neutral' : mapKey;
}

/** Attraction of a bloc (>= 0.6): its leader's share of the race and its members' recent firsts. */
function blocAttraction(state, data, key, BD) {
  const bloc = state.blocs?.[blocIdOfKey(data, key)];
  if (!bloc) return 0;
  const win = BD.momentumWeeks ?? 52;
  let firsts = 0;
  for (const f of Object.values(state.firsts || {})) {
    if (f?.turn == null || f.turn < 0 || state.turn - f.turn > win) continue;
    if (bloc.members?.includes(f.actorId)) firsts++;
  }
  const leaders = Object.keys(blocMapOf(data)).map((id) => state.blocs?.[id]?.leader).filter((id) => state.actors?.[id]);
  const total = leaders.reduce((a, id) => a + Math.max(1, state.actors[id].prestige || 0), 0) || 1;
  const share = state.actors?.[bloc.leader] ? Math.max(1, state.actors[bloc.leader].prestige || 0) / total : 0.5;
  return 0.6 + share + Math.min(4, firsts) * (BD.firstBoost ?? 0.25);
}

/** Tension level between the nations of the two bloc leaders (0 when unknown). */
function leaderPairLevel(state, data) {
  const ids = Object.keys(blocMapOf(data)).map((id) => state.blocs?.[id]?.leader).filter(Boolean);
  if (ids.length < 2) return 0;
  const na = nationOf(state, ids[0]), nb = nationOf(state, ids[1]);
  if (!na || !nb || na === nb) return 0;
  return state.world.pairs?.[relKey(na, nb)]?.level ?? 0;
}

const countryName = (data, iso) => GD(data).countries?.[iso]?.name || GD(data).countryNames?.[iso] || iso;

/** Record + publish one country change (news, timeline, signal). */
function applyCountryChange(state, data, iso, bloc, joined, cause, extra = {}) {
  const G = GD(data);
  const BD = blocDyn(data) || {};
  const from = countryKeyAt(state, data, iso);
  const to = joined ? addKey(from, bloc) : dropKey(from, bloc);
  if (to === from) return null;
  const rec = { turn: state.turn, kind: 'country', iso, bloc, joined, from, to, cause };
  pushCapped(state.geo.blocChanges, rec, BD.cap ?? 60);
  const other = bloc === 'artemis' ? 'ilrs' : 'artemis';
  const vars = { ...isoVars(data, iso, 'Country'), ...blocVars(data, bloc), ...blocVars(data, other, 'Other') };
  const key = !joined ? 'pick_side' : to === 'both' ? 'both' : `join_${bloc}`;
  const tl = G.timeline?.[joined ? 'bloc_join' : 'bloc_leave'] || '{Country}: {Bloc}';
  geoEvent(state, data, { kind: joined ? 'bloc_join' : 'bloc_leave', iso, bloc, from, to, zoneIds: [], text: capFirst(fill(tl, vars)) });
  const leader = state.blocs?.[blocIdOfKey(data, bloc)]?.leader;
  const now = countryBlocs(state, data);
  const n = Object.values(now).filter((k) => memberOfKey(k, bloc)).length;
  const bodyTpl = BD.body?.[joined ? 'join' : 'leave'] || '';
  pnews(state, data, `geo:bloc_${key}`, vars, {
    headlines: G.news?.[`bloc_${key}`] || G.news?.bloc_join_artemis, tplKey: `geo:bloc_${key}`, importance: extra.importance ?? 2, force: true, always: true,
    tags: ['geo', 'bloco', 'diplomacia'], actors: leader && state.actors?.[leader] ? [leader] : [], icon: '🏳️',
    body: fill(bodyTpl, { ...vars, n }),
  });
  if (leader && state.actors?.[leader]) changeActor(state, leader, 'reputation', (joined ? 1 : -1) * (BD.leaderReputation ?? 1));
  emitSignal(state, 'geo/blocSignup', {
    iso, countryName: countryName(data, iso), bloc, blocId: blocIdOfKey(data, bloc), joined, from, to,
    actorId: leader || null, withPlayer: !!(leader && blocKeyOfActor(state, data, state.playerId) === bloc),
  });
  state.stats['politics.blocChanges'] = (state.stats['politics.blocChanges'] || 0) + 1;
  log(state, `politics/geo: ${iso} ${from}→${to} (${cause})`);
  return rec;
}

/** Monthly: maybe one country signs a bloc (or picks a side under a crisis between the leaders). */
function geoBlocTick(state, data, rng) {
  const BD = blocDyn(data);
  const geo = state.geo;
  if (!BD || !geo) return;
  geo.blocChanges ||= [];
  if (state.turn < (BD.startTurn ?? 8)) return;
  if (geo.blocChanges.filter((c) => c.kind === 'country').length >= (BD.maxChanges ?? 3)) return;
  if (geo.blocNextTurn != null && state.turn < geo.blocNextTurn) return;
  const keys = ['artemis', 'ilrs'].filter((k) => state.blocs?.[blocIdOfKey(data, k)]);
  if (!keys.length) return;
  const attract = Object.fromEntries(keys.map((k) => [k, blocAttraction(state, data, k, BD)]));
  const crisis = leaderPairLevel(state, data);
  const agencyIsos = new Set(Object.values(GD(data).actorCountries || {}).flat());
  // a crisis between the two leaders: countries that sat in both blocs feel the pressure to pick one
  if (crisis >= (BD.sideMinLevel ?? 3) && keys.length === 2) {
    const map = countryBlocs(state, data);
    const both = Object.keys(map).filter((iso) => map[iso] === 'both' && !agencyIsos.has(iso)).sort();
    if (both.length && rng.chance(Math.min(0.5, (BD.sideHazard ?? 0.04) * both.length))) {
      const iso = rng.pick(both);
      const lean = (BD.candidates || []).find((c) => c.iso === iso)?.lean || {};
      const score = (k) => (lean[k] ?? 0.5) * attract[k];
      const drop = score('artemis') >= score('ilrs') ? 'ilrs' : 'artemis';
      const rec = applyCountryChange(state, data, iso, drop, false, 'crise entre os líderes dos blocos');
      if (rec) geo.blocNextTurn = state.turn + (BD.minGapWeeks ?? 16);
      return;
    }
  }
  const gt = state.world.globalTension ?? 0;
  const momentum = 1 + Math.max(0, gt - 1) * (BD.tensionBoost ?? 0.2)
    + Object.values(attract).reduce((a, v) => a + Math.max(0, v - 1.1), 0) * (BD.momentumBoost ?? 0.5);
  if (!rng.chance((BD.signupHazard ?? 0.02) * momentum)) return;
  const options = [];
  for (const c of BD.candidates || []) {
    if (agencyIsos.has(c.iso)) continue;
    const now = countryKeyAt(state, data, c.iso);
    for (const k of keys) {
      if (memberOfKey(now, k)) continue;
      const lean = c.lean?.[k] ?? 0;
      if (lean <= 0) continue;
      // a country already in the other bloc signs this one too less often (and hardly in a crisis)
      const hedge = now === 'neutral' ? 1 : (BD.hedgeFactor ?? 0.5) * (crisis >= 3 ? 0.2 : 1);
      options.push({ iso: c.iso, bloc: k, weight: (c.weight ?? 1) * lean * lean * attract[k] * hedge });
    }
  }
  const pick = rng.weighted(options);
  if (!pick) return;
  const rec = applyCountryChange(state, data, pick.iso, pick.bloc, true, 'adesão');
  if (rec) geo.blocNextTurn = state.turn + (BD.minGapWeeks ?? 16);
}

/** An agency changed bloc (diplomacy signal): keep a dated record for the map history and timeline. */
function recordAgencyBlocChange(state, data, s) {
  const geo = state.geo;
  if (!geo || !s?.actorId || !s.blocId) return;
  geo.blocChanges ||= [];
  const turn = s.turn ?? state.turn;
  const joined = !!s.joined;
  if (geo.blocChanges.some((c) => c.kind === 'agency' && c.actorId === s.actorId && c.blocId === s.blocId && c.turn === turn && c.joined === joined)) return;
  const bloc = blocMapOf(data)[s.blocId] || null;
  pushCapped(geo.blocChanges, { turn, kind: 'agency', actorId: s.actorId, blocId: s.blocId, bloc, joined, isos: (GD(data).actorCountries?.[s.actorId] || []).slice() }, blocDyn(data)?.cap ?? 60);
  const vars = { actor: actorShort(state, s.actorId), ...blocVars(data, bloc || s.blocId) };
  const tl = GD(data).timeline?.[joined ? 'agency_join' : 'agency_leave'] || '{actor}: {Bloc}';
  pushCapped(geo.events, { turn, kind: joined ? 'bloc_join' : 'bloc_leave', actorId: s.actorId, bloc, zoneIds: [], text: capFirst(fill(tl, vars)) }, (Number.isFinite(state.endTurn) && state.endTurn > 10 * WEEKS_PER_YEAR ? 40 : GD(data).model?.eventsCap ?? 80));
}

/** Bloc id of an agency at turn T (current bloc, undoing recorded changes after T). */
function actorBlocAt(state, actorId, T) {
  let b = state.actors?.[actorId]?.bloc ?? null;
  if (T >= state.turn) return b;
  const list = (state.geo?.blocChanges || []).filter((c) => c.kind === 'agency' && c.actorId === actorId && c.turn > T);
  for (let i = list.length - 1; i >= 0; i--) b = list[i].joined ? null : list[i].blocId;
  return b;
}

/**
 * Country -> bloc key for the map at turn T (default now): static signatory lists, countries that signed or
 * left during the campaign, and agencies whose bloc differs from the start recolor their countries.
 */
function countryBlocs(state, data, T = state.turn) {
  const G = GD(data);
  const out = staticCountryBlocs(data);
  for (const c of state.geo?.blocChanges || []) if (c.kind === 'country' && c.turn <= T) out[c.iso] = c.to;
  const map = blocMapOf(data);
  const initial = Object.fromEntries((data?.actors?.actors || []).map((a) => [a.id, a.bloc ?? null]));
  for (const [aid, isos] of Object.entries(G.actorCountries || {})) {
    const a = state.actors?.[aid];
    if (!a || a.kind === 'company') continue;
    const b = actorBlocAt(state, aid, T);
    if ((b ?? null) === (initial[aid] ?? null)) continue;
    const k = b ? map[b] || 'neutral' : 'neutral';
    for (const iso of isos) out[iso] = k;
  }
  return out;
}

/** Nation pair levels at turn T, rebuilt from the tension history (capped: older moves are approximate). */
function pairLevelsAt(state, T) {
  const w = state.world || {};
  const lv = {};
  for (const [k, p] of Object.entries(w.pairs || {})) lv[k] = p.level;
  if (T >= state.turn) return lv;
  const hist = w.history?.tension || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.turn > T && lv[h.pair] != null) lv[h.pair] = h.from;
  }
  return lv;
}

function geoStateQuery(state, data, atTurn) {
  DATA = data || DATA;
  const G = GD(data);
  const geo = state.geo || { zones: {}, conflicts: [], events: [] };
  const T = atTurn == null || !Number.isFinite(Number(atTurn)) ? state.turn : clamp(Math.round(Number(atTurn)), Math.min(0, state.turn), state.turn);
  const labels = G.statusLabels || {};
  const conflicts = (geo.conflicts || []).filter((g) => !g.joined && g.startTurn <= T && (g.endTurn == null || g.endTurn > T)).map((g) => ({
    id: g.id, name: g.name, fact: !!g.fact, place: g.place, parties: g.parties, nations: g.nations,
    partyNames: g.fact ? g.parties.map((iso) => G.countries?.[iso]?.name || iso) : (g.nations || []).map((n) => nationName(data, n)),
    zoneIds: g.zoneIds, area: g.area, startTurn: g.startTurn, endTurn: g.endTurn, intensity: g.intensity, levelLabel: levelLabel(g.intensity),
  }));
  const zones = (G.zones || []).filter((zd) => geo.zones?.[zd.id]).map((zd) => {
    const z = geo.zones[zd.id];
    let controller = z.controller;
    let status = z.status;
    for (let i = z.history.length - 1; i >= 0; i--) {
      const h = z.history[i];
      if (h.turn <= T) continue;
      if (h.field === 'controller') controller = h.from; else if (h.field === 'status') status = h.from;
    }
    const past = z.history.filter((h) => h.turn <= T);
    const lastControl = past.filter((h) => h.field === 'controller').pop() || null;
    const since = past.length ? past[past.length - 1].turn : (geoTurn(data, zd.since, state.startYear) ?? 0);
    const conflict = conflicts.find((c) => c.zoneIds.includes(zd.id)) || null;
    return {
      id: zd.id, name: zd.name, kind: zd.kind, polygon: zd.polygon || null, circle: zd.circle || null, label: zd.label || zd.circle || null,
      claimants: zd.claimants, claimantNames: zd.claimants.map((iso) => G.countries?.[iso]?.name || iso),
      controller, controllerName: G.countries?.[controller]?.name || controller, status, statusLabel: labels[status] || status,
      since, sinceYear: past.length ? null : zd.since?.year ?? null, desc: zd.desc || '', shiftable: !!zd.shiftable,
      changedTurn: lastControl?.turn ?? null, changedFrom: lastControl?.from ?? null,
      changedFromName: lastControl ? G.countries?.[lastControl.from]?.name || lastControl.from : null,
      conflictId: conflict?.id || null,
    };
  });
  const lv = pairLevelsAt(state, T);
  const pNation = nationOf(state, state.playerId);
  const anchors = G.nationAnchors || {};
  const tensionLines = Object.entries(state.world?.pairs || {}).map(([k, p]) => ({ k, p, level: lv[k] ?? p.level }))
    .filter(({ p, level }) => anchors[p.a] && anchors[p.b] && (level >= 1 || p.a === pNation || p.b === pNation))
    .map(({ k, p, level }) => ({
      key: k, nations: [p.a, p.b], names: [nationName(data, p.a), nationName(data, p.b)], flags: [nationDef(data, p.a)?.flag || '', nationDef(data, p.b)?.flag || ''],
      level, levelLabel: levelLabel(level), from: anchors[p.a], to: anchors[p.b], player: p.a === pNation || p.b === pNation,
    }))
    .sort((x, y) => x.level - y.level);
  const hqs = (G.hqs || []).filter((q) => state.actors?.[q.actorId]).map((q) => {
    const a = state.actors[q.actorId];
    return { ...q, short: a.short || a.name, flag: a.flag || '', bloc: a.bloc || null, kind: a.kind, isPlayer: q.actorId === state.playerId, color: a.color || null };
  });
  return {
    turn: T, now: state.turn, isPast: T < state.turn, startYear: state.startYear,
    zones, conflicts, countryBloc: countryBlocs(state, data, T), blocLabels: G.blocLabels || {}, statusLabels: labels,
    actorCountries: G.actorCountries || {}, esaAssociates: G.esaAssociates || [], countryNames: G.countryNames || {},
    hqs, sites: G.launchSites || [], tensionLines, playerId: state.playerId, playerNation: pNation,
    playerCountries: G.actorCountries?.[state.playerId] || [], shifts: geo.shifts || 0, asOf: G.asOf || null, source: G.source || null,
  };
}

function geoHistoryQuery(state, data) {
  DATA = data || DATA;
  const G = GD(data);
  const events = (state.geo?.events || []).map((e) => ({ ...e }));
  for (const h of state.world?.history?.tension || []) {
    if (Math.max(h.from, h.to) < 3) continue;
    const p = state.world.pairs?.[h.pair];
    if (!p) continue;
    const vars = { A: nationName(data, p.a), B: nationName(data, p.b), level: levelLabel(h.to) };
    events.push({ turn: h.turn, kind: 'tension', pair: h.pair, from: h.from, to: h.to, text: capFirst(fill(G.timeline?.[h.to > h.from ? 'tension_up' : 'tension_down'] || 'Tensão {A}–{B}: {level}', vars)) });
  }
  // same week: the tension move first, then what it did to the map
  events.sort((a, b) => a.turn - b.turn || (a.kind === 'tension' ? 0 : 1) - (b.kind === 'tension' ? 0 : 1));
  return { events, minTurn: 0, maxTurn: state.turn, startYear: state.startYear };
}

// ---------------------------------------------------------------- views & tick

function updateViews(state, data) {
  const w = state.world;
  for (const [id, p] of Object.entries(state.politics)) {
    if (p.kind === 'company') {
      const m = w.markets[id];
      if (!m) continue;
      p.nextElectionTurn = m.nextRoundTurn;
      w.economy[id] = { kind: 'market', growth: m.growth, sentiment: m.sentiment, crisis: m.crisis ? { type: m.crisis.type, untilTurn: m.crisis.untilTurn } : null };
    } else if (p.kind === 'agency') {
      const e = w.elections.find((x) => !x.done && x.nation === p.nation && x.kind !== 'budget_summit' && x.weight >= 0.5);
      p.nextElectionTurn = e ? e.turn : null;
      p.nextElectionName = e ? e.name : null;
      const ec = w.nations[p.nation]?.econ;
      if (ec) w.economy[id] = { kind: 'national', nation: p.nation, growth: ec.growth, inflation: ec.inflation, debt: ec.debt, crisis: ec.crisis ? { type: ec.crisis.type, untilTurn: ec.crisis.untilTurn } : null };
    }
  }
  updateGlobalTension(state);
}

export function tick(state, data, ctx) {
  DATA = data;
  if (!state.world?.pairs || !state.world?.nations) init(state, data, ctx);
  const w = state.world;
  if (w.actorCount !== Object.keys(state.actors || {}).length) refreshActorNation(state, data);
  ensureEntries(state, data);
  for (const [id, a] of Object.entries(state.actors || {})) if (typeof a?.budget === 'number' && w.baseBudget[id] == null) w.baseBudget[id] = a.budget;
  reconcileExternal(state, data);
  processSignals(state, data, ctx);
  if (state.turn > 0 && crossed(state, ctx, WEEKS_PER_YEAR, 0)) annualRollover(state, data, ctx);
  if (monthCrossed(state, ctx)) {
    syncNations(state, data, ctx);
    updateEconomy(state, data, ctx.rng('economy'));
    updateMarkets(state, data, ctx.rng('markets'));
    updateStances(state, data);
    tensionDynamics(state, data, ctx.rng('tension'));
    exogenousEvents(state, data, ctx.rng('events'));
    scheduleSnapElections(state, data, ctx.rng('snap'));
  }
  electionsWeekly(state, data, ctx);
  fundingRounds(state, data, ctx);
  demandWeekly(state, data, ctx);
  geoTick(state, data, ctx);
  updateViews(state, data);
}

// ---------------------------------------------------------------- queries

function pairView(state, data, pk) {
  const p = state.world.pairs[pk];
  const last = [...state.world.history.tension].reverse().find((h) => h.pair === pk);
  return {
    key: pk, nations: [p.a, p.b], a: leadActor(state, data, p.a), b: leadActor(state, data, p.b),
    names: [nationName(data, p.a), nationName(data, p.b)], flags: [nationDef(data, p.a)?.flag || '', nationDef(data, p.b)?.flag || ''],
    label: `${nationName(data, p.a)}–${nationName(data, p.b)}`, level: p.level, levelLabel: levelLabel(p.level),
    trend: last ? Math.sign(last.to - last.from) : 0, sinceTurn: p.sinceTurn, peak: p.peak,
  };
}

export const actions = {};

export const queries = {
  /** World map state at `turn` (default now): zones, active conflicts, country blocs, HQs, sites, tension lines. */
  'geo/state': (state, data, turn) => geoStateQuery(state, data, turn),
  /** Geo timeline (conflicts, ceasefires, treaties, control changes, tension moves to/from level 3+), oldest first. */
  'geo/history': (state, data) => geoHistoryQuery(state, data),
  /** All nation pairs, most tense first. */
  'politics/tension': (state, data) => {
    DATA = data || DATA;
    if (!state.world?.pairs) return [];
    return Object.keys(state.world.pairs).map((k) => pairView(state, data, k)).sort((x, y) => y.level - x.level || x.label.localeCompare(y.label));
  },
  /** World overview for the Mundo tab. */
  'politics/world': (state, data) => {
    DATA = data || DATA;
    const w = state.world || {};
    const pd = PD(data);
    const g = w.globalTension ?? 0;
    return {
      globalTension: g,
      globalLabel: levelLabel(Math.round(g)),
      debrisRisk: w.debrisRisk ?? 0,
      nations: nations(data).filter((n) => w.nations?.[n.id]).map((n) => {
        const ns = w.nations[n.id];
        const ex = factionDef(n, ns.government.exec);
        const lg = factionDef(n, ns.government.legis);
        const next = (w.elections || []).find((e) => !e.done && e.nation === n.id);
        return {
          id: n.id, name: n.name, flag: n.flag, actors: n.actors,
          government: ex?.gov, legislature: lg?.name, divided: !!ns.divided, priority: ex?.priority, priorityLabel: priorityLabel(data, ex?.priority),
          economy: { growth: ns.econ.growth, inflation: ns.econ.inflation, debt: ns.econ.debt, crisis: ns.econ.crisis?.type || null, crisisLabel: ns.econ.crisis ? pd.crises?.[ns.econ.crisis.type]?.label : null },
          nextElection: next ? { id: next.id, name: next.name, turn: next.turn, kind: next.kind } : null,
        };
      }),
      markets: Object.entries(w.markets || {}).map(([id, m]) => ({ actorId: id, sentiment: m.sentiment, growth: m.growth, crisis: m.crisis?.type || null, nextRoundTurn: m.nextRoundTurn })),
      conflicts: (w.conflicts || []).map((c) => ({ ...c, names: c.nations.map((n) => nationName(data, n)), active: c.endTurn == null })),
      elections: (w.elections || []).filter((e) => !e.done).slice(0, 6).map((e) => ({ id: e.id, name: e.name, nation: e.nation, turn: e.turn, kind: e.kind })),
      recentEvents: (w.history?.events || []).slice(-8).reverse(),
      recentElections: (w.history?.elections || []).slice(-6).reverse(),
      demand: w.demand ? { ...w.demand, goal: pd.goals?.[w.demand.type] } : null,
    };
  },
  /** One actor's political situation. */
  'politics/actor': (state, data, id) => {
    DATA = data || DATA;
    const p = state.politics?.[id];
    if (!p) return null;
    const w = state.world;
    const tensions = Object.keys(w.pairs || {}).filter((k) => w.pairs[k].a === p.nation || w.pairs[k].b === p.nation).map((k) => pairView(state, data, k)).sort((x, y) => y.level - x.level);
    return {
      actorId: id, kind: p.kind, nation: p.nation, nationName: nationName(data, p.nation), government: p.government,
      stance: p.stance, priority: p.priority, priorityLabel: priorityLabel(data, p.priority),
      nextElectionTurn: p.nextElectionTurn, nextElectionName: p.nextElectionName,
      economy: w.economy?.[id] || null, tensions,
      demand: w.demand?.actorId === id ? { ...w.demand, goal: PD(data).goals?.[w.demand.type] } : null,
    };
  },
};

// ---------------------------------------------------------------- 1950–3000 contract (EXPANSION.md §1.5, §3)

/**
 * Monthly economy and tension, elections, funding rounds and demands. Substepped by the engine in windows of at most
 * 4 weeks: a month (52/12 weeks) never starts twice inside one window, so monthCrossed() fires exactly once per month
 * as week by week; the weekly checks compare against the window (election announcements) or fire at its first week
 * (elections, rounds and demands due inside it), at a quarter of the weekly overhead.
 */
export const meta = { maxDt: 4 };

/**
 * Create the political entry of a nation (idempotent): government, economy, tension pairs with every live nation
 * (level 0), and refresh the actor → nation map. Nations the politics data does not describe get a generic profile
 * from data/core/nations.json. Returns the nation slice, or null when the nation is unknown.
 */
export function ensureNation(state, data, nationId, ctx) {
  if (!state.world?.nations || !nationId) return null;
  const w = state.world;
  if (w.nations[nationId]) return w.nations[nationId];
  const nd = nationDef(data, nationId);
  if (!nd) return null;
  const e = nd.economy || {};
  const gov = { exec: nd.government?.exec || nd.factions?.[0]?.id, legis: nd.government?.legis || nd.government?.exec || nd.factions?.[0]?.id };
  w.nations[nationId] = {
    government: gov, econ: { growth: e.growth ?? 2, inflation: e.inflation ?? 2, debt: e.debt ?? 80, crisis: null },
    incumbentMod: 0, pendingBudgetPct: 0, divided: gov.exec !== gov.legis, ...(nd.generic ? { generic: true } : {}),
    bornTurn: state.turn,
  };
  for (const other of Object.keys(w.nations)) {
    if (other === nationId) continue;
    const k = relKey(nationId, other);
    if (!w.pairs[k]) {
      const p = (PD(data).pairs || []).find((x) => relKey(x.a, x.b) === k);
      const lvl = Array.isArray(p?.initial) ? p.initial[0] : (p?.initial ?? 0);
      w.pairs[k] = { a: nationId < other ? nationId : other, b: nationId < other ? other : nationId, level: clamp(lvl, 0, 4), pressure: 0, sinceTurn: state.turn, peak: lvl, changes: 0 };
      PAIRS_VER++;
      syncPair(state, k);
    }
  }
  refreshActorNation(state, data);
  for (const [id, n] of Object.entries(w.actorNation)) {
    if (n !== nationId || !state.politics?.[id] || state.politics[id].kind !== 'other') continue;
    delete state.politics[id]; // re-created as an agency entry of its new nation
  }
  ensureEntries(state, data);
  refreshGovernment(state, data, nationId);
  return w.nations[nationId];
}

/**
 * A nation ends (USSR in dez/1991): its pairs and elections go, its agencies move to `into` (or to their lineage's
 * nation of the day) and keep their political entries (government, stance) from the successor.
 */
export function retireNation(state, data, nationId, { into = null } = {}, ctx) {
  const w = state.world;
  if (!w?.nations?.[nationId]) return false;
  const succ = Array.isArray(into) ? into[0] : into;
  if (succ && !w.nations[succ]) ensureNation(state, data, succ, ctx);
  delete w.nations[nationId];
  for (const k of Object.keys(w.pairs)) if (w.pairs[k].a === nationId || w.pairs[k].b === nationId) { delete w.pairs[k]; PAIRS_VER++; }
  w.elections = (w.elections || []).filter((e) => e.nation !== nationId || e.done);
  for (const [id, n] of Object.entries(w.actorNation || {})) {
    if (n !== nationId) continue;
    const ln = lineageNationAt(state, data, id);
    const to = ln && ln !== nationId && w.nations[ln] ? ln : succ && w.nations[succ] ? succ : null;
    if (to) w.actorNation[id] = to; else delete w.actorNation[id];
    if (state.politics?.[id]) { state.politics[id].nation = to; if (!to) state.politics[id].kind = 'other'; }
  }
  invalidateNations();
  w.gone = w.gone || {};
  w.gone[nationId] = { turn: state.turn, into: succ };
  if (succ) refreshGovernment(state, data, succ);
  return true;
}

/** Monthly: nations born (or needed by a live actor's lineage) enter, nations whose date ended leave. */
function syncNations(state, data, ctx) {
  const list = coreNations(data);
  if (!list.length) return;
  const w = state.world;
  for (const nid of Object.keys(w.nations)) {
    if (nationAliveAt(state, data, nid)) continue;
    const def = coreNation(data, nid);
    retireNation(state, data, nid, { into: def?.successors?.[0] ?? null }, ctx);
  }
  const want = new Set(nations(data).map((n) => n.id));
  // only core actors bring their nation into world politics (background actors ride along when it exists)
  for (const id of Object.keys(state.actors || {})) {
    if ((state.actors[id]?.tier ?? 'core') !== 'core' && id !== state.playerId) continue;
    const ln = lineageNationAt(state, data, id);
    if (ln) want.add(ln);
  }
  for (const nid of want) if (!w.nations[nid] && coreNation(data, nid) && nationAliveAt(state, data, nid)) ensureNation(state, data, nid, ctx);
}

/** A born actor gets its nation (from its lineage) and its political entry. */
export function onActorBorn(state, data, ctx, id) {
  if (!state.world?.nations) return;
  const ln = lineageNationAt(state, data, id) || state.actors?.[id]?.nation;
  const core = (state.actors?.[id]?.tier ?? 'core') === 'core' || id === state.playerId;
  if (core && ln && !state.world.nations[ln] && nationAliveAt(state, data, ln)) ensureNation(state, data, ln, ctx);
  refreshActorNation(state, data);
  ensureEntries(state, data);
}

/** A dead actor leaves the political slices (its tension rows go with it). */
export function onActorGone(state, data, ctx, id) {
  const w = state.world;
  if (state.politics) delete state.politics[id];
  if (w?.actorNation) delete w.actorNation[id];
  invalidateNations();
  if (w?.markets) delete w.markets[id];
  if (w?.baseBudget) delete w.baseBudget[id];
  if (w?.economy) delete w.economy[id];
  if (w) w.actorCount = Object.keys(state.actors || {}).length;
  for (const k of Object.keys(state.tension || {})) if (k.split('|').includes(id)) delete state.tension[k];
}

/** Era change / yearly: history lists are already capped on write; drop settled geo conflicts beyond 30. */
export function compact(state) {
  const geo = state.geo;
  if (Array.isArray(geo?.conflicts) && geo.conflicts.length > 60) {
    const settled = geo.conflicts.filter((g) => g.endTurn != null);
    const drop = new Set(settled.slice(0, geo.conflicts.length - 60).map((g) => g.id));
    geo.conflicts = geo.conflicts.filter((g) => !drop.has(g.id));
  }
  const w = state.world;
  // economy views of actors that are gone (saves from before onActorGone cleaned them)
  if (w?.economy && state.actors) for (const id of Object.keys(w.economy)) if (!state.actors[id]) delete w.economy[id];
  if (Array.isArray(w?.conflicts) && w.conflicts.length > 60) w.conflicts = w.conflicts.filter((c, i) => c.endTurn == null || i >= w.conflicts.length - 60);
  if (Array.isArray(w?.elections) && w.elections.length > 80) w.elections = w.elections.filter((e) => !e.done || e.turn > state.turn - 3 * WEEKS_PER_YEAR);
  // a 1950–3000 campaign (save budget 400 KB) keeps a shorter memory; the Corrida Lunar is untouched
  if (Number.isFinite(state.endTurn) && state.endTurn > 10 * WEEKS_PER_YEAR) {
    for (const [k, n] of Object.entries(LONG_HISTORY_CAP)) if (Array.isArray(w?.history?.[k]) && w.history[k].length > n) w.history[k] = w.history[k].slice(-n);
    if (Array.isArray(geo?.events) && geo.events.length > 40) geo.events = geo.events.slice(-40);
    if (Array.isArray(geo?.conflicts)) {
      const settled = geo.conflicts.filter((g) => g.endTurn != null && g.settled);
      if (settled.length > 10) {
        const drop = new Set(settled.slice(0, settled.length - 10).map((g) => g.id));
        geo.conflicts = geo.conflicts.filter((g) => !drop.has(g.id));
      }
    }
    for (const z of Object.values(geo?.zones || {})) if (Array.isArray(z?.history) && z.history.length > 6) z.history = z.history.slice(-6);
    if (Array.isArray(w?.conflicts) && w.conflicts.length > 20) w.conflicts = w.conflicts.filter((c, i) => c.endTurn == null || i >= w.conflicts.length - 20);
  }
}

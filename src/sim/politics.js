// Politics & simulated wars (GDD "Política e guerras simuladas", Turno 5).
// Owns the slices `world`, `politics` and `tension`. Pure JS, deterministic (ctx.rng / rngFor only).
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

/** Static content cache so setTension(state, ...) can phrase news without a data argument. */
let DATA = null;
const PD = (data) => (data || DATA)?.politics || {};

const LEVEL_LABELS = ['normal', 'tensão', 'crise', 'conflito regional', 'guerra aberta'];
const OUTCOME_SCORE = { total: 1, partial: 0.4, recoverable: -0.5, catastrophic: -1 };
const HISTORY_CAP = { tension: 150, events: 80, elections: 40, crises: 40, budgets: 80 };

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
const nationDef = (data, id) => nations(data).find((n) => n.id === id) || null;
const nationName = (data, id) => nationDef(data, id)?.name || id;
const factionDef = (nd, fid) => nd?.factions?.find((f) => f.id === fid) || nd?.factions?.[0] || null;
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
/** Known actor ids of a nation (data-listed + state actors mapped to it). */
function actorsOfNation(state, nid) {
  const m = state.world?.actorNation || {};
  return Object.keys(m).filter((k) => m[k] === nid);
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
  for (const a of Object.values(state.actors || {})) {
    if (!a?.id || w.actorNation[a.id]) continue;
    const c = String(a.country || '').toLowerCase();
    const n = nations(data).find((x) => (x.aliases || []).some((al) => al.toLowerCase() === c) || x.name.toLowerCase() === c);
    if (n) w.actorNation[a.id] = n.id;
  }
  w.actorCount = Object.keys(state.actors || {}).length;
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
  if ((!opts.force && w.newsMonth.count >= per) || (w.newsMonth.count >= hard && importance < 3)) {
    state.stats['politics.newsDropped'] = (state.stats['politics.newsDropped'] || 0) + 1;
    return null;
  }
  const rng = rngFor(state.seed, state.turn, 'politics', 'tpl', key, w.newsMonth.count);
  let idx = Math.floor(rng.next() * list.length);
  const tplKey = opts.tplKey || key;
  if (list.length > 1 && w.tplLast?.[tplKey] === idx) idx = (idx + 1) % list.length;
  w.tplLast = w.tplLast || {};
  w.tplLast[tplKey] = idx;
  w.newsMonth.count += 1;
  return addNews(state, {
    headline: capFirst(fill(list[idx], vars)),
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
  }
  // ensure every nation pair exists (pairs missing from data get baseline 0)
  const ids = Object.keys(w.nations);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const k = relKey(ids[i], ids[j]);
    if (!w.pairs[k]) w.pairs[k] = { a: ids[i], b: ids[j], level: 0, pressure: 0, sinceTurn: 0, peak: 0, changes: 0 };
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

function syncPair(state, pk) {
  const p = state.world.pairs[pk];
  if (!p) return;
  const as = actorsOfNation(state, p.a);
  const bs = actorsOfNation(state, p.b);
  for (const x of as) for (const y of bs) state.tension[relKey(x, y)] = p.level;
}

/**
 * Another module may have written state.tension directly (e.g. a narrative choice "+1 tension with the rival").
 * A small nudge (±1) becomes a pressure impulse on the nation pair: provocations matter, but one card does not
 * start a war by itself. A jump of 2+ levels is treated as deliberate and adopted.
 */
function reconcileExternal(state, data) {
  const M = PD(data).tensionModel || {};
  for (const [pk, p] of Object.entries(state.world.pairs)) {
    let ext = null;
    for (const x of actorsOfNation(state, p.a)) {
      for (const y of actorsOfNation(state, p.b)) {
        const v = state.tension[relKey(x, y)];
        if (typeof v === 'number' && Math.round(v) !== p.level) { ext = clamp(Math.round(v), 0, 4); break; }
      }
      if (ext != null) break;
    }
    if (ext == null) { syncPair(state, pk); continue; }
    const delta = ext - p.level;
    if (Math.abs(delta) >= 2) applyLevel(state, data, pk, ext, 'externo');
    else {
      p.pressure = r3(p.pressure + delta * (M.externalImpulse ?? 0.45));
      syncPair(state, pk);
      log(state, `politics: incidente externo em ${pk} vira pressão (${p.pressure})`);
    }
  }
}

function pairPlace(state, data, pk) {
  const p = state.world.pairs[pk];
  const def = (PD(data).pairs || []).find((x) => relKey(x.a, x.b) === pk);
  const places = def?.places || [];
  if (!places.length) return '';
  const rng = rngFor(state.seed, 'politics', 'place', pk, p.changes || 0);
  return rng.pick(places);
}

function pairFloor(data, pk) {
  return (PD(data).pairs || []).find((x) => relKey(x.a, x.b) === pk)?.floor ?? 0;
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
  pushCapped(w.history.tension, { turn: state.turn, pair: pk, from, to, reason }, HISTORY_CAP.tension);
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
  const lv = Object.values(state.world.pairs).map((p) => p.level).sort((a, b) => b - a);
  if (!lv.length) { state.world.globalTension = 0; return; }
  const top = lv.slice(0, 3);
  const avg = top.reduce((s, x) => s + x, 0) / top.length;
  state.world.globalTension = Math.round(clamp(0.5 * lv[0] + 0.5 * avg, 0, 4) * 10) / 10;
}

// ---------------------------------------------------------------- monthly dynamics

function tensionDynamics(state, data, rng) {
  const pd = PD(data);
  const M = pd.tensionModel || {};
  const up = M.up || [0.55, 0.7, 1.0, 1.35];
  const drag = M.levelDrag || [0, 0, 0, 0.05, 0.18];
  const w = state.world;
  for (const [pk, p] of Object.entries(w.pairs)) {
    const def = (pd.pairs || []).find((x) => relKey(x.a, x.b) === pk) || {};
    const na = nationDef(data, p.a);
    const nb = nationDef(data, p.b);
    let drive = ((def.baseline ?? 0.2) - p.level) * (M.meanReversion ?? 0.12);
    // diplomacy relations between lead agencies (if diplomacy runs)
    const rel = state.relations?.[relKey(leadActor(state, data, p.a), leadActor(state, data, p.b))];
    if (rel) drive += (((rel.rivalry ?? 30) - 40) / 100) * (M.rivalryFactor ?? 0.08) - ((rel.trust ?? 0) / 100) * (M.trustFactor ?? 0.05);
    // hawkish governments push up
    const ha = factionDef(na, w.nations[p.a]?.government.exec)?.hawk ?? 0.5;
    const hb = factionDef(nb, w.nations[p.b]?.government.exec)?.hawk ?? 0.5;
    drive += (ha + hb - 1) * (M.hawkFactor ?? 0.08) * (p.level > 0 || def.baseline > 0.5 ? 1 : 0.3);
    // economic instability breeds friction
    for (const nid of [p.a, p.b]) {
      const c = w.nations[nid]?.econ.crisis;
      if (c) drive += pd.crises?.[c.type]?.instability ?? 0.05;
    }
    // bilateral peaceful treaties dampen
    const la = leadActor(state, data, p.a);
    const lb = leadActor(state, data, p.b);
    const peace = (state.treaties || []).filter((t) => t?.status === 'active' && t.parties?.includes(la) && t.parties?.includes(lb)).length;
    drive -= Math.min(3, peace) * (M.peaceTreaty ?? 0.02);
    drive -= drag[p.level] || 0; // war exhaustion
    drive += rng.normal(0, (def.volatility ?? 0.2) * (M.noiseScale ?? 0.3));
    p.pressure = r3(p.pressure * (M.decay ?? 0.8) + drive);
    const dwell = state.turn - (p.sinceTurn ?? 0) >= (M.minDwellWeeks ?? 8);
    if (!dwell) continue;
    if (p.level < 4 && p.pressure > up[p.level]) applyLevel(state, data, pk, p.level + 1, 'escalada');
    else if (p.level > pairFloor(data, pk) && p.pressure < -(M.down ?? 0.55)) applyLevel(state, data, pk, p.level - 1, 'distensão');
  }
}

function startCrisis(state, data, nid, type, rng, severity = 1) {
  const pd = PD(data);
  const ns = state.world.nations[nid];
  if (!ns || ns.econ.crisis) return false;
  const def = pd.crises?.[type] || {};
  const [lo, hi] = def.months || [6, 12];
  const months = rng.int(lo, hi);
  ns.econ.crisis = { type, startTurn: state.turn, untilTurn: state.turn + Math.round(months * WEEKS_PER_YEAR / 12), severity: r2(severity) };
  pushCapped(state.world.history.crises, { turn: state.turn, nation: nid, type, months }, HISTORY_CAP.crises);
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
  let list;
  if (def.pairs === 'any' || !def.pairs) list = Object.values(w.pairs).map((p) => [p.a, p.b]);
  else list = def.pairs.filter(([a, b]) => w.pairs[relKey(a, b)]);
  return list
    .map(([a, b]) => ({ a, b, p: w.pairs[relKey(a, b)] }))
    .filter(({ p }) => p.level >= (def.minLevel ?? 0) && p.level <= (def.maxLevel ?? 4))
    .map((c) => ({ ...c, weight: 1 + c.p.level * (def.levelBias ?? 0.4) + Math.max(0, c.p.pressure) * 0.5 }));
}

function eventEligible(state, data, def) {
  const w = state.world;
  if ((w.cooldowns[`ev:${def.id}`] ?? -1) > state.turn) return false;
  if (def.once && w.eventCounts[def.id]) return false;
  if (def.minTurn != null && state.turn < def.minTurn) return false;
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
        let ns = def.nations === 'any' || !def.nations ? nations(data).map((x) => x.id) : def.nations.filter((x) => w.nations[x]);
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
    pushCapped(w.history.events, { turn: state.turn, id: def.id, a: tctx.a || null, b: tctx.b || null, n: tctx.n || null, headline: item?.headline || null, involved }, HISTORY_CAP.events);
    state.stats['politics.events'] = (state.stats['politics.events'] || 0) + 1;
    applyEventEffects(state, data, def, tctx, rng);
  }
}

// ---------------------------------------------------------------- elections

function scheduleSnapElections(state, data, rng) {
  const w = state.world;
  const em = PD(data).electionModel || {};
  for (const n of nations(data)) {
    if (!n.snapElectionPerYear) continue;
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
  pushCapped(w.history.elections, { turn: state.turn, id: e.id, nation: e.nation, kind: e.kind, name: e.name, result, exec: gov.exec, legis: gov.legis }, HISTORY_CAP.elections);
  state.stats['politics.elections'] = (state.stats['politics.elections'] || 0) + 1;
  emitSignal(state, 'election', { actorId: leadActor(state, data, e.nation), result, nation: e.nation, electionId: e.id, kind: e.kind });
  // player's promise comes due
  const dm = w.demand;
  if (dm && dm.electionId === e.id) settleDemand(state, data, dm.fulfilled);
}

function electionsWeekly(state, data, ctx) {
  const w = state.world;
  const em = PD(data).electionModel || {};
  for (const e of w.elections) {
    if (e.done) continue;
    if (state.turn === e.turn - (em.announceWeeks ?? 4) && e.weight >= 0.5 && e.kind !== 'budget_summit') {
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
  return { pct: clamp(pct, bm.min ?? -0.25, bm.max ?? 0.2), reasons };
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
        pushCapped(w.history.budgets, { turn: state.turn, year, actorId: id, from, to: from, pct: 0, proposed: r3(pct) }, HISTORY_CAP.budgets);
        lines.push(`${actorShort(state, id)}: corte de ${fmtPct(-pct, false)} em negociação`);
        continue;
      }
    }
    budgetDelta(state, id, pct, 'orçamento anual');
    const to = a.budget;
    const real = from ? to / from - 1 : 0;
    changes.push({ id, real });
    pushCapped(w.history.budgets, { turn: state.turn, year, actorId: id, from: r2(from), to: r2(to), pct: r3(real) }, HISTORY_CAP.budgets);
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
    pushCapped(state.world.history.budgets, { turn: state.turn, year: pl.year, actorId: pid, from: r2(from), to: r2(to), pct: r3(from ? to / from - 1 : 0), negotiated: choice }, HISTORY_CAP.budgets);
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
  if (state.turn > 0 && ctx.date.week === 1) annualRollover(state, data, ctx);
  if (isMonthStart(state)) {
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

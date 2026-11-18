// Shared state helpers. Every sim module uses these to talk to the rest of the game
// instead of reaching into slices it does not own (see ARCHITECTURE.md "Slice ownership").

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Stable key for an unordered actor pair: relKey('nasa','cnsa') === relKey('cnsa','nasa'). */
// Memoized (the sims build hundreds of thousands of pair keys per campaign year): the same string comes back for
// the same ids, so the property lookup that follows hits an already-hashed key. Only string ids are memoized
// (a few hundred actors and nations at most, so the table stays small).
const REL_KEYS = new Map();
export function relKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return a < b ? `${a}|${b}` : `${b}|${a}`;
  let row = REL_KEYS.get(a);
  if (row === undefined) {
    if (REL_KEYS.size > 4000) REL_KEYS.clear(); // safety valve: never grows without bound
    row = new Map();
    REL_KEYS.set(a, row);
  }
  let k = row.get(b);
  if (k === undefined) {
    if (row.size > 4000) row.clear();
    k = a < b ? `${a}|${b}` : `${b}|${a}`;
    row.set(b, k);
  }
  return k;
}

/** Monotonic id generator stored in state (deterministic, serializable). */
export function nextId(state, prefix) {
  state.idCounter = (state.idCounter || 0) + 1;
  return `${prefix}_${state.idCounter}`;
}

/** Live news cap (EXPANSION.md §10); the year's top headlines survive in state.annals. */
export const NEWS_CAP = 120;
export const LONG_NEWS_CAP = 60;
/** Headlines kept per year in the annals, and per decade once a year is older than ANNALS_DECADE_AFTER years. */
export const ANNALS_PER_YEAR = 3;
export const ANNALS_PER_DECADE = 4;
export const ANNALS_DECADE_AFTER = 30;
/** Decades older than this many years fold into one century key "c1900" with the top 3 (a 1,050-year save stays small). */
export const ANNALS_PER_CENTURY = 3;
export const ANNALS_CENTURY_AFTER = 250;
const ANNAL_CHARS = 90;

/**
 * Add a news item to the world feed (Mundo tab + dashboard ticker).
 * item: { headline (pt-BR, short), body?, tags?: string[], actors?: string[], importance?: 1|2|3, icon? }
 */
export function addNews(state, item) {
  const n = {
    id: nextId(state, 'news'),
    turn: state.turn,
    headline: item.headline,
    body: item.body || '',
    tags: item.tags || [],
    actors: item.actors || [],
    importance: item.importance || 1,
    icon: item.icon || null,
  };
  state.news.unshift(n);
  // a 1950–3000 campaign keeps 60 (save budget 400 KB; the annals keep the history); the Corrida Lunar keeps 120
  const cap = Number.isFinite(state.endTurn) && state.endTurn > 520 ? LONG_NEWS_CAP : NEWS_CAP;
  if (state.news.length > cap) state.news.length = cap;
  noteAnnal(state, n);
  return n;
}

/**
 * Annals hook: keep the year's top headlines (importance, then earliest) in state.annals[year] = [{h, i, t}]
 * (≤ 90 chars each), so a 1,050-year campaign remembers its history after the live feed rolls over.
 */
export function noteAnnal(state, n) {
  if (!n?.headline || !Number.isFinite(state.startYear)) return;
  const year = state.startYear + Math.floor(n.turn / 52);
  if (!state.annals || typeof state.annals !== 'object') state.annals = {};
  const list = state.annals[year] || (state.annals[year] = []);
  const h = String(n.headline);
  const entry = { h: h.length > ANNAL_CHARS ? `${h.slice(0, ANNAL_CHARS - 1)}…` : h, i: n.importance || 1, t: n.turn };
  if (list.length < ANNALS_PER_YEAR) { list.push(entry); list.sort(annalOrder); return; }
  if (entry.i > list[list.length - 1].i) { list[list.length - 1] = entry; list.sort(annalOrder); }
}
const annalOrder = (a, b) => (b.i - a.i) || (a.t - b.t);

/**
 * Yearly core compaction: years older than 30 → one decade key "d1950" with the top 4; decades older than 250 years
 * → one century key "c1900" with the top 3.
 */
export function compactAnnals(state, currentYear) {
  const an = state.annals;
  if (!an) return;
  for (const k of Object.keys(an)) {
    if (k.startsWith('c')) continue;
    if (k.startsWith('d')) {
      const dy = Number(k.slice(1));
      if (!Number.isFinite(dy) || currentYear - (dy + 9) <= ANNALS_CENTURY_AFTER) continue;
      const ck = `c${Math.floor(dy / 100) * 100}`;
      an[ck] = (an[ck] || []).concat(an[k]).sort(annalOrder).slice(0, ANNALS_PER_CENTURY);
      delete an[k];
      continue;
    }
    const y = Number(k);
    if (!Number.isFinite(y) || currentYear - y <= ANNALS_DECADE_AFTER) continue;
    const dk = `d${Math.floor(y / 10) * 10}`;
    an[dk] = (an[dk] || []).concat(an[k]).sort(annalOrder).slice(0, ANNALS_PER_DECADE);
    delete an[k];
  }
}

/**
 * Push a decision card to the player's queue (dashboard "fila de decisões").
 * card: {
 *   kind: string                // routes resolution to the module that registered decisionHandlers[kind]
 *   title, body (pt-BR), portrait?: {crewId}|{actorId}|null,
 *   choices: [{ id, label, preview?: string (effect text shown before confirming), disabled?: bool, reason?: string }],
 *   urgency?: 1..3 (3 = most urgent), blocking?: bool (time cannot advance while pending),
 *   expiresTurn?: number, defaultChoice?: string (auto-picked on expiry), payload?: any (module-private data)
 * }
 */
export function pushDecision(state, card) {
  const d = {
    id: nextId(state, 'dec'),
    createdTurn: state.turn,
    urgency: 1,
    blocking: false,
    payload: null,
    portrait: null,
    ...card,
  };
  state.decisions.push(d);
  return d;
}

export function removeDecision(state, id) {
  const i = state.decisions.findIndex((d) => d.id === id);
  if (i >= 0) state.decisions.splice(i, 1);
}

/** Debug/dev log (not shown to players by default). Cap 60 lines; error lines ("erro") are kept longer (up to 20). */
export const LOG_CAP = 60;
const LOG_ERR_CAP = 20;
export function log(state, msg) {
  state.log.push(`[${state.turn}] ${msg}`);
  if (state.log.length <= LOG_CAP) return;
  const isErr = (l) => l.includes('erro');
  let errs = state.log.reduce((n, l) => n + (isErr(l) ? 1 : 0), 0);
  for (let i = 0; i < state.log.length && state.log.length > LOG_CAP;) {
    const err = isErr(state.log[i]);
    if (!err || errs > LOG_ERR_CAP) { state.log.splice(i, 1); if (err) errs--; } else i++;
  }
}

/** Change a numeric field on an actor with clamping to the documented ranges. */
const ACTOR_RANGES = {
  support: [0, 100],
  reputation: [0, 100],
  culture: [-100, 100],
  prestige: [0, Infinity],
  cash: [-Infinity, Infinity],
  budget: [0, Infinity],
};
const SOFT_CAPPED = ['support', 'reputation'];
export function changeActor(state, actorId, field, delta) {
  const a = state.actors[actorId];
  if (!a) return;
  const [lo, hi] = ACTOR_RANGES[field] || [-Infinity, Infinity];
  // diminishing returns near the top: support/reputation gains shrink above 60 so they do not run away to 100
  if (SOFT_CAPPED.includes(field) && delta > 0) delta *= clamp((100 - (a[field] || 0)) / 40, 0.05, 1);
  const before = a[field] || 0;
  a[field] = clamp(before + delta, lo, hi);
  // era prestige (Tabela da Era): tracked only once the engine started it at an era transition
  if (field === 'prestige' && Number.isFinite(a.prestigeEra)) a.prestigeEra = Math.max(0, a.prestigeEra + (a[field] - before));
}

export function player(state) {
  return state.actors[state.playerId];
}

/** Share of the first-place prestige for repeating a feat history already saw ("primeiro do século"). */
export const HISTORIC_FIRST_SHARE = 0.35;

/** Was this milestone already achieved before the scenario (Apollo, Luna, Viking...)? */
export function isHistoricFirst(state, milestoneId) {
  return !!state?.firstsHistory?.[String(milestoneId).split(':')[0]];
}

/**
 * Share of the destination's first points a milestone pays (data/scenario.json firstShares, default 1): a sub-first
 * of a bigger feat (people at the lunar south pole, after people on the Moon) is worth less than the feat itself.
 */
export function milestoneShare(data, milestoneId) {
  const v = data?.scenario?.firstShares?.[String(milestoneId).split(':')[0]];
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

/** Prestige the first actor of the era gets for a milestone (full for true firsts, a share for historic ones). */
export function firstValue(state, milestoneId, prestigeFirst = 30) {
  if (!isHistoricFirst(state, milestoneId)) return prestigeFirst;
  // a historic feat may carry its own share (scenario.historicalFirsts[id].share): the race's headline feat is worth more
  const share = state.firstsHistory[String(milestoneId).split(':')[0]]?.share;
  return Math.round(prestigeFirst * (Number.isFinite(share) ? share : HISTORIC_FIRST_SHARE));
}

/**
 * Award a "Os Primeiros" milestone if nobody reached it yet in this era. Returns true if this actor was first.
 * Feats history already saw (state.firstsHistory) count as "first of the century" (era: true) and pay less.
 */
export function claimFirst(state, milestoneId, actorId, prestigeFirst = 30, prestigeLater = 5) {
  if (!state.firsts[milestoneId]) {
    const era = isHistoricFirst(state, milestoneId);
    state.firsts[milestoneId] = era ? { actorId, turn: state.turn, era: true } : { actorId, turn: state.turn };
    changeActor(state, actorId, 'prestige', firstValue(state, milestoneId, prestigeFirst));
    return true;
  }
  changeActor(state, actorId, 'prestige', prestigeLater);
  return false;
}

/** Deep clone a JSON-serializable state. */
export const cloneState = (s) => JSON.parse(JSON.stringify(s));

/**
 * Cross-module notification (see ARCHITECTURE.md "Signals").
 * Emitted signals become visible in state.signals during the NEXT tick, to every module, then are discarded.
 * signal: { type: string, ...payload }
 */
export function emitSignal(state, type, payload = {}) {
  // type/turn go last so a payload field never masks the signal type
  state.signalsPending.push({ ...payload, type, turn: state.turn });
}

// ---------------------------------------------------------------------------------------------------------------
// Variable-step helpers (EXPANSION.md §1.4). A tick covers the weeks [ctx.prevTurn, ctx.prevTurn + ctx.dt).
// At dt = 1 every helper reduces exactly to the old weekly expression (every(ctx, 52, 51) ⇔ turn % 52 === 51).
// ---------------------------------------------------------------------------------------------------------------

const ctxPrev = (ctx) => (Number.isFinite(ctx?.prevTurn) ? ctx.prevTurn : (Number.isFinite(ctx?.turn) ? ctx.turn : 0));
const ctxDt = (ctx) => (Number.isFinite(ctx?.dt) && ctx.dt > 0 ? ctx.dt : 1);

/** How many weeks t ≡ phase (mod period) fall in this tick's window. */
export function every(ctx, periodWeeks, phase = 0) {
  const p = Math.max(1, Math.round(periodWeeks));
  const a = ctxPrev(ctx);
  const b = a + ctxDt(ctx); // exclusive
  return Math.floor((b - 1 - phase) / p) - Math.floor((a - 1 - phase) / p);
}

/** True when the window contains a week t ≡ phase (mod period). Replaces `state.turn % N === k`. */
export function crossed(ctx, periodWeeks, phase = 0) {
  return every(ctx, periodWeeks, phase) > 0;
}

/** A weekly amount over the whole step (income, salaries, research progress). */
export function perStep(weeklyAmount, ctx) {
  return weeklyAmount * ctxDt(ctx);
}

/** Probability that a weekly chance happens at least once in the step (one draw per tick). */
export function chanceInStep(pWeek, ctx) {
  const dt = ctxDt(ctx);
  if (dt === 1) return pWeek;
  return 1 - (1 - clamp(pWeek, 0, 1)) ** dt;
}

/** Weekly multiplicative decay over the step. */
export function decay(x, perWeekFactor, ctx) {
  const dt = ctxDt(ctx);
  return dt === 1 ? x * perWeekFactor : x * perWeekFactor ** dt;
}

/** A scheduled thing at turn t is due during this tick (t < end of the window). Pair it with a consumed flag. */
export function dueIn(ctx, t) {
  return t != null && t < ctxPrev(ctx) + ctxDt(ctx);
}

/** Cadence with a floor in steps: the effective period is max(weeks, minSteps·dt). */
export function cadence(ctx, { weeks, minSteps = 1, phase = 0 } = {}) {
  const period = Math.max(weeks || 1, minSteps * ctxDt(ctx));
  return crossed(ctx, period, phase);
}

/** Expiry turn for a decision pushed now: at least one full step ahead, so it can be seen before it expires. */
export function expiryIn(ctx, weeks) {
  const now = Number.isFinite(ctx?.turn) ? ctx.turn : ctxPrev(ctx);
  return now + Math.max(weeks, ctxDt(ctx));
}

// ---------------------------------------------------------------------------------------------------------------
// Actors across the lifecycle (EXPANSION.md §3.1)
// ---------------------------------------------------------------------------------------------------------------

/** Ids of live actors, optionally of one tier ('core' | 'minor'; an actor without tier is core). */
export function liveActors(state, { tier } = {}) {
  const ids = Object.keys(state?.actors || {});
  if (!tier) return ids;
  return ids.filter((id) => (state.actors[id]?.tier || 'core') === tier);
}

/** Follow lifecycle aliases (absorbed predecessors → survivor). Unknown ids come back unchanged. */
export function resolveActor(state, id) {
  const aliases = state?.lifecycle?.aliases;
  let cur = id;
  for (let i = 0; aliases && i < 16 && aliases[cur] && aliases[cur] !== cur; i++) cur = aliases[cur];
  return cur;
}

/** Live actor (after aliases) or its tombstone (for UI history), or null. */
export function actorInfo(state, id) {
  const live = state?.actors?.[id] || state?.actors?.[resolveActor(state, id)];
  if (live) return live;
  return state?.lifecycle?.tombstones?.[id] || null;
}

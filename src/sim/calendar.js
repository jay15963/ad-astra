// Catalog + living calendar (module "calendar", owner: catalog).
// - Dynamic catalog: vehicle/spacecraft availability, access rules (embargo, blocs, tension), reliability (Beta).
// - Living calendar: official plans from data/calendar.json slip through periodic schedule revisions,
//   prerequisites gate launches, rival launches resolve with quickOutcome, firsts are claimed, news is written.
// - Background commercial launches (aggregate) keep vehicle stats alive.
// Pure JS, deterministic: randomness only via ctx.rng(label). No dates or mission names hard-coded here.

import { addNews, emitSignal, claimFirst, isHistoricFirst, changeActor, log, relKey, clamp } from '../core/helpers.js';
import { hash32, makeRng } from '../core/rng.js';
import { formatTurn, weeksToText, WEEKS_PER_YEAR } from '../core/time.js';

// outcome.js belongs to launch-core; load it defensively so this module works while it is missing.
let outcomeMod = null;
try {
  outcomeMod = await import('../core/outcome.js');
} catch {
  outcomeMod = null;
}

// ---------------------------------------------------------------- constants (rules, not content)

const WEEKS_PER_MONTH = WEEKS_PER_YEAR / 12;
const REVISION_PERIOD = 13;        // schedule reviews are quarterly...
const REVISION_HORIZON = 104;      // ...and only in the last ~2 years before the flight
const PREREQ_GAP_WEEKS = 8;        // minimum spacing after a prerequisite flight
const SCRUB_CHANCE = 0.12;         // last-week scrub (weather, sensor) for non-historical items
const MAX_REFLIGHTS = 2;
const CREWED_STANDDOWN_WEEKS = 52; // after a fatal accident the owner stops crewed flights ~1 year
const DONE = ['success', 'partial'];
const OK_LEVELS = ['total', 'partial'];
/**
 * Probes already flying when the scenario starts were paid for before 2026: their arrival pays only this share of
 * the prestige (mission and firsts). scenario.inheritedPrestigeShare overrides. missions.js uses the same rule.
 */
export const INHERITED_PRESTIGE_SHARE = 0.35;
export const inheritedShare = (data) => data?.scenario?.inheritedPrestigeShare ?? INHERITED_PRESTIGE_SHARE;
/** Windows this rare (Apophis: one per decade) are single chances: missing one cancels the program. */
const ONE_OFF_WINDOW_WEEKS = 260;
const LEVEL_RANK = { total: 0, partial: 1, recoverable: 2, catastrophic: 3 };
const FAILURE_TYPES = ['propulsion', 'structure', 'software', 'human', 'environment'];
const ASCENT_WEIGHTS = { propulsion: 0.45, structure: 0.2, software: 0.15, human: 0.08, environment: 0.12 };

export const TRUTH_LABELS = { fato: 'Fato', plano_oficial: 'Plano oficial', projecao: 'Projeção', especulacao: 'Especulação' };
export const STATUS_LABELS = {
  planned: 'Planejada', launched: 'Em trânsito', success: 'Sucesso', partial: 'Sucesso parcial',
  failed: 'Fracasso', cancelled: 'Cancelada', player: 'Sua missão',
};

const DEFAULT_NEWS = {
  delayed: 'Adiamento: {name} fica para {date}',
  delayedBody: 'Mais {weeks} de atraso. Plano original: {planned}.',
  windowMissed: '{name} perde a janela e fica para {date}',
  windowMissedBody: '',
  prereqWait: '{name} aguarda {prereq}',
  prereqWaitBody: 'Nova meta: {date}.',
  prereqFailed: 'Revisão em {name} depois do fracasso de {prereq}',
  grounded: 'Adiamento: {name} espera a frota do {vehicle} voltar a voar',
  suspended: 'Guerra suspende {name}',
  suspendedBody: 'Retomada prevista para {date}.',
  cancelled: 'Cancelamento: {name}',
  cancelledBody: '',
  windowLost: '{name} perde a janela única e é cancelada',
  windowLostBody: 'O alinhamento não se repete tão cedo: a próxima chance seria em {date}.',
  launched: '{owner} lança {name}',
  launchedBody: 'Chegada prevista para {date}.',
  success: '{name}: sucesso!',
  partial: '{name}: sucesso parcial',
  failed: '{name} fracassa',
  lostCrew: 'Tragédia: tripulação perdida em {name}',
  lostCrewBody: '',
  first: 'Feito inédito! {owner} conquista: {milestone}',
  firstEra: 'Primeira vez neste século: {owner} conquista {milestone}',
  reflight: '{owner} vai repetir {name}: nova data {date}',
  bgFailure: 'Falha do {vehicle} perde carga comercial',
  bgFailureBody: 'Frota em solo por cerca de {weeks}.',
  bgTestFailure: '{vehicle} se perde em voo de teste',
  bgMilestone: '{vehicle} chega ao {n}º voo',
  bgQuarter: 'Balanço do trimestre: {summary}',
  debut: 'Estreia do {vehicle}',
};

// ---------------------------------------------------------------- small data helpers

const vehiclesOf = (data) => data?.vehicles?.vehicles || [];
const spacecraftOf = (data) => data?.spacecraft?.spacecraft || [];
const destinationsOf = (data) => data?.destinations?.destinations || [];
const itemsOf = (data) => data?.calendar?.missions || [];

const byId = (list, idxName, data, id) => (id == null ? null : data?.index?.[idxName]?.[id] || list.find((x) => x.id === id) || null);
export const vehicleById = (data, id) => byId(vehiclesOf(data), 'vehicles', data, id);
export const spacecraftById = (data, id) => byId(spacecraftOf(data), 'spacecraft', data, id);
export const destinationById = (data, id) => byId(destinationsOf(data), 'destinations', data, id);
export const calendarItem = (data, id) => byId(itemsOf(data), 'calendar', data, id);
export const calendarInstance = (state, id) => (state?.calendar || []).find((c) => c.id === id) || null;

/** {year, month (1-12)} -> turn. Data files use month base 1. */
function turnOfDate(d, startYear, data) {
  if (!d || d.year == null) return null;
  const base = data?.calendar?.monthBase ?? 1;
  const m = clamp(Math.round((d.month ?? base) - base), 0, 11);
  // ceil (not dateToTurn's round) so that formatTurn(turn) shows the same month back
  return (d.year - startYear) * WEEKS_PER_YEAR + Math.ceil(m * WEEKS_PER_MONTH);
}

function startYearOf(state, data) {
  return state?.startYear ?? data?.scenario?.startYear ?? 0;
}

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function newsText(data, key) {
  return data?.calendar?.news?.[key] ?? DEFAULT_NEWS[key] ?? '';
}

function actorName(state, data, id) {
  const a = state?.actors?.[id] || (data?.actors?.actors || []).find((x) => x.id === id);
  return a?.short || a?.name || id;
}

function milestoneLabel(data, mid) {
  const base = String(mid).split(':')[0];
  return data?.calendar?.milestoneLabels?.[base] || base.replace(/_/g, ' ');
}

const fmt = (state, data, turn) => formatTurn(turn, startYearOf(state, data));

function tensionBetween(state, a, b) {
  if (!a || !b || a === b) return 0;
  return state?.tension?.[relKey(a, b)] ?? 0;
}

function maxTensionOf(state, actorId) {
  let m = 0;
  for (const [k, v] of Object.entries(state?.tension || {})) {
    const [a, b] = k.split('|');
    if (a === actorId || b === actorId) m = Math.max(m, v || 0);
  }
  return m;
}

/** Sum of tech effects for an actor (player: research.unlocked; rivals: research.rivals[actor]). Mirrors research.techBonus. */
export function techBonusFor(state, data, actorId, key) {
  const ids = actorId === state?.playerId ? state?.research?.unlocked : state?.research?.rivals?.[actorId];
  if (!Array.isArray(ids)) return 0;
  let s = 0;
  for (const id of ids) {
    const node = data?.index?.tech?.[id] || (data?.tech?.nodes || []).find((n) => n.id === id);
    const v = node?.effects?.[key];
    if (typeof v === 'number') s += v;
  }
  return s;
}

// ---------------------------------------------------------------- outcome (with local fallback)

function fallbackQuickOutcome(rng, p, { failureWeights } = {}) {
  if (rng.next() < p) return { level: 'total', failureType: null };
  const r = rng.next();
  const level = r < 0.35 ? 'partial' : r < 0.7 ? 'recoverable' : 'catastrophic';
  return { level, failureType: pickFailureType(rng, failureWeights) };
}

function pickFailureType(rng, weights = ASCENT_WEIGHTS) {
  const items = FAILURE_TYPES.map((t) => ({ t, weight: weights?.[t] ?? 0 }));
  return rng.weighted(items)?.t || 'propulsion';
}

function quick(rng, p, opts) {
  const pp = clamp(p, 0.01, 0.995);
  try {
    const fn = outcomeMod?.quickOutcome;
    if (typeof fn === 'function') {
      const r = fn(rng, pp, opts);
      if (r && LEVEL_RANK[r.level] != null) return { level: r.level, failureType: r.level === 'total' ? null : (r.failureType || pickFailureType(rng, opts?.failureWeights)) };
    }
  } catch { /* fall through */ }
  return fallbackQuickOutcome(rng, pp, opts);
}

const worse = (a, b) => ((LEVEL_RANK[b?.level] ?? 0) > (LEVEL_RANK[a?.level] ?? 0) ? b : a);

// ---------------------------------------------------------------- catalog functions (contract)

/** Beta posterior from vehicleStats (seeded with real history) + estimated prior. */
export function vehicleReliability(state, data, vehicleId) {
  const v = vehicleById(data, vehicleId);
  const hf = v?.history?.flights || 0;
  const hx = v?.history?.failures || 0;
  const st = state?.vehicleStats?.[vehicleId] || { flights: hf, failures: hx };
  const est = v?.estimatedReliability ?? 0.9;
  const k = v?.estimatedReliability != null ? 8 : 2;
  const flights = Math.max(0, st.flights || 0);
  const failures = clamp(st.failures || 0, 0, flights);
  // historyWeight < 1 discounts early prototype flights (e.g. Starship test campaign) in favor of recent ones
  const hw = clamp(v?.historyWeight ?? 1, 0, 1);
  const gf = Math.max(0, flights - hf);
  const gx = clamp(failures - hx, 0, gf);
  const effOk = hw * (hf - hx) + (gf - gx);
  const effBad = hw * hx + gx;
  return betaSummary(est * k + Math.max(0, effOk), (1 - est) * k + Math.max(0, effBad), { flights, failures });
}

function betaSummary(a, b, extra = {}) {
  const n = a + b;
  const mean = n > 0 ? a / n : 0.5;
  const sd = Math.sqrt((mean * (1 - mean)) / (n + 1));
  return { mean, low: clamp(mean - 1.645 * sd, 0, 1), high: clamp(mean + 1.645 * sd, 0, 1), ...extra };
}

/** Spacecraft reliability: estimated prior + real history + in-game results (calendar and player missions). */
export function spacecraftReliability(state, data, spacecraftId) {
  const s = spacecraftById(data, spacecraftId);
  const est = s?.estimatedReliability ?? 0.85;
  const k = 8;
  let ok = (s?.history?.flights || 0) - (s?.history?.failures || 0);
  let bad = s?.history?.failures || 0;
  for (const inst of state?.calendar || []) {
    for (const h of inst.history || []) {
      if (!h.craftJudged) continue;
      const item = calendarItem(data, inst.id);
      if (item?.spacecraftId !== spacecraftId && item?.secondarySpacecraftId !== spacecraftId) continue;
      if (OK_LEVELS.includes(h.level)) ok++; else bad++;
    }
  }
  for (const m of state?.missions || []) {
    if ((m?.spacecraftId !== spacecraftId && m?.secondarySpacecraftId !== spacecraftId) || !m.result) continue;
    if (OK_LEVELS.includes(m.result.outcome)) ok++;
    else if (m.result.phase === 'arrival') bad++;
  }
  return betaSummary(est * k + Math.max(0, ok), (1 - est) * k + bad, { flights: Math.max(0, ok) + bad });
}

/** Payload (t) a vehicle can deliver to a destination (or to a raw capacity key). */
export function capacityTo(data, vehicleId, destinationId) {
  const v = vehicleById(data, vehicleId);
  if (!v?.capacity) return 0;
  const d = destinationById(data, destinationId);
  const key = d?.capacityKey || destinationId;
  const cap = (v.capacity[key] || 0) * (d?.capacityFactor ?? 1);
  return Math.round(cap * 100) / 100;
}

/** Window used by a calendar item: its own `window` (gravity-assist trajectories; `false` = none) or the destination's. */
export function itemWindow(data, item) {
  if (item && item.window !== undefined) return item.window || null;
  return destinationById(data, item?.destination)?.window || null;
}

/**
 * Next launch window. Destinations without window: {openTurn: fromTurn, closeTurn: Infinity}.
 * `item` (optional calendar item) lets a program fly its own trajectory window (`item.window`).
 */
export function nextWindow(state, data, destinationId, fromTurn, item) {
  const from = fromTurn ?? state?.turn ?? 0;
  const w = item ? itemWindow(data, item) : destinationById(data, destinationId)?.window;
  if (!w || !(w.periodWeeks > 0)) return { openTurn: from, closeTurn: Infinity, isOpen: true };
  const open = Math.max(1, w.openWeeks || 1);
  // smallest k with phase + k*period + open > from
  const k = Math.ceil((from - (w.phaseTurn || 0) - open + 1) / w.periodWeeks);
  const openTurn = (w.phaseTurn || 0) + k * w.periodWeeks;
  const closeTurn = openTurn + open;
  return { openTurn, closeTurn, isOpen: from >= openTurn && from < closeTurn };
}

function snapToWindow(state, data, destinationId, turn, item) {
  const w = nextWindow(state, data, destinationId, turn, item);
  return Math.max(turn, w.openTurn);
}

/** Record a flight of a vehicle (used by missions for the player and internally for rivals/background). */
export function recordFlight(state, vehicleId, success) {
  if (!state || !vehicleId) return;
  state.vehicleStats = state.vehicleStats || {};
  const st = (state.vehicleStats[vehicleId] = state.vehicleStats[vehicleId] || emptyStats());
  st.flights = (st.flights || 0) + 1;
  if (!success) st.failures = (st.failures || 0) + 1;
  st.lastFlightTurn = state.turn;
  st.yearFlights = (st.yearFlights || 0) + 1;
  st.quarterFlights = (st.quarterFlights || 0) + 1;
  st.gameFlights = (st.gameFlights || 0) + 1;
  if (!success) {
    st.groundedUntil = Math.max(st.groundedUntil ?? -1, state.turn + (st.standDownWeeks ?? 12));
    st.lastFailureTurn = state.turn;
  }
}

const emptyStats = () => ({ flights: 0, failures: 0, lastFlightTurn: null, groundedUntil: null, yearFlights: 0, quarterFlights: 0, gameFlights: 0, standDownWeeks: 12 });

export function isGrounded(state, vehicleId, turn) {
  const g = state?.vehicleStats?.[vehicleId]?.groundedUntil;
  return g != null && g > (turn ?? state?.turn ?? 0);
}

/** Turn from which a vehicle (or spacecraft) is in the catalog; null = not yet known (debut pending). */
export function availableTurnOf(state, data, item) {
  if (!item) return null;
  const sy = startYearOf(state, data);
  let t = turnOfDate(item.availableFrom, sy, data) ?? -Infinity;
  if (item.debutCalendarId) {
    const inst = calendarInstance(state, item.debutCalendarId);
    if (inst && inst.status !== 'player' && inst.status !== 'cancelled') {
      const firstOk = (inst.history || []).find((h) => h.vehicleOk);
      // player-flown debuts (missions writes the final status, without rival history)
      const okTurn = firstOk ? firstOk.turn : ['success', 'partial'].includes(inst.status) ? inst.resolvedTurn ?? inst.currentTurn : null;
      if (okTurn != null) t = Math.max(t, okTurn);
      else return null; // debut has not flown successfully yet
    }
  }
  return t;
}

function inCatalogAt(state, data, item, turn) {
  const from = availableTurnOf(state, data, item);
  if (from == null || turn < from) return false;
  if (item.availableUntil) {
    const until = turnOfDate(item.availableUntil, startYearOf(state, data), data);
    if (until != null && turn > until + 4) return false;
  }
  return true;
}

function inSameBloc(state, data, a, b) {
  const blocOf = (id) => state?.actors?.[id]?.bloc ?? (data?.actors?.actors || []).find((x) => x.id === id)?.bloc ?? null;
  const ba = blocOf(a);
  if (ba && ba === blocOf(b)) return true;
  for (const bloc of Object.values(state?.blocs || {})) {
    const mem = bloc?.members || [];
    if (mem.includes(a) && mem.includes(b)) return true;
  }
  return false;
}

// Only working agreements open hardware access; global norms (Outer Space Treaty, traffic rules) do not.
const ACCESS_TREATIES = ['mission_partnership', 'cost_sharing', 'crew_exchange', 'tech_transfer'];
function hasTreaty(state, a, b) {
  return (state?.treaties || []).some((t) => t?.status === 'active' && ACCESS_TREATIES.includes(t.type) && t.parties?.includes(a) && t.parties?.includes(b));
}

function actorDef(state, data, id) {
  return state?.actors?.[id] || (data?.actors?.actors || []).find((x) => x.id === id) || null;
}

/** Can `actorId` buy/use this catalog entry? → {ok, reason} (reason pt-BR when blocked). */
export function accessFor(state, data, actorId, item) {
  if (!item) return { ok: false, reason: 'desconhecido' };
  // one-off real probes already flying (BepiColombo, Psyche…): only their calendar program uses them, nobody builds another
  if (item.calendarOnly) return { ok: false, reason: 'Sonda única, já em voo: não dá para construir outra' };
  if (item.access === 'generic' || !item.operator) return { ok: true, reason: null };
  const ctrl = item.tensionActor || item.operator;
  if (ctrl === actorId || item.operator === actorId) return { ok: true, reason: null };
  if ((item.embargo || []).includes(actorId)) return { ok: false, reason: 'Embargo: o operador não vende para você' };
  const t = tensionBetween(state, actorId, ctrl);
  if (t >= 3) return { ok: false, reason: `Bloqueado pela tensão com ${actorName(state, data, ctrl)}` };
  if (item.access === 'own') return { ok: false, reason: 'Uso exclusivo do operador' };
  // national launch policy (NASA by law, CNSA and Roscosmos in practice): launchers must be domestic
  const me = actorDef(state, data, actorId);
  if (me?.launchPolicy === 'domestic' && item.capacity && item.country && me.country && !String(item.country).includes(me.country)) {
    return { ok: false, reason: 'Política nacional: só lançadores do próprio país' };
  }
  if (item.access === 'bloc' && !inSameBloc(state, data, actorId, ctrl) && !hasTreaty(state, actorId, ctrl)) {
    return { ok: false, reason: 'Só para o bloco e parceiros do operador' };
  }
  return { ok: true, reason: null };
}

/** True if a catalog item (vehicle or spacecraft) is still in service at `turn` (not before debut, not retired). */
export function inServiceAt(state, data, item, turn) {
  return !!item && inCatalogAt(state, data, item, turn);
}

export function availableVehicles(state, data, actorId) {
  const turn = state?.turn ?? 0;
  return vehiclesOf(data).filter((v) => inCatalogAt(state, data, v, turn) && accessFor(state, data, actorId, v).ok);
}

export function availableSpacecraft(state, data, actorId) {
  const turn = state?.turn ?? 0;
  return spacecraftOf(data).filter((s) => inCatalogAt(state, data, s, turn) && accessFor(state, data, actorId, s).ok);
}

/** Prerequisite status for a calendar item: {ok, pending: [id], failed: [id], cancelled: [id]}. */
export function prerequisiteStatus(state, data, calendarId) {
  const item = calendarItem(data, calendarId);
  const inst = calendarInstance(state, calendarId);
  const res = { ok: true, pending: [], failed: [], cancelled: [] };
  for (const pid of item?.prerequisites || []) {
    if ((inst?.waived || []).includes(pid)) continue;
    const s = itemProgress(state, data, pid);
    if (s === 'done' || s === 'missing') continue;
    res.ok = false;
    res[s === 'failed' ? 'failed' : s === 'cancelled' ? 'cancelled' : 'pending'].push(pid);
  }
  return res;
}

/** 'done' | 'pending' | 'failed' | 'cancelled' | 'missing' for any calendar item, rival or player-owned. */
function itemProgress(state, data, id) {
  const inst = calendarInstance(state, id);
  if (!inst) return 'missing';
  if (DONE.includes(inst.status)) return 'done';
  if (inst.status === 'cancelled') return 'cancelled';
  if (inst.status === 'failed') return 'failed';
  if (inst.status === 'player') {
    const m = (state.missions || []).find((x) => x?.calendarId === id);
    const dest = destinationById(data, calendarItem(data, id)?.destination);
    const needsArrival = (dest?.arrivalMilestones?.length || 0) > 0;
    if (m) {
      if (m.status === 'cancelled') return 'cancelled';
      const r = m.result;
      if (r && OK_LEVELS.includes(r.outcome) && (!needsArrival || r.phase === 'arrival' || ['operations', 'done'].includes(m.status))) return 'done';
      if (r && !OK_LEVELS.includes(r.outcome) && m.status === 'done') return 'failed';
    }
    if (inst.outcome && OK_LEVELS.includes(inst.outcome.level) && (!needsArrival || inst.outcome.phase === 'arrival')) return 'done';
    return 'pending';
  }
  return 'pending';
}

// ---------------------------------------------------------------- init

function newInstance(state, data, item) {
  const sy = startYearOf(state, data);
  const plannedTurn = turnOfDate(item.planned, sy, data) ?? 0;
  // a probe launched before the scenario: `planned` is the arrival, `launched` the real launch date
  if (item.inTransit) {
    const launchTurn = Math.min(plannedTurn - 1, turnOfDate(item.launched, sy, data) ?? plannedTurn - Math.max(1, destinationById(data, item.destination)?.transitWeeks || 1));
    return {
      id: item.id, plannedTurn, currentTurn: launchTurn,
      status: item.owner === state.playerId ? 'player' : 'launched',
      delayWeeks: 0, programDelayWeeks: 0, revisions: 0, outcome: null, resolvedTurn: null,
      launchTurn, arrivalTurn: plannedTurn, ascentLevel: 'total', inTransit: true, attempts: 0,
      history: [{ turn: launchTurn, level: 'total', phase: 'ascent', attempt: 0, vehicleOk: true, craftJudged: false }],
      waived: [], lastWaitNewsTurn: null,
    };
  }
  return {
    id: item.id,
    plannedTurn,
    currentTurn: snapToWindow(state, data, item.destination, plannedTurn, item),
    status: item.owner === state.playerId ? 'player' : 'planned',
    delayWeeks: 0,
    programDelayWeeks: 0,
    revisions: 0,
    outcome: null,
    resolvedTurn: null,
    launchTurn: null,
    arrivalTurn: null,
    attempts: 0,
    history: [],
    waived: [],
    lastWaitNewsTurn: null,
  };
}

function ensureSlices(state, data) {
  if (!state.vehicleStats || typeof state.vehicleStats !== 'object') state.vehicleStats = {};
  for (const v of vehiclesOf(data)) {
    if (!state.vehicleStats[v.id]) {
      state.vehicleStats[v.id] = { ...emptyStats(), flights: v.history?.flights || 0, failures: v.history?.failures || 0, standDownWeeks: v.standDownWeeks ?? 12 };
    }
  }
  if (!Array.isArray(state.calendar)) state.calendar = [];
  const have = new Set(state.calendar.map((c) => c.id));
  for (const item of itemsOf(data)) {
    if (have.has(item.id)) continue;
    const inst = newInstance(state, data, item);
    // an old save meets a probe that was added later and already arrived: it is history, not news
    if (inst.inTransit && inst.arrivalTurn < (state.turn ?? 0)) settleAsHistory(state, data, inst, item);
    state.calendar.push(inst);
  }
}

/** Resolve an in-transit item whose arrival is already in the past (old save): success at arrivalTurn, no news, no prestige. */
function settleAsHistory(state, data, inst, item) {
  const turn = inst.arrivalTurn;
  inst.status = 'success';
  inst.outcome = { level: 'total', failureType: null, phase: 'arrival' };
  inst.resolvedTurn = turn;
  inst.currentTurn = inst.launchTurn;
  inst.history.push({ turn, level: 'total', phase: 'arrival', attempt: 0, vehicleOk: true, craftJudged: true, retro: true });
  // the feat is recorded with its real date if nobody claimed it since (points were never part of this save)
  state.firsts = state.firsts || {};
  for (const mid of milestonesFor(state, data, item)) {
    if (state.firsts[mid]) continue;
    state.firsts[mid] = isHistoricFirst(state, mid) ? { actorId: item.owner, turn, era: true } : { actorId: item.owner, turn };
  }
}

export function init(state, data, _ctx) {
  state.vehicleStats = {};
  state.calendar = [];
  ensureSlices(state, data);
  state.stats = state.stats || {};
  state.stats['calendar.backgroundLaunches'] = 0;
  state.stats['calendar.slips'] = 0;
}

// ---------------------------------------------------------------- tick

export function tick(state, data, ctx) {
  ensureSlices(state, data);
  readSignals(state, data);
  const turn = state.turn;
  for (const inst of state.calendar) {
    const item = calendarItem(data, inst.id);
    if (!item) continue;
    try {
      if (inst.status === 'planned') {
        const ahead = inst.currentTurn - turn;
        if (ahead >= 3 && ahead <= REVISION_HORIZON && (turn + (hash32(inst.id) % REVISION_PERIOD)) % REVISION_PERIOD === 0) {
          reviseSchedule(state, data, inst, item, ctx.rng(`rev:${inst.id}`));
        }
        if (inst.status === 'planned' && turn >= inst.currentTurn) tryLaunch(state, data, inst, item, ctx.rng(`launch:${inst.id}:${inst.attempts}`));
      } else if (inst.status === 'launched' && inst.arrivalTurn != null && turn >= inst.arrivalTurn) {
        resolveArrival(state, data, inst, item, ctx.rng(`arrive:${inst.id}:${inst.attempts}`));
      }
    } catch (e) {
      log(state, `calendar: falha ao processar ${inst.id}: ${e.message}`);
    }
  }
  backgroundLaunches(state, data, ctx);
  rivalOps(state, data, ctx);
  rivalProgramPrestige(state, data);
  periodicSummaries(state, data);
}

// ---------------------------------------------------------------- rival discretionary missions
// Rivals fly more than their scripted calendar (GDD pillar "O universo reage"): every month an AI with spare cash
// may fly a goal-driven mission of its own, weighted toward the player's latest first. Resolved with quickOutcome
// (launch now, arrival after the transit), scored on the player's prestige scale, paid from the AI's cash.
// Slice: state.rivalOps = { pending: [{actorId, destination, vehicleId, spacecraftId, arriveTurn, cost}], flights: {actorId: {destId: n}}, react }.

const OPS_PERIOD = 4;
const OPS_CASH_SHARE = 0.2;   // share of cash (plus OPS_BUDGET_SHARE of the yearly budget) a rival puts into its own missions per year
const OPS_BUDGET_SHARE = 0.05;
const OPS_REACT_WEEKS = 26;   // how long the player's latest first steers the rivals' choices
const GOAL_DEST = {
  lunar_south_pole_landing: 'lunar_south_pole', lunar_surface_robotic: 'lunar_surface', lunar_resource_demo: 'lunar_south_pole',
  lunar_sample_return: 'lunar_surface', mars_landing_robotic: 'mars_surface', jupiter_arrival: 'jupiter', titan_arrival: 'titan',
};
/** Destination that awards a robotic goal: the fixed table first, then any destination whose robotic firsts include it. */
function goalDest(data, goal) {
  if (GOAL_DEST[goal]) return GOAL_DEST[goal];
  return destinationsOf(data).find((d) => [].concat(d.firsts?.robotic ?? []).includes(goal))?.id || null;
}
const OPS_DEFAULTS = [{ destination: 'lunar_orbit', weight: 1.2 }, { destination: 'sso', weight: 0.8 }, { destination: 'mars_orbit', weight: 0.8 }, { destination: 'lunar_surface', weight: 0.8 }];
const OPS_SCALE = { leo: 1, gto: 1.2, tli: 1.6, mars: 2.4, outer: 4 };
const OPS_COST = { leo: 6, gto: 5, tli: 35, mars: 60, outer: 90 };

function opsSlice(state) {
  if (!state.rivalOps || typeof state.rivalOps !== 'object') state.rivalOps = { pending: [], flights: {}, react: null };
  state.rivalOps.pending ||= [];
  state.rivalOps.flights ||= {};
  return state.rivalOps;
}

/** Cheapest generic spacecraft + vehicle an actor can fly to a destination right now, with its cost. */
function opsConfig(state, data, actorId, destId) {
  const dest = destinationById(data, destId);
  if (!dest) return null;
  const kinds = dest.kind === 'surface' ? ['lander'] : dest.body === 'earth' ? ['satellite'] : ['probe'];
  const scs = availableSpacecraft(state, data, actorId)
    .filter((s) => s.access === 'generic' && kinds.includes(s.kind) && (!s.destinations?.length || s.destinations.includes(destId)))
    .sort((a, b) => (a.costM || 0) - (b.costM || 0));
  const sc = scs[0];
  if (!sc) return null;
  let best = null;
  for (const v of availableVehicles(state, data, actorId)) {
    if (capacityTo(data, v.id, destId) * 0.9 < (sc.massT || 1) || isGrounded(state, v.id)) continue;
    if (!best || (v.costM || 0) < (best.costM || 0)) best = v;
  }
  if (!best) return null;
  const cost = Math.round((best.costM || 0) + (sc.costM || 0) * (OPS_SCALE[dest.capacityKey] ?? 1) + (OPS_COST[dest.capacityKey] ?? 10));
  return { dest, sc, v: best, cost };
}

function opsFirsts(dest) {
  return [].concat(dest?.firsts?.robotic ?? []);
}

/** The player's firsts make rivals that chase the same goal react: their related programs speed up. */
function opsReact(state, data, ctx) {
  const ops = opsSlice(state);
  for (const s of state.signals || []) {
    if (s?.type !== 'first' || s.actorId !== state.playerId || String(s.milestoneId).includes(':')) continue;
    ops.react = { milestoneId: s.milestoneId, untilTurn: state.turn + OPS_REACT_WEEKS };
    const body = destinationsOf(data).find((d) => [].concat(d.firsts?.crewed ?? [], d.firsts?.robotic ?? []).includes(s.milestoneId))?.body;
    const rng = ctx.rng(`react:${s.milestoneId}`);
    let told = false;
    for (const inst of state.calendar || []) {
      if (inst.status !== 'planned') continue;
      const item = calendarItem(data, inst.id);
      const owner = item?.owner;
      const a = state.actors?.[owner];
      if (!item || !a || owner === state.playerId) continue;
      const chases = (a.ai?.goals || []).includes(s.milestoneId) || item.milestone === s.milestoneId;
      if (!chases || destinationById(data, item.destination)?.body !== body) continue;
      const floor = Math.max(state.turn + 3, (inst.plannedTurn ?? inst.currentTurn) - 8);
      const to = Math.max(floor, inst.currentTurn - rng.int(4, 8));
      if (to >= inst.currentTurn) continue;
      inst.currentTurn = to;
      inst.accelerated = (inst.accelerated || 0) + 1;
      if (!told) {
        told = true;
        addNews(state, {
          headline: `Resposta da ${actorName(state, data, owner)}: ${item.name} é antecipada para ${fmt(state, data, to)}`,
          body: 'Depois do feito do rival, o governo libera horas extras e verba de emergência.',
          tags: ['calendar', 'race'], actors: [owner, state.playerId], importance: 2, icon: '⏩',
        });
      }
    }
  }
}

function rivalOps(state, data, ctx) {
  const ops = opsSlice(state);
  opsReact(state, data, ctx);
  // arrivals of missions launched earlier
  for (const p of ops.pending.slice()) {
    if (!p.launched || state.turn < p.arriveTurn) continue;
    ops.pending.splice(ops.pending.indexOf(p), 1);
    if (!p.lost) opsArrive(state, data, p, ctx.rng(`opsArrive:${p.actorId}:${p.launchTurn}`));
  }
  // launches of missions committed earlier (a new mission takes months to build)
  for (const p of ops.pending) {
    if (p.launched || state.turn < p.launchTurn) continue;
    p.launched = true;
    const rngL = ctx.rng(`opsLaunch:${p.actorId}:${p.launchTurn}`);
    const v = vehicleById(data, p.vehicleId);
    if (!v || !inCatalogAt(state, data, v, state.turn) || isGrounded(state, v.id)) { p.arriveTurn = state.turn; p.lost = true; continue; }
    const asc = quick(rngL, clamp(vehicleSuccessP(state, data, v.id, p.actorId), 0.3, 0.995), { failureWeights: ASCENT_WEIGHTS });
    recordFlight(state, v.id, OK_LEVELS.includes(asc.level));
    if (!OK_LEVELS.includes(asc.level)) { p.arriveTurn = state.turn; p.lost = true; continue; } // the background feed covers launch failures
    p.arriveTurn = state.turn + Math.max(0, destinationById(data, p.destination)?.transitWeeks || 0);
  }
  const tun = data?.calendar?.rivalOps || {};
  if (tun.enabled === false || state.turn % OPS_PERIOD !== 2 || state.turn < (tun.startTurn ?? 8)) return;
  const react = ops.react && ops.react.untilTurn > state.turn ? ops.react : null;
  for (const id of Object.keys(state.actors || {}).sort()) {
    const a = state.actors[id];
    if (id === state.playerId || !a || !(a.budget > 0) || ops.pending.some((p) => p.actorId === id)) continue;
    const reserve = a.budget * 0.1;
    const spare = (a.cash || 0) - reserve;
    if (spare <= 0) continue;
    const rng = ctx.rng(`ops:${id}`);
    const options = [...OPS_DEFAULTS];
    for (const g of a.ai?.goals || []) { const gd = goalDest(data, g); if (gd) options.push({ destination: gd, weight: state.firsts?.[g] ? 1.2 : 3 }); }
    if (react && (a.ai?.goals || []).includes(react.milestoneId) && goalDest(data, react.milestoneId)) options.push({ destination: goalDest(data, react.milestoneId), weight: 4 });
    // the scripted program already covers a destination it flies to within two years
    const scripted = new Set((state.calendar || []).filter((c) => c.status === 'planned' && c.currentTurn - state.turn <= 104 && calendarItem(data, c.id)?.owner === id).map((c) => calendarItem(data, c.id)?.destination));
    const build = (o) => (destinationById(data, o.destination)?.kind === 'surface' ? 39 : 26);
    const open = options.filter((o) => {
      if (scripted.has(o.destination)) return false;
      const w = destinationById(data, o.destination)?.window;
      // planetary targets: commit now only if a window opens when the hardware is ready
      return !w || nextWindow(state, data, o.destination, state.turn + build(o)).openTurn <= state.turn + build(o) + 8;
    });
    const pick = rng.weighted(open);
    const cfg = pick ? opsConfig(state, data, id, pick.destination) : null;
    if (!cfg || cfg.cost > spare) continue;
    const yearly = (tun.cashShare ?? OPS_CASH_SHARE) * spare + (tun.budgetShare ?? OPS_BUDGET_SHARE) * a.budget;
    // monthly decision: expected yearly spend / (12 decisions a year) / cost
    if (!rng.chance(clamp(yearly / (52 / OPS_PERIOD) / cfg.cost, 0, 0.45))) continue;
    changeActor(state, id, 'cash', -cfg.cost);
    state.stats['calendar.rivalOps'] = (state.stats['calendar.rivalOps'] || 0) + 1;
    let launchTurn = state.turn + build(pick);
    if (cfg.dest.window) launchTurn = Math.max(launchTurn, nextWindow(state, data, cfg.dest.id, launchTurn).openTurn);
    ops.pending.push({ actorId: id, destination: cfg.dest.id, vehicleId: cfg.v.id, spacecraftId: cfg.sc.id, launchTurn, arriveTurn: null, cost: cfg.cost });
  }
}

function opsArrive(state, data, p, rng) {
  const dest = destinationById(data, p.destination);
  const ops = opsSlice(state);
  const owner = p.actorId;
  let pc = spacecraftReliability(state, data, p.spacecraftId).mean + 0.5 * techBonusFor(state, data, owner, 'reliability');
  if (dest?.kind === 'surface') pc += techBonusFor(state, data, owner, 'landingReliability') - (dest.body === 'mars' ? 0.1 : 0.05);
  const o = quick(rng, clamp(pc, 0.3, 0.99), { failureWeights: arrivalWeights(dest) });
  const flown = (ops.flights[owner] ||= {});
  const repeats = flown[p.destination] || 0;
  if (!OK_LEVELS.includes(o.level)) {
    if (dest?.body !== 'earth') {
      addNews(state, { headline: `Missão da ${actorName(state, data, owner)} se perde em ${dest?.name || p.destination}`, tags: ['calendar', 'failure'], actors: [owner], importance: 1, icon: '💥' });
    }
    return;
  }
  flown[p.destination] = repeats + 1;
  const mp = scorePrestige(dest, { crewed: false, level: o.level, p: 0.8, repeats });
  changeActor(state, owner, 'prestige', mp.prestige);
  for (const mid of opsFirsts(dest)) {
    if (claimFirst(state, mid, owner, mp.firstPoints, 5)) {
      emitSignal(state, 'first', { milestoneId: mid, actorId: owner });
      addNews(state, {
        headline: fill(newsText(data, isHistoricFirst(state, mid) ? 'firstEra' : 'first') || newsText(data, 'first'), { owner: actorName(state, data, owner), milestone: milestoneLabel(data, mid) }),
        tags: ['first'], actors: [owner], importance: 3, icon: '🏁',
      });
    }
  }
}

/** Prestige on the player's scale (core/outcome.js), with a local fallback. */
function scorePrestige(dest, opts) {
  const f = outcomeMod?.missionPrestige;
  if (typeof f === 'function') return f(dest, opts);
  const base = (dest?.prestige ?? 5) * (opts.crewed ? 1.8 : 1);
  return { base, prestige: OK_LEVELS.includes(opts.level) ? Math.round(base * (opts.level === 'total' ? 1 : 0.45)) : 0, firstPoints: 30 + Math.round(base) };
}

/**
 * Rivals do far more than their headline calendar items (crew rotations, science, satellites):
 * a small weekly prestige drip, proportional to budget and public support, keeps the Tabela da Era contested.
 * Tunable in data/calendar.json "rivalProgramPrestige" (points per US$ 1 bi of budget per year).
 */
function rivalProgramPrestige(state, data) {
  const rate = data?.calendar?.rivalProgramPrestige ?? 1.0;
  if (!(rate > 0)) return;
  for (const [id, a] of Object.entries(state.actors || {})) {
    if (id === state.playerId || !(a?.budget > 0)) continue;
    const mood = clamp((a.support ?? 50) / 60, 0.5, 1.4);
    changeActor(state, id, 'prestige', ((a.budget / 1000) * rate * mood) / WEEKS_PER_YEAR);
  }
}

/** Mirror the player's results on their own calendar items (status stays 'player'). */
function readSignals(state, data) {
  for (const s of state.signals || []) {
    // open war (politics/suspension): joint programs between the two sides end at once
    if (s?.type === 'politics/suspension') {
      for (const inst of state.calendar || []) {
        if (inst.status !== 'planned') continue;
        const item = calendarItem(data, inst.id);
        if (item && (item.partners || []).some((p) => tensionBetween(state, item.owner, p) >= 4)) cancel(state, data, inst, item, 'war');
      }
      continue;
    }
    if (s?.type !== 'mission/resolved' || !s.calendarId || s.actorId !== state.playerId) continue;
    const inst = calendarInstance(state, s.calendarId);
    if (!inst || inst.status !== 'player') continue;
    inst.outcome = { level: s.outcome, failureType: s.failureType ?? null, phase: s.phase ?? null };
    inst.resolvedTurn = s.turn ?? state.turn;
  }
}

// ---------------------------------------------------------------- schedule revisions

function slipMultiplier(state, data, item) {
  const owner = item.owner;
  const a = state.actors?.[owner];
  let m = 1;
  if (a) {
    if (a.support != null && a.support < 30) m *= 1.35;
    else if (a.support != null && a.support > 75) m *= 0.85;
    if (a.cash != null && a.cash < 0) m *= 1.5;
    if (typeof a.culture === 'number') m *= 1 - clamp(a.culture, -100, 100) / 400; // bold agencies push harder
  }
  if (state.world?.economy?.[owner]?.crisis) m *= 1.4;
  const stance = state.politics?.[owner]?.stance;
  if (typeof stance === 'number' && stance < -0.3) m *= 1.3;
  for (const p of item.partners || []) if (tensionBetween(state, owner, p) >= 2) { m *= 1.3; break; }
  m *= 1 - clamp(techBonusFor(state, data, owner, 'delayReduction'), 0, 0.6);
  return clamp(m, 0.2, 3);
}

function reviseSchedule(state, data, inst, item, rng) {
  const d = item.delay || {};
  inst.revisions++;
  // open war (tension 4) between the owner and anyone: programs get suspended or cancelled
  if (maxTensionOf(state, item.owner) >= 4) {
    if (rng.chance(0.06 + (d.cancelChance || 0))) return cancel(state, data, inst, item, 'war');
    if (rng.chance(0.35)) {
      const w = rng.int(26, 52);
      return applySlip(state, data, inst, item, w, 'suspended', rng);
    }
  }
  if (d.cancelChance && rng.chance(d.cancelChance * slipMultiplier(state, data, item))) return cancel(state, data, inst, item, 'review');
  const p = clamp((d.slipChance || 0) * slipMultiplier(state, data, item), 0, 0.95);
  if (!(p > 0) || !rng.chance(p)) return;
  const maxW = Math.round((d.maxMonths ?? 24) * WEEKS_PER_MONTH) - (inst.programDelayWeeks || 0);
  if (maxW < 1) return;
  const months = clamp(rng.normal(d.meanMonths ?? 3, d.sdMonths ?? 2), 0.5, (d.meanMonths ?? 3) + 3 * (d.sdMonths ?? 2));
  const weeks = Math.min(maxW, Math.max(1, Math.round(months * WEEKS_PER_MONTH)));
  inst.programDelayWeeks = (inst.programDelayWeeks || 0) + weeks;
  applySlip(state, data, inst, item, weeks, 'delayed', rng);
}

/**
 * Move an instance later by `weeks` (or to `opts.toTurn`). Handles launch windows: if the new date misses the
 * current window, window-bound programs usually absorb the slip (crunch) unless the slip is too big; otherwise the
 * mission waits for the next window. Writes news (scaled by importance) and emits calendar/delayed.
 */
function applySlip(state, data, inst, item, weeks, kind, rng, opts = {}) {
  const old = inst.currentTurn;
  let target = opts.toTurn != null ? Math.max(opts.toTurn, old + 1) : old + Math.max(1, Math.round(weeks));
  let missedWindow = false;
  const dest = destinationById(data, item.destination);
  if (itemWindow(data, item)) {
    const cur = nextWindow(state, data, item.destination, old, item);
    if (target >= cur.closeTurn && old < cur.closeTurn) {
      const discipline = item.delay?.windowDiscipline ?? 0.85;
      // planetary windows are hard deadlines: teams crunch to make them when the slip is modest
      if (kind === 'delayed' && rng && target - cur.closeTurn < 26 && rng.chance(discipline)) {
        target = cur.closeTurn - 1;
        if (target <= old) return; // the team absorbs the whole slip to keep the window
      }
    }
    const snapped = snapToWindow(state, data, item.destination, target, item);
    // a once-in-a-decade window (Apophis 2029) is not "postponed ten years": the rival program is cancelled
    if (snapped > target && (itemWindow(data, item)?.periodWeeks || 0) >= ONE_OFF_WINDOW_WEEKS && inst.status !== 'player') {
      return cancel(state, data, inst, item, 'windowLost', { date: fmt(state, data, snapped) });
    }
    if (snapped > target) {
      missedWindow = true;
      // a missed window gives the team years of margin: it eats the program's remaining slip budget
      inst.programDelayWeeks = (inst.programDelayWeeks || 0) + (snapped - target);
    }
    target = snapped;
  }
  const delta = target - old;
  if (delta <= 0) return;
  inst.currentTurn = target;
  inst.delayWeeks = target - inst.plannedTurn;
  state.stats['calendar.slips'] = (state.stats['calendar.slips'] || 0) + 1;
  emitSignal(state, 'calendar/delayed', { calendarId: inst.id, weeks: delta, reason: kind });

  const vars = {
    name: item.name, date: fmt(state, data, target), planned: fmt(state, data, inst.plannedTurn), weeks: weeksToText(delta),
    vehicle: vehicleById(data, item.vehicleId)?.name || item.vehicleId, prereq: opts.prereqName || '', owner: actorName(state, data, item.owner),
  };
  const key = missedWindow && kind !== 'suspended' ? 'windowMissed' : kind;
  const imp = item.importance || 1;
  // low news volume: small slips of minor items stay silent (the signal still goes out)
  if (kind === 'prereqWait') {
    if (inst.lastWaitNewsTurn != null && state.turn - inst.lastWaitNewsTurn < 26) return;
    inst.lastWaitNewsTurn = state.turn;
  }
  const loud = missedWindow || kind === 'suspended' || kind === 'prereqFailed';
  if (!loud && !(imp >= 2 && delta >= 4) && delta < 13) return;
  const bodyKey = `${key}Body`;
  addNews(state, {
    headline: fill(newsText(data, key), vars),
    body: fill(newsText(data, bodyKey) || newsText(data, 'delayedBody'), vars),
    tags: ['calendar', 'delay', kind],
    actors: [item.owner, ...(item.partners || [])],
    importance: (loud && imp >= 2) || (imp >= 3 && delta >= 8) ? 2 : 1,
    icon: '⏳',
  });
}

function cancel(state, data, inst, item, reason, extra = {}) {
  inst.status = 'cancelled';
  inst.resolvedTurn = state.turn;
  emitSignal(state, 'calendar/delayed', { calendarId: inst.id, weeks: 0, reason: 'cancelled' });
  const vars = { name: item.name, owner: actorName(state, data, item.owner) };
  const lost = reason === 'windowLost';
  addNews(state, {
    headline: fill(newsText(data, lost ? 'windowLost' : 'cancelled'), vars),
    body: fill(reason === 'war' ? newsText(data, 'suspendedBody') : newsText(data, lost ? 'windowLostBody' : 'cancelledBody'), { ...vars, date: '-', ...extra }),
    tags: ['calendar', 'cancelled'], actors: [item.owner, ...(item.partners || [])],
    importance: clamp(item.importance || 1, 1, 2), icon: '✖️',
  });
  changeActor(state, item.owner, 'support', -(item.importance || 1));
}

// ---------------------------------------------------------------- launch and arrival

function tryLaunch(state, data, inst, item, rng) {
  const turn = state.turn;
  // 1. fleet grounded after a failure (return to flight)
  const st = state.vehicleStats[item.vehicleId];
  if (isGrounded(state, item.vehicleId)) {
    return applySlip(state, data, inst, item, 0, 'grounded', rng, { toTurn: st.groundedUntil + rng.int(1, 4) });
  }
  // 2. prerequisites
  for (const pid of item.prerequisites || []) {
    if ((inst.waived || []).includes(pid)) continue;
    const s = itemProgress(state, data, pid);
    if (s === 'done' || s === 'missing') continue;
    const pItem = calendarItem(data, pid);
    const pInst = calendarInstance(state, pid);
    const prereqName = pItem?.name || pid;
    if (s === 'pending') {
      const ref = pInst?.status === 'launched' ? pInst.arrivalTurn : pInst?.status === 'planned' ? pInst.currentTurn : turn;
      const toTurn = Math.max(turn + 4, (ref ?? turn) + PREREQ_GAP_WEEKS);
      return applySlip(state, data, inst, item, 0, 'prereqWait', rng, { toTurn, prereqName });
    }
    // failed for good or cancelled: the program adapts, at a cost in time
    inst.waived = [...(inst.waived || []), pid];
    const w = s === 'failed' ? rng.int(13, 39) : rng.int(8, 26);
    return applySlip(state, data, inst, item, w, s === 'failed' ? 'prereqFailed' : 'delayed', rng, { prereqName });
  }
  // 3. planetary window (may have closed after a grounding)
  const win = nextWindow(state, data, item.destination, turn, item);
  if (!win.isOpen) return applySlip(state, data, inst, item, 0, 'windowMissed', rng, { toTurn: win.openTurn });
  // 4. last-week scrub (never for historical facts)
  const historical = item.truthLayer === 'fato' && item.historicalOutcome;
  if (!historical && rng.chance(SCRUB_CHANCE)) {
    const w = rng.int(1, 2);
    if (win.closeTurn === Infinity || turn + w < win.closeTurn) {
      inst.currentTurn += w;
      inst.delayWeeks = inst.currentTurn - inst.plannedTurn;
      emitSignal(state, 'calendar/delayed', { calendarId: inst.id, weeks: w, reason: 'scrub' });
      return;
    }
  }
  launch(state, data, inst, item, rng);
}

function vehicleSuccessP(state, data, vehicleId, actorId) {
  return vehicleReliability(state, data, vehicleId).mean + techBonusFor(state, data, actorId, 'reliability');
}

function craftSuccessP(state, data, item) {
  const dest = destinationById(data, item.destination);
  let p = spacecraftReliability(state, data, item.spacecraftId).mean;
  if (item.secondarySpacecraftId) p *= spacecraftReliability(state, data, item.secondarySpacecraftId).mean;
  p += 0.5 * techBonusFor(state, data, item.owner, 'reliability');
  if (dest?.kind === 'surface') p += techBonusFor(state, data, item.owner, 'landingReliability');
  if (item.crewed) p += 0.5 * techBonusFor(state, data, item.owner, 'crewSafety');
  return p;
}

function arrivalWeights(dest) {
  const w = {};
  for (const m of dest?.arrivalMilestones || []) for (const t of FAILURE_TYPES) w[t] = (w[t] || 0) + (m.failureWeights?.[t] || 0);
  return Object.keys(w).length ? w : ASCENT_WEIGHTS;
}

function launch(state, data, inst, item, rng) {
  const turn = state.turn;
  const historical = item.truthLayer === 'fato' && item.historicalOutcome;
  const n = Math.max(1, item.launches || 1);
  let ascent = { level: 'total', failureType: null };
  let vehicleOk = true;
  for (let i = 0; i < n; i++) {
    const o = historical ? { level: 'total', failureType: null } : quick(rng, vehicleSuccessP(state, data, item.vehicleId, item.owner), { failureWeights: ASCENT_WEIGHTS, crewed: !!item.crewed });
    const ok = OK_LEVELS.includes(o.level);
    recordFlight(state, item.vehicleId, ok);
    ascent = worse(ascent, o);
    if (!ok) { vehicleOk = false; break; }
  }
  inst.launchTurn = turn;
  emitSignal(state, 'mission/launched', { calendarId: inst.id, actorId: item.owner });
  if (!vehicleOk) return finish(state, data, inst, item, ascent, 'ascent', rng, { vehicleOk: false, craftJudged: false });

  const dest = destinationById(data, item.destination);
  const hasArrival = (dest?.arrivalMilestones?.length || 0) > 0;
  if (!hasArrival) {
    const o2 = historical ? { level: 'total', failureType: null } : quick(rng, craftSuccessP(state, data, item), { failureWeights: ASCENT_WEIGHTS, crewed: !!item.crewed });
    return finish(state, data, inst, item, worse(ascent, o2), 'ascent', rng, { vehicleOk: true, craftJudged: true });
  }
  inst.status = 'launched';
  inst.ascentLevel = ascent.level;
  inst.arrivalTurn = turn + Math.max(1, dest.transitWeeks || 1);
  inst.history.push({ turn, level: ascent.level, phase: 'ascent', attempt: inst.attempts, vehicleOk: true, craftJudged: false });
  const imp = item.importance || 1;
  if (imp >= 2 || (dest.transitWeeks || 0) > 4) {
    const vars = { name: item.name, owner: actorName(state, data, item.owner), vehicle: vehicleById(data, item.vehicleId)?.name || item.vehicleId, date: fmt(state, data, inst.arrivalTurn) };
    addNews(state, {
      headline: fill(newsText(data, 'launched'), vars), body: fill(newsText(data, 'launchedBody'), vars),
      tags: ['calendar', 'launch'], actors: [item.owner, ...(item.partners || [])], importance: clamp(imp - 1, 1, 2), icon: '🚀',
    });
  }
}

function resolveArrival(state, data, inst, item, rng) {
  const historical = item.truthLayer === 'fato' && item.historicalOutcome;
  const dest = destinationById(data, item.destination);
  const o2 = historical ? { level: 'total', failureType: null } : quick(rng, craftSuccessP(state, data, item), { failureWeights: arrivalWeights(dest), crewed: !!item.crewed });
  finish(state, data, inst, item, worse({ level: inst.ascentLevel || 'total', failureType: null }, o2), 'arrival', rng, { vehicleOk: true, craftJudged: true });
}

/** Milestones claimed on success: explicit item milestone + destination first (crewed/robotic). */
function milestonesFor(state, data, item) {
  const dest = destinationById(data, item.destination);
  const list = [];
  const add = (m) => {
    if (!m) return;
    if (m === 'crewed_orbit_national') {
      // per-actor first; agencies that already flew people before the scenario do not get it again
      const a = (data?.actors?.actors || []).find((x) => x.id === item.owner);
      if (a?.capabilities?.crewed) return;
      m = `crewed_orbit_national:${item.owner}`;
    }
    if (!list.includes(m)) list.push(m);
  };
  add(item.milestone);
  // a destination may award several firsts (a south pole landing is also a lunar landing)
  for (const f of [].concat(dest?.firsts?.[item.crewed ? 'crewed' : 'robotic'] ?? [])) add(f);
  return list;
}

function finish(state, data, inst, item, outcome, phase, rng, flags) {
  const turn = state.turn;
  const level = outcome.level;
  const ok = OK_LEVELS.includes(level);
  inst.outcome = { level, failureType: ok && level === 'total' ? null : outcome.failureType || null, phase };
  inst.resolvedTurn = turn;
  inst.status = level === 'total' ? 'success' : level === 'partial' ? 'partial' : 'failed';
  inst.history.push({ turn, level, phase, attempt: inst.attempts, vehicleOk: flags.vehicleOk, craftJudged: flags.craftJudged });
  const owner = item.owner;
  const imp = item.importance || 1;
  emitSignal(state, 'mission/resolved', {
    calendarId: inst.id, actorId: owner, destination: item.destination, missionType: item.type, crewed: !!item.crewed,
    outcome: level, failureType: inst.outcome.failureType, phase,
  });
  const vars = { name: item.name, owner: actorName(state, data, owner), vehicle: vehicleById(data, item.vehicleId)?.name || item.vehicleId };
  const actors = [owner, ...(item.partners || [])];

  if (ok) {
    addNews(state, {
      headline: fill(newsText(data, level === 'total' ? 'success' : 'partial'), vars),
      body: item.description || '', tags: ['calendar', 'result', 'success'], actors, importance: clamp(imp, 1, 3), icon: '✅',
    });
    // same feat, same points: the player's prestige scale (destination difficulty, crew, novelty), with a floor for
    // flagship items whose value is not in the destination (a space telescope in LEO)
    const repeats = (state.calendar || []).filter((c) => c !== inst && DONE.includes(c.status) && calendarItem(data, c.id)?.owner === owner
      && calendarItem(data, c.id)?.destination === item.destination && !!calendarItem(data, c.id)?.crewed === !!item.crewed).length;
    const mp = scorePrestige(destinationById(data, item.destination), { crewed: !!item.crewed, level, p: 0.8, repeats });
    const share = item.inTransit ? inheritedShare(data) : 1;
    changeActor(state, owner, 'prestige', Math.round(share * Math.max(mp.prestige, level === 'total' ? imp * 3 : imp * 1.5)));
    changeActor(state, owner, 'support', level === 'total' ? imp : 0);
    changeActor(state, owner, 'reputation', level === 'total' ? 1 : 0);
    for (const mid of milestonesFor(state, data, item)) {
      const first = claimFirst(state, mid, owner, Math.round(mp.firstPoints * share), Math.round(5 * share));
      if (first) {
        emitSignal(state, 'first', { milestoneId: mid, actorId: owner, calendarId: inst.id });
        addNews(state, {
          headline: fill(newsText(data, isHistoricFirst(state, mid) ? 'firstEra' : 'first') || newsText(data, 'first'), { ...vars, milestone: milestoneLabel(data, mid) }),
          body: item.name, tags: ['first'], actors, importance: 3, icon: '🏁',
        });
      }
    }
    // a successful debut puts a new vehicle in the catalog
    for (const v of vehiclesOf(data)) {
      if (v.debutCalendarId === inst.id && flags.vehicleOk) {
        addNews(state, { headline: fill(newsText(data, 'debut'), { vehicle: v.name }), body: v.notes || '', tags: ['catalog'], actors: [v.operator], importance: 1, icon: '🚀' });
      }
    }
    return;
  }

  // failure
  const lostCrew = item.crewed && level === 'catastrophic';
  changeActor(state, owner, 'support', lostCrew ? -10 : -2 * imp);
  changeActor(state, owner, 'reputation', lostCrew ? -6 : -imp);
  addNews(state, {
    headline: fill(newsText(data, lostCrew ? 'lostCrew' : 'failed'), vars),
    body: lostCrew ? fill(newsText(data, 'lostCrewBody'), vars) : item.description || '',
    tags: ['calendar', 'result', 'failure'], actors, importance: lostCrew ? 3 : clamp(Math.max(2, imp), 1, 3), icon: lostCrew ? '🕯️' : '💥',
  });
  if (lostCrew) {
    for (const other of state.calendar) {
      const oi = calendarItem(data, other.id);
      if (other.status !== 'planned' || oi?.owner !== owner || !oi.crewed) continue;
      const toTurn = turn + CREWED_STANDDOWN_WEEKS + rng.int(0, 26);
      if (other.currentTurn < toTurn) applySlip(state, data, other, oi, 0, 'suspended', rng, { toTurn });
    }
  }
  // test/demo flights are flown again
  if (item.refly && inst.attempts < MAX_REFLIGHTS) {
    inst.attempts++;
    inst.status = 'planned';
    inst.arrivalTurn = null;
    inst.ascentLevel = null;
    inst.currentTurn = snapToWindow(state, data, item.destination, turn + rng.int(16, 40), item);
    inst.delayWeeks = inst.currentTurn - inst.plannedTurn;
    addNews(state, {
      headline: fill(newsText(data, 'reflight'), { ...vars, date: fmt(state, data, inst.currentTurn) }),
      tags: ['calendar', 'reflight'], actors, importance: 1, icon: '⏳',
    });
  }
}

// ---------------------------------------------------------------- background commercial launches

function backgroundRate(v, year) {
  const byYear = v.backgroundByYear?.[String(year)];
  return Math.max(0, byYear ?? v.backgroundPerYear ?? v.cadencePerYear ?? 0);
}

function backgroundLaunches(state, data, ctx) {
  const turn = state.turn;
  const year = ctx?.date?.year ?? startYearOf(state, data) + Math.floor(turn / WEEKS_PER_YEAR);
  let total = 0;
  for (const v of vehiclesOf(data)) {
    const rate = backgroundRate(v, year) / WEEKS_PER_YEAR;
    if (!(rate > 0) || !inCatalogAt(state, data, v, turn) || isGrounded(state, v.id)) continue;
    const rng = ctx?.rng ? ctx.rng(`bg:${v.id}`) : makeRng(hash32(state.seed, turn, 'bg', v.id));
    const n = Math.floor(rate) + (rng.chance(rate - Math.floor(rate)) ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const before = state.vehicleStats[v.id]?.flights || 0;
      const p = clamp(vehicleSuccessP(state, data, v.id, v.operator), 0.3, 0.998);
      const ok = rng.chance(p);
      recordFlight(state, v.id, ok);
      total++;
      if (Math.floor(before / 100) < Math.floor((before + 1) / 100)) {
        addNews(state, { headline: fill(newsText(data, 'bgMilestone'), { vehicle: v.name, n: before + 1 }), tags: ['catalog', 'launches'], actors: [v.tensionActor || v.operator], importance: 1, icon: '🚀' });
      }
      if (!ok) {
        const st = state.vehicleStats[v.id];
        const weeks = st.standDownWeeks ?? 12;
        st.quarterFailures = (st.quarterFailures || 0) + 1;
        // a vehicle that keeps failing stops being news: after 2 in a year it goes to the quarterly summary
        st.failNewsTurns = (st.failNewsTurns || []).filter((t) => turn - t < WEEKS_PER_YEAR);
        if (st.failNewsTurns.length >= 2) break;
        st.failNewsTurns.push(turn);
        addNews(state, {
          headline: fill(newsText(data, v.backgroundKind === 'test' ? 'bgTestFailure' : 'bgFailure'), { vehicle: v.name }), body: fill(newsText(data, 'bgFailureBody'), { weeks: weeksToText(weeks) }),
          tags: ['catalog', 'failure'], actors: [v.tensionActor || v.operator], importance: v.class === 'small' ? 1 : 2, icon: '💥',
        });
        break; // fleet grounded
      }
    }
  }
  state.stats['calendar.backgroundLaunches'] = (state.stats['calendar.backgroundLaunches'] || 0) + total;
}

function periodicSummaries(state, data) {
  const turn = state.turn;
  if (turn % REVISION_PERIOD === REVISION_PERIOD - 1) {
    const rows = vehiclesOf(data)
      .map((v) => ({ v, n: state.vehicleStats[v.id]?.quarterFlights || 0 }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);
    const total = rows.reduce((s, r) => s + r.n, 0);
    if (rows.length) {
      const fails = vehiclesOf(data).map((v) => ({ v, n: state.vehicleStats[v.id]?.quarterFailures || 0 })).filter((r) => r.n > 0);
      const failText = fails.length ? `; falhas: ${fails.map((r) => `${r.v.name} ${r.n}`).join(', ')}` : '';
      const summary = `${total} lançamentos; ${rows.slice(0, 3).map((r) => `${r.v.name} ${r.n}`).join(', ')}${failText}`;
      addNews(state, { headline: fill(newsText(data, 'bgQuarter'), { summary }), tags: ['catalog', 'launches', 'summary'], actors: [], importance: 1, icon: 'chart' });
    }
    for (const st of Object.values(state.vehicleStats)) { st.quarterFlights = 0; st.quarterFailures = 0; }
  }
  if (turn % WEEKS_PER_YEAR === WEEKS_PER_YEAR - 1) {
    for (const st of Object.values(state.vehicleStats)) st.yearFlights = 0;
  }
}

// ---------------------------------------------------------------- views / queries

function vehicleCard(state, data, v, actorId) {
  const turn = state?.turn ?? 0;
  const st = state?.vehicleStats?.[v.id] || null;
  const inCatalog = inCatalogAt(state, data, v, turn);
  const acc = accessFor(state, data, actorId, v);
  const availableTurn = availableTurnOf(state, data, v);
  return {
    ...v,
    available: inCatalog && acc.ok,
    inCatalog,
    availableTurn,
    availableText: availableTurn == null ? 'aguarda a estreia' : availableTurn > turn ? fmt(state, data, availableTurn) : null,
    access: acc,
    reliability: vehicleReliability(state, data, v.id),
    stats: st,
    grounded: isGrounded(state, v.id),
    groundedUntil: isGrounded(state, v.id) ? st.groundedUntil : null,
    truthLabel: TRUTH_LABELS[v.truthLayer] || v.truthLayer,
  };
}

function spacecraftCard(state, data, s, actorId) {
  const turn = state?.turn ?? 0;
  const inCatalog = inCatalogAt(state, data, s, turn);
  const acc = accessFor(state, data, actorId, s);
  return {
    ...s, available: inCatalog && acc.ok, inCatalog, access: acc,
    availableTurn: availableTurnOf(state, data, s),
    reliability: spacecraftReliability(state, data, s.id),
    truthLabel: TRUTH_LABELS[s.truthLayer] || s.truthLayer,
  };
}

function windowView(state, data, destId) {
  const w = nextWindow(state, data, destId, state?.turn ?? 0);
  const always = w.closeTurn === Infinity;
  const turn = state?.turn ?? 0;
  return {
    destinationId: destId, openTurn: w.openTurn, closeTurn: always ? null : w.closeTurn, isOpen: w.isOpen, alwaysOpen: always,
    weeksUntil: Math.max(0, w.openTurn - turn),
    text: always ? 'Sempre aberta' : w.isOpen ? `Aberta até ${fmt(state, data, w.closeTurn)}` : `Abre em ${fmt(state, data, w.openTurn)} (${weeksToText(w.openTurn - turn)})`,
  };
}

function destinationCard(state, data, d) {
  const until = d.availableUntil ? turnOfDate(d.availableUntil, startYearOf(state, data), data) : null;
  return {
    ...d,
    totalDv: Math.round((d.route || []).reduce((s, r) => s + (r.dv || 0), 0) * 100) / 100,
    available: until == null || (state?.turn ?? 0) <= until,
    window: d.window,
    windowInfo: windowView(state, data, d.id),
  };
}

export function calendarView(state, data, inst) {
  const item = calendarItem(data, inst.id) || {};
  const dest = destinationById(data, item.destination);
  const turnRef = inst.status === 'launched' ? inst.arrivalTurn : inst.currentTurn;
  return {
    ...inst,
    name: item.name, owner: item.owner, ownerName: actorName(state, data, item.owner), partners: item.partners || [], client: item.client || null,
    type: item.type, destination: item.destination, destinationName: dest?.name || item.destination,
    vehicleId: item.vehicleId, vehicleName: item.vehicleName || vehicleById(data, item.vehicleId)?.name || item.vehicleId,
    inTransit: !!item.inTransit, launchedText: inst.launchTurn != null ? fmt(state, data, inst.launchTurn) : null,
    spacecraftId: item.spacecraftId, spacecraftName: spacecraftById(data, item.spacecraftId)?.name || item.spacecraftId,
    crewed: !!item.crewed, truthLayer: item.truthLayer, truthLabel: TRUTH_LABELS[item.truthLayer] || item.truthLayer,
    importance: item.importance || 1, milestone: item.milestone || null, prerequisites: item.prerequisites || [],
    description: item.description || '', statusNov2026: item.statusNov2026 || '', source: item.source || null,
    isPlayer: inst.status === 'player', statusLabel: STATUS_LABELS[inst.status] || inst.status,
    plannedText: fmt(state, data, inst.plannedTurn), currentText: fmt(state, data, inst.currentTurn),
    arrivalText: inst.arrivalTurn != null ? fmt(state, data, inst.arrivalTurn) : null,
    delayText: inst.delayWeeks > 0 ? `+${weeksToText(inst.delayWeeks)}` : 'no prazo',
    sortTurn: turnRef ?? inst.currentTurn,
  };
}

export const actions = {};
export const decisionHandlers = {};

export const queries = {
  'catalog/vehicles': (state, data, actorId) => vehiclesOf(data).map((v) => vehicleCard(state, data, v, actorId ?? state?.playerId)),
  'catalog/vehicle': (state, data, id, actorId) => {
    const v = vehicleById(data, id);
    return v ? vehicleCard(state, data, v, actorId ?? state?.playerId) : null;
  },
  'catalog/spacecraft': (state, data, actorId) => spacecraftOf(data).map((s) => spacecraftCard(state, data, s, actorId ?? state?.playerId)),
  'catalog/destinations': (state, data) => destinationsOf(data).map((d) => destinationCard(state, data, d)),
  'catalog/routeNodes': (_state, data) => data?.destinations?.routeNodes || [],
  'catalog/window': (state, data, destId) => windowView(state, data, destId),
  'calendar/upcoming': (state, data, n = 6) =>
    (state?.calendar || [])
      .filter((c) => c.status === 'planned' || c.status === 'launched' || (c.status === 'player' && !c.outcome))
      .map((c) => calendarView(state, data, c))
      .sort((a, b) => a.sortTurn - b.sortTurn)
      .slice(0, n),
  'calendar/all': (state, data) => (state?.calendar || []).map((c) => calendarView(state, data, c)).sort((a, b) => a.sortTurn - b.sortTurn),
  'calendar/get': (state, data, id) => {
    const c = calendarInstance(state, id);
    return c ? calendarView(state, data, c) : null;
  },
  'calendar/prerequisites': (state, data, id) => prerequisiteStatus(state, data, id),
};

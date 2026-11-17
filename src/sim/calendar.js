// Catalog + living calendar (module "calendar", owner: catalog).
// - Dynamic catalog: vehicle/spacecraft availability, access rules (embargo, blocs, tension), reliability (Beta).
// - Living calendar: official plans from data/calendar.json slip through periodic schedule revisions,
//   prerequisites gate launches, rival launches resolve with quickOutcome, firsts are claimed, news is written.
// - Background commercial launches (aggregate) keep vehicle stats alive.
// Pure JS, deterministic: randomness only via ctx.rng(label). No dates or mission names hard-coded here.

import { addNews, emitSignal, claimFirst, changeActor, log, relKey, clamp } from '../core/helpers.js';
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
const LEVEL_RANK = { total: 0, partial: 1, recoverable: 2, catastrophic: 3 };
const FAILURE_TYPES = ['propulsion', 'structure', 'software', 'human', 'environment'];
const ASCENT_WEIGHTS = { propulsion: 0.45, structure: 0.2, software: 0.15, human: 0.08, environment: 0.12 };

export const TRUTH_LABELS = { fato: 'Fato', plano_oficial: 'Plano oficial', projecao: 'Projeção', especulacao: 'Especulação' };
export const STATUS_LABELS = {
  planned: 'Planejada', launched: 'Em trânsito', success: 'Sucesso', partial: 'Sucesso parcial',
  failed: 'Fracasso', cancelled: 'Cancelada', player: 'Sua missão',
};

const DEFAULT_NEWS = {
  delayed: '{name} adiada para {date}',
  delayedBody: 'Mais {weeks} de atraso. Plano original: {planned}.',
  windowMissed: '{name} perde a janela e fica para {date}',
  windowMissedBody: '',
  prereqWait: '{name} aguarda {prereq}',
  prereqWaitBody: 'Nova meta: {date}.',
  prereqFailed: '{name} revista depois do fracasso de {prereq}',
  grounded: '{name} adiada: frota do {vehicle} em solo',
  suspended: '{name} suspensa',
  suspendedBody: 'Retomada prevista para {date}.',
  cancelled: '{name} cancelada',
  cancelledBody: '',
  launched: '{owner} lança {name}',
  launchedBody: 'Chegada prevista para {date}.',
  success: '{name}: sucesso!',
  partial: '{name}: sucesso parcial',
  failed: '{name} fracassa',
  lostCrew: 'Tragédia: tripulação da {name} perdida',
  lostCrewBody: '',
  first: '{owner} é o primeiro: {milestone}',
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

/** Next launch window. Destinations without window: {openTurn: fromTurn, closeTurn: Infinity}. */
export function nextWindow(state, data, destinationId, fromTurn) {
  const from = fromTurn ?? state?.turn ?? 0;
  const w = destinationById(data, destinationId)?.window;
  if (!w || !(w.periodWeeks > 0)) return { openTurn: from, closeTurn: Infinity, isOpen: true };
  const open = Math.max(1, w.openWeeks || 1);
  // smallest k with phase + k*period + open > from
  const k = Math.ceil((from - (w.phaseTurn || 0) - open + 1) / w.periodWeeks);
  const openTurn = (w.phaseTurn || 0) + k * w.periodWeeks;
  const closeTurn = openTurn + open;
  return { openTurn, closeTurn, isOpen: from >= openTurn && from < closeTurn };
}

function snapToWindow(state, data, destinationId, turn) {
  const w = nextWindow(state, data, destinationId, turn);
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
      if (firstOk) t = Math.max(t, firstOk.turn);
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

function hasTreaty(state, a, b) {
  return (state?.treaties || []).some((t) => t?.status === 'active' && t.parties?.includes(a) && t.parties?.includes(b));
}

/** Can `actorId` buy/use this catalog entry? → {ok, reason} (reason pt-BR when blocked). */
export function accessFor(state, data, actorId, item) {
  if (!item) return { ok: false, reason: 'desconhecido' };
  if (item.access === 'generic' || !item.operator) return { ok: true, reason: null };
  const ctrl = item.tensionActor || item.operator;
  if (ctrl === actorId || item.operator === actorId) return { ok: true, reason: null };
  if ((item.embargo || []).includes(actorId)) return { ok: false, reason: 'Embargo: o operador não vende para você' };
  const t = tensionBetween(state, actorId, ctrl);
  if (t >= 3) return { ok: false, reason: `Bloqueado pela tensão com ${actorName(state, data, ctrl)}` };
  if (item.access === 'own') return { ok: false, reason: 'Uso exclusivo do operador' };
  if (item.access === 'bloc' && !inSameBloc(state, data, actorId, ctrl) && !hasTreaty(state, actorId, ctrl)) {
    return { ok: false, reason: 'Só para o bloco e parceiros do operador' };
  }
  return { ok: true, reason: null };
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
  return {
    id: item.id,
    plannedTurn,
    currentTurn: snapToWindow(state, data, item.destination, plannedTurn),
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
  for (const item of itemsOf(data)) if (!have.has(item.id)) state.calendar.push(newInstance(state, data, item));
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
  rivalProgramPrestige(state, data);
  periodicSummaries(state, data);
}

/**
 * Rivals do far more than their headline calendar items (crew rotations, science, satellites):
 * a small weekly prestige drip, proportional to budget and public support, keeps the Tabela da Era contested.
 * Tunable in data/calendar.json "rivalProgramPrestige" (points per US$ 1 bi of budget per year).
 */
function rivalProgramPrestige(state, data) {
  const rate = data?.calendar?.rivalProgramPrestige ?? 2.5;
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
  if (dest?.window) {
    const cur = nextWindow(state, data, item.destination, old);
    if (target >= cur.closeTurn && old < cur.closeTurn) {
      const discipline = item.delay?.windowDiscipline ?? 0.85;
      // planetary windows are hard deadlines: teams crunch to make them when the slip is modest
      if (kind === 'delayed' && rng && target - cur.closeTurn < 26 && rng.chance(discipline)) {
        target = cur.closeTurn - 1;
        if (target <= old) return; // the team absorbs the whole slip to keep the window
      }
    }
    const snapped = snapToWindow(state, data, item.destination, target);
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
    icon: 'delay',
  });
}

function cancel(state, data, inst, item, reason) {
  inst.status = 'cancelled';
  inst.resolvedTurn = state.turn;
  emitSignal(state, 'calendar/delayed', { calendarId: inst.id, weeks: 0, reason: 'cancelled' });
  const vars = { name: item.name, owner: actorName(state, data, item.owner) };
  addNews(state, {
    headline: fill(newsText(data, 'cancelled'), vars),
    body: fill(reason === 'war' ? newsText(data, 'suspendedBody') : newsText(data, 'cancelledBody'), { ...vars, date: '-' }),
    tags: ['calendar', 'cancelled'], actors: [item.owner, ...(item.partners || [])],
    importance: clamp(item.importance || 1, 1, 2), icon: 'cancel',
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
  const win = nextWindow(state, data, item.destination, turn);
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
      tags: ['calendar', 'launch'], actors: [item.owner, ...(item.partners || [])], importance: clamp(imp - 1, 1, 2), icon: 'launch',
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
  add(dest?.firsts?.[item.crewed ? 'crewed' : 'robotic']);
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
      body: item.description || '', tags: ['calendar', 'result', 'success'], actors, importance: clamp(imp, 1, 3), icon: 'success',
    });
    changeActor(state, owner, 'prestige', level === 'total' ? imp * 3 : imp * 1.5);
    changeActor(state, owner, 'support', level === 'total' ? imp : 0);
    changeActor(state, owner, 'reputation', level === 'total' ? 1 : 0);
    for (const mid of milestonesFor(state, data, item)) {
      const first = claimFirst(state, mid, owner);
      if (first) {
        emitSignal(state, 'first', { milestoneId: mid, actorId: owner, calendarId: inst.id });
        addNews(state, {
          headline: fill(newsText(data, 'first'), { ...vars, milestone: milestoneLabel(data, mid) }),
          body: item.name, tags: ['first'], actors, importance: 3, icon: 'first',
        });
      }
    }
    // a successful debut puts a new vehicle in the catalog
    for (const v of vehiclesOf(data)) {
      if (v.debutCalendarId === inst.id && flags.vehicleOk) {
        addNews(state, { headline: fill(newsText(data, 'debut'), { vehicle: v.name }), body: v.notes || '', tags: ['catalog'], actors: [v.operator], importance: 1, icon: 'rocket' });
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
    tags: ['calendar', 'result', 'failure'], actors, importance: lostCrew ? 3 : clamp(Math.max(2, imp), 1, 3), icon: lostCrew ? 'memorial' : 'failure',
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
    inst.currentTurn = snapToWindow(state, data, item.destination, turn + rng.int(16, 40));
    inst.delayWeeks = inst.currentTurn - inst.plannedTurn;
    addNews(state, {
      headline: fill(newsText(data, 'reflight'), { ...vars, date: fmt(state, data, inst.currentTurn) }),
      tags: ['calendar', 'reflight'], actors, importance: 1, icon: 'delay',
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
        addNews(state, { headline: fill(newsText(data, 'bgMilestone'), { vehicle: v.name, n: before + 1 }), tags: ['catalog', 'launches'], actors: [v.tensionActor || v.operator], importance: 1, icon: 'rocket' });
      }
      if (!ok) {
        const weeks = state.vehicleStats[v.id].standDownWeeks ?? 12;
        addNews(state, {
          headline: fill(newsText(data, v.backgroundKind === 'test' ? 'bgTestFailure' : 'bgFailure'), { vehicle: v.name }), body: fill(newsText(data, 'bgFailureBody'), { weeks: weeksToText(weeks) }),
          tags: ['catalog', 'failure'], actors: [v.tensionActor || v.operator], importance: v.class === 'small' ? 1 : 2, icon: 'failure',
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
      const summary = `${total} lançamentos; ${rows.slice(0, 3).map((r) => `${r.v.name} ${r.n}`).join(', ')}`;
      addNews(state, { headline: fill(newsText(data, 'bgQuarter'), { summary }), tags: ['catalog', 'launches', 'summary'], actors: [], importance: 1, icon: 'chart' });
    }
    for (const st of Object.values(state.vehicleStats)) st.quarterFlights = 0;
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
    vehicleId: item.vehicleId, vehicleName: vehicleById(data, item.vehicleId)?.name || item.vehicleId,
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

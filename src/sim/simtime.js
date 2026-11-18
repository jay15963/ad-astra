// Time/era glue shared by the sim modules (owner: A3 sim-agnostic). Pure, no rng, no state writes.
//
// - Cadence helpers of docs/EXPANSION.md §1.4. They delegate to src/core/helpers.js when core exposes them and the
//   engine passes `ctx.prevTurn/ctx.dt`; otherwise they fall back to the same math on (state.turn, dt = 1), which is
//   exactly the old `state.turn % N === k` (so the Corrida Lunar stays bit-identical whichever engine runs it).
// - Calendar year of a turn without the old `?? 2026` default (the scenario always sets state.startYear).
// - Date windows of content: `fromYear/untilYear` (stamped by packs.js on era-pack entities) and
//   `availableFrom/availableUntil` ({year, month 1..12}). Legacy files (data/*.json, pack "legacy-e4") are not stamped;
//   their undated narrative content belongs to the era of that pack (2026+): `legacyFromYear(data)`.

import * as H from '../core/helpers.js';
import { WEEKS_PER_YEAR, eraAt, eraById } from '../core/time.js';

const W = WEEKS_PER_YEAR;

/** Weeks this tick covers (1 with the weekly engine). */
export const dtOf = (ctx) => Math.max(1, Math.floor(ctx?.dt ?? 1));
/** First week of this tick. */
export const prevTurnOf = (state, ctx) => (Number.isFinite(ctx?.prevTurn) ? ctx.prevTurn : state.turn);

/** Count of t ≡ phase (mod period) in [prevTurn, prevTurn + dt). */
export function every(state, ctx, period, phase = 0) {
  if (typeof H.every === 'function' && Number.isFinite(ctx?.prevTurn) && Number.isFinite(ctx?.dt)) return H.every(ctx, period, phase);
  const p0 = prevTurnOf(state, ctx);
  const dt = dtOf(ctx);
  const f = (x) => Math.floor((x - phase) / period);
  return f(p0 + dt - 1) - f(p0 - 1);
}
/** Replaces `state.turn % period === phase`. */
export const crossed = (state, ctx, period, phase = 0) => every(state, ctx, period, phase) > 0;
/** weekly amount → amount for this tick. */
export const perStep = (weekly, ctx) => weekly * dtOf(ctx);
/** Weekly probability → probability for this tick (one draw). */
export const chanceInStep = (pWeek, ctx) => (dtOf(ctx) === 1 ? pWeek : 1 - (1 - pWeek) ** dtOf(ctx));
/** Scheduled turn t falls inside this tick (or is already past). */
export const dueIn = (state, ctx, t) => t != null && t < prevTurnOf(state, ctx) + dtOf(ctx);
/** Expiry for a decision: at least one whole step away. */
export const expiryIn = (state, ctx, weeks) => state.turn + Math.max(weeks, dtOf(ctx));
/** Did this tick enter a new calendar month? (replaces politics' isMonthStart; same answer at dt = 1). */
export function monthCrossed(state, ctx) {
  const p0 = prevTurnOf(state, ctx);
  if (p0 === 0) return true;
  const mk = (t) => Math.floor(((((t % W) + W) % W)) / (W / 12)) + 12 * Math.floor(t / W);
  return mk(p0 + dtOf(ctx) - 1) !== mk(p0 - 1);
}

/** Calendar year of a turn (state.startYear is always set by createState). */
export function yearAt(state, turn = state?.turn ?? 0) {
  return (state?.startYear ?? 0) + Math.floor(turn / W);
}
/** Years elapsed since the scenario start (decimal). */
export const yearsSinceStart = (state, turn = state?.turn ?? 0) => turn / W;

/** Era id of a year ('e1'..'e7'), from data/core/eras.json (fallback table in time.js). */
export const eraIdAt = (data, year) => eraAt(data, year)?.id ?? null;

/** Era the legacy files (data/*.json) belong to: the manifest's "legacy-eN" pack, else e4. */
export function legacyEraId(data) {
  if (typeof data?.legacyEra === 'string') return data.legacyEra;
  for (const id of Object.keys(data?.packsLoaded || {})) {
    const m = /^legacy-(e\d+)$/.exec(id);
    if (m) return m[1];
  }
  return 'e4';
}
/** First year of the legacy content (2026 today). */
export function legacyFromYear(data) {
  const e = eraById(data, legacyEraId(data));
  const y = typeof e?.from === 'number' ? e.from : e?.from?.year;
  return Number.isFinite(y) ? y : -Infinity;
}

const yr = (d) => (d == null ? null : typeof d === 'number' ? d : Number.isFinite(d.year) ? d.year : null);

/**
 * Is a content item valid in `year`? Honours fromYear/untilYear, availableFrom/availableUntil (year granularity) and,
 * for undated legacy narrative content (`undatedFrom`), the legacy era start.
 */
export function inYearWindow(item, year, { undatedFrom = null } = {}) {
  if (!item) return false;
  const from = yr(item.fromYear) ?? yr(item.availableFrom) ?? undatedFrom;
  const until = yr(item.untilYear) ?? yr(item.availableUntil);
  if (from != null && year < from) return false;
  if (until != null && year > until) return false;
  return true;
}

/** Destination usable in `year` (stations are born and retired: ISS has availableUntil 2030). */
export const destinationOpen = (dest, year) => inYearWindow(dest, year);

/** Live actor ids (helpers.liveActors when core has it; tier filter optional). */
export function liveActorIds(state, opts) {
  if (typeof H.liveActors === 'function') {
    const r = H.liveActors(state, opts);
    if (Array.isArray(r)) return r.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  }
  const all = Object.keys(state?.actors || {});
  if (!opts?.tier) return all;
  return all.filter((id) => (state.actors[id]?.tier ?? 'core') === opts.tier || id === state.playerId);
}

/** Lineage alias → living id (helpers.resolveActor when present). */
export function resolveActorId(state, id) {
  if (typeof H.resolveActor === 'function') {
    const r = H.resolveActor(state, id);
    if (typeof r === 'string') return r;
    if (r?.id) return r.id;
  }
  const aliases = state?.lifecycle?.aliases || {};
  let cur = id;
  for (let i = 0; i < 8 && cur && aliases[cur]; i++) cur = aliases[cur];
  return cur;
}

/** Lineage definition (data/core/lineages.json) of an actor id, or null. */
export function lineageOf(data, id) {
  return data?.index?.lineages?.[id] || data?.lineages?.lineages?.find((l) => l.id === id) || null;
}

/**
 * AI goals of an actor in the current era: the lineage's eraProfiles[era].ai.goals when the data has them
 * (NACA chases "first_satellite" in 1950, not the lunar south pole), else the actor's own ai.goals.
 */
export function aiGoals(state, data, id) {
  const a = state?.actors?.[id];
  const era = eraIdAt(data, yearAt(state));
  const prof = lineageOf(data, a?.lineage || id)?.eraProfiles?.[era]?.ai?.goals;
  return Array.isArray(prof) ? prof : a?.ai?.goals || [];
}

/**
 * Service life of catalog hardware without a retirement date: legacy vehicles (Falcon 9…) do not fly forever in a
 * 1,050-year campaign. data.vehicles.serviceLifeYears / data.spacecraft.serviceLifeYears (default 50) after availableFrom.
 */
export function retireYearOf(data, item, kind = 'vehicles') {
  if (item?.availableUntil?.year != null) return item.availableUntil.year;
  if (Number.isFinite(item?.untilYear)) return item.untilYear;
  const from = item?.availableFrom?.year ?? item?.fromYear ?? item?.history?.firstFlight;
  if (!Number.isFinite(from)) return Infinity;
  const life = data?.[kind]?.serviceLifeYears ?? item?.serviceLifeYears ?? 50;
  return from + life;
}

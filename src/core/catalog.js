// Catalog accessor: the single lookup for launch vehicles and spacecraft (docs/EXPANSION.md §4.3).
// Every vehicle/craft read in src/sim and src/ui goes through here, so player designs (Phase B, state.designs) and
// era packs plug in without touching the callers. Pure, no I/O, no rng.
//
// Dates in vehicles.json/spacecraft.json use monthBase 1 ({year, month 1..12}); turns are weeks since
// state.startYear (src/core/time.js).

import { turnToDate } from './time.js';
import { itemGate, techGated } from './gating.js';

const asVehicle = (d) => d?.asVehicle ?? (d?.kind === 'vehicle' ? d : null);
const asCraft = (d) => d?.asSpacecraft ?? d?.asCraft ?? (d?.kind === 'spacecraft' ? d : null);

/** Launch vehicle by id: catalog first, then the player's designs. null when unknown. */
export function vehicleDef(data, id, state) {
  if (!id) return null;
  return data?.index?.vehicles?.[id]
    ?? data?.vehicles?.vehicles?.find((v) => v.id === id)
    ?? asVehicle(state?.designs?.[id])
    ?? null;
}

/** Spacecraft by id: catalog first, then the player's designs. null when unknown. */
export function spacecraftDef(data, id, state) {
  if (!id) return null;
  return data?.index?.spacecraft?.[id]
    ?? data?.spacecraft?.spacecraft?.find((v) => v.id === id)
    ?? asCraft(state?.designs?.[id])
    ?? null;
}

/** {year, month 1..12} -> month count (−∞ for no date). */
export function monthIndex(d) {
  if (!d || d.year == null) return -Infinity;
  return d.year * 12 + ((d.month ?? 1) - 1);
}

/** Month count of a turn of this game. */
function monthOfTurn(state, data, turn) {
  const sy = state?.startYear ?? data?.scenario?.startYear ?? 2026;
  const d = turnToDate(turn ?? state?.turn ?? 0, sy);
  return d.year * 12 + d.month;
}

/** Follows lifecycle aliases (merged predecessors) to the living lineage id. */
function resolveOperator(state, id) {
  const aliases = state?.lifecycle?.aliases || {};
  let cur = id;
  for (let i = 0; i < 8 && cur && aliases[cur]; i++) cur = aliases[cur];
  return cur;
}

/**
 * True when the vehicle (or a spacecraft id, via `kind: 'spacecraft'`) is in the catalog at `turn`: after
 * availableFrom, not past availableUntil, not flagged retired and its operator has not died (a tombstone without
 * successor). Operators that are not actors (contractors) never block.
 */
export function vehicleAvailable(data, state, id, turn, { kind = 'vehicle' } = {}) {
  const def = kind === 'spacecraft' ? spacecraftDef(data, id, state) : vehicleDef(data, id, state);
  return itemAvailable(data, state, def, turn);
}

/** Same rule for an already resolved definition. */
export function itemAvailable(data, state, def, turn) {
  if (!def || def.retired) return false;
  const now = monthOfTurn(state, data, turn);
  if (monthIndex(def.availableFrom) > now) return false;
  if (def.availableUntil && monthIndex(def.availableUntil) < now) return false;
  if (def.operator) {
    const op = resolveOperator(state, def.operator);
    const tomb = state?.lifecycle?.tombstones?.[op];
    if (tomb && !tomb.into && !state?.actors?.[op]) return false;
  }
  return true;
}

/** Player designs as catalog entries ({id, …asVehicle}) owned by actorId (all owners when absent). */
function designList(state, actorId, pick) {
  const out = [];
  for (const [id, d] of Object.entries(state?.designs || {})) {
    if (actorId && d.owner && d.owner !== actorId) continue;
    const def = pick(d);
    if (def) out.push({ ...def, id: def.id ?? id });
  }
  return out;
}

/**
 * Research gate of a catalog entry (MISSIONS-V2 §5): {ok, key, nodeId, reason}. Only the player of a scenario with
 * `techGating` is gated; player designs (built in the Hangar) are never gated here (their parts are, in designs.js).
 */
export function researchGateOf(data, state, kind, item, actorId = state?.playerId, opts = {}) {
  if (!item || actorId !== state?.playerId || !techGated(state, data) || item.owner === actorId) return { ok: true, key: null, nodeId: null, reason: null };
  return itemGate(state, data, kind, item, actorId, opts);
}

/**
 * Vehicles in the catalog at `turn` (default: now) plus the actor's designs, catalog order then designs.
 * `gated: true` also drops catalog entries the (gated) player has not researched yet.
 */
export function listVehicles(data, state, { turn, actorId, gated = false } = {}) {
  const t = turn ?? state?.turn ?? 0;
  const catalog = (data?.vehicles?.vehicles || []).filter((v) => itemAvailable(data, state, v, t)
    && (!gated || researchGateOf(data, state, 'vehicle', v, actorId).ok));
  return catalog.concat(designList(state, actorId, asVehicle).filter((v) => itemAvailable(data, state, v, t)));
}

/** Spacecraft in the catalog at `turn` (default: now) plus the actor's designs (`gated` as listVehicles). */
export function listSpacecraft(data, state, { turn, actorId, gated = false } = {}) {
  const t = turn ?? state?.turn ?? 0;
  const catalog = (data?.spacecraft?.spacecraft || []).filter((v) => itemAvailable(data, state, v, t)
    && (!gated || researchGateOf(data, state, 'spacecraft', v, actorId).ok));
  return catalog.concat(designList(state, actorId, asCraft).filter((v) => itemAvailable(data, state, v, t)));
}

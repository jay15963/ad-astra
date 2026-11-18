// Save migration v3 → v4 (docs/MISSIONS-V2.md §10, "Missões v2"). Pure, idempotent, takes (s, data).
// 1. Legacy landing: every mission-like record of type 'lander' becomes {type: 'probe', sub: 'lander'}.
// 2. Research grants (gated scenarios): the unlock nodes history had by the save's year, the nodes whose keys the
//    player's committed hardware needs, and their requires closure. Without `data` this step is deferred
//    (`research.needsGrant = true`) and research.js runs the same function once data is present.
// 3. New slices: assets and market start null (their modules build them in ensure).
// Registered on import (src/sim/research.js imports this file).
import { registerMigration } from '../migrate.js';
import { historicalGrant, requiresClosure, gatesOf, nodeForKey, keyIndex, keysOfNodes, resolveType, histYearOf } from '../gating.js';

const WEEKS_PER_YEAR = 52;
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

/** Rewrite one record in place when its type is the legacy 'lander' (field `type`, or `t` on archive stubs). */
function fixType(rec) {
  if (!isObj(rec)) return 0;
  let n = 0;
  for (const f of ['type', 't']) {
    if (rec[f] !== 'lander' && rec[f] !== 'landing') continue;
    const r = resolveType(rec[f], rec.sub);
    rec[f] = r.type;
    if (rec.sub == null) rec.sub = r.sub;
    n++;
  }
  return n;
}

/** Step 1: legacy landing missions everywhere they are stored. Returns how many records changed. */
export function renameLegacyLanding(s) {
  let n = 0;
  for (const key of ['missions', 'missionsArchive', 'contracts', 'calendar', 'mandates']) {
    const list = s[key];
    if (Array.isArray(list)) for (const rec of list) {
      n += fixType(rec);
      if (isObj(rec?.draft)) n += fixType(rec.draft);
    }
  }
  for (const d of Array.isArray(s.decisions) ? s.decisions : []) {
    const p = d?.payload;
    if (!isObj(p)) continue;
    n += fixType(p);
    if (isObj(p.draft)) n += fixType(p.draft);
    if (isObj(p.mission)) n += fixType(p.mission);
  }
  return n;
}

const sortedUnion = (a, b) => [...new Set([...(a || []), ...(b || [])])].sort();

/** Keys needed by the hardware of the player's committed missions and operational designs. */
function committedKeys(s, data) {
  const keys = new Set();
  const vIdx = data?.index?.vehicles || {};
  const cIdx = data?.index?.spacecraft || {};
  const partIdx = Object.fromEntries((data?.parts?.parts || []).map((p) => [p.id, p]));
  const add = (list) => { for (const k of list || []) keys.add(k); };
  for (const m of Array.isArray(s.missions) ? s.missions : []) {
    if (!m || (m.owner && m.owner !== s.playerId) || (m.actorId && m.actorId !== s.playerId)) continue;
    const crewed = !!(m.crewed || (m.crew && m.crew.length) || m.draft?.crewed);
    const vId = m.vehicleId ?? m.draft?.vehicleId;
    const cId = m.spacecraftId ?? m.draft?.spacecraftId;
    if (vId && vIdx[vId]) add(gatesOf(data, 'vehicle', vIdx[vId], { crewed }));
    if (cId && cIdx[cId]) add(gatesOf(data, 'spacecraft', cIdx[cId]));
  }
  for (const d of Object.values(isObj(s.designs) ? s.designs : {})) {
    if (!d || d.retired || d.owner !== s.playerId || d.program?.phase !== 'operational') continue;
    const sp = d.spec || {};
    const ids = [];
    for (const st of sp.stages || []) for (const f of ['moduleId', 'engineId', 'engineId2']) if (st?.[f]) ids.push(st[f]);
    if (sp.boosters?.id) ids.push(sp.boosters.id);
    for (const f of ['fairingId', 'avionicsId', 'escapeId']) if (sp[f]) ids.push(sp[f]);
    for (const id of ids) if (partIdx[id]) add(gatesOf(data, 'part', partIdx[id]));
    if (d.templateId) {
      const t = (data?.parts?.templates || []).find((x) => x.id === d.templateId);
      if (t) add(gatesOf(data, 'template', t));
    }
    if (d.asVehicle) add(gatesOf(data, 'vehicle', d.asVehicle));
  }
  return [...keys];
}

/**
 * Step 2 (also run by research.js when a data-less migration left `needsGrant`): grants by date and committed
 * hardware. Writes research.unlocked (sorted union), research.keys and research.migratedGrant (count of new ids).
 */
/**
 * v0.8 campaigns gave every actor its 2026 start set (initialFor of data/tech.json) in 1950. With
 * `techStart: "historical"` those nodes are dropped while their year is still ahead, unless another held node
 * requires them. Returns the cleaned list (same order).
 */
export function dropEarlyStartNodes(data, ids, year) {
  if (data?.scenario?.techStart !== 'historical' || !Array.isArray(ids)) return ids;
  const byId = keyIndex(data).byId;
  const early = new Set(ids.filter((id) => { const n = byId.get(id); return n && (n.initialFor || []).length && histYearOf(n) > year; }));
  if (!early.size) return ids;
  const kept = ids.filter((id) => !early.has(id));
  const need = requiresClosure(data, kept.flatMap((id) => byId.get(id)?.requires || []));
  return ids.filter((id) => !early.has(id) || need.has(id));
}

export function applyResearchGrant(s, data) {
  const r = s.research;
  if (!isObj(r)) return 0;
  delete r.needsGrant;
  if (!data?.scenario?.techGating) return 0;
  const year = (s.startYear ?? 0) + Math.floor((s.turn ?? 0) / WEEKS_PER_YEAR);
  r.unlocked = dropEarlyStartNodes(data, r.unlocked || [], year);
  if (isObj(r.rivals)) for (const [id, list] of Object.entries(r.rivals)) r.rivals[id] = dropEarlyStartNodes(data, list, year);
  const before = new Set(r.unlocked || []);
  let ids = historicalGrant(data, year + 1, { have: r.unlocked || [] });
  const idx = keyIndex(data);
  const held = new Set(keysOfNodes(data, ids));
  const extra = [];
  const tmp = { ...s, research: { ...r, unlocked: ids } };
  for (const k of committedKeys(s, data)) {
    if (held.has(k) || !idx.byKey.has(k)) continue;
    const n = nodeForKey(tmp, data, k);
    if (n) extra.push(n.id);
  }
  if (extra.length) ids = sortedUnion(ids, [...requiresClosure(data, extra)]);
  r.unlocked = ids;
  r.keys = keysOfNodes(data, ids);
  const added = ids.filter((id) => !before.has(id)).length;
  if (added) r.migratedGrant = (r.migratedGrant || 0) + added;
  return added;
}

export function v3to4(s, data) {
  renameLegacyLanding(s);
  if (isObj(s.research)) {
    if (data) applyResearchGrant(s, data);
    else s.research.needsGrant = true;
    s.research.needsRecompute = true; // keys + capped bonus are derived caches: research rebuilds them next tick
  }
  if (!('assets' in s)) s.assets = null;
  if (!('market' in s)) s.market = null;
  s.version = 4;
  return s;
}

registerMigration(3, v3to4);

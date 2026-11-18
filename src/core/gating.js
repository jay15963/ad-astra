// Unlock keys and the player's catalog gate (docs/MISSIONS-V2.md §0, §5). Pure: no rng, no I/O, no state writes.
//
// - A key is `<kind>:<id>` (vehicle:heavy, satellite:observatory, module:station.lab, missionType:rover...).
//   Tech nodes grant keys (`node.unlocks[].key`); data rules (`data.techtree.gates`) and item overrides (`gate`)
//   say which keys a catalog item, mission subtype, payload, module or Hangar part needs.
// - Keys gate only the player and only when the scenario sets `techGating`. Everyone else (AI rivals, and the
//   player of a non-gated scenario such as the Corrida Lunar) "holds" a key from its `keyYear`: the earliest
//   `histYear` of the nodes granting it. One API, `keyHeld`, serves every case.
// - A key no node grants is held by everyone (data safety; the validator refuses it).
// - Everything that only depends on the (static) data is memoized per data object (WeakMap); results never depend
//   on the memo.

import { yearOf } from './time.js';

/** The 8 unlock kinds (legend order), with the defaults of MISSIONS-V2 §5.6 (data.techtree.kinds overrides). */
export const UNLOCK_KINDS = Object.freeze({
  vehicle: { label: 'Foguete', token: '--uk-vehicle', color: '#ff8a4c', glyph: 'foguete' },
  spacecraft: { label: 'Nave', token: '--uk-spacecraft', color: '#f472b6', glyph: 'capsula' },
  satellite: { label: 'Satélite', token: '--uk-satellite', color: '#38bdf8', glyph: 'satelite' },
  probe: { label: 'Sonda', token: '--uk-probe', color: '#818cf8', glyph: 'sonda' },
  rover: { label: 'Rover e veículos', token: '--uk-rover', color: '#a3e635', glyph: 'rodas' },
  module: { label: 'Módulo de estação ou base', token: '--uk-module', color: '#2dd4bf', glyph: 'modulo' },
  missionType: { label: 'Tipo de missão', token: '--uk-mission', color: '#f5f5f4', glyph: 'alvo' },
  part: { label: 'Peça do Hangar', token: '--uk-part', color: '#d6b98c', glyph: 'chave' },
});
export const KIND_ORDER = Object.freeze(Object.keys(UNLOCK_KINDS));

/** Mission type labels used in gate reasons (missions.js owns the real table; this is only text). */
const TYPE_LABELS = {
  satellite: 'satélites', probe: 'sondas', rover: 'rovers', crewed: 'missões tripuladas', cargo: 'missões de carga',
  station: 'estações', colony: 'colônias', mining: 'mineração', interstellar: 'missões interestelares', docking: 'acoplagem',
};
/** Legacy mission types and what they mean now (MISSIONS-V2 §1.1). */
export const TYPE_ALIASES = Object.freeze({ lander: { type: 'probe', sub: 'lander' }, landing: { type: 'probe', sub: 'lander' } });

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const LEGACY_YEAR = 2026; // undated legacy nodes (data/tech.json) open with the legacy era

// ------------------------------------------------------------------ node helpers

const nodesOf = (data) => data?.tech?.nodes || [];
/** Keys a node grants, in order (strings only). */
export const nodeKeys = (n) => (Array.isArray(n?.unlocks) ? n.unlocks.map((u) => (typeof u === 'string' ? u : u?.key)).filter((k) => typeof k === 'string' && k) : []);
/** 'unlock' when the node grants a key, else 'efficiency' (MISSIONS-V2 §4.2: derived, never stored). */
export const nodeKind = (n) => (nodeKeys(n).length ? 'unlock' : 'efficiency');
/** Kind part of a key ('vehicle:heavy' → 'vehicle'). */
export const keyKind = (key) => String(key || '').split(':')[0] || null;
/** Primary unlock kind of a node (kind of its first key), null for efficiency nodes. */
export const unlockKindOf = (n) => { const k = nodeKeys(n)[0]; return k ? keyKind(k) : null; };
/** Year a node is anchored to in history: histYear, else fromYear, else the legacy era start. */
export const histYearOf = (n) => num(n?.histYear, num(n?.fromYear, LEGACY_YEAR));
/** Era id of a node ('e1'..'e7'): techTier t3 → e3, else the numeric era stamp, else from its year. */
export function eraIdOf(n) {
  if (typeof n?.techTier === 'string' && /^t\d$/.test(n.techTier)) return `e${n.techTier.slice(1)}`;
  if (Number.isInteger(n?.era)) return `e${n.era}`;
  if (typeof n?.era === 'string' && /^e\d$/.test(n.era)) return n.era;
  const y = histYearOf(n);
  return y < 1976 ? 'e1' : y < 2000 ? 'e2' : y < 2026 ? 'e3' : y < 2051 ? 'e4' : y < 2200 ? 'e5' : y < 2600 ? 'e6' : 'e7';
}

/** Kinds table (legend order) merged over the defaults: [{id, label, color, token, glyph}]. */
export function kindsOf(data) {
  const over = data?.techtree?.kinds;
  const rows = Array.isArray(over) ? Object.fromEntries(over.filter((k) => k?.id).map((k) => [k.id, k])) : (over && typeof over === 'object' ? over : {});
  const ids = [...KIND_ORDER, ...Object.keys(rows).filter((k) => !KIND_ORDER.includes(k))];
  return ids.map((id) => ({ id, ...(UNLOCK_KINDS[id] || { label: id, token: `--uk-${id}`, color: '#98a3bf', glyph: 'chave' }), ...(rows[id] || {}) }));
}

/** Label of a key: vocab.unlockKeys, else the first node unlock label, else the key itself. */
export function keyLabel(data, key) {
  const v = data?.vocab?.unlockKeys?.[key];
  if (v?.label) return v.label;
  const idx = keyIndex(data);
  return idx.label.get(key) || key;
}

// ------------------------------------------------------------------ key index (memo per node list)

const KEY_INDEX = new WeakMap();
const EMPTY_INDEX = { byKey: new Map(), year: new Map(), label: new Map(), byId: new Map() };

/** {byKey: key → nodes granting it, year: key → min histYear, label: key → label, byId: id → node}. */
export function keyIndex(data) {
  const nodes = data?.tech?.nodes;
  if (!Array.isArray(nodes)) return EMPTY_INDEX;
  let idx = KEY_INDEX.get(nodes);
  if (idx) return idx;
  idx = { byKey: new Map(), year: new Map(), label: new Map(), byId: new Map() };
  for (const n of nodes) {
    if (!n?.id) continue;
    idx.byId.set(n.id, n);
    for (const u of Array.isArray(n.unlocks) ? n.unlocks : []) {
      const key = typeof u === 'string' ? u : u?.key;
      if (typeof key !== 'string' || !key) continue;
      if (!idx.byKey.has(key)) idx.byKey.set(key, []);
      idx.byKey.get(key).push(n);
      const y = histYearOf(n);
      if (!(idx.year.get(key) <= y)) idx.year.set(key, y);
      if (!idx.label.has(key) && u?.label) idx.label.set(key, u.label);
    }
  }
  KEY_INDEX.set(nodes, idx);
  return idx;
}

/** Earliest histYear of the nodes granting `key` (Infinity when none does). */
export function keyYear(data, key) {
  const y = keyIndex(data).year.get(key);
  return y == null ? Infinity : y;
}

/** True when some node grants the key. */
export const keyKnown = (data, key) => keyIndex(data).byKey.has(key);

/** Sorted unique keys granted by a list of node ids. */
export function keysOfNodes(data, ids) {
  const idx = keyIndex(data);
  const out = new Set();
  for (const id of ids || []) for (const k of nodeKeys(idx.byId.get(id))) out.add(k);
  return [...out].sort();
}

// ------------------------------------------------------------------ keys held

/** Does this scenario gate the player's catalog by research? */
export const techGated = (state, data) => !!(data?.scenario?.techGating ?? state?.techGating);

const KEYSET = new WeakMap();
/** The player's keys as a Set: research.keys cache when present, else derived from research.unlocked. */
export function playerKeySet(state, data) {
  const r = state?.research;
  const src = Array.isArray(r?.keys) ? r.keys : null;
  if (src) {
    const m = KEYSET.get(src);
    if (m && m.len === src.length) return m.set;
    const set = new Set(src);
    KEYSET.set(src, { len: src.length, set });
    return set;
  }
  const un = Array.isArray(r?.unlocked) ? r.unlocked : [];
  const m = KEYSET.get(un);
  if (m && m.len === un.length && m.data === data) return m.set;
  const set = new Set(keysOfNodes(data, un));
  KEYSET.set(un, { len: un.length, set, data });
  return set;
}

/**
 * keyHeld(state, data, key, actorId = player): the gated player → its research keys; anyone else (AI, non-gated
 * player) → the date rule (year ≥ keyYear). Unknown key → true.
 */
export function keyHeld(state, data, key, actorId = state?.playerId) {
  if (!key) return true;
  const idx = keyIndex(data);
  if (!idx.byKey.has(key)) return true;
  if (actorId === state?.playerId && techGated(state, data)) return playerKeySet(state, data).has(key);
  return yearOf(state) >= idx.year.get(key);
}

/**
 * Node the player should research for `key`: among granting nodes not yet held, an available one (requirements met,
 * in its year window) with the lowest science cost; else the one with the earliest year (then cost). null if none.
 */
const NODE_FOR = new WeakMap();
export function nodeForKey(state, data, key) {
  const list = keyIndex(data).byKey.get(key) || [];
  if (!list.length) return null;
  // memo per (unlocked list, its length, year, data): reasons are rebuilt for every locked item of every list
  const un = state?.research?.unlocked;
  const year = yearOf(state);
  let memo = Array.isArray(un) ? NODE_FOR.get(un) : null;
  if (Array.isArray(un) && !(memo && memo.len === un.length && memo.year === year && memo.data === data)) {
    memo = { len: un.length, year, data, map: new Map() };
    NODE_FOR.set(un, memo);
  }
  if (memo?.map.has(key)) return memo.map.get(key);
  const res = pickNodeForKey(state, list, year);
  memo?.map.set(key, res);
  return res;
}

function pickNodeForKey(state, list, year) {
  const have = new Set(state?.research?.unlocked || []);
  if (list.some((n) => have.has(n.id))) return list.find((n) => have.has(n.id));
  const open = (n) => (n.requires || []).every((r) => have.has(r)) && num(n.fromYear, -Infinity) <= year && !(n.untilYear != null && year > n.untilYear);
  const by = (a, b) => num(a.science, 0) - num(b.science, 0) || num(a.cost, 0) - num(b.cost, 0) || (a.id < b.id ? -1 : 1);
  const ready = list.filter(open).sort(by);
  if (ready.length) return ready[0];
  return list.slice().sort((a, b) => histYearOf(a) - histYearOf(b) || by(a, b))[0];
}

// ------------------------------------------------------------------ gates of items

const GATES = new WeakMap();

function destBodies(data, item) {
  const idx = data?.index?.destinations;
  const list = data?.destinations?.destinations || [];
  const out = new Set();
  for (const id of item?.destinations || []) {
    const d = idx?.[id] || list.find((x) => x.id === id);
    if (d?.body) out.add(d.body);
    out.add(id); // classes may list destination ids too
  }
  return out;
}

function fieldMatches(want, have) {
  if (Array.isArray(want)) return want.includes(have);
  if (want === true) return !!have;
  if (want === false) return !have;
  return have === want;
}

/** Does `item` match a rule's `match` object? `crewRated` rules only count when the mission is crewed. */
function ruleMatches(data, match, item, crewed) {
  for (const [f, want] of Object.entries(match || {})) {
    switch (f) {
      case 'crewMin': if (!(num(item.crew, 0) >= want)) return false; break;
      case 'crewMax': if (!(num(item.crew, 0) <= want)) return false; break;
      case 'destClass': {
        const cls = data?.techtree?.destClass?.[want] || [];
        const bodies = destBodies(data, item);
        if (!cls.some((b) => bodies.has(b))) return false;
        break;
      }
      case 'crewRated': if (!crewed || !fieldMatches(want, item.crewRated)) return false; break;
      default: if (!fieldMatches(want, item[f])) return false;
    }
  }
  return true;
}

/**
 * Keys an item needs: its `gate` override when present (`[]` = ungated), else every matching rule of
 * data.techtree.gates[kind] (AND). kind: vehicle | spacecraft | part | template (any other kind with rules works).
 * Rule forms: {match, key} · {match, keys: [...]} · {match, subKey: 'satellite'} → `satellite:<item.sub>`.
 */
export function gatesOf(data, kind, item, opts) {
  if (!item || typeof item !== 'object') return [];
  if (Array.isArray(item.gate)) return item.gate;
  const rules = data?.techtree?.gates?.[kind];
  if (!Array.isArray(rules) || !rules.length) return [];
  const crewed = !!opts?.crewed;
  // memo per item object → kind → {rules, [plain, crewed]} (a new rules table, i.e. new data, recomputes)
  let m = GATES.get(item);
  if (!m) { m = {}; GATES.set(item, m); }
  let slot = m[kind];
  if (!slot || slot.rules !== rules) slot = m[kind] = { rules, out: [null, null] };
  const i = crewed ? 1 : 0;
  if (slot.out[i]) return slot.out[i];
  const out = [];
  for (const r of rules) {
    if (!r || !ruleMatches(data, r.match, item, crewed)) continue;
    if (typeof r.key === 'string') out.push(r.key);
    if (Array.isArray(r.keys)) out.push(...r.keys.filter((k) => typeof k === 'string'));
    if (typeof r.subKey === 'string' && item.sub) out.push(`${r.subKey}:${item.sub}`);
  }
  slot.out[i] = [...new Set(out)];
  return slot.out[i];
}

const OK = Object.freeze({ ok: true, key: null, nodeId: null, reason: null });

function missing(state, data, key, fmt) {
  const node = nodeForKey(state, data, key);
  const name = node?.name || keyLabel(data, key);
  return { ok: false, key, nodeId: node?.id || null, nodeName: name, reason: fmt(name) };
}

/** First key in `keys` the actor lacks → {ok:false, key, nodeId, reason}, or OK. */
export function firstMissing(state, data, keys, actorId = state?.playerId, fmt = (name) => `Pesquise ${name}`) {
  for (const k of keys || []) if (!keyHeld(state, data, k, actorId)) return missing(state, data, k, fmt);
  return OK;
}

/** Boolean fast path of itemGate (no reason, no node lookup): does the actor hold every key the item needs? */
export function itemHeld(state, data, kind, item, actorId = state?.playerId, opts = {}) {
  if (!item) return true;
  for (const k of gatesOf(data, kind, item, opts)) if (!keyHeld(state, data, k, actorId)) return false;
  return true;
}

/** Can the actor use this catalog item by research? → {ok, key, nodeId, reason: 'Pesquise {nó}'}. */
export function itemGate(state, data, kind, item, actorId = state?.playerId, opts = {}) {
  if (!item) return OK;
  return firstMissing(state, data, gatesOf(data, kind, item, opts), actorId, opts.fmt);
}

// ------------------------------------------------------------------ mission gate

const subtypesOf = (data) => data?.missions?.subtypes || [];
function subRow(data, type, sub) {
  if (!type || !sub) return null;
  return subtypesOf(data).find((r) => r?.type === type && r.id === sub) || null;
}
function moduleRow(data, id) {
  if (!id) return null;
  const M = data?.modules || {};
  for (const k of ['station', 'base']) {
    const r = (Array.isArray(M[k]) ? M[k] : []).find((x) => x?.id === id);
    if (r) return r;
  }
  return (Array.isArray(M.modules) ? M.modules : []).find((x) => x?.id === id) || null;
}
const vehicleRow = (data, id) => (id ? (Array.isArray(data?.modules?.vehicles) ? data.modules.vehicles : []).find((x) => x?.id === id) || null : null);

/** Resolved {type, sub} of a (possibly legacy) mission type. */
export function resolveType(type, sub = null) {
  const a = TYPE_ALIASES[type];
  return a ? { type: a.type, sub: sub || a.sub } : { type, sub };
}

/**
 * missionGate(state, data, {type, sub, payloadKind, moduleId, vehicleTypeId, docking|targetKind}, actorId) →
 * {ok, key, nodeId, reason}. Checks, in order: `missionType:<type>`, the subtype's key, the payload kind's key
 * (cargo subtype of that id, or techtree.payloadKeys), the module's key, the surface vehicle's key, and
 * `missionType:docking` when the target is a station asset. Reason: 'Pesquise {nó} para liberar {rótulo}.'
 */
export function missionGate(state, data, spec = {}, actorId = state?.playerId) {
  const { type, sub } = resolveType(spec.type, spec.sub);
  const checks = [];
  if (type) checks.push([`missionType:${type}`, TYPE_LABELS[type] || type]);
  const sr = subRow(data, type, sub);
  if (sr?.key) checks.push([sr.key, sr.label || sub]);
  if (spec.payloadKind) {
    const pr = subRow(data, 'cargo', spec.payloadKind);
    const pk = pr?.key || data?.techtree?.payloadKeys?.[spec.payloadKind];
    if (pk && pk !== sr?.key) checks.push([pk, pr?.label || spec.payloadKind]);
  }
  const mr = moduleRow(data, spec.moduleId);
  if (mr?.key) checks.push([mr.key, `o módulo ${mr.label || mr.name || spec.moduleId}`]);
  const vr = vehicleRow(data, spec.vehicleTypeId);
  if (vr?.key) checks.push([vr.key, `o veículo ${vr.label || vr.name || spec.vehicleTypeId}`]);
  if (spec.docking || spec.targetKind === 'station') checks.push(['missionType:docking', TYPE_LABELS.docking]);
  for (const [key, label] of checks) {
    if (keyHeld(state, data, key, actorId)) continue;
    const res = missing(state, data, key, (name) => `Pesquise ${name} para liberar ${label}.`);
    return { ...res, label };
  }
  return OK;
}

/** Grandfathering (§5.3): hardware already committed keeps working. */
export const grandfatheredMission = (m) => !!m && m.status != null && m.status !== 'planning';
export const grandfatheredDesign = (d) => d?.program?.phase === 'operational';

// ------------------------------------------------------------------ historical grant

/** requires-closure of some node ids (ids not in data are dropped). */
export function requiresClosure(data, ids) {
  const byId = keyIndex(data).byId;
  const out = new Set();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    const n = byId.get(id);
    if (!n) continue;
    out.add(id);
    for (const r of n.requires || []) if (!out.has(r)) stack.push(r);
  }
  return out;
}

/**
 * historicalGrant(data, year, {have}) → sorted node ids: `have` ∪ every non-secret unlock node with
 * histYear < year (strictly earlier) ∪ the requires closure of those (efficiency ancestors included).
 */
export function historicalGrant(data, year, { have = [] } = {}) {
  const roots = nodesOf(data).filter((n) => n?.id && !n.secret && nodeKind(n) === 'unlock' && histYearOf(n) < year).map((n) => n.id);
  const out = requiresClosure(data, roots);
  for (const id of have || []) out.add(id);
  return [...out].sort();
}

// ------------------------------------------------------------------ what a key unlocks (UI)

const TARGETS = new WeakMap();
const yearFrom = (it) => num(it?.availableFrom?.year, num(it?.fromYear, num(it?.histYear, -Infinity)));
const yearUntil = (it) => num(it?.availableUntil?.year, Infinity);

function targetTable(data) {
  const nodes = data?.tech?.nodes || EMPTY_INDEX;
  let t = TARGETS.get(nodes);
  if (t && t.data === data) return t;
  const map = new Map();
  const add = (key, name, it) => {
    if (!key || !name) return;
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (!list.some((x) => x.name === name)) list.push({ name, from: yearFrom(it), until: yearUntil(it) });
  };
  for (const v of data?.vehicles?.vehicles || []) for (const k of gatesOf(data, 'vehicle', v)) add(k, v.name, v);
  for (const v of data?.vehicles?.vehicles || []) for (const k of gatesOf(data, 'vehicle', v, { crewed: true })) add(k, v.name, v);
  for (const s of data?.spacecraft?.spacecraft || []) for (const k of gatesOf(data, 'spacecraft', s)) add(k, s.name, s);
  for (const p of data?.parts?.parts || []) for (const k of gatesOf(data, 'part', p)) add(k, p.name, p);
  for (const p of data?.parts?.templates || []) for (const k of gatesOf(data, 'template', p)) add(k, `Modelo ${p.name}`, p);
  for (const r of subtypesOf(data)) add(r.key, r.label || r.id, r);
  for (const k of ['station', 'base', 'vehicles']) for (const r of (Array.isArray(data?.modules?.[k]) ? data.modules[k] : [])) add(r.key, r.label || r.name || r.id, r);
  for (const list of map.values()) list.sort((a, b) => a.from - b.from || (a.name < b.name ? -1 : 1));
  t = { data, map };
  TARGETS.set(nodes, t);
  return t;
}

/**
 * unlockTargets(data, state, key) → {names: ≤ 6 catalog names now matched by the key, more: n, total}.
 * Items already out of service at the current year are left out; sorted by debut.
 */
export function unlockTargets(data, state, key, max = 6) {
  const all = targetTable(data).map.get(key) || [];
  const year = state ? yearOf(state) : null;
  const live = year == null ? all : all.filter((x) => x.until >= year);
  return { names: live.slice(0, max).map((x) => x.name), more: Math.max(0, live.length - max), total: live.length };
}

// Actor lifecycle (EXPANSION.md §3): agencies and companies are born, renamed, merged and dissolved over time.
// - Real history 1950–2030 comes from data (data/core/lineages.json + lifecycle.json + nations.json).
// - After 2030 speculative actors are generated deterministically (data/core/actor-gen.json): names, nation, kind,
//   culture, goals and an emblem spec, all drawn from rngFor(seed, 'lifecycle', year, …).
// - The lineage id is stable; the identity (name, short, flag, country) changes with the date and is written into
//   state.actors[id] so every existing reader of actor.name keeps working.
// - Dead actors leave state.actors and become tombstones; absorbed predecessors become aliases.
// The module is a no-op unless data.scenario.lifecycle === 'on' (the Corrida Lunar keeps its golden).
//
// Slice: state.lifecycle = {applied:{eventId:turn}, aliases:{old:into}, tombstones:{id:tomb}, births:n,
//   nextGenTurn, booted, lastYear, idents:{id:{fromTurn,name,short,n}}, watch:{id:{neg}}, mergeWatch:{key:years}, once:{}}
// Uses (never edits): diplomacy.addActor/retireActor, politics.ensureNation/retireNation, ctx.hooks.
// While those APIs are missing it falls back to the minimal equivalent so the module works on its own.

import { rngFor, hash32 } from '../core/rng.js';
import { addNews, emitSignal, pushDecision, changeActor, log, relKey, clamp } from '../core/helpers.js';
import { dateToTurn, turnToDate, eraAt, WEEKS_PER_YEAR } from '../core/time.js';
import * as diplomacy from './diplomacy.js';
import * as politics from './politics.js';

/** Converted to variable steps: yearly logic reads the window, dated events apply in the tick that contains them. */
export const meta = { maxDt: 52 };

const DEFAULT_REL = { trust: 0, dependence: 0, rivalry: 10 };
const TOMB_CAP = 200;
const DEFAULT_CAPS = { core: 12, minor: 24 };

// ---------------------------------------------------------------- data access (tolerant of shapes)

const listOf = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);
export const lineagesOf = (data) => listOf(data?.lineages, 'lineages');
export const eventsOf = (data) => listOf(data?.lifecycle, 'events');
export const nationsOf = (data) => listOf(data?.nations, 'nations');
const gen = (data) => data?.actorGen || {};
const texts = (data) => (data?.lifecycle && !Array.isArray(data.lifecycle) ? data.lifecycle.texts : null) || {};
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const isOn = (data) => data?.scenario?.lifecycle === 'on';

const CACHE = new WeakMap();
/** Per-data lookups: lineages by id, events sorted by date, nations by id, birth/death by lineage. */
function tables(data) {
  // keyed by data, checked against the source lists: a lazy pack load rebuilds data in place (src/core/data.js)
  const c = data && CACHE.get(data);
  if (c && c.src[0] === data.lineages && c.src[1] === data.lifecycle && c.src[2] === data.nations) return c;
  const lineages = {};
  for (const l of lineagesOf(data)) if (l?.id) lineages[l.id] = l;
  const nations = {};
  for (const n of nationsOf(data)) if (n?.id) nations[n.id] = n;
  const events = eventsOf(data).filter((e) => e?.id && e.date).map((e, i) => ({ e, i, key: dateKey(e.date) }));
  events.sort((a, b) => a.key - b.key || a.i - b.i);
  const birth = {}; // lineage id -> date
  const death = {}; // lineage id -> {date, into, cause}
  for (const { e } of events) {
    if (e.op === 'birth' && e.actor && !birth[e.actor]) birth[e.actor] = e.date;
    if (e.op === 'split') for (const id of e.into || []) if (!birth[id]) birth[id] = e.date;
    if (e.op === 'merge') for (const id of e.from || []) if (!death[id]) death[id] = { date: e.date, into: e.into, cause: 'merge' };
    if (e.op === 'dissolve' && e.actor && !death[e.actor]) death[e.actor] = { date: e.date, into: null, cause: 'dissolve' };
  }
  const t = { lineages, nations, events: events.map((x) => x.e), birth, death, src: [data?.lineages, data?.lifecycle, data?.nations] };
  if (data) CACHE.set(data, t);
  return t;
}

const asDate = (d) => (typeof d === 'number' ? { year: d, month: 0 } : { year: d?.year ?? 0, month: d?.month ?? 0 });
const dateKey = (d) => { const x = asDate(d); return x.year * 12 + x.month; };
/** Turn of a {year, month} (or a bare year) relative to startYear. */
export const turnOf = (d, startYear) => { const x = asDate(d); return dateToTurn(x.year, x.month, startYear); };
const yearAt = (state, turn) => (state.startYear ?? 0) + Math.floor(turn / WEEKS_PER_YEAR);

// ---------------------------------------------------------------- pure lineage queries

/** Birth date of a lineage: its 'birth' event if any, else lineage.born (null = always alive). */
export function birthDate(data, id) {
  const t = tables(data);
  return t.birth[id] || t.lineages[id]?.born || null;
}

/** Is the lineage alive at `turn` (data history only; procedural actors are not lineages)? */
export function aliveAt(data, id, turn, startYear) {
  const t = tables(data);
  if (!t.lineages[id]) return false;
  const b = birthDate(data, id);
  if (b && turnOf(b, startYear) > turn) return false;
  const d = t.death[id];
  if (d && turnOf(d.date, startYear) <= turn) return false;
  return true;
}

function identityIndexAt(lin, turn, startYear) {
  const ids = lin?.identities || [];
  let idx = 0;
  for (let i = 0; i < ids.length; i++) if (turnOf(ids[i].from, startYear) <= turn) idx = i;
  return idx;
}

/**
 * Identity of a lineage at a turn (data only): identities are cumulative, a later entry inherits the fields it does
 * not set (flag, country…). Returns {idx, lineage, name, short, flag, country, …} or null for unknown ids.
 */
export function identityAt(data, id, turn, startYear) {
  const lin = tables(data).lineages[id];
  if (!lin) return null;
  const ids = lin.identities || [];
  const idx = identityIndexAt(lin, turn, startYear);
  const out = { idx, lineage: id };
  for (let i = 0; i <= idx && i < ids.length; i++) {
    const { from, ...rest } = ids[i];
    Object.assign(out, rest);
    out.from = from;
  }
  if (!out.name) out.name = id;
  if (!out.short) out.short = out.name;
  return out;
}

/** Nation id of a lineage at a turn. */
export function nationAt(data, id, turn, startYear) {
  const lin = tables(data).lineages[id];
  let n = null;
  for (const e of lin?.nation || []) if (turnOf(e.from, startYear) <= turn) n = e.id;
  return n ?? lin?.nation?.[0]?.id ?? null;
}

/** Budget from the lineage's budgetSeries (linear interpolation, clamped at the ends). */
export function budgetAt(lin, year) {
  const s = (lin?.budgetSeries || []).filter((p) => Array.isArray(p) && p.length >= 2).slice().sort((a, b) => a[0] - b[0]);
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

function nationAlive(n, year) {
  if (!n) return false;
  const f = asDate(n.from).year;
  const to = n.to ? asDate(n.to).year : Infinity;
  return f <= year && year < to;
}

/** Scenario start as {year, month, startYear} from a normalized or legacy scenario. */
function scenarioStart(sc) {
  const year = sc?.start?.year ?? sc?.startYear ?? 2026;
  return { year, month: sc?.start?.month ?? 0 };
}

/**
 * Actors the player may direct at the start of a scenario (works before a state exists; the new-game screen uses it).
 * rule 'alive': lineages alive at the start with playableFrom ≤ start year (plus listed ones that are alive);
 * rule 'list' (and every scenario with the lifecycle off): exactly the listed actors.
 */
export function playableAt(data, scenario = data?.scenario) {
  const sc = scenario || {};
  const { year, month } = scenarioStart(sc);
  const turn = dateToTurn(year, month, year);
  const listed = sc.playable?.actors || sc.playableActors || [];
  const rule = sc.lifecycle === 'on' ? (sc.playable?.rule || 'alive') : 'list';
  const legacy = {};
  for (const a of data?.actors?.actors || []) legacy[a.id] = a;
  const t = tables(data);
  const row = (id) => {
    const ident = sc.lifecycle === 'on' ? identityAt(data, id, turn, year) : null;
    const lin = t.lineages[id];
    const base = legacy[id] || {};
    return {
      id, name: ident?.name ?? base.name ?? id, short: ident?.short ?? base.short ?? id, flag: ident?.flag ?? base.flag ?? '',
      country: ident?.country ?? base.country ?? '', kind: lin?.kind ?? base.kind ?? 'agency', tier: lin?.tier ?? 'core',
      emerging: !!lin?.emerging, color: ident?.color ?? lin?.color ?? base.color ?? null,
    };
  };
  if (rule === 'list') {
    const ids = listed.filter((id) => sc.lifecycle !== 'on' || !t.lineages[id] || aliveAt(data, id, turn, year));
    return ids.map(row);
  }
  const out = [];
  const seen = new Set();
  for (const lin of lineagesOf(data)) {
    if (!aliveAt(data, lin.id, turn, year)) continue;
    if (!(Number.isFinite(lin.playableFrom) && lin.playableFrom <= year) && !listed.includes(lin.id)) continue;
    out.push(row(lin.id));
    seen.add(lin.id);
  }
  for (const id of listed) if (!seen.has(id) && aliveAt(data, id, turn, year)) out.push(row(id));
  return out;
}

/** {ok, error?}: the chosen actor must exist at the scenario start (pt-BR message for the new-game screen). */
export function checkPlayable(data, playerId, scenario = data?.scenario) {
  if (!playerId) return { ok: false, error: 'Escolha uma agência para dirigir.' };
  if (String(playerId).startsWith('custom_')) return { ok: true };
  const ok = playableAt(data, scenario).some((p) => p.id === playerId);
  return ok ? { ok: true } : { ok: false, error: 'Esta agência ainda não existe na data de início do cenário.' };
}

// ---------------------------------------------------------------- slice

function slice(state) {
  const L = state.lifecycle && typeof state.lifecycle === 'object' ? state.lifecycle : (state.lifecycle = {});
  L.applied = L.applied || {};
  L.aliases = L.aliases || {};
  L.tombstones = L.tombstones || {};
  if (!Number.isFinite(L.births)) L.births = 0;
  if (L.nextGenTurn === undefined) L.nextGenTurn = null;
  L.idents = L.idents || {};
  L.watch = L.watch || {};
  L.mergeWatch = L.mergeWatch || {};
  L.once = L.once || {};
  return L;
}

const caps = (data) => ({ ...DEFAULT_CAPS, ...(gen(data).caps || {}) });
const tierOf = (a) => a?.tier || 'core';
function liveIds(state) { return Object.keys(state.actors || {}).sort(); }
function countTier(state, tier) {
  return liveIds(state).filter((id) => id !== state.playerId && tierOf(state.actors[id]) === tier).length;
}

// ---------------------------------------------------------------- text helpers

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
function text(data, rng, key, vars, fallback) {
  const list = texts(data)[key];
  const tpl = Array.isArray(list) && list.length ? (rng ? rng.pick(list) : list[0]) : (typeof list === 'string' ? list : fallback);
  return fill(tpl || fallback || '', vars);
}
const kindLabel = (data, kind) => texts(data).kindLabel?.[kind] || 'ator espacial';

function news(state, item, turn) {
  const n = addNews(state, { tags: ['lifecycle'], icon: 'agency', ...item });
  if (Number.isFinite(turn) && turn > n.turn) n.turn = turn;
  return n;
}

// ---------------------------------------------------------------- actor defs

/** Full actor definition of a lineage at a turn (shape of data/actors.json entries + lifecycle fields). */
export function buildDef(state, data, id, turn) {
  const t = tables(data);
  const lin = t.lineages[id];
  const startYear = state.startYear;
  const year = yearAt(state, turn);
  const ident = identityAt(data, id, turn, startYear) || { idx: 0, name: id, short: id };
  const legacy = (data?.actors?.actors || []).find((a) => a.id === id);
  const modern = year >= 2026; // today's profile (Artemis goals, crewed capsules) only from the era it describes
  const base = legacy ? clone(legacy) : {};
  delete base.bloc;
  const start = lin?.start || {};
  const eraId = eraAt(data, year)?.id;
  const prof = lin?.eraProfiles?.[eraId] || {};
  const budget = Math.round(budgetAt(lin, year) ?? base.budget ?? 100);
  const def = {
    ...base,
    id,
    name: ident.name, short: ident.short, flag: ident.flag ?? base.flag ?? '', country: ident.country ?? base.country ?? '',
    color: ident.color ?? lin?.color ?? base.color ?? '#888888',
    kind: ident.kind ?? lin?.kind ?? base.kind ?? 'agency',
    description: ident.description ?? (modern ? base.description : '') ?? '',
    style: ident.style ?? (modern ? base.style : '') ?? '',
    budget,
    cash: Math.round(budget * 0.25),
    support: start.support ?? base.support ?? 60,
    reputation: start.reputation ?? base.reputation ?? 50,
    culture: start.culture ?? base.culture ?? 0,
    prestige: 0,
    fixedCostShare: start.fixedCostShare ?? base.fixedCostShare ?? 0.5,
    capabilities: clone(start.capabilities ?? (modern && base.capabilities ? base.capabilities : { crewed: false, launchSites: [] })),
    ai: { cooperation: 0.5, aggression: 0.5, riskTolerance: 0.5, goals: [], ...(modern ? clone(base.ai || {}) : {}), ...clone(start.ai || {}), ...clone(prof.ai || {}) },
    tier: lin?.tier || 'core',
    nation: nationAt(data, id, turn, startYear),
    lineage: id,
    born: asDate(birthDate(data, id) || turnToDate(turn, startYear)),
    identityIdx: ident.idx,
    emblem: ident.emblem ?? lin?.emblem ?? null,
  };
  if (!modern && def.ai) def.ai.goals = (start.ai?.goals || prof.ai?.goals || []).slice();
  return def;
}

/** Write the date's identity into the live actor. Returns the old name. */
function applyIdentity(state, data, id, turn) {
  const a = state.actors?.[id];
  if (!a) return null;
  const old = a.name;
  const ident = identityAt(data, id, turn, state.startYear);
  if (ident) {
    for (const k of ['name', 'short', 'flag', 'country']) if (ident[k] != null) a[k] = ident[k];
    if (ident.kind) a.kind = ident.kind;
    if (ident.emblem) a.emblem = ident.emblem;
    if (ident.color) a.color = ident.color;
    if (ident.description) a.description = ident.description;
    if (ident.style) a.style = ident.style;
    a.identityIdx = ident.idx;
  }
  const spec = slice(state).idents[id];
  if (spec && spec.fromTurn <= turn) {
    a.name = spec.name;
    a.short = spec.short;
    a.identityIdx = 100 + (spec.n || 1);
  }
  return old;
}

/** Identity key a live actor should have at `turn` (data identity or a speculative successor). */
function identityKey(state, data, id, turn) {
  const spec = slice(state).idents[id];
  if (spec && spec.fromTurn <= turn) return 100 + (spec.n || 1);
  const lin = tables(data).lineages[id];
  return lin ? identityIndexAt(lin, turn, state.startYear) : null;
}

// ---------------------------------------------------------------- add / remove (published APIs + fallbacks)

function fallbackAdd(state, def) {
  const ac = clone(def);
  ac.cash = ac.cash ?? Math.round((ac.budget || 0) * 0.25);
  ac.prestige = ac.prestige ?? 0;
  ac.support = ac.support ?? 60;
  ac.reputation = ac.reputation ?? 60;
  ac.culture = ac.culture ?? 0;
  ac.fixedCostShare = ac.fixedCostShare ?? 0.5;
  ac.capabilities = ac.capabilities || { crewed: false, launchSites: [] };
  ac.ai = { cooperation: 0.5, aggression: 0.5, riskTolerance: 0.5, goals: [], ...(ac.ai || {}) };
  ac.ai.nextEvalTurn = state.turn + 1 + (hash32(state.seed, 'lifecycle', 'stagger', ac.id) % 5);
  ac.ai.memory = ac.ai.memory || { rejected: {}, brokenBy: {}, withdrew: {} };
  ac.ai.prestigeHistory = ac.ai.prestigeHistory || [];
  ac.bloc = null;
  delete ac.relations;
  state.actors[ac.id] = ac;
}

/** Remove every diplomacy reference to a gone actor (idempotent; a no-op after diplomacy.retireActor). */
function purgeRefs(state, id) {
  if (state.actors) delete state.actors[id];
  for (const k of Object.keys(state.relations || {})) {
    const [a, b] = k.split('|');
    if (a === id || b === id) delete state.relations[k];
  }
  for (const b of Object.values(state.blocs || {})) {
    if (!Array.isArray(b.members) || !b.members.includes(id)) continue;
    b.members = b.members.filter((m) => m !== id);
    if (b.leader === id) b.leader = b.members[0] || null;
  }
  for (const t of state.treaties || []) {
    if (!Array.isArray(t.parties) || !t.parties.includes(id)) continue;
    t.parties = t.parties.filter((p) => p !== id);
    if (t.parties.length < 2 && t.status === 'active') t.status = 'expired';
  }
  if (Array.isArray(state.proposals)) state.proposals = state.proposals.filter((p) => p.from !== id && p.to !== id);
}

function dropRelations(state, id) {
  for (const k of Object.keys(state.relations || {})) {
    const [a, b] = k.split('|');
    if (a === id || b === id) delete state.relations[k];
  }
  if (Array.isArray(state.proposals)) state.proposals = state.proposals.filter((p) => p.from !== id && p.to !== id);
}

function ensureRelations(state, id) {
  state.relations = state.relations || {};
  for (const o of liveIds(state)) {
    if (o === id || tierOf(state.actors[o]) !== 'core') continue;
    const k = relKey(id, o);
    if (!state.relations[k]) state.relations[k] = { ...DEFAULT_REL };
  }
}

function ensureNation(state, data, nid, ctx) {
  if (!nid) return;
  if (typeof politics.ensureNation === 'function') {
    try { politics.ensureNation(state, data, nid, ctx); } catch (e) { log(state, `lifecycle: ensureNation ${nid}: ${e.message}`); }
  }
}

/**
 * Bring a new actor to life: diplomacy.addActor (or the fallback), lifecycle fields, relation rows and seeds with
 * live core actors (same nation = warm start), bloc of its nation, politics nation, hooks and signal.
 */
function addActor(state, data, ctx, def, info = {}) {
  const seeds = def.relations || [];
  if (typeof diplomacy.addActor === 'function') {
    try { diplomacy.addActor(state, data, clone(def), ctx); } catch (e) { log(state, `lifecycle: addActor ${def.id}: ${e.message}`); }
  }
  if (!state.actors[def.id]) fallbackAdd(state, def);
  const a = state.actors[def.id];
  for (const k of ['tier', 'nation', 'lineage', 'born', 'identityIdx', 'emblem', 'generated', 'archetype', 'custom']) {
    if (def[k] !== undefined) a[k] = clone(def[k]);
  }
  if (!a.tier) a.tier = 'core';
  if (def.id === state.playerId) a.tier = 'core';
  if (a.tier === 'core') {
    ensureRelations(state, def.id);
    for (const o of liveIds(state)) {
      if (o === def.id || tierOf(state.actors[o]) !== 'core') continue;
      if (a.nation && state.actors[o].nation === a.nation) {
        const r = state.relations[relKey(def.id, o)];
        r.trust = clamp(r.trust + 30, -100, 100);
        r.dependence = clamp(r.dependence + 15, 0, 100);
      }
    }
    for (const s of seeds) {
      const o = s.with || s.b;
      if (!state.actors[o] || o === def.id) continue;
      const k = relKey(def.id, o);
      state.relations[k] = {
        trust: clamp(s.trust ?? 0, -100, 100), dependence: clamp(s.dependence ?? 0, 0, 100), rivalry: clamp(s.rivalry ?? 10, 0, 100),
      };
    }
  } else {
    dropRelations(state, def.id); // background actors carry no relation rows (EXPANSION.md §3.1)
  }
  // bloc: the one in the definition, else the bloc of an actor of the same nation
  if (!a.bloc && state.blocs) {
    let bid = def.bloc && state.blocs[def.bloc] ? def.bloc : null;
    if (!bid && a.nation) {
      for (const o of liveIds(state)) {
        if (o !== def.id && state.actors[o].nation === a.nation && state.actors[o].bloc && state.blocs[state.actors[o].bloc]) { bid = state.actors[o].bloc; break; }
      }
    }
    if (bid) {
      const b = state.blocs[bid];
      b.members = Array.isArray(b.members) ? b.members : [];
      if (!b.members.includes(def.id)) b.members.push(def.id);
      if (!b.leader) b.leader = def.id;
      a.bloc = bid;
    }
  }
  ensureNation(state, data, a.nation, ctx);
  ctx?.hooks?.actorBorn?.(def.id, { lineage: a.lineage ?? null, tier: a.tier, nation: a.nation ?? null, kind: a.kind, generated: !!a.generated, reason: info.reason || 'birth' });
  if (info.reason !== 'bootstrap') emitSignal(state, 'actor/born', { actorId: def.id, tier: a.tier, generated: !!a.generated });
  return a;
}

/** Retire an actor: tombstone, alias, diplomacy cleanup, hooks, signal. */
function retireActor(state, data, ctx, id, { into = null, reason = 'dissolve', turn = state.turn, quiet = false } = {}) {
  const L = slice(state);
  const a = state.actors?.[id];
  if (!a) return false;
  if (reason !== 'unborn') {
    L.tombstones[id] = {
      id, name: a.name, short: a.short, emblem: a.emblem ?? null, flag: a.flag ?? '',
      born: a.born?.year ?? null, died: yearAt(state, turn), into, cause: reason, prestigeTotal: Math.round(a.prestige || 0),
      ...(a.generated ? { generated: true } : {}),
    };
    if (into) L.aliases[id] = into;
  }
  if (typeof diplomacy.retireActor === 'function') {
    try { diplomacy.retireActor(state, data, id, { into, reason }, ctx); } catch (e) { log(state, `lifecycle: retireActor ${id}: ${e.message}`); }
  }
  purgeRefs(state, id);
  delete L.watch[id];
  delete L.idents[id];
  for (const k of Object.keys(L.mergeWatch)) if (k.split('|').includes(id)) delete L.mergeWatch[k];
  ctx?.hooks?.actorGone?.(id, { into, reason });
  if (!quiet) emitSignal(state, into ? 'actor/merged' : 'actor/gone', { actorId: id, into, reason });
  return true;
}

// ---------------------------------------------------------------- bootstrap (who exists at the start date)

/** The era snapshot named by the scenario (data.snapshots[eraId] from packs.js; tolerant of other shapes). */
function snapshotFor(data) {
  const id = data?.scenario?.snapshot;
  if (!id) return null;
  return data?.snapshots?.[id] || data?.eraPacks?.[id]?.snapshot || (data?.snapshot?.era === id ? data.snapshot : null) || null;
}

/**
 * Make state.actors match history at the start date: unborn and already-dead lineages leave (quietly), live ones get
 * their identity of the date and snapshot / lineage values, missing ones are added. The chosen player actor always
 * exists. Needs diplomacy.init to have run (call from postInit; tick self-heals if nobody did).
 */
export function bootstrap(state, data, ctx) {
  if (!isOn(data)) return false;
  const L = slice(state);
  if (L.booted) return false;
  const t = tables(data);
  const turn0 = state.turn;
  const startYear = state.startYear;
  state.actors = state.actors || {};
  const alive = lineagesOf(data).filter((l) => aliveAt(data, l.id, turn0, startYear)).map((l) => l.id);
  if (state.playerId && t.lineages[state.playerId] && !alive.includes(state.playerId)) {
    log(state, `lifecycle: ${state.playerId} não existe na data de início; criado mesmo assim (jogador)`);
    alive.push(state.playerId);
  }
  // 1) actors from today's roster that do not exist yet (or any more)
  for (const id of liveIds(state)) {
    if (id === state.playerId || !t.lineages[id] || alive.includes(id)) continue;
    retireActor(state, data, ctx, id, { reason: 'unborn', quiet: true });
  }
  // 2) history before the start: applied events, aliases and tombstones of predecessors already gone
  for (const e of t.events) {
    const et = turnOf(e.date, startYear);
    if (et >= turn0) continue;
    L.applied[e.id] = et;
    if (e.op === 'merge') {
      for (const f of e.from || []) {
        if (f === state.playerId) continue;
        L.aliases[f] = e.into;
        const ident = identityAt(data, f, et - 1, startYear);
        L.tombstones[f] = { id: f, name: ident?.name ?? f, short: ident?.short ?? f, emblem: null, flag: ident?.flag ?? '',
          born: birthDate(data, f) ? asDate(birthDate(data, f)).year : null, died: asDate(e.date).year, into: e.into, cause: 'merge', prestigeTotal: 0 };
      }
    }
  }
  // 3) live lineages at the start: identity, values (snapshot > lineage > today's profile)
  const snap = snapshotFor(data);
  const cap = caps(data);
  let core = 0, minor = 0;
  for (const id of alive) {
    const def = buildDef(state, data, id, turn0);
    const sv = snap?.actors?.[id];
    if (sv) {
      for (const [k, v] of Object.entries(sv)) {
        if (k === 'ai') def.ai = { ...def.ai, ...clone(v) };
        else def[k] = clone(v);
      }
    }
    if (id !== state.playerId) {
      if (def.tier === 'core' && core >= cap.core) def.tier = 'minor';
      if (def.tier === 'core') core++; else minor++;
    } else def.tier = 'core';
    const a = state.actors[id];
    if (a) {
      const keepAi = a.ai || {};
      for (const k of ['name', 'short', 'flag', 'country', 'color', 'kind', 'description', 'style', 'budget', 'cash', 'support',
        'reputation', 'culture', 'prestige', 'fixedCostShare', 'capabilities', 'tier', 'nation', 'lineage', 'born', 'identityIdx', 'emblem']) {
        if (def[k] !== undefined) a[k] = clone(def[k]);
      }
      a.ai = { ...keepAi, ...clone(def.ai) };
      a.ai.memory = keepAi.memory || { rejected: {}, brokenBy: {}, withdrew: {} };
      a.ai.prestigeHistory = keepAi.prestigeHistory || [];
      if (a.ai.nextEvalTurn == null) a.ai.nextEvalTurn = turn0 + 1;
      if (a.tier === 'minor') dropRelations(state, id);
      ensureNation(state, data, a.nation, ctx);
    } else {
      addActor(state, data, ctx, def, { reason: 'bootstrap' });
    }
  }
  // 4) the snapshot's world: relations of listed pairs; blocs and treaties when the snapshot lists them
  if (snap) {
    if (Array.isArray(snap.blocs)) {
      state.blocs = {};
      for (const b of snap.blocs) {
        const members = (b.members || []).filter((m) => state.actors[m]);
        state.blocs[b.id] = { ...clone(b), members, leader: state.actors[b.leader] ? b.leader : members[0] || null };
      }
      for (const a of Object.values(state.actors)) a.bloc = null;
      for (const b of Object.values(state.blocs)) for (const m of b.members) state.actors[m].bloc = b.id;
    }
    if (Array.isArray(snap.treaties)) state.treaties = clone(snap.treaties);
    if (Array.isArray(snap.blocs) || Array.isArray(snap.treaties)) state.proposals = [];
    for (const r of snap.relations || []) {
      if (!state.actors[r.a] || !state.actors[r.b] || r.a === r.b) continue;
      state.relations[relKey(r.a, r.b)] = {
        trust: clamp(r.trust ?? 0, -100, 100), dependence: clamp(r.dependence ?? 0, 0, 100), rivalry: clamp(r.rivalry ?? 10, 0, 100),
      };
    }
  }
  for (const id of liveIds(state)) if (tierOf(state.actors[id]) === 'core') ensureRelations(state, id);
  L.booted = true;
  L.bootTurn = turn0;
  return true;
}

// ---------------------------------------------------------------- module contract

export function init(state, data) {
  if (!isOn(data)) return; // Corrida Lunar: the slice stays as createState made it (golden unchanged)
  const L = slice(state);
  L.booted = false;
  L.nextGenTurn = turnOf({ year: gen(data).fromYear ?? 2031, month: 0 }, state.startYear);
  // diplomacy.init runs after this module and rebuilds today's roster: the engine calls postInit (or the first tick
  // self-heals) to reconcile it with history.
  if (state.actors && Object.keys(state.actors).length) bootstrap(state, data, null);
}

/** Called by the engine after every module's init (reconciles the roster with the start date). */
export function postInit(state, data, ctx) {
  bootstrap(state, data, ctx);
}

/** Dated events inside this tick's window [prevTurn, prevTurn + dt), then yearly work for year starts inside it. */
export function tick(state, data, ctx = {}) {
  if (!isOn(data)) return;
  const L = slice(state);
  if (!L.booted) bootstrap(state, data, ctx);
  const prev = Number.isFinite(ctx.prevTurn) ? ctx.prevTurn : state.turn;
  const dt = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 1;
  const end = prev + dt;
  const t = tables(data);
  for (const e of t.events) {
    if (L.applied[e.id] != null) continue;
    const et = turnOf(e.date, state.startYear);
    if (et >= end) break; // sorted by date
    applyEvent(state, data, ctx, e, Math.max(et, prev));
    L.applied[e.id] = et;
  }
  // identities without an event (and successors) follow the date silently
  for (const id of liveIds(state)) {
    const a = state.actors[id];
    if (!t.lineages[id] && !L.idents[id]) continue;
    const key = identityKey(state, data, id, end - 1);
    if (key != null && key !== a.identityIdx) applyIdentity(state, data, id, end - 1);
  }
  for (const y of yearStarts(state, prev, dt)) runYear(state, data, ctx, y);
}

/** Engine year hook: same yearly work, guarded so a year never runs twice. */
export function onYear(state, data, ctx = {}) {
  if (!isOn(data)) return;
  const prev = Number.isFinite(ctx.prevTurn) ? ctx.prevTurn : state.turn;
  const dt = Number.isFinite(ctx.dt) && ctx.dt > 0 ? ctx.dt : 1;
  for (const y of yearStarts(state, prev, dt)) runYear(state, data, ctx, y);
}

function yearStarts(state, prev, dt) {
  const out = [];
  const first = Math.ceil(prev / WEEKS_PER_YEAR) * WEEKS_PER_YEAR;
  for (let t = first; t < prev + dt; t += WEEKS_PER_YEAR) out.push(yearAt(state, t));
  return out;
}

/** Caps (tombstones 200) and stale bookkeeping. */
export function compact(state, data) {
  if (!state.lifecycle || !isOn(data)) return;
  const L = slice(state);
  const tombs = Object.values(L.tombstones);
  if (tombs.length > TOMB_CAP) {
    tombs.sort((a, b) => (a.died ?? 0) - (b.died ?? 0) || String(a.id).localeCompare(String(b.id)));
    for (const tb of tombs.slice(0, tombs.length - TOMB_CAP)) delete L.tombstones[tb.id];
  }
  // tombstones older than 15 years keep only what the annals/timeline show (name, dates, fate)
  const year = yearAt(state, state.turn);
  for (const tb of Object.values(L.tombstones)) {
    if (!(year - (tb.died ?? year) > 15) || tb.slim) continue;
    delete tb.emblem; delete tb.flag; delete tb.short;
    if (!tb.prestigeTotal) delete tb.prestigeTotal;
    if (!tb.into) delete tb.into;
    tb.slim = 1;
  }
  // and only the 40 most recent of those old generated ones stay (real lineages keep theirs: the catalog reads them)
  const slim = Object.values(L.tombstones).filter((tb) => tb.slim && tb.generated).sort((a, b) => (a.died ?? 0) - (b.died ?? 0) || String(a.id).localeCompare(String(b.id)));
  for (const tb of slim.slice(0, Math.max(0, slim.length - 40))) delete L.tombstones[tb.id];
  for (const id of Object.keys(L.watch)) if (!state.actors?.[id]) delete L.watch[id];
  for (const id of Object.keys(L.idents)) if (!state.actors?.[id]) delete L.idents[id];
  for (const k of Object.keys(L.mergeWatch)) if (k.split('|').some((id) => !state.actors?.[id])) delete L.mergeWatch[k];
}

// ---------------------------------------------------------------- dated events

function applyEvent(state, data, ctx, e, turn) {
  const rng = rngFor(state.seed, 'lifecycle', 'event', e.id);
  try {
    switch (e.op) {
      case 'birth': return opBirth(state, data, ctx, e, turn, rng);
      case 'rename': return opRename(state, data, ctx, e, turn, rng);
      case 'merge': return opMerge(state, data, ctx, e, turn, rng);
      case 'dissolve': return opDissolve(state, data, ctx, e, turn, rng);
      case 'nationSplit': return opNationSplit(state, data, ctx, e, turn, rng);
      case 'split': return opSplit(state, data, ctx, e, turn, rng);
      case 'privatize': case 'nationalize': return opKind(state, data, ctx, e, turn, rng);
      default: log(state, `lifecycle: operação desconhecida ${e.op} (${e.id})`);
    }
  } catch (err) {
    log(state, `lifecycle: erro em ${e.id}: ${err.message}`);
  }
  return null;
}

function bornHere(state, data, ctx, id, turn, rng, e = {}) {
  if (state.actors[id]) return null;
  const def = buildDef(state, data, id, turn);
  const cap = caps(data);
  if (def.tier === 'core' && id !== state.playerId && countTier(state, 'core') >= cap.core) def.tier = 'minor';
  if (def.tier === 'minor' && countTier(state, 'minor') >= cap.minor) {
    log(state, `lifecycle: ${id} não nasce (teto de atores menores)`);
    return null;
  }
  addActor(state, data, ctx, def, { reason: 'birth' });
  const a = state.actors[id];
  news(state, {
    headline: e.headline || text(data, rng, 'birth', { name: a.name, country: a.country || 'O mundo' }, 'Nasce {name}'),
    actors: [id], tags: ['lifecycle', 'birth'], importance: a.tier === 'core' ? 2 : 1,
  }, turn);
  return a;
}

function opBirth(state, data, ctx, e, turn, rng) {
  return bornHere(state, data, ctx, e.actor, turn, rng, e);
}

function opRename(state, data, ctx, e, turn, rng) {
  const id = e.actor;
  if (!state.actors[id]) return;
  const old = applyIdentity(state, data, id, turn);
  const a = state.actors[id];
  if (old === a.name) return;
  news(state, { headline: e.headline || text(data, rng, 'rename', { old, name: a.name }, '{old} agora é {name}'), actors: [id], tags: ['lifecycle', 'rename'], importance: 2 }, turn);
  emitSignal(state, 'actor/renamed', { actorId: id, from: old, to: a.name });
}

function opMerge(state, data, ctx, e, turn, rng) {
  const into = e.into;
  const target = state.actors[into];
  if (!target) { log(state, `lifecycle: fusão ${e.id} sem sobrevivente ${into}`); return; }
  const inh = e.inherit || {};
  const names = [];
  // e.rename: the survivor takes its identity of the date (ESRO → ESA) before anything is announced
  applyIdentity(state, data, into, turn);
  for (const f of e.from || []) {
    const a = state.actors[f];
    if (!a) { slice(state).aliases[f] = into; continue; }
    names.push(a.name);
    const playerAbsorbed = f === state.playerId;
    const cashShare = playerAbsorbed ? 1 : (Number.isFinite(inh.cash) ? inh.cash : 0.5);
    changeActor(state, into, 'cash', (a.cash || 0) * cashShare);
    if (inh.prestige === 'sum' || playerAbsorbed) changeActor(state, into, 'prestige', a.prestige || 0);
    if (Number.isFinite(inh.budget)) changeActor(state, into, 'budget', (a.budget || 0) * inh.budget);
    if (playerAbsorbed) {
      state.playerId = into;
      target.tier = 'core';
      const vars = { name: target.name, from: a.name, into: target.name };
      pushDecision(state, {
        kind: 'lifecycle/merge', blocking: true, urgency: 3, portrait: { actorId: into },
        title: text(data, null, 'playerMergeTitle', vars, 'Fusão: você agora dirige {name}'),
        body: text(data, null, 'playerMergeBody', vars, '{from} foi incorporada a {into}.'),
        choices: [{ id: 'ok', label: 'Assumir a direção' }], defaultChoice: 'ok', payload: { from: f, into },
      });
    }
    retireActor(state, data, ctx, f, { into, reason: 'merge', turn });
  }
  if (!names.length) return;
  const involvesPlayer = state.playerId === into;
  news(state, {
    headline: e.headline || text(data, rng, 'merge', { from: names.join(' e '), into: state.actors[into].name }, '{from} é absorvida por {into}'),
    actors: [into], tags: ['lifecycle', 'merge'], importance: involvesPlayer ? 3 : 2,
  }, turn);
}

function opDissolve(state, data, ctx, e, turn, rng) {
  const id = e.actor;
  const a = state.actors[id];
  if (!a) return;
  if (id === state.playerId) { log(state, `lifecycle: ${id} é do jogador; dissolução histórica ignorada`); return; }
  const name = a.name;
  retireActor(state, data, ctx, id, { into: e.into || null, reason: 'dissolve', turn });
  news(state, { headline: e.headline || text(data, rng, 'dissolve', { name }, '{name} encerra as atividades'), actors: [], tags: ['lifecycle', 'dissolve'], importance: 2 }, turn);
}

function opNationSplit(state, data, ctx, e, turn, rng) {
  const t = tables(data);
  for (const nid of e.into || []) ensureNation(state, data, nid, ctx);
  if (typeof politics.retireNation === 'function') {
    try { politics.retireNation(state, data, e.nation, { into: e.into || [] }, ctx); } catch (err) { log(state, `lifecycle: retireNation ${e.nation}: ${err.message}`); }
  }
  let playerHit = null;
  for (const [id, m] of Object.entries(e.actors || {})) {
    const a = state.actors[id];
    if (!a) continue;
    if (m.nation) a.nation = m.nation;
    if (Number.isFinite(m.budgetShock)) changeActor(state, id, 'budget', (a.budget || 0) * m.budgetShock);
    if (id === state.playerId) playerHit = { id, shock: m.budgetShock ?? 0 };
  }
  emitSignal(state, 'nation/split', { nation: e.nation, into: (e.into || []).slice() });
  const nname = t.nations[e.nation]?.name || e.nation;
  const list = (e.into || []).map((n) => t.nations[n]?.name || n);
  news(state, {
    headline: e.headline || text(data, rng, 'nationSplit', { nation: nname, list: list.join(', ') }, '{nation} se divide'),
    actors: Object.keys(e.actors || {}).filter((id) => state.actors[id]), tags: ['lifecycle', 'nation'], importance: 3,
  }, turn);
  if (playerHit) {
    const a = state.actors[playerHit.id];
    const cost = Math.max(1, Math.round((a.budget || 0) * 0.1));
    const vars = { nation: nname };
    pushDecision(state, {
      kind: 'lifecycle/crisis', blocking: true, urgency: 3, portrait: { actorId: playerHit.id },
      title: text(data, null, 'playerCrisisTitle', vars, '{nation} acabou'),
      body: text(data, null, 'playerCrisisBody', vars, 'A verba despenca. O que fazer com a equipe?'),
      choices: [
        { id: 'segurar', label: 'Segurar os engenheiros', preview: `Custa US$ ${cost} mi do caixa; reputação +3.` },
        { id: 'liberar', label: 'Deixar partir', preview: 'Caixa intacto; reputação −5 e apoio −5.' },
      ],
      defaultChoice: 'segurar', payload: { actorId: playerHit.id, cost },
    });
  }
}

function opSplit(state, data, ctx, e, turn, rng) {
  const src = state.actors[e.actor];
  for (const id of e.into || []) {
    const a = bornHere(state, data, ctx, id, turn, rng, {});
    if (a && src && Number.isFinite(e.budgetShare)) changeActor(state, e.actor, 'budget', -(src.budget || 0) * e.budgetShare);
  }
}

function opKind(state, data, ctx, e, turn, rng) {
  const a = state.actors[e.actor];
  if (!a) return;
  a.kind = e.op === 'privatize' ? 'company' : 'agency';
  applyIdentity(state, data, e.actor, turn);
  news(state, {
    headline: e.headline || (e.op === 'privatize' ? `${a.name} é privatizada` : `${a.name} passa ao Estado`),
    actors: [e.actor], tags: ['lifecycle'], importance: 2,
  }, turn);
  emitSignal(state, 'actor/renamed', { actorId: e.actor, from: a.name, to: a.name, kind: a.kind });
}

// ---------------------------------------------------------------- yearly: speculative world (≥ 2031)

function runYear(state, data, ctx, year) {
  const L = slice(state);
  if (Number.isFinite(L.lastYear) && L.lastYear >= year) return;
  L.lastYear = year;
  const g = gen(data);
  const rng = rngFor(state.seed, 'lifecycle', 'year', year);
  const fromYear = g.fromYear ?? 2031;
  const turn = Math.max(state.turn, turnOf({ year, month: 0 }, state.startYear));
  if (year >= fromYear) {
    yearDissolve(state, data, ctx, year, turn, rng);
    yearMerge(state, data, ctx, year, turn, rng);
    yearSuccessors(state, data, year, turn, rng);
    yearBirths(state, data, ctx, year, turn, rng);
  }
  yearTiers(state, data, year, turn, rng);
}

function yearDissolve(state, data, ctx, year, turn, rng) {
  const L = slice(state);
  const d = { cashNegativeYears: 3, supportBelow: 10, hazardPerYear: 0.05, minYears: 5, ...(gen(data).dissolve || {}) };
  const t = tables(data);
  // real lineages leave too in the speculative future (otherwise they hold 30 of the 36 slots for 950 years),
  // but rarely: companies more than agencies, the big national agencies least of all
  const lh = { fromYear: 2041, company: 0.006, agency: 0.002, core: 0.001, ...(d.lineage || {}) };
  for (const id of liveIds(state)) {
    const a = state.actors[id];
    if (id === state.playerId) continue;
    const lineage = !a.generated && !!t.lineages[id];
    if (!a.generated && !(lineage && year >= lh.fromYear)) continue;
    const w = L.watch[id] || (L.watch[id] = { neg: 0 });
    w.neg = (a.cash || 0) < 0 ? w.neg + 1 : 0;
    const age = year - (a.born?.year ?? year);
    const roll = rng.next();
    // real lineages only leave by the (low) hazard: their money and support are the game's, not history's
    const broke = !lineage && w.neg >= d.cashNegativeYears;
    const orphan = !lineage && (a.support ?? 50) < d.supportBelow;
    const pHaz = !lineage ? d.hazardPerYear : tierOf(a) === 'core' ? lh.core : a.kind === 'company' ? lh.company : lh.agency;
    const hazard = (lineage || age >= d.minYears) && roll < pHaz;
    if (!(broke || orphan || hazard)) continue;
    const name = a.name;
    retireActor(state, data, ctx, id, { reason: broke ? 'falencia' : orphan ? 'abandono' : 'dissolve', turn });
    news(state, { headline: text(data, rng, 'dissolve', { name }, '{name} encerra as atividades'), tags: ['lifecycle', 'dissolve'], importance: 1 }, turn);
  }
}

function yearMerge(state, data, ctx, year, turn, rng) {
  const L = slice(state);
  const m = { trust: 80, dependence: 60, years: 10, ...(gen(data).merge || {}) };
  const ids = liveIds(state).filter((id) => state.actors[id].generated && id !== state.playerId);
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const k = relKey(ids[i], ids[j]);
    const r = state.relations?.[k];
    if (r && r.trust >= m.trust && r.dependence >= m.dependence) { L.mergeWatch[k] = (L.mergeWatch[k] || 0) + 1; seen.add(k); }
  }
  for (const k of Object.keys(L.mergeWatch)) if (!seen.has(k)) delete L.mergeWatch[k];
  for (const k of Object.keys(L.mergeWatch).sort()) {
    if (L.mergeWatch[k] < m.years) continue;
    const [a, b] = k.split('|');
    if (!state.actors[a] || !state.actors[b]) continue;
    const [into, from] = (state.actors[a].budget || 0) >= (state.actors[b].budget || 0) ? [a, b] : [b, a];
    const fromName = state.actors[from].name;
    changeActor(state, into, 'cash', state.actors[from].cash || 0);
    changeActor(state, into, 'budget', (state.actors[from].budget || 0) * 0.5);
    changeActor(state, into, 'prestige', state.actors[from].prestige || 0);
    retireActor(state, data, ctx, from, { into, reason: 'merge', turn });
    news(state, { headline: text(data, rng, 'merge', { from: fromName, into: state.actors[into].name }, '{from} é absorvida por {into}'), actors: [into], tags: ['lifecycle', 'merge'], importance: 2 }, turn);
  }
}

function yearSuccessors(state, data, year, turn, rng) {
  const L = slice(state);
  const s = { fromYear: 2051, hazardPerYear: 0.01, names: ['Nova {short}'], ...(gen(data).successors || {}) };
  if (year < s.fromYear) return;
  const t = tables(data);
  for (const id of liveIds(state)) {
    const a = state.actors[id];
    if (!t.lineages[id] || id === state.playerId) continue;
    if (rng.next() >= s.hazardPerYear) continue;
    // the template always takes the lineage's own short name (ESA), never a previous successor (Nova ESA):
    // renames replace each other instead of stacking (Nova Nova ESA)
    const base = L.idents[id]?.base || String(identityAt(data, id, turn, state.startYear)?.short || a.short || a.name).replace(/\s*\(.*\)\s*/g, '').trim();
    const n = (L.idents[id]?.n || 0) + 1;
    const name = fill(rng.pick(s.names), { short: base, name: a.name });
    if (name === a.name) continue;
    const old = a.name;
    L.idents[id] = { fromTurn: turn, name, short: name.length <= 14 ? name : base, n, base };
    applyIdentity(state, data, id, turn);
    news(state, { headline: text(data, rng, 'successor', { old, name }, '{old} vira {name}'), actors: [id], tags: ['lifecycle', 'rename'], importance: 1 }, turn);
    emitSignal(state, 'actor/renamed', { actorId: id, from: old, to: name });
  }
}

function needsMet(state, needs) {
  if (!needs) return true;
  if (needs.colonyStage != null) {
    const st = state.colonies?.maxStage ?? Math.max(0, ...Object.values(state.colonies?.list || state.colonies || {}).map((c) => c?.stage || 0));
    if (!(st >= needs.colonyStage)) return false;
  }
  if (needs.ecoPieces != null) {
    const p = state.eco?.pieces;
    const n = Array.isArray(p) ? p.length : Number.isFinite(p) ? p : Object.keys(p || {}).length;
    if (!(n >= needs.ecoPieces)) return false;
  }
  return true;
}

function yearBirths(state, data, ctx, year, turn, rng) {
  const L = slice(state);
  const g = gen(data);
  const eraId = eraAt(data, year)?.id;
  const rate = g.births?.perYear?.[eraId] ?? 0;
  const roll = rng.next();
  if (!(roll < rate)) return;
  const eligible = (g.archetypes || []).filter((a) => year >= (a.fromYear ?? 0) && year <= (a.toYear ?? Infinity)
    && !(a.once && L.once[a.id]) && needsMet(state, a.needs));
  const arch = rng.weighted(eligible, (a) => a.weight ?? 1);
  if (!arch) return;
  const def = genActor(state, data, year, turn, arch, rng);
  if (!def) return;
  if (arch.once) L.once[arch.id] = true;
  addActor(state, data, ctx, def, { reason: 'birth' });
  const nat = tables(data).nations[def.nation];
  news(state, {
    headline: text(data, rng, 'birthGen', { name: def.name, kindLabel: kindLabel(data, def.kind), of: nat?.of || '' }, 'Nasce {name}').replace(/\s+,/g, ',').replace(/\s+$/, ''),
    actors: [def.id], tags: ['lifecycle', 'birth'], importance: def.tier === 'core' ? 2 : 1,
  }, turn);
}

const range = (rng, r, dflt) => (Array.isArray(r) ? r[0] + (r[1] - r[0]) * rng.next() : Number.isFinite(r) ? r : dflt);
const r2 = (x) => Math.round(x * 100) / 100;

function pickNation(state, data, arch, year, rng) {
  const t = tables(data);
  const alive = nationsOf(data).filter((n) => nationAlive(n, year));
  let pool = [];
  if (arch.nation === 'none') return null;
  if (arch.nation === 'emerging') {
    const used = new Set(liveIds(state).filter((id) => state.actors[id].kind === 'agency').map((id) => state.actors[id].nation));
    pool = alive.filter((n) => n.emerging && !used.has(n.id));
    if (!pool.length) pool = alive.filter((n) => !n.bloc);
  } else if (arch.nation === 'large') pool = alive.filter((n) => !n.bloc && (n.economy === 'large' || n.economy === 'medium'));
  else pool = alive.filter((n) => !n.bloc);
  if (!pool.length) return null;
  const pick = rng.pick(pool);
  return t.nations[pick.id] ? pick.id : null;
}

/** Deterministic speculative actor definition (null when caps are full). */
function genActor(state, data, year, turn, arch, rng) {
  const L = slice(state);
  const g = gen(data);
  const cap = caps(data);
  let tier = 'core';
  if (countTier(state, 'core') >= cap.core) tier = 'minor';
  if (tier === 'minor' && countTier(state, 'minor') >= cap.minor) return null;
  const nationId = pickNation(state, data, arch, year, rng);
  const nat = tables(data).nations[nationId];
  if (arch.nation === 'emerging' && !nat) return null;
  const gr = g.grammar || {};
  const taken = new Set([...liveIds(state).map((id) => state.actors[id].name), ...Object.values(L.tombstones).map((tb) => tb.name)]);
  let name = null, short = null;
  for (let i = 0; i < 8 && !name; i++) {
    const pre = rng.pick(gr.pre || ['Astra']);
    const place = rng.pick(gr.place || ['Tharsis']);
    const vars = {
      of: nat?.of || '', abbr: nat?.abbr || '', pre, suf: rng.pick(gr.suf || ['Orbital']), place,
      pre3: pre.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3).toUpperCase(),
      place3: place.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3).toUpperCase(),
    };
    const cand = fill(rng.pick(arch.names || ['{pre}']), vars).replace(/\s+/g, ' ').trim();
    if (!taken.has(cand)) { name = cand; short = fill(rng.pick(arch.short || ['{pre}']), vars).slice(0, 12); }
  }
  L.births += 1;
  const n = L.births;
  if (!name) { name = `${fill((arch.names || ['{pre}'])[0], { of: nat?.of || '', pre: 'Nova', suf: '', place: '' }).trim()} ${n}`; short = `N${n}`; }
  const id = `gen_${n}`;
  const st = arch.start || {};
  const eraId = eraAt(data, year)?.id;
  const scale = g.budgetScale?.[eraId] ?? 1;
  const budget = Math.round(range(rng, st.budget, 200) * scale);
  const pal = rng.pick(g.palettes || [['#1B3A6B', '#F2C14E']]);
  const em = arch.emblem || {};
  return {
    id, name, short, kind: arch.kind || 'agency', tier,
    country: nat?.name || (arch.kind === 'colony' ? 'Colônia' : 'Internacional'), flag: arch.kind === 'colony' ? '🪐' : '🌐',
    color: pal[1] || pal[0],
    description: `${kindLabel(data, arch.kind)} ${nat?.of || ''}`.trim(), style: '',
    budget, cash: Math.round(budget * 0.25),
    support: Math.round(range(rng, st.support, 60)), reputation: Math.round(range(rng, st.reputation, 50)),
    culture: Math.round(range(rng, st.culture, 0)), prestige: 0, fixedCostShare: 0.5,
    capabilities: { crewed: rng.next() < (st.crewedChance ?? 0.3), launchSites: [] },
    ai: {
      cooperation: r2(range(rng, st.ai?.cooperation, 0.5)), aggression: r2(range(rng, st.ai?.aggression, 0.5)),
      riskTolerance: r2(range(rng, st.ai?.riskTolerance, 0.5)), goals: (st.goals || []).slice(),
    },
    nation: nationId, lineage: null, generated: true, archetype: arch.id,
    born: { year, month: turnToDate(turn, state.startYear).month },
    emblem: {
      shape: rng.pick(em.shapes || ['roundel']), field: pal[0], field2: pal[1], division: rng.pick(em.divisions || ['none']),
      glyph: rng.pick(em.glyphs || ['rocket']), glyphColor: pal[1], stars: rng.int(0, 5), label: String(short).slice(0, 6),
      seed: hash32(id, state.seed),
    },
  };
}

/**
 * Tiers: from rankFromYear the top `caps.core` live actors by prestige + budget are core, the rest minor (the player
 * is always core). Before that, data tiers hold and only the cap is enforced.
 */
function yearTiers(state, data, year, turn, rng) {
  const g = gen(data);
  const cap = caps(data);
  const rankFrom = g.tiers?.rankFromYear ?? g.fromYear ?? 2031;
  const ids = liveIds(state).filter((id) => id !== state.playerId);
  const score = (id) => (state.actors[id].prestige || 0) + Math.sqrt(Math.max(0, state.actors[id].budget || 0));
  const ranked = ids.slice().sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const want = {};
  if (year >= rankFrom) {
    ranked.forEach((id, i) => { want[id] = i < cap.core ? 'core' : 'minor'; });
  } else {
    let core = 0;
    for (const id of ranked) {
      const t = tierOf(state.actors[id]);
      if (t === 'core' && core >= cap.core) want[id] = 'minor';
      else { want[id] = t; if (t === 'core') core++; }
    }
  }
  if (state.playerId && state.actors[state.playerId]) state.actors[state.playerId].tier = 'core';
  for (const id of ranked) {
    const a = state.actors[id];
    const from = tierOf(a);
    const to = want[id];
    if (to === from) continue;
    a.tier = to;
    if (to === 'core') {
      ensureRelations(state, id);
      news(state, { headline: text(data, rng, 'tierUp', { name: a.name }, '{name} entra no primeiro escalão'), actors: [id], tags: ['lifecycle'], importance: 1 }, turn);
    } else dropRelations(state, id);
    emitSignal(state, 'actor/tier', { actorId: id, from, to });
  }
  // background actors beyond the cap leave quietly (the oldest generated ones first never happens: births check caps)
}

// ---------------------------------------------------------------- decisions

export const decisionHandlers = {
  'lifecycle/merge': () => ({}),
  'lifecycle/crisis': (state, data, d, choiceId) => {
    const id = d.payload?.actorId;
    if (!state.actors?.[id]) return {};
    if (choiceId === 'segurar') {
      changeActor(state, id, 'cash', -(d.payload?.cost || 0));
      changeActor(state, id, 'reputation', 3);
    } else {
      changeActor(state, id, 'reputation', -5);
      changeActor(state, id, 'support', -5);
    }
    return {};
  },
};

// ---------------------------------------------------------------- founding an agency (Phase B, B1: EXPANSION.md §5.3)
//
// Action 'agency/found' {name, short, kind: 'agency'|'company', nationId, hq: {id} | {lat, lon, name?}, emblem}.
// Valid only at the start of a game (no step taken). The UI creates the new game with playerId = customIdFor(payload,
// seed), then this action brings the actor to life through the same addActor path as every birth: tier core,
// `custom: true`, lineage = its own id. A game created for another player id is re-keyed (crew and missions follow
// the new id). Numbers: data/core/hq-sites.json `founding`. 'agency/emblem' {emblem} changes the logo later.

const FOUND_DEFAULTS = {
  privateFromYear: 1980,
  stateBudget: { large: 160, medium: 85, small: 60 },
  privateBudget: 65,
  cashYears: { state: 0.35, company: 1.4 },
  scale: [[1950, 1], [2026, 4], [2600, 16]],
  start: {
    state: { support: 55, reputation: 35, culture: 0, fixedCostShare: 0.35 },
    company: { support: 45, reputation: 30, culture: 50, fixedCostShare: 0.3 },
  },
  launchSiteBonus: { reputation: 5 },
};
const EMBLEM_SHAPES = ['roundel', 'shield', 'hex', 'chevron', 'wing', 'star', 'wordmark'];
const EMBLEM_DIVISIONS = ['none', 'half', 'band', 'chevron', 'quarter'];
const EMBLEM_GLYPHS = ['rocket', 'orbit', 'star', 'planet', 'comet', 'capsule', 'atom', 'globe', 'wreath', 'satellite', 'crescent'];
const HEXCOL = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const strip = (s, max) => String(s ?? '').replace(/[<>&"'`\\{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const shortOf = (s) => strip(s, 12).toUpperCase().replace(/[^\p{L}\p{N}-]/gu, '');

const foundCfg = (data) => ({ ...FOUND_DEFAULTS, ...(data?.hqSites?.founding || {}) });
const hqSitesOf = (data) => listOf(data?.hqSites, 'sites');

/**
 * Safe emblem spec (EXPANSION.md §5.4) or null: whitelisted keys, #rgb/#rrggbb colours, known shape/division/glyph
 * (lists from data/core/emblem-parts.json when loaded), texts stripped of markup, JSON ≤ 200 B (the motto shrinks).
 */
export function sanitizeEmblem(spec, data) {
  if (!spec || typeof spec !== 'object') return null;
  const parts = data?.emblemParts || {};
  const ids = (k, dflt) => { const l = listOf(parts[k], k).map((x) => x?.id).filter(Boolean); return l.length ? l : dflt; };
  const glyphs = [...new Set([...ids('glyphs', EMBLEM_GLYPHS), ...Object.keys(parts.paths || {})])];
  const col = (c) => (HEXCOL.test(String(c || '')) ? String(c).toLowerCase() : null);
  const shape = ids('shapes', EMBLEM_SHAPES).includes(spec.shape) ? spec.shape : null;
  const field = col(spec.field);
  if (!shape || !field) return null;
  const out = { shape, field };
  if (col(spec.field2)) out.field2 = col(spec.field2);
  if (ids('divisions', EMBLEM_DIVISIONS).includes(spec.division) && spec.division !== 'none') out.division = spec.division;
  if (spec.ring && typeof spec.ring === 'object' && col(spec.ring.color)) {
    out.ring = { color: col(spec.ring.color) };
    const t = strip(spec.ring.text, 22).toUpperCase();
    if (t) out.ring.text = t;
  }
  out.glyph = glyphs.includes(spec.glyph) ? spec.glyph : 'star';
  if (col(spec.glyphColor)) out.glyphColor = col(spec.glyphColor);
  if (col(spec.accent)) out.accent = col(spec.accent);
  const orbit = Math.round(Number(spec.orbit));
  if (orbit > 0) out.orbit = Math.min(2, orbit);
  const stars = Math.round(Number(spec.stars));
  if (stars > 0) out.stars = Math.min(12, stars);
  const label = strip(spec.label, 12).toUpperCase().replace(/[^\p{L}\p{N}ª.-]/gu, '').slice(0, 6);
  if (label) out.label = label;
  while (out.ring?.text && JSON.stringify(out).length > 200) out.ring.text = out.ring.text.slice(0, -1).trim();
  if (out.ring && !out.ring.text) delete out.ring.text;
  if (JSON.stringify(out).length > 200) return null;
  return out;
}

/** Start year/month of the scenario and whether founding is offered there. */
function foundingStart(data, scenario = data?.scenario) {
  const { year, month } = scenarioStart(scenario || {});
  const offered = !!(scenario?.playable?.found ?? scenario?.lifecycle === 'on');
  return { year, month, offered };
}

/**
 * What the founding wizard may offer at the scenario start (works before a state exists):
 * {offered, year, privateOk, privateFrom, privateNote, nations: [{id, name, of, economy, isos, sites}]}.
 */
export function foundingOptions(data, scenario = data?.scenario) {
  const { year, offered } = foundingStart(data, scenario);
  const cfg = foundCfg(data);
  const sites = hqSitesOf(data);
  const nations = nationsOf(data).filter((n) => nationAlive(n, year)).map((n) => ({
    id: n.id, name: n.name, of: n.of || `de ${n.name}`, economy: n.economy || 'medium',
    isos: (n.isos || []).filter((x) => (x.from ?? -Infinity) <= year && (x.to == null || year <= x.to)).map((x) => x.iso),
    sites: sites.filter((s) => s.nation === n.id),
  })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const privateOk = year >= cfg.privateFromYear;
  return {
    offered, year, privateFrom: cfg.privateFromYear, privateOk,
    privateNote: privateOk ? null : 'Empresas privadas de lançamento só surgem nos anos 80.',
    nations,
  };
}

/** Deterministic id of a founded agency: `custom_<base36 hash>` of its name, short, nation and the world seed. */
export function customIdFor(payload, seed = 0) {
  const p = payload || {};
  return `custom_${hash32(strip(p.name, 40).toLowerCase(), shortOf(p.short), p.nationId || '', seed >>> 0).toString(36)}`;
}

/** {ok, error?, value} — the cleaned payload of 'agency/found' (pt-BR messages for the wizard). */
export function validateFound(data, payload, scenario = data?.scenario) {
  const p = payload || {};
  const opts = foundingOptions(data, scenario);
  if (!opts.offered) return { ok: false, error: 'Este cenário não permite fundar uma agência.' };
  const kind = p.kind === 'company' ? 'company' : p.kind === 'agency' || p.kind == null ? 'agency' : null;
  if (!kind) return { ok: false, error: 'Escolha entre agência estatal e empresa privada.' };
  if (kind === 'company' && !opts.privateOk) return { ok: false, error: opts.privateNote };
  const nation = opts.nations.find((n) => n.id === p.nationId);
  if (!nation) return { ok: false, error: 'Escolha um país que exista na data de início.' };
  const name = strip(p.name, 40);
  if (name.length < 3) return { ok: false, error: 'O nome precisa de pelo menos 3 letras.' };
  const short = shortOf(p.short);
  if (short.length < 2 || short.length > 6) return { ok: false, error: 'A sigla precisa ter de 2 a 6 letras.' };
  let hq = null;
  if (p.hq?.id) {
    const s = nation.sites.find((x) => x.id === p.hq.id);
    if (!s) return { ok: false, error: 'Esta sede não fica no país escolhido.' };
    hq = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, ...(s.launch ? { launch: true } : {}) };
  } else if (p.hq && Number.isFinite(Number(p.hq.lat)) && Number.isFinite(Number(p.hq.lon))) {
    const lat = Math.round(clamp(Number(p.hq.lat), -85, 85) * 100) / 100;
    const lon = Math.round(clamp(Number(p.hq.lon), -180, 180) * 100) / 100;
    hq = { name: strip(p.hq.name, 40) || `Sede própria (${nation.name})`, lat, lon };
  } else if (nation.sites.length) {
    const s = nation.sites[0];
    hq = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, ...(s.launch ? { launch: true } : {}) };
  }
  const emblem = sanitizeEmblem(p.emblem, data);
  if (p.emblem && !emblem) return { ok: false, error: 'O logo não é válido. Sorteie outro ou ajuste as cores.' };
  return { ok: true, value: { name, short, kind, nationId: nation.id, nation, hq, emblem } };
}

function scaleAt(cfg, year) {
  const s = Array.isArray(cfg.scale) && cfg.scale.length ? cfg.scale : FOUND_DEFAULTS.scale;
  if (year <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (year <= s[i][0]) { const [y0, v0] = s[i - 1]; const [y1, v1] = s[i]; return v0 + (v1 - v0) * ((year - y0) / Math.max(1, y1 - y0)); }
  }
  return s[s.length - 1][1];
}

/**
 * Starting numbers of a founded agency and a derived difficulty (pure; the wizard's summary uses it):
 * {budget, cash, support, reputation, culture, fixedCostShare, launchSites, difficulty: {id, label, score, notes[]}}.
 */
export function foundPreview(data, value, scenario = data?.scenario) {
  const cfg = foundCfg(data);
  const { year } = foundingStart(data, scenario);
  const v = value || {};
  const eco = v.nation?.economy || nationsOf(data).find((n) => n.id === v.nationId)?.economy || 'medium';
  const company = v.kind === 'company';
  const scale = scaleAt(cfg, year);
  const budget = Math.max(5, Math.round((company ? cfg.privateBudget : (cfg.stateBudget?.[eco] ?? 40)) * scale));
  const cash = Math.round(budget * (company ? cfg.cashYears?.company ?? 1.4 : cfg.cashYears?.state ?? 0.35));
  const st = { ...(company ? cfg.start?.company : cfg.start?.state) };
  const launchSites = v.hq?.launch ? [v.hq.name] : [];
  if (launchSites.length) st.reputation = (st.reputation ?? 35) + (cfg.launchSiteBonus?.reputation ?? 0);
  // difficulty: this budget against the biggest live rival at the date, plus the handicaps
  const t0 = dateToTurn(year, 0, year);
  const ref = lineagesOf(data).filter((l) => aliveAt(data, l.id, t0, year)).map((l) => budgetAt(l, year) || 0);
  const top = Math.max(budget, ...ref);
  let score = Math.log10(top / budget) * 2; // 10× smaller than the leader = +2
  const notes = [];
  if (company) { score += 0.8; notes.push('Empresa: a receita vem de contratos e investidores, não do governo.'); }
  else notes.push(`Verba do governo ${v.nation?.of || ''}, economia ${eco === 'large' ? 'grande' : eco === 'small' ? 'pequena' : 'média'}.`.replace('  ', ' '));
  if (!launchSites.length) { score += 0.6; notes.push('Sem base de lançamento própria: vai depender de bases de outros.'); }
  else notes.push(`Base de lançamento própria em ${v.hq.name}.`);
  notes.push('Agência nova: sem tecnologias iniciais e sem histórico de voos.');
  const id = score < 1.2 ? 'media' : score < 2.4 ? 'dificil' : 'muito_dificil';
  const label = { media: 'Média', dificil: 'Difícil', muito_dificil: 'Muito difícil' }[id];
  return {
    budget, cash, support: st.support ?? 55, reputation: st.reputation ?? 35, culture: st.culture ?? 0,
    fixedCostShare: st.fixedCostShare ?? 0.5, launchSites, difficulty: { id, label, score: Math.round(score * 100) / 100, notes },
  };
}

const hexLum = (c) => {
  const x = c.length === 4 ? c.slice(1).split('').map((d) => d + d).join('') : c.slice(1);
  return [0, 2, 4].reduce((s, i, k) => s + parseInt(x.slice(i, i + 2), 16) * [0.2126, 0.7152, 0.0722][k], 0) / 255;
};

/** Actor definition of a founded agency (the shape addActor takes). */
function foundDef(state, data, id, value) {
  const pv = foundPreview(data, value);
  const n = value.nation;
  const emblem = value.emblem || { shape: value.kind === 'company' ? 'wordmark' : 'roundel', field: '#13294b', glyph: 'rocket' };
  if (!emblem.label) emblem.label = value.short.slice(0, 6);
  // map/line colour: the field, or its accent when the field is too dark to read on the dark map
  const color = hexLum(emblem.field) < 0.12 ? (emblem.accent || emblem.glyphColor || emblem.field) : emblem.field;
  return {
    id, name: value.name, short: value.short, kind: value.kind, tier: 'core', custom: true,
    country: n.name, flag: '', color,
    description: value.kind === 'company' ? `Empresa espacial privada ${n.of}` : `Agência espacial ${n.of}`,
    style: value.kind === 'company' ? 'Empresa recém-fundada' : 'Agência recém-fundada',
    budget: pv.budget, cash: pv.cash, support: pv.support, reputation: pv.reputation, culture: pv.culture, prestige: 0,
    fixedCostShare: pv.fixedCostShare,
    capabilities: { crewed: false, launchSites: pv.launchSites },
    ai: { cooperation: 0.5, aggression: 0.4, riskTolerance: 0.45, goals: [] },
    nation: n.id, lineage: id, born: { year: yearAt(state, state.turn), month: turnToDate(state.turn, state.startYear).month },
    identityIdx: 0, emblem, hq: value.hq || null,
  };
}

function foundAgency(state, data, action, ctx) {
  if ((state.clock?.steps ?? 0) > 0 || (state.missions || []).length) {
    return { ok: false, error: 'Só é possível fundar uma agência no início de um jogo novo.' };
  }
  const chk = validateFound(data, action);
  if (!chk.ok) return chk;
  const value = chk.value;
  const old = state.playerId;
  // one founding per game: a second call would leave the first custom agency in the world as an AI actor
  if (old && state.actors?.[old]?.custom) return { ok: false, error: 'Esta partida já tem uma agência fundada.' };
  const id = old && String(old).startsWith('custom_') && !state.actors?.[old] ? old : customIdFor(value, state.seed);
  if (state.actors?.[id]) return { ok: false, error: 'Esta agência já foi fundada.' };
  // re-key the player-owned records when the game was created for another actor (it stays in the world as AI)
  if (old && old !== id) {
    for (const p of Object.values(state.crew || {})) if (p?.actorId === old) p.actorId = id;
    if (state.research) state.research.unlocked = [];
    // the old actor's real programs go back to the AI calendar: the new agency starts with no story missions
    for (const inst of Array.isArray(state.calendar) ? state.calendar : []) {
      if (inst?.status !== 'player') continue;
      inst.status = inst.launchTurn != null || inst.inTransit ? 'launched' : 'planned';
    }
  }
  state.playerId = id;
  const def = foundDef(state, data, id, value);
  addActor(state, data, ctx, def, { reason: 'found' });
  const a = state.actors[id];
  a.custom = true;
  a.tier = 'core';
  a.lineage = id;
  a.hq = def.hq ? clone(def.hq) : null;
  news(state, {
    importance: 3, actorId: id,
    headline: `Começa a operar ${value.name} (${value.short}), ${value.kind === 'company' ? 'nova empresa espacial' : 'nova agência espacial'} ${value.nation.of}`,
    text: value.hq?.name ? `Sede em ${value.hq.name}.` : '',
  }, state.turn);
  emitSignal(state, 'agency/founded', { actorId: id, kind: value.kind, nation: value.nationId });
  return { ok: true, actorId: id };
}

/** Change the player's emblem (Identidade e logo): any time, free; map colour stays as it was. */
function setEmblem(state, data, action) {
  const a = state.actors?.[state.playerId];
  if (!a) return { ok: false, error: 'Nenhuma agência para editar.' };
  const spec = sanitizeEmblem(action?.emblem, data);
  if (!spec) return { ok: false, error: 'O logo não é válido. Sorteie outro ou ajuste as cores.' };
  if (!spec.label) spec.label = shortOf(a.short).slice(0, 6);
  a.emblem = spec;
  return { ok: true, emblem: spec };
}

// ---------------------------------------------------------------- actions

export const actions = {
  'agency/found': foundAgency,
  'agency/emblem': setEmblem,
};

// ---------------------------------------------------------------- queries (UI)

/** State-aware identity: live actor's current identity, data identity at a turn, or the tombstone. */
export function identityNow(state, data, id, turn = state?.turn ?? 0) {
  const L = state?.lifecycle || {};
  const spec = L.idents?.[id];
  const base = identityAt(data, id, turn, state.startYear);
  if (base) {
    if (spec && spec.fromTurn <= turn) return { ...base, name: spec.name, short: spec.short, idx: 100 + (spec.n || 1) };
    return base;
  }
  const a = state.actors?.[id];
  if (a) return { idx: a.identityIdx ?? 0, lineage: a.lineage ?? null, name: a.name, short: a.short, flag: a.flag, country: a.country, emblem: a.emblem ?? null };
  const tb = L.tombstones?.[id];
  return tb ? { idx: -1, lineage: null, name: tb.name, short: tb.short, flag: tb.flag, emblem: tb.emblem, gone: true } : null;
}

/** Live actors (and optionally the gone) for lists, respecting the date: [{id, name, …, alive}]. */
export function actorList(state, data, { tier, includeGone = false } = {}) {
  const out = [];
  for (const id of liveIds(state)) {
    const a = state.actors[id];
    if (tier && tierOf(a) !== tier) continue;
    out.push({
      id, name: a.name, short: a.short, flag: a.flag, country: a.country, kind: a.kind, tier: tierOf(a), color: a.color,
      emblem: a.emblem ?? null, born: a.born ?? null, generated: !!a.generated, player: id === state.playerId,
      prestige: Math.round(a.prestige || 0), alive: true,
    });
  }
  out.sort((x, y) => (x.player ? -1 : y.player ? 1 : 0) || (x.tier === y.tier ? 0 : x.tier === 'core' ? -1 : 1) || y.prestige - x.prestige || x.id.localeCompare(y.id));
  if (includeGone) {
    const gone = Object.values(state.lifecycle?.tombstones || {}).slice().sort((a, b) => (b.died ?? 0) - (a.died ?? 0));
    for (const tb of gone) out.push({ ...tb, alive: false });
  }
  return out;
}

/** Timeline of births/renames/merges/ends between two years (data history + what happened in this campaign). */
export function timeline(state, data, fromYear = -Infinity, toYear = Infinity) {
  const out = [];
  const t = tables(data);
  const sy = state?.startYear ?? 1950;
  const nowYear = state ? yearAt(state, state.turn) : Infinity;
  for (const e of t.events) {
    const d = asDate(e.date);
    if (d.year < fromYear || d.year > toYear) continue;
    if (state && d.year > nowYear) continue; // the future is not history yet
    const at = turnOf(e.date, sy);
    const who = e.actor || e.into || e.nation;
    const ident = identityAt(data, e.actor || e.into, at, sy);
    let label = e.headline || '';
    if (!label) {
      if (e.op === 'birth') label = `Nasce ${ident?.name ?? who}`;
      else if (e.op === 'rename') label = `${identityAt(data, e.actor, at - 1, sy)?.name ?? who} vira ${ident?.name ?? who}`;
      else if (e.op === 'merge') label = `${(e.from || []).map((f) => identityAt(data, f, at - 1, sy)?.name ?? f).join(' e ')} → ${ident?.name ?? e.into}`;
      else if (e.op === 'nationSplit') label = `${t.nations[e.nation]?.name ?? e.nation} se divide`;
      else label = `${ident?.name ?? who}: ${e.op}`;
    }
    out.push({ year: d.year, month: d.month, op: e.op, id: who, text: label, truthLayer: e.truthLayer || 'fato', source: e.source || null });
  }
  if (state) {
    for (const a of Object.values(state.actors || {})) {
      if (!a.generated || !a.born) continue;
      if (a.born.year < fromYear || a.born.year > toYear) continue;
      out.push({ year: a.born.year, month: a.born.month ?? 0, op: 'birth', id: a.id, text: `Nasce ${a.name}`, truthLayer: 'especulacao', source: null });
    }
    for (const tb of Object.values(state.lifecycle?.tombstones || {})) {
      if (tb.generated && tb.born != null && tb.born >= fromYear && tb.born <= toYear) {
        out.push({ year: tb.born, month: 0, op: 'birth', id: tb.id, text: `Nasce ${tb.name}`, truthLayer: 'especulacao', source: null });
      }
      if (!tb.generated || tb.died == null || tb.died < fromYear || tb.died > toYear) continue;
      out.push({ year: tb.died, month: 11, op: tb.cause === 'merge' ? 'merge' : 'dissolve', id: tb.id,
        text: tb.into ? `${tb.name} → ${state.actors?.[tb.into]?.name ?? tb.into}` : `Fim de ${tb.name}`, truthLayer: 'especulacao', source: null });
    }
  }
  out.sort((a, b) => a.year - b.year || a.month - b.month);
  return out;
}

export const queries = {
  'lifecycle/timeline': (state, data, fromYear, toYear) => timeline(state, data, fromYear, toYear),
  'lifecycle/identity': (state, data, id, turn) => identityNow(state, data, id, turn ?? state.turn),
  'lifecycle/playable': (state, data, scenario) => playableAt(data, scenario || data?.scenario),
  'lifecycle/actors': (state, data, opts) => actorList(state, data, opts || {}),
  'agency/foundingOptions': (state, data, scenario) => foundingOptions(data, scenario || data?.scenario),
  'agency/foundPreview': (state, data, payload) => { const v = validateFound(data, payload); return v.ok ? foundPreview(data, v.value) : null; },
  'agency/validateFound': (state, data, payload, scenario) => validateFound(data, payload, scenario || data?.scenario),
  'agency/previewValue': (state, data, value, scenario) => foundPreview(data, value, scenario || data?.scenario),
  'agency/customId': (state, data, payload, seed) => customIdFor(payload, seed),
  'lifecycle/info': (state, data, id) => {
    const live = state.actors?.[id] || state.actors?.[state.lifecycle?.aliases?.[id]];
    return live || state.lifecycle?.tombstones?.[id] || null;
  },
};

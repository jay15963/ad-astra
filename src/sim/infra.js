// Infraestrutura: estações, bases de superfície, frotas de satélites e rovers (docs/MISSIONS-V2.md §3).
// Owner: infrastructure-sim. Registered in engine.MODULES right after 'missions'.
//
// Slice (JSON only, deterministic; no rng is needed: everything here follows from data and dates):
//   state.assets = {
//     seq, list: [Asset], past: [{name, kind, ownerId, year, cause}] (cap 30), notified: {key: turn},
//     hist: {stationsJsonId: 'live'|'gone'}   historical stations already handled (never rebuilt),
//     seen: {missionId: assetId|''}           deliveries already applied (deliver() is idempotent), pruned,
//     accM: {actorId: US$ mi}                 satellite revenue accrued, paid each quarter,
//     legacyDone: true                        v0.8 missions converted (once) }
//   Asset (§3.1) = {id, kind, sub, name, ownerId, partners: [{actorId, massT, crewWeeks}], site, bodyId, histId,
//     foundedTurn, status, modules: [{id, n, addedTurn, by}], vehicles: [{id, n, by}], units: [{endTurn, n, k, from}],
//     lifeEndTurn, health, supplyT, crew: {n, untilTurn, missionId}, colonyId, stageN, sizeTier, sciYr, lastNotice,
//     derelictTurn, + optional: untilTurn (historical end), histNext, starvedTurn, boostUntilTurn, propT, visited,
//     km, grownTurn, playerSupplyTurn, revenueMYr}
//   `partners` lists every contributor, the owner included (its row is the owner's delivered mass).
//
// Time: meta.maxDt = 13. Supply, health and science are integrated piecewise inside the tick (the moment supply
// runs out, the moment modules age), so a 13-week step matches 13 weekly steps; quarterly things (AI resupply,
// adoption by colonies.js, reminders, revenue) run at every(ctx, 13); money upkeep and prestige in onYear.
//
// Historical stations (data/core/stations.json) appear on their dates as assets of their (resolved) owner, grow on
// the listed module dates and end at `until` (reentry) unless the player holds ≥ 25% and keeps supplying them.
// Their ground operations are paid by the historical programmes (no money upkeep), and they are resupplied
// abstractly while the owner's budget pressure stays below tuning.ai.pressureMax.

import { addNews, changeActor, clamp, claimFirst, emitSignal, every, pushDecision, removeDecision, expiryIn, resolveActor, log } from '../core/helpers.js';
import { hash32 } from '../core/rng.js';
import { turnToDate, eraAt, WEEKS_PER_YEAR } from '../core/time.js';
import * as research from './research.js';
import * as budget from './budget.js';
import * as colonies from './colonies.js';
import { budgetPressure, tensionOf } from './diplomacy.js';
import { fitDest } from '../core/craftfit.js';

/** Life (years) of a craft designed in the Estaleiro at a site (its own structure, power and nights), else null. */
function designLifeYears(data, sc, site) {
  if (!sc?.craftFit) return null;
  const f = fitDest(data, sc.craftFit, site);
  return Number.isFinite(f.lifeYears) && f.lifeYears > 0 ? f.lifeYears : Number.isFinite(sc.design?.lifeYears) ? sc.design.lifeYears : null;
}

export const meta = { maxDt: 13 };

const W = WEEKS_PER_YEAR;
const KINDS = ['station', 'base', 'satellite', 'rover'];
const LIVE = new Set(['active', 'degraded', 'derelict']);
const PARTNER_TREATIES = ['station_partnership', 'mission_partnership', 'cost_sharing', 'crew_exchange'];
const SCIENCE_BODY = { earth: 1, moon: 1.5, mars: 2.2, jupiter: 2.8, saturn: 3 };
const OBSERVATORY_SUBS = new Set(['observatory', 'deep_observatory', 'gravity_lens']);
const KIND_LABEL = { station: 'Estação', base: 'Base', satellite: 'Satélite', rover: 'Rover' };
const STATUS_LABEL = { active: 'Ativa', degraded: 'Degradada', derelict: 'Abandonada', ended: 'Encerrada' };
const AI_BASE_MILESTONES = ['lunar_base', 'mars_outpost', 'mars_base', 'ceres_base'];

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x, d = 0) => (x != null && Number.isFinite(Number(x)) ? Number(x) : d);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const yearAt = (state, turn = state.turn) => turnToDate(turn, state.startYear).year;
const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? String(v[k]) : ''));

// ---------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------

const DEFAULT_TUNING = {
  crewTYr: 2.5, minStorageT: 2, healYr: 8, evaHealYr: 4, ageYr: 6, graceWeeks: 4, starveYr: 30,
  status: { active: 40, degraded: 15 }, degradedScience: 0.5, derelictYears: 3, endedKeepYears: 5,
  reminderWeeks: 13, reminderEveryWeeks: 26, rotationWeeks: 26, crewWeekShare: 0.05,
  experiments: { boost: 0.5, weeks: 26 }, servicing: { years: 5 },
  ai: { supplyFill: 0.8, pressureMax: 0.6, growYears: 4, prestigePerSci: 0.02 },
  hist: { playerShareExtend: 0.25, extendYears: 5 }, relay: { bonus: 0.15 }, partialHealth: 70,
  eraScale: { e1: 1, e2: 1.3, e3: 1.6, e4: 2, e5: 3, e6: 4, e7: 5 },
  prestigeYr: { stationBase: 0.5, stationPerCrew: 0.01, baseBase: 0.8, basePerStage: 1, observatory: 0.3 },
  caps: { player: 60, ai: 40, past: 30, fleetRows: 12, fleetBucketWeeks: 26, seen: 30 },
  infra: { max: 6 }, sizeTiers: [2, 6, 15, 40, 120], colonyStageTier: { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 },
  ports: { dockNeedsFree: 1 },
  rover: {
    light: { lifeYears: 1, scienceYr: 8, kmYr: 40 }, micro: { lifeYears: 0.25, scienceYr: 4, kmYr: 0.4 },
    medium: { lifeYears: 3, scienceYr: 14, kmYr: 4 }, heavy: { lifeYears: 10, scienceYr: 22, kmYr: 3 },
    rotorcraft: { lifeYears: 2, scienceYr: 10, kmYr: 8 }, swarm: { lifeYears: 6, scienceYr: 25, kmYr: 60 },
    cryobot: { lifeYears: 5, scienceYr: 30, kmYr: 0.5 }, submarine: { lifeYears: 4, scienceYr: 35, kmYr: 200 },
  },
};

/** Satellite yields when data/core/missions.json (missions-sim) is not loaded: §3.6 numbers. */
const SAT_FALLBACK = {
  science: { lifeYears: 3, scienceYr: 5, refT: 1 }, weather: { lifeYears: 5, supportYr: 0.3, reputationYr: 0.1, refT: 1 },
  navigation: { lifeYears: 8, supportYr: 0.4, reputationYr: 0.2, refT: 1.5 }, comms: { lifeYears: 10, revenueMYr: 30, refT: 2 },
  earth_obs: { lifeYears: 6, scienceYr: 2, supportYr: 0.3, refT: 1.5 }, observatory: { lifeYears: 20, scienceYr: 18, supportYr: 0.4, refT: 11, serviceable: true },
  deep_observatory: { lifeYears: 20, scienceYr: 40, supportYr: 0.6, refT: 6, serviceable: true }, relay: { lifeYears: 10, refT: 1 },
  constellation: { lifeYears: 5, revenueMYr: 4, refT: 0.3 }, power: { lifeYears: 25, revenueMYr: 80, refT: 15, serviceable: true },
  gravity_lens: { lifeYears: 40, scienceYr: 120, supportYr: 1, refT: 20 }, interstellar_relay: { lifeYears: 60, scienceYr: 6, refT: 20 },
  power_swarm: { lifeYears: 100, revenueMYr: 400, refT: 40 },
};
const SAT_LABEL = {
  science: 'Satélite científico', weather: 'Satélites meteorológicos', navigation: 'Satélites de navegação', comms: 'Satélites de comunicações',
  earth_obs: 'Observação da Terra', observatory: 'Observatório espacial', deep_observatory: 'Observatório profundo', relay: 'Retransmissor',
  constellation: 'Megaconstelação', power: 'Usina solar orbital', gravity_lens: 'Telescópio de lente solar', interstellar_relay: 'Retransmissor interestelar',
  power_swarm: 'Enxame solar',
};

function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const CFG = new WeakMap();
const EMPTY = {};
/** Indexed infra data: {tuning, station[], base[], vehicles[], byId, vehicleById, names, stageRules, aiBases, hist[], histById, active}. */
export function cfg(data) {
  const src = data?.modules || EMPTY;
  const hs = data?.stations || EMPTY;
  let byStations = CFG.get(src);
  if (!byStations) { byStations = new WeakMap(); CFG.set(src, byStations); }
  let c = byStations.get(hs);
  if (c) return c;
  const station = arr(src.station).map((m) => ({ ...m, kind: 'station' }));
  const base = arr(src.base).map((m) => ({ ...m, kind: 'base' }));
  const hist = arr(hs.stations);
  c = {
    tuning: deepMerge(DEFAULT_TUNING, src.tuning || {}),
    station, base, vehicles: arr(src.vehicles),
    byId: Object.fromEntries([...station, ...base].map((m) => [m.id, m])),
    vehicleById: Object.fromEntries(arr(src.vehicles).map((v) => [v.id, v])),
    names: src.names || { station: ['Aurora'], base: ['Base {place}'] },
    stageRules: src.stageRules || {}, aiBases: src.aiBases || {},
    hist, histById: Object.fromEntries(hist.map((h) => [h.id, h])),
    active: station.length + base.length > 0,
  };
  byStations.set(hs, c);
  return c;
}

export const moduleById = (data, id) => cfg(data).byId[id] || null;
export const vehicleTypeById = (data, id) => cfg(data).vehicleById[id] || null;
/** Module catalog of a kind ('station' | 'base'), in data order. */
export const modulesCatalog = (data, kind) => (kind === 'base' ? cfg(data).base : kind === 'vehicles' ? cfg(data).vehicles : cfg(data).station);

const destOf = (data, id) => (id ? data?.index?.destinations?.[id] || null : null);
const scOf = (data, id) => (id ? data?.index?.spacecraft?.[id] || null : null);
const bodyOf = (data, site) => destOf(data, site)?.body || null;
/** pt-BR name of a site: its destination, else the colony site placed there (mars_polar_cap → Cratera Korolev). */
function siteName(data, site) {
  const d = destOf(data, site);
  if (d) return d.short || d.name || site;
  let cs = null;
  try { cs = (colonies.cfg?.(data)?.sites || []).find((x) => x.destination === site || x.id === site) || null; } catch { cs = null; }
  return cs?.short || cs?.name || site || '?';
}
function bodyMult(data, site) {
  const d = destOf(data, site);
  if (Number.isFinite(d?.scienceMult)) return d.scienceMult;
  return SCIENCE_BODY[d?.body] ?? 1;
}
const actorName = (state, id) => state.actors?.[id]?.short || state.actors?.[id]?.name || state.lifecycle?.tombstones?.[id]?.short || 'Uma agência';
const tb = (state, actorId, key) => (actorId ? research.techBonus(state, actorId, key) : 0);
const eraIdAt = (state, data) => eraAt(data, yearAt(state))?.id || state.clock?.eraId || 'e4';

/** Mission subtype row (data/core/missions.json, missions-sim) or null. */
function subRow(data, type, sub) {
  const rows = data?.missions?.subtypes;
  if (!Array.isArray(rows) || !sub) return null;
  return rows.find((r) => r.type === type && r.id === sub) || null;
}
/** {lifeYears, scienceYr, revenueMYr, supportYr, reputationYr, refT, serviceable, kmYr} for a satellite or rover sub. */
export function subYield(data, type, sub) {
  const row = subRow(data, type, sub);
  const fb = type === 'rover' ? (cfg(data).tuning.rover[sub] || cfg(data).tuning.rover.medium) : (SAT_FALLBACK[sub] || SAT_FALLBACK.science);
  if (!row) return { ...fb };
  return { ...fb, ...(row.yield || {}), lifeYears: num(row.asset?.lifeYears, fb.lifeYears), serviceable: row.asset?.serviceable ?? fb.serviceable ?? false };
}
const subLabel = (data, type, sub) => subRow(data, type, sub)?.label || (type === 'satellite' ? SAT_LABEL[sub] : null) || sub || '';

/** Price index of the era (missions.json eraPrice list {fromYear, mult}); 1 when absent. */
function eraPrice(state, data) {
  const list = data?.missions?.eraPrice;
  if (!Array.isArray(list)) return 1;
  const y = yearAt(state);
  let m = 1;
  for (const e of list) if (y >= num(e.fromYear, Infinity)) m = num(e.mult, m);
  return m;
}
const rotationWeeks = (data, kind) => num(data?.missions?.rotationWeeks?.[kind], cfg(data).tuning.rotationWeeks);

/** {year, month 1..12} → turn of this save. */
function turnOfDate(state, d) {
  if (!d || !Number.isFinite(d.year)) return null;
  const m = clamp(Math.round(num(d.month, 1)) - 1, 0, 11);
  return (d.year - state.startYear) * W + Math.ceil(m * (W / 12));
}

// ---------------------------------------------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------------------------------------------

/** The slice, created on demand (tolerant of old or partial saves). */
export function slice(state) {
  let s = state.assets;
  if (!isObj(s)) s = state.assets = {};
  if (!Number.isFinite(s.seq)) s.seq = 0;
  if (!Array.isArray(s.list)) s.list = [];
  if (!Array.isArray(s.past)) s.past = [];
  if (!isObj(s.notified)) s.notified = {};
  if (!isObj(s.hist)) s.hist = {};
  if (!isObj(s.seen)) s.seen = {};
  if (!isObj(s.accM)) s.accM = {};
  return s;
}

export function assetById(state, id) {
  return id ? (state.assets?.list || []).find((a) => a.id === id) || null : null;
}

/** Assets matching a filter (live only unless `status` asks for 'ended'). `other`: not owned by the player. */
export function listAssets(state, { ownerId, kind, site, status, other, actorId } = {}) {
  const statuses = status == null ? null : new Set(Array.isArray(status) ? status : [status]);
  return (state.assets?.list || []).filter((a) => {
    if (statuses ? !statuses.has(a.status) : !LIVE.has(a.status)) return false;
    if (ownerId != null && a.ownerId !== ownerId) return false;
    if (kind != null && (Array.isArray(kind) ? !kind.includes(a.kind) : a.kind !== kind)) return false;
    if (site != null && a.site !== site) return false;
    if (other === true && a.ownerId === (actorId ?? state.playerId)) return false;
    if (other === false && a.ownerId !== (actorId ?? state.playerId)) return false;
    return true;
  });
}

function newAsset(state, data, { kind, sub = null, name, ownerId, site, histId = null }) {
  const s = slice(state);
  s.seq += 1;
  const a = {
    id: `as_${s.seq}`, kind, sub, name: String(name || KIND_LABEL[kind]).slice(0, 32), ownerId,
    partners: [], site, bodyId: bodyOf(data, site), histId,
    foundedTurn: state.turn, status: 'active', modules: [], vehicles: [], units: [], lifeEndTurn: null,
    health: 100, supplyT: 0, crew: { n: 0, untilTurn: null, missionId: null },
    colonyId: null, stageN: 0, sizeTier: 0, sciYr: 0, lastNotice: null, derelictTurn: null,
    // optional state, always present so every asset has the same keys in the same order (savepack writes the list
    // as columns: a 1950–3000 save stays inside its 400 KB budget)
    untilTurn: null, histNext: null, starvedTurn: null, boostUntilTurn: null, propT: 0, visited: false, km: 0,
    grownTurn: null, playerSupplyTurn: null, endedTurn: null,
  };
  s.list.push(a);
  emitSignal(state, 'infra/created', { assetId: a.id, kind, actorId: ownerId, site });
  return a;
}

/** Room for one more live asset of this owner (§3.1 caps; satellites merge into fleets). */
export function canCreate(state, data, actorId, kind) {
  const T = cfg(data).tuning;
  const mine = actorId === state.playerId;
  if (!mine && (kind === 'satellite' || kind === 'rover')) return false;
  const live = (state.assets?.list || []).filter((a) => LIVE.has(a.status) && (mine ? a.ownerId === actorId : a.ownerId !== state.playerId)).length;
  return live < (mine ? T.caps.player : T.caps.ai);
}

function pickName(state, data, kind, site) {
  const C = cfg(data);
  const list = arr(C.names[kind]).length ? C.names[kind] : [kind === 'base' ? 'Base {place}' : 'Aurora'];
  const used = new Set((state.assets?.list || []).map((a) => a.name));
  const place = siteName(data, site);
  const start = hash32('infraname', kind, site || '', slice(state).seq) % list.length;
  for (let i = 0; i < list.length; i++) {
    const n = fill(list[(start + i) % list.length], { place });
    if (!used.has(n)) return n;
  }
  return `${fill(list[start], { place })} ${slice(state).seq + 1}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Derived numbers of an asset (pure)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Sums over the modules and vehicles of a station/base: {power, gen, life, ports, attach, count, crewCap, storageT,
 * upkeepTYr, isruTYr, science, crewNeed, housing, food, score, massT, upkeepM, labs, lifeMods, habs, traits:Set}.
 */
export function stats(data, a) {
  const C = cfg(data);
  const o = { power: 0, gen: 0, life: 0, ports: 0, used: 0, count: 0, crewCap: 0, storageT: 0, upkeepTYr: 0, isruTYr: 0, science: 0, crewNeed: 0, housing: 0, food: 0, score: 0, massT: 0, upkeepM: 0, labs: 0, lifeMods: 0, habs: 0, traits: new Set() };
  const lifeTraits = new Set(arr(C.stageRules?.base?.lifeTraits).length ? C.stageRules.base.lifeTraits : ['isru', 'greenhouse']);
  for (const g of arr(a?.modules)) {
    const m = C.byId[g.id];
    const n = Math.max(0, num(g.n, 1));
    if (!m || !n) continue;
    o.count += n;
    o.power += num(m.power) * n;
    o.gen += Math.max(0, num(m.power)) * n;
    o.life += num(m.life) * n;
    o.ports += num(m.ports) * n;
    if (!m.attach) o.used += n;
    o.crewCap += num(m.crew) * n;
    o.storageT += num(m.storageT) * n;
    o.upkeepTYr += num(m.upkeepTYr) * n;
    o.isruTYr += num(m.isruTYr) * n;
    o.science += num(m.science) * n;
    o.crewNeed += num(m.crewNeed) * n;
    o.housing += num(m.housing) * n;
    o.food += num(m.food) * n;
    o.score += num(m.size, 1) * n;
    o.massT += num(m.massT) * n;
    o.upkeepM += num(m.upkeepM) * n;
    for (const t of arr(m.traits)) o.traits.add(t);
    if (arr(m.traits).includes('lab') || m.id === 'st_lab' || m.id === 'bs_lab') o.labs += n;
    if (num(m.housing) > 0 || arr(m.traits).includes('hab')) o.habs += n;
    if (arr(m.traits).some((t) => lifeTraits.has(t))) o.lifeMods += n;
  }
  for (const g of arr(a?.vehicles)) {
    const v = C.vehicleById[g.id];
    const n = Math.max(0, num(g.n, 1));
    if (!v || !n) continue;
    o.science += num(v.science) * n;
    o.isruTYr += num(v.isruTYr) * n;
    o.score += 0.3 * n;
  }
  // free docking ports: every module beyond the first that is not hung on a truss or arm takes one
  o.freePorts = o.ports - Math.max(0, o.used - 1);
  o.storageT = Math.max(C.tuning.minStorageT, o.storageT);
  return o;
}

export const storageOf = (data, a) => stats(data, a).storageT;
export const portsFree = (data, a) => stats(data, a).freePorts;

/** Upkeep in t/yr (§3.4): modules + crew − ISRU, floor 0, × (1 + owner's maintenance bonus). */
export function upkeepTYr(state, data, a, st = stats(data, a)) {
  if (a.kind !== 'station' && a.kind !== 'base') return 0;
  const T = cfg(data).tuning;
  const isru = st.isruTYr * (1 + tb(state, a.ownerId, 'isru'));
  const raw = Math.max(0, st.upkeepTYr + num(a.crew?.n) * T.crewTYr - isru);
  return raw * Math.max(0.3, 1 + tb(state, a.ownerId, 'maintenance'));
}

/** Supply reserve / storage (0..1) of a station or base. */
export const supplyRatio = (data, a) => (a.kind === 'station' || a.kind === 'base' ? clamp(num(a.supplyT) / storageOf(data, a), 0, 1) : 1);

/**
 * A base linked to an active colony that its route or reserve feeds: the colony supplies it (aiSupply, and kept
 * topped up in evolveStructure), so it never asks the player for cargo.
 */
export function colonyFed(state, a) {
  if (!a?.colonyId || a.kind !== 'base') return false;
  const c = (state.colonies?.list || []).find((x) => x.id === a.colonyId);
  return !!c && c.status === 'active' && (num(c.route) > 0 || num(c.reserve) > 0);
}

/** Weeks of supply left (Infinity when nothing is consumed, or when its colony feeds the base). */
export function supplyWeeks(state, data, a) {
  if (colonyFed(state, a)) return Infinity;
  const u = upkeepTYr(state, data, a);
  return u > 0 ? (num(a.supplyT) / u) * W : Infinity;
}

/** Contribution share of an actor (0..1): (massT + crewWeeks × 0.05) / Σ over all live contributors. */
export function shareOf(state, a, actorId) {
  const k = 0.05;
  let tot = 0;
  let mine = 0;
  for (const p of arr(a?.partners)) {
    if (!state.actors?.[p.actorId]) continue;
    const v = num(p.massT) + num(p.crewWeeks) * k;
    tot += v;
    if (p.actorId === actorId) mine += v;
  }
  if (tot <= 0) return a?.ownerId === actorId ? 1 : 0;
  return mine / tot;
}
/** [{actorId, share}] of live contributors, biggest first. */
export function sharesOf(state, a) {
  const rows = arr(a?.partners).filter((p) => state.actors?.[p.actorId]).map((p) => ({ actorId: p.actorId, share: shareOf(state, a, p.actorId) }));
  if (!rows.length && a?.ownerId) rows.push({ actorId: a.ownerId, share: 1 });
  return rows.sort((x, y) => y.share - x.share || (x.actorId < y.actorId ? -1 : 1));
}

function contribute(a, actorId, massT = 0, crewWeeks = 0) {
  if (!actorId) return;
  let p = a.partners.find((x) => x.actorId === actorId);
  if (!p) { p = { actorId, massT: 0, crewWeeks: 0 }; a.partners.push(p); }
  p.massT = r2(p.massT + Math.max(0, num(massT)));
  p.crewWeeks = Math.round(p.crewWeeks + Math.max(0, num(crewWeeks)));
}

/** Base stage (§3.7): 0 empty, 1 vehicles/probes only, 2 outpost, 3 base. Stations: 0. */
export function stageOf(state, data, a, st = stats(data, a)) {
  if (a?.kind !== 'base') return 0;
  const R = cfg(data).stageRules || {};
  const o = R.outpost || { housing: 1, power: 1, visited: true };
  const b = R.base || { housing: 12, power: 3, life: 2, labs: 1 };
  if (st.count === 0) return arr(a.vehicles).length ? 1 : 0;
  const outpost = st.housing >= num(o.housing, 1) && st.gen >= num(o.power, 1) && (!o.visited || !!a.visited);
  if (!outpost) return 1;
  const isBase = st.housing >= num(b.housing, 12) && st.gen >= num(b.power, 3) && st.life >= num(b.life, 2) && st.lifeMods >= 1 && st.labs >= num(b.labs, 1);
  return isBase ? 3 : 2;
}

/** Renderer size tier 0..5 (§3.7): max(tier by module score, tier by colony stage). */
export function sizeTier(state, data, a, st = stats(data, a)) {
  const T = cfg(data).tuning;
  const lim = arr(T.sizeTiers).length === 5 ? T.sizeTiers : [2, 6, 15, 40, 120];
  let t = 0;
  while (t < 5 && st.score > lim[t]) t++;
  const c = a?.colonyId ? (state.colonies?.list || []).find((x) => x.id === a.colonyId) : null;
  const ct = c ? num(T.colonyStageTier?.[c.stage], 0) : 0;
  return Math.max(t, ct);
}

/** Science per year of an asset for its owner's whole share (§3.5–3.6), at health h (default: current). */
export function scienceYr(state, data, a, h = a?.health, st = null, o = {}) {
  const T = cfg(data).tuning;
  const status = o.status || a?.status;
  if (!a || status === 'ended' || status === 'derelict') return 0;
  const statusMult = status === 'degraded' ? T.degradedScience : 1;
  if (a.kind === 'station' || a.kind === 'base') {
    st = st || stats(data, a);
    if (a.kind === 'base' && destOf(data, a.site)?.needsRelay && !relayHas(state, a.ownerId, a.bodyId)) return 0;
    const crewN = o.crewN ?? num(a.crew?.n);
    const crewFactor = st.crewNeed > 0 ? 0.4 + 0.6 * Math.min(1, crewN / st.crewNeed) : 1;
    const power = st.power >= 0 ? 1 : 0.6;
    const key = a.kind === 'station' ? 'stationScience' : 'baseScience';
    const boost = num(a.boostUntilTurn, -1) > state.turn ? 1 + T.experiments.boost : 1;
    const relay = a.kind === 'base' && relayHas(state, a.ownerId, a.bodyId) ? 1 + T.relay.bonus : 1;
    return st.science * crewFactor * power * (clamp(h, 0, 100) / 100) * statusMult * bodyMult(data, a.site) * (1 + tb(state, a.ownerId, key)) * boost * relay;
  }
  if (a.kind === 'rover') {
    const y = subYield(data, 'rover', a.sub);
    const relay = relayHas(state, a.ownerId, a.bodyId) ? 1 + T.relay.bonus : 1;
    return num(y.scienceYr) * bodyMult(data, a.site) * (clamp(h, 0, 100) / 100) * (1 + tb(state, a.ownerId, 'roverScience')) * relay;
  }
  if (a.kind === 'satellite') return fleetYield(state, data, a, state.turn).sci;
  return 0;
}

/** Health of a satellite unit / rover near its end of life: 100, falling to 50 over the last 2 years (or half the life). */
function ageHealth(endTurn, from, t) {
  const life = Math.max(1, endTurn - num(from, endTurn - 2 * W));
  const win = Math.min(2 * W, life / 2);
  const left = endTurn - t;
  return left >= win ? 100 : clamp(50 + 50 * (left / win), 0, 100);
}

/** Yields of a satellite fleet at turn t: {sci, revM, support, rep, n}. */
function fleetYield(state, data, a, t) {
  const y = subYield(data, 'satellite', a.sub);
  const sciB = OBSERVATORY_SUBS.has(a.sub) ? 1 + tb(state, a.ownerId, 'observatoryScience') : 1;
  const revB = 1 + tb(state, a.ownerId, 'satRevenue');
  const o = { sci: 0, revM: 0, support: 0, rep: 0, n: 0 };
  for (const u of arr(a.units)) {
    if (u.endTurn <= t) continue;
    const n = num(u.n, 1);
    const k = num(u.k, 1);
    const h = ageHealth(u.endTurn, u.from, t) / 100;
    o.n += n;
    o.sci += num(y.scienceYr) * n * k * h * sciB;
    o.revM += num(y.revenueMYr) * n * k * revB;
    o.support += num(y.supportYr) * n;
    o.rep += num(y.reputationYr) * n;
  }
  return o;
}

/** The actor has a live relay satellite in orbit of that body (sat site → destination body). */
export function relayHas(state, actorId, bodyId) {
  if (!actorId || !bodyId) return false;
  return (state.assets?.list || []).some((x) => x.kind === 'satellite' && x.sub === 'relay' && x.ownerId === actorId && LIVE.has(x.status) && x.bodyId === bodyId && arr(x.units).some((u) => u.endTurn > state.turn));
}
/** +15% science for the actor's probes in operations on that body when a relay is there (missions-sim may use it). */
export const relayBonus = (state, data, actorId, bodyId) => (relayHas(state, actorId, bodyId) ? cfg(data).tuning.relay.bonus : 0);

/**
 * Bonuses an asset gives missions at a site (missions-sim may read them): {payload: +0.05 with a supplied depot in
 * that orbit, costMult: 0.9 with a shipyard, landingRisk: −0.1 with a landing pad}. Own or partner-share assets only.
 */
export function bonusAt(state, data, { site, actorId = state.playerId } = {}) {
  const out = { payload: 0, costMult: 1, landingRisk: 0 };
  for (const a of state.assets?.list || []) {
    if (a.site !== site || a.status !== 'active') continue;
    if (a.ownerId !== actorId && !(shareOf(state, a, actorId) > 0)) continue;
    const st = stats(data, a);
    if (st.traits.has('depot') && num(a.propT) > 0) out.payload = Math.max(out.payload, 0.05);
    if (st.traits.has('shipyard')) out.costMult = Math.min(out.costMult, 0.9);
    if (st.traits.has('pad')) out.landingRisk = Math.min(out.landingRisk, -0.1);
  }
  return out;
}

function refresh(state, data, a) {
  if (a.kind === 'station' || a.kind === 'base') {
    const st = stats(data, a);
    a.stageN = stageOf(state, data, a, st);
    a.sizeTier = sizeTier(state, data, a, st);
    a.supplyT = r3(Math.min(num(a.supplyT), st.storageT));
    a.sciYr = r2(scienceYr(state, data, a, a.health, st));
  } else a.sciYr = r2(scienceYr(state, data, a));
}

// ---------------------------------------------------------------------------------------------------------------
// News, milestones
// ---------------------------------------------------------------------------------------------------------------

const involves = (state, a) => a.ownerId === state.playerId || arr(a.partners).some((p) => p.actorId === state.playerId);
function news(state, a, headline, importance = 1, icon = '🛰️') {
  addNews(state, { headline, tags: ['infra'], actors: [a.ownerId].filter(Boolean), importance, icon });
}
function claim(state, data, mid, actorId, label) {
  if (!mid || !actorId || !state.actors?.[actorId] || !state.firsts || state.firsts[mid]) return false;
  if (!claimFirst(state, mid, actorId, 30, 0)) return false;
  emitSignal(state, 'first', { milestoneId: mid, actorId, source: 'infra' });
  addNews(state, { headline: `${actorName(state, actorId)}: ${label || mid}`, tags: ['first', 'infra'], actors: [actorId], importance: 3, icon: '🏁' });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Building: modules, vehicles, satellites, rovers
// ---------------------------------------------------------------------------------------------------------------

/** Add `n` modules of type `id` built by `by` (contribution by mass). Adopted bases feed colonies.js infra levels. */
export function addModule(state, data, a, id, { by = a.ownerId, n = 1, quiet = false, massT = null } = {}) {
  const m = moduleById(data, id);
  if (!m || n <= 0) return false;
  const g = a.modules.find((x) => x.id === id && x.by === by);
  if (g) {
    g.addedTurn = Math.round((num(g.addedTurn) * g.n + state.turn * n) / (g.n + n));
    g.n += n;
  } else a.modules.push({ id, n, addedTurn: state.turn, by });
  contribute(a, by, massT ?? num(m.massT) * n);
  if (m.milestone) claim(state, data, m.milestone, by, m.label);
  if (a.colonyId && m.infraNeed) colonies.addInfra?.(state, data, a.colonyId, m.infraNeed, n);
  refresh(state, data, a);
  emitSignal(state, 'infra/module', { assetId: a.id, moduleId: id, actorId: by });
  if (!quiet && involves(state, a)) news(state, a, `${a.name} ganha ${n > 1 ? `${n}× ` : ''}${m.label.toLowerCase()}`, by === state.playerId ? 2 : 1, a.kind === 'base' ? '🏗️' : '🛰️');
  return true;
}

function addVehicles(state, data, a, id, n = 1, by = a.ownerId) {
  const v = vehicleTypeById(data, id);
  if (!v || n <= 0) return false;
  const g = a.vehicles.find((x) => x.id === id && x.by === by);
  if (g) g.n += n; else a.vehicles.push({ id, n, by });
  contribute(a, by, num(v.massT) * n);
  refresh(state, data, a);
  emitSignal(state, 'infra/module', { assetId: a.id, vehicleTypeId: id, actorId: by });
  return true;
}

/** Generic module set of a stage name (modules.json stageRules.sets), filtered by what exists by `year`. */
function stageSet(data, setName, year) {
  const C = cfg(data);
  const set = arr(C.stageRules?.sets?.[setName]);
  return set.map(([id, n]) => [id, n]).filter(([id]) => {
    const m = C.byId[id] || C.vehicleById[id];
    return m && num(m.histYear, 0) <= year;
  });
}

function buildFromSet(state, data, a, setName, by) {
  const year = yearAt(state);
  for (const [id, n] of stageSet(data, setName, year)) {
    if (cfg(data).byId[id]) addModule(state, data, a, id, { by, n, quiet: true });
  }
}

/** Satellite fleet for (owner, sub, site): one unit per delivery, merged by end-of-life bucket. */
function deliverSatellite(state, data, actorId, mission, level) {
  const T = cfg(data).tuning;
  const sc = scOf(data, mission.spacecraftId);
  const sub = mission.sub || sc?.sub || 'science';
  const site = mission.destination;
  const y = subYield(data, 'satellite', sub);
  let a = (state.assets?.list || []).find((x) => x.kind === 'satellite' && x.ownerId === actorId && x.sub === sub && x.site === site && LIVE.has(x.status));
  let created = false;
  if (!a) {
    if (!canCreate(state, data, actorId, 'satellite')) return null;
    a = newAsset(state, data, { kind: 'satellite', sub, name: sc?.name || subLabel(data, 'satellite', sub), ownerId: actorId, site });
    created = true;
  }
  const life = Math.max(0.25, num(designLifeYears(data, sc, site) ?? y.lifeYears, 5) * (1 + tb(state, actorId, 'lifetime')) * (level === 'partial' ? 0.6 : 1));
  const endTurn = state.turn + Math.round(life * W);
  // a designed satellite yields by its instruments (Estaleiro), a catalog one by its size
  const k = Number.isFinite(sc?.design?.yieldK) ? sc.design.yieldK : r2(clamp(num(sc?.massT, y.refT || 1) / Math.max(0.01, num(y.refT, 1)), 0.5, 3) ** 0.6);
  const bucket = Math.max(1, T.caps.fleetBucketWeeks);
  let u = a.units.find((x) => Math.floor(x.endTurn / bucket) === Math.floor(endTurn / bucket));
  if (!u && a.units.length >= T.caps.fleetRows) u = a.units.slice().sort((p, q) => Math.abs(p.endTurn - endTurn) - Math.abs(q.endTurn - endTurn))[0];
  if (u) { u.k = r2((u.k * u.n + k) / (u.n + 1)); u.n += 1; } else a.units.push({ endTurn, n: 1, k, from: state.turn });
  a.units.sort((p, q) => p.endTurn - q.endTurn);
  a.lifeEndTurn = a.units.length ? a.units[a.units.length - 1].endTurn : endTurn;
  contribute(a, actorId, num(sc?.massT, 1));
  refresh(state, data, a);
  return { a, created };
}

function roverSubFor(data, sc, site) {
  if (sc?.sub && cfg(data).tuning.rover[sc.sub]) return sc.sub;
  const id = `${sc?.id || ''} ${sc?.name || ''}`.toLowerCase();
  if (/lunokhod|yutu|pragyan|light/.test(id)) return 'light';
  if (/sojourner|micro|csa_rover/.test(id)) return 'micro';
  if (/ingenuity|dragonfly|helic|drone/.test(id)) return 'rotorcraft';
  if (/submarin|barco|kraken|tetis/.test(id)) return 'submarine';
  if (/cryo|crio/.test(id)) return 'cryobot';
  if (/curiosity|perseverance|lupex|cruiser|heavy/.test(id)) return 'heavy';
  if (destOf(data, site)?.kind === 'atmosphere') return 'rotorcraft';
  return 'medium';
}

function deliverRover(state, data, actorId, mission, level) {
  const sc = scOf(data, mission.spacecraftId);
  const site = mission.destination;
  const sub = mission.sub && mission.sub !== 'lander' ? mission.sub : roverSubFor(data, sc, site);
  if (!canCreate(state, data, actorId, 'rover')) return null;
  const y = subYield(data, 'rover', sub);
  const life = Math.max(0.04, num(designLifeYears(data, sc, site) ?? y.lifeYears, 1) * (1 + tb(state, actorId, 'lifetime')) * (level === 'partial' ? 0.6 : 1));
  const a = newAsset(state, data, { kind: 'rover', sub, name: sc?.name || mission.name || 'Rover', ownerId: actorId, site });
  a.lifeEndTurn = state.turn + Math.max(1, Math.round(life * W));
  a.units = [];
  a.km = 0;
  contribute(a, actorId, num(sc?.massT, 1));
  refresh(state, data, a);
  return { a, created: true };
}

/** Station module type a spacecraft stands for (sc.moduleId first, then its name), for missions without payload. */
function moduleForSpacecraft(data, sc, isNew, kind = 'station') {
  const C = cfg(data);
  if (sc?.moduleId && C.byId[sc.moduleId]) return sc.moduleId;
  const id = `${sc?.id || ''} ${sc?.name || ''}`.toLowerCase();
  if (kind === 'base') return /lab/.test(id) ? 'bs_lab' : 'bs_hab_small';
  if (isNew) return 'st_core';
  if (/node|nó|harmony|unity|tranquility|uzlovoy|prichal/.test(id)) return 'st_node';
  if (/hab|zvezda|living|moradia/.test(id)) return 'st_hab';
  if (/solar|truss|treliça/.test(id)) return 'st_solar';
  if (/airlock|quest|câmara/.test(id)) return 'st_airlock';
  if (/arm|braço|canadarm/.test(id)) return 'st_arm';
  if (/logist|leonardo|mplm|pmm/.test(id)) return 'st_logistics';
  if (/beam|inflat/.test(id)) return 'st_inflatable';
  if (/core|núcleo|tianhe|zarya|salyut|skylab|mir_core/.test(id)) return 'st_core';
  return 'st_lab';
}

const missionType = (m) => (m?.type === 'lander' ? 'probe' : m?.type);
const missionSub = (m) => (m?.type === 'lander' ? 'lander' : m?.sub || null);
const crewCount = (m) => [m?.crew?.commander, ...arr(m?.crew?.astronauts)].filter(Boolean).length || num(m?.crewSize, 0);

/** Existing target: payload.targetAssetId, else (no newAsset) the best deliverable asset of that kind at the site. */
function resolveTarget(state, data, mission, kinds, actorId) {
  const p = mission.payload || {};
  if (p.targetAssetId) {
    const a = assetById(state, p.targetAssetId);
    return a && a.status !== 'ended' && kinds.includes(a.kind) ? a : null;
  }
  if (p.newAsset) return null;
  const here = (state.assets?.list || []).filter((a) => kinds.includes(a.kind) && a.site === mission.destination && LIVE.has(a.status));
  if (!here.length) return null;
  const own = here.filter((a) => a.ownerId === actorId);
  if (own.length) return own[0];
  const ok = here.filter((a) => canDeliver(state, data, actorId, a.id).ok);
  return ok[0] || here.find((a) => a.histId) || null;
}

/** Fleet of a serviceable satellite sub at the site (servicing target). */
function servicingTarget(state, data, mission, actorId) {
  const p = mission.payload || {};
  const a = p.targetAssetId ? assetById(state, p.targetAssetId) : null;
  if (a?.kind === 'satellite') return a;
  return (state.assets?.list || []).find((x) => x.kind === 'satellite' && x.site === mission.destination && LIVE.has(x.status)
    && subYield(data, 'satellite', x.sub).serviceable && (x.ownerId === actorId || canDeliver(state, data, actorId, x.id).ok)) || null;
}

/** Servicing (§3.6): the oldest unit gets +5 years, health back to 100. */
export function service(state, data, a, years = cfg(data).tuning.servicing.years) {
  if (!a || a.kind !== 'satellite' || !a.units.length) return false;
  const u = a.units[0];
  u.endTurn += Math.round(years * W);
  u.from = state.turn;
  a.units.sort((p, q) => p.endTurn - q.endTurn);
  a.lifeEndTurn = a.units[a.units.length - 1].endTurn;
  a.health = 100;
  if (a.status !== 'active') a.status = 'active';
  refresh(state, data, a);
  return true;
}

function foundStructure(state, data, actorId, mission, kind) {
  if (!canCreate(state, data, actorId, kind)) return null;
  const p = mission.payload || {};
  const name = typeof p.newAssetName === 'string' && p.newAssetName.trim() ? p.newAssetName.trim().slice(0, 32) : pickName(state, data, kind, mission.destination);
  const a = newAsset(state, data, { kind, name, ownerId: actorId, site: mission.destination });
  a.supplyT = 0;
  if (actorId === state.playerId) news(state, a, kind === 'station' ? `Primeiro módulo da ${name} em órbita` : `${name}: a primeira carga pousa ${destOf(data, mission.destination)?.emLabel || ''}`.trim(), 2, kind === 'station' ? '🛰️' : '🏗️');
  return a;
}

/**
 * Apply a successful arrival (§1.3). Called by missions-sim on arrival success (level 'total' | 'partial'); also
 * used for the player's `mission/resolved` signal when nobody called it (idempotent per mission id).
 * Returns {assetId, created} (assetId null when the mission builds nothing).
 */
export function deliver(state, data, mission, level = 'total') {
  if (!mission || !(level === 'total' || level === 'partial')) return { assetId: null, created: false };
  const s = slice(state);
  if (mission.id && s.seen[mission.id] != null) return { assetId: s.seen[mission.id] || null, created: false };
  const actorId = mission.actorId || mission.owner || state.playerId;
  let res = null;
  try {
    res = deliverInner(state, data, actorId, mission, level);
  } catch (e) {
    log(state, `erro em infra.deliver: ${e.message}`);
    res = null;
  }
  const a = res?.a || null;
  if (a && level === 'partial' && (a.kind === 'station' || a.kind === 'base')) a.health = Math.min(a.health, cfg(data).tuning.partialHealth);
  if (a) refresh(state, data, a);
  if (mission.id) s.seen[mission.id] = a?.id || '';
  return { assetId: a?.id || null, created: !!res?.created };
}

function deliverInner(state, data, actorId, mission, level) {
  const C = cfg(data);
  const T = C.tuning;
  const type = missionType(mission);
  const sub = missionSub(mission);
  const sc = scOf(data, mission.spacecraftId);
  const p = mission.payload || {};
  const qtyMult = level === 'partial' ? 0.5 : 1;
  if (type === 'satellite') return deliverSatellite(state, data, actorId, mission, level);
  if (type === 'rover' || (type === 'probe' && sc?.kind === 'rover')) return deliverRover(state, data, actorId, mission, level);
  if (type === 'probe') return null;
  if (!C.active) return null;
  const surface = destOf(data, mission.destination)?.kind === 'surface' || destOf(data, mission.destination)?.kind === 'atmosphere';

  if (type === 'station' || p.kind === 'station_module') {
    let a = resolveTarget(state, data, mission, ['station'], actorId);
    let created = false;
    if (!a) { a = foundStructure(state, data, actorId, mission, 'station'); created = true; }
    if (!a) return null;
    const mid = p.moduleId && C.byId[p.moduleId]?.kind === 'station' ? p.moduleId : moduleForSpacecraft(data, sc, created || !a.modules.length);
    addModule(state, data, a, mid, { by: actorId, quiet: created, massT: num(C.byId[mid]?.massT, num(sc?.massT, 10)) });
    if (created) a.supplyT = r3(actorId === state.playerId ? Math.min(storageOf(data, a), 1) : storageOf(data, a) * T.ai.supplyFill);
    return { a, created };
  }

  if (type === 'crewed') {
    if (sub === 'servicing') {
      const f = servicingTarget(state, data, mission, actorId);
      if (f) { service(state, data, f); contribute(f, actorId, 0, crewCount(mission) * 2); }
      return f ? { a: f, created: false } : null;
    }
    const a = resolveTarget(state, data, mission, surface ? ['base'] : ['station'], actorId);
    if (!a) {
      // a crewed landing with a habitat founds a base there (the old v0.8 crewed bases)
      if (surface && sc?.kind === 'habitat' && C.base.length) {
        const b = foundStructure(state, data, actorId, mission, 'base');
        if (!b) return null;
        addModule(state, data, b, 'bs_hab_small', { by: actorId, quiet: true, massT: num(sc.massT, 6) });
        b.visited = true;
        return { a: b, created: true };
      }
      return null;
    }
    const st = stats(data, a);
    const seats = Math.max(1, Math.min(Math.max(1, st.crewCap || 1), crewCount(mission) || num(sc?.crew, 2)));
    const weeks = rotationWeeks(data, a.kind);
    a.crew = { n: Math.max(seats, a.histId && a.ownerId !== actorId ? num(a.crew?.n) : 0), untilTurn: state.turn + weeks, missionId: mission.id || null };
    if (a.histId) a.crew.untilTurn = null; // historical stations keep their own crew; the visitors add a share
    a.visited = true;
    contribute(a, actorId, 0, seats * weeks);
    if (sc?.kind === 'habitat' && a.kind === 'base') addModule(state, data, a, 'bs_hab_small', { by: actorId, quiet: true, massT: num(sc.massT, 6) });
    return { a, created: false };
  }

  if (type === 'cargo') {
    let kind = p.kind || null;
    if (!kind) kind = sub === 'experiments' || sub === 'propellant' || sub === 'servicing' || sub === 'base_module' || sub === 'base_vehicle' ? sub : 'supply';
    if (kind === 'client') return null;
    if (kind === 'servicing') {
      const f = servicingTarget(state, data, mission, actorId);
      if (f) { service(state, data, f); contribute(f, actorId, 0.5); }
      return f ? { a: f, created: false } : null;
    }
    if (kind === 'base_module' || kind === 'base_vehicle') {
      let a = resolveTarget(state, data, mission, ['base'], actorId);
      let created = false;
      if (!a) { a = foundStructure(state, data, actorId, mission, 'base'); created = true; }
      if (!a) return null;
      if (kind === 'base_module') {
        const mid = p.moduleId && C.byId[p.moduleId]?.kind === 'base' ? p.moduleId : moduleForSpacecraft(data, sc, created, 'base');
        addModule(state, data, a, mid, { by: actorId, quiet: created });
      } else {
        const vid = p.vehicleTypeId && C.vehicleById[p.vehicleTypeId] ? p.vehicleTypeId : C.vehicles[0]?.id;
        addVehicles(state, data, a, vid, clamp(Math.round(num(p.qty, 1) * qtyMult) || 1, 1, 4), actorId);
      }
      if (created) a.supplyT = r3(actorId === state.playerId ? Math.min(storageOf(data, a), 1) : storageOf(data, a) * T.ai.supplyFill);
      return { a, created };
    }
    const a = resolveTarget(state, data, mission, surface ? ['base'] : ['station', 'base'], actorId);
    if (!a) return null;
    const qty = Math.max(0, num(p.qty, num(mission.config?.payloadT, num(sc?.cargoT, 2)))) * qtyMult;
    if (kind === 'experiments') {
      a.boostUntilTurn = Math.max(num(a.boostUntilTurn, 0), state.turn + T.experiments.weeks);
      contribute(a, actorId, qty);
    } else if (kind === 'propellant') {
      // only what the depot can hold counts toward the share (overflow is vented, not credited)
      const before = num(a.propT);
      a.propT = r2(Math.min(500, before + qty));
      contribute(a, actorId, Math.max(0, a.propT - before));
    } else {
      const room = storageOf(data, a);
      const before = num(a.supplyT);
      a.supplyT = r3(Math.min(room, before + qty));
      if (a.supplyT > 0) a.starvedTurn = null;
      if (actorId === state.playerId) a.playerSupplyTurn = state.turn;
      // supply that does not fit is lost: the share grows only by what was stored
      contribute(a, actorId, Math.max(0, a.supplyT - before));
    }
    return { a, created: false };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Access: who may deliver to an asset, targets for the mission builder
// ---------------------------------------------------------------------------------------------------------------

function treatyWith(state, a, b, assetId) {
  return (state.treaties || []).some((t) => t.status === 'active' && arr(t.parties).includes(a) && arr(t.parties).includes(b)
    && PARTNER_TREATIES.includes(t.type) && (t.type !== 'station_partnership' || !t.terms?.assetId || t.terms.assetId === assetId));
}
function contractFor(state, actorId, assetId) {
  return (state.contracts || []).some((c) => c.targetAssetId === assetId && c.winner === actorId && ['awarded', 'late'].includes(c.status));
}

/**
 * {ok, reason} — may `actorId` deliver to the asset (§3.3). opts {payloadKind, type, sub, seats} adds the physical
 * checks: a free port for a new module or a docking, crew room for a rotation.
 */
export function canDeliver(state, data, actorId, assetId, opts = {}) {
  const a = assetById(state, assetId);
  if (!a) return { ok: false, reason: 'Destino não encontrado.' };
  const own = a.ownerId === actorId;
  const rescue = opts.payloadKind === 'supply' || opts.payloadKind === 'servicing' || opts.sub === 'servicing' || opts.sub === 'supply';
  if (a.status === 'ended') return { ok: false, reason: `${a.name} não existe mais.` };
  if (a.status === 'derelict' && !(own && rescue)) return { ok: false, reason: `${a.name} está abandonada.` };
  if (!own) {
    if (!a.ownerId || !state.actors?.[a.ownerId]) return { ok: false, reason: `${a.name} está abandonada.` };
    if (tensionOf(state, actorId, a.ownerId) >= 3) return { ok: false, reason: `A tensão com ${actorName(state, a.ownerId)} impede chegar à ${a.name}.` };
    if (!treatyWith(state, actorId, a.ownerId, a.id) && !contractFor(state, actorId, a.id)) {
      return { ok: false, reason: a.kind === 'station' ? `Precisa de uma parceria de estação com ${actorName(state, a.ownerId)}.` : `Precisa de uma parceria com ${actorName(state, a.ownerId)} para usar ${a.name}.` };
    }
  }
  if (a.kind === 'station' && (opts.type || opts.payloadKind)) {
    const st = stats(data, a);
    const docking = opts.type === 'crewed' || opts.type === 'cargo' || opts.type === 'station' || opts.payloadKind === 'station_module';
    const need = cfg(data).tuning.ports.dockNeedsFree + (num(a.crew?.n) > 0 && opts.type !== 'crewed' ? 1 : 0);
    if (docking && st.freePorts < need) {
      return { ok: false, reason: num(a.crew?.n) > 0 ? `Sem porta livre na ${a.name} com a tripulação a bordo: leve antes um núcleo de duas portas.` : `Sem porta livre na ${a.name}: leve antes um nó de conexão.` };
    }
    if (opts.type === 'crewed' && opts.sub === 'rotation' && num(opts.seats) > 0 && num(opts.seats) > st.crewCap) {
      return { ok: false, reason: `${a.name} tem lugar para ${st.crewCap} tripulantes.` };
    }
  }
  return { ok: true, reason: null };
}

/** Kinds of asset a mission (type/sub/payload kind) can target. */
function targetKinds(type, sub, payloadKind) {
  const pk = payloadKind || null;
  if (type === 'station' || pk === 'station_module') return ['station'];
  if (pk === 'base_module' || pk === 'base_vehicle') return ['base'];
  if (pk === 'servicing' || sub === 'servicing') return ['satellite'];
  if (type === 'cargo' || type === 'crewed') return ['station', 'base'];
  return [];
}

/**
 * Assets a mission may target at a destination (§3.8): own first, then others; each row says whether this actor
 * may deliver there now and why not. [{assetId, name, ownerId, ok, reason, kind, own, modules, health, supplyWeeks}]
 */
export function targetsFor(state, data, { type, sub = null, destination, payloadKind = null, seats = 0 } = {}, actorId = state.playerId) {
  const kinds = targetKinds(missionType({ type }), type === 'lander' ? 'lander' : sub, payloadKind);
  if (!kinds.length || !destination) return [];
  const here = (state.assets?.list || []).filter((a) => kinds.includes(a.kind) && a.site === destination && a.status !== 'ended'
    && (a.kind !== 'satellite' || subYield(data, 'satellite', a.sub).serviceable));
  return here.map((a) => {
    const chk = canDeliver(state, data, actorId, a.id, { type: missionType({ type }), sub, payloadKind, seats });
    const st = a.kind === 'satellite' ? null : stats(data, a);
    const sw = supplyWeeks(state, data, a);
    return {
      assetId: a.id, name: a.name, ownerId: a.ownerId, kind: a.kind, ok: chk.ok, reason: chk.reason, own: a.ownerId === actorId,
      modules: st ? st.count : 0, health: Math.round(a.health), status: a.status, supplyWeeks: Number.isFinite(sw) ? Math.floor(sw) : null,
      crewCap: st?.crewCap ?? 0, freePorts: st?.freePorts ?? null,
    };
  }).sort((x, y) => (y.own - x.own) || (y.ok - x.ok) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// Launch scene snapshot (§7.1)
// ---------------------------------------------------------------------------------------------------------------

/** SceneTarget for launch.js, or null when the flight does not meet a station or a base. JSON only. */
export function sceneTarget(state, data, mission) {
  if (!mission) return null;
  const type = missionType(mission);
  const p = mission.payload || {};
  const sc = scOf(data, mission.spacecraftId);
  const C = cfg(data);
  const dest = destOf(data, mission.destination);
  const surface = dest?.kind === 'surface' || dest?.kind === 'atmosphere';
  const actorId = mission.actorId || state.playerId;
  const pk = p.kind || (type === 'station' ? 'station_module' : null);
  let kind = null;
  if (type === 'station' || pk === 'station_module') kind = 'station';
  else if (pk === 'base_module' || pk === 'base_vehicle') kind = 'base';
  else if (type === 'cargo' || type === 'crewed') kind = surface ? 'base' : 'station';
  if (!kind) return null;
  const target = resolveTarget(state, data, { ...mission, payload: p }, [kind], actorId);
  const founding = !target && (type === 'station' || pk === 'station_module' || pk === 'base_module' || pk === 'base_vehicle' || (surface && sc?.kind === 'habitat'));
  if (!target && !founding) return null;
  const st = target ? stats(data, target) : null;
  const traits = st ? [...st.traits].sort() : [];
  let sequence;
  if (kind === 'base') sequence = 'surface';
  else if (!target) sequence = 'release';
  else if (traits.includes('arm') && (type === 'station' || (sc?.kind === 'cargo' && sc?.docking !== 'auto'))) sequence = 'berth';
  else sequence = 'dock';
  const moduleId = p.moduleId || (kind === 'station' && (type === 'station' || pk === 'station_module') ? moduleForSpacecraft(data, sc, !target) : null);
  return {
    kind, assetId: target?.id || null, name: target?.name || (typeof p.newAssetName === 'string' && p.newAssetName.trim() ? p.newAssetName.trim().slice(0, 32) : (kind === 'station' ? 'Nova estação' : 'Nova base')),
    newAsset: !target, sequence,
    modules: target ? target.modules.map((g) => ({ id: g.id, n: g.n })) : [],
    vehicles: target ? target.vehicles.map((g) => ({ id: g.id, n: g.n })) : [],
    sizeTier: target ? sizeTier(state, data, target, st) : 0, stageN: target ? stageOf(state, data, target, st) : 0,
    bodyId: dest?.body || target?.bodyId || null, site: mission.destination || null,
    payload: { kind: pk, moduleId: moduleId && C.byId[moduleId] ? moduleId : null, vehicleTypeId: p.vehicleTypeId || null, qty: num(p.qty, 1) },
    traits,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Colonies (§3.7)
// ---------------------------------------------------------------------------------------------------------------

/** colonies.js infra levels a base's modules are worth: {vida, energia, alimento, moradia} (capped). */
export function colonyLevels(data, a, st = stats(data, a)) {
  const max = num(cfg(data).tuning.infra?.max, 6);
  const C = cfg(data);
  let greenhouse = 0;
  let isru = 0;
  for (const g of arr(a.modules)) {
    const t = arr(C.byId[g.id]?.traits);
    if (t.includes('greenhouse')) greenhouse += g.n;
    if (t.includes('isru')) isru += g.n;
  }
  return {
    vida: clamp(Math.floor(st.life), 0, max), energia: clamp(Math.floor(st.gen / 2), 0, max),
    alimento: clamp(greenhouse * 2 + isru, 0, max), moradia: clamp(Math.floor(st.housing / 16), 0, max),
  };
}

/** The colonies.json site whose destination is this base's site, or null. */
function colonySiteFor(data, a) {
  const C = colonies.cfg?.(data);
  if (!C) return null;
  return C.sites.find((s) => s.destination === a.site) || null;
}

function tryAdopt(state, data, a) {
  if (a.kind !== 'base' || a.colonyId || a.stageN < 2 || !a.ownerId || !state.actors?.[a.ownerId]) return;
  if (!colonies.isActive?.(data) || typeof colonies.adoptBase !== 'function') return;
  if (yearAt(state) < colonies.unlockYear(data)) return;
  const site = colonySiteFor(data, a);
  if (!site) return;
  const why = colonies.foundCheck(state, data, a.ownerId, site.id, { adopt: true });
  if (why) return;
  const st = stats(data, a);
  colonies.adoptBase(state, data, a.id, { siteId: site.id, stage: a.stageN, crew: num(a.crew?.n), levels: colonyLevels(data, a, st), name: a.name, ownerId: a.ownerId });
}

/** Base asset of a colony founded by the abstract path (convoy): built from the stage's generic module set. */
export function ensureBaseFor(state, data, colony) {
  if (!colony || !cfg(data).active) return null;
  const s = slice(state);
  const linked = colony.assetId ? assetById(state, colony.assetId) : null;
  if (linked && linked.status !== 'ended') return linked.id;
  const byColony = s.list.find((a) => a.colonyId === colony.id && a.status !== 'ended');
  if (byColony) { colony.assetId = byColony.id; return byColony.id; }
  const site = colonies.cfg?.(data)?.siteById?.[colony.siteId];
  const dest = site?.destination || colony.siteId;
  const ownerId = colony.ownerId && state.actors?.[colony.ownerId] ? colony.ownerId : colony.founderId || null;
  const a = newAsset(state, data, { kind: 'base', name: colony.name, ownerId, site: dest });
  if (!a.bodyId) a.bodyId = colony.bodyId || site?.body || null;
  a.colonyId = colony.id;
  a.visited = true;
  // the player's colonies get the stage's full module set; rivals' only the outpost core (their size tier follows the
  // colony stage anyway, and the save stays small with a dozen rival colonies)
  const mine = ownerId === state.playerId;
  const setName = !mine ? 'outpost' : cfg(data).stageRules?.colonyStageSet?.[colony.stage] || (colony.stage >= 4 ? 'colony' : colony.stage >= 3 ? 'base' : 'outpost');
  buildFromSet(state, data, a, setName, ownerId);
  if (mine && colony.stage >= 3) {
    for (const [id, n] of stageSet(data, 'vehicles', yearAt(state))) addVehicles(state, data, a, id, n, ownerId);
  }
  a.crew = { n: Math.max(4, Math.min(stats(data, a).crewCap, Math.floor(num(colony.population, 4)))), untilTurn: null, missionId: null };
  a.supplyT = r3(storageOf(data, a) * 0.8);
  colony.assetId = a.id;
  refresh(state, data, a);
  return a.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Ensure: historical stations, legacy saves, colony bases
// ---------------------------------------------------------------------------------------------------------------

function histOwner(state, h) {
  const own = resolveActor(state, h.owner);
  if (state.actors?.[own]) return own;
  for (const p of arr(h.partners)) { const r = resolveActor(state, p); if (state.actors?.[r]) return r; }
  return null;
}

/** Historical stations by date (§3.3): created with every module already up, ended ones skipped forever. */
function ensureHist(state, data, until) {
  const C = cfg(data);
  if (!C.hist.length || !C.active) return;
  const s = slice(state);
  for (const h of C.hist) {
    if (s.hist[h.id]) continue;
    const from = turnOfDate(state, h.from);
    const end = turnOfDate(state, h.until);
    if (from == null || from >= until) continue;
    if (end != null && end <= state.turn) { s.hist[h.id] = 'gone'; continue; }
    if (!destOf(data, h.destination) && data?.index?.destinations && Object.keys(data.index.destinations).length) {
      // the destination is not in this scenario's catalog (era not loaded yet): try again later
      continue;
    }
    const owner = histOwner(state, h);
    if (!owner) continue;
    const a = newAsset(state, data, { kind: 'station', name: h.name, ownerId: owner, site: h.destination, histId: h.id });
    a.foundedTurn = Math.min(state.turn, from);
    a.untilTurn = end;
    a.histNext = 0;
    histGrow(state, data, a, h, Math.max(until, state.turn + 1), true);
    a.crew = { n: Math.min(num(h.crew, 2), stats(data, a).crewCap || num(h.crew, 2)), untilTurn: null, missionId: null };
    a.visited = true;
    a.supplyT = r3(storageOf(data, a) * cfg(data).tuning.ai.supplyFill);
    s.hist[h.id] = 'live';
    refresh(state, data, a);
  }
}

/** Add the historical modules whose date falls before `until`. */
function histGrow(state, data, a, h, until, quiet = false) {
  const mods = arr(h.modules);
  while (num(a.histNext) < mods.length) {
    const m = mods[a.histNext];
    const t = turnOfDate(state, m.at);
    if (t != null && t >= until) break;
    const by = m.by ? resolveActor(state, m.by) : a.ownerId;
    addModule(state, data, a, m.id, { by: state.actors?.[by] ? by : a.ownerId, quiet: quiet || !involves(state, a) });
    a.histNext = num(a.histNext) + 1;
  }
}

/** v0.8 saves (§10 step 3): successful player 'station' missions → stations/shares; active rover probes → rovers. */
function convertLegacy(state, data) {
  const s = slice(state);
  if (s.legacyDone) return;
  s.legacyDone = true;
  for (const m of state.missions || []) {
    const out = m.result?.outcome;
    if (!(out === 'total' || out === 'partial')) continue;
    const type = missionType(m);
    const sc = scOf(data, m.spacecraftId);
    const roverActive = (type === 'probe' || type === 'rover') && sc?.kind === 'rover' && m.status === 'operations';
    if (!(type === 'station' || roverActive)) continue;
    if (m.status !== 'done' && m.status !== 'operations') continue;
    deliver(state, data, { ...m, actorId: state.playerId }, out);
  }
}

function ensureColonyBases(state, data) {
  const list = state.colonies?.list;
  if (!Array.isArray(list) || !list.length || !cfg(data).active) return;
  for (const c of list) {
    if (c.status === 'node' || c.status === 'independent' || !c.siteId) continue;
    if (c.assetId && assetById(state, c.assetId)) continue;
    // rival colonies around other stars never meet the player's flights: no base asset for them (save budget)
    if (c.ownerId !== state.playerId && (c.starId || colonies.cfg?.(data)?.siteById?.[c.siteId]?.starId)) continue;
    ensureBaseFor(state, data, c);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Continuous update
// ---------------------------------------------------------------------------------------------------------------

/** Mass-weighted share of modules past their life (0..1) at turn t. */
function agedFraction(state, data, a, t) {
  const C = cfg(data);
  const lifeMult = Math.max(0.3, 1 + tb(state, a.ownerId, 'lifetime'));
  let tot = 0;
  let aged = 0;
  for (const g of arr(a.modules)) {
    const m = C.byId[g.id];
    if (!m) continue;
    const w = Math.max(0.1, num(m.massT, 1)) * g.n;
    tot += w;
    if ((t - num(g.addedTurn, a.foundedTurn)) / W > num(m.lifeYears, 25) * lifeMult) aged += w;
  }
  return tot > 0 ? aged / tot : 0;
}

function setStatus(state, data, a, ctx) {
  const T = cfg(data).tuning;
  const prev = a.status;
  const h = a.health;
  const next = h >= T.status.active ? 'active' : h >= T.status.degraded ? 'degraded' : 'derelict';
  if (next === prev) return;
  a.status = next;
  if (next === 'derelict') {
    a.derelictTurn = state.turn;
    a.crew = { n: 0, untilTurn: null, missionId: null };
    if (involves(state, a)) news(state, a, `${a.name} fica sem condições de operar`, 2, '⚠️');
    if (a.ownerId === state.playerId) pushDerelict(state, data, a, ctx);
  } else {
    a.derelictTurn = null;
    if (next === 'degraded' && prev === 'active') {
      emitSignal(state, 'infra/degraded', { assetId: a.id, actorId: a.ownerId });
      const key = `deg|${a.id}`;
      if (involves(state, a) && !(state.turn - num(slice(state).notified[key], -9999) < 52)) {
        slice(state).notified[key] = state.turn;
        news(state, a, `${a.name} se degrada sem suprimentos`, 2, '⚠️');
      }
    }
    if (prev === 'derelict' && a.ownerId === state.playerId) {
      const d = (state.decisions || []).find((x) => x.kind === 'infra/derelict' && x.payload?.assetId === a.id);
      if (d) removeDecision(state, d.id);
    }
  }
}

function pushDerelict(state, data, a, ctx) {
  if ((state.decisions || []).some((x) => x.kind === 'infra/derelict' && x.payload?.assetId === a.id)) return;
  const qty = Math.max(1, Math.ceil(storageOf(data, a) * 0.5));
  pushDecision(state, {
    kind: 'infra/derelict', title: `${a.name} está abandonada`,
    body: `Sem suprimentos a saúde caiu para ${Math.round(a.health)}%. Em ${cfg(data).tuning.derelictYears} anos ${a.kind === 'station' ? 'ela reentra na atmosfera' : 'a base é perdida'}.`,
    choices: [
      { id: 'rescue', label: 'Resgatar', preview: `Prepara uma missão de suprimentos (${qty} t) para ${siteName(data, a.site)}.` },
      { id: 'abandon', label: 'Abandonar', preview: a.kind === 'station' ? 'A estação é desligada e reentra.' : 'A base é desativada.' },
    ],
    urgency: 2, blocking: false, expiresTurn: expiryIn(ctx, 26), defaultChoice: 'rescue', payload: { assetId: a.id },
  });
}

function endAsset(state, data, a, cause, headline = null, importance = null) {
  if (a.status === 'ended') return;
  a.status = 'ended';
  a.endedTurn = state.turn;
  a.crew = { n: 0, untilTurn: null, missionId: null };
  const s = slice(state);
  s.past.unshift({ name: a.name, kind: a.kind, ownerId: a.ownerId, year: yearAt(state), cause });
  const cap = cfg(data).tuning.caps.past;
  if (s.past.length > cap) s.past.length = cap;
  const d = (state.decisions || []).find((x) => x.kind === 'infra/derelict' && x.payload?.assetId === a.id);
  if (d) removeDecision(state, d.id);
  if (a.colonyId) {
    const c = (state.colonies?.list || []).find((x) => x.id === a.colonyId);
    if (c && c.assetId === a.id) c.assetId = null;
  }
  const text = headline || (a.kind === 'station' ? `${a.name} reentra na atmosfera` : a.kind === 'base' ? `${a.name} é desativada` : `${a.name} encerra a missão`);
  news(state, a, text, importance ?? (involves(state, a) ? 2 : 1), a.kind === 'station' ? '☄️' : '🕯️');
  emitSignal(state, 'infra/ended', { assetId: a.id, actorId: a.ownerId, kind: a.kind, cause });
}

/** Station/base over the window [t0, t0 + dt): supply, health (piecewise), crew, status, science. */
function evolveStructure(state, data, ctx, a, t0, dt) {
  const T = cfg(data).tuning;
  const t1 = t0 + dt;
  const h = a.histId ? cfg(data).histById[a.histId] : null;
  if (h) {
    histGrow(state, data, a, h, t1);
    if (a.untilTurn != null && a.untilTurn < t1) { endAsset(state, data, a, 'reentrada', h.reentry || null, involves(state, a) ? 3 : 2); return 0; }
  }
  if (a.status === 'derelict') {
    if (num(a.derelictTurn, t0) + T.derelictYears * W <= t1) { endAsset(state, data, a, a.kind === 'station' ? 'reentrada' : 'abandonada'); return 0; }
  }
  const st = stats(data, a);
  // a colony-fed base is kept stocked by its colony's route all along (no starvation between quarterly refills)
  if (colonyFed(state, a)) {
    const room = st.storageT;
    if (num(a.supplyT) < room * T.ai.supplyFill) a.supplyT = r3(room * T.ai.supplyFill);
  }
  // supply: the crew eats until the rotation ends (cw weeks), the modules all along; w0 = weeks with supply
  const crew0 = num(a.crew?.n);
  const rotEnd = crew0 > 0 && a.crew.untilTurn != null ? a.crew.untilTurn : Infinity;
  const cw = crew0 > 0 ? clamp(rotEnd - t0, 0, dt) : 0;
  const uA = upkeepTYr(state, data, a, st) / W;
  const uB = crew0 > 0 ? upkeepTYr(state, data, { ...a, crew: { n: 0 } }, st) / W : uA;
  const s0 = num(a.supplyT);
  let w0;
  if (s0 <= uA * cw) w0 = uA > 0 ? s0 / uA : dt;
  else w0 = uB > 0 ? Math.min(dt, cw + (s0 - uA * cw) / uB) : dt;
  a.supplyT = r3(Math.max(0, s0 - uA * cw - uB * (dt - cw)));
  if (a.supplyT <= 0 && s0 > 0) a.starvedTurn = Math.round(t0 + w0);
  else if (a.supplyT > 0) a.starvedTurn = null;
  else if (a.starvedTurn == null) a.starvedTurn = t0;
  // health: heal while supplied, starve after; aging all along (mass-weighted share of old modules, at mid-window)
  const heal = (T.healYr + (st.traits.has('eva') ? T.evaHealYr : 0)) / W;
  const starve = T.starveYr / W;
  const age = (T.ageYr * agedFraction(state, data, a, t0 + dt / 2)) / W;
  const h0 = num(a.health, 100);
  const g1 = heal - age;
  const seg1 = (x) => clamp(g1 >= 0 ? Math.max(h0, Math.min(100, h0 + g1 * x)) : h0 + g1 * x, 0, 100);
  const hw0 = seg1(w0);
  const hAt = (x) => (x <= w0 ? seg1(x) : clamp(hw0 - (starve + age) * (x - w0), 0, 100));
  const evacAt = a.starvedTurn != null ? a.starvedTurn + T.graceWeeks : Infinity;
  // science week by week inside the window (health, status and crew change mid-step): at most 13 samples
  let sci = 0;
  for (let k = 0; k < dt; k++) {
    const x = k + 0.5;
    const hx = hAt(x);
    const status = hx >= T.status.active ? 'active' : hx >= T.status.degraded ? 'degraded' : 'derelict';
    const crewN = t0 + x >= rotEnd || t0 + x >= evacAt ? 0 : crew0;
    sci += scienceYr(state, data, a, hx, st, { status, crewN }) / W;
  }
  a.health = r3(hAt(dt));
  if (t1 >= rotEnd) a.crew = { n: 0, untilTurn: null, missionId: null };
  // crew evacuates after the grace weeks without supply
  if (num(a.crew?.n) > 0 && t1 >= evacAt && !(a.supplyT > 0)) {
    a.crew = { n: 0, untilTurn: null, missionId: null };
    if (involves(state, a)) news(state, a, `${a.name}: tripulação evacuada por falta de suprimentos`, 2, '⚠️');
    if (a.colonyId) colonies.applyShock?.(state, data, a.colonyId, 'vida', -15);
  }
  setStatus(state, data, a, ctx);
  if (a.status === 'ended') return 0;
  return sci;
}

function evolveSatellite(state, data, a, t0, dt) {
  const t1 = t0 + dt;
  const y = fleetYield(state, data, a, t0 + dt / 2);
  const before = a.units.length;
  const left = [];
  for (const u of a.units) {
    if (u.endTurn <= t1) {
      if (OBSERVATORY_SUBS.has(a.sub) && involves(state, a)) {
        const years = Math.max(1, Math.round((u.endTurn - num(u.from, a.foundedTurn)) / W));
        news(state, a, `${a.name} encerra a missão após ${years} ${years === 1 ? 'ano' : 'anos'}`, 2, '🔭');
      }
    } else left.push(u);
  }
  a.units = left;
  if (before && !left.length) {
    endAsset(state, data, a, 'fim da vida útil', OBSERVATORY_SUBS.has(a.sub) ? null : `${a.name}: os últimos satélites saem de serviço`, 1);
  } else {
    a.health = r2(left.length ? ageHealth(left[0].endTurn, left[0].from, t1) : 0);
    a.lifeEndTurn = left.length ? left[left.length - 1].endTurn : a.lifeEndTurn;
  }
  return { sci: y.sci * (dt / W), revM: y.revM * (dt / W) };
}

function evolveRover(state, data, a, t0, dt) {
  const t1 = t0 + dt;
  const y = subYield(data, 'rover', a.sub);
  const end = num(a.lifeEndTurn, t1);
  const active = Math.max(0, Math.min(t1, end) - t0);
  const hMid = ageHealth(end, a.foundedTurn, t0 + active / 2);
  const sci = active > 0 ? scienceYr(state, data, a, hMid) * (active / W) : 0;
  a.km = r2(num(a.km) + num(y.kmYr) * (active / W));
  if (end <= t1) {
    const years = (end - a.foundedTurn) / W;
    const txt = years >= 1 ? `${Math.round(years)} ${Math.round(years) === 1 ? 'ano' : 'anos'}` : `${Math.max(1, Math.round(years * 12))} meses`;
    endAsset(state, data, a, 'fim da vida útil', `${a.name} encerra a missão após ${txt} e ${Math.round(a.km).toLocaleString('pt-BR')} km`, involves(state, a) ? 2 : 1);
  } else a.health = r2(ageHealth(end, a.foundedTurn, t1));
  return sci;
}

function payScience(state, a, sci) {
  if (!(sci > 0)) return;
  const pid = state.playerId;
  const share = a.ownerId === pid ? (a.kind === 'station' || a.kind === 'base' ? shareOf(state, a, pid) : 1) : shareOf(state, a, pid);
  if (share > 0) research.addSciencePoints(state, sci * share, 'Infraestrutura');
}

// ---------------------------------------------------------------------------------------------------------------
// Signals: player missions (fallback for deliver), AI calendar flights
// ---------------------------------------------------------------------------------------------------------------

function onSignals(state, data) {
  for (const sg of arr(state.signals)) {
    if (sg?.type === 'mission/resolved') {
      const ok = sg.outcome === 'total' || sg.outcome === 'partial';
      if (!ok || sg.final === false) continue;
      if (sg.missionId) {
        const m = (state.missions || []).find((x) => x.id === sg.missionId);
        // same exclusions as missions-sim's own hand-off: test flights, certification demos and a client's payload
        const skip = !m || m.testDesignId || m.certVehicleId || m.clientPayload || m.payload?.kind === 'client' || m.assetId;
        if (!skip && slice(state).seen[m.id] == null) deliver(state, data, { ...m, actorId: state.playerId }, sg.outcome);
      } else if (sg.calendarId && sg.actorId !== state.playerId) aiFlight(state, data, sg);
    } else if (sg?.type === 'colony/lost' && sg.colonyId) {
      const a = (state.assets?.list || []).find((x) => x.colonyId === sg.colonyId && x.status !== 'ended');
      if (a) { a.colonyId = null; a.crew = { n: 0, untilTurn: null, missionId: null }; }
    }
  }
}

/** An AI calendar flight succeeded: base milestones build/grow AI bases; flights to own assets grow or crew them. */
function aiFlight(state, data, sg) {
  const C = cfg(data);
  if (!C.active) return;
  const item = data?.index?.calendar?.[sg.calendarId];
  if (!item) return;
  const owner = resolveActor(state, item.owner || sg.actorId);
  if (!state.actors?.[owner] || owner === state.playerId) return;
  const site = item.destination;
  const dest = destOf(data, site);
  const surface = dest?.kind === 'surface' || dest?.kind === 'atmosphere';
  let a = (state.assets?.list || []).find((x) => x.ownerId === owner && x.site === site && LIVE.has(x.status) && (x.kind === 'base' || x.kind === 'station'));
  const ms = item.milestone;
  if (!a && ms && AI_BASE_MILESTONES.includes(ms)) {
    const rule = C.aiBases[ms] || {};
    const at = surface ? site : (destOf(data, rule.site) ? rule.site : rule.fallback || rule.site);
    a = (state.assets?.list || []).find((x) => x.ownerId === owner && x.site === at && x.kind === 'base' && LIVE.has(x.status));
    if (!a) {
      if (!canCreate(state, data, owner, 'base')) return;
      a = newAsset(state, data, { kind: 'base', name: pickName(state, data, 'base', at), ownerId: owner, site: at });
      buildFromSet(state, data, a, rule.set || 'outpost', owner);
      for (const p of arr(item.partners)) { const r = resolveActor(state, p); if (state.actors?.[r]) contribute(a, r, 5); }
      a.supplyT = r3(storageOf(data, a) * C.tuning.ai.supplyFill);
      a.grownTurn = state.turn;
      news(state, a, `${actorName(state, owner)} inaugura ${a.name}`, 2, '🏗️');
    }
  } else if (a && surface && a.kind === 'base' && (item.type === 'cargo' || item.type === 'crewed')) {
    aiGrow(state, data, a, true);
  }
  if (a && item.crewed) {
    a.visited = true;
    const cap = stats(data, a).crewCap;
    a.crew = { n: Math.max(num(a.crew?.n), Math.min(cap, num(item.crewSize, 3))), untilTurn: a.histId ? null : state.turn + rotationWeeks(data, a.kind), missionId: null };
  }
  if (a) { a.supplyT = r3(Math.max(num(a.supplyT), storageOf(data, a) * C.tuning.ai.supplyFill)); refresh(state, data, a); }
}

/** AI base growth: the next affordable module of the era (by histYear), at most one per growYears (unless forced). */
function aiGrow(state, data, a, force = false) {
  const C = cfg(data);
  const T = C.tuning;
  if (a.kind !== 'base' || a.histId) return;
  if (!force && state.turn - num(a.grownTurn, a.foundedTurn) < T.ai.growYears * W) return;
  if (budgetPressure(state, a.ownerId) >= T.ai.pressureMax) return;
  const year = yearAt(state);
  const st = stats(data, a);
  const have = new Map();
  for (const g of a.modules) have.set(g.id, (have.get(g.id) || 0) + g.n);
  // what the base lacks first: power, then life support, a lab, housing; else the newest module of the era
  const avail = C.base.filter((m) => num(m.histYear, 0) <= year);
  const pick = (pred) => avail.filter(pred).sort((x, y) => num(y.histYear) - num(x.histYear))[0];
  let m = null;
  if (st.power < 0) m = pick((x) => num(x.power) > 0);
  if (!m && st.lifeMods < 1) m = pick((x) => arr(x.traits).some((t) => t === 'isru' || t === 'greenhouse'));
  if (!m && st.labs < 1) m = pick((x) => arr(x.traits).includes('lab'));
  if (!m && num(a.crew?.n) >= st.crewCap) m = pick((x) => num(x.housing) > 0);
  if (!m) m = avail.filter((x) => (have.get(x.id) || 0) < 3).sort((x, y) => num(y.histYear) - num(x.histYear) || (x.id < y.id ? -1 : 1))[0];
  if (!m) return;
  addModule(state, data, a, m.id, { by: a.ownerId, quiet: true });
  a.grownTurn = state.turn;
}

// ---------------------------------------------------------------------------------------------------------------
// Quarterly and yearly
// ---------------------------------------------------------------------------------------------------------------

/** AI owners (and the historical programmes) resupply abstractly while their budget pressure allows it. */
function aiSupply(state, data, a) {
  const T = cfg(data).tuning;
  if (a.kind !== 'station' && a.kind !== 'base') return;
  if (a.status === 'ended') return;
  const managed = a.ownerId !== state.playerId || !!a.histId;
  const colony = a.colonyId ? (state.colonies?.list || []).find((c) => c.id === a.colonyId) : null;
  const colonyFed = colony && colony.status === 'active' && (num(colony.route) > 0 || num(colony.reserve) > 0);
  if (!managed && !colonyFed) return;
  if (!colonyFed && (!state.actors?.[a.ownerId] || budgetPressure(state, a.ownerId) >= T.ai.pressureMax)) return;
  const room = storageOf(data, a);
  if (num(a.supplyT) < room * T.ai.supplyFill) {
    a.supplyT = r3(room * T.ai.supplyFill);
    a.starvedTurn = null;
  }
}

function reminders(state, data, a) {
  const T = cfg(data).tuning;
  if (a.ownerId !== state.playerId || (a.kind !== 'station' && a.kind !== 'base') || !LIVE.has(a.status) || a.histId) return;
  const sw = supplyWeeks(state, data, a);
  if (!(sw < T.reminderWeeks)) return;
  if (state.turn - num(a.lastNotice, -9999) < T.reminderEveryWeeks) return;
  a.lastNotice = state.turn;
  news(state, a, `${a.name}: suprimentos para ${Math.max(0, Math.floor(sw))} ${Math.floor(sw) === 1 ? 'semana' : 'semanas'}`, 2, '📦');
}

function quarter(state, data) {
  const s = slice(state);
  for (const a of s.list) {
    if (a.status === 'ended') continue;
    tryAdopt(state, data, a);
    reminders(state, data, a);
    refresh(state, data, a);
  }
  // satellite services are paid every quarter (one ledger line per owner)
  for (const [id, m] of Object.entries(s.accM)) {
    if (m >= 0.5 && state.actors?.[id]) { budget.earn(state, id, Math.round(m * 10) / 10, catOf('infra'), 'Satélites: serviços'); s.accM[id] = 0; }
    else if (!state.actors?.[id]) delete s.accM[id];
  }
}

const catOf = (c) => (budget.CATEGORIES?.includes(c) ? c : c === 'infra' ? 'facilities' : 'grants');

export function onYear(state, data, ctx) {
  if (state.gameOver || !state.assets) return;
  const C = cfg(data);
  const T = C.tuning;
  const s = slice(state);
  const pid = state.playerId;
  const scale = num(T.eraScale?.[eraIdAt(state, data)], 1);
  const bill = new Map();
  for (const a of s.list) {
    if (!LIVE.has(a.status)) continue;
    if (a.kind === 'station' || a.kind === 'base') {
      const st = stats(data, a);
      // ground operations, split by share (historical stations are paid by their programmes, off the books)
      if (!a.histId) {
        const m = st.upkeepM * scale;
        for (const { actorId, share } of sharesOf(state, a)) {
          const v = m * share * Math.max(0.3, 1 + tb(state, actorId, 'maintenance'));
          if (v > 0) bill.set(actorId, (bill.get(actorId) || 0) + v);
        }
      }
      // AI owners: prestige from the science they would have earned
      for (const { actorId, share } of sharesOf(state, a)) {
        if (actorId !== pid && a.sciYr > 0) changeActor(state, actorId, 'prestige', T.ai.prestigePerSci * a.sciYr * share);
      }
      if (a.ownerId === pid && a.status === 'active') {
        const P = T.prestigeYr;
        const v = a.kind === 'station' ? P.stationBase + P.stationPerCrew * num(a.crew?.n) : P.baseBase + P.basePerStage * Math.max(0, a.stageN - 1);
        changeActor(state, pid, 'prestige', v);
      }
      // historical stations: the player's supplies with ≥ 25% share keep them flying (alt history)
      if (a.histId && a.untilTurn != null && shareOf(state, a, pid) >= T.hist.playerShareExtend && state.turn - num(a.playerSupplyTurn, -9999) <= W) {
        const ext = state.turn + T.hist.extendYears * W;
        if (ext > a.untilTurn) {
          a.untilTurn = ext;
          news(state, a, `${a.name} ganha mais ${T.hist.extendYears} anos de vida graças aos suprimentos da ${actorName(state, pid)}`, 2, '🛰️');
        }
      }
      if (a.ownerId !== pid) aiGrow(state, data, a);
    } else if (a.kind === 'satellite' && a.ownerId === pid) {
      const y = fleetYield(state, data, a, state.turn);
      if (y.support) changeActor(state, pid, 'support', y.support);
      if (y.rep) changeActor(state, pid, 'reputation', y.rep);
      if (OBSERVATORY_SUBS.has(a.sub) && y.n) changeActor(state, pid, 'prestige', T.prestigeYr.observatory * y.n);
    }
  }
  for (const [actorId, v] of [...bill.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const amt = Math.round(v * 10) / 10;
    if (amt <= 0 || !state.actors?.[actorId]) continue;
    if (budget.spend(state, actorId, amt, catOf('infra'), 'Infraestrutura: operação')) continue;
    // no money for ground operations: the crews cut corners and the hardware suffers
    for (const a of s.list) if (a.ownerId === actorId && LIVE.has(a.status) && (a.kind === 'station' || a.kind === 'base') && !a.histId) a.health = r3(Math.max(0, a.health - 10));
    if (actorId === pid) addNews(state, { headline: 'Sem verba para operar a infraestrutura: estações e bases se desgastam', tags: ['infra'], actors: [pid], importance: 2, icon: '📉' });
  }
  void ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init(state, data) {
  slice(state).legacyDone = true; // a new game has no v0.8 missions to convert
  ensureHist(state, data, state.turn + 1);
}

export function tick(state, data, ctx) {
  if (state.gameOver) return;
  const fresh = !isObj(state.assets);
  const s = slice(state);
  const t0 = Number.isFinite(ctx?.prevTurn) ? ctx.prevTurn : state.turn;
  const dt = Math.max(1, num(ctx?.dt, 1));
  ensureHist(state, data, t0 + dt);
  if (fresh) convertLegacy(state, data);
  onSignals(state, data);
  ensureColonyBases(state, data);
  const q = every(ctx, 13) > 0;
  if (q) for (const a of s.list) if (a.status !== 'ended') aiSupply(state, data, a);
  for (const a of s.list.slice()) {
    if (a.status === 'ended') continue;
    if (a.kind === 'station' || a.kind === 'base') payScience(state, a, evolveStructure(state, data, ctx, a, t0, dt));
    else if (a.kind === 'satellite') {
      const y = evolveSatellite(state, data, a, t0, dt);
      payScience(state, a, y.sci);
      if (y.revM > 0 && a.ownerId) s.accM[a.ownerId] = r3(num(s.accM[a.ownerId]) + y.revM * eraPrice(state, data));
    } else if (a.kind === 'rover') payScience(state, a, evolveRover(state, data, a, t0, dt));
  }
  if (q) quarter(state, data);
}

export function compact(state, data) {
  const s = state.assets;
  if (!isObj(s)) return;
  const T = cfg(data).tuning;
  // ended assets leave the list after endedKeepYears (their name is already in `past` and the annals)
  s.list = s.list.filter((a) => a.status !== 'ended' || state.turn - num(a.endedTurn, state.turn) < T.endedKeepYears * W);
  // caps: the AI keeps its biggest live structures; the player is capped at creation
  const ai = s.list.filter((a) => a.ownerId !== state.playerId && LIVE.has(a.status));
  if (ai.length > T.caps.ai) {
    const keep = new Set(ai.slice().sort((x, y) => (!!y.histId - !!x.histId) || (stats(data, y).massT - stats(data, x).massT) || (x.id < y.id ? -1 : 1)).slice(0, T.caps.ai));
    s.list = s.list.filter((a) => a.ownerId === state.playerId || !LIVE.has(a.status) || keep.has(a));
  }
  if (s.past.length > T.caps.past) s.past.length = T.caps.past;
  const seen = Object.keys(s.seen);
  if (seen.length > T.caps.seen) for (const k of seen.slice(0, seen.length - T.caps.seen)) delete s.seen[k];
  for (const [k, v] of Object.entries(s.notified)) if (state.turn - num(v) > 2 * W) delete s.notified[k];
  for (const a of s.list) {
    if (a.boostUntilTurn != null && a.boostUntilTurn <= state.turn) a.boostUntilTurn = null;
    if (a.kind === 'satellite') a.units = a.units.filter((u) => u.endTurn > state.turn);
  }
}

/** The player's assets end on their own dates; no appointment truncates the step (they are not launches). */
export function appointments() { return []; }

/** An owner left the world (§3.3): assets pass to `into`, else to the biggest partner, else become derelict. */
export function onActorGone(state, data, ctx, id, info = {}) {
  const s = state.assets;
  if (!isObj(s)) return;
  const into = info?.into && state.actors?.[info.into] ? info.into : null;
  for (const a of s.list) {
    const row = a.partners.find((p) => p.actorId === id);
    if (row && into) {
      const other = a.partners.find((p) => p.actorId === into);
      if (other) { other.massT = r2(other.massT + row.massT); other.crewWeeks += row.crewWeeks; a.partners = a.partners.filter((p) => p !== row); } else row.actorId = into;
    }
    if (a.ownerId !== id || a.status === 'ended') continue;
    if (into) { a.ownerId = into; continue; }
    const heir = a.partners.filter((p) => p.actorId !== id && state.actors?.[p.actorId]).sort((x, y) => (y.massT + y.crewWeeks * 0.05) - (x.massT + x.crewWeeks * 0.05) || (x.actorId < y.actorId ? -1 : 1))[0];
    if (heir && (a.kind === 'station' || a.kind === 'base')) {
      a.ownerId = heir.actorId;
      if (involves(state, a)) news(state, a, `${actorName(state, heir.actorId)} assume a ${a.name}`, 2, '🤝');
      continue;
    }
    if (a.kind === 'station' || a.kind === 'base') {
      a.status = 'derelict';
      a.derelictTurn = state.turn;
      a.crew = { n: 0, untilTurn: null, missionId: null };
    } else endAsset(state, data, a, 'dona extinta');
  }
}

export function onActorBorn() {}

const playerAsset = (state, id) => {
  const a = assetById(state, id);
  return a && a.ownerId === state.playerId && a.status !== 'ended' ? a : null;
};

/** Player abandons an asset: partners inherit it; alone, it ends. */
function abandonAsset(state, data, a) {
  const heir = a.partners.filter((p) => p.actorId !== state.playerId && state.actors?.[p.actorId]).sort((x, y) => (y.massT - x.massT) || (x.actorId < y.actorId ? -1 : 1))[0];
  changeActor(state, state.playerId, 'support', -1);
  if (heir && (a.kind === 'station' || a.kind === 'base')) {
    a.ownerId = heir.actorId;
    const d = (state.decisions || []).find((x) => x.kind === 'infra/derelict' && x.payload?.assetId === a.id);
    if (d) removeDecision(state, d.id);
    news(state, a, `${actorName(state, heir.actorId)} assume a ${a.name}`, 2, '🤝');
    return { ok: true, heir: heir.actorId };
  }
  endAsset(state, data, a, 'abandonada', a.kind === 'station' ? `${a.name} é desligada e deixada para reentrar` : null, 2);
  return { ok: true };
}

/** Prefilled draft of a supply mission to an asset (Infra screen and the derelict card). */
export function supplyDraft(state, data, a) {
  if (!a) return null;
  const qty = Math.max(1, Math.ceil(Math.max(0, storageOf(data, a) - num(a.supplyT))));
  return { type: 'cargo', sub: 'supply', destination: a.site, payload: { kind: 'supply', qty: Math.min(40, qty), targetAssetId: a.id, moduleId: null, vehicleTypeId: null, newAsset: false, newAssetName: null } };
}

export const actions = {
  'infra/rename': (state, data, a) => {
    const x = playerAsset(state, a?.assetId);
    if (!x) return { ok: false, error: 'Ativo indisponível.' };
    const name = typeof a?.name === 'string' ? a.name.trim().slice(0, 32) : '';
    if (!name) return { ok: false, error: 'Dê um nome.' };
    x.name = name;
    return { ok: true, name };
  },
  'infra/abandon': (state, data, a) => {
    const x = playerAsset(state, a?.assetId);
    if (!x) return { ok: false, error: 'Ativo indisponível.' };
    return abandonAsset(state, data, x);
  },
};

export const decisionHandlers = {
  'infra/derelict': (state, data, dec, choiceId) => {
    const a = assetById(state, dec.payload?.assetId);
    if (!a || a.status === 'ended') return { ok: true };
    if (choiceId === 'abandon') return abandonAsset(state, data, a);
    return { ok: true, draft: supplyDraft(state, data, a) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Queries (UI)
// ---------------------------------------------------------------------------------------------------------------

/** Everything a card of the Infraestrutura screen shows (pure). */
export function assetView(state, data, a) {
  const C = cfg(data);
  const pid = state.playerId;
  const structure = a.kind === 'station' || a.kind === 'base';
  const st = structure ? stats(data, a) : null;
  const sw = structure ? supplyWeeks(state, data, a) : Infinity;
  const fy = a.kind === 'satellite' ? fleetYield(state, data, a, state.turn) : null;
  const alerts = [];
  if (structure && LIVE.has(a.status) && sw < C.tuning.reminderWeeks && !a.histId) alerts.push('supply');
  if (a.status === 'degraded') alerts.push('degraded');
  if (a.status === 'derelict') alerts.push('derelict');
  const end = a.kind === 'satellite' ? (a.units[0]?.endTurn ?? a.lifeEndTurn) : a.lifeEndTurn;
  if ((a.kind === 'satellite' || a.kind === 'rover') && end != null && end - state.turn < W && a.status !== 'ended') alerts.push('ending');
  const sci = a.status === 'ended' ? 0 : a.kind === 'satellite' ? fy.sci : scienceYr(state, data, a, a.health, st);
  const share = structure ? shareOf(state, a, pid) : (a.ownerId === pid ? 1 : 0);
  return {
    id: a.id, kind: a.kind, kindLabel: KIND_LABEL[a.kind], sub: a.sub, subLabel: a.sub ? subLabel(data, a.kind, a.sub) : null,
    name: a.name, ownerId: a.ownerId, ownerName: actorName(state, a.ownerId), mine: a.ownerId === pid, hist: !!a.histId,
    partners: structure ? sharesOf(state, a).map((p) => ({ actorId: p.actorId, name: actorName(state, p.actorId), share: Math.round(p.share * 100) })) : [],
    site: a.site, siteName: siteName(data, a.site), bodyId: a.bodyId, status: a.status, statusLabel: STATUS_LABEL[a.status] || a.status,
    health: Math.round(num(a.health)), supplyT: structure ? r2(num(a.supplyT)) : null, storageT: st ? r2(st.storageT) : null,
    upkeepTYr: structure ? r2(upkeepTYr(state, data, a, st)) : null, supplyWeeks: structure ? (Number.isFinite(sw) ? Math.floor(sw) : null) : null,
    crew: num(a.crew?.n), crewCap: st?.crewCap ?? 0, crewUntilTurn: a.crew?.untilTurn ?? null,
    sciYr: r2(sci), myShare: Math.round(share * 100), mySciYr: r2(sci * share),
    revenueMYr: fy ? r2(fy.revM * eraPrice(state, data)) : 0, units: fy ? fy.n : 0,
    modules: arr(a.modules).reduce((acc, g) => {
      const row = acc.find((x) => x.id === g.id);
      if (row) row.n += g.n; else acc.push({ id: g.id, n: g.n, label: C.byId[g.id]?.label || g.id });
      return acc;
    }, []),
    vehicles: arr(a.vehicles).reduce((acc, g) => {
      const row = acc.find((x) => x.id === g.id);
      if (row) row.n += g.n; else acc.push({ id: g.id, n: g.n, label: C.vehicleById[g.id]?.label || g.id });
      return acc;
    }, []),
    power: st ? r2(st.power) : null, freePorts: st?.freePorts ?? null, traits: st ? [...st.traits].sort() : [],
    lifeEndTurn: end ?? null, yearsLeft: end != null && a.status !== 'ended' ? r2(Math.max(0, (end - state.turn) / W)) : null, km: a.kind === 'rover' ? Math.round(num(a.km)) : null,
    stageN: num(a.stageN), sizeTier: num(a.sizeTier), colonyId: a.colonyId || null, foundedTurn: a.foundedTurn, untilTurn: a.untilTurn ?? null,
    boost: num(a.boostUntilTurn, -1) > state.turn, propT: a.propT ? r2(a.propT) : 0, alerts,
    supplyDraft: structure && LIVE.has(a.status) ? supplyDraft(state, data, a) : null,
  };
}

/** View rows: {kind?, mine?, includeEnded?}. Player's own first, then partner shares, then the rest. */
export function listView(state, data, { kind = null, mine = null, includeEnded = false } = {}) {
  const pid = state.playerId;
  return (state.assets?.list || [])
    .filter((a) => (includeEnded || a.status !== 'ended') && (!kind || a.kind === kind) && (mine == null || (a.ownerId === pid) === !!mine))
    .map((a) => assetView(state, data, a))
    .sort((x, y) => (y.mine - x.mine) || (y.myShare - x.myShare) || KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** Badge and totals for the player: {count, byKind, alerts, sciYr, revenueMYr, upkeepTYr, past}. */
export function summary(state, data) {
  const pid = state.playerId;
  const out = { count: 0, byKind: { station: 0, base: 0, satellite: 0, rover: 0 }, alerts: 0, sciYr: 0, revenueMYr: 0, upkeepMYr: 0, partnerOf: 0, past: arr(state.assets?.past).slice(0, 10) };
  const scale = num(cfg(data).tuning.eraScale?.[eraIdAt(state, data)], 1);
  for (const a of state.assets?.list || []) {
    if (!LIVE.has(a.status)) continue;
    const share = a.kind === 'station' || a.kind === 'base' ? shareOf(state, a, pid) : (a.ownerId === pid ? 1 : 0);
    if (a.ownerId !== pid && !(share > 0)) continue;
    const v = assetView(state, data, a);
    if (a.ownerId === pid) { out.count += 1; out.byKind[a.kind] += 1; if (v.alerts.includes('supply') || v.alerts.includes('derelict')) out.alerts += 1; } else out.partnerOf += 1;
    out.sciYr += v.mySciYr;
    out.revenueMYr += a.ownerId === pid ? v.revenueMYr : 0;
    if ((a.kind === 'station' || a.kind === 'base') && !a.histId) out.upkeepMYr += stats(data, a).upkeepM * scale * share;
  }
  out.sciYr = r2(out.sciYr);
  out.revenueMYr = r2(out.revenueMYr);
  out.upkeepMYr = Math.round(out.upkeepMYr);
  return out;
}

export const queries = {
  'infra/list': (state, data, opts = {}) => listView(state, data, opts || {}),
  'infra/get': (state, data, id) => { const a = assetById(state, id); return a ? assetView(state, data, a) : null; },
  'infra/summary': (state, data) => summary(state, data),
  'infra/targets': (state, data, q = {}) => targetsFor(state, data, q || {}, state.playerId),
  'infra/catalog': (state, data, kind = 'station') => modulesCatalog(data, kind).map((m) => ({ ...m })),
};

export function onGameEnd() {}

// exported for tests
export const _internal = { DEFAULT_TUNING, ageHealth, agedFraction };

// Colônias (docs/EXPANSION.md §2.1 unlocks.colonies, §8 rotas, §14 C10; GDD "Mapa do universo e colonização").
// Os seis estágios do GDD (vocab.colonyStages): Reconhecimento → Posto avançado → Base → Colônia → Cidade-estado →
// Mundo independente ou aliado. Cada colônia tem população, quatro necessidades (suporte de vida, energia, alimento,
// moradia), uma linha de suprimento com a Terra (nível 0–3, custo anual, reserva em semanas), opinião sobre a
// agência dona, impostos, crises (cartas de decisão) e, no estágio 5, a pressão pela independência.
//
// Slice (dono: este módulo), JSON puro:
//   state.colonies = {
//     list: [colônias assentadas]   ← o formato que src/sim/explore.js colonyList() lê para os marcadores do mapa
//                                     {id, name, siteId, kind, bodyId, starId, regionId, ownerId, founderId, stage,
//                                      status: active|allied|independent|node, population, foundedTurn, stageTurn,
//                                      infra{vida,energia,alimento,moradia}, shock{}, reserve, route, tax, charter,
//                                      opinion, welfare, autonomy, needs{}, pending[], project, done[], card, indep,
//                                      govId, opBonus, routeMult, exportMult, prestigeYear},
//     transit: [comboios/naves-semente a caminho {id, siteId, ownerId, name, departTurn, arriveTurn}],
//     probes:  [sondas de reconhecimento do jogador {siteId, ownerId, departTurn, arriveTurn}],
//     surveys: {siteId: turn}        reconhecimento próprio do jogador (estágio 1),
//     frontier: {reachLy, extra, worlds, nodes: [regionId]},
//     past: [{name, place, year, cause}] (teto 12), once: {eventId: true}, recent: {eventId: ano} (cartas do jogador,
//     sem repetir por tuning.events.repeatYears), seq, maxStage, stats }
// Regras de módulo (ARCHITECTURE.md): determinístico (rngFor/ctx.rng só), dt-nativo (meta.maxDt 52): o contínuo
// (reserva, população, opinião, choques) escala com dt; o anual (custos, renda, crises, independência, IA, fronteira)
// fica em onYear. Ativo só quando o cenário tem `unlocks.colonies` e há data.colonies (a Corrida Lunar nunca cria o
// slice). Os rivais também colonizam (gestão automática, sem cartas).

import { addNews, changeActor, clamp, claimFirst, emitSignal, pushDecision, removeDecision, expiryIn, dueIn, decay } from '../core/helpers.js';
import { rngFor, hash32 } from '../core/rng.js';
import { turnToDate, eraAt, WEEKS_PER_YEAR } from '../core/time.js';
import * as budget from './budget.js';
import { explore, exploredIds } from './explore.js';

export const meta = { maxDt: 52 };

const W = WEEKS_PER_YEAR;
const NEEDS = ['vida', 'energia', 'alimento', 'moradia'];
const IMPORTED = ['vida', 'energia', 'alimento'];
const SETTLED = new Set(['active', 'allied', 'independent']);
const STAGE_KIND = (n) => (n <= 2 ? 'outpost' : n === 3 ? 'base' : 'colony');
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const r2 = (x) => Math.round(x * 100) / 100;
/** pt-BR prepositions for a site: {em: "na Lua", para: "para a Lua", a: "à Lua"} (data overrides; default without article). */
const preps = (site) => ({ em: site?.em || `em ${site?.place || '?'}`, para: site?.para || `para ${site?.place || '?'}`, a: site?.a || `a ${site?.place || '?'}` });
const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? String(v[k]) : ''));

// ---------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------

const DEFAULT_TUNING = {
  cost: { refBudgetM: 2500, min: 0.35, max: 1.6 },
  caps: { player: 8, ai: 12, perSite: 2, list: 40, aiPerActor: 3 },
  survey: { costM: 120, interstellarCostM: 900, probeSpeedC: 0.1, ownRiskMult: 0.6, interstellarFromYear: 2120 },
  ship: { speedC: { e5: 0.02, e6: 0.05, e7: 0.2 }, minYearInterstellar: 2200 },
  found: { success: 0.94, pop: 8, interstellarPop: 600, interstellarStage: 3, interstellarInfra: 2 },
  route: { capPerLevel: 0.4, maxLevel: 3, reserveMax: 52, startReserve: 26, interstellarReserve: 520, lossPerYear: 0.06, lossWeeks: 6 },
  infra: { max: 6, costM: 45, levelMult: 0.6, weeks: 13 },
  pop: { outpostCrewPerYear: 4, immigration: 0.05, lowWelfare: 40, decline: 0.012 },
  tax: { leve: { rate: 0.1, opinion: 0, label: 'Leve (10%)' }, media: { rate: 0.25, opinion: -8, label: 'Média (25%)' }, pesada: { rate: 0.4, opinion: -18, label: 'Pesada (40%)' } },
  opinion: { start: 66, weeklyPull: 0.985, charter: 12, supplyOk: 5, supplyShort: -10, interstellar: 14, outer: 5 },
  independence: { minStage: 5, opinionBelow: 42, autonomyAbove: 0.85, yearsAtStage: 25, chancePerYear: 0.35, alliedOpinion: 40, cooldownYears: 10, forcedOpinion: 25, alliedShare: 0.15 },
  events: { basePerYear: 0.28, lowWelfare: 0.22, maxOpenCards: 2, expiryWeeks: 10, repeatYears: 8 },
  ai: { foundPerYear: 0.06, minBudgetM: 500, routeLevel: 2, investCashMult: 3, costMult: 1, stellarCostMult: 0.25 },
  prestigePerStageYear: 0.15,
};

function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

const CACHE = new WeakMap();
/** Indexed colony data: {tuning, stages[n], stageById, needs, sites, siteById, events, projects, rules, frontier, texts}. */
export function cfg(data) {
  const src = data?.colonies;
  if (!src) return null;
  let c = CACHE.get(src);
  if (c) return c;
  const stages = [];
  for (const s of arr(src.stages)) if (Number.isInteger(s?.n)) stages[s.n] = s;
  c = {
    tuning: deepMerge(DEFAULT_TUNING, src.tuning || {}),
    stages, stageById: Object.fromEntries(arr(src.stages).map((s) => [s.id, s])),
    needs: arr(src.needs).length ? src.needs : NEEDS.map((id) => ({ id, label: id, weight: 0.25, imported: id !== 'moradia' })),
    sites: arr(src.sites), siteById: Object.fromEntries(arr(src.sites).map((s) => [s.id, s])),
    events: arr(src.events), projects: arr(src.projects), projectById: Object.fromEntries(arr(src.projects).map((p) => [p.id, p])),
    rules: arr(src.milestones), frontier: src.frontier || {}, texts: src.texts || {},
  };
  CACHE.set(src, c);
  return c;
}

/** The scenario uses colonies (campaign and the e5+ scenarios) and the data is loaded. */
export function isActive(data) {
  return !!data?.scenario?.unlocks?.colonies && !!cfg(data);
}
export function unlockYear(data) {
  const y = Number(data?.scenario?.unlocks?.colonies?.fromYear);
  return Number.isFinite(y) ? y : 2051;
}

const yearAt = (state, turn = state.turn) => turnToDate(turn, state.startYear).year;
const eraIdAt = (state, data, turn = state.turn) => eraAt(data, yearAt(state, turn))?.id || state.clock?.eraId || 'e5';
const finalTurnOf = (state) => (Number.isFinite(state.clock?.finalTurn) ? state.clock.finalTurn : Number.isFinite(state.endTurn) ? state.endTurn : Infinity);
const owner = (state, id) => (id ? state.actors?.[id] || null : null);
const ownerName = (state, id) => owner(state, id)?.short || owner(state, id)?.name || 'Uma agência';
const isStellar = (site) => !!site?.starId;
const incomeCat = () => (budget.CATEGORIES?.includes('colonies') ? 'colonies' : 'grants');
const spendCat = () => (budget.CATEGORIES?.includes('colonies') ? 'colonies' : 'facilities');

/** Cost multiplier from the actor's annual budget (a small agency pays proportionally less). */
export function costScale(state, data, actorId) {
  const t = cfg(data)?.tuning || DEFAULT_TUNING;
  const b = Number(owner(state, actorId)?.budget) || t.cost.refBudgetM;
  return clamp(b / t.cost.refBudgetM, t.cost.min, t.cost.max);
}
const scaled = (state, data, actorId, m) => Math.round((Number(m) || 0) * costScale(state, data, actorId));

/** The slice (created on demand, tolerant of old or partial saves). */
export function slice(state) {
  let s = state.colonies;
  if (!isObj(s)) s = state.colonies = {};
  if (!Array.isArray(s.list)) s.list = [];
  if (!Array.isArray(s.transit)) s.transit = [];
  if (!Array.isArray(s.probes)) s.probes = [];
  if (!isObj(s.surveys)) s.surveys = {};
  if (!isObj(s.frontier)) s.frontier = { reachLy: 0, extra: 0, worlds: 0, nodes: [] };
  if (!Array.isArray(s.frontier.nodes)) s.frontier.nodes = [];
  if (!Array.isArray(s.past)) s.past = [];
  if (!isObj(s.once)) s.once = {};
  if (!isObj(s.recent)) s.recent = {};
  if (!isObj(s.stats)) s.stats = { founded: 0, lost: 0, sovereign: 0 };
  if (!Number.isFinite(s.seq)) s.seq = 0;
  if (!Number.isFinite(s.maxStage)) s.maxStage = 0;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Sites: knowledge, travel
// ---------------------------------------------------------------------------------------------------------------

/** Weeks of travel from Earth to a site (stellar sites: light-years / ship speed of the era). */
export function travelWeeks(state, data, site, turn = state.turn) {
  if (!site) return 0;
  if (!isStellar(site)) return Math.max(1, Math.round(site.transitWeeks || 1));
  const t = cfg(data).tuning;
  const v = t.ship.speedC[eraIdAt(state, data, turn)] || t.ship.speedC.e6 || 0.05;
  return Math.max(52, Math.ceil(((Number(site.ly) || 4) / v) * W));
}
export function probeWeeks(state, data, site) {
  if (!site) return 0;
  if (!isStellar(site)) return Math.max(4, Math.round((site.transitWeeks || 1) * 0.8));
  const v = cfg(data).tuning.survey.probeSpeedC || 0.1;
  return Math.max(52, Math.ceil(((Number(site.ly) || 4) / v) * W));
}

/** Known to an actor at `year`: a real survey (fato) for everyone; the player's own surveys/explored stars; AI dates. */
export function siteKnown(state, data, site, actorId = state.playerId, year = yearAt(state)) {
  if (!site) return false;
  if (site.survey?.year != null && site.survey.year <= year) return true;
  if (actorId === state.playerId) {
    if (state.colonies?.surveys?.[site.id] != null) return true;
    if (isStellar(site)) {
      const ex = exploredIds(state, data);
      return ex.has(site.starId) || ex.has(site.body);
    }
    return false;
  }
  return isStellar(site) ? Number.isFinite(site.aiFrom) && site.aiFrom <= year : site.survey == null;
}

const siteOpen = (site, year) => year >= (site?.fromYear ?? 0);
const settledAt = (s, siteId) => s.list.filter((c) => c.siteId === siteId && SETTLED.has(c.status)).length + s.transit.filter((t) => t.siteId === siteId).length;
const ownedBy = (s, id) => s.list.filter((c) => c.ownerId === id && c.status === 'active').length + s.transit.filter((t) => t.ownerId === id).length;

// ---------------------------------------------------------------------------------------------------------------
// Colony model (pure over one colony)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Derived numbers of a colony: {local{k}, autonomy, importNeed, capacity, coverage, needs{k}, welfare, housing}.
 * local = infra (+ site bonus) / what the stage requires; imports cover the rest while the route delivers or the
 * reserve lasts; moradia = housing capacity / population.
 */
export function model(data, c, site = cfg(data)?.siteById?.[c.siteId]) {
  const C = cfg(data);
  const t = C.tuning;
  const st = C.stages[c.stage] || C.stages[2] || {};
  const req = Math.max(1, st.req || 2);
  const eff = (k) => (c.infra?.[k] || 0) + (site?.bonus?.[k] || 0);
  const local = {};
  for (const k of IMPORTED) local[k] = clamp(eff(k) / req, 0, 1);
  const autonomy = IMPORTED.reduce((a, k) => a + local[k], 0) / IMPORTED.length;
  const importNeed = 1 - autonomy;
  const capacity = isStellar(site) ? 0 : (c.route || 0) * t.route.capPerLevel;
  const coverage = importNeed <= 0.001 || capacity >= importNeed || (c.reserve || 0) > 0 ? 1 : capacity / importNeed;
  const needs = {};
  for (const k of IMPORTED) needs[k] = clamp(100 * Math.min(1, local[k] + (1 - local[k]) * coverage) + (c.shock?.[k] || 0), 0, 100);
  const housing = Math.round((st.housing || 20) * (1 + 0.5 * eff('moradia')));
  needs.moradia = clamp(100 * Math.min(1, housing / Math.max(1, c.population || 1)) + (c.shock?.moradia || 0), 0, 100);
  let welfare = 0;
  for (const n of C.needs) welfare += (n.weight || 0) * (needs[n.id] ?? 100);
  if (needs.vida < 40) welfare -= (40 - needs.vida) * 0.5; // air and water first: nothing else matters without them
  return { local, autonomy, importNeed, capacity, coverage, needs, welfare: clamp(welfare, 0, 100), housing, supplied: coverage >= 1 };
}

function refresh(data, c) {
  const m = model(data, c);
  c.autonomy = r2(m.autonomy);
  c.welfare = Math.round(m.welfare);
  c.needs = Object.fromEntries(NEEDS.map((k) => [k, Math.round(m.needs[k])]));
  return m;
}

/** Opinion target (where the colony's mood drifts to). */
export function opinionTarget(data, c, m = model(data, c)) {
  const C = cfg(data);
  const t = C.tuning.opinion;
  const site = C.siteById[c.siteId];
  const tax = C.tuning.tax[c.charter ? 'leve' : c.tax] || C.tuning.tax.media;
  let drive = 0;
  if (c.stage >= 4) {
    drive = m.autonomy * 20 + (c.stage - 3) * 5;
    if (isStellar(site)) drive += t.interstellar;
    else if (['jupiter', 'saturno', 'externo'].includes(site?.region)) drive += t.outer;
  }
  const v = 50 + 0.6 * (m.welfare - 60) + (m.supplied ? t.supplyOk : t.supplyShort) + (tax.opinion || 0)
    + (c.charter ? t.charter : 0) + (c.opBonus || 0) - drive;
  return clamp(v, 5, 95);
}

// ---------------------------------------------------------------------------------------------------------------
// News, milestones, signals
// ---------------------------------------------------------------------------------------------------------------

/** A text of data.colonies.texts: a string, or a list of variants picked deterministically (key, turn, vars). */
function pickText(state, data, key, vars) {
  const tx = cfg(data)?.texts?.[key];
  if (!Array.isArray(tx)) return tx || '';
  return tx.length ? tx[hash32('coltext', key, state.turn, vars?.name || vars?.site || '') % tx.length] : '';
}
function news(state, data, key, vars, { importance = 1, actors = [], icon = '🪐', fallback = '', text = null } = {}) {
  const tx = text || pickText(state, data, key, vars) || fallback;
  if (!tx) return;
  addNews(state, { headline: fill(tx, vars), tags: ['colony'], actors: actors.filter(Boolean), importance, icon });
}

function claim(state, data, mid, actorId, label) {
  if (!mid || !actorId || !state.actors?.[actorId] || !state.firsts || state.firsts[mid]) return false;
  if (!claimFirst(state, mid, actorId, 30, 0)) return false;
  emitSignal(state, 'first', { milestoneId: mid, actorId, source: 'colonies' });
  addNews(state, { headline: `${ownerName(state, actorId)}: ${label || mid}`, tags: ['first', 'colony'], actors: [actorId], importance: 3, icon: '🏁' });
  return true;
}

/** Stage/body rules of data.colonies.milestones for one colony (only unclaimed firsts are paid). */
function stageMilestones(state, data, c) {
  const C = cfg(data);
  const site = C.siteById[c.siteId];
  for (const r of C.rules) {
    if (r.stage == null || r.event || r.outcome) continue;
    if (c.stage < r.stage) continue;
    if (r.body && r.body !== site?.body && r.body !== site?.mapBody) continue;
    claim(state, data, r.milestone, c.ownerId, r.label);
  }
}
function eventMilestones(state, data, ev, actorId, extra = {}) {
  for (const r of cfg(data).rules) {
    if (r.event !== ev) continue;
    if (r.maxSpeedC != null && !(extra.speedC <= r.maxSpeedC)) continue;
    if (r.surface && !extra.surface) continue;
    claim(state, data, r.milestone, actorId, r.label);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Founding, surveys, arrivals
// ---------------------------------------------------------------------------------------------------------------

function colonyName(state, data, site, ownerId) {
  const s = slice(state);
  const names = arr(site.names).length ? site.names : [site.name];
  const used = new Set([...s.list.map((c) => c.name), ...s.transit.map((t) => t.name)]);
  const start = hash32('colname', site.id, ownerId || '') % names.length;
  for (let i = 0; i < names.length; i++) {
    const n = names[(start + i) % names.length];
    if (!used.has(n)) return n;
  }
  return `${names[start]} ${s.seq + 1}`;
}

/** Founding cost. Rivals pay a share of a seed ship (their consortia and governments split it, off the books). */
export function foundCost(state, data, actorId, site) {
  const T = cfg(data).tuning;
  const mult = actorId === state.playerId ? 1 : isStellar(site) ? (T.ai.stellarCostMult ?? 0.25) : (T.ai.costMult ?? 1);
  return Math.round(scaled(state, data, actorId, site?.costM) * mult);
}

/**
 * Why `actorId` cannot found at `siteId` now (pt-BR), or null. Cost/weeks in `out`. With `out.adopt` (infra.js
 * adopting a base built module by module, MISSIONS-V2 §3.7) there is no convoy: cost, travel and the player's survey
 * do not apply (the base itself is the survey).
 */
export function foundCheck(state, data, actorId, siteId, out = {}) {
  const C = cfg(data);
  if (!C || !isActive(data)) return 'Esta partida não tem colônias.';
  const site = C.siteById[siteId];
  if (!site) return 'Local desconhecido.';
  const s = slice(state);
  const year = yearAt(state);
  out.costM = foundCost(state, data, actorId, site);
  out.weeks = travelWeeks(state, data, site);
  out.arriveTurn = state.turn + out.weeks;
  if (year < unlockYear(data)) return `Colônias só a partir de ${unlockYear(data)}.`;
  if (!siteOpen(site, year)) return `${site.name} só fica ao alcance a partir de ${site.fromYear}.`;
  if (isStellar(site) && year < C.tuning.ship.minYearInterstellar) return `Naves-semente só a partir de ${C.tuning.ship.minYearInterstellar}.`;
  const adopt = out.adopt === true;
  if (!adopt && !siteKnown(state, data, site, actorId, year)) return isStellar(site) ? 'Mande antes uma sonda de reconhecimento para essa estrela.' : 'Local ainda não reconhecido.';
  if (s.list.some((c) => c.siteId === siteId && c.ownerId === actorId && SETTLED.has(c.status)) || s.transit.some((t) => t.siteId === siteId && t.ownerId === actorId)) return 'Você já tem uma colônia ali.';
  if (settledAt(s, siteId) >= C.tuning.caps.perSite) return 'Já há colônias demais nesse local.';
  const cap = actorId === state.playerId ? C.tuning.caps.player : C.tuning.caps.aiPerActor;
  if (ownedBy(s, actorId) >= cap) return `Limite de ${cap} colônias ao mesmo tempo.`;
  if (adopt) return null;
  if (out.arriveTurn >= finalTurnOf(state)) return 'A nave chegaria depois do fim da campanha.';
  if (!budget.canAfford(state, actorId, out.costM)) return `Caixa insuficiente: a fundação custa ${budget.fmtMoney(out.costM)}.`;
  return null;
}

/**
 * A base built module by module becomes a colony (MISSIONS-V2 §3.7, called by src/sim/infra.js): no convoy, the
 * colony is founded at once with the base's stage, crew and infrastructure levels, and linked to the asset
 * (colony.assetId ↔ asset.colonyId). info = {siteId, stage, crew, levels: {vida, energia, alimento, moradia}, name,
 * ownerId}. Returns {ok, colonyId} or {ok: false, error}.
 */
export function adoptBase(state, data, assetId, info = {}) {
  const C = cfg(data);
  if (!C || !isActive(data)) return { ok: false, error: 'Esta partida não tem colônias.' };
  const asset = (state.assets?.list || []).find((a) => a.id === assetId) || null;
  const site = C.siteById[info.siteId] || C.sites.find((x) => x.destination === asset?.site) || null;
  const ownerId = info.ownerId || asset?.ownerId;
  if (!site || !ownerId || !owner(state, ownerId)) return { ok: false, error: 'Local desconhecido.' };
  if (asset?.colonyId) return { ok: true, colonyId: asset.colonyId };
  const why = foundCheck(state, data, ownerId, site.id, { adopt: true });
  if (why) return { ok: false, error: why };
  const T = C.tuning;
  const s = slice(state);
  s.seq += 1;
  const stage = clamp(Math.round(Number(info.stage) || 2), 2, 3);
  const max = T.infra.max;
  const lv = info.levels || {};
  const c = {
    id: `col_${s.seq}`, name: String(info.name || asset?.name || colonyName(state, data, site, ownerId)).slice(0, 32), siteId: site.id, kind: STAGE_KIND(stage),
    bodyId: site.mapBody || null, starId: site.starId || null, ownerId, founderId: ownerId, stage, status: 'active',
    population: Math.max(4, Math.floor(Number(info.crew) || 0)), foundedTurn: state.turn, stageTurn: state.turn,
    infra: Object.fromEntries(NEEDS.map((k) => [k, clamp(Math.floor(Number(lv[k]) || 0), 0, max)])), shock: {},
    reserve: T.route.startReserve, route: 1, tax: 'leve', charter: false,
    opinion: T.opinion.start, welfare: 0, autonomy: 0, needs: {}, pending: [], project: null, done: [], card: null,
    indep: { resisted: 0, cooldownTurn: null }, govId: null, opBonus: 0, routeMult: 1, exportMult: 1, prestigeYear: 0,
    assetId: assetId || null,
  };
  refresh(data, c);
  s.list.push(c);
  s.stats.founded += 1;
  if (ownerId === state.playerId && s.surveys[site.id] == null) s.surveys[site.id] = state.turn;
  if (asset) asset.colonyId = c.id;
  const vars = { owner: ownerName(state, ownerId), site: site.name, place: site.place, ...preps(site), name: c.name };
  news(state, data, 'founded', vars, { importance: ownerId === state.playerId ? 3 : 1, actors: [ownerId], icon: '🏠' });
  changeActor(state, ownerId, 'prestige', 2);
  stageMilestones(state, data, c);
  updateMaxStage(state);
  emitSignal(state, 'colony/founded', { colonyId: c.id, siteId: site.id, actorId: ownerId, stage, assetId: assetId || null, adopted: true });
  return { ok: true, colonyId: c.id };
}

/** A base module delivered to an adopted base raises one infrastructure need (same effect as invest, no cash). */
export function addInfra(state, data, colonyId, need, levels = 1) {
  const C = cfg(data);
  const c = colonyById(state, colonyId);
  if (!C || !c || c.status !== 'active' || !NEEDS.includes(need)) return false;
  c.infra[need] = clamp((c.infra?.[need] || 0) + Math.max(0, Math.round(Number(levels) || 0)), 0, C.tuning.infra.max);
  refresh(data, c);
  return true;
}

/** A shock to one need of a colony (infra.js: the base ran out of supply). */
export function applyShock(state, data, colonyId, need, delta) {
  const c = colonyById(state, colonyId);
  if (!cfg(data) || !c || !NEEDS.includes(need)) return false;
  c.shock = c.shock || {};
  c.shock[need] = clamp((c.shock[need] || 0) + (Number(delta) || 0), -80, 40);
  refresh(data, c);
  return true;
}

/** Send the founding convoy (or seed ship). Pays the cost. */
export function foundColony(state, data, actorId, siteId, { name } = {}) {
  const out = {};
  const why = foundCheck(state, data, actorId, siteId, out);
  if (why) return { ok: false, error: why };
  const C = cfg(data);
  const site = C.siteById[siteId];
  if (!budget.spend(state, actorId, out.costM, spendCat(), `Fundação: ${site.name}`.slice(0, 60))) return { ok: false, error: 'Caixa insuficiente.' };
  const s = slice(state);
  s.seq += 1;
  const nm = typeof name === 'string' && name.trim() ? name.trim().slice(0, 32) : colonyName(state, data, site, actorId);
  const t = { id: `col_${s.seq}`, siteId, ownerId: actorId, name: nm, departTurn: state.turn, arriveTurn: out.arriveTurn };
  s.transit.push(t);
  const stellar = isStellar(site);
  const vars = { owner: ownerName(state, actorId), site: site.name, place: site.place, ...preps(site), year: yearAt(state, t.arriveTurn) };
  news(state, data, stellar ? 'departedStar' : 'departed', vars, { importance: actorId === state.playerId ? 2 : 1, actors: [actorId], icon: stellar ? '🌌' : '🚀' });
  if (stellar) {
    const speed = C.tuning.ship.speedC[eraIdAt(state, data)] || 0.05;
    eventMilestones(state, data, 'interstellarLaunch', actorId, { speedC: speed });
  }
  emitSignal(state, 'colony/departed', { colonyId: t.id, siteId, actorId, arriveTurn: t.arriveTurn });
  return { ok: true, colonyId: t.id, arriveTurn: t.arriveTurn, costM: out.costM };
}

export function surveyCheck(state, data, siteId, out = {}) {
  const C = cfg(data);
  if (!C || !isActive(data)) return 'Esta partida não tem colônias.';
  const site = C.siteById[siteId];
  if (!site) return 'Local desconhecido.';
  const s = slice(state);
  const year = yearAt(state);
  out.costM = scaled(state, data, state.playerId, isStellar(site) ? C.tuning.survey.interstellarCostM : C.tuning.survey.costM);
  out.weeks = probeWeeks(state, data, site);
  if (year < unlockYear(data)) return `Colônias só a partir de ${unlockYear(data)}.`;
  if (isStellar(site) && year < (C.tuning.survey.interstellarFromYear ?? 2120)) return `Sondas interestelares só a partir de ${C.tuning.survey.interstellarFromYear ?? 2120}.`;
  if (s.surveys[siteId] != null) return 'Você já reconheceu esse local.';
  if (isStellar(site) && siteKnown(state, data, site)) return 'Essa estrela já foi sondada.';
  if (s.probes.some((p) => p.siteId === siteId)) return 'Já há uma sonda a caminho.';
  if (state.turn + out.weeks >= finalTurnOf(state)) return 'A sonda chegaria depois do fim da campanha.';
  if (!budget.canAfford(state, state.playerId, out.costM)) return `Caixa insuficiente: a sonda custa ${budget.fmtMoney(out.costM)}.`;
  return null;
}

export function launchSurvey(state, data, siteId) {
  const out = {};
  const why = surveyCheck(state, data, siteId, out);
  if (why) return { ok: false, error: why };
  const site = cfg(data).siteById[siteId];
  if (!budget.spend(state, state.playerId, out.costM, spendCat(), `Sonda de reconhecimento: ${site.name}`.slice(0, 60))) return { ok: false, error: 'Caixa insuficiente.' };
  const s = slice(state);
  s.probes.push({ siteId, ownerId: state.playerId, departTurn: state.turn, arriveTurn: state.turn + out.weeks });
  if (isStellar(site)) eventMilestones(state, data, 'probeLaunch', state.playerId);
  return { ok: true, arriveTurn: state.turn + out.weeks, costM: out.costM };
}

function arrive(state, data, t) {
  const C = cfg(data);
  const T = C.tuning;
  const site = C.siteById[t.siteId];
  const s = slice(state);
  const vars = { owner: ownerName(state, t.ownerId), site: site?.name, place: site?.place, ...preps(site), name: t.name };
  if (!site || !owner(state, t.ownerId)) {
    s.past.unshift({ name: t.name, place: site?.place || '?', year: yearAt(state), cause: 'perdida' });
    return;
  }
  const own = t.ownerId === state.playerId && s.surveys[site.id] != null;
  const p = clamp(T.found.success * (1 - (site.risk || 0) * (own ? T.survey.ownRiskMult : 1)), 0.05, 0.99);
  const ok = rngFor(state.seed, 'colonies', 'arrive', t.id).next() < p;
  if (!ok) {
    s.stats.lost += 1;
    s.past.unshift({ name: t.name, place: site.place, year: yearAt(state), cause: 'comboio perdido' });
    news(state, data, isStellar(site) ? 'convoyLostStar' : 'convoyLost', vars, { importance: t.ownerId === state.playerId ? 3 : 1, actors: [t.ownerId], icon: '💥' });
    if (t.ownerId === state.playerId) changeActor(state, t.ownerId, 'support', -2);
    emitSignal(state, 'colony/lost', { colonyId: t.id, siteId: site.id, actorId: t.ownerId, reason: 'convoy' });
    return;
  }
  const stellar = isStellar(site);
  const stage = stellar ? T.found.interstellarStage : 2;
  const base = stellar ? T.found.interstellarInfra : 0;
  const c = {
    id: t.id, name: t.name, siteId: site.id, kind: STAGE_KIND(stage), bodyId: site.mapBody || null, starId: site.starId || null,
    ownerId: t.ownerId, founderId: t.ownerId, stage, status: 'active',
    population: stellar ? T.found.interstellarPop : T.found.pop, foundedTurn: state.turn, stageTurn: state.turn,
    infra: { vida: base, energia: base, alimento: base, moradia: base }, shock: {},
    reserve: stellar ? T.route.interstellarReserve : T.route.startReserve, route: stellar ? 0 : 1, tax: 'leve', charter: false,
    opinion: T.opinion.start, welfare: 0, autonomy: 0, needs: {}, pending: [], project: null, done: [], card: null,
    indep: { resisted: 0, cooldownTurn: null }, govId: null, opBonus: 0, routeMult: 1, exportMult: 1, prestigeYear: 0,
  };
  refresh(data, c);
  s.list.push(c);
  s.stats.founded += 1;
  news(state, data, stellar ? 'foundedStar' : 'founded', vars, { importance: t.ownerId === state.playerId ? 3 : stellar ? 2 : 1, actors: [t.ownerId], icon: stellar ? '🌌' : '🏠' });
  changeActor(state, t.ownerId, 'prestige', stellar ? 6 : 2);
  if (stellar) {
    if (t.ownerId === state.playerId) explore(state, [site.starId]);
    eventMilestones(state, data, 'interstellarArrival', t.ownerId, { surface: /_surface$/.test(site.destination || '') });
  }
  stageMilestones(state, data, c);
  emitSignal(state, 'colony/founded', { colonyId: c.id, siteId: site.id, actorId: c.ownerId, stage });
}

function surveyArrive(state, data, p) {
  const C = cfg(data);
  const site = C.siteById[p.siteId];
  const s = slice(state);
  if (!site) return;
  if (s.surveys[site.id] == null) s.surveys[site.id] = state.turn;
  const years = Math.max(1, Math.round((state.turn - p.departTurn) / W));
  if (isStellar(site)) {
    explore(state, [site.starId]);
    eventMilestones(state, data, 'probeArrival', p.ownerId);
  }
  news(state, data, isStellar(site) ? 'surveyStar' : 'surveyDone', { owner: ownerName(state, p.ownerId), site: site.name, years }, { importance: isStellar(site) ? 2 : 1, actors: [p.ownerId], icon: '🔭' });
  emitSignal(state, 'colony/surveyed', { siteId: site.id, actorId: p.ownerId });
}

// ---------------------------------------------------------------------------------------------------------------
// Upgrades, investments, projects, policy
// ---------------------------------------------------------------------------------------------------------------

const colonyById = (state, id) => (state.colonies?.list || []).find((c) => c.id === id) || null;

/** Requirements for the next stage: {ok, reasons[], costM, auto, next}. */
export function upgradeCheck(state, data, c) {
  const C = cfg(data);
  const site = C.siteById[c?.siteId];
  const next = C.stages[(c?.stage || 0) + 1];
  const res = { ok: false, reasons: [], costM: 0, auto: false, next: next || null };
  if (!c || !next || !next.upgrade) { res.reasons.push(c?.stage >= 5 ? 'O último passo é político: a independência ou a aliança.' : 'Sem próximo estágio.'); return res; }
  if (c.status !== 'active') { res.reasons.push('A colônia não responde mais à agência.'); return res; }
  const u = next.upgrade;
  res.auto = !!u.auto;
  // in another star the colonists build it themselves: Earth sends plans, specialists and credit (35%)
  const T = C.tuning;
  const ai = c.ownerId !== state.playerId ? (isStellar(site) ? (T.ai.stellarCostMult ?? 0.25) : (T.ai.costMult ?? 1)) : 1;
  res.costM = u.auto ? 0 : Math.round(scaled(state, data, c.ownerId, (site?.costM || 500) * (u.costMult || 1) * (isStellar(site) ? 0.35 : 1)) * ai);
  const m = model(data, c, site);
  const years = (state.turn - (c.stageTurn ?? state.turn)) / W;
  if (next.n > (site?.maxStage ?? 6)) res.reasons.push(`${site?.place || 'Esse lugar'} não sustenta uma ${next.label.toLowerCase()}.`);
  if (years < (u.years || 0)) res.reasons.push(`Mais ${Math.ceil((u.years || 0) - years)} ano(s) neste estágio.`);
  if ((c.population || 0) < (u.pop || 0)) res.reasons.push(`População de ${u.pop} (hoje ${Math.floor(c.population || 0)}).`);
  if (u.autonomy != null && m.autonomy < u.autonomy) res.reasons.push(`Autossuficiência de ${Math.round(u.autonomy * 100)}% (hoje ${Math.round(m.autonomy * 100)}%).`);
  if (u.welfare != null && m.welfare < u.welfare) res.reasons.push(`Bem-estar ${u.welfare} (hoje ${Math.round(m.welfare)}).`);
  for (const [k, lv] of Object.entries(u.infra || {})) if ((c.infra?.[k] || 0) + (site?.bonus?.[k] || 0) < lv) res.reasons.push(`${needLabel(data, k)} nível ${lv}.`);
  if (!u.auto && res.costM > 0 && !budget.canAfford(state, c.ownerId, res.costM)) res.reasons.push(`Caixa para ${budget.fmtMoney(res.costM)}.`);
  res.ok = res.reasons.length === 0;
  return res;
}
const needLabel = (data, k) => cfg(data)?.needs?.find((n) => n.id === k)?.label || k;

function setStage(state, data, c, n, { quiet = false } = {}) {
  const C = cfg(data);
  c.stage = n;
  c.stageTurn = state.turn;
  c.kind = STAGE_KIND(n);
  refresh(data, c);
  const site = C.siteById[c.siteId];
  if (!quiet) {
    const st = C.stages[n];
    news(state, data, n === 5 ? 'cityState' : 'stageUp', { name: c.name, place: site?.place, stage: st?.label?.toLowerCase() }, { importance: c.ownerId === state.playerId ? 3 : 1, actors: [c.ownerId], icon: '🏙️' });
  }
  stageMilestones(state, data, c);
  updateMaxStage(state);
  emitSignal(state, 'colony/stage', { colonyId: c.id, actorId: c.ownerId, stage: n });
}

export function upgradeColony(state, data, c) {
  const chk = upgradeCheck(state, data, c);
  if (!chk.ok) return { ok: false, error: chk.reasons[0] || 'Ainda não.' };
  if (chk.auto) return { ok: false, error: 'Esse passo acontece sozinho quando a colônia estiver pronta.' };
  if (chk.costM > 0 && !budget.spend(state, c.ownerId, chk.costM, spendCat(), `${c.name}: ${chk.next.label}`.slice(0, 60))) return { ok: false, error: 'Caixa insuficiente.' };
  setStage(state, data, c, chk.next.n);
  return { ok: true, stage: c.stage, costM: chk.costM };
}

/** Cost of the next level of one need's infrastructure. */
export function investCost(state, data, c, need) {
  const t = cfg(data).tuning.infra;
  const lv = c?.infra?.[need] || 0;
  const pend = arr(c?.pending).filter((p) => p.need === need).length;
  return scaled(state, data, c?.ownerId, t.costM * (1 + t.levelMult * (lv + pend)) * (1 + 0.25 * Math.max(0, (c?.stage || 2) - 2)));
}
/** Weeks until an investment takes effect (stellar colonies: the plans travel at the speed of light). */
export function investWeeks(data, c) {
  const C = cfg(data);
  const site = C.siteById[c?.siteId];
  return isStellar(site) ? Math.ceil((Number(site.ly) || 4) * W) + C.tuning.infra.weeks : C.tuning.infra.weeks;
}

export function invest(state, data, c, need) {
  const C = cfg(data);
  if (!c || c.status !== 'active') return { ok: false, error: 'Colônia indisponível.' };
  if (!NEEDS.includes(need)) return { ok: false, error: 'Necessidade desconhecida.' };
  const lv = (c.infra?.[need] || 0) + arr(c.pending).filter((p) => p.need === need).length;
  if (lv >= C.tuning.infra.max) return { ok: false, error: 'Esse sistema já está no nível máximo.' };
  if (arr(c.pending).length >= 4) return { ok: false, error: 'Já há obras demais em andamento.' };
  const cost = investCost(state, data, c, need);
  if (!budget.spend(state, c.ownerId, cost, spendCat(), `${c.name}: ${needLabel(data, need)}`.slice(0, 60))) return { ok: false, error: `Caixa insuficiente: custa ${budget.fmtMoney(cost)}.` };
  const turn = state.turn + investWeeks(data, c);
  c.pending = [...arr(c.pending), { need, turn }];
  return { ok: true, costM: cost, readyTurn: turn };
}

export function setRoute(state, data, c, level) {
  const C = cfg(data);
  const site = C.siteById[c?.siteId];
  if (!c || c.status !== 'active') return { ok: false, error: 'Colônia indisponível.' };
  if (isStellar(site)) return { ok: false, error: 'Não há linha de suprimento entre estrelas: a colônia vive do que tem.' };
  const lv = Math.round(Number(level));
  if (!(lv >= 0 && lv <= C.tuning.route.maxLevel)) return { ok: false, error: 'Nível de rota inválido.' };
  c.route = lv;
  return { ok: true, route: lv, yearlyM: routeCost(state, data, c) };
}

export function setTax(state, data, c, tax) {
  const T = cfg(data).tuning;
  if (!c || c.status !== 'active') return { ok: false, error: 'Colônia indisponível.' };
  if (!T.tax[tax]) return { ok: false, error: 'Imposto inválido.' };
  if (c.charter && tax !== 'leve') return { ok: false, error: 'A carta de autonomia limita o imposto ao leve.' };
  c.tax = tax;
  return { ok: true, tax };
}

export function projectCheck(state, data, c, pid, out = {}) {
  const C = cfg(data);
  const p = C.projectById[pid];
  if (!p) return 'Projeto desconhecido.';
  const site = C.siteById[c?.siteId];
  out.costM = scaled(state, data, c?.ownerId, p.costM);
  if (!c || c.status !== 'active') return 'Colônia indisponível.';
  if (c.project) return 'Já há um grande projeto em andamento.';
  if (arr(c.done).includes(pid)) return 'Projeto já concluído.';
  if (c.stage < (p.minStage || 1)) return `Precisa de uma colônia no estágio ${p.minStage}.`;
  if (yearAt(state) < (p.fromYear || 0)) return `Só a partir de ${p.fromYear}.`;
  if (p.regions && !p.regions.includes(site?.region)) return 'Não serve para esse lugar.';
  if (p.bodies && !p.bodies.includes(site?.body)) return 'Não serve para esse lugar.';
  if (!budget.canAfford(state, c.ownerId, out.costM)) return `Caixa insuficiente: custa ${budget.fmtMoney(out.costM)}.`;
  return null;
}

export function startProject(state, data, c, pid) {
  const out = {};
  const why = projectCheck(state, data, c, pid, out);
  if (why) return { ok: false, error: why };
  const p = cfg(data).projectById[pid];
  if (!budget.spend(state, c.ownerId, out.costM, spendCat(), `${c.name}: ${p.label}`.slice(0, 60))) return { ok: false, error: 'Caixa insuficiente.' };
  c.project = { id: pid, startTurn: state.turn, doneTurn: state.turn + Math.round((p.years || 5) * W) };
  news(state, data, 'projectStart', { owner: ownerName(state, c.ownerId), project: p.label, name: c.name }, { importance: 2, actors: [c.ownerId], icon: '🏗️', text: p.startText || null });
  if (p.startMilestone) claim(state, data, p.startMilestone, c.ownerId, cfg(data).rules.find((r) => r.milestone === p.startMilestone)?.label || p.label);
  return { ok: true, doneTurn: c.project.doneTurn, costM: out.costM };
}

function finishProject(state, data, c) {
  const C = cfg(data);
  const p = C.projectById[c.project?.id];
  c.project = null;
  if (!p) return;
  c.done = [...arr(c.done), p.id];
  const e = p.effect || {};
  for (const [k, v] of Object.entries(e.infra || {})) c.infra[k] = clamp((c.infra[k] || 0) + v, 0, C.tuning.infra.max);
  if (e.opinion) c.opBonus = (c.opBonus || 0) + e.opinion;
  if (e.routeMult) c.routeMult = r2((c.routeMult || 1) * e.routeMult);
  if (e.exportMult) c.exportMult = r2((c.exportMult || 1) * e.exportMult);
  if (e.prestigeYear) c.prestigeYear = r2((c.prestigeYear || 0) + e.prestigeYear);
  news(state, data, 'projectDone', { project: p.label, name: c.name }, { importance: 2, actors: [c.ownerId], icon: '🏗️', text: p.doneText || null });
  if (p.milestone) claim(state, data, p.milestone, c.ownerId, C.rules.find((r) => r.milestone === p.milestone)?.label || p.label);
  refresh(data, c);
}

/** Evacuate (player decision): colonists come home, the colony leaves the list. */
export function abandon(state, data, c, cause = 'evacuada') {
  const s = slice(state);
  const site = cfg(data).siteById[c.siteId];
  s.list = s.list.filter((x) => x !== c);
  s.past.unshift({ name: c.name, place: site?.place || '?', year: yearAt(state), cause });
  if (s.past.length > 12) s.past.length = 12;
  if (c.card) removeDecision(state, c.card);
  emitSignal(state, 'colony/lost', { colonyId: c.id, actorId: c.ownerId, reason: cause });
}

// ---------------------------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------------------------

export function routeCost(state, data, c) {
  const site = cfg(data).siteById[c?.siteId];
  return scaled(state, data, c?.ownerId, (c?.route || 0) * (site?.routeM || 0) * (c?.routeMult || 1));
}
export function upkeepCost(state, data, c) {
  const C = cfg(data);
  const st = C.stages[c?.stage];
  if (!st || c.status !== 'active') return 0;
  const m = model(data, c);
  const p = c.project ? C.projectById[c.project.id] : null;
  return scaled(state, data, c.ownerId, (st.upkeepM || 0) * (1 - 0.7 * m.autonomy)) + routeCost(state, data, c) + scaled(state, data, c.ownerId, p?.yearlyM || 0);
}
/** Yearly income of the colony's owner (taxes on exports; allies pay a trade share). */
export function incomeOf(data, c) {
  const C = cfg(data);
  const st = C.stages[c?.stage];
  const site = C.siteById[c?.siteId];
  if (!st || !(st.exportM > 0)) return 0;
  const value = st.exportM * (site?.value || 1) * (c.exportMult || 1) * ((c.welfare ?? 60) / 100);
  if (c.status === 'allied') return Math.round(value * C.tuning.independence.alliedShare);
  if (c.status !== 'active') return 0;
  const tax = C.tuning.tax[c.charter ? 'leve' : c.tax] || C.tuning.tax.media;
  return Math.round(value * tax.rate);
}

// ---------------------------------------------------------------------------------------------------------------
// Effects (events)
// ---------------------------------------------------------------------------------------------------------------

function applyEffects(state, data, c, eff = {}, { pay = true } = {}) {
  const C = cfg(data);
  const T = C.tuning;
  if (eff.cashM) {
    const m = scaled(state, data, c.ownerId, Math.abs(eff.cashM));
    if (eff.cashM < 0 && pay) budget.spend(state, c.ownerId, m, spendCat(), `${c.name}: emergência`.slice(0, 60));
    else if (eff.cashM > 0) budget.earn(state, c.ownerId, m, incomeCat(), `${c.name}`.slice(0, 60));
  }
  if (eff.pop) c.population = r2(Math.max(0, (c.population || 0) * (1 + eff.pop)));
  if (eff.opinion) c.opinion = clamp((c.opinion || 50) + eff.opinion, 0, 100);
  for (const [k, v] of Object.entries(eff.shock || {})) if (NEEDS.includes(k)) c.shock[k] = clamp((c.shock[k] || 0) + v, -80, 40);
  for (const [k, v] of Object.entries(eff.infra || {})) if (NEEDS.includes(k)) c.infra[k] = clamp((c.infra[k] || 0) + v, 0, T.infra.max);
  if (eff.reserve) c.reserve = clamp((c.reserve || 0) + eff.reserve, 0, isStellar(C.siteById[c.siteId]) ? T.route.interstellarReserve : T.route.reserveMax);
  for (const k of ['prestige', 'support', 'reputation']) if (eff[k]) changeActor(state, c.ownerId, k, eff[k]);
  if (eff.charter) { c.charter = true; c.tax = 'leve'; }
  refresh(data, c);
}

function eventFits(state, data, ev, c) {
  const w = ev.when || {};
  const C = cfg(data);
  const site = C.siteById[c.siteId];
  const year = yearAt(state);
  if (ev.once && state.colonies.once[ev.id]) return false;
  if (w.stages && (c.stage < w.stages[0] || c.stage > w.stages[1])) return false;
  if (w.tags && !w.tags.some((tg) => arr(site?.tags).includes(tg))) return false;
  if (w.interstellar != null && w.interstellar !== isStellar(site)) return false;
  if (w.route === 'some' && !(c.route > 0)) return false;
  if (w.fromYear != null && year < w.fromYear) return false;
  if (w.toYear != null && year > w.toYear) return false;
  if (w.opinionBelow != null && !(c.opinion < w.opinionBelow)) return false;
  if (w.opinionAbove != null && !(c.opinion > w.opinionAbove)) return false;
  if (w.welfareBelow != null && !(c.welfare < w.welfareBelow)) return false;
  if (w.welfareAbove != null && !(c.welfare > w.welfareAbove)) return false;
  if (w.popAbove != null && !(c.population > w.popAbove)) return false;
  for (const [k, v] of Object.entries(w.needBelow || {})) if (!((c.needs?.[k] ?? 100) < v)) return false;
  return true;
}

function choicePreview(state, data, c, ch) {
  const cost = ch.effects?.cashM < 0 ? scaled(state, data, c.ownerId, -ch.effects.cashM) : 0;
  return [ch.preview || '', cost ? `Custa ${budget.fmtMoney(cost)}.` : ''].filter(Boolean).join(' ');
}

function pushCrisis(state, data, ctx, c, ev) {
  const C = cfg(data);
  const vars = { name: c.name, place: C.siteById[c.siteId]?.place };
  const choices = arr(ev.choices).map((ch) => {
    const cost = ch.effects?.cashM < 0 ? scaled(state, data, c.ownerId, -ch.effects.cashM) : 0;
    const poor = cost > 0 && !budget.canAfford(state, c.ownerId, cost);
    return { id: ch.id, label: ch.label, preview: choicePreview(state, data, c, ch), ...(poor ? { disabled: true, reason: 'Caixa insuficiente.' } : {}) };
  });
  const def = arr(ev.choices).find((ch) => ch.default)?.id || choices[choices.length - 1]?.id;
  const d = pushDecision(state, {
    kind: 'colonies/crisis', title: fill(ev.title, vars), body: fill(ev.body, vars), choices, urgency: 2, blocking: false,
    expiresTurn: expiryIn(ctx, C.tuning.events.expiryWeeks), defaultChoice: def, payload: { colonyId: c.id, eventId: ev.id },
  });
  c.card = d.id;
  if (ev.once) state.colonies.once[ev.id] = true;
}

function resolveEvent(state, data, c, ev, choiceId, label) {
  const ch = arr(ev.choices).find((x) => x.id === choiceId) || arr(ev.choices).find((x) => x.default) || arr(ev.choices)[0];
  if (!ch) return { ok: true };
  applyEffects(state, data, c, ch.effects);
  let text = null;
  if (ch.gamble) {
    const ok = rngFor(state.seed, 'colonies', 'gamble', c.id, ev.id, label || state.turn).next() < (ch.gamble.p ?? 0.5);
    if (ok) { if (ch.gamble.success) applyEffects(state, data, c, ch.gamble.success); } else {
      applyEffects(state, data, c, ch.gamble.fail);
      text = fill(ch.gamble.failText, { name: c.name });
      if (text && c.ownerId === state.playerId) addNews(state, { headline: text, tags: ['colony', 'colony_crisis'], actors: [c.ownerId], importance: 2, icon: '⚠️' });
    }
  }
  if (ev.milestone) claim(state, data, ev.milestone, c.ownerId, cfg(data).rules.find((r) => r.milestone === ev.milestone)?.label || fill(ev.title, { name: c.name }));
  return { ok: true, outcome: text };
}

// ---------------------------------------------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------------------------------------------

function becomeSovereign(state, data, c, outcome, { forced = false } = {}) {
  const s = slice(state);
  const C = cfg(data);
  const prev = c.ownerId;
  c.stage = 6;
  c.stageTurn = state.turn;
  c.kind = 'colony';
  c.outcome = outcome;
  if (c.card) { removeDecision(state, c.card); c.card = null; }
  if (outcome === 'allied') {
    c.status = 'allied';
    news(state, data, 'allied', { name: c.name, owner: ownerName(state, prev) }, { importance: 3, actors: [prev], icon: '🤝' });
    changeActor(state, prev, 'prestige', 4);
  } else {
    c.status = 'independent';
    c.ownerId = c.govId && state.actors?.[c.govId] ? c.govId : null;
    c.route = 0;
    c.project = null;
    news(state, data, forced ? 'forced' : 'independent', { name: c.name, owner: ownerName(state, prev) }, { importance: 3, actors: [prev], icon: '🗽' });
    if (forced) { changeActor(state, prev, 'reputation', -5); changeActor(state, prev, 'support', -2); } else { changeActor(state, prev, 'reputation', 3); changeActor(state, prev, 'prestige', 3); }
    const r = C.rules.find((x) => x.outcome === 'independent');
    if (r) claim(state, data, r.milestone, prev, r.label);
  }
  s.stats.sovereign += 1;
  emitSignal(state, 'colony/sovereign', { colonyId: c.id, actorId: prev, outcome, forced });
}

function independenceDue(state, data, c) {
  const T = cfg(data).tuning.independence;
  if (c.status !== 'active' || c.stage < T.minStage) return false;
  if (c.indep?.cooldownTurn != null && state.turn < c.indep.cooldownTurn) return false;
  const years = (state.turn - (c.stageTurn ?? state.turn)) / W;
  return c.opinion < T.opinionBelow || (c.autonomy >= T.autonomyAbove && years >= T.yearsAtStage);
}

function pushIndependence(state, data, ctx, c) {
  const T = cfg(data).tuning.independence;
  const alliedMin = T.alliedOpinion - (c.charter ? 10 : 0);
  const choices = [
    { id: 'aliada', label: 'Negociar uma aliança', preview: `A colônia vira um mundo soberano aliado: você mantém ${Math.round(T.alliedShare * 100)}% das trocas e o prestígio.`,
      ...(c.opinion < alliedMin ? { disabled: true, reason: `Precisa de opinião ${alliedMin} ou mais (hoje ${Math.round(c.opinion)}).` } : {}) },
    { id: 'independente', label: 'Reconhecer a independência', preview: 'Sem renda da colônia; a agência ganha reputação e um vizinho grato.' },
    { id: 'adiar', label: 'Adiar o referendo', preview: 'A opinião cai muito e, se cair mais, eles rompem sozinhos.',
      ...(c.indep?.resisted >= 1 ? { disabled: true, reason: 'Você já adiou uma vez.' } : {}) },
  ];
  const d = pushDecision(state, {
    kind: 'colonies/independence', title: `${c.name} quer decidir o próprio destino`,
    body: `A cidade-estado de ${Math.floor(c.population).toLocaleString('pt-BR')} habitantes pede um referendo. Opinião sobre a agência: ${Math.round(c.opinion)}.`,
    choices, urgency: 3, blocking: false, expiresTurn: expiryIn(ctx, 13), defaultChoice: 'independente', payload: { colonyId: c.id },
  });
  c.card = d.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Continuous update (each tick)
// ---------------------------------------------------------------------------------------------------------------

function evolve(state, data, ctx, c) {
  const C = cfg(data);
  const T = C.tuning;
  const site = C.siteById[c.siteId];
  const st = C.stages[c.stage] || C.stages[2];
  const dt = ctx.dt || 1;
  const y = dt / W;
  // obras que ficaram prontas
  if (arr(c.pending).length) {
    const left = [];
    for (const p of c.pending) {
      if (dueIn(ctx, p.turn)) c.infra[p.need] = clamp((c.infra[p.need] || 0) + 1, 0, T.infra.max);
      else left.push(p);
    }
    c.pending = left;
  }
  if (c.project && dueIn(ctx, c.project.doneTurn)) finishProject(state, data, c);
  // choques passam (metade por ano)
  for (const k of Object.keys(c.shock || {})) {
    c.shock[k] = r2(decay(c.shock[k], 0.5 ** (1 / W), ctx));
    if (Math.abs(c.shock[k]) < 0.5) delete c.shock[k];
  }
  let m = model(data, c, site);
  // reserva: a rota cobre a parte importada; a diferença enche ou esvazia o estoque
  if (c.status === 'active') {
    const max = isStellar(site) ? T.route.interstellarReserve : T.route.reserveMax;
    const net = m.importNeed <= 0.001 ? 1 : clamp((m.capacity - m.importNeed) / Math.max(m.importNeed, 0.1), -1, 1);
    c.reserve = r2(clamp((c.reserve || 0) + net * dt, 0, max));
    m = model(data, c, site);
  }
  // população
  const pop = c.population || 0;
  const cap = m.housing;
  let r = st.natural || 0;
  if (c.status === 'active' && !isStellar(site) && c.route > 0 && m.welfare >= 50 && c.stage <= 5) r += T.pop.immigration * (c.route / T.route.maxLevel) * (c.stage <= 4 ? 1 : 0.5);
  if (m.welfare < T.pop.lowWelfare) r -= ((T.pop.lowWelfare - m.welfare) / 100) * 0.5 + T.pop.decline;
  if (m.needs.vida < 25) r -= 0.1;
  let next = pop;
  if (c.stage === 2 && c.status === 'active') {
    // posto avançado: tripulação em rodízio, cresce enquanto houver rota e lugar
    if (r >= 0 && pop < cap) next = Math.min(cap, pop + T.pop.outpostCrewPerYear * y * (c.route > 0 ? 1 : 0.25));
    else if (r < 0) next = pop * (1 + r * y);
  } else if (r > 0) next = pop + pop * r * y * Math.max(0, 1 - pop / Math.max(1, cap));
  else next = pop + pop * r * y;
  c.population = r2(Math.max(0, next));
  // opinião
  const target = opinionTarget(data, c, m);
  const keep = (T.opinion.weeklyPull ?? 0.985) ** dt;
  c.opinion = r2(target + ((c.opinion ?? target) - target) * keep);
  refresh(data, c);
}

// ---------------------------------------------------------------------------------------------------------------
// Yearly
// ---------------------------------------------------------------------------------------------------------------

function yearMoney(state, data) {
  const s = slice(state);
  const by = new Map();
  for (const c of s.list) {
    if (!c.ownerId || !owner(state, c.ownerId) || !(c.status === 'active' || c.status === 'allied')) continue;
    const e = by.get(c.ownerId) || { cost: 0, income: 0, cols: [] };
    e.cost += upkeepCost(state, data, c);
    e.income += incomeOf(data, c);
    e.cols.push(c);
    by.set(c.ownerId, e);
  }
  for (const [id, e] of by) {
    if (e.income > 0) budget.earn(state, id, e.income, incomeCat(), 'Colônias: impostos e trocas');
    if (e.cost <= 0) continue;
    if (budget.spend(state, id, e.cost, spendCat(), 'Colônias: operação e rotas')) continue;
    // sem dinheiro: as rotas encolhem um nível e a colônia sente o atraso
    for (const c of e.cols) {
      if (c.route > 0) {
        c.route -= 1;
        if (id === state.playerId) news(state, data, 'routeCut', { owner: ownerName(state, id), name: c.name }, { importance: 2, actors: [id], icon: '📉' });
      }
      c.opinion = clamp((c.opinion || 50) - 8, 0, 100);
    }
    const again = e.cols.reduce((a, c) => a + upkeepCost(state, data, c), 0);
    budget.spend(state, id, again, spendCat(), 'Colônias: operação reduzida');
  }
}

function yearColony(state, data, ctx, c, openCards) {
  const C = cfg(data);
  const T = C.tuning;
  const site = C.siteById[c.siteId];
  const s = slice(state);
  const year = yearAt(state);
  const player = c.ownerId === state.playerId;
  if (c.status === 'independent') return openCards;
  // prestígio de manter gente viva longe de casa
  if (owner(state, c.ownerId)) changeActor(state, c.ownerId, 'prestige', T.prestigePerStageYear * Math.max(0, c.stage - 1) + (c.prestigeYear || 0));
  if (c.status !== 'active') return openCards;
  // colapso
  if ((c.population || 0) < 1) {
    news(state, data, 'lost', { name: c.name, place: site?.place, ...preps(site) }, { importance: player ? 3 : 1, actors: [c.ownerId], icon: '🕯️' });
    s.stats.lost += 1;
    if (player) changeActor(state, c.ownerId, 'support', -3);
    abandon(state, data, c, 'colapso');
    return openCards;
  }
  // cidade-estado chega sozinha
  const next = C.stages[c.stage + 1];
  if (next?.upgrade?.auto && upgradeCheck(state, data, c).ok) setStage(state, data, c, next.n);
  // perda de carga na rota
  if (!isStellar(site) && c.route > 0) {
    const p = T.route.lossPerYear * ((site?.risk || 0.08) / 0.08);
    if (rngFor(state.seed, 'colonies', 'routeLoss', c.id, year).next() < p) {
      c.reserve = Math.max(0, (c.reserve || 0) - T.route.lossWeeks);
      if (player && c.reserve < 13) news(state, data, 'routeLoss', { name: c.name }, { importance: 1, actors: [c.ownerId], icon: '📦' });
    }
  }
  // independência
  if (independenceDue(state, data, c) && rngFor(state.seed, 'colonies', 'indep', c.id, year).next() < T.independence.chancePerYear) {
    if (c.indep?.resisted >= 1 && c.opinion < T.independence.forcedOpinion) becomeSovereign(state, data, c, 'independent', { forced: true });
    else if (player) { if (!c.card) { pushIndependence(state, data, ctx, c); openCards += 1; } } else becomeSovereign(state, data, c, c.opinion >= T.independence.alliedOpinion ? 'allied' : 'independent');
    return openCards;
  }
  // crises e acontecimentos
  if (c.card && !(state.decisions || []).some((d) => d.id === c.card)) c.card = null;
  if (c.card || c.stage < 2) return openCards;
  if (player && openCards >= T.events.maxOpenCards) return openCards;
  const rng = rngFor(state.seed, 'colonies', 'event', c.id, year);
  const p = T.events.basePerYear + (c.welfare < 50 ? T.events.lowWelfare : 0);
  if (rng.next() >= p) return openCards;
  // the player does not see the same card again for a few years (on any of their colonies): variety over 950 years
  const rep = T.events.repeatYears ?? 0;
  const fresh = (e) => !player || !(rep > 0) || !(year - (s.recent[e.id] ?? -Infinity) < rep);
  const ev = rng.weighted(C.events.filter((e) => fresh(e) && eventFits(state, data, e, c)), (e) => e.weight ?? 1);
  if (!ev) return openCards;
  if (player) { s.recent[ev.id] = year; pushCrisis(state, data, ctx, c, ev); return openCards + 1; }
  if (ev.once) s.once[ev.id] = true;
  resolveEvent(state, data, c, ev, null, `ai${year}`);
  return openCards;
}

/** Rivals run their colonies on a simple rule: steady route, cheapest missing system, next stage when they can. */
function aiManage(state, data, c) {
  const T = cfg(data).tuning;
  const site = cfg(data).siteById[c.siteId];
  if (c.status !== 'active' || c.ownerId === state.playerId || !owner(state, c.ownerId)) return;
  if (!isStellar(site)) c.route = T.ai.routeLevel;
  c.tax = 'media';
  const cash = owner(state, c.ownerId).cash || 0;
  // the imported system furthest behind first (self-sufficiency), then housing when it gets crowded
  const eff = (k) => (c.infra?.[k] || 0) + (site?.bonus?.[k] || 0) + arr(c.pending).filter((p) => p.need === k).length;
  let need = (c.autonomy ?? 0) < 0.999 ? IMPORTED.slice().sort((a, b) => eff(a) - eff(b))[0] : null;
  if ((c.needs?.moradia ?? 100) < 85 && (!need || eff('moradia') < eff(need))) need = 'moradia';
  if (need && eff(need) < T.infra.max) {
    const cost = investCost(state, data, c, need);
    if (cash > cost * T.ai.investCashMult) invest(state, data, c, need);
  }
  const up = upgradeCheck(state, data, c);
  if (up.ok && !up.auto && (owner(state, c.ownerId).cash || 0) > up.costM * 1.5) upgradeColony(state, data, c);
}

function aiFound(state, data, year) {
  const C = cfg(data);
  const T = C.tuning;
  const s = slice(state);
  const aiCount = s.list.filter((c) => c.ownerId && c.ownerId !== state.playerId && c.status === 'active').length + s.transit.filter((t) => t.ownerId !== state.playerId).length;
  if (aiCount >= T.caps.ai) return;
  const eraF = { e5: 1, e6: 1.2, e7: 1.4 }[eraIdAt(state, data)] || 1;
  for (const id of Object.keys(state.actors || {})) {
    if (id === state.playerId) continue;
    const a = state.actors[id];
    if ((a.tier || 'core') !== 'core' || a.kind === 'colony' || !((a.budget || 0) >= T.ai.minBudgetM)) continue;
    const rng = rngFor(state.seed, 'colonies', 'aiFound', id, year);
    if (rng.next() >= T.ai.foundPerYear * eraF * clamp((a.budget || 0) / 2000, 0.5, 2)) continue;
    const cands = C.sites.filter((site) => !foundCheck(state, data, id, site.id));
    // beyond 2200 the rivals look to other stars: a seed ship weighs as much as a dozen local outposts
    const deep = eraF > 1;
    const site = rng.weighted(cands, (x) => ((x.value || 1) / Math.max(1, x.costM)) * 1000 * (deep && isStellar(x) ? 25 : 1));
    if (site) foundColony(state, data, id, site.id);
    return; // at most one new rival colony per year
  }
}

function frontierYear(state, data) {
  const C = cfg(data);
  const F = C.frontier;
  const s = slice(state);
  const fr = s.frontier;
  const stellar = s.list.filter((c) => c.starId && SETTLED.has(c.status) && c.stage >= (F.startStage || 4));
  const inhabited = s.list.filter((c) => SETTLED.has(c.status) && c.stage >= 2).length;
  if (stellar.length) {
    const far = Math.max(...stellar.map((c) => Number(C.siteById[c.siteId]?.ly) || 0));
    const before = Math.max(fr.reachLy || 0, far);
    const rate = F.lyPerYear?.[eraIdAt(state, data)] || 0;
    const cities = stellar.filter((c) => c.stage >= 5).length;
    fr.reachLy = r2(before + rate * Math.min(1, stellar.length / 2));
    fr.extra = r2((fr.extra || 0) + (F.worldsPerLy || 0) * (fr.reachLy - before) + (F.worldsPerCityYear || 0) * cities);
    const ranked = stellar.slice().sort((a, b) => (b.stage - a.stage) || ((b.population || 0) - (a.population || 0)));
    const lead = ranked[0];
    const alive = (id) => (id && state.actors?.[id] ? id : null);
    const leadOwner = ranked.reduce((o, c) => o || alive(c.ownerId) || alive(c.founderId), null) || lead.ownerId || lead.founderId;
    for (const r of F.regions || []) {
      if (fr.nodes.includes(r.id) || fr.reachLy < r.d) continue;
      fr.nodes.push(r.id);
      s.list.push({ id: `node_${r.id}`, name: r.name, kind: 'colony', regionId: r.id, ownerId: lead.ownerId || null, founderId: leadOwner, stage: 5, status: 'node', population: null, foundedTurn: state.turn });
      news(state, data, 'frontier', { region: r.name, a: r.a || `a ${r.name}` },{ importance: 2, actors: [leadOwner], icon: '🌌' });
    }
    for (const rule of C.rules) if (rule.reachLy != null && fr.reachLy >= rule.reachLy) claim(state, data, rule.milestone, leadOwner, rule.label);
  }
  fr.worlds = inhabited + Math.floor(fr.extra || 0);
  // marcos por dono: estrelas distintas e mundos
  const byOwner = new Map();
  for (const c of s.list) {
    if (!c.starId || !SETTLED.has(c.status)) continue;
    const o = c.founderId || c.ownerId;
    if (!byOwner.has(o)) byOwner.set(o, new Set());
    byOwner.get(o).add(c.starId);
  }
  for (const rule of C.rules) {
    if (rule.stars != null) for (const [o, set] of byOwner) if (set.size >= rule.stars) claim(state, data, rule.milestone, o, rule.label);
    if (rule.worlds != null && fr.worlds >= rule.worlds) {
      const lead = s.list.filter((c) => SETTLED.has(c.status) && (state.actors?.[c.ownerId] || state.actors?.[c.founderId])).sort((a, b) => (b.population || 0) - (a.population || 0))[0];
      if (lead) claim(state, data, rule.milestone, state.actors?.[lead.ownerId] ? lead.ownerId : lead.founderId, rule.label);
    }
  }
}

function updateMaxStage(state) {
  const s = state.colonies;
  s.maxStage = s.list.reduce((m, c) => (SETTLED.has(c.status) ? Math.max(m, c.stage || 0) : m), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init() { /* the slice appears in the colonies' unlock year (§2.1 unlocks.colonies) */ }

export function tick(state, data, ctx) {
  if (state.gameOver || !isActive(data)) return;
  if (!state.colonies && yearAt(state) < unlockYear(data)) return;
  const s = slice(state);
  const C = cfg(data);
  // reconhecimento próprio: missões do jogador que chegaram bem aos destinos dos locais
  for (const sg of arr(state.signals)) {
    if (sg?.type === 'mission/resolved' && sg.actorId === state.playerId && sg.final !== false && (sg.outcome === 'total' || sg.outcome === 'partial')) {
      for (const site of C.sites) if (s.surveys[site.id] == null && arr(site.surveyBy).includes(sg.destination)) s.surveys[site.id] = state.turn;
    }
    // um governo colonial nasce (lifecycle, arquétipo colony_gov): ele representa a colônia soberana sem governo
    if (sg?.type === 'actor/born' && state.actors?.[sg.actorId]?.archetype === 'colony_gov') {
      const c = s.list.filter((x) => !x.govId && x.status !== 'node' && x.stage >= 5).sort((a, b) => (a.status === 'independent' ? -1 : 0) - (b.status === 'independent' ? -1 : 0) || (b.population || 0) - (a.population || 0))[0];
      if (c) { c.govId = sg.actorId; if (c.status === 'independent' && !c.ownerId) c.ownerId = sg.actorId; }
    }
  }
  if (s.probes.length) {
    const left = [];
    for (const p of s.probes) (dueIn(ctx, p.arriveTurn) ? surveyArrive(state, data, p) : left.push(p));
    s.probes = left;
  }
  if (s.transit.length) {
    const left = [];
    for (const t of s.transit) (dueIn(ctx, t.arriveTurn) ? arrive(state, data, t) : left.push(t));
    s.transit = left;
  }
  for (const c of s.list) if (c.status !== 'node') evolve(state, data, ctx, c);
  updateMaxStage(state);
}

export function onYear(state, data, ctx) {
  if (state.gameOver || !isActive(data) || !state.colonies) return;
  const s = slice(state);
  const year = yearAt(state);
  yearMoney(state, data);
  let open = (state.decisions || []).filter((d) => String(d.kind).startsWith('colonies/')).length;
  for (const c of s.list.slice()) {
    if (c.status === 'node') continue;
    open = yearColony(state, data, ctx, c, open);
    aiManage(state, data, c);
  }
  if (year >= unlockYear(data)) aiFound(state, data, year);
  frontierYear(state, data);
  updateMaxStage(state);
}

export function compact(state, data) {
  const s = state.colonies;
  if (!s) return;
  if (s.past.length > 12) s.past.length = 12;
  if (isObj(s.recent)) {
    const rep = cfg(data)?.tuning?.events?.repeatYears ?? 0;
    const y = yearAt(state);
    for (const [k, v] of Object.entries(s.recent)) if (!(y - v < rep)) delete s.recent[k];
  }
  const cap = cfg(data)?.tuning?.caps?.list ?? 40;
  if (s.list.length > cap) {
    // keep everything the player has and the biggest worlds; nodes count as worlds
    const keep = s.list.slice().sort((a, b) => ((b.ownerId === state.playerId) - (a.ownerId === state.playerId)) || ((b.population || 0) - (a.population || 0))).slice(0, cap);
    s.list = s.list.filter((c) => keep.includes(c));
  }
  for (const c of s.list) {
    if (c.status === 'node') continue;
    if (c.status === 'independent') { c.pending = []; c.shock = {}; c.project = null; }
    if (c.card && !(state.decisions || []).some((d) => d.id === c.card)) c.card = null;
  }
}

/** Arrivals of the player's convoys and probes truncate the step (they are the player's appointments). */
export function appointments(state) {
  const s = state?.colonies;
  if (!s) return [];
  const pid = state.playerId;
  return [...arr(s.transit).filter((t) => t.ownerId === pid).map((t) => t.arriveTurn), ...arr(s.probes).map((p) => p.arriveTurn)];
}

/** An owner left the world: its colonies go to the survivor, or govern themselves (stage ≥ 4), or are evacuated. */
export function onActorGone(state, data, ctx, id, info = {}) {
  const s = state.colonies;
  if (!s || !isActive(data)) return;
  const into = info?.into && state.actors?.[info.into] ? info.into : null;
  // the name for the news: the actor may already be gone from state.actors (lifecycle keeps a tombstone)
  const tomb = state.lifecycle?.tombstones?.[id];
  const goneName = info?.name || state.actors?.[id]?.short || state.actors?.[id]?.name || tomb?.short || tomb?.name || 'antiga dona';
  s.transit = arr(s.transit).filter((t) => {
    if (t.ownerId !== id) return true;
    if (into) { t.ownerId = into; return true; }
    return false;
  });
  for (const c of s.list.slice()) {
    if (c.govId === id) c.govId = null;
    if (c.ownerId !== id) continue;
    if (into) { c.ownerId = into; if (c.founderId === id) c.founderId = into; continue; }
    if (c.status === 'independent' || c.status === 'node') { c.ownerId = null; continue; }
    if (c.stage >= 4) {
      news(state, data, 'orphan', { owner: goneName, name: c.name }, { importance: 1, actors: [], icon: '🗽' });
      c.status = 'independent'; c.stage = 6; c.outcome = 'independent'; c.ownerId = null; c.route = 0;
    } else abandon(state, data, c, 'dona extinta');
  }
  updateMaxStage(state);
}

const playerColony = (state, id) => {
  const c = colonyById(state, id);
  return c && c.ownerId === state.playerId ? c : null;
};
const needSlice = (state, data) => (isActive(data) ? (slice(state), null) : { ok: false, error: 'Esta partida não tem colônias.' });

export const actions = {
  'colonies/survey': (state, data, a) => needSlice(state, data) || launchSurvey(state, data, a?.siteId),
  'colonies/found': (state, data, a) => needSlice(state, data) || foundColony(state, data, state.playerId, a?.siteId, { name: a?.name }),
  'colonies/route': (state, data, a) => needSlice(state, data) || setRoute(state, data, playerColony(state, a?.colonyId), a?.level),
  'colonies/invest': (state, data, a) => needSlice(state, data) || invest(state, data, playerColony(state, a?.colonyId), a?.need),
  'colonies/upgrade': (state, data, a) => {
    const c = playerColony(state, a?.colonyId);
    return needSlice(state, data) || (c ? upgradeColony(state, data, c) : { ok: false, error: 'Colônia indisponível.' });
  },
  'colonies/tax': (state, data, a) => needSlice(state, data) || setTax(state, data, playerColony(state, a?.colonyId), a?.tax),
  'colonies/project': (state, data, a) => needSlice(state, data) || startProject(state, data, playerColony(state, a?.colonyId), a?.projectId),
  'colonies/abandon': (state, data, a) => {
    const c = playerColony(state, a?.colonyId);
    if (!c || c.status !== 'active') return { ok: false, error: 'Colônia indisponível.' };
    news(state, data, 'abandoned', { owner: ownerName(state, c.ownerId), name: c.name }, { importance: 2, actors: [c.ownerId], icon: '🕯️' });
    changeActor(state, c.ownerId, 'support', -2);
    abandon(state, data, c, 'evacuada');
    updateMaxStage(state);
    return { ok: true };
  },
};

export const decisionHandlers = {
  'colonies/crisis': (state, data, dec, choiceId) => {
    const c = colonyById(state, dec.payload?.colonyId);
    if (!c) return { ok: true };
    c.card = null;
    const ev = cfg(data)?.events?.find((e) => e.id === dec.payload?.eventId);
    if (!ev) return { ok: true };
    return resolveEvent(state, data, c, ev, choiceId, dec.id);
  },
  'colonies/independence': (state, data, dec, choiceId) => {
    const c = colonyById(state, dec.payload?.colonyId);
    if (!c) return { ok: true };
    c.card = null;
    const T = cfg(data).tuning.independence;
    if (choiceId === 'aliada') becomeSovereign(state, data, c, 'allied');
    else if (choiceId === 'adiar') {
      c.indep = { ...(c.indep || {}), resisted: (c.indep?.resisted || 0) + 1, cooldownTurn: state.turn + T.cooldownYears * W };
      c.opinion = clamp((c.opinion || 50) - 15, 0, 100);
    } else becomeSovereign(state, data, c, 'independent');
    updateMaxStage(state);
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Queries (UI)
// ---------------------------------------------------------------------------------------------------------------

/** Supply lines for the space map: Earth → colony body, with level, weeks and risk. */
export function routes(state, data) {
  const C = cfg(data);
  if (!C || !state.colonies) return [];
  return state.colonies.list.filter((c) => c.status === 'active' && c.route > 0 && c.bodyId).map((c) => {
    const site = C.siteById[c.siteId];
    return { colonyId: c.id, name: c.name, from: 'earth', to: c.bodyId, level: c.route, weeks: site?.transitWeeks || 0, risk: site?.risk || 0, ownerId: c.ownerId, supplied: (c.reserve || 0) > 0 };
  });
}

function colonyCard(state, data, c) {
  const C = cfg(data);
  const site = C.siteById[c.siteId] || {};
  const st = C.stages[c.stage] || {};
  const mine = c.ownerId === state.playerId;
  const m = c.status === 'node' ? null : model(data, c, site);
  const up = mine && c.status === 'active' ? upgradeCheck(state, data, c) : null;
  const projects = mine && c.status === 'active' ? C.projects.map((p) => {
    const out = {};
    const why = projectCheck(state, data, c, p.id, out);
    return { id: p.id, label: p.label, desc: p.desc, costM: out.costM, years: p.years, ok: !why, reason: why, done: arr(c.done).includes(p.id) };
  }).filter((p) => p.done || p.ok || (c.stage >= (C.projectById[p.id].minStage || 1) - 1 && (!C.projectById[p.id].regions || C.projectById[p.id].regions.includes(site.region)))) : [];
  return {
    id: c.id, name: c.name, siteId: c.siteId, place: site.place || '', siteName: site.name || '', region: site.region || null, stellar: isStellar(site), ly: site.ly ?? null,
    ownerId: c.ownerId, founderId: c.founderId, mine, status: c.status, outcome: c.outcome || null,
    stage: c.stage, stageLabel: st.label || '', stageDesc: st.desc || '', population: Math.floor(c.population || 0),
    housing: m?.housing ?? null, welfare: c.welfare ?? null, autonomy: c.autonomy ?? null, opinion: Math.round(c.opinion ?? 0),
    opinionTarget: m ? Math.round(opinionTarget(data, c, m)) : null,
    needs: NEEDS.map((k) => ({ id: k, label: needLabel(data, k), value: c.needs?.[k] ?? null, level: c.infra?.[k] ?? 0, bonus: site.bonus?.[k] || 0,
      pending: arr(c.pending).filter((p) => p.need === k).map((p) => p.turn), costM: mine && c.status === 'active' ? investCost(state, data, c, k) : null })),
    reserve: Math.round(c.reserve || 0), route: c.route || 0, routeYearM: routeCost(state, data, c), supplied: m?.supplied ?? true,
    tax: c.charter ? 'leve' : c.tax, charter: !!c.charter, upkeepM: upkeepCost(state, data, c), incomeM: incomeOf(data, c),
    upgrade: up, project: c.project ? { ...c.project, label: C.projectById[c.project.id]?.label || c.project.id } : null, projects,
    investWeeks: investWeeks(data, c), foundedTurn: c.foundedTurn, stageTurn: c.stageTurn, card: c.card || null, tags: arr(site.tags),
  };
}

/** Everything the Colônias screen needs (pure). */
export function view(state, data) {
  const C = cfg(data);
  const year = yearAt(state);
  if (!C || !isActive(data)) return { active: false, year, unlockYear: unlockYear(data) };
  const s = state.colonies || { list: [], transit: [], probes: [], surveys: {}, frontier: { reachLy: 0, worlds: 0, nodes: [] }, past: [], stats: {} };
  const pid = state.playerId;
  const list = s.list.filter((c) => c.status !== 'node');
  const mine = list.filter((c) => c.ownerId === pid || (c.founderId === pid && c.status === 'independent')).map((c) => colonyCard(state, data, c));
  const rivals = list.filter((c) => c.ownerId !== pid && !(c.founderId === pid && c.status === 'independent')).map((c) => {
    const site = C.siteById[c.siteId] || {};
    return { id: c.id, name: c.name, place: site.place || '', ownerId: c.ownerId, founderId: c.founderId, stage: c.stage, stageLabel: C.stages[c.stage]?.label || '', status: c.status, population: Math.floor(c.population || 0), stellar: isStellar(site) };
  });
  const sites = C.sites.map((site) => {
    const f = {};
    const why = foundCheck(state, data, pid, site.id, f);
    const sv = {};
    const svWhy = surveyCheck(state, data, site.id, sv);
    return {
      id: site.id, name: site.name, place: site.place, region: site.region, desc: site.desc, stellar: isStellar(site), ly: site.ly ?? null, fromYear: site.fromYear,
      open: siteOpen(site, year), known: siteKnown(state, data, site, pid, year), own: s.surveys?.[site.id] != null, survey: site.survey || null,
      costM: f.costM, weeks: f.weeks, canFound: !why, reason: why, canSurvey: !svWhy, surveyReason: svWhy, surveyCostM: sv.costM, surveyWeeks: sv.weeks,
      maxStage: site.maxStage ?? 6, maxStageLabel: C.stages[site.maxStage ?? 6]?.label || '', risk: site.risk || 0, tags: arr(site.tags),
      probe: s.probes.find((p) => p.siteId === site.id)?.arriveTurn ?? null,
      occupied: settledAt(s, site.id),
    };
  });
  const transit = s.transit.map((t) => ({ ...t, place: C.siteById[t.siteId]?.place || '', siteName: C.siteById[t.siteId]?.name || '', mine: t.ownerId === pid, stellar: isStellar(C.siteById[t.siteId]) }));
  const own = mine.filter((c) => c.status === 'active' || c.status === 'allied');
  return {
    active: true, unlocked: year >= unlockYear(data), year, unlockYear: unlockYear(data), turn: state.turn,
    colonies: mine, rivals, sites, transit, probes: s.probes.slice(),
    totals: { population: own.reduce((a, c) => a + c.population, 0), upkeepM: own.reduce((a, c) => a + (c.upkeepM || 0), 0), incomeM: own.reduce((a, c) => a + (c.incomeM || 0), 0), count: own.length, cap: C.tuning.caps.player },
    frontier: { reachLy: s.frontier?.reachLy || 0, worlds: s.frontier?.worlds || 0, nodes: arr(s.frontier?.nodes) },
    past: arr(s.past).slice(0, 8), stats: s.stats || {},
    stages: C.stages.filter(Boolean).map((x) => ({ n: x.n, id: x.id, label: x.label, short: x.short, desc: x.desc })),
    taxes: Object.entries(C.tuning.tax).map(([id, x]) => ({ id, label: x.label, rate: x.rate, opinion: x.opinion })),
    maxRoute: C.tuning.route.maxLevel, routes: routes(state, data),
  };
}

export const queries = {
  'colonies/view': (state, data) => view(state, data),
  'colonies/routes': (state, data) => routes(state, data),
  'colonies/active': (state, data) => isActive(data),
  'colonies/quote': (state, data, siteId) => { const o = {}; const why = foundCheck(state, data, state.playerId, siteId, o); return { ...o, ok: !why, reason: why }; },
};

export function onGameEnd() {}

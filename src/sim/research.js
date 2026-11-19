// Research & tech tree (module "research", slice state.research).
// - Player projects: safe (slow, predictable) or bold (faster, may surprise: leaps, setbacks, breakthroughs, latent flaws).
// - Science points (from missions via addSciencePoints, labs and engineers weekly) are spent to START a project;
//   money (US$ mi) is paid weekly via budget.spend('research') in proportion to progress.
// - Secret nodes appear when an event flag is set (state.events.flags[unlockedBy]) or a signal reveals them.
// - Rival actors research in parallel (state.research.rivals) and get techBonus too.
// techBonus() reads a cached per-actor effect table (state.research.bonus) so it needs no `data` argument.

import { addNews, emitSignal, clamp, changeActor, pushDecision, removeDecision } from '../core/helpers.js';
import * as budget from './budget.js';
import { yearAt, inYearWindow, legacyFromYear, dtOf, chanceInStep } from './simtime.js';
import * as gating from '../core/gating.js';
import { applyResearchGrant } from '../core/migrations/v4.js'; // also registers the v3 → v4 save migration

const DEFAULT_CFG = {
  startPoints: 30, baseSciencePerWeek: 1, engineerSciencePerWeek: 0.12, maxProjects: 2,
  costScale: { refBudget: 5000, min: 0.5, max: 1.4 }, cancelRefund: 0.5,
  approaches: {
    safe: { label: 'Segura', speed: 1, costMult: 1, weeklyEventChance: 0, breakthroughChance: 0.04, flawChance: 0 },
    bold: { label: 'Ousada', speed: 1.65, costMult: 1.1, weeklyEventChance: 0.035, leapShare: 0.4, leapProgress: 0.12,
      setbackProgress: 0.2, pushCostShare: 0.15, breakthroughChance: 0.2, flawChance: 0.2 },
  },
  quality: { breakthrough: 1.5, normal: 1, flaw: 0.5 },
  rivals: { baseSpeed: 0.35, budgetDivisor: 7000, maxSpeed: 1.6, boldCultureThreshold: 30 },
};

const REFINE_SHARE = 0.4; // refining a flawed node costs/takes 40% of the original
// Last data object seen (only used by the short unlockNode(state, id) form; content is static, so no determinism impact).
let lastData = null;

// ---------- data helpers ----------
// merged config, built once per (data, config object): the tree views call it for each of ~540 nodes
const CFG_MEMO = new WeakMap();
const cfg = (data) => {
  const src = data?.tech?.config || null;
  const key = data && typeof data === 'object' ? data : null;
  const hit = key ? CFG_MEMO.get(key) : null;
  if (hit && hit.src === src) return hit.c;
  const c = { ...DEFAULT_CFG, ...(src || {}) };
  if (key) CFG_MEMO.set(key, { src, c });
  return c;
};
const nodesOf = (data) => data?.tech?.nodes || [];
const nodeById = (data, id) => data?.index?.tech?.[id] || nodesOf(data).find((n) => n.id === id) || null;
const approachCfg = (data, a) => cfg(data).approaches?.[a] || DEFAULT_CFG.approaches[a] || DEFAULT_CFG.approaches.safe;
const round2 = (x) => Math.round(x * 100) / 100;

function ensure(state) {
  if (!state.research || typeof state.research !== 'object') state.research = {};
  const r = state.research;
  r.points ??= 0;
  r.projects ??= [];
  r.unlocked ??= [];
  r.rivals ??= {};
  r.rivalProjects ??= {};
  r.quality ??= {};
  r.revealed ??= [];
  r.announced ??= [];
  r.bonus ??= {};
  r.completedTurn ??= {};
  r.earned ??= 0;
  r.keys ??= [];
  return r;
}

function actorName(state, id) {
  const a = state.actors?.[id];
  return a ? `${a.flag ? a.flag + ' ' : ''}${a.short || a.name || id}` : id;
}

// ---------- effects / bonus cache ----------

/** Raw (unrounded) sum of the effects of ids[from..] into `out`, in list order. */
function addEffects(data, out, ids, quality, from = 0) {
  for (let i = from; i < ids.length; i++) {
    const id = ids[i];
    const n = nodeById(data, id);
    if (!n?.effects) continue;
    const q = quality[id] ?? 1;
    for (const [k, v] of Object.entries(n.effects)) {
      if (typeof v !== 'number') continue;
      out[k] = (out[k] || 0) + v * q;
    }
  }
  return out;
}

/** Sum of a node list's effects (times quality multipliers), as {key: value}. */
function sumEffects(data, ids, quality = {}, raw = null) {
  return roundEffects({ ...(raw || addEffects(data, {}, ids || [], quality)) });
}

// Rivals only ever append to their list, so their raw sums are kept per game state and actor and extended by the new
// ids (same order, same float operations as a full sum: the result is identical, MISSIONS-V2 §4.7 tick budget).
const RIVAL_SUMS = new WeakMap();
function rivalRawSum(state, data, actorId, ids) {
  let m = RIVAL_SUMS.get(state);
  if (!m) { m = new Map(); RIVAL_SUMS.set(state, m); }
  const c = rivalCacheOn ? m.get(actorId) : null;
  if (c && c.ids === ids && c.data === data && c.len <= ids.length && (c.len === 0 || ids[c.len - 1] === c.last)) {
    if (c.len < ids.length) { addEffects(data, c.raw, ids, {}, c.len); c.len = ids.length; c.last = ids[ids.length - 1]; }
    return c.raw;
  }
  const raw = addEffects(data, {}, ids, {});
  m.set(actorId, { ids, data, len: ids.length, last: ids[ids.length - 1], raw });
  return raw;
}

function roundEffects(out) {
  for (const k of Object.keys(out)) out[k] = round2(out[k] * 1000) / 1000; // avoid float noise (keeps 5 decimals)
  for (const k of ['commandPoints', 'researchSlots']) if (out[k] != null) out[k] = Math.floor(out[k] + 1e-9);
  return out;
}

function unlockedFor(state, actorId) {
  const r = state.research;
  if (!r) return [];
  return actorId === state.playerId ? r.unlocked || [] : r.rivals?.[actorId] || [];
}

/**
 * Effect caps (data.techtree.effectCaps, MISSIONS-V2 §4.6), applied after summing: {key: {min?, max?}} or
 * {key: [min, max]}; '*' (or '_default') caps every other key. Without the table nothing is capped.
 */
function capEffects(data, out) {
  const caps = data?.techtree?.effectCaps;
  if (!caps || typeof caps !== 'object') return out;
  const dflt = caps['*'] ?? caps._default ?? null;
  for (const k of Object.keys(out)) {
    let c = caps[k] ?? dflt;
    if (Array.isArray(c)) c = { min: c[0], max: c[1] };
    if (!c || typeof c !== 'object') continue;
    if (typeof c.min === 'number' && out[k] < c.min) out[k] = c.min;
    if (typeof c.max === 'number' && out[k] > c.max) out[k] = c.max;
  }
  return out;
}

function recompute(state, data, actorId) {
  const r = ensure(state);
  const isPlayer = actorId === state.playerId;
  const ids = unlockedFor(state, actorId);
  r.bonus[actorId] = capEffects(data, isPlayer ? sumEffects(data, ids, r.quality) : sumEffects(data, ids, {}, rivalRawSum(state, data, actorId, ids)));
  // keys the player holds (MISSIONS-V2 §5.1): a sorted cache of the unlock keys of research.unlocked
  if (isPlayer) r.keys = gating.keysOfNodes(data, r.unlocked);
}

/**
 * techBonus(state, actorId, key) → summed effect of unlocked nodes (0 if none).
 * Keys: reliability, launchCost, payload, chanceBand, commandPoints, sciencePerMission, landingReliability,
 * crewSafety, delayReduction (+ internal: sciencePerWeek, researchSlots, crewMorale, injuryReduction).
 */
export function techBonus(state, actorId, key) {
  const v = state?.research?.bonus?.[actorId]?.[key];
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** True if actor has the node (player or rival). */
export function hasTech(state, actorId, nodeId) {
  return unlockedFor(state, actorId ?? state.playerId).includes(nodeId);
}

/** Add science points to the player (from missions, events, crew...). */
export function addSciencePoints(state, n, source = '') {
  const r = ensure(state);
  const v = Number(n) || 0;
  r.points = round2(Math.max(0, r.points + v));
  if (v > 0) r.earned = round2(r.earned + v);
  if (state.stats && v > 0) state.stats['research.science'] = round2((state.stats['research.science'] || 0) + v);
  if (source && v >= 1) r.lastIncome = { turn: state.turn, amount: round2(v), source };
  return r.points;
}

// ---------- visibility / availability ----------

function isVisible(state, node) {
  if (!node.secret) return true;
  const r = state.research || {};
  if (r.unlocked?.includes(node.id) || r.revealed?.includes(node.id)) return true;
  return !!(node.unlockedBy && state.events?.flags?.[node.unlockedBy]);
}

/** Researchable in the current year (fromYear/untilYear; undated legacy nodes open with the legacy era, 2026). */
export function nodeOpen(state, data, node) {
  return inYearWindow(node, yearAt(state), { undatedFrom: legacyFromYear(data) });
}

function requiresMet(list, node) {
  return (node.requires || []).every((req) => list.includes(req));
}

function maxProjects(state, data) {
  return (cfg(data).maxProjects || 2) + techBonus(state, state.playerId, 'researchSlots');
}

/** Cost scale by agency size: big budgets pay more (bigger programs), frugal agencies less. */
function costScale(state, data, actorId) {
  const cs = cfg(data).costScale || DEFAULT_CFG.costScale;
  const b = state.actors?.[actorId]?.budget;
  if (!b || !(b > 0)) return 1;
  return clamp(Math.sqrt(b / (cs.refBudget || 5000)), cs.min ?? 0.5, cs.max ?? 1.4);
}

function nodeMoneyCost(state, data, node, approach = 'safe') {
  return Math.round((node.cost || 0) * costScale(state, data, state.playerId) * (approachCfg(data, approach).costMult ?? 1));
}

/** Engineering team speed factor (reads state.crew read-only; no import of crew.js). */
function engineerFactor(state, data) {
  const traits = {};
  for (const t of data?.crew?.traits || []) traits[t.id] = t.effects || {};
  const engs = Object.values(state.crew || {})
    .filter((p) => p && p.actorId === state.playerId && p.role === 'engineer' && p.status === 'active')
    .sort((a, b) => (b.skill || 0) - (a.skill || 0))
    .slice(0, 3);
  if (!engs.length) return 0.8;
  const avg = engs.reduce((s, p) => s + (p.skill || 0), 0) / engs.length;
  let f = 1 + (avg - 50) / 200;
  for (const p of engs) for (const t of p.traits || []) f += (traits[t]?.researchSpeed || 0) / engs.length;
  return clamp(f, 0.7, 1.5);
}

function weeklySpeed(state, data, approach) {
  return (approachCfg(data, approach).speed ?? 1) * engineerFactor(state, data);
}

/**
 * Lab ("passive") science is limited: over the whole game it can only add up to passivePool(year) points
 * (data/tech.json config.passivePool, cumulative steps by era). Enough for the starter nodes of each era; the rest
 * of the tree needs real science from missions, stations and events. null = no pool configured (unlimited).
 */
export function passivePool(state, data) {
  const steps = cfg(data).passivePool;
  if (!Array.isArray(steps) || !steps.length) return null;
  // only where research gates the catalog (campaign and era scenarios); the Corrida Lunar keeps its free labs
  if (!(data?.scenario?.techGating ?? state?.techGating)) return null;
  const y = yearAt(state);
  let pool = 0;
  for (const [from, v] of steps) if (y >= from) pool = v;
  return pool;
}
/** Lab science still to come under the pool (Infinity without a pool). */
export function passiveLeft(state, data) {
  const pool = passivePool(state, data);
  if (pool == null) return Infinity;
  const r = ensure(state);
  if (!Number.isFinite(r.passive)) r.passive = Math.min(r.earned || 0, pool); // saves before the pool
  return Math.max(0, pool - r.passive);
}

function sciencePerWeek(state, data) {
  const c = cfg(data);
  const engs = Object.values(state.crew || {}).filter(
    (p) => p && p.actorId === state.playerId && p.role === 'engineer' && p.status === 'active',
  ).length;
  return round2((c.baseSciencePerWeek || 0) + engs * (c.engineerSciencePerWeek || 0) + techBonus(state, state.playerId, 'sciencePerWeek'));
}

// ---------- effect text (pt-BR) ----------

/** ["+2 p.p. confiabilidade das missões", "−6% custo de lançamento", ...] */
const LABELS_MEMO = new WeakMap();
function effectLabels(data) {
  // Missões v2 effect keys (lifetime, maintenance…) are labelled in data/core/techtree.json
  const a = data?.tech?.effectLabels, b = data?.techtree?.effectLabels;
  const hit = data && typeof data === 'object' ? LABELS_MEMO.get(data) : null;
  if (hit && hit.a === a && hit.b === b) return hit.labels;
  const labels = b ? { ...(a || {}), ...b } : (a || {});
  if (data && typeof data === 'object') LABELS_MEMO.set(data, { a, b, labels });
  return labels;
}
export function describeEffects(data, effects = {}, mult = 1) {
  const labels = effectLabels(data);
  const out = [];
  for (const [k, raw] of Object.entries(effects || {})) {
    if (typeof raw !== 'number') continue;
    const v = raw * mult;
    const L = labels[k] || { label: k, unit: 'num' };
    const fmt = (x, d = 0) => x.toFixed(d).replace('.', ',');
    const sign = v >= 0 ? '+' : '−';
    const a = Math.abs(v);
    switch (L.unit) {
      case 'pp': out.push(`${sign}${fmt(a * 100, a * 100 < 1 ? 1 : 0)} p.p. ${L.label}`); break;
      case 'pct': out.push(`${sign}${fmt(a * 100)}% ${L.label}`); break;
      case 'pctAbs': out.push(`${fmt(a * 100)}% mais ${L.label}`); break;
      case 'pctNeg': out.push(`−${fmt(a * 100)}% ${L.label}`); break;
      case 'int': out.push(`${sign}${Math.floor(a + 1e-9)} ${L.label}`); break;
      default: out.push(`${sign}${fmt(a, a % 1 ? 1 : 0)} ${L.label}`);
    }
  }
  return out;
}

// ---------- init ----------

/**
 * Nodes an actor starts with: the ones data gives it (initialFor). With `techStart: "historical"` (the campaign) an
 * initialFor node from a later year is not given yet (the 2026 start set of the Corrida must not reach 1950).
 */
function initialNodes(state, data, actorId, { secret = true } = {}) {
  const historical = data?.scenario?.techStart === 'historical';
  const year = yearAt(state);
  return nodesOf(data).filter((n) => (secret || !n.secret) && (n.initialFor || []).includes(actorId)
    && !(historical && gating.histYearOf(n) > year)).map((n) => n.id);
}

/**
 * The player's starting research (initialFor + the §5.5 historical grant), keys recomputed. `grant` (node ids, the
 * founding "Tecnologia inicial" level from lifecycle) replaces the historical grant of a gated scenario.
 */
function startPlayer(state, data, { grant = null } = {}) {
  const r = ensure(state);
  r.unlocked = initialNodes(state, data, state.playerId);
  // MISSIONS-V2 §5.5: a gated scenario starts the player with what history had by the start year (histYear ≤
  // start: the 1950 campaign gets the sounding rockets and their roots; same rule as the v3 → v4 migration)
  if (data?.scenario?.techStart === 'historical') {
    r.unlocked = Array.isArray(grant)
      ? [...new Set([...grant, ...r.unlocked])].sort()
      : gating.historicalGrant(data, (state.startYear ?? yearAt(state)) + 1, { have: r.unlocked });
  }
  ensureRivals(state, data);
  recompute(state, data, state.playerId);
}

export function init(state, data, ctx) {
  lastData = data;
  const r = ensure(state);
  r.points = cfg(data).startPoints ?? 30;
  startPlayer(state, data);
}

/**
 * The player became another actor before the first turn (agency/found on a game created for someone else): its
 * research starts over as a new agency's would (§5.5), and the old actor joins the rivals. opts.grant = the node ids
 * of the founding "Tecnologia inicial" level (gating.foundingGrant).
 */
export function resetPlayer(state, data, opts = {}) {
  if (!state.research) return;
  const r = state.research;
  delete r.rivals?.[state.playerId];
  startPlayer(state, data, opts);
}

/**
 * A new director mid-game (src/sim/director.js; state.playerId is already the new agency). The old agency keeps what
 * it researched as a rival (its open projects end with the director); the new one brings its own: the rival list it
 * had (an agency taken over), or `grant` (a founded agency: initialFor + the "Tecnologia inicial" share at today's
 * date, lifecycle.foundingTech). Science points start over like a new agency's.
 */
export function onDirectorChange(state, data, ctx, { from, to, grant = null } = {}) {
  const r = ensure(state);
  const mine = Array.isArray(r.unlocked) ? r.unlocked.slice() : [];
  if (from && from !== to && state.actors?.[from]) r.rivals[from] = mine;
  else if (from) delete r.rivals[from];
  let next;
  if (Array.isArray(grant)) next = [...new Set([...grant, ...initialNodes(state, data, to)])].sort();
  else next = Array.isArray(r.rivals[to]) ? r.rivals[to].slice() : initialNodes(state, data, to);
  delete r.rivals[to];
  delete r.rivalProjects?.[to];
  r.unlocked = next;
  r.projects = [];
  r.quality = {};
  r.points = cfg(data).startPoints ?? 30;
  delete r.needsRecompute;
  ensureRivals(state, data);
  recompute(state, data, to);
  if (r.rivals[from]) recompute(state, data, from);
}

/** Rivals = every actor except the player. Added lazily so a late diplomacy init still works. */
function ensureRivals(state, data) {
  const r = ensure(state);
  for (const id of Object.keys(state.actors || {})) {
    if (id === state.playerId || r.rivals[id]) continue;
    r.rivals[id] = initialNodes(state, data, id, { secret: false });
    recompute(state, data, id);
  }
}

// ---------- tick ----------

export function tick(state, data, ctx) {
  lastData = data;
  const r = ensure(state);
  if (r.needsGrant) { applyResearchGrant(state, data); r.needsRecompute = true; }
  if (r.needsRecompute) { recompute(state, data, state.playerId); delete r.needsRecompute; }
  ensureRivals(state, data);
  revealSecrets(state, data);

  const dt = dtOf(ctx);
  // weekly science from labs + engineering team (dt weeks of it)
  {
    const want = dt === 1 ? sciencePerWeek(state, data) : round2(sciencePerWeek(state, data) * dt);
    const left = passiveLeft(state, data);
    const got = round2(Math.min(want, left));
    if (got > 0) {
      addSciencePoints(state, got);
      if (Number.isFinite(left)) state.research.passive = round2((state.research.passive || 0) + got);
    }
  }
  // tech-transfer treaties (diplomacy emits 'diplomacy/techTransfer' at signing and every quarter)
  for (const s of state.signals || []) {
    if (s?.type !== 'diplomacy/techTransfer' || s.actorId !== state.playerId || !(s.points > 0)) continue;
    const from = state.actors?.[s.partnerId]?.short || s.partnerId || 'parceiro';
    addSciencePoints(state, Math.round(s.points), `transferência de tecnologia: ${from}`);
  }

  // player projects
  for (const p of r.projects.slice()) advanceProject(state, data, ctx, p, dt);

  // rivals
  for (const id of Object.keys(r.rivals)) if (state.actors?.[id]) advanceRival(state, data, ctx, id, dt);
}

function revealSecrets(state, data) {
  const r = state.research;
  const signals = state.signals || [];
  for (const n of nodesOf(data)) {
    if (!n.secret || r.unlocked.includes(n.id) || r.announced.includes(n.id)) continue;
    let reveal = !!(n.unlockedBy && state.events?.flags?.[n.unlockedBy]);
    if (!reveal && n.revealedBySignal) {
      reveal = signals.some((s) => s.type === n.revealedBySignal && signalIsPlayers(state, s));
    }
    if (!reveal) continue;
    if (!r.revealed.includes(n.id)) r.revealed.push(n.id);
    r.announced.push(n.id);
    addNews(state, {
      headline: `Nova linha de pesquisa aberta: ${n.name}`,
      body: n.description || '',
      tags: ['research', 'secret'], actors: [state.playerId], importance: 2, icon: '🔬',
    });
  }
}

function signalIsPlayers(state, s) {
  if (s.actorId) return s.actorId === state.playerId;
  if (s.crewId) return state.crew?.[s.crewId]?.actorId === state.playerId;
  return true;
}

function pay(state, actorId, amount, category, note) {
  if (!(amount > 0)) return true;
  if (typeof budget.spend === 'function') {
    if (typeof budget.canAfford === 'function' && !budget.canAfford(state, actorId, amount)) return false;
    return budget.spend(state, actorId, amount, category, note) !== false;
  }
  const a = state.actors?.[actorId];
  if (!a) return true; // no economy at all (tests / stubs): research is free
  if ((a.cash ?? 0) < amount) return false;
  changeActor(state, actorId, 'cash', -amount);
  return true;
}

function canPay(state, actorId, amount) {
  if (typeof budget.canAfford === 'function') return !!budget.canAfford(state, actorId, amount);
  const a = state.actors?.[actorId];
  return !a || (a.cash ?? 0) >= amount;
}

function advanceProject(state, data, ctx, p, dt = 1) {
  const node = nodeById(data, p.nodeId);
  const r = state.research;
  if (!node) { r.projects = r.projects.filter((x) => x !== p); return; }
  const ac = approachCfg(data, p.approach);
  // dt weeks of progress (and of spending) at once; the project stops at 100%
  const inc = Math.min(1 - p.progress, dt * weeklySpeed(state, data, p.approach) / Math.max(1, p.weeks || node.weeks || 10));
  const amount = round2((p.cost || 0) * inc);
  // a project in progress never stops for lack of money: it is charged even into the red (only new starts are blocked)
  if (!(typeof budget.commit === 'function' ? budget.commit(state, state.playerId, amount, 'research', `P&D: ${node.name}`) : pay(state, state.playerId, amount, 'research', `P&D: ${node.name}`))) {
    if (!p.stalled) {
      p.stalled = true;
      addNews(state, { headline: `Pesquisa parada por falta de verba: ${node.name}`, tags: ['research', 'budget'], actors: [state.playerId], importance: 2, icon: '⏸️' });
    }
    return;
  }
  p.stalled = false;
  p.progress = round2((p.progress + inc) * 1000) / 1000;
  p.spent = round2((p.spent || 0) + amount);

  // bold approach: surprises along the way
  if (p.approach === 'bold' && !p.refine && p.progress < 1 && ac.weeklyEventChance > 0) {
    const rng = ctx.rng(`bold:${p.nodeId}`);
    if (rng.chance(chanceInStep(ac.weeklyEventChance, { dt }))) {
      if (rng.chance(ac.leapShare ?? 0.4)) {
        p.progress = Math.min(1, p.progress + (ac.leapProgress ?? 0.12));
        addNews(state, { headline: `Salto inesperado em ${node.name}: teste rende mais que o previsto`, tags: ['research'], actors: [state.playerId], importance: 1, icon: '🚀' });
      } else if (!p.pendingDecision && p.progress > 0.1) {
        pushSetback(state, data, p, node);
      }
    }
  }

  if (p.progress >= 1 - 1e-9) completeProject(state, data, ctx, p, node);
}

function pushSetback(state, data, p, node) {
  const ac = approachCfg(data, 'bold');
  const pushCost = Math.round((p.cost || 0) * (ac.pushCostShare ?? 0.15));
  const lose = Math.round((ac.setbackProgress ?? 0.2) * 100);
  const afford = canPay(state, state.playerId, pushCost);
  const d = pushDecision(state, {
    kind: 'research/setback',
    title: `Revés em ${node.name}`,
    body: `Um teste da abordagem ousada falhou de forma inesperada. A equipe pode varar noites e comprar peças de reposição, ou aceitar o atraso e refazer a etapa.`,
    choices: [
      { id: 'push', label: 'Insistir e pagar', preview: `−US$ ${pushCost} mi, progresso mantido`, disabled: !afford, reason: afford ? undefined : 'Caixa insuficiente' },
      { id: 'accept', label: 'Aceitar o atraso', preview: `−${lose}% de progresso no projeto` },
    ],
    urgency: 2,
    expiresTurn: state.turn + 3,
    defaultChoice: 'accept',
    payload: { nodeId: p.nodeId, pushCost },
  });
  p.pendingDecision = d.id;
}

function completeProject(state, data, ctx, p, node) {
  const r = state.research;
  const c = cfg(data);
  const ac = approachCfg(data, p.approach);
  r.projects = r.projects.filter((x) => x !== p);
  if (p.pendingDecision) removeDecision(state, p.pendingDecision);

  let result = 'normal';
  if (p.refine) {
    delete r.quality[node.id];
    addNews(state, { headline: `Correção concluída: ${node.name} agora rende o esperado`, tags: ['research'], actors: [state.playerId], importance: 1, icon: '🔧' });
  } else {
    const roll = ctx.rng(`complete:${node.id}`).next();
    if (roll < (ac.breakthroughChance || 0)) result = 'breakthrough';
    else if (roll < (ac.breakthroughChance || 0) + (ac.flawChance || 0)) result = 'flaw';
    const q = c.quality?.[result] ?? 1;
    if (q !== 1) r.quality[node.id] = q; else delete r.quality[node.id];
    if (!r.unlocked.includes(node.id)) r.unlocked.push(node.id);
    r.completedTurn[node.id] = state.turn;
    const extra = result === 'breakthrough' ? ' — e superou as expectativas'
      : result === 'flaw' ? ', mas com uma falha latente' : '';
    addNews(state, {
      headline: `Pesquisa concluída: ${node.name}${extra}`,
      body: describeEffects(data, node.effects, q).join(' · '),
      tags: ['research'], actors: [state.playerId], importance: 2, icon: result === 'flaw' ? '⚠️' : '🔬',
    });
    if (result === 'breakthrough') addSciencePoints(state, Math.round((node.science || 10) * 0.5), 'breakthrough');
    if (state.stats) state.stats['research.completed'] = (state.stats['research.completed'] || 0) + 1;
    emitSignal(state, 'research/completed', { nodeId: node.id, actorId: state.playerId, result });
  }
  recompute(state, data, state.playerId);
}

// ---------- rivals ----------

function rivalSpeed(state, data, actorId) {
  const rc = cfg(data).rivals || DEFAULT_CFG.rivals;
  const b = state.actors?.[actorId]?.budget || 2000;
  return clamp((rc.baseSpeed ?? 0.35) + b / (rc.budgetDivisor || 7000), 0.2, rc.maxSpeed ?? 1.6);
}

function rivalWeight(actor, node) {
  let w = 1;
  const e = node.effects || {};
  const crewed = !!actor?.capabilities?.crewed;
  const company = actor?.kind === 'company';
  if (crewed && e.crewSafety) w += 1.5;
  if (company && (e.launchCost || e.payload)) w += 1.5;
  if (!crewed && (e.sciencePerMission || e.landingReliability)) w += 1;
  if (e.reliability) w += 0.5;
  return w * 20 / Math.max(10, node.weeks || 20);
}

// Rival option lists (MISSIONS-V2 §4.7): ~540 nodes × a dozen rivals every week is too much to filter from scratch,
// so the list is cached per game state and actor, keyed by (year, has.length, data). A rival's list only grows by
// push (or is replaced when the actor is born/merged, which changes the length), so the key pins the content and the
// cached list is exactly what the filter would return: picks are identical with or without the cache.
const RIVAL_OPTIONS = new WeakMap();
let rivalCacheOn = true;
/** Tests: switch the cache off to compare picks. */
export function _setRivalCache(on) { rivalCacheOn = !!on; }

function rivalOptions(state, data, id, has) {
  const year = yearAt(state);
  let m = rivalCacheOn ? RIVAL_OPTIONS.get(state) : null;
  const hit = m?.get(id);
  if (hit && hit.year === year && hit.len === has.length && hit.data === data && hit.has === has) return hit.options;
  // same filter as before, with set lookups and the year window read once
  const hasSet = new Set(has);
  const undatedFrom = legacyFromYear(data);
  const options = nodesOf(data).filter((n) => !n.secret && !hasSet.has(n.id) && (n.requires || []).every((req) => hasSet.has(req))
    && inYearWindow(n, year, { undatedFrom }));
  if (rivalCacheOn) {
    if (!m) { m = new Map(); RIVAL_OPTIONS.set(state, m); }
    m.set(id, { year, len: has.length, data, has, options });
  }
  return options;
}

// dt weeks of a rival's research: a project finished inside the window hands its spare weeks to the next pick, so a
// long tick researches as much as the same weeks one by one (dt = 1: one week, the old weekly step)
function advanceRival(state, data, ctx, id, dt = 1) {
  let weeks = dt;
  for (let n = 0; weeks > 0 && n < 64; n++) {
    const used = advanceRivalOnce(state, data, ctx, id, weeks, n);
    if (!(used > 0)) return;
    weeks -= used;
  }
}
function advanceRivalOnce(state, data, ctx, id, weeks, n) {
  const r = state.research;
  const has = r.rivals[id] || (r.rivals[id] = []);
  let proj = r.rivalProjects[id];
  if (!proj) {
    const options = rivalOptions(state, data, id, has);
    if (!options.length) return 0;
    const rng = ctx.rng(n ? `rival-pick:${id}:${n}` : `rival-pick:${id}`);
    const actor = state.actors?.[id];
    const pick = rng.weighted(options, (o) => rivalWeight(actor, o));
    if (!pick) return 0;
    const bold = (actor?.culture ?? 0) > (cfg(data).rivals?.boldCultureThreshold ?? 30);
    proj = r.rivalProjects[id] = { nodeId: pick.id, progress: 0, startedTurn: state.turn, bold };
  }
  const node = nodeById(data, proj.nodeId);
  if (!node) { delete r.rivalProjects[id]; return 0; }
  const rate = rivalSpeed(state, data, id) * (proj.bold ? 1.3 : 1) / Math.max(1, node.weeks || 20);
  // whole weeks this project still needs, at most the window's (1 for the weekly step)
  const used = weeks === 1 ? 1 : Math.max(1, Math.min(weeks, Math.ceil((1 - proj.progress) / rate - 1e-9)));
  proj.progress = round2((proj.progress + rate * used) * 1000) / 1000;
  if (proj.progress < 1) return weeks;
  delete r.rivalProjects[id];
  if (!has.includes(node.id)) has.push(node.id);
  recompute(state, data, id);
  const playerHas = r.unlocked.includes(node.id);
  // only notable programs the player lacks make the news; the signal always fires
  if (!playerHas && (node.cost || 0) >= (cfg(data).rivals?.announceMinCost ?? 150)) addNews(state, {
    headline: `${actorName(state, id)} domina ${node.name}`,
    body: 'Sua agência ainda não tem essa tecnologia.',
    tags: ['research', 'rival'], actors: [id], importance: 1, icon: '🧪',
  });
  emitSignal(state, 'research/completed', { nodeId: node.id, actorId: id });
  return used;
}

// ---------- unlock (for narrative {unlockTech}) ----------

/**
 * Grant a node to the player (or an actor) immediately, e.g. from an event effect {unlockTech}.
 * Returns true if newly unlocked.
 * Also accepts the short form unlockNode(state, nodeId) (caller emits its own signal); then the bonus cache is
 * rebuilt from the last data seen (or at the next tick if none yet).
 */
export function unlockNode(state, data, nodeId, opts = {}) {
  if (typeof data === 'string') {
    const id = data;
    const r = ensure(state);
    const d = lastData;
    if (d && !nodeById(d, id)) return false;
    if (r.unlocked.includes(id)) return false;
    r.unlocked.push(id);
    r.projects = r.projects.filter((p) => p.nodeId !== id);
    r.completedTurn[id] = state.turn;
    if (d) recompute(state, d, state.playerId); else r.needsRecompute = true;
    return true;
  }
  const { actorId = state.playerId, source = 'event' } = opts;
  const r = ensure(state);
  const node = nodeById(data, nodeId);
  if (!node) return false;
  const list = actorId === state.playerId ? r.unlocked : (r.rivals[actorId] ||= []);
  if (list.includes(nodeId)) return false;
  list.push(nodeId);
  if (actorId === state.playerId) {
    r.projects = r.projects.filter((p) => p.nodeId !== nodeId);
    r.completedTurn[nodeId] = state.turn;
    if (!r.revealed.includes(nodeId) && node.secret) r.revealed.push(nodeId);
    addNews(state, { headline: `Tecnologia obtida: ${node.name}`, tags: ['research', source], actors: [actorId], importance: 2, icon: '🔬' });
  } else if (r.rivalProjects[actorId]?.nodeId === nodeId) delete r.rivalProjects[actorId];
  recompute(state, data, actorId);
  emitSignal(state, 'research/completed', { nodeId, actorId, source });
  return true;
}

/** Reveal a secret node without granting it (event "abre um nó secreto"). */
export function revealNode(state, data, nodeId) {
  const r = ensure(state);
  if (!nodeById(data, nodeId) || r.revealed.includes(nodeId)) return false;
  r.revealed.push(nodeId);
  return true;
}

// ---------- actions ----------

function startProject(state, data, action, ctx) {
  const r = ensure(state);
  const node = nodeById(data, action.nodeId);
  if (!node) return { ok: false, error: 'tecnologia desconhecida' };
  const approach = action.approach === 'bold' ? 'bold' : 'safe';
  if (!isVisible(state, node)) return { ok: false, error: 'tecnologia ainda desconhecida' };
  if (r.unlocked.includes(node.id)) return { ok: false, error: 'já pesquisada' };
  if (r.projects.some((p) => p.nodeId === node.id)) return { ok: false, error: 'já em andamento' };
  if (!requiresMet(r.unlocked, node)) return { ok: false, error: 'pré-requisitos faltando' };
  if (!nodeOpen(state, data, node)) return { ok: false, error: 'tecnologia ainda fora do alcance desta época' };
  if (r.projects.length >= maxProjects(state, data)) return { ok: false, error: `limite de ${maxProjects(state, data)} projetos simultâneos` };
  const sci = node.science || 0;
  if (r.points < sci) return { ok: false, error: `ciência insuficiente (${sci} necessários)` };
  r.points = round2(r.points - sci);
  const p = {
    nodeId: node.id, approach, progress: 0, cost: nodeMoneyCost(state, data, node, approach),
    startedTurn: state.turn, weeks: node.weeks || 10, science: sci, spent: 0,
  };
  r.projects.push(p);
  return { ok: true, nodeId: node.id, etaWeeks: Math.ceil(p.weeks / weeklySpeed(state, data, approach)), cost: p.cost };
}

function cancelProject(state, data, action) {
  const r = ensure(state);
  const p = r.projects.find((x) => x.nodeId === action.nodeId);
  if (!p) return { ok: false, error: 'projeto não encontrado' };
  r.projects = r.projects.filter((x) => x !== p);
  if (p.pendingDecision) removeDecision(state, p.pendingDecision);
  const refund = Math.floor((p.science || 0) * (cfg(data).cancelRefund ?? 0.5));
  addSciencePoints(state, refund, 'cancel');
  return { ok: true, refund };
}

function refineProject(state, data, action) {
  const r = ensure(state);
  const node = nodeById(data, action.nodeId);
  if (!node || !r.unlocked.includes(node.id) || !(r.quality[node.id] < 1)) return { ok: false, error: 'nada a corrigir' };
  if (r.projects.some((p) => p.nodeId === node.id)) return { ok: false, error: 'já em andamento' };
  if (r.projects.length >= maxProjects(state, data)) return { ok: false, error: 'limite de projetos simultâneos' };
  const p = {
    nodeId: node.id, approach: 'safe', refine: true, progress: 0,
    cost: Math.round(nodeMoneyCost(state, data, node, 'safe') * REFINE_SHARE),
    startedTurn: state.turn, weeks: Math.max(4, Math.round((node.weeks || 10) * REFINE_SHARE)), science: 0, spent: 0,
  };
  r.projects.push(p);
  return { ok: true, nodeId: node.id, cost: p.cost };
}

export const actions = {
  'research/start': startProject,
  'research/cancel': cancelProject,
  'research/refine': refineProject,
};

export const decisionHandlers = {
  'research/setback': (state, data, decision, choiceId) => {
    const r = ensure(state);
    const { nodeId, pushCost } = decision.payload || {};
    const p = r.projects.find((x) => x.nodeId === nodeId);
    if (!p) return {};
    p.pendingDecision = null;
    const node = nodeById(data, nodeId);
    if (choiceId === 'push' && pay(state, state.playerId, pushCost || 0, 'research', `P&D emergencial: ${node?.name || nodeId}`)) {
      return { kept: true };
    }
    const lose = approachCfg(data, 'bold').setbackProgress ?? 0.2;
    p.progress = Math.max(0, round2(p.progress - lose));
    addNews(state, { headline: `${node?.name || 'Projeto'} atrasa após teste fracassado`, tags: ['research'], actors: [state.playerId], importance: 1, icon: '🧯' });
    if (state.stats) state.stats['research.setbacks'] = (state.stats['research.setbacks'] || 0) + 1;
    return { kept: false };
  },
};

// ---------- queries ----------

/** Shared lookups for a batch of node views (sets instead of list scans: the tree has ~540 nodes). */
function viewCtx(state, data) {
  const r = state.research || {};
  const rivalsBy = new Map();
  for (const [id, l] of Object.entries(r.rivals || {})) for (const nid of l || []) {
    if (!rivalsBy.has(nid)) rivalsBy.set(nid, []);
    rivalsBy.get(nid).push(id);
  }
  return {
    unlocked: new Set(r.unlocked || []),
    projects: new Map((r.projects || []).map((p) => [p.nodeId, p])),
    rivalsBy,
    speedSafe: weeklySpeed(state, data, 'safe'),
    speedBold: weeklySpeed(state, data, 'bold'),
    kinds: Object.fromEntries(gating.kindsOf(data).map((k) => [k.id, k])),
    // read once per batch (each node used to recompute them)
    year: yearAt(state),
    undatedFrom: legacyFromYear(data),
    scale: costScale(state, data, state.playerId),
    multSafe: approachCfg(data, 'safe').costMult ?? 1,
    multBold: approachCfg(data, 'bold').costMult ?? 1,
  };
}

// The parts of a node view that depend only on the data (era, unlock labels, cross-era prerequisites, names, effect
// text at quality 1): built once per (data, node) and copied into every view; the state-dependent fields are filled
// per call. Kind labels come from the same data (gating.kindsOf).
const STATIC_VIEWS = new WeakMap();
function staticView(data, n, kinds) {
  let byNode = STATIC_VIEWS.get(data);
  if (!byNode) { byNode = new WeakMap(); STATIC_VIEWS.set(data, byNode); }
  let s = byNode.get(n);
  if (s) return s;
  const branch = (data?.tech?.branches || []).find((b) => b.id === n.branch);
  const eraId = gating.eraIdOf(n);
  const keys = gating.nodeKeys(n);
  const unlocks = (n.unlocks || []).map((u) => {
    const key = typeof u === 'string' ? u : u?.key;
    if (!key) return null;
    const kind = gating.keyKind(key);
    return { key, kind, kindLabel: kinds[kind]?.label || kind, label: (typeof u === 'object' && u.label) || gating.keyLabel(data, key) };
  }).filter(Boolean);
  const stubs = [];
  for (const id of n.requires || []) {
    const p = nodeById(data, id);
    if (!p) continue;
    const pe = gating.eraIdOf(p);
    if (pe !== eraId) stubs.push({ id, eraId: pe, name: p.name || id, short: p.short || p.name || id });
  }
  s = {
    branchName: branch?.name || n.branch, eraId, keys, unlocks, stubs,
    requiresNames: (n.requires || []).map((id) => nodeById(data, id)?.name || id),
    effectText: describeEffects(data, n.effects, 1),
  };
  byNode.set(n, s);
  return s;
}

function nodeView(state, data, n, vc = viewCtx(state, data)) {
  const r = state.research || {};
  const unlocked = vc.unlocked;
  const proj = vc.projects.get(n.id);
  const done = unlocked.has(n.id);
  let status = 'locked';
  if (done && !proj) status = 'done';
  else if (proj) status = 'active';
  else if ((n.requires || []).every((x) => unlocked.has(x)) && inYearWindow(n, vc.year, { undatedFrom: vc.undatedFrom })) status = 'available';
  const q = r.quality?.[n.id] ?? 1;
  const eta = proj
    ? Math.ceil(((1 - proj.progress) * (proj.weeks || n.weeks || 10)) / weeklySpeed(state, data, proj.approach))
    : null;
  const sv = staticView(data, n, vc.kinds);
  const { eraId, keys } = sv;
  // fresh copies: callers get their own objects, as before
  const unlocks = sv.unlocks.map((u) => ({ ...u }));
  // prerequisites of another era: drawn as stubs at the top of the branch column (MISSIONS-V2 §6.1)
  const stubs = sv.stubs.map((x) => ({ ...x, status: unlocked.has(x.id) ? 'done' : 'locked' }));
  return {
    id: n.id, branch: n.branch, branchName: sv.branchName, name: n.name, description: n.description,
    era: n.era, eraId, secret: !!n.secret, status, fromYear: n.fromYear ?? null, histYear: n.histYear ?? null,
    icon: n.icon || null, short: n.short || null, tier: n.tier ?? null, row: n.row ?? null, lane: n.lane ?? null,
    kind: keys.length ? 'unlock' : 'efficiency', unlockKind: keys.length ? gating.keyKind(keys[0]) : null, unlocks,
    // = nodeMoneyCost (same product, same order)
    cost: Math.round((n.cost || 0) * vc.scale * vc.multSafe), costBold: Math.round((n.cost || 0) * vc.scale * vc.multBold),
    science: n.science || 0, canAffordScience: (r.points || 0) >= (n.science || 0),
    weeks: Math.ceil((n.weeks || 10) / vc.speedSafe), weeksBold: Math.ceil((n.weeks || 10) / vc.speedBold),
    requires: n.requires || [], requiresNames: sv.requiresNames.slice(), stubs,
    effects: n.effects || {}, effectText: done && q !== 1 ? describeEffects(data, n.effects, q) : sv.effectText.slice(),
    quality: done ? q : null, canRefine: done && q < 1 && !proj,
    progress: proj ? proj.progress : done ? 1 : 0, approach: proj?.approach || null, stalled: !!proj?.stalled,
    refining: !!proj?.refine, etaWeeks: eta, spent: proj?.spent || 0, projectCost: proj?.cost || null,
    rivalsWith: vc.rivalsBy.get(n.id) || [],
  };
}

const visibleNodes = (state, data) => nodesOf(data).filter((n) => isVisible(state, n));
const treeViews = (state, data, list = visibleNodes(state, data)) => {
  const vc = viewCtx(state, data);
  return list.map((n) => nodeView(state, data, n, vc));
};

/** Era rows for the era bar: loaded eras with counts, unloaded ones from techtree.preview. */
function eraRows(state, data) {
  const eras = data?.eras?.eras || [];
  const counts = {};
  const unlocked = new Set(state.research?.unlocked || []);
  for (const n of visibleNodes(state, data)) {
    const e = gating.eraIdOf(n);
    const c = (counts[e] ||= { total: 0, done: 0, unlock: 0 });
    c.total++;
    if (unlocked.has(n.id)) c.done++;
    if (gating.nodeKind(n) === 'unlock') c.unlock++;
  }
  const ids = eras.length ? eras.map((e) => e.id) : Object.keys(counts).sort();
  const curYear = yearAt(state);
  return ids.map((id) => {
    const e = eras.find((x) => x.id === id) || {};
    const c = counts[id];
    const pv = data?.techtree?.preview?.[id] || null;
    const from = e.from?.year ?? null, to = e.to?.year ?? null;
    return {
      id, name: e.name || id, from, to, current: from != null && curYear >= from && (to == null || curYear <= to),
      loaded: !!c, total: c?.total ?? pv?.count ?? 0, done: c?.done ?? 0, unlockCount: c?.unlock ?? pv?.unlockCount ?? 0,
      preview: c ? null : pv,
    };
  });
}

export const queries = {
  'research/tree': (state, data) => treeViews(state, data),
  'research/node': (state, data, id) => {
    const n = nodeById(data, id);
    return n && isVisible(state, n) ? nodeView(state, data, n) : null;
  },
  /** Views of one era's nodes only (MISSIONS-V2 §6.3). */
  'research/era': (state, data, eraId) => treeViews(state, data, visibleNodes(state, data).filter((n) => gating.eraIdOf(n) === eraId)),
  /** Era bar rows: [{id, name, from, to, current, loaded, total, done, unlockCount, preview}]. */
  'research/eras': (state, data) => eraRows(state, data),
  /** Up to n unlock nodes of an era the player can work on now (active first, then available by year and cost). */
  'research/nextUnlocks': (state, data, eraId, n = 3) => {
    const list = visibleNodes(state, data).filter((x) => gating.nodeKind(x) === 'unlock' && (!eraId || gating.eraIdOf(x) === eraId));
    const views = treeViews(state, data, list).filter((v) => v.status === 'available' || v.status === 'active');
    const rank = (v) => (v.status === 'active' ? 0 : 1);
    return views.sort((a, b) => rank(a) - rank(b) || (a.histYear ?? a.fromYear ?? 0) - (b.histYear ?? b.fromYear ?? 0) || a.science - b.science || (a.id < b.id ? -1 : 1)).slice(0, n);
  },
  /** Legend: the unlock kinds with researched/total unlock nodes of each (by primary kind). */
  'research/kinds': (state, data) => {
    const unlocked = new Set(state.research?.unlocked || []);
    const out = gating.kindsOf(data).map((k) => ({ ...k, total: 0, done: 0 }));
    const by = Object.fromEntries(out.map((k) => [k.id, k]));
    for (const n of visibleNodes(state, data)) {
      const k = by[gating.unlockKindOf(n)];
      if (!k) continue;
      k.total++;
      if (unlocked.has(n.id)) k.done++;
    }
    return out;
  },
  /** Unlock keys the player holds (sorted). */
  'research/keys': (state, data) => (Array.isArray(state.research?.keys) ? state.research.keys.slice() : gating.keysOfNodes(data, state.research?.unlocked || [])),
  /** What a key unlocks in the catalog now: {names, more, total}. */
  'research/targets': (state, data, key) => gating.unlockTargets(data, state, key),
  'research/branches': (state, data) => data?.tech?.branches || [],
  'research/points': (state) => Math.floor(state.research?.points || 0),
  'research/summary': (state, data) => ({
    points: Math.floor(state.research?.points || 0),
    perWeek: passiveLeft(state, data) > 0 ? sciencePerWeek(state, data) : 0,
    labRate: sciencePerWeek(state, data),
    passiveLeft: Number.isFinite(passiveLeft(state, data)) ? Math.round(passiveLeft(state, data)) : null,
    passivePool: passivePool(state, data),
    earned: state.research?.earned || 0,
    active: state.research?.projects?.length || 0,
    slots: maxProjects(state, data),
    unlocked: state.research?.unlocked?.length || 0,
    total: nodesOf(data).filter((n) => isVisible(state, n)).length,
    engineerFactor: round2(engineerFactor(state, data)),
    bonus: { ...(state.research?.bonus?.[state.playerId] || {}) },
    approaches: cfg(data).approaches,
    gated: gating.techGated(state, data),
    migratedGrant: state.research?.migratedGrant || 0,
  }),
  'research/rivals': (state, data) =>
    Object.entries(state.research?.rivals || {}).map(([id, list]) => {
      const proj = state.research?.rivalProjects?.[id];
      return {
        actorId: id, name: actorName(state, id), unlocked: list.length,
        aheadOfPlayer: list.filter((x) => !(state.research?.unlocked || []).includes(x)).length,
        current: proj ? { nodeId: proj.nodeId, name: nodeById(data, proj.nodeId)?.name || proj.nodeId, progress: proj.progress } : null,
      };
    }).sort((a, b) => b.unlocked - a.unlocked),
  'research/bonus': (state, data, actorId, key) => techBonus(state, actorId ?? state.playerId, key),
};


// ---------- 1950–3000 contract (EXPANSION.md §1.5, §3) ----------

/**
 * Weekly science, project progress and rival research, dt-native: a tick covers up to a quarter (13 weeks) at once
 * (science and spending × dt, the bold approach's weekly surprise as one chance over the window, rivals carry spare
 * weeks into their next project). The 52-week steps of the far future run 4 ticks a year instead of 52.
 */
export const meta = { maxDt: 13 };

/** A born actor starts with the techs data gives it (initialFor), like the founding rivals. */
export function onActorBorn(state, data, ctx, id) {
  if (!state.research || id === state.playerId) return;
  ensureRivals(state, data);
}

/** A dead actor's research leaves the slice (its techs die with it, or live on in `into`). */
export function onActorGone(state, data, ctx, id, info = {}) {
  const r = state.research;
  if (!r) return;
  const into = info?.into;
  if (into && into !== state.playerId && r.rivals?.[into] && r.rivals?.[id]) {
    for (const n of r.rivals[id]) if (!r.rivals[into].includes(n)) r.rivals[into].push(n);
    recompute(state, data, into);
  }
  if (r.rivals) delete r.rivals[id];
  if (r.rivalProjects) delete r.rivalProjects[id];
  if (r.bonus) delete r.bonus[id];
}

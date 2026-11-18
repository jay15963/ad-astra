// Research & tech tree (module "research", slice state.research).
// - Player projects: safe (slow, predictable) or bold (faster, may surprise: leaps, setbacks, breakthroughs, latent flaws).
// - Science points (from missions via addSciencePoints, labs and engineers weekly) are spent to START a project;
//   money (US$ mi) is paid weekly via budget.spend('research') in proportion to progress.
// - Secret nodes appear when an event flag is set (state.events.flags[unlockedBy]) or a signal reveals them.
// - Rival actors research in parallel (state.research.rivals) and get techBonus too.
// techBonus() reads a cached per-actor effect table (state.research.bonus) so it needs no `data` argument.

import { addNews, emitSignal, clamp, changeActor, pushDecision, removeDecision } from '../core/helpers.js';
import * as budget from './budget.js';
import { yearAt, inYearWindow, legacyFromYear } from './simtime.js';

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
const cfg = (data) => ({ ...DEFAULT_CFG, ...(data?.tech?.config || {}) });
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
  return r;
}

function actorName(state, id) {
  const a = state.actors?.[id];
  return a ? `${a.flag ? a.flag + ' ' : ''}${a.short || a.name || id}` : id;
}

// ---------- effects / bonus cache ----------

/** Sum of a node list's effects (times quality multipliers), as {key: value}. */
function sumEffects(data, ids, quality = {}) {
  const out = {};
  for (const id of ids || []) {
    const n = nodeById(data, id);
    if (!n?.effects) continue;
    const q = quality[id] ?? 1;
    for (const [k, v] of Object.entries(n.effects)) {
      if (typeof v !== 'number') continue;
      out[k] = (out[k] || 0) + v * q;
    }
  }
  for (const k of Object.keys(out)) out[k] = round2(out[k] * 1000) / 1000; // avoid float noise (keeps 5 decimals)
  for (const k of ['commandPoints', 'researchSlots']) if (out[k] != null) out[k] = Math.floor(out[k] + 1e-9);
  return out;
}

function unlockedFor(state, actorId) {
  const r = state.research;
  if (!r) return [];
  return actorId === state.playerId ? r.unlocked || [] : r.rivals?.[actorId] || [];
}

function recompute(state, data, actorId) {
  const r = ensure(state);
  const isPlayer = actorId === state.playerId;
  r.bonus[actorId] = sumEffects(data, unlockedFor(state, actorId), isPlayer ? r.quality : {});
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

function sciencePerWeek(state, data) {
  const c = cfg(data);
  const engs = Object.values(state.crew || {}).filter(
    (p) => p && p.actorId === state.playerId && p.role === 'engineer' && p.status === 'active',
  ).length;
  return round2((c.baseSciencePerWeek || 0) + engs * (c.engineerSciencePerWeek || 0) + techBonus(state, state.playerId, 'sciencePerWeek'));
}

// ---------- effect text (pt-BR) ----------

/** ["+2 p.p. confiabilidade das missões", "−6% custo de lançamento", ...] */
export function describeEffects(data, effects = {}, mult = 1) {
  const labels = data?.tech?.effectLabels || {};
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

export function init(state, data, ctx) {
  lastData = data;
  const r = ensure(state);
  r.points = cfg(data).startPoints ?? 30;
  r.unlocked = nodesOf(data).filter((n) => (n.initialFor || []).includes(state.playerId)).map((n) => n.id);
  ensureRivals(state, data);
  recompute(state, data, state.playerId);
}

/** Rivals = every actor except the player. Added lazily so a late diplomacy init still works. */
function ensureRivals(state, data) {
  const r = ensure(state);
  for (const id of Object.keys(state.actors || {})) {
    if (id === state.playerId || r.rivals[id]) continue;
    r.rivals[id] = nodesOf(data).filter((n) => !n.secret && (n.initialFor || []).includes(id)).map((n) => n.id);
    recompute(state, data, id);
  }
}

// ---------- tick ----------

export function tick(state, data, ctx) {
  lastData = data;
  const r = ensure(state);
  if (r.needsRecompute) { recompute(state, data, state.playerId); delete r.needsRecompute; }
  ensureRivals(state, data);
  revealSecrets(state, data);

  // weekly science from labs + engineering team
  addSciencePoints(state, sciencePerWeek(state, data));
  // tech-transfer treaties (diplomacy emits 'diplomacy/techTransfer' at signing and every quarter)
  for (const s of state.signals || []) {
    if (s?.type !== 'diplomacy/techTransfer' || s.actorId !== state.playerId || !(s.points > 0)) continue;
    const from = state.actors?.[s.partnerId]?.short || s.partnerId || 'parceiro';
    addSciencePoints(state, Math.round(s.points), `transferência de tecnologia: ${from}`);
  }

  // player projects
  for (const p of r.projects.slice()) advanceProject(state, data, ctx, p);

  // rivals
  for (const id of Object.keys(r.rivals)) if (state.actors?.[id]) advanceRival(state, data, ctx, id);
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

function advanceProject(state, data, ctx, p) {
  const node = nodeById(data, p.nodeId);
  const r = state.research;
  if (!node) { r.projects = r.projects.filter((x) => x !== p); return; }
  const ac = approachCfg(data, p.approach);
  const inc = Math.min(1 - p.progress, weeklySpeed(state, data, p.approach) / Math.max(1, p.weeks || node.weeks || 10));
  const amount = round2((p.cost || 0) * inc);
  if (!pay(state, state.playerId, amount, 'research', `P&D: ${node.name}`)) {
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
    if (rng.chance(ac.weeklyEventChance)) {
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

function advanceRival(state, data, ctx, id) {
  const r = state.research;
  const has = r.rivals[id] || (r.rivals[id] = []);
  let proj = r.rivalProjects[id];
  if (!proj) {
    const options = nodesOf(data).filter((n) => !n.secret && !has.includes(n.id) && requiresMet(has, n) && nodeOpen(state, data, n));
    if (!options.length) return;
    const rng = ctx.rng(`rival-pick:${id}`);
    const actor = state.actors?.[id];
    const pick = rng.weighted(options, (n) => rivalWeight(actor, n));
    if (!pick) return;
    const bold = (actor?.culture ?? 0) > (cfg(data).rivals?.boldCultureThreshold ?? 30);
    proj = r.rivalProjects[id] = { nodeId: pick.id, progress: 0, startedTurn: state.turn, bold };
  }
  const node = nodeById(data, proj.nodeId);
  if (!node) { delete r.rivalProjects[id]; return; }
  proj.progress = round2((proj.progress + rivalSpeed(state, data, id) * (proj.bold ? 1.3 : 1) / Math.max(1, node.weeks || 20)) * 1000) / 1000;
  if (proj.progress < 1) return;
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

function nodeView(state, data, n) {
  const r = state.research || {};
  const unlocked = r.unlocked || [];
  const proj = (r.projects || []).find((p) => p.nodeId === n.id);
  const done = unlocked.includes(n.id);
  let status = 'locked';
  if (done && !proj) status = 'done';
  else if (proj) status = 'active';
  else if (requiresMet(unlocked, n) && nodeOpen(state, data, n)) status = 'available';
  const speedSafe = weeklySpeed(state, data, 'safe');
  const speedBold = weeklySpeed(state, data, 'bold');
  const q = r.quality?.[n.id] ?? 1;
  const branch = (data?.tech?.branches || []).find((b) => b.id === n.branch);
  const eta = proj
    ? Math.ceil(((1 - proj.progress) * (proj.weeks || n.weeks || 10)) / weeklySpeed(state, data, proj.approach))
    : null;
  return {
    id: n.id, branch: n.branch, branchName: branch?.name || n.branch, name: n.name, description: n.description,
    era: n.era, secret: !!n.secret, status, fromYear: n.fromYear ?? null, icon: n.icon || null, short: n.short || null,
    tier: n.tier ?? null, row: n.row ?? null,
    cost: nodeMoneyCost(state, data, n, 'safe'), costBold: nodeMoneyCost(state, data, n, 'bold'),
    science: n.science || 0, canAffordScience: (r.points || 0) >= (n.science || 0),
    weeks: Math.ceil((n.weeks || 10) / speedSafe), weeksBold: Math.ceil((n.weeks || 10) / speedBold),
    requires: n.requires || [], requiresNames: (n.requires || []).map((id) => nodeById(data, id)?.name || id),
    effects: n.effects || {}, effectText: describeEffects(data, n.effects, done ? q : 1),
    quality: done ? q : null, canRefine: done && q < 1 && !proj,
    progress: proj ? proj.progress : done ? 1 : 0, approach: proj?.approach || null, stalled: !!proj?.stalled,
    refining: !!proj?.refine, etaWeeks: eta, spent: proj?.spent || 0, projectCost: proj?.cost || null,
    rivalsWith: Object.entries(r.rivals || {}).filter(([, l]) => l.includes(n.id)).map(([id]) => id),
  };
}

export const queries = {
  'research/tree': (state, data) => nodesOf(data).filter((n) => isVisible(state, n)).map((n) => nodeView(state, data, n)),
  'research/node': (state, data, id) => {
    const n = nodeById(data, id);
    return n && isVisible(state, n) ? nodeView(state, data, n) : null;
  },
  'research/branches': (state, data) => data?.tech?.branches || [],
  'research/points': (state) => Math.floor(state.research?.points || 0),
  'research/summary': (state, data) => ({
    points: Math.floor(state.research?.points || 0),
    perWeek: sciencePerWeek(state, data),
    earned: state.research?.earned || 0,
    active: state.research?.projects?.length || 0,
    slots: maxProjects(state, data),
    unlocked: state.research?.unlocked?.length || 0,
    total: nodesOf(data).filter((n) => isVisible(state, n)).length,
    engineerFactor: round2(engineerFactor(state, data)),
    bonus: { ...(state.research?.bonus?.[state.playerId] || {}) },
    approaches: cfg(data).approaches,
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

/** Weekly science and project progress: substepped week by week by the engine. */
export const meta = { maxDt: 1 };

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

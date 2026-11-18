// Diplomacy: actors, relations, blocs, treaties, proposals, utility-based AI and the Tabela da Era.
// No script: every alliance is born, cools and breaks from state (trust, dependence, rivalry, tension,
// budget pressure, goals and culture). Pure JS, deterministic (ctx.rng / rngFor only), JSON state.
import { clamp, relKey, nextId, addNews, pushDecision, emitSignal, changeActor, log, firstValue, milestoneShare } from '../core/helpers.js';
import { crossed, yearAt, liveActorIds, aiGoals } from './simtime.js';
const DATA_REF = { data: null }; // last data seen by tick/init (goals by era read the lineage table)
import { rngFor } from '../core/rng.js';
import * as politics from './politics.js';

// ---------------------------------------------------------------- constants
export const BILATERAL_TYPES = ['mission_partnership', 'cost_sharing', 'crew_exchange', 'tech_transfer'];
export const NORM_TYPES = ['peaceful_use', 'lunar_resources', 'orbital_traffic'];
export const PROPOSAL_TYPES = [...BILATERAL_TYPES, ...NORM_TYPES, 'join_bloc'];

const ACCEPT_T = 8;      // acceptance threshold (utility)
const PROPOSE_T = 24;    // AI only proposes when the best option clears this
const BREAK_T = 22;      // AI breaks a treaty above this
const LEAVE_T = 2;       // AI leaves its bloc above this (the drivers are real causes: government, tension, money)
const LEAVE_INERTIA = 20; // base reluctance to walk out of a bloc (utility points)
const ALIGN_NEUTRAL = 0.35; // government alignment (politics) at which the bloc is neither a pull nor a push
const ALIGN_W = 30;       // utility per point of alignment below/above ALIGN_NEUTRAL
const NEW_GOV_W = 16;     // a new government reviews its commitments (decays over NEW_GOV_WEEKS)
const NEW_GOV_WEEKS = 52;
const SEEDED_GRACE_WEEKS = 26; // default protection of the starting treaties
const STRAIN_K = 0.04;   // monthly chance factor of an AI-AI rupture under strain (rivalry above trust)
const STRAIN_OFFSET = 25; // even a lukewarm partnership (trust barely above rivalry) can sour
const JOIN_T = 14;       // blocless AI asks to join a bloc above this
const NOISE = 6;         // sd of the decision noise
const PLAYER_PROPOSAL_GAP = 8;   // weeks between AI proposals to the player
const PROPOSAL_TTL = 6;          // weeks the player has to answer
const REJECT_MEMORY = 26;        // weeks an actor remembers a refusal
const REFUSAL_TRUST = 1;         // trust lost when a player proposal is refused (2x for a counter-proposal)
const BREAK_MEMORY = 156;        // weeks an actor remembers a betrayal
const INCIDENT_MEMORY = 52;     // weeks before the same actor stars in the same kind of incident again

const DEFAULT_REL = { trust: 0, dependence: 0, rivalry: 10 };

// ---------------------------------------------------------------- small utils
const A = (data) => data?.actors || {};
// core-tier actors only (EXPANSION.md §3.1: minor actors have no relation rows); every actor is core in the Corrida Lunar
const sortedIdsRaw = (state) => liveActorIds(state, { tier: 'core' }).filter((id) => state.actors?.[id]).sort();
// Read-only memo for one AI evaluation (aiEvaluate builds its candidate list without touching the state): the
// actor list, the active treaties (indexed by pair) and the era goals are computed once instead of once per deal.
let SCOPE = null;
const sortedIds = (state) => (SCOPE?.state === state ? SCOPE.ids : sortedIdsRaw(state));
const yearOf = (state, turn = state.turn) => yearAt(state, turn);
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (f) => `${Math.round(f * 100)}%`;

function typeDef(data, type) {
  return (A(data).proposalTypes || []).find((t) => t.id === type)
    || { id: type, name: type, treatyName: type, durationWeeks: 104, base: 0, budgetWeight: 0, cultureWeight: 0, breakReputation: 6, allowCompanies: true };
}
const typeName = (data, type) => typeDef(data, type).name || type;
function programDef(data, id) {
  return (A(data).programs || []).find((p) => p.id === id) || (id ? { id, name: id, milestone: null, appeal: 0 } : null);
}
const milestoneLabel = (data, id) => {
  if (!id) return '';
  const base = String(id).split(':')[0];
  // actors.json lists the race milestones; events.json / bodies.json name the solar-system ones (never show a raw id)
  return A(data).milestones?.[id] || A(data).milestones?.[base] || data?.events?.milestones?.[base] || data?.bodies?.milestoneLabels?.[base] || id;
};
const short = (state, id) => state.actors?.[id]?.short || id;
const listNames = (state, ids) => {
  const n = ids.map((i) => short(state, i));
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} e ${n[n.length - 1]}`;
};
const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));

/** Pick a pt-BR template from data.actors.texts[key] (optionally [key][sub]). */
function txt(data, rng, key, sub, vars, fallback) {
  let list = A(data).texts?.[key];
  if (sub && list && !Array.isArray(list)) list = list[sub];
  const tpl = Array.isArray(list) && list.length ? (rng ? rng.pick(list) : list[0]) : fallback;
  return fill(tpl || '', vars);
}

const isCompany = (state, id) => state.actors?.[id]?.kind === 'company';
const isPlayer = (state, id) => id === state.playerId;

// ---------------------------------------------------------------- public helpers (contract)

/** Relation between two actors (read-only view; defaults when missing). */
export function relation(state, a, b) {
  return state.relations?.[relKey(a, b)] || { ...DEFAULT_REL };
}
function rel(state, a, b) {
  const k = relKey(a, b);
  if (!state.relations[k]) state.relations[k] = { ...DEFAULT_REL };
  return state.relations[k];
}
/** Change a relation with clamping. delta: {trust?, dependence?, rivalry?} */
export function bumpRelation(state, a, b, delta) {
  if (!a || !b || a === b || !state.actors?.[a] || !state.actors?.[b]) return;
  const r = rel(state, a, b);
  if (delta.trust) r.trust = round(clamp(r.trust + delta.trust, -100, 100));
  if (delta.dependence) r.dependence = round(clamp(r.dependence + delta.dependence, 0, 100));
  if (delta.rivalry) r.rivalry = round(clamp(r.rivalry + delta.rivalry, 0, 100));
}

/** Bloc object of an actor, or null. */
export function blocOf(state, actorId) {
  for (const b of Object.values(state.blocs || {})) if (b.members?.includes(actorId)) return b;
  return null;
}

const activeTreatiesRaw = (state) => (state.treaties || []).filter((t) => t.status === 'active');
const activeTreaties = (state) => (SCOPE?.state === state ? SCOPE.active : activeTreatiesRaw(state));
function treatiesBetween(state, a, b, type) {
  if (SCOPE?.state === state) {
    const list = SCOPE.byPair.get(relKey(a, b)) || [];
    return type ? list.filter((t) => t.type === type) : list.slice();
  }
  return activeTreaties(state).filter((t) => t.parties.includes(a) && t.parties.includes(b) && (!type || t.type === type));
}
function openScope(state, data) {
  const active = activeTreatiesRaw(state);
  const byPair = new Map();
  for (const t of active) {
    const ps = [...new Set(t.parties || [])];
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const k = relKey(ps[i], ps[j]);
      const l = byPair.get(k);
      if (l) l.push(t); else byPair.set(k, [t]);
    }
  }
  SCOPE = { state, data, ids: sortedIdsRaw(state), active, byPair, goals: new Map(), views: new Map(), rivals: new Map() };
}

/** True when a and b share an active treaty/partnership (the universal peaceful-use baseline does not count). */
export function isPartner(state, a, b) {
  if (a === b) return false;
  return treatiesBetween(state, a, b).some((t) => t.type !== 'peaceful_use');
}

/** Discount fraction (0..0.5) a gets on joint missions with b thanks to cost-sharing treaties. */
export function costShare(state, a, b) {
  if (!a || !b || a === b) return 0;
  let s = 0;
  for (const t of treatiesBetween(state, a, b, 'cost_sharing')) s += t.terms?.share || 0;
  return clamp(round(s, 2), 0, 0.5);
}

/** Political tension 0..4 (politics module; falls back to the raw slice). */
export function tensionOf(state, a, b) {
  let t;
  try { t = typeof politics.tensionBetween === 'function' ? politics.tensionBetween(state, a, b) : undefined; } catch { t = undefined; }
  if (typeof t !== 'number' || Number.isNaN(t)) t = state.tension?.[relKey(a, b)];
  return typeof t === 'number' ? clamp(t, 0, 4) : 0;
}

// ---------------------------------------------------------------- derived views

const goalsOf = (state, id) => {
  if (SCOPE?.state !== state || SCOPE.data !== DATA_REF.data) return aiGoals(state, DATA_REF.data, id);
  let g = SCOPE.goals.get(id);
  if (!g) { g = aiGoals(state, DATA_REF.data, id); SCOPE.goals.set(id, g); }
  return g;
};
function sharedOpenGoals(state, a, b) {
  const gb = new Set(goalsOf(state, b));
  return goalsOf(state, a).filter((g) => gb.has(g) && !state.firsts?.[g]);
}

/** 0..1, how much an actor needs to save money (cash, crisis, politics). */
export function budgetPressure(state, id) {
  const ac = state.actors?.[id];
  if (!ac) return 0;
  const ratio = (ac.cash ?? ac.budget * 0.25) / Math.max(1, ac.budget || 1);
  let p = clamp((0.3 - ratio) / 0.5, 0, 1);
  if (state.world?.economy?.[id]?.crisis) p += 0.35;
  const stance = state.politics?.[id]?.stance;
  if (typeof stance === 'number') p += clamp(-stance, 0, 1) * 0.3;
  if (ac.ai?.memory?.budgetCutTurn != null && state.turn - ac.ai.memory.budgetCutTurn < 52) p += 0.2;
  return clamp(p, 0, 1);
}

function view(state, a, b) {
  if (SCOPE?.state === state) {
    const k = `${a}>${b}`;
    let v = SCOPE.views.get(k);
    if (!v) { v = viewRaw(state, a, b); SCOPE.views.set(k, v); }
    return v;
  }
  return viewRaw(state, a, b);
}
function viewRaw(state, a, b) {
  const r = relation(state, a, b);
  const ba = blocOf(state, a), bb = blocOf(state, b);
  const bil = treatiesBetween(state, a, b).filter((t) => t.type !== 'peaceful_use' && !t.terms?.multilateral).length;
  const multi = treatiesBetween(state, a, b).filter((t) => t.terms?.multilateral).length;
  return {
    trust: r.trust, rivalry: r.rivalry, dependence: r.dependence,
    tension: tensionOf(state, a, b),
    sameBloc: !!(ba && bb && ba.id === bb.id),
    opposing: !!(ba && bb && ba.id !== bb.id),
    shared: sharedOpenGoals(state, a, b),
    bilateral: bil, multilateral: multi,
  };
}
const bilateralLoad = (state, id) =>
  activeTreaties(state).filter((t) => t.parties.includes(id) && !t.terms?.multilateral && t.type !== 'peaceful_use').length;

/** Strongest rival both actors share (min of the two rivalries), 0..100. */
function commonRival(state, a, b) {
  if (SCOPE?.state === state) {
    const k = relKey(a, b);
    let v = SCOPE.rivals.get(k);
    if (v == null) { v = commonRivalRaw(state, a, b); SCOPE.rivals.set(k, v); }
    return v;
  }
  return commonRivalRaw(state, a, b);
}
function commonRivalRaw(state, a, b) {
  let best = 0;
  const R = state.relations || {};
  for (const c of sortedIds(state)) {
    if (c === a || c === b) continue;
    const ra = (R[relKey(a, c)] || DEFAULT_REL).rivalry, rb = (R[relKey(b, c)] || DEFAULT_REL).rivalry;
    best = Math.max(best, Math.min(ra, rb));
  }
  return best;
}

function memoryOf(state, id) {
  const ac = state.actors[id];
  ac.ai = ac.ai || {};
  ac.ai.memory = ac.ai.memory || {};
  const m = ac.ai.memory;
  m.rejected = m.rejected || {};
  m.brokenBy = m.brokenBy || {};
  m.withdrew = m.withdrew || {};
  return m;
}
const remembers = (state, id, kind, key, weeks) => {
  const t = state.actors?.[id]?.ai?.memory?.[kind]?.[key];
  return t != null && state.turn - t < weeks;
};

// ---------------------------------------------------------------- utility model

class Factors {
  constructor() { this.list = []; this.u = 0; }
  add(label, v) { if (!v) return this; this.u += v; this.list.push({ label, delta: round(v) }); return this; }
  top(n = 2, sign = 1) {
    return this.list.filter((f) => f.delta * sign > 0).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, n).map((f) => f.label);
  }
}

function typeAllowed(state, data, type, a, b) {
  const td = typeDef(data, type);
  if (!td.allowCompanies && (isCompany(state, a) || isCompany(state, b))) return false;
  if (type === 'crew_exchange') {
    const ca = state.actors[a]?.capabilities?.crewed, cb = state.actors[b]?.capabilities?.crewed;
    if (!ca && !cb) return false;
  }
  return true;
}

/** Best partnership program for (self, other): avoids the milestones they race for. */
function pickProgram(state, data, self, other, rng) {
  const S = state.actors[self], O = state.actors[other];
  const v = view(state, self, other);
  const used = new Set(treatiesBetween(state, self, other, 'mission_partnership').map((t) => t.terms?.program));
  let best = null;
  for (const p of A(data).programs || []) {
    if (used.has(p.id)) continue;
    let s = p.appeal || 0;
    if (p.milestone && goalsOf(state, self).includes(p.milestone)) s += 8;
    if (p.milestone && goalsOf(state, other).includes(p.milestone)) s += 5;
    if (p.milestone && state.firsts?.[p.milestone]) s -= 4; // the race is over, less glamour
    if (p.milestone && v.shared.includes(p.milestone)) s -= v.rivalry * 0.3; // they race for it: no sharing
    if (!p.milestone) s += v.rivalry * 0.1 + (v.opposing ? 4 : 0); // neutral science is the safe bridge between rivals
    if (p.needsCrewed && !S?.capabilities?.crewed && !O?.capabilities?.crewed) s -= 30;
    s += rng ? rng.range(0, 2) : 0;
    if (!best || s > best.s) best = { p, s };
  }
  return best ? { program: best.p.id, score: best.s } : { program: null, score: -10 };
}

/** Builds default terms for a proposal from `self` to `other`. */
export function defaultTerms(state, data, type, self, other, rng) {
  const S = state.actors[self], O = state.actors[other];
  switch (type) {
    case 'mission_partnership': return { program: pickProgram(state, data, self, other, rng).program, lead: self };
    case 'cost_sharing': {
      const bp = Math.max(budgetPressure(state, self), budgetPressure(state, other));
      return { share: clamp(Math.round((0.1 + bp * 0.2) * 20) / 20, 0.1, 0.3) };
    }
    case 'crew_exchange': return { seats: relation(state, self, other).trust > 50 ? 2 : 1 };
    case 'tech_transfer': {
      const sGives = (S?.budget || 0) >= (O?.budget || 0);
      const giver = sGives ? self : other, receiver = sGives ? other : self;
      const gap = clamp(((state.actors[giver]?.budget || 1) - (state.actors[receiver]?.budget || 1)) / Math.max(1, state.actors[receiver]?.budget || 1), 0, 3);
      return { giver, receiver, points: Math.round(15 + gap * 12) };
    }
    case 'join_bloc': {
      const b = blocOf(state, self);
      return b ? { blocId: b.id, member: other } : { blocId: blocOf(state, other)?.id, member: self };
    }
    default: return {};
  }
}

/**
 * Utility for `self` of a bilateral deal with `other` (role 'propose' or 'accept').
 * Returns a Factors object (u + readable reasons).
 */
export function dealUtility(state, data, self, other, type, terms = {}, role = 'propose') {
  const f = new Factors();
  const S = state.actors[self], O = state.actors[other];
  if (!S || !O) return f.add('ator desconhecido', -999);
  if (type === 'join_bloc') return joinBlocUtility(state, data, self, other, terms, role);
  const td = typeDef(data, type);
  const v = view(state, self, other);
  if (v.tension >= 3) return f.add('conflito aberto', -999);
  if (!typeAllowed(state, data, type, self, other)) return f.add('não se aplica', -999);
  const ai = S.ai || {};
  f.add('valor do acordo', td.base || 0);
  f.add('confiança', v.trust * 0.3);
  f.add('rivalidade', -v.rivalry * 0.25);
  f.add('tensão política', -v.tension * 12);
  if (v.sameBloc) f.add('mesmo bloco', 10);
  if (v.opposing) f.add('blocos rivais', -14);
  f.add('perfil cooperativo', ((ai.cooperation ?? 0.5) - 0.5) * 30);
  f.add('agressividade', -(ai.aggression ?? 0.5) * 8);
  f.add('reputação do parceiro', ((O.reputation ?? 50) - 50) * 0.12);
  f.add('agenda cheia', -5 * bilateralLoad(state, self));
  f.add('já temos acordos', -7 * v.bilateral);
  f.add('laços existentes', v.dependence * 0.08);
  f.add('verba apertada', budgetPressure(state, self) * (td.budgetWeight || 0));
  f.add('cultura', ((S.culture || 0) / 100) * (td.cultureWeight || 0));
  if (remembers(state, self, 'brokenBy', other, BREAK_MEMORY)) f.add('já rompeu conosco', -25);
  f.add('rival em comum', commonRival(state, self, other) * 0.18);

  const budgetRatio = (O.budget || 1) / Math.max(1, S.budget || 1);
  switch (type) {
    case 'mission_partnership': {
      const p = programDef(data, terms.program);
      if (!p) { f.add('sem programa', -20); break; }
      if (p.milestone && goalsOf(state, self).includes(p.milestone)) f.add(`meta: ${milestoneLabel(data, p.milestone)}`, 8);
      if (p.milestone && v.shared.includes(p.milestone)) f.add(`disputam ${milestoneLabel(data, p.milestone)}`, -v.rivalry * 0.25);
      if (!p.milestone) {
        // science diplomacy: neutral programs are the bridge between rivals and blocs
        f.add('ciência neutra', 3 + v.rivalry * 0.12 + (v.opposing ? 10 : 0) * (0.5 + (ai.cooperation ?? 0.5)));
      }
      if (p.needsCrewed && !S.capabilities?.crewed && !O.capabilities?.crewed) f.add('ninguém voa tripulado', -30);
      f.add('peso do parceiro', clamp(Math.log2(budgetRatio) * 3, -6, 6));
      if (role === 'accept' && terms.lead && terms.lead !== self) f.add('liderança do outro', -2);
      if (role === 'accept' && terms.lead === self) f.add('liderança nossa', 4);
      break;
    }
    case 'cost_sharing': {
      const share = terms.share ?? 0.15;
      f.add('desconto', share * 20);
      if (role === 'accept' && terms.counterAsk) f.add('contraproposta exigente', -terms.counterAsk * 60);
      break;
    }
    case 'crew_exchange': {
      const sc = S.capabilities?.crewed, oc = O.capabilities?.crewed;
      if (!sc && oc) f.add('vagas em naves tripuladas', 14);
      else if (sc && !oc) f.add('ceder assentos', -4 + (ai.cooperation ?? 0.5) * 4);
      else f.add('intercâmbio', 3);
      f.add('assentos', -(Math.max(0, (terms.seats || 1) - 1)) * (sc ? 4 : -2));
      break;
    }
    case 'tech_transfer': {
      const receives = terms.receiver === self;
      if (receives) f.add('aprender tecnologia', 10 + clamp(budgetRatio - 1, 0, 3) * 4);
      else {
        f.add('ceder tecnologia', -9 - (terms.points || 20) * 0.1);
        f.add('influência', (ai.aggression ?? 0.5) * 6 + clamp(1 / Math.max(0.2, budgetRatio) - 1, 0, 4));
      }
      if (v.opposing) f.add('controle de exportação', -15);
      if (isCompany(state, self) && !receives) f.add('segredo comercial', -6);
      break;
    }
    default: { // bilateral norms
      f.add('normas', 2 + (ai.cooperation ?? 0.5) * 6);
      if (treatiesBetween(state, self, other, type).length) f.add('já assinado', -999);
    }
  }
  if (role === 'accept' && terms.counterAsk && type !== 'cost_sharing') f.add('contraproposta exigente', -terms.counterAsk * 30);
  return f;
}

/** Utility of a bloc membership change. member joins blocId; `self` is either the member or the bloc leader. */
function joinBlocUtility(state, data, self, other, terms, role) {
  const f = new Factors();
  const bloc = state.blocs?.[terms.blocId];
  const member = terms.member;
  if (!bloc || !member || bloc.members.includes(member)) return f.add('inválido', -999);
  const current = blocOf(state, member);
  if (current && current.id !== bloc.id) return f.add('já está em outro bloco', -999);
  const leader = bloc.leader;
  if (self === member) {
    const v = view(state, member, leader);
    if (v.tension >= 3) return f.add('conflito com o líder', -999);
    f.add('base', 2);
    f.add('confiança no líder', v.trust * 0.4);
    f.add('rivalidade com o líder', -v.rivalry * 0.2);
    f.add('tensão com o líder', -v.tension * 12);
    const mates = bloc.members.filter((m) => m !== leader);
    if (mates.length) f.add('afinidade com membros', mates.reduce((s, m) => s + relation(state, member, m).trust, 0) / mates.length * 0.15);
    f.add('proteção de um bloco', 6 + budgetPressure(state, member) * 8);
    if (remembers(state, member, 'withdrew', bloc.id, 104)) f.add('saiu há pouco', -20);
    const lean = politics.blocAlignment?.(state, data, member, bloc.id);
    if (lean != null) f.add('alinhamento do governo', (lean - ALIGN_NEUTRAL) * ALIGN_W);
  } else {
    // leader (or any member) judging the applicant
    const v = view(state, self, member);
    if (v.tension >= 3) return f.add('conflito', -999);
    f.add('base', 6);
    f.add('confiança', v.trust * 0.35);
    f.add('rivalidade', -v.rivalry * 0.25);
    f.add('tensão', -v.tension * 10);
    f.add('peso do candidato', clamp(Math.log2((state.actors[member]?.budget || 1000) / 1000) * 4, -4, 8));
    f.add('reputação', ((state.actors[member]?.reputation ?? 50) - 50) * 0.15);
    if (remembers(state, self, 'brokenBy', member, BREAK_MEMORY)) f.add('quebrou acordos', -25);
  }
  return f;
}

/** Logistic estimate of P(accept) given expected utility (decision noise ~ NOISE). */
const chanceFrom = (u, t = ACCEPT_T) => (u < -500 ? 0 : 1 / (1 + Math.exp(-(u - t) / (NOISE * 0.6))));
function chanceLabel(p) {
  if (p >= 0.8) return 'muito provável';
  if (p >= 0.55) return 'provável';
  if (p >= 0.35) return 'incerta';
  if (p >= 0.12) return 'improvável';
  return 'quase impossível';
}

// ---------------------------------------------------------------- init

export function init(state, data) {
  DATA_REF.data = data;
  const src = A(data);
  state.actors = {};
  for (const raw of src.actors || []) {
    const ac = JSON.parse(JSON.stringify(raw));
    ac.cash = ac.cash ?? Math.round((ac.budget || 0) * 0.25);
    ac.prestige = ac.prestige ?? 0;
    ac.support = ac.support ?? 60;
    ac.reputation = ac.reputation ?? 60;
    ac.culture = ac.culture ?? 0;
    ac.fixedCostShare = ac.fixedCostShare ?? 0.5;
    ac.capabilities = ac.capabilities || { crewed: false, launchSites: [] };
    ac.ai = { cooperation: 0.5, aggression: 0.5, riskTolerance: 0.5, goals: [], ...(ac.ai || {}) };
    // private AI bookkeeping (stagger first evaluations so actors do not move in lockstep)
    ac.ai.nextEvalTurn = 1 + (rngFor(state.seed, 'diplomacy', 'stagger', ac.id).int(0, 5));
    ac.ai.memory = { rejected: {}, brokenBy: {}, withdrew: {} };
    ac.ai.prestigeHistory = [];
    ac.bloc = null;
    state.actors[ac.id] = ac;
  }
  // relations: every pair exists
  state.relations = {};
  const ids = sortedIds(state);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) state.relations[relKey(ids[i], ids[j])] = { ...DEFAULT_REL };
  for (const r of src.relations || []) {
    if (!state.actors[r.a] || !state.actors[r.b] || r.a === r.b) continue;
    state.relations[relKey(r.a, r.b)] = {
      trust: clamp(r.trust ?? 0, -100, 100), dependence: clamp(r.dependence ?? 0, 0, 100), rivalry: clamp(r.rivalry ?? 10, 0, 100),
    };
  }
  // blocs (members are the source of truth; actor.bloc mirrors it)
  state.blocs = {};
  for (const b of src.blocs || []) {
    const members = (b.members || []).filter((m) => state.actors[m]);
    state.blocs[b.id] = { ...JSON.parse(JSON.stringify(b)), members, leader: state.actors[b.leader] ? b.leader : members[0] || null };
  }
  syncActorBlocs(state);
  // treaties
  state.treaties = (src.treaties || []).map((t) => ({
    ...JSON.parse(JSON.stringify(t)),
    parties: (t.parties || []).filter((p) => state.actors[p]),
    status: t.status || 'active',
    signedTurn: t.signedTurn ?? 0,
    terms: { health: 60, ...(t.terms || {}) },
  }));
  // real arrangements of 2026 do not collapse in the first months: seeded bilateral deals are protected until
  // their own milestone (data: terms.protectedUntil) or for the first half year
  for (const t of state.treaties) {
    if (t.status !== 'active' || t.parties.length !== 2 || t.terms.multilateral) continue;
    if (t.terms.protectedUntil == null) t.terms.protectedUntil = SEEDED_GRACE_WEEKS;
  }
  for (const t of state.treaties) if (t.status === 'broken' && t.brokenBy) {
    for (const p of t.parties) if (p !== t.brokenBy && state.actors[p]) memoryOf(state, p).brokenBy[t.brokenBy] = t.brokenTurn ?? -999;
  }
  state.proposals = [];
}

function syncActorBlocs(state) {
  for (const ac of Object.values(state.actors)) ac.bloc = null;
  for (const b of Object.values(state.blocs)) for (const m of b.members) if (state.actors[m]) state.actors[m].bloc = b.id;
}

function ensureSlices(state) {
  state.relations = state.relations || {};
  state.blocs = state.blocs || {};
  state.treaties = state.treaties || [];
  state.proposals = state.proposals || [];
  for (const ac of Object.values(state.actors || {})) {
    ac.ai = ac.ai || { cooperation: 0.5, aggression: 0.5, goals: [] };
    if (ac.ai.nextEvalTurn == null) ac.ai.nextEvalTurn = state.turn + 1;
    ac.ai.prestigeHistory = ac.ai.prestigeHistory || [];
    memoryOf(state, ac.id);
  }
}

// ---------------------------------------------------------------- tick

export function tick(state, data, ctx) {
  DATA_REF.data = data;
  if (!state.actors || !Object.keys(state.actors).length) return;
  ensureSlices(state);
  const rng = ctx.rng('tick');
  readSignals(state, data, ctx.rng('signals'));
  driftRelations(state, data, rng);
  expireTreaties(state, data, ctx.rng('expire'));
  if (crossed(state, ctx, 4, 0)) {
    treatyUpkeep(state, data, ctx.rng('upkeep'));
    incidents(state, data, ctx.rng('incidents'));
  }
  if (crossed(state, ctx, 13, 0)) techTransfers(state, data);
  resolveDueProposals(state, data, ctx);
  for (const id of sortedIds(state)) {
    if (isPlayer(state, id)) continue;
    const ac = state.actors[id];
    if (state.turn < (ac.ai.nextEvalTurn ?? 0)) continue;
    const r = ctx.rng(`eval:${id}`);
    aiEvaluate(state, data, id, r);
    // long clock steps (13–52 weeks in the far future): the AI weighs deals less often, about as often per step as
    // the player sees the world move (stepWeeks 1 in the Corrida Lunar: unchanged)
    const slow = clamp((state.clock?.stepWeeks || 1) / 4, 1, 8);
    const every = Math.round(clamp(Math.round(6 - (ac.culture || 0) / 40), 3, 9) * slow);
    ac.ai.nextEvalTurn = state.turn + every + r.int(-1, 2);
  }
  if (crossed(state, ctx, 13, 0)) {
    for (const ac of Object.values(state.actors)) {
      ac.ai.prestigeHistory.push(Math.round(ac.prestige || 0));
      if (ac.ai.prestigeHistory.length > 24) ac.ai.prestigeHistory.shift();
    }
  }
  pruneTreaties(state);
}

// ---- signals from other modules
function readSignals(state, data, rng) {
  for (const s of state.signals || []) {
    try {
      switch (s.type) {
        case 'mission/resolved': onMissionResolved(state, data, s); break;
        case 'crew/died': onCrewDied(state, data, s, rng); break;
        case 'crew/rivalLost': onCrewDied(state, data, s, rng); break;
        case 'first': onFirst(state, data, s, rng); break;
        case 'tension/changed': onTension(state, data, s); break;
        case 'election': onElection(state, data, s, rng); break;
        case 'budget/changed': onBudgetChanged(state, data, s); break;
        case 'contract/awarded': onContract(state, data, s); break;
        default: break;
      }
    } catch (e) {
      log(state, `diplomacy: sinal ${s.type} ignorado (${e.message})`);
    }
  }
}

function onMissionResolved(state, data, s) {
  const a = s.actorId;
  if (!state.actors[a]) return;
  const ok = s.outcome === 'total' || s.outcome === 'partial';
  if (ok) {
    const pc = partnerCredit(data);
    creditPartners(state, data, s, (cal) => pc.share * pc.perImportance * (cal.importance || 1) * (s.crewed ? pc.crewedMult : 1) * (s.outcome === 'total' ? 1 : 0.45));
  }
  const cat = s.outcome === 'catastrophic';
  const cal = s.calendarId ? data.index?.calendar?.[s.calendarId] : null;
  const joint = new Set((cal?.partners || []).filter((p) => state.actors[p] && p !== a));
  for (const b of sortedIds(state)) {
    if (b === a) continue;
    if (joint.has(b)) {
      bumpRelation(state, a, b, ok ? { trust: 4, dependence: 1 } : cat ? { trust: -3 } : { trust: -1 });
      for (const t of treatiesBetween(state, a, b)) if (t.parties.length === 2) t.terms.health = clamp((t.terms.health ?? 60) + (ok ? 10 : -6), 0, 100);
    } else if (isPartner(state, a, b)) {
      bumpRelation(state, a, b, ok ? { trust: 1 } : {});
    }
    const v = relation(state, a, b);
    if (ok && v.rivalry >= 45 && s.crewed) bumpRelation(state, a, b, { rivalry: 2 });
  }
}

/**
 * Partners of a calendar program (ESA's service module on Orion, JAXA's rover on LUPEX) share the credit of a
 * success: each gets a slice of the program's prestige (importance-based) and, for a first, a slice of its value.
 * Tuning: data/actors.json "partnerCredit". The owner keeps all of its own points.
 */
function partnerCredit(data) {
  return { share: 0.25, crewedMult: 1.5, perImportance: 6, firstShare: 0.15, ...(A(data).partnerCredit || {}) };
}
function creditPartners(state, data, s, amountOf) {
  const cal = s.calendarId ? data.index?.calendar?.[s.calendarId] : null;
  if (!cal) return;
  for (const b of [...new Set(cal.partners || [])].sort()) {
    if (b === s.actorId || !state.actors[b]) continue;
    const pts = Math.round(amountOf(cal));
    if (pts <= 0) continue;
    changeActor(state, b, 'prestige', pts);
    if (isPlayer(state, b)) {
      addNews(state, {
        headline: txt(data, null, 'partnerCredit', null, { a: short(state, b), program: cal.name, pts }) || `${short(state, b)} divide os louros de ${cal.name} (+${pts} de prestígio)`,
        tags: ['diplomacia'], actors: [b, s.actorId], importance: 1, icon: '🤝',
      });
    }
  }
}

function onCrewDied(state, data, s, rng) {
  const a = state.crew?.[s.crewId]?.actorId || s.actorId;
  if (!state.actors[a]) return;
  // one tragedy, one round of condolences: crew/died comes once per person lost, in the same week
  const mem = memoryOf(state, a);
  const key = `${s.missionId ?? s.flightId ?? ''}@${s.turn ?? state.turn}`;
  if (mem.lastLossKey === key || (mem.lastLossTurn != null && state.turn - mem.lastLossTurn < 2)) return;
  mem.lastLossKey = key;
  mem.lastLossTurn = state.turn;
  let sent = false;
  for (const b of sortedIds(state)) {
    if (b === a) continue;
    bumpRelation(state, a, b, { trust: 2 });
    const v = relation(state, a, b);
    if (!sent && v.rivalry >= 55) {
      bumpRelation(state, a, b, { trust: 3 });
      addNews(state, {
        headline: txt(data, rng, 'condolences', null, { a: short(state, a), b: short(state, b) }),
        tags: ['diplomacia'], actors: [a, b], importance: 1, icon: '🕯️',
      });
      sent = true;
    }
  }
}

function onFirst(state, data, s, rng) {
  const a = s.actorId, m = s.milestoneId;
  if (!state.actors[a] || !m) return;
  const base = String(m).split(':')[0];
  {
    const pc = partnerCredit(data);
    creditPartners(state, data, s, (cal) => pc.firstShare * firstValue(state, m, (30 + 10 * (cal.importance || 1)) * milestoneShare(data, m)));
  }
  for (const b of sortedIds(state)) {
    if (b === a) continue;
    const wanted = goalsOf(state, b).includes(m) || goalsOf(state, b).includes(base);
    const sharedProgram = treatiesBetween(state, a, b, 'mission_partnership').some((t) => programDef(data, t.terms?.program)?.milestone === m);
    if (sharedProgram) bumpRelation(state, a, b, { trust: 5, dependence: 2 });
    else if (wanted) {
      bumpRelation(state, a, b, { rivalry: 6, trust: -2 });
      if (relation(state, a, b).rivalry >= 60 && !isPlayer(state, b)) {
        addNews(state, {
          headline: txt(data, rng, 'firstRivalry', null, { a: short(state, a), b: short(state, b), milestone: milestoneLabel(data, m) }),
          tags: ['diplomacia', 'corrida'], actors: [a, b], importance: 1, icon: '🏁',
        });
      }
    } else if (view(state, a, b).sameBloc) bumpRelation(state, a, b, { trust: 2 });
  }
}

function onTension(state, data, s) {
  if (!state.actors[s.a] || !state.actors[s.b]) return;
  const d = (s.to ?? 0) - (s.from ?? 0);
  if (d > 0) bumpRelation(state, s.a, s.b, { trust: -8 * d, rivalry: 3 * d });
  else if (d < 0) bumpRelation(state, s.a, s.b, { trust: -4 * d });
  for (const id of [s.a, s.b]) if (state.actors[id] && !isPlayer(state, id)) state.actors[id].ai.nextEvalTurn = state.turn;
}

function onElection(state, data, s, rng) {
  const ac = state.actors[s.actorId];
  if (!ac || isPlayer(state, s.actorId)) return;
  ac.ai.nextEvalTurn = state.turn;
  if (s.result === 'change') {
    // a new government reviews alliances for a year (leaveUtility) and reshuffles priorities a little
    memoryOf(state, s.actorId).newGovTurn = state.turn;
    ac.ai.cooperation = round(clamp((ac.ai.cooperation ?? 0.5) + rng.range(-0.12, 0.12), 0.1, 0.95), 2);
    ac.ai.aggression = round(clamp((ac.ai.aggression ?? 0.5) + rng.range(-0.1, 0.1), 0.05, 0.95), 2);
  }
}

function onBudgetChanged(state, data, s) {
  const ac = state.actors[s.actorId];
  if (!ac || !(s.from > 0)) return;
  if (s.to < s.from * 0.92) {
    memoryOf(state, s.actorId).budgetCutTurn = state.turn;
    if (!isPlayer(state, s.actorId)) ac.ai.nextEvalTurn = state.turn;
  }
}

function onContract(state, data, s) {
  const w = s.winner;
  if (!state.actors[w]) return;
  for (const l of s.bidders || s.losers || []) if (l !== w && state.actors[l]) bumpRelation(state, w, l, { rivalry: 2, trust: -1 });
}

// ---- relation drift toward a state-derived anchor (weekly)
function driftRelations(state, data, rng) {
  // read-only memo (treaties by pair, goals): each pair's view is read before its own relation moves
  openScope(state, data);
  try { driftPairs(state, data, rng); } finally { SCOPE = null; }
}
function driftPairs(state, data, rng) {
  const ids = sortedIds(state);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const r = rel(state, a, b);
      const v = view(state, a, b);
      const coop = ((state.actors[a].ai?.cooperation ?? 0.5) + (state.actors[b].ai?.cooperation ?? 0.5)) / 2;
      const trustAnchor = (v.sameBloc ? 15 : v.opposing ? -25 : 0) + 5 * Math.min(2, v.bilateral) + 2 * Math.min(2, v.multilateral)
        - 8 * v.tension - 0.15 * r.rivalry + (coop - 0.5) * 20;
      // the race heats up as the era advances: shared, unclaimed goals weigh more every year
      const heat = 12 + Math.min(10, (state.turn / 52) * 2);
      const rivAnchor = 8 + heat * v.shared.length + (v.opposing ? 12 : 0) + 5 * v.tension - 2 * Math.min(3, v.bilateral)
        + (isCompany(state, a) && isCompany(state, b) ? 20 : 0);
      const depAnchor = 10 * Math.min(3, v.bilateral) + 3 * Math.min(2, v.multilateral);
      r.trust = round(clamp(r.trust + (trustAnchor - r.trust) * 0.015 + rng.normal(0, 0.8), -100, 100));
      r.rivalry = round(clamp(r.rivalry + (rivAnchor - r.rivalry) * 0.008 + rng.normal(0, 0.4), 0, 100));
      r.dependence = round(clamp(r.dependence + (depAnchor - r.dependence) * 0.01, 0, 100));
    }
  }
}

// ---- treaties lifecycle
function expireTreaties(state, data, rng) {
  for (const t of state.treaties) {
    if (t.status !== 'active' || t.terms?.untilTurn == null || state.turn < t.terms.untilTurn) continue;
    t.status = 'expired';
    t.endedTurn = state.turn;
    const involvesPlayer = t.parties.includes(state.playerId);
    const headline = txt(data, rng, 'expired', null, { treaty: t.name, parties: listNames(state, t.parties) });
    if (!involvesPlayer) { log(state, `diplomacia: ${headline}`); continue; } // routine AI-AI expiry: log only
    addNews(state, {
      headline,
      body: involvesPlayer ? 'Se quiser manter o acordo, proponha uma renovação na aba Mundo.' : '',
      tags: ['diplomacia', 'tratado'], actors: t.parties.slice(), importance: involvesPlayer ? 2 : 1, icon: '⌛',
    });
  }
}

/** Monthly: each bilateral treaty's health (0..100) moves with trust, rivalry and money; healthy deals warm the pair. */
function treatyUpkeep(state, data, rng) {
  for (const t of activeTreaties(state)) {
    if (t.terms?.multilateral || t.type === 'peaceful_use' || t.parties.length !== 2) continue;
    const [a, b] = t.parties;
    const r = relation(state, a, b);
    const bp = Math.max(budgetPressure(state, a), budgetPressure(state, b));
    const h = t.terms.health ?? 60;
    const dh = (55 - h) * 0.05 + (r.trust - 20) / 25 - (r.rivalry - 30) / 30 - bp * 4 - tensionOf(state, a, b) * 3 + rng.normal(0, 5);
    t.terms.health = Math.round(clamp(h + dh, 0, 100));
    if (isProtected(state, t)) t.terms.health = Math.max(t.terms.health, 40);
    bumpRelation(state, a, b, { trust: (t.terms.health - 50) / 100, dependence: 0.3 });
  }
  strainRuptures(state, data, rng);
  // keeping your word slowly builds reputation
  for (const id of sortedIds(state)) {
    const n = bilateralLoad(state, id);
    if (n > 0) changeActor(state, id, 'reputation', Math.min(0.3, 0.08 * n));
  }
}

function isProtected(state, t) {
  return t?.terms?.protectedUntil != null && state.turn < t.terms.protectedUntil;
}

/**
 * Alliances cool and break (GDD "uma aliança nasce, esfria e se rompe"): a bilateral AI-AI deal under strain
 * (rivalry above trust, worse in a crisis) may break any month, on top of the utility-driven decisions.
 */
function strainRuptures(state, data, rng) {
  for (const t of activeTreaties(state).slice()) {
    if (t.terms?.multilateral || t.type === 'peaceful_use' || t.parties.length !== 2 || isProtected(state, t)) continue;
    if (t.parties.includes(state.playerId) || state.turn - (t.signedTurn ?? 0) < 26) continue;
    const [a, b] = t.parties;
    const r = relation(state, a, b);
    const ten = tensionOf(state, a, b);
    const p = STRAIN_K * Math.max(0, r.rivalry - r.trust + STRAIN_OFFSET) / 100 * (ten >= 2 ? 2 : 1) * (1 + Math.max(0, 50 - (t.terms.health ?? 60)) / 50);
    if (!(p > 0) || !rng.chance(p)) continue;
    // the more aggressive (or more squeezed) side walks out
    const score = (x) => (state.actors[x]?.ai?.aggression ?? 0.5) + budgetPressure(state, x);
    const by = score(a) >= score(b) ? a : b;
    const f = new Factors().add('rivalidade acima da confiança', r.rivalry - r.trust).add('acordo desgastado', 55 - (t.terms.health ?? 60));
    breakTreaty(state, data, by, t.id, rng, f);
  }
}

/** tech_transfer: research bonus delivered by signal every quarter (research module may listen). */
function techTransfers(state, data) {
  for (const t of activeTreaties(state)) {
    if (t.type !== 'tech_transfer' || t.signedTurn === state.turn) continue;
    const { giver, receiver } = t.terms || {};
    if (!state.actors[receiver]) continue;
    const points = Math.max(1, Math.round((t.terms.points || 20) / 4));
    emitSignal(state, 'diplomacy/techTransfer', { actorId: receiver, partnerId: giver, points, treatyId: t.id });
    bumpRelation(state, giver, receiver, { dependence: 1.5 });
    if (isPlayer(state, receiver)) {
      addNews(state, {
        headline: `${short(state, giver)} entrega pacote técnico: +${points} pontos de pesquisa.`,
        tags: ['diplomacia', 'pesquisa'], actors: [giver, receiver], importance: 1, icon: '🔧',
      });
    }
  }
}

/** Keep the treaty list bounded: drop old ended treaties beyond a cap. */
function pruneTreaties(state) {
  if (state.treaties.length <= 90) return;
  const ended = state.treaties.filter((t) => t.status !== 'active' && (t.endedTurn ?? t.brokenTurn ?? 0) < state.turn - 156);
  const drop = new Set(ended.slice(0, state.treaties.length - 90).map((t) => t.id));
  state.treaties = state.treaties.filter((t) => !drop.has(t.id));
}

// ---- emergent incidents (frictions and goodwill), probability from state
function incidents(state, data, rng) {
  const defs = A(data).incidents || [];
  if (!defs.length) return;
  const ids = sortedIds(state);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    let a = ids[i], b = ids[j];
    const v = view(state, a, b);
    const partners = treatiesBetween(state, a, b).filter((t) => !t.terms?.multilateral && t.type !== 'peaceful_use');
    const bp = Math.max(budgetPressure(state, a), budgetPressure(state, b));
    const coop = ((state.actors[a].ai?.cooperation ?? 0.5) + (state.actors[b].ai?.cooperation ?? 0.5)) / 2;
    const pF = 0.004 + (v.rivalry / 100) * 0.018 + v.tension * 0.012 + (partners.length ? 0.006 + bp * 0.05 : 0) + Math.max(0, -v.trust) / 100 * 0.008;
    const pG = 0.004 + Math.max(0, v.trust) / 100 * 0.012 + coop * 0.008 - v.tension * 0.003;
    const roll = rng.next();
    let kind = null;
    if (roll < pF) kind = 'friction';
    else if (roll < pF + Math.max(0, pG)) kind = 'goodwill';
    if (!kind) continue;
    const fits = defs.filter((d) => d.kind === kind && (
      d.requires === 'any'
      || (d.requires === 'partners' && partners.length)
      || (d.requires === 'rivals' && v.rivalry >= 50)
      || (d.requires === 'opposing' && v.opposing)
      || (d.requires === 'companies' && isCompany(state, a) && isCompany(state, b))));
    const d = rng.weighted(fits, (x) => (x.weight || 1) * (x.budgetDriven ? 0.5 + bp * 2 : 1));
    if (!d) continue;
    // the more aggressive (friction) or more cooperative (goodwill) side is the subject
    const sa = state.actors[a].ai || {}, sb = state.actors[b].ai || {};
    const swap = kind === 'friction' ? (sb.aggression ?? 0.5) + budgetPressure(state, b) > (sa.aggression ?? 0.5) + budgetPressure(state, a)
      : (sb.cooperation ?? 0.5) > (sa.cooperation ?? 0.5);
    if (swap ^ rng.chance(0.25)) [a, b] = [b, a];
    // bloc-vs-bloc frictions (export controls, state media) are acts of governments: the subject is an agency
    if (d.requires === 'opposing' && isCompany(state, a)) {
      if (isCompany(state, b)) continue;
      [a, b] = [b, a];
    }
    // no-repeat window: the same actor does not star in the same kind of incident twice within a year
    const mem = memoryOf(state, a);
    mem.incidents = mem.incidents || {};
    if (mem.incidents[d.id] != null && state.turn - mem.incidents[d.id] < INCIDENT_MEMORY) continue;
    mem.incidents[d.id] = state.turn;
    const prog = partners.find((t) => t.terms?.program);
    const program = prog ? programDef(data, prog.terms.program)?.name : (partners[0]?.name || 'o programa conjunto');
    bumpRelation(state, a, b, { trust: d.trust || 0, rivalry: d.rivalry || 0, dependence: d.dependence || 0 });
    const hit = d.requires === 'partners' ? (prog || partners[0]) : null;
    if (hit) hit.terms.health = clamp((hit.terms.health ?? 60) + (kind === 'friction' ? -15 : 10), 0, 100);
    const involvesPlayer = isPlayer(state, a) || isPlayer(state, b);
    addNews(state, {
      headline: fill(d.text, { a: short(state, a), b: short(state, b), program }),
      body: `Confiança ${d.trust > 0 ? '+' : ''}${d.trust || 0} entre ${short(state, a)} e ${short(state, b)}.`,
      tags: ['diplomacia', kind === 'friction' ? 'atrito' : 'aproximação'], actors: [a, b],
      importance: involvesPlayer ? 2 : 1, icon: kind === 'friction' ? '⚡' : '🤝',
    });
    state.stats[`diplomacy.${kind}`] = (state.stats[`diplomacy.${kind}`] || 0) + 1;
  }
}

// ---------------------------------------------------------------- AI evaluation

function aiEvaluate(state, data, id, rng) {
  openScope(state, data);
  let res;
  try { res = aiCandidates(state, data, id, rng); } finally { SCOPE = null; }
  if (res.now) { executeAi(state, data, id, res.now, rng); return res.now; }
  // pick the single best action that clears its threshold (margin = u - threshold)
  let best = null;
  for (const c of res.cands) {
    const margin = c.u - c.t;
    if (margin > 0 && (!best || margin > best.u - best.t)) best = c;
  }
  if (!best) return null;
  executeAi(state, data, id, best, rng);
  return best;
}

/** Candidate moves of one AI evaluation (reads the state only; aiEvaluate executes the winner). */
function aiCandidates(state, data, id, rng) {
  const S = state.actors[id];
  const cands = [];
  const others = sortedIds(state).filter((o) => o !== id);
  const openWith = (o) => state.proposals.some((p) => (p.from === id && p.to === o) || (p.from === o && p.to === id));

  // 1) bilateral proposals
  for (const o of others) {
    if (openWith(o)) continue;
    if (isPlayer(state, o) && !canProposeToPlayer(state)) continue;
    for (const type of BILATERAL_TYPES) {
      if (!typeAllowed(state, data, type, id, o)) continue;
      if (type !== 'mission_partnership' && treatiesBetween(state, id, o, type).length) continue;
      if (type === 'mission_partnership' && treatiesBetween(state, id, o, type).length >= 2) continue;
      if (remembers(state, id, 'rejected', `${o}:${type}`, REJECT_MEMORY)) continue;
      const terms = defaultTerms(state, data, type, id, o, rng);
      if (type === 'mission_partnership' && !terms.program) continue;
      const f = dealUtility(state, data, id, o, type, terms, 'propose');
      cands.push({ kind: 'propose', to: o, type, terms, u: f.u + rng.normal(0, NOISE), t: PROPOSE_T, f });
    }
  }
  // 2) bloc moves
  const myBloc = blocOf(state, id);
  if (myBloc && myBloc.leader !== id) {
    const f = leaveUtility(state, data, id, myBloc);
    const c = { kind: 'leave', bloc: myBloc.id, u: f.u + rng.normal(0, NOISE), t: LEAVE_T, f };
    // leaving a bloc is a strategic decision, not one more deal on the table: when it clears, it happens
    if (c.u > c.t) return { now: c, cands };
  }
  if (!myBloc) {
    for (const b of Object.values(state.blocs)) {
      if (!b.leader || !state.actors[b.leader] || openWith(b.leader)) continue;
      if (isPlayer(state, b.leader) && !canProposeToPlayer(state)) continue;
      if (remembers(state, id, 'rejected', `${b.leader}:join_bloc`, REJECT_MEMORY)) continue;
      const terms = { blocId: b.id, member: id };
      const f = joinBlocUtility(state, data, id, b.leader, terms, 'propose');
      cands.push({ kind: 'propose', to: b.leader, type: 'join_bloc', terms, u: f.u + rng.normal(0, NOISE), t: JOIN_T, f });
    }
  }
  if (myBloc && myBloc.leader === id) {
    for (const o of others) {
      if (blocOf(state, o) || openWith(o)) continue;
      if (isPlayer(state, o) && !canProposeToPlayer(state)) continue;
      if (remembers(state, id, 'rejected', `${o}:join_bloc`, REJECT_MEMORY)) continue;
      const terms = { blocId: myBloc.id, member: o };
      const f = joinBlocUtility(state, data, id, o, terms, 'accept');
      cands.push({ kind: 'propose', to: o, type: 'join_bloc', terms, u: f.u - 4 + rng.normal(0, NOISE), t: PROPOSE_T, f });
    }
  }
  // 3) multilateral norms: accede to open ones, or found a new one
  for (const t of activeTreaties(state)) {
    if (!t.terms?.multilateral || t.parties.includes(id) || t.terms.blocId) continue;
    if (!typeDef(data, t.type).allowCompanies && isCompany(state, id)) continue;
    if (remembers(state, id, 'withdrew', t.id, 104)) continue;
    const f = accedeUtility(state, data, id, t);
    cands.push({ kind: 'accede', treaty: t.id, u: f.u + rng.normal(0, NOISE), t: PROPOSE_T - 4, f });
  }
  for (const type of NORM_TYPES) {
    if (activeTreaties(state).some((t) => t.type === type && t.terms?.multilateral && !t.terms.blocId)) continue;
    if (!typeDef(data, type).allowCompanies && isCompany(state, id)) continue;
    if (remembers(state, id, 'rejected', `*:${type}`, 52)) continue;
    if (activeTreaties(state).some((t) => t.type === type && t.parties.includes(id))) continue; // already bound by one
    const f = new Factors()
      .add('base', -6 + typeDef(data, type).base)
      .add('perfil cooperativo', (S.ai.cooperation ?? 0.5) * 18)
      .add('órbita congestionada', type === 'orbital_traffic' ? Math.min(12, state.turn / 26) : 0)
      .add('reputação', ((S.reputation ?? 50) - 50) * 0.2);
    cands.push({ kind: 'found', type, u: f.u + rng.normal(0, NOISE), t: PROPOSE_T, f });
  }
  // 4) breaking treaties
  for (const t of activeTreaties(state)) {
    if (!t.parties.includes(id)) continue;
    if (t.terms?.blocId && blocOf(state, id)?.id === t.terms.blocId) continue; // leaving the bloc handles this
    if (state.turn - (t.signedTurn ?? 0) < 12) continue; // the ink is still wet
    if (state.turn < 12 && (t.signedTurn ?? 0) < 0) continue; // the world does not flip in the first weeks
    if (isProtected(state, t)) continue;
    const f = breakUtility(state, data, id, t);
    cands.push({ kind: 'break', treaty: t.id, u: f.u + rng.normal(0, NOISE), t: BREAK_T, f });
  }
  return { now: null, cands };
}

function canProposeToPlayer(state) {
  if (!state.playerId || !state.actors[state.playerId]) return false;
  if (state.proposals.some((p) => p.to === state.playerId && !p.countered)) return false;
  const last = state.stats['diplomacy.lastPlayerProposalTurn'];
  return last == null || state.turn - last >= PLAYER_PROPOSAL_GAP;
}

export function leaveUtility(state, data, id, bloc) {
  const S = state.actors[id];
  const v = view(state, id, bloc.leader);
  const f = new Factors();
  // companies are associates: they follow their country's policy, they do not walk out on their own
  if (isCompany(state, id)) return f.add('empresa associada', -999);
  f.add('inércia', -LEAVE_INERTIA);
  f.add('confiança no líder', -v.trust * 0.4);
  f.add('rivalidade com o líder', v.rivalry * 0.3);
  f.add('tensão com o líder', v.tension * 15);
  f.add('agressividade', (S.ai.aggression ?? 0.5) * 10);
  f.add('dependência', -v.dependence * 0.2);
  if (v.trust < -20) f.add('relação rompida com o líder', 8 + (-20 - v.trust) * 0.4);
  const outside = Object.values(state.blocs).filter((b) => b.id !== bloc.id && b.leader);
  for (const b of outside) f.add(`atração do ${b.short || b.name}`, Math.max(0, relation(state, id, b.leader).trust - v.trust) * 0.25);
  // the government's view of the bloc (politics: faction alignment) and a fresh government reviewing commitments
  const lean = politics.blocAlignment?.(state, data, id, bloc.id);
  if (lean != null) f.add('alinhamento do governo', (ALIGN_NEUTRAL - lean) * ALIGN_W);
  const ng = newGovernmentWeight(state, id);
  if (ng > 0) f.add('governo novo revê compromissos', ng * NEW_GOV_W);
  f.add('verba apertada', budgetPressure(state, id) * 6);
  const ls = state.actors[bloc.leader]?.support;
  if (typeof ls === 'number' && ls < 45) f.add('líder do bloco desgastado', (45 - ls) * 0.3);
  return f;
}

/** 1..0: how fresh the actor's new government is (election with a change of government in the last year). */
function newGovernmentWeight(state, id) {
  const t = state.actors?.[id]?.ai?.memory?.newGovTurn;
  if (t == null) return 0;
  const age = state.turn - t;
  return age < 0 || age >= NEW_GOV_WEEKS ? 0 : 1 - age / NEW_GOV_WEEKS;
}

function accedeUtility(state, data, id, t) {
  const S = state.actors[id];
  const f = new Factors();
  const ps = t.parties.filter((p) => p !== id);
  if (!ps.length) return f.add('vazio', -999);
  let trust = 0, riv = 0, ten = 0;
  for (const p of ps) { const v = view(state, id, p); trust += v.trust; riv += v.rivalry; ten = Math.max(ten, v.tension); }
  f.add('base', typeDef(data, t.type).base - 2);
  f.add('confiança nos signatários', (trust / ps.length) * 0.3);
  f.add('rivalidade', -(riv / ps.length) * 0.15);
  f.add('tensão', -ten * 8);
  f.add('perfil cooperativo', (S.ai.cooperation ?? 0.5) * 12);
  f.add('cultura', ((S.culture || 0) / 100) * (typeDef(data, t.type).cultureWeight || 0));
  f.add('peso do acordo', Math.min(10, ps.length * 1.5));
  return f;
}

function breakUtility(state, data, id, t) {
  const S = state.actors[id];
  const f = new Factors();
  const td = typeDef(data, t.type);
  const ps = t.parties.filter((p) => p !== id);
  if (!ps.length) return f.add('vazio', -999);
  let trust = 0, riv = 0, dep = 0, ten = 0;
  for (const p of ps) { const v = view(state, id, p); trust += v.trust; riv += v.rivalry; dep += v.dependence; ten = Math.max(ten, v.tension); }
  const n = ps.length;
  if (t.terms?.multilateral && n > 1) {
    // leaving a multilateral norm is about principles and isolation, not about one partner
    f.add('inércia', -18);
    f.add('custo de reputação', -(td.breakReputation || 8) * 1.5);
    f.add('isolamento', -Math.min(15, n * 2));
    f.add('confiança média', -(trust / n) * 0.15);
    f.add('tensão máxima', ten >= 3 ? 10 + ten * 8 : ten * 3);
    f.add('agressividade', (S.ai.aggression ?? 0.5) * 10);
    if (t.type === 'peaceful_use') f.add('tabu', -30);
    return f;
  }
  f.add('inércia', -8);
  f.add('investimento já feito', -Math.min(10, Math.max(0, state.turn - (t.signedTurn ?? 0)) / 26 * 1.5));
  if (t.terms?.untilTurn != null && t.terms.untilTurn - state.turn < 26) f.add('acaba em breve', -10);
  if (n === 1 && !t.terms?.multilateral) f.add('acordo desgastado', (55 - (t.terms?.health ?? 60)) * 0.6);
  f.add('custo de reputação', -(td.breakReputation || 6) * 1.2 * (0.5 + (S.reputation ?? 50) / 100));
  f.add('confiança', -(trust / n) * 0.25);
  f.add('rivalidade', (riv / n) * 0.3);
  f.add('dependência', -(dep / n) * 0.2);
  f.add('tensão política', ten * 10 + (ten >= 3 ? 15 : 0));
  f.add('agressividade', (S.ai.aggression ?? 0.5) * 12);
  f.add('verba apertada', budgetPressure(state, id) * (t.type === 'tech_transfer' || t.type === 'mission_partnership' ? 14 : 4));
  if (t.type === 'tech_transfer' && t.terms?.giver === id) f.add('dando sem receber', 6);
  if (t.type === 'peaceful_use') f.add('tabu', -20);
  if (t.type === 'mission_partnership') {
    const p = programDef(data, t.terms?.program);
    if (p?.milestone && state.firsts?.[p.milestone]) f.add('programa perdeu o sentido', 6);
  }
  for (const p of ps) if (remembers(state, id, 'brokenBy', p, BREAK_MEMORY)) f.add('revide', 10);
  return f;
}

function executeAi(state, data, id, c, rng) {
  switch (c.kind) {
    case 'propose': return createProposal(state, data, id, c.to, c.type, c.terms, c.f);
    case 'leave': return leaveBloc(state, data, id, rng, c.f);
    case 'accede': return accede(state, data, id, c.treaty, rng);
    case 'found': return foundTreaty(state, data, id, c.type, rng);
    case 'break': return breakTreaty(state, data, id, c.treaty, rng, c.f);
    default: return null;
  }
}

// ---------------------------------------------------------------- proposals

function createProposal(state, data, from, to, type, terms, factors) {
  const p = {
    id: nextId(state, 'prop'), from, to, type, terms: { ...terms },
    createdTurn: state.turn, expiresTurn: state.turn + (isPlayer(state, to) ? PROPOSAL_TTL : 2),
    respondTurn: state.turn + 1, status: 'open', countered: false,
    reasons: factors ? factors.top(2) : [],
  };
  state.proposals.push(p);
  if (isPlayer(state, to)) {
    state.stats['diplomacy.lastPlayerProposalTurn'] = state.turn;
    pushProposalDecision(state, data, p);
  }
  return p;
}

function describeTerms(state, data, type, terms) {
  switch (type) {
    case 'mission_partnership': return `Programa: ${programDef(data, terms.program)?.name || 'conjunto'}${terms.lead ? ` · liderança: ${short(state, terms.lead)}` : ''}.`;
    case 'cost_sharing': return `Desconto de ${pct(terms.share ?? 0.15)} nas missões conjuntas.`;
    case 'crew_exchange': return `${terms.seats || 1} vaga(s) por ano para cada lado.`;
    case 'tech_transfer': return `${short(state, terms.giver)} ensina ${short(state, terms.receiver)}: ~${terms.points || 20} pontos de pesquisa em 2 anos.`;
    case 'join_bloc': return `${short(state, terms.member)} entra no bloco ${state.blocs?.[terms.blocId]?.name || terms.blocId}.`;
    default: return typeDef(data, type).description || '';
  }
}

/** What accepting means for the player, in a short pt-BR preview. */
function acceptPreview(state, data, p) {
  const me = state.playerId;
  const td = typeDef(data, p.type);
  const dur = td.durationWeeks ? `${Math.round(td.durationWeeks / 52)} anos` : 'sem prazo';
  const bits = [`Tratado (${dur})`, `confiança +4 com ${short(state, p.from)}`];
  if (p.type === 'cost_sharing') bits.push(`missões conjuntas ${pct(p.terms.share ?? 0.15)} mais baratas`);
  if (p.type === 'tech_transfer') bits.push(p.terms.receiver === me ? `+${p.terms.points} pontos de pesquisa` : 'você cede tecnologia; ele fica dependente');
  if (p.type === 'crew_exchange') bits.push(state.actors[me]?.capabilities?.crewed ? 'você cede assentos' : 'seus astronautas ganham vagas');
  if (p.type === 'join_bloc') {
    const bloc = state.blocs[p.terms.blocId];
    if (p.terms.member === me) {
      const rival = Object.values(state.blocs).find((b) => b.id !== bloc?.id && b.leader);
      bits.push(`aliados do ${bloc?.short || bloc?.name}`);
      if (rival) bits.push(`irrita o ${rival.short || rival.name}`);
    } else bits.push(`${short(state, p.terms.member)} entra no seu bloco`);
  }
  return bits.join(' · ') + '.';
}

function counterTerms(state, data, p) {
  const t = { ...p.terms };
  const me = state.playerId;
  switch (p.type) {
    case 'cost_sharing': t.counterAsk = 0.1; t.share = clamp(round((t.share ?? 0.15) + 0.1, 2), 0.1, 0.4); break;
    case 'mission_partnership': t.counterAsk = 0.4; t.lead = me; break;
    case 'crew_exchange': t.counterAsk = 0.4; t.seats = (t.seats || 1) + 1; break;
    case 'tech_transfer':
      t.counterAsk = 0.5;
      if (t.receiver === me) t.points = Math.round((t.points || 20) * 1.5);
      else { t.points = Math.round((t.points || 20) * 0.6); }
      break;
    default: t.counterAsk = 0.3;
  }
  return t;
}
function counterText(state, data, p, t) {
  switch (p.type) {
    case 'cost_sharing': return `Pedir desconto de ${pct(t.share)}`;
    case 'mission_partnership': return 'Exigir a liderança do programa';
    case 'crew_exchange': return `Pedir ${t.seats} vagas por ano`;
    case 'tech_transfer': return t.receiver === state.playerId ? `Pedir ${t.points} pontos` : `Ceder só ${t.points} pontos`;
    default: return 'Pedir condições melhores';
  }
}

function pushProposalDecision(state, data, p) {
  const F = state.actors[p.from];
  const td = typeDef(data, p.type);
  const v = view(state, state.playerId, p.from);
  const ct = counterTerms(state, data, p);
  const cu = utilityFor(state, data, p.from, { ...p, terms: ct }).u;
  const cChance = chanceFrom(cu);
  const why = p.reasons?.length ? ` Motivos: ${p.reasons.join(', ')}.` : '';
  const isJoinRequest = p.type === 'join_bloc' && p.terms.member === p.from;
  const title = isJoinRequest
    ? `${F.flag || ''} ${F.short} quer entrar no seu bloco`
    : `${F.flag || ''} ${F.short} propõe: ${td.name}`;
  const d = pushDecision(state, {
    kind: 'diplomacy/proposal',
    title: title.trim(),
    body: `${describeTerms(state, data, p.type, p.terms)}${why} Confiança ${Math.round(v.trust)} · rivalidade ${Math.round(v.rivalry)}${v.tension ? ` · tensão ${v.tension}` : ''}.`,
    portrait: { actorId: p.from },
    urgency: 2,
    expiresTurn: p.expiresTurn,
    defaultChoice: 'reject',
    payload: { proposalId: p.id },
    choices: [
      { id: 'accept', label: 'Aceitar', preview: acceptPreview(state, data, p) },
      { id: 'counter', label: 'Contraproposta', preview: `${counterText(state, data, p, ct)}. Chance de aceitarem: ${chanceLabel(cChance)} (~${pct(cChance)}). Resposta na próxima semana.` },
      { id: 'reject', label: 'Recusar', preview: `Confiança −3 com ${F.short}. Eles não voltam a propor isso por meses.` },
    ],
  });
  p.decisionId = d.id;
}

/** AI responses to AI proposals, counters from the player and the player's pending proposals. */
function resolveDueProposals(state, data, ctx) {
  for (const p of state.proposals.slice()) {
    if (!state.proposals.includes(p)) continue;
    const responder = p.countered ? p.from : p.to;
    if (!state.actors[p.from] || !state.actors[p.to]) { dropProposal(state, p.id); continue; }
    if (isPlayer(state, responder)) {
      // waiting for the player: the decision expiry handles it; clean orphans
      if (!state.decisions.some((d) => d.payload?.proposalId === p.id) || state.turn > p.expiresTurn + 1) dropProposal(state, p.id);
      continue;
    }
    if (state.turn < p.respondTurn) continue;
    respond(state, data, p, responder, ctx.rng(`respond:${p.id}`));
  }
}

function utilityFor(state, data, responder, p) {
  const other = responder === p.from ? p.to : p.from;
  if (p.type === 'join_bloc') {
    const role = responder === p.terms.member ? 'propose' : 'accept';
    const f = joinBlocUtility(state, data, responder, other, p.terms, role);
    if (p.terms.counterAsk) f.add('contraproposta', -p.terms.counterAsk * 30);
    return f;
  }
  return dealUtility(state, data, responder, other, p.type, p.terms, 'accept');
}

function respond(state, data, p, responder, rng) {
  const f = utilityFor(state, data, responder, p);
  const other = responder === p.from ? p.to : p.from;
  // a proposer's own reputation matters
  f.add('reputação de quem propõe', ((state.actors[other]?.reputation ?? 50) - 50) * 0.1);
  const u = f.u + rng.normal(0, NOISE);
  dropProposal(state, p.id);
  const playerSide = isPlayer(state, other);
  if (u >= ACCEPT_T) {
    const t = signFromProposal(state, data, p, rng);
    if (playerSide && t !== false) {
      addNews(state, {
        headline: `${short(state, responder)} aceita ${p.countered ? 'sua contraproposta' : 'sua proposta'}: ${typeName(data, p.type).toLowerCase()}.`,
        body: `Pesou a favor: ${f.top(2).join(', ') || 'o momento'}.`,
        tags: ['diplomacia', 'jogador'], actors: [responder, other], importance: 3, icon: '✅',
      });
    }
    return { accepted: true, u };
  }
  memoryOf(state, other).rejected[`${responder}:${p.type}`] = state.turn;
  memoryOf(state, responder).rejected[`${other}:${p.type}`] = state.turn;
  bumpRelation(state, responder, other, { trust: p.countered ? -2 * REFUSAL_TRUST : -REFUSAL_TRUST });
  const vars = { a: short(state, p.from), b: short(state, responder), type: typeName(data, p.type).toLowerCase() };
  if (playerSide) {
    addNews(state, {
      headline: `${short(state, responder)} recusa ${p.countered ? 'sua contraproposta' : 'sua proposta'}: ${vars.type}.`,
      body: `Pesou contra: ${f.top(2, -1).join(', ') || 'falta de interesse'}.`,
      tags: ['diplomacia', 'jogador'], actors: [responder, other], importance: 3, icon: '❌',
    });
  } else if (relation(state, p.from, responder).rivalry >= 50 || p.type === 'join_bloc') {
    // only newsworthy refusals reach the feed
    addNews(state, {
      headline: txt(data, rng, 'rejected', null, vars),
      tags: ['diplomacia'], actors: [p.from, responder], importance: 1, icon: '✋',
    });
  }
  state.stats['diplomacy.rejected'] = (state.stats['diplomacy.rejected'] || 0) + 1;
  return { accepted: false, u };
}

function dropProposal(state, id) {
  const i = state.proposals.findIndex((p) => p.id === id);
  if (i >= 0) state.proposals.splice(i, 1);
}

// ---------------------------------------------------------------- signing / breaking / blocs

function signFromProposal(state, data, p, rng) {
  if (p.type === 'join_bloc') return joinBloc(state, data, p.terms.member, p.terms.blocId, rng, p.from);
  if (NORM_TYPES.includes(p.type)) {
    // accession to an existing multilateral norm the other side belongs to
    const open = activeTreaties(state).find((t) => t.type === p.type && t.terms?.multilateral && !t.terms.blocId
      && (t.parties.includes(p.to) !== t.parties.includes(p.from)));
    if (open) {
      const joiner = open.parties.includes(p.to) ? p.from : p.to;
      return accede(state, data, joiner, open.id, rng);
    }
  }
  const terms = { ...p.terms };
  delete terms.counterAsk;
  return signTreaty(state, data, { type: p.type, parties: [p.from, p.to], terms, proposer: p.from }, rng);
}

/** Create an active treaty with effects, news and signals. Returns the treaty. */
export function signTreaty(state, data, { type, parties, terms = {}, name, proposer }, rng) {
  const td = typeDef(data, type);
  const prog = terms.program ? programDef(data, terms.program) : null;
  const t = {
    id: nextId(state, 'treaty'), type,
    name: name || fill(td.treatyName || td.name, { program: prog?.name || '' }).replace(/\s+$/, ''),
    parties: parties.slice(), signedTurn: state.turn, status: 'active',
    terms: { ...terms, untilTurn: td.durationWeeks ? state.turn + td.durationWeeks : null, health: 60 },
  };
  if (NORM_TYPES.includes(type) && parties.length > 2) t.terms.multilateral = true;
  state.treaties.push(t);
  for (let i = 0; i < parties.length; i++) for (let j = i + 1; j < parties.length; j++) {
    bumpRelation(state, parties[i], parties[j], { trust: 4, dependence: 4, rivalry: -2 });
  }
  for (const pid of parties) changeActor(state, pid, 'reputation', 1);
  emitSignal(state, 'treaty/signed', { treatyId: t.id, treatyType: type, parties: t.parties.slice() });
  if (type === 'crew_exchange') emitSignal(state, 'diplomacy/crewExchange', { treatyId: t.id, parties: t.parties.slice(), seats: terms.seats || 1 });
  if (type === 'tech_transfer' && terms.receiver) {
    emitSignal(state, 'diplomacy/techTransfer', { actorId: terms.receiver, partnerId: terms.giver, points: Math.round((terms.points || 20) / 4), treatyId: t.id });
  }
  const [a, b] = parties;
  const v = view(state, a, b);
  const involvesPlayer = parties.includes(state.playerId);
  const unusual = v.opposing || v.rivalry >= 50 || v.shared.length >= 2;
  const vars = {
    a: short(state, a), b: short(state, b), program: prog?.name || 'missão conjunta', share: pct(terms.share ?? 0.15),
    seats: terms.seats || 1, giver: short(state, terms.giver), receiver: short(state, terms.receiver),
  };
  let body = '';
  const racing = v.shared.filter((g) => g !== prog?.milestone);
  if (unusual && racing.length) {
    body = `Cooperam em ${prog?.name || typeName(data, type).toLowerCase()}, mas seguem disputando ${milestoneLabel(data, racing[0])}.`;
  }
  addNews(state, {
    headline: txt(data, rng, 'signed', type, vars, `${vars.a} e ${vars.b} assinam ${t.name}.`),
    body, tags: ['diplomacia', 'tratado'], actors: parties.slice(),
    importance: involvesPlayer ? 2 : unusual ? 2 : 1, icon: td.icon || '🤝',
  });
  state.stats['diplomacy.signed'] = (state.stats['diplomacy.signed'] || 0) + 1;
  return t;
}

/** Break (bilateral) or withdraw from (multilateral) a treaty. */
export function breakTreaty(state, data, by, treatyId, rng, factors) {
  const t = state.treaties.find((x) => x.id === treatyId);
  if (!t || t.status !== 'active' || !t.parties.includes(by)) return null;
  const td = typeDef(data, t.type);
  const others = t.parties.filter((p) => p !== by);
  const multi = !!t.terms?.multilateral && t.parties.length > 2;
  if (multi) {
    t.parties = others;
    t.terms.withdrawn = [...(t.terms.withdrawn || []), { actorId: by, turn: state.turn }];
    memoryOf(state, by).withdrew[t.id] = state.turn;
    if (t.parties.length < 2) { t.status = 'broken'; t.brokenBy = by; t.brokenTurn = state.turn; t.endedTurn = state.turn; }
  } else {
    t.status = 'broken'; t.brokenBy = by; t.brokenTurn = state.turn; t.endedTurn = state.turn;
  }
  changeActor(state, by, 'reputation', -(td.breakReputation || 6) * (multi ? 1 : 1));
  for (const p of others) {
    bumpRelation(state, by, p, { trust: multi ? -8 : -20, rivalry: multi ? 2 : 5, dependence: multi ? -2 : -8 });
    memoryOf(state, p).brokenBy[by] = state.turn;
  }
  for (const o of sortedIds(state)) if (o !== by && !others.includes(o)) bumpRelation(state, by, o, { trust: -2 });
  emitSignal(state, 'treaty/broken', { treatyId: t.id, by, treatyType: t.type });
  const involvesPlayer = by === state.playerId || others.includes(state.playerId);
  const why = factors?.top?.(2) || [];
  addNews(state, {
    headline: multi
      ? txt(data, rng, 'withdrawn', null, { a: short(state, by), treaty: t.name })
      : txt(data, rng, 'broken', null, { a: short(state, by), b: short(state, others[0]), treaty: t.name }),
    body: `${why.length ? `Motivos: ${why.join(', ')}. ` : ''}Reputação de ${short(state, by)} −${td.breakReputation || 6}.`,
    tags: ['diplomacia', 'ruptura'], actors: t.parties.concat(by),
    importance: involvesPlayer || multi || t.type === 'peaceful_use' ? 3 : 2, icon: '💔',
  });
  state.stats['diplomacy.broken'] = (state.stats['diplomacy.broken'] || 0) + 1;
  return t;
}

function accede(state, data, id, treatyId, rng) {
  const t = state.treaties.find((x) => x.id === treatyId);
  if (!t || t.status !== 'active' || t.parties.includes(id)) return false;
  t.parties.push(id);
  for (const p of t.parties) if (p !== id) bumpRelation(state, id, p, { trust: 2, dependence: 1 });
  changeActor(state, id, 'reputation', 2);
  emitSignal(state, 'treaty/signed', { treatyId: t.id, treatyType: t.type, parties: [id], accession: true });
  addNews(state, {
    headline: txt(data, rng, 'acceded', null, { a: short(state, id), treaty: t.name }),
    tags: ['diplomacia', 'tratado'], actors: [id], importance: isPlayer(state, id) ? 2 : 1, icon: typeDef(data, t.type).icon || '✍️',
  });
  state.stats['diplomacy.acceded'] = (state.stats['diplomacy.acceded'] || 0) + 1;
  return t;
}

/** An AI founds a new multilateral norm, inviting everyone who would agree (player gets no vote here: he can accede later). */
function foundTreaty(state, data, founder, type, rng) {
  const parties = [founder];
  const td = typeDef(data, type);
  for (const o of sortedIds(state)) {
    if (o === founder || isPlayer(state, o)) continue;
    if (!td.allowCompanies && isCompany(state, o)) continue;
    const pseudo = { type, parties: [founder, ...parties.filter((p) => p !== founder)], terms: { multilateral: true } };
    const f = accedeUtility(state, data, o, pseudo);
    if (f.u + rng.normal(0, NOISE) >= ACCEPT_T) parties.push(o);
  }
  if (parties.length < 3) {
    memoryOf(state, founder).rejected[`*:${type}`] = state.turn;
    return null;
  }
  const t = signTreaty(state, data, { type, parties, terms: { multilateral: true, founder }, proposer: founder }, rng);
  t.terms.multilateral = true;
  // replace the generic headline with a founding one
  state.news[0].headline = txt(data, rng, 'founded', null, { treaty: t.name, parties: listNames(state, parties), founder: short(state, founder) });
  state.news[0].importance = 2;
  if (state.playerId && !parties.includes(state.playerId)) state.news[0].body = 'Você pode aderir pela aba Mundo.';
  return t;
}

export function joinBloc(state, data, member, blocId, rng, via) {
  const bloc = state.blocs?.[blocId];
  if (!bloc || !state.actors[member] || bloc.members.includes(member)) return false;
  if (blocOf(state, member)) return false;
  bloc.members.push(member);
  state.actors[member].bloc = bloc.id;
  if (!bloc.leader) bloc.leader = member;
  for (const m of bloc.members) if (m !== member) bumpRelation(state, member, m, { trust: 8, dependence: 3 });
  for (const ob of Object.values(state.blocs)) {
    if (ob.id === bloc.id) continue;
    for (const m of ob.members) bumpRelation(state, member, m, { trust: -6, rivalry: 4 });
  }
  // agencies sign the bloc's founding treaty
  const bt = bloc.treatyId && state.treaties.find((t) => t.id === bloc.treatyId && t.status === 'active');
  if (bt && !bt.parties.includes(member) && (typeDef(data, bt.type).allowCompanies || !isCompany(state, member))) bt.parties.push(member);
  emitSignal(state, 'diplomacy/blocChanged', { actorId: member, blocId: bloc.id, joined: true });
  addNews(state, {
    headline: txt(data, rng, 'joinedBloc', null, { a: short(state, member), bloc: bloc.name, leader: short(state, bloc.leader) }),
    body: 'Novos aliados, novos rivais: a geopolítica do espaço se reorganiza.',
    tags: ['diplomacia', 'bloco'], actors: [member, bloc.leader], importance: 3, icon: bloc.icon || '🏳️',
  });
  state.stats['diplomacy.joinedBloc'] = (state.stats['diplomacy.joinedBloc'] || 0) + 1;
  return true;
}

export function leaveBloc(state, data, member, rng, factors) {
  const bloc = blocOf(state, member);
  if (!bloc) return false;
  bloc.members = bloc.members.filter((m) => m !== member);
  state.actors[member].bloc = null;
  memoryOf(state, member).withdrew[bloc.id] = state.turn;
  const oldLeader = bloc.leader;
  for (const m of bloc.members) bumpRelation(state, member, m, { trust: m === oldLeader ? -15 : -6, dependence: -4 });
  changeActor(state, member, 'reputation', -4);
  // withdraw from the bloc treaty
  const bt = bloc.treatyId && state.treaties.find((t) => t.id === bloc.treatyId && t.status === 'active');
  if (bt && bt.parties.includes(member)) {
    bt.parties = bt.parties.filter((p) => p !== member);
    bt.terms.withdrawn = [...(bt.terms.withdrawn || []), { actorId: member, turn: state.turn }];
    memoryOf(state, member).withdrew[bt.id] = state.turn;
    emitSignal(state, 'treaty/broken', { treatyId: bt.id, by: member, treatyType: bt.type });
  }
  let leaderNews = null;
  if (oldLeader === member) {
    const next = bloc.members.slice().sort((x, y) => (isCompany(state, x) - isCompany(state, y)) || ((state.actors[y].budget || 0) - (state.actors[x].budget || 0)))[0];
    bloc.leader = next || null;
    if (next) leaderNews = txt(data, rng, 'leaderChange', null, { a: short(state, next), bloc: bloc.name });
  }
  emitSignal(state, 'diplomacy/blocChanged', { actorId: member, blocId: bloc.id, joined: false });
  const why = factors?.top?.(2) || [];
  addNews(state, {
    headline: txt(data, rng, 'leftBloc', null, { a: short(state, member), bloc: bloc.name }),
    body: [why.length ? `Motivos: ${why.join(', ')}.` : '', leaderNews || ''].filter(Boolean).join(' '),
    tags: ['diplomacia', 'bloco', 'ruptura'], actors: [member, ...(bloc.leader ? [bloc.leader] : [])], importance: 3, icon: '🚪',
  });
  state.stats['diplomacy.leftBloc'] = (state.stats['diplomacy.leftBloc'] || 0) + 1;
  return true;
}

// ---------------------------------------------------------------- player actions

function validatePlayerProposal(state, data, me, to, type, terms) {
  if (!me || !state.actors[me]) return 'sem jogador';
  if (!state.actors[to] || to === me) return 'Destinatário inválido.';
  if (!PROPOSAL_TYPES.includes(type)) return 'Tipo de proposta desconhecido.';
  if (type === 'join_bloc') return null;
  if (!typeAllowed(state, data, type, me, to)) return 'Esse tipo de acordo não se aplica a esse ator.';
  if (tensionOf(state, me, to) >= 3) return 'Conflito aberto: não há canal diplomático.';
  if (state.proposals.some((p) => ((p.from === me && p.to === to) || (p.from === to && p.to === me)) && p.type === type)) return 'Já existe uma proposta em aberto.';
  if (type === 'mission_partnership') {
    if (treatiesBetween(state, me, to, type).some((t) => t.terms?.program === terms.program)) return 'Já existe parceria nesse programa.';
  } else if (BILATERAL_TYPES.includes(type) && treatiesBetween(state, me, to, type).length) return 'Já existe um acordo desse tipo em vigor.';
  if (NORM_TYPES.includes(type) && treatiesBetween(state, me, to, type).length) return 'Vocês já são signatários.';
  if (remembers(state, to, 'rejected', `${me}:${type}`, 12)) return `${short(state, to)} recusou isso há pouco. Espere algumas semanas.`;
  return null;
}

function normalizeTerms(state, data, type, me, to, terms = {}) {
  const t = { ...defaultTerms(state, data, type, me, to, null), ...terms };
  if (type === 'cost_sharing') t.share = clamp(Number(t.share) || 0.15, 0.05, 0.4);
  if (type === 'crew_exchange') t.seats = clamp(Math.round(Number(t.seats) || 1), 1, 3);
  if (type === 'tech_transfer') {
    if (terms.direction === 'give') { t.giver = me; t.receiver = to; }
    if (terms.direction === 'receive') { t.giver = to; t.receiver = me; }
    t.points = clamp(Math.round(Number(t.points) || 20), 5, 80);
  }
  if (type === 'mission_partnership' && !programDef(data, t.program)) t.program = defaultTerms(state, data, type, me, to, null).program;
  if (type === 'mission_partnership') t.lead = t.lead === to ? to : me;
  return t;
}

/** Expected AI answer to a player proposal (no noise): {u, chance, label, reasons}. */
export function previewProposal(state, data, to, type, terms = {}) {
  const me = state.playerId;
  if (type === 'join_bloc') {
    const blocId = terms.blocId || blocOf(state, to)?.id;
    const bloc = state.blocs?.[blocId];
    if (!bloc) return { u: -999, chance: 0, label: chanceLabel(0), reasons: ['bloco inexistente'], error: 'Bloco inexistente.' };
    const f = joinBlocUtility(state, data, bloc.leader, me, { blocId, member: me }, 'accept');
    const c = chanceFrom(f.u);
    return { u: round(f.u), chance: round(c, 2), label: chanceLabel(c), reasons: f.top(2), against: f.top(2, -1), terms: { blocId, member: me }, refusalTrust: REFUSAL_TRUST };
  }
  const err = validatePlayerProposal(state, data, me, to, type, terms);
  const t = normalizeTerms(state, data, type, me, to, terms);
  const f = dealUtility(state, data, to, me, type, t, 'accept');
  f.add('sua reputação', ((state.actors[me]?.reputation ?? 50) - 50) * 0.1);
  const c = err ? 0 : chanceFrom(f.u);
  return { u: round(f.u), chance: round(c, 2), label: chanceLabel(c), reasons: f.top(2), against: f.top(2, -1), terms: t, error: err || undefined, refusalTrust: REFUSAL_TRUST, counterRefusalTrust: 2 * REFUSAL_TRUST };
}

/** The proposal kind travels in `proposalType` (action.type is the engine route 'diplomacy/propose'). */
export function proposalTypeOf(action) {
  if (action?.proposalType) return action.proposalType;
  if (action?.kind) return action.kind;
  if (action?.terms?.type) return action.terms.type;
  return action?.type && action.type !== 'diplomacy/propose' ? action.type : null;
}

function actPropose(state, data, action, ctx) {
  const me = state.playerId;
  const to = action.to;
  const type = proposalTypeOf(action);
  if (type === 'join_bloc') return actJoinBloc(state, data, { blocId: action.terms?.blocId || blocOf(state, to)?.id }, ctx);
  const err = validatePlayerProposal(state, data, me, to, type, action.terms || {});
  if (err) return { ok: false, error: err };
  const terms = normalizeTerms(state, data, type, me, to, action.terms || {});
  const rng = ctx.rng(`propose:${to}:${type}`);
  const pre = previewProposal(state, data, to, type, terms);
  const p = {
    id: nextId(state, 'prop'), from: me, to, type, terms,
    createdTurn: state.turn, expiresTurn: state.turn + 2, respondTurn: state.turn + 1, status: 'open', countered: false, reasons: [],
  };
  // clear-cut cases are answered on the spot; close calls take a week of deliberation
  if (Math.abs(pre.u - ACCEPT_T) >= 12) {
    state.proposals.push(p);
    const r = respond(state, data, p, to, rng);
    return { ok: true, status: r.accepted ? 'accepted' : 'rejected', chance: pre.chance, proposalId: p.id };
  }
  state.proposals.push(p);
  addNews(state, {
    headline: `${short(state, to)} vai avaliar sua proposta de ${typeName(data, type).toLowerCase()}.`,
    body: `Resposta na próxima semana. Chance: ${pre.label}.`, tags: ['diplomacia', 'jogador'], actors: [me, to], importance: 1, icon: '⏳',
  });
  return { ok: true, status: 'pending', chance: pre.chance, proposalId: p.id };
}

function actJoinBloc(state, data, action, ctx) {
  const me = state.playerId;
  const bloc = state.blocs?.[action.blocId];
  if (!bloc) return { ok: false, error: 'Bloco inexistente.' };
  if (bloc.members.includes(me)) return { ok: false, error: 'Você já faz parte desse bloco.' };
  const cur = blocOf(state, me);
  if (cur) return { ok: false, error: `Saia antes do bloco ${cur.name}.` };
  if (!bloc.leader || bloc.leader === me) { joinBloc(state, data, me, bloc.id, ctx.rng('join')); return { ok: true, status: 'accepted' }; }
  // same gates as any other proposal: no channel in open conflict, one request at a time, a cooldown after a refusal
  if (tensionOf(state, me, bloc.leader) >= 3) return { ok: false, error: 'Conflito aberto: não há canal diplomático.' };
  if (state.proposals.some((p) => p.from === me && p.type === 'join_bloc')) return { ok: false, error: 'Já existe um pedido de adesão em aberto.' };
  if (remembers(state, bloc.leader, 'rejected', `${me}:join_bloc`, 12)) return { ok: false, error: `${short(state, bloc.leader)} recusou isso há pouco. Espere algumas semanas.` };
  const rng = ctx.rng(`joinBloc:${bloc.id}`);
  const p = {
    id: nextId(state, 'prop'), from: me, to: bloc.leader, type: 'join_bloc', terms: { blocId: bloc.id, member: me },
    createdTurn: state.turn, expiresTurn: state.turn + 2, respondTurn: state.turn, status: 'open', countered: false, reasons: [],
  };
  state.proposals.push(p);
  const r = respond(state, data, p, bloc.leader, rng);
  return { ok: true, status: r.accepted ? 'accepted' : 'rejected' };
}

function actLeaveBloc(state, data, action, ctx) {
  const me = state.playerId;
  if (!blocOf(state, me)) return { ok: false, error: 'Você não está em nenhum bloco.' };
  leaveBloc(state, data, me, ctx.rng('leave'), null);
  return { ok: true };
}

function actBreakTreaty(state, data, action, ctx) {
  const me = state.playerId;
  const t = state.treaties.find((x) => x.id === action.treatyId);
  if (!t || t.status !== 'active' || !t.parties.includes(me)) return { ok: false, error: 'Tratado não encontrado ou inativo.' };
  if (t.terms?.blocId && blocOf(state, me)?.id === t.terms.blocId) return { ok: false, error: 'Esse tratado é o pilar do seu bloco: saia do bloco para romper.' };
  breakTreaty(state, data, me, t.id, ctx.rng(`break:${t.id}`), null);
  return { ok: true };
}

function actCancelProposal(state, data, action) {
  const p = state.proposals.find((x) => x.id === action.proposalId && x.from === state.playerId && !x.countered);
  if (!p) return { ok: false, error: 'Proposta não encontrada.' };
  dropProposal(state, p.id);
  return { ok: true };
}

export const actions = {
  'diplomacy/propose': actPropose,
  'diplomacy/joinBloc': actJoinBloc,
  'diplomacy/leaveBloc': actLeaveBloc,
  'diplomacy/breakTreaty': actBreakTreaty,
  'diplomacy/cancelProposal': actCancelProposal,
};

// ---------------------------------------------------------------- decision handler (AI -> player)

function onProposalDecision(state, data, decision, choiceId, ctx) {
  const p = state.proposals.find((x) => x.id === decision.payload?.proposalId);
  if (!p) return { status: 'gone' };
  const me = state.playerId;
  const rng = ctx.rng(`decide:${p.id}`);
  if (choiceId === 'accept') {
    dropProposal(state, p.id);
    signFromProposal(state, data, p, rng);
    return { status: 'accepted' };
  }
  if (choiceId === 'counter') {
    p.terms = counterTerms(state, data, p);
    p.countered = true;
    p.respondTurn = state.turn + 1;
    p.expiresTurn = state.turn + 3;
    addNews(state, {
      headline: `Você enviou uma contraproposta a ${short(state, p.from)}.`,
      body: describeTerms(state, data, p.type, p.terms), tags: ['diplomacia', 'jogador'], actors: [me, p.from], importance: 1, icon: '↩️',
    });
    return { status: 'countered' };
  }
  // reject (or expired)
  dropProposal(state, p.id);
  memoryOf(state, p.from).rejected[`${me}:${p.type}`] = state.turn;
  bumpRelation(state, me, p.from, { trust: ctx.expired ? -1 : -3 });
  addNews(state, {
    headline: ctx.expired ? `Proposta de ${short(state, p.from)} expira sem resposta.` : `Você recusou a proposta de ${short(state, p.from)}.`,
    tags: ['diplomacia', 'jogador'], actors: [me, p.from], importance: 1, icon: '✋',
  });
  return { status: 'rejected' };
}

export const decisionHandlers = { 'diplomacy/proposal': onProposalDecision };

// ---------------------------------------------------------------- queries

function stanceLabel(r) {
  let s;
  if (r.trust >= 50) s = 'aliado';
  else if (r.trust >= 20) s = 'parceiro';
  else if (r.trust >= -15) s = 'neutro';
  else if (r.trust >= -45) s = 'frio';
  else s = 'hostil';
  return r.rivalry >= 60 ? `${s} · rival` : s;
}

function qRelations(state, data, actorId = state.playerId) {
  if (!state.actors?.[actorId]) return [];
  return sortedIds(state).filter((o) => o !== actorId).map((o) => {
    const r = relation(state, actorId, o);
    const v = view(state, actorId, o);
    const O = state.actors[o];
    return {
      actorId: o, name: O.name, short: O.short, flag: O.flag, color: O.color, kind: O.kind,
      trust: Math.round(r.trust), dependence: Math.round(r.dependence), rivalry: Math.round(r.rivalry),
      tension: v.tension, stance: stanceLabel(r), sameBloc: v.sameBloc, opposingBloc: v.opposing,
      bloc: O.bloc, isPartner: isPartner(state, actorId, o), costShare: costShare(state, actorId, o),
      treaties: treatiesBetween(state, actorId, o).map((t) => ({ id: t.id, type: t.type, name: t.name })),
      sharedGoals: v.shared.map((g) => ({ id: g, label: milestoneLabel(data, g) })),
    };
  }).sort((x, y) => y.trust - x.trust);
}

function qTreaties(state, data, actorId) {
  const order = { active: 0, expired: 1, broken: 2 };
  return (state.treaties || [])
    .filter((t) => !actorId || t.parties.includes(actorId) || t.brokenBy === actorId)
    .map((t) => ({
      ...t, typeName: typeName(data, t.type), icon: typeDef(data, t.type).icon,
      partyNames: t.parties.map((p) => short(state, p)),
      statusLabel: t.status === 'active' ? 'em vigor' : t.status === 'broken' ? 'rompido' : 'expirado',
      programName: t.terms?.program ? programDef(data, t.terms.program)?.name : null,
      untilYear: t.terms?.untilTurn != null ? yearOf(state, t.terms.untilTurn) : null,
      canBreak: t.status === 'active' && t.parties.includes(state.playerId) && !(t.terms?.blocId && blocOf(state, state.playerId)?.id === t.terms.blocId),
      canAccede: t.status === 'active' && t.terms?.multilateral && !t.terms.blocId && !t.parties.includes(state.playerId),
    }))
    .sort((x, y) => (order[x.status] - order[y.status]) || (y.signedTurn - x.signedTurn));
}

function qBlocs(state, data) {
  return Object.values(state.blocs || {}).map((b) => ({
    ...b,
    memberInfo: b.members.map((m) => ({ id: m, short: short(state, m), flag: state.actors[m]?.flag, color: state.actors[m]?.color, associate: (b.associates || []).includes(m) })),
    cohesion: b.members.length > 1
      ? Math.round(b.members.filter((m) => m !== b.leader).reduce((s, m) => s + relation(state, m, b.leader).trust, 0) / Math.max(1, b.members.length - 1))
      : 100,
    playerMember: b.members.includes(state.playerId),
    joinChance: b.members.includes(state.playerId) ? null : previewProposal(state, data, b.leader, 'join_bloc', { blocId: b.id }).chance,
  }));
}

function qProposalTypes(state, data, to) {
  const me = state.playerId;
  return PROPOSAL_TYPES.map((type) => {
    const td = typeDef(data, type);
    const row = { id: type, name: td.name, description: td.description, icon: td.icon, durationWeeks: td.durationWeeks ?? null };
    if (to && state.actors?.[to] && me) {
      const pre = previewProposal(state, data, to, type, {});
      row.available = !pre.error && pre.u > -500;
      row.reason = pre.error || (pre.u <= -500 ? pre.against?.[0] : undefined);
      row.chance = pre.chance; row.chanceLabel = pre.label; row.terms = pre.terms; row.refusalTrust = pre.refusalTrust;
      row.termsText = pre.terms ? describeTerms(state, data, type, pre.terms) : '';
    }
    return row;
  });
}

function qLeague(state, data) {
  const firstsBy = {};
  for (const [m, f] of Object.entries(state.firsts || {})) {
    (firstsBy[f.actorId] = firstsBy[f.actorId] || []).push({ milestoneId: m, label: milestoneLabel(data, m), turn: f.turn, year: yearOf(state, f.turn) });
  }
  const rows = sortedIds(state).map((id) => {
    const ac = state.actors[id];
    const fs = (firstsBy[id] || []).sort((a, b) => a.turn - b.turn);
    const hist = ac.ai?.prestigeHistory || [];
    const prev = hist.length >= 2 ? hist[hist.length - 2] : 0;
    return {
      actorId: id, name: ac.name, short: ac.short, flag: ac.flag, color: ac.color, kind: ac.kind,
      prestige: Math.round(ac.prestige || 0), reputation: Math.round(ac.reputation || 0),
      firsts: fs, firstsCount: fs.filter((f) => !f.milestoneId.includes(':')).length,
      bloc: ac.bloc, isPlayer: isPlayer(state, id), history: hist.slice(), trend: Math.round((ac.prestige || 0) - prev),
    };
  });
  rows.sort((a, b) => (b.prestige - a.prestige) || (b.firstsCount - a.firstsCount) || (b.reputation - a.reputation) || (a.actorId < b.actorId ? -1 : 1));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

export const queries = {
  'diplomacy/relations': qRelations,
  'diplomacy/relation': (state, data, a, b) => ({ ...relation(state, a, b), tension: tensionOf(state, a, b) }),
  'diplomacy/treaties': qTreaties,
  'diplomacy/blocs': qBlocs,
  'diplomacy/proposalTypes': qProposalTypes,
  'diplomacy/preview': (state, data, to, type, terms) => previewProposal(state, data, to, type, terms || {}),
  'diplomacy/proposals': (state) => (state.proposals || []).filter((p) => p.from === state.playerId || p.to === state.playerId),
  'diplomacy/costShare': (state, data, a, b) => costShare(state, a, b),
  'diplomacy/isPartner': (state, data, a, b) => isPartner(state, a, b),
  'diplomacy/partners': (state, data, actorId = state.playerId) => sortedIds(state).filter((o) => o !== actorId && isPartner(state, actorId, o)),
  'diplomacy/crewSeats': (state, data, actorId = state.playerId) => treatiesFor(state, actorId, 'crew_exchange')
    .map((t) => ({ partnerId: t.parties.find((p) => p !== actorId), seats: t.terms?.seats || 1, treatyId: t.id })),
  'diplomacy/programs': (state, data) => (A(data).programs || []).map((p) => ({ ...p, milestoneLabel: milestoneLabel(data, p.milestone) })),
  'league/table': qLeague,
};
function treatiesFor(state, id, type) {
  return activeTreaties(state).filter((t) => t.parties.includes(id) && (!type || t.type === type));
}

// ---------------------------------------------------------------- game end

export function onGameEnd(state, data, ctx) {
  const table = qLeague(state, data);
  const top = table[0];
  if (!top) return;
  addNews(state, {
    headline: txt(data, ctx.rng('trophy'), 'eraTrophy', null, { a: top.short, prestige: top.prestige }),
    body: table.slice(0, 3).map((r) => `${r.rank}º ${r.short} (${r.prestige})`).join(' · '),
    tags: ['tabela', 'era'], actors: [top.actorId], importance: 3, icon: '🏆',
  });
  state.stats['diplomacy.eraWinner'] = top.actorId;
}

// ---------------------------------------------------------------- 1950–3000 contract (EXPANSION.md §1.5, §3, §10)

/** Weekly drift, monthly upkeep and staggered AI evaluations: substepped week by week by the engine. */
export const meta = { maxDt: 1 };

/**
 * Bring an actor to life mid-game (lifecycle birth, a founded agency): same defaults as init, a staggered first AI
 * evaluation, relation rows with every live core actor (minor actors carry none), bloc from `def.bloc`.
 * Idempotent: an existing actor only gets the missing fields. Returns the live actor.
 */
export function addActor(state, data, def, ctx) {
  if (!def?.id) return null;
  DATA_REF.data = data || DATA_REF.data;
  ensureSlices(state);
  const ac = state.actors[def.id] || JSON.parse(JSON.stringify(def));
  ac.cash = ac.cash ?? Math.round((ac.budget || 0) * 0.25);
  ac.prestige = ac.prestige ?? 0;
  ac.support = ac.support ?? 60;
  ac.reputation = ac.reputation ?? 60;
  ac.culture = ac.culture ?? 0;
  ac.fixedCostShare = ac.fixedCostShare ?? 0.5;
  ac.capabilities = ac.capabilities || { crewed: false, launchSites: [] };
  ac.ai = { cooperation: 0.5, aggression: 0.5, riskTolerance: 0.5, goals: [], ...(ac.ai || {}) };
  if (ac.ai.nextEvalTurn == null) ac.ai.nextEvalTurn = state.turn + 1 + rngFor(state.seed, 'diplomacy', 'stagger', ac.id).int(0, 5);
  ac.ai.memory = ac.ai.memory || { rejected: {}, brokenBy: {}, withdrew: {} };
  ac.ai.prestigeHistory = ac.ai.prestigeHistory || [];
  ac.bloc = ac.bloc ?? null;
  state.actors[ac.id] = ac;
  memoryOf(state, ac.id);
  if ((ac.tier ?? 'core') === 'core') {
    for (const o of sortedIds(state)) {
      if (o === ac.id) continue;
      const k = relKey(ac.id, o);
      if (!state.relations[k]) state.relations[k] = { ...DEFAULT_REL };
    }
  }
  const bid = def.bloc && state.blocs?.[def.bloc] ? def.bloc : null;
  if (bid && !state.blocs[bid].members.includes(ac.id)) {
    state.blocs[bid].members.push(ac.id);
    if (!state.blocs[bid].leader) state.blocs[bid].leader = ac.id;
    syncActorBlocs(state);
  }
  return ac;
}

/**
 * An actor leaves the world (dissolved, merged `into` another, never born): relation rows, bloc seats, open
 * proposals and its seat in treaties go (a treaty left with one party ends). A merge hands the absorbed actor's
 * partnerships to the survivor as trust. The actor leaves state.actors (lifecycle keeps its tombstone).
 */
export function retireActor(state, data, id, { into = null, reason = 'dissolve' } = {}, ctx) {
  if (!id) return false;
  const survivor = into && into !== id && state.actors?.[into] ? into : null;
  for (const k of Object.keys(state.relations || {})) {
    const [a, b] = k.split('|');
    if (a !== id && b !== id) continue;
    const other = a === id ? b : a;
    if (survivor && other !== survivor && state.relations[k].trust > 0) bumpRelation(state, survivor, other, { trust: Math.round(state.relations[k].trust * 0.25) });
    delete state.relations[k];
  }
  for (const b of Object.values(state.blocs || {})) {
    if (!Array.isArray(b.members) || !b.members.includes(id)) continue;
    b.members = b.members.filter((m) => m !== id);
    if (survivor && !b.members.includes(survivor) && !blocOf(state, survivor)) b.members.push(survivor);
    if (b.leader === id) b.leader = b.members[0] || null;
  }
  for (const t of state.treaties || []) {
    if (!Array.isArray(t.parties) || !t.parties.includes(id)) continue;
    const rest = t.parties.filter((p) => p !== id);
    if (survivor && t.status === 'active' && !rest.includes(survivor) && t.type !== 'peaceful_use') rest.push(survivor);
    t.parties = rest;
    if (t.status === 'active' && t.parties.length < 2 && !t.terms?.multilateral) {
      t.status = 'expired';
      t.endedTurn = state.turn;
      t.endReason = reason === 'merge' ? 'fusão' : 'fim de uma das partes';
    }
  }
  if (Array.isArray(state.proposals)) state.proposals = state.proposals.filter((p) => p.from !== id && p.to !== id && !(p.parties || []).includes(id));
  state.decisions = (state.decisions || []).filter((d) => !(d.kind?.startsWith('diplomacy/') && (d.payload?.from === id || d.payload?.actorId === id || d.payload?.partnerId === id)));
  for (const ac of Object.values(state.actors || {})) {
    const m = ac?.ai?.memory;
    if (!m) continue;
    for (const k of ['rejected', 'brokenBy', 'withdrew']) if (m[k]) for (const key of Object.keys(m[k])) if (key.split('|').includes(id) || key === id) delete m[k][key];
  }
  if (state.actors) delete state.actors[id];
  syncActorBlocs(state);
  return true;
}

/** Engine hook (lifecycle birth through ctx.hooks): make sure the diplomacy fields exist. */
export function onActorBorn(state, data, ctx, id) {
  if (state.actors?.[id]) addActor(state, data, state.actors[id], ctx);
}
/** Engine hook: idempotent cleanup (lifecycle already called retireActor). */
export function onActorGone(state, data, ctx, id, info = {}) {
  if (state.actors?.[id]) return; // still alive (a rename is not a death)
  retireActor(state, data, id, info, ctx);
}

/** Treaties broken/expired more than 10 years ago leave the slice (EXPANSION.md §10). */
export function compact(state) {
  const long = Number.isFinite(state.endTurn) && state.endTurn > 10 * 52; // 1950–3000: keep 3 years of ended treaties
  const limit = state.turn - (long ? 3 : 10) * 52;
  if (long) {
    // AI memories past the longest window that reads them (BREAK_MEMORY) never matter again: drop them
    for (const ac of Object.values(state.actors || {})) {
      const mem = ac?.ai?.memory;
      if (!mem) continue;
      for (const kind of ['rejected', 'withdrew', 'brokenBy']) {
        const m = mem[kind];
        if (!m || typeof m !== 'object') continue;
        for (const [k, t] of Object.entries(m)) if (!Number.isFinite(t) || state.turn - t >= BREAK_MEMORY) delete m[k];
      }
    }
  }
  if (!Array.isArray(state.treaties)) return;
  state.treaties = state.treaties.filter((t) => t.status === 'active' || !Number.isFinite(t.endedTurn ?? t.brokenTurn ?? t.expiredTurn) || (t.endedTurn ?? t.brokenTurn ?? t.expiredTurn) >= limit);
}

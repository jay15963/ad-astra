// Narrative module: authored event cards, chains, operation events (transit) and the Agency Album.
// Implements GDD "Aleatoriedade, eventos e narrativa" + "Turno 9" for the Corrida Lunar.
// Pure sim: no DOM, no Math.random/Date.now. All randomness via ctx.rng(label) or rngFor(state.seed, ...).
//
// Slices owned: state.events, state.album.
// state.events = {
//   history: {[eventId]: {count, lastTurn}}, flags: {}, chains: {[chainId]: step},
//   scheduled: [{eventId, turn, context, tries?}],
//   failStreak,            // consecutive player mission failures ("sorte com memória leve")
//   lastRandomTurn,        // pacing of random narrative events
//   missionEvents: {[missionId]: n},  // operation events already shown per mission
//   missionRisk: {[missionId]: delta},// accumulated {missionRisk} effects (+ = riskier; subtract from p)
//   journal: [{turn, eventId, title, choice}], albumKeys: {[key]: true} }

import { clamp, relKey, addNews, pushDecision, emitSignal, log, changeActor, nextId } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import * as budget from './budget.js';
import * as politics from './politics.js';
import * as diplomacy from './diplomacy.js';
import * as research from './research.js';

// ---------------------------------------------------------------- constants

const PENDING_CAP = 3;          // max event cards waiting in the queue before random events pause
const NARRATIVE_EXPIRE_WEEKS = 8;
const OPERATION_EXPIRE_WEEKS = 3;
const OP_CHANCE = 1;            // missions already rolls its own weekly chance before calling pickOperationEvent
const OP_MAX_PER_MISSION = 2;
const JOURNAL_CAP = 120;

export const PLACEHOLDERS = ['actor', 'person', 'mission', 'rival', 'year'];
const ACTOR_FIELDS = ['support', 'reputation', 'culture', 'prestige', 'budget'];
const RELATION_FIELDS = ['trust', 'dependence', 'rivalry'];
const CREW_FIELDS = ['skill', 'morale', 'loyalty', 'ambition', 'experience'];
const CREW_STATUS = ['left', 'injured'];
const ROLES = ['engineer', 'flight_director', 'astronaut'];
export const RARITIES = ['common', 'rare', 'epic', 'legendary'];
const RARITY_LABELS = { common: 'Comum', rare: 'Rara', epic: 'Épica', legendary: 'Lendária' };
const FAIL_OUTCOMES = ['recoverable', 'catastrophic'];

const FIELD_LABELS = {
  support: 'Apoio', reputation: 'Reputação', culture: 'Cultura', prestige: 'Prestígio', budget: 'Verba anual',
  trust: 'Confiança', dependence: 'Dependência', rivalry: 'Rivalidade',
  skill: 'habilidade', morale: 'moral', loyalty: 'lealdade', ambition: 'ambição', experience: 'experiência',
};
const ROLE_LABELS = { engineer: 'engenheiro(a)', flight_director: 'diretor(a) de voo', astronaut: 'astronauta' };

// Schemas used by validateEvent (unknown keys are errors).
const EVENT_KEYS = ['id', 'kind', 'title', 'text', 'portrait', 'trigger', 'weight', 'cooldownWeeks', 'once', 'choices', 'chain',
  'subject', 'rival', 'tags', 'defaultChoice', 'urgency'];
const TRIGGER_KEYS = ['minTurn', 'maxTurn', 'actors', 'requiresFlags', 'forbidsFlags', 'signal', 'signalWhere', 'chance',
  'condition', 'destinations', 'crewed', 'scheduledOnly'];
const CHOICE_KEYS = ['id', 'label', 'preview', 'requires', 'effects'];
const COND_COMPARE_KEYS = ['culture', 'cash', 'support', 'reputation', 'prestige', 'budget', 'failStreak', 'turn', 'tension', 'trust'];
const COND_KEYS = [...COND_COMPARE_KEYS, 'tech', 'flag', 'value', 'hasRole', 'all', 'any', 'not', 'bloc'];
const EFFECT_SHAPES = {
  actor: { required: ['actor', 'field', 'delta'], optional: [] },
  relation: { required: ['relation', 'field', 'delta'], optional: [] },
  flag: { required: ['flag'], optional: ['value'] },
  schedule: { required: ['schedule', 'inWeeks'], optional: [] },
  science: { required: ['science'], optional: [] },
  cash: { required: ['cash'], optional: [] },
  crew: { required: ['crew', 'field', 'delta'], optional: [] },
  crewStatus: { required: ['crewStatus'], optional: [] },
  missionRisk: { required: ['missionRisk'], optional: [] },
  news: { required: ['news'], optional: ['importance'] },
  album: { required: ['album'], optional: ['rarity'] },
  tension: { required: ['tension', 'delta'], optional: [] },
  unlockTech: { required: ['unlockTech'], optional: [] },
};

// ---------------------------------------------------------------- small helpers

function ensure(state) {
  const ev = state.events || (state.events = {});
  ev.history ||= {};
  ev.flags ||= {};
  ev.chains ||= {};
  ev.scheduled ||= [];
  ev.failStreak ??= 0;
  if (ev.lastRandomTurn === undefined) ev.lastRandomTurn = null;
  ev.missionEvents ||= {};
  ev.missionRisk ||= {};
  ev.journal ||= [];
  ev.albumKeys ||= {};
  if (!Array.isArray(state.album)) state.album = [];
  return ev;
}

const eventList = (data) => data?.events?.events || [];
export function getEvent(data, id) {
  return data?.index?.events?.[id] || eventList(data).find((e) => e.id === id) || null;
}

const playerActor = (state) => state.actors?.[state.playerId] || {};

function fmtMoney(m) {
  const a = Math.abs(m);
  if (a >= 1000) return `US$ ${(a / 1000).toFixed(1).replace('.', ',')} bi`;
  return `US$ ${Math.round(a)} mi`;
}
const signed = (n, unit = '') => `${n >= 0 ? '+' : '−'}${Math.abs(n)}${unit}`;

/** '>20', '<=3', '=1', '!=0' (plain number = '>='). */
export function compare(value, spec) {
  const v = Number(value) || 0;
  if (typeof spec === 'number') return v >= spec;
  const m = /^\s*(>=|<=|!=|==|>|<|=)?\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(spec));
  if (!m) return false;
  const n = Number(m[2]);
  switch (m[1] || '>=') {
    case '>': return v > n;
    case '<': return v < n;
    case '>=': return v >= n;
    case '<=': return v <= n;
    case '!=': return v !== n;
    default: return v === n;
  }
}
const validCompare = (spec) => typeof spec === 'number' || /^\s*(>=|<=|!=|==|>|<|=)?\s*-?\d+(\.\d+)?\s*$/.test(String(spec));

function activeCrew(state, role) {
  return Object.values(state.crew || {}).filter((p) => p && p.actorId === state.playerId && p.status === 'active'
    && (!role || role === 'any' || (Array.isArray(role) ? role.includes(p.role) : p.role === role)));
}

function relationWith(state, other) {
  return state.relations?.[relKey(state.playerId, other)] || {};
}
function tensionWith(state, other) {
  return state.tension?.[relKey(state.playerId, other)] ?? 0;
}
function inBloc(state, actorId, blocId) {
  const b = state.blocs?.[blocId];
  if (b?.members?.includes(actorId)) return true;
  return state.actors?.[actorId]?.bloc === blocId;
}
function hasTech(state, nodeId) {
  return !!(state.research?.unlocked?.includes?.(nodeId) || state.events?.flags?.[`tech:${nodeId}`]);
}

function actorName(state, data, id) {
  if (!id) return null;
  const a = state.actors?.[id] || data?.index?.actors?.[id];
  return a?.short || a?.name || id;
}
function personName(state, id) {
  if (!id) return null;
  return state.crew?.[id]?.name || state.memorial?.find?.((m) => m.crewId === id)?.name || null;
}
function missionName(state, data, id) {
  if (!id) return null;
  return state.missions?.find?.((m) => m.id === id)?.name || data?.index?.calendar?.[id]?.name || null;
}
function milestoneLabel(data, id) {
  const base = String(id || '').split(':')[0];
  return data?.events?.milestones?.[id] || data?.events?.milestones?.[base] || base;
}

const pendingEvents = (state) => (state.decisions || []).filter((d) => typeof d.kind === 'string' && d.kind.startsWith('event/'));
const isPending = (state, eventId) => pendingEvents(state).some((d) => d.payload?.eventId === eventId);
const isFollowUp = (event) => !!(event.trigger?.scheduledOnly || (event.chain && event.chain.step > 1));

// ---------------------------------------------------------------- Condition DSL

/** Evaluate a Condition (ARCHITECTURE.md) for the player. Multiple keys in one object = all must hold. */
export function evalCondition(state, data, cond, context = {}) {
  if (!cond) return true;
  if (Array.isArray(cond)) return cond.every((c) => evalCondition(state, data, c, context));
  const p = playerActor(state);
  for (const [k, v] of Object.entries(cond)) {
    let ok;
    switch (k) {
      case 'value': ok = true; break; // paired with 'flag'
      case 'all': ok = (v || []).every((c) => evalCondition(state, data, c, context)); break;
      case 'any': ok = (v || []).some((c) => evalCondition(state, data, c, context)); break;
      case 'not': ok = !evalCondition(state, data, v, context); break;
      case 'culture': case 'cash': case 'support': case 'reputation': case 'prestige': case 'budget':
        ok = compare(p[k] ?? 0, v); break;
      case 'failStreak': ok = compare(state.events?.failStreak ?? 0, v); break;
      case 'turn': ok = compare(state.turn, v); break;
      case 'tech': ok = hasTech(state, v); break;
      case 'flag': {
        const f = state.events?.flags?.[v];
        ok = 'value' in cond ? f === cond.value : !!f;
        break;
      }
      case 'hasRole': ok = activeCrew(state, v).length > 0; break;
      case 'bloc': ok = inBloc(state, state.playerId, v); break;
      case 'tension': ok = context.rival ? compare(tensionWith(state, context.rival), v) : false; break;
      case 'trust': ok = context.rival ? compare(relationWith(state, context.rival).trust ?? 0, v) : false; break;
      default: ok = false;
    }
    if (!ok) return false;
  }
  return true;
}

/** pt-BR description of a condition (used as the "reason" of disabled choices). */
export function describeCondition(state, data, cond, context = {}) {
  if (!cond) return '';
  if (Array.isArray(cond)) return cond.map((c) => describeCondition(state, data, c, context)).join(' e ');
  const parts = [];
  const cmp = (spec) => String(spec).replace(/^\s*(>=|<=|!=|==|>|<|=)?\s*/, (m, op) => `${op || '≥'} `).replace('>=', '≥').replace('<=', '≤');
  for (const [k, v] of Object.entries(cond)) {
    switch (k) {
      case 'value': break;
      case 'all': parts.push((v || []).map((c) => describeCondition(state, data, c, context)).join(' e ')); break;
      case 'any': parts.push((v || []).map((c) => describeCondition(state, data, c, context)).join(' ou ')); break;
      case 'not': parts.push(`não ${describeCondition(state, data, v, context)}`); break;
      case 'culture': parts.push(`cultura ${cmp(v)}${/</.test(v) ? ' (cautelosa)' : /\>/.test(v) ? ' (ousada)' : ''}`); break;
      case 'cash': { const n = Number(String(v).replace(/[^\d.-]/g, '')); parts.push(`caixa ${cmp(v).replace(/-?\d+(\.\d+)?$/, fmtMoney(n))}`); break; }
      case 'support': case 'reputation': case 'prestige': case 'budget':
        parts.push(`${FIELD_LABELS[k].toLowerCase()} ${cmp(v)}`); break;
      case 'failStreak': parts.push(`falhas seguidas ${cmp(v)}`); break;
      case 'turn': parts.push(`semana ${cmp(v)}`); break;
      case 'tech': parts.push(`tecnologia "${data?.index?.tech?.[v]?.name || v}"`); break;
      case 'flag': parts.push('uma decisão anterior'); break;
      case 'hasRole': parts.push(`um(a) ${ROLE_LABELS[v] || v} ativo(a)`); break;
      case 'bloc': parts.push(`ser membro de ${state.blocs?.[v]?.name || v}`); break;
      case 'tension': parts.push(`tensão com ${actorName(state, data, context.rival) || 'o rival'} ${cmp(v)}`); break;
      case 'trust': parts.push(`confiança de ${actorName(state, data, context.rival) || 'o rival'} ${cmp(v)}`); break;
      default: parts.push(k);
    }
  }
  return parts.filter(Boolean).join(' e ');
}

// ---------------------------------------------------------------- context & templating

const needsCache = new WeakMap();
/** What context an event needs, inferred from its text and effects. */
function analyzeNeeds(event) {
  if (needsCache.has(event)) return needsCache.get(event);
  const texts = [event.title, event.text, ...(event.choices || []).flatMap((c) => [c.label, c.preview])].join(' ');
  const effects = (event.choices || []).flatMap((c) => c.effects || []);
  const newsTexts = effects.map((e) => `${e.news || ''} ${e.album || ''}`).join(' ');
  const all = `${texts} ${newsTexts}`;
  const needs = {
    person: /\{person\}/.test(all) || event.portrait === 'crew' || effects.some((e) => e.crew === 'subject' || e.crewStatus),
    mission: /\{mission\}/.test(all) || effects.some((e) => 'missionRisk' in e) || event.kind === 'operation',
    rival: /\{rival\}/.test(all) || Array.isArray(event.rival)
      || effects.some((e) => e.actor === 'rival' || e.relation === 'rival' || e.tension === 'rival'),
  };
  needsCache.set(event, needs);
  return needs;
}

function missionCrewIds(state, missionId) {
  const m = state.missions?.find?.((x) => x.id === missionId);
  if (!m?.crew) return [];
  return [m.crew.commander, ...(m.crew.astronauts || []), m.crew.flightDirector].filter(Boolean);
}

/**
 * Choose the event's context deterministically: {actor, person?, rival?, mission?, milestone?}.
 * `base` carries ids from a signal or a chain; returns null when a required piece is missing.
 */
export function buildContext(state, data, event, rng, base = {}) {
  const needs = analyzeNeeds(event);
  const c = { actor: state.playerId };
  // mission first (operation events pick crew from the mission)
  if (base.mission && state.missions?.some?.((m) => m.id === base.mission)) c.mission = base.mission;
  else if (needs.mission) {
    if (event.kind === 'operation') return null;
    const pool = (state.missions || []).filter((m) => m.status === 'planning' || m.status === 'scheduled');
    if (!pool.length) return null;
    c.mission = rng.pick(pool).id;
  }
  // person
  if (base.person && (state.crew?.[base.person] || personName(state, base.person))) c.person = base.person;
  else if (needs.person) {
    let pool = activeCrew(state, event.subject);
    if (event.kind === 'operation') {
      const ids = missionCrewIds(state, c.mission);
      pool = pool.filter((p) => ids.includes(p.id));
    }
    if (!pool.length) return null;
    c.person = rng.pick(pool).id;
  }
  // rival
  if (base.rival && base.rival !== state.playerId && state.actors?.[base.rival]
      && (!Array.isArray(event.rival) || event.rival.includes(base.rival))) c.rival = base.rival;
  else if (needs.rival) {
    const ids = Array.isArray(event.rival) ? event.rival : Object.keys(state.actors || {});
    const pool = ids.filter((id) => id !== state.playerId && state.actors?.[id]);
    if (!pool.length) return null;
    const pick = rng.weighted(pool.map((id) => ({ id, weight: 5 + (relationWith(state, id).rivalry ?? 20) })));
    c.rival = pick.id;
  }
  if (base.milestone) c.milestone = base.milestone;
  return c;
}

/** Replace {actor}, {person}, {mission}, {rival}, {year} (and {milestone} for album). */
export function renderText(state, data, text, context = {}) {
  if (!text) return '';
  return String(text).replace(/\{(\w+)\}/g, (m, k) => {
    switch (k) {
      case 'actor': return actorName(state, data, context.actor || state.playerId) || 'a agência';
      case 'rival': return actorName(state, data, context.rival) || 'um rival';
      case 'person': return personName(state, context.person) || 'alguém da equipe';
      case 'mission': return missionName(state, data, context.mission) || 'a missão';
      case 'year': return String((state.startYear || 2026) + Math.floor((state.turn || 0) / 52));
      case 'milestone': return milestoneLabel(data, context.milestone);
      default: return m;
    }
  });
}

/** Short visible preview of a choice's effects (hidden effects such as flags/schedules are omitted). */
/**
 * Money in event data is written for a mid-size agency (~US$ 4 bi/yr). Scale it to the actor's starting budget
 * so a US$ 60 mi bill hurts ISRO and is still felt at NASA. Rounded to US$ 5 mi.
 */
export function moneyScale(state, actorId = state.playerId) {
  const b = state.world?.baseBudget?.[actorId] ?? state.actors?.[actorId]?.budget ?? 4000;
  return clamp(b / 4000, 0.4, 2.5);
}
const scaleMoney = (state, v, actorId) => {
  const x = v * moneyScale(state, actorId);
  return Math.abs(x) >= 10 ? Math.round(x / 5) * 5 : Math.round(x);
};

export function describeEffects(state, data, effects, context = {}) {
  const out = [];
  const who = (t) => (t === 'player' || t === state.playerId ? null : actorName(state, data, t === 'rival' ? context.rival : t));
  for (const e of effects || []) {
    if ('actor' in e) {
      const w = who(e.actor);
      const tid = e.actor === 'player' ? state.playerId : e.actor === 'rival' ? context.rival : e.actor;
      const val = e.field === 'budget' ? `${e.delta >= 0 ? '+' : '−'}${fmtMoney(Math.abs(scaleMoney(state, e.delta, tid)))}` : signed(e.delta);
      let label = FIELD_LABELS[e.field] || e.field;
      if (e.field === 'culture') label += e.delta >= 0 ? ' (ousadia)' : ' (cautela)';
      out.push(w ? `${w}: ${label.toLowerCase()} ${val}` : `${label} ${val}`);
    } else if ('relation' in e) {
      out.push(`${FIELD_LABELS[e.field] || e.field} com ${who(e.relation) || 'parceiro'} ${signed(e.delta)}`);
    } else if ('cash' in e) {
      out.push(`Caixa ${e.cash >= 0 ? '+' : '−'}${fmtMoney(Math.abs(scaleMoney(state, e.cash)))}`);
    } else if ('science' in e) {
      out.push(`Ciência ${signed(e.science)}`);
    } else if ('crew' in e) {
      const name = e.crew === 'subject' ? (personName(state, context.person) || 'Pessoa') : 'Alguém da equipe';
      out.push(`${name}: ${FIELD_LABELS[e.field] || e.field} ${signed(e.delta)}`);
    } else if ('crewStatus' in e) {
      const name = personName(state, context.person) || 'A pessoa';
      out.push(e.crewStatus === 'left' ? `${name} deixa a agência` : `${name} fica afastado(a)`);
    } else if ('missionRisk' in e) {
      const pts = Math.round(e.missionRisk * 100);
      out.push(`Risco de ${missionName(state, data, context.mission) || 'missão'} ${signed(pts, ' pts')}`);
    } else if ('tension' in e) {
      out.push(`Tensão com ${who(e.tension) || 'rival'} ${signed(e.delta)}`);
    } else if ('unlockTech' in e) {
      out.push(`Libera tecnologia: ${data?.index?.tech?.[e.unlockTech]?.name || e.unlockTech}`);
    } else if ('album' in e) {
      out.push('Carta no Álbum');
    }
  }
  return out.join(' · ');
}

// ---------------------------------------------------------------- eligibility & weights

/**
 * Returns the context if `event` can fire now, else null.
 * mode: 'random' (weekly roll), 'signal', 'scheduled' (chain step), 'operation' (transit).
 */
export function eligibleContext(state, data, event, { mode = 'random', base = {}, rng } = {}) {
  const ev = ensure(state);
  const t = event.trigger || {};
  const r = rng || rngFor(state.seed, 'narrative-ctx', state.turn, event.id);
  if (isPending(state, event.id)) return null;
  const h = ev.history[event.id];
  if (event.once && h?.count) return null;
  if (mode !== 'scheduled') {
    if (isFollowUp(event)) return null;
    if (h?.lastTurn != null && state.turn - h.lastTurn < (event.cooldownWeeks ?? 26)) return null;
    if (t.minTurn != null && state.turn < t.minTurn) return null;
    if (t.maxTurn != null && state.turn > t.maxTurn) return null;
  }
  if (mode === 'random' && (event.kind === 'operation' || t.signal)) return null;
  if (mode === 'signal' && (!t.signal || event.kind === 'operation')) return null;
  if (mode === 'operation' && event.kind !== 'operation') return null;
  if (t.actors?.length && !t.actors.includes(state.playerId)) return null;
  for (const f of t.requiresFlags || []) if (!ev.flags[f]) return null;
  for (const f of t.forbidsFlags || []) if (ev.flags[f]) return null;
  // signal events talk about *that* mission/person: never substitute a random one
  if (mode === 'signal') {
    const needs = analyzeNeeds(event);
    if ((needs.mission && !base.mission) || (needs.person && !base.person)) return null;
  }
  const context = buildContext(state, data, event, r, base);
  if (!context) return null;
  if (!evalCondition(state, data, t.condition, context)) return null;
  if (!(event.choices || []).some((c) => evalCondition(state, data, c.requires, context))) return null;
  return context;
}

/** Weight with history decay (no repetition) and recovery boost after 3 failures in a row. */
export function eventWeight(state, event) {
  const ev = state.events || {};
  let w = event.weight ?? 10;
  const h = ev.history?.[event.id];
  if (h?.count) {
    const age = Math.max(0, state.turn - (h.lastTurn ?? 0));
    const effCount = h.count * Math.pow(0.5, age / 104); // memory fades over ~2 years
    w *= 1 / (1 + 1.5 * effCount);
    w *= Math.min(1, 0.25 + age / 52);
  }
  if (event.tags?.includes('recovery')) w *= (ev.failStreak ?? 0) >= 3 ? 5 : 0.3;
  return w;
}

/** All events that could fire right now as random narrative events, with weights (for tests/debug). */
export function eligibleEvents(state, data, mode = 'random') {
  const out = [];
  for (const event of eventList(data)) {
    const context = eligibleContext(state, data, event, { mode, rng: rngFor(state.seed, 'narrative-ctx', state.turn, event.id) });
    if (context) out.push({ event, context, weight: eventWeight(state, event) });
  }
  return out;
}

// ---------------------------------------------------------------- decisions

function pushEventDecision(state, data, event, context, source) {
  const ev = ensure(state);
  const h = ev.history[event.id] || (ev.history[event.id] = { count: 0, lastTurn: null });
  h.count += 1;
  h.lastTurn = state.turn;
  const R = (s) => renderText(state, data, s, context);
  const choices = (event.choices || []).map((c) => {
    const ok = evalCondition(state, data, c.requires, context);
    const auto = describeEffects(state, data, c.effects, context);
    const out = { id: c.id, label: R(c.label), preview: [R(c.preview), auto].filter(Boolean).join(' · ') };
    if (!ok) { out.disabled = true; out.reason = `Requer ${describeCondition(state, data, c.requires, context)}`; }
    return out;
  });
  const enabled = choices.filter((c) => !c.disabled);
  const def = enabled.find((c) => c.id === event.defaultChoice) || enabled[0] || choices[0];
  let portrait = null;
  if (event.portrait === 'crew' && context.person) portrait = { crewId: context.person };
  else if (event.portrait === 'actor') portrait = { actorId: context.rival || state.playerId };
  const op = event.kind === 'operation';
  const d = pushDecision(state, {
    kind: `event/${event.id}`,
    title: R(event.title),
    body: R(event.text),
    portrait,
    choices,
    urgency: event.urgency ?? (op ? 3 : 2),
    blocking: false,
    expiresTurn: state.turn + (op ? OPERATION_EXPIRE_WEEKS : NARRATIVE_EXPIRE_WEEKS),
    defaultChoice: def?.id,
    payload: { eventId: event.id, context, source, eventKind: event.kind || 'narrative' },
  });
  state.stats ||= {};
  state.stats['narrative.shown'] = (state.stats['narrative.shown'] || 0) + 1;
  return d;
}

function resolveEvent(state, data, decision, choiceId) {
  const ev = ensure(state);
  const eventId = decision.payload?.eventId || String(decision.kind || '').replace(/^event\//, '');
  const event = getEvent(data, eventId);
  if (!event) { log(state, `narrative: evento desconhecido ${eventId}`); return {}; }
  const choice = event.choices?.find((c) => c.id === choiceId) || event.choices?.find((c) => c.id === decision.defaultChoice) || event.choices?.[0];
  if (!choice) return {};
  const context = { ...(decision.payload?.context || {}), eventId, choiceId: choice.id, note: renderText(state, data, event.title, decision.payload?.context || {}) };
  applyEffects(state, data, choice.effects, context);
  if (event.chain?.id) ev.chains[event.chain.id] = event.chain.step ?? 1;
  ev.journal.unshift({ turn: state.turn, eventId, title: context.note, choice: renderText(state, data, choice.label, context), chain: event.chain?.id || null });
  if (ev.journal.length > JOURNAL_CAP) ev.journal.length = JOURNAL_CAP;
  state.stats ||= {};
  state.stats['narrative.resolved'] = (state.stats['narrative.resolved'] || 0) + 1;
  return { eventId, choiceId: choice.id };
}

// ---------------------------------------------------------------- Effect DSL

const resolveTarget = (state, t, context) => (t === 'player' ? state.playerId : t === 'rival' ? context.rival : t);

function scheduleContext(context) {
  const c = {};
  for (const k of ['actor', 'person', 'rival', 'mission']) if (context[k]) c[k] = context[k];
  return c;
}

/** Interpret a list of Effects (ARCHITECTURE.md DSL). context: {person, rival, mission, eventId?, choiceId?, note?}. */
export function applyEffects(state, data, effects, context = {}) {
  ensure(state);
  const rng = rngFor(state.seed, 'narrative-fx', state.turn, context.eventId || '', context.choiceId || '');
  let n = 0;
  for (const e of effects || []) {
    try {
      applyOne(state, data, e, context, rng);
      n++;
    } catch (err) {
      log(state, `narrative: efeito ignorado ${JSON.stringify(e)} (${err.message})`);
    }
  }
  return n;
}

function applyOne(state, data, e, context, rng) {
  const ev = state.events;
  const pid = state.playerId;
  const note = context.note || 'Evento';
  if ('actor' in e) {
    const id = resolveTarget(state, e.actor, context);
    if (!id || !state.actors?.[id]) return;
    const from = state.actors[id][e.field] ?? 0;
    changeActor(state, id, e.field, e.field === 'budget' ? scaleMoney(state, e.delta, id) : e.delta);
    if (e.field === 'budget') emitSignal(state, 'budget/changed', { actorId: id, from, to: state.actors[id].budget });
  } else if ('relation' in e) {
    const other = resolveTarget(state, e.relation, context);
    if (!other || other === pid) return;
    // relations belong to diplomacy: go through its export
    if (['trust', 'dependence', 'rivalry'].includes(e.field) && typeof diplomacy.bumpRelation === 'function') diplomacy.bumpRelation(state, pid, other, { [e.field]: e.delta });
  } else if ('flag' in e) {
    ev.flags[e.flag] = e.value ?? true;
  } else if ('schedule' in e) {
    ev.scheduled.push({ eventId: e.schedule, turn: state.turn + Math.max(1, e.inWeeks | 0), context: scheduleContext(context) });
  } else if ('science' in e) {
    if (typeof research.addSciencePoints === 'function') research.addSciencePoints(state, e.science, `evento: ${note}`);
    else { state.stats ||= {}; state.stats['narrative.scienceUnclaimed'] = (state.stats['narrative.scienceUnclaimed'] || 0) + e.science; }
  } else if ('cash' in e) {
    const amt = scaleMoney(state, e.cash);
    const category = context.mission ? 'missions' : amt >= 0 ? 'grants' : 'facilities';
    if (amt >= 0) {
      if (typeof budget.earn === 'function') budget.earn(state, pid, amt, category, note);
      else changeActor(state, pid, 'cash', amt);
    } else if (typeof budget.spend === 'function') {
      if (budget.spend(state, pid, -amt, category, note) === false) changeActor(state, pid, 'cash', amt); // forced (debt)
    } else changeActor(state, pid, 'cash', amt);
  } else if ('crew' in e) {
    let person = null;
    if (e.crew === 'subject') person = state.crew?.[context.person];
    else {
      const pool = activeCrew(state).filter((p) => p.id !== context.person);
      person = pool.length ? rng.pick(pool) : null;
    }
    if (!person || person.status === 'dead' || person.status === 'left') return;
    const hi = e.field === 'experience' ? Infinity : 100;
    person[e.field] = clamp((person[e.field] ?? 50) + e.delta, 0, hi);
  } else if ('crewStatus' in e) {
    const person = state.crew?.[context.person];
    if (!person || person.status === 'dead' || person.status === 'left') return;
    person.status = e.crewStatus;
    if (e.crewStatus === 'injured') person.injuredUntil = state.turn + 8; // hint for crew module
    person.history ||= [];
    person.history.push({ turn: state.turn, text: e.crewStatus === 'left' ? `Deixou a agência (${note})` : `Afastado(a) (${note})` });
    emitSignal(state, e.crewStatus === 'left' ? 'crew/left' : 'crew/injured', { crewId: person.id, reason: context.eventId || null });
  } else if ('missionRisk' in e) {
    const id = context.mission;
    if (!id) return;
    ev.missionRisk[id] = Math.round(((ev.missionRisk[id] || 0) + e.missionRisk) * 1000) / 1000;
  } else if ('news' in e) {
    const actors = [pid, context.rival].filter(Boolean);
    addNews(state, { headline: renderText(state, data, e.news, context), importance: e.importance ?? 2, tags: ['evento'], actors, icon: 'event' });
  } else if ('album' in e) {
    addAlbumCard(state, data, `event:${context.eventId || ''}:${e.album}`, {
      title: renderText(state, data, e.album, context),
      headline: note,
      kind: 'event',
      rarity: RARITIES.includes(e.rarity) ? e.rarity : 'rare',
      missionId: context.mission,
      crewIds: context.person ? [context.person] : undefined,
    });
  } else if ('tension' in e) {
    const other = resolveTarget(state, e.tension, context);
    if (!other || other === pid) return;
    // tension belongs to politics: a provocation becomes pressure there (no phantom level change, no fake signal)
    if (typeof politics.nudgeTension === 'function') politics.nudgeTension(state, pid, other, Number(e.delta) || 0, `evento: ${note}`, data);
  } else if ('unlockTech' in e) {
    const id = e.unlockTech;
    ev.flags[`tech:${id}`] = true;
    if (typeof research.unlockNode === 'function') research.unlockNode(state, id);
    else if (Array.isArray(state.research?.unlocked) && !state.research.unlocked.includes(id)) state.research.unlocked.push(id);
    emitSignal(state, 'research/completed', { nodeId: id, actorId: pid, source: 'event' });
  }
}

// ---------------------------------------------------------------- Album

function addAlbumCard(state, data, key, card) {
  const ev = ensure(state);
  if (key && ev.albumKeys[key]) return null;
  if (key) ev.albumKeys[key] = true;
  const c = { id: nextId(state, 'card'), turn: state.turn, title: card.title, headline: card.headline || '', kind: card.kind || 'moment',
    rarity: RARITIES.includes(card.rarity) ? card.rarity : 'common' };
  if (card.missionId) c.missionId = card.missionId;
  if (card.crewIds?.length) c.crewIds = card.crewIds;
  state.album.push(c);
  return c;
}

function cardFromTemplate(state, data, key, tplId, context, extra = {}) {
  const tpl = data?.events?.album?.[tplId];
  if (!tpl) return null;
  const R = (s) => renderText(state, data, s, context);
  return addAlbumCard(state, data, key, {
    title: R(tpl.title), headline: extra.headline || R(tpl.headline), kind: tpl.kind || tplId, rarity: tpl.rarity,
    missionId: context.mission, crewIds: extra.crewIds,
  });
}

function albumFromMission(state, data, sig) {
  const ev = state.events;
  const m = state.missions?.find?.((x) => x.id === sig.missionId);
  const context = { mission: sig.missionId };
  const extra = { headline: m?.result?.headlines?.[0], crewIds: missionCrewIds(state, sig.missionId).filter((id) => state.crew?.[id]?.role === 'astronaut') };
  const lunar = /^(lunar|cislunar)/.test(sig.destination || '');
  if (sig.outcome === 'total') {
    // one card per mission: the most notable "first" wins, every applicable first is marked as claimed
    const firsts = [];
    if (lunar && sig.crewed) firsts.push([`lunar_crewed:${sig.missionId}:${sig.phase}`, 'lunarCrewed']);
    if (sig.crewed && !ev.albumKeys.first_crewed) firsts.push(['first_crewed', 'firstCrewed']);
    if (lunar && !ev.albumKeys.first_lunar) firsts.push(['first_lunar', 'firstLunar']);
    if (!ev.albumKeys.first_success) firsts.push(['first_success', 'firstSuccess']);
    if (firsts.length) {
      cardFromTemplate(state, data, firsts[0][0], firsts[0][1], context, extra);
      for (const [key] of firsts) ev.albumKeys[key] = true;
    }
  } else if (sig.crewed && (sig.outcome === 'partial' || sig.outcome === 'recoverable')) {
    cardFromTemplate(state, data, `near_miss:${sig.missionId}:${sig.phase}`, 'nearMiss', context, extra);
  } else if (sig.outcome === 'partial' && ev.failStreak >= 2) {
    cardFromTemplate(state, data, `comeback:${sig.missionId}`, 'comeback', context, extra);
  }
}

// ---------------------------------------------------------------- signals

function signalActor(state, sig) {
  if (sig.actorId) return sig.actorId;
  if (sig.crewId && state.crew?.[sig.crewId]) return state.crew[sig.crewId].actorId;
  if (sig.missionId && state.missions?.some?.((m) => m.id === sig.missionId)) return state.playerId;
  if (sig.type === 'treaty/signed') {
    const t = state.treaties?.find?.((x) => x.id === sig.treatyId);
    if (t?.parties?.includes(state.playerId)) return state.playerId;
    return t?.parties?.[0] || null;
  }
  if (sig.type === 'tension/changed') return sig.a === state.playerId || sig.b === state.playerId ? state.playerId : sig.a;
  return sig.winner || sig.by || null;
}

function signalMatches(state, sig, where) {
  if (!where) return true;
  const actor = signalActor(state, sig);
  for (const [k, v] of Object.entries(where)) {
    if (k === 'actor') {
      if (v === 'player' && actor !== state.playerId) return false;
      if (v === 'rival' && (!actor || actor === state.playerId)) return false;
      if (v !== 'player' && v !== 'rival' && actor !== v) return false;
    } else if (Array.isArray(v) ? !v.includes(sig[k]) : sig[k] !== v) return false;
  }
  return true;
}

function signalContext(state, sig) {
  const actor = signalActor(state, sig);
  const base = {};
  if (sig.missionId && state.missions?.some?.((m) => m.id === sig.missionId)) base.mission = sig.missionId;
  if (sig.crewId) base.person = sig.crewId;
  if (actor && actor !== state.playerId) base.rival = actor;
  if (sig.type === 'tension/changed') base.rival = sig.a === state.playerId ? sig.b : sig.a;
  if (sig.milestoneId) base.milestone = sig.milestoneId;
  return base;
}

function processSignals(state, data, ctx) {
  const ev = state.events;
  const sigs = state.signals || [];
  const pid = state.playerId;
  for (const sig of sigs) {
    const own = signalActor(state, sig) === pid;
    if (sig.type === 'mission/resolved' && own) {
      if (FAIL_OUTCOMES.includes(sig.outcome)) ev.failStreak += 1;
      else if (sig.outcome) {
        albumFromMission(state, data, sig); // before reset so 'comeback' sees the streak
        ev.failStreak = 0;
        continue;
      }
      albumFromMission(state, data, sig);
    } else if (sig.type === 'first' && sig.actorId === pid) {
      cardFromTemplate(state, data, `first:${sig.milestoneId}`, 'first', { milestone: sig.milestoneId, mission: sig.missionId });
    } else if (sig.type === 'crew/died' && own) {
      cardFromTemplate(state, data, `died:${sig.crewId}`, 'memorial', { person: sig.crewId, mission: sig.missionId }, { crewIds: [sig.crewId] });
    } else if (sig.type === 'crew/legend' && own) {
      cardFromTemplate(state, data, `legend:${sig.crewId}`, 'legend', { person: sig.crewId }, { crewIds: [sig.crewId] });
    } else if (sig.type === 'treaty/signed' && own) {
      const t = state.treaties?.find?.((x) => x.id === sig.treatyId);
      // one card per treaty type (the first time the agency signs it), not for every renewal
      const card = t ? cardFromTemplate(state, data, `treaty:${t.type || sig.treatyId}`, 'treaty', {}) : null;
      if (card && t?.name) card.headline = t.name;
    }
  }
  // signal-triggered narrative events (at most one per week)
  const cands = [];
  for (const event of eventList(data)) {
    const t = event.trigger;
    if (!t?.signal || event.kind === 'operation') continue;
    for (const sig of sigs) if (sig.type === t.signal && signalMatches(state, sig, t.signalWhere)) cands.push({ event, sig });
  }
  if (!cands.length) return;
  // most certain reactions first (a crew death outranks a rival's press release); stable sort keeps data order
  cands.sort((x, y) => (y.event.trigger.chance ?? 0.5) - (x.event.trigger.chance ?? 0.5));
  const rng = ctx.rng('signal-events');
  for (const { event, sig } of cands) {
    if (pendingEvents(state).length >= PENDING_CAP + 1) break;
    if (!rng.chance(event.trigger.chance ?? 0.5)) continue;
    const context = eligibleContext(state, data, event, { mode: 'signal', base: signalContext(state, sig), rng: ctx.rng(`sigctx:${event.id}`) });
    if (!context) continue;
    pushEventDecision(state, data, event, context, 'signal');
    break;
  }
}

function fireScheduled(state, data, ctx) {
  const ev = state.events;
  if (!ev.scheduled.length) return;
  const keep = [];
  for (const s of ev.scheduled) {
    if (s.turn > state.turn) { keep.push(s); continue; }
    const event = getEvent(data, s.eventId);
    if (!event) { log(state, `narrative: evento agendado desconhecido ${s.eventId}`); continue; }
    const context = pendingEvents(state).length < PENDING_CAP + 2
      ? eligibleContext(state, data, event, { mode: 'scheduled', base: s.context || {}, rng: ctx.rng(`sched:${s.eventId}`) })
      : null;
    if (!context) {
      const tries = (s.tries || 0) + 1;
      if (tries <= 6) keep.push({ ...s, turn: state.turn + 1, tries });
      else log(state, `narrative: cadeia ${s.eventId} descartada (condições não satisfeitas)`);
      continue;
    }
    pushEventDecision(state, data, event, context, 'chain');
  }
  ev.scheduled = keep;
}

function maybeRandomEvent(state, data, ctx) {
  const ev = state.events;
  if (state.turn < 2 || pendingEvents(state).length >= PENDING_CAP) return;
  const since = ev.lastRandomTurn == null ? 6 : state.turn - ev.lastRandomTurn;
  if (since < 2) return;
  let p = clamp(0.16 + 0.05 * (since - 3), 0.1, 0.65);
  if (ev.failStreak >= 3) p += 0.2; // recovery events should show up soon
  const rng = ctx.rng('random-event');
  if (!rng.chance(p)) return;
  const cands = [];
  for (const event of eventList(data)) {
    const context = eligibleContext(state, data, event, { mode: 'random', rng: ctx.rng(`ctx:${event.id}`) });
    if (!context) continue;
    const weight = eventWeight(state, event);
    if (weight > 0) cands.push({ event, context, weight });
  }
  const pick = rng.weighted(cands);
  if (!pick) return;
  pushEventDecision(state, data, pick.event, pick.context, 'random');
  ev.lastRandomTurn = state.turn;
}

// ---------------------------------------------------------------- cross-module API

/**
 * Operation event for a player mission in transit (called by missions, ideally once per transit week).
 * The caller gates the weekly chance; here: eligibility, weights, one pending card and max 2 per mission. Pushes the decision and returns {eventId, decisionId} or null.
 */
export function pickOperationEvent(state, data, mission, rng) {
  if (!mission?.id) return null;
  const ev = ensure(state);
  const r = rng || rngFor(state.seed, 'narrative-op', mission.id, state.turn);
  if ((ev.missionEvents[mission.id] || 0) >= OP_MAX_PER_MISSION) return null;
  if (pendingEvents(state).some((d) => d.payload?.context?.mission === mission.id)) return null;
  if (OP_CHANCE < 1 && !r.chance(OP_CHANCE)) return null;
  const crewed = !!(mission.type === 'crewed' || mission.crew?.astronauts?.length || mission.crew?.commander);
  const cands = [];
  for (const event of eventList(data)) {
    if (event.kind !== 'operation') continue;
    const t = event.trigger || {};
    if (t.destinations?.length && !t.destinations.includes(mission.destination)) continue;
    if (t.crewed != null && t.crewed !== crewed) continue;
    const context = eligibleContext(state, data, event, { mode: 'operation', base: { mission: mission.id }, rng: rngFor(state.seed, 'narrative-opctx', mission.id, state.turn, event.id) });
    if (!context) continue;
    cands.push({ event, context, weight: eventWeight(state, event) });
  }
  const pick = r.weighted(cands);
  if (!pick) return null;
  const d = pushEventDecision(state, data, pick.event, pick.context, 'operation');
  ev.missionEvents[mission.id] = (ev.missionEvents[mission.id] || 0) + 1;
  return { eventId: pick.event.id, decisionId: d.id };
}

/** Accumulated {missionRisk} from events for a mission (+ = riskier: subtract from success p). */
export function missionRiskDelta(state, missionId) {
  return state.events?.missionRisk?.[missionId] || 0;
}

// ---------------------------------------------------------------- validation (tests / tools)

function validateCondition(cond, where, errors) {
  if (cond == null) return;
  if (Array.isArray(cond)) { cond.forEach((c, i) => validateCondition(c, `${where}[${i}]`, errors)); return; }
  if (typeof cond !== 'object') { errors.push(`${where}: condição inválida`); return; }
  for (const [k, v] of Object.entries(cond)) {
    if (!COND_KEYS.includes(k)) errors.push(`${where}: chave de condição desconhecida "${k}"`);
    else if (COND_COMPARE_KEYS.includes(k) && !validCompare(v)) errors.push(`${where}.${k}: comparação inválida "${v}"`);
    else if ((k === 'all' || k === 'any') && !Array.isArray(v)) errors.push(`${where}.${k}: precisa ser lista`);
    else if (k === 'all' || k === 'any') v.forEach((c, i) => validateCondition(c, `${where}.${k}[${i}]`, errors));
    else if (k === 'not') validateCondition(v, `${where}.not`, errors);
    else if (k === 'hasRole' && !ROLES.includes(v)) errors.push(`${where}.hasRole: papel desconhecido "${v}"`);
    else if (k === 'value' && !('flag' in cond)) errors.push(`${where}: "value" sem "flag"`);
  }
}

function validateEffect(e, where, data, errors, eventIds) {
  if (!e || typeof e !== 'object') { errors.push(`${where}: efeito inválido`); return; }
  const kind = Object.keys(EFFECT_SHAPES).find((k) => k in e);
  if (!kind) { errors.push(`${where}: efeito sem tipo conhecido (${Object.keys(e).join(',')})`); return; }
  const shape = EFFECT_SHAPES[kind];
  for (const k of shape.required) if (!(k in e)) errors.push(`${where}: falta "${k}"`);
  for (const k of Object.keys(e)) if (!shape.required.includes(k) && !shape.optional.includes(k)) errors.push(`${where}: chave desconhecida "${k}"`);
  const num = (k) => { if (typeof e[k] !== 'number' || !Number.isFinite(e[k])) errors.push(`${where}.${k}: precisa ser número`); };
  switch (kind) {
    case 'actor': if (!ACTOR_FIELDS.includes(e.field)) errors.push(`${where}: campo de ator "${e.field}"`); num('delta'); break;
    case 'relation': if (!RELATION_FIELDS.includes(e.field)) errors.push(`${where}: campo de relação "${e.field}"`); num('delta'); break;
    case 'crew':
      if (!['random', 'subject'].includes(e.crew)) errors.push(`${where}: crew "${e.crew}"`);
      if (!CREW_FIELDS.includes(e.field)) errors.push(`${where}: campo de equipe "${e.field}"`);
      num('delta'); break;
    case 'crewStatus': if (!CREW_STATUS.includes(e.crewStatus)) errors.push(`${where}: crewStatus "${e.crewStatus}"`); break;
    case 'schedule':
      num('inWeeks');
      if (eventIds && !eventIds.has(e.schedule)) errors.push(`${where}: agenda evento inexistente "${e.schedule}"`);
      break;
    case 'science': case 'cash': case 'missionRisk': num(kind); break;
    case 'tension': num('delta'); break;
    case 'news': if (typeof e.news !== 'string' || !e.news) errors.push(`${where}: manchete vazia`); if ('importance' in e && ![1, 2, 3].includes(e.importance)) errors.push(`${where}: importance 1..3`); break;
    case 'album': if ('rarity' in e && !RARITIES.includes(e.rarity)) errors.push(`${where}: raridade "${e.rarity}"`); break;
    case 'flag': if (typeof e.flag !== 'string') errors.push(`${where}: flag precisa ser texto`); break;
    case 'unlockTech': {
      const tech = data?.index?.tech;
      if (tech && Object.keys(tech).length && !tech[e.unlockTech]) errors.push(`${where}: tecnologia inexistente "${e.unlockTech}"`);
      break;
    }
    default: break;
  }
  const actorRef = e.actor ?? e.relation ?? e.tension;
  if (actorRef != null && actorRef !== 'player' && actorRef !== 'rival') {
    const actors = data?.index?.actors;
    if (actors && Object.keys(actors).length && !actors[actorRef]) errors.push(`${where}: ator desconhecido "${actorRef}"`);
  }
}

function checkPlaceholders(text, where, errors, extra = []) {
  for (const m of String(text || '').matchAll(/\{(\w+)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1]) && !extra.includes(m[1])) errors.push(`${where}: marcador desconhecido {${m[1]}}`);
  }
}

/** Validate one event definition against the DSL. Returns a list of error strings (empty = valid). */
export function validateEvent(event, data, eventIds) {
  const errors = [];
  const w = `evento ${event?.id}`;
  if (!event || typeof event !== 'object') return ['evento inválido'];
  for (const k of Object.keys(event)) if (!EVENT_KEYS.includes(k)) errors.push(`${w}: chave desconhecida "${k}"`);
  if (!/^[a-z0-9_]+$/.test(event.id || '')) errors.push(`${w}: id inválido`);
  if (!['narrative', 'operation'].includes(event.kind)) errors.push(`${w}: kind "${event.kind}"`);
  if (!event.title) errors.push(`${w}: sem título`);
  if (!event.text || event.text.length < 120) errors.push(`${w}: texto curto demais`);
  if (event.text && event.text.length > 700) errors.push(`${w}: texto longo demais`);
  checkPlaceholders(event.title, `${w}.title`, errors);
  checkPlaceholders(event.text, `${w}.text`, errors);
  if (event.portrait != null && !['crew', 'actor'].includes(event.portrait)) errors.push(`${w}: portrait "${event.portrait}"`);
  if (typeof event.weight !== 'number' || event.weight < 0) errors.push(`${w}: weight`);
  if (typeof event.cooldownWeeks !== 'number' || event.cooldownWeeks < 0) errors.push(`${w}: cooldownWeeks`);
  if ('once' in event && typeof event.once !== 'boolean') errors.push(`${w}: once precisa ser booleano`);
  if (event.subject != null) {
    const s = Array.isArray(event.subject) ? event.subject : [event.subject];
    for (const r of s) if (r !== 'any' && !ROLES.includes(r)) errors.push(`${w}: subject "${r}"`);
  }
  if (event.rival != null && !Array.isArray(event.rival)) errors.push(`${w}: rival precisa ser lista`);
  if (event.tags != null && !Array.isArray(event.tags)) errors.push(`${w}: tags precisa ser lista`);
  if (event.urgency != null && ![1, 2, 3].includes(event.urgency)) errors.push(`${w}: urgency 1..3`);
  const t = event.trigger || {};
  if (event.trigger != null && typeof event.trigger !== 'object') errors.push(`${w}: trigger`);
  for (const k of Object.keys(t)) if (!TRIGGER_KEYS.includes(k)) errors.push(`${w}.trigger: chave desconhecida "${k}"`);
  for (const k of ['actors', 'requiresFlags', 'forbidsFlags', 'destinations']) if (k in t && !Array.isArray(t[k])) errors.push(`${w}.trigger.${k}: precisa ser lista`);
  if ('chance' in t && !(t.chance > 0 && t.chance <= 1)) errors.push(`${w}.trigger.chance: 0..1`);
  if (t.signalWhere && !t.signal) errors.push(`${w}.trigger: signalWhere sem signal`);
  validateCondition(t.condition, `${w}.trigger.condition`, errors);
  if (event.chain != null && (typeof event.chain.id !== 'string' || typeof event.chain.step !== 'number'
      || Object.keys(event.chain).some((k) => !['id', 'step'].includes(k)))) errors.push(`${w}: chain {id, step}`);
  const choices = event.choices;
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 4) errors.push(`${w}: precisa de 2 a 4 escolhas`);
  const ids = new Set();
  for (const [i, c] of (choices || []).entries()) {
    const cw = `${w}.choices[${c?.id ?? i}]`;
    for (const k of Object.keys(c || {})) if (!CHOICE_KEYS.includes(k)) errors.push(`${cw}: chave desconhecida "${k}"`);
    if (!c?.id || ids.has(c.id)) errors.push(`${cw}: id ausente ou repetido`);
    ids.add(c?.id);
    if (!c?.label) errors.push(`${cw}: sem label`);
    if (!c?.preview) errors.push(`${cw}: sem preview`);
    checkPlaceholders(c?.label, `${cw}.label`, errors);
    checkPlaceholders(c?.preview, `${cw}.preview`, errors);
    validateCondition(c?.requires, `${cw}.requires`, errors);
    if (!Array.isArray(c?.effects) || !c.effects.length) errors.push(`${cw}: sem efeitos (todo evento muda o estado)`);
    (c?.effects || []).forEach((e, j) => {
      validateEffect(e, `${cw}.effects[${j}]`, data, errors, eventIds);
      if (e && 'news' in e) checkPlaceholders(e.news, `${cw}.effects[${j}].news`, errors);
      if (e && 'album' in e) checkPlaceholders(e.album, `${cw}.effects[${j}].album`, errors);
    });
    // "every event changes world state": at least one effect beyond news/flags
    if ((c?.effects || []).every((e) => e && ('news' in e || 'flag' in e || 'schedule' in e))) errors.push(`${cw}: só efeitos invisíveis`);
  }
  if ((choices || []).length && !(choices || []).some((c) => !c.requires)) errors.push(`${w}: precisa de uma escolha sem requisito`);
  if (event.defaultChoice && !ids.has(event.defaultChoice)) errors.push(`${w}: defaultChoice inexistente`);
  return errors;
}

/** Validate every event in data/events.json, plus chain reachability and album templates. */
export function validateEvents(data) {
  const list = eventList(data);
  const ids = new Set(list.map((e) => e.id));
  const errors = [];
  if (ids.size !== list.length) errors.push('ids de evento repetidos');
  const scheduled = new Set();
  for (const e of list) {
    errors.push(...validateEvent(e, data, ids));
    for (const c of e.choices || []) for (const fx of c.effects || []) if (fx && 'schedule' in fx) scheduled.add(fx.schedule);
  }
  for (const e of list) if (isFollowUp(e) && !scheduled.has(e.id)) errors.push(`evento ${e.id}: passo de cadeia nunca agendado`);
  for (const [k, tpl] of Object.entries(data?.events?.album || {})) {
    if (!tpl.title || !RARITIES.includes(tpl.rarity)) errors.push(`álbum ${k}: título/raridade`);
    checkPlaceholders(tpl.title, `álbum ${k}`, errors, ['milestone', 'pos']);
    checkPlaceholders(tpl.headline, `álbum ${k}`, errors, ['milestone', 'pos']);
  }
  return errors;
}

// ---------------------------------------------------------------- module interface

export function init(state, data, ctx) {
  ensure(state);
}

export function tick(state, data, ctx) {
  ensure(state);
  processSignals(state, data, ctx);
  fireScheduled(state, data, ctx);
  maybeRandomEvent(state, data, ctx);
  // forget per-mission bookkeeping for missions that no longer exist
  const live = new Set((state.missions || []).map((m) => m.id));
  for (const id of Object.keys(state.events.missionEvents)) if (!live.has(id)) delete state.events.missionEvents[id];
}

export function onGameEnd(state, data, ctx) {
  ensure(state);
  const ranking = Object.values(state.actors || {}).sort((a, b) => (b.prestige || 0) - (a.prestige || 0));
  const pos = ranking.findIndex((a) => a.id === state.playerId) + 1;
  if (pos <= 0) return;
  const tpl = data?.events?.album?.eraEnd;
  if (!tpl) return;
  const rarity = pos === 1 ? 'legendary' : pos <= 3 ? 'epic' : 'rare';
  addAlbumCard(state, data, 'era_end', {
    title: renderText(state, data, tpl.title, {}).replace('{pos}', String(pos)),
    headline: renderText(state, data, tpl.headline, {}).replace('{pos}', String(pos)),
    kind: 'era', rarity,
  });
}

export const actions = {};

export const decisionHandlers = {
  'event/*': (state, data, decision, choiceId) => resolveEvent(state, data, decision, choiceId),
};

export const queries = {
  /** Album cards, newest first, with pt-BR rarity label. */
  'narrative/album': (state) => (state.album || []).slice().reverse().map((c) => ({ ...c, rarityLabel: RARITY_LABELS[c.rarity] || c.rarity })),
  'narrative/flags': (state) => ({ ...(state.events?.flags || {}) }),
  /** Resolved events, newest first: [{turn, eventId, title, choice, chain}]. */
  'narrative/journal': (state) => (state.events?.journal || []).slice(),
  'narrative/missionRisk': (state, data, missionId) => missionRiskDelta(state, missionId),
  'narrative/chains': (state) => ({ ...(state.events?.chains || {}) }),
};

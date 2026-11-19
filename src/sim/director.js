// The player inside the world: being fired never ends a campaign (request "demitido", nov/2026).
// When the government (weeks in the red, budget.js) or the shareholders (investors.js) remove the director,
// helpers.removeDirector marks state.director.ousted; the engine freezes the clock ('ousted') and the player either
// takes another live agency ('director/take') or founds a new one at today's date ('director/found'). The agency left
// behind stays in the world as an ordinary AI actor: every module hands its player-only records over in its
// onDirectorChange hook (engine.runHook, MODULES order), the save slot and the world are never reset.
// Only the jan/3000 ending (or a short scenario's end date) ends a campaign.
//
// Slice (owner: this module): state.director = { since: turn the current tenure began, ousted: null | {reason,
//   turn, summary, actorId, frozen?, reopened?}, tenures: [{actorId, name, short, flag, country, emblem, fromTurn,
//   toTurn, reason, summary, missions, ok, firsts, crewLost, prestige, highlights: [name]}] (cap 40) }.
// Old saves that ended with gameOver 'fired' / 'board' before the campaign's end are reopened on load (reopen()).
// Deterministic, plain JSON, no DOM.

import { addNews, emitSignal, log, changeActor } from '../core/helpers.js';
import { turnToDate, dateToTurn } from '../core/time.js';
import * as lifecycle from './lifecycle.js';

const TENURE_CAP = 40;
/** Cards that survive the director's exit (the world's, not the director's). */
const KEEP_KINDS = new Set(['era/transition', 'ending/final']);
const OK = ['total', 'partial'];
const OUST_REASONS = ['fired', 'board'];

export const REASON_LABELS = {
  fired: 'Demitido depois de semanas no vermelho',
  board: 'Destituído pelo conselho de acionistas',
  ending: 'Até o fim da campanha',
  end: 'Até o fim do cenário',
};

/** Turn the scenario starts on (turn 0 is 1 January of startYear; a mid-year start begins at its month). */
function startTurnOf(state, data) {
  const m = data?.scenario?.start?.month ?? 0;
  return m ? dateToTurn(state.startYear, m, state.startYear) : 0;
}

/** The slice (created on first use: saves from before v0.9.13 have none). */
export function ensure(state, data) {
  let d = state.director;
  if (!d || typeof d !== 'object' || Array.isArray(d)) d = state.director = { since: null, tenures: [], ousted: null };
  if (!Array.isArray(d.tenures)) d.tenures = [];
  if (d.ousted === undefined) d.ousted = null;
  if (!Number.isFinite(d.since)) d.since = startTurnOf(state, data);
  return d;
}

export function init(state) {
  state.director = { since: state.turn ?? 0, tenures: [], ousted: null };
}

export const isOusted = (state) => !!state?.director?.ousted;

// ---------------------------------------------------------------------------------------------------------------
// The exit
// ---------------------------------------------------------------------------------------------------------------

/**
 * End of the step in which the director was removed (engine.tick): the director's cards and a launch day in progress
 * end with the tenure; the era and ending cards stay (the next director gets them).
 */
export function freeze(state, data) {
  const o = state.director?.ousted;
  if (!o || o.frozen) return;
  ensure(state, data);
  o.frozen = true;
  state.decisions = (state.decisions || []).filter((d) => KEEP_KINDS.has(d.kind));
  if (state.activeLaunch) state.activeLaunch = null;
  log(state, `director: ${state.playerId} sem diretor (${o.reason})`);
}

/** Old save that ended with the director fired before the campaign's end: back to the choice (engine.deserialize). */
export function reopen(state, data) {
  const go = state?.gameOver;
  if (!go || !OUST_REASONS.includes(go.reason)) return false;
  const finalTurn = state.clock?.finalTurn;
  const before = Number.isFinite(finalTurn) ? state.turn < finalTurn : !Number.isFinite(state.endTurn) || state.turn <= state.endTurn;
  if (!before || !state.actors?.[state.playerId]) return false;
  const d = ensure(state, data);
  state.gameOver = null;
  if (state.eco && typeof state.eco === 'object') delete state.eco.epilogue; // the world's ending was written early
  d.ousted = {
    reason: go.reason, turn: Number.isFinite(go.turn) ? go.turn : state.turn,
    summary: typeof go.summary === 'string' ? go.summary : '', actorId: state.playerId, frozen: true, reopened: true,
  };
  state.decisions = (state.decisions || []).filter((x) => KEEP_KINDS.has(x.kind));
  state.activeLaunch = null;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Tenures
// ---------------------------------------------------------------------------------------------------------------

/** Record of the current tenure (pure read): the agency, the dates and what the director did with it. */
export function currentTenure(state, data, { toTurn = null, reason = null, summary = '' } = {}) {
  const d = state.director && typeof state.director === 'object' ? state.director : {};
  const from = Number.isFinite(d.since) ? d.since : startTurnOf(state, data);
  const pid = state.playerId;
  const a = state.actors?.[pid] || state.lifecycle?.tombstones?.[pid] || {};
  const ms = (state.missions || []).filter((m) => m && m.result && m.result.outcome != null);
  const stubs = state.missionsArchive?.stubs || [];
  const folded = Object.values(state.missionsArchive?.byDest || {});
  const missions = ms.length + stubs.length + folded.reduce((s, b) => s + (b.flown || 0), 0);
  const ok = ms.filter((m) => OK.includes(m.result.outcome)).length + stubs.filter((s) => OK.includes(s.o)).length
    + folded.reduce((s, b) => s + (b.ok || 0), 0);
  const seen = new Set();
  for (const [id, f] of Object.entries(state.firsts || {})) if (f?.actorId === pid && (f.turn ?? 0) >= from && !id.includes(':')) seen.add(`${id}@${f.turn}`);
  for (const e of state.eraHistory || []) for (const f of e.firsts || []) if (f?.actorId === pid && (f.turn ?? 0) >= from && !String(f.milestone).includes(':')) seen.add(`${f.milestone}@${f.turn}`);
  const crewLost = (state.memorial || []).filter((m) => (m?.turn ?? 0) >= from).length;
  const highlights = ms.filter((m) => OK.includes(m.result.outcome))
    .sort((x, y) => (y.result.prestige || 0) - (x.result.prestige || 0) || (x.result.resolvedTurn ?? 0) - (y.result.resolvedTurn ?? 0))
    .slice(0, 3).map((m) => String(m.name || '').slice(0, 48)).filter(Boolean);
  return {
    actorId: pid, name: a.name || pid, short: a.short || a.name || pid, flag: a.flag || '', country: a.country || '',
    emblem: a.emblem ?? null, fromTurn: from, toTurn, reason, summary: summary || '',
    missions, ok, firsts: seen.size, crewLost, prestige: Math.round(a.prestige || 0), highlights,
  };
}

/** Every tenure, oldest first: the closed ones and the current one (toTurn null while it lasts). */
export function tenures(state, data) {
  const d = state.director && typeof state.director === 'object' ? state.director : {};
  const list = (Array.isArray(d.tenures) ? d.tenures : []).map((t) => ({ ...t, current: false }));
  if (d.closed) return list; // the game ended while the choice was pending: the last tenure is already closed
  const o = d.ousted;
  const cur = currentTenure(state, data, o ? { toTurn: o.turn, reason: o.reason, summary: o.summary } : {});
  return [...list, { ...cur, current: !o, pending: !!o }];
}

// ---------------------------------------------------------------------------------------------------------------
// The choice: another agency or a new one
// ---------------------------------------------------------------------------------------------------------------

/** The scenario seen from today (start = the current date): the founding wizard and its rules at this date. */
export function scenarioNow(state, data) {
  const { year, month } = turnToDate(state.turn, state.startYear);
  return { ...(data?.scenario || {}), start: { year, month: month ?? 0 }, startYear: year };
}

/** Founding is offered mid-game where the scenario offers it at the start (playable.found, as on the title screen). */
export function canFound(state, data) {
  const sc = data?.scenario || {};
  if (sc.playable?.found !== true) return false;
  try { return !!lifecycle.foundingOptions(data, scenarioNow(state, data)).offered; } catch { return false; }
}

function noteOf(a) {
  if ((a.cash || 0) < 0) return 'Caixa no vermelho';
  if ((a.support ?? 50) < 30) return 'Apoio baixo';
  if ((a.support ?? 50) >= 70) return 'Apoio alto';
  return 'Estável';
}

/**
 * Agencies the player may direct now: live actors except the one that just removed the director; a scenario with a
 * fixed list (Corrida Lunar, rule 'list') keeps to its playable actors. Core first, then by prestige.
 */
export function candidates(state, data) {
  const ousted = state.director?.ousted?.actorId ?? null;
  const sc = data?.scenario || {};
  const rule = sc.lifecycle === 'on' ? (sc.playable?.rule || 'alive') : 'list';
  const listed = sc.playable?.actors || sc.playableActors || [];
  const all = Object.values(state.actors || {}).filter((a) => a && a.id);
  const ranked = all.slice().sort((x, y) => (y.prestige || 0) - (x.prestige || 0) || (x.id < y.id ? -1 : 1)).map((a) => a.id);
  return all.filter((a) => a.id === ousted || (rule !== 'list' || listed.includes(a.id))).map((a) => ({
    id: a.id, name: a.name || a.id, short: a.short || a.id, flag: a.flag || '', country: a.country || '', kind: a.kind || 'agency',
    tier: a.tier || 'core', emblem: a.emblem ?? null, color: a.color ?? null, generated: !!a.generated, custom: !!a.custom,
    budget: Math.round(a.budget || 0), cash: Math.round(a.cash || 0), prestige: Math.round(a.prestige || 0),
    support: Math.round(a.support ?? 0), reputation: Math.round(a.reputation ?? 0), crewed: !!a.capabilities?.crewed,
    rank: ranked.indexOf(a.id) + 1, of: ranked.length, note: noteOf(a),
    before: (state.director?.tenures || []).some((t) => t.actorId === a.id),
    self: a.id === ousted, // the agency that just removed the director: "Voltar à direção" (a second chance)
  })).sort((x, y) => (x.self === y.self ? 0 : x.self ? -1 : 1) || (x.tier === y.tier ? 0 : x.tier === 'core' ? -1 : 1) || y.prestige - x.prestige || (x.id < y.id ? -1 : 1));
}

/** What the "Você foi afastado" screen shows (null while the player still directs an agency). */
export function status(state, data) {
  const o = state.director?.ousted;
  if (!o) return null;
  const a = state.actors?.[o.actorId] || {};
  const t = currentTenure(state, data, { toTurn: o.turn, reason: o.reason, summary: o.summary });
  return {
    reason: o.reason, reasonLabel: REASON_LABELS[o.reason] || 'Afastado da direção', summary: o.summary || '',
    turn: o.turn, actorId: o.actorId, name: a.name || t.name, short: a.short || t.short, kind: a.kind || 'agency',
    tenure: t, past: (state.director?.tenures || []).slice(), candidates: candidates(state, data), canFound: canFound(state, data),
  };
}

/** Hand the agency to the AI and give the player `to` (every module's onDirectorChange runs in MODULES order). */
function handOver(state, data, ctx, to, { mode, grant = null } = {}) {
  const d = ensure(state, data);
  const o = d.ousted;
  const from = state.playerId;
  const old = state.actors?.[from] || {};
  d.tenures.push(currentTenure(state, data, { toTurn: o?.turn ?? state.turn, reason: o?.reason ?? null, summary: o?.summary ?? '' }));
  if (d.tenures.length > TENURE_CAP) d.tenures.splice(0, d.tenures.length - TENURE_CAP);
  state.decisions = (state.decisions || []).filter((x) => KEEP_KINDS.has(x.kind));
  state.activeLaunch = null;
  state.playerId = to;
  const info = { from, to, mode, grant };
  if (typeof ctx?.hooks?.directorChanged === 'function') ctx.hooks.directorChanged(info);
  d.since = state.turn;
  d.ousted = null;
  const a = state.actors?.[to] || {};
  addNews(state, {
    headline: mode === 'found'
      ? `Ex-diretor${old.short ? ` da ${old.short}` : ''} funda ${a.name || to}`
      : `Nova direção na ${a.short || a.name || to}: chega o ex-diretor${old.short ? ` da ${old.short}` : ''}`,
    body: `${old.name || 'A antiga agência'} segue com uma nova direção.`,
    tags: ['director'], actors: [to, from].filter((x) => state.actors?.[x]), importance: 3, icon: 'agency',
  });
  emitSignal(state, 'director/changed', { from, to, mode });
  return { ok: true, actorId: to, from };
}

/**
 * Back to the agency that just removed the director: a second chance, not a hand-over. The world, the missions, the
 * crew, the designs and the research stay as they are; the government/board give breathing room (debt covered,
 * support at least 30, the weeks-in-the-red count and the board's bad rounds restart) so the director is not removed
 * again the next week.
 */
function retake(state, data, ctx) {
  const d = ensure(state, data);
  const o = d.ousted;
  const pid = state.playerId;
  d.tenures.push(currentTenure(state, data, { toTurn: o?.turn ?? state.turn, reason: o?.reason ?? null, summary: o?.summary ?? '' }));
  if (d.tenures.length > TENURE_CAP) d.tenures.splice(0, d.tenures.length - TENURE_CAP);
  const a = state.actors?.[pid] || {};
  if ((a.cash || 0) < 0) changeActor(state, pid, 'cash', -(a.cash || 0));
  if ((a.support ?? 0) < 30) changeActor(state, pid, 'support', 30 - (a.support ?? 0));
  if (state.finance) state.finance.debtWeeks = 0;
  if (state.cap) {
    state.cap.lowRounds = 0;
    state.cap.warned = false;
    for (const h of state.cap.holders || []) if ((h.mood ?? 50) < 45) h.mood = 45;
  }
  d.since = state.turn;
  d.ousted = null;
  addNews(state, {
    headline: `O diretor afastado volta ao comando da ${a.short || a.name || pid}`,
    body: o?.reason === 'board' ? 'Os acionistas aceitam uma segunda chance, com metas mais curtas.' : 'O governo cobre as dívidas e dá uma segunda chance à antiga direção.',
    tags: ['director'], actors: [pid], importance: 3, icon: 'agency',
  });
  emitSignal(state, 'director/changed', { from: pid, to: pid, mode: 'retake' });
  return { ok: true, actorId: pid, from: pid, retake: true };
}

function take(state, data, action, ctx) {
  if (!isOusted(state)) return { ok: false, error: 'Você ainda dirige a sua agência.' };
  const id = action?.actorId;
  if (id && id === state.director?.ousted?.actorId && id === state.playerId) return retake(state, data, ctx);
  if (!candidates(state, data).some((c) => c.id === id)) return { ok: false, error: 'Esta agência não pode ser assumida agora.' };
  return handOver(state, data, ctx, id, { mode: 'take' });
}

function found(state, data, action, ctx) {
  if (!isOusted(state)) return { ok: false, error: 'Você ainda dirige a sua agência.' };
  if (!canFound(state, data)) return { ok: false, error: 'Este cenário não permite fundar uma agência.' };
  const res = lifecycle.foundNow(state, data, ctx, action || {}, scenarioNow(state, data));
  if (!res?.ok) return res || { ok: false, error: 'Não foi possível fundar a agência.' };
  return handOver(state, data, ctx, res.actorId, { mode: 'found', grant: res.grant ?? null });
}

/** Game end while the choice is pending (a short scenario's last week): the tenure closes with its reason. */
export function onGameEnd(state, data) {
  const d = state.director;
  if (!d || typeof d !== 'object' || !d.ousted) return;
  ensure(state, data);
  const o = d.ousted;
  d.tenures.push(currentTenure(state, data, { toTurn: o.turn, reason: o.reason, summary: o.summary }));
  if (d.tenures.length > TENURE_CAP) d.tenures.splice(0, d.tenures.length - TENURE_CAP);
  d.ousted = null;
  d.closed = true;
}

export const actions = {
  'director/take': take,
  'director/found': found,
};

export const decisionHandlers = {};

export const queries = {
  'director/status': (state, data) => status(state, data),
  'director/candidates': (state, data) => candidates(state, data),
  'director/tenures': (state, data) => tenures(state, data),
  'director/foundScenario': (state, data) => scenarioNow(state, data),
  'director/canFound': (state, data) => canFound(state, data),
};

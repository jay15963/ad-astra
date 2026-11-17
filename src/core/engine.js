// Game engine: owns the module registry, new-game creation, turn advance and action dispatch.
// UI never mutates state directly: it calls dispatch(state, data, action) and re-renders.
// Pure JS, no DOM. Deterministic given (data, seed, action sequence).

import { rngFor } from './rng.js';
import { removeDecision, log } from './helpers.js';
import { turnToDate } from './time.js';

import * as economyPolitics from '../sim/politics.js';
import * as diplomacy from '../sim/diplomacy.js';
import * as calendar from '../sim/calendar.js';
import * as budget from '../sim/budget.js';
import * as research from '../sim/research.js';
import * as crew from '../sim/crew.js';
import * as missions from '../sim/missions.js';
import * as launch from '../sim/launch.js';
import * as narrative from '../sim/narrative.js';

/**
 * Tick order matters: world first (economy/politics), then other actors (diplomacy, rival calendar),
 * then the player's agency (budget, research, crew, missions), then narrative events which react to all of it.
 * launch has no weekly tick logic of its own beyond housekeeping but is registered for actions.
 */
export const MODULES = [
  ['politics', economyPolitics],
  ['diplomacy', diplomacy],
  ['calendar', calendar],
  ['budget', budget],
  ['research', research],
  ['crew', crew],
  ['missions', missions],
  ['launch', launch],
  ['narrative', narrative],
];

export const SAVE_VERSION = 1;

/** Build the empty state skeleton. Each module's init() fills its own slices. */
export function createState(data, { seed, playerId }) {
  const sc = data.scenario;
  return {
    version: SAVE_VERSION,
    scenarioId: sc.id,
    seed: seed >>> 0,
    startYear: sc.startYear,
    endTurn: (sc.endYear - sc.startYear + 1) * 52 - 1,
    turn: 0,
    playerId,
    idCounter: 0,
    gameOver: null, // null | { reason, turn, summary }

    // ---- slices (owner module in brackets; see ARCHITECTURE.md) ----
    actors: {},      // [diplomacy] init; numeric fields changed via helpers.changeActor by anyone
    relations: {},   // [diplomacy] relKey -> { trust, dependence, rivalry }
    blocs: {},       // [diplomacy]
    treaties: [],    // [diplomacy]
    proposals: [],   // [diplomacy]
    world: {},       // [politics] economy, globalTension
    politics: {},    // [politics] per-actor government/elections
    tension: {},     // [politics] relKey -> 0..4
    calendar: [],    // [calendar] rival/real missions instances
    vehicleStats: {},// [calendar] vehicleId -> { flights, failures, lastFlightTurn, available }
    finance: {},     // [budget] player ledger
    research: {},    // [research]
    crew: {},        // [crew] crewId -> person
    missions: [],    // [missions] player missions
    activeLaunch: null, // [launch]
    commandPoints: 0,   // [launch] current Command points
    events: { history: {}, flags: {}, chains: {} }, // [narrative]
    memorial: [],    // [crew]/[narrative]
    album: [],       // [narrative]
    firsts: {},      // helpers.claimFirst
    decisions: [],   // helpers.pushDecision
    news: [],        // helpers.addNews
    log: [],         // helpers.log
    stats: {},       // free-form counters, any module, namespaced keys "module.key"
    signals: [],        // helpers.emitSignal — batch visible to all modules during the current tick
    signalsPending: [], // signals emitted since the last tick started (moved to `signals` at tick start)
  };
}

function makeCtx(state, data, moduleName) {
  return {
    data,
    /** rng that depends only on (seed, turn, module, label) */
    rng: (label = '') => rngFor(state.seed, state.turn, moduleName, label),
    date: turnToDate(state.turn, state.startYear),
  };
}

export function newGame(data, { seed, playerId }) {
  const state = createState(data, { seed, playerId });
  for (const [name, mod] of MODULES) {
    if (mod.init) mod.init(state, data, makeCtx(state, data, name));
  }
  return state;
}

/** One week. */
export function tick(state, data) {
  if (state.gameOver) return state;
  // expire decisions
  for (const d of state.decisions.slice()) {
    if (d.expiresTurn != null && state.turn >= d.expiresTurn) {
      resolveDecision(state, data, d.id, d.defaultChoice ?? d.choices?.[0]?.id, { expired: true });
    }
  }
  // signals emitted since last tick (by actions or by modules during last tick) become visible to every module now
  state.signals = state.signalsPending;
  state.signalsPending = [];
  for (const [name, mod] of MODULES) {
    if (mod.tick) mod.tick(state, data, makeCtx(state, data, name));
  }
  state.turn += 1;
  if (state.turn > state.endTurn && !state.gameOver) {
    state.gameOver = { reason: 'end', turn: state.turn, summary: null };
    for (const [name, mod] of MODULES) {
      if (mod.onGameEnd) mod.onGameEnd(state, data, makeCtx(state, data, name));
    }
  }
  return state;
}

/** True when time must not advance (blocking decision, active launch, or game over). */
export function isBlocked(state) {
  if (state.gameOver) return 'gameOver';
  if (state.activeLaunch) return 'launch';
  if (state.decisions.some((d) => d.blocking)) return 'decision';
  return null;
}

/**
 * Advance up to `weeks` weeks, stopping early when blocked or when something new needs attention
 * (a new decision or a new important news item) if stopOnEvent is true.
 * Returns { advanced, stoppedBy }.
 */
export function advance(state, data, weeks = 1, { stopOnEvent = false } = {}) {
  let advanced = 0;
  for (let i = 0; i < weeks; i++) {
    const b = isBlocked(state);
    if (b) return { advanced, stoppedBy: b };
    const decBefore = state.decisions.length;
    const newsBefore = state.news[0]?.id;
    tick(state, data);
    advanced++;
    if (stopOnEvent) {
      if (state.decisions.length > decBefore) return { advanced, stoppedBy: 'newDecision' };
      const top = state.news[0];
      if (top && top.id !== newsBefore && top.importance >= 3) return { advanced, stoppedBy: 'news' };
    }
  }
  return { advanced, stoppedBy: isBlocked(state) };
}

/** Collect action handlers from modules: { 'mission/create': fn(state, data, action, ctx) } */
function actionTable() {
  const t = {};
  for (const [name, mod] of MODULES) {
    for (const [type, fn] of Object.entries(mod.actions || {})) {
      if (t[type]) throw new Error(`Ação duplicada: ${type}`);
      t[type] = { fn, name };
    }
  }
  return t;
}
let ACTIONS = null;

function decisionHandler(kind) {
  for (const [name, mod] of MODULES) {
    const h = mod.decisionHandlers?.[kind];
    if (h) return { h, name };
  }
  // prefix match: 'event/*' handled by a module registering 'event/*'
  const prefix = kind.split('/')[0] + '/*';
  for (const [name, mod] of MODULES) {
    const h = mod.decisionHandlers?.[prefix];
    if (h) return { h, name };
  }
  return null;
}

export function resolveDecision(state, data, decisionId, choiceId, opts = {}) {
  const d = state.decisions.find((x) => x.id === decisionId);
  if (!d) return { ok: false, error: 'decisão não encontrada' };
  const choice = d.choices?.find((c) => c.id === choiceId);
  if (d.choices?.length && !choice) return { ok: false, error: 'escolha inválida' };
  if (choice?.disabled && !opts.expired) return { ok: false, error: choice.reason || 'indisponível' };
  removeDecision(state, decisionId);
  const found = decisionHandler(d.kind);
  if (!found) {
    log(state, `sem handler para decisão ${d.kind}`);
    return { ok: true };
  }
  const res = found.h(state, data, d, choiceId, { ...makeCtx(state, data, found.name), ...opts }) || {};
  return { ok: true, ...res };
}

/**
 * The single entry point for the UI.
 * Built-in actions: 'time/advance' {weeks, stopOnEvent}, 'decision/resolve' {id, choiceId}.
 * Everything else is routed to module `actions`.
 * Returns { ok, error?, ...handlerResult }.
 */
export function dispatch(state, data, action) {
  try {
    if (action.type === 'time/advance') {
      return { ok: true, ...advance(state, data, action.weeks ?? 1, { stopOnEvent: action.stopOnEvent ?? true }) };
    }
    if (action.type === 'decision/resolve') {
      return resolveDecision(state, data, action.id, action.choiceId);
    }
    ACTIONS = ACTIONS || actionTable();
    const entry = ACTIONS[action.type];
    if (!entry) return { ok: false, error: `ação desconhecida: ${action.type}` };
    const res = entry.fn(state, data, action, makeCtx(state, data, entry.name)) || {};
    return { ok: res.ok ?? true, ...res };
  } catch (e) {
    log(state, `erro em ${action.type}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Read-only queries the UI may call (pure functions over state). Modules export `queries`. */
export function query(state, data, name, ...args) {
  for (const [, mod] of MODULES) {
    const q = mod.queries?.[name];
    if (q) return q(state, data, ...args);
  }
  throw new Error(`consulta desconhecida: ${name}`);
}

export function serialize(state) {
  return JSON.stringify(state);
}
export function deserialize(json) {
  const s = JSON.parse(json);
  if (s.version !== SAVE_VERSION) throw new Error('save incompatível');
  return s;
}

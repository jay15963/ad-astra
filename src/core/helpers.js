// Shared state helpers. Every sim module uses these to talk to the rest of the game
// instead of reaching into slices it does not own (see ARCHITECTURE.md "Slice ownership").

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Stable key for an unordered actor pair: relKey('nasa','cnsa') === relKey('cnsa','nasa'). */
export function relKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Monotonic id generator stored in state (deterministic, serializable). */
export function nextId(state, prefix) {
  state.idCounter = (state.idCounter || 0) + 1;
  return `${prefix}_${state.idCounter}`;
}

const NEWS_CAP = 200;

/**
 * Add a news item to the world feed (Mundo tab + dashboard ticker).
 * item: { headline (pt-BR, short), body?, tags?: string[], actors?: string[], importance?: 1|2|3, icon? }
 */
export function addNews(state, item) {
  const n = {
    id: nextId(state, 'news'),
    turn: state.turn,
    headline: item.headline,
    body: item.body || '',
    tags: item.tags || [],
    actors: item.actors || [],
    importance: item.importance || 1,
    icon: item.icon || null,
  };
  state.news.unshift(n);
  if (state.news.length > NEWS_CAP) state.news.length = NEWS_CAP;
  return n;
}

/**
 * Push a decision card to the player's queue (dashboard "fila de decisões").
 * card: {
 *   kind: string                // routes resolution to the module that registered decisionHandlers[kind]
 *   title, body (pt-BR), portrait?: {crewId}|{actorId}|null,
 *   choices: [{ id, label, preview?: string (effect text shown before confirming), disabled?: bool, reason?: string }],
 *   urgency?: 1..3 (3 = most urgent), blocking?: bool (time cannot advance while pending),
 *   expiresTurn?: number, defaultChoice?: string (auto-picked on expiry), payload?: any (module-private data)
 * }
 */
export function pushDecision(state, card) {
  const d = {
    id: nextId(state, 'dec'),
    createdTurn: state.turn,
    urgency: 1,
    blocking: false,
    payload: null,
    portrait: null,
    ...card,
  };
  state.decisions.push(d);
  return d;
}

export function removeDecision(state, id) {
  const i = state.decisions.findIndex((d) => d.id === id);
  if (i >= 0) state.decisions.splice(i, 1);
}

/** Debug/dev log (not shown to players by default). */
export function log(state, msg) {
  state.log.push(`[${state.turn}] ${msg}`);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

/** Change a numeric field on an actor with clamping to the documented ranges. */
const ACTOR_RANGES = {
  support: [0, 100],
  reputation: [0, 100],
  culture: [-100, 100],
  prestige: [0, Infinity],
  cash: [-Infinity, Infinity],
  budget: [0, Infinity],
};
export function changeActor(state, actorId, field, delta) {
  const a = state.actors[actorId];
  if (!a) return;
  const [lo, hi] = ACTOR_RANGES[field] || [-Infinity, Infinity];
  a[field] = clamp((a[field] || 0) + delta, lo, hi);
}

export function player(state) {
  return state.actors[state.playerId];
}

/** Award a "Os Primeiros" milestone if nobody reached it yet. Returns true if this actor was first. */
export function claimFirst(state, milestoneId, actorId, prestigeFirst = 30, prestigeLater = 5) {
  if (!state.firsts[milestoneId]) {
    state.firsts[milestoneId] = { actorId, turn: state.turn };
    changeActor(state, actorId, 'prestige', prestigeFirst);
    return true;
  }
  changeActor(state, actorId, 'prestige', prestigeLater);
  return false;
}

/** Deep clone a JSON-serializable state. */
export const cloneState = (s) => JSON.parse(JSON.stringify(s));

/**
 * Cross-module notification (see ARCHITECTURE.md "Signals").
 * Emitted signals become visible in state.signals during the NEXT tick, to every module, then are discarded.
 * signal: { type: string, ...payload }
 */
export function emitSignal(state, type, payload = {}) {
  // type/turn go last so a payload field never masks the signal type
  state.signalsPending.push({ ...payload, type, turn: state.turn });
}

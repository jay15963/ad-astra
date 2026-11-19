// Game engine: owns the module registry, new-game creation, the clock (variable step per era), turn advance,
// era transitions, the end of the campaign and action dispatch.
// UI never mutates state directly: it calls dispatch(state, data, action) and re-renders.
// Pure JS, no DOM. Deterministic given (data, seed, action sequence). See EXPANSION.md §1 (time) and §2 (scenarios).

import { rngFor } from './rng.js';
import { removeDecision, log, pushDecision, addNews, compactAnnals, every } from './helpers.js';
import {
  turnToDate, dateToTurn, yearOf, eraAt, eraById, bandAt, gridNext, nextEraTurn, stepLabel, WEEKS_PER_YEAR,
} from './time.js';
import { migrate, targetVersion } from './migrate.js';
import { packState } from './savepack.js';

import * as economyPolitics from '../sim/politics.js';
import * as diplomacy from '../sim/diplomacy.js';
import * as calendar from '../sim/calendar.js';
import * as budget from '../sim/budget.js';
import * as research from '../sim/research.js';
import * as crew from '../sim/crew.js';
import * as missions from '../sim/missions.js';
import * as launch from '../sim/launch.js';
import * as narrative from '../sim/narrative.js';
import * as designs from '../sim/designs.js';
import * as investors from '../sim/investors.js';
import * as explore from '../sim/explore.js';
import * as eco from '../sim/eco.js';
import * as colonies from '../sim/colonies.js';
import * as infra from '../sim/infra.js';
import * as director from '../sim/director.js';

// The lifecycle module (A2) is optional while it is being built: a missing file leaves the registry as in v0.5.
// Any other failure (syntax error inside the module) is re-thrown so it is never hidden.
const lifecycle = await import('../sim/lifecycle.js').catch((e) => {
  const missing = e?.code === 'ERR_MODULE_NOT_FOUND' || /Failed to fetch|Importing a module script failed|error loading dynamically imported module/i.test(String(e?.message));
  if (!missing) throw e;
  return null;
});
// The rocket market (MISSIONS-V2 §8, src/sim/market.js) is optional the same way while it is being built.
const market = await import('../sim/market.js').catch((e) => {
  const missing = e?.code === 'ERR_MODULE_NOT_FOUND' || /Failed to fetch|Importing a module script failed|error loading dynamically imported module/i.test(String(e?.message));
  if (!missing) throw e;
  return null;
});

/**
 * Tick order matters: world first (economy/politics), the actor lifecycle right after it (births, renames,
 * merges), then other actors (diplomacy, rival calendar), then the player's agency (budget, research, crew,
 * missions), then narrative events which react to all of it.
 * launch has no weekly tick logic of its own beyond housekeeping but is registered for actions.
 */
export const MODULES = [
  ['politics', economyPolitics],
  ...(lifecycle ? [['lifecycle', lifecycle]] : []),
  ['diplomacy', diplomacy],
  ['calendar', calendar],
  ['budget', budget],
  ['research', research],
  ['crew', crew],
  ['designs', designs],     // Phase B §6: Hangar designs (asVehicle before missions read the vehicle list)
  ['missions', missions],
  ['infra', infra],         // Missões v2 §3: stations, bases, satellite fleets and rovers (after missions: deliveries)
  ['investors', investors], // Phase B §5: cap table, rounds and mandates (after missions: reads their results)
  ...(market ? [['market', market]] : []), // Missões v2 §8: rocket market (after investors)
  ['colonies', colonies],   // Phase C10: colonies from 2051 (unlocks.colonies; data from the 'colonies' pack, eras e5–e7)
  ['launch', launch],
  ['explore', explore],     // Phase B §8: fog of war of the space map (ids only)
  ['narrative', narrative],
  ['eco', eco],             // Phase C9 §9: the Eco mystery and the jan/3000 card (reads the step's firsts and news)
  ['director', director],   // fired ≠ game over: tenures, the "Você foi afastado" choice (no tick)
];

// the newest version this build writes: v2 plus every migration registered by the modules imported above
// (investors.js registers v2 → v3), so a new game is stamped with the same version a migrated save reaches
export const SAVE_VERSION = targetVersion();

/** Long-press "Próximo evento": at most this many turns, or 26 weeks, whichever is longer (UI reads it). */
export const RUN_MAX_STEPS = 12;
export const RUN_MAX_WEEKS = 26;

// ---------------------------------------------------------------------------------------------------------------
// Scenario view (tolerant: normalized §2.1 scenario from packs.js, or the legacy data/scenario.json)
// ---------------------------------------------------------------------------------------------------------------

/** Normalized fields the engine needs from data.scenario, whatever loader produced it. */
export function scenarioView(sc = {}) {
  const startYear = sc.start?.year ?? sc.startYear ?? 2026;
  const startMonth = sc.start?.month ?? 0;
  const legacy = !sc.kind && !sc.start;
  const endingType = sc.ending?.type ?? (sc.kind === 'campaign' ? 'final' : 'end');
  const endYear = sc.endYear ?? sc.end?.year ?? startYear + 4;
  const endMonth = sc.end?.month ?? 0;
  const turnWeeks = legacy ? 1 : (Number.isFinite(sc.turnWeeks) && sc.turnWeeks > 0 ? sc.turnWeeks : null);
  const finalTurn = endingType === 'final' ? dateToTurn(sc.end?.year ?? endYear, endMonth, startYear) : null;
  // 'end' keeps v0.5's formula: the scenario plays through the whole of endYear
  const endTurn = endingType === 'final' ? finalTurn : (endYear - startYear + 1) * WEEKS_PER_YEAR - 1;
  return {
    id: sc.id ?? 'lunar_race', kind: sc.kind ?? 'scenario', startYear, startMonth, endYear, endTurn, finalTurn,
    turnWeeks, endingType, endingEvent: sc.ending?.event ?? 'ending/final',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

/** Build the empty state skeleton. Each module's init() fills its own slices. */
export function createState(data, { seed, playerId }) {
  const sc = data.scenario || {};
  const v = scenarioView(sc);
  // a scenario that starts mid-year starts at that month's first week (turn 0 is always 1 January of startYear)
  const turn = v.startMonth ? dateToTurn(v.startYear, v.startMonth, v.startYear) : 0;
  const state = {
    version: SAVE_VERSION,
    scenarioId: v.id,
    seed: seed >>> 0,
    startYear: v.startYear,
    endTurn: v.endTurn,
    turn,
    playerId,
    idCounter: 0,
    gameOver: null, // null | { reason, turn, summary, ending? }

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
    firsts: {},      // helpers.claimFirst — "first of this era"
    firstsHistory: JSON.parse(JSON.stringify(sc.historicalFirsts || {})), // [core] feats done before the start
    decisions: [],   // helpers.pushDecision
    news: [],        // helpers.addNews
    log: [],         // helpers.log
    stats: {},       // free-form counters, any module, namespaced keys "module.key"
    signals: [],        // helpers.emitSignal — batch visible to all modules during the current tick
    signalsPending: [], // signals emitted since the last tick started (moved to `signals` at tick start)

    // ---- v2 (EXPANSION.md) ----
    clock: null,     // [core] see initClock
    eraHistory: [],  // [core] {eraId, turn, standings, firsts, survivors, headline}
    annals: {},      // [core] year -> top headlines (helpers.addNews)
    lifecycle: { applied: {}, tombstones: {}, aliases: {} }, // [lifecycle] (module init may replace it)
    dataPacks: { ...(data.packsLoaded || {}) }, // [core] packs the game was started with {id: hash}
  };
  initClock(state, data, v);
  return state;
}

function initClock(state, data, v) {
  state.clock = {
    eraId: null, stepWeeks: 1, bandIdx: 0, steps: 0, eraStartTurn: state.turn, pendingEra: null, paceMult: 1,
    turnWeeks: v.turnWeeks, finalTurn: v.finalTurn, endingPushed: false,
  };
  const b = bandAt(data, state, state.turn);
  state.clock.eraId = b.eraId;
  state.clock.stepWeeks = b.stepWeeks;
  state.clock.bandIdx = b.idx;
}

/** Clock of a state, created on the fly for hand-made test states without one (never persisted here). */
function clockOf(state, data) {
  if (!state.clock) {
    const v = scenarioView(data?.scenario || {});
    initClock(state, data, { ...v, turnWeeks: v.turnWeeks ?? 1, finalTurn: null });
  }
  return state.clock;
}

// ---------------------------------------------------------------------------------------------------------------
// Context and hooks
// ---------------------------------------------------------------------------------------------------------------

function makeHooks(state, data) {
  return {
    actorBorn: (id, info) => runHook(state, data, 'onActorBorn', id, info),
    actorGone: (id, info) => runHook(state, data, 'onActorGone', id, info),
    // a new director (src/sim/director.js): each module hands the old agency's player-only records over
    directorChanged: (info) => runHook(state, data, 'onDirectorChange', info),
  };
}

/**
 * ctx = {data, rng, date, dt, prevTurn, turn, eraId, year, hooks}. `extra` overrides the step window (prevTurn/dt)
 * for ticks and substeps; actions and decisions get the window of the next step.
 */
function makeCtx(state, data, moduleName, extra = {}) {
  const clock = state.clock;
  const dt = extra.dt ?? clock?.stepWeeks ?? 1;
  const prevTurn = extra.prevTurn ?? state.turn;
  const turn = state.turn;
  // date and hooks are built on first use (a 52-week step makes ~500 contexts and most modules read neither)
  let date, hooks;
  return {
    data,
    /** rng that depends only on (seed, turn, module, label) */
    rng: (label = '') => rngFor(state.seed, state.turn, moduleName, label),
    get date() { return date || (date = turnToDate(turn, state.startYear)); },
    dt,
    prevTurn,
    turn,
    /** end of the whole player step (a substep of a 13-week step still knows when the player next decides) */
    stepEnd: extra.stepEnd ?? prevTurn + dt,
    eraId: clock?.eraId ?? null,
    year: yearOf(state, turn),
    get hooks() { return hooks || (hooks = makeHooks(state, data)); },
  };
}

/** Call an optional module hook in MODULES order. */
function runHook(state, data, hook, ...args) {
  for (const [name, mod] of MODULES) {
    if (typeof mod[hook] === 'function') mod[hook](state, data, makeCtx(state, data, name), ...args);
  }
}

export function newGame(data, { seed, playerId }) {
  const state = createState(data, { seed, playerId });
  for (const [name, mod] of MODULES) {
    if (mod.init) mod.init(state, data, makeCtx(state, data, name));
  }
  // optional second pass once every slice exists (lifecycle reconciles diplomacy's roster with the start date)
  for (const [name, mod] of MODULES) {
    if (typeof mod.postInit === 'function') mod.postInit(state, data, makeCtx(state, data, name));
  }
  return state;
}

// ---------------------------------------------------------------------------------------------------------------
// Step length
// ---------------------------------------------------------------------------------------------------------------

/**
 * Details of the next step: {dt, stepWeeks, gridNext, truncated: null|'appointment'|'era'|'final'|'end', label}.
 * dt = max(1, min(gridNext, nearest player appointment, era boundary, final turn) − turn).
 */
export function stepInfo(state, data) {
  const clock = clockOf(state, data);
  const turn = state.turn;
  const band = bandAt(data, state, turn);
  const grid = gridNext(data, state, turn);
  let limit = grid;
  let truncated = null;
  const eraB = nextEraTurn(data, state, turn);
  if (eraB < limit) { limit = eraB; truncated = 'era'; }
  if (clock.finalTurn != null && clock.finalTurn > turn && clock.finalTurn < limit) { limit = clock.finalTurn; truncated = 'final'; }
  if (clock.finalTurn == null && state.endTurn != null && state.endTurn + 1 > turn && state.endTurn + 1 < limit) { limit = state.endTurn + 1; truncated = 'end'; }
  // appointments only matter when the step is longer than one week
  if (limit - turn > 1) {
    for (const [, mod] of MODULES) {
      if (typeof mod.appointments !== 'function') continue;
      let list;
      try { list = mod.appointments(state, data); } catch { list = null; }
      for (const t of list || []) {
        if (Number.isFinite(t) && t > turn && t < limit) { limit = t; truncated = 'appointment'; }
      }
    }
  }
  const dt = Math.max(1, limit - turn);
  const label = truncated === 'appointment' ? 'até o lançamento' : stepLabel(dt);
  return { dt, stepWeeks: band.stepWeeks, gridNext: grid, truncated, label, eraId: band.eraId, bandIdx: band.idx };
}

/** Length in weeks of the next tick (EXPANSION.md §1.3). */
export function stepFor(state, data) {
  return stepInfo(state, data).dt;
}

// ---------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------

/** maxDt of a module (default 1: an unconverted module is substepped week by week). */
const maxDtOf = (mod) => {
  const m = mod?.meta?.maxDt;
  return Number.isFinite(m) && m >= 1 ? m : 1;
};

/** Run a module's tick over [prevTurn, prevTurn + dt), in substeps of at most meta.maxDt weeks. */
function tickModule(state, data, name, mod, prevTurn, dt) {
  const max = maxDtOf(mod);
  if (dt <= max) {
    mod.tick(state, data, makeCtx(state, data, name, { prevTurn, dt, stepEnd: prevTurn + dt }));
    return;
  }
  const saved = state.turn;
  const signals = state.signals;
  try {
    for (let sub = prevTurn; sub < prevTurn + dt; sub += max) {
      const sdt = Math.min(max, prevTurn + dt - sub);
      state.turn = sub;
      mod.tick(state, data, makeCtx(state, data, name, { prevTurn: sub, dt: sdt, stepEnd: prevTurn + dt }));
      if (state.gameOver) break;
      // the step's signals are delivered once, in the first substep: before this, a 52-week step made every
      // substepped module handle each signal 52 times (diplomacy re-ran its AI evaluation every week for each
      // tension change, research paid tech transfers 52 times, politics scored a mission 52 times…)
      state.signals = [];
    }
  } finally {
    state.turn = saved;
    state.signals = signals;
  }
}

/** One player turn: advances `stepFor` weeks (1 in the Corrida Lunar). */
export function tick(state, data) {
  if (state.gameOver) return state;
  const clock = clockOf(state, data);
  const info = stepInfo(state, data);
  const dt = info.dt;
  const prevTurn = state.turn;
  clock.stepWeeks = info.stepWeeks;
  clock.bandIdx = info.bandIdx;
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
    if (mod.tick) tickModule(state, data, name, mod, prevTurn, dt);
    // a module ended the campaign mid-step (budget fires the director): nothing else happens this step
    if (state.gameOver) break;
  }
  state.turn = prevTurn + dt;
  clock.steps = (clock.steps || 0) + 1;
  const ctx = { prevTurn, dt, turn: state.turn };
  if (!state.gameOver && every(ctx, WEEKS_PER_YEAR) > 0) yearly(state, data, prevTurn, dt);
  if (!state.gameOver) checkEra(state, data);
  if (!state.gameOver && clock.finalTurn != null && state.turn >= clock.finalTurn && !clock.endingPushed) pushEnding(state, data);
  if (clock.finalTurn == null && state.turn > state.endTurn && !state.gameOver) state.gameOver = { reason: 'end', turn: state.turn, summary: null };
  if (state.gameOver) endGame(state, data);
  // the director was removed this step (fired, board): the world went on to the end of the step; now the clock waits
  // for the player's next agency (isBlocked 'ousted'), with the old director's cards and launch day closed
  else if (state.director?.ousted && !state.director.ousted.frozen) director.freeze(state, data);
  return state;
}

/** Year boundary: modules' onYear, then compaction (modules + core). */
function yearly(state, data, prevTurn, dt) {
  for (const [name, mod] of MODULES) {
    if (typeof mod.onYear === 'function') mod.onYear(state, data, makeCtx(state, data, name, { prevTurn, dt }));
  }
  compactAll(state, data, prevTurn, dt);
}

function compactAll(state, data, prevTurn = state.turn, dt = 1) {
  for (const [name, mod] of MODULES) {
    if (typeof mod.compact === 'function') mod.compact(state, data, makeCtx(state, data, name, { prevTurn, dt }));
  }
  compactAnnals(state, yearOf(state, state.turn));
  // 1950–3000 (save budget 400 KB): news older than a year keep the headline, not the body
  if (Number.isFinite(state.endTurn) && state.endTurn > 520) {
    for (const n of state.news || []) if (n?.body && state.turn - (n.turn ?? state.turn) > 52) n.body = '';
    if (Array.isArray(state.news) && state.news.length > 60) state.news.length = 60;
    if (Array.isArray(state.events?.journal) && state.events.journal.length > 50) state.events.journal.length = 50;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Eras
// ---------------------------------------------------------------------------------------------------------------

/** True when the data pack of an era is loaded (or the loader does not use packs at all). */
export function eraPackLoaded(data, eraId) {
  const loaded = data?.packsLoaded;
  if (!loaded || !eraId) return true;
  if (Array.isArray(loaded)) return loaded.includes(eraId);
  return Object.prototype.hasOwnProperty.call(loaded, eraId);
}

/** After a tick: entering a new era opens a pending transition (blocking card, era scene in the UI). */
function checkEra(state, data) {
  const clock = state.clock;
  if (clock.pendingEra) return;
  const era = eraAt(data, yearOf(state, state.turn));
  if (!era || era.id === clock.eraId) return;
  const from = clock.eraId;
  clock.pendingEra = { from, to: era.id, turn: state.turn };
  recordEra(state, data, from);
  runHook(state, data, 'onEraEnd', { from, to: era.id });
  compactAll(state, data);
  const prev = eraById(data, from);
  pushDecision(state, {
    kind: 'era/transition',
    title: `Fim da Era ${prev?.n ?? ''}: ${prev?.name ?? from}`.replace('  ', ' '),
    body: `Começa a Era ${era.n ?? ''}: ${era.name}.`,
    choices: [{ id: 'continue', label: `Começar a Era ${era.n ?? era.id}` }],
    urgency: 3,
    blocking: true,
    payload: { from, to: era.id },
  });
}

/** Tabela da Era snapshot pushed to state.eraHistory when an era closes. */
function recordEra(state, data, eraId) {
  const standings = Object.entries(state.actors || {})
    .map(([id, a]) => ({ id, prestigeEra: Math.round(Number.isFinite(a.prestigeEra) ? a.prestigeEra : (a.prestige || 0)) }))
    .sort((a, b) => b.prestigeEra - a.prestigeEra || (a.id < b.id ? -1 : 1));
  const start = state.clock.eraStartTurn ?? 0;
  const firsts = Object.entries(state.firsts || {})
    .filter(([, f]) => f && f.turn >= start)
    .map(([milestone, f]) => ({ milestone, actorId: f.actorId, turn: f.turn }))
    .slice(0, 12);
  const y = yearOf(state, state.turn) - 1;
  const headline = state.annals?.[y]?.[0]?.h ?? state.news?.[0]?.headline ?? null;
  state.eraHistory = state.eraHistory || [];
  state.eraHistory.push({ eraId, turn: state.turn, standings, firsts, survivors: Object.keys(state.actors || {}), headline });
}

/** Close the pending transition (built-in 'era/transition' handler). */
function startEra(state, data) {
  const clock = state.clock;
  const p = clock.pendingEra;
  if (!p) return { ok: true };
  clock.eraId = p.to;
  clock.eraStartTurn = state.turn;
  clock.pendingEra = null;
  const b = bandAt(data, state, state.turn);
  clock.stepWeeks = b.stepWeeks;
  clock.bandIdx = b.idx;
  // Tabela da Era restarts; lifetime prestige carries over
  for (const a of Object.values(state.actors || {})) a.prestigeEra = 0;
  runHook(state, data, 'onEraStart', { from: p.from, to: p.to });
  const era = eraById(data, p.to);
  addNews(state, { headline: `Começa a Era ${era?.n ?? ''}: ${era?.name ?? p.to}`.replace('  ', ' '), importance: 3, tags: ['era'], icon: 'era' });
  return { ok: true, eraId: p.to };
}

// ---------------------------------------------------------------------------------------------------------------
// Final event (jan/3000). Phase A stub; src/sim/eco.js (Phase C) registers the same decision kind and wins.
// ---------------------------------------------------------------------------------------------------------------

const ENDING_FALLBACK = {
  title: 'O Grande Silêncio',
  body: 'Janeiro de 3000. O Eco se cala. O que a humanidade faz agora?',
  choices: [
    { id: 'contato', label: 'Contato', preview: 'Responder ao Silêncio.', text: 'A agência responde ao Silêncio.' },
    { id: 'silencio', label: 'Silêncio', preview: 'Calar e seguir sozinhos.', text: 'A agência segue sozinha.' },
    { id: 'heranca', label: 'Herança', preview: 'Deixar tudo preparado para quem vier depois.', text: 'A agência deixa a porta aberta.' },
  ],
};
export const ENDINGS = ['contato', 'silencio', 'heranca'];

function endingData(data) {
  const e = data?.ending;
  return e && Array.isArray(e.choices) && e.choices.length ? e : ENDING_FALLBACK;
}

function pushEnding(state, data) {
  const e = endingData(data);
  state.clock.endingPushed = true;
  pushDecision(state, {
    kind: 'ending/final',
    title: e.title,
    body: e.body,
    choices: e.choices.map((c) => ({ id: c.id, label: c.label, preview: c.preview })),
    urgency: 3,
    blocking: true,
    payload: { turn: state.turn },
  });
}

/** Built-in decision handlers (modules registering the same kind take precedence). */
const BUILTIN_DECISIONS = {
  'era/transition': (state, data) => startEra(state, data),
  'ending/final': (state, data, dec, choiceId) => {
    const e = endingData(data);
    const c = e.choices.find((x) => x.id === choiceId) || e.choices[0];
    state.gameOver = { reason: 'ending', ending: c.id, turn: state.turn, summary: c.text || c.title || c.label };
    endGame(state, data);
    return { ok: true, ending: c.id };
  },
};

/** Run every module's onGameEnd exactly once, whatever ended the campaign, and clear the decision queue. */
export function endGame(state, data) {
  if (!state.gameOver || state.gameOver.hooksRun) return;
  state.gameOver.hooksRun = true;
  // nothing can be decided or flown any more (a launch card pushed in the last week would otherwise fly after the trophy)
  state.decisions = [];
  for (const [name, mod] of MODULES) {
    if (mod.onGameEnd) mod.onGameEnd(state, data, makeCtx(state, data, name));
  }
}

/** Actions that only read state; still allowed after the campaign is over. */
const READ_ONLY_ACTIONS = new Set(['time/advance', 'mission/estimate']);
/** What the player may do with no agency to direct (fired, choice pending): choose, or start the waiting era. */
const OUSTED_ACTIONS = new Set(['director/take', 'director/found']);

/**
 * True when time must not advance: 'gameOver' | 'ousted' (the player was fired and has not chosen the next agency) |
 * 'launch' | 'needsData' (the next era's pack is not loaded) |
 * 'era' (pending era transition) | 'decision' (blocking card) | null.
 */
export function isBlocked(state, data) {
  if (state.gameOver) return 'gameOver';
  if (state.director?.ousted) return 'ousted';
  if (state.activeLaunch) return 'launch';
  const p = state.clock?.pendingEra;
  if (p) return data && !eraPackLoaded(data, p.to) ? 'needsData' : 'era';
  if (state.decisions.some((d) => d.blocking)) return 'decision';
  return null;
}

/** Turns needed to cover `weeks` weeks at the current step (v0.5 callers count weeks; equal at dt = 1). */
export function turnsForWeeks(state, data, weeks) {
  const w = Math.max(1, Math.round(weeks));
  const step = state.clock?.turnWeeks ?? bandAt(data, state, state.turn).stepWeeks;
  return Math.max(1, Math.ceil(w / Math.max(1, step)));
}

/**
 * Advance up to `turns` player turns, stopping early when blocked or when something new needs attention
 * (a new decision or a new important news item) if stopOnEvent is true.
 * Returns { advanced (turns), weeks, stoppedBy }.
 */
export function advance(state, data, turns = 1, { stopOnEvent = false } = {}) {
  let advanced = 0;
  const startTurn = state.turn;
  for (let i = 0; i < turns; i++) {
    const b = isBlocked(state, data);
    if (b) return { advanced, weeks: state.turn - startTurn, stoppedBy: b };
    const decBefore = state.decisions.length;
    const newsBefore = state.news[0]?.id;
    tick(state, data);
    advanced++;
    if (state.director?.ousted) return { advanced, weeks: state.turn - startTurn, stoppedBy: 'ousted' };
    if (stopOnEvent) {
      if (state.decisions.length > decBefore) return { advanced, weeks: state.turn - startTurn, stoppedBy: 'newDecision' };
      const top = state.news[0];
      if (top && top.id !== newsBefore && top.importance >= 3) return { advanced, weeks: state.turn - startTurn, stoppedBy: 'news' };
    }
  }
  return { advanced, weeks: state.turn - startTurn, stoppedBy: isBlocked(state, data) };
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
  if (BUILTIN_DECISIONS[kind]) return { h: BUILTIN_DECISIONS[kind], name: 'engine' };
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
  // the next era cannot start before its data pack is loaded (the UI loads it and retries)
  if (d.kind === 'era/transition') {
    const to = d.payload?.to ?? state.clock?.pendingEra?.to;
    if (!eraPackLoaded(data, to)) return { ok: false, needsData: to, error: 'Carregando a próxima era…' };
  }
  const at = state.decisions.indexOf(d);
  removeDecision(state, decisionId);
  const found = decisionHandler(d.kind);
  if (!found) {
    log(state, `sem handler para decisão ${d.kind}`);
    return { ok: true };
  }
  const res = found.h(state, data, d, choiceId, { ...makeCtx(state, data, found.name), ...opts }) || {};
  // a refused choice (e.g. "Aceitar" with the investors' agenda full) keeps the card, so another choice can be made
  if (res.ok === false && !opts.expired && !state.decisions.includes(d)) state.decisions.splice(Math.min(at, state.decisions.length), 0, d);
  return { ok: true, ...res };
}

/**
 * The single entry point for the UI.
 * Built-in actions: 'time/advance' {turns | weeks, stopOnEvent}, 'decision/resolve' {id, choiceId}.
 * Everything else is routed to module `actions`.
 * Returns { ok, error?, ...handlerResult }.
 */
export function dispatch(state, data, action) {
  try {
    if (state.gameOver && !READ_ONLY_ACTIONS.has(action?.type)) return { ok: false, error: 'Campanha encerrada.' };
    if (state.director?.ousted && !READ_ONLY_ACTIONS.has(action?.type) && !OUSTED_ACTIONS.has(action?.type)
      && !(action?.type === 'decision/resolve' && state.decisions.find((d) => d.id === action.id)?.kind === 'era/transition')) {
      return { ok: false, error: 'Você foi afastado da direção: assuma outra agência ou funde uma nova.' };
    }
    if (action.type === 'time/advance') {
      const turns = action.turns ?? (action.weeks != null ? turnsForWeeks(state, data, action.weeks) : 1);
      return { ok: true, ...advance(state, data, turns, { stopOnEvent: action.stopOnEvent ?? true }) };
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

/** Engine queries (time). */
const BUILTIN_QUERIES = {
  /** Disc label of the next step: '+2 sem', '+1 trimestre'… or 'até o lançamento' when truncated by an appointment. */
  'time/stepLabel': (state, data) => stepInfo(state, data).label,
  /** Clock + next step details for the UI (date chip, era chip, disc). */
  'time/clock': (state, data) => {
    const info = stepInfo(state, data);
    const era = eraById(data, state.clock?.eraId);
    return {
      ...state.clock, ...info, year: yearOf(state), date: turnToDate(state.turn, state.startYear),
      eraName: era?.name ?? null, eraN: era?.n ?? null, finalTurn: state.clock?.finalTurn ?? null, endTurn: state.endTurn,
    };
  },
};

/** Read-only queries the UI may call (pure functions over state). Modules export `queries`. */
export function query(state, data, name, ...args) {
  for (const [, mod] of MODULES) {
    const q = mod.queries?.[name];
    if (q) return q(state, data, ...args);
  }
  if (BUILTIN_QUERIES[name]) return BUILTIN_QUERIES[name](state, data, ...args);
  throw new Error(`consulta desconhecida: ${name}`);
}

/** JSON text of a save. Long campaigns use the lossless compact encoding of src/core/savepack.js. */
export function serialize(state) {
  return JSON.stringify(packState(state));
}

/** Parse + migrate a save. Throws SaveError {code: 'newer'|'unreadable'|'scenario', message (pt-BR)}. */
export function deserialize(json, data) {
  const state = migrate(json, data);
  // v0.9.13: a save that ended with the director fired before the campaign's end goes back to the choice
  director.reopen(state, data);
  return state;
}

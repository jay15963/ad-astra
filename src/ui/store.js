// UI store: wraps the engine (state + dispatch + query), save slots, settings and small UI memory
// (metric snapshots for trend arrows). DOM-free: localStorage/navigator are guarded so it runs in Node.
//
// Saves (docs/EXPANSION.md §10-11): `adastra.save.auto` (written after every action), manual slots
// `adastra.save.slot1..3`, era checkpoints `adastra.save.era.<eraId>` (last 2 kept), index `adastra.saves.index`.
// A v1 save under `adastra.save.v1` is migrated into the auto slot on first boot and deleted only after the
// new write succeeds. A save the engine rejects is never deleted silently: its raw text is kept under
// `adastra.save.backup.v<N>` and the title screen shows a card (store.rejection) with "Começar de novo" and
// "Exportar o save".

import * as engine from '../core/engine.js';
import * as dataApi from '../core/data.js';

const { newGame: engineNewGame, dispatch: engineDispatch, query: engineQuery, serialize, deserialize, isBlocked } = engine;

export const SAVE_KEY = 'adastra.save.auto';
export const LEGACY_SAVE_KEY = 'adastra.save.v1';
export const SLOT_NAMES = ['slot1', 'slot2', 'slot3'];
export const INDEX_KEY = 'adastra.saves.index';
export const SETTINGS_KEY = 'adastra.settings';
export const METRICS_KEY = 'adastra.metrics.v1';
export const ERA_CHECKPOINTS_KEPT = 2;
/** "Próximo evento" (disc long-press) runs at most this many turns, or 26 weeks if that is longer (§1.6). */
export const RUN_MAX_STEPS = 12;
export const RUN_MAX_WEEKS = 26;

/** pt-BR rejection texts (§11); the engine's SaveError carries its own message, these are the fallbacks. */
export const SAVE_MESSAGES = {
  newer: 'Este save é de uma versão mais nova do Ad Astra. Atualize o jogo para continuar.',
  unreadable: 'Não foi possível ler este save. Ele pode estar corrompido ou ser de uma versão antiga demais.',
  scenario: 'Este save usa um cenário que não existe nesta versão.',
};

/** Disc label per step length in weeks (time.js stepLabel is the source when the engine exposes it). */
const STEP_LABELS = { 1: '+1 semana', 2: '+2 sem', 4: '+4 sem', 13: '+1 trimestre', 26: '+1 semestre', 52: '+1 ano' };
export function stepLabelFor(weeks) {
  const w = Math.max(1, Math.round(Number(weeks) || 1));
  return STEP_LABELS[w] || `+${w} sem`;
}

/** Turns the long-press run may take: RUN_MAX_STEPS turns or 26 weeks, whichever is longer. */
export function runMaxSteps(stepWeeks = 1) {
  const w = Math.max(1, Number(stepWeeks) || 1);
  return Math.max(RUN_MAX_STEPS, Math.ceil(RUN_MAX_WEEKS / w));
}

/** localStorage key of a save slot: 'auto', 'slot1'..'slot3', 'era.<eraId>', 'legacy' (the v1 key). */
export const slotKey = (name) => (name === 'auto' ? SAVE_KEY : name === 'legacy' ? LEGACY_SAVE_KEY : `adastra.save.${name}`);

function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export const DEFAULT_SETTINGS = {
  sound: true,
  vibrate: true,
  reduceMotion: false,
  textScale: 1,      // 1 | 1.15 | 1.3
  colorblind: false,
  interventionSeconds: 5, // 5 | 10 | 0 (= no limit): GDD act 4 default is 5 s; pillar 5, no punishing timers
};

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const k = '__adastra_probe';
    s.setItem(k, '1'); s.removeItem(k);
    return s;
  } catch { return null; }
}

/** In-memory fallback (private mode / Node). */
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** Values tracked per turn for trend arrows and sparklines. */
export function metricsOf(state) {
  const p = state?.actors?.[state?.playerId] || {};
  const crew = Object.values(state?.crew || {}).filter((c) => c && c.actorId === state.playerId && c.status === 'active');
  return {
    turn: state?.turn ?? 0,
    cash: Number(p.cash) || 0,
    support: Number(p.support) || 0,
    reputation: Number(p.reputation) || 0,
    prestige: Number(p.prestige) || 0,
    crew: crew.length,
    morale: crew.length ? crew.reduce((s, c) => s + (Number(c.morale) || 0), 0) / crew.length : 0,
  };
}

/** {code, message} for a save the engine refused (SaveError from migrate.js, or an older plain Error). */
export function rejectionOf(e, raw = null) {
  let version = null;
  try { version = raw ? JSON.parse(raw)?.version ?? null : null; } catch { /* unreadable */ }
  const code = e?.code || (version != null && Number(version) > Number(engine.SAVE_VERSION) ? 'newer' : 'unreadable');
  const msg = typeof e?.message === 'string' && /[ãçéêíóõú]/i.test(e.message) && e.message.length > 30 ? e.message : (SAVE_MESSAGES[code] || SAVE_MESSAGES.unreadable);
  return { code, message: msg, version };
}

/**
 * Playable actors for a scenario at its start date (new-game picker): the lifecycle query when the engine has it,
 * else the scenario's list with each lineage's identity at the start date from data (lineages.json), else actors.json.
 * Returns [{id, ...actorDef, name, short}] — DOM-free, never throws.
 */
export function playableAtStart(data) {
  const sc = data?.scenario || {};
  const idx = data?.index?.actors || {};
  const list = sc.playable?.actors || sc.playableActors || Object.keys(idx);
  let ids = null;
  try {
    const probe = engineNewGame(data, { seed: 1, playerId: list[0] });
    const q = engineQuery(probe, data, 'lifecycle/playable', sc);
    if (Array.isArray(q) && q.length) ids = q.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
    if (ids) {
      return ids.map((id) => ({ ...(idx[id] || {}), ...(probe.actors?.[id] || {}), id }));
    }
  } catch { /* lifecycle not there yet: fall back to data */ }
  const start = sc.start || { year: sc.startYear, month: 0 };
  const lineages = data?.lineages?.lineages || (Array.isArray(data?.lineages) ? data.lineages : []);
  const byId = Object.fromEntries(lineages.map((l) => [l.id, l]));
  const t = (d) => (Number(d?.year) || 0) * 12 + (Number(d?.month) || 0);
  return list.map((id) => {
    const base = { ...(idx[id] || { id, name: String(id).toUpperCase(), short: String(id).toUpperCase() }), id };
    const lin = byId[id];
    if (!lin) return base;
    if (lin.born && t(lin.born) > t(start)) return null;
    let cur = {};
    for (const ident of lin.identities || []) if (t(ident.from) <= t(start)) cur = { ...cur, ...ident };
    delete cur.from;
    return { ...base, ...cur, id };
  }).filter(Boolean);
}

/**
 * createStore(data, {storage, loadScenario, reader}) -> store (see ARCHITECTURE.md "UI").
 * `data` is the loaded game data. loadScenario(id) -> Promise<data> swaps scenarios (campaign vs Corrida Lunar);
 * reader is the JSON reader used by ensureEra (era packs, data.ensurePacks).
 */
export function createStore(data, { storage, loadScenario = null, reader = null } = {}) {
  const st = storage || defaultStorage() || memoryStorage();
  const subs = new Set();

  const readJSON = (k, fb) => { try { const v = st.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const writeJSON = (k, v) => { try { st.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
  const readRaw = (k) => { try { return st.getItem(k); } catch { return null; } };

  const store = {
    data,
    state: null,
    settings: { ...DEFAULT_SETTINGS, reduceMotion: prefersReducedMotion(), ...readJSON(SETTINGS_KEY, {}) },
    metrics: readJSON(METRICS_KEY, []), // [{turn, cash, support, ...}] last 40 turns seen
    lastAction: null,
    lastResult: null,
    saveError: null,
    rejection: null, // {code, message, slot, version} when the last load was refused

    dispatch(action) {
      if (!store.state) return { ok: false, error: 'nenhum jogo carregado' };
      let res;
      try {
        res = engineDispatch(store.state, store.data, action) || { ok: true };
      } catch (e) {
        res = { ok: false, error: e?.message || String(e) };
      }
      store.lastAction = action;
      store.lastResult = res;
      store.save();
      notify(action, res);
      return res;
    },

    /** Raw query (may throw if the module is still a stub). */
    query(name, ...args) {
      if (!store.state) throw new Error('nenhum jogo carregado');
      return engineQuery(store.state, store.data, name, ...args);
    },

    /** Query that never throws: returns `fallback` on error or undefined. */
    tryQuery(name, fallback, ...args) {
      try {
        const v = store.query(name, ...args);
        return v === undefined || v === null ? fallback : v;
      } catch { return fallback; }
    },

    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },

    setSettings(patch) {
      store.settings = { ...store.settings, ...patch };
      writeJSON(SETTINGS_KEY, store.settings);
      notify({ type: 'ui/settings' }, { ok: true });
    },

    // ---------------------------------------------------------------- scenarios and data packs

    /** Id of the scenario the loaded data describes. */
    scenarioId() { return store.data?.scenario?.id || 'lunar_race'; },

    /** Scenarios the title screen offers: data.listScenarios when present, else the loaded one. */
    scenarios() {
      try {
        const l = dataApi.listScenarios?.(store.data);
        if (Array.isArray(l) && l.length) return l;
      } catch { /* */ }
      const sc = store.data?.scenario || {};
      return [{ id: sc.id || 'lunar_race', kind: sc.kind || 'scenario', name: sc.name || 'Corrida Lunar', subtitle: sc.subtitle || null, start: sc.start || { year: sc.startYear, month: 0 } }];
    },

    /** Make store.data describe `scenarioId` (async: loads the scenario's packs). Resolves to true when ready. */
    async useScenario(scenarioId) {
      if (!scenarioId || store.scenarioId() === scenarioId) return true;
      if (typeof loadScenario !== 'function') return false;
      const next = await loadScenario(scenarioId);
      if (!next?.scenario || (next.scenario.id && next.scenario.id !== scenarioId)) return false;
      store.data = next;
      return true;
    },

    /**
     * Move the loaded scenario's start to January of `year` (founding "Quando começar"; null = the scenario's own
     * start) and load that era's packs (data.ensureStartYear). Resolves to true when store.data describes it.
     */
    async useStart(year = null) {
      if (typeof dataApi.ensureStartYear !== 'function') return year == null;
      const rd = reader || (dataApi.browserReader ? dataApi.browserReader() : null);
      const next = await dataApi.ensureStartYear(store.data, rd, Number.isFinite(year) ? year : null);
      if (next && typeof next === 'object') store.data = next;
      const sc = store.data?.scenario || {};
      return year == null || (sc.start?.year ?? sc.startYear) === year;
    },

    /** Load the data pack of an era (browser loads packs lazily; Node has them all). Resolves to true when present. */
    async ensureEra(eraId) {
      if (!eraId) return true;
      if (store.data?.packsLoaded && (store.data.packsLoaded[eraId] || (Array.isArray(store.data.packsLoaded) && store.data.packsLoaded.includes(eraId)))) return true;
      if (typeof dataApi.ensurePacks !== 'function') return true; // single-pack data: nothing to load
      const rd = reader || (dataApi.browserReader ? dataApi.browserReader() : null);
      const next = await dataApi.ensurePacks(store.data, rd, [eraId]);
      if (next && typeof next === 'object') store.data = next;
      // per-era offline cache (sw.js precacheEras): this era and the next one
      try {
        const n = Number(String(eraId).slice(1));
        globalThis.navigator?.serviceWorker?.controller?.postMessage({ type: 'precache-eras', eras: [eraId, ...(n ? [`e${n + 1}`] : [])] });
      } catch { /* no service worker (Node, private mode) */ }
      return true;
    },

    // ---------------------------------------------------------------- game lifecycle

    newGame({ playerId, seed, scenarioId } = {}) {
      const s = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 1;
      if (scenarioId && scenarioId !== store.scenarioId()) throw new Error('cenário não carregado');
      store.state = engineNewGame(store.data, { seed: s, playerId, scenarioId: scenarioId || store.scenarioId() });
      store.rejection = null;
      store.metrics = [];
      recordMetrics();
      store.save();
      notify({ type: 'ui/newGame' }, { ok: true });
      return store.state;
    },

    hasSave(name = 'auto') {
      return !!readRaw(slotKey(name));
    },

    /** Brief info about a save for the title screen (without loading it). */
    saveInfo(name = 'auto') {
      try {
        const raw = readRaw(slotKey(name));
        if (!raw) return null;
        const s = JSON.parse(raw);
        return {
          playerId: s.playerId, turn: s.turn, startYear: s.startYear, gameOver: !!s.gameOver, seed: s.seed,
          actor: s.actors?.[s.playerId] || null, scenarioId: s.scenarioId || 'lunar_race', eraId: s.clock?.eraId || null,
          version: s.version ?? null, activeLaunch: !!s.activeLaunch,
        };
      } catch { return null; }
    },

    /** Load a slot (sync: the data must already describe its scenario; see loadSlot). */
    load(name = 'auto') {
      const raw = readRaw(slotKey(name));
      if (!raw) return false;
      try {
        const loaded = deserialize(raw, store.data);
        if (loaded?.scenarioId && store.data?.scenario?.id && loaded.scenarioId !== store.data.scenario.id) {
          const e = new Error(SAVE_MESSAGES.scenario);
          e.code = 'scenario';
          throw e;
        }
        store.state = loaded;
        store.rejection = null;
        store.saveError = null;
        store.metrics = name === 'auto' ? readJSON(METRICS_KEY, []) : [];
        recordMetrics();
        if (name !== 'auto') store.save(); // the loaded game continues in the auto slot
        notify({ type: 'ui/load' }, { ok: true });
        return true;
      } catch (e) {
        const r = rejectionOf(e, raw);
        // a save for a scenario this build has but the loaded data is not: not a rejection, loadSlot switches
        store.saveError = r.message;
        store.rejection = { ...r, slot: name };
        if (r.code !== 'scenario' || !store.scenarios().some((x) => x.id === store.saveInfo(name)?.scenarioId)) {
          try { st.setItem(`adastra.save.backup.v${r.version ?? 'x'}`, raw); } catch { /* full storage */ }
        }
        return false;
      }
    },

    /** Async load: switches to the save's scenario and era pack first. */
    async loadSlot(name = 'auto') {
      const info = store.saveInfo(name);
      if (!info) { store.saveError = SAVE_MESSAGES.unreadable; store.rejection = { code: 'unreadable', message: SAVE_MESSAGES.unreadable, slot: name }; return false; }
      try {
        const ok = await store.useScenario(info.scenarioId);
        if (!ok && info.scenarioId !== store.scenarioId()) {
          store.saveError = SAVE_MESSAGES.scenario;
          store.rejection = { code: 'scenario', message: SAVE_MESSAGES.scenario, slot: name, version: info.version };
          return false;
        }
        // a campaign founded in a later era keeps its start (snapshot, packs of that era); others go back to theirs
        await store.useStart(Number.isFinite(info.startYear) ? info.startYear : null);
        if (info.eraId) await store.ensureEra(info.eraId);
      } catch (e) {
        store.saveError = SAVE_MESSAGES.unreadable;
        store.rejection = { code: 'unreadable', message: SAVE_MESSAGES.unreadable, slot: name };
        return false;
      }
      return store.load(name);
    },

    save() {
      if (!store.state) return false;
      try {
        st.setItem(SAVE_KEY, serialize(store.state));
        store.saveError = null;
        return true;
      } catch (e) {
        store.saveError = e?.message || String(e);
        return false;
      }
    },

    /** Manual slot ('slot1'..'slot3') or era checkpoint ('era.e2'). */
    saveSlot(name) {
      if (!store.state || !name || name === 'auto') return false;
      try {
        st.setItem(slotKey(name), serialize(store.state));
        const idx = readJSON(INDEX_KEY, { eras: [] }) || { eras: [] };
        idx.eras = Array.isArray(idx.eras) ? idx.eras : [];
        if (name.startsWith('era.')) {
          idx.eras = idx.eras.filter((x) => x !== name).concat(name);
          while (idx.eras.length > ERA_CHECKPOINTS_KEPT) { const old = idx.eras.shift(); try { st.removeItem(slotKey(old)); } catch { /* */ } }
        }
        idx[name] = { turn: store.state.turn, at: Date.now() };
        writeJSON(INDEX_KEY, idx);
        store.saveError = null;
        return true;
      } catch (e) {
        store.saveError = e?.message || String(e);
        return false;
      }
    },

    /** Era checkpoint written by the era scene before its last card. */
    eraCheckpoint(eraId) { return eraId ? store.saveSlot(`era.${eraId}`) : false; },

    /** [{name, label, kind: 'auto'|'slot'|'era', writable, info}] for the Salvar screen and the title screen. */
    slots() {
      const idx = readJSON(INDEX_KEY, { eras: [] }) || {};
      const eras = (Array.isArray(idx.eras) ? idx.eras : []).slice().reverse();
      return [
        { name: 'auto', label: 'Salvamento automático', kind: 'auto', writable: false, info: store.saveInfo('auto') },
        ...SLOT_NAMES.map((n, i) => ({ name: n, label: `Espaço ${i + 1}`, kind: 'slot', writable: true, info: store.saveInfo(n) })),
        ...eras.map((n) => ({ name: n, label: `Início da era ${n.slice(4).replace(/^e/, '')}`, kind: 'era', writable: false, info: store.saveInfo(n) })).filter((s) => s.info),
      ];
    },

    deleteSave() {
      try { st.removeItem(SAVE_KEY); st.removeItem(METRICS_KEY); } catch { /* ignore */ }
      store.state = null;
      store.metrics = [];
      store.rejection = null;
      notify({ type: 'ui/deleteSave' }, { ok: true });
    },

    /** "Começar de novo" on the rejection card: the raw save is already in a backup key, drop the slot. */
    dismissRejected() {
      const slot = store.rejection?.slot || 'auto';
      const raw = readRaw(slotKey(slot));
      if (raw) { try { st.setItem(`adastra.save.backup.v${store.rejection?.version ?? 'x'}`, raw); st.removeItem(slotKey(slot)); } catch { /* */ } }
      store.rejection = null;
      store.saveError = null;
    },

    /** Raw text of a slot (Exportar o save on the rejection card). */
    rawSave(name = 'auto') { return readRaw(slotKey(name)); },

    /** Export/import raw save text (settings screen). */
    exportSave() { return store.state ? serialize(store.state) : null; },
    importSave(text) {
      const s = deserialize(text, store.data); // throws on incompatible
      store.state = s;
      store.metrics = [];
      recordMetrics();
      store.save();
      notify({ type: 'ui/load' }, { ok: true });
      return true;
    },

    /** Leave the current game without deleting the save (back to title). */
    unload() {
      store.state = null;
      notify({ type: 'ui/unload' }, { ok: true });
    },

    // ---------------------------------------------------------------- time

    /** Length of the next step in weeks (engine clock; 1 in the Corrida Lunar). */
    stepWeeks() {
      const c = store.tryQuery('time/clock', null);
      const w = c?.stepWeeks ?? store.state?.clock?.stepWeeks ?? store.data?.scenario?.turnWeeks ?? 1;
      return Math.max(1, Number(w) || 1);
    },

    /** Disc label: "+1 semana", "+2 sem", "+1 trimestre"…, or "até o lançamento" when the step is truncated. */
    stepLabel() {
      const q = store.tryQuery('time/stepLabel', null);
      const label = typeof q === 'string' ? q : q?.label;
      if (label) return label === '+1 sem' ? '+1 semana' : label;
      return stepLabelFor(store.stepWeeks());
    },

    /** The time/advance action for n player turns (engine v2 counts turns; v1 counted weeks = turns). */
    advanceAction(n = 1, stopOnEvent = false) {
      return Number(engine.SAVE_VERSION) >= 2
        ? { type: 'time/advance', turns: n, stopOnEvent }
        : { type: 'time/advance', weeks: n, stopOnEvent };
    },

    runMaxSteps() { return runMaxSteps(store.stepWeeks()); },

    vibrate(pattern) {
      if (!store.settings.vibrate) return false;
      try { return !!globalThis.navigator?.vibrate?.(pattern); } catch { return false; }
    },

    player() {
      return store.state?.actors?.[store.state.playerId] || null;
    },

    blocked() {
      return store.state ? isBlocked(store.state, store.data) : null;
    },

    /** Delta of a metric versus the last snapshot from an earlier turn. */
    trend(key) {
      if (!store.state) return 0;
      const now = metricsOf(store.state);
      for (let i = store.metrics.length - 1; i >= 0; i--) {
        const m = store.metrics[i];
        if (m.turn < now.turn) return (now[key] ?? 0) - (m[key] ?? 0);
      }
      return 0;
    },

    /** Series of a metric for sparklines (oldest -> newest). */
    series(key, n = 16) {
      return store.metrics.slice(-n).map((m) => m[key]);
    },
  };

  function recordMetrics() {
    if (!store.state) return;
    const m = metricsOf(store.state);
    const last = store.metrics[store.metrics.length - 1];
    // most actions (launch steps, UI clicks) change none of these: skip the localStorage write
    if (last && last.turn === m.turn && Object.keys(m).every((k) => last[k] === m[k])) return;
    if (last && last.turn === m.turn) store.metrics[store.metrics.length - 1] = m;
    else store.metrics.push(m);
    if (store.metrics.length > 40) store.metrics.splice(0, store.metrics.length - 40);
    writeJSON(METRICS_KEY, store.metrics);
  }

  function notify(action, res) {
    recordMetrics();
    for (const fn of Array.from(subs)) {
      try { fn(store.state, action, res); } catch (e) { console.error('[Ad Astra] assinante falhou', e); }
    }
  }

  /** First boot after the update: move the v1 save into the auto slot (delete the old key only after the write). */
  function migrateLegacy() {
    const legacy = readRaw(LEGACY_SAVE_KEY);
    if (!legacy || readRaw(SAVE_KEY)) return;
    try {
      const s = deserialize(legacy, store.data);
      st.setItem(SAVE_KEY, serialize(s));
      if (readRaw(SAVE_KEY)) st.removeItem(LEGACY_SAVE_KEY);
    } catch (e) {
      const r = rejectionOf(e, legacy);
      try { st.setItem('adastra.save.backup.v1', legacy); } catch { /* */ }
      store.saveError = r.message;
      store.rejection = { ...r, slot: 'legacy' };
    }
  }
  migrateLegacy();

  return store;
}

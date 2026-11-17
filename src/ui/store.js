// UI store: wraps the engine (state + dispatch + query), autosave, settings and small UI memory
// (metric snapshots for trend arrows). DOM-free: localStorage/navigator are guarded so it runs in Node.

import {
  newGame as engineNewGame, dispatch as engineDispatch, query as engineQuery,
  serialize, deserialize, isBlocked,
} from '../core/engine.js';

export const SAVE_KEY = 'adastra.save.v1';
export const SETTINGS_KEY = 'adastra.settings';
export const METRICS_KEY = 'adastra.metrics.v1';

function prefersReducedMotion() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export const DEFAULT_SETTINGS = {
  sound: true,
  vibrate: true,
  reduceMotion: false,
  textScale: 1,      // 1 | 1.15 | 1.3
  colorblind: false,
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

/**
 * createStore(data, {storage}) -> store (see ARCHITECTURE.md "UI").
 * `data` is the loaded game data (loadData(browserReader())).
 */
export function createStore(data, { storage } = {}) {
  const st = storage || defaultStorage() || memoryStorage();
  const subs = new Set();

  const readJSON = (k, fb) => { try { const v = st.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const writeJSON = (k, v) => { try { st.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

  const store = {
    data,
    state: null,
    settings: { ...DEFAULT_SETTINGS, reduceMotion: prefersReducedMotion(), ...readJSON(SETTINGS_KEY, {}) },
    metrics: readJSON(METRICS_KEY, []), // [{turn, cash, support, ...}] last 40 turns seen
    lastAction: null,
    lastResult: null,
    saveError: null,

    dispatch(action) {
      if (!store.state) return { ok: false, error: 'nenhum jogo carregado' };
      let res;
      try {
        res = engineDispatch(store.state, data, action) || { ok: true };
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
      return engineQuery(store.state, data, name, ...args);
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

    newGame({ playerId, seed }) {
      const s = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : 1;
      store.state = engineNewGame(data, { seed: s, playerId });
      store.metrics = [];
      recordMetrics();
      store.save();
      notify({ type: 'ui/newGame' }, { ok: true });
      return store.state;
    },

    hasSave() {
      try { return !!st.getItem(SAVE_KEY); } catch { return false; }
    },

    /** Brief info about the save for the title screen (without loading it). */
    saveInfo() {
      try {
        const raw = st.getItem(SAVE_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return { playerId: s.playerId, turn: s.turn, startYear: s.startYear, gameOver: !!s.gameOver, seed: s.seed, actor: s.actors?.[s.playerId] || null };
      } catch { return null; }
    },

    load() {
      try {
        const raw = st.getItem(SAVE_KEY);
        if (!raw) return false;
        store.state = deserialize(raw);
        store.metrics = readJSON(METRICS_KEY, []);
        recordMetrics();
        notify({ type: 'ui/load' }, { ok: true });
        return true;
      } catch (e) {
        store.saveError = e?.message || String(e);
        return false;
      }
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

    deleteSave() {
      try { st.removeItem(SAVE_KEY); st.removeItem(METRICS_KEY); } catch { /* ignore */ }
      store.state = null;
      store.metrics = [];
      notify({ type: 'ui/deleteSave' }, { ok: true });
    },

    /** Export/import raw save text (settings screen). */
    exportSave() { return store.state ? serialize(store.state) : null; },
    importSave(text) {
      const s = deserialize(text); // throws on incompatible
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

    vibrate(pattern) {
      if (!store.settings.vibrate) return false;
      try { return !!globalThis.navigator?.vibrate?.(pattern); } catch { return false; }
    },

    player() {
      return store.state?.actors?.[store.state.playerId] || null;
    },

    blocked() {
      return store.state ? isBlocked(store.state) : null;
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

  return store;
}

// Dia de Lançamento — the emotional peak of Ad Astra ("torcer, não pilotar").
// The scene ONLY presents what src/sim/launch.js computes (state.activeLaunch). It never mutates state:
// every change goes through store.dispatch('launch/*'). Six acts:
//   1 prelaunch (lineup) · 2 countdown (control room) · 3 ascent (rocket, milestones as "goals")
//   4 interventions (5 s cards) · 5 climax (slow motion, radio silence) · 6 result (causes, headlines, replay)
// Phase 'arrival' reuses the same scene skinned as a lunar/Mars descent.
// Resilient: reopening mid-launch resumes the same act from state; missing fields never throw.

import { getAudio, unlockAudio } from './audio.js';
import { formatTurn, weeksToText } from '../core/time.js';

// ---------------------------------------------------------------- constants

export const STRATEGIES = [
  { id: 'conservative', label: 'Conservadora', hint: 'Mais margem, mais holds. Menos risco, menos ousadia.' },
  { id: 'balanced', label: 'Equilibrada', hint: 'O plano padrão da sala de controle.' },
  { id: 'aggressive', label: 'Agressiva', hint: 'Prazo acima de tudo. Mais risco, mais glória.' },
];

export const OUTCOME_INFO = {
  total: { label: 'Sucesso total', tone: 'ok', glyph: '★', line: 'Missão cumprida. A sala de controle explode.' },
  partial: { label: 'Sucesso parcial', tone: 'warn', glyph: '◐', line: 'Chegamos, mas não como planejado.' },
  recoverable: { label: 'Falha recuperável', tone: 'bad', glyph: '▲', line: 'A missão se perdeu. Ainda dá para aprender.' },
  catastrophic: { label: 'Falha catastrófica', tone: 'dead', glyph: '✕', line: 'Silêncio na sala. Ninguém se mexe.' },
};

const CAUSE_KIND = { part: 'Peça', decision: 'Decisão', luck: 'Sorte', environment: 'Ambiente', crew: 'Equipe' };
const FAILURE_LABELS = { propulsion: 'Propulsão', structure: 'Estrutura', software: 'Software', human: 'Fator humano', environment: 'Ambiente' };

// default animation times (s) and telemetry keyframes for standard ascent milestones
const ASCENT_T = { ignition: 2, liftoff: 5, maxq: 16, staging: 29, fairing_or_les: 39, orbit: 54, tli: 68 };
// real mission elapsed time (s) at each standard milestone: the HUD clock runs on this scale, the same one the
// sim's TLM radio lines use ("TLM T+3:30 · alt 110 km"), while the animation itself stays compressed
const ASCENT_MET = { ignition: 0, liftoff: 3, maxq: 72, staging: 160, fairing_or_les: 210, orbit: 530, tli: 3900 };
const ASCENT_KEYS = {
  ignition: [0, 0], liftoff: [0.06, 0.02], maxq: [12, 0.45], staging: [68, 2.4],
  fairing_or_les: [115, 3.4], orbit: [200, 7.8], tli: [240, 10.9],
};
const MIN_GAP = 4;          // s between milestones, so radio lines are readable
const MAX_DURATION = 85;    // s of ascent animation at 1x
const COUNT_FROM = 30;      // T-minus at which the visible countdown starts
const HOLD_AT = 20;         // built-in hold point where pendingHold cards appear
const CLIMAX_PRE = 3.2;     // s of slow motion + silence before the final milestone is rolled

// ---------------------------------------------------------------- pure helpers (tested in Node)

/** 0..1 or 0..100 -> 0..100 (null if missing). */
/** "Risco à tripulação ~2%" (small risks keep a decimal: "~0,4%", "<0,1%"). */
export function crewRiskText(x) {
  const v = Math.max(0, Math.min(1, Number(x) || 0)) * 100;
  const s = v < 0.1 ? '<0,1%' : v < 10 ? `~${(Math.round(v * 10) / 10).toString().replace('.', ',')}%` : `~${Math.round(v)}%`;
  return `Risco à tripulação ${s}`;
}

export function toPct(x) {
  if (x == null || !Number.isFinite(Number(x))) return null;
  const v = Number(x);
  return Math.max(0, Math.min(100, Math.abs(v) <= 1.0001 ? v * 100 : v));
}

/** Estimated chance as a band: "62–78%". */
export function formatBand(est) {
  const p = toPct(est?.p);
  let lo = toPct(est?.low);
  let hi = toPct(est?.high);
  if (lo == null && hi == null) {
    if (p == null) return '—';
    lo = p - 8; hi = p + 8;
  }
  lo = Math.round(Math.max(0, lo ?? hi));
  hi = Math.round(Math.min(100, hi ?? lo));
  if (lo > hi) [lo, hi] = [hi, lo];
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

/** Factor delta (fraction or points) -> "+4 pts" / "−2 pts". */
export function formatDelta(d) {
  const n = Number(d);
  if (!Number.isFinite(n) || n === 0) return '±0';
  const pts = Math.abs(n) <= 1 ? n * 100 : n;
  const r = Math.abs(pts) < 1 ? pts.toFixed(1).replace('.', ',') : String(Math.round(pts));
  return `${pts > 0 ? '+' : '−'}${r.replace('-', '')} pts`;
}

/** Which UI view to show for a stored activeLaunch (resume from the same act). */
export function viewForAct(al) {
  if (!al) return null;
  const act = al.act || 'prelaunch';
  if (act === 'result') return 'result';
  if (act === 'climax') return 'climax';
  if (al.outcome) return 'result';
  if (act === 'ascent') return 'ascent';
  if (act === 'countdown') return (al.current || 0) > 0 ? 'ascent' : 'countdown';
  return 'prelaunch';
}

/** Trigger time (s) of each milestone: uses m.t when present, with minimum spacing and a total cap. */
export function milestoneTimes(milestones, phase = 'ascent') {
  const ms = Array.isArray(milestones) ? milestones : [];
  const raw = [];
  let prev = 0;
  ms.forEach((m, i) => {
    let t = Number(m?.t);
    if (!Number.isFinite(t)) t = phase === 'ascent' && ASCENT_T[m?.id] != null ? ASCENT_T[m.id] : (i === 0 ? 3 : prev + 11);
    raw.push(t);
    prev = t;
  });
  const last = raw.length ? Math.max(...raw) : 0;
  const scale = last > MAX_DURATION ? MAX_DURATION / last : 1;
  const out = [];
  raw.forEach((t, i) => {
    let v = Math.max(1.5, t * scale);
    if (i > 0) v = Math.max(v, out[i - 1] + MIN_GAP);
    out.push(v);
  });
  return out;
}

/** Telemetry keyframes [{t, alt km, vel km/s}] for the animation clock. */
export function buildProfile(milestones, phase = 'ascent', body = 'moon', kind = 'landing') {
  const ms = Array.isArray(milestones) ? milestones : [];
  const times = milestoneTimes(ms, phase);
  const n = ms.length;
  const keys = [];
  if (phase === 'arrival') {
    const orbit = kind === 'orbit';
    const A0 = orbit ? 3000 : body === 'mars' || body === 'titan' ? 125 : body === 'earth' ? 120 : 100;
    const V0 = orbit ? 2.6 : body === 'mars' ? 5.8 : body === 'earth' ? 11 : body === 'titan' ? 6 : 1.7;
    keys.push({ t: 0, alt: A0 * 1.15, vel: V0 * 1.02 });
    ms.forEach((m, i) => {
      const f = n > 1 ? i / (n - 1) : 1;
      const lastOne = i === n - 1;
      if (orbit) keys.push({ t: times[i], alt: A0 * (1 - 0.93 * f), vel: V0 * (1 - 0.35 * f) });
      // the touchdown milestone is rolled (and its intervention card shown) a few metres up: the lander
      // touches the ground after it, not while "Poeira cegando as câmeras" is still on screen
      else keys.push({ t: times[i], alt: lastOne ? 0.03 : A0 * Math.pow(1 - f, 2.2), vel: lastOne ? 0.002 : V0 * Math.pow(1 - f, 1.4) + 0.002 });
    });
    if (!orbit && n) keys.push({ t: times[n - 1] + 3, alt: 0, vel: 0.001 });
    keys.forEach((k) => { k.met = k.t; }); // no published timeline for arrivals: the clock is the scene's
  } else {
    keys.push({ t: 0, alt: 0, vel: 0, met: 0 });
    ms.forEach((m, i) => {
      const f = n > 1 ? (i + 1) / n : 1;
      const k = ASCENT_KEYS[m?.id] || [200 * Math.pow(f, 1.5), 7.8 * Math.pow(f, 1.2)];
      const prevK = keys[keys.length - 1];
      const met = Math.max(prevK.met, ASCENT_MET[m?.id] ?? prevK.met + (times[i] - prevK.t) * 8);
      keys.push({ t: times[i], alt: Math.max(prevK.alt, k[0]), vel: Math.max(prevK.vel, k[1]), met });
    });
  }
  return { keys, times };
}

/** Interpolated {alt, vel} at clock t. */
export function telemetryAt(profile, t) {
  const keys = profile?.keys || [];
  if (!keys.length) return { alt: 0, vel: 0 };
  if (t <= keys[0].t) return { alt: keys[0].alt, vel: keys[0].vel };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const s = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      const e = s * s * (3 - 2 * s) * 0.5 + s * 0.5; // softened ease
      return { alt: a.alt + (b.alt - a.alt) * e, vel: a.vel + (b.vel - a.vel) * s };
    }
  }
  const l = keys[keys.length - 1];
  return { alt: l.alt, vel: l.vel };
}

/** Mission elapsed time (s) shown by the HUD at animation time t (see ASCENT_MET). */
export function metAt(profile, t) {
  const keys = profile?.keys || [];
  if (!keys.length || !Number.isFinite(keys[0].met)) return Math.max(0, t);
  if (t <= keys[0].t) return keys[0].met;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) return a.met + (b.met - a.met) * (b.t > a.t ? (t - a.t) / (b.t - a.t) : 1);
  }
  const l = keys[keys.length - 1];
  const p = keys[keys.length - 2];
  const rate = p && l.t > p.t ? (l.met - p.met) / (l.t - p.t) : 1;
  return l.met + (t - l.t) * Math.max(1, rate);
}

/** True when no more milestones will be rolled in this scene. */
export function isEnded(al) {
  if (!al) return true;
  const ms = al.milestones || [];
  if (al.act === 'climax' || al.act === 'result' || al.outcome) return true;
  if (ms.length === 0) return true;
  if ((al.current || 0) >= ms.length) return true;
  return ms.slice(0, al.current || 0).some((m) => m?.status === 'fail');
}

/** Presentation-only fallback when the sim did not fill an outcome (never decides anything persistent). */
export function fallbackOutcome(al) {
  const ms = al?.milestones || [];
  const aborted = (al?.interventions || []).some((x) => x?.optionId === 'abort');
  const failed = ms.some((m) => m?.status === 'fail');
  const anomalies = ms.filter((m) => m?.status === 'anomaly').length;
  const level = failed ? (aborted ? 'recoverable' : 'catastrophic') : anomalies ? 'partial' : 'total';
  return { level, failureType: null, causes: [], headline: '', crewLost: [] };
}

/** "02:14" style mission clock (T+). */
export function fmtClock(s) {
  const v = Math.max(0, Math.floor(s));
  const mm = `${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return v >= 3600 ? `${Math.floor(v / 3600)}:${mm}` : `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/** Numbers with a pt-BR comma. */
export function fmtNum(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits).replace('.', ',');
}

// ---------------------------------------------------------------- small DOM helpers

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** Null-safe append (DOM append would print "null"). */
function put(parent, ...kids) {
  parent.append(...kids.flat().filter((k) => k != null && k !== false));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// portrait.js (ui-shell) is loaded dynamically so a missing/partial module never breaks the scene
let portraitFn = null;
let portraitTried = false;
function ensurePortrait(onReady) {
  if (portraitTried) return;
  portraitTried = true;
  import('./portrait.js')
    .then((m) => { if (typeof m?.portraitSVG === 'function') { portraitFn = m.portraitSVG; onReady?.(); } })
    .catch(() => {});
}

/** Portrait SVG string for a person, with a flat fallback (initials) if portrait.js is unavailable. */
function portraitOf(person, size = 56, mood = 'neutral') {
  if (person && portraitFn && person.portrait) {
    try {
      const s = portraitFn(person.portrait, { size, mood });
      if (typeof s === 'string' && s.includes('<svg')) return s;
    } catch { /* fall through */ }
  }
  const name = person?.name || '?';
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const hues = ['#ff6b35', '#2ec4b6', '#ffb703', '#8ecae6', '#e76f51', '#a8dadc'];
  const bg = hues[hashStr(person?.id || name) % hues.length];
  const mouth = mood === 'happy' ? 'M19 37 Q28 44 37 37' : mood === 'sad' ? 'M20 41 Q28 35 36 41' : mood === 'tense' ? 'M20 39 L36 39' : 'M20 38 Q28 41 36 38';
  return `<svg viewBox="0 0 56 56" width="${size}" height="${size}" aria-hidden="true"><rect width="56" height="56" rx="10" fill="${bg}"/>` +
    `<circle cx="28" cy="25" r="13" fill="#f3e9d2"/><rect x="12" y="42" width="32" height="14" rx="7" fill="#13204a"/>` +
    `<circle cx="23" cy="24" r="1.8" fill="#0b1020"/><circle cx="33" cy="24" r="1.8" fill="#0b1020"/>` +
    `<path d="${mouth}" transform="translate(0,-8)" stroke="#0b1020" stroke-width="2" fill="none" stroke-linecap="round"/>` +
    `<text x="28" y="53" font-size="8" text-anchor="middle" fill="#f3e9d2" font-family="system-ui">${esc(initials)}</text></svg>`;
}

// ---------------------------------------------------------------- store reading (all guarded)

function safeQuery(store, name, ...args) {
  try { return store.query?.(name, ...args); } catch { return undefined; }
}

function getMission(store, id) {
  const q = safeQuery(store, 'missions/get', id);
  if (q && typeof q === 'object') return q;
  return (store.state?.missions || []).find((m) => m?.id === id) || null;
}

function allCrew(store) {
  const st = store.state || {};
  let list = safeQuery(store, 'crew/roster');
  if (list && !Array.isArray(list) && typeof list === 'object') list = Array.isArray(list.active) ? list.active : Object.values(list).flat();
  if (!Array.isArray(list) || !list.length) list = Object.values(st.crew || {});
  return list.filter((p) => p && typeof p === 'object' && p.id);
}

function crewFor(store, role) {
  const pid = store.state?.playerId;
  return allCrew(store).filter((p) => p.role === role && (p.status || 'active') === 'active' && (!p.actorId || p.actorId === pid));
}

function person(store, id) {
  if (!id) return null;
  return store.state?.crew?.[id] || allCrew(store).find((p) => p.id === id) || null;
}

function traitNames(store, p) {
  const defs = store.data?.crew?.traits || [];
  return (p?.traits || []).map((t) => defs.find((d) => d.id === t)?.name || t).slice(0, 2);
}

// ---------------------------------------------------------------- the renderer (loaded on demand)
// src/ui/launch-render is imported dynamically: a broken or missing renderer module must never take the whole
// Launch Day scene down (the scene falls back to a plain sky until the module is there).
let renderMod = null;
let renderLoad = null;
function loadRenderer() {
  if (!renderLoad) {
    renderLoad = import('./launch-render/index.js')
      .then((m) => {
        if (typeof m?.createLaunchRenderer !== 'function') throw new Error('launch-render sem createLaunchRenderer');
        renderMod = m;
        try { m.loadVehicleArt?.()?.catch?.(() => {}); } catch { /* art falls back to families */ }
        return m;
      })
      .catch((e) => { console.error('launch-render indisponível:', e); renderLoad = null; return null; }); // next scene retries
  }
  return renderLoad;
}

// ---------------------------------------------------------------- the scene

let activeScene = null;

/**
 * Open the Launch Day overlay for state.activeLaunch. Returns close().
 * Calling again while open for the same launch returns the existing close (app.js may call it on every render).
 */
export function openLaunchScene(store) {
  const al = store?.state?.activeLaunch;
  if (!store || !al || typeof document === 'undefined') return () => {};
  const key = `${al.missionId}|${al.phase || 'ascent'}`;
  if (activeScene && activeScene.alive() && activeScene.key === key) return activeScene.close;
  if (activeScene) (activeScene.forceClose || activeScene.close)();
  loadRenderer();
  try {
    activeScene = createScene(store, key);
  } catch (e) {
    console.error('launch-scene:', e);
    return () => {};
  }
  return activeScene.close;
}

function createScene(store, key) {
  const audio = getAudio(store);
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduce = () => !!(store.settings?.reduceMotion || mq?.matches);
  const vibrate = (pattern) => {
    try {
      if (typeof store.vibrate === 'function') store.vibrate(pattern);
      else if (store.settings?.vibrate !== false) navigator.vibrate?.(pattern);
    } catch { /* ignore */ }
  };
  const AL = () => store.state?.activeLaunch || null;
  const al0 = AL();
  const phase = al0.phase === 'arrival' ? 'arrival' : 'ascent';
  const mission = getMission(store, al0.missionId) || { id: al0.missionId, name: 'Missão' };
  const dIdx = store.data?.index || {};
  const dest = dIdx.destinations?.[mission.destination] || null;
  const body = dest?.body || (/mars/.test(mission.destination || '') ? 'mars' : /lunar|moon/.test(mission.destination || '') ? 'moon' : 'earth');
  const vehicle = dIdx.vehicles?.[mission.vehicleId] || null;
  const craft = dIdx.spacecraft?.[mission.spacecraftId] || null;
  const actor = store.state?.actors?.[store.state?.playerId] || null;
  const lastMsId = String((al0.milestones || []).slice(-1)[0]?.id || '');
  const arrivalKind = phase !== 'arrival' ? null : /touch|land|pouso|splash/.test(lastMsId) ? 'landing' : 'orbit';
  // the "world" drawn under the vehicle (a cislunar return ends in Earth's ocean)
  const world = /splash/.test(lastMsId) ? 'earth' : mission.destination === 'titan' ? 'titan' : body;
  const crewed = typeof al0.crewed === 'boolean' ? al0.crewed : mission.type === 'crewed' || (craft?.crew || 0) > 0 || (mission.crew?.astronauts?.length || 0) > 0 || !!al0.lineup?.commander;
  const T = phase === 'arrival'
    ? (arrivalKind === 'landing'
      ? { pre: 'Preparação da descida', start: 'Iniciar descida', cd: 'Ignição de descida em', scene: 'Chegada' }
      : { pre: 'Preparação da chegada', start: 'Iniciar aproximação', cd: 'Queima de inserção em', scene: 'Chegada' })
    : { pre: 'Pré-lançamento · a escalação', start: 'Iniciar contagem', cd: 'Lançamento em', scene: 'Dia de Lançamento' };

  // theme colours (CSS vars of styles.css when present)
  const css = getComputedStyle(document.body);
  const cv = (name, fb) => (css.getPropertyValue(name) || '').trim() || fb;
  const PAL = {
    bg: cv('--bg', '#0b1020'), fg: cv('--fg', '#f3e9d2'), accent: cv('--accent', '#ff6b35'),
    teal: cv('--accent-2', '#2ec4b6'), amber: cv('--warn', '#ffb703'), red: cv('--danger', '#e63946'),
    navy: '#13204a', steel: '#8a94a6', cream: '#f3e9d2', flag: actor?.color || '#2ec4b6',
  };

  // ---------- scene state (UI only; never persisted)
  const S = {
    alive: true, view: null, clock: 0, speed: 1, timeScale: 1, presented: 0,
    profile: buildProfile(al0.milestones, phase, world, arrivalKind), frozen: false,
    cd: COUNT_FROM, lastBeep: null, holdShown: null, ivShown: null, ivLeft: 0, ivTotal: 5,
    climaxPre: null, climaxDone: false, endTimer: 0, cTimer: 0, stepCooldown: 0, stepFails: 0,
    staged: false, fairingOff: false, engineOn: false, exploded: false, escaped: null, landed: false,
    shake: 0, flash: 0, flashColor: '#fff', particles: [], debris: [], prevAlt: 0, logSeen: (al0.log || []).length,
    radioQ: [], radioTimer: 0, mood: 'neutral', moodTimer: 0, replay: null, resultFx: null, last: 0, hudTimer: 0,
    W: 0, H: 0, dpr: 1, t: 0, finishing: false,
  };

  // ---------- DOM
  const root = document.getElementById('overlay-root') || document.body;
  const ov = el('div', { class: 'ls-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': T.scene, 'data-phase': phase, 'data-body': body });
  const soundBtn = el('button', { class: 'ls-iconbtn', type: 'button', 'aria-label': 'Som', onclick: () => toggleSound() });
  const speedBtn = el('button', { class: 'ls-iconbtn ls-speed', type: 'button', 'aria-label': 'Velocidade da animação', onclick: () => cycleSpeed() }, '1×');
  const head = el('header', { class: 'ls-head' },
    el('div', { class: 'ls-head-txt' },
      el('div', { class: 'ls-kicker' }, phase === 'arrival' ? `Chegada · ${dest?.name || ''}` : T.scene),
      el('div', { class: 'ls-title' }, mission.name || al0.name || 'Missão'),
      el('div', { class: 'ls-sub' }, [vehicle?.name || al0.vehicleName, craft?.name, dest?.name || al0.destName].filter(Boolean).join(' · '))),
    el('div', { class: 'ls-head-btns' }, speedBtn, soundBtn));
  const track = el('div', { class: 'ls-track', role: 'list', 'aria-label': 'Marcos' });
  const canvas = el('canvas', { class: 'ls-canvas', 'aria-hidden': 'true' });
  const hud = el('div', { class: 'ls-hud' });
  const countEl = el('div', { class: 'ls-count', 'aria-live': 'off' });
  const stamp = el('div', { class: 'ls-stamp', 'aria-hidden': 'true' });
  const silenceEl = el('div', { class: 'ls-silence' }, 'silêncio no rádio');
  const stage = el('div', { class: 'ls-stage' }, canvas, hud, countEl, stamp, silenceEl);
  const team = el('div', { class: 'ls-team', 'aria-label': 'Sala de controle' });
  const radio = el('div', { class: 'ls-radio', 'aria-live': 'polite', role: 'log' });
  const panel = el('div', { class: 'ls-panel' });
  const sheet = el('div', { class: 'ls-sheet', role: 'alertdialog', 'aria-live': 'assertive' });
  ov.append(head, track, stage, team, radio, panel, sheet);
  root.append(ov);
  requestAnimationFrame(() => ov.classList.add('ls-in'));
  const g = canvas.getContext('2d');

  // ---------- lifecycle
  let raf = 0;
  const onResize = () => resize();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  ro?.observe(stage);
  window.addEventListener('resize', onResize);
  const onVis = () => { S.last = 0; };
  document.addEventListener('visibilitychange', onVis);
  const onGesture = () => unlockAudio();
  ov.addEventListener('pointerdown', onGesture, { passive: true });
  const unsub = typeof store.subscribe === 'function' ? store.subscribe(() => onStore()) : null;

  function close() {
    if (!S.alive) return;
    S.alive = false;
    cancelAnimationFrame(raf);
    try { unsub?.(); } catch { /* ok */ }
    ro?.disconnect();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    audio.stopAll();
    ov.classList.remove('ls-in');
    ov.classList.add('ls-out');
    setTimeout(() => ov.remove(), 350);
    if (activeScene && activeScene.forceClose === close) activeScene = null;
  }

  function onStore() {
    if (!S.alive) return;
    const al = AL();
    if (!al) { gone(); return; }
    if (`${al.missionId}|${al.phase || 'ascent'}` !== key) { close(); return; }
    if (S.view === 'prelaunch') refreshPrelaunch();
  }

  /** activeLaunch disappeared (scrub, finish, or another module): close gracefully. */
  function gone() {
    if (S.finishing && !S.holdPending) { close(); return; }
    S.finishing = true;
    // our own hold/scrub choice: chooseHold shows a card with the reason and the new date, closed by the player
    if (S.holdPending) { S.awaitingAck = true; return; }
    const info = scrubInfo();
    showStamp('ADIADO', info.when ? `Nova data: ${info.when}` : 'Nova data em breve', 'warn');
    caption(info.when ? `Adiado ${info.wait}. Nova data: ${info.when}.` : 'Adiado. A nova data sai no painel.', 'event');
    setTimeout(close, 1600);
  }

  /** New date of this phase after a postpone: { when: 'mai/2026', wait: 'em 2 semanas' } (or nulls). */
  function scrubInfo() {
    const st = store.state || {};
    const m = (st.missions || []).find((x) => x?.id === mission.id) || null;
    const t = phase === 'arrival' ? m?.transit?.arriveTurn : m?.launchTurn;
    if (!Number.isFinite(t)) return { when: null, wait: null };
    const d = Math.max(0, Math.round(t - (st.turn ?? 0)));
    return { when: formatTurn(t, st.startYear ?? 2026), wait: d > 0 ? `em ${weeksToText(d)}` : 'para esta semana', weeks: d };
  }

  /** Card after a hold that ended the day: why, the new date, what it cost, and an OK the player taps. */
  function showScrubCard(r, choice, hold) {
    const info = scrubInfo();
    const weeks = Number(r?.weeks) || info.weeks || null;
    const reason = r?.windowClosed ? 'A janela do dia fechou enquanto a equipe esperava.'
      : choice === 'scrub' ? (hold?.reason === 'weather' ? 'Você adiou por causa do clima.' : 'Você adiou para verificar o sensor.')
        : 'A contagem não pôde continuar hoje.';
    const cost = choice === 'scrub' ? 'Apoio interno −1 (a imprensa nota cada adiamento).' : 'Sem custo de apoio: quem fechou a janela foi o tempo.';
    showStamp('ADIADO', info.when ? `Nova data: ${info.when}` : 'Nova data em breve', 'warn');
    caption(r?.windowClosed ? 'Janela fechada. Desmobilizando a plataforma.' : 'Contagem encerrada por hoje.', 'event');
    sheet.innerHTML = '';
    put(sheet,
      el('div', { class: 'ls-card-k' }, phase === 'arrival' ? 'Descida adiada' : 'Lançamento adiado'),
      el('div', { class: 'ls-card-t' }, reason),
      el('ul', { class: 'ls-scrub' },
        el('li', {}, info.when ? `Nova data: ${info.when}${weeks ? ` (${weeks} semana${weeks > 1 ? 's' : ''} depois)` : ''}.` : 'Nova data: no painel de missões.'),
        el('li', {}, cost),
        el('li', {}, 'A sorte dos marcos fica a mesma: só o dia muda.')),
      el('div', { class: 'ls-cta' }, el('button', { class: 'ls-btn ls-primary', type: 'button', onclick: () => { S.awaitingAck = false; close(); } }, 'Entendido')));
    sheet.classList.add('open');
    sheet.querySelector('.ls-btn')?.focus?.({ preventScroll: true });
  }

  function dispatch(action) {
    let r;
    try { r = store.dispatch(action); } catch (e) { r = { ok: false, error: e?.message }; }
    return r || { ok: false };
  }

  // ---------- settings buttons
  function soundLabel() {
    const on = store.settings?.sound !== false;
    soundBtn.textContent = on ? '♪' : '♪̸';
    soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    soundBtn.title = on ? 'Som ligado' : 'Som desligado';
  }
  function toggleSound() {
    const on = store.settings?.sound !== false;
    try { store.setSettings?.({ sound: !on }); } catch { /* ok */ }
    unlockAudio();
    audio.sync();
    soundLabel();
  }
  function cycleSpeed() {
    S.speed = S.speed === 1 ? 2 : S.speed === 2 ? 4 : 1;
    speedBtn.textContent = `${S.speed}×`;
  }
  soundLabel();

  // ---------- canvas sizing
  function resize() {
    const r = stage.getBoundingClientRect();
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    S.W = Math.max(1, Math.round(r.width));
    S.H = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(S.W * S.dpr);
    canvas.height = Math.round(S.H * S.dpr);
    // resizing clears the canvas: repaint now so a layout change (radio lines, sheets) never flashes black
    if (S.view && S.ready) { try { draw(0); } catch { /* next frame repaints */ } }
  }

  // ---------- milestone track (also the result's timeline strip)
  function renderTrack(interactive = false) {
    const al = AL();
    const ms = al?.milestones || [];
    track.innerHTML = '';
    ms.forEach((m, i) => {
      let st = i < S.presented || S.view === 'result' ? (m.status || 'pending') : 'pending';
      if (al?.pendingIntervention && i === (al.current || 0)) st = 'anomaly';
      const cur = i === (al?.current || 0) && S.view !== 'result';
      const iv = (al?.interventions || []).find((x) => x.milestoneId === m.id);
      const pill = el(interactive ? 'button' : 'div', {
        class: `ls-pill is-${st}${cur ? ' is-current' : ''}${iv ? ' has-iv' : ''}`, role: 'listitem', type: interactive ? 'button' : null,
        'aria-label': `${m.label || m.id}: ${statusText(st)}`,
        onclick: interactive ? () => showMilestoneDetail(m) : null,
      }, el('span', { class: 'ls-pill-dot', 'aria-hidden': 'true' }), el('span', { class: 'ls-pill-txt' }, m.label || m.id));
      track.append(pill);
    });
  }
  function statusText(st) {
    return { ok: 'ok', anomaly: 'anomalia', fail: 'falha', pending: 'pendente' }[st] || st;
  }
  function showMilestoneDetail(m) {
    const lines = (m.radio || []).slice(0, 4);
    const iv = (AL()?.interventions || []).find((x) => x.milestoneId === m.id);
    const box = panel.querySelector('.ls-tl-detail');
    if (!box) return;
    box.innerHTML = '';
    box.append(el('strong', {}, `${m.label || m.id} — ${statusText(m.status)}`));
    if (iv) box.append(el('div', { class: 'ls-tl-iv' }, `Intervenção: ${ivLabel(iv)}`));
    for (const l of lines) box.append(el('div', { class: 'ls-tl-line' }, `“${l}”`));
    if (!lines.length && !iv) box.append(el('div', { class: 'ls-tl-line' }, 'Sem registro de rádio.'));
  }
  /** pt-BR name of an intervention choice (record or id); never the raw id. */
  const ivLabel = (x) => {
    const id = typeof x === 'string' ? x : x?.optionId;
    const name = {
      reduce: phase === 'arrival' ? (arrivalKind === 'landing' ? 'descida mais lenta' : 'queima mais suave') : 'reduzir empuxo', maintain: 'manter', contingency: 'contingência',
      abort: phase === 'arrival' ? (crewed && arrivalKind === 'landing' ? 'abortar pouso' : 'abortar e preservar') : 'abortar', timeout: 'sem resposta',
    }[id] || 'outra';
    return x && typeof x === 'object' && x.timeout ? `${name} (sem resposta)` : name;
  };

  // ---------- team strip (control room faces)
  function teamMembers() {
    const al = AL();
    const lu = al?.lineup || {};
    const out = [];
    const fd = person(store, lu.flightDirector || mission.crew?.flightDirector);
    if (fd) out.push({ p: fd, role: fd.gender === 'f' ? 'Diretora de voo' : 'Diretor de voo' });
    const cmd = person(store, lu.commander || mission.crew?.commander);
    if (cmd) out.push({ p: cmd, role: 'Comandante' });
    for (const id of mission.crew?.astronauts || []) {
      if (out.length >= 5) break;
      if (cmd && id === cmd.id) continue;
      const a = person(store, id);
      if (a) out.push({ p: a, role: 'Astronauta' });
    }
    for (const e of crewFor(store, 'engineer')) {
      if (out.length >= 5) break;
      out.push({ p: e, role: 'Engenharia' });
    }
    return out;
  }
  function renderTeam() {
    const mood = S.mood;
    team.innerHTML = '';
    const members = teamMembers();
    if (!members.length) {
      team.append(el('div', { class: 'ls-team-empty' }, 'Sala de controle: equipe de plantão'));
      return;
    }
    for (const { p, role } of members) {
      team.append(el('figure', { class: `ls-face mood-${mood}` },
        el('div', { class: 'ls-face-img', html: portraitOf(p, 52, mood) }),
        el('figcaption', {}, el('b', {}, (p.name || '').split(' ')[0]), el('span', {}, role))));
    }
  }
  function setMood(m, secs = 0) {
    if (S.mood === m) { S.moodTimer = secs; return; }
    S.mood = m;
    S.moodTimer = secs;
    renderTeam();
  }
  ensurePortrait(() => { if (S.alive) { renderTeam(); if (S.view === 'prelaunch') refreshPrelaunch(true); } });

  // ---------- radio / captions
  function caption(text, kind = 'radio') {
    if (!text) return;
    const line = el('div', { class: `ls-line k-${kind}` }, text);
    radio.append(line);
    while (radio.children.length > 4) radio.firstChild.remove();
  }
  function queueRadio(lines) {
    for (const l of lines || []) if (l) S.radioQ.push({ text: String(l), kind: 'radio' });
  }
  function pumpRadio(dt) {
    if (S.view === 'climax' || S.climaxPre) return; // radio silence
    S.radioTimer -= dt;
    if (S.radioTimer <= 0 && S.radioQ.length) {
      const item = S.radioQ.shift();
      caption(item.text, item.kind);
      if (item.kind === 'radio') audio.radio();
      S.radioTimer = 1.1;
    }
  }
  /** New sim log lines since last look (deduped against milestone radio lines already queued). */
  function drainLog(skip = []) {
    const log = AL()?.log || [];
    const fresh = log.slice(S.logSeen);
    S.logSeen = log.length;
    const known = new Set(skip.map(String));
    for (const e of fresh) {
      const txt = typeof e === 'string' ? e : e?.text;
      if (!txt || known.has(txt)) continue;
      S.radioQ.push({ text: txt, kind: e?.kind === 'telemetry' || e?.kind === 'event' ? e.kind : 'radio' });
    }
  }

  // ---------- big stamp ("gol" moments)
  function showStamp(title, sub, tone = 'ok') {
    stamp.className = `ls-stamp tone-${tone}`;
    stamp.innerHTML = `<div class="ls-stamp-t">${esc(title)}</div>${sub ? `<div class="ls-stamp-s">${esc(sub)}</div>` : ''}`;
    void stamp.offsetWidth; // restart CSS animation
    stamp.classList.add('show');
  }

  // ================================================================ ACT 1: prelaunch
  function enterPrelaunch() {
    S.view = 'prelaunch';
    S.logSeen = 0; // the intro radio lines play once the countdown starts
    ov.dataset.view = 'prelaunch';
    sheet.innerHTML = '';
    sheet.classList.remove('open');
    panel.innerHTML = '';
    put(panel,
      el('h2', { class: 'ls-h2' }, T.pre),
      el('section', { class: 'ls-sec ls-est' }),
      el('section', { class: 'ls-sec ls-lineup' }),
      el('section', { class: 'ls-sec ls-strat' }),
      el('section', { class: 'ls-sec ls-fuel' }),
      el('div', { class: 'ls-cta' },
        el('button', { class: 'ls-btn ls-primary', type: 'button', onclick: startCountdown }, T.start)),
    );
    refreshPrelaunch(true);
    caption(phase === 'arrival' ? 'Sala de controle reunida. A nave aguarda o comando de descida.' : 'Equipe no console. O foguete está abastecendo.', 'event');
  }

  function refreshPrelaunch(full = false) {
    const al = AL();
    if (!al) return;
    renderEstimate(panel.querySelector('.ls-est'), al);
    if (full) {
      renderLineup(panel.querySelector('.ls-lineup'), al);
      renderStrategy(panel.querySelector('.ls-strat'), al);
      renderFuel(panel.querySelector('.ls-fuel'), al);
    } else {
      // keep the slider intact during drags; update selections only
      panel.querySelectorAll('[data-pick]').forEach((b) => {
        const [field, id] = b.dataset.pick.split(':');
        b.classList.toggle('is-on', (al.lineup?.[field] || '') === id);
        b.setAttribute('aria-pressed', (al.lineup?.[field] || '') === id ? 'true' : 'false');
      });
    }
  }

  function renderEstimate(box, al) {
    if (!box) return;
    const est = al.estimate || mission.estimate || {};
    const lo = toPct(est.low) ?? (toPct(est.p) ?? 50) - 8;
    const hi = toPct(est.high) ?? (toPct(est.p) ?? 50) + 8;
    const p = toPct(est.p) ?? (lo + hi) / 2;
    // an arrival is decided after the rocket already flew: factors the sim tags as ascent-only do not apply
    const ascentOnly = (f) => phase === 'arrival' && Array.isArray(f.stages) && f.stages.length > 0 && f.stages.every((x) => x === 'asc');
    const factors = (est.factors || []).filter((f) => f && f.label && !ascentOnly(f)).slice().sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0)).slice(0, 7);
    const w = al.weather || {};
    const wRisk = toPct(w.risk);
    // crew-loss risk (launch.js: estimate.pCrewLoss, 0 for robotic flights); the chip replaces the sim's warning line
    const crewed = !!al.crewed && (al.crewIds || []).length > 0;
    const loss = Number(est.pCrewLoss);
    const crewRisk = crewed && Number.isFinite(loss) ? crewRiskText(loss) : null;
    const warnings = (est.warnings || []).filter((x) => !(crewRisk && /^Risco (estimado )?de perder a tripulação/.test(String(x))));
    const where = phase === 'arrival' ? 'na chegada' : 'nesta subida';
    box.innerHTML = '';
    put(box,
      el('div', { class: 'ls-band-head' },
        el('div', {}, el('div', { class: 'ls-label' }, 'Chance estimada'), el('div', { class: 'ls-band' }, formatBand(est))),
        el('div', { class: 'ls-chips' },
          w.label ? el('span', { class: `ls-chip${wRisk > 30 ? ' warn' : ''}` }, `Clima: ${w.label}`) : null,
          crewRisk ? el('span', { class: 'ls-chip warn ls-crewrisk', title: `Chance estimada de perder a tripulação ${where}` }, `⚠ ${crewRisk}`) : null,
          el('span', { class: 'ls-chip', title: 'Pontos de Comando: a reserva da agência recarrega 1 ponto a cada 4 semanas' },
            Number.isFinite(al.pool) && al.pool > (al.commandPoints ?? 0)
              ? `Comando: ${al.commandPoints ?? 0} (agência: ${al.pool})`
              : `Comando: ${al.commandPoints ?? store.state?.commandPoints ?? 0}`))),
      el('div', { class: 'ls-bandbar', role: 'img', 'aria-label': `Faixa de ${formatBand(est)}` },
        el('div', { class: 'ls-bandbar-fill', style: { left: `${Math.max(0, lo)}%`, width: `${Math.max(1, hi - lo)}%` } }),
        el('div', { class: 'ls-bandbar-p', style: { left: `${p}%` } })),
      el('p', { class: 'ls-note' }, 'Os engenheiros nunca têm certeza. Equipe e pesquisa melhores estreitam a faixa.'),
      factors.length ? el('ul', { class: 'ls-factors' }, factors.map((f) => el('li', { class: (f.delta || 0) >= 0 ? 'pos' : 'neg' },
        el('span', {}, f.label), el('b', {}, formatDelta(f.delta))))) : null,
      warnings.length ? el('div', { class: 'ls-warn' }, warnings.slice(0, 2).join(' · ')) : null,
    );
  }

  function pickCard(field, p, roleLabel, selected) {
    const on = selected === p.id;
    return el('button', {
      class: `ls-pick${on ? ' is-on' : ''}`, type: 'button', 'data-pick': `${field}:${p.id}`, 'aria-pressed': on ? 'true' : 'false',
      onclick: () => configure({ [field]: p.id }),
    },
    el('div', { class: 'ls-pick-img', html: portraitOf(p, 48) }),
    el('div', { class: 'ls-pick-txt' },
      el('b', {}, p.name || p.id),
      el('span', {}, `${roleLabel} · perícia ${Math.round(p.skill ?? 0)}`),
      el('div', { class: 'ls-skill' }, el('i', { style: { width: `${Math.max(0, Math.min(100, p.skill ?? 0))}%` } })),
      traitNames(store, p).length ? el('em', {}, traitNames(store, p).join(', ')) : null));
  }

  function renderLineup(box, al) {
    if (!box) return;
    const lu = al.lineup || {};
    box.innerHTML = '';
    const fds = crewFor(store, 'flight_director');
    box.append(el('div', { class: 'ls-label' }, 'Diretor de voo'));
    box.append(fds.length ? el('div', { class: 'ls-picks' }, fds.slice(0, 6).map((p) => pickCard('flightDirector', p, p.gender === 'f' ? 'Diretora' : 'Diretor', lu.flightDirector)))
      : el('p', { class: 'ls-note' }, 'Nenhum diretor de voo contratado. A sala segue com o plantão.'));
    if (crewed) {
      const assigned = (mission.crew?.astronauts || []).map((id) => person(store, id)).filter(Boolean);
      const pool = assigned.length ? assigned : crewFor(store, 'astronaut');
      box.append(el('div', { class: 'ls-label' }, 'Comandante'));
      box.append(pool.length ? el('div', { class: 'ls-picks' }, pool.slice(0, 6).map((p) => pickCard('commander', p, 'Astronauta', lu.commander)))
        : el('p', { class: 'ls-note' }, 'Sem astronautas disponíveis.'));
    }
  }

  function renderStrategy(box, al) {
    if (!box) return;
    const cur = al.lineup?.strategy || mission.config?.strategy || 'balanced';
    box.innerHTML = '';
    box.append(el('div', { class: 'ls-label' }, 'Estratégia'));
    const seg = el('div', { class: 'ls-seg', role: 'radiogroup', 'aria-label': 'Estratégia' });
    for (const s of STRATEGIES) {
      seg.append(el('button', {
        class: `ls-seg-b${cur === s.id ? ' is-on' : ''}`, type: 'button', role: 'radio', 'aria-checked': cur === s.id ? 'true' : 'false',
        'data-pick': `strategy:${s.id}`, onclick: () => { configure({ strategy: s.id }); renderStrategy(box, AL() || al); },
      }, s.label));
    }
    box.append(seg, el('p', { class: 'ls-note' }, STRATEGIES.find((s) => s.id === cur)?.hint || ''));
  }

  function renderFuel(box, al) {
    if (!box) return;
    const v = Number(al.lineup?.fuelMargin ?? mission.config?.fuelMargin ?? 0.1);
    const pct = Math.round((v <= 1 ? v * 100 : v));
    box.innerHTML = '';
    const val = el('b', {}, `${pct}%`);
    let timer = 0;
    const input = el('input', {
      type: 'range', min: '0', max: '30', step: '1', value: String(pct), class: 'ls-range', 'aria-label': 'Margem de combustível',
      oninput: (e) => {
        val.textContent = `${e.target.value}%`;
        clearTimeout(timer);
        timer = setTimeout(() => configure({ fuelMargin: Number(e.target.value) / 100 }), 140);
      },
      onchange: (e) => { clearTimeout(timer); configure({ fuelMargin: Number(e.target.value) / 100 }); },
    });
    box.append(el('div', { class: 'ls-label ls-row' }, el('span', {}, 'Margem de combustível'), val), input,
      el('p', { class: 'ls-note' }, phase === 'arrival'
        ? (arrivalKind === 'landing' ? 'Mais reserva dá tempo para corrigir a descida e escolher onde pousar.' : 'Mais reserva dá folga para corrigir a inserção na órbita.')
        : 'Mais margem perdoa erros na subida, mas tira carga útil.'));
  }

  function configure(patch) {
    const r = dispatch({ type: 'launch/configure', ...patch });
    if (!r.ok && r.error) caption(r.error, 'event');
    refreshPrelaunch();
    renderTeam();
  }

  function startCountdown() {
    unlockAudio();
    const r = dispatch({ type: 'launch/countdown' });
    if (!AL()) return; // scrubbed or closed
    if (!r.ok && r.error) caption(r.error, 'event');
    enterCountdown();
  }

  // ================================================================ ACT 2: countdown
  function enterCountdown() {
    S.view = 'countdown';
    ov.dataset.view = 'countdown';
    panel.innerHTML = '';
    S.cd = COUNT_FROM;
    S.lastBeep = null;
    setMood('tense');
    const w = AL()?.weather;
    caption(phase === 'arrival' ? 'Telemetria nominal. Iniciando sequência de descida.' : `Contagem iniciada.${w?.label ? ` Clima: ${w.label}.` : ''}`, 'event');
    renderTrack();
  }

  /** Countdown radio: log lines carry t (negative = T-minus), shown when the clock gets there. */
  function flushCountdownLog(al) {
    const log = al.log || [];
    while (S.logSeen < log.length) {
      const e = log[S.logSeen];
      const t = Number(e?.t);
      if (Number.isFinite(t) && t < 0 && S.cd > -t && !al.pendingHold) break;
      S.logSeen++;
      const txt = typeof e === 'string' ? e : e?.text;
      if (txt) S.radioQ.push({ text: txt, kind: e?.kind === 'event' || e?.kind === 'telemetry' ? e.kind : 'radio' });
    }
  }

  function updateCountdown(dt) {
    const al = AL();
    flushCountdownLog(al);
    if (al.pendingHold && S.cd <= HOLD_AT + 0.01) {
      S.cd = Math.min(S.cd, HOLD_AT);
      if (S.holdShown !== al.pendingHold) showHold(al.pendingHold);
      countEl.innerHTML = `<small>${esc(T.cd)}</small>T−${fmtClock(S.cd)}<em>CONTAGEM SUSPENSA</em>`;
      audio.tension(0.35);
      return;
    }
    if (S.holdShown && !al.pendingHold) closeSheet();
    const before = S.cd;
    S.cd = Math.max(0, S.cd - dt * S.speed);
    const sec = Math.ceil(S.cd);
    if (sec !== Math.ceil(before) && sec <= 10 && sec !== S.lastBeep) {
      S.lastBeep = sec;
      if (sec > 0) {
        audio.beep(sec <= 3 ? 'final' : 'tick');
        if (sec <= 5) caption(`T−${sec}`, 'telemetry');
        if (sec === 3 && phase === 'ascent') { caption('Sequência de ignição.', 'radio'); fire('ignition'); }
        if (sec <= 3) vibrate(20);
      }
    }
    audio.tension(0.15 + (1 - S.cd / COUNT_FROM) * 0.45);
    countEl.innerHTML = `<small>${esc(T.cd)}</small>T−${fmtClock(Math.ceil(S.cd))}`;
    if (S.cd <= 0) {
      audio.beep('go');
      vibrate([60, 30, 120]);
      startAscent();
    }
  }

  function showHold(hold) {
    S.holdShown = hold;
    sheet.innerHTML = '';
    const opts = (hold.options && hold.options.length ? hold.options : [
      { id: 'hold', label: 'Segurar', preview: 'Espera a janela melhorar.' },
      { id: 'scrub', label: 'Adiar', preview: 'Nova tentativa em 1–2 semanas.' },
      { id: 'go', label: 'Lançar assim mesmo', preview: 'Aceita o risco.' },
    ]);
    put(sheet,
      el('div', { class: 'ls-card-k' }, 'Contagem segurada'),
      el('div', { class: 'ls-card-t' }, holdText(hold)),
      el('div', { class: 'ls-opts' }, opts.map((o) => el('button', {
        class: `ls-opt${o.id === 'go' ? ' is-risk' : ''}`, type: 'button', disabled: o.disabled ? true : null,
        onclick: () => chooseHold(o.id),
      }, el('b', {}, o.label || o.id), o.preview ? el('span', {}, o.preview) : null))));
    sheet.classList.add('open');
    audio.alarm();
    vibrate([80, 40, 80]);
    caption(`Hold em T−${HOLD_AT}: ${holdText(hold)}`, 'event');
  }
  function holdText(hold) {
    if (hold?.text) return hold.text;
    if (hold?.reason === 'weather') return `Clima instável${AL()?.weather?.label ? `: ${AL().weather.label}` : ''}.`;
    if (hold?.reason === 'sensor' || !hold?.reason) return 'Um sensor acusou leitura fora da faixa.';
    return String(hold.reason);
  }

  function chooseHold(choice) {
    const hold = S.holdShown;
    closeSheet();
    S.holdPending = choice; // if this ends the day, gone() waits for the card below instead of vanishing
    const r = dispatch({ type: 'launch/hold', choice });
    S.holdPending = null;
    if (!AL()) {
      if (r?.ok && (r.scrubbed || S.awaitingAck)) showScrubCard(r, choice, hold);
      else close();
      return;
    }
    if (!r.ok && r.error) caption(r.error, 'event');
    if (choice === 'hold') { caption('Segurando. Reciclando para T−20.', 'radio'); S.cd = HOLD_AT - 0.01; }
    else if (choice === 'go') caption('Diretor de voo: “Seguimos. Retomar contagem.”', 'radio');
    S.holdShown = null;
    if (AL()?.pendingHold) S.cd = HOLD_AT; // the sim asked again
    else if (S.cd >= HOLD_AT) S.cd = HOLD_AT - 0.01;
  }

  function closeSheet() {
    sheet.classList.remove('open');
    S.holdShown = null;
  }

  // ================================================================ ACT 3/4: ascent + interventions
  function startAscent(resume = false) {
    const al = AL();
    S.view = 'ascent';
    ov.dataset.view = 'ascent';
    countEl.innerHTML = '';
    panel.innerHTML = '';
    S.profile = buildProfile(al.milestones, phase, world, arrivalKind);
    if (resume) {
      // resume from the stored point: no replay of milestones already rolled
      S.presented = Math.min(al.current || 0, (al.milestones || []).length);
      S.clock = S.presented > 0 ? S.profile.times[S.presented - 1] || 0 : 0;
      deriveVehicleState(al);
      S.logSeen = (al.log || []).length;
      caption('Reconectando à sala de controle…', 'event');
    } else {
      S.clock = 0;
      S.presented = 0;
    }
    // fresh renderer state for the flight (the countdown window used its own framing)
    try { R.reset(); } catch (e) { renderFailed(e); }
    S.ev = {};
    if (phase === 'ascent') {
      fire('ignition');
      // resumed above the pad: liftoff happened long ago (no frost, no pad smoke)
      if (telemetryAt(S.profile, S.clock).alt > 0.0004) S.ev.liftoff = S.t - 30;
    } else if (resume) {
      for (const m of (al.milestones || []).slice(0, S.presented)) if (m.status !== 'fail') visualEvents(m);
    }
    S.engineOn = true;
    S.prevAlt = telemetryAt(S.profile, S.clock).alt;
    setMood('tense');
    renderTrack();
    renderTeam();
  }

  /** Vehicle configuration implied by milestones already resolved (used on resume and replay). */
  function deriveVehicleState(al, upto = S.presented) {
    const done = (al.milestones || []).slice(0, upto);
    S.staged = done.some((m) => /stag|separ|meco/.test(m.id || '') && m.status !== 'fail');
    S.fairingOff = done.some((m) => /fairing|les|coifa/.test(m.id || '') && m.status !== 'fail');
    const failed = done.some((m) => m.status === 'fail');
    const lvl = al.outcome?.level;
    S.exploded = failed && (!lvl || lvl === 'catastrophic' || !!al.outcome?.escaped);
    S.frozen = failed;
    const complete = done.length === (al.milestones || []).length && done.length > 0 && !S.exploded;
    S.landed = phase === 'arrival' && arrivalKind === 'landing' && complete;
    S.inOrbit = phase === 'arrival' && arrivalKind === 'orbit' && complete;
    S.chute = done.some((m) => /parachute|paraq/.test(m.id || '')) && !done.some((m) => /powered|descent|descida/.test(m.id || ''));
    S.engineOn = !S.exploded && !S.landed;
  }

  function updateAscent(dt, dtReal) {
    const al = AL();
    const ms = al.milestones || [];
    // 1) present milestones the sim resolved since last frame
    while (S.presented < Math.min(al.current || 0, ms.length)) {
      present(ms[S.presented], S.presented, al);
      S.presented++;
      renderTrack();
    }
    // 2) intervention card (slow motion while open)
    if (al.pendingIntervention) {
      if (S.climaxPre) endClimaxPre(); // the card must be heard and seen
      if (S.ivShown !== al.pendingIntervention.id + '|' + al.pendingIntervention.milestoneId) showIntervention(al.pendingIntervention);
      S.ivLeft -= dtReal;
      updateRing();
      if (S.ivLeft <= 0) chooseIntervention('timeout');
    } else if (S.ivShown) {
      S.ivShown = null;
      sheet.classList.remove('open');
    }
    S.timeScale = al.pendingIntervention ? 0.12 : S.climaxPre ? 0.3 : 1;
    // 3) roll the next milestone when the clock reaches it
    const ended = isEnded(al) || S.stepFails > 3;
    S.stepCooldown -= dtReal;
    if (!ended && !al.pendingIntervention) {
      const next = al.current || 0;
      const tNext = S.profile.times[next] ?? Infinity;
      const last = next === ms.length - 1;
      // the final milestone is preceded by slow motion + radio silence (the climax pre-roll)
      if (last && !S.climaxPre && !S.climaxDone && S.clock >= tNext - 1) startClimaxPre();
      const ready = !last || S.climaxDone || (S.climaxPre && S.climaxPre.t >= CLIMAX_PRE);
      if (S.clock >= tNext - 1e-6 && S.stepCooldown <= 0 && ready) step();
    }
    if (S.climaxPre) {
      S.climaxPre.t += dtReal;
      if (S.presented >= ms.length || ended) endClimaxPre();
    }
    // 4) advance the animation clock (pinned at the next unresolved milestone)
    if (!S.frozen) {
      const cap = ended ? Infinity : S.profile.times[al.current || 0] ?? Infinity;
      S.clock = Math.min(S.clock + dt * S.speed * S.timeScale, cap);
    }
    // 5) audio intensity follows dynamic pressure & thrust
    const tele = telemetryAt(S.profile, S.clock);
    if (phase === 'ascent') {
      const q = Math.exp(-Math.pow((tele.alt - 12) / 14, 2));
      audio.rumble(S.engineOn && !S.climaxPre ? 0.45 + q * 0.5 : 0);
    } else audio.rumble(S.engineOn ? 0.35 : 0);
    if (!S.climaxPre) audio.tension(0.3 + 0.6 * (S.presented / Math.max(1, ms.length)) + (al.pendingIntervention ? 0.2 : 0));
    // 6) after the last milestone, hand over to the climax
    if (ended && !al.pendingIntervention) {
      S.endTimer += dtReal;
      const touching = S.landed && S.touch && !S.touch.done; // let the craft settle on screen first
      if (S.endTimer > (S.exploded ? 2.4 : 2.2) && !S.radioQ.length && !touching) enterClimax();
      else if (S.endTimer > 6) enterClimax();
    }
  }

  function step() {
    S.stepCooldown = 0.35;
    const beforeCur = AL()?.current || 0;
    const r = dispatch({ type: 'launch/step' });
    const al = AL();
    if (!al) return;
    if (!r.ok || ((al.current || 0) === beforeCur && !al.pendingIntervention && !isEnded(al))) {
      S.stepFails++;
      if (r.error) caption(r.error, 'event');
    } else S.stepFails = 0;
  }

  /** A resolved milestone becomes a "goal" moment. */
  function present(m, i, al) {
    const label = m.label || m.id;
    const lines = Array.isArray(m.radio) ? m.radio : [];
    queueRadio(lines);
    drainLog(lines);
    const id = m.id || '';
    if (m.status === 'ok') {
      const finalArr = phase === 'arrival' && i === (al.milestones || []).length - 1;
      showStamp(label, !finalArr ? 'OK' : arrivalKind === 'orbit' ? 'CAPTURA CONFIRMADA' : world === 'earth' ? 'AMERISSAGEM' : 'POUSO CONFIRMADO', 'ok');
      audio.chime();
      vibrate(30);
      setMood('happy', 1.6);
      visualEvents(m);
      if (/stag|separ|meco/.test(id)) separateStage();
      if (/fairing|les|coifa/.test(id)) dropFairing();
      if (/orbit/.test(id) && phase === 'ascent') { S.engineOn = false; caption('Corte dos motores. Estamos em órbita.', 'telemetry'); }
      if (/tli/.test(id)) { S.engineOn = true; S.flash = 0.5; S.flashColor = PAL.amber; }
      if (/parachute|paraq/.test(id)) S.chute = true;
      if (/powered|descent|descida/.test(id)) S.chute = false;
      if (phase === 'arrival' && i === (al.milestones || []).length - 1) { if (arrivalKind === 'landing') touchdown(); else captured(); }
    } else if (m.status === 'anomaly') {
      showStamp(label, 'ANOMALIA', 'warn');
      audio.alarm();
      vibrate([60, 40, 60]);
      setMood('tense', 2);
      S.shake = Math.max(S.shake, 1);
      S.flash = 0.35; S.flashColor = PAL.amber;
      visualEvents(m);
      if (/stag|separ|meco/.test(id)) separateStage();
      if (/fairing|les|coifa/.test(id)) dropFairing();
      if (phase === 'arrival' && i === (al.milestones || []).length - 1) { if (arrivalKind === 'landing') touchdown(true); else captured(); }
    } else if (m.status === 'fail') {
      presentFailure(m, i, al);
    }
  }

  /** Failure staging depends on what the sim decided: explosion, escape tower, or a safe shutdown. */
  function presentFailure(m, i, al, quiet = false) {
    const label = m.label || m.id;
    const out = al.outcome || {};
    const aborted = al.endedAt?.how === 'abort' || out.how === 'abort' || (al.interventions || []).some((x) => x.optionId === 'abort' && x.milestoneId === m.id);
    const lvl = out.level || 'catastrophic';
    showStamp(label, aborted ? 'ABORTADO' : 'FALHA', 'bad');
    if (!quiet) { vibrate([250, 80, 250]); setMood('sad'); }
    S.frozen = true;
    if (crewed && phase === 'ascent' && (out.escaped || aborted)) { escape(); explode(quiet); return; }
    if (lvl === 'catastrophic' && !(aborted && !crewed)) { explode(quiet); return; }
    // vehicle survives (pad abort, wrong orbit, safe abort): engines cut, alarms, no fireball
    S.engineOn = false;
    S.shake = Math.max(S.shake, 1);
    S.flash = 0.45; S.flashColor = PAL.amber;
    if (!quiet) { audio.thump(); audio.alarm(); }
    if (phase === 'arrival' && arrivalKind === 'landing' && i === (al.milestones || []).length - 1) touchdown(true);
  }

  function startClimaxPre() {
    S.climaxPre = { t: 0 };
    audio.cutTension();
    audio.silence(true);
    ov.classList.add('ls-hush');
    setMood('tense');
    caption(phase === 'arrival' ? 'Últimos metros. Ninguém respira.' : 'Último marco. Ninguém fala.', 'event');
    vibrate(15);
  }
  function endClimaxPre() {
    S.climaxPre = null;
    S.climaxDone = true;
    audio.silence(false);
    ov.classList.remove('ls-hush');
  }

  // ---------- intervention cards (5 s)
  function showIntervention(iv) {
    S.ivShown = iv.id + '|' + iv.milestoneId;
    S.ivTotal = interventionTimer(iv);
    S.ivLeft = S.ivTotal; // a reopened app always gets the full timer back (pausing never punishes)
    const untimed = !Number.isFinite(S.ivTotal);
    const cp = AL()?.commandPoints ?? 0;
    sheet.innerHTML = '';
    const ring = untimed ? null : el('div', { class: 'ls-ring', html: `<svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" class="bg"/><circle cx="22" cy="22" r="19" class="fg" pathLength="100"/></svg><span>${Math.ceil(S.ivTotal)}</span>` });
    const opts = (iv.options || []).map((o) => {
      const cost = Number(o.cost) || 0;
      const disabled = !!o.disabled || cost > cp;
      return el('button', {
        class: `ls-opt opt-${o.id}${o.id === (iv.defaultOption || 'maintain') ? ' is-default' : ''}`, type: 'button', disabled: disabled ? true : null,
        onclick: () => chooseIntervention(o.id),
      },
      el('b', {}, o.label || ivLabel(o.id)),
      el('span', { class: 'ls-cost', 'aria-label': `custa ${cost} pontos de Comando` }, cost ? '●'.repeat(Math.min(cost, 5)) : 'grátis'),
      o.preview ? el('span', {}, o.preview) : null,
      disabled ? el('em', {}, o.reason || (cost > cp ? 'Comando insuficiente' : 'Indisponível')) : null);
    });
    put(sheet,
      el('div', { class: 'ls-card-head' }, el('div', {},
        el('div', { class: 'ls-card-k' }, `Intervenção · Comando ${'●'.repeat(Math.min(cp, 6))} (${cp})`),
        el('div', { class: 'ls-card-t' }, iv.prompt || 'Leitura fora da faixa. Sua decisão?')), ring),
      el('div', { class: 'ls-opts' }, opts),
      el('div', { class: 'ls-note' }, untimed ? 'Sem limite de tempo (Ajustes). Escolha com calma.' : `Sem resposta em ${Math.ceil(S.ivTotal)} s: ${ivLabel(iv.defaultOption || 'maintain')}.`));
    sheet.classList.add('open');
    audio.alarm();
    vibrate([90, 50, 90]);
    setMood('tense');
    S.shake = Math.max(S.shake, 0.6);
    caption(iv.prompt || 'Anomalia detectada.', 'event');
    sheet.querySelector('.ls-opt:not([disabled])')?.focus?.({ preventScroll: true });
  }
  /** Seconds for an intervention card: the player's setting (5 / 10 / no limit) over the sim's default. */
  function interventionTimer(iv) {
    const base = Number(iv?.seconds) > 0 ? Number(iv.seconds) : 5;
    const pref = Number(store.settings?.interventionSeconds);
    if (pref === 0) return Infinity;
    return pref > 0 ? Math.max(base, pref) : base;
  }
  function updateRing() {
    if (!Number.isFinite(S.ivTotal)) return; // no-limit setting: no ring, no ticking
    const fg = sheet.querySelector('.ls-ring .fg');
    const num = sheet.querySelector('.ls-ring span');
    const f = Math.max(0, S.ivLeft / S.ivTotal);
    if (fg) fg.style.strokeDashoffset = String(100 - f * 100);
    if (num) num.textContent = String(Math.max(0, Math.ceil(S.ivLeft)));
    if (Math.ceil(S.ivLeft) !== S.ivTick) { S.ivTick = Math.ceil(S.ivLeft); if (S.ivLeft > 0) audio.beep('tick'); }
  }
  function chooseIntervention(optionId) {
    const iv = AL()?.pendingIntervention;
    if (!iv) return;
    S.ivShown = null;
    sheet.classList.remove('open');
    let r = dispatch({ type: 'launch/choose', optionId });
    if (!r.ok && optionId === 'timeout') r = dispatch({ type: 'launch/choose', optionId: iv.defaultOption || 'maintain' });
    if (!r.ok && AL()?.pendingIntervention) {
      // last resort so the scene can never deadlock
      const first = (iv.options || []).find((o) => !o.disabled)?.id;
      if (first) r = dispatch({ type: 'launch/choose', optionId: first });
    }
    const chosen = optionId === 'timeout' ? (iv.defaultOption || 'maintain') : optionId;
    caption(optionId === 'timeout' ? `Sem resposta. Protocolo: ${ivLabel(chosen)}.` : `Diretor de voo: “${capitalize(ivLabel(chosen))}!”`, 'radio');
    if (chosen === 'abort') { S.shake = 1.2; caption('ABORTAR, ABORTAR, ABORTAR.', 'radio'); }
    drainLog();
    renderTrack();
  }
  const capitalize = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

  // ================================================================ ACT 5: climax
  function enterClimax() {
    if (S.view === 'climax' || S.view === 'result') return;
    S.view = 'climax';
    ov.dataset.view = 'climax';
    S.cTimer = 0;
    if (S.climaxPre) endClimaxPre();
    sheet.classList.remove('open');
    audio.cutTension();
    audio.silence(true);
    S.radioQ.length = 0;
    caption('…', 'event');
    renderTeam();
  }
  function updateClimax(dtReal) {
    S.timeScale = 0.25;
    S.cTimer += dtReal;
    const dur = S.climaxDone && !S.exploded ? 1.6 : 3.4;
    if (S.cTimer < dur) return;
    // let the sim move climax -> result (bounded tries)
    for (let i = 0; i < 3; i++) {
      const al = AL();
      if (!al || al.act === 'result') break;
      const r = dispatch({ type: 'launch/step' });
      if (!r.ok) break;
    }
    if (AL()) enterResult();
  }

  // ================================================================ ACT 6: result
  function enterResult(resumed = false) {
    const al = AL();
    S.view = 'result';
    ov.dataset.view = 'result';
    ov.classList.remove('ls-hush');
    audio.silence(false);
    audio.cutTension();
    audio.stopRumble();
    sheet.classList.remove('open');
    countEl.innerHTML = '';
    S.presented = (al.milestones || []).length;
    deriveVehicleState(al);
    if (S.touch && !S.touch.done) { S.clock = Math.max(S.clock, S.profile.keys[S.profile.keys.length - 1]?.t ?? S.clock); visualTouchdown(); }
    const out = al.outcome || fallbackOutcome(al);
    const info = outcomeInfoFor(out);
    const good = out.level === 'total' || out.level === 'partial';
    setMood(good ? 'happy' : 'sad');
    S.resultFx = good ? (out.level === 'total' ? 'confetti' : 'sparks') : 'smoke';
    if (!resumed) {
      if (good) { audio.fanfare(out.level === 'total'); vibrate([40, 40, 40, 40, 160]); }
      else { audio.failure(out.level === 'catastrophic'); vibrate([400]); }
    }
    showStamp(info.label.toUpperCase(), '', info.tone === 'ok' ? 'ok' : info.tone === 'warn' ? 'warn' : 'bad');
    renderTrack(true);
    renderResult(al, out, info);
  }

  /**
   * A good ascent of a mission that still has to arrive somewhere is one leg, not the mission: "Subida
   * concluída / A caminho", never "Missão cumprida" while the lander is still in transit.
   */
  function outcomeInfoFor(out) {
    const base = OUTCOME_INFO[out.level] || OUTCOME_INFO.partial;
    const more = out.final === false || (out.final !== true && phase === 'ascent' && (dest?.arrivalMilestones || []).length > 0);
    if (!more || (out.level !== 'total' && out.level !== 'partial')) return base;
    const where = dest?.name ? ` de ${dest.name}` : '';
    return out.level === 'total'
      ? { ...base, label: 'Subida concluída', glyph: '➚', line: `A caminho${where}. A chegada decide a missão.` }
      : { ...base, label: 'Subida com ressalvas', line: `A nave segue a caminho${where}, com menos folga para a chegada.` };
  }

  function renderResult(al, out, info) {
    const est = al.estimate || mission.estimate || {};
    const p = toPct(est.p);
    const good = out.level === 'total' || out.level === 'partial';
    let odds = '';
    if (p != null && good && p < 50) odds = 'Contra as probabilidades.';
    else if (p != null && !good && p > 80) odds = 'Era quase certo. Não foi.';
    const causes = (out.causes || []).filter(Boolean).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 5);
    const lost = (out.crewLost || []).map((id) => person(store, id)).filter(Boolean);
    const headlines = [out.headline, ...(mission.result?.headlines || [])].filter(Boolean);
    if (headlines.length < 2) headlines.push(genericHeadline(out.level));
    const ivs = al.interventions || [];
    panel.innerHTML = '';
    put(panel,
      el('div', { class: `ls-banner tone-${info.tone}` },
        el('div', { class: 'ls-banner-g', 'aria-hidden': 'true' }, info.glyph),
        el('div', {}, el('div', { class: 'ls-banner-t' }, info.label), el('div', { class: 'ls-banner-s' }, info.line))),
      el('div', { class: 'ls-odds' },
        el('span', {}, `Chance estimada ${formatBand(est)}`),
        out.failureType ? el('span', { class: 'ls-chip warn' }, `Falha: ${FAILURE_LABELS[out.failureType] || out.failureType}`) : null,
        odds ? el('strong', {}, odds) : null),
      lost.length ? el('div', { class: 'ls-memorial' },
        el('div', { class: 'ls-label' }, 'Em memória'),
        el('div', { class: 'ls-picks' }, lost.map((pp) => el('div', { class: 'ls-lost' }, el('div', { html: portraitOf(pp, 44, 'dead') }), el('span', {}, pp.name))))) : null,
      el('section', { class: 'ls-sec' },
        el('div', { class: 'ls-label' }, 'Relatório de causas'),
        causes.length ? el('ol', { class: 'ls-chain' }, causes.map((c) => el('li', { class: `k-${c.kind || 'luck'}` },
          el('span', { class: 'ls-chain-k' }, CAUSE_KIND[c.kind] || c.kind || 'Fator'),
          el('div', {}, el('b', {}, c.label || ''), c.detail ? el('span', {}, c.detail) : null))))
          : el('p', { class: 'ls-note' }, good ? 'Tudo dentro do esperado. Nenhuma causa crítica registrada.' : 'A investigação ainda está em andamento.')),
      el('section', { class: 'ls-sec' },
        el('div', { class: 'ls-label' }, 'Manchetes'),
        el('ul', { class: 'ls-heads' }, headlines.slice(0, 3).map((hl) => el('li', {}, hl)))),
      el('section', { class: 'ls-sec' },
        el('div', { class: 'ls-label' }, 'Linha do tempo · toque num marco'),
        el('div', { class: 'ls-tl-detail' }, ivs.length ? `${ivs.length} intervenç${ivs.length > 1 ? 'ões' : 'ão'}: ${ivs.map((x) => ivLabel(x)).join(', ')}.` : 'Nenhuma intervenção: a equipe só torceu.')),
      el('div', { class: 'ls-cta' },
        el('button', { class: 'ls-btn', type: 'button', onclick: startReplay }, 'Rever'),
        el('button', { class: 'ls-btn ls-primary', type: 'button', onclick: finish }, 'Continuar')),
    );
    panel.scrollTop = 0;
  }

  function genericHeadline(level) {
    const who = actor?.short || actor?.name || 'Agência';
    const mname = mission.name || 'missão';
    return {
      total: `${who} acerta em cheio com ${mname}`,
      partial: `${mname}: meio sucesso, muitas perguntas`,
      recoverable: `${who} perde ${mname}, mas salva o que importa`,
      catastrophic: `Tragédia: ${mname} termina em desastre`,
    }[level] || `${mname} chega ao fim`;
  }

  function finish() {
    if (S.finishing) return;
    S.finishing = true;
    dispatch({ type: 'launch/finish' });
    close();
  }

  // ---------- replay (visual only: never dispatches)
  function startReplay() {
    const al = AL();
    if (!al) return;
    S.replay = { clock: 0, shown: 0, speed: 3 };
    S.view = 'replay';
    ov.dataset.view = 'ascent';
    ov.classList.add('ls-replaying');
    S.particles.length = 0;
    try { R.reset(); } catch (e) { renderFailed(e); }
    S.ev = {};
    if (phase === 'ascent') fire('ignition');
    S.staged = false; S.fairingOff = false; S.exploded = false; S.landed = false; S.touch = null; S.engineOn = true; S.frozen = false; S.escaped = null; S.chute = false; S.inOrbit = false;
    S.presented = 0;
    S.clock = 0;
    S.resultFx = null;
    caption('Replay da linha do tempo.', 'event');
    renderTrack();
  }
  function updateReplay(dtReal) {
    const al = AL();
    const ms = al.milestones || [];
    const RP = S.replay;
    if (!S.frozen) S.clock += dtReal * RP.speed;
    while (RP.shown < ms.length && S.clock >= S.profile.times[RP.shown]) {
      const m = ms[RP.shown];
      S.presented = RP.shown + 1;
      const id = m.id || '';
      showStamp(m.label || id, m.status === 'ok' ? 'OK' : m.status === 'anomaly' ? 'ANOMALIA' : m.status === 'fail' ? 'FALHA' : '', m.status === 'ok' ? 'ok' : m.status === 'anomaly' ? 'warn' : 'bad');
      if (m.status !== 'fail' && /stag|separ|meco/.test(id)) separateStage();
      if (m.status !== 'fail' && /fairing|les|coifa/.test(id)) dropFairing();
      if (/orbit/.test(id) && m.status !== 'fail' && phase === 'ascent') S.engineOn = false;
      if (phase === 'arrival' && RP.shown === ms.length - 1 && m.status !== 'fail') { if (arrivalKind === 'landing') touchdown(m.status === 'anomaly'); else captured(); }
      visualEvents(m);
      if (m.status === 'fail') presentFailure(m, RP.shown, al, true);
      RP.shown++;
      renderTrack();
    }
    const doneAt = (S.profile.times[ms.length - 1] ?? 0) + 2.5 * RP.speed;
    if (RP.shown >= ms.length && S.clock >= doneAt || (S.frozen && (RP.frozenT = (RP.frozenT || 0) + dtReal) > 2.5)) {
      S.replay = null;
      ov.classList.remove('ls-replaying');
      enterResult(true);
    }
  }

  // ================================================================ renderer (src/ui/launch-render)
  // Everything on the canvas is painted by the launch renderer from a RenderState snapshot (README §3) plus
  // milestone events (§4). The scene keeps only its HUD/DOM, the control-room chrome, flashes and result fx.
  // R forwards to the real renderer once its module has loaded; events fired before that are kept in S.ev and
  // reach it through rs.events (the renderer merges them), so nothing is lost.
  let Rimpl = null;
  const ensureR = () => {
    if (!Rimpl && renderMod) Rimpl = renderMod.createLaunchRenderer({ seed: hashStr(key), cap: reduce() ? 150 : 600 });
    return Rimpl;
  };
  const R = {
    ready: () => !!ensureR(),
    reset() { ensureR()?.reset(); },
    event(name, payload) { ensureR()?.event(name, payload); },
    update(rs) { ensureR()?.update(rs); },
    draw(ctx, rs) { if (!ensureR()) return false; Rimpl.draw(ctx, rs); return true; },
    drawPadWindow(ctx, rect, rs) { if (!ensureR()) return false; Rimpl.drawPadWindow(ctx, rect, rs); return true; },
    vehicleScreenPos(rs) { return ensureR()?.vehicleScreenPos(rs) || { x: S.W / 2, y: S.H * 0.45 }; },
  };
  const landerId = pickLander();
  const AIR_WORLDS = new Set(['earth', 'mars', 'titan', 'venus']);
  S.ev = {};
  let lastRS = null;
  let renderErrors = 0;

  /** The partner lander drawn when the mission's own craft cannot land (Orion → HLS, Mengzhou → Lanyue). */
  function pickLander() {
    if (phase !== 'arrival' || arrivalKind !== 'landing' || world === 'earth' || !craft || craft.kind === 'lander') return null;
    const list = store.data?.spacecraft?.spacecraft || Object.values(dIdx.spacecraft || {});
    const fits = list.filter((c) => c && c.kind === 'lander' && (c.destinations || []).includes(mission.destination) && (!crewed || (c.crew || 0) > 0));
    const pick = fits.find((c) => c.operator === craft.operator) || fits.find((c) => !(c.embargo || []).includes(craft.operator)) || fits[0];
    return pick?.id || null;
  }

  function renderFailed(e) {
    renderErrors++;
    if (renderErrors <= 3) console.error('launch-render:', e);
  }

  /** Forward a visual event once (the renderer is idempotent too; S.ev feeds rs.events for the camera). */
  function fire(name, payload) {
    if (S.ev[name] != null) return;
    S.ev[name] = S.t;
    try { R.event(name, payload || {}); } catch (e) { renderFailed(e); }
  }

  /** Visual events implied by a resolved milestone (stage/fairing/touchdown are fired by their handlers). */
  function visualEvents(m) {
    const id = m?.id || '';
    if (!m || m.status === 'fail') return;
    if (phase === 'ascent') {
      if (id === 'ignition') fire('ignition');
      if (id === 'liftoff') fire('liftoff');
      if (/maxq|max_q/.test(id)) fire('maxq', { status: m.status });
      if (/orbit/.test(id)) fire('seco');
      if (/tli/.test(id)) fire('tli');
    } else {
      if (/entry|reentry/.test(id)) fire('entry');
      if (/parachute|paraq/.test(id)) fire('chute');
      if (/powered|descent|descida/.test(id)) fire('powered');
    }
    if (m.status === 'anomaly') { try { R.event('anomaly', { severity: 0.6 }); } catch (e) { renderFailed(e); } }
  }

  function sceneMode() {
    if (S.view === 'countdown') return 'pad';
    if (phase === 'arrival') return arrivalKind === 'landing' ? 'descent' : 'orbit';
    return 'ascent';
  }

  /** RenderState snapshot (README §3). Only presents scene state: never reads or changes the sim. */
  function buildRS(dt, over = {}) {
    const al = AL();
    const mode = over.mode || sceneMode();
    const tele = telemetryAt(S.profile, S.clock);
    const lastT = S.profile.times[S.profile.times.length - 1] || 1;
    const descentWorld = phase === 'arrival' ? world : 'earth';
    const landed = visLanded(tele.alt);
    let engineOn = (!!S.engineOn || (!!S.landed && !landed && !S.inOrbit)) && !S.exploded;
    let chute = !!S.chute;
    if (mode === 'pad') engineOn = phase === 'ascent' && S.cd <= 3;
    else if (mode === 'descent') {
      if (descentWorld === 'earth') {
        engineOn = false;
        // a capsule coming home has no parachute milestone: the mains open a few seconds after re-entry
        chute = S.ev.entry != null && S.t - S.ev.entry > 3.5 && !landed;
      } else if (AIR_WORLDS.has(descentWorld)) engineOn = engineOn && S.ev.powered != null && !chute;
      engineOn = engineOn && !landed;
    }
    return {
      view: { W: S.W, H: S.H }, t: S.t, dt, reduce: reduce(), seed: hashStr(key), mode, phase,
      tele: { altKm: mode === 'pad' ? 0 : tele.alt, velKms: mode === 'pad' ? 0 : tele.vel, met: metAt(S.profile, S.clock) },
      clock: S.clock, progress: Math.max(0, Math.min(1, S.clock / lastT)), cd: mode === 'pad' ? S.cd : null,
      vehicleId: mission.vehicleId || null, craftId: mission.spacecraftId || null, landerId, crewed,
      bodyId: body, world: descentWorld, siteId: null,
      weather: { risk: toPct(al?.weather?.risk) ?? 15, label: al?.weather?.label || '' },
      flags: {
        engineOn, staged: !!S.staged, fairingOff: !!S.fairingOff, exploded: !!S.exploded, escaped: !!S.escaped,
        landed, chute, inOrbit: !!S.inOrbit, hold: !!al?.pendingHold,
      },
      events: S.ev,
      ...over,
    };
  }

  function separateStage() {
    if (S.staged) return;
    S.staged = true;
    audio.thump();
    S.shake = Math.max(S.shake, 0.4);
    if (phase === 'ascent') fire('staging', { status: 'ok' });
  }
  function dropFairing() {
    if (S.fairingOff) return;
    S.fairingOff = true;
    if (phase === 'ascent') fire('fairing');
  }
  function explode(quiet = false) {
    if (S.exploded && !quiet) return;
    S.exploded = true;
    S.engineOn = false;
    if (!quiet) audio.boom();
    S.flash = 1; S.flashColor = '#fff3d6';
    fire('explode', vehicleScreenPos());
  }
  function escape() {
    S.escaped = { t: 0 };
    caption('Torre de escape disparada! Cápsula se afastando.', 'radio');
    fire('escape');
  }
  /**
   * The sim rolls the touchdown milestone a few metres up (buildProfile): the scene marks the landing as decided
   * and the craft actually touches the ground when the profile reaches zero altitude (visualTouchdown).
   */
  function touchdown(hard = false) {
    S.landed = true;
    S.touch = { hard: !!hard, done: false };
  }
  function visualTouchdown() {
    if (!S.touch || S.touch.done) return;
    S.touch.done = true;
    S.engineOn = false;
    audio.touchdown();
    S.shake = Math.max(S.shake, S.touch.hard ? 0.6 : 0.2);
    if (world === 'earth') fire('splashdown');
    else fire('touchdown', { hard: S.touch.hard });
  }
  /** Landed on screen: decided by the sim AND down to the ground (or restored from a finished state). */
  function visLanded(altKm) {
    return !!S.landed && (!S.touch || S.touch.done || altKm <= 0.0008);
  }
  function captured() {
    S.engineOn = false;
    S.inOrbit = true;
    fire('capture');
  }

  function vehicleScreenPos() {
    try { if (lastRS) return R.vehicleScreenPos(lastRS); } catch (e) { renderFailed(e); }
    return { x: S.W / 2, y: S.H * 0.45 };
  }

  // ================================================================ drawing
  let vignette = null;
  function drawVignette() {
    if (!vignette || vignette.W !== S.W || vignette.H !== S.H) {
      const gr = g.createRadialGradient(S.W / 2, S.H * 0.48, Math.min(S.W, S.H) * 0.35, S.W / 2, S.H * 0.48, Math.hypot(S.W, S.H) * 0.62);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,0.34)');
      vignette = { W: S.W, H: S.H, gr };
    }
    g.fillStyle = vignette.gr;
    g.fillRect(0, 0, S.W, S.H);
  }

  function draw(dt) {
    const W = S.W, H = S.H;
    g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // scene-level shake (interventions, anomalies); deterministic, none with reduced motion
    let sx = 0, sy = 0;
    if (S.shake > 0 && !reduce()) {
      const a = S.shake * 4;
      sx = a * (Math.sin(S.t * 57.1) * 0.6 + Math.sin(S.t * 21.7) * 0.4);
      sy = a * (Math.sin(S.t * 43.3) * 0.6 + Math.sin(S.t * 29.9) * 0.4);
    }
    S.shake = Math.max(0, S.shake - dt * 1.6);
    g.save();
    g.translate(sx, sy);
    if (S.view === 'countdown') drawControlRoom(dt);
    else drawFlight(dt);
    drawParticles(dt);
    g.restore();
    if (S.view !== 'countdown') drawVignette();
    if (S.flash > 0) {
      g.globalAlpha = Math.min(1, S.flash) * (reduce() ? 0.3 : 0.75);
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = S.flashColor;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      S.flash = Math.max(0, S.flash - dt * 1.8);
    }
    if (S.view === 'result') drawResultFx(dt);
  }

  /** The whole flight (ascent, descent, orbit arrival) through the renderer. */
  function drawFlight(dt) {
    const rs = buildRS(dt);
    try {
      R.update(rs);
      lastRS = rs;
      // the vehicle leaves the pad when the profile starts climbing (a little before the "liftoff" call)
      if (rs.mode === 'ascent' && rs.tele.altKm > 0.0004) fire('liftoff');
      if (rs.mode === 'descent' && rs.flags.chute) fire('chute');
      if (rs.mode === 'descent' && S.landed && S.touch && !S.touch.done && rs.tele.altKm <= 0.0008) { visualTouchdown(); rs.flags.landed = true; rs.flags.engineOn = false; }
      if (!R.draw(g, rs)) plainSky();
    } catch (e) {
      renderFailed(e);
      plainSky();
    }
  }
  /** Plain sky while the renderer module loads (or if it is unavailable). */
  function plainSky() {
    const gr = g.createLinearGradient(0, 0, 0, S.H);
    gr.addColorStop(0, '#04060d'); gr.addColorStop(1, phase === 'arrival' ? '#141821' : '#1d3f66');
    g.fillStyle = gr;
    g.fillRect(-20, -20, S.W + 40, S.H + 40);
  }

  // ---------- control room (countdown): a dim room, the window to the pad (or the big screen) and consoles
  let roomCache = null;
  function roomBackdrop(W, H) {
    if (roomCache && roomCache.W === W && roomCache.H === H && roomCache.dpr === S.dpr) return roomCache.c;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * S.dpr)); c.height = Math.max(1, Math.round(H * S.dpr));
    const x = c.getContext('2d');
    x.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    // back wall: dark acoustic panels under a soft ceiling light
    const wall = x.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#0c1220'); wall.addColorStop(0.6, '#0a0f1a'); wall.addColorStop(1, '#06090f');
    x.fillStyle = wall; x.fillRect(0, 0, W, H);
    const panelW = Math.max(28, W / 9);
    for (let i = 0; i * panelW < W; i++) {
      const v = (hashStr('wall' + i) % 7) / 260;
      x.fillStyle = `rgba(160,180,210,${(0.02 + v).toFixed(3)})`;
      x.fillRect(i * panelW + 1, 0, panelW - 2, H * 0.62);
    }
    const lamp = x.createRadialGradient(W / 2, -H * 0.1, 10, W / 2, -H * 0.1, H * 0.8);
    lamp.addColorStop(0, 'rgba(255,236,200,0.10)'); lamp.addColorStop(1, 'rgba(255,236,200,0)');
    x.fillStyle = lamp; x.fillRect(0, 0, W, H);
    const fl = x.createLinearGradient(0, H * 0.62, 0, H);
    fl.addColorStop(0, '#0b0f17'); fl.addColorStop(1, '#030407');
    x.fillStyle = fl; x.fillRect(0, H * 0.62, W, H * 0.38);
    roomCache = { W, H, dpr: S.dpr, c };
    return c;
  }

  function windowRect() {
    const W = S.W, H = S.H;
    return { x: Math.round(W * 0.05), y: Math.round(H * 0.04), w: Math.round(W * 0.9), h: Math.round(H * 0.6) };
  }

  function drawControlRoom(dt) {
    const W = S.W, H = S.H;
    const al = AL();
    const arr = phase === 'arrival';
    const excite = Math.max(0, Math.min(1, 1 - S.cd / COUNT_FROM));
    g.drawImage(roomBackdrop(W, H), 0, 0, W, H);
    const rect = windowRect();
    // the view: the pad through the window (ascent) or the approach on the big screen (arrival)
    try {
      if (!arr) {
        const rs = buildRS(dt, { view: { W: rect.w, H: rect.h }, mode: 'pad' });
        R.update(rs);
        if (!R.drawPadWindow(g, rect, rs)) { g.fillStyle = '#3d6f99'; g.fillRect(rect.x, rect.y, rect.w, rect.h); }
      } else {
        const rs = buildRS(dt, {
          view: { W: rect.w, H: rect.h }, mode: 'orbit', world,
          progress: 0.06 + 0.1 * excite, tele: { altKm: S.profile.keys[0]?.alt || 1000, velKms: S.profile.keys[0]?.vel || 2, met: 0 },
          flags: { engineOn: false, staged: true, fairingOff: true },
        });
        g.save();
        g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
        g.translate(rect.x, rect.y);
        if (!R.draw(g, rs)) { g.fillStyle = '#05070f'; g.fillRect(0, 0, rect.w, rect.h); }
        g.restore();
      }
    } catch (e) {
      renderFailed(e);
      g.fillStyle = arr ? '#05070f' : '#3d6f99';
      g.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    g.save();
    g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
    if (arr) {
      // big-screen overlay: approach path, craft marker and faint scanlines
      const u = Math.max(0.7, Math.min(1.4, H / 700));
      g.setLineDash([5 * u, 6 * u]); g.strokeStyle = 'rgba(126,232,214,0.55)'; g.lineWidth = 1.2;
      const x0 = rect.x + rect.w * 0.1, y0 = rect.y + rect.h * 0.12;
      const xc = rect.x + rect.w * 0.18;
      const x1 = rect.x + rect.w * 0.5, y1 = rect.y + rect.h * 0.62;
      g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(xc, y1, x1, y1); g.stroke();
      g.setLineDash([]);
      const f = excite * 0.9;
      const px = (1 - f) * (1 - f) * x0 + 2 * (1 - f) * f * xc + f * f * x1;
      const py = (1 - f) * (1 - f) * y0 + 2 * (1 - f) * f * y1 + f * f * y1;
      if (reduce() || Math.floor(S.t * 2.5) % 2 === 0) { g.fillStyle = 'rgba(255,196,90,0.95)'; g.beginPath(); g.arc(px, py, 3.2 * u, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = 'rgba(160,220,255,0.035)';
      for (let yy = rect.y; yy < rect.y + rect.h; yy += 3) g.fillRect(rect.x, yy, rect.w, 1);
      g.font = `600 ${Math.round(10 * u)}px system-ui, sans-serif`;
      g.fillStyle = 'rgba(126,232,214,0.85)';
      g.fillText('TELEMETRIA · APROXIMAÇÃO', rect.x + 8, rect.y + rect.h - 10);
    } else {
      // glass: faint reflection bands, rain streaks in bad weather
      const risk = toPct(al?.weather?.risk) ?? 10;
      const rain = risk > 55 || /chuva|tempest|raio/.test(String(al?.weather?.label || '').toLowerCase());
      const refl = g.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
      refl.addColorStop(0, 'rgba(255,255,255,0.06)'); refl.addColorStop(0.35, 'rgba(255,255,255,0)');
      refl.addColorStop(0.62, 'rgba(255,255,255,0.035)'); refl.addColorStop(0.7, 'rgba(255,255,255,0)');
      g.fillStyle = refl; g.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (rain && !reduce()) {
        g.strokeStyle = 'rgba(210,225,240,0.28)'; g.lineWidth = 1;
        for (let i = 0; i < 40; i++) {
          const x = rect.x + ((i * 37.3 + S.t * 40) % rect.w);
          const y = rect.y + ((i * 53.7 + S.t * (90 + (i % 5) * 20)) % rect.h);
          g.beginPath(); g.moveTo(x, y); g.lineTo(x - 1, y + 7); g.stroke();
        }
      }
    }
    g.restore();
    // window frame
    g.strokeStyle = '#1c2433'; g.lineWidth = 6;
    g.strokeRect(rect.x - 2, rect.y - 2, rect.w + 4, rect.h + 4);
    g.strokeStyle = 'rgba(200,210,225,0.18)'; g.lineWidth = 1;
    g.strokeRect(rect.x - 5, rect.y - 5, rect.w + 10, rect.h + 10);
    // HOLD lamp
    if (al?.pendingHold && (reduce() || Math.floor(S.t * 2) % 2 === 0)) {
      const lx = W - 18, ly = rect.y + 14;
      const halo = g.createRadialGradient(lx, ly, 1, lx, ly, 16);
      halo.addColorStop(0, 'rgba(255,190,60,0.95)'); halo.addColorStop(1, 'rgba(255,190,60,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(lx, ly, 16, 0, Math.PI * 2); g.fill();
    }
    drawConsoles(W, H, rect, excite, al);
  }

  /** Two tiers of consoles in silhouette, their screens lighting the desks. */
  function drawConsoles(W, H, rect, excite, al) {
    const top = rect.y + rect.h + 8;
    const room = Math.max(40, H - top);
    // one tier of screens right under the window; the desk below is where the big countdown sits
    for (let row = 0; row < 1; row++) {
      const deskH = Math.max(14, room * 0.8);
      const cy = top + Math.min(room * 0.42, 70);
      const cw = W * (0.9 + row * 0.14);
      const cx = (W - cw) / 2;
      const n = 4 + row;
      const gap = 6;
      const sw = (cw - 24 - gap * (n - 1)) / n;
      const sh = Math.min(48, room * 0.34);
      for (let i = 0; i < n; i++) {
        const sx = cx + 12 + i * (sw + gap);
        const syy = cy - sh * 0.85;
        const warn = al?.pendingHold && i === 1;
        const glow = g.createRadialGradient(sx + sw / 2, syy + sh / 2, 2, sx + sw / 2, syy + sh / 2, sw);
        glow.addColorStop(0, warn ? 'rgba(255,90,70,0.16)' : 'rgba(110,200,255,0.10)');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = glow; g.fillRect(sx - sw * 0.5, syy - sh, sw * 2, sh * 3);
        g.fillStyle = '#05101e'; g.fillRect(sx, syy, sw, sh);
        g.strokeStyle = 'rgba(160,190,220,0.18)'; g.lineWidth = 1; g.strokeRect(sx + 0.5, syy + 0.5, sw - 1, sh - 1);
        g.save();
        g.beginPath(); g.rect(sx + 2, syy + 2, sw - 4, sh - 4); g.clip();
        g.strokeStyle = warn ? 'rgba(255,120,90,0.9)' : i % 2 ? 'rgba(126,232,214,0.8)' : 'rgba(255,200,110,0.8)';
        g.lineWidth = 1;
        g.beginPath();
        const ph = reduce() ? 0 : S.t * (1.6 + i * 0.5);
        for (let k = 0; k <= 16; k++) {
          const px = sx + (k / 16) * sw;
          const py = syy + sh * 0.6 + Math.sin(ph + k * 0.8 + row * 2) * sh * 0.2 * (0.4 + excite * 0.6);
          if (k) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.stroke();
        g.fillStyle = 'rgba(200,220,240,0.35)';
        for (let k = 0; k < 3; k++) g.fillRect(sx + 4, syy + 4 + k * 4, sw * (0.3 + ((hashStr('l' + i + k + row) % 40) / 100)), 1.5);
        g.restore();
      }
      const dg = g.createLinearGradient(0, cy, 0, cy + deskH);
      dg.addColorStop(0, row ? '#1a2232' : '#161d2b'); dg.addColorStop(0.08, '#0d121c'); dg.addColorStop(1, '#06080d');
      g.fillStyle = dg;
      g.beginPath(); g.moveTo(cx + 10, cy); g.lineTo(cx + cw - 10, cy); g.lineTo(cx + cw, cy + deskH); g.lineTo(cx, cy + deskH); g.closePath(); g.fill();
      g.fillStyle = 'rgba(150,200,240,0.16)';
      g.fillRect(cx + 10, cy, cw - 20, 1);
      for (let i = 0; i < n; i++) {
        const on = reduce() || Math.floor(S.t * (1.2 + i * 0.6) + row) % 4 !== 0;
        g.fillStyle = on ? (al?.pendingHold && i === 1 ? '#ff5a46' : '#38d39f') : '#1b2636';
        g.fillRect(cx + 18 + i * (sw + gap) + sw * 0.8, cy + deskH * 0.35, 3, 3);
      }
    }
  }

  // ---------- small UI particles (confetti / sparks / smoke over the result)
  function cap() { return reduce() ? 120 : 420; }
  function emit(p) { if (S.particles.length < cap()) S.particles.push(p); }

  // ---------- particles
  function drawParticles(dt) {
    const ps = S.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      const drag = p.drag || 0;
      p.vx -= p.vx * drag * dt;
      p.vy -= p.vy * drag * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      const size = p.size + p.grow * k;
      g.globalAlpha = (1 - k) * (p.kind === 'smoke' ? 0.55 : 0.9);
      g.fillStyle = p.kind === 'fire' && k > 0.5 ? '#6b6f7a' : p.color;
      if (p.kind === 'spark') g.fillRect(p.x - size / 2, p.y - size / 2, size, size);
      else { g.beginPath(); g.arc(p.x, p.y, size, 0, Math.PI * 2); g.fill(); }
    }
    g.globalAlpha = 1;
  }

  function drawResultFx(dt) {
    if (!S.resultFx) return;
    const W = S.W;
    const rate = reduce() ? 0.15 : 1;
    if (S.resultFx === 'confetti' && Math.random() < 0.9 * rate) {
      const colors = [PAL.accent, PAL.amber, PAL.teal, PAL.cream, PAL.flag];
      emit({ x: Math.random() * W, y: -10, vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 80, life: 0, max: 4, size: 3 + Math.random() * 3, grow: 0, color: colors[Math.floor(Math.random() * colors.length)], kind: 'spark', world: false });
    } else if (S.resultFx === 'sparks' && Math.random() < 0.3 * rate) {
      emit({ x: Math.random() * W, y: -10, vx: 0, vy: 70, life: 0, max: 3, size: 3, grow: 0, color: PAL.amber, kind: 'spark', world: false });
    } else if (S.resultFx === 'smoke' && Math.random() < 0.25 * rate) {
      emit({ x: W * (0.3 + Math.random() * 0.4), y: S.H * 0.6, vx: (Math.random() - 0.5) * 20, vy: -20, life: 0, max: 4, size: 8, grow: 30, color: '#3a3f4a', kind: 'smoke', world: false });
    }
  }

  // ---------- HUD (DOM, throttled)
  function renderHud() {
    const al = AL();
    if (!al) return;
    if (S.view === 'prelaunch' || S.view === 'result') { hud.innerHTML = ''; return; }
    const tele = telemetryAt(S.profile, S.clock);
    const wob = reduce() ? 0 : Math.sin(S.t * 1.7) * 4 + Math.sin(S.t * 4.3) * 2;
    const conf = Math.max(0, Math.min(100, (Number(al.confidence) || 60) + (S.view === 'ascent' ? wob : 0)));
    const nervBase = Number(al.nerves) || 30;
    const nerv = Math.max(0, Math.min(100, nervBase + (S.view === 'countdown' ? (1 - S.cd / COUNT_FROM) * 12 : 0) + (al.pendingIntervention ? 15 : 0) + (reduce() ? 0 : Math.sin(S.t * 3.1) * 2)));
    const cp = al.commandPoints ?? 0;
    const tlabel = S.view === 'countdown' ? `T−${fmtClock(Math.ceil(S.cd))}` : `T+${fmtClock(metAt(S.profile, S.clock))}`;
    const altTxt = tele.alt < 1 ? `${Math.round(tele.alt * 1000)} m` : `${fmtNum(tele.alt, tele.alt < 100 ? 1 : 0)} km`;
    const velTxt = tele.vel < 1 ? `${Math.round(tele.vel * 1000)} m/s` : `${fmtNum(tele.vel, 2)} km/s`;
    hud.innerHTML =
      `<div class="ls-tele"><div><small>${phase === 'arrival' ? 'TEMPO' : 'MET'}</small>${tlabel}</div>` +
      (S.view !== 'countdown' ? `<div><small>ALT</small>${altTxt}</div><div><small>VEL</small>${velTxt}</div>` : `<div><small>CLIMA</small>${esc(al.weather?.label || '—')}</div>`) +
      `</div><div class="ls-bars">` +
      `<div class="ls-meter m-conf"><small>Confiança</small><i style="width:${conf.toFixed(0)}%"></i></div>` +
      `<div class="ls-meter m-nerv"><small>Nervosismo</small><i style="width:${nerv.toFixed(0)}%"></i></div>` +
      `<div class="ls-cp" aria-label="${cp} pontos de Comando"><small>Comando</small>${'<b>●</b>'.repeat(Math.min(cp, 6))}${cp === 0 ? '<span>0</span>' : ''}</div></div>`;
  }

  // ================================================================ main loop
  function frame(ts) {
    if (!S.alive) return;
    const dtReal = S.last ? Math.min(0.1, (ts - S.last) / 1000) : 0.016;
    S.last = ts;
    try {
      const al = AL();
      if (!al) { if (!S.finishing) gone(); }
      else {
        const slow = S.view === 'climax' ? 0.25 : S.timeScale;
        const dt = dtReal;
        if (S.view === 'countdown') updateCountdown(dtReal);
        else if (S.view === 'ascent') updateAscent(dt, dtReal);
        else if (S.view === 'climax') updateClimax(dtReal);
        else if (S.view === 'replay') updateReplay(dtReal);
        if (S.moodTimer > 0) { S.moodTimer -= dtReal; if (S.moodTimer <= 0 && S.view === 'ascent') setMood('tense'); }
        pumpRadio(dtReal);
        S.hudTimer -= dtReal;
        if (S.hudTimer <= 0) { renderHud(); S.hudTimer = 0.1; }
        S.t += dtReal * (S.view === 'climax' || S.climaxPre || al.pendingIntervention ? slow : 1);
        draw(dtReal * (S.view === 'climax' || S.climaxPre || al.pendingIntervention ? Math.max(0.15, slow) : 1));
      }
    } catch (e) {
      console.error('launch-scene frame:', e);
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- boot: resume at the stored act
  resize();
  renderTeam();
  const v = viewForAct(al0);
  if (v === 'prelaunch') enterPrelaunch();
  else if (v === 'countdown') { enterCountdown(); S.cd = Math.min(COUNT_FROM, 12); }
  else if (v === 'ascent') {
    startAscent(true);
    if (isEnded(al0)) S.endTimer = 0;
  } else if (v === 'climax') { startAscent(true); enterClimax(); }
  else enterResult(true);
  renderTrack(S.view === 'result');
  S.ready = true;
  raf = requestAnimationFrame(frame);

  // app.js closes the scene a moment after activeLaunch clears; a scrub card waits for its "Entendido"
  const requestClose = () => { if (S.awaitingAck && S.alive) return; close(); };
  return { key, close: requestClose, forceClose: close, alive: () => S.alive };
}

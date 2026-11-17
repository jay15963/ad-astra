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
        if (sec === 3 && phase === 'ascent') caption('Sequência de ignição.', 'radio');
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
      if (S.endTimer > (S.exploded ? 2.4 : 2.2) && !S.radioQ.length) enterClimax();
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
      burst(0.5);
      if (/stag|separ|meco/.test(id)) separateStage();
      if (/fairing|les|coifa/.test(id)) dropFairing();
      if (/orbit/.test(id) && phase === 'ascent') { S.engineOn = false; caption('Corte dos motores. Estamos em órbita.', 'telemetry'); }
      if (/tli/.test(id)) { S.engineOn = true; S.flash = 0.5; S.flashColor = PAL.amber; }
      if (/parachute|paraq/.test(id)) S.chute = true;
      if (/powered|descent|descida/.test(id)) S.chute = false;
      if (phase === 'arrival' && i === (al.milestones || []).length - 1) { if (arrivalKind === 'landing') touchdown(); else { S.engineOn = false; S.inOrbit = true; } }
    } else if (m.status === 'anomaly') {
      showStamp(label, 'ANOMALIA', 'warn');
      audio.alarm();
      vibrate([60, 40, 60]);
      setMood('tense', 2);
      S.shake = Math.max(S.shake, 1);
      S.flash = 0.35; S.flashColor = PAL.amber;
      if (/stag|separ|meco/.test(id)) separateStage();
      if (/fairing|les|coifa/.test(id)) dropFairing();
      if (phase === 'arrival' && i === (al.milestones || []).length - 1) { if (arrivalKind === 'landing') touchdown(true); else { S.engineOn = false; S.inOrbit = true; } }
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
    S.particles.length = 0; S.debris.length = 0;
    S.staged = false; S.fairingOff = false; S.exploded = false; S.landed = false; S.engineOn = true; S.frozen = false; S.escaped = null; S.chute = false; S.inOrbit = false;
    S.presented = 0;
    S.clock = 0;
    S.resultFx = null;
    caption('Replay da linha do tempo.', 'event');
    renderTrack();
  }
  function updateReplay(dtReal) {
    const al = AL();
    const ms = al.milestones || [];
    const R = S.replay;
    if (!S.frozen) S.clock += dtReal * R.speed;
    while (R.shown < ms.length && S.clock >= S.profile.times[R.shown]) {
      const m = ms[R.shown];
      S.presented = R.shown + 1;
      const id = m.id || '';
      showStamp(m.label || id, m.status === 'ok' ? 'OK' : m.status === 'anomaly' ? 'ANOMALIA' : m.status === 'fail' ? 'FALHA' : '', m.status === 'ok' ? 'ok' : m.status === 'anomaly' ? 'warn' : 'bad');
      if (m.status !== 'fail' && /stag|separ|meco/.test(id)) separateStage();
      if (m.status !== 'fail' && /fairing|les|coifa/.test(id)) dropFairing();
      if (/orbit/.test(id) && m.status !== 'fail' && phase === 'ascent') S.engineOn = false;
      if (phase === 'arrival' && R.shown === ms.length - 1 && m.status !== 'fail') { if (arrivalKind === 'landing') touchdown(m.status === 'anomaly'); else { S.engineOn = false; S.inOrbit = true; } }
      if (m.status === 'fail') presentFailure(m, R.shown, al, true);
      R.shown++;
      renderTrack();
    }
    const doneAt = (S.profile.times[ms.length - 1] ?? 0) + 2.5 * R.speed;
    if (R.shown >= ms.length && S.clock >= doneAt || (S.frozen && (R.frozenT = (R.frozenT || 0) + dtReal) > 2.5)) {
      S.replay = null;
      ov.classList.remove('ls-replaying');
      enterResult(true);
    }
  }

  // ================================================================ particles & effects
  function cap() { return reduce() ? 120 : 420; }
  function emit(p) { if (S.particles.length < cap()) S.particles.push(p); }
  function burst(power = 1) {
    if (reduce()) return;
    const cx = S.W / 2;
    const cy = S.H * 0.45;
    for (let i = 0; i < 24 * power; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 60 + Math.random() * 140;
      emit({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.7 + Math.random() * 0.5, size: 2.5, grow: 0, color: Math.random() < 0.5 ? PAL.amber : PAL.cream, kind: 'spark', world: false });
    }
  }
  function separateStage() {
    if (S.staged) return;
    S.staged = true;
    audio.thump();
    S.shake = Math.max(S.shake, 0.7);
    if (phase === 'ascent') S.debris.push({ kind: 'stage', oy: 0, x: 0, y: 0, vx: -12, vy: 40, rot: 0, vr: -0.5, life: 0 });
  }
  function dropFairing() {
    if (S.fairingOff) return;
    S.fairingOff = true;
    if (phase !== 'ascent') return;
    S.debris.push({ kind: 'fairL', oy: S.staged ? -58 : -176, x: 0, y: 0, vx: -50, vy: 20, rot: 0, vr: -1.4, life: 0 });
    S.debris.push({ kind: 'fairR', oy: S.staged ? -58 : -176, x: 0, y: 0, vx: 50, vy: 20, rot: 0, vr: 1.4, life: 0 });
  }
  function explode(quiet = false) {
    if (S.exploded && !quiet) return;
    S.exploded = true;
    S.engineOn = false;
    if (!quiet) audio.boom();
    S.flash = 1; S.flashColor = '#fff3d6';
    S.shake = reduce() ? 0 : 2;
    const n = reduce() ? 40 : 160;
    const { x, y } = vehicleScreenPos();
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 30 + Math.random() * 220;
      const fire = Math.random() < 0.6;
      emit({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.8 + Math.random() * 1.8, size: fire ? 4 + Math.random() * 6 : 6 + Math.random() * 10, grow: fire ? 6 : 14, color: fire ? (Math.random() < 0.5 ? PAL.amber : PAL.accent) : '#5b5f6b', kind: fire ? 'fire' : 'smoke', world: true, drag: 1.6 });
    }
    for (let i = 0; i < 7; i++) S.debris.push({ kind: 'chunk', oy: phase === 'arrival' ? 0 : -80, x: 0, y: 0, vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.8) * 120, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8, life: 0 });
  }
  function escape() {
    S.escaped = { t: 0 };
    caption('Torre de escape disparada! Cápsula se afastando.', 'radio');
  }
  function touchdown(hard = false) {
    S.landed = true;
    S.engineOn = false;
    audio.touchdown();
    S.shake = Math.max(S.shake, hard ? 1.2 : 0.5);
    const n = reduce() ? 20 : 90;
    const { x, y } = vehicleScreenPos();
    const groundY = y + 26 * scaleU();
    const dust = body === 'mars' ? '#c97b4a' : '#b8b4a8';
    for (let i = 0; i < n; i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      emit({ x: x + dir * Math.random() * 10, y: groundY, vx: dir * (40 + Math.random() * 160), vy: -Math.random() * 40, life: 0, max: 1.2 + Math.random() * 1.6, size: 4 + Math.random() * 6, grow: 16, color: dust, kind: 'smoke', world: false, drag: 1.2 });
    }
  }

  function scaleU() { return Math.max(0.6, Math.min(1.6, S.H / 620)); }
  function vehicleScreenPos() {
    if (phase === 'arrival') return { x: S.W / 2, y: arrivalKind === 'orbit' ? S.H * 0.36 : landerY() };
    const tele = telemetryAt(S.profile, S.clock);
    const lift = Math.min(1, tele.alt / 0.4);
    return { x: S.W / 2 + Math.min(1, tele.alt / 150) * S.W * 0.05, y: S.H * (0.7 - 0.15 * lift) };
  }
  function landerY() {
    return S.H * 0.4;
  }

  // ================================================================ drawing
  const STARS = Array.from({ length: 140 }, (_, i) => ({ x: (hashStr('sx' + i) % 1000) / 1000, y: (hashStr('sy' + i) % 1000) / 1000, r: 0.4 + (hashStr('sr' + i) % 100) / 70, tw: (hashStr('st' + i) % 628) / 100 }));
  const CLOUDS = Array.from({ length: 14 }, (_, i) => ({ alt: 1.2 + (hashStr('ca' + i) % 1000) / 1000 * 9, x: (hashStr('cx' + i) % 1000) / 1000, w: 60 + hashStr('cw' + i) % 120 }));
  const CRATERS = Array.from({ length: 26 }, (_, i) => ({ x: (hashStr('kx' + i) % 1000) / 1000, d: (hashStr('kd' + i) % 1000) / 1000, r: 6 + hashStr('kr' + i) % 26 }));
  const CROWD = Array.from({ length: 46 }, (_, i) => ({ x: (i + 0.5) / 46 + ((hashStr('px' + i) % 100) / 100 - 0.5) / 60, h: 0.7 + (hashStr('ph' + i) % 100) / 200, sign: hashStr('pg' + i) % 9 === 0, ph: (hashStr('pp' + i) % 628) / 100 }));

  function lerpColor(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round(((pa >> 16) & 255) + ((((pb >> 16) & 255) - ((pa >> 16) & 255)) * t));
    const gg = Math.round(((pa >> 8) & 255) + ((((pb >> 8) & 255) - ((pa >> 8) & 255)) * t));
    const bb = Math.round((pa & 255) + (((pb & 255) - (pa & 255)) * t));
    return `rgb(${r},${gg},${bb})`;
  }
  function skyAt(alt) {
    const w = phase === 'arrival' ? world : 'earth';
    const stops = w === 'mars'
      ? [[0, '#e8a87c', '#c97b4a'], [20, '#b5654a', '#7a3a2a'], [60, '#3a1f2a', '#5b2a26'], [140, '#07060c', '#1a0f14']]
      : w === 'titan'
        ? [[0, '#c98a3a', '#e0a95a'], [40, '#8a5a2a', '#b07a3a'], [140, '#1a1208', '#3a2a14']]
        : w !== 'earth'
          ? [[0, '#05070f', '#0b1020'], [200, '#05070f', '#0b1020']]
          : [[0, '#5aa0c8', '#f4c48f'], [10, '#2f6aa3', '#7fb2d6'], [35, '#122a5c', '#2f5d94'], [80, '#070c1f', '#13204a'], [200, '#03050c', '#0b1020']];
    let i = 0;
    while (i < stops.length - 2 && alt > stops[i + 1][0]) i++;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    const t = b[0] > a[0] ? Math.max(0, Math.min(1, (alt - a[0]) / (b[0] - a[0]))) : 0;
    return [lerpColor(a[1], b[1], t), lerpColor(a[2], b[2], t)];
  }

  function draw(dt) {
    const W = S.W, H = S.H;
    g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    let sx = 0, sy = 0;
    if (S.shake > 0 && !reduce()) {
      const a = S.shake * 5 * scaleU();
      sx = (Math.random() - 0.5) * a;
      sy = (Math.random() - 0.5) * a;
    }
    S.shake = Math.max(0, S.shake - dt * 1.6);
    g.save();
    g.translate(sx, sy);
    if (S.view === 'countdown') drawControlRoom(dt);
    else if (phase === 'arrival' && arrivalKind === 'orbit') drawOrbitArrival(dt);
    else if (phase === 'arrival') drawDescent(dt);
    else drawAscent(dt);
    drawParticles(dt);
    g.restore();
    if (S.flash > 0) {
      g.globalAlpha = Math.min(1, S.flash) * (reduce() ? 0.35 : 0.8);
      g.fillStyle = S.flashColor;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      S.flash = Math.max(0, S.flash - dt * 1.8);
    }
    if (S.view === 'result') drawResultFx(dt);
  }

  function drawStars(alpha, drift = 0) {
    if (alpha <= 0) return;
    g.fillStyle = PAL.cream;
    for (const s of STARS) {
      const x = ((s.x * S.W - drift * (0.3 + s.r * 0.2)) % S.W + S.W) % S.W;
      const tw = reduce() ? 1 : 0.6 + 0.4 * Math.sin(S.t * 2 + s.tw);
      g.globalAlpha = alpha * tw;
      g.fillRect(x, s.y * S.H, s.r, s.r);
    }
    g.globalAlpha = 1;
  }

  // ---------- ascent (side view, following camera)
  function drawAscent(dt) {
    const W = S.W, H = S.H, u = scaleU();
    const tele = telemetryAt(S.profile, S.clock);
    const alt = tele.alt;
    const [top, bottom] = skyAt(alt);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, top);
    grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fillRect(-20, -20, W + 40, H + 40);
    // poster sun near the horizon early on
    if (alt < 20) {
      g.globalAlpha = 1 - alt / 20;
      g.fillStyle = '#ffd59e';
      g.beginPath(); g.arc(W * 0.78, H * 0.62 + alt * 18, 46 * u, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1;
    }
    const drift = Math.pow(Math.max(0, alt), 1.25) * 6;
    drawStars(Math.max(0, Math.min(1, (alt - 25) / 40)), drift);
    // earth limb at high altitude
    if (alt > 60) {
      const k = Math.min(1, (alt - 60) / 140);
      const R = W * (6 - k * 4.2);
      const cy = H + R - H * (0.06 + k * 0.2);
      g.fillStyle = '#1f5f9e';
      g.beginPath(); g.arc(W * 0.5, cy, R, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(142,202,230,0.8)';
      g.lineWidth = 6 * u;
      g.beginPath(); g.arc(W * 0.5, cy, R + 3 * u, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.fillStyle = 'rgba(243,233,210,0.18)';
      for (let i = 0; i < 5; i++) { g.beginPath(); g.ellipse(((i * 0.27 * W - drift * 0.4) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2, cy - R + 18 * u + i * 4, 50 * u, 6 * u, 0, 0, Math.PI * 2); g.fill(); }
    }
    const pos = vehicleScreenPos();
    // clouds (parallax by altitude)
    const pxKm = 150 * u;
    for (const c of CLOUDS) {
      const y = pos.y - (c.alt - alt) * pxKm;
      if (y < -60 || y > H + 60) continue;
      const x = ((c.x * W * 1.6 - drift * 2) % (W * 1.6) + W * 1.6) % (W * 1.6) - W * 0.3;
      g.fillStyle = 'rgba(243,233,210,0.85)';
      g.beginPath();
      g.ellipse(x, y, c.w * u * 0.5, 12 * u, 0, 0, Math.PI * 2);
      g.ellipse(x + c.w * u * 0.2, y - 8 * u, c.w * u * 0.3, 12 * u, 0, 0, Math.PI * 2);
      g.fill();
    }
    // ground, pad, tower and crowd (scroll away quickly)
    const groundY = pos.y + 8 * u + alt * 1000 * 0.9 * u;
    if (groundY < H + 200) {
      g.fillStyle = '#2b3a2e';
      g.fillRect(-20, groundY, W + 40, H);
      g.fillStyle = '#3d5040';
      g.fillRect(-20, groundY, W + 40, 6 * u);
      g.fillStyle = '#6b6f7a';
      g.fillRect(W / 2 - 60 * u, groundY - 6 * u, 120 * u, 8 * u); // pad
      // tower (blueprint truss)
      const tx = W / 2 - 48 * u, th = 210 * u;
      g.strokeStyle = PAL.accent; g.lineWidth = 2 * u;
      g.strokeRect(tx, groundY - th, 14 * u, th);
      for (let y = groundY - th; y < groundY; y += 14 * u) { g.beginPath(); g.moveTo(tx, y); g.lineTo(tx + 14 * u, y + 14 * u); g.stroke(); }
      if (S.clock < 4) { g.beginPath(); g.moveTo(tx + 14 * u, groundY - th * 0.8); g.lineTo(W / 2 - 11 * u, groundY - th * 0.8); g.stroke(); }
      // crowd silhouettes far left/right
      g.fillStyle = '#16202a';
      for (const p of CROWD) {
        if (p.x > 0.32 && p.x < 0.68) continue;
        const bob = reduce() ? 0 : Math.abs(Math.sin(S.t * 6 + p.ph)) * 3 * u * (S.mood === 'happy' ? 2 : 1);
        const x = p.x * W, y = groundY + 20 * u - bob;
        g.beginPath(); g.arc(x, y - 10 * u * p.h, 4 * u, 0, Math.PI * 2); g.fill();
        g.fillRect(x - 4 * u, y - 7 * u * p.h, 8 * u, 12 * u);
      }
      // venting vapor before liftoff
      if (S.clock < 5 && !reduce() && Math.random() < 0.4) emit({ x: W / 2 + 12 * u, y: groundY - 140 * u, vx: 20 + Math.random() * 20, vy: -5, life: 0, max: 1.5, size: 4, grow: 10, color: 'rgba(243,233,210,0.6)', kind: 'smoke', world: true, drag: 0.5 });
    }
    // camera follows: shift world particles as the ground moves away
    const dAlt = alt - S.prevAlt;
    S.prevAlt = alt;
    const camDy = Math.min(60, dAlt * 1000 * 0.9 * u * (alt < 2 ? 1 : 0.03) + (alt >= 2 ? dAlt * 40 : 0));
    for (const p of S.particles) if (p.world) p.y += camDy;
    // debris (stage, fairings, chunks)
    drawDebris(dt, pos, u);
    // rocket
    const tilt = Math.min(1, Math.max(0, (alt - 1) / 140)) * 1.05;
    if (!S.exploded || S.escaped) drawRocket(pos.x, pos.y, tilt, u, dt, tele);
    if (S.escaped) drawEscape(dt, pos, u);
  }

  function drawRocket(x, y, tilt, u, dt, tele) {
    const s = u * 0.95;
    const w = 20 * s;
    const h1 = S.staged ? 0 : 118 * s;
    const h2 = 58 * s;
    const hp = 34 * s;
    if (S.exploded) return;
    g.save();
    g.translate(x, y);
    g.rotate(tilt);
    // exhaust
    if (S.engineOn) {
      const n = reduce() ? 1 : 4;
      const throttle = 0.7 + 0.3 * Math.sin(S.t * 40);
      for (let i = 0; i < n; i++) {
        const spread = (Math.random() - 0.5) * 0.5;
        const v = 180 + Math.random() * 120;
        const ang = tilt + Math.PI / 2 + spread * 0.4;
        const wx = x + Math.cos(tilt + Math.PI / 2) * 6 * s;
        const wy = y + Math.sin(tilt + Math.PI / 2) * 6 * s;
        emit({ x: wx, y: wy, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v + 40, life: 0, max: 0.4 + Math.random() * (tele.alt < 30 ? 1.1 : 0.4), size: 4 * s, grow: tele.alt < 40 ? 22 : 8, color: Math.random() < 0.3 ? '#fff3d6' : PAL.amber, kind: tele.alt < 40 ? 'fire' : 'spark', world: true, drag: 0.8 });
      }
      // flame core
      const fl = (S.staged ? 30 : 46) * s * throttle * (tele.alt > 40 ? 1.6 : 1);
      const fg = g.createLinearGradient(0, 0, 0, fl);
      fg.addColorStop(0, '#fff3d6'); fg.addColorStop(0.4, PAL.amber); fg.addColorStop(1, 'rgba(255,107,53,0)');
      g.fillStyle = fg;
      g.beginPath(); g.moveTo(-w * 0.4, 0); g.quadraticCurveTo(0, fl * 1.2, w * 0.4, 0); g.fill();
    }
    // stage 1
    if (!S.staged) {
      g.fillStyle = PAL.cream;
      g.fillRect(-w / 2, -h1, w, h1);
      g.fillStyle = PAL.flag;
      g.fillRect(-w / 2, -h1 * 0.55, w, 10 * s);
      g.fillStyle = PAL.navy;
      g.fillRect(-w / 2, -h1, w, 4 * s);
      // fins
      g.fillStyle = PAL.accent;
      g.beginPath(); g.moveTo(-w / 2, -18 * s); g.lineTo(-w / 2 - 10 * s, 4 * s); g.lineTo(-w / 2, 0); g.fill();
      g.beginPath(); g.moveTo(w / 2, -18 * s); g.lineTo(w / 2 + 10 * s, 4 * s); g.lineTo(w / 2, 0); g.fill();
      g.fillStyle = '#3a3f4a';
      g.fillRect(-w * 0.35, 0, w * 0.7, 5 * s);
    } else {
      g.fillStyle = '#3a3f4a';
      g.fillRect(-w * 0.28, 0, w * 0.56, 6 * s);
    }
    // stage 2
    const y2 = -h1 - h2;
    g.fillStyle = PAL.cream;
    g.fillRect(-w / 2, y2, w, h2);
    g.fillStyle = PAL.navy;
    g.fillRect(-w / 2, y2 + h2 * 0.3, w, 5 * s);
    // payload
    const yp = y2;
    if (!S.fairingOff) {
      g.fillStyle = crewed ? PAL.cream : '#e8e1cf';
      g.beginPath(); g.moveTo(-w / 2, yp); g.quadraticCurveTo(-w / 2, yp - hp, 0, yp - hp - 6 * s); g.quadraticCurveTo(w / 2, yp - hp, w / 2, yp); g.fill();
      if (crewed) { g.strokeStyle = PAL.accent; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(0, yp - hp - 6 * s); g.lineTo(0, yp - hp - 22 * s); g.stroke(); }
    } else {
      g.fillStyle = crewed ? '#d9d2c0' : PAL.amber;
      if (crewed) { g.beginPath(); g.moveTo(-w / 2, yp); g.lineTo(-w * 0.2, yp - 18 * s); g.lineTo(w * 0.2, yp - 18 * s); g.lineTo(w / 2, yp); g.fill(); }
      else { g.fillRect(-w * 0.35, yp - 14 * s, w * 0.7, 14 * s); g.fillStyle = '#1f5f9e'; g.fillRect(-w * 1.2, yp - 10 * s, w * 0.7, 6 * s); g.fillRect(w * 0.5, yp - 10 * s, w * 0.7, 6 * s); }
    }
    // anomaly glow
    if (S.shake > 0.5 && !S.exploded) { g.strokeStyle = PAL.amber; g.lineWidth = 2; g.strokeRect(-w / 2 - 3, y2 - 3, w + 6, h2 + 6); }
    g.restore();
  }

  function drawDebris(dt, pos, u) {
    for (const d of S.debris) {
      d.life += dt;
      d.vy += 60 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.vr * dt;
      g.save();
      g.translate(pos.x + d.x * u, pos.y + ((d.oy || 0) + d.y) * u);
      g.rotate(d.rot);
      g.globalAlpha = Math.max(0, 1 - d.life / 5);
      if (d.kind === 'stage') { g.fillStyle = PAL.cream; g.fillRect(-10 * u, 0, 20 * u, 112 * u); g.fillStyle = PAL.flag; g.fillRect(-10 * u, 50 * u, 20 * u, 10 * u); }
      else if (d.kind === 'chunk') { g.fillStyle = '#6b6f7a'; g.fillRect(-5 * u, -4 * u, 10 * u, 8 * u); }
      else { g.fillStyle = '#e8e1cf'; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(d.kind === 'fairL' ? -12 * u : 12 * u, -16 * u, 0, -34 * u); g.lineTo(0, 0); g.fill(); }
      g.restore();
    }
    g.globalAlpha = 1;
    S.debris = S.debris.filter((d) => d.life < 5);
  }

  function drawEscape(dt, pos, u) {
    S.escaped.t += dt;
    const t = S.escaped.t;
    const x = pos.x - t * 50 * u;
    const y = pos.y - 190 * u - t * 90 * u + t * t * 18 * u;
    g.fillStyle = PAL.cream;
    g.beginPath(); g.moveTo(x - 10 * u, y); g.lineTo(x - 4 * u, y - 16 * u); g.lineTo(x + 4 * u, y - 16 * u); g.lineTo(x + 10 * u, y); g.fill();
    if (t > 2) { // parachute
      g.fillStyle = PAL.accent;
      g.beginPath(); g.arc(x, y - 50 * u, 22 * u, Math.PI, 0); g.fill();
      g.strokeStyle = PAL.cream; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x - 22 * u, y - 50 * u); g.lineTo(x, y - 16 * u); g.lineTo(x + 22 * u, y - 50 * u); g.stroke();
    } else if (!reduce()) emit({ x, y: y + 2, vx: 30, vy: 80, life: 0, max: 0.5, size: 3, grow: 8, color: PAL.amber, kind: 'fire', world: false });
  }

  // ---------- arrival (descent over a cratered surface)
  function drawDescent(dt) {
    const W = S.W, H = S.H, u = scaleU();
    const tele = telemetryAt(S.profile, S.clock);
    const alt = Math.max(0, tele.alt);
    const [top, bottom] = skyAt(alt);
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, top); grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fillRect(-20, -20, W + 40, H + 40);
    const airless = world === 'moon';
    drawStars(airless ? 1 : Math.min(1, alt / 80) * 0.6, S.clock * 2);
    if (airless) { // Earth hanging in the lunar sky
      g.fillStyle = '#1f5f9e';
      g.beginPath(); g.arc(W * 0.8, H * 0.14, 18 * u, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(243,233,210,0.7)';
      g.beginPath(); g.ellipse(W * 0.8 - 4 * u, H * 0.14 - 4 * u, 8 * u, 3 * u, 0.4, 0, Math.PI * 2); g.fill();
    }
    const ly = landerY();
    const dist = S.landed || alt <= 0.0005 ? 24 * u : Math.log10(1 + alt * 50) * H * 0.18 + 24 * u;
    const surf = ly + dist;
    const near = Math.max(0, Math.min(1, 1 - (dist - 24 * u) / (H * 0.6)));
    const ground = { mars: ['#9c4a24', '#c1683a'], titan: ['#7a5326', '#a8743a'], earth: ['#123e6b', '#1f5f9e'] }[world] || ['#6e6d68', '#9a9a94'];
    if (surf < H + 40) {
      const sg = g.createLinearGradient(0, surf, 0, H);
      sg.addColorStop(0, ground[1]); sg.addColorStop(1, ground[0]);
      g.fillStyle = sg;
      g.beginPath();
      g.moveTo(-20, surf + 10 * u);
      for (let i = 0; i <= 12; i++) g.lineTo((i / 12) * (W + 40) - 20, surf + Math.sin(i * 1.7) * 6 * u * (1 + near));
      g.lineTo(W + 20, H + 20); g.lineTo(-20, H + 20); g.fill();
      // craters with perspective (bigger as we get close); waves on the ocean
      for (const c of CRATERS) {
        if (world === 'earth') {
          const wy = surf + 8 * u + c.d * (H - surf);
          g.strokeStyle = 'rgba(243,233,210,0.35)'; g.lineWidth = 1.5;
          const wx = ((c.x * W + S.t * 12 * (0.5 + c.d)) % (W + 40)) - 20;
          g.beginPath(); g.moveTo(wx - c.r * u, wy); g.quadraticCurveTo(wx, wy - 4 * u, wx + c.r * u, wy); g.stroke();
          continue;
        }
        const cy = surf + 8 * u + c.d * (H - surf);
        if (cy > H + 30) continue;
        const sc = (0.4 + near * 1.6) * (0.5 + c.d);
        const cx = (c.x - 0.5) * W * (1 + near) + W / 2;
        g.fillStyle = 'rgba(0,0,0,0.22)';
        g.beginPath(); g.ellipse(cx, cy, c.r * sc * u, c.r * sc * u * 0.35, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = 'rgba(243,233,210,0.25)'; g.lineWidth = 1.5;
        g.beginPath(); g.ellipse(cx, cy - 1, c.r * sc * u, c.r * sc * u * 0.35, 0, Math.PI, Math.PI * 2); g.stroke();
      }
    }
    drawDebris(dt, { x: W / 2, y: ly }, u);
    if (S.exploded) return;
    const vy = S.landed ? surf - 24 * u : ly;
    if (S.chute) { // supersonic parachute (Mars/Titan/Earth entries)
      const sway = reduce() ? 0 : Math.sin(S.t * 1.5) * 4 * u;
      g.fillStyle = PAL.accent;
      g.beginPath(); g.arc(W / 2 + sway, vy - 80 * u, 34 * u, Math.PI, 0); g.fill();
      g.fillStyle = PAL.cream;
      g.fillRect(W / 2 + sway - 34 * u, vy - 82 * u, 68 * u, 4 * u);
      g.strokeStyle = PAL.cream; g.lineWidth = 1;
      g.beginPath(); g.moveTo(W / 2 + sway - 34 * u, vy - 80 * u); g.lineTo(W / 2, vy - 26 * u); g.lineTo(W / 2 + sway + 34 * u, vy - 80 * u); g.stroke();
    }
    if (world === 'earth') drawCapsule(W / 2, vy, u);
    else drawLander(W / 2, vy, u);
  }

  function drawCapsule(x, y, u) {
    g.save();
    g.translate(x, y);
    // heat-shield glow during entry
    const tele = telemetryAt(S.profile, S.clock);
    if (tele.alt > 40 && tele.alt < 110 && !S.landed) {
      g.fillStyle = 'rgba(255,107,53,' + (0.5 + 0.3 * Math.sin(S.t * 20)).toFixed(2) + ')';
      g.beginPath(); g.ellipse(0, 16 * u, 26 * u, 14 * u, 0, 0, Math.PI); g.fill();
    }
    g.fillStyle = '#d9d2c0';
    g.beginPath(); g.moveTo(-22 * u, 12 * u); g.lineTo(-8 * u, -18 * u); g.lineTo(8 * u, -18 * u); g.lineTo(22 * u, 12 * u); g.closePath(); g.fill();
    g.fillStyle = '#5b4a3a'; g.fillRect(-22 * u, 10 * u, 44 * u, 5 * u);
    g.fillStyle = PAL.navy; g.fillRect(-4 * u, -8 * u, 8 * u, 6 * u);
    g.fillStyle = PAL.flag; g.fillRect(-12 * u, 2 * u, 24 * u, 2 * u);
    g.restore();
  }

  // ---------- arrival without landing: orbital insertion over a big planet disc
  function drawOrbitArrival(dt) {
    const W = S.W, H = S.H, u = scaleU();
    const tele = telemetryAt(S.profile, S.clock);
    const A0 = S.profile.keys[0]?.alt || 3000;
    const k = Math.max(0, Math.min(1, 1 - tele.alt / A0));
    g.fillStyle = '#05070f';
    g.fillRect(-20, -20, W + 40, H + 40);
    drawStars(1, S.clock * 3);
    const R = W * (0.55 + 1.6 * k);
    const cx = W / 2, cy = H + R * 0.62;
    const col = { moon: ['#9a9a94', '#6e6d68'], mars: ['#c1683a', '#7a3a2a'], jupiter: ['#d8b78a', '#a0703a'], saturn: ['#e0b070', '#a07840'], titan: ['#d09a4a', '#8a5a2a'], earth: ['#1f5f9e', '#123e6b'] }[world] || ['#9a9a94', '#6e6d68'];
    const pg = g.createRadialGradient(cx - R * 0.3, cy - R * 0.5, R * 0.1, cx, cy, R);
    pg.addColorStop(0, col[0]); pg.addColorStop(1, col[1]);
    g.fillStyle = pg;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    if (world === 'jupiter' || world === 'saturn') {
      for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? 'rgba(122,74,40,0.35)' : 'rgba(243,233,210,0.18)'; g.fillRect(cx - R, cy - R + i * R * 0.12, R * 2, R * 0.06); }
    } else {
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (const c of CRATERS.slice(0, 14)) { g.beginPath(); g.arc(cx + (c.x - 0.5) * R * 1.4, cy - R * (0.35 + c.d * 0.6), c.r * u * (0.4 + k), 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
    if (world !== 'moon') { g.strokeStyle = 'rgba(243,233,210,0.25)'; g.lineWidth = 4 * u; g.beginPath(); g.arc(cx, cy, R + 3 * u, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); }
    if (S.inOrbit) { // captured: draw the orbit ellipse
      g.setLineDash([6 * u, 6 * u]); g.strokeStyle = PAL.teal; g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(cx, cy, R * 1.15, R * 0.95, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.setLineDash([]);
    }
    drawDebris(dt, { x: W / 2, y: H * 0.36 }, u);
    if (S.exploded) return;
    const x = W * (0.5 + 0.06 * Math.sin(S.clock * 0.05)), y = H * 0.36;
    drawProbe(x, y, u);
  }

  function drawProbe(x, y, u) {
    g.save();
    g.translate(x, y);
    if (S.engineOn) { // retro burn points forward (left)
      const fl = (18 + Math.random() * 8) * u;
      g.fillStyle = PAL.amber;
      g.beginPath(); g.moveTo(-14 * u, -4 * u); g.lineTo(-14 * u - fl, 0); g.lineTo(-14 * u, 4 * u); g.fill();
      if (!reduce() && Math.random() < 0.5) emit({ x: x - 16 * u, y, vx: -120, vy: (Math.random() - 0.5) * 20, life: 0, max: 0.5, size: 2, grow: 5, color: PAL.amber, kind: 'spark', world: false });
    }
    g.fillStyle = '#1f5f9e';
    g.fillRect(-6 * u, -34 * u, 12 * u, 24 * u);
    g.fillRect(-6 * u, 10 * u, 12 * u, 24 * u);
    g.strokeStyle = 'rgba(243,233,210,0.5)'; g.lineWidth = 1;
    for (let i = 0; i < 3; i++) { g.strokeRect(-6 * u, (-34 + i * 8) * u, 12 * u, 8 * u); g.strokeRect(-6 * u, (10 + i * 8) * u, 12 * u, 8 * u); }
    g.fillStyle = '#d4a017';
    g.fillRect(-14 * u, -10 * u, 28 * u, 20 * u);
    g.fillStyle = PAL.cream;
    g.beginPath(); g.ellipse(10 * u, -14 * u, 4 * u, 9 * u, -0.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = PAL.flag; g.fillRect(-14 * u, 6 * u, 28 * u, 2 * u);
    g.restore();
  }

  function drawLander(x, y, u) {
    g.save();
    g.translate(x, y);
    if (S.engineOn) {
      const fl = (20 + Math.random() * 8) * u;
      const fg = g.createLinearGradient(0, 14 * u, 0, 14 * u + fl);
      fg.addColorStop(0, '#fff3d6'); fg.addColorStop(1, 'rgba(255,183,3,0)');
      g.fillStyle = fg;
      g.beginPath(); g.moveTo(-6 * u, 14 * u); g.lineTo(0, 14 * u + fl * 1.4); g.lineTo(6 * u, 14 * u); g.fill();
      if (!reduce() && Math.random() < 0.6) emit({ x, y: y + 20 * u, vx: (Math.random() - 0.5) * 30, vy: 120, life: 0, max: 0.4, size: 2, grow: 6, color: PAL.amber, kind: 'spark', world: false });
    }
    // legs
    g.strokeStyle = PAL.steel; g.lineWidth = 2.5 * u;
    g.beginPath(); g.moveTo(-12 * u, 4 * u); g.lineTo(-24 * u, 24 * u); g.moveTo(12 * u, 4 * u); g.lineTo(24 * u, 24 * u); g.stroke();
    g.fillStyle = PAL.steel;
    g.fillRect(-28 * u, 23 * u, 8 * u, 3 * u); g.fillRect(20 * u, 23 * u, 8 * u, 3 * u);
    // descent stage (gold foil) + ascent module
    g.fillStyle = '#d4a017';
    g.beginPath(); g.moveTo(-16 * u, -2 * u); g.lineTo(-12 * u, 10 * u); g.lineTo(12 * u, 10 * u); g.lineTo(16 * u, -2 * u); g.lineTo(12 * u, -10 * u); g.lineTo(-12 * u, -10 * u); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(11,16,32,0.35)'; g.lineWidth = 1;
    for (let i = -10; i < 12; i += 5) { g.beginPath(); g.moveTo(i * u, -10 * u); g.lineTo((i + 3) * u, 10 * u); g.stroke(); }
    g.fillStyle = PAL.cream;
    g.fillRect(-10 * u, -26 * u, 20 * u, 16 * u);
    g.fillStyle = PAL.navy;
    g.fillRect(-5 * u, -22 * u, 10 * u, 5 * u);
    g.fillStyle = PAL.flag;
    g.fillRect(-10 * u, -12 * u, 20 * u, 2 * u);
    g.fillStyle = '#3a3f4a';
    g.fillRect(-4 * u, 10 * u, 8 * u, 4 * u);
    g.restore();
  }

  /** Arrival countdown: the control room's big screen shows the target and the approach path. */
  function drawBigScreen(x, y, w, h, u) {
    const col = { moon: '#9a9a94', mars: '#c1683a', jupiter: '#d8b78a', saturn: '#e0b070', titan: '#d09a4a', earth: '#1f5f9e' }[world] || '#9a9a94';
    const R = Math.min(w, h) * 0.32;
    const cx = x + w * 0.62, cy = y + h * 0.5;
    g.fillStyle = col;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath(); g.arc(cx + R * 0.35, cy, R, -Math.PI / 2, Math.PI / 2); g.fill();
    // approach path: dashed arc ending at the target, a blinking dot for the craft
    g.setLineDash([5 * u, 5 * u]); g.strokeStyle = PAL.teal; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x + w * 0.08, y + h * 0.15); g.quadraticCurveTo(x + w * 0.3, y + h * 0.9, cx - R * 0.7, cy + R * 0.7); g.stroke();
    g.setLineDash([]);
    const f = Math.max(0, Math.min(1, 1 - S.cd / COUNT_FROM)) * 0.85;
    const px = (1 - f) * (1 - f) * (x + w * 0.08) + 2 * (1 - f) * f * (x + w * 0.3) + f * f * (cx - R * 0.7);
    const py = (1 - f) * (1 - f) * (y + h * 0.15) + 2 * (1 - f) * f * (y + h * 0.9) + f * f * (cy + R * 0.7);
    if (Math.floor(S.t * 3) % 2 === 0) { g.fillStyle = PAL.amber; g.beginPath(); g.arc(px, py, 4 * u, 0, Math.PI * 2); g.fill(); }
    // scanlines (retro screen)
    g.fillStyle = 'rgba(142,202,230,0.05)';
    for (let yy = y; yy < y + h; yy += 4) g.fillRect(x, yy, w, 1);
  }

  // ---------- control room (countdown)
  function drawControlRoom() {
    const W = S.W, H = S.H, u = scaleU();
    const al = AL();
    const risk = toPct(al?.weather?.risk) ?? 10;
    const wlabel = String(al?.weather?.label || '').toLowerCase();
    const rain = risk > 55 || /chuva|tempest|raio/.test(wlabel);
    const cloudy = rain || risk > 30 || /nubl|vento|nuvem/.test(wlabel);
    // wall
    g.fillStyle = '#0f1a33';
    g.fillRect(-20, -20, W + 40, H + 40);
    // blueprint grid
    g.strokeStyle = 'rgba(142,202,230,0.07)'; g.lineWidth = 1;
    for (let x = 0; x < W; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y < H; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    // window to the pad
    const wx = W * 0.06, wy = H * 0.05, ww = W * 0.88, wh = H * 0.5;
    const arr = phase === 'arrival';
    const sky = g.createLinearGradient(0, wy, 0, wy + wh);
    if (arr) { sky.addColorStop(0, '#03050c'); sky.addColorStop(1, '#0b1530'); }
    else { sky.addColorStop(0, cloudy ? '#55657a' : '#5aa0c8'); sky.addColorStop(1, cloudy ? '#8b95a3' : '#f4c48f'); }
    g.fillStyle = sky;
    g.fillRect(wx, wy, ww, wh);
    g.save();
    g.beginPath(); g.rect(wx, wy, ww, wh); g.clip();
    if (arr) drawBigScreen(wx, wy, ww, wh, u);
    else if (cloudy) {
      g.fillStyle = 'rgba(60,70,85,0.7)';
      for (let i = 0; i < 6; i++) { const cx = wx + ((i * 0.21 * ww + S.t * 8) % (ww + 120)) - 60; g.beginPath(); g.ellipse(cx, wy + 20 * u + (i % 3) * 14 * u, 60 * u, 14 * u, 0, 0, Math.PI * 2); g.fill(); }
    }
    // distant pad + rocket
    const gy = wy + wh * 0.8;
    if (!arr) {
    g.fillStyle = '#2b3a2e'; g.fillRect(wx, gy, ww, wh);
    const rx = wx + ww * 0.5;
    g.fillStyle = PAL.cream; g.fillRect(rx - 5 * u, gy - 70 * u, 10 * u, 70 * u);
    g.beginPath(); g.moveTo(rx - 5 * u, gy - 70 * u); g.lineTo(rx, gy - 84 * u); g.lineTo(rx + 5 * u, gy - 70 * u); g.fill();
    g.fillStyle = PAL.flag; g.fillRect(rx - 5 * u, gy - 40 * u, 10 * u, 4 * u);
    g.strokeStyle = PAL.accent; g.lineWidth = 1.5 * u; g.strokeRect(rx - 22 * u, gy - 90 * u, 8 * u, 90 * u);
    if (!reduce() && Math.random() < 0.3) emit({ x: rx + 6 * u, y: gy - 50 * u, vx: 10 + Math.random() * 10, vy: -4, life: 0, max: 1.6, size: 2, grow: 6, color: 'rgba(243,233,210,0.7)', kind: 'smoke', world: false, drag: 0.4 });
    // ignition glow in the last seconds
    if (S.cd < 3) { g.fillStyle = `rgba(255,183,3,${0.5 * (1 - S.cd / 3)})`; g.beginPath(); g.ellipse(rx, gy, 30 * u, 8 * u, 0, 0, Math.PI * 2); g.fill(); }
    }
    // crowd outside (excitement grows near T-0, cheers on happy mood)
    const excite = 1 - S.cd / COUNT_FROM;
    g.fillStyle = '#16202a';
    for (const p of CROWD) {
      const bob = reduce() ? 0 : Math.abs(Math.sin(S.t * (3 + excite * 6) + p.ph)) * (1 + excite * 4) * u;
      const x = wx + p.x * ww, y = wy + wh - bob;
      g.beginPath(); g.arc(x, y - 16 * u * p.h, 5 * u, 0, Math.PI * 2); g.fill();
      g.fillRect(x - 5 * u, y - 12 * u * p.h, 10 * u, 16 * u);
      if (p.sign) { g.fillStyle = PAL.accent; g.fillRect(x - 7 * u, y - 34 * u * p.h - bob, 14 * u, 8 * u); g.fillStyle = '#16202a'; }
    }
    if (rain && !reduce() && !arr) {
      g.strokeStyle = 'rgba(200,220,240,0.5)'; g.lineWidth = 1;
      for (let i = 0; i < 50; i++) { const x = wx + ((i * 37 + S.t * 300) % ww); const y = wy + ((i * 53 + S.t * 600) % wh); g.beginPath(); g.moveTo(x, y); g.lineTo(x - 3, y + 10); g.stroke(); }
    }
    g.restore();
    g.strokeStyle = PAL.cream; g.lineWidth = 3 * u; g.strokeRect(wx, wy, ww, wh);
    g.beginPath(); g.moveTo(wx + ww / 3, wy); g.lineTo(wx + ww / 3, wy + wh); g.moveTo(wx + ww * 2 / 3, wy); g.lineTo(wx + ww * 2 / 3, wy + wh); g.stroke();
    // HOLD lamp
    if (al?.pendingHold && Math.floor(S.t * 2) % 2 === 0) {
      g.fillStyle = PAL.amber; g.beginPath(); g.arc(W - 22 * u, 20 * u, 8 * u, 0, Math.PI * 2); g.fill();
    }
    // consoles in tiers
    for (let row = 0; row < 2; row++) {
      const cy = H * (0.66 + row * 0.17);
      const cw = W * (0.86 + row * 0.1);
      const cx = (W - cw) / 2;
      g.fillStyle = row ? '#1a2a4d' : '#14223f';
      g.beginPath(); g.moveTo(cx + 14 * u, cy); g.lineTo(cx + cw - 14 * u, cy); g.lineTo(cx + cw, cy + 40 * u); g.lineTo(cx, cy + 40 * u); g.fill();
      const n = 4 + row;
      for (let i = 0; i < n; i++) {
        const sx = cx + 20 * u + i * (cw - 40 * u) / n;
        const sw = (cw - 40 * u) / n - 8 * u;
        g.fillStyle = '#071226'; g.fillRect(sx, cy + 6 * u, sw, 18 * u);
        g.strokeStyle = i % 2 ? PAL.teal : PAL.amber; g.lineWidth = 1.2;
        g.beginPath();
        for (let k = 0; k <= 12; k++) { const px = sx + (k / 12) * sw; const py = cy + 15 * u + Math.sin(S.t * (2 + i) + k * 0.9 + row) * 5 * u * (0.4 + excite); k ? g.lineTo(px, py) : g.moveTo(px, py); }
        g.stroke();
        const on = Math.floor(S.t * (1.5 + i * 0.7)) % 3 !== 0;
        g.fillStyle = on ? (al?.pendingHold && i === 1 ? PAL.red : PAL.teal) : '#24324f';
        g.fillRect(sx + sw - 6 * u, cy + 28 * u, 4 * u, 4 * u);
      }
    }
  }

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
  raf = requestAnimationFrame(frame);

  // app.js closes the scene a moment after activeLaunch clears; a scrub card waits for its "Entendido"
  const requestClose = () => { if (S.awaitingAck && S.alive) return; close(); };
  return { key, close: requestClose, forceClose: close, alive: () => S.alive };
}

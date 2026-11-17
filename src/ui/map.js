// Aba Mapa: vista esquemática do sistema (Terra-Lua, sistema interno, sistema solar) em canvas 2D,
// mapa de metrô das rotas, janelas de lançamento, missões em trânsito, névoa de guerra e presença dos rivais.
// A UI só lê o estado (store.state / store.query); nunca muta. Funções puras exportadas para testes em Node.

import { weeksToText, formatTurn } from '../core/time.js';
import { makeRng } from '../core/rng.js';

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const OK_OUTCOMES = ['total', 'partial'];
const CAL_OK = ['success', 'partial'];
const LINE_COLORS = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#f8961e', '#9b5de5', '#90be6d', '#ff6b6b', '#4895ef', '#e9c46a', '#43aa8b', '#b5179e'];
const FALLBACK_ACTOR_COLORS = ['#4895ef', '#e63946', '#f4a261', '#2a9d8f', '#9b5de5', '#ffd166', '#06d6a0', '#ff8fab'];
const FOG_LABEL = { known: 'Explorado', partial: 'Visitado por rivais', unknown: 'Inexplorado' };
const DEFAULT_LEVELS = [
  { id: 'earth_moon', name: 'Terra-Lua', short: 'Terra-Lua', focus: 'earth', span: 104 },
  { id: 'inner', name: 'Sistema interno', short: 'Interno', focus: 'sun', span: 1060 },
  { id: 'solar', name: 'Sistema solar', short: 'Solar', focus: 'sun', span: 2760 },
];

/* ------------------------------------------------------------------ */
/* Acesso defensivo a dados e estado                                   */
/* ------------------------------------------------------------------ */

const arr = (x) => (Array.isArray(x) ? x : []);
const asList = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []); // firsts: "id" or ["id", ...]
const DEG = Math.PI / 180;

export function getBodies(data) {
  return arr(data?.bodies?.bodies);
}
export function getLevels(data) {
  const l = arr(data?.bodies?.levels);
  return l.length ? l : DEFAULT_LEVELS;
}
function bodyById(data, id) {
  return data?.index?.bodies?.[id] || getBodies(data).find((b) => b.id === id) || null;
}
function getDestinations(data) {
  return arr(data?.destinations?.destinations);
}
function destById(data, id) {
  return data?.index?.destinations?.[id] || getDestinations(data).find((d) => d.id === id) || null;
}
function calDef(data, id) {
  return data?.index?.calendar?.[id] || arr(data?.calendar?.missions).find((m) => m.id === id) || null;
}

/** Wraps store.query so missing/stub queries return undefined instead of throwing. */
export function makeQuery(store) {
  return (name, ...args) => {
    try {
      return store?.query?.(name, ...args);
    } catch {
      return undefined;
    }
  };
}

/** Where each destination sits: bodies.json anchors first, then destinations.json `body` as fallback. */
export function destAnchors(data) {
  const out = {};
  for (const b of getBodies(data)) {
    for (const a of arr(b.destinations)) out[a.id] = { bodyId: b.id, anchor: a };
  }
  getDestinations(data).forEach((d, i) => {
    if (out[d.id]) return;
    const bodyId = bodyById(data, d.body) ? d.body : 'earth';
    out[d.id] = { bodyId, anchor: { id: d.id, anchor: 'ring', r: 0, angle: (i * 47) % 360, label: d.name } };
  });
  return out;
}

export function destName(data, id) {
  return destById(data, id)?.name || destAnchors(data)[id]?.anchor?.label || data?.bodies?.stations?.[id] || id;
}

function destBodyId(data, destId) {
  return destAnchors(data)[destId]?.bodyId || destById(data, destId)?.body || null;
}

/** Bodies that a milestone id belongs to (from bodies.json `milestones`, or destinations.json `firsts`). */
function milestoneBody(data, milestoneId) {
  const base = String(milestoneId).split(':')[0];
  for (const b of getBodies(data)) if (arr(b.milestones).includes(base)) return b.id;
  for (const d of getDestinations(data)) {
    const f = d.firsts || {};
    if ([].concat(f.crewed ?? [], f.robotic ?? []).includes(base)) return destBodyId(data, d.id);
  }
  return null;
}

export function actorInfo(state, data, id) {
  const a = state?.actors?.[id] || data?.index?.actors?.[id] || {};
  let color = a.color;
  if (!color) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    color = FALLBACK_ACTOR_COLORS[h % FALLBACK_ACTOR_COLORS.length];
  }
  return { id, name: a.name || a.short || id, short: a.short || a.name || id, flag: a.flag || '', color };
}

/* ------------------------------------------------------------------ */
/* Layout esquemático                                                  */
/* ------------------------------------------------------------------ */

/** Body angle (deg) at a turn. Planets with `syncWindow` are phased so the window opens at the right alignment. */
function bodyAngle(data, body, turn, memo) {
  const o = body.orbit;
  if (!o) return 0;
  if (!o.periodWeeks) return o.angle0 || 0;
  let a0 = o.angle0 || 0;
  const sync = arr(o.syncWindow).map((id) => destById(data, id)?.window).find((w) => w?.periodWeeks);
  if (sync && memo !== 'nosync') {
    const earth = bodyById(data, 'earth');
    if (earth?.orbit?.periodWeeks) {
      const T = sync.phaseTurn || 0;
      const eA = bodyAngle(data, earth, T, 'nosync');
      a0 = eA + (o.leadDeg ?? 44) - (360 * T) / o.periodWeeks;
    }
  }
  return a0 + (360 * turn) / o.periodWeeks;
}

/** World positions {x, y} for every body at `turn` (y grows downward like the canvas). */
export function bodyPositions(data, turn = 0) {
  const pos = {};
  const bodies = getBodies(data);
  const place = (b, depth = 0) => {
    if (pos[b.id] || depth > 6) return pos[b.id];
    let px = 0;
    let py = 0;
    if (b.parent) {
      const p = bodies.find((x) => x.id === b.parent);
      const pp = p ? place(p, depth + 1) : null;
      if (pp) ({ x: px, y: py } = pp);
    }
    const r = b.orbit?.radius || 0;
    const ang = bodyAngle(data, b, turn) * DEG;
    pos[b.id] = { x: px + r * Math.cos(ang), y: py - r * Math.sin(ang), angle: ang };
    return pos[b.id];
  };
  for (const b of bodies) place(b);
  return pos;
}

/* ------------------------------------------------------------------ */
/* Janelas de lançamento                                               */
/* ------------------------------------------------------------------ */

/** Periodic window from destinations.window = {periodWeeks, phaseTurn, openWeeks}. Close turn is inclusive. */
export function computeWindow(win, fromTurn) {
  if (!win || !(win.periodWeeks > 0)) return null;
  const P = win.periodWeeks;
  const ph = win.phaseTurn || 0;
  const ow = Math.max(1, win.openWeeks || 8);
  let open = ph + Math.floor((fromTurn - ph) / P) * P;
  if (fromTurn > open + ow - 1) open += P;
  return { openTurn: open, closeTurn: open + ow - 1, periodWeeks: P };
}

/**
 * Window status for a destination: null when it has no window constraint.
 * Uses the catalog query when available and sane; falls back to destinations.window.
 */
export function windowFor(state, data, destId, q) {
  const turn = state?.turn ?? 0;
  const dest = destById(data, destId);
  let w = q ? q('catalog/window', destId) : undefined;
  let openTurn;
  let closeTurn;
  if (w && Number.isFinite(w.openTurn) && (w.closeTurn == null || w.closeTurn >= turn)) {
    openTurn = w.openTurn;
    closeTurn = w.closeTurn ?? Infinity;
  } else {
    const c = computeWindow(dest?.window, turn);
    if (!c) return null;
    ({ openTurn, closeTurn } = c);
  }
  if (!Number.isFinite(closeTurn)) return null; // destination always reachable
  const period = dest?.window?.periodWeeks || null;
  const open = turn >= openTurn && turn <= closeTurn;
  const weeksToOpen = Math.max(0, openTurn - turn);
  const weeksLeft = open ? closeTurn - turn + 1 : 0;
  const cycle = period ? (open ? 1 : Math.max(0, Math.min(1, 1 - weeksToOpen / period))) : open ? 1 : 0.5;
  return { destId, openTurn, closeTurn, open, weeksToOpen, weeksLeft, cycle, period };
}

/** Is a launch turn inside the window of a destination? (null = no window rule) */
function launchInWindow(state, data, destId, launchTurn, q) {
  const dest = destById(data, destId);
  const c = computeWindow(dest?.window, launchTurn);
  if (c) return launchTurn >= c.openTurn && launchTurn <= c.closeTurn ? true : c;
  const w = windowFor(state, data, destId, q);
  if (!w) return null;
  return launchTurn >= w.openTurn && launchTurn <= w.closeTurn ? true : w;
}

/** One window line per body ("próxima janela para Marte em 9 meses"). */
export function windowSummaries(state, data, q) {
  const groups = new Map();
  const ids = new Set([...getDestinations(data).map((d) => d.id), ...Object.keys(destAnchors(data))]);
  for (const id of ids) {
    const w = windowFor(state, data, id, q);
    if (!w) continue;
    const bodyId = destBodyId(data, id) || id;
    const key = `${bodyId}|${w.openTurn}`;
    if (!groups.has(key)) groups.set(key, { ...w, bodyId, destIds: [] });
    groups.get(key).destIds.push(id);
  }
  const out = [...groups.values()].sort((a, b) => a.weeksToOpen - b.weeksToOpen);
  // keep only the next window per body; then open windows first, nearer worlds first (Marte before Júpiter)
  const seen = new Set();
  const dist = (id) => {
    const b = bodyById(data, id);
    const p = b?.parent && b.parent !== 'sun' ? bodyById(data, b.parent) : b;
    return p?.orbit?.radius ?? 1e9;
  };
  return out
    .filter((w) => (seen.has(w.bodyId) ? false : (seen.add(w.bodyId), true)))
    .sort((a, b) => (b.open - a.open) || dist(a.bodyId) - dist(b.bodyId))
    .map((w) => ({
    ...w,
    bodyName: bodyById(data, w.bodyId)?.name || destName(data, w.bodyId),
    text: windowText(w, bodyById(data, w.bodyId)?.name || destName(data, w.bodyId)),
  }));
}

export function windowText(w, name) {
  if (!w) return '';
  if (w.open) return `Janela para ${name} aberta · fecha em ${weeksToText(w.weeksLeft)}`;
  return `Próxima janela para ${name} em ${weeksToText(w.weeksToOpen)}`;
}

/* ------------------------------------------------------------------ */
/* Névoa de guerra, presença, trânsito                                  */
/* ------------------------------------------------------------------ */

function playerReached(m) {
  return ['operations', 'done'].includes(m?.status) && OK_OUTCOMES.includes(m?.result?.outcome);
}

/** Successful arrivals by any actor: [{actorId, destId, bodyId, source, label, turn}] */
export function visits(state, data) {
  const out = [];
  const pid = state?.playerId;
  for (const m of arr(state?.missions)) {
    if (!playerReached(m)) continue;
    out.push({ actorId: pid, destId: m.destination, bodyId: destBodyId(data, m.destination), source: 'mission', label: m.name || destName(data, m.destination), turn: m.result?.resolvedTurn ?? m.launchTurn ?? 0 });
  }
  const turn = state?.turn ?? 0;
  for (const inst of arr(state?.calendar)) {
    if (!CAL_OK.includes(inst?.status)) continue;
    const def = calDef(data, inst.id);
    if (!def?.destination) continue;
    const launchT = inst.currentTurn ?? inst.plannedTurn ?? 0;
    const tw = destById(data, def.destination)?.transitWeeks || 0;
    if (launchT + tw > turn) continue; // still on the way
    for (const actorId of [def.owner, ...arr(def.partners)].filter(Boolean)) {
      out.push({ actorId, destId: def.destination, bodyId: destBodyId(data, def.destination), source: 'calendar', label: def.name || inst.id, turn: inst.resolvedTurn ?? launchT });
    }
  }
  for (const [mid, f] of Object.entries(state?.firsts || {})) {
    const bodyId = milestoneBody(data, mid);
    if (!bodyId || !f?.actorId) continue;
    out.push({ actorId: f.actorId, destId: null, bodyId, source: 'first', label: mid, turn: f.turn ?? 0 });
  }
  return out;
}

/**
 * Milestones that belong to a destination. A milestone listed by several destinations (lunar_surface_robotic is
 * also in lunar_south_pole.firsts) belongs to the one(s) that list it earliest in their own list.
 */
export function ownFirsts(data, destId) {
  const all = getDestinations(data);
  const rank = (d, mid) => {
    let best = Infinity;
    for (const list of Object.values(d?.firsts || {})) { const i = asList(list).indexOf(mid); if (i >= 0) best = Math.min(best, i); }
    return best;
  };
  const me = destById(data, destId);
  const mine = [...new Set(Object.values(me?.firsts || {}).flatMap(asList))];
  // ties (LEO and ISS both list the national crewed orbit first) belong to every tied destination
  return mine.filter((mid) => rank(me, mid) <= Math.min(...all.map((d) => rank(d, mid))));
}

/** Fog per body ('known' | 'partial' | 'unknown') and per destination ('player' | 'rival' | null). */
export function computeFog(state, data, vis = visits(state, data)) {
  const pid = state?.playerId;
  const bodies = {};
  const dests = {};
  for (const b of getBodies(data)) bodies[b.id] = b.fog === 'known' ? 'known' : 'unknown';
  const mark = (id, mine) => { dests[id] = mine || dests[id] === 'player' ? 'player' : 'rival'; };
  for (const v of vis) {
    const mine = v.actorId === pid;
    if (v.destId) {
      mark(v.destId, mine);
      // a lunar landing went through lunar orbit: the stops on its route that are destinations count as visited
      for (const leg of arr(destById(data, v.destId)?.route)) {
        if (leg?.to && leg.to !== v.destId && destById(data, leg.to)) mark(leg.to, mine);
      }
    }
    if (v.bodyId && bodies[v.bodyId] !== undefined && bodies[v.bodyId] !== 'known') {
      bodies[v.bodyId] = mine ? 'known' : 'partial';
    }
  }
  // a satellite revealed reveals its parent schematically (Titã → Saturno parcial)
  for (const b of getBodies(data)) {
    if (b.parent && b.parent !== 'sun' && bodies[b.id] !== 'unknown' && bodies[b.parent] === 'unknown') bodies[b.parent] = 'partial';
  }
  return { bodies, dests };
}

/** Actors present on each body (excluding Earth, where everyone is). */
export function presence(state, data, vis = visits(state, data)) {
  const out = {};
  for (const v of vis) {
    if (!v.bodyId || v.bodyId === 'earth') continue;
    const list = (out[v.bodyId] ||= []);
    let e = list.find((x) => x.actorId === v.actorId);
    if (!e) list.push((e = { actorId: v.actorId, items: [], firstTurn: v.turn }));
    if (!e.items.includes(v.label)) e.items.push(v.label);
    e.firstTurn = Math.min(e.firstTurn, v.turn);
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.firstTurn - b.firstTurn);
  return out;
}

/** Everything moving or operating right now: player missions and rival calendar launches. */
export function activeTransits(state, data) {
  const turn = state?.turn ?? 0;
  const pid = state?.playerId;
  const out = [];
  for (const m of arr(state?.missions)) {
    if (!['transit', 'arrival', 'operations'].includes(m?.status) || !m.destination) continue;
    const tw = destById(data, m.destination)?.transitWeeks || 0;
    const depart = m.transit?.departTurn ?? m.result?.launchedTurn ?? m.launchTurn ?? turn;
    const arrive = m.transit?.arriveTurn ?? depart + tw;
    const phase = m.status === 'transit' ? 'transit' : 'ops';
    out.push(transitItem({ key: `m:${m.id}`, missionId: m.id, actorId: pid, isPlayer: true, destId: m.destination, name: m.name || destName(data, m.destination), depart, arrive, phase, turn, data, events: arr(m.transit?.events).length }));
  }
  for (const inst of arr(state?.calendar)) {
    if (!inst || inst.status === 'player') continue;
    const def = calDef(data, inst.id);
    if (!def?.destination || def.owner === pid) continue;
    const tw = destById(data, def.destination)?.transitWeeks || 0;
    const depart = inst.currentTurn ?? inst.plannedTurn ?? 0;
    const arrive = depart + tw;
    let phase = null;
    if (inst.status === 'launched') phase = turn < arrive ? 'transit' : 'ops';
    else if (CAL_OK.includes(inst.status) && depart <= turn) {
      if (turn < arrive) phase = 'transit';
      else if (turn < arrive + 6) phase = 'ops'; // a few weeks of visible operations after arrival
    }
    if (!phase) continue;
    out.push(transitItem({ key: `c:${inst.id}`, calendarId: inst.id, actorId: def.owner, isPlayer: false, destId: def.destination, name: def.name || inst.id, depart, arrive, phase, turn, data }));
  }
  return out;
}

function transitItem(o) {
  const span = Math.max(1, o.arrive - o.depart);
  const progress = o.phase === 'transit' ? Math.max(0, Math.min(0.97, (o.turn - o.depart) / span)) : 1;
  const { turn, data, ...rest } = o;
  return { ...rest, bodyId: destBodyId(data, o.destId), progress, weeksLeft: Math.max(0, o.arrive - turn) };
}

/** Player missions planned outside a window, or windows about to close on a planned mission. */
export function windowWarnings(state, data, q) {
  const out = [];
  const turn = state?.turn ?? 0;
  for (const m of arr(state?.missions)) {
    if (!['planning', 'scheduled'].includes(m?.status) || !m.destination) continue;
    const body = bodyById(data, destBodyId(data, m.destination));
    const bodyName = body?.name || destName(data, m.destination);
    if (m.launchTurn != null) {
      const ok = launchInWindow(state, data, m.destination, m.launchTurn, q);
      if (ok && ok !== true) {
        const next = ok.openTurn > m.launchTurn ? ok.openTurn : ok.openTurn + (ok.periodWeeks || 0);
        out.push({ missionId: m.id, level: 'miss', text: `${m.name || 'Missão'}: lançamento fora da janela para ${bodyName}. Próxima abre em ${formatTurn(next, state?.startYear ?? 2026)}.` });
        continue;
      }
    }
    const w = windowFor(state, data, m.destination, q);
    if (w?.open && w.weeksLeft <= 6 && (m.launchTurn == null || m.launchTurn > w.closeTurn)) {
      out.push({ missionId: m.id, level: 'closing', text: `${m.name || 'Missão'}: a janela para ${bodyName} fecha em ${weeksToText(w.weeksLeft)}.` });
    } else if (w && !w.open && m.launchTurn == null && w.weeksToOpen > 26) {
      out.push({ missionId: m.id, level: 'wait', text: `${m.name || 'Missão'}: próxima janela para ${bodyName} só em ${weeksToText(w.weeksToOpen)}.` });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Mapa de metrô (rotas)                                               */
/* ------------------------------------------------------------------ */

export function energyWord(dv) {
  if (dv < 10) return 'Baixa';
  if (dv < 13) return 'Média';
  if (dv < 16) return 'Alta';
  return 'Extrema';
}

/** Route graph as a tree laid out in columns (depth) and rows. Pure: no DOM. */
export function buildMetro(data, { colW = 96, rowH = 58, padX = 22, padY = 30 } = {}) {
  const nodes = {};
  const order = [];
  const node = (id) => nodes[id] || (order.push(id), (nodes[id] = { id, parent: null, children: [], dvIn: 0, lines: [], depth: 0 }));
  const lines = [];
  getDestinations(data).forEach((d, i) => {
    const route = arr(d.route).filter((s) => s && s.from != null && s.to != null);
    if (!route.length) return;
    const color = LINE_COLORS[i % LINE_COLORS.length];
    const path = [];
    for (const s of route) {
      const a = node(s.from);
      const b = node(s.to);
      if (!path.length) path.push(a.id);
      if (!b.parent && b.id !== a.id && !isAncestor(nodes, b.id, a.id)) {
        b.parent = a.id;
        b.dvIn = Number(s.dv) || 0;
        a.children.push(b.id);
      }
      path.push(b.id);
    }
    const terminal = path[path.length - 1];
    const totalDv = route.reduce((t, s) => t + (Number(s.dv) || 0), 0);
    for (const id of path) if (!nodes[id].lines.includes(d.id)) nodes[id].lines.push(d.id);
    lines.push({ destId: d.id, name: d.name || d.id, color, path, terminal, totalDv, transitWeeks: d.transitWeeks || 0, segments: route.map((s) => ({ from: s.from, to: s.to, dv: Number(s.dv) || 0 })) });
  });
  // rows: depth-first, first child continues the parent's row (straight trunk)
  let row = 0;
  let maxDepth = 0;
  const visit = (id, depth) => {
    const n = nodes[id];
    n.depth = depth;
    maxDepth = Math.max(maxDepth, depth);
    if (!n.children.length) {
      n.row = row++;
      return;
    }
    n.children.forEach((c, i) => {
      visit(c, depth + 1);
      if (i === 0) n.row = nodes[c].row;
    });
  };
  for (const id of order) if (!nodes[id].parent) visit(id, 0);
  for (const id of order) {
    const n = nodes[id];
    n.x = padX + n.depth * colW;
    n.y = padY + (n.row ?? 0) * rowH;
  }
  const edges = order.filter((id) => nodes[id].parent).map((id) => {
    const n = nodes[id];
    const p = nodes[n.parent];
    const shared = n.lines.length > 1;
    const color = shared ? '#cfd8e3' : lines.find((l) => l.destId === n.lines[0])?.color || '#cfd8e3';
    return { from: p.id, to: id, dv: n.dvIn, x1: p.x, y1: p.y, x2: n.x, y2: n.y, color, lines: n.lines.slice() };
  });
  return { nodes, order, edges, lines, width: padX * 2 + maxDepth * colW + 70, height: padY * 2 + Math.max(0, row - 1) * rowH + 24 };
}

function isAncestor(nodes, maybeAncestor, id) {
  let cur = nodes[id];
  for (let g = 0; cur && g < 50; g++) {
    if (cur.id === maybeAncestor) return true;
    cur = cur.parent ? nodes[cur.parent] : null;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Modelo completo                                                     */
/* ------------------------------------------------------------------ */

export function buildModel(state, data, q) {
  const vis = visits(state, data);
  return {
    turn: state?.turn ?? 0,
    playerId: state?.playerId,
    fog: computeFog(state, data, vis),
    presence: presence(state, data, vis),
    transits: activeTransits(state, data),
    windows: windowSummaries(state, data, q),
    warnings: windowWarnings(state, data, q),
  };
}

/* ------------------------------------------------------------------ */
/* DOM helpers (só usados no navegador)                                */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function blocksHtml(dv, max = 10, cls = 'map-blocks') {
  const full = Math.floor(dv);
  const frac = dv - full;
  let h = `<span class="${cls}" aria-hidden="true">`;
  for (let i = 0; i < max; i++) {
    const fill = i < full ? 1 : i === full ? frac : 0;
    h += `<i style="--f:${fill.toFixed(2)}"></i>`;
  }
  return `${h}</span>`;
}

function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

/* Persistent view across re-renders (app.js may re-render the tab on every state change). */
const MEM = { mode: 'map', cam: null, selected: null, metroSel: null, legend: false };

/* ------------------------------------------------------------------ */
/* render(container, store)                                            */
/* ------------------------------------------------------------------ */

export function render(container, store) {
  if (!container || typeof document === 'undefined') return () => {};
  if (typeof container.__mapCleanup === 'function') container.__mapCleanup();

  const data = store?.data || {};
  const q = makeQuery(store);
  const levels = getLevels(data);
  const settings = () => store?.settings || {};
  const reduceMotion = () => !!settings().reduceMotion || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const textScale = () => Number(settings().textScale) || 1;

  let state = store?.state || {};
  let model = buildModel(state, data, q);
  let positions = bodyPositions(data, state.turn ?? 0);

  // ---------- DOM skeleton ----------
  container.innerHTML = '';
  const root = el('div', 'map-root');
  root.dataset.mode = MEM.mode;
  const hud = el('div', 'map-hud');
  const seg = el('div', 'map-seg', `<button type="button" data-mode="map">Mapa</button><button type="button" data-mode="metro">Rotas</button>`);
  seg.setAttribute('role', 'tablist');
  const dateEl = el('div', 'map-date');
  hud.append(seg, dateEl);
  const levelBar = el('div', 'map-levels');
  levelBar.innerHTML = levels.map((l) => `<button type="button" data-level="${esc(l.id)}">${esc(l.short || l.name)}</button>`).join('') + `<button type="button" class="map-legend-btn" data-legend="1" aria-label="Legenda">?</button>`;
  const stage = el('div', 'map-stage');
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Mapa do sistema solar. Toque em um corpo para abrir a ficha.');
  stage.append(canvas);
  const legend = el('div', 'map-legend');
  const winBox = el('div', 'map-windows');
  const metro = el('div', 'map-metro');
  const sheet = el('div', 'map-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'false');
  const discovery = el('div', 'map-discovery');
  stage.append(legend, winBox, sheet, discovery);
  root.append(hud, levelBar, stage, metro);
  container.append(root);

  const cx2d = canvas.getContext?.('2d');
  let W = 0;
  let H = 0;
  let dpr = 1;
  let starfield = null;
  let hits = [];
  let lastScr = {}; // screen geometry of the last frame (sheet panning)
  let rafId = 0;
  let lastPulseDraw = 0;
  let tween = null;
  let snapTimer = 0;
  let destroyed = false;
  let drawErrorLogged = false;

  // ---------- camera ----------
  const minDim = () => Math.max(1, Math.min(W, H));
  const levelById = (id) => levels.find((l) => l.id === id) || levels[0];
  /** Default pan offset of a level: center on the midpoint of its `frame` bodies (e.g. Terra + Lua). */
  function levelOffset(level) {
    const fr = arr(level.frame).map((id) => positions[id]).filter(Boolean);
    const f = positions[level.focus];
    if (!fr.length || !f) return { ox: 0, oy: 0 };
    return { ox: fr.reduce((t, p) => t + p.x, 0) / fr.length - f.x, oy: fr.reduce((t, p) => t + p.y, 0) / fr.length - f.y };
  }
  if (!MEM.cam) MEM.cam = { follow: levels[0].focus, ...levelOffset(levels[0]), span: levels[0].span };
  // Terra-Lua needs real zoom on a 375px phone (LEO, ISS, GTO and SSO sit within a few pixels of Earth): 5x
  const spanMin = levels[0].span * 0.2;
  const spanMax = levels[levels.length - 1].span * 1.45;

  function camNow(now = performance.now()) {
    const c = MEM.cam;
    const f = positions[c.follow] || { x: 0, y: 0 };
    let cx = f.x + c.ox;
    let cy = f.y + c.oy;
    let span = c.span;
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / tween.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const tf = positions[tween.to.follow] || { x: 0, y: 0 };
      const tx = tf.x + tween.to.ox;
      const ty = tf.y + tween.to.oy;
      cx = tween.from.cx + (tx - tween.from.cx) * e;
      cy = tween.from.cy + (ty - tween.from.cy) * e;
      span = Math.exp(Math.log(tween.from.span) + (Math.log(tween.to.span) - Math.log(tween.from.span)) * e);
      if (t >= 1) {
        MEM.cam = { ...tween.to };
        tween = null;
      }
    }
    return { cx, cy, s: minDim() / span, span };
  }

  function currentLevel() {
    const span = tween ? tween.to.span : MEM.cam.span;
    let best = levels[0];
    let bd = Infinity;
    for (const l of levels) {
      const d = Math.abs(Math.log(span / l.span));
      if (d < bd) (bd = d), (best = l);
    }
    return best;
  }

  /** Smoothly move to a level (or keep the pan offset when staying in the same level). */
  function goLevel(level, keepOffset = false) {
    const cam = camNow();
    const tf = positions[level.focus] || { x: 0, y: 0 };
    let { ox, oy } = levelOffset(level);
    if (keepOffset) {
      const lim = level.span * 0.45;
      ox = Math.max(-lim, Math.min(lim, cam.cx - tf.x));
      oy = Math.max(-lim, Math.min(lim, cam.cy - tf.y));
    }
    const to = { follow: level.focus, ox, oy, span: level.span };
    if (reduceMotion()) {
      tween = null;
      MEM.cam = to;
    } else {
      tween = { from: { cx: cam.cx, cy: cam.cy, span: cam.span }, to, t0: performance.now(), dur: 420 };
    }
    updateLevelBar(level.id);
    invalidate();
  }

  function snap() {
    // zoomed in past the first level: that zoom is the player's choice, do not spring back to 1x
    if ((tween ? tween.to.span : MEM.cam.span) < levels[0].span * 0.98) { invalidate(); return; }
    const lvl = currentLevel();
    const followLevel = MEM.cam.follow === lvl.focus;
    goLevel(lvl, followLevel);
  }

  /** Zoom by factor keeping the world point under (sx, sy) fixed. */
  function zoomAt(sx, sy, factor) {
    const cam = camNow();
    tween = null;
    const span = Math.max(spanMin, Math.min(spanMax, cam.span / factor));
    const s2 = minDim() / span;
    const wx = cam.cx + (sx - W / 2) / cam.s;
    const wy = cam.cy + (sy - H / 2) / cam.s;
    const ncx = wx - (sx - W / 2) / s2;
    const ncy = wy - (sy - H / 2) / s2;
    // when zooming out past the middle, follow the Sun; when zooming in, follow Earth
    const lvl = levelOfSpan(span);
    const f = positions[lvl.focus] || { x: 0, y: 0 };
    MEM.cam = { follow: lvl.focus, ox: ncx - f.x, oy: ncy - f.y, span };
    updateLevelBar(lvl.id);
    invalidate();
  }
  function levelOfSpan(span) {
    let best = levels[0];
    let bd = Infinity;
    for (const l of levels) {
      const d = Math.abs(Math.log(span / l.span));
      if (d < bd) (bd = d), (best = l);
    }
    return best;
  }
  function panBy(dx, dy) {
    const cam = camNow();
    tween = null;
    MEM.cam = { ...MEM.cam, ox: MEM.cam.ox - dx / cam.s, oy: MEM.cam.oy - dy / cam.s, span: cam.span };
    invalidate();
  }

  // ---------- sizing ----------
  function resize() {
    const r = stage.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width));
    const nh = Math.max(1, Math.round(r.height));
    const ndpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (nw === W && nh === H && ndpr === dpr) return;
    W = nw;
    H = nh;
    dpr = ndpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    starfield = null;
    invalidate();
  }

  function makeStarfield() {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const g = off.getContext('2d');
    g.scale(dpr, dpr);
    const bg = g.createRadialGradient(W * 0.3, H * 0.25, 0, W * 0.5, H * 0.5, Math.max(W, H));
    bg.addColorStop(0, '#111a33');
    bg.addColorStop(1, '#05070f');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const rng = makeRng(4242);
    const n = Math.round((W * H) / 2600);
    for (let i = 0; i < n; i++) {
      const a = 0.25 + rng.next() * 0.6;
      g.fillStyle = `rgba(${200 + rng.int(0, 55)},${210 + rng.int(0, 45)},255,${a.toFixed(2)})`;
      const r = rng.next() < 0.08 ? 1.3 : 0.7;
      g.beginPath();
      g.arc(rng.next() * W, rng.next() * H, r, 0, Math.PI * 2);
      g.fill();
    }
    return off;
  }

  // ---------- frame loop: draws only when invalidated; loops only while animating ----------
  function invalidate() {
    if (!rafId && !destroyed) rafId = requestAnimationFrame(frame);
  }
  function hasPulse() {
    return MEM.mode === 'map' && !reduceMotion() && model.transits.length > 0 && !document.hidden;
  }
  function frame(now) {
    rafId = 0;
    if (destroyed) return;
    if (!root.isConnected) return cleanup();
    const animating = !!tween || gesture.active;
    if (MEM.mode === 'map' && (animating || now - lastPulseDraw > 30 || !hasPulse())) {
      try {
        draw(now);
      } catch (e) {
        if (!drawErrorLogged) console.warn('[mapa] erro ao desenhar', e);
        drawErrorLogged = true;
      }
      lastPulseDraw = now;
    }
    if (tween || hasPulse()) rafId = requestAnimationFrame(frame);
  }

  // ---------- drawing ----------
  function draw(now) {
    if (!cx2d || !W || !H) return;
    const g = cx2d;
    const ts = textScale();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!starfield) starfield = makeStarfield();
    g.drawImage(starfield, 0, 0, W, H);
    const cam = camNow(now);
    const s = cam.s;
    const toS = (p) => ({ x: (p.x - cam.cx) * s + W / 2, y: (p.y - cam.cy) * s + H / 2 });
    hits = [];
    const bodies = getBodies(data);
    const fog = model.fog.bodies;
    const pulse = reduceMotion() ? 0.5 : (Math.sin(now / 380) + 1) / 2;

    // screen geometry for bodies (satellites keep a minimum separation from the parent)
    const scr = {};
    const radius = (b) => Math.max(b.display?.minPx ?? 4, Math.min(b.display?.maxPx ?? 60, (b.display?.radius ?? 3) * s));
    const placeScreen = (b, depth = 0) => {
      if (scr[b.id] || depth > 6) return scr[b.id];
      const p = positions[b.id] || { x: 0, y: 0 };
      let sp = toS(p);
      let R = radius(b);
      const parent = b.parent && b.parent !== 'sun' ? bodies.find((x) => x.id === b.parent) : null;
      if (parent) {
        const ps = placeScreen(parent, depth + 1);
        const dx = sp.x - ps.x;
        const dy = sp.y - ps.y;
        const d = Math.hypot(dx, dy) || 1;
        const small = d < ps.R + R + 8;
        if (small) R = Math.max(2.5, Math.min(R, 4));
        const minSep = ps.R + R + 6;
        if (d < minSep) sp = { x: ps.x + (dx / d) * minSep, y: ps.y + (dy / d) * minSep };
      }
      scr[b.id] = { x: sp.x, y: sp.y, R, b };
      return scr[b.id];
    };
    for (const b of bodies) placeScreen(b);
    lastScr = scr;
    const sun = scr.sun || toS({ x: 0, y: 0 });

    // orbits
    g.lineWidth = 1;
    for (const b of bodies) {
      if (!b.orbit?.radius) continue;
      const ps = b.parent === 'sun' ? sun : b.parent ? scr[b.parent] : null;
      if (!ps) continue;
      const r = b.parent === 'sun' ? b.orbit.radius * s : Math.hypot(scr[b.id].x - ps.x, scr[b.id].y - ps.y);
      if (r < 6 || r > 6 * Math.max(W, H)) continue;
      g.strokeStyle = fog[b.id] === 'unknown' ? 'rgba(160,175,210,0.10)' : 'rgba(170,190,230,0.22)';
      g.setLineDash(fog[b.id] === 'unknown' ? [3, 5] : []);
      g.beginPath();
      g.arc(ps.x, ps.y, r, 0, Math.PI * 2);
      g.stroke();
    }
    g.setLineDash([]);

    // launch windows: arc on the target's orbit + alignment line when open
    for (const w of model.windows) {
      const b = bodyById(data, w.bodyId);
      const bs = scr[w.bodyId];
      if (!b || !bs || b.parent !== 'sun' || !scr.earth) continue;
      const r = b.orbit.radius * s;
      if (r < 20) continue;
      const ang = Math.atan2(bs.y - sun.y, bs.x - sun.x);
      g.lineWidth = 4;
      g.strokeStyle = w.open ? `rgba(76,201,240,${0.45 + 0.4 * pulse})` : 'rgba(255,209,102,0.35)';
      g.beginPath();
      g.arc(sun.x, sun.y, r, ang - 0.28, ang + 0.28);
      g.stroke();
      if (w.open) {
        g.lineWidth = 1.2;
        g.setLineDash([5, 5]);
        g.strokeStyle = 'rgba(76,201,240,0.55)';
        g.beginPath();
        g.moveTo(scr.earth.x, scr.earth.y);
        g.lineTo(bs.x, bs.y);
        g.stroke();
        g.setLineDash([]);
      }
      if (s < 1) {
        label(g, w.open ? 'Janela aberta' : `Janela em ${weeksToText(w.weeksToOpen)}`, bs.x, bs.y + bs.R + 26 * ts, 10.5 * ts, w.open ? '#7fdcf5' : '#ffd98a');
      }
    }

    // transit paths (interplanetary ones are hidden at Terra-Lua scale: they would cross the view meaninglessly)
    const detail = s >= 1.2; // Terra-Lua scale: rings, destination markers, labels
    for (const t of model.transits) {
      const local = t.bodyId === 'earth' || bodyById(data, t.bodyId)?.parent === 'earth';
      const path = detail && !local ? null : transitPath(t, scr, toS, s);
      t._path = path;
      if (!path || path.length < 2 || t.phase !== 'transit') continue;
      const col = actorInfo(state, data, t.actorId).color;
      g.strokeStyle = col;
      g.globalAlpha = 0.45;
      g.lineWidth = t.isPlayer ? 1.8 : 1.2;
      g.setLineDash(t.isPlayer ? [] : [4, 4]);
      g.beginPath();
      path.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }

    // bodies
    for (const b of bodies) {
      const p = scr[b.id];
      if (p.x < -200 || p.y < -200 || p.x > W + 200 || p.y > H + 200) continue;
      drawBody(g, b, p, fog[b.id], sun);
      hits.push({ x: p.x, y: p.y, r: Math.max(p.R, 18), kind: 'body', id: b.id });
      if (!detail && b.parent === 'sun') {
        // tiny ring around far bodies where the player orbits
        if (arr(b.destinations).some((a) => a.anchor === 'ring' && model.fog.dests[a.id] === 'player')) {
          g.strokeStyle = 'rgba(255,255,255,0.5)';
          g.lineWidth = 1;
          g.beginPath();
          g.arc(p.x, p.y, p.R + 4, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }

    // label placement: body names first, then destination names only where they fit (no overlaps, not on a disc)
    const boxes = [];
    const textRect = (text, x, y, size, align) => {
      g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const w = g.measureText(text).width + 4;
      const hh = size * 1.25;
      const left = align === 'left' ? x - 2 : align === 'right' ? x - w + 2 : x - w / 2;
      return { x: left, y: y - hh / 2, w, h: hh };
    };
    const hitsBox = (r) => boxes.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    const onDisc = (r) => Object.values(scr).some((p) => {
      if (!p || p.R < 3) return false;
      const nx = Math.max(r.x, Math.min(p.x, r.x + r.w));
      const ny = Math.max(r.y, Math.min(p.y, r.y + r.h));
      return Math.hypot(nx - p.x, ny - p.y) < p.R;
    });
    const bodyLabels = [];
    for (const b of bodies) {
      const p = scr[b.id];
      if (!p || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) continue;
      if (b.parent && b.parent !== 'sun' && !detail && p.R <= 4) continue; // satellites too small to label
      const f = fog[b.id];
      const item = { text: f === 'unknown' ? `${b.name} ?` : b.name, x: p.x, y: p.y + p.R + 13 * ts, size: (b.reference ? 11 : 12) * ts, color: f === 'unknown' ? 'rgba(190,200,225,0.55)' : '#e8eefc' };
      const r = textRect(item.text, item.x, item.y, item.size, 'center');
      if (hitsBox(r)) continue; // two bodies on top of each other at this zoom: the first one speaks
      boxes.push(r);
      bodyLabels.push(item);
    }
    /** Destination label beside its marker: try four corners, skip it when none is free (zoom in to read it). */
    const placeDestLabel = (text, pos, size, color) => {
      for (const [dx, dy, align] of [[7, -7, 'left'], [7, 8, 'left'], [-7, -7, 'right'], [-7, 8, 'right']]) {
        const r = textRect(text, pos.x + dx, pos.y + dy, size, align);
        if (r.x < 0 || r.x + r.w > W || hitsBox(r) || onDisc(r)) continue;
        boxes.push(r);
        label(g, text, pos.x + dx, pos.y + dy, size, color, align);
        return true;
      }
      return false;
    };

    // destination rings/markers (only where there is room)
    if (detail) {
      for (const b of bodies) {
        const p = scr[b.id];
        if (!p || p.R < 6) continue;
        for (const a of arr(b.destinations)) {
          const pos = anchorScreen(a, p, scr, s);
          if (!pos) continue;
          const st = model.fog.dests[a.id];
          if (a.anchor === 'ring') {
            const rr = Math.hypot(pos.x - p.x, pos.y - p.y);
            g.strokeStyle = st === 'player' ? 'rgba(127,220,245,0.45)' : 'rgba(200,210,235,0.16)';
            g.lineWidth = 1;
            g.beginPath();
            if (a.tilt) g.ellipse(p.x, p.y, rr * a.tilt, rr, 0, 0, Math.PI * 2);
            else g.arc(p.x, p.y, rr, 0, Math.PI * 2);
            g.stroke();
          }
          drawDestMarker(g, pos, st, MEM.selected?.destId === a.id);
          hits.push({ x: pos.x, y: pos.y, r: 14, kind: 'dest', id: a.id, bodyId: b.id });
          if (s >= 2.4 && p.R >= 16) placeDestLabel(destName(data, a.id), pos, 10 * ts, st ? '#d9e6ff' : 'rgba(200,210,235,0.6)');
        }
      }
    }

    // presence flags
    for (const [bodyId, list] of Object.entries(model.presence)) {
      const p = scr[bodyId];
      if (!p || fog[bodyId] === 'unknown' && !list.length) continue;
      list.slice(0, 5).forEach((e, i) => {
        const a = actorInfo(state, data, e.actorId);
        const fx = p.x + p.R * 0.55 + i * 9;
        const fy = p.y - p.R - 4;
        drawFlag(g, fx, fy, a.color, e.actorId === state.playerId);
      });
    }

    // missions: pulsing dots (circle = player, diamond = rival, for colorblind clarity)
    for (const t of model.transits) {
      const path = t._path;
      if (!path?.length) continue;
      let pt;
      if (t.phase === 'transit') pt = pointAlong(path, t.progress);
      else {
        // in operations: slow circle around the destination
        const end = path[path.length - 1];
        const ang = (reduceMotion() ? 0.8 : now / 2200) + hashAngle(t.key);
        pt = { x: end.x + Math.cos(ang) * 5, y: end.y + Math.sin(ang) * 5 };
      }
      const col = actorInfo(state, data, t.actorId).color;
      const pr = t.isPlayer ? 4.5 : 3.6;
      g.fillStyle = col;
      g.globalAlpha = 0.25 + 0.3 * (1 - pulse);
      g.beginPath();
      g.arc(pt.x, pt.y, pr + 4 + 6 * pulse, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
      g.beginPath();
      if (t.isPlayer) g.arc(pt.x, pt.y, pr, 0, Math.PI * 2);
      else {
        g.moveTo(pt.x, pt.y - pr - 1);
        g.lineTo(pt.x + pr + 1, pt.y);
        g.lineTo(pt.x, pt.y + pr + 1);
        g.lineTo(pt.x - pr - 1, pt.y);
        g.closePath();
      }
      g.fill();
      g.lineWidth = t.isPlayer ? 1.6 : 1;
      g.strokeStyle = '#ffffff';
      g.stroke();
      hits.push({ x: pt.x, y: pt.y, r: 16, kind: 'transit', id: t.key, bodyId: t.bodyId });
    }

    // body labels (placed above, drawn on top of markers)
    for (const it of bodyLabels) label(g, it.text, it.x, it.y, it.size, it.color);

    // Sun direction indicator when the Sun is off-screen (Terra-Lua)
    if (sun.x < 0 || sun.y < 0 || sun.x > W || sun.y > H) edgeArrow(g, sun, '☀ Sol', ts);

    // selection highlight
    const sel = MEM.selected;
    if (sel?.bodyId && scr[sel.bodyId]) {
      const p = scr[sel.bodyId];
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 1.5;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.arc(p.x, p.y, p.R + 7, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
  }

  function anchorScreen(a, p, scr, s) {
    const ang = (a.angle || 0) * DEG;
    if (a.anchor === 'surface') return { x: p.x + Math.cos(ang) * p.R, y: p.y - Math.sin(ang) * p.R };
    if (a.anchor === 'lagrange') {
      const from = scr[a.from];
      if (!from) return null;
      const f = a.f ?? 0.8;
      return { x: from.x + (p.x - from.x) * f, y: from.y + (p.y - from.y) * f };
    }
    const rr = Math.max((a.r || 0) * s, p.R + 6);
    const k = a.tilt || 1;
    return { x: p.x + Math.cos(ang) * rr * k, y: p.y - Math.sin(ang) * rr };
  }

  /** Path points (screen) for a transit: bezier inside the Earth system, spiral around the Sun beyond it. */
  function transitPath(t, scr, toS, s) {
    const anchors = destAnchors(data);
    const an = anchors[t.destId];
    const bodyId = an?.bodyId || t.bodyId;
    const target = scr[bodyId];
    const earth = scr.earth;
    if (!earth || !target) return null;
    const body = bodyById(data, bodyId);
    const local = bodyId === 'earth' || body?.parent === 'earth';
    const end = an ? anchorScreen(an.anchor, target, scr, s) || target : target;
    const pts = [];
    if (local) {
      if (bodyId === 'earth') {
        // orbit missions: just the marker itself
        return [end];
      }
      const mx = (earth.x + end.x) / 2;
      const my = (earth.y + end.y) / 2;
      const dx = end.x - earth.x;
      const dy = end.y - earth.y;
      const cx = mx - dy * 0.28;
      const cy = my + dx * 0.28;
      const sx = earth.x + (dx / (Math.hypot(dx, dy) || 1)) * earth.R;
      const sy = earth.y + (dy / (Math.hypot(dx, dy) || 1)) * earth.R;
      for (let i = 0; i <= 28; i++) {
        const u = i / 28;
        pts.push({ x: (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * end.x, y: (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * end.y });
      }
      return pts;
    }
    // interplanetary: polar interpolation around the Sun from Earth at departure to the target at arrival
    const sunBody = getBodies(data).find((b) => !b.parent);
    const planetId = body?.parent && body.parent !== 'sun' ? body.parent : bodyId;
    const P0 = bodyPositions(data, t.depart);
    const P1 = bodyPositions(data, t.arrive);
    const e0 = P0.earth;
    const m1 = P1[planetId];
    if (!e0 || !m1 || !sunBody) return [earth, target];
    const r0 = Math.hypot(e0.x, e0.y);
    const r1 = Math.hypot(m1.x, m1.y);
    const a1 = Math.atan2(-m1.y, m1.x);
    // prograde sweep from Earth's departure angle; launches far from the window would loop around the Sun,
    // so those are drawn as a schematic half-orbit transfer ending at the target (Hohmann-like)
    let sweep = ((((a1 - Math.atan2(-e0.y, e0.x)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
    if (sweep < Math.PI * 0.75 || sweep > Math.PI * 1.15) sweep = Math.PI;
    const a0 = a1 - sweep;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const r = r0 + (r1 - r0) * (1 - Math.cos(u * Math.PI)) / 2;
      const a = a0 + sweep * u;
      pts.push(toS({ x: r * Math.cos(a), y: -r * Math.sin(a) }));
    }
    return pts;
  }

  function pointAlong(path, u) {
    if (path.length === 1) return path[0];
    const f = Math.max(0, Math.min(1, u)) * (path.length - 1);
    const i = Math.min(path.length - 2, Math.floor(f));
    const k = f - i;
    return { x: path[i].x + (path[i + 1].x - path[i].x) * k, y: path[i].y + (path[i + 1].y - path[i].y) * k };
  }

  function drawBody(g, b, p, fogState, sun) {
    const d = b.display || {};
    const R = p.R;
    const unknown = fogState === 'unknown';
    const dim = unknown ? 0.42 : fogState === 'partial' ? 0.75 : 1;
    if (b.id === 'sun' || (!b.parent && b.reference)) {
      const glow = g.createRadialGradient(p.x, p.y, R * 0.3, p.x, p.y, R * 2.6);
      glow.addColorStop(0, d.glow || '#ff9f1c');
      glow.addColorStop(1, 'rgba(255,159,28,0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(p.x, p.y, R * 2.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = d.color || '#ffd166';
      g.beginPath();
      g.arc(p.x, p.y, R, 0, Math.PI * 2);
      g.fill();
      return;
    }
    const base = unknown ? d.dark || shade(d.color, 0.5) : d.color || '#aaa';
    // Saturn-like ring (back half)
    if (d.ring) ringHalf(g, p, R, d.ring, dim, true);
    g.save();
    g.beginPath();
    g.arc(p.x, p.y, R, 0, Math.PI * 2);
    g.clip();
    const grad = g.createRadialGradient(p.x - R * 0.35, p.y - R * 0.35, R * 0.1, p.x, p.y, R);
    grad.addColorStop(0, shade(base, 1.25 * dim));
    grad.addColorStop(1, shade(base, 0.8 * dim));
    g.fillStyle = grad;
    g.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    if (!unknown) surfaceDetail(g, b, p, R, d, dim);
    // night side away from the Sun
    const ang = Math.atan2(p.y - sun.y, p.x - sun.x);
    const nx = p.x + Math.cos(ang) * R * 0.9;
    const ny = p.y + Math.sin(ang) * R * 0.9;
    const night = g.createRadialGradient(nx, ny, 0, nx, ny, R * 1.7);
    night.addColorStop(0, 'rgba(3,6,16,0.82)');
    night.addColorStop(0.6, 'rgba(3,6,16,0.35)');
    night.addColorStop(1, 'rgba(3,6,16,0)');
    g.fillStyle = night;
    g.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    g.restore();
    if (d.atmosphere && !unknown && R > 10) {
      g.strokeStyle = d.atmosphere;
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(1.5, R * 0.08);
      g.beginPath();
      g.arc(p.x, p.y, R + g.lineWidth / 2, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
    if (unknown) {
      g.strokeStyle = 'rgba(190,200,230,0.45)';
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(p.x, p.y, R + 2, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    if (d.ring) ringHalf(g, p, R, d.ring, dim, false);
  }

  function surfaceDetail(g, b, p, R, d, dim) {
    if (R < 5) return;
    const rng = makeRng(b.id.length * 977 + b.id.charCodeAt(0));
    if (b.id === 'earth' && d.land) {
      g.fillStyle = shade(d.land, dim);
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.ellipse(p.x + (rng.next() - 0.5) * R * 1.4, p.y + (rng.next() - 0.5) * R * 1.4, R * (0.18 + rng.next() * 0.3), R * (0.12 + rng.next() * 0.22), rng.next() * 3, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.25)';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.ellipse(p.x + (rng.next() - 0.5) * R * 1.5, p.y + (rng.next() - 0.5) * R * 1.5, R * 0.35, R * 0.07, rng.next(), 0, Math.PI * 2);
        g.fill();
      }
    } else if (d.bands) {
      g.fillStyle = shade(d.bands, dim);
      for (let i = -3; i <= 3; i++) g.fillRect(p.x - R, p.y + i * R * 0.27 - R * 0.06, R * 2, R * (0.07 + rng.next() * 0.06));
    } else if (b.id === 'mars') {
      g.fillStyle = shade('#9c4a35', dim);
      g.beginPath();
      g.ellipse(p.x + R * 0.2, p.y + R * 0.1, R * 0.5, R * 0.25, 0.4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.ellipse(p.x, p.y - R * 0.92, R * 0.38, R * 0.16, 0, 0, Math.PI * 2);
      g.fill();
    } else if (d.dark) {
      g.fillStyle = shade(d.dark, dim);
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.arc(p.x + (rng.next() - 0.5) * R * 1.4, p.y + (rng.next() - 0.5) * R * 1.4, R * (0.08 + rng.next() * 0.16), 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  function ringHalf(g, p, R, color, dim, back) {
    g.save();
    g.strokeStyle = color;
    g.globalAlpha = 0.75 * dim;
    g.lineWidth = Math.max(1.5, R * 0.22);
    g.beginPath();
    g.ellipse(p.x, p.y, R * 1.9, R * 0.55, -0.35, back ? Math.PI : 0, back ? Math.PI * 2 : Math.PI);
    g.stroke();
    g.restore();
  }

  function drawDestMarker(g, pos, st, selected) {
    const r = selected ? 5.5 : 4;
    g.beginPath();
    g.moveTo(pos.x, pos.y - r);
    g.lineTo(pos.x + r, pos.y);
    g.lineTo(pos.x, pos.y + r);
    g.lineTo(pos.x - r, pos.y);
    g.closePath();
    g.fillStyle = st === 'player' ? '#7fdcf5' : st === 'rival' ? '#c9b37a' : 'rgba(30,38,60,0.9)';
    g.fill();
    g.lineWidth = selected ? 2 : 1;
    g.strokeStyle = st ? '#ffffff' : 'rgba(190,200,230,0.6)';
    g.stroke();
  }

  function drawFlag(g, x, y, color, mine) {
    g.strokeStyle = 'rgba(230,236,250,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y + 9);
    g.lineTo(x, y - 3);
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y - 3);
    g.lineTo(x + 7, y);
    g.lineTo(x, y + 3);
    g.closePath();
    g.fill();
    if (mine) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.2;
      g.stroke();
    }
  }

  function label(g, text, x, y, size, color, align = 'center') {
    g.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(5,8,18,0.85)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function edgeArrow(g, target, text, ts) {
    const cx = W / 2;
    const cy = H / 2;
    const ang = Math.atan2(target.y - cy, target.x - cx);
    const m = 26;
    const kx = (W / 2 - m) / Math.abs(Math.cos(ang) || 1e-6);
    const ky = (H / 2 - m) / Math.abs(Math.sin(ang) || 1e-6);
    const k = Math.min(kx, ky);
    const x = cx + Math.cos(ang) * k;
    const y = cy + Math.sin(ang) * k;
    g.fillStyle = 'rgba(255,209,102,0.85)';
    g.beginPath();
    g.moveTo(x + Math.cos(ang) * 9, y + Math.sin(ang) * 9);
    g.lineTo(x + Math.cos(ang + 2.5) * 7, y + Math.sin(ang + 2.5) * 7);
    g.lineTo(x + Math.cos(ang - 2.5) * 7, y + Math.sin(ang - 2.5) * 7);
    g.closePath();
    g.fill();
    label(g, text, x - Math.cos(ang) * 22, y - Math.sin(ang) * 14, 10 * ts, '#ffd98a');
  }

  function hashAngle(key) {
    let h = 0;
    for (const c of String(key)) h = (h * 33 + c.charCodeAt(0)) >>> 0;
    return (h % 628) / 100;
  }

  // ---------- HUD ----------
  function updateLevelBar(id = currentLevel().id) {
    for (const b of levelBar.querySelectorAll('button[data-level]')) {
      const on = b.dataset.level === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function updateHud() {
    root.dataset.mode = MEM.mode;
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.mode === MEM.mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    dateEl.textContent = formatTurn(state.turn ?? 0, state.startYear ?? data?.scenario?.startYear ?? 2026);
    updateLevelBar();
    // windows + warnings
    const parts = [];
    const nTransit = model.transits.filter((t) => t.phase === 'transit').length;
    if (nTransit) parts.push(`<div class="map-transit-count">${nTransit} ${nTransit === 1 ? 'missão em trânsito' : 'missões em trânsito'}</div>`);
    const w0 = model.warnings[0];
    if (w0) {
      const more = model.warnings.length > 1 ? ` <small>(+${model.warnings.length - 1})</small>` : '';
      parts.push(`<div class="map-warn map-warn--${esc(w0.level)}" role="status"><b aria-hidden="true">!</b> ${esc(w0.text)}${more}</div>`);
    }
    // nearest window gets the full sentence; the others become compact chips in one scrollable row
    const chips = model.windows.slice(0, 4).map((w, i) => {
      const txt = i === 0 ? w.text : w.open ? `${w.bodyName} · aberta` : `${w.bodyName} · ${weeksToText(w.weeksToOpen)}`;
      return `<button type="button" class="map-win ${w.open ? 'is-open' : ''} ${i ? 'is-compact' : ''}" data-body="${esc(w.bodyId)}" aria-label="${esc(w.text)}">
        <span class="map-win__txt">${esc(txt)}</span>
        <span class="map-win__bar" aria-hidden="true"><i style="width:${Math.round(w.cycle * 100)}%"></i></span></button>`;
    });
    if (chips.length) parts.push(`<div class="map-win-row">${chips.join('')}</div>`);
    winBox.innerHTML = parts.join('');
    legend.classList.toggle('is-open', !!MEM.legend);
    legend.innerHTML = MEM.legend ? legendHtml() : '';
  }

  function legendHtml() {
    const pid = state.playerId;
    const me = actorInfo(state, data, pid);
    return `<div class="map-legend__card">
      <div><span class="lg-dot" style="background:${esc(me.color)}"></span> Sua missão (círculo)</div>
      <div><span class="lg-dia"></span> Missão rival (losango, cor do ator)</div>
      <div><span class="lg-flag"></span> Presença: quem já chegou lá</div>
      <div><span class="lg-fog"></span> Inexplorado: envie uma sonda</div>
      <div><span class="lg-win"></span> Arco azul: janela aberta</div>
    </div>`;
  }

  // ---------- ficha (body card) ----------
  function openSheet(sel) {
    MEM.selected = sel;
    renderSheet();
    keepAboveSheet(sel);
    invalidate();
  }

  /** Pan so the selected body (or destination) sits in the middle of the map area the card leaves free. */
  function keepAboveSheet(sel) {
    const p = sel && lastScr[sel.bodyId];
    if (!p || !H) return;
    requestAnimationFrame(() => {
      if (destroyed || MEM.selected !== sel) return;
      const sh = sheet.getBoundingClientRect?.().height || 0;
      const freeH = Math.max(80, H - sh);
      const target = freeH / 2;
      if (p.y + p.R <= freeH - 12 && p.y - p.R >= 8) return; // already in view
      const cam = camNow();
      const dy = (p.y - target) / cam.s;
      const dx = (p.x - W / 2) / cam.s;
      const to = { ...MEM.cam, ox: MEM.cam.ox + dx, oy: MEM.cam.oy + dy, span: cam.span };
      if (reduceMotion()) { tween = null; MEM.cam = to; }
      else tween = { from: { cx: cam.cx, cy: cam.cy, span: cam.span }, to, t0: performance.now(), dur: 320 };
      invalidate();
    });
  }
  function closeSheet() {
    MEM.selected = null;
    renderSheet();
    invalidate();
  }

  function renderSheet() {
    const sel = MEM.selected;
    const b = sel ? bodyById(data, sel.bodyId) : null;
    if (!b) {
      sheet.classList.remove('is-open');
      sheet.innerHTML = '';
      return;
    }
    const fogState = model.fog.bodies[b.id] || 'unknown';
    const f = b.ficha || {};
    const hidden = fogState === 'unknown';
    const list = (items) => (hidden ? `<p class="map-fogged">Desconhecido. Envie uma sonda para revelar.</p>` : `<ul>${arr(items).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
    const anchors = arr(b.destinations);
    const pid = state.playerId;
    const destRows = anchors.map((a) => {
      const dest = destById(data, a.id);
      const st = model.fog.dests[a.id];
      const w = windowFor(state, data, a.id, q);
      const dv = arr(dest?.route).reduce((t, s) => t + (Number(s?.dv) || 0), 0);
      // only this destination's own milestones: the pole lists the general Moon landing too (an alias for
      // scoring), and crediting it here showed "Nunca visitado" next to "Primeiro CNSA"
      const firsts = ownFirsts(data, a.id).map((mid) => state.firsts?.[mid] && { mid, ...state.firsts[mid] }).filter(Boolean);
      const chip = st === 'player' ? '<span class="map-chip is-player">Visitado por você</span>' : st === 'rival' ? '<span class="map-chip is-rival">Visitado por rivais</span>' : homeChip(a.id) || '<span class="map-chip">Nunca visitado</span>';
      return `<li class="map-dest ${sel.destId === a.id ? 'is-sel' : ''}">
        <div class="map-dest__head"><b>${esc(destName(data, a.id))}</b>${chip}</div>
        ${dv ? `<div class="map-dest__row"><span>Energia</span>${blocksHtml(Math.min(10, dv / 2))}<em>${energyWord(dv)}</em></div>` : ''}
        ${dest ? `<div class="map-dest__row"><span>Viagem</span><em>${dest.transitWeeks ? weeksToText(dest.transitWeeks) : 'imediata'}</em></div>` : ''}
        ${w ? `<div class="map-dest__row"><span>Janela</span><em class="${w.open ? 'is-open' : ''}">${w.open ? `aberta, fecha em ${weeksToText(w.weeksLeft)}` : `abre em ${weeksToText(w.weeksToOpen)}`}</em></div>` : ''}
        ${firsts.map((x) => `<div class="map-dest__row"><span>Primeiro</span><em>${esc(actorInfo(state, data, x.actorId).flag)} ${esc(actorInfo(state, data, x.actorId).short)}</em></div>`).join('')}
      </li>`;
    }).join('');
    const pres = arr(model.presence[b.id]).map((e) => {
      const a = actorInfo(state, data, e.actorId);
      return `<li><span class="map-pres__flag" style="--c:${esc(a.color)}"></span><b>${esc(a.flag)} ${esc(a.short)}${e.actorId === pid ? ' (você)' : ''}</b> <small>${esc(e.items.slice(0, 3).map(prettyItem).join(', '))}</small></li>`;
    }).join('');
    const active = model.transits.filter((t) => t.bodyId === b.id || (bodyById(data, t.bodyId)?.parent === b.id));
    const act = active.map((t) => {
      const a = actorInfo(state, data, t.actorId);
      const status = t.phase === 'transit' ? `chega em ${weeksToText(Math.max(1, t.weeksLeft))}` : 'em operação';
      return `<li class="${sel.transitKey === t.key ? 'is-sel' : ''}"><span class="map-pres__flag" style="--c:${esc(a.color)}"></span><b>${esc(t.name)}</b> <small>${esc(a.short)} · ${esc(destName(data, t.destId))} · ${status}${t.phase === 'transit' ? ` · ${Math.round(t.progress * 100)}%` : ''}</small></li>`;
    }).join('');
    sheet.innerHTML = `
      <div class="map-sheet__grab" aria-hidden="true"></div>
      <header class="map-sheet__head">
        <span class="map-sheet__dot" style="background:${esc(b.display?.color || '#888')}"></span>
        <div><h3>${esc(b.name)}</h3><p class="map-sheet__tipo">${esc(f.tipo || '')}</p></div>
        <span class="map-chip map-chip--fog-${fogState}">${FOG_LABEL[fogState] || ''}</span>
        <button type="button" class="map-sheet__close" data-close="1" aria-label="Fechar ficha">×</button>
      </header>
      <div class="map-sheet__body">
        <dl class="map-facts"><div><dt>Gravidade</dt><dd>${esc(f.gravidade || '—')}</dd></div><div><dt>Atmosfera</dt><dd>${esc(f.atmosfera || '—')}</dd></div></dl>
        <section><h4>Recursos</h4>${list(f.recursos)}</section>
        <section><h4>Perigos</h4>${list(f.perigos)}</section>
        ${f.historia ? `<p class="map-hist">${esc(f.historia)}</p>` : ''}
        ${act ? `<section><h4>Em andamento</h4><ul class="map-pres">${act}</ul></section>` : ''}
        ${destRows ? `<section><h4>Destinos</h4><ul class="map-dests">${destRows}</ul></section>` : ''}
        <section><h4>Presença</h4>${pres ? `<ul class="map-pres">${pres}</ul>` : '<p class="map-fogged">Ninguém chegou lá nesta campanha.</p>'}</section>
      </div>`;
    sheet.classList.add('is-open');
  }

  /** Destinations around a body that is always known (Terra) are routine, not "unexplored". */
  function homeChip(destId) {
    return bodyById(data, destBodyId(data, destId))?.fog === 'known' ? '<span class="map-chip">Acessível</span>' : '';
  }

  function prettyItem(s) {
    // milestone ids (from firsts) get their pt-BR label from bodies.json
    const base = String(s).split(':')[0];
    return data?.bodies?.milestoneLabels?.[base] || (/^[a-z0-9_:]+$/.test(s) ? 'marco histórico' : s);
  }

  // ---------- discovery scene (fog lifted by the player) ----------
  const seenKey = `adastra.map.seen.${state.seed ?? 0}.${state.playerId ?? ''}`;
  function loadSeen() {
    try {
      return JSON.parse(globalThis.localStorage?.getItem(seenKey) || '[]');
    } catch {
      return [];
    }
  }
  function saveSeen(list) {
    try {
      globalThis.localStorage?.setItem(seenKey, JSON.stringify(list));
    } catch {
      /* storage unavailable: discovery may repeat, harmless */
    }
  }
  function checkDiscoveries() {
    const seen = loadSeen();
    const fresh = getBodies(data).filter((b) => b.fog !== 'known' && model.fog.bodies[b.id] === 'known' && !seen.includes(b.id));
    if (!fresh.length || discovery.classList.contains('is-open')) return;
    const b = fresh[0];
    discovery.innerHTML = `<div class="map-discovery__card" role="dialog" aria-label="Descoberta">
      <div class="map-discovery__art" style="--c:${esc(b.display?.color || '#888')}"></div>
      <small>Descoberta</small><h3>${esc(b.name)}</h3>
      <p>${esc(b.ficha?.descoberta || b.ficha?.historia || '')}</p>
      <button type="button" data-discovery="${esc(b.id)}">Continuar</button></div>`;
    discovery.classList.add('is-open');
  }

  // ---------- metro view ----------
  function renderMetro() {
    const m = buildMetro(data);
    if (!m.lines.length) {
      metro.innerHTML = `<p class="map-empty">Rotas indisponíveis: o catálogo de destinos ainda não foi carregado.</p>`;
      return;
    }
    const sel = MEM.metroSel;
    const selLine = m.lines.find((l) => l.destId === sel);
    const onPath = new Set(selLine ? selLine.path : []);
    const stations = data?.bodies?.stations || {};
    const fogD = model.fog.dests;
    let svg = `<svg class="map-metro__svg" viewBox="0 0 ${m.width} ${m.height}" width="${m.width}" height="${m.height}" role="img" aria-label="Mapa de rotas">`;
    for (const e of m.edges) {
      const hi = selLine && onPath.has(e.from) && onPath.has(e.to);
      const dim = selLine && !hi;
      const color = hi ? selLine.color : e.color;
      const bend = e.y2 === e.y1 ? '' : `Q ${e.x1} ${e.y2} ${e.x1 + 18} ${e.y2} `;
      const d = `M ${e.x1} ${e.y1} ${bend}L ${e.x2} ${e.y2}`;
      svg += `<path d="${d}" stroke="${color}" stroke-width="${hi ? 7 : 5}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${dim ? 0.25 : 1}"/>`;
      // delta-v as blocks along the horizontal stretch (1 block ≈ 1 unidade de energia, sem números)
      const x0 = e.y2 === e.y1 ? e.x1 + 12 : e.x1 + 24;
      const x1 = e.x2 - 12;
      const n = 10;
      const bw = Math.max(2, (x1 - x0 - (n - 1) * 1.5) / n);
      for (let i = 0; i < n; i++) {
        const fill = Math.max(0, Math.min(1, e.dv - i));
        const bx = x0 + i * (bw + 1.5);
        svg += `<rect x="${bx.toFixed(1)}" y="${e.y2 - 14}" width="${bw.toFixed(1)}" height="5" rx="1" fill="rgba(255,255,255,0.10)" opacity="${dim ? 0.3 : 1}"/>`;
        if (fill > 0) svg += `<rect x="${bx.toFixed(1)}" y="${e.y2 - 14}" width="${(bw * fill).toFixed(1)}" height="5" rx="1" fill="${hi ? '#ffffff' : '#ffd166'}" opacity="${dim ? 0.3 : 0.95}"/>`;
      }
    }
    for (const id of m.order) {
      const n = m.nodes[id];
      const line = m.lines.find((l) => l.terminal === id);
      const isDest = !!line || !!destById(data, id);
      const destId = line?.destId || (destById(data, id) ? id : null);
      const st = destId ? fogD[destId] : 'player';
      const hi = !selLine || onPath.has(id);
      const name = destId ? destName(data, destId) : stations[id] || destName(data, id);
      const r = isDest ? 7.5 : 5.5;
      const fill = isDest ? (st === 'player' ? '#7fdcf5' : st === 'rival' ? '#c9b37a' : '#1a2238') : '#ffffff';
      const dash = isDest && !st ? 'stroke-dasharray="2 2"' : '';
      svg += `<g class="map-st" ${destId ? `data-dest="${esc(destId)}" tabindex="0" role="button" aria-label="${esc(name)}"` : ''} opacity="${hi ? 1 : 0.35}">
        <circle cx="${n.x}" cy="${n.y}" r="${destId ? 18 : 0}" fill="transparent"/>
        <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fill}" stroke="#0b1020" stroke-width="2.5" ${dash}/>
        <circle cx="${n.x}" cy="${n.y}" r="${r + 1.5}" fill="none" stroke="${isDest && !st ? 'rgba(200,210,235,0.6)' : '#ffffff'}" stroke-width="1.2" ${dash}/>
        ${wrapLabel(name, n.x, n.y + r + 12)}</g>`;
    }
    svg += '</svg>';
    const maxDv = Math.max(...m.lines.map((l) => l.totalDv), 1);
    const cards = m.lines.map((l) => {
      const st = fogD[l.destId];
      const w = windowFor(state, data, l.destId, q);
      const chip = st === 'player' ? '<span class="map-chip is-player">Visitado</span>' : st === 'rival' ? '<span class="map-chip is-rival">Rivais lá</span>' : homeChip(l.destId) || '<span class="map-chip">Inexplorado</span>';
      return `<li class="map-line ${sel === l.destId ? 'is-sel' : ''}" data-dest="${esc(l.destId)}" tabindex="0" role="button">
        <span class="map-line__sw" style="background:${l.color}"></span>
        <div class="map-line__main">
          <div class="map-line__head"><b>${esc(l.name)}</b>${chip}</div>
          <div class="map-dest__row"><span>Energia</span>${blocksHtml((l.totalDv / maxDv) * 10)}<em>${energyWord(l.totalDv)}</em></div>
          <div class="map-dest__row"><span>Viagem</span><em>${l.transitWeeks ? weeksToText(l.transitWeeks) : 'imediata'}</em>${w ? `<em class="map-line__win ${w.open ? 'is-open' : ''}">${w.open ? 'janela aberta' : `janela em ${weeksToText(w.weeksToOpen)}`}</em>` : ''}</div>
        </div></li>`;
    }).join('');
    metro.innerHTML = `<div class="map-metro__scroll">${svg}</div>
      <p class="map-metro__hint">Cada bloco é um trecho de energia. Mais blocos, foguete maior ou carga menor.</p>
      <ul class="map-lines">${cards}</ul>`;
  }

  function wrapLabel(text, x, y) {
    const words = String(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 13 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) lines.push(cur);
    return `<text x="${x}" y="${y}" text-anchor="middle" class="map-st__lbl">${lines.slice(0, 2).map((l, i) => `<tspan x="${x}" dy="${i ? 11 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
  }

  // ---------- input ----------
  const pointers = new Map();
  const gesture = { active: false, moved: false, sx: 0, sy: 0, pinch: null };

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onDown(e) {
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const p = localXY(e);
    pointers.set(e.pointerId, p);
    clearTimeout(snapTimer);
    if (tween) {
      const c = camNow();
      const f = positions[MEM.cam.follow] || { x: 0, y: 0 };
      MEM.cam = { ...MEM.cam, ox: c.cx - f.x, oy: c.cy - f.y, span: c.span };
      tween = null;
    }
    if (pointers.size === 1) Object.assign(gesture, { active: true, moved: false, sx: p.x, sy: p.y, lx: p.x, ly: p.y, pinch: null });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      gesture.moved = true;
    }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localXY(e);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && gesture.pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      zoomAt(mx, my, d / gesture.pinch.d);
      panBy(mx - gesture.pinch.mx, my - gesture.pinch.my);
      gesture.pinch = { d, mx, my };
    } else if (pointers.size === 1) {
      if (Math.hypot(p.x - gesture.sx, p.y - gesture.sy) > 7) gesture.moved = true;
      if (gesture.moved) panBy(p.x - gesture.lx, p.y - gesture.ly);
      gesture.lx = p.x;
      gesture.ly = p.y;
    }
  }
  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    const p = localXY(e);
    pointers.delete(e.pointerId);
    if (pointers.size === 1) {
      // pinch ended with one finger left: continue as pan without jumping
      const [rest] = [...pointers.values()];
      Object.assign(gesture, { lx: rest.x, ly: rest.y, pinch: null });
      return;
    }
    if (pointers.size === 0) {
      gesture.active = false;
      if (!gesture.moved && e.type === 'pointerup') onTap(p.x, p.y);
      else snap();
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const p = localXY(e);
    const k = e.deltaMode === 1 ? 40 : 1;
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * k * 0.0016));
    clearTimeout(snapTimer);
    snapTimer = setTimeout(snap, 240);
  }
  function onTap(x, y) {
    let best = null;
    let bd = Infinity;
    const prio = { transit: 0, dest: 1, body: 2 };
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d > Math.max(h.r, 22)) continue;
      const score = d / Math.max(h.r, 1) + prio[h.kind] * 0.35;
      if (score < bd) (bd = score), (best = h);
    }
    if (!best) {
      if (MEM.selected) closeSheet();
      return;
    }
    store?.vibrate?.(8);
    if (best.kind === 'body') openSheet({ bodyId: best.id });
    else if (best.kind === 'dest') openSheet({ bodyId: best.bodyId, destId: best.id });
    else {
      const t = model.transits.find((x) => x.key === best.id);
      openSheet({ bodyId: t?.bodyId || 'earth', transitKey: best.id });
    }
  }

  function onRootClick(e) {
    const t = e.target.closest?.('[data-mode],[data-level],[data-legend],[data-close],[data-body],[data-discovery],[data-dest]');
    if (!t) return;
    if (t.dataset.mode) {
      MEM.mode = t.dataset.mode;
      if (MEM.mode === 'metro') renderMetro();
      updateHud();
      invalidate();
    } else if (t.dataset.level) {
      goLevel(levelById(t.dataset.level));
    } else if (t.dataset.legend) {
      MEM.legend = !MEM.legend;
      updateHud();
    } else if (t.dataset.close) {
      closeSheet();
    } else if (t.dataset.discovery) {
      saveSeen([...loadSeen(), t.dataset.discovery]);
      discovery.classList.remove('is-open');
      discovery.innerHTML = '';
      openSheet({ bodyId: t.dataset.discovery });
      checkDiscoveries();
    } else if (t.dataset.body) {
      const lvl = levels.find((l) => l.focus === 'sun' && l.id === 'inner') || levels[1] || levels[0];
      if (t.dataset.body !== 'earth' && t.dataset.body !== 'moon') goLevel(lvl);
      openSheet({ bodyId: t.dataset.body });
    } else if (t.dataset.dest && metro.contains(t)) {
      MEM.metroSel = MEM.metroSel === t.dataset.dest ? null : t.dataset.dest;
      renderMetro();
    }
  }
  function onRootKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-dest]') && metro.contains(e.target)) {
      e.preventDefault();
      onRootClick(e);
    } else if (e.key === 'Escape' && MEM.selected) closeSheet();
  }
  const onVis = () => {
    if (!document.hidden) invalidate();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('click', onRootClick);
  root.addEventListener('keydown', onRootKey);
  document.addEventListener('visibilitychange', onVis);
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => resize());
    ro.observe(stage);
  } else globalThis.addEventListener?.('resize', resize);

  // ---------- store updates ----------
  function refresh() {
    state = store?.state || {};
    model = buildModel(state, data, q);
    positions = bodyPositions(data, state.turn ?? 0);
    updateHud();
    if (MEM.selected) renderSheet();
    if (MEM.mode === 'metro') renderMetro();
    checkDiscoveries();
    invalidate();
  }
  const unsub = typeof store?.subscribe === 'function' ? store.subscribe(() => refresh()) : null;

  function cleanup() {
    if (destroyed) return;
    destroyed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(snapTimer);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel);
    root.removeEventListener('click', onRootClick);
    root.removeEventListener('keydown', onRootKey);
    document.removeEventListener('visibilitychange', onVis);
    if (ro) ro.disconnect();
    else globalThis.removeEventListener?.('resize', resize);
    if (typeof unsub === 'function') unsub();
    if (container.__mapCleanup === cleanup) delete container.__mapCleanup;
  }
  container.__mapCleanup = cleanup;

  // first paint
  updateHud();
  if (MEM.mode === 'metro') renderMetro();
  renderSheet();
  resize();
  checkDiscoveries();
  invalidate();
  return cleanup;
}

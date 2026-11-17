// Aba Mapa: vista esquemática do sistema solar em canvas 2D (4 níveis de zoom semântico: Terra-Lua, interno,
// externo, completo), mapa de metrô das rotas por região, janelas de lançamento, missões em trânsito, névoa de
// guerra ("não mapeado") e presença dos rivais.
// A UI só lê o estado (store.state / store.query); nunca muta. Funções puras exportadas para testes em Node.
// Desempenho: fundo (estrelas + Via Láctea) pré-renderizado uma vez por tamanho; camada estática (órbitas,
// cinturões, corpos, rótulos) em canvas fora da tela, refeita só quando câmera/estado mudam; rAF só enquanto
// algo anima (transição de câmera, gesto, pulso das missões por alguns segundos).

import { weeksToText, formatTurn } from '../core/time.js';
import { makeRng } from '../core/rng.js';

/* ------------------------------------------------------------------ */
/* Constantes                                                          */
/* ------------------------------------------------------------------ */

const OK_OUTCOMES = ['total', 'partial'];
const CAL_OK = ['success', 'partial'];
const TRUNK_COLOR = '#cfd8e3';
const FALLBACK_ACTOR_COLORS = ['#4895ef', '#e63946', '#f4a261', '#2a9d8f', '#9b5de5', '#ffd166', '#06d6a0', '#ff8fab'];
const FOG_LABEL = { known: 'Mapeado', partial: 'Visitado por rivais', unknown: 'Não mapeado' };
const DEST_COLORS = { player: '#7fdcf5', rival: '#e6a23c' };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Zoom levels. Spans (world units across the short side of the screen) are fitted to the data when possible. */
const LEVEL_SPECS = [
  { id: 'earth_moon', name: 'Terra-Lua', short: 'Terra-Lua', focus: 'earth', frame: ['earth', 'moon'], span: 104 },
  { id: 'inner', name: 'Sistema interno', short: 'Interno', focus: 'sun', span: 1400, fit: ['asteroid_belt', 'mars'] },
  { id: 'outer', name: 'Sistema externo', short: 'Externo', focus: 'sun', span: 3860, fit: ['neptune'] },
  { id: 'full', name: 'Sistema completo', short: 'Completo', focus: 'sun', span: 5400, fit: ['kuiper_belt', 'pluto', 'heliopause'] },
];

/** Route lines of the metro map, one per region of the Solar System (Okabe–Ito based: readable for colorblind players). */
export const METRO_REGIONS = [
  { id: 'orbita', name: 'Linha da Órbita', short: 'Órbita', color: '#56b4e9' },
  { id: 'lua', name: 'Linha Lunar', short: 'Lua', color: '#cc79a7' },
  { id: 'venus', name: 'Linha Vênus–Mercúrio', short: 'Vênus', color: '#f0e442' },
  { id: 'marte', name: 'Linha de Marte', short: 'Marte', color: '#d55e00' },
  { id: 'asteroides', name: 'Linha dos Asteroides', short: 'Asteroides', color: '#009e73' },
  { id: 'externos', name: 'Linha dos Planetas Externos', short: 'Externos', color: '#a78bfa' },
];

/** Map-only looks the data does not carry: atmosphere rims and faint ring systems. */
const ATMOS = { earth: '#8ecae6', venus: '#f4e3b2', titan: '#e9b872' };
const RINGS = {
  saturn: { rot: -0.38, flat: 0.34, bands: [[1.28, 1.52, 0.42], [1.55, 1.95, 0.78], [2.02, 2.28, 0.55]] },
  uranus: { rot: 1.38, flat: 0.28, color: '#c7e6e8', bands: [[1.55, 1.62, 0.4], [1.78, 1.84, 0.32]] },
  jupiter: { rot: -0.06, flat: 0.16, color: '#d9c3a0', bands: [[1.55, 1.68, 0.18]] },
  neptune: { rot: -0.25, flat: 0.3, color: '#9fb3e8', bands: [[1.6, 1.66, 0.2], [1.92, 1.97, 0.16]] },
};

/* ------------------------------------------------------------------ */
/* Acesso defensivo a dados e estado                                   */
/* ------------------------------------------------------------------ */

const arr = (x) => (Array.isArray(x) ? x : []);
const asList = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x ? [x] : []); // firsts: "id" or ["id", ...]
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export function getBodies(data) {
  return arr(data?.bodies?.bodies);
}
function getMarkers(data) {
  return arr(data?.bodies?.markers);
}

/** Outer schematic radius of a body (belt edge, orbit) or marker (heliopause). */
function outerRadius(data, id) {
  const b = bodyById(data, id);
  if (b) return b.belt?.outer || b.orbit?.radius || 0;
  return getMarkers(data).find((m) => m.id === id)?.radius || 0;
}

/** The four zoom levels (Terra-Lua → interno → externo → completo). bodies.json levels can tune them by id. */
export function getLevels(data) {
  const given = arr(data?.bodies?.levels);
  const hasBodies = getBodies(data).length > 0;
  return LEVEL_SPECS.map((spec) => {
    const g = given.find((l) => l.id === spec.id) || {};
    let span = g.span || spec.span;
    if (spec.fit && hasBodies) {
      const r = Math.max(0, ...spec.fit.map((id) => outerRadius(data, id)));
      if (r > 0) span = r * 2 * 1.06;
    }
    return { ...spec, ...g, id: spec.id, name: spec.name, short: spec.short, focus: g.focus || spec.focus, span };
  });
}

/**
 * Level pill to highlight for a camera: the nearest level by span, except when the camera is framing some other
 * body up close (Vênus at a Terra-Lua-sized span is not the Terra-Lua view): then no pill is active (null).
 * `parentOf(id)` gives a body's parent. Pure: exported for tests.
 */
export function activeLevelFor(levels, span, follow, parentOf = () => null) {
  const lvl = levelForSpan(levels, span);
  const home = levels[0];
  if (lvl !== home || !follow || follow === 'sun' || follow === home.focus) return lvl;
  if (parentOf(follow) === home.focus) return lvl; // the Moon belongs to the Terra-Lua view
  return null;
}

/** Level whose span is nearest (log scale) to `span`. */
export function levelForSpan(levels, span) {
  let best = levels[0];
  let bd = Infinity;
  for (const l of levels) {
    const d = Math.abs(Math.log(span / l.span));
    if (d < bd) (bd = d), (best = l);
  }
  return best;
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

/** The body orbiting the Sun that a body belongs to (Titã → Saturno, Terra → Terra). */
function systemOf(data, bodyId) {
  let b = bodyById(data, bodyId);
  for (let g = 0; b && b.parent && b.parent !== 'sun' && g < 6; g++) b = bodyById(data, b.parent);
  return b;
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

/**
 * Deterministic particles for a belt body: `belt {inner, outer}` gives a band around the Sun ({x, y} world);
 * a cloud body (Troianos) gives polar offsets {dr, da} around its point and the opposite Lagrange point.
 */
export function beltParticles(body, n = 600) {
  let h = 7;
  for (const c of String(body?.id || 'belt')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rng = makeRng(h);
  const out = [];
  const gauss = () => (rng.next() + rng.next() + rng.next() - 1.5) / 1.5;
  if (body?.belt) {
    const { inner, outer } = body.belt;
    for (let i = 0; i < n; i++) {
      const u = (rng.next() + rng.next()) / 2; // denser in the middle of the band
      const r = inner + (outer - inner) * u;
      const a = rng.next() * TAU;
      out.push({ x: r * Math.cos(a), y: -r * Math.sin(a), k: rng.int(0, 2) });
    }
  } else {
    for (let i = 0; i < n; i++) {
      out.push({ dr: gauss() * 46, da: gauss() * 0.3, l5: i % 2 === 1, k: rng.int(0, 2) });
    }
  }
  return out;
}

/** Map region (metro line) of a destination: orbita, lua, venus, marte, asteroides, externos. */
export function destRegion(data, destId) {
  const bodyId = destBodyId(data, destId);
  if (!bodyId || bodyId === 'earth') return 'orbita';
  const sys = systemOf(data, bodyId);
  if (!sys) return 'orbita';
  if (sys.id === 'earth') return 'lua';
  if (sys.id === 'venus' || sys.id === 'mercury') return 'venus';
  if (sys.id === 'mars') return 'marte';
  if (sys.group === 'neo' || sys.group === 'belt') return 'asteroides';
  return 'externos';
}

/** Regions that have at least one destination, in metro order, with their destination ids. */
export function metroRegions(data) {
  const out = METRO_REGIONS.map((r) => ({ ...r, dests: [] }));
  for (const d of getDestinations(data)) {
    if (!arr(d.route).length) continue;
    out.find((r) => r.id === destRegion(data, d.id))?.dests.push(d.id);
  }
  return out.filter((r) => r.dests.length);
}

/**
 * World-space transfer arc for an interplanetary transit: polar interpolation around the Sun from Earth at
 * departure to the target's system at arrival (prograde, Hohmann-like half orbit when far from the window).
 */
export function transferPath(data, t, steps = 40) {
  const bodyId = destAnchors(data)[t?.destId]?.bodyId || t?.bodyId;
  const sys = systemOf(data, bodyId);
  if (!sys || sys.id === 'earth') return null;
  const P0 = bodyPositions(data, t.depart ?? 0);
  const P1 = bodyPositions(data, t.arrive ?? t.depart ?? 0);
  const e0 = P0.earth;
  const m1 = P1[sys.id];
  if (!e0 || !m1) return null;
  const r0 = Math.hypot(e0.x, e0.y);
  const r1 = Math.hypot(m1.x, m1.y);
  const a1 = Math.atan2(-m1.y, m1.x);
  let sweep = (((a1 - Math.atan2(-e0.y, e0.x)) % TAU) + TAU) % TAU;
  if (sweep < Math.PI * 0.6 || sweep > Math.PI * 1.25) sweep = Math.PI;
  const a0 = a1 - sweep;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const r = r0 + ((r1 - r0) * (1 - Math.cos(u * Math.PI))) / 2;
    const a = a0 + sweep * u;
    pts.push({ x: r * Math.cos(a), y: -r * Math.sin(a) });
  }
  return pts;
}

/**
 * Greedy label placement without overlaps. items: {id, x, y, r, w, h, prio}; tries below, above, right, left and
 * the diagonals of the anchor circle, keeps inside the screen and off other discs; lower prio is placed first.
 * `taken` boxes ({bx, by, w, h}) are already drawn by another pass and are avoided too.
 * Returns the placed items with their box {bx, by, w, h}, text centre (lx, ly) and align.
 */
export function placeLabels(items, { width = Infinity, height = Infinity, obstacles = [], gap = 3, margin = 2, taken = [] } = {}) {
  const placed = [];
  const boxes = taken.map((b) => ({ bx: b.bx, by: b.by, w: b.w, h: b.h })); // boxes already on screen (other passes)
  const overlaps = (b) => boxes.some((o) => b.bx < o.bx + o.w && b.bx + b.w > o.bx && b.by < o.by + o.h && b.by + b.h > o.by);
  const onDisc = (b, selfId) => obstacles.some((c) => {
    if (c.id === selfId || c.r < 2) return false;
    const nx = clamp(c.x, b.bx, b.bx + b.w);
    const ny = clamp(c.y, b.by, b.by + b.h);
    return Math.hypot(nx - c.x, ny - c.y) < c.r;
  });
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.prio ?? 0) - (b.it.prio ?? 0) || a.i - b.i);
  for (const { it } of sorted) {
    const r = it.r || 0;
    const { w, h } = it;
    const d = r + gap;
    const k = 0.72;
    const cands = it.only || [
      ['below', it.x, it.y + d + h / 2, 'center'],
      ['above', it.x, it.y - d - h / 2, 'center'],
      ['right', it.x + d, it.y, 'left'],
      ['left', it.x - d, it.y, 'right'],
      ['br', it.x + d * k, it.y + d * k + h / 2, 'left'],
      ['tr', it.x + d * k, it.y - d * k - h / 2, 'left'],
      ['bl', it.x - d * k, it.y + d * k + h / 2, 'right'],
      ['tl', it.x - d * k, it.y - d * k - h / 2, 'right'],
    ];
    for (const [pos, lx, ly, align] of cands) {
      const bx = align === 'left' ? lx : align === 'right' ? lx - w : lx - w / 2;
      const box = { bx, by: ly - h / 2, w, h };
      if (box.bx < margin || box.by < margin || box.bx + w > width - margin || box.by + h > height - margin) continue;
      if (overlaps(box) || onDisc(box, it.id)) continue;
      boxes.push(box);
      placed.push({ ...it, ...box, lx, ly, align, pos });
      break;
    }
  }
  return placed;
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

/** Arrival turn of a calendar instance (programs already in flight carry `arrivalTurn`). */
function calArrival(data, inst, def) {
  if (Number.isFinite(inst?.arrivalTurn)) return inst.arrivalTurn;
  const launchT = inst?.currentTurn ?? inst?.plannedTurn ?? 0;
  return launchT + (destById(data, def?.destination)?.transitWeeks || 0);
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
    if (calArrival(data, inst, def) > turn) continue; // still on the way
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
    const depart = inst.launchTurn ?? inst.currentTurn ?? inst.plannedTurn ?? 0;
    const arrive = calArrival(data, inst, def);
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

/** Route graph as a tree laid out in columns (depth) and rows. Pure: no DOM. Lines carry their region color. */
export function buildMetro(data, { colW = 96, rowH = 58, padX = 22, padY = 30 } = {}) {
  const nodes = {};
  const order = [];
  const node = (id) => nodes[id] || (order.push(id), (nodes[id] = { id, parent: null, children: [], dvIn: 0, lines: [], depth: 0 }));
  const lines = [];
  getDestinations(data).forEach((d) => {
    const route = arr(d.route).filter((s) => s && s.from != null && s.to != null);
    if (!route.length) return;
    const region = destRegion(data, d.id);
    const color = METRO_REGIONS.find((r) => r.id === region)?.color || TRUNK_COLOR;
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
    lines.push({ destId: d.id, name: d.name || d.id, short: d.short || d.name || d.id, region, color, path, terminal, totalDv, transitWeeks: d.transitWeeks || 0, segments: route.map((s) => ({ from: s.from, to: s.to, dv: Number(s.dv) || 0 })) });
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
    const color = shared ? TRUNK_COLOR : lines.find((l) => l.destId === n.lines[0])?.color || TRUNK_COLOR;
    return { from: p.id, to: id, dv: n.dvIn, x1: p.x, y1: p.y, x2: n.x, y2: n.y, color, lines: n.lines.slice() };
  });
  return { nodes, order, edges, lines, maxDepth, width: padX * 2 + maxDepth * colW + 70, height: padY * 2 + Math.max(0, row - 1) * rowH + 24 };
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
/* DOM / canvas helpers (só usados no navegador)                       */
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

/** Route legs as one segmented bar (trunk grey, legs in the line color), width relative to `maxDv`. */
function legsBarHtml(segments, color, maxDv) {
  const total = segments.reduce((t, s) => t + s.dv, 0);
  const parts = segments.map((s, i) => {
    const c = s.from === 'earth' ? TRUNK_COLOR : color;
    return `<i style="flex:${s.dv.toFixed(2)};background:${c};opacity:${s.from === 'earth' ? 0.55 : 0.6 + 0.4 * (i / Math.max(1, segments.length - 1))}" title="${s.dv.toFixed(1)} km/s"></i>`;
  }).join('');
  return `<span class="map-legs" aria-hidden="true"><span class="map-legs__fill" style="width:${Math.round((total / Math.max(1, maxDv)) * 100)}%">${parts}</span></span>`;
}

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [170, 170, 170];
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function shade(hex, k) {
  const [r, g, b] = hexRgb(hex);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
/** Mix a color toward grey-blue haze (unexplored worlds). */
function haze(hex, k = 0.6) {
  const [r, g, b] = hexRgb(hex);
  const t = [70, 80, 105];
  return `rgb(${Math.round(r + (t[0] - r) * k)},${Math.round(g + (t[1] - g) * k)},${Math.round(b + (t[2] - b) * k)})`;
}
function toHex(rgbStr) {
  const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(rgbStr || '');
  if (!m) return rgbStr;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}
function hashAngle(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return (h % 628) / 100;
}

/* Persistent view across re-renders (app.js re-renders the tab on every state change). */
const MEM = { mode: 'map', cam: null, selected: null, metroRegion: null, legend: false, prog: {}, intro: false };
/* Pre-rendered layers shared across re-renders: background per size, belt particles per body. */
const CACHE = { bgKey: '', bg: null, belts: {} };

function beltCache(b) {
  if (!CACHE.belts[b.id]) CACHE.belts[b.id] = beltParticles(b, b.belt ? (b.group === 'trans' || b.belt.outer > 1200 ? 1500 : 950) : 300);
  return CACHE.belts[b.id];
}

/** Deep-space background: gradient, faint Milky Way band and a starfield. Drawn once per canvas size. */
function backgroundCanvas(W, H, dpr) {
  const key = `${W}x${H}@${dpr}`;
  if (CACHE.bg && CACHE.bgKey === key) return CACHE.bg;
  const off = document.createElement('canvas');
  off.width = Math.round(W * dpr);
  off.height = Math.round(H * dpr);
  const g = off.getContext('2d');
  if (!g) return off;
  g.scale(dpr, dpr);
  const bg = g.createRadialGradient(W * 0.35, H * 0.3, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.9);
  bg.addColorStop(0, '#0d1530');
  bg.addColorStop(0.55, '#070b1a');
  bg.addColorStop(1, '#03050c');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const rng = makeRng(4242);
  // Milky Way: a soft diagonal band with dust
  const ang = -0.52;
  const len = Math.hypot(W, H) * 1.2;
  const bw = Math.min(W, H) * 0.24;
  g.save();
  g.translate(W * 0.5, H * 0.52);
  g.rotate(ang);
  const band = g.createLinearGradient(0, -bw, 0, bw);
  band.addColorStop(0, 'rgba(120,130,190,0)');
  band.addColorStop(0.35, 'rgba(120,135,200,0.05)');
  band.addColorStop(0.5, 'rgba(190,180,225,0.085)');
  band.addColorStop(0.65, 'rgba(120,135,200,0.05)');
  band.addColorStop(1, 'rgba(120,130,190,0)');
  g.fillStyle = band;
  g.fillRect(-len / 2, -bw, len, bw * 2);
  const nDust = Math.round((W * H) / 220);
  for (let i = 0; i < nDust; i++) {
    const x = (rng.next() - 0.5) * len;
    const y = ((rng.next() + rng.next() + rng.next() - 1.5) / 1.5) * bw * 0.9;
    const a = 0.04 + rng.next() * 0.14;
    g.fillStyle = `rgba(${200 + rng.int(0, 40)},${195 + rng.int(0, 40)},255,${a.toFixed(3)})`;
    g.fillRect(x, y, 0.8, 0.8);
  }
  // dark dust lane
  const lane = g.createLinearGradient(0, -bw * 0.18, 0, bw * 0.18);
  lane.addColorStop(0, 'rgba(3,5,12,0)');
  lane.addColorStop(0.5, 'rgba(3,5,12,0.18)');
  lane.addColorStop(1, 'rgba(3,5,12,0)');
  g.fillStyle = lane;
  g.fillRect(-len / 2, -bw * 0.18 + bw * 0.08, len, bw * 0.36);
  g.restore();
  // stars
  const n = Math.round((W * H) / 1500);
  for (let i = 0; i < n; i++) {
    const x = rng.next() * W;
    const y = rng.next() * H;
    const big = rng.next();
    const a = 0.25 + rng.next() * 0.55;
    const tint = rng.next();
    const col = tint < 0.15 ? `255,${215 + rng.int(0, 30)},${180 + rng.int(0, 30)}` : tint < 0.35 ? `${190 + rng.int(0, 30)},${210 + rng.int(0, 30)},255` : '235,240,255';
    g.fillStyle = `rgba(${col},${a.toFixed(2)})`;
    const r = big > 0.985 ? 1.35 : big > 0.9 ? 0.95 : 0.6;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    if (big > 0.993) {
      g.strokeStyle = `rgba(${col},0.25)`;
      g.lineWidth = 0.6;
      g.beginPath();
      g.moveTo(x - 4, y);
      g.lineTo(x + 4, y);
      g.moveTo(x, y - 4);
      g.lineTo(x, y + 4);
      g.stroke();
    }
  }
  CACHE.bg = off;
  CACHE.bgKey = key;
  return off;
}

/* ------------------------------------------------------------------ */
/* render(container, store)                                            */
/* ------------------------------------------------------------------ */

export function render(container, store) {
  if (!container || typeof document === 'undefined') return () => {};
  if (typeof container.__mapCleanup === 'function') container.__mapCleanup();

  const data = store?.data || {};
  const q = makeQuery(store);
  const levels = getLevels(data);
  const bodies = getBodies(data);
  const bodyIdx = Object.fromEntries(bodies.map((b) => [b.id, b]));
  let sceneLabelBoxes = []; // label boxes of the last scene pass (the dynamic layer avoids them)
  const anchors = destAnchors(data);
  const settings = () => store?.settings || {};
  const reduceMotion = () => !!settings().reduceMotion || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const colorblind = () => !!settings().colorblind || !!document.body?.classList?.contains('colorblind');
  const textScale = () => Number(settings().textScale) || 1;
  const now0 = () => (globalThis.performance?.now?.() ?? 0);

  let state = store?.state || {};
  let model = buildModel(state, data, q);
  let positions = bodyPositions(data, state.turn ?? 0);
  let version = 0;
  const pathCache = new Map();

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
  levelBar.setAttribute('role', 'group');
  levelBar.setAttribute('aria-label', 'Nível de zoom');
  levelBar.innerHTML = levels.map((l) => `<button type="button" data-level="${esc(l.id)}" title="${esc(l.name)}">${esc(l.short || l.name)}</button>`).join('') + `<button type="button" class="map-legend-btn" data-legend="1" aria-label="Legenda">?</button>`;
  const stage = el('div', 'map-stage');
  const canvas = document.createElement('canvas');
  canvas.className = 'map-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Mapa do sistema solar. Toque em um corpo para abrir a ficha; pinça ou toque duplo para aproximar.');
  stage.append(canvas);
  const zoomBox = el('div', 'map-zoom', `<button type="button" data-zoom="in" aria-label="Aproximar">+</button><button type="button" data-zoom="out" aria-label="Afastar">−</button>`);
  const legend = el('div', 'map-legend');
  const winBox = el('div', 'map-windows');
  const metro = el('div', 'map-metro');
  const sheet = el('div', 'map-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'false');
  const discovery = el('div', 'map-discovery');
  stage.append(zoomBox, legend, winBox, discovery);
  root.append(hud, levelBar, stage, metro, sheet);
  container.append(root);

  const cx2d = canvas.getContext?.('2d');
  const scene = document.createElement('canvas');
  const sg = scene.getContext?.('2d');
  let sceneKey = '';
  let W = 0;
  let H = 0;
  let dpr = 1;
  let hits = [];
  let tHits = [];
  let lastScr = {};
  let rafId = 0;
  let lastDraw = 0;
  let tween = null;
  let destroyed = false;
  let drawErrorLogged = false;
  let animUntil = 0;
  const progAnim = {};

  const bump = (ms = 16000) => { animUntil = Math.max(animUntil, now0() + ms); };

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
  if (!MEM.cam) MEM.cam = { follow: levels[1]?.focus || levels[0].focus, ...levelOffset(levels[1] || levels[0]), span: (levels[1] || levels[0]).span };
  // max zoom: Earth about 64 px with its orbits (LEO, ISS, SSO, GTO) readable on a 375 px phone
  const spanMin = Math.min(levels[0].span * 0.21, 24);
  const spanMax = levels[levels.length - 1].span * 1.3;

  function camNow(now = now0()) {
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
      // zoom and pan move together on a log scale so far jumps (Terra-Lua → completo) feel even
      const ls = Math.log(tween.from.span) + (Math.log(tween.to.span) - Math.log(tween.from.span)) * e;
      span = Math.exp(ls);
      cx = tween.from.cx + (tx - tween.from.cx) * e;
      cy = tween.from.cy + (ty - tween.from.cy) * e;
      if (t >= 1) {
        MEM.cam = { ...tween.to };
        tween = null;
      }
    }
    return { cx, cy, s: minDim() / span, span };
  }

  const targetSpan = () => (tween ? tween.to.span : MEM.cam.span);
  const currentLevel = () => levelForSpan(levels, targetSpan());
  const parentOf = (id) => bodyIdx[id]?.parent ?? null;

  function moveTo(to, dur = 650) {
    const cam = camNow();
    to.span = clamp(to.span, spanMin, spanMax);
    if (reduceMotion() || !W) {
      tween = null;
      MEM.cam = to;
    } else {
      tween = { from: { cx: cam.cx, cy: cam.cy, span: cam.span }, to, t0: now0(), dur };
    }
    updateLevelBar(activeLevelFor(levels, to.span, to.follow, parentOf)?.id ?? null);
    bump(4000);
    invalidate();
  }

  /** Smoothly move to a level. */
  function goLevel(level) {
    const o = levelOffset(level);
    // the window chips cover the bottom of the stage: centre the level in the area above them
    const under = Math.min(H * 0.3, winBox.getBoundingClientRect?.().height || 0);
    if (H) o.oy += under / 2 / (minDim() / level.span);
    moveTo({ follow: level.focus, ...o, span: level.span }, 700);
  }

  /** Frame a body with its moons (semantic zoom: its destinations appear), above the card when one is open. */
  function goBody(bodyId, withSheet = !!MEM.selected) {
    const b = bodyIdx[bodyId];
    if (!b) return;
    if (b.belt) {
      const lvl = levels.find((l) => l.span >= b.belt.outer * 2) || levels[levels.length - 1];
      goLevel(lvl);
      return;
    }
    if (bodyId === 'sun') { goLevel(levelById('inner')); return; }
    if (bodyId === 'earth' || b.parent === 'earth') { goLevel(levels[0]); return; }
    const moons = bodies.filter((m) => m.parent === bodyId && m.orbit?.radius);
    const dr = b.display?.radius || 2;
    let span = (minDim() * dr) / 46;
    if (moons.length) span = Math.max(span, Math.max(...moons.map((m) => m.orbit.radius)) * 2.5);
    span = clamp(span, spanMin, spanMax);
    // with the card open the free area is the top ~45% of the stage: centre the body there
    const oy = withSheet && H ? (H / 2 - (H * 0.45) / 2) / (minDim() / span) : 0;
    moveTo({ follow: bodyId, ox: 0, oy, span }, 750);
  }

  /** Camera after zooming by `factor` about screen point (sx, sy). */
  function zoomedCam(cam, sx, sy, factor) {
    const span = clamp(cam.span / factor, spanMin, spanMax);
    const s2 = minDim() / span;
    const wx = cam.cx + (sx - W / 2) / cam.s;
    const wy = cam.cy + (sy - H / 2) / cam.s;
    const ncx = wx - (sx - W / 2) / s2;
    const ncy = wy - (sy - H / 2) / s2;
    // the followed body changes with the level (Terra up close, Sol from afar) without moving the view;
    // a body framed with goBody keeps being followed while the zoom stays close to it
    const lvl = levelForSpan(levels, span);
    const keep = MEM.cam.follow !== 'sun' && MEM.cam.follow !== 'earth' && span < levels[1].span * 0.5;
    const follow = keep ? MEM.cam.follow : lvl.focus;
    const f = positions[follow] || { x: 0, y: 0 };
    return { follow, ox: ncx - f.x, oy: ncy - f.y, span };
  }

  function zoomAt(sx, sy, factor) {
    const cam = camNow();
    tween = null;
    MEM.cam = zoomedCam(cam, sx, sy, factor);
    updateLevelBar();
    invalidate();
  }
  function zoomAnimated(sx, sy, factor) {
    moveTo(zoomedCam(camNow(), sx, sy, factor), 420);
  }
  function panBy(dx, dy) {
    const cam = camNow();
    tween = null;
    MEM.cam = { ...MEM.cam, ox: MEM.cam.ox - dx / cam.s, oy: MEM.cam.oy - dy / cam.s, span: cam.span };
    invalidate();
  }
  /** Stop a running tween where it is (a finger landed on the map). */
  function freezeTween() {
    if (!tween) return;
    const c = camNow();
    const follow = tween.to.follow;
    const f = positions[follow] || { x: 0, y: 0 };
    MEM.cam = { follow, ox: c.cx - f.x, oy: c.cy - f.y, span: c.span };
    tween = null;
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
    scene.width = canvas.width;
    scene.height = canvas.height;
    sceneKey = '';
    invalidate();
  }

  // ---------- frame loop: draws only when invalidated; loops only while animating ----------
  function invalidate() {
    if (!rafId && !destroyed) rafId = requestAnimationFrame(frame);
  }
  const visibleTransits = () => model.transits.length > 0;
  function ambient(now) {
    return MEM.mode === 'map' && !reduceMotion() && !document.hidden && visibleTransits() && now < animUntil;
  }
  function progBusy(now) {
    return Object.values(progAnim).some((a) => now - a.t0 < a.dur);
  }
  function frame(now) {
    rafId = 0;
    if (destroyed) return;
    if (!root.isConnected) return cleanup();
    const busy = !!tween || gesture.active || progBusy(now);
    const amb = ambient(now);
    if (MEM.mode === 'map' && (busy || !amb || now - lastDraw > 33)) {
      try {
        draw(now);
      } catch (e) {
        if (!drawErrorLogged) console.warn('[mapa] erro ao desenhar', e);
        drawErrorLogged = true;
      }
      lastDraw = now;
    }
    if (busy || amb) rafId = requestAnimationFrame(frame);
  }

  // ---------- drawing ----------
  function draw(now) {
    if (!cx2d || !sg || !W || !H) return;
    const cam = camNow(now);
    const ts = textScale();
    const cb = colorblind();
    const key = `${cam.cx.toFixed(2)}|${cam.cy.toFixed(2)}|${cam.s.toFixed(5)}|${W}|${H}|${dpr}|${version}|${ts}|${cb}|${MEM.selected ? JSON.stringify(MEM.selected) : ''}`;
    if (key !== sceneKey) {
      drawScene(sg, cam, ts, cb);
      sceneKey = key;
    }
    const g = cx2d;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(backgroundCanvas(W, H, dpr), 0, 0);
    g.drawImage(scene, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDynamic(g, cam, now, ts, cb);
  }

  const radiusOf = (b, s) => clamp((b.display?.radius ?? 3) * s, b.display?.minPx ?? 4, b.display?.maxPx ?? 60);

  /** Screen geometry: satellites fade in once they separate from their planet (semantic zoom). */
  function screenGeometry(cam) {
    const s = cam.s;
    const toS = (p) => ({ x: (p.x - cam.cx) * s + W / 2, y: (p.y - cam.cy) * s + H / 2 });
    const scr = {};
    const place = (b, depth = 0) => {
      if (scr[b.id] || depth > 6) return scr[b.id];
      let sp = toS(positions[b.id] || { x: 0, y: 0 });
      let R = radiusOf(b, s);
      let vis = 1;
      const parent = b.parent && b.parent !== 'sun' ? bodyIdx[b.parent] : null;
      if (parent) {
        const ps = place(parent, depth + 1);
        const dx = sp.x - ps.x;
        const dy = sp.y - ps.y;
        const d = Math.hypot(dx, dy) || 1;
        vis = ps.vis ? clamp((d - ps.R - 2) / (R + 8), 0, 1) : 0;
        const minSep = ps.R + R + 5;
        if (d < minSep) sp = { x: ps.x + (dx / d) * minSep, y: ps.y + (dy / d) * minSep };
      }
      scr[b.id] = { x: sp.x, y: sp.y, R, vis, b };
      return scr[b.id];
    };
    for (const b of bodies) place(b);
    return { scr, toS };
  }

  function anchorScreen(a, p, scr) {
    const ang = (a.angle || 0) * DEG;
    if (a.anchor === 'surface') return { x: p.x + Math.cos(ang) * p.R, y: p.y - Math.sin(ang) * p.R };
    if (a.anchor === 'lagrange') {
      const from = scr[a.from];
      if (!from) return null;
      const f = a.f ?? 0.8;
      return { x: from.x + (p.x - from.x) * f, y: from.y + (p.y - from.y) * f };
    }
    const rr = ringRadius(a, p);
    const k = a.tilt || 1;
    return { x: p.x + Math.cos(ang) * rr * k, y: p.y - Math.sin(ang) * rr };
  }
  /** Destination rings scale with the drawn planet, so they stay outside the disc at every zoom. */
  function ringRadius(a, p) {
    const dr = p.b.display?.radius || 1;
    return Math.max(p.R + 5, (p.R * (a.r || dr * 1.3)) / dr);
  }

  function drawScene(g, cam, ts, cb) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, scene.width, scene.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = cam.s;
    const { scr, toS } = screenGeometry(cam);
    lastScr = scr;
    hits = [];
    const fog = model.fog.bodies;
    const sun = scr.sun || toS({ x: 0, y: 0 });
    const sel = MEM.selected;
    const selBody = sel?.bodyId;
    const onScreen = (p, m = 80) => p.x > -m && p.y > -m && p.x < W + m && p.y < H + m;
    const labels = [];
    const obstacles = [];
    const fs = (px) => px * ts;

    // heliopause (marker)
    for (const m of getMarkers(data)) {
      const r = (m.radius || 0) * s;
      if (r < 40 || r > 6 * Math.max(W, H)) continue;
      g.save();
      g.strokeStyle = 'rgba(150,170,255,0.22)';
      g.setLineDash([2, 6]);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(sun.x, sun.y, r, 0, TAU);
      g.stroke();
      const glow = g.createRadialGradient(sun.x, sun.y, r * 0.96, sun.x, sun.y, r * 1.04);
      glow.addColorStop(0, 'rgba(120,140,255,0)');
      glow.addColorStop(0.5, 'rgba(120,140,255,0.05)');
      glow.addColorStop(1, 'rgba(120,140,255,0)');
      g.setLineDash([]);
      g.strokeStyle = glow;
      g.lineWidth = r * 0.08;
      g.beginPath();
      g.arc(sun.x, sun.y, r, 0, TAU);
      g.stroke();
      g.restore();
      const lp = { x: sun.x, y: sun.y - r };
      if (onScreen(lp, 0)) labels.push({ id: m.id, text: m.name, x: lp.x, y: lp.y, r: 2, prio: 3.4, size: fs(10), color: 'rgba(170,185,255,0.7)', italic: true, only: [['below', lp.x, lp.y + 10, 'center']] });
    }

    // belts as dotted particle bands
    for (const b of bodies) {
      if (b.kind !== 'belt') continue;
      drawBelt(g, b, cam, scr, fog[b.id], labels, ts);
    }

    // orbits
    for (const b of bodies) {
      if (!b.orbit?.radius || b.kind === 'belt') continue;
      const p = scr[b.id];
      const heli = b.parent === 'sun';
      const ps = heli ? sun : scr[b.parent];
      if (!ps || !p) continue;
      const r = heli ? b.orbit.radius * s : Math.hypot(p.x - ps.x, p.y - ps.y);
      if (r < 5 || r > 30000) continue;
      if (Math.hypot(ps.x - W / 2, ps.y - H / 2) - r > Math.hypot(W, H)) continue; // whole circle off-screen
      const f = fog[b.id];
      const minor = b.kind === 'asteroid' || (b.kind === 'dwarf' && b.group === 'belt');
      let a = heli ? (f === 'unknown' ? 0.16 : 0.3) : 0.16 * p.vis;
      if (minor) a = clamp((s - 0.42) / 0.6, 0, 1) * 0.16;
      if (b.id === selBody) a = Math.max(a, 0.5);
      if (a < 0.01) continue;
      g.lineWidth = b.id === selBody ? 1.4 : 0.9;
      g.setLineDash(f === 'unknown' || minor ? [2, 4] : []);
      const ang = Math.atan2(p.y - ps.y, p.x - ps.x);
      if (heli && !minor && g.createConicGradient && f !== 'unknown') {
        // brighter at the planet, fading along the trail behind it
        const cg = g.createConicGradient(ang, ps.x, ps.y);
        cg.addColorStop(0, `rgba(175,195,240,${Math.min(0.75, a * 2.1)})`);
        cg.addColorStop(0.3, `rgba(160,180,230,${a * 0.75})`);
        cg.addColorStop(1, `rgba(160,180,230,${a * 0.45})`);
        g.strokeStyle = cg;
      } else g.strokeStyle = `rgba(165,185,230,${a})`;
      g.beginPath();
      g.arc(ps.x, ps.y, r, 0, TAU);
      g.stroke();
    }
    g.setLineDash([]);

    // launch windows: arc on the target's orbit (+ alignment line when open)
    const winList = model.windows.filter((w) => w.open || w.weeksToOpen <= 30);
    const seenSys = new Set();
    for (const w of winList) {
      const b = bodyIdx[w.bodyId];
      const sys = b?.parent === 'sun' ? b : systemOf(data, w.bodyId);
      const bs = sys && scr[sys.id];
      // planets only (NEO windows stay in the chips: their arcs would crowd Earth's orbit), and not up close
      if (!sys || !bs || sys.parent !== 'sun' || !scr.earth || !['planet', 'dwarf'].includes(sys.kind) || s >= 1) continue;
      if (seenSys.has(sys.id) || seenSys.size >= 4) continue;
      seenSys.add(sys.id);
      const r = sys.orbit.radius * s;
      if (r < 24 || r > 4 * Math.max(W, H)) continue;
      const ang = Math.atan2(bs.y - sun.y, bs.x - sun.x);
      g.lineCap = 'round';
      g.lineWidth = 3;
      g.strokeStyle = w.open ? 'rgba(76,201,240,0.8)' : 'rgba(255,209,102,0.5)';
      g.beginPath();
      g.arc(sun.x, sun.y, r, ang - 0.2, ang + 0.2);
      g.stroke();
      g.lineCap = 'butt';
      if (w.open) {
        g.lineWidth = 1;
        g.setLineDash([4, 5]);
        g.strokeStyle = 'rgba(76,201,240,0.45)';
        g.beginPath();
        g.moveTo(scr.earth.x, scr.earth.y);
        g.lineTo(bs.x, bs.y);
        g.stroke();
        g.setLineDash([]);
      }
      if (s < 1 && r >= 60 && onScreen(bs, 0)) {
        labels.push({ id: `win:${w.bodyId}`, text: w.open ? 'Janela aberta' : `Janela em ${weeksToText(w.weeksToOpen)}`, x: bs.x, y: bs.y, r: bs.R + 14, prio: 5, size: fs(10), color: w.open ? '#7fdcf5' : '#ffd98a' });
      }
    }

    // bodies (Sun, planets, then satellites over them)
    const order = bodies.filter((b) => b.kind !== 'belt').sort((a, b) => (a.parent && a.parent !== 'sun' ? 1 : 0) - (b.parent && b.parent !== 'sun' ? 1 : 0));
    for (const b of order) {
      const p = scr[b.id];
      if (!p || p.vis <= 0.02 || !onScreen(p, p.R * 3 + 40)) continue;
      g.globalAlpha = p.vis;
      if (!b.parent || b.kind === 'star') drawSun(g, p);
      else drawPlanet(g, b, p, fog[b.id], sun, cb);
      g.globalAlpha = 1;
      obstacles.push({ id: b.id, x: p.x, y: p.y, r: p.R + (RINGS[b.id] && p.R >= 6 ? p.R * 0.6 : 0) });
      if (p.vis > 0.5) hits.push({ x: p.x, y: p.y, r: Math.max(p.R + 4, 16), kind: 'body', id: b.id });
    }

    // destination rings and markers: appear once the planet is big enough on screen
    for (const b of order) {
      const p = scr[b.id];
      if (!p || p.vis < 0.6 || p.R < 11 || !onScreen(p, 200)) continue;
      const a0 = clamp((p.R - 11) / 9, 0, 1) * p.vis;
      arr(b.destinations).forEach((a, i) => {
        const pos = anchorScreen(a, p, scr);
        if (!pos) return;
        const st = model.fog.dests[a.id];
        if (a.anchor === 'ring') {
          const rr = ringRadius(a, p);
          g.strokeStyle = st === 'player' ? `rgba(127,220,245,${0.5 * a0})` : st === 'rival' ? `rgba(230,162,60,${0.35 * a0})` : `rgba(200,210,235,${0.18 * a0})`;
          g.lineWidth = 1;
          g.setLineDash(st ? [] : [3, 4]);
          g.beginPath();
          if (a.tilt) g.ellipse(p.x, p.y, rr * a.tilt, rr, 0, 0, TAU);
          else g.arc(p.x, p.y, rr, 0, TAU);
          g.stroke();
          g.setLineDash([]);
        }
        g.globalAlpha = a0;
        drawDestMarker(g, pos, st, sel?.destId === a.id, cb);
        g.globalAlpha = 1;
        if (a0 > 0.5) hits.push({ x: pos.x, y: pos.y, r: 14, kind: 'dest', id: a.id, bodyId: b.id });
        if (p.R >= 20 && a0 > 0.6) {
          const name = destById(data, a.id)?.short && p.R < 34 ? destById(data, a.id).short : a.label || destName(data, a.id);
          labels.push({ id: `d:${a.id}`, text: name, x: pos.x, y: pos.y, r: 6, prio: 6 + i * 0.01 - (sel?.destId === a.id ? 6.5 : 0), size: fs(10), color: st === 'player' ? '#bfeefb' : st === 'rival' ? '#f2cf94' : 'rgba(205,215,240,0.75)' });
        }
      });
    }

    // presence flags (satellites too small to see hand their flags to the planet)
    const flagMap = {};
    for (const [bodyId, list] of Object.entries(model.presence)) {
      let p = scr[bodyId];
      let target = bodyId;
      if (p && p.vis < 0.5) {
        const sys = systemOf(data, bodyId);
        target = sys?.id || bodyId;
        p = scr[target];
      }
      if (!p || !onScreen(p)) continue;
      const lst = (flagMap[target] ||= []);
      for (const e of list) if (!lst.includes(e.actorId)) lst.push(e.actorId);
    }
    for (const [bodyId, list] of Object.entries(flagMap)) {
      const p = scr[bodyId];
      list.slice(0, 5).forEach((actorId, i) => {
        const a = actorInfo(state, data, actorId);
        const fx = p.x + Math.max(p.R * 0.6, 3) + i * (cb ? 11 : 8);
        const fy = p.y - Math.max(p.R * 0.75, 4) - 6;
        drawFlag(g, fx, fy, a.color, actorId === state.playerId, cb ? a.short.slice(0, 1) : '');
        obstacles.push({ id: bodyId, x: fx + 3, y: fy, r: 5 });
      });
    }

    // body labels (priority: selected, Sun, big planets, dwarfs, moons, asteroids)
    for (const b of order) {
      const p = scr[b.id];
      if (!p || p.vis < 0.6 || !onScreen(p, 0)) continue;
      const f = fog[b.id];
      const minor = b.kind === 'asteroid' || b.kind === 'comet';
      if (minor && s < 0.2 && b.id !== selBody) continue;
      // semantic zoom: inner worlds crowd the Sun from afar; only Earth keeps its name there
      const orbitPx = b.parent === 'sun' ? (b.orbit?.radius || 0) * s : Infinity;
      if (orbitPx < 48 && b.id !== 'earth' && b.id !== selBody && b.kind !== 'star') continue;
      let prio = b.kind === 'star' ? 0.5 : b.kind === 'planet' ? 1 + (1 - Math.min(1, (b.display?.radius || 1) / 22)) * 0.5 : b.kind === 'dwarf' ? 2 : b.kind === 'moon' ? (b.id === 'moon' ? 1.6 : 2.5) : 3.5;
      if (b.id === selBody) prio = -1;
      const text = f === 'unknown' ? `${b.name} ?` : b.name;
      const size = fs(b.kind === 'planet' || b.kind === 'star' ? 11.5 : 10.5);
      const color = f === 'unknown' ? 'rgba(185,195,222,0.62)' : f === 'partial' ? '#ecdcb5' : '#eaf0ff';
      labels.push({ id: b.id, text, x: p.x, y: p.y, r: p.R + (RINGS[b.id] && p.R >= 6 ? p.R * 0.5 : 0), prio, size, color, caps: b.kind === 'planet' });
    }

    // place and draw labels
    for (const it of labels) {
      g.font = labelFont(it);
      setSpacing(g, it.caps ? 0.6 : 0);
      it.w = g.measureText(it.text).width + 4;
      it.h = it.size * 1.25;
    }
    const placed = placeLabels(labels, { width: W, height: H, obstacles });
    sceneLabelBoxes = placed.map((it) => ({ bx: it.bx, by: it.by, w: it.w, h: it.h }));
    for (const it of placed) {
      g.font = labelFont(it);
      setSpacing(g, it.caps ? 0.6 : 0);
      drawLabel(g, it.text, it.lx, it.ly, it.color, it.align);
    }
    setSpacing(g, 0);

    // Sun direction when it is off-screen (Terra-Lua)
    if (sun.x < 0 || sun.y < 0 || sun.x > W || sun.y > H) edgeArrow(g, sun, 'Sol', ts);

    // selection highlight
    if (selBody && scr[selBody] && scr[selBody].vis > 0.3) {
      const p = scr[selBody];
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 1.4;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.arc(p.x, p.y, p.R + 7, 0, TAU);
      g.stroke();
      g.setLineDash([]);
    }
  }

  function labelFont(it) {
    return `${it.italic ? 'italic ' : ''}600 ${it.size.toFixed(1)}px ${FONT}`;
  }
  function setSpacing(g, px) {
    if ('letterSpacing' in g) g.letterSpacing = `${px}px`;
  }

  function drawBelt(g, b, cam, scr, fogState, labels, ts) {
    const s = cam.s;
    const unknown = fogState === 'unknown';
    const col = hexRgb(b.display?.color || '#8a8478');
    const sun = scr.sun || { x: W / 2, y: H / 2 };
    const parts = beltCache(b);
    const alphas = unknown ? [0.12, 0.2, 0.3] : [0.22, 0.38, 0.6];
    const sizes = [0.8, 1.1, 1.5];
    if (b.belt) {
      const ri = b.belt.inner * s;
      const ro = b.belt.outer * s;
      if (ro < 8 || ri > 4 * Math.hypot(W, H)) return;
      // soft band
      const grad = g.createRadialGradient(sun.x, sun.y, ri, sun.x, sun.y, ro);
      const base = unknown ? 0.025 : 0.05;
      grad.addColorStop(0, `rgba(${col},0)`);
      grad.addColorStop(0.5, `rgba(${col},${base})`);
      grad.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sun.x, sun.y, ro, 0, TAU);
      g.arc(sun.x, sun.y, ri, 0, TAU, true);
      g.fill('evenodd');
      // particles, thinned when the band is tiny
      const step = ro < 60 ? 3 : ro < 140 ? 2 : 1;
      for (let k = 0; k < 3; k++) {
        g.fillStyle = `rgba(${col[0] + 40},${col[1] + 40},${col[2] + 40},${alphas[k]})`;
        g.beginPath();
        const z = sizes[k];
        for (let i = k; i < parts.length; i += 3 * step) {
          const pt = parts[i];
          const x = (pt.x - cam.cx) * s + W / 2;
          const y = (pt.y - cam.cy) * s + H / 2;
          if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
          g.rect(x, y, z, z);
        }
        g.fill();
      }
      if (unknown) {
        g.strokeStyle = 'rgba(170,180,215,0.16)';
        g.setLineDash([2, 6]);
        g.lineWidth = 1;
        for (const r of [ri, ro]) { g.beginPath(); g.arc(sun.x, sun.y, r, 0, TAU); g.stroke(); }
        g.setLineDash([]);
      }
      // label sits on the band at the body's angle; tap anywhere on the band opens it
      const mid = ((b.belt.inner + b.belt.outer) / 2) * s;
      const a = (b.orbit?.angle0 || 0) * DEG;
      const lp = { x: sun.x + Math.cos(a) * mid, y: sun.y - Math.sin(a) * mid };
      hits.push({ kind: 'belt', id: b.id, ri, ro, cx: sun.x, cy: sun.y });
      if (lp.x > 0 && lp.x < W && lp.y > 0 && lp.y < H && ro - ri > 6) {
        labels.push({ id: b.id, text: unknown ? `${b.name} ?` : b.name, x: lp.x, y: lp.y, r: 2, prio: 2.8, size: 10 * ts, italic: true, color: unknown ? 'rgba(180,190,215,0.6)' : 'rgba(215,205,180,0.85)' });
      }
      return;
    }
    // cloud (Troianos): around the body's point (L4) and the opposite Lagrange point (L5)
    const p = scr[b.id];
    if (!p) return;
    const R = Math.hypot((positions[b.id]?.x || 0), (positions[b.id]?.y || 0));
    const base = positions[b.id]?.angle || 0;
    if (R * s < 30) return;
    for (let k = 0; k < 3; k++) {
      g.fillStyle = `rgba(${col[0] + 40},${col[1] + 40},${col[2] + 40},${alphas[k]})`;
      g.beginPath();
      for (let i = k; i < parts.length; i += 3) {
        const pt = parts[i];
        const ang = base + pt.da - (pt.l5 ? 120 * DEG : 0);
        const rr = R + pt.dr;
        const x = (rr * Math.cos(ang) - cam.cx) * s + W / 2;
        const y = (-rr * Math.sin(ang) - cam.cy) * s + H / 2;
        if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
        g.rect(x, y, sizes[k], sizes[k]);
      }
      g.fill();
    }
    hits.push({ x: p.x, y: p.y, r: 20, kind: 'body', id: b.id });
    labels.push({ id: b.id, text: unknown ? `${b.name} ?` : b.name, x: p.x, y: p.y, r: 8, prio: 3, size: 10 * ts, italic: true, color: unknown ? 'rgba(180,190,215,0.6)' : 'rgba(215,205,180,0.85)' });
  }

  function drawSun(g, p) {
    const R = p.R;
    const halo = g.createRadialGradient(p.x, p.y, R * 0.6, p.x, p.y, R * 6);
    halo.addColorStop(0, 'rgba(255,190,90,0.38)');
    halo.addColorStop(0.25, 'rgba(255,150,50,0.12)');
    halo.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(p.x, p.y, R * 6, 0, TAU);
    g.fill();
    const corona = g.createRadialGradient(p.x, p.y, R * 0.9, p.x, p.y, R * 1.7);
    corona.addColorStop(0, 'rgba(255,236,170,0.75)');
    corona.addColorStop(1, 'rgba(255,200,100,0)');
    g.fillStyle = corona;
    g.beginPath();
    g.arc(p.x, p.y, R * 1.7, 0, TAU);
    g.fill();
    const disc = g.createRadialGradient(p.x - R * 0.2, p.y - R * 0.2, R * 0.1, p.x, p.y, R);
    disc.addColorStop(0, '#fffbe8');
    disc.addColorStop(0.55, '#ffe08a');
    disc.addColorStop(1, '#f9a03f');
    g.fillStyle = disc;
    g.beginPath();
    g.arc(p.x, p.y, R, 0, TAU);
    g.fill();
  }

  function drawPlanet(g, b, p, fogState, sun, cb) {
    const d = b.display || {};
    const R = p.R;
    const unknown = fogState === 'unknown';
    const dim = fogState === 'partial' ? 0.85 : 1;
    // light comes from the Sun
    let lx = sun.x - p.x;
    let ly = sun.y - p.y;
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll;
    ly /= ll;
    if (unknown) {
      // não mapeado: hazy silhouette, dashed outline and a question mark
      const col = haze(d.color || '#999', 0.55);
      const hz = g.createRadialGradient(p.x, p.y, R * 0.2, p.x, p.y, R * 2);
      hz.addColorStop(0, rgba(toHex(col), 0.32));
      hz.addColorStop(1, rgba(toHex(col), 0));
      g.fillStyle = hz;
      g.beginPath();
      g.arc(p.x, p.y, R * 2, 0, TAU);
      g.fill();
      const disc = g.createRadialGradient(p.x + lx * R * 0.4, p.y + ly * R * 0.4, R * 0.1, p.x, p.y, R);
      disc.addColorStop(0, rgba(toHex(col), 0.75));
      disc.addColorStop(1, 'rgba(20,26,44,0.75)');
      g.fillStyle = disc;
      g.beginPath();
      g.arc(p.x, p.y, R, 0, TAU);
      g.fill();
      if (RINGS[b.id] && R >= 6) {
        ringPass(g, b, p, R, 0.35, true);
        ringPass(g, b, p, R, 0.35, false);
      }
      g.strokeStyle = 'rgba(190,200,232,0.55)';
      g.setLineDash([2, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(p.x, p.y, R + 3, 0, TAU);
      g.stroke();
      g.setLineDash([]);
      if (R >= 7) {
        g.font = `700 ${Math.round(Math.min(R * 1.05, 26))}px ${FONT}`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = 'rgba(225,232,250,0.7)';
        g.fillText('?', p.x, p.y + 0.5);
      }
      return;
    }
    const base = d.color || '#aaa';
    const ring = RINGS[b.id] && R >= 6;
    if (ring) ringPass(g, b, p, R, dim, true);
    g.save();
    g.beginPath();
    g.arc(p.x, p.y, R, 0, TAU);
    g.clip();
    const grad = g.createRadialGradient(p.x + lx * R * 0.45, p.y + ly * R * 0.45, R * 0.05, p.x, p.y, R * 1.05);
    grad.addColorStop(0, shade(base, 1.3 * dim));
    grad.addColorStop(0.55, shade(base, 1.0 * dim));
    grad.addColorStop(1, shade(base, 0.55 * dim));
    g.fillStyle = grad;
    g.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    surfaceDetail(g, b, p, R, d, dim);
    // night side away from the Sun
    const nx = p.x - lx * R * 0.95;
    const ny = p.y - ly * R * 0.95;
    const night = g.createRadialGradient(nx, ny, 0, nx, ny, R * 1.65);
    night.addColorStop(0, 'rgba(2,4,12,0.88)');
    night.addColorStop(0.55, 'rgba(2,4,12,0.45)');
    night.addColorStop(1, 'rgba(2,4,12,0)');
    g.fillStyle = night;
    g.fillRect(p.x - R, p.y - R, R * 2, R * 2);
    g.restore();
    const atm = ATMOS[b.id] || d.atmosphere;
    if (atm && R >= 4) {
      const glow = g.createRadialGradient(p.x, p.y, R * 0.92, p.x, p.y, R * 1.3);
      glow.addColorStop(0, rgba(atm, 0));
      glow.addColorStop(0.3, rgba(atm, 0.5 * dim));
      glow.addColorStop(1, rgba(atm, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(p.x, p.y, R * 1.3, 0, TAU);
      g.arc(p.x, p.y, R * 0.92, 0, TAU, true);
      g.fill('evenodd');
      // bright limb on the day side
      const la = Math.atan2(ly, lx);
      g.strokeStyle = rgba(atm, 0.7 * dim);
      g.lineWidth = Math.max(1, R * 0.06);
      g.beginPath();
      g.arc(p.x, p.y, R + g.lineWidth * 0.3, la - 1.2, la + 1.2);
      g.stroke();
    }
    if (ring) ringPass(g, b, p, R, dim, false);
  }

  function surfaceDetail(g, b, p, R, d, dim) {
    if (R < 5) return;
    const rng = makeRng(b.id.length * 977 + b.id.charCodeAt(0));
    if (b.id === 'earth' && d.land) {
      g.fillStyle = shade(d.land, dim);
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.ellipse(p.x + (rng.next() - 0.5) * R * 1.4, p.y + (rng.next() - 0.5) * R * 1.4, R * (0.18 + rng.next() * 0.3), R * (0.12 + rng.next() * 0.22), rng.next() * 3, 0, TAU);
        g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.28)';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.ellipse(p.x + (rng.next() - 0.5) * R * 1.5, p.y + (rng.next() - 0.5) * R * 1.5, R * 0.35, R * 0.07, rng.next(), 0, TAU);
        g.fill();
      }
    } else if (d.bands) {
      g.fillStyle = shade(d.bands, dim);
      g.globalAlpha *= 0.85;
      for (let i = -3; i <= 3; i++) g.fillRect(p.x - R, p.y + i * R * 0.27 - R * 0.06, R * 2, R * (0.07 + rng.next() * 0.06));
      g.globalAlpha /= 0.85;
      if (b.id === 'jupiter' && R >= 10) {
        g.fillStyle = shade('#c8553d', dim);
        g.beginPath();
        g.ellipse(p.x + R * 0.3, p.y + R * 0.32, R * 0.16, R * 0.09, 0, 0, TAU);
        g.fill();
      }
    } else if (b.id === 'mars') {
      g.fillStyle = shade('#9c4a35', dim);
      g.beginPath();
      g.ellipse(p.x + R * 0.2, p.y + R * 0.1, R * 0.5, R * 0.25, 0.4, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.ellipse(p.x, p.y - R * 0.92, R * 0.38, R * 0.16, 0, 0, TAU);
      g.fill();
    } else if (b.id === 'venus' || b.id === 'titan') {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      for (let i = 0; i < 4; i++) {
        g.beginPath();
        g.ellipse(p.x + (rng.next() - 0.5) * R, p.y + (rng.next() - 0.5) * R * 1.2, R * 0.7, R * 0.12, -0.2 + rng.next() * 0.4, 0, TAU);
        g.fill();
      }
    } else if (d.dark) {
      g.fillStyle = shade(d.dark, dim);
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.arc(p.x + (rng.next() - 0.5) * R * 1.4, p.y + (rng.next() - 0.5) * R * 1.4, R * (0.08 + rng.next() * 0.16), 0, TAU);
        g.fill();
      }
    }
  }

  /** Ring system: back half before the disc, front half after it. */
  function ringPass(g, b, p, R, dim, back) {
    const spec = RINGS[b.id];
    if (!spec) return;
    const color = spec.color || b.display?.ring || '#d4bf8a';
    g.save();
    for (const [r0, r1, a] of spec.bands) {
      const mid = ((r0 + r1) / 2) * R;
      g.strokeStyle = rgba(color, a * dim);
      g.lineWidth = Math.max(0.8, (r1 - r0) * R);
      g.beginPath();
      g.ellipse(p.x, p.y, mid, mid * spec.flat, spec.rot, back ? Math.PI : 0, back ? TAU : Math.PI);
      g.stroke();
    }
    g.restore();
  }

  function drawDestMarker(g, pos, st, selected, cb) {
    const r = selected ? 5.5 : 4;
    g.beginPath();
    if (st === 'player') {
      g.moveTo(pos.x, pos.y - r);
      g.lineTo(pos.x + r, pos.y);
      g.lineTo(pos.x, pos.y + r);
      g.lineTo(pos.x - r, pos.y);
      g.closePath();
      g.fillStyle = DEST_COLORS.player;
    } else if (st === 'rival') {
      // rival: square (shape, not only color)
      g.rect(pos.x - r * 0.8, pos.y - r * 0.8, r * 1.6, r * 1.6);
      g.fillStyle = DEST_COLORS.rival;
    } else {
      g.arc(pos.x, pos.y, r * 0.85, 0, TAU);
      g.fillStyle = 'rgba(22,30,52,0.95)';
    }
    g.fill();
    g.lineWidth = selected ? 2 : 1;
    g.strokeStyle = st ? '#ffffff' : 'rgba(190,200,230,0.7)';
    if (!st) g.setLineDash([1.5, 1.5]);
    g.stroke();
    g.setLineDash([]);
    if (cb && st === 'player') {
      g.strokeStyle = '#06101e';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(pos.x - 1.8, pos.y);
      g.lineTo(pos.x - 0.4, pos.y + 1.5);
      g.lineTo(pos.x + 2, pos.y - 1.6);
      g.stroke();
    }
  }

  function drawFlag(g, x, y, color, mine, letter) {
    g.strokeStyle = 'rgba(230,236,250,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y + 8);
    g.lineTo(x, y - 4);
    g.stroke();
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y - 4);
    g.lineTo(x + (letter ? 9 : 7), y - 1);
    g.lineTo(x, y + 2);
    g.closePath();
    g.fill();
    if (mine) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.2;
      g.stroke();
    }
    if (letter) {
      g.font = `700 6px ${FONT}`;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillStyle = '#06101e';
      g.fillText(letter, x + 1.2, y - 1);
    }
  }

  function drawLabel(g, text, x, y, color, align = 'center') {
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(4,7,16,0.82)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function edgeArrow(g, target, text, ts) {
    const cx = W / 2;
    const cy = H / 2;
    const ang = Math.atan2(target.y - cy, target.x - cx);
    const m = 22;
    const kx = (W / 2 - m) / Math.abs(Math.cos(ang) || 1e-6);
    const ky = (H / 2 - m) / Math.abs(Math.sin(ang) || 1e-6);
    const k = Math.min(kx, ky);
    const x = cx + Math.cos(ang) * k;
    const y = cy + Math.sin(ang) * k;
    const glow = g.createRadialGradient(x, y, 0, x, y, 16);
    glow.addColorStop(0, 'rgba(255,200,100,0.45)');
    glow.addColorStop(1, 'rgba(255,200,100,0)');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(x, y, 16, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255,214,120,0.95)';
    g.beginPath();
    g.moveTo(x + Math.cos(ang) * 8, y + Math.sin(ang) * 8);
    g.lineTo(x + Math.cos(ang + 2.5) * 6, y + Math.sin(ang + 2.5) * 6);
    g.lineTo(x + Math.cos(ang - 2.5) * 6, y + Math.sin(ang - 2.5) * 6);
    g.closePath();
    g.fill();
    g.font = `600 ${(10 * ts).toFixed(1)}px ${FONT}`;
    drawLabel(g, text, x - Math.cos(ang) * 22, y - Math.sin(ang) * 14, '#ffd98a');
  }

  // ---------- dynamic layer: missions in transit ----------
  function displayedProgress(t, now) {
    const a = progAnim[t.key];
    if (!a) return t.progress;
    const k = clamp((now - a.t0) / a.dur, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    return a.from + (t.progress - a.from) * e;
  }

  function transitScreenPath(t, cam, scr, toS) {
    const an = anchors[t.destId];
    const bodyId = an?.bodyId || t.bodyId;
    const body = bodyIdx[bodyId];
    const sysId = systemOf(data, bodyId)?.id;
    const earth = scr.earth;
    if (!earth || !body) return null;
    if (sysId === 'earth') {
      if (cam.s < 1.0) return null;
      const target = scr[bodyId];
      if (!target || target.vis < 0.5) return null;
      const end = an ? anchorScreen(an.anchor, target, scr) || target : target;
      if (bodyId === 'earth') return { pts: [end], local: true };
      const dx = end.x - earth.x;
      const dy = end.y - earth.y;
      const dd = Math.hypot(dx, dy) || 1;
      const cxp = (earth.x + end.x) / 2 - dy * 0.28;
      const cyp = (earth.y + end.y) / 2 + dx * 0.28;
      const sx = earth.x + (dx / dd) * earth.R;
      const sy = earth.y + (dy / dd) * earth.R;
      const pts = [];
      for (let i = 0; i <= 28; i++) {
        const u = i / 28;
        pts.push({ x: (1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cxp + u * u * end.x, y: (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cyp + u * u * end.y });
      }
      return { pts, local: true };
    }
    if (cam.s >= 1.2) return null; // Terra-Lua scale: interplanetary arcs would only cross the view
    if (t.phase !== 'transit') {
      const p = scr[bodyId]?.vis > 0.5 ? scr[bodyId] : scr[sysId];
      return p ? { pts: [{ x: p.x, y: p.y, R: p.R }], local: false } : null;
    }
    const k = `${t.key}|${t.depart}|${t.arrive}`;
    let world = pathCache.get(k);
    if (world === undefined) {
      world = transferPath(data, t);
      pathCache.set(k, world);
    }
    if (!world) return null;
    return { pts: world.map(toS), local: false };
  }

  function pointAlong(path, u) {
    if (path.length === 1) return path[0];
    const f = clamp(u, 0, 1) * (path.length - 1);
    const i = Math.min(path.length - 2, Math.floor(f));
    const k = f - i;
    return { x: path[i].x + (path[i + 1].x - path[i].x) * k, y: path[i].y + (path[i + 1].y - path[i].y) * k };
  }
  function polyline(g, path, u0, u1, n = 24) {
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const p = pointAlong(path, u0 + ((u1 - u0) * i) / n);
      if (i) g.lineTo(p.x, p.y);
      else g.moveTo(p.x, p.y);
    }
  }

  function drawDynamic(g, cam, now, ts, cb) {
    tHits = [];
    const toS = (p) => ({ x: (p.x - cam.cx) * cam.s + W / 2, y: (p.y - cam.cy) * cam.s + H / 2 });
    const scr = lastScr;
    const still = reduceMotion();
    const selKey = MEM.selected?.transitKey;
    for (const t of model.transits) {
      const res = transitScreenPath(t, cam, scr, toS);
      if (!res) continue;
      const path = res.pts;
      const a = actorInfo(state, data, t.actorId);
      const col = a.color;
      const isSel = selKey === t.key;
      let pt;
      if (t.phase === 'transit' && path.length > 1) {
        const u = displayedProgress(t, now);
        // remaining route: faint dashes to the meeting point
        g.strokeStyle = rgba(col, isSel ? 0.5 : 0.22);
        g.lineWidth = 1;
        g.setLineDash([2, 5]);
        polyline(g, path, u, 1, 20);
        g.stroke();
        g.setLineDash([]);
        // meeting point (where the target will be on arrival)
        const end = path[path.length - 1];
        g.strokeStyle = rgba(col, 0.45);
        g.beginPath();
        g.arc(end.x, end.y, 3.5, 0, TAU);
        g.stroke();
        // fading trail behind the craft
        const tail = Math.min(u, 0.35);
        const n = 12;
        g.lineCap = 'round';
        for (let i = 0; i < n; i++) {
          const ua = u - tail + (tail * i) / n;
          const ub = u - tail + (tail * (i + 1)) / n;
          g.strokeStyle = rgba(col, ((i + 1) / n) * (isSel ? 0.95 : 0.7));
          g.lineWidth = (t.isPlayer ? 2 : 1.5) * (0.5 + (0.5 * (i + 1)) / n);
          polyline(g, path, ua, ub, 3);
          g.stroke();
        }
        g.lineCap = 'butt';
        // traveled part before the tail, very faint (rivals dashed: shape, not only color)
        if (u - tail > 0.01) {
          g.strokeStyle = rgba(col, 0.16);
          g.lineWidth = 1;
          g.setLineDash(t.isPlayer ? [] : [3, 3]);
          polyline(g, path, 0, u - tail, 16);
          g.stroke();
          g.setLineDash([]);
        }
        pt = pointAlong(path, u);
        // spark running along the trail
        if (!still) {
          const ph = ((now / 2400 + hashAngle(t.key)) % 1 + 1) % 1;
          const sp = pointAlong(path, (u - tail) + tail * ph);
          g.fillStyle = `rgba(255,255,255,${0.75 * Math.sin(ph * Math.PI)})`;
          g.beginPath();
          g.arc(sp.x, sp.y, 1.3, 0, TAU);
          g.fill();
        }
      } else {
        // operating: slow circle around the destination
        const end = path[path.length - 1];
        const rr = (end.R || 0) + 6;
        const ang = (still ? 0.8 : now / 2600) + hashAngle(t.key);
        pt = { x: end.x + Math.cos(ang) * rr, y: end.y + Math.sin(ang) * rr };
      }
      if (pt.x < -20 || pt.y < -20 || pt.x > W + 20 || pt.y > H + 20) continue;
      const pulse = still ? 0.5 : (Math.sin(now / 420 + hashAngle(t.key)) + 1) / 2;
      const pr = t.isPlayer ? 4.2 : 3.6;
      const glow = g.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, pr + 7 + 4 * pulse);
      glow.addColorStop(0, rgba(col, 0.55));
      glow.addColorStop(1, rgba(col, 0));
      g.fillStyle = glow;
      g.beginPath();
      g.arc(pt.x, pt.y, pr + 7 + 4 * pulse, 0, TAU);
      g.fill();
      g.beginPath();
      if (t.isPlayer) g.arc(pt.x, pt.y, pr, 0, TAU);
      else {
        g.moveTo(pt.x, pt.y - pr - 1);
        g.lineTo(pt.x + pr + 1, pt.y);
        g.lineTo(pt.x, pt.y + pr + 1);
        g.lineTo(pt.x - pr - 1, pt.y);
        g.closePath();
      }
      g.fillStyle = col;
      g.fill();
      g.lineWidth = t.isPlayer || isSel ? 1.6 : 1;
      g.strokeStyle = '#ffffff';
      g.stroke();
      if (isSel) {
        g.font = `600 ${(10.5 * ts).toFixed(1)}px ${FONT}`;
        // placed against the body labels already drawn by the scene pass (no 'Sonda Vênus-1' over 'Vênus ?')
        const lw = g.measureText(t.name).width + 4, lh = 10.5 * ts * 1.25;
        const at = placeLabels([{ id: t.key, text: t.name, x: pt.x, y: pt.y, r: pr + 6, w: lw, h: lh, prio: 0, only: null }],
          { width: W, height: H, taken: sceneLabelBoxes })[0];
        if (at) drawLabel(g, t.name, at.lx, at.ly, '#ffffff', at.align);
        else drawLabel(g, t.name, clamp(pt.x, 40, W - 40), pt.y - 14, '#ffffff');
      }
      tHits.push({ x: pt.x, y: pt.y, r: 18, kind: 'transit', id: t.key, bodyId: t.bodyId });
    }
  }

  // ---------- HUD ----------
  function updateLevelBar(id = activeLevelFor(levels, targetSpan(), (tween?.to || MEM.cam)?.follow, parentOf)?.id ?? null) {
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
    const parts = [];
    const nTransit = model.transits.filter((t) => t.phase === 'transit').length;
    if (nTransit) parts.push(`<div class="map-transit-count"><i aria-hidden="true"></i>${nTransit} ${nTransit === 1 ? 'missão em trânsito' : 'missões em trânsito'}</div>`);
    const w0 = model.warnings[0];
    if (w0) {
      const more = model.warnings.length > 1 ? ` <small>(+${model.warnings.length - 1})</small>` : '';
      parts.push(`<div class="map-warn map-warn--${esc(w0.level)}" role="status"><b aria-hidden="true">!</b> ${esc(w0.text)}${more}</div>`);
    }
    // nearest window gets the full sentence; the others become compact chips in one scrollable row
    const chips = model.windows.slice(0, 5).map((w, i) => {
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
    const me = actorInfo(state, data, state.playerId);
    return `<div class="map-legend__card">
      <div><span class="lg-dot" style="background:${esc(me.color)}"></span> Sua missão (círculo, rastro contínuo)</div>
      <div><span class="lg-dia"></span> Missão rival (losango, cor da agência)</div>
      <div><span class="lg-flag"></span> Bandeira: quem já chegou lá</div>
      <div><span class="lg-fog"></span> Não mapeado: só uma missão sua revela</div>
      <div><span class="lg-mk lg-mk--p"></span> Destino visitado por você · <span class="lg-mk lg-mk--r"></span> por rivais</div>
      <div><span class="lg-win"></span> Arco azul: janela aberta · amarelo: em breve</div>
      <div><span class="lg-belt"></span> Pontilhado: cinturões</div>
      <p>Pinça, roda ou toque duplo aproxima. Os destinos aparecem ao chegar perto.</p>
    </div>`;
  }

  // ---------- sheets (ficha do corpo, cartão de missão, destino) ----------
  function openSheet(sel) {
    MEM.selected = sel;
    renderSheet();
    if (MEM.mode === 'map') keepAboveSheet(sel);
    invalidate();
  }

  /** Pan so the selected body sits in the middle of the map area the card leaves free. */
  function keepAboveSheet(sel) {
    const p = sel && (lastScr[sel.bodyId]?.vis > 0.5 ? lastScr[sel.bodyId] : lastScr[systemOf(data, sel.bodyId)?.id]);
    if (!p || !H || sel.transitKey) return;
    requestAnimationFrame(() => {
      if (destroyed || MEM.selected !== sel || tween) return;
      const sh = sheet.getBoundingClientRect?.().height || 0;
      const top = stage.getBoundingClientRect?.().top || 0;
      const sheetTop = (sheet.getBoundingClientRect?.().top || H) - top;
      const freeH = Math.max(80, Math.min(H, sheetTop || H - sh));
      if (p.y + p.R <= freeH - 12 && p.y - p.R >= 8 && p.x > 0 && p.x < W) return; // already in view
      const cam = camNow();
      const dy = (p.y - freeH / 2) / cam.s;
      const dx = (p.x - W / 2) / cam.s;
      moveTo({ ...MEM.cam, ox: MEM.cam.ox + dx, oy: MEM.cam.oy + dy, span: cam.span }, 360);
    });
  }
  function closeSheet() {
    MEM.selected = null;
    renderSheet();
    invalidate();
  }

  function renderSheet() {
    const sel = MEM.selected;
    let html = '';
    if (sel?.transitKey) html = transitSheet(sel);
    else if (sel?.mode === 'dest' && destById(data, sel.destId)) html = destSheet(sel.destId);
    else if (sel && bodyIdx[sel.bodyId]) html = bodySheet(sel);
    if (!html) {
      sheet.classList.remove('is-open');
      sheet.innerHTML = '';
      return;
    }
    sheet.innerHTML = `<div class="map-sheet__grab" aria-hidden="true"></div>${html}`;
    sheet.classList.add('is-open');
  }

  const head = (dotStyle, title, sub, chipHtml) => `
    <header class="map-sheet__head">
      <span class="map-sheet__dot" style="${dotStyle}"></span>
      <div><h3>${esc(title)}</h3><p class="map-sheet__tipo">${sub}</p></div>
      ${chipHtml || ''}
      <button type="button" class="map-sheet__close" data-close="1" aria-label="Fechar">×</button>
    </header>`;
  const planetDot = (b, fogState) => {
    const c = b?.display?.color || '#888';
    return fogState === 'unknown'
      ? `background:radial-gradient(circle at 35% 35%, ${haze(c, 0.5)}, #141a2c 75%);border:1px dashed rgba(190,200,232,0.6)`
      : `background:radial-gradient(circle at 32% 32%, ${shade(c, 1.35)}, ${c} 45%, ${shade(c, 0.35)} 100%)`;
  };

  function bodySheet(sel) {
    const b = bodyIdx[sel.bodyId];
    const fogState = model.fog.bodies[b.id] || 'unknown';
    const f = b.ficha || {};
    const hidden = fogState === 'unknown';
    const pid = state.playerId;
    const fact = (k, v) => `<div><dt>${k}</dt><dd>${hidden ? '?' : esc(v || '—')}</dd></div>`;
    const list = (items) => (hidden ? '<p class="map-fogged">?</p>' : `<ul>${arr(items).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
    const destRows = arr(b.destinations).map((a) => destRow(a.id, sel)).join('');
    const pres = arr(model.presence[b.id]).map((e) => {
      const a = actorInfo(state, data, e.actorId);
      return `<li><span class="map-pres__flag" style="--c:${esc(a.color)}"></span><b>${esc(a.flag)} ${esc(a.short)}${e.actorId === pid ? ' (você)' : ''}</b> <small>${esc(e.items.slice(0, 3).map(prettyItem).join(', '))}</small></li>`;
    }).join('');
    const active = model.transits.filter((t) => t.bodyId === b.id || bodyIdx[t.bodyId]?.parent === b.id);
    const act = active.map((t) => transitRow(t, sel)).join('');
    const moons = bodies.filter((m) => m.parent === b.id && m.kind !== 'belt');
    const moonBtns = moons.map((m) => `<button type="button" class="map-pill" data-body="${esc(m.id)}">${esc(m.name)}${model.fog.bodies[m.id] === 'unknown' ? ' ?' : ''}</button>`).join('');
    const parent = b.parent && b.parent !== 'sun' ? bodyIdx[b.parent] : null;
    const actions = `<div class="map-actions">
        ${b.kind !== 'star' ? `<button type="button" class="map-btn" data-focus="${esc(b.id)}">Aproximar</button>` : ''}
        ${parent ? `<button type="button" class="map-pill" data-body="${esc(parent.id)}">↑ ${esc(parent.name)}</button>` : ''}
        ${moonBtns}
      </div>`;
    return `${head(planetDot(b, fogState), b.name, esc(f.tipo || ''), `<span class="map-chip map-chip--fog-${fogState}">${FOG_LABEL[fogState] || ''}</span>`)}
      <div class="map-sheet__body">
        ${actions}
        ${hidden ? '<p class="map-fogged map-fogged--box">Não mapeado pela sua agência. Uma missão sua bem-sucedida aqui revela a ficha.</p>' : ''}
        <dl class="map-facts">${fact('Gravidade', f.gravidade)}${fact('Atmosfera', f.atmosfera)}${f.temperatura || hidden ? fact('Temperatura', f.temperatura) : ''}${b.physical?.dayHours ? fact('Dia', `${String(b.physical.dayHours).replace('.', ',')} h`) : ''}</dl>
        <section><h4>Recursos</h4>${list(f.recursos)}</section>
        <section><h4>Perigos</h4>${list(f.perigos)}</section>
        ${f.historia && !hidden ? `<p class="map-hist">${esc(f.historia)}</p>` : ''}
        ${act ? `<section><h4>Em andamento</h4><ul class="map-pres">${act}</ul></section>` : ''}
        ${destRows ? `<section><h4>Destinos</h4><ul class="map-dests">${destRows}</ul></section>` : ''}
        <section><h4>Presença</h4>${pres ? `<ul class="map-pres">${pres}</ul>` : '<p class="map-fogged">Ninguém chegou lá nesta campanha.</p>'}</section>
      </div>`;
  }

  function stateChip(destId) {
    const st = model.fog.dests[destId];
    if (st === 'player') return '<span class="map-chip is-player">Visitado por você</span>';
    if (st === 'rival') return '<span class="map-chip is-rival">Visitado por rivais</span>';
    return homeChip(destId) || '<span class="map-chip">Não mapeado</span>';
  }

  function windowChip(destId) {
    const v = q('catalog/window', destId);
    const w = windowFor(state, data, destId, q);
    if (v?.alwaysOpen || (!w && !v)) return '<span class="map-wchip is-always">Sempre aberta</span>';
    if (w?.open) return `<span class="map-wchip is-open">Janela aberta · ${esc(weeksToText(w.weeksLeft))}</span>`;
    if (w) return `<span class="map-wchip">Janela em ${esc(weeksToText(w.weeksToOpen))}</span>`;
    return v?.text ? `<span class="map-wchip">${esc(v.text)}</span>` : '';
  }

  function destRow(destId, sel) {
    const dest = destById(data, destId);
    const dv = arr(dest?.route).reduce((t, s) => t + (Number(s?.dv) || 0), 0);
    // only this destination's own milestones (the pole also lists the general Moon landing, for scoring)
    const firsts = ownFirsts(data, destId).map((mid) => state.firsts?.[mid] && { mid, ...state.firsts[mid] }).filter(Boolean);
    return `<li class="map-dest ${sel?.destId === destId ? 'is-sel' : ''}">
      <div class="map-dest__head"><b>${esc(destName(data, destId))}</b>${stateChip(destId)}</div>
      ${dv ? `<div class="map-dest__row"><span>Energia</span>${blocksHtml(Math.min(10, dv / 2))}<em>${energyWord(dv)}</em></div>` : ''}
      ${dest ? `<div class="map-dest__row"><span>Viagem</span><em>${dest.transitWeeks ? weeksToText(dest.transitWeeks) : 'imediata'}</em>${windowChip(destId)}</div>` : ''}
      ${firsts.map((x) => `<div class="map-dest__row"><span>Primeiro</span><em>${esc(actorInfo(state, data, x.actorId).flag)} ${esc(actorInfo(state, data, x.actorId).short)}</em></div>`).join('')}
      ${dest ? `<div class="map-dest__act"><button type="button" class="map-btn map-btn--primary" data-plan="${esc(destId)}">Planejar missão</button></div>` : ''}
    </li>`;
  }

  function transitRow(t, sel) {
    const a = actorInfo(state, data, t.actorId);
    const status = t.phase === 'transit' ? `chega em ${weeksToText(Math.max(1, t.weeksLeft))}` : 'em operação';
    return `<li class="map-tr ${sel?.transitKey === t.key ? 'is-sel' : ''}" data-transit="${esc(t.key)}" role="button" tabindex="0"><span class="map-pres__flag" style="--c:${esc(a.color)}"></span><b>${esc(t.name)}</b> <small>${esc(a.short)} · ${esc(destName(data, t.destId))} · ${status}</small></li>`;
  }

  function transitSheet(sel) {
    const t = model.transits.find((x) => x.key === sel.transitKey);
    if (!t) return '';
    const a = actorInfo(state, data, t.actorId);
    const sy = state.startYear ?? data?.scenario?.startYear ?? 2026;
    const pct = Math.round(t.progress * 100);
    const eta = t.phase === 'transit'
      ? `<div class="map-eta"><span>Chegada prevista</span><b>${esc(formatTurn(t.arrive, sy))}</b><small>em ${esc(weeksToText(Math.max(1, t.weeksLeft)))}</small></div>`
      : `<div class="map-eta"><span>Situação</span><b>Em operação</b><small>desde ${esc(formatTurn(t.arrive, sy))}</small></div>`;
    const body = bodyIdx[t.bodyId];
    return `${head(`background:${esc(a.color)};box-shadow:0 0 14px ${esc(a.color)}`, t.name, `${esc(a.flag)} ${esc(a.short)}${t.isPlayer ? ' (você)' : ''} · ${esc(destName(data, t.destId))}`, t.isPlayer ? '<span class="map-chip is-player">Sua missão</span>' : '<span class="map-chip is-rival">Rival</span>')}
      <div class="map-sheet__body">
        ${eta}
        ${t.phase === 'transit' ? `<div class="map-prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Viagem ${pct}%"><i style="width:${pct}%;background:${esc(a.color)}"></i></div>
        <div class="map-prog__lbl"><span>Partiu em ${esc(formatTurn(t.depart, sy))}</span><span>${pct}%</span></div>` : ''}
        <div class="map-actions">
          ${body ? `<button type="button" class="map-btn" data-body="${esc(body.id)}">Ver ${esc(body.name)}</button>` : ''}
          ${t.isPlayer && t.missionId ? `<button type="button" class="map-btn map-btn--primary" data-mission="${esc(t.missionId)}">Abrir missão</button>` : ''}
        </div>
      </div>`;
  }

  function destSheet(destId) {
    const dest = destById(data, destId);
    const region = METRO_REGIONS.find((r) => r.id === destRegion(data, destId));
    const bodyId = destBodyId(data, destId);
    const b = bodyIdx[bodyId];
    const segs = arr(dest.route).map((s) => ({ from: s.from, to: s.to, dv: Number(s.dv) || 0 }));
    const total = segs.reduce((t, s) => t + s.dv, 0);
    const legRows = segs.map((s) => `<li><span>${esc(data?.bodies?.stations?.[s.from] || destName(data, s.from))} → ${esc(data?.bodies?.stations?.[s.to] || destName(data, s.to))}</span>${blocksHtml(Math.min(10, s.dv))}<em>${s.dv.toFixed(1).replace('.', ',')}</em></li>`).join('');
    const firsts = ownFirsts(data, destId).map((mid) => {
      const f = state.firsts?.[mid];
      const label = data?.bodies?.milestoneLabels?.[mid] || 'Marco';
      const h = state.firstsHistory?.[mid];
      if (!f) return `<li>${esc(label)}: <small>em aberto${h?.mission ? ` nesta era · recorde: ${esc(h.mission)}${h.year ? ` (${esc(h.year)})` : ''}` : ''}</small></li>`;
      const a = actorInfo(state, data, f.actorId);
      return `<li>${esc(label)}: <b>${esc(a.flag)} ${esc(a.short)}</b></li>`;
    }).join('');
    return `${head(`background:${esc(region?.color || TRUNK_COLOR)}`, dest.name, `${esc(region?.name || '')}${b ? ` · ${esc(b.name)}` : ''}`, stateChip(destId))}
      <div class="map-sheet__body">
        ${dest.description ? `<p class="map-hist">${esc(dest.description)}</p>` : ''}
        <div class="map-dest__row"><span>Viagem</span><em>${dest.transitWeeks ? weeksToText(dest.transitWeeks) : 'imediata'}</em>${windowChip(destId)}</div>
        <section><h4>Energia · ${energyWord(total)} · ${total.toFixed(1).replace('.', ',')} km/s</h4><ul class="map-legrows">${legRows}</ul></section>
        ${firsts ? `<section><h4>Os Primeiros</h4><ul>${firsts}</ul></section>` : ''}
        <div class="map-actions">
          <button type="button" class="map-btn map-btn--primary" data-plan="${esc(destId)}">Planejar missão aqui</button>
          ${b ? `<button type="button" class="map-btn" data-show="${esc(bodyId)}">Ver no mapa</button>` : ''}
        </div>
      </div>`;
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

  /** Mission builder with this destination: app hook when present, else open Missões › Montar. */
  function planMission(destId) {
    store?.vibrate?.(8);
    const ui = store?.ui;
    if (typeof ui?.planMission === 'function') { ui.planMission(destId); return; }
    if (ui && typeof ui === 'object') ui.pendingDestination = destId; // read by the builder when it supports it
    if (typeof ui?.navigate === 'function') ui.navigate('missoes', 'nova');
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
    const fresh = bodies.filter((b) => b.fog !== 'known' && model.fog.bodies[b.id] === 'known' && !seen.includes(b.id));
    if (!fresh.length || discovery.classList.contains('is-open')) return;
    const b = fresh[0];
    discovery.innerHTML = `<div class="map-discovery__card" role="dialog" aria-label="Descoberta">
      <div class="map-discovery__art" style="--c:${esc(b.display?.color || '#888')}"></div>
      <small>Mapeado</small><h3>${esc(b.name)}</h3>
      <p>${esc(b.ficha?.descoberta || b.ficha?.historia || '')}</p>
      <button type="button" data-discovery="${esc(b.id)}">Continuar</button></div>`;
    discovery.classList.add('is-open');
  }

  // ---------- metro view ----------
  function renderMetro() {
    const regions = metroRegions(data);
    if (!regions.length) {
      metro.innerHTML = `<p class="map-empty">Rotas indisponíveis: o catálogo de destinos ainda não foi carregado.</p>`;
      return;
    }
    const reg = regions.find((r) => r.id === MEM.metroRegion) || regions.find((r) => r.id === 'lua') || regions[0];
    MEM.metroRegion = reg.id;
    const fogD = model.fog.dests;
    const stations = data?.bodies?.stations || {};
    const sub = { ...data, destinations: { destinations: reg.dests.map((id) => destById(data, id)) } };
    const avail = Math.max(250, (metro.clientWidth || container.clientWidth || 360) - 24);
    const pre = buildMetro(sub);
    const colW = clamp((avail - 2 * 26 - 80) / Math.max(1, pre.maxDepth), 48, 124);
    const m = buildMetro(sub, { colW, rowH: 58, padX: 26, padY: 26 });
    const selDest = MEM.selected?.mode === 'dest' ? MEM.selected.destId : null;
    const selLine = m.lines.find((l) => l.destId === selDest);
    const onPath = new Set(selLine ? selLine.path : []);
    let svg = `<svg class="map-metro__svg" viewBox="0 0 ${Math.round(m.width)} ${m.height}" width="${Math.round(m.width)}" height="${m.height}" role="img" aria-label="${esc(reg.name)}">`;
    for (const e of m.edges) {
      const hi = !selLine || (onPath.has(e.from) && onPath.has(e.to));
      const color = e.from === 'earth' && e.to === 'leo' ? TRUNK_COLOR : reg.color;
      const bend = e.y2 === e.y1 ? '' : `Q ${e.x1} ${e.y2} ${e.x1 + 16} ${e.y2} `;
      const d = `M ${e.x1} ${e.y1} ${e.y2 === e.y1 ? '' : `L ${e.x1} ${e.y2 - 16} `}${bend}L ${e.x2} ${e.y2}`;
      svg += `<path d="${d}" stroke="#070a14" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
      svg += `<path d="${d}" stroke="${color}" stroke-width="${selLine && hi ? 6 : 5}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${hi ? 1 : 0.25}"/>`;
      // delta-v of the leg as a readable number above its straight stretch (tiny 1 km/s blocks could not be counted)
      if (e.dv > 0) {
        const x0 = e.y2 === e.y1 ? e.x1 + 8 : e.x1 + 18;
        const mx = (x0 + e.x2 - 8) / 2;
        svg += `<text x="${mx.toFixed(1)}" y="${e.y2 - 9}" text-anchor="middle" class="map-leg__dv" opacity="${hi ? 1 : 0.35}">${esc(String(Math.round(e.dv * 10) / 10).replace('.', ','))}</text>`;
      }
    }
    for (const id of m.order) {
      const n = m.nodes[id];
      // a line that ends on a route node (Sobrevoo lunar ends at the translunar injection) owns that station
      const endLine = m.lines.find((l) => l.terminal === id && l.destId !== id);
      const dest = destById(data, id) || (endLine ? destById(data, endLine.destId) : null);
      const destId = dest ? dest.id : null;
      const home = destId && bodyById(data, destBodyId(data, destId))?.fog === 'known';
      const st = destId ? fogD[destId] || (home ? 'home' : null) : 'player';
      const hi = !selLine || onPath.has(id);
      const name = destId ? dest.short || destName(data, destId) : stations[id] || destName(data, id);
      const inter = n.children.length > 0 && !destId;
      const r = destId ? 7 : inter ? 5.5 : 5;
      const fill = destId ? (st === 'player' ? DEST_COLORS.player : st === 'rival' ? DEST_COLORS.rival : st === 'home' ? '#3a4a72' : '#141b30') : '#ffffff';
      const dash = destId && !st ? 'stroke-dasharray="2 2"' : '';
      const ring = destId && !st ? 'rgba(200,210,235,0.7)' : '#ffffff';
      svg += `<g class="map-st" ${destId ? `data-dest="${esc(destId)}" tabindex="0" role="button" aria-label="${esc(destName(data, destId))}"` : ''} opacity="${hi ? 1 : 0.35}">
        <circle cx="${n.x}" cy="${n.y}" r="${destId ? 20 : 0}" fill="transparent"/>
        <circle cx="${n.x}" cy="${n.y}" r="${r}" fill="${fill}" stroke="#070a14" stroke-width="2.5"/>
        <circle cx="${n.x}" cy="${n.y}" r="${r + 1.5}" fill="none" stroke="${ring}" stroke-width="1.3" ${dash}/>
        ${destId && !st ? `<text x="${n.x}" y="${n.y + 3}" text-anchor="middle" class="map-st__q">?</text>` : ''}
        ${wrapLabel(name, n.x, n.y + r + 12)}</g>`;
    }
    svg += '</svg>';
    const maxDv = Math.max(...getDestinations(data).map((d) => arr(d.route).reduce((t, s) => t + (Number(s?.dv) || 0), 0)), 1);
    const cards = m.lines.map((l) => `<li class="map-line ${selDest === l.destId ? 'is-sel' : ''}" data-dest="${esc(l.destId)}" tabindex="0" role="button">
        <span class="map-line__sw" style="background:${reg.color}"></span>
        <div class="map-line__main">
          <div class="map-line__head"><b>${esc(l.name)}</b>${stateChip(l.destId)}</div>
          <div class="map-dest__row"><span>Energia</span>${legsBarHtml(l.segments, reg.color, maxDv)}<em>${energyWord(l.totalDv)}</em></div>
          <div class="map-dest__row"><span>Viagem</span><em>${l.transitWeeks ? weeksToText(l.transitWeeks) : 'imediata'}</em>${windowChip(l.destId)}</div>
        </div></li>`).join('');
    const chips = regions.map((r) => `<button type="button" class="map-region ${r.id === reg.id ? 'is-on' : ''}" data-region="${esc(r.id)}" aria-pressed="${r.id === reg.id}"><i style="background:${r.color}"></i>${esc(r.short)} <small>${r.dests.length}</small></button>`).join('');
    metro.innerHTML = `<div class="map-regions" role="group" aria-label="Linhas">${chips}</div>
      <h3 class="map-metro__title"><i style="background:${reg.color}"></i>${esc(reg.name)}</h3>
      <div class="map-metro__scroll">${svg}</div>
      <p class="map-metro__hint">O número amarelo em cada trecho é a energia gasta nele, em km/s. Toque numa estação para planejar uma missão.</p>
      <ul class="map-lines">${cards}</ul>`;
  }

  function wrapLabel(text, x, y) {
    const words = String(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 12 && cur) {
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
  let lastTap = null;

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
    freezeTween();
    bump();
    if (pointers.size === 1) Object.assign(gesture, { active: true, moved: false, sx: p.x, sy: p.y, lx: p.x, ly: p.y, pinch: null });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      gesture.moved = true;
    }
    invalidate();
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
      if (!gesture.moved && e.type === 'pointerup') {
        const t = now0();
        if (lastTap && t - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
          // double tap: zoom in there (at max zoom, back out to the level)
          lastTap = null;
          if (targetSpan() <= spanMin * 1.05) goLevel(currentLevel());
          else zoomAnimated(p.x, p.y, 2.4);
          return;
        }
        lastTap = { t, x: p.x, y: p.y };
        onTap(p.x, p.y);
      }
      updateLevelBar();
      invalidate();
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const p = localXY(e);
    const k = e.deltaMode === 1 ? 40 : 1;
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * k * 0.0016));
    bump(4000);
  }
  function onTap(x, y) {
    let best = null;
    let bd = Infinity;
    const prio = { transit: 0, dest: 1, body: 2 };
    for (const h of [...tHits, ...hits]) {
      if (h.kind === 'belt') continue;
      const d = Math.hypot(h.x - x, h.y - y);
      if (d > Math.max(h.r, 22)) continue;
      const score = d / Math.max(h.r, 1) + prio[h.kind] * 0.35;
      if (score < bd) (bd = score), (best = h);
    }
    if (!best) {
      // tap on a belt band opens the belt
      const belt = hits.find((h) => h.kind === 'belt' && (() => { const d = Math.hypot(x - h.cx, y - h.cy); return d >= h.ri - 6 && d <= h.ro + 6; })());
      if (belt) best = { kind: 'body', id: belt.id };
    }
    if (!best) {
      if (MEM.selected) closeSheet();
      return;
    }
    store?.vibrate?.(8);
    if (best.kind === 'body') openSheet({ bodyId: best.id });
    else if (best.kind === 'dest') openSheet({ bodyId: best.bodyId, destId: best.id });
    else {
      const t = model.transits.find((tr) => tr.key === best.id);
      openSheet({ bodyId: t?.bodyId || 'earth', transitKey: best.id });
    }
  }

  function onRootClick(e) {
    const t = e.target.closest?.('[data-mode],[data-level],[data-legend],[data-close],[data-body],[data-discovery],[data-dest],[data-zoom],[data-focus],[data-plan],[data-transit],[data-mission],[data-region],[data-show]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.mode) {
      MEM.mode = ds.mode;
      root.dataset.mode = MEM.mode; // visible before measuring the route diagram
      if (MEM.selected && (MEM.mode === 'metro') !== (MEM.selected.mode === 'dest')) MEM.selected = null;
      if (MEM.mode === 'metro') renderMetro();
      renderSheet();
      updateHud();
      sceneKey = '';
      invalidate();
    } else if (ds.level) {
      goLevel(levelById(ds.level));
    } else if (ds.legend) {
      MEM.legend = !MEM.legend;
      updateHud();
    } else if (ds.close) {
      closeSheet();
    } else if (ds.zoom) {
      zoomAnimated(W / 2, H / 2, ds.zoom === 'in' ? 2 : 0.5);
    } else if (ds.focus) {
      goBody(ds.focus);
    } else if (ds.plan) {
      planMission(ds.plan);
    } else if (ds.mission) {
      store?.ui?.navigate?.('missoes', `m/${ds.mission}`);
    } else if (ds.transit) {
      const tr = model.transits.find((x) => x.key === ds.transit);
      openSheet({ bodyId: tr?.bodyId || 'earth', transitKey: ds.transit });
    } else if (ds.discovery) {
      saveSeen([...loadSeen(), ds.discovery]);
      discovery.classList.remove('is-open');
      discovery.innerHTML = '';
      openSheet({ bodyId: ds.discovery });
      checkDiscoveries();
    } else if (ds.region) {
      MEM.metroRegion = ds.region;
      if (MEM.selected?.mode === 'dest') MEM.selected = null;
      renderSheet();
      renderMetro();
    } else if (ds.show || ds.body) {
      const id = ds.show || ds.body;
      if (MEM.mode !== 'map') {
        MEM.mode = 'map';
        updateHud();
        sceneKey = '';
      }
      MEM.selected = { bodyId: id };
      if (t.closest('.map-windows') || ds.show) goBody(id, true);
      else if (!(lastScr[id]?.vis > 0.5)) goBody(systemOf(data, id)?.id || id, true);
      openSheet({ bodyId: id });
    } else if (ds.dest && metro.contains(t)) {
      const same = MEM.selected?.mode === 'dest' && MEM.selected.destId === ds.dest;
      MEM.selected = same ? null : { mode: 'dest', destId: ds.dest, bodyId: destBodyId(data, ds.dest) };
      renderSheet();
      renderMetro();
    }
  }
  function onRootKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('[data-dest],[data-transit]') && !e.target.closest('button')) {
      e.preventDefault();
      onRootClick(e);
    } else if (e.key === 'Escape' && MEM.selected) closeSheet();
    else if ((e.key === '+' || e.key === '=') && MEM.mode === 'map') zoomAnimated(W / 2, H / 2, 2);
    else if (e.key === '-' && MEM.mode === 'map') zoomAnimated(W / 2, H / 2, 0.5);
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
  /** Dots glide from where they were to the new week's progress (and fly out the first time). */
  function syncProgress() {
    const t0 = now0();
    const still = reduceMotion();
    for (const t of model.transits) {
      const prev = MEM.prog[t.key];
      const from = prev ?? (MEM.intro ? null : 0);
      if (!still && from != null && Math.abs(from - t.progress) > 0.002 && t.phase === 'transit') {
        progAnim[t.key] = { from, t0, dur: prev == null ? 1400 : 900 };
      }
      MEM.prog[t.key] = t.progress;
    }
    MEM.intro = true;
  }

  function refresh() {
    state = store?.state || {};
    model = buildModel(state, data, q);
    positions = bodyPositions(data, state.turn ?? 0);
    version++;
    syncProgress();
    bump();
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
    pathCache.clear();
    // free the offscreen scene bitmap now (the shared background stays cached for the next visit)
    scene.width = 0;
    scene.height = 0;
    if (container.__mapCleanup === cleanup) delete container.__mapCleanup;
  }
  container.__mapCleanup = cleanup;

  // first paint
  syncProgress();
  bump();
  updateHud();
  if (MEM.mode === 'metro') renderMetro();
  renderSheet();
  resize();
  checkDiscoveries();
  invalidate();
  return cleanup;
}

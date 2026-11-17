// Mapa-múndi geopolítico (topo da aba Mundo): países por bloco, sedes das agências, bases de lançamento,
// linhas de tensão entre os países dos atores, zonas disputadas/em conflito e linha do tempo do histórico.
// Só apresenta o que o sim calculou ('geo/state', 'geo/history', 'politics/actor'). data/world.json
// (Natural Earth 110m, domínio público) é carregado sob demanda, só quando o mapa aparece.
import { h, chip, button, attempt, reduceMotion, fmtMonth, TENSION_LABELS } from './components.js';
import { relKey } from '../core/helpers.js';

// ------------------------------------------------------------------ module state (survives re-renders)

let WORLD = null;          // parsed world.json
let WORLD_P = null;        // pending fetch
let WORLD_ERR = null;
let PROJ = null;           // [{id, name, polys: [[Float32Array]], bbox}]
const V = { k: 1, cx: null, cy: null, turn: null, sel: null, legend: false };
let CURRENT = null;         // cleanup of the live map (internal re-renders replace it)
const stopCurrent = () => { const c = CURRENT; CURRENT = null; try { c?.(); } catch { /* */ } };

const XMAX = Math.PI * 0.8707;
const LAT_TOP = 84;
const LAT_BOT = -58;

/** Natural Earth I projection (Šavrič et al.), lon/lat in degrees -> unit plane (y down). */
export function project(lon, lat) {
  const l = (lon * Math.PI) / 180;
  const p = (Math.max(-89.9, Math.min(89.9, lat)) * Math.PI) / 180;
  const p2 = p * p;
  const p4 = p2 * p2;
  const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [x, -y];
}
const Y_TOP = project(0, LAT_TOP)[1];
const Y_BOT = project(0, LAT_BOT)[1];

// colorblind-safe (Okabe–Ito based) + a pattern per bloc, so color is never the only cue
const BLOC_STYLE = {
  artemis: { fill: '#2f80c4', pattern: 'stripes' },
  ilrs: { fill: '#c9632c', pattern: 'dots' },
  both: { fill: '#a86a9a', pattern: 'cross' },
  neutral: { fill: '#384360', pattern: null },
};
const LINE_STYLE = [
  { color: '#9aa3b8', width: 1, dash: [1.5, 4] },
  { color: '#f0e442', width: 1.4, dash: [5, 5] },
  { color: '#e69f00', width: 2.2, dash: [9, 4] },
  { color: '#ff7a3d', width: 3.2, dash: [] },
  { color: '#ff3b4e', width: 4.6, dash: [] },
];
const LINE_ICON = ['·', '!', '!!', '⚔', '☢'];
const STATUS_ICON = { stable: '◇', contested: '◈', conflict: '⚔', ceasefire: '⏸' };
const ZONE_STYLE = {
  stable: { stroke: 'rgba(230,235,245,.55)', dash: [], width: 1 },
  contested: { stroke: '#f0e442', dash: [2, 3], width: 1.4 },
  conflict: { stroke: '#ff3b4e', dash: [], width: 2 },
  ceasefire: { stroke: '#e8edf7', dash: [6, 4], width: 1.6 },
};

function ensureCss() {
  try {
    if (document.querySelector('link[data-worldmap-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./worldmap.css', import.meta.url).href;
    l.dataset.worldmapCss = '1';
    document.head.appendChild(l);
  } catch { /* no DOM */ }
}

function loadWorld() {
  if (WORLD) return Promise.resolve(WORLD);
  if (!WORLD_P) {
    WORLD_ERR = null;
    WORLD_P = fetch('./data/world.json')
      .then((r) => { if (!r.ok) throw new Error(`world.json ${r.status}`); return r.json(); })
      .then((w) => { WORLD = w; PROJ = projectWorld(w); return w; })
      .catch((e) => { WORLD_ERR = e; WORLD_P = null; throw e; });
  }
  return WORLD_P;
}

function projectWorld(w) {
  const out = [];
  for (const c of w.countries || []) {
    if (c.id === 'ATA') continue;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    const polys = (c.polygons || []).map((poly) => poly.map((ring) => {
      const a = new Float32Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = project(ring[i][0], ring[i][1]);
        a[i * 2] = x; a[i * 2 + 1] = y;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      return a;
    }));
    out.push({ id: c.id, name: c.name, continent: c.continent, polys, bbox: [minx, miny, maxx, maxy], label: project(c.labelLon, c.labelLat) });
  }
  return out;
}

// ------------------------------------------------------------------ helpers

const clampN = (x, a, b) => Math.max(a, Math.min(b, x));
const pctFmt = (v, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits).replace('.', ',')}%`;

function countryName(geo, iso) {
  return geo?.countryNames?.[iso] || WORLD?.countries?.find((c) => c.id === iso)?.name || iso;
}

/** iso -> [actorId] (agencies first). */
function actorsByCountry(geo, st) {
  const m = {};
  for (const [aid, list] of Object.entries(geo.actorCountries || {})) {
    if (!st.actors?.[aid]) continue;
    for (const iso of list) (m[iso] ||= []).push(aid);
  }
  for (const k of Object.keys(m)) m[k].sort((a, b) => (st.actors[a].kind === 'company') - (st.actors[b].kind === 'company'));
  return m;
}

function circleRing(c, n = 40) {
  const pts = [];
  const rLat = c.radiusKm / 111;
  const rLon = c.radiusKm / (111 * Math.max(0.2, Math.cos((c.lat * Math.PI) / 180)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([c.lon + Math.cos(a) * rLon, c.lat + Math.sin(a) * rLat]);
  }
  return pts;
}

function makePatterns(ctx) {
  const mk = (draw, size = 8) => {
    const t = document.createElement('canvas');
    t.width = size; t.height = size;
    const g = t.getContext('2d');
    draw(g, size);
    return ctx.createPattern(t, 'repeat');
  };
  return {
    stripes: mk((g, s) => { g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, s); g.lineTo(s, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(s - 1, s + 1); g.lineTo(s + 1, s - 1); g.stroke(); }),
    dots: mk((g) => { g.fillStyle = 'rgba(255,255,255,.32)'; g.beginPath(); g.arc(2, 2, 1.1, 0, 7); g.arc(6, 6, 1.1, 0, 7); g.fill(); }),
    cross: mk((g, s) => { g.strokeStyle = 'rgba(255,255,255,.26)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke(); }),
    hatch: mk((g, s) => { g.strokeStyle = 'rgba(255,59,78,.85)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, s); g.lineTo(s, 0); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(s - 2, s + 2); g.lineTo(s + 2, s - 2); g.stroke(); }, 7),
  };
}

// ------------------------------------------------------------------ render

/**
 * Render the world map into `container`. Returns a cleanup function.
 * opts.onActor(actorId) opens the actor sheet (provided by world-tab).
 */
export function render(container, store, opts = {}) {
  stopCurrent();
  ensureCss();
  const st = store.state;
  const root = h('div', { class: 'wm' });
  container.appendChild(root);
  if (!WORLD) {
    const msg = h('div', { class: 'wm-loading' }, WORLD_ERR ? 'Não foi possível carregar o mapa.' : 'Carregando o mapa-múndi…');
    if (WORLD_ERR) msg.append(' ', button('Tentar de novo', () => { WORLD_ERR = null; root.remove(); render(container, store, opts); }, { small: true, kind: 'ghost' }));
    root.append(msg);
    let alive = true;
    loadWorld().then(() => { if (alive && root.isConnected) { root.remove(); render(container, store, opts); } })
      .catch(() => { if (alive && root.isConnected) { root.remove(); render(container, store, opts); } });
    CURRENT = () => { alive = false; };
    return stopCurrent;
  }

  const now = st.turn;
  if (V.turn != null && V.turn >= now) V.turn = null;
  const T = V.turn ?? now;
  const geo = store.tryQuery('geo/state', null, T);
  if (!geo) { root.append(h('div', { class: 'wm-loading' }, 'O mapa geopolítico ainda não está disponível.')); return () => {}; }
  const hist = store.tryQuery('geo/history', null) || { events: [] };
  const byIso = actorsByCountry(geo, st);
  const playerIsos = new Set(geo.playerCountries || []);

  const canvas = h('canvas', { class: 'wm-canvas', role: 'img', 'aria-label': 'Mapa-múndi com blocos, sedes, bases de lançamento, tensões e zonas disputadas. Toque num país para detalhes.' });
  const card = h('div', { class: 'wm-card', hidden: true });
  const legend = h('div', { class: 'wm-legend', hidden: !V.legend }, legendContent(geo));
  const past = geo.isPast ? h('div', { class: 'wm-past' }, `Vendo ${fmtMonth(T, st.startYear)}`, ' ', h('button', { class: 'wm-link', type: 'button', onclick: () => { V.turn = null; rerender(); } }, 'voltar a hoje')) : null;
  const tools = h('div', { class: 'wm-tools' },
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Aproximar', onclick: () => zoomBy(1.6) }, '+'),
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Afastar', onclick: () => zoomBy(1 / 1.6) }, '−'),
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Centralizar na sua agência', onclick: () => { V.k = 1; centerOnHq(); layout(); draw(); } }, '⌖'),
    h('button', { class: ['wm-btn', V.legend && 'on'], type: 'button', 'aria-label': 'Legenda', 'aria-expanded': String(V.legend), onclick: (e) => { V.legend = !V.legend; legend.hidden = !V.legend; e.currentTarget.classList.toggle('on', V.legend); e.currentTarget.setAttribute('aria-expanded', String(V.legend)); } }, 'ⓘ'));
  const stage = h('div', { class: 'wm-stage' }, canvas, tools, past, legend, card);
  root.append(stage, timeline(store, geo, hist, T, (t) => { V.turn = t >= now ? null : t; rerender(); }, (e) => focusEvent(e)));

  /** Center the map on what an event is about (zone, incident area). */
  function focusEvent(e) {
    const z = geo.zones.find((x) => (e.zoneIds || []).includes(x.id) || x.id === e.zoneId);
    const c = geo.conflicts.find((x) => x.id === e.conflictId);
    const at = z?.label || c?.area || null;
    if (!at) return;
    const [x, y] = project(at.lon, at.lat);
    V.cx = x; V.cy = y; V.k = Math.max(V.k, 3);
    if (z) V.sel = { type: 'zone', id: z.id };
    else if (c) V.sel = { type: 'conflict', id: c.id };
    clampView(); showCard(); draw();
  }

  function rerender() {
    cleanup();
    root.remove();
    render(container, store, opts);
  }

  // ---------------------------------------------------------------- canvas plumbing
  const ctx = canvas.getContext('2d');
  if (!ctx) { stage.replaceChildren(h('div', { class: 'wm-loading' }, 'Seu navegador não desenha o mapa.')); return () => {}; }
  const pats = makePatterns(ctx);
  let W = 0, H = 0, dpr = 1, s0 = 1;
  const TOOLS_W = 56;
  let toolsRect = null;
  let hits = [];
  let paths = [];
  let raf = 0;
  let alive = true;
  const animated = () => !reduceMotion() && (geo.tensionLines.some((l) => l.level >= 4) || geo.zones.some((z) => z.status === 'conflict') || geo.conflicts.some((c) => c.area));

  function centerOnHq() {
    const me = geo.hqs.find((q) => q.isPlayer) || geo.hqs[0];
    const [x, y] = me ? project(me.lon, me.lat) : [0, 0];
    V.cx = x; V.cy = y;
  }
  function layout() {
    const r = stage.getBoundingClientRect();
    W = Math.max(200, Math.round(r.width));
    H = Math.max(160, Math.round(r.height));
    dpr = Math.min(2.5, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    s0 = H / (Y_BOT - Y_TOP); // k = 1: whole height of the map fits
    if (V.cx == null) {
      const me = geo.hqs.find((q) => q.isPlayer) || geo.hqs[0];
      let [x, y] = me ? project(me.lon, me.lat) : [0, 0];
      // an active conflict in view from the start when it fits next to the player's HQ (controls column kept clear)
      const c = geo.conflicts.find((k) => k.area) || null;
      const z = !c ? geo.zones.find((k) => k.status === 'conflict' && k.label) : null;
      const at = c?.area || z?.label || null;
      if (at) {
        const [cx, cy] = project(at.lon, at.lat);
        const room = W - 2 * TOOLS_W;
        if (Math.abs(cx - x) * s0 < room && Math.abs(cy - y) * s0 < H - 40) { x = (x + cx) / 2; y = (y + cy) / 2; }
      }
      V.cx = x; V.cy = y;
    }
    clampView();
    // the +/−/⌖/ⓘ column covers the top-right corner: labels treat it as an obstacle
    const tr = tools.getBoundingClientRect?.();
    toolsRect = tr && tr.width ? [tr.left - r.left - 4, tr.top - r.top - 4, tr.width + 8, tr.height + 8] : [W - TOOLS_W, 0, TOOLS_W, 170];
  }
  const kMin = () => Math.min(1, W / (2 * XMAX * s0));
  function clampView() {
    V.k = clampN(V.k, kMin(), 16);
    const s = s0 * V.k;
    const halfW = W / 2 / s;
    const halfH = H / 2 / s;
    V.cx = XMAX <= halfW ? 0 : clampN(V.cx, -XMAX + halfW, XMAX - halfW);
    const midY = (Y_TOP + Y_BOT) / 2;
    V.cy = (Y_BOT - Y_TOP) / 2 <= halfH ? midY : clampN(V.cy, Y_TOP + halfH, Y_BOT - halfH);
  }
  const scale = () => s0 * V.k;
  const toScreen = (x, y) => { const s = scale(); return [(x - V.cx) * s + W / 2, (y - V.cy) * s + H / 2]; };
  const toPlane = (sx, sy) => { const s = scale(); return [(sx - W / 2) / s + V.cx, (sy - H / 2) / s + V.cy]; };
  const ll = (lon, lat) => { const [x, y] = project(lon, lat); return toScreen(x, y); };

  function zoomBy(f, sx = W / 2, sy = H / 2) {
    const [px, py] = toPlane(sx, sy);
    V.k = clampN(V.k * f, kMin(), 16);
    const s = scale();
    V.cx = px - (sx - W / 2) / s;
    V.cy = py - (sy - H / 2) / s;
    clampView();
    draw();
  }

  function schedule() {
    if (raf || !alive) return;
    raf = requestAnimationFrame((t) => { raf = 0; frame(t); });
  }
  function draw() { schedule(); }
  function frame(t) {
    if (!alive || !canvas.isConnected) return;
    paint(t || 0);
    if (animated()) schedule();
  }

  // ---------------------------------------------------------------- painting
  function ringPath(p, ring, s, ox, oy) {
    p.moveTo(ring[0] * s + ox, ring[1] * s + oy);
    for (let i = 2; i < ring.length; i += 2) p.lineTo(ring[i] * s + ox, ring[i + 1] * s + oy);
    p.closePath();
  }
  function lonLatPath(points) {
    const p = new Path2D();
    points.forEach(([lon, lat], i) => { const [x, y] = ll(lon, lat); if (i) p.lineTo(x, y); else p.moveTo(x, y); });
    p.closePath();
    return p;
  }

  function paint(t) {
    const pulse = reduceMotion() ? 0.6 : 0.5 + 0.5 * Math.sin(t / 380);
    const s = scale();
    const ox = W / 2 - V.cx * s;
    const oy = H / 2 - V.cy * s;
    const fs = attempt(() => parseFloat(getComputedStyle(document.documentElement).fontSize), 15) || 15;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0c1730';
    ctx.fillRect(0, 0, W, H);
    hits = [];
    paths = [];

    // graticule
    ctx.strokeStyle = 'rgba(120,150,200,.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let lon = -180; lon <= 180; lon += 30) {
      ctx.beginPath();
      for (let lat = LAT_BOT; lat <= LAT_TOP; lat += 4) { const [x, y] = ll(lon, lat); if (lat === LAT_BOT) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    for (let lat = -30; lat <= 60; lat += 30) {
      ctx.beginPath();
      for (let lon = -180; lon <= 180; lon += 6) { const [x, y] = ll(lon, lat); if (lon === -180) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }

    // countries
    for (const c of PROJ) {
      const [bx0, by0, bx1, by1] = c.bbox;
      if (bx1 * s + ox < 0 || bx0 * s + ox > W || by1 * s + oy < 0 || by0 * s + oy > H) continue;
      const p = new Path2D();
      for (const poly of c.polys) for (const ring of poly) ringPath(p, ring, s, ox, oy);
      const bloc = geo.countryBloc[c.id] || 'neutral';
      const bs = BLOC_STYLE[bloc] || BLOC_STYLE.neutral;
      ctx.globalAlpha = geo.isPast ? 0.75 : 0.9;
      ctx.fillStyle = bs.fill;
      ctx.fill(p, 'evenodd');
      ctx.globalAlpha = 1;
      if (bs.pattern && pats[bs.pattern]) { ctx.fillStyle = pats[bs.pattern]; ctx.fill(p, 'evenodd'); }
      ctx.strokeStyle = 'rgba(8,12,24,.75)';
      ctx.lineWidth = 0.7;
      ctx.stroke(p);
      paths.push({ id: c.id, p, bbox: [bx0 * s + ox, by0 * s + oy, bx1 * s + ox, by1 * s + oy] });
    }
    // player's countries and selection on top
    for (const e of paths) {
      if (playerIsos.has(e.id)) { ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.6; ctx.stroke(e.p); }
      if (V.sel?.type === 'country' && V.sel.id === e.id) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.4; ctx.stroke(e.p); }
    }

    // zones
    for (const z of geo.zones) {
      const pts = z.kind === 'circle' && z.circle ? circleRing(z.circle) : z.polygon;
      if (!pts?.length) continue;
      const p = lonLatPath(pts);
      const zs = ZONE_STYLE[z.status] || ZONE_STYLE.contested;
      if (z.status === 'conflict') {
        ctx.fillStyle = pats.hatch; ctx.fill(p);
        ctx.globalAlpha = 0.25 + 0.35 * pulse; ctx.fillStyle = '#ff3b4e'; ctx.fill(p); ctx.globalAlpha = 1;
      } else if (z.status === 'ceasefire') {
        ctx.fillStyle = 'rgba(232,237,247,.16)'; ctx.fill(p);
      } else {
        ctx.fillStyle = 'rgba(240,228,66,.10)'; ctx.fill(p);
      }
      ctx.setLineDash(zs.dash);
      ctx.strokeStyle = zs.stroke;
      ctx.lineWidth = zs.width + (z.status === 'conflict' ? pulse * 1.4 : 0);
      ctx.stroke(p);
      if (z.changedTurn != null) { ctx.setLineDash([]); ctx.strokeStyle = '#56d4ff'; ctx.lineWidth = 3; ctx.stroke(p); }
      ctx.setLineDash([]);
      if (V.sel?.type === 'zone' && V.sel.id === z.id) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(p); }
      hits.push({ type: 'zone', id: z.id, p, prio: 3 });
    }
    // incident areas of conflicts that have no mapped zone
    for (const c of geo.conflicts) {
      if (!c.area) continue;
      const p = lonLatPath(circleRing(c.area));
      ctx.fillStyle = pats.hatch; ctx.globalAlpha = 0.6; ctx.fill(p); ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ff3b4e'; ctx.lineWidth = 1.5 + pulse; ctx.stroke(p); ctx.setLineDash([]);
      hits.push({ type: 'conflict', id: c.id, p, prio: 3 });
    }

    // HQ tags are drawn last (on top), but placed first so tension badges keep off them
    const obstacles = toolsRect ? [toolsRect] : [];
    const hqPlace = new Map();
    for (const q of geo.hqs) {
      const [x, y] = ll(q.lon, q.lat);
      const dy = q.dy ?? -14;
      const opt = { fs: fs * 0.74, bold: q.isPlayer };
      const [w, hh] = pillSize(ctx, `${q.flag} ${q.short}`, opt);
      let px = x, py = y + dy;
      // under the controls column: slide the tag to its left edge so it stays readable
      if (toolsRect && rectsOverlap([px - w / 2, py - hh / 2, w, hh], toolsRect)) px = Math.min(px, toolsRect[0] - w / 2 - 2);
      hqPlace.set(q.actorId, [px, py]);
      obstacles.push([px - w / 2, py - hh / 2, w, hh]);
    }

    // tension lines between the actors' countries
    for (const l of geo.tensionLines) {
      const [ax, ay] = ll(l.from.lon, l.from.lat);
      const [bx, by] = ll(l.to.lon, l.to.lat);
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if (ny > 0) { nx = -nx; ny = -ny; } // bow toward the north
      const cxp = (ax + bx) / 2 + nx * len * 0.18;
      const cyp = (ay + by) / 2 + ny * len * 0.18;
      const ls = LINE_STYLE[l.level] || LINE_STYLE[0];
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cxp, cyp, bx, by);
      ctx.setLineDash(ls.dash);
      ctx.lineCap = 'round';
      if (l.level >= 4) { ctx.strokeStyle = 'rgba(255,59,78,.35)'; ctx.lineWidth = ls.width + 6 * pulse; ctx.stroke(); }
      ctx.strokeStyle = ls.color;
      ctx.lineWidth = ls.width;
      ctx.stroke();
      ctx.setLineDash([]);
      // badge at the curve midpoint: icon + level (+ word when zoomed in), never color alone
      const mx = 0.25 * ax + 0.5 * cxp + 0.25 * bx;
      const my = 0.25 * ay + 0.5 * cyp + 0.25 * by;
      // declutter when zoomed out: calm lines keep only the line itself (tap the line badge when zoomed in)
      if (l.level === 0 && V.k < 3) continue;
      if (l.level === 1 && V.k < 1.4) continue;
      const word = V.k >= 2.2 || l.level >= 3 ? ` ${shortLevel(l.level)}` : '';
      const txt = `${LINE_ICON[l.level]} ${l.level}${word}`;
      const bopt = { fs: fs * 0.72, bold: l.level >= 3 };
      const [bw, bh] = pillSize(ctx, txt, bopt);
      // slide along the line's normal until it clears HQ tags, other badges and the controls
      const [px, py] = placeAway(mx, my, bw, bh, obstacles, { dx: nx, dy: ny });
      const b = pill(ctx, px, py, txt, { ...bopt, bg: 'rgba(8,12,26,.88)', border: ls.color, color: '#fff' });
      obstacles.push(b);
      hits.push({ type: 'line', id: l.key, rect: b, prio: 1 });
    }

    // launch sites
    for (const site of geo.sites) {
      const [x, y] = ll(site.lon, site.lat);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const r = V.k >= 2 ? 5 : 3.6;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.9, y + r * 0.7); ctx.lineTo(x - r * 0.9, y + r * 0.7); ctx.closePath();
      ctx.fillStyle = site.actors?.length ? '#f2ead8' : '#9aa8c7';
      ctx.strokeStyle = '#0b1020';
      ctx.lineWidth = 1;
      ctx.fill(); ctx.stroke();
      if (V.k >= 3.2 || (V.sel?.type === 'site' && V.sel.id === site.id)) {
        ctx.font = `${Math.round(fs * 0.68)}px system-ui, sans-serif`;
        ctx.fillStyle = '#e8eefc';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(site.name, x + r + 3, y);
      }
      hits.push({ type: 'site', id: site.id, rect: [x - 9, y - 9, 18, 18], prio: 2 });
    }

    // zone markers and labels (one ⚔ per conflict, at the middle of its zones)
    const marked = new Set();
    for (const z of geo.zones) {
      if (!z.label) continue;
      const [x, y] = ll(z.label.lon, z.label.lat);
      if (z.status === 'conflict') {
        if (!(z.conflictId && marked.has(z.conflictId))) {
        const group = z.conflictId ? geo.zones.filter((o) => o.conflictId === z.conflictId && o.label) : [z];
        marked.add(z.conflictId);
        const mx = group.reduce((a, o) => a + ll(o.label.lon, o.label.lat)[0], 0) / group.length;
        const my = group.reduce((a, o) => a + ll(o.label.lon, o.label.lat)[1], 0) / group.length;
        const r = pill(ctx, mx, my, '⚔', { fs: fs * 0.85, bg: 'rgba(120,10,25,.9)', border: '#ff3b4e', color: '#fff', pad: 3 });
        hits.push({ type: 'zone', id: z.id, rect: r, prio: 1 });
        }
      } else if (z.status === 'ceasefire' && V.k >= 1.4) {
        pill(ctx, x, y, '⏸', { fs: fs * 0.7, bg: 'rgba(20,26,44,.9)', border: '#e8edf7', color: '#fff', pad: 3 });
      }
      if (z.changedTurn != null) {
        const r = pill(ctx, x, y + fs * 1.25, `mudou de controle em ${fmtMonth(z.changedTurn, st.startYear)}`, { fs: fs * 0.66, bg: 'rgba(6,40,56,.92)', border: '#56d4ff', color: '#dff6ff' });
        hits.push({ type: 'zone', id: z.id, rect: r, prio: 1 });
      } else if (V.k >= 3.5) {
        ctx.font = `${Math.round(fs * 0.66)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(240,240,250,.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(z.name, x, y + fs * 0.7);
      }
    }
    for (const c of geo.conflicts) {
      if (!c.area) continue;
      const [x, y] = ll(c.area.lon, c.area.lat);
      const r = pill(ctx, x, y, '⚔', { fs: fs * 0.85, bg: 'rgba(120,10,25,.9)', border: '#ff3b4e', color: '#fff', pad: 3 });
      hits.push({ type: 'conflict', id: c.id, rect: r, prio: 1 });
    }

    // HQs: flag + short name (no official logos)
    for (const q of geo.hqs) {
      const [x, y] = ll(q.lon, q.lat);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = q.isPlayer ? '#ffd166' : '#fff'; ctx.fill();
      ctx.strokeStyle = '#0b1020'; ctx.lineWidth = 1; ctx.stroke();
      const [px, py] = hqPlace.get(q.actorId) || [x, y + (q.dy ?? -14)];
      const r = pill(ctx, px, py, `${q.flag} ${q.short}`, { fs: fs * 0.74, bg: q.isPlayer ? 'rgba(60,44,6,.95)' : 'rgba(10,14,30,.9)', border: q.isPlayer ? '#ffd166' : (q.color || '#cdbf9f'), color: '#fff', bold: q.isPlayer });
      hits.push({ type: 'hq', id: q.actorId, rect: r, prio: 0 });
    }
  }

  // ---------------------------------------------------------------- interaction
  const ptrs = new Map();
  let g = null;
  const rel = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function onDown(e) {
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic or already released pointer */ }
    const [x, y] = rel(e);
    ptrs.set(e.pointerId, [x, y]);
    if (ptrs.size === 1) g = { type: 'pan', sx: x, sy: y, cx: V.cx, cy: V.cy, t: performance.now(), moved: false };
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      g = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k0: V.k, anchor: toPlane(mx, my), moved: true };
    }
  }
  function onMove(e) {
    if (!ptrs.has(e.pointerId) || !g) return;
    const [x, y] = rel(e);
    ptrs.set(e.pointerId, [x, y]);
    if (g.type === 'pan' && ptrs.size === 1) {
      const dx = x - g.sx, dy = y - g.sy;
      if (Math.hypot(dx, dy) > 6) g.moved = true;
      if (!g.moved) return;
      const s = scale();
      V.cx = g.cx - dx / s; V.cy = g.cy - dy / s;
      clampView(); draw();
    } else if (g.type === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      V.k = clampN(g.k0 * (d / g.d0), kMin(), 16);
      const s = scale();
      V.cx = g.anchor[0] - (mx - W / 2) / s; V.cy = g.anchor[1] - (my - H / 2) / s;
      clampView(); draw();
    }
  }
  function onUp(e) {
    const wasTap = g?.type === 'pan' && !g.moved && performance.now() - g.t < 600 && ptrs.size === 1;
    ptrs.delete(e.pointerId);
    if (wasTap) { const [x, y] = rel(e); tap(x, y); }
    if (ptrs.size === 1) { const [p] = [...ptrs.values()]; g = { type: 'pan', sx: p[0], sy: p[1], cx: V.cx, cy: V.cy, t: 0, moved: true }; }
    else if (!ptrs.size) g = null;
  }
  function onWheel(e) {
    e.preventDefault();
    const [x, y] = rel(e);
    zoomBy(Math.exp(-e.deltaY * 0.0016), x, y);
  }
  function tap(x, y) {
    const inRect = (r) => r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const found = hits.filter((hh) => (hh.rect ? inRect(hh.rect) : hh.p && ctx.isPointInPath(hh.p, x * dpr, y * dpr)))
      .sort((a, b) => a.prio - b.prio)[0];
    if (found) select({ type: found.type, id: found.id });
    else {
      const c = paths.slice().reverse().find((e) => x >= e.bbox[0] - 1 && x <= e.bbox[2] + 1 && y >= e.bbox[1] - 1 && y <= e.bbox[3] + 1 && ctx.isPointInPath(e.p, x * dpr, y * dpr, 'evenodd'));
      select(c ? { type: 'country', id: c.id } : null);
    }
  }
  function select(sel) {
    V.sel = sel;
    showCard();
    draw();
  }
  function showCard() {
    const content = V.sel ? attempt(() => cardFor(store, geo, byIso, V.sel, opts), null) : null;
    if (!content) { card.hidden = true; card.replaceChildren(); return; }
    card.replaceChildren(
      h('button', { class: 'wm-card-close', type: 'button', 'aria-label': 'Fechar', onclick: () => select(null) }, '✕'),
      content);
    card.hidden = false;
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { layout(); draw(); }) : null;
  ro?.observe(stage);
  requestAnimationFrame(() => {
    if (!alive) return;
    layout(); showCard(); draw();
    // opened from the "⚔ N conflitos" chip: frame that conflict
    if (opts.focus) focusEvent(opts.focus);
  });

  function cleanup() {
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro?.disconnect();
    if (CURRENT === cleanup) CURRENT = null;
  }
  CURRENT = cleanup;
  return stopCurrent;
}

function shortLevel(l) {
  return ['normal', 'tensão', 'crise', 'conflito', 'guerra'][l] || '';
}

/** Rounded label centered at (x, y). Returns its hit rect [x, y, w, h]. */
/** Size of a pill without drawing it: [w, h]. */
function pillSize(ctx, text, { fs = 11, bold = false, pad = 5 } = {}) {
  ctx.font = `${bold ? '700 ' : ''}${Math.round(fs)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  return [Math.ceil(ctx.measureText(text).width) + pad * 2, Math.round(fs * 1.5)];
}

/** Axis-aligned overlap of [x, y, w, h] rects (with a small gap). Pure: exported for tests. */
export function rectsOverlap(a, b, gap = 2) {
  return a[0] < b[0] + b[2] + gap && b[0] < a[0] + a[2] + gap && a[1] < b[1] + b[3] + gap && b[1] < a[1] + a[3] + gap;
}

/**
 * Nudge a label centred at (x, y) with size [w, h] off the obstacles: tries the spot itself, then steps along (dx, dy)
 * both ways. Returns the new centre. Pure: exported for tests.
 */
export function placeAway(x, y, w, h, obstacles, { dx = 0, dy = -1, step = 0, tries = 5 } = {}) {
  const st = step || h + 2;
  const free = (cx, cy) => !obstacles.some((o) => rectsOverlap([cx - w / 2, cy - h / 2, w, h], o));
  if (free(x, y)) return [x, y];
  for (let i = 1; i <= tries; i++) {
    for (const sgn of [1, -1]) {
      const cx = x + dx * st * i * sgn, cy = y + dy * st * i * sgn;
      if (free(cx, cy)) return [cx, cy];
    }
  }
  return [x, y];
}

function pill(ctx, x, y, text, { fs = 11, bg, border, color = '#fff', bold = false, pad = 5 } = {}) {
  ctx.font = `${bold ? '700 ' : ''}${Math.round(fs)}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const hh = Math.round(fs * 1.5);
  const rx = x - w / 2, ry = y - hh / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, ry, w, hh, hh / 2); else ctx.rect(rx, ry, w, hh);
  ctx.fillStyle = bg; ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1.2; ctx.stroke(); }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  return [rx, ry, w, hh];
}

// ------------------------------------------------------------------ cards

function cardFor(store, geo, byIso, sel, opts) {
  const st = store.state;
  if (sel.type === 'country') return countryCard(store, geo, byIso, sel.id, opts);
  if (sel.type === 'hq') {
    const q = geo.hqs.find((x) => x.actorId === sel.id);
    return h('div', null, actorBlock(store, geo, sel.id, opts, true), q?.city ? h('p', { class: 'tiny muted' }, `Sede: ${q.city}`) : null);
  }
  if (sel.type === 'zone') return zoneCard(store, geo, sel.id);
  if (sel.type === 'site') {
    const s = geo.sites.find((x) => x.id === sel.id);
    if (!s) return null;
    const users = (s.actors || []).map((id) => st.actors?.[id]).filter(Boolean);
    return h('div', null,
      h('h3', { class: 'wm-card-title' }, `▲ ${s.name}`),
      h('p', { class: 'small muted' }, `Base de lançamento · ${countryName(geo, s.country)}`),
      users.length ? h('div', { class: 'chips' }, users.map((a) => chip(`${a.flag || ''} ${a.short || a.name}`.trim(), 'muted'))) : h('p', { class: 'tiny muted' }, 'Sem agência do jogo operando aqui.'));
  }
  if (sel.type === 'line') {
    const l = geo.tensionLines.find((x) => x.key === sel.id);
    if (!l) return null;
    return h('div', null,
      h('h3', { class: 'wm-card-title' }, `${l.flags[0]} ${l.names[0]} – ${l.flags[1]} ${l.names[1]}`),
      h('p', null, chip(`${LINE_ICON[l.level]} Nível ${l.level}: ${TENSION_LABELS[l.level] || l.levelLabel}`, l.level >= 3 ? 'bad' : l.level >= 2 ? 'warn' : 'muted')),
      h('p', { class: 'tiny muted' }, tensionEffect(store, l.level)));
  }
  if (sel.type === 'conflict') {
    const c = geo.conflicts.find((x) => x.id === sel.id);
    if (!c) return null;
    return h('div', null,
      h('h3', { class: 'wm-card-title' }, `⚔ ${c.area?.name || c.name || 'Conflito'}`),
      h('p', { class: 'small' }, `${c.partyNames.join(' × ')} · desde ${fmtMonth(c.startTurn, st.startYear)}`),
      h('p', null, chip(`Intensidade ${c.intensity}: ${c.levelLabel}`, 'bad')),
      h('p', { class: 'tiny muted' }, 'Incidentes e mobilização na região, sem mudança de fronteiras.'));
  }
  return null;
}

function tensionEffect(store, level) {
  const lv = store.data?.politics?.levels?.[level];
  return lv?.description || '';
}

function countryCard(store, geo, byIso, iso, opts) {
  const st = store.state;
  const bloc = geo.countryBloc[iso] || 'neutral';
  const actors = byIso[iso] || [];
  const zones = geo.zones.filter((z) => z.claimants.includes(iso) || z.controller === iso);
  const mine = (geo.playerCountries || []).includes(iso);
  const sites = (geo.sites || []).filter((x) => x.country === iso);
  return h('div', null,
    h('h3', { class: 'wm-card-title' }, countryName(geo, iso), mine ? h('span', { class: 'tiny wm-mine' }, ' · sua base') : null),
    h('div', { class: 'chips' },
      h('span', { class: `chip wm-bloc b-${bloc}` }, h('span', { class: `wm-swatch b-${bloc}`, 'aria-hidden': 'true' }), ` ${geo.blocLabels[bloc] || bloc}`),
      (geo.esaAssociates || []).includes(iso) ? chip('associado à ESA', 'muted') : null),
    actors.length ? actors.filter((id, i) => i === 0 || st.actors[id].kind !== 'company' || actors.length <= 3).map((id) => actorBlock(store, geo, id, opts)) : h('p', { class: 'tiny muted' }, 'Sem agência no jogo.'),
    sites.length ? h('p', { class: 'tiny muted' }, `▲ Bases: ${sites.map((x) => x.name).join(', ')}`) : null,
    zones.length ? h('div', { class: 'wm-zones' }, h('div', { class: 'tiny muted' }, 'Áreas disputadas'),
      zones.map((z) => h('div', { class: 'wm-zone-row' }, `${STATUS_ICON[z.status] || ''} ${z.name} `, chip(z.statusLabel, z.status === 'conflict' ? 'bad' : z.status === 'ceasefire' ? 'warn' : 'muted'),
        h('span', { class: 'tiny muted' }, ` controle: ${z.controllerName}`)))) : null);
}

function actorBlock(store, geo, actorId, opts, big = false) {
  const st = store.state;
  const a = st.actors?.[actorId];
  if (!a) return null;
  const me = st.playerId;
  const t = actorId === me ? null : Math.max(0, Math.min(4, Math.round(Number(st.tension?.[relKey(me, actorId)]) || 0)));
  const pol = store.tryQuery('politics/actor', null, actorId) || {};
  const e = pol.economy || {};
  const crises = store.data?.politics?.crises || {};
  const econ = e.kind === 'market'
    ? `Mercado: receita ${pctFmt((e.growth || 0) * 100, 0)}/ano · humor ${Math.round(e.sentiment ?? 50)}`
    : e.growth != null ? `Economia: PIB ${pctFmt(e.growth)} · inflação ${String((e.inflation ?? 0).toFixed(1)).replace('.', ',')}%` : null;
  const crisis = e.crisis ? crises[e.crisis.type]?.label || 'crise' : null;
  const blocName = a.bloc ? st.blocs?.[a.bloc]?.short || st.blocs?.[a.bloc]?.name || a.bloc : 'sem bloco';
  return h('div', { class: ['wm-actor', big && 'big'] },
    h('div', { class: 'wm-actor-head' },
      h('strong', null, `${a.flag || ''} ${big ? a.name : a.short || a.name}`.trim()),
      actorId === me ? chip('você', 'accent') : chip(`${['○', '●', '●●', '●●●', '●●●●'][t]} ${TENSION_LABELS[t]}`, t >= 3 ? 'bad' : t >= 1 ? 'warn' : 'muted')),
    h('div', { class: 'tiny muted' }, [a.kind === 'company' ? 'empresa' : 'agência', blocName, pol.government ? `governo: ${pol.government}` : null, pol.priorityLabel ? `prioridade: ${pol.priorityLabel}` : null].filter(Boolean).join(' · ')),
    econ ? h('div', { class: 'tiny' }, econ, crisis ? h('span', { class: 'warn-text' }, ` · ${crisis}`) : null) : null,
    pol.nextElectionTurn != null && pol.nextElectionName ? h('div', { class: 'tiny muted' }, `Próxima: ${pol.nextElectionName} (${fmtMonth(pol.nextElectionTurn, st.startYear)})`) : null,
    opts.onActor && actorId !== me ? button('Abrir ficha', () => opts.onActor(actorId), { small: true, kind: 'ghost' }) : null);
}

function zoneCard(store, geo, id) {
  const st = store.state;
  const z = geo.zones.find((x) => x.id === id);
  if (!z) return null;
  const c = z.conflictId ? geo.conflicts.find((x) => x.id === z.conflictId) : null;
  const since = z.sinceYear != null ? `desde ${z.sinceYear}` : `desde ${fmtMonth(z.since, st.startYear)}`;
  return h('div', null,
    h('h3', { class: 'wm-card-title' }, `${STATUS_ICON[z.status] || ''} ${z.name}`),
    h('div', { class: 'chips' }, chip(z.statusLabel, z.status === 'conflict' ? 'bad' : z.status === 'ceasefire' ? 'warn' : 'muted'), chip(since, 'muted')),
    h('p', { class: 'small' }, `Controle de fato: ${z.controllerName} · Reivindicam: ${z.claimantNames.join(', ')}`),
    z.changedTurn != null ? h('p', { class: 'small wm-changed' }, `Mudou de controle em ${fmtMonth(z.changedTurn, st.startYear)} (antes: ${z.changedFromName}).`) : null,
    c ? h('p', { class: 'small' }, `⚔ ${c.name || 'Conflito'}: ${c.partyNames.join(' × ')} · intensidade ${c.intensity} (${c.levelLabel})`) : null,
    h('p', { class: 'tiny muted' }, z.desc));
}

// ------------------------------------------------------------------ legend & timeline

function legendContent(geo) {
  const row = (sw, text) => h('div', { class: 'wm-leg-row' }, sw, h('span', null, text));
  const sw = (cls) => h('span', { class: `wm-swatch ${cls}`, 'aria-hidden': 'true' });
  const line = (l) => h('span', { class: `wm-leg-line l${l}`, 'aria-hidden': 'true' });
  return [
    h('div', { class: 'wm-leg-title' }, 'Blocos'),
    ['artemis', 'ilrs', 'both', 'neutral'].map((b) => row(sw(`b-${b}`), geo.blocLabels[b] || b)),
    h('div', { class: 'wm-leg-title' }, 'Tensão entre países dos atores'),
    [1, 2, 3, 4].map((l) => row(line(l), `${LINE_ICON[l]} ${l} · ${TENSION_LABELS[l]}`)),
    row(line(0), 'Sua relação sem tensão'),
    h('div', { class: 'wm-leg-title' }, 'Zonas'),
    row(sw('z-conflict'), '⚔ em conflito (hachurada, pulsa)'),
    row(sw('z-ceasefire'), '⏸ cessar-fogo (tracejada)'),
    row(sw('z-contested'), '◈ disputada (pontilhada)'),
    row(sw('z-changed'), 'mudou de controle (contorno azul)'),
    h('div', { class: 'wm-leg-title' }, 'Marcadores'),
    row(h('span', { class: 'wm-leg-ico' }, '🇺🇸 NASA'), 'sede de agência (bandeira + sigla)'),
    row(h('span', { class: 'wm-leg-ico' }, '▲'), 'base de lançamento'),
    h('p', { class: 'tiny muted' }, `Situação inicial de referência: ${geo.asOf || 'nov/2026'}. ${geo.source || ''}`),
  ];
}

function timeline(store, geo, hist, T, onScrub, onFocus) {
  const st = store.state;
  const now = st.turn;
  const evs = (hist.events || []).filter((e) => e.turn >= 0 && e.turn <= now);
  const at = [...evs].reverse().find((e) => e.turn <= T) || null;
  const prev = [...evs].reverse().find((e) => e.turn < T) || null;
  const next = evs.find((e) => e.turn > T) || null;
  const max = Math.max(1, now);
  const range = h('input', {
    class: 'wm-range', type: 'range', min: '0', max: String(max), step: '1', value: String(Math.min(T, max)),
    'aria-label': 'Linha do tempo do mapa', disabled: now <= 0,
  });
  let pend = 0;
  range.addEventListener('input', () => {
    const v = Number(range.value);
    label.textContent = v >= now ? `Hoje · ${fmtMonth(now, st.startYear)}` : fmtMonth(v, st.startYear);
    clearTimeout(pend);
    pend = setTimeout(() => onScrub(v), 120);
  });
  range.addEventListener('change', () => { clearTimeout(pend); onScrub(Number(range.value)); });
  const ticks = h('div', { class: 'wm-ticks', 'aria-hidden': 'true' }, evs.map((e) => h('span', {
    class: ['wm-tick', `k-${e.kind}`], style: { left: `${(e.turn / max) * 100}%` }, title: e.text,
  })));
  const label = h('span', { class: 'wm-when' }, T >= now ? `Hoje · ${fmtMonth(now, st.startYear)}` : fmtMonth(T, st.startYear));
  return h('div', { class: 'wm-timeline' },
    h('div', { class: 'wm-tl-row' },
      h('button', { class: 'wm-btn small', type: 'button', 'aria-label': 'Evento anterior', disabled: !prev, onclick: () => prev && onScrub(prev.turn) }, '◀'),
      h('div', { class: 'wm-track' }, ticks, range),
      h('button', { class: 'wm-btn small', type: 'button', 'aria-label': 'Próximo evento', disabled: !next && T >= now, onclick: () => onScrub(next ? next.turn : now) }, '▶')),
    h('div', { class: 'wm-tl-caption' }, label,
      at ? h('span', { class: 'tiny wm-ev' }, ` · ${fmtMonth(at.turn, st.startYear)}: ${at.text} `,
        (at.zoneIds?.length || at.zoneId || at.conflictId) ? h('button', { class: 'wm-link', type: 'button', onclick: () => onFocus?.(at) }, 'ver no mapa') : null) : h('span', { class: 'tiny muted' }, evs.length ? '' : ' · Nenhuma mudança no mapa desde o início da campanha.')));
}

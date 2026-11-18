// Mapa-múndi geopolítico (topo da aba Mundo): países por bloco, sedes das agências (com emblema), bases de
// lançamento, linhas de tensão entre os países dos atores, zonas disputadas/em conflito e linha do tempo do histórico.
// 1950–3000: as fronteiras e blocos de cada época vêm de data/world-eras.json (URSS, Pacto de Varsóvia, Alemanhas,
// descolonização, federações especulativas) como fusões/sobreposições dos polígonos de hoje; de 2020 a 2079 as
// cores são as do simulador (Artemis/ILRS). Só apresenta o que o sim calculou ('geo/state', 'geo/history',
// 'politics/actor'). data/world.json (Natural Earth 110m, domínio público) e world-eras.json são carregados sob
// demanda, só quando o mapa aparece. Modo "escolher sede" (opts.pick) para o assistente de fundação.
import { h, chip, button, attempt, reduceMotion, fmtMonth, TENSION_LABELS, iconSVG, flagPrefix } from './components.js';
import { relKey } from '../core/helpers.js';

// ------------------------------------------------------------------ module state (survives re-renders)

let WORLD = null;          // parsed world.json
let WORLD_P = null;        // pending fetch
let WORLD_ERR = null;
let PROJ = null;           // [{id, name, polys: [[Float32Array]], bbox}]
let ERAS = null;           // compiled world-eras.json (null: offline/missing → the sim's blocs at every date)
let EMBLEM = null;         // src/ui/emblem.js when present (HQ badges)
let EMBLEM_P = null;
const EMBLEM_IMG = new Map(); // actorId|spec -> HTMLImageElement
const V = { k: 1, cx: null, cy: null, turn: null, sel: null, legend: false, hl: null };
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
    // the era file is optional: without it the map still opens (sim blocs only)
    const eras = fetch('./data/world-eras.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    WORLD_P = fetch('./data/world.json')
      .then((r) => { if (!r.ok) throw new Error(`world.json ${r.status}`); return r.json(); })
      .then(async (w) => { const we = await eras; WORLD = w; PROJ = projectWorld(w); ERAS = compileWorldEras(we, w.countries); return w; })
      .catch((e) => { WORLD_ERR = e; WORLD_P = null; throw e; });
  }
  return WORLD_P;
}

/** Tests / tools: inject parsed world + era files without fetch. */
export function setWorldData(world, worldEras = null) {
  WORLD = world || null;
  PROJ = world ? projectWorld(world) : null;
  ERAS = world ? compileWorldEras(worldEras, world.countries) : null;
  WORLD_P = null;
}
/** Screen position of lon/lat in the live map of size W×H (tools/screenshots; same maths as the renderer). */
export function screenOf(lon, lat, W, H) {
  const s = (H / (Y_BOT - Y_TOP)) * V.k;
  const [x, y] = project(lon, lat);
  return [(x - (V.cx ?? 0)) * s + W / 2, (y - (V.cy ?? 0)) * s + H / 2];
}
/** Compiled era data in use (null until loaded). */
export const worldEras = () => ERAS;

function loadEmblems() {
  if (EMBLEM || EMBLEM_P) return EMBLEM_P || Promise.resolve(EMBLEM);
  EMBLEM_P = import('./emblem.js').then((m) => { EMBLEM = m; return m; }).catch(() => null);
  return EMBLEM_P;
}

/** Emblem image of an actor for the HQ pills (null until ready / when emblem.js is absent). */
function emblemImage(actor, onReady) {
  if (!EMBLEM || !actor) return null;
  const key = `${actor.id}|${JSON.stringify(actor.emblem || '')}`;
  if (EMBLEM_IMG.has(key)) { const im = EMBLEM_IMG.get(key); return im?.complete && im.naturalWidth ? im : null; }
  let svg = null;
  try { svg = EMBLEM.actorEmblemSVG ? EMBLEM.actorEmblemSVG(actor, { size: 40 }) : EMBLEM.emblemSVG?.(actor.emblem || EMBLEM.specForActor?.(actor), { size: 40 }); } catch { svg = null; }
  if (!svg || typeof Image === 'undefined') { EMBLEM_IMG.set(key, null); return null; }
  if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  const im = new Image();
  im.onload = () => onReady?.();
  im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  EMBLEM_IMG.set(key, im);
  return null;
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

const BLOC_KINDS = new Set(['bloc_join', 'bloc_leave']);
/** Timeline event about a bloc change (country signing/leaving or an agency switching). Pure: exported for tests. */
export const isBlocEvent = (e) => !!e && BLOC_KINDS.has(e.kind);
const BLOC_ICON = { bloc_join: '🏳️', bloc_leave: '🏳️' };
// fallback only: the game data (geopolitics.blocDynamics.blocForms) wins, so labels match the sim's own timeline text
const BLOC_NAME = { artemis: { name: 'Acordos Artemis', art: 'os' }, ilrs: { name: 'ILRS', art: 'o' } };
const A_CONTRACT = { o: 'ao', a: 'à', os: 'aos', as: 'às' };
const blocFormsOf = (store) => store?.data?.geopolitics?.blocDynamics?.blocForms || null;

/**
 * Countries a bloc event is about: the country itself, or the countries of the agency that switched.
 * Pure: exported for tests.
 */
export function blocEventIsos(e, actorCountries = {}) {
  if (!isBlocEvent(e)) return [];
  if (e.iso) return [e.iso];
  return e.actorId ? (actorCountries?.[e.actorId] || []).slice() : [];
}

/**
 * pt-BR label of a bloc event ("Brasil adere ao ILRS", "Índia deixa os Acordos Artemis"). The sim already writes
 * `text`; this is the fallback for records without it. Pure: exported for tests.
 */
export function blocEventLabel(e, who = '', forms = null) {
  if (!isBlocEvent(e)) return e?.text || '';
  if (e.text) return e.text;
  const b = forms?.[e.bloc] || BLOC_NAME[e.bloc] || { name: e.bloc || 'bloco', art: null };
  const name = who || e.iso || e.actorId || 'País';
  if (e.kind === 'bloc_join') return `${name} adere ${b.art ? `${A_CONTRACT[b.art]} ${b.name}` : `a ${b.name}`}`;
  return `${name} deixa ${b.art ? `${b.art} ${b.name}` : b.name}`;
}

/**
 * Country -> bloc key at turn T rebuilt from today's map plus the dated country records of geo.blocChanges
 * (undo every change after T, newest first). Pure: exported for tests.
 */
export function countryBlocsAt(today, blocChanges, T) {
  const out = { ...(today || {}) };
  const later = (blocChanges || []).filter((c) => c?.kind === 'country' && c.iso && c.turn > T);
  for (let i = later.length - 1; i >= 0; i--) out[later[i].iso] = later[i].from || 'neutral';
  return out;
}

// ------------------------------------------------------------------ eras (data/world-eras.json): pure, exported for tests

/** "1955" → 1955, "1955-05" → 1955 + 4/12 (start of that month). */
export function parseWhen(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const m = /^(\d{3,4})(?:-(\d{1,2}))?$/.exec(String(v).trim());
  if (!m) return null;
  return Number(m[1]) + (m[2] ? (Number(m[2]) - 1) / 12 : 0);
}
/** End bound, exclusive: "1991-12" → 1992 (through dec/1991), "1991" → 1992. */
export function parseUntil(v) {
  if (v == null || v === '') return Infinity;
  if (typeof v === 'number') return v + 1;
  const m = /^(\d{3,4})(?:-(\d{1,2}))?$/.exec(String(v).trim());
  if (!m) return Infinity;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 1);
}
/** Member token → {iso|macro, from, to, exclude}: "DEU@1955-05", "RUS@1922..1991-12", "#Africa@2090", "!RUS". */
export function parseMember(tok) {
  const t = String(tok || '').trim();
  const exclude = t.startsWith('!');
  const body = exclude ? t.slice(1) : t;
  const [who, when = ''] = body.split('@');
  const [a, b] = when.includes('..') ? when.split('..') : [when, ''];
  const out = { from: parseWhen(a) ?? -Infinity, to: b ? parseUntil(b) : Infinity, exclude };
  if (who.startsWith('#')) out.macro = who.slice(1); else out.iso = who;
  return out;
}
const inSpan = (T, from, to) => T >= from && T < to;

/** Compile world-eras.json against the countries of world.json (continent macros). Pure. */
export function compileWorldEras(we, countries = []) {
  if (!we) return null;
  const byCont = {};
  for (const c of countries || []) (byCont[c.continent] ||= []).push(c.id);
  const blocs = (we.blocs || []).map((b) => {
    const ranges = {}; // iso -> [[from, to]]
    const excl = new Set();
    for (const tok of b.members || []) {
      const m = parseMember(tok);
      if (m.exclude) { excl.add(m.iso); continue; }
      for (const iso of m.macro ? byCont[m.macro] || [] : [m.iso]) (ranges[iso] ||= []).push([m.from, m.to]);
    }
    for (const iso of excl) delete ranges[iso];
    // bloc-level bounds cap every member (NATO's open-ended members stop where the sim's blocs take over)
    const bf = parseWhen(b.from) ?? -Infinity, bt = parseUntil(b.to);
    for (const rs of Object.values(ranges)) for (const r of rs) { r[0] = Math.max(r[0], bf); r[1] = Math.min(r[1], bt); }
    return { id: b.id, name: b.name, nameBefore: b.nameBefore ? { until: parseWhen(b.nameBefore.until) + 1 / 12, name: b.nameBefore.name } : null,
      fill: b.fill || '#384360', pattern: b.pattern || null, merge: !!b.merge, ranges };
  });
  const span = (x) => [parseWhen(x.from) ?? -Infinity, parseUntil(x.to)];
  return {
    periods: (we.periods || []).map((p) => ({ ...p, span: span(p) })),
    blocs,
    unions: (we.unions || []).map((u) => ({ ...u, span: span(u) })),
    splits: (we.splits || []).map((x) => ({ ...x, span: span(x) })),
    colonies: (we.colonies || []).map((c) => ({ ...c, span: [parseWhen(c.from) ?? -Infinity, parseUntil(c.to)] })),
    rulers: we.rulers || {},
    milestones: (we.milestones || []).map((m) => ({ ...m, T: parseWhen(m.at) })).filter((m) => m.T != null).sort((a, b) => a.T - b.T),
    simplifications: we.simplifications || [],
    source: we.source || '',
  };
}

/**
 * The world at fractional year T: period, bloc of every country (first matching bloc in list order), unions active
 * (iso -> union), colonies (iso -> {ruler, adj, until}), splits (iso -> split) and the last milestone. Pure.
 */
export function worldEraAt(cw, T) {
  if (!cw) return null;
  const period = cw.periods.find((p) => inSpan(T, ...p.span)) || cw.periods[cw.periods.length - 1] || { id: 'hoje', name: '' };
  const union = {};
  const unions = [];
  for (const u of cw.unions) {
    if (!inSpan(T, ...u.span)) continue;
    unions.push(u);
    for (const iso of u.members || []) if (!union[iso]) union[iso] = u;
  }
  const colony = {};
  for (const c of cw.colonies) {
    if (!inSpan(T, ...c.span)) continue;
    const r = cw.rulers[c.ruler] || { name: c.ruler, adj: '' };
    colony[c.iso] = { ruler: c.ruler, rulerName: r.name, adj: r.adj, until: c.span[1] };
  }
  const split = {};
  for (const x of cw.splits) if (inSpan(T, ...x.span)) split[x.iso] = x;
  const bloc = {};
  const blocs = {};
  for (const b of cw.blocs) {
    let any = false;
    for (const [iso, rs] of Object.entries(b.ranges)) {
      if (bloc[iso] || !rs.some(([f, t]) => inSpan(T, f, t))) continue;
      bloc[iso] = b.id;
      any = true;
    }
    if (any) blocs[b.id] = { id: b.id, name: b.nameBefore && T < b.nameBefore.until ? b.nameBefore.name : b.name, fill: b.fill, pattern: b.pattern, merge: b.merge };
  }
  // split halves count for their bloc too (the RDA keeps the Pacto de Varsóvia in the legend)
  for (const x of Object.values(split)) {
    const b = cw.blocs.find((k) => k.id === x.bloc);
    if (b && !blocs[b.id]) blocs[b.id] = { id: b.id, name: b.nameBefore && T < b.nameBefore.until ? b.nameBefore.name : b.name, fill: b.fill, pattern: b.pattern, merge: b.merge };
  }
  let milestone = null;
  for (const m of cw.milestones) if (m.T <= T) milestone = m;
  return { T, period, sim: !!period.sim, speculative: !!period.speculative, bloc, blocs, union, unions, colony, split, milestone };
}

/** Lead country whose colour/bloc a country shows at this time (union lead, or itself). Pure. */
export const leadOf = (ev, iso) => ev?.union?.[iso]?.lead || iso;

const NEUTRAL_FILL = '#384360';
/**
 * Fill of a country at a time: colony (metropole's bloc colour, hatched), its bloc (historic/speculative), or the
 * sim's bloc (2020–2079 and whenever world-eras.json is missing). {key, fill, pattern, bloc, name, merge, colony}.
 */
export function styleIn(ev, geo, iso) {
  const L = leadOf(ev, iso);
  if (ev && !ev.sim) {
    const col = ev.colony[L];
    if (col) {
      const rb = ev.bloc[col.ruler];
      const b = rb ? ev.blocs[rb] : null;
      return { key: `col:${col.ruler}`, fill: b?.fill || '#5b6378', pattern: 'colony', bloc: rb || null, name: `Colônia ${col.adj}`.trim(), merge: false, colony: col };
    }
    const id = ev.bloc[L];
    const b = id ? ev.blocs[id] : null;
    return b ? { key: id, fill: b.fill, pattern: b.pattern, bloc: id, name: b.name, merge: !!b.merge, colony: null }
      : { key: 'neutral', fill: NEUTRAL_FILL, pattern: null, bloc: null, name: 'Sem bloco', merge: false, colony: null };
  }
  const k = geo?.countryBloc?.[L] || 'neutral';
  const bs = BLOC_STYLE[k] || BLOC_STYLE.neutral;
  return { key: k, fill: bs.fill, pattern: bs.pattern, bloc: k, name: geo?.blocLabels?.[k] || (k === 'neutral' ? 'Sem bloco' : k), merge: false, colony: null };
}

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
    grid: mk((g, s) => { g.strokeStyle = 'rgba(255,255,255,.24)'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, s - 1, s - 1); }, 6),
    rings: mk((g) => { g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1; g.beginPath(); g.arc(4, 4, 2.2, 0, 7); g.stroke(); }),
    dash: mk((g, s) => { g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(1, 2); g.lineTo(4, 2); g.moveTo(5, 6); g.lineTo(8, 6); g.stroke(); }),
    // colonies: dense dark diagonals over the metropole's colour (reads "under foreign rule" without a new hue)
    colony: mk((g, s) => { g.strokeStyle = 'rgba(8,12,24,.7)'; g.lineWidth = 1.4; g.beginPath(); for (let i = -s; i <= s; i += 3) { g.moveTo(i, s); g.lineTo(i + s, 0); } g.stroke(); }, 6),
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
  // scrubbing back: geo/state(T) already colors by the bloc of that turn; the country records of blocChanges are
  // replayed on top (same result, and old saves whose query is not dated still show the past), and countries whose
  // bloc at T differs from today's get a dashed outline in today's color
  const geoNow = geo.isPast ? store.tryQuery('geo/state', null) : geo;
  // the era of the date being viewed (world-eras.json): historical blocs and borders, or the sim's own blocs
  const sy = st.startYear ?? 2026;
  const yearAt = (t) => sy + t / 52;
  const ev = ERAS ? worldEraAt(ERAS, yearAt(T)) : null;
  const evNow = ERAS ? (geo.isPast ? worldEraAt(ERAS, yearAt(now)) : ev) : null;
  const historic = !!ev && !ev.sim;
  V.historic = historic;
  const styleT = (iso) => styleIn(ev, geo, iso);
  const styleNow = (iso) => styleIn(evNow, geoNow || geo, iso);
  const blocDiff = new Map();
  if (geo.isPast && geoNow) {
    // geo/state(T) is already dated (and also applies agency switches, which a country-record replay would undo):
    // countryBlocsAt is kept as a pure helper only, never applied on top of it
    for (const c of PROJ) {
      const a = styleT(c.id), b = styleNow(c.id);
      if (a.key !== b.key) blocDiff.set(c.id, b);
    }
  }
  /** Countries drawn as one shape (URSS, Iugoslávia, merged federations): group key or null. */
  const groupOf = (iso) => {
    const u = ev?.union?.[iso];
    if (u) return `u:${u.id}`;
    if (!historic) return null;
    const stl = styleT(iso);
    return stl.merge ? `b:${stl.key}` : null;
  };
  // agencies without a fixed HQ in geopolitics.json (founded by the player, born after 2030) show at their own HQ
  const hqs = geo.hqs.slice();
  for (const [aid, a] of Object.entries(st.actors || {})) {
    if (hqs.some((q) => q.actorId === aid) || !Number.isFinite(a?.hq?.lat) || !Number.isFinite(a?.hq?.lon)) continue;
    if (a.status === 'gone' || a.gone) continue;
    hqs.push({ actorId: aid, lat: a.hq.lat, lon: a.hq.lon, city: a.hq.city || a.hq.name || '', short: a.short || a.name, flag: a.flag || '', kind: a.kind, isPlayer: aid === st.playerId, color: a.color || null });
  }
  loadEmblems().then((m) => { if (m && alive) draw(); });
  geo.hqsAll = hqs;
  // the bloc changes of the week being viewed (and the one focused from the timeline) are highlighted
  const blocHl = new Set(V.hl || []);
  for (const e of hist.events || []) if (isBlocEvent(e) && e.turn === T) for (const iso of blocEventIsos(e, geo.actorCountries)) blocHl.add(iso);

  const canvas = h('canvas', { class: 'wm-canvas', role: 'img', 'aria-label': 'Mapa-múndi com blocos, sedes, bases de lançamento, tensões e zonas disputadas. Toque num país para detalhes.' });
  const card = h('div', { class: 'wm-card', hidden: true });
  const legend = h('div', { class: 'wm-legend', hidden: !V.legend }, legendContent(geo, ev));
  // always-on chip: the date being viewed and its era (a speculative era says so)
  const past = h('div', { class: ['wm-past', 'wm-era', geo.isPast && 'is-past', ev?.speculative && 'is-spec'] },
    h('span', { class: 'wm-era-when' }, geo.isPast ? `Vendo ${fmtMonth(T, st.startYear)}` : fmtMonth(T, st.startYear)),
    ev?.period?.name ? h('span', { class: 'wm-era-name' }, ` · ${ev.period.name}`) : null,
    ev?.speculative ? h('span', { class: 'wm-era-tag' }, 'especulativo') : null,
    geo.isPast ? h('button', { class: 'wm-link', type: 'button', onclick: () => { V.turn = null; rerender(); } }, 'voltar a hoje') : null);
  const tools = h('div', { class: 'wm-tools' },
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Aproximar', onclick: () => zoomBy(1.6), html: iconSVG('mais', 20) }),
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Afastar', onclick: () => zoomBy(1 / 1.6), html: iconSVG('menos', 20) }),
    h('button', { class: 'wm-btn', type: 'button', 'aria-label': 'Centralizar na sua agência', onclick: () => { V.k = 1; centerOnHq(); layout(); draw(); }, html: iconSVG('alvo', 20) }),
    h('button', { class: ['wm-btn', V.legend && 'on'], type: 'button', 'aria-label': 'Legenda', 'aria-expanded': String(V.legend), onclick: (e) => { V.legend = !V.legend; legend.hidden = !V.legend; e.currentTarget.classList.toggle('on', V.legend); e.currentTarget.setAttribute('aria-expanded', String(V.legend)); }, html: iconSVG('info', 20) }));
  const stage = h('div', { class: 'wm-stage' }, canvas, tools, past, legend, card);
  root.append(stage, timeline(store, geo, hist, T, (t) => { V.turn = t >= now ? null : t; rerender(); }, (e) => focusEvent(e)));

  /** Center the map on what an event is about (zone, incident area). */
  function focusEvent(e) {
    if (isBlocEvent(e)) return focusCountries(blocEventIsos(e, geo.actorCountries));
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

  /** Frame and highlight the countries of a bloc change; the first one gets its card. */
  function focusCountries(isos) {
    const list = (isos || []).filter((iso) => PROJ.some((c) => c.id === iso));
    if (!list.length || !W) return;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const iso of list) {
      const c = PROJ.find((x) => x.id === iso);
      minx = Math.min(minx, c.bbox[0]); miny = Math.min(miny, c.bbox[1]); maxx = Math.max(maxx, c.bbox[2]); maxy = Math.max(maxy, c.bbox[3]);
    }
    // small countries: zoom in (up to 6x), big ones: fit; the card covers the bottom part of the stage
    const fit = Math.min((W * 0.7) / Math.max(1e-4, (maxx - minx) * s0), (H * 0.45) / Math.max(1e-4, (maxy - miny) * s0));
    V.k = clampN(Math.min(fit, 6), Math.min(V.k, 1.5), 16);
    V.cx = (minx + maxx) / 2;
    V.cy = (miny + maxy) / 2 + (H * 0.15) / (s0 * V.k);
    V.hl = list;
    for (const iso of list) blocHl.add(iso);
    V.sel = { type: 'country', id: list[0] };
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
  let toolsRect = null;
  let eraRect = null; // the date/era chip in the top-left corner
  let hits = [];
  let paths = [];
  let raf = 0;
  let alive = true;
  const animated = () => !reduceMotion() && (geo.tensionLines.some((l) => l.level >= 4) || geo.zones.some((z) => z.status === 'conflict') || geo.conflicts.some((c) => c.area));

  function centerOnHq() {
    const me = hqs.find((q) => q.isPlayer) || hqs[0];
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
      const me = hqs.find((q) => q.isPlayer) || hqs[0];
      let [x, y] = me ? project(me.lon, me.lat) : [0, 0];
      // an active conflict in view from the start when it fits next to the player's HQ (controls column kept clear)
      const c = geo.conflicts.find((k) => k.area) || null;
      const z = !c ? geo.zones.find((k) => k.status === 'conflict' && k.label) : null;
      const at = c?.area || z?.label || null;
      if (at) {
        const [cx, cy] = project(at.lon, at.lat);
        const room = W - 20;
        if (Math.abs(cx - x) * s0 < room && Math.abs(cy - y) * s0 < H - 40) { x = (x + cx) / 2; y = (y + cy) / 2; }
      }
      V.cx = x; V.cy = y;
    }
    clampView();
    // the +/−/⌖/ⓘ row covers the bottom-right corner: labels treat it as an obstacle
    const tr = tools.getBoundingClientRect?.();
    toolsRect = tr && tr.width ? [tr.left - r.left - 4, tr.top - r.top - 4, tr.width + 8, tr.height + 8] : [W - 190, H - 54, 190, 54];
    const er = past.getBoundingClientRect?.();
    eraRect = er && er.width ? [er.left - r.left - 2, er.top - r.top - 2, er.width + 4, er.height + 4] : null;
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

  // static layer (graticule, countries, unions, split halves, era labels) cached per view: the pulse of conflicts
  // and tension lines redraws only the top layer (cheap on phones)
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  let baseKey = '';
  function paintBase(s, ox, oy, fs) {
    const key = `${W}x${H}@${dpr}|${s.toFixed(4)}|${ox.toFixed(1)}|${oy.toFixed(1)}|${fs}`;
    if (key === baseKey && paths.length) return;
    baseKey = key;
    if (base.width !== Math.round(W * dpr) || base.height !== Math.round(H * dpr)) { base.width = Math.round(W * dpr); base.height = Math.round(H * dpr); }
    const g = bctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = historic && ev.speculative ? '#0d1428' : '#0c1730';
    g.fillRect(0, 0, W, H);
    paths = [];
    const llb = (lon, lat) => { const [x, y] = project(lon, lat); return [x * s + ox, y * s + oy]; };

    // graticule
    g.strokeStyle = 'rgba(120,150,200,.10)';
    g.lineWidth = 1;
    g.setLineDash([]);
    for (let lon = -180; lon <= 180; lon += 30) {
      g.beginPath();
      for (let lat = LAT_BOT; lat <= LAT_TOP; lat += 4) { const [x, y] = llb(lon, lat); if (lat === LAT_BOT) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }
    for (let lat = -30; lat <= 60; lat += 30) {
      g.beginPath();
      for (let lon = -180; lon <= 180; lon += 6) { const [x, y] = llb(lon, lat); if (lon === -180) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
    }

    const fillStyled = (p, stl) => {
      g.globalAlpha = stl.colony ? 0.5 : geo.isPast ? 0.75 : 0.9;
      g.fillStyle = stl.fill;
      g.fill(p, 'evenodd');
      g.globalAlpha = 1;
      const pat = stl.pattern && pats[stl.pattern];
      if (pat) { g.fillStyle = pat; g.fill(p, 'evenodd'); }
    };
    // countries (grouped ones are drawn after, as one shape without inner borders)
    const groups = new Map();
    for (const c of PROJ) {
      const [bx0, by0, bx1, by1] = c.bbox;
      const vis = !(bx1 * s + ox < 0 || bx0 * s + ox > W || by1 * s + oy < 0 || by0 * s + oy > H);
      const gk = groupOf(c.id);
      if (!vis && !gk) continue;
      const p = new Path2D();
      for (const poly of c.polys) for (const ring of poly) ringPath(p, ring, s, ox, oy);
      paths.push({ id: c.id, p, bbox: [bx0 * s + ox, by0 * s + oy, bx1 * s + ox, by1 * s + oy], group: gk });
      if (gk) {
        if (!groups.has(gk)) groups.set(gk, { all: new Path2D(), isos: [], stl: styleT(c.id) });
        const G = groups.get(gk);
        G.all.addPath(p);
        G.isos.push(c.id);
        continue;
      }
      fillStyled(p, styleT(c.id));
      g.strokeStyle = 'rgba(8,12,24,.75)';
      g.lineWidth = 0.7;
      g.stroke(p);
    }
    // a union: dark outline first, then the fill on top hides the inner borders (outer edge keeps half the line)
    for (const G of groups.values()) {
      g.strokeStyle = 'rgba(8,12,24,.9)';
      g.lineWidth = 1.8;
      g.stroke(G.all);
      fillStyled(G.all, G.stl);
    }
    // divided countries (two Germanys, two Vietnams): the other half in its own bloc, a dashed line between them
    for (const [iso, x] of Object.entries(ev?.split || {})) {
      const e = paths.find((q) => q.id === iso);
      const b = ERAS?.blocs?.find((k) => k.id === x.bloc);
      if (!e || !b) continue;
      const clip = new Path2D();
      x.clip.forEach(([lon, lat], i) => { const [px, py] = llb(lon, lat); if (i) clip.lineTo(px, py); else clip.moveTo(px, py); });
      clip.closePath();
      g.save();
      g.clip(e.p, 'evenodd');
      g.fillStyle = NEUTRAL_FILL;
      g.fill(clip);
      fillStyled(clip, { fill: b.fill, pattern: b.pattern });
      g.setLineDash([3, 2]);
      g.strokeStyle = 'rgba(236,237,240,.85)';
      g.lineWidth = 1.2;
      g.stroke(clip);
      g.setLineDash([]);
      g.restore();
    }
    // era names: unions (URSS, Iugoslávia…) and merged federations, faint, under every marker
    if (ev) {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const label = (text, lon, lat, size, alpha) => {
        const [x, y] = llb(lon, lat);
        if (x < -60 || x > W + 60 || y < -20 || y > H + 20) return;
        g.font = `600 ${Math.round(size)}px Inter, system-ui, sans-serif`;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(8,12,24,.6)';
        g.strokeText(text, x, y);
        g.fillStyle = `rgba(236,237,240,${alpha})`;
        g.fillText(text, x, y);
      };
      for (const u of ev.unions) {
        if (u.quiet) continue;
        const big = u.id === 'ussr';
        if (!big && V.k < 2.2) continue;
        const lead = PROJ.find((c) => c.id === u.lead);
        const [lon, lat] = u.labelAt || (lead ? [WORLD.countries.find((c) => c.id === u.lead)?.labelLon, WORLD.countries.find((c) => c.id === u.lead)?.labelLat] : [null, null]);
        if (lon == null) continue;
        label(u.name.toUpperCase(), lon, lat, fs * (big ? 0.95 : 0.7), 0.62);
      }
      if (historic && V.k < 2.6) {
        for (const [key, G] of groups) {
          if (!key.startsWith('b:') || G.isos.length < 4) continue;
          const pts = G.isos.map((iso) => WORLD.countries.find((c) => c.id === iso)).filter(Boolean);
          const lon = pts.reduce((a, c) => a + c.labelLon, 0) / pts.length;
          const lat = pts.reduce((a, c) => a + c.labelLat, 0) / pts.length;
          label(G.stl.name.toUpperCase(), lon, lat, fs * 0.72, 0.55);
        }
      }
    }
  }

  function paint(t) {
    const pulse = reduceMotion() ? 0.6 : 0.5 + 0.5 * Math.sin(t / 380);
    const s = scale();
    const ox = W / 2 - V.cx * s;
    const oy = H / 2 - V.cy * s;
    const fs = attempt(() => parseFloat(getComputedStyle(document.documentElement).fontSize), 15) || 15;
    paintBase(s, ox, oy, fs);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hits = [];

    // player's countries and selection on top (a union's member selects the whole union)
    const selGroup = V.sel?.type === 'country' ? paths.find((e) => e.id === V.sel.id)?.group : null;
    for (const e of paths) {
      if (blocDiff.has(e.id)) {
        const k = blocDiff.get(e.id);
        ctx.setLineDash([3, 3]); ctx.strokeStyle = k.key === 'neutral' ? '#c7cede' : k.fill;
        ctx.lineWidth = 1.8; ctx.stroke(e.p); ctx.setLineDash([]);
      }
      if (blocHl.has(e.id)) {
        const k = styleT(e.id);
        ctx.strokeStyle = 'rgba(255,255,255,.92)'; ctx.lineWidth = 4.2 + pulse * 1.2; ctx.stroke(e.p);
        ctx.strokeStyle = k.key === 'neutral' ? '#56d4ff' : k.fill; ctx.lineWidth = 2.2; ctx.stroke(e.p);
      }
      if (playerIsos.has(e.id)) { ctx.strokeStyle = '#e3b341'; ctx.lineWidth = 1.6; ctx.stroke(e.p); }
      if (V.sel?.type === 'country' && (V.sel.id === e.id || (selGroup && selGroup === e.group && selGroup.startsWith('u:')))) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = V.sel.id === e.id ? 2.4 : 1.4; ctx.stroke(e.p); }
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
    const obstacles = [toolsRect, eraRect].filter(Boolean);
    const hqPlace = new Map();
    // the agency's emblem (emblem.js) replaces the flag in the tag once its image is ready
    const hqIcon = (q) => emblemImage({ ...(st.actors?.[q.actorId] || {}), id: q.actorId }, () => { if (alive) draw(); });
    const hqText = (q, icon) => (icon ? q.short : `${flagPrefix(q)}${q.short}`);
    for (const q of hqs) {
      const [x, y] = ll(q.lon, q.lat);
      const dy = q.dy ?? -14;
      const icon = hqIcon(q);
      const opt = { fs: fs * 0.74, bold: q.isPlayer, icon };
      const [w, hh] = pillSize(ctx, hqText(q, icon), opt);
      let px = x, py = y + dy;
      // under the controls row: lift the tag above it so it stays readable
      if (toolsRect && rectsOverlap([px - w / 2, py - hh / 2, w, hh], toolsRect)) py = Math.min(py, toolsRect[1] - hh / 2 - 2);
      // under the date/era chip: drop the tag just below it
      if (eraRect && rectsOverlap([px - w / 2, py - hh / 2, w, hh], eraRect)) py = Math.max(py, eraRect[1] + eraRect[3] + hh / 2 + 2);
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
      // the digit is the tension LEVEL (0-4), not a count: with the word shown it reads as "3 conflito", so the word replaces it
      const txt = word ? `${LINE_ICON[l.level]}${word}` : `${LINE_ICON[l.level]} ${l.level}`;
      const bopt = { fs: fs * 0.72, bold: l.level >= 3 };
      const [bw, bh] = pillSize(ctx, txt, bopt);
      // slide along the line's normal until it clears HQ tags, other badges and the controls
      const [px, py] = placeAway(mx, my, bw, bh, obstacles, { dx: nx, dy: ny });
      const b = pill(ctx, px, py, txt, { ...bopt, bg: 'rgba(12,12,15,.9)', border: ls.color, color: '#ecedf0' });
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
        pill(ctx, x, y, '⏸', { fs: fs * 0.7, bg: 'rgba(12,12,15,.9)', border: '#e8edf7', color: '#fff', pad: 3 });
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

    // HQs: emblem (game-designed, never an official logo) or flag + short name
    for (const q of hqs) {
      const [x, y] = ll(q.lon, q.lat);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = q.isPlayer ? '#e3b341' : '#ecedf0'; ctx.fill();
      ctx.strokeStyle = '#0b1020'; ctx.lineWidth = 1; ctx.stroke();
      const [px, py] = hqPlace.get(q.actorId) || [x, y + (q.dy ?? -14)];
      const icon = hqIcon(q);
      const r = pill(ctx, px, py, hqText(q, icon), { fs: fs * 0.74, bg: 'rgba(12,12,15,.92)', border: q.isPlayer ? '#e3b341' : '#2a2a33', color: '#ecedf0', bold: q.isPlayer, icon });
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
    if (V.hl && !(sel?.type === 'country' && V.hl.includes(sel.id))) { for (const iso of V.hl) blocHl.delete(iso); V.hl = null; }
    V.sel = sel;
    showCard();
    draw();
  }
  function showCard() {
    const content = V.sel ? attempt(() => cardFor(store, geo, byIso, V.sel, opts, geoNow, { ev, evNow }), null) : null;
    if (!content) { card.hidden = true; card.replaceChildren(); return; }
    card.replaceChildren(
      h('button', { class: 'wm-card-close', type: 'button', 'aria-label': 'Fechar', onclick: () => select(null), html: iconSVG('fechar', 16) }),
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
function pillSize(ctx, text, { fs = 11, bold = false, pad = 5, icon = null } = {}) {
  ctx.font = `${bold ? '700 ' : ''}${Math.round(fs)}px Inter, system-ui, "Segoe UI", "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  return [Math.ceil(ctx.measureText(text).width) + pad * 2 + (icon ? Math.round(fs * 1.3) + 3 : 0), Math.round(fs * 1.5)];
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

function pill(ctx, x, y, text, { fs = 11, bg, border, color = '#fff', bold = false, pad = 5, icon = null } = {}) {
  ctx.font = `${bold ? '700 ' : ''}${Math.round(fs)}px Inter, system-ui, "Segoe UI", "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  const iw = icon ? Math.round(fs * 1.3) : 0;
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + pad * 2 + (icon ? iw + 3 : 0);
  const hh = Math.round(fs * 1.5);
  const rx = x - w / 2, ry = y - hh / 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rx, ry, w, hh, hh / 2); else ctx.rect(rx, ry, w, hh);
  ctx.fillStyle = bg; ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1.2; ctx.stroke(); }
  if (icon) { try { ctx.drawImage(icon, rx + pad - 1, y - iw / 2, iw, iw); } catch { /* broken image */ } }
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, icon ? rx + pad + iw + 3 + tw / 2 : x, y + 0.5);
  return [rx, ry, w, hh];
}

// ------------------------------------------------------------------ cards

function cardFor(store, geo, byIso, sel, opts, geoNow = geo, era = {}) {
  const st = store.state;
  if (sel.type === 'country') return countryCard(store, geo, byIso, sel.id, opts, geoNow, era);
  if (sel.type === 'hq') {
    const q = (geo.hqsAll || geo.hqs).find((x) => x.actorId === sel.id);
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
      users.length ? h('div', { class: 'chips' }, users.map((a) => chip(`${flagPrefix(a)}${a.short || a.name}`.trim(), 'muted'))) : h('p', { class: 'tiny muted' }, 'Sem agência do jogo operando aqui.'));
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

const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** Fractional year → "mai/1955". Pure: exported for tests. */
export function fmtFracYear(T) {
  if (!Number.isFinite(T)) return '';
  const y = Math.floor(T + 1e-6);
  const m = Math.min(11, Math.max(0, Math.round((T - y) * 12)));
  return `${MES[m]}/${y}`;
}
/** Swatch for a style: era blocs get an inline colour + pattern class, the sim's blocs keep their classes. */
function swatchFor(stl, small = false) {
  if (BLOC_STYLE[stl.key] && !stl.colony) return h('span', { class: ['wm-swatch', `b-${stl.key}`], 'aria-hidden': 'true' });
  return h('span', { class: ['wm-swatch', stl.pattern && `pat-${stl.pattern}`, small && 'sm'], style: { backgroundColor: stl.fill }, 'aria-hidden': 'true' });
}

/** Chip of the other half of a divided country (RDA, Vietnã do Norte). */
function splitChip(ev, split) {
  const b = split ? ERAS?.blocs?.find((k) => k.id === split.bloc) : null;
  if (!b) return null;
  return h('span', { class: 'chip wm-bloc' }, swatchFor({ key: `split:${b.id}`, fill: b.fill, pattern: b.pattern }), ` ${ev?.blocs?.[b.id]?.name || b.name} · ${split.names[1]}`);
}

function countryCard(store, geo, byIso, iso, opts, geoNow = geo, era = {}) {
  const st = store.state;
  const { ev = null, evNow = null } = era;
  const stl = styleIn(ev, geo, iso);
  const stlNow = styleIn(evNow || ev, geoNow || geo, iso);
  const union = ev?.union?.[iso] && !ev.union[iso].quiet ? ev.union[iso] : null;
  const split = ev?.split?.[iso] || null;
  const colony = stl.colony;
  const eraNotes = [
    colony ? `Colônia ${colony.adj} (${colony.rulerName}) · independência em ${fmtFracYear(colony.until)}` : null,
    union && union.lead === iso && Number.isFinite(union.span[1]) ? `Até ${fmtFracYear(union.span[1] - 1 / 12)}: ${union.name}` : null,
    union && union.lead !== iso ? `Parte ${union.id === 'ussr' ? 'da URSS' : `de ${union.name}`}${Number.isFinite(union.span[1]) ? ` até ${fmtFracYear(union.span[1] - 1 / 12)}` : ''}` : null,
    split ? `Dividido até ${fmtFracYear(split.span[1] - 1 / 12)}. Simplificação: o contorno de hoje com uma linha aproximada entre as duas partes.` : null,
  ].filter(Boolean);
  const bloc = geo.countryBloc[iso] || 'neutral';
  const changes = (st.geo?.blocChanges || []).filter((c) => c.kind === 'country' && c.iso === iso && c.turn <= geo.turn);
  const actors = byIso[iso] || [];
  const zones = geo.zones.filter((z) => z.claimants.includes(iso) || z.controller === iso);
  const mine = (geo.playerCountries || []).includes(iso);
  const sites = (geo.sites || []).filter((x) => x.country === iso);
  return h('div', null,
    h('h3', { class: 'wm-card-title' }, union ? union.name : split ? split.names.join(' e ') : countryName(geo, iso), mine ? h('span', { class: 'tiny wm-mine' }, ' · sua base') : null),
    union || split ? h('p', { class: 'tiny muted' }, `Hoje: ${countryName(geo, iso)}`) : null,
    h('div', { class: 'chips' },
      h('span', { class: ['chip', 'wm-bloc', `b-${stl.key}`] }, swatchFor(stl), ` ${stl.name}`),
      splitChip(ev, split),
      (!ev || ev.sim) && (geo.esaAssociates || []).includes(iso) ? chip('associado à ESA', 'muted') : null),
    eraNotes.length ? h('div', { class: 'wm-era-notes' }, eraNotes.map((t) => h('p', { class: 'tiny' }, t))) : null,
    geo.isPast && stlNow.key !== stl.key ? h('p', { class: 'tiny wm-changed' }, `Hoje: ${stlNow.name}`) : null,
    changes.length ? h('div', { class: 'wm-bloc-hist' }, changes.slice(-3).map((c) => h('div', { class: ['tiny', 'wm-bloc-ev', c.joined ? 'join' : 'leave'] },
      `${BLOC_ICON[c.joined ? 'bloc_join' : 'bloc_leave']} ${fmtMonth(c.turn, st.startYear)}: ${blocEventLabel({ kind: c.joined ? 'bloc_join' : 'bloc_leave', bloc: c.bloc }, countryName(geo, iso), blocFormsOf(store))}`))) : null,
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
  // in a historic/speculative era the country's bloc is the era's (card chip); the sim's lunar blocs show only when set
  const blocName = a.bloc ? st.blocs?.[a.bloc]?.short || st.blocs?.[a.bloc]?.name || a.bloc : V.historic ? null : 'sem bloco';
  return h('div', { class: ['wm-actor', big && 'big'] },
    h('div', { class: 'wm-actor-head' },
      h('strong', null, `${flagPrefix(a)}${big ? a.name : a.short || a.name}`.trim()),
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

function legendContent(geo, ev = null) {
  const row = (sw, text) => h('div', { class: 'wm-leg-row' }, sw, h('span', null, text));
  const sw = (cls) => h('span', { class: `wm-swatch ${cls}`, 'aria-hidden': 'true' });
  const line = (l) => h('span', { class: `wm-leg-line l${l}`, 'aria-hidden': 'true' });
  const historic = ev && !ev.sim;
  const eraBlocs = historic ? Object.values(ev.blocs) : [];
  const anyColony = historic && Object.keys(ev.colony).length > 0;
  const unions = (ev?.unions || []).filter((u) => !u.quiet);
  const splits = Object.values(ev?.split || {});
  return [
    h('div', { class: 'wm-leg-title' }, ev?.period?.name ? `Blocos · ${ev.period.name}${ev.speculative ? ' (especulativo)' : ''}` : 'Blocos'),
    historic
      ? [...eraBlocs.map((b) => row(swatchFor({ key: `era:${b.id}`, fill: b.fill, pattern: b.pattern }), b.name)), row(sw('b-neutral'), 'Sem bloco')]
      : ['artemis', 'ilrs', 'both', 'neutral'].map((b) => row(sw(`b-${b}`), geo.blocLabels[b] || b)),
    anyColony ? row(h('span', { class: 'wm-swatch pat-colony', style: { backgroundColor: '#2f80c4' }, 'aria-hidden': 'true' }), 'colônia: cor da metrópole, hachurada') : null,
    unions.length ? row(h('span', { class: 'wm-leg-ico' }, 'URSS'), `uniões da época sem fronteiras internas (${unions.slice(0, 3).map((u) => u.name).join(', ')}${unions.length > 3 ? '…' : ''})`) : null,
    splits.length ? row(h('span', { class: 'wm-swatch wm-split', 'aria-hidden': 'true' }), `país dividido (${splits.map((x) => x.names[1]).join(', ')})`) : null,
    h('div', { class: 'wm-leg-title' }, 'Tensão entre países dos atores'),
    [1, 2, 3, 4].map((l) => row(line(l), `${LINE_ICON[l]} ${l} · ${TENSION_LABELS[l]}`)),
    row(line(0), 'Sua relação sem tensão'),
    h('div', { class: 'wm-leg-title' }, 'Zonas'),
    row(sw('z-conflict'), '⚔ em conflito (hachurada, pulsa)'),
    row(sw('z-ceasefire'), '⏸ cessar-fogo (tracejada)'),
    row(sw('z-contested'), '◈ disputada (pontilhada)'),
    row(sw('z-changed'), 'mudou de controle (contorno azul)'),
    h('div', { class: 'wm-leg-title' }, 'Mudanças de bloco'),
    row(h('span', { class: 'wm-leg-ico' }, h('span', { class: 'wm-bloc-mark join b-ilrs', 'aria-hidden': 'true' })), 'adesão (losango cheio na linha do tempo)'),
    row(h('span', { class: 'wm-leg-ico' }, h('span', { class: 'wm-bloc-mark leave b-artemis', 'aria-hidden': 'true' })), 'saída (losango vazado)'),
    row(sw('bloc-diff'), 'no passado: bloco diferente do de hoje (tracejado na cor de hoje)'),
    h('div', { class: 'wm-leg-title' }, 'Marcadores'),
    row(h('span', { class: 'wm-leg-ico' }, '🇺🇸 NASA'), 'sede de agência (bandeira + sigla)'),
    row(h('span', { class: 'wm-leg-ico' }, '▲'), 'base de lançamento'),
    historic && ERAS?.simplifications?.length ? h('p', { class: 'tiny muted' }, ERAS.simplifications.join(' ')) : null,
    h('p', { class: 'tiny muted' }, historic ? ERAS.source : `Situação inicial de referência: ${geo.asOf || 'nov/2026'}. ${geo.source || ''}`),
  ];
}

function timeline(store, geo, hist, T, onScrub, onFocus) {
  const st = store.state;
  const now = st.turn;
  // the sim's own timeline plus the era milestones of world-eras.json inside the campaign so far
  const sy = st.startYear ?? 2026;
  const eraEvs = (ERAS?.milestones || []).map((m) => ({ turn: Math.round((m.T - sy) * 52), kind: 'era', text: m.text }))
    .filter((e) => e.turn > 0 && e.turn <= now);
  const evs = [...(hist.events || []).filter((e) => e.turn >= 0 && e.turn <= now), ...eraEvs].sort((a, b) => a.turn - b.turn);
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
  const who = (e) => (e.iso ? countryName(geo, e.iso) : e.actorId ? st.actors?.[e.actorId]?.short || st.actors?.[e.actorId]?.name || e.actorId : '');
  const evText = (e) => (isBlocEvent(e) ? blocEventLabel(e, who(e), blocFormsOf(store)) : e.text);
  // bloc changes: a diamond in the bloc's color above the track (filled = joined, hollow = left)
  const ticks = h('div', { class: 'wm-ticks', 'aria-hidden': 'true' }, evs.map((e) => h('span', {
    class: isBlocEvent(e)
      ? ['wm-tick', 'wm-bloc-mark', `k-${e.kind}`, e.kind === 'bloc_join' ? 'join' : 'leave', `b-${e.bloc || 'neutral'}`, e.turn === T && T < now && 'cur']
      : ['wm-tick', `k-${e.kind}`],
    style: { left: `${(e.turn / max) * 100}%` }, title: evText(e),
  })));
  const canFocus = (e) => (isBlocEvent(e) ? blocEventIsos(e, geo.actorCountries).length > 0 : !!(e.zoneIds?.length || e.zoneId || e.conflictId));
  const label = h('span', { class: 'wm-when' }, T >= now ? `Hoje · ${fmtMonth(now, st.startYear)}` : fmtMonth(T, st.startYear));
  const ends = now > 52 ? h('div', { class: 'wm-tl-ends', 'aria-hidden': 'true' }, h('span', null, String(sy)), h('span', null, String(sy + Math.floor(now / 52)))) : null;
  return h('div', { class: 'wm-timeline' },
    h('div', { class: 'wm-tl-row' },
      h('button', { class: 'wm-btn small', type: 'button', 'aria-label': 'Evento anterior', disabled: !prev, onclick: () => prev && onScrub(prev.turn), html: iconSVG('voltar', 18) }),
      h('div', { class: 'wm-track' }, ticks, range),
      h('button', { class: 'wm-btn small', type: 'button', 'aria-label': 'Próximo evento', disabled: !next && T >= now, onclick: () => onScrub(next ? next.turn : now), html: iconSVG('avancar', 18) })),
    ends,
    h('div', { class: 'wm-tl-caption' }, label,
      at ? h('span', { class: ['tiny', 'wm-ev', isBlocEvent(at) && 'wm-ev-bloc'] }, ' · ',
        isBlocEvent(at) ? h('span', { class: ['wm-bloc-mark', 'inline', at.kind === 'bloc_join' ? 'join' : 'leave', `b-${at.bloc || 'neutral'}`], 'aria-hidden': 'true' }) : null,
        `${fmtMonth(at.turn, st.startYear)}: ${evText(at)} `,
        canFocus(at) ? h('button', { class: 'wm-link', type: 'button', onclick: () => onFocus?.(at) }, 'ver no mapa') : null) : h('span', { class: 'tiny muted' }, evs.length ? '' : ' · Nenhuma mudança no mapa desde o início da campanha.')));
}

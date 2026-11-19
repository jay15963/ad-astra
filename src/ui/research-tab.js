// Pesquisa: árvore de tecnologia 1950–3000 (docs/MISSIONS-V2.md §6). Uma era por vez: a barra de eras escolhe qual,
// e o grafo mostra só os nós daquela era (≤ ~100 peças), com os pré-requisitos de outras eras como "tocos" no topo
// da coluna do ramo. Nós de liberação (foguetes, naves, satélites, sondas, rovers, módulos, tipos de missão, peças)
// são peças grandes com faixa e selo na cor do tipo; nós de eficiência são peças compactas com o efeito em mono.
// No celular em retrato os níveis (profundidade de pré-requisitos) descem de cima para baixo e cada ramo é um
// grupo de colunas; os grupos quebram em linhas (pickLayout escolhe quantos por linha). Arrastar = mover,
// pinça/roda = zoom (só `transform` no "mundo"; nada é re-renderizado durante o gesto). Toque num nó destaca a
// cadeia e abre a folha com abordagens Segura/Ousada e, nos nós de liberação, o bloco "Libera".
// Ferramentas: Buscar (nome, rótulo do que libera, itens do catálogo), Legenda (tipos e estados), Só liberações,
// Grafo/Lista (lista por ramo, alternativa acessível em 320x640). Rota direta: #pesquisa/n/<id>.
// Layout, cadeia, busca e recorte por era são funções puras exportadas (tests/techtree.test.mjs).
import {
  h, card, chip, bar, button, emptyState, safePanel, openModal, toast, countUp, attempt, reduceMotion,
  fmtEffect, fmtNum, fmtIn, fmtMoney, icon, iconSVG, viewHead, flagPrefix, ICONS,
} from './components.js';
import { eraIdOf, nodeKind as nodeKindOf, nodeKeys, keyKind, kindsOf, UNLOCK_KINDS, KIND_ORDER } from '../core/gating.js';

const BRANCH_STYLE = {
  propulsion: { icon: '🔥', color: '#ff7a45' },
  structures: { icon: '🧱', color: '#cdbf9f' },
  life_support: { icon: '🫁', color: '#5fd08f' },
  computing: { icon: '🖥️', color: '#b48cff' },
  energy: { icon: '⚡', color: '#f2c94c' },
  science: { icon: '🔭', color: '#4fb3d9' },
};
const STATE_LABELS = { locked: 'Travado', available: 'Disponível', active: 'Em pesquisa', done: 'Concluído', secret: 'Secreto' };
const STATE_KIND = { locked: 'muted', available: 'accent', active: 'info', done: 'good', secret: 'muted' };
// state marks as stroke icons / plain shapes (DESIGN §2: no emoji in labels)
const ACTIVE_MARK = '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5H12z" fill="currentColor" stroke="none"/></svg>';
function markHTML(s) {
  if (s === 'done') return iconSVG('check', 12);
  if (s === 'locked') return iconSVG('cadeado', 12);
  if (s === 'active') return ACTIVE_MARK;
  if (s === 'available') return '<i class="tt-pip"></i>';
  if (s === 'secret') return '?';
  return '';
}
const markOf = (s, cls = '') => h('span', { class: `tt-mark ${cls}`.trim(), 'aria-hidden': 'true', html: markHTML(s) });

// tool glyphs this screen needs that the shared set may not have yet (same 24-grid stroke style, DESIGN §2)
const LOCAL_ICONS = {
  busca: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  lista: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.5" r="1" fill="currentColor" stroke="none"/>',
  grafo: '<rect x="3.5" y="3.5" width="6" height="5" rx="1.2"/><rect x="14.5" y="3.5" width="6" height="5" rx="1.2"/><rect x="9" y="15.5" width="6" height="5" rx="1.2"/><path d="M6.5 8.5v3.5h11V8.5M12 12v3.5"/>',
  legenda: '<rect x="3.5" y="4" width="5" height="5" rx="1"/><rect x="3.5" y="15" width="5" height="5" rx="1"/><path d="M11.5 6.5h9M11.5 17.5h9"/>',
  filtro: '<path d="M4 5h16l-6.2 7.6V19l-3.6-1.8v-4.6z"/>',
};
/**
 * Inline style string (custom properties included: h() assigns style objects with Object.assign, which drops
 * `--x` keys). {left: '4px', '--uk': '#fff'} → "left:4px;--uk:#fff".
 */
export function css(obj) {
  return Object.entries(obj || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`).join(';');
}

/** Stroke icon from the shared set, else the local one, else nothing (never a broken glyph). */
function glyph(name, size = 16, cls = '') {
  const path = ICONS?.[name] || LOCAL_ICONS[name] || '';
  return h('span', { class: ['ic-wrap', cls], 'aria-hidden': 'true', html: `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>` });
}

/** Geometry of the graph, in world px (scaled by the pan/zoom transform). */
export const GEOM = { tile: 80, colW: 124, rowH: 96, bandPadT: 28, bandPadB: 10, padL: 14, padT: 6, padR: 22, padB: 10 };

/** Tile sizes per kind (MISSIONS-V2 §6.1): unlock nodes 80 px, efficiency nodes 60 px, cross-era stubs 56 px chips. */
export const TILE = Object.freeze({ unlock: { w: 80, h: 80 }, efficiency: { w: 60, h: 60 }, stub: { w: 56, h: 40 } });
/** Tile size of a (decorated) node. */
export function tileOf(n) {
  if (n?.stub) return TILE.stub;
  return (n?.kind || nodeKindOf(n)) === 'unlock' ? TILE.unlock : TILE.efficiency;
}
/** At most this many tiles at a time (one era, §6.2). */
export const MAX_TILES = 100;

// view state survives the tab's re-render on every store change (and tab switches during the session)
const ui = {
  view: null, selected: null, ctl: null,
  era: null, mode: 'graph', onlyUnlocks: false, nextOpen: null, routeDone: null, mount: null, migratedSeen: false,
};

// ------------------------------------------------------------------ data (pure)

const KIND_COLORS = Object.fromEntries(KIND_ORDER.map((k) => [k, UNLOCK_KINDS[k].color]));

/** Adds the derived fields the UI needs when the sim view is not there (kind, unlockKind, unlocks, eraId). */
function decorate(n) {
  const keys = nodeKeys(n);
  const out = { ...n };
  out.kind ??= keys.length ? 'unlock' : 'efficiency';
  if (out.unlockKind === undefined) out.unlockKind = keys.length ? keyKind(keys[0]) : null;
  if (!Array.isArray(out.unlocks) || out.unlocks.some((u) => typeof u === 'string' || !u?.kind)) {
    out.unlocks = (n.unlocks || []).map((u) => {
      const key = typeof u === 'string' ? u : u?.key;
      return key ? { key, kind: keyKind(key), kindLabel: UNLOCK_KINDS[keyKind(key)]?.label || keyKind(key), label: u?.label || key } : null;
    }).filter(Boolean);
  }
  out.eraId ??= eraIdOf(n);
  if (out.row == null && Number.isInteger(n.lane)) out.row = n.lane;
  return out;
}

/**
 * Every tech node with a UI state: research/tree view merged over data/tech.json (layout fields: icon, short,
 * tier, row). Secret nodes the sim does not list yet come back as {state: 'secret', hidden: true}.
 */
export function treeNodes(store) {
  const dataNodes = store.data?.tech?.nodes || [];
  const q = store.tryQuery ? store.tryQuery('research/tree', null) : null;
  const list = Array.isArray(q) ? q : Array.isArray(q?.nodes) ? q.nodes : null;
  const st = store.state || {};
  const r = st.research || {};
  if (list) {
    const views = Object.fromEntries(list.map((v) => [v.id, v]));
    const out = dataNodes.map((n) => {
      const v = views[n.id];
      if (v) return decorate({ ...n, ...v, unlocks: v.unlocks ?? n.unlocks, icon: n.icon, short: n.short, tier: n.tier, row: n.row, state: v.state || v.status || 'locked' });
      return decorate(n.secret ? { ...n, state: 'secret', hidden: true } : { ...n, state: 'locked' });
    });
    // nodes only the sim knows (should not happen, but never drop them)
    for (const v of list) if (!dataNodes.some((n) => n.id === v.id)) out.push(decorate({ ...v, state: v.state || v.status || 'locked' }));
    return out;
  }
  const unlocked = new Set(r.unlocked || []);
  const revealed = new Set(r.revealed || []);
  const active = Object.fromEntries((r.projects || []).map((p) => [p.nodeId, p]));
  return dataNodes.map((n) => {
    const p = active[n.id];
    if (n.secret && !unlocked.has(n.id) && !revealed.has(n.id) && !p && !st.events?.flags?.[n.unlockedBy]) return decorate({ ...n, state: 'secret', hidden: true });
    let state = 'locked';
    if (p) state = 'active';
    else if (unlocked.has(n.id)) state = 'done';
    else if ((n.requires || []).every((x) => unlocked.has(x))) state = 'available';
    const rivalsWith = Object.entries(r.rivals || {}).filter(([, l]) => Array.isArray(l) && l.includes(n.id)).map(([id]) => id);
    return decorate({ ...n, state, progress: p ? p.progress : state === 'done' ? 1 : 0, approach: p?.approach, projectCost: p?.cost, rivalsWith });
  });
}
/** Kept for older callers. */
export const researchNodes = treeNodes;

/** Era id of a (decorated or raw) node. */
export const eraOf = (n) => n?.eraId || eraIdOf(n);

/**
 * One era's subgraph (MISSIONS-V2 §6.1): the nodes of `eraId` plus a stub per (prerequisite of another era, branch),
 * placed at the top of that branch's column. `onlyUnlocks` keeps unlock nodes only; their requires then point to the
 * nearest kept ancestors (in-era chains through hidden efficiency nodes stay connected, other eras become stubs).
 * Stub: {id: '@<target>@<branch>', stub: true, target, eraId, name, short, branch, state, requires: []}.
 */
export function eraGraph(nodes, eraId, { onlyUnlocks = false } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inEra = nodes.filter((n) => eraOf(n) === eraId);
  const keep = new Set(inEra.filter((n) => !onlyUnlocks || n.kind === 'unlock' || nodeKindOf(n) === 'unlock').map((n) => n.id));
  const stubs = new Map();
  const out = [];
  const stubFor = (target, branch) => {
    const id = `@${target.id}@${branch}`;
    if (!stubs.has(id)) {
      stubs.set(id, {
        id, stub: true, target: target.id, eraId: eraOf(target), name: target.hidden ? 'Tecnologia secreta' : target.name || target.id,
        short: target.hidden ? '???' : target.short || target.name || target.id, branch, state: target.state || 'locked', requires: [],
        kind: 'stub', hidden: !!target.hidden,
      });
    }
    return id;
  };
  for (const n of inEra) {
    if (!keep.has(n.id)) continue;
    const req = new Set();
    const seen = new Set();
    const stack = [...(n.requires || [])];
    while (stack.length) {
      const r = stack.pop();
      if (seen.has(r)) continue;
      seen.add(r);
      const p = byId.get(r);
      if (!p) continue;
      if (eraOf(p) !== eraId) req.add(stubFor(p, n.branch));
      else if (keep.has(r)) req.add(r);
      else stack.push(...(p.requires || []));
    }
    out.push({ ...n, requires: [...req] });
  }
  return [...stubs.values(), ...out];
}

/** Accent/case-insensitive text ("Órbita" → "orbita"). */
export const normText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Search (MISSIONS-V2 §6.1): over name, short, unlock labels and `targetNames` (catalog items a node's keys unlock).
 * Returns ≤ max nodes, best first: name starts with the query, then a word starts with it, then contains it; ties
 * keep era/data order. Hidden secret nodes never match. Pure (tested).
 */
export function searchNodes(nodes, q, max = 20) {
  const needle = normText(q).trim();
  if (needle.length < 2) return [];
  const words = needle.split(/\s+/).filter(Boolean);
  const scored = [];
  nodes.forEach((n, i) => {
    if (n.hidden || n.stub) return;
    const name = normText(n.name);
    const hay = n._search ?? (n._search = normText([n.name, n.short, ...(n.unlocks || []).map((u) => u.label), ...(n.targetNames || [])].filter(Boolean).join(' · ')));
    if (!words.every((w) => hay.includes(w))) return;
    let score = 3;
    if (name.startsWith(needle)) score = 0;
    else if (name.split(/[\s\-–/()]+/).some((w) => w.startsWith(words[0]))) score = 1;
    else if (name.includes(needle)) score = 2;
    scored.push({ n, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).slice(0, max).map((x) => x.n);
}

/** Effect labels: data/tech.json's plus the Missões v2 keys of data/core/techtree.json. */
const effectLabelsOf = (data) => ({ ...(data?.tech?.effectLabels || {}), ...(data?.techtree?.effectLabels || {}) });

/** Short mono effect chip of an efficiency tile ("−3% lanç."), from the node's first effect. */
const EFFECT_SHORT = {
  launchCost: 'lanç.', reliability: 'conf.', payload: 'carga', chanceBand: 'prev.', commandPoints: 'cmd.', sciencePerMission: 'ciên.',
  landingReliability: 'pouso', crewSafety: 'trip.', delayReduction: 'atraso', sciencePerWeek: 'ciên./sem', researchSlots: 'proj.',
  crewMorale: 'moral', injuryReduction: 'lesão', lifetime: 'vida', maintenance: 'manut.', stationScience: 'estação', baseScience: 'base',
  roverScience: 'rover', observatoryScience: 'obs.', satRevenue: 'receita', dockingReliability: 'acopl.', moduleMass: 'massa',
  isru: 'ISRU', transitTime: 'trânsito', devTime: 'desenv.', production: 'prod.', marketInterest: 'mercado',
};
const PP_KEYS = new Set(['reliability', 'landingReliability', 'crewSafety', 'dockingReliability']);
const INT_KEYS = new Set(['commandPoints', 'researchSlots']);
export function effectShort(effects = {}, labels = {}) {
  const e = Object.entries(effects || {}).find(([, v]) => typeof v === 'number' && v !== 0);
  if (!e) return null;
  const [k, v] = e;
  const unit = labels?.[k]?.unit || (PP_KEYS.has(k) ? 'pp' : INT_KEYS.has(k) ? 'int' : k === 'sciencePerWeek' || k === 'crewMorale' || k === 'marketInterest' ? 'num' : 'pct');
  const sign = v > 0 ? '+' : '−';
  const a = Math.abs(v);
  const f = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  const val = unit === 'pp' ? `${sign}${f(a * 100)} pp` : unit === 'int' ? `${sign}${Math.round(a)}` : unit === 'num' ? `${sign}${f(a)}`
    : unit === 'pctNeg' ? `−${f(a * 100)}%` : `${sign}${f(a * 100)}%`;
  return `${val} ${EFFECT_SHORT[k] || labels?.[k]?.label || k}`;
}

/** Column (tier) per node: optional `tier` override, else 1 + deepest prerequisite (roots = 0). Cycle-safe. */
export function computeTiers(nodes) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const memo = {};
  const visiting = new Set();
  const tierOf = (id) => {
    if (memo[id] != null) return memo[id];
    const n = byId[id];
    if (!n) return -1;
    if (Number.isInteger(n.tier) && n.tier >= 0) return (memo[id] = n.tier);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let t = 0;
    for (const r of n.requires || []) if (byId[r]) t = Math.max(t, tierOf(r) + 1);
    visiting.delete(id);
    return (memo[id] = t);
  };
  for (const n of nodes) tierOf(n.id);
  return memo;
}

/** Direct children (dependents) per node id. */
export function childrenMap(nodes) {
  const out = Object.fromEntries(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const r of n.requires || []) if (out[r]) out[r].push(n.id);
  return out;
}

/** {ancestors, descendants}: every prerequisite up the chain, and everything the node eventually unlocks. */
export function chainOf(nodes, id) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const kids = childrenMap(nodes);
  const walk = (start, next) => {
    const seen = new Set();
    const stack = [...next(start)];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x) || x === id || !byId[x]) continue;
      seen.add(x);
      stack.push(...next(x));
    }
    return seen;
  };
  return {
    ancestors: walk(id, (x) => (byId[x]?.requires || [])),
    descendants: walk(id, (x) => kids[x] || []),
  };
}

/** Line state between a prerequisite and its dependent. */
export function edgeState(from, to) {
  if (from === 'done' && to === 'done') return 'done';
  if (from === 'done') return 'ready';
  return 'locked';
}

/**
 * Lane (row in the left→right tree, column in the top→bottom one) of every node of one branch: lanes follow the
 * barycenter of same-branch parents (so chains run straight), then roots move next to the children they feed;
 * an integer `row` on the node overrides. Returns { rows: {id: lane}, R: lane count }.
 */
function branchRows(list, bid, tiers, maxTier, byId, kids) {
  const rowOf = {};
  const cols = Array.from({ length: maxTier + 1 }, () => []);
  for (const n of list) cols[tiers[n.id]].push(n);
  let R = Math.max(1, ...cols.map((c) => c.length));
  for (const n of list) if (Number.isInteger(n.row) && n.row >= 0) R = Math.max(R, n.row + 1);
  const mean = (ids) => {
    const v = ids.filter((x) => byId[x]?.branch === bid && rowOf[x] != null).map((x) => rowOf[x]);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const assign = (col, keyFn) => {
    const taken = new Set();
    for (const n of col) if (Number.isInteger(n.row) && n.row >= 0 && !taken.has(n.row)) { rowOf[n.id] = n.row; taken.add(n.row); }
    const rest = col.filter((n) => !(Number.isInteger(n.row) && rowOf[n.id] === n.row && taken.has(n.row)))
      .map((n, i) => ({ n, i, k: keyFn(n) }));
    const keyed = rest.filter((e) => e.k != null).sort((a, b) => a.k - b.k || a.i - b.i);
    const free = rest.filter((e) => e.k == null);
    for (const e of keyed) {
      const want = Math.max(0, Math.min(R - 1, Math.round(e.k)));
      let pick = null;
      for (let d = 0; d < R && pick == null; d++) {
        if (want - d >= 0 && !taken.has(want - d)) pick = want - d;
        else if (want + d < R && !taken.has(want + d)) pick = want + d;
      }
      rowOf[e.n.id] = pick ?? 0;
      taken.add(rowOf[e.n.id]);
    }
    for (const e of free) {
      let r = 0;
      while (taken.has(r) && r < R) r++;
      rowOf[e.n.id] = r;
      taken.add(r);
    }
  };
  const forward = () => { for (let t = 1; t <= maxTier; t++) assign(cols[t], (n) => mean(n.requires || [])); };
  assign(cols[0], () => null);
  forward();
  // second sweep: roots move next to the children they feed, then the rest follows again
  assign(cols[0], (n) => mean(kids[n.id] || []));
  forward();
  return { rows: rowOf, R };
}

/**
 * Graph layout. Returns { pos: {id: {x, y, tier, row, branch}}, bands: [{id, name, icon, color, y, h, rows}],
 * edges: [{from, to, d, points}], width, height, tiers }.
 * Rows inside a branch band follow the barycenter of same-branch parents (so chains run straight), `row` overrides.
 */
export function layoutTree(nodes, branches = [], geom = {}) {
  const G = { ...GEOM, ...geom };
  const tiers = computeTiers(nodes);
  const kids = childrenMap(nodes);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const order = branches.map((b) => b.id);
  for (const n of nodes) if (!order.includes(n.branch)) order.push(n.branch);
  const maxTier = Math.max(0, ...Object.values(tiers));
  const rowOf = {};
  const bands = [];
  let y = G.padT;
  for (const bid of order) {
    const list = nodes.filter((n) => n.branch === bid);
    if (!list.length) continue;
    const { rows, R } = branchRows(list, bid, tiers, maxTier, byId, kids);
    Object.assign(rowOf, rows);
    const style = BRANCH_STYLE[bid] || {};
    const b = branches.find((x) => x.id === bid) || {};
    const hgt = G.bandPadT + R * G.rowH - (G.rowH - G.tile) + G.bandPadB;
    bands.push({ id: bid, name: b.name || bid, icon: b.icon || style.icon || '✦', color: b.color || style.color || '#98a3bf', y, h: hgt, rows: R });
    for (const n of list) rowOf[`@${n.id}`] = y + G.bandPadT + rowOf[n.id] * G.rowH; // absolute y
    y += hgt;
  }
  const pos = {};
  for (const n of nodes) {
    if (rowOf[`@${n.id}`] == null) continue;
    pos[n.id] = { x: G.padL + tiers[n.id] * G.colW, y: rowOf[`@${n.id}`], tier: tiers[n.id], row: rowOf[n.id], branch: n.branch };
  }
  const width = G.padL + maxTier * G.colW + G.tile + G.padR;
  const height = y + G.padB;
  // occupancy of a horizontal run at absolute y between two tiers (exclusive)
  const occupied = (yy, t0, t1) => Object.values(pos).some((p) => p.y === yy && p.tier > t0 && p.tier < t1);
  const gap = G.colW - G.tile;
  const half = G.tile / 2;
  const edges = [];
  for (const n of nodes) {
    const c = pos[n.id];
    if (!c) continue;
    for (const rid of n.requires || []) {
      const p = pos[rid];
      if (!p) continue;
      const ax = p.x + G.tile, ay = p.y + half, bx = c.x, by = c.y + half;
      let pts;
      if (c.tier > p.tier) {
        const laneChild = c.x - gap / 2;
        const laneParent = p.x + G.tile + gap / 2;
        if (ay === by && !occupied(p.y, p.tier, c.tier)) pts = [[ax, ay], [bx, by]];
        else if (!occupied(p.y, p.tier, c.tier)) pts = [[ax, ay], [laneChild, ay], [laneChild, by], [bx, by]];
        else if (!occupied(c.y, p.tier, c.tier)) pts = [[ax, ay], [laneParent, ay], [laneParent, by], [bx, by]];
        else {
          // run in the gap between rows
          const gy = c.y - (G.rowH - G.tile) / 2;
          pts = [[ax, ay], [laneParent, ay], [laneParent, gy], [laneChild, gy], [laneChild, by], [bx, by]];
        }
      } else {
        // backwards/same column (only with odd overrides): loop around through the row gap
        const gy = c.y - (G.rowH - G.tile) / 2;
        pts = [[ax, ay], [ax + gap / 2, ay], [ax + gap / 2, gy], [bx - gap / 2, gy], [bx - gap / 2, by], [bx, by]];
      }
      edges.push({ from: rid, to: n.id, points: pts, d: pathOf(pts) });
    }
  }
  return { pos, bands, edges, width, height, tiers, geom: G };
}

function pathOf(pts) {
  const clean = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  return clean.map((p, i) => `${i ? 'L' : 'M'}${Math.round(p[0] * 10) / 10} ${Math.round(p[1] * 10) / 10}`).join(' ');
}

/** Geometry of the portrait (top→bottom) layout: tiers are rows, a branch's lanes are columns. */
export const VGEOM = { tile: 80, colW: 96, rowH: 110, bandPadT: 30, bandPadB: 12, padL: 8, padR: 8, groupGap: 10, rowGap: 12, padT: 4, padB: 6, padX: 4 };

/**
 * Branch order for the grid: data order, except that a branch whose nodes require another branch's nodes comes
 * after it (stable topological sort), so cross-branch lines run forward (right / down) between neighbours.
 */
export function branchOrder(nodes, branches = []) {
  const order = branches.map((b) => b.id);
  for (const n of nodes) if (!order.includes(n.branch)) order.push(n.branch);
  const present = order.filter((bid) => nodes.some((n) => n.branch === bid));
  const branchOf = Object.fromEntries(nodes.map((n) => [n.id, n.branch]));
  const deps = Object.fromEntries(present.map((b) => [b, new Set()]));
  for (const n of nodes) {
    for (const r of n.requires || []) {
      const rb = branchOf[r];
      if (rb && rb !== n.branch && deps[n.branch] && deps[rb]) deps[n.branch].add(rb);
    }
  }
  const out = [];
  const left = [...present];
  while (left.length) {
    // earliest branch (data order) whose feeders are all placed; a cycle falls back to data order
    let i = left.findIndex((b) => [...deps[b]].every((d) => out.includes(d)));
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

/**
 * Portrait layout: tiers run top→bottom, each branch is a column group (its lanes side by side) and the groups wrap
 * `perRow` to a grid row. Same return shape as layoutTree (+ orient 'v', bands carry x/w, pos carries col/grid).
 * Lines leave a node's bottom and enter the child's top, bending only in the empty gutters between tiers and lanes.
 * `tileOf(n)` → {w, h} gives per-kind tile sizes (MISSIONS-V2 §6.1): a tile is centred in its lane cell, and each
 * tier of a grid row is as tall as its tallest tile (rows of compact tiles pack closer). Without it every tile is
 * `geom.tile` square and the layout is the classic one. pos: {x, y, w, h (tile), cx, cy, ch (cell), tier, col, grid}.
 */
export function layoutGrid(nodes, branches = [], perRow = 3, geom = {}, tileOf = null) {
  const G = { ...VGEOM, ...geom };
  const sizeOf = (n) => {
    const t = tileOf ? tileOf(n) : null;
    return { w: Math.min(G.tile, t?.w ?? G.tile), h: t?.h ?? G.tile };
  };
  const tiers = computeTiers(nodes);
  const kids = childrenMap(nodes);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const order = branchOrder(nodes, branches);
  const maxTier = Math.max(0, ...Object.values(tiers));
  const per = Math.max(1, Math.min(order.length || 1, Math.round(perRow) || 1));
  const vgap = G.rowH - G.tile, hgap = G.colW - G.tile;
  const groups = order.map((bid) => {
    const list = nodes.filter((n) => n.branch === bid);
    const { rows, R } = branchRows(list, bid, tiers, maxTier, byId, kids);
    return { bid, list, rows, R, w: G.padL + R * G.colW - (G.colW - G.tile) + G.padR, deep: Math.max(0, ...list.map((n) => tiers[n.id])) };
  });
  const pos = {};
  const bands = [];
  const grids = [];
  let y = G.padT;
  let width = 0;
  for (let g = 0; g * per < groups.length; g++) {
    const row = groups.slice(g * per, g * per + per);
    const deep = Math.max(0, ...row.map((x) => x.deep));
    // tier heights of this grid row: the tallest tile of each tier (empty tiers keep a thin gutter)
    const th = Array.from({ length: deep + 1 }, () => 0);
    for (const gr of row) for (const n of gr.list) th[tiers[n.id]] = Math.max(th[tiers[n.id]], sizeOf(n).h);
    for (let t = 0; t <= deep; t++) if (!th[t]) th[t] = tileOf ? 24 : G.tile;
    const top = [];
    let acc = G.bandPadT;
    for (let t = 0; t <= deep; t++) { top[t] = acc; acc += th[t] + vgap; }
    const hgt = acc - vgap + G.bandPadB;
    let x = G.padX;
    for (const gr of row) {
      const style = BRANCH_STYLE[gr.bid] || {};
      const b = branches.find((q) => q.id === gr.bid) || {};
      bands.push({ id: gr.bid, name: b.name || gr.bid, icon: b.icon || style.icon || '✦', color: b.color || style.color || '#98a3bf', x, y, w: gr.w, h: hgt, rows: gr.R, grid: g });
      for (const n of gr.list) {
        const col = gr.rows[n.id];
        const t = tiers[n.id];
        const cx = x + G.padL + col * G.colW, cy = y + top[t];
        const s = sizeOf(n);
        pos[n.id] = { x: cx + (G.tile - s.w) / 2, y: cy + (th[t] - s.h) / 2, w: s.w, h: s.h, cx, cy, ch: th[t], tier: t, row: col, col, grid: g, branch: n.branch };
      }
      x += gr.w + G.groupGap;
    }
    width = Math.max(width, x - G.groupGap + G.padX);
    grids.push({ y, h: hgt });
    y += hgt + G.rowGap;
  }
  const height = y - G.rowGap + G.padB;
  // some node sits in lane cx of grid row g strictly between two tiers
  const blocked = (cx, g, t0, t1) => Object.values(pos).some((q) => q.cx === cx && q.grid === g && q.tier > t0 && q.tier < t1);
  const edges = [];
  for (const n of nodes) {
    const c = pos[n.id];
    if (!c) continue;
    for (const rid of n.requires || []) {
      const p = pos[rid];
      if (!p) continue;
      const pcx = p.x + p.w / 2, ccx = c.x + c.w / 2, pB = p.y + p.h, cT = c.y;
      // cross-branch runs bend nearer the node they leave/enter, so they never share a gutter line with a branch's own
      const off = p.branch !== c.branch ? vgap / 4 : 0;
      const below = p.cy + p.ch + vgap / 2 - off; // gutter under the parent's tier
      const above = c.cy - vgap / 2 + off; // gutter over the child's tier
      const laneP = p.cx + G.tile + hgap / 2; // empty lane right of the parent
      const laneC = c.cx - hgap / 2; // empty lane left of the child
      let pts;
      if (p.grid === c.grid && c.tier > p.tier) {
        if (c.tier === p.tier + 1) pts = [[pcx, pB], [pcx, below], [ccx, below], [ccx, cT]];
        else if (!blocked(p.cx, p.grid, p.tier, c.tier)) pts = [[pcx, pB], [pcx, above], [ccx, above], [ccx, cT]];
        else if (!blocked(c.cx, c.grid, p.tier, c.tier)) pts = [[pcx, pB], [pcx, below], [ccx, below], [ccx, cT]];
        else pts = [[pcx, pB], [pcx, below], [laneC, below], [laneC, above], [ccx, above], [ccx, cT]];
      } else if (c.grid > p.grid) {
        // down the parent's lane to the channel between grid rows, across, then down the child's lane
        const ch = grids[c.grid].y - G.rowGap / 2;
        pts = [[pcx, pB], [pcx, below], [laneP, below], [laneP, ch], [laneC, ch], [laneC, above], [ccx, above], [ccx, cT]];
      } else {
        // backwards (branch cycle or odd tier overrides): around through the lanes
        pts = [[pcx, pB], [pcx, below], [laneP, below], [laneP, above], [ccx, above], [ccx, cT]];
      }
      edges.push({ from: rid, to: n.id, points: pts, d: pathOf(pts) });
    }
  }
  return { pos, bands, edges, width, height, tiers, geom: G, orient: 'v', perRow: per };
}

/** The portrait grid (branches per row from 1 to all) that shows the whole tree biggest in a vw×vh viewport. */
export function pickLayout(nodes, branches, vw, vh, tileOf = null) {
  const n = Math.max(1, branchOrder(nodes, branches).length);
  let best = null;
  for (let k = 1; k <= n; k++) {
    const lay = layoutGrid(nodes, branches, k, {}, tileOf);
    const s = Math.min(vw / Math.max(1, lay.width), vh / Math.max(1, lay.height));
    if (!best || s > best.s + 1e-9) best = { s, lay };
  }
  return best.lay;
}

/** Transform that fits world rect {x, y, w, h} in a vw×vh viewport (scale clamped to [min, max]). */
export function fitView(rect, vw, vh, { min = 0.2, max = 1.2, pad = 16, anchorY = 0.5 } = {}) {
  const s = Math.max(min, Math.min(max, Math.min((vw - pad * 2) / Math.max(1, rect.w), (vh - pad * 2) / Math.max(1, rect.h))));
  return { s, x: vw / 2 - (rect.x + rect.w / 2) * s, y: vh * anchorY - (rect.y + rect.h / 2) * s };
}

/** Bounding rect of some nodes in world px (null when empty). */
export function rectOf(lay, ids) {
  const ps = ids.map((id) => lay.pos[id]).filter(Boolean);
  if (!ps.length) return null;
  const t = lay.geom.tile;
  const x0 = Math.min(...ps.map((p) => p.x)), y0 = Math.min(...ps.map((p) => p.y));
  const x1 = Math.max(...ps.map((p) => p.x + (p.w ?? t))), y1 = Math.max(...ps.map((p) => p.y + (p.h ?? t)));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ memo (MISSIONS-V2 §6.2)

const memo = { nodesKey: null, nodes: null, data: null, layouts: new Map(), search: null };

/** Tree views, rebuilt only when (turn, unlocked, points, projects, revealed) change. */
function cachedNodes(store) {
  const st = store.state || {};
  const r = st.research || {};
  const key = [st.turn, (r.unlocked || []).length, Math.floor(r.points || 0), (r.projects || []).map((p) => `${p.nodeId}:${p.progress}`).join(','), (r.revealed || []).length, st.seed].join('|');
  if (memo.nodesKey === key && memo.data === store.data && memo.nodes) return memo.nodes;
  memo.nodesKey = key;
  memo.data = store.data;
  memo.nodes = treeNodes(store);
  memo.search = null;
  return memo.nodes;
}

function cachedLayout(store, nodes, eraId, guess) {
  const st = store.state || {};
  const r = st.research || {};
  const key = [eraId, (r.unlocked || []).length, (r.projects || []).map((p) => p.nodeId).join(','), ui.onlyUnlocks ? 1 : 0,
    Math.round(guess.w / 40), Math.round(guess.h / 40), nodes.length, (r.revealed || []).length].join('|');
  const hit = memo.layouts.get(key);
  if (hit && hit.data === store.data) return hit.lay;
  const lay = pickLayout(nodes, store.data?.tech?.branches || [], guess.w, guess.h, tileOf);
  if (memo.layouts.size > 24) memo.layouts.clear();
  memo.layouts.set(key, { data: store.data, lay });
  return lay;
}

// ------------------------------------------------------------------ helpers

function pointsInfo(store) {
  const sum = store.tryQuery('research/summary', null);
  if (sum && typeof sum === 'object') return sum;
  const q = store.tryQuery('research/points', null);
  if (typeof q === 'number') return { points: q };
  if (q && typeof q === 'object') return q;
  return { points: store.state.research?.points ?? 0 };
}

function ensureCss() {
  try {
    if (document.querySelector('link[data-techtree-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./techtree.css', import.meta.url).href;
    l.dataset.techtreeCss = '1';
    document.head.appendChild(l);
  } catch { /* no DOM */ }
}

const motionOff = () => reduceMotion() || attempt(() => matchMedia('(prefers-reduced-motion: reduce)').matches, false);
const fracOf = (n) => {
  const p = Number(n.progress) || 0;
  return Math.max(0, Math.min(1, p <= 1 ? p : p / (n.science || n.projectCost || 100)));
};
const labelOf = (n) => (n.hidden ? '???' : n.short || n.name || n.id);
const shortEra = (id) => String(id || '').toUpperCase();
const yy = (y) => (y == null ? '' : String(y).slice(-2));
const eraYears = (e) => (e?.from != null ? `${e.from}–${e.to != null && String(e.to).slice(0, 2) === String(e.from).slice(0, 2) ? yy(e.to) : e.to ?? ''}` : '');

function kindTable(store) {
  return Object.fromEntries(kindsOf(store.data).map((k) => [k.id, k]));
}
function kindColor(store, kind) {
  return kindTable(store)[kind]?.color || KIND_COLORS[kind] || '#98a3bf';
}

/** Kind badge: a small square in the kind colour with its stroke glyph (never colour alone, §5.6). */
function kindBadge(store, kind, { size = 16, cls = '' } = {}) {
  const k = kindTable(store)[kind] || { label: kind, glyph: 'chave', color: '#98a3bf' };
  const hasGlyph = !!(ICONS?.[k.glyph] || LOCAL_ICONS[k.glyph]);
  return h('span', { class: ['tt-kb', `uk-${kind}`, cls], style: css({ '--uk': k.color }), title: k.label, 'aria-hidden': 'true' },
    hasGlyph ? glyph(k.glyph, Math.round(size * 0.72)) : h('b', null, String(k.label || kind).slice(0, 1)));
}

function effectChips(n) {
  const list = Array.isArray(n.effectText) && n.effectText.length ? n.effectText
    : Object.entries(n.effects || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => fmtEffect(k, v));
  return list.length ? h('div', { class: 'chips' }, list.map((t) => chip(t, 'info'))) : null;
}

function rivalActors(store, n) {
  return (n.rivalsWith || []).map((id) => store.state.actors?.[id]).filter(Boolean)
    .concat((n.rivalsWith || []).filter((id) => !store.state.actors?.[id]).map((id) => ({ id, short: id })));
}

/** Era rows for the bar: the sim query, else counted from the nodes. */
function eraList(store, nodes) {
  const q = store.tryQuery('research/eras', null);
  if (Array.isArray(q) && q.length) return q;
  const by = {};
  for (const n of nodes) {
    const e = eraOf(n);
    const c = (by[e] ||= { id: e, name: e, total: 0, done: 0, unlockCount: 0, loaded: true });
    c.total++;
    if (n.state === 'done') c.done++;
    if (n.kind === 'unlock') c.unlockCount++;
  }
  return Object.values(by).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Era shown: the player's pick, else the current era if it has nodes, else the latest loaded one before it. */
function pickEra(eras) {
  if (ui.era && eras.some((e) => e.id === ui.era)) return ui.era;
  const cur = eras.find((e) => e.current && e.loaded) || eras.filter((e) => e.loaded).pop() || eras[0];
  return cur?.id || null;
}

// ------------------------------------------------------------------ render

export function render(container, store, route) {
  ensureCss();
  ui.mount = { container, store, route };
  // #pesquisa/n/<id>: open that node once (era, centre, sheet)
  const m = /^n\/(.+)$/.exec(route?.sub || '');
  let openId = null;
  if (m && ui.routeDone !== route.sub) {
    ui.routeDone = route.sub;
    openId = decodeURIComponent(m[1]);
  } else if (!m) ui.routeDone = null;
  const nodes = cachedNodes(store);
  if (openId) {
    const n = nodes.find((x) => x.id === openId);
    if (n) { ui.era = eraOf(n); ui.selected = openId; ui.view = null; if (ui.onlyUnlocks && n.kind !== 'unlock') ui.onlyUnlocks = false; }
    else openId = null;
  }
  const branches = store.data?.tech?.branches || [];
  const eras = nodes.length ? eraList(store, nodes) : [];
  const eraId = pickEra(eras);
  ui.era = eraId;
  const era = eras.find((e) => e.id === eraId) || null;
  const eraNodes = nodes.filter((n) => eraOf(n) === eraId);
  const page = h('div', { class: 'view-pad research tt-page' },
    viewHead('Laboratórios', { lead: researchLead(nodes, branches, eras) }),
    safePanel(() => header(store, nodes), 'Pontos de ciência indisponíveis.'));
  container.appendChild(page);
  if (!nodes.length) {
    page.appendChild(emptyState('A árvore de tecnologia ainda não chegou desta era.', 'pesquisa'));
    return cleanup;
  }
  const info = attempt(() => pointsInfo(store), {});
  if (info.migratedGrant > 0 && !ui.migratedSeen) {
    page.appendChild(h('p', { class: 'aviso tt-migrated' }, icon('info', 14, 'tt-note-ic'),
      h('span', null, `${info.migratedGrant} ${info.migratedGrant === 1 ? 'tecnologia foi concedida' : 'tecnologias foram concedidas'} pela atualização do save, conforme o ano em que você está.`)));
  }
  // era bar + toolbar: two rows, one row on short phones (techtree.css, max-height 700px)
  page.appendChild(h('div', { class: 'tt-controls' }, safePanel(() => eraBar(store, eras, eraId), 'Eras indisponíveis.'), toolbar(store)));
  if (era && !era.loaded) {
    page.appendChild(previewCard(era));
    return cleanup;
  }
  const next = safePanel(() => nextStrip(store, eraId, nodes), '');
  if (next) page.appendChild(next);
  if (ui.mode === 'list') page.appendChild(safePanel(() => listView(store, eraNodes, branches), 'A lista de tecnologias encontrou um problema.'));
  else page.appendChild(safePanel(() => treeView(store, nodes, branches, eraId), 'A árvore de tecnologia encontrou um problema.'));
  if (openId) requestAnimationFrame(() => { if (ui.selected === openId) selectNode(store, openId, { open: true, center: true }); });
  return cleanup;
}

function cleanup() {
  try { ui.ctl?.destroy(); } catch { /* */ }
  ui.ctl = null;
}

/** Re-render the tab in place (era switch, filters, mode) keeping the open sheet. */
function rerender() {
  const m = ui.mount;
  if (!m?.container?.isConnected) return;
  cleanup();
  m.container.innerHTML = '';
  render(m.container, m.store, m.route);
}

function setEra(id, { keepView = false } = {}) {
  if (ui.era === id) return false;
  ui.era = id;
  if (!keepView) ui.view = null;
  ui.selected = null;
  rerender();
  return true;
}

function researchLead(nodes, branches, eras) {
  const known = nodes.filter((n) => !n.hidden);
  if (!known.length) return null;
  const done = known.filter((n) => n.state === 'done').length;
  const open = known.filter((n) => n.state === 'available').length;
  const unlockN = known.filter((n) => n.kind === 'unlock').length;
  return [eras.length > 1 ? `${eras.length} eras` : branches.length ? `${branches.length} ramos` : null,
    unlockN ? `${unlockN} liberações` : null,
    `${open} ${open === 1 ? 'disponível' : 'disponíveis'}`, `${done} ${done === 1 ? 'concluída' : 'concluídas'}`].filter(Boolean).join(' · ');
}

function header(store, nodes) {
  const info = pointsInfo(store);
  const active = nodes.filter((n) => n.state === 'active');
  const known = nodes.filter((n) => !n.hidden);
  return card({ cls: 'science-card rs-card' },
    h('div', { class: 'science-row rs-kpi' },
      h('div', { class: 'rs-kpi-main' }, h('div', { class: 'rs-eyebrow' }, 'Pontos de ciência'), countUp('research.points', info.points ?? 0, fmtNum, 'rs-value')),
      h('div', { class: 'rs-kpi-side' },
        info.perWeek > 0 ? h('div', { class: 'rs-up' }, `+${fmtNum(info.perWeek)}/sem`) : info.passiveLeft === 0 ? h('div', { class: 'rs-lab-out' }, 'laboratório esgotado') : null,
        info.slots != null ? h('div', null, h('b', null, `${info.active ?? active.length}/${info.slots}`), ' projetos') : null,
        h('div', null, h('b', null, `${known.filter((n) => n.state === 'done').length}/${known.length}`), ' tecnologias'))),
    active.length
      ? h('div', { class: 'active-projects' }, active.map((n) => h('button', {
        class: 'tt-proj', type: 'button', 'aria-label': `Abrir ${n.name}`, onclick: () => jump(store, n.id, { open: true }),
      }, progressBar(store, n))))
      : h('p', { class: 'rs-hint' }, 'Nenhum projeto em andamento. Toque num nó com contorno amarelo para começar.'),
    info.passiveLeft != null ? h('p', { class: ['rs-lab', info.passiveLeft === 0 && 'out'] },
      info.passiveLeft > 0
        ? `Ciência de laboratório: ainda ${fmtNum(info.passiveLeft)} pontos nesta era (dá para as primeiras tecnologias). O resto vem de missões (satélites, sondas, voos tripulados) e da ciência contínua de estações espaciais e bases de superfície, que não tem limite.`
        : 'Ciência de laboratório esgotada nesta era: a próxima ciência vem de missões (satélites, sondas, voos tripulados) e das estações espaciais e bases de superfície, que rendem sem limite. Na próxima era os laboratórios rendem de novo.') : null);
}

function progressBar(store, n) {
  const eta = n.etaWeeks != null ? ` · ${fmtIn(store.state.turn + n.etaWeeks, store.state.turn)}` : '';
  return bar(fracOf(n) * 100, {
    key: `rs.${n.id}`, label: `${n.name}${n.refining ? ' · refino' : ''}${n.approach === 'bold' ? ' · ousada' : ''}${n.stalled ? ' · parado' : ''}${eta}`,
    kind: n.approach === 'bold' ? 'warn' : 'info',
  });
}

// ---- era bar, toolbar, next unlocks, preview

function eraBar(store, eras, eraId) {
  const row = h('div', { class: 'tt-eras', role: 'group', 'aria-label': 'Eras da árvore' },
    eras.map((e) => h('button', {
      class: ['tt-era', e.id === eraId && 'is-on', !e.loaded && 'is-preview', e.current && 'is-now'], type: 'button',
      'aria-pressed': e.id === eraId ? 'true' : 'false',
      'aria-label': `${e.name || e.id}${eraYears(e) ? `, ${eraYears(e)}` : ''}: ${e.loaded ? `${e.done} de ${e.total} pesquisadas` : 'prévia'}`,
      onclick: () => setEra(e.id),
    },
    h('span', { class: 'tt-era-top' }, h('b', null, shortEra(e.id)), h('span', { class: 'tt-era-y' }, eraYears(e))),
    h('span', { class: 'tt-era-n' }, e.loaded ? `${e.done}/${e.total}` : 'prévia'))));
  requestAnimationFrame(() => attempt(() => row.querySelector('.is-on')?.scrollIntoView({ inline: 'center', block: 'nearest' })));
  return row;
}

function toolbar(store) {
  const tb = (ic, label, fn, { pressed = null, aria } = {}) => h('button', {
    class: ['tt-tbtn', pressed && 'is-on'], type: 'button', onclick: fn, 'aria-label': aria || label, 'aria-pressed': pressed == null ? null : pressed ? 'true' : 'false',
  }, glyph(ic, 18), h('span', null, label));
  return h('div', { class: 'tt-toolbar', role: 'toolbar', 'aria-label': 'Ferramentas da árvore' },
    tb('busca', 'Buscar', () => openSearch(store)),
    tb('legenda', 'Legenda', () => openLegend(store)),
    tb('filtro', 'Liberações', () => { ui.onlyUnlocks = !ui.onlyUnlocks; ui.view = null; ui.selected = null; rerender(); }, { pressed: ui.onlyUnlocks, aria: 'Só liberações' }),
    ui.mode === 'list'
      ? tb('grafo', 'Grafo', () => { ui.mode = 'graph'; rerender(); }, { aria: 'Ver como grafo' })
      : tb('lista', 'Lista', () => { ui.mode = 'list'; rerender(); }, { aria: 'Ver como lista' }));
}

function unlockLine(n) {
  const u = (n.unlocks || [])[0];
  if (!u) return '';
  const more = (n.unlocks || []).length - 1;
  return `Libera: ${u.label}${more > 0 ? ` e mais ${more}` : ''}`;
}

function nextStrip(store, eraId, nodes) {
  let list = store.tryQuery('research/nextUnlocks', null, eraId, 3);
  if (!Array.isArray(list)) {
    list = nodes.filter((n) => eraOf(n) === eraId && n.kind === 'unlock' && (n.state === 'available' || n.state === 'active')).slice(0, 3);
  }
  if (!list.length) return null;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  // open by default only on tall screens: on phones the strip is one line (count + the first name) above the graph
  if (ui.nextOpen == null) ui.nextOpen = attempt(() => window.innerHeight >= 900, false);
  const open = ui.nextOpen;
  const body = h('div', { class: 'tt-next-list', hidden: !open },
    list.map((v) => {
      const n = { ...(byId[v.id] || {}), ...v };
      const eta = n.state === 'active' || n.status === 'active' ? `${Math.round(fracOf(n) * 100)}%` : n.weeks != null ? `~${n.weeks} sem` : '';
      return h('button', { class: 'tt-next-row', type: 'button', onclick: () => jump(store, n.id, { open: true }) },
        kindBadge(store, n.unlockKind, { size: 22 }),
        h('span', { class: 'tt-next-txt' }, h('b', null, n.name || n.id), h('span', null, unlockLine(n))),
        h('span', { class: 'tt-next-eta' }, eta));
    }));
  const head = h('button', {
    class: 'tt-next-head', type: 'button', 'aria-expanded': open ? 'true' : 'false',
    onclick: () => { ui.nextOpen = !ui.nextOpen; body.hidden = !ui.nextOpen; head.setAttribute('aria-expanded', ui.nextOpen ? 'true' : 'false'); head.classList.toggle('is-open', ui.nextOpen); },
  }, h('span', { class: 'tt-next-title' }, 'Próximas liberações'), h('span', { class: 'tt-next-count' }, String(list.length)),
  h('span', { class: 'tt-next-peek' }, list.map((v) => v.name).join(' · ')), glyph('avancar', 14, 'tt-next-chev'));
  head.classList.toggle('is-open', open);
  return h('section', { class: 'tt-next', 'aria-label': 'Próximas liberações' }, head, body);
}

function previewCard(era) {
  const pv = era.preview || {};
  const hl = (pv.highlights || []).slice(0, 8);
  const count = pv.count ?? era.total ?? 0;
  const unl = pv.unlockCount ?? era.unlockCount ?? 0;
  return h('div', { class: 'tt-preview' },
    h('p', { class: 'tt-preview-title' }, `${era.name || era.id}${eraYears(era) ? ` · ${eraYears(era)}` : ''}`),
    h('p', { class: 'tt-preview-lead' }, count ? `${count} tecnologias, ${unl} liberações.` : 'Tecnologias ainda desconhecidas.'),
    hl.length ? h('div', { class: 'tt-preview-hl' }, hl.map((x) => h('span', { class: 'tt-uchip', style: css({ '--uk': KIND_COLORS[x.kind] || '#98a3bf' }) }, h('i', { class: 'tt-uchip-dot', 'aria-hidden': 'true' }), x.name))) : null,
    h('p', { class: 'tt-preview-note' }, 'Carrega ao chegar mais perto.'));
}

// ---- graph

/**
 * Rough size of the tree viewport before it is laid out (fitHeight sets the real one), used to pick how many branch
 * groups go side by side: 375x812 → 3 per row, a phone on its side → wider rows.
 */
function viewportGuess() {
  const W = attempt(() => window.innerWidth, 375) || 375;
  const H = attempt(() => window.innerHeight, 812) || 812;
  const w = Math.min(W, 480) - 26; // .view-pad padding + borders (.shell is capped at 480px)
  const h = Math.max(160, H - (H < 700 ? 330 : 400)); // header, science card, era bar, toolbar, action bar
  return { w, h };
}

function treeView(store, allNodes, branches, eraId) {
  const nodes = eraGraph(allNodes, eraId, { onlyUnlocks: ui.onlyUnlocks });
  if (!nodes.some((n) => !n.stub)) {
    return emptyState(ui.onlyUnlocks ? 'Nenhuma liberação nesta era. Desligue "Só liberações" para ver os nós de eficiência.' : 'Nenhuma tecnologia nesta era.', 'pesquisa');
  }
  const guess = viewportGuess();
  const lay = cachedLayout(store, nodes, eraId, guess);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'tt-edges');
  svg.setAttribute('width', lay.width);
  svg.setAttribute('height', lay.height);
  svg.setAttribute('viewBox', `0 0 ${lay.width} ${lay.height}`);
  svg.setAttribute('aria-hidden', 'true');
  const edgeEls = [];
  const rank = { locked: 0, ready: 1, done: 2 };
  const edges = lay.edges.map((e) => ({ ...e, st: edgeState(byId[e.from]?.state, byId[e.to]?.state) }))
    .sort((a, b) => rank[a.st] - rank[b.st]);
  for (const e of edges) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', e.d);
    p.setAttribute('class', `tt-edge es-${e.st}${byId[e.to]?.hidden ? ' es-secret' : ''}${byId[e.from]?.stub ? ' es-stub' : ''}`);
    svg.appendChild(p);
    edgeEls.push({ el: p, from: e.from, to: e.to });
  }
  const bands = lay.bands.map((b) => h('div', {
    class: `tt-band${b.x != null ? ' tt-band-col' : ''}`,
    style: css({ left: `${b.x ?? 0}px`, top: `${b.y}px`, height: `${b.h}px`, width: `${b.w ?? lay.width}px`, '--band': b.color }),
    title: b.name,
  }, h('span', { class: 'tt-band-label' }, h('i', { class: 'tt-band-dot', style: { background: b.color }, 'aria-hidden': 'true' }), h('span', { class: 'tt-band-ic', 'aria-hidden': 'true' }, b.icon), h('span', { class: 'tt-band-name' }, b.name))));
  const tiles = {};
  let count = 0;
  for (const n of nodes) {
    const p = lay.pos[n.id];
    if (!p || count >= MAX_TILES * 1.5) continue; // hard stop: never thousands of buttons (data error)
    tiles[n.id] = n.stub ? stubTile(store, n, p) : tile(store, n, p);
    count++;
  }
  const world = h('div', { class: 'tt-world', style: { width: `${lay.width}px`, height: `${lay.height}px` } }, bands, svg, Object.values(tiles));
  const zoomBtn = (ic, aria, fn, extra) => h('button', { class: extra ? 'tt-tool tt-tool-extra' : 'tt-tool', type: 'button', 'aria-label': aria, title: aria, onclick: fn }, icon(ic, 20));
  const vp = h('div', { class: 'tt-viewport', role: 'group', 'aria-label': `Árvore de tecnologia, ${shortEra(eraId)}. Arraste para mover, pince para aproximar.` },
    world,
    h('div', { class: 'tt-tools' },
      zoomBtn('mais', 'Aproximar', () => ctl.zoomBy(1.3)),
      zoomBtn('menos', 'Afastar', () => ctl.zoomBy(1 / 1.3)),
      zoomBtn('expandir', 'Ver a era inteira', () => ctl.fitAll(), true),
      zoomBtn('alvo', 'Ir para a fronteira', () => ctl.focusFrontier(), true)));
  const ctl = panZoom(vp, world, lay, nodes);
  ctl.tiles = tiles;
  ctl.edges = edgeEls;
  ctl.nodes = nodes;
  ctl.all = allNodes;
  ctl.byId = byId;
  ctl.svg = svg;
  ui.ctl = ctl;
  if (ui.selected && byId[ui.selected]) highlight(ui.selected);
  else if (!ui.selected || !allNodes.some((n) => n.id === ui.selected)) ui.selected = null;
  return vp;
}

function tile(store, n, p) {
  const s = n.state;
  const unlock = n.kind === 'unlock';
  const rivals = s === 'secret' ? [] : rivalActors(store, n);
  const frac = fracOf(n);
  const R = unlock ? 15 : 7, C = 2 * Math.PI * R;
  const eff = !unlock && !n.hidden ? effectShort(n.effects, effectLabelsOf(store.data)) : null;
  const cost = s === 'done' ? (n.quality != null && n.quality < 1 ? 'falhas' : n.quality > 1 ? 'avanço' : 'pronto')
    : s === 'active' ? `${Math.round(frac * 100)}%` : s === 'secret' ? '' : `${fmtNum(n.science || 0)} pts`;
  const libera = unlock && !n.hidden ? (n.unlocks || []).map((u) => u.label).join(', ') : '';
  const aria = n.hidden ? 'Tecnologia secreta, ainda desconhecida'
    : `${n.name}. ${unlock ? `Liberação (${n.unlocks?.[0]?.kindLabel || ''}): ${libera}.` : `Eficiência${eff ? `: ${eff}` : ''}.`} ${STATE_LABELS[s] || s}.${s === 'active' ? ` ${Math.round(frac * 100)}%.` : ''}${s !== 'done' ? ` Custa ${fmtNum(n.science || 0)} de ciência.` : ''}${rivals.length ? ` Rivais já têm: ${rivals.map((a) => a.short || a.id).join(', ')}.` : ''}`;
  const color = unlock ? kindColor(store, n.unlockKind) : null;
  const sz = unlock ? 32 : 18; // efficiency tiles: 18 + two name lines + the effect chip fit in 60 px
  return h('button', {
    class: `tt-node ns-${s}${n.secret ? ' is-secret' : ''} ${unlock ? `is-unlock uk-${n.unlockKind}` : 'is-eff'}`, type: 'button', 'data-id': n.id, 'aria-label': aria,
    style: css({ left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px`, '--band': (BRANCH_STYLE[n.branch] || {}).color || '#98a3bf', ...(color ? { '--uk': color } : {}) }),
    onclick: () => selectNode(store, n.id, { open: true, center: true }),
  },
  unlock && !n.hidden ? h('span', { class: 'tt-kband', 'aria-hidden': 'true' }) : null,
  markOf(s, 'tt-badge'),
  unlock && !n.hidden ? kindBadge(store, n.unlockKind, { size: 16, cls: 'tt-kcorner' }) : null,
  h('span', { class: 'tt-icon', 'aria-hidden': 'true', style: { width: `${sz}px`, height: `${sz}px` } },
    s === 'active' ? h('span', {
      class: 'tt-ring', html: `<svg viewBox="0 0 ${2 * R + 6} ${2 * R + 6}" width="${sz}" height="${sz}"><circle cx="${R + 3}" cy="${R + 3}" r="${R}" class="tt-ring-bg"/><circle cx="${R + 3}" cy="${R + 3}" r="${R}" class="tt-ring-fg" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${R + 3} ${R + 3})"/></svg>`,
    }) : null,
    h('span', { class: 'tt-emoji' }, n.hidden ? '?' : n.icon || (BRANCH_STYLE[n.branch] || {}).icon || '✦')),
  h('span', { class: 'tt-name' }, labelOf(n)),
  eff ? h('span', { class: 'tt-eff' }, eff) : cost ? h('span', { class: 'tt-cost' }, cost) : null,
  rivals.length ? h('span', { class: 'tt-rivals', 'aria-hidden': 'true' },
    rivals.slice(0, unlock ? 4 : 2).map((a) => h('i', { style: { background: a.color || 'var(--muted)' }, title: a.short || a.id }))) : null);
}

function stubTile(store, n, p) {
  return h('button', {
    class: `tt-node tt-stub ns-${n.state === 'done' ? 'done' : 'locked'}`, type: 'button', 'data-id': n.id,
    'aria-label': `Exige ${n.name}, da ${shortEra(n.eraId)}${n.state === 'done' ? ' (concluída)' : ''}. Toque para ir até lá.`,
    style: { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` },
    onclick: () => jump(store, n.target, { open: true }),
  }, h('span', { class: 'tt-stub-era' }, `◂ ${shortEra(n.eraId)}`), h('span', { class: 'tt-stub-name' }, n.short));
}

// ---- list mode (accessible fallback, same filters)

function listView(store, eraNodes, branches) {
  const list = eraNodes.filter((n) => !ui.onlyUnlocks || n.kind === 'unlock');
  if (!list.length) return emptyState(ui.onlyUnlocks ? 'Nenhuma liberação nesta era.' : 'Nenhuma tecnologia nesta era.', 'pesquisa');
  const order = branches.map((b) => b.id);
  for (const n of list) if (!order.includes(n.branch)) order.push(n.branch);
  const rank = { active: 0, available: 1, locked: 2, secret: 3, done: 4 };
  return h('div', { class: 'tt-list' }, order.map((bid) => {
    const rows = list.filter((n) => n.branch === bid).sort((a, b) => rank[a.state] - rank[b.state] || (a.histYear ?? a.fromYear ?? 0) - (b.histYear ?? b.fromYear ?? 0));
    if (!rows.length) return null;
    const b = branches.find((x) => x.id === bid) || {};
    const st = BRANCH_STYLE[bid] || {};
    return h('section', { class: 'tt-list-sec' },
      h('h3', { class: 'tt-list-h' }, h('i', { class: 'tt-band-dot', style: { background: b.color || st.color || '#98a3bf' }, 'aria-hidden': 'true' }), b.name || bid, h('span', { class: 'tt-list-n' }, `${rows.filter((n) => n.state === 'done').length}/${rows.length}`)),
      h('div', { class: 'tt-links' }, rows.map((n) => h('button', { class: `tt-link tt-lrow ns-${n.state}`, type: 'button', onclick: () => jump(store, n.id, { open: true }) },
        n.kind === 'unlock' && !n.hidden ? kindBadge(store, n.unlockKind, { size: 24, cls: 'tt-link-kb' }) : markOf(n.state, 'tt-link-mark'),
        h('span', { class: 'tt-lrow-txt' }, h('span', { class: 'tt-link-name' }, n.hidden ? 'Tecnologia secreta' : n.name || n.id),
          h('span', { class: 'tt-lrow-sub' }, n.hidden ? '' : n.kind === 'unlock' ? unlockLine(n) : effectShort(n.effects, effectLabelsOf(store.data)) || '')),
        h('span', { class: 'tt-link-state' }, STATE_LABELS[n.state] || ''),
        icon('avancar', 16, 'tt-link-chev')))));
  }));
}

// ------------------------------------------------------------------ selection / highlight

function highlight(id) {
  const ctl = ui.ctl;
  if (!ctl) return;
  const world = ctl.world;
  if (!id || !ctl.byId[id]) {
    world.classList.remove('has-sel');
    for (const el of Object.values(ctl.tiles)) el.classList.remove('hl-self', 'hl-anc', 'hl-desc');
    for (const e of ctl.edges) e.el.classList.remove('hl', 'hl-anc', 'hl-desc');
    return;
  }
  // chain over the whole tree (other eras included), drawn where it crosses this era (stubs stand for their target)
  const { ancestors, descendants } = chainOf(ctl.all || ctl.nodes, id);
  const inAnc = (nid) => ancestors.has(nid) || (ctl.byId[nid]?.stub && ancestors.has(ctl.byId[nid].target));
  world.classList.add('has-sel');
  for (const [nid, el] of Object.entries(ctl.tiles)) {
    el.classList.toggle('hl-self', nid === id);
    el.classList.toggle('hl-anc', inAnc(nid));
    el.classList.toggle('hl-desc', descendants.has(nid));
  }
  const up = new Set([...Object.keys(ctl.tiles).filter(inAnc), id]);
  const down = new Set([...descendants, id]);
  for (const e of ctl.edges) {
    const anc = up.has(e.from) && up.has(e.to);
    const desc = down.has(e.from) && down.has(e.to);
    e.el.classList.toggle('hl', anc || desc);
    e.el.classList.toggle('hl-anc', anc);
    e.el.classList.toggle('hl-desc', desc && !anc);
    if (anc || desc) ctl.svg.appendChild(e.el); // draw on top
  }
}

/** Select a node: highlight its chain, optionally center it and open (or refill) its sheet. */
function selectNode(store, id, { open = false, center = false } = {}) {
  ui.selected = id;
  highlight(id);
  if (open) openSheet(store, id);
  if (center) {
    const ctl = ui.ctl;
    // wait a frame so the sheet is laid out and its real top is known
    if (open) requestAnimationFrame(() => { if (ui.ctl === ctl && ui.selected === id) ctl?.centerOn(id); });
    else ctl?.centerOn(id);
  }
}

// one sheet at a time: jumping to another node refills it in place (no close/reopen history churn)
let sheet = null;

/** Close the sheet after an action (start/refine/cancel) and drop the selection, so the tree is not left dimmed. */
function closeSheetAndClear() {
  sheet?.close?.();
  ui.selected = null;
  highlight(null);
}

function openSheet(store, id) {
  if (sheet?.body?.isConnected) { fillSheet(store, id); return; }
  const body = h('div', { class: 'tt-sheet-body' });
  sheet = { body, close: null };
  sheet.close = openModal(() => body, {
    title: ' ', cls: 'tt-sheet',
    onClose: () => { sheet = null; },
  });
  fillSheet(store, id);
}

function fillSheet(store, id) {
  if (!sheet) return;
  const nodes = cachedNodes(store);
  const n = nodes.find((x) => x.id === id);
  const titleEl = sheet.body.closest('.modal')?.querySelector('.modal-title');
  const title = n ? (n.hidden ? 'Tecnologia secreta' : n.name || n.id) : 'Tecnologia';
  if (titleEl) titleEl.textContent = title;
  sheet.body.closest('.modal')?.setAttribute('aria-label', title);
  sheet.body.innerHTML = '';
  if (!n) { sheet.body.appendChild(h('p', null, 'Tecnologia desconhecida.')); return; }
  try { sheet.body.appendChild(sheetContent(store, n, nodes)); } catch (e) {
    console.error(e);
    sheet.body.appendChild(h('p', { class: 'muted' }, 'Não foi possível mostrar esta tecnologia.'));
  }
  sheet.body.closest('.modal-body')?.scrollTo?.(0, 0);
}

/**
 * Go to a node anywhere in the tree: switch era (and drop "Só liberações" if it hides the node, or the list mode
 * keeps the list), select, centre, and fill the sheet (opening it when asked).
 */
function jump(store, id, { open = false } = {}) {
  const n = cachedNodes(store).find((x) => x.id === id);
  if (!n) return;
  let changed = false;
  if (ui.onlyUnlocks && n.kind !== 'unlock') { ui.onlyUnlocks = false; changed = true; }
  if (eraOf(n) !== ui.era) { ui.era = eraOf(n); ui.view = null; changed = true; }
  ui.selected = id;
  if (changed) rerender();
  const go = () => {
    if (ui.mode === 'graph') selectNode(store, id, { center: true });
    if (open || sheet?.body?.isConnected) openSheet(store, id);
  };
  if (changed) requestAnimationFrame(go); else go();
}

function nodeLink(store, n, { era = false } = {}) {
  return h('button', { class: `tt-link ns-${n.state}`, type: 'button', onclick: () => jump(store, n.id) },
    n.kind === 'unlock' && !n.hidden ? kindBadge(store, n.unlockKind, { size: 24, cls: 'tt-link-kb' }) : markOf(n.state, 'tt-link-mark'),
    h('span', { class: 'tt-link-name' }, n.hidden ? 'Tecnologia secreta' : n.name || n.id),
    era ? h('span', { class: 'tt-link-era' }, shortEra(eraOf(n))) : null,
    h('span', { class: 'tt-link-state' }, STATE_LABELS[n.state] || ''),
    icon('avancar', 16, 'tt-link-chev'));
}

/** "Libera" block of an unlock node: kind chips with the unlock labels, then the catalog names now matched. */
function liberaBlock(store, n) {
  const rows = (n.unlocks || []).map((u) => {
    const t = store.tryQuery('research/targets', null, u.key);
    const names = t?.names || [];
    return h('div', { class: 'tt-lib-row' },
      h('span', { class: 'tt-uchip', style: css({ '--uk': kindColor(store, u.kind) }) }, kindBadge(store, u.kind, { size: 16 }), h('span', { class: 'tt-uchip-k' }, u.kindLabel || u.kind)),
      h('div', { class: 'tt-lib-txt' }, h('b', null, u.label),
        names.length ? h('span', { class: 'tt-lib-ex' }, `Ex.: ${names.join(', ')}${t.more > 0 ? ` e mais ${t.more}` : ''}`) : null));
  });
  return h('div', { class: 'tt-sec tt-lib' }, h('h3', null, 'Libera'), h('div', { class: 'tt-lib-list' }, rows));
}

function sheetContent(store, n, nodes) {
  const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
  const branch = (store.data?.tech?.branches || []).find((b) => b.id === n.branch);
  const bs = BRANCH_STYLE[n.branch] || {};
  const kids = childrenMap(nodes)[n.id] || [];
  const reqs = (n.requires || []).map((r) => byId[r]).filter(Boolean);
  const eraReqs = reqs.filter((r) => eraOf(r) === eraOf(n));
  const otherReqs = reqs.filter((r) => eraOf(r) !== eraOf(n));
  const head = h('div', { class: 'tt-sheet-tags' },
    n.kind === 'unlock' && !n.hidden ? chip([kindBadge(store, n.unlockKind, { size: 14 }), ' ', `Liberação · ${n.unlocks?.[0]?.kindLabel || ''}`], 'tt-kchip') : chip('Eficiência', 'muted'),
    chip([h('i', { class: 'tt-band-dot', style: { background: bs.color || '#98a3bf' }, 'aria-hidden': 'true' }), branch?.name || n.branchName || n.branch], ''),
    chip(`${shortEra(eraOf(n))}${n.histYear ? ` · ${n.histYear}` : ''}`, 'muted'),
    chip(STATE_LABELS[n.state] || n.state, STATE_KIND[n.state] || 'muted'));
  if (n.hidden) {
    return h('div', { class: 'node-sheet' }, head,
      h('p', null, 'Ninguém na agência sabe ainda o que existe aqui. Um acontecimento no caminho pode revelar esta pesquisa.'),
      reqs.length ? h('div', { class: 'tt-sec' }, h('h3', null, 'Ligada a'), h('div', { class: 'tt-links' }, reqs.map((r) => nodeLink(store, r)))) : null);
  }
  const info = attempt(() => pointsInfo(store), {});
  const ap = info.approaches || store.data?.tech?.config?.approaches || {};
  const rivals = rivalActors(store, n);
  const missing = reqs.filter((r) => r.state !== 'done');
  const weeks = n.weeks ?? n.estWeeks;
  const boldW = n.weeksBold ?? (weeks != null ? Math.max(1, Math.round(weeks / (ap.bold?.speed || 1.65))) : null);
  const costBold = n.costBold ?? (n.cost != null ? Math.round(n.cost * (ap.bold?.costMult || 1.1)) : null);
  const out = h('div', { class: 'node-sheet' }, head,
    n.description ? h('p', { class: 'tt-desc' }, n.description) : null);
  if (n.kind === 'unlock') out.appendChild(liberaBlock(store, n));
  const fx = effectChips(n);
  if (fx) out.appendChild(fx);
  out.appendChild(h('div', { class: 'tt-facts' },
    fact('Ciência', `${fmtNum(n.science || 0)} pts`, n.state !== 'done' && n.state !== 'active' ? `você tem ${fmtNum(info.points ?? 0)}` : null),
    fact('Verba', n.cost != null ? fmtMoney(n.cost) : '—', n.cost != null && weeks ? `total, pago ao longo do projeto (≈ ${fmtMoney(n.cost / weeks)}/sem)` : 'total, pago ao longo do projeto'),
    fact('Prazo', weeks != null ? `~${weeks} sem` : '—', 'abordagem segura')));
  if (n.state === 'active') {
    out.append(progressBar(store, n),
      h('p', { class: 'small' }, n.approach === 'bold' ? 'Abordagem ousada: mais rápida, com chance de surpresa, boa ou ruim.' : 'Abordagem segura: ritmo constante, sem surpresas.'),
      button('Cancelar projeto', () => {
        const r = store.dispatch({ type: 'research/cancel', nodeId: n.id });
        if (r?.ok) { toast(`Projeto cancelado.${r.refund ? ` ${fmtNum(r.refund)} de ciência devolvidos.` : ''}`, 'warn'); closeSheetAndClear(); }
        else toast(r?.error || 'Não foi possível cancelar.', 'bad');
      }, { kind: 'danger', big: true }),
      h('p', { class: 'tiny muted' }, `Cancelar devolve parte da ciência (${Math.round((store.data?.tech?.config?.cancelRefund ?? 0.5) * 100)}%). A verba já gasta não volta.`));
  } else if (n.state === 'done' && n.canRefine) {
    out.append(h('p', { class: 'small' }, 'O projeto terminou com falhas. Refinar recupera o efeito completo.'),
      button('Refinar tecnologia', () => {
        const r = store.dispatch({ type: 'research/refine', nodeId: n.id });
        if (r?.ok) { toast(`Refino iniciado: ${n.name}.`, 'good'); closeSheetAndClear(); } else toast(r?.error || 'Não foi possível refinar.', 'bad');
      }, { kind: 'primary', big: true }));
  } else if (n.state === 'available') {
    const slotsFull = info.slots != null && (info.active ?? 0) >= info.slots;
    const noSci = n.canAffordScience === false || (n.canAffordScience == null && (info.points ?? 0) < (n.science || 0));
    const blocked = slotsFull ? `Limite de ${info.slots} projetos simultâneos. Conclua ou cancele um antes.`
      : noSci ? 'Ciência insuficiente: missões e laboratórios geram mais.' : null;
    const start = (approach) => {
      const r = store.dispatch({ type: 'research/start', nodeId: n.id, approach });
      if (r?.ok) { toast(`Pesquisa iniciada: ${n.name} (${approach === 'bold' ? 'ousada' : 'segura'}).`, 'good'); closeSheetAndClear(); }
      else toast(r?.error || 'Não foi possível iniciar.', 'bad');
    };
    // native append() would turn a null into the text "null": only append what exists
    if (blocked) out.appendChild(h('div', { class: 'aviso warn tt-note' }, icon('alerta', 14, 'tt-note-ic'), h('span', null, blocked)));
    out.appendChild(
      h('div', { class: 'approach-grid' },
        approachBtn('safe', 'Segura', weeks, n.cost, ap.safe?.description || 'Sem surpresas. Ideal para o que a missão precisa a tempo.', !!blocked, start),
        approachBtn('bold', 'Ousada', boldW, costBold, ap.bold?.description || 'Chance de resultado inesperado: um salto ou um tropeço.', !!blocked, start)));
  } else if (n.state === 'locked') {
    const early = n.fromYear != null && (store.state?.startYear ?? 0) + Math.floor((store.state?.turn ?? 0) / 52) < n.fromYear && !missing.length;
    const text = early ? `Fora do alcance desta época: abre em ${n.fromYear}.`
      : `Pesquise antes: ${missing.map((r) => r.hidden ? 'uma tecnologia secreta' : r.name).join(', ') || 'os pré-requisitos'}.`;
    out.appendChild(h('div', { class: 'aviso tt-note tt-locked-note' }, icon('cadeado', 14, 'tt-note-ic'), h('span', null, text)));
  } else if (n.state === 'done') {
    out.appendChild(h('div', { class: 'aviso ok tt-note' }, icon('check', 14, 'tt-note-ic'), h('span', null, `Concluída${n.quality > 1 ? ', com um avanço inesperado' : ''}. ${n.kind === 'unlock' ? 'O que ela libera já está no seu catálogo.' : 'Os efeitos já valem para as suas missões.'}`)));
  }
  if (rivals.length) {
    out.appendChild(h('div', { class: 'tt-rivals-line small muted' },
      rivals.map((a) => h('i', { class: 'tt-dot', style: { background: a.color || 'var(--muted)' }, 'aria-hidden': 'true' })),
      ` Já dominam: ${rivals.map((a) => `${flagPrefix(a)}${a.short || a.id}`).join(', ')}`));
  }
  if (eraReqs.length) out.appendChild(h('div', { class: 'tt-sec' }, h('h3', null, 'Requer'), h('div', { class: 'tt-links' }, eraReqs.map((r) => nodeLink(store, r)))));
  if (otherReqs.length) out.appendChild(h('div', { class: 'tt-sec' }, h('h3', null, 'Exige (outras eras)'), h('div', { class: 'tt-links' }, otherReqs.map((r) => nodeLink(store, r, { era: true })))));
  if (kids.length) out.appendChild(h('div', { class: 'tt-sec' }, h('h3', null, 'Abre caminho para'), h('div', { class: 'tt-links' }, kids.map((k) => byId[k]).filter(Boolean).map((k) => nodeLink(store, k, { era: eraOf(k) !== eraOf(n) })))));
  return out;
}

function fact(label, value, sub) {
  return h('div', { class: 'tt-fact' }, h('div', { class: 'tt-fact-l' }, h('span', { class: 'tt-fact-k' }, label), sub ? h('span', { class: 'tt-fact-sub' }, sub) : null), h('div', { class: 'tt-fact-v' }, value));
}

function approachBtn(kind, title, weeks, cost, desc, disabled, start) {
  return h('button', { class: `approach ${kind}`, type: 'button', disabled, onclick: () => start(kind) },
    h('div', { class: 'approach-head' }, h('span', { class: 'approach-title' }, title), kind === 'bold' ? chip('arriscada', 'warn') : null),
    h('div', { class: 'approach-stats' }, [weeks != null ? `~${weeks} sem` : kind === 'bold' ? 'Mais rápida' : 'Mais lenta', cost != null ? fmtMoney(cost) : null].filter(Boolean).join(' · ')),
    h('div', { class: 'approach-desc' }, desc));
}

// ------------------------------------------------------------------ search and legend sheets

function searchIndex(store) {
  if (memo.search && memo.search.data === store.data && memo.search.nodes === memo.nodes) return memo.search.list;
  const nodes = cachedNodes(store);
  const list = nodes.filter((n) => !n.hidden).map((n) => {
    if (n.kind !== 'unlock') return n;
    const targetNames = [];
    for (const u of n.unlocks || []) {
      const t = store.tryQuery('research/targets', null, u.key);
      if (t?.names) targetNames.push(...t.names);
    }
    return { ...n, targetNames };
  });
  memo.search = { data: store.data, nodes: memo.nodes, list };
  return list;
}

function openSearch(store) {
  const input = h('input', { class: 'tt-search-in', type: 'search', placeholder: 'Nome, foguete, satélite, módulo…', 'aria-label': 'Buscar tecnologia', autocomplete: 'off', spellcheck: 'false' });
  const results = h('div', { class: 'tt-links tt-search-res', role: 'list' });
  const hint = h('p', { class: 'tt-search-hint' }, 'Digite ao menos 2 letras. A busca cobre todas as eras carregadas.');
  let close = null;
  const run = () => {
    const found = searchNodes(searchIndex(store), input.value, 20);
    results.innerHTML = '';
    hint.textContent = input.value.trim().length < 2 ? 'Digite ao menos 2 letras. A busca cobre todas as eras carregadas.'
      : found.length ? `${found.length}${found.length === 20 ? '+' : ''} resultado${found.length === 1 ? '' : 's'}` : 'Nada encontrado.';
    for (const n of found) {
      results.appendChild(h('button', { class: `tt-link tt-lrow ns-${n.state}`, type: 'button', role: 'listitem', onclick: () => { close?.(); jump(store, n.id, { open: true }); } },
        n.kind === 'unlock' ? kindBadge(store, n.unlockKind, { size: 24, cls: 'tt-link-kb' }) : markOf(n.state, 'tt-link-mark'),
        h('span', { class: 'tt-lrow-txt' }, h('span', { class: 'tt-link-name' }, n.name || n.id),
          h('span', { class: 'tt-lrow-sub' }, n.kind === 'unlock' ? unlockLine(n) : effectShort(n.effects, effectLabelsOf(store.data)) || '')),
        h('span', { class: 'tt-link-era' }, shortEra(eraOf(n))),
        h('span', { class: 'tt-link-state' }, STATE_LABELS[n.state] || '')));
    }
  };
  input.addEventListener('input', run);
  close = openModal(() => h('div', { class: 'tt-search' }, input, hint, results), { title: 'Buscar na árvore', cls: 'tt-sheet tt-search-sheet' });
  setTimeout(() => attempt(() => input.focus()), 60);
}

function openLegend(store) {
  let kinds = store.tryQuery('research/kinds', null);
  if (!Array.isArray(kinds)) {
    const nodes = cachedNodes(store);
    kinds = kindsOf(store.data).map((k) => ({ ...k, total: nodes.filter((n) => n.unlockKind === k.id).length, done: nodes.filter((n) => n.unlockKind === k.id && n.state === 'done').length }));
  }
  openModal(() => h('div', { class: 'tt-legend-sheet' },
    h('p', { class: 'tt-desc' }, 'Peças grandes, com faixa colorida, liberam algo novo para construir, comprar ou voar. Peças compactas melhoram a eficiência.'),
    h('div', { class: 'tt-sec' }, h('h3', null, 'Tipos de liberação'),
      h('div', { class: 'tt-links' }, kinds.map((k) => h('div', { class: 'tt-link tt-leg-row' },
        kindBadge(store, k.id, { size: 24, cls: 'tt-link-kb' }),
        h('span', { class: 'tt-link-name' }, k.label),
        h('span', { class: 'tt-leg-n' }, `${k.done ?? 0}/${k.total ?? 0}`))))),
    h('div', { class: 'tt-sec' }, h('h3', null, 'Estado'),
      h('div', { class: 'tt-legend' }, ['done', 'active', 'available', 'locked', 'secret'].map((s) =>
        h('span', { class: `tt-leg ns-${s}` }, markOf(s), STATE_LABELS[s])))),
    h('p', { class: 'tiny muted' }, '◂ E3 no topo de uma coluna: pré-requisito de outra era. Toque para ir até ele.')),
  { title: 'Legenda', cls: 'tt-sheet tt-search-sheet' });
}

// ------------------------------------------------------------------ pan / zoom

// short phones: the tree may shrink below the old 320px floor so it (and its tools) fit above the action bar
const MIN_VP_H = 200;
const MIN_VP_H_SHORT = 200; // 320x640 and the like: the 4 tool buttons are 34px there (techtree.css)

/** Vertical centre (viewport-local px) of the part of the tree not covered by an open bottom sheet. */
function visibleMidY(vp, hh) {
  const modal = sheet?.body?.closest?.('.modal');
  if (!modal || !vp.getBoundingClientRect) return hh / 2;
  const vr = vp.getBoundingClientRect();
  // sheet top in viewport-local coords; a bottom sheet still sliding in reports a lower rect, so take the resting
  // position (its height up from the bottom of the window) when that is higher
  const r = modal.getBoundingClientRect();
  const resting = (window.innerHeight || r.bottom) - modal.offsetHeight;
  const top = Math.min(r.top, resting > 0 ? resting : r.top) - vr.top;
  if (!(top > 0) || top >= hh) return top >= hh ? hh / 2 : 40; // sheet below the tree: real centre; covering it: top edge
  return Math.max(36, top / 2);
}

function panZoom(vp, world, lay, nodes) {
  const MIN = 0.15, MAX = 1.6;
  let v = ui.view ? { ...ui.view } : null;
  let raf = 0;
  let destroyed = false;
  // the tools float in the bottom-right corner (DESIGN §6), so the whole viewport is usable for fit/centre
  const size = () => ({ w: Math.max(120, vp.clientWidth || 360), h: vp.clientHeight || 480 });
  const clampV = () => {
    const { w, h: hh } = size();
    v.s = Math.max(MIN, Math.min(MAX, v.s));
    const cw = lay.width * v.s, ch = lay.height * v.s, m = 70;
    v.x = cw + 2 * m <= w ? (w - cw) / 2 : Math.max(w - cw - m, Math.min(m, v.x));
    v.y = ch + 2 * m <= hh ? (hh - ch) / 2 : Math.max(hh - ch - m, Math.min(m, v.y));
  };
  const apply = () => {
    raf = 0;
    if (!v) return;
    world.style.transform = `translate3d(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px, 0) scale(${v.s.toFixed(4)})`;
    vp.classList.toggle('tt-far', v.s < 0.55);
  };
  const commit = (animate = false) => {
    clampV();
    ui.view = { ...v };
    if (animate && !motionOff()) {
      world.classList.add('tt-anim');
      clearTimeout(commit.t);
      commit.t = setTimeout(() => world.classList.remove('tt-anim'), 320);
    }
    if (!raf) raf = requestAnimationFrame(apply);
  };
  const zoomAt = (px, py, k) => {
    const s = Math.max(MIN, Math.min(MAX, v.s * k));
    v.x = px - (px - v.x) * (s / v.s);
    v.y = py - (py - v.y) * (s / v.s);
    v.s = s;
  };
  const frontierIds = () => nodes.filter((n) => !n.stub && (n.state === 'available' || n.state === 'active')).map((n) => n.id);
  const ctl = {
    world,
    zoomBy(k) { const { w, h: hh } = size(); zoomAt(w / 2, hh / 2, k); commit(true); },
    fitAll() {
      const { w, h: hh } = size();
      v = fitView({ x: 0, y: 0, w: lay.width, h: lay.height }, w, hh, { min: MIN, max: 1, pad: 6 });
      commit(true);
    },
    focusFrontier(animate = true) {
      const { w, h: hh } = size();
      const r = rectOf(lay, frontierIds());
      if (!r) { ctl.fitAll(); return; }
      const box = { x: r.x - 12, y: r.y - 30, w: r.w + 24, h: r.h + 42 }; // 30 on top: room for the band label
      v = fitView(box, w, hh, { min: 0.9, max: 1, pad: 6 });
      // frontier bigger than the screen at a readable zoom: start at its top-left corner (the roots), not the middle
      if (box.w * v.s > w) v.x = 6 - box.x * v.s;
      if (box.h * v.s > hh) v.y = 6 - box.y * v.s;
      commit(animate);
    },
    centerOn(id) {
      const p = lay.pos[id];
      if (!p) return;
      const { w, h: hh } = size();
      if (v.s < 0.7) v.s = 0.85;
      const tw = p.w ?? lay.geom.tile, th = p.h ?? lay.geom.tile;
      v.x = w / 2 - (p.x + tw / 2) * v.s;
      v.y = visibleMidY(vp, hh) - (p.y + th / 2) * v.s; // middle of the strip the sheet leaves visible
      commit(true);
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    },
  };

  // ---- gestures (pointer events: mouse, touch, pen) ----
  const pts = new Map();
  let g = null;
  let dragged = false;
  const local = (e) => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const startPan = (p) => { g = { type: 'pan', sx: p.x, sy: p.y, vx: v.x, vy: v.y }; };
  const startPinch = () => {
    const [a, b] = [...pts.values()];
    g = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ...v };
  };
  vp.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest?.('.tt-tools')) return;
    world.classList.remove('tt-anim');
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) { dragged = false; startPan(local(e)); }
    else if (pts.size === 2) {
      dragged = true;
      for (const id of pts.keys()) attempt(() => vp.setPointerCapture(id));
      startPinch();
    }
  });
  vp.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (g.type === 'pan') {
      const dx = p.x - g.sx, dy = p.y - g.sy;
      if (!dragged && Math.hypot(dx, dy) > 7) { dragged = true; attempt(() => vp.setPointerCapture(e.pointerId)); vp.classList.add('tt-dragging'); }
      if (!dragged) return;
      v.x = g.vx + dx; v.y = g.vy + dy;
    } else if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const s = Math.max(MIN, Math.min(MAX, g.s * (d / g.d0)));
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      v.s = s;
      v.x = mx - (g.mx - g.x) * (s / g.s);
      v.y = my - (g.my - g.y) * (s / g.s);
    }
    if (!raf) raf = requestAnimationFrame(apply);
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 1) startPan([...pts.values()][0]);
    else if (pts.size === 0) { g = null; vp.classList.remove('tt-dragging'); commit(); }
  };
  vp.addEventListener('pointerup', end);
  vp.addEventListener('pointercancel', end);
  // a drag ends in a click on whatever is under the finger: swallow it; a plain tap on empty space clears the selection
  vp.addEventListener('click', (e) => {
    if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; return; }
    if (!e.target.closest?.('.tt-node, .tt-tools')) { ui.selected = null; highlight(null); }
  }, true);
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    world.classList.remove('tt-anim');
    const p = local(e);
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
    } else v.x -= e.deltaX;
    commit();
  }, { passive: false });
  // keyboard focus on a tile off screen brings it into view
  vp.addEventListener('focusin', (e) => {
    const id = e.target?.dataset?.id;
    const p = id && lay.pos[id];
    if (!p) return;
    vp.scrollTop = 0; vp.scrollLeft = 0; // browsers scroll overflow:hidden boxes to focused children
    const { w, h: hh } = size();
    const tw = p.w ?? lay.geom.tile, th = p.h ?? lay.geom.tile;
    const sx = v.x + p.x * v.s, sy = v.y + p.y * v.s;
    if (sx < 0 || sy < 0 || sx + tw * v.s > w || sy + th * v.s > hh) { v.x = w / 2 - (p.x + tw / 2) * v.s; v.y = hh / 2 - (p.y + th / 2) * v.s; commit(true); }
  });
  const fitHeight = () => {
    if (destroyed || !vp.isConnected) return;
    const view = vp.closest('.view');
    const top = vp.getBoundingClientRect().top - (view ? view.getBoundingClientRect().top : 0) + (view?.scrollTop || 0);
    const avail = (view ? view.clientHeight : window.innerHeight) - top - 14;
    vp.style.height = `${Math.max(window.innerHeight < 700 ? MIN_VP_H_SHORT : MIN_VP_H, Math.round(avail))}px`;
  };
  const onResize = () => { fitHeight(); if (v) commit(); };
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => {
    if (destroyed) return;
    fitHeight();
    if (!v) { v = { x: 0, y: 0, s: 1 }; ctl.focusFrontier(false); } else commit();
    apply();
  });
  if (v) apply();
  return ctl;
}

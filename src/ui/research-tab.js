// Pesquisa: árvore de tecnologia em grafo (estilo KSP). Colunas = níveis (profundidade de pré-requisitos),
// faixas = ramos, conectores em cotovelo num SVG atrás dos nós. Arrastar = mover, pinça/roda = zoom
// (só `transform` no "mundo"; nada é re-renderizado durante o gesto). Toque num nó destaca a cadeia
// (o que ele exige e o que ele libera) e abre a folha com abordagens Segura/Ousada.
// Layout/cadeia são funções puras exportadas (testadas em Node, tests/techtree.test.mjs).
import {
  h, card, chip, bar, button, emptyState, safePanel, openModal, toast, countUp, attempt, reduceMotion,
  fmtEffect, fmtNum, fmtIn, fmtMoney,
} from './components.js';

const BRANCH_STYLE = {
  propulsion: { icon: '🔥', color: '#ff7a45' },
  structures: { icon: '🧱', color: '#cdbf9f' },
  life_support: { icon: '🫁', color: '#5fd08f' },
  computing: { icon: '🖥️', color: '#b48cff' },
  energy: { icon: '⚡', color: '#f2c94c' },
  science: { icon: '🔭', color: '#4fb3d9' },
};
const STATE_LABELS = { locked: 'Travado', available: 'Disponível', active: 'Em pesquisa', done: 'Concluído', secret: 'Secreto' };
const STATE_GLYPH = { locked: '🔒', available: '●', active: '◔', done: '✓', secret: '?' };
const STATE_KIND = { locked: 'muted', available: 'accent', active: 'info', done: 'good', secret: 'warn' };

/** Geometry of the graph, in world px (scaled by the pan/zoom transform). */
export const GEOM = { tile: 80, colW: 124, rowH: 96, bandPadT: 28, bandPadB: 10, padL: 14, padT: 6, padR: 22, padB: 10 };

// view state survives the tab's re-render on every store change (and tab switches during the session)
const ui = { view: null, selected: null, ctl: null };

// ------------------------------------------------------------------ data (pure)

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
      if (v) return { ...n, ...v, icon: n.icon, short: n.short, tier: n.tier, row: n.row, state: v.state || v.status || 'locked' };
      return n.secret ? { ...n, state: 'secret', hidden: true } : { ...n, state: 'locked' };
    });
    // nodes only the sim knows (should not happen, but never drop them)
    for (const v of list) if (!dataNodes.some((n) => n.id === v.id)) out.push({ ...v, state: v.state || v.status || 'locked' });
    return out;
  }
  const unlocked = new Set(r.unlocked || []);
  const revealed = new Set(r.revealed || []);
  const active = Object.fromEntries((r.projects || []).map((p) => [p.nodeId, p]));
  return dataNodes.map((n) => {
    const p = active[n.id];
    if (n.secret && !unlocked.has(n.id) && !revealed.has(n.id) && !p && !st.events?.flags?.[n.unlockedBy]) return { ...n, state: 'secret', hidden: true };
    let state = 'locked';
    if (p) state = 'active';
    else if (unlocked.has(n.id)) state = 'done';
    else if ((n.requires || []).every((x) => unlocked.has(x))) state = 'available';
    const rivalsWith = Object.entries(r.rivals || {}).filter(([, l]) => Array.isArray(l) && l.includes(n.id)).map(([id]) => id);
    return { ...n, state, progress: p ? p.progress : state === 'done' ? 1 : 0, approach: p?.approach, projectCost: p?.cost, rivalsWith };
  });
}
/** Kept for older callers. */
export const researchNodes = treeNodes;

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
  const x1 = Math.max(...ps.map((p) => p.x + t)), y1 = Math.max(...ps.map((p) => p.y + t));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

function effectChips(n) {
  const list = Array.isArray(n.effectText) && n.effectText.length ? n.effectText
    : Object.entries(n.effects || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => fmtEffect(k, v));
  return list.length ? h('div', { class: 'chips' }, list.map((t) => chip(t, 'info'))) : null;
}

function rivalActors(store, n) {
  return (n.rivalsWith || []).map((id) => store.state.actors?.[id]).filter(Boolean)
    .concat((n.rivalsWith || []).filter((id) => !store.state.actors?.[id]).map((id) => ({ id, short: id })));
}

// ------------------------------------------------------------------ render

export function render(container, store) {
  ensureCss();
  const nodes = treeNodes(store);
  const branches = store.data?.tech?.branches || [];
  container.appendChild(h('div', { class: 'view-pad research tt-page' },
    h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'Pesquisa')),
    safePanel(() => header(store, nodes), 'Pontos de ciência indisponíveis.'),
    nodes.length ? legend() : null,
    nodes.length ? safePanel(() => treeView(store, nodes, branches), 'A árvore de tecnologia encontrou um problema.')
      : emptyState('A árvore de tecnologia ainda não chegou desta era.', '🧪')));
  const ctl = ui.ctl;
  return () => { try { ctl?.destroy(); } catch { /* */ } if (ui.ctl === ctl) ui.ctl = null; };
}

function header(store, nodes) {
  const info = pointsInfo(store);
  const active = nodes.filter((n) => n.state === 'active');
  const known = nodes.filter((n) => !n.hidden);
  return card({ cls: 'science-card' },
    h('div', { class: 'science-row' },
      h('div', null, h('div', { class: 'tile-label' }, '🔬 Pontos de ciência'), countUp('research.points', info.points ?? 0, fmtNum, 'tile-value')),
      h('div', { class: 'right' },
        info.perWeek != null ? h('div', { class: 'small' }, `+${fmtNum(info.perWeek)}/sem`) : null,
        info.slots != null ? h('div', { class: 'small muted' }, `${info.active ?? active.length}/${info.slots} projetos simultâneos`) : null,
        h('div', { class: 'small muted' }, `${known.filter((n) => n.state === 'done').length}/${known.length} tecnologias`))),
    active.length
      ? h('div', { class: 'active-projects' }, active.map((n) => h('button', {
        class: 'tt-proj', type: 'button', 'aria-label': `Abrir ${n.name}`, onclick: () => selectNode(store, n.id, { open: true, center: true }),
      }, progressBar(store, n))))
      : h('p', { class: 'muted small' }, 'Nenhum projeto em andamento. Toque num nó com contorno brilhante para começar.'));
}

function progressBar(store, n) {
  const eta = n.etaWeeks != null ? ` · ${fmtIn(store.state.turn + n.etaWeeks, store.state.turn)}` : '';
  return bar(fracOf(n) * 100, {
    key: `rs.${n.id}`, label: `${n.name}${n.refining ? ' · refino' : ''}${n.approach === 'bold' ? ' · ousada' : ''}${n.stalled ? ' · parado' : ''}${eta}`,
    kind: n.approach === 'bold' ? 'warn' : 'accent',
  });
}

function legend() {
  return h('div', { class: 'tt-legend', 'aria-label': 'Legenda' },
    ['done', 'active', 'available', 'locked', 'secret'].map((s) =>
      h('span', { class: `tt-leg ns-${s}` }, h('i', { 'aria-hidden': 'true' }, STATE_GLYPH[s]), STATE_LABELS[s])));
}

function treeView(store, nodes, branches) {
  const lay = layoutTree(nodes, branches);
  const G = lay.geom;
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
    p.setAttribute('class', `tt-edge es-${e.st}${byId[e.to]?.hidden ? ' es-secret' : ''}`);
    svg.appendChild(p);
    edgeEls.push({ el: p, from: e.from, to: e.to });
  }
  const bands = lay.bands.map((b) => h('div', {
    class: 'tt-band', style: { top: `${b.y}px`, height: `${b.h}px`, width: `${lay.width}px`, '--band': b.color },
  }, h('span', { class: 'tt-band-label' }, h('span', { 'aria-hidden': 'true' }, b.icon), ` ${b.name}`)));
  const tiles = {};
  for (const n of nodes) {
    const p = lay.pos[n.id];
    if (!p) continue;
    tiles[n.id] = tile(store, n, p, G);
  }
  const world = h('div', { class: 'tt-world', style: { width: `${lay.width}px`, height: `${lay.height}px` } }, bands, svg, Object.values(tiles));
  const zoomBtn = (label, aria, fn) => h('button', { class: 'tt-tool', type: 'button', 'aria-label': aria, title: aria, onclick: fn }, label);
  const vp = h('div', { class: 'tt-viewport', role: 'group', 'aria-label': 'Árvore de tecnologia. Arraste para mover, pince para aproximar.' },
    world,
    h('div', { class: 'tt-tools' },
      zoomBtn('−', 'Afastar', () => ctl.zoomBy(1 / 1.3)),
      zoomBtn('+', 'Aproximar', () => ctl.zoomBy(1.3)),
      zoomBtn('⤢', 'Ver a árvore inteira', () => ctl.fitAll()),
      zoomBtn('◎', 'Ir para a fronteira', () => ctl.focusFrontier())));
  const ctl = panZoom(vp, world, lay, nodes);
  ctl.tiles = tiles;
  ctl.edges = edgeEls;
  ctl.nodes = nodes;
  ctl.byId = byId;
  ctl.svg = svg;
  ui.ctl = ctl;
  if (ui.selected && byId[ui.selected]) highlight(ui.selected);
  else ui.selected = null;
  return vp;
}

function tile(store, n, p, G) {
  const s = n.state;
  const rivals = s === 'secret' ? [] : rivalActors(store, n);
  const frac = fracOf(n);
  const R = 15, C = 2 * Math.PI * R;
  const cost = s === 'done' ? (n.quality != null && n.quality < 1 ? '⚠ falhas' : n.quality > 1 ? '✦ avanço' : 'pronto')
    : s === 'active' ? `${Math.round(frac * 100)}%` : s === 'secret' ? '' : `${fmtNum(n.science || 0)} 🔬`;
  const aria = n.hidden ? 'Tecnologia secreta, ainda desconhecida'
    : `${n.name}. ${STATE_LABELS[s] || s}.${s === 'active' ? ` ${Math.round(frac * 100)}%.` : ''}${s !== 'done' ? ` Custa ${fmtNum(n.science || 0)} de ciência.` : ''}${rivals.length ? ` Rivais já têm: ${rivals.map((a) => a.short || a.id).join(', ')}.` : ''}`;
  return h('button', {
    class: `tt-node ns-${s}${n.secret ? ' is-secret' : ''}`, type: 'button', 'data-id': n.id, 'aria-label': aria,
    style: { left: `${p.x}px`, top: `${p.y}px`, width: `${G.tile}px`, height: `${G.tile}px`, '--band': (BRANCH_STYLE[n.branch] || {}).color || '#98a3bf' },
    onclick: () => selectNode(store, n.id, { open: true, center: true }),
  },
  h('span', { class: 'tt-badge', 'aria-hidden': 'true' }, STATE_GLYPH[s] || ''),
  h('span', { class: 'tt-icon', 'aria-hidden': 'true' },
    s === 'active' ? h('span', {
      class: 'tt-ring', html: `<svg viewBox="0 0 36 36" width="32" height="32"><circle cx="18" cy="18" r="${R}" class="tt-ring-bg"/><circle cx="18" cy="18" r="${R}" class="tt-ring-fg" stroke-dasharray="${(C * frac).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 18 18)"/></svg>`,
    }) : null,
    h('span', { class: 'tt-emoji' }, n.hidden ? '?' : n.icon || (BRANCH_STYLE[n.branch] || {}).icon || '✦')),
  h('span', { class: 'tt-name' }, labelOf(n)),
  cost ? h('span', { class: 'tt-cost' }, cost) : null,
  rivals.length ? h('span', { class: 'tt-rivals', 'aria-hidden': 'true' },
    rivals.slice(0, 4).map((a) => h('i', { style: { background: a.color || 'var(--muted)' }, title: a.short || a.id }))) : null);
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
  const { ancestors, descendants } = chainOf(ctl.nodes, id);
  world.classList.add('has-sel');
  for (const [nid, el] of Object.entries(ctl.tiles)) {
    el.classList.toggle('hl-self', nid === id);
    el.classList.toggle('hl-anc', ancestors.has(nid));
    el.classList.toggle('hl-desc', descendants.has(nid));
  }
  const up = new Set([...ancestors, id]);
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
  const nodes = treeNodes(store);
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

function jump(store, id) {
  selectNode(store, id, { center: true });
  fillSheet(store, id);
}

function nodeLink(store, n) {
  return h('button', { class: `tt-link ns-${n.state}`, type: 'button', onclick: () => jump(store, n.id) },
    h('i', { 'aria-hidden': 'true' }, STATE_GLYPH[n.state] || ''),
    h('span', null, n.hidden ? 'Tecnologia secreta' : n.name || n.id),
    h('span', { class: 'tt-link-state' }, STATE_LABELS[n.state] || ''));
}

function sheetContent(store, n, nodes) {
  const byId = Object.fromEntries(nodes.map((x) => [x.id, x]));
  const branch = (store.data?.tech?.branches || []).find((b) => b.id === n.branch);
  const bs = BRANCH_STYLE[n.branch] || {};
  const kids = childrenMap(nodes)[n.id] || [];
  const reqs = (n.requires || []).map((r) => byId[r]).filter(Boolean);
  const head = h('div', { class: 'tt-sheet-tags' },
    chip(`${branch?.icon || bs.icon || '✦'} ${branch?.name || n.branchName || n.branch}`, ''),
    chip(`${STATE_GLYPH[n.state] || ''} ${STATE_LABELS[n.state] || n.state}`, STATE_KIND[n.state] || 'muted'));
  if (n.hidden) {
    return h('div', { class: 'node-sheet' }, head,
      h('p', null, 'Ninguém na agência sabe ainda o que existe aqui. Um acontecimento no caminho pode revelar esta pesquisa.'),
      reqs.length ? h('div', { class: 'tt-sec' }, h('h3', null, 'Ligada a'), reqs.map((r) => nodeLink(store, r))) : null);
  }
  const info = attempt(() => pointsInfo(store), {});
  const ap = info.approaches || store.data?.tech?.config?.approaches || {};
  const rivals = rivalActors(store, n);
  const missing = reqs.filter((r) => r.state !== 'done');
  const weeks = n.weeks ?? n.estWeeks;
  const boldW = n.weeksBold ?? (weeks != null ? Math.max(1, Math.round(weeks / (ap.bold?.speed || 1.65))) : null);
  const costBold = n.costBold ?? (n.cost != null ? Math.round(n.cost * (ap.bold?.costMult || 1.1)) : null);
  const out = h('div', { class: 'node-sheet' }, head,
    n.description ? h('p', null, n.description) : null,
    effectChips(n));
  out.appendChild(h('div', { class: 'tt-facts' },
    fact('Ciência', `${fmtNum(n.science || 0)} 🔬`, n.state !== 'done' && n.state !== 'active' ? `você tem ${fmtNum(info.points ?? 0)}` : null),
    fact('Verba', n.cost != null ? fmtMoney(n.cost) : '—', n.cost != null && weeks ? `total, pago ao longo do projeto (≈ ${fmtMoney(n.cost / weeks)}/sem)` : 'total, pago ao longo do projeto'),
    fact('Prazo', weeks != null ? `~${weeks} sem` : '—', 'abordagem segura')));
  if (n.state === 'active') {
    out.append(progressBar(store, n),
      h('p', { class: 'small' }, n.approach === 'bold' ? 'Abordagem ousada: mais rápida, com chance de surpresa, boa ou ruim.' : 'Abordagem segura: ritmo constante, sem surpresas.'),
      button('Cancelar projeto', () => {
        const r = store.dispatch({ type: 'research/cancel', nodeId: n.id });
        if (r?.ok) { toast(`Projeto cancelado.${r.refund ? ` ${fmtNum(r.refund)} de ciência devolvidos.` : ''}`, 'warn'); closeSheetAndClear(); }
        else toast(r?.error || 'Não foi possível cancelar.', 'bad');
      }, { kind: 'danger' }),
      h('p', { class: 'tiny muted' }, `Cancelar devolve parte da ciência (${Math.round((store.data?.tech?.config?.cancelRefund ?? 0.5) * 100)}%). A verba já gasta não volta.`));
  } else if (n.state === 'done' && n.canRefine) {
    out.append(h('p', { class: 'small' }, 'O projeto terminou com falhas. Refinar recupera o efeito completo.'),
      button('Refinar tecnologia', () => {
        const r = store.dispatch({ type: 'research/refine', nodeId: n.id });
        if (r?.ok) { toast(`Refino iniciado: ${n.name}.`, 'good'); closeSheetAndClear(); } else toast(r?.error || 'Não foi possível refinar.', 'bad');
      }, { kind: 'primary' }));
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
    if (blocked) out.appendChild(h('div', { class: 'warn-text small' }, `⚠ ${blocked}`));
    out.appendChild(
      h('div', { class: 'approach-grid' },
        approachBtn('safe', '🛡 Segura', weeks, n.cost, ap.safe?.description || 'Sem surpresas. Ideal para o que a missão precisa a tempo.', !!blocked, start),
        approachBtn('bold', '🎲 Ousada', boldW, costBold, ap.bold?.description || 'Chance de resultado inesperado: um salto ou um tropeço.', !!blocked, start)));
  } else if (n.state === 'locked') {
    out.appendChild(h('p', { class: 'small tt-locked-note' }, `🔒 Pesquise antes: ${missing.map((r) => r.hidden ? 'uma tecnologia secreta' : r.name).join(', ') || 'os pré-requisitos'}.`));
  } else if (n.state === 'done') {
    out.appendChild(h('p', { class: 'small good-text' }, `✓ Concluída${n.quality > 1 ? ', com um avanço inesperado' : ''}. Os efeitos já valem para as suas missões.`));
  }
  if (rivals.length) {
    out.appendChild(h('div', { class: 'tt-rivals-line small muted' },
      rivals.map((a) => h('i', { class: 'tt-dot', style: { background: a.color || 'var(--muted)' }, 'aria-hidden': 'true' })),
      ` Já dominam: ${rivals.map((a) => `${a.flag ? a.flag + ' ' : ''}${a.short || a.id}`).join(', ')}`));
  }
  if (reqs.length) out.appendChild(h('div', { class: 'tt-sec' }, h('h3', null, 'Requer'), reqs.map((r) => nodeLink(store, r))));
  if (kids.length) out.appendChild(h('div', { class: 'tt-sec' }, h('h3', null, 'Libera'), kids.map((k) => byId[k]).filter(Boolean).map((k) => nodeLink(store, k))));
  return out;
}

function fact(label, value, sub) {
  return h('div', { class: 'tt-fact' }, h('div', { class: 'tiny muted' }, label), h('div', { class: 'tt-fact-v' }, value), sub ? h('div', { class: 'tiny muted' }, sub) : null);
}

function approachBtn(kind, title, weeks, cost, desc, disabled, start) {
  return h('button', { class: `approach ${kind}`, type: 'button', disabled, onclick: () => start(kind) },
    h('div', { class: 'approach-title' }, title),
    h('div', { class: 'small' }, [weeks != null ? `~${weeks} semanas` : kind === 'bold' ? 'Mais rápida' : 'Mais lenta', cost != null ? fmtMoney(cost) : null].filter(Boolean).join(' · ')),
    h('div', { class: 'tiny muted' }, desc));
}

// ------------------------------------------------------------------ pan / zoom

// short phones: the tree may shrink below the old 320px floor so it (and its tools) fit above the action bar
const MIN_VP_H = 200;
const MIN_VP_H_SHORT = 160; // 320x640 and the like: the 4 tool buttons are 34px there (techtree.css)

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
  const size = () => ({ w: vp.clientWidth || 360, h: vp.clientHeight || 480 });
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
  const frontierIds = () => nodes.filter((n) => n.state === 'available' || n.state === 'active').map((n) => n.id);
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
      const t = lay.geom.tile;
      v.x = w / 2 - (p.x + t / 2) * v.s;
      v.y = visibleMidY(vp, hh) - (p.y + t / 2) * v.s; // middle of the strip the sheet leaves visible
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
    const t = lay.geom.tile;
    const sx = v.x + p.x * v.s, sy = v.y + p.y * v.s;
    if (sx < 0 || sy < 0 || sx + t * v.s > w || sy + t * v.s > hh) { v.x = w / 2 - (p.x + t / 2) * v.s; v.y = hh / 2 - (p.y + t / 2) * v.s; commit(true); }
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

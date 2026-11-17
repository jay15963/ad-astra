// Tech tree graph (research-tab.js): pure layout, tiers, chains and node states (no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { computeTiers, layoutTree, chainOf, edgeState, fitView, rectOf, treeNodes, childrenMap, GEOM } from '../src/ui/research-tab.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const nodes = data.tech.nodes;
const branches = data.tech.branches;

test('tiers follow prerequisite depth (tier override allowed only for prerequisite-free or deeper placement)', () => {
  const t = computeTiers(nodes);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const r of n.requires) assert.ok(t[n.id] > t[r], `${n.id} (${t[n.id]}) must sit right of ${r} (${t[r]})`);
    if (!Number.isInteger(n.tier)) assert.equal(t[n.id], n.requires.length ? 1 + Math.max(...n.requires.map((r) => t[r])) : 0, n.id);
  }
  assert.equal(t.prop_nuclear_thermal, 3, 'cryo(1) + fission(2) → 3');
  assert.ok(byId.en_solar && t.en_solar === 0);
  // synthetic: depth + cycle safety
  const tt = computeTiers([{ id: 'a', requires: [] }, { id: 'b', requires: ['a'] }, { id: 'c', requires: ['b', 'a'] }, { id: 'x', requires: ['y'] }, { id: 'y', requires: ['x'] }]);
  assert.deepEqual([tt.a, tt.b, tt.c], [0, 1, 2]);
  assert.ok(Number.isFinite(tt.x) && Number.isFinite(tt.y));
});

test('layout: every node placed, no overlaps, inside its branch band, 6 bands', () => {
  const lay = layoutTree(nodes, branches);
  assert.equal(lay.bands.length, 6);
  const seen = new Set();
  for (const n of nodes) {
    const p = lay.pos[n.id];
    assert.ok(p, `${n.id} placed`);
    const key = `${p.x},${p.y}`;
    assert.ok(!seen.has(key), `overlap at ${key} (${n.id})`);
    seen.add(key);
    const band = lay.bands.find((b) => b.id === n.branch);
    assert.ok(p.y >= band.y && p.y + GEOM.tile <= band.y + band.h, `${n.id} inside ${band.id}`);
    assert.ok(p.x >= 0 && p.x + GEOM.tile <= lay.width && p.y + GEOM.tile <= lay.height);
  }
  // bands do not overlap and stack top to bottom
  for (let i = 1; i < lay.bands.length; i++) assert.ok(lay.bands[i].y >= lay.bands[i - 1].y + lay.bands[i - 1].h - 0.001);
  // compact enough for a phone: at most 3 rows per band with the shipped overrides
  for (const b of lay.bands) assert.ok(b.rows <= 3, `${b.id}: ${b.rows} rows`);
  // same-branch single-parent chains run straight when possible
  assert.equal(lay.pos.sci_isru.y, lay.pos.sci_lunar_prospect.y);
  assert.equal(lay.pos.sci_lunar_prospect.y, lay.pos.sci_sample_curation.y);
});

test('layout: one orthogonal edge per prerequisite, from parent right side to child left side', () => {
  const lay = layoutTree(nodes, branches);
  const total = nodes.reduce((a, n) => a + n.requires.length, 0);
  assert.equal(lay.edges.length, total);
  for (const e of lay.edges) {
    const a = e.points[0], b = e.points[e.points.length - 1];
    assert.equal(a[0], lay.pos[e.from].x + GEOM.tile);
    assert.equal(b[0], lay.pos[e.to].x);
    for (let i = 1; i < e.points.length; i++) {
      const [p, q] = [e.points[i - 1], e.points[i]];
      assert.ok(p[0] === q[0] || p[1] === q[1], `${e.from}->${e.to} segment ${i} is not orthogonal`);
    }
    assert.match(e.d, /^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/);
  }
});

test('row override is honoured', () => {
  const ns = [{ id: 'a', branch: 'x', requires: [] }, { id: 'b', branch: 'x', requires: [], row: 2 }];
  const lay = layoutTree(ns, [{ id: 'x', name: 'X' }]);
  assert.equal(lay.pos.b.row, 2);
  assert.equal(lay.bands[0].rows, 3);
});

test('chainOf: ancestors and descendants', () => {
  const c = chainOf(nodes, 'prop_nuclear_thermal');
  assert.deepEqual([...c.ancestors].sort(), ['en_batteries', 'en_fission', 'en_solar', 'prop_cryo_storage', 'prop_methalox']);
  assert.equal(c.descendants.size, 0);
  const s = chainOf(nodes, 'en_solar');
  assert.ok(s.descendants.has('prop_electric') && s.descendants.has('prop_nuclear_thermal') && s.descendants.has('sec_beamed_power'));
  assert.equal(s.ancestors.size, 0);
  assert.deepEqual(childrenMap(nodes).str_heatshield.sort(), ['ls_abort', 'str_radiation']);
});

test('edge states and view fitting', () => {
  assert.equal(edgeState('done', 'done'), 'done');
  assert.equal(edgeState('done', 'available'), 'ready');
  assert.equal(edgeState('available', 'locked'), 'locked');
  const v = fitView({ x: 0, y: 0, w: 600, h: 1200 }, 300, 600, { min: 0.1, max: 2, pad: 0 });
  assert.equal(v.s, 0.5);
  assert.equal(v.x, 0);
  assert.equal(v.y, 0);
  const lay = layoutTree(nodes, branches);
  const r = rectOf(lay, ['en_solar', 'en_fission']);
  assert.ok(r.w > GEOM.tile && r.h >= GEOM.tile);
  assert.equal(rectOf(lay, []), null);
});

test('treeNodes merges the sim view and hides unknown secrets as "?"', async () => {
  // minimal store over plain state + a fake research/tree
  const tree = nodes.filter((n) => !n.secret).map((n) => ({ id: n.id, status: n.requires.length ? 'locked' : 'available', name: n.name }));
  const store = { data, state: { research: { unlocked: [], projects: [] }, actors: {} }, tryQuery: (q, fb) => (q === 'research/tree' ? tree : fb) };
  const list = treeNodes(store);
  assert.equal(list.length, nodes.length);
  const sec = list.find((n) => n.id === 'sec_echo_analysis');
  assert.equal(sec.state, 'secret');
  assert.ok(sec.hidden);
  const solar = list.find((n) => n.id === 'en_solar');
  assert.equal(solar.state, 'available');
  assert.ok(solar.icon && solar.short, 'layout fields kept from data');
  // fallback without the query
  const bare = treeNodes({ data, state: { research: { unlocked: ['en_solar'], projects: [{ nodeId: 'en_batteries', progress: 0.5 }], rivals: { cnsa: ['en_solar'] } } }, tryQuery: (q, fb) => fb });
  assert.equal(bare.find((n) => n.id === 'en_solar').state, 'done');
  assert.equal(bare.find((n) => n.id === 'en_batteries').state, 'active');
  assert.equal(bare.find((n) => n.id === 'prop_electric').state, 'available');
  assert.deepEqual(bare.find((n) => n.id === 'en_solar').rivalsWith, ['cnsa']);
  assert.equal(bare.find((n) => n.id === 'sec_beamed_power').state, 'secret');
});

test('every node has an icon and a short label for its tile', () => {
  for (const n of nodes) {
    assert.ok(n.icon, `${n.id} icon`);
    assert.ok(n.short && n.short.length <= 22, `${n.id} short "${n.short}"`);
  }
});

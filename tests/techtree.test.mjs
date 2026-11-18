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

// ---------------------------------------------------------------- Missões v2: one era at a time (MISSIONS-V2 §6)

const RT = await import('../src/ui/research-tab.js');
const { withStubTree } = await import('./fixtures/techtree-stub.mjs');
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const stubD = withStubTree(campaign);
const fakeStore = (d, state = {}) => ({ data: d, state: { research: { unlocked: [], projects: [], rivals: {} }, ...state }, tryQuery: () => null });
const stubNodes = RT.treeNodes(fakeStore(stubD));

test('v2 eraGraph: only the era, cross-era prerequisites as one stub per (target, branch) at tier 0', () => {
  const e3 = RT.eraGraph(stubNodes, 'e3');
  const real = e3.filter((n) => !n.stub);
  assert.ok(real.length > 0 && real.every((n) => RT.eraOf(n) === 'e3'));
  const stubs = e3.filter((n) => n.stub);
  const reuse = e3.find((n) => n.id === 'zt3_vehicle_reusable');
  assert.deepEqual(reuse.requires, ['@zt1_vehicle_heavy@propulsion']);
  const st = stubs.find((n) => n.id === '@zt1_vehicle_heavy@propulsion');
  assert.equal(st.target, 'zt1_vehicle_heavy');
  assert.equal(st.eraId, 'e1');
  assert.equal(st.branch, 'propulsion');
  assert.equal(new Set(stubs.map((n) => n.id)).size, stubs.length, 'no duplicate stubs');
  const tiers = computeTiers(e3);
  for (const s of stubs) assert.equal(tiers[s.id], 0);
  // every requires of the subgraph resolves inside it
  const ids = new Set(e3.map((n) => n.id));
  for (const n of e3) for (const r of n.requires) assert.ok(ids.has(r), `${n.id} → ${r}`);
});

test('v2 eraGraph onlyUnlocks: efficiency nodes hidden, chains reconnected to the nearest kept ancestor', () => {
  const nodes = [
    { id: 'u1', branch: 'p', era: 2, unlocks: [{ key: 'vehicle:a' }], requires: [] },
    { id: 'e1', branch: 'p', era: 2, requires: ['u1'] },
    { id: 'e2', branch: 'p', era: 2, requires: ['e1', 'old'] },
    { id: 'u2', branch: 'p', era: 2, unlocks: [{ key: 'vehicle:b' }], requires: ['e2'] },
    { id: 'old', branch: 's', era: 1, requires: [] },
  ].map((n) => ({ ...n, kind: n.unlocks ? 'unlock' : 'efficiency' }));
  const g = RT.eraGraph(nodes, 'e2', { onlyUnlocks: true });
  assert.deepEqual(g.filter((n) => !n.stub).map((n) => n.id), ['u1', 'u2']);
  assert.deepEqual(g.find((n) => n.id === 'u2').requires.sort(), ['@old@p', 'u1']);
});

test('v2 tile sizes: unlock 80, efficiency 60, stub 56 wide; layoutGrid centres them, no overlaps, edges avoid tiles', () => {
  assert.deepEqual(RT.tileOf({ kind: 'unlock' }), { w: 80, h: 80 });
  assert.deepEqual(RT.tileOf({ kind: 'efficiency' }), { w: 60, h: 60 });
  assert.equal(RT.tileOf({ stub: true }).w, 56);
  for (const era of ['e1', 'e3', 'e4']) {
    const nodes = RT.eraGraph(stubNodes, era);
    assert.ok(nodes.length <= RT.MAX_TILES, `${era}: ${nodes.length} tiles`);
    for (const per of [1, 3]) {
      const lay = RT.layoutGrid(nodes, campaign.tech.branches, per, {}, RT.tileOf);
      const rects = [];
      for (const n of nodes) {
        const p = lay.pos[n.id];
        assert.ok(p, `${n.id} placed`);
        const t = RT.tileOf(n);
        assert.equal(p.w, t.w);
        assert.equal(p.h, t.h);
        assert.equal(p.x + p.w / 2, p.cx + 40, 'centred in its lane');
        assert.ok(p.y >= p.cy && p.y + p.h <= p.cy + p.ch, 'inside its tier row');
        const b = lay.bands.find((x) => x.id === n.branch);
        assert.ok(p.x >= b.x && p.x + p.w <= b.x + b.w && p.y >= b.y && p.y + p.h <= b.y + b.h, `${n.id} inside its band`);
        rects.push([p.x, p.y, p.x + p.w, p.y + p.h, n.id]);
      }
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const [a, c] = [rects[i], rects[j]];
        assert.ok(a[2] <= c[0] || c[2] <= a[0] || a[3] <= c[1] || c[3] <= a[1], `${a[4]} overlaps ${c[4]}`);
      }
      for (const e of lay.edges) {
        const a = e.points[0], z = e.points[e.points.length - 1];
        const P = lay.pos[e.from], C = lay.pos[e.to];
        assert.deepEqual(a, [P.x + P.w / 2, P.y + P.h], 'leaves the bottom of its tile');
        assert.deepEqual(z, [C.x + C.w / 2, C.y], 'enters the top');
        for (let i = 1; i < e.points.length; i++) {
          const [p, q] = [e.points[i - 1], e.points[i]];
          assert.ok(p[0] === q[0] || p[1] === q[1], 'orthogonal');
          const [x0, x1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])], [y0, y1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
          for (const r of rects) {
            if (r[4] === e.from || r[4] === e.to) continue;
            assert.ok(!(x0 < r[2] - 1 && x1 > r[0] + 1 && y0 < r[3] - 1 && y1 > r[1] + 1), `${e.from}->${e.to} crosses ${r[4]}`);
          }
        }
      }
    }
  }
  // without tileOf the classic uniform layout is unchanged (ui-layout tests cover it in depth)
  const plain = RT.layoutGrid(stubNodes.filter((n) => RT.eraOf(n) === 'e4'), campaign.tech.branches, 3);
  for (const p of Object.values(plain.pos)) assert.deepEqual([p.w, p.h, p.x, p.y], [80, 80, p.cx, p.cy]);
});

test('v2 searchNodes: accent/case-insensitive, unlock labels and target names, best match first, ≤ 20', () => {
  const nodes = [
    { id: 'a', name: 'Motores a hidrogênio', short: 'Hidrogênio', unlocks: [{ label: 'Estágios a hidrogênio' }] },
    { id: 'b', name: 'Integração de cargas pesadas', unlocks: [{ label: 'Lançadores pesados' }], targetNames: ['Saturn IB', 'Proton'] },
    { id: 'c', name: 'Órbita geoestacionária', short: 'GEO' },
    { id: 'd', name: 'Segredo', hidden: true },
    { id: 'e', name: 'Turbobombas de hidrogenio leves' },
  ];
  assert.deepEqual(RT.searchNodes(nodes, 'hidro').map((n) => n.id), ['a', 'e']);
  assert.deepEqual(RT.searchNodes(nodes, 'ORBITA').map((n) => n.id), ['c']);
  assert.deepEqual(RT.searchNodes(nodes, 'proton').map((n) => n.id), ['b'], 'catalog names a key unlocks');
  assert.deepEqual(RT.searchNodes(nodes, 'lançadores').map((n) => n.id), ['b']);
  assert.deepEqual(RT.searchNodes(nodes, 'seg'), [], 'hidden secrets never match');
  assert.deepEqual(RT.searchNodes(nodes, 'h'), [], 'two letters at least');
  const many = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, name: `Nó ${i} propulsão`, short: `P${i}` }));
  const t0 = performance.now();
  const r = RT.searchNodes(many, 'propulsao');
  const ms = performance.now() - t0;
  assert.equal(r.length, 20);
  assert.ok(ms < 50, `search over 600 nodes took ${ms.toFixed(1)} ms`);
  const t1 = performance.now();
  RT.searchNodes(many, 'propul');
  assert.ok(performance.now() - t1 < 5, 'second search (cached text) ≤ 5 ms');
});

test('v2 effectShort: compact mono chip for efficiency tiles', () => {
  assert.equal(RT.effectShort({ launchCost: -0.03 }), '−3% lanç.');
  assert.equal(RT.effectShort({ reliability: 0.02 }), '+2 pp conf.');
  assert.equal(RT.effectShort({ researchSlots: 1 }), '+1 proj.');
  assert.equal(RT.effectShort({ maintenance: -0.1 }, { maintenance: { unit: 'pctNeg' } }), '−10% manut.');
  assert.equal(RT.effectShort({}), null);
});

test('v2 treeNodes decorates nodes without the sim view (kind, unlockKind, unlock labels, eraId)', () => {
  const v = stubNodes.find((n) => n.id === 'zt1_crewed_capsule');
  assert.equal(v.kind, 'unlock');
  assert.equal(v.unlockKind, 'missionType');
  assert.equal(v.eraId, 'e1');
  assert.deepEqual(v.unlocks.map((u) => u.kind), ['missionType', 'spacecraft', 'vehicle']);
  const e = stubNodes.find((n) => n.kind === 'efficiency');
  assert.ok(e && e.unlockKind === null);
});

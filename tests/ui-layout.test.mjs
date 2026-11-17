// Phone layout polish: portrait tech-tree grid (research-tab.js), map level fit above the window chips and
// "não dá para chegar antes do fim de 2030" window marks (map.js). Pure functions only (no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { layoutTree, layoutGrid, pickLayout, branchOrder, computeTiers, VGEOM } from '../src/ui/research-tab.js';
import { getLevels, fitLevel, levelForSpan, lateInfo, windowSummaries } from '../src/ui/map.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const nodes = data.tech.nodes;
const branches = data.tech.branches;
const fit = (lay, w, h) => Math.min(w / lay.width, h / lay.height);

test('tech tree grid: branch order puts feeder branches first', () => {
  const order = branchOrder(nodes, branches);
  assert.equal(order.length, 6);
  const at = Object.fromEntries(order.map((b, i) => [b, i]));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    for (const r of n.requires) {
      if (byId[r].branch !== n.branch) assert.ok(at[byId[r].branch] < at[n.branch], `${byId[r].branch} before ${n.branch}`);
    }
  }
});

test('tech tree grid: every node placed once, inside its group, parents above children, edges avoid tiles', () => {
  const T = VGEOM.tile;
  const tiers = computeTiers(nodes);
  for (const per of [1, 2, 3, 6]) {
    const lay = layoutGrid(nodes, branches, per);
    assert.equal(lay.orient, 'v');
    assert.equal(lay.bands.length, 6);
    const seen = new Set();
    for (const n of nodes) {
      const p = lay.pos[n.id];
      assert.ok(p, `${n.id} placed`);
      assert.ok(!seen.has(`${p.x},${p.y}`), `overlap ${n.id}`);
      seen.add(`${p.x},${p.y}`);
      const b = lay.bands.find((x) => x.id === n.branch);
      assert.ok(p.x >= b.x && p.x + T <= b.x + b.w && p.y >= b.y + 20 && p.y + T <= b.y + b.h, `${n.id} inside ${b.id} (per ${per})`);
      assert.ok(p.x + T <= lay.width && p.y + T <= lay.height);
      assert.equal(p.tier, tiers[n.id]);
    }
    // groups never overlap
    for (const a of lay.bands) {
      for (const b of lay.bands) {
        if (a === b) continue;
        const sep = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(sep, `${a.id} overlaps ${b.id}`);
      }
    }
    const total = nodes.reduce((s, n) => s + n.requires.length, 0);
    assert.equal(lay.edges.length, total);
    const rects = Object.values(lay.pos).map((p) => [p.x + 1, p.y + 1, p.x + T - 1, p.y + T - 1]);
    for (const e of lay.edges) {
      const a = e.points[0], z = e.points[e.points.length - 1];
      assert.deepEqual(a, [lay.pos[e.from].x + T / 2, lay.pos[e.from].y + T], `${e.from} leaves from the bottom`);
      assert.deepEqual(z, [lay.pos[e.to].x + T / 2, lay.pos[e.to].y], `${e.to} entered from the top`);
      for (let i = 1; i < e.points.length; i++) {
        const [p, q] = [e.points[i - 1], e.points[i]];
        assert.ok(p[0] === q[0] || p[1] === q[1], `${e.from}->${e.to} orthogonal`);
        const [x0, x1] = [Math.min(p[0], q[0]), Math.max(p[0], q[0])];
        const [y0, y1] = [Math.min(p[1], q[1]), Math.max(p[1], q[1])];
        for (const r of rects) {
          const hit = x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1];
          assert.ok(!hit, `${e.from}->${e.to} crosses a tile at ${r} (per ${per})`);
        }
      }
      assert.match(e.d, /^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)+$/);
    }
  }
});

test('tech tree grid: a phone overview is much bigger than the old stacked bands', () => {
  const old = layoutTree(nodes, branches);
  for (const [w, h] of [[349, 472], [294, 340]]) {
    const lay = pickLayout(nodes, branches, w, h);
    assert.ok(fit(lay, w, h) >= fit(old, w, h) * 1.35, `${w}x${h}: ${fit(lay, w, h).toFixed(3)} vs ${fit(old, w, h).toFixed(3)}`);
    assert.ok(lay.width / lay.height > 0.6 && lay.width / lay.height < 1.2, 'portrait-friendly aspect');
    assert.equal(lay.perRow, 3);
  }
  // a phone on its side gets wider rows
  assert.ok(pickLayout(nodes, branches, 454, 160).perRow >= 5);
});

test('map: levels fit above the window chips on a 320x640 phone without changing the level pill', () => {
  const levels = getLevels({ ...data, bodies: data.bodies });
  const inner = levels.find((l) => l.id === 'inner');
  // 320x640: stage ~320x404, chips/warnings ~150 px at the bottom
  const W = 320, H = 404, bottom = 150;
  const f = fitLevel(inner, levels, W, H, { bottom });
  const s = Math.min(W, H) / f.span; // px per world unit
  const sunY = H / 2 - f.dy;
  const venus = data.bodies.bodies.find((b) => b.id === 'venus');
  const vr = venus.orbit.radius * s + (venus.display?.minPx || 7);
  assert.ok(sunY + vr <= H - bottom, `Vênus clears the chips (${(sunY + vr).toFixed(0)} <= ${H - bottom})`);
  const belt = data.bodies.bodies.find((b) => b.id === 'asteroid_belt').belt.outer * s;
  assert.ok(sunY + belt <= H - bottom + 2 && sunY - belt >= -2, 'the whole inner system fits the free area');
  for (const l of levels) assert.equal(levelForSpan(levels, fitLevel(l, levels, W, H, { bottom }).span).id, l.id, `${l.id} pill stays`);
  // tall phone: nothing to do
  const big = fitLevel(inner, levels, 375, 600, { bottom: 150 });
  assert.equal(big.k, 1);
});

test('map: windows that cannot arrive by the end are marked and listed last', () => {
  const st = { turn: 0, startYear: 2026, endTurn: 259, actors: {}, calendar: [], missions: [] };
  const far = lateInfo(st, data, ['jupiter'], { openTurn: 42 });
  assert.equal(far.late, true);
  assert.equal(far.lateText, 'Não dá para chegar antes do fim de 2030');
  assert.equal(lateInfo(st, data, ['mars_orbit'], { openTurn: 39 }).late, false);
  const list = windowSummaries(st, data, () => undefined);
  assert.ok(list.length > 2);
  const firstLate = list.findIndex((w) => w.late);
  if (firstLate >= 0) assert.ok(list.slice(firstLate).every((w) => w.late), 'reachable windows first');
  assert.ok(list.some((w) => w.late) && list.some((w) => !w.late));
});

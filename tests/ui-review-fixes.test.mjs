// UI review fixes (mobile): late arrivals flagged in the builder/dashboard, in-transit results not shown as final,
// map destination handed to the builder, level pill vs followed body, label collisions (map transit, world map).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function newStore(playerId = 'nasa', seed = 7919) {
  const data = await loadDataNode(root);
  const { createStore } = await import('../src/ui/store.js');
  const store = createStore(data, { storage: memStorage() });
  store.newGame({ playerId, seed });
  return store;
}

test('arrivalOf / sortByArrival: missions that land after the campaign end are flagged and listed last', async () => {
  const { arrivalOf, sortByArrival } = await import('../src/ui/missions-tab.js');
  assert.deepEqual(arrivalOf({ transitWeeks: 680 }, 10, 259), { arriveTurn: 690, late: true });
  assert.deepEqual(arrivalOf({ transitWeeks: 30 }, 10, 259), { arriveTurn: 40, late: false });
  assert.equal(arrivalOf({ transitWeeks: 0 }, 300, 259).late, false, 'Earth orbit has no arrival to miss');
  const list = [{ id: 'uranus', transitWeeks: 680 }, { id: 'mars', transitWeeks: 30 }, { id: 'leo', transitWeeks: 0 }, { id: 'pluto', transitWeeks: 495 }];
  assert.deepEqual(sortByArrival(list, () => 5, 259).map((x) => x.id), ['mars', 'leo', 'uranus', 'pluto']);
});

test('every destination the builder lists late really arrives after endTurn (real data)', async () => {
  const store = await newStore();
  const { arrivalOf } = await import('../src/ui/missions-tab.js');
  const st = store.state;
  const late = store.data.destinations.destinations.filter((d) => arrivalOf(d, st.turn, st.endTurn).late).map((d) => d.id);
  for (const id of ['uranus_orbit', 'kuiper', 'neptune_flyby', 'pluto_flyby']) assert.ok(late.includes(id), `${id} late`);
  assert.ok(!late.includes('mars_orbit') && !late.includes('venus_orbit'));
});

test('dashboard next window skips destinations that would arrive after 2030', async () => {
  const store = await newStore();
  const { reachableNextWindow } = await import('../src/ui/dashboard.js');
  const st = store.state;
  const w = reachableNextWindow(store);
  assert.ok(w, 'some reachable window exists');
  const dest = store.data.index.destinations[w.destination];
  assert.ok(Math.max(st.turn, w.openTurn) + (dest.transitWeeks || 0) <= st.endTurn, `${w.destination} arrives before the end`);
  assert.notEqual(w.destination, 'pluto_flyby');
});

test('isProvisionalResult: an ascent-only result in transit is not the mission outcome', async () => {
  const { isProvisionalResult } = await import('../src/ui/missions-tab.js');
  const r = { outcome: 'total', phase: 'ascent' };
  assert.equal(isProvisionalResult({ status: 'transit', result: r, transit: {} }), true);
  assert.equal(isProvisionalResult({ status: 'arrival', result: r }), true);
  assert.equal(isProvisionalResult({ status: 'operations', result: r, transit: {} }), true);
  assert.equal(isProvisionalResult({ status: 'operations', result: { outcome: 'total', phase: 'arrival' }, transit: {} }), false);
  assert.equal(isProvisionalResult({ status: 'done', result: r }), false);
  assert.equal(isProvisionalResult({ status: 'transit', result: null }), false);
});

test('map "Planejar missão": the builder starts on that destination with a compatible type', async () => {
  const store = await newStore();
  const { planMissionFor, currentDraft, defaultTypeFor } = await import('../src/ui/missions-tab.js');
  const idx = store.data.index.destinations;
  assert.equal(planMissionFor(store, 'venus_orbit'), true);
  assert.equal(currentDraft().destination, 'venus_orbit');
  assert.ok(idx.venus_orbit.missionTypes.includes(currentDraft().type));
  assert.equal(defaultTypeFor(idx.lunar_surface), 'lander');
  assert.equal(defaultTypeFor(idx.leo), 'satellite');
  assert.equal(defaultTypeFor(idx.leo, 'crewed'), 'crewed');
  assert.equal(defaultTypeFor(idx.mars_orbit), 'probe');
  assert.equal(defaultTypeFor(idx.venus_atmosphere, 'lander'), 'lander');
  assert.equal(planMissionFor(store, 'nowhere'), false);
  const opts = store.tryQuery('missions/draftOptions', null, currentDraft());
  const d = (opts?.destinations || []).find((x) => (x.id || x) === 'venus_orbit');
  assert.ok(d, 'venus_orbit offered by the sim');
});

test('map level pill: framing Venus up close highlights no level; Earth and the Moon keep Terra-Lua', async () => {
  const { activeLevelFor } = await import('../src/ui/map.js');
  const levels = [{ id: 'earth_moon', focus: 'earth', span: 104 }, { id: 'inner', focus: 'sun', span: 1400 }, { id: 'outer', focus: 'sun', span: 3860 }];
  const parentOf = (id) => ({ moon: 'earth', venus: 'sun', mars: 'sun' }[id] ?? null);
  assert.equal(activeLevelFor(levels, 150, 'venus', parentOf), null);
  assert.equal(activeLevelFor(levels, 104, 'earth', parentOf).id, 'earth_moon');
  assert.equal(activeLevelFor(levels, 120, 'moon', parentOf).id, 'earth_moon');
  assert.equal(activeLevelFor(levels, 1400, 'sun', parentOf).id, 'inner');
  assert.equal(activeLevelFor(levels, 1300, 'mars', parentOf).id, 'inner');
});

test('placeLabels avoids boxes already taken by another pass (transit label vs body label)', async () => {
  const { placeLabels } = await import('../src/ui/map.js');
  const taken = [{ bx: 80, by: 70, w: 50, h: 14 }];
  const [p] = placeLabels([{ id: 't', text: 'Sonda Vênus-1', x: 100, y: 92, r: 8, w: 70, h: 13, prio: 0 }], { width: 400, height: 400, taken });
  assert.ok(p, 'placed');
  const o = taken[0];
  assert.ok(!(p.bx < o.bx + o.w && p.bx + p.w > o.bx && p.by < o.by + o.h && p.by + p.h > o.by), 'no overlap');
});

test('world map label helpers: overlap test and nudge off obstacles', async () => {
  const { rectsOverlap, placeAway } = await import('../src/ui/worldmap.js');
  assert.equal(rectsOverlap([0, 0, 10, 10], [5, 5, 10, 10]), true);
  assert.equal(rectsOverlap([0, 0, 10, 10], [20, 20, 5, 5]), false);
  const obstacles = [[90, 90, 40, 20]];
  const [x, y] = placeAway(100, 100, 30, 14, obstacles, { dx: 0, dy: -1 });
  assert.ok(!rectsOverlap([x - 15, y - 7, 30, 14], obstacles[0]), 'badge moved off the HQ tag');
  assert.deepEqual(placeAway(10, 10, 5, 5, obstacles), [10, 10], 'free spot unchanged');
});

test('research sheet: no native append() of a possibly-null child (would print "null"); budget is a total', () => {
  const src = fs.readFileSync(path.join(root, 'src/ui/research-tab.js'), 'utf8');
  const bad = [...src.matchAll(/\.append\(\s*\n?\s*[\w.?]+ \? h\([^;]*?: null,/g)].map((m) => m[0].slice(0, 80));
  assert.deepEqual(bad, []);
  assert.doesNotMatch(src, /paga por semana/);
});

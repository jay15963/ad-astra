// Tests for the map module's pure model (src/ui/map.js exports) and data/bodies.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import {
  render, getBodies, getLevels, bodyPositions, computeWindow, windowFor, windowSummaries, computeFog, presence,
  activeTransits, windowWarnings, buildMetro, buildModel, destAnchors, energyWord, makeQuery,
} from '../src/ui/map.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = await loadDataNode(root);

// Fixture destinations (the real catalog may still be empty while modules are written in parallel).
const FIX_DEST = [
  { id: 'leo', name: 'Órbita baixa', body: 'earth', transitWeeks: 0, window: null, route: [{ from: 'earth', to: 'leo', dv: 9.4 }], firsts: {} },
  { id: 'iss', name: 'ISS', body: 'earth', transitWeeks: 0, window: null, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: 'iss', dv: 0.3 }], firsts: {} },
  { id: 'lunar_orbit', name: 'Órbita lunar', body: 'moon', transitWeeks: 1, window: null, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: 'tli', dv: 3.1 }, { from: 'tli', to: 'lunar_orbit', dv: 0.9 }], firsts: { crewed: 'crewed_lunar_orbit' } },
  { id: 'lunar_surface', name: 'Superfície lunar', body: 'moon', transitWeeks: 1, window: null, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: 'tli', dv: 3.1 }, { from: 'tli', to: 'lunar_orbit', dv: 0.9 }, { from: 'lunar_orbit', to: 'lunar_surface', dv: 1.9 }], firsts: { crewed: 'crewed_lunar_landing' } },
  { id: 'mars_surface', name: 'Superfície de Marte', body: 'mars', transitWeeks: 30, window: { periodWeeks: 113, phaseTurn: 40, openWeeks: 8 }, route: [{ from: 'earth', to: 'leo', dv: 9.4 }, { from: 'leo', to: 'tmi', dv: 3.6 }, { from: 'tmi', to: 'mars_surface', dv: 1.5 }], firsts: { robotic: 'mars_landing_robotic' } },
];
function withDest(extra = {}) {
  const d = { ...real, destinations: { destinations: FIX_DEST }, calendar: { missions: [
    { id: 'cal_change7', name: "Chang'e 7", owner: 'cnsa', partners: [], type: 'lander', destination: 'lunar_surface' },
    { id: 'cal_tianwen', name: 'Tianwen-3', owner: 'cnsa', partners: ['esa'], type: 'probe', destination: 'mars_surface' },
  ] }, ...extra };
  d.index = { ...real.index, destinations: Object.fromEntries(FIX_DEST.map((x) => [x.id, x])), calendar: Object.fromEntries(d.calendar.missions.map((x) => [x.id, x])) };
  return d;
}
const baseState = (o = {}) => ({ turn: 10, startYear: 2026, seed: 1, playerId: 'nasa', actors: { nasa: { color: '#4895ef', short: 'NASA' }, cnsa: { color: '#e63946', short: 'CNSA' } }, missions: [], calendar: [], firsts: {}, ...o });

test('bodies.json: required bodies with ficha, display and levels', () => {
  const ids = getBodies(real).map((b) => b.id);
  for (const id of ['sun', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'titan']) assert.ok(ids.includes(id), id);
  for (const b of getBodies(real)) {
    for (const k of ['tipo', 'gravidade', 'atmosfera', 'historia']) assert.ok(b.ficha?.[k], `${b.id}.${k}`);
    assert.ok(Array.isArray(b.ficha.recursos) && Array.isArray(b.ficha.perigos));
    assert.ok(b.display?.color && b.display.radius > 0);
  }
  assert.equal(getLevels(real).length, 3);
  const anchored = Object.keys(destAnchors(real));
  for (const id of ['leo', 'sso', 'gto', 'iss', 'cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole', 'mars_orbit', 'mars_surface', 'jupiter', 'titan']) assert.ok(anchored.includes(id), id);
  assert.equal(real.index.bodies.moon.name, 'Lua');
});

test('positions are deterministic, finite, and planets move over time', () => {
  const a = bodyPositions(real, 0);
  const b = bodyPositions(real, 26);
  assert.deepEqual(a, bodyPositions(real, 0));
  for (const p of Object.values(a)) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.notDeepEqual(a.earth, b.earth);
  // moon stays near earth
  assert.ok(Math.hypot(a.moon.x - a.earth.x, a.moon.y - a.earth.y) < 60);
});

test('mars phasing follows the window: Mars leads Earth by ~44° when the window opens', () => {
  const data = withDest();
  const p = bodyPositions(data, 40);
  const ang = (q) => Math.atan2(-q.y, q.x) / (Math.PI / 180);
  const lead = ((ang(p.mars) - ang(p.earth)) % 360 + 360) % 360;
  assert.ok(Math.abs(lead - 44) < 1, `lead ${lead}`);
});

test('computeWindow and windowFor fallback / query', () => {
  const w = { periodWeeks: 113, phaseTurn: 40, openWeeks: 8 };
  assert.deepEqual(computeWindow(w, 10), { openTurn: 40, closeTurn: 47, periodWeeks: 113 });
  assert.equal(computeWindow(w, 45).openTurn, 40);
  assert.equal(computeWindow(w, 48).openTurn, 153);
  assert.equal(computeWindow(null, 3), null);
  const data = withDest();
  const st = baseState();
  const f = windowFor(st, data, 'mars_surface', () => undefined);
  assert.equal(f.open, false);
  assert.equal(f.weeksToOpen, 30);
  assert.equal(windowFor(st, data, 'leo', () => undefined), null);
  // query result wins when sane; Infinity close = no window
  assert.equal(windowFor(st, data, 'mars_surface', () => ({ openTurn: 5, closeTurn: 12 })).open, true);
  assert.equal(windowFor(st, data, 'leo', () => ({ openTurn: 10, closeTurn: Infinity })), null);
  const sum = windowSummaries(st, data, () => undefined);
  assert.equal(sum.length, 1);
  assert.match(sum[0].text, /Próxima janela para Marte em \d+ meses/);
});

test('fog of war: unknown → partial (rival) → known (player)', () => {
  const data = withDest();
  let st = baseState();
  let fog = computeFog(st, data);
  assert.equal(fog.bodies.earth, 'known');
  assert.equal(fog.bodies.moon, 'unknown');
  st = baseState({ calendar: [{ id: 'cal_change7', status: 'success', currentTurn: 2, plannedTurn: 2 }] });
  fog = computeFog(st, data);
  assert.equal(fog.bodies.moon, 'partial');
  assert.equal(fog.dests.lunar_surface, 'rival');
  st.missions.push({ id: 'm1', name: 'Artemis III', destination: 'lunar_surface', status: 'done', result: { outcome: 'total', resolvedTurn: 9 } });
  fog = computeFog(st, data);
  assert.equal(fog.bodies.moon, 'known');
  assert.equal(fog.dests.lunar_surface, 'player');
  // failed mission does not reveal
  const st2 = baseState({ missions: [{ id: 'm2', destination: 'mars_surface', status: 'done', result: { outcome: 'catastrophic' } }] });
  assert.equal(computeFog(st2, data).bodies.mars, 'unknown');
  // firsts reveal through bodies.json milestones
  const st3 = baseState({ firsts: { mars_landing_robotic: { actorId: 'nasa', turn: 3 } } });
  assert.equal(computeFog(st3, data).bodies.mars, 'known');
});

test('presence flags per body, partners included, Earth excluded', () => {
  const data = withDest();
  const st = baseState({ turn: 60, calendar: [{ id: 'cal_tianwen', status: 'success', currentTurn: 20 }], firsts: { commercial_station: { actorId: 'spacex', turn: 1 } } });
  const pr = presence(st, data);
  assert.deepEqual(pr.mars.map((e) => e.actorId).sort(), ['cnsa', 'esa']);
  assert.equal(pr.earth, undefined);
  // still in transit at turn 30 → not present yet
  assert.equal(presence({ ...st, turn: 30 }, data).mars, undefined);
});

test('active transits: player transit progress, rival launches, operations', () => {
  const data = withDest();
  const st = baseState({
    turn: 30,
    missions: [
      { id: 'm1', name: 'Rover', destination: 'mars_surface', status: 'transit', transit: { departTurn: 20, arriveTurn: 50 } },
      { id: 'm2', name: 'Sat', destination: 'leo', status: 'operations', launchTurn: 28 },
      { id: 'm3', name: 'Plan', destination: 'leo', status: 'planning' },
    ],
    calendar: [{ id: 'cal_tianwen', status: 'success', currentTurn: 25 }, { id: 'cal_change7', status: 'planned', currentTurn: 40 }],
  });
  const t = activeTransits(st, data);
  assert.equal(t.length, 3);
  const rover = t.find((x) => x.missionId === 'm1');
  assert.ok(Math.abs(rover.progress - 1 / 3) < 1e-9);
  assert.equal(rover.isPlayer, true);
  assert.equal(rover.bodyId, 'mars');
  assert.equal(t.find((x) => x.missionId === 'm2').phase, 'ops');
  const rival = t.find((x) => x.calendarId === 'cal_tianwen');
  assert.equal(rival.actorId, 'cnsa');
  assert.equal(rival.phase, 'transit');
});

test('window warnings: launch outside the Mars window is flagged', () => {
  const data = withDest();
  const st = baseState({ missions: [{ id: 'm1', name: 'Sonda Vermelha', destination: 'mars_surface', status: 'scheduled', launchTurn: 60 }] });
  const w = windowWarnings(st, data, () => undefined);
  assert.equal(w.length, 1);
  assert.equal(w[0].level, 'miss');
  assert.match(w[0].text, /fora da janela para Marte/);
  st.missions[0].launchTurn = 42;
  assert.equal(windowWarnings(st, data, () => undefined).length, 0);
});

test('metro: shared trunk, tree layout, line totals', () => {
  const m = buildMetro(withDest());
  assert.equal(m.lines.length, FIX_DEST.length);
  assert.ok(m.nodes.earth && !m.nodes.earth.parent);
  assert.equal(m.nodes.leo.parent, 'earth');
  assert.equal(m.nodes.lunar_surface.parent, 'lunar_orbit');
  const trunk = m.edges.find((e) => e.from === 'earth' && e.to === 'leo');
  assert.ok(trunk.lines.length >= 4);
  assert.equal(trunk.color, '#cfd8e3');
  assert.ok(Math.abs(m.lines.find((l) => l.destId === 'lunar_surface').totalDv - 15.3) < 1e-9);
  for (const id of m.order) assert.ok(Number.isFinite(m.nodes[id].x) && Number.isFinite(m.nodes[id].y));
  assert.equal(energyWord(9.4), 'Baixa');
  assert.equal(energyWord(15.3), 'Alta');
  // empty catalog → no lines, no throw
  assert.equal(buildMetro({}).lines.length, 0);
});

test('robust with stubs: empty state, empty data, throwing queries', () => {
  const bad = makeQuery({ query: () => { throw new Error('consulta desconhecida'); } });
  assert.equal(bad('catalog/window', 'x'), undefined);
  const m = buildModel({}, {}, bad);
  assert.deepEqual(m.transits, []);
  const m2 = buildModel(baseState(), real, bad);
  assert.ok(m2.fog.bodies.earth === 'known');
  const m3 = buildModel(baseState({ missions: [{}], calendar: [{}, null] }), withDest(), bad);
  assert.ok(Array.isArray(m3.windows));
  // model is JSON-safe input/output
  assert.doesNotThrow(() => JSON.stringify(m3));
  // render without DOM is a no-op returning a cleanup fn
  assert.equal(typeof render(null, {}), 'function');
});

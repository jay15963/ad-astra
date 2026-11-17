// Whole Solar System data (solar-data workstream): bodies, destinations, windows, in-transit probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, createState, tick } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as cal from '../src/sim/calendar.js';
import * as missions from '../src/sim/missions.js';
import * as risk from '../src/sim/risk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const bodies = data.bodies.bodies;
const B = Object.fromEntries(bodies.map((b) => [b.id, b]));
const dests = data.destinations.destinations;
const TYPES = ['satellite', 'probe', 'crewed', 'cargo', 'station', 'lander'];
const PLAYABLE = data.scenario.playableActors;
const turnOf = (year, month) => (year - 2026) * 52 + Math.ceil((month - 1) * (52 / 12));

const REQUIRED_BODIES = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'phobos', 'deimos', 'asteroid_belt', 'ceres', 'vesta', 'psyche',
  'apophis', 'bennu', 'didymos', 'kamooalewa', 'jupiter', 'io', 'europa', 'ganymede', 'callisto', 'trojans', 'saturn', 'titan', 'enceladus',
  'uranus', 'neptune', 'triton', 'pluto', 'charon', 'kuiper_belt'];
const NEW_DESTS = ['venus_flyby', 'venus_orbit', 'venus_atmosphere', 'mercury_flyby', 'mercury_orbit', 'neo_asteroid', 'neo_sample_return', 'apophis',
  'didymos', 'phobos', 'ceres', 'psyche', 'jupiter_trojans', 'europa_flyby', 'ganymede_orbit', 'saturn_orbit', 'enceladus_flyby', 'uranus_orbit',
  'neptune_flyby', 'pluto_flyby', 'kuiper'];

test('bodies.json: the whole Solar System, well-formed, schema documented', () => {
  assert.ok(data.bodies._schema && data.bodies._schema.orbit && data.bodies._schema.ficha, '_schema documents the fields');
  for (const id of REQUIRED_BODIES) assert.ok(B[id], `body ${id}`);
  assert.equal(new Set(bodies.map((b) => b.id)).size, bodies.length, 'unique ids');
  for (const b of bodies) {
    assert.ok(b.name && ['star', 'planet', 'dwarf', 'moon', 'asteroid', 'belt', 'comet'].includes(b.kind), `${b.id} kind`);
    assert.ok(b.parent === null || B[b.parent], `${b.id} parent`);
    for (const k of ['tipo', 'gravidade', 'atmosfera', 'temperatura', 'historia']) assert.ok(typeof b.ficha?.[k] === 'string' && b.ficha[k].length > 2, `${b.id}.ficha.${k}`);
    assert.ok(Array.isArray(b.ficha.recursos) && b.ficha.recursos.length && Array.isArray(b.ficha.perigos) && b.ficha.perigos.length, `${b.id} recursos/perigos`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(b.display?.color) && b.display.radius > 0, `${b.id} display`);
    if (b.id !== 'sun') {
      assert.ok(Number.isFinite(b.orbit?.radius) && b.orbit.radius > 0, `${b.id} orbit.radius`);
      assert.ok(b.orbit.periodWeeks === null || b.orbit.periodWeeks > 0, `${b.id} periodWeeks`);
      assert.ok(b.orbit.aAU > 0 || b.orbit.aKm > 0, `${b.id} real semi-major axis`);
    }
    if (b.kind === 'belt' && b.belt) assert.ok(b.belt.inner < b.belt.outer && b.belt.innerAU < b.belt.outerAU, `${b.id} belt`);
    for (const a of b.destinations || []) assert.ok(data.index.destinations[a.id] && ['ring', 'surface', 'lagrange'].includes(a.anchor), `${b.id} anchor ${a.id}`);
    for (const m of b.milestones || []) assert.ok(data.bodies.milestoneLabels[m], `${b.id} milestone label ${m}`);
  }
  // planets ordered outward on the schematic layout, like the real semi-major axes
  const planets = bodies.filter((b) => b.kind === 'planet' && b.parent === 'sun').sort((a, b) => a.orbit.aAU - b.orbit.aAU);
  for (let i = 1; i < planets.length; i++) assert.ok(planets[i].orbit.radius > planets[i - 1].orbit.radius, planets[i].id);
  assert.deepEqual(planets.map((p) => p.id), ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
  assert.ok(B.saturn.rings && B.saturn.display.ring && B.uranus.rings);
  // the outermost level shows the Kuiper belt
  const solar = data.bodies.levels.find((l) => l.id === 'solar');
  assert.ok(solar.span / 2 >= B.kuiper_belt.belt.outer, 'solar level spans the Kuiper belt');
});

test('destinations: every new target is well-formed and anchored on the map', () => {
  const nodes = new Set(data.destinations.routeNodes.map((n) => n.id));
  const anchored = new Set(bodies.flatMap((b) => (b.destinations || []).map((a) => a.id)));
  for (const id of NEW_DESTS) {
    const d = data.index.destinations[id];
    assert.ok(d, `destination ${id}`);
    assert.ok(B[d.body], `${id} body ${d.body} in bodies.json`);
    assert.ok(anchored.has(id), `${id} has a map anchor`);
    assert.ok(d.name && d.emLabel && d.toLabel && d.short && d.description, `${id} texts`);
    assert.ok(d.missionTypes.length && d.missionTypes.every((t) => TYPES.includes(t)), `${id} missionTypes`);
    assert.ok(d.risk > 0 && d.risk < 0.2 && d.prestige > 0 && d.scienceMult >= 1, `${id} risk/prestige/science`);
    assert.ok(d.transitWeeks > 0 && d.arrivalMilestones.length >= 1, `${id} transit + arrival scene`);
    assert.ok(d.route.every((r) => nodes.has(r.from) && nodes.has(r.to) && r.dv > 0), `${id} route`);
    const dv = d.route.reduce((s, r) => s + r.dv, 0);
    assert.ok(dv > 12 && dv < 22, `${id} total delta-v ${dv}`);
    assert.ok([].concat(d.firsts.robotic).every((m) => data.calendar.milestoneLabels[m] && data.bodies.milestoneLabels[m]), `${id} first labels`);
  }
  // physics sanity: farther is slower
  const T = (id) => data.index.destinations[id].transitWeeks;
  assert.ok(T('venus_orbit') < T('mars_orbit') && T('mars_orbit') < T('jupiter') && T('saturn_orbit') < T('uranus_orbit'));
  assert.ok(T('mercury_orbit') > T('venus_orbit') * 10, 'Mercury orbit takes years of gravity assists');
});

test('every destination is reachable by some vehicle + spacecraft for some playable actor', () => {
  for (const d of dests) {
    const types = d.missionTypes || ['probe', 'lander', 'satellite', 'crewed', 'cargo', 'station'];
    let found = null;
    for (const actor of PLAYABLE) {
      const s = newGame(data, { seed: 1, playerId: actor });
      s.actors[actor].cash = 1e6; // reachability, not affordability
      const w = cal.nextWindow(s, data, d.id, 20);
      s.turn = Number.isFinite(w.closeTurn) ? Math.max(0, w.openTurn - 30) : 20;
      for (const type of types) {
        const o = missions.draftOptions(s, data, { type, destination: d.id, crewed: type === 'crewed' });
        if (!o.destinations.find((x) => x.id === d.id)?.valid) continue;
        for (const sc of o.spacecraft.filter((x) => x.valid).slice(0, 8)) {
          const o2 = missions.draftOptions(s, data, { type, destination: d.id, spacecraftId: sc.id, crewed: type === 'crewed' });
          for (const v of o2.vehicles.filter((x) => x.valid).slice(0, 4)) {
            const o3 = missions.draftOptions(s, data, { type, destination: d.id, spacecraftId: sc.id, vehicleId: v.id, crewed: type === 'crewed' });
            if (o3.valid) { found = `${actor}:${sc.id}/${v.id}`; break; }
          }
          if (found) break;
        }
        if (found) break;
      }
      if (found) break;
    }
    assert.ok(found, `${d.id} reachable`);
  }
});

test('windows open in 2026-2030 where the real ones do', () => {
  const s = createState(data, { seed: 1, playerId: 'nasa' });
  const opens = (id) => {
    const out = [];
    let t = 0;
    while (t < 260) { const w = cal.nextWindow(s, data, id, t); if (w.openTurn >= 260) break; out.push(w); t = w.closeTurn; }
    return out;
  };
  for (const d of dests) if (d.window) assert.ok(opens(d.id).length >= 1, `${d.id} has a window before 2031`);
  // Venus: every ~19 months (jun/2026, fev/2028, set/2029); Shukrayaan (29/mar/2028) fits the 2028 one
  const v = opens('venus_orbit');
  assert.equal(v.length, 3);
  assert.ok(v[1].openTurn - v[0].openTurn >= 80 && v[1].openTurn - v[0].openTurn <= 88);
  assert.ok(cal.nextWindow(s, data, 'venus_orbit', turnOf(2028, 3) + 4).isOpen, 'Venus window open end of mar/2028');
  // Apophis: one window only, spring 2028 (Ramses launches 24/abr-11/mai/2028)
  const a = opens('apophis');
  assert.equal(a.length, 1);
  assert.ok(cal.nextWindow(s, data, 'apophis', turnOf(2028, 4) + 3).isOpen);
  // Phobos follows Mars (MMX launched 20/out/2026)
  assert.ok(cal.nextWindow(s, data, 'phobos', turnOf(2026, 10) + 2).isOpen);
  // Jupiter-family destinations share Jupiter's window (~13 months), Saturn's ~12.4 months
  assert.equal(data.index.destinations.europa_flyby.window.periodWeeks, 57);
  assert.equal(data.index.destinations.saturn_orbit.window.periodWeeks, 54);
  // the map can phase Venus with its window
  assert.ok(B.venus.orbit.syncWindow.every((id) => data.index.destinations[id]?.window));
});

test('calendar: real missions to the new targets, in-transit probes start mid-flight', () => {
  const ids = ['bepicolombo', 'hera', 'tianwen2', 'psyche', 'osiris_apex', 'lucy', 'europa_clipper', 'juice', 'shukrayaan', 'ramses', 'davinci', 'mmx'];
  for (const id of ids) {
    const c = data.index.calendar[id];
    assert.ok(c && c.statusNov2026 && c.source.startsWith('https://') && c.truthLayer, id);
  }
  assert.equal(data.index.calendar.mmx.destination, 'phobos');
  const s = createState(data, { seed: 3, playerId: 'isro' });
  const ctx = () => ({ data, rng: (l = '') => rngFor(s.seed, s.turn, 'calendar', l), date: turnToDate(s.turn, s.startYear) });
  cal.init(s, data, ctx());
  const inst = (id) => s.calendar.find((c) => c.id === id);
  for (const c of data.calendar.missions.filter((m) => m.inTransit)) {
    const i = inst(c.id);
    assert.equal(i.status, 'launched', c.id);
    assert.ok(i.launchTurn < 0 && i.arrivalTurn === i.plannedTurn, c.id);
  }
  assert.equal(inst('shukrayaan').status, 'player');
  // BepiColombo and Hera arrive in nov/2026 and get resolved by the living calendar
  while (s.turn < turnOf(2027, 1)) { s.signals = s.signalsPending; s.signalsPending = []; cal.tick(s, data, ctx()); s.turn++; }
  for (const id of ['bepicolombo', 'hera']) assert.ok(['success', 'partial', 'failed'].includes(inst(id).status), `${id} resolved`);
  assert.equal(inst('europa_clipper').status, 'launched');
  const view = cal.queries['calendar/get'](s, data, 'bepicolombo');
  assert.equal(view.vehicleName, 'Ariane 5');
  assert.equal(view.inTransit, true);
});

test('player-owned in-transit probes become player missions in transit with an arrival scene', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  tick(s, data);
  const mine = s.missions.filter((m) => m.inheritedTransit);
  assert.deepEqual(mine.map((m) => m.calendarId).sort(), ['europa_clipper', 'lucy', 'osiris_apex', 'psyche']);
  for (const m of mine) {
    assert.equal(m.status, 'transit');
    assert.ok(m.transit.arriveTurn > s.turn && m.paid && m.cost === 0, m.id);
    assert.ok(Number.isFinite(m.estimate.p));
  }
  assert.ok(!s.decisions.some((d) => d.kind === 'briefing' && mine.some((m) => m.calendarId === d.payload?.calendarId)), 'no briefing for probes already flying');
  // Lucy reaches the Trojans in aug/2027: arrival scene for the player
  const lucy = mine.find((m) => m.calendarId === 'lucy');
  while (s.turn <= lucy.transit.arriveTurn && !s.gameOver) tick(s, data);
  assert.ok(['arrival', 'operations', 'done'].includes(lucy.status), lucy.status);
  if (lucy.status === 'arrival') assert.ok(s.decisions.some((d) => d.kind === 'launch/ready' && d.payload?.missionId === lucy.id) || s.activeLaunch || s.decisions.some((d) => d.kind === 'launch/ready'));
  // risk sees the arrival milestones of the new destination
  const r = risk.missionRisk(s, data, { actorId: 'nasa', type: 'probe', destination: 'jupiter_trojans', vehicleId: 'atlas_v', spacecraftId: 'lucy', crew: lucy.crew, config: lucy.config, launchTurn: s.turn });
  assert.ok(r.milestones.some((m) => m.id === 'trojan_flyby'));
  assert.ok(r.p > 0.5 && r.p < 1);
  // save/load keeps everything JSON-pure
  assert.deepEqual(JSON.parse(JSON.stringify(s.missions)), s.missions);
});

test('a CNSA player owns Tianwen-2; an ESA player owns BepiColombo, Hera and JUICE', () => {
  const c = newGame(data, { seed: 2, playerId: 'cnsa' });
  tick(c, data);
  assert.deepEqual(c.missions.filter((m) => m.inheritedTransit).map((m) => m.calendarId), ['tianwen2']);
  const e = newGame(data, { seed: 2, playerId: 'esa' });
  tick(e, data);
  assert.deepEqual(e.missions.filter((m) => m.inheritedTransit).map((m) => m.calendarId).sort(), ['bepicolombo', 'hera', 'juice']);
});

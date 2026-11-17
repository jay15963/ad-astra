// Tests for the geopolitics slice (state.geo, owned by src/sim/politics.js) and data/geopolitics.json.
// Runs politics in isolation (actors copied from data/actors.json), like tests/politics.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode, DATA_FILES } from '../src/core/data.js';
import { createState, newGame } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import { relKey } from '../src/core/helpers.js';
import * as politics from '../src/sim/politics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const G = data.geopolitics;
const world = JSON.parse(fs.readFileSync(path.join(root, 'data', 'world.json'), 'utf8'));
const ISO = new Set(world.countries.map((c) => c.id));
const STATUS = new Set(['stable', 'contested', 'conflict', 'ceasefire']);

const ctxFor = (state) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'politics', l), date: turnToDate(state.turn, state.startYear) });

function setup(seed, playerId = 'nasa') {
  const state = createState(data, { seed, playerId });
  for (const a of data.actors.actors) state.actors[a.id] = { ...structuredClone(a), cash: a.budget * 0.25 };
  for (const r of data.actors.relations || []) state.relations[relKey(r.a, r.b)] = { trust: r.trust, dependence: r.dependence, rivalry: r.rivalry };
  for (const b of data.actors.blocs || []) state.blocs[b.id] = structuredClone(b);
  state.treaties = structuredClone(data.actors.treaties || []);
  politics.init(state, data, ctxFor(state));
  return state;
}

function step(state) {
  for (const d of state.decisions.slice()) {
    state.decisions.splice(state.decisions.indexOf(d), 1);
    politics.decisionHandlers['politics/*'](state, data, d, d.choices?.[0]?.id, ctxFor(state));
  }
  state.signals = state.signalsPending;
  state.signalsPending = [];
  politics.tick(state, data, ctxFor(state));
  state.turn += 1;
}

function run(seed, { check } = {}) {
  const state = setup(seed);
  while (state.turn <= state.endTurn) { step(state); check?.(state); }
  return state;
}

const SEEDS = Array.from({ length: 30 }, (_, i) => 4242 + i * 7919);
const RUNS = new Map();
const runSeed = (seed) => { if (!RUNS.has(seed)) RUNS.set(seed, run(seed)); return RUNS.get(seed); };

test('data: geopolitics is loaded, zones are valid and point at real countries', () => {
  assert.ok(DATA_FILES.includes('geopolitics'));
  assert.ok(!DATA_FILES.includes('world'), 'world.json stays lazy (fetched by the map only)');
  assert.ok(G.zones.length >= 10);
  const ids = new Set();
  for (const z of G.zones) {
    assert.ok(!ids.has(z.id), `zona duplicada ${z.id}`);
    ids.add(z.id);
    assert.ok(z.name && z.desc, z.id);
    assert.ok(z.claimants.length >= 2, z.id);
    for (const iso of z.claimants) assert.ok(ISO.has(iso), `${z.id}: ${iso} fora do world.json`);
    assert.ok(z.claimants.includes(z.controller), `${z.id}: controlador fora dos reivindicantes`);
    assert.ok(STATUS.has(z.status), z.id);
    assert.ok(G.countries[z.controller]?.name, `${z.id}: nome de ${z.controller}`);
    if (z.kind === 'circle') assert.ok(Math.abs(z.circle.lat) <= 90 && Math.abs(z.circle.lon) <= 180 && z.circle.radiusKm > 0, z.id);
    else for (const [lon, lat] of z.polygon) assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, z.id);
    for (const [n, iso] of Object.entries(z.sides || {})) {
      assert.ok(data.politics.nations.some((x) => x.id === n), `${z.id}: nação ${n}`);
      assert.ok(z.claimants.includes(iso), `${z.id}: lado ${n}→${iso}`);
    }
    for (const p of z.pairs || []) assert.ok(p.every((n) => data.politics.nations.some((x) => x.id === n)), `${z.id}: par ${p}`);
  }
  for (const c of G.conflicts) for (const id of c.zoneIds) assert.ok(ids.has(id), `${c.id}: ${id}`);
  for (const [aid, list] of Object.entries(G.actorCountries)) {
    assert.ok(data.actors.actors.some((a) => a.id === aid), aid);
    for (const iso of list) assert.ok(ISO.has(iso), `${aid}: ${iso}`);
  }
  for (const s of [...G.launchSites, ...G.hqs]) assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180, s.id || s.actorId);
  for (const a of data.actors.actors) assert.ok(G.hqs.some((q) => q.actorId === a.id), `sede de ${a.id}`);
  for (const n of data.politics.nations) assert.ok(G.nationAnchors[n.id], `âncora de ${n.id}`);
});

test('init: the map starts as the data says (nothing changes before turn 0) and the slice is JSON', () => {
  const s = setup(7);
  assert.ok(s.geo?.zones);
  for (const z of G.zones) {
    const gz = s.geo.zones[z.id];
    assert.equal(gz.controller, z.controller, z.id);
    assert.equal(gz.history.length, 0, z.id);
    assert.ok(gz.since <= 0, `${z.id} since ${gz.since}`);
  }
  assert.equal(s.geo.events.length, 0);
  assert.equal(s.geo.shifts, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.geo)), s.geo);
  // the fact conflict (already under way) starts before the campaign, as data
  const fact = s.geo.conflicts.find((c) => c.fact);
  assert.ok(fact && fact.startTurn < 0 && fact.endTurn == null);
  // newGame (full engine) also creates the slice
  const ng = newGame(data, { seed: 7, playerId: 'nasa' });
  assert.ok(ng.geo?.zones?.crimea);
});

test('determinism: same seed, same map history; different seeds diverge', () => {
  const a = run(SEEDS[0]);
  const b = run(SEEDS[0]);
  assert.equal(JSON.stringify(a.geo), JSON.stringify(b.geo));
  const prints = new Set(SEEDS.slice(0, 10).map((sd) => JSON.stringify(runSeed(sd).geo.events)));
  assert.ok(prints.size >= 5, `mundos pouco divergentes (${prints.size})`);
});

test('zones always have a valid controller and status; no change dated before turn 0', () => {
  for (const seed of SEEDS.slice(0, 8)) {
    run(seed, {
      check: (s) => {
        for (const z of G.zones) {
          const gz = s.geo.zones[z.id];
          assert.ok(z.claimants.includes(gz.controller), `${seed} ${z.id} ${gz.controller}`);
          assert.ok(STATUS.has(gz.status), `${seed} ${z.id} ${gz.status}`);
        }
      },
    });
  }
  for (const seed of SEEDS) {
    const s = runSeed(seed);
    for (const z of Object.values(s.geo.zones)) for (const h of z.history) assert.ok(h.turn >= 0, `${seed}: mudança no turno ${h.turn}`);
    for (const e of s.geo.events) assert.ok(e.turn >= 0);
    // geo/state at turn 0 equals the data (the past is fixed)
    const at0 = politics.queries['geo/state'](s, data, 0);
    for (const z of at0.zones) assert.equal(z.controller, G.zones.find((x) => x.id === z.id).controller, `${seed} ${z.id}`);
    // background zones with no driving pair never move
    for (const z of G.zones.filter((x) => !(x.pairs || []).length)) {
      assert.equal(s.geo.zones[z.id].history.length, 0, `${seed}: ${z.id} mudou sem par de tensão`);
    }
  }
});

test('bounded frequency across 30 seeds: territory changes are rare, wars are not scripted', () => {
  let withShift = 0;
  let total = 0;
  let anyEvent = 0;
  for (const seed of SEEDS) {
    const s = runSeed(seed);
    const shifts = s.geo.events.filter((e) => e.kind === 'control_change').length;
    assert.ok(shifts <= (G.model.maxShifts ?? 3), `${seed}: ${shifts} mudanças`);
    assert.equal(shifts, s.geo.shifts);
    if (shifts) withShift++;
    total += shifts;
    if (s.geo.events.length) anyEvent++;
    // shifts only in shiftable zones and only during a conflict
    for (const e of s.geo.events.filter((x) => x.kind === 'control_change')) {
      assert.ok(G.zones.find((z) => z.id === e.zoneId).shiftable, e.zoneId);
      const c = s.geo.conflicts.find((x) => x.id === e.conflictId);
      assert.ok(c && c.startTurn <= e.turn && (c.endTurn == null || c.endTurn >= e.turn), `${seed}: mudança fora de conflito`);
    }
  }
  assert.ok(withShift <= 15, `mudanças de controle em ${withShift}/30 sementes (a maioria deve ficar sem)`);
  assert.ok(total <= 30, `total de mudanças ${total}`);
  assert.ok(anyEvent >= 10, `o mapa quase nunca muda (${anyEvent}/30)`);
});

test('queries: geo/state and geo/history are readable and can show the past', () => {
  const seed = SEEDS.find((sd) => runSeed(sd).geo.shifts > 0) ?? SEEDS[0];
  const s = runSeed(seed);
  const q = politics.queries['geo/state'](s, data);
  assert.equal(q.turn, s.turn);
  assert.equal(q.zones.length, G.zones.length);
  assert.ok(q.hqs.length >= 8 && q.sites.length >= 15);
  for (const l of q.tensionLines) {
    assert.ok(l.level >= 0 && l.level <= 4 && l.from && l.to && l.levelLabel);
  }
  for (const b of Object.values(q.countryBloc)) assert.ok(['artemis', 'ilrs', 'both', 'neutral'].includes(b));
  assert.equal(q.countryBloc.USA, 'artemis');
  assert.equal(q.countryBloc.CHN, 'ilrs');
  const h = politics.queries['geo/history'](s, data);
  assert.ok(Array.isArray(h.events));
  for (let i = 1; i < h.events.length; i++) assert.ok(h.events[i].turn >= h.events[i - 1].turn);
  for (const e of h.events) assert.ok(e.text && !/undefined|null|NaN|\{/.test(e.text), e.text);
  const shift = s.geo.events.find((e) => e.kind === 'control_change');
  if (shift) {
    const before = politics.queries['geo/state'](s, data, shift.turn - 1).zones.find((z) => z.id === shift.zoneId);
    const after = politics.queries['geo/state'](s, data, shift.turn).zones.find((z) => z.id === shift.zoneId);
    assert.equal(before.controller, shift.from);
    assert.equal(after.controller, shift.to);
    assert.equal(after.changedTurn, shift.turn);
    assert.equal(before.changedTurn, null);
  }
  // bloc change recolors the agency's countries
  const s2 = setup(11);
  s2.actors.isro.bloc = null;
  assert.equal(politics.queries['geo/state'](s2, data).countryBloc.IND, 'neutral');
});

test('old saves without state.geo get the slice on the next tick; news stay neutral', () => {
  const s = setup(99);
  delete s.geo;
  step(s);
  assert.ok(s.geo?.zones?.taiwan);
  const all = SEEDS.flatMap((sd) => runSeed(sd).news.filter((n) => n.tags?.includes('geo')));
  for (const n of all) assert.ok(n.headline && !/\{|undefined|null/.test(n.headline), n.headline);
});

// Save migration v3 → v4 (docs/MISSIONS-V2.md §10): legacy landing everywhere, research grants by date and by
// committed hardware, new slices, idempotence, and save/load identity afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { migrate, MIGRATIONS, targetVersion } from '../src/core/migrate.js';
import { v3to4, renameLegacyLanding, applyResearchGrant } from '../src/core/migrations/v4.js';
import { keyHeld, keysOfNodes, gatesOf } from '../src/core/gating.js';
import { withStubTree } from './fixtures/techtree-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const stub = withStubTree(real);
const W = 52;

/** A v0.8-shaped (v3) campaign save at `year`: legacy 'lander' records everywhere, research without keys. */
function v08Save(year, { reusableMission = false } = {}) {
  const s = engine.newGame(real, { seed: 11, playerId: 'nasa' });
  s.turn = (year - s.startYear) * W;
  s.missions = [
    { id: 'mis_1', type: 'lander', destination: 'lunar_surface', status: 'planning', vehicleId: null, spacecraftId: null },
    { id: 'mis_2', type: 'satellite', destination: 'leo', status: 'success' },
  ];
  if (reusableMission) {
    const v = real.vehicles.vehicles.find((x) => x.reusable && x.class === 'heavy');
    s.missions.push({ id: 'mis_3', type: 'satellite', destination: 'leo', status: 'scheduled', vehicleId: v.id });
  }
  s.missionsArchive = [{ id: 'mis_0', t: 'lander', n: 'Antiga' }];
  s.contracts = [{ id: 'ctr_1', type: 'lander', destination: 'lunar_surface' }];
  s.decisions = [{ id: 'dec_1', kind: 'mission/opportunity', payload: { type: 'lander', draft: { type: 'lander', destination: 'lunar_surface' } } }];
  s.mandates = [{ id: 'man_1', type: 'lander' }];
  delete s.research.keys;
  delete s.assets;
  delete s.market;
  s.research.unlocked = (s.research.unlocked || []).filter((id) => !stub.index.tech[id] || !/^t\d_/.test(id));
  s.version = 3;
  return JSON.parse(JSON.stringify(s));
}

test('v3 → v4 is registered on import of research.js and is the newest step', () => {
  assert.equal(typeof MIGRATIONS[3], 'function');
  assert.equal(targetVersion(), 4);
  assert.equal(engine.SAVE_VERSION, 4);
});

test('legacy landing: lander → probe/lander in missions, archive stubs, contracts, decisions, mandates', () => {
  const raw = v08Save(1970);
  const s = migrate(JSON.stringify(raw), stub);
  assert.equal(s.version, 4);
  assert.deepEqual([s.missions[0].type, s.missions[0].sub], ['probe', 'lander']);
  assert.equal(s.missions[1].type, 'satellite');
  assert.equal(s.missions[1].sub, undefined, 'other types: sub is derived later, not here');
  assert.deepEqual([s.missionsArchive[0].t, s.missionsArchive[0].sub], ['probe', 'lander']);
  assert.deepEqual([s.contracts[0].type, s.contracts[0].sub], ['probe', 'lander']);
  assert.equal(s.decisions[0].payload.type, 'probe');
  assert.deepEqual([s.decisions[0].payload.draft.type, s.decisions[0].payload.draft.sub], ['probe', 'lander']);
  assert.equal(s.mandates[0].type, 'probe');
  assert.ok(!JSON.stringify(s).includes('"lander"') || JSON.stringify(s).match(/"type":"lander"/) === null, 'no type lander left');
  assert.equal(s.assets, null);
  assert.equal(s.market, null);
});

test('research grants follow the date: a 1970 save has vehicle:heavy and not vehicle:reusable', () => {
  const s = migrate(JSON.stringify(v08Save(1970)), stub);
  const r = s.research;
  assert.deepEqual(r.unlocked, [...r.unlocked].sort(), 'sorted union');
  assert.ok(r.unlocked.includes('zt1_vehicle_heavy'));
  assert.ok(r.unlocked.includes('zt1_vehicle_medium'), 'requires closure');
  assert.ok(!r.unlocked.includes('zt3_vehicle_reusable'));
  assert.ok(!r.unlocked.includes('zt1_station_core'), '1971 is after 1970');
  assert.deepEqual(r.keys, keysOfNodes(stub, r.unlocked));
  assert.equal(keyHeld(s, stub, 'vehicle:heavy'), true);
  assert.equal(keyHeld(s, stub, 'vehicle:reusable'), false);
  assert.ok(r.migratedGrant >= 8, `granted ${r.migratedGrant}`);
  for (const id of r.unlocked) assert.equal(r.completedTurn[id] === undefined || !stub.index.tech[id]?.unlocks, true, `${id} not stamped as completed`);
  // 1971 includes the station (histYear ≤ year)
  assert.ok(migrate(JSON.stringify(v08Save(1971)), stub).research.unlocked.includes('zt1_station_core'));
});

test('committed hardware keeps working: its unlock nodes (and their closure) are granted', () => {
  const s = migrate(JSON.stringify(v08Save(1972, { reusableMission: true })), stub);
  const v = real.vehicles.vehicles.find((x) => x.reusable && x.class === 'heavy');
  for (const k of gatesOf(stub, 'vehicle', v)) assert.equal(keyHeld(s, stub, k), true, k);
  assert.ok(s.research.unlocked.includes('zt3_vehicle_reusable'));
});

test('idempotent, and serialize → deserialize is identical after migrating', () => {
  const s = migrate(JSON.stringify(v08Save(1970)), stub);
  const again = v3to4(JSON.parse(JSON.stringify(s)), stub);
  delete again.research.needsRecompute; delete s.research.needsRecompute;
  again.research.migratedGrant = s.research.migratedGrant; // the count only grows when something new is granted
  assert.deepEqual(again, { ...s, version: 4 });
  assert.equal(renameLegacyLanding(again), 0);
  const t = migrate(JSON.stringify(v08Save(1970)), stub);
  t.missions = []; t.decisions = []; // the fixture's hand-made records are not full missions
  engine.tick(t, stub);
  const text = engine.serialize(t);
  assert.equal(engine.serialize(engine.deserialize(text, stub)), text);
});

test('non-gated scenario: no grants (date rule applies), lander still renamed', () => {
  const ng = withStubTree(real, { gated: false });
  const raw = v08Save(1970);
  const s = migrate(JSON.stringify(raw), ng);
  assert.deepEqual(s.research.unlocked, raw.research.unlocked);
  assert.equal(s.missions[0].type, 'probe');
});

test('without data the grant is deferred to research (same result once data is present)', () => {
  const raw = v08Save(1970);
  const lazy = migrate(JSON.stringify(raw));
  assert.equal(lazy.research.needsGrant, true);
  assert.equal(lazy.missions[0].type, 'probe');
  const eager = migrate(JSON.stringify(raw), stub);
  const fixed = JSON.parse(JSON.stringify(lazy));
  applyResearchGrant(fixed, stub);
  assert.deepEqual(fixed.research.unlocked, eager.research.unlocked);
  assert.deepEqual(fixed.research.keys, eager.research.keys);
  assert.equal(fixed.research.needsGrant, undefined);
  // research's tick runs it on its own
  lazy.missions = []; lazy.decisions = [];
  engine.tick(lazy, stub);
  assert.equal(lazy.research.needsGrant, undefined);
  assert.ok(lazy.research.unlocked.includes('zt1_vehicle_heavy'));
  assert.deepEqual(lazy.research.keys, keysOfNodes(stub, lazy.research.unlocked));
});

// ------------------------------------------------------------------ the real tree (data/core/techtree.json + data/tech)

test('real tree: a 1970 campaign save migrates to the keys history had (heavy yes, reusable no), with real node ids', { skip: !real.techtree }, () => {
  const raw = v08Save(1970);
  raw.research.unlocked = [];
  const s = migrate(JSON.stringify(raw), real);
  const r = s.research;
  assert.deepEqual(r.keys, keysOfNodes(real, r.unlocked));
  for (const k of ['vehicle:small', 'vehicle:medium', 'vehicle:heavy', 'missionType:satellite', 'missionType:crewed', 'probe:lander']) {
    assert.equal(keyHeld(s, real, k), true, k);
  }
  for (const k of ['vehicle:reusable', 'missionType:station', 'module:station.core', 'probe:outer']) assert.equal(keyHeld(s, real, k), false, k);
  for (const id of r.unlocked) assert.ok(real.index.tech[id], `${id} is a real node`);
  // closure: every granted node has its requirements granted
  const have = new Set(r.unlocked);
  for (const id of r.unlocked) for (const q of real.index.tech[id].requires || []) assert.ok(have.has(q), `${id} needs ${q}`);
});

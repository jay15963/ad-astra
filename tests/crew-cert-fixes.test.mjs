// Crew certification follow-ups: a program whose demo is never flown expires (no permanent block on a rival's
// launcher), the builder offers the thinner fuel margin that makes a payload fit, ranks fixable vehicles first and
// warns when a certification costs more than the cash on hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick, dispatch, query, serialize, deserialize } from '../src/core/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const LIMIT = data.vehicles.crewCertRules.demoExpiryWeeks;

const game = (playerId, seed = 5) => {
  const s = newGame(data, { seed, playerId });
  s.actors[playerId].cash = 50000;
  return s;
};

/** Push a player program straight into the demo phase. */
function toDemo(s, vid) {
  const p = s.crewCert.programs[vid];
  s.turn = p.readyTurn;
  s.vehicleStats[vid].flights += 60;
  tick(s, data);
  assert.equal(s.crewCert.programs[vid]?.phase, 'demo');
  return s.crewCert.programs[vid];
}

test('data: demo expiry rule exists', () => {
  assert.ok(Number.isFinite(LIMIT) && LIMIT >= 26 && LIMIT <= 104);
});

test('a customer program whose demo is never flown expires and frees the vehicle', () => {
  const s = game('nasa');
  const r = dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'new_glenn' });
  assert.ok(r.ok, r.error);
  const p = toDemo(s, 'new_glenn');
  assert.ok(Number.isFinite(p.demoSince) && p.demoSince <= s.turn);
  const since = p.demoSince;
  tick(s, data);
  const demo = s.missions.find((m) => m.certVehicleId === 'new_glenn');
  assert.ok(demo && demo.status === 'planning');
  while (s.turn < since + LIMIT - 1) tick(s, data);
  assert.ok(s.crewCert.programs.new_glenn, 'still alive before the deadline');
  tick(s, data); tick(s, data);
  assert.equal(s.crewCert.programs.new_glenn, undefined, 'expired');
  assert.ok(s.news.some((n) => /encerrada sem o voo de demonstração/.test(n.headline)));
  tick(s, data);
  assert.equal(s.missions.find((m) => m.id === demo.id).status, 'cancelled', 'orphan demo dropped');
  // the vehicle is no longer held: nobody "is already certifying" it
  const again = dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'new_glenn' });
  assert.ok(again.ok || !/certificando|em andamento/.test(again.error), again.error);
});

test('a paused program also expires; a scheduled demo does not', () => {
  const s = game('spacex');
  assert.ok(dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' }).ok);
  toDemo(s, 'falconheavy');
  tick(s, data);
  const demo = s.missions.find((m) => m.certVehicleId === 'falconheavy' && m.status === 'planning');
  assert.ok(demo);
  assert.ok(dispatch(s, data, { type: 'mission/cancel', missionId: demo.id }).ok);
  const p = s.crewCert.programs.falconheavy;
  assert.equal(p.paused, true);
  assert.ok(p.pausedTurn <= s.turn);
  const t0 = p.pausedTurn;
  while (s.turn <= t0 + LIMIT) tick(s, data);
  assert.equal(s.crewCert.programs.falconheavy, undefined);

  // scheduled demo: kept past the deadline while it is on the pad
  const s2 = game('spacex', 9);
  assert.ok(dispatch(s2, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' }).ok);
  const p2 = toDemo(s2, 'falconheavy');
  tick(s2, data);
  const m2 = s2.missions.find((m) => m.certVehicleId === 'falconheavy');
  m2.status = 'scheduled';
  s2.turn = p2.demoSince + LIMIT + 5;
  s2.missions = s2.missions.filter((m) => m.id === m2.id).map((m) => ({ ...m, launchTurn: s2.turn + 50 }));
  tick(s2, data);
  assert.ok(s2.crewCert.programs.falconheavy, 'flying demo is not cut off');
});

test('old programs without demoSince/pausedTurn load and expire on demoTurn', () => {
  const s = game('nasa');
  assert.ok(dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'new_glenn' }).ok);
  const p = toDemo(s, 'new_glenn');
  delete p.demoSince;
  const back = deserialize(serialize(s));
  back.turn = (p.demoTurn ?? back.turn) + LIMIT + 1;
  tick(back, data);
  assert.equal(back.crewCert.programs.new_glenn, undefined);
});

test('builder: marginFit says which thinner fuel margin makes the payload fit', async () => {
  const { capacityHelpText, vehicleFixRank } = await import('../src/ui/missions-tab.js');
  const s = game('spacex');
  const d = { type: 'crewed', destination: 'lunar_surface', spacecraftId: 'orion', config: { fuelMargin: 0.1 } };
  const opts = query(s, data, 'missions/draftOptions', d);
  for (const v of opts.vehicles) {
    if (!(v.capacityShortT > 0)) { assert.equal(v.marginFit, null, v.id); continue; }
    if (v.marginFit) {
      assert.ok(v.marginFit.margin < 0.1 && v.marginFit.capacityT >= v.payloadT, v.id);
      const again = query(s, data, 'missions/draftOptions', { ...d, config: { fuelMargin: v.marginFit.margin } }).vehicles.find((x) => x.id === v.id);
      assert.equal(again.capacityShortT, 0, `${v.id} fits at ${v.marginFit.margin}`);
      assert.match(capacityHelpText(v, { margin: 0.1 }), /Com margem de combustível de \d+% ele leva [\d,]+ t: cabe/);
    } else {
      assert.match(capacityHelpText(v, { margin: 0.1 }), /nem com 0% cabe/);
      assert.equal(vehicleFixRank(v, d), 3, `${v.id}: too weak ranks last`);
    }
  }
  // pure ranking
  assert.equal(vehicleFixRank({ capacityShortT: 0, crewRated: false, crewCert: { feasible: true, start: { ok: true } } }, { type: 'crewed' }), 0);
  assert.equal(vehicleFixRank({ capacityShortT: 0, crewRated: false, crewCert: { feasible: false } }, { type: 'crewed' }), 2);
  assert.equal(vehicleFixRank({ capacityShortT: 0, crewRated: false, crewCert: { feasible: true, start: { ok: false } } }, { type: 'crewed' }), 1);
  assert.equal(vehicleFixRank({ capacityShortT: 1.2, marginFit: { margin: 0, capacityT: 28 } }, { type: 'crewed' }), 0);
  assert.equal(vehicleFixRank({ capacityShortT: 5 }, { type: 'crewed' }), 3);
});

test('builder: certification cash check', async () => {
  const { certCashCheck } = await import('../src/ui/missions-tab.js');
  assert.deepEqual(certCashCheck(1300, 1650), { before: 1300, after: -350, short: true, shortBy: 350 });
  assert.deepEqual(certCashCheck(2000, 1500), { before: 2000, after: 500, short: false, shortBy: 0 });
});

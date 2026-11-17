// Regression tests for the data-facts / sim-geo review fixes (nov/2026): launch windows, inherited probes,
// one-off windows, historical firsts, old saves, in-flight probes out of the catalog, warnings past the era.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query, serialize, deserialize } from '../src/core/engine.js';
import * as calendar from '../src/sim/calendar.js';
import { formatTurn } from '../src/core/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const dest = (id) => data.destinations.destinations.find((d) => d.id === id);
const calItem = (id) => data.calendar.missions.find((m) => m.id === id);
const advance = (s, n) => { for (let i = 0; i < n && !s.gameOver; i++) dispatch(s, data, { type: 'time/advance' }); };

test('Jupiter-family windows open in out/nov (about 3.5 months before opposition), Apophis abr-mai/2028', () => {
  for (const id of ['jupiter', 'jupiter_trojans', 'europa_flyby', 'ganymede_orbit']) {
    const w = calendar.nextWindow(null, data, id, 0);
    assert.match(formatTurn(w.openTurn, 2026), /out\/2026/, id);
  }
  const ap = calendar.nextWindow(null, data, 'apophis', 0);
  assert.equal(formatTurn(ap.openTurn, 2026), 'abr/2028');
  assert.equal(formatTurn(ap.closeTurn - 1, 2026), 'mai/2028');
  assert.match(dest('apophis').description, /abril a maio de 2028/);
});

test('a calendar item can fly its own trajectory window (Tianwen-4 VEEGA in 2029)', () => {
  const item = calItem('tianwen4');
  const w = calendar.nextWindow(null, data, item.destination, 180, item);
  assert.match(formatTurn(w.openTurn, 2026), /ago\/2029/);
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  const inst = s.calendar.find((c) => c.id === 'tianwen4');
  assert.equal(inst.currentTurn, inst.plannedTurn, 'planned date sits inside its own window');
});

test('inherited in-flight probes appear in the Missions tab on turn 0', () => {
  const s = newGame(data, { seed: 1, playerId: 'nasa' });
  const names = s.missions.filter((m) => m.inheritedTransit).map((m) => m.calendarId).sort();
  assert.deepEqual(names, ['europa_clipper', 'lucy', 'osiris_apex', 'psyche']);
  // and they are not adopted twice by the first tick
  advance(s, 1);
  assert.equal(s.missions.filter((m) => m.inheritedTransit).length, 4);
});

test('arrivals of probes paid before 2026 pay a reduced share of prestige; old feats are "do século"', () => {
  assert.ok(calendar.inheritedShare(data) > 0 && calendar.inheritedShare(data) < 1);
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  const before = s.actors.esa.prestige;
  const arr = s.calendar.find((c) => c.id === 'bepicolombo').arrivalTurn;
  advance(s, arr + 1);
  const inst = s.calendar.find((c) => c.id === 'bepicolombo');
  assert.ok(['success', 'partial', 'failed'].includes(inst.status));
  // BepiColombo alone used to pay ~86 prestige at turn 44; with the share it stays well below
  assert.ok(s.actors.esa.prestige - before < 60, `esa gained ${s.actors.esa.prestige - before}`);
  if (s.firsts.mercury_orbit) assert.equal(s.firsts.mercury_orbit.era, true, 'MESSENGER orbited Mercury in 2011');
  for (const k of ['venus_orbit', 'asteroid_sample_return', 'asteroid_rendezvous', 'europa_arrival', 'mercury_orbit', 'saturn_orbit', 'pluto_flyby']) {
    assert.ok(data.scenario.historicalFirsts[k], k);
  }
});

test('one-off real probes already flying cannot be built again', () => {
  const s = newGame(data, { seed: 1, playerId: 'nasa' });
  const ids = calendar.availableSpacecraft(s, data, 'nasa').map((x) => x.id);
  for (const id of ['osiris_apex', 'psyche', 'lucy', 'europa_clipper']) assert.ok(!ids.includes(id), id);
  assert.ok(ids.includes('generic_probe'));
});

test('builder warns when a probe can only arrive after the end of the era', () => {
  const s = newGame(data, { seed: 1, playerId: 'nasa' });
  const far = query(s, data, 'missions/draftOptions', { type: 'probe', destination: 'saturn_orbit', vehicleId: 'falconheavy', spacecraftId: 'generic_probe' });
  assert.ok(far.warnings.some((w) => /não pontua na Tabela da Era/.test(w)), far.warnings.join(' | '));
  const near = query(s, data, 'missions/draftOptions', { type: 'probe', destination: 'mars_orbit', vehicleId: 'falconheavy', spacecraftId: 'generic_probe' });
  assert.ok(!near.warnings.some((w) => /não pontua/.test(w)), near.warnings.join(' | '));
});

test('venus_orbit offers only mission types some hardware can fly', () => {
  assert.deepEqual(dest('venus_orbit').missionTypes, ['probe']);
});

test('old save: an in-transit item added later and already arrived becomes history, not news', () => {
  const s = newGame(data, { seed: 7, playerId: 'nasa' });
  advance(s, 60);
  const old = JSON.parse(serialize(s));
  old.calendar = old.calendar.filter((c) => c.id !== 'bepicolombo');
  delete old.firsts.mercury_orbit;
  const loaded = deserialize(JSON.stringify(old));
  advance(loaded, 1);
  const inst = loaded.calendar.find((c) => c.id === 'bepicolombo');
  assert.equal(inst.status, 'success');
  assert.equal(inst.resolvedTurn, inst.arrivalTurn);
  assert.ok(loaded.firsts.mercury_orbit && loaded.firsts.mercury_orbit.turn === inst.arrivalTurn);
  assert.ok(!loaded.news.some((n) => n.turn >= 60 && /BepiColombo/.test(n.headline || '')));
});

test('a missed once-in-a-decade window cancels the rival program instead of a 2038 date', () => {
  for (const [pid, seed] of [['nasa', 104729], ['isro', 104729], ['cnsa', 314187]]) {
    const s = newGame(data, { seed, playerId: pid });
    advance(s, 130);
    assert.ok(!s.news.some((n) => /20(3[5-9])/.test(n.headline || '') && /Ramses/.test(n.headline || '')), `${pid}/${seed}`);
    const r = s.calendar.find((c) => c.id === 'ramses');
    assert.ok(r.status !== 'planned' || r.currentTurn < 130, `${pid}/${seed}: ${r.status} ${r.currentTurn}`);
  }
});

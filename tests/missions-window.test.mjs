// missions/nextWindow marks windows whose arrival falls after the scenario end; the retired Ariane 5 is historical only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, query } from '../src/core/engine.js';
import * as calendar from '../src/sim/calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const transit = (id) => data.index.destinations[id]?.transitWeeks || 0;

test('nextWindow (no args) returns the earliest window that still arrives by the end of the scenario', () => {
  const s = newGame(data, { seed: 11, playerId: 'nasa' });
  const w = query(s, data, 'missions/nextWindow');
  assert.ok(w && w.destination, 'some window');
  assert.equal(w.late, false);
  assert.equal(w.lateText, null);
  assert.ok(w.arrivalTurn <= s.endTurn, `${w.destination} arrives by the end`);
  assert.equal(w.arrivalTurn, Math.max(s.turn, w.openTurn) + transit(w.destination));
  // no reachable window opens earlier than the one returned
  for (const d of data.destinations.destinations.filter((x) => x.window?.periodWeeks)) {
    const one = query(s, data, 'missions/nextWindow', d.id);
    if (!one.late) assert.ok(one.openTurn >= w.openTurn, `${d.id} opens before ${w.destination}`);
  }
});

test('nextWindow per destination: far worlds are marked late with the pt-BR warning', () => {
  const s = newGame(data, { seed: 11, playerId: 'esa' });
  const far = data.destinations.destinations.find((d) => d.window?.periodWeeks && d.transitWeeks > s.endTurn);
  assert.ok(far, 'a destination whose transit alone outlasts the era');
  const w = query(s, data, 'missions/nextWindow', far.id);
  assert.equal(w.late, true);
  assert.ok(w.arrivalTurn > s.endTurn);
  assert.match(w.lateText, /^Não dá para chegar antes do fim de 2030: chegada só em /);
  const mars = query(s, data, 'missions/nextWindow', 'mars_orbit');
  assert.equal(mars.late, false);
});

test('nextWindow near the end: nothing reachable → earliest window, marked late', () => {
  const s = newGame(data, { seed: 3, playerId: 'nasa' });
  s.turn = s.endTurn - 2;
  const w = query(s, data, 'missions/nextWindow');
  assert.ok(w, 'still answers');
  assert.equal(w.late, true);
  assert.ok(w.lateText.startsWith('Não dá para chegar antes do fim de 2030'));
  const all = data.destinations.destinations.filter((d) => d.window?.periodWeeks).map((d) => query(s, data, 'missions/nextWindow', d.id));
  assert.equal(w.openTurn, Math.min(...all.map((x) => x.openTurn)));
});

test('Ariane 5: retired, historical vehicle of BepiColombo and JUICE, never offered for new missions', () => {
  const a5 = data.index.vehicles.ariane5;
  assert.ok(a5, 'ariane5 in vehicles.json');
  assert.equal(a5.name, 'Ariane 5');
  assert.ok(a5.retired && a5.availableUntil && a5.availableUntil.year < 2026);
  assert.equal(a5.backgroundPerYear, 0);
  for (const id of ['bepicolombo', 'juice']) {
    const c = data.index.calendar[id];
    assert.equal(c.vehicleId, 'ariane5', id);
    assert.ok(calendar.capacityTo(data, 'ariane5', c.destination) >= data.index.spacecraft[c.spacecraftId].massT, `${id} fits`);
  }
  const s = newGame(data, { seed: 5, playerId: 'esa' });
  for (const pid of ['esa', 'nasa', 'isro']) {
    assert.ok(!calendar.availableVehicles(s, data, pid).some((v) => v.id === 'ariane5'), `${pid} cannot buy it`);
  }
  assert.equal(calendar.inServiceAt(s, data, a5, 0), false);
  assert.ok(calendar.availableVehicles(s, data, 'esa').some((v) => v.id === 'ariane6'), 'Ariane 6 still flies');
});

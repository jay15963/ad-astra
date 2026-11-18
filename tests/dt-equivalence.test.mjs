// Sim-agnostic time glue (src/sim/simtime.js, docs/EXPANSION.md §1.4): at dt = 1 every helper is exactly the old
// expression (`turn % N === k`, isMonthStart, `startYear + floor(turn/52)`), and at larger dt it counts the events
// inside the step window. Also: content date windows, legacy era start, hardware service life, era AI goals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { every, crossed, monthCrossed, perStep, chanceInStep, dueIn, expiryIn, yearAt, inYearWindow, legacyFromYear, retireYearOf, aiGoals } from '../src/sim/simtime.js';
import { turnToDate } from '../src/core/time.js';

const st = (turn, startYear = 2026) => ({ turn, startYear });
const cx = (prevTurn, dt) => ({ prevTurn, dt, turn: prevTurn });

test('dt = 1: crossed(N, k) is exactly turn % N === k, for every turn and phase', () => {
  for (const N of [4, 13, 52]) {
    for (const k of [0, 2, 5, N - 1].filter((x) => x < N)) {
      for (let t = 0; t < 2 * 52 + 3; t++) assert.equal(crossed(st(t), cx(t, 1), N, k), t % N === k, `N=${N} k=${k} t=${t}`);
    }
  }
  // without engine ctx (old engine): same answer from state.turn
  for (let t = 0; t < 60; t++) assert.equal(crossed(st(t), {}, 13, 12), t % 13 === 12);
});

test('dt = 1: monthCrossed equals the old isMonthStart', () => {
  const monthKey = (turn, sy) => { const d = turnToDate(turn, sy); return d.year * 12 + d.month; };
  for (let t = 0; t < 3 * 52; t++) {
    const old = t === 0 || monthKey(t, 2026) !== monthKey(t - 1, 2026);
    assert.equal(monthCrossed(st(t), cx(t, 1)), old, `t=${t}`);
  }
});

test('every() counts the period points inside [prevTurn, prevTurn + dt) for dt 2, 4, 13, 26, 52', () => {
  for (const dt of [2, 4, 13, 26, 52]) {
    for (const N of [4, 13, 52]) {
      for (const k of [0, 3 % N, N - 1]) {
        for (let p0 = 0; p0 < 120; p0 += dt) {
          let brute = 0;
          for (let t = p0; t < p0 + dt; t++) if (t % N === k) brute++;
          assert.equal(every(st(p0 + dt), cx(p0, dt), N, k), brute, `dt=${dt} N=${N} k=${k} p0=${p0}`);
        }
      }
    }
  }
});

test('a 52-week step crosses exactly one year boundary and 12 month starts', () => {
  for (let y = 0; y < 5; y++) {
    const p0 = y * 52;
    assert.equal(every(st(p0 + 52), cx(p0, 52), 52, 0), 1);
    assert.equal(monthCrossed(st(p0 + 52), cx(p0, 52)), true);
  }
});

test('rate helpers reduce to the weekly value at dt = 1', () => {
  assert.equal(perStep(3, cx(0, 1)), 3);
  assert.equal(perStep(3, cx(0, 13)), 39);
  assert.equal(chanceInStep(0.1, cx(0, 1)), 0.1);
  assert.ok(Math.abs(chanceInStep(0.1, cx(0, 2)) - 0.19) < 1e-12);
  assert.equal(dueIn(st(10), cx(10, 1), 10), true);
  assert.equal(dueIn(st(10), cx(10, 1), 11), false);
  assert.equal(dueIn(st(10), cx(10, 13), 22), true);
  assert.equal(expiryIn(st(10), cx(10, 1), 4), 14);
  assert.equal(expiryIn(st(10), cx(10, 26), 4), 36);
});

test('calendar year of a turn has no 2026 default', () => {
  assert.equal(yearAt(st(0, 1950)), 1950);
  assert.equal(yearAt(st(54599, 1950)), 2999);
  assert.equal(yearAt(st(54600, 1950)), 3000);
  assert.equal(yearAt(st(51, 2026)), 2026);
  assert.equal(yearAt(st(52, 2026)), 2027);
});

test('content windows: fromYear/untilYear, availableFrom/Until, undated legacy content opens with its era', () => {
  assert.equal(inYearWindow({ fromYear: 1957 }, 1956), false);
  assert.equal(inYearWindow({ fromYear: 1957 }, 1957), true);
  assert.equal(inYearWindow({ availableUntil: { year: 2030, month: 12 } }, 2031), false);
  assert.equal(inYearWindow({}, 1950), true);
  assert.equal(inYearWindow({}, 1950, { undatedFrom: 2026 }), false);
  assert.equal(inYearWindow({}, 2026, { undatedFrom: 2026 }), true);
  assert.equal(legacyFromYear({}), 2026); // fallback era table: legacy pack = e4
  assert.equal(legacyFromYear({ packsLoaded: { 'legacy-e4': 'x' } }), 2026);
});

test('hardware without a retirement date has a service life (Falcon 9 does not fly in 2900)', () => {
  assert.equal(retireYearOf({}, { availableFrom: { year: 2010, month: 6 } }), 2060);
  assert.equal(retireYearOf({ vehicles: { serviceLifeYears: 30 } }, { availableFrom: { year: 2010 } }), 2040);
  assert.equal(retireYearOf({}, { availableFrom: { year: 1996 }, availableUntil: { year: 2023, month: 7 } }), 2023);
  assert.equal(retireYearOf({}, {}), Infinity);
});

test('AI goals follow the lineage era profile when the data has one, else the actor goals', () => {
  const data = { lineages: { lineages: [{ id: 'nasa', eraProfiles: { e1: { ai: { goals: ['first_satellite'] } } } }] } };
  const s1950 = { turn: 0, startYear: 1950, actors: { nasa: { id: 'nasa', ai: { goals: ['crewed_lunar_landing'] } } } };
  assert.deepEqual(aiGoals(s1950, data, 'nasa'), ['first_satellite']);
  const s2026 = { ...s1950, startYear: 2026 };
  assert.deepEqual(aiGoals(s2026, data, 'nasa'), ['crewed_lunar_landing']);
});

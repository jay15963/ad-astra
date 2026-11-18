// Time model 1950–3000 (EXPANSION.md §1, §13.2): bands, grid, dates, step helpers, truncated steps, substepping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  WEEKS_PER_YEAR, turnToDate, dateToTurn, formatTurn, weeksToText, DEFAULT_ERAS, eraTable, eraAt, bandAt, gridNext,
  nextEraTurn, stepLabel, formatTurnEra, yearOf,
} from '../src/core/time.js';
import { every, crossed, perStep, chanceInStep, decay, dueIn, cadence, expiryIn, liveActors, resolveActor, actorInfo } from '../src/core/helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const erasJson = JSON.parse(readFileSync(path.join(root, 'data', 'core', 'eras.json'), 'utf8'));
const data = { eras: erasJson };
const campaign = { startYear: 1950, clock: { turnWeeks: null } };

/** Walk the grid from 1950 to 3000 exactly as the engine does without appointments. */
function walk(state = campaign, d = data) {
  const final = dateToTurn(3000, 0, state.startYear);
  const turns = [];
  let t = 0;
  while (t < final) {
    const lim = Math.min(gridNext(d, state, t), nextEraTurn(d, state, t), final);
    turns.push([t, lim - t]);
    t = lim;
  }
  return { turns, end: t };
}

test('eras.json: the code fallback equals the data file (data stays the source of truth)', () => {
  const strip = (b) => ({ id: b.id, from: b.from, to: b.to, eraId: b.eraId, stepWeeks: b.stepWeeks });
  assert.deepEqual(erasJson.bands.map(strip), DEFAULT_ERAS.bands.map(strip));
  assert.deepEqual(erasJson.final, DEFAULT_ERAS.final);
  assert.deepEqual(erasJson.eras.map((e) => [e.id, e.n, e.name, e.from, e.truthLayer]), DEFAULT_ERAS.eras.map((e) => [e.id, e.n, e.name, e.from, e.truthLayer]));
  assert.equal(eraTable({}).bands.length, 9);
  assert.equal(eraTable(data).bands, erasJson.bands);
});

test('bands: every band starts in January and every step divides 52; bands are contiguous 1950–2999', () => {
  let prev = 1949;
  for (const b of erasJson.bands) {
    assert.equal(WEEKS_PER_YEAR % b.stepWeeks, 0, `${b.id} step ${b.stepWeeks}`);
    assert.equal(b.from, prev + 1, `${b.id} contíguo`);
    prev = b.to;
  }
  assert.equal(prev, 2999);
});

test('campaign grid: exactly 3,670 turns from 1950 to jan/3000, final turn 54,600', () => {
  assert.equal(dateToTurn(3000, 0, 1950), 54600);
  const { turns, end } = walk();
  assert.equal(end, 54600);
  assert.equal(turns.length, 3670);
  // the bands' turn counts of §1.2
  const per = {};
  for (const [t] of turns) { const id = erasJson.bands[bandAt(data, campaign, t).idx].id; per[id] = (per[id] || 0) + 1; }
  assert.deepEqual(per, { b1: 24, b2: 520, b3: 312, b4: 338, b5: 650, b6: 596, b7: 800, b8: 390, b9: 40 });
  // without truncation every step is a whole band step
  for (const [t, dt] of turns) assert.equal(dt, bandAt(data, campaign, t).stepWeeks, `t${t}`);
});

test('grid checks: every band boundary is on the grid of both sides', () => {
  const checks = [[1956, 312, 13], [1976, 1352, 4], [2000, 2600, 4], [2026, 3952, 2], [2051, 5252, 13], [2200, 13000, 26], [2600, 33800, 52], [2990, 54080, 13], [3000, 54600, 13]];
  for (const [year, turn, div] of checks) {
    assert.equal(dateToTurn(year, 0, 1950), turn, `${year}`);
    assert.equal(turn % div, 0, `${year} ÷ ${div}`);
  }
});

test('eras: eraAt per year, boundaries fall exactly on turns', () => {
  const expect = { 1950: 'e1', 1975: 'e1', 1976: 'e2', 1999: 'e2', 2000: 'e3', 2026: 'e4', 2050: 'e4', 2051: 'e5', 2199: 'e5', 2200: 'e6', 2600: 'e7', 2999: 'e7', 3000: 'e7' };
  for (const [y, id] of Object.entries(expect)) assert.equal(eraAt(data, Number(y)).id, id, y);
  assert.equal(nextEraTurn(data, campaign, 0), dateToTurn(1976, 0, 1950));
  assert.equal(nextEraTurn(data, campaign, dateToTurn(2600, 0, 1950)), Infinity);
  // every era start is a turn the walk lands on
  const landed = new Set(walk().turns.map(([t]) => t));
  for (const e of erasJson.eras) assert.ok(landed.has(dateToTurn(e.from.year, 0, 1950)), e.id);
});

test('fixed turnWeeks (Corrida Lunar) overrides the band step; era still from the calendar', () => {
  const lunar = { startYear: 2026, clock: { turnWeeks: 1 } };
  for (const t of [0, 1, 51, 52, 259]) {
    assert.equal(bandAt(data, lunar, t).stepWeeks, 1);
    assert.equal(gridNext(data, lunar, t), t + 1);
    assert.equal(bandAt(data, lunar, t).eraId, 'e4');
  }
});

test('turnToDate/dateToTurn round-trip 1950–3000 (first week of each month, every 7 years)', () => {
  for (let y = 1950; y <= 3000; y += 7) {
    for (let m = 0; m < 12; m++) {
      const t = dateToTurn(y, m, 1950);
      const d = turnToDate(t, 1950);
      assert.equal(d.year, y);
      assert.equal(d.month, m);
      assert.equal(yearOf({ startYear: 1950 }, t), y);
    }
  }
  assert.equal(formatTurn(dateToTurn(1962, 2, 1950), 1950), 'mar/1962');
});

test('labels and date chips for every step length', () => {
  assert.equal(stepLabel(1), '+1 sem');
  assert.equal(stepLabel(2), '+2 sem');
  assert.equal(stepLabel(4), '+4 sem');
  assert.equal(stepLabel(13), '+1 trimestre');
  assert.equal(stepLabel(26), '+1 semestre');
  assert.equal(stepLabel(52), '+1 ano');
  assert.ok(stepLabel(39).startsWith('+'));
  assert.ok(!/undefined|NaN/.test(stepLabel(7)));
  const t = dateToTurn(2087, 7, 1950);
  assert.equal(formatTurnEra(dateToTurn(1962, 2, 1950), 1950, 2), 'mar/1962');
  assert.equal(formatTurnEra(t, 1950, 13), 'T3 2087');
  assert.equal(formatTurnEra(dateToTurn(2300, 0, 1950), 1950, 26), 'S1 2300');
  assert.equal(formatTurnEra(dateToTurn(2741, 5, 1950), 1950, 52), '2741');
  // weeksToText keeps v0.5 outputs and reaches decades/centuries
  assert.equal(weeksToText(3), '3 sem');
  assert.equal(weeksToText(26), '6 meses');
  assert.equal(weeksToText(130), '2,5 anos');
  assert.equal(weeksToText(52 * 30), '30 anos');
  assert.equal(weeksToText(52 * 300), '3 séculos');
});

// ---- step helpers --------------------------------------------------------------------------------------------

const ctxAt = (prevTurn, dt) => ({ prevTurn, dt, turn: prevTurn });

test('helpers at dt = 1 reduce exactly to the weekly expressions', () => {
  for (let t = 0; t < 300; t++) {
    const c = ctxAt(t, 1);
    for (const [p, ph] of [[52, 51], [52, 0], [13, 3], [4, 0], [2, 1]]) {
      assert.equal(crossed(c, p, ph), t % p === ph, `t${t} %${p}==${ph}`);
      assert.equal(every(c, p, ph), t % p === ph ? 1 : 0);
    }
    assert.equal(perStep(2.5, c), 2.5);
    assert.equal(chanceInStep(0.1, c), 0.1);
    assert.equal(decay(10, 0.9, c), 9);
    assert.equal(dueIn(c, t), true);
    assert.equal(dueIn(c, t + 1), false);
    assert.equal(cadence(c, { weeks: 4 }), t % 4 === 0);
    assert.equal(expiryIn(c, 3), t + 3);
  }
});

test('every/crossed/dueIn/cadence at dt 2, 4, 13, 26, 52 count the weeks of the window', () => {
  for (const dt of [2, 4, 13, 26, 52]) {
    for (let a = 0; a < 520; a += dt) {
      const c = ctxAt(a, dt);
      for (const [p, ph] of [[52, 51], [52, 0], [13, 0], [4, 2], [26, 25], [104, 7]]) {
        let n = 0;
        for (let t = a; t < a + dt; t++) if (t % p === ph) n++;
        assert.equal(every(c, p, ph), n, `dt${dt} a${a} p${p} ph${ph}`);
        assert.equal(crossed(c, p, ph), n > 0);
      }
      assert.equal(dueIn(c, a + dt - 1), true);
      assert.equal(dueIn(c, a + dt), false);
      assert.equal(dueIn(c, null), false);
      // cadence never fires more often than once per minSteps steps
      assert.equal(cadence(c, { weeks: 1, minSteps: 2 }), crossed(c, 2 * dt));
      assert.equal(expiryIn(c, 1), a + dt);
    }
    // a year of steps fires the yearly hook exactly once
    let years = 0;
    for (let a = 0; a < 52 * 3; a += dt) years += every(ctxAt(a, dt), 52);
    assert.equal(years, 3);
  }
});

test('rate helpers compound over the step', () => {
  const c = ctxAt(0, 13);
  assert.equal(perStep(2, c), 26);
  assert.ok(Math.abs(chanceInStep(0.1, c) - (1 - 0.9 ** 13)) < 1e-12);
  assert.ok(Math.abs(decay(100, 0.95, c) - 100 * 0.95 ** 13) < 1e-9);
  assert.equal(chanceInStep(0, c), 0);
  assert.equal(chanceInStep(1, c), 1);
  // missing ctx fields behave like a weekly step
  assert.equal(perStep(3, {}), 3);
  assert.equal(every({ turn: 51 }, 52, 51), 1);
});

test('actor helpers: liveActors by tier, aliases, tombstones', () => {
  const s = {
    actors: { nasa: { name: 'NASA' }, cnes: { name: 'CNES', tier: 'minor' } },
    lifecycle: { aliases: { abma: 'nasa', old: 'abma' }, tombstones: { eldo: { id: 'eldo', name: 'ELDO' } } },
  };
  assert.deepEqual(liveActors(s), ['nasa', 'cnes']);
  assert.deepEqual(liveActors(s, { tier: 'core' }), ['nasa']);
  assert.deepEqual(liveActors(s, { tier: 'minor' }), ['cnes']);
  assert.equal(resolveActor(s, 'old'), 'nasa');
  assert.equal(resolveActor(s, 'zzz'), 'zzz');
  assert.equal(actorInfo(s, 'abma').name, 'NASA');
  assert.equal(actorInfo(s, 'eldo').name, 'ELDO');
  assert.equal(actorInfo(s, 'zzz'), null);
  assert.deepEqual(liveActors({}), []);
});

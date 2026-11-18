// Phase D2 performance pass: the weekly modules that dominated long steps are dt-native (diplomacy and research up to
// a quarter, politics in 4-week windows), the research tree views share their static parts, and world.pairs is saved
// in columns. Every change keeps dt = 1 (the Corrida Lunar) bit-identical and save/load a fixed point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { packState, unpackState } from '../src/core/savepack.js';
import * as research from '../src/sim/research.js';
import * as diplomacy from '../src/sim/diplomacy.js';
import * as politics from '../src/sim/politics.js';
import { rngFor } from '../src/core/rng.js';

const { newGame, dispatch, serialize, deserialize } = engine;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const hasCampaign = campaign.scenario?.id === 'campaign';

test('cadence contract: diplomacy and research run up to a quarter per tick, politics in 4-week windows', () => {
  assert.equal(diplomacy.meta.maxDt, 13);
  assert.equal(research.meta.maxDt, 13);
  assert.equal(politics.meta.maxDt, 4);
  // a 4-week window never holds two month starts (months are 4 or 5 weeks long), so politics' monthly work runs
  // exactly once a month, as week by week
  const W = 52;
  const mk = (t) => Math.floor((((t % W) + W) % W) / (W / 12)) + 12 * Math.floor(t / W);
  for (let p0 = 0; p0 < 3 * W; p0++) {
    let starts = 0;
    for (let t = p0; t < p0 + 4; t++) if (t === 0 || mk(t) !== mk(t - 1)) starts++;
    assert.ok(starts <= 1, `window at ${p0} holds ${starts} month starts`);
  }
});

function researchState(data) {
  const s = newGame(data, { seed: 21, playerId: 'nasa' });
  for (const d of s.decisions.slice()) if (d.blocking) s.decisions.splice(s.decisions.indexOf(d), 1);
  return s;
}
const rivalTechs = (s) => Object.values(s.research.rivals).reduce((n, l) => n + l.length, 0);

test('research: 4 quarterly ticks research about as much as 52 weekly ticks (rivals carry spare weeks)', { skip: !hasCampaign }, () => {
  const weekly = researchState(campaign);
  const quarter = JSON.parse(JSON.stringify(weekly));
  const p0 = weekly.turn;
  const before = rivalTechs(weekly);
  const pts0 = weekly.research.points;
  for (let k = 0; k < 52; k++) {
    weekly.turn = p0 + k;
    research.tick(weekly, campaign, { prevTurn: p0 + k, dt: 1, turn: p0 + k, rng: (l) => fakeRng(weekly.seed, p0 + k, l) });
  }
  for (let q = 0; q < 4; q++) {
    const t = p0 + 13 * q;
    quarter.turn = t;
    research.tick(quarter, campaign, { prevTurn: t, dt: 13, turn: t, rng: (l) => fakeRng(quarter.seed, t, l) });
  }
  const gw = rivalTechs(weekly) - before, gq = rivalTechs(quarter) - before;
  assert.ok(gw > 0 && gq > 0, `rivals research in a year (weekly ${gw}, quarterly ${gq})`);
  // the same weeks of work; picks differ (other draws), so allow one tech per rival either way
  const rivals = Object.keys(weekly.research.rivals).length;
  assert.ok(Math.abs(gw - gq) <= rivals, `weekly ${gw} vs quarter ${gq}`);
  // science income is 52 weeks of it
  const dw = weekly.research.points - pts0, dq = quarter.research.points - pts0;
  assert.ok(Math.abs(dw - dq) < 0.05 + 1e-9 * Math.abs(dw), `science weekly ${dw} vs quarter ${dq}`);
});

// stand-in for ctx.rng when calling a module tick directly (same shape as the engine's)
function fakeRng(seed, turn, label) { return rngFor(seed, turn, 'research', label); }

test('research tree views: static parts are shared, the view still matches the node and the state', { skip: !hasCampaign }, () => {
  const s = researchState(campaign);
  const a = engine.query(s, campaign, 'research/tree');
  const b = engine.query(s, campaign, 'research/tree');
  assert.deepEqual(a, b);
  assert.ok(a.length > 50);
  // callers get their own objects (mutating one view does not leak into the next)
  const withUnlocks = a.find((v) => v.unlocks.length);
  if (withUnlocks) {
    withUnlocks.unlocks[0].label = 'x';
    const again = engine.query(s, campaign, 'research/tree').find((v) => v.id === withUnlocks.id);
    assert.notEqual(again.unlocks[0].label, 'x');
  }
  // cost = nodeMoneyCost of the node view (research/node builds it alone)
  for (const v of a.slice(0, 30)) assert.deepEqual(engine.query(s, campaign, 'research/node', v.id), v);
});

test('a campaign year with long steps: save/load stays a fixed point and the sim keeps going', { skip: !hasCampaign }, () => {
  let s = newGame(campaign, { seed: 5, playerId: 'nasa' });
  for (let i = 0; i < 60 && !s.gameOver; i++) {
    s.decisions = s.decisions.filter((d) => !d.blocking || d.kind === 'era/transition');
    s.activeLaunch = null;
    for (const d of s.decisions.slice()) dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: d.choices?.[0]?.id });
    dispatch(s, campaign, { type: 'time/advance', turns: 1 });
    if (i % 20 === 19) {
      const json = serialize(s);
      const back = deserialize(json, campaign);
      assert.equal(serialize(back), json);
      s = back;
    }
  }
  assert.ok(s.turn > 60, 'the 1950s step more than a week at a time');
  for (const r of Object.values(s.relations || {})) {
    assert.ok(Number.isFinite(r.trust) && Number.isFinite(r.rivalry) && Number.isFinite(r.dependence));
  }
});

test('world.pairs columns: lossless, compact, and a pair that does not fit falls back to rows', () => {
  const nations = ['usa', 'china', 'india', 'japan', 'europe', 'brazil'];
  const pairs = {};
  let n = 0;
  for (let i = 0; i < nations.length; i++) for (let j = i + 1; j < nations.length; j++) {
    const [a, b] = n % 3 ? [nations[i], nations[j]] : [nations[j], nations[i]];
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairs[k] = { a, b, level: n % 5, pressure: Math.round((n * 0.137 - 0.9) * 1000) / 1000, sinceTurn: n * 977, peak: (n % 5) + 1 > 4 ? 4 : n % 5, changes: n * 3 };
    n++;
  }
  pairs[Object.keys(pairs)[2]].pressure = -0.25;
  const st = { endTurn: 54600, turn: 9, actors: {}, world: { pairs, globalTension: 1.2 } };
  const plain = JSON.stringify(st);
  const json = JSON.stringify(packState(st));
  assert.ok(json.includes('"$q"'), 'columns used');
  assert.ok(json.length < plain.length * 0.75, `columns ${json.length} vs plain ${plain.length}`);
  assert.equal(JSON.stringify(unpackState(JSON.parse(json))), plain);
  // a fractional turn (or any unexpected value) keeps the row format, still lossless
  const odd = JSON.parse(plain);
  odd.world.pairs[Object.keys(odd.world.pairs)[0]].sinceTurn = 3.5;
  const oddPlain = JSON.stringify(odd);
  const oddJson = JSON.stringify(packState(odd));
  assert.ok(!oddJson.includes('"$q"') && oddJson.includes('"$p"'));
  assert.equal(JSON.stringify(unpackState(JSON.parse(oddJson))), oddPlain);
});

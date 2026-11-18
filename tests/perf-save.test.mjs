// Phase B performance pass: signals are delivered once per step to substepped modules, the compact save encoding of
// long campaigns (src/core/savepack.js) is lossless, and the read-only memos give the same answers as the plain code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { packState, unpackState, packable, PACK_MARK } from '../src/core/savepack.js';
import { relKey, emitSignal } from '../src/core/helpers.js';

const { newGame, dispatch, serialize, deserialize, MODULES } = engine;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lunar = await loadDataNode(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const hasCampaign = campaign.scenario?.id === 'campaign';

function withModule(entry, fn) {
  MODULES.push(entry);
  try { return fn(); } finally { MODULES.splice(MODULES.indexOf(entry), 1); }
}

function clearBlocks(s) {
  s.decisions = s.decisions.filter((d) => !d.blocking || d.kind === 'era/transition' || d.kind === 'ending/final');
  s.activeLaunch = null;
}

test('a substepped module sees the step signals once, not once per substep', { skip: !hasCampaign }, () => {
  const s = newGame(campaign, { seed: 3, playerId: 'nasa' });
  const seen = [];
  const probe = ['zz_probe', { meta: { maxDt: 1 }, tick: (st) => { for (const x of st.signals || []) if (x.type === 'zz/test') seen.push(st.turn); } }];
  withModule(probe, () => {
    clearBlocks(s);
    emitSignal(s, 'zz/test', { n: 1 });
    const before = s.turn;
    engine.tick(s, campaign);
    assert.ok(s.turn - before > 1, 'the 1950 prologue steps more than one week');
    assert.equal(seen.length, 1, `signal handled ${seen.length} times`);
    assert.equal(seen[0], before);
    // later modules of the same step still read the signals (they are restored after the substeps)
    assert.ok(Array.isArray(s.signals));
  });
});

test('relKey is symmetric and memoized to the same string', () => {
  assert.equal(relKey('nasa', 'cnsa'), 'cnsa|nasa');
  assert.equal(relKey('cnsa', 'nasa'), 'cnsa|nasa');
  assert.equal(relKey('a', 'a'), 'a|a');
  assert.equal(relKey(1, 2), '1|2');
});

test('Corrida Lunar saves are plain JSON (no compact encoding)', () => {
  const s = newGame(lunar, { seed: 5, playerId: 'nasa' });
  assert.equal(packable(s), false);
  const json = serialize(s);
  assert.equal(json, JSON.stringify(s));
  assert.ok(!json.includes(PACK_MARK));
});

test('compact encoding: unpack(pack(state)) is the same state, and save/load is a fixed point', { skip: !hasCampaign }, () => {
  let s = newGame(campaign, { seed: 11, playerId: 'nasa' });
  for (let i = 0; i < 160 && !s.gameOver; i++) {
    clearBlocks(s);
    for (const d of s.decisions.slice()) dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: d.choices?.[0]?.id });
    dispatch(s, campaign, { type: 'time/advance', turns: 1 });
  }
  assert.ok(packable(s));
  const plain = JSON.stringify(s);
  const json = serialize(s);
  assert.ok(json.length < plain.length, `packed ${json.length} ≥ plain ${plain.length}`);
  assert.equal(JSON.stringify(s), plain, 'serialize does not touch the live state');
  const back = deserialize(json, campaign);
  assert.equal(JSON.stringify(back), plain);
  assert.equal(serialize(back), json);
  // a plain (older) campaign save still loads
  const old = deserialize(plain, campaign);
  assert.equal(JSON.stringify(old), plain);
  assert.equal(serialize(old), json);
});

test('compact encoding of hand-made shapes (pairs, mixed-shape arrays, id tables, undefined fields)', () => {
  const st = {
    endTurn: 54600, turn: 9, actors: { x: { id: 'x', list: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    world: {
      pairs: {
        'chn|usa': { a: 'usa', b: 'chn', level: 2, pressure: -0.125, sinceTurn: 4, peak: 3, changes: 7 },
        'fra|ger': { a: 'fra', b: 'ger', level: 0, pressure: 0, sinceTurn: 0, peak: 0, changes: 0 },
        'odd|x': { a: 'odd', b: 'x', level: 1, extra: true },
      },
      history: { tension: [{ t: 1, p: 'a' }, { t: 2, p: 'b' }, { t: 3, p: 'c', skip: undefined }] },
    },
    research: { rivals: { a: ['t1', 't2'], b: ['t2', 't3', 't1'] }, bonus: { a: { r: 0.1 } } },
    missions: [
      { id: 1, s: 'done', r: { causes: [{ k: 1 }, { k: 2 }, { k: 3 }] } }, { id: 2, s: 'done', r: null },
      { id: 3, s: 'x', extra: [1, 2] }, { id: 4, s: 'y', extra: [] }, { id: 5, s: 'z', r: { causes: [] } },
    ],
    news: [{ h: 'a' }, null, { h: 'b' }],
    empty: [],
  };
  const plain = JSON.stringify(st);
  const packed = packState(st);
  assert.equal(JSON.stringify(st), plain, 'input untouched');
  const json = JSON.stringify(packed);
  const back = unpackState(JSON.parse(json));
  assert.equal(JSON.stringify(back), plain);
  // actors are never encoded (the title screen reads them straight from the save)
  assert.deepEqual(JSON.parse(json).actors, JSON.parse(plain).actors);
});

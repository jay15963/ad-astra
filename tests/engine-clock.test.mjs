// Engine clock (EXPANSION.md §1.3–1.6, §2.4, §9): variable step, truncated steps, substepping, era transitions,
// the jan/3000 final event, play-disc queries, determinism with save/load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { dateToTurn } from '../src/core/time.js';
import { hash32 } from '../src/core/rng.js';
import { changeActor } from '../src/core/helpers.js';

const { newGame, dispatch, query, isBlocked, serialize, deserialize, stepFor, stepInfo, MODULES, tick, scenarioView } = engine;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lunar = await loadDataNode(root);
const campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const hasCampaign = campaign.scenario?.id === 'campaign';

/** Clear whatever would stop time (the clock is under test, not the player's choices). */
function clearBlocks(s) {
  s.decisions = s.decisions.filter((d) => !d.blocking || d.kind === 'era/transition' || d.kind === 'ending/final');
  s.activeLaunch = null;
}

/** Temporarily add a fake module to the registry. */
function withModule(entry, fn) {
  MODULES.push(entry);
  try { return fn(); } finally { MODULES.splice(MODULES.indexOf(entry), 1); }
}

test('Corrida Lunar: 1 week per turn, era e4, v0.5 end rule, disc label "+1 sem"', () => {
  const s = newGame(lunar, { seed: 1, playerId: 'nasa' });
  assert.equal(s.version, 3); // v2 + the v2 → v3 migration of investors.js (Phase B)
  assert.equal(s.startYear, 2026);
  assert.equal(s.endTurn, 259);
  assert.equal(s.clock.eraId, 'e4');
  assert.equal(s.clock.stepWeeks, 1);
  assert.equal(s.clock.turnWeeks, 1);
  assert.equal(s.clock.finalTurn, null);
  assert.equal(stepFor(s, lunar), 1);
  assert.equal(query(s, lunar, 'time/stepLabel'), '+1 sem');
  const r = dispatch(s, lunar, { type: 'time/advance', turns: 3, stopOnEvent: false });
  assert.equal(s.turn, r.weeks);
  assert.equal(r.weeks, r.advanced);
  // v0.5 callers still count weeks
  const before = s.turn;
  clearBlocks(s);
  const r2 = dispatch(s, lunar, { type: 'time/advance', weeks: 2, stopOnEvent: false });
  if (!r2.stoppedBy) assert.equal(s.turn, before + 2);
  const c = query(s, lunar, 'time/clock');
  assert.equal(c.eraId, 'e4');
  assert.equal(c.dt, 1);
  assert.equal(c.label, '+1 sem');
});

test('scenarioView: legacy file and normalized campaign', () => {
  const v = scenarioView({ id: 'lunar_race', startYear: 2026, endYear: 2030 });
  assert.equal(v.endTurn, 259);
  assert.equal(v.turnWeeks, 1);
  assert.equal(v.endingType, 'end');
  const c = scenarioView({ id: 'campaign', kind: 'campaign', start: { year: 1950, month: 0 }, end: { year: 3000, month: 0 }, turnWeeks: null, ending: { type: 'final' } });
  assert.equal(c.finalTurn, 54600);
  assert.equal(c.endTurn, 54600);
  assert.equal(c.turnWeeks, null);
});

test('campaign starts in jan/1950, era e1, quarterly steps; time/advance counts turns', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const s = newGame(campaign, { seed: 3, playerId: 'nasa' });
  assert.equal(s.startYear, 1950);
  assert.equal(s.turn, 0);
  assert.equal(s.endTurn, 54600);
  assert.equal(s.clock.finalTurn, 54600);
  assert.equal(s.clock.eraId, 'e1');
  assert.equal(stepFor(s, campaign), 13);
  assert.equal(query(s, campaign, 'time/stepLabel'), '+1 trimestre');
  clearBlocks(s);
  const r = dispatch(s, campaign, { type: 'time/advance', turns: 2, stopOnEvent: false });
  assert.equal(r.advanced, 2);
  assert.equal(s.turn, 26);
  assert.equal(s.clock.steps, 2);
  clearBlocks(s);
  // weeks → turns at the current step
  dispatch(s, campaign, { type: 'time/advance', weeks: 13, stopOnEvent: false });
  assert.equal(s.turn, 39);
  assert.ok(Object.keys(s.annals || {}).length >= 0);
});

test('truncated step: a player appointment inside the step stops the tick there, the next tap completes the grid', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const s = newGame(campaign, { seed: 4, playerId: 'nasa' });
  const fake = ['fake_appt', { appointments: (st) => (st.turn < 5 ? [5] : []) }];
  withModule(fake, () => {
    const info = stepInfo(s, campaign);
    assert.equal(info.dt, 5);
    assert.equal(info.truncated, 'appointment');
    assert.equal(info.label, 'até o lançamento');
    clearBlocks(s);
    tick(s, campaign);
    assert.equal(s.turn, 5);
    assert.equal(stepFor(s, campaign), 8); // completes the quarter (grid 13)
    tick(s, campaign);
    assert.equal(s.turn, 13);
  });
});

test('substepping: a module with maxDt 4 runs ceil(dt/4) times over the right windows, turn restored', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const s = newGame(campaign, { seed: 5, playerId: 'nasa' });
  const seen = [];
  const after = [];
  const fake = ['fake_sub', {
    meta: { maxDt: 4 },
    tick: (st, d, ctx) => { seen.push([ctx.prevTurn, ctx.dt, st.turn]); ctx.rng('x').next(); },
  }];
  const fake1 = ['fake_one', { tick: (st, d, ctx) => after.push(ctx.dt) }];
  withModule(fake, () => withModule(fake1, () => {
    clearBlocks(s);
    tick(s, campaign);
  }));
  assert.deepEqual(seen, [[0, 4, 0], [4, 4, 4], [8, 4, 8], [12, 1, 12]]);
  assert.equal(after.length, 13); // default maxDt 1: unconverted modules stay correct week by week
  assert.ok(after.every((d) => d === 1));
  assert.equal(s.turn, 13);
});

test('era transition: pending era blocks, needs its pack, then starts the next era with its step', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const s = newGame(campaign, { seed: 6, playerId: 'nasa' });
  const e2 = dateToTurn(1976, 0, 1950);
  s.turn = e2 - 2; // last step of 1975 (band b2, 2 weeks)
  s.actors.nasa.prestigeEra = undefined;
  clearBlocks(s);
  assert.equal(stepFor(s, campaign), 2);
  tick(s, campaign);
  assert.equal(s.turn, e2);
  assert.deepEqual({ from: s.clock.pendingEra.from, to: s.clock.pendingEra.to }, { from: 'e1', to: 'e2' });
  assert.equal(isBlocked(s, campaign), 'era');
  const dec = s.decisions.find((d) => d.kind === 'era/transition');
  assert.ok(dec && dec.blocking);
  assert.ok(!/undefined|NaN/.test(`${dec.title} ${dec.body} ${dec.choices[0].label}`), dec.title);
  assert.equal(s.eraHistory.length, 1);
  assert.equal(s.eraHistory[0].eraId, 'e1');
  // advancing is refused while pending
  const adv = dispatch(s, campaign, { type: 'time/advance', turns: 1 });
  assert.equal(adv.advanced, 0);
  assert.equal(adv.stoppedBy, 'era');
  // without the e2 pack: needsData, card stays
  const { e2: _drop, ...rest } = campaign.packsLoaded;
  const lazy = { ...campaign, packsLoaded: rest };
  assert.equal(isBlocked(s, lazy), 'needsData');
  const refused = dispatch(s, lazy, { type: 'decision/resolve', id: dec.id, choiceId: 'continue' });
  assert.equal(refused.ok, false);
  assert.equal(refused.needsData, 'e2');
  assert.equal(refused.error, 'Carregando a próxima era…');
  assert.ok(s.decisions.some((d) => d.id === dec.id));
  // with the pack
  const ok = dispatch(s, campaign, { type: 'decision/resolve', id: dec.id, choiceId: 'continue' });
  assert.equal(ok.ok, true);
  assert.equal(s.clock.eraId, 'e2');
  assert.equal(s.clock.pendingEra, null);
  assert.equal(s.clock.eraStartTurn, e2);
  assert.equal(s.actors.nasa.prestigeEra, 0);
  assert.equal(isBlocked(s, campaign), null);
  assert.equal(stepFor(s, campaign), 4);
  assert.equal(query(s, campaign, 'time/stepLabel'), '+4 sem');
  // era prestige follows prestige gains from now on
  changeActor(s, 'nasa', 'prestige', 7);
  assert.equal(s.actors.nasa.prestigeEra, 7);
});

test('final event: jan/3000 pushes the blocking ending card with Contato, Silêncio, Herança; choosing ends the game', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const s = newGame(campaign, { seed: 7, playerId: 'nasa' });
  s.turn = 54600 - 13;
  s.clock.eraId = 'e7';
  clearBlocks(s);
  assert.equal(stepFor(s, campaign), 13);
  assert.equal(query(s, campaign, 'time/stepLabel'), '+1 trimestre');
  tick(s, campaign);
  assert.equal(s.turn, 54600);
  assert.equal(s.gameOver, null);
  const dec = s.decisions.find((d) => d.kind === 'ending/final');
  assert.ok(dec?.blocking);
  assert.deepEqual(dec.choices.map((c) => c.id), ['contato', 'silencio', 'heranca']);
  assert.ok(dec.choices.every((c) => !c.disabled));
  assert.equal(isBlocked(s, campaign), 'decision');
  const r = dispatch(s, campaign, { type: 'decision/resolve', id: dec.id, choiceId: 'heranca' });
  assert.equal(r.ok, true);
  assert.equal(s.gameOver.reason, 'ending');
  assert.equal(s.gameOver.ending, 'heranca');
  assert.ok(s.gameOver.summary && !/undefined/.test(s.gameOver.summary));
  assert.equal(s.decisions.length, 0);
  assert.equal(isBlocked(s, campaign), 'gameOver');
});

test('determinism: same seed and actions give the same state, with save/load at every step', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const run = (reload) => {
    let s = newGame(campaign, { seed: 99, playerId: 'nasa' });
    for (let i = 0; i < 40; i++) {
      for (const d of s.decisions.slice()) dispatch(s, campaign, { type: 'decision/resolve', id: d.id, choiceId: (d.choices.find((c) => !c.disabled) || d.choices[0])?.id });
      s.activeLaunch = null;
      dispatch(s, campaign, { type: 'time/advance', turns: 1, stopOnEvent: false });
      if (reload) s = deserialize(serialize(s), campaign);
    }
    return s;
  };
  const a = run(false);
  const b = run(true);
  assert.ok(a.turn > 26 * 4, `turn ${a.turn}`);
  assert.equal(hash32(serialize(a)), hash32(serialize(b)));
});

test('caps: news ≤ 120 and log ≤ 80 with annals keeping each year top headlines', () => {
  const s = newGame(lunar, { seed: 8, playerId: 'esa' });
  for (let i = 0; i < 120 && !s.gameOver; i++) { clearBlocks(s); s.decisions = []; tick(s, lunar); }
  assert.ok(s.news.length <= 120);
  assert.ok(s.log.length <= 80);
  const years = Object.keys(s.annals);
  assert.ok(years.includes('2026'));
  for (const y of years) {
    assert.ok(s.annals[y].length <= 3);
    for (const a of s.annals[y]) assert.ok(a.h.length <= 90 && a.i >= 1);
  }
});

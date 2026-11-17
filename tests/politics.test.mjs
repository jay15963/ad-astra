// Tests for src/sim/politics.js (economy, elections, tension 0-4, exogenous events, news, decisions).
// Runs the politics module in isolation (actors copied from data/actors.json, or fixtures if it is empty),
// so the results do not depend on other modules being finished.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import { relKey, emitSignal } from '../src/core/helpers.js';
import * as politics from '../src/sim/politics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const FIXTURE = [
  ['nasa', 'agency', 'EUA', 9000], ['spacex', 'company', 'EUA', 5000], ['blueorigin', 'company', 'EUA', 2500],
  ['cnsa', 'agency', 'China', 6000], ['isro', 'agency', 'Índia', 1600], ['esa', 'agency', 'Europa', 3500],
  ['roscosmos', 'agency', 'Rússia', 2200], ['jaxa', 'agency', 'Japão', 1500],
].map(([id, kind, country, budget]) => ({ id, name: id, short: id.toUpperCase(), kind, country, budget, support: 60, reputation: 60, culture: 0, prestige: 0, capabilities: { crewed: true } }));

const ctxFor = (state) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'politics', l), date: turnToDate(state.turn, state.startYear) });

function setup(seed, playerId = 'nasa') {
  const state = createState(data, { seed, playerId });
  const acts = data.actors?.actors?.length ? data.actors.actors : FIXTURE;
  for (const a of acts) state.actors[a.id] = { ...structuredClone(a), cash: a.budget * 0.25 };
  for (const r of data.actors?.relations || []) state.relations[relKey(r.a, r.b)] = { trust: r.trust, dependence: r.dependence, rivalry: r.rivalry };
  for (const b of data.actors?.blocs || []) state.blocs[b.id] = structuredClone(b);
  state.treaties = structuredClone(data.actors?.treaties || []);
  politics.init(state, data, ctxFor(state));
  return state;
}

function step(state, { resolve = true } = {}) {
  if (resolve) {
    for (const d of state.decisions.slice()) {
      if (d.expiresTurn != null && state.turn < d.expiresTurn && !d.kind.startsWith('politics/')) continue;
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      state.decisions.splice(state.decisions.indexOf(d), 1);
      politics.decisionHandlers['politics/*'](state, data, d, c?.id, ctxFor(state));
    }
  }
  state.signals = state.signalsPending;
  state.signalsPending = [];
  politics.tick(state, data, ctxFor(state));
  state.turn += 1;
}

function run(seed, weeks = 260, playerId = 'nasa') {
  const state = setup(seed, playerId);
  for (let i = 0; i < weeks && state.turn <= state.endTurn; i++) step(state);
  return state;
}

const fingerprint = (s) => JSON.stringify({ world: s.world, politics: s.politics, tension: s.tension, budgets: Object.fromEntries(Object.entries(s.actors).map(([k, a]) => [k, a.budget])), news: s.news.map((n) => n.headline) });

test('init: plausible Nov-2026 tensions, slices are JSON and every actor has a political entry', () => {
  const s = setup(1234);
  assert.ok([1, 2].includes(politics.tensionBetween(s, 'nasa', 'cnsa')), 'EUA–China starts at 1-2');
  assert.equal(politics.tensionBetween(s, 'esa', 'roscosmos'), 2);
  assert.equal(politics.tensionBetween(s, 'nasa', 'roscosmos'), 2);
  assert.equal(politics.tensionBetween(s, 'isro', 'cnsa'), 1);
  assert.equal(politics.tensionBetween(s, 'nasa', 'spacex'), 0, 'same nation is always 0');
  assert.equal(politics.tensionBetween(s, 'spacex', 'cnsa'), politics.tensionBetween(s, 'nasa', 'cnsa'), 'companies follow their nation');
  for (const id of Object.keys(s.actors)) {
    const p = s.politics[id];
    assert.ok(p, `politics entry for ${id}`);
    assert.ok('government' in p && 'stance' in p && 'nextElectionTurn' in p && 'priority' in p);
  }
  assert.ok(s.politics.nasa.nextElectionTurn > 0, 'US midterm scheduled');
  assert.equal(s.politics.spacex.kind, 'company');
  assert.deepEqual(JSON.parse(JSON.stringify({ w: s.world, p: s.politics, t: s.tension })), { w: s.world, p: s.politics, t: s.tension });
});

test('determinism: same seed gives the same world, including across a save/load roundtrip', () => {
  const a = run(4242, 260);
  const b = run(4242, 260);
  assert.equal(fingerprint(a), fingerprint(b));
  // roundtrip midway
  const c = setup(4242);
  for (let i = 0; i < 130; i++) step(c);
  const c2 = JSON.parse(JSON.stringify(c));
  for (let i = 0; i < 130; i++) step(c2);
  assert.equal(fingerprint(c2), fingerprint(a));
});

test('divergence: 20 seeds produce different, plausible worlds', () => {
  const sigs = new Set();
  const electionSigs = new Set();
  let changes = 0;
  for (let s = 1; s <= 20; s++) {
    const st = run(s * 7919, 260);
    sigs.add(JSON.stringify(Object.values(st.world.pairs).map((p) => p.level)) + st.world.history.tension.map((h) => h.turn).join(','));
    electionSigs.add(st.world.history.elections.map((e) => e.result).join(','));
    changes += st.world.history.tension.length;
    assert.ok(st.world.history.elections.length >= 8, 'real-ish election calendar ran');
  }
  assert.ok(sigs.size >= 18, `tension trajectories should diverge (got ${sigs.size}/20)`);
  assert.ok(electionSigs.size >= 5, 'elections diverge');
  assert.ok(changes / 20 >= 4 && changes / 20 <= 40, `tension moves plausibly (${changes / 20} changes per world)`);
});

test('invariants over 20 seeds: budgets stay positive (above floor), tension in 0..4, news is capped', () => {
  for (let s = 1; s <= 20; s++) {
    const st = run(s * 104729, 260, s % 2 ? 'nasa' : 'spacex');
    for (const [id, a] of Object.entries(st.actors)) {
      assert.ok(a.budget > 0, `${id} budget positive`);
      assert.ok(a.budget >= st.world.baseBudget[id] * 0.4 - 1e-6, `${id} budget above floor`);
      assert.ok(Number.isFinite(a.budget));
    }
    for (const [k, v] of Object.entries(st.tension)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 4, `tension ${k}=${v}`);
    for (const p of Object.values(st.world.pairs)) assert.ok(p.level >= 0 && p.level <= 4);
    assert.ok(st.world.globalTension >= 0 && st.world.globalTension <= 4);
    const perMonth = {};
    for (const n of st.news.filter((x) => x.tags.includes('politics'))) {
      const d = turnToDate(n.turn, st.startYear);
      const k = `${d.year}-${d.month}`;
      perMonth[k] = (perMonth[k] || 0) + 1;
    }
    const max = Math.max(...Object.values(perMonth));
    assert.ok(max <= 8, `political news per month capped (max ${max})`);
    const total = Object.values(perMonth).reduce((x, y) => x + y, 0);
    assert.ok(total / 60 <= 3.5, `not spammy: ${(total / 60).toFixed(2)} per month on average`);
    for (const p of Object.values(st.politics)) assert.ok(p.stance >= -1 && p.stance <= 1);
  }
});

test('annual rollover adjusts budgets and emits budget/changed + digest news', () => {
  const s = setup(99, 'esa');
  while (s.turn < 52) step(s);
  const before = Object.fromEntries(Object.entries(s.actors).map(([k, a]) => [k, a.budget]));
  step(s); // turn 52 = week 1 of 2027
  const changed = s.signalsPending.filter((x) => x.type === 'budget/changed');
  assert.ok(changed.length >= 5, 'most actors got a new budget');
  assert.ok(changed.every((c) => c.from === before[c.actorId] || c.reason !== 'orçamento anual'));
  assert.ok(s.news.some((n) => n.tags.includes('budget') && /2027/.test(n.headline)), 'budget news for 2027');
  assert.ok(s.world.history.budgets.some((b) => b.year === 2027));
});

test('setTension/tensionBetween: bounds, nation sync, signal, news and level effects', () => {
  const s = setup(7);
  s.turn = 20;
  const lvl = politics.setTension(s, 'nasa', 'cnsa', 9, 'teste', data);
  assert.equal(lvl, 4, 'clamped to 4');
  assert.equal(politics.tensionBetween(s, 'spacex', 'cnsa'), 4, 'all actor pairs follow the nation pair');
  const sig = s.signalsPending.find((x) => x.type === 'tension/changed');
  assert.ok(sig && sig.to === 4 && sig.nations.includes('usa'));
  assert.ok(s.signalsPending.some((x) => x.type === 'politics/suspension'), 'level 4 suspends programs');
  assert.ok(s.world.conflicts.some((c) => c.pair === 'china|usa' && c.peak === 4 && c.endTurn == null));
  assert.ok(s.news.some((n) => n.importance === 3), 'war is big news');
  assert.ok(s.decisions.some((d) => d.kind === 'politics/suspension'), 'player (NASA) gets a decision');
  politics.setTension(s, 'cnsa', 'nasa', -3, 'teste', data);
  assert.equal(politics.tensionBetween(s, 'nasa', 'cnsa'), 1, 'floor keeps EUA–China at >= 1');
  assert.ok(s.world.conflicts.find((c) => c.pair === 'china|usa').endTurn != null, 'conflict ended');
  assert.equal(politics.tensionBetween(s, 'nasa', 'nasa'), 0);
  // external writes: a jump of 2+ is adopted at the next tick; a ±1 nudge becomes pressure
  const lv0 = s.world.pairs['china|india'].level;
  s.tension[relKey('isro', 'cnsa')] = lv0 + 2;
  step(s);
  assert.equal(politics.tensionBetween(s, 'isro', 'cnsa'), lv0 + 2);
  assert.equal(s.world.pairs['china|india'].level, lv0 + 2);
  const pr0 = s.world.pairs['china|japan'].pressure;
  const jl = s.world.pairs['china|japan'].level;
  s.tension[relKey('jaxa', 'cnsa')] = Math.min(4, jl + 1);
  politics.queries['politics/tension'](s, data);
  const before = s.world.pairs['china|japan'].pressure;
  assert.equal(before, pr0);
});

test('level 2 freezes partnership money between partners', () => {
  const s = setup(11, 'esa');
  s.turn = 30;
  s.treaties.push({ id: 't_test', type: 'mission_partnership', parties: ['esa', 'cnsa'], status: 'active', terms: {} });
  politics.setTension(s, 'esa', 'cnsa', 0, 'teste', data);
  s.signalsPending.length = 0;
  const b0 = s.actors.esa.budget;
  politics.setTension(s, 'esa', 'cnsa', 2, 'teste', data);
  assert.ok(s.actors.esa.budget < b0, 'ESA loses partnership money');
  assert.ok(s.decisions.some((d) => d.kind === 'politics/partnership_freeze'));
});

test('player decisions: election demand, hearing after failure, and every handler resolves', () => {
  const s = setup(2026, 'nasa');
  // run until the midterm demand window
  let demand = null;
  while (s.turn < 60 && !demand) {
    step(s, { resolve: false });
    demand = s.decisions.find((d) => d.kind === 'politics/election_demand');
    for (const d of s.decisions.slice()) if (d !== demand) { s.decisions.splice(s.decisions.indexOf(d), 1); politics.decisionHandlers['politics/*'](s, data, d, d.choices[0].id, ctxFor(s)); }
  }
  if (demand) {
    s.decisions.splice(s.decisions.indexOf(demand), 1);
    const b0 = s.actors.nasa.budget;
    politics.decisionHandlers['politics/*'](s, data, demand, 'accept', ctxFor(s));
    assert.ok(s.actors.nasa.budget > b0);
    assert.ok(s.world.demand && s.world.demand.actorId === 'nasa');
    emitSignal(s, 'mission/resolved', { actorId: 'nasa', outcome: 'total', crewed: true, destination: 'lunar_orbit' });
    step(s, { resolve: false });
    assert.equal(s.world.demand?.fulfilled, true, 'a crewed lunar success fulfils any goal type');
  }
  // hearing after a catastrophic failure
  s.world.cooldowns.hearing = -1;
  emitSignal(s, 'mission/resolved', { actorId: 'nasa', outcome: 'catastrophic', crewed: true, destination: 'lunar_orbit' });
  s.decisions = s.decisions.filter((d) => d.kind === 'politics/hearing');
  step(s, { resolve: false });
  const h = s.decisions.find((d) => d.kind === 'politics/hearing');
  assert.ok(h, 'hearing decision pushed');
  assert.ok(/Congresso/.test(h.title));
  // every decision kind and choice resolves without throwing
  const kinds = Object.keys(data.politics.decisions);
  for (const k of kinds) {
    for (const v of Object.values(data.politics.decisions[k])) {
      for (const c of v.choices) {
        const t = structuredClone(s);
        const res = politics.decisionHandlers['politics/*'](t, data, { id: 'dec_x', kind: `politics/${k}`, payload: { pct: -0.05, chance: 0.5, lost: 100, type: 'any_success', year: 2027 } }, c.id, ctxFor(t));
        assert.ok(res && typeof res === 'object', `${k}/${c.id}`);
        assert.ok(t.actors.nasa.budget > 0);
      }
    }
  }
});

test('company player: market model, funding rounds and investor demands', () => {
  const s = run(555, 160, 'spacex');
  assert.ok(s.world.markets.spacex.rounds >= 2, 'funding rounds happened');
  assert.ok(s.world.economy.spacex.kind === 'market');
  assert.ok(s.politics.spacex.nextElectionTurn > s.turn - 60);
});

test('queries return readable views', () => {
  const s = run(31337, 104);
  const t = politics.queries['politics/tension'](s, data);
  assert.equal(t.length, 15);
  assert.ok(t[0].level >= t[t.length - 1].level);
  assert.ok(t.every((x) => x.label.includes('–') && typeof x.levelLabel === 'string'));
  const w = politics.queries['politics/world'](s, data);
  assert.equal(w.nations.length, 6);
  assert.ok(typeof w.globalLabel === 'string');
  const a = politics.queries['politics/actor'](s, data, 'cnsa');
  assert.equal(a.nation, 'china');
  assert.ok(a.tensions.length === 5);
  assert.equal(politics.queries['politics/actor'](s, data, 'nope'), null);
  // headlines are pt-BR sentences without unfilled placeholders
  for (const n of s.news) {
    assert.ok(!/[{}]/.test(n.headline), `unfilled template: ${n.headline}`);
    assert.ok(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9]/.test(n.headline), `capitalized: ${n.headline}`);
  }
});

test('robust to missing actors / empty state slices', () => {
  const state = createState(data, { seed: 5, playerId: 'nasa' });
  politics.init(state, data, ctxFor(state));
  for (let i = 0; i < 60; i++) step(state);
  assert.equal(politics.tensionBetween(state, 'nasa', 'cnsa') >= 0, true);
  assert.equal(politics.tensionBetween({}, 'a', 'b'), 0);
  assert.equal(politics.setTension({ tension: {}, world: {}, signalsPending: [] }, 'x', 'y', 2), 2);
});

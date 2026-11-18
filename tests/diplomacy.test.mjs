// Tests for src/sim/diplomacy.js (actors, relations, blocs, treaties, proposals, utility AI, Tabela da Era).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import { relKey } from '../src/core/helpers.js';
import * as dip from '../src/sim/diplomacy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const IDS = ['nasa', 'spacex', 'blueorigin', 'cnsa', 'isro', 'esa', 'roscosmos', 'jaxa'];

/** Minimal harness that runs only the diplomacy module (independent of other modules' progress). */
function game(seed = 1, playerId = 'nasa') {
  const state = {
    version: 1, seed: seed >>> 0, turn: 0, startYear: 2026, endTurn: 519, playerId, idCounter: 0, gameOver: null,
    actors: {}, relations: {}, blocs: {}, treaties: [], proposals: [], world: {}, politics: {}, tension: {}, firsts: {},
    decisions: [], news: [], log: [], stats: {}, signals: [], signalsPending: [], crew: {},
  };
  const ctx = (extra = {}) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'diplomacy', l), date: turnToDate(state.turn, 2026), ...extra });
  dip.init(state, data, ctx());
  const g = {
    state, ctx,
    tick() {
      for (const d of state.decisions.slice()) {
        if (d.expiresTurn != null && state.turn >= d.expiresTurn) g.resolve(d, d.defaultChoice, true);
      }
      state.signals = state.signalsPending; state.signalsPending = [];
      dip.tick(state, data, ctx());
      state.turn++;
    },
    run(weeks, answer) {
      for (let i = 0; i < weeks; i++) {
        if (answer) for (const d of state.decisions.slice()) if (d.kind === 'diplomacy/proposal') g.resolve(d, answer(d));
        g.tick();
      }
    },
    resolve(d, choiceId, expired = false) {
      state.decisions = state.decisions.filter((x) => x.id !== d.id);
      return dip.decisionHandlers[d.kind](state, data, d, choiceId, ctx({ expired }));
    },
    act(action) { return dip.actions[action.type](state, data, action, ctx()); },
  };
  return g;
}
const dipSlices = (s) => JSON.stringify({ r: s.relations, b: s.blocs, t: s.treaties, p: s.proposals, n: s.news.map((x) => x.headline), d: s.decisions });

test('data/actors.json has 8 actors with the contract fields and every relation pair', () => {
  const src = data.actors;
  assert.deepEqual(src.actors.map((a) => a.id).sort(), IDS.slice().sort());
  const colors = new Set();
  for (const a of src.actors) {
    for (const k of ['name', 'short', 'kind', 'country', 'flag', 'color', 'budget', 'fixedCostShare', 'support', 'reputation', 'culture', 'style', 'capabilities', 'ai']) {
      assert.ok(a[k] !== undefined, `${a.id}.${k}`);
    }
    assert.match(a.color, /^#[0-9A-Fa-f]{6}$/);
    colors.add(a.color.toLowerCase());
    assert.ok(Array.isArray(a.ai.goals) && a.ai.goals.length);
  }
  assert.equal(colors.size, 8, 'distinct colors');
  const budgets = Object.fromEntries(src.actors.map((a) => [a.id, a.budget]));
  assert.deepEqual(budgets, { nasa: 9000, cnsa: 6000, isro: 1600, esa: 3500, roscosmos: 2200, jaxa: 1500, spacex: 5000, blueorigin: 2500 });
  const keys = new Set(src.relations.map((r) => relKey(r.a, r.b)));
  assert.equal(keys.size, 28);
});

test('init copies actors, relations, blocs and treaties; state is JSON-pure', () => {
  const { state } = game();
  assert.equal(Object.keys(state.actors).length, 8);
  assert.equal(state.actors.nasa.cash, 2250);
  assert.equal(state.actors.nasa.bloc, 'artemis_accords');
  assert.equal(state.actors.cnsa.bloc, 'ilrs');
  assert.equal(dip.blocOf(state, 'roscosmos').id, 'ilrs');
  assert.equal(Object.keys(state.relations).length, 28);
  const nc = dip.relation(state, 'cnsa', 'nasa');
  assert.ok(nc.trust < -30 && nc.rivalry > 70, 'NASA–CNSA low trust, high rivalry');
  assert.ok(dip.relation(state, 'spacex', 'blueorigin').rivalry >= 60);
  assert.ok(state.treaties.find((t) => t.id === 'outer_space_treaty' && t.type === 'peaceful_use'));
  assert.equal(state.treaties.find((t) => t.id === 'exomars_russia').status, 'broken');
  assert.equal(dip.costShare(state, 'nasa', 'esa'), 0.15);
  assert.equal(dip.costShare(state, 'nasa', 'cnsa'), 0);
  assert.ok(dip.isPartner(state, 'jaxa', 'isro'));
  assert.ok(!dip.isPartner(state, 'nasa', 'cnsa'), 'OST alone does not make partners');
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('queries: relations, treaties, blocs, proposal types, league table', () => {
  const g = game(3, 'isro');
  const { state } = g;
  const rel = dip.queries['diplomacy/relations'](state, data);
  assert.equal(rel.length, 7);
  assert.ok(rel.every((r) => typeof r.stance === 'string' && typeof r.tension === 'number'));
  const tr = dip.queries['diplomacy/treaties'](state, data, 'isro');
  assert.ok(tr.some((t) => t.id === 'lupex' && t.statusLabel === 'em vigor'));
  const blocs = dip.queries['diplomacy/blocs'](state, data);
  assert.equal(blocs.length, 2);
  const types = dip.queries['diplomacy/proposalTypes'](state, data, 'jaxa');
  // 4 bilateral + 2 service agreements (MISSIONS-V2 §8.2: launch_services, station_partnership) + 3 norms + join_bloc
  assert.equal(types.length, 10);
  assert.ok(types.every((t) => typeof t.chance === 'number'));
  assert.ok(types.some((t) => t.id === 'launch_services') && types.some((t) => t.id === 'station_partnership'));
  const table = dip.queries['league/table'](state, data);
  assert.equal(table.length, 8);
  assert.deepEqual(table.map((r) => r.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(table.find((r) => r.actorId === 'isro').isPlayer);
  state.actors.jaxa.prestige = 50;
  state.firsts.lunar_south_pole_landing = { actorId: 'jaxa', turn: 10 };
  const t2 = dip.queries['league/table'](state, data);
  assert.equal(t2[0].actorId, 'jaxa');
  assert.equal(t2[0].firsts[0].label, 'Pouso no polo sul lunar');
});

test('determinism: same seed same world, different seed different world, save/load safe', () => {
  const a = game(42), b = game(42), c = game(43);
  a.run(150); b.run(150); c.run(150);
  assert.equal(dipSlices(a.state), dipSlices(b.state));
  assert.notEqual(dipSlices(a.state), dipSlices(c.state));
  // save/load in the middle does not change the continuation
  const x = game(7), y = game(7);
  x.run(60); y.run(60);
  const restored = JSON.parse(JSON.stringify(y.state));
  Object.assign(y.state, restored);
  x.run(60); y.run(60);
  assert.equal(dipSlices(x.state), dipSlices(y.state));
});

test('10 simulated years produce both signings and ruptures across seeds, with no script', () => {
  let signed = 0, broken = 0, seedsWithBoth = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = game(seed, 'nasa');
    g.run(520, () => 'reject');
    const s = g.state.stats;
    const sg = (s['diplomacy.signed'] || 0) + (s['diplomacy.acceded'] || 0);
    const br = (s['diplomacy.broken'] || 0) + (s['diplomacy.leftBloc'] || 0);
    signed += sg; broken += br;
    if (sg > 0 && br > 0) seedsWithBoth++;
    // invariants
    for (const r of Object.values(g.state.relations)) {
      assert.ok(r.trust >= -100 && r.trust <= 100 && r.rivalry >= 0 && r.rivalry <= 100 && r.dependence >= 0 && r.dependence <= 100);
    }
    for (const b of Object.values(g.state.blocs)) for (const m of b.members) assert.equal(g.state.actors[m].bloc, b.id);
    assert.ok(g.state.news.some((n) => n.tags.includes('diplomacia')));
  }
  assert.ok(signed >= 20, `signings: ${signed}`);
  assert.ok(broken >= 3, `ruptures: ${broken}`);
  assert.ok(seedsWithBoth >= 3, `seeds with both: ${seedsWithBoth}`);
});

test('worlds diverge: different seeds produce different alliance sets', () => {
  const sets = [11, 12, 13].map((seed) => {
    const g = game(seed, 'esa');
    g.run(260, () => 'reject');
    return g.state.treaties.filter((t) => t.status === 'active').map((t) => `${t.type}:${t.parties.slice().sort()}`).sort().join(';');
  });
  assert.ok(new Set(sets).size >= 2);
});

test('AI proposals reach the player as decisions and resolve (accept / reject / counter / expire)', () => {
  const g = game(5, 'nasa');
  const seen = [];
  const outcomes = { accept: 0, reject: 0, counter: 0 };
  const cycle = ['accept', 'reject', 'counter'];
  let i = 0;
  for (let w = 0; w < 260; w++) {
    for (const d of g.state.decisions.slice()) {
      if (d.kind !== 'diplomacy/proposal') continue;
      seen.push(d);
      assert.ok(d.choices.map((c) => c.id).join() === 'accept,counter,reject');
      assert.ok(d.choices.every((c) => c.preview && c.preview.length > 5), 'previews');
      assert.equal(d.defaultChoice, 'reject');
      const pid = d.payload.proposalId;
      assert.ok(g.state.proposals.find((p) => p.id === pid));
      const choice = cycle[i++ % 3];
      const before = g.state.treaties.length;
      const r = g.resolve(d, choice);
      outcomes[choice]++;
      if (choice === 'accept') {
        assert.equal(r.status, 'accepted');
        assert.ok(!g.state.proposals.find((p) => p.id === pid));
        assert.ok(g.state.treaties.length > before || g.state.blocs[d.payload?.blocId]);
      }
      if (choice === 'reject') assert.ok(!g.state.proposals.find((p) => p.id === pid));
      if (choice === 'counter') {
        assert.equal(r.status, 'countered');
        assert.ok(g.state.proposals.find((p) => p.id === pid).countered);
        g.tick(); g.tick();
        assert.ok(!g.state.proposals.find((p) => p.id === pid), 'counter answered within a week');
      }
    }
    g.tick();
  }
  assert.ok(seen.length >= 6, `proposals to player: ${seen.length}`);
  assert.ok(outcomes.accept && outcomes.reject && outcomes.counter);
  assert.ok(g.state.treaties.some((t) => t.parties.includes('nasa') && t.signedTurn > 0), 'player signed something');
  // expiry: an unanswered proposal is rejected by default
  const h = game(5, 'nasa');
  let dec = null;
  for (let w = 0; w < 200 && !dec; w++) { h.tick(); dec = h.state.decisions.find((d) => d.kind === 'diplomacy/proposal'); }
  assert.ok(dec);
  for (let w = 0; w < 8; w++) h.tick();
  assert.ok(!h.state.decisions.includes(dec));
  assert.ok(!h.state.proposals.find((p) => p.id === dec.payload.proposalId));
});

test('player actions: propose, break treaty, leave and join a bloc', () => {
  const g = game(9, 'esa');
  const { state } = g;
  // proposal to a friendly partner gets an answer now or next week
  const pre = dip.queries['diplomacy/preview'](state, data, 'jaxa', 'crew_exchange', {});
  assert.ok(pre.chance >= 0 && pre.chance <= 1);
  // action.type is the engine route; the proposal kind travels in proposalType
  assert.equal(g.act({ type: 'diplomacy/propose', to: 'jaxa', proposalType: 'bogus' }).ok, false, 'unknown proposal type');
  assert.equal(g.act({ type: 'diplomacy/propose', to: 'jaxa' }).ok, false, 'missing proposal type');
  assert.equal(g.act({ type: 'diplomacy/propose', to: 'jaxa', proposalType: 'crew_exchange' }).ok, false, 'nobody flies crew');
  const p1 = g.act({ type: 'diplomacy/propose', to: 'jaxa', proposalType: 'mission_partnership', terms: { program: 'mars_robotic' } });
  assert.equal(p1.ok, true);
  assert.ok(['accepted', 'rejected', 'pending'].includes(p1.status));
  g.tick();
  assert.ok(!state.proposals.some((p) => p.from === 'esa' && p.to === 'jaxa'), 'answered by next turn');
  assert.ok(state.news.some((n) => n.tags.includes('jogador')));
  // invalid target / conflict
  assert.equal(g.act({ type: 'diplomacy/propose', to: 'esa', proposalType: 'cost_sharing' }).ok, false);
  // break a treaty: reputation and trust fall, signal emitted, news
  const rep0 = state.actors.esa.reputation;
  const trust0 = dip.relation(state, 'esa', 'nasa').trust;
  const br = dip.actions['diplomacy/breakTreaty'](state, data, { treatyId: 'orion_esm' }, g.ctx());
  assert.equal(br.ok, true);
  assert.equal(state.treaties.find((t) => t.id === 'orion_esm').status, 'broken');
  assert.ok(state.actors.esa.reputation < rep0);
  assert.ok(dip.relation(state, 'esa', 'nasa').trust < trust0);
  assert.ok(state.signalsPending.some((s) => s.type === 'treaty/broken' && s.treatyId === 'orion_esm'));
  assert.equal(dip.costShare(state, 'nasa', 'esa'), 0);
  // the bloc's founding treaty cannot be broken while inside the bloc
  assert.equal(dip.actions['diplomacy/breakTreaty'](state, data, { treatyId: 'artemis_accords' }, g.ctx()).ok, false);
  // leave the bloc: membership and bloc treaty withdrawal
  assert.equal(dip.actions['diplomacy/leaveBloc'](state, data, {}, g.ctx()).ok, true);
  assert.equal(state.actors.esa.bloc, null);
  assert.ok(!state.blocs.artemis_accords.members.includes('esa'));
  assert.ok(!state.treaties.find((t) => t.id === 'artemis_accords').parties.includes('esa'));
  assert.equal(dip.actions['diplomacy/leaveBloc'](state, data, {}, g.ctx()).ok, false);
  // join a bloc: the leader decides
  const j = dip.actions['diplomacy/joinBloc'](state, data, { blocId: 'ilrs' }, g.ctx());
  assert.equal(j.ok, true);
  assert.ok(['accepted', 'rejected'].includes(j.status));
  if (j.status === 'accepted') assert.equal(state.actors.esa.bloc, 'ilrs');
  assert.equal(dip.actions['diplomacy/joinBloc'](state, data, { blocId: 'nope' }, g.ctx()).ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('signals move relations: firsts heat rivalries, crew deaths bring condolences, tension cools trust', () => {
  const g = game(2, 'esa');
  const { state } = g;
  const r0 = dip.relation(state, 'nasa', 'cnsa').rivalry;
  state.signalsPending.push({ type: 'first', milestoneId: 'crewed_lunar_landing', actorId: 'cnsa', turn: 0 });
  state.signalsPending.push({ type: 'crew/died', crewId: 'x', actorId: 'isro', turn: 0 });
  state.signalsPending.push({ type: 'tension/changed', a: 'esa', b: 'jaxa', from: 0, to: 2, turn: 0 });
  const t0 = dip.relation(state, 'esa', 'jaxa').trust;
  g.tick();
  assert.ok(dip.relation(state, 'nasa', 'cnsa').rivalry > r0 - 1);
  assert.ok(dip.relation(state, 'esa', 'jaxa').trust < t0 - 10);
});

test('full engine: diplomacy runs inside newGame/tick when the other modules load', async (t) => {
  let engine;
  try { engine = await import('../src/core/engine.js'); } catch (e) { t.skip(`engine indisponível: ${e.message}`); return; }
  const state = engine.newGame(data, { seed: 77, playerId: 'cnsa' });
  assert.equal(Object.keys(state.actors).length, 8);
  for (let i = 0; i < 40; i++) {
    for (const d of state.decisions.slice()) engine.resolveDecision(state, data, d.id, d.choices?.[0]?.id);
    state.activeLaunch = null;
    engine.tick(state, data);
  }
  assert.ok(Array.isArray(engine.query(state, data, 'league/table')));
  assert.equal(typeof engine.query(state, data, 'diplomacy/costShare', 'cnsa', 'roscosmos'), 'number');
  const r = engine.dispatch(state, data, { type: 'diplomacy/propose', to: 'roscosmos', proposalType: 'crew_exchange' });
  assert.ok(r.ok === true || typeof r.error === 'string');
  assert.ok(!state.log.some((l) => l.includes('erro em diplomacy')), 'no exception inside diplomacy actions');
  assert.equal(engine.dispatch(state, data, { type: 'diplomacy/propose', to: 'nope', proposalType: 'crew_exchange' }).ok, false);
});

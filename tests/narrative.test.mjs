// Tests for src/sim/narrative.js and data/events.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState, resolveDecision } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { relKey } from '../src/core/helpers.js';
import * as N from '../src/sim/narrative.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const EVENTS = data.events.events;

const ctxFor = (state) => ({ data, rng: (label = '') => rngFor(state.seed, state.turn, 'narrative', label), date: {} });

/** Self-contained state (does not depend on other modules being implemented). */
function makeState({ seed = 42, playerId = 'esa', turn = 60 } = {}) {
  const s = createState(data, { seed, playerId });
  s.turn = turn;
  const mk = (id, extra = {}) => ({ id, name: id.toUpperCase(), short: id.toUpperCase(), kind: 'agency', budget: 3000, cash: 800,
    support: 60, reputation: 55, culture: 0, prestige: 10, bloc: null, ...extra });
  for (const id of ['nasa', 'spacex', 'cnsa', 'isro', 'esa', 'roscosmos']) s.actors[id] = mk(id);
  s.blocs = { artemis_accords: { id: 'artemis_accords', name: 'Acordos Artemis', members: ['nasa', 'esa', 'isro', 'spacex'] },
    ilrs: { id: 'ilrs', name: 'ILRS', members: ['cnsa', 'roscosmos'] } };
  const person = (id, role, name) => ({ id, name, role, actorId: playerId, skill: 60, experience: 20, traits: [], loyalty: 60,
    ambition: 50, morale: 60, status: 'active', history: [] });
  s.crew = { p1: person('p1', 'engineer', 'Ana Souza'), p2: person('p2', 'astronaut', 'Lena Vogel'), p3: person('p3', 'flight_director', 'Klaus Brenner'),
    p4: person('p4', 'astronaut', 'Marco Rossi') };
  s.missions = [{ id: 'm1', name: 'Argonauta-1', type: 'lander', destination: 'lunar_surface', status: 'scheduled',
    crew: { flightDirector: 'p3', commander: null, astronauts: [] } }];
  N.init(s, data, ctxFor(s));
  return s;
}

const ev = (id) => EVENTS.find((e) => e.id === id);

// ------------------------------------------------------------------ data

test('events.json: at least 45 events, all valid against the DSL', () => {
  assert.ok(EVENTS.length >= 45, `only ${EVENTS.length} events`);
  const errors = N.validateEvents(data);
  assert.deepEqual(errors, []);
  assert.ok(EVENTS.filter((e) => e.kind === 'operation').length >= 5, 'need operation events');
  const ids = EVENTS.map((e) => e.id);
  for (const need of ['op_solar_storm', 'op_micrometeoroid', 'op_software_glitch', 'op_comm_blackout', 'op_sensor_drift',
    'south_pole_ice', 'dust_1', 'lander_anomaly', 'accords_ceremony', 'ilrs_invite', 'iss_1', 'commercial_station',
    'eng_sells_plans', 'whistleblower', 'union_strike', 'celebrity_seat', 'media_scandal', 'family_letters', 'rival_poaching', 'espionage_offer']) {
    assert.ok(ids.includes(need), `missing ${need}`);
  }
});

test('events.json: chains — Eco has 4 steps, legacy chain exists, >= 2 multi-step chains', () => {
  const chains = {};
  for (const e of EVENTS) if (e.chain) (chains[e.chain.id] ||= new Set()).add(e.chain.step);
  assert.deepEqual([...chains.eco].sort(), [1, 2, 3, 4]);
  assert.ok(chains.legacy.size >= 3);
  assert.ok(Object.values(chains).filter((s) => s.size >= 2).length >= 2);
});

test('validator rejects unknown keys and malformed effects/conditions', () => {
  const base = structuredClone(ev('union_strike'));
  const bad = (mut) => { const e = structuredClone(base); mut(e); return N.validateEvent(e, data, new Set(EVENTS.map((x) => x.id))); };
  assert.equal(bad(() => {}).length, 0);
  assert.ok(bad((e) => { e.foo = 1; }).length > 0, 'unknown event key');
  assert.ok(bad((e) => { e.trigger.when = 3; }).length > 0, 'unknown trigger key');
  assert.ok(bad((e) => { e.choices[0].effects.push({ cash: 5, note: 'x' }); }).length > 0, 'unknown effect key');
  assert.ok(bad((e) => { e.choices[0].effects.push({ teleport: true }); }).length > 0, 'unknown effect type');
  assert.ok(bad((e) => { e.choices[0].effects.push({ actor: 'player', field: 'happiness', delta: 1 }); }).length > 0, 'bad actor field');
  assert.ok(bad((e) => { e.choices[0].requires = { mood: '>3' }; }).length > 0, 'unknown condition key');
  assert.ok(bad((e) => { e.choices[0].requires = { culture: 'muito' }; }).length > 0, 'bad comparison');
  assert.ok(bad((e) => { e.choices[0].effects.push({ schedule: 'nao_existe', inWeeks: 2 }); }).length > 0, 'bad schedule target');
  assert.ok(bad((e) => { e.text = 'Olá {fulano}, ' + e.text; }).length > 0, 'unknown placeholder');
  assert.ok(bad((e) => { e.choices = [e.choices[0]]; }).length > 0, 'needs 2+ choices');
  assert.ok(bad((e) => { for (const c of e.choices) c.requires = { culture: '>0' }; }).length > 0, 'needs an unconditional choice');
});

// ------------------------------------------------------------------ conditions & templating

test('Condition DSL', () => {
  const s = makeState();
  const C = (c, ctx) => N.evalCondition(s, data, c, ctx);
  s.actors.esa.culture = 25;
  assert.equal(C({ culture: '>20' }), true);
  assert.equal(C({ culture: '<20' }), false);
  assert.equal(C({ cash: '>500' }), true);
  assert.equal(C({ support: '<40' }), false);
  assert.equal(C({ hasRole: 'engineer' }), true);
  s.crew.p1.status = 'left';
  assert.equal(C({ hasRole: 'engineer' }), false);
  assert.equal(C({ flag: 'x' }), false);
  s.events.flags.x = 'b';
  assert.equal(C({ flag: 'x' }), true);
  assert.equal(C({ flag: 'x', value: 'a' }), false);
  assert.equal(C({ tech: 'comp_digital_twin' }), false);
  s.research = { unlocked: ['comp_digital_twin'] };
  assert.equal(C({ tech: 'comp_digital_twin' }), true);
  assert.equal(C({ all: [{ culture: '>20' }, { cash: '>500' }] }), true);
  assert.equal(C({ any: [{ culture: '<0' }, { cash: '>5000' }] }), false);
  assert.equal(C({ not: { culture: '<0' } }), true);
  assert.equal(C({ bloc: 'artemis_accords' }), true);
  assert.equal(C({ bloc: 'ilrs' }), false);
  s.tension[relKey('esa', 'cnsa')] = 2;
  assert.equal(C({ tension: '>=2' }, { rival: 'cnsa' }), true);
  assert.equal(C({ tension: '>=2' }, { rival: 'nasa' }), false);
  assert.match(N.describeCondition(s, data, { cash: '>500' }), /US\$ 500 mi/);
});

test('text templating fills {actor} {person} {mission} {rival} {year}', () => {
  const s = makeState();
  const out = N.renderText(s, data, '{actor}/{person}/{mission}/{rival}/{year}', { person: 'p2', mission: 'm1', rival: 'cnsa' });
  assert.equal(out, 'ESA/Lena Vogel/Argonauta-1/CNSA/2027');
});

// ------------------------------------------------------------------ eligibility

test('eligibility: minTurn, actors, flags, conditions, once', () => {
  const s = makeState({ turn: 1 });
  const can = (id, mode = 'random') => !!N.eligibleContext(s, data, ev(id), { mode });
  assert.equal(can('eco_1'), false, 'minTurn 26');
  s.turn = 30;
  assert.equal(can('eco_1'), true);
  assert.equal(can('vyommitra'), false, 'ISRO only');
  assert.equal(can('ilrs_invite'), true, 'ESA invited to ILRS');
  assert.equal(can('investor_call'), false, 'companies only');
  assert.equal(can('eco_whisper'), false, 'requires eco_first_piece');
  s.events.flags.eco_first_piece = true;
  assert.equal(can('eco_whisper'), true);
  assert.equal(can('public_poll'), false, 'support < 45 required');
  s.actors.esa.support = 30;
  assert.equal(can('public_poll'), true);
  assert.equal(can('eco_2'), false, 'chain follow-ups only fire when scheduled');
  assert.equal(can('eco_2', 'scheduled'), true);
  assert.equal(can('op_solar_storm'), false, 'operation events never fire as narrative');
  assert.equal(can('rival_failure'), false, 'signal events never fire randomly');
  // once
  s.events.history.eco_1 = { count: 1, lastTurn: 0 };
  assert.equal(can('eco_1'), false);
  // context needs a person: no engineer → no whistleblower
  for (const p of Object.values(s.crew)) if (p.role === 'engineer') p.status = 'dead';
  assert.equal(can('eng_sells_plans'), false);
});

test('no repetition: cooldown blocks and history decays the weight', () => {
  const s = makeState({ turn: 60 });
  const e = ev('media_scandal');
  const w0 = N.eventWeight(s, e);
  s.events.history[e.id] = { count: 1, lastTurn: 60 };
  assert.equal(N.eligibleContext(s, data, e), null, 'cooldown');
  s.turn = 60 + e.cooldownWeeks;
  assert.ok(N.eligibleContext(s, data, e), 'cooldown over');
  const w1 = N.eventWeight(s, e);
  assert.ok(w1 < w0, `weight should decay (${w1} < ${w0})`);
  s.events.history[e.id] = { count: 3, lastTurn: 60 };
  assert.ok(N.eventWeight(s, e) < w1, 'more appearances, lower weight');
  s.turn = 60 + 400;
  assert.ok(N.eventWeight(s, e) > w1 * 0.9, 'memory fades with time');
});

test('sorte com memória leve: 3 player failures boost recovery events', () => {
  const s = makeState({ turn: 80 });
  const rec = ev('recovery_review');
  const base = N.eventWeight(s, rec);
  assert.equal(N.eligibleContext(s, data, rec), null, 'needs a fail streak');
  for (let i = 0; i < 3; i++) {
    s.signals = [{ type: 'mission/resolved', missionId: 'm1', actorId: 'esa', outcome: 'catastrophic', crewed: false, destination: 'leo', phase: 'ascent' }];
    N.tick(s, data, ctxFor(s));
    s.turn++;
  }
  assert.equal(s.events.failStreak, 3);
  assert.ok(N.eligibleContext(s, data, rec));
  assert.ok(N.eventWeight(s, rec) > base * 10);
  s.signals = [{ type: 'mission/resolved', missionId: 'm1', actorId: 'esa', outcome: 'total', crewed: false, destination: 'leo', phase: 'ascent' }];
  N.tick(s, data, ctxFor(s));
  assert.equal(s.events.failStreak, 0);
});

// ------------------------------------------------------------------ decisions, effects & chains

test('event decision: templated card, previews, disabled choice with reason, resolution', () => {
  const s = makeState({ turn: 30 });
  s.signals = [];
  const e = ev('eng_sells_plans');
  const context = N.eligibleContext(s, data, e);
  assert.equal(context.person, 'p1');
  assert.ok(context.rival && context.rival !== 'esa');
  // push through the scheduled path to get a decision
  s.events.scheduled.push({ eventId: e.id, turn: s.turn, context });
  N.tick(s, data, ctxFor(s));
  const d = s.decisions.find((x) => x.kind === 'event/eng_sells_plans');
  assert.ok(d, 'decision pushed');
  assert.match(d.body, /Ana Souza/);
  assert.ok(!d.body.includes('{'));
  const sting = d.choices.find((c) => c.id === 'sting');
  assert.equal(sting.disabled, true, 'culture 0 is not > 10');
  assert.match(sting.reason, /cultura/);
  assert.match(d.choices.find((c) => c.id === 'confront').preview, /lealdade \+15/);
  assert.notEqual(d.defaultChoice, 'sting');
  assert.deepEqual(d.portrait, { crewId: 'p1' });
  const loyalty = s.crew.p1.loyalty;
  const r = resolveDecision(s, data, d.id, 'confront');
  assert.equal(r.ok, true);
  assert.equal(s.crew.p1.loyalty, loyalty + 15);
  assert.equal(s.events.flags.leak_confronted, true);
  assert.equal(s.events.chains.leak, 1);
  const sch = s.events.scheduled.find((x) => x.eventId === 'leak_2');
  assert.ok(sch && sch.turn === s.turn + 6 && sch.context.rival === context.rival, 'next step scheduled with context');
  assert.equal(s.events.journal[0].eventId, 'eng_sells_plans');
});

test('chain: the 4-step Eco chain branches by flags and reaches the album', () => {
  const s = makeState({ turn: 30 });
  const ctx = () => ctxFor(s);
  const step = (id, choice) => {
    for (let i = 0; i < 30; i++) {
      const d = s.decisions.find((x) => x.kind === `event/${id}`);
      if (d) {
        // drop unrelated cards so the queue stays small
        for (const o of s.decisions.slice()) if (o !== d && o.kind.startsWith('event/') && !o.kind.startsWith('event/eco')) resolveDecision(s, data, o.id, o.defaultChoice);
        const r = resolveDecision(s, data, d.id, choice);
        assert.equal(r.ok, true, `${id}/${choice}`);
        return d;
      }
      s.signals = [];
      N.tick(s, data, ctx());
      s.turn++;
    }
    assert.fail(`chain step ${id} never fired`);
  };
  s.events.scheduled.push({ eventId: 'eco_1', turn: s.turn, context: {} });
  step('eco_1', 'observe');
  assert.equal(s.events.flags.echo_signal, true, 'unlocks secret tech flag');
  step('eco_2', 'secret');
  assert.equal(s.events.flags.eco_secret, true);
  const leak = step('eco_3_leak', 'joint');
  assert.ok(leak.payload.context.rival);
  const d4 = step('eco_4', 'joint');
  assert.equal(d4.choices.find((c) => c.id === 'joint').disabled, undefined, 'joint enabled by eco_joint flag');
  assert.equal(d4.choices.find((c) => c.id === 'secret').disabled, undefined, 'secret enabled by eco_secret flag');
  assert.equal(s.events.chains.eco, 4);
  assert.equal(s.events.flags.eco_first_piece, true);
  const card = s.album.find((c) => c.title === 'O primeiro Eco');
  assert.ok(card && card.rarity === 'legendary');
  // later lore event now possible
  assert.ok(N.eligibleContext(s, data, ev('eco_whisper')));
});

test('applyEffects: every effect type changes state', () => {
  const s = makeState();
  const context = { person: 'p2', rival: 'cnsa', mission: 'm1', eventId: 'test', note: 'Teste' };
  const before = structuredClone(s);
  N.applyEffects(s, data, [
    { actor: 'player', field: 'support', delta: 5 },
    { actor: 'rival', field: 'reputation', delta: -5 },
    { actor: 'player', field: 'budget', delta: 100 },
    { relation: 'rival', field: 'trust', delta: 12 },
    { relation: 'nasa', field: 'rivalry', delta: 7 },
    { flag: 'f1' }, { flag: 'f2', value: 3 },
    { schedule: 'leak_2', inWeeks: 4 },
    { science: 10 },
    { cash: -50 }, { cash: 20 },
    { crew: 'subject', field: 'morale', delta: 10 },
    { crew: 'random', field: 'skill', delta: 5 },
    { missionRisk: 0.03 },
    { news: '{actor} testa {rival}', importance: 3 },
    { album: 'Carta de {person}', rarity: 'epic' },
    { tension: 'rival', delta: 1 },
    { unlockTech: 'comp_digital_twin' },
  ], context);
  assert.equal(s.actors.esa.support, before.actors.esa.support + 5);
  assert.equal(s.actors.cnsa.reputation, before.actors.cnsa.reputation - 5);
  // money effects scale with the agency's size (data is written for a ~US$ 4 bi agency)
  assert.equal(s.actors.esa.budget, before.actors.esa.budget + Math.round((100 * N.moneyScale(before, 'esa')) / 5) * 5);
  // relations go through diplomacy.bumpRelation (default relation: trust 0, rivalry 10)
  assert.equal(s.relations[relKey('esa', 'cnsa')].trust, (before.relations?.[relKey('esa', 'cnsa')]?.trust ?? 0) + 12);
  assert.equal(s.relations[relKey('esa', 'nasa')].rivalry, (before.relations?.[relKey('esa', 'nasa')]?.rivalry ?? 10) + 7);
  assert.equal(s.events.flags.f1, true);
  assert.equal(s.events.flags.f2, 3);
  assert.deepEqual(s.events.scheduled.at(-1), { eventId: 'leak_2', turn: s.turn + 4, context: { person: 'p2', rival: 'cnsa', mission: 'm1' } });
  assert.notEqual(s.actors.esa.cash, before.actors.esa.cash, 'cash changed (budget module or fallback)');
  assert.equal(s.crew.p2.morale, 70);
  assert.ok(Object.values(s.crew).some((p) => p.id !== 'p2' && p.skill === 65), 'random crew changed');
  assert.equal(N.missionRiskDelta(s, 'm1'), 0.03);
  assert.equal(s.news[0].headline, 'ESA testa CNSA');
  assert.equal(s.news[0].importance, 3);
  assert.equal(s.album.at(-1).title, 'Carta de Lena Vogel');
  assert.equal(s.album.at(-1).rarity, 'epic');
  assert.equal(s.tension[relKey('esa', 'cnsa')], 1);
  assert.ok(s.signalsPending.some((x) => x.type === 'tension/changed'));
  assert.equal(s.events.flags['tech:comp_digital_twin'], true);
  // crewStatus
  N.applyEffects(s, data, [{ crewStatus: 'left' }], { person: 'p4', note: 'X' });
  assert.equal(s.crew.p4.status, 'left');
  assert.ok(s.crew.p4.history.length > 0);
  // clamping
  N.applyEffects(s, data, [{ actor: 'player', field: 'support', delta: 500 }, { relation: 'rival', field: 'trust', delta: -500 }, { tension: 'rival', delta: 9 }], context);
  assert.equal(s.actors.esa.support, 100);
  assert.equal(s.relations[relKey('esa', 'cnsa')].trust, -100);
  assert.equal(s.tension[relKey('esa', 'cnsa')], 4);
  // JSON-serializable
  assert.deepEqual(JSON.parse(JSON.stringify(s.events)), s.events);
});

test('every authored choice applies without throwing and changes state', () => {
  for (const e of EVENTS) {
    for (const c of e.choices) {
      const s = makeState({ turn: 100 });
      const context = { person: 'p2', rival: (e.rival || ['cnsa'])[0], mission: 'm1', eventId: e.id, choiceId: c.id, note: e.title };
      const snap = JSON.stringify({ a: s.actors, r: s.relations, t: s.tension, c: s.crew, e: s.events, al: s.album, st: s.stats });
      N.applyEffects(s, data, c.effects, context);
      const after = JSON.stringify({ a: s.actors, r: s.relations, t: s.tension, c: s.crew, e: s.events, al: s.album, st: s.stats });
      assert.notEqual(after, snap, `${e.id}/${c.id} changed nothing`);
      assert.equal(s.log.filter((l) => l.includes('erro')).length, 0);
    }
  }
});

// ------------------------------------------------------------------ operation events

test('pickOperationEvent: transit events for the mission, max 2 per mission, mission risk applied', () => {
  const s = makeState({ turn: 50 });
  const m = { id: 'm2', name: 'Selene', type: 'crewed', destination: 'lunar_south_pole', status: 'transit',
    crew: { flightDirector: 'p3', commander: 'p2', astronauts: ['p4'] } };
  s.missions.push(m);
  const picked = [];
  for (let t = 0; t < 200 && picked.length < 5; t++) {
    s.turn = 50 + t;
    const r = N.pickOperationEvent(s, data, m, rngFor(s.seed, 'test-op', s.turn));
    if (r) {
      picked.push(r);
      const d = s.decisions.find((x) => x.id === r.decisionId);
      assert.ok(d.kind.startsWith('event/op_'));
      assert.equal(d.payload.context.mission, 'm2');
      assert.match(d.body, /Selene|\w/);
      assert.equal(N.pickOperationEvent(s, data, m, rngFor(s.seed, 'again', s.turn)), null, 'one pending per mission');
      resolveDecision(s, data, d.id, d.defaultChoice);
    }
  }
  assert.equal(picked.length, 2, 'cap of 2 per mission');
  assert.notEqual(picked[0].eventId, picked[1].eventId);
  assert.equal(N.pickOperationEvent(s, data, null), null);
  // crew illness only for crewed missions
  const robo = { id: 'm3', name: 'Robô', type: 'probe', destination: 'leo', status: 'transit', crew: { astronauts: [] } };
  s.missions.push(robo);
  for (let t = 0; t < 300; t++) {
    s.turn = 300 + t;
    const r = N.pickOperationEvent(s, data, robo, rngFor(s.seed, 'robo', t));
    if (r) {
      assert.notEqual(r.eventId, 'op_crew_illness');
      assert.notEqual(r.eventId, 'op_sensor_drift', 'lunar-only event on LEO mission');
      const d = s.decisions.find((x) => x.id === r.decisionId);
      resolveDecision(s, data, d.id, d.defaultChoice);
    }
  }
});

// ------------------------------------------------------------------ album & signals

test('album: firsts, deaths, legends, first success and near-misses become cards', () => {
  const s = makeState();
  s.signals = [
    { type: 'first', milestoneId: 'crewed_lunar_landing', actorId: 'esa' },
    { type: 'first', milestoneId: 'lunar_base', actorId: 'cnsa' },
    { type: 'crew/died', crewId: 'p4', missionId: 'm1' },
    { type: 'crew/legend', crewId: 'p2' },
    { type: 'mission/resolved', missionId: 'm1', actorId: 'esa', outcome: 'total', crewed: false, destination: 'lunar_surface', phase: 'arrival' },
  ];
  N.tick(s, data, ctxFor(s));
  const kinds = s.album.map((c) => c.kind);
  assert.ok(s.album.find((c) => c.kind === 'first' && c.rarity === 'legendary' && /Pouso tripulado na Lua/.test(c.title)));
  assert.equal(s.album.filter((c) => c.kind === 'first').length, 1, 'rival firsts are not player cards');
  assert.ok(kinds.includes('memorial'));
  assert.ok(kinds.includes('legend'));
  assert.ok(s.album.find((c) => c.title === 'A Lua ao alcance'), 'most notable first wins');
  // the crew death triggers the family letter event (signal-driven, keeps the person)
  const letter = s.decisions.find((d) => d.kind === 'event/legacy_letter');
  assert.ok(letter && letter.payload.context.person === 'p4');
  // same signals again: no duplicate cards
  const n = s.album.length;
  s.turn++;
  N.tick(s, data, ctxFor(s));
  assert.equal(s.album.length, n);
  // near miss
  s.turn++;
  s.signals = [{ type: 'mission/resolved', missionId: 'm1', actorId: 'esa', outcome: 'recoverable', crewed: true, destination: 'lunar_orbit', phase: 'ascent' }];
  N.tick(s, data, ctxFor(s));
  assert.ok(s.album.find((c) => c.kind === 'near_miss'));
  const q = N.queries['narrative/album'](s, data);
  assert.equal(q[0].rarityLabel !== undefined, true);
  N.onGameEnd(s, data, ctxFor(s));
  assert.ok(s.album.find((c) => c.kind === 'era' && /lugar/.test(c.title) && !c.title.includes('{')));
});

test('signal events use the signal context (rival failure, failure inquiry)', () => {
  const s = makeState({ turn: 70 });
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    s.turn++;
    s.signals = [{ type: 'mission/resolved', calendarId: 'c1', actorId: 'cnsa', outcome: 'catastrophic', destination: 'lunar_surface', phase: 'arrival' }];
    N.tick(s, data, ctxFor(s));
    const d = s.decisions.find((x) => x.kind === 'event/rival_failure');
    if (d) { found = true; assert.equal(d.payload.context.rival, 'cnsa'); assert.match(d.body, /CNSA/); }
  }
  assert.ok(found, 'rival failure card');
});

// ------------------------------------------------------------------ whole-campaign behaviour

function campaign(seed, playerId = 'esa') {
  const s = makeState({ seed, playerId, turn: 0 });
  const shown = [];
  for (let t = 0; t <= 259; t++) {
    s.turn = t;
    s.signals = [];
    N.tick(s, data, ctxFor(s));
    for (const d of s.decisions.slice()) {
      if (!d.kind.startsWith('event/')) continue;
      shown.push({ id: d.payload.eventId, turn: t });
      const c = d.choices.find((x) => !x.disabled);
      const r = resolveDecision(s, data, d.id, c.id);
      assert.equal(r.ok, true);
    }
  }
  return { s, shown };
}

test('campaign: steady pacing, no back-to-back repeats, deterministic, seeds diverge', () => {
  const a = campaign(7);
  const b = campaign(7);
  assert.deepEqual(a.shown, b.shown, 'same seed, same story');
  assert.ok(a.shown.length >= 30 && a.shown.length <= 110, `events shown: ${a.shown.length}`);
  const last = {};
  for (const { id, turn } of a.shown) {
    const e = ev(id);
    if (last[id] != null) assert.ok(turn - last[id] >= Math.min(e.cooldownWeeks, 8), `${id} repeated too soon`);
    last[id] = turn;
  }
  const distinct = new Set(a.shown.map((x) => x.id)).size;
  assert.ok(distinct >= 20, `variety: ${distinct}`);
  const c = campaign(1234);
  assert.notDeepEqual(c.shown.map((x) => x.id), a.shown.map((x) => x.id), 'different seeds tell different stories');
  assert.deepEqual(JSON.parse(JSON.stringify(a.s)), a.s, 'state stays JSON-pure');
  assert.equal(a.s.log.filter((l) => l.includes('erro')).length, 0);
});

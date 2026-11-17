// Narrative variety: per-campaign caps, shared group windows, text variants, new events and the living-world signals.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState, resolveDecision } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import * as N from '../src/sim/narrative.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const EVENTS = data.events.events;
const ev = (id) => EVENTS.find((e) => e.id === id);
const ctxFor = (state) => ({ data, rng: (label = '') => rngFor(state.seed, state.turn, 'narrative', label), date: {} });

function makeState({ seed = 42, playerId = 'esa', turn = 80 } = {}) {
  const s = createState(data, { seed, playerId });
  s.turn = turn;
  const mk = (id, extra = {}) => ({ id, name: id.toUpperCase(), short: id.toUpperCase(), kind: 'agency', budget: 3000, cash: 800,
    support: 60, reputation: 55, culture: 0, prestige: 10, bloc: null, ...extra });
  for (const id of ['nasa', 'spacex', 'cnsa', 'isro', 'esa', 'roscosmos']) s.actors[id] = mk(id);
  s.blocs = { artemis_accords: { id: 'artemis_accords', name: 'Acordos Artemis', short: 'Artemis', members: ['nasa', 'esa', 'isro', 'spacex'], leader: 'nasa' },
    ilrs: { id: 'ilrs', name: 'ILRS', short: 'ILRS', members: ['cnsa', 'roscosmos'], leader: 'cnsa' } };
  for (const b of Object.values(s.blocs)) for (const m of b.members) s.actors[m].bloc = b.id;
  const person = (id, role, name) => ({ id, name, role, actorId: playerId, skill: 60, experience: 20, traits: [], loyalty: 60,
    ambition: 50, morale: 60, status: 'active', history: [] });
  s.crew = { p1: person('p1', 'engineer', 'Ana Souza'), p2: person('p2', 'astronaut', 'Lena Vogel'), p3: person('p3', 'flight_director', 'Klaus Brenner') };
  s.missions = [];
  N.init(s, data, ctxFor(s));
  return s;
}
const signalRun = (s, sig) => {
  s.signals = [{ turn: s.turn, ...sig }];
  N.tick(s, data, ctxFor(s));
  s.signals = [];
};

test('events.json: +20 new events (100 total), all valid, new chains reachable, groups declared', () => {
  assert.ok(EVENTS.length >= 98, `${EVENTS.length} eventos`);
  assert.deepEqual(N.validateEvents(data), []);
  for (const id of ['bloc_newcomer', 'bloc_rival_grows', 'bloc_side_pressure', 'bloc_member_leaves', 'bloc_member_joins', 'map_redrawn',
    'thaw_window', 'rare_earth_1', 'rare_earth_2', 'ai_copilot', 'ai_copilot_2', 'lunar_law_1', 'lunar_law_2', 'dsn_crunch', 'heat_wave_pad',
    'deepfake_launch', 'student_cubesat', 'sovereign_seat', 'constellation_glare', 'veteran_candidate', 'rival_first_offer', 'rival_failure_help']) {
    assert.ok(ev(id), `falta ${id}`);
  }
  for (const e of EVENTS) if (e.group) assert.ok(data.events.groups[e.group] > 0, `grupo ${e.group} sem janela`);
  for (const e of EVENTS) for (const v of e.variants || []) assert.ok(!/undefined/.test(v.text || ''));
});

test('validation rejects bad variants, groups and caps', () => {
  const base = structuredClone(ev('burnout'));
  assert.ok(N.validateEvent({ ...base, variants: [{ text: 'curto' }] }, data).length);
  assert.ok(N.validateEvent({ ...base, variants: [{ body: 'x'.repeat(200) }] }, data).length);
  assert.ok(N.validateEvent({ ...base, group: 'Com Espaço' }, data).length);
  assert.ok(N.validateEvent({ ...base, maxCount: 0 }, data).length);
  assert.deepEqual(N.validateEvent({ ...base, maxCount: 2, group: 'crew_morale' }, data), []);
});

test('per-campaign cap: a repeatable random event stops after DEFAULT_MAX_COUNT showings', () => {
  const s = makeState();
  const e = ev('burnout');
  assert.ok(N.eligibleContext(s, data, e, { mode: 'random' }));
  s.events.history.burnout = { count: N.DEFAULT_MAX_COUNT.random, lastTurn: 0 };
  s.turn = 400;
  assert.equal(N.eligibleContext(s, data, e, { mode: 'random' }), null);
});

test('per-occurrence signal cards (family letter, inquiry) are not capped by the signal default', () => {
  for (const id of ['legacy_letter', 'failure_inquiry']) {
    const e = ev(id);
    assert.ok((e.maxCount ?? 0) > N.DEFAULT_MAX_COUNT.signal, `${id} maxCount`);
  }
  const s = makeState();
  const e = ev('legacy_letter');
  s.events.history.legacy_letter = { count: N.DEFAULT_MAX_COUNT.signal, lastTurn: s.turn - 30 };
  const ctx = N.eligibleContext(s, data, e, { mode: 'signal', base: { person: 'Lena Vogel', actor: s.playerId } });
  assert.ok(ctx, 'a 4th death still gets its letter');
});

test('group window: after one card of a group, its siblings wait', () => {
  const s = makeState();
  const e = ev('burnout');
  assert.equal(e.group, ev('family_letters').group);
  s.events.history.family_letters = { count: 1, lastTurn: s.turn - 2 };
  assert.equal(N.eligibleContext(s, data, e, { mode: 'random' }), null);
  s.turn += data.events.groups[e.group];
  assert.ok(N.eligibleContext(s, data, e, { mode: 'random' }));
  assert.equal(N.groupLastTurn(s, data, e.group), 78);
});

test('variants: the second showing of a repeated card reads differently', () => {
  const s = makeState();
  const e = ev('burnout');
  assert.ok(e.variants?.length);
  const titles = [];
  for (let i = 0; i < 2; i++) {
    s.turn += 60;
    s.decisions = [];
    signalRun(s, {}); // housekeeping only
    const ctx = N.eligibleContext(s, data, e, { mode: 'scheduled' });
    // push through the public path used by chains
    s.events.scheduled.push({ eventId: 'burnout', turn: s.turn, context: ctx });
    N.tick(s, data, ctxFor(s));
    const d = s.decisions.find((x) => x.kind === 'event/burnout');
    assert.ok(d, 'carta não apareceu');
    titles.push(d.title);
    resolveDecision(s, data, d.id, d.choices[0].id);
  }
  assert.notEqual(titles[0], titles[1]);
  assert.equal(titles[1], e.variants[0].title);
});

test('living world: a country joining your bloc becomes a card that names it', () => {
  let shown = null;
  for (let seed = 1; seed < 40 && !shown; seed++) {
    const s = makeState({ seed });
    signalRun(s, { type: 'geo/blocSignup', iso: 'IDN', countryName: 'Indonésia', bloc: 'artemis', blocId: 'artemis_accords', joined: true, actorId: 'nasa', withPlayer: true });
    shown = s.decisions.find((d) => d.kind === 'event/bloc_newcomer');
  }
  assert.ok(shown, 'bloc_newcomer nunca disparou');
  assert.match(shown.body, /Indonésia/);
  assert.match(shown.body, /Artemis/);
  assert.ok(!/\{|undefined/.test(shown.body + shown.title));
});

test('living world: a rival leaving its bloc and a map change produce reaction cards', () => {
  let leave = null;
  let map = null;
  for (let seed = 1; seed < 40 && !(leave && map); seed++) {
    const s = makeState({ seed });
    if (!leave) {
      signalRun(s, { type: 'diplomacy/blocChanged', actorId: 'isro', blocId: 'artemis_accords', joined: false });
      leave = s.decisions.find((d) => d.kind === 'event/bloc_member_leaves');
    }
    const s2 = makeState({ seed });
    if (!map) {
      signalRun(s2, { type: 'geo/zoneChanged', zoneId: 'donetsk_w', zoneName: 'Donetsk (oeste)', from: 'UKR', to: 'RUS', actorId: 'roscosmos' });
      map = s2.decisions.find((d) => d.kind === 'event/map_redrawn');
    }
  }
  assert.ok(leave && /ISRO/.test(leave.body) && /Artemis/.test(leave.body), leave?.body);
  assert.ok(map && /Donetsk/.test(map.body), map?.body);
});

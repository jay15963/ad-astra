import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState, newGame, tick as engineTick } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as research from '../src/sim/research.js';
import * as crew from '../src/sim/crew.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const ctxFor = (s, mod = 'crew') => ({ data, rng: (l = '') => rngFor(s.seed, s.turn, mod, l), date: turnToDate(s.turn, s.startYear) });

/** Isolated state with research + crew only, mock actors. */
function mini(playerId = 'nasa', seed = 11) {
  const s = createState(data, { seed, playerId });
  s.actors = {
    [playerId]: { id: playerId, short: playerId.toUpperCase(), budget: 5000, cash: 5000, support: 50 },
    spacex: { id: 'spacex', short: 'SpaceX', budget: 5000, cash: 1e5 },
    cnsa: { id: 'cnsa', short: 'CNSA', budget: 6000, cash: 1e5 },
  };
  research.init(s, data, ctxFor(s, 'research'));
  crew.init(s, data, ctxFor(s));
  return s;
}
function step(s, n = 1) {
  for (let i = 0; i < n; i++) {
    s.signals = s.signalsPending; s.signalsPending = [];
    crew.tick(s, data, ctxFor(s));
    s.turn++;
  }
}
const act = (s, type, extra) => crew.actions[type](s, data, { type, ...extra }, ctxFor(s));
const roleOf = (s, role) => Object.values(s.crew).filter((p) => p.role === role && p.status === 'active');

test('crew.json: name pools, traits, rosters per playable actor', () => {
  const C = data.crew;
  for (const c of ['american', 'chinese', 'indian', 'european', 'russian', 'japanese']) {
    assert.ok(C.firstNames[c].length >= 20 && C.lastNames[c].length >= 20, c);
    assert.ok(C.femaleNames[c].every((n) => C.firstNames[c].includes(n)), c);
  }
  assert.ok(C.traits.length >= 20);
  const traitIds = new Set(C.traits.map((t) => t.id));
  for (const a of data.scenario.playableActors) {
    const r = C.roster[a];
    assert.ok(r && r.length >= 6 && r.length <= 10, a);
    assert.equal(r.filter((p) => p.role === 'flight_director').length, 2, `${a} has 2 FDs`);
    assert.ok(r.some((p) => p.role === 'astronaut') && r.some((p) => p.role === 'engineer'));
    for (const p of r) {
      assert.ok(p.id && p.name && p.bio, p.id);
      for (const t of p.traits) assert.ok(traitIds.has(t), `${p.id}:${t}`);
    }
  }
});

test('init: roster loaded as full Persons with portraits; fallback roster for non-roster actors', () => {
  const s = mini('isro');
  const people = Object.values(s.crew);
  assert.ok(people.length >= 6);
  for (const p of people) {
    assert.equal(p.actorId, 'isro');
    assert.equal(p.status, 'active');
    for (const k of ['skin', 'hair', 'hairColor', 'eyes', 'brows', 'mouth', 'accessory', 'suit', 'bg']) assert.equal(typeof p.portrait[k], 'number');
    assert.ok(p.salaryM > 0 && p.history.length === 1);
  }
  const j = mini('jaxa');
  const jp = Object.values(j.crew);
  assert.equal(jp.length, 8);
  assert.ok(jp.every((p) => p.name && p.culture === 'japanese'));
  assert.deepEqual(mini('jaxa').crew, j.crew, 'deterministic');
});

test('crewModifier and commandPointsFor respond to crew quality', () => {
  const s = mini('nasa');
  const sel = { flightDirector: 'nasa_calloway', commander: 'nasa_hart', astronauts: ['nasa_hart', 'nasa_reyes'] };
  const good = crew.crewModifier(s, data, sel);
  const none = crew.crewModifier(s, data, { flightDirector: null, commander: null, astronauts: [] });
  assert.ok(good.delta > none.delta && good.band > none.band);
  assert.ok(good.factors.length >= 3 && good.factors.every((f) => typeof f.label === 'string'));
  const cpGood = crew.commandPointsFor(s, data, sel);
  const cpWeak = crew.commandPointsFor(s, data, { flightDirector: 'nasa_boyd' });
  assert.ok(cpGood >= 3 && cpGood <= 5 && cpGood > cpWeak, `${cpGood} ${cpWeak}`);
  assert.equal(crew.commandPointsFor(s, data, {}), 1 + research.techBonus(s, 'nasa', 'commandPoints'));
  // unavailable people hurt
  s.crew.nasa_calloway.status = 'injured';
  assert.ok(crew.crewModifier(s, data, sel).delta < good.delta);
  assert.doesNotThrow(() => crew.crewModifier(s, data, undefined));
});

test('applyMissionToCrew: success grants xp, history, legends on lunar landing', () => {
  const s = mini('nasa');
  const m = { id: 'm1', name: 'Artemis IV', destination: 'lunar_surface', type: 'crewed',
    crew: { flightDirector: 'nasa_calloway', commander: 'nasa_hart', astronauts: ['nasa_reyes'] } };
  const xp0 = s.crew.nasa_hart.experience;
  const res = crew.applyMissionToCrew(s, data, m, { level: 'total' });
  assert.ok(s.crew.nasa_hart.experience > xp0);
  assert.equal(s.crew.nasa_hart.missions, 3);
  assert.ok(res.legends.includes('nasa_hart') && res.legends.includes('nasa_reyes'));
  assert.ok(s.crew.nasa_hart.legend);
  assert.ok(s.signalsPending.some((x) => x.type === 'crew/legend'));
  assert.ok(s.crew.nasa_reyes.history.some((h) => h.text.includes('Artemis IV')));
  // second phase of the same mission does not double-count the flight
  crew.applyMissionToCrew(s, data, m, 'partial');
  assert.equal(s.crew.nasa_hart.missions, 3);
});

test('catastrophic crewed failure kills (or not, per crewLost), fills Memorial and emits crew/died', () => {
  const s = mini('nasa');
  const m = { id: 'm2', name: 'Voo Fatal', destination: 'leo', type: 'crewed',
    crew: { flightDirector: 'nasa_boyd', commander: 'nasa_pell', astronauts: ['nasa_brooks'] } };
  const res = crew.applyMissionToCrew(s, data, m, { level: 'catastrophic', failureType: 'propulsion', crewLost: ['nasa_pell', 'nasa_brooks'] });
  assert.deepEqual(res.died.sort(), ['nasa_brooks', 'nasa_pell']);
  assert.equal(s.crew.nasa_pell.status, 'dead');
  assert.equal(s.memorial.length, 2);
  assert.equal(s.memorial[0].cause, 'Falha de propulsão');
  assert.equal(s.signalsPending.filter((x) => x.type === 'crew/died').length, 2);
  assert.ok(s.news.some((n) => n.headline.startsWith('Luto')));
  assert.ok(s.crew.nasa_boyd.morale < 65, 'FD grieves');
  assert.equal(crew.queries['crew/memorial'](s, data).length, 2);
  assert.ok(!crew.availableCrew(s, 'astronaut').some((p) => p.id === 'nasa_pell'));
});

test('crewSafety tech lowers death rate on rolled catastrophes', () => {
  const deaths = (safety) => {
    let d = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = mini('nasa', seed);
      if (safety) for (const id of ['ls_abort', 'str_radiation', 'ls_suits', 'ls_medicine', 'sec_phoenix_protocol']) research.unlockNode(s, data, id);
      const m = { id: 'mx', name: 'Teste', destination: 'leo', crew: { commander: 'nasa_hart', astronauts: ['nasa_reyes', 'nasa_pell'] } };
      d += crew.applyMissionToCrew(s, data, m, { level: 'catastrophic', failureType: 'structure' }).died.length;
    }
    return d;
  };
  const a = deaths(false), b = deaths(true);
  assert.ok(b < a, `${b} < ${a}`);
  assert.ok(a > 0);
});

test('hiring market: deterministic weekly refresh, hire/fire/train with costs', () => {
  const s = mini('esa');
  const c1 = crew.queries['crew/candidates'](s, data);
  assert.ok(c1.length >= 6);
  assert.deepEqual(c1.map((c) => c.id), crew.queries['crew/candidates'](s, data).map((c) => c.id));
  step(s, 2);
  const c2 = crew.queries['crew/candidates'](s, data);
  assert.notDeepEqual(c1.map((c) => c.id), c2.map((c) => c.id));
  const cand = c2[0];
  const cash0 = s.actors.esa.cash;
  const r = act(s, 'crew/hire', { candidateId: cand.id });
  assert.ok(r.ok, r.error);
  assert.ok(s.actors.esa.cash < cash0);
  assert.equal(s.crew[cand.id].actorId, 'esa');
  assert.ok(!crew.queries['crew/candidates'](s, data).some((c) => c.id === cand.id), 'hired leaves the market');
  assert.equal(act(s, 'crew/hire', { candidateId: cand.id }).ok, false);
  // train
  const t = act(s, 'crew/train', { crewId: 'esa_ortega' });
  assert.ok(t.ok);
  assert.ok(!crew.availableCrew(s, 'astronaut').some((p) => p.id === 'esa_ortega'));
  const sk = s.crew.esa_ortega.skill;
  step(s, 6);
  assert.ok(s.crew.esa_ortega.skill > sk && s.crew.esa_ortega.trainingUntil === null);
  // fire (blocked while assigned)
  s.missions = [{ id: 'mm', status: 'scheduled', crew: { flightDirector: 'esa_almeida', commander: null, astronauts: [] } }];
  assert.equal(act(s, 'crew/fire', { crewId: 'esa_almeida' }).ok, false);
  assert.ok(act(s, 'crew/fire', { crewId: 'esa_marchand' }).ok);
  assert.equal(s.crew.esa_marchand.status, 'left');
});

test('weekly salaries are paid (category crew) and roster query is ordered', () => {
  const s = mini('cnsa');
  const cash0 = s.actors.cnsa.cash;
  step(s, 4);
  const payroll = crew.queries['crew/summary'](s, data).payrollWeekly;
  assert.ok(payroll > 0);
  assert.ok(Math.abs(cash0 - s.actors.cnsa.cash - payroll * 4) < 0.05);
  const roster = crew.queries['crew/roster'](s, data);
  assert.equal(roster[0].status, 'active');
  assert.ok(roster.every((p) => p.roleLabel && Array.isArray(p.traitDetails)));
  assert.equal(crew.queries['crew/person'](s, data, 'cnsa_han').name, 'Han Zhiyuan');
});

test('low loyalty + ambition leads to rival poaching decision; counter or release', () => {
  const s = mini('spacex');
  const p = s.crew.spacex_asante;
  p.loyalty = 20; p.ambition = 90;
  let w = 0;
  while (!s.decisions.some((d) => d.kind === 'crew/poach') && w++ < 400) { p.loyalty = 20; step(s); }
  const d = s.decisions.find((x) => x.kind === 'crew/poach');
  assert.ok(d, 'poach decision appeared');
  assert.equal(d.payload.crewId, 'spacex_asante');
  const sal = p.salaryM;
  crew.decisionHandlers['crew/poach'](s, data, d, 'counter', ctxFor(s));
  assert.ok(p.salaryM > sal && p.loyalty > 20 && p.status === 'active');
  crew.decisionHandlers['crew/poach'](s, data, d, 'release', ctxFor(s));
  assert.equal(p.status, 'left');
  assert.ok(p.leftTo);
  assert.ok(s.news.some((n) => n.headline.includes(p.name)));
});

test('retirement, injuries recover, legacy candidates appear after a death', () => {
  const s = mini('nasa');
  s.crew.nasa_calloway.age = 70;
  step(s, 140);
  assert.equal(s.crew.nasa_calloway.status, 'retired');
  // injury and recovery
  crew.setCrewStatus(s, data, 'nasa_reyes', 'injured', 'Torceu o tornozelo');
  assert.equal(s.crew.nasa_reyes.status, 'injured');
  step(s, 20);
  assert.equal(s.crew.nasa_reyes.status, 'active');
  // legacy: after a memorial entry, some market candidates carry the surname
  const m = { id: 'mz', name: 'Missão Z', crew: { commander: 'nasa_hart', astronauts: [] } };
  crew.applyMissionToCrew(s, data, m, { level: 'catastrophic', crewLost: ['nasa_hart'] });
  let found = null;
  for (let i = 0; i < 120 && !found; i++) { step(s); found = crew.queries['crew/candidates'](s, data).find((c) => c.legacyOf === 'nasa_hart'); }
  assert.ok(found, 'legacy candidate');
  assert.ok(found.name.endsWith('Hart') && found.bio.includes('Caleb Hart'));
});

test('narrative helpers and JSON round-trip', () => {
  const s = mini('nasa');
  crew.changeCrew(s, 'nasa_pell', 'morale', -500);
  assert.equal(s.crew.nasa_pell.morale, 0);
  assert.ok(crew.pickCrew(s, rngFor(1, 'x')));
  assert.equal(crew.setCrewStatus(s, data, 'nasa_pell', 'left'), true);
  assert.deepEqual(JSON.parse(JSON.stringify({ crew: s.crew, memorial: s.memorial })), { crew: s.crew, memorial: s.memorial });
});

test('integration: full engine, 60 weeks, crew stays consistent', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  for (let i = 0; i < 60; i++) {
    for (const d of s.decisions.slice()) if (d.kind === 'crew/poach') s.decisions.splice(s.decisions.indexOf(d), 1);
    engineTick(s, data);
  }
  for (const p of Object.values(s.crew)) {
    assert.ok(p.morale >= 0 && p.morale <= 100 && p.loyalty >= 0 && p.loyalty <= 100, p.id);
    assert.ok(['active', 'injured', 'retired', 'dead', 'left'].includes(p.status));
  }
});

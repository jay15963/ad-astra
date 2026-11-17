// Crew certification (human-rating): data, effective rating helper, player program + demo flight, calendar grants,
// AI operators, customers, save/load and the builder's "why / how" texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick, dispatch, query, serialize, deserialize } from '../src/core/engine.js';
import { relKey } from '../src/core/helpers.js';
import * as cal from '../src/sim/calendar.js';
import * as missions from '../src/sim/missions.js';
import { missionRisk } from '../src/sim/risk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const vehicles = data.vehicles.vehicles;

const game = (playerId, seed = 11) => {
  const s = newGame(data, { seed, playerId });
  s.actors[playerId].cash = 50000; // money is not what these tests are about
  return s;
};
/** Give a vehicle `n` extra successful flights (as if background launches flew them). */
const fly = (s, vid, n) => { s.vehicleStats[vid].flights += n; };
const crewedLunar = { type: 'crewed', destination: 'lunar_surface', spacecraftId: 'starship_hls' };

test('data: every launcher that is not crew-rated says whether and how it can be certified', () => {
  for (const v of vehicles) {
    if (v.crewRated) continue;
    assert.ok(v.crewCert, `${v.id}: crewCert missing`);
    if (v.crewCert.feasible === false) {
      assert.ok(typeof v.crewCert.reason === 'string' && v.crewCert.reason.length > 5, `${v.id}: reason (pt-BR)`);
      continue;
    }
    for (const k of ['flights', 'costM', 'weeks']) assert.ok(v.crewCert[k] > 0, `${v.id}: ${k}`);
    assert.ok(v.crewCert.minReliability > 0.5 && v.crewCert.minReliability < 1, `${v.id}: minReliability`);
    if (v.crewCert.calendarGrant) assert.ok(data.index.calendar[v.crewCert.calendarGrant], `${v.id}: calendarGrant exists`);
  }
  // the realistic ones: Starship follows the HLS uncrewed landing; small launchers never carry people
  const by = Object.fromEntries(vehicles.map((v) => [v.id, v]));
  assert.equal(by.starship.crewCert.calendarGrant, 'starship_hls_demo');
  for (const id of ['new_glenn', 'vulcan', 'falconheavy']) assert.notEqual(by[id].crewCert.feasible, false, id);
  for (const id of ['electron', 'pslv', 'vega_c']) assert.equal(by[id].crewCert.feasible, false, id);
  assert.ok(by.long_march_10.crewRated, 'Long March 10 is already crew-rated');
  assert.ok(data.vehicles.crewCertRules.customerCostMult > 1);
});

test('isCrewRated: data flag or a rating earned in play (state.crewCert.rated)', () => {
  const s = game('spacex');
  assert.equal(cal.isCrewRated(s, data, 'falcon9'), true);
  assert.equal(cal.isCrewRated(s, data, 'starship'), false);
  s.crewCert.rated.starship = { turn: 0, by: 'spacex', source: 'program' };
  assert.equal(cal.isCrewRated(s, data, 'starship'), true);
  assert.equal(cal.isCrewRated({}, data, 'starship'), false, 'no slice (old save) = data flag');
  // every reader goes through the helper: the builder, the validator and the risk model agree
  const opts = query(s, data, 'missions/draftOptions', crewedLunar);
  const st = opts.vehicles.find((v) => v.id === 'starship');
  assert.equal(st.crewRated, true);
  assert.ok(!st.reasons.includes('Sem certificação para tripulação.'));
  const r = missionRisk(s, data, { actorId: 'spacex', type: 'crewed', destination: 'lunar_surface', vehicleId: 'starship', spacecraftId: 'starship_hls', crew: {}, config: {} });
  assert.ok(!r.errors.some((e) => /certificad/.test(e)), r.errors.join(' | '));
  assert.equal(query(s, data, 'catalog/vehicle', 'starship')?.crewRated ?? true, true);
});

test('builder: a non-certified vehicle explains why and how (Starship for a SpaceX crewed lunar landing)', () => {
  const s = game('spacex');
  const opts = query(s, data, 'missions/draftOptions', crewedLunar);
  const st = opts.vehicles.find((v) => v.id === 'starship');
  assert.equal(st.valid, false);
  assert.ok(st.reasons.includes('Sem certificação para tripulação.'));
  const cs = st.crewCert;
  assert.ok(cs && cs.feasible && !cs.rated);
  assert.equal(cs.flightsNeeded, 20);
  assert.ok(cs.start.ok && cs.start.costM > 0 && cs.start.weeks > 0 && !cs.start.customer);
  assert.equal(cs.grant?.calendarId, 'starship_hls_demo');
  // capacity reason: how much is missing
  const f9 = opts.vehicles.find((v) => v.id === 'falcon9');
  assert.ok(f9.capacityShortT > 0 && f9.payloadT > f9.effectiveCapacityT);
  const e = opts.vehicles.find((v) => v.id === 'electron');
  assert.equal(e.crewCert.feasible, false);
});

test('player program: pay, engineering, flights, uncrewed demo on Launch Day → crew-rated for everyone', () => {
  const s = game('spacex');
  const cash0 = s.actors.spacex.cash;
  const r = dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' });
  assert.ok(r.ok, r.error);
  assert.ok(s.actors.spacex.cash <= cash0 - r.costM + 1, 'paid up front');
  const again = dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' });
  assert.equal(again.ok, false);
  const p = s.crewCert.programs.falconheavy;
  assert.equal(p.phase, 'work');
  // engineering done, but still short of flights: waits
  s.turn = p.readyTurn;
  tick(s, data);
  assert.equal(s.crewCert.programs.falconheavy.phase, 'flights');
  fly(s, 'falconheavy', 10);
  tick(s, data);
  assert.equal(s.crewCert.programs.falconheavy.phase, 'demo');
  tick(s, data); // missions creates the demo mission
  const demo = s.missions.find((m) => m.certVehicleId === 'falconheavy');
  assert.ok(demo, 'demo mission created');
  assert.equal(demo.crewed, false);
  assert.equal(demo.vehicleId, 'falconheavy');
  assert.equal(demo.source, 'cert');
  assert.equal(s.crewCert.programs.falconheavy.demoMissionId, demo.id);
  // the demo flies that vehicle without people: no swapping
  assert.equal(dispatch(s, data, { type: 'mission/update', missionId: demo.id, patch: { vehicleId: 'falcon9' } }).ok, false);
  assert.ok(dispatch(s, data, { type: 'mission/schedule', missionId: demo.id }).ok);
  const prestige0 = s.actors.spacex.prestige;
  demo.status = 'launch';
  missions.onLaunchResolved(s, data, demo.id, 'ascent', { level: 'total' });
  assert.ok(cal.isCrewRated(s, data, 'falconheavy'));
  assert.equal(s.crewCert.rated.falconheavy.by, 'spacex');
  assert.ok(!s.crewCert.programs.falconheavy);
  assert.ok(s.actors.spacex.prestige > prestige0);
  assert.ok(s.news.some((n) => /Falcon Heavy é certificado/.test(n.headline)));
  // other buyers see it too
  const nasaView = cal.certStatus(s, data, 'falconheavy', 'nasa');
  assert.equal(nasaView.rated, true);
});

test('demo failure asks for another demo; cancelling pauses and "Certificar" resumes for free', () => {
  const s = game('spacex');
  assert.ok(dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' }).ok);
  const p = s.crewCert.programs.falconheavy;
  s.turn = p.readyTurn; fly(s, 'falconheavy', 10);
  tick(s, data); tick(s, data);
  const demo = s.missions.find((m) => m.certVehicleId === 'falconheavy');
  demo.status = 'launch';
  missions.onLaunchResolved(s, data, demo.id, 'ascent', { level: 'catastrophic', failureType: 'propulsion' });
  assert.ok(!cal.isCrewRated(s, data, 'falconheavy'));
  assert.equal(s.crewCert.programs.falconheavy.demoAttempts, 1);
  assert.equal(s.crewCert.programs.falconheavy.demoMissionId, null);
  s.turn = s.crewCert.programs.falconheavy.demoTurn;
  tick(s, data);
  const demo2 = s.missions.find((m) => m.certVehicleId === 'falconheavy' && m.id !== demo.id);
  assert.ok(demo2, 'second demo');
  assert.ok(dispatch(s, data, { type: 'mission/cancel', missionId: demo2.id }).ok);
  assert.equal(s.crewCert.programs.falconheavy.paused, true);
  tick(s, data);
  assert.equal(s.missions.filter((m) => m.certVehicleId === 'falconheavy' && m.status === 'planning').length, 0, 'paused: no new demo');
  const cash = s.actors.spacex.cash;
  const res = dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' });
  assert.ok(res.ok && res.resumed, res.error);
  assert.equal(s.actors.spacex.cash, cash, 'resume is free');
  tick(s, data);
  assert.ok(s.missions.some((m) => m.certVehicleId === 'falconheavy' && m.status === 'planning'));
});

test('calendar milestone certifies on the real schedule: Starship after the HLS uncrewed landing', () => {
  const s = game('nasa');
  const inst = s.calendar.find((c) => c.id === 'starship_hls_demo');
  assert.ok(inst);
  inst.status = 'success';
  inst.resolvedTurn = s.turn;
  tick(s, data);
  assert.ok(cal.isCrewRated(s, data, 'starship'));
  assert.equal(s.crewCert.rated.starship.source, 'calendar');
  assert.equal(s.crewCert.rated.starship.by, 'spacex');
});

test('customers pay more and need the operator: NASA certifies Vulcan (ULA), low trust blocks New Glenn', () => {
  const s = game('nasa');
  const v = cal.canStartCert(s, data, 'vulcan', 'nasa');
  assert.ok(v.ok && v.customer, v.error);
  const base = vehicles.find((x) => x.id === 'vulcan').crewCert.costM;
  assert.equal(v.costM, Math.round(base * data.vehicles.crewCertRules.customerCostMult));
  s.relations[relKey('nasa', 'blueorigin')].trust = -60;
  const ng = cal.canStartCert(s, data, 'new_glenn', 'nasa');
  assert.equal(ng.ok, false);
  assert.match(ng.error, /confiança/);
  // embargoed or own-use vehicles: no contract at all
  assert.equal(cal.canStartCert(s, data, 'angara_a5', 'nasa').ok, false);
  assert.equal(cal.canStartCert(s, data, 'electron', 'nasa').ok, false);
  // one program per vehicle
  assert.ok(dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'vulcan' }).ok);
  assert.equal(cal.canStartCert(s, data, 'vulcan', 'spacex').ok, false);
});

test('AI operators pursue a rating when their goals need crews (Blue Origin and New Glenn), deterministically', () => {
  const run = () => {
    const s = game('nasa', 5);
    s.actors.blueorigin.cash = 20000;
    for (let i = 0; i < 80 && !s.crewCert.programs.new_glenn && !cal.isCrewRated(s, data, 'new_glenn'); i++) tick(s, data);
    return s;
  };
  const a = run();
  assert.ok(a.crewCert.programs.new_glenn || cal.isCrewRated(a, data, 'new_glenn'), 'Blue Origin started a program');
  assert.equal(a.crewCert.programs.new_glenn?.sponsor ?? 'blueorigin', 'blueorigin');
  const b = run();
  assert.deepEqual(a.crewCert, b.crewCert);
  // the AI flies its own demo: push it there and let it resolve
  const p = a.crewCert.programs.new_glenn;
  if (p) {
    a.turn = Math.max(a.turn, p.readyTurn);
    fly(a, 'new_glenn', 30);
    for (let i = 0; i < 40 && !cal.isCrewRated(a, data, 'new_glenn'); i++) { a.vehicleStats.new_glenn.groundedUntil = null; tick(a, data); }
    assert.ok(cal.isCrewRated(a, data, 'new_glenn'), 'AI demo flown');
  }
});

test('save/load keeps programs and ratings; an old save without the slice still plays', () => {
  const s = game('spacex');
  assert.ok(dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' }).ok);
  s.crewCert.rated.new_glenn = { turn: 3, by: 'blueorigin', source: 'program' };
  const back = deserialize(serialize(s));
  assert.deepEqual(back.crewCert, s.crewCert);
  assert.deepEqual(JSON.parse(JSON.stringify(s.crewCert)), s.crewCert);
  const old = deserialize(serialize(s));
  delete old.crewCert;
  assert.equal(cal.isCrewRated(old, data, 'starship'), false);
  assert.ok(query(old, data, 'missions/draftOptions', crewedLunar).vehicles.length > 0);
  tick(old, data);
  assert.deepEqual(old.crewCert.programs, {});
});

test('UI texts: certification summary and the capacity explanation (pt-BR)', async () => {
  const { certSummaryText, capacityHelpText } = await import('../src/ui/missions-tab.js');
  const s = game('spacex');
  const cs = cal.certStatus(s, data, 'starship', 'spacex');
  const txt = certSummaryText(cs);
  assert.match(txt, /^Certificar: 20 voos bem-sucedidos \(tem \d+\) \+ demo não tripulado, US\$ \d+ mi, ~\d+ meses\.$/);
  assert.match(certSummaryText(cal.certStatus(s, data, 'electron', 'spacex')), /^Indisponível: /);
  assert.match(certSummaryText(cal.certStatus(s, data, 'falcon9', 'spacex')), /Certificado/);
  dispatch(s, data, { type: 'vehicle/certify', vehicleId: 'falconheavy' });
  assert.match(certSummaryText(cal.certStatus(s, data, 'falconheavy', 'spacex')), /^Sua certificação em andamento: Engenharia e revisão \(\d+%\)\.$/);
  const help = capacityHelpText({ id: 'falcon9', name: 'Falcon 9', capacityShortT: 23.2, payloadT: 26.5, effectiveCapacityT: 3.3 }, { destName: 'Superfície lunar', margin: 0.1, farTarget: true });
  assert.match(help, /^Faltam 23,2 t: a carga \(nave \+ módulos\) pesa 26,5 t e o Falcon 9 leva só 3,3 t até Superfície lunar com margem de 10%./);
  assert.match(help, /reabastecimento em órbita/);
  assert.equal(capacityHelpText({ capacityShortT: 0 }), null);
});

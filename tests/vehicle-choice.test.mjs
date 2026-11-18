// Item 9 (docs/EXPANSION.md §7): accepting a mission never picks the rocket or the craft. The player decides; the
// engineers' pick only comes back as `suggestion`. Scheduling without hardware is refused with a pt-BR message.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query, resolveDecision } from '../src/core/engine.js';
import * as missions from '../src/sim/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const ctxFor = (state) => ({ data, rng: () => ({ chance: () => false, next: () => 0.5, int: (a) => a, range: (a) => a, pick: (l) => l[0], shuffle: (l) => l.slice(), weighted: (l) => l[0], normal: (m) => m }), date: { year: 2026, week: 1, month: 0 }, dt: 1, prevTurn: state.turn, turn: state.turn });

/** Advance until the player gets a calendar briefing (NASA: Artemis II in the first weeks). */
function firstProgramBriefing(state) {
  for (let i = 0; i < 40; i++) {
    const d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.kind === 'calendar');
    if (d) return d;
    state.decisions = state.decisions.filter((x) => !x.blocking);
    dispatch(state, data, { type: 'time/advance', weeks: 1, stopOnEvent: false });
  }
  return null;
}

test('program briefing: accept creates the mission without hardware, with the program plan as suggestion', () => {
  const state = newGame(data, { seed: 7, playerId: 'nasa' });
  const d = firstProgramBriefing(state);
  assert.ok(d, 'NASA receives a program briefing');
  const accept = d.choices.find((c) => c.id === 'accept');
  assert.equal(accept.label, 'Aceitar e escolher o veículo');
  assert.match(accept.preview, /Sugestão dos engenheiros/);
  assert.match(d.body, /Custo estimado: US\$/);
  const r = resolveDecision(state, data, d.id, 'accept');
  assert.equal(r.ok, true, r.error);
  const m = state.missions.find((x) => x.calendarId === d.payload.calendarId);
  assert.ok(m, 'mission created');
  assert.equal(r.openBuilder, m.id);
  assert.equal(r.step, 2);
  assert.equal(m.status, 'planning');
  assert.equal(m.vehicleId, null);
  assert.equal(m.spacecraftId, null);
  assert.ok(m.suggestion?.vehicleId && m.suggestion?.spacecraftId, 'suggestion carries the program hardware');
  assert.equal(m.suggestion.reason, 'Plano do programa');
  // type/destination of a program stay locked
  const bad = dispatch(state, data, { type: 'mission/update', missionId: m.id, patch: { destination: 'mars_orbit' } });
  assert.equal(bad.ok, false);
  // the list marks it
  const row = query(state, data, 'missions/list').find((x) => x.id === m.id);
  assert.equal(row.needsHardware, true);
  assert.ok(row.suggestionNames.vehicle);
});

test('scheduling without hardware is refused in pt-BR; picking the suggestion makes it schedulable', () => {
  const state = newGame(data, { seed: 7, playerId: 'nasa' });
  const d = firstProgramBriefing(state);
  resolveDecision(state, data, d.id, 'accept');
  const m = state.missions.find((x) => x.calendarId === d.payload.calendarId);
  const r = dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Escolha o foguete e a nave antes de agendar.');
  const up = dispatch(state, data, { type: 'mission/update', missionId: m.id, patch: { vehicleId: m.suggestion.vehicleId, spacecraftId: m.suggestion.spacecraftId } });
  assert.equal(up.ok, true, up.error);
  assert.equal(m.vehicleId, m.suggestion.vehicleId);
  assert.ok(m.cost > 0);
  const row = query(state, data, 'missions/list').find((x) => x.id === m.id);
  assert.equal(row.needsHardware, false);
  const s2 = dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  assert.notEqual(s2.error, 'Escolha o foguete e a nave antes de agendar.');
});

test('opportunity briefing: accept leaves the hardware to the player (cheapest pick as suggestion)', () => {
  const state = newGame(data, { seed: 3, playerId: 'isro' });
  const draft = { type: 'satellite', destination: 'sso', vehicleId: 'pslv', spacecraftId: 'generic_sat', crewed: false, source: 'custom', config: { strategy: 'balanced', fuelMargin: 0.1 } };
  const dec = { id: 'x', kind: 'briefing', payload: { kind: 'earth_obs', draft } };
  const r = missions.decisionHandlers.briefing(state, data, dec, 'accept');
  assert.equal(r.ok, true, r.error);
  const m = state.missions.find((x) => x.id === r.missionId);
  assert.equal(m.vehicleId, null);
  assert.equal(m.spacecraftId, null);
  assert.equal(m.suggestion.vehicleId, 'pslv');
  assert.equal(m.suggestion.reason, 'Mais barato que leva a carga');
  assert.equal(r.openBuilder, m.id);
});

test('awarded contract: mission without rocket, suggestion from the bid estimate', () => {
  const state = newGame(data, { seed: 11, playerId: 'spacex' });
  const c = {
    id: 'ctr_test', kind: 'gto_sat', title: 'Satélite de teste', client: 'Cliente', body: '', type: 'satellite', destination: 'gto',
    payloadT: 3, clientPayload: true, valueM: 200, createdTurn: state.turn, closeTurn: state.turn, deadlineTurn: state.turn + 40,
    status: 'bidding', rivals: [], playerBid: { level: 'bid_mid', price: 200 }, winner: null, winningPrice: null, missionId: null, advancePaidM: 0, late: false,
  };
  state.contracts.push(c);
  missions.tick(state, data, ctxFor(state));
  assert.equal(c.status, 'awarded');
  const m = state.missions.find((x) => x.id === c.missionId);
  assert.ok(m);
  assert.equal(m.vehicleId, null);
  assert.ok(m.suggestion?.vehicleId, 'suggested launcher');
  assert.equal(m.clientPayload, true);
  assert.equal(missions.needsHardware(m), true);
  const up = missions.actions['mission/update'](state, data, { missionId: m.id, patch: { vehicleId: m.suggestion.vehicleId } });
  assert.equal(up.ok, true, up.error);
  assert.equal(missions.needsHardware(m), false); // client payload: no craft of ours
});

test('crew-certification demo keeps its vehicle (the vehicle is the object of the flight)', () => {
  const state = newGame(data, { seed: 5, playerId: 'nasa' });
  const v = data.vehicles.vehicles.find((x) => !x.crewRated && x.operator === 'nasa') || data.vehicles.vehicles.find((x) => !x.crewRated);
  state.crewCert = state.crewCert || { rated: {}, programs: {} };
  state.crewCert.programs[v.id] = { vehicleId: v.id, sponsor: 'nasa', customer: null, phase: 'demo', demoTurn: state.turn, startedTurn: 0, paused: false };
  missions.tick(state, data, ctxFor(state));
  const m = state.missions.find((x) => x.certVehicleId === v.id);
  assert.ok(m, 'demo mission created');
  assert.equal(m.vehicleId, v.id);
  assert.equal(m.suggestion, undefined);
  const other = data.vehicles.vehicles.find((x) => x.id !== v.id);
  const r = missions.actions['mission/update'](state, data, { missionId: m.id, patch: { vehicleId: other.id } });
  assert.equal(r.ok, false);
});

test('missions/costRange gives min ≤ max over the valid hardware (briefing cards show a range)', () => {
  const state = newGame(data, { seed: 1, playerId: 'nasa' });
  const r = query(state, data, 'missions/costRange', { type: 'satellite', destination: 'gto' });
  assert.ok(r.options > 1, `options ${r.options}`);
  assert.ok(r.minM > 0 && r.minM <= r.maxM, `${r.minM}–${r.maxM}`);
  assert.equal(query(state, data, 'missions/costRange', { type: 'satellite', destination: 'nowhere' }).options, 0);
});

test('createMandateMission (Phase B hook) also leaves the hardware to the player', () => {
  const state = newGame(data, { seed: 2, playerId: 'nasa' });
  const r = missions.createMandateMission(state, data, { id: 'mdt_1', holderId: 'gov', title: 'Mandato: satélite', type: 'satellite', destination: 'sso', deadlineTurn: state.turn + 52 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.mission.vehicleId, null);
  assert.equal(r.mission.mandateId, 'mdt_1');
  assert.equal(r.mission.deadlineTurn, state.turn + 52);
});

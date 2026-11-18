// Phase B, B5 missions (docs/EXPANSION.md §5.2, §6, §7, §14): investor mandates on the player's side (badge,
// deadline, penalty, own-mission agenda), builder designs as launch vehicles, test flights with ballast, the
// engineers' suggestion (shown, never preselected) and the late-bound peers (investors.js / designs.js).
// The B2/B3 slices are faked here with their contract shapes (§5.1, §6), so the tests run before those modules land.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query, resolveDecision, serialize, deserialize } from '../src/core/engine.js';
import * as missions from '../src/sim/missions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const design = (over = {}) => ({
  id: 'dsg_1', name: 'Andorinha I', owner: 'nasa', baseVehicleId: null, origin: 'scratch',
  stages: [{ engineId: 'e1', engines: 1, tank: 'M', size: 'M' }],
  derived: { capacity: { leo: 12, gto: 4, tli: 2.5, mars: 1.5, outer: 0.4 }, costM: 45, reliabilityPrior: 0.9, devCostM: 300, devWeeks: 60, heightM: 50, diaM: 3.7 },
  program: { phase: 'testFlights', startedTurn: 0, readyTurn: 0, testFlights: 0, needFlights: 2 },
  stats: { flights: 0, failures: 0 },
  ...over,
});

const capTable = (playerPct, over = {}) => ({
  playerPct,
  holders: [
    { id: 'h_gov', kind: 'government', name: 'Governo', pct: 40, sinceTurn: 0, mood: 60, emblem: { shape: 'roundel', field: '#28628f', glyph: 'globe', glyphColor: '#fff', stars: 0, label: 'GOV' } },
    { id: 'h_fund', kind: 'fund', name: 'Fundo Órbita', pct: Math.max(0, 60 - playerPct), sinceTurn: 0, mood: 50 },
  ],
  lastRoundTurn: 0, valuationM: 1000, history: [],
  ...over,
});

function advance(state, weeks = 1, d = data) {
  for (let i = 0; i < weeks; i++) {
    state.decisions = state.decisions.filter((x) => !x.blocking);
    dispatch(state, d, { type: 'time/advance', weeks: 1, stopOnEvent: false });
  }
}
// designs.js is inert without data/core/parts.json: the "fallback" tests run on the data minus the parts catalog
const noParts = { ...data, parts: undefined };

test.afterEach(() => missions.bindPeers({ investors: null, designs: null }));

// ------------------------------------------------------------------------------------------- designs

test('a design in its test campaign gets a locked test flight with ballast (source test)', () => {
  const state = newGame(data, { seed: 11, playerId: 'nasa' });
  state.designs = { dsg_1: design() };
  advance(state);
  const m = state.missions.find((x) => x.testDesignId === 'dsg_1');
  assert.ok(m, 'test-flight mission created');
  assert.equal(m.source, 'test');
  assert.equal(m.vehicleId, 'dsg_1');
  assert.equal(m.clientPayload, true);
  assert.equal(m.crewed, false);
  assert.ok(m.config.payloadT > 0 && m.config.payloadT <= 12, 'ballast within the design capacity');
  assert.match(m.name, /Voo de teste 1: Andorinha I/);
  assert.ok(state.decisions.some((d) => /voo de teste 1 de 2/.test(d.title)), 'a card tells the player');
  // locked: no other rocket, no craft, no other target
  for (const patch of [{ vehicleId: 'falcon9' }, { destination: 'gto' }, { spacecraftId: 'generic_sat' }]) {
    const r = dispatch(state, data, { type: 'mission/update', missionId: m.id, patch });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.match(r.error, /voo de teste/i);
  }
  // only one test flight at a time
  advance(state, 2);
  assert.equal(state.missions.filter((x) => x.testDesignId === 'dsg_1').length, 1);
  // the risk/catalog resolve the design (published into data.index.vehicles)
  assert.equal(data.index.vehicles.dsg_1?.name, 'Andorinha I');
  assert.ok(Number.isFinite(m.estimate?.p) && m.estimate.p > 0.3, 'estimate from risk.js');
  const r = dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  assert.equal(r.ok, true, r.error);
});

test('test flights approve the design (fallback without designs.js); then it flies any mission', () => {
  const state = newGame(noParts, { seed: 12, playerId: 'nasa' });
  state.designs = { dsg_1: design() };
  advance(state, 1, noParts);
  // in the builder a design under test is listed, blocked, with the reason
  const draft = { type: 'satellite', destination: 'leo', crew: {}, config: {} };
  let opts = query(state, noParts, 'missions/draftOptions', draft);
  let row = opts.vehicles.find((v) => v.id === 'dsg_1');
  assert.ok(row, 'design listed');
  assert.equal(row.valid, false);
  assert.equal(row.design, true);
  assert.match(row.reasons[0], /Em voos de teste \(0 de 2\)/);
  for (let k = 0; k < 2; k++) {
    const m = state.missions.find((x) => x.testDesignId === 'dsg_1' && x.status === 'planning');
    assert.ok(m, `test flight ${k + 1}`);
    missions.onLaunchResolved(state, noParts, m.id, 'ascent', { level: 'total' });
    advance(state, 1, noParts);
  }
  const dz = state.designs.dsg_1;
  assert.equal(dz.program.phase, 'operational');
  assert.equal(dz.program.testFlights, 2);
  assert.equal(dz.stats.flights, 2);
  assert.ok(state.decisions.some((d) => /Andorinha I aprovado/.test(d.title)) || state.news.some((n) => /aprova o Andorinha I/.test(n.headline)));
  opts = query(state, noParts, 'missions/draftOptions', draft);
  row = opts.vehicles.find((v) => v.id === 'dsg_1');
  assert.equal(row.valid, true, row.reasons.join(' '));
  assert.equal(row.designPhase, 'operational');
  // a normal custom mission on the design
  const sat = opts.spacecraft.find((s) => s.valid);
  const c = dispatch(state, noParts, { type: 'mission/create', draft: { ...draft, vehicleId: 'dsg_1', spacecraftId: sat.id } });
  assert.equal(c.ok, true, c.error);
  const s = dispatch(state, noParts, { type: 'mission/schedule', missionId: c.missionId });
  assert.equal(s.ok, true, s.error);
  const listed = query(state, noParts, 'missions/list').find((x) => x.id === c.missionId);
  assert.equal(listed.isDesign, true);
  assert.equal(listed.vehicleName, 'Andorinha I');
});

test('a failed test flight does not count; designs.js takes over when bound', () => {
  const state = newGame(noParts, { seed: 13, playerId: 'nasa' });
  state.designs = { dsg_1: design({ program: { phase: 'testFlights', testFlights: 0, needFlights: 1 } }) };
  advance(state, 1, noParts);
  let m = state.missions.find((x) => x.testDesignId === 'dsg_1');
  missions.onLaunchResolved(state, noParts, m.id, 'ascent', { level: 'catastrophic', failureType: 'propulsion' });
  assert.equal(state.designs.dsg_1.program.phase, 'testFlights');
  assert.equal(state.designs.dsg_1.stats.failures, 1);
  advance(state, 1, noParts);
  m = state.missions.find((x) => x.testDesignId === 'dsg_1' && x.status === 'planning');
  assert.ok(m, 'another test flight after a loss');
  assert.match(m.name, /Voo de teste 2/);
  const calls = [];
  missions.bindPeers({ designs: { onTestFlight: (...a) => calls.push(a.slice(2)) } });
  missions.onLaunchResolved(state, noParts, m.id, 'ascent', { level: 'total' });
  assert.deepEqual(calls, [['dsg_1', true, m.id]]);
  assert.equal(state.designs.dsg_1.program.phase, 'testFlights', 'the peer owns the slice once bound');
  assert.equal(state.designs.dsg_1.stats.flights, 1);
});

test('designs never leak into another game; save/load keeps the design flight identical', () => {
  const a = newGame(data, { seed: 14, playerId: 'nasa' });
  a.designs = { dsg_1: design({ program: { phase: 'operational', testFlights: 2, needFlights: 2 } }) };
  advance(a);
  assert.ok(data.index.vehicles.dsg_1);
  const json = serialize(a);
  const back = deserialize(json, data);
  assert.equal(serialize(back), json);
  for (let i = 0; i < 6; i++) { advance(a); advance(back); }
  assert.equal(serialize(back), serialize(a), 'same play after load');
  const b = newGame(data, { seed: 14, playerId: 'nasa' });
  advance(b);
  assert.equal(data.index.vehicles.dsg_1, undefined, 'a game without designs drops them from the catalog');
  assert.ok(!query(b, data, 'missions/draftOptions', { type: 'satellite', destination: 'leo' }).vehicles.some((v) => v.id === 'dsg_1'));
});

test('AI never gets the player design; the real catalog wins over a design id clash', () => {
  const state = newGame(data, { seed: 15, playerId: 'nasa' });
  state.designs = { falcon9: design({ id: 'falcon9', name: 'Clone', program: { phase: 'operational' } }) };
  advance(state);
  assert.notEqual(data.index.vehicles.falcon9?.name, 'Clone');
  state.designs = {};
  advance(state);
  assert.ok(data.index.vehicles.falcon9, 'catalog entry untouched');
});

// ------------------------------------------------------------------------------------------- mandates

test('agenda: own slots follow the §5.2 table (K = 6) and block extra own missions', () => {
  const state = newGame(data, { seed: 21, playerId: 'nasa' });
  const want = { 100: [0, 6], 90: [2, 4], 75: [3, 3], 60: [3, 3], 50: [4, 2], 30: [5, 1], 10: [5, 1] };
  for (const [pct, [M, own]] of Object.entries(want)) {
    state.cap = capTable(Number(pct));
    const a = missions.agendaOf(state, data);
    assert.equal(a.M, M, `M at ${pct}%`);
    assert.equal(a.own, own, `own at ${pct}%`);
    assert.equal(a.binding, Number(pct) < 50);
  }
  state.cap = null;
  assert.equal(query(state, data, 'missions/agenda'), null, 'no cap table, no agenda');
  state.cap = capTable(30);
  const draft = { type: 'satellite', destination: 'leo', vehicleId: null, spacecraftId: null };
  const r1 = dispatch(state, data, { type: 'mission/create', draft });
  assert.equal(r1.ok, true, r1.error);
  const r2 = dispatch(state, data, { type: 'mission/create', draft });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Agenda tomada pelos investidores/);
  const a = query(state, data, 'missions/agenda');
  assert.equal(a.used, 1);
  assert.equal(a.left, 0);
});

test('an investor mandate becomes a mission without hardware, with holder, deadline and penalty', () => {
  const state = newGame(data, { seed: 22, playerId: 'nasa' });
  state.cap = capTable(30);
  state.mandates = [{ id: 'mdt_1', holderId: 'h_fund', title: 'Rede de satélites', type: 'satellite', destination: 'leo', count: 2,
    deadlineTurn: state.turn + 40, rewardM: 120, penalty: { mood: 25, cashM: 50 }, missionIds: [], status: 'open' }];
  let list = query(state, data, 'missions/mandates');
  assert.equal(list.length, 1);
  assert.equal(list[0].missionId, null);
  assert.equal(list[0].holder.name, 'Fundo Órbita');
  const r = dispatch(state, data, { type: 'mission/fromMandate', mandateId: 'mdt_1' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.openBuilder, r.missionId);
  const m = state.missions.find((x) => x.id === r.missionId);
  assert.equal(m.mandateId, 'mdt_1');
  assert.equal(m.holderId, 'h_fund');
  assert.equal(m.vehicleId, null, 'item 9: nothing preselected');
  assert.ok(m.suggestion?.vehicleId, 'engineers suggest');
  assert.equal(m.deadlineTurn, state.turn + 40);
  assert.match(m.name, /Rede de satélites 1\/2/);
  assert.deepEqual(state.mandates[0].missionIds, [m.id]);
  const again = dispatch(state, data, { type: 'mission/fromMandate', mandateId: 'mdt_1' });
  assert.equal(again.missionId, m.id, 'idempotent while open');
  list = query(state, data, 'missions/mandates');
  assert.equal(list[0].missionId, m.id);
  const row = query(state, data, 'missions/get', m.id);
  assert.equal(row.holder.name, 'Fundo Órbita');
  assert.ok(row.deadline);
  // mandated missions do not use the player's own slot
  assert.equal(query(state, data, 'missions/agenda').used, 0);
  // the deadline shows up in the checks under the mandate wording
  dispatch(state, data, { type: 'mission/update', missionId: m.id, patch: { vehicleId: m.suggestion.vehicleId, spacecraftId: m.suggestion.spacecraftId } });
  const g = query(state, data, 'missions/get', m.id);
  assert.ok(g.check.warnings.some((w) => /Prazo do mandato/.test(w)), g.check.warnings.join(' | '));
});

test('investors.js is told every final result and every cancelled mandate (late binding)', () => {
  const state = newGame(data, { seed: 23, playerId: 'nasa' });
  state.cap = capTable(40);
  const got = [];
  missions.bindPeers({ investors: { onMissionResolved: (s, d, m, info) => got.push(['resolved', m.id, info.mandateId, info.level]), onMissionCancelled: (s, d, m) => got.push(['cancelled', m.id]) } });
  const a = missions.createMandateMission(state, data, { id: 'mdt_a', holderId: 'h_gov', title: 'Satélite do governo', type: 'satellite', destination: 'leo', deadlineTurn: state.turn + 30 });
  const b = missions.createMandateMission(state, data, { id: 'mdt_b', holderId: 'h_fund', title: 'Satélite do fundo', type: 'satellite', destination: 'leo', deadlineTurn: state.turn + 30 });
  assert.equal(a.ok && b.ok, true);
  missions.onLaunchResolved(state, data, a.missionId, 'ascent', { level: 'total' });
  dispatch(state, data, { type: 'mission/cancel', missionId: b.missionId });
  assert.deepEqual(got, [['resolved', a.missionId, 'mdt_a', 'total'], ['cancelled', b.missionId]]);
  const sig = state.signalsPending.find((x) => x.type === 'mission/resolved' && x.missionId === a.missionId);
  assert.equal(sig.mandateId, 'mdt_a');
  assert.equal(sig.holderId, 'h_gov');
});

test('program briefing under a cap table is the anchor holder mandate; binding below 50%', () => {
  const state = newGame(data, { seed: 7, playerId: 'nasa' });
  state.cap = capTable(30);
  let d = null;
  for (let i = 0; i < 40 && !d; i++) {
    d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.kind === 'calendar');
    if (!d) advance(state);
  }
  assert.ok(d, 'program briefing');
  assert.match(d.title, /^Mandato: /);
  assert.match(d.body, /Mandato de Governo: prazo/);
  assert.equal(d.payload.holderId, 'h_gov');
  for (const id of ['delay', 'cancel']) assert.equal(d.choices.find((c) => c.id === id).disabled, true, id);
  assert.equal(resolveDecision(state, data, d.id, 'cancel').ok, false, 'the board refuses');
  const r = resolveDecision(state, data, d.id, 'accept');
  assert.equal(r.ok, true, r.error);
  const m = state.missions.find((x) => x.calendarId === d.payload.calendarId);
  assert.equal(m.holderId, 'h_gov');
  assert.ok(Number.isFinite(m.deadlineTurn) && m.deadlineTurn >= (m.targetTurn ?? 0));
  assert.equal(m.vehicleId, null);
  assert.equal(query(state, data, 'missions/list').find((x) => x.id === m.id).holder.name, 'Governo');
});

test('autonomous player (≥ 50%) may postpone a program; investors.js hears about it', () => {
  const state = newGame(data, { seed: 7, playerId: 'nasa' });
  state.cap = capTable(60);
  const told = [];
  missions.bindPeers({ investors: { onMandateDeclined: (s, d, info) => told.push(info) } });
  let d = null;
  for (let i = 0; i < 40 && !d; i++) {
    d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.kind === 'calendar');
    if (!d) advance(state);
  }
  assert.ok(!d.choices.find((c) => c.id === 'delay').disabled);
  assert.equal(resolveDecision(state, data, d.id, 'delay').ok, true);
  assert.equal(told.length, 1);
  assert.equal(told[0].choice, 'delay');
  assert.equal(told[0].holderId, 'h_gov');
});

test('no cap table: Corrida Lunar briefings and missions are unchanged (no holder, no agenda)', () => {
  const state = newGame(data, { seed: 7, playerId: 'nasa' });
  let d = null;
  for (let i = 0; i < 40 && !d; i++) {
    d = state.decisions.find((x) => x.kind === 'briefing' && x.payload?.kind === 'calendar');
    if (!d) advance(state);
  }
  assert.match(d.title, /^Briefing: /);
  assert.equal(d.payload.mandate, undefined);
  assert.ok(!d.choices.some((c) => c.disabled));
  resolveDecision(state, data, d.id, 'accept');
  const m = state.missions.find((x) => x.calendarId === d.payload.calendarId);
  assert.equal(m.holderId, undefined);
  assert.equal(m.mandate, undefined);
});

// ------------------------------------------------------------------------------------------- suggestion, guards

test('engineers suggestion for an own draft is a query: the draft stays without hardware', () => {
  const state = newGame(data, { seed: 31, playerId: 'nasa' });
  const draft = { type: 'satellite', destination: 'leo', vehicleId: null, spacecraftId: null };
  const s = query(state, data, 'missions/suggest', draft);
  assert.ok(s.vehicleId && s.vehicleName);
  assert.equal(s.reason, 'Mais barato que leva a carga');
  assert.equal(draft.vehicleId, null);
  assert.equal(query(state, data, 'missions/suggest', { type: 'satellite' }), null, 'needs a destination');
});

test('privileged Phase B links never come from a public draft', () => {
  const d = missions.publicDraft({ type: 'satellite', destination: 'leo', mandateId: 'x', holderId: 'h', testDesignId: 'dsg_1', mandate: {} });
  for (const k of ['mandateId', 'holderId', 'testDesignId', 'mandate']) assert.equal(k in d, false, k);
  const state = newGame(data, { seed: 32, playerId: 'nasa' });
  const r = dispatch(state, data, { type: 'mission/create', draft: { type: 'satellite', destination: 'leo', mandateId: 'fake', testDesignId: 'dsg_9' } });
  const m = state.missions.find((x) => x.id === r.missionId);
  assert.equal(m.mandateId, undefined);
  assert.equal(m.testDesignId, undefined);
});

test('UI helpers: locked vehicles, penalty text, holder label', async () => {
  const ui = await import('../src/ui/missions-tab.js');
  assert.equal(ui.lockedVehicle({ source: 'test' }), true);
  assert.equal(ui.lockedVehicle({ source: 'cert' }), true);
  assert.equal(ui.lockedVehicle({ source: 'calendar' }), false);
  assert.equal(ui.needsHardware({ status: 'planning', vehicleId: null, source: 'test' }), null);
  assert.ok(ui.needsHardware({ status: 'planning', vehicleId: null, source: 'custom' }));
  assert.match(ui.penaltyText({ mood: 25, cashM: 50 }), /−25 de humor do investidor, multa de US\$ 50 mi\./);
  assert.match(ui.penaltyText(null, true), /derruba a diretoria/);
  assert.equal(ui.holderLabel({ name: 'Governo', pct: 40 }), 'Governo 40%');
  assert.match(ui.holderEmblemSVG({ name: 'Fundo Órbita', kind: 'fund' }, 16), /^<svg/);
  assert.match(ui.holderEmblemSVG({ name: 'Governo', emblem: { shape: 'roundel', field: '#28628f' } }, 16), /^<svg/);
  assert.doesNotMatch(ui.holderEmblemSVG({ name: 'Governo', emblem: { shape: 'roundel' } }, 16), /OBJECT|undefined|NaN/);
});

// ------------------------------------------------------------------------------------------- bots

test('Phase B bot (tools/bot-b.mjs) flies mandates, test flights and the approved design', async () => {
  const engine = await import('../src/core/engine.js');
  const { phaseBStep, phaseBStats } = await import('../tools/bot-b.mjs');
  const state = newGame(data, { seed: 7919, playerId: 'nasa' });
  state.cap = capTable(60);
  state.mandates = [{ id: 'mdt_1', holderId: 'h_gov', title: 'Satélite de clima', type: 'satellite', destination: 'leo', count: 1, deadlineTurn: 60, rewardM: 80, penalty: { mood: 25 }, missionIds: [], status: 'open' }];
  state.designs = { dsg_1: design({ derived: { capacity: { leo: 14, gto: 5, tli: 3, mars: 2, outer: 0.5 }, costM: 50, reliabilityPrior: 0.93 } }) };
  const mem = {};
  for (let g = 0; !state.gameOver && state.turn < 110 && g < 2000; g++) {
    phaseBStep(state, data, engine, { schedule: true }, mem);
    if (state.gameOver) break;
    assert.equal(dispatch(state, data, { type: 'time/advance', weeks: 1, stopOnEvent: false }).ok, true);
  }
  const b = phaseBStats(state);
  assert.equal(b.testFlights >= 2, true, JSON.stringify(b));
  assert.equal(state.designs.dsg_1.program.phase, 'operational');
  assert.ok(b.designFlights > 0, 'the approved design flies own missions');
  assert.equal(state.missions.filter((m) => m.mandateId === 'mdt_1').length, 1, 'a fulfilled mandate is not flown again');
  assert.ok(b.programMandates > 0, 'program briefings carry the government');
  assert.deepEqual(state.log.filter((l) => l.includes('erro')), []);
});

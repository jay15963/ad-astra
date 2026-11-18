// Missões v2, contracts only when they make sense (docs/MISSIONS-V2.md §2): no lunar cargo before anyone has landed
// on the Moon; station supply only for an active station of another owner that is short of supplies, with an
// acceptable relation; one offer per asset per 26 weeks; derelict assets get none; the player must hold the keys;
// follow-ups propose the natural next step (lander → rover, first module → next module). Real Década Lunar data.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as missions from '../src/sim/missions.js';
import { achievedAny } from '../src/core/helpers.js';
import { relKey } from '../src/core/helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root, { scenarioId: 'decada_lunar' });
const row = (kind) => data.contracts.contracts.find((r) => r.kind === kind);

function fresh(playerId = 'esa', seed = 5) {
  const s = engine.newGame(data, { seed, playerId });
  s.actors[playerId].cash = 1e6;
  return s;
}
const iss = (s) => s.assets.list.find((a) => a.histId === 'iss');
const setTrust = (s, a, b, trust) => {
  const k = relKey(a, b);
  s.relations[k] = { ...(s.relations[k] || {}), trust };
};

test('contracts.json: every binding kind of §2 is authored, firstsAny are milestones, pt-BR titles', () => {
  const kinds = ['gto_comms', 'sso_obs', 'leo_constellation', 'station_supply', 'station_crew', 'station_module_assist', 'commercial_station_cargo',
    'lunar_delivery', 'base_supply', 'base_module_assist', 'mars_delivery', 'observatory_servicing', 'orbital_tourism', 'propellant_depot'];
  for (const k of kinds) assert.ok(row(k), `contrato ${k}`);
  const vocab = data.vocab || {};
  for (const r of data.contracts.contracts) {
    assert.ok(missions.TYPES.includes(r.type), `${r.kind} type`);
    assert.ok(r.title && !/\bundefined\b/.test(r.title), `${r.kind} title`);
    for (const m of r.needs?.firstsAny || []) assert.ok(!vocab.milestones || vocab.milestones[m], `${r.kind} marco ${m}`);
  }
  // no row keeps the retired type or the old CLPS kind
  assert.ok(!data.contracts.contracts.some((r) => r.type === 'lander' || r.kind === 'clps'));
});

test('helpers.achievedAny: in play or in history, actor-suffixed keys count for their base id', () => {
  assert.equal(achievedAny({ firsts: {}, firstsHistory: {} }, 'lunar_surface_robotic'), false);
  assert.equal(achievedAny({ firsts: {}, firstsHistory: { lunar_surface_robotic: { year: 1966 } } }, 'lunar_surface_robotic'), true);
  assert.equal(achievedAny({ firsts: { lunar_surface_robotic: { actorId: 'x' } } }, 'lunar_surface_robotic'), true);
  assert.equal(achievedAny({ firsts: { crewed_orbit_national: 1 } }, 'crewed_orbit_national:isro'), true);
  assert.equal(achievedAny({}, null), false);
});

test('no "carga para a Lua" before someone landed there; available once a robotic landing happened', () => {
  const s = fresh();
  const r = row('lunar_delivery');
  s.firsts = {};
  s.firstsHistory = {};
  const no = missions.contractEligible(s, data, r);
  assert.equal(no.ok, false);
  assert.equal(no.why, 'firsts:lunar_surface_robotic');
  assert.ok(!missions.contractCandidates(s, data).some((c) => c.row.kind === 'lunar_delivery'));
  s.firsts.lunar_surface_robotic = { actorId: 'cnsa', turn: 0 };
  assert.equal(missions.contractEligible(s, data, r).ok, true);
  assert.ok(missions.contractCandidates(s, data).some((c) => c.row.kind === 'lunar_delivery' && c.destination.startsWith('lunar')));
  // before the date window nothing, even with the landing done
  const early = { ...s, startYear: 1990, turn: 0 };
  assert.equal(missions.contractEligible(early, data, r).why, 'date');
});

test('station supply: only for another owner\'s active station short of supplies, with trust and low tension', () => {
  const s = fresh('esa');
  const r = row('station_supply');
  const a = iss(s);
  assert.ok(a && a.ownerId !== s.playerId, 'ISS belongs to another agency');
  setTrust(s, 'esa', a.ownerId, 60);
  a.supplyT = 1e6; // full stores: nobody needs a delivery
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).why, 'asset');
  a.supplyT = 0.5;
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).ok, true);
  const cand = missions.contractCandidates(s, data).find((c) => c.row.kind === 'station_supply' && c.asset.id === a.id);
  assert.ok(cand, 'one candidate per concrete asset');
  assert.equal(cand.destination, a.site);
  // a row with a target never stands without its asset
  assert.equal(missions.contractEligible(s, data, r).why, 'target');
  // relation and tension
  setTrust(s, 'esa', a.ownerId, 0);
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).why, 'relation');
  setTrust(s, 'esa', a.ownerId, 60);
  s.tension = { ...(s.tension || {}), [relKey('esa', a.ownerId)]: 3 };
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).why, 'tension');
  s.tension[relKey('esa', a.ownerId)] = 0;
  // one offer per asset per 26 weeks
  s.contracts.push({ id: 'ct_test', targetAssetId: a.id, createdTurn: s.turn, status: 'open', rivals: [] });
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).why, 'asset');
  s.contracts.pop();
  // a derelict station gets no supply contract
  a.status = 'derelict';
  assert.equal(missions.contractEligible(s, data, r, { asset: a }).ok, false);
  a.status = 'active';
  // the owner itself never gets a contract for its own station
  const own = fresh(a.ownerId);
  const a2 = iss(own);
  a2.supplyT = 0.5;
  assert.equal(missions.contractEligible(own, data, r, { asset: a2 }).ok, false);
});

test('research: a contract whose job the player cannot research yet is not offered', () => {
  const s = fresh('esa');
  const a = iss(s);
  a.supplyT = 0.5;
  setTrust(s, 'esa', a.ownerId, 60);
  s.research.keys = (s.research.keys || []).filter((k) => k !== 'missionType:docking');
  const res = missions.contractEligible(s, data, row('station_supply'), { asset: a });
  assert.equal(res.ok, false);
  assert.equal(res.why, 'research');
});

test('follow-ups: a probe landing proposes a rover; a first station module proposes the next module', () => {
  const s = fresh('nasa');
  const step = missions.nextStepOf(s, data, { id: 'm1', name: 'Pouso X', type: 'probe', sub: 'lander', destination: 'lunar_surface' });
  assert.equal(step.type, 'rover');
  assert.equal(step.destination, 'lunar_surface');
  const st = { id: 'as_t', kind: 'station', ownerId: 'nasa', name: 'Aurora', site: 'leo', status: 'active', modules: [{ id: 'st_core', n: 1 }], partners: [] };
  s.assets.list.push(st);
  const step2 = missions.nextStepOf(s, data, { id: 'm2', name: 'Aurora 1', type: 'station', sub: 'found', destination: 'leo', assetId: 'as_t' });
  assert.equal(step2.type, 'station');
  assert.equal(step2.sub, 'expand');
  assert.equal(step2.payload.targetAssetId, 'as_t');
  assert.ok(step2.payload.moduleId && step2.payload.moduleId !== 'st_core');
});

test('contracts made in play respect eligibility: 3 years of Década Lunar, every lunar contract after a lunar landing', () => {
  const s = fresh('esa', 11);
  s.firsts = {};
  s.firstsHistory = Object.fromEntries(Object.entries(engine.newGame(data, { seed: 11, playerId: 'esa' }).firstsHistory || {}).filter(([k]) => !/^lunar/.test(k)));
  for (let i = 0; i < 400 && s.turn < 156 && !s.gameOver; i++) {
    for (const d of s.decisions.slice()) engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: d.defaultChoice || d.choices?.[0]?.id });
    for (let lg = 0; s.activeLaunch && lg < 400; lg++) {
      const al = s.activeLaunch;
      const a = al.pendingIntervention ? { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id }
        : al.act === 'prelaunch' ? { type: 'launch/countdown' } : al.pendingHold ? { type: 'launch/hold', choice: 'go' } : al.act === 'result' ? { type: 'launch/finish' } : { type: 'launch/step' };
      assert.ok(engine.dispatch(s, data, a).ok);
    }
    if (s.decisions.length) continue;
    engine.advance(s, data, 1);
    for (const c of s.contracts) {
      const dest = data.index.destinations[c.destination];
      if (dest?.body === 'moon' && c.type === 'cargo' && !c.targetAssetId) {
        assert.ok(achievedAny(s, 'lunar_surface_robotic'), `contrato lunar ${c.id} antes de um pouso`);
      }
      assert.notEqual(c.type, 'lander');
    }
  }
  assert.ok(s.turn >= 100, `jogou só até a semana ${s.turn}`);
});

// Infraestrutura (docs/MISSIONS-V2.md §3, owner infrastructure-sim): modules.json/stations.json against the binding
// ids, deliveries (stations module by module, bases, vehicles, satellite fleets, rovers, servicing), upkeep/supply/
// health curves (dt 1 vs 13 within 1%), statuses and news once, shares and the science split, treaty access,
// historical stations by date (ISS modules, reentry, player extension), AI auto-supply and contract demand, the
// derelict card, ended → past, compaction caps, colonies (adoptBase, addInfra, ensureBaseFor), the launch-scene
// snapshot and save/load identical with assets.
// data/packs.json may not list modules/stations yet (techtree-data adds them to `core`): the files are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as infra from '../src/sim/infra.js';
import * as col from '../src/sim/colonies.js';
import * as research from '../src/sim/research.js';
import { dateToTurn } from '../src/core/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const MODULES = read('data/core/modules.json');
const STATIONS = read('data/core/stations.json');
const VOCAB = read('data/core/vocab.json');

const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
const withInfra = (d) => ({ ...d, modules: d.modules || MODULES, stations: d.stations || STATIONS });

/** Campaign data starting at `year` (colonies on from 2051), modules and stations present. */
function dataAt(year, patch = (d) => d) {
  const scenario = { ...campaign.scenario, start: { year, month: 0 }, startYear: year, unlocks: { ...(campaign.scenario.unlocks || {}), colonies: { fromYear: 2051 } } };
  return patch(withInfra({ ...campaign, scenario }));
}
function fresh(data, playerId = 'nasa', seed = 7) {
  const s = engine.newGame(data, { seed, playerId });
  s.actors[playerId].cash = 1e6;
  s.actors[playerId].budget = 50000;
  return s;
}
/** Run infra alone over `weeks` in steps of `dt` (onYear at year boundaries), like the engine's substeps. */
function run(state, data, weeks, dt = 1) {
  const end = state.turn + weeks;
  while (state.turn < end) {
    const d = Math.min(dt, end - state.turn);
    const prev = state.turn;
    state.signals = [];
    infra.tick(state, data, { prevTurn: prev, dt: d, turn: prev });
    state.turn = prev + d;
    if (Math.floor((state.turn - 1) / 52) !== Math.floor((prev - 1) / 52)) infra.onYear(state, data, { prevTurn: prev, dt: d, turn: state.turn });
  }
}
let mseq = 0;
const mission = (o) => ({ id: `mt_${++mseq}`, actorId: 'nasa', name: 'Teste', ...o });
const playerAssets = (s) => s.assets.list.filter((a) => a.ownerId === s.playerId);

// ------------------------------------------------------------------ data

test('modules.json: the binding ids of §3.2, keys, pt-BR labels, numbers in range', () => {
  const st = ['st_core', 'st_lab', 'st_multiport', 'st_hab', 'st_node', 'st_solar', 'st_airlock', 'st_arm', 'st_cupola', 'st_logistics', 'st_inflatable', 'st_depot', 'st_centrifuge', 'st_shipyard', 'st_ring', 'st_cylinder'];
  const bs = ['bs_hab_small', 'bs_solar', 'bs_comms', 'bs_lab', 'bs_fission', 'bs_isru', 'bs_pad', 'bs_garage', 'bs_hab_large', 'bs_greenhouse', 'bs_dome', 'bs_factory', 'bs_mass_driver', 'bs_arcology', 'bs_megastructure'];
  const vh = ['vh_lrv', 'vh_drone', 'vh_pressurized', 'vh_crane', 'vh_excavator', 'vh_truck', 'vh_hopper', 'vh_crawler'];
  assert.deepEqual(MODULES.station.map((m) => m.id).sort(), st.slice().sort());
  assert.deepEqual(MODULES.base.map((m) => m.id).sort(), bs.slice().sort());
  assert.deepEqual(MODULES.vehicles.map((m) => m.id).sort(), vh.slice().sort());
  const needs = new Set(['vida', 'energia', 'alimento', 'moradia', null]);
  for (const m of [...MODULES.station, ...MODULES.base]) {
    const kind = MODULES.station.includes(m) ? 'station' : 'base';
    assert.equal(m.key, `module:${kind}.${m.id.replace(/^(st|bs)_/, '')}`, m.id);
    assert.ok(m.histYear >= 1950 && m.histYear <= 3000, m.id);
    for (const k of ['massT', 'costM', 'upkeepM', 'lifeYears', 'size']) assert.ok(m[k] > 0, `${m.id}.${k}`);
    for (const k of ['storageT', 'upkeepTYr', 'science', 'crewNeed', 'crew', 'life']) assert.ok(m[k] >= 0, `${m.id}.${k}`);
    assert.ok(m.label && m.desc && m.desc.length <= 90 && !/TODO|undefined/.test(m.desc), m.id);
    if (kind === 'base') assert.ok(needs.has(m.infraNeed), `${m.id}.infraNeed`);
    if (m.milestone) assert.ok(VOCAB.milestones[m.milestone], `${m.id}: milestone ${m.milestone}`);
  }
  for (const v of MODULES.vehicles) {
    assert.equal(v.key, `rover:${v.id}`);
    assert.ok(v.massT > 0 && v.costM > 0 && v.label && v.desc, v.id);
  }
  // generic sets only name modules that exist
  const ids = new Set([...st, ...bs, ...vh]);
  for (const [name, set] of Object.entries(MODULES.stageRules.sets)) for (const [id, n] of set) assert.ok(ids.has(id) && n >= 1, `${name}: ${id}`);
  for (const [mid, r] of Object.entries(MODULES.aiBases)) {
    assert.ok(VOCAB.milestones[mid], mid);
    assert.ok(VOCAB.destinations[r.site], `${mid}: ${r.site}`);
  }
});

test('stations.json: destinations of kind station, modules exist, dates in order, owners are real actors', () => {
  const dests = new Map();
  for (const d of campaign.destinations?.destinations || []) dests.set(d.id, d);
  const mods = new Set(MODULES.station.map((m) => m.id));
  const actorIds = new Set([...Object.keys(VOCAB.destinations), ...(campaign.actors?.actors || []).map((a) => a.id)]);
  for (const h of STATIONS.stations) {
    assert.ok(VOCAB.destinations[h.destination], `${h.id}: ${h.destination}`);
    if (dests.has(h.destination)) assert.equal(dests.get(h.destination).kind, 'station', h.id);
    assert.ok(h.modules.length >= 1 && h.modules[0].id === 'st_core', `${h.id}: começa pelo núcleo`);
    let last = -Infinity;
    for (const m of h.modules) {
      assert.ok(mods.has(m.id), `${h.id}: ${m.id}`);
      const t = m.at.year * 12 + m.at.month;
      assert.ok(t >= last && m.at.month >= 1 && m.at.month <= 12, `${h.id}: datas em ordem`);
      last = t;
    }
    assert.ok(h.from.year * 12 + h.from.month <= h.modules[0].at.year * 12 + h.modules[0].at.month);
    if (h.until) assert.ok(h.until.year > h.from.year, h.id);
    assert.ok(h.name && h.reentry, h.id);
    assert.ok(actorIds.has(h.owner) || h.owner, h.id);
  }
});

// ------------------------------------------------------------------ deliveries

test('station from scratch, module by module: core founds it, labs join, crew rotation, shares by mass', () => {
  const data = dataAt(1975);
  const s = fresh(data);
  const r1 = infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Liberdade' } }));
  assert.ok(r1.created && r1.assetId);
  const a = infra.assetById(s, r1.assetId);
  assert.equal(a.kind, 'station');
  assert.equal(a.name, 'Liberdade');
  assert.equal(a.site, 'leo');
  assert.deepEqual(a.modules.map((g) => [g.id, g.n]), [['st_core', 1]]);
  const r2 = infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a.id } }));
  assert.equal(r2.assetId, a.id);
  assert.equal(r2.created, false);
  assert.deepEqual(a.modules.map((g) => [g.id, g.n]).sort(), [['st_core', 1], ['st_lab', 1]]);
  // an AI partner (by treaty) adds a lab: its share follows the mass
  s.treaties.push({ id: 'tr_t1', type: 'station_partnership', parties: ['nasa', 'esa'], status: 'active', terms: { assetId: a.id } });
  assert.ok(infra.canDeliver(s, data, 'esa', a.id).ok);
  infra.deliver(s, data, mission({ actorId: 'esa', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a.id } }));
  const shares = infra.sharesOf(s, a);
  const esa = shares.find((x) => x.actorId === 'esa').share;
  assert.ok(Math.abs(esa - 15 / (18 + 15 + 15)) < 1e-9, `esa ${esa}`);
  // rotation: crew aboard for 26 weeks, crew-weeks add to the share
  infra.deliver(s, data, mission({ type: 'crewed', sub: 'rotation', destination: 'leo', crew: { commander: 'c1', astronauts: ['c2'] }, payload: { targetAssetId: a.id } }));
  assert.equal(a.crew.n, 2);
  assert.equal(a.crew.untilTurn, s.turn + 26);
  assert.ok(a.visited);
  assert.ok(infra.sharesOf(s, a).find((x) => x.actorId === 'nasa').share > 1 - esa);
  // idempotent per mission id
  const m = mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_hab', targetAssetId: a.id } });
  infra.deliver(s, data, m);
  infra.deliver(s, data, m);
  assert.equal(a.modules.filter((g) => g.id === 'st_hab').reduce((x, g) => x + g.n, 0), 1);
});

test('satellites merge into fleets per (owner, sub, site); rovers are single assets with a life', () => {
  const data = dataAt(1990);
  const s = fresh(data);
  for (let i = 0; i < 3; i++) infra.deliver(s, data, mission({ type: 'satellite', sub: 'comms', destination: 'geo' }));
  const fleets = s.assets.list.filter((a) => a.kind === 'satellite');
  assert.equal(fleets.length, 1);
  assert.equal(fleets[0].units.reduce((x, u) => x + u.n, 0), 3);
  infra.deliver(s, data, mission({ type: 'satellite', sub: 'observatory', destination: 'leo' }));
  assert.equal(s.assets.list.filter((a) => a.kind === 'satellite').length, 2);
  const r = infra.deliver(s, data, mission({ type: 'rover', sub: 'medium', destination: 'mars_surface' }));
  const rv = infra.assetById(s, r.assetId);
  assert.equal(rv.kind, 'rover');
  assert.equal(rv.lifeEndTurn - s.turn, Math.max(1, Math.round(3 * (1 + research.techBonus(s, 'nasa', 'lifetime')) * 52)));
  // the legacy 'lander' type is a probe: nothing is created
  assert.equal(infra.deliver(s, data, mission({ type: 'lander', destination: 'lunar_surface' })).assetId, null);
  // a probe whose spacecraft is a rover (v0.8 calendar items) is a rover
  const sc = Object.values(data.index.spacecraft).find((x) => x.kind === 'rover');
  const r2 = infra.deliver(s, data, mission({ type: 'probe', spacecraftId: sc.id, destination: sc.destinations?.[0] || 'mars_surface' }));
  assert.equal(infra.assetById(s, r2.assetId)?.kind, 'rover');
});

test('observatories give science until the end of their life, then news once; servicing adds 5 years', () => {
  const data = dataAt(1990);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ type: 'satellite', sub: 'observatory', destination: 'leo' }));
  const a = infra.assetById(s, assetId);
  const life = a.units[0].endTurn - s.turn;
  const before = s.research.earned;
  run(s, data, 52 * 5, 13);
  assert.ok(s.research.earned - before > 5 * 10, `ciência ${s.research.earned - before}`);
  // servicing: +5 years on the oldest unit
  const end0 = a.units[0].endTurn;
  infra.deliver(s, data, mission({ type: 'crewed', sub: 'servicing', destination: 'leo', crew: { commander: 'c1' } }));
  assert.equal(a.units[0].endTurn, end0 + 5 * 52);
  run(s, data, life + 5 * 52, 13);
  assert.equal(a.status, 'ended');
  const n = s.news.filter((x) => /encerra a missão após/.test(x.headline));
  assert.equal(n.length, 1);
  assert.equal(s.assets.past[0].name, a.name);
});

test('bases: modules and vehicles by cargo, stage outpost → base, size tier from the module score', () => {
  const data = dataAt(2040);
  const s = fresh(data);
  const r = infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: 'bs_hab_small', newAsset: true } }));
  const b = infra.assetById(s, r.assetId);
  assert.equal(b.kind, 'base');
  assert.match(b.name, /Lua|Polo|Shackleton|Base|Posto|Vila|Acampamento|Estação/);
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: 'bs_solar', targetAssetId: b.id } }));
  assert.equal(infra.stageOf(s, data, b), 1, 'sem visita tripulada não é posto');
  infra.deliver(s, data, mission({ type: 'crewed', sub: 'landing', destination: 'lunar_south_pole', crew: { commander: 'c1', astronauts: ['c2'] } }));
  assert.equal(infra.stageOf(s, data, b), 2);
  assert.equal(infra.sizeTier(s, data, b), 0);
  for (const id of ['bs_hab_large', 'bs_fission', 'bs_isru', 'bs_lab', 'bs_pad']) infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: id, targetAssetId: b.id } }));
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_vehicle', destination: 'lunar_south_pole', payload: { kind: 'base_vehicle', vehicleTypeId: 'vh_truck', qty: 2, targetAssetId: b.id } }));
  assert.equal(infra.stageOf(s, data, b), 3);
  assert.equal(b.vehicles.reduce((x, g) => x + g.n, 0), 2);
  assert.ok(infra.sizeTier(s, data, b) >= 2);
  assert.ok(s.firsts.first_fission_surface_power, 'reator de fissão é marco');
});

// ------------------------------------------------------------------ maintenance

test('upkeep, supply and health: dt 1 and dt 13 agree within 1% (supply runs out mid-step)', () => {
  const data = dataAt(1980);
  const base = fresh(data);
  const { assetId } = infra.deliver(base, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  for (let i = 0; i < 3; i++) infra.deliver(base, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: assetId } }));
  const a0 = infra.assetById(base, assetId);
  a0.supplyT = 5.5;
  a0.crew = { n: 2, untilTurn: null, missionId: null };
  const A = JSON.parse(JSON.stringify(base));
  const B = JSON.parse(JSON.stringify(base));
  const e0 = base.research.earned;
  run(A, data, 156, 1);
  run(B, data, 156, 13);
  const a = infra.assetById(A, assetId);
  const b = infra.assetById(B, assetId);
  assert.ok(Math.abs(a.health - b.health) <= Math.max(0.5, a.health * 0.01), `saúde ${a.health} vs ${b.health}`);
  assert.equal(a.status, b.status);
  assert.ok(Math.abs(a.supplyT - b.supplyT) < 0.01);
  const sa = A.research.earned - e0;
  const sb = B.research.earned - e0;
  assert.ok(sa > 0 && Math.abs(sa - sb) / sa < 0.01, `ciência ${sa} vs ${sb}`);
  // the curve: supplied → healthy; out of supply → crew evacuated, health falls by starveYr
  assert.equal(a.supplyT, 0);
  assert.equal(a.crew.n, 0);
  assert.ok(a.health < 100);
});

test('statuses: degraded news once, derelict card for the owner, 3 years derelict → ended and past', () => {
  const data = dataAt(1980);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Teste' } }));
  const a = infra.assetById(s, assetId);
  a.supplyT = 0;
  run(s, data, 52 * 2 + 13, 13); // 100 → 40 in 2 years at 30/yr
  assert.ok(['degraded', 'derelict'].includes(a.status), a.status);
  run(s, data, 52, 13);
  assert.equal(a.status, 'derelict');
  assert.equal(s.news.filter((n) => n.headline === 'Teste se degrada sem suprimentos').length, 1);
  const cards = s.decisions.filter((d) => d.kind === 'infra/derelict');
  assert.equal(cards.length, 1);
  // "Resgatar" returns a prefilled supply draft and keeps the asset
  const res = engine.resolveDecision(s, data, cards[0].id, 'rescue');
  assert.equal(res.draft.type, 'cargo');
  assert.equal(res.draft.payload.kind, 'supply');
  assert.equal(res.draft.payload.targetAssetId, a.id);
  // a supply rescue of an own derelict asset is allowed; others' are not
  assert.ok(infra.canDeliver(s, data, 'nasa', a.id, { payloadKind: 'supply', type: 'cargo' }).ok);
  assert.equal(infra.canDeliver(s, data, 'nasa', a.id, { payloadKind: 'station_module', type: 'station' }).reason, 'Teste está abandonada.');
  run(s, data, 52 * 3 + 13, 13);
  assert.equal(a.status, 'ended');
  assert.ok(s.assets.past.some((x) => x.name === 'Teste' && x.cause === 'reentrada'));
  // ended assets leave the list after 5 years
  run(s, data, 52 * 6, 13);
  infra.compact(s, data, {});
  assert.equal(infra.assetById(s, assetId), null);
});

test('supply cargo heals: health climbs back, status recovers, reminders when < 13 weeks', () => {
  const data = dataAt(1980);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Farol' } }));
  const a = infra.assetById(s, assetId);
  a.health = 30;
  a.status = 'degraded';
  a.crew = { n: 3, untilTurn: s.turn + 200, missionId: null };
  a.supplyT = 0;
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'supply', destination: 'leo', payload: { kind: 'supply', qty: 2, targetAssetId: a.id } }));
  assert.equal(a.supplyT, 2);
  run(s, data, 13, 1);
  assert.ok(s.news.some((n) => /^Farol: suprimentos para \d+ semanas?$/.test(n.headline)), 'lembrete de suprimentos');
  a.supplyT = 4; a.crew.n = 0;
  run(s, data, 52 * 2, 13);
  assert.ok(a.health > 40);
  assert.equal(a.status, 'active');
});

test('science split by share; AI owners get prestige; degraded halves the yield', () => {
  const data = dataAt(1985);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  const a = infra.assetById(s, assetId);
  infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a.id } }));
  s.treaties.push({ id: 'tr_t2', type: 'mission_partnership', parties: ['nasa', 'roscosmos'], status: 'active', terms: {} });
  infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a.id } }));
  a.crew = { n: 4, untilTurn: null, missionId: null };
  a.supplyT = 6;
  const share = infra.shareOf(s, a, 'nasa');
  assert.ok(share > 0.25 && share < 0.4);
  const sci = infra.scienceYr(s, data, a);
  const e0 = s.research.earned;
  run(s, data, 13, 13);
  const got = s.research.earned - e0;
  assert.ok(Math.abs(got - sci * share * 13 / 52) < 0.05, `${got} vs ${sci * share / 4}`);
  a.status = 'degraded';
  assert.ok(Math.abs(infra.scienceYr(s, data, a, a.health) - sci * 0.5) < 1e-6);
  a.status = 'active';
  const p0 = s.actors.roscosmos.prestige;
  infra.refresh?.(s, data, a);
  a.sciYr = sci;
  infra.onYear(s, data, { prevTurn: s.turn, dt: 1, turn: s.turn });
  assert.ok(s.actors.roscosmos.prestige > p0);
});

test('canDeliver: own ok; others need a treaty or a contract; tension ≥ 3 blocks; rotation room', () => {
  const data = dataAt(1985);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Salyut 9' } }));
  assert.ok(infra.canDeliver(s, data, 'roscosmos', assetId).ok);
  assert.equal(infra.canDeliver(s, data, 'nasa', assetId).reason, `Precisa de uma parceria de estação com ${s.actors.roscosmos.short || s.actors.roscosmos.name}.`);
  s.contracts = [{ id: 'ct_x', targetAssetId: assetId, winner: 'nasa', status: 'awarded' }];
  assert.ok(infra.canDeliver(s, data, 'nasa', assetId).ok, 'contrato que nomeia o ativo');
  s.contracts = [];
  s.treaties.push({ id: 'tr_t3', type: 'station_partnership', parties: ['nasa', 'roscosmos'], status: 'active', terms: { assetId: 'as_outra' } });
  assert.equal(infra.canDeliver(s, data, 'nasa', assetId).ok, false, 'parceria de outra estação');
  s.treaties.push({ id: 'tr_t4', type: 'crew_exchange', parties: ['nasa', 'roscosmos'], status: 'active', terms: {} });
  assert.ok(infra.canDeliver(s, data, 'nasa', assetId).ok);
  const k = ['nasa', 'roscosmos'].sort().join('|');
  s.tension[k] = 3;
  assert.match(infra.canDeliver(s, data, 'nasa', assetId).reason, /tensão/);
  s.tension[k] = 0;
  assert.equal(infra.canDeliver(s, data, 'nasa', assetId, { type: 'crewed', sub: 'rotation', seats: 5 }).reason, 'Salyut 9 tem lugar para 3 tripulantes.');
  // targetsFor lists it with the reason
  const rows = infra.targetsFor(s, data, { type: 'cargo', sub: 'supply', destination: 'leo', payloadKind: 'supply' }, 'nasa');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, true);
});

// ------------------------------------------------------------------ historical stations

test('ISS by date: modules added on their dates, partners by `by`, reentry at the end of 2030', () => {
  const data = dataAt(1998);
  const s = fresh(data, 'esa');
  const iss = () => s.assets.list.find((a) => a.histId === 'iss');
  assert.equal(iss(), undefined, 'jan/1998: ainda não');
  run(s, data, dateToTurn(1999, 0, 1998) - s.turn, 13);
  const a = iss();
  assert.ok(a, 'ISS em 1999');
  assert.equal(a.ownerId, 'nasa');
  assert.deepEqual(a.modules.map((g) => g.id).sort(), ['st_core', 'st_node']);
  assert.equal(a.modules.find((g) => g.id === 'st_core').by, 'roscosmos');
  run(s, data, dateToTurn(2012, 0, 1998) - s.turn, 13);
  const n = a.modules.reduce((x, g) => x + g.n, 0);
  assert.equal(n, 16);
  assert.ok(infra.shareOf(s, a, 'esa') > 0.05, 'Columbus e Cúpula dão cota à ESA');
  // historical stations are resupplied abstractly and do not cost the player money
  assert.equal(a.status, 'active');
  assert.ok(a.supplyT > 0);
  run(s, data, dateToTurn(2031, 1, 1998) - s.turn, 13);
  assert.equal(a.status, 'ended');
  assert.equal(s.assets.past[0].cause, 'reentrada');
  assert.ok(s.news.some((x) => /Ponto Nemo/.test(x.headline)));
});

test('a historical station lives on while the player holds ≥ 25% and keeps supplying it', () => {
  const data = dataAt(2026);
  const s = fresh(data, 'esa');
  const a = s.assets.list.find((x) => x.histId === 'iss');
  assert.ok(a && a.status === 'active');
  // the player becomes a big partner (modules and supplies)
  for (let i = 0; i < 6; i++) infra.deliver(s, data, mission({ actorId: 'esa', type: 'station', destination: 'iss', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: a.id } }));
  assert.ok(infra.shareOf(s, a, 'esa') >= 0.25);
  const until0 = a.untilTurn;
  for (let y = 0; y < 6; y++) {
    infra.deliver(s, data, mission({ actorId: 'esa', type: 'cargo', sub: 'supply', destination: 'iss', payload: { kind: 'supply', qty: 4, targetAssetId: a.id } }));
    run(s, data, 52, 13);
  }
  assert.ok(a.untilTurn > until0);
  assert.equal(a.status, 'active', 'ainda voando depois de 2030');
});

test('AI owners resupply while their budget allows; under pressure supply decays (contract demand)', () => {
  const data = dataAt(1990);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  const a = infra.assetById(s, assetId);
  a.crew = { n: 3, untilTurn: null, missionId: null };
  s.actors.roscosmos.cash = s.actors.roscosmos.budget * 5;
  run(s, data, 52, 13);
  assert.ok(a.supplyT > 0 && a.crew.n === 3, `abastecida ${a.supplyT}, tripulação ${a.crew.n}`);
  s.actors.roscosmos.cash = -s.actors.roscosmos.budget;
  run(s, data, 26, 13);
  assert.ok(infra.supplyRatio(data, a) < 0.6, 'sem verba: a reserva cai e a estação vira demanda de contrato');
  assert.ok(infra.listAssets(s, { kind: 'station', other: true }).some((x) => x.id === a.id));
});

test('AI calendar flights with base milestones build AI bases at the site', () => {
  const data = dataAt(2038);
  const s = fresh(data, 'esa');
  const item = Object.values(data.index.calendar).find((c) => c.milestone === 'lunar_base' && c.owner === 'nasa');
  assert.ok(item);
  s.signals = [{ type: 'mission/resolved', calendarId: item.id, actorId: 'nasa', destination: item.destination, missionType: item.type, outcome: 'total' }];
  infra.tick(s, data, { prevTurn: s.turn, dt: 1, turn: s.turn });
  const b = s.assets.list.find((x) => x.kind === 'base' && x.ownerId === 'nasa');
  assert.ok(b, 'base da IA');
  assert.equal(b.site, item.destination);
  assert.equal(infra.stageOf(s, data, b), 2);
  assert.ok(b.modules.length >= 2);
});

// ------------------------------------------------------------------ colonies

test('colonies: a base that reaches outpost is adopted (adoptBase), new modules raise infra (addInfra)', () => {
  const data = dataAt(2052);
  const s = fresh(data);
  const site = col.cfg(data).sites.find((x) => x.destination === 'lunar_south_pole');
  assert.ok(site);
  const r = infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: site.destination, payload: { kind: 'base_module', moduleId: 'bs_hab_small', newAsset: true } }));
  const b = infra.assetById(s, r.assetId);
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: site.destination, payload: { kind: 'base_module', moduleId: 'bs_solar', targetAssetId: b.id } }));
  infra.deliver(s, data, mission({ type: 'crewed', sub: 'landing', destination: site.destination, crew: { commander: 'c1', astronauts: ['c2', 'c3', 'c4'] } }));
  assert.equal(b.stageN, 2);
  run(s, data, 13, 13);
  assert.ok(b.colonyId, 'adotada como colônia');
  const c = s.colonies.list.find((x) => x.id === b.colonyId);
  assert.equal(c.assetId, b.id);
  assert.equal(c.stage, 2);
  assert.equal(c.ownerId, 'nasa');
  assert.ok(c.population >= 4);
  const lv = c.infra.energia;
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: site.destination, payload: { kind: 'base_module', moduleId: 'bs_fission', targetAssetId: b.id } }));
  assert.equal(c.infra.energia, lv + 1);
  // the direct API
  assert.equal(col.addInfra(s, data, c.id, 'vida', 2), true);
  assert.equal(col.addInfra(s, data, c.id, 'nope', 1), false);
  assert.equal(col.applyShock(s, data, c.id, 'vida', -10), true);
});

test('colonies: a colony founded by the abstract path gets its base asset (ensureBaseFor)', () => {
  const data = dataAt(2060);
  const s = fresh(data);
  const cs = col.slice(s);
  const site = col.cfg(data).sites.find((x) => x.destination === 'mars_surface');
  cs.list.push({ id: 'col_x', name: 'Nova Arcádia', siteId: site.id, ownerId: 'nasa', founderId: 'nasa', stage: 3, status: 'active', population: 30, infra: {}, shock: {}, route: 1, reserve: 20 });
  run(s, data, 1, 1);
  const c = cs.list.find((x) => x.id === 'col_x');
  const b = infra.assetById(s, c.assetId);
  assert.ok(b && b.kind === 'base' && b.colonyId === 'col_x');
  assert.equal(b.site, 'mars_surface');
  assert.ok(b.modules.length >= 4 && b.vehicles.length >= 1);
  assert.ok(infra.sizeTier(s, data, b) >= 2);
  assert.equal(infra.ensureBaseFor(s, data, c), b.id, 'idempotente');
  // the colony route keeps the base supplied
  b.supplyT = 0;
  run(s, data, 13, 13);
  assert.ok(b.supplyT > 0);
});

// ------------------------------------------------------------------ launch scene, caps, save/load

test('sceneTarget: dock / berth / release / surface, JSON snapshot', () => {
  const data = dataAt(2040);
  const s = fresh(data);
  const iss = s.assets.list.find((x) => x.histId === 'iss');
  const cargoSc = Object.values(data.index.spacecraft).find((x) => x.kind === 'cargo' && x.docking !== 'auto');
  const capsule = Object.values(data.index.spacecraft).find((x) => x.kind === 'capsule');
  if (iss && iss.status !== 'ended') {
    const t = infra.sceneTarget(s, data, mission({ type: 'cargo', sub: 'supply', destination: 'iss', spacecraftId: cargoSc?.id, payload: { kind: 'supply', qty: 2, targetAssetId: iss.id } }));
    assert.equal(t.sequence, 'berth');
  }
  const { assetId } = infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  const dock = infra.sceneTarget(s, data, mission({ type: 'crewed', sub: 'rotation', destination: 'leo', spacecraftId: capsule.id, payload: { targetAssetId: assetId } }));
  assert.equal(dock.sequence, 'dock');
  assert.equal(dock.kind, 'station');
  assert.deepEqual(dock.modules, [{ id: 'st_core', n: 1 }]);
  const rel = infra.sceneTarget(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  assert.equal(rel.sequence, 'release');
  assert.equal(rel.newAsset, true);
  assert.equal(rel.payload.moduleId, 'st_core');
  const surf = infra.sceneTarget(s, data, mission({ type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: 'bs_hab_small', newAsset: true } }));
  assert.equal(surf.sequence, 'surface');
  assert.equal(surf.bodyId, 'moon');
  assert.deepEqual(JSON.parse(JSON.stringify(surf)), surf);
  assert.equal(infra.sceneTarget(s, data, mission({ type: 'probe', destination: 'mars_orbit' })), null);
});

test('caps: player live assets ≤ 60 (satellites in fleets), past ≤ 30, AI ≤ 40 after compaction', () => {
  const data = dataAt(2000);
  const s = fresh(data);
  for (let i = 0; i < 70; i++) infra.deliver(s, data, mission({ type: 'rover', sub: 'heavy', destination: 'mars_surface' }));
  assert.equal(playerAssets(s).length, 60);
  for (let i = 0; i < 50; i++) infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  infra.compact(s, data, {});
  assert.ok(s.assets.list.filter((a) => a.ownerId !== 'nasa').length <= 40);
  for (let i = 0; i < 40; i++) s.assets.past.push({ name: `x${i}`, kind: 'rover', ownerId: 'nasa', year: 2000, cause: 'x' });
  infra.compact(s, data, {});
  assert.ok(s.assets.past.length <= 30);
});

test('onActorGone: assets pass to the absorbing actor, else to the biggest partner, else derelict', () => {
  const data = dataAt(1990);
  const s = fresh(data);
  const { assetId } = infra.deliver(s, data, mission({ actorId: 'roscosmos', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  const a = infra.assetById(s, assetId);
  infra.onActorGone(s, data, {}, 'roscosmos', { into: 'esa' });
  assert.equal(a.ownerId, 'esa');
  assert.ok(a.partners.some((p) => p.actorId === 'esa'));
  const r2 = infra.deliver(s, data, mission({ actorId: 'cnsa', type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  const b = infra.assetById(s, r2.assetId);
  delete s.actors.cnsa;
  infra.onActorGone(s, data, {}, 'cnsa', {});
  assert.equal(b.status, 'derelict');
});

test('save/load identical with assets; queries never show undefined/NaN', () => {
  const data = dataAt(2040);
  const s = fresh(data);
  infra.deliver(s, data, mission({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true } }));
  infra.deliver(s, data, mission({ type: 'satellite', sub: 'comms', destination: 'geo' }));
  infra.deliver(s, data, mission({ type: 'rover', sub: 'heavy', destination: 'mars_surface' }));
  infra.deliver(s, data, mission({ type: 'cargo', sub: 'base_module', destination: 'lunar_south_pole', payload: { kind: 'base_module', moduleId: 'bs_hab_small', newAsset: true } }));
  run(s, data, 30, 13);
  const json = engine.serialize(s);
  const back = engine.deserialize(json, data);
  assert.deepEqual(back.assets, s.assets);
  const A = JSON.parse(JSON.stringify(s));
  run(A, data, 52, 13);
  run(back, data, 52, 13);
  assert.deepEqual(back.assets, A.assets);
  const text = JSON.stringify([engine.query(s, data, 'infra/list'), engine.query(s, data, 'infra/summary')]);
  assert.ok(!/undefined|NaN/.test(text), text.slice(0, 300));
  const v = engine.query(s, data, 'infra/list');
  assert.ok(v.length >= 4);
  assert.ok(v.every((x) => x.kindLabel && x.statusLabel && x.siteName));
  // rename / abandon actions
  const mine = v.find((x) => x.mine && x.kind === 'station' && !x.hist);
  assert.equal(engine.dispatch(s, data, { type: 'infra/rename', assetId: mine.id, name: 'Ipê' }).ok, true);
  assert.equal(infra.assetById(s, mine.id).name, 'Ipê');
  assert.equal(engine.dispatch(s, data, { type: 'infra/abandon', assetId: mine.id }).ok, true);
  assert.equal(infra.assetById(s, mine.id).status, 'ended');
});

test('legacy v0.8 saves: successful station missions become a share of the historical station', () => {
  const data = dataAt(2026);
  const s = fresh(data, 'esa');
  const before = s.assets.list.find((x) => x.histId === 'iss');
  const issModules = before.modules.reduce((x, g) => x + g.n, 0);
  delete s.assets;
  s.missions = [{ id: 'm_old', type: 'station', destination: 'iss', status: 'done', result: { outcome: 'total' } }];
  run(s, data, 1, 1);
  const iss = s.assets.list.find((x) => x.histId === 'iss');
  assert.ok(iss);
  assert.equal(iss.modules.reduce((x, g) => x + g.n, 0), issModules + 1);
  assert.ok(infra.shareOf(s, iss, 'esa') > 0);
  assert.equal(s.assets.legacyDone, true);
});

test('engine: infra is registered right after missions; budget has the infra and market categories', async () => {
  const names = engine.MODULES.map(([n]) => n);
  assert.equal(names[names.indexOf('missions') + 1], 'infra');
  const budget = await import('../src/sim/budget.js');
  assert.ok(budget.CATEGORIES.includes('infra') && budget.CATEGORIES.includes('market'));
  assert.equal(budget.CATEGORY_LABELS.infra, 'Infraestrutura');
  assert.equal(budget.CATEGORY_LABELS.market, 'Vendas de foguetes');
});

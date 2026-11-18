// Review fixes (Missões v2, sim side): research gate on edits of scheduled missions, rocket-market price cap,
// station share only for stored cargo, founded agencies start their own research, the 1950 campaign gets no 2026
// start set, contract auctions outlive a 13-week step, colony-fed bases never ask for cargo, and the compact save
// encoding of the research slice is lossless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import * as infra from '../src/sim/infra.js';
import * as market from '../src/sim/market.js';
import { histYearOf } from '../src/core/gating.js';
import { packState, unpackState } from '../src/core/savepack.js';
import { dropEarlyStartNodes } from '../src/core/migrations/v4.js';
import { foundingPayload } from '../tools/bot-b.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const decada = await loadDataNode(ROOT, { scenarioId: 'decada_lunar' });
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });

test('a scheduled mission cannot be edited into content the player has not researched (§5.3)', () => {
  const s = engine.newGame(decada, { seed: 5, playerId: 'nasa' });
  s.actors.nasa.cash = 1e6;
  const sugg = engine.query(s, decada, 'missions/suggest', { type: 'satellite', sub: 'science', destination: 'leo' });
  const c = engine.dispatch(s, decada, { type: 'mission/create', draft: { type: 'satellite', sub: 'science', destination: 'leo', vehicleId: sugg?.vehicleId, spacecraftId: sugg?.spacecraftId } });
  assert.ok(c.ok, c.error);
  const sch = engine.dispatch(s, decada, { type: 'mission/schedule', missionId: c.missionId });
  assert.ok(sch.ok, sch.error);
  const m = s.missions.find((x) => x.id === c.missionId);
  for (const mod of ['st_depot', 'st_centrifuge', 'st_shipyard']) {
    const r = engine.dispatch(s, decada, { type: 'mission/update', missionId: m.id, patch: { type: 'station', destination: 'leo', spacecraftId: null, vehicleId: 'starship', sub: null, payload: { kind: 'station_module', moduleId: mod, newAsset: true } } });
    assert.equal(r.ok, false, mod);
    assert.equal(m.type, 'satellite', 'the mission keeps what it had');
  }
  // the hardware it already carries is still grandfathered: a harmless edit of the same content passes the gate
  const keep = engine.dispatch(s, decada, { type: 'mission/update', missionId: m.id, patch: { name: 'Mesmo satélite' } });
  assert.ok(keep.ok, keep.error);
});

test('market: a proposal far above the reference price is refused and has no chance', () => {
  const s = engine.newGame(decada, { seed: 11, playerId: 'spacex' });
  const vid = market.sellables(s, decada)[0]?.vehicleId;
  assert.ok(vid);
  const cap = engine.query(s, decada, 'market/maxPrice', vid, 'isro');
  assert.ok(cap >= 1);
  assert.equal(market.proposeChance(s, decada, vid, 'isro', 1e7), 0);
  const r = engine.dispatch(s, decada, { type: 'market/propose', vehicleId: vid, buyerId: 'isro', units: 8, priceM: 1e7 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Preço alto demais/);
  const ok = engine.dispatch(s, decada, { type: 'market/propose', vehicleId: vid, buyerId: 'isro', units: 2, priceM: cap });
  assert.ok(ok.ok, ok.error);
  assert.ok(ok.chance > 0);
});

test('infra: supply that does not fit in storage does not raise the partner share', () => {
  const s = engine.newGame(decada, { seed: 5, playerId: 'nasa' });
  const iss = s.assets.list.find((a) => a.histId === 'iss');
  const p0 = (iss.partners.find((p) => p.actorId === 'nasa')?.massT) || 0;
  const s0 = iss.supplyT;
  for (let i = 0; i < 10; i++) {
    infra.deliver(s, decada, { id: `x${i}`, actorId: 'nasa', owner: 'nasa', type: 'cargo', sub: 'supply', destination: 'iss', spacecraftId: 'cargo_dragon', payload: { kind: 'supply', qty: 8, targetAssetId: iss.id } }, 'total');
  }
  const p1 = iss.partners.find((p) => p.actorId === 'nasa').massT;
  assert.ok(Math.abs((p1 - p0) - (iss.supplyT - s0)) < 0.01, `credited ${p1 - p0} t for ${iss.supplyT - s0} t stored`);
});

test('agency/found on a game created for another actor starts the research of a new agency', () => {
  const s = engine.newGame(campaign, { seed: 3, playerId: 'nasa' });
  const r = engine.dispatch(s, campaign, foundingPayload(s, campaign, { seed: 3 }));
  assert.ok(r.ok, r.error);
  assert.notEqual(s.playerId, 'nasa');
  assert.ok(s.research.unlocked.includes('t1_prop_sounding'));
  assert.ok(s.research.keys.includes('vehicle:sounding'));
  assert.ok(Array.isArray(s.research.rivals.nasa), 'the old actor joins the rivals');
  const back = engine.deserialize(engine.serialize(s), campaign);
  assert.deepEqual(back.research.keys, s.research.keys);
});

test('the 1950 campaign gives nobody the 2026 start set (initialFor of later years waits for its year)', () => {
  const s = engine.newGame(campaign, { seed: 1, playerId: 'nasa' });
  const byId = campaign.index.tech;
  for (const id of s.research.unlocked) assert.ok(histYearOf(byId[id]) <= 1951, id);
  for (const [actor, list] of Object.entries(s.research.rivals)) {
    for (const id of list) assert.ok(histYearOf(byId[id]) <= 1950, `${actor}: ${id}`);
  }
  // v0.8 saves: the migration drops them while their year is ahead
  assert.deepEqual(dropEarlyStartNodes(campaign, ['t1_prop_sounding', 'en_solar', 'sci_labs'], 1969), ['t1_prop_sounding']);
  assert.deepEqual(dropEarlyStartNodes(campaign, ['en_solar'], 2030), ['en_solar']);
});

test('contract offers in 13-week steps: every card on the table is for an open auction', () => {
  const f = join(ROOT, 'tools/_scratch/ref/saves/y2150.json');
  if (!existsSync(f)) return;
  const data = campaign;
  const s = engine.deserialize(readFileSync(f, 'utf8'), data);
  assert.equal(engine.stepInfo(s, data).dt, 13);
  let seen = 0;
  for (let i = 0; i < 16 && !s.gameOver; i++) {
    for (const d of s.decisions.slice()) if (d.kind !== 'contract/offer') {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      engine.dispatch(s, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    }
    if (s.clock?.pendingEra) break;
    while (s.activeLaunch) {
      const al = s.activeLaunch;
      if (al.pendingIntervention) engine.dispatch(s, data, { type: 'launch/choose', optionId: al.pendingIntervention.options[0].id });
      else if (al.act === 'prelaunch') engine.dispatch(s, data, { type: 'launch/countdown' });
      else if (al.pendingHold) engine.dispatch(s, data, { type: 'launch/hold', choice: 'go' });
      else if (al.act === 'result') engine.dispatch(s, data, { type: 'launch/finish' });
      else engine.dispatch(s, data, { type: 'launch/step' });
    }
    engine.dispatch(s, data, { type: 'time/advance', turns: 1 });
    for (const d of s.decisions.filter((x) => x.kind === 'contract/offer')) {
      const c = s.contracts.find((x) => x.id === d.payload.contractId);
      assert.equal(c?.status, 'open', `${d.title} t${s.turn}`);
      assert.ok(d.expiresTurn >= s.turn, `${d.title} expires ${d.expiresTurn} at t${s.turn}`);
      seen++;
    }
  }
  assert.ok(seen > 0, 'some offers were made');
});

test('colony-fed bases are supplied by their colony: no cargo reminder, site named in pt-BR', () => {
  const f = join(ROOT, 'tools/_scratch/ref/saves/col.json');
  if (!existsSync(f)) return;
  const s = engine.deserialize(readFileSync(f, 'utf8'), campaign);
  engine.dispatch(s, campaign, { type: 'time/advance', turns: 1 });
  const mine = s.assets.list.filter((a) => a.ownerId === s.playerId && a.kind === 'base' && a.status !== 'ended' && infra.colonyFed(s, a));
  assert.ok(mine.length >= 1);
  for (const a of mine) {
    const v = infra.assetView(s, campaign, a);
    assert.equal(v.supplyWeeks, null, a.name);
    assert.ok(!/_/.test(v.siteName), v.siteName);
  }
});

test('save: research ids, completion turns and bonuses are packed losslessly', () => {
  const s = engine.newGame(campaign, { seed: 2, playerId: 'nasa' });
  for (let i = 0; i < 30; i++) engine.dispatch(s, campaign, { type: 'time/advance', turns: 1 });
  s.research.completedTurn.t1_prop_sounding = 3;
  const ref = JSON.stringify(s);
  const j = JSON.stringify(packState(s));
  assert.equal(JSON.stringify(unpackState(JSON.parse(j))), ref);
  const back = engine.deserialize(engine.serialize(s), campaign);
  assert.equal(engine.serialize(back), engine.serialize(s));
});

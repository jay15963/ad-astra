// Fase D3 (história): itens "fato" do calendário com o resultado real (Apollo 13 parcial, Soyuz 1 e 11 com a tripulação
// perdida, N1, Vanguard TV-3, Challenger, Columbia), canon.requires/onBreak, destino suborbital (Freedom 7, Liberty
// Bell 7), linhagem OKB-1 → TsKBEM (1966) → NPO Energia (1974) → RKA → Roscosmos, herança de foguetes da ABMA,
// geopolítica de 2026 congelada depois de 2100, textos de corpos datados e nomes/siglas únicos entre atores vivos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { dateToTurn } from '../src/core/time.js';
import * as calendarMod from '../src/sim/calendar.js';
import * as lifecycle from '../src/sim/lifecycle.js';
import { runCampaign } from '../tools/campaign.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
const item = (id) => calendarMod.calendarItem(campaign, id);

test('historicalResult: the real outcome, phase and crew loss come from data', () => {
  const r = (id) => calendarMod.historicalResult(campaign, item(id));
  assert.equal(r('sputnik1').level, 'total');
  assert.deepEqual([r('apollo13').level, r('apollo13').phase, r('apollo13').vehicleFails], ['partial', 'arrival', false]);
  assert.deepEqual([r('mars3').level, r('mars3').phase], ['partial', 'arrival']);
  assert.deepEqual([r('vanguard_tv3').level, r('vanguard_tv3').vehicleFails, r('vanguard_tv3').lostCrew], ['catastrophic', true, false]);
  for (const id of ['soyuz1', 'soyuz11', 'sts107']) {
    assert.deepEqual([r(id).level, r(id).vehicleFails, r(id).lostCrew], ['catastrophic', false, true], id);
  }
  assert.deepEqual([r('sts51l').level, r('sts51l').vehicleFails, r('sts51l').lostCrew], ['catastrophic', true, true]);
  for (const id of ['n1_3l', 'n1_5l', 'n1_6l', 'n1_7l']) assert.deepEqual([r(id).level, r(id).phase, r(id).vehicleFails], ['catastrophic', 'ascent', true], id);
  assert.deepEqual([r('mars96').phase, r('mars_observer').phase], ['ascent', 'arrival']);
  assert.equal(r('liberty_bell7').level, 'partial');
  // non-historical items have no fixed result
  assert.equal(calendarMod.historicalResult(campaign, { ...item('sputnik1'), truthLayer: 'projecao' }), null);
});

test('suborbital: destination enabled, Mercury-Redstone reaches it but not orbit, Freedom 7 and Liberty Bell 7 on their months', () => {
  const d = campaign.destinations.destinations.find((x) => x.id === 'suborbital');
  assert.equal(d.kind, 'suborbital');
  const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/core/vocab.json'), 'utf8'));
  assert.equal(vocab.destinationKinds.suborbital.status, undefined, 'tipo não está mais reservado');
  assert.equal(vocab.destinations.suborbital.status, undefined);
  assert.ok(calendarMod.capacityTo(campaign, 'mercury_redstone', 'suborbital') > 1);
  assert.equal(calendarMod.capacityTo(campaign, 'mercury_redstone', 'leo'), 0);
  assert.ok(calendarMod.capacityTo(campaign, 'atlas_lv3b', 'suborbital') > calendarMod.capacityTo(campaign, 'atlas_lv3b', 'leo'));
  assert.deepEqual(item('freedom7').planned, { year: 1961, month: 5 });
  assert.deepEqual(item('liberty_bell7').planned, { year: 1961, month: 7 });
});

test('canon.requires: waits for the presupposed item, drops when it was cancelled or an actor is gone', () => {
  const s = engine.newGame(campaign, { seed: 5, playerId: 'cnes' });
  const lb = item('liberty_bell7');
  const f7 = calendarMod.calendarInstance(s, 'freedom7') || (s.calendar.push({ id: 'freedom7', status: 'planned' }), calendarMod.calendarInstance(s, 'freedom7'));
  f7.status = 'planned';
  assert.deepEqual(calendarMod.canonStatus(s, campaign, lb), { wait: 'freedom7' });
  f7.status = 'success';
  assert.equal(calendarMod.canonStatus(s, campaign, lb), null);
  f7.status = 'failed';
  assert.equal(calendarMod.canonStatus(s, campaign, lb), null, 'voou, mesmo que falhando: a história seguiu');
  f7.status = 'cancelled';
  assert.match(calendarMod.canonStatus(s, campaign, lb).reason, /Freedom 7 .*não aconteceu/);
  // actorAlive
  const astp = item('astp');
  const saved = s.actors.roscosmos;
  delete s.actors.roscosmos;
  assert.match(calendarMod.canonStatus(s, campaign, astp).reason, /não existe mais/);
  s.actors.roscosmos = saved;
  // the Corrida Lunar never reads canon
  assert.equal(calendarMod.canonStatus({ ...s, lifecycle: undefined }, campaign, lb), null);
});

test('1950→1976 campaign: history flies with its real outcomes, crews lost where they were lost', () => {
  const res = runCampaign(campaign, { seed: 7919, playerId: 'cnes', fast: true, toEra: 'e1' });
  assert.deepEqual(res.errors, []);
  const s = res.state;
  const st = (id) => calendarMod.instanceOrPast(s, id)?.status;
  const want = {
    sputnik1: 'success', vanguard_tv3: 'failed', vanguard1: 'success', freedom7: 'success', liberty_bell7: 'partial',
    soyuz1: 'failed', n1_3l: 'failed', n1_5l: 'failed', apollo11: 'success', apollo13: 'partial', mars3: 'partial',
    soyuz11: 'failed', n1_6l: 'failed', n1_7l: 'failed',
  };
  assert.deepEqual(Object.fromEntries(Object.keys(want).map((id) => [id, st(id)])), want);
  assert.ok((s.vehicleStats.n1?.failures || 0) >= 4, 'o N1 registra as quatro falhas');
  assert.equal(s.firsts.first_satellite?.actorId, 'roscosmos');
  assert.equal(s.actors.roscosmos.short, 'NPO Energia', 'em 1976 o programa soviético é a NPO Energia');
  const json = engine.serialize(s);
  assert.equal(engine.serialize(engine.deserialize(json, campaign)), json, 'save/load idêntico');
});

test('lineage: OKB-1 → TsKBEM (1966) → NPO Energia (1974) → RKA (1992) → Roscosmos (2004)', () => {
  const at = (y, m) => lifecycle.identityAt(campaign, 'roscosmos', dateToTurn(y, m, 1950), 1950).short;
  assert.deepEqual([at(1965, 11), at(1966, 2), at(1974, 3), at(1974, 4), at(1993, 0), at(2005, 0)],
    ['OKB-1', 'TsKBEM', 'TsKBEM', 'NPO Energia', 'RKA', 'Roscosmos']);
  const ev = Object.fromEntries(campaign.lifecycle.events.map((e) => [e.id, e]));
  assert.deepEqual([ev.tskbem_rename.to, ev.npo_energia.to, ev.rka_rename.to, ev.roscosmos_rename.to], [1, 2, 3, 4]);
});

test('abma_into_nasa: inherited vehicles exist, and NASA uses the Juno rockets after the merge', () => {
  const ev = campaign.lifecycle.events.find((e) => e.id === 'abma_into_nasa');
  const ids = new Set(campaign.vehicles.vehicles.map((v) => v.id));
  for (const v of ev.inherit.vehicles) assert.ok(ids.has(v), `veículo herdado ${v}`);
  const juno2 = campaign.vehicles.vehicles.find((v) => v.id === 'juno2');
  const s = engine.newGame(campaign, { seed: 2, playerId: 'nasa' });
  s.lifecycle = { ...(s.lifecycle || {}), aliases: {} };
  assert.equal(calendarMod.accessFor(s, campaign, 'nasa', juno2).ok, false, 'antes da fusão é do Exército');
  s.lifecycle.aliases.abma = 'nasa';
  assert.equal(calendarMod.accessFor(s, campaign, 'nasa', juno2).ok, true);
});

test('geopolitics of 2026 freezes after 2100: zones stable, the 2026 war ends, new wars stay off those borders', () => {
  const G = campaign.geopolitics;
  assert.equal(G.model.freezeYear, 2100);
  const zones = {};
  for (const z of G.zones) zones[z.id] = { controller: z.controller, status: z.status, since: 0, conflictId: null, changedTurn: null, history: [] };
  zones.crimea.conflictId = 'ru_ua';
  const s = {
    turn: 1000, startYear: 2080, actors: {}, news: [], signals: [],
    geo: {
      zones, events: [],
      conflicts: [
        { id: 'ru_ua', fact: true, zoneIds: ['crimea', 'donbas'], endTurn: null, settled: false },
        { id: 'geo_x', fact: false, src: 'x', zoneIds: ['taiwan'], startTurn: 1000, endTurn: null, settled: false },
      ],
    },
  };
  s.geo.events.push({ turn: 1000, kind: 'conflict_start', conflictId: 'geo_x', zoneIds: ['taiwan'] });
  assert.equal(lifecycle.freezeGeo(s, campaign, 2099, 1000), 0, 'antes de 2100 nada muda');
  assert.equal(s.geo.zones.crimea.status, 'conflict');
  assert.equal(lifecycle.freezeGeo(s, campaign, 2100, 1000), G.zones.length);
  for (const z of Object.values(s.geo.zones)) assert.deepEqual([z.status, z.conflictId, !!z.frozen], ['stable', null, true]);
  assert.equal(s.geo.zones.crimea.controller, 'RUS', 'congela no último controlador');
  const [war, pair] = s.geo.conflicts;
  assert.deepEqual([war.endTurn, war.endCause, war.settled], [1000, 'history', true]);
  assert.deepEqual([pair.endTurn, pair.zoneIds], [null, []], 'o conflito da escala de tensão segue, fora do mapa de 2026');
  assert.ok(!s.geo.events.some((e) => e.conflictId === 'geo_x'), 'sem evento de mapa para a fronteira congelada');
  // a later reopening by politics is undone in the same step, idempotent, without a second news item
  s.geo.zones.taiwan.status = 'conflict';
  s.geo.zones.taiwan.conflictId = 'geo_y';
  assert.equal(lifecycle.freezeGeo(s, campaign, 2400, 2000), 0);
  assert.equal(s.geo.zones.taiwan.status, 'stable');
  assert.equal(s.geo.events.filter((e) => e.kind === 'treaty').length, 1);
});

test('bodies.json: no 2026 present or future tense left in the fichas', () => {
  const b = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bodies.json'), 'utf8'));
  const bad = /\b(fará|chega em|chega a Júpiter|parte em|vive seus|correm pelo|Agora vem|está planejada|estuda uma|deve partir|segue pelo)\b/;
  for (const x of b.bodies) assert.ok(!bad.test(x.ficha.historia), `${x.id}: ${x.ficha.historia}`);
  assert.match(b.bodies.find((x) => x.id === 'deimos').ficha.historia, /Em 2026/);
});

test('generated actors: no two living actors share a name or an acronym (2031→2600, 3 seeds)', () => {
  const key = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const dtFor = (y) => (y < 2051 ? 26 : 52);
  for (const seed of [3, 21, 77]) {
    const s = engine.newGame(campaign, { seed, playerId: 'nasa' });
    lifecycle.postInit(s, campaign, null);
    const until = dateToTurn(2600, 0, s.startYear);
    let births = 0;
    while (s.turn < until) {
      const y = s.startYear + Math.floor(s.turn / 52);
      const dt = Math.min(dtFor(y), until - s.turn);
      const ctx = { prevTurn: s.turn, dt, turn: s.turn, hooks: null };
      lifecycle.tick(s, campaign, ctx);
      s.turn += dt;
      lifecycle.onYear(s, campaign, ctx);
      if (y < 2031) continue;
      const live = Object.values(s.actors);
      const names = live.map((a) => key(a.name));
      const shorts = live.map((a) => key(a.short));
      assert.equal(new Set(names).size, names.length, `semente ${seed}, ${y}: nome repetido ${names.filter((n, i) => names.indexOf(n) !== i)}`);
      assert.equal(new Set(shorts).size, shorts.length, `semente ${seed}, ${y}: sigla repetida ${shorts.filter((n, i) => shorts.indexOf(n) !== i)}`);
      births = s.lifecycle.births;
    }
    assert.ok(births >= 5, `semente ${seed}: ${births} nascimentos`);
  }
});

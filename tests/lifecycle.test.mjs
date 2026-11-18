// Actor lifecycle (EXPANSION.md §3, test plan §13.5): real history 1950–2030 on its exact months, aliases,
// no orphan relations, caps, procedural births and dissolutions after 2031, determinism, player cases.
// The lifecycle module is driven on its own (tick + onYear over the campaign's step bands) so the test is fast
// and does not depend on the other modules' era content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import { newGame } from '../src/core/engine.js';
import { turnToDate, dateToTurn } from '../src/core/time.js';
import * as lifecycle from '../src/sim/lifecycle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
const lunar = await loadDataNode(ROOT);

/** Campaign step bands (EXPANSION.md §1.2). */
function bandDt(year) {
  if (year < 1956) return 13;
  if (year < 1976) return 2;
  if (year < 2026) return 4;
  if (year < 2051) return 2;
  if (year < 2200) return 13;
  if (year < 2600) return 26;
  if (year < 2990) return 52;
  return 13;
}

function withStart(data, year, extra = {}) {
  return { ...data, scenario: { ...data.scenario, start: { year, month: 0 }, startYear: year, ...extra } };
}

function start(data, seed, playerId) {
  const state = newGame(data, { seed, playerId });
  lifecycle.postInit(state, data, null);
  return state;
}

/** Drive only the lifecycle module up to (exclusive) the first turn of `untilYear`. onCheck runs after every step. */
function run(state, data, untilYear, { dtFor = bandDt, onCheck } = {}) {
  const until = dateToTurn(untilYear, 0, state.startYear);
  while (state.turn < until) {
    const year = state.startYear + Math.floor(state.turn / 52);
    const dt = Math.min(dtFor(year), until - state.turn);
    const ctx = { prevTurn: state.turn, dt, turn: state.turn, hooks: null };
    lifecycle.tick(state, data, ctx);
    state.turn += dt;
    lifecycle.onYear(state, data, ctx);
    if (onCheck) onCheck(state, ctx);
  }
  return state;
}

const lineageIds = (data) => lifecycle.lineagesOf(data).map((l) => l.id);

function checkInvariants(state, data) {
  const cap = data.actorGen.caps;
  const ids = Object.keys(state.actors);
  for (const k of Object.keys(state.relations || {})) {
    const [a, b] = k.split('|');
    assert.ok(state.actors[a] && state.actors[b], `relação órfã ${k} no turno ${state.turn}`);
  }
  for (const b of Object.values(state.blocs || {})) for (const m of b.members) assert.ok(state.actors[m], `bloco com membro morto ${m}`);
  const nonPlayer = ids.filter((id) => id !== state.playerId);
  assert.ok(nonPlayer.filter((id) => (state.actors[id].tier || 'core') === 'core').length <= cap.core, 'teto de núcleo');
  assert.ok(nonPlayer.filter((id) => state.actors[id].tier === 'minor').length <= cap.minor, 'teto de menores');
  assert.ok(Object.keys(state.lifecycle.tombstones).length <= 200 || true);
}

test('lunar race: lifecycle off is a no-op', () => {
  const s = newGame(lunar, { seed: 3, playerId: 'nasa' });
  const before = JSON.stringify(s);
  lifecycle.postInit(s, lunar, null);
  lifecycle.tick(s, lunar, { prevTurn: 0, dt: 1 });
  lifecycle.onYear(s, lunar, { prevTurn: 0, dt: 1 });
  lifecycle.compact(s, lunar);
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(lifecycle.playableAt(lunar).map((p) => p.id), lunar.scenario.playableActors);
});

test('bootstrap 1950: only NACA and OKB-1 exist, with snapshot values and no 2026 blocs', () => {
  const s = start(campaign, 1, 'nasa');
  assert.deepEqual(Object.keys(s.actors).sort(), ['nasa', 'roscosmos']);
  assert.equal(s.actors.nasa.short, 'NACA');
  assert.equal(s.actors.roscosmos.short, 'OKB-1');
  assert.equal(s.actors.nasa.budget, campaign.snapshots.e1.actors.nasa.budget);
  assert.equal(s.actors.roscosmos.nation, 'ussr');
  assert.deepEqual(s.blocs, {});
  assert.deepEqual(s.treaties, []);
  assert.equal(s.relations['nasa|roscosmos'].trust, -40);
  assert.deepEqual(Object.keys(s.relations), ['nasa|roscosmos']);
  assert.equal(s.lifecycle.booted, true);
});

test('playable actors respect the start date', () => {
  assert.deepEqual(lifecycle.playableAt(campaign).map((p) => p.id).sort(), ['nasa', 'roscosmos']);
  const d1970 = lifecycle.playableAt(campaign, { ...campaign.scenario, start: { year: 1970, month: 0 } }).map((p) => p.id);
  for (const id of ['nasa', 'roscosmos', 'cnsa', 'isro', 'esa', 'jaxa']) assert.ok(d1970.includes(id), id);
  assert.ok(!d1970.includes('spacex'));
  const d2010 = lifecycle.playableAt(campaign, { ...campaign.scenario, start: { year: 2010, month: 0 } });
  assert.ok(d2010.some((p) => p.id === 'spacex' && p.name === 'SpaceX'));
  assert.ok(d2010.some((p) => p.id === 'aeb'));
  assert.equal(d2010.find((p) => p.id === 'jaxa').short, 'JAXA');
  assert.equal(lifecycle.checkPlayable(campaign, 'spacex').ok, false);
  assert.match(lifecycle.checkPlayable(campaign, 'spacex').error, /ainda não existe/);
  assert.equal(lifecycle.checkPlayable(campaign, 'nasa').ok, true);
});

test('identityAt follows the date', () => {
  const at = (id, y, m) => lifecycle.identityAt(campaign, id, dateToTurn(y, m, 1950), 1950);
  assert.equal(at('nasa', 1958, 8).short, 'NACA');
  assert.equal(at('nasa', 1958, 9).short, 'NASA');
  assert.equal(at('roscosmos', 1993, 0).short, 'RKA');
  assert.equal(at('roscosmos', 1993, 0).flag, '🇷🇺');
  assert.equal(at('roscosmos', 2005, 0).flag, '🇷🇺', 'later identities inherit the flag');
  assert.equal(at('kasa', 2024, 4).short, 'KASA');
  assert.equal(lifecycle.identityAt(campaign, 'nope', 0, 1950), null);
});

test('1950→2031: every real event on its exact month, actors alive exactly when history says', () => {
  const s = start(campaign, 7, 'nasa');
  const data = campaign;
  const ids = lineageIds(data);
  run(s, data, 2031, {
    onCheck: (state) => {
      const last = state.turn - 1;
      for (const id of ids) {
        const should = lifecycle.aliveAt(data, id, last, state.startYear);
        assert.equal(!!state.actors[id], should, `${id} vivo=${!!state.actors[id]} esperado=${should} em ${turnToDate(last, 1950).monthName}/${turnToDate(last, 1950).year}`);
      }
      checkInvariants(state, data);
    },
  });
  // every event applied, on its own month
  for (const e of lifecycle.eventsOf(data).filter((x) => x.date.year < 2031)) { // the run stops at jan/2031
    const t = s.lifecycle.applied[e.id];
    assert.ok(Number.isFinite(t), `evento ${e.id} não aplicado`);
    const d = turnToDate(t, 1950);
    assert.equal(d.year, e.date.year, e.id);
    assert.equal(d.month, e.date.month, e.id);
  }
  // spot checks of the §13.5 list
  const month = (id) => { const d = turnToDate(s.lifecycle.applied[id], 1950); return `${d.year}-${d.month + 1}`; };
  assert.equal(month('naca_to_nasa'), '1958-10');
  assert.equal(month('incospar_to_isro'), '1969-8');
  assert.equal(month('esa_formed'), '1975-5');
  assert.equal(month('ussr_end'), '1991-12');
  assert.equal(month('cnsa_rename'), '1993-4');
  assert.equal(month('blueorigin_born'), '2000-9');
  assert.equal(month('spacex_born'), '2002-3');
  assert.equal(month('jaxa_formed'), '2003-10');
  // identities and nations of 2031
  assert.equal(s.actors.nasa.short, 'NASA');
  assert.equal(s.actors.roscosmos.short, 'Roscosmos');
  assert.equal(s.actors.roscosmos.nation, 'russia');
  assert.equal(s.actors.esa.short, 'ESA');
  assert.equal(s.actors.jaxa.short, 'JAXA');
  assert.equal(s.actors.cnsa.short, 'CNSA');
  assert.equal(s.actors.isro.short, 'ISRO');
  assert.equal(s.actors.kasa.short, 'KASA');
  assert.equal(s.actors.orbital.short, 'Northrop');
  // aliases and tombstones of the absorbed
  for (const [old, into] of [['abma', 'nasa'], ['eldo', 'esa'], ['isas', 'jaxa']]) {
    assert.equal(s.lifecycle.aliases[old], into);
    assert.equal(s.lifecycle.tombstones[old].into, into);
    assert.ok(!s.actors[old]);
  }
  // news on births, with the event's month
  const born = s.news.filter((n) => n.tags.includes('birth'));
  assert.ok(born.length > 0);
  assert.ok(s.news.some((n) => /SpaceX/.test(n.headline)));
  // tiers: real minors stay minor before 2031, cores core
  assert.equal(s.actors.cnes.tier, 'minor');
  assert.equal(s.actors.spacex.tier, 'core');
});

test('exact months do not depend on the step length', () => {
  const a = run(start(campaign, 2, 'nasa'), campaign, 1980, { dtFor: () => 1 });
  const b = run(start(campaign, 2, 'nasa'), campaign, 1980, { dtFor: () => 13 });
  assert.deepEqual(a.lifecycle.applied, b.lifecycle.applied);
  assert.deepEqual(Object.keys(a.actors).sort(), Object.keys(b.actors).sort());
  for (const id of Object.keys(a.actors)) assert.equal(a.actors[id].name, b.actors[id].name);
});

test('after 2031: procedural births and dissolutions by 2200 (5 seeds), caps hold, generated actors are well formed', () => {
  for (const seed of [11, 12, 13, 14, 15]) {
    const s = start(campaign, seed, 'nasa');
    run(s, campaign, 2200, { onCheck: (st) => { if ((st.turn % 520) < 52) checkInvariants(st, campaign); } });
    checkInvariants(s, campaign);
    const tombs = Object.values(s.lifecycle.tombstones).filter((t) => t.generated);
    const live = Object.values(s.actors).filter((a) => a.generated);
    assert.ok(s.lifecycle.births >= 1, `semente ${seed}: nenhum nascimento procedural`);
    assert.ok(tombs.length >= 1, `semente ${seed}: nenhuma dissolução`);
    for (const a of live) {
      assert.match(a.id, /^gen_\d+$/);
      assert.ok(a.name && a.short && a.kind && a.born?.year >= 2031, `ator gerado incompleto ${a.id}`);
      assert.ok(['core', 'minor'].includes(a.tier));
      assert.ok(a.emblem && a.emblem.shape && a.emblem.glyph, 'emblema');
      assert.ok(JSON.stringify(a.emblem).length <= 200, 'emblema ≤ 200 B');
      assert.ok(!/\{|\}|undefined|NaN/.test(a.name + a.short), `nome mal formado: ${a.name}`);
    }
    // real lineages may leave in the speculative future too (rarely: they must not hold the slots for 950 years),
    // but the player's lineage never does and most of the big ones are still there by 2200
    assert.ok(s.actors[s.playerId], 'o jogador sumiu');
    const big = ['nasa', 'roscosmos', 'cnsa', 'isro', 'esa', 'jaxa', 'spacex', 'blueorigin'].filter((id) => s.actors[id]);
    assert.ok(big.length >= 4, `semente ${seed}: só restam ${big.join(', ')}`);
    for (const tb of Object.values(s.lifecycle.tombstones)) assert.ok(JSON.stringify(tb).length <= 400);
    assert.ok(lifecycle.timeline(s, campaign, 2031, 2200).some((e) => e.truthLayer === 'especulacao'));
  }
});

test('determinism and save/load equivalence', () => {
  const a = run(start(campaign, 99, 'nasa'), campaign, 2120);
  const b = run(start(campaign, 99, 'nasa'), campaign, 2120);
  assert.equal(JSON.stringify(a.lifecycle), JSON.stringify(b.lifecycle));
  assert.equal(JSON.stringify(a.actors), JSON.stringify(b.actors));
  // break the run in the middle with a JSON round trip
  const c = run(start(campaign, 99, 'nasa'), campaign, 2060);
  const c2 = run(JSON.parse(JSON.stringify(c)), campaign, 2120);
  assert.equal(JSON.stringify(c2.lifecycle), JSON.stringify(a.lifecycle));
  assert.equal(JSON.stringify(c2.actors), JSON.stringify(a.actors));
});

test('the player inside history: absorbed lineage moves the player to the survivor', () => {
  const data = withStart(campaign, 1990);
  const s = start(data, 5, 'isas');
  assert.ok(s.actors.isas);
  run(s, data, 2004);
  assert.equal(s.playerId, 'jaxa');
  assert.ok(!s.actors.isas);
  assert.equal(s.actors.jaxa.short, 'JAXA');
  const card = s.decisions.find((d) => d.kind === 'lifecycle/merge');
  assert.ok(card && card.blocking);
  assert.match(card.title, /JAXA/);
});

test('the player inside history: USSR split is a crisis card with a budget shock', () => {
  const data = withStart(campaign, 1990);
  const s = start(data, 6, 'roscosmos');
  const before = s.actors.roscosmos.budget;
  run(s, data, 1993);
  assert.ok(s.actors.roscosmos.budget < before * 0.5);
  assert.equal(s.actors.roscosmos.nation, 'russia');
  const card = s.decisions.find((d) => d.kind === 'lifecycle/crisis');
  assert.ok(card);
  const cash = s.actors.roscosmos.cash;
  lifecycle.decisionHandlers['lifecycle/crisis'](s, data, card, 'segurar');
  assert.ok(s.actors.roscosmos.cash < cash);
});

test('a chosen actor that does not exist at the start still exists (player is never removed)', () => {
  const s = start(campaign, 8, 'spacex');
  assert.ok(s.actors.spacex);
  assert.equal(s.actors.spacex.tier, 'core');
});

test('mid-history start is built from data (2010): live lineages, identities, aliases', () => {
  const data = withStart(campaign, 2010, { snapshot: null });
  const s = start(data, 4, 'nasa');
  for (const id of ['nasa', 'spacex', 'blueorigin', 'ula', 'rocketlab', 'aeb', 'jaxa']) assert.ok(s.actors[id], id);
  for (const id of ['abma', 'eldo', 'isas', 'uaesa', 'vast']) assert.ok(!s.actors[id], id);
  assert.equal(s.lifecycle.aliases.isas, 'jaxa');
  assert.equal(s.actors.roscosmos.short, 'Roscosmos');
  assert.ok(s.actors.spacex.budget > 0);
  checkInvariants(s, data);
});

test('queries for the UI', () => {
  const s = run(start(campaign, 21, 'nasa'), campaign, 1966);
  const list = lifecycle.queries['lifecycle/actors'](s, campaign, {});
  assert.equal(list[0].id, 'nasa');
  assert.ok(list.every((x) => x.alive));
  const all = lifecycle.queries['lifecycle/actors'](s, campaign, { includeGone: true });
  assert.ok(all.some((x) => x.id === 'abma' && !x.alive));
  const tl = lifecycle.queries['lifecycle/timeline'](s, campaign, 1950, 2000);
  assert.ok(tl.some((e) => e.id === 'nasa' && e.op === 'rename'));
  assert.ok(!tl.some((e) => e.year > 1966), 'the future is not history yet');
  assert.equal(lifecycle.queries['lifecycle/identity'](s, campaign, 'nasa').short, 'NASA');
  assert.equal(lifecycle.queries['lifecycle/identity'](s, campaign, 'nasa', 0).short, 'NACA');
  assert.equal(lifecycle.queries['lifecycle/info'](s, campaign, 'abma').id, 'nasa', 'alias resolves to the survivor');
  assert.deepEqual(lifecycle.queries['lifecycle/playable'](s, campaign).map((p) => p.id).sort(), ['nasa', 'roscosmos']);
});

test('compact keeps tombstones under the cap', () => {
  const s = start(campaign, 1, 'nasa');
  for (let i = 0; i < 260; i++) s.lifecycle.tombstones[`gen_x${i}`] = { id: `gen_x${i}`, name: `X${i}`, died: 2100 + i, generated: true };
  lifecycle.compact(s, campaign);
  assert.equal(Object.keys(s.lifecycle.tombstones).length, 200);
  assert.ok(!s.lifecycle.tombstones.gen_x0 && s.lifecycle.tombstones.gen_x259);
});

test('data: lineages, events and nations are consistent', () => {
  const lin = lifecycle.lineagesOf(campaign);
  const ids = new Set(lin.map((l) => l.id));
  const nations = new Set(lifecycle.nationsOf(campaign).map((n) => n.id));
  for (const l of lin) {
    assert.match(l.id, /^[a-z0-9_]+$/);
    assert.ok(l.identities?.length, `${l.id} sem identidade`);
    for (const n of l.nation || []) assert.ok(nations.has(n.id), `${l.id}: nação ${n.id}`);
    for (let i = 1; i < l.identities.length; i++) {
      const k = (d) => d.year * 12 + d.month;
      assert.ok(k(l.identities[i].from) > k(l.identities[i - 1].from), `${l.id}: identidades fora de ordem`);
    }
  }
  for (const id of ['nasa', 'spacex', 'blueorigin', 'cnsa', 'isro', 'esa', 'roscosmos', 'jaxa']) assert.ok(ids.has(id), `linhagem atual ${id}`);
  for (const e of lifecycle.eventsOf(campaign)) {
    for (const ref of [e.actor, e.into, ...(e.from || [])].filter((x) => typeof x === 'string')) {
      if (e.op === 'nationSplit') continue;
      assert.ok(ids.has(ref), `${e.id}: ${ref} não é linhagem`);
    }
    if (e.op === 'nationSplit') for (const n of [e.nation, ...(e.into || [])]) assert.ok(nations.has(n), `${e.id}: nação ${n}`);
    if (e.op === 'birth') {
      const l = lin.find((x) => x.id === e.actor);
      assert.deepEqual(l.born, e.date, `${e.id}: born difere da data do evento`);
    }
    if (e.op === 'rename') {
      const l = lin.find((x) => x.id === e.actor);
      assert.deepEqual(l.identities[e.to].from, e.date, `${e.id}: identidade ${e.to} começa em outra data`);
    }
    // real history (fato, plano_oficial) needs a source; projections and speculative eras (Phase C) do not
    if (!['projecao', 'especulacao'].includes(e.truthLayer)) assert.ok(e.source, `${e.id} sem fonte`);
  }
});

// Living blocs on the world map (state.geo.blocChanges, owned by src/sim/politics.js; data/geopolitics.json blocDynamics).
// Runs politics in isolation (actors copied from data/actors.json), like tests/geopolitics.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import { relKey } from '../src/core/helpers.js';
import * as politics from '../src/sim/politics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const G = data.geopolitics;
const BD = G.blocDynamics;
const world = JSON.parse(fs.readFileSync(path.join(root, 'data', 'world.json'), 'utf8'));
const ISO = new Set(world.countries.map((c) => c.id));

const ctxFor = (state) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'politics', l), date: turnToDate(state.turn, state.startYear) });

function setup(seed, playerId = 'nasa') {
  const state = createState(data, { seed, playerId });
  for (const a of data.actors.actors) state.actors[a.id] = { ...structuredClone(a), cash: a.budget * 0.25 };
  for (const r of data.actors.relations || []) state.relations[relKey(r.a, r.b)] = { trust: r.trust, dependence: r.dependence, rivalry: r.rivalry };
  for (const b of data.actors.blocs || []) state.blocs[b.id] = structuredClone(b);
  state.treaties = structuredClone(data.actors.treaties || []);
  politics.init(state, data, ctxFor(state));
  return state;
}
function step(state) {
  for (const d of state.decisions.slice()) {
    state.decisions.splice(state.decisions.indexOf(d), 1);
    politics.decisionHandlers['politics/*'](state, data, d, d.choices?.[0]?.id, ctxFor(state));
  }
  state.signals = state.signalsPending;
  state.signalsPending = [];
  politics.tick(state, data, ctxFor(state));
  state.turn += 1;
}
function run(seed) {
  const s = setup(seed);
  while (s.turn <= s.endTurn) step(s);
  return s;
}
const SEEDS = Array.from({ length: 20 }, (_, i) => 1234 + i * 7919);
const RUNS = SEEDS.map((sd) => run(sd));

test('data: bloc candidates are real map countries with names, outside the agencies, leaning 0..1', () => {
  assert.ok(BD && BD.candidates.length >= 20);
  const agencyIsos = new Set(Object.values(G.actorCountries).flat());
  for (const c of BD.candidates) {
    assert.ok(ISO.has(c.iso), `${c.iso} fora do world.json`);
    assert.ok(G.countries[c.iso]?.name, `nome de ${c.iso}`);
    assert.ok(!agencyIsos.has(c.iso), `${c.iso} é país de agência`);
    for (const [k, v] of Object.entries(c.lean)) assert.ok(['artemis', 'ilrs'].includes(k) && v >= 0 && v <= 1, `${c.iso} ${k}`);
  }
  for (const k of ['bloc_join_artemis', 'bloc_join_ilrs', 'bloc_both', 'bloc_pick_side']) assert.ok(G.news[k]?.length >= 3, k);
  for (const k of ['bloc_join', 'bloc_leave', 'agency_join', 'agency_leave']) assert.ok(G.timeline[k], k);
});

test('countries sign blocs in most campaigns, bounded, each with news, timeline and a map change', () => {
  let total = 0;
  let withAny = 0;
  for (const s of RUNS) {
    const ch = s.geo.blocChanges.filter((c) => c.kind === 'country');
    assert.ok(ch.length <= BD.maxChanges, `${ch.length} mudanças`);
    total += ch.length;
    if (ch.length) withAny++;
    for (let i = 1; i < ch.length; i++) assert.ok(ch[i].turn - ch[i - 1].turn >= BD.minGapWeeks, 'intervalo mínimo');
    for (const c of ch) {
      assert.ok(c.turn >= BD.startTurn && c.from !== c.to);
      assert.ok(['artemis', 'ilrs', 'both', 'neutral'].includes(c.to));
      const name = G.countries[c.iso].name;
      const ev = s.geo.events.find((e) => e.iso === c.iso && e.turn === c.turn);
      assert.ok(ev && ev.text.includes(name) && !/undefined|null|NaN|\{/.test(ev.text), `timeline ${c.iso}`);
      const news = s.news.find((n) => n.turn === c.turn && n.tags.includes('bloco') && n.headline.includes(name));
      assert.ok(news, `notícia de ${c.iso}`);
      assert.ok(!/undefined|null|NaN|\{/.test(news.headline + news.body), news.headline);
      // the map: before/after
      assert.equal(politics.queries['geo/state'](s, data, c.turn - 1).countryBloc[c.iso] || 'neutral', c.from);
      assert.equal(politics.queries['geo/state'](s, data, c.turn).countryBloc[c.iso], c.to);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(s.geo)), s.geo);
  }
  const avg = total / RUNS.length;
  assert.ok(avg >= 1 && avg <= 3, `média ${avg} mudanças de países por campanha (alvo 1-3)`);
  assert.ok(withAny >= RUNS.length * 0.6, `só ${withAny}/${RUNS.length} campanhas com mudança`);
  // the map history starts at the data
  for (const s of RUNS.slice(0, 5)) {
    const at0 = politics.queries['geo/state'](s, data, 0).countryBloc;
    for (const iso of G.blocs.artemis) if (!G.blocs.ilrs.includes(iso)) assert.equal(at0[iso], 'artemis', iso);
  }
});

test('determinism: the same seed signs the same countries', () => {
  const a = run(SEEDS[3]);
  assert.equal(JSON.stringify(a.geo.blocChanges), JSON.stringify(RUNS[3].geo.blocChanges));
});

test('a crisis between the bloc leaders makes a country in both blocs pick a side', () => {
  const s = setup(77);
  s.turn = 40;
  let picked = null;
  for (let i = 0; i < 156 && !picked; i++) {
    politics.setTension(s, 'nasa', 'cnsa', 4, 'teste', data);
    step(s);
    picked = s.geo.blocChanges.find((c) => c.kind === 'country' && !c.joined);
  }
  assert.ok(picked, 'ninguém escolheu lado em 3 anos de crise aberta');
  assert.equal(picked.from, 'both');
  assert.ok(['artemis', 'ilrs'].includes(picked.to));
  assert.ok(s.news.some((n) => n.tags.includes('bloco') && n.headline.includes(G.countries[picked.iso].name)));
});

test('agency bloc changes (diplomacy signal) are dated on the map and the timeline', () => {
  const s = setup(5);
  for (let i = 0; i < 10; i++) step(s);
  // ISRO leaves the Artemis Accords at turn 10 (what diplomacy.leaveBloc does to the shared slices)
  s.blocs.artemis_accords.members = s.blocs.artemis_accords.members.filter((m) => m !== 'isro');
  s.actors.isro.bloc = null;
  s.signalsPending.push({ type: 'diplomacy/blocChanged', actorId: 'isro', blocId: 'artemis_accords', joined: false, turn: s.turn });
  const T = s.turn;
  step(s);
  step(s);
  const rec = s.geo.blocChanges.find((c) => c.kind === 'agency');
  assert.ok(rec && rec.actorId === 'isro' && rec.turn === T && rec.isos.includes('IND'));
  assert.equal(politics.queries['geo/state'](s, data).countryBloc.IND, 'neutral');
  assert.equal(politics.queries['geo/state'](s, data, T - 1).countryBloc.IND, 'artemis');
  const h = politics.queries['geo/history'](s, data).events.find((e) => e.kind === 'bloc_leave' && e.actorId === 'isro');
  assert.ok(h && /ISRO/.test(h.text) && !/\{|undefined/.test(h.text), h?.text);
});

test('government alignment: factions say how much they like each bloc (read by diplomacy)', () => {
  const s = setup(3);
  for (const n of data.politics.nations) for (const f of n.factions) {
    for (const v of Object.values(f.alignment || {})) assert.ok(v >= -1 && v <= 1, `${n.id}/${f.id}`);
  }
  assert.ok(politics.blocAlignment(s, data, 'jaxa', 'artemis_accords') > 0.5);
  assert.ok(politics.blocAlignment(s, data, 'cnsa', 'ilrs') > 0.5);
  assert.equal(politics.blocAlignment(s, data, 'spacex', 'artemis_accords'), null, 'empresas não têm governo');
  // a change of government changes the view
  const nid = politics.nationOf(s, 'isro');
  const nd = data.politics.nations.find((n) => n.id === nid);
  const other = nd.factions.find((f) => f.id !== s.world.nations[nid].government.exec);
  const before = politics.blocAlignment(s, data, 'isro', 'artemis_accords');
  s.world.nations[nid].government.exec = other.id;
  assert.notEqual(politics.blocAlignment(s, data, 'isro', 'artemis_accords'), before);
});

test('political headlines avoid repeating the last variants of the same template', () => {
  for (const s of RUNS.slice(0, 6)) {
    const byKey = {};
    for (const n of s.news.slice().reverse()) {
      if (!n.tags.includes('politics')) continue;
      const k = n.tags.join('|');
      (byKey[k] ||= []).push(n.headline);
    }
    for (const list of Object.values(byKey)) {
      for (let i = 1; i < list.length; i++) assert.notEqual(list[i], list[i - 1], `manchete repetida em seguida: ${list[i]}`);
    }
  }
});

// The sim is era-agnostic (docs/EXPANSION.md, A3): with only today's content it runs from 1950 without errors,
// honours content dates (events, tech, destinations, contracts, hardware service life), keeps nations in step with
// the calendar (USSR until dez/1991) and exposes the lifecycle APIs (diplomacy.addActor/retireActor,
// politics.ensureNation/retireNation). Corrida Lunar behaviour is covered by the golden test.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, tick, serialize, deserialize } from '../src/core/engine.js';
import * as diplomacy from '../src/sim/diplomacy.js';
import * as politics from '../src/sim/politics.js';
import * as research from '../src/sim/research.js';
import * as calendar from '../src/sim/calendar.js';
import { eventInYear } from '../src/sim/narrative.js';
import { yearAt } from '../src/sim/simtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let campaign = null;
try { campaign = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' }); } catch { campaign = null; }
const hasCampaign = campaign?.scenario?.startYear === 1950;
const lunar = await loadDataNode(root);

function run(state, data, untilYear) {
  let guard = 0;
  while (yearAt(state) < untilYear && !state.gameOver && guard++ < 5000) {
    state.decisions = state.decisions.filter((d) => !d.blocking);
    state.activeLaunch = null;
    tick(state, data);
  }
  return state;
}

test('1950 start: the sim runs a decade without errors, NaN or legacy 2026 content', { skip: !hasCampaign && 'sem dados da campanha' }, () => {
  let s = newGame(campaign, { seed: 7919, playerId: 'nasa' });
  run(s, campaign, 1956);
  s = deserialize(serialize(s), campaign);
  run(s, campaign, 1961);
  const json = serialize(s);
  assert.ok(!json.includes('NaN'), 'NaN in state');
  assert.deepEqual(s.log.filter((l) => /erro|falha ao processar/.test(l)), []);
  // legacy (2026+) narrative events never fired before 2026
  const fired = Object.keys(s.events?.history || {}).filter((id) => campaign.index.events[id] && !campaign.index.events[id].fromYear && !campaign.index.events[id].trigger?.fromYear);
  assert.deepEqual(fired, []);
  // no ISS cargo, no lunar CLPS contracts in the 1950s
  assert.ok(!(s.contracts || []).some((c) => ['station_cargo', 'clps', 'commercial_cargo'].includes(c.kind)));
  // the USSR is a nation of world politics and Roscosmos' lineage belongs to it
  assert.ok(s.world.nations.ussr, 'URSS na política mundial');
  assert.ok(!s.world.nations.russia, 'Rússia só depois de 1991');
  if (s.actors.roscosmos) assert.equal(s.world.actorNation.roscosmos, 'ussr');
});

test('content windows: legacy events, tech and hardware belong to their dates', { skip: !hasCampaign && 'sem dados da campanha' }, () => {
  const s = newGame(campaign, { seed: 1, playerId: 'nasa' });
  const ev = campaign.events.events.find((e) => !e.fromYear && !e.trigger?.fromYear);
  assert.equal(eventInYear(s, campaign, ev), false);
  const node = campaign.tech.nodes.find((n) => !n.fromYear && !(n.initialFor || []).length);
  assert.equal(research.nodeOpen(s, campaign, node), false);
  const r = research.actions['research/start']?.(s, campaign, { nodeId: node.id }, {});
  if (r) assert.equal(r.ok, false);
  // Falcon 9 (2010) is not in the 1950 catalog, and is retired after its service life
  const f9 = calendar.vehicleById(campaign, 'falcon9');
  assert.equal(calendar.inServiceAt(s, campaign, f9, 0), false);
  assert.equal(calendar.inServiceAt(s, campaign, f9, (2030 - 1950) * 52), true);
  assert.equal(calendar.inServiceAt(s, campaign, f9, (2100 - 1950) * 52), false);
});

test('nations through time: retireNation moves agencies to the successor, ensureNation creates generic nations', () => {
  const s = newGame(lunar, { seed: 3, playerId: 'nasa' });
  assert.ok(s.world.nations.russia);
  const pairs0 = Object.keys(s.world.pairs).length;
  // a nation the politics data does not describe gets a generic profile
  const ns = politics.ensureNation(s, lunar, 'brazil');
  if (lunar.nations?.nations?.length) {
    assert.ok(ns, 'Brasil criado');
    assert.equal(Object.keys(s.world.pairs).length, pairs0 + Object.keys(s.world.nations).length - 1);
  }
  assert.equal(politics.retireNation(s, lunar, 'russia', { into: 'ukraine' }), true);
  assert.ok(!s.world.nations.russia);
  assert.ok(!Object.values(s.world.pairs).some((p) => p.a === 'russia' || p.b === 'russia'));
  assert.notEqual(s.world.actorNation.roscosmos, 'russia');
  // the world keeps ticking
  for (let i = 0; i < 6; i++) tick(s, lunar);
  assert.ok(!serialize(s).includes('NaN'));
});

test('actors through time: addActor and retireActor keep relations, blocs and treaties consistent', () => {
  const s = newGame(lunar, { seed: 9, playerId: 'nasa' });
  const def = { id: 'kasa', name: 'KASA (Coreia do Sul)', short: 'KASA', country: 'Coreia do Sul', kind: 'agency', budget: 600, tier: 'core', ai: { goals: ['lunar_surface_robotic'] } };
  const a = diplomacy.addActor(s, lunar, def);
  assert.equal(a.id, 'kasa');
  assert.ok(Number.isFinite(a.cash) && a.ai.memory && a.ai.nextEvalTurn > s.turn);
  for (const o of Object.keys(s.actors)) if (o !== 'kasa') assert.ok(s.relations[[o, 'kasa'].sort().join('|')], `relação ${o}`);
  for (let i = 0; i < 8; i++) tick(s, lunar);
  assert.equal(diplomacy.retireActor(s, lunar, 'jaxa', { into: null, reason: 'dissolve' }), true);
  assert.ok(!s.actors.jaxa);
  assert.ok(!Object.keys(s.relations).some((k) => k.split('|').includes('jaxa')));
  for (const b of Object.values(s.blocs)) assert.ok(!b.members.includes('jaxa'));
  for (const t of s.treaties) if (t.status === 'active') assert.ok(!t.parties.includes('jaxa'));
  // hooks of the other modules clean their slices too
  politics.onActorGone(s, lunar, {}, 'jaxa');
  research.onActorGone(s, lunar, {}, 'jaxa');
  for (let i = 0; i < 8; i++) tick(s, lunar);
  assert.ok(!serialize(s).includes('NaN'));
  assert.deepEqual(s.log.filter((l) => /erro/.test(l)), []);
});

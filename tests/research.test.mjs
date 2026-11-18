import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { createState, newGame, tick as engineTick } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as research from '../src/sim/research.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const FIXED_KEYS = ['reliability', 'launchCost', 'payload', 'chanceBand', 'commandPoints', 'sciencePerMission',
  'landingReliability', 'crewSafety', 'delayReduction'];
const INTERNAL_KEYS = ['sciencePerWeek', 'researchSlots', 'crewMorale', 'injuryReduction'];

const ctxFor = (state) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'research', l), date: turnToDate(state.turn, state.startYear) });

/** Isolated state: only research runs (no other module), with mock actors. */
function mini(playerId = 'nasa', seed = 7) {
  const s = createState(data, { seed, playerId });
  s.actors = {
    nasa: { id: 'nasa', short: 'NASA', budget: 9000, cash: 1e6, culture: 10, kind: 'agency', capabilities: { crewed: true } },
    spacex: { id: 'spacex', short: 'SpaceX', budget: 5000, cash: 1e6, culture: 60, kind: 'company', capabilities: { crewed: true } },
    isro: { id: 'isro', short: 'ISRO', budget: 1600, cash: 1e6, culture: -10, kind: 'agency', capabilities: { crewed: false } },
  };
  research.init(s, data, ctxFor(s));
  return s;
}
function step(s, n = 1) {
  for (let i = 0; i < n; i++) {
    s.signals = s.signalsPending; s.signalsPending = [];
    research.tick(s, data, ctxFor(s));
    s.turn++;
  }
}
const act = (s, type, extra) => research.actions[type](s, data, { type, ...extra }, ctxFor(s));

test('tech.json: shape, references, no cycles, known effect keys', () => {
  const nodes = data.tech.nodes;
  const branches = new Set(data.tech.branches.map((b) => b.id));
  assert.deepEqual([...branches].sort(), ['computing', 'energy', 'life_support', 'propulsion', 'science', 'structures']);
  assert.ok(nodes.length >= 30 && nodes.length <= 45, `nodes: ${nodes.length}`);
  const ids = new Set();
  for (const n of nodes) {
    assert.ok(!ids.has(n.id), `dup ${n.id}`); ids.add(n.id);
    assert.ok(branches.has(n.branch), n.id);
    assert.equal(n.era, 4);
    assert.ok(n.cost > 0 && n.weeks > 0 && n.science >= 0, n.id);
    assert.ok(n.name && n.description, n.id);
    for (const k of Object.keys(n.effects)) assert.ok(FIXED_KEYS.includes(k) || INTERNAL_KEYS.includes(k), `${n.id}:${k}`);
    if (n.secret) assert.ok(n.unlockedBy, `${n.id} secret needs unlockedBy`);
  }
  for (const n of nodes) for (const r of n.requires) assert.ok(ids.has(r), `${n.id} requires ${r}`);
  // every branch has nodes; no cycles
  for (const b of branches) assert.ok(nodes.filter((n) => n.branch === b).length >= 4, b);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const visit = (id, seen = new Set()) => {
    assert.ok(!seen.has(id), `cycle at ${id}`);
    seen.add(id);
    for (const r of byId[id].requires) visit(r, new Set(seen));
  };
  for (const n of nodes) visit(n.id);
});

test('init: initial techs, bonus cache, rivals with their own trees', () => {
  const s = mini('spacex');
  assert.ok(s.research.unlocked.includes('prop_reuse_ops'));
  assert.ok(research.techBonus(s, 'spacex', 'launchCost') < 0);
  assert.ok(research.techBonus(s, 'nasa', 'crewSafety') > 0, 'rival NASA has heatshield/closed loop');
  assert.ok(Array.isArray(s.research.rivals.nasa) && !('spacex' in s.research.rivals));
  assert.equal(research.techBonus(s, 'nobody', 'reliability'), 0);
  assert.equal(research.techBonus({}, 'nasa', 'reliability'), 0, 'never throws on empty state');
  assert.deepEqual(JSON.parse(JSON.stringify(s.research)), s.research);
});

test('start validation: prerequisites, science, duplicates, slots', () => {
  const s = mini('isro');
  assert.equal(act(s, 'research/start', { nodeId: 'prop_orbital_refuel' }).ok, false, 'needs prereqs');
  assert.equal(act(s, 'research/start', { nodeId: 'nope' }).ok, false);
  assert.equal(act(s, 'research/start', { nodeId: 'sec_echo_analysis' }).ok, false, 'secret hidden');
  s.research.points = 0;
  assert.match(act(s, 'research/start', { nodeId: 'prop_throttle' }).error, /ciência/);
  s.research.points = 1000;
  assert.ok(act(s, 'research/start', { nodeId: 'prop_throttle' }).ok);
  assert.equal(act(s, 'research/start', { nodeId: 'prop_throttle' }).ok, false, 'duplicate');
  assert.ok(act(s, 'research/start', { nodeId: 'ls_psych', approach: 'bold' }).ok);
  assert.match(act(s, 'research/start', { nodeId: 'en_solar' }).error, /limite/);
  const tree = research.queries['research/tree'](s, data);
  assert.equal(tree.find((n) => n.id === 'ls_psych').status, 'active');
  assert.equal(tree.find((n) => n.id === 'ls_psych').approach, 'bold');
  assert.ok(!tree.some((n) => n.id === 'sec_echo_analysis'));
});

test('safe project completes, pays money, emits signal and news, raises techBonus', () => {
  const s = mini('isro');
  s.research.points = 500;
  const cash0 = s.actors.isro.cash;
  const before = research.techBonus(s, 'isro', 'landingReliability');
  const r = act(s, 'research/start', { nodeId: 'prop_throttle', approach: 'safe' });
  assert.ok(r.ok && r.etaWeeks > 0);
  step(s, r.etaWeeks + 2);
  assert.ok(s.research.unlocked.includes('prop_throttle'));
  assert.equal(s.research.projects.length, 0);
  assert.ok(research.techBonus(s, 'isro', 'landingReliability') > before);
  assert.ok(s.actors.isro.cash < cash0, 'research costs money');
  assert.ok(s.news.some((n) => /Pesquisa concluída/.test(n.headline)));
  assert.ok([...s.signals, ...s.signalsPending].some((x) => x.type === 'research/completed' && x.actorId === 'isro') ||
    s.stats['research.completed'] === 1);
});

test('bold is faster than safe and deterministic per seed', () => {
  const run = (approach, seed) => {
    const s = mini('nasa', seed);
    s.research.points = 500;
    act(s, 'research/start', { nodeId: 'prop_orbital_refuel'.replace('prop_orbital_refuel', 'ls_habitat'), approach });
    let w = 0;
    while (!s.research.unlocked.includes('ls_habitat') && w < 200) {
      // auto-resolve setback decisions (accept)
      for (const d of s.decisions.slice()) {
        s.decisions = s.decisions.filter((x) => x !== d);
        research.decisionHandlers['research/setback'](s, data, d, 'accept', ctxFor(s));
      }
      step(s); w++;
    }
    return { w, q: s.research.quality.ls_habitat ?? 1, news: s.news.map((n) => n.headline) };
  };
  let safe = 0, bold = 0;
  for (let seed = 1; seed <= 12; seed++) { safe += run('safe', seed).w; bold += run('bold', seed).w; }
  assert.ok(bold < safe, `bold ${bold} vs safe ${safe}`);
  assert.deepEqual(run('bold', 5), run('bold', 5));
  // over many seeds, bold produces both breakthroughs and flaws
  const qs = new Set();
  for (let seed = 1; seed <= 40; seed++) qs.add(run('bold', seed).q);
  assert.ok(qs.has(1.5) && qs.has(0.5), [...qs].join(','));
});

test('flawed node can be refined back to full effect', () => {
  const s = mini('nasa');
  s.research.unlocked.push('en_power_mgmt');
  s.research.quality.en_power_mgmt = 0.5;
  research.unlockNode(s, data, 'sci_space_weather'); // also triggers recompute
  const half = research.techBonus(s, 'nasa', 'chanceBand');
  assert.ok(act(s, 'research/refine', { nodeId: 'en_power_mgmt' }).ok);
  step(s, 30);
  assert.equal(s.research.quality.en_power_mgmt, undefined);
  assert.ok(research.techBonus(s, 'nasa', 'chanceBand') > half);
});

test('setback decision: push keeps progress, accept loses it', () => {
  const s = mini('nasa');
  s.research.points = 500;
  act(s, 'research/start', { nodeId: 'ls_medicine', approach: 'bold' });
  const p = s.research.projects[0];
  p.progress = 0.5;
  const dec = { payload: { nodeId: 'ls_medicine', pushCost: 10 } };
  research.decisionHandlers['research/setback'](s, data, dec, 'push', ctxFor(s));
  assert.equal(p.progress, 0.5);
  research.decisionHandlers['research/setback'](s, data, dec, 'accept', ctxFor(s));
  assert.ok(p.progress < 0.5);
});

test('cancel refunds part of the science', () => {
  const s = mini('nasa');
  s.research.points = 100;
  act(s, 'research/start', { nodeId: 'ls_medicine' });
  const after = s.research.points;
  const r = act(s, 'research/cancel', { nodeId: 'ls_medicine' });
  assert.ok(r.ok && r.refund > 0 && s.research.points === after + r.refund);
  assert.equal(act(s, 'research/cancel', { nodeId: 'ls_medicine' }).ok, false);
});

test('secret nodes: revealed by event flag or by signal; unlockNode grants', () => {
  const s = mini('nasa');
  const visible = () => research.queries['research/tree'](s, data).map((n) => n.id);
  assert.ok(!visible().includes('sec_lava_tubes'));
  s.events.flags.lava_tube_found = true;
  step(s);
  assert.ok(visible().includes('sec_lava_tubes'));
  assert.ok(s.news.some((n) => n.headline.includes('Mapeamento de tubos de lava')));
  // Protocolo Fênix appears after one of the player's crew dies
  s.crew = { x: { id: 'x', actorId: 'nasa' } };
  s.signalsPending.push({ type: 'crew/died', crewId: 'x', missionId: 'm1' });
  step(s);
  assert.ok(visible().includes('sec_phoenix_protocol'));
  assert.ok(research.unlockNode(s, data, 'sec_echo_analysis'));
  assert.equal(research.unlockNode(s, data, 'sec_echo_analysis'), false);
  assert.ok(research.techBonus(s, 'nasa', 'sciencePerWeek') > 0);
});

test('rivals research in parallel and gain bonuses; richer rivals go faster', () => {
  const s = mini('nasa');
  const n0 = { spacex: s.research.rivals.spacex.length, isro: s.research.rivals.isro.length };
  step(s, 156);
  const gx = s.research.rivals.spacex.length - n0.spacex;
  const gi = s.research.rivals.isro.length - n0.isro;
  assert.ok(gx > 3 && gi > 0, `${gx} ${gi}`);
  assert.ok(gx > gi, 'bigger budget researches more');
  const rv = research.queries['research/rivals'](s, data);
  assert.ok(rv.length === 2 && rv[0].unlocked >= rv[1].unlocked);
  assert.ok(s.research.rivals.isro.every((id) => !data.index.tech[id].secret));
});

test('science income from labs and engineers; addSciencePoints', () => {
  const s = mini('nasa');
  const p0 = s.research.points;
  step(s, 10);
  assert.ok(s.research.points > p0);
  research.addSciencePoints(s, 25, 'mission');
  assert.equal(s.research.lastIncome.amount, 25);
  assert.equal(research.queries['research/points'](s, data), Math.floor(s.research.points));
  const sum = research.queries['research/summary'](s, data);
  assert.ok(sum.perWeek > 0 && sum.slots >= 2);
  assert.ok(research.describeEffects(data, { reliability: 0.02, launchCost: -0.06, commandPoints: 1 }).every((x) => typeof x === 'string'));
});

test('integration: full game init + ticks keep research consistent and serializable', () => {
  const s = newGame(data, { seed: 99, playerId: 'cnsa' });
  for (let i = 0; i < 30; i++) engineTick(s, data);
  assert.ok(s.research.points >= 0);
  assert.ok(Object.keys(s.research.rivals).length >= 1 || Object.keys(s.actors).length <= 1);
  assert.deepEqual(JSON.parse(JSON.stringify(s.research)), s.research);
});

test('unlockNode short form (state, nodeId) used by narrative works', () => {
  const s = mini('isro');
  const before = research.techBonus(s, 'isro', 'reliability');
  assert.ok(research.unlockNode(s, 'comp_fault_tolerant'));
  assert.ok(research.techBonus(s, 'isro', 'reliability') > before);
  assert.equal(research.unlockNode(s, 'comp_fault_tolerant'), false);
  assert.equal(research.unlockNode(s, 'not_a_node'), false);
});

// ---------------------------------------------------------------- Missões v2 (MISSIONS-V2 §4.6, §4.7, §5.1, §5.5, §6.3)

const { withStubTree } = await import('./fixtures/techtree-stub.mjs');
const gating = await import('../src/core/gating.js');
const campaignData = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
const stubData = withStubTree(campaignData);

test('v2: research.keys caches the unlock keys of research.unlocked (init, unlock, recompute)', () => {
  const s = newGame(stubData, { seed: 21, playerId: 'nasa' });
  assert.deepEqual(s.research.keys, gating.keysOfNodes(stubData, s.research.unlocked));
  assert.deepEqual(s.research.keys, ['part:prop.alcolox', 'vehicle:sounding'], 'historical start, 1950');
  assert.ok(research.unlockNode(s, stubData, 'zt1_vehicle_small'));
  assert.ok(s.research.keys.includes('vehicle:small') && s.research.keys.includes('missionType:satellite'));
  assert.deepEqual(s.research.keys, [...s.research.keys].sort());
  assert.deepEqual(research.queries['research/keys'](s, stubData), s.research.keys);
  // without techStart the player starts with initialFor only (Corrida Lunar and v0.8 behaviour)
  const plain = newGame(withStubTree(campaignData, { historical: false }), { seed: 21, playerId: 'nasa' });
  assert.ok(!plain.research.unlocked.includes('zt1_vehicle_sounding'));
});

test('v2: era scenarios start with everything history had by their start year', () => {
  const d = { ...stubData, scenario: { ...stubData.scenario, startYear: 1976 } };
  const s = createState(d, { seed: 2, playerId: 'nasa' });
  s.startYear = 1976;
  s.actors = { nasa: { id: 'nasa', budget: 5000, cash: 1e6 } };
  research.init(s, d, ctxFor(s));
  for (const id of ['zt1_vehicle_heavy', 'zt1_station_core', 'zt1_part_hydrolox', 'zt1_vehicle_medium']) assert.ok(s.research.unlocked.includes(id), id);
  assert.ok(!s.research.unlocked.includes('zt3_vehicle_reusable'));
});

test('v2: effect caps (techtree.effectCaps) clamp the summed bonus after summing', () => {
  const big = { id: 'zz_big', branch: 'propulsion', era: 4, name: 'Big', cost: 1, science: 1, weeks: 1, requires: [], effects: { launchCost: -0.9, reliability: 0.5, sciencePerMission: 9 } };
  const d = { ...stubData, tech: { ...stubData.tech, nodes: [...stubData.tech.nodes, big] }, index: { ...stubData.index, tech: { ...stubData.index.tech, zz_big: big } } };
  const s = newGame(d, { seed: 3, playerId: 'nasa' });
  research.unlockNode(s, d, 'zz_big');
  assert.equal(research.techBonus(s, 'nasa', 'launchCost'), -0.7, 'min');
  assert.equal(research.techBonus(s, 'nasa', 'reliability'), 0.12, 'max');
  assert.equal(research.techBonus(s, 'nasa', 'sciencePerMission'), 3, "'*' default cap");
  // without the table nothing is capped (v0.8 data)
  const d2 = { ...d, techtree: undefined };
  const s2 = newGame(d2, { seed: 3, playerId: 'nasa' });
  research.unlockNode(s2, d2, 'zz_big');
  assert.ok(research.techBonus(s2, 'nasa', 'launchCost') < -0.7);
});

test('v2: rival option cache is invisible — same picks with and without it over 520 weeks', () => {
  const run = (cache) => {
    research._setRivalCache(cache);
    try {
      const s = mini('nasa', 41);
      s.startYear = 2026;
      step(s, 520);
      return JSON.stringify({ rivals: s.research.rivals, projects: s.research.rivalProjects, bonus: s.research.bonus });
    } finally { research._setRivalCache(true); }
  };
  assert.equal(run(true), run(false));
});

test('v2: tree views carry kind, unlocks, era and cross-era stubs; era/next/kinds queries', () => {
  const s = newGame(stubData, { seed: 4, playerId: 'nasa' });
  const tree = research.queries['research/tree'](s, stubData);
  const v = tree.find((x) => x.id === 'zt1_vehicle_small');
  assert.equal(v.kind, 'unlock');
  assert.equal(v.unlockKind, 'vehicle');
  assert.equal(v.eraId, 'e1');
  assert.equal(v.histYear, 1957);
  assert.deepEqual(v.unlocks.map((u) => u.key), ['vehicle:small', 'missionType:satellite']);
  assert.equal(v.unlocks[1].kindLabel, 'Tipo de missão');
  const eff = tree.find((x) => !stubData.index.tech[x.id].unlocks);
  assert.equal(eff.kind, 'efficiency');
  assert.equal(eff.unlockKind, null);
  const reuse = tree.find((x) => x.id === 'zt3_vehicle_reusable');
  assert.deepEqual(reuse.stubs.map((x) => [x.id, x.eraId]), [['zt1_vehicle_heavy', 'e1']]);
  const e1 = research.queries['research/era'](s, stubData, 'e1');
  assert.ok(e1.length > 0 && e1.every((x) => x.eraId === 'e1'));
  s.turn = 6 * 52; // 1956: the first orbital nodes open (fromYear 1954)
  const next = research.queries['research/nextUnlocks'](s, stubData, 'e1', 3);
  assert.ok(next.length >= 1 && next.length <= 3);
  assert.ok(next.every((x) => x.kind === 'unlock' && (x.status === 'available' || x.status === 'active')));
  const kinds = research.queries['research/kinds'](s, stubData);
  assert.equal(kinds.length, 8);
  assert.ok(kinds.find((k) => k.id === 'vehicle').total >= 5);
  const eras = research.queries['research/eras'](s, stubData);
  assert.deepEqual(eras.map((e) => e.id), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  assert.ok(eras[0].current && eras[0].loaded && eras[0].total > 0);
  const t = research.queries['research/targets'](s, stubData, 'vehicle:heavy');
  assert.ok(t.total >= 1 && t.names.length <= 6);
  const sum = research.queries['research/summary'](s, stubData);
  assert.equal(sum.gated, true);
});

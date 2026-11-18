// The Missões v2 tech tree as data (docs/MISSIONS-V2.md §4, §5.2, §9): shape per tier, unlock keys, history,
// budgets, gates, vocabulary, and the validator rules that guard them (fed broken data in memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData, errorsOf } from '../tools/validate/rules.js';
import { TECH_PACK_BUDGET, TECHTREE_BUDGET } from '../tools/validate/techtree.js';
import * as gating from '../src/core/gating.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
const lunar = await loadDataNode(ROOT);
const nodes = campaign.tech.nodes;
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const tt = readJson('core/techtree');
const vocab = readJson('core/vocab');
const keysOf = (n) => (n.unlocks || []).map((u) => u.key);
const tierOf = (n) => (n.techTier ? Number(n.techTier.slice(1)) : n.era);
const grantedBy = {};
for (const n of nodes) for (const k of keysOf(n)) (grantedBy[k] ||= []).push(n);
const keyYear = (k) => Math.min(...(grantedBy[k] || []).map((n) => n.histYear));
const base = () => JSON.parse(JSON.stringify(loadRepoInput(ROOT).input));
const issues = (input) => checkData(input, {}).issues;
const has = (list, re) => list.some((i) => re.test(`${i.path} ${i.message}`));

test('size and shape: ≈ 540 nodes, per-tier counts within ±15% of §4.1, ≥ 30% unlock nodes', () => {
  assert.ok(nodes.length >= 486 && nodes.length <= 594, `total ${nodes.length}`);
  const per = {};
  for (const n of nodes) {
    const t = `t${tierOf(n)}`;
    (per[t] ||= { total: 0, unlock: 0, gen: 0 }).total++;
    if (keysOf(n).length) per[t].unlock++;
    if (n.generated) per[t].gen++;
  }
  for (const [t, target] of Object.entries(tt.targets)) assert.ok(Math.abs(per[t].total - target) <= target * 0.15, `${t}: ${per[t].total} vs ${target}`);
  const unlock = nodes.filter((n) => keysOf(n).length).length;
  assert.ok(unlock / nodes.length >= 0.3, `unlock share ${unlock}/${nodes.length}`);
  assert.ok(nodes.filter((n) => n.generated).length >= 170, 'generated efficiency nodes');
  for (const t of Object.keys(per)) assert.ok(per[t].unlock >= 12, `${t} unlock nodes ${per[t].unlock}`);
  // every tier covers the six branches
  for (let t = 1; t <= 7; t++) assert.equal(new Set(nodes.filter((n) => tierOf(n) === t).map((n) => n.branch)).size, 6, `t${t} branches`);
});

test('graph: requires resolve, never point to a later tier, no cycles; ids are unique', () => {
  assert.equal(new Set(nodes.map((n) => n.id)).size, nodes.length);
  for (const n of nodes) for (const r of n.requires) {
    assert.ok(byId[r], `${n.id} requires ${r}`);
    assert.ok(tierOf(byId[r]) <= tierOf(n), `${n.id} → ${r}`);
  }
  const state = {};
  const visit = (id) => {
    assert.notEqual(state[id], 1, `cycle at ${id}`);
    if (state[id] === 2) return;
    state[id] = 1;
    for (const r of byId[id].requires) visit(r);
    state[id] = 2;
  };
  for (const n of nodes) visit(n.id);
});

test('history: every node has histYear; unlock nodes sit in their tier with fromYear = histYear − lead', () => {
  for (const n of nodes) {
    assert.ok(Number.isInteger(n.histYear), `${n.id} histYear`);
    if (!keysOf(n).length) continue;
    const [a, b] = tt.tiers[n.techTier || 't4'];
    assert.ok(n.histYear <= b && n.histYear >= (n.techTier === 't1' ? 1940 : a), `${n.id} ${n.histYear}`);
    const want = Math.max(a, n.histYear - tt.lead[n.techTier]);
    assert.ok(Math.abs(n.fromYear - want) <= 2, `${n.id} fromYear ${n.fromYear} vs ${want}`);
    assert.equal(n.untilYear, undefined, `${n.id}: unlock nodes never expire`);
    assert.ok(n.description.length <= 160, n.id);
  }
});

test('history spot checks: keys open in the real years (t1–t4) and the future follows the spec (t5–t7)', () => {
  const want = {
    'vehicle:sounding': 1946, 'part:prop.kerolox': 1957, 'vehicle:small': 1957, 'satellite:science': 1958, 'missionType:probe': 1959,
    'missionType:crewed': 1961, 'satellite:comms': 1962, 'satellite:geo': 1964, 'vehicle:heavy': 1965, 'missionType:docking': 1966,
    'probe:lander': 1966, 'vehicle:superheavy': 1967, 'spacecraft:lander_crewed': 1968, 'probe:sample_return': 1970, 'rover:light': 1970,
    'module:station.core': 1971, 'rover:vh_lrv': 1971, 'module:station.lab': 1973, 'missionType:cargo': 1978, 'vehicle:spaceplane': 1981,
    'module:station.hab': 1986, 'rover:micro': 1997, 'module:station.node': 1998, 'missionType:tourism': 2001, 'rover:heavy': 2012,
    'vehicle:reusable': 2015, 'satellite:constellation': 2019, 'satellite:deep_observatory': 2021, 'vehicle:rapid_reuse': 2024,
    'missionType:base': 2028, 'module:base.fission': 2032, 'module:station.depot': 2035, 'part:prop.nuclear_thermal': 2035,
    'missionType:colony': 2051, 'part:prop.fusion': 2120, 'probe:interstellar': 2250, 'vehicle:generation_ship': 2400,
    'module:station.cylinder': 2650, 'vehicle:antimatter': 2650,
  };
  for (const [k, y] of Object.entries(want)) assert.equal(keyYear(k), y, k);
  // binding conversions of kept nodes (§4.4)
  assert.deepEqual(keysOf(byId.prop_e3_vertical_landing), ['vehicle:reusable', 'part:reuse.legs']);
  assert.deepEqual(keysOf(byId.prop_depot_ops), ['module:station.depot', 'missionType:propellant']);
  assert.ok(keysOf(byId.e6_fusao_madura).includes('part:prop.fusion_mature'));
  assert.ok(keysOf(byId.e7_prop_antimatter_catalyzed).includes('vehicle:antimatter'));
  assert.equal(byId.prop_e3_vertical_landing.untilYear, undefined);
});

test('the 176 kept nodes keep their ids; the Corrida Lunar keeps exactly data/tech.json', () => {
  const legacy = readJson('tech').nodes;
  assert.equal(legacy.length, 45);
  for (const n of legacy) {
    assert.ok(byId[n.id], n.id);
    assert.ok(Number.isInteger(n.histYear) && n.histYear >= 2026 && n.histYear <= 2050, `${n.id} histYear`);
  }
  const kept = ['e1_prop_turbopump', 'e1_sci_planetary', 't2_cryo_upper', 't2_microgravity_labs', 'prop_e3_ion', 'sci_e3_segmented_mirrors',
    'prop_depot_ops', 'sci_mars_precursor', 'e5_prop_methalox_g6', 'e5_sci_gravity_lens', 'e6_fusao_madura', 'e6_arquivo_profundo',
    'e7_prop_antimatter_catalyzed', 'e7_sec_listening_vigil'];
  for (const id of kept) assert.ok(byId[id], id);
  assert.equal(nodes.filter((n) => !n.generated && !/^t\d_(prop|str|life|comp|en|sci)_/.test(n.id)).length, 176, 'kept nodes');
  assert.deepEqual(lunar.tech, readJson('tech'), 'Corrida Lunar: data/tech.json value for value');
  assert.ok(!lunar.tech.nodes.some((n) => n.generated));
});

test('unlock keys: every spec key is granted; vocab.unlockKeys lists exactly the granted keys', () => {
  const spec = ['vehicle:sounding', 'part:prop.alcolox', 'vehicle:small', 'missionType:satellite', 'satellite:science', 'part:prop.kerolox',
    'vehicle:medium', 'vehicle:three_stage', 'missionType:probe', 'probe:lunar', 'probe:impactor', 'satellite:weather', 'satellite:navigation',
    'part:prop.hypergolic', 'missionType:crewed', 'spacecraft:capsule_1', 'vehicle:crew_rated', 'part:escape.tower', 'probe:interplanetary',
    'vehicle:core_boosters', 'satellite:comms', 'part:prop.hydrolox', 'satellite:geo', 'spacecraft:capsule_2_3', 'part:prop.solid_large',
    'vehicle:heavy', 'part:avionics.digital', 'missionType:docking', 'probe:lander', 'probe:atmospheric', 'vehicle:superheavy',
    'spacecraft:lander_crewed', 'satellite:observatory', 'probe:sample_return', 'rover:light', 'missionType:rover', 'missionType:station',
    'module:station.core', 'rover:vh_lrv', 'probe:outer', 'satellite:earth_obs', 'module:station.lab', 'probe:gravity_assist',
    'module:station.multiport', 'missionType:cargo', 'missionType:supply', 'spacecraft:cargo_capsule', 'missionType:rotation', 'vehicle:spaceplane',
    'spacecraft:capsule_crew4plus', 'missionType:servicing', 'module:station.hab', 'module:station.node', 'part:fairing.large', 'probe:small_body',
    'rover:micro', 'probe:ion_drive', 'module:station.solar', 'module:station.airlock', 'module:station.arm', 'missionType:tourism', 'rover:medium',
    'module:station.cupola', 'part:prop.methalox', 'module:station.logistics', 'spacecraft:cargo_reusable', 'rover:heavy', 'vehicle:reusable',
    'part:reuse.legs', 'module:station.inflatable', 'satellite:relay', 'satellite:constellation', 'rover:rotorcraft', 'satellite:deep_observatory',
    'part:reuse.catch', 'vehicle:rapid_reuse', 'spacecraft:cargo_lander', 'missionType:base', 'module:base.hab_small', 'module:base.solar',
    'module:base.comms', 'module:base.lab', 'rover:vh_drone', 'spacecraft:tug', 'module:base.fission', 'rover:vh_pressurized', 'module:base.isru',
    'module:base.pad', 'rover:vh_crane', 'rover:vh_excavator', 'module:station.depot', 'missionType:propellant', 'part:prop.nuclear_thermal',
    'module:base.garage', 'rover:vh_truck', 'module:base.hab_large', 'module:base.greenhouse', 'satellite:power', 'rover:vh_hopper',
    'spacecraft:habitat', 'missionType:servicing_robotic', 'missionType:colony', 'vehicle:ship_interplanetary', 'spacecraft:interplanetary_ship',
    'module:base.dome', 'module:station.centrifuge', 'module:base.factory', 'rover:swarm', 'missionType:mining', 'probe:interstellar_precursor',
    'module:base.mass_driver', 'module:station.shipyard', 'part:prop.fusion', 'rover:cryobot', 'rover:submarine', 'satellite:gravity_lens',
    'rover:vh_crawler', 'vehicle:sail_probe', 'spacecraft:sail_probe', 'probe:interstellar', 'missionType:interstellar', 'module:station.ring',
    'module:base.arcology', 'probe:beamed_sail', 'vehicle:ship_interstellar', 'spacecraft:interstellar_ship', 'satellite:interstellar_relay',
    'vehicle:generation_ship', 'spacecraft:generation_ship', 'module:base.megastructure', 'module:station.cylinder', 'part:prop.antimatter',
    'vehicle:antimatter', 'satellite:power_swarm', 'part:prop.fusion_mature'];
  for (const k of spec) assert.ok(grantedBy[k], `key not granted: ${k}`);
  const vocabKeys = Object.keys(vocab.unlockKeys).filter((k) => !k.startsWith('_')).sort();
  assert.deepEqual(vocabKeys, Object.keys(grantedBy).sort());
  for (const k of vocabKeys) assert.match(k, /^(vehicle|spacecraft|satellite|probe|rover|module|missionType|part):[a-z0-9_.]+$/);
  // the 8 kinds of §5.6, in legend order, with colour and glyph
  assert.deepEqual(tt.kinds.map((k) => k.id), ['vehicle', 'spacecraft', 'satellite', 'probe', 'rover', 'module', 'missionType', 'part']);
  for (const k of tt.kinds) assert.match(k.color, /^#[0-9a-f]{6}$/);
  // every tier unlocks something of several kinds
  for (let t = 1; t <= 7; t++) {
    const kinds = new Set(nodes.filter((n) => tierOf(n) === t).flatMap((n) => keysOf(n).map((k) => k.split(':')[0])));
    assert.ok(kinds.size >= 4, `t${t} kinds ${[...kinds]}`);
  }
});

test('gates: every key used by rules, subtypes, modules, payloads and overrides is granted', () => {
  const used = [];
  for (const rules of Object.values(tt.gates)) for (const r of rules) used.push(...(r.key ? [r.key] : []), ...(r.keys || []));
  used.push(...Object.values(tt.payloadKeys));
  for (const s of campaign.missions?.subtypes || []) if (s.key) used.push(s.key);
  for (const g of ['station', 'base', 'vehicles']) for (const m of campaign.modules?.[g] || []) used.push(m.key);
  for (const v of campaign.vehicles.vehicles) if (Array.isArray(v.gate)) used.push(...v.gate);
  for (const k of used) assert.ok(grantedBy[k], `gate key not granted: ${k}`);
  for (const r of tt.gates.spacecraft) if (r.match.destClass) assert.ok(tt.destClass[r.match.destClass], r.match.destClass);
  // the Shuttle keeps its 1981 keys (its reusable flag must not ask for 2015 reuse tech)
  assert.deepEqual(campaign.index.vehicles.space_shuttle.gate, ['vehicle:heavy', 'vehicle:spaceplane', 'vehicle:crew_rated']);
  // every catalog vehicle/part matches at least one rule or override
  const matchAny = (kind, item) => (tt.gates[kind] || []).some((r) => Object.entries(r.match).every(([f, want]) => (['crewMin', 'crewMax', 'destClass', 'crewRated'].includes(f) ? true : Array.isArray(want) ? want.includes(item[f]) : want === true ? !!item[f] : want === false ? !item[f] : item[f] === want)));
  for (const v of campaign.vehicles.vehicles) assert.ok(Array.isArray(v.gate) || matchAny('vehicle', v), `vehicle ${v.id} ungated`);
  // liquid propellants are gated by family; small solid kick stages stay free (only big boosters need solid_large)
  for (const p of campaign.parts?.parts || []) if (p.prop && p.prop !== 'solid') assert.ok(matchAny('part', p), `part ${p.id} ungated`);
});

test('historical grant (§5.5 rule on the data): 1950 grants only the start keys; 1970 has heavy, not reusable', () => {
  const grant = (year) => {
    const out = new Set();
    const add = (id) => { if (out.has(id)) return; out.add(id); for (const r of byId[id].requires) add(r); };
    for (const n of nodes) if (!n.secret && keysOf(n).length && n.histYear < year) add(n.id);
    return out;
  };
  const keysAt = (year) => new Set([...grant(year)].flatMap((id) => keysOf(byId[id])));
  assert.deepEqual([...keysAt(1950)].sort(), ['part:prop.alcolox', 'vehicle:sounding']);
  for (const id of grant(1950)) assert.equal(byId[id].requires.length, 0, `${id}: start nodes are roots`);
  const k1970 = keysAt(1970);
  assert.ok(k1970.has('vehicle:heavy') && k1970.has('missionType:crewed') && k1970.has('vehicle:superheavy'));
  assert.ok(!k1970.has('vehicle:reusable') && !k1970.has('module:station.core'));
  // every unlock node is reachable: its prerequisites open no later than its histYear
  for (const n of nodes) if (keysOf(n).length) for (const r of n.requires) assert.ok((byId[r].fromYear ?? 2026) <= n.histYear, `${n.id} ← ${r}`);
});

test('budgets: tech packs ≤ 40 KB raw, techtree.json ≤ 15 KB; preview matches the tree', () => {
  for (let e = 1; e <= 7; e++) {
    const bytes = fs.statSync(path.join(ROOT, 'data', 'tech', `e${e}`, 'tech.json')).size;
    assert.ok(bytes <= TECH_PACK_BUDGET, `tech-e${e}: ${bytes}`);
    const pv = tt.preview[`e${e}`];
    const list = nodes.filter((n) => tierOf(n) === e);
    assert.equal(pv.count, list.length, `preview e${e} count`);
    assert.equal(pv.unlockCount, list.filter((n) => keysOf(n).length).length, `preview e${e} unlocks`);
    assert.ok(pv.highlights.length >= 4 && pv.highlights.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(pv)) <= 1024, `preview e${e} ≤ 1 KB`);
  }
  assert.ok(fs.statSync(path.join(ROOT, 'data', 'core', 'techtree.json')).size <= TECHTREE_BUDGET);
  assert.ok(!fs.existsSync(path.join(ROOT, 'data', 'eras', 'e3', 'tech.json')), 'era packs no longer carry tech');
});

test('manifest: one tech pack per era, bound to its era and every later one, excluded from the Corrida Lunar', () => {
  const m = readJson('packs');
  const eras = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
  for (const [i, e] of eras.entries()) {
    const p = m.packs.find((x) => x.id === `tech-${e}`);
    assert.ok(p, `tech-${e}`);
    assert.equal(p.kind, 'tech');
    assert.equal(p.techEra, e);
    assert.deepEqual(p.eras, eras.slice(i));
    assert.deepEqual(p.exclude, ['lunar_race']);
    assert.ok(!m.packs.find((x) => x.id === e).files.includes('tech'), `${e} drops tech`);
  }
  const core = m.packs.find((x) => x.id === 'core');
  for (const f of ['techtree', 'missions', 'contracts', 'modules', 'stations', 'market']) assert.ok(core.files.includes(f), f);
  assert.ok(!lunar.packsLoaded['tech-e4'], 'Corrida Lunar never merges a tech pack');
  // scenario switches (§0.5)
  assert.equal(readJson('scenarios/campaign').techGating, true);
  assert.equal(readJson('scenarios/campaign').unlocks.market.fromYear, 1962);
  assert.equal(readJson('scenario').techGating, false);
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'scenarios')).filter((x) => x !== 'index.json' && x !== 'campaign.json')) {
    const s = readJson(`scenarios/${f.replace('.json', '')}`);
    assert.equal(s.techGating, true, f);
    assert.equal(s.techStart, 'historical', f);
    assert.equal(s.unlocks.market.fromYear, s.start?.year ?? s.startYear, f);
  }
});

test('the whole tree is merged whatever eras are loaded (unlock keys and their years are known from the start)', async () => {
  const e1 = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: ['e1'] });
  assert.ok(e1.index.tech.t1_prop_heavy && e1.index.tech.t2_prop_spaceplane && e1.index.tech.t6_str_ring);
  const all = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });
  assert.deepEqual(e1.tech.nodes.map((n) => n.id).sort(), all.tech.nodes.map((n) => n.id).sort(), 'same tree lazy and eager');
  const e5 = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: ['e5'] });
  for (const id of ['t1_prop_heavy', 'g2_propulsion_lc_1', 'prop_e3_vertical_landing', 't4_life_base', 't5_life_colony', 't6_str_ring']) assert.ok(e5.index.tech[id], id);
  // a key first granted in a future era stays locked for the gated player (never "unknown, so held")
  const s = { playerId: 'nasa', startYear: 1950, turn: 0, techGating: true, research: { unlocked: [], keys: [] } };
  assert.equal(gating.keyHeld(s, e1, 'module:station.centrifuge'), false);
  assert.equal(gating.keyHeld(s, e1, 'satellite:deep_observatory'), false);
});

test('vocabulary: lander is a legacy alias of probe/lander; subtypes, modules and effects are frozen', () => {
  assert.deepEqual(vocab.missionTypes.lander.aliasOf, { type: 'probe', sub: 'lander' });
  assert.equal(vocab.missionTypes.lander.status, 'legacy');
  assert.ok(vocab.missionTypes.rover);
  for (const t of ['satellite', 'probe', 'rover', 'crewed', 'cargo', 'station']) assert.ok(Object.keys(vocab.missionSubtypes[t]).length >= 2, t);
  for (const [t, subs] of Object.entries(vocab.missionSubtypes)) {
    if (t.startsWith('_')) continue;
    for (const [id, s] of Object.entries(subs)) if (s.key) assert.ok(grantedBy[s.key], `${t}/${id} → ${s.key}`);
  }
  assert.equal(Object.keys(vocab.stationModules).length, 16);
  assert.equal(Object.keys(vocab.baseModules).length, 15);
  assert.equal(Object.keys(vocab.baseVehicles).length, 8);
  for (const k of ['lifetime', 'maintenance', 'stationScience', 'baseScience', 'roverScience', 'observatoryScience', 'satRevenue',
    'dockingReliability', 'moduleMass', 'isru', 'transitTime', 'devTime', 'production', 'marketInterest']) {
    assert.ok(vocab.techEffects[k], k);
    assert.ok(tt.effectLabels[k], `label ${k}`);
  }
  for (const n of nodes) for (const k of Object.keys(n.effects)) assert.ok(vocab.techEffects[k], `${n.id}: ${k}`);
  assert.ok(vocab.proposalTypes.launch_services && vocab.proposalTypes.station_partnership);
  for (const k of ['payloadKinds', 'assetKinds', 'assetStatus', 'unlockKinds']) assert.ok(Object.keys(vocab[k]).length >= 4, k);
});

test('validator: broken tech data is caught (prefix, tier order, untilYear, keys, templates, budgets)', () => {
  const inp = base();
  const t3 = inp.packs['tech-e3'].tech;
  t3.nodes.push({ ...t3.nodes[0], id: 'g3_falso', unlocks: undefined });
  const conv = t3.nodes.find((n) => n.id === 'prop_e3_vertical_landing');
  conv.untilYear = 2050;
  conv.requires = [...conv.requires, 't5_life_colony'];
  t3.nodes.push({ ...t3.nodes.find((n) => n.id === 't3_str_cupola'), id: 't3_str_chave_nova', unlocks: [{ key: 'module:station.inexistente', label: 'X' }] });
  t3.templates[0].names = t3.templates[0].names.slice(1);
  inp.packs.core.techtree.gates.vehicle.push({ match: { id: 'x' }, key: 'vehicle:nao_existe' });
  const iss = issues(inp);
  const e = errorsOf({ issues: iss });
  assert.ok(has(e, /g3_falso.*prefixo g<n>_/), 'generated prefix');
  assert.ok(has(e, /prop_e3_vertical_landing.*untilYear.*obsoleto/), 'untilYear on unlock node');
  assert.ok(has(e, /requires.*t5_life_colony é de um nível posterior/), 'later tier');
  assert.ok(has(e, /chave fora do vocabulário.*module:station\.inexistente/), 'vocab key');
  assert.ok(has(e, /templates\.lc\.names/), 'template names');
  assert.ok(has(e, /vehicle:nao_existe não é concedida/), 'gate key not granted');
  // histYear window and fromYear lead
  const inp2 = base();
  const heavy = inp2.packs['tech-e1'].tech.nodes.find((n) => n.id === 't1_prop_heavy');
  heavy.histYear = 1990;
  const cap = inp2.packs['tech-e1'].tech.nodes.find((n) => n.id === 't1_comp_geo');
  cap.fromYear = 1950;
  inp2.sizes['tech-e1'].tech = TECH_PACK_BUDGET + 1;
  const e2 = errorsOf({ issues: issues(inp2) });
  assert.ok(has(e2, /t1_prop_heavy\.histYear.*fora do nível t1/));
  assert.ok(has(e2, /t1_comp_geo\.fromYear.*deveria ser 1961/));
  assert.ok(has(e2, /pacote de tecnologia com .* KB \(limite 40 KB\)/));
  // a cycle across tiers' own nodes
  const inp3 = base();
  const a = inp3.packs['tech-e2'].tech.nodes.find((n) => n.id === 't2_str_multiport');
  const b = inp3.packs['tech-e2'].tech.nodes.find((n) => n.id === 't2_str_cargo_ship');
  a.requires = [...a.requires, b.id];
  assert.ok(has(errorsOf({ issues: issues(inp3) }), /ciclo de pré-requisitos/));
});

test('validator: subtypes on calendar and spacecraft come from vocab.missionSubtypes; legacy lander warns', () => {
  const inp = base();
  const cal = inp.packs.e1.calendar.missions;
  cal[0] = { ...cal[0], type: 'satellite', sub: 'hologram' };
  const sat = inp.packs.e1.spacecraft.spacecraft.find((s) => s.kind === 'satellite');
  sat.sub = 'telepathy';
  const list = issues(inp);
  assert.ok(has(errorsOf({ issues: list }), /sub.*subtipo hologram não existe para satellite/));
  assert.ok(has(errorsOf({ issues: list }), /sub.*subtipo telepathy não existe para satellite/));
  const inp2 = base();
  inp2.packs.e1.calendar.missions[0] = { ...inp2.packs.e1.calendar.missions[0], type: 'lander', sub: undefined };
  assert.ok(has(issues(inp2).filter((i) => i.level === 'warn'), /tipo legado lander/));
});

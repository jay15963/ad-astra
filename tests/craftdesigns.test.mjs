// Estaleiro (spacecraft designer, src/sim/craftdesigns.js + src/core/craftfit.js): the craft parts catalog, stats
// (mass, Δv, power, cost, reliability), destination rules (comms, power, Δv, landing, entry, crew), research gating,
// costs balanced against catalog craft, the development program and maturity, the catalog/missions integration
// (the design shows up in the mission builder), determinism with save/load, old saves, and the painter adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { spacecraftDef, listSpacecraft, craftFitsDestination } from '../src/core/catalog.js';
import * as gating from '../src/core/gating.js';
import * as cd from '../src/sim/craftdesigns.js';
import { fitDest, bodyInfo, dvNeed, craftPartsOf } from '../src/core/craftfit.js';
import * as painter from '../src/ui/launch-render/vehicles.js';
import * as render from '../src/ui/launch-render/index.js';
import * as estaleiro from '../src/ui/estaleiro.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(readFileSync(join(ROOT, 'data/core/craft-parts.json'), 'utf8'));
const lunar = await loadDataNode(ROOT);
const campaign = await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' });

const game = (data = lunar, playerId = 'nasa', seed = 7) => engine.newGame(data, { seed, playerId });
const act = (st, data, a) => engine.dispatch(st, data, a);
const Y = { year: 2026 };
function play(st, data, n) {
  for (let i = 0; i < n && !st.gameOver; i++) {
    for (const d of st.decisions.slice()) engine.resolveDecision(st, data, d.id, (d.choices?.find((c) => !c.disabled) || d.choices?.[0])?.id);
    st.activeLaunch = null;
    engine.tick(st, data);
  }
}
function grantHistory(st, data, year) {
  st.research.unlocked = gating.historicalGrant(data, year + 1, { have: st.research.unlocked });
  st.research.keys = gating.keysOfNodes(data, st.research.unlocked);
}
/** Fly the design's demo flights (missions.js creates each one; a 'mission/resolved' success counts it). */
function passTests(st, data, id, outcome = 'total') {
  for (let i = 0; i < 6 && st.craftDesigns[id].program?.phase === 'testFlights'; i++) {
    play(st, data, 1);
    const m = st.missions.find((x) => x.testCraftId === id && !['done', 'cancelled'].includes(x.status));
    assert.ok(m, 'o voo de teste aparece em Missões');
    m.status = 'done';
    st.signals = [{ type: 'mission/resolved', missionId: m.id, outcome, phase: 'arrival', final: true }];
    cd.tick(st, data, { dt: 1, prevTurn: st.turn, turn: st.turn });
    if (outcome !== 'total') return;
  }
}
const generic = (id) => lunar.spacecraft.spacecraft.find((s) => s.id === id);

// lean lunar-orbit science smallsat (2026 parts)
const LUNAR_SAT = {
  role: 'satellite', busId: 'bus_smallsat_2010', shape: 'hex', finish: 'gold', arrays: 'wings', antenna: 'top',
  parts: { inst_spectrometer_1962: 1, inst_camera_1959: 1, comm_lga_1959: 1, solar_wing_gaas_1997: 1, batt_liion_2000: 1, eng_biprop_1966: 1 }, propT: 0.06,
};

// ------------------------------------------------------------------ data

test('craft-parts.json: ids unique, kinds and roles known, every role has a structure, gate keys granted by a node', () => {
  const kinds = new Set(Object.keys(lunar.vocab?.craftPartKinds || JSON.parse(readFileSync(join(ROOT, 'data/core/vocab.json'), 'utf8')).craftPartKinds));
  const roles = new Set(RAW.roles.map((r) => r.id));
  const seen = new Set();
  const idx = gating.keyIndex(campaign);
  for (const p of RAW.parts) {
    assert.match(p.id, /^[a-z0-9_]+$/);
    assert.ok(!seen.has(p.id), `id repetido ${p.id}`); seen.add(p.id);
    assert.ok(kinds.has(p.kind), `${p.id}: kind ${p.kind}`);
    for (const r of p.roles || []) assert.ok(roles.has(r), `${p.id}: role ${r}`);
    assert.ok(p.availableFrom?.year >= 1950, p.id);
    for (const k of p.gate || []) assert.ok(idx.byKey.has(k), `${p.id}: chave ${k} sem nó`);
  }
  for (const r of RAW.roles) {
    assert.ok(RAW.parts.some((p) => p.kind === 'bus' && p.roles.includes(r.id)), `${r.id} sem estrutura`);
    for (const k of r.gate || []) assert.ok(idx.byKey.has(k), `${r.id}: chave ${k}`);
  }
  assert.ok(craftPartsOf(lunar), 'pacote core carrega o catálogo também na Corrida Lunar');
});

// ------------------------------------------------------------------ stats and fit rules

test('stats: mass, Δv (Tsiolkovsky), power, cost and reliability of a lean lunar science satellite', () => {
  const s = cd.craftStats(lunar, LUNAR_SAT, Y);
  assert.equal(s.ok, true, s.errors.join('; '));
  assert.equal(s.ready, true, s.missing.join('; '));
  assert.ok(s.massT > 0.15 && s.massT < 0.35, `massa ${s.massT}`);
  const ve = (312 * 9.80665) / 1000;
  assert.ok(Math.abs(s.dv - ve * Math.log(s.massT / s.dryT)) < 0.02, `Δv ${s.dv}`);
  assert.ok(s.powerW >= 1200 && s.useW < s.powerW);
  assert.equal(s.kind, 'satellite');
  assert.equal(s.sub, 'science');
  assert.ok(s.inherent > 0.85 && s.inherent < 0.97, `confiança ${s.inherent}`);
  const f = fitDest(lunar, s.cap, 'lunar_orbit');
  assert.equal(f.ok, true, f.reasons.map((r) => r.text).join('; '));
  assert.equal(fitDest(lunar, s.cap, 'mars_orbit').ok, false, 'antena de baixo ganho não chega a Marte');
  assert.ok(fitDest(lunar, s.cap, 'mars_orbit').reasons.some((r) => r.code === 'comms'));
  assert.equal(fitDest(lunar, s.cap, 'lunar_surface').ok, false, 'satélite não pousa');
});

test('fit rules: landing legs and descent thrust on the Moon, heat shield and chute on Mars, wheels on rovers, RTG far from the Sun', () => {
  const st = game();
  const lander = cd.fillRole(st, lunar, 'lander', 'lunar_surface');
  const s = cd.craftStats(lunar, lander, Y);
  assert.ok(fitDest(lunar, s.cap, 'lunar_surface').ok, 'o rascunho automático pousa na Lua');
  const noLegs = { ...lander, parts: { ...lander.parts } };
  delete noLegs.parts.legs_1966;
  assert.ok(fitDest(lunar, cd.craftStats(lunar, noLegs, Y).cap, 'lunar_surface').reasons.some((r) => r.code === 'legs'));
  const dry = { ...lander, propT: 0.1 };
  assert.ok(fitDest(lunar, cd.craftStats(lunar, dry, Y).cap, 'lunar_surface').reasons.some((r) => r.code === 'dv'));
  // Mars: entry needs a shield and a chute
  const mars = cd.craftStats(lunar, cd.fillRole(st, lunar, 'lander', 'mars_surface'), Y);
  assert.ok(fitDest(lunar, mars.cap, 'mars_surface').ok);
  assert.ok(fitDest(lunar, { ...mars.cap, shield: 0 }, 'mars_surface').reasons.some((r) => r.code === 'shield'));
  assert.ok(fitDest(lunar, { ...mars.cap, chute: false }, 'mars_surface').reasons.some((r) => r.code === 'chute'));
  // rovers need wheels
  const rov = cd.craftStats(lunar, cd.fillRole(st, lunar, 'rover', 'mars_surface'), Y);
  assert.ok(fitDest(lunar, rov.cap, 'mars_surface').ok);
  assert.ok(fitDest(lunar, { ...rov.cap, wheels: 0 }, 'mars_surface').reasons.some((r) => r.code === 'wheels'));
  // solar power falls with 1/AU²: the lunar satellite cannot work at Jupiter even with a big antenna
  const far = { ...cd.craftStats(lunar, LUNAR_SAT, Y).cap, comms: 3, dv: 2 };
  assert.ok(fitDest(lunar, far, 'jupiter').reasons.some((r) => r.code === 'power'));
  assert.ok(fitDest(lunar, { ...far, rtgW: 400 }, 'jupiter').ok);
  // airless landing Δv = orbit insertion + landK·√g
  const moon = bodyInfo(lunar, { id: 'lunar_surface', body: 'moon', kind: 'surface' });
  assert.ok(Math.abs(dvNeed(lunar, s.cap, { id: 'lunar_surface', body: 'moon', kind: 'surface' }, moon).dv - (0.85 + 4.8 * Math.sqrt(0.166))) < 0.02);
});

test('crewed: seats, life support, return shield, chute and escape; a crewed lander is a companion only', () => {
  const st = game();
  const cap = cd.craftStats(lunar, cd.fillRole(st, lunar, 'capsule', 'iss', { crew: 3 }), Y);
  assert.ok(cap.crew >= 1);
  const f = fitDest(lunar, cap.cap, 'iss');
  assert.equal(f.ok, true, f.reasons.map((r) => r.text).join('; '));
  assert.ok(fitDest(lunar, { ...cap.cap, escape: false }, 'iss').reasons.some((r) => r.code === 'escape'));
  assert.ok(fitDest(lunar, { ...cap.cap, docking: false }, 'iss').reasons.some((r) => r.code === 'docking'));
  assert.ok(fitDest(lunar, cap.cap, 'lunar_orbit').reasons.some((r) => r.code === 'life' || r.code === 'return' || r.code === 'dv'), 'a cápsula de órbita baixa não vai à Lua');
});

// ------------------------------------------------------------------ balance against the catalog

test('costs: a lean lunar-orbit satellite is much cheaper than the generic catalog option; a generalist build is not', () => {
  const s = cd.craftStats(lunar, LUNAR_SAT, Y);
  const gsat = generic('generic_sat');
  const gprobe = generic('generic_probe');
  const lunarGeneric = Math.min(gsat.costM * 1.6, gprobe.costM * 1.6); // GENERIC_COST_SCALE.tli
  assert.ok(s.costM < lunarGeneric * 0.4, `${s.costM} vs ${lunarGeneric}`);
  assert.ok(s.massT < gsat.massT, 'mais leve: foguete menor');
  // ... but it pays development, flies less reliably at first and does less science per year
  const pc = cd.programCosts(game(), lunar, { spec: LUNAR_SAT, origin: 'scratch' }, s);
  assert.ok(pc.devCostM >= 3 * s.costM, `desenvolvimento ${pc.devCostM}`);
  assert.ok(s.inherent - pc.newness < gsat.estimatedReliability, 'primeiro voo menos confiável que o genérico');
  // a comms satellite on a GEO-class structure with the same job as generic_sat costs about the same
  const geo = cd.craftStats(lunar, { role: 'satellite', busId: 'bus_geo_2000', parts: { inst_transponder_1962: 4, comm_lga_1959: 1, solar_wing_gaas_1997: 2, batt_liion_2000: 1, eng_main_1975: 1 }, propT: 0.8 }, Y);
  assert.ok(geo.ok, geo.errors.join('; '));
  assert.ok(geo.costM > gsat.costM * 0.8 && geo.costM < gsat.costM * 2, `GEO ${geo.costM} vs ${gsat.costM}`);
});

// ------------------------------------------------------------------ gating

test('gating (campaign): roles and parts open with the tech tree keys (probe:lander, probe:outer, rover:*)', () => {
  const st = game(campaign, 'nasa');
  st.turn = (1962 - st.startYear) * 52;
  grantHistory(st, campaign, 1961);
  assert.equal(cd.roleAccess(st, campaign, 'satellite').ok, true);
  const la = cd.roleAccess(st, campaign, 'lander');
  assert.equal(la.ok, false, 'pousador pede probe:lander (1966)');
  assert.ok(la.nodeId, 'aponta o nó de pesquisa');
  assert.equal(act(st, campaign, { type: 'craft/new', role: 'lander' }).ok, false);
  const rtg = craftPartsOf(campaign).byId.rtg_mhw_1976;
  st.turn = (1977 - st.startYear) * 52;
  assert.equal(cd.partAccess(st, campaign, rtg).ok, false, 'RTG grande pede probe:outer');
  grantHistory(st, campaign, 1976);
  assert.equal(cd.partAccess(st, campaign, rtg).ok, true);
  assert.equal(cd.roleAccess(st, campaign, 'lander').ok, true);
  const t = gating.unlockTargets(campaign, st, 'probe:lander', 50);
  assert.ok(t.names.some((n) => /^Estaleiro:/.test(n)), 'a árvore lista as peças do Estaleiro que a chave libera');
});

// ------------------------------------------------------------------ program, catalog, missions

test('program: develop → operational; the design joins listSpacecraft and the mission builder; flights mature it', () => {
  const st = game();
  const r = act(st, lunar, { type: 'craft/new', spec: LUNAR_SAT, name: 'Selene-1' });
  assert.ok(r.ok, r.error);
  const id = r.designId;
  assert.match(id, /^csg_\d+$/);
  assert.equal(spacecraftDef(lunar, id, st)?.retired, true, 'projeto ainda não voa');
  const cash0 = st.actors.nasa.cash;
  const dv = act(st, lunar, { type: 'craft/develop', designId: id });
  assert.ok(dv.ok, dv.error);
  assert.ok(st.actors.nasa.cash < cash0, 'paga a entrada');
  play(st, lunar, dv.devWeeks + 2);
  const d = st.craftDesigns[id];
  assert.equal(d.program.phase, 'testFlights', 'depois do desenvolvimento vêm os voos de teste');
  passTests(st, lunar, id);
  assert.equal(d.program.phase, 'operational');
  const sc = spacecraftDef(lunar, id, st);
  assert.ok(sc && !sc.retired && sc.craftFit && sc.kind === 'satellite');
  assert.ok(listSpacecraft(lunar, st, { actorId: 'nasa' }).some((s) => s.id === id));
  assert.equal(craftFitsDestination(lunar, sc, 'lunar_orbit'), true);
  assert.equal(craftFitsDestination(lunar, sc, 'mars_orbit'), false);
  const opts = engine.query(st, lunar, 'missions/draftOptions', { type: 'satellite', destination: 'lunar_orbit', sub: 'science' });
  const mine = opts.spacecraft.find((s) => s.id === id);
  assert.ok(mine, 'aparece na escolha de nave');
  assert.equal(mine.valid, true, (mine.reasons || []).join('; '));
  assert.equal(mine.design, true);
  const mars = engine.query(st, lunar, 'missions/draftOptions', { type: 'satellite', destination: 'mars_orbit' }).spacecraft.find((s) => s.id === id);
  assert.ok(mars && !mars.valid && /antena/i.test(mars.reasons[0]), 'explica por que não serve');
  assert.ok(lunar.index.spacecraft[id], 'publicada no índice (risk/launch/infra resolvem pelo id)');
  // maturity: a successful flight shrinks the first-flight gap
  const gap0 = d.gap;
  st.missions.push({ id: 'm_test', spacecraftId: id, status: 'done' });
  st.signals = [{ type: 'mission/resolved', missionId: 'm_test', outcome: 'total', phase: 'arrival', final: true }];
  cd.tick(st, lunar, { dt: 1, prevTurn: st.turn, turn: st.turn });
  assert.ok(d.gap < gap0, 'voo bom amadurece');
  assert.equal(d.stats.flights, 2, '1 voo de teste + 1 voo operacional');
  st.missions.pop();
});

test('templates: every role fills a first draft that fits its default target in 2026; catalog craft as templates', () => {
  const st = game();
  for (const r of cd.queries['craft/roles'](st, lunar)) {
    assert.ok(r.ok, `${r.id}: ${r.reason}`);
    const res = act(st, lunar, { type: 'craft/new', role: r.id, crew: r.id === 'capsule' ? 1 : 0 });
    assert.ok(res.ok, `${r.id}: ${res.error}`);
    const pv = cd.queries['craft/preview'](st, lunar, { designId: res.designId, spec: st.craftDesigns[res.designId].spec, destId: r.target });
    assert.ok(pv.ready, `${r.id}: ${pv.missing.join(', ')} ${pv.errors.join(', ')}`);
    assert.ok(pv.fitCount > 0, `${r.id} não serve para nada`);
    assert.ok(pv.types.length > 0, `${r.id}: tipos de missão`);
  }
  const tpl = cd.queries['craft/catalogTemplates'](st, lunar);
  assert.ok(tpl.some((t) => t.craftId === 'generic_lander'));
  const r2 = act(st, lunar, { type: 'craft/new', fromCraftId: 'generic_lander' });
  assert.ok(r2.ok, r2.error);
  assert.equal(st.craftDesigns[r2.designId].origin, 'catalog');
  assert.equal(st.craftDesigns[r2.designId].role, 'lander');
});

test('save/load: identical results after serialize/deserialize; an old save without the slice still works', () => {
  const st = game(lunar, 'nasa', 11);
  const id = act(st, lunar, { type: 'craft/new', spec: LUNAR_SAT }).designId;
  act(st, lunar, { type: 'craft/develop', designId: id });
  play(st, lunar, 5);
  const copy = engine.deserialize(engine.serialize(st), lunar);
  play(st, lunar, 20);
  play(copy, lunar, 20);
  assert.equal(JSON.stringify(copy.craftDesigns), JSON.stringify(st.craftDesigns));
  assert.equal(engine.serialize(copy), engine.serialize(st));
  // old save (v1 fixture): no craftDesigns slice at all
  const old = engine.deserialize(readFileSync(join(ROOT, 'tests/fixtures/save-v1-t120.json'), 'utf8'), lunar);
  delete old.craftDesigns;
  assert.deepEqual(cd.queries['craft/list'](old, lunar), []);
  play(old, lunar, 1);
  const r = act(old, lunar, { type: 'craft/new', role: 'satellite' });
  assert.ok(r.ok, r.error);
});

test('revision: editing an operational design makes "Nome II" with a cheaper program', () => {
  const st = game();
  const id = act(st, lunar, { type: 'craft/new', spec: LUNAR_SAT, name: 'Selene' }).designId;
  const dv = act(st, lunar, { type: 'craft/develop', designId: id });
  play(st, lunar, dv.devWeeks + 2);
  passTests(st, lunar, id);
  const res = act(st, lunar, { type: 'craft/save', designId: id, draft: { parts: { ...LUNAR_SAT.parts, inst_magnetometer_1959: 1 } } });
  assert.ok(res.ok && res.revision, res.error);
  const nd = st.craftDesigns[res.designId];
  assert.equal(nd.name, 'Selene II');
  const pc = cd.programCosts(st, lunar, nd, cd.craftStats(lunar, nd.spec, Y));
  assert.ok(pc.devCostM < dv.devCostM * 0.5);
  assert.equal(act(st, lunar, { type: 'craft/save', designId: id, draft: { finish: 'white', name: 'Selene' } }).ok, true, 'aparência não é revisão');
});

// ------------------------------------------------------------------ painter + UI helpers

test('painter: designed craft become art of the existing templates; the launch scene resolves them by id', () => {
  const s = cd.craftStats(lunar, LUNAR_SAT, Y);
  const art = painter.craftDesignArt({ name: 'Selene', design: { geometry: s.geometry } });
  assert.equal(art.template, 'probe');
  assert.equal(art.bus.shape, 'hex');
  const rover = cd.craftStats(lunar, cd.fillRole(game(), lunar, 'rover', 'mars_surface'), Y);
  assert.equal(painter.craftDesignArt({ name: 'R', design: { geometry: rover.geometry } }).template, 'rover');
  painter.setCraftResolver((id) => (id === 'csg_9' ? { name: 'X', design: { geometry: s.geometry } } : null));
  assert.equal(painter.craftArt('csg_9').template, 'probe');
  const stack = painter.resolveStack('falcon9', 'csg_9', {});
  assert.ok(stack.heightM > 40);
  painter.setCraftResolver(null);
  assert.equal(estaleiro.fmtDv(1.234), '1,23 km/s');
  assert.equal(estaleiro.fmtW(1500), '1,5 kW');
  assert.equal(typeof estaleiro.render, 'function');
});

// ------------------------------------------------------------------ test flights (v0.10.1)

test('test flights: count by function; dev → testFlights → demo missions in Missões → operational; only its own demos fly it', () => {
  const st = game();
  const D = craftPartsOf(lunar).rules.dev;
  const stat = (spec) => cd.craftStats(lunar, spec, Y);
  assert.equal(cd.testsNeeded(D, { origin: 'scratch' }, stat(LUNAR_SAT), 0.1), 1, 'satélite: 1');
  assert.equal(cd.testsNeeded(D, { origin: 'scratch' }, stat(cd.fillRole(st, lunar, 'lander', 'lunar_surface')), 0.1), 2, 'pousador: 2');
  assert.equal(cd.testsNeeded(D, { origin: 'scratch' }, stat(cd.fillRole(st, lunar, 'capsule', 'iss', { crew: 3 })), 0.1), 3, 'cápsula tripulada: 3');
  assert.equal(cd.testsNeeded(D, { parentId: 'x', refSpec: LUNAR_SAT }, stat(LUNAR_SAT), 0.04), 1, 'revisão: 1');

  const id = act(st, lunar, { type: 'craft/new', role: 'lander', destId: 'lunar_surface', name: 'Tranquilo' }).designId;
  const dv = act(st, lunar, { type: 'craft/develop', designId: id });
  assert.ok(dv.ok, dv.error);
  assert.equal(dv.needFlights, 2);
  play(st, lunar, dv.devWeeks + 2);
  const d = st.craftDesigns[id];
  assert.equal(d.program.phase, 'testFlights');
  const gap0 = d.gap;
  const m = st.missions.find((x) => x.testCraftId === id);
  assert.ok(m, 'missions.js cria o voo de demonstração');
  assert.equal(m.spacecraftId, id);
  assert.equal(m.crewed, false);
  assert.equal(m.destination, 'lunar_surface', 'voa até o próprio alvo');
  assert.equal(m.vehicleId, null, 'o jogador escolhe o foguete');
  assert.ok(m.suggestion?.vehicleId, 'com a sugestão dos engenheiros');
  // the demo flight validates with the suggested rocket (craft in test is allowed in its own demo)
  const est = engine.query(st, lunar, 'missions/draftOptions', { missionId: m.id, type: m.type, destination: m.destination, spacecraftId: id, vehicleId: m.suggestion.vehicleId, clientPayload: true, config: m.config, source: 'test' });
  assert.ok(est.spacecraft.find((s) => s.id === id)?.valid, 'a nave em teste vale no próprio voo de teste');
  assert.ok(!est.errors.some((e) => /Tranquilo/.test(e)), est.errors.join('; '));
  // ... but not in ordinary missions
  const other = engine.query(st, lunar, 'missions/draftOptions', { type: 'probe', destination: 'lunar_surface' }).spacecraft.find((s) => s.id === id);
  assert.ok(other && !other.valid && /voos de teste/.test(other.reasons[0]));
  assert.equal(act(st, lunar, { type: 'craft/save', designId: id, draft: { propT: 0.5 } }).ok, false, 'hardware travado nos testes');
  // a failed demo does not count; two good ones approve it and mature the reliability
  passTests(st, lunar, id, 'catastrophic');
  assert.equal(d.program.testOk, 0);
  assert.equal(d.program.phase, 'testFlights');
  passTests(st, lunar, id);
  assert.equal(d.program.phase, 'operational');
  assert.equal(d.program.testOk, 2);
  assert.ok(d.gap < gap0 * 0.5, `confiança amadurece (${gap0} → ${d.gap})`);
  assert.ok(engine.query(st, lunar, 'missions/draftOptions', { type: 'probe', destination: 'lunar_surface' }).spacecraft.find((s) => s.id === id)?.valid, 'aprovada: voa em qualquer missão');
});

test('launch scene: designed landers and rovers ride an aeroshell only toward a world with an atmosphere', () => {
  const st = game();
  const mars = cd.craftStats(lunar, cd.fillRole(st, lunar, 'lander', 'mars_surface'), Y);
  assert.ok(mars.geometry.shield && mars.geometry.chute);
  // the same hardware (shield + chute) is the lander itself in the art; the renderer encapsulates it by world
  const art = painter.craftDesignArt({ name: 'L', design: { geometry: mars.geometry } });
  assert.equal(art.template, 'lander');
  assert.ok(art.aeroshell?.d > 0, 'carrega o diâmetro do aeroescudo como os pousadores marcianos do catálogo');
  for (const w of ['mars', 'titan', 'venus']) assert.equal(render.descendsInAeroshell(art, w), true, w);
  for (const w of ['moon', 'mercury', 'phobos', 'europa', 'bennu', 'ceres']) assert.equal(render.descendsInAeroshell(art, w), false, w);
  const lunarArt = painter.craftDesignArt({ name: 'T', design: { geometry: cd.craftStats(lunar, cd.fillRole(st, lunar, 'lander', 'lunar_surface'), Y).geometry } });
  assert.equal(lunarArt.aeroshell, undefined, 'pousador lunar sem escudo nunca tem aeroescudo');
  const rover = painter.craftDesignArt({ name: 'R', design: { geometry: cd.craftStats(lunar, cd.fillRole(st, lunar, 'rover', 'mars_surface'), Y).geometry } });
  assert.equal(render.descendsInAeroshell(rover, 'mars'), true);
  assert.equal(render.descendsInAeroshell(rover, 'moon'), false);
  // the aeroshell's inner craft resolves a designed id
  painter.setCraftResolver((id) => (id === 'csg_77' ? { name: 'L', design: { geometry: mars.geometry } } : null));
  assert.equal(painter.craftArt('csg_77').template, 'lander');
  painter.setCraftResolver(null);
});

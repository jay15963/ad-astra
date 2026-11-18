// Fase B4 (mapas, EXPANSION.md §8): data/core/stars.json + níveis profundos (src/ui/starmap.js), névoa de guerra
// (src/sim/explore.js) e fronteiras/blocos por época do mapa-múndi (data/world-eras.json + worldmap.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as explore from '../src/sim/explore.js';
import {
  starXYZ, galacticLB, galaxyXY, deepLevels, sectorModel, galaxyModel, projectSector, declutter, starTypeText,
  travelText, knownSets, setStarsData, starsData,
} from '../src/ui/starmap.js';
import {
  parseWhen, parseUntil, parseMember, compileWorldEras, worldEraAt, styleIn, leadOf, fmtFracYear,
} from '../src/ui/worldmap.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const STARS = readJson('data/core/stars.json');
const WE = readJson('data/world-eras.json');
const WORLD = readJson('data/world.json');
const ISOS = new Set(WORLD.countries.map((c) => c.id));
const CW = compileWorldEras(WE, WORLD.countries);
const at = (y, m = 0) => worldEraAt(CW, y + m / 12);

// ------------------------------------------------------------------ stars.json

test('stars.json: ~55 real nearby stars with valid ids, coordinates and spectral classes', () => {
  const ids = new Set();
  assert.ok(STARS.stars.length >= 50, `${STARS.stars.length} estrelas`);
  for (const s of STARS.stars) {
    assert.match(s.id, /^[a-z0-9_]+$/, s.id);
    assert.ok(!ids.has(s.id), `id repetido ${s.id}`);
    ids.add(s.id);
    assert.ok(s.ra >= 0 && s.ra < 24 && s.dec >= -90 && s.dec <= 90, `${s.id} ra/dec`);
    assert.ok(s.ly >= 0 && s.ly < 45, `${s.id} ly`);
    assert.ok(s.name && !/TODO|undefined/.test(s.name));
    assert.ok(STARS.spectral[String(s.spec)[0]], `${s.id}: classe ${s.spec}`);
    for (const p of s.planets || []) {
      assert.match(p.id, /^[a-z0-9_]+$/);
      assert.ok(!ids.has(p.id), `id repetido ${p.id}`);
      ids.add(p.id);
      assert.ok(p.found >= 1990 && p.found <= 2026, `${p.id}: ano do anúncio`);
    }
  }
  assert.equal(STARS.stars.filter((s) => s.home).length, 1);
  const nearest = STARS.stars.filter((s) => !s.home).sort((a, b) => a.ly - b.ly)[0];
  assert.equal(nearest.id, 'proxima_centauri');
  for (const r of STARS.galaxy.regions) { assert.match(r.id, /^[a-z0-9_]+$/); assert.ok(!ids.has(r.id)); ids.add(r.id); }
  assert.ok(fs.statSync(path.join(root, 'data/core/stars.json')).size < 40000, 'stars.json pequeno (carregado sob demanda)');
});

test('starXYZ / galacticLB: real galactic coordinates (α Cen, Sirius, Barnard) and distances preserved', () => {
  const by = Object.fromEntries(STARS.stars.map((s) => [s.id, s]));
  for (const s of STARS.stars) {
    const d = Math.hypot(...starXYZ(s));
    assert.ok(Math.abs(d - s.ly) < 1e-6, `${s.id}: |xyz| = ly`);
  }
  const near = (a, b, tol) => Math.abs(((a - b + 540) % 360) - 180) <= tol;
  const ac = galacticLB(by.alpha_centauri);
  assert.ok(near(ac.l, 315.7, 1.5) && Math.abs(ac.b - -0.7) < 1.5, `α Cen l=${ac.l} b=${ac.b}`);
  const si = galacticLB(by.sirius);
  assert.ok(near(si.l, 227.2, 1.5) && Math.abs(si.b - -8.9) < 1.5, `Sirius l=${si.l} b=${si.b}`);
  const ba = galacticLB(by.barnard);
  assert.ok(near(ba.l, 31.0, 1.5) && Math.abs(ba.b - 14.1) < 1.5, `Barnard l=${ba.l} b=${ba.b}`);
  // Proxima and α Cen are one system: a fraction of a light-year apart
  const [p, q] = [starXYZ(by.proxima_centauri), starXYZ(by.alpha_centauri)];
  assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.35);
  // galaxy map: the Sun sits below the centre, the centre direction (l = 0) is up
  assert.deepEqual(galaxyXY(0, 0, 26000), [-0, 26000]);
  const [cx, cy] = galaxyXY(0, 26000, 26000);
  assert.ok(Math.abs(cx) < 1e-9 && Math.abs(cy) < 1e-9);
});

test('deep levels unlock by era: none before 2200, Setor from 2200 (e6), Galáxia from 2600 (e7)', () => {
  assert.deepEqual(deepLevels(STARS, 1962), []);
  assert.deepEqual(deepLevels(STARS, 2199), []);
  assert.deepEqual(deepLevels(STARS, 2200).map((l) => l.id), ['sector']);
  assert.deepEqual(deepLevels(STARS, 2700).map((l) => l.id), ['sector', 'galaxy']);
  assert.deepEqual(deepLevels(null, 2700), []);
  for (const l of deepLevels(STARS, 2700)) assert.ok(l.short && l.name);
});

// ------------------------------------------------------------------ explore.js (sim slice)

test('explore(): ids only, first-discovery order, dedupe, invalid ids ignored, cap, JSON round-trip', () => {
  const st = {};
  assert.deepEqual(explore.exploredList(st), []);
  assert.deepEqual(explore.explore(st, ['barnard', 'proxima_centauri', 'barnard', 'Bad Id', null]), ['barnard', 'proxima_centauri']);
  assert.deepEqual(explore.explore(st, 'barnard'), []);
  assert.deepEqual(st.explored, ['barnard', 'proxima_centauri']);
  assert.ok(explore.isExplored(st, 'barnard') && !explore.isExplored(st, 'tau_ceti'));
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
  const big = { explored: [] };
  explore.explore(big, Array.from({ length: explore.EXPLORED_CAP + 20 }, (_, i) => `s${i}`));
  assert.equal(big.explored.length, explore.EXPLORED_CAP);
  // module contract: init creates the slice, tick copies what missions reached (idempotent, no rng)
  const data = { destinations: { destinations: [{ id: 'proxima_flyby', star: 'proxima_centauri', explores: ['alpha_centauri'] }, { id: 'leo' }] }, index: {} };
  const s2 = { missions: [
    { id: 'm1', destination: 'proxima_flyby', status: 'done', result: { outcome: 'total' } },
    { id: 'm2', destination: 'leo', status: 'done', result: { outcome: 'total' } },
    { id: 'm3', destination: 'proxima_flyby', status: 'transit' },
  ] };
  explore.init(s2);
  assert.deepEqual(s2.explored, []);
  explore.tick(s2, data);
  explore.tick(s2, data);
  assert.deepEqual(s2.explored, ['alpha_centauri', 'proxima_centauri']);
  assert.deepEqual(explore.meta, { maxDt: 52 });
  const failed = { missions: [{ id: 'm', destination: 'proxima_flyby', status: 'done', result: { outcome: 'failure' } }] };
  assert.deepEqual(explore.revealedByMissions(failed, data), []);
  assert.deepEqual(explore.queries['explore/state'](s2, data).explored.sort(), ['alpha_centauri', 'proxima_centauri']);
});

test('colonies in any Phase C shape; stars hosting them count as explored', () => {
  const shapes = [
    [{ id: 'c1', name: 'Nova Esperança', starId: 'proxima_centauri', ownerId: 'nasa' }],
    { list: [{ id: 'c1', name: 'Nova Esperança', star: 'proxima_centauri', owner: 'nasa' }] },
    { list: { c1: { id: 'c1', name: 'Nova Esperança', starId: 'proxima_centauri', actorId: 'nasa' } } },
    { c1: { id: 'c1', name: 'Nova Esperança', starId: 'proxima_centauri', ownerId: 'nasa', stage: 3 } },
  ];
  for (const c of shapes) {
    const list = explore.colonyList({ colonies: c });
    assert.equal(list.length, 1, JSON.stringify(c));
    assert.equal(list[0].starId, 'proxima_centauri');
    assert.equal(list[0].ownerId, 'nasa');
    assert.ok(explore.exploredIds({ colonies: c }, {}).has('proxima_centauri'));
  }
  assert.deepEqual(explore.colonyList({}), []);
  assert.deepEqual(explore.colonyList({ colonies: { maxStage: 2 } }), []);
  assert.equal(explore.colonyList({ colonies: [{ id: 'o', bodyId: 'mars', stage: 1 }] })[0].kind, 'outpost');
});

test('fog: planets appear on their announcement year; generated worlds only after a survey, same in every game', () => {
  const prox = STARS.stars.find((s) => s.id === 'proxima_centauri');
  assert.deepEqual(explore.knownPlanets(prox, 2015).map((p) => p.id), []);
  assert.deepEqual(explore.knownPlanets(prox, 2016).map((p) => p.id), ['proxima_b']);
  assert.deepEqual(explore.knownPlanets(prox, 2030).map((p) => p.id), ['proxima_b', 'proxima_d']);
  assert.equal(explore.hiddenPlanetCount(prox, 2015), 2 + explore.generatedPlanets(prox).length);
  const wolf = STARS.stars.find((s) => s.id === 'wolf_359');
  const gen = explore.generatedPlanets(wolf);
  assert.deepEqual(gen, explore.generatedPlanets(wolf), 'deterministic');
  for (const p of gen) { assert.match(p.id, /^wolf_359_g\d$/); assert.ok(p.generated && p.kind); }
  assert.deepEqual(explore.knownPlanets(wolf, 2600, 'observed'), []);
  assert.equal(explore.knownPlanets(wolf, 2600, 'surveyed').length, gen.length);
  assert.equal(explore.hiddenPlanetCount(wolf, 2600, 'surveyed'), 0);
  assert.deepEqual(explore.generatedPlanets({ id: 'sol', home: true }), []);
  for (const s of STARS.stars) {
    const names = explore.knownPlanets(s, 3000, 'surveyed').map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${s.id}: nomes de planetas repetidos (${names.join(', ')})`);
  }
  const ex = new Set(['barnard']);
  const cols = [{ starId: 'tau_ceti' }];
  assert.equal(explore.starStatus({ id: 'sol', home: true }, ex, cols), 'home');
  assert.equal(explore.starStatus({ id: 'barnard' }, ex, cols), 'surveyed');
  assert.equal(explore.starStatus({ id: 'tau_ceti' }, ex, cols), 'colony');
  assert.equal(explore.starStatus({ id: 'proxima_centauri', system: 'barnard' }, ex, cols), 'surveyed', 'system id counts');
  assert.equal(explore.starStatus({ id: 'vega' }, ex, cols), 'observed');
});

// ------------------------------------------------------------------ starmap models

test('sector model: statuses, planets by year, explored reach; galaxy model: arms, regions, colony nodes', () => {
  const state = { startYear: 1950, turn: 0, explored: ['barnard', 'tau_ceti'], colonies: [{ id: 'c1', name: 'Nova Esperança', starId: 'proxima_centauri', ownerId: 'nasa' }, { id: 'c2', name: 'Arco de Órion', galaxy: { l: 209, d: 1344 } }] };
  const m = sectorModel(STARS, state, {}, 2700);
  const by = Object.fromEntries(m.stars.map((s) => [s.id, s]));
  assert.equal(by.sol.status, 'home');
  assert.equal(by.barnard.status, 'surveyed');
  assert.equal(by.proxima_centauri.status, 'colony');
  assert.equal(by.vega.status, 'observed');
  assert.ok(Math.abs(m.reach - by.tau_ceti.ly) < 1e-9, 'reach = farthest surveyed/colonised star');
  assert.ok(by.trappist_1.planets.length === 7);
  assert.equal(sectorModel(STARS, state, {}, 2010).stars.find((s) => s.id === 'trappist_1').planets.length, 0);
  // a registered explore module wins over the fallback derivation
  const viaQuery = knownSets(state, {}, (n) => (n === 'explore/state' ? { explored: ['vega'], colonies: [] } : null));
  assert.deepEqual([...viaQuery.explored], ['vega']);
  const g = galaxyModel(STARS, state, {}, m);
  assert.equal(g.arms.length, 4);
  for (const a of g.arms) {
    assert.ok(a.pts.length > 40, a.id);
    for (const [x, y] of a.pts) assert.ok(Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x, y) <= g.radius);
  }
  const sgr = g.regions.find((r) => r.id === 'sgr_a');
  assert.ok(Math.hypot(sgr.x, sgr.y) < 1, 'Sgr A* at the centre');
  assert.equal(g.regions.find((r) => r.id === 'bolha_local').status, 'home');
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['c1', 'c2']);
  assert.ok(g.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test('sector projection, label declutter and pt-BR texts', () => {
  const top = { yaw: 0, pitch: Math.PI / 2, s: 10, cx: 100, cy: 100 };
  const p = projectSector([5, 0, 0], top);
  assert.ok(Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y - 50) < 1e-9, 'galactic centre direction is up');
  const q = projectSector([0, 0, 3], { ...top, pitch: Math.PI / 4 });
  assert.ok(q.y < q.y0, 'a star above the plane has its stalk going down');
  const items = Array.from({ length: 30 }, (_, i) => ({ x: 50 + (i % 3), y: 50, w: 40, h: 12, prio: i }));
  const out = declutter(items);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    assert.ok(!(a.bx < b.bx + b.w && b.bx < a.bx + a.w && a.by < b.by + b.h && b.by < a.by + a.h), 'no overlap');
  }
  assert.ok(out.length >= 1 && out.length <= 4);
  assert.equal(out[0].prio, 29, 'highest priority placed first');
  assert.equal(starTypeText(STARS, { spec: 'M5.5V' }), 'Anã vermelha · M5.5V');
  assert.equal(travelText(4.24, 0.1), '42 anos a 10% da luz');
  assert.equal(travelText(1344, 0.1), '13440 anos a 10% da luz');
  setStarsData(STARS);
  assert.equal(starsData(), STARS);
  setStarsData(null);
});

// ------------------------------------------------------------------ world-eras.json

test('world-eras.json: every iso exists in world.json, rulers/blocs resolve, periods cover 1950–3000 without gaps', () => {
  const bad = [];
  for (const b of WE.blocs) for (const t of b.members) {
    const m = parseMember(t);
    if (m.iso && !ISOS.has(m.iso)) bad.push(`${b.id}: ${t}`);
    if (m.macro && !WORLD.countries.some((c) => c.continent === m.macro)) bad.push(`${b.id}: macro ${t}`);
    if (!Number.isFinite(m.from) && m.from !== -Infinity) bad.push(`${b.id}: data ${t}`);
  }
  for (const u of WE.unions) { if (!ISOS.has(u.lead)) bad.push(`união ${u.id} lead`); for (const i of u.members) if (!ISOS.has(i)) bad.push(`união ${u.id}: ${i}`); if (!u.members.includes(u.lead)) bad.push(`união ${u.id} sem o líder`); }
  for (const c of WE.colonies) { if (!ISOS.has(c.iso)) bad.push(`colônia ${c.iso}`); if (!WE.rulers[c.ruler]) bad.push(`metrópole ${c.ruler}`); }
  for (const x of WE.splits) { if (!ISOS.has(x.iso)) bad.push(`divisão ${x.iso}`); if (!WE.blocs.some((b) => b.id === x.bloc)) bad.push(`divisão ${x.id} bloco`); if (x.names.length !== 2) bad.push(`divisão ${x.id} nomes`); }
  assert.deepEqual(bad, []);
  const blocIds = WE.blocs.map((b) => b.id);
  assert.equal(new Set(blocIds).size, blocIds.length, 'bloc ids unique');
  for (let y = 1950; y < 3000; y += 1 / 12) assert.ok(CW.periods.some((p) => y >= p.span[0] && y < p.span[1]), `sem período em ${y.toFixed(2)}`);
  for (let i = 1; i < CW.milestones.length; i++) assert.ok(CW.milestones[i].T >= CW.milestones[i - 1].T);
  for (const m of CW.milestones) assert.ok(m.T >= 1950 && m.T <= 3000 && m.text.length <= 60, m.text);
  assert.ok(fs.statSync(path.join(root, 'data/world-eras.json')).size < 40000, 'world-eras.json leve');
});

test('date tokens: from / until (inclusive end month), macros and exclusions', () => {
  assert.equal(parseWhen('1955'), 1955);
  assert.equal(parseWhen('1955-05'), 1955 + 4 / 12);
  assert.equal(parseUntil('1991-12'), 1992);
  assert.equal(parseUntil('1991'), 1992);
  assert.equal(parseUntil(null), Infinity);
  assert.deepEqual(parseMember('DEU@1955-05'), { from: 1955 + 4 / 12, to: Infinity, exclude: false, iso: 'DEU' });
  assert.deepEqual(parseMember('RUS@1922..1991-12'), { from: 1922, to: 1992, exclude: false, iso: 'RUS' });
  assert.deepEqual(parseMember('#Africa@2090'), { from: 2090, to: Infinity, exclude: false, macro: 'Africa' });
  assert.equal(parseMember('!RUS').exclude, true);
  assert.equal(fmtFracYear(1957 + 2 / 12), 'mar/1957');
  assert.equal(fmtFracYear(1992 - 1 / 12), 'dez/1991');
});

test('Cold War map: URSS as one union in the Pacto de Varsóvia, two Germanys, colonies in Africa, NATO, non-aligned', () => {
  const y50 = at(1950);
  assert.equal(y50.period.id, 'guerra_fria');
  assert.equal(y50.blocs.sov.name, 'Bloco soviético', 'named before the 1955 pact');
  const e = at(1962, 5);
  assert.equal(e.blocs.sov.name, 'Pacto de Varsóvia');
  assert.equal(e.union.UKR.id, 'ussr');
  assert.equal(leadOf(e, 'UKR'), 'RUS');
  assert.equal(styleIn(e, null, 'UKR').key, 'sov');
  assert.equal(styleIn(e, null, 'EST').key, 'sov', 'Baltic states inside the URSS');
  assert.equal(styleIn(e, null, 'USA').key, 'nato');
  assert.equal(styleIn(e, null, 'DEU').key, 'nato', 'West Germany (whole outline) in NATO');
  assert.equal(e.split.DEU.bloc, 'sov', 'the RDA half');
  assert.equal(styleIn(e, null, 'POL').key, 'sov');
  assert.equal(styleIn(e, null, 'SVK').key, 'sov', 'Tchecoslováquia via union lead');
  assert.equal(e.union.HRV.id, 'iugoslavia');
  assert.equal(styleIn(e, null, 'HRV').key, 'nao_alinhados');
  assert.equal(styleIn(e, null, 'IND').key, 'nao_alinhados');
  assert.equal(styleIn(e, null, 'CHN').key, 'sino', 'after the Sino-Soviet split');
  assert.equal(styleIn(at(1955), null, 'CHN').key, 'aliados_sov');
  assert.equal(styleIn(e, null, 'CUB').key, 'aliados_sov');
  assert.equal(styleIn(e, null, 'BGD').key, styleIn(e, null, 'PAK').key, 'East Pakistan');
  const ken = styleIn(e, null, 'KEN');
  assert.equal(ken.colony?.ruler, 'GBR');
  assert.equal(ken.pattern, 'colony');
  assert.equal(ken.fill, WE.blocs.find((b) => b.id === 'nato').fill, 'colony shows its metropole colour');
  assert.equal(fmtFracYear(ken.colony.until), 'dez/1963');
  assert.equal(styleIn(e, null, 'GHA').colony, null, 'Ghana independent since 1957');
  assert.equal(styleIn(at(1974), null, 'AGO').colony?.ruler, 'PRT');
  assert.equal(styleIn(at(1976), null, 'AGO').key, 'aliados_sov');
  assert.ok(at(1960).split.VNM, 'two Vietnams');
  assert.equal(at(1977).split.VNM, undefined);
  assert.ok(e.milestone && e.milestone.T <= 1962 + 5 / 12);
});

test('borders move on the right month: USSR ends dec/1991, Germany reunites oct/1990, Czechoslovakia splits 1993', () => {
  assert.equal(at(1991, 11).union.UKR?.id, 'ussr');
  assert.equal(at(1992, 0).union.UKR, undefined);
  assert.equal(at(1992).period.id, 'pos_guerra_fria');
  assert.equal(styleIn(at(1995), null, 'RUS').key, 'otsc');
  assert.equal(styleIn(at(1995), null, 'UKR').key, 'neutral');
  assert.ok(at(1990, 8).split.DEU);
  assert.equal(at(1990, 9).split.DEU, undefined);
  assert.equal(at(1992, 11).union.SVK?.id, 'tchecoslovaquia');
  assert.equal(at(1993, 0).union.SVK, undefined);
  assert.equal(styleIn(at(2005), null, 'EST').key, 'nato');
  assert.equal(at(2011, 5).union.SSD?.id, 'sudao');
  assert.equal(at(2011, 6).union.SSD, undefined);
  // permanent territories stay merged with their country, quietly (no label)
  assert.equal(at(2500).union.GRL?.quiet, true);
});

test('2020–2079 uses the simulator blocs; speculative federations after; one Concórdia covers the Earth from 2450', () => {
  const sim = at(2035);
  assert.ok(sim.sim && !sim.speculative);
  const geo = { countryBloc: { USA: 'artemis', CHN: 'ilrs' }, blocLabels: { artemis: 'Acordos Artemis', ilrs: 'ILRS' } };
  assert.equal(styleIn(sim, geo, 'USA').key, 'artemis');
  assert.equal(styleIn(sim, geo, 'CHN').name, 'ILRS');
  assert.equal(styleIn(null, geo, 'BRA').key, 'neutral', 'no era file: sim blocs everywhere');
  const f = at(2100);
  assert.ok(f.speculative);
  assert.equal(styleIn(f, geo, 'NGA').key, 'africana');
  assert.equal(styleIn(f, geo, 'NGA').merge, true);
  assert.equal(styleIn(f, geo, 'BRA').key, 'austral');
  assert.equal(styleIn(at(2300), geo, 'RUS').key, 'uniao_asiatica', '!RUS keeps Russia out of the western federation');
  const c = at(2700);
  assert.equal(c.period.id, 'concordia');
  const missing = WORLD.countries.filter((x) => x.id !== 'ATA' && styleIn(c, geo, x.id).key !== 'concordia').map((x) => x.id);
  assert.deepEqual(missing, []);
  assert.equal(at(2999, 11).period.id, 'concordia');
});

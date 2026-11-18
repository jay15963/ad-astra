// Rocket builder (docs/EXPANSION.md §6, Phase B3): the parts catalog, the physics (Tsiolkovsky per stage with
// parallel boosters, liftoff TWR, structural fractions by year), catalog decompositions reproducing their capacity,
// licensing (access rules, fee, unmodified license = the original), scratch designs from family templates, the
// development program (work → test flights → operational), revisions, the catalog accessor seeing designs,
// determinism with save/load, and the painter's design adapter.
// The engine registry lists designs.js before 'missions'; the guarded splice below only matters for a build without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { vehicleDef, listVehicles } from '../src/core/catalog.js';
import { emitSignal } from '../src/core/helpers.js';
import * as designs from '../src/sim/designs.js';
import * as gating from '../src/core/gating.js';
import * as hangar from '../src/ui/hangar.js';
import * as painter from '../src/ui/launch-render/vehicles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!engine.MODULES.some(([n]) => n === 'designs')) {
  engine.MODULES.splice(engine.MODULES.findIndex(([n]) => n === 'missions'), 0, ['designs', designs]);
}
const PARTS = JSON.parse(readFileSync(join(ROOT, 'data/core/parts.json'), 'utf8'));
const withParts = (d) => (d.parts ? d : { ...d, parts: PARTS });
const lunar = withParts(await loadDataNode(ROOT));
const campaign = withParts(await loadDataNode(ROOT, { scenarioId: 'campaign', eras: 'all' }));
const P = designs.partsOf(lunar);

const game = (data = lunar, playerId = 'nasa', seed = 7) => engine.newGame(data, { seed, playerId });
const act = (st, data, a) => engine.dispatch(st, data, a);
/** Advance n turns, resolving every non-launch decision with its first available choice. */
function play(st, data, n) {
  for (let i = 0; i < n && !st.gameOver; i++) {
    for (const d of st.decisions.slice()) {
      if (d.kind === 'design/ready') continue;
      engine.resolveDecision(st, data, d.id, (d.choices?.find((c) => !c.disabled) || d.choices?.[0])?.id);
    }
    st.activeLaunch = null;
    engine.tick(st, data);
  }
}
const vehicleOf = (data, id) => data.vehicles.vehicles.find((v) => v.id === id);

// ------------------------------------------------------------------ data

test('parts.json: ids unique, kinds known, numbers positive, dates valid, pt-BR names', () => {
  const kinds = new Set(['engine', 'booster', 'upper', 'fairing', 'avionics', 'escape']);
  const seen = new Set();
  for (const p of PARTS.parts) {
    assert.match(p.id, /^[a-z0-9_]+$/, p.id);
    assert.ok(!seen.has(p.id), `id repetido ${p.id}`);
    seen.add(p.id);
    assert.ok(kinds.has(p.kind), `${p.id}: kind ${p.kind}`);
    assert.ok(typeof p.name === 'string' && p.name.length >= 3 && p.name.length <= 60, p.id);
    assert.ok(p.availableFrom?.year >= 1950 && p.availableFrom.month >= 1 && p.availableFrom.month <= 12, `${p.id}: availableFrom`);
    if (p.availableUntil) assert.ok(p.availableUntil.year * 12 + p.availableUntil.month > p.availableFrom.year * 12 + p.availableFrom.month, `${p.id}: until`);
    assert.ok(Number.isFinite(p.costM) && p.costM >= 0, `${p.id}: costM`);
    if (p.kind === 'engine') {
      assert.ok(p.thrustKN > 0 && p.ispVac > 0 && p.massT > 0 && p.bellD > 0, p.id);
      assert.ok(p.ispSL >= 0 && p.ispSL <= p.ispVac, `${p.id}: Isp nível do mar ≤ vácuo`);
      assert.ok(p.upperOnly || p.ispSL > 0, `${p.id}: motor de 1º estágio precisa de Isp no nível do mar`);
      assert.ok(P.tanks.props[p.prop], `${p.id}: propelente ${p.prop}`);
      assert.ok(p.reliability > 0.8 && p.reliability < 1, p.id);
    }
    if (p.kind === 'booster') {
      assert.ok(p.propT > 0 && p.dryT > 0 && p.d > 0 && p.len > 0, p.id);
      if (p.engineId) assert.equal(PARTS.parts.find((x) => x.id === p.engineId)?.kind, 'engine', `${p.id}: engineId`);
      else assert.ok(p.thrustKN > 0 && p.ispVac > 0, p.id);
    }
    if (p.kind === 'upper') assert.ok(p.propT > 0 && p.dryT > 0 && p.thrustKN > 0 && p.ispVac > 0, p.id);
    if (p.access && p.access !== 'generic') assert.ok(p.operator, `${p.id}: access sem operator`);
  }
  // every era has something generic to build with once the builder opens
  for (const kind of ['engine', 'fairing', 'avionics']) assert.ok(PARTS.parts.some((p) => p.kind === kind && p.access === 'generic' && p.availableFrom.year <= 1960), kind);
  assert.ok(PARTS.parts.some((p) => p.availableFrom.year >= 2200), 'peças especulativas para as eras 6–7');
  for (const k of ['leo', 'gto', 'tli', 'mars', 'outer']) assert.ok(PARTS.deltaV[k] > 9 && PARTS.deltaV[k] < 20, k);
  assert.ok(PARTS.deltaV.leo < PARTS.deltaV.gto && PARTS.deltaV.gto < PARTS.deltaV.tli && PARTS.deltaV.tli < PARTS.deltaV.mars && PARTS.deltaV.mars < PARTS.deltaV.outer);
  assert.equal(PARTS.rules.maxStages, 4);
  assert.equal(PARTS.rules.minTWR, 1.2);
  assert.deepEqual(PARTS.rules.boosterCounts, [0, 2, 4, 6]);
});

test('every catalog vehicle with a decomposition reproduces its LEO capacity within ±10% (calib per vehicle)', () => {
  const ids = Object.keys(P.designs);
  assert.ok(ids.length >= 25, 'decomposições do catálogo');
  const calibs = [];
  for (const id of ids) {
    const v = vehicleOf(campaign, id);
    assert.ok(v, `${id}: veículo existe no catálogo`);
    const spec = P.designs[id];
    const year = spec.year ?? v.availableFrom.year;
    for (const pid of designs.specPartIds(spec)) {
      const part = P.byId[pid];
      assert.ok(part, `${id}: peça ${pid}`);
      assert.ok(part.availableFrom.year * 12 + part.availableFrom.month <= Math.max(year, v.availableFrom.year) * 12 + 12, `${id}: ${pid} existe na data`);
    }
    const s = designs.designStats(campaign, spec, { year });
    assert.ok(s.ok, `${id}: ${s.errors.join('; ')}`);
    const err = Math.abs(s.capacity.leo - v.capacity.leo) / v.capacity.leo;
    assert.ok(err <= 0.1, `${id}: LEO ${s.capacity.leo} vs ${v.capacity.leo}`);
    assert.ok(spec.calib >= 0.35 && spec.calib <= 1.9, `${id}: calib ${spec.calib} plausível`);
    calibs.push(spec.calib);
    // monotone: farther destinations never carry more
    const c = s.capacity;
    assert.ok(c.leo >= c.gto && c.gto >= c.tli && c.tli >= c.mars && c.mars >= c.outer, `${id}: monotone ${JSON.stringify(c)}`);
  }
  calibs.sort((a, b) => a - b);
  const median = calibs[Math.floor(calibs.length / 2)];
  assert.ok(median > 0.8 && median < 1.25, `mediana do calib ${median}: o modelo físico é honesto`);
});

// ------------------------------------------------------------------ physics

const F9 = () => JSON.parse(JSON.stringify({ ...P.designs.falcon9, calib: 1 }));

test('designStats is pure and deterministic', () => {
  const spec = F9();
  const before = JSON.stringify(PARTS);
  const a = designs.designStats(lunar, spec, { year: 2026 });
  const b = designs.designStats(lunar, JSON.parse(JSON.stringify(spec)), { year: 2026 });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(PARTS), before);
  assert.ok(a.ok && a.capacity.leo > 5 && a.costM > 0 && a.inherent > 0.8 && a.inherent < 1);
  assert.ok(a.heightM > 40 && a.heightM < 100, `altura ${a.heightM}`);
  assert.ok(a.geometry.stages.length === 2 && a.geometry.fairing);
});

test('physics: a kick stage helps far targets; a bigger upper stage helps LEO; too much tank does not lift off', () => {
  const base = designs.designStats(lunar, F9(), { year: 2026 });
  const big = F9();
  big.stages[1].size += 2;
  assert.ok(designs.designStats(lunar, big, { year: 2026 }).capacity.leo > base.capacity.leo, 'LEO melhora com 2º estágio maior');
  const kick = F9();
  kick.stages.push({ moduleId: 'star48' });
  const s2 = designs.designStats(lunar, kick, { year: 2026 });
  assert.ok(s2.capacity.mars > base.capacity.mars * 2 && s2.capacity.outer > base.capacity.outer, 'estágio de chute leva mais longe');
  const heavy = F9();
  heavy.stages[0].size = 30;
  heavy.stages[1].size = 14;
  const s3 = designs.designStats(lunar, heavy, { year: 2026 });
  assert.equal(s3.ok, false);
  assert.match(s3.errors[0], /Não decola/);
  // more engines lift it again
  heavy.stages[0].engines = 13;
  assert.ok(designs.designStats(lunar, heavy, { year: 2026 }).ok);
});

test('physics: vacuum engines refused on stage 1; engines must fit the tank; stage cap', () => {
  const s = F9();
  s.stages[0].engineId = 'mvac';
  assert.match(designs.designStats(lunar, s, { year: 2026 }).errors[0], /vácuo/);
  const t = F9();
  t.stages[0].tank = 'd1_0';
  assert.match(designs.designStats(lunar, t, { year: 2026 }).errors.join(' '), /não cabem/);
  const u = F9();
  u.stages = [...u.stages, ...u.stages, ...u.stages];
  assert.match(designs.designStats(lunar, u, { year: 2026 }).errors[0], /No máximo 4/);
  const b = F9();
  b.boosters = { id: 'aj60a', count: 3 };
  assert.match(designs.designStats(lunar, b, { year: 2026 }).errors.join(' '), /Propulsores/);
});

test('physics: reuse costs capacity but cuts the price per flight; structures get lighter over time', () => {
  const exp = F9();
  delete exp.stages[0].reuse;
  const r = designs.designStats(lunar, F9(), { year: 2026 });
  const e = designs.designStats(lunar, exp, { year: 2026 });
  assert.ok(e.capacity.leo > r.capacity.leo);
  assert.ok(r.costM < e.costM);
  const old = designs.designStats(lunar, exp, { year: 1990 });
  assert.ok(e.capacity.leo > old.capacity.leo, 'tanques de 2026 mais leves que os de 1990');
  // reuse is only possible from 2015
  assert.match(designs.designStats(lunar, F9(), { year: 2005 }).errors.join(' '), /2015/);
  // balloon tanks: lighter, slightly less reliable
  const bal = JSON.parse(JSON.stringify(exp));
  bal.stages[0].balloon = true;
  const sb = designs.designStats(lunar, bal, { year: 2026 });
  assert.ok(sb.capacity.leo > e.capacity.leo && sb.inherent < e.inherent);
});

test('physics: a nuclear upper stage needs the research and reaches far', () => {
  const st = game();
  st.turn = 8 * 52; // 2034
  const part = P.byId.ntr_nerva;
  assert.equal(designs.partAccess(st, lunar, part).ok, false);
  assert.match(designs.partAccess(st, lunar, part).reason, /Pesquise/);
  st.research.unlocked = [...(st.research.unlocked || []), 'prop_nuclear_thermal'];
  assert.equal(designs.partAccess(st, lunar, part).ok, true);
  const sls = { ...P.designs.sls_b1b, calib: 1 };
  const chem = designs.designStats(lunar, sls, { year: 2034 });
  const nuc = designs.designStats(lunar, { ...sls, stages: [...sls.stages, { moduleId: 'ntr_stage' }] }, { year: 2034 });
  assert.ok(nuc.ok, nuc.errors.join(';'));
  assert.ok(nuc.capacity.outer > chem.capacity.outer, `externos ${nuc.capacity.outer} > ${chem.capacity.outer}`);
});

// ------------------------------------------------------------------ licensing and access

test('license: access rules (embargo, national policy), fee from cost and relation, own vehicles free', () => {
  const st = game(lunar, 'nasa');
  const lic = Object.fromEntries(designs.queries['designs/licensable'](st, lunar).map((x) => [x.vehicleId, x]));
  assert.equal(lic.long_march_5.ok, false);
  assert.match(lic.long_march_5.reason, /Embargo/);
  assert.equal(lic.ariane6.ok, false);
  assert.match(lic.ariane6.reason, /Política nacional/);
  assert.equal(lic.falcon9.ok, true);
  assert.ok(lic.falcon9.feeM > lunar.index.vehicles.falcon9.costM * 3);
  assert.equal(lic.sls_b1.feeM, 0, 'o SLS é da NASA');
  // a worse relation costs more
  const st2 = game(lunar, 'nasa');
  const key = Object.keys(st2.relations).find((k) => k.split('|').includes('spacex') && k.split('|').includes('nasa'));
  st2.relations[key].trust = 0;
  assert.ok(designs.licenseQuote(st2, lunar, 'falcon9').feeM > lic.falcon9.feeM);
  // tension above the limit refuses
  const k2 = key;
  st2.tension[k2] = 3;
  assert.equal(designs.licenseQuote(st2, lunar, 'falcon9').ok, false);
});

test('license: an unmodified license flies exactly like the original and needs no test flights', () => {
  const st = game(lunar, 'nasa');
  const cash0 = st.actors.nasa.cash;
  const r = act(st, lunar, { type: 'design/license', vehicleId: 'falcon9' });
  assert.ok(r.ok, r.error);
  assert.ok(st.actors.nasa.cash < cash0 - r.feeM + 0.01);
  const d = st.designs[r.designId];
  const f9 = lunar.index.vehicles.falcon9;
  for (const k of ['leo', 'gto', 'tli']) assert.ok(Math.abs(d.derived.capacity[k] - f9.capacity[k]) < 0.02, `${k} ${d.derived.capacity[k]} vs ${f9.capacity[k]}`);
  assert.ok(Math.abs(d.derived.costM - f9.costM) < 0.2);
  const pc = designs.programCosts(st, lunar, d);
  assert.equal(pc.needFlights, 0);
  assert.equal(pc.change, 0);
  // before development it is not in the mission pickers
  assert.ok(!listVehicles(lunar, st, { actorId: 'nasa' }).some((v) => v.id === d.id));
  assert.equal(st.designs[d.id].asVehicle.retired, true);
  const dv = act(st, lunar, { type: 'design/develop', designId: d.id });
  assert.ok(dv.ok, dv.error);
  play(st, lunar, pc.devWeeks + 2);
  assert.equal(st.designs[d.id].program.phase, 'operational');
  const v = st.designs[d.id].asVehicle;
  assert.equal(v.retired, undefined);
  assert.ok(vehicleDef(lunar, d.id, st), 'o acessor do catálogo acha o projeto');
  assert.equal(v.operator, 'nasa');
  assert.ok(listVehicles(lunar, st, { actorId: 'nasa' }).some((x) => x.id === d.id), 'aparece na escolha de veículo');
  assert.ok(!listVehicles(lunar, st, { actorId: 'cnsa' }).some((x) => x.id === d.id), 'só para o dono');
  assert.ok(st.news.some((n) => /entra em operação/.test(n.headline)));
});

test('license: a total redesign keeps nothing of the base vehicle (same numbers as the scratch design)', () => {
  const st = game(lunar, 'nasa');
  st.actors.nasa.cash = 1e6;
  const L = act(st, lunar, { type: 'design/license', vehicleId: 'falcon9' });
  assert.ok(L.ok, L.error);
  const tpl = engine.query(st, lunar, 'designs/templates').find((t) => t.ok && t.id === 'two_stage');
  assert.ok(tpl, 'modelo two_stage');
  assert.ok(act(st, lunar, { type: 'design/save', designId: L.designId, draft: { ...tpl.spec } }).ok);
  const S = act(st, lunar, { type: 'design/new', templateId: 'two_stage' });
  const dl = st.designs[L.designId];
  const ds = st.designs[S.designId];
  assert.ok(designs.sameHardware(dl.spec, ds.spec));
  assert.equal(dl.derived.kinship, 0);
  assert.equal(dl.derived.capacity.leo, ds.derived.capacity.leo);
  assert.equal(dl.derived.inherent, ds.derived.inherent);
  const pl = designs.programCosts(st, lunar, dl);
  const ps = designs.programCosts(st, lunar, ds);
  assert.equal(pl.devCostM, ps.devCostM);
  assert.equal(pl.devWeeks, ps.devWeeks);
  assert.equal(pl.needFlights, ps.needFlights);
  assert.ok(Math.abs(designs.designReliability(st, lunar, dl.id).mean - designs.designReliability(st, lunar, ds.id).mean) < 1e-9, 'sem o histórico herdado');
  // empty slots do not dilute the change: a full swap reads as a big change
  assert.ok(designs.changeFraction(dl.spec, designs.catalogDesign(lunar, 'falcon9')) >= 0.5);
});

test('physics: a tiny-thrust upper stage with a huge tank does not beat a real one (low-TWR loss below orbit)', () => {
  const f9 = designs.catalogDesign(lunar, 'falcon9');
  const stack = (size) => designs.designStats(lunar, { stages: [{ engineId: 'merlin1d', engines: 9, tank: 'd3_7', size: 24 }, { engineId: 'rl10b2', engines: 1, tank: 'd3_7', size }], boosters: null, fairingId: f9.fairingId, avionicsId: f9.avionicsId }, { year: 2026 });
  const mid = stack(4);
  const huge = stack(21);
  assert.ok(mid.ok && huge.ok);
  assert.ok(huge.stages[1].twr < 0.1);
  assert.ok(huge.capacity.leo < mid.capacity.leo, `tanque enorme ${huge.capacity.leo} t < ${mid.capacity.leo} t`);
  const exp = JSON.parse(JSON.stringify({ ...P.designs.falcon9, calib: 1 }));
  exp.stages.forEach((x) => delete x.reuse);
  assert.ok(huge.capacity.leo < designs.designStats(lunar, exp, { year: 2026 }).capacity.leo, 'abaixo do Falcon 9 descartável');
});

test('license: modified parts are recalibrated, change fraction drives the program, licensed parts stay usable', () => {
  const st = game(lunar, 'nasa');
  const r = act(st, lunar, { type: 'design/license', vehicleId: 'falcon9' });
  const d = st.designs[r.designId];
  assert.ok(d.licensedParts.includes('merlin1d'), 'motores da licença');
  // NASA cannot buy Merlins on the market, but the license brings them
  assert.equal(designs.partAccess(st, lunar, P.byId.merlin1d).ok, false);
  const spec = JSON.parse(JSON.stringify(d.spec));
  spec.stages[1].size += 2;
  const pv = designs.queries['designs/preview'](st, lunar, { designId: d.id, spec });
  assert.ok(pv.ok, pv.errors?.join(';'));
  assert.ok(pv.derived.capacity.leo > d.derived.capacity.leo);
  const c = pv.derived.capacity;
  assert.ok(c.leo >= c.gto && c.gto >= c.tli && c.tli >= c.mars && c.mars >= c.outer, 'calibrado continua monótono');
  assert.ok(pv.costs.needFlights >= 1 && pv.costs.change > 0);
  const sv = act(st, lunar, { type: 'design/save', designId: d.id, draft: { ...spec, name: 'Falcão Azul' } });
  assert.ok(sv.ok, sv.error);
  assert.equal(st.designs[d.id].name, 'Falcão Azul');
  // a part the agency cannot use is refused
  const bad = JSON.parse(JSON.stringify(spec));
  bad.stages[0].engineId = 'rd108';
  const no = act(st, lunar, { type: 'design/save', designId: d.id, draft: bad });
  assert.equal(no.ok, false);
  assert.match(no.error, /RD-108/);
});

// ------------------------------------------------------------------ scratch program, test flights, revisions

test('scratch: template → development (paid over time) → test flights (deterministic) → operational', () => {
  const run = () => {
    const st = game(lunar, 'nasa', 11);
    st.actors.nasa.cash = 20000;
    const r = act(st, lunar, { type: 'design/new', templateId: 'two_stage' });
    assert.ok(r.ok, r.error);
    const d = st.designs[r.designId];
    assert.equal(d.origin, 'scratch');
    assert.ok(d.derived.capacity.leo > 1);
    const dv = act(st, lunar, { type: 'design/develop', designId: d.id });
    assert.ok(dv.ok, dv.error);
    assert.equal(dv.needFlights, 2);
    assert.ok(Math.abs(d.program.paidM - dv.upfrontM) < 0.01);
    assert.equal(act(st, lunar, { type: 'design/save', designId: d.id, draft: d.spec }).ok, false, 'travado em desenvolvimento');
    play(st, lunar, dv.devWeeks + 1);
    assert.equal(d.program.phase, 'testFlights');
    assert.ok(d.program.paidM >= d.program.devCostM - 0.02, 'pago aos poucos até o fim');
    assert.ok(st.decisions.some((x) => x.kind === 'design/ready'));
    const log = [];
    // with the mission system (B5) a test-flight mission is offered instead; the Hangar refuses to double-book
    const viaMissions = () => (st.missions || []).filter((m) => m.testDesignId === d.id && m.status === 'planning');
    if (viaMissions().length) assert.match(act(st, lunar, { type: 'design/testFlight', designId: d.id }).error, /Missões/);
    for (let i = 0; i < 12 && d.program.phase === 'testFlights'; i++) {
      for (const m of viaMissions()) st.missions.splice(st.missions.indexOf(m), 1); // exercise the Hangar's own flights here
      const t = act(st, lunar, { type: 'design/testFlight', designId: d.id });
      assert.ok(t.ok, t.error);
      assert.equal(act(st, lunar, { type: 'design/testFlight', designId: d.id }).ok, false, 'um voo de cada vez');
      play(st, lunar, 8);
      log.push(`${d.program.testFlights}:${d.program.testOk}`);
    }
    return { st, d, log };
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.log, b.log, 'mesma semente, mesmos voos de teste');
  assert.equal(a.d.program.phase, 'operational', `voos: ${a.log.join(' ')}`);
  assert.ok(a.d.program.gap < 0.12, 'os testes amadurecem a confiabilidade');
  assert.ok(a.st.vehicleStats[a.d.id].flights >= 2);
  assert.ok(designs.designReliability(a.st, lunar, a.d.id).mean > 0.5);
});

test('revision: editing an operational design creates "Nome II" with a smaller program', () => {
  const st = game(lunar, 'nasa');
  st.actors.nasa.cash = 20000;
  const r = act(st, lunar, { type: 'design/license', vehicleId: 'falcon9' });
  act(st, lunar, { type: 'design/develop', designId: r.designId });
  play(st, lunar, 30);
  const d = st.designs[r.designId];
  assert.equal(d.program.phase, 'operational');
  const spec = JSON.parse(JSON.stringify(d.spec));
  spec.stages[1].size += 2;
  const sv = act(st, lunar, { type: 'design/save', designId: d.id, draft: spec });
  assert.ok(sv.ok && sv.revision, sv.error);
  const rev = st.designs[sv.designId];
  assert.equal(rev.parentId, d.id);
  assert.match(rev.name, / II$/);
  const pc = designs.programCosts(st, lunar, rev);
  assert.equal(pc.needFlights, 1);
  assert.ok(pc.devCostM < rev.derived.scratchDevCostM * 0.5);
  // renaming / repainting an operational design changes it in place
  const same = act(st, lunar, { type: 'design/save', designId: d.id, draft: { ...d.spec, paint: 'black', name: 'Cometa' } });
  assert.ok(same.ok && !same.revision);
  assert.equal(st.designs[d.id].name, 'Cometa');
});

test('cap, cancel, retire; mission-system test flights (B5) count through the mission/resolved signal', () => {
  const st = game(lunar, 'nasa');
  st.actors.nasa.cash = 50000;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(act(st, lunar, { type: 'design/new', templateId: 'two_stage' }).designId);
  assert.equal(act(st, lunar, { type: 'design/new', templateId: 'two_stage' }).ok, false, 'teto de 12 projetos');
  assert.ok(act(st, lunar, { type: 'design/retire', designId: ids[11] }).removed);
  assert.equal(st.designs[ids[11]], undefined);
  const id = ids[0];
  act(st, lunar, { type: 'design/develop', designId: id });
  assert.ok(act(st, lunar, { type: 'design/cancel', designId: id }).ok);
  assert.equal(st.designs[id].program, null);
  // B5 path: a 'test' mission flown by the mission system
  const d = st.designs[id];
  d.program = { phase: 'testFlights', startedTurn: 0, readyTurn: 0, devCostM: 1, paidM: 1, needFlights: 1, testFlights: 0, testOk: 0, nextTestTurn: null, paused: false, gap: 0.1 };
  st.missions.push({ id: 'mis_test_1', source: 'test', testDesignId: id, vehicleId: id, status: 'done' });
  emitSignal(st, 'mission/resolved', { missionId: 'mis_test_1', actorId: 'nasa', outcome: 'total' });
  play(st, lunar, 2);
  assert.equal(st.designs[id].program.phase, 'operational');
  assert.equal(st.designs[id].program.testOk, 1);
  const plan = designs.queries['designs/testFlightPlan'](st, lunar, ids[1]);
  assert.equal(plan, null, 'sem plano fora da fase de testes');
});

test('save/load mid-program gives the same future (JSON state, ctx.rng only)', () => {
  const st = game(lunar, 'nasa', 21);
  st.actors.nasa.cash = 20000;
  const r = act(st, lunar, { type: 'design/new', templateId: 'core_boosters' });
  act(st, lunar, { type: 'design/develop', designId: r.designId });
  const P0 = st.designs[r.designId].program;
  P0.readyTurn = st.turn + 3;
  P0.paidM = P0.devCostM;
  play(st, lunar, 4);
  act(st, lunar, { type: 'design/testFlight', designId: r.designId });
  const saved = engine.serialize(st);
  const copy = engine.deserialize(saved, lunar);
  play(st, lunar, 10);
  play(copy, lunar, 10);
  assert.deepEqual(copy.designs, st.designs);
  assert.deepEqual(copy.vehicleStats[r.designId], st.vehicleStats[r.designId]);
  assert.equal(JSON.stringify(JSON.parse(engine.serialize(st)).designs), JSON.stringify(st.designs));
});

test('preview query is pure: no state change', () => {
  const st = game(lunar, 'nasa');
  const r = act(st, lunar, { type: 'design/new', templateId: 'three_stage' });
  const before = engine.serialize(st);
  const spec = JSON.parse(JSON.stringify(st.designs[r.designId].spec));
  spec.stages[0].size = Math.max(1, spec.stages[0].size - 2);
  const pv = engine.query(st, lunar, 'designs/preview', { designId: r.designId, spec });
  assert.ok(pv.derived);
  engine.query(st, lunar, 'designs/templates');
  engine.query(st, lunar, 'designs/licensable');
  engine.query(st, lunar, 'designs/parts', { kind: 'engine' });
  assert.equal(engine.serialize(st), before);
});

// ------------------------------------------------------------------ eras, unlocks, tolerance

/** What history had by `year` (gating.historicalGrant), as research would hold it. */
function grantHistory(st, data, year) {
  st.research.unlocked = gating.historicalGrant(data, year + 1, { have: st.research.unlocked });
  st.research.keys = gating.keysOfNodes(data, st.research.unlocked);
}

test('campaign: the Hangar opens in 1957; templates use the parts of the era and the nation', () => {
  const st = game(campaign, 'nasa');
  assert.equal(designs.queries['designs/unlocked'](st, campaign).ok, false);
  assert.equal(act(st, campaign, { type: 'design/new', templateId: 'two_stage' }).ok, false);
  st.turn = (1962 - st.startYear) * 52;
  grantHistory(st, campaign, 1962); // the campaign gates the Hangar by research (MISSIONS-V2 §5.3)
  const tpls = Object.fromEntries(designs.queries['designs/templates'](st, campaign).map((t) => [t.id, t]));
  assert.ok(tpls.two_stage.ok, JSON.stringify(tpls.two_stage).slice(0, 400));
  assert.equal(tpls.reusable.ok, false);
  for (const id of designs.specPartIds(tpls.two_stage.spec)) {
    const p = P.byId[id];
    assert.ok(p.availableFrom.year <= 1962, `${id} existe em 1962`);
    assert.ok(!p.operator || p.operator === 'nasa' || p.access !== 'own', `${id}: peça soviética fora do alcance`);
  }
  const s = designs.designStats(campaign, tpls.two_stage.spec, designs.techCtxFor(st));
  assert.ok(s.ok && s.capacity.leo > 0.5, `LEO ${s.capacity.leo}`);
  // far future: speculative parts, big rockets
  st.turn = (2300 - st.startYear) * 52;
  grantHistory(st, campaign, 2300);
  const far = designs.queries['designs/templates'](st, campaign).find((t) => t.id === 'two_stage');
  assert.ok(far.ok);
  assert.ok(designs.designStats(campaign, far.spec, designs.techCtxFor(st)).capacity.leo > 10);
});

test('without data/core/parts.json the module is inert and says why', () => {
  const st = game(lunar, 'nasa');
  const bare = { ...lunar, parts: undefined };
  assert.equal(designs.partsOf(bare), null);
  assert.equal(designs.queries['designs/unlocked'](st, bare).loaded, false);
  assert.match(designs.actions['design/new'](st, bare, { templateId: 'two_stage' }).error, /peças/);
  assert.doesNotThrow(() => designs.tick(st, bare, { prevTurn: 0, dt: 1, rng: () => ({ next: () => 0.5 }) }));
  assert.deepEqual(designs.queries['designs/list'](st, bare), []);
  // a save without the slice (v2) works
  delete st.designs;
  assert.deepEqual(designs.queries['designs/list'](st, lunar), []);
  assert.ok(act(st, lunar, { type: 'design/new', templateId: 'two_stage' }).ok);
});

test('long steps (era 6–7: 26/52 weeks) still pay and finish the work phase', () => {
  const st = game(lunar, 'nasa');
  st.actors.nasa.cash = 50000;
  const r = act(st, lunar, { type: 'design/new', templateId: 'two_stage' });
  const dv = act(st, lunar, { type: 'design/develop', designId: r.designId });
  const d = st.designs[r.designId];
  for (let t = st.turn; t < st.turn + dv.devWeeks + 60; t += 52) {
    designs.tick(st, lunar, { prevTurn: t, dt: 52, turn: t, rng: () => ({ next: () => 0.5 }) });
  }
  assert.equal(d.program.phase, 'testFlights');
  assert.ok(Math.abs(d.program.paidM - d.program.devCostM) < 0.05);
});

// ------------------------------------------------------------------ painter adapter and Hangar helpers

test('painter: a design renders from its geometry (launch scene by id, Hangar by data)', () => {
  const s = designs.designStats(lunar, { ...P.designs.ariane5 }, { year: 2010 });
  const v = { id: 'dsg_99', name: 'Teste', provider: 'NASA', design: { geometry: s.geometry } };
  const art = painter.designArt(v);
  assert.equal(art.family, 'design');
  assert.deepEqual(art.parts.map((p) => p.role).filter((r) => r !== 'booster'), ['stage', 'upper']);
  assert.equal(art.parts.filter((p) => p.role === 'booster').length, 2);
  assert.ok(art.fairing && art.payloadTop > 20);
  const stack = painter.resolveStack('dsg_99', null, { vehicleData: v });
  assert.ok(stack.hasBoosters && stack.heightM > 30);
  // the launch scene only knows the id: the resolver finds the design
  painter.setDesignResolver((id) => (id === 'dsg_99' ? v : null));
  const byId = painter.resolveStack('dsg_99', null, {});
  assert.equal(byId.art.family, 'design');
  // a different geometry under the same id is a different stack (the Hangar edits in place)
  const v2 = { ...v, design: { geometry: { ...s.geometry, paint: 'black' } } };
  assert.notEqual(painter.resolveStack('dsg_99', null, { vehicleData: v2 }).id, stack.id);
  painter.setDesignResolver(null);
  // catalog ids keep their own art
  assert.notEqual(painter.vehicleArt('falcon9', null)?.family, 'design');
});

test('Hangar helpers: pt-BR formats, stable draft compare', () => {
  assert.equal(hangar.fmtT(0.354), '0,35 t');
  assert.equal(hangar.fmtT(17.5), '17,5 t');
  assert.equal(hangar.fmtWeeks(26), '6 meses');
  assert.equal(hangar.fmtWeeks(156), '3 anos');
  assert.equal(hangar.fmtDelta(0.8), '+0,8 t');
  assert.equal(hangar.fmtDelta(-0.02, 'pct'), '−2% confiança');
  assert.equal(hangar.fmtDelta(0.001), '');
  assert.equal(hangar.fmtRel(0.998), '99,8%');
  assert.equal(hangar.fmtRel(0.82), '82%');
  assert.equal(hangar.canon({ b: 1, a: { d: 2, c: 3 } }), hangar.canon({ a: { c: 3, d: 2 }, b: 1 }));
  assert.ok(hangar.capFrac(100) > hangar.capFrac(1) && hangar.capFrac(0) === 0 && hangar.capFrac(1e6) === 1);
  assert.equal(typeof hangar.render, 'function');
});

// ---------------------------------------------------------------- Missões v2: Hangar gated by research (§5.3)

const { withStubTree } = await import('./fixtures/techtree-stub.mjs');
const gatedCampaign = withStubTree(campaign);

test('v2 Hangar gating: templates and parts need research, with the node to open; research lifts it', () => {
  const st = engine.newGame(gatedCampaign, { seed: 7, playerId: 'nasa' });
  st.turn = 10 * 52; // 1960: the Hangar is open (1957) and the parts exist, but only sounding rockets are researched
  const r = act(st, gatedCampaign, { type: 'design/new', templateId: 'two_stage' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Pesquise Foguete orbital de dois estágios.');
  assert.equal(r.nodeId, 'zt1_vehicle_small');
  const tpl = engine.query(st, gatedCampaign, 'designs/templates').find((t) => t.id === 'two_stage');
  assert.equal(tpl.ok, false);
  assert.equal(tpl.nodeId, 'zt1_vehicle_small');
  // the Hangar row for that lock links to Pesquisa
  assert.equal(hangar.researchHref('zt1_vehicle_small'), '#pesquisa/n/zt1_vehicle_small');
  const hyd = engine.query(st, gatedCampaign, 'designs/parts', { kind: 'upper' }).find((p) => p.part.prop === 'hydrolox' && !p.ok && p.nodeId);
  if (hyd) {
    const opt = hangar.lockedOption(hyd);
    assert.equal(opt.disabled, undefined, 'a research lock stays tappable');
    assert.match(opt.sub, /toque para abrir a pesquisa/);
  }
  const dateLocked = hangar.lockedOption({ part: { name: 'X' }, ok: false, reason: 'Disponível em 1990' });
  assert.equal(dateLocked.disabled, true);
  // research the node: the template fills and design/new works
  st.research.unlocked.push('zt1_vehicle_small');
  st.research.needsRecompute = true;
  engine.tick(st, gatedCampaign);
  assert.ok(st.research.keys.includes('vehicle:small'));
  const ok = act(st, gatedCampaign, { type: 'design/new', templateId: 'two_stage' });
  assert.equal(ok.ok, true, ok.error);
  // the same game without techGating: dates only (v0.8 rule)
  const plain = engine.newGame(withStubTree(campaign, { gated: false }), { seed: 7, playerId: 'nasa' });
  plain.turn = 10 * 52;
  assert.equal(act(plain, withStubTree(campaign, { gated: false }), { type: 'design/new', templateId: 'two_stage' }).ok, true);
});

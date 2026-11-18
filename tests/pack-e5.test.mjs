// Era 5 pack — Expansão do Sistema, 2051–2199 (docs/EXPANSION.md §14 Phase C, builder C5).
// The pack is checked as the campaign will load it: e5's files listed in data/packs.json and the Fronteira Marciana
// scenario registered. Until the integrator adds them, the tests list them in memory (same files, same validator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, nodeReader, erasLoaded } from '../src/core/data.js';
import { loadRepoInput } from '../tools/validate-data.mjs';
import { checkData } from '../tools/validate/rules.js';
import { validateEvents } from '../src/sim/narrative.js';
import { designStats } from '../src/sim/designs.js';
import { aliveAt } from '../src/sim/lifecycle.js';
import * as engine from '../src/core/engine.js';
import { runCampaign } from '../tools/campaign.mjs';
import { dateToTurn } from '../src/core/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const E5 = path.join(root, 'data/eras/e5');
const E5_FILES = ['era', 'snapshot', 'lineages', 'lifecycle', 'patches', 'parts', 'vehicles', 'spacecraft', 'destinations', 'calendar', 'events', 'investors', 'crew'];
const SCENARIO = 'fronteira_marciana';
const SCENARIO_FILE = `scenarios/${SCENARIO}.json`;
const readE5 = (f) => JSON.parse(fs.readFileSync(path.join(E5, `${f}.json`), 'utf8'));
const withE5 = (manifest) => {
  const m = JSON.parse(JSON.stringify(manifest));
  const p = m.packs.find((x) => x.id === 'e5');
  p.files = [...new Set([...(p.files || []), ...E5_FILES])];
  m.scenarios[SCENARIO] ??= SCENARIO_FILE;
  return m;
};
const reader = async () => {
  const base = await nodeReader(root);
  return async (name) => (name === 'packs' ? withE5(await base(name)) : base(name));
};
const campaign = await loadData(await reader(), { scenarioId: 'campaign', eras: 'all' });
const F = Object.fromEntries(E5_FILES.map((f) => [f, readE5(f)]));
// the era-5 tree lives in its own pack since Missões v2 (data/tech/e5/tech.json, MISSIONS-V2 §4.3)
F.tech = JSON.parse(fs.readFileSync(path.join(root, 'data/tech/e5/tech.json'), 'utf8'));
const y = (d) => d?.year;
const ym = (d) => d.year * 12 + (d.month ?? 1) - 1; // monthBase 1 files

test('e5: validator clean with the pack listed (no errors in e5, scenarios or the merge)', () => {
  const { input } = loadRepoInput(root);
  input.manifest = withE5(input.manifest);
  for (const f of E5_FILES) {
    const t = fs.readFileSync(path.join(E5, `${f}.json`), 'utf8');
    input.packs.e5[f] = JSON.parse(t);
    input.sizes.e5[f] = Buffer.byteLength(t);
  }
  input.scenarios[SCENARIO] = JSON.parse(fs.readFileSync(path.join(root, 'data', SCENARIO_FILE), 'utf8'));
  const r = checkData(input);
  const bad = r.issues.filter((i) => i.level === 'error' && (i.pack === 'e5' || i.pack === 'manifest' || String(i.path).includes(SCENARIO)));
  assert.deepEqual(bad.map((i) => `${i.path}: ${i.message}`), []);
  assert.ok(r.stats.packBytes.e5 <= 350 * 1024, `pacote e5 com ${r.stats.packBytes.e5} B`);
});

test('e5: era meta, chapters and truth layer', () => {
  assert.equal(F.era.id, 'e5');
  assert.deepEqual([F.era.from, F.era.to], [2051, 2199]);
  assert.ok(F.era.chapters.length >= 2 && F.era.chapters.length <= 4);
  assert.equal(F.era.palette, 'ambar');
  for (const list of [F.vehicles.vehicles, F.spacecraft.spacecraft, F.calendar.missions]) {
    for (const x of list) assert.equal(x.truthLayer, 'especulacao', `${x.id}: camada`);
  }
});

test('e5: actors — lineages born inside the era, lifecycle rows dated and resolvable, snapshot covers 2051', () => {
  const ids = new Set(F.lineages.lineages.map((l) => l.id));
  for (const l of F.lineages.lineages) {
    assert.ok(l.born.year >= 2051 && l.born.year <= 2199, `${l.id}: nasce na era`);
    assert.equal(l.truthLayer, 'especulacao');
    assert.ok(l.eraProfiles?.e5?.ai?.goals?.length, `${l.id}: metas da era`);
  }
  for (const e of F.lifecycle.events) {
    assert.ok(e.date.year >= 2051 && e.date.year <= 2199 && e.date.month >= 0 && e.date.month <= 11, `${e.id}: data`);
    for (const a of [e.actor, ...(e.from || []), ...[].concat(e.into || [])].filter(Boolean)) {
      assert.ok(ids.has(a) || campaign.index.lineages[a], `${e.id}: ator ${a}`);
    }
  }
  const ops = new Set(F.lifecycle.events.map((e) => e.op));
  for (const op of ['birth', 'rename', 'merge', 'dissolve']) assert.ok(ops.has(op), `operação ${op}`);
  // the merged lineage table carries the successor identities of the real agencies
  const nasa = campaign.index.lineages.nasa;
  assert.ok(nasa.identities.some((i) => i.from.year >= 2051), 'NASA ganha identidade sucessora');
  assert.ok(nasa.eraProfiles?.e5?.ai?.goals?.length, 'NASA tem metas da era 5');
  for (const id of Object.keys(F.snapshot.actors)) assert.ok(aliveAt(campaign, id, 0, 2051), `${id} vivo em jan/2051`);
});

test('e5: vehicles — dated, monotone capacity, and the Hangar decomposition reproduces LEO within ±10%', () => {
  const parts = campaign.parts.parts;
  const byId = Object.fromEntries(parts.map((p) => [p.id, p]));
  for (const v of F.vehicles.vehicles) {
    assert.ok(v.availableFrom.year >= 2051 && v.availableFrom.year <= 2199, `${v.id}: data`);
    assert.ok(ym(v.availableUntil) > ym(v.availableFrom), `${v.id}: janela de serviço`);
    const c = v.capacity;
    assert.ok(c.leo >= c.gto && c.gto >= c.tli && c.tli >= c.mars && c.mars >= c.outer, `${v.id}: capacidade monótona`);
    assert.ok(v.design && Array.isArray(v.design.stages), `${v.id}: design`);
    for (const s of v.design.stages) {
      const pid = s.engineId || s.moduleId;
      assert.ok(byId[pid], `${v.id}: peça ${pid}`);
      assert.ok(ym(byId[pid].availableFrom) <= ym(v.availableFrom) + 12, `${v.id}: ${pid} existe na estreia`);
    }
    const s = designStats(campaign, v.design, { year: v.availableFrom.year });
    assert.ok(s.ok, `${v.id}: ${s.errors?.join('; ')}`);
    assert.ok(Math.abs(s.capacity.leo - c.leo) / c.leo <= 0.1, `${v.id}: LEO ${s.capacity.leo} vs ${c.leo}`);
    assert.ok(v.design.calib >= 0.35 && v.design.calib <= 1.9, `${v.id}: calib ${v.design.calib}`);
  }
  assert.ok(F.parts.parts.some((p) => p.prop === 'fusion' && p.family === 'fusao'), 'peças de fusão');
  assert.ok(F.parts.parts.some((p) => p.prop === 'nuclear'), 'peças nucleares');
});

test('e5: destinations — era places with windows wider than the quarterly step', () => {
  assert.ok(F.destinations.destinations.length >= 15);
  for (const d of F.destinations.destinations) {
    assert.ok(campaign.index.bodies[d.body], `${d.id}: corpo ${d.body}`);
    assert.ok(d.missionTypes?.length, `${d.id}: tipos de missão`);
    assert.ok(['leo', 'gto', 'tli', 'mars', 'outer'].includes(d.capacityKey));
    if (d.window) assert.ok(d.window.openWeeks >= 13, `${d.id}: janela abre ${d.window.openWeeks} semanas (passo de 13)`);
    for (const r of d.route) for (const n of [r.from, r.to]) assert.ok(campaign.destinations.routeNodes.some((x) => x.id === n), `${d.id}: nó ${n}`);
  }
});

test('e5: calendar — every program can fly: owner alive, hardware in service, compatible and big enough', () => {
  const V = campaign.index.vehicles; const S = campaign.index.spacecraft; const D = campaign.index.destinations;
  const items = F.calendar.missions;
  assert.ok(items.length >= 40, `${items.length} programas`);
  const ids = new Set(items.map((m) => m.id));
  for (const m of items) {
    assert.ok(m.planned.year >= 2051 && m.planned.year <= 2199, `${m.id}: data`);
    assert.ok(m.canon?.requires?.actorAlive?.includes(m.owner) && ['drop', 'reassign', 'retarget'].includes(m.canon.onBreak), `${m.id}: canon`);
    for (const p of m.prerequisites) assert.ok(ids.has(p), `${m.id}: pré-requisito ${p}`);
    const turn = dateToTurn(m.planned.year, m.planned.month - 1, 1950);
    for (const a of [m.owner, ...m.partners]) assert.ok(aliveAt(campaign, a, turn, 1950), `${m.id}: ${a} vivo em ${m.planned.year}`);
    const v = V[m.vehicleId]; const sc = S[m.spacecraftId]; const d = D[m.destination];
    assert.ok(v && sc && d, `${m.id}: hardware/destino`);
    const slipEnd = ym(m.planned) + (m.delay.maxMonths ?? 0);
    assert.ok(ym(v.availableFrom) <= ym(m.planned), `${m.id}: ${v.id} ainda não existe`);
    if (v.availableUntil) assert.ok(ym(v.availableUntil) >= slipEnd, `${m.id}: ${v.id} sai de serviço antes do atraso máximo`);
    assert.ok(ym(sc.availableFrom) <= ym(m.planned) && (!sc.availableUntil || ym(sc.availableUntil) >= slipEnd), `${m.id}: janela de ${sc.id}`);
    assert.ok(sc.compatibleVehicles.includes(v.id), `${m.id}: ${sc.id} não voa no ${v.id}`);
    assert.ok(sc.destinations.includes(d.id), `${m.id}: ${sc.id} não vai a ${d.id}`);
    assert.ok(d.missionTypes ? d.missionTypes.includes(m.type) : true, `${m.id}: tipo ${m.type} em ${d.id}`);
    if (m.crewed) assert.ok(sc.crew >= (m.crewSize || 1), `${m.id}: lugares`);
    const cap = (v.capacity[d.capacityKey] || 0) * (d.capacityFactor ?? 1);
    assert.ok(sc.massT <= cap, `${m.id}: ${sc.massT} t > ${cap.toFixed(1)} t`);
  }
  const ms = new Set(items.map((m) => m.milestone).filter(Boolean));
  for (const k of ['mars_outpost', 'mars_base', 'first_asteroid_mining', 'first_fusion_flight', 'first_colony', 'autonomous_colony']) assert.ok(ms.has(k), `marco ${k}`);
  const last = items.find((m) => m.milestone === 'autonomous_colony');
  assert.ok(last.planned.year >= 2180, 'a primeira colônia autônoma fecha a era');
});

test('e5: tech tier t5 — six branches, era 5, requirements resolve', () => {
  const nodes = F.tech.nodes;
  assert.ok(nodes.length >= 18);
  assert.deepEqual(new Set(nodes.map((n) => n.branch)).size, 6);
  for (const n of nodes) {
    assert.equal(n.era, 5);
    assert.equal(n.techTier, 't5');
    for (const r of n.requires) assert.ok(campaign.index.tech[r], `${n.id}: requer ${r}`);
  }
  for (const p of F.parts.parts) if (p.tech) assert.ok(campaign.index.tech[p.tech], `${p.id}: tecnologia ${p.tech}`);
});

test('e5: ≥120 events with year triggers inside the era, valid for the narrative engine', () => {
  const list = F.events.events;
  assert.ok(list.length >= 120, `${list.length} eventos`);
  for (const e of list) {
    assert.ok(e.trigger.fromYear >= 2051 && e.trigger.untilYear <= 2199 && e.trigger.fromYear <= e.trigger.untilYear, `${e.id}: janela de anos`);
    assert.ok(e.id.startsWith('e5_'), `${e.id}: prefixo da era`);
  }
  const errs = validateEvents(campaign).filter((x) => /e5_/.test(x));
  assert.deepEqual(errs, []);
  // spread over the four chapters
  for (const [a, b] of [[2051, 2087], [2088, 2124], [2125, 2164], [2165, 2199]]) {
    const n = list.filter((e) => e.trigger.fromYear <= b && e.trigger.untilYear >= a).length;
    assert.ok(n >= 30, `capítulo ${a}–${b}: ${n} eventos`);
  }
  assert.ok(list.filter((e) => e.kind === 'operation').length >= 6, 'eventos de operação');
});

test('e5: no card repeats word for word, and {person} cards read for anyone', () => {
  // a random card may show twice in a 150-year era: one-off stories are `once`, recurring ones carry a variant text
  for (const e of F.events.events) {
    if (e.kind === 'operation' || e.trigger.signal || (e.chain && e.chain.step > 1)) continue;
    assert.ok(e.once || e.variants?.length, `${e.id}: repete com o mesmo texto`);
  }
  // the narrative engine draws {person} from any active crew member, so the text cannot assume a gender
  const gendered = /\b(ela|ele|dele|dela|grávida|barbudo|magro|recruta|o garimpeiro|a engenheira)\b/i;
  for (const e of F.events.events) {
    const all = [e.title, e.text, ...(e.variants || []).flatMap((v) => [v.title, v.text]), ...e.choices.flatMap((c) => [c.label, c.preview])].join(' ');
    if (!all.includes('{person}') && !e.subject) continue;
    const words = [e.title, e.text, ...(e.variants || []).flatMap((v) => [v.title, v.text])].join(' ');
    assert.ok(!gendered.test(words), `${e.id}: texto com gênero para {person}: ${words.match(gendered)?.[0]}`);
  }
});

test('e5: investors, crew pools and news tone', () => {
  for (const a of F.investors.investors) assert.ok(a.names.length >= 2 && a.eras.includes('e5'));
  for (const [, pr] of Object.entries(F.investors.profiles)) for (const t of pr.templates) {
    assert.ok(t.fromYear >= 2051, `${t.id}: fromYear`);
    for (const d of t.destinations) assert.ok(campaign.index.destinations[d], `${t.id}: destino ${d}`);
  }
  for (const c of ['marciana', 'cinturao', 'selenita']) {
    assert.ok(F.crew.firstNames[c].length >= 20 && F.crew.lastNames[c].length >= 10, `nomes ${c}`);
    for (const n of F.crew.femaleNames[c]) assert.ok(F.crew.firstNames[c].includes(n));
  }
  const forbidden = new Set(campaign.crew.forbiddenNames.map((n) => n.toLowerCase()));
  const traits = new Set(campaign.crew.traits.map((t) => t.id));
  for (const [actor, list] of Object.entries(F.crew.eraRosters.e5)) {
    assert.ok(campaign.index.lineages[actor], `elenco de ${actor}`);
    for (const p of list) {
      assert.ok(!forbidden.has(p.name.toLowerCase()), `${p.id}: nome real`);
      for (const t of p.traits) assert.ok(traits.has(t), `${p.id}: traço ${t}`);
    }
  }
  assert.ok(F.era.news?.calendar?.first && F.era.news.voice);
});

test('e5: era palette css', () => {
  const css = fs.readFileSync(path.join(root, 'src/ui/css/era-5.css'), 'utf8');
  assert.match(css, /body\[data-era="e5"\]/);
  for (const t of ['--s0', '--accent', '--act', '--text']) assert.ok(css.includes(`${t}:`), t);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});

test('e5: content never predates the era (campaign before 2051 is identical with or without the pack)', () => {
  const inPack = (f, lk) => F[f][lk];
  for (const [f, lk, date] of [['vehicles', 'vehicles', 'availableFrom'], ['spacecraft', 'spacecraft', 'availableFrom'], ['calendar', 'missions', 'planned'], ['parts', 'parts', 'availableFrom']]) {
    for (const x of inPack(f, lk)) assert.ok(y(x[date]) >= 2051, `${f}#${x.id}`);
  }
  for (const t of F.tech.nodes) assert.ok(t.fromYear >= 2051, t.id);
  for (const p of F.patches.lineages) for (const i of p.identities || []) assert.ok(i.from.year >= 2051, `${p.id}: identidade`);
});

test('e5: determinism — listing the e5 pack does not change a 1950 campaign', async () => {
  const base = await nodeReader(root);
  const run = async (rd) => {
    const data = await loadData(rd, { scenarioId: 'campaign', eras: 'all' });
    const st = engine.newGame(data, { seed: 5, playerId: 'nasa' });
    for (let i = 0; i < 30; i++) {
      for (const d of [...st.decisions]) engine.dispatch(st, data, { type: 'decision/resolve', id: d.id, choiceId: (d.choices || [])[0]?.id ?? 'continue' });
      engine.dispatch(st, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    }
    // calendar/vehicleStats hold one instance per catalog item of every loaded pack (lazy instancing is §10 work)
    return JSON.stringify({ turn: st.turn, actors: st.actors, firsts: st.firsts, news: st.news.map((n) => n.headline), events: st.events?.history, crew: st.crew });
  };
  const without = async (name) => {
    const j = await base(name);
    if (name !== 'packs') return j;
    const m = JSON.parse(JSON.stringify(j));
    const p = m.packs.find((x) => x.id === 'e5');
    p.files = ['era'];
    return m;
  };
  assert.equal(await run(await reader()), await run(without));
});

test(`e5: scenario ${SCENARIO} (2051–2100) loads from the snapshot, plays and keeps save/load identical`, () => {
  return (async () => {
    const data = await loadData(await reader(), { scenarioId: SCENARIO });
    assert.equal(data.scenario.id, SCENARIO);
    // e1–e4 come in as catalog only (src/core/data.js CATALOG_FILES); e5 is the only full era pack
    assert.deepEqual(erasLoaded(data), ['e5']);
    const st = engine.newGame(data, { seed: 4242, playerId: 'shackleton' });
    assert.equal(st.startYear, 2051);
    assert.equal(st.clock.eraId, 'e5');
    assert.ok(st.actors.shackleton && st.actors.nasa && st.actors.cnsa, 'atores do snapshot');
    assert.ok(!st.actors.tharsis, 'Tharsis só nasce em 2058');
    const res = runCampaign(data, { seed: 4242, playerId: 'nasa', fast: true, maxTurns: dateToTurn(2066, 0, 2051) });
    assert.deepEqual(res.errors, []);
    const s = res.state;
    assert.ok(s.turn >= dateToTurn(2066, 0, 2051) - 13, `turno ${s.turn}`);
    assert.ok(s.actors.tharsis || s.lifecycle.applied.tharsis_born != null, 'Tharsis nasceu');
    const json = engine.serialize(s);
    assert.equal(engine.serialize(engine.deserialize(json, data)), json);
    assert.ok(json.length <= 400 * 1024, `save ${Math.round(json.length / 1024)} KB`);
  })();
});

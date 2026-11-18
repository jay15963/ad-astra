// C8 generators (src/gen/**, data/gen/**): determinism, distinct era-styled names, vocabulary ties, schema shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGen, genWorld, genName, successorName, nameRegistry, registryFromState, keyTokens, genActorDef,
  genVehicle, genSpacecraft, interstellarDestinations, genAllEvents, GEN_FILES, withArticle, standInDestinations,
} from '../src/gen/index.js';
import { makeRng } from '../src/core/rng.js';
import { validate } from '../tools/validate/schema.js';
import { vocabSets } from '../tools/validate/vocab.js';
import { validateEvent, PLACEHOLDERS } from '../src/sim/narrative.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const G = await loadGen(async (n) => readJson(n));
const N = G.names;
const data = { actorGen: readJson('core/actor-gen'), nations: readJson('core/nations'), destinations: readJson('destinations') };
const stars = readJson('core/stars');
const vocab = readJson('core/vocab');
const lineages = readJson('core/lineages').lineages;
const V = vocabSets(vocab, stars);
const inVocab = (cat, id) => V.sets[cat]?.has(id);
const schemas = {};
for (const f of fs.readdirSync(path.join(ROOT, 'data/core/schemas'))) schemas[f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/core/schemas', f), 'utf8'));
const schemaErrors = (name, v) => validate(schemas[`${name}.schema.json`], v, { registry: schemas });

const lineageRegistry = () => {
  const reg = nameRegistry(N);
  for (const l of lineages) for (const i of l.identities || []) reg.add(i.name, i.short);
  return reg;
};

// ------------------------------------------------------------------ names

test('gen: 300 births over 2031–2999 never repeat a name, a short name or a key word', () => {
  const reg = lineageRegistry();
  const rng = makeRng(99);
  const archs = data.actorGen.archetypes.filter((a) => a.id !== 'colegio_silencio');
  const emerging = data.nations.nations.filter((n) => n.emerging);
  const names = new Set(); const shorts = new Set(); const keys = new Map();
  for (let i = 0; i < 300; i++) {
    const year = 2031 + Math.floor((i * 968) / 300);
    const arch = archs[i % archs.length];
    const def = genActorDef(data, N, { archetype: arch.id, year, n: i + 1, nationId: emerging[i % emerging.length].id, rng, registry: reg });
    assert.ok(def, `def ${i}`);
    assert.ok(!names.has(def.name), `nome repetido: ${def.name}`);
    assert.ok(!shorts.has(def.short), `sigla repetida: ${def.short} (${def.name})`);
    names.add(def.name); shorts.add(def.short);
    // nation words repeat legitimately (two agencies of the same country in different centuries)
    const natWords = new Set(keyTokens(N, data.nations.nations.find((n) => n.id === def.nation)?.of || ''));
    for (const k of keyTokens(N, def.name).filter((w) => !natWords.has(w))) {
      assert.ok(!keys.has(k), `palavra-chave "${k}" repetida: ${keys.get(k)} / ${def.name}`);
      keys.set(k, def.name);
    }
    assert.match(def.id, /^gen_\d+$/);
    assert.ok(def.short.length <= 12, `sigla longa: ${def.short}`);
    assert.doesNotMatch(def.name, /\{|\}|undefined|NaN|\s{2}/, def.name);
  }
});

test('gen: no awkward names (the "SpaceX do Espaço" / "Tycho Recursos" problem)', () => {
  // successor templates never add Espaço/Espacial: agencies already are space agencies
  for (const byEra of Object.values(N.successors).filter((x) => typeof x === 'object' && !Array.isArray(x))) {
    for (const list of Object.values(byEra)) for (const t of list || []) assert.doesNotMatch(t.name, /Espa[çc]/i, t.name);
  }
  const reg = lineageRegistry();
  const rng = makeRng(5);
  const seen = new Set();
  for (const year of [2060, 2150, 2250, 2400, 2700, 2900]) {
    for (const l of lineages) {
      const last = l.identities.at(-1);
      const natId = Array.isArray(l.nation) ? l.nation.at(-1)?.id : l.nation;
      const nat = data.nations.nations.find((n) => n.id === natId);
      const s = successorName(N, { base: last.short || l.id, kind: l.kind, of: nat?.of, year, rng, registry: reg, currentName: last.name });
      if (!s) continue;
      assert.doesNotMatch(s.name, /Espa[çc]o|Nova Nova|\{|\}/, s.name);
      assert.ok(!seen.has(s.name), `sucessor repetido: ${s.name}`);
      seen.add(s.name);
    }
  }
  // the old grammar produced three "Tycho Recursos …": the same root never comes back
  const reg2 = nameRegistry(N);
  const roots = new Map();
  const rng2 = makeRng(1);
  for (let i = 0; i < 40; i++) {
    const r = genName(N, { kind: 'mining', eraId: 'e5', rng: rng2, registry: reg2 });
    const first = keyTokens(N, r.name)[0];
    if (first) { assert.ok(!roots.has(first), `${roots.get(first)} / ${r.name}`); roots.set(first, r.name); }
  }
});

test('gen: successors keep distinct short names and fall back to the lineage short', () => {
  const reg = nameRegistry(N);
  const rng = makeRng(3);
  const a = successorName(N, { base: 'NASA', kind: 'agency', of: 'dos EUA', eraId: 'e6', rng, registry: reg });
  const b = successorName(N, { base: 'ESA', kind: 'agency', of: 'da Europa', eraId: 'e6', rng, registry: reg });
  assert.ok(a && b);
  assert.notEqual(a.short, b.short);
  assert.equal(successorName(N, { base: '', kind: 'agency', eraId: 'e5', rng }), null);
  assert.doesNotMatch(successorName(N, { base: 'Nova ESA', kind: 'agency', eraId: 'e5', rng: makeRng(1), registry: nameRegistry(N) })?.name || '', /Nova Nova/);
});

test('gen: era styles differ (frontier e5, habitats e6, guilds e7)', () => {
  const sample = (eraId) => {
    const reg = nameRegistry(N);
    const rng = makeRng(11);
    return Array.from({ length: 12 }, () => genName(N, { kind: 'company', eraId, rng, registry: reg }).style);
  };
  const e5 = new Set(sample('e5')); const e6 = new Set(sample('e6')); const e7 = new Set(sample('e7'));
  assert.ok(e5.size >= 3 && e6.size >= 3 && e7.size >= 3, 'variedade de estilos por era');
  for (const s of e7) assert.ok(!e5.has(s) || s === 'casa', `estilo ${s} vazou de e5 para e7`);
  assert.equal(withArticle(N, 'Governo Autônomo de Titã', 'de'), 'do Governo Autônomo de Titã');
  assert.equal(withArticle(N, 'Estaleiros de Oberon', '', { cap: true }), 'Os Estaleiros de Oberon');
  assert.equal(withArticle(N, 'NASA', 'de'), 'da NASA');
});

test('gen: registryFromState sees live actors, tombstones and successor identities', () => {
  const state = { actors: { nasa: { name: 'NASA (EUA)', short: 'NASA' } }, lifecycle: { tombstones: { gen_1: { name: 'Tycho Recursos Ceres', short: 'Tycho' } }, idents: { esa: { name: 'ESA Estelar', short: 'ESA' } } } };
  const reg = registryFromState(N, state);
  assert.ok(reg.hasName('NASA (EUA)') && reg.hasShort('Tycho') && reg.hasName('ESA Estelar'));
  assert.ok(!reg.keyFree('Tycho') && !reg.keyFree('Ceres') && reg.keyFree('Vesta'));
});

// ------------------------------------------------------------------ determinism

test('gen: same seed -> identical world; different seed -> different world', () => {
  for (const eraId of ['e5', 'e6', 'e7']) {
    const a = genWorld(data, G, { seed: 42, eraId, stars });
    const b = genWorld(data, G, { seed: 42, eraId, stars });
    assert.deepEqual(a, b, eraId);
    const c = genWorld(data, G, { seed: 43, eraId, stars });
    assert.notDeepEqual(a.actors.map((x) => x.name), c.actors.map((x) => x.name), eraId);
    assert.ok(JSON.parse(JSON.stringify(a)), 'JSON puro');
  }
});

// ------------------------------------------------------------------ hardware, destinations, programs

test('gen: vehicles and craft match the core schemas, monotone capacity, vocab families/kinds', () => {
  const rng = makeRng(8);
  const op = { id: 'gen_1', name: 'Carcará Orbital', short: 'Carcará', country: 'Internacional', kind: 'company' };
  for (const [eraId, year] of [['e5', 2080], ['e6', 2300], ['e7', 2700]]) {
    for (let i = 0; i < 12; i++) {
      const v = genVehicle(data, G.hardware, { operator: op, year, eraId, n: i, rng, names: N });
      assert.deepEqual(schemaErrors('vehicle', v), [], `${v.id}`);
      const c = v.capacity;
      assert.ok(c.leo >= c.gto && c.gto >= c.tli && c.tli >= c.mars && c.mars >= c.outer && c.outer > 0, `${v.id} ${JSON.stringify(c)}`);
      assert.ok(inVocab('partFamilies', v.family) && inVocab('vehicleClasses', v.class), v.family);
      assert.match(v.id, /^gen_v_[a-z0-9_]+$/);
      const s = genSpacecraft(data, G.hardware, { operator: op, year, eraId, n: i, rng, names: N });
      assert.deepEqual(schemaErrors('spacecraft', s), [], `${s.id}`);
      assert.ok(inVocab('spacecraftKinds', s.kind) && !vocab.spacecraftKinds[s.kind].status, s.kind);
      assert.match(s.id, /^gen_c_[a-z0-9_]+$/);
      for (const t of [v.notes, s.notes]) assert.doesNotMatch(t, /undefined|NaN|\{|\d\.\d{3,}/, t);
    }
  }
});

test('gen: interstellar destinations use the frozen vocab families and the destination schema', () => {
  const fam = Object.fromEntries(vocab.destinationFamilies.map((f) => [f.id, f]));
  for (const f of G.destinations.families) assert.equal(f.pattern, fam[f.id]?.pattern, `família ${f.id} difere do vocabulário`);
  const list = interstellarDestinations(stars, G.destinations);
  assert.ok(list.length > 100);
  const ids = new Set();
  for (const d of list) {
    assert.ok(inVocab('destinations', d.id), `destino fora do vocabulário: ${d.id}`);
    assert.ok(inVocab('bodies', d.body), d.body);
    assert.deepEqual(schemaErrors('destination', d), [], d.id);
    assert.ok(!ids.has(d.id)); ids.add(d.id);
    for (const m of Object.values(d.firsts)) assert.ok(inVocab('milestones', m), m);
    assert.ok(d.transitWeeks > 0 && d.transitWeeksCrewed >= d.transitWeeks);
  }
  const prox = list.find((d) => d.id === 'proxima_centauri_system');
  assert.ok(prox && Math.abs(prox.transitWeeks / 52 - 43) < 2, 'Proxima a 0,1c: ~43 anos');
});

test('gen: programs are valid calendar items with fitting hardware, inside the era and the campaign', () => {
  for (const eraId of ['e5', 'e6', 'e7']) {
    for (const seed of [1, 2, 3]) {
      const w = genWorld(data, G, { seed, eraId, stars, programs: 8 });
      const vById = Object.fromEntries(w.vehicles.map((v) => [v.id, v]));
      const sById = Object.fromEntries(w.spacecraft.map((s) => [s.id, s]));
      const owners = Object.fromEntries(w.actors.map((a) => [a.id, a]));
      const allDests = [...interstellarDestinations(stars, G.destinations, { eraId }), ...standInDestinations(G.destinations, eraId)];
      assert.ok(w.programs.length >= 3, `${eraId}/${seed}: poucos programas (${w.programs.length})`);
      const ids = new Set();
      for (const p of w.programs) {
        assert.deepEqual(schemaErrors('calendar-mission', p), [], `${p.id}`);
        assert.ok(!ids.has(p.id)); ids.add(p.id);
        assert.match(p.id, /^gen_p_/);
        assert.ok(inVocab('missionTypes', p.type) && inVocab('destinations', p.destination), `${p.type} ${p.destination}`);
        if (p.milestone) assert.ok(inVocab('milestones', p.milestone), p.milestone);
        const v = vById[p.vehicleId]; const s = sById[p.spacecraftId];
        assert.ok(v && s, `${p.id}: hardware`);
        const d = data.destinations.destinations.find((x) => x.id === p.destination) || allDests.find((x) => x.id === p.destination);
        const capKey = d?.capacityKey || 'outer';
        assert.ok((v.capacity[capKey] || 0) >= s.massT, `${p.id}: ${v.name} não leva ${s.name} (${s.massT} t)`);
        assert.ok((s.destinations || []).includes(p.destination), `${p.id}: nave sem o destino`);
        if (p.crewed) assert.ok(owners[p.owner].capabilities.crewed, `${p.id}: dono sem voo tripulado`);
        const range = { e5: [2051, 2199], e6: [2200, 2599], e7: [2600, 2999] }[eraId];
        assert.ok(p.planned.year >= range[0] && p.planned.year <= range[1], `${p.id}: ${p.planned.year}`);
        if (d?.transitWeeks) assert.ok(p.planned.year + d.transitWeeks / 52 <= 3000, `${p.id}: chega depois de 3000`);
        assert.doesNotMatch(p.description, /\{|\}|undefined|NaN/, p.description);
        for (const pre of p.prerequisites) assert.ok(ids.has(pre), `${p.id}: pré-requisito ${pre}`);
      }
    }
  }
});

test('gen: review regressions (owner lifespan, crew room, class names, follow-up prose, successor variety)', () => {
  for (const eraId of ['e5', 'e6', 'e7']) {
    for (const seed of [1, 2, 3, 7, 11]) {
      const w = genWorld(data, G, { seed, eraId, stars, programs: 8 });
      const owners = Object.fromEntries(w.actors.map((a) => [a.id, a]));
      const byProgram = {};
      for (const p of w.programs) {
        // nobody flies before it exists ("Concórdia de Trappist" born 2927 flying in 2611)
        assert.ok(p.planned.year > owners[p.owner].born.year, `${p.id}: dono nasce em ${owners[p.owner].born.year}`);
        (byProgram[`${p.owner}:${p.program}:${p.name.replace(/ [IVX]+$/, '')}`] ||= []).push(p);
      }
      // flight II never repeats the "first time" text of flight I
      for (const list of Object.values(byProgram)) {
        if (list.length > 1) assert.equal(new Set(list.map((p) => p.description)).size, list.length, list[0].name);
      }
      for (const v of w.vehicles) if (v.class === 'medium') assert.doesNotMatch(v.name, /Pesado/, v.name);
      for (const c of w.spacecraft) {
        const spec = G.hardware.spacecraft[eraId].kinds.find((k) => k.kind === c.kind);
        if (c.crew && spec?.tPerPerson && !/Montada em órbita/.test(c.notes)) assert.ok(c.massT >= c.crew * spec.tPerPerson - 1, `${c.name}: ${c.crew} pessoas em ${c.massT} t`);
      }
    }
  }
  // successors of ten live lineages in one era never share one template more than four times
  const reg = nameRegistry(G.names);
  for (const eraId of ['e5', 'e6', 'e7']) {
    const count = {};
    const OF = { NASA: 'dos EUA', Roscosmos: 'da Rússia', CNSA: 'da China', ESA: 'da Europa', ISRO: 'da Índia', JAXA: 'do Japão', AEB: 'do Brasil', KASA: 'da Coreia', UAESA: 'dos Emirados', CSA: 'do Canadá' };
    for (const [base, of] of Object.entries(OF)) {
      const s = successorName(G.names, { base, kind: 'agency', of, eraId, seed: 5, registry: reg });
      if (s) count[s.style] = (count[s.style] || 0) + 1;
    }
    for (const [st, n] of Object.entries(count)) assert.ok(n <= 4, `${eraId}: ${n}× ${st}`);
  }
});

// ------------------------------------------------------------------ events

test('gen: events pass the narrative DSL, keep only engine placeholders and use vocab groups/tags', () => {
  const evs = genAllEvents(G.events, { seed: 7 });
  const ids = new Set(evs.map((e) => e.id));
  assert.equal(ids.size, evs.length, 'ids únicos');
  const titles = {};
  for (const e of evs) {
    assert.deepEqual(validateEvent(e, {}, ids), [], e.id);
    assert.match(e.id, /^gen_ev_e[5-7]_/);
    assert.ok(inVocab('eventGroups', e.group), e.group);
    for (const t of e.tags) assert.ok(inVocab('eventTags', t), t);
    for (const m of JSON.stringify(e).matchAll(/\{(\w+)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]), `${e.id}: marcador {${m[1]}}`);
    const key = `${e.era}:${e.title}`;
    assert.ok(!titles[key], `título repetido na era: ${e.title}`);
    titles[key] = true;
    assert.ok(e.trigger.fromYear >= 2051 && e.trigger.untilYear <= 2999);
  }
  for (const eraId of ['e5', 'e6', 'e7']) assert.ok(evs.filter((e) => e.era === eraId).length >= 15, `${eraId}: eventos`);
});

// ------------------------------------------------------------------ data files

test('gen: data/gen ties to the vocabulary and stays small', () => {
  let bytes = 0;
  for (const f of GEN_FILES) bytes += fs.statSync(path.join(ROOT, 'data/gen', `${f}.json`)).size;
  assert.ok(bytes < 120 * 1024, `data/gen ${bytes} B`);
  // archetype styles cover every actor-gen archetype
  for (const a of data.actorGen.archetypes) assert.ok(N.archetypeStyle[a.id], `estilo para ${a.id}`);
  for (const [eraId, list] of Object.entries(G.programs.programs)) {
    for (const t of list) {
      assert.ok(inVocab('missionTypes', t.type) && !vocab.missionTypes[t.type].status, `${eraId}/${t.id}: ${t.type}`);
      if (t.milestone) assert.ok(inVocab('milestones', t.milestone), `${t.id}: ${t.milestone}`);
      for (const d of t.destinations || []) assert.ok(inVocab('destinations', d), `${t.id}: ${d}`);
      if (t.family) assert.ok(vocab.destinationFamilies.some((f) => f.id === t.family), t.family);
    }
  }
  for (const [eraId, T] of Object.entries(G.hardware.vehicles)) for (const f of T.families) assert.ok(inVocab('partFamilies', f), `${eraId}: ${f}`);
  for (const d of G.destinations.standIns) assert.equal(d.kind, vocab.destinations[d.id]?.kind, `stand-in ${d.id}`);
  for (const T of Object.values(G.hardware.spacecraft)) for (const k of T.kinds) assert.ok(inVocab('spacecraftKinds', k.kind) && !vocab.spacecraftKinds[k.kind].status, k.kind);
});

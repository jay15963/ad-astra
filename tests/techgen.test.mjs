// Generated efficiency nodes (src/core/techgen.js, docs/MISSIONS-V2.md §4.3): ids, chain, interpolation, texts,
// stability, and the packs.assemble hook (templates expanded right before a tech file is merged).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandTemplate, expandTemplates, expand, prepareTechFile, effectTexts, GEN_ID } from '../src/core/techgen.js';
import { assemble, packHash } from '../src/core/packs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const LABELS = { launchCost: { label: 'custo de lançamento', unit: 'pct' }, maintenance: { label: 'manutenção', unit: 'pctNeg' }, dockingReliability: { label: 'acoplagem', unit: 'pp' } };
const TPL = {
  id: 'lc', branch: 'propulsion', effect: 'launchCost', values: [-0.02, -0.02, -0.03],
  names: ['Turbobombas mais leves', 'Injetores coaxiais', 'Bocais regenerativos'], shorts: ['Turbobombas', 'Injetores', 'Bocais'],
  icon: '🔥', after: 'e1_prop_turbopump', alsoAfter: ['e1_struct_aluminium'], years: [1952, 1974], cost: [40, 90], science: [8, 20], weeks: [12, 24],
  desc: '{name}: {effect}.',
};

test('expandTemplate: ids g<n>_<branch>_<id>_<i>, chained requires, one effect per node', () => {
  const nodes = expandTemplate(TPL, { era: 1, labels: LABELS });
  assert.deepEqual(nodes.map((n) => n.id), ['g1_propulsion_lc_1', 'g1_propulsion_lc_2', 'g1_propulsion_lc_3']);
  assert.deepEqual(nodes[0].requires, ['e1_prop_turbopump', 'e1_struct_aluminium']);
  assert.deepEqual(nodes[1].requires, ['g1_propulsion_lc_1']);
  assert.deepEqual(nodes[2].requires, ['g1_propulsion_lc_2']);
  assert.deepEqual(nodes.map((n) => n.effects), [{ launchCost: -0.02 }, { launchCost: -0.02 }, { launchCost: -0.03 }]);
  for (const n of nodes) {
    assert.ok(GEN_ID.test(n.id));
    assert.equal(n.era, 1);
    assert.equal(n.techTier, 't1');
    assert.equal(n.branch, 'propulsion');
    assert.equal(n.generated, 'lc');
    assert.ok(!n.unlocks, 'generated nodes are efficiency nodes');
  }
  assert.deepEqual(nodes.map((n) => n.name), TPL.names);
  assert.deepEqual(nodes.map((n) => n.short), TPL.shorts);
});

test('expandTemplate: linear interpolation of years, cost (×5), science and weeks', () => {
  const [a, b, c] = expandTemplate(TPL, { era: 1, labels: LABELS });
  assert.deepEqual([a.histYear, b.histYear, c.histYear], [1952, 1963, 1974]);
  assert.deepEqual([a.fromYear, b.fromYear, c.fromYear], [1952, 1963, 1974]);
  assert.deepEqual([a.cost, b.cost, c.cost], [40, 65, 90]);
  assert.deepEqual([a.science, b.science, c.science], [8, 14, 20]);
  assert.deepEqual([a.weeks, b.weeks, c.weeks], [12, 18, 24]);
  for (const n of [a, b, c]) assert.equal(n.cost % 5, 0);
  // one value: the start of every range
  const [solo] = expandTemplate({ ...TPL, values: [0.01], names: ['Só'], shorts: ['Só'] }, { era: 2 });
  assert.equal(solo.id, 'g2_propulsion_lc_1');
  assert.equal(solo.histYear, 1952);
  assert.equal(solo.cost, 40);
});

test('description: {name} and {effect} filled with pt-BR effect text', () => {
  const [a] = expandTemplate(TPL, { era: 1, labels: LABELS });
  assert.equal(a.description, 'Turbobombas mais leves: −2% custo de lançamento.');
  assert.deepEqual(effectTexts(LABELS, { maintenance: -0.035 }), ['−3,5% manutenção']);
  assert.deepEqual(effectTexts(LABELS, { dockingReliability: 0.015 }), ['+1,5 p.p. acoplagem']);
  assert.deepEqual(effectTexts({}, { marketInterest: 3 }), ['+3 marketInterest'], 'unknown labels fall back to the key');
  for (const n of expandTemplate(TPL, { era: 1 })) assert.ok(n.description.length <= 160);
});

test('stability: appending a value keeps the existing nodes; expansion is pure', () => {
  const before = expandTemplate(TPL, { era: 1, labels: LABELS });
  const longer = { ...TPL, values: [...TPL.values, -0.04], names: [...TPL.names, 'Quarto'], shorts: [...TPL.shorts, 'Quarto'], years: [1952, 1974] };
  const after = expandTemplate(longer, { era: 1, labels: LABELS });
  assert.deepEqual(after.slice(0, 3).map((n) => [n.id, n.requires, n.effects, n.name]), before.map((n) => [n.id, n.requires, n.effects, n.name]));
  assert.equal(after[3].id, 'g1_propulsion_lc_4');
  const snapshot = JSON.stringify(TPL);
  expandTemplate(TPL, { era: 1, labels: LABELS });
  assert.equal(JSON.stringify(TPL), snapshot, 'template not mutated');
  assert.deepEqual(expandTemplate(TPL, { era: 1, labels: LABELS }), before, 'same input, same nodes');
});

test('expand / prepareTechFile: authored first, generated after; templates and file era dropped', () => {
  const file = { _doc: 'x', era: 3, techTier: 't3', nodes: [{ id: 'a', branch: 'science', era: 3, requires: [], effects: {} }], templates: [{ ...TPL, after: 'a', alsoAfter: undefined }] };
  const all = expand(file, { labels: LABELS });
  assert.deepEqual(all.map((n) => n.id), ['a', 'g3_propulsion_lc_1', 'g3_propulsion_lc_2', 'g3_propulsion_lc_3']);
  assert.deepEqual(expandTemplates(file).map((n) => n.era), [3, 3, 3], 'era from the file');
  const prepared = prepareTechFile(file, { labels: LABELS });
  assert.equal(prepared.templates, undefined);
  assert.equal(prepared.era, undefined);
  assert.equal(prepared._doc, 'x');
  assert.equal(prepared.nodes.length, 4);
  // a file without templates (data/tech.json) is returned as is
  const legacy = { nodes: [{ id: 'z' }], config: {} };
  assert.equal(prepareTechFile(legacy), legacy);
});

test('packs.assemble expands the templates of a tech pack before indexing; hashes cover the templates', () => {
  const manifest = { version: 1, packs: [
    { id: 'core', always: true, dir: 'core/', files: ['techtree'] },
    { id: 'tech-e1', kind: 'tech', techEra: 'e1', eras: ['e1'], dir: 'tech/e1/', files: ['tech'], exclude: ['lunar_race'] },
  ], scenarios: {} };
  const techFile = { era: 1, techTier: 't1', nodes: [{ id: 'e1_prop_turbopump', branch: 'propulsion', era: 1, requires: [], effects: {} }], templates: [{ ...TPL, alsoAfter: [] }] };
  const raw = { core: { files: { techtree: { effectLabels: LABELS } }, hash: 'c' }, 'tech-e1': { files: { tech: techFile }, hash: packHash({ tech: techFile }, ['tech']) } };
  const data = assemble(manifest, raw, ['core', 'tech-e1'], { scenario: { id: 'campaign', kind: 'campaign', start: { year: 1950 } }, scenarioId: 'campaign' });
  assert.equal(data.tech.nodes.length, 4);
  assert.ok(data.index.tech.g1_propulsion_lc_3, 'generated node indexed');
  assert.equal(data.index.tech.g1_propulsion_lc_1.description, 'Turbobombas mais leves: −2% custo de lançamento.', 'labels from core/techtree.json');
  assert.equal(data.tech.templates, undefined);
  assert.deepEqual(data.packWarnings, []);
  // exclude: the pack does not exist for the Corrida Lunar
  const lunar = assemble(manifest, raw, ['core', 'tech-e1'], { scenario: { id: 'lunar_race', startYear: 2026, endYear: 2030 }, scenarioId: 'lunar_race' });
  assert.equal(lunar.tech, undefined);
  assert.equal(lunar.packsLoaded['tech-e1'], undefined);
  // the hash changes when a template changes
  const changed = { ...techFile, templates: [{ ...TPL, values: [-0.05, -0.02, -0.03] }] };
  assert.notEqual(packHash({ tech: changed }, ['tech']), raw['tech-e1'].hash);
});

test('repository tech files: every template expands to unique, prefixed, chained nodes', () => {
  const seen = new Set();
  for (const e of [1, 2, 3, 4, 5, 6, 7]) {
    const file = readJson(`tech/e${e}/tech`);
    assert.ok(Array.isArray(file.templates) && file.templates.length >= 1, `e${e} templates`);
    for (const tp of file.templates) assert.equal(tp.names.length, tp.values.length, `${e}/${tp.id}`);
    const gen = expandTemplates(file);
    for (const n of gen) {
      assert.ok(n.id.startsWith(`g${e}_`), n.id);
      assert.ok(!seen.has(n.id), `dup ${n.id}`);
      seen.add(n.id);
    }
    for (const n of file.nodes) assert.ok(!GEN_ID.test(n.id), `authored ${n.id} uses the generated prefix`);
  }
  assert.ok(seen.size >= 180, `generated nodes: ${seen.size}`);
});

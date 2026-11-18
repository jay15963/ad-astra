// Mini JSON-Schema engine (tools/validate/schema.js) and the schemas of every data kind (data/core/schemas),
// including the truth layers. Contract: docs/EXPANSION.md §4.4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../tools/validate/schema.js';
import { ITEM_SCHEMAS, FILE_SCHEMAS } from '../tools/validate/rules.js';
import { LIST_KEYS } from '../src/core/packs.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdir = path.join(root, 'data', 'core', 'schemas');
const schemas = Object.fromEntries(fs.readdirSync(sdir).filter((f) => f.endsWith('.schema.json'))
  .map((f) => [f, JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8'))]));
const S = (n) => schemas[`${n}.schema.json`];
const v = (n, value) => validate(S(n), value, { registry: schemas });
const readRaw = (n) => JSON.parse(fs.readFileSync(path.join(root, 'data', `${n}.json`), 'utf8'));

test('engine: types, required, enum, ranges, pattern, items, additionalProperties', () => {
  const s = {
    type: 'object', required: ['id', 'n'], additionalProperties: false,
    properties: {
      id: { type: 'string', pattern: '^[a-z]+$' }, n: { type: 'integer', minimum: 0, maximum: 3 },
      k: { enum: ['a', 'b'] }, l: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'number' } }, t: { type: 'string', maxLength: 3 },
    },
  };
  assert.deepEqual(validate(s, { id: 'ab', n: 2, k: 'a', l: [1, 2], t: 'abc' }), []);
  const errs = validate(s, { id: 'A1', n: 4.5, k: 'c', l: [1, 1, 'x'], t: 'abcd', extra: 1 });
  const paths = errs.map((e) => e.path).sort();
  assert.deepEqual(paths, ['extra', 'id', 'k', 'l[1]', 'l[2]', 'n', 't'].sort());
  assert.ok(errs.every((e) => typeof e.message === 'string' && e.message.length > 3));
  assert.match(validate(s, { n: 1 })[0].message, /obrigatório ausente: id/);
  assert.match(validate({ type: 'integer' }, 1.5)[0].message, /tipo errado/);
  assert.equal(validate({ type: 'number' }, NaN).length, 1, 'NaN is not a number for data');
});

test('engine: $ref (local and cross-file), anyOf, oneOf, not, const', () => {
  const reg = { 'c.schema.json': { $defs: { pos: { type: 'number', minimum: 0 } } } };
  const s = { $defs: { id: { type: 'string' } }, type: 'object', properties: { a: { $ref: '#/$defs/id' }, b: { $ref: 'c.schema.json#/$defs/pos' } } };
  assert.deepEqual(validate(s, { a: 'x', b: 1 }, { registry: reg }), []);
  assert.equal(validate(s, { a: 1, b: -1 }, { registry: reg }).length, 2);
  assert.match(validate({ $ref: 'nada.schema.json#/x' }, 1)[0].message, /desconhecido/);
  assert.equal(validate({ anyOf: [{ type: 'null' }, { type: 'string' }] }, null).length, 0);
  assert.equal(validate({ anyOf: [{ type: 'null' }, { type: 'string' }] }, 1).length, 1);
  assert.equal(validate({ oneOf: [{ type: 'number' }, { type: 'integer' }] }, 1).length, 1, 'matches both');
  assert.equal(validate({ not: { const: 'x' } }, 'x').length, 1);
  assert.equal(validate({ const: 1 }, 1).length, 0);
});

test('every data kind has a schema, and every schema parses with resolvable $refs', () => {
  for (const n of [...Object.values(ITEM_SCHEMAS), ...Object.values(FILE_SCHEMAS), 'common', 'scenario', 'scenario-index', 'packs']) {
    assert.ok(S(n), `${n}.schema.json missing`);
    assert.equal(S(n).$id, `${n}.schema.json`);
  }
  for (const f of Object.keys(ITEM_SCHEMAS)) assert.ok(LIST_KEYS[f], `list key of ${f}`);
  const refs = [];
  const scan = (o) => { if (o && typeof o === 'object') for (const [k, x] of Object.entries(o)) { if (k === '$ref') refs.push(x); else scan(x); } };
  scan(schemas);
  for (const r of refs) {
    const [file] = r.split('#');
    if (file) assert.ok(schemas[file], `$ref ${r}`);
  }
});

test('every legacy entity (data/*.json) passes its schema', () => {
  for (const [file, schema] of Object.entries(ITEM_SCHEMAS)) {
    let json;
    try { json = readRaw(file); } catch { continue; } // core files live under data/core
    for (const item of json[LIST_KEYS[file]]) assert.deepEqual(v(schema, item), [], `${file}#${item.id}`);
  }
  assert.deepEqual(v('scenario', readRaw('scenario')), []);
  assert.deepEqual(v('scenario', readRaw('scenarios/campaign')), []);
  assert.deepEqual(v('scenario-index', readRaw('scenarios/index')), []);
  assert.deepEqual(v('packs', readRaw('packs')), []);
  for (const e of ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']) assert.deepEqual(v('era-meta', readRaw(`eras/${e}/era`)), [], e);
});

test('truth layers: only the four layers of §2.3 are accepted, everywhere they appear', () => {
  const layers = S('common').$defs.truthLayer.enum;
  assert.deepEqual(layers, ['fato', 'plano_oficial', 'projecao', 'especulacao']);
  const veh = readRaw('vehicles').vehicles[0];
  assert.deepEqual(v('vehicle', { ...veh, truthLayer: 'especulacao' }), []);
  assert.equal(v('vehicle', { ...veh, truthLayer: 'boato' }).length, 1);
  const cal = readRaw('calendar').missions[0];
  assert.equal(v('calendar-mission', { ...cal, truthLayer: 'lenda' }).length, 1);
  assert.equal(v('lifecycle-event', { id: 'x', date: { year: 1958, month: 9 }, op: 'rename', truthLayer: 'mito' }).length, 1);
  assert.equal(v('lineage', { id: 'x', kind: 'agency', identities: [{ from: 1950, name: 'X' }], truthLayer: 'fato' }).length, 0);
});

test('schemas catch the usual authoring mistakes', () => {
  const veh = readRaw('vehicles').vehicles[0];
  assert.ok(v('vehicle', { ...veh, id: 'Falcon-9' }).some((e) => e.path === 'id'));
  assert.ok(v('vehicle', { ...veh, costM: -1 }).some((e) => e.path === 'costM'));
  assert.ok(v('vehicle', { ...veh, availableFrom: { month: 3 } }).some((e) => e.path === 'availableFrom'));
  const { capacity, ...noCap } = veh;
  assert.ok(capacity && v('vehicle', noCap).some((e) => /capacity/.test(e.message)));
  const ev = readRaw('events').events[0];
  assert.ok(v('event', { ...ev, choices: [] }).some((e) => e.path === 'choices'));
  assert.ok(v('event', { ...ev, kind: 'cutscene' }).length);
  assert.ok(v('lifecycle-event', { id: 'x', date: { year: 1958 }, op: 'explode' }).some((e) => e.path === 'op'));
  assert.ok(v('lineage', { id: 'x', kind: 'agency', identities: [] }).some((e) => e.path === 'identities'));
  assert.ok(v('ending', { choices: [{ id: 'contato', label: 'C' }] }).length, 'the three endings are required');
  assert.ok(v('scenario', { id: 'x', name: 'X' }).length, 'neither format');
  assert.ok(v('packs', { version: 1, packs: [{ id: 'a', dir: 'x', files: ['f'] }], scenarios: {} }).some((e) => /dir/.test(e.path)));
});

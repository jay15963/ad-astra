// Emblem system (docs/EXPANSION.md §5.4, Phase B builder B1): layered procedural SVG emblems for every agency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/ui/emblem.js';
import { emblemSVG as portraitEmblem } from '../src/ui/portrait.js';
import { sanitizeEmblem } from '../src/sim/lifecycle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
const parts = read('core/emblem-parts.json');
const book = read('core/emblems.json');
const lineages = read('core/lineages.json').lineages;
E.useEmblemData({ emblemParts: parts, emblems: book });

const wellFormed = (svg, what) => {
  assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100"/, what);
  assert.ok(svg.endsWith('</svg>'), what);
  assert.ok(!/undefined|NaN|null|\[object/.test(svg), `${what}: bad token`);
  assert.equal((svg.match(/<g[ >]/g) || []).length, (svg.match(/<\/g>/g) || []).length, `${what}: balanced <g>`);
  assert.equal((svg.match(/<text[ >]/g) || []).length, (svg.match(/<\/text>/g) || []).length, `${what}: balanced <text>`);
};

test('every shape × glyph × division renders valid SVG at the three levels of detail', () => {
  const glyphs = E.glyphIds();
  assert.ok(glyphs.includes('satellite') && glyphs.includes('crescent'), 'extra glyphs from emblem-parts.json');
  for (const shape of E.SHAPES) for (const glyph of glyphs) for (const division of E.DIVISIONS) {
    const spec = { shape, glyph, division, field: '#13294b', field2: '#1f3d6e', glyphColor: '#f2f4f7', accent: '#d6453d', stars: 5, orbit: 2, label: 'TESTE', ring: { color: '#0a1830', text: 'LEMA DE TESTE' } };
    for (const size of [24, 56, 120]) wellFormed(E.emblemSVG(spec, { size }), `${shape}/${glyph}/${division}@${size}`);
  }
});

test('level of detail: no text when small, label at list size, motto at full size', () => {
  const spec = { shape: 'shield', field: '#9e1b1b', glyph: 'rocket', label: 'OKB', ring: { color: '#5c0b0e', text: 'MOTE' } };
  assert.ok(!/<text/.test(E.emblemSVG(spec, { size: 30 })), 'header size has no text');
  assert.match(E.emblemSVG(spec, { size: 56 }), />OKB</);
  assert.match(E.emblemSVG(spec, { size: 120 }), />MOTE</);
  const ring = { shape: 'roundel', field: '#0b3d91', glyph: 'rocket', label: 'NASA', ring: { color: '#e9edf2', text: 'NASA · EUA' } };
  assert.match(E.emblemSVG(ring, { size: 120 }), /textPath[^>]*>NASA · EUA</);
});

test('specs are sanitized: colours, enums, markup, size', () => {
  const n = E.normalizeSpec({ shape: 'x', field: 'javascript:', glyph: '<script>', stars: 99, orbit: -4, label: '<b>abc</b>defg', ring: { color: 'red', text: '<img onerror=1>' } });
  assert.equal(n.shape, 'roundel');
  assert.match(n.field, /^#[0-9a-f]{6}$/);
  assert.equal(n.glyph, 'star');
  assert.equal(n.stars, 12);
  assert.equal(n.orbit, 0);
  assert.ok(!/[<>]/.test(n.label) && n.label.length <= 6);
  assert.ok(!/[<>]/.test(n.ring.text));
  const svg = E.emblemSVG({ label: '<script>alert(1)</script>', ring: { color: '#000', text: '"><svg onload=1>' } }, { size: 120, title: '<x>' });
  assert.ok(!/<script|onload|<x>/.test(svg));
  const big = E.compactSpec({ shape: 'roundel', field: '#123456', field2: '#654321', division: 'quarter', glyph: 'capsule', glyphColor: '#ffffff', accent: '#ff0000', orbit: 2, stars: 12, label: 'ABCDEF', ring: { color: '#000000', text: 'UM LEMA BEM COMPRIDO AQ' } });
  assert.ok(E.specBytes(big) <= E.MAX_SPEC_BYTES, `compact spec ≤ 200 B (${E.specBytes(big)})`);
  // the sim validator agrees with the UI on what is acceptable
  const s = sanitizeEmblem(big, { emblemParts: parts });
  assert.ok(s && JSON.stringify(s).length <= 200);
  assert.equal(sanitizeEmblem({ shape: 'blob', field: '#123456' }, { emblemParts: parts }), null);
  assert.equal(sanitizeEmblem({ shape: 'hex', field: 'url(x)' }, { emblemParts: parts }), null);
});

test('every real lineage identity has a designed spec (≤ 200 B, distinct, valid)', () => {
  const seen = new Set();
  for (const lin of lineages) {
    const list = book.specs[lin.id];
    assert.ok(Array.isArray(list), `emblems.json sem ${lin.id}`);
    assert.equal(list.length, lin.identities.length, `${lin.id}: um emblema por identidade`);
    list.forEach((spec, i) => {
      assert.ok(JSON.stringify(spec).length <= 200, `${lin.id}#${i} > 200 B`);
      assert.ok(E.SHAPES.includes(spec.shape) && E.glyphIds().includes(spec.glyph), `${lin.id}#${i} partes`);
      assert.ok(sanitizeEmblem(spec, { emblemParts: parts }), `${lin.id}#${i} aceito pelo sim`);
      const svg = E.emblemSVG(spec, { size: 64 });
      wellFormed(svg, `${lin.id}#${i}`);
      seen.add(svg);
    });
  }
  const total = Object.values(book.specs).reduce((s, l) => s + l.length, 0);
  assert.equal(seen.size, total, 'no two identities share an emblem');
});

test('actors resolve to the right spec: own > lineage identity > procedural', () => {
  const naca = E.specForActor({ id: 'nasa', lineage: 'nasa', identityIdx: 0, short: 'NACA' });
  const nasa = E.specForActor({ id: 'nasa', lineage: 'nasa', identityIdx: 1, short: 'NASA' });
  assert.equal(naca.label, 'NACA');
  assert.equal(naca.shape, book.specs.nasa[0].shape);
  assert.equal(nasa.shape, book.specs.nasa[1].shape);
  // legacy actors (Corrida Lunar, no identityIdx) match by label, else the latest identity
  assert.equal(E.specForActor({ id: 'roscosmos', short: 'Roscosmos' }).label, 'ROSC');
  assert.equal(E.specForActor({ id: 'jaxa', short: 'JAXA' }).shape, book.specs.jaxa[1].shape);
  // own spec wins (founded / generated actors)
  const own = E.specForActor({ id: 'custom_x', short: 'AEX', emblem: { shape: 'hex', field: '#0b5d4b', glyph: 'atom' } });
  assert.equal(own.shape, 'hex');
  assert.equal(own.label, 'AEX');
  // lifecycle genActor specs (with seed) get derived optional parts deterministically
  const g = { id: 'gen_3', short: 'HEL', emblem: { shape: 'roundel', field: '#1B3A6B', field2: '#F2C14E', division: 'band', glyph: 'orbit', glyphColor: '#F2C14E', stars: 2, label: 'HEL', seed: 12345 } };
  assert.deepEqual(E.specForActor(g), E.specForActor(JSON.parse(JSON.stringify(g))));
  // procedural: deterministic per id, varied across ids, kind-aware
  const ids = Array.from({ length: 60 }, (_, i) => `gen_${i}`);
  const svgs = new Set(ids.map((id) => E.emblemSVG(E.specForActor({ id, short: id.toUpperCase() }), { size: 48 })));
  assert.ok(svgs.size >= 55, `procedural emblems vary (${svgs.size}/60)`);
  assert.deepEqual(E.specFromSeed('abc', { kind: 'company' }), E.specFromSeed('abc', { kind: 'company' }));
  const companies = ids.map((id) => E.specFromSeed(id, { kind: 'company' }).shape);
  assert.ok(companies.filter((s) => s === 'wordmark').length >= 15, 'companies lean to wordmarks');
  // a colour hint pulls the palette toward the actor's colour
  const red = E.specFromSeed('x1', { color: '#a3161a' });
  assert.ok(['#9e1b1b', '#8c3b1f', '#5e1f2d', '#7a1414', '#6b2c17', '#44141f'].some((c) => [red.field, red.field2].includes(c)), `red-ish palette (${red.field})`);
});

test('portrait.emblemSVG is a wrapper: legacy callers keep working', () => {
  const svg = portraitEmblem({ short: 'SpaceX', color: '#E8E8E8' });
  assert.match(svg, /fill="#14202e"[^>]*>SPACEX</);
  assert.equal(portraitEmblem({ id: 'esa', short: 'ESA' }, { size: 40 }), E.emblemSVG(E.specForActor({ id: 'esa', short: 'ESA' }), { size: 40 }));
  assert.ok(portraitEmblem(undefined).startsWith('<svg'));
  assert.ok(portraitEmblem({ id: 'tomb', name: 'Velha', short: 'VEL', emblem: null }).startsWith('<svg'));
});

test('palettes are curated and readable (glyph contrasts with the field)', () => {
  const pals = E.palettes();
  assert.ok(pals.length >= 16);
  for (const p of pals) {
    assert.equal(p.colors.length, 4);
    assert.ok(E.contrast(p.colors[0], p.colors[2]) >= 3, `${p.id}: símbolo legível (${E.contrast(p.colors[0], p.colors[2]).toFixed(2)})`);
  }
  assert.equal(E.inkFor('#E8E8E8'), '#14202e');
  assert.equal(E.inkFor('#0072B2'), '#f7f1e3');
});

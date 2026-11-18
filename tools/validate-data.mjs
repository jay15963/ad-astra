#!/usr/bin/env node
// Data validator CLI (docs/EXPANSION.md §4.4). No dependencies.
//   node tools/validate-data.mjs [--pack e2] [--json] [--legacy-warnings] [--quiet]
// Exit code 1 when there is any error. Warnings never fail. Prints per-year density of era packs for authors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkData, errorsOf } from './validate/rules.js';
import { DEFAULT_MANIFEST } from '../src/core/packs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Read data/ into the validator input (see tools/validate/rules.js). */
export function loadRepoInput(root = ROOT) {
  const dataDir = path.join(root, 'data');
  const readJson = (rel) => {
    const f = path.join(dataDir, `${rel}.json`);
    if (!fs.existsSync(f)) return { json: undefined, bytes: 0 };
    const text = fs.readFileSync(f, 'utf8');
    try { return { json: JSON.parse(text), bytes: Buffer.byteLength(text) }; } catch (e) {
      return { json: undefined, bytes: Buffer.byteLength(text), error: `JSON inválido: ${e.message}` };
    }
  };
  const parseErrors = [];
  const m = readJson('packs');
  const manifest = m.json || DEFAULT_MANIFEST;
  const packs = {};
  const sizes = {};
  for (const p of manifest.packs || []) {
    packs[p.id] = {};
    sizes[p.id] = {};
    for (const f of p.files || []) {
      const r = readJson(`${p.dir || ''}${f}`);
      if (r.error) parseErrors.push({ level: 'error', pack: p.id, path: `${p.dir || ''}${f}.json`, message: r.error });
      if (r.json !== undefined) packs[p.id][f] = r.json;
      if (r.bytes) sizes[p.id][f] = r.bytes;
    }
    // optional patches.json of era packs (not always listed while empty)
    if (p.era && !p.always && !(p.files || []).includes('patches')) {
      const r = readJson(`${p.dir}patches`);
      if (r.json !== undefined) parseErrors.push({ level: 'warn', pack: p.id, path: `${p.dir}patches.json`, message: 'patches.json existe mas não está listado no manifesto (é ignorado)' });
    }
  }
  const scenarios = {};
  for (const [id, file] of Object.entries(manifest.scenarios || {})) {
    const r = readJson(file.replace(/\.json$/, ''));
    if (r.error) parseErrors.push({ level: 'error', pack: 'scenarios', path: file, message: r.error });
    if (r.json !== undefined) scenarios[id] = r.json;
    else if (!r.error) parseErrors.push({ level: 'error', pack: 'scenarios', path: file, message: 'arquivo de cenário não existe' });
  }
  const scenarioIndex = readJson('scenarios/index').json ?? null;
  const schemas = {};
  const sdir = path.join(dataDir, 'core', 'schemas');
  if (fs.existsSync(sdir)) {
    for (const f of fs.readdirSync(sdir)) if (f.endsWith('.schema.json')) schemas[f] = JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8'));
  }
  return { input: { manifest: m.json, packs, sizes, scenarios, scenarioIndex, schemas }, parseErrors };
}

/** Load + check. Returns {issues, density, stats}. */
export function validateRepo(root = ROOT, opts = {}) {
  const { input, parseErrors } = loadRepoInput(root);
  const r = checkData(input, opts);
  const extra = parseErrors.filter((e) => !opts.onlyPack || e.pack === opts.onlyPack);
  return { ...r, issues: [...extra, ...r.issues] };
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const onlyPack = opt('--pack');
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const r = validateRepo(ROOT, { onlyPack, legacyWarnings: argv.includes('--legacy-warnings') });
  const errors = errorsOf(r);
  if (asJson) {
    console.log(JSON.stringify({ ok: errors.length === 0, ...r }, null, 2));
  } else {
    for (const i of r.issues) console.log(`${i.level === 'error' ? 'ERRO ' : 'aviso'} ${i.path}: ${i.message}`);
    if (!quiet) {
      const years = Object.keys(r.density).map(Number).sort((a, b) => a - b);
      if (years.length) {
        console.log('\nDensidade por ano (itens datados dos pacotes de era):');
        const rows = years.map((y) => `${y} ${'#'.repeat(Math.min(40, r.density[y]))} ${r.density[y]}`);
        console.log(rows.join('\n'));
      }
      console.log(`\n${r.stats.entities ?? 0} entidades em ${r.stats.packs ?? 0} pacotes; dados de partida ≈ ${((r.stats.bootBytes ?? 0) / 1024).toFixed(0)} KB.`);
    }
    console.log(errors.length ? `\n${errors.length} erro(s).` : '\nDados válidos.');
  }
  return errors.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

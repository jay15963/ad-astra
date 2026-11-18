#!/usr/bin/env node
// Prints generator samples per era (C8): actor names (new births + successors of real lineages), vehicles, craft,
// interstellar destinations, programs and events. Deterministic per seed.
//
//   node tools/gen-preview.mjs [--seed 7] [--era e5|e6|e7|all] [--actors 12] [--programs 6] [--json] [--names-only]
//
// Also reports repeated names/shorts/key words (should be none) and ids not in data/core/vocab.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGen, genWorld, nameRegistry, successorName, genName, keyTokens } from '../src/gen/index.js';
import { makeRng } from '../src/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${rel}.json`), 'utf8'));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

const seed = Number(opt('seed', 7));
const eraArg = opt('era', 'all');
const eras = eraArg === 'all' ? ['e5', 'e6', 'e7'] : [eraArg];
const nActors = Number(opt('actors', 10));
const nPrograms = Number(opt('programs', 6));

const G = await loadGen(async (n) => readJson(n));
const data = {
  actorGen: readJson('core/actor-gen'), nations: readJson('core/nations'), destinations: readJson('destinations'),
};
const stars = readJson('core/stars');
const vocab = readJson('core/vocab');
const lineages = readJson('core/lineages').lineages || [];

// one registry for the whole run: names stay distinct across eras, as in a campaign
const reg = nameRegistry(G.names);
for (const l of lineages) for (const idn of l.identities || []) reg.add(idn.name, idn.short);

const SAMPLE_LINEAGES = ['nasa', 'roscosmos', 'cnsa', 'esa', 'isro', 'jaxa', 'aeb', 'spacex', 'blueorigin', 'rocketlab'];
// words of nation phrases ("da África do Sul") are not key words: a nation may have an agency and, later, an authority
const nationWords = new Set((data.nations.nations || []).flatMap((n) => keyTokens(G.names, n.of || '')));

const report = { seed, eras: {} };
const problems = [];
for (const eraId of eras) {
  const w = genWorld(data, G, { seed, eraId, stars, actors: nActors, programs: nPrograms, registry: reg });
  // successors of real lineages
  const rng = makeRng(seed + eraId.charCodeAt(1));
  const succ = [];
  // lineages still alive in 2050 (ABMA, ELDO, ISAS… ended in the 20th century and never get a successor)
  for (const l of lineages.filter((x) => SAMPLE_LINEAGES.includes(x.id))) {
    const last = (l.identities || []).at(-1) || {};
    const nat = (data.nations.nations || []).find((n) => n.id === (l.nation?.at?.(-1)?.id || l.nation));
    const s = successorName(G.names, { base: last.short || l.id, kind: l.kind, of: nat?.of, eraId, rng, registry: reg, currentName: last.name });
    if (s) succ.push(`${last.short || l.id} -> ${s.name} (${s.short})`);
  }
  report.eras[eraId] = { ...w, successors: succ };
  if (flag('json')) continue;
  console.log(`\n=== ${eraId} (semente ${seed}) ===`);
  console.log('-- Atores novos');
  for (const a of w.actors) console.log(`  ${a.born.year}  ${a.name.padEnd(46)} ${String(a.short).padEnd(13)} ${a.archetype}${a.country ? ` · ${a.country}` : ''}`);
  console.log('-- Sucessores de linhagens reais');
  for (const s of succ) console.log(`  ${s}`);
  if (flag('names-only')) continue;
  console.log('-- Foguetes');
  for (const v of w.vehicles) console.log(`  ${v.name.padEnd(22)} ${v.class.padEnd(10)} LEO ${String(v.capacity.leo).padStart(5)} t · Marte ${String(v.capacity.mars).padStart(5)} t · externo ${String(v.capacity.outer).padStart(5)} t · US$ ${v.costM} mi · ${v.family} · ${v.provider}`);
  console.log('-- Naves');
  for (const c of w.spacecraft) console.log(`  ${c.name.padEnd(18)} ${c.kind.padEnd(9)} tripulação ${String(c.crew).padStart(4)} · ${c.massT} t · ${c.destinations.length} destinos · ${c.provider}`);
  if (w.destinations.length) {
    console.log(`-- Destinos interestelares (${w.destinations.length}; 6 mais próximos)`);
    for (const d of w.destinations.slice(0, 6)) console.log(`  ${d.id.padEnd(26)} ${d.name.padEnd(30)} ${String(d.ly).padStart(6)} al · sonda ${Math.round(d.transitWeeks / 52)} anos · tripulada ${Math.round(d.transitWeeksCrewed / 52)} anos`);
  }
  console.log('-- Programas');
  for (const p of w.programs) console.log(`  ${p.planned.year}/${String(p.planned.month + 1).padStart(2, '0')} ${p.name.padEnd(24)} ${p.type.padEnd(8)} ${p.destination.padEnd(24)} ${p.owner} · ${p.milestone || '—'}\n      ${p.description}`);
  console.log(`-- Eventos (${w.events.length})`);
  for (const e of w.events.slice(0, 8)) console.log(`  [${e.group}] ${e.title}`);
}

// checks: repeated names / shorts / key words among generated actors, vocab ids
const all = Object.values(report.eras).flatMap((e) => e.actors);
const seen = { name: new Set(), short: new Set(), key: new Map() };
for (const a of all) {
  if (seen.name.has(a.name)) problems.push(`nome repetido: ${a.name}`);
  if (seen.short.has(a.short)) problems.push(`sigla repetida: ${a.short}`);
  seen.name.add(a.name); seen.short.add(a.short);
  for (const k of keyTokens(G.names, a.name).filter((t) => !nationWords.has(t))) { if (seen.key.has(k)) problems.push(`palavra-chave repetida "${k}": ${seen.key.get(k)} / ${a.name}`); seen.key.set(k, a.name); }
}
const V = (cat, id) => !!vocab[cat]?.[id];
const famId = (id) => /_(system|orbit|surface)$/.test(id) || id.startsWith('region_');
for (const e of Object.values(report.eras)) {
  for (const p of e.programs) {
    if (!V('destinations', p.destination) && !famId(p.destination)) problems.push(`destino fora do vocabulário: ${p.destination}`);
    if (p.milestone && !V('milestones', p.milestone)) problems.push(`marco fora do vocabulário: ${p.milestone}`);
    if (!V('missionTypes', p.type)) problems.push(`tipo fora do vocabulário: ${p.type}`);
  }
  for (const v of e.vehicles) if (!V('partFamilies', v.family) || !V('vehicleClasses', v.class)) problems.push(`família/classe fora do vocabulário: ${v.id}`);
  for (const c of e.spacecraft) if (!V('spacecraftKinds', c.kind)) problems.push(`tipo de nave fora do vocabulário: ${c.kind}`);
  for (const ev of e.events) if (!V('eventGroups', ev.group) || ev.tags.some((t) => !V('eventTags', t))) problems.push(`grupo/etiqueta fora do vocabulário: ${ev.id}`);
}
if (flag('json')) console.log(JSON.stringify({ ...report, problems }, null, 1));
else console.log(problems.length ? `\nPROBLEMAS (${problems.length}):\n  ${problems.join('\n  ')}` : '\nSem nomes repetidos; todos os ids estão no vocabulário.');
process.exitCode = problems.length ? 1 : 0;

// keep genName importable from the preview for ad-hoc use (node -e)
export { genName };

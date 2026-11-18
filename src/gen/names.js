// Procedural names for speculative actors (C8, docs/EXPANSION.md §3.2 / §14). Data: data/gen/gen-names.json.
//
// Guarantees (tested in tests/gen.test.mjs):
// - deterministic for the same rng stream and registry;
// - no two live/dead actors share a name, a short name, or a key word ({root}, {surname}, {place}): the old
//   grammar produced three "Tycho Recursos …" and "SpaceX do Espaço Profundo"; here every key word is used once and
//   successor templates never add "Espaço" to an acronym that is already a space agency;
// - era-appropriate style: frontier/mining brands in e5, habitats and dynasties in e6, guilds/archives in e7.
//
// API
//   nameRegistry(N, {names, shorts})                 -> registry (add/has); seed it with live actors + tombstones
//   registryFromState(N, state)                      -> registry of state.actors + state.lifecycle.tombstones
//   genName(N, {kind, archetype, year|eraId, nation, rng|seed, registry}) -> {name, short, keys, style, eraId, kind}
//   successorName(N, {base, kind, of, year|eraId, rng|seed, registry, used, currentName}) -> {name, short, style} | null
//   styleKindOf(N, archetypeId) -> 'agency'|'company'|'mining'|'authority'|'colony'|'fixed'

import { fill, norm, weighted, rngOf, eraOfYear, nearestEra, eraIndex } from './util.js';

const MAX_SHORT = 12;
const KIND_FALLBACK = { authority: ['agency'], colony: ['company'], mining: ['company'], company: ['agency'], agency: ['company'] };

const genericSet = (N) => {
  if (N.__generic) return N.__generic;
  const s = new Set([...(N.generic || []), ...(N.functionWords || [])].map(norm));
  // every literal word of a template is generic too ("Mundo Livre de {place}": only the place is a key word)
  const tpls = [];
  for (const byKind of Object.values(N.styles || {})) for (const list of Object.values(byKind)) for (const t of list) tpls.push(t.name, t.short);
  for (const byEra of Object.values(N.successors || {})) if (byEra && typeof byEra === 'object') {
    for (const list of Object.values(byEra)) if (Array.isArray(list)) for (const t of list) tpls.push(t.name);
  }
  for (const sec of Object.values(N.sectors || {})) tpls.push(...sec);
  for (const t of tpls) for (const w of String(t || '').replace(/\{\w+\}/g, ' ').split(/\s+/)) if (w) s.add(norm(w));
  Object.defineProperty(N, '__generic', { value: s, enumerable: false });
  return s;
};

/** Distinctive words of a name (normalized): everything that is not a generic/function word. */
export function keyTokens(N, name) {
  const g = genericSet(N);
  return String(name || '').replace(/\(.*?\)/g, ' ').split(/[\s/]+/).map(norm).map((w) => w.replace(/[^a-z0-9-]/g, ''))
    .filter((w) => w.length >= 3 && !g.has(w));
}

/** Acronym: first letter of each significant word ("Agência Espacial da Nigéria" -> AEN). */
export function acronym(N, name) {
  const fw = new Set((N.functionWords || []).map(norm));
  let out = '';
  for (const raw of String(name).replace(/\(.*?\)/g, ' ').split(/\s+/)) {
    if (!raw || fw.has(norm(raw))) continue;
    for (const part of raw.split('-')) {
      if (!part) continue;
      out += part[0].toUpperCase();
    }
  }
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 8);
}

export function nameRegistry(N, { names = [], shorts = [] } = {}) {
  const reg = {
    names: new Set(), shorts: new Set(), keys: new Set(), styles: new Map(),
    add(name, short) {
      if (name) { reg.names.add(norm(name)); for (const k of keyTokens(N, name)) reg.keys.add(k); }
      if (short) reg.shorts.add(norm(short));
      return reg;
    },
    hasName: (n) => reg.names.has(norm(n)),
    hasShort: (s) => reg.shorts.has(norm(s)),
    /** a key word (root/surname/place) is free when none of its words is already a distinctive word somewhere */
    keyFree: (w) => keyTokens(N, w).every((k) => !reg.keys.has(k)) && !reg.names.has(norm(w)),
  };
  names.forEach((n, i) => reg.add(n, shorts[i]));
  shorts.slice(names.length).forEach((s) => reg.add(null, s));
  return reg;
}

export function registryFromState(N, state) {
  const reg = nameRegistry(N);
  for (const a of Object.values(state?.actors || {})) reg.add(a?.name, a?.short);
  for (const t of Object.values(state?.lifecycle?.tombstones || {})) reg.add(t?.name, t?.short);
  for (const s of Object.values(state?.lifecycle?.idents || {})) reg.add(s?.name, s?.short);
  return reg;
}

export const styleKindOf = (N, archetypeId) => N.archetypeStyle?.[archetypeId] || 'company';

const PREP = { de: { a: 'da', o: 'do', as: 'das', os: 'dos' }, em: { a: 'na', o: 'no', as: 'nas', os: 'nos' },
  a: { a: 'à', o: 'ao', as: 'às', os: 'aos' }, '': { a: 'a', o: 'o', as: 'as', os: 'os' } };

/** Article of an institution name by its first word: 'a' (default: agência, empresa), 'o', 'os', 'as'. */
export function articleOf(N, name) {
  const w = norm(String(name || '').split(/[\s-]+/)[0]);
  const A = N.articles || {};
  if ((A.mascPl || []).some((x) => norm(x) === w)) return 'os';
  if ((A.femPl || []).some((x) => norm(x) === w)) return 'as';
  if ((A.masc || []).some((x) => norm(x) === w)) return 'o';
  return 'a';
}

/** "da Agência…", "do Governo…", "A NASA" (cap) — prep in '', 'de', 'em', 'a'. */
export function withArticle(N, name, prep = '', { cap = false } = {}) {
  const art = (PREP[prep] || PREP[''])[articleOf(N, name)];
  const out = `${art} ${name}`;
  return cap ? out[0].toUpperCase() + out.slice(1) : out;
}

function stylesFor(N, eraId, kind) {
  const tryKinds = [kind, ...(KIND_FALLBACK[kind] || [])];
  for (const k of tryKinds) {
    // nearest era at or before eraId that defines this kind, else the first later era that does
    const eras = Object.keys(N.styles || {}).sort((a, b) => eraIndex(a) - eraIndex(b));
    const before = eras.filter((e) => eraIndex(e) <= eraIndex(eraId) && N.styles[e][k]?.length);
    const after = eras.filter((e) => eraIndex(e) > eraIndex(eraId) && N.styles[e][k]?.length);
    const e = before.length ? before[before.length - 1] : after[0];
    if (e) return N.styles[e][k];
  }
  return [];
}

/** Pool for era (current era first, then older eras), restricted to free key words. */
function freePool(byEra, eraId, reg, { currentOnly = false } = {}) {
  const cur = (byEra?.[eraId] || []).filter((w) => reg.keyFree(typeof w === 'string' ? w : w.name));
  if (cur.length || currentOnly) return cur;
  const out = [];
  for (const e of Object.keys(byEra || {}).sort((a, b) => eraIndex(b) - eraIndex(a))) {
    if (eraIndex(e) > eraIndex(eraId)) continue;
    out.push(...byEra[e].filter((w) => reg.keyFree(typeof w === 'string' ? w : w.name)));
    if (out.length) break;
  }
  return out;
}

const pickFree = (rng, pool) => (pool.length ? pool[Math.floor(rng.next() * pool.length)] : null);
const initial = (s) => String(s || '?').normalize('NFD').replace(/[̀-ͯ]/g, '')[0].toUpperCase();

/** Build one candidate from a style; null when a slot cannot be filled. */
function candidate(N, style, eraId, nation, reg, rng) {
  const tpl = style.name;
  const vars = {};
  const keys = [];
  if (tpl.includes('{of}')) { if (!nation?.of) return null; vars.of = nation.of; }
  if (tpl.includes('{root}')) {
    const r = pickFree(rng, freePool(N.roots, eraId, reg));
    if (!r) return null;
    vars.root = r; keys.push(r);
  }
  if (tpl.includes('{surname}')) {
    const pool = (N.surnames || []).filter((s) => reg.keyFree(s));
    const s1 = pickFree(rng, pool);
    if (!s1) return null;
    vars.surname = s1; keys.push(s1);
    if (tpl.includes('{surname2}')) {
      const s2 = pickFree(rng, pool.filter((s) => s !== s1));
      if (!s2) return null;
      vars.surname2 = s2; keys.push(s2);
    }
  }
  if (tpl.includes('{place}') || tpl.includes('{placeOf}') || String(style.short).includes('{place}')) {
    const p = pickFree(rng, freePool(N.places, eraId, reg));
    if (!p) return null;
    vars.place = p.name; vars.placeOf = p.of; keys.push(p.name);
  }
  if (tpl.includes('{sector}')) {
    const pool = (N.sectors?.[eraId]?.length ? N.sectors[eraId] : nearestSectors(N, eraId));
    if (!pool.length) return null;
    vars.sector = pool[Math.floor(rng.next() * pool.length)];
  }
  const name = fill(tpl, vars).replace(/\s+/g, ' ').trim();
  vars.i1 = initial(vars.surname); vars.i2 = initial(vars.surname2);
  vars.acr = acronym(N, name);
  let short = fill(style.short || '{acr}', vars).trim();
  if (short.length > MAX_SHORT) short = [vars.place, vars.root, vars.surname].find((x) => x && x.length <= MAX_SHORT) || vars.acr;
  if (/\{\w+\}/.test(name) || /\{\w+\}/.test(short)) return null;
  return { name, short, keys };
}

function nearestSectors(N, eraId) {
  for (let i = eraIndex(eraId); i >= 0; i--) {
    const e = `e${i + 1}`;
    if (N.sectors?.[e]?.length) return N.sectors[e];
  }
  return [];
}

/**
 * A new actor name. `kind` is a style kind (or pass `archetype` and it is mapped through archetypeStyle).
 * Never returns a name, short or key word already in `registry`; adds the result to it.
 */
export function genName(N, opts = {}) {
  const reg = opts.registry || nameRegistry(N);
  const eraId = opts.eraId || eraOfYear(N.eraOf, opts.year ?? 2051);
  const kind = opts.kind || styleKindOf(N, opts.archetype);
  const rng = rngOf(opts, 'name', eraId, kind, opts.n ?? 0);
  if (kind === 'fixed') {
    const f = N.fixed?.[opts.archetype] || { name: 'Colégio do Silêncio', short: 'Colégio' };
    reg.add(f.name, f.short);
    return { name: f.name, short: f.short, keys: [], style: 'fixed', eraId, kind };
  }
  const styles = stylesFor(N, eraId, kind);
  for (let attempt = 0; attempt < 24 && styles.length; attempt++) {
    // soft variety: a style already used k times weighs w/(1+k), so the same pattern rarely repeats
    const style = rng.weighted(styles, (s) => (s.w ?? 1) / (1 + (reg.styles?.get(`${kind}:${s.id}`) || 0)));
    const c = style && candidate(N, style, eraId, opts.nation, reg, rng);
    if (!c) continue;
    if (reg.hasName(c.name)) continue;
    if (reg.hasShort(c.short)) {
      const alt = `${c.short}${opts.nation?.abbr ? `-${opts.nation.abbr}` : ''}`.slice(0, MAX_SHORT);
      if (reg.hasShort(alt)) continue;
      c.short = alt;
    }
    reg.add(c.name, c.short);
    reg.styles?.set(`${kind}:${style.id}`, (reg.styles.get(`${kind}:${style.id}`) || 0) + 1);
    for (const k of c.keys) for (const t of keyTokens(N, k)) reg.keys.add(t);
    return { ...c, style: style.id, eraId, kind };
  }
  // exhausted pools: still distinct and readable ("Consórcio Orbital 37")
  let k = (opts.n ?? 0) + 1;
  let name;
  do { name = `Consórcio Orbital ${k++}`; } while (reg.hasName(name));
  const short = `CO${k - 1}`;
  reg.add(name, short);
  return { name, short, keys: [], style: 'fallback', eraId, kind };
}

/**
 * Speculative successor identity of a real lineage (NASA -> "NASA Interplanetária", SpaceX -> "Grupo SpaceX").
 * `base` = the lineage's own short name (never a previous successor), `kind` = actor kind ('company' or other),
 * `of` = nation phrase ("dos EUA"), `used` = style ids already used by this lineage (once-templates skip),
 * `currentName` = the actor's current name (a successor must change it). Null when nothing fits.
 */
export function successorName(N, opts = {}) {
  const reg = opts.registry || nameRegistry(N);
  const eraId = opts.eraId || eraOfYear(N.eraOf, opts.year ?? 2051);
  const k = opts.kind === 'company' || opts.kind === 'consortium' ? 'company' : 'agency';
  const byEra = N.successors?.[k] || {};
  const list = nearestEra(byEra, eraId) || [];
  const base = String(opts.base || '').replace(/\s*\(.*\)\s*/g, '').trim();
  if (!base) return null;
  const used = new Set(opts.used || []);
  const cur = norm(opts.currentName);
  const vars = { short: base, of: opts.of || '' };
  const fits = [];
  for (const t of list) {
    if (t.once && used.has(t.id)) continue;
    if (t.name.includes('{of}') && !opts.of) continue;
    if (t.id === 'nova' && /^nov[ao]\s/i.test(base)) continue; // never 'Nova Nova ESA'
    const masc = articleOf(N, base) === 'o';
    const name = fill(masc && t.nameMasc ? t.nameMasc : t.name, vars).replace(/\s+/g, ' ').trim();
    if (norm(name) === cur || reg.hasName(name)) continue;
    let short = fill((masc && t.shortMasc) || t.short || '{short}', { ...vars, acr: acronym(N, name) }).trim();
    // a successor keeps its lineage's own short name unless the new one is free (two 'DEE' never coexist)
    if (short.length > MAX_SHORT || (norm(short) !== norm(base) && reg.hasShort(short))) short = base.slice(0, MAX_SHORT);
    fits.push({ ...t, nameOut: name, shortOut: short });
  }
  const rng = rngOf(opts, 'successor', base, eraId);
  // soft variety across lineages (as in genName): a style already given to k lineages weighs w/(1+k), so one era
  // does not end with six "{short} Estelar"
  const sk = (t) => `succ:${k}:${eraId}:${t.id}`;
  const pick = fits.length ? rng.weighted(fits, (t) => (t.w ?? 1) / (1 + (reg.styles?.get(sk(t)) || 0))) : null;
  if (!pick) return null;
  reg.add(pick.nameOut, pick.shortOut);
  reg.styles?.set(sk(pick), (reg.styles.get(sk(pick)) || 0) + 1);
  return { name: pick.nameOut, short: pick.shortOut, style: pick.id, eraId };
}

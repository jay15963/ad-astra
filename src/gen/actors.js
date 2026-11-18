// Procedural actor definitions (C8). Same shape lifecycle.js genActor() builds today, with names from
// src/gen/names.js (distinct, era-styled). Start values come from data/core/actor-gen.json archetypes (lifecycle owns
// those numbers); names, emblem grammar and era palettes come from data/gen/gen-names.json.
//
//   genActorDef(data, N, {archetype, year, month?, n, nationId?, tier?, seed|rng, registry, startYear?}) -> def
//   successorIdentity(data, N, {actor, base, year, seed|rng, registry, used}) -> {name, short, style} | null
//
// `def.id` is always `gen_<n>` (the gen_ prefix is reserved for runtime generators: docs/EXPANSION.md §14 C0).

import { rngOf, span, eraOfYear, hash32 } from './util.js';
import { genName, styleKindOf, successorName } from './names.js';

const r2 = (x) => Math.round(x * 100) / 100;
const listOf = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

/** Archetype by id from data.actorGen (or the object itself). */
export function archetypeOf(data, arch) {
  if (arch && typeof arch === 'object') return arch;
  return (data?.actorGen?.archetypes || []).find((a) => a.id === arch) || null;
}

export const nationOf = (data, id) => (id ? listOf(data?.nations, 'nations').find((n) => n.id === id) || null : null);

const KIND_LABEL = { agency: 'Agência', company: 'Empresa', consortium: 'Consórcio', colony: 'Colônia', order: 'Ordem' };

/** Deterministic speculative actor definition (no cap logic: the caller decides tier and whether to add it). */
export function genActorDef(data, N, opts = {}) {
  const arch = archetypeOf(data, opts.archetype);
  if (!arch) return null;
  const year = opts.year ?? 2051;
  const n = opts.n ?? 1;
  const rng = rngOf(opts, 'actor', arch.id, year, n);
  const eraId = eraOfYear(N.eraOf, year);
  const nat = nationOf(data, opts.nationId);
  const nm = genName(N, { archetype: arch.id, eraId, nation: nat, rng, registry: opts.registry, n });
  const st = arch.start || {};
  const scale = data?.actorGen?.budgetScale?.[eraId] ?? 1;
  const budget = Math.round(span(rng, st.budget, 200) * scale);
  const pals = N.palettes?.[eraId] || data?.actorGen?.palettes || [['#1B3A6B', '#F2C14E']];
  const pal = pals[Math.floor(rng.next() * pals.length)];
  const styleKind = styleKindOf(N, arch.id);
  const em = N.emblem?.[styleKind] || arch.emblem || {};
  const pick = (a, d) => (a?.length ? a[Math.floor(rng.next() * a.length)] : d);
  const id = `gen_${n}`;
  const kind = arch.kind || 'agency';
  const ofTxt = nat?.of || '';
  return {
    id, name: nm.name, short: nm.short, kind, tier: opts.tier || 'core',
    country: nat?.name || (kind === 'colony' ? 'Colônia' : 'Internacional'), flag: kind === 'colony' ? '🪐' : '🌐',
    color: pal[1] || pal[0],
    description: `${KIND_LABEL[kind] || 'Ator espacial'} ${ofTxt}`.trim(), style: nm.style,
    budget, cash: Math.round(budget * 0.25),
    support: Math.round(span(rng, st.support, 60)), reputation: Math.round(span(rng, st.reputation, 50)),
    culture: Math.round(span(rng, st.culture, 0)), prestige: 0, fixedCostShare: 0.5,
    capabilities: { crewed: rng.next() < (st.crewedChance ?? 0.3), launchSites: [] },
    ai: {
      cooperation: r2(span(rng, st.ai?.cooperation, 0.5)), aggression: r2(span(rng, st.ai?.aggression, 0.5)),
      riskTolerance: r2(span(rng, st.ai?.riskTolerance, 0.5)), goals: (st.goals || []).slice(),
    },
    nation: nat?.id || null, lineage: null, generated: true, archetype: arch.id,
    born: { year, month: opts.month ?? 0 },
    emblem: {
      shape: pick(em.shapes, 'roundel'), field: pal[0], field2: pal[1], division: pick(em.divisions, 'none'),
      glyph: pick(em.glyphs, 'rocket'), glyphColor: pal[1], stars: rng.int(0, 5), label: String(nm.short).slice(0, 6),
      seed: hash32(id, opts.seed ?? 0),
    },
  };
}

/** Successor identity for a real lineage's live actor (lifecycle yearSuccessors). */
export function successorIdentity(data, N, opts = {}) {
  const a = opts.actor || {};
  const nat = nationOf(data, a.nation);
  return successorName(N, {
    base: opts.base || a.short || a.name, kind: a.kind, of: nat?.of || '', year: opts.year,
    rng: opts.rng, seed: opts.seed, registry: opts.registry, used: opts.used, currentName: a.name,
  });
}

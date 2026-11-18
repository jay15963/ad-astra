// Procedural generators for the speculative eras (C8, docs/EXPANSION.md §14). Entry point.
//
// Data lives in data/gen/*.json and is NOT in data/packs.json yet (integrator decision). Two ways to get it:
//   - loadGen(reader): reader(name) -> json, the same reader src/core/data.js uses (browserReader/nodeReader);
//   - genDataOf(data): if a pack `{id:'gen', always:true, dir:'gen/', files: GEN_FILES}` is added to packs.json,
//     packs.js maps the files to data.genNames, data.genHardware, data.genDestinations, data.genPrograms, data.genEvents.
// Every generator is pure and deterministic for (seed, labels) or an explicit rng; ids start with `gen_` (reserved
// for generators by the vocabulary) and every shared id comes from data/core/vocab.json (tests/gen.test.mjs).

import { genName, successorName, nameRegistry, registryFromState, keyTokens, acronym, styleKindOf, articleOf, withArticle } from './names.js';
import { genActorDef, successorIdentity, archetypeOf } from './actors.js';
import { genVehicle, genSpacecraft, hardwareRegistry, craftReach } from './hardware.js';
import { interstellarDestinations, destinationById, transitYears } from './destinations.js';
import { genPrograms } from './programs.js';
import { genEvents, genAllEvents } from './events.js';
import { rngOf, eraOfYear } from './util.js';

export {
  genName, successorName, nameRegistry, registryFromState, keyTokens, acronym, styleKindOf, articleOf, withArticle,
  genActorDef, successorIdentity, archetypeOf,
  genVehicle, genSpacecraft, hardwareRegistry, craftReach,
  interstellarDestinations, destinationById, transitYears,
  genPrograms, genEvents, genAllEvents,
};

/** data/gen file names (without .json), in load order. */
export const GEN_FILES = ['gen-names', 'gen-hardware', 'gen-destinations', 'gen-programs', 'gen-events'];
const KEY = { 'gen-names': 'names', 'gen-hardware': 'hardware', 'gen-destinations': 'destinations', 'gen-programs': 'programs', 'gen-events': 'events' };

/** Load the generator bundle {names, hardware, destinations, programs, events} with a data reader. */
export async function loadGen(reader, dir = 'gen/') {
  const out = {};
  for (const f of GEN_FILES) out[KEY[f]] = await reader(`${dir}${f}`);
  return out;
}

/** Bundle from a loaded data object (when the gen pack is in packs.json), else null. */
export function genDataOf(data) {
  if (!data?.genNames) return null;
  return { names: data.genNames, hardware: data.genHardware, destinations: data.genDestinations, programs: data.genPrograms, events: data.genEvents };
}

const ERA_RANGE = { e5: [2051, 2199], e6: [2200, 2599], e7: [2600, 2999] };
const ARCH_BY_ERA = {
  e5: ['emerging_agency', 'megacorp', 'megacorp', 'mining_consortium', 'mining_consortium', 'colony_gov'],
  e6: ['megacorp', 'mining_consortium', 'interplanetary_authority', 'colony_gov', 'colony_gov', 'megacorp'],
  e7: ['megacorp', 'interplanetary_authority', 'colony_gov', 'mining_consortium', 'megacorp', 'colony_gov'],
};

/**
 * A sample "world" for one era: actors, hardware, destinations, programs and events, all from the same seed.
 * Used by tools/gen-preview.mjs and the tests; the sim wires the individual generators instead.
 */
export function genWorld(data, G, { seed = 1, eraId = 'e5', stars = null, actors = 6, programs = 6, registry = null } = {}) {
  const [from, to] = ERA_RANGE[eraId] || ERA_RANGE.e5;
  const rng = rngOf({ seed }, 'world', eraId);
  const reg = registry || nameRegistry(G.names);
  const emerging = (Array.isArray(data?.nations) ? data.nations : data?.nations?.nations || []).filter((n) => n.emerging);
  const out = { eraId, actors: [], vehicles: [], spacecraft: [], destinations: [], programs: [], events: [] };
  const archs = ARCH_BY_ERA[eraId] || ARCH_BY_ERA.e5;
  for (let i = 0; i < actors; i++) {
    const year = from + Math.floor(((to - from) * (i + rng.next())) / actors);
    const archetype = archs[i % archs.length];
    const nat = archetype === 'emerging_agency' || archetype === 'interplanetary_authority' ? emerging[Math.floor(rng.next() * emerging.length)] : null;
    const def = genActorDef(data, G.names, { archetype, year, n: 1000 + i, nationId: nat?.id, rng, registry: reg, seed });
    if (def) { def.capabilities.crewed = def.capabilities.crewed || i % 2 === 0; out.actors.push(def); }
  }
  const hwReg = hardwareRegistry();
  const baseDests = (data?.destinations?.destinations || []).slice();
  const inter = stars && G.destinations ? interstellarDestinations(stars, G.destinations, { eraId }) : [];
  out.destinations = inter.filter((d) => d.era === eraId || (eraId === 'e7' && d.era === 'e6'));
  const dests = [...baseDests, ...standInDestinations(G.destinations, eraId, baseDests), ...inter];
  out.actors.forEach((a, i) => {
    const year = Math.max(from, a.born.year + 2);
    out.vehicles.push(genVehicle(data, G.hardware, { operator: a, year, eraId, n: i, rng, registry: hwReg, names: G.names }));
    out.spacecraft.push(genSpacecraft(data, G.hardware, { operator: a, year, eraId, n: i, rng, registry: hwReg, destinations: dests, names: G.names }));
  });
  const prog = genPrograms(data, G.programs, G.hardware, {
    eraId, fromYear: from, toYear: to, owners: out.actors, count: programs, destinations: dests,
    fleet: { vehicles: out.vehicles, spacecraft: out.spacecraft }, rng, registry: hwReg, names: G.names,
  });
  out.programs = prog.missions;
  out.vehicles.push(...prog.vehicles);
  out.spacecraft.push(...prog.spacecraft);
  out.events = genEvents(G.events, { eraId, rng });
  return out;
}

/**
 * Stand-ins for vocab destinations the era packs have not authored yet (data/gen/gen-destinations.json `standIns`;
 * preview/tests only, so programs have somewhere to go). Real rows come from data/eras/eN/destinations.json once
 * C5–C7 deliver them; an authored row always wins over a stand-in with the same id.
 */
export function standInDestinations(D, eraId, authored = []) {
  const have = new Set(authored.map((d) => d.id));
  const order = ['e5', 'e6', 'e7'];
  return (D?.standIns || []).filter((d) => order.indexOf(d.era) <= order.indexOf(eraId) && !have.has(d.id))
    .map((d) => ({ transitWeeks: 0, fromYear: d.era === 'e6' ? 2200 : 2051, ...d }));
}

export { eraOfYear };

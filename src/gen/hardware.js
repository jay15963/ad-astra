// Procedural launch vehicles and spacecraft for the speculative eras (C8). Data: data/gen/gen-hardware.json.
// Output rows have the shape of data/vehicles.json / data/spacecraft.json (validated against the core schemas in
// tests/gen.test.mjs), with ids `gen_v_*` / `gen_c_*`, truthLayer 'especulacao' and `generated: true`.
//
//   hardwareRegistry(names?) -> Set of normalized names (shared by vehicles and craft of one world)
//   genVehicle(data, H, {operator, year, month?, eraId?, cls?, n, seed|rng, registry}) -> vehicle
//   genSpacecraft(data, H, {operator, year, month?, eraId?, kind?, n, seed|rng, registry, destinations?}) -> spacecraft
//
// `operator` is an actor-like object {id, name, short, country, kind}. `destinations` (optional) is the list the
// craft may fly to; default = data.destinations.destinations dated at or before `year`.

import { rngOf, span, round, norm, slug, weighted, nearestEra, eraOfYear } from './util.js';
import { withArticle } from './names.js';

const ERA_TABLE = [[2051, 'e5'], [2200, 'e6'], [2600, 'e7']];
const CAP_KEYS = ['leo', 'gto', 'tli', 'mars', 'outer'];

export const hardwareRegistry = (names = []) => new Set(names.map(norm));

const yearOfDate = (d) => (d == null ? null : typeof d === 'number' ? d : d.year ?? null);
const effYear = (x) => yearOfDate(x.availableFrom) ?? x.fromYear ?? null;

function uniqueName(rng, roots, series, reg) {
  const free = roots.filter((r) => !reg.has(norm(r)));
  for (let i = 0; i < 12; i++) {
    const root = free.length ? free[Math.floor(rng.next() * free.length)] : roots[Math.floor(rng.next() * roots.length)];
    const s = series?.length ? series[Math.floor(rng.next() * series.length)] : '';
    const name = `${root}${s}`.trim();
    if (!reg.has(norm(name))) return name;
  }
  let k = 2;
  const root = roots[0] || 'Nave';
  while (reg.has(norm(`${root} ${k}`))) k++;
  return `${root} ${k}`;
}

const fmt = (x) => (x >= 100 ? String(Math.round(x)) : String(round(x, 0.1)).replace('.', ','));

export function genVehicle(data, H, opts = {}) {
  const year = opts.year ?? 2060;
  const eraId = opts.eraId || eraOfYear(ERA_TABLE, year);
  const T = nearestEra(H.vehicles, eraId);
  const op = opts.operator || { id: 'generic', name: 'Consórcio de lançamento', country: 'Internacional', kind: 'company' };
  const n = opts.n ?? 1;
  const rng = rngOf(opts, 'vehicle', op.id, year, n);
  const reg = opts.registry || hardwareRegistry();
  const cl = (opts.cls && T.classes.find((c) => c.class === opts.cls)) || weighted(rng, T.classes);
  const leo = span(rng, cl.leo);
  const capacity = { leo: leo >= 100 ? Math.round(leo) : round(leo, 0.1) };
  let prev = capacity.leo;
  for (const k of CAP_KEYS.slice(1)) {
    const v = Math.min(prev, leo * span(rng, T.ratios[k]));
    capacity[k] = v >= 100 ? Math.floor(v) : Math.floor(v * 10) / 10;
    prev = capacity[k];
  }
  // a 'Pesado' suffix only on heavy/superheavy rockets (never "Atobá Pesado" in the medium class)
  const series = cl.class === 'medium' || cl.class === 'small' ? (T.series || []).filter((x) => !/pesado/i.test(x)) : T.series;
  const name = uniqueName(rng, T.names, series, reg);
  reg.add(norm(name));
  const family = T.families[Math.floor(rng.next() * T.families.length)];
  const reliability = round(span(rng, T.reliability), 0.0001);
  const reusable = rng.next() < T.reusableChance;
  const crewRated = rng.next() < T.crewRatedChance;
  const cadence = Math.round(span(rng, cl.cadence));
  const month = opts.month ?? rng.int(0, 11);
  const clsLabel = H.classLabel?.[cl.class] || cl.class;
  const notes = `Lançador ${clsLabel} ${withArticle(opts.names || {}, op.name, 'de')}, com ${H.familyNote?.[family] || 'propulsão avançada'}. `
    + `Leva ${fmt(capacity.leo)} t à órbita baixa e ${fmt(capacity.mars)} t a Marte${reusable ? ', e volta para voar de novo' : ''}.`;
  return {
    id: `gen_v_${slug(name)}`, name, operator: op.id, provider: op.name, country: op.country || 'Internacional',
    class: cl.class, availableFrom: { year, month }, truthLayer: 'especulacao',
    costM: Math.round(span(rng, cl.costM)), cadencePerYear: cadence, backgroundPerYear: Math.max(0, cadence - 2),
    history: { flights: 0, failures: 0, firstFlight: year }, reusable, crewRated,
    access: op.kind === 'company' || op.kind === 'consortium' ? 'open' : 'own',
    standDownWeeks: Math.round(span(rng, T.standDownWeeks)), capacity, estimatedReliability: reliability,
    family, notes, era: eraId, generated: true,
  };
}

/** Which destinations a craft kind may fly to (by capacityKey reach + destination kind). */
export function craftReach(spec, dests, year) {
  const reach = new Set(spec.reach || CAP_KEYS);
  return dests.filter((d) => {
    if (!d?.id || !reach.has(d.capacityKey)) return false;
    const y = effYear(d);
    if (y != null && year != null && y > year) return false;
    const until = yearOfDate(d.availableUntil);
    if (until != null && year != null && until < year) return false;
    switch (spec.kind) {
      case 'lander': return d.kind === 'surface';
      case 'capsule': return d.kind !== 'surface';
      case 'probe': return d.kind !== 'station';
      case 'cargo': return ['station', 'orbit', 'surface'].includes(d.kind);
      case 'tug': return ['orbit', 'rendezvous', 'station'].includes(d.kind);
      case 'habitat': return ['station', 'orbit', 'surface'].includes(d.kind);
      default: return true;
    }
  }).map((d) => d.id);
}

/** Kinds the era tables do not list but programs may need. */
const EXTRA_KINDS = {
  satellite: { kind: 'satellite', crew: [0, 0], massT: [2, 20], costM: [40, 300], reach: ['leo', 'gto', 'tli'] },
};

const listOf = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

export function genSpacecraft(data, H, opts = {}) {
  const year = opts.year ?? 2060;
  const eraId = opts.eraId || eraOfYear(ERA_TABLE, year);
  const T = nearestEra(H.spacecraft, eraId);
  const op = opts.operator || { id: 'generic', name: 'Consórcio de naves', kind: 'company' };
  const n = opts.n ?? 1;
  const rng = rngOf(opts, 'craft', op.id, year, n);
  const reg = opts.registry || hardwareRegistry();
  const spec = (opts.kind && (T.kinds.find((k) => k.kind === opts.kind) || EXTRA_KINDS[opts.kind])) || weighted(rng, T.kinds);
  const dests = opts.destinations || listOf(data?.destinations, 'destinations');
  const destinations = craftReach(spec, dests, year);
  for (const id of opts.mustReach || []) if (!destinations.includes(id)) destinations.push(id);
  const name = uniqueName(rng, T.names[spec.kind] || H.extraNames?.[spec.kind] || ['Nave'], ['', '', ' II', ' III', ' B'], reg);
  reg.add(norm(name));
  const crew = opts.crew ?? Math.round(span(rng, spec.crew));
  let massT = spec.massT[1] >= 10 ? Math.round(span(rng, spec.massT)) : round(span(rng, spec.massT), 0.1);
  // people need room, air, water and shielding: a crewed craft never weighs less than tPerPerson × crew
  // (so 1.700 colonists never fit in a 200 t habitat); the era table sets how compact the technology is
  const perPerson = Number(spec.tPerPerson) || 0;
  if (crew > 0 && perPerson > 0 && massT < crew * perPerson) massT = Math.round(crew * perPerson);
  if (Number.isFinite(opts.maxMassT) && massT > opts.maxMassT) massT = Math.max(0.1, opts.maxMassT >= 10 ? Math.floor(opts.maxMassT) : round(opts.maxMassT, 0.1));
  const label = H.kindLabel?.[spec.kind] || 'Nave';
  const notes = `${label} ${withArticle(opts.names || {}, op.name, 'de')}${crew ? ` para ${crew} pessoas` : ''}, `
    + `${massT >= 100 ? Math.round(massT) : String(massT).replace('.', ',')} t. ${destinations.length ? `Certificada para ${destinations.length} destino${destinations.length > 1 ? 's' : ''}.` : 'Aguarda certificação de destino.'}`;
  return {
    id: `gen_c_${slug(name)}`, name, operator: op.id, provider: op.name, kind: spec.kind, crew, massT,
    costM: Math.round(span(rng, spec.costM)), availableFrom: { year, month: opts.month ?? rng.int(0, 11) },
    truthLayer: 'especulacao', estimatedReliability: round(span(rng, T.reliability), 0.001),
    history: { flights: 0, failures: 0 }, destinations, compatibleVehicles: [],
    access: op.kind === 'company' || op.kind === 'consortium' ? 'open' : 'own', notes, era: eraId, generated: true,
  };
}

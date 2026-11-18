// Procedural programs (calendar items) for the speculative eras (C8). Data: data/gen/gen-programs.json.
// Each program is 1..n numbered flights with the shape of data/calendar.json `missions` rows
// (truthLayer 'especulacao', delay drawn per era, ids `gen_p_*`). Hardware comes from the given fleet when something
// fits (date, capacity, crew, reach); otherwise a vehicle/craft is generated and returned alongside.
//
//   genPrograms(data, P, H, {eraId, fromYear, toYear, owners, count, destinations, fleet, seed|rng, registry, names})
//     -> {missions, vehicles, spacecraft}
//
// owners: actor-like [{id, name, short, kind, capabilities:{crewed}}]; destinations: destination rows (authored ones
// from data plus interstellarDestinations()); fleet: {vehicles: [], spacecraft: []}.

import { rngOf, span, weighted, slug, norm, nearestEra } from './util.js';
import { genVehicle, genSpacecraft, hardwareRegistry } from './hardware.js';
import { withArticle } from './names.js';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
/** Follow-up flights of a program without their own `textNext`: never repeat the "first time" prose. */
const NEXT_TEXT = '{base} {n} segue o caminho aberto por {base} {prev}: {Owner} volta {a} com o que aprendeu no voo anterior.';
const CRAFT_FOR = { crewed: ['capsule', 'habitat'], lander: ['lander'], cargo: ['cargo'], probe: ['probe'], satellite: ['satellite', 'probe'], station: ['habitat'] };
const yearOf = (d) => (d == null ? null : typeof d === 'number' ? d : d.year ?? null);
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
/** Name used in prose: the full name when short enough, else the short name ("a AEI"). */
const ownerLabel = (o) => (String(o.name || '').length <= 30 ? o.name : o.short || o.name);
const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));

function familyOf(d) {
  if (d.family) return d.family;
  if (d.id.startsWith('region_')) return 'galactic_region';
  if (d.kind === 'interstellar') return 'star_system';
  return null;
}

function destCandidates(t, dests, year, crewed, lastYear = year) {
  return dests.filter((d) => {
    if (t.family) { if (familyOf(d) !== t.family) return false; if (t.hz && !d.hz) return false; }
    else if (!(t.destinations || []).includes(d.id)) return false;
    const from = yearOf(d.fromYear) ?? null;
    if (from != null && from > year) return false;
    const until = yearOf(d.availableUntil);
    if (until != null && until < year) return false;
    const weeks = crewed ? (d.transitWeeksCrewed ?? d.transitWeeks ?? 0) : (d.transitWeeks ?? 0);
    return lastYear + weeks / 52 <= 2999; // the last numbered flight must also arrive before the campaign ends
  });
}

function fitVehicle(fleet, owner, year, capKey, massT) {
  const ok = (fleet.vehicles || []).filter((v) => (yearOf(v.availableFrom) ?? 0) <= year
    && (yearOf(v.availableUntil) ?? Infinity) >= year && (v.operator === owner.id || v.access === 'open' || v.access === 'generic')
    && (Number(v.capacity?.[capKey]) || 0) >= massT);
  return ok.sort((a, b) => (a.costM || 0) - (b.costM || 0) || a.id.localeCompare(b.id))[0] || null;
}

function fitCraft(fleet, owner, year, kinds, destId, crew) {
  const ok = (fleet.spacecraft || []).filter((s) => kinds.includes(s.kind) && (yearOf(s.availableFrom) ?? 0) <= year
    && (s.operator === owner.id || s.access === 'open' || s.access === 'generic')
    && (s.destinations || []).includes(destId) && (s.crew || 0) >= crew);
  return ok.sort((a, b) => (a.costM || 0) - (b.costM || 0) || a.id.localeCompare(b.id))[0] || null;
}

export function genPrograms(data, P, H, opts = {}) {
  const eraId = opts.eraId || 'e5';
  const fromYear = opts.fromYear ?? 2051;
  const toYear = opts.toYear ?? 2199;
  const rng = rngOf(opts, 'programs', eraId, fromYear, toYear);
  const N = opts.names || {};
  const owners = (opts.owners || []).filter((o) => o?.id);
  const dests = opts.destinations || [];
  const fleet = { vehicles: [...(opts.fleet?.vehicles || [])], spacecraft: [...(opts.fleet?.spacecraft || [])] };
  const hwReg = opts.registry || hardwareRegistry([...fleet.vehicles, ...fleet.spacecraft].map((x) => x.name));
  const templates = nearestEra(P.programs, eraId) || [];
  const delay = nearestEra(P.delay, eraId) || { slipChance: 0.4, meanMonths: 9, sdMonths: 6, maxMonths: 36 };
  const out = { missions: [], vehicles: [], spacecraft: [] };
  const usedNames = new Set();
  const ids = new Set();
  const count = opts.count ?? 6;
  let hwN = 0;
  for (let k = 0, tries = 0; k < count && tries < count * 8 && owners.length; tries++) {
    const owner = owners[Math.floor(rng.next() * owners.length)];
    const crewedOk = !!owner.capabilities?.crewed;
    const pool = templates.filter((t) => crewedOk || t.type !== 'crewed');
    const t = weighted(rng, pool);
    if (!t) break;
    const flights = Math.max(1, Math.round(span(rng, t.flights || [1, 1])));
    const gap = span(rng, t.gapYears || [2, 4]);
    const lastStart = toYear - Math.ceil(gap * (flights - 1));
    // an owner flies only while it exists: never before its birth year (+1 to build the hardware) or after its end
    const bornY = yearOf(owner.born);
    const firstStart = Math.max(fromYear, bornY != null ? bornY + 1 : fromYear);
    const endY = yearOf(owner.dissolved ?? owner.until);
    const lastOk = Math.min(lastStart, endY != null ? endY - Math.ceil(gap * (flights - 1)) : lastStart);
    if (lastOk < firstStart) continue;
    const year0 = Math.floor(span(rng, [firstStart, lastOk + 0.999]));
    const cands = destCandidates(t, dests, year0, t.type === 'crewed', Math.min(toYear, year0 + Math.round(gap * (flights - 1))));
    if (!cands.length) continue;
    const dest = cands[Math.floor(rng.next() * Math.min(cands.length, t.family ? 6 : cands.length))];
    const freeNames = (t.names || ['Programa']).filter((n) => !usedNames.has(norm(n)));
    const base = freeNames.length ? freeNames[Math.floor(rng.next() * freeNames.length)] : `${t.names?.[0] || 'Programa'} ${k + 2}`;
    usedNames.add(norm(base));
    k++;
    let prevId = null;
    for (let f = 1; f <= flights; f++) {
      const year = Math.min(toYear, year0 + Math.round(gap * (f - 1)));
      const month = rng.int(0, 11);
      const people = t.type === 'crewed' ? Math.round(span(rng, t.crewSize || [3, 6])) : 0;
      // calendar crewSize is the flight crew (1..12, schema); everyone else travels as passengers/colonists
      const crewSize = Math.min(12, people);
      const capKey = dest.capacityKey || 'outer';
      const kinds = CRAFT_FOR[t.type] || ['probe'];
      // craft first (it sets the payload), then the cheapest vehicle that lifts it; generate what is missing
      let sc = fitCraft(fleet, owner, year, kinds, dest.id, people);
      if (!sc) {
        const kind = people > 12 ? 'habitat' : kinds[0];
        sc = genSpacecraft(data, H, {
          operator: owner, year: Math.max(fromYear, year - 1), eraId, kind, n: ++hwN, rng, registry: hwReg, destinations: dests,
          mustReach: [dest.id], crew: t.type === 'crewed' ? people : 0, names: opts.names,
        });
        fleet.spacecraft.push(sc); out.spacecraft.push(sc);
      }
      let v = fitVehicle(fleet, owner, year, capKey, sc.massT || 1);
      if (!v) {
        v = genVehicle(data, H, { operator: owner, year: Math.max(fromYear, year - 1), eraId, n: ++hwN, rng, registry: hwReg, cls: 'superheavy', names: opts.names });
        fleet.vehicles.push(v); out.vehicles.push(v);
        const cap = Number(v.capacity?.[capKey]) || 0;
        // the biggest rocket of the era still cannot lift it: the ship is assembled in orbit from several launches,
        // which the sim models as one launch of a lighter, generated craft
        if (cap < (sc.massT || 0) && out.spacecraft.includes(sc)) {
          const launches = Math.ceil((sc.massT || 0) / Math.max(cap, 0.1));
          sc.massT = cap >= 10 ? Math.floor(cap) : Math.max(0.1, Math.floor(cap * 10) / 10);
          sc.notes = `${sc.notes} Montada em órbita a partir de ${launches} lançamentos; a massa indicada é a do último módulo.`;
        }
      }
      const name = flights > 1 ? `${base} ${ROMAN[f] || f}` : base;
      let id = `gen_p_${slug(t.id)}_${slug(owner.id)}_${year}`;
      while (ids.has(id)) id += '_b';
      ids.add(id);
      const weeks = t.type === 'crewed' ? (dest.transitWeeksCrewed ?? dest.transitWeeks ?? 0) : (dest.transitWeeks ?? 0);
      const vars = {
        owner: owner.short || owner.name, Owner: withArticle(N, ownerLabel(owner), '', { cap: true }), doOwner: withArticle(N, ownerLabel(owner), 'de'),
        crew: fmtInt(people), dest: dest.name, lugar: dest.short || dest.name,
        em: dest.emLabel || `em ${dest.name}`, a: dest.toLabel || `a ${dest.name}`, years: Math.round(weeks / 52),
      };
      out.missions.push({
        id, name, owner: owner.id, partners: [], type: t.type, destination: dest.id, vehicleId: v.id, spacecraftId: sc.id,
        crewed: t.type === 'crewed', ...(crewSize ? { crewSize } : {}), ...(people > crewSize ? { passengers: people - crewSize } : {}), planned: { year, month }, truthLayer: 'especulacao',
        delay: { ...delay }, prerequisites: prevId ? [prevId] : [],
        milestone: f === 1 ? (t.milestone ?? null) : null, importance: f === 1 ? (t.importance ?? 2) : Math.max(1, (t.importance ?? 2) - 1),
        description: fill(f === 1 ? t.text : (t.textNext || NEXT_TEXT), { ...vars, base, n: ROMAN[f] || f, prev: ROMAN[f - 1] || f - 1 }),
        era: eraId, generated: true, program: t.id,
      });
      prevId = id;
    }
  }
  out.missions.sort((a, b) => a.planned.year - b.planned.year || a.planned.month - b.planned.month || a.id.localeCompare(b.id));
  return out;
}

// Interstellar destinations generated from data/core/stars.json (C8). Ids follow the frozen vocab families
// (<star>_system, <planet>_orbit, <planet>_surface, region_<region>); the output has the shape of
// data/destinations.json rows so missions/calendar read them like any other destination.
//
//   interstellarDestinations(stars, D, {eraId?, untilYear?, authored?}) -> destination[]  (all families, nearest first;
//     ids present in `authored` are skipped so hand-written rows win)
//   destinationById(stars, D, id) -> destination | null
//   transitYears(D, ly, {eraId, crewed}) -> years of flight at that era's speed
//
// Pure, no rng: the same stars.json always yields the same list.

import { fill, round } from './util.js';

const C_KMS = 299792;
const NO_SURFACE = new Set(['gigante gasoso', 'netuniano']);
const ERA_FROM = { e6: 2200, e7: 2600 };

export function transitYears(D, ly, { eraId = 'e6', crewed = false } = {}) {
  const sp = D.speedC?.[eraId] || D.speedC?.e6 || { probe: 0.1, crewed: 0.04 };
  const v = crewed ? sp.crewed : sp.probe;
  return ly / v + (D.boostWeeks?.[crewed ? 'crewed' : 'probe'] ?? 0) / 52;
}

const fmtLy = (ly) => (ly >= 100 ? String(Math.round(ly)) : String(round(ly, 0.1)).replace('.', ','));
const cleanName = (s) => String(s || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();

function build(D, fam, { id, body, name, ly, star, hz, regionId }, eraId) {
  const era = fam.era === 'e7' || eraId === 'e7' ? 'e7' : 'e6';
  const yProbe = transitYears(D, ly, { eraId: era, crewed: false });
  const yCrew = transitYears(D, ly, { eraId: era, crewed: true });
  const sp = D.speedC?.[era] || { probe: 0.1 };
  const vars = { name, star, ly: fmtLy(ly), years: Math.round(yProbe), hz: hz ? D.hzText || '' : '' };
  const label = fill(fam.label, { name });
  const arrival = (D.arrival?.[fam.id] || []).map((m) => ({
    id: m.id, label: fill(m.label, vars), pFail: m.pFail, anomalyBand: round(m.pFail * 1.6, 0.01),
    failureWeights: { ...(D.failureWeights || {}) }, radio: (m.radio || []).map((r) => fill(r, vars)),
  }));
  const firsts = { ...(D.firsts?.[`${fam.id}:${regionId}`] || D.firsts?.[fam.id] || {}) };
  const labels = {
    star_system: [`no ${label}`, `ao ${label}`],
    exoplanet_orbit: [`na órbita de ${name}`, `à órbita de ${name}`],
    exoplanet_surface: [`na superfície de ${name}`, `à superfície de ${name}`],
    galactic_region: [`na região de ${name}`, `à região de ${name}`],
  }[fam.id] || [`em ${name}`, `a ${name}`];
  return {
    id, name: label, emLabel: labels[0], toLabel: labels[1], short: name.length <= 16 ? name : name.slice(0, 16),
    body, kind: fam.kind, capacityKey: 'outer', capacityFactor: fam.kind === 'surface' ? 0.5 : 1,
    route: [
      { from: 'earth', to: 'leo', dv: 9.4 },
      { from: 'leo', to: 'interstellar_cruise', dv: Math.round(sp.probe * C_KMS * 2) },
      { from: 'interstellar_cruise', to: id, dv: fam.kind === 'surface' ? 6 : 1 },
    ],
    transitWeeks: Math.round(yProbe * 52), transitWeeksCrewed: Math.round(yCrew * 52),
    window: null, arrivalMilestones: arrival, firsts,
    description: fill(D.description?.[fam.id] || '{name}', vars),
    era, fromYear: ERA_FROM[era], ly: round(ly, 0.01), family: fam.id, ...(hz ? { hz: true } : {}), generated: true,
  };
}

/** Every interstellar destination derivable from stars.json, nearest first. */
export function interstellarDestinations(stars, D, { eraId = 'e6', untilYear = null, authored = [] } = {}) {
  const out = [];
  const fams = Object.fromEntries((D.families || []).map((f) => [f.from, f]));
  for (const s of stars?.stars || []) {
    if (!s?.id || s.home) continue;
    const sName = cleanName(s.short || s.name);
    if (fams.stars) out.push(build(D, fams.stars, { id: fill(fams.stars.pattern, { star: s.id }), body: s.id, name: sName, ly: s.ly, star: sName }, eraId));
    for (const p of s.planets || []) {
      if (!p?.id) continue;
      const pName = cleanName(p.name);
      if (fams.exoplanets) {
        const orb = (D.families || []).find((f) => f.id === 'exoplanet_orbit');
        const sur = (D.families || []).find((f) => f.id === 'exoplanet_surface');
        if (orb) out.push(build(D, orb, { id: fill(orb.pattern, { planet: p.id }), body: p.id, name: pName, ly: s.ly, star: sName, hz: p.hz }, eraId));
        if (sur && !NO_SURFACE.has(p.kind)) out.push(build(D, sur, { id: fill(sur.pattern, { planet: p.id }), body: p.id, name: pName, ly: s.ly, star: sName, hz: p.hz }, eraId));
      }
    }
  }
  if (fams.regions) for (const r of stars?.galaxy?.regions || []) {
    if (!r?.id || r.kind === 'home') continue;
    const rName = cleanName(r.name);
    out.push(build(D, fams.regions, { id: fill(fams.regions.pattern, { region: r.id }), body: r.id, name: rName, ly: r.d, star: rName, regionId: r.id }, 'e7'));
  }
  // an authored row (data/eras/e6|e7/destinations.json) always wins over the generated one with the same id
  const have = new Set((authored || []).map((d) => d?.id));
  const mine = have.size ? out.filter((d) => !have.has(d.id)) : out;
  const list = untilYear == null ? mine : mine.filter((d) => d.fromYear + d.transitWeeks / 52 <= untilYear);
  return list.sort((a, b) => a.ly - b.ly || a.id.localeCompare(b.id));
}

export function destinationById(stars, D, id) {
  return interstellarDestinations(stars, D).find((d) => d.id === id) || null;
}

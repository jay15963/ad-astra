// Estaleiro (spacecraft designer): the player's own satellites, probes, landers, rovers, capsules, cargo craft and
// station modules, built from parts (data/core/craft-parts.json → data.craftParts), sibling of the Hangar
// (src/sim/designs.js, rockets). Slice: state.craftDesigns = { [id: 'csg_<n>']: CraftDesign } (owner: this module).
//
// CraftDesign = { id, name, owner, role, origin: 'scratch'|'catalog'|'revision', baseCraftId?, parentId?, refSpec?,
//   spec: { role, busId, shape, finish, arrays: 'wings'|'single'|'body', antenna: 'top'|'side', parts: {[partId]: n},
//           propT },
//   derived: { ok, ready, massT, dryT, propT, cargoT, costM, inherent, lifeYears, scienceYr, dv, kind, sub, subs,
//              cap, geometry, scratchDevCostM, scratchDevWeeks } (cache, recomputed on save),
//   program: null | { phase: 'work'|'operational', startedTurn, readyTurn, devCostM, paidM, paused, newness,
//                     operationalTurn? },
//   gap (first-flight reliability still to mature), qual: null | {untilTurn, n}, stats: {flights, ok, counted: []},
//   createdTurn, retired?, asSpacecraft }
// `asSpacecraft` is what src/core/catalog.js (spacecraftDef / listSpacecraft) hands to the game: a spacecraft.json-shaped
// entry with `craftFit` (the capability descriptor read by src/core/craftfit.js) instead of a destination list, and
// `retired: true` until the design is operational. missions.js publishes it into data.index.spacecraft and adds it to
// the player's craft list, so risk.js, launch.js, infra.js and the launch scene resolve it like any catalog craft.
// Deterministic: no Math.random, no Date; no rng at all (development and maturity are bookkeeping). The AI never designs.

import { nextId, addNews, emitSignal, clamp, dueIn } from '../core/helpers.js';
import { turnToDate, yearOf } from '../core/time.js';
import { monthIndex, researchGateOf, itemAvailable } from '../core/catalog.js';
import { craftPartsOf, fitDest, destById, bodyInfo, distClass, dvNeed } from '../core/craftfit.js';
import { destinationOpen } from './simtime.js';
import * as budget from './budget.js';
import * as research from './research.js';
import * as calendar from './calendar.js';

export const meta = { maxDt: 52 };
export { craftPartsOf };

const NAME_MAX = 28;
const OK_LEVELS = new Set(['total', 'partial']);
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const SURFACE_LIKE = new Set(['surface', 'atmosphere']);
const KIND_ORDER = { suborbital: 0, orbit: 1, station: 1, flyby: 2, rendezvous: 3, atmosphere: 4, surface: 5, interstellar: 6 };
const KEY_ORDER = { suborbital: 0, leo: 1, gto: 2, tli: 3, mars: 4, outer: 5, interstellar: 6 };
// science yield per unit of the satellite subtypes whose design science replaces infra's mass factor
const SCI_SUBS = { science: 5, observatory: 18, deep_observatory: 40, earth_obs: 2 };

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : (v != null && v !== '' && Number.isFinite(+v) ? +v : d));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

function ensure(state) {
  if (!state.craftDesigns || typeof state.craftDesigns !== 'object' || Array.isArray(state.craftDesigns)) state.craftDesigns = {};
  return state.craftDesigns;
}

/** Piecewise-linear curve [[year, value], ...] at `year`. */
function curve(points, year, dflt = 1) {
  if (!Array.isArray(points) || !points.length) return dflt;
  if (year <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [y1, v1] = points[i];
    const [y0, v0] = points[i - 1];
    if (year <= y1) return v0 + ((v1 - v0) * (year - y0)) / Math.max(1e-9, y1 - y0);
  }
  return points[points.length - 1][1];
}

const monthNow = (state, turn = state?.turn ?? 0) => { const d = turnToDate(turn, state?.startYear ?? 2026); return d.year * 12 + d.month; };
const yearNow = (state, turn = state?.turn ?? 0) => yearOf(state, turn);
const actorName = (state, id) => state?.actors?.[id]?.short || state?.actors?.[id]?.name || id;

// ---------------------------------------------------------------------------------------------------------------
// Spec (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Clean copy of a spec: known fields only, integer part counts (≥ 1) in sorted key order, propellant ≥ 0. */
export function normalizeSpec(spec = {}) {
  const parts = {};
  const src = spec?.parts && typeof spec.parts === 'object' && !Array.isArray(spec.parts) ? spec.parts : {};
  for (const id of Object.keys(src).sort()) {
    const n = Math.round(num(src[id], 0));
    if (id && n >= 1) parts[String(id)] = Math.min(20, n);
  }
  return {
    role: spec?.role ? String(spec.role) : null,
    busId: spec?.busId ? String(spec.busId) : null,
    shape: spec?.shape ? String(spec.shape) : null,
    finish: spec?.finish ? String(spec.finish) : 'gold',
    arrays: ['wings', 'single', 'body'].includes(spec?.arrays) ? spec.arrays : 'wings',
    antenna: spec?.antenna === 'side' ? 'side' : 'top',
    parts,
    propT: Math.max(0, r3(num(spec?.propT, 0))),
  };
}

/** Part ids a spec uses (bus first). */
export function specPartIds(spec) {
  const s = normalizeSpec(spec);
  return [...(s.busId ? [s.busId] : []), ...Object.keys(s.parts)];
}

/** Share of slots that differ between two specs (0 = same hardware). Shape/finish/placement do not count. */
export function changeFraction(a, b) {
  if (!a || !b) return 1;
  const A = normalizeSpec(a);
  const B = normalizeSpec(b);
  let total = 2;
  let diff = (A.role !== B.role ? 1 : 0) + (A.busId !== B.busId ? 1 : 0);
  const ids = new Set([...Object.keys(A.parts), ...Object.keys(B.parts)]);
  for (const id of ids) { total++; if ((A.parts[id] || 0) !== (B.parts[id] || 0)) diff++; }
  total++;
  const pa = A.propT; const pb = B.propT;
  if (Math.abs(pa - pb) > Math.max(0.02, 0.15 * Math.max(pa, pb))) diff++;
  return total ? r2(diff / total) : 0;
}

/** Same hardware (name, shape, finish and placement do not count). */
export const sameHardware = (a, b) => changeFraction(a, b) === 0;

// ---------------------------------------------------------------------------------------------------------------
// Stats (pure)
// ---------------------------------------------------------------------------------------------------------------

const BUS_SCALE_MAX = 2.2;

/**
 * Pure numbers of a spec at a year: { ok, errors[], missing[], warnings[], ready, massT, dryT, propT, cargoT, costM,
 * inherent, lifeYears, scienceYr, dv, dvEmpty, thrustKN, isp, powerW (generation at 1 AU), useW, comms, crew, lsDays,
 * kind, sub, subs, roverSub, moduleId, cap, geometry, scratchDevCostM, scratchDevWeeks, nParts, slots }.
 * `missing` lists the role's required systems that are absent (shown, and they block development).
 */
export function craftStats(data, specIn, techCtx = {}) {
  const P = craftPartsOf(data);
  const errors = [];
  const warnings = [];
  const missing = [];
  const empty = { ok: false, ready: false, errors, missing, warnings, massT: 0, dryT: 0, propT: 0, cargoT: 0, costM: 0, inherent: 0, lifeYears: 0, scienceYr: 0, dv: 0, dvEmpty: 0, thrustKN: 0, isp: 0, powerW: 0, useW: 0, comms: -1, crew: 0, lsDays: 0, kind: null, sub: null, subs: [], cap: null, geometry: null, scratchDevCostM: 0, scratchDevWeeks: 0, nParts: 0, slots: 0 };
  if (!P) { errors.push('Catálogo de peças do Estaleiro não carregado.'); return empty; }
  const R = P.rules;
  const sp = normalizeSpec(specIn || {});
  const year = num(techCtx.year, 2026);
  const role = P.roles[sp.role];
  if (!role) { errors.push('Escolha a função da nave.'); return empty; }
  const bus = P.byId[sp.busId];
  if (!bus || bus.kind !== 'bus') { errors.push('Escolha a estrutura (corpo) da nave.'); return { ...empty, errors }; }
  if (!(bus.roles || []).includes(role.id)) { errors.push(`${bus.name} não serve para ${role.label.toLowerCase()}.`); return { ...empty, errors }; }
  const items = [];
  for (const [id, n] of Object.entries(sp.parts)) {
    const p = P.byId[id];
    if (!p) { errors.push(`Peça desconhecida: ${id}.`); continue; }
    if (p.kind === 'bus') { errors.push(`${p.name} é uma estrutura: escolha só uma.`); continue; }
    if (Array.isArray(p.roles) && !p.roles.includes(role.id)) { errors.push(`${p.name} não serve para ${role.label.toLowerCase()}.`); continue; }
    if (n > num(p.max, 4)) errors.push(`${p.name}: no máximo ${num(p.max, 4)}.`);
    items.push({ p, n });
  }
  const nParts = items.reduce((a, x) => a + x.n, 0);
  const slots = num(bus.slots, 6);
  if (nParts > slots) errors.push(`${bus.name} tem ${slots} encaixes e o projeto usa ${nParts}: tire peças ou use uma estrutura maior.`);
  const sum = (f) => items.reduce((a, { p, n }) => a + num(p[f], 0) * n, 0);
  const has = (f) => items.some(({ p }) => !!p[f]);
  const seats = sum('seats');
  const crewMax = num(bus.crewMax, 0);
  if (seats > crewMax) errors.push(crewMax > 0 ? `${bus.name} leva no máximo ${crewMax} tripulante(s).` : `${bus.name} não leva tripulação.`);
  for (const { p } of items) if (p.kind === 'escape' && Number.isFinite(p.crewMax) && seats > p.crewMax) errors.push(`${p.name} serve para no máximo ${p.crewMax} tripulante(s).`);
  if (items.filter(({ p }) => p.kind === 'life').length > 1) errors.push('Use um sistema de suporte de vida só.');
  if (items.filter(({ p }) => p.kind === 'escape').length > 1) errors.push('Use um sistema de escape só.');
  if (items.filter(({ p }) => p.shield).length > 1) errors.push('Use um escudo térmico só.');
  if (items.filter(({ p }) => p.kind === 'mobility').length > 1) errors.push('Use um conjunto de rodas só.');
  const maxProp = num(bus.maxPropT, 0);
  if (sp.propT > maxProp + 1e-9) errors.push(maxProp > 0 ? `${bus.name} leva no máximo ${fmtT(maxProp)} de propelente.` : `${bus.name} não leva propelente.`);
  if (sp.shape && Array.isArray(bus.shapes) && !bus.shapes.includes(sp.shape)) warnings.push(`${bus.name} só tem formato ${bus.shapes.map(shapeLabel(P)).join(', ')}.`);

  // ---- mass
  const life = items.find(({ p }) => p.kind === 'life')?.p || null;
  const fixed = num(bus.massT) + sum('massT') + (life ? num(life.perSeatT) * seats : 0);
  const fracSum = sum('massFrac');
  if (fracSum > num(R.maxFrac, 0.6)) errors.push('Escudo, paraquedas, pernas e rodas pesam demais juntos: tire algum.');
  const propT = Math.min(sp.propT, Math.max(0, maxProp));
  const tankT = propT * num(R.tankFrac, 0.1);
  const dryT = (fixed + tankT) / Math.max(0.2, 1 - fracSum);
  const massT = dryT + propT;
  const cargoT = num(bus.cargoT, 0) + sum('cargoT');

  // ---- propulsion
  const engines = items.filter(({ p }) => p.kind === 'engine');
  const chem = engines.filter(({ p }) => !p.ion);
  const ion = engines.filter(({ p }) => p.ion);
  const thrustOf = (list) => list.reduce((a, { p, n }) => a + num(p.thrustKN) * n, 0);
  const ispOf = (list) => { const T = thrustOf(list); const md = list.reduce((a, { p, n }) => a + (num(p.isp) > 0 ? (num(p.thrustKN) * n) / num(p.isp) : 0), 0); return md > 0 ? T / md : 0; };
  const thrustKN = thrustOf(chem);
  const isp = chem.length ? ispOf(chem) : ion.length ? ispOf(ion) : 0;
  const ve = (isp * num(R.g0, 9.80665)) / 1000;
  const dv = propT > 0 && ve > 0 ? ve * Math.log((massT + cargoT) / (dryT + cargoT)) : 0;
  const dvEmpty = propT > 0 && ve > 0 ? ve * Math.log(massT / dryT) : 0;
  if (propT > 0 && !engines.length) warnings.push('Há propelente mas nenhum motor: o tanque é peso morto.');
  if (engines.length && propT <= 0) warnings.push('Motor sem propelente: ponha propelente para ter Δv.');

  // ---- power and comms
  const bodyMounted = sp.arrays === 'body';
  const solarW = items.reduce((a, { p, n }) => a + (p.src === 'solar' ? num(p.solarW) * n * (bodyMounted && p.mount !== 'body' ? 0.5 : 1) : 0), 0);
  const rtgW = sum('rtgW');
  const fcW = sum('genW');
  const battery = items.some(({ p }) => p.src === 'battery');
  const useW = num(bus.powerW) + sum('powerW');
  const comms = items.reduce((a, { p }) => (p.kind === 'comms' ? Math.max(a, num(p.range, 0)) : a), -1);

  // ---- science and tags
  const tags = new Set();
  for (const { p } of items) for (const t of p.tags || []) tags.add(t);
  const scienceYr = sum('scienceYr');
  const shield = items.reduce((a, { p }) => Math.max(a, num(p.shield, 0)), 0);
  const wheels = items.reduce((a, { p }) => Math.max(a, num(p.wheels, 0)), 0);
  const escape = items.find(({ p }) => p.kind === 'escape')?.p?.escape || null;

  // ---- reliability
  let rel = num(bus.reliability, 0.9);
  for (const { p, n } of items) rel *= num(p.reliability, 0.995) ** n;
  const pp = R.partsPenalty || {};
  if (nParts > num(pp.from, 10)) rel *= 1 - num(pp.per, 0.004) * (nParts - num(pp.from, 10));
  const inherent = clamp(rel, num(R.minReliability, 0.4), num(R.maxReliability, 0.995));

  // ---- cost
  const fracMass = (p, n) => num(p.massFrac) * n * dryT;
  let partsCost = num(bus.costM);
  for (const { p, n } of items) partsCost += num(p.costM) * n + num(p.costPerT) * fracMass(p, n);
  if (life) partsCost += num(life.perSeatM) * seats;
  partsCost += num(R.assemblyM, 0.3) * nParts;
  const costM = r1(partsCost * num(R.integrationMult, 2) + propT * num(R.propCostPerT, 0.3));

  // ---- required systems of the role
  const lsDays = life ? num(life.lsDays) : 0;
  const needLabels = { comms: 'Comunicações (antena ou rádio)', power: 'Energia (painel solar, bateria ou RTG)', instrument: 'Pelo menos um instrumento ou carga útil', mobility: 'Rodas', crew: 'Assentos para a tripulação', life: 'Suporte de vida', entry: 'Escudo térmico e paraquedas para a volta', escape: 'Sistema de escape', cargo: 'Compartimento de carga', docking: 'Porta de acoplagem' };
  const haveNeed = {
    comms: comms >= 0, power: solarW > 0 || rtgW > 0 || fcW > 0 || battery, instrument: items.some(({ p }) => p.kind === 'instrument'),
    mobility: wheels > 0, crew: seats > 0, life: !!life, entry: shield > 0 && has('chute'), escape: !!escape, cargo: cargoT > 0, docking: has('docking'),
  };
  for (const k of role.needs || []) if (!haveNeed[k]) missing.push(needLabels[k] || k);
  if (role.id === 'lander' && seats > 0 && !life) missing.push(needLabels.life);

  // ---- kind, subtypes, module
  const kind = role.kind;
  const subs = [];
  if (role.id === 'satellite') {
    for (const t of R.subPriority || []) if (t === 'science' ? scienceYr > 0 && tags.has('science') : tags.has(t)) subs.push(t);
    if (tags.has('comms') && massT <= num(R.constellationMaxT, 0.6)) subs.push('constellation');
  }
  const roverSub = role.id === 'rover' ? bus.roverSub || 'medium' : null;
  const sub = role.id === 'rover' ? roverSub : subs[0] || null;
  const moduleId = role.id === 'module'
    ? (scienceYr >= 4 ? 'st_lab' : sum('cargoT') >= 3 ? 'st_logistics' : items.filter(({ p }) => p.docking).reduce((a, x) => a + x.n, 0) >= 2 ? 'st_node' : solarW >= 8000 ? 'st_solar' : 'st_core')
    : null;

  // ---- capability descriptor (src/core/craftfit.js)
  const cap = {
    role: role.id, kind, massT: r3(massT), dryT: r3(dryT), cargoT: r2(cargoT), dv: r3(dv), thrust: r3(thrustKN),
    throttle: chem.some(({ p }) => p.throttle), hasEngine: engines.length > 0 && propT > 0, ionOnly: !chem.length && ion.length > 0,
    comms, solarW: Math.round(solarW), rtgW: Math.round(rtgW), fcW: Math.round(fcW), useW: Math.round(useW), battery,
    shield, chute: has('chute'), airbags: has('airbags'), legs: has('legs'), skycrane: has('skycrane'), pressure: has('pressure'),
    wheels, docking: has('docking'), arm: has('arm'), sampler: has('sampler'), crew: seats, lsDays, escape: !!escape,
    impactor: tags.has('impactor'), sample: tags.has('sample'), life: num(bus.lifeYears, 1), sci: r2(scienceYr),
  };

  // ---- development from scratch
  const D = R.dev || {};
  const cx = D.complexity || {};
  const landing = cap.legs || cap.airbags || cap.skycrane;
  const complexity = 1 + (landing ? num(cx.landing, 0.3) : 0) + (seats > 0 ? num(cx.crewed, 0.6) : 0) + (role.id === 'rover' ? num(cx.rover, 0.25) : 0)
    + (shield > 0 ? num(cx.entry, 0.15) : 0) + (cap.docking ? num(cx.docking, 0.1) : 0) + (ion.length ? num(cx.ion, 0.1) : 0);
  const scratchDevCostM = Math.round(Math.max(num(D.minCostM, 8), num(D.devK, 5) * costM * complexity));
  const scratchDevWeeks = Math.round((num(D.baseWeeks, 39) + num(D.perPartWeeks, 2) * nParts + (seats > 0 ? num(D.crewedWeeks, 39) : 0)
    + (landing ? num(D.landingWeeks, 13) : 0) + (role.id === 'rover' ? num(D.roverWeeks, 13) : 0)) * curve(D.eraWeeksMult, year, 1));

  // ---- geometry for the painter (src/ui/launch-render/vehicles.js craft design adapter)
  const geometry = geometryOf(P, sp, { role, bus, items, dryT, massT, solarW, rtgW, cap, seats, cargoT, propT, ion: ion.length > 0, tags, moduleId });

  const ok = errors.length === 0;
  return {
    ok, ready: ok && missing.length === 0, errors, missing, warnings,
    massT: r3(massT), dryT: r3(dryT), propT: r3(propT), cargoT: r2(cargoT), costM, inherent: r3(inherent), lifeYears: num(bus.lifeYears, 1),
    scienceYr: r2(scienceYr), dv: r2(dv), dvEmpty: r2(dvEmpty), thrustKN: r3(thrustKN), isp: Math.round(isp), powerW: Math.round(solarW + rtgW + fcW), solarW: Math.round(solarW), rtgW: Math.round(rtgW), useW: Math.round(useW),
    comms, crew: seats, lsDays, kind, sub, subs, roverSub, moduleId, cap, geometry, scratchDevCostM, scratchDevWeeks, nParts, slots,
    maxPropT: maxProp, busName: bus.name, roleLabel: role.label,
  };
}

const fmtT = (t) => `${String(Math.round(num(t, 0) * 100) / 100).replace('.', ',')} t`;
const shapeLabel = (P) => (id) => (P.shapes.find((s) => s.id === id)?.label || id).toLowerCase();

/** Visual description of a design (metres; painter-agnostic). */
function geometryOf(P, sp, { role, bus, items, dryT, massT, solarW, rtgW, cap, seats, cargoT, propT, ion, tags, moduleId }) {
  const fin = P.finishes.find((f) => f.id === sp.finish) || P.finishes[0] || { id: 'gold', mat: 'gold_foil' };
  const d0 = bus.dims || { w: 1.5, h: 1.5 };
  const grow = ['satellite', 'probe', 'lander', 'rover'].includes(role.id) ? clamp(Math.cbrt(Math.max(1, dryT / Math.max(0.005, num(bus.massT, 0.1)) / 2.5)), 1, BUS_SCALE_MAX) : 1;
  const comm = items.filter(({ p }) => p.kind === 'comms').map(({ p }) => p).sort((a, b) => num(b.dishD) - num(a.dishD))[0] || null;
  const shape = sp.shape && (bus.shapes || []).includes(sp.shape) ? sp.shape : (bus.shapes || ['box'])[0];
  const solarParts = items.filter(({ p }) => p.src === 'solar');
  const onlyBody = solarParts.length > 0 && solarParts.every(({ p }) => p.mount === 'body');
  const arrays = !solarParts.length ? 'none' : onlyBody || sp.arrays === 'body' ? 'body' : sp.arrays;
  const w = r2(num(d0.w, 1.5) * grow);
  return {
    role: role.id, shape, finish: fin.id, mat: fin.mat || 'gold_foil', w, h: r2(num(d0.h, 1.5) * grow),
    arrays, spanM: arrays === 'wings' || arrays === 'single' ? r1(w + 2 * clamp(Math.sqrt(solarW / 120), 0.6, 18)) : 0,
    panels: clamp(Math.round(Math.sqrt(solarW / 150)), 1, 5),
    hgaD: comm ? r2(num(comm.dishD, comm.range >= 1 ? 0.6 : 0)) : 0, antenna: sp.antenna,
    rtg: rtgW > 0 ? Math.min(3, items.filter(({ p }) => p.src === 'rtg').reduce((a, x) => a + x.n, 0)) : 0,
    ion, legs: cap.legs, airbags: cap.airbags, skycrane: cap.skycrane, wheels: cap.wheels, chute: cap.chute, shield: cap.shield,
    drill: tags.has('drill'), sampler: cap.sampler, arm: cap.arm, impactor: cap.impactor, telescope: tags.has('observatory') || tags.has('deep_observatory'),
    crew: seats, docking: cap.docking, cargoT: r1(cargoT), propT: r2(propT), massT: r2(massT), moduleId: moduleId || null,
    engine: cap.hasEngine ? (cap.throttle ? 'descent' : ion ? 'ion' : 'main') : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Access (dates + research gate) — the player only
// ---------------------------------------------------------------------------------------------------------------

/** Can the actor use this part (or bus) now for this role? → {ok, reason, nodeId}. */
export function partAccess(state, data, part, actorId = state?.playerId, { role = null, turn = state?.turn } = {}) {
  if (!part) return { ok: false, reason: 'Peça desconhecida', nodeId: null };
  const now = monthNow(state, turn);
  if (monthIndex(part.availableFrom) > now) return { ok: false, reason: `Disponível em ${part.availableFrom.year}`, nodeId: null };
  if (part.availableUntil && monthIndex(part.availableUntil) < now) return { ok: false, reason: 'Fora de produção', nodeId: null };
  if (role && Array.isArray(part.roles) && !part.roles.includes(role)) return { ok: false, reason: 'Não serve para esta função', nodeId: null, role: true };
  const g = researchGateOf(data, state, 'craftPart', part, actorId);
  if (!g.ok) return { ok: false, reason: g.reason, nodeId: g.nodeId || null };
  return { ok: true, reason: null, nodeId: null };
}

/** Research gate of a role (and of its crew size): {ok, reason, nodeId}. */
export function roleAccess(state, data, roleId, { seats = 0 } = {}, actorId = state?.playerId) {
  const P = craftPartsOf(data);
  const role = P?.roles?.[roleId];
  if (!role) return { ok: false, reason: 'Função desconhecida', nodeId: null };
  const g = researchGateOf(data, state, 'craftRole', role, actorId);
  if (!g.ok) return { ok: false, reason: g.reason, nodeId: g.nodeId || null };
  if (seats > 0 && actorId === state?.playerId) {
    const R = P.rules || {};
    const keys = [];
    if (roleId === 'lander' && R.crewLanderKey) keys.push(R.crewLanderKey);
    if (roleId === 'capsule') for (const [min, key] of R.seatKeys || []) if (seats >= min) keys.push(key);
    const m = keys.length ? researchGateOf(data, state, 'craftRole', { gate: keys }, actorId) : { ok: true };
    if (!m.ok) return { ok: false, reason: `${m.reason} para ${seats} tripulante(s)`, nodeId: m.nodeId || null };
  }
  return { ok: true, reason: null, nodeId: null };
}

/** Locked parts (and role) of a spec for the actor → [{id, name, reason, nodeId}]. */
export function lockedParts(state, data, spec, actorId = state?.playerId) {
  const P = craftPartsOf(data);
  if (!P) return [];
  const s = normalizeSpec(spec);
  const out = [];
  const seats = Object.entries(s.parts).reduce((a, [id, n]) => a + num(P.byId[id]?.seats, 0) * n, 0);
  const ra = roleAccess(state, data, s.role, { seats }, actorId);
  if (!ra.ok && P.roles[s.role]) out.push({ id: s.role, name: P.roles[s.role].label, reason: ra.reason, nodeId: ra.nodeId });
  for (const id of specPartIds(s)) {
    const a = partAccess(state, data, P.byId[id], actorId, { role: null });
    if (!a.ok) out.push({ id, name: P.byId[id]?.name || id, reason: a.reason, nodeId: a.nodeId });
  }
  return out;
}

function usable(state, data, kind, roleId, actorId = state?.playerId) {
  const P = craftPartsOf(data);
  return (P?.list || []).filter((p) => p.kind === kind && (kind !== 'bus' || (p.roles || []).includes(roleId)) && partAccess(state, data, p, actorId, { role: kind === 'bus' ? null : roleId }).ok);
}

export function techCtxFor(state) {
  return { year: yearNow(state) };
}

// ---------------------------------------------------------------------------------------------------------------
// Destinations and missions a design can fly
// ---------------------------------------------------------------------------------------------------------------

const destOpen = (dest, year) => !!dest && destinationOpen(dest, year);

/** Fit of a capability descriptor against every destination open now (pure on data + year). */
export function fitAll(state, data, cap, { year = yearNow(state) } = {}) {
  const out = [];
  for (const d of data?.destinations?.destinations || []) {
    if (!destOpen(d, year)) continue;
    const f = fitDest(data, cap, d);
    out.push({ id: d.id, name: d.name, short: d.short || null, body: d.body, kind: d.kind, capacityKey: d.capacityKey, ok: f.ok, reasons: f.reasons, warnings: f.warnings, needDv: f.needDv, lifeYears: f.lifeYears, scienceYr: f.scienceYr, companion: f.companion });
  }
  return out;
}

const TYPE_LABEL = { satellite: 'Satélite', probe: 'Sonda', rover: 'Rover', crewed: 'Tripulada', cargo: 'Carga', station: 'Estação' };
const PROBE_SUB_LABEL = { orbiter: 'Orbitador', flyby: 'Sobrevoo', lander: 'Pouso de sonda', atmospheric: 'Sonda atmosférica', small_body: 'Asteroides e cometas', impactor: 'Impactador', sample_return: 'Retorno de amostras' };

/** Mission types and subtypes a design can fly (for the editor): [{type, label, subs: [{id, label}]}]. */
export function missionTypesOf(data, stats, fits) {
  if (!stats?.cap) return [];
  const cap = stats.cap;
  const okKinds = new Set((fits || []).filter((f) => f.ok).map((f) => f.kind));
  const subLabel = (type, id) => (data?.missions?.subtypes || []).find((r) => r.type === type && r.id === id)?.label || PROBE_SUB_LABEL[id] || id;
  const out = [];
  const push = (type, subs) => out.push({ type, label: TYPE_LABEL[type], subs: subs.map((id) => ({ id, label: subLabel(type, id) })) });
  if (!okKinds.size) return out;
  const probeSubs = () => {
    const s = [];
    if (okKinds.has('orbit')) s.push('orbiter');
    if (okKinds.has('flyby')) s.push('flyby');
    if (okKinds.has('rendezvous')) s.push('small_body');
    if (okKinds.has('atmosphere')) s.push('atmospheric');
    if (okKinds.has('surface') && cap.impactor) s.push('impactor');
    if (okKinds.has('surface') && cap.role === 'lander') s.push('lander');
    if (cap.sample && (okKinds.has('surface') || okKinds.has('rendezvous'))) s.push('sample_return');
    return s;
  };
  switch (cap.role) {
    case 'satellite': push('satellite', stats.subs || []); push('probe', probeSubs()); break;
    case 'probe': push('probe', probeSubs()); break;
    case 'lander':
      push('probe', probeSubs());
      if (cap.cargoT > 0) push('cargo', ['experiments', 'base_module', 'base_vehicle', 'supply'].filter((x) => (data?.missions?.subtypes || []).some((r) => r.type === 'cargo' && r.id === x)));
      if (cap.crew > 0) push('crewed', ['landing']);
      break;
    case 'rover': push('rover', stats.roverSub ? [stats.roverSub] : []); break;
    case 'capsule': push('crewed', ['orbital', ...(okKinds.has('station') ? ['rotation'] : []), ...(okKinds.has('flyby') ? ['flyby'] : [])]); if (cap.cargoT > 0) push('cargo', ['supply']); break;
    case 'cargo': push('cargo', ['supply', 'experiments']); break;
    case 'module': push('station', ['found', 'expand']); break;
    default: break;
  }
  return out.filter((x) => x.subs.length || ['rover', 'station'].includes(x.type));
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-fill: a first draft that fits a target with the parts the agency has now
// ---------------------------------------------------------------------------------------------------------------

const byMass = (a, b) => num(a.massT) - num(b.massT) || num(a.costM) - num(b.costM) || (a.id < b.id ? -1 : 1);

/**
 * Spec for a role that flies to `destId` with the agency's parts now (smallest structure that fits), or the closest
 * attempt when none fits, or null when the role has no structure available. opts: {sub, crew, cargoT, massHint}.
 */
export function fillRole(state, data, roleId, destId = null, opts = {}) {
  const P = craftPartsOf(data);
  const role = P?.roles?.[roleId];
  if (!role) return null;
  const dest = destById(data, destId) || destById(data, role.target) || destById(data, 'leo');
  let buses = usable(state, data, 'bus', roleId).sort(byMass);
  if (opts.crew > 0) buses = buses.filter((b) => num(b.crewMax) >= 1);
  else if (roleId === 'lander') buses = buses.filter((b) => !num(b.crewMax)).concat(buses.filter((b) => num(b.crewMax) > 0));
  if (opts.massHint > 0) {
    const big = buses.filter((b) => num(b.massT) >= opts.massHint * 0.18);
    if (big.length) buses = big.concat(buses.filter((b) => !big.includes(b)));
  }
  if (!buses.length) return null;
  let last = null;
  for (const bus of buses) {
    const spec = buildFor(state, data, role, bus, dest, opts);
    if (!spec) continue;
    last = spec;
    const st = craftStats(data, spec, techCtxFor(state));
    if (st.ok && st.ready && fitDest(data, st.cap, dest).ok) return spec;
  }
  return last;
}

function bestOf(list, score) {
  return list.slice().sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1))[0] || null;
}

function buildFor(state, data, role, bus, dest, opts) {
  const P = craftPartsOf(data);
  const R = P.rules;
  const U = (kind) => usable(state, data, kind, role.id);
  const body = bodyInfo(data, dest);
  const dc = distClass(dest, body);
  const parts = {};
  const add = (p, n = 1) => { if (p) parts[p.id] = (parts[p.id] || 0) + n; };
  const slotsLeft = () => num(bus.slots, 6) - Object.values(parts).reduce((a, n) => a + n, 0);
  const kind = dest?.kind;
  const surface = kind === 'surface';
  const air = body.atmo !== 'none';
  const crew = clamp(Math.round(num(opts.crew, role.id === 'capsule' ? 1 : 0)), 0, num(bus.crewMax, 0));
  // payload / instruments
  const inst = U('instrument');
  if (['satellite', 'probe', 'lander', 'rover'].includes(role.id) && crew === 0) {
    const want = opts.sub && inst.some((p) => (p.tags || []).includes(opts.sub)) ? opts.sub : null;
    if (want) {
      const p = bestOf(inst.filter((x) => (x.tags || []).includes(want)), (x) => -num(x.massT));
      add(p, want === 'comms' ? 2 : 1);
    } else {
      const sci = inst.filter((x) => (x.tags || []).includes('science') && !(x.tags || []).includes('impactor') && !(x.tags || []).includes('sample'));
      add(bestOf(sci, (x) => num(x.scienceYr) / (0.5 + num(x.costM)) - num(x.massT)));
    }
    if (opts.sub === 'sample_return') add(bestOf(inst.filter((x) => (x.tags || []).includes('sample')), (x) => -num(x.massT)));
  }
  // comms
  const comms = U('comms');
  add(bestOf(comms.filter((p) => num(p.range) >= dc), (p) => -num(p.costM) - num(p.massT)) || bestOf(comms, (p) => num(p.range)));
  // crew systems
  if (crew > 0) {
    add(U('crew').find((p) => p.seats), crew);
    const days = role.id === 'lander' ? num(R.landerCrewDays, 4) : num(R.crewDays?.[dc], 3);
    const ls = U('life').sort((a, b) => num(a.lsDays) - num(b.lsDays));
    add(ls.find((p) => num(p.lsDays) >= days) || ls[ls.length - 1]);
    if (role.id === 'capsule') {
      const esc = U('escape').filter((p) => !(Number.isFinite(p.crewMax) && crew > p.crewMax)).sort(byMass);
      add(esc[0]);
      const rs = num(R.returnShield?.[dc], 1);
      const hs = U('entry').filter((p) => num(p.shield) >= rs).sort((a, b) => num(a.massFrac) - num(b.massFrac));
      add(hs[0] || bestOf(U('entry').filter((p) => p.shield), (p) => num(p.shield)));
      add(U('entry').find((p) => p.chute));
    }
  }
  // entry / landing
  const entry = U('entry');
  const landing = U('landing');
  if ((surface || kind === 'atmosphere') && air && role.id !== 'capsule') {
    const hs = entry.filter((p) => num(p.shield) >= body.entry).sort((a, b) => num(a.massFrac) - num(b.massFrac));
    add(hs[0]);
    add(entry.find((p) => p.chute));
    if (surface && body.hot) add(entry.find((p) => p.pressure));
    if (surface && body.atmo === 'thin') {
      const sky = landing.find((p) => p.skycrane);
      const bags = landing.find((p) => p.airbags);
      if (role.id === 'rover' && sky && bus.roverSub === 'heavy') add(sky);
      else if (bags) add(bags);
      else if (sky) add(sky);
      else add(landing.find((p) => p.legs));
    } else if (surface && role.id === 'lander') add(landing.find((p) => p.legs) || landing.find((p) => p.airbags));
  } else if (surface && !(role.id === 'probe')) {
    if (body.g >= num(R.smallBodyG, 0.005)) add(landing.find((p) => p.legs) || landing.find((p) => p.airbags));
    else add(landing.find((p) => p.legs) || U('arm').find((p) => p.sampler));
  }
  if (role.id === 'rover') add(bestOf(U('mobility'), (p) => num(p.reliability) - num(p.massFrac)));
  // docking and cargo
  if (kind === 'station' || role.id === 'cargo' || role.id === 'module') add(bestOf(U('docking'), (p) => -num(p.massT)));
  if (opts.cargoT > 0) {
    const holds = U('cargo').sort((a, b) => num(b.cargoT) / num(b.massT, 1) - num(a.cargoT) / num(a.massT, 1));
    const h = holds[0];
    const have = num(bus.cargoT, 0);
    if (h && opts.cargoT > have) add(h, Math.min(num(h.max, 8), Math.ceil((opts.cargoT - have) / Math.max(0.1, num(h.cargoT, 1)))));
  }
  // engine
  const probeStats = (extra = {}) => craftStats(data, { role: role.id, busId: bus.id, shape: (bus.shapes || [])[0], finish: defaultFinish(role.id), parts: { ...parts, ...extra.parts }, propT: extra.propT ?? 0 }, techCtxFor(state));
  const need0 = dvNeed(data, probeStats().cap, dest, body);
  const needDv = need0.dv;
  const engines = U('engine');
  let eng = null;
  if (needDv > 0.001) {
    const landsHere = need0.mode === 'land' || (need0.mode === 'airland' && needDv > 0);
    const big = body.g >= num(R.throttleG, 0.05);
    const cand = engines.filter((p) => !p.ion && (!landsHere || !big || p.throttle));
    eng = landsHere ? bestOf(cand, (p) => num(p.isp) / 100 + Math.log10(1 + num(p.thrustKN)) - num(p.massT) * 2)
      : bestOf(cand.filter((p) => !p.throttle || role.id === 'lander'), (p) => num(p.isp) - num(p.massT) * 200 - num(p.costM));
    if (!eng && !landsHere) eng = bestOf(engines, (p) => num(p.isp));
    add(eng);
  }
  // power (after everything that draws it)
  const powerFor = () => {
    const st = probeStats();
    const use = st.useW;
    const solar = U('power').filter((p) => p.src === 'solar' && p.mount !== 'body').sort((a, b) => num(a.solarW) - num(b.solarW));
    const rtg = U('power').filter((p) => p.src === 'rtg').sort((a, b) => num(a.rtgW) - num(b.rtgW));
    const bat = bestOf(U('power').filter((p) => p.src === 'battery'), (p) => -num(p.massT));
    const au = Math.max(0.1, body.au);
    const lunarNight = surface && body.night;
    if (au <= 3.2) {
      for (const s of solar) {
        const n = Math.ceil((use * 1.15 * au * au) / Math.max(1, num(s.solarW)));
        if (n <= num(s.max, 4)) { add(s, Math.max(1, n)); if (bat) add(bat); return; }
      }
      if (solar.length) { const s = solar[solar.length - 1]; add(s, num(s.max, 4)); if (bat) add(bat); return; }
    }
    for (const r of rtg) {
      const n = Math.ceil((use * 1.05) / Math.max(1, num(r.rtgW)));
      if (n <= num(r.max, 4)) { add(r, Math.max(1, n)); return; }
    }
    if (rtg.length) { add(rtg[rtg.length - 1], num(rtg[rtg.length - 1].max, 4)); return; }
    const cells = U('power').find((p) => p.src === 'solar');
    if (cells && !lunarNight) add(cells, Math.min(num(cells.max, 4), Math.max(1, Math.ceil((use * au * au) / Math.max(1, num(cells.solarW))))));
    if (bat) add(bat);
  };
  if (crew > 0 && role.id === 'capsule' && dc === 0) {
    const fc = U('power').find((p) => p.src === 'fuelcell');
    const st = probeStats();
    if (fc && num(fc.genW) >= st.useW) add(fc); else powerFor();
  } else powerFor();
  // propellant: iterate (dry mass grows with the tank), then engine count for the landing thrust
  let propT = 0;
  if (eng) {
    const target = needDv * 1.08;
    for (let i = 0; i < 8; i++) {
      const st = probeStats({ propT });
      if (!(st.isp > 0)) break;
      const ve = (st.isp * num(R.g0, 9.80665)) / 1000;
      const want = (st.dryT + st.cargoT) * (Math.exp(target / ve) - 1);
      propT = r3(Math.min(num(bus.maxPropT, 0), want));
    }
    if (need0.mode === 'land' && body.g >= num(R.smallBodyG, 0.005)) {
      for (let i = 0; i < 4; i++) {
        const st = probeStats({ propT });
        const needKN = (st.massT + st.cargoT) * 9.80665 * body.g * num(R.landTwr, 1.5);
        if (st.thrustKN >= needKN || (parts[eng.id] || 0) >= num(eng.max, 3) || slotsLeft() <= 0) break;
        parts[eng.id] += 1;
      }
    }
  }
  if (slotsLeft() < 0) {
    // too many parts for this structure: let the caller try the next one
    return { role: role.id, busId: bus.id, shape: (bus.shapes || [])[0], finish: defaultFinish(role.id), arrays: 'wings', antenna: 'top', parts, propT };
  }
  return normalizeSpec({ role: role.id, busId: bus.id, shape: (bus.shapes || [])[0], finish: defaultFinish(role.id), arrays: 'wings', antenna: 'top', parts, propT });
}

function defaultFinish(role) {
  return role === 'capsule' || role === 'cargo' || role === 'module' || role === 'rover' ? 'white' : 'gold';
}

/** Catalog craft → role of the Estaleiro. */
export function roleOfCraft(sc) {
  const k = sc?.kind;
  if (k === 'satellite' || k === 'probe' || k === 'lander' || k === 'rover' || k === 'capsule' || k === 'cargo') return k;
  if (k === 'station_module') return 'module';
  return null;
}

/** The hardest destination a catalog craft lists that is open now (its template target), else the role default. */
function craftTarget(state, data, sc, role) {
  const year = yearNow(state);
  const list = (sc?.destinations || []).map((id) => destById(data, id)).filter((d) => d && destOpen(d, year));
  if (!list.length) return role?.target || 'leo';
  list.sort((a, b) => (KEY_ORDER[b.capacityKey] ?? 0) - (KEY_ORDER[a.capacityKey] ?? 0) || (KIND_ORDER[b.kind] ?? 0) - (KIND_ORDER[a.kind] ?? 0) || (a.id < b.id ? -1 : 1));
  // a satellite template sizes for its own orbit, not for the far end of a generic list
  return (role?.id === 'satellite' ? list[list.length - 1] : list[0]).id;
}

/** Template spec from a catalog craft (role, size, subtype, crew, target) or null. */
export function templateFromCraft(state, data, craftId) {
  const sc = data?.index?.spacecraft?.[craftId] || (data?.spacecraft?.spacecraft || []).find((x) => x.id === craftId);
  const roleId = roleOfCraft(sc);
  const P = craftPartsOf(data);
  if (!sc || !roleId || !P?.roles?.[roleId]) return null;
  const target = craftTarget(state, data, sc, P.roles[roleId]);
  const spec = fillRole(state, data, roleId, target, { sub: sc.sub || null, crew: num(sc.crew, 0), cargoT: num(sc.cargoT, 0), massHint: num(sc.massT, 0) });
  return spec ? { spec, target, craft: sc, role: roleId } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Program numbers, asSpacecraft, reliability
// ---------------------------------------------------------------------------------------------------------------

function techBonus(state, actorId, key) {
  try { const v = research.techBonus(state, actorId, key); return Number.isFinite(v) ? v : 0; } catch { return 0; }
}

/** {devCostM, devWeeks, upfrontM, newness, change} of a design (or a fake one) with its derived stats. */
export function programCosts(state, data, d, st) {
  const D = craftPartsOf(data)?.rules?.dev || {};
  if (!st?.ok) return { devCostM: 0, devWeeks: 0, upfrontM: 0, newness: 0, change: 0 };
  const nw = D.newness || {};
  let devCostM = st.scratchDevCostM;
  let devWeeks = st.scratchDevWeeks;
  let newness = num(nw.scratch, 0.1);
  let change = 1;
  if (d?.parentId && d.refSpec) {
    const rv = D.revision || {};
    change = changeFraction(d.spec, d.refSpec);
    const f = Math.max(num(rv.minChange, 0.25), change);
    devCostM = st.scratchDevCostM * num(rv.costFrac, 0.35) * f;
    devWeeks = Math.max(num(rv.minWeeks, 13), st.scratchDevWeeks * num(rv.weeksFrac, 0.4) * f);
    newness = num(nw.revision, 0.04);
  } else if (d?.origin === 'catalog' && d.refSpec) {
    change = changeFraction(d.spec, d.refSpec);
    if (change <= num(D.catalogMaxChange, 0.35)) {
      devCostM *= 1 - num(D.catalogCut, 0.2);
      devWeeks *= 1 - num(D.catalogCut, 0.2);
      newness = num(nw.catalog, 0.07);
    }
  }
  devWeeks *= Math.max(0.4, 1 + techBonus(state, d?.owner ?? state?.playerId, 'devTime'));
  devCostM = Math.round(devCostM);
  devWeeks = Math.max(8, Math.round(devWeeks));
  return { devCostM, devWeeks, upfrontM: Math.round(devCostM * num(D.upfrontFrac, 0.3)), newness, change: r2(change) };
}

/** Current first-flight gap (reliability still to mature). */
const gapOf = (d) => num(d?.gap, num(d?.program?.newness, num(craftPartsOf(null)?.rules?.dev?.newness?.scratch, 0.1)));

export function craftReliability(state, data, id) {
  const d = state?.craftDesigns?.[id];
  if (!d) return { mean: 0.8, low: 0.6, high: 0.95 };
  try {
    const r = calendar.spacecraftReliability(state, data, id);
    if (r && Number.isFinite(r.mean)) return r;
  } catch { /* fall back */ }
  const m = clamp(num(d.derived?.inherent, 0.85) - gapOf(d), 0.3, 0.999);
  return { mean: m, low: clamp(m - 0.08, 0, 1), high: clamp(m + 0.03, 0, 1) };
}

/** Surface destinations where a crewed capsule lands with a separate crewed lander (missions.needsLander). */
function landerRequiredOf(data, cap) {
  if (cap?.role !== 'capsule' || !(cap.crew > 0)) return null;
  const out = [];
  for (const dest of data?.destinations?.destinations || []) {
    if (dest.kind !== 'surface' || (dest.body ?? 'earth') === 'earth') continue;
    const f = fitDest(data, cap, dest);
    if (f.ok && f.companion) out.push(dest.id);
  }
  return out;
}

function subScience(data, sub) {
  const row = (data?.missions?.subtypes || []).find((r) => r.type === 'satellite' && r.id === sub);
  return num(row?.yield?.scienceYr, SCI_SUBS[sub] ?? 0);
}

function refreshCraft(state, data, d) {
  const der = d.derived || {};
  const me = state.actors?.[d.owner] || {};
  const prog = d.program;
  const operational = prog?.phase === 'operational';
  const od = turnToDate(prog?.operationalTurn ?? state.turn, state.startYear);
  const cap = der.cap || null;
  const yk = der.sub && SCI_SUBS[der.sub] != null && subScience(data, der.sub) > 0 ? r2(clamp(num(der.scienceYr) / subScience(data, der.sub), 0.5, 3)) : null;
  const v = {
    id: d.id, name: d.name, operator: d.owner, provider: me.short || me.name || 'Sua agência', kind: der.kind || 'probe',
    ...(der.sub ? { sub: der.sub } : {}), ...(Array.isArray(der.subs) && der.subs.length ? { subs: der.subs.slice() } : {}),
    crew: num(der.crew, 0), massT: num(der.massT, 1), costM: num(der.costM, 10), cargoT: num(der.cargoT, 0),
    availableFrom: { year: od.year, month: od.month + 1 }, truthLayer: 'jogador',
    estimatedReliability: r3(clamp(num(der.inherent, 0.85) - gapOf(d), 0.3, 0.999)),
    history: { flights: 0, failures: 0 }, destinations: [], access: 'own',
    craftDesign: true, designId: d.id, craftFit: cap,
    design: { geometry: der.geometry || null, lifeYears: num(der.lifeYears, 1), ...(yk != null ? { yieldK: yk } : {}) },
    notes: d.origin === 'catalog' && d.baseCraftName ? `Projeto do Estaleiro baseado na ${d.baseCraftName}.` : 'Projeto próprio do Estaleiro.',
  };
  if (der.moduleId) v.moduleId = der.moduleId;
  if (cap?.role === 'lander' && cap.crew > 0) v.companionOnly = true;
  const lr = landerRequiredOf(data, cap);
  if (lr && lr.length) v.landerRequired = lr;
  if (!operational || d.retired) v.retired = true;
  d.asSpacecraft = v;
  return v;
}

function compactDerived(st) {
  return {
    ok: !!st.ok, ready: !!st.ready, massT: st.massT, dryT: st.dryT, propT: st.propT, cargoT: st.cargoT, costM: st.costM, inherent: st.inherent,
    lifeYears: st.lifeYears, scienceYr: st.scienceYr, dv: st.dv, crew: st.crew, kind: st.kind, sub: st.sub, subs: st.subs, roverSub: st.roverSub,
    moduleId: st.moduleId, cap: st.cap, geometry: st.geometry, scratchDevCostM: st.scratchDevCostM, scratchDevWeeks: st.scratchDevWeeks,
  };
}

function recompute(state, data, d) {
  const st = craftStats(data, d.spec, techCtxFor(state));
  d.derived = compactDerived(st);
  refreshCraft(state, data, d);
  return st;
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------------------------------------------

function liveDesigns(state, owner) {
  return Object.values(state?.craftDesigns || {}).filter((d) => d && !d.retired && (!owner || d.owner === owner));
}

function capReached(state, data, owner) {
  return liveDesigns(state, owner).length >= num(craftPartsOf(data)?.rules?.maxLiveDesigns, 12);
}

function cleanName(s, fallback) {
  const t = String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return t || fallback;
}

function revisionName(name, n) {
  const base = String(name).replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)$/, '');
  return `${base} ${ROMAN[clamp(n + 1, 2, 12)]}`.slice(0, NAME_MAX);
}

function newDesign(state, data, fields) {
  const id = nextId(state, 'csg');
  const d = {
    id, name: fields.name, owner: fields.owner, role: fields.spec.role, origin: fields.origin || 'scratch',
    spec: normalizeSpec(fields.spec), createdTurn: state.turn, program: null, gap: null, qual: null, stats: { flights: 0, ok: 0, counted: [] },
  };
  if (fields.baseCraftId) { d.baseCraftId = fields.baseCraftId; d.baseCraftName = fields.baseCraftName || null; }
  if (fields.refSpec) d.refSpec = normalizeSpec(fields.refSpec);
  if (fields.parentId) { d.parentId = fields.parentId; d.revision = fields.revision || 2; }
  if (fields.targetId) d.targetId = String(fields.targetId);
  ensure(state)[id] = d;
  recompute(state, data, d);
  return d;
}

function missionsUsing(state, id) {
  return (state.missions || []).filter((m) => m && (m.spacecraftId === id || m.secondarySpacecraftId === id) && ['planning', 'scheduled', 'launch', 'transit', 'arrival', 'operations'].includes(m.status));
}

function playerOnly(state, action) {
  return action?.actorId && action.actorId !== state.playerId ? { ok: false, error: 'Só a sua agência usa o Estaleiro.' } : null;
}

/** Same scenario unlock as the Hangar (`unlocks.craftBuilder`, else `unlocks.builder`). */
function builderUnlocked(state, data) {
  const u = data?.scenario?.unlocks || {};
  const fy = (u.craftBuilder || u.builder)?.fromYear;
  if (!Number.isFinite(fy)) return { ok: true, fromYear: null };
  return { ok: yearNow(state) >= fy, fromYear: fy };
}

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init(state) {
  ensure(state);
}

function makeOperational(state, data, d) {
  d.program.phase = 'operational';
  d.program.operationalTurn = state.turn;
  d.gap = num(d.program.newness, 0.1);
  refreshCraft(state, data, d);
  addNews(state, {
    headline: `${d.name} pronta para voar`,
    body: 'A nova espaçonave da agência já aparece na escolha de nave das missões. A confiabilidade amadurece a cada voo.',
    importance: 2, tags: ['designs', 'craft'], actors: [d.owner], icon: 'rocket',
  });
  emitSignal(state, 'craft/operational', { designId: d.id, actorId: d.owner });
}

export function tick(state, data, ctx) {
  const all = state?.craftDesigns;
  if (!all || !craftPartsOf(data)) return;
  const M = craftPartsOf(data).rules?.dev?.maturity || {};
  // flights of operational designs mature the first-flight gap
  for (const sg of state.signals || []) {
    if (sg?.type !== 'mission/resolved' || !sg.missionId) continue;
    const m = (state.missions || []).find((x) => x?.id === sg.missionId);
    if (!m) continue;
    for (const id of [m.spacecraftId, m.secondarySpacecraftId]) {
      const d = id && all[id];
      if (!d || d.program?.phase !== 'operational') continue;
      d.stats = d.stats || { flights: 0, ok: 0, counted: [] };
      d.stats.counted = Array.isArray(d.stats.counted) ? d.stats.counted : [];
      const key = `${m.id}:${sg.phase || ''}`;
      const good = OK_LEVELS.has(sg.outcome);
      // the craft is judged where it works: a launch failure is the rocket's; the ascent leg of a longer mission is not the end
      if (d.stats.counted.includes(key) || (sg.phase === 'ascent' && (!good || sg.final === false))) continue;
      d.stats.counted.push(key);
      if (d.stats.counted.length > 12) d.stats.counted.shift();
      d.stats.flights = num(d.stats.flights, 0) + 1;
      if (good) d.stats.ok = num(d.stats.ok, 0) + 1;
      d.gap = r3(gapOf(d) * num(good ? M.success : M.failure, good ? 0.6 : 0.85));
      refreshCraft(state, data, d);
    }
  }
  for (const d of Object.values(all)) {
    const pr = d?.program;
    if (!pr || d.retired) continue;
    if (pr.phase === 'work') {
      const remaining = Math.max(0, num(pr.devCostM, 0) - num(pr.paidM, 0));
      const weeksLeft = Math.max(1, num(pr.readyTurn, state.turn) - ctx.prevTurn);
      const span = Math.min(ctx.dt, weeksLeft);
      const pay = remaining > 0 ? Math.min(remaining, (remaining / weeksLeft) * span) : 0;
      if (pay > 0.005) {
        if ((typeof budget.commit === 'function' ? budget.commit : budget.spend)(state, d.owner, pay, 'designs', `Desenvolvimento: ${d.name}`)) {
          pr.paidM = r2(num(pr.paidM, 0) + pay);
          if (pr.paused) pr.paused = false;
        } else {
          pr.readyTurn = num(pr.readyTurn, state.turn) + ctx.dt;
          if (!pr.paused) {
            pr.paused = true;
            addNews(state, { headline: `Falta caixa: desenvolvimento da ${d.name} parado`, importance: 2, tags: ['designs'], actors: [d.owner], icon: 'budget' });
          }
          continue;
        }
      }
      if (dueIn(ctx, pr.readyTurn) && num(pr.devCostM, 0) - num(pr.paidM, 0) <= 0.01) makeOperational(state, data, d);
    } else if (pr.phase === 'operational' && d.qual && dueIn(ctx, d.qual.untilTurn)) {
      const Q = craftPartsOf(data).rules?.dev?.qualification || {};
      d.gap = r3(gapOf(d) * num(Q.mult, 0.5));
      d.qual = { untilTurn: null, n: num(d.qual.n, 1) };
      refreshCraft(state, data, d);
      addNews(state, { headline: `${d.name} passa nos testes de qualificação`, body: 'Vibração, vácuo térmico e ensaios de sistemas aumentam a confiança no primeiro voo.', importance: 1, tags: ['designs', 'craft'], actors: [d.owner], icon: 'rocket' });
    }
  }
}

export function compact(state) {
  const all = state?.craftDesigns;
  if (!all) return;
  for (const [id, d] of Object.entries(all)) if (d?.retired && state.turn - num(d.retiredTurn, state.turn) > 20 * 52) delete all[id];
}

export function onActorGone(state, data, ctx, id, info = {}) {
  for (const d of Object.values(state?.craftDesigns || {})) {
    if (d?.owner !== id || !info?.into) continue;
    d.owner = info.into;
    if (d.asSpacecraft) d.asSpacecraft.operator = info.into;
  }
}

export const decisionHandlers = {};

/** Validation shared by new / save: research locks and stats. */
function checkSpec(state, data, spec) {
  const locked = lockedParts(state, data, spec);
  if (locked.length) return fail(`${locked[0].name}: ${locked[0].reason}.`, { locked, nodeId: locked[0].nodeId || null });
  const st = craftStats(data, spec, techCtxFor(state));
  if (!st.ok) return fail(st.errors[0], { errors: st.errors });
  return { ok: true, stats: st };
}

export const actions = {
  /**
   * New design: {role, destId?, fromCraftId?, spec?, name?}. From a role (auto-filled for a target), from a catalog
   * craft (its size, subtype and crew; development is cheaper while the design stays close) or from an explicit spec.
   */
  'craft/new': (state, data, action) => {
    ensure(state);
    const P = craftPartsOf(data);
    if (!P) return fail('Catálogo de peças do Estaleiro não carregado.');
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const un = builderUnlocked(state, data);
    if (!un.ok) return fail(`O Estaleiro abre em ${un.fromYear}.`);
    if (capReached(state, data, state.playerId)) return fail('Limite de projetos de naves atingido: aposente algum.');
    let spec = null;
    let origin = 'scratch';
    let base = null;
    if (action.fromCraftId) {
      const t = templateFromCraft(state, data, action.fromCraftId);
      if (!t) return fail('Essa nave não serve de modelo no Estaleiro.');
      spec = t.spec;
      origin = 'catalog';
      base = t.craft;
      action = { ...action, destId: action.destId || t.target };
    } else if (action.spec) {
      spec = normalizeSpec(action.spec);
    } else {
      const role = P.roles[action.role];
      if (!role) return fail('Escolha a função da nave.');
      const ra = roleAccess(state, data, role.id);
      if (!ra.ok) return fail(`${ra.reason}.`, { nodeId: ra.nodeId });
      spec = fillRole(state, data, role.id, action.destId || null, { crew: num(action.crew, 0), sub: action.sub || null, cargoT: num(action.cargoT, 0) });
      if (!spec) return fail(`Ainda não há estrutura disponível para ${role.label.toLowerCase()}.`);
    }
    const role = P.roles[spec.role];
    if (!role) return fail('Escolha a função da nave.');
    const ra = roleAccess(state, data, role.id);
    if (!ra.ok) return fail(`${ra.reason}.`, { nodeId: ra.nodeId });
    const me = state.actors?.[state.playerId] || {};
    const n = liveDesigns(state, state.playerId).length + 1;
    const d = newDesign(state, data, {
      name: cleanName(action.name, base ? `${base.name} (${me.short || 'projeto'})` : `${me.short || 'Projeto'} ${role.label} ${n}`),
      owner: state.playerId, spec, origin, baseCraftId: base?.id || null, baseCraftName: base?.name || null, refSpec: base ? spec : null, targetId: action.destId || P.roles[spec.role]?.target || null,
    });
    return { ok: true, designId: d.id };
  },

  /**
   * Save edits: {designId, draft: {name?, ...spec}}. Project: in place. Operational with new hardware: a revision
   * (new design "Nome II", cheaper development). In development: refused.
   */
  'craft/save': (state, data, action) => {
    ensure(state);
    if (!craftPartsOf(data)) return fail('Catálogo de peças do Estaleiro não carregado.');
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.craftDesigns[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return fail('Projeto não encontrado.');
    const draft = action.draft || {};
    const spec = normalizeSpec({ ...d.spec, ...draft, role: d.spec.role, parts: draft.parts ?? d.spec.parts });
    const name = cleanName(draft.name, d.name);
    if (d.program?.phase === 'work') return fail('Em desenvolvimento: edite quando estiver pronta (vira uma revisão).');
    const chk = checkSpec(state, data, spec);
    if (!chk.ok) return chk;
    if (d.program?.phase === 'operational') {
      if (sameHardware(spec, d.spec)) {
        d.name = name;
        d.spec = { ...d.spec, shape: spec.shape, finish: spec.finish, arrays: spec.arrays, antenna: spec.antenna };
        recompute(state, data, d);
        return { ok: true, designId: d.id };
      }
      if (capReached(state, data, d.owner)) return fail('Limite de projetos de naves atingido: aposente algum.');
      const rev = num(d.revision, 1) + 1;
      const nd = newDesign(state, data, { name: name !== d.name ? name : revisionName(d.name, rev - 1), owner: d.owner, spec, origin: 'revision', parentId: d.id, revision: rev, refSpec: d.spec, targetId: d.targetId });
      return { ok: true, designId: nd.id, revision: true };
    }
    d.name = name;
    d.spec = spec;
    recompute(state, data, d);
    return { ok: true, designId: d.id };
  },

  /** Start development: pays the upfront share, the rest week by week. */
  'craft/develop': (state, data, action) => {
    ensure(state);
    if (!craftPartsOf(data)) return fail('Catálogo de peças do Estaleiro não carregado.');
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.craftDesigns[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return fail('Projeto não encontrado.');
    if (d.program) return fail('Este projeto já está em desenvolvimento.');
    const chk = checkSpec(state, data, d.spec);
    if (!chk.ok) return chk;
    const st = recompute(state, data, d);
    if (st.missing.length) return fail(`Falta: ${st.missing[0]}.`, { missing: st.missing });
    if (!fitAll(state, data, st.cap).some((f) => f.ok)) return fail('Esta nave ainda não serve para nenhum destino: veja o quadro "Por que não serve".');
    const pc = programCosts(state, data, d, st);
    if (pc.upfrontM > 0 && !budget.spend(state, d.owner, pc.upfrontM, 'designs', `Desenvolvimento: ${d.name}`)) return fail(`Caixa insuficiente: a entrada é de ${pc.upfrontM} mi.`);
    d.program = { phase: 'work', startedTurn: state.turn, readyTurn: state.turn + Math.max(1, pc.devWeeks), devCostM: pc.devCostM, paidM: pc.upfrontM, paused: false, newness: pc.newness };
    refreshCraft(state, data, d);
    addNews(state, { headline: `${actorName(state, d.owner)} começa a desenvolver a ${d.name}`, importance: 1, tags: ['designs', 'craft'], actors: [d.owner], icon: 'rocket' });
    return { ok: true, designId: d.id, ...pc };
  },

  /** Stop a development program (no refund). */
  'craft/cancel': (state, data, action) => {
    ensure(state);
    const d = state.craftDesigns[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return fail('Projeto não encontrado.');
    if (d.program?.phase !== 'work') return fail('Não há desenvolvimento para cancelar.');
    d.program = null;
    refreshCraft(state, data, d);
    addNews(state, { headline: `Desenvolvimento da ${d.name} cancelado`, importance: 1, tags: ['designs', 'craft'], actors: [d.owner], icon: 'failure' });
    return { ok: true, designId: d.id };
  },

  /** Ground qualification tests of an operational design: costs a share of a unit, halves the first-flight gap. */
  'craft/qualify': (state, data, action) => {
    ensure(state);
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.craftDesigns[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return fail('Projeto não encontrado.');
    if (d.program?.phase !== 'operational') return fail('Os testes de qualificação são para naves prontas.');
    const Q = craftPartsOf(data)?.rules?.dev?.qualification || {};
    if (d.qual?.untilTurn != null) return fail('Os testes já estão em andamento.');
    if (num(d.qual?.n, 0) >= num(Q.max, 2)) return fail('Já foram feitos todos os testes de qualificação úteis.');
    if (gapOf(d) < 0.01) return fail('A confiabilidade já amadureceu: testes não acrescentam.');
    const cost = r1(num(d.derived?.costM, 10) * num(Q.costFrac, 0.4));
    if (!budget.spend(state, d.owner, cost, 'designs', `Qualificação: ${d.name}`)) return fail('Caixa insuficiente para os testes.');
    d.qual = { untilTurn: state.turn + Math.max(1, num(Q.weeks, 13)), n: num(d.qual?.n, 0) + 1 };
    return { ok: true, designId: d.id, costM: cost, untilTurn: d.qual.untilTurn };
  },

  /** Retire (delete) a design no live mission uses. */
  'craft/retire': (state, data, action) => {
    ensure(state);
    const d = state.craftDesigns[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return fail('Projeto não encontrado.');
    if (missionsUsing(state, d.id).length) return fail('Há missões usando esta nave.');
    if (!d.program || d.program.phase !== 'operational') {
      delete state.craftDesigns[d.id];
      return { ok: true, removed: true };
    }
    d.retired = true;
    d.retiredTurn = state.turn;
    refreshCraft(state, data, d);
    return { ok: true, retired: true };
  },
};

/** Short pt-BR status of a design. */
export function statusOf(d) {
  const pr = d?.program;
  if (d?.retired) return { id: 'retired', label: 'Aposentada' };
  if (!pr) return { id: 'project', label: 'Projeto' };
  if (pr.phase === 'work') return { id: 'work', label: pr.paused ? 'Parado (sem caixa)' : 'Em desenvolvimento' };
  if (d.qual?.untilTurn != null) return { id: 'tests', label: 'Em qualificação' };
  return { id: 'operational', label: 'Pronta para voar' };
}

function summary(state, data, d) {
  const st = craftStats(data, d.spec, techCtxFor(state));
  const fits = st.cap ? fitAll(state, data, st.cap) : [];
  return {
    id: d.id, name: d.name, role: d.spec.role, origin: d.origin, targetId: d.targetId || null, baseCraftId: d.baseCraftId || null, baseCraftName: d.baseCraftName || null,
    parentId: d.parentId || null, status: statusOf(d), spec: clone(d.spec), program: d.program ? { ...d.program } : null, qual: d.qual ? { ...d.qual } : null,
    gap: gapOf(d), stats: { flights: num(d.stats?.flights, 0), ok: num(d.stats?.ok, 0) }, derived: st, costs: d.program ? null : programCosts(state, data, d, st),
    reliability: craftReliability(state, data, d.id), asSpacecraft: d.asSpacecraft, fitCount: fits.filter((f) => f.ok).length,
    types: missionTypesOf(data, st, fits),
  };
}

export const queries = {
  /** Is the Estaleiro open (scenario unlocks) and is the parts catalog loaded? */
  'craft/unlocked': (state, data) => ({ ...builderUnlocked(state, data), loaded: !!craftPartsOf(data) }),
  /** Player designs (live), newest first. */
  'craft/list': (state, data) => liveDesigns(state, state.playerId).sort((a, b) => num(b.createdTurn, 0) - num(a.createdTurn, 0) || (a.id < b.id ? 1 : -1)).map((d) => summary(state, data, d)),
  'craft/get': (state, data, id) => (state.craftDesigns?.[id] ? summary(state, data, state.craftDesigns[id]) : null),
  /**
   * Pure preview of a draft spec (no time passes): {ok, ready, errors, missing, warnings, derived, costs, locked, fits,
   * types, target: fit at `destId`, revision}. `designId` = edit of a saved design.
   */
  'craft/preview': (state, data, draft = {}) => {
    const src = draft.designId ? state.craftDesigns?.[draft.designId] : null;
    const spec = normalizeSpec(draft.spec || draft);
    const st = craftStats(data, spec, techCtxFor(state));
    const fake = src
      ? (src.program?.phase === 'operational' && !sameHardware(spec, src.spec) ? { ...src, spec, parentId: src.id, refSpec: src.spec, program: null } : { ...src, spec })
      : { id: 'preview', owner: state.playerId, origin: 'scratch', spec };
    const costs = st.ok ? programCosts(state, data, fake, st) : null;
    const locked = lockedParts(state, data, spec);
    const fits = st.cap ? fitAll(state, data, st.cap) : [];
    const destId = draft.destId || null;
    const target = destId && st.cap ? { id: destId, name: destById(data, destId)?.name || destId, ...fitDest(data, st.cap, destId) } : null;
    return {
      ok: st.ok && !locked.length, ready: st.ready && !locked.length, errors: st.errors, missing: st.missing, warnings: st.warnings, derived: st, costs, locked,
      fits, fitCount: fits.filter((f) => f.ok).length, types: missionTypesOf(data, st, fits), target,
      revision: !!fake.parentId && fake !== src, firstFlightRel: st.ok && costs ? r3(clamp(st.inherent - costs.newness, 0, 1)) : null,
    };
  },
  /** Parts with lock state for the player and a role: [{part, ok, reason, nodeId}] (kind optional). */
  'craft/parts': (state, data, { kind = null, role = null } = {}) => (craftPartsOf(data)?.list || [])
    .filter((p) => (!kind || p.kind === kind) && (kind !== 'bus' || !role || (p.roles || []).includes(role)))
    .map((p) => ({ part: p, ...partAccess(state, data, p, state.playerId, { role: p.kind === 'bus' ? null : role }) })),
  /** Roles with lock state and the auto-filled first draft for each (target = role default or `destId`). */
  'craft/roles': (state, data, { destId = null } = {}) => (craftPartsOf(data)?.roleList || []).map((r) => {
    const a = roleAccess(state, data, r.id);
    const buses = a.ok ? usable(state, data, 'bus', r.id) : [];
    const reason = !a.ok ? a.reason : !buses.length ? 'Nenhuma estrutura disponível ainda' : null;
    const nextBus = !buses.length ? (craftPartsOf(data)?.list || []).filter((p) => p.kind === 'bus' && (p.roles || []).includes(r.id)).map((p) => ({ p, acc: partAccess(state, data, p) })).sort((x, y) => monthIndex(x.p.availableFrom) - monthIndex(y.p.availableFrom))[0] : null;
    return { id: r.id, label: r.label, desc: r.desc, kind: r.kind, target: destId || r.target, ok: a.ok && buses.length > 0, reason: reason || null, nodeId: a.nodeId || nextBus?.acc?.nodeId || null, nextBus: nextBus ? { name: nextBus.p.name, reason: nextBus.acc.reason } : null };
  }),
  /** Catalog craft the player can start from, with the role and target their template uses. */
  'craft/catalogTemplates': (state, data) => {
    let list = [];
    try { list = calendar.availableSpacecraft(state, data, state.playerId) || []; } catch { list = []; }
    const P = craftPartsOf(data);
    return list.filter((s) => !s.craftDesign && roleOfCraft(s) && P?.roles?.[roleOfCraft(s)] && !s.calendarOnly && itemAvailable(data, state, s, state.turn))
      .map((s) => ({ craftId: s.id, name: s.name, kind: s.kind, role: roleOfCraft(s), sub: s.sub || null, crew: num(s.crew, 0), massT: num(s.massT, 0), costM: num(s.costM, 0), generic: !!(s.generic || s.access === 'generic'), operator: s.operator || null, roleOk: roleAccess(state, data, roleOfCraft(s)).ok }));
  },
  /** Static tables for the editor (labels, shapes, finishes, groups, comms range labels). */
  'craft/catalogInfo': (state, data) => {
    const P = craftPartsOf(data);
    if (!P) return null;
    return { roles: P.roleList, groups: P.groups, shapes: P.shapes, finishes: P.finishes, placements: P.placements, commsLabels: P.rules.commsLabels || [], maxLive: num(P.rules.maxLiveDesigns, 12) };
  },
  'craft/reliability': (state, data, id) => craftReliability(state, data, id),
};

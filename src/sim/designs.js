// Rocket builder (Hangar): player launch-vehicle designs, the parts model and the development program.
// Contract: docs/EXPANSION.md §6. Slice: state.designs = { [id: 'dsg_<n>']: Design } (owner: this module).
//
// Design = { id, name, owner, baseVehicleId|null, origin: 'license'|'scratch', parentId?, revision?,
//   spec: { stages: [{engineId, engines, engineId2?, engines2?, tank, size, reuse?} | {moduleId}],
//           boosters: {id, count, reuse?}|null, fairingId, avionicsId, escapeId?, paint },
//   licensedParts: [partId],   // parts the license brought (usable even without own access)
//   derived: { capacity, capacityRaw, costM, reliabilityPrior, inherent, devCostM, devWeeks, heightM, diaM,
//              massT, liftoffTWR, geometry, year } (cache, recomputed on save),
//   program: null | { phase: 'work'|'testFlights'|'operational', startedTurn, readyTurn, devCostM, paidM,
//                     needFlights, testFlights, testOk, nextTestTurn, paused, gap, operationalTurn? },
//   stats: { flights, failures }, createdTurn, retired?, asVehicle }
// `asVehicle` is what src/core/catalog.js hands to the rest of the game (same shape as a vehicles.json entry,
// `retired: true` until the design is operational, so it never shows up in normal mission pickers before that).
//
// Pure parts: designStats(data, spec, techCtx) (Tsiolkovsky per stage with parallel boosters, TWR check,
// structural fractions by year), availability checks, template auto-fill. Deterministic: no Math.random, no Date,
// rng only through ctx.rng in tick (abstract test flights). The parts catalog lives in data/core/parts.json
// (data.parts); without it the module is inert and the Hangar says so.

import { nextId, addNews, emitSignal, clamp, relKey, dueIn, expiryIn, pushDecision } from '../core/helpers.js';
import { turnToDate, yearOf } from '../core/time.js';
import { vehicleDef as catalogVehicle, itemAvailable, monthIndex, researchGateOf } from '../core/catalog.js';
import * as budget from './budget.js';
import * as calendar from './calendar.js';
import * as research from './research.js';

export const meta = { maxDt: 52 };

const G0 = 9.80665;
const OK_LEVELS = new Set(['total', 'partial']);
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const NAME_MAX = 28;

// ---------------------------------------------------------------------------------------------------------------
// Data access (tolerant: everything returns something sensible when data.parts is missing)
// ---------------------------------------------------------------------------------------------------------------

const PCACHE = new WeakMap();

/** Indexed parts catalog of a data object, or null when data/core/parts.json is not loaded. */
export function partsOf(data) {
  const raw = data?.parts;
  if (!raw || !Array.isArray(raw.parts)) return null;
  let p = PCACHE.get(raw);
  if (p) return p;
  const byId = {};
  for (const x of raw.parts) if (x && x.id) byId[x.id] = x;
  const dia = {};
  for (const d of raw.tanks?.diameters || []) dia[d.id] = d;
  const designs = {};
  for (const [k, v] of Object.entries(raw.vehicleDesigns || {})) if (!k.startsWith('_') && v && typeof v === 'object') designs[k] = v;
  p = {
    raw, byId, dia, designs, list: raw.parts,
    tanks: raw.tanks || {}, rules: raw.rules || {}, reuse: raw.reuse || {}, dev: raw.dev || {},
    cost: raw.costModel || {}, tests: raw.testFlights || {}, deltaV: raw.deltaV || { leo: 9.4, gto: 11.8, tli: 12.5, mars: 13.1, outer: 15.5 },
    classes: raw.destClasses || [], templates: raw.templates || [], paints: raw.paints || [],
  };
  PCACHE.set(raw, p);
  return p;
}

export const CAP_KEYS = ['leo', 'gto', 'tli', 'mars', 'outer'];

/** Piecewise-linear curve [[year, value], ...] at `year`. */
export function curve(points, year, dflt = 0) {
  if (!Array.isArray(points) || !points.length) return dflt;
  if (year <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [y1, v1] = points[i];
    const [y0, v0] = points[i - 1];
    if (year <= y1) return v0 + ((v1 - v0) * (year - y0)) / Math.max(1e-9, y1 - y0);
  }
  return points[points.length - 1][1];
}

const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const r2 = (x) => Math.round(x * 100) / 100;
const r1 = (x) => Math.round(x * 10) / 10;

function ensure(state) {
  if (!state.designs || typeof state.designs !== 'object' || Array.isArray(state.designs)) state.designs = {};
  return state.designs;
}

/** Month count (year*12 + month0) of a turn of this game. */
function monthNow(state, turn = state?.turn ?? 0) {
  const d = turnToDate(turn, state?.startYear ?? 2026);
  return d.year * 12 + d.month;
}

/** Fractional calendar year of a turn (for curves). */
function yearNow(state, turn = state?.turn ?? 0) {
  return yearOf(state, turn);
}

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

// ---------------------------------------------------------------------------------------------------------------
// Spec normalization and stage expansion (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Clean copy of a spec with integer counts and only known fields (safe to store in state). */
export function normalizeSpec(spec = {}) {
  const stages = (Array.isArray(spec.stages) ? spec.stages : []).slice(0, 8).map((s) => {
    if (s?.moduleId) return { moduleId: String(s.moduleId) };
    const o = {
      engineId: s?.engineId ? String(s.engineId) : null,
      engines: Math.max(1, Math.round(num(s?.engines, 1))),
      tank: s?.tank ? String(s.tank) : null,
      size: Math.max(1, Math.round(num(s?.size, 1))),
    };
    if (s?.engineId2) { o.engineId2 = String(s.engineId2); o.engines2 = Math.max(1, Math.round(num(s.engines2, 1))); }
    if (s?.reuse) o.reuse = true;
    if (s?.balloon) o.balloon = true;
    return o;
  });
  const b = spec.boosters && spec.boosters.id && num(spec.boosters.count, 0) > 0
    ? { id: String(spec.boosters.id), count: Math.round(num(spec.boosters.count, 0)), ...(spec.boosters.reuse ? { reuse: true } : {}) }
    : null;
  const out = { stages, boosters: b, fairingId: spec.fairingId || null, avionicsId: spec.avionicsId || null, paint: spec.paint || 'white' };
  if (spec.escapeId) out.escapeId = spec.escapeId;
  return out;
}

/** Thrust-weighted (= mass-flow-weighted) Isp of an engine group. */
function groupIsp(groups, key) {
  let F = 0;
  let md = 0;
  for (const g of groups) {
    const isp = num(g.eng[key], 0);
    const T = g.n * num(g.eng.thrustKN, 0) * (key === 'ispSL' ? (num(g.eng.ispVac, 1) > 0 ? isp / num(g.eng.ispVac, 1) : 0) : 1);
    if (isp <= 0 || T <= 0) continue;
    F += T;
    md += T / isp;
  }
  return { thrust: F, isp: md > 0 ? F / md : 0 };
}

/** Engine-out-tolerant reliability of an engine group set. */
function enginesReliability(groups, rules) {
  let all = 1;
  let n = 0;
  for (const g of groups) { all *= num(g.eng.reliability, 0.95) ** g.n; n += g.n; }
  const eo = rules.engineOut || {};
  if (n >= num(eo.minEngines, 5)) {
    let extra = 0;
    for (const g of groups) {
      const r = num(g.eng.reliability, 0.95);
      extra += g.n * ((1 - r) / Math.max(1e-6, r)) * all;
    }
    all = Math.min(1, all + extra * num(eo.cover, 0.6));
  }
  return all;
}

function tankDims(P, tankId, size) {
  const t = P.tanks;
  const dia = P.dia[tankId];
  if (!dia) return null;
  const d = num(dia.d, 3);
  const steps = clamp(Math.round(num(size, 1)), 1, num(t.maxSteps, 32));
  const stepLen = Math.max(num(t.minStepM, 0.8), num(t.stepPerD, 0.5) * d);
  const vol = Math.PI * (d / 2) ** 2 * stepLen * steps * num(t.fill, 0.88);
  return { d, steps, stepLen, len: stepLen * steps, vol };
}

/** Structural fraction for a propellant at a year, with the player's structure techs. */
function structFrac(P, prop, year, techs) {
  const pr = P.tanks.props?.[prop] || P.tanks.props?.kerolox || {};
  let f = curve(pr.structFrac, year, 0.07);
  if (techs?.has?.('str_composites')) f *= 0.92;
  if (techs?.has?.('str_additive')) f *= 0.96;
  return f;
}

/**
 * Expand one stage spec into physical numbers. Returns {error} on invalid input.
 * stage: {kind:'built'|'module', name, prop, propT, usableT, dryT, engMassT, thrustVac, thrustSL, ispVac, ispSL,
 *         reliability, costParts: {engines, structure, module}, d, len, reuse, art}
 */
function expandStage(P, s, idx, nStages, ctx) {
  const rules = P.rules;
  const reuseCfg = P.reuse;
  if (s.moduleId) {
    const m = P.byId[s.moduleId];
    if (!m || m.kind !== 'upper') return { error: `Estágio ${idx + 1}: módulo desconhecido.` };
    if (idx === 0 && !m.firstStage) return { error: `${m.name} não serve de primeiro estágio.` };
    const ispVac = num(m.ispVac, 300);
    const ispSL = num(m.ispSL, 0);
    const thrustVac = num(m.thrustKN, 0);
    return {
      kind: 'module', name: m.name, prop: m.prop, propT: num(m.propT, 0), usableT: num(m.propT, 0), dryT: num(m.dryT, 0),
      engMassT: 0, thrustVac, thrustSL: ispSL > 0 ? (thrustVac * ispSL) / ispVac : 0, ispVac, ispSL,
      reliability: num(m.reliability, 0.97), costParts: { engines: 0, structure: 0, module: num(m.costM, 1) },
      d: num(m.d, 2), len: num(m.len, 4), reuse: false,
      art: { d: num(m.d, 2), len: num(m.len, 4), prop: m.prop, engines: { n: num(m.engines, 1), bellD: Math.min(num(m.d, 2) * 0.55, 2.4), bellLen: Math.min(num(m.len, 4) * 0.3, 3), chambers: 1 }, module: true },
    };
  }
  const eng = P.byId[s.engineId];
  if (!eng || eng.kind !== 'engine') return { error: `Estágio ${idx + 1}: escolha um motor.` };
  const groups = [{ eng, n: Math.max(1, Math.round(num(s.engines, 1))) }];
  if (s.engineId2) {
    const e2 = P.byId[s.engineId2];
    if (!e2 || e2.kind !== 'engine') return { error: `Estágio ${idx + 1}: segundo motor desconhecido.` };
    if (e2.prop !== eng.prop) return { error: `Estágio ${idx + 1}: os dois motores precisam usar o mesmo propelente.` };
    groups.push({ eng: e2, n: Math.max(1, Math.round(num(s.engines2, 1))) });
  }
  const tank = tankDims(P, s.tank, s.size);
  if (!tank) return { error: `Estágio ${idx + 1}: escolha o diâmetro do tanque.` };
  if (idx === 0 && groups.some((g) => g.eng.upperOnly)) return { error: `${groups.find((g) => g.eng.upperOnly).eng.name} é motor de vácuo: não serve no primeiro estágio.` };
  const nTot = groups.reduce((a, g) => a + g.n, 0);
  const maxE = num(rules.maxEnginesPerStage, 33);
  if (nTot > maxE) return { error: `Estágio ${idx + 1}: no máximo ${maxE} motores.` };
  const foot = groups.reduce((a, g) => a + g.n * num(g.eng.bellD, 1) ** 2, 0);
  const room = num(rules.engineFootprint, 0.75) * tank.d ** 2 + Math.max(...groups.map((g) => num(g.eng.bellD, 1) ** 2));
  if (foot > room * 1.0001) return { error: `Estágio ${idx + 1}: ${nTot} motores não cabem num tanque de ${fmtD(tank.d)}.` };
  const prop = eng.prop;
  const density = num(P.tanks.props?.[prop]?.densityT_m3, 1);
  const propT = tank.vol * density;
  const reuse = !!s.reuse;
  const reserve = reuse ? (idx === 0 ? num(reuseCfg.reservePropFrac, 0.1) : num(reuseCfg.upperReservePropFrac, 0.06)) : 0;
  const engMassT = groups.reduce((a, g) => a + g.n * num(g.eng.massT, 1), 0);
  const balloon = !!s.balloon && ctx.year >= num(P.tanks.balloon?.fromYear, 1957) && prop !== 'solid';
  let structT = propT * structFrac(P, prop, ctx.year, ctx.techs) * (balloon ? num(P.tanks.balloon?.structMult, 0.55) : 1);
  if (reuse) structT *= idx === 0 ? num(reuseCfg.dryMult, 1.06) : num(reuseCfg.upperDryMult, 1.15);
  const vac = groupIsp(groups, 'ispVac');
  const sl = groupIsp(groups, 'ispSL');
  const bell = groups[0].eng;
  return {
    kind: 'built', name: eng.name, prop, propT, usableT: propT * (1 - reserve), dryT: structT + engMassT, engMassT, structT,
    thrustVac: vac.thrust, thrustSL: sl.thrust, ispVac: vac.isp, ispSL: sl.isp,
    reliability: enginesReliability(groups, rules) * (balloon ? num(P.tanks.balloon?.reliabilityMult, 0.99) : 1),
    costParts: { engines: groups.reduce((a, g) => a + g.n * num(g.eng.costM, 1), 0), structure: structT, module: 0 },
    d: tank.d, len: tank.len + 1.2, reuse, balloon, steps: tank.steps, stepLen: tank.stepLen, nEngines: nTot,
    art: {
      d: tank.d, len: tank.len + 1.2, prop,
      engines: { n: nTot, bellD: num(bell.bellD, 1), bellLen: num(bell.bellLen, 1.5), chambers: num(bell.chambers, 1), vac: idx > 0 },
      reuse,
    },
  };
}

function expandBoosters(P, b, ctx) {
  if (!b || !b.id || !(b.count > 0)) return null;
  const part = P.byId[b.id];
  if (!part || part.kind !== 'booster') return { error: 'Propulsor lateral desconhecido.' };
  const counts = P.rules.boosterCounts || [0, 2, 4, 6];
  if (!counts.includes(b.count)) return { error: `Propulsores: use ${counts.filter((c) => c).join(', ')} unidades.` };
  let thrustVac;
  let ispVac;
  let ispSL;
  let rel = num(part.reliability, 0.99);
  let engCost = 0;
  if (part.engineId) {
    const e = P.byId[part.engineId];
    if (!e) return { error: `${part.name}: motor desconhecido.` };
    const n = num(part.engines, 1);
    thrustVac = n * num(e.thrustKN, 0);
    ispVac = num(e.ispVac, 300);
    ispSL = num(e.ispSL, 0);
    rel *= enginesReliability([{ eng: e, n }], P.rules);
    engCost = n * num(e.costM, 1);
  } else {
    thrustVac = num(part.thrustKN, 0);
    ispVac = num(part.ispVac, 260);
    ispSL = num(part.ispSL, 230);
  }
  const reuse = !!(b.reuse && part.reusable);
  const reserve = reuse ? num(P.reuse.reservePropFrac, 0.1) : 0;
  const dryT = num(part.dryT, 1) * (reuse ? num(P.reuse.dryMult, 1.06) : 1);
  return {
    part, count: b.count, propT: num(part.propT, 1), usableT: num(part.propT, 1) * (1 - reserve), dryT,
    thrustVac, ispVac, ispSL, thrustSL: ispSL > 0 ? (thrustVac * ispSL) / ispVac : 0,
    reliability: rel, cost: num(part.costM, 1) + engCost, reuse, d: num(part.d, 1.5), len: num(part.len, 15), prop: part.prop,
    art: { d: num(part.d, 1.5), len: num(part.len, 15), prop: part.prop, n: b.count, engines: part.engineId ? { n: num(part.engines, 1), bellD: num(P.byId[part.engineId]?.bellD, 1), bellLen: num(P.byId[part.engineId]?.bellLen, 1.5), chambers: num(P.byId[part.engineId]?.chambers, 1) } : { n: 1, bellD: num(part.d, 1.5) * 0.55, bellLen: num(part.d, 1.5) * 0.6, chambers: 1 } },
  };
}

const fmtD = (d) => `${String(Math.round(d * 100) / 100).replace('.', ',')} m`;

// ---------------------------------------------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------------------------------------------

/**
 * Ideal Δv (km/s) of the stack with payload P (t). Stage 1 burns in parallel with the boosters; the fairing and
 * the escape tower drop at stage-1 burnout (a 'kept' fairing rides to orbit); avionics sit on the top stage.
 */
function deltaV(model, P) {
  const { st, bo, fairT, keptT, escT, avT, mix, upperLoss } = model;
  const n = st.length;
  const above = new Array(n).fill(0);
  let acc = P + keptT + avT;
  for (let i = n - 1; i >= 0; i--) { above[i] = acc; acc += st[i].propT + st[i].dryT; }
  let dv = 0;
  const twr = [];
  // stage 1 (+ boosters)
  const s0 = st[0];
  const m0 = above[0] + s0.propT + s0.dryT + fairT + escT + (bo ? bo.count * (bo.propT + bo.dryT) : 0);
  const mdc = s0.ispVac > 0 ? s0.thrustVac / (G0 * s0.ispVac) : 0; // t/s
  const ispC = (k) => s0.ispSL > 0 ? s0.ispSL * k + s0.ispVac * (1 - k) : s0.ispVac;
  if (bo) {
    const mdb = bo.ispVac > 0 ? (bo.count * bo.thrustVac) / (G0 * bo.ispVac) : 0;
    const tb = mdb > 0 ? (bo.count * bo.usableT) / mdb : 0;
    const coreUsed = Math.min(s0.usableT, mdc * tb);
    const ispB = bo.ispSL > 0 ? bo.ispSL * mix.withBoosters + bo.ispVac * (1 - mix.withBoosters) : bo.ispVac;
    const ispA = (mdb * ispB + mdc * ispC(mix.withBoosters)) / Math.max(1e-9, mdb + mdc);
    const m1 = m0 - bo.count * bo.usableT - coreUsed;
    dv += G0 * ispA * Math.log(m0 / m1);
    const m2 = m1 - bo.count * (bo.dryT + (bo.propT - bo.usableT)) - escT; // the escape tower goes with the boosters
    const rest = s0.usableT - coreUsed;
    if (rest > 1e-6) dv += G0 * ispC(mix.coreAfter) * Math.log(m2 / (m2 - rest));
  } else {
    const m1 = m0 - s0.usableT;
    dv += G0 * ispC(mix.first) * Math.log(m0 / m1);
  }
  twr.push(null);
  for (let i = 1; i < n; i++) {
    const s = st[i];
    const a = above[i] + s.propT + s.dryT;
    const b = a - s.usableT;
    const t = s.thrustVac / (G0 * a);
    twr.push(t);
    const loss = clamp(upperLoss.base + upperLoss.k * t, upperLoss.min, 1);
    const x = G0 * s.ispVac * Math.log(a / b) * loss;
    // a weak stage still short of orbital speed fights gravity for minutes: the share of its Δv spent below
    // the suborbital mark only counts in proportion to its TWR (a kick stage already in orbit is not penalized)
    const below = clamp(upperLoss.subV - dv, 0, x);
    const low = clamp(t / upperLoss.fullTwr, upperLoss.lowMin, 1);
    dv += x - below + below * low;
  }
  return { dv: dv / 1000, m0, twr };
}

/** Largest payload (t) with Δv ≥ target, bounded by maxP. */
function solvePayload(model, target, maxP) {
  if (!(maxP > 0)) return 0;
  if (deltaV(model, 0).dv < target) return 0;
  if (deltaV(model, maxP).dv >= target) return maxP;
  let lo = 0;
  let hi = maxP;
  for (let i = 0; i < 40 && hi - lo > 0.002; i++) {
    const mid = (lo + hi) / 2;
    if (deltaV(model, mid).dv >= target) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Pure stats of a spec. techCtx = { year, techs?: Set|string[] }.
 * Returns { ok, errors[], warnings[], capacity{leo..outer} (raw × spec.calib), costM, costExpendableM, inherent,
 *           scratchDevCostM, scratchDevWeeks, massT, liftoffTWR, heightM, diaM, stages[], geometry }.
 */
export function designStats(data, spec, techCtx = {}) {
  const P = partsOf(data);
  const errors = [];
  const warnings = [];
  const empty = { ok: false, errors, warnings, capacity: Object.fromEntries(CAP_KEYS.map((k) => [k, 0])), costM: 0, costExpendableM: 0, inherent: 0, scratchDevCostM: 0, scratchDevWeeks: 0, massT: 0, liftoffTWR: 0, heightM: 0, diaM: 0, stages: [], geometry: null };
  if (!P) { errors.push('Catálogo de peças não carregado.'); return empty; }
  const sp = normalizeSpec(spec || {});
  const year = num(techCtx.year, 2026);
  const techs = techCtx.techs instanceof Set ? techCtx.techs : new Set(techCtx.techs || []);
  const ctx = { year, techs };
  const rules = P.rules;
  if (!sp.stages.length) { errors.push('Adicione pelo menos um estágio.'); return empty; }
  if (sp.stages.length > num(rules.maxStages, 4)) { errors.push(`No máximo ${num(rules.maxStages, 4)} estágios.`); return empty; }
  const st = [];
  sp.stages.forEach((s, i) => {
    const e = expandStage(P, s, i, sp.stages.length, ctx);
    if (e.error) errors.push(e.error); else st.push(e);
  });
  const bo = expandBoosters(P, sp.boosters, ctx);
  if (bo?.error) errors.push(bo.error);
  if (sp.stages.some((s, i) => s.reuse && i > 1)) errors.push('Só o 1º e o 2º estágios podem ser reutilizáveis.');
  if (sp.stages[0]?.reuse && year < num(P.reuse.firstFromYear, 2015)) errors.push(`Pouso de estágios só a partir de ${num(P.reuse.firstFromYear, 2015)}.`);
  if (sp.stages[1]?.reuse && year < num(P.reuse.upperFromYear, 2026)) errors.push(`Estágio superior reutilizável só a partir de ${num(P.reuse.upperFromYear, 2026)}.`);
  if (sp.boosters?.reuse && !(P.byId[sp.boosters.id]?.reusable)) errors.push('Esses propulsores não são recuperáveis.');
  if (sp.stages.some((s) => s.balloon) && year < num(P.tanks.balloon?.fromYear, 1957)) errors.push(`Tanque-balão só a partir de ${num(P.tanks.balloon?.fromYear, 1957)}.`);
  const fair = sp.fairingId ? P.byId[sp.fairingId] : null;
  if (sp.fairingId && (!fair || fair.kind !== 'fairing')) errors.push('Coifa desconhecida.');
  const av = sp.avionicsId ? P.byId[sp.avionicsId] : null;
  if (!av || av.kind !== 'avionics') errors.push('Escolha a aviônica.');
  const esc = sp.escapeId ? P.byId[sp.escapeId] : null;
  if (sp.escapeId && (!esc || esc.kind !== 'escape')) errors.push('Sistema de escape desconhecido.');
  if (errors.length) return { ...empty, errors };

  const fairT = fair && !fair.kept ? num(fair.massT, 1) : 0;
  const keptT = fair && fair.kept ? num(fair.massT, 1) : 0;
  const escT = esc ? num(esc.massT, 0) : 0;
  const avT = num(av.massT, 0.3);
  const mix = { first: num(rules.ispMixFirst, 0.5), withBoosters: num(rules.ispMixWithBoosters, 0.6), coreAfter: num(rules.ispMixCoreAfterBoosters, 0.2) };
  const ul = rules.upperTwrLoss || {};
  const model = { st, bo: bo && !bo.error ? bo : null, fairT, keptT, escT, avT, mix, upperLoss: {
    base: num(ul.base, 0.88), k: num(ul.k, 0.3), min: num(ul.min, 0.85),
    subV: num(P.deltaV?.leo, 9.4) * 1000 * num(ul.suborbitalFrac, 0.7), fullTwr: num(ul.fullTwr, 0.2), lowMin: num(ul.lowMin, 0.2),
  } };

  // liftoff TWR
  const thrustSL = st[0].thrustSL + (model.bo ? model.bo.count * model.bo.thrustSL : 0);
  if (thrustSL <= 0) errors.push('O primeiro estágio não acende no nível do mar.');
  const m0empty = deltaV(model, 0).m0;
  const minTWR = num(rules.minTWR, 1.2);
  const twr0 = thrustSL / (G0 * m0empty);
  if (twr0 < minTWR) errors.push(`Não decola: empuxo ${fmtPct1(twr0)} do peso (mínimo ${String(minTWR).replace('.', ',')}×). Use mais motores ou menos tanque.`);
  if (errors.length) return { ...empty, errors };
  const maxP = thrustSL / (G0 * minTWR) - m0empty;

  const calib = num(spec?.calib, 1);
  const capacityRaw = {};
  const capacity = {};
  for (const k of CAP_KEYS) {
    const raw = solvePayload(model, num(P.deltaV[k], 10), maxP);
    capacityRaw[k] = r2(raw);
    const c = raw * calib;
    capacity[k] = c >= 0.02 ? r2(c) : 0;
  }
  // suborbital hop (above 100 km and back): its own payload figure, read by calendar.capacityTo via capacity[destinationId]
  const subRaw = solvePayload(model, num(P.deltaV.suborbital, 2.4), maxP) * calib;
  capacity.suborbital = subRaw >= 0.02 ? r2(subRaw) : 0;
  if (capacity.leo <= 0 && capacity.suborbital > 0) warnings.push(`Só voo suborbital: sobe acima dos 100 km com até ${String(capacity.suborbital).replace('.', ',')} t, mas não chega à órbita.`);
  else if (capacity.leo <= 0) warnings.push('Não chega ao espaço: falta Δv. Aumente os tanques ou some um estágio.');
  const twrUp = deltaV(model, capacity.leo / Math.max(1e-6, calib)).twr;
  twrUp.forEach((t, i) => { if (t != null && t < 0.3) warnings.push(`Estágio ${i + 1} fraco (empuxo ${fmtPct1(t)} do peso): perde eficiência.`); });
  if (thrustSL / (G0 * (m0empty + capacity.leo)) > 2.6) warnings.push('Empuxo de sobra na decolagem: dá para pôr mais tanque.');

  // reliability
  let rel = 1;
  const structRel = curve(rules.structuralReliability, year, 0.99);
  for (const s of st) rel *= s.reliability * structRel;
  if (model.bo) rel *= (model.bo.reliability * structRel) ** model.bo.count;
  if (fair) rel *= num(fair.reliability, 0.995);
  rel *= num(av.reliability, 0.99);
  const inherent = clamp(rel, 0.3, 0.999);

  // cost per flight
  const costDryT = curve(P.tanks.costPerDryT, year, 0.5);
  const reuseCfg = P.reuse;
  let flight = 0;
  let expendable = 0;
  st.forEach((s) => {
    const c = s.costParts.engines + s.costParts.structure * costDryT + s.costParts.module + s.propT * num(P.cost.propCostPerT, 0.0004);
    expendable += c;
    flight += s.reuse ? c * num(reuseCfg.refurbFrac, 0.3) + num(reuseCfg.opsCostM, 1.5) : c;
  });
  if (model.bo) {
    const c = model.bo.count * model.bo.cost;
    expendable += c;
    flight += model.bo.reuse ? c * num(reuseCfg.refurbFrac, 0.3) + num(reuseCfg.opsCostM, 1.5) : c;
  }
  const extras = (fair ? num(fair.costM, 1) : 0) + num(av.costM, 1) + (esc ? num(esc.costM, 1) : 0);
  const im = num(P.cost.integrationMult, 1.15);
  const ops = curve(P.cost.launchOpsM, year, 2);
  const costM = r1((flight + extras) * im + ops);
  const costExpendableM = r1((expendable + extras) * im + ops);

  // development (from scratch; programs scale it)
  const dev = P.dev;
  const cx = dev.complexity || {};
  const anyReuse = st.some((s) => s.reuse) || !!model.bo?.reuse;
  const nuclear = st.some((s) => s.prop === 'nuclear' || s.prop === 'fusion');
  const complexity = 1 + num(cx.perExtraStage, 0.15) * (st.length - 1) + (model.bo ? num(cx.boosters, 0.1) : 0)
    + (st[0].reuse ? num(cx.reuse, 0.3) : 0) + (st[1]?.reuse ? num(cx.upperReuse, 0.3) : 0) + (nuclear ? num(cx.nuclear, 0.6) : 0);
  const scratchDevCostM = Math.round(Math.max(num(dev.minCostM, 30), num(dev.devK, 9) * costExpendableM * complexity));
  const massT = m0empty;
  const weeks = (num(dev.baseWeeks, 78) + num(dev.perStageWeeks, 26) * st.length + num(dev.massWeeks, 12) * Math.log2(1 + massT / 100)
    + (model.bo ? num(dev.boosterWeeks, 13) : 0) + (anyReuse ? num(dev.reuseWeeks, 26) : 0)) * curve(dev.eraWeeksMult, year, 1);
  const scratchDevWeeks = Math.round(weeks);

  // geometry for the painter (src/ui/launch-render/vehicles.js design adapter)
  const heightM = r1(st.reduce((a, s) => a + s.len, 0) + (fair ? num(fair.len, 5) : 0) + (esc && escT > 0 ? 6 : 0) + 1.5);
  const coreD = Math.max(...st.map((s) => s.d));
  const diaM = r2(model.bo ? coreD + 2 * model.bo.d : coreD);
  const geometry = {
    stages: st.map((s) => s.art),
    boosters: model.bo ? { ...model.bo.art, reuse: model.bo.reuse } : null,
    fairing: fair ? { d: num(fair.d, 3), len: num(fair.len, 5), kept: !!fair.kept } : null,
    escape: !!esc && escT > 0,
    paint: sp.paint || 'white',
  };

  return {
    ok: true, errors, warnings, capacity, capacityRaw, costM, costExpendableM, inherent, scratchDevCostM, scratchDevWeeks,
    massT: r1(massT), liftoffTWR: r2(twr0), heightM, diaM, geometry,
    stages: st.map((s, i) => ({ name: s.name, prop: s.prop, propT: r1(s.propT), dryT: r1(s.dryT), thrustKN: Math.round(i === 0 ? s.thrustSL : s.thrustVac), isp: Math.round(i === 0 ? (s.ispSL + s.ispVac) / 2 : s.ispVac), d: s.d, len: r1(s.len), reuse: s.reuse, twr: i === 0 ? r2(twr0) : (twrUp[i] != null ? r2(twrUp[i]) : null) })),
    boosters: model.bo ? { name: model.bo.part.name, count: model.bo.count, propT: r1(model.bo.propT), thrustKN: Math.round(model.bo.thrustSL) } : null,
    crewReady: !!esc,
  };
}

const fmtPct1 = (x) => `${String(Math.round(x * 100) / 100).replace('.', ',')}×`;

// ---------------------------------------------------------------------------------------------------------------
// Availability (player access to parts and catalog vehicles)
// ---------------------------------------------------------------------------------------------------------------

/** Techs of an actor as a Set (player: research.unlocked; rivals: research.rivals[id]). */
function techSet(state, actorId) {
  const ids = actorId === state?.playerId ? state?.research?.unlocked : state?.research?.rivals?.[actorId];
  return new Set(Array.isArray(ids) ? ids : []);
}

/** techCtx of an actor now. */
export function techCtxFor(state, actorId = state?.playerId, turn = state?.turn) {
  return { year: yearNow(state, turn), techs: techSet(state, actorId) };
}

/**
 * Can `actorId` use a part now? → {ok, reason}. Dates (availableFrom/Until), research (`tech`, only when that node
 * exists in data) and access/embargo/tension rules (calendar.accessFor) for parts with an operator.
 */
export function partAccess(state, data, part, actorId = state?.playerId, turn = state?.turn, { licensed = [] } = {}) {
  if (!part) return { ok: false, reason: 'Peça desconhecida' };
  const now = monthNow(state, turn);
  if (monthIndex(part.availableFrom) > now) return { ok: false, reason: `Disponível em ${part.availableFrom.year}` };
  // a license keeps its production line open after the part leaves the market
  if (part.availableUntil && monthIndex(part.availableUntil) < now && !licensed.includes(part.id)) return { ok: false, reason: 'Fora de produção' };
  if (part.tech && (data?.index?.tech?.[part.tech] || (data?.tech?.nodes || []).some((n) => n.id === part.tech))) {
    if (!research.hasTech(state, actorId, part.tech)) {
      const node = data?.index?.tech?.[part.tech] || (data?.tech?.nodes || []).find((n) => n.id === part.tech);
      return { ok: false, reason: `Pesquise ${node?.name || part.tech}` };
    }
  }
  if (licensed.includes(part.id)) return { ok: true, reason: null };
  // MISSIONS-V2 §5.3: the gated player needs the part's unlock keys (data.techtree.gates.part, or `gate`)
  const g = researchGateOf(data, state, 'part', part, actorId);
  if (!g.ok) return { ok: false, reason: g.reason, nodeId: g.nodeId };
  if (part.access && part.access !== 'generic' && part.operator) {
    const a = calendar.accessFor(state, data, actorId, part);
    if (!a.ok) return { ok: false, reason: a.reason || 'Sem acesso' };
  }
  return { ok: true, reason: null };
}

/** Diameter tooling available now? */
function diameterOk(state, dia, turn) {
  return monthIndex(dia?.availableFrom) <= monthNow(state, turn);
}

/** Every part a spec uses (ids), including booster engines. */
export function specPartIds(spec) {
  const ids = new Set();
  for (const s of spec?.stages || []) {
    if (s.moduleId) ids.add(s.moduleId);
    if (s.engineId) ids.add(s.engineId);
    if (s.engineId2) ids.add(s.engineId2);
  }
  if (spec?.boosters?.id) ids.add(spec.boosters.id);
  for (const k of ['fairingId', 'avionicsId', 'escapeId']) if (spec?.[k]) ids.add(spec[k]);
  return [...ids];
}

/** Locked parts in a spec for an actor → [{id, name, reason}]. Licensed parts are always allowed. */
export function lockedParts(state, data, spec, actorId = state?.playerId, licensed = []) {
  const P = partsOf(data);
  if (!P) return [];
  const out = [];
  for (const id of specPartIds(spec)) {
    const a = partAccess(state, data, P.byId[id], actorId, state?.turn, { licensed });
    if (!a.ok) out.push({ id, name: P.byId[id]?.name || id, reason: a.reason, nodeId: a.nodeId || null });
  }
  for (const s of spec?.stages || []) {
    if (s.tank && !licensed.includes(s.tank) && P.dia[s.tank] && !diameterOk(state, P.dia[s.tank])) out.push({ id: s.tank, name: `Tanque de ${fmtD(P.dia[s.tank].d)}`, reason: `Disponível em ${P.dia[s.tank].availableFrom.year}` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Catalog vehicles: decomposition, licensing
// ---------------------------------------------------------------------------------------------------------------

/** Parts decomposition of a catalog vehicle (vehicle.design wins over parts.json vehicleDesigns). */
export function catalogDesign(data, vehicleId) {
  const v = catalogVehicle(data, vehicleId);
  if (v?.design && Array.isArray(v.design.stages)) return v.design;
  return partsOf(data)?.designs?.[vehicleId] || null;
}

const yearOfDate = (d, dflt) => (d && Number.isFinite(d.year) ? d.year : dflt);

/** Model numbers of a catalog vehicle's decomposition, at its debut year (or `year`). */
export function catalogStats(data, vehicleId, year) {
  const spec = catalogDesign(data, vehicleId);
  if (!spec) return null;
  const v = catalogVehicle(data, vehicleId);
  return designStats(data, spec, { year: year ?? yearOfDate(v?.availableFrom, 2026) });
}

function relationTrust(state, a, b) {
  return num(state?.relations?.[relKey(a, b)]?.trust, 50);
}
function tensionWith(state, a, b) {
  return num(state?.tension?.[relKey(a, b)], 0);
}
function actorName(state, id) {
  const a = state?.actors?.[id] || state?.lifecycle?.tombstones?.[id];
  return a?.short || a?.name || id;
}

/**
 * Can the player license a catalog vehicle now? → {ok, reason, feeM, vehicle}. Same access/embargo rules as buying a
 * launch; tension ≤ dev.license.maxTension with the operator; the vehicle must be in service and decomposable.
 */
export function licenseQuote(state, data, vehicleId, actorId = state?.playerId) {
  const P = partsOf(data);
  const v = catalogVehicle(data, vehicleId);
  if (!P || !v) return { ok: false, reason: 'Foguete desconhecido', feeM: 0, vehicle: v };
  if (!catalogDesign(data, vehicleId)) return { ok: false, reason: 'Sem projeto detalhado disponível', feeM: 0, vehicle: v };
  if (!itemAvailable(data, state, v, state.turn)) return { ok: false, reason: 'Fora de serviço nesta data', feeM: 0, vehicle: v };
  // the gated player needs the vehicle's unlock keys to build it under license (MISSIONS-V2 §5.3)
  const g = researchGateOf(data, state, 'vehicle', v, actorId, { fmt: (name) => `Pesquise ${name} para licenciar` });
  if (!g.ok) return { ok: false, reason: g.reason, nodeId: g.nodeId, feeM: 0, vehicle: v };
  const lic = P.dev.license || {};
  const own = v.operator && (v.operator === actorId || state?.lifecycle?.aliases?.[v.operator] === actorId);
  if (!own) {
    const acc = calendar.accessFor(state, data, actorId, v);
    if (!acc.ok) return { ok: false, reason: acc.reason || 'Sem acesso', feeM: 0, vehicle: v };
    if (v.operator && tensionWith(state, actorId, v.operator) > num(lic.maxTension, 2)) {
      return { ok: false, reason: `Tensão alta demais com ${actorName(state, v.operator)}`, feeM: 0, vehicle: v };
    }
  }
  const trust = v.operator ? relationTrust(state, actorId, v.operator) : 50;
  const relFactor = clamp(1.3 - trust / 250, 0.9, 1.3);
  const feeM = own ? num(lic.ownFee, 0) : Math.round(num(v.costM, 50) * num(lic.feeMult, 5) * relFactor);
  return { ok: true, reason: null, feeM, vehicle: v, own };
}

// ---------------------------------------------------------------------------------------------------------------
// Derived numbers of a design (with the license calibration) and program costs
// ---------------------------------------------------------------------------------------------------------------

/**
 * Slots that differ between two specs / slots used by either (0 = identical, 1 = nothing in common).
 * A slot empty in both specs (no 2nd engine, no reuse, no balloon...) does not count: otherwise the always-empty
 * slots would dilute a total redesign into a small "change".
 */
export function changeFraction(a, b) {
  if (!a || !b) return 1;
  const A = normalizeSpec(a);
  const B = normalizeSpec(b);
  const blank = (v) => v == null || v === false;
  let total = 0;
  let diff = 0;
  const slot = (x, y) => {
    if (blank(x) && blank(y)) return;
    total++;
    if ((x ?? null) !== (y ?? null)) diff++;
  };
  const n = Math.max(A.stages.length, B.stages.length);
  for (let i = 0; i < n; i++) {
    const x = A.stages[i] || {};
    const y = B.stages[i] || {};
    for (const k of ['moduleId', 'engineId', 'engines', 'engineId2', 'engines2', 'tank', 'size', 'reuse', 'balloon']) slot(x[k], y[k]);
  }
  for (const k of ['fairingId', 'avionicsId', 'escapeId']) slot(A[k], B[k]);
  if (A.boosters || B.boosters) {
    slot(A.boosters?.id, B.boosters?.id);
    slot(A.boosters ? `${A.boosters.count}${A.boosters.reuse ? 'r' : ''}` : null, B.boosters ? `${B.boosters.count}${B.boosters.reuse ? 'r' : ''}` : null);
  }
  return total ? diff / total : 0;
}

/**
 * How much of the licensed vehicle is left in a spec (1 = same hardware, 0 = a different rocket). The license
 * calibration, the inherited flight history and the cheap adaptation fade with it, so a license is not a shortcut
 * to a rocket built from scratch (parts.json dev.license.fullChange: change at which nothing is left).
 */
export function licenseKinship(data, d, spec = d?.spec) {
  if (!d?.baseVehicleId) return 0;
  const base = catalogDesign(data, d.baseVehicleId);
  if (!base) return 0;
  const full = Math.max(0.05, num(partsOf(data)?.dev?.license?.fullChange, 0.5));
  return r2(clamp(1 - changeFraction(spec, base) / full, 0, 1));
}

const kinshipOf = (d) => (d?.baseVehicleId ? num(d.derived?.kinship, 1) : 0);

/** Same hardware as the reference (paint and name do not count). */
export function sameHardware(a, b) {
  return changeFraction(a, b) === 0;
}

/** The spec a design is compared with (license: base vehicle; revision: parent; scratch: none). */
function referenceSpec(state, data, d) {
  if (d.refSpec) return d.refSpec;
  if (d.baseVehicleId) return catalogDesign(data, d.baseVehicleId);
  return null;
}

/**
 * Game numbers of a design spec for an owner: physics, then (license lineage) per-key calibration to the base
 * vehicle's catalog numbers so an unmodified license flies exactly like the original.
 */
export function deriveDesign(state, data, d, spec = d.spec, actorId = d.owner ?? state?.playerId) {
  const tc = techCtxFor(state, actorId);
  const s = designStats(data, spec, tc);
  if (!s.ok) return { ...s, reliabilityPrior: 0 };
  const capacity = { ...s.capacity };
  let costM = s.costM;
  let inherent = s.inherent;
  let ratioInfo = null;
  const baseId = d.baseVehicleId;
  const kinship = licenseKinship(data, d, spec);
  const bend = (ratio) => 1 + (ratio - 1) * kinship; // calibration fades as the hardware stops being the base's
  if (baseId && kinship > 0) {
    const v = catalogVehicle(data, baseId);
    const bs = designStats(data, { ...catalogDesign(data, baseId), calib: 1 }, tc);
    if (v && bs.ok) {
      const leoRatio = bs.capacity.leo > 0 && num(v.capacity?.leo, 0) > 0 ? clamp(v.capacity.leo / bs.capacity.leo, 0.25, 3) : 1;
      for (const k of CAP_KEYS) {
        const cat = num(v.capacity?.[k], 0);
        const ratio = bend(cat > 0 && bs.capacity[k] > 0 ? clamp(cat / bs.capacity[k], 0.25, 3) : leoRatio);
        const c = s.capacity[k] * ratio;
        capacity[k] = c >= 0.02 ? r2(c) : 0;
      }
      const cr = bend(bs.costM > 0 ? clamp(num(v.costM, bs.costM) / bs.costM, 0.3, 4) : 1);
      costM = r1(s.costM * cr);
      inherent = clamp(s.inherent * bend(relMean(state, data, baseId) / Math.max(0.3, bs.inherent)), 0.3, 0.999);
      ratioInfo = { leoRatio, costRatio: cr };
    }
  }
  // per-key calibration may bend the order: farther targets never carry more than nearer ones
  for (let i = 1; i < CAP_KEYS.length; i++) capacity[CAP_KEYS[i]] = Math.min(capacity[CAP_KEYS[i]], capacity[CAP_KEYS[i - 1]]);
  // the license reproduces the base vehicle's numbers only while the hardware is the same
  const ref = referenceSpec(state, data, d);
  const unmodified = !!(d.origin === 'license' && !d.parentId && ref && sameHardware(spec, ref));
  return { ...s, capacity, costM, inherent, ratioInfo, unmodified, kinship };
}

/** Mean reliability of a catalog vehicle with its flight history (calendar's Beta). */
function relMean(state, data, vehicleId) {
  try {
    const r = calendar.vehicleReliability(state, data, vehicleId);
    if (r && Number.isFinite(r.mean)) return r.mean;
  } catch { /* fall through */ }
  return 0.9;
}

/** Program numbers of a design right now: {devCostM, devWeeks, needFlights, upfrontM, newness, change}. */
export function programCosts(state, data, d, derived = d.derived) {
  const P = partsOf(data);
  const dev = P?.dev || {};
  const tf = P?.tests || {};
  if (!derived?.ok) return { devCostM: 0, devWeeks: 0, needFlights: 0, upfrontM: 0, newness: 0, change: 0 };
  const ref = referenceSpec(state, data, d);
  const change = ref ? changeFraction(d.spec, ref) : 1;
  const scratchCost = derived.scratchDevCostM;
  const scratchWeeks = derived.scratchDevWeeks;
  const nw = dev.newness || {};
  let devCostM;
  let devWeeks;
  let needFlights;
  let newness;
  if (d.parentId) {
    const rv = dev.revision || {};
    const f = Math.max(num(rv.minChange, 0.3), change);
    devCostM = scratchCost * num(rv.costFrac, 0.3) * f;
    devWeeks = Math.max(13, scratchWeeks * num(rv.weeksFrac, 0.4) * f);
    needFlights = num(tf.revision, 1);
    newness = num(nw.revision, 0.04);
  } else if (d.origin === 'license') {
    const lic = dev.license || {};
    if (derived.unmodified) {
      devCostM = scratchCost * num(lic.unmodifiedCostFrac, 0.05);
      devWeeks = num(lic.unmodifiedWeeks, 26);
      needFlights = num(tf.unmodified, 0);
      newness = num(nw.unmodified, 0);
    } else {
      const f = Math.max(num(dev.revision?.minChange, 0.3), change);
      // the farther from the base vehicle, the closer to a scratch program (at kinship 0 it is one)
      const kin = derived.kinship ?? licenseKinship(data, d);
      const away = 1 - kin;
      const complex = (d.spec?.stages?.length || 0) >= 3 || !!d.spec?.escapeId;
      devCostM = scratchCost * Math.max(num(lic.adaptCostFrac, 0.15) * f, away);
      devWeeks = Math.max(num(lic.minWeeks, 26), scratchWeeks * 0.35 * f, scratchWeeks * away);
      needFlights = kin <= 0 ? num(complex ? tf.scratchComplex : tf.scratch, 2) : num(tf.license, 1);
      newness = num(nw.license, 0.02) + (num(nw.scratch, 0.12) - num(nw.license, 0.02)) * away;
    }
  } else {
    devCostM = scratchCost;
    devWeeks = scratchWeeks;
    const complex = (d.spec?.stages?.length || 0) >= 3 || !!d.spec?.escapeId;
    needFlights = num(complex ? tf.scratchComplex : tf.scratch, 2);
    newness = num(nw.scratch, 0.12);
  }
  devCostM = Math.round(devCostM);
  devWeeks = Math.round(devWeeks);
  return { devCostM, devWeeks, needFlights, upfrontM: Math.round(devCostM * num(dev.upfrontFrac, 0.3)), newness, change: r2(change) };
}

// ---------------------------------------------------------------------------------------------------------------
// asVehicle (what catalog.vehicleDef returns for a design)
// ---------------------------------------------------------------------------------------------------------------

function vClass(leo) {
  if (leo < 2) return 'small';
  if (leo < 20) return 'medium';
  if (leo < 50) return 'heavy';
  return 'superheavy';
}

/** Current reliability prior: inherent minus the not-yet-matured gap. */
function priorOf(d) {
  const inh = num(d.derived?.inherent, 0.85);
  const gap = num(d.program?.gap, num(d.gap, 0.12));
  return clamp(inh - gap, 0.3, 0.999);
}

function refreshVehicle(state, data, d) {
  const der = d.derived || {};
  const me = state.actors?.[d.owner] || {};
  const prog = d.program;
  const operational = prog?.phase === 'operational';
  const base = d.baseVehicleId ? catalogVehicle(data, d.baseVehicleId) : null;
  const opTurn = prog?.operationalTurn ?? state.turn;
  const od = turnToDate(opTurn, state.startYear);
  const hist = d.inheritHistory || { flights: 0, failures: 0 };
  const v = {
    id: d.id, name: d.name, operator: d.owner, provider: me.short || me.name || 'Sua agência', country: me.country || base?.country || '',
    class: vClass(num(der.capacity?.leo, 0)), family: 'design', designId: d.id, baseVehicleId: d.baseVehicleId || null,
    availableFrom: { year: od.year, month: od.month + 1 }, truthLayer: 'jogador',
    costM: num(der.costM, 50), cadencePerYear: 12, backgroundPerYear: 0,
    history: { flights: hist.flights, failures: hist.failures, firstFlight: null },
    historyWeight: r2(num(d.inheritWeight, 0) * (d.baseVehicleId ? kinshipOf(d) : 1)),
    estimatedReliability: r2(priorOf(d) * 1000) / 1000,
    reusable: !!(d.spec?.stages?.[0]?.reuse || d.spec?.boosters?.reuse),
    crewRated: false,
    crewCert: d.spec?.escapeId
      ? { feasible: true, flights: 3, costM: Math.round(num(der.costM, 50) * 4), weeks: 52, minReliability: 0.9, note: 'Projeto com sistema de escape: dá para certificar para tripulação.' }
      : { feasible: false, reason: 'Sem sistema de escape: o projeto não leva gente.' },
    access: 'own', embargo: [], standDownWeeks: 8,
    capacity: { ...Object.fromEntries(CAP_KEYS.map((k) => [k, num(der.capacity?.[k], 0)])), suborbital: num(der.capacity?.suborbital, 0) },
    notes: d.origin === 'license' ? `Projeto derivado do ${base?.name || 'foguete licenciado'}.` : 'Projeto próprio do Hangar.',
    design: { baseVehicleId: d.baseVehicleId || null, geometry: der.geometry || null, unmodified: !!der.unmodified, paint: d.spec?.paint || 'white' },
  };
  if (!operational) v.retired = true;
  if (d.retired) v.retired = true;
  d.asVehicle = v;
  return v;
}

/** Recompute derived numbers + asVehicle (after an edit, a license or a lifecycle change). */
function recompute(state, data, d) {
  const der = deriveDesign(state, data, d);
  d.derived = compactDerived(der);
  refreshVehicle(state, data, d);
  return der;
}

/** Keep the cache small in the save (geometry + headline numbers). */
function compactDerived(der) {
  return {
    ok: !!der.ok, capacity: der.capacity, costM: der.costM, inherent: r2(num(der.inherent, 0) * 1000) / 1000,
    scratchDevCostM: der.scratchDevCostM, scratchDevWeeks: der.scratchDevWeeks, massT: der.massT, liftoffTWR: der.liftoffTWR,
    heightM: der.heightM, diaM: der.diaM, geometry: der.geometry, unmodified: !!der.unmodified,
    ...(der.kinship != null ? { kinship: der.kinship } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reliability of a design (Beta: prior + inherited history + game flights)
// ---------------------------------------------------------------------------------------------------------------

export function designReliability(state, data, id) {
  const d = state?.designs?.[id];
  if (!d) return { mean: 0.8, low: 0.6, high: 0.95, flights: 0 };
  const est = priorOf(d);
  const k = 8;
  // a license only inherits the base vehicle's record while it is still that vehicle
  const hw = num(d.inheritWeight, 0) * (d.baseVehicleId ? kinshipOf(d) : 1);
  const hist = d.inheritHistory || { flights: 0, failures: 0 };
  const st = state.vehicleStats?.[id] || { flights: 0, failures: 0 };
  const gf = Math.max(0, num(st.flights, 0));
  const gx = clamp(num(st.failures, 0), 0, gf);
  const a = est * k + hw * (hist.flights - hist.failures) + (gf - gx);
  const b = (1 - est) * k + hw * hist.failures + gx;
  const n = a + b;
  const mean = a / n;
  const sd = Math.sqrt((mean * (1 - mean)) / (n + 1));
  return { mean, low: clamp(mean - 1.645 * sd, 0, 1), high: clamp(mean + 1.645 * sd, 0, 1), flights: gf, failures: gx };
}

// ---------------------------------------------------------------------------------------------------------------
// Templates (build from scratch based on the parts the actor can use now)
// ---------------------------------------------------------------------------------------------------------------

function usableParts(state, data, kind, actorId, licensed = []) {
  const P = partsOf(data);
  if (!P) return [];
  return P.list.filter((p) => p.kind === kind && partAccess(state, data, p, actorId, state.turn, { licensed }).ok);
}

function usableDiameters(state, data) {
  const P = partsOf(data);
  return (P?.tanks?.diameters || []).filter((d) => diameterOk(state, d));
}

/** pt-BR name of a tech node id (falls back to the id). */
function techName(data, id) {
  const n = data?.index?.tech?.[id] || (data?.tech?.nodes || []).find((x) => x.id === id);
  return n?.name || id;
}

/**
 * Why a template is locked and how to open it, for the Hangar (pt-BR):
 * { reason (one line), why (sentence), how: [{text, nodeId?, go?}], nodeId (first research to open) }.
 * For "no engine" it lists what would open an engine of this era: the research nodes and the agencies to sign with.
 */
function templateHelp(state, data, t, { early, gate }) {
  if (early) {
    return { reason: `Disponível em ${t.fromYear}`, why: `Ninguém ainda domina esse tipo de foguete: a tecnologia só existe a partir de ${t.fromYear}.`, how: [{ text: `Espere até ${t.fromYear}.` }], nodeId: null };
  }
  if (gate && !gate.ok) {
    const name = gate.nodeId ? techName(data, gate.nodeId) : null;
    return {
      reason: gate.reason,
      why: name ? `Sua agência ainda não sabe projetar essa família: ela depende da pesquisa ${name}.` : (gate.reason || 'Falta uma pesquisa.'),
      how: [{ text: name ? `Abra Pesquisa e estude ${name} (e o que vier antes dela na árvore).` : 'Abra Pesquisa.', nodeId: gate.nodeId || null, go: 'pesquisa' }],
      nodeId: gate.nodeId || null,
    };
  }
  const actorId = state.playerId;
  const P = partsOf(data);
  const now = monthNow(state, state.turn);
  if (!usableParts(state, data, 'engine', actorId).length) {
    // engines on the market now that this agency cannot use yet, grouped by what opens them
    const research = new Map();
    const deals = new Map();
    for (const p of (P?.list || [])) {
      if (p.kind !== 'engine' || monthIndex(p.availableFrom) > now || (p.availableUntil && monthIndex(p.availableUntil) < now)) continue;
      const a = partAccess(state, data, p, actorId, state.turn);
      if (a.ok) continue;
      const nodeId = a.nodeId || (p.tech && !research.has(p.tech) && /^Pesquise /.test(a.reason || '') ? p.tech : null)
        || (/^Pesquise /.test(a.reason || '') ? (data?.tech?.nodes || []).find((n) => n.name === a.reason.slice(9))?.id || null : null);
      if (/^Pesquise /.test(a.reason || '')) {
        const key = nodeId || a.reason;
        if (!research.has(key)) research.set(key, { name: nodeId ? techName(data, nodeId) : a.reason.slice(9), nodeId, engines: [] });
        research.get(key).engines.push(p.name);
      } else if (/acordo com/.test(a.reason || '')) {
        const who = (a.reason.match(/acordo com (.+?)( \(|$)/) || [])[1] || 'a dona do motor';
        if (!deals.has(who)) deals.set(who, []);
        deals.get(who).push(p.name);
      }
    }
    const how = [];
    for (const r of research.values()) how.push({ text: `Pesquise ${r.name}: libera ${r.engines.slice(0, 2).join(', ')}${r.engines.length > 2 ? ` e mais ${r.engines.length - 2}` : ''}.`, nodeId: r.nodeId, go: 'pesquisa' });
    for (const [who, list] of deals) how.push({ text: `Faça um acordo com ${who} (parceria ou contrato de lançamento, em Mundo › Rivais e diplomacia): libera ${list.slice(0, 2).join(', ')}.`, go: 'mundo' });
    if (!how.length) how.push({ text: 'Nenhum motor está à venda nesta data; espere os próximos anos ou pesquise propulsão.', go: 'pesquisa' });
    const first = [...research.values()].find((r) => r.nodeId);
    return { reason: 'Sem motor disponível', why: 'Todo foguete precisa de pelo menos um motor, e nenhum dos motores desta época está liberado para a sua agência.', how, nodeId: first?.nodeId || null };
  }
  if (!usableDiameters(state, data).length) {
    return { reason: 'Sem ferramental de tanque', why: 'Nenhum diâmetro de tanque está disponível nesta data.', how: [{ text: 'Espere o próximo ferramental de tanque.' }], nodeId: null };
  }
  return { reason: 'Os motores disponíveis não servem para esta família', why: 'Os motores liberados não têm empuxo ou eficiência suficientes para montar este rascunho.', how: [{ text: 'Pesquise motores mais potentes ou escolha outra família.', go: 'pesquisa' }], nodeId: null };
}

/** Best engine for a role (first: thrust × reliability with sea-level Isp; upper: vacuum Isp × reliability). */
function bestEngine(list, role) {
  const perKN = (e) => num(e.costM, 1) / Math.max(1, num(e.thrustKN, 1));
  const score = (e) => role === 'first'
    ? (num(e.ispSL, 0) > 0 ? (num(e.reliability, 0.9) ** 4 * (num(e.ispSL, 0) + num(e.ispVac, 0)) * Math.log10(10 + num(e.thrustKN, 0))) / (1 + 30 * perKN(e)) : -1)
    : (num(e.reliability, 0.9) ** 4 * num(e.ispVac, 0) * (num(e.ispVac, 0) > 600 ? 0.4 : 1) * (e.upperOnly ? 1 : 0.8) * (1 + 0.15 * Math.log10(10 + num(e.thrustKN, 0)))) / (1 + 3 * perKN(e));
  const cands = list.filter((e) => (role === 'first' ? !e.upperOnly && num(e.ispSL, 0) > 0 : true));
  return cands.sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1))[0] || null;
}

/** Research gate of a Hangar template for the actor (data.techtree.gates.template): {ok, key, nodeId, reason}. */
export function templateGate(state, data, t, actorId = state?.playerId) {
  return researchGateOf(data, state, 'template', t, actorId);
}

/**
 * Auto-filled spec for a template with the actor's parts now: engines by role, diameter by engine count,
 * tank steps sized for the template's liftoff TWR / upper-stage share. null when nothing fits.
 */
export function fillTemplate(state, data, templateId, actorId = state?.playerId) {
  const P = partsOf(data);
  const t = P?.templates.find((x) => x.id === templateId);
  if (!t) return null;
  const year = yearNow(state);
  if (year < num(t.fromYear, 1950)) return null;
  if (!templateGate(state, data, t, actorId).ok) return null;
  const engines = usableParts(state, data, 'engine', actorId);
  const dias = usableDiameters(state, data).slice().sort((a, b) => a.d - b.d);
  if (!engines.length || !dias.length) return null;
  const first = bestEngine(engines, 'first');
  if (!first) return null;
  const upper = bestEngine(engines.filter((e) => e.prop !== 'nuclear' && e.prop !== 'fusion'), 'upper') || first;
  const stages = [];
  const tc = techCtxFor(state, actorId);
  const T = P.tanks;
  const stepTOf = (d, prop) => Math.PI * (d / 2) ** 2 * Math.max(num(T.minStepM, 0.8), num(T.stepPerD, 0.5) * d) * num(T.fill, 0.88) * num(T.props?.[prop]?.densityT_m3, 1);
  const fits = (eng, n, d) => d >= num(eng.bellD, 1) * 1.15 && num(P.rules.engineFootprint, 0.75) * d ** 2 + num(eng.bellD, 1) ** 2 >= n * num(eng.bellD, 1) ** 2;
  // smallest tooling that holds the engines and keeps the tank slender (≤ maxSteps degraus)
  const pickSize = (eng, n, wantT, { maxSteps = 24, minD = 0, maxD = Infinity } = {}) => {
    const ok = dias.filter((d) => d.d >= minD && d.d <= maxD && fits(eng, n, d.d));
    for (const d of ok) {
      const steps = Math.round(wantT / stepTOf(d.d, eng.prop));
      if (steps <= maxSteps) return { dia: d, steps: Math.max(1, steps) };
    }
    const d = ok[ok.length - 1] || dias[dias.length - 1];
    return { dia: d, steps: clamp(Math.round(wantT / stepTOf(d.d, eng.prop)), 1, num(T.maxSteps, 32)) };
  };
  const t0 = t.stages[0] || {};
  const nFirst = clamp(Math.round(num(t0.engines, t.boosters ? 1 : 3)), 1, 9);
  let boosters = null;
  let boosterThrust = 0;
  let boosterMass = 0;
  if (t.boosters) {
    const bl = usableParts(state, data, 'booster', actorId).sort((a, b) => num(b.reliability, 0) - num(a.reliability, 0) || num(b.propT, 0) - num(a.propT, 0));
    const b = bl[0];
    if (!b) return null;
    boosters = { id: b.id, count: t.boosters };
    const e = b.engineId ? P.byId[b.engineId] : null;
    const vac = e ? num(b.engines, 1) * num(e.thrustKN, 0) : num(b.thrustKN, 0);
    const ratio = e ? num(e.ispSL, 0) / Math.max(1, num(e.ispVac, 1)) : num(b.ispSL, 230) / Math.max(1, num(b.ispVac, 260));
    boosterThrust = t.boosters * vac * ratio;
    boosterMass = t.boosters * (num(b.propT, 0) + num(b.dryT, 0));
  }
  const coreThrust = nFirst * num(first.thrustKN, 0) * num(first.ispSL, 0) / Math.max(1, num(first.ispVac, 1));
  const liftoffMass = (coreThrust + boosterThrust) / (G0 * num(t0.twr, 1.35));
  // the upper stages ride on the first: split the liftoff mass by the template's stage shares
  let chain = 0;
  let acc = 1;
  for (let i = 1; i < t.stages.length; i++) { acc *= num(t.stages[i].share, 0.25); chain += acc; }
  const coreProp = Math.max((liftoffMass * 0.86 - boosterMass) / (1 + chain), liftoffMass * 0.2);
  const s0 = pickSize(first, nFirst, coreProp);
  stages.push({ engineId: first.id, engines: nFirst, tank: s0.dia.id, size: s0.steps, ...(t0.reuse ? { reuse: true } : {}) });
  const dia0 = s0.dia;
  let prevProp = s0.steps * stepTOf(dia0.d, first.prop);
  for (let i = 1; i < t.stages.length; i++) {
    const want = prevProp * num(t.stages[i].share, 0.25);
    const prevD = dias.find((d) => d.id === stages[i - 1].tank)?.d ?? dia0.d;
    // enough engines for a TWR ≈ 0.6 on that stage
    const nUp = clamp(Math.ceil((want * 1.2 * G0 * 0.6) / Math.max(1, num(upper.thrustKN, 50))), 1, 6);
    const sz = pickSize(upper, nUp, want, { maxSteps: 14, minD: prevD * 0.55, maxD: prevD });
    stages.push({ engineId: upper.id, engines: nUp, tank: sz.dia.id, size: sz.steps });
    prevProp = sz.steps * stepTOf(sz.dia.d, upper.prop);
  }
  const fairings = usableParts(state, data, 'fairing', actorId).filter((f) => !f.kept).sort((a, b) => a.d - b.d);
  const fair = fairings.filter((f) => f.d <= dia0.d * 1.45).pop() || fairings[0] || null;
  const av = usableParts(state, data, 'avionics', actorId).sort((a, b) => num(b.reliability, 0) - num(a.reliability, 0))[0];
  if (!av) return null;
  const spec = { stages, boosters, fairingId: fair?.id || null, avionicsId: av.id, paint: 'white' };
  // shrink the first stage until it lifts off (cheap fix for odd part sets)
  for (let k = 0; k < 40; k++) {
    const s = designStats(data, spec, tc);
    if (s.ok || !s.errors.some((e) => /Não decola/.test(e))) break;
    if (spec.stages[0].size > 1) spec.stages[0].size -= 1;
    else if (spec.stages[0].engines < 9) spec.stages[0].engines += 1;
    else break;
  }
  // then trade first-stage tank for payload while that helps (a heavy stack is capped by the liftoff thrust)
  const leoOf = (sz) => { const x = designStats(data, { ...spec, stages: [{ ...spec.stages[0], size: sz }, ...spec.stages.slice(1)] }, tc); return x.ok ? x.capacity.leo : -1; };
  let best = spec.stages[0].size;
  let bestLeo = leoOf(best);
  for (let sz = best - 1; sz >= Math.max(1, best - 10); sz--) {
    const v = leoOf(sz);
    if (v > bestLeo + 1e-6) { best = sz; bestLeo = v; } else if (v < bestLeo - 1e-6) break;
  }
  spec.stages[0].size = best;
  return spec;
}

// ---------------------------------------------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------------------------------------------

function liveDesigns(state, owner) {
  return Object.values(state?.designs || {}).filter((d) => d && !d.retired && (!owner || d.owner === owner));
}

function capReached(state, data, owner) {
  const P = partsOf(data);
  return liveDesigns(state, owner).length >= num(P?.rules?.maxLiveDesigns, 12);
}

function cleanName(s, fallback) {
  const t = String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_MAX);
  return t || fallback;
}

function revisionName(name, n) {
  const base = String(name).replace(/\s+(II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)(-[A-Z])?$/, '');
  return `${base} ${ROMAN[clamp(n + 1, 2, 12)]}`.slice(0, NAME_MAX);
}

function newDesign(state, data, fields) {
  const id = nextId(state, 'dsg');
  const d = {
    id, name: fields.name, owner: fields.owner, baseVehicleId: fields.baseVehicleId ?? null, origin: fields.origin,
    spec: normalizeSpec(fields.spec), licensedParts: fields.licensedParts || [], createdTurn: state.turn,
    program: null, stats: { flights: 0, failures: 0 },
  };
  if (fields.parentId) { d.parentId = fields.parentId; d.revision = fields.revision || 1; d.refSpec = clone(fields.refSpec); }
  if (fields.inheritHistory) { d.inheritHistory = fields.inheritHistory; d.inheritWeight = fields.inheritWeight; }
  if (fields.gap != null) d.gap = fields.gap;
  ensure(state)[id] = d;
  recompute(state, data, d);
  return d;
}

function missionsUsing(state, id) {
  return (state.missions || []).filter((m) => m && m.vehicleId === id && ['planning', 'scheduled', 'launch', 'transit', 'arrival', 'operations'].includes(m.status));
}

function playerOnly(state, action) {
  return action?.actorId && action.actorId !== state.playerId ? { ok: false, error: 'Só a sua agência usa o Hangar.' } : null;
}

function builderUnlocked(state, data) {
  const fy = data?.scenario?.unlocks?.builder?.fromYear;
  if (!Number.isFinite(fy)) return { ok: true, fromYear: null };
  return { ok: yearNow(state) >= fy, fromYear: fy };
}

// ---------------------------------------------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------------------------------------------

export function init(state) {
  ensure(state);
}

/** Abstract test flight result (one rng draw) + records, maturity, news. */
function resolveTestFlight(state, data, d, ctx, success, { missionId = null } = {}) {
  const P = partsOf(data);
  const pr = d.program;
  pr.testFlights = (pr.testFlights || 0) + 1;
  if (success) pr.testOk = (pr.testOk || 0) + 1;
  const mt = P?.dev?.maturityPerTest || {};
  pr.gap = num(pr.gap, 0) * (1 - num(success ? mt.success : mt.failure, success ? 0.5 : 0.25));
  if (!missionId) {
    try { calendar.recordFlight(state, d.id, success); } catch { /* stats are a nicety */ }
  }
  d.stats = { flights: num(state.vehicleStats?.[d.id]?.flights, d.stats.flights + 1), failures: num(state.vehicleStats?.[d.id]?.failures, d.stats.failures + (success ? 0 : 1)) };
  const n = pr.testFlights;
  addNews(state, {
    headline: success ? `Voo de teste ${n} do ${d.name}: sucesso` : `Voo de teste ${n} do ${d.name} falha`,
    body: success ? 'O lastro chegou à órbita e a telemetria confirma o projeto.' : 'Os engenheiros já analisam os dados: cada falha ensina alguma coisa.',
    importance: 2, tags: ['designs', 'test'], actors: [d.owner], icon: success ? 'rocket' : 'failure',
  });
  emitSignal(state, 'design/testFlight', { designId: d.id, success, actorId: d.owner, missionId });
  if (success && pr.testOk >= pr.needFlights) makeOperational(state, data, d);
  refreshVehicle(state, data, d);
}

function makeOperational(state, data, d) {
  const pr = d.program;
  pr.phase = 'operational';
  pr.operationalTurn = state.turn;
  pr.nextTestTurn = null;
  refreshVehicle(state, data, d);
  addNews(state, {
    headline: `${d.name} entra em operação`,
    body: num(d.derived?.capacity?.leo, 0) > 0
      ? `O novo foguete da agência já aparece na escolha de veículo das missões (${fmtT(d.derived?.capacity?.leo)} em órbita baixa).`
      : `O novo foguete da agência já aparece na escolha de veículo das missões, para voos suborbitais (${fmtT(d.derived?.capacity?.suborbital)} acima dos 100 km).`,
    importance: 2, tags: ['designs'], actors: [d.owner], icon: 'rocket',
  });
  emitSignal(state, 'design/operational', { designId: d.id, actorId: d.owner });
}

const fmtT = (t) => `${String(Math.round(num(t, 0) * 10) / 10).replace('.', ',')} t`;

export function tick(state, data, ctx) {
  const all = state?.designs;
  if (!all || !partsOf(data)) return;
  // B5 path: test-flight missions (source 'test') flown through the normal mission system
  for (const sg of state.signals || []) {
    if (sg?.type !== 'mission/resolved' || !sg.missionId) continue;
    const m = (state.missions || []).find((x) => x?.id === sg.missionId);
    const did = m && (m.testDesignId || m.designId || (m.source === 'test' ? m.vehicleId : null));
    const d = did && all[did];
    if (!d || m.source !== 'test' || d.program?.phase !== 'testFlights') continue;
    onTestFlight(state, data, d.id, OK_LEVELS.has(sg.outcome), m.id);
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
        if (budget.spend(state, d.owner, pay, 'designs', `Desenvolvimento: ${d.name}`)) {
          pr.paidM = r2(num(pr.paidM, 0) + pay);
          if (pr.paused) pr.paused = false;
        } else {
          // no money: the work stops and the date slides
          pr.readyTurn = num(pr.readyTurn, state.turn) + ctx.dt;
          if (!pr.paused) {
            pr.paused = true;
            addNews(state, { headline: `Falta caixa: desenvolvimento do ${d.name} parado`, importance: 2, tags: ['designs'], actors: [d.owner], icon: 'budget' });
          }
          continue;
        }
      }
      if (dueIn(ctx, pr.readyTurn) && num(pr.devCostM, 0) - num(pr.paidM, 0) <= 0.01) {
        if (num(pr.needFlights, 0) > 0) {
          pr.phase = 'testFlights';
          pr.testsSince = ctx.prevTurn + ctx.dt;
          addNews(state, { headline: `${d.name} pronto para os voos de teste`, body: `Faltam ${pr.needFlights} voo(s) de teste com sucesso para o foguete entrar em operação.`, importance: 2, tags: ['designs'], actors: [d.owner], icon: 'rocket' });
          if (d.owner === state.playerId) {
            pushDecision(state, {
              kind: 'design/ready', title: `${d.name}: pronto para testar`,
              body: `O desenvolvimento terminou. Cada voo de teste leva lastro à órbita baixa e custa ${Math.round(testCost(data, d))} mi.`,
              choices: [{ id: 'test', label: 'Marcar voo de teste', preview: `${num(partsOf(data)?.tests?.prepWeeks, 6)} semanas de preparo` }, { id: 'later', label: 'Depois, no Hangar' }],
              defaultChoice: 'later', urgency: 1, expiresTurn: expiryIn(ctx, 8), payload: { designId: d.id },
            });
          }
        } else makeOperational(state, data, d);
      }
    } else if (pr.phase === 'testFlights' && pr.nextTestTurn != null && dueIn(ctx, pr.nextTestTurn)) {
      pr.nextTestTurn = null;
      const rel = designReliability(state, data, d.id).mean;
      const rng = ctx.rng(`test:${d.id}:${pr.testFlights || 0}`);
      resolveTestFlight(state, data, d, ctx, rng.next() < rel);
    }
    // keep the mirror of flight stats fresh (operational designs fly ordinary missions)
    const vs = state.vehicleStats?.[d.id];
    if (vs && (vs.flights !== d.stats?.flights || vs.failures !== d.stats?.failures)) d.stats = { flights: num(vs.flights, 0), failures: num(vs.failures, 0) };
  }
}

/** Player appointments: abstract test flights (the step lands on them). */
export function appointments(state) {
  const out = [];
  for (const d of Object.values(state?.designs || {})) {
    const t = d?.program?.nextTestTurn;
    if (d?.owner === state.playerId && Number.isFinite(t)) out.push(t);
  }
  return out;
}

export function compact(state) {
  const all = state?.designs;
  if (!all) return;
  for (const [id, d] of Object.entries(all)) {
    if (d?.retired && state.turn - num(d.retiredTurn, state.turn) > 20 * 52) delete all[id];
  }
}

/** Live test-flight mission of a design flown by the mission system (B5), or null. */
export function testMission(state, designId) {
  return (state?.missions || []).find((m) => m && (m.testDesignId === designId || (m.source === 'test' && m.designId === designId)) && !['done', 'cancelled'].includes(m.status)) || null;
}

// ---- peer API for missions.js (B5 binds it with missions.bindPeers({ designs })) ------------------------------

/** A test-flight mission was created for a design (missions.js). */
export function linkTestFlight(state, data, designId, missionId) {
  const d = state?.designs?.[designId];
  if (d?.program) d.program.testMissionId = missionId;
}

/** A test-flight mission of a design resolved (missions.js; the mission system records the flight itself). */
export function onTestFlight(state, data, designId, success, missionId) {
  const d = state?.designs?.[designId];
  if (!d || d.program?.phase !== 'testFlights') return;
  const pr = d.program;
  pr.countedMissions = pr.countedMissions || [];
  if (missionId && pr.countedMissions.includes(missionId)) return;
  if (missionId) { pr.countedMissions.push(missionId); if (pr.countedMissions.length > 8) pr.countedMissions.shift(); }
  if (pr.testMissionId === missionId) pr.testMissionId = null;
  resolveTestFlight(state, data, d, null, !!success, { missionId: missionId || 'mission' });
}

/** An operational design flew an ordinary mission: refresh the mirror of its record. */
export function onDesignFlight(state, data, designId) {
  const d = state?.designs?.[designId];
  const vs = state?.vehicleStats?.[designId];
  if (d && vs) d.stats = { flights: num(vs.flights, 0), failures: num(vs.failures, 0) };
}

export function onActorGone(state, data, ctx, id, info = {}) {
  for (const d of Object.values(state?.designs || {})) {
    if (d?.owner !== id) continue;
    if (info?.into) { d.owner = info.into; if (d.asVehicle) d.asVehicle.operator = info.into; }
  }
}

/** Test flight cost (US$ mi). */
function testCost(data, d) {
  return num(d.derived?.costM, 50) * num(partsOf(data)?.tests?.costMult, 1);
}

function scheduleTest(state, data, d, ctx) {
  const P = partsOf(data);
  if (d.program?.phase !== 'testFlights') return { ok: false, error: 'Este projeto não está na fase de testes.' };
  if (d.program.nextTestTurn != null) return { ok: false, error: 'Já há um voo de teste marcado.' };
  if (testMission(state, d.id)) return { ok: false, error: 'O voo de teste já está em Missões: agende por lá.' };
  const cost = Math.round(testCost(data, d) * 10) / 10;
  if (!budget.spend(state, d.owner, cost, 'designs', `Voo de teste: ${d.name}`)) return { ok: false, error: 'Caixa insuficiente para o voo de teste.' };
  const weeks = Math.max(1, num(P.tests.prepWeeks, 6));
  d.program.nextTestTurn = state.turn + Math.max(weeks, 1);
  return { ok: true, designId: d.id, testTurn: d.program.nextTestTurn, costM: cost };
}

export const decisionHandlers = {
  'design/ready': (state, data, dec, choiceId, ctx) => {
    const d = state.designs?.[dec.payload?.designId];
    if (!d || choiceId !== 'test') return { ok: true };
    // with the mission system flying test flights, the card opens that mission instead
    const m = testMission(state, d.id);
    if (m) return { ok: true, openBuilder: m.id, step: 2 };
    return scheduleTest(state, data, d, ctx);
  },
};

export const actions = {
  /** Buy the rights to a catalog rocket: a design with its parts and history, still to be developed. */
  'design/license': (state, data, action) => {
    ensure(state);
    if (!partsOf(data)) return { ok: false, error: 'Catálogo de peças não carregado.' };
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const un = builderUnlocked(state, data);
    if (!un.ok) return { ok: false, error: `O Hangar abre em ${un.fromYear}.` };
    const owner = state.playerId;
    if (capReached(state, data, owner)) return { ok: false, error: 'Limite de projetos ativos atingido: aposente algum.' };
    const q = licenseQuote(state, data, action.vehicleId, owner);
    if (!q.ok) return { ok: false, error: q.reason };
    if (q.feeM > 0 && !budget.spend(state, owner, q.feeM, 'designs', `Licença: ${q.vehicle.name}`)) return { ok: false, error: 'Caixa insuficiente para a licença.' };
    const spec = { ...clone(catalogDesign(data, action.vehicleId)), paint: catalogDesign(data, action.vehicleId)?.paint || 'white' };
    delete spec.calib;
    const st = state.vehicleStats?.[action.vehicleId] || q.vehicle.history || {};
    const d = newDesign(state, data, {
      name: cleanName(action.name, q.own ? `${q.vehicle.name} (projeto)` : `${q.vehicle.name} licenciado`),
      owner, baseVehicleId: action.vehicleId, origin: 'license', spec,
      licensedParts: [...specPartIds(spec), ...(spec.stages || []).map((s) => s.tank).filter(Boolean)],
      inheritHistory: { flights: Math.max(0, num(st.flights, 0)), failures: Math.max(0, num(st.failures, 0)) },
      inheritWeight: 0.5,
    });
    addNews(state, { headline: q.own ? `${actorName(state, owner)} abre um projeto a partir do ${q.vehicle.name}` : `${actorName(state, owner)} compra a licença do ${q.vehicle.name}`, importance: 1, tags: ['designs'], actors: [owner, q.vehicle.operator].filter(Boolean), icon: 'rocket' });
    if (!q.own && q.vehicle.operator && state.actors?.[q.vehicle.operator]) emitSignal(state, 'design/licensed', { designId: d.id, vehicleId: action.vehicleId, from: q.vehicle.operator, actorId: owner, feeM: q.feeM });
    return { ok: true, designId: d.id, feeM: q.feeM };
  },

  /** New design from a family template, filled with the parts the agency can use now (free until developed). */
  'design/new': (state, data, action) => {
    ensure(state);
    const P = partsOf(data);
    if (!P) return { ok: false, error: 'Catálogo de peças não carregado.' };
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const un = builderUnlocked(state, data);
    if (!un.ok) return { ok: false, error: `O Hangar abre em ${un.fromYear}.` };
    if (capReached(state, data, state.playerId)) return { ok: false, error: 'Limite de projetos ativos atingido: aposente algum.' };
    const tg = P.templates.find((x) => x.id === action.templateId);
    const gate = tg ? templateGate(state, data, tg) : null;
    if (gate && !gate.ok) return { ok: false, error: `${gate.reason}.`, nodeId: gate.nodeId };
    const spec = action.spec ? normalizeSpec(action.spec) : fillTemplate(state, data, action.templateId);
    if (!spec) return { ok: false, error: 'Ainda não há peças para esse tipo de foguete.' };
    const t = P.templates.find((x) => x.id === action.templateId);
    const me = state.actors?.[state.playerId] || {};
    const n = liveDesigns(state, state.playerId).length + 1;
    const d = newDesign(state, data, { name: cleanName(action.name, `${me.short || 'Projeto'} ${t ? t.name : 'novo'} ${n}`), owner: state.playerId, baseVehicleId: null, origin: 'scratch', spec });
    return { ok: true, designId: d.id };
  },

  /**
   * Save edits: {designId, draft: {name?, stages, boosters, fairingId, avionicsId, escapeId?, paint}}.
   * Project (not developing): updated in place. Operational: a revision (new design, "Nome II"). In development: refused.
   */
  'design/save': (state, data, action) => {
    ensure(state);
    if (!partsOf(data)) return { ok: false, error: 'Catálogo de peças não carregado.' };
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.designs[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return { ok: false, error: 'Projeto não encontrado.' };
    const draft = action.draft || {};
    const spec = normalizeSpec({ ...d.spec, ...draft, stages: draft.stages ?? d.spec.stages, boosters: draft.boosters !== undefined ? draft.boosters : d.spec.boosters });
    const name = cleanName(draft.name, d.name);
    const locked = lockedParts(state, data, spec, d.owner, d.licensedParts || []);
    if (locked.length) return { ok: false, error: `${locked[0].name}: ${locked[0].reason}.`, locked };
    const stats = designStats(data, spec, techCtxFor(state, d.owner));
    if (!stats.ok) return { ok: false, error: stats.errors[0], errors: stats.errors };
    if (d.program?.phase === 'work' || d.program?.phase === 'testFlights') return { ok: false, error: 'Em desenvolvimento: edite quando estiver operacional (vira uma revisão).' };
    if (d.program?.phase === 'operational') {
      if (sameHardware(spec, d.spec)) {
        d.name = name;
        d.spec.paint = spec.paint;
        refreshVehicle(state, data, d);
        return { ok: true, designId: d.id };
      }
      if (capReached(state, data, d.owner)) return { ok: false, error: 'Limite de projetos ativos atingido: aposente algum.' };
      const rev = (d.revision || 1) + 1;
      const nd = newDesign(state, data, {
        name: name !== d.name ? name : revisionName(d.name, rev - 1), owner: d.owner, baseVehicleId: d.baseVehicleId, origin: d.origin, spec,
        licensedParts: d.licensedParts, parentId: d.id, revision: rev, refSpec: d.spec,
        inheritHistory: { flights: num(state.vehicleStats?.[d.id]?.flights, 0) + num(d.inheritHistory?.flights, 0), failures: num(state.vehicleStats?.[d.id]?.failures, 0) + num(d.inheritHistory?.failures, 0) },
        inheritWeight: 0.6,
      });
      return { ok: true, designId: nd.id, revision: true };
    }
    d.name = name;
    d.spec = spec;
    recompute(state, data, d);
    return { ok: true, designId: d.id };
  },

  /** Start development: pays the upfront share, the rest week by week during the work phase. */
  'design/develop': (state, data, action) => {
    ensure(state);
    if (!partsOf(data)) return { ok: false, error: 'Catálogo de peças não carregado.' };
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.designs[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return { ok: false, error: 'Projeto não encontrado.' };
    if (d.program) return { ok: false, error: 'Este projeto já está em desenvolvimento.' };
    const locked = lockedParts(state, data, d.spec, d.owner, d.licensedParts || []);
    if (locked.length) return { ok: false, error: `${locked[0].name}: ${locked[0].reason}.` };
    const der = recompute(state, data, d);
    if (!der.ok) return { ok: false, error: der.errors[0] || 'Projeto inválido.' };
    if (!(der.capacity.leo > 0) && !(der.capacity.suborbital > 0)) return { ok: false, error: 'Este projeto não chega ao espaço (nem em voo suborbital).' };
    const pc = programCosts(state, data, d, der);
    if (pc.upfrontM > 0 && !budget.spend(state, d.owner, pc.upfrontM, 'designs', `Desenvolvimento: ${d.name}`)) return { ok: false, error: `Caixa insuficiente: a entrada é de ${pc.upfrontM} mi.` };
    d.program = {
      phase: 'work', startedTurn: state.turn, readyTurn: state.turn + Math.max(1, pc.devWeeks), devCostM: pc.devCostM, paidM: pc.upfrontM,
      needFlights: pc.needFlights, testFlights: 0, testOk: 0, nextTestTurn: null, paused: false, gap: pc.newness,
    };
    refreshVehicle(state, data, d);
    addNews(state, { headline: `${actorName(state, d.owner)} começa a desenvolver o ${d.name}`, importance: 1, tags: ['designs'], actors: [d.owner], icon: 'rocket' });
    return { ok: true, designId: d.id, ...pc };
  },

  /** Book an abstract test flight (ballast to LEO, no launch scene) for a design in its test phase. */
  'design/testFlight': (state, data, action, ctx) => {
    ensure(state);
    const deny = playerOnly(state, action);
    if (deny) return deny;
    const d = state.designs[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return { ok: false, error: 'Projeto não encontrado.' };
    return scheduleTest(state, data, d, ctx);
  },

  /** Stop a development program (no refund); the design goes back to the drawing board. */
  'design/cancel': (state, data, action) => {
    ensure(state);
    const d = state.designs[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return { ok: false, error: 'Projeto não encontrado.' };
    if (!d.program || d.program.phase === 'operational') return { ok: false, error: 'Não há desenvolvimento para cancelar.' };
    d.program = null;
    refreshVehicle(state, data, d);
    addNews(state, { headline: `Desenvolvimento do ${d.name} cancelado`, importance: 1, tags: ['designs'], actors: [d.owner], icon: 'failure' });
    return { ok: true, designId: d.id };
  },

  /** Retire (delete) a design that no live mission uses. */
  'design/retire': (state, data, action) => {
    ensure(state);
    const d = state.designs[action.designId];
    if (!d || d.retired || d.owner !== state.playerId) return { ok: false, error: 'Projeto não encontrado.' };
    if (missionsUsing(state, d.id).length) return { ok: false, error: 'Há missões usando este foguete.' };
    if (!d.program || d.program.phase !== 'operational') {
      delete state.designs[d.id];
      return { ok: true, removed: true };
    }
    d.retired = true;
    d.retiredTurn = state.turn;
    refreshVehicle(state, data, d);
    return { ok: true, retired: true };
  },
};

/** Short pt-BR status of a design. */
export function statusOf(state, d) {
  const pr = d?.program;
  if (d?.retired) return { id: 'retired', label: 'Aposentado' };
  if (!pr) return { id: 'project', label: 'Projeto' };
  if (pr.phase === 'work') return { id: 'work', label: pr.paused ? 'Parado (sem caixa)' : 'Em desenvolvimento' };
  if (pr.phase === 'testFlights') return { id: 'tests', label: pr.nextTestTurn != null ? 'Voo de teste marcado' : 'Voos de teste' };
  return { id: 'operational', label: 'Operacional' };
}

function summary(state, data, d) {
  const rel = designReliability(state, data, d.id);
  const pc = d.program ? null : programCosts(state, data, d);
  return {
    id: d.id, name: d.name, origin: d.origin, baseVehicleId: d.baseVehicleId, parentId: d.parentId || null, status: statusOf(state, d),
    capacity: d.derived?.capacity || {}, costM: d.derived?.costM ?? 0, heightM: d.derived?.heightM ?? 0, reliability: rel,
    program: d.program ? { ...d.program } : null, costs: pc, spec: clone(d.spec), geometry: d.derived?.geometry || null,
    asVehicle: d.asVehicle, ok: !!d.derived?.ok, licensedParts: d.licensedParts || [],
    testMission: (() => { const m = testMission(state, d.id); return m ? { id: m.id, status: m.status, name: m.name || null } : null; })(),
  };
}

export const queries = {
  /** Player designs (live), newest first. */
  'designs/list': (state, data) => liveDesigns(state, state.playerId).sort((a, b) => num(b.createdTurn, 0) - num(a.createdTurn, 0) || (a.id < b.id ? 1 : -1)).map((d) => summary(state, data, d)),
  'designs/get': (state, data, id) => (state.designs?.[id] ? summary(state, data, state.designs[id]) : null),
  /**
   * Pure preview of a draft (no time passes): {ok, errors, warnings, derived, costs, locked}. `draft` may carry
   * designId (edit of a saved design: license calibration + program kind) or baseVehicleId.
   */
  'designs/preview': (state, data, draft = {}) => {
    const src = draft.designId ? state.designs?.[draft.designId] : null;
    const owner = src?.owner ?? state.playerId;
    const spec = normalizeSpec(draft.spec || draft);
    const fake = src
      ? (src.program?.phase === 'operational' && !sameHardware(spec, src.spec)
        ? { ...src, spec, parentId: src.id, refSpec: src.spec, program: null }
        : { ...src, spec })
      : { id: 'preview', owner, origin: draft.baseVehicleId ? 'license' : 'scratch', baseVehicleId: draft.baseVehicleId || null, spec };
    const der = deriveDesign(state, data, fake, spec, owner);
    const costs = der.ok ? programCosts(state, data, fake, der) : null;
    const locked = lockedParts(state, data, spec, owner, src?.licensedParts || []);
    return { ok: der.ok && !locked.length, errors: der.errors, warnings: der.warnings, derived: der, costs, locked, revision: !!fake.parentId && fake !== src };
  },
  /** Parts of a kind with lock state for the player: [{part, ok, reason}]. */
  'designs/parts': (state, data, { kind, licensed = [] } = {}) => {
    const P = partsOf(data);
    if (!P) return [];
    return P.list.filter((p) => !kind || p.kind === kind).map((p) => ({ part: p, ...partAccess(state, data, p, state.playerId, state.turn, { licensed }) }));
  },
  /** Tank diameters with lock state. */
  'designs/diameters': (state, data, { licensed = [] } = {}) => (partsOf(data)?.tanks?.diameters || []).map((d) => ({ ...d, ok: licensed.includes(d.id) || diameterOk(state, d), reason: diameterOk(state, d) ? null : `Disponível em ${d.availableFrom.year}` })),
  /** Catalog rockets the player could license now (or why not). */
  'designs/licensable': (state, data) => {
    const P = partsOf(data);
    if (!P) return [];
    return (data?.vehicles?.vehicles || [])
      .filter((v) => itemAvailable(data, state, v, state.turn))
      .map((v) => ({ vehicleId: v.id, name: v.name, operator: v.operator, provider: v.provider || null, capacity: v.capacity, costM: v.costM, ...licenseQuote(state, data, v.id) }))
      .map(({ vehicle, ...rest }) => rest);
  },
  /** Templates with their auto-filled spec for the player now, plus why a locked one is locked and how to open it. */
  'designs/templates': (state, data) => (partsOf(data)?.templates || []).map((t) => {
    const early = yearNow(state) < num(t.fromYear, 1950);
    const gate = early ? null : templateGate(state, data, t);
    const spec = !early && gate.ok ? fillTemplate(state, data, t.id) : null;
    const help = spec ? null : templateHelp(state, data, t, { early, gate });
    const reason = spec ? null : help.reason;
    return { id: t.id, name: t.name, desc: t.desc, ok: !!spec, reason, why: help?.why || null, how: help?.how || [], nodeId: help?.nodeId || null, spec };
  }),
  /** Static tables the Hangar needs (labels). */
  'designs/catalogInfo': (state, data) => {
    const P = partsOf(data);
    if (!P) return null;
    return { classes: P.classes, paints: P.paints, props: Object.fromEntries(Object.entries(P.tanks.props || {}).map(([k, v]) => [k, { name: v.name, short: v.short }])), rules: P.rules, deltaV: P.deltaV, tests: P.tests };
  },
  /** Is the Hangar open (scenario unlocks) and is the parts catalog loaded? */
  'designs/unlocked': (state, data) => ({ ...builderUnlocked(state, data), loaded: !!partsOf(data) }),
  /** Reliability of a design (Beta). */
  'designs/reliability': (state, data, id) => designReliability(state, data, id),
  /** Plan for a test-flight mission (B5): vehicle locked to the design, ballast to LEO. */
  'designs/testFlightPlan': (state, data, id) => {
    const d = state.designs?.[id];
    if (!d || d.program?.phase !== 'testFlights') return null;
    const orbital = num(d.derived?.capacity?.leo, 0) > 0;
    const cap = orbital ? num(d.derived.capacity.leo, 0) : num(d.derived?.capacity?.suborbital, 0);
    const ballastT = Math.min(num(partsOf(data)?.tests?.ballastT, 0.5), Math.max(0.02, Math.round(cap * 0.8 * 100) / 100));
    return { vehicleId: d.id, destination: orbital ? 'leo' : 'suborbital', ballastT, costM: r1(testCost(data, d)), crewed: false, locked: true, source: 'test', testDesignId: d.id };
  },
};

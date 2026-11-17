// Mission risk model (pure, no slice). GDD "Confiabilidade e risco" + ARCHITECTURE "src/sim/risk.js".
// Model: each risk source is a *hazard* h (p_success = exp(-h)). Modifiers multiply hazards, which keeps
// probabilities in range and lets us distribute the total over milestones: pFail_i = 1 - exp(-h_i).
// Imports only via namespaces so stub modules (missing exports) never break linking.

import * as calendar from './calendar.js';
import * as research from './research.js';
import * as crew from './crew.js';
import * as politics from './politics.js';
import { DEFAULT_FAILURE_WEIGHTS } from '../core/outcome.js';
import { dateToTurn, formatTurn } from '../core/time.js';

// ---------- tables (mechanics, not content) ----------

/** Share of the vehicle hazard per ascent milestone. */
const ASCENT_SHARES = { ignition: 0.1, liftoff: 0.13, maxq: 0.22, staging: 0.25, fairing_or_les: 0.1, orbit: 0.14, tli: 0.08 };

/** Failure-type weights per ascent milestone (before environment/crew adjustments). */
const ASCENT_WEIGHTS = {
  ignition: { propulsion: 0.6, structure: 0.05, software: 0.25, human: 0.05, environment: 0.05 },
  liftoff: { propulsion: 0.42, structure: 0.15, software: 0.15, human: 0.1, environment: 0.18 },
  maxq: { propulsion: 0.22, structure: 0.45, software: 0.05, human: 0.05, environment: 0.23 },
  staging: { propulsion: 0.35, structure: 0.3, software: 0.25, human: 0.1, environment: 0 },
  fairing_or_les: { propulsion: 0.1, structure: 0.5, software: 0.3, human: 0.1, environment: 0 },
  orbit: { propulsion: 0.4, structure: 0.1, software: 0.35, human: 0.15, environment: 0 },
  tli: { propulsion: 0.5, structure: 0.05, software: 0.25, human: 0.2, environment: 0 },
};

/** Environmental sensitivity per milestone (weather/space weather adds hazard here). */
const ENV_SENSITIVITY = { ignition: 0.2, liftoff: 1, maxq: 1.2, staging: 0.2, fairing_or_les: 0.1, orbit: 0, tli: 0 };

const ASCENT_T = { ignition: 0, liftoff: 6, maxq: 22, staging: 40, fairing_or_les: 52, orbit: 72, tli: 88 };

/** Arrival milestone defaults guessed from the id when data omits fields. */
function arrivalDefaults(id = '') {
  const s = String(id);
  if (/touch|pouso|land|surface|contact/.test(s)) return { share: 1.3, env: 1, weights: { propulsion: 0.25, structure: 0.15, software: 0.25, human: 0.15, environment: 0.2 } };
  if (/descent|descida|braking|pdi/.test(s)) return { share: 1.1, env: 0.7, weights: { propulsion: 0.3, structure: 0.05, software: 0.35, human: 0.15, environment: 0.15 } };
  if (/entry|edl|reentr|atmos|aero/.test(s)) return { share: 1.2, env: 1.2, weights: { propulsion: 0.1, structure: 0.45, software: 0.2, human: 0.05, environment: 0.2 } };
  if (/insert|loi|moi|orbit|capture|captura/.test(s)) return { share: 0.9, env: 0.2, weights: { propulsion: 0.5, structure: 0.05, software: 0.3, human: 0.1, environment: 0.05 } };
  if (/dock|acopl|rendez/.test(s)) return { share: 0.7, env: 0.1, weights: { propulsion: 0.2, structure: 0.15, software: 0.4, human: 0.25, environment: 0 } };
  if (/deploy|rover|ops|science|sample|amostra/.test(s)) return { share: 0.6, env: 0.5, weights: { propulsion: 0.05, structure: 0.2, software: 0.4, human: 0.15, environment: 0.2 } };
  return { share: 1, env: 0.4, weights: { ...DEFAULT_FAILURE_WEIGHTS } };
}

/** Extra hazard of the destination itself (landing, entry, deep space). data may override with destination.risk. */
const DEST_BASE_FAIL = { orbit: 0.004, station: 0.006, flyby: 0.01, lunar_orbit: 0.015, surface: 0.07, south_pole: 0.095, mars_orbit: 0.04, mars_surface: 0.16, outer: 0.06 };

function destBaseFail(dest) {
  if (!dest) return 0;
  if (Number.isFinite(dest.risk)) return dest.risk;
  const id = dest.id || '';
  if (id === 'lunar_south_pole') return DEST_BASE_FAIL.south_pole;
  if (id === 'mars_surface') return DEST_BASE_FAIL.mars_surface;
  if (id === 'mars_orbit') return DEST_BASE_FAIL.mars_orbit;
  if (id === 'jupiter' || id === 'titan' || dest.capacityKey === 'outer') return DEST_BASE_FAIL.outer;
  if (/surface|landing|pouso/.test(id + (dest.kind || ''))) return dest.body === 'mars' ? DEST_BASE_FAIL.mars_surface : DEST_BASE_FAIL.surface;
  if (id === 'lunar_orbit') return DEST_BASE_FAIL.lunar_orbit;
  if (id === 'cislunar') return DEST_BASE_FAIL.flyby;
  if (id === 'iss' || dest.kind === 'station') return DEST_BASE_FAIL.station;
  if (dest.body === 'moon') return DEST_BASE_FAIL.lunar_orbit;
  return DEST_BASE_FAIL.orbit;
}

/** Minimum preparation (weeks between creation and launch) before rushing adds risk. */
const PREP_WEEKS = { satellite: 6, cargo: 8, probe: 12, crewed: 16, lander: 14, station: 16 };

export const STRATEGIES = {
  conservative: { hazard: 0.8, prestige: 0.85, science: 0.95, label: 'Estratégia conservadora' },
  balanced: { hazard: 1, prestige: 1, science: 1, label: 'Estratégia equilibrada' },
  aggressive: { hazard: 1.25, prestige: 1.2, science: 1.1, label: 'Estratégia agressiva' },
};

/** Expected weather risk before the launch day (the real roll replaces it). */
export const EXPECTED_WEATHER_RISK = 0.1;
/** Fail probability added per unit of weather risk at a fully sensitive milestone. */
const WEATHER_FAIL = 0.035;

// ---------- small helpers ----------

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const H = (p) => -Math.log(clamp(p, 1e-6, 1)); // success prob -> hazard
const P = (h) => Math.exp(-h);
const r3 = (x) => Math.round(x * 1000) / 1000;
const pct = (x) => `${Math.round(x * 100)}%`;

/** Call a cross-module function if it exists; swallow errors from modules still in progress. */
function safe(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    const v = fn(...args);
    return v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) ? fallback : v;
  } catch {
    return fallback;
  }
}

export function lookup(data, kind, id) {
  if (!id) return null;
  const idx = data?.index?.[kind];
  if (idx && idx[id]) return idx[id];
  const listKey = { vehicles: 'vehicles', spacecraft: 'spacecraft', destinations: 'destinations' }[kind];
  return data?.[kind]?.[listKey]?.find?.((x) => x.id === id) || null;
}

/** Beta-style vehicle reliability fallback when calendar.vehicleReliability is unavailable. */
export function fallbackVehicleReliability(state, vehicle) {
  const st = state?.vehicleStats?.[vehicle?.id];
  const flights = st?.flights ?? vehicle?.history?.flights ?? 0;
  const failures = st?.failures ?? vehicle?.history?.failures ?? 0;
  const prior = vehicle?.estimatedReliability ?? 0.9;
  const k = 8;
  const mean = clamp((prior * k + flights - failures) / (k + flights), 0.3, 0.998);
  const sd = Math.sqrt((mean * (1 - mean)) / (k + flights + 1));
  return { mean, low: clamp(mean - 1.64 * sd, 0.05, mean), high: clamp(mean + 1.64 * sd, mean, 0.999), flights };
}

function fallbackCraftReliability(sc) {
  const mean = clamp(sc?.estimatedReliability ?? 0.96, 0.3, 0.999);
  const w = (1 - mean) * 0.7 + 0.01;
  return { mean, low: clamp(mean - w, 0.05, mean), high: clamp(mean + w * 0.6, mean, 0.999) };
}

function relOf(r, fb) {
  if (!r || !Number.isFinite(r.mean)) return fb;
  return { mean: r.mean, low: Number.isFinite(r.low) ? r.low : fb.low, high: Number.isFinite(r.high) ? r.high : fb.high, flights: r.flights ?? fb.flights };
}

/** Destination capacity key for a vehicle. */
export function capacityFor(data, vehicle, dest) {
  if (!vehicle || !dest) return 0;
  const v = safe(calendar.capacityTo, [data, vehicle.id, dest.id], null);
  if (Number.isFinite(v)) return v;
  return (vehicle.capacity?.[dest.capacityKey || 'leo'] ?? 0) * (Number.isFinite(dest.capacityFactor) ? dest.capacityFactor : 1);
}

/** Ascent milestone ids for a destination. */
export function ascentIds(dest) {
  const ids = ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit'];
  const key = dest?.capacityKey;
  if (key === 'tli' || key === 'mars' || key === 'outer' || (dest && dest.body && dest.body !== 'earth')) ids.push('tli');
  return ids;
}

export function ascentLabel(id, { crewed, dest } = {}) {
  switch (id) {
    case 'ignition': return 'Ignição';
    case 'liftoff': return 'Decolagem';
    case 'maxq': return 'Max-Q';
    case 'staging': return 'Separação de estágio';
    case 'fairing_or_les': return crewed ? 'Descarte da torre de escape' : 'Separação da coifa';
    case 'orbit': return 'Inserção orbital';
    case 'tli': return dest?.body === 'moon' || dest?.capacityKey === 'tli' ? 'Injeção translunar' : 'Injeção interplanetária';
    default: return id;
  }
}

/** Normalize data.destinations[].arrivalMilestones entries (string or object). */
export function arrivalDefs(dest, { crewed = true } = {}) {
  const list = (Array.isArray(dest?.arrivalMilestones) ? dest.arrivalMilestones : []).filter((m) => crewed || !m?.crewOnly && !m?.crewedOnly);
  return list.map((m, i) => {
    const def = typeof m === 'string' ? { id: m } : m || {};
    const id = def.id || `arrival_${i}`;
    const d = arrivalDefaults(id + ' ' + (def.kind || ''));
    return {
      id,
      label: def.label || def.name || id,
      t: Number.isFinite(def.t) ? def.t : 8 + i * 16,
      share: def.share ?? def.weight ?? d.share,
      env: def.env ?? d.env,
      failureWeights: { ...d.weights, ...(def.failureWeights || {}) },
      extraFail: Number.isFinite(def.pFail) ? def.pFail : 0,
      explicit: Number.isFinite(def.pFail),
      anomalyBand: Number.isFinite(def.anomalyBand) ? def.anomalyBand : null,
      radio: Array.isArray(def.radio) ? def.radio : null,
    };
  });
}

function normWeights(w) {
  const out = {};
  let tot = 0;
  for (const k of Object.keys(DEFAULT_FAILURE_WEIGHTS)) tot += Math.max(0, w[k] || 0);
  for (const k of Object.keys(DEFAULT_FAILURE_WEIGHTS)) out[k] = r3(tot > 0 ? Math.max(0, w[k] || 0) / tot : DEFAULT_FAILURE_WEIGHTS[k]);
  return out;
}

/** Convert an additive probability bonus into a hazard multiplier (bounded). */
function deltaMult(hTotal, delta, lo = 0.45, hi = 2.5) {
  if (!delta || hTotal <= 0) return 1;
  const f = 1 - P(hTotal);
  const f2 = clamp(f - delta, f * 0.5, 0.95);
  return clamp(H(1 - f2) / hTotal, lo, hi);
}

function tensionWith(state, a, b) {
  if (!a || !b || a === b) return 0;
  const t = safe(politics.tensionBetween, [state, a, b], null);
  if (Number.isFinite(t)) return t;
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  return state?.tension?.[k] ?? 0;
}

/** Fallback crew modifier from raw people when crew.crewModifier is missing. */
function fallbackCrew(state, sel) {
  const factors = [];
  let delta = 0;
  let band = 0;
  const fd = sel?.flightDirector ? state?.crew?.[sel.flightDirector] : null;
  const cmd = sel?.commander ? state?.crew?.[sel.commander] : null;
  if (fd) {
    const d = ((fd.skill ?? 50) - 50) / 1500;
    delta += d;
    band += (fd.skill ?? 50) / 300;
    factors.push({ label: `Diretor de voo: ${fd.name || 'sem nome'}`, delta: r3(d) });
  }
  if (cmd) {
    const d = ((cmd.skill ?? 50) - 50) / 2000;
    delta += d;
    factors.push({ label: `Comandante: ${cmd.name || 'sem nome'}`, delta: r3(d) });
  }
  return { delta, band, factors };
}

// ---------- main ----------

/**
 * plan = {actorId, type, destination, vehicleId, spacecraftId, crew, config, launchTurn, createdTurn?, weather?, crewed?}
 * Returns { p, low, high, factors, milestones, warnings, valid, errors, + extras (pAscent, pArrival, payload, prestigeMult...) }.
 */
// The destination difficulty already prices the descent; a separate lander/capsule adds half its own hazard.
const COMPANION_WEIGHT = 0.5;

/** Same crewed rule as missionRisk (used before the full computation). */
function crewedPlan(plan, sc) {
  const c = plan.crew || {};
  const n = Array.isArray(c.astronauts) ? c.astronauts.filter(Boolean).length : 0;
  return !!(plan.crewed || plan.type === 'crewed' || (sc?.crew > 0 && (n > 0 || c.commander)));
}

export function missionRisk(state, data, plan = {}) {
  const errors = [];
  const warnings = [];
  const factors = [];
  const actorId = plan.actorId || state?.playerId;
  const actor = state?.actors?.[actorId] || null;
  const vehicle = lookup(data, 'vehicles', plan.vehicleId);
  const sc = lookup(data, 'spacecraft', plan.spacecraftId);
  const dest = lookup(data, 'destinations', plan.destination);
  const cfg = plan.config || {};
  const crewSel = plan.crew || {};
  const type = plan.type || (sc?.crew > 0 ? 'crewed' : 'satellite');
  const astronauts = Array.isArray(crewSel.astronauts) ? crewSel.astronauts.filter(Boolean) : [];
  const crewed = !!(plan.crewed || type === 'crewed' || (sc?.crew > 0 && (astronauts.length > 0 || crewSel.commander)));
  const launchTurn = Number.isFinite(plan.launchTurn) ? plan.launchTurn : state?.turn ?? 0;
  const startYear = state?.startYear ?? data?.scenario?.startYear ?? 2026;

  if (!vehicle) errors.push('Escolha um veículo válido.');
  if (!dest) errors.push('Escolha um destino válido.');
  if (plan.spacecraftId && !sc) errors.push('Espaçonave desconhecida.');
  // companion craft launched separately (crewed lander for Orion, Mengzhou for Lanyue): plan.secondarySpacecraftId
  const sc2 = plan.secondarySpacecraftId ? lookup(data, 'spacecraft', plan.secondarySpacecraftId) : null;
  if (plan.secondarySpacecraftId && !sc2) errors.push('Módulo de apoio desconhecido.');

  // --- validation: availability, compatibility, crew, payload ---
  const availErr = (item, what) => {
    const from = item?.availableFrom;
    if (from?.year) {
      const t = dateToTurn(from.year, clamp((from.month ?? 1) - 1, 0, 11), startYear);
      if (launchTurn < t) errors.push(`${what} só fica disponível em ${formatTurn(t, startYear)}.`);
    }
    const until = item?.availableUntil;
    if (until?.year) {
      const t = dateToTurn(until.year, clamp((until.month ?? 12) - 1, 0, 11), startYear);
      if (launchTurn > t) errors.push(`${what} foi aposentado em ${formatTurn(t, startYear)}.`);
    }
  };
  if (vehicle) availErr(vehicle, vehicle.name || vehicle.id);
  if (sc) availErr(sc, sc.name || sc.id);
  if (sc2) availErr(sc2, sc2.name || sc2.id);
  if (crewedPlan(plan, sc) && sc && dest && Array.isArray(sc.landerRequired) && sc.landerRequired.includes(dest.id) && !(sc2 && sc2.kind === 'lander' && sc2.crew > 0)) {
    errors.push(`${sc.name || sc.id} precisa de um módulo de pouso tripulado para ${dest.name || dest.id}.`);
  }

  if (sc && dest && Array.isArray(sc.destinations) && sc.destinations.length && !sc.destinations.includes(dest.id)) {
    errors.push(`${sc.name || sc.id} não foi feita para ${dest.name || dest.id}.`);
  }
  if (sc && vehicle && Array.isArray(sc.compatibleVehicles) && sc.compatibleVehicles.length && !sc.compatibleVehicles.includes(vehicle.id)) {
    errors.push(`${sc.name || sc.id} não voa no ${vehicle.name || vehicle.id}.`);
  }
  if (crewed) {
    if (vehicle && !vehicle.crewRated) errors.push(`${vehicle.name || vehicle.id} não é certificado para tripulação.`);
    if (!sc) errors.push('Missão tripulada precisa de uma cápsula.');
    else if (!(sc.crew > 0) || !['capsule', 'lander'].includes(sc.kind)) errors.push(`${sc.name || sc.id} não leva tripulação.`);
    else if (astronauts.length > sc.crew) errors.push(`${sc.name || sc.id} leva no máximo ${sc.crew} tripulantes.`);
    if (!crewSel.commander) warnings.push('Sem comandante escalado.');
  } else if (type === 'crewed') {
    errors.push('Missão tripulada sem tripulação.');
  }

  const capacityT = vehicle && dest ? capacityFor(data, vehicle, dest) : 0;
  const payloadBonus = safe(research.techBonus, [state, actorId, 'payload'], 0);
  const margin = clamp(Number.isFinite(cfg.fuelMargin) ? cfg.fuelMargin : 0.1, 0, 0.3);
  const effectiveT = capacityT * (1 + payloadBonus) * (1 - margin); // same rule as missions.effectiveCapacity
  const payloadT = Number.isFinite(cfg.payloadT) && cfg.payloadT > 0 ? cfg.payloadT : sc?.massT ?? 0;
  if (vehicle && dest && capacityT <= 0) errors.push(`${vehicle.name || vehicle.id} não alcança ${dest.name || dest.id}.`);
  else if (vehicle && dest && payloadT > effectiveT + 1e-9) {
    errors.push(`Carga de ${fmtT(payloadT)} excede a capacidade de ${fmtT(effectiveT)} com essa margem.`);
  }

  // --- base hazards: vehicle (ascent), spacecraft, destination ---
  const relV = vehicle ? relOf(safe(calendar.vehicleReliability, [state, data, vehicle.id], null), fallbackVehicleReliability(state, vehicle)) : { mean: 0.9, low: 0.8, high: 0.95, flights: 0 };
  const relS = sc ? relOf(safe(calendar.spacecraftReliability, [state, data, sc.id], null), fallbackCraftReliability(sc)) : { mean: 0.995, low: 0.98, high: 0.999 };
  const arrPre = arrivalDefs(dest, { crewed });
  const explicitArrival = arrPre.length > 0 && arrPre.every((m) => m.explicit);
  const destFail = explicitArrival ? 0 : destBaseFail(dest);
  const relS2 = sc2 ? relOf(safe(calendar.spacecraftReliability, [state, data, sc2.id], null), fallbackCraftReliability(sc2)) : null;
  const seg = { asc: H(relV.mean), craft: H(relS.mean), dest: H(1 - destFail) + (relS2 ? COMPANION_WEIGHT * H(relS2.mean) : 0), arr: explicitArrival ? arrPre.reduce((h, m) => h + H(1 - m.extraFail), 0) : 0 };
  const baseP = P(seg.asc + seg.craft + seg.dest);
  factors.push({ label: `Confiabilidade do ${vehicle?.name || 'veículo'} (${relV.flights ?? 0} voos)`, delta: r3(relV.mean - 1), kind: 'part' });
  if (sc) factors.push({ label: `Confiabilidade da ${sc.name || sc.id}`, delta: r3(relS.mean - 1), kind: 'part' });
  if (relS2) factors.push({ label: `Confiabilidade do módulo ${sc2.name || sc2.id}`, delta: r3(P(COMPANION_WEIGHT * H(relS2.mean)) - 1), kind: 'part' });
  if (seg.dest + seg.arr > 0) factors.push({ label: `Dificuldade do destino: ${dest?.name || dest?.id}`, delta: r3(P(seg.dest + seg.arr) - 1), kind: 'environment' });

  const total = () => seg.asc + seg.craft + seg.dest + seg.arr;
  const ALL = ['asc', 'craft', 'dest', 'arr'];
  // Multiply some segments, record the change in p as a factor.
  const apply = (label, mult, keys = ALL, kind = 'decision') => {
    if (!Number.isFinite(mult) || Math.abs(mult - 1) < 1e-9) return;
    const before = P(total());
    for (const k of keys) seg[k] *= mult;
    const d = P(total()) - before;
    if (Math.abs(d) >= 0.0005) factors.push({ label, delta: r3(d), kind });
  };
  const applyDelta = (label, delta, keys, kind) => {
    if (!delta) return;
    const h = keys.reduce((s, k) => s + seg[k], 0);
    apply(label, deltaMult(h, delta), keys, kind);
  };

  // tech (research)
  applyDelta('Pesquisa: confiabilidade', safe(research.techBonus, [state, actorId, 'reliability'], 0), ['asc', 'craft'], 'part');
  if (seg.dest + seg.arr > 0) applyDelta('Pesquisa: pouso e chegada', safe(research.techBonus, [state, actorId, 'landingReliability'], 0), ['dest', 'arr'], 'part');

  // crew
  const cmReal = safe(crew.crewModifier, [state, data, crewSel, { destination: dest?.id }], null);
  const cm = cmReal && Number.isFinite(cmReal.delta) ? cmReal : fallbackCrew(state, crewSel);
  if (cm.delta) applyDelta('Equipe escalada', cm.delta, ALL, 'crew');
  if (!crewSel.flightDirector) {
    if (!cmReal) apply('Sem diretor de voo', 1.08, ALL, 'crew');
    warnings.push('Sem diretor de voo: menos pontos de Comando e faixa mais larga.');
  }
  if (crewed && !crewSel.commander) apply('Sem comandante', 1.1, ['craft', 'dest', 'arr'], 'crew');

  // culture: bold agencies run hotter, cautious ones double-check
  const culture = clamp(actor?.culture ?? 0, -100, 100);
  if (Math.abs(culture) >= 10) apply(culture > 0 ? 'Cultura ousada da agência' : 'Cultura cautelosa da agência', 1 + (culture / 100) * 0.1, undefined, 'decision');

  // strategy
  const strat = STRATEGIES[cfg.strategy] || STRATEGIES.balanced;
  apply(strat.label, strat.hazard, undefined, 'decision');

  // fuel margin: more margin = safer, less payload
  apply(margin >= 0.1 ? `Margem de combustível de ${pct(margin)}` : `Margem de combustível curta (${pct(margin)})`, 1.15 - margin * 1.5, ALL, 'decision');
  if (effectiveT > 0 && payloadT > effectiveT * 0.92 && payloadT <= effectiveT) {
    apply('Carga no limite da capacidade', 1.12, ['asc'], 'decision');
    warnings.push('Carga perto do limite: pouca folga para imprevistos.');
  }

  // rushing: launch soon after the mission was created
  if (Number.isFinite(plan.createdTurn) && Number.isFinite(plan.launchTurn)) {
    const prep = plan.launchTurn - plan.createdTurn;
    const need = PREP_WEEKS[type] ?? 10;
    if (prep < need) {
      apply(`Prazo apertado (${Math.max(0, prep)} de ${need} semanas)`, 1 + 0.5 * (1 - Math.max(0, prep) / need), undefined, 'decision');
      warnings.push('Preparação curta: a equipe vai trabalhar sob pressão.');
    }
  }

  // politics: global tension (pressure, scrutiny) and access to a foreign launcher
  const gt = clamp(state?.world?.globalTension ?? 0, 0, 4);
  if (gt > 0) apply('Tensão política mundial', 1 + 0.03 * gt, undefined, 'environment');
  const op = vehicle?.operator;
  const tOp = tensionWith(state, actorId, op);
  if (tOp >= 3) errors.push(`Acesso ao ${vehicle?.name || 'veículo'} bloqueado pela crise com ${state?.actors?.[op]?.short || op}.`);
  else if (tOp >= 2) {
    apply('Sanções atrasam peças do lançador', 1.1, ['asc'], 'environment');
    warnings.push('Crise com o operador do lançador: peças e suporte atrasam.');
  }

  // weather (known on launch day; otherwise expected average)
  const weatherRisk = clamp(plan.weather?.risk ?? EXPECTED_WEATHER_RISK, 0, 1);

  // --- milestones ---
  const ids = vehicle ? ascentIds(dest) : ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit'];
  const arr = arrPre;
  const shareSum = ids.reduce((s, id) => s + ASCENT_SHARES[id], 0);
  const lastAsc = ids[ids.length - 1];
  const arrShare = arr.reduce((s, m) => s + m.share, 0) || 1;
  // spacecraft reliability covers its whole life; on launch day only part of it is at stake
  const craftToAscent = arr.length ? 0.25 : 0.6;
  const milestones = [];

  for (const id of ids) {
    let h = (seg.asc * ASCENT_SHARES[id]) / shareSum;
    if (id === lastAsc) h += seg.craft * craftToAscent; // spacecraft checkout/deploy rides on the last ascent step
    if (!arr.length && id === lastAsc) h += seg.dest;
    h += WEATHER_FAIL * weatherRisk * (ENV_SENSITIVITY[id] ?? 0);
    const w = { ...ASCENT_WEIGHTS[id] };
    w.environment += weatherRisk * (ENV_SENSITIVITY[id] ?? 0) * 0.4;
    milestones.push(makeMs(id, ascentLabel(id, { crewed, dest }), ASCENT_T[id], h, w, 'ascent', crewed));
  }
  for (const m of arr) {
    // own data risk (scaled by all modifiers via seg.arr) + share of spacecraft/destination hazard
    const own = explicitArrival ? (seg.arr * H(1 - m.extraFail)) / (arrPre.reduce((s2, x) => s2 + H(1 - x.extraFail), 0) || 1) : H(1 - m.extraFail);
    let h = (seg.craft * (1 - craftToAscent) + seg.dest) * (m.share / arrShare) + own;
    // space weather is milder than launch weather
    h += WEATHER_FAIL * 0.5 * weatherRisk * m.env;
    const w = { ...m.failureWeights };
    w.environment = (w.environment || 0) + weatherRisk * m.env * 0.3;
    const ms = makeMs(m.id, m.label, m.t, h, w, 'arrival', crewed);
    if (m.anomalyBand != null) ms.anomalyBand = r3(clamp(Math.max(m.anomalyBand, ms.pFail * 1.2), 0.02, 0.3));
    if (m.radio) ms.radio = m.radio;
    milestones.push(ms);
  }
  // nudge failure types toward 'human' with a weak or missing crew
  if (!crewSel.flightDirector || cm.delta < 0) for (const m of milestones) m.failureWeights = normWeights({ ...m.failureWeights, human: m.failureWeights.human + 0.08 });

  const hAsc = milestones.filter((m) => m.phase === 'ascent').reduce((s, m) => s + H(1 - m.pFail), 0);
  const hArr = milestones.filter((m) => m.phase === 'arrival').reduce((s, m) => s + H(1 - m.pFail), 0);
  const p = P(hAsc + hArr);
  if (weatherRisk !== EXPECTED_WEATHER_RISK || plan.weather) {
    factors.push({ label: plan.weather?.label ? `Clima: ${plan.weather.label}` : 'Clima', delta: r3(p - P(hAsc + hArr - weatherHazard(milestones, weatherRisk))), kind: 'environment' });
  }

  // --- uncertainty band ---
  // spacecraft uncertainty only partly matters on the day (same idea as craftToAscent)
  let w = (relV.high - relV.low) / 2 + ((relS.high - relS.low) / 2) * (arr.length ? 0.6 : 0.4) + (1 - P(seg.dest + seg.arr)) * 0.35 + 0.01;
  const chanceBand = safe(research.techBonus, [state, actorId, 'chanceBand'], 0);
  const narrowing = clamp((cm.band || 0) + chanceBand, -0.4, 0.7);
  w *= 1 - narrowing;
  if (!crewSel.flightDirector) w *= 1.25;
  w = clamp(w, 0.008, 0.3);
  const low = clamp(p - w, 0.01, p);
  const high = clamp(p + w * 0.7, p, 0.995);

  for (const f of cm.factors || []) factors.push({ label: f.label, delta: r3(f.delta || 0), kind: 'crew', info: true });

  return {
    p: r3(p),
    low: r3(low),
    high: r3(high),
    factors,
    milestones,
    warnings,
    valid: errors.length === 0,
    errors,
    // extras (not in the minimum contract, safe to ignore)
    baseP: r3(baseP),
    pAscent: r3(P(hAsc)),
    pArrival: r3(P(hArr)),
    crewed,
    payload: { payloadT: r3(payloadT), capacityT: r3(capacityT), effectiveT: r3(effectiveT) },
    prestigeMult: strat.prestige,
    scienceMult: strat.science,
    vehicleFlights: relV.flights ?? 0,
    weatherRisk,
  };
}

function weatherHazard(ms, risk) {
  let h = 0;
  for (const m of ms) h += m.phase === 'ascent' ? WEATHER_FAIL * risk * (ENV_SENSITIVITY[m.id] ?? 0) : 0;
  return h;
}

function makeMs(id, label, t, h, weights, phase, crewed) {
  const pFail = clamp(1 - P(h), 0.0002, 0.9);
  // anomaly band: scary-but-survivable zone right above the failure threshold
  const anomalyBand = r3(clamp(0.03 + pFail * 1.6, 0.03, 0.3));
  return { id, label, t, pFail: Math.round(pFail * 100000) / 100000, anomalyBand, failureWeights: normWeights(weights), phase, crewed: !!crewed };
}

function fmtT(t) {
  return `${(Math.round(t * 10) / 10).toString().replace('.', ',')} t`;
}

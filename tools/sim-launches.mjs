// Batch launch simulator (GDD Turno 2): N scenes per vehicle, to LEO and to its best far destination.
// Runs the real launch state machine (src/sim/launch.js) with an automatic policy and prints success rates
// and the failure-type distribution, plus the calibration of the chance shown (est, read when the countdown is
// over, right before the first milestone) against the real rate (ok = total + partial), per phase.
// The shown chance assumes the flight director's standard play (risk.standardChoice = policy 'smart').
// Usage: node tools/sim-launches.mjs [N=10000] [policy=smart|maintain|bot]
import { loadDataNode } from '../src/core/data.js';
import { newGame } from '../src/core/engine.js';
import { openScene, actions } from '../src/sim/launch.js';
import { missionRisk, capacityFor, lookup, standardChoice } from '../src/sim/risk.js';
import { FAILURE_TYPES, FAILURE_LABELS } from '../src/core/outcome.js';
import { dateToTurn } from '../src/core/time.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const POLICIES = {
  maintain: { choose: () => 'maintain', hold: () => 'go' },
  // the flight director's standard play (what the shown chance assumes); holds on bad weather
  smart: {
    choose: (pi, al) => standardChoice(pi.hint, al.commandPoints, !!al.lineup.flightDirector, al.crewed),
    hold: (h) => (h.reason === 'weather' ? 'hold' : 'go'),
  },
  // the campaign bot (tools/sim-campaign.mjs): spends Command on every card
  bot: {
    choose: (pi) => { const o = pi.options.filter((x) => !x.disabled); return (o.find((x) => x.id === 'contingency') || o.find((x) => x.id === 'reduce') || o.find((x) => x.id === 'maintain') || o[0]).id; },
    hold: (h, al) => ((al.weather?.risk ?? 0) > 0.03 ? 'hold' : 'go'),
  },
};

/** Drive one opened scene; returns {outcome, shown: {p, pCrewLoss}} with the estimate read before the first milestone. */
export function playScene(state, data, policy) {
  let shown = null;
  let guard = 0;
  while (state.activeLaunch && guard++ < 100) {
    const al = state.activeLaunch;
    let r;
    if (al.act === 'prelaunch') r = actions['launch/countdown'](state, data, {});
    else if (al.pendingHold) r = actions['launch/hold'](state, data, { choice: policy.hold(al.pendingHold, al) });
    else if (al.pendingIntervention) {
      let id = policy.choose(al.pendingIntervention, al);
      const o = al.pendingIntervention.options.find((x) => x.id === id);
      if (!o || o.disabled) id = 'maintain';
      r = actions['launch/choose'](state, data, { optionId: id });
    } else if (al.act === 'result') return { outcome: al.outcome, shown };
    else {
      if (!shown) shown = { p: al.estimate.p, pCrewLoss: al.estimate.pCrewLoss || 0 };
      r = actions['launch/step'](state, data, {});
    }
    if (r && r.scrubbed) return { outcome: { scrubbed: true }, shown };
    if (r && r.ok === false) throw new Error(r.error);
  }
  return { outcome: state.activeLaunch?.outcome || null, shown };
}

const FAR_ORDER = { outer: 4, mars: 3, tli: 2, gto: 1, leo: 0 };

/** A game state with the player's best flight director/commander, used as sim harness. */
export function harness(data, playerId = 'nasa', seed = 1) {
  const state = newGame(data, { seed, playerId });
  state.decisions = [];
  const people = Object.values(state.crew || {}).filter((p) => p.actorId === playerId && (!p.status || p.status === 'active'));
  const best = (role) => people.filter((p) => p.role === role).sort((a, b) => b.skill - a.skill)[0]?.id || null;
  return { state, data, fd: best('flight_director'), cmd: best('astronaut') };
}

/** Run n scenes of one mission/phase. Returns {n, p, rates, types, interventions, scrubs}. */
export function runMany(data, h, mission, phase, n, policy = POLICIES.maintain, seed0 = 1) {
  const { state } = h;
  const levels = { total: 0, partial: 0, recoverable: 0, catastrophic: 0 };
  const types = Object.fromEntries(FAILURE_TYPES.map((t) => [t, 0]));
  let inter = 0;
  let scrubs = 0;
  let pSum = 0;
  let lossSum = 0;
  let deaths = 0;
  state.missions = [mission];
  for (let i = 0; i < n; i++) {
    state.seed = (seed0 * 1000003 + i * 7919) >>> 0;
    state.activeLaunch = null;
    // every run is an independent scene: start from a full Command pool (the campaign pool is tested by sim-campaign)
    state.commandPoints = null;
    const al = openScene(state, data, mission.id, phase);
    if (!al) throw new Error('scene not opened');
    const { outcome: out, shown } = playScene(state, data, policy);
    if (!out || out.scrubbed) { scrubs++; continue; }
    pSum += shown.p;
    lossSum += shown.pCrewLoss;
    levels[out.level]++;
    if (out.failureType) types[out.failureType]++;
    if (out.crewLost?.length) deaths++;
    inter += state.activeLaunch?.interventions?.length || 0;
    state.activeLaunch = null;
  }
  const flown = n - scrubs || 1;
  return { n, flown, p: pSum / flown, pCrewLoss: lossSum / flown, levels, types, interventions: inter / flown, scrubs, deaths };
}

/** Earliest turn when both vehicle and spacecraft are available (launch day used by the sim). */
function availTurn(h, ...ids) {
  const d = h.data;
  let t = 0;
  for (const id of ids) {
    const x = d?.index?.vehicles?.[id] || d?.index?.spacecraft?.[id];
    if (x?.availableFrom?.year) t = Math.max(t, dateToTurn(x.availableFrom.year, Math.max(0, (x.availableFrom.month ?? 1) - 1), h.state.startYear));
  }
  return t;
}

function missionFor(id, type, vehicleId, spacecraftId, destination, payloadT, h, crewed = false) {
  return {
    id, name: 'Simulação', type, destination, vehicleId, spacecraftId, crewed,
    crew: { flightDirector: h.fd, commander: crewed ? h.cmd : null, astronauts: crewed && h.cmd ? [h.cmd] : [] },
    config: { strategy: 'balanced', fuelMargin: 0.1, payloadT }, status: 'launch', createdTurn: availTurn(h, vehicleId, spacecraftId) - 52, launchTurn: availTurn(h, vehicleId, spacecraftId), attempts: 0,
  };
}

const pct = (x) => `${(x * 100).toFixed(1).padStart(5)}%`;

function row(label, r) {
  const ok = (r.levels.total + r.levels.partial) / r.flown;
  const types = FAILURE_TYPES.map((t) => r.types[t]);
  const tf = types.reduce((a, b) => a + b, 0) || 1;
  return `${label.padEnd(44)} est ${pct(r.p)} | total ${pct(r.levels.total / r.flown)} ok ${pct(ok)} | parc ${pct(r.levels.partial / r.flown)} rec ${pct(r.levels.recoverable / r.flown)} cat ${pct(r.levels.catastrophic / r.flown)} | int ${r.interventions.toFixed(2)} | ${types.map((v, i) => `${FAILURE_TYPES[i].slice(0, 4)} ${Math.round((v / tf) * 100)}%`).join(' ')}`;
}

function pickCraft(data, v, dest, crewed, cap) {
  const list = data.spacecraft.spacecraft.filter((s) => (s.destinations || []).includes(dest.id) && (crewed ? s.crew > 0 && ['capsule', 'lander'].includes(s.kind) : !(s.crew > 0)));
  const fits = list.filter((s) => (s.massT || 0) <= cap && (!Array.isArray(s.compatibleVehicles) || !s.compatibleVehicles.length || s.compatibleVehicles.includes(v.id)));
  fits.sort((a, b) => (a.id.startsWith('generic') ? -1 : 0) - (b.id.startsWith('generic') ? -1 : 0) || (a.massT || 0) - (b.massT || 0));
  return fits[0] || null;
}

async function main() {
  const data = await loadDataNode(root);
  const N = Number(process.argv[2] || 10000);
  const policyName = POLICIES[process.argv[3]] ? process.argv[3] : 'smart';
  const policy = POLICIES[policyName];
  // calibration: shown chance (est) vs real rate (ok), per phase
  const cal = {};
  const calAdd = (key, r) => {
    const ok = (r.levels.total + r.levels.partial) / r.flown;
    const c = (cal[key] ||= { rows: 0, shown: 0, real: 0, abs: 0, worst: 0, se: 0 });
    c.rows++; c.shown += r.p; c.real += ok; c.abs += Math.abs(ok - r.p);
    c.se += Math.sqrt(Math.max(ok * (1 - ok), 1e-6) / r.flown);
    if (Math.abs(ok - r.p) > Math.abs(c.worst)) c.worst = ok - r.p;
  };
  const h = harness(data);
  const hcache = {};
  const harnessFor = (data, h0, op) => (h0.state.actors[op] && op !== h0.state.playerId ? (hcache[op] = hcache[op] || harness(data, op)) : h0);
  const t0 = performance.now();
  console.log(`Ad Astra · ${N} lançamentos por linha · política ${policyName} · FD ${h.state.crew?.[h.fd]?.name || 'nenhum'}`);
  console.log('est = chance mostrada na cena (média, lida antes do 1º marco) | ok = total+parcial (real) | int = intervenções por cena | tipos de falha\n');
  const leo = lookup(data, 'destinations', 'leo');
  const dests = data.destinations.destinations.filter((d) => (d.arrivalMilestones || []).length);
  const typeTotals = Object.fromEntries(FAILURE_TYPES.map((t) => [t, 0]));
  for (const v of data.vehicles.vehicles) {
    const capLeo = capacityFor(data, v, leo);
    if (capLeo > 0) {
      const m = missionFor('sim_leo', 'satellite', v.id, 'generic_sat', 'leo', Math.min(3, capLeo * 0.5), h);
      const r = runMany(data, h, m, 'ascent', N, policy);
      for (const t of FAILURE_TYPES) typeTotals[t] += r.types[t];
      calAdd('subida', r);
      console.log(row(`${v.name} → LEO`, r));
    }
    // best far destination: farthest capacity key with a compatible uncrewed spacecraft
    let best = null;
    for (const d of dests) {
      const cap = capacityFor(data, v, d) * 0.95;
      if (cap <= 0) continue;
      const sc = pickCraft(data, v, d, false, cap);
      if (!sc) continue;
      const score = (FAR_ORDER[d.capacityKey] ?? 0) * 10 + (d.kind === 'surface' ? 1 : 0);
      if (!best || score > best.score) best = { d, sc, score };
    }
    if (best) {
      const type = best.d.kind === 'surface' ? 'lander' : 'probe';
      const m = missionFor('sim_far', type, v.id, best.sc.id, best.d.id, best.sc.massT, h);
      const a = runMany(data, h, m, 'ascent', N, policy);
      const b = runMany(data, h, m, 'arrival', N, policy);
      const okA = (a.levels.total + a.levels.partial) / a.flown;
      const okB = (b.levels.total + b.levels.partial) / b.flown;
      for (const t of FAILURE_TYPES) typeTotals[t] += a.types[t] + b.types[t];
      calAdd('subida', a);
      calAdd('chegada', b);
      console.log(row(`  ${v.name} → ${best.d.short || best.d.id} (${best.sc.id}) subida`, a));
      console.log(row(`  ${v.name} → ${best.d.short || best.d.id} chegada`, b) + ` | missão completa ~ ${pct(okA * okB)}`);
    }
  }
  // crewed reference flights
  console.log('\nVoos tripulados de referência (plano = chance no montador; cena = mostrada no dia; real = sorteios):');
  const crewCal = { shown: 0, real: 0, rows: 0 };
  const crewedCases = [];
  for (const v of data.vehicles.vehicles.filter((x) => x.crewRated)) {
    for (const destId of ['leo', 'iss', 'lunar_orbit', 'lunar_surface']) {
      const d = lookup(data, 'destinations', destId);
      const cap = capacityFor(data, v, d) * 0.95;
      const sc = d && cap > 0 ? pickCraft(data, v, d, true, cap / 0.95) : null;
      if (sc) crewedCases.push({ v, d, sc });
    }
  }
  for (const c of crewedCases) {
    const hc = harnessFor(data, h, c.v.operator);
    for (const strategy of c.d.id === 'lunar_surface' ? ['conservative', 'balanced', 'aggressive'] : ['balanced']) {
      const m = missionFor('sim_crew', 'crewed', c.v.id, c.sc.id, c.d.id, c.sc.massT, hc, true);
      m.config.strategy = strategy;
      let est = null;
      for (const fm of [0.1, 0.05, 0.02, 0]) {
        m.config.fuelMargin = fm;
        est = missionRisk(hc.state, data, { ...m, actorId: hc.state.playerId });
        if (est.valid) break;
      }
      if (!est.valid) continue;
      const a = runMany(data, hc, m, 'ascent', N, policy);
      const hasArr = (c.d.arrivalMilestones || []).length > 0;
      const b = hasArr ? runMany(data, hc, m, 'arrival', N, policy) : null;
      const okA = (a.levels.total + a.levels.partial) / a.flown;
      const okB = b ? (b.levels.total + b.levels.partial) / b.flown : 1;
      calAdd('subida tripulada', a);
      if (b) calAdd('chegada tripulada', b);
      const deaths = a.deaths / a.flown + (b ? okA * (b.deaths / b.flown) : 0);
      const shownLoss = a.pCrewLoss + (b ? a.p * b.pCrewLoss : 0);
      crewCal.shown += shownLoss; crewCal.real += deaths; crewCal.rows++;
      console.log(`${`${c.v.name} + ${c.sc.name} → ${c.d.short || c.d.id} [${strategy}, margem ${Math.round(m.config.fuelMargin * 100)}%]`.padEnd(66)} plano ${pct(est.p)} | cena ${pct(a.p * (b ? b.p : 1))} real ${pct(okA * okB)} | perda da tripulação: mostrada ${pct(shownLoss)} real ${pct(deaths)} | int ${a.interventions.toFixed(2)}`);
    }
  }
  console.log(`\nCalibração (política ${policyName}): chance mostrada × real (ok), média por linha`);
  for (const [k, c] of Object.entries(cal)) {
    console.log(`  ${k.padEnd(18)} linhas ${String(c.rows).padStart(3)} | mostrada ${pct(c.shown / c.rows)} real ${pct(c.real / c.rows)} | erro médio |Δ| ${((c.abs / c.rows) * 100).toFixed(2)} p.p. (ruído ~${((c.se / c.rows) * 100).toFixed(2)}) | pior ${(c.worst * 100).toFixed(1)} p.p.`);
  }
  if (crewCal.rows) console.log(`  perda de tripulação  mostrada ${pct(crewCal.shown / crewCal.rows)} real ${pct(crewCal.real / crewCal.rows)} (média de ${crewCal.rows} voos de referência)`);
  const tt = Object.values(typeTotals).reduce((a, b) => a + b, 0) || 1;
  console.log(`\nDistribuição geral dos tipos de falha: ${FAILURE_TYPES.map((t) => `${FAILURE_LABELS[t]} ${Math.round((typeTotals[t] / tt) * 100)}%`).join(' · ')}`);
  console.log(`Tempo: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

// Missions module [missions]: the player's mission lifecycle.
//   briefing → planning → scheduled → launch → (transit → arrival) → operations → done | cancelled
// Also: contract offers + auctions against rival AIs, opportunity briefings, the 3-step builder
// (query 'missions/draftOptions') and the impact of each result (prestige, "Os Primeiros", science,
// support/reputation, news, signals). Pure JS, deterministic, JSON state. Player text in pt-BR.
//
// Slices owned: state.missions, state.contracts. Player-owned calendar instances (status 'player')
// are conducted here (briefing, delay, cancel, final status), as ARCHITECTURE.md specifies.

import * as risk from './risk.js';
import * as budget from './budget.js';
import * as calendar from './calendar.js';
import * as crewMod from './crew.js';
import * as research from './research.js';
import * as narrative from './narrative.js';
import * as diplomacy from './diplomacy.js';
import { clamp, nextId, addNews, pushDecision, emitSignal, claimFirst, firstValue, milestoneShare, changeActor, log, relKey } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import { destPrestige as outcomeDestPrestige, missionPrestige } from '../core/outcome.js';
import { turnToDate, formatTurn, weeksToText } from '../core/time.js';

// ---------------------------------------------------------------------------------------------
// Tunables and vocabularies (generic rules; content names live in data/*.json)
// ---------------------------------------------------------------------------------------------

export const TYPES = ['satellite', 'probe', 'crewed', 'cargo', 'station', 'lander'];
export const TYPE_LABELS = {
  satellite: 'Satélite', probe: 'Sonda', crewed: 'Tripulada', cargo: 'Carga', station: 'Estação', lander: 'Pouso robótico',
};
export const STATUS_LABELS = {
  planning: 'Em planejamento', scheduled: 'Agendada', launch: 'Dia de lançamento', transit: 'Em trânsito',
  arrival: 'Chegada', operations: 'Em operação', done: 'Concluída', cancelled: 'Cancelada',
};
const STRATEGIES = ['conservative', 'balanced', 'aggressive'];
const LEVELS = ['total', 'partial', 'recoverable', 'catastrophic'];
const LEVEL_LABELS = { total: 'sucesso total', partial: 'sucesso parcial', recoverable: 'falha recuperável', catastrophic: 'falha catastrófica' };
const FAILURE_LABELS = { propulsion: 'propulsão', structure: 'estrutura', software: 'software', human: 'fator humano', environment: 'ambiente' };

// Default destination vocabulary per mission type (data may override with destination.missionTypes).
const TYPE_DESTS = {
  satellite: ['leo', 'sso', 'gto', 'cislunar', 'lunar_orbit', 'mars_orbit'],
  probe: ['cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole', 'mars_orbit', 'mars_surface', 'jupiter', 'titan'],
  crewed: ['leo', 'iss', 'cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole', 'mars_orbit', 'mars_surface'],
  cargo: ['leo', 'iss', 'cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole', 'mars_surface'],
  station: ['leo', 'cislunar', 'lunar_orbit', 'lunar_surface', 'lunar_south_pole'],
  lander: ['lunar_surface', 'lunar_south_pole', 'mars_surface', 'titan'],
};
// Spacecraft kinds that can fly each mission type.
const SC_KINDS = {
  satellite: ['satellite'],
  probe: ['probe', 'lander', 'rover', 'satellite'],
  crewed: ['capsule', 'lander'],
  cargo: ['cargo', 'capsule', 'lander'],
  station: ['station_module'],
  lander: ['lander', 'rover', 'probe'],
};
// Difficulty → base prestige: core/outcome.js destPrestige (shared with the AI's calendar results).
const GENERIC_COST_SCALE = { leo: 1, gto: 1.2, tli: 1.6, mars: 2.4, outer: 4 };
const OPS_COST_BY_KEY = { leo: 6, gto: 5, tli: 35, mars: 60, outer: 90 }; // US$ mi, operations + ground segment
const SCIENCE_BASE = { satellite: 6, probe: 40, crewed: 20, cargo: 3, station: 25, lander: 45 };
const SCIENCE_BODY = { earth: 1, moon: 1.5, mars: 2.2, jupiter: 2.8, saturn: 3 };
const OPS_WEEKS = { satellite: 0, probe: 10, crewed: 2, cargo: 1, station: 8, lander: 6 };
const LEAD_WEEKS = { satellite: 6, probe: 10, crewed: 12, cargo: 6, station: 14, lander: 10 };
const LEAD_BY_SOURCE = { calendar: 2, contract: 4 };
const CREW_COST_PER_PERSON = 15; // US$ mi: training, suits, recovery
const CONSERVATIVE_EXTRA_WEEKS = 6; // conservative strategy: extra tests before launch
// fuel margin price: the default 10% is cheap (part of any plan); every point above it costs 1% of the launch
const MARGIN_BASE = 0.1;
// a calendar program's hardware can be ready a little before the official date, never much earlier
const PROGRAM_EARLY_WEEKS = 4;
// prestige multiplier per strategy (same values as risk.STRATEGIES): less risk, less glory
const STRATEGY_PRESTIGE = { conservative: 0.8, balanced: 1, aggressive: 1.25 };
const ACTIVE_STATUSES = ['scheduled', 'launch', 'transit', 'arrival', 'operations'];

// pt-BR labels for the fixed "Os Primeiros" vocabulary.
const MILESTONE_LABELS = {
  crewed_lunar_flyby: 'primeiro sobrevoo lunar tripulado do século',
  crewed_lunar_orbit: 'primeira órbita lunar tripulada do século',
  crewed_lunar_landing: 'primeiro pouso tripulado na Lua do século',
  lunar_south_pole_landing: 'primeiro pouso no polo sul lunar da corrida',
  lunar_surface_robotic: 'primeiro pouso robótico na Lua da corrida',
  lunar_south_pole_crewed: 'primeira tripulação no polo sul lunar',
  lunar_sample_return: 'primeiro retorno de amostras lunares da corrida',
  lunar_resource_demo: 'primeira demonstração de recursos lunares',
  lunar_base: 'primeira base lunar',
  mars_landing_robotic: 'primeiro pouso robótico em Marte da corrida',
  mars_sample_return: 'primeiro retorno de amostras de Marte',
  titan_arrival: 'primeira chegada a Titã do século',
  jupiter_arrival: 'primeira chegada a Júpiter da corrida',
  commercial_station: 'primeira estação comercial',
  national_station: 'primeira estação nacional da corrida',
  crewed_orbit_national: 'primeiro voo orbital tripulado próprio',
};

// Contract templates (generic commercial demand, GDD "Leilões de contratos").
const CONTRACT_KINDS = [
  { kind: 'gto_sat', type: 'satellite', destination: 'gto', clientPayload: true, payload: [3, 6.5], weight: 3,
    title: 'Satélite de comunicações para GTO',
    clients: ['Operadora de telecom do Sudeste Asiático', 'Consórcio europeu de banda larga', 'Operadora latino-americana de TV', 'Rede de satélites do Golfo'],
    body: 'Um satélite geoestacionário precisa de carona até a órbita de transferência. O cliente quer preço, prazo e um foguete confiável.' },
  { kind: 'sso_sat', type: 'satellite', destination: 'sso', clientPayload: true, payload: [0.5, 2.5], weight: 2,
    title: 'Constelação de observação em órbita polar',
    clients: ['Startup de imagens de radar', 'Agência ambiental regional', 'Seguradora agrícola'],
    body: 'Um lote de satélites de observação precisa de lançamento em órbita heliossíncrona.' },
  { kind: 'station_cargo', type: 'cargo', destination: 'iss', payload: [2, 4], weight: 2, untilYear: 2030,
    title: 'Carga para a Estação Espacial',
    clients: ['Programa de reabastecimento da ISS', 'Laboratório farmacêutico em microgravidade'],
    body: 'Experimentos, comida e peças de reposição precisam chegar à estação. Atraso aqui vira manchete.' },
  { kind: 'commercial_cargo', type: 'cargo', destination: 'leo', payload: [2, 5], weight: 1, fromYear: 2028,
    title: 'Carga para estação comercial',
    clients: ['Estação comercial em órbita baixa', 'Operadora de hotel orbital'],
    body: 'A sucessora comercial da ISS precisa de carga regular. Quem entregar agora pode virar fornecedor fixo.' },
  { kind: 'clps', type: 'lander', destination: 'lunar_surface', payload: [0.3, 1.2], weight: 2,
    title: 'Entrega de carga útil na Lua',
    clients: ['Programa de cargas lunares comerciais', 'Universidade com instrumento sísmico', 'Mineradora de olho no regolito'],
    body: 'Instrumentos científicos precisam pousar na superfície lunar. É dinheiro bom e risco alto: pouso lunar ainda falha muito.' },
];

// Opportunity briefings (custom targets). Drafts are completed from the player's catalog.
const OPPORTUNITIES = [
  { sub: 'earth_obs', type: 'satellite', destination: 'sso', grantShare: 0.35,
    title: 'Satélite de observação da Terra', body: 'Um consórcio de clima oferece financiar parte de um satélite de observação em órbita polar. Missão barata, ciência modesta, apoio garantido.' },
  { sub: 'comms', type: 'satellite', destination: 'gto', grantShare: 0.3,
    title: 'Satélite de comunicações nacional', body: 'O ministério das comunicações quer um satélite próprio em órbita geoestacionária e topa dividir a conta.' },
  { sub: 'lunar_orbiter', type: 'probe', destination: 'lunar_orbit', grantShare: 0.2,
    title: 'Orbitador lunar de mapeamento', body: 'Cientistas pedem um orbitador para mapear gelo nas crateras. Os dados valem ouro para quem quer pousar depois.' },
  { sub: 'south_pole_lander', type: 'lander', destination: 'lunar_south_pole', grantShare: 0.15,
    title: 'Pousador robótico no polo sul', body: 'O polo sul é a disputa da década. Um pousador robótico agora garante lugar na corrida e dados sobre o gelo.' },
  { sub: 'lunar_lander', type: 'lander', destination: 'lunar_surface', grantShare: 0.15,
    title: 'Pousador lunar de demonstração', body: 'Engenheiros querem provar a tecnologia de pouso antes das missões grandes. Falhar aqui custa menos que falhar depois.' },
  { sub: 'cislunar_demo', type: 'probe', destination: 'cislunar', grantShare: 0.25,
    title: 'Demonstrador cislunar', body: 'Um teste de navegação no espaço cislunar, perto da futura estação lunar. Barato e útil para o programa.' },
  { sub: 'crewed_demo', type: 'crewed', destination: 'leo', grantShare: 0.1,
    title: 'Voo tripulado de demonstração', body: 'O governo quer astronautas no noticiário. Um voo curto em órbita baixa mantém a tripulação afiada e o público atento.' },
];

// Natural next step after a success ("o briefing seguinte já nasce disso").
const NEXT_STEP = {
  leo: 'cislunar', sso: 'lunar_orbit', gto: 'lunar_orbit', iss: 'cislunar', cislunar: 'lunar_orbit',
  lunar_orbit: 'lunar_surface', lunar_surface: 'lunar_south_pole', mars_orbit: 'mars_surface',
};

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

const fn = (mod, name) => (typeof mod?.[name] === 'function' ? mod[name] : null);
const round1 = (x) => Math.round(x * 10) / 10;
const pct = (p) => `${Math.round(p * 100)}%`;

/** "US$ 1,2 bi" / "US$ 350 mi" */
export function fmtMoney(m) {
  const v = Number(m) || 0;
  if (Math.abs(v) >= 1000) return `US$ ${(v / 1000).toFixed(1).replace('.', ',')} bi`;
  return `US$ ${Math.round(v)} mi`;
}

const vehicleDef = (data, id) => (id ? data.index?.vehicles?.[id] ?? data.vehicles?.vehicles?.find((v) => v.id === id) ?? null : null);
const spacecraftDef = (data, id) => (id ? data.index?.spacecraft?.[id] ?? data.spacecraft?.spacecraft?.find((v) => v.id === id) ?? null : null);
const destDef = (data, id) => (id ? data.index?.destinations?.[id] ?? data.destinations?.destinations?.find((v) => v.id === id) ?? null : null);
const calDef = (data, id) => data.index?.calendar?.[id] ?? data.calendar?.missions?.find((v) => v.id === id) ?? null;
const destList = (data) => data.destinations?.destinations || [];
const actorName = (state, id) => state.actors?.[id]?.short || state.actors?.[id]?.name || id;
const missionById = (state, id) => (state.missions || []).find((m) => m.id === id) || null;
const fmtT = (state, t) => formatTurn(t, state.startYear);

function stat(state, key, delta = 1) {
  state.stats = state.stats || {};
  state.stats[`missions.${key}`] = (state.stats[`missions.${key}`] || 0) + delta;
}

function techBonus(state, key) {
  const f = fn(research, 'techBonus');
  const v = f ? f(state, state.playerId, key) : 0;
  return Number.isFinite(v) ? v : 0;
}

// --- money: budget module when present, otherwise plain cash ---
function canPay(state, amount) {
  const f = fn(budget, 'canAfford');
  if (f) return f(state, state.playerId, amount) !== false;
  return (state.actors?.[state.playerId]?.cash ?? 0) >= amount;
}
function pay(state, amount, note) {
  if (amount <= 0) return true;
  const f = fn(budget, 'spend');
  if (f) return f(state, state.playerId, amount, 'missions', note) !== false;
  if (!canPay(state, amount)) return false;
  changeActor(state, state.playerId, 'cash', -amount);
  return true;
}
function receive(state, actorId, amount, category, note) {
  if (amount <= 0) return;
  const f = fn(budget, 'earn');
  if (f) f(state, actorId, amount, category, note);
  else changeActor(state, actorId, 'cash', amount);
}

// --- catalog access with fallbacks (calendar module may still be a stub) ---
function monthIdx(d) {
  if (!d || d.year == null) return -Infinity;
  return d.year * 12 + ((d.month ?? 1) - 1);
}
function availableByDate(state, item) {
  const d = turnToDate(state.turn, state.startYear);
  const now = d.year * 12 + d.month;
  if (monthIdx(item.availableFrom) > now) return false;
  if (item.availableUntil && monthIdx(item.availableUntil) < now) return false;
  return true;
}
function vehiclesFor(state, data, actorId = state.playerId) {
  const f = fn(calendar, 'availableVehicles');
  const r = f ? f(state, data, actorId) : null;
  if (Array.isArray(r)) return r;
  return (data.vehicles?.vehicles || []).filter((v) => availableByDate(state, v));
}
function spacecraftFor(state, data, actorId = state.playerId) {
  const f = fn(calendar, 'availableSpacecraft');
  const r = f ? f(state, data, actorId) : null;
  if (Array.isArray(r)) return r;
  return (data.spacecraft?.spacecraft || []).filter((s) => availableByDate(state, s));
}
function capacityTo(data, vehicleId, destId) {
  const f = fn(calendar, 'capacityTo');
  if (f) {
    const c = f(data, vehicleId, destId);
    if (Number.isFinite(c)) return c;
  }
  const v = vehicleDef(data, vehicleId);
  const d = destDef(data, destId);
  if (!v || !d) return 0;
  return Number(v.capacity?.[d.capacityKey]) || 0;
}
export function vehicleReliability(state, data, vehicleId) {
  const f = fn(calendar, 'vehicleReliability');
  const r = f ? f(state, data, vehicleId) : null;
  if (r && Number.isFinite(r.mean)) return r;
  const v = vehicleDef(data, vehicleId);
  if (!v) return { mean: 0.8, low: 0.6, high: 0.95, flights: 0 };
  const st = state.vehicleStats?.[vehicleId] || v.history || {};
  const flights = st.flights || 0;
  const failures = st.failures || 0;
  const prior = v.estimatedReliability ?? 0.9;
  const a = prior * 6 + (flights - failures);
  const b = (1 - prior) * 6 + failures;
  const mean = a / (a + b);
  const sd = Math.sqrt((mean * (1 - mean)) / (a + b + 1));
  return { mean, low: clamp(mean - 1.6 * sd, 0, 1), high: clamp(mean + 1.6 * sd, 0, 1), flights };
}
function spacecraftReliability(state, data, scId) {
  const f = fn(calendar, 'spacecraftReliability');
  const r = f ? f(state, data, scId) : null;
  if (r && Number.isFinite(r.mean)) return r;
  const s = spacecraftDef(data, scId);
  const mean = s?.estimatedReliability ?? 0.95;
  return { mean, low: clamp(mean - 0.05, 0, 1), high: clamp(mean + 0.03, 0, 1) };
}
function reliabilityBand(rel) {
  if ((rel.flights ?? 99) < 3 && rel.high - rel.low > 0.15) return 'experimental';
  if (rel.mean >= 0.95) return 'alta';
  if (rel.mean >= 0.85) return 'média';
  return 'baixa';
}

/**
 * Next launch window for a destination: { openTurn, closeTurn } (closeTurn may be Infinity).
 * `calendarId`: a calendar program may fly its own trajectory window (calendar item `window`).
 */
export function windowFor(state, data, destId, fromTurn = state.turn, calendarId = null) {
  const f = fn(calendar, 'nextWindow');
  if (f) {
    const item = calendarId ? calDef(data, calendarId) : null;
    const w = f(state, data, destId, fromTurn, item && item.window !== undefined ? item : undefined);
    if (w && Number.isFinite(w.openTurn)) return { openTurn: w.openTurn, closeTurn: w.closeTurn ?? Infinity };
  }
  const win = destDef(data, destId)?.window;
  if (!win || !win.periodWeeks) return { openTurn: fromTurn, closeTurn: Infinity };
  const P = win.periodWeeks;
  const ph = win.phaseTurn || 0;
  const O = win.openWeeks || 6;
  let open = ph + Math.floor((fromTurn - ph) / P) * P;
  if (fromTurn >= open + O) open += P;
  return { openTurn: open, closeTurn: open + O };
}
const inWindow = (w, t) => t >= w.openTurn && t < w.closeTurn;

// --- type/destination/spacecraft compatibility ---
function destOkForType(dest, type) {
  if (!dest || !type) return false;
  const custom = dest.missionTypes || dest.types;
  if (Array.isArray(custom) && custom.length) return custom.includes(type);
  return (TYPE_DESTS[type] || []).includes(dest.id);
}
function scOkForType(sc, type, crewed) {
  if (!sc) return false;
  if (crewed) return (sc.crew || 0) > 0;
  return (SC_KINDS[type] || []).includes(sc.kind);
}
function scOkForDest(sc, destId) {
  return !Array.isArray(sc?.destinations) || sc.destinations.length === 0 || sc.destinations.includes(destId);
}

// ---------------------------------------------------------------------------------------------
// Drafts, crew, cost and validation
// ---------------------------------------------------------------------------------------------

/** Companion craft (launched separately): needed when the main craft lists the destination in landerRequired. */
function needsLander(data, d) {
  const sc = spacecraftDef(data, d.spacecraftId);
  return !!(d.crewed && sc && Array.isArray(sc.landerRequired) && sc.landerRequired.includes(d.destination));
}
const isCrewLander = (s) => s && s.kind === 'lander' && (s.crew || 0) > 0;
/** Where a companion must be able to go: the destination itself, or lunar orbit for a lunar surface rendezvous. */
function companionOk(data, s, destId) {
  if (!s) return false;
  if (scOkForDest(s, destId)) return true;
  const dest = destDef(data, destId);
  return dest?.body === 'moon' && scOkForDest(s, 'lunar_orbit');
}
/** Crewed landers the agency can use for this draft, best first (own hardware, reliability, cost). */
function landerChoices(state, data, d) {
  return spacecraftFor(state, data)
    .filter((s) => isCrewLander(s) && s.id !== d.spacecraftId && scOkForDest(s, d.destination))
    .map((s) => ({ s, rel: spacecraftReliability(state, data, s.id).mean }))
    .sort((a, b) => ((b.s.operator === state.playerId) - (a.s.operator === state.playerId)) || (b.rel - a.rel) || ((a.s.costM || 0) - (b.s.costM || 0)))
    .map((x) => x.s);
}
/** The companion craft id this draft will fly with (explicit choice, or the best lander when one is required). */
export function companionOf(state, data, d) {
  if (d.secondarySpacecraftId) return d.secondarySpacecraftId;
  if (!needsLander(data, d)) return null;
  return landerChoices(state, data, d)[0]?.id || null;
}
/** Cheapest available launch for the companion craft (it flies on its own rocket). */
function companionLaunch(state, data, s, destId) {
  if (!s) return null;
  const dest = destDef(data, destId);
  const target = scOkForDest(s, destId) ? destId : dest?.body === 'moon' ? 'lunar_orbit' : destId;
  let best = null;
  for (const v of vehiclesFor(state, data)) {
    if (capacityTo(data, v.id, target) < (s.massT || 0)) continue;
    if (!best || (v.costM || 0) < (best.costM || 0)) best = v;
  }
  return best;
}

function emptyCrew() {
  return { flightDirector: null, commander: null, astronauts: [] };
}

/** Normalize a (partial) draft coming from the UI or from a briefing/contract. */
export function normalizeDraft(d = {}) {
  const cfg = d.config || {};
  const crew = d.crew || {};
  const type = TYPES.includes(d.type) ? d.type : null;
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 60) : null,
    type,
    destination: d.destination || null,
    vehicleId: d.vehicleId || null,
    spacecraftId: d.spacecraftId || null,
    secondarySpacecraftId: d.secondarySpacecraftId || null,
    crewed: d.crewed ?? type === 'crewed',
    crew: {
      flightDirector: crew.flightDirector || null,
      commander: crew.commander || null,
      astronauts: Array.isArray(crew.astronauts) ? [...new Set(crew.astronauts.filter(Boolean))] : [],
    },
    config: {
      strategy: STRATEGIES.includes(cfg.strategy) ? cfg.strategy : 'balanced',
      fuelMargin: clamp(Number.isFinite(cfg.fuelMargin) ? cfg.fuelMargin : 0.1, 0, 0.3),
      payloadT: Number.isFinite(cfg.payloadT) && cfg.payloadT > 0 ? cfg.payloadT : null,
    },
    source: ['calendar', 'custom', 'contract'].includes(d.source) ? d.source : 'custom',
    calendarId: d.calendarId || null,
    contractId: d.contractId || null,
    clientPayload: !!d.clientPayload,
    grantM: Math.max(0, Number(d.grantM) || 0),
    // share of the bill paid by someone else (program appropriation, sponsor): scales with the configuration
    grantShare: clamp(Number(d.grantShare) || 0, 0, 0.9),
    deadlineTurn: Number.isFinite(d.deadlineTurn) ? d.deadlineTurn : null,
    milestone: d.milestone || null,
    targetTurn: Number.isFinite(d.targetTurn) ? d.targetTurn : null,
    readyTurn: Number.isFinite(d.readyTurn) ? d.readyTurn : null,
  };
}

const crewIdsOf = (m) => [m.crew?.commander, ...(m.crew?.astronauts || [])].filter(Boolean);

/** Map crewId -> mission that holds them (active missions only, excluding `exceptId`). */
function busyCrew(state, exceptId) {
  const busy = {};
  for (const m of state.missions || []) {
    if (m.id === exceptId || !ACTIVE_STATUSES.includes(m.status) || !m.crewed) continue;
    for (const id of crewIdsOf(m)) busy[id] = m;
  }
  return busy;
}

function rosterFor(state, role) {
  const f = fn(crewMod, 'availableCrew');
  const r = f ? f(state, role) : null;
  if (Array.isArray(r)) return r;
  return Object.values(state.crew || {}).filter((p) => p.role === role && p.status === 'active' && (p.actorId ?? state.playerId) === state.playerId);
}

function candidate(p, busy) {
  return {
    id: p.id, name: p.name, role: p.role, skill: p.skill ?? 0, experience: p.experience ?? 0,
    traits: p.traits || [], morale: p.morale ?? 50, legend: !!p.legend, portrait: p.portrait || null,
    busy: !!busy[p.id], busyWith: busy[p.id]?.name || null,
  };
}

/** Pick the best free crew for a mission (used to pre-fill briefings and contracts). */
function autoCrew(state, data, seats, exceptId) {
  const busy = busyCrew(state, exceptId);
  const score = (p) => (p.skill || 0) + (p.experience || 0) * 2 + (p.legend ? 15 : 0);
  const fds = rosterFor(state, 'flight_director').slice().sort((a, b) => score(b) - score(a));
  const astros = rosterFor(state, 'astronaut').filter((p) => !busy[p.id]).sort((a, b) => score(b) - score(a));
  const crew = emptyCrew();
  crew.flightDirector = fds[0]?.id || null;
  if (seats > 0) {
    crew.commander = astros[0]?.id || null;
    crew.astronauts = astros.slice(1, seats).map((p) => p.id);
  }
  return crew;
}

function payloadOf(data, d) {
  if (d.config?.payloadT) return d.config.payloadT;
  const sc = spacecraftDef(data, d.spacecraftId);
  return sc?.massT ?? 1;
}

/** Effective capacity of vehicle to destination after research bonus and fuel margin. */
function effectiveCapacity(state, data, vehicleId, destId, fuelMargin) {
  const raw = capacityTo(data, vehicleId, destId);
  return { raw, eff: round1(raw * (1 + techBonus(state, 'payload')) * (1 - (fuelMargin ?? 0.1))) };
}

/** Cost breakdown in US$ mi. */
export function computeCost(state, data, draft) {
  const d = draft.config ? draft : normalizeDraft(draft);
  const v = vehicleDef(data, d.vehicleId);
  const sc = spacecraftDef(data, d.spacecraftId);
  const dest = destDef(data, d.destination);
  const lines = [];
  const launchCost = v ? (v.costM || 0) * Math.max(0.3, 1 + techBonus(state, 'launchCost')) : 0;
  if (v) lines.push({ label: `Lançador (${v.name})`, amount: round1(launchCost) });
  // generic hardware is priced per class of destination (a Jupiter probe is not a lunar cubesat)
  const scCost = sc ? (sc.costM || 0) * (sc.access === 'generic' ? GENERIC_COST_SCALE[dest?.capacityKey] ?? 1 : 1) : 0;
  if (sc && !d.clientPayload) lines.push({ label: `Espaçonave (${sc.name})`, amount: round1(scCost) });
  const sc2 = spacecraftDef(data, companionOf(state, data, d));
  if (sc2) {
    lines.push({ label: `Módulo de apoio (${sc2.name})`, amount: round1(sc2.costM || 0) });
    const v2 = companionLaunch(state, data, sc2, d.destination);
    if (v2) lines.push({ label: `Lançamento do módulo (${v2.name})`, amount: round1((v2.costM || 0) * Math.max(0.3, 1 + techBonus(state, 'launchCost'))) });
  }
  if (dest) {
    const ops = dest.opsCostM ?? OPS_COST_BY_KEY[dest.capacityKey] ?? 10;
    lines.push({ label: 'Operações e controle', amount: ops });
  }
  const nCrew = d.crewed ? crewIdsOf(d).length : 0;
  if (nCrew) lines.push({ label: `Tripulação (${nCrew})`, amount: nCrew * CREW_COST_PER_PERSON });
  if (v && d.config.fuelMargin > 0) {
    const fm = d.config.fuelMargin;
    lines.push({ label: 'Margem de combustível', amount: round1(launchCost * (Math.min(fm, MARGIN_BASE) * 0.25 + Math.max(0, fm - MARGIN_BASE))) });
  }
  const hw = launchCost + (sc && !d.clientPayload ? scCost : 0);
  if (d.config.strategy === 'conservative') lines.push({ label: 'Testes extras (conservadora)', amount: round1(hw * 0.06) });
  if (d.config.strategy === 'aggressive') lines.push({ label: 'Cronograma enxuto (agressiva)', amount: round1(-hw * 0.04) });
  let total = lines.reduce((s, l) => s + l.amount, 0);
  if (d.grantShare > 0 || d.grantM > 0) {
    // a share, not a fixed amount: swapping to cheap hardware must not turn the grant into a free mission
    const g = d.grantShare > 0 ? total * d.grantShare : Math.min(d.grantM, total);
    lines.push({ label: d.source === 'calendar' ? 'Verba dedicada do programa' : 'Financiamento externo', amount: -round1(g) });
    total -= g;
  }
  return { total: Math.max(0, round1(total)), breakdown: lines };
}

function leadWeeks(d) {
  const base = LEAD_BY_SOURCE[d.source] ?? LEAD_WEEKS[d.type] ?? 8;
  // extra tests take time, not only money
  return base + (d.config?.strategy === 'conservative' ? CONSERVATIVE_EXTRA_WEEKS : 0);
}

/** Earliest turn this draft can launch (preparation lead + launch window). */
function earliestLaunch(state, data, d) {
  // a calendar program's hardware is ready on its own schedule (readyTurn), not the day the plan is approved
  const from = Math.max(state.turn + leadWeeks(d), Number.isFinite(d.readyTurn) ? d.readyTurn : -Infinity);
  if (!d.destination) return from;
  const w = windowFor(state, data, d.destination, from, d.calendarId);
  return Math.max(from, w.openTurn);
}

/**
 * Validate a draft. opts: { schedule: bool, launchTurn, missionId, paid, skipLead }
 * Returns { errors, warnings, payloadT, capacity, seats, cost, window, earliest }.
 */
function validate(state, data, d, opts = {}) {
  const errors = [];
  const warnings = [];
  const dest = destDef(data, d.destination);
  const v = vehicleDef(data, d.vehicleId);
  const sc = spacecraftDef(data, d.spacecraftId);
  const typeLabel = TYPE_LABELS[d.type] || '';

  if (!d.type) errors.push('Escolha o tipo de missão.');
  if (!d.destination) errors.push('Escolha o destino.');
  else if (!dest) errors.push('Destino desconhecido.');
  else if (d.type && !destOkForType(dest, d.type) && d.source !== 'calendar') errors.push(`${dest.name} não é destino para missão do tipo ${typeLabel.toLowerCase()}.`);

  // spacecraft
  if (!d.spacecraftId) {
    if (!d.clientPayload) errors.push('Escolha a espaçonave.');
  } else if (!sc) errors.push('Espaçonave desconhecida.');
  else {
    if (!spacecraftFor(state, data).some((s) => s.id === sc.id)) errors.push(`${sc.name} não está disponível para a agência agora.`);
    if (d.type && d.source !== 'calendar' && !scOkForType(sc, d.type, d.crewed)) errors.push(d.crewed ? `${sc.name} não leva tripulação.` : `${sc.name} não serve para missão do tipo ${typeLabel.toLowerCase()}.`);
    if (dest && !scOkForDest(sc, dest.id)) errors.push(`${sc.name} não foi projetada para ${dest.name}.`);
  }
  // companion craft (lander for Orion, capsule for Lanyue)
  const sc2id = companionOf(state, data, d);
  const sc2 = spacecraftDef(data, sc2id);
  if (needsLander(data, d) && !isCrewLander(sc2)) errors.push(`${sc?.name || 'A nave'} precisa de um módulo de pouso tripulado para ${dest?.name || d.destination}, e nenhum está disponível.`);
  if (sc2id && !sc2) errors.push('Módulo de apoio desconhecido.');
  else if (sc2) {
    if (!spacecraftFor(state, data).some((s) => s.id === sc2.id)) errors.push(`${sc2.name} não está disponível para a agência agora.`);
    if (dest && !companionOk(data, sc2, dest.id)) errors.push(`${sc2.name} não opera em ${dest.name}.`);
    else if (!companionLaunch(state, data, sc2, dest?.id)) errors.push(`Nenhum foguete disponível leva ${sc2.name} até ${dest?.name || d.destination}.`);
  }

  // vehicle + payload
  const payloadT = payloadOf(data, d);
  let capacity = { raw: 0, eff: 0 };
  if (!d.vehicleId) errors.push('Escolha o veículo lançador.');
  else if (!v) errors.push('Veículo desconhecido.');
  else {
    if (!vehiclesFor(state, data).some((x) => x.id === v.id)) errors.push(`${v.name} não está disponível para a agência agora.`);
    if (d.crewed && !v.crewRated) errors.push(`${v.name} não é certificado para voo tripulado.`);
    if (dest) {
      capacity = effectiveCapacity(state, data, v.id, dest.id, d.config.fuelMargin);
      if (capacity.raw <= 0) errors.push(`${v.name} não alcança ${dest.name}.`);
      else if (capacity.eff < payloadT) {
        errors.push(`Carga de ${String(round1(payloadT)).replace('.', ',')} t excede a capacidade de ${String(capacity.eff).replace('.', ',')} t do ${v.name} até ${dest.name}.`);
      } else if (capacity.eff < payloadT * 1.05) warnings.push('Carga no limite da capacidade: pouca folga.');
    }
    const rel = vehicleReliability(state, data, v.id);
    if (reliabilityBand(rel) === 'experimental') warnings.push(`${v.name} tem poucos voos: confiabilidade incerta.`);
  }

  // crew
  const seats = sc?.crew || 0;
  const busy = busyCrew(state, opts.missionId);
  const checkPerson = (id, role, roleLabel) => {
    const p = state.crew?.[id];
    if (!p) { errors.push(`${roleLabel}: pessoa desconhecida.`); return; }
    if (p.role !== role) errors.push(`${p.name} não é ${roleLabel.toLowerCase()}.`);
    if (p.status && p.status !== 'active') errors.push(`${p.name} não está disponível.`);
    if (p.actorId && p.actorId !== state.playerId) errors.push(`${p.name} não é da agência.`);
    if (busy[id]) errors.push(`${p.name} já está escalado(a) em ${busy[id].name}.`);
  };
  if (d.crew.flightDirector) {
    const fd = state.crew?.[d.crew.flightDirector];
    if (!fd || fd.role !== 'flight_director' || (fd.status && fd.status !== 'active')) errors.push('Diretor de voo indisponível.');
  } // (no flight director: risk.missionRisk already warns)
  if (d.crewed) {
    if (!d.crew.commander) errors.push('Escolha o comandante.');
    else checkPerson(d.crew.commander, 'astronaut', 'Astronauta');
    for (const id of d.crew.astronauts) {
      if (id === d.crew.commander) errors.push('O comandante já ocupa um assento.');
      else checkPerson(id, 'astronaut', 'Astronauta');
    }
    const n = crewIdsOf(d).length;
    if (sc && n > seats) errors.push(`A ${sc.name} leva ${seats} pessoa(s); há ${n} escalada(s).`);
    if (sc && n > 0 && n < seats) warnings.push(`Assentos livres: ${seats - n}.`);
  } else if (crewIdsOf(d).length) warnings.push('Missão sem tripulação: astronautas escalados serão ignorados.');

  // scheduling constraints
  const cost = computeCost(state, data, d);
  const earliest = earliestLaunch(state, data, d);
  const lt = Number.isFinite(opts.launchTurn) ? opts.launchTurn : earliest;
  const window = d.destination ? windowFor(state, data, d.destination, lt, d.calendarId) : null;
  if (opts.schedule) {
    // hardware must still be in service on launch day (a rocket retiring before the date cannot be booked)
    const svc = fn(calendar, 'inServiceAt');
    if (svc) {
      for (const item of [v, sc, sc2]) {
        if (item && !svc(state, data, item, lt)) errors.push(`${item.name} sai de serviço antes de ${fmtT(state, lt)}.`);
      }
    }
    const minTurn = state.turn + leadWeeks(d);
    if (!opts.skipLead && lt < minTurn) errors.push(`Preparação mínima de ${weeksToText(leadWeeks(d))}: lançamento a partir de ${fmtT(state, minTurn)}.`);
    if (Number.isFinite(d.readyTurn) && lt < d.readyTurn) errors.push(`O hardware do programa só fica pronto em ${fmtT(state, d.readyTurn)}.`);
    // the last week is the end of the campaign: a launch then would fly after the Era Trophy
    if (lt >= state.endTurn) errors.push('Data além do fim do cenário.');
    if (window && !inWindow(window, lt)) {
      errors.push(`Fora da janela para ${dest?.name || d.destination}. Próxima janela: ${fmtT(state, window.openTurn)} a ${fmtT(state, window.closeTurn)}.`);
    }
    if (!opts.paid && !canPay(state, cost.total)) {
      errors.push(`Caixa insuficiente: custo ${fmtMoney(cost.total)}, caixa ${fmtMoney(state.actors?.[state.playerId]?.cash ?? 0)}.`);
    }
  }
  // prestige and science are paid on arrival: a probe that lands after the era never reaches the Era Table
  const arriveLt = (window && Number.isFinite(window.openTurn) ? Math.max(lt, window.openTurn) : lt) + (dest?.transitWeeks || 0);
  if (dest?.transitWeeks > 0 && arriveLt > state.endTurn && lt < state.endTurn) {
    warnings.push(`Chega só em ${fmtT(state, arriveLt)}, depois do fim de ${turnToDate(state.endTurn, state.startYear).year}: não pontua na Tabela da Era.`);
  }
  if (d.deadlineTurn != null) {
    if (lt > d.deadlineTurn) warnings.push(`Depois do prazo do contrato (${fmtT(state, d.deadlineTurn)}): multa e receita menor.`);
    else warnings.push(`Prazo do contrato: ${fmtT(state, d.deadlineTurn)}.`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], payloadT, capacity, seats, cost, window, earliest, launchTurn: lt };
}

// ---------------------------------------------------------------------------------------------
// Risk estimate
// ---------------------------------------------------------------------------------------------

function planOf(state, d, launchTurn) {
  return {
    actorId: state.playerId, type: d.type, destination: d.destination, vehicleId: d.vehicleId, spacecraftId: d.spacecraftId,
    secondarySpacecraftId: d.secondarySpacecraftId || undefined,
    crew: d.crew, config: d.config, launchTurn: launchTurn ?? state.turn, crewed: d.crewed, riskMod: d.riskMod || 0,
    // a draft is "created" now: lets risk show "Prazo apertado" in the builder, same rule as launch day
    createdTurn: Number.isFinite(d.createdTurn) ? d.createdTurn : state.turn,
    calendarId: d.source === 'calendar' ? d.calendarId || undefined : undefined,
  };
}

/** Our own simple estimate, used when risk.js is unavailable. */
function fallbackRisk(state, data, d) {
  const factors = [];
  const vr = d.vehicleId ? vehicleReliability(state, data, d.vehicleId) : { mean: 0.85, low: 0.7, high: 0.95 };
  const sr = d.spacecraftId ? spacecraftReliability(state, data, d.spacecraftId) : { mean: 0.97 };
  const dest = destDef(data, d.destination);
  let p = vr.mean * sr.mean;
  factors.push({ label: 'Confiabilidade do veículo e da nave', delta: round1((p - 1) * 100) / 100 });
  if (dest?.arrivalMilestones?.length) { p *= 0.9; factors.push({ label: 'Chegada ao destino', delta: -0.1 }); }
  const strat = d.config.strategy === 'conservative' ? 0.02 : d.config.strategy === 'aggressive' ? -0.04 : 0;
  if (strat) factors.push({ label: 'Estratégia', delta: strat });
  const tech = techBonus(state, 'reliability');
  if (tech) factors.push({ label: 'Pesquisa', delta: tech });
  p = clamp(p + strat + tech + (d.config.fuelMargin - 0.1) * 0.1, 0.05, 0.99);
  const band = clamp(0.1 - techBonus(state, 'chanceBand') * 0.1 - (d.crew.flightDirector ? 0.02 : 0), 0.03, 0.15);
  return { p, low: clamp(p - band, 0.01, 0.99), high: clamp(p + band * 0.7, 0.02, 0.995), factors, warnings: [], errors: [], valid: true, milestones: [] };
}

/** Full risk report for a draft (never throws). */
function riskFor(state, data, d, launchTurn) {
  let r = null;
  const f = fn(risk, 'missionRisk');
  if (f && d.type && d.destination && d.vehicleId && (d.spacecraftId || d.clientPayload)) {
    try { r = f(state, data, planOf(state, { ...d, secondarySpacecraftId: companionOf(state, data, d) }, launchTurn)); } catch (e) { log(state, `aviso: risco indisponível (${e.message})`); r = null; }
  }
  if (!r || !Number.isFinite(r.p)) r = fallbackRisk(state, data, d);
  const mod = d.riskMod || 0;
  if (mod) {
    r = { ...r, p: clamp(r.p + mod, 0.01, 0.995), low: clamp((r.low ?? r.p) + mod, 0.01, 0.99), high: clamp((r.high ?? r.p) + mod, 0.02, 0.995),
      factors: [...(r.factors || []), { label: 'Eventos da missão', delta: mod }] };
  }
  return r;
}

const estimateOf = (r) => ({ p: r.p, low: r.low ?? r.p, high: r.high ?? r.p, ...(r.pCrewLoss ? { pCrewLoss: r.pCrewLoss } : {}) });

/** Mission-specific odds shift (+ = safer): missions' own riskMod minus narrative {missionRisk} effects (+ = riskier). */
export function riskModOf(state, m) {
  if (!m) return 0;
  const f = fn(narrative, 'missionRiskDelta');
  let ev = 0;
  try { ev = f ? Number(f(state, m.id)) || 0 : 0; } catch { ev = 0; }
  return clamp((Number(m.riskMod) || 0) - ev, -0.4, 0.2);
}

/** Recalculate mission.estimate via risk.missionRisk. Returns the estimate. */
export function estimateFor(state, data, missionId) {
  const m = missionById(state, missionId);
  if (!m) return null;
  m.estimate = estimateOf(riskFor(state, data, { ...m, riskMod: riskModOf(state, m) }, m.launchTurn ?? undefined));
  return m.estimate;
}

// ---------------------------------------------------------------------------------------------
// Catalog helpers for pre-filled drafts (briefings, contracts, opportunities)
// ---------------------------------------------------------------------------------------------

/** Cheapest valid vehicle+spacecraft for (type, destination), or null. */
function pickConfig(state, data, { type, destination, crewed = type === 'crewed', extraPayload = 0, payloadOverride = null, clientPayload = false, scKinds = null, actorId = state.playerId }) {
  const dest = destDef(data, destination);
  if (!dest) return null;
  let scs = clientPayload
    ? [null]
    : spacecraftFor(state, data, actorId).filter((s) => (scKinds ? scKinds.includes(s.kind) && (!crewed || s.crew > 0) : scOkForType(s, type, crewed)) && scOkForDest(s, destination));
  if (!clientPayload && scs.length === 0) return null;
  // own spacecraft first, then cheaper
  scs = scs.slice().sort((a, b) => ((b?.operator === actorId) - (a?.operator === actorId)) || ((a?.costM || 0) - (b?.costM || 0)));
  const vehicles = vehiclesFor(state, data, actorId);
  let best = null;
  for (const sc of scs.slice(0, 6)) {
    const payload = payloadOverride ?? ((sc?.massT ?? 1) + extraPayload);
    for (const v of vehicles) {
      if (crewed && !v.crewRated) continue;
      const cap = capacityTo(data, v.id, destination) * (1 + techBonus(state, 'payload')) * 0.9;
      if (cap < payload) continue;
      const rel = vehicleReliability(state, data, v.id).mean;
      const cost = (v.costM || 0) + (sc && !clientPayload ? sc.costM || 0 : 0);
      const score = cost * (1 + Math.max(0, 0.92 - rel) * 4); // penalize shaky rockets
      if (!best || score < best.score) best = { score, vehicleId: v.id, spacecraftId: sc?.id || null, payloadT: payload, cost, rel };
    }
  }
  return best;
}

const NAME_TYPE = { satellite: 'Satélite', probe: 'Sonda', crewed: 'Voo tripulado', cargo: 'Carga', station: 'Módulo', lander: 'Pousador' };
const NAME_DEST = {
  leo: 'LEO', sso: 'Polar', gto: 'GEO', iss: 'ISS', cislunar: 'Cislunar', lunar_orbit: 'Lunar', lunar_surface: 'Lunar',
  lunar_south_pole: 'Polo Sul', mars_orbit: 'Marte', mars_surface: 'Marte', jupiter: 'Júpiter', titan: 'Titã',
};
function nameFor(state, data, d) {
  const dest = destDef(data, d.destination);
  const tag = NAME_DEST[d.destination] || dest?.short || dest?.name || '';
  const prefix = `${NAME_TYPE[d.type] || TYPE_LABELS[d.type] || 'Missão'}${tag ? ` ${tag}` : ''}`;
  const n = (state.missions || []).filter((m) => typeof m.name === 'string' && m.name.startsWith(`${prefix}-`)).length + 1;
  return `${prefix}-${n}`;
}

// ---------------------------------------------------------------------------------------------
// Mission creation and actions
// ---------------------------------------------------------------------------------------------

function createMission(state, data, draft) {
  const d = normalizeDraft(draft);
  if (!d.type) return { ok: false, error: 'Tipo de missão inválido.' };
  if (d.destination && !destDef(data, d.destination)) return { ok: false, error: 'Destino desconhecido.' };
  const m = {
    id: nextId(state, 'mis'),
    name: d.name || nameFor(state, data, d),
    source: d.source,
    calendarId: d.calendarId,
    contractId: d.contractId,
    type: d.type,
    destination: d.destination,
    vehicleId: d.vehicleId,
    spacecraftId: d.spacecraftId,
    secondarySpacecraftId: null,
    crewed: !!d.crewed,
    crew: d.crewed ? d.crew : { flightDirector: d.crew.flightDirector, commander: null, astronauts: [] },
    config: d.config,
    status: 'planning',
    createdTurn: state.turn,
    launchTurn: null,
    windowTurn: null,
    targetTurn: d.targetTurn,
    readyTurn: d.readyTurn,
    deadlineTurn: d.deadlineTurn,
    milestone: d.milestone,
    clientPayload: d.clientPayload,
    grantM: d.grantM,
    grantShare: d.grantShare,
    cost: 0,
    paid: false,
    paidM: 0,
    estimate: null,
    riskMod: 0,
    attempts: 0,
    transit: null,
    ops: null,
    phases: [],
    result: null,
  };
  m.secondarySpacecraftId = companionOf(state, data, { ...d, crewed: m.crewed }) || null;
  m.cost = computeCost(state, data, m).total;
  m.estimate = estimateOf(riskFor(state, data, m));
  state.missions.push(m);
  stat(state, 'created');
  return { ok: true, missionId: m.id, mission: m };
}

function scheduleMission(state, data, m, launchTurn) {
  if (!['planning', 'scheduled'].includes(m.status)) return { ok: false, error: 'Esta missão não pode ser agendada agora.' };
  const lt = Number.isFinite(launchTurn) ? Math.round(launchTurn) : earliestLaunch(state, data, m);
  const v = validate(state, data, m, { schedule: true, launchTurn: lt, missionId: m.id, paid: m.paid });
  if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors, warnings: v.warnings };
  if (!m.paid) {
    if (!pay(state, v.cost.total, `Missão ${m.name}`)) return { ok: false, error: 'Caixa insuficiente para pagar a missão.' };
    m.paid = true;
    m.cost = v.cost.total;
    m.paidM = v.cost.total;
  }
  const wasScheduled = m.status === 'scheduled';
  // pushing a booked launch back is remembered: rivals stop treating that date as a credible threat (calendar.rivalEta)
  if (wasScheduled && m.launchTurn != null && lt > m.launchTurn) m.redated = (m.redated || 0) + 1;
  m.status = 'scheduled';
  m.launchTurn = lt;
  m.windowTurn = v.window && Number.isFinite(v.window.closeTurn) ? v.window.openTurn : null;
  m.estimate = estimateOf(riskFor(state, data, m, lt));
  // a player calendar item follows the player's date
  const inst = m.calendarId ? (state.calendar || []).find((c) => c.id === m.calendarId) : null;
  if (inst && inst.status === 'player') inst.currentTurn = lt;
  const routine = !m.crewed && (destDef(data, m.destination)?.body ?? 'earth') === 'earth' && m.source !== 'calendar';
  if (!wasScheduled && routine) stat(state, 'scheduled');
  else if (!wasScheduled) {
    addNews(state, {
      headline: `${actorName(state, state.playerId)} marca ${m.name} para ${fmtT(state, lt)}`,
      body: `Chance estimada entre ${pct(m.estimate.low)} e ${pct(m.estimate.high)}. Custo: ${fmtMoney(m.cost)}.`,
      tags: ['mission', 'schedule'], actors: [state.playerId], importance: 1,
    });
    stat(state, 'scheduled');
  }
  return { ok: true, missionId: m.id, launchTurn: lt, cost: m.cost, warnings: v.warnings };
}

function cancelMission(state, data, m, { reason = 'player', penalty = true } = {}) {
  if (!['planning', 'scheduled', 'launch'].includes(m.status)) return { ok: false, error: 'A missão já voou: não dá para cancelar.' };
  if (state.activeLaunch?.missionId === m.id) return { ok: false, error: 'Lançamento em andamento.' };
  // remove pending launch card for it
  state.decisions = state.decisions.filter((x) => !(x.kind === 'launch/ready' && x.payload?.missionId === m.id));
  let refund = 0;
  if (m.paid) {
    // refund a share of what was actually paid (a paid mission sent back to planning is still a paid mission)
    refund = round1(paidOf(m) * 0.4);
    receive(state, state.playerId, refund, 'missions', `Reembolso parcial: ${m.name}`);
  }
  m.status = 'cancelled';
  m.result = { outcome: null, failureType: null, causes: [], phase: null, launchedTurn: null, resolvedTurn: state.turn, prestige: 0, science: 0, headlines: [] };
  const pid = state.playerId;
  if (m.source === 'calendar' && m.calendarId) {
    const inst = (state.calendar || []).find((c) => c.id === m.calendarId);
    if (inst && inst.status === 'player') { inst.status = 'cancelled'; inst.resolvedTurn = state.turn; }
    if (penalty) {
      changeActor(state, pid, 'support', m.crewed ? -8 : -5);
      changeActor(state, pid, 'reputation', -3);
    }
  } else if (m.paid && penalty) changeActor(state, pid, 'support', -2);
  if (m.contractId) defaultContract(state, data, m.contractId, 'cancel');
  if (reason === 'player') {
    addNews(state, {
      headline: `${actorName(state, pid)} cancela ${m.name}`,
      body: refund ? `Parte do dinheiro volta ao caixa: ${fmtMoney(refund)}.` : '',
      tags: ['mission', 'cancel'], actors: [pid], importance: m.source === 'calendar' ? 2 : 1,
    });
  }
  stat(state, 'cancelled');
  return { ok: true, refund };
}

const PATCH_KEYS = ['name', 'type', 'destination', 'vehicleId', 'spacecraftId', 'secondarySpacecraftId', 'crew', 'config', 'crewed'];

/** Amount the player actually paid for a mission (older saves: the cost at scheduling). */
function paidOf(m) {
  if (!m?.paid) return 0;
  return Number.isFinite(m.paidM) && m.paidM > 0 ? m.paidM : m.cost || 0;
}

/** Mission type a calendar definition flies as (same rule as calendarDraft). */
function calendarTypeOf(def) {
  return TYPES.includes(def?.type) ? def.type : def?.crewed ? 'crewed' : 'probe';
}

/**
 * Does the mission still fly its calendar program? Same type and crew flag, and the same destination
 * (or one whose own firsts include the program's milestone). Missions without a program: true.
 */
export function matchesCalendar(data, m) {
  if (!m?.calendarId) return true;
  const def = calDef(data, m.calendarId);
  if (!def) return true;
  if (m.type !== calendarTypeOf(def) || !!m.crewed !== !!def.crewed) return false;
  if (m.destination === def.destination) return true;
  const dest = destDef(data, m.destination);
  const own = [].concat((m.crewed ? dest?.firsts?.crewed : dest?.firsts?.robotic) ?? []);
  return !!def.milestone && own.includes(def.milestone);
}

function updateMission(state, data, m, patch = {}) {
  if (!['planning', 'scheduled'].includes(m.status)) return { ok: false, error: 'Só missões em planejamento ou agendadas podem mudar.' };
  // a calendar program is a fixed goal (Artemis IV lands on the Moon): the hardware may change, the target may not
  if (m.source === 'calendar' && m.calendarId) {
    const def = calDef(data, m.calendarId);
    const changed = (k) => k in patch && patch[k] != null && (k === 'crewed' ? !!patch[k] !== !!m[k] : patch[k] !== m[k]);
    if (def && ['type', 'destination', 'crewed'].some(changed)) {
      return { ok: false, error: `${def.name} é um programa com destino e tipo definidos. Para outro alvo, monte uma missão nova.` };
    }
  }
  const merged = {
    ...m,
    ...Object.fromEntries(PATCH_KEYS.filter((k) => k in patch && k !== 'crew' && k !== 'config').map((k) => [k, patch[k]])),
    crew: { ...m.crew, ...(patch.crew || {}) },
    config: { ...m.config, ...(patch.config || {}) },
  };
  if (patch.type && !('crewed' in patch)) merged.crewed = patch.type === 'crewed' || (m.crewed && m.source === 'calendar');
  // hardware/destination changed without a companion choice: pick it again
  if (!('secondarySpacecraftId' in patch) && ['type', 'destination', 'spacecraftId', 'crewed'].some((k) => k in patch)) merged.secondarySpacecraftId = null;
  const d = { ...normalizeDraft(merged), riskMod: riskModOf(state, m) };
  if (!d.type) return { ok: false, error: 'Tipo de missão inválido.' };
  const newCost = computeCost(state, data, d).total;
  if (m.status === 'scheduled') {
    const v = validate(state, data, d, { schedule: true, launchTurn: m.launchTurn, missionId: m.id, paid: true, skipLead: true });
    if (v.errors.length) return { ok: false, error: v.errors[0], errors: v.errors };
  }
  // already paid (scheduled, or sent back to planning on launch day): settle the difference whatever the status
  if (m.paid) {
    const paidM = paidOf(m);
    const diff = round1(newCost - paidM);
    if (diff > 0) {
      if (!canPay(state, diff) || !pay(state, diff, `Ajuste: ${m.name}`)) return { ok: false, error: `Caixa insuficiente para a diferença de ${fmtMoney(diff)}.` };
      m.paidM = round1(paidM + diff);
    } else if (diff < 0) {
      receive(state, state.playerId, round1(-diff * 0.8), 'missions', `Ajuste: ${m.name}`);
      m.paidM = newCost;
    }
  }
  if (d.name) m.name = d.name;
  Object.assign(m, {
    type: d.type, destination: d.destination, vehicleId: d.vehicleId, spacecraftId: d.spacecraftId, crewed: d.crewed,
    secondarySpacecraftId: companionOf(state, data, d) || null,
    crew: d.crewed ? d.crew : { flightDirector: d.crew.flightDirector, commander: null, astronauts: [] }, config: d.config,
  });
  m.cost = newCost;
  m.estimate = estimateOf(riskFor(state, data, m, m.launchTurn ?? undefined));
  return { ok: true, missionId: m.id, cost: m.cost, estimate: m.estimate };
}

// ---------------------------------------------------------------------------------------------
// Briefings (calendar items owned by the player + opportunities)
// ---------------------------------------------------------------------------------------------

function calendarDraft(state, data, inst, def) {
  const sc = spacecraftDef(data, def.spacecraftId);
  const crewed = !!def.crewed;
  const d = {
    name: def.name, source: 'calendar', calendarId: inst.id, type: TYPES.includes(def.type) ? def.type : crewed ? 'crewed' : 'probe',
    destination: def.destination, vehicleId: def.vehicleId || null, spacecraftId: def.spacecraftId || null, crewed,
    secondarySpacecraftId: def.secondarySpacecraftId || null,
    crew: autoCrew(state, data, crewed ? sc?.crew || 0 : 0), config: { strategy: 'balanced', fuelMargin: 0.1 },
    milestone: def.milestone || null, targetTurn: inst.currentTurn ?? inst.plannedTurn,
  };
  // program hardware missing from the catalog? complete it with the cheapest valid option
  if (!vehicleDef(data, d.vehicleId) || !spacecraftDef(data, d.spacecraftId)) {
    const cfg = pickConfig(state, data, { type: d.type, destination: d.destination, crewed });
    if (cfg) {
      if (!vehicleDef(data, d.vehicleId)) d.vehicleId = cfg.vehicleId;
      if (!spacecraftDef(data, d.spacecraftId)) d.spacecraftId = cfg.spacecraftId;
    }
  }
  // tight programs (Lanyue on Long March 10) only fit with a thin fuel margin
  if (d.vehicleId && sc) {
    const raw = capacityTo(data, d.vehicleId, d.destination) * (1 + techBonus(state, 'payload'));
    const fit = [0.1, 0.07, 0.05, 0.03, 0.02, 0].find((mg) => raw * (1 - mg) >= (sc.massT || 0));
    if (fit != null) d.config.fuelMargin = fit;
  }
  // flagship programs have their own appropriation (agencies) or customer money (companies): part of the bill is covered
  let share = def.fundedShare ?? (state.actors?.[state.playerId]?.kind === 'company' ? 0.2 : 0.35);
  // partners with a cost-sharing treaty (diplomacy.costShare) pay their part of joint programs
  const cs = fn(diplomacy, 'costShare');
  if (cs) share += Math.max(0, ...(def.partners || []).map((p) => Number(cs(state, state.playerId, p)) || 0));
  share = clamp(share, 0, 0.7);
  if (share > 0) d.grantShare = Math.round(share * 1000) / 1000;
  return d;
}

const TRUTH_LABELS = { fato: 'fato', plano_oficial: 'plano oficial', projecao: 'projeção', especulacao: 'especulação' };

function pushCalendarBriefing(state, data, inst, def, reach = null) {
  const target = inst.currentTurn ?? inst.plannedTurn ?? state.turn;
  const draft = calendarDraft(state, data, inst, def);
  const cost = computeCost(state, data, normalizeDraft(draft)).total;
  const revisions = inst.revisions || 0;
  const delaySupport = 2 + 2 * Math.min(revisions, 4);
  const cancelSupport = def.crewed ? 12 : 7;
  const prereqs = (def.prerequisites || [])
    .map((id) => (state.calendar || []).find((c) => c.id === id))
    .filter((c) => c && !['success', 'partial'].includes(c.status));
  const lines = [
    def.description || `Programa ${def.name}.`,
    `Data prevista: ${fmtT(state, target)} (${TRUTH_LABELS[def.truthLayer] || 'plano'}).`,
    `Custo estimado: ${fmtMoney(cost)}.`,
  ];
  if (prereqs.length) lines.push(`Depende de: ${prereqs.map((c) => calDef(data, c.id)?.name || c.id).join(', ')} (ainda não concluída).`);
  if (reach?.lateArrival) lines.push(`Atenção: chega só em ${fmtT(state, reach.arriveTurn)}, depois do fim de ${turnToDate(state.endTurn, state.startYear).year}. Não pontua na Tabela da Era.`);
  pushDecision(state, {
    kind: 'briefing',
    title: `Briefing: ${def.name}`,
    body: lines.join('\n'),
    portrait: { actorId: state.playerId },
    urgency: target - state.turn <= 6 ? 3 : 2,
    expiresTurn: Math.max(target, state.turn + 6),
    defaultChoice: 'accept',
    payload: { kind: 'calendar', calendarId: inst.id, draft },
    choices: [
      { id: 'accept', label: 'Aprovar o plano', preview: `A missão entra em planejamento com o veículo e a nave do programa. Agendar cobra ${fmtMoney(cost)}.` },
      { id: 'delay', label: 'Adiar 3 meses', preview: `−${delaySupport} apoio. Nova data: ${fmtT(state, target + 13)}.` },
      { id: 'cancel', label: 'Cancelar o programa', preview: `−${cancelSupport} apoio, −5 reputação. Os parceiros não vão esquecer.` },
    ],
  });
}

/**
 * Probes launched before the scenario (calendar items with inTransit) that belong to the player start as
 * player missions already in transit: no briefing, no bill, the arrival is the player's scene.
 */
function adoptTransitPrograms(state, data) {
  for (const inst of state.calendar || []) {
    if (inst.status !== 'player' || !inst.inTransit) continue;
    const def = calDef(data, inst.id);
    if (!def || (state.missions || []).some((m) => m.calendarId === inst.id)) continue;
    const launchTurn = inst.launchTurn ?? state.turn;
    const arriveTurn = Math.max(state.turn, inst.arrivalTurn ?? inst.plannedTurn ?? state.turn);
    const m = {
      id: nextId(state, 'mis'), name: def.name, source: 'calendar', calendarId: inst.id, contractId: null,
      type: calendarTypeOf(def), destination: def.destination, vehicleId: def.vehicleId || null, spacecraftId: def.spacecraftId || null,
      vehicleName: def.vehicleName || def.inTransit?.vehicleName || null, // retired launcher shown by name (Ariane 5)
      secondarySpacecraftId: null, crewed: false, crew: autoCrew(state, data, 0),
      config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: null },
      status: 'transit', createdTurn: state.turn, launchTurn, windowTurn: null, targetTurn: null, readyTurn: null, deadlineTurn: null,
      milestone: def.milestone || null, clientPayload: false, grantM: 0, grantShare: 0,
      cost: 0, paid: true, paidM: 0, estimate: null, riskMod: 0, attempts: 1, inheritedTransit: true,
      transit: { departTurn: launchTurn, arriveTurn, events: [] }, ops: null,
      phases: [{ phase: 'ascent', outcome: 'total', failureType: null, turn: launchTurn }],
      result: { outcome: 'total', failureType: null, causes: [], phase: 'ascent', launchedTurn: launchTurn, resolvedTurn: launchTurn, prestige: 0, science: 0, headlines: [], firsts: [], crewLost: [] },
    };
    try { m.estimate = estimateOf(riskFor(state, data, m, state.turn)); } catch { m.estimate = { p: 0.85, low: 0.75, high: 0.92 }; }
    state.missions.push(m);
    stat(state, 'inheritedTransit');
  }
}

function calendarBriefings(state, data) {
  for (const inst of state.calendar || []) {
    if (inst.status !== 'player') continue;
    const def = calDef(data, inst.id);
    if (!def) continue;
    if ((state.missions || []).some((m) => m.calendarId === inst.id && m.status !== 'cancelled')) continue;
    if (state.decisions.some((x) => x.kind === 'briefing' && x.payload?.calendarId === inst.id)) continue;
    const target = inst.currentTurn ?? inst.plannedTurn ?? state.turn;
    const lead = rngFor(state.seed, 'missions', 'briefLead', inst.id).int(8, 16) + (def.crewed ? 2 : 0);
    if (target - state.turn > lead) continue;
    const reach = programReach(state, data, inst, def, calendarDraft(state, data, inst, def));
    if (!reach.ok) { programBeyondEnd(state, data, inst, def, reach); continue; }
    pushCalendarBriefing(state, data, inst, def, reach);
  }
}

function resolveCalendarBriefing(state, data, dec, choiceId) {
  const { calendarId, draft } = dec.payload || {};
  const inst = (state.calendar || []).find((c) => c.id === calendarId);
  const def = calDef(data, calendarId);
  const pid = state.playerId;
  if (!inst || inst.status !== 'player') return { ok: true };
  if (choiceId === 'delay') {
    const weeks = 13;
    const sup = 2 + 2 * Math.min(inst.revisions || 0, 4);
    inst.currentTurn = (inst.currentTurn ?? inst.plannedTurn ?? state.turn) + weeks;
    inst.delayWeeks = (inst.delayWeeks || 0) + weeks;
    inst.revisions = (inst.revisions || 0) + 1;
    changeActor(state, pid, 'support', -sup);
    emitSignal(state, 'calendar/delayed', { calendarId, weeks });
    addNews(state, {
      headline: `${actorName(state, pid)} adia ${def?.name || 'missão'} para ${fmtT(state, inst.currentTurn)}`,
      body: 'Críticos falam em falta de rumo; engenheiros agradecem o tempo extra.',
      tags: ['mission', 'delay'], actors: [pid], importance: 2,
    });
    return { ok: true };
  }
  if (choiceId === 'cancel') {
    inst.status = 'cancelled';
    inst.resolvedTurn = state.turn;
    changeActor(state, pid, 'support', def?.crewed ? -12 : -7);
    changeActor(state, pid, 'reputation', -5);
    addNews(state, {
      headline: `${actorName(state, pid)} cancela ${def?.name || 'programa'}`,
      body: 'Parceiros reagem com frieza. A oposição fala em desperdício de anos de trabalho.',
      tags: ['mission', 'cancel'], actors: [pid, ...(def?.partners || [])], importance: 2,
    });
    return { ok: true };
  }
  const d0 = draft || calendarDraft(state, data, inst, def || {});
  // a briefing left open for weeks may no longer fit in the era: refuse instead of creating a mission that never flies
  const reach = programReach(state, data, inst, def, d0);
  if (!reach.ok) {
    programBeyondEnd(state, data, inst, def, reach);
    return { ok: true, beyondEnd: true };
  }
  const res = createMission(state, data, { ...d0, readyTurn: programReadyTurn(state, data, inst, def) });
  if (res.ok) inst.missionId = res.missionId;
  return res;
}

/**
 * When the program's hardware is ready: the official date (a few weeks of slack), plus a readiness slip rolled
 * from the item's own delay model (rival programs slip by the same numbers in calendar.js). Announces the slip.
 */
function programReadyTurn(state, data, inst, def) {
  const target = inst.currentTurn ?? inst.plannedTurn ?? state.turn;
  const weeks = programSlipWeeks(state, inst, def);
  if (weeks > 0) {
    addNews(state, {
      headline: `Hardware de ${def?.name || 'programa'} atrasa: pronto só em ${fmtT(state, target + weeks)}`,
      body: 'Testes de qualificação acharam problemas. A equipe pede mais tempo antes do voo.',
      tags: ['mission', 'delay'], actors: [state.playerId], importance: 2,
    });
  }
  return Math.max(state.turn, target - PROGRAM_EARLY_WEEKS + weeks);
}

/** Readiness slip of a program, in weeks (pure: same seed + item give the same slip whenever it is asked). */
function programSlipWeeks(state, inst, def) {
  const d = def?.delay || {};
  const rng = rngFor(state.seed, 'missions', 'readiness', inst.id);
  let weeks = 0;
  // two review gates before launch, like the rivals' periodic revisions
  for (let gate = 0; gate < 2; gate++) {
    if (!(d.slipChance > 0) || !rng.chance(d.slipChance)) continue;
    const months = clamp(rng.normal(d.meanMonths ?? 3, d.sdMonths ?? 2), 0.5, (d.meanMonths ?? 3) + 3 * (d.sdMonths ?? 2));
    weeks += Math.max(1, Math.round(months * 52 / 12));
  }
  return Math.min(weeks, Math.round((d.maxMonths ?? 24) * 52 / 12));
}

/**
 * Can this program still fly inside the scenario? Earliest launch = hardware ready (slip included) + lead +
 * planetary window; a launch must happen before the last week (`launchTurn < endTurn`, as validate demands).
 * Returns { ok, readyTurn, launchTurn, arriveTurn, lateArrival }.
 */
function programReach(state, data, inst, def, draft) {
  const target = inst.currentTurn ?? inst.plannedTurn ?? state.turn;
  const readyTurn = Math.max(state.turn, target - PROGRAM_EARLY_WEEKS + programSlipWeeks(state, inst, def));
  const end = Number.isFinite(state.endTurn) ? state.endTurn : Infinity;
  let launchTurn = readyTurn;
  try {
    launchTurn = earliestLaunch(state, data, normalizeDraft({ ...(draft || {}), source: 'calendar', calendarId: inst.id, readyTurn }));
  } catch { /* keep readyTurn */ }
  const arriveTurn = launchTurn + (destDef(data, def?.destination)?.transitWeeks || 0);
  return { ok: launchTurn < end, readyTurn, launchTurn, arriveTurn, lateArrival: arriveTurn > end };
}

/**
 * The program's hardware is only ready after the era ends: no briefing the player could approve and never fly.
 * The item leaves the player's plan with no political cost (the industry's schedule is nobody's fault), plus a card.
 */
function programBeyondEnd(state, data, inst, def, reach) {
  if (!inst || inst.status !== 'player') return;
  inst.status = 'cancelled';
  inst.beyondEnd = true;
  inst.resolvedTurn = state.turn;
  state.decisions = state.decisions.filter((x) => !(x.kind === 'briefing' && x.payload?.calendarId === inst.id));
  const year = turnToDate(state.endTurn, state.startYear).year;
  const when = reach && Number.isFinite(reach.launchTurn) ? ` O primeiro lançamento possível seria em ${fmtT(state, reach.launchTurn)}.` : '';
  issueCard(state, `${def?.name || 'Programa'} fica para depois de ${year}`,
    `O hardware do programa não fica pronto a tempo de voar antes do fim de ${year}.${when}\nO programa sai do seu plano sem custo político: ninguém culpa a agência pelo cronograma da indústria.`);
  addNews(state, {
    headline: `${def?.name || 'Programa'} fica para depois de ${year}`,
    body: 'Sem hardware pronto a tempo, a missão sai do cronograma desta era.',
    tags: ['mission', 'delay'], actors: [state.playerId], importance: 1,
  });
  stat(state, 'programBeyondEnd');
}

// --- opportunities: windows, rival moves, custom targets, follow-ups ---

function hasPendingOpportunity(state) {
  return state.decisions.some((x) => x.kind === 'briefing' && x.payload?.kind && x.payload.kind !== 'calendar');
}

function pushOpportunity(state, data, { sub, title, body, type, destination, grantShare = 0, crewed, declineSupport = 0, urgency = 1, extra = {} }) {
  const cfg = pickConfig(state, data, { type, destination, crewed: crewed ?? type === 'crewed' });
  if (!cfg) return null;
  const sc = spacecraftDef(data, cfg.spacecraftId);
  const isCrewed = crewed ?? type === 'crewed';
  const draft = {
    type, destination, vehicleId: cfg.vehicleId, spacecraftId: cfg.spacecraftId, crewed: isCrewed, source: 'custom',
    crew: autoCrew(state, data, isCrewed ? sc?.crew || 0 : 0), config: { strategy: 'balanced', fuelMargin: 0.1 }, ...extra,
  };
  draft.grantShare = grantShare;
  const net = computeCost(state, data, normalizeDraft(draft)).total;
  const grantM = round1(computeCost(state, data, normalizeDraft({ ...draft, grantShare: 0 })).total - net);
  const dest = destDef(data, destination);
  stat(state, 'opportunities');
  state.stats['missions.lastOpportunityTurn'] = state.turn;
  return pushDecision(state, {
    kind: 'briefing',
    title,
    body: `${body}\nDestino: ${dest?.name || destination}. Custo para a agência: ${fmtMoney(net)}${grantM > 0 ? ` (${fmtMoney(grantM)} vêm de fora)` : ''}.`,
    portrait: { actorId: state.playerId },
    urgency,
    expiresTurn: state.turn + 8,
    defaultChoice: 'decline',
    payload: { kind: sub, draft },
    choices: [
      { id: 'accept', label: 'Montar a missão', preview: `Cria a missão em planejamento (${TYPE_LABELS[type]}, ${dest?.name || destination}).` },
      { id: 'decline', label: 'Deixar passar', preview: declineSupport ? `−${declineSupport} apoio.` : 'Nada muda.' },
    ],
  });
}

function windowOpportunity(state, data) {
  for (const dest of destList(data)) {
    if (!dest.window) continue;
    if ((state.missions || []).some((m) => m.destination === dest.id && m.status !== 'done' && m.status !== 'cancelled')) continue;
    const w = windowFor(state, data, dest.id, state.turn + 10);
    const weeks = w.openTurn - state.turn;
    if (weeks < 14 || weeks > 40 || w.openTurn > state.endTurn) continue;
    // a probe that would arrive after the end of the era is not an opportunity the government pitches
    if (w.openTurn + (dest.transitWeeks || 0) > state.endTurn) continue;
    const type = dest.id.includes('surface') ? 'lander' : 'probe';
    const d = pushOpportunity(state, data, {
      sub: 'window', type, destination: dest.id, grantShare: 0.1, urgency: 2,
      title: `Janela para ${dest.name}`,
      body: `Os planetas se alinham: a janela para ${dest.name} abre em ${fmtT(state, w.openTurn)} e fecha em ${fmtT(state, w.closeTurn)}. Perder esta significa esperar ${weeksToText(dest.window.periodWeeks)}.`,
    });
    if (d) return d;
  }
  return null;
}

function rivalOpportunity(state, data) {
  const pid = state.playerId;
  for (const s of state.signals || []) {
    if (s.type !== 'mission/resolved' || !s.actorId || s.actorId === pid || s.outcome !== 'total') continue;
    const dest = destDef(data, s.destination);
    if (!dest || dest.body === 'earth') continue;
    // same rule as windowOpportunity: no pitch for a mission that could only arrive after the end of the era
    const w = windowFor(state, data, dest.id, state.turn + (LEAD_WEEKS.probe ?? 8));
    if (w.openTurn >= state.endTurn || w.openTurn + (dest.transitWeeks || 0) > state.endTurn) continue;
    const tryTypes = s.crewed ? ['crewed', 'lander', 'probe'] : [s.missionType, 'lander', 'probe'];
    for (const type of [...new Set(tryTypes)]) {
      if (!TYPES.includes(type) || !destOkForType(dest, type)) continue;
      const d = pushOpportunity(state, data, {
        sub: 'rival', type, destination: dest.id, grantShare: 0.2, declineSupport: 2, urgency: 2,
        title: `Resposta a ${actorName(state, s.actorId)}`,
        body: `${actorName(state, s.actorId)} chegou a ${dest.name}. O governo quer uma resposta à altura e promete ajudar a pagar.`,
      });
      if (d) return d;
    }
  }
  return null;
}

function customOpportunity(state, data, rng) {
  const pool = rng.shuffle(OPPORTUNITIES);
  for (const o of pool) {
    if (!destDef(data, o.destination)) continue;
    if ((state.missions || []).some((m) => m.destination === o.destination && m.type === o.type && !['done', 'cancelled'].includes(m.status))) continue;
    const d = pushOpportunity(state, data, { ...o });
    if (d) return d;
  }
  return null;
}

function opportunities(state, data, ctx) {
  if (hasPendingOpportunity(state)) return;
  const planning = (state.missions || []).filter((m) => m.status === 'planning').length;
  if (planning >= 3) return;
  const last = state.stats?.['missions.lastOpportunityTurn'] ?? -99;
  const rng = ctx.rng('opportunity');
  if (state.turn - last >= 4 && rng.chance(0.5) && rivalOpportunity(state, data)) return;
  if (state.turn - last >= 8 && rng.chance(0.25) && windowOpportunity(state, data)) return;
  if (state.turn - last >= 10 && rng.chance(0.12)) customOpportunity(state, data, rng);
}

/** After a result: offer the natural next step or a retry. Non-blocking. */
function followUp(state, data, m, success) {
  if (hasPendingOpportunity(state) || m.source === 'contract') return;
  if (success) {
    const next = NEXT_STEP[m.destination];
    const dest = destDef(data, next);
    if (!dest) return;
    const type = m.crewed ? 'crewed' : next.includes('surface') || next.includes('pole') ? 'lander' : 'probe';
    pushOpportunity(state, data, {
      sub: 'followup', type, destination: next, crewed: m.crewed, grantShare: 0.1,
      title: `Próximo passo: ${dest.name}`,
      body: `O sucesso de ${m.name} abriu caminho. Os engenheiros já desenham a próxima etapa: ${dest.name}.`,
    });
  } else {
    pushOpportunity(state, data, {
      sub: 'retry', type: m.type, destination: m.destination, crewed: m.crewed, grantShare: 0.15,
      title: `Tentar de novo: ${m.name}`,
      body: 'O seguro cobre parte de uma nova tentativa. A equipe quer provar que aprendeu com a falha.',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Contracts and auctions
// ---------------------------------------------------------------------------------------------

/** Rough market cost of fulfilling a contract (cheapest capable hardware across the catalog). */
function marketCost(state, data, k, payloadT) {
  const dest = destDef(data, k.destination);
  const ops = dest?.opsCostM ?? OPS_COST_BY_KEY[dest?.capacityKey] ?? 10;
  const vehicles = (data.vehicles?.vehicles || []).filter((v) => availableByDate(state, v));
  let scCost = 0;
  let extra = 0;
  if (!k.clientPayload) {
    const scs = (data.spacecraft?.spacecraft || []).filter((s) => availableByDate(state, s) && (SC_KINDS[k.type] || []).includes(s.kind) && scOkForDest(s, k.destination));
    if (!scs.length) return null;
    const cheapest = scs.reduce((a, b) => ((a.costM || 0) <= (b.costM || 0) ? a : b));
    scCost = cheapest.costM || 0;
    extra = cheapest.massT || 0;
  }
  const caps = vehicles.filter((v) => capacityTo(data, v.id, k.destination) * 0.9 >= payloadT + extra);
  if (!caps.length) return null;
  const vc = Math.min(...caps.map((v) => v.costM || 0));
  return vc + scCost + ops;
}

/** Can this actor fly the contract? Returns best vehicle reliability or 0. */
function actorCapability(state, data, actorId, c) {
  const extraMass = c.clientPayload ? 0 : (pickConfig(state, data, { type: c.type, destination: c.destination, actorId })?.payloadT ?? null);
  if (!c.clientPayload && extraMass == null) return 0;
  const need = c.clientPayload ? c.payloadT : extraMass + c.payloadT;
  let best = 0;
  for (const v of vehiclesFor(state, data, actorId)) {
    if (capacityTo(data, v.id, c.destination) * 0.9 < need) continue;
    best = Math.max(best, vehicleReliability(state, data, v.id).mean);
  }
  return best;
}

function bidScore(c, price, reputation, reliability, noise) {
  return 60 * (c.valueM / Math.max(1, price)) + 0.35 * (reputation ?? 50) + 40 * (reliability - 0.8) + noise;
}

const BID_LEVELS = { bid_low: 0.85, bid_mid: 1.0, bid_high: 1.15 };
const BID_LABELS = { bid_low: 'Preço baixo', bid_mid: 'Preço médio', bid_high: 'Preço alto' };

/** Monte-Carlo estimate of the player's win chance per bid level (shown in the card: visible probabilities). */
function winChances(state, c, playerRel) {
  const rng = rngFor(state.seed, 'missions', 'contractEst', c.id);
  const rep = state.actors?.[state.playerId]?.reputation ?? 50;
  const out = {};
  const N = 300;
  const wins = { bid_low: 0, bid_mid: 0, bid_high: 0 };
  for (let i = 0; i < N; i++) {
    let bestRival = -Infinity;
    for (const r of c.rivals) {
      const a = state.actors?.[r.actorId];
      const price = c.valueM * (0.8 + rng.next() * 0.38 - 0.12 * (a?.ai?.aggression ?? 0.5));
      bestRival = Math.max(bestRival, bidScore(c, price, a?.reputation, r.reliability, rng.range(-5, 5)));
    }
    const myNoise = rng.range(-5, 5);
    for (const [k, f] of Object.entries(BID_LEVELS)) {
      if (bidScore(c, c.valueM * f, rep, playerRel, myNoise) > bestRival) wins[k]++;
    }
  }
  for (const k of Object.keys(wins)) out[k] = wins[k] / N;
  return out;
}

function makeContract(state, data, rng) {
  const year = turnToDate(state.turn, state.startYear).year;
  const kinds = CONTRACT_KINDS.filter((k) => destDef(data, k.destination) && (!k.untilYear || year <= k.untilYear) && (!k.fromYear || year >= k.fromYear));
  if (!kinds.length) return null;
  const k = rng.weighted(kinds);
  const payloadT = round1(rng.range(k.payload[0], k.payload[1]));
  const base = marketCost(state, data, k, payloadT);
  if (!base) return null;
  const c = {
    id: nextId(state, 'ctr'),
    kind: k.kind, title: k.title, client: rng.pick(k.clients), body: k.body,
    type: k.type, destination: k.destination, payloadT, clientPayload: !!k.clientPayload,
    valueM: Math.round(base * rng.range(1.25, 1.6)),
    createdTurn: state.turn, closeTurn: state.turn + 4, deadlineTurn: state.turn + rng.int(30, 56),
    status: 'open', rivals: [], playerBid: null, winner: null, winningPrice: null, missionId: null,
    advancePaidM: 0, late: false,
  };
  c.deadlineTurn = Math.min(c.deadlineTurn, state.endTurn);
  // rival bidders: capable actors, hidden bids rolled now (deterministic)
  const bidRng = rngFor(state.seed, 'missions', 'contractBids', c.id);
  const pool = Object.values(state.actors || {}).filter((a) => a.id !== state.playerId);
  const capable = pool.map((a) => ({ a, rel: actorCapability(state, data, a.id, c) })).filter((x) => x.rel > 0);
  for (const { a, rel } of bidRng.shuffle(capable).slice(0, 3)) {
    const price = Math.round(c.valueM * (0.8 + bidRng.next() * 0.38 - 0.12 * (a.ai?.aggression ?? 0.5)));
    c.rivals.push({ actorId: a.id, price, reliability: rel, noise: bidRng.range(-5, 5) });
  }
  return c;
}

function offerContract(state, data, c) {
  const playerRel = actorCapability(state, data, state.playerId, c);
  const chances = playerRel > 0 ? winChances(state, c, playerRel) : {};
  const dest = destDef(data, c.destination);
  const why = 'A agência não tem veículo e nave capazes para esta entrega.';
  const choices = Object.entries(BID_LEVELS).map(([id, f]) => ({
    id, label: `${BID_LABELS[id]} · ${fmtMoney(c.valueM * f)}`,
    preview: playerRel > 0 ? `≈ ${pct(chances[id])} de vencer. ${id === 'bid_low' ? 'Margem apertada.' : id === 'bid_high' ? 'Lucro maior, se ganhar.' : 'Equilíbrio entre preço e lucro.'}` : why,
    disabled: playerRel <= 0, reason: playerRel <= 0 ? why : undefined,
  }));
  choices.push({ id: 'pass', label: 'Não participar', preview: 'Os rivais disputam sozinhos.' });
  const rivals = c.rivals.map((r) => actorName(state, r.actorId)).join(', ') || 'nenhum rival declarado';
  pushDecision(state, {
    kind: 'contract/offer',
    title: `Contrato: ${c.title}`,
    body: `${c.client}. ${c.body}\nCarga: ${String(c.payloadT).replace('.', ',')} t até ${dest?.name || c.destination}. Prazo: ${fmtT(state, c.deadlineTurn)}. Valor de referência: ${fmtMoney(c.valueM)}.\nConcorrentes: ${rivals}. Preço, prazo e reputação decidem.`,
    portrait: null,
    urgency: 1,
    expiresTurn: c.closeTurn,
    defaultChoice: 'pass',
    payload: { contractId: c.id },
    choices,
  });
}

function contractOffers(state, data, ctx) {
  state.contracts = state.contracts || [];
  const open = state.contracts.filter((c) => c.status === 'open' || c.status === 'bidding').length;
  if (open >= 2) return;
  const last = state.contracts.reduce((mx, c) => Math.max(mx, c.createdTurn), -99);
  const rng = ctx.rng('contract');
  if (state.turn - last < 6 || !rng.chance(state.turn < 8 ? 0.35 : 0.22)) return;
  if (state.turn > state.endTurn - 20) return;
  const c = makeContract(state, data, rng);
  if (!c) return;
  state.contracts.push(c);
  offerContract(state, data, c);
  stat(state, 'contractsOffered');
  // keep the slice small
  if (state.contracts.length > 40) {
    const keep = state.contracts.filter((x) => ['open', 'bidding', 'awarded', 'late'].includes(x.status));
    const old = state.contracts.filter((x) => !keep.includes(x)).slice(-20);
    state.contracts = [...old, ...keep];
  }
}

function resolveContractOffer(state, data, dec, choiceId) {
  const c = (state.contracts || []).find((x) => x.id === dec.payload?.contractId);
  if (!c || c.status !== 'open') return { ok: true };
  if (BID_LEVELS[choiceId]) {
    c.playerBid = { level: choiceId, price: Math.round(c.valueM * BID_LEVELS[choiceId]) };
    c.status = 'bidding';
  }
  return { ok: true, contractId: c.id };
}

/** Close auctions whose time has come. */
function closeAuctions(state, data) {
  const pid = state.playerId;
  for (const c of state.contracts || []) {
    if (!['open', 'bidding'].includes(c.status) || state.turn < c.closeTurn) continue;
    const entries = c.rivals.map((r) => ({
      actorId: r.actorId, price: r.price,
      score: bidScore(c, r.price, state.actors?.[r.actorId]?.reputation, r.reliability, r.noise),
    }));
    if (c.playerBid) {
      const rel = actorCapability(state, data, pid, c);
      if (rel > 0) {
        const noise = rngFor(state.seed, 'missions', 'contractPlayer', c.id).range(-5, 5);
        entries.push({ actorId: pid, price: c.playerBid.price, score: bidScore(c, c.playerBid.price, state.actors?.[pid]?.reputation, rel, noise) });
      }
    }
    entries.sort((a, b) => b.score - a.score);
    const win = entries[0];
    if (!win) { c.status = 'expired'; continue; }
    c.winner = win.actorId;
    c.winningPrice = win.price;
    emitSignal(state, 'contract/awarded', { contractId: c.id, winner: win.actorId });
    if (win.actorId === pid) awardToPlayer(state, data, c);
    else {
      c.status = 'closed';
      receive(state, win.actorId, Math.round(win.price * 0.25), 'contracts', c.title);
      changeActor(state, win.actorId, 'reputation', 1);
      addNews(state, {
        headline: `${actorName(state, win.actorId)} vence contrato: ${c.title.charAt(0).toLowerCase() + c.title.slice(1)}`,
        body: c.playerBid ? `A proposta da ${actorName(state, pid)} (${fmtMoney(c.playerBid.price)}) perdeu para ${fmtMoney(win.price)}.` : `Valor: ${fmtMoney(win.price)}.`,
        tags: ['contract'], actors: [win.actorId], importance: c.playerBid ? 2 : 1,
      });
    }
  }
}

function awardToPlayer(state, data, c) {
  const pid = state.playerId;
  c.status = 'awarded';
  const cfg = pickConfig(state, data, {
    type: c.type, destination: c.destination, clientPayload: c.clientPayload,
    extraPayload: c.clientPayload ? 0 : c.payloadT, payloadOverride: c.clientPayload ? c.payloadT : null,
  });
  const draft = {
    name: `Contrato ${(state.stats?.["missions.contractsWon"] || 0) + 1}: ${c.title}`.slice(0, 60), source: 'contract', contractId: c.id, type: c.type, destination: c.destination,
    vehicleId: cfg?.vehicleId || null, spacecraftId: cfg?.spacecraftId || null, clientPayload: c.clientPayload, crewed: false,
    crew: autoCrew(state, data, 0), config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: cfg?.payloadT ?? c.payloadT },
    deadlineTurn: c.deadlineTurn,
  };
  const res = createMission(state, data, draft);
  if (res.ok) c.missionId = res.missionId;
  c.advancePaidM = Math.round(c.winningPrice * 0.2);
  receive(state, pid, c.advancePaidM, 'contracts', `Adiantamento: ${c.title}`);
  changeActor(state, pid, 'reputation', 1);
  addNews(state, {
    headline: `${actorName(state, pid)} vence o contrato: ${c.title.charAt(0).toLowerCase() + c.title.slice(1)}`,
    body: `${fmtMoney(c.winningPrice)}, com ${fmtMoney(c.advancePaidM)} adiantados. Lançamento até ${fmtT(state, c.deadlineTurn)}.`,
    tags: ['contract', 'win'], actors: [pid], importance: 2,
  });
  stat(state, 'contractsWon');
}

function defaultContract(state, data, contractId, why) {
  const c = (state.contracts || []).find((x) => x.id === contractId);
  if (!c || !['awarded', 'late'].includes(c.status)) return;
  const pid = state.playerId;
  c.status = 'defaulted';
  const penalty = Math.round((c.winningPrice || c.valueM) * 0.15);
  pay(state, penalty, `Multa contratual: ${c.title}`);
  changeActor(state, pid, 'reputation', -8);
  changeActor(state, pid, 'support', -2);
  addNews(state, {
    headline: `${actorName(state, pid)} rompe contrato e paga multa de ${fmtMoney(penalty)}`,
    body: why === 'cancel' ? `${c.client} procura outro fornecedor.` : `Prazo estourado. ${c.client} cancela a encomenda.`,
    tags: ['contract', 'default'], actors: [pid], importance: 2,
  });
}

/** Deadlines of contracts the player must fly. */
function contractDeadlines(state, data) {
  const pid = state.playerId;
  for (const c of state.contracts || []) {
    if (!['awarded', 'late'].includes(c.status)) continue;
    const m = missionById(state, c.missionId);
    const flown = m && !['planning', 'scheduled', 'launch', 'cancelled'].includes(m.status);
    if (flown) continue;
    if (c.status === 'awarded' && state.turn > c.deadlineTurn) {
      c.status = 'late';
      c.late = true;
      changeActor(state, pid, 'reputation', -3);
      addNews(state, {
        headline: `${c.client} reclama do atraso da ${actorName(state, pid)}`,
        body: 'A receita cai 30% e a paciência do cliente acaba em três meses.',
        tags: ['contract', 'late'], actors: [pid], importance: 1,
      });
    } else if (c.status === 'late' && state.turn > c.deadlineTurn + 13) {
      if (m && ['planning', 'scheduled', 'launch'].includes(m.status)) {
        m.contractId = null; // the mission itself is gone with the contract
        cancelMission(state, data, m, { reason: 'contract' });
      }
      defaultContract(state, data, c.id, 'late');
    }
  }
}

/** Settle a player contract when its mission reaches a final result. */
function settleContract(state, data, m, level) {
  const c = (state.contracts || []).find((x) => x.id === m.contractId);
  if (!c || !['awarded', 'late'].includes(c.status)) return 0;
  const pid = state.playerId;
  const remaining = Math.max(0, (c.winningPrice || c.valueM) - c.advancePaidM);
  const lateF = c.late ? 0.7 : 1;
  let paid = 0;
  if (level === 'total' || level === 'partial') {
    paid = Math.round(remaining * lateF * (level === 'total' ? 1 : 0.5));
    receive(state, pid, paid, 'contracts', `Entrega: ${c.title}`);
    c.status = 'delivered';
    changeActor(state, pid, 'reputation', level === 'total' ? 2 : 0);
  } else {
    c.status = 'failed';
    changeActor(state, pid, 'reputation', -5);
  }
  c.resolvedTurn = state.turn;
  return paid;
}

// ---------------------------------------------------------------------------------------------
// Launch day, transit, arrival and operations
// ---------------------------------------------------------------------------------------------

const hasArrivalScene = (data, m) => (destDef(data, m.destination)?.arrivalMilestones || []).length > 0;
/** True when a successful ascent still leaves a transit/arrival phase ahead (the ascent is not the final word). */
export const needsTransit = (data, m) => {
  const dest = destDef(data, m.destination);
  return (dest?.transitWeeks || 0) > 0 || (dest?.arrivalMilestones || []).length > 0;
};
const launchPending = (state, missionId) =>
  state.activeLaunch?.missionId === missionId || state.decisions.some((x) => x.kind === 'launch/ready' && x.payload?.missionId === missionId);
const anyLaunchBusy = (state) => !!state.activeLaunch || state.decisions.some((x) => x.kind === 'launch/ready');

function issueCard(state, title, body) {
  pushDecision(state, { kind: 'mission/issue', title, body, urgency: 2, choices: [{ id: 'ok', label: 'Entendido' }] });
}

function pushLaunchReady(state, data, m, phase) {
  const r = riskFor(state, data, m, state.turn);
  m.estimate = estimateOf(r);
  const dest = destDef(data, m.destination);
  const v = vehicleDef(data, m.vehicleId);
  const fd = state.crew?.[m.crew?.flightDirector];
  const cmd = state.crew?.[m.crew?.commander];
  const team = [fd && `${fd.gender === "f" ? "Diretora" : "Diretor"} de voo: ${fd.name}`, cmd && `Comandante: ${cmd.name}`].filter(Boolean).join(' · ');
  const band = `Chance estimada: ${pct(m.estimate.low)} a ${pct(m.estimate.high)}.`;
  const card = phase === 'arrival'
    ? {
      title: `Chegada: ${m.name}`,
      body: `${m.name} se aproxima de ${dest?.name || m.destination}. A sala de controle está a postos.\n${band}${team ? `\n${team}` : ''}`,
      choices: [{ id: 'go', label: 'Acompanhar a chegada', preview: 'Abre a sala de controle.' }],
    }
    : {
      title: `Dia de Lançamento: ${m.name}`,
      body: `${v?.name || 'O foguete'} está na plataforma, destino ${dest?.name || m.destination}.\n${band}${team ? `\n${team}` : ''}`,
      choices: [
        { id: 'go', label: 'Ir para a sala de controle', preview: 'Escalação, contagem e lançamento.' },
        { id: 'scrub', label: 'Adiar 1 a 2 semanas', preview: 'Custa um pouco de apoio.' },
      ],
    };
  pushDecision(state, { kind: 'launch/ready', ...card, portrait: cmd ? { crewId: cmd.id } : fd ? { crewId: fd.id } : null, urgency: 3, blocking: true, payload: { missionId: m.id, phase } });
}

/** Launch-day checks: crew still available, window still open, hardware still accessible. */
function launchDay(state, data, m) {
  const pid = state.playerId;
  // drop crew that died, left or got injured since planning
  const okP = (id) => state.crew?.[id] && (!state.crew[id].status || state.crew[id].status === 'active');
  const dropped = crewIdsOf(m).filter((id) => !okP(id));
  if (m.crew.flightDirector && !okP(m.crew.flightDirector)) m.crew.flightDirector = null;
  if (dropped.length) {
    if (m.crew.commander && !okP(m.crew.commander)) m.crew.commander = null;
    m.crew.astronauts = m.crew.astronauts.filter(okP);
  }
  // missed planetary window → slip to the next one
  const w = windowFor(state, data, m.destination, state.turn, m.calendarId);
  if (Number.isFinite(w.closeTurn) && !inWindow(w, state.turn)) {
    const next = windowFor(state, data, m.destination, state.turn, m.calendarId).openTurn;
    m.status = 'scheduled';
    m.launchTurn = next;
    m.windowTurn = next;
    changeActor(state, pid, 'support', -3);
    addNews(state, {
      headline: `${m.name} perde a janela de lançamento`,
      body: `Próxima oportunidade só em ${fmtT(state, next)}. O atraso custa caro em apoio político.`,
      tags: ['mission', 'window'], actors: [pid], importance: 2,
    });
    if (next > state.endTurn) issueCard(state, `${m.name}: janela perdida`, 'A próxima janela fica fora do horizonte do cenário. Considere cancelar e recuperar parte do dinheiro.');
    return false;
  }
  // fleet grounded after a recent failure (calendar.recordFlight): wait for the return to flight
  const grounded = fn(calendar, 'isGrounded');
  if (grounded && grounded(state, m.vehicleId)) {
    const until = state.vehicleStats?.[m.vehicleId]?.groundedUntil ?? state.turn + 4;
    const veh = vehicleDef(data, m.vehicleId);
    m.status = 'scheduled';
    m.launchTurn = Math.min(state.endTurn, until + 1);
    addNews(state, {
      headline: `${m.name} espera: ${veh?.name || 'o foguete'} está em terra após uma falha`,
      body: `A investigação deve liberar a frota em ${fmtT(state, until + 1)}. Dá para trocar de lançador no planejamento.`,
      tags: ['mission', 'grounded'], actors: [pid], importance: 2,
    });
    return false;
  }
  const v = validate(state, data, m, { schedule: false, missionId: m.id });
  if (v.errors.length) {
    m.status = 'planning';
    m.launchTurn = null;
    issueCard(state, `Lançamento suspenso: ${m.name}`, `${v.errors.join('\n')}\nA missão voltou ao planejamento; o valor já pago continua valendo.`);
    addNews(state, { headline: `${m.name} sai da plataforma: problemas de última hora`, tags: ['mission'], actors: [pid], importance: 1 });
    return false;
  }
  return true;
}

function launchTick(state, data) {
  for (const m of state.missions || []) {
    if (!['scheduled', 'launch'].includes(m.status) || m.launchTurn == null) continue;
    if (m.launchTurn > state.turn) { if (m.status === 'launch' && !launchPending(state, m.id)) m.status = 'scheduled'; continue; }
    if (launchPending(state, m.id) || anyLaunchBusy(state)) continue;
    if (!launchDay(state, data, m)) continue;
    m.status = 'launch';
    pushLaunchReady(state, data, m, 'ascent');
  }
}

const FAILURE_WEIGHTS = [
  { id: 'propulsion', weight: 3 }, { id: 'software', weight: 3 }, { id: 'environment', weight: 2 }, { id: 'structure', weight: 1.5 }, { id: 'human', weight: 1 },
];

/** Simple arrival roll for destinations without an arrival scene. */
function rollArrival(state, data, m, rng) {
  const dest = destDef(data, m.destination);
  const surface = /surface|pole/.test(m.destination || '');
  let p = surface ? 0.88 : 0.95;
  p += surface ? techBonus(state, 'landingReliability') : techBonus(state, 'reliability') * 0.5;
  p += m.config?.strategy === 'conservative' ? 0.02 : m.config?.strategy === 'aggressive' ? -0.03 : 0;
  const mod = riskModOf(state, m);
  p += mod + ((m.config?.fuelMargin ?? 0.1) - 0.1) * 0.15;
  p = clamp(p, 0.3, 0.995);
  const r = rng.next();
  let level = 'total';
  if (r >= p) level = r < p + (1 - p) * 0.45 ? 'partial' : m.crewed && r > p + (1 - p) * 0.92 ? 'catastrophic' : 'recoverable';
  const failureType = level === 'total' ? null : rng.weighted(FAILURE_WEIGHTS).id;
  const causes = [{ kind: 'luck', label: surface ? 'Descida e pouso' : 'Inserção no destino', detail: `chance estimada de ${pct(p)} em ${dest?.name || m.destination}`, weight: 1 }];
  if (failureType) causes.push({ kind: failureType === 'environment' ? 'environment' : 'part', label: `Falha de ${FAILURE_LABELS[failureType]}`, detail: '', weight: 1 });
  if (mod < 0) causes.push({ kind: 'decision', label: 'Danos sofridos no trânsito', detail: '', weight: 0.5 });
  return { level, failureType, causes, headline: null, crewLost: [] };
}

function transitTick(state, data, ctx) {
  for (const m of state.missions || []) {
    if (m.status === 'transit' && m.transit) {
      if (state.turn >= m.transit.arriveTurn) {
        m.status = 'arrival';
      } else {
        maybeOperationEvent(state, data, m, m.transit, ctx, 0.07);
        continue;
      }
    }
    if (m.status === 'arrival') {
      if (hasArrivalScene(data, m)) {
        if (!launchPending(state, m.id) && !anyLaunchBusy(state)) pushLaunchReady(state, data, m, 'arrival');
      } else {
        onLaunchResolved(state, data, m.id, 'arrival', rollArrival(state, data, m, ctx.rng(`arrival:${m.id}`)));
      }
    } else if (m.status === 'operations' && m.ops) {
      if (state.turn >= m.ops.untilTurn) endOperations(state, data, m);
      else maybeOperationEvent(state, data, m, m.ops, ctx, 0.05);
    }
  }
}

function maybeOperationEvent(state, data, m, stage, ctx, p) {
  const pick = fn(narrative, 'pickOperationEvent');
  if (!pick) return;
  stage.events = stage.events || [];
  if (stage.events.length >= 2 || state.turn - (stage.departTurn ?? stage.startTurn ?? 0) < 1) return;
  const rng = ctx.rng(`op:${m.id}`);
  if (!rng.chance(p)) return;
  const ev = pick(state, data, m, rng);
  if (ev?.eventId) stage.events.push({ turn: state.turn, eventId: ev.eventId });
}

function endOperations(state, data, m) {
  const sci = Math.round(m.ops.science || 0);
  if (sci > 0) addScience(state, sci, m);
  if (m.result) m.result.science = (m.result.science || 0) + sci;
  m.status = 'done';
  addNews(state, {
    headline: `${m.name} encerra operações${sci ? ` com ${sci} pontos de ciência` : ''}`,
    tags: ['mission', 'done'], actors: [state.playerId], importance: 1,
  });
}

function addScience(state, n, m) {
  const f = fn(research, 'addSciencePoints');
  if (f) f(state, n, `Missão ${m.name}`);
}

// ---------------------------------------------------------------------------------------------
// Result impact
// ---------------------------------------------------------------------------------------------

const destPrestige = (dest) => outcomeDestPrestige(dest);

function mainRival(state) {
  const pid = state.playerId;
  let best = null;
  for (const id of Object.keys(state.actors || {})) {
    if (id === pid) continue;
    const relF = fn(diplomacy, 'relation');
    const rel = (relF ? relF(state, pid, id) : null) || state.relations?.[relKey(pid, id)];
    const r = rel?.rivalry ?? 0;
    if (!best || r > best.r) best = { id, r };
  }
  return best && best.r > 0 ? best.id : null;
}

/** pt-BR label for a milestone id: our vocabulary, then scenario goals, then the raw id. */
function milestoneLabel(data, id) {
  const base = String(id).split(":")[0];
  const goal = (data.scenario?.victory?.goals || []).find((g) => g.id === base);
  return MILESTONE_LABELS[base] || data.calendar?.milestoneLabels?.[base] || goal?.label?.toLowerCase() || base.replace(/_/g, " ");
}

const fill = (t, vars) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// Era 4 tone: bloc rivalry, lunar dust, urgency. Data templates (politics.json missionHeadlines) win when present.
const HEADLINES = {
  first: ['{actor} faz história: {milestone}', 'Primeira vez: {actor} conquista: {milestone}', '{mission} coloca a {actor} na frente da corrida lunar'],
  total: ['{mission}: sucesso total para a {actor}', '{actor} acerta em cheio com {mission}', '{mission} cumpre o plano e reforça a {actor} na corrida'],
  partial: ['{mission} cumpre parte dos objetivos', 'Sucesso parcial para {mission}; engenheiros analisam desvio', '{mission} chega, mas não como planejado'],
  recoverable: ['{mission} falha, mas a {actor} salva o essencial', 'Falha de {failure} interrompe {mission}', 'Revés para a {actor}: {mission} não cumpre a missão'],
  catastrophic: ['Perdemos {mission}: falha de {failure}', 'Desastre: {mission} põe o programa da {actor} em xeque', 'Fim abrupto para {mission}; investigação começa hoje'],
  death: ['Luto na {actor}: tripulação de {mission} morre em acidente', 'Tragédia: {mission} termina com {deaths} morte(s)', 'O mundo para: a {actor} perde astronautas em {mission}'],
  transit: ['{mission} deixa a Terra rumo {to}', '{mission} a caminho; chegada prevista em {arrive}'],
  rival: ['{rival} reage: "a corrida não acabou"', '{rival} promete acelerar o próprio programa', 'Pressão sobe na {rival} depois do feito da {actor}'],
};
function headline(state, data, key, vars, rng) {
  const custom = data.politics?.missionHeadlines?.[key];
  const pool = Array.isArray(custom) && custom.length ? custom : HEADLINES[key];
  return fill(rng.pick(pool), vars);
}

/**
 * Called by launch at the end of each scene (and by missions for arrivals without a scene).
 * outcome = { level, failureType, causes, headline?, crewLost? }
 */
export function onLaunchResolved(state, data, missionId, phase = 'ascent', outcome = {}) {
  const m = missionById(state, missionId);
  if (!m || m.status === 'done' || m.status === 'cancelled') return null;
  const pid = state.playerId;
  const rng = rngFor(state.seed, 'missions', 'resolve', missionId, phase, state.turn);
  const level = LEVELS.includes(outcome?.level) ? outcome.level : 'recoverable';
  const failureType = level === 'total' ? null : outcome?.failureType || null;
  const success = level === 'total' || level === 'partial';
  const dest = destDef(data, m.destination);
  const vars = {
    actor: actorName(state, pid), mission: m.name, dest: dest?.name || m.destination, to: dest?.toLabel || `a ${dest?.name || m.destination}`,
    failure: FAILURE_LABELS[failureType] || 'origem desconhecida',
  };
  const headlines = [];
  if (outcome?.headline) headlines.push(outcome.headline);

  // --- flight record + crew ---
  if (phase === 'ascent') {
    m.attempts = (m.attempts || 0) + 1;
    const rf = fn(calendar, 'recordFlight');
    if (rf && m.vehicleId) rf(state, m.vehicleId, success);
    emitSignal(state, 'mission/launched', { missionId: m.id, actorId: pid });
    stat(state, 'launched');
  }
  const alive = crewIdsOf(m).filter((id) => state.crew?.[id]?.status !== 'dead');
  const apply = fn(crewMod, 'applyMissionToCrew');
  if (apply) apply(state, data, m, { ...outcome, level, failureType, phase });
  const deadIds = [...new Set([...alive.filter((id) => state.crew?.[id]?.status === 'dead'), ...(outcome?.crewLost || [])])];

  // --- next status ---
  m.phases = m.phases || [];
  m.phases.push({ phase, outcome: level, failureType, turn: state.turn });
  const launchedTurn = phase === 'ascent' ? state.turn : m.result?.launchedTurn ?? m.launchTurn;
  let final = true;
  if (phase === 'ascent' && success && needsTransit(data, m)) {
    final = false;
    const weeks = Math.max(1, dest?.transitWeeks || 0);
    m.status = 'transit';
    m.transit = { departTurn: state.turn, arriveTurn: state.turn + weeks, events: [] };
    if (level === 'partial') m.riskMod = (m.riskMod || 0) - 0.05; // wrong orbit: less margin at arrival
  } else if (success) {
    const opsWeeks = m.crewed ? OPS_WEEKS.crewed : OPS_WEEKS[m.type] ?? 2;
    m.status = opsWeeks > 0 ? 'operations' : 'done';
    if (opsWeeks > 0) m.ops = { startTurn: state.turn, untilTurn: state.turn + opsWeeks, events: [], science: 0 };
  } else {
    m.status = 'done';
  }

  // --- prestige, firsts, science, support (decisive phase only) ---
  let prestige = 0;
  let science = 0;
  const firsts = [];
  let rivalLine = null;
  if (!final) {
    // the launch scene already wrote the departure headline: the transit line only replaces a missing one
    if (!outcome?.headline) headlines.push(headline(state, data, 'transit', { ...vars, arrive: fmtT(state, m.transit.arriveTurn) }, rng));
    changeActor(state, pid, 'support', 1);
    if (level === 'partial') headlines.push(`${m.name} entra em órbita abaixo do previsto; margem reduzida para a chegada`);
  } else {
    const p0 = m.estimate?.p ?? 0.8;
    const strategy = outcome?.lineup?.strategy || m.config?.strategy || 'balanced';
    const stratMult = STRATEGY_PRESTIGE[strategy] ?? 1;
    // repetition is less newsworthy: diminishing returns per earlier success at the same destination
    const repeats = (state.missions || []).filter((x) => x.id !== m.id && x.destination === m.destination && !!x.crewed === !!m.crewed
      && ['operations', 'done'].includes(x.status) && ['total', 'partial'].includes(x.result?.outcome)).length;
    // contract deliveries are a service: they pay in cash and reputation more than in prestige
    // (same scale as the AI's calendar results: core/outcome.js missionPrestige)
    // a calendar program flagged "contract" (a bought delivery, such as CLPS) pays like a contract, same as for the AI
    const bought = m.source === 'contract' || (m.calendarId && !!calDef(data, m.calendarId)?.contract);
    const mp = missionPrestige(dest, { crewed: !!m.crewed, level, p: p0, repeats, strategyMult: stratMult, contract: bought });
    const { base, novelty, bold } = mp;
    // a probe inherited in flight (paid before 2026) pays only a share of the prestige: calendar.js, same rule
    const share = m.inheritedTransit ? (fn(calendar, 'inheritedShare')?.(data) ?? 0.35) : 1;
    const routine = (dest?.body ?? 'earth') === 'earth' && !m.crewed;
    if (success) {
      prestige = Math.round(mp.prestige * share);
      changeActor(state, pid, 'prestige', prestige);
      // "Os Primeiros": destination firsts, calendar milestone, national crewed orbit
      // (crewed_orbit_national is per actor: handled below with its ":<actorId>" key)
      // the program milestone only counts if the flight really is that program (not a LEO hop renamed Artemis IV)
      const programOk = matchesCalendar(data, m);
      const ms = [...[].concat((m.crewed ? dest?.firsts?.crewed : dest?.firsts?.robotic) ?? []), programOk ? m.milestone : null].filter((id) => id && !String(id).startsWith('crewed_orbit_national'));
      for (const id of [...new Set(ms)]) {
        if (state.firsts?.[id]?.actorId === pid || (state.stats?.[`missions.reached.${id}`] || 0) > 0) continue;
        stat(state, `reached.${id}`);
        const firstPts = Math.round((30 + Math.round(base)) * share * milestoneShare(data, id));
        const laterPts = Math.round(5 * share);
        const wasFirst = claimFirst(state, id, pid, firstPts, laterPts);
        prestige += wasFirst ? firstValue(state, id, firstPts) : laterPts;
        if (wasFirst) { firsts.push(id); emitSignal(state, 'first', { milestoneId: id, actorId: pid }); }
      }
      const natKey = `crewed_orbit_national:${pid}`;
      if (m.crewed && !state.firsts?.[natKey]) {
        claimFirst(state, natKey, pid, 15, 0);
        prestige += 15;
        firsts.push(natKey);
        emitSignal(state, 'first', { milestoneId: natKey, actorId: pid });
      }
      // science: part now, the rest at the end of operations
      const sci = (SCIENCE_BASE[m.crewed ? 'crewed' : m.type] ?? 5) * (dest?.scienceMult ?? SCIENCE_BODY[dest?.body] ?? 1) * (1 + techBonus(state, 'sciencePerMission')) * (level === 'total' ? 1 : 0.5);
      science = Math.round(sci * (m.ops ? 0.6 : 1));
      if (science > 0) addScience(state, science, m);
      if (m.ops) m.ops.science = Math.round(sci - science);
      // support / reputation / culture: bold missions pay off more
      changeActor(state, pid, 'support', level === 'total' ? Math.round((1 + base / 8 + bold * 4) * novelty) : routine ? 0 : 1);
      changeActor(state, pid, 'reputation', level === 'total' && novelty >= 0.4 ? 1 : 0);
      if (level === 'total' && strategy === 'aggressive') changeActor(state, pid, 'culture', 3);
      stat(state, level === 'total' ? 'success' : 'partial');
    } else {
      const heavy = level === 'catastrophic';
      changeActor(state, pid, 'support', -Math.round(heavy ? 6 + base / 5 : 3 + base / 8));
      changeActor(state, pid, 'reputation', heavy ? -5 : -2);
      if (heavy) changeActor(state, pid, 'culture', -4);
      stat(state, 'failed');
    }
    if (deadIds.length) {
      changeActor(state, pid, 'support', -(10 + 4 * (deadIds.length - 1)));
      changeActor(state, pid, 'reputation', -6);
      changeActor(state, pid, 'culture', -5);
      stat(state, 'crewLost', deadIds.length);
    }
    // headlines
    if (deadIds.length) headlines.unshift(headline(state, data, 'death', { ...vars, deaths: deadIds.length }, rng));
    else if (firsts.length) {
      const fid = firsts.find((f) => !f.includes(':')) || firsts[0];
      const label = milestoneLabel(data, fid);
      headlines.unshift(headline(state, data, 'first', { ...vars, milestone: label }, rng));
    }
    if (!outcome?.headline || headlines.length < 2) headlines.push(headline(state, data, level, vars, rng));
    const rival = mainRival(state);
    if (rival && success && (firsts.length || prestige >= 10)) headlines.push((rivalLine = headline(state, data, 'rival', { ...vars, rival: actorName(state, rival) }, rng)));

    // linked calendar item + contract
    const inst = m.calendarId ? (state.calendar || []).find((c) => c.id === m.calendarId) : null;
    if (inst && !matchesCalendar(data, m)) {
      // flew something else under the program's name: the program itself never happened
      if (inst.status === 'player') { inst.status = 'cancelled'; inst.resolvedTurn = state.turn; }
    } else if (inst) {
      inst.status = level === 'total' ? 'success' : level === 'partial' ? 'partial' : 'failed';
      inst.outcome = { level, failureType };
      inst.resolvedTurn = state.turn;
    }
    if (m.contractId) {
      const paid = settleContract(state, data, m, level);
      if (paid > 0) headlines.push(`Cliente satisfeito: ${fmtMoney(paid)} entram no caixa`);
    }
    followUp(state, data, m, success && !deadIds.length);
  }

  const prevPrestige = m.result?.prestige || 0;
  const prevScience = m.result?.science || 0;
  m.result = {
    outcome: level, failureType, causes: outcome?.causes || [], phase, launchedTurn, resolvedTurn: state.turn,
    prestige: prevPrestige + prestige, science: prevScience + science, headlines: [...new Set(headlines)].slice(0, 4), firsts, crewLost: deadIds,
  };

  // news feed
  const top = m.result.headlines[0];
  // routine repeats (3rd+ uneventful success to the same Earth orbit) are log-only: the feed is for news
  const routineRepeat = final && level === 'total' && !firsts.length && !deadIds.length && (dest?.body ?? 'earth') === 'earth' && !m.crewed
    && (state.missions || []).filter((x) => x.id !== m.id && x.destination === m.destination && !x.crewed && x.result?.outcome === 'total').length >= 2;
  if (top && routineRepeat) log(state, `missions: ${top}`);
  else if (top) {
    addNews(state, {
      headline: top,
      body: [
        [
          final ? `Resultado: ${LEVEL_LABELS[level]}.` : `Subida: ${LEVEL_LABELS[level]}.`,
          prestige ? `+${prestige} prestígio.` : '',
          science ? `+${science} ciência.` : '',
        ].filter(Boolean).join(' '),
        (outcome?.causes || []).slice(0, 2).map((c) => c.label).filter(Boolean).join(' · '),
      ].filter(Boolean).join('\n'),
      tags: ['mission', level, phase], actors: [pid], importance: deadIds.length || firsts.length || level === 'catastrophic' ? 3 : 2,
    });
    // one headline per event; a rival's reaction is news only when a first changed the race
    const reaction = firsts.length && rivalLine && rivalLine !== top ? rivalLine : null;
    if (reaction) addNews(state, { headline: reaction, tags: ['mission', 'reaction'], actors: [pid], importance: 1 });
  }

  emitSignal(state, 'mission/resolved', {
    missionId: m.id, calendarId: m.calendarId || null, actorId: pid, destination: m.destination, missionType: m.type, // NOT "type": emitSignal spreads payload over the signal type
    crewed: !!m.crewed, outcome: level, failureType, phase, final,
  });
  return { status: m.status, final, prestige, science, firsts, headlines: m.result.headlines };
}

// ---------------------------------------------------------------------------------------------
// Builder query (3 steps)
// ---------------------------------------------------------------------------------------------

/** Everything the 3-step builder needs for a partial draft. Pure; never throws on partial input. */
export function draftOptions(state, data, draftIn = {}) {
  const d = { ...normalizeDraft(draftIn), riskMod: 0 };
  const existing = draftIn.missionId ? missionById(state, draftIn.missionId) : null;
  if (Number.isFinite(existing?.createdTurn)) d.createdTurn = existing.createdTurn;
  const pid = state.playerId;
  const cash = state.actors?.[pid]?.cash ?? 0;
  const types = TYPES.map((t) => ({ id: t, label: TYPE_LABELS[t], selected: t === d.type }));

  const destinations = destList(data).map((x) => {
    const w = windowFor(state, data, x.id, state.turn);
    return {
      id: x.id, name: x.name, body: x.body, kind: x.kind, transitWeeks: x.transitWeeks || 0, prestige: destPrestige(x),
      route: x.route || [], hasArrival: (x.arrivalMilestones || []).length > 0,
      valid: d.type ? destOkForType(x, d.type) : true,
      window: Number.isFinite(w.closeTurn) ? { openTurn: w.openTurn, closeTurn: w.closeTurn, open: inWindow(w, state.turn) } : null,
      firsts: x.firsts || {}, selected: x.id === d.destination,
    };
  });

  const payloadT = payloadOf(data, d);
  const vehicles = vehiclesFor(state, data).map((v) => {
    const rel = vehicleReliability(state, data, v.id);
    const cap = d.destination ? effectiveCapacity(state, data, v.id, d.destination, d.config.fuelMargin) : { raw: 0, eff: 0 };
    const reasons = [];
    if (d.destination && cap.raw <= 0) reasons.push('Não alcança o destino.');
    else if (d.destination && cap.eff < payloadT) reasons.push(`Capacidade ${String(cap.eff).replace('.', ',')} t < carga ${String(round1(payloadT)).replace('.', ',')} t.`);
    if (d.crewed && !v.crewRated) reasons.push('Sem certificação para tripulação.');
    return {
      id: v.id, name: v.name, operator: v.operator, operatorName: actorName(state, v.operator), costM: round1((v.costM || 0) * Math.max(0.3, 1 + techBonus(state, 'launchCost'))),
      capacityT: cap.raw, effectiveCapacityT: cap.eff, crewRated: !!v.crewRated, reusable: !!v.reusable, truthLayer: v.truthLayer,
      reliability: { mean: rel.mean, low: rel.low, high: rel.high, flights: rel.flights ?? null, band: reliabilityBand(rel) },
      valid: reasons.length === 0 && (!!d.destination || true), reasons, selected: v.id === d.vehicleId,
    };
  }).sort((a, b) => (b.valid - a.valid) || (a.costM - b.costM));

  const spacecraft = spacecraftFor(state, data).map((s) => {
    const reasons = [];
    if (d.type && !(d.source === 'calendar' && s.id === d.spacecraftId) && !scOkForType(s, d.type, d.crewed)) reasons.push(d.crewed ? 'Não leva tripulação.' : 'Tipo incompatível.');
    if (d.destination && !scOkForDest(s, d.destination)) reasons.push('Não serve para este destino.');
    if (d.vehicleId && Array.isArray(s.compatibleVehicles) && s.compatibleVehicles.length && !s.compatibleVehicles.includes(d.vehicleId)) {
      const names = s.compatibleVehicles.map((id) => vehicleDef(data, id)?.name || id);
      reasons.push(`Só voa no ${names.join(' ou ')}.`);
    }
    const rel = spacecraftReliability(state, data, s.id);
    return {
      id: s.id, name: s.name, operator: s.operator, kind: s.kind, crew: s.crew || 0, massT: s.massT ?? null, costM: s.costM || 0,
      reliability: { mean: rel.mean, low: rel.low, high: rel.high }, truthLayer: s.truthLayer,
      valid: reasons.length === 0, reasons, selected: s.id === d.spacecraftId,
    };
  }).sort((a, b) => (b.valid - a.valid) || (a.costM - b.costM));

  const companionId = companionOf(state, data, d);
  const landers = needsLander(data, d) || d.secondarySpacecraftId
    ? landerChoices(state, data, d).map((s) => {
      const rel = spacecraftReliability(state, data, s.id);
      return { id: s.id, name: s.name, operator: s.operator, crew: s.crew || 0, costM: s.costM || 0, reliability: { mean: rel.mean, low: rel.low, high: rel.high }, selected: s.id === companionId };
    })
    : [];
  const sc2 = spacecraftDef(data, companionId);
  const companion = sc2 ? { id: sc2.id, name: sc2.name, kind: sc2.kind, costM: sc2.costM || 0, required: needsLander(data, d) } : null;

  const busy = busyCrew(state, draftIn.missionId);
  const crew = {
    flightDirector: rosterFor(state, 'flight_director').map((p) => candidate(p, {})),
    commander: d.crewed ? rosterFor(state, 'astronaut').map((p) => candidate(p, busy)) : [],
    astronauts: d.crewed ? rosterFor(state, 'astronaut').map((p) => candidate(p, busy)) : [],
  };

  const v = validate(state, data, d, { schedule: true, launchTurn: Number.isFinite(draftIn.launchTurn) ? draftIn.launchTurn : undefined, missionId: draftIn.missionId, paid: !!draftIn.paid });
  let estimate = null;
  try {
    const r = riskFor(state, data, d, v.launchTurn);
    estimate = { p: r.p, low: r.low ?? r.p, high: r.high ?? r.p, factors: r.factors || [], warnings: r.warnings || [], milestones: r.milestones || [] };
    for (const e of r.errors || []) if (!v.errors.includes(e)) v.errors.push(e);
    // same advice worded twice (missions + risk): keep the first
    for (const w of r.warnings || []) if (!v.warnings.some((x) => x === w || x.slice(0, 18) === w.slice(0, 18))) v.warnings.push(w);
  } catch (e) {
    estimate = null;
  }
  const w = v.window;
  return {
    draft: d,
    autoName: d.name ? null : nameFor(state, data, d),
    types,
    destinations,
    vehicles,
    spacecraft,
    landers,
    companion,
    crew,
    seats: v.seats,
    payloadT: round1(v.payloadT),
    capacityT: v.capacity.eff,
    cost: v.cost,
    cash,
    affordable: cash >= v.cost.total,
    leadWeeks: leadWeeks(d),
    earliestLaunchTurn: v.earliest,
    launchTurn: v.launchTurn,
    window: w ? { openTurn: w.openTurn, closeTurn: Number.isFinite(w.closeTurn) ? w.closeTurn : null, inWindow: inWindow(w, v.launchTurn) } : null,
    estimate,
    errors: v.errors,
    warnings: v.warnings,
    valid: v.errors.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Module interface
// ---------------------------------------------------------------------------------------------

export function init(state, data) {
  state.missions = state.missions || [];
  state.contracts = state.contracts || [];
  state.stats = state.stats || {};
  // probes already flying on day one show up in the Missions tab before the first advance (calendar.init ran earlier)
  if (data && Array.isArray(state.calendar)) adoptTransitPrograms(state, data);
}

export function tick(state, data, ctx) {
  state.missions = state.missions || [];
  state.contracts = state.contracts || [];
  contractDeadlines(state, data);
  closeAuctions(state, data);
  adoptTransitPrograms(state, data);
  launchTick(state, data);
  transitTick(state, data, ctx);
  calendarBriefings(state, data);
  strandedMissions(state, data);
  opportunities(state, data, ctx);
  contractOffers(state, data, ctx);
  // keep estimates fresh (research, crew and reliability change over time)
  if (state.turn % 4 === 0) {
    for (const m of state.missions) if (m.status === 'planning' || m.status === 'scheduled') m.estimate = estimateOf(riskFor(state, data, m, m.launchTurn ?? undefined));
  }
}

/**
 * Planning missions that can no longer launch before the end (earliest launch >= endTurn). Program missions
 * (hardware date and destination locked) are cancelled with no political cost; custom/contract missions get the
 * `stranded` flag and one card, since another destination or hardware may still save them.
 */
function strandedMissions(state, data) {
  const end = state.endTurn;
  if (!Number.isFinite(end)) return;
  const year = turnToDate(end, state.startYear).year;
  for (const m of state.missions) {
    if (m.status !== 'planning') { if (m.stranded && m.status !== 'cancelled') m.stranded = false; continue; }
    let lt;
    try { lt = earliestLaunch(state, data, m); } catch { continue; }
    if (lt < end) { if (m.stranded) m.stranded = false; continue; }
    if (m.source === 'calendar') {
      const res = cancelMission(state, data, m, { reason: 'stranded', penalty: false });
      if (!res.ok) continue;
      m.stranded = true;
      const inst = (state.calendar || []).find((c) => c.id === m.calendarId);
      if (inst) inst.beyondEnd = true;
      issueCard(state, `${m.name}: não voa antes do fim de ${year}`,
        `O hardware e a janela do programa só permitem lançar depois do fim de ${year}. A missão saiu do planejamento sem custo político.${res.refund ? ` Reembolso: ${fmtMoney(res.refund)}.` : ''}`);
    } else if (!m.stranded) {
      m.stranded = true;
      issueCard(state, `${m.name}: sem data possível`,
        `Com o preparo e a janela atuais, o primeiro lançamento seria depois do fim de ${year}. Troque destino ou hardware, ou cancele a missão.`);
    }
  }
}

const PRIVILEGED_DRAFT_KEYS = ['grantM', 'grantShare', 'milestone', 'calendarId', 'contractId', 'deadlineTurn', 'targetTurn', 'readyTurn', 'clientPayload'];
/** A draft as the player may send it: no grants, no program/contract links, always a custom mission. */
export function publicDraft(draft) {
  const d = { ...(draft && typeof draft === 'object' ? draft : {}) };
  for (const k of PRIVILEGED_DRAFT_KEYS) delete d[k];
  d.source = 'custom';
  return d;
}

const getM = (state, action) => {
  const m = missionById(state, action.missionId);
  return m ? { m } : { err: { ok: false, error: 'Missão não encontrada.' } };
};

export const actions = {
  // public entry point: privileged fields (grants, program/contract links, milestones) only come from briefings and contracts
  'mission/create': (state, data, action) => createMission(state, data, publicDraft(action.draft)),
  'mission/update': (state, data, action) => {
    const { m, err } = getM(state, action);
    return err || updateMission(state, data, m, action.patch || {});
  },
  'mission/schedule': (state, data, action) => {
    const { m, err } = getM(state, action);
    return err || scheduleMission(state, data, m, action.launchTurn);
  },
  'mission/cancel': (state, data, action) => {
    const { m, err } = getM(state, action);
    return err || cancelMission(state, data, m);
  },
  'mission/estimate': (state, data, action) => {
    const d = { ...normalizeDraft(action.draft || {}), riskMod: 0 };
    const r = riskFor(state, data, d, action.draft?.launchTurn);
    return { ok: true, estimate: { p: r.p, low: r.low ?? r.p, high: r.high ?? r.p, factors: r.factors || [], warnings: r.warnings || [], errors: r.errors || [] } };
  },
};

export const decisionHandlers = {
  briefing: (state, data, dec, choiceId) => {
    if (dec.payload?.kind === 'calendar') return resolveCalendarBriefing(state, data, dec, choiceId);
    if (choiceId === 'accept' && dec.payload?.draft) return createMission(state, data, dec.payload.draft);
    if (choiceId === 'decline' && dec.payload?.kind === 'rival') changeActor(state, state.playerId, 'support', -2);
    return { ok: true };
  },
  'contract/offer': (state, data, dec, choiceId) => resolveContractOffer(state, data, dec, choiceId),
  'mission/issue': () => ({ ok: true }),
};

function decorate(state, data, m) {
  const dest = destDef(data, m.destination);
  return {
    ...m,
    statusLabel: STATUS_LABELS[m.status] || m.status,
    typeLabel: TYPE_LABELS[m.type] || m.type,
    destinationName: dest?.name || m.destination,
    vehicleName: m.vehicleName || (m.calendarId && data?.index?.calendar?.[m.calendarId]?.vehicleName) || vehicleDef(data, m.vehicleId)?.name || null,
    spacecraftName: spacecraftDef(data, m.spacecraftId)?.name || null,
    launchDate: m.launchTurn != null ? fmtT(state, m.launchTurn) : null,
    arriveDate: m.transit ? fmtT(state, m.transit.arriveTurn) : null,
    contract: m.contractId ? (state.contracts || []).find((c) => c.id === m.contractId) || null : null,
  };
}

const STATUS_ORDER = { launch: 0, arrival: 1, scheduled: 2, transit: 3, operations: 4, planning: 5, done: 6, cancelled: 7 };

export const queries = {
  'missions/list': (state, data) =>
    (state.missions || []).map((m) => decorate(state, data, m)).sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || (b.createdTurn - a.createdTurn)),
  'missions/get': (state, data, id) => {
    const m = missionById(state, id);
    if (!m) return null;
    const out = decorate(state, data, m);
    if (m.status === 'planning' || m.status === 'scheduled') {
      const v = validate(state, data, m, { schedule: m.status === 'planning', missionId: m.id, paid: m.paid, launchTurn: m.launchTurn ?? undefined });
      out.check = { errors: v.errors, warnings: v.warnings, earliestLaunchTurn: v.earliest, cost: v.cost };
    }
    return out;
  },
  'missions/draftOptions': (state, data, draft) => draftOptions(state, data, draft || {}),
  // Next window for a destination, or (no destId) the earliest window whose mission still arrives by the end of the
  // scenario. `late`: launching in it the craft arrives after the end (or it opens after the end) — `lateText` is the
  // pt-BR warning the UI shows; with no reachable window at all the earliest one comes back marked late.
  'missions/nextWindow': (state, data, destId, fromTurn) => {
    const from = Number.isFinite(fromTurn) ? fromTurn : state.turn;
    const end = Number.isFinite(state.endTurn) ? state.endTurn : Infinity;
    const endYear = Number.isFinite(end) ? turnToDate(end, state.startYear).year : null;
    const one = (x) => {
      const w = windowFor(state, data, x.id, from);
      const launchTurn = Math.max(state.turn, from, w.openTurn);
      const arrivalTurn = launchTurn + (x.transitWeeks || 0);
      const late = launchTurn >= end || arrivalTurn > end;
      return {
        destination: x.id, name: x.name, openTurn: w.openTurn, closeTurn: Number.isFinite(w.closeTurn) ? w.closeTurn : null,
        weeks: Math.max(0, w.openTurn - state.turn), open: inWindow(w, state.turn),
        launchTurn, arrivalTurn, late,
        lateText: late ? `Não dá para chegar antes do fim de ${endYear}: ${launchTurn >= end ? 'a janela abre depois do fim do cenário' : `chegada só em ${fmtT(state, arrivalTurn)}`}.` : null,
      };
    };
    if (destId) {
      const x = destDef(data, destId);
      return x ? one(x) : null;
    }
    const list = destList(data).filter((x) => x.window).map(one).filter((w) => w.closeTurn != null);
    list.sort((a, b) => a.openTurn - b.openTurn || a.arrivalTurn - b.arrivalTurn);
    return list.find((w) => !w.late) || list[0] || null;
  },
  'missions/contracts': (state) =>
    (state.contracts || []).slice().reverse().map((c) => {
      const closed = !['open', 'bidding'].includes(c.status);
      return {
        ...c,
        rivals: c.rivals.map((r) => ({ actorId: r.actorId, name: actorName(state, r.actorId), price: closed ? r.price : null })),
        deadline: fmtT(state, c.deadlineTurn),
      };
    }),
};

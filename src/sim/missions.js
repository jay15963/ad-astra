// Missions module [missions]: the player's mission lifecycle.
//   briefing → planning → scheduled → launch → (transit → arrival) → operations → done | cancelled
// Also: the contract tender board (bids against rival AIs, tela Contratos), opportunity briefings, the 3-step builder
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
import { clamp, nextId, addNews, pushDecision, removeDecision, emitSignal, claimFirst, firstValue, milestoneShare, changeActor, log, relKey, achievedAny } from '../core/helpers.js';
import { rngFor } from '../core/rng.js';
import { destPrestige as outcomeDestPrestige, missionPrestige } from '../core/outcome.js';
import { turnToDate, formatTurn, weeksToText } from '../core/time.js';
import { vehicleDef as catalogVehicle, spacecraftDef as catalogCraft } from '../core/catalog.js';
import { crossed, yearAt, destinationOpen, liveActorIds } from './simtime.js';

// Missões v2 (docs/MISSIONS-V2.md §5): the player's research gate. gating.js is pure core code (no sim imports), so it
// is awaited here without any cycle risk; a missing file (builders working in parallel) leaves every mission ungated.
const optionalModule = (p) => import(p).catch((e) => {
  const missing = e?.code === 'ERR_MODULE_NOT_FOUND' || /Failed to fetch|Importing a module script failed|error loading dynamically imported module|Cannot find module/i.test(String(e?.message));
  if (!missing) throw e;
  return null;
});
const gatingModule = await optionalModule('../core/gating.js');

// ---------------------------------------------------------------------------------------------
// Tunables and vocabularies (generic rules; content names live in data/*.json)
// ---------------------------------------------------------------------------------------------

// Missões v2 taxonomy (§1.1): "Pouso" is gone as a type — a probe sent to a surface is the landing, a rover is the
// long-lived surface mission. `lander`/`landing` stay forever as aliases of probe/lander (old saves, data, programs).
export const TYPES = ['satellite', 'probe', 'rover', 'crewed', 'cargo', 'station'];
export const LEGACY_TYPES = Object.freeze({ lander: Object.freeze({ type: 'probe', sub: 'lander' }), landing: Object.freeze({ type: 'probe', sub: 'lander' }) });
export const TYPE_LABELS = {
  satellite: 'Satélite', probe: 'Sonda', rover: 'Rover', crewed: 'Tripulada', cargo: 'Carga', station: 'Estação',
};
/** Payload kinds of §1.4 (vocab.payloadKinds). `client` is privileged: contracts only. */
export const PAYLOAD_KINDS = ['supply', 'experiments', 'station_module', 'base_module', 'base_vehicle', 'propellant', 'servicing', 'client'];

/**
 * Resolve a (possibly legacy) mission type: 'lander' → {type: 'probe', sub: 'lander'}. Accepts a string or an object
 * with {type, sub}. Unknown types come back as {type: null}. Pure; used for drafts, calendar items, AI programs, saves.
 */
export function missionTypeOf(raw, sub = null) {
  const t = raw && typeof raw === 'object' ? raw.type : raw;
  const s = raw && typeof raw === 'object' ? raw.sub ?? sub : sub;
  const alias = LEGACY_TYPES[t];
  if (alias) return { type: alias.type, sub: typeof s === 'string' && s ? s : alias.sub };
  return { type: TYPES.includes(t) ? t : null, sub: typeof s === 'string' && s ? s : null };
}
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
  rover: ['lunar_surface', 'lunar_south_pole', 'mars_surface', 'titan'],
};
// Spacecraft kinds that can fly each mission type (data/core/missions.json types[].scKinds overrides).
const SC_KINDS = {
  satellite: ['satellite'],
  probe: ['probe', 'lander', 'satellite'],
  rover: ['rover'],
  crewed: ['capsule', 'lander', 'habitat'],
  cargo: ['cargo', 'capsule', 'lander'],
  station: ['station_module'],
};
// Difficulty → base prestige: core/outcome.js destPrestige (shared with the AI's calendar results).
const GENERIC_COST_SCALE = { leo: 1, gto: 1.2, tli: 1.6, mars: 2.4, outer: 4 };
const OPS_COST_BY_KEY = { leo: 6, gto: 5, tli: 35, mars: 60, outer: 90 }; // US$ mi, operations + ground segment
const SCIENCE_BASE = { satellite: 6, probe: 40, rover: 30, crewed: 20, cargo: 3, station: 25 };
const SCIENCE_BODY = { earth: 1, moon: 1.5, mars: 2.2, jupiter: 2.8, saturn: 3 };
const OPS_WEEKS = { satellite: 0, probe: 10, rover: 4, crewed: 2, cargo: 1, station: 8 };
const LEAD_WEEKS = { satellite: 6, probe: 10, rover: 12, crewed: 12, cargo: 6, station: 14 };
const ROTATION_WEEKS = 26; // a crew rotation keeps its people on the station/base this long (missions.json rotationWeeks)
const SERVICING_KIT_T = 0.5;
const DEFAULT_EXPERIMENTS_T = 1;
// cargo a carrier holds when its data has no cargoT: share of its own mass (§1.4)
const CARGO_SHARE = { cargo: 0.35, capsule: 0.35, lander: 0.25, habitat: 0.2 };
// payload kinds that ride inside a carrier (station/base modules fly themselves only when type is station)
const CARRIED_KINDS = ['supply', 'experiments', 'base_module', 'base_vehicle', 'propellant', 'servicing'];
const SURFACE_KINDS = ['surface', 'atmosphere'];
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

// Contracts and opportunities live in data/core/contracts.json (MISSIONS-V2.md §2): rows with eligibility rules
// (date, someone already reached the place, a concrete asset to supply, the player's research, relations). These
// fallbacks are used only when the file is absent (in-memory test data); they follow the same rules.
const FALLBACK_CONTRACTS = [
  { id: 'gto_comms', kind: 'gto_comms', type: 'satellite', sub: 'comms', destination: 'gto', clientPayload: true, payload: [3, 6.5], weight: 3,
    title: 'Satélite de comunicações para GTO',
    clients: ['Operadora de telecom do Sudeste Asiático', 'Consórcio europeu de banda larga', 'Operadora latino-americana de TV', 'Rede de satélites do Golfo'],
    body: 'Um satélite geoestacionário precisa de carona até a órbita de transferência. O cliente quer preço, prazo e um foguete confiável.',
    needs: { fromYear: 1965, firstsAny: ['first_geostationary_satellite'] } },
  { id: 'sso_obs', kind: 'sso_obs', type: 'satellite', sub: 'earth_obs', destination: 'sso', clientPayload: true, payload: [0.5, 2.5], weight: 2,
    title: 'Constelação de observação em órbita polar',
    clients: ['Startup de imagens de radar', 'Agência ambiental regional', 'Seguradora agrícola'],
    body: 'Um lote de satélites de observação precisa de lançamento em órbita heliossíncrona.',
    needs: { fromYear: 1972, firstsAny: ['first_weather_satellite'] } },
  { id: 'station_supply', kind: 'station_supply', type: 'cargo', sub: 'supply', payload: [1, 2.5], weight: 3,
    title: 'Suprimentos para {asset}', clients: ['{owner}'],
    body: 'A reserva de {asset} está baixa: comida, água, peças de reposição e experimentos precisam subir. Atraso aqui vira manchete.',
    target: { assetKind: 'station', owner: 'other', status: ['active', 'degraded'], supplyBelow: 0.6 },
    needs: { fromYear: 1978, playerKeys: ['missionType:cargo', 'missionType:docking'], relation: { minTrust: 10 }, noTensionAbove: 2 } },
  { id: 'lunar_delivery', kind: 'lunar_delivery', type: 'cargo', sub: 'experiments', destinations: ['lunar_surface', 'lunar_south_pole'], payload: [0.3, 1.2], weight: 2, carrier: 'lander',
    title: 'Entrega de carga útil na Lua',
    clients: ['Programa de cargas lunares comerciais', 'Universidade com instrumento sísmico', 'Mineradora de olho no regolito'],
    body: 'Instrumentos científicos precisam pousar na superfície lunar. É dinheiro bom e risco alto: pouso lunar ainda falha muito.',
    needs: { fromYear: 2018, firstsAny: ['lunar_surface_robotic'] } },
];
const FALLBACK_OPPORTUNITIES = [
  { id: 'comms', sub: 'comms', type: 'satellite', destination: 'gto', grantShare: 0.3, needs: { fromYear: 1965 },
    title: 'Satélite de comunicações nacional', body: 'O ministério das comunicações quer um satélite próprio em órbita geoestacionária e topa dividir a conta.' },
  { id: 'lunar_orbiter', sub: 'orbiter', type: 'probe', destination: 'lunar_orbit', grantShare: 0.2, needs: { fromYear: 1966 },
    title: 'Orbitador lunar de mapeamento', body: 'Cientistas pedem um orbitador para mapear gelo nas crateras. Os dados valem ouro para quem quer pousar depois.' },
  { id: 'lunar_lander', sub: 'lander', type: 'probe', destination: 'lunar_surface', grantShare: 0.15, needs: { fromYear: 1966 },
    title: 'Pousador lunar de demonstração', body: 'Engenheiros querem provar a tecnologia de pouso antes das missões grandes. Falhar aqui custa menos que falhar depois.' },
  { id: 'crewed_demo', sub: 'orbital', type: 'crewed', destination: 'leo', grantShare: 0.1, needs: { fromYear: 1961 },
    title: 'Voo tripulado de demonstração', body: 'O governo quer astronautas no noticiário. Um voo curto em órbita baixa mantém a tripulação afiada e o público atento.' },
];
const CONTRACT_CAPS = { openOffers: 2, perAssetWeeks: 26, minGapWeeks: 6 };


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

// ---------------------------------------------------------------------------------------------
// Phase B peers (EXPANSION.md §5.2, §6, §14 B5). investors.js (B2) and designs.js (B3) import this module for
// createMandateMission / the test-flight API, so a static import back would be a cycle that breaks while either
// file is missing. They are bound late instead: `bindPeers({ investors, designs })` (engine.js, after its imports,
// or the peers themselves). Unbound peers are tolerated: every call below has a fallback or is optional, and the
// 'mission/resolved' signal carries mandateId/holderId/designId for modules that prefer to listen.
// ---------------------------------------------------------------------------------------------

// Missões v2 adds three peers (MISSIONS-V2.md §3.8, §5, §8.5): infra.js (assets: stations, bases, fleets, rovers),
// market.js (treaty access, production queue) and gating.js (research gate; also imported above when present).
// infra/market import missions-adjacent modules, so they are never imported statically here: they bind themselves
// (`missions.bindPeers({ infra: self })`, like investors.js) and a lazy import below binds them as a fallback.
const peers = { investors: null, designs: null, infra: null, market: null, gating: gatingModule };
/** Late binding of the Phase B / Missões v2 modules. Pass only the ones that exist; null unbinds (tests). */
export function bindPeers(p = {}) {
  for (const k of Object.keys(peers)) if (k in p) peers[k] = p[k] || null;
  return { ...peers };
}
const peerFn = (name, f) => (typeof peers[name]?.[f] === 'function' ? peers[name][f] : null);
// fallback binding of the v2 sim peers (never awaited: no evaluation cycle; a missing file is simply not bound)
for (const [k, p] of [['infra', './infra.js'], ['market', './market.js']]) {
  optionalModule(p).then((mod) => { if (mod && peers[k] === null && !boundOff.has(k)) peers[k] = mod; }, () => {});
}
const boundOff = new Set(); // peers a test unbound explicitly (bindPeers({infra: null})) are not re-bound by the lazy import
/** Tests: unbind a v2 peer and keep the lazy import from binding it again. */
export function unbindPeer(name) { boundOff.add(name); peers[name] = null; }

// --- player designs (B3, state.designs) as launch vehicles ---------------------------------------
// A design flies through the same catalog as any rocket: its vehicle view is published into data.index.vehicles
// (so calendar.capacityTo/vehicleReliability, risk.js and launch.js resolve it without knowing designs exist) and
// operational designs join the player's vehicle list. Derived from state only: same state → same catalog.

/** state.designs as a list, whatever the container (id map, array, {list}). */
export function designList(state) {
  const raw = state?.designs;
  if (!raw || typeof raw !== 'object') return [];
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.list) ? raw.list : Array.isArray(raw.items) ? raw.items
    : Object.entries(raw).filter(([, d]) => d && typeof d === 'object' && !Array.isArray(d)).map(([id, d]) => (d.id ? d : { ...d, id }));
  return arr.filter((d) => d && typeof d === 'object' && d.id);
}
export const designPhase = (d) => d?.program?.phase || (d?.operational ? 'operational' : null);
export const isDesignId = (state, id) => !!id && designList(state).some((d) => d.id === id);

/** Vehicle definition of a design (B3's own `asVehicle` first, else built from `derived`), or null. */
export function designVehicle(state, d) {
  if (!d) return null;
  const own = d.asVehicle && typeof d.asVehicle === 'object' ? d.asVehicle : d.kind === 'vehicle' ? d : null;
  const der = d.derived || {};
  const capacity = own?.capacity || der.capacity;
  if (!capacity || typeof capacity !== 'object') return null;
  // B3's asVehicle is kept whole (launch-render reads its `design` geometry); the flags below gate it here instead of
  // its `retired` (a design under test flies its own test flights, so it must resolve as an in-service rocket)
  return {
    ...(own || {}),
    id: d.id, name: own?.name || d.name || d.id, operator: own?.operator || d.owner || state?.playerId || null, access: 'own',
    capacity, costM: Number(own?.costM ?? der.costM) || 0,
    estimatedReliability: Number.isFinite(own?.estimatedReliability) ? own.estimatedReliability : Number.isFinite(der.reliabilityPrior) ? der.reliabilityPrior : 0.85,
    reusable: !!(own?.reusable ?? d.reusable), crewRated: !!own?.crewRated, heightM: own?.heightM ?? der.heightM ?? null, diaM: own?.diaM ?? der.diaM ?? null,
    truthLayer: own?.truthLayer || 'jogador', retired: false, availableFrom: null, availableUntil: null,
    playerDesign: true, designId: d.id, designPhase: designPhase(d), baseVehicleId: d.baseVehicleId || null,
  };
}

/** Successful test flights of a design so far (B3 counts successes in `testOk`, attempts in `testFlights`). */
export const testsPassed = (d) => Number(d?.program?.testOk ?? d?.program?.testFlights) || 0;
/** True when designs.js (B3) manages the design (it writes `asVehicle`): its tick then counts our test missions. */
const managedByB3 = (d) => !!d?.asVehicle;

/** Player-owned designs that resolve to a vehicle: [{design, def}]. */
function playerDesignVehicles(state) {
  const pid = state?.playerId;
  const out = [];
  for (const d of designList(state)) {
    if (d.owner && d.owner !== pid) continue;
    if (d.retired || d.archived) continue;
    const def = designVehicle(state, d);
    if (def) out.push({ design: d, def });
  }
  return out;
}

const INJECTED = new WeakMap(); // data.index.vehicles table -> Set of design ids this module put there

/** Publish the player's design vehicles into data.index.vehicles (and drop the ones no longer in state). */
export function syncDesignCatalog(state, data) {
  const idx = data?.index;
  if (!idx || typeof idx !== 'object') return;
  const list = playerDesignVehicles(state);
  let mine = idx.vehicles ? INJECTED.get(idx.vehicles) : null;
  if (!list.length && !mine?.size) return;
  const table = idx.vehicles || (idx.vehicles = {});
  if (!mine) INJECTED.set(table, (mine = new Set()));
  const want = new Set(list.map((x) => x.def.id));
  for (const id of [...mine]) if (!want.has(id)) { delete table[id]; mine.delete(id); }
  for (const { def } of list) {
    if (table[def.id] && !mine.has(def.id)) continue; // a real catalog entry (or B3's own) wins
    table[def.id] = def;
    mine.add(def.id);
  }
}

/** Operational designs of the player: they join the vehicle list of every mission. */
function operationalDesigns(state) {
  return playerDesignVehicles(state).filter((x) => designPhase(x.design) === 'operational').map((x) => x.def);
}

// single catalog lookup (src/core/catalog.js): Phase B player designs resolve here without touching the callers
const vehicleDef = (data, id, state) => catalogVehicle(data, id, state);
const spacecraftDef = (data, id, state) => catalogCraft(data, id, state);
const destDef = (data, id) => (id ? data.index?.destinations?.[id] ?? data.destinations?.destinations?.find((v) => v.id === id) ?? null : null);
const calDef = (data, id) => data.index?.calendar?.[id] ?? data.calendar?.missions?.find((v) => v.id === id) ?? null;
const destList = (data) => data.destinations?.destinations || [];
const actorName = (state, id) => state.actors?.[id]?.short || state.actors?.[id]?.name || id;
const missionById = (state, id) => (state.missions || []).find((m) => m.id === id) || null;
const fmtT = (state, t) => formatTurn(t, state.startYear);
const fmtTons = (t) => String(round1(t)).replace('.', ',');

// ---------------------------------------------------------------------------------------------
// Missões v2 data: subtypes, payloads, modules (data/core/missions.json, data/core/modules.json)
// ---------------------------------------------------------------------------------------------

const MDATA = new WeakMap(); // data → resolved missions tables (data is immutable during play)
/** Mission tables of §1: data/core/missions.json when loaded, else the code defaults (types, derive rules). */
function mtables(data) {
  const key = data && typeof data === 'object' ? data : null;
  if (key && MDATA.has(key)) return MDATA.get(key);
  const md = data?.missions && typeof data.missions === 'object' && !Array.isArray(data.missions) ? data.missions : {};
  const subs = Array.isArray(md.subtypes) ? md.subtypes.filter((r) => r && r.id && r.type) : [];
  const byType = {};
  for (const r of subs) (byType[r.type] || (byType[r.type] = [])).push(r);
  const out = {
    has: subs.length > 0,
    types: md.types || {},
    derive: md.derive || DEFAULT_DERIVE,
    subs, byType,
    payloadKinds: md.payloadKinds || {},
    carrierShare: { ...CARGO_SHARE, ...(md.carrier?.cargoShare || {}) },
    rotationWeeks: md.rotationWeeks || {},
    supplyCost: Array.isArray(md.supplyCostPerT) ? md.supplyCostPerT : [{ fromYear: 0, costM: 20 }],
    firsts: Array.isArray(md.firsts) ? md.firsts : [],
  };
  if (key) MDATA.set(key, out);
  return out;
}
// derivation of the subtype when the draft does not name one (§1.2): "Sonda + superfície" is the landing
const DEFAULT_DERIVE = {
  probe: { byKind: { surface: 'lander', atmosphere: 'atmospheric', flyby: 'flyby', orbit: 'orbiter', rendezvous: 'small_body', interstellar: 'interstellar', station: 'orbiter' }, default: 'orbiter' },
  satellite: { bySc: true, default: 'science' },
  rover: { bySc: true, default: 'medium' },
  crewed: { byKind: { station: 'rotation', surface: 'landing' }, otherBody: 'flyby', default: 'orbital' },
  cargo: { byKind: { station: 'supply', surface: 'experiments' }, client: 'client', default: 'supply' },
  station: { default: 'found' },
};
/** Subtype row of (type, sub), or null. */
export function subtypeOf(data, type, sub) {
  if (!type || !sub) return null;
  return (mtables(data).byType[type] || []).find((r) => r.id === sub) || null;
}
/** Subtype rows of a type (data order). */
export function subtypesFor(data, type) {
  return (mtables(data).byType[type] || []).slice();
}
const typeRow = (data, type) => mtables(data).types?.[type] || null;
const scKindsFor = (data, type) => (Array.isArray(typeRow(data, type)?.scKinds) ? typeRow(data, type).scKinds : SC_KINDS[type] || []);

/** Does a destination satisfy a subtype's `dest` rule? ids are an alternative to the other criteria. */
export function subDestOk(row, dest) {
  const r = row?.dest;
  if (!r || !dest) return true;
  if (Array.isArray(r.ids) && r.ids.includes(dest.id)) return true;
  const crit = ['kinds', 'bodies', 'earth', 'capacityKeys'].filter((k) => r[k] != null);
  if (!crit.length) return !(Array.isArray(r.ids) && r.ids.length);
  if (Array.isArray(r.kinds) && !r.kinds.includes(dest.kind)) return false;
  if (Array.isArray(r.bodies) && !r.bodies.includes(dest.body)) return false;
  if (typeof r.earth === 'boolean' && ((dest.body ?? 'earth') === 'earth') !== r.earth) return false;
  if (Array.isArray(r.capacityKeys) && !r.capacityKeys.includes(dest.capacityKey)) return false;
  return true;
}
/** Can this craft fly the subtype? Satellites and rovers carry `sub`; untagged (generic) craft fly `genericOk` subtypes. */
function scOkForSub(data, sc, type, sub) {
  if (!sc || !sub) return true;
  if (type !== 'satellite' && type !== 'rover') return true;
  const row = subtypeOf(data, type, sub);
  if (!row) return true;
  if (sc.sub) return sc.sub === sub || (Array.isArray(sc.subs) && sc.subs.includes(sub));
  if (Array.isArray(sc.subs)) return sc.subs.includes(sub);
  return !!row.genericOk;
}

/** The subtype a draft flies: its own (when given), else derived from client payload / target / craft / destination. */
export function resolveSub(state, data, d) {
  if (!d?.type) return null;
  if (typeof d.sub === 'string' && d.sub) return d.sub;
  const rules = mtables(data).derive?.[d.type] || DEFAULT_DERIVE[d.type] || {};
  const dest = destDef(data, d.destination);
  if (d.type === 'cargo' && d.clientPayload) return rules.client || 'client';
  if (d.type === 'cargo' && d.payload?.kind && d.payload.kind !== 'client' && subtypeOf(data, 'cargo', d.payload.kind)) return d.payload.kind;
  if (d.type === 'station') return d.payload?.targetAssetId || dest?.kind === 'station' ? 'expand' : 'found';
  if (d.type === 'crewed' && d.payload?.targetAssetId) {
    const a = assetOf(state, d.payload.targetAssetId);
    if (a?.kind === 'satellite') return 'servicing';
    if (a) return 'rotation';
  }
  const sc = spacecraftDef(data, d.spacecraftId, state);
  if (rules.bySc && sc?.sub && (!mtables(data).has || subtypeOf(data, d.type, sc.sub))) return sc.sub;
  if (dest) {
    if (rules.byId?.[dest.id]) return rules.byId[dest.id];
    if (rules.byCapacityKey?.[dest.capacityKey]) return rules.byCapacityKey[dest.capacityKey];
    if (rules.byKind?.[dest.kind]) return rules.byKind[dest.kind];
    if (rules.otherBody && (dest.body ?? 'earth') !== 'earth') return rules.otherBody;
  }
  if (d.type === 'rover' || d.type === 'satellite') {
    // first subtype this craft (or a generic craft) can fly at this destination
    const fit = subtypesFor(data, d.type).find((r) => subDestOk(r, dest) && (!sc || scOkForSub(data, sc, d.type, r.id)));
    if (fit) return fit.id;
  }
  return rules.default || null;
}

/** Payload kind a draft carries: its own, else the subtype's (§1.4); station modules for station missions. */
function payloadKindOf(data, d, sub = d?.sub) {
  if (d?.payload?.kind) return d.payload.kind;
  if (d?.type === 'station') return 'station_module';
  if (d?.type === 'cargo') {
    if (d.clientPayload) return 'client';
    return subtypeOf(data, 'cargo', sub)?.payload || (['supply', 'experiments', 'base_module', 'base_vehicle', 'propellant', 'servicing'].includes(sub) ? sub : null);
  }
  return null;
}

// --- modules and surface vehicles (data/core/modules.json, owner infrastructure-sim) ---
function moduleRows(data, kind) {
  const M = data?.modules || {};
  return Array.isArray(M[kind]) ? M[kind] : [];
}
/** Station or base module row by id (null when unknown). */
export function moduleDef(data, id) {
  if (!id) return null;
  return moduleRows(data, 'station').find((x) => x?.id === id) || moduleRows(data, 'base').find((x) => x?.id === id) || null;
}
const moduleKindOf = (data, id) => (moduleRows(data, 'station').some((x) => x?.id === id) ? 'station' : moduleRows(data, 'base').some((x) => x?.id === id) ? 'base' : null);
/** Surface vehicle type row (modules.json vehicles) by id. */
export function surfaceVehicleDef(data, id) {
  if (!id) return null;
  return moduleRows(data, 'vehicles').find((x) => x?.id === id) || null;
}
const moduleLabel = (m) => m?.label || m?.name || m?.id || 'módulo';

// --- assets (infra.js) ---
const infraBound = () => !!peerFn('infra', 'deliver');
function assetOf(state, id) {
  if (!id) return null;
  const f = peerFn('infra', 'assetById');
  if (f) { try { return f(state, id) || null; } catch { return null; } }
  return (state?.assets?.list || []).find((a) => a?.id === id) || null;
}
/** Deliverable targets for a draft (infra.targetsFor), own first; [] without infra. */
function targetsOf(state, data, d, sub) {
  const f = peerFn('infra', 'targetsFor');
  if (!f || !d?.type || !d.destination) return [];
  try {
    const r = f(state, data, { type: d.type, sub, destination: d.destination, payloadKind: payloadKindOf(data, d, sub) }, state.playerId);
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}
/** Does this subtype need an existing asset (rotation, supply, expand, servicing, propellant)? */
function needsTargetKinds(data, type, sub) {
  const row = subtypeOf(data, type, sub);
  if (Array.isArray(row?.needsTarget)) return row.needsTarget;
  if (type === 'station' && sub === 'expand') return ['station'];
  return null;
}
/**
 * The asset a draft delivers to: the explicit one, else (when the subtype needs one) the first deliverable target at
 * the destination — own assets first, then partners/historical stations (a crewed flight to the ISS targets the ISS).
 * null when founding a new asset or when no target applies.
 */
function resolvedTargetId(state, data, d, sub) {
  const p = d?.payload || {};
  if (p.targetAssetId) return p.targetAssetId;
  if (p.newAsset || (d?.type === 'station' && sub === 'found')) return null;
  const need = needsTargetKinds(data, d.type, sub);
  const dest = destDef(data, d.destination);
  const pk = payloadKindOf(data, d, sub);
  const docksAtStation = dest?.kind === 'station' && ['crewed', 'cargo', 'station'].includes(d.type);
  const baseCargo = d.type === 'cargo' && ['base_module', 'base_vehicle', 'experiments'].includes(pk) && SURFACE_KINDS.includes(dest?.kind);
  if (!need && !docksAtStation && !baseCargo) return null;
  const list = targetsOf(state, data, d, sub).filter((t) => t?.assetId && (!need || need.includes(t.kind)));
  const pick = (xs) => xs.find((t) => t.ownerId === state.playerId) || xs[0] || null;
  const okList = list.filter((t) => t.ok !== false);
  const own = okList.find((t) => t.ownerId === state.playerId);
  if (own) return own.assetId;
  // someone else's asset only when the mission must dock/deliver there; an unreachable one is still picked so that
  // validate shows why ("Precisa de uma parceria de estação com ...")
  if (need || docksAtStation) return (pick(okList) || pick(list))?.assetId || null;
  return null;
}

/** Era price of one tonne of supplies (missions.json supplyCostPerT). */
function supplyCostPerT(state, data) {
  const y = yearAt(state);
  let v = 20;
  for (const r of mtables(data).supplyCost) if (y >= (r.fromYear ?? 0)) v = Number(r.costM) || v;
  return v;
}
/** Cargo tonnes a craft carries (data cargoT, else a share of its own mass). */
export function cargoCapacityOf(data, sc) {
  if (!sc) return 0;
  if (Number.isFinite(sc.cargoT)) return sc.cargoT;
  const share = mtables(data).carrierShare[sc.kind];
  return Number.isFinite(share) ? round1((sc.massT || 0) * share) : 0;
}
/** Mass of what the draft carries (not the carrier): module, vehicles, tonnes of supplies, kit, experiments. */
function cargoMassOf(state, data, d, kind = payloadKindOf(data, d)) {
  const p = d?.payload || {};
  const sc = spacecraftDef(data, d?.spacecraftId, state);
  switch (kind) {
    case 'station_module':
      if (sc?.kind === 'station_module') return 0; // a module craft is its own payload
      return (moduleDef(data, p.moduleId)?.massT || 0) * Math.max(0.5, 1 + techBonus(state, 'moduleMass'));
    case 'base_module': return (moduleDef(data, p.moduleId)?.massT || 0) * Math.max(0.5, 1 + techBonus(state, 'moduleMass'));
    case 'base_vehicle': return (surfaceVehicleDef(data, p.vehicleTypeId)?.massT || 0) * (p.qty || 1);
    case 'supply': case 'propellant': return p.qty || 1;
    case 'servicing': return SERVICING_KIT_T;
    case 'experiments': return Number.isFinite(p.massT) ? p.massT : DEFAULT_EXPERIMENTS_T;
    case 'client': return Number.isFinite(p.massT) ? p.massT : 0;
    default: return 0;
  }
}

function stat(state, key, delta = 1) {
  state.stats = state.stats || {};
  state.stats[`missions.${key}`] = (state.stats[`missions.${key}`] || 0) + delta;
}

/** Effective crew rating (data flag or a certification earned in play: calendar.isCrewRated). */
function crewRatedV(state, data, v) {
  if (!v) return false;
  const f = fn(calendar, 'isCrewRated');
  return f ? f(state, data, v) : !!v.crewRated;
}

function techBonus(state, key) {
  if (!state) return 0;
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
  const base = Array.isArray(r) ? r : (data.vehicles?.vehicles || []).filter((v) => availableByDate(state, v));
  if (actorId !== state.playerId) return base;
  const own = operationalDesigns(state).filter((v) => !base.some((x) => x.id === v.id));
  return own.length ? base.concat(own) : base;
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
/** Destination open in the current year (a station exists only between its dates: ISS until 2030). */
const destOpenNow = (state, dest) => !!dest && destinationOpen(dest, yearAt(state));

function destOkForType(dest, type) {
  if (!dest || !type) return false;
  const custom = dest.missionTypes || dest.types;
  if (Array.isArray(custom) && custom.length) {
    if (custom.includes(type)) return true;
    // legacy lists ("lander"): the landing is a probe now, and a surface reachable by a lander takes a rover too
    if (custom.includes('lander')) return type === 'probe' || (type === 'rover' && SURFACE_KINDS.includes(dest.kind));
    return false;
  }
  if ((TYPE_DESTS[type] || []).includes(dest.id)) return true;
  // Missões v2 (§3.3): a station destination takes crews, cargo and new modules (expanding the station there)
  if (dest.kind === 'station' && ['crewed', 'cargo', 'station'].includes(type)) return true;
  // orbits flagged stationOk can host a new station (§3)
  if (type === 'station' && dest.stationOk === true) return true;
  // probes land on any default surface; rovers go wherever a probe can land
  return type === 'rover' && SURFACE_KINDS.includes(dest.kind) && (TYPE_DESTS.probe || []).includes(dest.id);
}
function scOkForType(sc, type, crewed, data = null) {
  if (!sc) return false;
  if (crewed) return (sc.crew || 0) > 0;
  return (data ? scKindsFor(data, type) : SC_KINDS[type] || []).includes(sc.kind);
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

/** Normalize draft.payload (§1.4). Always an object; unknown kinds become null. */
export function normalizePayload(p) {
  const x = p && typeof p === 'object' ? p : {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const kind = PAYLOAD_KINDS.includes(x.kind) ? x.kind : null;
  const qty = num(x.qty);
  const massT = num(x.massT);
  const name = typeof x.newAssetName === 'string' && x.newAssetName.trim() ? x.newAssetName.trim().slice(0, 32) : null;
  return {
    kind,
    moduleId: typeof x.moduleId === 'string' && x.moduleId ? x.moduleId : null,
    vehicleTypeId: typeof x.vehicleTypeId === 'string' && x.vehicleTypeId ? x.vehicleTypeId : null,
    qty: kind === 'base_vehicle' ? clamp(Math.round(qty ?? 1), 1, 4) : round1(clamp(qty ?? 1, 0.1, 400)),
    targetAssetId: typeof x.targetAssetId === 'string' && x.targetAssetId ? x.targetAssetId : null,
    newAsset: !!x.newAsset,
    newAssetName: name,
    ...(massT != null && massT > 0 ? { massT: round1(massT) } : {}),
  };
}

/** Normalize a (partial) draft coming from the UI or from a briefing/contract. */
export function normalizeDraft(d = {}) {
  const cfg = d.config || {};
  const crew = d.crew || {};
  const rt = missionTypeOf(d.type, d.sub);
  const type = rt.type;
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 60) : null,
    type,
    sub: type && rt.sub ? String(rt.sub).slice(0, 40) : null,
    payload: normalizePayload(d.payload),
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
    source: ['calendar', 'custom', 'contract', 'cert', 'test'].includes(d.source) ? d.source : 'custom',
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
    // Phase B links (privileged: never from a public draft): investor mandate (B2), design under test (B3)
    mandateId: d.mandateId || null,
    holderId: d.holderId || null,
    testDesignId: d.testDesignId || null,
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

/**
 * Mass the launcher lifts (§1.4): an explicit config.payloadT (contracts, ballast, client payloads) wins; else the
 * carrier's own mass (none for a station module flying itself) plus what it carries.
 */
function payloadOf(data, d, state = null) {
  if (d.config?.payloadT) return d.config.payloadT;
  const sc = spacecraftDef(data, d.spacecraftId, state);
  const kind = payloadKindOf(data, d);
  const carrier = sc ? sc.massT ?? 1 : d.type === 'station' && d.payload?.moduleId ? 0 : 1;
  return round1(carrier + cargoMassOf(state, data, d, kind));
}

/** Effective capacity of vehicle to destination after research bonus and fuel margin. */
function effectiveCapacity(state, data, vehicleId, destId, fuelMargin) {
  const raw = capacityTo(data, vehicleId, destId);
  const depot = depotBonus(state, data, destId);
  return { raw, eff: round1(raw * (1 + techBonus(state, 'payload') + depot) * (1 - (fuelMargin ?? 0.1))), ...(depot ? { depot } : {}) };
}
/**
 * Propellant depot in Earth orbit (st_depot with propellant, §3.2): +5% payload for the agency's flights that leave
 * Earth orbit (refuelled on the way). 0 without infra or without a stocked depot.
 */
function depotBonus(state, data, destId) {
  const f = peerFn('infra', 'bonusAt');
  const dest = destDef(data, destId);
  if (!f || !dest || (dest.body ?? 'earth') === 'earth' || !state?.assets?.list?.length) return 0;
  let best = 0;
  const sites = new Set();
  for (const a of state.assets.list) if (a.kind === 'station' && (a.bodyId ?? 'earth') === 'earth' && a.status === 'active') sites.add(a.site);
  for (const site of sites) {
    let b = null;
    try { b = f(state, data, { site, actorId: state.playerId }); } catch { b = null; }
    best = Math.max(best, Number(b?.payload) || 0);
  }
  return clamp(best, 0, 0.2);
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
  // an orbital shipyard of the agency at the destination builds the ship there: −10% on the craft (§3.2 shipyard)
  const yard = d.destination ? siteBonusOf(state, data, d.destination) : null;
  const yardMult = yard && yard.costMult < 1 ? yard.costMult : 1;
  // generic hardware is priced per class of destination (a Jupiter probe is not a lunar cubesat)
  const scCost = sc ? (sc.costM || 0) * (sc.access === 'generic' ? GENERIC_COST_SCALE[dest?.capacityKey] ?? 1 : 1) * yardMult : 0;
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
  // Missões v2 payloads (§1.5): the module, the vehicles or the tonnes of supplies are bought too
  const pk = payloadKindOf(data, d, d.sub || resolveSub(state, data, d));
  const p = d.payload || {};
  let cargoM = 0;
  if ((pk === 'station_module' || pk === 'base_module') && p.moduleId && sc?.kind !== 'station_module') {
    const mod = moduleDef(data, p.moduleId);
    if (mod) { cargoM = Number(mod.costM) || 0; lines.push({ label: `Módulo ${moduleLabel(mod)}`, amount: round1(cargoM) }); }
  } else if (pk === 'base_vehicle' && p.vehicleTypeId) {
    const vh = surfaceVehicleDef(data, p.vehicleTypeId);
    if (vh) { cargoM = (Number(vh.costM) || 0) * (p.qty || 1); lines.push({ label: `Veículos (${p.qty || 1})`, amount: round1(cargoM) }); }
  } else if (pk === 'supply' || pk === 'propellant') {
    const t = p.qty || 1;
    cargoM = supplyCostPerT(state, data) * t * (pk === 'propellant' ? 0.5 : 1);
    lines.push({ label: pk === 'supply' ? `Suprimentos (${fmtTons(t)} t)` : `Propelente (${fmtTons(t)} t)`, amount: round1(cargoM) });
  } else if (pk === 'servicing') {
    cargoM = supplyCostPerT(state, data) * 4;
    lines.push({ label: 'Kit de reparo', amount: round1(cargoM) });
  }
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

/**
 * Production queue of the player's own rocket (designs, own-lineage catalog vehicles): market.js §8.4. null when the
 * vehicle is bought from others, the market is not bound, or the mission already holds its unit (scheduled on it).
 */
function productionQueueFor(state, data, d, missionId = d?.id) {
  const f = peerFn('market', 'productionQueue');
  if (!f || !d?.vehicleId) return null;
  const v = vehicleDef(data, d.vehicleId, state);
  if (!v || !(v.playerDesign || (v.operator && v.operator === state.playerId))) return null;
  const m = missionId ? missionById(state, missionId) : null;
  if (m && m.status !== 'planning' && m.vehicleId === d.vehicleId) return null;
  try { return f(state, data, d.vehicleId, { exceptMissionId: missionId || null }) || null; } catch { return null; }
}

function leadWeeks(d) {
  const base = LEAD_BY_SOURCE[d.source] ?? LEAD_WEEKS[d.type] ?? 8;
  // extra tests take time, not only money
  return base + (d.config?.strategy === 'conservative' ? CONSERVATIVE_EXTRA_WEEKS : 0);
}

/** Earliest turn this draft can launch (preparation lead + launch window). */
function earliestLaunch(state, data, d) {
  // a calendar program's hardware is ready on its own schedule (readyTurn), not the day the plan is approved
  let from = Math.max(state.turn + leadWeeks(d), Number.isFinite(d.readyTurn) ? d.readyTurn : -Infinity);
  // a rocket the player builds has a production line (market.productionQueue, §8.4): wait for a free unit
  const pq = productionQueueFor(state, data, d);
  if (pq && Number.isFinite(pq.nextFreeTurn)) from = Math.max(from, pq.nextFreeTurn);
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
  else if (!destOpenNow(state, dest)) errors.push(`${dest.name} não existe nesta época.`);
  else if (d.type && !destOkForType(dest, d.type) && d.source !== 'calendar') errors.push(`${dest.name} não é destino para missão do tipo ${typeLabel.toLowerCase()}.`);

  // Missões v2 (§1.2–1.5): subtype, payload, target asset and the research gate
  const v2 = validateV2(state, data, d, opts, errors, warnings);

  // spacecraft (a station module from modules.json flies itself: no craft)
  if (!d.spacecraftId) {
    if (!d.clientPayload && !v2.moduleFliesItself) errors.push('Escolha a espaçonave.');
  } else if (!sc) errors.push('Espaçonave desconhecida.');
  else {
    if (!spacecraftFor(state, data).some((s) => s.id === sc.id) && !keepsBooking(state, data, sc, opts)) errors.push(`${sc.name} não está disponível para a agência agora.`);
    if (d.type && d.source !== 'calendar' && !scOkForType(sc, d.type, d.crewed, data)) errors.push(d.crewed ? `${sc.name} não leva tripulação.` : `${sc.name} não serve para missão do tipo ${typeLabel.toLowerCase()}.`);
    else if (d.type && d.source !== 'calendar' && v2.sub && !scOkForSub(data, sc, d.type, v2.sub)) errors.push(`${sc.name} não é ${(subtypeOf(data, d.type, v2.sub)?.label || v2.sub).toLowerCase()}.`);
    if (dest && !scOkForDest(sc, dest.id)) errors.push(`${sc.name} não foi projetada para ${dest.name}.`);
    // carriers (§1.4): the craft must hold what it carries; surface deliveries need a cargo lander
    if (v2.carried) {
      const cap = cargoCapacityOf(data, sc);
      if (v2.cargoT > cap + 1e-9) errors.push(`A ${sc.name} leva no máximo ${fmtTons(cap)} t de carga.`);
      if (dest && SURFACE_KINDS.includes(dest.kind) && !(sc.kind === 'lander' || (sc.kind === 'cargo' && scOkForDest(sc, dest.id) && Array.isArray(sc.destinations) && sc.destinations.includes(dest.id)))) {
        errors.push('Carga na superfície precisa de um módulo de pouso de carga.');
      }
    }
  }
  // companion craft (lander for Orion, capsule for Lanyue)
  const sc2id = companionOf(state, data, d);
  const sc2 = spacecraftDef(data, sc2id);
  if (needsLander(data, d) && !isCrewLander(sc2)) errors.push(`${sc?.name || 'A nave'} precisa de um módulo de pouso tripulado para ${dest?.name || d.destination}, e nenhum está disponível.`);
  if (sc2id && !sc2) errors.push('Módulo de apoio desconhecido.');
  else if (sc2) {
    if (!spacecraftFor(state, data).some((s) => s.id === sc2.id) && !keepsBooking(state, data, sc2, opts)) errors.push(`${sc2.name} não está disponível para a agência agora.`);
    if (dest && !companionOk(data, sc2, dest.id)) errors.push(`${sc2.name} não opera em ${dest.name}.`);
    else if (!companionLaunch(state, data, sc2, dest?.id)) errors.push(`Nenhum foguete disponível leva ${sc2.name} até ${dest?.name || d.destination}.`);
  }

  // vehicle + payload
  const payloadT = payloadOf(data, d, state);
  let capacity = { raw: 0, eff: 0 };
  if (!d.vehicleId) errors.push('Escolha o veículo lançador.');
  else if (!v) errors.push('Veículo desconhecido.');
  else {
    // a design in its test campaign flies only its own test flights (the vehicle is the object of that mission)
    const testing = !!d.testDesignId && d.testDesignId === v.id;
    if (!testing && !vehiclesFor(state, data).some((x) => x.id === v.id) && !keepsBooking(state, data, v, opts)) {
      const dz = designList(state).find((x) => x.id === v.id);
      errors.push(dz && designPhase(dz) !== 'operational' ? `${v.name} ainda não terminou os voos de teste.` : `${v.name} não está disponível para a agência agora.`);
    }
    if (d.crewed && !crewRatedV(state, data, v)) errors.push(`${v.name} não é certificado para voo tripulado.`);
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
    const pq = v ? productionQueueFor(state, data, d, opts.missionId) : null;
    if (pq && Number.isFinite(pq.nextFreeTurn) && lt < pq.nextFreeTurn) errors.push(`Produção do ${v.name} ocupada até ${fmtT(state, pq.nextFreeTurn)}.`);
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
    // investor mandates (B2) carry a deadline too: missing it costs the holder's mood and its penalty
    const what = d.mandateId || d.holderId ? 'do mandato' : 'do contrato';
    const cost2 = d.mandateId || d.holderId ? 'o investidor cobra a multa e perde a confiança' : 'multa e receita menor';
    if (lt > d.deadlineTurn) warnings.push(`Depois do prazo ${what} (${fmtT(state, d.deadlineTurn)}): ${cost2}.`);
    else warnings.push(`Prazo ${what}: ${fmtT(state, d.deadlineTurn)}.`);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], payloadT, capacity, seats, cost, window, earliest, launchTurn: lt, v2 };
}

/**
 * Missões v2 checks (§1.5), pushed into `errors`/`warnings`. Returns what the rest of validate and the builder need:
 * { sub, payloadKind, cargoT, carried, targetAssetId, target, moduleFliesItself, gate }.
 */
/**
 * A booked flight keeps hardware it no longer could buy (MISSIONS-V2 §8.1: an agreement that ends leaves launches
 * ≤ 26 weeks away on their vehicle and craft — farther ones are reassigned by treatyEnded; research grandfathering
 * §5.3). Embargo and tension ≥ 3 still suspend the launch.
 */
function keepsBooking(state, data, item, opts) {
  const m = opts?.missionId ? missionById(state, opts.missionId) : null;
  if (!m || !item || !['scheduled', 'launch'].includes(m.status)) return false;
  if (![m.vehicleId, m.spacecraftId, m.secondarySpacecraftId].includes(item.id)) return false;
  if (isDesignId(state, item.id) || item.calendarOnly || (item.embargo || []).includes(state.playerId)) return false;
  const ctrl = item.tensionActor || item.operator;
  if (ctrl && ctrl !== state.playerId && tensionBetween(state, state.playerId, ctrl) >= 3) return false;
  return true;
}

function validateV2(state, data, d, opts, errors, warnings) {
  const out = { sub: null, payloadKind: null, cargoT: 0, carried: false, targetAssetId: null, target: null, moduleFliesItself: false, gate: null };
  if (!d.type) return out;
  const md = mtables(data);
  const dest = destDef(data, d.destination);
  const sub = resolveSub(state, data, d);
  out.sub = sub;
  const row = subtypeOf(data, d.type, sub);
  const calendarItem = d.source === 'calendar';
  const privileged = ['contract', 'cert', 'test'].includes(d.source) || d.clientPayload;
  if (md.has && sub && !row && !calendarItem) errors.push('Subtipo de missão desconhecido.');
  if (row?.privileged && !privileged) errors.push(`${row.label} só existe em contratos.`);
  if (row && dest && !calendarItem && !subDestOk(row, dest)) errors.push(`${row.label} não serve para ${dest.name}.`);

  const pk = payloadKindOf(data, d, sub);
  out.payloadKind = pk;
  const p = d.payload || {};
  // modules and surface vehicles
  if (pk === 'station_module' || pk === 'base_module') {
    const sc = spacecraftDef(data, d.spacecraftId, state);
    if (p.moduleId) {
      const mod = moduleDef(data, p.moduleId);
      if (!mod) errors.push('Módulo desconhecido.');
      else if (moduleKindOf(data, p.moduleId) !== (pk === 'station_module' ? 'station' : 'base')) errors.push(`${moduleLabel(mod)} não é ${pk === 'station_module' ? 'módulo de estação' : 'módulo de base'}.`);
      if (pk === 'station_module' && !sc) out.moduleFliesItself = true;
    } else if (!(pk === 'station_module' && sc?.kind === 'station_module') && moduleRows(data, pk === 'station_module' ? 'station' : 'base').length) {
      errors.push(pk === 'station_module' ? 'Escolha o módulo da estação.' : 'Escolha o módulo da base.');
    }
  } else if (pk === 'base_vehicle') {
    const vh = surfaceVehicleDef(data, p.vehicleTypeId);
    if (!p.vehicleTypeId) { if (moduleRows(data, 'vehicles').length) errors.push('Escolha o veículo de superfície.'); }
    else if (!vh) errors.push('Veículo de superfície desconhecido.');
    else if (Array.isArray(vh.bodies) && vh.bodies.length && dest && !vh.bodies.includes(dest.body)) errors.push(`${moduleLabel(vh)} não opera em ${dest.name}.`);
  }
  out.cargoT = round1(cargoMassOf(state, data, d, pk));
  out.carried = CARRIED_KINDS.includes(pk) && !d.config?.payloadT;

  // target asset (only meaningful when infra.js is bound: without it the v0.8 abstract flow stands)
  const targetId = resolvedTargetId(state, data, d, sub);
  out.targetAssetId = targetId;
  const target = targetId ? assetOf(state, targetId) : null;
  out.target = target;
  const need = needsTargetKinds(data, d.type, sub);
  if (infraBound() && !calendarItem) {
    if (need && !targetId) errors.push('Escolha a estação ou base de destino.');
    else if (targetId && !target) errors.push('Estação ou base desconhecida.');
    else if (target) {
      if (need && !need.includes(target.kind)) errors.push('Escolha a estação ou base de destino.');
      const cd = peerFn('infra', 'canDeliver');
      let res = null;
      const seats = d.crewed ? crewIdsOf(d).length || (spacecraftDef(data, d.spacecraftId, state)?.crew || 0) : 0;
      try { res = cd ? cd(state, data, state.playerId, targetId, { type: d.type, sub, payloadKind: pk, seats }) : null; } catch { res = null; }
      // an awarded contract naming the asset is the permission (§3.3), unless the asset is gone
      const ctr = d.contractId ? (state.contracts || []).find((c) => c.id === d.contractId) : null;
      const byContract = ctr && ctr.targetAssetId === targetId && !['derelict', 'ended'].includes(target.status);
      if (res && res.ok === false && !byContract) errors.push(res.reason || 'Esta estação não aceita a entrega.');
      if (target.site && d.destination && target.site !== d.destination) errors.push(`${target.name || 'O destino'} fica em ${destDef(data, target.site)?.name || target.site}.`);
    }
  }

  // research gate (§5.3): only the player, only in tech-gated scenarios. A committed (scheduled) mission is
  // grandfathered only for what it already carried: an edit to a new type, subtype, module or surface vehicle is new
  // content and goes through the gate like a fresh draft.
  const mg = peerFn('gating', 'missionGate');
  const existing = opts.missionId ? missionById(state, opts.missionId) : null;
  const spec = gateSpecOf(state, data, d, sub, pk, target, dest);
  let grandfathered = false;
  if (existing && existing.status && existing.status !== 'planning') {
    const esub = existing.sub || resolveSub(state, data, existing);
    const etid = resolvedTargetId(state, data, existing, esub);
    const eSpec = gateSpecOf(state, data, existing, esub, payloadKindOf(data, existing, esub), etid ? assetOf(state, etid) : null, destDef(data, existing.destination));
    grandfathered = JSON.stringify(eSpec) === JSON.stringify(spec);
  }
  if (mg && !grandfathered && !['cert', 'test'].includes(d.source)) {
    let g = null;
    try { g = mg(state, data, spec, state.playerId); } catch { g = null; }
    out.gate = g;
    if (g && g.ok === false) errors.push(g.reason || 'Pesquise a tecnologia necessária.');
  }
  return out;
}

/** What the research gate looks at in a draft or mission (gating.missionGate spec). */
function gateSpecOf(state, data, d, sub, pk, target, dest) {
  const p = d?.payload || {};
  return {
    type: d?.type || null, sub: sub || null, payloadKind: pk === 'client' ? null : (pk || null), moduleId: p.moduleId || null,
    vehicleTypeId: p.vehicleTypeId || null, crewed: !!d?.crewed,
    targetKind: target?.kind || (dest?.kind === 'station' && ['crewed', 'cargo', 'station'].includes(d?.type) ? 'station' : null),
  };
}

// ---------------------------------------------------------------------------------------------
// Risk estimate
// ---------------------------------------------------------------------------------------------

function planOf(state, d, launchTurn, data = null) {
  return {
    actorId: state.playerId, type: d.type, destination: d.destination, vehicleId: d.vehicleId, spacecraftId: d.spacecraftId,
    secondarySpacecraftId: d.secondarySpacecraftId || undefined,
    crew: d.crew, config: d.config, launchTurn: launchTurn ?? state.turn, crewed: d.crewed, riskMod: d.riskMod || 0,
    // a draft is "created" now: lets risk show "Prazo apertado" in the builder, same rule as launch day
    createdTurn: Number.isFinite(d.createdTurn) ? d.createdTurn : state.turn,
    calendarId: d.source === 'calendar' ? d.calendarId || undefined : undefined,
    // Missões v2 (§7.1): docking/berthing/release milestones come from the scene target of this flight
    sub: d.sub || undefined,
    target: data ? dockingOf(state, data, d) || undefined : undefined,
    siteBonus: data ? siteBonusOf(state, data, d.destination) || undefined : undefined,
  };
}

/**
 * What the agency's infrastructure at a site gives a flight there (infra.bonusAt, §3.2): landing pad (landing risk),
 * propellant depot (payload), orbital shipyard (cost). null without infra or without a bonus.
 */
function siteBonusOf(state, data, site) {
  const f = peerFn('infra', 'bonusAt');
  if (!f || !site) return null;
  let b = null;
  try { b = f(state, data, { site, actorId: state.playerId }); } catch { b = null; }
  if (!b || (!(b.landingRisk < 0) && !(b.payload > 0) && !(b.costMult < 1))) return null;
  return { landingRisk: b.landingRisk || 0, payload: b.payload || 0, costMult: b.costMult ?? 1 };
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
    try { r = f(state, data, planOf(state, { ...d, secondarySpacecraftId: companionOf(state, data, d) }, launchTurn, data)); } catch (e) { log(state, `aviso: risco indisponível (${e.message})`); r = null; }
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
  syncDesignCatalog(state, data);
  const m = missionById(state, missionId);
  if (!m) return null;
  m.estimate = estimateOf(riskFor(state, data, { ...m, riskMod: riskModOf(state, m) }, m.launchTurn ?? undefined));
  return m.estimate;
}

// ---------------------------------------------------------------------------------------------
// Catalog helpers for pre-filled drafts (briefings, contracts, opportunities)
// ---------------------------------------------------------------------------------------------

// --- item 9: the player chooses the hardware (EXPANSION.md §7) ---
export const SUGGEST_PROGRAM = 'Plano do programa';
export const SUGGEST_CHEAPEST = 'Mais barato que leva a carga';
export const NEEDS_HARDWARE_TEXT = 'Escolha o foguete e a nave antes de agendar.';
export const ACCEPT_LABEL = 'Aceitar e escolher o veículo';

/**
 * True when the mission still lacks a launcher, or a craft (client payloads fly without one of ours; a station module
 * from modules.json flies itself, MISSIONS-V2 §1.1).
 */
export function needsHardware(m) {
  if (!m) return false;
  const selfFlying = m.type === 'station' && !!m.payload?.moduleId;
  return !m.vehicleId || (!m.spacecraftId && !m.clientPayload && !selfFlying);
}

function cleanSuggestion(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    vehicleId: s.vehicleId || null, spacecraftId: s.spacecraftId || null,
    secondarySpacecraftId: s.secondarySpacecraftId || null, reason: typeof s.reason === 'string' ? s.reason : SUGGEST_CHEAPEST,
  };
}

/**
 * A briefing/contract draft as it becomes a mission: no hardware, the engineers' pick kept as `suggestion`.
 * Crew-certification demos never pass here (the vehicle is the object of that flight).
 */
function withoutHardware(draft, reason) {
  const { suggestionReason, ...d } = draft || {};
  return {
    ...d,
    suggestion: { vehicleId: d.vehicleId || null, spacecraftId: d.spacecraftId || null, secondarySpacecraftId: d.secondarySpacecraftId || null, reason },
    vehicleId: null, spacecraftId: null, secondarySpacecraftId: null,
  };
}

/** Largest fuel margin (≤ 10%) with which the craft still fits on the rocket, or null. */
function programFuelFit(state, data, d) {
  const sc = spacecraftDef(data, d.spacecraftId);
  if (!d.vehicleId || !sc) return null;
  const raw = capacityTo(data, d.vehicleId, d.destination) * (1 + techBonus(state, 'payload'));
  const fit = [0.1, 0.07, 0.05, 0.03, 0.02, 0].find((mg) => raw * (1 - mg) >= (sc.massT || 0));
  return fit ?? null;
}

function hardwareNames(data, d) {
  const v = vehicleDef(data, d?.vehicleId)?.name;
  const s = d?.clientPayload ? 'carga do cliente' : spacecraftDef(data, d?.spacecraftId)?.name;
  if (!v && !s) return 'nenhuma opção válida agora';
  return [v, s].filter(Boolean).join(' + ');
}

/**
 * Cost of a draft over every valid (rocket, craft) pair the agency could pick: { minM, maxM, options }.
 * Crewed drafts need a crew-rated rocket; the payload is the craft mass (or the client's payload).
 */
export function costRange(state, data, draftIn = {}) {
  syncDesignCatalog(state, data);
  const base = normalizeDraft({ ...draftIn, vehicleId: null, spacecraftId: null, secondarySpacecraftId: null });
  if (!base.type || !destDef(data, base.destination)) return { minM: null, maxM: null, options: 0 };
  const own = draftIn.spacecraftId || draftIn.suggestion?.spacecraftId || null;
  const scs = base.clientPayload ? [null]
    : spacecraftFor(state, data).filter((s) => (s.id === own || scOkForType(s, base.type, base.crewed)) && scOkForDest(s, base.destination));
  const vs = vehiclesFor(state, data).filter((v) => !base.crewed || crewRatedV(state, data, v));
  const bonus = 1 + techBonus(state, 'payload');
  let minM = Infinity;
  let maxM = -Infinity;
  let n = 0;
  for (const sc of scs) {
    const payload = base.config.payloadT ?? (sc?.massT ?? 1);
    for (const v of vs) {
      if (Array.isArray(sc?.compatibleVehicles) && sc.compatibleVehicles.length && !sc.compatibleVehicles.includes(v.id)) continue;
      if (capacityTo(data, v.id, base.destination) * bonus * (1 - base.config.fuelMargin) < payload) continue;
      const c = computeCost(state, data, { ...base, vehicleId: v.id, spacecraftId: sc?.id || null }).total;
      n++;
      if (c < minM) minM = c;
      if (c > maxM) maxM = c;
    }
  }
  return n ? { minM: round1(minM), maxM: round1(maxM), options: n } : { minM: null, maxM: null, options: 0 };
}

/** "US$ 120–310 mi conforme o foguete" (the single figure when every option costs the same). */
function costRangeText(state, data, draft, fallbackM) {
  const r = costRange(state, data, draft);
  if (!r.options || r.minM == null) return fmtMoney(fallbackM);
  if (Math.round(r.maxM) <= Math.round(r.minM)) return fmtMoney(r.minM);
  const lo = fmtMoney(r.minM).slice(4); // "120 mi" / "1,2 bi"
  const hi = fmtMoney(r.maxM).slice(4);
  const [nLo, uLo] = lo.split(' ');
  const [, uHi] = hi.split(' ');
  return `US$ ${uLo === uHi ? nLo : lo}–${hi} conforme o foguete`;
}

/**
 * Cheapest valid vehicle+spacecraft for (type, destination), or null.
 * Missões v2: `sub` filters satellites/rovers by subtype; `cargoT` (> 0) needs a carrier that holds it (a cargo
 * lander on a surface); `noCraft` prices a station module that flies itself (payloadOverride = its mass).
 */
function pickConfig(state, data, { type, sub = null, destination, crewed = type === 'crewed', extraPayload = 0, payloadOverride = null, clientPayload = false, scKinds = null, actorId = state.playerId, cargoT = 0, noCraft = false, onlyVehicleId = null }) {
  const dest = destDef(data, destination);
  if (!dest || !destOpenNow(state, dest)) return null;
  const surface = SURFACE_KINDS.includes(dest.kind);
  const carrierOk = (s) => cargoT <= 0 || (cargoCapacityOf(data, s) + 1e-9 >= cargoT && (!surface || s.kind === 'lander' || (s.kind === 'cargo' && (s.destinations || []).includes(destination))));
  let scs = clientPayload || noCraft
    ? [null]
    : spacecraftFor(state, data, actorId).filter((s) => (scKinds ? scKinds.includes(s.kind) && (!crewed || s.crew > 0) : scOkForType(s, type, crewed, data))
      && scOkForDest(s, destination) && (!sub || scOkForSub(data, s, type, sub)) && carrierOk(s));
  if (!clientPayload && !noCraft && scs.length === 0) return null;
  // own spacecraft first, then cheaper
  scs = scs.slice().sort((a, b) => ((b?.operator === actorId) - (a?.operator === actorId)) || ((a?.costM || 0) - (b?.costM || 0)));
  const vehicles = vehiclesFor(state, data, actorId);
  let best = null;
  for (const sc of scs.slice(0, 6)) {
    const payload = payloadOverride ?? ((sc?.massT ?? 1) + extraPayload);
    for (const v of vehicles) {
      if (onlyVehicleId && v.id !== onlyVehicleId) continue;
      if (crewed && !crewRatedV(state, data, v)) continue;
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

const NAME_TYPE = { satellite: 'Satélite', probe: 'Sonda', rover: 'Rover', crewed: 'Voo tripulado', cargo: 'Carga', station: 'Módulo' };
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

/** The draft's payload with its kind and its target asset filled in (explicit target kept, else auto-resolved). */
function withResolvedTarget(state, data, d) {
  const p = normalizePayload(d.payload);
  const sub = d.sub || resolveSub(state, data, d);
  if (!p.kind) p.kind = payloadKindOf(data, d, sub);
  if (!p.targetAssetId) p.targetAssetId = resolvedTargetId(state, data, { ...d, payload: p }, sub);
  // nothing carried, no target (satellites, probes, rovers, plain crewed flights): no payload object in the save
  const empty = !p.kind && !p.targetAssetId && !p.moduleId && !p.vehicleTypeId && !p.newAsset && !p.newAssetName && p.massT == null && p.qty === 1;
  return empty ? null : p;
}

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
    sub: resolveSub(state, data, d),
    payload: withResolvedTarget(state, data, d),
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
    ...(d.mandateId ? { mandateId: d.mandateId, holderId: d.holderId } : {}),
    ...(d.testDesignId ? { testDesignId: d.testDesignId } : {}),
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
  // item 9: briefings, opportunities and contracts arrive without hardware; the engineers' pick is only a suggestion
  const sug = cleanSuggestion(draft?.suggestion);
  m.secondarySpacecraftId = companionOf(state, data, { ...d, crewed: m.crewed }) || null;
  if (sug && !m.vehicleId && !m.spacecraftId) {
    // cost and odds shown at acceptance are those of the engineers' suggestion (the cheapest/planned option);
    // picking exactly that hardware keeps them until the regular refresh (missions.tick, every 4 weeks)
    m.suggestion = { ...sug, pristine: true };
    const asSuggested = { ...m, vehicleId: sug.vehicleId, spacecraftId: sug.spacecraftId };
    asSuggested.secondarySpacecraftId = companionOf(state, data, { ...d, crewed: m.crewed, vehicleId: sug.vehicleId, spacecraftId: sug.spacecraftId, secondarySpacecraftId: sug.secondarySpacecraftId }) || null;
    m.cost = computeCost(state, data, asSuggested).total;
    m.estimate = estimateOf(riskFor(state, data, asSuggested));
  } else {
    if (sug) m.suggestion = sug;
    m.cost = computeCost(state, data, m).total;
    m.estimate = estimateOf(riskFor(state, data, m));
  }
  state.missions.push(m);
  stat(state, 'created');
  return { ok: true, missionId: m.id, mission: m };
}

function scheduleMission(state, data, m, launchTurn) {
  if (!['planning', 'scheduled'].includes(m.status)) return { ok: false, error: 'Esta missão não pode ser agendada agora.' };
  if (needsHardware(m)) return { ok: false, error: NEEDS_HARDWARE_TEXT, errors: [NEEDS_HARDWARE_TEXT] };
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
  if (m.certVehicleId) fn(calendar, 'pauseCert')?.(state, m.certVehicleId, m.id);
  if (m.mandateId || m.holderId) tellInvestors(state, data, m, { cancelled: true, reason, final: true, mandateId: m.mandateId || null, holderId: m.holderId || null });
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

const PATCH_KEYS = ['name', 'type', 'sub', 'destination', 'vehicleId', 'spacecraftId', 'secondarySpacecraftId', 'crew', 'config', 'crewed', 'payload'];

/** Amount the player actually paid for a mission (older saves: the cost at scheduling). */
function paidOf(m) {
  if (!m?.paid) return 0;
  return Number.isFinite(m.paidM) && m.paidM > 0 ? m.paidM : m.cost || 0;
}

/** Mission type a calendar definition flies as (same rule as calendarDraft). */
function calendarTypeOf(def) {
  const t = missionTypeOf(def?.type).type;
  return t || (def?.crewed ? 'crewed' : 'probe');
}
/** Subtype a calendar item flies (its own, or the legacy alias's: 'lander' → 'lander'). */
const calendarSubOf = (def) => missionTypeOf(def?.type, def?.sub).sub || null;

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
  // a crew-certification demo flies that vehicle, without people
  if (m.certVehicleId) {
    if (('vehicleId' in patch && patch.vehicleId && patch.vehicleId !== m.certVehicleId) || patch.crewed || (patch.type && patch.type !== m.type) || (patch.destination && patch.destination !== m.destination)) {
      return { ok: false, error: 'O voo de demonstração da certificação tem foguete, destino e tipo fixos (sem tripulação).' };
    }
  }
  // a builder test flight flies that design with ballast (EXPANSION.md §6): the vehicle is the object of the mission
  if (m.testDesignId) {
    if (('vehicleId' in patch && patch.vehicleId !== m.testDesignId) || ('spacecraftId' in patch && patch.spacecraftId) || patch.crewed
      || (patch.type && patch.type !== m.type) || (patch.destination && patch.destination !== m.destination)) {
      return { ok: false, error: 'O voo de teste leva lastro no próprio projeto: foguete, destino e tipo são fixos.' };
    }
  }
  // a won contract fixes what is delivered and where (tender board): only the hardware, crew and plan change
  if (m.contractId && (('type' in patch && patch.type !== m.type) || ('destination' in patch && patch.destination !== m.destination) || ('clientPayload' in patch && !!patch.clientPayload !== !!m.clientPayload))) {
    return { ok: false, error: 'O contrato fixa a carga e o destino: escolha só o foguete, a nave e o plano.' };
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
  // the subtype follows type/destination/craft unless the player picks one; a new type drops the old payload
  if (!('sub' in patch) && ['type', 'destination', 'spacecraftId'].some((k) => k in patch && patch[k] !== m[k])) merged.sub = null;
  if (!('payload' in patch) && 'type' in patch && patch.type !== m.type) merged.payload = null;
  else if ('payload' in patch) merged.payload = { ...(m.payload || {}), ...(patch.payload || {}) };
  // a contract fixes what is delivered and where; a client payload is never something the player can ask for
  if (m.contractId) { merged.payload = m.payload || null; merged.sub = m.sub || null; if (m.config?.payloadT) merged.config.payloadT = m.config.payloadT; }
  if (merged.payload?.kind === 'client' && m.payload?.kind !== 'client') merged.payload = { ...merged.payload, kind: null };
  // taking the engineers' craft also takes the companion they planned with it (program landers)
  if (!('secondarySpacecraftId' in patch) && m.suggestion?.secondarySpacecraftId && merged.spacecraftId === m.suggestion.spacecraftId
    && merged.destination === m.destination && !!merged.crewed === !!m.crewed) merged.secondarySpacecraftId = m.suggestion.secondarySpacecraftId;
  const d = { ...normalizeDraft(merged), riskMod: riskModOf(state, m) };
  if (!d.type) return { ok: false, error: 'Tipo de missão inválido.' };
  // tight programs (Lanyue on Long March 10) only fit with a thin fuel margin: when the hardware changes, find it
  const hwChanged = ['vehicleId', 'spacecraftId'].some((k) => k in patch && (patch[k] || null) !== (m[k] || null));
  // the player takes exactly the suggested hardware right after accepting: the acceptance figures stand
  const sg = m.suggestion;
  const tookSuggestion = !!sg?.pristine && !m.paid && Object.keys(patch).every((k) => k === 'vehicleId' || k === 'spacecraftId')
    && (d.vehicleId || null) === (sg.vehicleId || null) && (d.spacecraftId || null) === (sg.spacecraftId || null);
  if (sg?.pristine) delete sg.pristine;
  if (m.source === 'calendar' && hwChanged && !tookSuggestion && !(patch.config && 'fuelMargin' in patch.config)) {
    const fit = programFuelFit(state, data, d);
    if (fit != null && (!m.vehicleId || !m.spacecraftId || fit < d.config.fuelMargin)) d.config.fuelMargin = fit;
  }
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
    type: d.type, sub: resolveSub(state, data, d), payload: withResolvedTarget(state, data, d),
    destination: d.destination, vehicleId: d.vehicleId, spacecraftId: d.spacecraftId, crewed: d.crewed,
    secondarySpacecraftId: companionOf(state, data, d) || null,
    crew: d.crewed ? d.crew : { flightDirector: d.crew.flightDirector, commander: null, astronauts: [] }, config: d.config,
  });
  if (!tookSuggestion) {
    m.cost = newCost;
    m.estimate = estimateOf(riskFor(state, data, m, m.launchTurn ?? undefined));
  }
  return { ok: true, missionId: m.id, cost: m.cost, estimate: m.estimate };
}

// ---------------------------------------------------------------------------------------------
// Briefings (calendar items owned by the player + opportunities)
// ---------------------------------------------------------------------------------------------

function calendarDraft(state, data, inst, def) {
  const sc = spacecraftDef(data, def.spacecraftId);
  const crewed = !!def.crewed;
  const d = {
    name: def.name, source: 'calendar', calendarId: inst.id, type: calendarTypeOf(def), sub: calendarSubOf(def),
    destination: def.destination, vehicleId: def.vehicleId || null, spacecraftId: def.spacecraftId || null, crewed,
    secondarySpacecraftId: def.secondarySpacecraftId || null,
    crew: autoCrew(state, data, crewed ? sc?.crew || 0 : 0), config: { strategy: 'balanced', fuelMargin: 0.1 },
    milestone: def.milestone || null, targetTurn: inst.currentTurn ?? inst.plannedTurn,
  };
  // program hardware missing from the catalog? complete it with the cheapest valid option
  d.suggestionReason = SUGGEST_PROGRAM;
  if (!vehicleDef(data, d.vehicleId) || !spacecraftDef(data, d.spacecraftId)) {
    d.suggestionReason = SUGGEST_CHEAPEST;
    const cfg = pickConfig(state, data, { type: d.type, destination: d.destination, crewed });
    if (cfg) {
      if (!vehicleDef(data, d.vehicleId)) d.vehicleId = cfg.vehicleId;
      if (!spacecraftDef(data, d.spacecraftId)) d.spacecraftId = cfg.spacecraftId;
    }
  }
  // tight programs (Lanyue on Long March 10) only fit with a thin fuel margin
  if (d.vehicleId && sc) {
    const fit = programFuelFit(state, data, { ...d, spacecraftId: sc.id });
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
    `Custo estimado: ${costRangeText(state, data, draft, cost)}.`,
  ];
  if (prereqs.length) lines.push(`Depende de: ${prereqs.map((c) => calDef(data, c.id)?.name || c.id).join(', ')} (ainda não concluída).`);
  if (reach?.lateArrival) lines.push(`Atenção: chega só em ${fmtT(state, reach.arriveTurn)}, depois do fim de ${turnToDate(state.endTurn, state.startYear).year}. Não pontua na Tabela da Era.`);
  // Phase B (§5.2): under a cap table the program is the anchor holder's mandate, with a deadline
  const pm = programMandate(state, inst, def);
  if (pm) {
    lines.unshift(`Mandato de ${pm.holderName}: prazo ${fmtT(state, pm.deadlineTurn)}.${pm.binding ? ' Com menos de 50% da agência, o conselho não aceita adiar nem cancelar.' : ''}`);
  }
  const lockNote = pm?.binding ? 'O conselho de acionistas exige o programa: você tem menos de 50% da agência.' : null;
  pushDecision(state, {
    kind: 'briefing',
    title: pm ? `Mandato: ${def.name}` : `Briefing: ${def.name}`,
    body: lines.join('\n'),
    portrait: { actorId: state.playerId },
    urgency: target - state.turn <= 6 ? 3 : 2,
    expiresTurn: Math.max(target, state.turn + 6),
    defaultChoice: 'accept',
    payload: { kind: 'calendar', calendarId: inst.id, draft, ...(pm ? { mandate: pm, holderId: pm.holderId } : {}) },
    choices: [
      { id: 'accept', label: ACCEPT_LABEL, preview: `A missão entra em planejamento e você escolhe o foguete e a nave. Sugestão dos engenheiros: ${hardwareNames(data, draft)}.` },
      { id: 'delay', label: 'Adiar 3 meses', preview: `−${delaySupport} apoio. Nova data: ${fmtT(state, target + 13)}.${pm ? ` ${pm.holderName} perde a paciência.` : ''}`, ...(lockNote ? { disabled: true, reason: lockNote } : {}) },
      { id: 'cancel', label: 'Cancelar o programa', preview: `−${cancelSupport} apoio, −5 reputação. Os parceiros não vão esquecer.${pm ? ` ${pm.holderName} vai cobrar no conselho.` : ''}`, ...(lockNote ? { disabled: true, reason: lockNote } : {}) },
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
      type: calendarTypeOf(def), sub: calendarSubOf(def) || resolveSub(state, data, { type: calendarTypeOf(def), destination: def.destination, spacecraftId: def.spacecraftId }), payload: null, destination: def.destination, vehicleId: def.vehicleId || null, spacecraftId: def.spacecraftId || null,
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
  const pm = dec.payload?.mandate || null;
  if (pm && (choiceId === 'delay' || choiceId === 'cancel')) {
    peerFn('investors', 'onMandateDeclined')?.(state, data, { holderId: pm.holderId, calendarId, choice: choiceId, kind: 'program' });
  }
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
  const res = createMission(state, data, withoutHardware({ ...d0, readyTurn: programReadyTurn(state, data, inst, def) }, d0.suggestionReason || SUGGEST_PROGRAM));
  if (res.ok) inst.missionId = res.missionId;
  // the anchor holder's program (§5.2): the mission carries the holder and the deadline shown on the briefing
  if (res.ok && pm && state.cap) {
    res.mission.holderId = pm.holderId;
    res.mission.mandate = { holderId: pm.holderId, holderName: pm.holderName, holderKind: pm.holderKind, emblem: pm.emblem, deadlineTurn: pm.deadlineTurn, kind: 'program', binding: !!pm.binding };
    res.mission.deadlineTurn = pm.deadlineTurn;
  }
  return res.ok ? { ...res, openBuilder: res.missionId, step: 2 } : res;
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

// --- Missões v2 eligibility (§2): contracts and opportunities only when they make sense ---

const contractRows = (data) => (Array.isArray(data?.contracts?.contracts) ? data.contracts.contracts : FALLBACK_CONTRACTS);
const opportunityRows = (data) => (Array.isArray(data?.contracts?.opportunities) ? data.contracts.opportunities : FALLBACK_OPPORTUNITIES);
const contractCaps = (data) => ({ ...CONTRACT_CAPS, ...(data?.contracts?.caps || {}) });

function trustBetween(state, a, b) {
  const f = fn(diplomacy, 'relation');
  let r = null;
  try { r = f ? f(state, a, b) : null; } catch { r = null; }
  r = r || state.relations?.[relKey(a, b)];
  return Number(r?.trust) || 0;
}
function tensionBetween(state, a, b) {
  const f = fn(diplomacy, 'tensionOf');
  let v = null;
  try { v = f ? f(state, a, b) : null; } catch { v = null; }
  if (!Number.isFinite(v)) v = state.tension?.[relKey(a, b)];
  return Number(v) || 0;
}
/** Does the player hold a key (gating.keyHeld; everyone holds every key without gating.js)? */
function playerHolds(state, data, key) {
  const f = peerFn('gating', 'keyHeld');
  if (!f || !key) return true;
  try { return f(state, data, key, state.playerId) !== false; } catch { return true; }
}
/** Research check of a row (type/sub/payload keys + needs.playerKeys): {ok, nodeId, reason}. */
function rowResearch(state, data, row) {
  const mg = peerFn('gating', 'missionGate');
  if (mg && row?.type) {
    let g = null;
    const pk = payloadKindOf(data, { type: row.type, clientPayload: !!row.clientPayload }, row.sub);
    try { g = mg(state, data, { type: row.type, sub: row.sub || null, payloadKind: pk === 'client' ? null : pk, crewed: row.type === 'crewed' }, state.playerId); } catch { g = null; }
    if (g && g.ok === false) return { ok: false, nodeId: g.nodeId || null, reason: g.reason || null };
  }
  for (const k of row?.needs?.playerKeys || []) if (!playerHolds(state, data, k)) return { ok: false, reason: k };
  return { ok: true };
}

/** Storage of an asset (Σ module storageT × n, min 2 t), for the supply ratio. */
function assetStorageT(data, a) {
  let s = 0;
  for (const x of a?.modules || []) s += (Number(moduleDef(data, x.id)?.storageT) || 0) * (x.n || 1);
  return Math.max(2, Number(a?.storageT) || s);
}
/** Modules an asset still plans to receive (historical stations: plannedModules). */
function plannedModulesLeft(a) {
  const have = (a?.modules || []).reduce((n, x) => n + (x.n || 1), 0);
  if (Array.isArray(a?.plannedModules)) return Math.max(0, a.plannedModules.length - have);
  return Math.max(0, (Number(a?.plannedModules) || 0) - have);
}
/** Next module a station/base plans (planned list first, else a laboratory / a habitat). */
function nextModuleFor(data, a, kind) {
  const have = new Set((a?.modules || []).map((x) => x.id));
  const plan = Array.isArray(a?.plannedModules) ? a.plannedModules.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean) : [];
  const fromPlan = plan.find((id) => !have.has(id) && moduleDef(data, id));
  if (fromPlan) return fromPlan;
  const pref = kind === 'base' ? ['bs_hab_small', 'bs_solar', 'bs_lab', 'bs_hab_large'] : ['st_lab', 'st_hab', 'st_node', 'st_logistics'];
  return pref.find((id) => moduleDef(data, id)) || moduleRows(data, kind)[0]?.id || null;
}
/** Fraction of life left of a satellite fleet / rover (0..1), 1 when unknown. */
function lifeLeftOf(state, data, a) {
  const row = subtypeOf(data, a?.kind === 'rover' ? 'rover' : 'satellite', a?.sub);
  const life = (Number(row?.asset?.lifeYears) || 10) * 52;
  const ends = Array.isArray(a?.units) && a.units.length ? Math.min(...a.units.map((u) => u.endTurn)) : a?.lifeEndTurn;
  if (!Number.isFinite(ends)) return 1;
  return clamp((ends - state.turn) / life, 0, 1);
}

/** Does an asset satisfy a contract row's `target` (and the per-asset demand cap)? */
function assetMatches(state, data, t, a, caps) {
  if (!a || !t) return false;
  const pid = state.playerId;
  if (t.assetKind && a.kind !== t.assetKind) return false;
  if ((t.owner ?? 'other') === 'other' && a.ownerId === pid) return false;
  if (t.owner === 'self' && a.ownerId !== pid) return false;
  if (Array.isArray(t.status) && !t.status.includes(a.status || 'active')) return false;
  if (['ended', 'derelict'].includes(a.status) && !Array.isArray(t.status)) return false;
  if (t.sub && a.sub !== t.sub) return false;
  if (t.ownerKind && state.actors?.[a.ownerId]?.kind !== t.ownerKind) return false;
  if (t.module && !(a.modules || []).some((x) => x.id === t.module)) return false;
  if (Number.isFinite(t.supplyBelow) && (Number(a.supplyT) || 0) / assetStorageT(data, a) >= t.supplyBelow) return false;
  if (t.plannedModulesLeft && plannedModulesLeft(a) <= 0) return false;
  if (Number.isFinite(t.lifeLeftBelow) && lifeLeftOf(state, data, a) >= t.lifeLeftBelow) return false;
  if (a.site && !destOpenNow(state, destDef(data, a.site))) return false;
  // ≤ 1 offer per asset per 26 weeks
  if ((state.contracts || []).some((c) => c.targetAssetId === a.id && state.turn - (c.createdTurn ?? -999) < caps.perAssetWeeks)) return false;
  return true;
}

/**
 * Is a contract/opportunity row eligible now? (§2 rules 1–5) → {ok, why}. `asset`: the concrete asset of a target
 * row (rule 3); rows with a target and no asset are never eligible ("carga para a Lua" needs someone there first).
 */
export function contractEligible(state, data, row, { asset = null, world = false, colony = false } = {}) {
  if (!row) return { ok: false, why: 'row' };
  const n = row.needs || {};
  const y = yearAt(state);
  const from = n.fromYear ?? row.fromYear;
  const until = n.untilYear ?? row.untilYear;
  if (Number.isFinite(from) && y < from) return { ok: false, why: 'date' };
  if (Number.isFinite(until) && y > until) return { ok: false, why: 'date' };
  for (const id of n.firstsAny || []) if (!achievedAny(state, id)) return { ok: false, why: `firsts:${id}` };
  // the board's view (world: true) lists what anyone could fly; the player's research is the card's feasibility check
  if (!world) {
    const rr = rowResearch(state, data, row);
    if (!rr.ok) return { ok: false, why: 'research', nodeId: rr.nodeId || null };
  }
  if (row.colony) {
    if (!colony) return { ok: false, why: 'colony' };
  } else if (row.target) {
    if (!asset) return { ok: false, why: 'target' };
    if (!assetMatches(state, data, row.target, asset, contractCaps(data))) return { ok: false, why: 'asset' };
    const owner = asset.ownerId;
    if (owner && owner !== state.playerId) {
      if (!world && Number.isFinite(n.relation?.minTrust) && trustBetween(state, state.playerId, owner) < n.relation.minTrust) return { ok: false, why: 'relation' };
      if (!world && Number.isFinite(n.noTensionAbove) && tensionBetween(state, state.playerId, owner) > n.noTensionAbove) return { ok: false, why: 'tension' };
      if (!state.actors?.[owner] || state.actors[owner].dead || state.actors[owner].status === 'gone') return { ok: false, why: 'owner' };
    }
  } else if (!rowDestinations(state, data, row).length) return { ok: false, why: 'destination' };
  if (row.noOwnAsset) {
    let list = [];
    try { list = peerFn('infra', 'listAssets')?.(state, { ownerId: state.playerId, kind: row.noOwnAsset }) || []; } catch { list = []; }
    if (list.some((a) => a.ownerId === state.playerId && !['ended', 'derelict'].includes(a.status))) return { ok: false, why: 'own' };
  }
  return { ok: true, why: null };
}

/** Open destinations a row without target can use (row.destination or row.destinations). */
function rowDestinations(state, data, row) {
  const ids = Array.isArray(row?.destinations) ? row.destinations : row?.destination ? [row.destination] : [];
  return ids.filter((id) => {
    const dest = destDef(data, id);
    if (!dest || !destOpenNow(state, dest)) return false;
    if (row.type && !destOkForType(dest, missionTypeOf(row.type).type)) return false;
    const sr = subtypeOf(data, missionTypeOf(row.type).type, row.sub);
    return !sr || subDestOk(sr, dest) || row.sub === 'client';
  });
}

/**
 * Every eligible (row, asset|null, destination) a contract could be made of now, in a stable order. `world`: the
 * board's view (no player research or relation check; colony rows are added by tenderCandidates).
 */
export function contractCandidates(state, data, { world = false } = {}) {
  const out = [];
  const listAssets = peerFn('infra', 'listAssets');
  for (const row of contractRows(data)) {
    if (row.colony) continue;
    if (row.target) {
      if (!listAssets) continue;
      let list = [];
      try { list = listAssets(state, { kind: row.target.assetKind }) || []; } catch { list = []; }
      for (const a of list) if (contractEligible(state, data, row, { asset: a, world }).ok) out.push({ row, asset: a, destination: a.site });
    } else if (contractEligible(state, data, row, { world }).ok) {
      for (const id of rowDestinations(state, data, row)) out.push({ row, asset: null, destination: id });
    }
  }
  return out;
}

// --- opportunities: windows, rival moves, custom targets, follow-ups ---

function hasPendingOpportunity(state) {
  return state.decisions.some((x) => x.kind === 'briefing' && x.payload?.kind && x.payload.kind !== 'calendar');
}

/**
 * A briefing card with a pre-filled draft. `kind`: the briefing family (window, rival, followup, retry, or a row id);
 * `sub`/`payload`: the mission's subtype and payload (Missões v2). Returns the decision or null.
 */
function pushOpportunity(state, data, { kind, title, body, type, sub = null, payload = null, destination, grantShare = 0, crewed, declineSupport = 0, urgency = 1, extra = {} }) {
  // investors hold the agenda (§5.2): no pitch for an own mission the player has no slot for
  const ag = agendaOf(state, data);
  if (ag?.enforced && ag.left <= 0) return null;
  const isCrewed = crewed ?? type === 'crewed';
  const pl = payload ? normalizePayload(payload) : null;
  const d0 = { type, sub, destination, crewed: isCrewed, payload: pl };
  const subR = sub || resolveSub(state, data, d0);
  // no pitch for something the player has not researched (§2 rule 4)
  if (!rowResearch(state, data, { type, sub: subR }).ok) return null;
  // a station module that flies itself (modules.json) is priced by its mass, without a craft
  const mod = pl?.moduleId ? moduleDef(data, pl.moduleId) : null;
  const noCraft = type === 'station' && !!mod;
  const pk = payloadKindOf(data, d0, subR);
  const cargoT = !noCraft && pl && CARRIED_KINDS.includes(pk) ? cargoMassOf(state, data, d0, pk) : 0;
  const cfg = pickConfig(state, data, { type, sub: subR, destination, crewed: isCrewed, noCraft, payloadOverride: noCraft ? mod.massT || 1 : null, cargoT, extraPayload: cargoT });
  if (!cfg) return null;
  const sc = spacecraftDef(data, cfg.spacecraftId);
  const draft = {
    type, sub: subR, destination, vehicleId: cfg.vehicleId, spacecraftId: cfg.spacecraftId, crewed: isCrewed, source: 'custom',
    ...(pl ? { payload: pl } : {}),
    crew: autoCrew(state, data, isCrewed ? sc?.crew || 0 : 0), config: { strategy: 'balanced', fuelMargin: 0.1 }, ...extra,
  };
  draft.grantShare = grantShare;
  const net = computeCost(state, data, normalizeDraft(draft)).total;
  const grantM = round1(computeCost(state, data, normalizeDraft({ ...draft, grantShare: 0 })).total - net);
  const dest = destDef(data, destination);
  stat(state, 'opportunities');
  state.stats['missions.lastOpportunityTurn'] = state.turn;
  const subLabel = subtypeOf(data, type, subR)?.label;
  return pushDecision(state, {
    kind: 'briefing',
    title,
    body: `${body}\nDestino: ${dest?.name || destination}. Custo para a agência: ${costRangeText(state, data, draft, net)}${grantM > 0 ? ` (${Math.round(grantShare * 100)}% da conta vem de fora)` : ''}.`,
    portrait: { actorId: state.playerId },
    urgency,
    expiresTurn: state.turn + 8,
    defaultChoice: 'decline',
    payload: { kind, draft },
    choices: [
      { id: 'accept', label: ACCEPT_LABEL, preview: `Cria a missão em planejamento (${TYPE_LABELS[type]}${subLabel ? ` · ${subLabel}` : ''}, ${dest?.name || destination}). Sugestão dos engenheiros: ${hardwareNames(data, draft)}.` },
      { id: 'decline', label: 'Deixar passar', preview: declineSupport ? `−${declineSupport} apoio.` : 'Nada muda.' },
    ],
  });
}

function windowOpportunity(state, data) {
  for (const dest of destList(data)) {
    if (!dest.window || !destOpenNow(state, dest)) continue;
    if ((state.missions || []).some((m) => m.destination === dest.id && m.status !== 'done' && m.status !== 'cancelled')) continue;
    const w = windowFor(state, data, dest.id, state.turn + 10);
    const weeks = w.openTurn - state.turn;
    if (weeks < 14 || weeks > 40 || w.openTurn > state.endTurn) continue;
    // a probe that would arrive after the end of the era is not an opportunity the government pitches
    if (w.openTurn + (dest.transitWeeks || 0) > state.endTurn) continue;
    if (!destOkForType(dest, 'probe')) continue;
    // "Sonda + superfície" is the landing (R1): the subtype comes from the destination
    const d = pushOpportunity(state, data, {
      kind: 'window', type: 'probe', destination: dest.id, grantShare: 0.1, urgency: 2,
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
    if (!dest || dest.body === 'earth' || !destOpenNow(state, dest)) continue;
    // same rule as windowOpportunity: no pitch for a mission that could only arrive after the end of the era
    const w = windowFor(state, data, dest.id, state.turn + (LEAD_WEEKS.probe ?? 8));
    if (w.openTurn >= state.endTurn || w.openTurn + (dest.transitWeeks || 0) > state.endTurn) continue;
    const theirs = missionTypeOf(s.missionType).type;
    const tryTypes = s.crewed ? ['crewed', 'probe'] : [theirs, SURFACE_KINDS.includes(dest.kind) ? 'rover' : null, 'probe'];
    for (const type of [...new Set(tryTypes)]) {
      if (!TYPES.includes(type) || !destOkForType(dest, type)) continue;
      const d = pushOpportunity(state, data, {
        kind: 'rival', type, destination: dest.id, grantShare: 0.2, declineSupport: 2, urgency: 2,
        title: `Resposta a ${actorName(state, s.actorId)}`,
        body: `${actorName(state, s.actorId)} chegou a ${dest.name}. O governo quer uma resposta à altura e promete ajudar a pagar.`,
      });
      if (d) return d;
    }
  }
  return null;
}

/** First module of a new station (modules.json st_core), as a payload; null without modules data. */
function stationFoundPayload(data) {
  const core = moduleDef(data, 'st_core') || moduleRows(data, 'station')[0] || null;
  return core ? { kind: 'station_module', moduleId: core.id, newAsset: true } : null;
}

function customOpportunity(state, data, rng) {
  const pool = rng.shuffle(opportunityRows(data));
  for (const o of pool) {
    if (!contractEligible(state, data, o).ok) continue;
    const type = missionTypeOf(o.type, o.sub);
    if ((state.missions || []).some((m) => m.destination === o.destination && m.type === type.type && !['done', 'cancelled'].includes(m.status))) continue;
    const payload = type.type === 'station' ? stationFoundPayload(data) : o.payload || null;
    const d = pushOpportunity(state, data, {
      kind: o.kind || o.id, type: type.type, sub: type.sub, payload, destination: o.destination, grantShare: o.grantShare || 0,
      crewed: o.crewed, title: o.title, body: o.body, declineSupport: o.declineSupport || 0, urgency: o.urgency || 1,
    });
    if (d) return d;
  }
  return null;
}

function opportunities(state, data, ctx) {
  if (hasPendingOpportunity(state)) return;
  // long steps (D1): the government's pitches (windows, answers to rivals, ideas) wait for the attention step
  if (typeof budget.attentionStep === 'function' && !budget.attentionStep(state, ctx)) return;
  const planning = (state.missions || []).filter((m) => m.status === 'planning').length;
  if (planning >= 3) return;
  const last = state.stats?.['missions.lastOpportunityTurn'] ?? -99;
  const rng = ctx.rng('opportunity');
  if (state.turn - last >= 4 && rng.chance(0.5) && rivalOpportunity(state, data)) return;
  if (state.turn - last >= 8 && rng.chance(0.25) && windowOpportunity(state, data)) return;
  if (state.turn - last >= 10 && rng.chance(0.12)) customOpportunity(state, data, rng);
}

/**
 * The natural next step after a success (§2 "Opportunities"): a lunar orbiter → a probe landing there; a landing →
 * a rover; a first station module → the next module; otherwise the next destination of the route. pushOpportunity
 * drops steps the player has not researched. → spec | null
 */
export function nextStepOf(state, data, m) {
  const dest = destDef(data, m.destination);
  if (m.type === 'station' && (m.assetId || m.payload?.targetAssetId)) {
    const assetId = m.assetId || m.payload.targetAssetId;
    const a = assetOf(state, assetId);
    const modId = a ? nextModuleFor(data, a, 'station') : null;
    if (modId && a.ownerId === state.playerId) {
      return { type: 'station', sub: 'expand', destination: m.destination, payload: { kind: 'station_module', moduleId: modId, targetAssetId: assetId },
        title: `Próximo módulo: ${a.name || 'estação'}`, body: `O módulo está em posição. Os engenheiros já preparam o próximo: ${moduleLabel(moduleDef(data, modId)).toLowerCase()}.` };
    }
  }
  if (m.type === 'probe' && m.sub === 'lander' && dest && destOkForType(dest, 'rover')) {
    return { type: 'rover', destination: m.destination, title: `Próximo passo: rodas em ${dest.name}`,
      body: `O pouso de ${m.name} provou o caminho. Agora um rover pode rodar por ${dest.name} e mandar ciência por meses.` };
  }
  const next = NEXT_STEP[m.destination];
  const nd = destDef(data, next);
  if (!nd) return null;
  const text = { title: `Próximo passo: ${nd.name}`, body: `O sucesso de ${m.name} abriu caminho. Os engenheiros já desenham a próxima etapa: ${nd.name}.` };
  return m.crewed ? { type: 'crewed', destination: next, crewed: true, ...text } : { type: 'probe', destination: next, ...text };
}

/** After a result: offer the natural next step or a retry. Non-blocking. */
function followUp(state, data, m, success) {
  if (hasPendingOpportunity(state) || m.source === 'contract') return;
  if (success) {
    const step = nextStepOf(state, data, m);
    const dest = destDef(data, step?.destination);
    if (!step || !dest || !destOpenNow(state, dest) || !destOkForType(dest, step.type)) return;
    pushOpportunity(state, data, { kind: 'followup', grantShare: 0.1, ...step });
  } else {
    pushOpportunity(state, data, {
      kind: 'retry', type: m.type, sub: m.sub || null, payload: m.payload?.kind && m.payload.kind !== 'client' ? { ...m.payload } : null,
      destination: m.destination, crewed: m.crewed, grantShare: 0.15,
      title: `Tentar de novo: ${m.name}`,
      body: 'O seguro cobre parte de uma nova tentativa. A equipe quer provar que aprendeu com a falha.',
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Contracts: the tender board (tela Contratos)
// ---------------------------------------------------------------------------------------------
// Clients publish tenders on a public board (state.contracts, status 'open'): a payload of some kind and mass to a
// destination, a reference price (what the client is ready to pay), the date bidding closes and a launch deadline.
// Every agency that can fly the job may bid a price between 60% and 140% of the reference; when bidding closes one
// winner is drawn with the odds the board shows (softmax of a score: price against the reference, reputation,
// reliability of the rocket the bidder plans to use and its record of delivered/failed contracts). The reference
// price is always well above the typical cost of flying the job, so even a low winning bid pays more than it costs.
// The player bids from the Contratos screen (actions contract/bid, contract/withdraw), never from a card; rival
// bids are rolled when the tender opens (cost of their cheapest capable hardware × need for work). A tender won by
// a rival is flown off-screen (a delivery date inside the deadline, one roll on the rocket's reliability, news).
// Tunables: data/core/contracts.json "board" (defaults below). Slice state.tenders = {next, record: {actorId: {won,
// ok, bad}}}: when the next tender may open and each agency's contract record.

export const BOARD_DEFAULTS = Object.freeze({
  openMax: 5, // open tenders on the board at once
  gapWeeks: [3, 7], // weeks between two new tenders
  startBurst: 3, // tenders that open together on a new board
  bidWeeks: [10, 24], // bidding window (never closes before the player's next stop)
  bidRange: [0.6, 1.4], // allowed bid / reference price
  refMult: [1.8, 2.2], // reference price / typical cost of flying the job
  advance: 0.3, // share paid on signing (the rest on delivery)
  finePct: 0.25, // fine on a missed deadline or a failure with no time to fly again (share of the price)
  lateCut: 0.3, // pay cut of a late delivery
  graceWeeks: 13, // a late contract is called off this long after the deadline (× step scale)
  rivalsMax: 4,
  sizes: { small: { w: 3, f: [0.08, 0.35] }, medium: { w: 2, f: [0.35, 0.65] }, large: { w: 1, f: [0.65, 0.95] } },
  chance: { price: 60, rep: 0.35, rel: 40, record: 2, recordMin: -12, recordMax: 10, temp: 10 },
  rival: { margin: 1.45, needSpan: 0.45, aggression: 0.2, jitter: 0.05, bidP: 0.6, needP: 0.35 },
  rep: { win: 1, deliver: 2, late: -3, default: -8, fail: -5, retry: -2, rivalFail: -4 },
});
const TUNED = new WeakMap();
/** Board tunables: BOARD_DEFAULTS merged with data.contracts.board (one level deep). */
export function boardTuning(data) {
  const src = data?.contracts?.board;
  if (!src || typeof src !== 'object') return BOARD_DEFAULTS;
  let t = TUNED.get(src);
  if (!t) {
    t = { ...BOARD_DEFAULTS };
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith('_')) continue;
      t[k] = v && typeof v === 'object' && !Array.isArray(v) && BOARD_DEFAULTS[k] && typeof BOARD_DEFAULTS[k] === 'object' && !Array.isArray(BOARD_DEFAULTS[k]) ? { ...BOARD_DEFAULTS[k], ...v } : v;
    }
    TUNED.set(src, t);
  }
  return t;
}

const OPEN_TENDER = ['open', 'bidding'];
const isOpenTender = (c) => OPEN_TENDER.includes(c?.status);
const PLAYER_CONTRACT = ['awarded', 'late'];
/** Long steps (eras 5–7) stretch deadlines: a 13-week step gets 3.25× the weeks, capped at 6×. */
const stepScale = (state) => clamp((Number(state?.clock?.stepWeeks) || 1) / 4, 1, 6);
const roundT = (t) => (t < 1 ? Math.round(t * 100) / 100 : round1(t));
/** "350 kg" / "2,5 t" */
export const tonsText = (t) => (Number(t) < 1 ? `${Math.round((Number(t) || 0) * 1000)} kg` : `${fmtTons(t)} t`);
export const SIZE_LABELS = { small: 'Pequeno', medium: 'Médio', large: 'Grande' };
export const CLIENT_KIND_LABELS = { governo: 'Governo', empresa: 'Empresa', instituto: 'Instituto científico', colonia: 'Colônia', agencia: 'Agência espacial' };
export const SUGGEST_BID = 'Foguete da proposta';
const toWhere = (dest, id) => dest?.toLabel || (dest?.name ? `a ${dest.name}` : id);

function tendersSlice(state) {
  const t = state.tenders && typeof state.tenders === 'object' ? state.tenders : (state.tenders = {});
  if (!Number.isFinite(t.next)) t.next = null;
  if (!t.record || typeof t.record !== 'object') t.record = {};
  return t;
}
/** An agency's contract record: {won, ok, bad} (bad = failed or defaulted). */
export function recordOf(state, id) {
  const r = state?.tenders?.record?.[id];
  return { won: r?.won || 0, ok: r?.ok || 0, bad: r?.bad || 0 };
}
function recordBump(state, id, key) {
  if (!id) return;
  const rec = tendersSlice(state).record;
  const r = rec[id] || (rec[id] = { won: 0, ok: 0, bad: 0 });
  r[key] = (r[key] || 0) + 1;
}
function recordBonus(state, data, id) {
  const T = boardTuning(data).chance;
  const r = recordOf(state, id);
  return clamp(T.record * (r.ok - 2 * r.bad), T.recordMin, T.recordMax);
}

/** What a contract asks the carrier to hold (t): its tonnes, a module, a repair kit; 0 for crew and client payloads. */
function contractCargoT(data, c) {
  if (c.clientPayload) return 0;
  switch (c.payloadKind) {
    case 'supply': case 'propellant': case 'experiments': return c.payloadT || 0;
    case 'servicing': return SERVICING_KIT_T;
    case 'base_module': return moduleDef(data, c.moduleId)?.massT || 0;
    default: return 0;
  }
}
/** A contract as a mission spec for pickConfig (§1.4: carrier, module that flies itself, client payload). */
function contractSpec(state, data, c, actorId = state.playerId, onlyVehicleId = null) {
  const type = missionTypeOf(c.type, c.sub).type;
  const mod = c.payloadKind === 'station_module' ? moduleDef(data, c.moduleId) : null;
  const cargoT = contractCargoT(data, c);
  return {
    type, sub: c.sub || null, destination: c.destination, crewed: type === 'crewed', clientPayload: !!c.clientPayload, actorId,
    noCraft: !!mod, cargoT, extraPayload: c.clientPayload ? 0 : cargoT,
    payloadOverride: c.clientPayload ? c.payloadT : mod ? mod.massT || 1 : null, onlyVehicleId,
  };
}

/** Goods the job buys besides the flight: a module, tonnes of supplies or propellant, a repair kit (US$ mi). */
function contractGoodsM(state, data, c) {
  const mod = c.moduleId ? moduleDef(data, c.moduleId) : null;
  if ((c.payloadKind === 'station_module' || c.payloadKind === 'base_module') && mod) return Number(mod.costM) || 0;
  if (c.payloadKind === 'supply' || c.payloadKind === 'propellant') return supplyCostPerT(state, data) * (c.payloadT || 0) * (c.payloadKind === 'propellant' ? 0.5 : 1);
  if (c.payloadKind === 'servicing') return supplyCostPerT(state, data) * 4;
  return 0;
}
/** Cost of flying the job with a config (rocket + craft from pickConfig): hardware, operations, goods, crew. */
function contractCostOf(state, data, c, cfg) {
  if (!cfg) return null;
  const dest = destDef(data, c.destination);
  const ops = dest?.opsCostM ?? OPS_COST_BY_KEY[dest?.capacityKey] ?? 10;
  const crewed = missionTypeOf(c.type).type === 'crewed';
  const seats = crewed ? spacecraftDef(data, cfg.spacecraftId, state)?.crew || 2 : 0;
  return round1((cfg.cost || 0) + ops + contractGoodsM(state, data, c) + seats * CREW_COST_PER_PERSON);
}

/** Rough market cost of fulfilling a contract (cheapest capable hardware across the catalog, any operator). */
function marketCost(state, data, c) {
  const dest = destDef(data, c.destination);
  if (!dest) return null;
  const ops = dest.opsCostM ?? OPS_COST_BY_KEY[dest.capacityKey] ?? 10;
  const type = missionTypeOf(c.type, c.sub).type;
  const crewed = type === 'crewed';
  const vehicles = (data.vehicles?.vehicles || []).filter((v) => availableByDate(state, v) && (!crewed || v.crewRated));
  let scCost = 0;
  let need = c.payloadT || 0;
  const mod = c.moduleId ? moduleDef(data, c.moduleId) : null;
  if (c.payloadKind === 'station_module' && mod) need = mod.massT || 1;
  else if (!c.clientPayload) {
    const cargoT = contractCargoT(data, c);
    const surface = SURFACE_KINDS.includes(dest.kind);
    const scs = (data.spacecraft?.spacecraft || []).filter((s) => availableByDate(state, s) && scKindsFor(data, type).includes(s.kind) && scOkForDest(s, c.destination)
      && (!crewed || (s.crew || 0) > 0) && (cargoT <= 0 || (cargoCapacityOf(data, s) >= cargoT && (!surface || s.kind === 'lander' || s.kind === 'cargo'))));
    if (!scs.length) return null;
    const cheapest = scs.reduce((a, b) => ((a.costM || 0) <= (b.costM || 0) ? a : b));
    scCost = cheapest.costM || 0;
    need = (cheapest.massT || 0) + cargoT;
  }
  const caps = vehicles.filter((v) => capacityTo(data, v.id, c.destination) * 0.9 >= need);
  if (!caps.length) return null;
  const vc = Math.min(...caps.map((v) => v.costM || 0));
  return vc + scCost + ops + contractGoodsM(state, data, c) + (crewed ? 2 * CREW_COST_PER_PERSON : 0);
}

/** Most the world's rockets lift to a destination today (any live agency, the player's designs included), t. */
function worldLift(state, data, destId) {
  let best = 0;
  for (const id of liveActorIds(state, { tier: 'core' })) {
    for (const v of vehiclesFor(state, data, id)) best = Math.max(best, capacityTo(data, v.id, destId) * 0.9);
  }
  return best;
}

/** Every agency able to fly the job now: [{actorId, cfg, rel, costM}] (the client never bids on its own job). */
function capableField(state, data, c) {
  const out = [];
  for (const id of liveActorIds(state, { tier: 'core' })) {
    const a = state.actors?.[id];
    if (!a || a.dead || a.status === 'gone' || id === c.clientActorId) continue;
    if (id === state.playerId && !rowResearch(state, data, contractRowOf(data, c) || c).ok) continue;
    const cfg = pickConfig(state, data, contractSpec(state, data, c, id));
    if (!cfg) continue;
    out.push({ actorId: id, cfg, rel: Number.isFinite(cfg.rel) ? cfg.rel : 0.85, costM: contractCostOf(state, data, c, cfg) });
  }
  return out;
}

const contractRowOf = (data, c) => contractRows(data).find((r) => (r.kind || r.id) === c?.kind) || null;

/** A rival's sealed bid: its cost × (margin, less when it needs the work or bids aggressively), inside the range. */
function rivalPrice(c, a, costM, rng, T) {
  const budgetM = Math.max(1, Number(a?.budget) || 100);
  const need = clamp(1 - (Number(a?.cash) || 0) / (budgetM * 0.5), 0, 1);
  const r = T.rival;
  const mult = r.margin + r.needSpan * (1 - need) - r.aggression * (a?.ai?.aggression ?? 0.5);
  const raw = (costM || c.costM || 1) * mult * rng.range(1 - r.jitter, 1 + r.jitter);
  return { price: Math.round(clamp(raw, c.valueM * T.bidRange[0], c.valueM * T.bidRange[1])), need };
}

/** Settled colonies (era 5+) as clients: pseudo-assets {id, name, ownerId, site, kind: 'colony'}. */
function colonyClients(state, data) {
  const list = Array.isArray(state.colonies?.list) ? state.colonies.list : [];
  const sites = Array.isArray(data?.colonies?.sites) ? data.colonies.sites : [];
  const out = [];
  for (const col of list) {
    if (!col || !['active', 'allied', 'independent'].includes(col.status)) continue;
    if (col.ownerId === state.playerId && col.status === 'active') continue; // the agency's own colony does not tender
    const site = sites.find((s) => s.id === col.siteId);
    const destId = site?.destination || null;
    if (!destId || !destDef(data, destId)) continue;
    out.push({ id: col.id, name: col.name || site.name || col.siteId, ownerId: col.status === 'independent' ? null : col.ownerId || null, site: destId, kind: 'colony' });
  }
  return out;
}

/** Eligible (row, client asset|colony|null, destination) for the board, the world's view (no player research). */
function tenderCandidates(state, data) {
  const out = contractCandidates(state, data, { world: true });
  const caps = contractCaps(data);
  const cols = colonyClients(state, data);
  for (const row of contractRows(data)) {
    if (!row.colony) continue;
    if (!contractEligible(state, data, row, { world: true, colony: true }).ok) continue;
    for (const col of cols) {
      if ((state.contracts || []).some((c) => c.colonyId === col.id && state.turn - (c.createdTurn ?? -999) < caps.perAssetWeeks)) continue;
      const dest = destDef(data, col.site);
      if (!destOpenNow(state, dest) || !destOkForType(dest, missionTypeOf(row.type).type)) continue;
      out.push({ row, asset: col, destination: col.site });
    }
  }
  return out;
}

/** Sizes to try for a tender: the drawn one first, then the smaller ones (a job nobody can fly shrinks). */
function sizeOrder(rng, T) {
  const ids = Object.keys(T.sizes);
  const first = rng.weighted(ids, (id) => Number(T.sizes[id]?.w) || 0) || ids[0];
  return [first, ...ids.slice(0, ids.indexOf(first)).reverse()];
}

/** A tender from a candidate, or null when nobody in the world can fly it (at any size) or the dates do not fit. */
function buildTender(state, data, rng, pick, stepEnd, T) {
  const { row: k, asset, destination } = pick;
  const pid = state.playerId;
  const type = missionTypeOf(k.type, k.sub);
  const sub = type.sub || resolveSub(state, data, { type: type.type, destination, clientPayload: !!k.clientPayload });
  const payloadKind = payloadKindOf(data, { type: type.type, clientPayload: !!k.clientPayload }, sub);
  let moduleId = null;
  let fixedT = null;
  if (payloadKind === 'station_module' || payloadKind === 'base_module') {
    if (asset?.kind === 'colony') return null;
    moduleId = nextModuleFor(data, asset, payloadKind === 'station_module' ? 'station' : 'base');
    if (!moduleId) return null;
    fixedT = round1(moduleDef(data, moduleId)?.massT || 0);
  } else if (payloadKind === 'servicing') fixedT = SERVICING_KIT_T;
  else if (type.type === 'crewed' || !(Array.isArray(k.payload) && k.payload[1] > 0)) fixedT = 0;
  const colony = asset?.kind === 'colony' ? asset : null;
  const ownerName = colony ? colony.name : asset ? actorName(state, asset.ownerId) : '';
  const vars = { asset: asset?.name || destDef(data, destination)?.name || '', owner: ownerName };
  const ownerKind = asset?.ownerId ? state.actors?.[asset.ownerId]?.kind : null;
  const base = {
    id: null, kind: k.kind || k.id, title: fillAsset(k.title, vars).slice(0, 80), client: fillAsset(rng.pick(k.clients || ['Cliente']), vars), body: fillAsset(k.body, vars),
    clientKind: colony ? 'colonia' : asset ? (ownerKind === 'company' ? 'empresa' : 'agencia') : k.clientKind || 'empresa',
    type: type.type, sub, payloadKind, destination, payloadT: 0, clientPayload: !!k.clientPayload, size: k.size || 'medium',
    ...(moduleId ? { moduleId } : {}), ...(asset && !colony ? { targetAssetId: asset.id, clientActorId: asset.ownerId } : {}),
    ...(colony ? { colonyId: colony.id, ...(colony.ownerId ? { clientActorId: colony.ownerId } : {}) } : {}),
    valueM: 0, costM: 0, createdTurn: state.turn, closeTurn: 0, deadlineTurn: 0,
    status: 'open', rivals: [], playerBid: null, winner: null, winningPrice: null, missionId: null, advancePaidM: 0, late: false,
  };
  const range = Array.isArray(k.payload) ? k.payload : [0, 0];
  const lift = fixedT == null && k.clientPayload ? worldLift(state, data, destination) : Infinity;
  for (const size of fixedT == null ? sizeOrder(rng, T) : [base.size]) {
    let payloadT = fixedT;
    if (payloadT == null) {
      const lo = range[0];
      const hi = Math.min(range[1], lift);
      if (!(hi >= lo)) return null;
      const f = T.sizes[size]?.f || [0.3, 0.6];
      payloadT = roundT(lo + rng.range(f[0], f[1]) * (hi - lo));
    }
    const c = { ...base, size, payloadT };
    const field = capableField(state, data, c);
    if (!field.length) continue;
    // reference price: the typical cost of flying it (the mean of the capable agencies, never below the open market)
    const typical = field.reduce((s, x) => s + (x.costM || 0), 0) / field.length;
    c.costM = round1(Math.max(typical, marketCost(state, data, c) || 0));
    if (!(c.costM > 0)) return null;
    c.valueM = Math.max(2, Math.round(c.costM * rng.range(T.refMult[0], T.refMult[1]) * (Number(k.refMult) || 1)));
    c.closeTurn = Math.max(state.turn + rng.int(T.bidWeeks[0], T.bidWeeks[1]), stepEnd + 1);
    const dl = Array.isArray(k.deadline) ? k.deadline : [30, 56];
    let weeks = Math.round(rng.int(dl[0], dl[1]) * stepScale(state));
    // a destination with launch windows: the first window after the preparation must fit before the deadline
    const w = windowFor(state, data, destination, c.closeTurn + (LEAD_BY_SOURCE.contract || 4));
    if (Number.isFinite(w?.openTurn)) weeks = Math.max(weeks, w.openTurn - c.closeTurn + 8);
    c.deadlineTurn = Math.min(c.closeTurn + weeks, state.endTurn);
    if (c.deadlineTurn - c.closeTurn < 8) return null;
    // sealed rival bids (deterministic per tender); each capable agency bids unless it has no need for the work
    const bidRng = rngFor(state.seed, 'tenders', 'bids', state.turn, c.title, c.destination);
    const rivals = bidRng.shuffle(field.filter((x) => x.actorId !== pid));
    for (const x of rivals) {
      if (c.rivals.length >= T.rivalsMax) break;
      const a = state.actors[x.actorId];
      const { price, need } = rivalPrice(c, a, x.costM, bidRng, T);
      if (c.rivals.length && !bidRng.chance(T.rival.bidP + T.rival.needP * need)) continue;
      c.rivals.push({ actorId: x.actorId, price, reliability: round1(x.rel * 1000) / 1000, vehicleId: x.cfg.vehicleId, costM: x.costM });
    }
    c.feasAtCreate = field.some((x) => x.actorId === pid);
    c.id = nextId(state, 'ctr');
    return c;
  }
  return null;
}

/** A new tender for the board, or null (nothing eligible, or nobody can fly what is). */
function makeTender(state, data, rng, stepEnd) {
  const T = boardTuning(data);
  const open = (state.contracts || []).filter(isOpenTender);
  const same = (x, c) => c.kind === (x.row.kind || x.row.id) && c.destination === x.destination && (c.targetAssetId || c.colonyId || null) === (x.asset?.id || null);
  let cands = tenderCandidates(state, data).filter((x) => !open.some((c) => same(x, c)));
  for (let attempt = 0; attempt < 4 && cands.length; attempt++) {
    // a row's weight is shared by its candidates (ten stations do not make supply contracts ten times likelier)
    const perRow = new Map();
    for (const x of cands) perRow.set(x.row, (perRow.get(x.row) || 0) + 1);
    const pick = rng.weighted(cands, (x) => (Number(x.row.weight) || 1) / perRow.get(x.row));
    if (!pick) return null;
    const c = buildTender(state, data, rng, pick, stepEnd, T);
    if (c) return c;
    cands = cands.filter((x) => x !== pick);
  }
  return null;
}

/** Board refresh: new tenders every few weeks while there is room (no card: the board is a screen). */
function tenderBoard(state, data, ctx) {
  const T = boardTuning(data);
  const tn = tendersSlice(state);
  if (Number.isFinite(state.endTurn) && state.turn > state.endTurn - 20) return;
  if (tn.next != null && state.turn < tn.next) return;
  const stepEnd = Number.isFinite(ctx?.stepEnd) ? ctx.stepEnd : state.turn + 1;
  const burst = tn.next == null ? Math.max(1, T.startBurst) : 1;
  for (let i = 0; i < burst; i++) {
    if ((state.contracts || []).filter(isOpenTender).length >= T.openMax) break;
    const c = makeTender(state, data, ctx.rng(`tender:${i}`), stepEnd);
    if (!c) break;
    state.contracts.push(c);
    stat(state, 'contractsOffered');
  }
  const gap = Array.isArray(T.gapWeeks) ? T.gapWeeks : [3, 7];
  tn.next = state.turn + ctx.rng('tender:gap').int(gap[0], gap[1]);
}

/** Old saves: the bid cards of the push-offer system are gone (their contracts stay on the board as tenders). */
function retireOfferCards(state) {
  if (!(state.decisions || []).some((d) => d.kind === 'contract/offer')) return;
  state.decisions = state.decisions.filter((d) => d.kind !== 'contract/offer');
}

// --- the player's side: feasibility, rockets, odds ---

/** The player's config for a tender with a given rocket (null = the engineers' pick), or null. */
function playerConfig(state, data, c, vehicleId = null) {
  return pickConfig(state, data, contractSpec(state, data, c, state.playerId, vehicleId || null));
}

/** A contract as the draft of its mission (used for the bill, the research gate and the launch date). */
function contractDraft(state, data, c, cfg = null) {
  const type = missionTypeOf(c.type, c.sub);
  const crewed = type.type === 'crewed';
  const sc = spacecraftDef(data, cfg?.spacecraftId, state);
  const payload = contractPayload(data, c);
  // v0.8 contracts (and client payloads) carry the total mass in config.payloadT; v2 cargo carries its tonnes in payload
  const legacyMass = c.clientPayload || !c.payloadKind;
  return {
    name: c.title, source: 'contract', contractId: c.id,
    type: type.type, sub: c.sub || type.sub || null, ...(payload ? { payload } : {}), destination: c.destination,
    vehicleId: cfg?.vehicleId || null, spacecraftId: cfg?.spacecraftId || null, clientPayload: !!c.clientPayload, crewed,
    crew: autoCrew(state, data, crewed ? sc?.crew || 0 : 0),
    config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: legacyMass ? cfg?.payloadT ?? c.payloadT : null },
    deadlineTurn: c.deadlineTurn,
  };
}

/** The bill of the job for the player with a config (computeCost, crew seats included). */
function playerCostOf(state, data, c, cfg) {
  if (!cfg) return null;
  const d = normalizeDraft(contractDraft(state, data, c, cfg));
  let total = computeCost(state, data, d).total;
  if (d.crewed && !crewIdsOf(d).length) total += (spacecraftDef(data, cfg.spacecraftId, state)?.crew || 2) * CREW_COST_PER_PERSON;
  return round1(total);
}

/** Every rocket of the player that flies the job: [{vehicleId, name, rel, capT, costM, cfg}] (cheapest score first). */
function playerVehicleOptions(state, data, c) {
  const out = [];
  const crewed = missionTypeOf(c.type).type === 'crewed';
  for (const v of vehiclesFor(state, data, state.playerId)) {
    if (crewed && !crewRatedV(state, data, v)) continue;
    const cfg = playerConfig(state, data, c, v.id);
    if (!cfg) continue;
    out.push({ vehicleId: v.id, name: v.name || v.id, scName: cfg.spacecraftId ? spacecraftDef(data, cfg.spacecraftId, state)?.name || null : null, rel: cfg.rel, capT: round1(capacityTo(data, v.id, c.destination) * (1 + techBonus(state, 'payload')) * 0.9), needT: roundT(cfg.payloadT || 0), costM: playerCostOf(state, data, c, cfg), cfg, score: cfg.score });
  }
  return out.sort((a, b) => a.score - b.score || a.costM - b.costM);
}

/** Why the player has no rocket/craft for a job, with what would open one (research, market, Hangar). */
function hardwareWhy(state, data, c) {
  const pid = state.playerId;
  const type = missionTypeOf(c.type).type;
  const crewed = type === 'crewed';
  const dest = destDef(data, c.destination);
  const to = toWhere(dest, c.destination);
  const spec = contractSpec(state, data, c, pid);
  let need = spec.payloadOverride ?? null;
  if (need == null) {
    const surface = SURFACE_KINDS.includes(dest?.kind);
    const fits = (s) => scOkForType(s, type, crewed, data) && scOkForDest(s, c.destination) && (!c.sub || scOkForSub(data, s, type, c.sub))
      && (spec.cargoT <= 0 || (cargoCapacityOf(data, s) + 1e-9 >= spec.cargoT && (!surface || s.kind === 'lander' || (s.kind === 'cargo' && (s.destinations || []).includes(c.destination)))));
    const mine = spacecraftFor(state, data, pid).filter(fits);
    if (!mine.length) {
      let locked = null;
      try { locked = (fn(calendar, 'availableSpacecraft')?.(state, data, pid, { withLocked: true }) || []).find((x) => !x.ok && fits(x.item)) || null; } catch { locked = null; }
      const what = spec.cargoT > 0 ? `leva ${tonsText(spec.cargoT)} de carga ${to}` : crewed ? `leva tripulação ${to}` : `serve para esta missão ${to}`;
      return `Nenhuma nave sua ${what}${locked?.reason ? `; ${lowerFirst(locked.reason)}` : ''}.`;
    }
    need = Math.min(...mine.map((s) => s.massT ?? 1)) + spec.extraPayload;
  }
  const bonus = 1 + techBonus(state, 'payload');
  const vs = vehiclesFor(state, data, pid).filter((v) => !crewed || crewRatedV(state, data, v));
  const maxLift = vs.reduce((m, v) => Math.max(m, capacityTo(data, v.id, c.destination) * bonus * 0.9), 0);
  let text = `Nenhum foguete seu${crewed ? ' certificado para tripulação' : ''} leva ${tonsText(need)} ${to}${maxLift > 0 ? ` (o maior leva ${tonsText(maxLift)})` : ''}`;
  let locked = [];
  try { locked = (fn(calendar, 'availableVehicles')?.(state, data, pid, { withLocked: true, crewed }) || []).filter((x) => !x.ok && capacityTo(data, x.item.id, c.destination) * bonus * 0.9 >= need); } catch { locked = []; }
  const research = locked.find((x) => x.nodeId && /^Pesquise /.test(x.reason || ''));
  // a rocket of another operator that a launch agreement could open (not one kept for its own use, embargoed or blocked)
  const market = locked.find((x) => !x.nodeId && x.item.access !== 'own' && !/Embargo|tensão|Sonda única/i.test(x.reason || ''));
  const hints = [];
  if (research) hints.push(lowerFirst(research.reason));
  if (market) hints.push(`contrate um lançador (${market.item.name}${market.item.operator ? `, de ${actorName(state, market.item.operator)}` : ''})`);
  if (!hints.length) hints.push('projete um foguete maior no Hangar');
  text += `; ${hints.join(' ou ')}.`;
  return text;
}
const fillAsset = (t, vars) => String(t || '').replace(/\{(asset|owner)\}/g, (_, k) => vars[k] ?? '');
const lowerFirst = (s) => (s ? String(s).charAt(0).toLowerCase() + String(s).slice(1) : '');
const upperFirst = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const relText = (p) => { const x = (Number(p) || 0) * 100; return x >= 95 ? `${(Math.floor(x * 10) / 10).toFixed(1).replace('.', ',')}%` : `${Math.round(x)}%`; };

/** Bids of the player still waiting (they take an own-mission slot of the year if they win). */
const pendingBids = (state, exceptId = null) => (state.contracts || []).filter((x) => x.id !== exceptId && x.status === 'bidding' && x.playerBid).length;

/**
 * "Você consegue entregar?" → {level: 'ok'|'warn'|'bad', text, reasons: [{level, text}], vehicles, vehicleId, rel,
 * costM, earliestTurn}. Research, the client's trust, a rocket (and craft) that carries it, time before the
 * deadline, the investors' agenda; warnings for a shaky rocket, a cost that eats the margin and a short cash.
 */
export function tenderFeasibility(state, data, c, vehicleId = null) {
  syncDesignCatalog(state, data);
  const pid = state.playerId;
  const T = boardTuning(data);
  const reasons = [];
  const bad = (text) => reasons.push({ level: 'bad', text });
  const warn = (text) => reasons.push({ level: 'warn', text });
  const dest = destDef(data, c.destination);
  const row = contractRowOf(data, c);
  // research: the same gate the mission will meet (type, subtype, payload, docking), plus the row's own keys
  const d = normalizeDraft(contractDraft(state, data, c, null));
  const sub = resolveSub(state, data, d);
  const target = c.targetAssetId ? assetOf(state, c.targetAssetId) : null;
  const mg = peerFn('gating', 'missionGate');
  let g = null;
  try { g = mg ? mg(state, data, gateSpecOf(state, data, d, sub, payloadKindOf(data, d, sub), target, dest), pid) : null; } catch { g = null; }
  if (g && g.ok === false) bad(g.reason || 'Falta pesquisa para esta missão.');
  else {
    for (const k of row?.needs?.playerKeys || []) {
      if (playerHolds(state, data, k)) continue;
      let r = null;
      try { r = peerFn('gating', 'firstMissing')?.(state, data, [k], pid) || null; } catch { r = null; }
      bad(r?.reason ? `${r.reason}.` : 'Falta pesquisa para esta missão.');
      break;
    }
  }
  // the client's trust (stations, bases, colonies of another owner)
  const owner = c.clientActorId && c.clientActorId !== pid ? c.clientActorId : null;
  if (owner && row?.needs) {
    const n = row.needs;
    const trust = trustBetween(state, pid, owner);
    if (Number.isFinite(n.relation?.minTrust) && trust < n.relation.minTrust) bad(`${actorName(state, owner)} não confia na agência o bastante para contratá-la (confiança ${Math.round(trust)}, precisa de ${n.relation.minTrust}).`);
    if (Number.isFinite(n.noTensionAbove) && tensionBetween(state, pid, owner) > n.noTensionAbove) bad(`A tensão com ${actorName(state, owner)} impede o contrato.`);
  }
  // hardware
  const vehicles = playerVehicleOptions(state, data, c);
  const chosen = (vehicleId && vehicles.find((v) => v.vehicleId === vehicleId)) || vehicles[0] || null;
  if (!vehicles.length) bad(hardwareWhy(state, data, c));
  else if (vehicleId && chosen.vehicleId !== vehicleId) warn('O foguete escolhido não leva esta carga: a estimativa usa o melhor que você tem.');
  // time: the mission opens when bidding closes; preparation + launch window must fit before the deadline
  let earliestTurn = null;
  if (chosen) {
    const from = Math.max(state.turn, c.closeTurn || state.turn) + (LEAD_BY_SOURCE.contract || 4);
    const w = windowFor(state, data, c.destination, from);
    earliestTurn = Math.max(from, Number.isFinite(w?.openTurn) ? w.openTurn : from);
    const pq = productionQueueFor(state, data, { vehicleId: chosen.vehicleId }, null);
    if (pq && Number.isFinite(pq.nextFreeTurn)) earliestTurn = Math.max(earliestTurn, pq.nextFreeTurn);
    if (earliestTurn > c.deadlineTurn) bad(`Não dá tempo: o primeiro lançamento possível é ${fmtT(state, earliestTurn)}, depois do prazo (${fmtT(state, c.deadlineTurn)}).`);
    else if (c.deadlineTurn - earliestTurn < 6) warn(`Prazo apertado: o primeiro lançamento possível é ${fmtT(state, earliestTurn)} e o prazo acaba em ${fmtT(state, c.deadlineTurn)}.`);
    if (chosen.rel < 0.85) warn(`${chosen.name} ainda é pouco confiável (${relText(chosen.rel)}): sem tempo para repetir, uma falha custa multa de ${pct(T.finePct)} do preço.`);
    if (chosen.costM > c.valueM * T.bidRange[0]) warn(`Seu custo provável com o ${chosen.name} (${fmtMoney(chosen.costM)}) passa de ${pct(T.bidRange[0])} do valor de referência: lances baixos dão prejuízo.`);
    const cash = state.actors?.[pid]?.cash ?? 0;
    if (cash + c.valueM * T.advance < chosen.costM) warn(`Caixa curto: o voo custa ${fmtMoney(chosen.costM)} e você tem ${fmtMoney(cash)}.`);
  }
  // the investors' agenda: a won contract is one of the agency's own missions of the year (EXPANSION.md §5.2)
  const ag = agendaOf(state, data);
  if (ag?.enforced && ag.left - pendingBids(state, c.id) <= 0) bad(agendaFullText(ag));
  const level = reasons.some((r) => r.level === 'bad') ? 'bad' : reasons.some((r) => r.level === 'warn') ? 'warn' : 'ok';
  const first = reasons.find((r) => r.level === level);
  const text = level === 'ok'
    ? (c.clientPayload || !chosen.scName
      ? `Sim: o ${chosen.name} leva ${tonsText(chosen.needT)} ${toWhere(dest, c.destination)} (até ${tonsText(chosen.capT)}), confiabilidade ${relText(chosen.rel)}.`
      : `Sim: o ${chosen.name} leva a ${chosen.scName} ${toWhere(dest, c.destination)} (${tonsText(chosen.needT)} com a carga, até ${tonsText(chosen.capT)}), confiabilidade ${relText(chosen.rel)}.`)
    : first.text;
  return {
    level, text, reasons, earliestTurn,
    vehicles: vehicles.map((v) => ({ vehicleId: v.vehicleId, name: v.name, scName: v.scName, rel: v.rel, capT: v.capT, needT: v.needT, costM: v.costM })),
    vehicleId: chosen?.vehicleId || null, vehicleName: chosen?.name || null, rel: chosen?.rel ?? null, costM: chosen?.costM ?? null,
  };
}

/** The tender's bidders with their win odds: rivals' sealed bids plus the player's (price, rocket) when given. */
function tenderField(state, data, c, { price = null, vehicleId = null } = {}) {
  const T = boardTuning(data).chance;
  const pid = state.playerId;
  const out = [];
  for (const r of c.rivals || []) {
    const a = state.actors?.[r.actorId];
    if (!a || a.dead || a.status === 'gone') continue;
    out.push({ actorId: r.actorId, price: r.price, rel: Number.isFinite(r.reliability) ? r.reliability : 0.85, rep: a.reputation ?? 50 });
  }
  if (Number.isFinite(price) && price > 0) {
    const cfg = playerConfig(state, data, c, vehicleId) || (vehicleId ? playerConfig(state, data, c, null) : null);
    if (cfg) out.push({ actorId: pid, price, rel: Number.isFinite(cfg.rel) ? cfg.rel : 0.85, rep: state.actors?.[pid]?.reputation ?? 50, player: true, vehicleId: cfg.vehicleId });
  }
  for (const e of out) e.score = T.price * (c.valueM / Math.max(1, e.price)) + T.rep * e.rep + T.rel * (e.rel - 0.8) + recordBonus(state, data, e.actorId);
  const top = Math.max(...out.map((e) => e.score));
  let sum = 0;
  for (const e of out) sum += (e.w = Math.exp((e.score - top) / Math.max(0.5, T.temp)));
  for (const e of out) e.p = sum > 0 ? e.w / sum : 0;
  return out;
}

/**
 * The bid sheet's live numbers for a price and a rocket: {price, chance, field: [{actorId, name, p, player}],
 * favourite, costM, marginM, marginPct, advanceM, fineM, bidMin, bidMax, rel, vehicleId}. Rival prices stay sealed.
 */
export function tenderOdds(state, data, c, price, vehicleId = null) {
  syncDesignCatalog(state, data);
  const T = boardTuning(data);
  const bidMin = Math.ceil(c.valueM * T.bidRange[0]);
  const bidMax = Math.floor(c.valueM * T.bidRange[1]);
  const p = clamp(Math.round(Number.isFinite(Number(price)) ? Number(price) : c.valueM), bidMin, bidMax);
  const field = tenderField(state, data, c, { price: p, vehicleId });
  const me = field.find((e) => e.player) || null;
  const fav = field.reduce((b, e) => (!b || e.p > b.p ? e : b), null);
  const cfg = me ? playerConfig(state, data, c, me.vehicleId) : null;
  const costM = cfg ? playerCostOf(state, data, c, cfg) : null;
  return {
    price: p, chance: me ? me.p : 0, bidMin, bidMax, rel: me?.rel ?? null, vehicleId: me?.vehicleId || null,
    field: field.map((e) => ({ actorId: e.actorId, name: e.player ? 'Sua agência' : actorName(state, e.actorId), p: e.p, player: !!e.player })).sort((a, b) => b.p - a.p),
    favourite: fav ? { actorId: fav.actorId, name: fav.player ? 'Sua agência' : actorName(state, fav.actorId), p: fav.p, player: !!fav.player } : null,
    costM, marginM: costM != null ? round1(p - costM) : null, marginPct: costM ? (p - costM) / costM : null,
    advanceM: Math.round(p * T.advance), fineM: Math.round(p * T.finePct),
  };
}

/** Place or change the player's sealed bid. */
function placeBid(state, data, contractId, price, vehicleId = null) {
  const c = (state.contracts || []).find((x) => x.id === contractId);
  if (!c || !isOpenTender(c) || state.turn > c.closeTurn) return { ok: false, status: 'gone', error: 'Esta concorrência já foi encerrada.' };
  const T = boardTuning(data);
  const f = tenderFeasibility(state, data, c, vehicleId || null);
  if (f.level === 'bad') return { ok: false, error: f.text };
  if (vehicleId && !f.vehicles.some((v) => v.vehicleId === vehicleId)) return { ok: false, error: 'Este foguete não leva a carga deste contrato.' };
  const p = Math.round(Number(price));
  const lo = Math.ceil(c.valueM * T.bidRange[0]);
  const hi = Math.floor(c.valueM * T.bidRange[1]);
  if (!Number.isFinite(p) || p < lo || p > hi) return { ok: false, error: `O lance precisa ficar entre ${fmtMoney(lo)} e ${fmtMoney(hi)}.` };
  const first = !c.playerBid;
  c.playerBid = { price: p, vehicleId: vehicleId || null, turn: state.turn };
  c.status = 'bidding';
  if (first) stat(state, 'contractsBid');
  const odds = tenderOdds(state, data, c, p, vehicleId || null);
  return { ok: true, contractId: c.id, price: p, chance: odds.chance };
}

function withdrawBid(state, data, contractId) {
  const c = (state.contracts || []).find((x) => x.id === contractId);
  if (!c || !isOpenTender(c) || state.turn > c.closeTurn) return { ok: false, status: 'gone', error: 'Esta concorrência já foi encerrada.' };
  if (!c.playerBid) return { ok: false, error: 'Você não tem lance neste contrato.' };
  c.playerBid = null;
  c.status = 'open';
  return { ok: true, contractId: c.id };
}

// --- old push-offer cards (saves before v0.9.12): a stale card still answers, as a bid at its level ---
const BID_LEVELS = { bid_low: 0.85, bid_mid: 1.0, bid_high: 1.15 };
function resolveContractOffer(state, data, dec, choiceId) {
  const c = (state.contracts || []).find((x) => x.id === dec.payload?.contractId);
  if (!c || !isOpenTender(c)) return { ok: true, status: 'gone', message: 'Este contrato já foi decidido.' };
  if (BID_LEVELS[choiceId]) {
    const r = placeBid(state, data, c.id, c.valueM * BID_LEVELS[choiceId]);
    if (!r.ok) return { ok: true, status: 'refused', message: r.error };
  }
  return { ok: true, contractId: c.id };
}

// --- closing, awarding, flying ---

/** Close the tenders whose bidding ended: one winner drawn with the board's odds. */
function closeTenders(state, data) {
  const pid = state.playerId;
  for (const c of state.contracts || []) {
    if (!isOpenTender(c) || state.turn < c.closeTurn) continue;
    for (const d of (state.decisions || []).filter((x) => x.kind === 'contract/offer' && x.payload?.contractId === c.id)) removeDecision(state, d.id);
    const field = tenderField(state, data, c, { price: c.playerBid?.price ?? null, vehicleId: c.playerBid?.vehicleId ?? null });
    if (c.playerBid && !field.some((e) => e.player)) {
      addNews(state, {
        headline: `Proposta da ${actorName(state, pid)} desclassificada: ${lowerFirst(c.title)}`,
        body: `${c.client} não aceitou a proposta: a agência não tem mais um foguete capaz para a entrega.`,
        tags: ['contract'], actors: [pid], importance: 1,
      });
    }
    if (!field.length) { c.status = 'expired'; c.resolvedTurn = state.turn; c.body = ''; continue; }
    let r = rngFor(state.seed, 'tenders', 'award', c.id).next();
    let win = field[field.length - 1];
    for (const e of field) { r -= e.p; if (r < 0) { win = e; break; } }
    c.field = field.map((e) => ({ actorId: e.actorId, price: e.price, p: Math.round(e.p * 1000) / 1000 }));
    c.winner = win.actorId;
    c.winningPrice = win.price;
    emitSignal(state, 'contract/awarded', { contractId: c.id, winner: win.actorId });
    if (win.player) awardToPlayer(state, data, c, win);
    else awardToRival(state, data, c, win);
  }
}

function awardToRival(state, data, c, win) {
  const T = boardTuning(data);
  const pid = state.playerId;
  const r = (c.rivals || []).find((x) => x.actorId === win.actorId) || {};
  c.status = 'closed';
  c.advancePaidM = Math.round(win.price * T.advance);
  receive(state, win.actorId, c.advancePaidM, 'contracts', c.title);
  changeActor(state, win.actorId, 'reputation', T.rep.win);
  recordBump(state, win.actorId, 'won');
  // flown off-screen: a delivery date inside the deadline, one roll on the rocket's reliability at that date
  const span = Math.max(1, c.deadlineTurn - state.turn);
  c.ai = { deliverTurn: state.turn + Math.max(1, Math.round(span * rngFor(state.seed, 'tenders', 'aiDate', c.id).range(0.2, 0.6))), rel: win.rel, vehicleId: r.vehicleId || null, done: null, ok: null };
  // the save keeps what the board shows of a rival's job: who bid what, the odds, the delivery roll (no pitch text)
  c.body = '';
  c.rivals = (c.rivals || []).map((x) => ({ actorId: x.actorId, price: x.price }));
  const mine = c.field?.find((e) => e.actorId === pid);
  if (c.playerBid || c.size === 'large') {
    addNews(state, {
      headline: `${actorName(state, win.actorId)} vence a concorrência: ${lowerFirst(c.title)}`,
      body: c.playerBid
        ? `A proposta da ${actorName(state, pid)} (${fmtMoney(c.playerBid.price)}, ${pct(mine?.p ?? 0)} de chance) perdeu para ${fmtMoney(win.price)}.`
        : `${c.client} fecha por ${fmtMoney(win.price)}.`,
      tags: ['contract'], actors: [win.actorId], importance: c.playerBid ? 2 : 1,
    });
  }
}

/** Rival contracts reach their delivery date: success pays the rest, failure costs the fine and reputation. */
function rivalDeliveries(state, data) {
  const T = boardTuning(data);
  for (const c of state.contracts || []) {
    if (c.status !== 'closed' || !c.ai || c.ai.done != null || state.turn < c.ai.deliverTurn) continue;
    c.ai.done = state.turn;
    c.resolvedTurn = state.turn;
    const a = state.actors?.[c.winner];
    if (!a || a.dead || a.status === 'gone') { c.ai.ok = false; continue; }
    const ok = rngFor(state.seed, 'tenders', 'aiFlight', c.id).next() < clamp(c.ai.rel ?? 0.85, 0.5, 0.995) * 0.98;
    c.ai.ok = ok;
    const vName = vehicleDef(data, c.ai.vehicleId, state)?.name || null;
    if (ok) {
      receive(state, c.winner, Math.max(0, (c.winningPrice || 0) - (c.advancePaidM || 0)), 'contracts', c.title);
      recordBump(state, c.winner, 'ok');
      if (c.size === 'large' || c.playerBid) {
        addNews(state, {
          headline: `${actorName(state, c.winner)} entrega para ${c.client}`,
          body: `${upperFirst(contractWhatText(state, data, c))}${vName ? ` Voou num ${vName}.` : ''}`,
          tags: ['contract'], actors: [c.winner], importance: 1,
        });
      }
    } else {
      const fine = Math.round((c.winningPrice || 0) * T.finePct);
      changeActor(state, c.winner, 'cash', -fine);
      changeActor(state, c.winner, 'reputation', T.rep.rivalFail);
      recordBump(state, c.winner, 'bad');
      addNews(state, {
        headline: `Falha da ${actorName(state, c.winner)}: ${c.client} perde a carga`,
        body: `${vName ? `O ${vName} falhou. ` : ''}A agência paga multa de ${fmtMoney(fine)} e o contrato vai para a lista negra dos clientes.`,
        tags: ['contract', 'failure'], actors: [c.winner], importance: 1,
      });
    }
  }
}

/** "Carga: 2,5 t até a ISS" / "Módulo Laboratório para a Mir" / "Tripulação para a ISS" (contract card line). */
function contractWhatText(state, data, c) {
  const dest = destDef(data, c.destination);
  const where = dest?.name || c.destination;
  const asset = c.targetAssetId ? assetOf(state, c.targetAssetId) : null;
  const to = asset?.name || where;
  if (c.payloadKind === 'station_module' || c.payloadKind === 'base_module') return `Módulo ${moduleLabel(moduleDef(data, c.moduleId))} (${tonsText(c.payloadT)}) para ${to}.`;
  if (c.type === 'crewed') return c.sub === 'tourism' ? `Turistas em ${where}.` : `Tripulação para ${to}.`;
  if (c.payloadKind === 'servicing') return `Kit de reparo para ${to}.`;
  if (c.clientPayload) return `Carga do cliente: ${tonsText(c.payloadT)} ${toWhere(dest, c.destination)}.`;
  return `Carga: ${tonsText(c.payloadT)} até ${to}.`;
}

/** The mission payload a contract asks for (§1.4): tonnes, module, kit, client mass; with its target asset. */
function contractPayload(data, c) {
  const pk = c.payloadKind || (c.clientPayload ? 'client' : null);
  if (!pk && !c.targetAssetId) return null;
  const p = { kind: pk || null, targetAssetId: c.targetAssetId || null };
  if (pk === 'supply' || pk === 'propellant') p.qty = c.payloadT;
  if (pk === 'experiments' || pk === 'client') p.massT = c.payloadT;
  if (pk === 'station_module' || pk === 'base_module') p.moduleId = c.moduleId || null;
  return p;
}

/**
 * The mission of a player contract, without hardware (item 9): the rocket of the bid (or the engineers' pick) is
 * only a suggestion. `retry`: the second attempt after a failed launch.
 */
function contractMission(state, data, c, { retry = false } = {}) {
  const vid = c.playerBid?.vehicleId || null;
  const own = vid ? playerConfig(state, data, c, vid) : null;
  const cfg = own || playerConfig(state, data, c, null);
  const draft = contractDraft(state, data, c, cfg);
  const n = (state.stats?.['missions.contractsWon'] || 0) + (retry ? 0 : 1);
  draft.name = (retry ? `${c.title} (2ª tentativa)` : `Contrato ${n}: ${c.title}`).slice(0, 60);
  const res = createMission(state, data, withoutHardware(draft, own ? SUGGEST_BID : SUGGEST_CHEAPEST));
  if (res.ok) c.missionId = res.missionId;
  return res;
}

function awardToPlayer(state, data, c, win = null) {
  const T = boardTuning(data);
  const pid = state.playerId;
  c.status = 'awarded';
  recordBump(state, pid, 'won');
  const res = contractMission(state, data, c);
  c.advancePaidM = Math.round(c.winningPrice * T.advance);
  receive(state, pid, c.advancePaidM, 'contracts', `Adiantamento: ${c.title}`);
  stat(state, 'contractsIncomeM', c.advancePaidM);
  changeActor(state, pid, 'reputation', T.rep.win);
  const cost = res.ok ? missionById(state, res.missionId) : null;
  addNews(state, {
    headline: `${actorName(state, pid)} vence o contrato: ${lowerFirst(c.title)}`,
    body: `${fmtMoney(c.winningPrice)}${win?.p != null ? ` (a proposta tinha ${pct(win.p)} de chance)` : ''}, com ${fmtMoney(c.advancePaidM)} adiantados. Lançamento até ${fmtT(state, c.deadlineTurn)}.${cost ? ' Escolha o foguete e agende a missão.' : ''}`,
    tags: ['contract', 'win'], actors: [pid], importance: 2,
  });
  stat(state, 'contractsWon');
}

function defaultContract(state, data, contractId, why) {
  const c = (state.contracts || []).find((x) => x.id === contractId);
  if (!c || !PLAYER_CONTRACT.includes(c.status)) return;
  const T = boardTuning(data);
  const pid = state.playerId;
  c.status = 'defaulted';
  c.resolvedTurn = state.turn;
  const penalty = Math.round((c.winningPrice || c.valueM) * T.finePct);
  c.fineM = penalty;
  pay(state, penalty, `Multa contratual: ${c.title}`);
  stat(state, 'contractsFinesM', penalty);
  changeActor(state, pid, 'reputation', T.rep.default);
  changeActor(state, pid, 'support', -2);
  recordBump(state, pid, 'bad');
  stat(state, 'contractsDefaulted');
  addNews(state, {
    headline: `${actorName(state, pid)} rompe contrato e paga multa de ${fmtMoney(penalty)}`,
    body: why === 'cancel' ? `${c.client} procura outro fornecedor.` : `Prazo estourado. ${c.client} cancela a encomenda.`,
    tags: ['contract', 'default'], actors: [pid], importance: 2,
  });
}

/** Deadlines of contracts the player must fly: late (pay cut) at the deadline, called off (fine) after the grace. */
function contractDeadlines(state, data) {
  const T = boardTuning(data);
  const pid = state.playerId;
  const grace = Math.round(T.graceWeeks * stepScale(state));
  for (const c of state.contracts || []) {
    if (!PLAYER_CONTRACT.includes(c.status)) continue;
    const m = missionById(state, c.missionId);
    const flown = m && !['planning', 'scheduled', 'launch', 'cancelled'].includes(m.status);
    if (flown) continue;
    if (c.status === 'awarded' && state.turn > c.deadlineTurn) {
      c.status = 'late';
      c.late = true;
      changeActor(state, pid, 'reputation', T.rep.late);
      addNews(state, {
        headline: `${c.client} reclama do atraso da ${actorName(state, pid)}`,
        body: `O pagamento cai ${pct(T.lateCut)}; sem lançamento até ${fmtT(state, c.deadlineTurn + grace)}, o contrato acaba com multa de ${fmtMoney(Math.round((c.winningPrice || c.valueM) * T.finePct))}.`,
        tags: ['contract', 'late'], actors: [pid], importance: 1,
      });
    } else if (c.status === 'late' && state.turn > c.deadlineTurn + grace) {
      if (m && ['planning', 'scheduled', 'launch'].includes(m.status)) {
        m.contractId = null; // the mission itself is gone with the contract
        cancelMission(state, data, m, { reason: 'contract' });
      }
      defaultContract(state, data, c.id, 'late');
    }
  }
}

/** Settle a player contract when its mission reaches a final result (a failure with time left gets one retry). */
function settleContract(state, data, m, level) {
  const c = (state.contracts || []).find((x) => x.id === m.contractId);
  if (!c || !PLAYER_CONTRACT.includes(c.status)) return 0;
  const T = boardTuning(data);
  const pid = state.playerId;
  const remaining = Math.max(0, (c.winningPrice || c.valueM) - c.advancePaidM);
  const lateF = c.late ? 1 - T.lateCut : 1;
  let paid = 0;
  if (level === 'total' || level === 'partial') {
    paid = Math.round(remaining * lateF * (level === 'total' ? 1 : 0.5));
    receive(state, pid, paid, 'contracts', `Entrega: ${c.title}`);
    stat(state, 'contractsIncomeM', paid);
    c.status = 'delivered';
    c.paidM = (c.advancePaidM || 0) + paid;
    changeActor(state, pid, 'reputation', level === 'total' ? T.rep.deliver : 0);
    recordBump(state, pid, 'ok');
    stat(state, 'contractsDelivered');
    c.resolvedTurn = state.turn;
    return paid;
  }
  // a failed launch: the client accepts one more try when there is time to prepare it before the deadline
  const lead = (LEAD_BY_SOURCE.contract || 4) + 2;
  if (!(c.failures > 0) && c.status === 'awarded' && c.deadlineTurn - state.turn >= lead) {
    c.failures = 1;
    c.missionId = null;
    changeActor(state, pid, 'reputation', T.rep.retry);
    contractMission(state, data, c, { retry: true });
    addNews(state, {
      headline: `${c.client} dá à ${actorName(state, pid)} uma segunda chance`,
      body: `A carga se perdeu, mas o cliente aceita nova tentativa até ${fmtT(state, c.deadlineTurn)}. Outra falha custa multa de ${fmtMoney(Math.round((c.winningPrice || c.valueM) * T.finePct))}.`,
      tags: ['contract'], actors: [pid], importance: 2,
    });
    stat(state, 'contractsRetried');
    return 0;
  }
  c.status = 'failed';
  c.resolvedTurn = state.turn;
  const fine = Math.round((c.winningPrice || c.valueM) * T.finePct);
  c.fineM = fine;
  pay(state, fine, `Multa contratual: ${c.title}`);
  stat(state, 'contractsFinesM', fine);
  changeActor(state, pid, 'reputation', T.rep.fail);
  recordBump(state, pid, 'bad');
  stat(state, 'contractsFailed');
  addNews(state, {
    headline: `${actorName(state, pid)} perde a carga de ${c.client} e paga multa`,
    body: `Sem tempo para outra tentativa antes do prazo: multa de ${fmtMoney(fine)} e a reputação cai.`,
    tags: ['contract', 'failure'], actors: [pid], importance: 2,
  });
  return 0;
}

/** The player's contracts: a mission for an awarded contract that has none alive (e.g. after a cancel failed). */
function missionForContract(state, data, contractId) {
  const c = (state.contracts || []).find((x) => x.id === contractId);
  if (!c || !PLAYER_CONTRACT.includes(c.status)) return { ok: false, error: 'Contrato não encontrado.' };
  const m = missionById(state, c.missionId);
  if (m && m.status !== 'cancelled') return { ok: true, missionId: m.id, existing: true };
  const res = contractMission(state, data, c, { retry: (c.failures || 0) > 0 });
  return res.ok ? { ok: true, missionId: res.missionId } : res;
}

// --- views (Contratos screen) ---

function tenderView(state, data, c) {
  const T = boardTuning(data);
  const dest = destDef(data, c.destination);
  const feas = tenderFeasibility(state, data, c, c.playerBid?.vehicleId || null);
  const odds = tenderOdds(state, data, c, c.playerBid?.price ?? null, c.playerBid?.vehicleId || null);
  const rivalsOnly = tenderField(state, data, c, {});
  const favRival = rivalsOnly.reduce((b, e) => (!b || e.p > b.p ? e : b), null);
  return {
    id: c.id, kind: c.kind, title: c.title, client: c.client, clientKind: c.clientKind || 'empresa', clientKindLabel: CLIENT_KIND_LABELS[c.clientKind] || 'Cliente',
    clientActorId: c.clientActorId || null, body: c.body, what: contractWhatText(state, data, c), type: c.type, sub: c.sub, typeLabel: TYPE_LABELS[c.type] || c.type,
    subLabel: subtypeOf(data, c.type, c.sub)?.label || null, destination: c.destination, destName: dest?.name || c.destination, payloadT: c.payloadT, payloadText: c.payloadT > 0 ? tonsText(c.payloadT) : null,
    size: c.size || 'medium', sizeLabel: SIZE_LABELS[c.size] || 'Médio', refM: c.valueM, costM: c.costM || null,
    bidMin: Math.ceil(c.valueM * T.bidRange[0]), bidMax: Math.floor(c.valueM * T.bidRange[1]), advance: T.advance, finePct: T.finePct,
    closeTurn: c.closeTurn, closeText: fmtT(state, c.closeTurn), closeWeeks: Math.max(0, c.closeTurn - state.turn),
    deadlineTurn: c.deadlineTurn, deadlineText: fmtT(state, c.deadlineTurn), status: c.status,
    playerBid: c.playerBid ? { ...c.playerBid, chance: odds.chance, vehicleName: odds.vehicleId ? vehicleDef(data, odds.vehicleId, state)?.name || null : null } : null,
    rivalsN: (c.rivals || []).filter((r) => state.actors?.[r.actorId]).length,
    rivals: rivalsOnly.map((e) => ({ actorId: e.actorId, name: actorName(state, e.actorId) })),
    favourite: c.playerBid ? odds.favourite : favRival ? { actorId: favRival.actorId, name: actorName(state, favRival.actorId), p: favRival.p, player: false } : null,
    feas,
  };
}

function contractView(state, data, c) {
  const T = boardTuning(data);
  const m = missionById(state, c.missionId);
  const dest = destDef(data, c.destination);
  return {
    id: c.id, title: c.title, client: c.client, clientKind: c.clientKind || null, clientKindLabel: CLIENT_KIND_LABELS[c.clientKind] || null, status: c.status,
    what: contractWhatText(state, data, c), destName: dest?.name || c.destination, winner: c.winner, winnerName: c.winner ? actorName(state, c.winner) : 'Outro fornecedor',
    mine: c.winner === state.playerId, price: c.winningPrice ?? null, refM: c.valueM, advanceM: c.advancePaidM || 0, paidM: c.paidM ?? null, fineM: c.fineM ?? Math.round((c.winningPrice || c.valueM) * T.finePct),
    deadlineTurn: c.deadlineTurn, deadlineText: fmtT(state, c.deadlineTurn), graceText: fmtT(state, c.deadlineTurn + Math.round(T.graceWeeks * stepScale(state))), late: !!c.late,
    failures: c.failures || 0, missionId: m && m.status !== 'cancelled' ? m.id : null, missionName: m?.name || null, missionStatus: m?.status || null,
    needsHardware: !!m && m.status === 'planning' && needsHardware(m), launchText: m?.launchTurn != null ? fmtT(state, m.launchTurn) : null,
    playerBid: c.playerBid ? { price: c.playerBid.price } : null, playerChance: c.field?.find((e) => e.actorId === state.playerId)?.p ?? null,
    bidders: (c.field || []).length, resolvedTurn: c.resolvedTurn ?? c.closeTurn, resolvedText: fmtT(state, c.resolvedTurn ?? c.closeTurn),
    ai: c.ai ? { done: c.ai.done != null, ok: c.ai.ok } : null,
  };
}

/** The Contratos screen: open tenders, the player's contracts, recent results and the record. */
function boardView(state, data) {
  const T = boardTuning(data);
  const pid = state.playerId;
  const all = state.contracts || [];
  const open = all.filter(isOpenTender).sort((a, b) => a.closeTurn - b.closeTurn || (a.id < b.id ? -1 : 1));
  const mine = all.filter((c) => PLAYER_CONTRACT.includes(c.status));
  const done = all.filter((c) => !isOpenTender(c) && !PLAYER_CONTRACT.includes(c.status))
    .sort((a, b) => (b.resolvedTurn ?? b.closeTurn ?? 0) - (a.resolvedTurn ?? a.closeTurn ?? 0)).slice(0, 10);
  const st = state.stats || {};
  return {
    open: open.map((c) => tenderView(state, data, c)),
    mine: mine.map((c) => contractView(state, data, c)),
    results: done.map((c) => contractView(state, data, c)),
    record: recordOf(state, pid),
    stats: { won: st['missions.contractsWon'] || 0, delivered: st['missions.contractsDelivered'] || 0, failed: st['missions.contractsFailed'] || 0, defaulted: st['missions.contractsDefaulted'] || 0, bids: st['missions.contractsBid'] || 0 },
    reputation: state.actors?.[pid]?.reputation ?? 50,
    bidRange: T.bidRange, advance: T.advance, finePct: T.finePct, lateCut: T.lateCut, openMax: T.openMax,
    agenda: agendaOf(state, data),
  };
}

// ---------------------------------------------------------------------------------------------
// Launch day, transit, arrival and operations
// ---------------------------------------------------------------------------------------------

// --- Missões v2: the launch scene's target (§7.1) ---

/**
 * SceneTarget snapshot for Launch Day (JSON): infra.sceneTarget when infra.js is bound, else a fallback from the
 * destination (a station destination such as the ISS → 'dock'; a station module founding a station → 'release';
 * a base module/vehicle or supply landing on a surface → 'surface'). null for flights without a target.
 */
export function sceneTarget(state, data, m) {
  if (!m) return null;
  const f = peerFn('infra', 'sceneTarget');
  if (f) {
    try {
      const t = f(state, data, m);
      if (t !== undefined) return t ? JSON.parse(JSON.stringify(t)) : null;
    } catch { /* fallback below */ }
  }
  return fallbackSceneTarget(state, data, m);
}

function fallbackSceneTarget(state, data, m) {
  const { type } = missionTypeOf(m.type, m.sub);
  const dest = destDef(data, m.destination);
  if (!type || !dest) return null;
  const sub = m.sub || resolveSub(state, data, { ...m, type });
  const pk = payloadKindOf(data, { ...m, type }, sub);
  const p = m.payload || {};
  const payload = { kind: pk || null, moduleId: p.moduleId || null, vehicleTypeId: p.vehicleTypeId || null, qty: p.qty || 1 };
  const base = { assetId: p.targetAssetId || null, modules: [], vehicles: [], sizeTier: 0, stageN: 0, bodyId: dest.body || 'earth', site: dest.id, payload, traits: [] };
  const asset = assetOf(state, p.targetAssetId);
  if (asset) {
    base.modules = (asset.modules || []).map((x) => ({ id: x.id, n: x.n || 1 }));
    base.vehicles = (asset.vehicles || []).map((x) => ({ id: x.id, n: x.n || 1 }));
    base.sizeTier = asset.sizeTier || 0;
    base.stageN = asset.stageN || 0;
  }
  const stationTarget = asset?.kind === 'station' || (dest.kind === 'station' && !asset);
  if (type === 'station' && (sub === 'found' || (!asset && dest.kind !== 'station'))) {
    return { ...base, kind: 'station', name: p.newAssetName || 'Nova estação', newAsset: true, sequence: 'release' };
  }
  if (['crewed', 'cargo', 'station'].includes(type) && stationTarget && !SURFACE_KINDS.includes(dest.kind)) {
    return { ...base, kind: 'station', name: asset?.name || dest.short || dest.name, newAsset: false, sequence: 'dock' };
  }
  if (type === 'cargo' && SURFACE_KINDS.includes(dest.kind) && (asset?.kind === 'base' || ['base_module', 'base_vehicle', 'supply'].includes(pk))) {
    return { ...base, kind: 'base', name: asset?.name || p.newAssetName || `Base em ${dest.name}`, newAsset: !asset, sequence: 'surface' };
  }
  return null;
}

/** {sequence, traits, inOrbit} of a flight's docking (risk.js docking milestones), or null. */
function dockingOf(state, data, d) {
  if (!d?.type || !['crewed', 'cargo', 'station'].includes(d.type)) return null;
  let t = null;
  try { t = sceneTarget(state, data, { ...d, sub: d.sub || resolveSub(state, data, d), payload: { ...(d.payload || {}), targetAssetId: resolvedTargetId(state, data, d, d.sub || resolveSub(state, data, d)) } }); } catch { t = null; }
  if (!t || !['dock', 'berth', 'release'].includes(t.sequence)) return null;
  return { sequence: t.sequence, traits: Array.isArray(t.traits) ? t.traits.slice(0, 8) : [] };
}

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

/** Weeks an arrival waits for its control-room scene before it is resolved without one. */
const ARRIVAL_SCENE_WAIT = 13;

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
      // the control room is offered while the arrival is fresh; one that waited a quarter behind other launches and
      // arrivals (one blocking scene at a time: 13- and 52-week steps launch faster than scenes can be watched) is
      // resolved off-screen, so arrivals never pile up in the save
      const waited = state.turn - (Number.isFinite(m.transit?.arriveTurn) ? m.transit.arriveTurn : state.turn);
      const pending = launchPending(state, m.id);
      if (hasArrivalScene(data, m) && (pending || waited < ARRIVAL_SCENE_WAIT)) {
        if (!pending && !anyLaunchBusy(state)) pushLaunchReady(state, data, m, 'arrival');
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

// --- Missões v2: results (§1.3) ---

/** Weeks of operations after success: crew rotations stay on the asset, subtypes may override the type's figure. */
function opsWeeksOf(state, data, m) {
  const sub = m.sub || null;
  const row = subtypeOf(data, m.type, sub);
  if (m.type === 'crewed' && sub === 'rotation' && (m.payload?.targetAssetId || infraBound())) {
    const a = assetOf(state, m.payload?.targetAssetId);
    const tbl = mtables(data).rotationWeeks;
    return Math.max(1, Math.round(row?.rotationWeeks ?? tbl?.[a?.kind] ?? ROTATION_WEEKS));
  }
  if (Number.isFinite(row?.opsWeeks)) return row.opsWeeks;
  // a rover lives on as an asset (infra.js pays its yearly science): a short commissioning period here
  if (m.crewed) return OPS_WEEKS.crewed;
  const t = typeRow(data, m.type);
  if (Number.isFinite(t?.opsWeeks)) return t.opsWeeks;
  return OPS_WEEKS[m.type] ?? 2;
}
/** One-shot science base of a result (type, or the subtype's onArrival). */
function scienceBaseOf(data, m) {
  const row = subtypeOf(data, m.type, m.sub);
  if (Number.isFinite(row?.science?.onArrival)) return row.science.onArrival;
  if (m.crewed) return SCIENCE_BASE.crewed;
  const t = typeRow(data, m.type);
  return Number.isFinite(t?.science) ? t.science : SCIENCE_BASE[m.type] ?? 5;
}
/** Milestones a successful flight of this type/subtype claims (missions.json firsts). */
function subtypeFirsts(data, m, dest) {
  const out = [];
  for (const r of mtables(data).firsts) {
    if (!r?.milestone || r.type !== m.type) continue;
    if (r.sub && r.sub !== m.sub) continue;
    if (r.body && r.body !== (dest?.body ?? 'earth')) continue;
    if (Array.isArray(r.dests) && !r.dests.includes(dest?.id)) continue;
    if (m.clientPayload) continue;
    out.push(r.milestone);
  }
  return [...new Set(out)];
}
/**
 * Hand the result to infra.js (§3): satellite fleets, rovers, station/base modules, supplies, crew rotations and
 * servicing. Records the asset on the mission. Without infra.js nothing changes (the v0.8 abstract flow).
 */
function deliverToInfra(state, data, m, level) {
  const f = peerFn('infra', 'deliver');
  if (!f || m.testDesignId || m.certVehicleId) return null;
  if (m.clientPayload) return null; // a client's satellite or cargo is the client's business
  let res = null;
  try { res = f(state, data, m, level); } catch (e) { log(state, `aviso: entrega à infraestrutura falhou (${e.message})`); res = null; }
  if (res?.assetId) {
    m.assetId = res.assetId;
    if (m.payload && typeof m.payload === 'object' && !m.payload.targetAssetId) m.payload.targetAssetId = res.assetId;
  }
  return res;
}

/**
 * Called by launch at the end of each scene (and by missions for arrivals without a scene).
 * outcome = { level, failureType, causes, headline?, crewLost? }
 */
export function onLaunchResolved(state, data, missionId, phase = 'ascent', outcome = {}) {
  syncDesignCatalog(state, data);
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
    if (m.certVehicleId) fn(calendar, 'certDemoResult')?.(state, data, m.certVehicleId, success, m.id);
    if (m.vehicleId && isDesignId(state, m.vehicleId)) designFlightResult(state, data, m, success);
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
    const opsWeeks = m.testDesignId ? 0 : opsWeeksOf(state, data, m); // ballast has no operations
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
      // Missões v2 subtype firsts (missions.json firsts: first weather satellite, first rover on Mars, ...)
      for (const id of subtypeFirsts(data, m, dest)) {
        if (ms.includes(id) || state.firsts?.[id]?.actorId === pid || (state.stats?.[`missions.reached.${id}`] || 0) > 0) continue;
        stat(state, `reached.${id}`);
        const firstPts = Math.round((20 + Math.round(base)) * share * milestoneShare(data, id));
        const wasFirst = claimFirst(state, id, pid, firstPts, Math.round(3 * share));
        prestige += wasFirst ? firstValue(state, id, firstPts) : Math.round(3 * share);
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
      const sci = scienceBaseOf(data, m) * (dest?.scienceMult ?? SCIENCE_BODY[dest?.body] ?? 1) * (1 + techBonus(state, 'sciencePerMission')) * (level === 'total' ? 1 : 0.5);
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
    // Missões v2 (§1.3): what the flight leaves behind — satellite fleet, rover, station/base module, cargo delivered
    if (success) deliverToInfra(state, data, m, level);
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
    missionId: m.id, calendarId: m.calendarId || null, actorId: pid, destination: m.destination, missionType: m.type, sub: m.sub || null,
    ...(m.assetId || m.payload?.targetAssetId ? { assetId: m.assetId || m.payload.targetAssetId } : {}), // NOT "type": emitSignal spreads payload over the signal type
    crewed: !!m.crewed, outcome: level, failureType, phase, final,
    ...(m.mandateId || m.holderId ? { mandateId: m.mandateId || null, holderId: m.holderId || null } : {}),
    ...(m.vehicleId && isDesignId(state, m.vehicleId) ? { designId: m.vehicleId, test: !!m.testDesignId } : {}),
  });
  // investors (B2): every final result of a player mission (mandates, programs of the anchor holder, own missions)
  if (final) tellInvestors(state, data, m, { level, success, phase, final, mandateId: m.mandateId || null, holderId: m.holderId || null, crewLost: deadIds.length });
  return { status: m.status, final, prestige, science, firsts, headlines: m.result.headlines };
}

// ---------------------------------------------------------------------------------------------
// Builder query (3 steps)
// ---------------------------------------------------------------------------------------------

/** What a module adds, for the builder cards: {science, crew, power, storageT, ports, life, isruTYr, housing}. */
function moduleAdds(m) {
  const out = {};
  for (const k of ['science', 'crew', 'power', 'storageT', 'ports', 'life', 'isruTYr', 'housing', 'food']) if (Number(m?.[k])) out[k] = Number(m[k]);
  return out;
}

/**
 * Missões v2 builder data (§11) for a normalized draft: resolved subtype, the subtype chips (locked/invalid ones
 * with a reason), payload kinds, station/base modules and surface vehicles (locked ones with the research link) and
 * the asset targets at the destination. Pure.
 */
function draftOptionsV2(state, data, d, gateOf) {
  const dest = destDef(data, d.destination);
  const sub = d.type ? resolveSub(state, data, d) : null;
  const sc = spacecraftDef(data, d.spacecraftId, state);
  const subs = d.type ? subtypesFor(data, d.type).filter((r) => !r.privileged || r.id === sub).map((r) => {
    const reasons = [];
    if (dest && !subDestOk(r, dest)) reasons.push(`Não serve para ${dest.name}.`);
    if (sc && !scOkForSub(data, sc, d.type, r.id)) reasons.push(`${sc.name} não é ${String(r.label).toLowerCase()}.`);
    return { id: r.id, label: r.label, key: r.key || null, histYear: r.histYear ?? null, selected: r.id === sub, derived: !d.sub && r.id === sub,
      valid: reasons.length === 0, reasons, locked: gateOf({ type: d.type, sub: r.id }) };
  }) : [];
  const pk = d.type ? payloadKindOf(data, d, sub) : null;
  const payloadKinds = d.type === 'cargo'
    ? subtypesFor(data, 'cargo').filter((r) => r.payload && r.payload !== 'client').map((r) => ({
      id: r.payload, sub: r.id, label: mtables(data).payloadKinds?.[r.payload]?.label || r.label, selected: r.payload === pk,
      valid: !dest || subDestOk(r, dest), locked: gateOf({ type: 'cargo', sub: r.id, payloadKind: r.payload }) }))
    : d.type === 'station' ? [{ id: 'station_module', sub, label: 'Módulo de estação', selected: true, valid: true, locked: null }] : [];
  const p = d.payload || normalizePayload(null);
  const modKind = pk === 'station_module' ? 'station' : pk === 'base_module' ? 'base' : null;
  const modules = modKind ? moduleRows(data, modKind).map((m) => ({
    id: m.id, label: moduleLabel(m), massT: m.massT ?? null, costM: m.costM ?? null, histYear: m.histYear ?? null, adds: moduleAdds(m), traits: m.traits || [],
    selected: m.id === p.moduleId, locked: gateOf({ type: d.type, sub, payloadKind: pk, moduleId: m.id }),
  })) : [];
  const surfaceVehicles = pk === 'base_vehicle' ? moduleRows(data, 'vehicles').map((v) => {
    const reasons = Array.isArray(v.bodies) && v.bodies.length && dest && !v.bodies.includes(dest.body) ? [`Não opera em ${dest.name}.`] : [];
    return { id: v.id, label: moduleLabel(v), massT: v.massT ?? null, costM: v.costM ?? null, science: v.science ?? 0, selected: v.id === p.vehicleTypeId,
      valid: reasons.length === 0, reasons, locked: gateOf({ type: 'cargo', sub, payloadKind: pk, vehicleTypeId: v.id }) };
  }) : [];
  const targetId = d.type ? resolvedTargetId(state, data, d, sub) : null;
  const need = d.type ? needsTargetKinds(data, d.type, sub) : null;
  const targets = d.type && d.destination ? targetsOf(state, data, d, sub).map((t) => ({ ...t, selected: t.assetId === targetId })) : [];
  const foundsKind = subtypeOf(data, d.type, sub)?.foundsAsset || (d.type === 'station' ? 'station' : null);
  const cargoT = d.type ? round1(cargoMassOf(state, data, d, pk)) : 0;
  return {
    sub, subs, payloadKinds, modules, surfaceVehicles, targets,
    payload: { ...p, kind: p.kind || pk || null, targetAssetId: targetId },
    targetAssetId: targetId, needsTarget: !!need,
    canFound: !!foundsKind && !need, foundsKind: foundsKind || null,
    cargoT, carried: CARRIED_KINDS.includes(pk) && !d.config?.payloadT,
    carrierCapT: sc ? cargoCapacityOf(data, sc) : null,
  };
}

/** Everything the 3-step builder needs for a partial draft. Pure; never throws on partial input. */
export function draftOptions(state, data, draftIn = {}) {
  syncDesignCatalog(state, data);
  const d = { ...normalizeDraft(draftIn), riskMod: 0 };
  const existing = draftIn.missionId ? missionById(state, draftIn.missionId) : null;
  if (Number.isFinite(existing?.createdTurn)) d.createdTurn = existing.createdTurn;
  // privileged links come from the mission itself, never from the UI draft
  if (existing) {
    d.mandateId = existing.mandateId || null; d.holderId = existing.holderId || null; d.testDesignId = existing.testDesignId || null;
    if (d.deadlineTurn == null && Number.isFinite(existing.deadlineTurn)) d.deadlineTurn = existing.deadlineTurn;
    if (existing.clientPayload) d.clientPayload = true;
    if (existing.contractId) { d.contractId = existing.contractId; d.source = existing.source; d.payload = normalizePayload(existing.payload); d.sub = existing.sub || d.sub; }
  }
  const pid = state.playerId;
  const cash = state.actors?.[pid]?.cash ?? 0;
  const gateOf = (spec) => {
    const mg = peerFn('gating', 'missionGate');
    if (!mg) return null;
    try { const g = mg(state, data, spec, pid); return g && g.ok === false ? { reason: g.reason || 'Pesquise a tecnologia necessária.', nodeId: g.nodeId || null } : null; } catch { return null; }
  };
  const types = TYPES.map((t) => ({ id: t, label: TYPE_LABELS[t], selected: t === d.type, locked: gateOf({ type: t }) }));
  // Missões v2 builder lists (§11): subtypes, payload kinds, modules, surface vehicles, targets — locked ones included
  const v2 = draftOptionsV2(state, data, d, gateOf);

  const destinations = destList(data).map((x) => {
    const w = windowFor(state, data, x.id, state.turn);
    return {
      id: x.id, name: x.name, body: x.body, kind: x.kind, transitWeeks: x.transitWeeks || 0, prestige: destPrestige(x),
      route: x.route || [], hasArrival: (x.arrivalMilestones || []).length > 0,
      valid: (d.type ? destOkForType(x, d.type) : true) && destOpenNow(state, x), open: destOpenNow(state, x),
      window: Number.isFinite(w.closeTurn) ? { openTurn: w.openTurn, closeTurn: w.closeTurn, open: inWindow(w, state.turn) } : null,
      firsts: x.firsts || {}, selected: x.id === d.destination,
    };
  });

  const payloadT = payloadOf(data, d, state);
  const vehicles = vehiclesFor(state, data).map((v) => {
    const rel = vehicleReliability(state, data, v.id);
    const cap = d.destination ? effectiveCapacity(state, data, v.id, d.destination, d.config.fuelMargin) : { raw: 0, eff: 0 };
    const reasons = [];
    if (d.destination && cap.raw <= 0) reasons.push('Não alcança o destino.');
    else if (d.destination && cap.eff < payloadT) reasons.push(`Capacidade ${String(cap.eff).replace('.', ',')} t < carga ${String(round1(payloadT)).replace('.', ',')} t.`);
    const rated = crewRatedV(state, data, v);
    if (d.crewed && !rated) reasons.push('Sem certificação para tripulação.');
    // why and how: capacity gap and the crew-certification path (UI explains both under the card)
    const capacityShortT = d.destination && cap.raw > 0 && cap.eff < payloadT ? round1(payloadT - cap.eff) : 0;
    const cs = d.crewed && !rated ? fn(calendar, 'certStatus')?.(state, data, v.id, pid) || null : null;
    // the cheapest fix the player can make right here: a thinner fuel margin that makes the payload fit
    let marginFit = null;
    if (capacityShortT > 0) {
      for (const mg of [0.2, 0.1, 0]) {
        if (mg >= d.config.fuelMargin) continue;
        const c2 = effectiveCapacity(state, data, v.id, d.destination, mg);
        if (c2.eff >= payloadT) { marginFit = { margin: mg, capacityT: c2.eff }; break; }
      }
    }
    return {
      id: v.id, name: v.name, operator: v.operator, operatorName: actorName(state, v.operator), costM: round1((v.costM || 0) * Math.max(0.3, 1 + techBonus(state, 'launchCost'))),
      capacityT: cap.raw, effectiveCapacityT: cap.eff, crewRated: rated, reusable: !!v.reusable, truthLayer: v.truthLayer,
      payloadT: round1(payloadT), capacityShortT, marginFit, crewCert: cs,
      reliability: { mean: rel.mean, low: rel.low, high: rel.high, flights: rel.flights ?? null, band: reliabilityBand(rel) },
      valid: reasons.length === 0 && (!!d.destination || true), reasons, selected: v.id === d.vehicleId,
      ...(v.playerDesign ? { design: true, designPhase: v.designPhase || 'operational', baseVehicleId: v.baseVehicleId || null } : {}),
    };
  }).sort((a, b) => (b.valid - a.valid) || (a.costM - b.costM));
  // the player's designs still in the hangar are listed (blocked) so the builder says when they can fly
  for (const { design: dz, def } of playerDesignVehicles(state)) {
    const ph = designPhase(dz);
    if (ph === 'operational' || vehicles.some((x) => x.id === def.id)) continue;
    const p = dz.program || {};
    const why = ph === 'testFlights'
      ? `Em voos de teste (${testsPassed(dz)} de ${p.needFlights || 1}): só voa com lastro até ser aprovado.`
      : ph === 'work' ? `Em desenvolvimento no Hangar${Number.isFinite(p.readyTurn) ? `: pronto em ${fmtT(state, p.readyTurn)}` : ''}.`
        : 'Projeto salvo no Hangar: falta desenvolver.';
    const cap = d.destination ? round1(capacityTo(data, def.id, d.destination)) : 0;
    vehicles.push({
      id: def.id, name: def.name, operator: def.operator, operatorName: actorName(state, def.operator), costM: round1(def.costM || 0),
      capacityT: cap, effectiveCapacityT: cap, crewRated: false, reusable: !!def.reusable, truthLayer: 'projeto',
      payloadT: round1(payloadT), capacityShortT: 0, marginFit: null, crewCert: null,
      reliability: { mean: def.estimatedReliability, low: clamp(def.estimatedReliability - 0.15, 0, 1), high: clamp(def.estimatedReliability + 0.05, 0, 1), flights: dz.stats?.flights ?? 0, band: 'experimental' },
      valid: false, reasons: [why], selected: def.id === d.vehicleId, design: true, designPhase: ph || 'draft', baseVehicleId: def.baseVehicleId,
    });
  }

  const spacecraft = spacecraftFor(state, data).map((s) => {
    const reasons = [];
    const calendarCraft = d.source === 'calendar' && s.id === d.spacecraftId;
    if (d.type && !calendarCraft && !scOkForType(s, d.type, d.crewed, data)) reasons.push(d.crewed ? 'Não leva tripulação.' : 'Tipo incompatível.');
    else if (d.type && !calendarCraft && v2.sub && !scOkForSub(data, s, d.type, v2.sub)) reasons.push(`Não é ${(subtypeOf(data, d.type, v2.sub)?.label || v2.sub).toLowerCase()}.`);
    const cargoCapT = cargoCapacityOf(data, s);
    if (v2.carried && v2.cargoT > cargoCapT + 1e-9) reasons.push(`Leva no máximo ${fmtTons(cargoCapT)} t de carga.`);
    const destX = destDef(data, d.destination);
    if (v2.carried && destX && SURFACE_KINDS.includes(destX.kind) && s.kind !== 'lander' && !(s.kind === 'cargo' && (s.destinations || []).includes(destX.id))) reasons.push('Carga na superfície precisa de um módulo de pouso de carga.');
    if (d.destination && !scOkForDest(s, d.destination)) reasons.push('Não serve para este destino.');
    if (d.vehicleId && Array.isArray(s.compatibleVehicles) && s.compatibleVehicles.length && !s.compatibleVehicles.includes(d.vehicleId)) {
      const names = s.compatibleVehicles.map((id) => vehicleDef(data, id)?.name || id);
      reasons.push(`Só voa no ${names.join(' ou ')}.`);
    }
    const rel = spacecraftReliability(state, data, s.id);
    return {
      id: s.id, name: s.name, operator: s.operator, kind: s.kind, crew: s.crew || 0, massT: s.massT ?? null, costM: s.costM || 0, sub: s.sub || null, cargoT: cargoCapT,
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
    // Missões v2 (§11)
    ...v2,
    sub: v2.sub, payload: v2.payload,
  };
}

// ---------------------------------------------------------------------------------------------
// Module interface
// ---------------------------------------------------------------------------------------------

/**
 * Legacy "Pouso" (§1.1, §10): missions and contracts still typed 'lander' (a v0.8 save the v4 migration did not see,
 * or a record made by old code) become probe/lander. Idempotent, same result as migrations/v4.js step 1.
 */
function normalizeLegacyTypes(state) {
  for (const list of [state.missions, state.contracts]) {
    for (const x of list || []) {
      const a = x && LEGACY_TYPES[x.type];
      if (!a) continue;
      x.type = a.type;
      if (!x.sub) x.sub = a.sub;
    }
  }
}

/**
 * A launch agreement ended (§8.1): the player's missions booked on a rocket the market no longer sells them go back
 * to planning without a rocket (launches ≤ 26 weeks away keep it), with the engineers' suggestion and one card each.
 */
function treatyEnded(state, data) {
  if (!(state.signals || []).some((s) => s?.type === 'treaty/broken' || s?.type === 'treaty/expired')) return;
  const access = peerFn('market', 'treatyAccess');
  if (!access) return;
  const pid = state.playerId;
  for (const m of state.missions || []) {
    if (!['planning', 'scheduled'].includes(m.status) || !m.vehicleId || m.testDesignId || m.certVehicleId) continue;
    const v = vehicleDef(data, m.vehicleId, state);
    if (!v) continue;
    const closed = (item) => {
      if (!item) return false;
      let r = null;
      try { r = access(state, data, pid, item); } catch { r = null; }
      return !!r && r.ok === false;
    };
    const lostV = closed(v);
    const sc = spacecraftDef(data, m.spacecraftId, state);
    const lostSc = closed(sc);
    if (!lostV && !lostSc) continue;
    if (m.status === 'scheduled' && Number.isFinite(m.launchTurn) && m.launchTurn - state.turn <= 26) continue;
    const cfg = pickConfig(state, data, { type: m.type, sub: m.sub || null, destination: m.destination, crewed: !!m.crewed });
    m.suggestion = { vehicleId: lostV ? cfg?.vehicleId || null : m.vehicleId, spacecraftId: lostSc ? cfg?.spacecraftId || null : m.spacecraftId || cfg?.spacecraftId || null, secondarySpacecraftId: m.secondarySpacecraftId || null, reason: SUGGEST_CHEAPEST };
    m.vehicleId = null;
    if (lostSc) m.spacecraftId = null;
    if (m.status === 'scheduled') { m.status = 'planning'; m.launchTurn = null; m.windowTurn = null; }
    state.decisions = state.decisions.filter((x) => !(x.kind === 'launch/ready' && x.payload?.missionId === m.id));
    const who = actorName(state, lostV ? v.operator : sc.operator);
    issueCard(state, `Acordo encerrado: ${m.name}`, `O acordo com ${who} acabou: escolha outro foguete para ${m.name}.`);
    stat(state, 'treatyReassigned');
  }
}

export function init(state, data) {
  state.missions = state.missions || [];
  normalizeLegacyTypes(state);
  syncDesignCatalog(state, data);
  state.contracts = state.contracts || [];
  state.stats = state.stats || {};
  // probes already flying on day one show up in the Missions tab before the first advance (calendar.init ran earlier)
  if (data && Array.isArray(state.calendar)) adoptTransitPrograms(state, data);
}

export function tick(state, data, ctx) {
  state.missions = state.missions || [];
  state.contracts = state.contracts || [];
  syncDesignCatalog(state, data);
  normalizeLegacyTypes(state);
  treatyEnded(state, data);
  retireOfferCards(state);
  contractDeadlines(state, data);
  closeTenders(state, data);
  rivalDeliveries(state, data);
  adoptTransitPrograms(state, data);
  launchTick(state, data);
  transitTick(state, data, ctx);
  calendarBriefings(state, data);
  certDemos(state, data);
  designTestFlights(state, data);
  strandedMissions(state, data);
  if (crossed(state, ctx, 13, 0)) obsoletePrograms(state, data);
  if (Number.isFinite(state.endTurn) && state.endTurn > 10 * 52 && crossed(state, ctx, 13, 7)) slimResults(state);
  opportunities(state, data, ctx);
  tenderBoard(state, data, ctx);
  // keep estimates fresh (research, crew and reliability change over time)
  if (crossed(state, ctx, 4, 0)) {
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

/**
 * Program missions (calendar) still in planning long after their date: the hardware they were built around retires
 * and the program is overtaken by history (a 1950–3000 campaign would otherwise keep Vostok 1 or Artemis II in
 * planning for centuries). Unpaid ones leave quietly after OBSOLETE_AFTER weeks past the program date.
 */
const OBSOLETE_AFTER = 5 * 52;
function obsoletePrograms(state, data) {
  for (const m of state.missions) {
    if (m.status !== 'planning' || m.source !== 'calendar' || m.paid) continue;
    const inst = (state.calendar || []).find((c) => c.id === m.calendarId);
    const due = Math.max(inst?.plannedTurn ?? -Infinity, inst?.currentTurn ?? -Infinity, m.createdTurn ?? -Infinity);
    if (!Number.isFinite(due) || state.turn - due < OBSOLETE_AFTER) continue;
    const res = cancelMission(state, data, m, { reason: 'obsolete', penalty: false });
    if (!res.ok) continue;
    issueCard(state, `${m.name}: programa superado`,
      'O programa ficou anos no planejamento e o hardware dele saiu de linha. A missão foi arquivada sem custo político.');
  }
}

// ---------------------------------------------------------------------------------------------
// Crew certification (human-rating): the player's side. Program state lives in calendar.js (state.crewCert);
// here: paying for it ('vehicle/certify') and the uncrewed demo flight, a normal mission (source 'cert',
// type cargo to LEO, client payload = the capsule mass simulator) flown on Launch Day. Its ascent decides the rating.
// ---------------------------------------------------------------------------------------------

function certDemos(state, data) {
  const pid = state.playerId;
  const progs = state.crewCert?.programs || {};
  // demo missions left over after the vehicle got rated some other way (calendar milestone): cancel at no cost
  for (const m of state.missions) {
    if (!m.certVehicleId || m.status !== 'planning') continue;
    if (crewRatedV(state, data, vehicleDef(data, m.certVehicleId))) {
      const res = cancelMission(state, data, m, { reason: 'obsolete', penalty: false });
      if (res.ok && m.paid) changeActor(state, pid, 'support', 2); // nobody blames you for a test that is no longer needed
    } else if (progs[m.certVehicleId]?.sponsor !== pid || progs[m.certVehicleId]?.demoMissionId !== m.id) {
      cancelMission(state, data, m, { reason: 'obsolete', penalty: false }); // program expired (demo never flown): drop the orphan
    }
  }
  for (const p of Object.values(progs)) {
    if (p.sponsor !== pid || p.phase !== 'demo' || p.paused) continue;
    if (Number.isFinite(p.demoTurn) && state.turn < p.demoTurn) continue;
    const cur = p.demoMissionId ? missionById(state, p.demoMissionId) : null;
    if (cur && ['planning', 'scheduled', 'launch', 'transit', 'arrival'].includes(cur.status)) continue;
    const v = vehicleDef(data, p.vehicleId);
    if (!v) continue;
    const rules = fn(calendar, 'certRules')?.(data) || {};
    const res = createMission(state, data, {
      name: `Demo de certificação: ${v.name}`.slice(0, 60), source: 'cert', type: 'cargo', destination: rules.demoDestination || 'leo',
      vehicleId: v.id, spacecraftId: null, clientPayload: true, crewed: false,
      config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: rules.demoPayloadT || 8 },
      crew: autoCrew(state, data, 0),
    });
    if (!res.ok) continue;
    res.mission.certVehicleId = v.id;
    res.mission.estimate = estimateOf(riskFor(state, data, res.mission));
    fn(calendar, 'linkCertDemo')?.(state, v.id, res.missionId);
    issueCard(state, `Certificação do ${v.name}: falta o voo de demonstração`,
      `Engenharia, voos e confiabilidade aprovados. Agende "${res.mission.name}" (sem tripulação) em Missões › Programa. Se ele chegar à órbita, o ${v.name} passa a levar gente. Sem o voo em ${rules.demoExpiryWeeks ?? 52} semanas, o programa é arquivado.`);
  }
}

/** Player starts (pays) or resumes the crew certification of a vehicle. */
function certifyVehicle(state, data, vehicleId) {
  const pid = state.playerId;
  const can = fn(calendar, 'canStartCert');
  const start = fn(calendar, 'startCertProgram');
  if (!can || !start) return { ok: false, error: 'Certificação indisponível.' };
  const chk = can(state, data, vehicleId, pid);
  if (!chk.ok) return { ok: false, error: chk.error };
  const v = vehicleDef(data, vehicleId);
  if (!chk.resume) {
    if (!canPay(state, chk.costM)) return { ok: false, error: `Caixa insuficiente: a certificação custa ${fmtMoney(chk.costM)}.` };
    if (!pay(state, chk.costM, `Certificação tripulada: ${v?.name || vehicleId}`)) return { ok: false, error: 'Pagamento recusado.' };
  }
  const res = start(state, data, vehicleId, pid);
  if (!res.ok) {
    if (!chk.resume) receive(state, pid, chk.costM, 'missions', 'Estorno: certificação');
    return { ok: false, error: res.error };
  }
  stat(state, 'certStarted');
  return { ok: true, vehicleId, costM: chk.resume ? 0 : chk.costM, weeks: chk.weeks, resumed: !!chk.resume };
}

const PRIVILEGED_DRAFT_KEYS = ['grantM', 'grantShare', 'milestone', 'calendarId', 'contractId', 'deadlineTurn', 'targetTurn', 'readyTurn', 'clientPayload', 'mandateId', 'holderId', 'testDesignId', 'mandate'];
/** A draft as the player may send it: no grants, no program/contract links, always a custom mission. */
export function publicDraft(draft) {
  const d = { ...(draft && typeof draft === 'object' ? draft : {}) };
  for (const k of PRIVILEGED_DRAFT_KEYS) delete d[k];
  d.source = 'custom';
  // Missões v2: client payloads are contract-only (§1.4)
  if (d.payload && typeof d.payload === 'object' && d.payload.kind === 'client') d.payload = { ...d.payload, kind: null };
  if (d.sub === 'client') d.sub = null;
  return d;
}

const getM = (state, action) => {
  const m = missionById(state, action.missionId);
  return m ? { m } : { err: { ok: false, error: 'Missão não encontrada.' } };
};

const actionsRaw = {
  // public entry point: privileged fields (grants, program/contract links, milestones) only come from briefings and contracts
  'mission/create': (state, data, action) => {
    const ag = agendaOf(state, data);
    if (ag?.enforced && ag.left <= 0) return { ok: false, error: agendaFullText(ag), agenda: ag };
    return createMission(state, data, publicDraft(action.draft));
  },
  // Phase B: open the mission of an investor mandate (B2's state.mandates) from the Missões screen
  'mission/fromMandate': (state, data, action) => missionFromMandate(state, data, action.mandateId),
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
  'vehicle/certify': (state, data, action) => certifyVehicle(state, data, action.vehicleId),
  // tela Contratos: sealed bid (price, rocket) on an open tender, withdraw it, open the mission of a won contract
  'contract/bid': (state, data, action) => placeBid(state, data, action.contractId, action.price, action.vehicleId || null),
  'contract/withdraw': (state, data, action) => withdrawBid(state, data, action.contractId),
  'contract/mission': (state, data, action) => missionForContract(state, data, action.contractId),
  'mission/estimate': (state, data, action) => {
    const d = { ...normalizeDraft(action.draft || {}), riskMod: 0 };
    const r = riskFor(state, data, d, action.draft?.launchTurn);
    return { ok: true, estimate: { p: r.p, low: r.low ?? r.p, high: r.high ?? r.p, factors: r.factors || [], warnings: r.warnings || [], errors: r.errors || [] } };
  },
};

const decisionHandlersRaw = {
  briefing: (state, data, dec, choiceId) => {
    if (dec.payload?.kind === 'calendar') return resolveCalendarBriefing(state, data, dec, choiceId);
    if (choiceId === 'accept' && dec.payload?.draft) {
      const ag = agendaOf(state, data);
      if (ag?.enforced && ag.left <= 0) return { ok: false, error: agendaFullText(ag), agenda: ag };
      const res = createMission(state, data, withoutHardware(dec.payload.draft, SUGGEST_CHEAPEST));
      return res.ok ? { ...res, openBuilder: res.missionId, step: 2 } : res;
    }
    if (choiceId === 'decline' && dec.payload?.kind === 'rival') changeActor(state, state.playerId, 'support', -2);
    return { ok: true };
  },
  'contract/offer': (state, data, dec, choiceId) => resolveContractOffer(state, data, dec, choiceId),
  'mission/issue': () => ({ ok: true }),
};

// every entry point publishes the player's designs into the catalog first (syncDesignCatalog is a no-op without designs)
const withCatalog = (table) => Object.fromEntries(Object.entries(table).map(([k, f]) => [k, (state, data, ...a) => { syncDesignCatalog(state, data); return f(state, data, ...a); }]));
export const actions = withCatalog(actionsRaw);
export const decisionHandlers = withCatalog(decisionHandlersRaw);

function decorate(state, data, m) {
  const dest = destDef(data, m.destination);
  return {
    ...m,
    statusLabel: STATUS_LABELS[m.status] || m.status,
    typeLabel: TYPE_LABELS[m.type] || m.type,
    subLabel: subtypeOf(data, m.type, m.sub)?.label || null,
    targetName: m.payload?.targetAssetId ? assetOf(state, m.payload.targetAssetId)?.name || null : null,
    moduleName: m.payload?.moduleId ? moduleLabel(moduleDef(data, m.payload.moduleId)) : null,
    destinationName: dest?.name || m.destination,
    vehicleName: m.vehicleName || (m.calendarId && data?.index?.calendar?.[m.calendarId]?.vehicleName) || vehicleDef(data, m.vehicleId)?.name || null,
    spacecraftName: spacecraftDef(data, m.spacecraftId)?.name || null,
    launchDate: m.launchTurn != null ? fmtT(state, m.launchTurn) : null,
    arriveDate: m.transit ? fmtT(state, m.transit.arriveTurn) : null,
    contract: m.contractId ? (state.contracts || []).find((c) => c.id === m.contractId) || null : null,
    needsHardware: ['planning', 'scheduled'].includes(m.status) && needsHardware(m),
    suggestionNames: m.suggestion ? { vehicle: vehicleDef(data, m.suggestion.vehicleId)?.name || null, spacecraft: spacecraftDef(data, m.suggestion.spacecraftId)?.name || null } : null,
    // Phase B: investor badge (holder, deadline, penalty) and builder designs
    holder: m.holderId || m.mandate ? holderView(state, m.holderId, m.mandate) : null,
    deadline: Number.isFinite(m.deadlineTurn) && (m.mandateId || m.holderId) ? fmtT(state, m.deadlineTurn) : null,
    late: Number.isFinite(m.deadlineTurn) && (m.mandateId || m.holderId) && ['planning', 'scheduled'].includes(m.status)
      && (state.turn > m.deadlineTurn || (m.launchTurn != null && m.launchTurn > m.deadlineTurn)),
    isDesign: !!m.vehicleId && isDesignId(state, m.vehicleId),
    testFlight: m.testDesignId ? (testFlightsView(state).find((x) => x.designId === m.testDesignId) || { designId: m.testDesignId }) : null,
  };
}

const STATUS_ORDER = { launch: 0, arrival: 1, scheduled: 2, transit: 3, operations: 4, planning: 5, done: 6, cancelled: 7 };

const queriesRaw = {
  // Phase B: own-mission slots under investors (null without a cap table), open mandates, test flights, suggestion
  'missions/agenda': (state, data) => agendaOf(state, data),
  'missions/mandates': (state, data) => mandatesView(state, data),
  'missions/testFlights': (state) => testFlightsView(state),
  'missions/suggest': (state, data, draft) => suggestFor(state, data, draft || {}),
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
  // item 9: the bill depends on the rocket the player picks: min/max over the valid hardware for this draft
  'missions/costRange': (state, data, draft) => costRange(state, data, draft || {}),
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
  // tela Contratos: the board, the live odds of a bid (price, rocket) and the feasibility check of a tender
  'contracts/board': (state, data) => boardView(state, data),
  'contracts/odds': (state, data, id, price, vehicleId) => {
    const c = (state.contracts || []).find((x) => x.id === id);
    return c ? tenderOdds(state, data, c, price, vehicleId || null) : null;
  },
  'contracts/feasibility': (state, data, id, vehicleId) => {
    const c = (state.contracts || []).find((x) => x.id === id);
    return c ? tenderFeasibility(state, data, c, vehicleId || null) : null;
  },
  'missions/contracts': (state) =>
    (state.contracts || []).slice().reverse().map((c) => {
      const closed = !['open', 'bidding'].includes(c.status);
      return {
        ...c,
        rivals: (c.rivals || []).map((r) => ({ actorId: r.actorId, name: actorName(state, r.actorId), price: closed ? r.price : null })),
        deadline: fmtT(state, c.deadlineTurn),
      };
    }),
};
export const queries = withCatalog(queriesRaw);

// ---------------------------------------------------------------------------------------------
// 1950–3000 contract (EXPANSION.md §1.3, §1.5, §5.2, §10)
// ---------------------------------------------------------------------------------------------

/** Launch day, transit and contract deadlines are checked week by week: the engine substeps this module. */
export const meta = { maxDt: 1 };

/**
 * Player appointments the engine must not step over (§1.3): booked launches and arrivals of player craft.
 * Turns strictly after now; the engine takes the nearest.
 */
export function appointments(state) {
  const out = [];
  for (const m of state.missions || []) {
    if (m.status === 'scheduled' && Number.isFinite(m.launchTurn) && m.launchTurn > state.turn) out.push(m.launchTurn);
    if (m.status === 'transit' && Number.isFinite(m.transit?.arriveTurn) && m.transit.arriveTurn > state.turn) out.push(m.transit.arriveTurn);
  }
  return out;
}

const ARCHIVE_AFTER = 5 * 52;

/**
 * Long campaigns: a result resolved more than a quarter ago keeps its first headline only and no cause list (both
 * were read on Launch Day; nothing in the sim reads them later). Runs in compact() and every quarter from tick(), so
 * a save never carries a year of full Launch Day reports.
 */
function slimResults(state, list = state.missions) {
  for (const m of list || []) {
    const r = m?.result;
    const end = r?.resolvedTurn ?? m?.createdTurn ?? state.turn;
    // any phase resolved a quarter ago (a probe in transit keeps its ascent result for years)
    if (!r || r.slim || !Number.isFinite(end) || state.turn - end <= 13) continue;
    if (Array.isArray(r.causes)) r.causes = [];
    if (Array.isArray(r.headlines)) r.headlines = r.headlines.slice(0, 1);
    r.slim = 1;
  }
}
/**
 * Caps: contracts keep ≤ 40 (resolved ones older than a year go first); missions done/cancelled more than 5 years
 * ago become a stub in state.missionsArchive (≤ 80 B each), stubs older than 50 years (8 in a long campaign) fold into
 * per-destination counts.
 */
export function compact(state) {
  const live = ['open', 'bidding', 'awarded', 'late'];
  // a rival's contract still to be flown (tender board) stays until its delivery date
  const alive = (c) => live.includes(c.status) || (c.status === 'closed' && c.ai && c.ai.done == null);
  // a 1950–3000 campaign keeps less history in full (the save budget is 400 KB): resolved missions older than a
  // year, beyond the 8 most recent, become stubs; contracts keep 12. The Corrida Lunar (5 years) is unchanged.
  const long = Number.isFinite(state.endTurn) && state.endTurn > 10 * 52;
  const cCap = long ? 12 : 40;
  if (Array.isArray(state.contracts) && state.contracts.length > cCap) {
    state.contracts = state.contracts.filter((c) => alive(c) || state.turn - (c.createdTurn ?? 0) < 52);
    if (state.contracts.length > cCap) {
      const keep = state.contracts.filter(alive);
      const old = state.contracts.filter((c) => !alive(c)).slice(-Math.max(0, cCap - keep.length));
      state.contracts = state.contracts.filter((c) => keep.includes(c) || old.includes(c));
    }
  }
  // resolved auctions of a long campaign keep who won, the bids and the price; the pitch text goes after half a year
  if (long) {
    for (const c of state.contracts || []) {
      if (alive(c) || state.turn - (c.createdTurn ?? state.turn) <= 26) continue;
      if (c.body) c.body = '';
      if (c.rivals?.length) c.rivals = c.rivals.map((r) => ({ actorId: r.actorId, price: r.price }));
    }
  }
  if (!Array.isArray(state.missions)) return;
  if (long) {
    // drafts nobody scheduled for 5 years (no launch date, no open mandate) are dropped: the hardware and the window
    // they were planned for are long gone, and a 1,000-year campaign would carry them forever
    const openMandates = new Set((state.mandates || []).filter((md) => (md.status ?? 'open') === 'open').map((md) => md.id));
    for (const m of state.missions) {
      if (m.status !== 'planning' || m.launchTurn != null || (m.mandateId && openMandates.has(m.mandateId))) continue;
      if (state.turn - (m.createdTurn ?? state.turn) > 5 * 52) { m.status = 'cancelled'; m.result = m.result || { outcome: null, resolvedTurn: state.turn, reason: 'stale' }; }
    }
  }
  const keep = [];
  const stubs = [];
  const linked = new Set((state.contracts || []).map((c) => c.missionId).filter(Boolean));
  const after = long ? 52 : ARCHIVE_AFTER;
  const endOf = (m) => m.result?.resolvedTurn ?? m.createdTurn ?? state.turn;
  const recent = long
    ? new Set(state.missions.filter((m) => ['done', 'cancelled'].includes(m.status)).sort((a, b) => endOf(b) - endOf(a)).slice(0, 8).map((m) => m.id))
    : null;
  for (const m of state.missions) {
    const end = endOf(m);
    const old = state.turn - end > ARCHIVE_AFTER || (long && state.turn - end > after && !recent.has(m.id));
    if (['done', 'cancelled'].includes(m.status) && old && !linked.has(m.id)) {
      stubs.push({ id: m.id, n: String(m.name || '').slice(0, 40), d: m.destination, o: m.result?.outcome ?? null, t: end });
    } else keep.push(m);
  }
  if (long) {
    // the engineers' suggestion only matters while the player picks the hardware
    for (const m of keep) if (m.suggestion && m.status !== 'planning' && m.vehicleId) delete m.suggestion;
    slimResults(state, keep);
  }
  if (!stubs.length) return;
  state.missions = keep;
  // the per-mission launch counters (launch.flown.<id>.<phase>) go with the archived mission
  if (state.stats) {
    const gone = new Set(stubs.map((x) => x.id));
    for (const k of Object.keys(state.stats)) {
      if (!k.startsWith('launch.flown.')) continue;
      const id = k.slice(13, k.lastIndexOf('.'));
      if (gone.has(id)) delete state.stats[k];
    }
  }
  const arc = state.missionsArchive || (state.missionsArchive = { stubs: [], byDest: {} });
  arc.stubs.push(...stubs);
  const foldAfter = (long ? 8 : 50) * 52;
  const old = arc.stubs.filter((s) => state.turn - s.t > foldAfter);
  if (old.length) {
    arc.stubs = arc.stubs.filter((s) => state.turn - s.t <= foldAfter);
    for (const s of old) {
      const b = arc.byDest[s.d || '?'] || (arc.byDest[s.d || '?'] = { flown: 0, ok: 0 });
      b.flown++;
      if (s.o === 'total' || s.o === 'partial') b.ok++;
    }
  }
}

/** A dead rival leaves the open tenders (its sealed bid goes with it) and the board's record. */
export function onActorGone(state, data, ctx, id) {
  for (const c of state.contracts || []) {
    if (!['open', 'bidding'].includes(c.status) || !Array.isArray(c.rivals)) continue;
    c.rivals = c.rivals.filter((r) => r.actorId !== id);
  }
  if (state.tenders?.record?.[id] && id !== state.playerId) delete state.tenders.record[id];
}

// ---------------------------------------------------------------------------------------------
// Phase B: investor mandates (B2, EXPANSION.md §5) — the player's side
// ---------------------------------------------------------------------------------------------

const BINDING_PCT = 50;
const PROGRAM_DEADLINE_GRACE = 13; // weeks after the program's date (+ its readiness slip) before the holder calls it late
const holdersOf = (state) => (Array.isArray(state?.cap?.holders) ? state.cap.holders : []);
const holderById = (state, id) => (id ? holdersOf(state).find((x) => x.id === id) || null : null);
const playerPctOf = (state) => (Number.isFinite(state?.cap?.playerPct) ? state.cap.playerPct : null);

/** True when the player holds less than 50%: the board's mandates are binding (no decline, no postpone). */
export function mandatesBinding(state) {
  const p = playerPctOf(state);
  return p != null && p < BINDING_PCT;
}

/**
 * The holder whose program list the calendar is (§5.2 "story missions become investor missions"): the government
 * for national agencies, the founders for companies, else the largest holder. null without a cap table.
 */
export function anchorHolder(state) {
  const hs = holdersOf(state).filter((x) => (x.pct || 0) > 0);
  if (!hs.length) return null;
  const kind = state.actors?.[state.playerId]?.kind === 'company' ? 'founders' : 'government';
  return hs.find((x) => x.kind === kind) || hs.find((x) => x.kind === 'government' || x.kind === 'founders')
    || hs.slice().sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
}

/** Small holder view for cards (the ≤ 200 B emblem spec included as is). */
function holderView(state, id, snap = null) {
  const x = holderById(state, id);
  if (!x && !snap) return null;
  return {
    id: id || snap?.holderId || null, name: x?.name || snap?.holderName || 'Investidor', kind: x?.kind || snap?.holderKind || null,
    pct: Number.isFinite(x?.pct) ? x.pct : null, mood: Number.isFinite(x?.mood) ? x.mood : null, emblem: x?.emblem || snap?.emblem || null,
  };
}

/**
 * Mission slots of the year (§5.2): K slots, M of them mandated, K − M (≥ 1) the player's own. `used` counts the
 * player's own custom missions created this year. null when the agency has no cap table (Corrida Lunar, AI).
 * Tunables: data.investors.agenda {slotsPerYear, exponent, minOwn} (or at the top level), or investors.agenda().
 */
export function agendaOf(state, data) {
  const playerPct = playerPctOf(state);
  if (playerPct == null) return null;
  const t = { ...(data?.investors || {}), ...(data?.investors?.agenda || {}) };
  let K = Math.max(2, Math.round(Number(t.slotsPerYear ?? t.K) || 6));
  const exp = Number.isFinite(t.exponent) ? t.exponent : 0.6;
  const minOwn = Math.max(1, Math.round(Number(t.minOwn) || 1));
  const s = 1 - clamp(playerPct, 10, 100) / 100;
  let M = Math.min(K - minOwn, Math.round(K * Math.pow(s, exp)));
  // investors.js (B2) owns the numbers when bound: K, M, own launches counted so far, autonomy
  let peerUsed = 0;
  let autonomous = playerPct >= BINDING_PCT;
  const peer = peerFn('investors', 'agenda');
  if (peer) {
    try {
      const r = peer(state, data);
      if (r && Number.isFinite(r.K)) K = Math.max(2, Math.round(r.K));
      if (r && Number.isFinite(r.M)) M = clamp(Math.round(r.M), 0, K - minOwn);
      if (r && Number.isFinite(r.ownUsed)) peerUsed = r.ownUsed;
      if (r && typeof r.autonomous === 'boolean') autonomous = r.autonomous;
    } catch { /* keep the formula */ }
  }
  const own = Math.max(minOwn, K - M);
  const year = yearAt(state);
  // own missions of the year: the player's own picks and the contracts won on the board (one per contract, a second
  // attempt after a failure is the same job), never the mandates (EXPANSION.md §5.2: mandates and contracts never clash)
  const ofYear = (m) => !m.mandateId && !m.holderId && Number.isFinite(m.createdTurn) && turnToDate(m.createdTurn, state.startYear).year === year && !(m.status === 'cancelled' && !m.paid);
  const mine = (state.missions || []).filter(ofYear);
  const created = mine.filter((m) => m.source === 'custom').length + new Set(mine.filter((m) => m.source === 'contract' && m.contractId).map((m) => m.contractId)).size;
  const used = Math.max(created, peerUsed);
  // with autonomy (≥ 50%) the board does not veto own missions (B2 'investors/canFlyOwn'): the agenda only informs
  return { K, M, own, used, left: Math.max(0, own - used), playerPct, binding: !autonomous, enforced: !autonomous, year };
}

export function agendaFullText(a) {
  return `Agenda tomada pelos investidores: as ${a.own} vaga${a.own === 1 ? '' : 's'} de missão própria de ${a.year} já foram usadas. Novas vagas em jan/${a.year + 1}.`;
}

/** A program briefing under a cap table: the anchor holder's mandate, with its deadline (real date + slip). */
function programMandate(state, inst, def) {
  const hold = anchorHolder(state);
  if (!hold) return null;
  const target = inst.currentTurn ?? inst.plannedTurn ?? state.turn;
  const deadlineTurn = target + programSlipWeeks(state, inst, def) + PROGRAM_DEADLINE_GRACE;
  return { holderId: hold.id, holderName: hold.name, holderKind: hold.kind || null, emblem: hold.emblem || null, deadlineTurn, kind: 'program', binding: mandatesBinding(state) };
}

/**
 * Phase B: a mandate closed without being flown (deadline missed, declined). Its missions still in planning and
 * never paid are closed with it (cancelled, no refund, no penalty, no callback: investors.js already settled the
 * mandate), so a long campaign does not pile up orphan drafts. Story items (calendarId) stay with the calendar.
 * Returns the number of missions closed.
 */
export function closeMandateMissions(state, mandateId) {
  let n = 0;
  for (const m of state.missions || []) {
    if (m.mandateId !== mandateId || m.status !== 'planning' || m.paid || m.attempts > 0 || m.calendarId) continue;
    m.status = 'cancelled';
    m.result = { outcome: null, failureType: null, causes: [], phase: null, launchedTurn: null, resolvedTurn: state.turn, prestige: 0, science: 0, headlines: [] };
    state.decisions = state.decisions.filter((x) => !(x.payload?.missionId === m.id && x.kind === 'launch/ready'));
    n++;
  }
  return n;
}

/**
 * Phase B (investors, EXPANSION.md §5.2): a mandate of a holder becomes a player mission in planning, without
 * hardware (item 9: the player picks it), with the mandate's deadline. Idempotent per mandate id (an open mission
 * of the same mandate is returned). A mandate tied to a calendar program (`calendarId`) adopts that program's
 * mission or is created as the program itself (type, destination and milestone locked).
 * mandate: { id, holderId, title, type, destination, count?, deadlineTurn, rewardM?, penalty?, crewed?, calendarId? }
 * → { ok, missionId, mission, openBuilder, step: 2 } | { ok: false, error }
 */
export function createMandateMission(state, data, mandate) {
  syncDesignCatalog(state, data);
  state.missions = state.missions || [];
  const mid = mandate?.id ?? null;
  const openOf = (pred) => state.missions.find((m) => pred(m) && !['done', 'cancelled'].includes(m.status)) || null;
  const already = mid ? openOf((m) => m.mandateId === mid) : null;
  if (already) return { ok: true, missionId: already.id, mission: already, existing: true };
  const hold = holderById(state, mandate?.holderId);
  const snap = {
    holderId: mandate?.holderId ?? null, holderName: hold?.name || mandate?.holderName || null, holderKind: hold?.kind || null,
    emblem: hold?.emblem || null, title: mandate?.title ? String(mandate.title).slice(0, 60) : null,
    deadlineTurn: Number.isFinite(mandate?.deadlineTurn) ? mandate.deadlineTurn : null,
    rewardM: Number.isFinite(mandate?.rewardM) ? mandate.rewardM : null, penalty: mandate?.penalty && typeof mandate.penalty === 'object' ? mandate.penalty : null,
    count: Number.isFinite(mandate?.count) ? mandate.count : 1, kind: mandate?.calendarId ? 'program' : 'mandate', binding: mandatesBinding(state),
  };
  const tag = (m) => {
    m.mandateId = mid; m.holderId = snap.holderId; m.mandate = snap;
    if (snap.deadlineTurn != null) m.deadlineTurn = snap.deadlineTurn;
  };
  // program mandate: the calendar item is the mission
  if (mandate?.calendarId) {
    const prog = openOf((m) => m.calendarId === mandate.calendarId);
    if (prog) { tag(prog); return { ok: true, missionId: prog.id, mission: prog, adopted: true }; }
    const inst = (state.calendar || []).find((c) => c.id === mandate.calendarId);
    const def = calDef(data, mandate.calendarId);
    if (inst && def && inst.status === 'player') {
      state.decisions = state.decisions.filter((x) => !(x.kind === 'briefing' && x.payload?.calendarId === inst.id));
      const d0 = calendarDraft(state, data, inst, def);
      const res = createMission(state, data, withoutHardware({ ...d0, readyTurn: programReadyTurn(state, data, inst, def) }, d0.suggestionReason || SUGGEST_PROGRAM));
      if (!res.ok) return res;
      inst.missionId = res.missionId;
      tag(res.mission);
      return { ...res, openBuilder: res.missionId, step: 2 };
    }
  }
  if (!mandate?.type || !mandate?.destination) return { ok: false, error: 'Mandato sem tipo ou destino.' };
  const mt = missionTypeOf(mandate.type, mandate.sub);
  if (!mt.type) return { ok: false, error: 'Tipo de missão inválido.' };
  if (!destDef(data, mandate.destination)) return { ok: false, error: 'Destino desconhecido.' };
  const crewed = mandate.crewed ?? mt.type === 'crewed';
  const cfg = pickConfig(state, data, { type: mt.type, sub: mt.sub, destination: mandate.destination, crewed });
  const sc = spacecraftDef(data, cfg?.spacecraftId);
  const done = mid ? state.missions.filter((m) => m.mandateId === mid && m.status !== 'cancelled').length : 0;
  const title = snap.title || null;
  const draft = {
    name: title ? `${title}${snap.count > 1 ? ` ${done + 1}/${snap.count}` : ''}`.slice(0, 60) : undefined,
    source: 'custom', type: mt.type, sub: mt.sub, destination: mandate.destination,
    vehicleId: cfg?.vehicleId || null, spacecraftId: cfg?.spacecraftId || null, crewed,
    crew: autoCrew(state, data, crewed ? sc?.crew || 0 : 0), config: { strategy: 'balanced', fuelMargin: 0.1 },
    deadlineTurn: snap.deadlineTurn, mandateId: mid, holderId: snap.holderId,
  };
  const res = createMission(state, data, withoutHardware(draft, SUGGEST_CHEAPEST));
  if (!res.ok) return res;
  tag(res.mission);
  return { ...res, openBuilder: res.missionId, step: 2 };
}

/** Player action: open the mission of an open mandate that has none yet (state.mandates belongs to investors.js). */
function missionFromMandate(state, data, mandateId) {
  const list = Array.isArray(state.mandates) ? state.mandates : [];
  const md = list.find((x) => x.id === mandateId);
  if (!md) return { ok: false, error: 'Mandato não encontrado.' };
  if (!['open', 'flying'].includes(md.status ?? 'open')) return { ok: false, error: 'Este mandato já foi encerrado.' };
  const delivered = (state.missions || []).filter((m) => m.mandateId === md.id && m.status === 'done' && ['total', 'partial'].includes(m.result?.outcome)).length;
  const open = (state.missions || []).some((m) => m.mandateId === md.id && !['done', 'cancelled'].includes(m.status));
  if (!open && delivered >= Math.max(1, md.count || 1)) return { ok: false, error: 'Mandato cumprido: o investidor confirma a entrega no próximo conselho.' };
  const res = createMandateMission(state, data, md);
  if (res.ok && !res.existing) {
    const link = peerFn('investors', 'linkMandateMission');
    if (link) link(state, data, md.id, res.missionId);
    else if (Array.isArray(md.missionIds) && !md.missionIds.includes(res.missionId)) md.missionIds.push(res.missionId);
  }
  return res;
}

/** Final result (or cancellation) of a player mission, told to investors.js (B2). One call per resolution. */
function tellInvestors(state, data, m, info) {
  if (!peers.investors) return;
  if (info.cancelled) {
    const c = peerFn('investors', 'onMissionCancelled');
    if (c) { c(state, data, m, info); return; }
  }
  peerFn('investors', 'onMissionResolved')?.(state, data, m, info);
}

/** Open mandates (investors.js slice) with their missions, for the Missões screen. */
function mandatesView(state, data) {
  const list = Array.isArray(state.mandates) ? state.mandates : [];
  return list.filter((md) => ['open', 'flying'].includes(md.status ?? 'open')).map((md) => {
    const ms = (state.missions || []).filter((m) => m.mandateId === md.id);
    const open = ms.find((m) => !['done', 'cancelled'].includes(m.status)) || null;
    const dest = destDef(data, md.destination);
    return {
      id: md.id, title: md.title || `${TYPE_LABELS[md.type] || 'Missão'} ${dest?.name || md.destination || ''}`.trim(), type: md.type || null,
      destination: md.destination || null, destinationName: dest?.name || md.destination || null, count: md.count || 1,
      delivered: ms.filter((m) => m.status === 'done' && ['total', 'partial'].includes(m.result?.outcome)).length,
      fulfilled: !open && ms.filter((m) => m.status === 'done' && ['total', 'partial'].includes(m.result?.outcome)).length >= Math.max(1, md.count || 1),
      deadlineTurn: Number.isFinite(md.deadlineTurn) ? md.deadlineTurn : null, deadline: Number.isFinite(md.deadlineTurn) ? fmtT(state, md.deadlineTurn) : null,
      late: Number.isFinite(md.deadlineTurn) && state.turn > md.deadlineTurn, rewardM: md.rewardM ?? null, penalty: md.penalty || null,
      holder: holderView(state, md.holderId, { holderName: md.holderName }), missionId: open?.id || null, missionStatus: open?.status || null,
      binding: mandatesBinding(state), status: md.status ?? 'open',
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Phase B: builder test flights (B3, EXPANSION.md §6) — missions source 'test', design locked, ballast payload
// ---------------------------------------------------------------------------------------------

const TEST_RETRY_WEEKS = 13; // a cancelled test flight is offered again after a quarter

function testDestination(state, data, def) {
  for (const id of ['leo', 'sso', 'gto']) {
    const dest = destDef(data, id);
    if (dest && destOpenNow(state, dest) && capacityTo(data, def.id, id) > 0) return id;
  }
  return null;
}

/** Designs in their test campaign get one test-flight mission at a time (the player schedules it). */
function designTestFlights(state, data) {
  for (const { design: dz, def } of playerDesignVehicles(state)) {
    if (designPhase(dz) !== 'testFlights') continue;
    const p = dz.program || {};
    const need = Math.max(1, p.needFlights || 1);
    if (testsPassed(dz) >= need) continue;
    if (p.nextTestTurn != null) continue; // designs.js booked an abstract test flight (Hangar): wait for it
    const mine = state.missions.filter((m) => m.testDesignId === dz.id || (m.source === 'test' && m.designId === dz.id));
    if (mine.some((m) => ['planning', 'scheduled', 'launch'].includes(m.status))) continue;
    const lastCancel = Math.max(-Infinity, ...mine.filter((m) => m.status === 'cancelled').map((m) => m.result?.resolvedTurn ?? -Infinity));
    if (state.turn - lastCancel < TEST_RETRY_WEEKS) continue;
    const dest = testDestination(state, data, def);
    if (!dest) continue;
    const capT = capacityTo(data, def.id, dest) * (1 + techBonus(state, 'payload')) * 0.9;
    const ballast = round1(clamp(capT * 0.5, 0.1, 60));
    const n = mine.filter((m) => m.status !== 'cancelled').length + 1;
    const res = createMission(state, data, {
      name: `Voo de teste ${n}: ${def.name}`.slice(0, 60), source: 'test', type: 'cargo', destination: dest,
      vehicleId: def.id, spacecraftId: null, clientPayload: true, crewed: false,
      config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: ballast }, crew: autoCrew(state, data, 0), testDesignId: dz.id,
    });
    if (!res.ok) continue;
    res.mission.estimate = estimateOf(riskFor(state, data, res.mission));
    peerFn('designs', 'linkTestFlight')?.(state, data, dz.id, res.missionId);
    issueCard(state, `${def.name}: voo de teste ${Math.min(n, need)} de ${need}`,
      `O projeto saiu do Hangar. Agende "${res.mission.name}" em Missões › Programa: o foguete leva ${String(ballast).replace('.', ',')} t de lastro até ${destDef(data, dest)?.name || dest}. Com ${need} voo${need === 1 ? '' : 's'} de teste bem-sucedido${need === 1 ? '' : 's'}, ele fica liberado para qualquer missão.`);
  }
}

/** A design flew (test or not): designs.js (B3) when bound, else the design's own counters (contract fields). */
function designFlightResult(state, data, m, success) {
  const dz = designList(state).find((x) => x.id === m.vehicleId);
  if (!dz) return;
  const isTest = m.testDesignId === dz.id;
  if (peers.designs) {
    if (isTest) peerFn('designs', 'onTestFlight')?.(state, data, dz.id, success, m.id);
    else peerFn('designs', 'onDesignFlight')?.(state, data, dz.id, success, m.id);
    return;
  }
  // designs.js present but not bound: it reads the 'mission/resolved' signal (source 'test') and the flight record
  if (managedByB3(dz)) return;
  dz.stats = dz.stats && typeof dz.stats === 'object' ? dz.stats : { flights: 0, failures: 0 };
  dz.stats.flights = (dz.stats.flights || 0) + 1;
  if (!success) dz.stats.failures = (dz.stats.failures || 0) + 1;
  const p = dz.program;
  if (!isTest || !p || designPhase(dz) !== 'testFlights') return;
  if (success) p.testFlights = (p.testFlights || 0) + 1;
  const need = Math.max(1, p.needFlights || 1);
  if ((p.testFlights || 0) >= need) {
    p.phase = 'operational';
    p.operationalTurn = state.turn;
    issueCard(state, `${dz.name || 'Projeto'} aprovado`, `Os voos de teste convenceram os engenheiros: o ${dz.name || 'foguete'} agora aparece na escolha de veículo de qualquer missão.`);
    addNews(state, { headline: `${actorName(state, state.playerId)} aprova o ${dz.name || 'novo foguete'} para voo operacional`, tags: ['mission', 'design'], actors: [state.playerId], importance: 2 });
  } else if (!success) {
    issueCard(state, `${dz.name || 'Projeto'}: voo de teste perdido`, 'A falha não conta para a aprovação. Outro voo de teste entra no programa.');
  }
}

/** Test flights of the player's designs (UI: Hangar and Missões). */
function testFlightsView(state) {
  return playerDesignVehicles(state).filter(({ design }) => designPhase(design) === 'testFlights').map(({ design: dz, def }) => {
    const m = (state.missions || []).find((x) => x.testDesignId === dz.id && !['done', 'cancelled'].includes(x.status)) || null;
    return { designId: dz.id, name: def.name, flights: testsPassed(dz), need: Math.max(1, dz.program?.needFlights || 1), missionId: m?.id || null, status: m?.status || null };
  });
}

/** Engineers' pick for a draft (shown, never preselected — EXPANSION.md §7.6). */
function suggestFor(state, data, draftIn = {}) {
  const d = normalizeDraft(draftIn);
  if (!d.type || !d.destination) return null;
  // Missões v2: the pick respects the subtype (an observatory needs an observatory craft) and the carried payload
  const sub = resolveSub(state, data, d);
  const pk = payloadKindOf(data, d, sub);
  const mod = d.payload?.moduleId ? moduleDef(data, d.payload.moduleId) : null;
  const noCraft = d.type === 'station' && !!mod;
  const cargoT = !noCraft && CARRIED_KINDS.includes(pk) ? cargoMassOf(state, data, d, pk) : 0;
  const cfg = pickConfig(state, data, { type: d.type, sub, destination: d.destination, crewed: d.crewed, noCraft, payloadOverride: noCraft ? mod.massT || 1 : null, cargoT, extraPayload: cargoT });
  if (!cfg) return null;
  return {
    vehicleId: cfg.vehicleId, spacecraftId: cfg.spacecraftId, reason: SUGGEST_CHEAPEST,
    vehicleName: vehicleDef(data, cfg.vehicleId)?.name || cfg.vehicleId, spacecraftName: spacecraftDef(data, cfg.spacecraftId)?.name || null,
    costM: round1(cfg.cost),
  };
}

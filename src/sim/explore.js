// Exploração e névoa de guerra do mapa espacial (EXPANSION.md §8). Slice `state.explored` = lista de ids (estrelas,
// planetas gerados, regiões da galáxia), só ids, em ordem de descoberta. Escrita apenas por `explore()`, que qualquer
// módulo do sim pode chamar (missões que chegam a uma estrela, eventos de era, colônias). Sem rng: tudo aqui é
// determinístico e puro, e o slice é JSON (save/load idêntico). Opcional: saves antigos sem o slice valem `[]`.
//
// Módulo no formato do engine ({meta, init, tick, queries, actions}); registrar em MODULES é opcional — sem ele, a UI
// deriva o mesmo conjunto a partir das missões (exploredIds) e `explore()` continua sendo a única escrita.
import { hash32 } from '../core/rng.js';

export const meta = { maxDt: 52 };

/** Cap: a campanha inteira cabe folgada (≈ 60 estrelas + regiões + nós de colonização). */
export const EXPLORED_CAP = 400;

const arr = (x) => (Array.isArray(x) ? x : []);
const isId = (x) => typeof x === 'string' && /^[a-z0-9_]+$/.test(x);

/** The explored list of a state (never null; tolerates saves without the slice). */
export function exploredList(state) {
  return Array.isArray(state?.explored) ? state.explored : [];
}

/** Has `id` been explored? */
export function isExplored(state, id) {
  return exploredList(state).includes(id);
}

/**
 * Mark ids as explored. Mutates `state.explored` (creating it), keeps first-discovery order, ignores duplicates and
 * malformed ids, never grows past EXPLORED_CAP. Returns the ids actually added (for news/signals by the caller).
 */
export function explore(state, ids) {
  if (!state) return [];
  const list = Array.isArray(state.explored) ? state.explored : (state.explored = []);
  const added = [];
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    if (!isId(id) || list.includes(id) || list.length >= EXPLORED_CAP) continue;
    list.push(id);
    added.push(id);
  }
  return added;
}

/** Destination → the star/region ids it reveals (`explores: [...]`, `star`, `region`). Pure. */
export function destinationReveals(dest) {
  if (!dest) return [];
  const out = [...arr(dest.explores)];
  if (isId(dest.star)) out.push(dest.star);
  if (isId(dest.region)) out.push(dest.region);
  return out.filter(isId);
}

const REACHED = new Set(['operations', 'done', 'arrival']);
const OK = new Set(['total', 'partial', 'success']);

/** Ids the player's own missions revealed (successful arrival at a destination that reveals something). Pure. */
export function revealedByMissions(state, data) {
  const out = [];
  const idx = data?.index?.destinations || {};
  const list = data?.destinations?.destinations;
  const byId = (id) => idx[id] || (Array.isArray(list) ? list.find((d) => d?.id === id) : null);
  for (const m of arr(state?.missions)) {
    if (!m?.destination || !REACHED.has(m.status)) continue;
    if (m.status === 'done' && m.result && m.result.outcome && !OK.has(m.result.outcome)) continue;
    for (const id of destinationReveals(byId(m.destination))) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Colonies/outposts in any shape Phase C may use (array, {list}, {items} or a map). Pure and tolerant. */
export function colonyList(state) {
  const c = state?.colonies;
  if (!c) return [];
  const raw = Array.isArray(c) ? c : Array.isArray(c.list) ? c.list : Array.isArray(c.items) ? c.items
    : Object.values(c.list && typeof c.list === 'object' ? c.list : c.items && typeof c.items === 'object' ? c.items : c);
  return raw.filter((x) => x && typeof x === 'object' && (x.id || x.name)).map((x) => ({
    id: String(x.id || x.name),
    name: x.name || x.id,
    kind: x.kind === 'outpost' || x.kind === 'station' || x.kind === 'base' ? x.kind : x.stage != null && x.stage < 2 ? 'outpost' : 'colony',
    bodyId: x.bodyId || x.body || x.at || null,
    starId: x.starId || x.star || null,
    regionId: x.regionId || x.region || null,
    galaxy: x.galaxy && Number.isFinite(x.galaxy.l) && Number.isFinite(x.galaxy.d) ? { l: x.galaxy.l, d: x.galaxy.d } : null,
    ownerId: x.ownerId || x.owner || x.actorId || null,
    stage: Number.isFinite(x.stage) ? x.stage : null,
    population: Number.isFinite(x.population) ? x.population : null,
  }));
}

/**
 * Everything the player knows as explored: the slice, plus what their missions reached, plus the stars/regions
 * that host a colony. Pure; works with or without the module registered.
 */
export function exploredIds(state, data) {
  const set = new Set(exploredList(state));
  for (const id of revealedByMissions(state, data)) set.add(id);
  for (const c of colonyList(state)) {
    if (c.starId) set.add(c.starId);
    if (c.regionId) set.add(c.regionId);
  }
  return set;
}

/** Fog state of a star: 'home' | 'colony' | 'surveyed' | 'observed'. Pure. */
export function starStatus(star, explored, colonies = []) {
  if (!star) return 'observed';
  if (star.home) return 'home';
  if (colonies.some((c) => c.starId === star.id)) return 'colony';
  if (explored.has(star.id) || (star.system && explored.has(star.system))) return 'surveyed';
  return 'observed';
}

const GEN_KINDS = ['rochoso', 'rochoso', 'super-Terra', 'netuniano', 'gigante gasoso', 'gigante gelado', 'mundo oceânico', 'anão gelado'];

/**
 * Worlds the survey of a star reveals beyond the real ones: 0–4, from hash32(starId) only (same in every game, so
 * the map never contradicts a save). Ids `<star>_g<n>`. Pure.
 */
export function generatedPlanets(star) {
  if (!star?.id || star.home) return [];
  const h = hash32('planets', star.id);
  const cls = String(star.spec || 'M')[0];
  const max = cls === 'D' || cls === 'Y' || cls === 'T' || cls === 'L' ? 2 : 4;
  const n = h % (max + 1);
  // letters already used by the real planets ("τ Ceti e, f, g, h") are skipped: the next free ones go to new worlds
  const used = new Set(arr(star.planets).map((p) => String(p.name || '').trim().slice(-1).toLowerCase()));
  let letter = 98; // 'b'
  const nextLetter = () => { while (used.has(String.fromCharCode(letter))) letter++; used.add(String.fromCharCode(letter)); return String.fromCharCode(letter); };
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = hash32('kind', star.id, i);
    out.push({
      id: `${star.id}_g${i + 1}`,
      name: `${star.short || star.name} ${nextLetter()}`,
      kind: GEN_KINDS[k % GEN_KINDS.length],
      hz: (k >>> 8) % 5 === 0,
      generated: true,
    });
  }
  return out;
}

/**
 * Planets of a star known at `year`: real ones from their announcement year on; generated ones only once the star
 * was surveyed (or hosts a colony). Pure.
 */
export function knownPlanets(star, year, status = 'observed') {
  const real = arr(star?.planets).filter((p) => !Number.isFinite(p.found) || p.found <= year);
  if (status === 'surveyed' || status === 'colony') return [...real, ...generatedPlanets(star)];
  return real;
}

/** Planets still hidden from the player at `year` (count only, for the "?" mark). Pure. */
export function hiddenPlanetCount(star, year, status = 'observed') {
  const futureReal = arr(star?.planets).filter((p) => Number.isFinite(p.found) && p.found > year).length;
  const gen = status === 'surveyed' || status === 'colony' ? 0 : generatedPlanets(star).length;
  return futureReal + gen;
}

// ------------------------------------------------------------------ module contract

export function init(state) {
  if (!Array.isArray(state.explored)) state.explored = [];
}

/** Copies what the player's missions reached into the slice (idempotent; no rng, no news). */
export function tick(state, data) {
  if (!Array.isArray(state.explored)) state.explored = [];
  const found = revealedByMissions(state, data);
  if (found.length) explore(state, found);
}

export const queries = {
  /** {explored: [...ids], colonies: [...]} — everything the space map's fog needs. */
  'explore/state': (state, data) => ({ explored: [...exploredIds(state, data)], colonies: colonyList(state) }),
};

export const actions = {};

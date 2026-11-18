// Data loader. All game content lives in /data/*.json (never hard-coded in sim code).
// Works in the browser (fetch) and Node (pass a reader). Pack layout and merge rules: docs/EXPANSION.md §4 and
// src/core/packs.js. A reader takes a name relative to data/ without ".json" ('vehicles', 'core/eras',
// 'eras/e1/era') and resolves to the parsed JSON.
//
// - `loadData(reader)` with no options = Corrida Lunar exactly as before (same legacy keys and values) plus the new
//   keys (core files, eraPacks, scenario normalization fields, packsLoaded).
// - Era packs are loaded lazily: the browser starts with core + legacy-e4 + the scenario's start era and asks for
//   more with `ensurePacks` (`packsNeeded(state, data)` says which); Node tools may pass `eras: 'all'`.
// - Missing optional files (core files, era files, snapshot…) are tolerated and listed in data.packWarnings; a missing
//   legacy file is fatal as before.

import { DEFAULT_MANIFEST, assemble, normalizeScenario, packHash, eraIds, eraOfYear, eraPacks } from './packs.js';

export { normalizeScenario } from './packs.js';

export const DATA_FILES = [
  'scenario',     // scenario config (start year, end year, playable actors) — core
  'actors',       // actors + initial relations + blocs — diplomacy module
  'vehicles',     // launch vehicle catalog — calendar/catalog module
  'spacecraft',   // spacecraft/capsules/landers catalog — calendar/catalog module
  'destinations', // targets + energy cost per route + windows — calendar/catalog module
  'calendar',     // real/planned missions 2026-2030 with truth layer + delay history — calendar module
  'politics',     // economy/government/tension templates + news templates — politics module
  'geopolitics',  // world map: actor countries, HQs, launch sites, disputed zones, geo model — politics module
  'tech',         // tech tree — research module
  'events',       // narrative + operation event cards and chains — narrative module
  'crew',         // name pools, traits, portrait parts, starting rosters — narrative module
  'bodies',       // map bodies (Earth, Moon, Mars...) for the map — map module
];

/** Default scenario when none is asked for. */
export const DEFAULT_SCENARIO = 'lunar_race';

// Loader memory lives on the data object but is not enumerable (not in JSON, not in deepEqual).
const STORE = Symbol.for('adastra.dataStore');
const storeOf = (data) => data?.[STORE] || null;

const stripJson = (f) => String(f).replace(/\.json$/, '');

async function tryRead(reader, name) {
  try { return await reader(name); } catch { return undefined; }
}

/** Read one pack's files. Legacy files are mandatory (errors propagate); everything else is optional. */
async function readPack(reader, pack) {
  const names = pack.files || [];
  const entries = await Promise.all(names.map(async (n) => {
    const path = `${pack.dir || ''}${n}`;
    const v = pack.legacy ? await reader(path) : await tryRead(reader, path);
    return [n, v];
  }));
  const files = {};
  const missing = [];
  for (const [n, v] of entries) {
    if (v === undefined) missing.push(`${pack.dir || ''}${n}.json`);
    else files[n] = v;
  }
  return { files, hash: packHash(files, names), missing };
}

/** Era ids a scenario needs at its start ('auto'): a fixed scenario lists its eras; a campaign starts in its first. */
export function startEras(scenario, manifest) {
  if (!scenario) return [];
  const known = new Set(eraIds(manifest));
  if (scenario.kind !== 'campaign') return (scenario.eras || []).filter((e) => known.has(e));
  const first = scenario.snapshot || eraOfYear(manifest, scenario.start?.year) || scenario.eras?.[0];
  return first && known.has(first) ? [first] : [];
}

function resolveEras(eras, scenario, manifest) {
  if (eras === 'all') return eraIds(manifest);
  if (Array.isArray(eras)) return eras.slice();
  return startEras(scenario, manifest);
}

function activeIds(manifest, eraSet) {
  return (manifest.packs || []).filter((p) => p.always || (p.era && eraSet.has(p.era))).map((p) => p.id);
}

/** Re-assemble `data` in place (the store keeps its reference) from the cached raw packs. */
function rebuild(data, st) {
  const active = activeIds(st.manifest, st.eras);
  const fresh = assemble(st.manifest, st.raw, active, {
    scenario: st.scenarioRaw, scenarioId: st.scenarioId, scenarioIndex: st.scenarioIndex,
  });
  fresh.packWarnings = [...st.missing, ...fresh.packWarnings];
  for (const k of Object.keys(data)) delete data[k];
  Object.assign(data, fresh);
  return data;
}

async function loadPacks(st, reader, ids) {
  const todo = (st.manifest.packs || []).filter((p) => ids.includes(p.id) && !st.raw[p.id]);
  const loaded = await Promise.all(todo.map((p) => readPack(reader, p)));
  todo.forEach((p, i) => {
    st.raw[p.id] = { files: loaded[i].files, hash: loaded[i].hash };
    for (const m of loaded[i].missing) if (!st.missing.includes(`arquivo ausente: ${m}`)) st.missing.push(`arquivo ausente: ${m}`);
  });
}

/**
 * @param {(name:string)=>Promise<any>} readJson  reads data/<name>.json
 * @param {{scenarioId?:string, eras?:'auto'|'all'|string[]}} [opts]
 * @returns {Promise<Record<string, any>>} data object keyed by file name (+ index, core files, scenario…)
 */
export async function loadData(readJson, { scenarioId = DEFAULT_SCENARIO, eras = 'auto' } = {}) {
  const [manifestRaw, scenarioIndex] = await Promise.all([tryRead(readJson, 'packs'), tryRead(readJson, 'scenarios/index')]);
  const manifest = manifestRaw && Array.isArray(manifestRaw.packs) ? manifestRaw : DEFAULT_MANIFEST;
  const file = manifest.scenarios?.[scenarioId] ?? (scenarioId === DEFAULT_SCENARIO ? 'scenario.json' : null);
  if (!file) throw new Error(`Cenário desconhecido: ${scenarioId}`);
  const scenarioRaw = await readJson(stripJson(file));
  const scenario = normalizeScenario(scenarioRaw, scenarioId);
  const st = {
    manifest, raw: {}, missing: [], scenarioRaw, scenarioId, scenarioIndex: scenarioIndex ?? null,
    eras: new Set(resolveEras(eras, scenario, manifest)),
  };
  await loadPacks(st, readJson, activeIds(manifest, st.eras));
  const data = {};
  Object.defineProperty(data, STORE, { value: st, enumerable: false, configurable: true });
  return rebuild(data, st);
}

/**
 * Make sure the packs of `eraIds` are merged into `data` (loading what is missing with `reader`). The result only
 * depends on the set of active packs, never on the order they were loaded in. `{prune: true}` also drops era packs
 * not in the list (keeps ≤ 3 era packs in memory on phones).
 * @returns {Promise<object>} the same data object
 */
export async function ensurePacks(data, reader, eraIdsWanted, { prune = false } = {}) {
  const st = storeOf(data);
  if (!st) return data; // data not built by loadData (tests with hand-made data): nothing to do
  const known = new Set(eraIds(st.manifest));
  const wanted = (eraIdsWanted || []).filter((e) => known.has(e));
  const next = new Set(prune ? wanted : [...st.eras, ...wanted]);
  const same = next.size === st.eras.size && [...next].every((e) => st.eras.has(e));
  await loadPacks(st, reader, activeIds(st.manifest, next));
  if (same) return data;
  st.eras = next;
  if (prune) for (const p of eraPacks(st.manifest)) if (!next.has(p.era)) delete st.raw[p.id];
  return rebuild(data, st);
}

/** Switch the scenario of an already loaded data object (new game from the title screen). */
export async function ensureScenario(data, reader, scenarioId, { eras = 'auto' } = {}) {
  const st = storeOf(data);
  if (!st) throw new Error('dados sem carregador: use loadData');
  if (st.scenarioId === scenarioId && eras === 'auto') return data;
  const file = st.manifest.scenarios?.[scenarioId];
  if (!file) throw new Error(`Cenário desconhecido: ${scenarioId}`);
  st.scenarioRaw = await reader(stripJson(file));
  st.scenarioId = scenarioId;
  const scenario = normalizeScenario(st.scenarioRaw, scenarioId);
  st.eras = new Set(resolveEras(eras, scenario, st.manifest));
  await loadPacks(st, reader, activeIds(st.manifest, st.eras));
  for (const p of eraPacks(st.manifest)) if (!st.eras.has(p.era)) delete st.raw[p.id];
  return rebuild(data, st);
}

/**
 * Era packs a running game needs now: the current era, the previous one (news/annals) and the next one once the
 * game is past 85% of the current era. Restricted to the scenario's eras.
 */
export function packsNeeded(state, data) {
  const manifest = storeOf(data)?.manifest || DEFAULT_MANIFEST;
  const list = eraPacks(manifest);
  const allowed = new Set(data?.scenario?.eras || list.map((p) => p.era));
  const year = (state?.startYear ?? data?.scenario?.startYear ?? 2026) + Math.floor((state?.turn ?? 0) / 52);
  const cur = state?.clock?.eraId || eraOfYear(manifest, year);
  const i = list.findIndex((p) => p.era === cur);
  if (i < 0) return [];
  const out = [];
  if (i > 0) out.push(list[i - 1].era);
  out.push(cur);
  const [from, to] = list[i].years || [year, year];
  const progress = to > from ? (year - from) / (to - from + 1) : 1;
  if (progress >= 0.85 && list[i + 1]) out.push(list[i + 1].era);
  return out.filter((e) => allowed.has(e));
}

/** Era packs currently merged into data (ids like 'e1'). */
export const erasLoaded = (data) => [...(storeOf(data)?.eras || [])];

/** Manifest the data was built from. */
export const manifestOf = (data) => storeOf(data)?.manifest || DEFAULT_MANIFEST;

/**
 * Scenarios for the title screen: data/scenarios/index.json plus the Corrida Lunar, each with its normalized
 * header fields. `loaded` marks the scenario `data` currently holds.
 */
export function listScenarios(data) {
  const list = (data?.scenarioIndex?.scenarios || []).map((s) => ({ ...s }));
  if (!list.some((s) => s.id === DEFAULT_SCENARIO)) {
    const raw = data?.scenario?.id === DEFAULT_SCENARIO ? data.scenario : null;
    list.push({ id: DEFAULT_SCENARIO, kind: 'scenario', name: raw?.name || 'Corrida Lunar', subtitle: raw?.subtitle || '2026 a 2030' });
  }
  const cur = data?.scenario?.id;
  return list
    .map((s) => ({ ...s, loaded: s.id === cur }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** Browser reader: fetches relative to the page. */
export function browserReader(base = './data/') {
  return async (name) => {
    const res = await fetch(`${base}${name}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Falha ao carregar ${name}.json (${res.status})`);
    return res.json();
  };
}

/** Node reader (import only in Node scripts/tests). */
export async function nodeReader(rootDir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  return async (name) => JSON.parse(await fs.readFile(path.join(rootDir, 'data', `${name}.json`), 'utf8'));
}

/**
 * Convenience for tests/tools: load data from the repo root in Node. With no options it is the Corrida Lunar
 * exactly as before; `{scenarioId: 'campaign'}` loads every era pack unless `eras` says otherwise.
 */
export async function loadDataNode(rootDir, opts = {}) {
  const scenarioId = opts.scenarioId ?? DEFAULT_SCENARIO;
  const eras = opts.eras ?? (scenarioId === DEFAULT_SCENARIO ? 'auto' : 'all');
  return loadData(await nodeReader(rootDir), { scenarioId, eras });
}

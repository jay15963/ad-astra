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
async function readPack(reader, pack, only = null) {
  const names = (pack.files || []).filter((n) => !only || only.includes(n));
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

/**
 * Files of an era pack that stay merged after the game has left that era (catalog continuity, §4.2 determinism):
 * places, hardware, parts, tech, lineages and the lifecycle rows (plus the pack's patches) are referenced for
 * centuries (GEO, a Soyuz, an agency born in 2087), while calendar, events, crew and snapshot are dated content.
 */
export const CATALOG_FILES = ['lineages', 'lifecycle', 'parts', 'craft-parts', 'vehicles', 'spacecraft', 'destinations', 'bodies', 'tech', 'investors', 'patches'];

/** Era packs before the latest loaded era that are not loaded in full: merged with their catalog files only. */
function catalogIds(manifest, eraSet) {
  const list = eraPacks(manifest);
  const last = Math.max(-1, ...list.map((p, i) => (eraSet.has(p.era) ? i : -1)));
  return list.filter((p, i) => i < last && !eraSet.has(p.era)).map((p) => p.id);
}

/**
 * Packs merged for a set of eras. Tech packs (`kind: "tech"`) are merged whatever the eras: unlock keys and their
 * years must be known from the start (a key no loaded node grants would be held by everyone, and the result would
 * depend on which era packs happen to be loaded; the whole tree is ~160 KB).
 */
function activeIds(manifest, eraSet) {
  return (manifest.packs || []).filter((p) => p.always || p.kind === 'tech' || (p.era && eraSet.has(p.era)) || (!p.era && Array.isArray(p.eras) && p.eras.some((e) => eraSet.has(e)))).map((p) => p.id);
}

/** Re-assemble `data` in place (the store keeps its reference) from the cached raw packs. */
function rebuild(data, st) {
  const active = [...activeIds(st.manifest, st.eras), ...catalogIds(st.manifest, st.eras)];
  const fresh = assemble(st.manifest, st.raw, active, {
    scenario: st.scenarioRaw, scenarioId: st.scenarioId, scenarioIndex: st.scenarioIndex,
  });
  fresh.packWarnings = [...st.missing, ...fresh.packWarnings];
  for (const k of Object.keys(data)) delete data[k];
  Object.assign(data, fresh);
  return data;
}

async function loadPacks(st, reader, ids) {
  st.partial ||= new Set();
  const catalog = new Set(catalogIds(st.manifest, st.eras));
  for (const id of catalog) if (!ids.includes(id)) ids = [...ids, id];
  // a pack held as catalog only is read again in full when the game needs all of it
  const todo = (st.manifest.packs || []).filter((p) => ids.includes(p.id) && (!st.raw[p.id] || (st.partial.has(p.id) && !catalog.has(p.id))));
  const loaded = await Promise.all(todo.map((p) => readPack(reader, p, catalog.has(p.id) ? CATALOG_FILES : null)));
  todo.forEach((p, i) => {
    if (catalog.has(p.id)) st.partial.add(p.id); else st.partial.delete(p.id);
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
  if (same) { await loadPacks(st, reader, activeIds(st.manifest, next)); return data; }
  st.eras = next;
  if (prune) {
    // packs left behind keep only their catalog files (CATALOG_FILES); later eras are dropped
    const catalog = new Set(catalogIds(st.manifest, next));
    for (const p of eraPacks(st.manifest)) {
      if (next.has(p.era) || !st.raw[p.id]) continue;
      if (!catalog.has(p.id)) { delete st.raw[p.id]; st.partial?.delete(p.id); continue; }
      if (!st.partial?.has(p.id)) {
        const files = Object.fromEntries(Object.entries(st.raw[p.id].files).filter(([n]) => CATALOG_FILES.includes(n)));
        st.raw[p.id] = { files, hash: packHash(files, (p.files || []).filter((n) => CATALOG_FILES.includes(n))) };
        (st.partial ||= new Set()).add(p.id);
      }
    }
  }
  await loadPacks(st, reader, activeIds(st.manifest, next));
  return rebuild(data, st);
}

/**
 * Feats history already saw before `year` (state.firstsHistory of a campaign that starts later): the union of the
 * scenarios' historicalFirsts dated before it, the earliest of each id. Pure.
 */
export function firstsBefore(scenarios, year) {
  const out = {};
  for (const sc of scenarios || []) {
    for (const [id, f] of Object.entries(sc?.historicalFirsts || {})) {
      if (!f || !Number.isFinite(f.year) || f.year >= year) continue;
      if (!out[id] || f.year < out[id].year) out[id] = JSON.parse(JSON.stringify(f));
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/**
 * The raw scenario moved to start at January of `year` (founding wizard "Quando começar"; EXPANSION.md §2.1): same
 * id, end and ending; the snapshot of the era of that year; `firsts` as historicalFirsts. Pure; the start year of
 * `raw` itself (or no year) returns `raw` unchanged.
 */
export function scenarioStartingAt(raw, year, manifest = DEFAULT_MANIFEST, firsts = null) {
  const y0 = raw?.start?.year ?? raw?.startYear;
  if (!raw || !Number.isFinite(year) || year === y0) return raw;
  const era = eraOfYear(manifest, year);
  const end = raw.end?.year ?? raw.endYear;
  return {
    ...raw, start: { year, month: 0 }, startYear: year, ...(era ? { snapshot: era } : {}),
    ...(end ? { subtitle: `${year} a ${end}` } : {}),
    historicalFirsts: firsts && Object.keys(firsts).length ? firsts : (raw.historicalFirsts ?? null),
  };
}

/**
 * Move the loaded scenario's start to `year` (null = its own start), reloading the era packs of the new start (the
 * packs of other eras are dropped: no 1950 content in 2200). Used by the founding wizard before the game is created
 * and by loadSlot for a save that started later. Resolves to the same data object.
 */
export async function ensureStartYear(data, reader, year = null, { eras = 'auto' } = {}) {
  const st = storeOf(data);
  if (!st) return data; // hand-made data (tests): nothing to move
  st.baseScenarioRaw ||= st.scenarioRaw;
  const base = st.baseScenarioRaw;
  const y0 = base?.start?.year ?? base?.startYear;
  let next = base;
  if (Number.isFinite(year) && year !== y0) {
    st.firstsCache ||= {};
    if (!st.firstsCache[year]) {
      const files = Object.entries(st.manifest.scenarios || {}).filter(([id]) => id !== st.scenarioId).map(([, f]) => f);
      const raws = await Promise.all(files.map((f) => tryRead(reader, stripJson(f))));
      st.firstsCache[year] = firstsBefore(raws.filter(Boolean), year);
    }
    next = scenarioStartingAt(base, year, st.manifest, st.firstsCache[year]);
  }
  if (next === st.scenarioRaw) return data;
  st.scenarioRaw = next;
  const scenario = normalizeScenario(next, st.scenarioId);
  st.eras = new Set(resolveEras(eras, scenario, st.manifest));
  for (const p of eraPacks(st.manifest)) if (!st.eras.has(p.era)) { delete st.raw[p.id]; st.partial?.delete(p.id); }
  await loadPacks(st, reader, activeIds(st.manifest, st.eras));
  return rebuild(data, st);
}

/** Start year of the scenario as its file has it (before any ensureStartYear). */
export const baseStartYear = (data) => {
  const raw = storeOf(data)?.baseScenarioRaw || storeOf(data)?.scenarioRaw || data?.scenario;
  return raw?.start?.year ?? raw?.startYear ?? null;
};

/** Switch the scenario of an already loaded data object (new game from the title screen). */
export async function ensureScenario(data, reader, scenarioId, { eras = 'auto' } = {}) {
  const st = storeOf(data);
  if (!st) throw new Error('dados sem carregador: use loadData');
  if (st.scenarioId === scenarioId && eras === 'auto') return data;
  const file = st.manifest.scenarios?.[scenarioId];
  if (!file) throw new Error(`Cenário desconhecido: ${scenarioId}`);
  st.scenarioRaw = await reader(stripJson(file));
  st.baseScenarioRaw = null;
  st.firstsCache = null;
  st.scenarioId = scenarioId;
  const scenario = normalizeScenario(st.scenarioRaw, scenarioId);
  st.eras = new Set(resolveEras(eras, scenario, st.manifest));
  for (const p of eraPacks(st.manifest)) if (!st.eras.has(p.era)) { delete st.raw[p.id]; st.partial?.delete(p.id); }
  await loadPacks(st, reader, activeIds(st.manifest, st.eras));
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

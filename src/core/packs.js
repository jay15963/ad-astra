// Data packs: pure merge of the files in data/packs.json into the single `data` object the sim reads.
// No I/O here (src/core/data.js reads the files). Contract: docs/EXPANSION.md §4.1–4.2.
//
// - Output keeps today's shape (data.vehicles.vehicles, data.calendar.missions, data.index…) plus the core files
//   (data.eras, data.lineages, data.lifecycle, data.nations, data.actorGen, data.ending), the per-era meta
//   (data.eraPacks[eraId] = eras/<eraId>/era.json, data.snapshots[eraId]), data.scenario (normalized),
//   data.scenarioIndex and data.packsLoaded {packId: hash}.
// - Lists whose items all have `id` merge by id in manifest order (a repeated id outside patches.json is a validator
//   error; the loader keeps the later one and notes it in data.packWarnings). Other lists concatenate; plain objects
//   merge deep; scalars: the later pack wins.
// - patches.json: `{ "<file>": [ { "$op": "patch"|"replace"|"remove", "id": "...", ...fields } ] }`, applied right
//   after its own pack's files.
// - Stamping (era packs only, never the legacy files): each listed entity gets `era` (if absent; tech nodes use the
//   number, everything else the era id) and `fromYear = era.from` when it has no absolute date.
// - Never mutates the raw JSON it is given (copy on write), so packs can be re-assembled in any order of loading and
//   the result only depends on the manifest order and the set of active packs.
// - Tech packs (MISSIONS-V2 §4.3): `{"id": "tech-e3", "kind": "tech", "techEra": "e3", "eras": ["e3", …, "e7"],
//   "dir": "tech/e3/", "files": ["tech"]}`. Always merged, whatever eras are loaded (src/core/data.js activeIds:
//   prerequisites, unlock keys and their years must not depend on the loaded eras); each tech file's `templates`
//   are expanded by src/core/techgen.js right before the file is merged (generated nodes are content like the
//   authored ones).
// - `exclude: [scenarioId, …]` (any pack): the pack is not merged for those scenarios (the Corrida Lunar keeps
//   exactly its tree).

import { genEvents } from '../gen/events.js';
import { prepareTechFile } from './techgen.js';

const GEN_EVENTS_SEED = 3000;

/** Legacy manifest (no data/packs.json): exactly today's files. */
export const LEGACY_FILES = ['actors', 'vehicles', 'spacecraft', 'destinations', 'calendar', 'politics', 'geopolitics',
  'tech', 'events', 'crew', 'bodies'];

export const DEFAULT_MANIFEST = Object.freeze({
  version: 1,
  packs: [{ id: 'legacy-e4', era: 'e4', always: true, legacy: true, dir: '', files: LEGACY_FILES }],
  scenarios: { lunar_race: 'scenario.json' },
});

/** file name -> key of its id list (what buildIndex, stamping and patches act on). */
export const LIST_KEYS = {
  actors: 'actors', vehicles: 'vehicles', spacecraft: 'spacecraft', destinations: 'destinations',
  calendar: 'missions', tech: 'nodes', events: 'events', bodies: 'bodies',
  lineages: 'lineages', lifecycle: 'events', nations: 'nations', investors: 'investors', parts: 'parts',
  'craft-parts': 'parts', // Estaleiro (src/sim/craftdesigns.js): era packs may add craft parts by id
};

/** data.index key -> [data key, list key]. The first eight are today's index (unchanged). */
const INDEX_LISTS = {
  actors: ['actors', 'actors'], vehicles: ['vehicles', 'vehicles'], spacecraft: ['spacecraft', 'spacecraft'],
  destinations: ['destinations', 'destinations'], calendar: ['calendar', 'missions'], tech: ['tech', 'nodes'],
  events: ['events', 'events'], bodies: ['bodies', 'bodies'],
};
const INDEX_EXTRA = { lineages: ['lineages', 'lineages'], nations: ['nations', 'nations'] };

/** Kinds whose entities are stamped with era/fromYear when they come from an era pack. */
const STAMP_KINDS = new Set(['vehicles', 'spacecraft', 'destinations', 'calendar', 'tech', 'events', 'investors', 'parts', 'craft-parts']);

/** core file name -> data key ('actor-gen' -> actorGen). */
export const dataKey = (file) => file.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasIds = (list) => list.length > 0 && list.every((x) => isObj(x) && typeof x.id === 'string');

/**
 * Pure deep merge: returns a new value, never mutates `a` or `b` (untouched branches are shared).
 * @param {(msg:string)=>void} [warn]
 */
export function mergeValue(a, b, warn, path = '') {
  if (b === undefined) return a;
  if (Array.isArray(a) && Array.isArray(b)) return mergeList(a, b, warn, path);
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? mergeValue(a[k], v, warn, path ? `${path}.${k}` : k) : v;
    return out;
  }
  return b;
}

function mergeList(a, b, warn, path) {
  if (!b.length) return a;
  if (!a.length) return b.slice();
  if (!(hasIds(a) && hasIds(b))) return a.concat(b);
  const out = a.slice();
  const pos = new Map(out.map((x, i) => [x.id, i]));
  for (const item of b) {
    if (pos.has(item.id)) {
      warn?.(`id repetido em ${path || 'lista'}: ${item.id} (o pacote posterior substitui; use patches.json)`);
      out[pos.get(item.id)] = item;
    } else {
      pos.set(item.id, out.length);
      out.push(item);
    }
  }
  return out;
}

/** True when the entity already carries an absolute date (then it is not stamped with fromYear). */
export function hasAbsoluteDate(e) {
  return !!(e.availableFrom || e.date || e.planned || e.plannedDate || e.fromYear != null || e.trigger?.fromYear != null);
}

/** Stamp copies of a pack file's list items with era/fromYear (see header). */
export function stampFile(file, json, eraId, eraFrom) {
  const lk = LIST_KEYS[file];
  if (!STAMP_KINDS.has(file) || !lk || !Array.isArray(json?.[lk]) || !eraId) return json;
  const eraValue = file === 'tech' ? Number(eraId.slice(1)) : eraId;
  const list = json[lk].map((e) => {
    if (!isObj(e)) return e;
    const out = { ...e };
    if (out.era == null) out.era = eraValue;
    if (eraFrom != null && !hasAbsoluteDate(out)) out.fromYear = eraFrom;
    return out;
  });
  return { ...json, [lk]: list };
}

/** Apply a patches.json to the assembled data (pure on the inputs: returns the new data fields). */
export function applyPatches(data, patches, warn) {
  const out = {};
  for (const [file, ops] of Object.entries(patches || {})) {
    if (!Array.isArray(ops)) continue; // _comment, monthBase…
    const lk = LIST_KEYS[file];
    const fileJson = out[file] || data[file];
    if (!lk || !fileJson) { warn?.(`patches.json: arquivo desconhecido ${file}`); continue; }
    const list = (fileJson[lk] || []).slice();
    for (const p of ops) {
      const i = list.findIndex((x) => x.id === p.id);
      const { $op = 'patch', ...fields } = p;
      if ($op === 'remove') { if (i >= 0) list.splice(i, 1); continue; }
      if ($op === 'replace') { if (i >= 0) list[i] = fields; else list.push(fields); continue; }
      if (i < 0) { warn?.(`patches.json: ${file}#${p.id} não existe para 'patch'`); continue; }
      list[i] = mergeValue(list[i], fields, warn, `${file}#${p.id}`);
    }
    out[file] = { ...fileJson, [lk]: list };
  }
  return out;
}

/**
 * Normalized scenario: legacy files (data/scenario.json) keep every field and gain the new ones; new-format files
 * gain the legacy aliases (startYear, endYear, playableActors) so today's readers keep working. Idempotent, pure.
 */
export function normalizeScenario(raw, id) {
  if (!raw) return null;
  const s = { ...raw };
  if (id && !s.id) s.id = id;
  const legacy = !s.kind && !s.start;
  if (legacy) {
    s.kind = 'scenario';
    s.start = { year: s.startYear, month: 0 };
    s.end = { year: s.endYear, month: 11 };
    s.turnWeeks = 1;
    s.eras = [`e${s.era ?? 4}`];
    s.snapshot = null;
    s.lifecycle = 'off';
    s.history = 'faithful';
    s.ending = { type: 'end' };
    s.playable = { rule: 'list', actors: (s.playableActors || []).slice() };
    s.unlocks = s.unlocks || {};
    // the Corrida Lunar keeps today's world (golden fixture): of the era packs only era.json (meta) is merged
    if (s.id === 'lunar_race') s.eraContent = 'meta';
  } else {
    s.kind = s.kind || 'scenario';
    s.start = { month: 0, ...(s.start || { year: s.startYear }) };
    s.end = s.end ? { month: 0, ...s.end } : { year: s.endYear, month: 11 };
    if (s.startYear == null) s.startYear = s.start.year;
    if (s.endYear == null) s.endYear = s.end.year;
    if (s.turnWeeks === undefined) s.turnWeeks = null;
    s.eras = Array.isArray(s.eras) && s.eras.length ? s.eras.slice() : ['e4'];
    if (s.era == null) s.era = Number(String(s.eras[0]).slice(1)) || 4;
    s.lifecycle = s.lifecycle || 'on';
    s.history = s.history || 'faithful';
    s.ending = s.ending || { type: s.kind === 'campaign' ? 'final' : 'end' };
    s.playable = s.playable || { rule: 'list', actors: s.playableActors || [] };
    if (!s.playableActors) s.playableActors = (s.playable.actors || []).slice();
    s.unlocks = s.unlocks || {};
    if (s.historicalFirsts === undefined) s.historicalFirsts = null;
  }
  return s;
}

/** Era packs in manifest order: [{id, era, years:[from,to], …}]. */
export const eraPacks = (manifest) => (manifest?.packs || []).filter((p) => p.era && !p.always);

/** Era id of a calendar year from the manifest windows (null outside every window). */
export function eraOfYear(manifest, year) {
  const list = eraPacks(manifest).filter((p) => p.years);
  for (const p of list) if (year >= p.years[0] && year <= p.years[1]) return p.era;
  // jan/3000 (the final event) and anything after the last window belong to the last era
  const last = list[list.length - 1];
  return last && year > last.years[1] ? last.era : null;
}

/** Ordered era ids of the manifest (e1…e7). */
export const eraIds = (manifest) => eraPacks(manifest).map((p) => p.era);

/** Small stable 32-bit FNV-1a hash (hex) of a string. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Hash of a pack's raw files (in the manifest's file order). */
export const packHash = (files, order) => hash32(JSON.stringify(order.map((n) => [n, files[n] ?? null])));

/** id -> object tables. Today's eight keys first (same content as before), then the new core lists. */
export function buildIndex(data) {
  const idx = {};
  for (const [k, [file, lk]] of Object.entries(INDEX_LISTS)) {
    idx[k] = {};
    for (const item of data[file]?.[lk] || []) idx[k][item.id] = item;
  }
  for (const [k, [file, lk]] of Object.entries(INDEX_EXTRA)) {
    const list = data[file]?.[lk];
    if (!Array.isArray(list)) continue;
    idx[k] = {};
    for (const item of list) idx[k][item.id] = item;
  }
  return idx;
}

/** Effect labels for generated node descriptions: data/tech.json effectLabels + core/techtree.json effectLabels. */
const techLabels = (data) => ({ ...(data.tech?.effectLabels || {}), ...(data.techtree?.effectLabels || {}) });
/** Tier number of a tech pack (techEra 'e3' → 3), null when the file says it itself (file.era). */
const techEraNum = (pack) => { const e = pack?.techEra || pack?.era; return typeof e === 'string' && /^e\d$/.test(e) ? Number(e.slice(1)) : null; };

/**
 * Assemble the data object from raw pack files.
 * @param {object} manifest   data/packs.json (or DEFAULT_MANIFEST)
 * @param {Record<string,{files:Record<string,any>, hash:string}>} raw  loaded packs by id
 * @param {string[]} active   pack ids to merge (manifest order is used, not this order)
 * @param {{scenario:any, scenarioId?:string, scenarioIndex?:any}} extra
 */
export function assemble(manifest, raw, active, { scenario, scenarioId, scenarioIndex } = {}) {
  const warnings = [];
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const on = new Set(active);
  let data = {};
  const eraMeta = {};
  const snapshots = {};
  const packsLoaded = {};
  const norm = normalizeScenario(scenario, scenarioId);
  const metaOnly = norm?.eraContent === 'meta';
  const scenId = norm?.id ?? scenarioId ?? null;
  for (const pack of manifest.packs || []) {
    if (!on.has(pack.id) || !raw[pack.id]) continue;
    if (Array.isArray(pack.exclude) && scenId != null && pack.exclude.includes(scenId)) continue;
    const { files, hash } = raw[pack.id];
    packsLoaded[pack.id] = hash;
    const isEraDir = !!pack.era && !pack.always && !pack.legacy;
    const eraFrom = pack.years?.[0] ?? files.era?.from ?? null;
    for (const name of pack.files || []) {
      const json = files[name];
      if (json === undefined || json === null) continue;
      if (metaOnly && !pack.always && name !== 'era') continue;
      if (isEraDir && name === 'era') { eraMeta[pack.era] = json; continue; }
      if (isEraDir && name === 'snapshot') { snapshots[pack.era] = json; continue; }
      if (name === 'patches') { Object.assign(data, applyPatches(data, json, warn)); continue; }
      const key = pack.legacy ? name : dataKey(name);
      let value = isEraDir ? stampFile(name, json, pack.era, eraFrom) : json;
      if (name === 'tech' && Array.isArray(value?.templates)) value = prepareTechFile(value, { labels: techLabels(data), era: techEraNum(pack) });
      data[key] = key in data ? mergeValue(data[key], value, warn, name) : value;
    }
  }
  // procedural narrative events of the speculative eras (C8, data/gen/gen-events.json): generated per loaded era
  // pack with a fixed seed, so they are content like any other (the same in every game and every load order)
  if (data.genEvents?.templates) {
    const have = new Set((data.events?.events || []).map((e) => e.id));
    const extra = Object.keys(eraMeta).filter((e) => data.genEvents.templates[e])
      .flatMap((eraId) => genEvents(data.genEvents, { eraId, seed: GEN_EVENTS_SEED })).filter((e) => !have.has(e.id));
    if (extra.length) data.events = { ...(data.events || {}), events: [...(data.events?.events || []), ...extra] };
  }
  data.eraPacks = eraMeta;
  data.snapshots = snapshots;
  data.scenario = normalizeScenario(scenario, scenarioId);
  data.scenarioIndex = scenarioIndex || null;
  data.packsLoaded = packsLoaded;
  data.packWarnings = warnings;
  data.index = buildIndex(data);
  return data;
}

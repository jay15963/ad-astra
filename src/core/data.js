// Data loader. All game content lives in /data/*.json (never hard-coded in sim code).
// Works in the browser (fetch) and Node (pass a reader).

export const DATA_FILES = [
  'scenario',     // scenario config (start year, end year, playable actors) — core
  'actors',       // actors + initial relations + blocs — diplomacy module
  'vehicles',     // launch vehicle catalog — calendar/catalog module
  'spacecraft',   // spacecraft/capsules/landers catalog — calendar/catalog module
  'destinations', // targets + energy cost per route + windows — calendar/catalog module
  'calendar',     // real/planned missions 2026-2030 with truth layer + delay history — calendar module
  'politics',     // economy/government/tension templates + news templates — politics module
  'tech',         // tech tree — research module
  'events',       // narrative + operation event cards and chains — narrative module
  'crew',         // name pools, traits, portrait parts, starting rosters — narrative module
  'bodies',       // map bodies (Earth, Moon, Mars...) for the map — map module
];

/**
 * @param {(name:string)=>Promise<any>} readJson  reads data/<name>.json
 * @returns {Promise<Record<string, any>>} data object keyed by file name
 */
export async function loadData(readJson) {
  const entries = await Promise.all(DATA_FILES.map(async (n) => [n, await readJson(n)]));
  const data = Object.fromEntries(entries);
  data.index = buildIndex(data);
  return data;
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

/** Convenience for tests/tools: load data from the repo root in Node. */
export async function loadDataNode(rootDir) {
  return loadData(await nodeReader(rootDir));
}

/** id -> object lookup tables for every list in data that has `id` fields. */
function buildIndex(data) {
  const idx = {};
  const lists = {
    actors: data.actors?.actors,
    vehicles: data.vehicles?.vehicles,
    spacecraft: data.spacecraft?.spacecraft,
    destinations: data.destinations?.destinations,
    calendar: data.calendar?.missions,
    tech: data.tech?.nodes,
    events: data.events?.events,
    bodies: data.bodies?.bodies,
  };
  for (const [k, list] of Object.entries(lists)) {
    idx[k] = {};
    for (const item of list || []) idx[k][item.id] = item;
  }
  return idx;
}

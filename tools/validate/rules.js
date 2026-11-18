// Data validator rules (docs/EXPANSION.md §4.4). Pure: works on an in-memory input, so tests can feed broken packs.
//
// input = {
//   manifest,                                   // data/packs.json
//   packs: { [packId]: { [file]: json } },      // raw files per pack (missing files simply absent)
//   sizes?: { [packId]: { [file]: bytes } },    // raw sizes for the budgets (§4.5)
//   scenarios: { [scenarioId]: json },          // raw scenario files
//   scenarioIndex,                              // data/scenarios/index.json
//   schemas: { 'vehicle.schema.json': {...}, … }
//   vocab?, stars?,                             // data/core/vocab.json (C0) and data/core/stars.json
//   vocabRequests?: { [eraId]: json },          // data/eras/eN/vocab-requests.json
//   extraCore?: { eco?, colonies? }             // core files outside the manifest that use vocabulary ids
// }
// Without input.vocab the vocabulary checks (tools/validate/vocab.js) are skipped.
// checkData(input, opts) -> { issues: [{level:'error'|'warn', pack, path, message}], density: {[year]: n}, stats }
// Paths look like "eras/e1/calendar.json#vostok1.planned". Messages are pt-BR.

import { validate } from './schema.js';
import { assemble, LIST_KEYS } from '../../src/core/packs.js';
import { checkVocab, starIds } from './vocab.js';
import { checkTechTree } from './techtree.js';

/** Year of the data's "present": items up to it may be 'fato' (the data is up to date as of nov/2026). */
export const DATA_PRESENT_YEAR = 2026;
export const CAMPAIGN_FROM = 1950;
export const CAMPAIGN_TO = 2999; // last era year; jan/3000 is the final event (core/eras.json "final")
export const PACK_BUDGET = 350 * 1024;
export const BOOT_BUDGET = 1.6 * 1024 * 1024; // raw JSON; GitHub Pages serves it gzipped (~20% of raw)

/** file -> schema of its list items. */
export const ITEM_SCHEMAS = {
  vehicles: 'vehicle', spacecraft: 'spacecraft', destinations: 'destination', calendar: 'calendar-mission',
  tech: 'tech-node', events: 'event', actors: 'actor', bodies: 'body', lineages: 'lineage',
  lifecycle: 'lifecycle-event', nations: 'nation',
};
/** file -> schema of the whole file. */
export const FILE_SCHEMAS = {
  era: 'era-meta', eras: 'eras', snapshot: 'snapshot', patches: 'patches', ending: 'ending', 'actor-gen': 'actor-gen',
  // Missões v2 (docs/MISSIONS-V2.md §9.2)
  tech: 'tech-file', techtree: 'techtree', missions: 'missions', contracts: 'contracts', modules: 'modules', stations: 'stations',
  market: 'market',
};
/** Core files whose texts are templates filled by code ({asset}, {owner}, {nome}…): placeholders are not checked. */
const TEMPLATE_TEXT_FILES = new Set(['missions', 'contracts', 'modules', 'stations', 'market', 'techtree']);

/** Truth layer × year (§2.3), calibrated to the data's present (nov/2026). */
export const TRUTH_YEARS = {
  fato: [-Infinity, DATA_PRESENT_YEAR],
  plano_oficial: [2024, 2040],
  projecao: [2026, 2060],
  especulacao: [2026, Infinity],
};

// case-sensitive on purpose: 'todo' is Portuguese ('todo o sistema'); 'TODO' is a leftover
const FORBIDDEN_TEXT = /\bTODO\b|\bFIXME\b|\bXXX\b|[Ll]orem ipsum|\bundefined\b|\bNaN\b|\[object Object\]/;
const TEXT_FIELDS = new Set(['name', 'title', 'text', 'description', 'notes', 'label', 'preview', 'statusNov2026', 'subtitle', 'blurb', 'headline']);
const CAPACITY_ORDER = ['leo', 'gto', 'tli', 'mars', 'outer'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const yearOf = (d) => (d == null ? null : typeof d === 'number' ? d : d.year ?? null);
const ymKey = (d) => (d == null ? null : typeof d === 'number' ? d * 12 : d.year * 12 + (d.month ?? 0));

/** The year an entity "happens" (absolute date first, then stamped/explicit fromYear). */
export function effectiveYear(e) {
  return yearOf(e.availableFrom) ?? yearOf(e.planned) ?? yearOf(e.plannedDate) ?? yearOf(e.date)
    ?? e.trigger?.fromYear ?? e.fromYear ?? yearOf(e.window?.from) ?? null;
}

function packPath(pack, file) { return `${pack.dir || ''}${file}.json`; }

/** Every string placeholder {x} used in the given JSON values. */
export function placeholdersIn(values) {
  const out = new Set();
  const scan = (o) => {
    if (typeof o === 'string') { for (const m of o.matchAll(/\{(\w+)\}/g)) out.add(m[1]); }
    else if (o && typeof o === 'object') for (const v of Object.values(o)) scan(v);
  };
  for (const v of values) scan(v);
  return out;
}

export function checkData(input, { onlyPack = null, legacyWarnings = false } = {}) {
  const issues = [];
  const { manifest, packs = {}, sizes = {}, scenarios = {}, scenarioIndex = null, schemas = {} } = input;
  const { vocab = null, stars = null, vocabRequests = {}, extraCore = {} } = input;
  const packDefs = manifest?.packs || [];
  const byId = Object.fromEntries(packDefs.map((p) => [p.id, p]));
  const add = (level, pack, path, message) => {
    if (onlyPack && pack !== onlyPack) return;
    if (level === 'warn' && byId[pack]?.legacy && !legacyWarnings) return;
    issues.push({ level, pack, path, message });
  };
  const err = (pack, path, msg) => add('error', pack, path, msg);
  const warn = (pack, path, msg) => add('warn', pack, path, msg);

  // ---------------------------------------------------------------- manifest
  const schemaOf = (name) => schemas[`${name}.schema.json`];
  const runSchema = (name, value, pack, path) => {
    const s = schemaOf(name);
    if (!s) { warn(pack, path, `esquema ${name}.schema.json ausente`); return; }
    for (const e of validate(s, value, { registry: schemas })) err(pack, e.path ? `${path}.${e.path}` : path, e.message);
  };
  if (!manifest) { err('manifest', 'packs.json', 'manifesto ausente'); return { issues, density: {}, stats: {} }; }
  runSchema('packs', manifest, 'manifest', 'packs.json');
  const seenPack = new Set();
  for (const p of packDefs) {
    if (seenPack.has(p.id)) err('manifest', `packs.json#${p.id}`, 'pacote repetido');
    seenPack.add(p.id);
  }
  const eraDefs = packDefs.filter((p) => p.era && !p.always);
  let expect = CAMPAIGN_FROM;
  for (const p of eraDefs) {
    if (!p.years) { err('manifest', `packs.json#${p.id}`, 'pacote de era sem "years" [de, até]'); continue; }
    if (p.years[0] !== expect) err('manifest', `packs.json#${p.id}.years`, `era deveria começar em ${expect}, começa em ${p.years[0]}`);
    if (p.years[1] < p.years[0]) err('manifest', `packs.json#${p.id}.years`, 'fim antes do começo');
    expect = p.years[1] + 1;
    if (!(p.files || []).includes('era')) err('manifest', `packs.json#${p.id}.files`, 'pacote de era precisa de era.json');
  }
  if (eraDefs.length && expect !== CAMPAIGN_TO + 1) err('manifest', 'packs.json', `as eras devem cobrir ${CAMPAIGN_FROM}–${CAMPAIGN_TO} (terminam em ${expect - 1})`);
  for (const p of packDefs) {
    for (const f of p.files || []) {
      if (packs[p.id]?.[f] !== undefined) continue;
      const path = packPath(p, f);
      if (p.legacy || f === 'era') err(p.id, path, 'arquivo listado no manifesto não existe');
      else warn(p.id, path, 'arquivo listado no manifesto ainda não existe (o carregador tolera)');
    }
  }

  // ---------------------------------------------------------------- schemas, per file
  for (const p of packDefs) {
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      const path = packPath(p, file);
      if (FILE_SCHEMAS[file]) runSchema(FILE_SCHEMAS[file], json, p.id, path);
      const itemSchema = ITEM_SCHEMAS[file];
      const lk = LIST_KEYS[file];
      if (itemSchema && lk) {
        if (!Array.isArray(json?.[lk])) { err(p.id, path, `lista "${lk}" ausente`); continue; }
        json[lk].forEach((item, i) => runSchema(itemSchema, item, p.id, `${path}#${item?.id ?? i}`));
      }
    }
  }
  for (const [id, raw] of Object.entries(scenarios)) runSchema('scenario', raw, 'scenarios', `${manifest.scenarios?.[id] || id}`);
  if (scenarioIndex) runSchema('scenario-index', scenarioIndex, 'scenarios', 'scenarios/index.json');

  // ---------------------------------------------------------------- origin + duplicates
  const origin = {}; // `${file}:${id}` -> pack id
  for (const p of packDefs) {
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      const lk = LIST_KEYS[file];
      if (!lk || file === 'patches' || !Array.isArray(json?.[lk])) continue;
      for (const item of json[lk]) {
        if (!isObj(item) || typeof item.id !== 'string') continue;
        const k = `${file}:${item.id}`;
        if (origin[k] && origin[k] !== p.id) err(p.id, `${packPath(p, file)}#${item.id}`, `id repetido (já existe no pacote ${origin[k]}); use patches.json para alterar`);
        else if (origin[k]) err(p.id, `${packPath(p, file)}#${item.id}`, 'id repetido no mesmo arquivo');
        else origin[k] = p.id;
      }
    }
  }
  const pathOf = (file, id) => {
    const p = byId[origin[`${file}:${id}`]];
    return p ? `${packPath(p, file)}#${id}` : `${file}.json#${id}`;
  };
  const packOf = (file, id) => origin[`${file}:${id}`] || 'legacy-e4';

  // ---------------------------------------------------------------- merged view (every pack: what the campaign sees)
  const raw = {};
  for (const p of packDefs) raw[p.id] = { files: packs[p.id] || {}, hash: '' };
  const merged = assemble(manifest, raw, packDefs.map((p) => p.id), { scenario: scenarios.campaign || scenarios.lunar_race || {}, scenarioId: scenarios.campaign ? 'campaign' : 'lunar_race' });
  for (const w of merged.packWarnings) err('manifest', 'merge', w);
  const list = (file) => merged[file]?.[LIST_KEYS[file]] || [];
  const ids = (file) => new Set(list(file).map((x) => x.id));
  const V = ids('vehicles'); const S = ids('spacecraft'); const D = ids('destinations'); const CAL = ids('calendar');
  const TECH = ids('tech'); const BODIES = ids('bodies');
  const lineages = merged.lineages?.lineages || [];
  const lifeEvents = merged.lifecycle?.events || [];
  const nations = new Set((merged.nations?.nations || []).map((n) => n.id));
  const ACTORS = new Set([...ids('actors'), ...lineages.map((l) => l.id)]);
  for (const e of lifeEvents) {
    if (e.op === 'birth' && e.actor) ACTORS.add(e.actor);
    for (const f of [].concat(e.from || [])) ACTORS.add(f);
  }
  const milestones = new Set([
    ...Object.keys(merged.events?.milestones || {}),
    ...Object.keys(scenarios.lunar_race?.historicalFirsts || {}),
    ...list('destinations').flatMap((d) => [...Object.values(d.firsts || {}), ...(d.arrivalMilestones || []).map((m) => (typeof m === 'string' ? m : m?.id))]),
    ...list('bodies').flatMap((b) => (b.milestones || []).map((m) => (typeof m === 'string' ? m : m?.id))),
  ].filter(Boolean));

  // lifecycle windows: born (year*12+month) and death per actor id
  const born = {}; const died = {};
  for (const l of lineages) if (l.born != null) born[l.id] = ymKey(l.born);
  for (const e of lifeEvents) {
    const k = ymKey(e.date);
    if (e.op === 'birth' && e.actor) born[e.actor] = Math.min(born[e.actor] ?? Infinity, k);
    if (e.op === 'dissolve' && e.actor) died[e.actor] = k;
    if (e.op === 'merge') for (const f of [].concat(e.from || [])) died[f] = k;
  }
  const aliveAt = (id, year) => {
    const k = year * 12;
    if (born[id] != null && born[id] > k + 11) return false;
    if (died[id] != null && died[id] < k) return false;
    return true;
  };

  const ref = (ok, file, id, field, value, what, level = 'error') => {
    if (ok) return;
    add(level, packOf(file, id), `${pathOf(file, id)}.${field}`, `${what} desconhecido: ${value}`);
  };

  // ---------------------------------------------------------------- references
  for (const m of list('calendar')) {
    ref(ACTORS.has(m.owner), 'calendar', m.id, 'owner', m.owner, 'ator');
    for (const p of m.partners || []) ref(ACTORS.has(p), 'calendar', m.id, 'partners', p, 'ator');
    ref(V.has(m.vehicleId), 'calendar', m.id, 'vehicleId', m.vehicleId, 'lançador');
    ref(S.has(m.spacecraftId), 'calendar', m.id, 'spacecraftId', m.spacecraftId, 'nave');
    if (m.secondarySpacecraftId) ref(S.has(m.secondarySpacecraftId), 'calendar', m.id, 'secondarySpacecraftId', m.secondarySpacecraftId, 'nave');
    ref(D.has(m.destination), 'calendar', m.id, 'destination', m.destination, 'destino');
    for (const r of m.prerequisites || []) ref(CAL.has(r), 'calendar', m.id, 'prerequisites', r, 'item de calendário');
    if (m.milestone) ref(milestones.has(m.milestone), 'calendar', m.id, 'milestone', m.milestone, 'marco', 'warn');
    const y = effectiveYear(m);
    const pk = packOf('calendar', m.id);
    if (y != null && !byId[pk]?.legacy) {
      for (const a of [m.owner, ...(m.partners || [])]) {
        if (ACTORS.has(a) && !aliveAt(a, y)) err(pk, `${pathOf('calendar', m.id)}.owner`, `${a} não existe em ${y} (ciclo de vida)`);
      }
    }
  }
  for (const s of list('spacecraft')) {
    for (const v of s.compatibleVehicles || []) ref(V.has(v), 'spacecraft', s.id, 'compatibleVehicles', v, 'lançador');
    for (const d of s.destinations || []) ref(D.has(d), 'spacecraft', s.id, 'destinations', d, 'destino');
    for (const l of s.landerRequired || []) ref(D.has(l), 'spacecraft', s.id, 'landerRequired', l, 'destino');
    if (s.operator) ref(ACTORS.has(s.operator), 'spacecraft', s.id, 'operator', s.operator, 'operador (ator)', 'warn');
  }
  for (const v of list('vehicles')) {
    ref(ACTORS.has(v.operator), 'vehicles', v.id, 'operator', v.operator, 'operador (ator)', 'warn');
    for (const a of v.embargo || []) ref(ACTORS.has(a), 'vehicles', v.id, 'embargo', a, 'ator', 'warn');
    if (v.debutCalendarId) ref(CAL.has(v.debutCalendarId), 'vehicles', v.id, 'debutCalendarId', v.debutCalendarId, 'item de calendário');
    const pk = packOf('vehicles', v.id);
    const y = effectiveYear(v);
    if (y != null && !byId[pk]?.legacy && ACTORS.has(v.operator) && !aliveAt(v.operator, y)) {
      err(pk, `${pathOf('vehicles', v.id)}.operator`, `${v.operator} não existe em ${y} (ciclo de vida)`);
    }
    // capacity (§4.4): leo is the ceiling; the chain is advisory (0 = rota não oferecida; superpesados mudam a ordem)
    const cap = v.capacity || {};
    for (const k of CAPACITY_ORDER.slice(1)) {
      if ((cap[k] ?? 0) > (cap.leo ?? 0)) err(pk, `${pathOf('vehicles', v.id)}.capacity.${k}`, `capacidade ${k} (${cap[k]} t) maior que a de LEO (${cap.leo} t)`);
    }
    const pos = CAPACITY_ORDER.map((k) => cap[k] ?? 0).filter((x) => x > 0);
    if (pos.some((x, i) => i > 0 && x > pos[i - 1])) warn(pk, `${pathOf('vehicles', v.id)}.capacity`, 'capacidade não decresce leo ≥ gto ≥ tli ≥ mars ≥ outer');
  }
  for (const t of list('tech')) for (const r of t.requires || []) ref(TECH.has(r), 'tech', t.id, 'requires', r, 'tecnologia');
  // interstellar destinations may sit on a star, exoplanet or galactic region of core/stars.json (vocab families)
  const sid = starIds(stars);
  const starBody = (b) => sid.stars.has(b) || sid.exoplanets.has(b) || sid.regions.has(b);
  for (const d of list('destinations')) ref(BODIES.has(d.body) || starBody(d.body), 'destinations', d.id, 'body', d.body, 'corpo');

  // ---------------------------------------------------------------- lifecycle (core files)
  const corePack = packDefs.find((p) => p.id === 'core') || { id: 'core', dir: 'core/' };
  const lineageIds = new Set(lineages.map((l) => l.id));
  for (const l of lineages) {
    const path = `${packPath(corePack, 'lineages')}#${l.id}`;
    const ids2 = l.identities || [];
    for (let i = 1; i < ids2.length; i++) {
      if (!(ymKey(ids2[i].from) > ymKey(ids2[i - 1].from))) err('core', `${path}.identities[${i}].from`, 'identidades fora de ordem (cada uma deve começar depois da anterior)');
    }
    if (nations.size) for (const n of Array.isArray(l.nation) ? l.nation.map((x) => x.id) : l.nation ? [l.nation] : []) {
      if (!nations.has(n)) err('core', `${path}.nation`, `nação desconhecida: ${n}`);
    }
  }
  const mergeInto = {};
  for (const e of lifeEvents) {
    const path = `${packPath(corePack, 'lifecycle')}#${e.id}`;
    const known = (a) => lineageIds.has(a) || ACTORS.has(a);
    if (e.actor && !known(e.actor)) err('core', `${path}.actor`, `ator desconhecido: ${e.actor}`);
    for (const f of [].concat(e.into || [])) if (typeof f === 'string' && e.op !== 'nationSplit' && !known(f)) err('core', `${path}.into`, `ator desconhecido: ${f}`);
    if (e.nation && nations.size && !nations.has(e.nation)) err('core', `${path}.nation`, `nação desconhecida: ${e.nation}`);
    if (e.op === 'rename') {
      const lin = lineages.find((l) => l.id === e.actor);
      if (lin && typeof e.to === 'number' && !(lin.identities || [])[e.to]) err('core', `${path}.to`, `identidade ${e.to} não existe em ${e.actor}`);
    }
    if (e.op === 'merge' && typeof e.into === 'string') for (const f of [].concat(e.from || [])) mergeInto[f] = e.into;
    if (['fato', 'plano_oficial'].includes(e.truthLayer) && !e.source) warn('core', path, `camada ${e.truthLayer} sem "source" (a Fase C precisa conferir)`);
    if (e.date && (e.date.month < 0 || e.date.month > 11)) err('core', `${path}.date.month`, 'mês fora de 0..11 (ciclo de vida usa meses base 0)');
  }
  for (const start of Object.keys(mergeInto)) {
    const seen = new Set([start]);
    let cur = mergeInto[start];
    while (cur) {
      if (seen.has(cur)) { err('core', `${packPath(corePack, 'lifecycle')}`, `ciclo de fusões: ${[...seen, cur].join(' → ')}`); break; }
      seen.add(cur);
      cur = mergeInto[cur];
    }
  }

  // ---------------------------------------------------------------- eras: windows, era.json, core/eras.json
  const coreEras = merged.eras?.eras || [];
  for (const p of eraDefs) {
    const meta = packs[p.id]?.era;
    const path = packPath(p, 'era');
    if (meta) {
      if (meta.id !== p.era) err(p.id, `${path}.id`, `id ${meta.id} difere da era do pacote ${p.era}`);
      if (p.years && (meta.from !== p.years[0] || meta.to !== p.years[1])) err(p.id, path, `anos ${meta.from}–${meta.to} diferem do manifesto ${p.years.join('–')}`);
      let last = -Infinity;
      (meta.chapters || []).forEach((c, i) => {
        const k = ymKey(c.from);
        if (k <= last) err(p.id, `${path}.chapters[${i}]`, 'capítulos fora de ordem');
        if (c.from?.month > 11) err(p.id, `${path}.chapters[${i}].from.month`, 'mês fora de 0..11 (era.json usa meses base 0)');
        if (p.years && (c.from.year < p.years[0] || c.from.year > p.years[1])) err(p.id, `${path}.chapters[${i}]`, `capítulo fora da era (${c.from.year})`);
        last = k;
      });
    }
    const ce = coreEras.find((e) => e.id === p.era);
    if (coreEras.length && !ce) err(p.id, 'core/eras.json', `era ${p.era} não existe em core/eras.json`);
    if (ce && p.years && (yearOf(ce.from) !== p.years[0] || yearOf(ce.to) !== p.years[1])) {
      err(p.id, `core/eras.json#${p.era}`, `anos ${yearOf(ce.from)}–${yearOf(ce.to)} diferem do manifesto ${p.years.join('–')}`);
    }
    // entity dates inside the era window, truth layer allowed by the era
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      const lk = LIST_KEYS[file];
      if (!lk || file === 'patches' || !Array.isArray(json?.[lk])) continue;
      for (const item of json[lk]) {
        const y = effectiveYear(item);
        const ipath = `${packPath(p, file)}#${item.id}`;
        if (y != null && p.years && y < p.years[0]) err(p.id, ipath, `data ${y} antes do início da era ${p.era} (${p.years[0]}): o resultado dependeria dos pacotes carregados`);
        if (y != null && p.years && y > p.years[1]) warn(p.id, ipath, `data ${y} depois do fim da era ${p.era} (${p.years[1]})`);
        if (item.truthLayer && meta?.truthLayers && !meta.truthLayers.includes(item.truthLayer)) warn(p.id, `${ipath}.truthLayer`, `camada ${item.truthLayer} incomum na era ${p.era}`);
      }
      // monthBase: same convention as the legacy file of the same kind
      const legacyFile = packs['legacy-e4']?.[file];
      if (legacyFile?.monthBase != null && json.monthBase !== legacyFile.monthBase) err(p.id, packPath(p, file), `monthBase deve ser ${legacyFile.monthBase} como em data/${file}.json`);
      if ((json.monthBase ?? legacyFile?.monthBase) === 1) {
        for (const item of json[lk]) for (const f of ['availableFrom', 'availableUntil', 'planned']) {
          if (item[f]?.month === 0) err(p.id, `${packPath(p, file)}#${item.id}.${f}.month`, 'mês 0 num arquivo com monthBase 1');
        }
      }
    }
  }

  // ---------------------------------------------------------------- truth layer × year, sources
  const truthCheck = (file, needSourceEverywhere) => {
    for (const e of list(file)) {
      if (!e.truthLayer) continue;
      const y = effectiveYear(e);
      const pk = packOf(file, e.id);
      const legacy = byId[pk]?.legacy;
      const range = TRUTH_YEARS[e.truthLayer];
      if (y != null && range && (y < range[0] || y > range[1])) {
        err(pk, `${pathOf(file, e.id)}.truthLayer`, `${e.truthLayer} não combina com ${y} (aceito: ${range[0] === -Infinity ? 'até' : range[0]}${range[1] === Infinity ? ' em diante' : `${range[0] === -Infinity ? ' ' : '–'}${range[1]}`})`);
      }
      if (['fato', 'plano_oficial'].includes(e.truthLayer) && !e.source && (needSourceEverywhere || !legacy)) {
        err(pk, `${pathOf(file, e.id)}.source`, `camada ${e.truthLayer} precisa de "source"`);
      }
    }
  };
  truthCheck('calendar', true);
  truthCheck('vehicles', false);
  truthCheck('spacecraft', false);

  // ---------------------------------------------------------------- scenarios
  for (const [id, raw] of Object.entries(scenarios)) {
    const path = manifest.scenarios?.[id] || id;
    const kind = raw.kind || 'scenario';
    const startYear = raw.start?.year ?? raw.startYear;
    for (const e of raw.eras || []) if (!eraDefs.some((p) => p.era === e)) err('scenarios', `${path}.eras`, `era ${e} não existe no manifesto`);
    const playable = raw.playable?.actors || raw.playableActors || [];
    for (const a of playable) {
      if (!ACTORS.has(a)) err('scenarios', `${path}.playable`, `ator jogável desconhecido: ${a}`);
      else if (kind === 'campaign' && born[a] != null && !aliveAt(a, startYear)) err('scenarios', `${path}.playable`, `${a} não existe em ${startYear}`);
    }
  }
  for (const s of scenarioIndex?.scenarios || []) {
    if (!manifest.scenarios?.[s.id]) err('scenarios', `scenarios/index.json#${s.id}`, 'cenário sem arquivo em packs.json "scenarios"');
  }

  // ---------------------------------------------------------------- texts (pt-BR checks)
  // + placeholders filled by Phase B modules ({pais}: investors.js anchor/archetype names)
  const legacyPh = new Set([...placeholdersIn(Object.values(packs['legacy-e4'] || {})), 'pais']);
  for (const p of packDefs) {
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      const walk = (o, path) => {
        if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${path}[${x?.id ?? i}]`)); return; }
        if (!isObj(o)) return;
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string' && TEXT_FIELDS.has(k)) {
            if (FORBIDDEN_TEXT.test(v)) err(p.id, `${path}.${k}`, `texto com marcador proibido: "${v.match(FORBIDDEN_TEXT)[0]}"`);
            // generator templates (data/gen) carry their own slot markers, filled by src/gen before the sim sees them
            if (!p.legacy && !String(p.dir || '').startsWith('gen/') && !TEMPLATE_TEXT_FILES.has(file)) for (const m of v.matchAll(/\{(\w+)\}/g)) if (!legacyPh.has(m[1])) err(p.id, `${path}.${k}`, `marcador {${m[1]}} desconhecido`);
          } else if (v && typeof v === 'object') walk(v, `${path}.${k}`);
        }
      };
      walk(json, packPath(p, file));
    }
  }

  // ---------------------------------------------------------------- shared vocabulary (core/vocab.json, §14 C0)
  let vocabStats = null;
  if (vocab) {
    vocabStats = checkVocab({ vocab, stars, requests: vocabRequests, extraCore, manifest, packDefs, packs, scenarios,
      scenarioIndex, listKeys: LIST_KEYS, packPath, add, runSchema });
  } else if (Object.keys(vocabRequests).length) {
    warn('core', 'core/vocab.json', 'há pedidos de vocabulário, mas core/vocab.json não existe');
  }

  // ---------------------------------------------------------------- tech tree and Missões v2 data (MISSIONS-V2 §9.3)
  const knownMilestones = new Set([...milestones, ...Object.keys(vocab?.milestones || {})]);
  const techStats = checkTechTree({ input, merged, packDefs, add, packPath, milestones: knownMilestones });

  // ---------------------------------------------------------------- budgets (§4.5)
  const packBytes = (id) => Object.values(sizes[id] || {}).reduce((a, b) => a + b, 0);
  for (const p of eraDefs) {
    const b = packBytes(p.id);
    if (b > PACK_BUDGET) err(p.id, p.dir, `pacote com ${(b / 1024).toFixed(0)} KB (limite ${PACK_BUDGET / 1024} KB)`);
  }
  // tech packs are merged whatever the eras (src/core/data.js activeIds: unlock keys must be known from the start)
  const always = packDefs.filter((p) => p.always || p.kind === 'tech').reduce((a, p) => a + packBytes(p.id), 0);
  const eraBytes = (p) => packBytes(p.id);
  const biggest = Math.max(0, ...eraDefs.map(eraBytes));
  const biggestEra = eraDefs.find((p) => eraBytes(p) === biggest)?.era ?? null;
  if (Object.keys(sizes).length && always + biggest > BOOT_BUDGET) err('manifest', 'packs.json', `dados de partida com ${(always + biggest) / 1024 | 0} KB (limite 1,6 MB): pacotes sempre carregados (com as árvores) ${(always / 1024) | 0} KB + era ${biggestEra} ${(biggest / 1024) | 0} KB`);

  // ---------------------------------------------------------------- density for authors
  const density = {};
  for (const p of eraDefs) {
    if (onlyPack && p.id !== onlyPack) continue;
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      const lk = LIST_KEYS[file];
      if (!lk || file === 'patches' || !Array.isArray(json?.[lk])) continue;
      for (const item of json[lk]) {
        const y = effectiveYear(item);
        if (y != null) density[y] = (density[y] || 0) + 1;
      }
    }
  }
  const stats = {
    packs: packDefs.length,
    entities: Object.keys(origin).length,
    bootBytes: always + biggest,
    packBytes: Object.fromEntries(packDefs.map((p) => [p.id, packBytes(p.id)])),
    vocab: vocabStats,
    techtree: techStats,
    bootEra: biggestEra,
  };
  return { issues, density, stats };
}

/** Errors only. */
export const errorsOf = (r) => r.issues.filter((i) => i.level === 'error');

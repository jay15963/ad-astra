// Shared vocabulary checks (docs/EXPANSION.md §14, C0). Pure: works on the in-memory validator input.
//
// data/core/vocab.json freezes every id that more than one era uses (destinations, bodies, milestones, mission types,
// spacecraft kinds, event kinds/groups/tags, tech branches/tiers, Hangar part kinds/families/templates, colony
// stages, investor kinds/profiles/archetypes, Eco fragments, endings, scenarios). Any id outside it is an error.
// New ids are asked for in data/eras/eN/vocab-requests.json: a pending request makes the id usable at once with a
// warning, until the steward moves it into vocab.json.

/** Vocabulary categories that a request may target (keys of vocab.json). */
export const VOCAB_CATEGORIES = [
  'destinations', 'bodies', 'milestones', 'missionTypes', 'spacecraftKinds', 'vehicleClasses', 'destinationKinds',
  'eventKinds', 'eventGroups', 'eventTags', 'techBranches', 'techTiers', 'partKinds', 'partFamilies',
  'rocketTemplates', 'colonyStages', 'holderKinds', 'investorProfiles', 'investorArchetypes', 'ecoFragments',
  'endings', 'scenarios',
];

/** Field name (anywhere in a data file) -> vocabulary category of its string value(s). */
export const FIELD_VOCAB = {
  milestone: 'milestones', milestones: 'milestones', goals: 'milestones', milestoneId: 'milestones',
  requiresMilestone: 'milestones', requiresMilestones: 'milestones', closingMilestoneId: 'milestones',
  destination: 'destinations', destinations: 'destinations', landerRequired: 'destinations',
  destinationId: 'destinations', demoDestination: 'destinations', targetDestination: 'destinations',
  missionType: 'missionTypes', missionTypes: 'missionTypes',
  ecoPiece: 'ecoFragments', ecoPieces: 'ecoFragments', ecoFragment: 'ecoFragments', ecoFragments: 'ecoFragments',
  requiresEco: 'ecoFragments',
  colonyStage: 'colonyStages', minColonyStage: 'colonyStages',
  investorArchetype: 'investorArchetypes', techTier: 'techTiers', ending: 'endings',
};

const CATEGORY_LABEL = {
  destinations: 'destino', bodies: 'corpo', milestones: 'marco', missionTypes: 'tipo de missão',
  spacecraftKinds: 'tipo de nave', vehicleClasses: 'classe de foguete', destinationKinds: 'tipo de destino',
  eventKinds: 'tipo de evento', eventGroups: 'grupo de evento', eventTags: 'etiqueta de evento',
  techBranches: 'ramo de tecnologia', techTiers: 'nível de tecnologia', partKinds: 'tipo de peça',
  partFamilies: 'família de peça', rocketTemplates: 'modelo de foguete', colonyStages: 'estágio de colônia',
  holderKinds: 'tipo de acionista', investorProfiles: 'perfil de investidor', investorArchetypes: 'arquétipo de investidor',
  ecoFragments: 'fragmento do Eco', endings: 'final', scenarios: 'cenário',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOf = (o) => (isObj(o) ? Object.keys(o).filter((k) => !k.startsWith('_')) : []);
const eraNum = (e) => (typeof e === 'number' ? e : typeof e === 'string' && /^e[1-7]$/.test(e) ? Number(e.slice(1)) : null);

/** Ids of data/core/stars.json: {stars, exoplanets, regions} with names, for the interstellar families. */
export function starIds(stars) {
  const out = { stars: new Map(), exoplanets: new Map(), regions: new Map() };
  for (const s of stars?.stars || []) {
    if (!s?.id) continue;
    if (!s.home) out.stars.set(s.id, s.short || s.name || s.id);
    for (const p of s.planets || []) if (p?.id) out.exoplanets.set(p.id, p.name || p.id);
  }
  for (const r of stars?.galaxy?.regions || []) if (r?.id && r.kind !== 'home') out.regions.set(r.id, r.name || r.id);
  return out;
}

/**
 * Allowed id sets per category (frozen + derived + pending requests).
 * Returns { sets: {cat: Set}, entry(cat, id) -> vocab entry|derived entry|request entry|null, provisional: Map }.
 */
export function vocabSets(vocab, stars = null, requests = {}) {
  const sets = {};
  const entries = {};
  for (const cat of VOCAB_CATEGORIES) {
    sets[cat] = new Set(keysOf(vocab?.[cat]));
    entries[cat] = new Map(keysOf(vocab?.[cat]).map((k) => [k, vocab[cat][k]]));
  }
  // interstellar destinations and bodies from core/stars.json
  const sid = starIds(stars);
  for (const m of [sid.stars, sid.exoplanets, sid.regions]) for (const [id] of m) {
    sets.bodies.add(id);
    if (!entries.bodies.has(id)) entries.bodies.set(id, { kind: m === sid.stars ? 'star' : m === sid.exoplanets ? 'exoplanet' : 'region', derived: true });
  }
  for (const fam of vocab?.destinationFamilies || []) {
    const src = sid[fam.from];
    if (!src || !fam.pattern) continue;
    const ph = fam.from === 'stars' ? '{star}' : fam.from === 'exoplanets' ? '{planet}' : '{region}';
    for (const [id, name] of src) {
      const did = fam.pattern.replace(ph, id);
      if (entries.destinations.has(did)) continue;
      sets.destinations.add(did);
      entries.destinations.set(did, { body: (fam.body || '').replace(ph, id), kind: fam.kind, era: fam.era, label: (fam.label || '').replace('{name}', name), family: fam.id });
    }
  }
  // pending requests: provisional ids
  const provisional = new Map(); // `${cat}:${id}` -> eraId
  for (const [eraId, json] of Object.entries(requests || {})) {
    for (const r of json?.requests || []) {
      if (!r || typeof r.id !== 'string' || !sets[r.category]) continue;
      if ((r.status ?? 'pending') !== 'pending' || sets[r.category].has(r.id)) continue;
      sets[r.category].add(r.id);
      entries[r.category].set(r.id, { ...(r.entry || {}), requested: eraId });
      provisional.set(`${r.category}:${r.id}`, eraId);
    }
  }
  return { sets, entry: (cat, id) => entries[cat]?.get(id) ?? null, provisional };
}

/**
 * Vocabulary checks. ctx = { vocab, stars, requests: {eraId: json}, packDefs, packs, scenarios, scenarioIndex,
 * manifest, extraCore, listKeys (LIST_KEYS of src/core/packs.js), packPath(pack,file), add(level,pack,path,msg), runSchema }.
 * Lists are read raw per pack (every file the loader read), so each id is reported at its own file#id.
 */
export function checkVocab(ctx) {
  const { vocab, stars, requests = {}, packDefs, packs, scenarios = {}, scenarioIndex, listKeys, packPath, add, runSchema } = ctx;
  // raw items per file kind, with their pack and path (patches.json excluded: it edits ids that already exist)
  const list = (file) => {
    const out = [];
    for (const p of packDefs) {
      const json = packs[p.id]?.[file];
      const lk = listKeys[file];
      if (!lk || !Array.isArray(json?.[lk])) continue;
      for (const item of json[lk]) if (isObj(item) && typeof item.id === 'string') out.push({ item, pack: p, path: `${packPath(p, file)}#${item.id}` });
    }
    return out;
  };
  const err = (pack, path, msg) => add('error', pack, path, msg);
  const warn = (pack, path, msg) => add('warn', pack, path, msg);
  const VOCAB_PATH = 'core/vocab.json';
  if (runSchema) runSchema('vocab', vocab, 'core', VOCAB_PATH);

  // ------------------------------------------------------------ requests files (data/eras/eN/vocab-requests.json)
  const eraDefs = packDefs.filter((p) => p.era && !p.always);
  const seenReq = new Map(); // `${cat}:${id}` -> {eraId, entry}
  for (const [eraId, json] of Object.entries(requests)) {
    const p = eraDefs.find((x) => x.era === eraId) || { id: eraId, dir: `eras/${eraId}/` };
    const rpath = `${p.dir}vocab-requests.json`;
    if (runSchema) runSchema('vocab-requests', json, p.id, rpath);
    if (json?.era && json.era !== eraId) err(p.id, `${rpath}.era`, `era ${json.era} difere da pasta ${eraId}`);
    for (const r of json?.requests || []) {
      if (!isObj(r) || typeof r.id !== 'string') continue;
      const ip = `${rpath}#${r.id}`;
      if (!VOCAB_CATEGORIES.includes(r.category)) { err(p.id, `${ip}.category`, `categoria desconhecida: ${r.category} (use uma de ${VOCAB_CATEGORIES.join(', ')})`); continue; }
      const frozen = isObj(vocab?.[r.category]) && Object.hasOwn(vocab[r.category], r.id);
      const status = r.status ?? 'pending';
      if (status === 'pending' && frozen) err(p.id, ip, `${r.id} já existe no vocabulário (${VOCAB_PATH} → ${r.category}); use o id congelado e apague o pedido`);
      if (status === 'accepted' && !frozen) err(p.id, ip, `pedido marcado como aceito, mas ${r.id} não está em ${VOCAB_PATH} → ${r.category}`);
      if (status === 'accepted' && frozen) warn(p.id, ip, 'pedido já incorporado ao vocabulário: pode ser apagado');
      if (status === 'pending') {
        warn(p.id, ip, `id provisório (${CATEGORY_LABEL[r.category]}): vale com aviso até entrar em ${VOCAB_PATH}`);
        const k = `${r.category}:${r.id}`;
        const prev = seenReq.get(k);
        if (prev && JSON.stringify(prev.entry ?? null) !== JSON.stringify(r.entry ?? null)) {
          err(p.id, ip, `${r.id} também foi pedido por ${prev.eraId} com outra definição: combinem uma só`);
        } else if (!prev) seenReq.set(k, { eraId, entry: r.entry });
      }
    }
  }

  const V = vocabSets(vocab, stars, requests);
  const has = (cat, id) => V.sets[cat]?.has(id);
  const unknown = (cat, id) => `${CATEGORY_LABEL[cat]} fora do vocabulário: ${id} (${VOCAB_PATH}; para um id novo, peça em data/eras/eN/vocab-requests.json)`;
  const reservedNote = (cat, id) => {
    const e = V.entry(cat, id);
    return e?.status === 'reserved' ? `${CATEGORY_LABEL[cat]} ${id} está reservado: ainda depende de ${e.needs || 'suporte no código'}` : null;
  };
  const checkId = (cat, id, pack, path) => {
    if (id == null || id === '') return;
    if (typeof id !== 'string') return;
    if (!has(cat, id)) { err(pack, path, unknown(cat, id)); return; }
    const r = reservedNote(cat, id);
    if (r) warn(pack, path, r);
  };

  // ------------------------------------------------------------ vocab self-consistency
  for (const [id, d] of Object.entries(vocab?.destinations || {})) {
    if (d.body && !has('bodies', d.body)) err('core', `${VOCAB_PATH}#destinations.${id}.body`, `corpo fora do vocabulário: ${d.body}`);
    if (d.kind && !has('destinationKinds', d.kind)) err('core', `${VOCAB_PATH}#destinations.${id}.kind`, `tipo de destino fora do vocabulário: ${d.kind}`);
  }
  for (const [id, a] of Object.entries(vocab?.investorArchetypes || {})) {
    if (a.kind && !has('holderKinds', a.kind)) err('core', `${VOCAB_PATH}#investorArchetypes.${id}.kind`, `tipo de acionista fora do vocabulário: ${a.kind}`);
    if (a.profile && !has('investorProfiles', a.profile)) err('core', `${VOCAB_PATH}#investorArchetypes.${id}.profile`, `perfil fora do vocabulário: ${a.profile}`);
  }
  for (const [id, t] of Object.entries(vocab?.techTiers || {})) {
    for (const b of Object.keys(t.themes || {})) if (!has('techBranches', b)) err('core', `${VOCAB_PATH}#techTiers.${id}.themes`, `ramo fora do vocabulário: ${b}`);
  }

  // ------------------------------------------------------------ destinations and bodies defined in data
  for (const { item: d, pack: { id: pk }, path } of list('destinations')) {
    if (d.id.startsWith('gen_')) { err(pk, path, 'prefixo gen_ é reservado aos geradores (src/gen)'); continue; }
    if (!has('destinations', d.id)) { err(pk, path, unknown('destinations', d.id)); continue; }
    const e = V.entry('destinations', d.id);
    if (e?.body && d.body && e.body !== d.body) err(pk, `${path}.body`, `corpo ${d.body} difere do vocabulário (${e.body})`);
    if (e?.kind && d.kind && e.kind !== d.kind) err(pk, `${path}.kind`, `tipo ${d.kind} difere do vocabulário (${e.kind})`);
    if (d.kind) checkId('destinationKinds', d.kind, pk, `${path}.kind`);
    for (const v of Object.values(d.firsts || {})) for (const m of [].concat(v)) checkId('milestones', m, pk, `${path}.firsts`);
  }
  for (const { item: b, pack: { id: pk }, path } of list('bodies')) {
    if (b.id.startsWith('gen_')) err(pk, path, 'prefixo gen_ é reservado aos geradores (src/gen)');
    else if (!has('bodies', b.id)) err(pk, path, unknown('bodies', b.id));
  }

  // ------------------------------------------------------------ typed lists
  for (const { item: s, pack, path } of list('spacecraft')) if (s.kind) checkId('spacecraftKinds', s.kind, pack.id, `${path}.kind`);
  for (const { item: v, pack, path } of list('vehicles')) if (v.class) checkId('vehicleClasses', v.class, pack.id, `${path}.class`);
  for (const { item: m, pack, path } of list('calendar')) if (m.type) checkId('missionTypes', m.type, pack.id, `${path}.type`);
  for (const { item: e, pack: { id: pk }, path } of list('events')) {
    if (e.kind) checkId('eventKinds', e.kind, pk, `${path}.kind`);
    if (e.group) checkId('eventGroups', e.group, pk, `${path}.group`);
    for (const t of Array.isArray(e.tags) ? e.tags : []) checkId('eventTags', t, pk, `${path}.tags`);
  }
  for (const { item: t, pack: pdef, path } of list('tech')) {
    const pk = pdef.id;
    if (t.branch) checkId('techBranches', t.branch, pk, `${path}.branch`);
    const n = eraNum(t.era ?? (pdef.era && !pdef.always ? pdef.era : null));
    if (pdef?.era && !pdef.always && n != null && n !== eraNum(pdef.era)) err(pk, `${path}.era`, `era ${t.era} difere do pacote ${pdef.era}`);
    if (t.techTier) {
      const tier = V.entry('techTiers', t.techTier);
      if (tier && n != null && eraNum(tier.era) !== n) err(pk, `${path}.techTier`, `nível ${t.techTier} é da era ${tier.era}, o nó é da era ${t.era}`);
    }
  }
  for (const { item: p, pack: { id: pk }, path } of list('parts')) {
    if (p.kind) checkId('partKinds', p.kind, pk, `${path}.kind`);
    if (p.family) checkId('partFamilies', p.family, pk, `${path}.family`);
  }
  for (const { item: p, pack: { id: pk }, path } of list('investors')) {
    if (!has('investorArchetypes', p.id)) { err(pk, path, unknown('investorArchetypes', p.id)); continue; }
    const a = V.entry('investorArchetypes', p.id);
    if (p.kind) checkId('holderKinds', p.kind, pk, `${path}.kind`);
    if (a?.kind && p.kind && a.kind !== p.kind) err(pk, `${path}.kind`, `tipo ${p.kind} difere do vocabulário (${a.kind})`);
    if (p.profile) checkId('investorProfiles', p.profile, pk, `${path}.profile`);
    for (const e of p.eras || []) if (a?.eras && !a.eras.includes(e)) err(pk, `${path}.eras`, `era ${e} fora das eras do arquétipo no vocabulário (${a.eras.join(', ')})`);
  }

  // ------------------------------------------------------------ keyed objects
  for (const p of packDefs) {
    const files = packs[p.id] || {};
    const ev = files.events;
    for (const k of keysOf(ev?.milestones)) checkId('milestones', k, p.id, `${packPath(p, 'events')}#milestones.${k}`);
    for (const k of keysOf(ev?.groups)) checkId('eventGroups', k, p.id, `${packPath(p, 'events')}#groups.${k}`);
    for (const f of ['calendar', 'bodies']) for (const k of keysOf(files[f]?.milestoneLabels)) checkId('milestones', k, p.id, `${packPath(p, f)}#milestoneLabels.${k}`);
    for (const b of files.tech?.branches || []) if (b?.id) checkId('techBranches', b.id, p.id, `${packPath(p, 'tech')}#branches.${b.id}`);
    for (const t of files.parts?.templates || []) if (t?.id) checkId('rocketTemplates', t.id, p.id, `${packPath(p, 'parts')}#templates.${t.id}`);
    const inv = files.investors;
    for (const k of keysOf(inv?.profiles)) checkId('investorProfiles', k, p.id, `${packPath(p, 'investors')}#profiles.${k}`);
    for (const [k, a] of Object.entries(inv?.anchors || {})) {
      checkId('holderKinds', k, p.id, `${packPath(p, 'investors')}#anchors.${k}`);
      if (a?.profile) checkId('investorProfiles', a.profile, p.id, `${packPath(p, 'investors')}#anchors.${k}.profile`);
    }
    for (const [k, pr] of Object.entries(inv?.profiles || {})) {
      for (const t of pr?.templates || []) if (t?.type) checkId('missionTypes', t.type, p.id, `${packPath(p, 'investors')}#profiles.${k}.${t.id}.type`);
    }
    for (const c of files.ending?.choices || []) if (c?.id) checkId('endings', c.id, p.id, `${packPath(p, 'ending')}#choices.${c.id}`);
  }
  for (const [id, raw] of Object.entries(scenarios)) {
    const path = ctx.manifest?.scenarios?.[id] || id;
    checkId('scenarios', id, 'scenarios', path);
    for (const k of keysOf(raw?.historicalFirsts)) checkId('milestones', k, 'scenarios', `${path}.historicalFirsts.${k}`);
  }
  for (const s of scenarioIndex?.scenarios || []) if (s?.id) checkId('scenarios', s.id, 'scenarios', `scenarios/index.json#${s.id}`);

  // ------------------------------------------------------------ typed fields anywhere (FIELD_VOCAB)
  // a value with spaces or capitals is a pt-BR label that happens to share a field name (core/eras.json "milestone");
  // AI goals may be scoped to an actor: "crewed_orbit_national:isro"
  const idPart = (k, v) => (/[\sA-ZÀ-ÿ]/.test(v) ? null : k === 'goals' ? v.split(':')[0] : v);
  const walk = (o, path, pack) => {
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${path}[${x?.id ?? i}]`, pack)); return; }
    if (!isObj(o)) return;
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_')) continue;
      const cat = FIELD_VOCAB[k];
      if (cat) {
        if (typeof v === 'string') checkId(cat, idPart(k, v), pack, `${path}.${k}`);
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) for (const x of v) checkId(cat, idPart(k, x), pack, `${path}.${k}`);
        else if (cat === 'colonyStages' && typeof v === 'number') {
          const max = Math.max(0, ...Object.values(vocab?.colonyStages || {}).map((s) => s.n || 0));
          if (!(Number.isInteger(v) && v >= 1 && v <= max)) err(pack, `${path}.${k}`, `estágio de colônia ${v} fora de 1..${max}`);
          continue;
        }
      }
      if (v && typeof v === 'object') walk(v, `${path}.${k}`, pack);
    }
  };
  for (const p of packDefs) {
    for (const [file, json] of Object.entries(packs[p.id] || {})) {
      walk(json, packPath(p, file), p.id); // non-string values (counts like needs.ecoPieces) are not ids
    }
  }
  for (const [id, raw] of Object.entries(scenarios)) walk(raw, ctx.manifest?.scenarios?.[id] || id, 'scenarios');
  for (const [name, json] of Object.entries(ctx.extraCore || {})) {
    walk(json, `core/${name}.json`, 'core');
    if (name === 'eco') for (const piece of json?.pieces || []) if (piece?.id) checkId('ecoFragments', piece.id, 'core', `core/eco.json#${piece.id}`);
    if (name === 'colonies') for (const st of json?.stages || []) if (st?.id) checkId('colonyStages', st.id, 'core', `core/colonies.json#stages.${st.id}`);
  }

  return {
    counts: Object.fromEntries(VOCAB_CATEGORIES.map((c) => [c, V.sets[c].size])),
    provisional: V.provisional.size,
  };
}

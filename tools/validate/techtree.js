// Tech tree, unlock keys and Missões v2 data checks (docs/MISSIONS-V2.md §9.3). Pure: works on the in-memory
// validator input plus the merged campaign view (tools/validate/rules.js builds both).
//
// - tech packs (manifest `kind: "tech"`): authored nodes carry histYear, era/techTier of their pack, ids never use
//   the generated prefix g<digit>_, descriptions ≤ 160 chars; templates are well formed; pack ≤ 40 KB raw.
// - the whole tree (authored + generated, every pack): requires only to the same or an earlier tier, no cycles,
//   effect keys in vocab.techEffects, unlock nodes with histYear inside their tier and fromYear = max(tier start,
//   histYear − lead) ± 2, never untilYear, keys in vocab.unlockKeys.
// - keys used by techtree.gates, item `gate` overrides, missions.json subtypes, modules.json and contracts.json are all
//   granted by some node; per-tier counts near techtree.targets (warning); preview counts match (warning).
// - modules.json: every module/vehicle can be delivered at histYear + 5 by some catalog vehicle (§3.2);
//   contracts.json needs.firstsAny are milestones; stations.json destinations exist with kind station;
//   calendar/spacecraft `sub` values are subtypes of vocab.missionSubtypes.

import { GEN_ID } from '../../src/core/techgen.js';

export const TECH_PACK_BUDGET = 40 * 1024;
export const TECHTREE_BUDGET = 15 * 1024;
export const DESC_MAX = 160;
const DEFAULT_TIERS = { t1: [1950, 1975], t2: [1976, 1999], t3: [2000, 2025], t4: [2026, 2050], t5: [2051, 2199], t6: [2200, 2599], t7: [2600, 2999] };
const DEFAULT_LEAD = { t1: 3, t2: 3, t3: 3, t4: 5, t5: 10, t6: 25, t7: 25 };
const KEY_RE = /^[a-zA-Z]+:[a-z0-9_.]+$/;
/** histYear of a t1 node may go back to the V-2 years (start keys granted at a 1950 campaign start). */
const T1_FLOOR = 1940;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const yearOf = (d) => (d == null ? null : typeof d === 'number' ? d : d.year ?? null);
const keysOfNode = (n) => (Array.isArray(n?.unlocks) ? n.unlocks.map((u) => (typeof u === 'string' ? u : u?.key)).filter((k) => typeof k === 'string') : []);
const tierNum = (n) => (typeof n?.techTier === 'string' && /^t[1-7]$/.test(n.techTier) ? Number(n.techTier.slice(1)) : Number.isInteger(n?.era) ? n.era : typeof n?.era === 'string' && /^e[1-7]$/.test(n.era) ? Number(n.era.slice(1)) : 4);

/**
 * @param {object} ctx { input, merged, packDefs, add(level, pack, path, msg), packPath(pack, file), milestones:Set, sizes }
 * @returns {{nodes:number, generated:number, unlock:number, keys:number, perTier:object}}
 */
export function checkTechTree(ctx) {
  const { input, merged, packDefs, add, packPath, milestones } = ctx;
  const { packs = {}, sizes = {}, vocab = null } = input;
  const err = (pack, path, msg) => add('error', pack, path, msg);
  const warn = (pack, path, msg) => add('warn', pack, path, msg);
  const tt = merged.techtree || null;
  const TIERS = tt?.tiers || DEFAULT_TIERS;
  const LEAD = tt?.lead || DEFAULT_LEAD;
  const corePack = packDefs.find((p) => p.id === 'core') || { id: 'core', dir: 'core/' };
  const TT_PATH = packPath(corePack, 'techtree');

  // ---------------------------------------------------------------- tech packs (manifest + authored files)
  const techPacks = packDefs.filter((p) => p.kind === 'tech');
  const eraOrder = packDefs.filter((p) => p.era && !p.always).map((p) => p.era);
  const origin = new Map(); // node id -> {pack, path}
  for (const p of packDefs) {
    for (const n of packs[p.id]?.tech?.nodes || []) if (n?.id) origin.set(n.id, { pack: p.id, path: `${packPath(p, 'tech')}#${n.id}` });
  }
  for (const p of techPacks) {
    const mpath = `packs.json#${p.id}`;
    if (!p.techEra || !eraOrder.includes(p.techEra)) { err('manifest', mpath, `pacote de tecnologia sem techEra válida (${p.techEra})`); continue; }
    const later = eraOrder.slice(eraOrder.indexOf(p.techEra));
    if (!Array.isArray(p.eras) || later.some((e) => !p.eras.includes(e))) {
      err('manifest', `${mpath}.eras`, `a árvore de ${p.techEra} precisa ficar carregada em todas as eras seguintes (${later.join(', ')}): pré-requisitos e chaves dependem dela`);
    }
    if (p.dir !== `tech/${p.techEra}/`) warn('manifest', `${mpath}.dir`, `pasta esperada tech/${p.techEra}/`);
    const bytes = Object.values(sizes[p.id] || {}).reduce((a, b) => a + b, 0);
    if (bytes > TECH_PACK_BUDGET) err(p.id, p.dir, `pacote de tecnologia com ${(bytes / 1024).toFixed(1)} KB (limite ${TECH_PACK_BUDGET / 1024} KB)`);
    const file = packs[p.id]?.tech;
    if (!file) continue;
    const n = Number(p.techEra.slice(1));
    const fpath = packPath(p, 'tech');
    if (file.era != null && file.era !== n) err(p.id, `${fpath}.era`, `era ${file.era} difere do pacote ${p.techEra}`);
    for (const node of file.nodes || []) {
      if (!isObj(node) || typeof node.id !== 'string') continue;
      const ip = `${fpath}#${node.id}`;
      if (GEN_ID.test(node.id)) err(p.id, ip, 'prefixo g<n>_ é reservado aos nós gerados (src/core/techgen.js)');
      if (node.era !== n) err(p.id, `${ip}.era`, `era ${node.era} difere do pacote ${p.techEra} (${n})`);
      if (node.techTier !== `t${n}`) err(p.id, `${ip}.techTier`, `nível ${node.techTier} difere de t${n}`);
      if (!Number.isInteger(node.histYear)) err(p.id, `${ip}.histYear`, 'histYear é obrigatório nos nós dos pacotes de tecnologia');
      if (!Number.isInteger(node.fromYear)) err(p.id, `${ip}.fromYear`, 'fromYear explícito é obrigatório (pacotes de tecnologia não são carimbados)');
      if (typeof node.description === 'string' && node.description.length > DESC_MAX) err(p.id, `${ip}.description`, `descrição com ${node.description.length} caracteres (máx. ${DESC_MAX})`);
    }
    for (const tp of file.templates || []) {
      if (!isObj(tp)) continue;
      const ip = `${fpath}#templates.${tp.id}`;
      const k = Array.isArray(tp.values) ? tp.values.length : 0;
      if (!Array.isArray(tp.names) || tp.names.length !== k) err(p.id, `${ip}.names`, `names precisa de ${k} nomes (um por valor)`);
      if (tp.shorts && (!Array.isArray(tp.shorts) || tp.shorts.length !== k)) err(p.id, `${ip}.shorts`, `shorts precisa de ${k} itens`);
      if (Array.isArray(tp.years) && TIERS[`t${n}`]) {
        const [a, b] = TIERS[`t${n}`];
        if (tp.years.some((y) => y < a || y > b)) err(p.id, `${ip}.years`, `anos ${tp.years.join('–')} fora do nível t${n} (${a}–${b})`);
      }
      if (vocab?.techEffects && !vocab.techEffects[tp.effect]) err(p.id, `${ip}.effect`, `efeito fora do vocabulário (vocab.techEffects): ${tp.effect}`);
    }
  }
  if (sizes.core?.techtree > TECHTREE_BUDGET) err('core', TT_PATH, `techtree.json com ${(sizes.core.techtree / 1024).toFixed(1)} KB (limite ${TECHTREE_BUDGET / 1024} KB)`);

  // ---------------------------------------------------------------- the whole tree (merged view)
  const nodes = merged.tech?.nodes || [];
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const where = (nd) => origin.get(nd.id) || (nd.generated ? originOfTemplate(nd) : { pack: 'legacy-e4', path: `tech.json#${nd.id}` });
  function originOfTemplate(nd) {
    const p = techPacks.find((x) => Number(x.techEra?.slice(1)) === nd.era);
    return { pack: p?.id || 'core', path: `${p ? packPath(p, 'tech') : 'tech.json'}#templates.${nd.generated} → ${nd.id}` };
  }
  const effects = vocab?.techEffects || null;
  const vocabKeys = isObj(vocab?.unlockKeys) ? vocab.unlockKeys : null;
  const granted = new Map(); // key -> [node]
  for (const nd of nodes) {
    const w = where(nd);
    const t = tierNum(nd);
    for (const r of nd.requires || []) {
      const rn = byId.get(r);
      if (!rn) continue; // rules.js reports unknown requires
      if (tierNum(rn) > t) err(w.pack, `${w.path}.requires`, `${r} é de um nível posterior (t${tierNum(rn)} > t${t})`);
      if (rn.secret && !nd.secret) warn(w.pack, `${w.path}.requires`, `${r} é secreto: o nó só abre depois de revelado`);
      const rf = rn.fromYear ?? null;
      if (rf != null && nd.histYear != null && rf > nd.histYear) warn(w.pack, `${w.path}.requires`, `${r} só abre em ${rf}, depois do ano histórico do nó (${nd.histYear})`);
    }
    if (effects) for (const k of Object.keys(nd.effects || {})) if (!effects[k]) err(w.pack, `${w.path}.effects.${k}`, `efeito fora do vocabulário (vocab.techEffects): ${k}`);
    const keys = keysOfNode(nd);
    if (!keys.length) continue;
    const tierId = `t${t}`;
    const [a, b] = TIERS[tierId] || [null, null];
    if (a != null && nd.histYear != null) {
      const floor = t === 1 ? T1_FLOOR : a;
      if (nd.histYear < floor || nd.histYear > b) err(w.pack, `${w.path}.histYear`, `nó de liberação com histYear ${nd.histYear} fora do nível ${tierId} (${a}–${b})`);
      if (nd.fromYear != null) {
        const want = Math.max(a, nd.histYear - (LEAD[tierId] ?? 0));
        if (Math.abs(nd.fromYear - want) > 2) err(w.pack, `${w.path}.fromYear`, `fromYear ${nd.fromYear} deveria ser ${want} ± 2 (histYear − ${LEAD[tierId]} anos, nunca antes de ${a})`);
      }
    }
    if (nd.untilYear != null) err(w.pack, `${w.path}.untilYear`, 'nó de liberação não pode ficar obsoleto (a chave precisa continuar obtível)');
    for (const k of keys) {
      if (!KEY_RE.test(k)) { err(w.pack, `${w.path}.unlocks`, `chave malformada: ${k} (use <tipo>:<id>)`); continue; }
      if (vocabKeys && !vocabKeys[k]) err(w.pack, `${w.path}.unlocks`, `chave fora do vocabulário (vocab.unlockKeys): ${k}`);
      if (isObj(vocab?.unlockKinds) && !vocab.unlockKinds[k.split(':')[0]]) err(w.pack, `${w.path}.unlocks`, `tipo de liberação desconhecido: ${k.split(':')[0]}`);
      if (!granted.has(k)) granted.set(k, []);
      granted.get(k).push(nd);
    }
  }
  // cycles (iterative DFS; reports the first cycle found)
  const state = new Map();
  for (const start of byId.keys()) {
    if (state.get(start)) continue;
    const stack = [[start, 0]];
    const pathIds = [];
    let cycle = null;
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      const [id, i] = top;
      if (i === 0) { state.set(id, 1); pathIds.push(id); }
      const req = byId.get(id)?.requires || [];
      if (i < req.length) {
        top[1]++;
        const r = req[i];
        if (!byId.has(r)) continue;
        if (state.get(r) === 1) { cycle = [...pathIds.slice(pathIds.indexOf(r)), r]; break; }
        if (!state.get(r)) stack.push([r, 0]);
      } else { state.set(id, 2); pathIds.pop(); stack.pop(); }
    }
    if (cycle) { const w = where(byId.get(cycle[0])); err(w.pack, w.path, `ciclo de pré-requisitos: ${cycle.join(' → ')}`); break; }
  }
  if (vocabKeys) for (const k of Object.keys(vocabKeys)) if (!k.startsWith('_') && !granted.has(k)) warn('core', `core/vocab.json#unlockKeys.${k}`, 'chave do vocabulário que nenhum nó concede');

  // ---------------------------------------------------------------- keys used ⊆ keys granted
  const need = (key, pack, path) => {
    if (typeof key !== 'string' || !key) return;
    if (!KEY_RE.test(key)) { err(pack, path, `chave malformada: ${key}`); return; }
    if (!granted.has(key)) err(pack, path, `chave ${key} não é concedida por nenhum nó da árvore`);
  };
  for (const [kind, rules] of Object.entries(tt?.gates || {})) {
    (rules || []).forEach((r, i) => {
      const p = `${TT_PATH}#gates.${kind}[${i}]`;
      need(r?.key, 'core', p);
      for (const k of r?.keys || []) need(k, 'core', p);
      if (r?.match?.destClass && !tt?.destClass?.[r.match.destClass]) err('core', `${p}.match.destClass`, `classe de destino desconhecida: ${r.match.destClass}`);
    });
  }
  for (const [kind, k] of Object.entries(tt?.payloadKeys || {})) need(k, 'core', `${TT_PATH}#payloadKeys.${kind}`);
  const itemFiles = { vehicles: 'vehicles', spacecraft: 'spacecraft', parts: 'parts', 'craft-parts': 'parts' };
  for (const p of packDefs) for (const r of packs[p.id]?.['craft-parts']?.roles || []) for (const k of r?.gate || []) need(k, p.id, `${packPath(p, 'craft-parts')}#roles.${r.id}.gate`);
  for (const p of packDefs) for (const [, k] of packs[p.id]?.['craft-parts']?.rules?.seatKeys || []) need(k, p.id, `${packPath(p, 'craft-parts')}#rules.seatKeys`);
  for (const p of packDefs) {
    for (const [file, lk] of Object.entries(itemFiles)) {
      for (const it of packs[p.id]?.[file]?.[lk] || []) {
        if (Array.isArray(it?.gate)) for (const k of it.gate) need(k, p.id, `${packPath(p, file)}#${it.id}.gate`);
      }
    }
    for (const t of packs[p.id]?.parts?.templates || []) if (Array.isArray(t?.gate)) for (const k of t.gate) need(k, p.id, `${packPath(p, 'parts')}#templates.${t.id}.gate`);
  }
  // satellites/rovers resolved by subKey
  const subKeyRules = Object.values(tt?.gates || {}).flat().filter((r) => r?.subKey);
  if (subKeyRules.length) {
    for (const p of packDefs) for (const s of packs[p.id]?.spacecraft?.spacecraft || []) {
      if (!s?.sub) continue;
      for (const r of subKeyRules) if (r.match?.kind === s.kind) need(`${r.subKey}:${s.sub}`, p.id, `${packPath(p, 'spacecraft')}#${s.id}.sub`);
    }
  }
  const missions = merged.missions;
  (missions?.subtypes || []).forEach((s) => need(s?.key, 'core', `core/missions.json#subtypes.${s?.type}.${s?.id}.key`));
  for (const [t, row] of Object.entries(isObj(missions?.types) ? missions.types : {})) need(row?.key, 'core', `core/missions.json#types.${t}.key`);
  const modules = merged.modules;
  for (const group of ['station', 'base', 'vehicles']) {
    for (const m of modules?.[group] || []) {
      need(m?.key, 'core', `core/modules.json#${group}.${m?.id}.key`);
      if (m?.key && m.histYear != null && granted.has(m.key)) {
        const y = Math.min(...granted.get(m.key).map((nd) => nd.histYear ?? Infinity));
        if (y !== m.histYear) warn('core', `core/modules.json#${group}.${m.id}.histYear`, `histYear ${m.histYear} difere do ano da chave ${m.key} na árvore (${y})`);
      }
    }
  }
  (missions?.subtypes || []).forEach((s) => {
    if (!s?.key || s.histYear == null || !granted.has(s.key)) return;
    const y = Math.min(...granted.get(s.key).map((nd) => nd.histYear ?? Infinity));
    if (y !== s.histYear) warn('core', `core/missions.json#subtypes.${s.type}.${s.id}.histYear`, `histYear ${s.histYear} difere do ano da chave ${s.key} na árvore (${y})`);
  });
  const contracts = merged.contracts;
  for (const group of ['contracts', 'opportunities']) {
    for (const c of contracts?.[group] || []) {
      const p = `core/contracts.json#${group}.${c?.id || c?.kind}`;
      for (const k of c?.needs?.playerKeys || []) need(k, 'core', `${p}.needs.playerKeys`);
      for (const m of c?.needs?.firstsAny || []) if (milestones && !milestones.has(m)) err('core', `${p}.needs.firstsAny`, `marco desconhecido: ${m}`);
    }
  }
  // historical stations
  const destIdx = new Map((merged.destinations?.destinations || []).map((d) => [d.id, d]));
  for (const s of merged.stations?.stations || []) {
    const p = `core/stations.json#${s?.id}`;
    const d = destIdx.get(s?.destination);
    if (!d) err('core', `${p}.destination`, `destino desconhecido: ${s?.destination}`);
    else if (d.kind !== 'station') err('core', `${p}.destination`, `destino ${s.destination} não é do tipo estação (${d.kind})`);
    for (const m of s?.modules || []) if (m?.id && modules && ![...(modules.station || []), ...(modules.base || [])].some((x) => x.id === m.id)) err('core', `${p}.modules`, `módulo desconhecido: ${m.id}`);
  }

  // ---------------------------------------------------------------- subtypes used by calendar / spacecraft
  const subs = isObj(vocab?.missionSubtypes) ? vocab.missionSubtypes : null;
  if (subs) {
    const SC_TYPE = { satellite: 'satellite', rover: 'rover', probe: 'probe', lander: 'probe' };
    for (const p of packDefs) {
      for (const m of packs[p.id]?.calendar?.missions || []) {
        if (m?.type === 'lander') warn(p.id, `${packPath(p, 'calendar')}#${m.id}.type`, 'tipo legado lander: use "type": "probe", "sub": "lander" (MISSIONS-V2 §1.1)');
        if (m?.sub == null) continue;
        const t = m.type === 'lander' ? 'probe' : m.type;
        if (!isObj(subs[t]) || !subs[t][m.sub]) err(p.id, `${packPath(p, 'calendar')}#${m.id}.sub`, `subtipo ${m.sub} não existe para ${t} (vocab.missionSubtypes)`);
      }
      for (const s of packs[p.id]?.spacecraft?.spacecraft || []) {
        if (s?.sub == null) continue;
        const t = SC_TYPE[s.kind];
        if (!t) continue;
        if (!isObj(subs[t]) || !subs[t][s.sub]) err(p.id, `${packPath(p, 'spacecraft')}#${s.id}.sub`, `subtipo ${s.sub} não existe para ${t} (vocab.missionSubtypes)`);
      }
    }
  }

  // ---------------------------------------------------------------- counts per tier, unlock share, preview
  const perTier = {};
  for (const nd of nodes) {
    const t = `t${tierNum(nd)}`;
    const c = (perTier[t] ||= { total: 0, unlock: 0, generated: 0, kinds: new Set() });
    c.total++;
    if (nd.generated) c.generated++;
    if (keysOfNode(nd).length) { c.unlock++; for (const k of keysOfNode(nd)) c.kinds.add(k.split(':')[0]); }
  }
  const campaignNodes = nodes.length;
  for (const [t, target] of Object.entries(tt?.targets || {})) {
    const have = perTier[t]?.total || 0;
    if (Math.abs(have - target) > target * 0.15) warn('core', `${TT_PATH}#targets.${t}`, `nível ${t} com ${have} nós (alvo ${target} ± 15%)`);
  }
  const unlockAll = nodes.filter((nd) => keysOfNode(nd).length).length;
  if (techPacks.length && campaignNodes && unlockAll / campaignNodes < 0.3) warn('core', TT_PATH, `só ${Math.round((unlockAll / campaignNodes) * 100)}% dos nós liberam algo (alvo ≥ 30%)`);
  if (vocabKeys) {
    for (const [t] of Object.entries(TIERS)) {
      const eraId = `e${t.slice(1)}`;
      const kinds = new Set(Object.entries(vocabKeys).filter(([k, v]) => !k.startsWith('_') && v?.era === eraId).map(([k]) => k.split(':')[0]));
      for (const kind of kinds) if (!perTier[t]?.kinds.has(kind)) warn('core', `${TT_PATH}#${t}`, `o nível ${t} não tem nó que libere ${kind}, mas há chaves desse tipo na era ${eraId}`);
    }
  }
  for (const [eraId, pv] of Object.entries(tt?.preview || {})) {
    const t = `t${eraId.slice(1)}`;
    const c = perTier[t];
    if (!c) continue;
    if (pv.count !== c.total || pv.unlockCount !== c.unlock) warn('core', `${TT_PATH}#preview.${eraId}`, `prévia diz ${pv.count}/${pv.unlockCount}, a árvore tem ${c.total} nós e ${c.unlock} liberações`);
  }

  // ---------------------------------------------------------------- modules deliverable (§3.2)
  checkModulesDeliverable({ merged, err, warn });

  return {
    nodes: nodes.length, generated: nodes.filter((nd) => nd.generated).length, unlock: unlockAll, keys: granted.size,
    perTier: Object.fromEntries(Object.entries(perTier).map(([t, c]) => [t, { total: c.total, unlock: c.unlock, generated: c.generated }])),
  };
}

/** Catalog vehicle in service at `year` with at least `t` tonnes to `route`. */
function lifts(vehicles, year, route, t) {
  return vehicles.some((v) => {
    const from = yearOf(v.availableFrom) ?? v.fromYear ?? -Infinity;
    const until = yearOf(v.availableUntil) ?? v.untilYear ?? Infinity;
    return from <= year && until >= year && (v.capacity?.[route] ?? 0) >= t;
  });
}

/**
 * Every station module reaches LEO at histYear + 5 (it flies itself); every base module and surface vehicle reaches
 * the Moon (TLI) inside the lightest uncrewed lander that holds it (cargoT, default massT × 0.25, §1.4).
 */
export function checkModulesDeliverable({ merged, err, warn }) {
  const M = merged.modules;
  if (!M) return;
  const vehicles = merged.vehicles?.vehicles || [];
  const landers = (merged.spacecraft?.spacecraft || []).filter((s) => s.kind === 'lander' && !(s.crew > 0) && !s.calendarOnly);
  const carrierFor = (t, year) => {
    let best = null;
    for (const s of landers) {
      const from = yearOf(s.availableFrom) ?? -Infinity;
      const until = yearOf(s.availableUntil) ?? s.untilYear ?? Infinity;
      if (from > year || until < year) continue;
      const cap = s.cargoT ?? Math.round(s.massT * 0.25 * 10) / 10;
      if (cap >= t && (!best || s.massT < best.massT)) best = s;
    }
    return best;
  };
  for (const m of M.station || []) {
    if (m?.histYear == null || !(m.massT > 0)) continue;
    const y = m.histYear + 5;
    if (!lifts(vehicles, y, 'leo', m.massT)) err('core', `core/modules.json#station.${m.id}`, `nenhum foguete do catálogo leva ${m.massT} t à órbita baixa até ${y} (histYear + 5)`);
  }
  for (const group of ['base', 'vehicles']) {
    for (const m of M[group] || []) {
      if (m?.histYear == null || !(m.massT > 0)) continue;
      const y = m.histYear + 5;
      const carrier = carrierFor(m.massT, y);
      const path = `core/modules.json#${group}.${m.id}`;
      if (!carrier) { warn('core', path, `nenhum pousador de carga do catálogo leva ${m.massT} t em ${y} (MISSIONS-V2 §1.4: generic_cargo_lander_*)`); continue; }
      const total = Math.round((m.massT + carrier.massT) * 10) / 10;
      if (!lifts(vehicles, y, 'tli', total)) err('core', path, `nenhum foguete do catálogo leva ${total} t (${m.massT} t + pousador ${carrier.id}) rumo à Lua até ${y}`);
    }
  }
}

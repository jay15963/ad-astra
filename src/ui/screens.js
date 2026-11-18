// Screen registry (docs/EXPANSION.md §12). app.js builds the bottom bar, the drawer (.gaveta) and the router from
// these descriptors; it has no screen list of its own. Adding a screen = one file exporting
// render(container, store, route) -> cleanup? + one registerScreen line below.
//
// Descriptor: { id, title, icon, group, order, nav: 'bottom'|'drawer'|'hidden', parent,
//   available(state, data) -> bool   (false hides it from the drawer and the router),
//   badge(state, store) -> 0 | true | n   (true = amber "precisa de você" dot),
//   load() -> Promise<{render}>       (lazy module),
//   go: 'tab/sub'                      (optional: a drawer shortcut into a sub-view of another screen),
//   action: 'title'                    (optional: a drawer item that runs a shell action instead of a screen),
//   soon: 'B' | 'C'                    (optional: the phase that delivers it; the stub says "em breve"),
//   short: 'Calendário'                (optional: compact name for the top bar when title is long) }
// DOM-free: tests import it in Node.

/** Drawer groups, in order (pt-BR labels shown as eyebrows). */
export const GROUPS = [
  { id: 'agencia', label: 'Agência' },
  { id: 'operacoes', label: 'Operações' },
  { id: 'universo', label: 'Universo' },
  { id: 'mundo', label: 'Mundo' },
  { id: 'arquivo', label: 'Arquivo' },
  { id: 'sistema', label: 'Sistema' },
];

const REGISTRY = new Map();

/** Register (or replace, same id) a screen descriptor. Returns the stored descriptor. */
export function registerScreen(desc) {
  if (!desc || typeof desc.id !== 'string' || !/^[a-z0-9_-]+$/.test(desc.id)) throw new Error(`registerScreen: id inválido (${desc?.id})`);
  const d = {
    nav: 'drawer', group: null, order: 100, parent: null, icon: 'info',
    available: null, badge: null, load: null, go: null, action: null, soon: null,
    ...desc,
  };
  d.title = String(d.title || d.id);
  REGISTRY.set(d.id, d);
  return d;
}

/** All descriptors (registration order), optionally only those visible for (state, data). */
export function screens(state = undefined, data = undefined) {
  const all = [...REGISTRY.values()];
  return state === undefined ? all : all.filter((d) => isAvailable(d, state, data));
}

export function screenById(id) { return REGISTRY.get(id) || null; }

/** available() guarded: a throwing predicate hides the screen instead of breaking the shell. */
export function isAvailable(d, state, data) {
  if (!d) return false;
  if (typeof d.available !== 'function') return true;
  try { return !!d.available(state, data); } catch { return false; }
}

/** lockedText guarded: a string while the screen is listed but not open yet, else null. */
function safeLocked(d, state, data) {
  try { return d.lockedText(state, data) || null; } catch { return null; }
}

/** Badge value guarded: 0 | true | n. */
export function badgeOf(d, state, store) {
  if (!d || typeof d.badge !== 'function') return 0;
  try {
    const v = d.badge(state, store);
    return v === true ? true : Number(v) > 0 ? Math.round(Number(v)) : 0;
  } catch { return 0; }
}

/** Bottom-bar destinations in order (4 items; the time disc sits between them, see app.js DISC_AT). */
export function bottomScreens() {
  return screens().filter((d) => d.nav === 'bottom').sort((a, b) => a.order - b.order);
}

/** Drawer sections: [{group, label, items: [desc]}] with only available items and non-empty groups. */
export function drawerSections(state, data) {
  const items = screens(state, data).filter((d) => d.nav === 'drawer');
  return GROUPS.map((g) => ({
    group: g.id, label: g.label,
    items: items.filter((d) => d.group === g.id).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
      .map((d) => (typeof d.lockedText === 'function' ? { ...d, lockedNow: safeLocked(d, state, data) } : d)),
  })).filter((s) => s.items.length);
}

/**
 * Route from a hash ("#missoes/m/abc"): {tab, sub}. Unknown or unavailable ids fall back to the Painel.
 * Drawer shortcuts (go) resolve to their target, so "#noticias" opens Mundo › Notícias.
 */
export function resolveRoute(hash, state = undefined, data = undefined) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [id, ...rest] = raw.split('/');
  let d = REGISTRY.get(id);
  if (d && d.go) {
    const [gt, ...gs] = String(d.go).split('/');
    return { tab: gt, sub: rest.length ? rest.join('/') : gs.join('/') };
  }
  if (!d || d.action || (state !== undefined && !isAvailable(d, state, data))) return { tab: 'painel', sub: '' };
  return { tab: id, sub: rest.join('/') };
}

/** Bottom tab that owns a route (for the bar's indicator): itself, its parent, or none. */
export function bottomOwner(tab) {
  const d = REGISTRY.get(tab);
  if (!d) return null;
  if (d.nav === 'bottom') return d.id;
  if (d.parent && REGISTRY.get(d.parent)?.nav === 'bottom') return d.parent;
  return null;
}

/** Drawer item that is "current" for a route ({tab, sub}): exact screen, or the shortcut matching tab/sub. */
export function drawerCurrent(route) {
  if (!route) return null;
  const key = `${route.tab}/${route.sub || ''}`;
  for (const d of REGISTRY.values()) {
    if (d.nav !== 'drawer') continue;
    if (d.go && (key === d.go || key.startsWith(`${d.go}/`))) return d.id;
  }
  const d = REGISTRY.get(route.tab);
  return d && d.nav === 'drawer' && !d.go ? d.id : null;
}

// ------------------------------------------------------------------ helpers for badges

const playerMissions = (st) => (Array.isArray(st?.missions) ? st.missions : []).filter((m) => m && m.status === 'planning');
/** Missions in planning that still have no rocket (item 9): the player must pick one before scheduling. */
export function missionsNeedingVehicle(st) {
  return playerMissions(st).filter((m) => !m.vehicleId && m.source !== 'cert');
}
const decisionsOf = (st, re) => (st?.decisions || []).filter((d) => re.test(String(d.kind || '')));
const views = () => import('./screen-views.js');
/** Lazy screen of a parallel Phase B builder: its module, or the "em breve" stub while the file is not there yet. */
const orStub = (load) => () => load().then((m) => (typeof (m?.render || m?.default) === 'function' ? m : null)).catch(() => null).then((m) => m || views().then((v) => v.stub));
const yearNow = (st) => (st?.startYear ?? 0) + Math.floor((st?.turn ?? 0) / 52);
/** A scenario unlock (data/scenarios/*.json "unlocks": {builder: {fromYear}}) is open in this year; no entry = open. */
export function unlocked(st, data, key) {
  const u = data?.scenario?.unlocks?.[key];
  return !u || !Number.isFinite(Number(u.fromYear)) || st == null || yearNow(st) >= Number(u.fromYear);
}
/** Investor mandates (Phase B, state.mandates) still open whose deadline is within a year. */
export function mandatesDueSoon(st) {
  const now = st?.turn ?? 0;
  return (Array.isArray(st?.mandates) ? st.mandates : []).filter((m) => m && m.status === 'open' && Number.isFinite(m.deadlineTurn) && m.deadlineTurn >= now && m.deadlineTurn - now <= 52);
}
/**
 * Infra badge (MISSIONS-V2 §11): the player's stations/bases (own or partner) with supply for < 13 weeks, or
 * derelict. Uses the sim's 'infra/list' views (supplyWeeks) when the store answers; else the raw slice (status).
 */
export function infraAlerts(st, store = null) {
  let list = null;
  try { const q = store?.tryQuery?.('infra/list', null); list = Array.isArray(q) ? q : Array.isArray(q?.list) ? q.list : null; } catch { list = null; }
  if (!list) list = Array.isArray(st?.assets?.list) ? st.assets.list : [];
  const pid = st?.playerId;
  return list.filter((a) => a && a.status !== 'ended' && (a.ownerId === pid || (a.partners || []).some((p) => p?.actorId === pid))
    && (a.status === 'derelict' || (Number.isFinite(a.supplyWeeks) && a.supplyWeeks < 13))).length;
}
/**
 * A founded agency (lifecycle `custom`) in a scenario with investors has a board from its first turn, even before the
 * investors module builds the cap table on the first advance: the drawer lists Conselho at once (Fase D, D4).
 */
export function boardPending(st, data) {
  if (!data?.scenario?.unlocks?.investors || !st?.playerId) return false;
  return !!st.actors?.[st.playerId]?.custom || String(st.playerId).startsWith('custom_');
}
/** Rocket designs of the player waiting for their test flights (Phase B builder, state.designs). */
const designsInTest = (st) => (Array.isArray(st?.designs) ? st.designs : Object.values(st?.designs || {})).filter((d) => d && (!d.owner || d.owner === st.playerId) && d.program?.phase === 'testFlights');

// ------------------------------------------------------------------ the registry (one line each)

registerScreen({ id: 'painel', title: 'Painel', icon: 'painel', nav: 'bottom', order: 10, load: () => import('./dashboard.js'), badge: (st) => (st?.decisions || []).length });
registerScreen({ id: 'missoes', title: 'Missões', icon: 'missoes', nav: 'bottom', order: 20, load: () => import('./missions-tab.js'), badge: (st) => missionsNeedingVehicle(st).length ? true : 0 });
registerScreen({ id: 'mapa', title: 'Mapa espacial', icon: 'mapa', nav: 'bottom', order: 30, load: () => import('./map.js') });
registerScreen({ id: 'mundo', title: 'Mundo', icon: 'mundo', nav: 'bottom', order: 40, load: () => import('./world-tab.js') });

registerScreen({ id: 'equipe', title: 'Equipe', icon: 'equipe', group: 'agencia', order: 10, load: () => import('./crew-view.js') });
registerScreen({ id: 'conselho', title: 'Conselho e investidores', short: 'Conselho', icon: 'acoes', group: 'agencia', order: 20, available: (st, data) => !!st?.cap || boardPending(st, data), load: orStub(() => import('./board.js')), badge: (st) => decisionsOf(st, /^(investors|mandate)/).length || (mandatesDueSoon(st).length ? true : 0) });
registerScreen({ id: 'identidade', title: 'Identidade e logo', short: 'Identidade', icon: 'editar', group: 'agencia', order: 30, load: () => import('./identidade.js') });
registerScreen({ id: 'financas', title: 'Finanças', icon: 'caixa', group: 'agencia', order: 40, load: () => import('./financas.js'), badge: (st) => ((st?.actors?.[st.playerId]?.cash ?? 0) < 0 ? true : 0) });

registerScreen({ id: 'pesquisa', title: 'Pesquisa', icon: 'pesquisa', group: 'operacoes', order: 10, load: () => import('./research-tab.js') });
registerScreen({ id: 'hangar', title: 'Hangar (construtor)', short: 'Hangar', icon: 'chave', group: 'operacoes', order: 20,
  // always listed: before the scenario unlock year it shows "a partir de <ano>" and opens an explanation instead
  lockedText: (st, data) => (unlocked(st, data, 'builder') ? null : `a partir de ${data.scenario.unlocks.builder.fromYear}`),
  load: () => orStub(() => import('./hangar.js'))().then((m) => ({
    render(container, store, route) {
      const lt = screenById('hangar')?.lockedText?.(store.state, store.data);
      if (lt) return views().then((v) => v.lockedPanel(container, store, 'hangar', lt));
      return m.render(container, store, route);
    },
  })),
  badge: (st) => (designsInTest(st).length ? true : 0) });
registerScreen({ id: 'infra', title: 'Infraestrutura', icon: 'estacao', group: 'operacoes', order: 25, load: () => import('./infra-tab.js'), badge: (st, store) => infraAlerts(st, store) || decisionsOf(st, /^infra\//).length });
registerScreen({ id: 'mercado', title: 'Mercado de foguetes', short: 'Mercado', icon: 'foguete', group: 'operacoes', order: 40, available: (st) => !!st?.market, load: orStub(() => import('./market.js')), badge: (st) => decisionsOf(st, /^market\/offer/).length });
registerScreen({ id: 'lancamentos', title: 'Calendário de lançamentos', short: 'Calendário', icon: 'calendario', group: 'operacoes', order: 30, load: () => import('./lancamentos.js'), badge: (st) => mandatesDueSoon(st).length });
registerScreen({ id: 'veiculo', title: 'Falta o veículo', icon: 'alerta', group: 'operacoes', order: 5, go: 'missoes/lista', available: (st) => missionsNeedingVehicle(st).length > 0, badge: (st) => missionsNeedingVehicle(st).length });

registerScreen({ id: 'colonias', title: 'Colônias', icon: 'alvo', group: 'universo', order: 10, available: (st, data) => !!st?.colonies || (!!data?.scenario?.unlocks?.colonies && unlocked(st, data, 'colonies')), load: orStub(() => import('./colonies.js')), badge: (st) => decisionsOf(st, /^colonies\//).length || ((st?.colonies?.list || []).some((c) => c && c.ownerId === st.playerId && c.status === 'active' && (c.welfare ?? 100) < 45) ? true : 0) });

registerScreen({ id: 'noticias', title: 'Notícias', icon: 'noticia', group: 'mundo', order: 10, go: 'mundo/noticias' });
registerScreen({ id: 'diplomacia', title: 'Rivais e diplomacia', icon: 'transferir', group: 'mundo', order: 20, go: 'mundo/atores', badge: (st) => decisionsOf(st, /^(diplomacy|politics)/).length });
registerScreen({ id: 'tabela', title: 'Tabela da Era', icon: 'ranking', group: 'mundo', order: 30, go: 'mundo/tabela' });

registerScreen({ id: 'anais', title: 'Anais', icon: 'livro', group: 'arquivo', order: 10, load: () => import('./anais.js') });
registerScreen({ id: 'memorial', title: 'Memorial', icon: 'vela', group: 'arquivo', order: 20, go: 'equipe/memorial' });
registerScreen({ id: 'album', title: 'Álbum', icon: 'estrela', group: 'arquivo', order: 30, go: 'equipe/album' });
registerScreen({ id: 'eco', title: 'Arquivo do Eco', icon: 'eco', group: 'arquivo', order: 40, available: (st) => !!st?.eco, load: orStub(() => import('./eco-archive.js')) });

registerScreen({ id: 'salvar', title: 'Salvar e capítulos', icon: 'salvar', group: 'sistema', order: 10, load: () => views().then((m) => m.salvar) });
registerScreen({ id: 'ajustes', title: 'Ajustes', icon: 'ajustes', group: 'sistema', order: 20, load: () => views().then((m) => m.ajustes) });
registerScreen({ id: 'sobre', title: 'Sobre', icon: 'info', group: 'sistema', order: 30, load: () => views().then((m) => m.sobre) });
registerScreen({ id: 'titulo', title: 'Sair para o título', icon: 'sair', group: 'sistema', order: 40, action: 'title' });

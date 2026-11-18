// Infraestrutura (drawer › Operações; docs/MISSIONS-V2.md §3, §11): the agency's stations, surface bases, satellite
// fleets and rovers. Segments Estações · Bases · Satélites · Rovers; each asset card shows owner and partners,
// health, supply reserve, crew and science per year, with the actions that open the mission builder prefilled
// (Enviar suprimentos / módulo / veículo, Rodízio de tripulação, Manutenção) plus Propor parceria and Abandonar.
// Reads query('infra/list') (src/sim/infra.js) and falls back to state.assets; acts only through store.dispatch and
// the builder. Styles in css/infra.css (tokens of docs/DESIGN.md), nothing wider than 320 px.
import {
  h, raw, chip, bar, button, icon, emptyState, openModal, toast, confirmDialog, fmtMonth, fmtIn, fmtMoney,
  SUB_LABELS, ASSET_STATUS_LABELS,
} from './components.js';
import { emblemSVG } from './portrait.js';
import { ensurePainelCss } from './decisions.js';
import { screenHead, section, kpis, note, countChip } from './screen-kit.js';
import { assetViews, assetsNeedingSupply, prefillBuilder, proposePartnership, moduleAddsText } from './missions-tab.js';

function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-infra-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/infra.css', import.meta.url).href;
    l.dataset.infraCss = '1';
    document.head.appendChild(l);
  } catch { /* no DOM (tests) */ }
}
ensureCss();

/** "1 estação", "3 bases", "1 frota de satélites"… (lead of the screen). Pure. */
export function countText(kind, n) {
  const W = { station: ['estação', 'estações'], base: ['base', 'bases'], satellite: ['frota de satélites', 'frotas de satélites'], rover: ['rover', 'rovers'] }[kind] || ['item', 'itens'];
  return `${n} ${n === 1 ? W[0] : W[1]}`;
}

export const SEGMENTS = [
  { id: 'estacoes', kind: 'station', label: 'Estações', glyph: 'estacao', empty: 'Nenhuma estação ainda. Uma missão de Estação lança o primeiro módulo; depois cada módulo amplia a estação.' },
  { id: 'bases', kind: 'base', label: 'Bases', glyph: 'base', empty: 'Nenhuma base de superfície ainda. Uma missão de Carga com um módulo de base, enviada a uma superfície, funda a primeira.' },
  { id: 'satelites', kind: 'satellite', label: 'Satélites', glyph: 'satelite', empty: 'Nenhum satélite em serviço. Satélites lançados ficam aqui como frotas e rendem ciência ou receita até o fim da vida útil.' },
  { id: 'rovers', kind: 'rover', label: 'Rovers', glyph: 'rodas', empty: 'Nenhum rover rodando. Uma missão de Rover pousa e gera ciência na superfície por anos.' },
];
const SERVICEABLE = new Set(['observatory', 'deep_observatory', 'gravity_lens']);
const fmtNum1 = (x) => String(Math.round((Number(x) || 0) * 10) / 10).replace('.', ',');
const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
/** Time left in a stat cell, short: "3 sem", "8 meses", "2,5 anos", "10 anos". Pure. */
export function lifeLeftText(w) {
  if (!Number.isFinite(w) || w <= 0) return '0 sem';
  if (w < 9) return `${Math.round(w)} sem`;
  if (w < 52) { const m = Math.max(1, Math.round(w / (52 / 12))); return m === 1 ? '1 mês' : `${m} meses`; }
  const y = w / 52;
  const r = y >= 3 ? Math.round(y) : Math.round(y * 10) / 10;
  return r === 1 ? '1 ano' : `${String(r).replace('.', ',')} anos`;
}
const weeksText = (w) => (!Number.isFinite(w) ? '—' : w <= 0 ? '0 sem' : w >= 104 ? `${Math.floor(w / 52)} anos` : `${w} sem`);
const healthKind = (hp) => (hp >= 40 ? 'good' : hp >= 15 ? 'warn' : 'bad');
const statusKind = (s) => (s === 'active' ? 'good' : s === 'degraded' ? 'warn' : s === 'derelict' ? 'bad' : 'muted');

/**
 * Builder prefill for an asset action (pure; exported for tests). action: 'supply' | 'module' | 'vehicle' |
 * 'rotation' | 'servicing' | 'more'. Returns a draft patch for prefillBuilder, or null when it does not apply.
 */
export function actionDraft(a, action) {
  if (!a) return null;
  const target = { targetAssetId: a.id };
  const room = Number.isFinite(a.storageT) && Number.isFinite(a.supplyT) ? Math.ceil(a.storageT - a.supplyT) : null;
  switch (action) {
    case 'supply':
      if (a.kind !== 'station' && a.kind !== 'base') return null;
      if (a.supplyDraft && typeof a.supplyDraft === 'object') return a.supplyDraft;
      return { type: 'cargo', sub: 'supply', destination: a.site, payload: { kind: 'supply', qty: Math.max(1, Math.min(200, room || 2)), ...target } };
    case 'module':
      if (a.kind === 'station') return { type: 'station', sub: 'expand', destination: a.site, payload: { kind: 'station_module', ...target } };
      if (a.kind === 'base') return { type: 'cargo', sub: 'base_module', destination: a.site, payload: { kind: 'base_module', ...target } };
      return null;
    case 'vehicle':
      return a.kind === 'base' ? { type: 'cargo', sub: 'base_vehicle', destination: a.site, payload: { kind: 'base_vehicle', qty: 1, ...target } } : null;
    case 'rotation':
      return a.kind === 'station' || a.kind === 'base' ? { type: 'crewed', sub: 'rotation', destination: a.site, payload: { kind: null, ...target } } : null;
    case 'servicing':
      return a.kind === 'satellite' ? { type: 'cargo', sub: 'servicing', destination: a.site, payload: { kind: 'servicing', ...target } } : null;
    case 'more':
      return a.kind === 'satellite' || a.kind === 'rover' ? { type: a.kind, sub: a.sub || null, destination: a.site, payload: null } : null;
    default: return null;
  }
}

/** Per-segment counts and alerts of the visible assets (pure on views). */
export function segmentCounts(views) {
  const out = {};
  for (const s of SEGMENTS) {
    const list = views.filter((a) => a.kind === s.kind && a.status !== 'ended');
    out[s.id] = { n: list.filter((a) => a.mine || a.partner).length, all: list.length, alerts: assetsNeedingSupply(list).length };
  }
  return out;
}

/** Badge of the drawer item (screens.js uses the same rule): player assets low on supply or derelict. */
export function infraBadge(store) {
  try { return assetsNeedingSupply(assetViews(store)).length; } catch { return 0; }
}

const ui = { seg: 'estacoes', openedRoute: null };

function goAction(store, a, action) {
  const patch = actionDraft(a, action);
  if (!patch) return;
  prefillBuilder(patch);
  store.ui?.navigate?.('missoes', 'nova');
}

function kindGlyph(kind) { return SEGMENTS.find((s) => s.kind === kind)?.glyph || 'modulo'; }

/** Owner + partner chips (emblem, name, share). */
function ownersRow(store, a) {
  const st = store.state;
  const shareOf = (id) => {
    const ps = a.partners || [];
    if (ps.some((p) => Number.isFinite(p.share) && p.massT == null)) return (ps.find((p) => p.actorId === id)?.share || 0) / 100;
    const w = (p) => (Number(p.massT) || 0) + (Number(p.crewWeeks) || 0) * 0.05;
    const tot = ps.reduce((s, p) => s + w(p), 0);
    return tot > 0 ? ps.filter((p) => p.actorId === id).reduce((s, p) => s + w(p), 0) / tot : (id === a.ownerId ? 1 : 0);
  };
  const ids = [a.ownerId, ...a.partners.map((p) => p.actorId).filter((id) => id !== a.ownerId)];
  return h('div', { class: 'if-owners' }, [...new Set(ids)].filter(Boolean).slice(0, 5).map((id) => {
    const ac = st.actors?.[id] || { id, name: id === a.ownerId ? a.ownerName : id };
    const sh = a.partners.length ? shareOf(id) : (id === a.ownerId ? 1 : 0);
    return h('span', { class: ['chip', 'if-owner', id === st.playerId && 'me'] }, raw(emblemSVG(ac, { size: 16 }), 'if-owner-em'),
      h('span', null, `${id === st.playerId ? 'Você' : ac.short || ac.name || id}${a.partners.length ? ` ${pct(sh)}` : ''}`));
  }));
}

/** Stat cell (eyebrow + mono value). */
function stat(label, value, cls = '') {
  return h('div', { class: ['if-stat', cls] }, h('span', { class: 'if-stat-l' }, label), h('b', { class: 'if-stat-v' }, value));
}

/** Facts of an asset as stat cells, by kind. */
function stats(store, a) {
  const st = store.state;
  if (a.kind === 'satellite') {
    return [
      Number(a.revenueMYr) > 0 ? stat('Receita/ano', fmtMoney(a.revenueMYr)) : stat('Unidades', String(a.unitsN || 1)),
      stat('Ciência', `${fmtNum1(a.sciYr)}/ano`),
      a.lifeEndTurn != null ? stat('Vida até', fmtMonth(a.lifeEndTurn, st.startYear)) : null,
    ];
  }
  if (a.kind === 'rover') {
    return [
      stat('Ciência', `${fmtNum1(a.sciYr)}/ano`),
      a.distanceKm != null ? stat('Rodados', `${Math.round(a.distanceKm).toLocaleString('pt-BR')} km`) : null,
      a.lifeEndTurn != null ? stat('Resta', a.lifeEndTurn > st.turn ? lifeLeftText(a.lifeEndTurn - st.turn) : 'encerrando') : null,
    ];
  }
  const low = Number.isFinite(a.supplyWeeks) && a.supplyWeeks < 13;
  return [
    stat('Reserva', weeksText(a.supplyWeeks), low ? 'low' : ''),
    stat('Equipe', a.crewCap != null ? `${a.crewN}/${a.crewCap}` : String(a.crewN)),
    stat('Ciência', `${fmtNum1(a.sciYr)}/ano`),
  ];
}

/** Action buttons of an asset card (each opens the builder prefilled). */
function actions(store, a, { full = false, close = null } = {}) {
  const st = store.state;
  const go = (act) => () => { close?.({ fromHistory: true }); goAction(store, a, act); };
  const mineOrPartner = a.mine || a.partner;
  const out = [];
  if (a.status === 'ended') return out;
  if (a.kind === 'station' || a.kind === 'base') {
    if (mineOrPartner) {
      out.push(button('Enviar suprimentos', go('supply'), { small: true, kind: assetsNeedingSupply([a]).length ? 'primary' : '', icon: 'caixa', iconSize: 16 }));
      if (a.status !== 'derelict') {
        out.push(button('Enviar módulo', go('module'), { small: true, icon: 'modulo', iconSize: 16 }));
        if (a.kind === 'base') out.push(button('Enviar veículo', go('vehicle'), { small: true, icon: 'rodas', iconSize: 16 }));
        out.push(button('Rodízio de tripulação', go('rotation'), { small: true, icon: 'equipe', iconSize: 16 }));
      }
    } else if (a.status !== 'derelict') {
      out.push(button('Propor parceria', () => proposePartnership(store, a), { small: true, icon: 'transferir', iconSize: 16 }));
    }
  }
  if (a.kind === 'satellite' && a.mine) {
    if (SERVICEABLE.has(a.sub) || a.serviceable) out.push(button('Manutenção', go('servicing'), { small: true, icon: 'chave', iconSize: 16 }));
    out.push(button('Lançar mais um', go('more'), { small: true, icon: 'mais', iconSize: 16 }));
  }
  if (a.kind === 'rover' && a.mine) out.push(button('Enviar outro rover', go('more'), { small: true, icon: 'mais', iconSize: 16 }));
  if (a.colonyId && a.kind === 'base') {
    out.push(button('Ver colônia', () => { close?.({ fromHistory: true }); store.ui?.navigate?.('colonias', a.colonyId); }, { small: true, kind: 'ghost', icon: 'alvo', iconSize: 16 }));
  }
  if (full && a.mine && (a.kind === 'station' || a.kind === 'base')) {
    out.push(button('Renomear', () => renameAsset(store, a, close), { small: true, kind: 'ghost', icon: 'editar', iconSize: 16 }));
    out.push(button('Abandonar', () => abandonAsset(store, a, close), { small: true, kind: 'danger', icon: 'fechar', iconSize: 16 }));
  }
  return out;
}

async function abandonAsset(store, a, close) {
  const what = a.kind === 'base' ? 'a base' : 'a estação';
  const ok = await confirmDialog(`Abandonar ${a.name}? A tripulação volta, ${what} para de render ciência e, sem manutenção, reentra ou se perde em alguns anos. Não dá para desfazer.`,
    { title: 'Abandonar', okLabel: 'Abandonar', cancelLabel: 'Manter', danger: true });
  if (!ok) return;
  const r = store.dispatch({ type: 'infra/abandon', assetId: a.id });
  if (r?.ok) { toast(`${a.name} foi abandonada.`, 'warn'); close?.(); } else toast(r?.error || 'Não foi possível abandonar agora.', 'bad');
}

function renameAsset(store, a, close) {
  const input = h('input', { class: 'input', value: a.name, maxlength: '32', 'aria-label': 'Novo nome' });
  openModal((done) => h('div', { class: 'if-rename' },
    h('label', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Nome'), input),
    h('div', { class: 'btn-col' }, button('Salvar nome', () => {
      const name = input.value.trim().slice(0, 32);
      if (!name) { toast('Escolha um nome.', 'warn'); return; }
      const r = store.dispatch({ type: 'infra/rename', assetId: a.id, name });
      if (r?.ok) { toast('Nome atualizado.', 'good'); done(); close?.(); } else toast(r?.error || 'Não foi possível renomear.', 'bad');
    }, { kind: 'primary', big: true }))), { title: `Renomear ${a.name}`, cls: 'if-sheet' });
}

/** Alert lines of an asset: the sim's alerts, else the derived ones (supply, health, derelict, life). */
export function assetAlerts(a, st) {
  const codes = new Set();
  const free = [];
  for (const x of a.alerts || []) {
    const t = typeof x === 'string' ? x : x?.text || x?.code;
    if (!t) continue;
    if (/^[a-z_]+$/.test(t)) codes.add(t); else free.push(t);
  }
  if (free.length && !codes.size) return free;
  const out = [];
  if (a.status === 'derelict') out.push(`${a.name} está abandonada: sem resgate, ${a.kind === 'base' ? 'a base se perde' : 'a estação reentra'} em até 3 anos.`);
  else if (a.status === 'degraded') out.push(`${a.name} se degrada: a ciência cai pela metade até a saúde passar de 40.`);
  if ((a.kind === 'station' || a.kind === 'base') && a.status !== 'derelict' && (a.mine || a.partner || codes.has('supply')) && Number.isFinite(a.supplyWeeks) && a.supplyWeeks < 13) {
    out.push(a.supplyWeeks <= 0 ? 'Suprimentos esgotados: a tripulação sai e a saúde despenca.' : `Suprimentos para ${a.supplyWeeks} semana${a.supplyWeeks === 1 ? '' : 's'}.`);
  }
  if ((a.kind === 'satellite' || a.kind === 'rover') && a.lifeEndTurn != null && st && a.lifeEndTurn - st.turn <= 52 && a.lifeEndTurn > st.turn) out.push(`Fim da vida útil ${fmtIn(a.lifeEndTurn, st.turn)}.`);
  return [...out, ...free];
}

/** One asset card. */
export function assetCard(store, a) {
  const st = store.state;
  const subLabel = a.sub ? (SUB_LABELS[a.kind]?.[a.sub] || null) : null;
  const count = a.kind === 'station' || a.kind === 'base' ? `${a.modulesN} módulo${a.modulesN === 1 ? '' : 's'}${a.vehiclesN ? ` · ${a.vehiclesN} veículo${a.vehiclesN === 1 ? '' : 's'}` : ''}`
    : a.kind === 'satellite' && Number(a.revenueMYr) > 0 ? `${a.unitsN || 1} unidade${(a.unitsN || 1) === 1 ? '' : 's'}` : null;
  const sub = [subLabel, a.siteName, !a.mine ? a.ownerName : null, count].filter(Boolean).join(' · ');
  const alerts = assetAlerts(a, st);
  const acts = actions(store, a);
  return h('article', { class: ['if-card', `st-${a.status}`, (a.mine || a.partner) && 'mine'], 'data-asset': a.id },
    h('button', { class: 'if-head', type: 'button', onclick: () => openAsset(store, a.id), 'aria-label': `Detalhes de ${a.name}` },
      h('span', { class: 'if-dot', 'aria-hidden': 'true' }, icon(kindGlyph(a.kind), 20)),
      h('span', { class: 'if-titles' }, h('b', { class: 'if-name' }, a.name), sub ? h('span', { class: 'if-sub' }, sub) : null),
      chip(ASSET_STATUS_LABELS[a.status] || a.status, statusKind(a.status)),
      icon('avancar', 16, 'if-chev')),
    (a.kind === 'station' || a.kind === 'base') && (a.partners.some((p) => p.actorId !== a.ownerId) || !a.mine) ? ownersRow(store, a) : null,
    a.kind !== 'satellite' || a.health < 100 ? bar(a.health, { kind: healthKind(a.health), label: 'Saúde', key: `if.${a.id}` }) : null,
    h('div', { class: 'if-stats' }, stats(store, a)),
    alerts.length ? h('div', { class: 'if-alerts' }, alerts.map((t) => h('div', { class: ['aviso', 'ms-note', a.status === 'derelict' ? 'bad' : 'warn'] }, icon('alerta', 14, 'ms-note-ic'), h('span', null, t)))) : null,
    acts.length ? h('div', { class: 'if-actions' }, acts) : null);
}

/** Detail sheet: modules and vehicles grouped, partners, all actions. */
export function openAsset(store, assetId) {
  const a = assetViews(store).find((x) => x.id === assetId);
  if (!a) { toast('Essa infraestrutura não existe mais.', 'warn'); return; }
  const md = store.data?.modules || {};
  const modTable = new Map([...(md.station || []), ...(md.base || [])].map((r) => [r.id, r]));
  const vehTable = new Map((md.vehicles || []).map((r) => [r.id, r]));
  const st = store.state;
  openModal((close) => h('div', { class: 'if-detail' },
    h('div', { class: 'if-detail-hero' }, h('span', { class: 'if-dot', 'aria-hidden': 'true' }, icon(kindGlyph(a.kind), 22)),
      h('div', { class: 'chips' }, chip(ASSET_STATUS_LABELS[a.status] || a.status, statusKind(a.status)), chip(a.siteName, 'muted'),
        a.sizeTier != null && a.kind === 'base' ? chip(`porte ${a.sizeTier}`, 'muted') : null)),
    a.partners.some((p) => p.actorId !== a.ownerId) || !a.mine ? ownersRow(store, a) : null,
    a.kind !== 'satellite' ? bar(a.health, { kind: healthKind(a.health), label: 'Saúde', showValue: true }) : null,
    h('div', { class: 'if-stats' }, stats(store, a)),
    (a.kind === 'station' || a.kind === 'base') ? h('div', { class: 'kv if-kv' },
      kv('Estoque', `${fmtNum1(a.supplyT)} t de ${fmtNum1(a.storageT)} t`),
      kv('Consumo', `${fmtNum1(a.upkeepTYr)} t por ano`),
      a.mine || a.partner ? kv('Sua participação', pct(a.share)) : null,
      Number.isFinite(a.foundedTurn) ? kv('Desde', fmtMonth(a.foundedTurn, st.startYear)) : null) : null,
    a.modules?.length ? h('div', null, h('div', { class: 'ms-eyebrow if-eyebrow' }, 'Módulos'),
      h('ul', { class: 'if-mods' }, a.modules.map((m) => {
        const r = modTable.get(m.id);
        return h('li', null, h('span', { class: 'if-mod-name' }, `${r?.label || m.label || m.id}${(m.n || 1) > 1 ? ` × ${m.n}` : ''}`), r ? h('span', { class: 'tiny muted' }, moduleAddsText(r)) : null);
      }))) : null,
    a.vehicles?.length ? h('div', null, h('div', { class: 'ms-eyebrow if-eyebrow' }, 'Veículos'),
      h('ul', { class: 'if-mods' }, a.vehicles.map((v) => h('li', null, h('span', { class: 'if-mod-name' }, `${vehTable.get(v.id)?.label || v.label || v.id}${(v.n || 1) > 1 ? ` × ${v.n}` : ''}`))))) : null,
    assetAlerts(a, st).map((t) => note(t, { kind: a.status === 'derelict' ? 'bad' : 'warn', icon: 'alerta' })),
    h('div', { class: 'if-actions if-actions-full' }, actions(store, a, { full: true, close }))),
  { title: a.name, cls: 'if-sheet' });
}

function kv(k, v) {
  return h('div', { class: 'kv-row' }, h('span', { class: 'muted' }, k), h('span', { class: 'num' }, v));
}

export function render(container, store, route) {
  ensurePainelCss();
  ensureCss();
  const st = store.state;
  const sub = String(route?.sub || '');
  const seg0 = SEGMENTS.find((s) => sub === s.id || sub.startsWith(`${s.id}/`));
  if (seg0) ui.seg = seg0.id;
  const views = assetViews(store);
  // #infra/a/<id>: open that asset's segment and its sheet once
  if (sub.startsWith('a/')) {
    const a = views.find((x) => x.id === sub.slice(2));
    if (a) ui.seg = SEGMENTS.find((s) => s.kind === a.kind)?.id || ui.seg;
    if (a && ui.openedRoute !== sub) { ui.openedRoute = sub; setTimeout(() => openAsset(store, a.id), 0); }
  } else ui.openedRoute = null;
  const counts = segmentCounts(views);
  const seg = SEGMENTS.find((s) => s.id === ui.seg) || SEGMENTS[0];
  const go = (id) => { ui.seg = id; if (store.ui?.navigate) store.ui.navigate('infra', id); else { container.innerHTML = ''; render(container, store, { sub: id }); } };
  const mine = views.filter((a) => (a.mine || a.partner) && a.status !== 'ended');
  const sci = mine.reduce((s, a) => s + (a.mySciYr != null ? a.mySciYr : (Number(a.sciYr) || 0) * (a.kind === 'station' || a.kind === 'base' ? (a.share || (a.mine ? 1 : 0)) : 1)), 0);
  const upkeep = mine.filter((a) => a.kind === 'station' || a.kind === 'base').reduce((s, a) => s + (Number(a.upkeepTYr) || 0) * (a.share || (a.mine ? 1 : 0)), 0);
  const alerts = assetsNeedingSupply(views).length;
  const list = views.filter((a) => a.kind === seg.kind);
  const own = list.filter((a) => (a.mine || a.partner) && a.status !== 'ended');
  const others = list.filter((a) => !a.mine && !a.partner && a.status !== 'ended' && (a.kind === 'station' || a.kind === 'base'));
  const past = (Array.isArray(st.assets?.past) ? st.assets.past : []).filter((p) => p && (!p.kind || p.kind === seg.kind) && (p.ownerId === st.playerId || !p.ownerId)).slice(-5).reverse();
  const lead = SEGMENTS.map((s) => (counts[s.id].n ? countText(s.kind, counts[s.id].n) : null)).filter(Boolean).join(' · ') || 'Estações, bases, satélites e rovers da agência';
  container.appendChild(h('div', { class: 'view-pad tela infra' },
    screenHead({ title: 'Infraestrutura', lead }),
    kpis([
      { label: 'Ciência por ano', value: fmtNum1(sci), sub: 'sua parte, de tudo em serviço' },
      { label: 'Manutenção', value: `${fmtNum1(upkeep)} t`, sub: 'de carga por ano', tone: alerts ? 'down' : '' },
    ], { label: 'Números da infraestrutura' }),
    alerts ? note(`${alerts} ${alerts === 1 ? 'precisa' : 'precisam'} de você: pouco suprimento ou abandono. Uma missão de Carga resolve.`, { kind: 'warn', icon: 'alerta' }) : null,
    h('div', { class: 'segmented tabs if-tabs', role: 'tablist' }, SEGMENTS.map((s) => h('button', {
      class: ['seg', s.id === seg.id && 'active'], type: 'button', role: 'tab', 'aria-selected': s.id === seg.id ? 'true' : 'false', onclick: () => go(s.id),
    }, s.label, counts[s.id].alerts ? h('span', { class: 'badge' }, String(counts[s.id].alerts)) : counts[s.id].n ? h('span', { class: 'if-seg-n' }, String(counts[s.id].n)) : null))),
    own.length ? section(seg.kind === 'satellite' ? 'Suas frotas' : seg.kind === 'rover' ? 'Seus rovers' : 'Suas e de parceria', { right: countChip(own.length) },
      h('div', { class: 'if-list' }, own.map((a) => assetCard(store, a))))
      : h('div', { class: 'if-empty' }, emptyState(seg.empty, seg.glyph),
        button(seg.kind === 'station' ? 'Montar uma estação' : seg.kind === 'base' ? 'Fundar uma base' : seg.kind === 'satellite' ? 'Lançar um satélite' : 'Enviar um rover', () => {
          prefillBuilder({ type: seg.kind === 'base' ? 'cargo' : seg.kind, sub: seg.kind === 'base' ? 'base_module' : null, payload: seg.kind === 'base' ? { kind: 'base_module', newAsset: true } : seg.kind === 'station' ? { kind: 'station_module', newAsset: true } : null });
          store.ui?.navigate?.('missoes', 'nova');
        }, { kind: 'primary', icon: 'mais', big: true, cls: 'if-wide' })),
    others.length ? section('De outras agências', { right: countChip(others.length) },
      note('Para ajudar a montar ou abastecer, é preciso uma parceria de estação (ou um contrato que a nomeie).', { icon: 'info' }),
      h('div', { class: 'if-list' }, others.map((a) => assetCard(store, a)))) : null,
    past.length ? section('Encerradas', {}, h('div', { class: 'pn-list' }, past.map((p) => h('div', { class: 'pn-row' },
      h('span', { class: 'pn-text' }, h('span', { class: 'pn-top' }, h('b', { class: 'pn-name' }, p.name || '—'), p.year ? h('span', { class: 'pn-meta' }, String(p.year)) : null),
        p.cause ? h('span', { class: 'pn-sub' }, p.cause) : null))))) : null));
}

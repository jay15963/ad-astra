// Colônias (drawer › Universo; docs/EXPANSION.md §12, §14 C10; GDD "Mapa do universo e colonização").
// Lista: as colônias do jogador (estágio, população, bem-estar, opinião, suprimento), o que está a caminho, as linhas
// de suprimento, os locais para fundar ou sondar, as colônias rivais e a fronteira estelar. Detalhe (#colonias/<id>):
// trilha dos seis estágios, as quatro necessidades com obras, rota, impostos, próximo estágio, grandes projetos.
// Lê query('colonies/view') (src/sim/colonies.js; com o módulo fora do registro, a mesma função pura direto) e age só
// por store.dispatch. Estilos próprios injetados uma vez (tokens do DESIGN.md), nada mais largo que 320 px.
import { h, button, chip, bar, fmtMoney, fmtMonth, toast, confirmDialog, emptyState, segmented, linkButton } from './components.js';
import { listRow, ensurePainelCss, openDecision } from './decisions.js';
import { screenHead, section, kpis, pills, listCard, note, countChip, rerender } from './screen-kit.js';
import { view as simView } from '../sim/colonies.js';
import { assetViews } from './missions-tab.js';

const CSS = `
.colonias .cl-card{background:var(--s1);border:1px solid var(--line);border-radius:var(--r-card);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0;text-align:left;width:100%;color:inherit;font:inherit}
.colonias button.cl-card{cursor:pointer}
.colonias .cl-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-width:0}
.colonias .cl-nome{font-weight:600;min-width:0;overflow-wrap:break-word}
.colonias .cl-sub{font-size:var(--t12);color:var(--text-2);min-width:0;overflow:hidden;text-overflow:ellipsis}
.colonias .cl-num{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:var(--t12);color:var(--text-2);white-space:nowrap}
.colonias .cl-trilha{display:flex;gap:4px;align-items:center;min-width:0}
.colonias .cl-passo{flex:1;height:6px;border-radius:3px;background:var(--s4);min-width:0}
.colonias .cl-passo.feito{background:var(--yellow)}
.colonias .cl-passo.agora{background:var(--yellow);box-shadow:0 0 0 2px rgba(227,179,65,.35)}
.colonias .cl-trilha-rot{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;font-size:var(--t10);color:var(--text-3);text-align:center;min-width:0}
.colonias .cl-trilha-rot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.colonias .cl-trilha-rot .agora{color:var(--text);font-weight:600}
.colonias .cl-barras{display:flex;flex-direction:column;gap:4px;min-width:0}
.colonias .cl-chips{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.colonias .cl-need{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.colonias .cl-need:first-child{border-top:0}
.colonias .cl-need-txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.colonias .cl-need-bar{grid-column:1/-1;min-width:0}
.colonias .cl-need-bar .bar-label{display:none}
.colonias .cl-need-bar .bar-row{display:block}
.colonias .cl-need-bar .bar{width:100%}
.colonias .cl-need small{grid-column:1/-1;color:var(--text-3);font-size:var(--t11)}
.colonias .cl-rota{display:flex;align-items:center;gap:8px;min-width:0;font-size:var(--t12)}
.colonias .cl-linha{flex:1;height:0;border-top:2px dashed var(--s4);min-width:24px}
.colonias .cl-linha.n1{border-top-color:#8a7a4a}.colonias .cl-linha.n2{border-top:2px solid #b8963a}.colonias .cl-linha.n3{border-top:3px solid var(--yellow)}
.colonias .cl-linha.falta{border-top-color:var(--red,#d9534f)}
.colonias .cl-req{margin:0;padding-left:18px;font-size:var(--t12);color:var(--text-2)}
.colonias .cl-acoes{display:flex;flex-wrap:wrap;gap:6px}
.colonias .cl-desc{font-size:var(--t12);color:var(--text-2);margin:0}
`;
function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.getElementById('cl-css')) return;
    document.head.appendChild(h('style', { id: 'cl-css' }, CSS));
  } catch { /* styles are progressive */ }
}

const num = (v) => Math.round(Number(v) || 0).toLocaleString('pt-BR');
const REGION = { lua: 'Lua', cislunar: 'Cislunar', marte: 'Marte', venus: 'Vênus', mercurio: 'Mercúrio', cinturao: 'Cinturão', jupiter: 'Júpiter', saturno: 'Saturno', externo: 'Sistema exterior', estelar: 'Outras estrelas' };
const STATUS = { active: '', allied: 'aliada', independent: 'independente' };
const ROUTE_LABEL = ['Sem rota', 'Mínima', 'Regular', 'Intensa'];

/** View model: the engine query, or the pure sim function when the module is not registered yet. */
export function colonyModel(store) {
  const v = store.tryQuery('colonies/view', null);
  if (v) return v;
  try { return simView(store.state, store.data); } catch { return null; }
}

/** Amber-dot badge for the drawer: open colony cards or a colony in trouble. Pure. */
export function coloniesBadge(st) {
  const cards = (st?.decisions || []).filter((d) => String(d?.kind || '').startsWith('colonies/')).length;
  if (cards) return cards;
  const list = Array.isArray(st?.colonies?.list) ? st.colonies.list : [];
  return list.some((c) => c && c.ownerId === st.playerId && c.status === 'active' && (c.welfare ?? 100) < 45) ? true : 0;
}

function act(store, container, route, action, okText) {
  const r = store.dispatch(action);
  if (r?.ok) { if (okText) toast(typeof okText === 'function' ? okText(r) : okText, 'good'); rerender(container, render, store, route); } else toast(r?.error || 'Não foi possível.', 'bad');
  return r;
}

function stageTrack(v, stage, { labels = false } = {}) {
  const steps = (v.stages || []).map((s) => h('span', { class: ['cl-passo', s.n < stage && 'feito', s.n === stage && 'agora'], title: s.label }));
  const track = h('div', { class: 'cl-trilha', role: 'img', 'aria-label': `Estágio ${stage} de 6: ${(v.stages || []).find((s) => s.n === stage)?.label || ''}` }, steps);
  if (!labels) return track;
  return h('div', null, track, h('div', { class: 'cl-trilha-rot', 'aria-hidden': 'true' }, (v.stages || []).map((s) => h('span', { class: s.n === stage ? 'agora' : null }, s.short || s.label))));
}

const tone = (x) => (x == null ? '' : x < 40 ? 'bad' : x < 60 ? 'warn' : 'good');

function colonyCardEl(store, v, c) {
  const st = store.state;
  const status = STATUS[c.status] ? chip(STATUS[c.status], c.status === 'allied' ? 'info' : 'muted') : null;
  return h('button', { class: 'cl-card', type: 'button', onclick: () => store.ui?.navigate?.('colonias', c.id) },
    h('div', { class: 'cl-top' }, h('span', { class: 'cl-nome' }, c.name), h('span', { class: 'cl-num' }, `${num(c.population)} hab.`)),
    h('div', { class: 'cl-sub' }, `${c.place} · ${c.stageLabel}${c.stellar && c.ly ? ` · ${String(c.ly).replace('.', ',')} anos-luz` : ''}`),
    stageTrack(v, c.stage),
    c.status === 'active' ? h('div', { class: 'cl-barras' },
      bar(c.welfare, { label: `Bem-estar ${Math.round(c.welfare ?? 0)}`, kind: tone(c.welfare), key: `col.${c.id}.wf` }),
      bar(c.opinion, { label: `Opinião ${c.opinion}`, kind: tone(c.opinion), key: `col.${c.id}.op` })) : null,
    h('div', { class: 'cl-chips' },
      status,
      c.status === 'active' && !c.stellar ? chip(c.supplied ? `rota ${ROUTE_LABEL[c.route].toLowerCase()}` : 'faltando suprimento', c.supplied ? 'muted' : 'bad') : null,
      c.status === 'active' && c.stellar ? chip(`reserva ${Math.round(c.reserve / 52)} anos`, 'muted') : null,
      c.upgrade?.ok ? chip('pronta para crescer', 'warn') : null,
      c.card ? chip('responder', 'warn') : null,
      c.incomeM > 0 ? chip(`+${fmtMoney(c.incomeM)}/ano`, 'good') : null,
      st && c.project ? chip(`obra: ${c.project.label}`, 'info') : null));
}

function siteRow(store, container, route, v, s) {
  const st = store.state;
  const know = s.own ? chip('reconhecido por você', 'good') : s.known ? chip('conhecido', 'muted') : chip('não sondado', 'muted');
  const when = s.stellar ? `${String(s.ly).replace('.', ',')} anos-luz · viagem de ${Math.round((s.weeks || 0) / 52)} anos` : `viagem de ${s.weeks} semana${s.weeks === 1 ? '' : 's'}`;
  const found = () => confirmDialog(`${s.name}: a fundação custa ${fmtMoney(s.costM)} e a viagem leva ${s.stellar ? `${Math.round(s.weeks / 52)} anos` : `${s.weeks} semanas`}. A chance de ${s.stellar ? 'a nave chegar inteira' : 'o comboio chegar inteiro'} depende do risco do local (${Math.round(s.risk * 100)}%)${s.own ? ', que cai porque você o reconheceu' : ''}.`, { okLabel: s.stellar ? 'Lançar a nave-semente' : 'Mandar o comboio', title: 'Fundar uma colônia' })
    .then((ok) => { if (ok) act(store, container, route, { type: 'colonies/found', siteId: s.id }, (r) => `A caminho: chega em ${fmtMonth(r.arriveTurn, st.startYear)}.`); });
  const survey = () => act(store, container, route, { type: 'colonies/survey', siteId: s.id }, (r) => `Sonda lançada: chega em ${fmtMonth(r.arriveTurn, st.startYear)}.`);
  const buttons = [];
  if (s.canFound) buttons.push(button(`Fundar · ${fmtMoney(s.costM)}`, found, { small: true, kind: 'primary', icon: 'alvo', iconSize: 16 }));
  if (s.canSurvey) buttons.push(button(`Sondar · ${fmtMoney(s.surveyCostM)}`, survey, { small: true, icon: 'info', iconSize: 16 }));
  const why = !s.canFound ? (s.probe != null ? `Sonda chega em ${fmtMonth(s.probe, st.startYear)}.` : s.reason) : null;
  return h('div', { class: 'cl-card' },
    h('div', { class: 'cl-top' }, h('span', { class: 'cl-nome' }, s.name), h('span', { class: 'cl-num' }, s.open ? when : `a partir de ${s.fromYear}`)),
    h('p', { class: 'cl-desc' }, s.desc || ''),
    h('div', { class: 'cl-chips' }, know, chip(`até ${s.maxStageLabel.toLowerCase()}`, 'muted'), s.occupied ? chip(`${s.occupied} colônia${s.occupied > 1 ? 's' : ''} ali`, 'info') : null,
      s.survey?.year ? chip(`${s.survey.by}, ${s.survey.year}`, 'muted') : null),
    buttons.length ? h('div', { class: 'cl-acoes' }, buttons) : null,
    why ? h('p', { class: 'cl-desc' }, why) : null);
}

let siteFilter = 'solar';

function renderList(container, store, route, v) {
  const st = store.state;
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  const cards = (st.decisions || []).filter((d) => String(d.kind || '').startsWith('colonies/'));
  const primary = cards.length ? { label: cards.length > 1 ? `Responder às ${cards.length} colônias` : `Responder: ${cards[0].title}`, icon: 'alerta', onClick: () => openDecision(store, cards[0].id) }
    : !v.colonies.length && v.unlocked ? { label: 'Escolher o primeiro local', icon: 'alvo', onClick: () => container.querySelector('#cl-locais')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } : null;
  const live = v.colonies.filter((c) => c.status === 'active' || c.status === 'allied');
  const sites = v.sites.filter((s) => (siteFilter === 'estelar' ? s.stellar : !s.stellar));
  const hasStellar = v.sites.some((s) => s.stellar && (s.open || s.canSurvey || s.known));
  container.appendChild(h('div', { class: 'view-pad tela colonias' },
    screenHead({ title: 'Colônias', lead: live.length ? `${live.length} de ${v.totals.cap} · ${num(v.totals.population)} habitantes` : 'Do posto avançado ao mundo independente', primary }),
    !v.unlocked ? note(`As colônias começam em ${v.unlockYear}. Até lá, as sondas reconhecem os lugares.`, { icon: 'relogio' }) : null,
    live.length ? kpis([
      { label: 'Habitantes', value: num(v.totals.population), sub: `${live.length} colônia${live.length > 1 ? 's' : ''}` },
      { label: 'Renda por ano', value: fmtMoney(v.totals.incomeM), tone: v.totals.incomeM > 0 ? 'up' : '', sub: 'impostos e trocas' },
      { label: 'Custo por ano', value: fmtMoney(v.totals.upkeepM), tone: v.totals.upkeepM > v.totals.incomeM ? 'down' : '', sub: 'operação e rotas' },
      v.frontier.reachLy > 0 ? { label: 'Fronteira', value: `${num(v.frontier.reachLy)} a.l.`, sub: `${num(v.frontier.worlds)} mundos habitados` } : null,
    ], { label: 'Números das colônias' }) : null,
    section('Suas colônias', { right: countChip(v.colonies.length) },
      v.colonies.length ? h('div', { class: 'cl-barras' }, v.colonies.map((c) => colonyCardEl(store, v, c))) : emptyState('Nenhuma colônia ainda. Escolha um local abaixo e mande o primeiro comboio.', 'alvo')),
    v.transit.filter((t) => t.mine).length || v.probes.length ? section('A caminho', {},
      listCard([
        ...v.transit.filter((t) => t.mine).map((t) => listRow({ title: t.name, sub: `${t.stellar ? 'Nave-semente' : 'Comboio'} para ${t.siteName}`, meta: fmtMonth(t.arriveTurn, st.startYear) })),
        ...v.probes.map((p) => listRow({ title: 'Sonda de reconhecimento', sub: v.sites.find((s) => s.id === p.siteId)?.name || p.siteId, meta: fmtMonth(p.arriveTurn, st.startYear) })),
      ])) : null,
    v.routes.filter((r) => r.ownerId === st.playerId).length ? section('Linhas de suprimento', { right: linkButton('Mapa', () => nav('mapa')) },
      h('div', { class: 'cl-card' }, v.routes.filter((r) => r.ownerId === st.playerId).map((r) => h('div', { class: 'cl-rota' },
        h('span', null, 'Terra'), h('span', { class: ['cl-linha', `n${r.level}`, !r.supplied && 'falta'], 'aria-hidden': 'true' }),
        h('span', { class: 'cl-nome' }, r.name), h('span', { class: 'cl-num' }, `${r.weeks} sem · risco ${Math.round(r.risk * 100)}%`))))) : null,
    section('Para onde ir', { id: 'cl-locais' },
      hasStellar ? pills([{ id: 'solar', label: 'Sistema Solar' }, { id: 'estelar', label: 'Outras estrelas' }], siteFilter, (id) => { siteFilter = id; rerender(container, render, store, route); }, { label: 'Região dos locais' }) : null,
      h('div', { class: 'cl-barras' }, sites.map((s) => siteRow(store, container, route, v, s)))),
    v.rivals.length ? section('Colônias dos outros', { right: countChip(v.rivals.length) },
      listCard(v.rivals.map((c) => {
        const a = st.actors?.[c.ownerId] || st.actors?.[c.founderId];
        return listRow({ title: c.name, sub: `${c.place} · ${c.stageLabel}${STATUS[c.status] ? ` (${STATUS[c.status]})` : ''}`, meta: `${num(c.population)} hab.`, extra: a ? h('span', { class: 'pn-sub' }, a.short || a.name) : null });
      }))) : null,
    v.past.length ? section('Memória', {}, listCard(v.past.map((p) => listRow({ title: p.name, sub: `${p.place} · ${p.cause}`, meta: String(p.year) })))) : null));
}

/**
 * The colony's physical base (MISSIONS-V2 §3.7: colony.assetId ↔ asset.colonyId): modules, vehicles, supply, with a
 * link to Infraestrutura. Null when the colony has no base asset (or infra is not loaded).
 */
export function baseLink(store, c) {
  const raw = (store.state?.colonies?.list || []).find((x) => x && x.id === c.id) || {};
  const assetId = c.assetId || raw.assetId || null;
  let a = null;
  try { a = assetViews(store).find((x) => x.id === assetId || (x.colonyId && x.colonyId === c.id)) || null; } catch { a = null; }
  if (!a) return null;
  const parts = [`${a.modulesN} módulo${a.modulesN === 1 ? '' : 's'}`, a.vehiclesN ? `${a.vehiclesN} veículo${a.vehiclesN === 1 ? '' : 's'}` : null,
    Number.isFinite(a.supplyWeeks) ? `suprimentos para ${a.supplyWeeks} semana${a.supplyWeeks === 1 ? '' : 's'}` : null].filter(Boolean);
  return section('Base física', {}, listCard([listRow({
    lead: '🏗️', title: a.name, sub: parts.join(' · '), meta: `saúde ${Math.round(a.health)}`,
    onClick: () => store.ui?.navigate?.('infra', `a/${a.id}`),
  })]), note('Módulos de base enviados por missões de Carga viram obras da colônia; sem suprimentos, a vida da colônia sofre.', { icon: 'info' }));
}

function renderDetail(container, store, route, v, c) {
  const st = store.state;
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  const a = (action, ok) => act(store, container, route, { ...action, colonyId: c.id }, ok);
  const mine = c.mine && c.status === 'active';
  const up = c.upgrade;
  const primary = c.card ? { label: 'Responder à colônia', icon: 'alerta', onClick: () => openDecision(store, c.card) }
    : up?.ok && !up.auto ? { label: `Virar ${up.next.label.toLowerCase()} · ${fmtMoney(up.costM)}`, icon: 'mais', onClick: () => a({ type: 'colonies/upgrade' }, `${c.name} cresceu.`) } : null;
  const needRows = c.needs.map((n) => h('div', { class: 'cl-need' },
    h('div', { class: 'cl-need-txt' }, h('span', { class: 'cl-nome' }, n.label), h('span', { class: 'cl-num' }, `nível ${n.level}${n.bonus ? ` +${n.bonus} do local` : ''} · ${Math.round(n.value ?? 0)}`)),
    mine ? button(`+1 · ${fmtMoney(n.costM)}`, () => a({ type: 'colonies/invest', need: n.id }, (r) => `Obra pronta em ${fmtMonth(r.readyTurn, st.startYear)}.`), { small: true }) : h('span'),
    h('div', { class: 'cl-need-bar' }, bar(n.value, { kind: tone(n.value), key: `col.${c.id}.${n.id}`, label: n.label })),
    n.pending.length ? h('small', null, `Obra pronta em ${fmtMonth(n.pending[0], st.startYear)}${n.pending.length > 1 ? ` (+${n.pending.length - 1})` : ''}`) : null));
  const routeCtl = mine && !c.stellar ? h('div', { class: 'cl-card' },
    segmented([0, 1, 2, 3].slice(0, (v.maxRoute ?? 3) + 1).map((i) => ({ id: String(i), label: ROUTE_LABEL[i] })), String(c.route), (id) => a({ type: 'colonies/route', level: Number(id) }, (r) => `Rota ajustada: ${fmtMoney(r.yearlyM)} por ano.`)),
    h('p', { class: 'cl-desc' }, `Custo da rota: ${fmtMoney(c.routeYearM)} por ano · reserva de ${c.reserve} semanas · ${c.supplied ? 'a colônia recebe o que precisa' : 'falta suprimento: o bem-estar cai'}.`)) : null;
  const taxCtl = mine && c.stage >= 4 ? h('div', { class: 'cl-card' },
    segmented(v.taxes.map((t) => ({ id: t.id, label: t.label })), c.tax, (id) => a({ type: 'colonies/tax', tax: id }, 'Impostos ajustados.')),
    h('p', { class: 'cl-desc' }, c.charter ? 'A carta de autonomia limita o imposto ao leve.' : 'Mais imposto rende mais, mas a opinião da colônia cai.')) : null;
  container.appendChild(h('div', { class: 'view-pad tela colonias' },
    h('div', { class: 'cl-acoes' }, linkButton('Todas as colônias', () => nav('colonias'), { arrow: false })),
    screenHead({ title: c.name, lead: `${c.siteName} · ${c.stageLabel}${STATUS[c.status] ? ` (${STATUS[c.status]})` : ''}`, primary }),
    stageTrack(v, c.stage, { labels: true }),
    c.stageDesc ? h('p', { class: 'cl-desc' }, c.stageDesc) : null,
    baseLink(store, c),
    kpis([
      { label: 'População', value: num(c.population), sub: c.housing ? `moradia para ${num(c.housing)}` : '' },
      { label: 'Bem-estar', value: String(Math.round(c.welfare ?? 0)), tone: c.welfare < 45 ? 'down' : '', sub: c.supplied ? 'com suprimento' : 'falta suprimento' },
      { label: 'Opinião', value: String(c.opinion), tone: c.opinion < 40 ? 'down' : c.opinion >= 65 ? 'up' : '', sub: c.opinionTarget != null ? `tende a ${c.opinionTarget}` : '' },
      { label: 'Autossuficiência', value: `${Math.round((c.autonomy ?? 0) * 100)}%`, sub: c.stellar ? 'longe demais para rotas' : 'o resto vem da Terra' },
    ], { label: 'Números da colônia' }),
    c.status === 'allied' ? note('Mundo soberano aliado: governa-se sozinho e divide as trocas com a agência.', { kind: 'ok' }) : null,
    c.status === 'independent' ? note('Mundo independente: a agência que a fundou é lembrada, mas não manda mais.', { icon: 'info' }) : null,
    c.status === 'active' ? section('Necessidades', {}, h('div', { class: 'cl-card' }, needRows),
      mine ? note(c.stellar ? `Os projetos viajam à velocidade da luz: cada obra leva ${Math.round(c.investWeeks / 52)} anos para ficar pronta.` : 'Cada obra fica pronta em um trimestre. Autossuficiência alta reduz o custo de operação.') : null) : null,
    routeCtl ? section('Linha de suprimento', {}, routeCtl) : null,
    taxCtl ? section('Impostos', {}, taxCtl) : null,
    mine && up && up.next ? section(`Próximo estágio: ${up.next.label}`, {},
      h('div', { class: 'cl-card' },
        up.auto ? h('p', { class: 'cl-desc' }, 'Acontece sozinho quando a colônia estiver pronta:') : null,
        up.reasons.length ? h('ul', { class: 'cl-req' }, up.reasons.map((r) => h('li', null, r))) : h('p', { class: 'cl-desc' }, up.auto ? 'Tudo pronto: acontece no próximo ano.' : 'Tudo pronto.'),
        !up.auto ? button(`Virar ${up.next.label.toLowerCase()} · ${fmtMoney(up.costM)}`, () => a({ type: 'colonies/upgrade' }, `${c.name} cresceu.`), { small: true, kind: up.ok ? 'primary' : '', disabled: !up.ok }) : null)) : null,
    mine && c.stage >= 5 ? note('Cidades-estado acabam pedindo um referendo. Opinião alta permite negociar uma aliança em vez de perder a colônia.', { icon: 'alerta' }) : null,
    mine && (c.projects.length || c.project) ? section('Grandes projetos', {},
      c.project ? h('div', { class: 'cl-card' }, h('div', { class: 'cl-top' }, h('span', { class: 'cl-nome' }, c.project.label), h('span', { class: 'cl-num' }, `pronto em ${fmtMonth(c.project.doneTurn, st.startYear)}`))) : null,
      ...c.projects.filter((p) => !(c.project && c.project.id === p.id)).map((p) => h('div', { class: 'cl-card' },
        h('div', { class: 'cl-top' }, h('span', { class: 'cl-nome' }, p.label), h('span', { class: 'cl-num' }, p.done ? 'concluído' : `${p.years} anos`)),
        h('p', { class: 'cl-desc' }, p.desc || ''),
        p.done ? null : p.ok ? button(`Começar · ${fmtMoney(p.costM)}`, () => a({ type: 'colonies/project', projectId: p.id }, 'Obra começou.'), { small: true }) : h('p', { class: 'cl-desc' }, p.reason)))) : null,
    mine ? section('Encerrar', {}, h('div', { class: 'cl-card' },
      h('p', { class: 'cl-desc' }, 'Trazer os colonos de volta encerra a colônia. O apoio em casa cai.'),
      button('Evacuar a colônia', () => confirmDialog(`Evacuar ${c.name}? ${num(c.population)} pessoas voltam e a colônia deixa de existir.`, { okLabel: 'Evacuar', danger: true, title: 'Evacuar' })
        .then((ok) => { if (ok) { const r = store.dispatch({ type: 'colonies/abandon', colonyId: c.id }); if (r?.ok) { toast(`${c.name} foi evacuada.`, 'info'); nav('colonias'); } else toast(r?.error || 'Não foi possível.', 'bad'); } }), { small: true, kind: 'danger' }))) : null));
}

export function render(container, store, route) {
  ensurePainelCss();
  ensureCss();
  const v = colonyModel(store);
  if (!v || !v.active) {
    container.appendChild(h('div', { class: 'view-pad tela colonias' },
      screenHead({ title: 'Colônias', lead: 'Do posto avançado ao mundo independente' }),
      emptyState(v ? `Nesta partida não há colônias. Na campanha elas começam em ${v.unlockYear}.` : 'As colônias ainda não estão disponíveis.', 'alvo')));
    return;
  }
  const sub = String(route?.sub || '');
  const c = sub ? v.colonies.find((x) => x.id === sub) : null;
  if (c) renderDetail(container, store, route, v, c);
  else renderList(container, store, route, v);
}

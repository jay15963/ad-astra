// Finanças (EXPANSION.md §12, drawer › Agência): cash, runway, cash flow year by year, spending by area, investor
// money (state.cap of the Phase B investors: stakes, capital raised, dividends) and the ledger.
// financeModel() is pure (tests); render() draws it with the shared screen layout.
import { h, raw, button, linkButton, bar, sparkline, fmtMoney, fmtMoneyDelta, fmtMonth, fmtPct, toast, confirmDialog } from './components.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss, openDecision } from './decisions.js';
import { screenById, isAvailable } from './screens.js';
import { screenHead, section, kpis, pills, listCard, note, countChip, rerender } from './screen-kit.js';

export const CATEGORY_LABELS = {
  missions: 'Missões', research: 'Pesquisa', crew: 'Equipe', facilities: 'Instalações', contracts: 'Contratos',
  diplomacy: 'Diplomacia', grants: 'Verba e repasses', investors: 'Investidores', dividends: 'Dividendos',
};
const HOLDER_KIND = { government: 'Governo', founders: 'Fundadores', fund: 'Fundo', corporation: 'Empresa', consortium: 'Consórcio', colony: 'Colônia' };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Pure model. q(name, fallback, ...args) = store.tryQuery.
 * {cash, budget, weeklyNet, runway, debtWeeks, fundsIn, flow:[{year, income, spent, net, partial}], flowMax,
 *  areas:[{id,label,value}] (spending of openYear — the finance year still open; openPartial = it is the current year), investors: null|{playerPct, investorsPct, autonomy, holders, valuationM, raisedM,
 *  inYear, dividendsYear}, ledger:[{turn, amount, label, category}], offer: decision|null, trouble}
 */
export function financeModel(state, data, q = () => null) {
  const st = state || {};
  const me = st.actors?.[st.playerId] || {};
  const f = st.finance || {};
  const s = q('budget/summary', null) || {};
  const cash = num(s.cash ?? me.cash);
  const budget = num(s.budget ?? me.budget);
  const weeklyNet = Number.isFinite(s.weeklyNet) ? s.weeklyNet : num(s.weeklyIncome) - num(s.weeklyCost);
  const runway = Number.isFinite(s.runwayWeeks) ? Math.max(0, Math.round(s.runwayWeeks)) : null;
  const year = (st.startYear ?? 0) + Math.floor((st.turn ?? 0) / 52);
  const hist = (Array.isArray(s.history) ? s.history : Array.isArray(f.history) ? f.history : []).filter((x) => x && Number.isFinite(x.year));
  const flow = hist.slice(-7).map((x) => ({ year: x.year, income: num(x.income), spent: num(x.spent), net: num(x.net ?? (num(x.income) - num(x.spent))), partial: false, decade: !!x.decade }));
  const yIncome = num(s.yearIncome ?? f.year?.income);
  const yByCat = s.spentByCategory || f.year?.spent || {};
  const ySpent = Number.isFinite(s.yearSpent) ? s.yearSpent : Object.values(yByCat).reduce((a, v) => a + num(v), 0);
  // The open finance year is closed by budget.tick during the step AFTER the one that lands on a new year (the
  // window [prev, prev+dt) only reaches turn 52k next step). Until then finance.year still holds the year that just
  // ended: label it with its own year (complete, no "*"), never as the current year "até agora".
  const openYear = Number.isFinite(f.year?.year) ? f.year.year : year;
  const openPartial = openYear >= year;
  if (!flow.some((x) => x.year === openYear && !x.decade)) {
    flow.push({ year: openYear, income: yIncome, spent: ySpent, net: yIncome - ySpent, partial: openPartial });
  }
  const flowMax = Math.max(1, ...flow.map((x) => Math.max(Math.abs(x.income), Math.abs(x.spent))));
  const areas = Object.entries(yByCat).map(([id, v]) => ({ id, label: CATEGORY_LABELS[id] || id, value: Math.abs(num(v)) }))
    .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);

  let ledger = q('budget/ledger', null, 40);
  if (!Array.isArray(ledger)) ledger = (f.ledger || []).slice(-40).reverse();
  ledger = ledger.filter(Boolean).map((e) => ({ turn: e.turn, amount: num(e.amount), category: e.category, label: e.note || e.label || CATEGORY_LABELS[e.category] || e.category || '' }));

  let investors = null;
  const cap = st.cap && typeof st.cap === 'object' ? st.cap : null;
  if (cap) {
    const holders = (Array.isArray(cap.holders) ? cap.holders : []).filter((x) => x && num(x.pct) > 0)
      .map((x) => ({ id: x.id, name: x.name || HOLDER_KIND[x.kind] || 'Investidor', kind: x.kind, kindLabel: HOLDER_KIND[x.kind] || 'Investidor', pct: num(x.pct), mood: Number.isFinite(x.mood) ? x.mood : null, emblem: x.emblem || null }))
      .sort((a, b) => b.pct - a.pct);
    const playerPct = Number.isFinite(cap.playerPct) ? cap.playerPct : Math.max(0, 100 - holders.reduce((a, x) => a + x.pct, 0));
    const capHist = Array.isArray(cap.history) ? cap.history : [];
    const yearOfTurn = (t) => (st.startYear ?? 0) + Math.floor(num(t) / 52);
    const inYear = (f.ledger || []).filter((e) => e?.category === 'investors' && yearOfTurn(e.turn) === year).reduce((a, e) => a + num(e.amount), 0);
    const dividendsYear = (f.ledger || []).filter((e) => e?.category === 'dividends' && yearOfTurn(e.turn) === year).reduce((a, e) => a + num(e.amount), 0);
    investors = {
      playerPct, investorsPct: Math.max(0, 100 - playerPct), autonomy: playerPct >= 50, holders,
      valuationM: Number.isFinite(cap.valuationM) ? cap.valuationM : null,
      raisedM: capHist.reduce((a, x) => a + num(x?.raisedM), 0), inYear, dividendsYear,
    };
  }
  const offer = (st.decisions || []).find((d) => /^investors\//.test(String(d?.kind || ''))) || null;
  const trouble = cash < 0 || (runway != null && runway < 26);
  return { year, openYear, openPartial, cash, budget, weeklyNet, runway, debtWeeks: num(s.debtWeeks ?? f.debtWeeks), fundsIn: num(s.fundsAvailableIn), flow, flowMax, areas, investors, ledger, offer, trouble, kind: me.kind };
}

let ledgerFilter = 'tudo';

function askFunds(store, container, route) {
  return async () => {
    const ok = await confirmDialog('O governo libera cerca de 6% da verba anual, mas o apoio cai e a reputação sofre.', { okLabel: 'Pedir verba', title: 'Verba emergencial' });
    if (!ok) return;
    const res = store.dispatch({ type: 'budget/requestFunds' });
    if (res?.ok) { toast(`Verba emergencial: ${fmtMoney(res.amount)}.`, 'good'); rerender(container, render, store, route); } else toast(res?.error || 'O pedido não foi aceito.', 'bad');
  };
}

export function render(container, store, route) {
  ensurePainelCss();
  const st = store.state;
  const me = st.actors?.[st.playerId] || {};
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  const m = financeModel(st, store.data, (n, fb, ...a) => store.tryQuery(n, fb, ...a));
  const funds = askFunds(store, container, route);

  let primary = null;
  if (m.offer) primary = { label: 'Ver a oferta dos investidores', icon: 'acoes', onClick: () => openDecision(store, m.offer.id) };
  else if (m.trouble) {
    primary = m.fundsIn > 0
      ? { label: 'Pedir verba emergencial', icon: 'caixa', disabled: true, note: `Novo pedido possível em ${m.fundsIn} semana${m.fundsIn === 1 ? '' : 's'}.` }
      : { label: 'Pedir verba emergencial', icon: 'caixa', onClick: funds, note: 'Custa apoio do governo e reputação.' };
  }
  const netTone = m.weeklyNet > 0 ? 'up' : m.weeklyNet < 0 ? 'down' : '';
  const series = typeof store.series === 'function' ? store.series('cash', 20) : [];

  const flowRows = m.flow.map((x) => h('div', { class: ['fluxo-ano', x.partial && 'parcial'] },
    h('span', { class: 'fluxo-rotulo mono' }, x.partial ? `${x.year}*` : String(x.year)),
    h('span', { class: 'fluxo-barras', 'aria-hidden': 'true' },
      h('span', { class: 'fluxo-barra entra', style: `width:${Math.round((Math.abs(x.income) / m.flowMax) * 100)}%` }),
      h('span', { class: 'fluxo-barra sai', style: `width:${Math.round((Math.abs(x.spent) / m.flowMax) * 100)}%` })),
    h('span', { class: ['fluxo-saldo mono', x.net >= 0 ? 'up' : 'down'], 'aria-label': `${x.year}: entrou ${fmtMoney(x.income)}, saiu ${fmtMoney(x.spent)}` }, fmtMoneyDelta(Math.round(x.net)) || fmtMoney(0))));

  const inv = m.investors;
  const ledgerShown = m.ledger.filter((e) => (ledgerFilter === 'entradas' ? e.amount > 0 : ledgerFilter === 'saidas' ? e.amount < 0 : true)).slice(0, 20);

  container.appendChild(h('div', { class: 'view-pad tela financas' },
    screenHead({ title: 'Finanças', lead: `${me.short || me.name || ''} · ano de ${m.year}`, primary }),
    kpis([
      { label: 'Caixa', value: fmtMoney(m.cash), tone: m.cash < 0 ? 'down' : '', wide: true, spark: series?.length > 1 ? sparkline(series, { w: 84, h: 26, cls: m.cash < 0 ? 'bad' : '' }) : null,
        sub: m.debtWeeks > 0 ? `${m.debtWeeks} semana${m.debtWeeks === 1 ? '' : 's'} no vermelho` : `Verba anual ${fmtMoney(m.budget)}` },
      { label: 'Saldo por semana', value: fmtMoneyDelta(Math.round(m.weeklyNet * 10) / 10) || fmtMoney(0), tone: netTone, sub: m.weeklyNet >= 0 ? 'entra mais do que sai' : 'gastando a reserva' },
      { label: 'Fôlego', value: m.runway != null ? `${m.runway} sem` : 'folgado', tone: m.runway != null && m.runway < 12 ? 'down' : '', sub: m.runway != null ? 'até o caixa acabar' : 'o caixa não está caindo' },
    ], { label: 'Números das finanças' }),
    section('Fluxo de caixa', { right: h('span', { class: 'fluxo-legenda' }, h('i', { class: 'entra' }), 'entrou', h('i', { class: 'sai' }), 'saiu') },
      h('div', { class: 'pn-card fluxo' }, flowRows, m.openPartial ? h('p', { class: 'fluxo-nota' }, `* ${m.openYear} até agora`) : h('p', { class: 'fluxo-nota' }, `${m.year} acabou de começar: ainda sem lançamentos no ano.`))),
    section(m.openPartial ? 'Gasto no ano por área' : `Gasto em ${m.openYear} por área`, {},
      m.areas.length ? h('div', { class: 'pn-card pn-bars' }, m.areas.map((a) => bar(a.value, { max: m.areas[0].value, label: `${a.label} · ${fmtMoney(a.value)}`, key: `fin.area.${a.id}` }))) : note('Nenhum gasto lançado neste ano.')),
    inv ? section('Dinheiro de investidores', { right: isAvailable(screenById('conselho'), st, store.data) ? linkButton('Conselho', () => nav('conselho')) : null },
      h('div', { class: 'pn-card investidores' },
        h('div', { class: 'cota' },
          h('div', { class: 'cota-barra', role: 'img', 'aria-label': `Você tem ${fmtPct(inv.playerPct / 100)}; investidores ${fmtPct(inv.investorsPct / 100)}` },
            h('span', { class: 'cota-sua', style: `width:${Math.round(inv.playerPct)}%` })),
          h('div', { class: 'cota-legenda' },
            h('span', null, h('b', { class: 'mono' }, fmtPct(inv.playerPct / 100)), ' sua'),
            h('span', null, h('b', { class: 'mono' }, fmtPct(inv.investorsPct / 100)), ' investidores'))),
        h('div', { class: 'stat-grid' },
          stat('Captado no total', fmtMoney(inv.raisedM)),
          stat('Avaliação', inv.valuationM != null ? fmtMoney(inv.valuationM) : '—'),
          stat(`Aportes em ${m.year}`, fmtMoney(inv.inYear)),
          stat(`Dividendos em ${m.year}`, fmtMoney(Math.abs(inv.dividendsYear)))),
        note(inv.autonomy ? 'Com 50% ou mais você tem autonomia: pode recusar ou adiar uma missão de investidor.' : 'Abaixo de 50% as missões dos investidores são obrigatórias.', { kind: inv.autonomy ? '' : 'warn' })),
      inv.holders.length ? listCard(inv.holders.map((x) => listRow({
        lead: raw(emblemSVG(x.emblem && typeof x.emblem === 'object' ? { ...x, emblem: x.emblem } : { name: x.name, short: x.name, color: '#3a3f4a' }, { size: 30 })), leadCls: 'pn-emblem',
        title: x.name, sub: x.mood != null ? `${x.kindLabel} · humor ${Math.round(x.mood)}` : x.kindLabel, meta: fmtPct(x.pct / 100),
      }))) : null) : null,
    !m.trouble ? section('Verba extra', {},
      h('div', { class: 'pn-card verba-extra' },
        h('p', { class: 'pn-lead-text' }, 'Em aperto, dá para pedir uma verba emergencial ao governo. Ela custa apoio e reputação.'),
        button(m.fundsIn > 0 ? `Disponível em ${m.fundsIn} sem` : 'Pedir verba emergencial', funds, { small: true, disabled: m.fundsIn > 0, icon: 'caixa', iconSize: 16 }))) : null,
    section('Lançamentos contábeis', { right: countChip(m.ledger.length) },
      pills([{ id: 'tudo', label: 'Tudo' }, { id: 'entradas', label: 'Entradas' }, { id: 'saidas', label: 'Saídas' }], ledgerFilter,
        (id) => { ledgerFilter = id; rerender(container, render, store, route); }, { label: 'Filtrar lançamentos' }),
      ledgerShown.length ? h('ul', { class: 'ledger' }, ledgerShown.map((l) => h('li', null,
        h('span', { class: 'ledger-date' }, fmtMonth(l.turn, st.startYear)),
        h('span', { class: 'ledger-note' }, l.label),
        h('span', { class: ['ledger-amt', l.amount < 0 ? 'neg' : 'pos'] }, fmtMoneyDelta(l.amount))))) : note('Nada lançado ainda.'))));
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value));
}

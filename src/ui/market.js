// Mercado de foguetes (drawer › Operações; docs/MISSIONS-V2.md §8, R9). Two halves of one market:
//   · sell: the player's rockets, the interest of each agency (flights + reliability + price + relations), offers
//     to answer, the player's own offers, the price asked and the production line;
//   · buy: other operators' rockets and why each one is open or closed (treaty-gated, §8.1), with "Pedir contrato
//     de lançamento" where an agreement would open it.
// Reads query('market/view') (src/sim/market.js) and acts only through store.dispatch. Layout: screen-kit (title →
// one primary action → sections), DESIGN.md tokens, styles in css/market.css (linked once). Mobile-first: every
// row holds at 320 px (flex + min-width: 0 + ellipsis), steppers and buttons are 44 px.
import { h, raw, button, chip, bar, trend, fmtMoney, fmtMonth, toast, openModal, emptyState } from './components.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss, openDecision } from './decisions.js';
import { screenHead, section, kpis, listCard, note, countChip, pills, rerender } from './screen-kit.js';

function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-market-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/market.css', import.meta.url).href;
    l.dataset.marketCss = '1';
    document.head.appendChild(l);
  } catch { /* styles are progressive */ }
}

// ------------------------------------------------------------------ pure helpers (tested in Node)

export const CLASS_PT = { small: 'Leve', medium: 'Médio', heavy: 'Pesado', superheavy: 'Superpesado', sounding: 'Sondagem' };
export const VIA_PT = { market: 'Mercado aberto', launch_services: 'Contrato de lançamento', treaty: 'Acordo em vigor', bloc: 'Mesmo bloco', open: 'Liberado' };
export const pctText = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
/** Reliability: one decimal near the top (99,8% is not 100%). */
export function relText(p) {
  const x = (Number(p) || 0) * 100;
  return x >= 95 ? `${(Math.floor(x * 10) / 10).toFixed(1).replace('.', ',')}%` : `${Math.round(x)}%`;
}
/** A bar with an accessible name only (components.bar with `label` also prints the label). */
function meter(value, kind, name) {
  const b = bar(value, { kind });
  try { b.setAttribute('aria-label', name); } catch { /* Node */ }
  return b;
}
export const multText = (m) => `×${(Math.round((Number(m) || 0) * 100) / 100).toFixed(2).replace('.', ',')}`;
/** Interest words (0..100) for the buyer rows; the bar carries the number. */
export function interestWord(v) {
  const x = Number(v) || 0;
  if (x >= 75) return 'quer muito';
  if (x >= 55) return 'interessada';
  if (x >= 30) return 'observa';
  if (x >= 10) return 'pouco';
  return 'nenhum';
}
/** Rows of the "Comprar de outros" list for a filter ('ok' | 'locked'). */
export function buyFilter(rows, f) {
  const list = Array.isArray(rows) ? rows : [];
  return f === 'locked' ? list.filter((r) => !r.ok) : list.filter((r) => r.ok);
}

const actorOf = (st, id) => st?.actors?.[id] || { id, short: id, name: id };
const emblem = (st, id, size = 30) => {
  try { return raw(emblemSVG(actorOf(st, id), { size })); } catch { return null; }
};

// ------------------------------------------------------------------ local UI state (per session)

const UI = { buy: 'ok', open: null };

// ------------------------------------------------------------------ pieces

function offerCard(store, again, st, o) {
  const resolve = (choiceId) => {
    const r = store.dispatch({ type: 'decision/resolve', id: o.decisionId, choiceId });
    if (!r?.ok) { toast(r?.error || 'A oferta não está mais disponível.', 'bad'); again(); return; }
    if (r.status === 'accepted') toast(r.countered ? `${o.buyerName} aceitou a contraproposta.` : `Contrato fechado com ${o.buyerName}.`, 'good');
    else if (r.status === 'rejected') toast(`${o.buyerName} recusou a contraproposta.`, 'warn');
    else toast('Oferta recusada.', 'info');
    again();
  };
  const dec = (st.decisions || []).find((d) => d.id === o.decisionId);
  const preview = (id) => dec?.choices?.find((c) => c.id === id)?.preview || '';
  return h('article', { class: 'mk-card mk-oferta' },
    h('div', { class: 'mk-card-topo' },
      h('span', { class: 'mk-emb' }, emblem(st, o.buyerId, 36)),
      h('div', { class: 'mk-card-nome' }, h('b', null, `${o.buyerName} quer ${o.units} lançamentos`), h('span', null, o.vehicleName)),
      h('div', { class: 'mk-card-num' }, h('b', null, fmtMoney(o.priceM)), h('span', null, 'por voo'))),
    h('p', { class: 'mk-texto' }, preview('accept')),
    h('p', { class: 'mk-texto mk-muted' }, preview('counter')),
    h('div', { class: 'mk-botoes' },
      button('Vender', () => resolve('accept'), { kind: 'primary', small: true }),
      button(`Pedir ${fmtMoney(o.counterPrice)}`, () => resolve('counter'), { small: true }),
      button('Recusar', () => resolve('decline'), { kind: 'ghost', small: true })),
    o.expiresTurn != null ? h('p', { class: 'mk-rodape' }, `Vale até ${fmtMonth(o.expiresTurn, st.startYear)}.`) : null);
}

function priceStepper(store, again, v, s) {
  const set = (mult) => {
    const r = store.dispatch({ type: 'market/setPrice', vehicleId: s.vehicleId, mult });
    if (!r?.ok) toast(r?.error || 'Preço não mudou.', 'bad');
    again();
  };
  const step = 0.1;
  return h('div', { class: 'mk-preco' },
    h('div', { class: 'mk-preco-txt' }, h('span', { class: 'mk-eyebrow' }, 'Preço pedido'), h('b', null, fmtMoney(s.askPrice)), h('span', null, `${multText(s.mult)} do custo (${fmtMoney(s.costM)})`)),
    h('div', { class: 'mk-stepper', role: 'group', 'aria-label': `Preço do ${s.name}` },
      button('', () => set(s.mult - step), { icon: 'menos', title: 'Baixar o preço', disabled: s.mult - step < v.ask.min - 1e-9 }),
      h('span', { class: 'mk-stepper-val' }, multText(s.mult)),
      button('', () => set(s.mult + step), { icon: 'mais', title: 'Subir o preço', disabled: s.mult + step > v.ask.max + 1e-9 })));
}

function rocketCard(store, again, st, v, s) {
  const top = s.buyers.filter((b) => b.interest > 0).slice(0, 4);
  const open = UI.open === s.vehicleId;
  const shown = open ? s.buyers.filter((b) => b.interest > 0) : top;
  return h('article', { class: 'mk-card' },
    h('div', { class: 'mk-card-topo' },
      h('div', { class: 'mk-card-nome' }, h('b', null, s.name), h('span', null, `${CLASS_PT[s.class] || s.class}${s.design ? ' · projeto do Hangar' : ''}`)),
      chip(s.free ? 'produção livre' : `fila até ${fmtMonth(s.nextFreeTurn, st.startYear)}`, s.free ? 'muted' : 'warn')),
    h('dl', { class: 'mk-dados' },
      h('div', null, h('dt', null, 'Voos'), h('dd', null, String(s.flights))),
      h('div', null, h('dt', null, 'Confiab.'), h('dd', null, relText(s.rel))),
      h('div', null, h('dt', null, 'Produção'), h('dd', null, `${String(s.perYear).replace('.', ',')}/ano`)),
      h('div', null, h('dt', null, 'Reservados'), h('dd', null, String(s.used12m)))),
    priceStepper(store, again, v, s),
    shown.length ? h('div', { class: 'mk-interesse', role: 'list', 'aria-label': `Interesse no ${s.name}` },
      shown.map((b) => h('div', { class: 'mk-int-linha', role: 'listitem' },
        h('span', { class: 'mk-int-nome' }, b.name),
        meter(b.interest, b.interest >= v.minInterest ? 'good' : '', `Interesse de ${b.name}`),
        h('span', { class: 'mk-int-num' }, String(Math.round(b.interest))),
        trend(b.trend, { format: (d) => String(Math.round(d)) }))))
      : note('Ninguém pediu este foguete ainda. Voos com sucesso e um preço justo atraem compradores.'),
    h('div', { class: 'mk-botoes' },
      button('Oferecer a…', () => proposeSheet(store, again, st, v, s), { small: true, icon: 'transferir' }),
      s.buyers.filter((b) => b.interest > 0).length > 4 ? button(open ? 'Menos' : 'Todas as agências', () => { UI.open = open ? null : s.vehicleId; again(); }, { kind: 'ghost', small: true }) : null));
}

function proposeSheet(store, again, st, v, s) {
  const buyers = s.buyers.filter((b) => st.actors?.[b.buyerId]);
  if (!buyers.length) { toast('Nenhuma agência para oferecer.', 'info'); return; }
  const form = { buyerId: buyers[0].buyerId, units: 2, priceM: null };
  const refOf = (bid) => store.tryQuery('market/refPrice', null, s.vehicleId, bid) || s.askPrice || 1;
  form.priceM = Math.max(1, Math.round(refOf(form.buyerId)));
  openModal((close) => {
    const wrap = h('div', { class: 'mk-folha' });
    const paint = () => {
      wrap.innerHTML = '';
      const chance = store.tryQuery('market/proposeChance', 0, s.vehicleId, form.buyerId, form.priceM) || 0;
      const ref = refOf(form.buyerId);
      wrap.append(
        h('p', { class: 'mk-texto' }, `Ofereça lançamentos do ${s.name}. A resposta chega no próximo turno; preço acima do que a agência paga hoje (${fmtMoney(ref)}) derruba a chance.`),
        h('div', { class: 'mk-escolha', role: 'radiogroup', 'aria-label': 'Comprador' }, buyers.slice(0, 8).map((b) => h('button', {
          class: ['mk-opcao', b.buyerId === form.buyerId && 'ativa'], type: 'button', role: 'radio', 'aria-checked': b.buyerId === form.buyerId ? 'true' : 'false',
          onclick: () => { form.buyerId = b.buyerId; form.priceM = Math.max(1, Math.round(refOf(b.buyerId))); paint(); },
        }, h('span', { class: 'mk-emb' }, emblem(st, b.buyerId, 24)), h('span', { class: 'mk-opcao-nome' }, b.name), h('span', { class: 'mk-int-num' }, String(Math.round(b.interest)))))),
        h('div', { class: 'mk-linha' }, h('span', null, 'Lançamentos'),
          h('div', { class: 'mk-stepper' },
            button('', () => { form.units = Math.max(1, form.units - 1); paint(); }, { icon: 'menos', title: 'Menos lançamentos', disabled: form.units <= 1 }),
            h('span', { class: 'mk-stepper-val' }, String(form.units)),
            button('', () => { form.units = Math.min(v.maxUnits, form.units + 1); paint(); }, { icon: 'mais', title: 'Mais lançamentos', disabled: form.units >= v.maxUnits }))),
        h('div', { class: 'mk-linha' }, h('span', null, 'Preço por voo'),
          h('div', { class: 'mk-stepper' },
            button('', () => { form.priceM = Math.max(1, Math.round(form.priceM * 0.95)); paint(); }, { icon: 'menos', title: 'Baixar o preço' }),
            h('span', { class: 'mk-stepper-val' }, fmtMoney(form.priceM)),
            button('', () => { form.priceM = Math.max(form.priceM + 1, Math.round(form.priceM * 1.05)); paint(); }, { icon: 'mais', title: 'Subir o preço' }))),
        h('dl', { class: 'mk-resumo' },
          h('dt', null, 'Total'), h('dd', null, fmtMoney(form.priceM * form.units)),
          h('dt', null, 'Chance de aceitarem'), h('dd', null, pctText(chance))),
        button('Enviar oferta', () => {
          const r = store.dispatch({ type: 'market/propose', vehicleId: s.vehicleId, buyerId: form.buyerId, units: form.units, priceM: form.priceM });
          if (r?.ok) { toast(`Oferta enviada. Chance de ${pctText(r.chance)}.`, 'good'); close(); again(); } else toast(r?.error || 'Oferta não enviada.', 'bad');
        }, { kind: 'primary', big: true }));
    };
    paint();
    return wrap;
  }, { title: `Oferecer o ${s.name}` });
}

function contractRow(st, c) {
  const done = c.delivered + c.failed;
  const fails = c.failed ? ` · ${c.failed} falha${c.failed > 1 ? 's' : ''}` : '';
  return listRow({
    lead: emblem(st, c.buyerId, 30), leadCls: 'pn-emblem',
    title: `${c.vehicleName} para ${c.buyerName}`,
    sub: c.status === 'active'
      ? `${c.delivered}/${c.units} entregues${fails} · ${fmtMoney(c.priceM)} · próximo ${fmtMonth(c.nextTurn, st.startYear)}`
      : `${c.delivered}/${c.units} entregues${fails} · ${fmtMoney(c.priceM)} por voo`,
    extra: c.status === 'active' ? meter((done / Math.max(1, c.units)) * 100, c.failed ? 'warn' : '', `Andamento do contrato com ${c.buyerName}`) : null,
    right: chip(c.status === 'active' ? 'ativo' : c.status === 'done' ? 'cumprido' : 'cancelado', c.status === 'done' ? 'good' : c.status === 'cancelled' ? 'bad' : 'info'),
    cls: c.status === 'active' ? 'mine' : null,
  });
}

function buyRow(store, again, st, b) {
  const ask = () => {
    const r = store.dispatch({ type: 'market/requestAccess', vehicleId: b.vehicleId });
    if (r?.ok) {
      const s2 = r.status;
      toast(s2 === 'accepted' ? `${b.operatorName} aceitou: o ${b.name} está liberado.` : s2 === 'rejected' ? `${b.operatorName} recusou o contrato.` : `Pedido enviado a ${b.operatorName}.`, s2 === 'rejected' ? 'warn' : 'good');
    } else toast(r?.error || 'Pedido não enviado.', 'bad');
    again();
  };
  const right = b.ok
    ? chip(VIA_PT[b.via] || 'Liberado', b.via === 'launch_services' ? 'good' : 'muted')
    : b.pending ? chip('pedido enviado', 'info')
      : b.canRequest ? button('Pedir contrato', ask, { small: true }) : chip('fechado', 'bad');
  return listRow({
    lead: emblem(st, b.operator, 30), leadCls: 'pn-emblem',
    title: b.name,
    sub: `${b.operatorName} · ${CLASS_PT[b.class] || b.class} · ${fmtMoney(b.costM)}${b.priceMult && b.priceMult !== 1 ? ` ${multText(b.priceMult)}` : ''}`,
    extra: !b.ok && b.reason ? h('span', { class: 'mk-motivo' }, b.reason) : null,
    right,
  });
}

// ------------------------------------------------------------------ screen

export function render(container, store, route) {
  ensurePainelCss();
  ensureCss();
  const st = store.state;
  const root = h('div', { class: 'view-pad tela mercado' });
  container.appendChild(root);
  const again = () => rerender(container, render, store, route);
  const v = store.tryQuery('market/view', null);
  if (!v) {
    root.append(screenHead({ title: 'Mercado de foguetes', lead: 'Vender e comprar lançamentos' }), emptyState('O mercado de foguetes não está disponível nesta partida.', 'foguete'));
    return;
  }
  if (!v.active) {
    root.append(screenHead({ title: 'Mercado de foguetes', lead: 'Vender e comprar lançamentos' }),
      emptyState(Number.isFinite(v.unlockYear) ? `O mercado abre em ${v.unlockYear}. Até lá, cada agência voa só com o que tem.` : 'O mercado ainda não abriu.', 'foguete'));
    return;
  }
  const aiOffers = (v.offers || []).filter((o) => !o.fromPlayer && (st.decisions || []).some((d) => d.id === o.decisionId));
  const mine = (v.offers || []).filter((o) => o.fromPlayer);
  const active = (v.contracts || []).filter((c) => c.status === 'active');
  const past = (v.contracts || []).filter((c) => c.status !== 'active').reverse();
  const primary = aiOffers.length
    ? { label: aiOffers.length > 1 ? `Responder às ${aiOffers.length} ofertas` : `Responder à oferta de ${aiOffers[0].buyerName}`, icon: 'alerta', onClick: () => (aiOffers.length > 1 ? root.querySelector('#mk-ofertas')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) : openDecision(store, aiOffers[0].decisionId, { onResolved: again })) }
    : null;
  const buyList = buyFilter(v.buyable, UI.buy);
  const lockedN = (v.buyable || []).filter((b) => !b.ok).length;
  root.append(...[
    screenHead({ title: 'Mercado de foguetes', lead: 'Seus foguetes à venda e os dos outros', primary }),
    kpis([
      { label: 'Contratos', value: String(v.sales?.count ?? 0), sub: `${active.length} de ${v.maxContracts} em andamento` },
      { label: 'Receita', value: fmtMoney(v.sales?.revenueM ?? 0), sub: 'adiantamentos e entregas' },
      { label: 'Voos entregues', value: String(v.sales?.launches ?? 0), sub: 'contam no histórico do foguete' },
      { label: 'Foguetes à venda', value: String(v.sellables.length), sub: v.sellables.length ? 'próprios e do Hangar' : 'nenhum ainda' },
    ], { label: 'Números do mercado' }),
    aiOffers.length ? section('Ofertas recebidas', { id: 'mk-ofertas', right: countChip(aiOffers.length) }, ...aiOffers.map((o) => offerCard(store, again, st, o))) : null,
    mine.length ? section('Suas ofertas', { right: countChip(mine.length) },
      listCard(mine.map((o) => listRow({
        lead: emblem(st, o.buyerId, 30), leadCls: 'pn-emblem', title: `${o.vehicleName} para ${o.buyerName}`,
        sub: `${o.units} ${o.units === 1 ? 'lançamento' : 'lançamentos'} a ${fmtMoney(o.priceM)} · chance ${pctText(o.p)}`, right: chip('aguardando', 'info'), cls: 'wrap',
      })))) : null,
    section('Seus foguetes', { right: countChip(v.sellables.length) },
      v.sellables.length ? v.sellables.map((s) => rocketCard(store, again, st, v, s))
        : note('Você ainda não tem foguete para vender. Um projeto do Hangar em operação ou um foguete da sua agência em serviço entra aqui.'),
      v.sellables.length ? note(`Agências pedem para comprar quando o interesse passa de ${v.minInterest}. Mais voos, mais confiabilidade e preço justo aumentam o interesse; falhas e tensão derrubam.`) : null),
    active.length || past.length ? section('Contratos', { right: countChip(active.length) },
      listCard([...active, ...past.slice(0, 6)].map((c) => contractRow(st, c)))) : null,
    section('Comprar de outros', { right: countChip((v.buyable || []).length) },
      pills([{ id: 'ok', label: 'Liberados', count: (v.buyable || []).length - lockedN }, { id: 'locked', label: 'Fechados', count: lockedN }], UI.buy, (id) => { UI.buy = id; again(); }, { label: 'Filtro de foguetes' }),
      buyList.length ? listCard(buyList.slice(0, 30).map((b) => buyRow(store, again, st, b)))
        : note(UI.buy === 'ok' ? 'Nenhum foguete de outro operador liberado agora.' : 'Nenhum foguete fechado: você pode comprar todos os que estão em serviço.'),
      note('Foguetes de agências exigem um acordo (contrato de lançamento ou parceria) ou o mesmo bloco; os de empresas com venda aberta estão no mercado. Embargo e tensão alta fecham tudo.')),
  ].filter(Boolean));
}

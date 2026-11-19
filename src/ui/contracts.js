// Contratos (drawer › Operações, and Missões › Contratos): the tender board (docs/MISSIONS-V2.md §2.1).
//   · open tenders: client, what goes where, mass, deadline, when bidding closes, rivals and the favourite, and the
//     "Você consegue entregar?" check against the agency's rockets and research (green / amber / red + the reason);
//   · the bid sheet: pick the rocket you plan to fly, set a price between 60% and 140% of the client's reference and
//     watch the live chance to win, the probable cost and the margin;
//   · the agency's won contracts (pick the rocket, see the mission), recent results and the contract record.
// Reads query('contracts/board' | 'contracts/odds') from src/sim/missions.js and acts only through store.dispatch
// (contract/bid, contract/withdraw, contract/mission). Layout: screen-kit; styles in css/contracts.css (linked once).
// Mobile-first: every row holds at 320 px (flex + min-width 0), steppers and buttons are 44 px.
import { h, raw, button, chip, bar, fmtMoney, toast, openModal, emptyState } from './components.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { screenHead, section, kpis, listCard, note, countChip, pills, rerender } from './screen-kit.js';

function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-contracts-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/contracts.css', import.meta.url).href;
    l.dataset.contractsCss = '1';
    document.head.appendChild(l);
  } catch { /* styles are progressive */ }
}

// ------------------------------------------------------------------ pure helpers (tested in Node)

export const pctText = (p) => `${Math.round((Number(p) || 0) * 100)}%`;
/** Chance with one decimal below 10% ("3,4%"), never "0%" for a real chance. */
export function chanceText(p) {
  const x = (Number(p) || 0) * 100;
  if (x > 0 && x < 1) return '<1%';
  return x < 10 ? `${x.toFixed(1).replace('.', ',')}%` : `${Math.round(x)}%`;
}
export const FEAS_KIND = { ok: 'ok', warn: 'warn', bad: 'bad' };
export const FEAS_TITLE = { ok: 'Você consegue entregar', warn: 'Consegue, com ressalvas', bad: 'Você não consegue entregar' };
export const STATUS_PT = {
  awarded: 'ganho', late: 'atrasado', delivered: 'entregue', failed: 'falhou', defaulted: 'rompido', expired: 'sem propostas', closed: 'de outra agência',
};
/** Status chip of a result row: [text, kind]. */
export function resultChip(r) {
  if (r.status === 'closed') {
    if (r.ai && !r.ai.done) return [`${r.winnerName} voa`, 'info'];
    if (r.ai && r.ai.ok === false) return [`${r.winnerName} falhou`, 'bad'];
    return [`${r.winnerName} entregou`, 'muted'];
  }
  return [STATUS_PT[r.status] || r.status, r.status === 'delivered' ? 'good' : ['failed', 'defaulted'].includes(r.status) ? 'bad' : 'muted'];
}
/** "+US$ 24 mi (+38%)" / "−US$ 8 mi (−12%)" */
export function marginText(m, pctv) {
  if (m == null || !Number.isFinite(m)) return '—';
  const s = m >= 0 ? '+' : '−';
  return `${s}${fmtMoney(Math.abs(m))}${Number.isFinite(pctv) ? ` (${s}${Math.round(Math.abs(pctv) * 100)}%)` : ''}`;
}
/** Filter of the open tenders: 'all' | 'can' (not red) | 'bid' (with the agency's bid). */
export function tenderFilter(list, f) {
  const l = Array.isArray(list) ? list : [];
  if (f === 'can') return l.filter((t) => t.feas?.level !== 'bad');
  if (f === 'bid') return l.filter((t) => t.playerBid);
  return l;
}
const weeksText = (w) => (w <= 0 ? 'nesta semana' : w === 1 ? 'em 1 semana' : w < 9 ? `em ${w} semanas` : `em ${Math.round(w / 4.33)} meses`);

const actorOf = (st, id) => st?.actors?.[id] || null;
const emblem = (st, id, size = 30) => {
  const a = actorOf(st, id);
  if (!a) return null;
  try { return raw(emblemSVG(a, { size })); } catch { return null; }
};

// ------------------------------------------------------------------ local UI state (per session)

const UI = { filter: 'all' };

// ------------------------------------------------------------------ pieces

function feasBlock(f) {
  const kind = FEAS_KIND[f.level] || '';
  const extra = (f.reasons || []).filter((r) => r.text !== f.text).slice(0, 2);
  return h('div', { class: ['ct-feas', `ct-feas-${kind}`], role: 'note' },
    h('span', { class: 'ct-eyebrow' }, 'Você consegue entregar?'),
    h('b', { class: 'ct-feas-title' }, FEAS_TITLE[f.level] || ''),
    h('p', { class: 'ct-feas-text' }, f.text),
    extra.length ? h('ul', { class: 'ct-feas-more' }, extra.map((r) => h('li', { class: `ct-feas-li-${r.level}` }, r.text))) : null);
}

function tenderCard(store, again, st, v, t) {
  const fav = t.favourite;
  const bid = t.playerBid;
  const can = t.feas.level !== 'bad';
  return h('article', { class: ['ct-card', bid && 'mine'], 'data-tender': t.id },
    h('div', { class: 'ct-card-topo' },
      t.clientActorId ? h('span', { class: 'ct-emb' }, emblem(st, t.clientActorId, 34)) : null,
      h('div', { class: 'ct-card-nome' },
        h('span', { class: 'ct-eyebrow' }, `${t.clientKindLabel} · ${t.sizeLabel}`),
        h('b', null, t.title),
        h('span', null, t.client)),
      h('div', { class: 'ct-card-num' }, h('b', null, fmtMoney(t.refM)), h('span', null, 'referência'))),
    h('p', { class: 'ct-texto' }, t.what),
    h('dl', { class: 'ct-dados' },
      h('div', null, h('dt', null, 'Carga'), h('dd', null, t.payloadText || (t.type === 'crewed' ? 'tripulação' : '—'))),
      h('div', null, h('dt', null, 'Destino'), h('dd', null, t.destName)),
      h('div', null, h('dt', null, 'Lances até'), h('dd', null, t.closeText)),
      h('div', null, h('dt', null, 'Lançar até'), h('dd', null, t.deadlineText))),
    h('div', { class: 'chips ct-chips' },
      chip(t.subLabel ? `${t.typeLabel} · ${t.subLabel}` : t.typeLabel, 'muted'),
      chip(t.rivalsN ? `${t.rivalsN} concorrente${t.rivalsN === 1 ? '' : 's'}` : 'sem concorrentes', 'muted'),
      fav ? chip(`favorita: ${fav.name} (${pctText(fav.p)})`, fav.player ? 'accent' : 'muted') : null,
      chip(`fecha ${weeksText(t.closeWeeks)}`, t.closeWeeks <= 2 ? 'warn' : 'muted')),
    feasBlock(t.feas),
    bid ? h('div', { class: 'ct-lance' },
      h('span', { class: 'ct-eyebrow' }, 'Seu lance'),
      h('b', null, fmtMoney(bid.price)),
      h('span', null, `${bid.vehicleName ? `${bid.vehicleName} · ` : ''}chance de ${chanceText(bid.chance)}`),
      bar((bid.chance || 0) * 100, { kind: 'accent' })) : null,
    h('div', { class: 'ct-botoes' },
      button(bid ? 'Mudar lance' : 'Fazer lance', () => bidSheet(store, again, st, v, t), { kind: bid ? '' : 'primary', small: true, disabled: !can && !bid, icon: 'editar', iconSize: 16 }),
      bid ? button('Retirar', () => {
        const r = store.dispatch({ type: 'contract/withdraw', contractId: t.id });
        toast(r?.ok ? 'Lance retirado.' : r?.error || 'Não deu para retirar.', r?.ok ? 'info' : 'bad');
        again();
      }, { kind: 'ghost', small: true }) : null));
}

function bidSheet(store, again, st, v, t) {
  const f = t.feas;
  const form = {
    vehicleId: t.playerBid?.vehicleId || f.vehicleId || null,
    price: t.playerBid?.price || Math.round(t.refM * 0.85),
  };
  form.price = Math.min(t.bidMax, Math.max(t.bidMin, form.price));
  openModal((close) => {
    const wrap = h('div', { class: 'ct-folha' });
    const live = h('div', { class: 'ct-live', 'aria-live': 'polite' });
    const priceVal = h('b', { class: 'ct-preco-val' });
    const pctRef = h('span', { class: 'ct-preco-ref' });
    const slider = h('input', {
      type: 'range', class: 'ct-range', min: String(t.bidMin), max: String(t.bidMax), step: '1', value: String(form.price), 'aria-label': 'Preço do lance',
      oninput: (e) => { form.price = Number(e.target.value); paintLive(); },
    });
    const step = (d) => {
      form.price = Math.min(t.bidMax, Math.max(t.bidMin, Math.round(form.price + d * t.refM)));
      slider.value = String(form.price);
      paintLive();
    };
    function paintLive() {
      const o = store.tryQuery('contracts/odds', null, t.id, form.price, form.vehicleId) || {};
      priceVal.textContent = fmtMoney(form.price);
      pctRef.textContent = `${pctText(form.price / t.refM)} da referência (${fmtMoney(t.refM)})`;
      live.innerHTML = '';
      const good = (o.marginM ?? 0) >= 0;
      live.append(...[
        h('div', { class: 'ct-chance' },
          h('span', { class: 'ct-eyebrow' }, 'Chance de vencer'),
          h('b', { class: 'ct-chance-val' }, chanceText(o.chance)),
          bar((o.chance || 0) * 100, { kind: 'accent' })),
        o.favourite ? h('p', { class: 'ct-texto' }, o.favourite.player ? 'Com este lance, sua agência é a favorita.' : `Favorita com este lance: ${o.favourite.name} (${pctText(o.favourite.p)}).`) : null,
        o.field?.length ? h('div', { class: 'ct-campo', role: 'list', 'aria-label': 'Chance de cada proposta' }, o.field.map((e) => h('div', { class: ['ct-campo-linha', e.player && 'mine'], role: 'listitem' },
          h('span', { class: 'ct-campo-nome' }, e.name),
          bar(e.p * 100, { kind: e.player ? 'accent' : '' }),
          h('span', { class: 'ct-campo-num' }, chanceText(e.p))))) : null,
        h('dl', { class: 'ct-resumo' },
          h('dt', null, 'Custo provável'), h('dd', null, o.costM != null ? fmtMoney(o.costM) : '—'),
          h('dt', null, 'Margem esperada'), h('dd', { class: good ? 'ct-pos' : 'ct-neg' }, marginText(o.marginM, o.marginPct)),
          h('dt', null, `Na assinatura (${pctText(v.advance)})`), h('dd', null, fmtMoney(o.advanceM)),
          h('dt', null, 'Na entrega'), h('dd', null, fmtMoney(form.price - (o.advanceM || 0))),
          h('dt', null, 'Multa se falhar ou atrasar demais'), h('dd', { class: 'ct-neg' }, fmtMoney(o.fineM))),
        !good ? note('Com este foguete o lance não cobre o custo provável: suba o preço ou escolha um foguete mais barato.', { kind: 'warn', icon: 'alerta' }) : null,
      ].filter(Boolean));
    }
    // the rockets worth offering: the ones that can pay off inside the bid range (and the one already chosen), cheapest first
    const all = f.vehicles || [];
    const rockets = all.filter((r) => r.vehicleId === form.vehicleId || r.costM < t.bidMax).slice(0, 6);
    wrap.append(
      h('p', { class: 'ct-texto' }, `${t.client}: ${t.what} Lançamento até ${t.deadlineText}. Os lances dos concorrentes são secretos; a chance considera preço, reputação, confiabilidade do foguete e o histórico de contratos.`),
      rockets.length > 1 ? h('div', { class: 'field' }, h('span', null, 'Foguete que você pretende usar'),
        h('div', { class: 'ct-escolha', role: 'radiogroup', 'aria-label': 'Foguete' }, rockets.map((r) => h('button', {
          class: ['ct-opcao', r.vehicleId === form.vehicleId && 'ativa'], type: 'button', role: 'radio', 'aria-checked': r.vehicleId === form.vehicleId ? 'true' : 'false',
          onclick: (e) => {
            form.vehicleId = r.vehicleId;
            for (const b of e.currentTarget.parentNode.children) { b.classList.toggle('ativa', b === e.currentTarget); b.setAttribute('aria-checked', b === e.currentTarget ? 'true' : 'false'); }
            paintLive();
          },
        }, h('span', { class: 'ct-opcao-nome' }, r.name), h('span', { class: 'ct-opcao-num' }, `${pctText(r.rel)} · ${fmtMoney(r.costM)}`))))) : rockets.length === 1
        ? h('p', { class: 'ct-texto ct-muted' }, `Foguete: ${rockets[0].name} (confiabilidade ${pctText(rockets[0].rel)}).`) : null,
      h('div', { class: 'field ct-preco' },
        h('span', null, 'Seu preço'),
        h('div', { class: 'ct-preco-linha' },
          button('', () => step(-0.05), { icon: 'menos', title: 'Baixar 5%' }),
          h('div', { class: 'ct-preco-txt' }, priceVal, pctRef),
          button('', () => step(0.05), { icon: 'mais', title: 'Subir 5%' })),
        slider,
        h('div', { class: 'ct-range-marcas', 'aria-hidden': 'true' }, h('span', null, fmtMoney(t.bidMin)), h('span', null, fmtMoney(t.bidMax)))),
      live,
      h('div', { class: 'ct-botoes' },
        button(t.playerBid ? 'Atualizar lance' : 'Enviar lance', () => {
          const r = store.dispatch({ type: 'contract/bid', contractId: t.id, price: form.price, vehicleId: form.vehicleId });
          if (r?.ok) { toast(`Lance de ${fmtMoney(r.price)} enviado: ${chanceText(r.chance)} de chance.`, 'good'); close(); again(); } else toast(r?.error || 'Lance não enviado.', 'bad');
        }, { kind: 'primary', big: true }),
        button('Cancelar', () => close(), { kind: 'ghost', big: true })));
    paintLive();
    return wrap;
  }, { title: `Lance: ${t.title}`, cls: 'ct-modal' });
}

function mineCard(store, again, st, c) {
  const go = (id) => store.ui?.navigate?.('missoes', `m/${id}`);
  const status = c.status === 'late' ? chip('atrasado', 'bad') : c.failures ? chip('2ª tentativa', 'warn') : chip('ganho', 'good');
  const mission = c.missionId
    ? c.needsHardware ? 'Falta escolher o foguete.' : c.missionStatus === 'scheduled' ? `Lançamento marcado: ${c.launchText}.` : c.missionStatus === 'planning' ? 'Missão em planejamento: agende o lançamento.' : 'Missão em andamento.'
    : 'Sem missão: monte a missão do contrato.';
  return h('article', { class: 'ct-card mine' },
    h('div', { class: 'ct-card-topo' },
      h('div', { class: 'ct-card-nome' }, h('span', { class: 'ct-eyebrow' }, c.clientKindLabel || 'Cliente'), h('b', null, c.title), h('span', null, c.client)),
      h('div', { class: 'ct-card-num' }, h('b', null, fmtMoney(c.price)), h('span', null, `${fmtMoney(c.advanceM)} recebidos`))),
    h('p', { class: 'ct-texto' }, c.what),
    h('div', { class: 'chips ct-chips' }, status, chip(`lançar até ${c.deadlineText}`, c.late ? 'bad' : 'muted'), chip(`multa ${fmtMoney(c.fineM)}`, 'muted')),
    h('p', { class: 'ct-texto' }, mission),
    c.late ? note(`Atrasado: o pagamento cai e, sem lançamento até ${c.graceText}, o contrato acaba com multa.`, { kind: 'bad', icon: 'alerta' }) : null,
    h('div', { class: 'ct-botoes' },
      c.missionId && c.needsHardware ? button('Escolher o foguete', () => go(c.missionId), { kind: 'primary', small: true, icon: 'foguete', iconSize: 16 }) : null,
      c.missionId && !c.needsHardware ? button('Ver missão', () => go(c.missionId), { small: true, icon: 'seta', iconSize: 14 }) : null,
      !c.missionId ? button('Montar missão', () => {
        const r = store.dispatch({ type: 'contract/mission', contractId: c.id });
        if (r?.ok) go(r.missionId); else { toast(r?.error || 'Não deu para montar a missão.', 'bad'); again(); }
      }, { kind: 'primary', small: true, icon: 'editar', iconSize: 16 }) : null));
}

function resultRow(st, r) {
  const [txt, kind] = resultChip(r);
  const mine = r.mine || r.playerBid;
  return listRow({
    lead: r.winner ? emblem(st, r.winner, 28) : null, leadCls: 'pn-emblem',
    title: r.title,
    sub: [r.client, r.price != null ? fmtMoney(r.price) : null, r.playerBid ? `seu lance ${fmtMoney(r.playerBid.price)}${r.playerChance != null ? ` (${chanceText(r.playerChance)})` : ''}` : null, r.resolvedText].filter(Boolean).join(' · '),
    right: chip(txt, kind),
    cls: ['wrap', mine && 'mine'].filter(Boolean).join(' '),
  });
}

// ------------------------------------------------------------------ screen

/** The board inside any container (the drawer screen and Missões › Contratos). */
export function renderBoard(root, store, again, { embedded = false } = {}) {
  ensurePainelCss();
  ensureCss();
  const st = store.state;
  const v = store.tryQuery('contracts/board', null);
  if (!v) {
    root.append(emptyState('O quadro de contratos não está disponível nesta partida.', 'transferir'));
    return;
  }
  const bids = v.open.filter((t) => t.playerBid);
  const can = v.open.filter((t) => t.feas.level !== 'bad');
  const hw = v.mine.find((c) => c.needsHardware || !c.missionId);
  const primary = hw
    ? { label: hw.missionId ? `Escolher o foguete: ${hw.title}` : `Montar missão: ${hw.title}`, icon: 'foguete', onClick: () => {
      if (hw.missionId) { store.ui?.navigate?.('missoes', `m/${hw.missionId}`); return; }
      const r = store.dispatch({ type: 'contract/mission', contractId: hw.id });
      if (r?.ok) store.ui?.navigate?.('missoes', `m/${r.missionId}`); else toast(r?.error || 'Não deu para montar a missão.', 'bad');
    } }
    : null;
  const rec = v.record || { won: 0, ok: 0, bad: 0 };
  const list = tenderFilter(v.open, UI.filter);
  root.append(...[
    embedded ? null : screenHead({ title: 'Contratos', lead: 'Concorrências abertas: dê seu preço e dispute com as outras agências', primary }),
    embedded && primary ? h('div', { class: 'tela-acao' }, button(primary.label, primary.onClick, { kind: 'primary', big: true, icon: primary.icon })) : null,
    kpis([
      { label: 'Abertas', value: String(v.open.length), sub: `${can.length} você consegue entregar` },
      { label: 'Seus lances', value: String(bids.length), sub: bids.length ? 'aguardando o fechamento' : 'nenhum agora' },
      { label: 'Contratos ativos', value: String(v.mine.length), sub: v.mine.some((c) => c.late) ? 'algum atrasado' : 'no prazo' },
      { label: 'Histórico', value: `${rec.ok}/${rec.won}`, sub: `entregues/ganhos${rec.bad ? ` · ${rec.bad} falha${rec.bad === 1 ? '' : 's'}` : ''}`, tone: rec.bad > rec.ok ? 'down' : '' },
    ], { label: 'Números dos contratos' }),
    v.mine.length ? section('Seus contratos', { right: countChip(v.mine.length) }, ...v.mine.map((c) => mineCard(store, again, st, c))) : null,
    section('Concorrências abertas', { right: countChip(v.open.length), id: 'ct-abertas' },
      v.open.length ? pills([
        { id: 'all', label: 'Todas', count: v.open.length },
        { id: 'can', label: 'Consigo entregar', count: can.length },
        { id: 'bid', label: 'Com lance', count: bids.length },
      ], UI.filter, (id) => { UI.filter = id; again(); }, { label: 'Filtro de concorrências' }) : null,
      list.length ? list.map((t) => tenderCard(store, again, st, v, t))
        : note(v.open.length ? 'Nenhuma concorrência neste filtro.' : 'Nenhuma concorrência aberta agora. Clientes publicam novas a cada poucas semanas, conforme o que a época sabe fazer.')),
    v.results.length ? section('Resultados recentes', { right: countChip(v.results.length) }, listCard(v.results.map((r) => resultRow(st, r)))) : null,
    section('Como funciona', {},
      note(`O valor de referência fica bem acima do custo típico de voar a entrega: mesmo um lance de ${pctText(v.bidRange[0])} paga mais do que custa para quem tem o foguete certo. Você recebe ${pctText(v.advance)} na assinatura e o resto na entrega.`),
      note('A chance de vencer vem do preço comparado aos outros lances, da reputação da agência, da confiabilidade do foguete escolhido e do histórico de contratos entregues ou perdidos.'),
      note(`Lançamento depois do prazo corta ${pctText(v.lateCut)} do pagamento; sem lançar, o contrato cai com multa de ${pctText(v.finePct)} do preço. Uma falha com tempo de sobra dá direito a uma segunda tentativa.`, { kind: 'warn', icon: 'alerta' })),
  ].filter(Boolean));
}

export function render(container, store, route) {
  const root = h('div', { class: 'view-pad tela contratos' });
  container.appendChild(root);
  const again = () => rerender(container, render, store, route);
  renderBoard(root, store, again);
}

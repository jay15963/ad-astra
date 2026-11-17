// Painel: five big numbers with trends, decision queue by urgency, upcoming launches, era goals.
import {
  h, raw, card, chip, bar, trend, countUp, sparkline, sectionTitle, emptyState, safePanel, openModal, button,
  fmtMoney, fmtMoneyDelta, fmtIn, fmtMonth, fmtBand, fmtDate, attempt, TYPE_ICONS, TRUTH_LABELS, STATUS_LABELS, FIRST_LABELS,
} from './components.js';
import { emblemSVG } from './portrait.js';
import { sortDecisions, decisionRow } from './decisions.js';

export function render(container, store) {
  const st = store.state;
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  container.appendChild(h('div', { class: 'view-pad dashboard' },
    safePanel(() => bigNumbers(store, nav), 'Os números da agência ainda não estão disponíveis.'),
    safePanel(() => decisionQueue(store), 'A fila de decisões não pôde ser exibida.'),
    safePanel(() => activeMissions(store, nav)),
    safePanel(() => upcoming(store, nav), 'O calendário ainda está sendo montado.'),
    safePanel(() => eraGoals(store, nav)),
    h('p', { class: 'muted small center' }, `Turno ${st.turn + 1} de ${st.endTurn + 1}`)));
}

// ------------------------------------------------------------------ five numbers

function tile({ key, label, value, format, delta, deltaFmt, goodWhenUp = true, sub, onClick, wide, spark, icon, noPulse }) {
  return h('button', { class: ['tile', wide && 'tile-wide'], type: 'button', onclick: onClick, 'aria-label': label },
    h('div', { class: 'tile-label' }, icon ? h('span', { 'aria-hidden': 'true' }, icon + ' ') : null, label),
    h('div', { class: 'tile-main' },
      countUp(`dash.${key}`, value, format, noPulse ? 'tile-value no-pulse' : 'tile-value'),
      delta !== undefined ? trend(delta, { goodWhenUp, format: deltaFmt || ((d) => String(Math.round(d))) }) : null),
    spark || null,
    sub ? h('div', { class: 'tile-sub' }, sub) : null);
}

function bigNumbers(store, nav) {
  const st = store.state;
  const me = st.actors?.[st.playerId];
  if (!me) {
    return card({ title: 'Agência em formação', icon: '🛠️' },
      h('p', { class: 'muted' }, 'Os dados dos atores ainda não chegaram. Assim que o módulo de diplomacia carregar, seus números aparecem aqui.'));
  }
  const summary = store.tryQuery('budget/summary', null);
  const weeklyNet = summary ? (Number(summary.weeklyIncome) || 0) - (Number(summary.weeklyCost) || 0) : null;
  const crew = Object.values(st.crew || {}).filter((c) => c?.actorId === st.playerId && c.status === 'active');
  const morale = crew.length ? Math.round(crew.reduce((s, c) => s + (c.morale || 0), 0) / crew.length) : null;
  const next = nextLaunchInfo(store);

  return h('section', { class: 'tiles', 'aria-label': 'Números da agência' },
    tile({
      key: 'cash', label: 'Verba em caixa', icon: '💰', value: me.cash, format: fmtMoney, wide: true,
      delta: store.trend('cash'), deltaFmt: (d) => fmtMoney(d).replace('US$ ', ''),
      spark: sparkline(store.series('cash', 20), { w: 96, h: 26, cls: me.cash < 0 ? 'bad' : '' }),
      sub: [
        weeklyNet != null ? `${fmtMoneyDelta(weeklyNet)}/sem` : `${fmtMoney(me.budget)}/ano`,
        summary?.runwayWeeks != null && Number.isFinite(summary.runwayWeeks) && summary.runwayWeeks < 52 ? ` · fôlego ${Math.max(0, Math.round(summary.runwayWeeks))} sem` : '',
        me.cash < 0 ? ' · no vermelho!' : '',
      ].join(''),
      onClick: () => openFinance(store),
    }),
    tile({
      key: 'support', label: 'Apoio', icon: '🏛', value: me.support, format: (v) => String(Math.round(v)), delta: store.trend('support'),
      sub: supportText(me.support), onClick: () => openSupport(store),
    }),
    tile({
      key: 'rep', label: 'Reputação', icon: '🤝', value: me.reputation, format: (v) => String(Math.round(v)), delta: store.trend('reputation'),
      sub: `Prestígio ${Math.round(me.prestige || 0)}`, onClick: () => nav('mundo', 'atores'),
    }),
    tile({
      key: 'crew', label: 'Equipe', icon: '👩‍🚀', value: crew.length, format: (v) => String(Math.round(v)), delta: store.trend('crew'),
      sub: morale != null ? `Moral ${morale}` : 'Toque para contratar', onClick: () => nav('equipe'),
    }),
    tile({
      key: 'next', noPulse: true, label: next.label, icon: '🚀', value: next.value, format: next.format, sub: next.sub, onClick: () => nav('missoes'),
    }));
}

function supportText(v) {
  if (v == null) return '';
  if (v < 20) return 'Governo perdendo a paciência';
  if (v < 40) return 'Apoio frágil';
  if (v < 65) return 'Apoio estável';
  return 'Opinião pública a favor';
}

/** Next player launch (or the next planetary window) for the 5th tile. */
function nextLaunchInfo(store) {
  const st = store.state;
  const sched = (st.missions || []).filter((m) => m.status === 'scheduled' && m.launchTurn != null).sort((a, b) => a.launchTurn - b.launchTurn);
  if (sched[0]) {
    const w = Math.max(0, sched[0].launchTurn - st.turn);
    return { label: 'Próximo lançamento', value: w, format: (v) => (Math.round(v) === 0 ? 'hoje' : `${Math.round(v)} sem`), sub: sched[0].name || 'Missão agendada' };
  }
  const win = attempt(() => reachableNextWindow(store), null);
  if (win) {
    const destName = store.data?.index?.destinations?.[win.destination || win.destinationId]?.name || win.name || 'Janela';
    const w = Math.max(0, win.openTurn - st.turn);
    return { label: 'Próxima janela', value: w, format: (v) => (Math.round(v) === 0 ? 'aberta' : `${Math.round(v)} sem`), sub: `${destName} · ${fmtMonth(win.openTurn, st.startYear)}` };
  }
  return { label: 'Próxima janela', value: NaN, format: () => '—', sub: 'Monte uma missão' };
}

/**
 * Earliest window whose mission still arrives before the campaign ends (launch + transitWeeks <= endTurn, the same rule
 * the government pitches use): a Pluto flyby that lands in 2035 is not worth promoting on the dashboard.
 * Uses the sim's per-destination 'missions/nextWindow' and falls back to the data-based computation.
 */
export function reachableNextWindow(store) {
  const st = store.state;
  const end = Number.isFinite(st.endTurn) ? st.endTurn : Infinity;
  let best = null;
  for (const d of store.data?.destinations?.destinations || []) {
    if (!d.window?.periodWeeks) continue;
    const q = store.tryQuery?.('missions/nextWindow', null, d.id, st.turn);
    const w = q && q.openTurn != null ? q : computeNextWindow(store, (x) => x.id === d.id);
    if (!w || w.openTurn == null) continue;
    const launch = Math.max(st.turn, w.openTurn);
    if (launch >= end || launch + (Number(d.transitWeeks) || 0) > end) continue;
    if (!best || w.openTurn < best.openTurn) best = { ...w, destination: d.id };
  }
  return best;
}

/** Fallback: earliest destination window from data (period/phase/open weeks), optionally only for some destinations. */
export function computeNextWindow(store, filter = null) {
  const st = store.state;
  let best = null;
  for (const d of store.data?.destinations?.destinations || []) {
    const w = d.window;
    if (!w || !w.periodWeeks) continue;
    if (filter && !filter(d)) continue;
    const period = w.periodWeeks, phase = w.phaseTurn || 0, open = w.openWeeks || 4;
    let k = Math.floor((st.turn - phase) / period);
    let openTurn = phase + k * period;
    if (st.turn > openTurn + open) openTurn += period;
    if (!best || openTurn < best.openTurn) best = { destination: d.id, openTurn, closeTurn: openTurn + open };
  }
  return best;
}

// ------------------------------------------------------------------ modals

function openFinance(store) {
  const st = store.state;
  const me = st.actors[st.playerId];
  const s = store.tryQuery('budget/summary', {}) || {};
  const ledger = (st.finance?.ledger || []).slice(-12).reverse();
  const spent = s.yearSpent || st.finance?.year?.spent || {};
  const CAT = { missions: 'Missões', research: 'Pesquisa', crew: 'Equipe', facilities: 'Instalações', contracts: 'Contratos', diplomacy: 'Diplomacia', grants: 'Repasses' };
  const maxSpent = Math.max(1, ...Object.values(spent).map((v) => Math.abs(Number(v) || 0)));
  openModal(h('div', { class: 'finance' },
    h('div', { class: 'stat-grid' },
      stat('Caixa', fmtMoney(s.cash ?? me.cash)),
      stat('Verba anual', fmtMoney(s.budget ?? me.budget)),
      stat('Entra/sem', fmtMoney(s.weeklyIncome)),
      stat('Sai/sem', fmtMoney(s.weeklyCost)),
      stat('Fôlego', s.runwayWeeks != null && Number.isFinite(s.runwayWeeks) ? `${Math.round(s.runwayWeeks)} sem` : '∞')),
    Object.keys(spent).length ? h('div', null, sectionTitle('Gasto no ano'),
      Object.entries(spent).map(([k, v]) => bar(Math.abs(v), { max: maxSpent, label: `${CAT[k] || k} · ${fmtMoney(v)}`, kind: 'accent' }))) : null,
    sectionTitle('Últimos lançamentos contábeis'),
    ledger.length ? h('ul', { class: 'ledger' }, ledger.map((l) => h('li', null,
      h('span', { class: 'muted small' }, fmtMonth(l.turn, st.startYear)),
      h('span', { class: 'ledger-note' }, l.note || CAT[l.category] || l.category),
      h('span', { class: ['ledger-amt', l.amount < 0 ? 'neg' : 'pos'] }, fmtMoneyDelta(l.amount)))))
      : emptyState('Nada lançado ainda.', '🧾')), { title: 'Orçamento' });
}

function openSupport(store) {
  const st = store.state;
  const me = st.actors[st.playerId];
  const pol = store.tryQuery('politics/actor', null, st.playerId) || st.politics?.[st.playerId] || {};
  openModal(h('div', null,
    bar(me.support, { label: 'Apoio do governo e do público', showValue: true, key: 'support.modal', kind: me.support < 30 ? 'bad' : 'good' }),
    h('p', { class: 'muted' }, 'Missões ousadas rendem apoio; falhas e dívidas custam caro. Se o apoio chegar a zero, você é demitido.'),
    h('div', { class: 'chips' },
      pol.government ? chip(`Governo: ${typeof pol.government === 'string' ? pol.government : pol.government.name || '—'}`, 'muted') : null,
      pol.stance != null ? chip(`Postura: ${pol.stance > 0.2 ? 'pró-espaço' : pol.stance < -0.2 ? 'cética' : 'neutra'}`, pol.stance > 0.2 ? 'good' : pol.stance < -0.2 ? 'bad' : 'muted') : null,
      pol.nextElectionTurn != null ? chip(`Eleição ${fmtIn(pol.nextElectionTurn, st.turn)}`, 'warn') : null,
      pol.priority ? chip(`Prioridade: ${pol.priority}`, 'info') : null),
    bar(me.culture ?? 0, { min: -100, max: 100, center: true, label: `Cultura: ${(me.culture ?? 0) > 20 ? 'ousada' : (me.culture ?? 0) < -20 ? 'cautelosa' : 'equilibrada'}` })),
  { title: 'Apoio e política' });
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

// ------------------------------------------------------------------ decisions

function decisionQueue(store) {
  const list = sortDecisions(store.state.decisions || []);
  return h('section', { class: 'queue' },
    sectionTitle('Decisões', list.length ? chip(String(list.length), list.some((d) => d.blocking) ? 'bad' : 'accent') : null),
    list.length ? h('div', { class: 'decision-list' }, list.slice(0, 8).map((d) => decisionRow(store, d)))
      : emptyState('Nenhuma decisão pendente. Avance o tempo ou monte uma missão.', '☕'),
    list.length > 8 ? h('p', { class: 'muted small' }, `+${list.length - 8} na fila`) : null);
}

// ------------------------------------------------------------------ missions in flight

function activeMissions(store, nav) {
  const st = store.state;
  const live = (st.missions || []).filter((m) => ['launch', 'transit', 'arrival', 'operations'].includes(m.status));
  if (!live.length) return null;
  return h('section', null,
    sectionTitle('Em voo'),
    live.map((m) => {
      const t = m.transit;
      const frac = t && t.arriveTurn > t.departTurn ? (st.turn - t.departTurn) / (t.arriveTurn - t.departTurn) : null;
      const dest = store.data?.index?.destinations?.[m.destination]?.name || m.destination;
      return card({ title: m.name, subtitle: `${STATUS_LABELS[m.status] || m.status} · ${dest}`, icon: TYPE_ICONS[m.type] || '🚀', onClick: () => nav('missoes', `m/${m.id}`) },
        frac != null ? bar(frac * 100, { key: `transit.${m.id}`, label: `Chegada ${fmtIn(t.arriveTurn, st.turn)}`, kind: 'accent' }) : null);
    }));
}

// ------------------------------------------------------------------ upcoming launches

function upcoming(store, nav) {
  const st = store.state;
  const mine = (st.missions || []).filter((m) => m.status === 'scheduled').sort((a, b) => (a.launchTurn ?? 1e9) - (b.launchTurn ?? 1e9)).slice(0, 3);
  let rivals = store.tryQuery('calendar/upcoming', null, 6);
  if (!Array.isArray(rivals)) {
    rivals = (st.calendar || []).filter((c) => c.status === 'planned' && c.owner !== st.playerId).sort((a, b) => (a.currentTurn ?? 1e9) - (b.currentTurn ?? 1e9)).slice(0, 6);
  }
  const rows = [];
  for (const m of mine) {
    rows.push(h('button', { class: 'launch-row mine', type: 'button', onclick: () => nav('missoes', `m/${m.id}`) },
      h('span', { class: 'lr-icon', 'aria-hidden': 'true' }, TYPE_ICONS[m.type] || '🚀'),
      h('div', { class: 'lr-text' }, h('div', { class: 'lr-name' }, m.name || 'Missão'),
        h('div', { class: 'muted small' }, `${fmtDate(m.launchTurn, st.startYear)} · ${fmtIn(m.launchTurn, st.turn)}`)),
      m.estimate ? chip(fmtBand(m.estimate.low, m.estimate.high), 'info') : chip('sua', 'accent')));
  }
  for (const c of rivals.filter((c) => c.owner !== st.playerId)) {
    const def = store.data?.index?.calendar?.[c.calendarId || c.id] || {};
    const owner = st.actors?.[c.owner || def.owner] || { id: c.owner || def.owner };
    const when = c.currentTurn ?? c.plannedTurn ?? c.turn;
    rows.push(h('div', { class: 'launch-row' },
      raw(emblemSVG(owner, { size: 30 }), 'lr-emblem'),
      h('div', { class: 'lr-text' }, h('div', { class: 'lr-name' }, c.name || def.name || c.id),
        h('div', { class: 'muted small' }, `${owner.short || owner.name || owner.id || ''} · ${fmtMonth(when, st.startYear)}${c.delayWeeks > 0 ? ` · atraso ${c.delayWeeks} sem` : ''}`)),
      chip(TRUTH_LABELS[c.truthLayer || def.truthLayer] || 'Plano', 'muted')));
  }
  return h('section', null,
    sectionTitle('Próximos lançamentos', button('Nova missão', () => nav('missoes', 'nova'), { kind: 'ghost', small: true, icon: '+' })),
    rows.length ? h('div', { class: 'launch-list' }, rows) : emptyState('Nenhum lançamento no horizonte.', '🛰️'));
}

// ------------------------------------------------------------------ era goals

function eraGoals(store, nav) {
  const st = store.state;
  const goals = store.data?.scenario?.victory?.goals || [];
  if (!goals.length) return null;
  return h('section', null,
    sectionTitle('Metas da era', button('Tabela', () => nav('mundo', 'tabela'), { kind: 'ghost', small: true })),
    h('div', { class: 'goal-list' }, goals.map((g) => {
      const f = st.firsts?.[g.id] || st.firsts?.[`${g.id}:${st.playerId}`];
      const who = f ? st.actors?.[f.actorId] : null;
      const mine = f && f.actorId === st.playerId;
      return h('div', { class: ['goal', f && 'claimed', mine && 'mine'] },
        h('span', { class: 'goal-mark', 'aria-hidden': 'true' }, mine ? '★' : f ? '✓' : '○'),
        h('span', { class: 'goal-label' }, g.label || FIRST_LABELS[g.id] || g.id),
        f ? chip(mine ? 'você primeiro!' : `${who?.short || who?.name || f.actorId}`, mine ? 'good' : 'muted') : chip('em aberto', 'accent'));
    })));
}

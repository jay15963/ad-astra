// Painel ("Centro de controle", CSmanager career dashboard): KPI tiles with trends, decision queue by urgency,
// missions in flight, upcoming launches, era goals — all as flat cards / divided list cards (docs/DESIGN.md §5 B2).
import {
  h, raw, iconSVG, chip, bar, trend, countUp, sparkline, sectionTitle, emptyState, safePanel, openModal, icon, linkButton, viewHead,
  fmtMoney, fmtMoneyDelta, fmtIn, fmtMonth, fmtBand, fmtDate, attempt, TYPE_ICONS, TRUTH_LABELS, STATUS_LABELS, FIRST_LABELS,
} from './components.js';
import { emblemSVG } from './portrait.js';
import { sortDecisions, decisionRow, listRow, ensurePainelCss } from './decisions.js';

const ERA_NAME = 'A Década Lunar';

export function render(container, store) {
  ensurePainelCss();
  const st = store.state;
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  container.appendChild(h('div', { class: 'view-pad dashboard' },
    safePanel(() => pageHead(store)),
    safePanel(() => bigNumbers(store, nav), 'Os números da agência ainda não estão disponíveis.'),
    safePanel(() => decisionQueue(store), 'A fila de decisões não pôde ser exibida.'),
    safePanel(() => activeMissions(store, nav)),
    safePanel(() => crewCertPrograms(store, nav)),
    safePanel(() => upcoming(store, nav), 'O calendário ainda está sendo montado.'),
    safePanel(() => eraGoals(store, nav)),
    h('p', { class: 'pn-foot' }, `Turno ${st.turn + 1} de ${st.endTurn + 1}`)));
}

function pageHead(store) {
  const st = store.state;
  const me = st.actors?.[st.playerId];
  const era = store.data?.scenario?.era || 4;
  return viewHead('Centro de controle', { lead: [me?.short || me?.name, `Era ${era}`, ERA_NAME].filter(Boolean).join(' · '), right: timeLinks(store) });
}

/**
 * The two time actions as plain links (the navbar disc does them by tap / long-press; this is the way without a
 * long-press: keyboard, switch access, or simply not knowing about the hold). A stopped clock routes the same
 * way as the disc (opens the decision / control room).
 */
function timeLinks(store) {
  if (store.state?.gameOver || !store.ui?.advance) return null;
  const link = (label, ic, fn) => h('button', { class: 'btn-link pn-time-link', type: 'button', onclick: fn },
    raw(iconSVG(ic, 14), 'btn-link-ic'), label);
  return h('div', { class: 'pn-time', role: 'group', 'aria-label': 'Tempo' },
    link('+1 semana', 'avancar', () => store.ui.advance(1, false)),
    link('Próximo evento', 'proximo', () => store.ui.advanceToEvent ? store.ui.advanceToEvent() : store.ui.advance(26, true)));
}

// ------------------------------------------------------------------ KPI tiles

function tile({ key, label, value, format, delta, deltaFmt, goodWhenUp = true, sub, onClick, wide, spark, noPulse }) {
  return h('button', { class: ['tile', wide && 'tile-wide'], type: 'button', onclick: onClick, 'aria-label': label },
    h('span', { class: 'tile-label' }, label),
    h('span', { class: 'tile-main' },
      countUp(`dash.${key}`, value, format, noPulse ? 'tile-value no-pulse' : 'tile-value'),
      delta !== undefined ? trend(delta, { goodWhenUp, format: deltaFmt || ((d) => String(Math.round(d))) }) : null),
    sub ? h('span', { class: 'tile-sub' }, sub) : null,
    spark ? h('span', { class: 'tile-spark', 'aria-hidden': 'true' }, spark) : null);
}

function bigNumbers(store, nav) {
  const st = store.state;
  const me = st.actors?.[st.playerId];
  if (!me) {
    return h('div', { class: 'empty pn-empty' }, h('p', null, 'Os dados dos atores ainda não chegaram. Assim que o módulo de diplomacia carregar, seus números aparecem aqui.'));
  }
  const summary = store.tryQuery('budget/summary', null);
  const weeklyNet = summary ? (Number(summary.weeklyIncome) || 0) - (Number(summary.weeklyCost) || 0) : null;
  const crew = Object.values(st.crew || {}).filter((c) => c?.actorId === st.playerId && c.status === 'active');
  const morale = crew.length ? Math.round(crew.reduce((s, c) => s + (c.morale || 0), 0) / crew.length) : null;
  const next = nextLaunchInfo(store);
  const runway = summary?.runwayWeeks != null && Number.isFinite(summary.runwayWeeks) && summary.runwayWeeks < 52
    ? Math.max(0, Math.round(summary.runwayWeeks)) : null;
  const falling = (store.trend('cash') || 0) < 0 || me.cash < 0;

  return h('section', { class: 'tiles', 'aria-label': 'Números da agência' },
    tile({
      key: 'cash', label: 'Verba em caixa', value: me.cash, format: fmtMoney, wide: true,
      delta: store.trend('cash'), deltaFmt: (d) => fmtMoney(d).replace('US$ ', ''),
      spark: sparkline(store.series('cash', 20), { w: 84, h: 26, cls: falling ? 'bad' : '' }),
      sub: [
        weeklyNet != null
          ? h('span', { class: weeklyNet > 0 ? 'up' : weeklyNet < 0 ? 'down' : null }, `${fmtMoneyDelta(weeklyNet) || fmtMoney(0)}/sem`)
          : `${fmtMoney(me.budget)}/ano`,
        runway != null ? h('span', { class: runway < 12 ? 'down' : null }, ` · fôlego ${runway} sem`) : null,
        me.cash < 0 ? h('span', { class: 'down' }, ' · no vermelho') : null,
      ],
      onClick: () => openFinance(store),
    }),
    tile({
      key: 'support', label: 'Apoio', value: me.support, format: (v) => String(Math.round(v)), delta: store.trend('support'),
      sub: supportText(me.support), onClick: () => openSupport(store),
    }),
    tile({
      key: 'rep', label: 'Reputação', value: me.reputation, format: (v) => String(Math.round(v)), delta: store.trend('reputation'),
      sub: `Prestígio ${Math.round(me.prestige || 0)}`, onClick: () => nav('mundo', 'atores'),
    }),
    tile({
      key: 'crew', label: 'Equipe', value: crew.length, format: (v) => String(Math.round(v)), delta: store.trend('crew'),
      sub: morale != null ? `Moral ${morale}` : 'Toque para contratar', onClick: () => nav('equipe'),
    }),
    tile({
      key: 'next', noPulse: true, label: next.label, value: next.value, format: next.format, sub: next.sub, onClick: () => nav('missoes'),
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

// ------------------------------------------------------------------ sheets

function openFinance(store) {
  const st = store.state;
  const me = st.actors[st.playerId];
  const s = store.tryQuery('budget/summary', {}) || {};
  const ledger = (st.finance?.ledger || []).slice(-12).reverse();
  const spent = s.yearSpent || st.finance?.year?.spent || {};
  const CAT = { missions: 'Missões', research: 'Pesquisa', crew: 'Equipe', facilities: 'Instalações', contracts: 'Contratos', diplomacy: 'Diplomacia', grants: 'Repasses' };
  const maxSpent = Math.max(1, ...Object.values(spent).map((v) => Math.abs(Number(v) || 0)));
  const runway = s.runwayWeeks != null && Number.isFinite(s.runwayWeeks) ? Math.round(s.runwayWeeks) : null;
  openModal(h('div', { class: 'finance' },
    h('div', { class: 'stat-grid' },
      stat('Caixa', fmtMoney(s.cash ?? me.cash), (s.cash ?? me.cash) < 0 ? 'down' : '', true),
      stat('Verba anual', fmtMoney(s.budget ?? me.budget)),
      stat('Fôlego', runway != null ? `${runway} sem` : '∞', runway != null && runway < 12 ? 'down' : ''),
      stat('Entra/sem', fmtMoney(s.weeklyIncome)),
      stat('Sai/sem', fmtMoney(s.weeklyCost))),
    Object.keys(spent).length ? h('div', { class: 'pn-block' }, sectionTitle('Gasto no ano'),
      h('div', { class: 'pn-card pn-bars' }, Object.entries(spent).map(([k, v]) => bar(Math.abs(v), { max: maxSpent, label: `${CAT[k] || k} · ${fmtMoney(v)}` })))) : null,
    h('div', { class: 'pn-block' }, sectionTitle('Últimos lançamentos contábeis'),
      ledger.length ? h('ul', { class: 'ledger' }, ledger.map((l) => h('li', null,
        h('span', { class: 'ledger-date' }, fmtMonth(l.turn, st.startYear)),
        h('span', { class: 'ledger-note' }, l.note || CAT[l.category] || l.category),
        h('span', { class: ['ledger-amt', l.amount < 0 ? 'neg' : 'pos'] }, fmtMoneyDelta(l.amount)))))
        : emptyState('Nada lançado ainda.', 'caixa'))), { title: 'Orçamento', cls: 'pn-sheet' });
}

function openSupport(store) {
  const st = store.state;
  const me = st.actors[st.playerId];
  const pol = store.tryQuery('politics/actor', null, st.playerId) || st.politics?.[st.playerId] || {};
  const culture = me.culture ?? 0;
  openModal(h('div', { class: 'support' },
    h('div', { class: 'stat-grid' },
      stat('Apoio', String(Math.round(me.support ?? 0)), me.support < 30 ? 'down' : ''),
      stat('Cultura', culture > 20 ? 'ousada' : culture < -20 ? 'cautelosa' : 'equilibrada')),
    h('div', { class: 'pn-card pn-bars' },
      bar(me.support, { label: 'Apoio do governo e do público', showValue: true, key: 'support.modal', kind: me.support < 30 ? 'bad' : '' }),
      bar(culture, { min: -100, max: 100, center: true, label: 'Cautelosa ↔ ousada' })),
    h('p', { class: 'pn-note' }, icon('info', 16), h('span', null, 'Missões ousadas rendem apoio; falhas e dívidas custam caro. Se o apoio chegar a zero, você é demitido.')),
    h('div', { class: 'chips' },
      pol.government ? chip(`Governo: ${typeof pol.government === 'string' ? pol.government : pol.government.name || '—'}`) : null,
      pol.stance != null ? chip(`Postura: ${pol.stance > 0.2 ? 'pró-espaço' : pol.stance < -0.2 ? 'cética' : 'neutra'}`, pol.stance > 0.2 ? 'good' : pol.stance < -0.2 ? 'bad' : '') : null,
      pol.nextElectionTurn != null ? chip(`Eleição ${fmtIn(pol.nextElectionTurn, st.turn)}`, 'warn') : null,
      pol.priority ? chip(`Prioridade: ${pol.priority}`, 'info') : null)),
  { title: 'Apoio e política', cls: 'pn-sheet' });
}

function stat(label, value, cls = '', wide = false) {
  return h('div', { class: ['stat', wide && 'stat-wide'] }, h('div', { class: 'stat-label' }, label), h('div', { class: ['stat-value', cls] }, value));
}

// ------------------------------------------------------------------ decisions

function decisionQueue(store) {
  const list = sortDecisions(store.state.decisions || []);
  const blocking = list.some((d) => d.blocking);
  return h('section', { class: 'queue pn-block' },
    sectionTitle('Decisões', list.length ? h('span', { class: ['badge', blocking && 'badge-bad'], 'aria-label': `${list.length} pendentes` }, String(list.length)) : null),
    list.length ? h('div', { class: 'decision-list' }, list.slice(0, 8).map((d) => decisionRow(store, d)))
      : emptyState('Nenhuma decisão pendente. Avance o tempo ou monte uma missão.', 'caixa'),
    list.length > 8 ? h('p', { class: 'pn-more' }, `+${list.length - 8} na fila`) : null);
}

// ------------------------------------------------------------------ missions in flight

function activeMissions(store, nav) {
  const st = store.state;
  const live = (st.missions || []).filter((m) => ['launch', 'transit', 'arrival', 'operations'].includes(m.status));
  if (!live.length) return null;
  return h('section', { class: 'pn-block' },
    sectionTitle('Em voo', h('span', { class: 'pn-count' }, String(live.length))),
    h('div', { class: 'pn-list' }, live.map((m) => {
      const t = m.transit;
      const frac = t && t.arriveTurn > t.departTurn ? Math.max(0, Math.min(1, (st.turn - t.departTurn) / (t.arriveTurn - t.departTurn))) : null;
      const dest = store.data?.index?.destinations?.[m.destination]?.name || m.destination;
      return listRow({
        lead: TYPE_ICONS[m.type] || '🚀', title: m.name, sub: `${STATUS_LABELS[m.status] || m.status} · ${dest}`,
        meta: frac != null ? fmtIn(t.arriveTurn, st.turn) : null,
        extra: frac != null ? bar(frac * 100, { key: `transit.${m.id}` }) : null,
        onClick: () => nav('missoes', `m/${m.id}`),
      });
    })));
}

/** The player's crew-certification programs (Missões › Frota has the details). */
function crewCertPrograms(store, nav) {
  const st = store.state;
  const progs = Object.values(st.crewCert?.programs || {}).filter((p) => p?.sponsor === st.playerId);
  if (!progs.length) return null;
  return h('section', { class: 'pn-block' },
    sectionTitle('Certificação tripulada', linkButton('Frota', () => nav('missoes', 'frota'))),
    h('div', { class: 'pn-list' }, progs.map((p) => {
      const cs = store.tryQuery?.('catalog/crewCert', null, p.vehicleId) || null;
      const name = cs?.name || store.data?.index?.vehicles?.[p.vehicleId]?.name || p.vehicleId;
      const prog = cs?.program;
      return listRow({
        lead: icon('equipe', 18), title: name, sub: prog ? prog.phaseLabel : 'Em andamento',
        meta: prog ? `${cs.flightsOk}/${cs.flightsNeeded} voos` : null,
        extra: prog ? bar(Math.round((prog.progress || 0) * 100), { key: `cert.${p.vehicleId}` }) : null,
        onClick: () => nav('missoes', 'frota'),
      });
    })));
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
    rows.push(listRow({
      cls: 'launch-row mine', lead: TYPE_ICONS[m.type] || '🚀', title: m.name || 'Missão',
      sub: `${fmtDate(m.launchTurn, st.startYear)} · ${fmtIn(m.launchTurn, st.turn)}`,
      right: m.estimate ? chip(fmtBand(m.estimate.low, m.estimate.high), 'info') : chip('sua', 'accent'),
      onClick: () => nav('missoes', `m/${m.id}`), chevron: false,
    }));
  }
  for (const c of rivals.filter((c) => c.owner !== st.playerId)) {
    const def = store.data?.index?.calendar?.[c.calendarId || c.id] || {};
    const owner = st.actors?.[c.owner || def.owner] || { id: c.owner || def.owner };
    const when = c.currentTurn ?? c.plannedTurn ?? c.turn;
    rows.push(listRow({
      cls: 'launch-row', lead: raw(emblemSVG(owner, { size: 30 })), leadCls: 'pn-emblem', title: c.name || def.name || c.id,
      sub: `${owner.short || owner.name || owner.id || ''} · ${fmtMonth(when, st.startYear)}${c.delayWeeks > 0 ? ` · atraso ${c.delayWeeks} sem` : ''}`,
      right: chip(TRUTH_LABELS[c.truthLayer || def.truthLayer] || 'Plano', 'muted'),
    }));
  }
  return h('section', { class: 'pn-block' },
    sectionTitle('Próximos lançamentos', linkButton('Nova missão', () => nav('missoes', 'nova'))),
    rows.length ? h('div', { class: 'launch-list pn-list' }, rows) : emptyState('Nenhum lançamento no horizonte.', 'calendario'));
}

// ------------------------------------------------------------------ era goals

function eraGoals(store, nav) {
  const st = store.state;
  const goals = store.data?.scenario?.victory?.goals || [];
  if (!goals.length) return null;
  const mineCount = goals.filter((g) => (st.firsts?.[g.id] || st.firsts?.[`${g.id}:${st.playerId}`])?.actorId === st.playerId).length;
  return h('section', { class: 'pn-block' },
    sectionTitle(`Metas da era · ${mineCount}/${goals.length}`, linkButton('Tabela', () => nav('mundo', 'tabela'))),
    h('div', { class: 'goal-list pn-list' }, goals.map((g) => {
      const f = st.firsts?.[g.id] || st.firsts?.[`${g.id}:${st.playerId}`];
      const who = f ? st.actors?.[f.actorId] : null;
      const mine = f && f.actorId === st.playerId;
      return listRow({
        cls: ['goal', f && 'claimed', mine && 'mine'].filter(Boolean).join(' '),
        lead: icon(mine ? 'trofeu' : f ? 'check' : 'alvo', 18), leadCls: mine ? 'lead-accent' : f ? 'lead-done' : '',
        title: g.label || FIRST_LABELS[g.id] || g.id,
        right: f ? chip(mine ? 'você primeiro' : `${who?.short || who?.name || f.actorId}`, mine ? 'good' : 'muted') : chip('em aberto', ''),
      });
    })));
}

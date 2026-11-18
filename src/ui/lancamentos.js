// Calendário de lançamentos (EXPANSION.md §12, drawer › Operações): CSmanager `.agenda-do-mes` rows by month (or by
// quarter/semester/year in the coarse eras). Shows your scheduled flights, your program items, investor deadlines
// (state.mandates, Phase B investors), the rivals' planned launches, what is in transit and what still needs a date.
// calendarModel() is pure (tests); render() only draws it.
import { h, raw, chip, fmtIn, TYPE_LABELS } from './components.js';
import { formatTurnEra, turnToDate } from '../core/time.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { missionsNeedingVehicle } from './screens.js';
import { screenHead, section, kpis, pills, listCard, countChip, note, rerender } from './screen-kit.js';

const TRUTH = { fato: 'Fato', plano_oficial: 'Plano oficial', projecao: 'Projeção', especulacao: 'Especulação' };
/** Weeks ahead the agenda looks: two years, or eight turns in the coarse eras. */
export const horizonWeeks = (stepWeeks = 1) => Math.max(104, Math.round(Number(stepWeeks) || 1) * 8);
const MAX_ROWS = 60;

const stepOf = (state, data) => Number(state?.clock?.stepWeeks) || Number(data?.scenario?.turnWeeks) || 1;
/** Bucket label at the era's precision: "mar/1962", "T3 2087", "S1 2300", "2741". */
export const bucketLabel = (turn, startYear, stepWeeks) => formatTurnEra(turn, startYear, stepWeeks);

/**
 * Pure model of the agenda. q(name, fallback, ...args) = store.tryQuery.
 * Returns {now, step, horizon, groups:[{label, items}], transit, toSchedule, counts:{all, mine, rivals, prazos}, next}.
 * item = {kind: 'mine'|'programa'|'prazo'|'rival', when, title, sub, ownerId, truth, missionId, chip, chipKind}
 */
export function calendarModel(state, data, q = () => null, { filter = 'todos' } = {}) {
  const st = state || {};
  const now = Number(st.turn) || 0;
  const step = stepOf(st, data);
  const horizon = horizonWeeks(step);
  const until = now + horizon;
  const actor = (id) => st.actors?.[id] || st.lifecycle?.tombstones?.[id] || { id };
  const shortOf = (id) => { const a = actor(id); return a.short || a.name || id || ''; };
  const destName = (id) => data?.index?.destinations?.[id]?.name || id || '';
  const items = [];

  // your scheduled flights
  for (const m of st.missions || []) {
    if (m?.status !== 'scheduled' || !Number.isFinite(m.launchTurn)) continue;
    items.push({ kind: 'mine', when: m.launchTurn, title: m.name || 'Missão', ownerId: st.playerId, missionId: m.id,
      sub: [TYPE_LABELS[m.type] || m.type, destName(m.destination)].filter(Boolean).join(' · '), chip: 'sua', chipKind: 'accent' });
  }
  // calendar: your program items not yet flown, and the rivals' planned launches
  let cal = q('calendar/all', null);
  if (!Array.isArray(cal)) cal = (st.calendar || []).map((c) => ({ ...c, ...(data?.index?.calendar?.[c.id] || {}) }));
  const transit = [];
  for (const c of cal) {
    if (!c) continue;
    const owner = c.owner;
    const when = Number.isFinite(c.currentTurn) ? c.currentTurn : c.plannedTurn;
    if (c.status === 'launched' && Number.isFinite(c.arrivalTurn) && c.arrivalTurn > now && owner !== st.playerId) {
      transit.push({ kind: 'rival', when: c.arrivalTurn, title: c.name || c.id, ownerId: owner, sub: `${shortOf(owner)} · chega a ${c.destinationName || destName(c.destination)}` });
      continue;
    }
    if (!Number.isFinite(when) || when < now || when > until) continue;
    if (c.status === 'player' || (owner === st.playerId && c.status === 'planned')) {
      if (c.outcome || (st.missions || []).some((x) => x?.calendarId === c.id && x.status !== 'cancelled')) continue;
      items.push({ kind: 'programa', when, title: c.name || c.id, ownerId: st.playerId, truth: TRUTH[c.truthLayer] || null,
        sub: `Programa · ${c.destinationName || destName(c.destination)}`, chip: 'programa', chipKind: 'accent' });
      continue;
    }
    if (c.status !== 'planned' || owner === st.playerId) continue;
    items.push({ kind: 'rival', when, title: c.name || c.id, ownerId: owner, truth: TRUTH[c.truthLayer] || null,
      sub: [shortOf(owner), c.delayWeeks > 0 ? `atraso de ${c.delayWeeks} sem` : null].filter(Boolean).join(' · '),
      chip: TRUTH[c.truthLayer] || 'Plano', chipKind: 'muted' });
  }
  // investor deadlines (Phase B investors: state.mandates)
  const holders = Object.fromEntries((st.cap?.holders || []).map((x) => [x.id, x]));
  for (const md of Array.isArray(st.mandates) ? st.mandates : []) {
    if (!md || !['open', 'flying'].includes(md.status) || !Number.isFinite(md.deadlineTurn)) continue;
    if (md.deadlineTurn < now || md.deadlineTurn > until) continue;
    const hd = holders[md.holderId];
    items.push({ kind: 'prazo', when: md.deadlineTurn, title: md.title || 'Missão do investidor', ownerId: st.playerId,
      sub: `Prazo de ${hd?.name || 'investidor'}${md.status === 'flying' ? ' · em voo' : ''}`, chip: 'prazo', chipKind: 'warn', mandateId: md.id });
  }
  // your flights in transit
  for (const m of st.missions || []) {
    const arr = m?.transit?.arriveTurn;
    if (!m || !['launch', 'transit', 'arrival'].includes(m.status) || !Number.isFinite(arr) || arr <= now) continue;
    transit.push({ kind: 'mine', when: arr, title: m.name || 'Missão', ownerId: st.playerId, missionId: m.id, sub: `Sua · chega a ${destName(m.destination)}` });
  }
  transit.sort((a, b) => a.when - b.when);

  const toSchedule = (st.missions || []).filter((m) => m?.status === 'planning').map((m) => {
    const noHw = missionsNeedingVehicle({ missions: [m] }).length > 0;
    return { kind: 'mine', when: null, title: m.name || 'Missão', missionId: m.id, ownerId: st.playerId,
      sub: [TYPE_LABELS[m.type] || m.type, destName(m.destination)].filter(Boolean).join(' · '),
      chip: noHw ? 'falta o veículo' : 'sem data', chipKind: noHw ? 'warn' : 'muted' };
  });

  items.sort((a, b) => a.when - b.when || (a.kind === 'rival') - (b.kind === 'rival') || String(a.title).localeCompare(String(b.title)));
  const isMine = (x) => x.kind !== 'rival';
  const counts = { all: items.length, mine: items.filter(isMine).length, rivals: items.filter((x) => !isMine(x)).length, prazos: items.filter((x) => x.kind === 'prazo').length };
  const shown = items.filter((x) => (filter === 'seus' ? isMine(x) : filter === 'rivais' ? !isMine(x) : true)).slice(0, MAX_ROWS);
  const groups = [];
  for (const x of shown) {
    const label = bucketLabel(x.when, st.startYear, step);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.items.push(x); else groups.push({ label, items: [x] });
  }
  const next = items.find((x) => x.kind === 'mine') || null;
  return { now, step, horizon, groups, transit: transit.slice(0, 12), toSchedule, counts, next, truncated: items.length > MAX_ROWS };
}

let filter = 'todos';

export function render(container, store, route) {
  ensurePainelCss();
  const st = store.state;
  const data = store.data;
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);
  const q = (name, fb, ...a) => store.tryQuery(name, fb, ...a);
  const m = calendarModel(st, data, q, { filter });
  const rel = (t) => fmtIn(t, st.turn);
  // the lead counts what is waiting for a date too, so it never says "nothing" next to "A agendar"
  const nTodo = m.toSchedule.length;
  const todoTxt = nTodo ? `${nTodo} ${nTodo === 1 ? 'missão' : 'missões'} a agendar` : '';
  const lead = m.counts.all
    ? [`${m.counts.all} lançamento${m.counts.all === 1 ? '' : 's'} até ${bucketLabel(st.turn + m.horizon, st.startYear, Math.max(4, m.step))}`, todoTxt].filter(Boolean).join(' · ')
    : nTodo ? `${todoTxt}; nenhum voo com data` : 'Nada no horizonte por enquanto';
  const emptyNote = filter === 'rivais' ? 'Nenhum lançamento rival no horizonte.'
    : nTodo ? 'Nenhum voo com data ainda. Agende as missões acima para entrar no calendário.'
      : filter === 'seus' ? 'Você não tem voos agendados neste período. Monte uma missão para entrar no calendário.' : 'Nenhum lançamento no horizonte.';

  const row = (x, { arrival = false } = {}) => listRow({
    cls: ['launch-row', x.kind !== 'rival' && 'mine', `agenda-${x.kind}`].filter(Boolean).join(' '),
    lead: raw(emblemSVG(x.kind === 'prazo' ? (st.actors?.[st.playerId] || {}) : (st.actors?.[x.ownerId] || st.lifecycle?.tombstones?.[x.ownerId] || { id: x.ownerId }), { size: 30 })),
    leadCls: 'pn-emblem', title: x.title,
    sub: x.when != null ? `${x.sub} · ${arrival ? `${bucketLabel(x.when, st.startYear, Math.max(4, m.step))}, ` : ''}${rel(x.when)}` : x.sub,
    meta: x.when != null && m.step === 1 && !arrival ? `sem ${turnToDate(x.when, st.startYear).week}` : null,
    right: x.chip ? chip(x.chip, x.chipKind) : null,
    onClick: x.missionId ? () => nav('missoes', `m/${x.missionId}`) : x.kind === 'prazo' ? () => nav('conselho') : x.kind === 'programa' ? () => nav('missoes') : null,
  });

  const root = h('div', { class: 'view-pad tela lancamentos' },
    screenHead({ title: 'Calendário de lançamentos', lead, primary: { label: 'Nova missão', icon: 'mais', onClick: () => nav('missoes', 'nova') } }),
    kpis([
      { label: 'Próximo voo', value: m.next ? rel(m.next.when) : '—', sub: m.next ? m.next.title : nTodo ? 'agende uma missão' : 'nenhum agendado', onClick: m.next?.missionId ? () => nav('missoes', `m/${m.next.missionId}`) : null },
      { label: 'Voos rivais', value: String(m.counts.rivals), sub: m.counts.prazos ? `planejados · ${m.counts.prazos} prazo${m.counts.prazos === 1 ? '' : 's'} de investidor` : 'planejados' },
    ], { label: 'Resumo do calendário' }),
    section('A agendar', { right: countChip(m.toSchedule.length) }, m.toSchedule.length ? listCard(m.toSchedule.map((x) => row(x))) : null),
    h('section', { class: 'tela-sec' },
      pills([
        { id: 'todos', label: 'Todos', count: m.counts.all },
        { id: 'seus', label: 'Seus', count: m.counts.mine },
        { id: 'rivais', label: 'Rivais', count: m.counts.rivals },
      ], filter, (id) => { filter = id; rerender(container, render, store, route); }, { label: 'Mostrar lançamentos' }),
      m.groups.length ? null : note(emptyNote, { icon: 'calendario' })),
    ...m.groups.map((g) => section(g.label, { cls: 'agenda-do-mes', right: countChip(g.items.length) }, listCard(g.items.map((x) => row(x))))),
    m.truncated ? note('Mostrando os primeiros 60 lançamentos.') : null,
    section('Em trânsito', { right: countChip(m.transit.length) }, m.transit.length ? listCard(m.transit.map((x) => row(x, { arrival: true }))) : null));
  container.appendChild(root);
}

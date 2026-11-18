// Anais (EXPANSION.md §12, drawer › Arquivo): the campaign's history in three views — headlines by year (state.annals,
// compacted into decades/centuries by helpers.compactAnnals), the agencies' timeline (lifecycle/timeline: births,
// renames, merges, ends) and the eras (state.eraHistory + the current one). Phase C adds content; this screen only reads.
// annalsModel() is pure (tests).
import { h, raw, chip, icon, ERA_NAMES } from './components.js';
import { eraTable, yearOf } from '../core/time.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { screenHead, section, listCard, pills, note, countChip, rerender } from './screen-kit.js';

const TRUTH = { fato: 'Fato', plano_oficial: 'Plano oficial', projecao: 'Projeção', especulacao: 'Especulação' };
const OPS = { birth: 'Nasce', rename: 'Novo nome', merge: 'Fusão', dissolve: 'Fim', end: 'Fim', nationSplit: 'País se divide', nationBirth: 'Novo país' };
const OP_ICON = { birth: 'mais', rename: 'editar', merge: 'transferir', dissolve: 'menos', end: 'menos', nationSplit: 'mundo', nationBirth: 'mundo' };
const PAGE = 24;

/** "1962", "Década de 1950", "Século de 1900" for an annals key (year | d1950 | c1900). */
export function annalKeyLabel(k) {
  const s = String(k);
  if (s[0] === 'd') return `Década de ${s.slice(1)}`;
  if (s[0] === 'c') return `Século de ${s.slice(1)}`;
  return s;
}
/** Sort value of an annals key (most recent first when sorted descending). */
const keyYear = (k) => { const s = String(k); return s[0] === 'd' ? Number(s.slice(1)) + 9.5 : s[0] === 'c' ? Number(s.slice(1)) + 99.5 : Number(s); };

const eraName = (data, id) => {
  const e = eraTable(data).eras.find((x) => x.id === id);
  return e?.name || ERA_NAMES[id] || id;
};
const eraFrom = (data, id) => { const e = eraTable(data).eras.find((x) => x.id === id); return typeof e?.from === 'number' ? e.from : e?.from?.year ?? null; };

/**
 * Pure model. q(name, fallback, ...args) = store.tryQuery.
 * {startYear, nowYear, years:[{key, label, lines:[{text, imp, turn}]}], agencies:[{year, month, op, opLabel, text, id, truth}],
 *  eras:[{id, n, name, fromYear, toYear, current, leader, firsts, headline}]}
 */
export function annalsModel(state, data, q = () => null) {
  const st = state || {};
  const sy = st.startYear ?? 0;
  const nowYear = yearOf(st, st.turn ?? 0);
  const an = st.annals && typeof st.annals === 'object' ? st.annals : {};
  const years = Object.keys(an).filter((k) => Number.isFinite(keyYear(k))).sort((a, b) => keyYear(b) - keyYear(a)).map((k) => {
    const entries = Array.isArray(an[k]) ? an[k] : [an[k]];
    const lines = entries.filter(Boolean).map((l) => (typeof l === 'string' ? { text: l, imp: 1, turn: null } : { text: String(l.h ?? l.headline ?? ''), imp: Number(l.i ?? l.importance ?? 1), turn: Number.isFinite(l.t) ? l.t : null }))
      .filter((l) => l.text);
    return { key: k, label: annalKeyLabel(k), lines };
  }).filter((y) => y.lines.length);
  let tl = q('lifecycle/timeline', null, sy, nowYear);
  if (!Array.isArray(tl)) tl = [];
  const agencies = tl.filter(Boolean).map((e) => ({ year: e.year, month: e.month ?? 0, op: e.op, opLabel: OPS[e.op] || e.op, text: e.text || '', id: e.id, truth: TRUTH[e.truthLayer] || null }))
    .sort((a, b) => b.year - a.year || b.month - a.month);
  const hist = Array.isArray(st.eraHistory) ? st.eraHistory : [];
  const eras = hist.map((e) => {
    const top = (e.standings || [])[0];
    return { id: e.eraId, name: eraName(data, e.eraId), fromYear: eraFrom(data, e.eraId), toYear: yearOf(st, e.turn ?? 0), current: false,
      leader: top?.id || null, firsts: (e.firsts || []).length, mineFirsts: (e.firsts || []).filter((f) => f.actorId === st.playerId).length, headline: e.headline || null };
  });
  const curId = st.clock?.eraId || (Array.isArray(data?.scenario?.eras) ? data.scenario.eras[0] : null);
  if (curId && !eras.some((e) => e.id === curId && e.current)) {
    const leader = Object.entries(st.actors || {}).map(([id, a]) => ({ id, p: Number.isFinite(a.prestigeEra) ? a.prestigeEra : a.prestige || 0 })).sort((a, b) => b.p - a.p)[0];
    eras.push({ id: curId, name: eraName(data, curId), fromYear: Math.max(sy, eraFrom(data, curId) ?? sy), toYear: null, current: true, leader: leader?.id || null, firsts: null, headline: null });
  }
  eras.reverse();
  for (const e of eras) e.n = Number(String(e.id).replace(/\D/g, '')) || null;
  return { startYear: sy, nowYear, years, agencies, eras };
}

let tab = 'manchetes';
let pages = 1;

export function render(container, store, route) {
  ensurePainelCss();
  const st = store.state;
  const m = annalsModel(st, store.data, (n, fb, ...a) => store.tryQuery(n, fb, ...a));
  const span = m.nowYear - m.startYear;
  const actorOf = (id) => st.actors?.[id] || st.lifecycle?.tombstones?.[id] || { id, name: id };
  const redraw = () => rerender(container, render, store, route);

  let body;
  if (tab === 'agencias') {
    body = m.agencies.length
      ? section('Agências', { right: countChip(m.agencies.length) }, listCard(m.agencies.slice(0, PAGE * pages).map((e) => listRow({
        lead: e.op === 'birth' || e.op === 'rename' ? raw(emblemSVG(actorOf(e.id), { size: 30 })) : icon(OP_ICON[e.op] || 'info', 18),
        leadCls: e.op === 'birth' || e.op === 'rename' ? 'pn-emblem' : '', title: e.text, sub: e.opLabel, meta: String(e.year),
        right: e.truth && e.truth !== 'Fato' ? chip(e.truth, 'muted') : null,
      }))))
      : note('Nenhuma agência nasceu, mudou de nome ou acabou desde o início da campanha.', { icon: 'livro' });
    if (m.agencies.length > PAGE * pages) body = [body, moreBtn(() => { pages += 1; redraw(); })];
  } else if (tab === 'eras') {
    body = section('Eras', { right: countChip(m.eras.length) }, listCard(m.eras.map((e) => {
      const leader = e.leader ? actorOf(e.leader) : null;
      const years = e.current ? `desde ${e.fromYear ?? m.startYear}` : `${e.fromYear ?? '?'}–${e.toYear}`;
      return listRow({
        cls: e.current ? 'mine' : '', lead: h('span', { class: 'mono' }, e.n ? String(e.n) : '·'), title: e.name,
        sub: [years, leader ? `${e.current ? 'lidera' : 'venceu'}: ${leader.short || leader.name}` : null, e.firsts ? `${e.firsts} primeiro${e.firsts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
        extra: e.headline ? h('span', { class: 'anais-manchete' }, e.headline) : null,
        right: e.current ? chip('agora', 'accent') : null,
      });
    })));
  } else {
    const shown = m.years.slice(0, PAGE * pages);
    body = m.years.length ? [
      ...shown.map((y) => section(y.label, { cls: 'anais-ano' }, listCard(y.lines.slice(0, 3).map((l, i) => listRow({
        cls: ['pn-hist', i === 0 && 'anais-topo'].filter(Boolean).join(' '), lead: icon(i === 0 ? 'noticia' : 'livro', 16), title: l.text,
      }))))),
      m.years.length > shown.length ? moreBtn(() => { pages += 1; redraw(); }) : null,
    ] : note('As manchetes de cada ano ficam guardadas aqui. Avance o tempo para escrever a história.', { icon: 'noticia' });
  }

  container.appendChild(h('div', { class: 'view-pad tela anais' },
    screenHead({ title: 'Anais', lead: span > 0 ? `${m.startYear}–${m.nowYear} · ${span} ano${span === 1 ? '' : 's'} de história` : `Começa em ${m.startYear}` }),
    pills([
      { id: 'manchetes', label: 'Manchetes', count: m.years.length },
      { id: 'agencias', label: 'Agências', count: m.agencies.length },
      { id: 'eras', label: 'Eras', count: m.eras.length },
    ], tab, (id) => { tab = id; pages = 1; redraw(); }, { label: 'Ver nos anais' }),
    body));
}

function moreBtn(fn) {
  return h('button', { class: 'btn btn-ghost btn-small anais-mais', type: 'button', onclick: fn }, 'Mostrar mais');
}

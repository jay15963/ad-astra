// Mundo: news feed, actors/rivals with relation bars and tension, treaties/blocs, diplomacy proposals, Tabela da Era.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtDate, fmtMonth, fmtIn, TENSION_LABELS, PROPOSAL_LABELS, FIRST_LABELS, newsIcon, iconSVG, viewHead, flagPrefix, cleanFlags,
} from './components.js';

// Mundo's own stylesheet (DESIGN.md: lists, ranking, filters). Linked as soon as this module loads (app boot), so the
// tab never paints unstyled; the service worker precaches it (it follows new URL(..., import.meta.url)).
(function linkWorldCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-world-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/world.css', import.meta.url).href;
    l.setAttribute('data-world-css', '1');
    document.head.appendChild(l);
  } catch { /* styles are optional */ }
})();

// news tags are module-internal (mixed languages); only these are shown to the player, in pt-BR
const TAG_LABELS = {
  diplomacia: 'diplomacia', diplomacy: 'diplomacia', tratado: 'tratado', ruptura: 'ruptura', bloco: 'bloco', atrito: 'atrito', aproximação: 'aproximação',
  budget: 'orçamento', economy: 'economia', market: 'mercado', mission: 'missão', launch: 'lançamento', launches: 'lançamentos',
  crew: 'equipe', research: 'pesquisa', pesquisa: 'pesquisa', secret: 'segredo', election: 'eleição', politics: 'política',
  conflict: 'conflito', tension: 'tensão', geo: 'mapa', contract: 'contrato', rival: 'rival', race: 'corrida', corrida: 'corrida',
  first: 'primeiro', failure: 'falha', success: 'sucesso', delay: 'atraso', cancel: 'cancelado', cancelled: 'cancelado',
  memorial: 'memorial', death: 'memorial', legend: 'lenda', evento: 'evento', event: 'evento', tabela: 'tabela', era: 'era',
};
import { emblemSVG } from './portrait.js';
import { relKey } from '../core/helpers.js';
import { decisionRow, sortDecisions } from './decisions.js';
import * as worldmap from './worldmap.js';

const SEGS = [
  { id: 'noticias', label: 'Notícias' },
  { id: 'atores', label: 'Atores' },
  { id: 'tratados', label: 'Tratados' },
  { id: 'tabela', label: 'Tabela' },
];
const ui = { seg: 'noticias', newsFilter: 'all', newsLimit: 30 }; // newsLimit: items shown (grows with "Ver mais")

export function render(container, store) {
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  if (SEGS.some((s) => s.id === route.sub)) ui.seg = route.sub;
  const go = (seg) => {
    ui.seg = seg;
    if (store.ui?.navigate) store.ui.navigate('mundo', seg);
    else { try { mapCleanup?.(); } catch { /* */ } container.innerHTML = ''; render(container, store); }
  };
  const st = store.state;
  const dipl = (st.decisions || []).filter((d) => /^(diplomacy|politics)/.test(String(d.kind)));
  let mapCleanup = null;
  const root = h('div', { class: 'view-pad world' },
    viewHead('Cenário internacional', { lead: 'O que rivais, governos e blocos estão fazendo', right: safePanel(() => tensionChip(store)) }),
    // sub-navigation right under the page head (CSmanager): switching tabs changes the first screen
    segmented(SEGS.map((s) => (s.id === 'atores' && dipl.length ? { ...s, badge: dipl.length } : s)), ui.seg, go, { cls: 'tabs' }),
    safePanel(() => worldMapSection(store, (fn) => { mapCleanup = fn; }), 'O mapa-múndi está fora do ar.'));
  container.appendChild(root);
  if (ui.seg === 'atores') root.append(safePanel(() => actorsView(store, dipl), 'Os atores ainda não chegaram ao mundo.'));
  else if (ui.seg === 'tratados') root.append(safePanel(() => treatiesView(store), 'Tratados e blocos em construção.'));
  else if (ui.seg === 'tabela') root.append(safePanel(() => leagueView(store), 'A Tabela da Era ainda está sendo apurada.'));
  else root.append(safePanel(() => newsView(store), 'O noticiário está fora do ar.'));
  return () => { try { mapCleanup?.(); } catch { /* */ } };
}

// ------------------------------------------------------------------ world map (collapsible, top of the tab)

const MAP_KEY = 'adastra.worldmap.open';
let mapOpen = attempt(() => localStorage.getItem(MAP_KEY) !== '0', true);
// Atores / Tratados / Tabela start with the map collapsed (their list stays on the first screen); opening it there
// lasts for the session and does not change the saved Notícias preference.
let mapOpenSub = false;

function worldMapSection(store, setCleanup) {
  const geo = store.tryQuery('geo/state', null);
  const conflicts = geo?.conflicts?.length || 0;
  const changed = (geo?.zones || []).filter((z) => z.changedTurn != null).length;
  const blocMoves = (store.state?.geo?.blocChanges || []).filter((c) => c.kind === 'country').length;
  const body = h('div', { class: 'wm-body' });
  const onNews = ui.seg === 'noticias';
  let open = onNews ? mapOpen : mapOpenSub;
  const setOpen = (v) => {
    open = v;
    if (onNews) { mapOpen = v; attempt(() => localStorage.setItem(MAP_KEY, v ? '1' : '0')); } else mapOpenSub = v;
    sec.classList.toggle('open', v);
    head.setAttribute('aria-expanded', String(v));
  };
  const sec = h('section', { class: ['wm-section', open && 'open'] });
  const toggle = () => { setOpen(!open); mount(); };
  const head = h('button', { class: 'wm-head', type: 'button', 'aria-expanded': String(open), onclick: toggle },
    h('span', { class: 'wm-head-ic', 'aria-hidden': 'true', html: iconSVG('mundo', 18) }),
    h('span', { class: 'wm-head-text' },
      h('span', { class: 'wm-head-title' }, 'Mapa-múndi'),
      // second line (never squeezed against the title / conflict chip): plain counts, neutral
      changed || blocMoves ? h('span', { class: 'wm-head-sub' },
        [changed ? `${changed} mudança${changed > 1 ? 's' : ''} de controle` : null,
          blocMoves ? `${blocMoves} mudança${blocMoves > 1 ? 's' : ''} de bloco` : null].filter(Boolean).join(' · ')) : null),
    h('span', { class: 'wm-chev', 'aria-hidden': 'true', html: iconSVG('avancar', 16) }));
  // the conflict chip is its own button (outside the collapse toggle): it opens the map on the hottest conflict
  const hottest = (geo?.conflicts || []).slice().sort((a, b) => (b.intensity || 0) - (a.intensity || 0))[0] || null;
  const focusConflict = () => {
    if (!hottest) return;
    if (!open) setOpen(true);
    mount({ conflictId: hottest.id, zoneIds: hottest.zoneIds, zoneId: hottest.zoneId });
  };
  const conflictBtn = conflicts ? chip(`${conflicts} conflito${conflicts > 1 ? 's' : ''}`, 'bad', {
    onclick: (e) => { e.stopPropagation(); focusConflict(); },
  }) : null;
  if (conflictBtn) {
    conflictBtn.classList.add('wm-conflict-chip');
    conflictBtn.setAttribute('aria-label', `Ver ${conflicts > 1 ? 'o conflito mais intenso' : 'o conflito'} no mapa`);
  }
  let cleanup = null;
  function mount(focus = null) {
    try { cleanup?.(); } catch { /* */ }
    cleanup = null;
    body.replaceChildren();
    if (open) cleanup = worldmap.render(body, store, { onActor: (id) => openActor(store, id), focus });
    setCleanup(() => { try { cleanup?.(); } catch { /* */ } });
  }
  sec.append(h('div', { class: 'wm-headrow' }, head, conflictBtn), body);
  mount();
  return sec;
}

function tensionLevel(store) {
  const w = store.tryQuery('politics/world', null) || store.state.world || {};
  return Math.max(0, Math.min(4, Math.round(Number(w.globalTension) || 0)));
}

/** 4-step tension meter (segments, not colour alone: the count of filled steps is the level). */
function tensionDots(level) {
  return h('span', { class: `w-tmeter t${level}`, role: 'img', 'aria-label': `tensão ${level} de 4` },
    [1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : null })));
}

function tensionChip(store) {
  const t = tensionLevel(store);
  return h('span', { class: `chip tension t${t}`, title: `Tensão global ${t} de 4` }, h('span', { class: 'w-tdot', 'aria-hidden': 'true' }), TENSION_LABELS[t]);
}

// ------------------------------------------------------------------ news

const NEWS_PAGE = 30;

/**
 * News feed. Filters and "Ver mais" redraw only this panel (the world map above keeps running); items after
 * the first screenful use content-visibility so a long feed costs no layout until it is scrolled into view.
 */
function newsView(store) {
  const st = store.state;
  const all = st.news || [];
  const filters = [
    { id: 'all', label: 'Todas' },
    { id: 'big', label: 'Importantes' },
    { id: 'me', label: 'Minha agência' },
  ];
  const out = h('div', { class: 'news-view' });
  const draw = () => {
    out.innerHTML = '';
    const list = all.filter((n) => ui.newsFilter === 'all' ? true : ui.newsFilter === 'big' ? n.importance >= 2 : (n.actors || []).includes(st.playerId));
    const count = (id) => all.filter((n) => id === 'big' ? n.importance >= 2 : id === 'me' ? (n.actors || []).includes(st.playerId) : true).length;
    out.append(h('div', { class: 'chip-scroll w-filters', role: 'group', 'aria-label': 'Filtrar notícias' }, filters.map((f) => {
      const on = ui.newsFilter === f.id;
      const n = f.id === 'all' ? 0 : count(f.id);
      return h('button', {
        class: ['chip', 'w-pill', on && 'active'], type: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { if (ui.newsFilter === f.id) return; ui.newsFilter = f.id; ui.newsLimit = NEWS_PAGE; draw(); },
      }, f.label, n ? h('span', { class: 'w-pill-n' }, n > 99 ? '99+' : String(n)) : null);
    })));
    if (!list.length) { out.append(emptyState('Nenhuma notícia por aqui ainda. O mundo se move a cada semana.', 'noticia')); return; }
    const feed = h('div', { class: 'news-feed' });
    out.append(feed);
    let shown = 0;
    let lastTurn = null;
    let group = null;
    const more = h('div', { class: 'news-more' });
    const appendUpTo = (limit) => {
      for (; shown < Math.min(limit, list.length); shown++) {
        const n = list[shown];
        if (n.turn !== lastTurn || !group) {
          group = h('div', { class: 'w-list news-list' });
          feed.append(h('div', { class: 'news-date' }, fmtDate(n.turn, st.startYear)), group);
          lastTurn = n.turn;
        }
        group.append(newsItem(st, n, shown >= 8));
      }
      more.innerHTML = '';
      if (list.length > shown) {
        more.append(button(`Ver mais (${list.length - shown})`, () => { ui.newsLimit = shown + NEWS_PAGE; appendUpTo(ui.newsLimit); }, { kind: 'ghost' }));
      }
    };
    appendUpTo(ui.newsLimit);
    out.append(more);
  };
  draw();
  return out;
}

function newsItem(st, n, offscreen) {
  const actors = (n.actors || []).map((id) => st.actors?.[id]).filter(Boolean);
  const mine = (n.actors || []).includes(st.playerId);
  const tags = [...new Set((n.tags || []).map((t) => TAG_LABELS[t]).filter(Boolean))].slice(0, 3);
  return h('article', {
    class: ['news-item', 'w-row', `imp-${n.importance || 1}`, mine && 'mine'],
    // below the first screenful: skip layout/paint until scrolled near (no-op where unsupported)
    style: offscreen ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 96px' } : null,
  },
  h('span', { class: 'w-lead news-icon', 'aria-hidden': 'true' }, newsIcon(n)),
  h('div', { class: 'w-main' },
    n.importance >= 3 ? h('div', { class: 'w-eyebrow accent' }, 'Destaque') : null,
    h('h3', { class: 'news-headline' }, cleanFlags(n.headline)),
    n.body ? h('p', { class: 'news-body' }, n.body) : null,
    actors.length || tags.length ? h('div', { class: 'chips w-chips' },
      actors.map((a) => chip(`${flagPrefix(a)}${a.short || a.name}`.trim(), a.id === st.playerId ? 'accent' : '')),
      tags.map((t) => chip(`#${t}`, 'muted'))) : null));
}

// ------------------------------------------------------------------ actors

function relationOf(store, a, b) {
  const st = store.state;
  return st.relations?.[relKey(a, b)] || null;
}

function actorsView(store, dipl) {
  const st = store.state;
  const others = Object.values(st.actors || {}).filter((a) => a.id !== st.playerId)
    .sort((a, b) => (b.prestige || 0) - (a.prestige || 0));
  const out = h('div');
  if (dipl.length) out.append(sectionTitle('Na sua mesa', h('span', { class: 'badge' }, String(dipl.length))), h('div', { class: 'decision-list' }, sortDecisions(dipl).map((d) => decisionRow(store, d))));
  if (!others.length) { out.append(emptyState('Nenhum outro ator no mundo ainda.', 'mundo')); return out; }
  out.append(sectionTitle('Rivais e parceiros', h('span', { class: 'w-count' }, String(others.length))));
  const list = h('div', { class: 'w-list actor-list' });
  for (const a of others) {
    const rel = relationOf(store, st.playerId, a.id) || {};
    const t = Math.max(0, Math.min(4, Number(st.tension?.[relKey(st.playerId, a.id)]) || 0));
    const sameBloc = a.bloc && st.actors?.[st.playerId]?.bloc === a.bloc;
    const open = () => openActor(store, a.id);
    list.append(h('div', {
      class: 'w-row w-row-tap actor-row', role: 'button', tabindex: '0', onclick: open,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
    },
    h('div', { class: 'w-row-top' },
      raw(emblemSVG(a, { size: 36 }), 'w-emblem'),
      h('div', { class: 'w-main' },
        h('b', { class: 'w-name' }, `${flagPrefix(a)}${a.name}`),
        h('span', { class: 'w-sub' }, [a.style || (a.kind === 'company' ? 'Empresa' : 'Agência'), !sameBloc && a.bloc ? blocName(store, a.bloc) : null].filter(Boolean).join(' · '))),
      h('div', { class: 'w-side' },
        h('span', { class: 'w-pts', title: 'Prestígio' }, String(Math.round(a.prestige || 0)), h('small', null, ' pts')),
        h('span', { title: TENSION_LABELS[t] }, tensionDots(t))),
      h('span', { class: 'w-chev', 'aria-hidden': 'true', html: iconSVG('avancar', 16) })),
    h('div', { class: 'rel-bars' },
      bar(rel.trust ?? 0, { min: -100, max: 100, center: true, label: `Confiança ${Math.round(rel.trust ?? 0)}` }),
      bar(rel.rivalry ?? 0, { label: 'Rivalidade', kind: 'bad', key: `riv.${a.id}` }),
      bar(rel.dependence ?? 0, { label: 'Dependência', kind: 'info', key: `dep.${a.id}` })),
    sameBloc || t > 0 ? h('div', { class: 'chips w-chips' },
      sameBloc ? chip('mesmo bloco', 'good') : null,
      t > 0 ? chip(TENSION_LABELS[t], t >= 3 ? 'bad' : 'warn') : null) : null));
  }
  out.append(list);
  return out;
}

function blocName(store, id) {
  return store.state.blocs?.[id]?.name || (store.data?.actors?.blocs || []).find((b) => b.id === id)?.name || id;
}

function proposalTypes(store, to) {
  const q = store.tryQuery('diplomacy/proposalTypes', null, to);
  const list = Array.isArray(q) ? q : q && typeof q === 'object' ? Object.entries(q).map(([id, v]) => ({ id, ...(typeof v === 'object' ? v : { label: v }) })) : Object.keys(PROPOSAL_LABELS).map((id) => ({ id }));
  return list.map((t) => (typeof t === 'string' ? { id: t } : t)).filter((t) => t.id !== 'join_bloc')
    .map((t) => ({ ...t, label: t.label || t.name || PROPOSAL_LABELS[t.id] || t.id, ok: t.available !== false }));
}

function openActor(store, actorId) {
  const st = store.state;
  const a = st.actors?.[actorId];
  if (!a) return;
  const me = st.playerId;
  const rel = relationOf(store, me, actorId) || {};
  const t = Number(st.tension?.[relKey(me, actorId)]) || 0;
  const pol = st.politics?.[actorId] || {};
  const pending = (st.proposals || []).filter((p) => (p.from === me && p.to === actorId) || (p.to === me && p.from === actorId));
  const treaties = (st.treaties || []).filter((x) => x.status === 'active' && x.parties?.includes(actorId) && x.parties?.includes(me));
  const types = proposalTypes(store, actorId);
  openModal((close) => h('div', { class: 'actor-sheet' },
    h('div', { class: 'actor-hero' }, raw(emblemSVG(a, { size: 56 })),
      h('div', null, h('div', { class: 'w-eyebrow' }, `${a.country || ''} · ${a.kind === 'company' ? 'empresa' : 'agência'}`), h('p', null, a.style || ''))),
    h('div', { class: 'stat-grid w-kpis' },
      stat('Verba/ano', fmtMoney(a.budget)), stat('Prestígio', String(Math.round(a.prestige || 0))),
      stat('Apoio interno', String(Math.round(a.support ?? 0))), stat('Tensão', TENSION_LABELS[Math.round(t)] || '—', true)),
    h('div', { class: 'rel-bars' },
      bar(rel.trust ?? 0, { min: -100, max: 100, center: true, label: `Confiança ${Math.round(rel.trust ?? 0)}` }),
      bar(rel.rivalry ?? 0, { label: 'Rivalidade', kind: 'bad' }),
      bar(rel.dependence ?? 0, { label: 'Dependência', kind: 'info' })),
    pol.nextElectionTurn != null ? h('p', { class: 'small muted' }, `Próxima eleição ${fmtIn(pol.nextElectionTurn, st.turn)}.`) : null,
    treaties.length ? h('div', null, sectionTitle('Acordos ativos'), h('div', { class: 'chips' }, treaties.map((x) => chip(x.name || PROPOSAL_LABELS[x.type] || x.type, 'good')))) : null,
    pending.length ? h('div', null, sectionTitle('Propostas em aberto'), pending.map((p) => h('div', { class: 'small' },
      `${p.from === me ? 'Você propôs' : 'Eles propõem'}: ${PROPOSAL_LABELS[p.type] || p.type}${p.expiresTurn != null ? ` · vence ${fmtIn(p.expiresTurn, st.turn)}` : ''}`))) : null,
    sectionTitle('Propor'),
    t >= 3 ? h('p', { class: 'aviso bad' }, 'Com o conflito neste nível, a outra parte dificilmente aceita algo.') : null,
    longShotHint(types),
    h('div', { class: 'proposal-list w-list' }, types.map((pt) => h('button', {
      class: ['proposal-btn', !pt.ok && 'disabled', pt.ok && pt.chance != null && pt.chance < 0.05 && 'long-shot'], type: 'button', disabled: !pt.ok,
      // select, then confirm: a refusal costs trust, so one stray tap must not send anything
      onclick: () => confirmProposal(store, actorId, pt, close),
    },
    // same leading slot as the treaty list: emoji in a 36px circle (DESIGN §2), not inline before the title
    pt.icon ? h('span', { class: 'card-icon', 'aria-hidden': 'true' }, pt.icon) : null,
    h('span', { class: 'proposal-main' },
    h('span', { class: 'proposal-top' }, h('span', { class: 'proposal-label' }, pt.label),
      // a row you cannot send has no odds: its reason says why ("Vocês já são signatários")
      pt.ok && (pt.chanceLabel || pt.chance != null) ? chip(pt.chanceLabel || `${Math.round(pt.chance * 100)}%`, pt.chance >= 0.6 ? 'good' : pt.chance >= 0.3 ? 'warn' : 'bad') : null,
      !pt.ok ? chip(unavailableLabel(pt.reason), 'muted') : null),
    pt.termsText ? h('span', { class: 'tiny' }, pt.termsText) : pt.description ? h('span', { class: 'tiny muted' }, pt.description) : null,
    !pt.ok && pt.reason ? h('span', { class: 'tiny warn-text' }, pt.reason) : null))))),
  { title: `${flagPrefix(a)}${a.name}` });
}

/** Short tag for a proposal you cannot send, from the sim's reason. */
function unavailableLabel(reason) {
  const r = String(reason || '').toLowerCase();
  if (/signat|assinad/.test(r)) return 'já assinado';
  if (/em vigor|já existe/.test(r)) return 'acordo em vigor';
  if (/pendente|em aberto|aguard/.test(r)) return 'já proposta';
  return 'indisponível';
}

/** When nothing on the list has a real chance, say how trust is earned instead of letting the player spam refusals. */
function longShotHint(types) {
  const open = types.filter((t) => t.ok && t.chance != null);
  if (!open.length || open.some((t) => t.chance >= 0.05)) return null;
  return h('p', { class: 'small muted' }, 'Tudo aqui é quase impossível por enquanto. A confiança cresce aceitando propostas deles, voando juntos e baixando a tensão; cada recusa custa um pouco dela.');
}

/** Confirm sheet for a proposal: odds, what weighs for and against, and what a refusal costs. */
async function confirmProposal(store, actorId, pt, closeSheet) {
  const st = store.state;
  const a = st.actors?.[actorId] || { id: actorId };
  const who = a.short || a.name || actorId;
  const pre = store.tryQuery('diplomacy/preview', null, actorId, pt.id, pt.terms || {}) || {};
  const chance = pt.chance ?? pre.chance;
  const chanceText = pt.chanceLabel || pre.label || (chance != null ? `${Math.round(chance * 100)}%` : null);
  const pros = (pre.reasons || []).filter(Boolean);
  const cons = (pre.against || []).filter(Boolean);
  const trustCost = Math.abs(pt.refusalTrust ?? pre.refusalTrust ?? 1);
  const body = h('div', { class: 'proposal-confirm' },
    h('p', null, h('strong', null, `${pt.icon ? pt.icon + ' ' : ''}${pt.label}`), ` para ${who}.`),
    pt.termsText ? h('p', { class: 'small' }, pt.termsText) : null,
    chanceText ? h('p', { class: 'small' }, 'Chance de aceite: ', chip(chanceText, chance >= 0.6 ? 'good' : chance >= 0.3 ? 'warn' : 'bad')) : null,
    pros.length ? h('p', { class: 'tiny muted' }, `A favor: ${pros.join(' · ')}`) : null,
    cons.length ? h('p', { class: 'tiny muted' }, `Contra: ${cons.join(' · ')}`) : null,
    h('p', { class: 'tiny warn-text' }, `Se ${who} recusar, a confiança cai ${trustCost} ponto${trustCost === 1 ? '' : 's'} (e o recado vira notícia).`));
  if (!(await confirmDialog(body, { title: 'Enviar proposta?', okLabel: 'Enviar proposta', cancelLabel: 'Voltar' }))) return;
  // `type` is the action route, so the proposal kind travels as proposalType (see diplomacy.proposalTypeOf)
  const r = store.dispatch({ type: 'diplomacy/propose', to: actorId, proposalType: pt.id, terms: pt.terms || {} });
  if (r?.ok) {
    const st2 = r.status || (r.accepted === true ? 'accepted' : r.accepted === false ? 'rejected' : 'pending');
    toast(r.message || (st2 === 'accepted' ? `🤝 ${who} aceitou: ${pt.label}!` : st2 === 'rejected' ? `${who} recusou a proposta. Confiança −${trustCost}.` : `Proposta enviada. ${who} responde na próxima semana.`), st2 === 'rejected' ? 'warn' : 'good');
    closeSheet?.();
  } else toast(r?.error || 'Proposta não pôde ser enviada.', 'bad');
}

/** KPI tile; word = non-numeric value (set in the sans font, mono is for numbers). */
function stat(label, value, word = false) {
  return h('div', { class: 'stat' }, h('div', { class: ['stat-value', word && 'is-word'] }, value), h('div', { class: 'stat-label' }, label));
}

// ------------------------------------------------------------------ treaties & blocs

function treatiesView(store) {
  const st = store.state;
  const me = st.playerId;
  let blocs = store.tryQuery('diplomacy/blocs', null);
  blocs = Array.isArray(blocs) ? blocs : Object.values(blocs && typeof blocs === 'object' ? blocs : st.blocs || {});
  let treaties = store.tryQuery('diplomacy/treaties', null);
  treaties = Array.isArray(treaties) ? treaties : st.treaties || [];
  const out = h('div');

  out.append(sectionTitle('Blocos'));
  if (!blocs.length) out.append(emptyState('Nenhum bloco formado.', 'equipe'));
  for (const b of blocs) {
    const members = (b.members || []).map((id) => st.actors?.[id] || { id });
    const inside = b.playerMember ?? (b.members || []).includes(me);
    out.append(card({ title: b.name || b.id, subtitle: b.leader ? `Liderado por ${st.actors?.[b.leader]?.short || b.leader}` : null, right: inside ? chip('você faz parte', 'good') : null },
      h('div', { class: 'emblem-row' }, members.map((a) => raw(emblemSVG(a, { size: 30 }), 'mini-emblem'))),
      h('div', { class: 'btn-row' }, inside
        ? button('Sair do bloco', async () => {
          if (!(await confirmDialog(`Sair de "${b.name}"? Parceiros vão lembrar disso.`, { okLabel: 'Sair', danger: true }))) return;
          const r = store.dispatch({ type: 'diplomacy/leaveBloc', blocId: b.id });
          toast(r?.ok ? (r.message || 'Você saiu do bloco.') : (r?.error || 'Não foi possível sair.'), r?.ok ? 'warn' : 'bad');
        }, { kind: 'danger', small: true })
        : h('div', { class: 'btn-row grow' },
          b.joinChance != null ? h('span', { class: 'small muted' }, `Chance de aceite ${Math.round(b.joinChance * 100)}%${Math.round(b.joinChance * 100) <= 0 ? ' · sem chance agora' : ''}`) : h('span'),
          button('Pedir adesão', () => {
            const r = store.dispatch({ type: 'diplomacy/joinBloc', blocId: b.id });
            if (!r?.ok) toast(r?.error || 'Pedido recusado.', 'bad');
            else toast(r.status === 'rejected' ? `${b.name} recusou sua adesão.` : r.status === 'accepted' ? `Bem-vindo ao bloco ${b.name}!` : (r.message || 'Pedido enviado.'), r.status === 'rejected' ? 'warn' : 'good');
          }, { small: true, disabled: b.joinChance != null && Math.round(b.joinChance * 100) <= 0 }))),
      b.cohesion != null ? bar(b.cohesion, { min: -100, max: 100, center: true, label: `Coesão ${b.cohesion}` }) : null));
  }

  const active = treaties.filter((t) => t.status === 'active');
  const past = treaties.filter((t) => t.status !== 'active');
  out.append(sectionTitle('Tratados em vigor', h('span', { class: 'w-count' }, String(active.length))));
  if (!active.length) out.append(emptyState('Nenhum tratado em vigor.', 'transferir'));
  if (active.length) out.append(h('div', { class: 'w-list treaty-list' }, active.map((t) => treatyCard(store, t))));
  if (past.length) {
    out.append(sectionTitle('Histórico'));
    out.append(h('div', { class: 'w-list treaty-list' }, past.slice(-8).reverse().map((t) => treatyCard(store, t))));
  }
  return out;
}

function treatyCard(store, t) {
  const st = store.state;
  const mine = t.parties?.includes(st.playerId);
  const S = { active: ['em vigor', 'good'], broken: ['rompido', 'bad'], expired: ['expirou', 'muted'] };
  const [sl, sk] = S[t.status] || [t.status, 'muted'];
  return card({ icon: t.icon || null, title: t.name || t.typeName || PROPOSAL_LABELS[t.type] || t.type, subtitle: [t.typeName && t.typeName !== t.name ? t.typeName : null, t.signedTurn != null ? `assinado em ${fmtMonth(t.signedTurn, st.startYear)}` : null, t.untilYear ? `até ${t.untilYear}` : null].filter(Boolean).join(' · '), right: chip(t.statusLabel || sl, sk), cls: mine ? 'mine' : '' },
    h('div', { class: 'emblem-row' }, (t.parties || []).map((id) => raw(emblemSVG(st.actors?.[id] || { id }, { size: 28 }), 'mini-emblem'))),
    (t.canBreak ?? (mine && t.status === 'active')) ? button('Romper tratado', async () => {
      if (!(await confirmDialog('Romper este tratado custa reputação e vira manchete. Continuar?', { okLabel: 'Romper', danger: true }))) return;
      const r = store.dispatch({ type: 'diplomacy/breakTreaty', treatyId: t.id });
      toast(r?.ok ? (r.message || 'Tratado rompido.') : (r?.error || 'Não foi possível.'), r?.ok ? 'warn' : 'bad');
    }, { kind: 'danger', small: true }) : null);
}

// ------------------------------------------------------------------ league

function leagueView(store) {
  const st = store.state;
  const q = store.tryQuery('league/table', null);
  let rows = Array.isArray(q) ? q : Array.isArray(q?.rows) ? q.rows : null;
  if (!rows) rows = Object.values(st.actors || {}).map((a) => ({ actorId: a.id, prestige: a.prestige || 0 })).sort((a, b) => b.prestige - a.prestige);
  rows = rows.map((r) => ({ ...r, actorId: r.actorId || r.id }));
  const top = Math.max(1, ...rows.map((r) => r.prestige || 0));
  const firstsBy = {};
  for (const [mid, f] of Object.entries(st.firsts || {})) {
    if (mid.includes(':')) continue; // per-actor national milestones don't count as global firsts
    (firstsBy[f.actorId] ||= []).push(mid);
  }
  const out = h('div', null,
    h('p', { class: 'w-lead-text' }, 'Classificação por prestígio. Ser o primeiro num marco vale muito mais do que chegar depois.'));
  if (!rows.length) { out.append(emptyState('Sem atores na tabela.', 'trofeu')); return out; }
  out.append(h('div', { class: 'w-list league-card' },
    h('div', { class: 'league-th', 'aria-hidden': 'true' }, h('span', { class: 'rank' }, '#'), h('span', { class: 'league-th-name' }, 'Ator'), h('span', { class: 'league-th-pts' }, 'Prestígio')),
    h('ol', { class: 'league' }, rows.map((r, i) => {
      const a = st.actors?.[r.actorId] || { id: r.actorId };
      const n = r.firstsCount ?? firstsBy[r.actorId]?.length ?? 0;
      const me = r.actorId === st.playerId;
      return h('li', { class: ['league-row', me && 'me'] },
        h('span', { class: ['rank', i < 3 && 'selo', i === 0 && 'gold'] }, `${i + 1}º`),
        raw(emblemSVG(a, { size: 28 }), 'mini-emblem'),
        h('div', { class: 'league-text' },
          h('div', { class: 'league-name' }, `${flagPrefix(a)}${a.short || a.name || r.actorId}`, me ? h('span', { class: 'chip chip-accent league-you' }, 'você') : null),
          bar(r.prestige || 0, { max: top, key: `lg.${r.actorId}`, kind: me ? 'accent' : '' })),
        h('div', { class: 'league-pts' }, h('strong', null, String(Math.round(r.prestige || 0))), n ? h('div', { class: 'league-firsts' }, `${n} primeiro${n > 1 ? 's' : ''}`) : null));
    }))));
  out.append(sectionTitle('Os primeiros'));
  out.append(h('div', { class: 'firsts w-list' }, Object.entries(FIRST_LABELS).filter(([id]) => id !== 'crewed_orbit_national').map(([id, label]) => {
    const f = st.firsts?.[id];
    const a = f ? st.actors?.[f.actorId] : null;
    // feats history already saw (Apollo, Luna...) are "do século" in this race
    const hist = st.firstsHistory?.[id] || (f?.era ? {} : null);
    return h('div', { class: ['first-row', f && 'claimed', f?.actorId === st.playerId && 'mine'] },
      h('span', { class: 'goal-mark w-mark', 'aria-hidden': 'true', html: f ? iconSVG(f.actorId === st.playerId ? 'trofeu' : 'check', 18) : '' }),
      h('span', { class: 'first-label' }, label,
        hist ? h('span', { class: 'tiny muted first-hist' }, ` · ${f ? 'primeiro do século; ' : ''}história: ${hist.mission || hist.holder} (${hist.year})`) : null),
      f ? chip(`${a?.short || f.actorId} · ${fmtMonth(f.turn, st.startYear)}`, f.actorId === st.playerId ? 'good' : 'muted') : chip('em aberto', 'muted'));
  })));
  return out;
}

// Mundo: news feed, actors/rivals with relation bars and tension, treaties/blocs, diplomacy proposals, Tabela da Era.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtDate, fmtMonth, fmtIn, TENSION_LABELS, PROPOSAL_LABELS, FIRST_LABELS, newsIcon,
} from './components.js';

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
    h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'Mundo'), safePanel(() => tensionChip(store))),
    safePanel(() => worldMapSection(store, (fn) => { mapCleanup = fn; }), 'O mapa-múndi está fora do ar.'),
    segmented(SEGS.map((s) => (s.id === 'atores' && dipl.length ? { ...s, badge: dipl.length } : s)), ui.seg, go));
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

function worldMapSection(store, setCleanup) {
  const geo = store.tryQuery('geo/state', null);
  const conflicts = geo?.conflicts?.length || 0;
  const changed = (geo?.zones || []).filter((z) => z.changedTurn != null).length;
  const blocMoves = (store.state?.geo?.blocChanges || []).filter((c) => c.kind === 'country').length;
  const body = h('div', { class: 'wm-body' });
  const sec = h('section', { class: ['wm-section', mapOpen && 'open'] });
  const toggle = () => {
    mapOpen = !mapOpen;
    attempt(() => localStorage.setItem(MAP_KEY, mapOpen ? '1' : '0'));
    sec.classList.toggle('open', mapOpen);
    head.setAttribute('aria-expanded', String(mapOpen));
    mount();
  };
  const head = h('button', { class: 'wm-head', type: 'button', 'aria-expanded': String(mapOpen), onclick: toggle },
    h('span', { class: 'wm-head-title' }, '🗺️ Mapa-múndi'),
    h('span', { class: 'wm-head-chips' },
      changed ? chip(`${changed} mudança${changed > 1 ? 's' : ''} de controle`, 'warn') : null,
      blocMoves ? chip(`🏳️ ${blocMoves} mudança${blocMoves > 1 ? 's' : ''} de bloco`, 'muted', { title: `${blocMoves} mudança${blocMoves > 1 ? 's' : ''} de bloco desde o início` }) : null),
    h('span', { class: 'wm-chev', 'aria-hidden': 'true' }, '▾'));
  // the conflict chip is its own button (outside the collapse toggle): it opens the map on the hottest conflict
  const hottest = (geo?.conflicts || []).slice().sort((a, b) => (b.intensity || 0) - (a.intensity || 0))[0] || null;
  const focusConflict = () => {
    if (!hottest) return;
    if (!mapOpen) {
      mapOpen = true;
      attempt(() => localStorage.setItem(MAP_KEY, '1'));
      sec.classList.add('open');
      head.setAttribute('aria-expanded', 'true');
    }
    mount({ conflictId: hottest.id, zoneIds: hottest.zoneIds, zoneId: hottest.zoneId });
  };
  const conflictBtn = conflicts ? chip(`⚔ ${conflicts} conflito${conflicts > 1 ? 's' : ''}`, 'bad', {
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
    if (mapOpen) cleanup = worldmap.render(body, store, { onActor: (id) => openActor(store, id), focus });
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

function tensionDots(level) {
  return h('span', { class: `tension-dots t${level}`, 'aria-label': `tensão ${level} de 4` }, '●'.repeat(level) + '○'.repeat(4 - level));
}

function tensionChip(store) {
  const t = tensionLevel(store);
  return h('span', { class: `chip tension t${t}` }, tensionDots(t), ` ${TENSION_LABELS[t]}`);
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
    out.append(h('div', { class: 'chip-scroll' }, filters.map((f) => chip(f.label, ui.newsFilter === f.id ? 'accent' : '', {
      onclick: () => { if (ui.newsFilter === f.id) return; ui.newsFilter = f.id; ui.newsLimit = NEWS_PAGE; draw(); },
    }))));
    if (!list.length) { out.append(emptyState('Nenhuma notícia por aqui ainda. O mundo se move a cada semana.', '📰')); return; }
    const feed = h('div', { class: 'news-feed' });
    out.append(feed);
    let shown = 0;
    let lastTurn = null;
    const more = h('div', { class: 'news-more' });
    const appendUpTo = (limit) => {
      for (; shown < Math.min(limit, list.length); shown++) {
        const n = list[shown];
        if (n.turn !== lastTurn) { feed.append(h('div', { class: 'news-date' }, fmtDate(n.turn, st.startYear))); lastTurn = n.turn; }
        feed.append(newsItem(st, n, shown >= 8));
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
  return h('article', {
    class: ['news-item', `imp-${n.importance || 1}`],
    // below the first screenful: skip layout/paint until scrolled near (no-op where unsupported)
    style: offscreen ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 110px' } : null,
  },
  h('div', { class: 'news-head' },
    h('span', { class: 'news-icon', 'aria-hidden': 'true' }, newsIcon(n)),
    h('h3', { class: 'news-headline' }, n.headline)),
  n.body ? h('p', { class: 'news-body small' }, n.body) : null,
  actors.length || n.tags?.length ? h('div', { class: 'chips' },
    actors.map((a) => chip(`${a.flag || ''} ${a.short || a.name}`.trim(), 'muted')),
    [...new Set((n.tags || []).map((t) => TAG_LABELS[t]).filter(Boolean))].slice(0, 3).map((t) => chip(`#${t}`, 'muted'))) : null);
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
  if (dipl.length) out.append(sectionTitle('Na sua mesa'), h('div', { class: 'decision-list' }, sortDecisions(dipl).map((d) => decisionRow(store, d))));
  if (!others.length) { out.append(emptyState('Nenhum outro ator no mundo ainda.', '🌐')); return out; }
  out.append(sectionTitle('Rivais e parceiros'));
  for (const a of others) {
    const rel = relationOf(store, st.playerId, a.id) || {};
    const t = Math.max(0, Math.min(4, Number(st.tension?.[relKey(st.playerId, a.id)]) || 0));
    const sameBloc = a.bloc && st.actors?.[st.playerId]?.bloc === a.bloc;
    out.append(card({
      cls: 'actor-card', onClick: () => openActor(store, a.id), icon: raw(emblemSVG(a, { size: 40 })),
      title: `${a.flag ? a.flag + ' ' : ''}${a.name}`, subtitle: a.style || (a.kind === 'company' ? 'Empresa' : 'Agência'),
      right: h('span', { class: `chip tension t${t}`, title: TENSION_LABELS[t] }, tensionDots(t)),
    },
    h('div', { class: 'rel-bars' },
      bar(rel.trust ?? 0, { min: -100, max: 100, center: true, label: `Confiança ${Math.round(rel.trust ?? 0)}` }),
      bar(rel.rivalry ?? 0, { label: 'Rivalidade', kind: 'bad', key: `riv.${a.id}` }),
      bar(rel.dependence ?? 0, { label: 'Dependência', kind: 'info', key: `dep.${a.id}` })),
    h('div', { class: 'chips' },
      sameBloc ? chip('mesmo bloco', 'good') : a.bloc ? chip(blocName(store, a.bloc), 'muted') : null,
      t > 0 ? chip(TENSION_LABELS[t], t >= 3 ? 'bad' : 'warn') : null,
      chip(`★ ${Math.round(a.prestige || 0)}`, 'muted'))));
  }
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
    h('div', { class: 'actor-hero' }, raw(emblemSVG(a, { size: 72 })),
      h('div', null, h('div', { class: 'small muted' }, `${a.country || ''} · ${a.kind === 'company' ? 'empresa' : 'agência'}`), h('p', null, a.style || ''))),
    h('div', { class: 'stat-grid' },
      stat('Verba/ano', fmtMoney(a.budget)), stat('Prestígio', String(Math.round(a.prestige || 0))),
      stat('Apoio interno', String(Math.round(a.support ?? 0))), stat('Tensão', TENSION_LABELS[Math.round(t)] || '—')),
    h('div', { class: 'rel-bars' },
      bar(rel.trust ?? 0, { min: -100, max: 100, center: true, label: `Confiança ${Math.round(rel.trust ?? 0)}` }),
      bar(rel.rivalry ?? 0, { label: 'Rivalidade', kind: 'bad' }),
      bar(rel.dependence ?? 0, { label: 'Dependência', kind: 'info' })),
    pol.nextElectionTurn != null ? h('p', { class: 'small muted' }, `Próxima eleição ${fmtIn(pol.nextElectionTurn, st.turn)}.`) : null,
    treaties.length ? h('div', null, sectionTitle('Acordos ativos'), h('div', { class: 'chips' }, treaties.map((x) => chip(x.name || PROPOSAL_LABELS[x.type] || x.type, 'good')))) : null,
    pending.length ? h('div', null, sectionTitle('Propostas em aberto'), pending.map((p) => h('div', { class: 'small' },
      `${p.from === me ? 'Você propôs' : 'Eles propõem'}: ${PROPOSAL_LABELS[p.type] || p.type}${p.expiresTurn != null ? ` · vence ${fmtIn(p.expiresTurn, st.turn)}` : ''}`))) : null,
    sectionTitle('Propor'),
    t >= 3 ? h('p', { class: 'warn-text small' }, 'Com o conflito neste nível, a outra parte dificilmente aceita algo.') : null,
    longShotHint(types),
    h('div', { class: 'proposal-list' }, types.map((pt) => h('button', {
      class: ['proposal-btn', !pt.ok && 'disabled', pt.ok && pt.chance != null && pt.chance < 0.05 && 'long-shot'], type: 'button', disabled: !pt.ok,
      // select, then confirm: a refusal costs trust, so one stray tap must not send anything
      onclick: () => confirmProposal(store, actorId, pt, close),
    },
    h('span', { class: 'proposal-top' }, h('span', { class: 'proposal-label' }, `${pt.icon ? pt.icon + ' ' : ''}${pt.label}`),
      // a row you cannot send has no odds: its reason says why ("Vocês já são signatários")
      pt.ok && (pt.chanceLabel || pt.chance != null) ? chip(pt.chanceLabel || `${Math.round(pt.chance * 100)}%`, pt.chance >= 0.6 ? 'good' : pt.chance >= 0.3 ? 'warn' : 'bad') : null,
      !pt.ok ? chip(unavailableLabel(pt.reason), 'muted') : null),
    pt.termsText ? h('span', { class: 'tiny' }, pt.termsText) : pt.description ? h('span', { class: 'tiny muted' }, pt.description) : null,
    !pt.ok && pt.reason ? h('span', { class: 'tiny warn-text' }, pt.reason) : null)))),
  { title: `${a.flag ? a.flag + ' ' : ''}${a.name}` });
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

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
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
  if (!blocs.length) out.append(emptyState('Nenhum bloco formado.', '🧩'));
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
        }, { kind: 'ghost', small: true })
        : h('div', { class: 'btn-row grow' },
          b.joinChance != null ? h('span', { class: 'small muted' }, `Chance de aceite ${Math.round(b.joinChance * 100)}%`) : h('span'),
          button('Pedir adesão', () => {
            const r = store.dispatch({ type: 'diplomacy/joinBloc', blocId: b.id });
            if (!r?.ok) toast(r?.error || 'Pedido recusado.', 'bad');
            else toast(r.status === 'rejected' ? `${b.name} recusou sua adesão.` : r.status === 'accepted' ? `Bem-vindo ao bloco ${b.name}!` : (r.message || 'Pedido enviado.'), r.status === 'rejected' ? 'warn' : 'good');
          }, { kind: 'primary', small: true }))),
      b.cohesion != null ? bar(b.cohesion, { min: -100, max: 100, center: true, label: `Coesão ${b.cohesion}` }) : null));
  }

  const active = treaties.filter((t) => t.status === 'active');
  const past = treaties.filter((t) => t.status !== 'active');
  out.append(sectionTitle('Tratados em vigor', chip(String(active.length), 'muted')));
  if (!active.length) out.append(emptyState('Nenhum tratado em vigor.', '📜'));
  for (const t of active) out.append(treatyCard(store, t));
  if (past.length) {
    out.append(sectionTitle('Histórico'));
    for (const t of past.slice(-8).reverse()) out.append(treatyCard(store, t));
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
    h('p', { class: 'muted small' }, 'Classificação por prestígio. Ser o primeiro num marco vale muito mais do que chegar depois.'));
  if (!rows.length) { out.append(emptyState('Sem atores na tabela.', '🏆')); return out; }
  out.append(h('ol', { class: 'league' }, rows.map((r, i) => {
    const a = st.actors?.[r.actorId] || { id: r.actorId };
    const n = r.firstsCount ?? firstsBy[r.actorId]?.length ?? 0;
    return h('li', { class: ['league-row', r.actorId === st.playerId && 'me'] },
      h('span', { class: 'rank' }, i === 0 ? '🏆' : `${i + 1}º`),
      raw(emblemSVG(a, { size: 32 }), 'mini-emblem'),
      h('div', { class: 'league-text' },
        h('div', { class: 'league-name' }, `${a.flag ? a.flag + ' ' : ''}${a.short || a.name || r.actorId}`),
        bar(r.prestige || 0, { max: top, key: `lg.${r.actorId}`, kind: r.actorId === st.playerId ? 'accent' : '' })),
      h('div', { class: 'league-pts' }, h('strong', null, String(Math.round(r.prestige || 0))), n ? h('div', { class: 'tiny muted' }, `${n} primeiro${n > 1 ? 's' : ''}`) : null));
  })));
  out.append(sectionTitle('Os Primeiros'));
  out.append(h('div', { class: 'firsts' }, Object.entries(FIRST_LABELS).filter(([id]) => id !== 'crewed_orbit_national').map(([id, label]) => {
    const f = st.firsts?.[id];
    const a = f ? st.actors?.[f.actorId] : null;
    // feats history already saw (Apollo, Luna...) are "do século" in this race
    const hist = st.firstsHistory?.[id] || (f?.era ? {} : null);
    return h('div', { class: ['first-row', f && 'claimed', f?.actorId === st.playerId && 'mine'] },
      h('span', { class: 'goal-mark', 'aria-hidden': 'true' }, f ? (f.actorId === st.playerId ? '★' : '✓') : '○'),
      h('span', { class: 'first-label' }, label,
        hist ? h('span', { class: 'tiny muted first-hist' }, ` · ${f ? 'primeiro do século; ' : ''}história: ${hist.mission || hist.holder} (${hist.year})`) : null),
      f ? chip(`${a?.short || f.actorId} · ${fmtMonth(f.turn, st.startYear)}`, f.actorId === st.playerId ? 'good' : 'muted') : chip('em aberto', 'muted'));
  })));
  return out;
}

// Mundo: news feed, actors/rivals with relation bars and tension, treaties/blocs, diplomacy proposals, Tabela da Era.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtDate, fmtMonth, fmtIn, TENSION_LABELS, PROPOSAL_LABELS, FIRST_LABELS,
} from './components.js';
import { emblemSVG } from './portrait.js';
import { relKey } from '../core/helpers.js';
import { decisionRow, sortDecisions } from './decisions.js';

const SEGS = [
  { id: 'noticias', label: 'Notícias' },
  { id: 'atores', label: 'Atores' },
  { id: 'tratados', label: 'Tratados' },
  { id: 'tabela', label: 'Tabela' },
];
const ui = { seg: 'noticias', newsFilter: 'all', newsLimit: 30 };

export function render(container, store) {
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  if (SEGS.some((s) => s.id === route.sub)) ui.seg = route.sub;
  const rerender = () => { container.innerHTML = ''; render(container, store); };
  const go = (seg) => { ui.seg = seg; store.ui?.navigate ? store.ui.navigate('mundo', seg) : rerender(); };
  const st = store.state;
  const dipl = (st.decisions || []).filter((d) => /^(diplomacy|politics)/.test(String(d.kind)));
  const root = h('div', { class: 'view-pad world' },
    h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'Mundo'), safePanel(() => tensionChip(store))),
    segmented(SEGS.map((s) => (s.id === 'atores' && dipl.length ? { ...s, badge: dipl.length } : s)), ui.seg, go));
  container.appendChild(root);
  if (ui.seg === 'atores') root.append(safePanel(() => actorsView(store, dipl), 'Os atores ainda não chegaram ao mundo.'));
  else if (ui.seg === 'tratados') root.append(safePanel(() => treatiesView(store), 'Tratados e blocos em construção.'));
  else if (ui.seg === 'tabela') root.append(safePanel(() => leagueView(store), 'A Tabela da Era ainda está sendo apurada.'));
  else root.append(safePanel(() => newsView(store, rerender), 'O noticiário está fora do ar.'));
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

function newsView(store, rerender) {
  const st = store.state;
  const all = st.news || [];
  const filters = [
    { id: 'all', label: 'Todas' },
    { id: 'big', label: 'Importantes' },
    { id: 'me', label: 'Minha agência' },
  ];
  const list = all.filter((n) => ui.newsFilter === 'all' ? true : ui.newsFilter === 'big' ? n.importance >= 2 : (n.actors || []).includes(st.playerId));
  const out = h('div', null,
    h('div', { class: 'chip-scroll' }, filters.map((f) => chip(f.label, ui.newsFilter === f.id ? 'accent' : '', { onclick: () => { ui.newsFilter = f.id; ui.newsLimit = 30; rerender(); } }))));
  if (!list.length) { out.append(emptyState('Nenhuma notícia por aqui ainda. O mundo se move a cada semana.', '📰')); return out; }
  let lastTurn = null;
  const feed = h('div', { class: 'news-feed' });
  for (const n of list.slice(0, ui.newsLimit)) {
    if (n.turn !== lastTurn) { feed.append(h('div', { class: 'news-date' }, fmtDate(n.turn, st.startYear))); lastTurn = n.turn; }
    const actors = (n.actors || []).map((id) => st.actors?.[id]).filter(Boolean);
    feed.append(h('article', { class: ['news-item', `imp-${n.importance || 1}`] },
      h('div', { class: 'news-head' },
        h('span', { class: 'news-icon', 'aria-hidden': 'true' }, n.icon || (n.importance >= 3 ? '⚡' : n.importance >= 2 ? '◆' : '•')),
        h('h3', { class: 'news-headline' }, n.headline)),
      n.body ? h('p', { class: 'news-body small' }, n.body) : null,
      actors.length || n.tags?.length ? h('div', { class: 'chips' },
        actors.map((a) => chip(`${a.flag || ''} ${a.short || a.name}`.trim(), 'muted')),
        (n.tags || []).slice(0, 3).map((t) => chip(`#${t}`, 'muted'))) : null));
  }
  out.append(feed);
  if (list.length > ui.newsLimit) out.append(button('Ver mais', () => { ui.newsLimit += 30; rerender(); }, { kind: 'ghost' }));
  return out;
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
    h('div', { class: 'proposal-list' }, proposalTypes(store, actorId).map((pt) => h('button', {
      class: ['proposal-btn', !pt.ok && 'disabled'], type: 'button', disabled: !pt.ok,
      onclick: () => {
        // `type` is the action route, so the proposal kind travels as proposalType (see diplomacy.proposalTypeOf)
        const r = store.dispatch({ type: 'diplomacy/propose', to: actorId, proposalType: pt.id, terms: pt.terms || {} });
        const who = a.short || a.name;
        if (r?.ok) {
          const st2 = r.status || (r.accepted === true ? 'accepted' : r.accepted === false ? 'rejected' : 'pending');
          toast(r.message || (st2 === 'accepted' ? `🤝 ${who} aceitou: ${pt.label}!` : st2 === 'rejected' ? `${who} recusou a proposta.` : `Proposta enviada. ${who} responde na próxima semana.`), st2 === 'rejected' ? 'warn' : 'good');
          close();
        } else toast(r?.error || 'Proposta não pôde ser enviada.', 'bad');
      },
    },
    h('span', { class: 'proposal-top' }, h('span', { class: 'proposal-label' }, `${pt.icon ? pt.icon + ' ' : ''}${pt.label}`),
      pt.chanceLabel || pt.chance != null ? chip(pt.chanceLabel || `${Math.round(pt.chance * 100)}%`, pt.chance >= 0.6 ? 'good' : pt.chance >= 0.3 ? 'warn' : 'bad') : null),
    pt.termsText ? h('span', { class: 'tiny' }, pt.termsText) : pt.description ? h('span', { class: 'tiny muted' }, pt.description) : null,
    !pt.ok && pt.reason ? h('span', { class: 'tiny warn-text' }, pt.reason) : null)))),
  { title: `${a.flag ? a.flag + ' ' : ''}${a.name}` });
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
    return h('div', { class: ['first-row', f && 'claimed', f?.actorId === st.playerId && 'mine'] },
      h('span', { class: 'goal-mark', 'aria-hidden': 'true' }, f ? (f.actorId === st.playerId ? '★' : '✓') : '○'),
      h('span', { class: 'first-label' }, label),
      f ? chip(`${a?.short || f.actorId} · ${fmtMonth(f.turn, st.startYear)}`, f.actorId === st.playerId ? 'good' : 'muted') : chip('em aberto', 'muted'));
  })));
  return out;
}

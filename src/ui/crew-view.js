// Equipe (from the Painel "equipe" number): roster with portraits, hiring, Memorial and Álbum da Agência.
// Layout per docs/DESIGN.md §5 B2: CSmanager "Elenco" 2-column person cards for the roster, list rows for former
// members and history, bottom sheet for a person.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  viewHead, fmtMoney, fmtDate, fmtMonth, ROLE_LABELS,
} from './components.js';
import { portraitSVG } from './portrait.js';
import { listRow, ensurePainelCss } from './decisions.js';

const SEGS = [
  { id: 'equipe', label: 'Equipe' },
  { id: 'contratar', label: 'Contratar' },
  { id: 'memorial', label: 'Memorial' },
  { id: 'album', label: 'Álbum' },
];
const ROLE_ORDER = ['flight_director', 'astronaut', 'engineer'];
const ROLE_PLURAL = { flight_director: 'Diretores de voo', astronaut: 'Astronautas', engineer: 'Engenharia' };
const ui = { seg: 'equipe' };

export function render(container, store) {
  ensurePainelCss();
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  if (SEGS.some((s) => s.id === route.sub)) ui.seg = route.sub;
  const rerender = () => { container.innerHTML = ''; render(container, store); };
  const go = (seg) => { ui.seg = seg; store.ui?.navigate ? store.ui.navigate('equipe', seg) : rerender(); };
  const root = h('div', { class: 'view-pad crew' },
    viewHead('Pessoal da agência', {
      lead: attempt(() => teamLead(store), null),
      right: button('Painel', () => store.ui?.navigate?.('painel'), { kind: 'ghost', small: true, icon: 'voltar', iconSize: 16 }),
    }),
    segmented(SEGS.map((s) => (s.id === 'memorial' && store.state.memorial?.length ? { ...s, badge: store.state.memorial.length } : s)), ui.seg, go, { cls: 'tabs' }));
  container.appendChild(root);
  if (ui.seg === 'contratar') root.append(safePanel(() => candidatesView(store), 'Contratações indisponíveis por enquanto.'));
  else if (ui.seg === 'memorial') root.append(safePanel(() => memorialView(store), 'O Memorial não pôde ser exibido.'));
  else if (ui.seg === 'album') root.append(safePanel(() => albumView(store), 'O Álbum não pôde ser exibido.'));
  else root.append(safePanel(() => rosterView(store), 'A equipe ainda está sendo formada.'));
}

function roster(store) {
  const st = store.state;
  const q = store.tryQuery('crew/roster', null);
  return Array.isArray(q) ? q : Object.values(st.crew || {}).filter((c) => c?.actorId === st.playerId);
}

const isActive = (p) => (p.status ?? 'active') === 'active' || p.status === 'injured';

/** "9 pessoas · folha US$ 4 mi/sem · 1 lenda" */
function teamLead(store) {
  const active = roster(store).filter(isActive);
  if (!active.length) return 'Ninguém contratado ainda';
  const salary = active.reduce((s, p) => s + (Number(p.salaryM) || 0), 0);
  const legends = active.filter((p) => p.legend).length;
  return [`${active.length} ${active.length === 1 ? 'pessoa' : 'pessoas'}`, salary ? `folha ${fmtMoney(salary)}/sem` : null,
    legends ? `${legends} ${legends === 1 ? 'lenda' : 'lendas'}` : null].filter(Boolean).join(' · ');
}

function moodOf(p) {
  if (p.status === 'dead') return 'dead';
  if ((p.morale ?? 60) >= 75) return 'happy';
  if ((p.morale ?? 60) < 30) return 'sad';
  return 'neutral';
}

function traitName(store, id) {
  const t = (store.data?.crew?.traits || []).find((x) => x.id === id);
  return t?.name || id;
}

const STATUS = { active: 'ativa(o)', injured: 'lesionada(o)', retired: 'aposentada(o)', dead: 'falecida(o)', left: 'saiu' };

/** Status line of a person: [text, chip kind]. */
function statusOf(p) {
  if (p.status && p.status !== 'active') return [STATUS[p.status] || p.status, p.status === 'injured' ? 'warn' : 'muted'];
  if (p.busy === 'training') return ['em treino', 'info'];
  if (p.busy === 'space') return ['no espaço', 'info'];
  return ['disponível', ''];
}

/** Small labelled meter: "Moral 62" + 4px bar. */
function meter(label, v, kind = '') {
  const n = Math.round(Number(v) || 0);
  return h('span', { class: 'cv-meter' },
    h('span', { class: 'cv-meter-top' }, h('span', null, label), h('span', { class: 'cv-meter-v' }, String(n))),
    bar(n, { kind }));
}

/** Roster card (CSmanager .elenco card): status eyebrow, portrait, name, since, skill/morale meters. */
function personTile(store, p) {
  const st = store.state;
  const [stTxt, stKind] = statusOf(p);
  return h('button', {
    class: ['person-card', 'cv-tile', p.legend && 'legend', p.status !== 'active' && 'inactive'], type: 'button',
    onclick: () => openPerson(store, p.id), 'aria-label': `${p.name || p.id}, ${ROLE_LABELS[p.role] || p.role}`,
  },
  h('span', { class: 'cv-tile-top' },
    h('span', { class: ['cv-eyebrow', stKind && `tone-${stKind}`] }, stTxt),
    p.legend ? h('span', { class: 'cv-legend' }, 'Lenda') : null),
  raw(portraitSVG(p.portrait || p.id, { size: 56, mood: moodOf(p), title: p.name }), 'cv-face'),
  h('b', { class: 'cv-name' }, p.name || p.id),
  h('span', { class: 'cv-sub' }, p.hiredTurn != null ? `desde ${fmtMonth(p.hiredTurn, st.startYear)}` : (ROLE_LABELS[p.role] || p.role)),
  h('span', { class: 'cv-meters' },
    meter('Habilidade', p.skill),
    meter('Moral', p.morale, (p.morale ?? 0) < 30 ? 'bad' : '')));
}

function rosterView(store) {
  const all = roster(store);
  const active = all.filter(isActive);
  const out = h('div', { class: 'cv-roster' });
  if (!active.length) {
    out.append(emptyState('Ninguém na equipe ainda. Contrate diretores de voo, astronautas e engenheiros.', 'equipe'),
      button('Ver candidatos', () => store.ui?.navigate?.('equipe', 'contratar'), { kind: 'primary', big: true }));
    return out;
  }
  for (const role of ROLE_ORDER) {
    const list = active.filter((p) => p.role === role).sort((a, b) => (b.legend ? 1 : 0) - (a.legend ? 1 : 0) || (b.skill || 0) - (a.skill || 0));
    if (!list.length) continue;
    out.append(sectionTitle(ROLE_PLURAL[role], h('span', { class: 'pn-count' }, String(list.length))),
      h('div', { class: 'person-list cv-grid' }, list.map((p) => personTile(store, p))));
  }
  const others = active.filter((p) => !ROLE_ORDER.includes(p.role));
  if (others.length) out.append(sectionTitle('Outros'), h('div', { class: 'person-list cv-grid' }, others.map((p) => personTile(store, p))));
  const gone = all.filter((p) => ['retired', 'left'].includes(p.status));
  if (gone.length) {
    out.append(sectionTitle('Ex-integrantes'), h('div', { class: 'pn-list' }, gone.slice(0, 10).map((p) => listRow({
      cls: 'inactive', lead: raw(portraitSVG(p.portrait || p.id, { size: 36, mood: moodOf(p), title: p.name })), leadCls: 'pn-face',
      title: p.name || p.id, sub: `${ROLE_LABELS[p.role] || p.role} · ${STATUS[p.status] || p.status}`, onClick: () => openPerson(store, p.id),
    }))));
  }
  return out;
}

function openPerson(store, id) {
  const st = store.state;
  const p = store.tryQuery('crew/person', null, id) || st.crew?.[id];
  if (!p) return;
  const traits = store.data?.crew?.traits || [];
  const [stTxt, stKind] = statusOf(p);
  openModal((close) => h('div', { class: 'person-sheet' },
    h('div', { class: 'person-hero' },
      raw(portraitSVG(p.portrait || p.id, { size: 72, mood: moodOf(p), title: p.name }), 'face big'),
      h('div', { class: 'ph-text' },
        h('div', { class: 'ph-role' }, ROLE_LABELS[p.role] || p.role),
        h('div', { class: 'chips' }, chip(stTxt, stKind), p.legend ? chip('Lenda da agência', 'accent') : null),
        h('div', { class: 'ph-facts' },
          p.salaryM != null ? h('span', null, 'Salário ', h('b', null, `${fmtMoney(p.salaryM)}/sem`)) : null,
          p.experience != null ? h('span', null, 'Experiência ', h('b', null, String(Math.round(p.experience)))) : null))),
    p.bio ? h('p', { class: 'bio' }, p.bio) : null,
    h('div', { class: 'pn-card pn-bars' },
      bar(p.skill ?? 0, { label: 'Habilidade', showValue: true }),
      bar(p.morale ?? 0, { label: 'Moral', showValue: true, kind: (p.morale ?? 0) < 30 ? 'bad' : '' }),
      bar(p.loyalty ?? 0, { label: 'Lealdade', showValue: true, kind: (p.loyalty ?? 0) < 30 ? 'bad' : '' }),
      bar(p.ambition ?? 0, { label: 'Ambição', showValue: true })),
    (p.traits || []).length ? h('div', { class: 'pn-block' }, sectionTitle('Traços'), h('div', { class: 'traits pn-list' }, p.traits.map((tid) => {
      const t = traits.find((x) => x.id === tid);
      return listRow({ cls: 'trait', title: t?.name || tid, sub: t?.description || null });
    }))) : null,
    (p.history || []).length ? h('div', { class: 'pn-block' }, sectionTitle('História'), h('div', { class: 'timeline pn-list' },
      p.history.slice().reverse().slice(0, 12).map((e) => listRow({ cls: 'pn-hist', title: e.text, meta: fmtMonth(e.turn, st.startYear) })))) : null,
    p.status === 'active' ? h('div', { class: 'btn-col cv-actions' },
      button(p.trainCost ? `Treinar · ${fmtMoney(p.trainCost)}` : 'Treinar', () => {
        const r = store.dispatch({ type: 'crew/train', crewId: p.id });
        toast(r?.ok ? (r.message || `${p.name} entrou em treinamento.`) : (r?.error || 'Não foi possível treinar.'), r?.ok ? 'good' : 'bad');
        if (r?.ok) close();
      }, { big: true }),
      button('Dispensar', async () => {
        if (!(await confirmDialog(`Dispensar ${p.name}? A moral do time pode cair.`, { okLabel: 'Dispensar', danger: true }))) return;
        const r = store.dispatch({ type: 'crew/fire', crewId: p.id });
        toast(r?.ok ? (r.message || `${p.name} deixou a agência.`) : (r?.error || 'Não foi possível.'), r?.ok ? 'warn' : 'bad');
        if (r?.ok) close();
      }, { kind: 'danger', big: true })) : null),
  { title: p.name || 'Pessoa', cls: 'pn-sheet' });
}

// ------------------------------------------------------------------ hiring

function candidatesView(store) {
  const q = store.tryQuery('crew/candidates', null);
  const list = Array.isArray(q) ? q : [];
  const me = store.player();
  if (!list.length) return emptyState('Nenhum candidato no mercado agora. Novos nomes aparecem com o tempo e com o prestígio da agência.', 'equipe');
  return h('div', { class: 'person-list cv-cands' }, h('p', { class: 'pn-lead-text' }, 'Contratar estrelas custa caro; formar talentos leva tempo.'),
    list.map((c) => {
      const cost = c.hireCostM ?? c.signingM ?? c.costM;
      const short = cost != null && me && me.cash < cost;
      return card({
        cls: 'person-card candidate', icon: raw(portraitSVG(c.portrait || c.id, { size: 44, title: c.name }), 'face'),
        title: c.name || c.id, subtitle: `${ROLE_LABELS[c.role] || c.role}${c.from ? ` · vem de ${store.state.actors?.[c.from]?.short || c.from}` : ''}`,
      },
      c.bio ? h('p', { class: 'cv-bio' }, c.bio) : null,
      meter('Habilidade', c.skill),
      (c.traits || []).length ? h('div', { class: 'chips' }, c.traits.map((t) => chip(traitName(store, t)))) : null,
      h('div', { class: 'cv-hire' },
        h('span', { class: 'cv-cost' },
          c.salaryM != null ? h('span', null, h('b', null, fmtMoney(c.salaryM)), '/sem') : null,
          cost != null ? h('span', { class: short ? 'down' : null }, 'contratação ', h('b', null, fmtMoney(cost))) : null),
        button('Contratar', () => {
          const r = store.dispatch({ type: 'crew/hire', candidateId: c.id });
          if (r?.ok) { toast(r.message || `${c.name} chegou à agência!`, 'good'); store.vibrate(20); }
          else toast(r?.error || 'Contratação recusada.', 'bad');
        }, { kind: 'primary', small: true, disabled: short })));
    }));
}

// ------------------------------------------------------------------ memorial

function memorialView(store) {
  const st = store.state;
  const q = store.tryQuery('crew/memorial', null);
  const list = Array.isArray(q) ? q : (st.memorial || []).slice().reverse(); // newest first
  if (!list.length) {
    return h('div', { class: 'memorial empty-wall' }, h('div', { class: 'memorial-title' }, 'Memorial'),
      h('p', null, 'A parede está vazia. Que continue assim.'),
      h('p', { class: 'memorial-note' }, 'Quem morrer a serviço da agência terá o nome gravado aqui.'));
  }
  return h('div', { class: 'memorial' },
    h('div', { class: 'memorial-title' }, 'Memorial'),
    h('p', { class: 'memorial-note' }, 'Coragem tem preço. Estes nomes pagaram por todos nós.'),
    h('div', { class: 'memorial-wall' }, list.map((m) => {
      const p = st.crew?.[m.crewId];
      const mission = (st.missions || []).find((x) => x.id === m.missionId);
      return h('div', { class: 'memorial-plate' },
        raw(portraitSVG(p?.portrait || m.crewId || m.name, { size: 56, mood: 'dead', title: m.name }), 'face'),
        h('div', { class: 'plate-name' }, m.name || p?.name || '—'),
        h('div', { class: 'plate-role' }, ROLE_LABELS[m.role || p?.role] || ''),
        h('div', { class: 'plate-when' }, `${fmtMonth(m.turn, st.startYear)}${mission ? ` · ${mission.name}` : ''}`),
        m.cause ? h('div', { class: 'plate-cause' }, m.cause) : null);
    })));
}

// ------------------------------------------------------------------ album

const RARITY = { common: 'Comum', rare: 'Rara', epic: 'Épica', legendary: 'Lendária' };

function albumView(store) {
  const st = store.state;
  const q = store.tryQuery('narrative/album', null);
  const list = Array.isArray(q) ? q : st.album || [];
  if (!list.length) return emptyState('O Álbum da Agência guarda os momentos marcantes como cartas. A primeira chega com o primeiro grande momento.', 'trofeu');
  return h('div', { class: 'cv-album' },
    h('p', { class: 'pn-lead-text' }, `${list.length} carta${list.length > 1 ? 's' : ''} colecionada${list.length > 1 ? 's' : ''}.`),
    h('div', { class: 'album-grid' }, list.slice().reverse().map((c) => {
      const rarity = c.rarity || 'common';
      const faces = (c.crewIds || []).map((id) => st.crew?.[id]).filter(Boolean).slice(0, 3);
      return h('button', { class: `album-card r-${rarity}`, type: 'button', onclick: () => openAlbumCard(store, c) },
        h('span', { class: 'album-rarity' }, RARITY[rarity] || rarity),
        h('span', { class: 'album-art' }, faces.length ? faces.map((p) => raw(portraitSVG(p.portrait || p.id, { size: 40, mood: p.status === 'dead' ? 'dead' : 'happy' }), 'face'))
          : h('span', { class: 'album-glyph', 'aria-hidden': 'true' }, c.kind === 'first' ? '🏁' : c.kind === 'tragedy' || c.kind === 'death' ? '🕯' : '🚀')),
        h('span', { class: 'album-title' }, c.title || 'Momento'),
        h('span', { class: 'album-date' }, fmtMonth(c.turn, st.startYear)));
    })));
}

function openAlbumCard(store, c) {
  const st = store.state;
  const rarity = c.rarity || 'common';
  openModal(h('div', { class: `album-sheet r-${rarity}` },
    h('div', { class: 'chips' }, chip(RARITY[rarity] || 'Comum', rarity === 'legendary' ? 'accent' : rarity === 'rare' ? 'info' : rarity === 'epic' ? 'epic' : ''),
      h('span', { class: 'album-sheet-date' }, fmtDate(c.turn, st.startYear))),
    c.headline ? h('blockquote', { class: 'headline-quote' }, c.headline) : null,
    (c.crewIds || []).length ? h('div', { class: 'crew-strip' }, c.crewIds.map((id) => st.crew?.[id]).filter(Boolean).map((p) =>
      h('div', { class: 'crew-mini' }, raw(portraitSVG(p.portrait || p.id, { size: 48, mood: p.status === 'dead' ? 'dead' : 'happy' }), 'face'), h('div', { class: 'crew-mini-name' }, p.name)))) : null),
  { title: c.title || 'Carta', cls: 'pn-sheet' });
}

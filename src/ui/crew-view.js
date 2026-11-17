// Equipe (from the Painel "equipe" number): roster with portraits, hiring, Memorial and Álbum da Agência.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtDate, fmtMonth, ROLE_LABELS,
} from './components.js';
import { portraitSVG } from './portrait.js';

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
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  if (SEGS.some((s) => s.id === route.sub)) ui.seg = route.sub;
  const rerender = () => { container.innerHTML = ''; render(container, store); };
  const go = (seg) => { ui.seg = seg; store.ui?.navigate ? store.ui.navigate('equipe', seg) : rerender(); };
  const root = h('div', { class: 'view-pad crew' },
    h('div', { class: 'view-head' },
      button('Painel', () => store.ui?.navigate?.('painel'), { kind: 'ghost', small: true, icon: '‹' }),
      h('h1', { class: 'view-title' }, 'Equipe')),
    segmented(SEGS.map((s) => (s.id === 'memorial' && store.state.memorial?.length ? { ...s, badge: store.state.memorial.length } : s)), ui.seg, go));
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

function personCard(store, p) {
  const st = store.state;
  return card({
    cls: ['person-card', p.legend && 'legend', p.status !== 'active' && 'inactive'].filter(Boolean).join(' '),
    onClick: () => openPerson(store, p.id),
    icon: raw(portraitSVG(p.portrait || p.id, { size: 56, mood: moodOf(p), title: p.name }), 'face'),
    title: `${p.legend ? '★ ' : ''}${p.name || p.id}`, subtitle: `${ROLE_LABELS[p.role] || p.role}${p.hiredTurn != null ? ` · desde ${fmtMonth(p.hiredTurn, st.startYear)}` : ''}`,
    right: p.status && p.status !== 'active' ? chip(STATUS[p.status] || p.status, p.status === 'injured' ? 'warn' : 'muted') : p.busy === 'training' ? chip('em treino', 'info') : p.busy === 'space' ? chip('no espaço', 'accent') : null,
  },
  h('div', { class: 'rel-bars' },
    bar(p.skill ?? 0, { label: `Habilidade ${Math.round(p.skill ?? 0)}`, key: `sk.${p.id}`, kind: 'accent' }),
    bar(p.morale ?? 0, { label: `Moral ${Math.round(p.morale ?? 0)}`, key: `mo.${p.id}`, kind: (p.morale ?? 0) < 30 ? 'bad' : 'good' })),
  (p.traits || []).length ? h('div', { class: 'chips' }, p.traits.map((t) => chip(traitName(store, t), 'muted'))) : null);
}

const STATUS = { active: 'ativa(o)', injured: 'lesionada(o)', retired: 'aposentada(o)', dead: 'falecida(o)', left: 'saiu' };

function rosterView(store) {
  const all = roster(store);
  const active = all.filter((p) => (p.status ?? 'active') === 'active' || p.status === 'injured');
  const out = h('div');
  if (!active.length) {
    out.append(emptyState('Ninguém na equipe ainda. Contrate diretores de voo, astronautas e engenheiros.', '👩‍🚀'),
      button('Ver candidatos', () => store.ui?.navigate?.('equipe', 'contratar'), { kind: 'primary' }));
    return out;
  }
  const salary = active.reduce((s, p) => s + (Number(p.salaryM) || 0), 0);
  out.append(h('div', { class: 'chips' }, chip(`${active.length} pessoas`, 'accent'), salary ? chip(`folha ${fmtMoney(salary)}/sem`, 'muted') : null,
    chip(`${active.filter((p) => p.legend).length} lendas`, 'muted')));
  for (const role of ROLE_ORDER) {
    const list = active.filter((p) => p.role === role).sort((a, b) => (b.legend ? 1 : 0) - (a.legend ? 1 : 0) || (b.skill || 0) - (a.skill || 0));
    if (!list.length) continue;
    out.append(sectionTitle(ROLE_PLURAL[role]), h('div', { class: 'person-list' }, list.map((p) => personCard(store, p))));
  }
  const others = active.filter((p) => !ROLE_ORDER.includes(p.role));
  if (others.length) out.append(sectionTitle('Outros'), ...others.map((p) => personCard(store, p)));
  const gone = all.filter((p) => ['retired', 'left'].includes(p.status));
  if (gone.length) out.append(sectionTitle('Ex-integrantes'), h('div', { class: 'person-list' }, gone.slice(0, 10).map((p) => personCard(store, p))));
  return out;
}

function openPerson(store, id) {
  const st = store.state;
  const p = store.tryQuery('crew/person', null, id) || st.crew?.[id];
  if (!p) return;
  const traits = store.data?.crew?.traits || [];
  openModal((close) => h('div', { class: 'person-sheet' },
    h('div', { class: 'person-hero' },
      raw(portraitSVG(p.portrait || p.id, { size: 112, mood: moodOf(p), title: p.name }), 'face big'),
      h('div', null,
        h('div', { class: 'small muted' }, ROLE_LABELS[p.role] || p.role),
        p.legend ? chip('★ Lenda da agência', 'good') : null,
        p.salaryM != null ? h('div', { class: 'small' }, `Salário ${fmtMoney(p.salaryM)}/sem`) : null,
        p.experience != null ? h('div', { class: 'small' }, `Experiência: ${Math.round(p.experience)}`) : null)),
    p.bio ? h('p', { class: 'bio' }, p.bio) : null,
    h('div', { class: 'rel-bars' },
      bar(p.skill ?? 0, { label: `Habilidade ${Math.round(p.skill ?? 0)}`, kind: 'accent' }),
      bar(p.morale ?? 0, { label: `Moral ${Math.round(p.morale ?? 0)}`, kind: (p.morale ?? 0) < 30 ? 'bad' : 'good' }),
      bar(p.loyalty ?? 0, { label: `Lealdade ${Math.round(p.loyalty ?? 0)}`, kind: 'info' }),
      bar(p.ambition ?? 0, { label: `Ambição ${Math.round(p.ambition ?? 0)}`, kind: 'warn' })),
    (p.traits || []).length ? h('div', { class: 'traits' }, p.traits.map((tid) => {
      const t = traits.find((x) => x.id === tid);
      return h('div', { class: 'trait' }, h('strong', null, t?.name || tid), t?.description ? h('span', { class: 'small muted' }, ` · ${t.description}`) : null);
    })) : null,
    (p.history || []).length ? h('div', null, sectionTitle('História'), h('ul', { class: 'timeline' }, p.history.slice().reverse().slice(0, 12).map((e) =>
      h('li', null, h('span', { class: 'tiny muted' }, fmtMonth(e.turn, st.startYear)), ' ', e.text)))) : null,
    p.status === 'active' ? h('div', { class: 'btn-row' },
      button(p.trainCost ? `Treinar · ${fmtMoney(p.trainCost)}` : 'Treinar', () => {
        const r = store.dispatch({ type: 'crew/train', crewId: p.id });
        toast(r?.ok ? (r.message || `${p.name} entrou em treinamento.`) : (r?.error || 'Não foi possível treinar.'), r?.ok ? 'good' : 'bad');
        if (r?.ok) close();
      }, { kind: 'ghost', icon: '🏋' }),
      button('Dispensar', async () => {
        if (!(await confirmDialog(`Dispensar ${p.name}? A moral do time pode cair.`, { okLabel: 'Dispensar', danger: true }))) return;
        const r = store.dispatch({ type: 'crew/fire', crewId: p.id });
        toast(r?.ok ? (r.message || `${p.name} deixou a agência.`) : (r?.error || 'Não foi possível.'), r?.ok ? 'warn' : 'bad');
        if (r?.ok) close();
      }, { kind: 'danger' })) : null),
  { title: p.name || 'Pessoa' });
}

// ------------------------------------------------------------------ hiring

function candidatesView(store) {
  const q = store.tryQuery('crew/candidates', null);
  const list = Array.isArray(q) ? q : [];
  const me = store.player();
  if (!list.length) return emptyState('Nenhum candidato no mercado agora. Novos nomes aparecem com o tempo e com o prestígio da agência.', '📇');
  return h('div', { class: 'person-list' }, h('p', { class: 'muted small' }, 'Contratar estrelas custa caro; formar talentos leva tempo.'),
    list.map((c) => {
      const cost = c.hireCostM ?? c.signingM ?? c.costM;
      return card({
        cls: 'person-card candidate', icon: raw(portraitSVG(c.portrait || c.id, { size: 56, title: c.name }), 'face'),
        title: c.name || c.id, subtitle: `${ROLE_LABELS[c.role] || c.role}${c.from ? ` · vem de ${store.state.actors?.[c.from]?.short || c.from}` : ''}`,
      },
      c.bio ? h('p', { class: 'small' }, c.bio) : null,
      bar(c.skill ?? 0, { label: `Habilidade ${Math.round(c.skill ?? 0)}`, kind: 'accent' }),
      (c.traits || []).length ? h('div', { class: 'chips' }, c.traits.map((t) => chip(traitName(store, t), 'muted'))) : null,
      h('div', { class: 'btn-row' },
        h('span', { class: 'small muted' }, [c.salaryM != null ? `${fmtMoney(c.salaryM)}/sem` : null, cost != null ? `contratação ${fmtMoney(cost)}` : null].filter(Boolean).join(' · ')),
        button('Contratar', () => {
          const r = store.dispatch({ type: 'crew/hire', candidateId: c.id });
          if (r?.ok) { toast(r.message || `${c.name} chegou à agência!`, 'good'); store.vibrate(20); }
          else toast(r?.error || 'Contratação recusada.', 'bad');
        }, { kind: 'primary', small: true, disabled: cost != null && me && me.cash < cost })));
    }));
}

// ------------------------------------------------------------------ memorial

function memorialView(store) {
  const st = store.state;
  const q = store.tryQuery('crew/memorial', null);
  const list = Array.isArray(q) ? q : (st.memorial || []).slice().reverse(); // newest first
  if (!list.length) {
    return h('div', { class: 'memorial empty-wall' }, h('div', { class: 'memorial-title' }, 'MEMORIAL'),
      h('p', null, 'A parede está vazia. Que continue assim.'),
      h('p', { class: 'tiny muted' }, 'Quem morrer a serviço da agência terá o nome gravado aqui.'));
  }
  return h('div', { class: 'memorial' },
    h('div', { class: 'memorial-title' }, 'MEMORIAL'),
    h('p', { class: 'small center muted' }, 'Coragem tem preço. Estes nomes pagaram por todos nós.'),
    h('div', { class: 'memorial-wall' }, list.map((m) => {
      const p = st.crew?.[m.crewId];
      const mission = (st.missions || []).find((x) => x.id === m.missionId);
      return h('div', { class: 'memorial-plate' },
        raw(portraitSVG(p?.portrait || m.crewId || m.name, { size: 60, mood: 'dead', title: m.name }), 'face'),
        h('div', { class: 'plate-name' }, m.name || p?.name || '—'),
        h('div', { class: 'tiny' }, ROLE_LABELS[m.role || p?.role] || ''),
        h('div', { class: 'tiny muted' }, `${fmtMonth(m.turn, st.startYear)}${mission ? ` · ${mission.name}` : ''}`),
        m.cause ? h('div', { class: 'tiny muted' }, m.cause) : null);
    })));
}

// ------------------------------------------------------------------ album

const RARITY = { common: 'Comum', rare: 'Rara', epic: 'Épica', legendary: 'Lendária' };

function albumView(store) {
  const st = store.state;
  const q = store.tryQuery('narrative/album', null);
  const list = Array.isArray(q) ? q : st.album || [];
  if (!list.length) return emptyState('O Álbum da Agência guarda os momentos marcantes como cartas. A primeira chega com o primeiro grande momento.', '🃏');
  return h('div', null,
    h('p', { class: 'muted small' }, `${list.length} carta${list.length > 1 ? 's' : ''} colecionada${list.length > 1 ? 's' : ''}.`),
    h('div', { class: 'album-grid' }, list.slice().reverse().map((c) => {
      const rarity = c.rarity || 'common';
      const faces = (c.crewIds || []).map((id) => st.crew?.[id]).filter(Boolean).slice(0, 3);
      return h('button', { class: `album-card r-${rarity}`, type: 'button', onclick: () => openAlbumCard(store, c) },
        h('div', { class: 'album-art' }, faces.length ? faces.map((p) => raw(portraitSVG(p.portrait || p.id, { size: 40, mood: p.status === 'dead' ? 'dead' : 'happy' }), 'face'))
          : h('span', { class: 'album-glyph', 'aria-hidden': 'true' }, c.kind === 'first' ? '🏁' : c.kind === 'tragedy' || c.kind === 'death' ? '🕯' : '🚀')),
        h('div', { class: 'album-title' }, c.title || 'Momento'),
        h('div', { class: 'tiny muted' }, fmtMonth(c.turn, st.startYear)),
        h('div', { class: 'album-rarity tiny' }, RARITY[rarity] || rarity));
    })));
}

function openAlbumCard(store, c) {
  const st = store.state;
  openModal(h('div', { class: `album-sheet r-${c.rarity || 'common'}` },
    h('div', { class: 'small muted' }, fmtDate(c.turn, st.startYear)),
    c.headline ? h('blockquote', { class: 'headline-quote' }, c.headline) : null,
    (c.crewIds || []).length ? h('div', { class: 'crew-strip' }, c.crewIds.map((id) => st.crew?.[id]).filter(Boolean).map((p) =>
      h('div', { class: 'crew-mini' }, raw(portraitSVG(p.portrait || p.id, { size: 48, mood: p.status === 'dead' ? 'dead' : 'happy' }), 'face'), h('div', { class: 'tiny' }, p.name)))) : null,
    h('div', { class: 'chips' }, chip(RARITY[c.rarity] || 'Comum', 'accent'))), { title: c.title || 'Carta' });
}

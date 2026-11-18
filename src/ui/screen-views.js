// Small drawer screens of the registry (screens.js): stubs for the screens later phases deliver ("em breve"),
// Finanças, Calendário de lançamentos, Anais, Salvar e capítulos, Ajustes and Sobre. Each export is a module-like
// object { render(container, store, route) -> cleanup? } so screens.js can lazy-load it.
import {
  h, raw, chip, button, sectionTitle, emptyState, viewHead, toast, confirmDialog, attempt, icon, iconSVG, fmtMonth, fmtDate,
  TRUTH_LABELS,
} from './components.js';
import { screenById } from './screens.js';
import { emblemSVG } from './portrait.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { financeView } from './dashboard.js';
import { render as renderSettings, APP_VERSION, BUILD, BUILD_DATE } from './settings.js';

const PHASE_TEXT = { B: 'Chega na próxima atualização.', C: 'Chega junto com o conteúdo das novas eras.' };

/** What each coming screen will do (pt-BR, shown on its "em breve" page). */
export const SOON_TEXT = {
  conselho: ['Investidores e conselho', 'A cada ano você poderá vender parte da agência a investidores. Com 50% ou mais nas suas mãos, você mantém a autonomia; quanto menos tiver, mais missões dos investidores entram no seu calendário.'],
  identidade: ['Identidade e logo', 'Funde sua própria agência: escolha o país, a sede e desenhe o logo. As agências do mundo também ganham emblemas novos.'],
  hangar: ['Hangar', 'Construtor de foguetes: compre um foguete existente e modifique, ou monte um do zero a partir dos que já voaram.'],
  colonias: ['Colônias', 'Bases que crescem até virar colônias autônomas no Sistema Solar e além.'],
  eco: ['Arquivo do Eco', 'Os fragmentos do sinal que atravessa as eras, reunidos em ordem.'],
  anais: ['Anais', 'A linha do tempo da sua campanha: agências que nasceram e sumiram, eras e feitos.'],
};

/** "Em breve" page for a registered screen that a later phase delivers. Never throws. */
export function soonPanel(id, extra = null) {
  const d = screenById(id);
  const [title, text] = SOON_TEXT[id] || [d?.title || 'Em breve', 'Esta tela ainda está em construção.'];
  return h('div', { class: 'view-pad em-breve-pag' },
    viewHead(d?.title || title, { lead: PHASE_TEXT[d?.soon] || 'Em construção.' }),
    h('section', { class: 'card em-breve-card' },
      h('div', { class: 'em-breve-topo' }, raw(iconSVG(d?.icon || 'info', 28), 'em-breve-ic'), chip('em breve', 'warn')),
      h('h2', { class: 'em-breve-titulo' }, title),
      h('p', { class: 'em-breve-texto' }, text)),
    extra);
}

export const stub = {
  render(container, store, route) {
    container.appendChild(soonPanel(route?.tab || 'hangar',
      button('Voltar ao Painel', () => store.ui?.navigate?.('painel'), { icon: 'voltar', big: true })));
  },
};

export const financas = {
  render(container, store) {
    const st = store.state;
    const me = st.actors?.[st.playerId] || {};
    container.appendChild(h('div', { class: 'view-pad financas' },
      viewHead('Finanças', { lead: `${me.short || me.name || ''} · caixa, gastos e lançamentos contábeis` }),
      attempt(() => financeView(store), emptyState('As finanças ainda não estão disponíveis.', 'caixa'))));
  },
};

/** Upcoming launches (yours and the world's) by month: CSmanager `.agenda-do-mes` rows. */
export const lancamentos = {
  render(container, store) {
    ensurePainelCss();
    const st = store.state;
    const mine = (st.missions || []).filter((m) => m.status === 'scheduled' && m.launchTurn != null)
      .map((m) => ({ when: m.launchTurn, mine: true, name: m.name || 'Missão', owner: st.actors?.[st.playerId], id: m.id }));
    let rivals = store.tryQuery('calendar/upcoming', null, 30);
    if (!Array.isArray(rivals)) rivals = (st.calendar || []).filter((c) => c.status === 'planned');
    const others = rivals.filter((c) => c.owner !== st.playerId).map((c) => {
      const def = store.data?.index?.calendar?.[c.calendarId || c.id] || {};
      return { when: c.currentTurn ?? c.plannedTurn ?? c.turn, name: c.name || def.name || c.id, owner: st.actors?.[c.owner || def.owner] || { id: c.owner || def.owner }, truth: c.truthLayer || def.truthLayer };
    });
    const all = [...mine, ...others].filter((x) => Number.isFinite(x.when)).sort((a, b) => a.when - b.when).slice(0, 40);
    const root = h('div', { class: 'view-pad lancamentos' },
      viewHead('Calendário de lançamentos', { lead: 'Seus voos agendados e os dos rivais, mês a mês' }));
    if (!all.length) root.append(emptyState('Nenhum lançamento no horizonte.', 'calendario'));
    let month = null;
    let list = null;
    for (const x of all) {
      const m = fmtMonth(x.when, st.startYear);
      if (m !== month) {
        month = m;
        list = h('div', { class: 'pn-list agenda-do-mes' });
        root.append(sectionTitle(m), list);
      }
      list.append(listRow({
        cls: ['launch-row', x.mine && 'mine'].filter(Boolean).join(' '), lead: raw(emblemSVG(x.owner || {}, { size: 30 })), leadCls: 'pn-emblem',
        title: x.name, sub: `${x.owner?.short || x.owner?.name || x.owner?.id || ''} · ${fmtDate(x.when, st.startYear)}`,
        right: x.mine ? chip('sua', 'accent') : x.truth ? chip(TRUTH_LABELS[x.truth] || x.truth, 'muted') : null,
        onClick: x.mine ? () => store.ui?.navigate?.('missoes', `m/${x.id}`) : null, chevron: !!x.mine,
      }));
    }
    container.appendChild(root);
  },
};

/** Anais: Phase C fills the timeline; Phase A shows what the engine already records (annals, era history). */
export const anais = {
  render(container, store) {
    const st = store.state;
    const years = Object.keys(st.annals || {}).map(Number).filter(Number.isFinite).sort((a, b) => b - a).slice(0, 30);
    const eras = Array.isArray(st.eraHistory) ? st.eraHistory : [];
    const extra = years.length || eras.length ? h('div', null,
      eras.length ? h('div', null, sectionTitle('Eras encerradas'), h('div', { class: 'pn-list' }, eras.map((e) => listRow({ lead: icon('trofeu', 18), title: e.headline || `Era ${e.eraId}`, sub: e.eraId })))) : null,
      years.length ? h('div', null, sectionTitle('Manchetes por ano'), h('div', { class: 'pn-list' }, years.map((y) => {
        const v = st.annals[y];
        const lines = Array.isArray(v) ? v : [v];
        return listRow({ lead: h('span', { class: 'mono' }, String(y)), title: String(lines[0]?.headline || lines[0] || ''), sub: lines.slice(1, 3).map((l) => l?.headline || l).join(' · ') });
      }))) : null) : null;
    container.appendChild(soonPanel('anais', extra));
  },
};

/** Salvar e capítulos: manual slots, autosave and era checkpoints (store.saveSlot / loadSlot / slots). */
export const salvar = {
  render(container, store) {
    const rerender = () => { container.innerHTML = ''; salvar.render(container, store); };
    const slots = attempt(() => store.slots?.() || [], []);
    const st = store.state;
    const row = (s) => {
      const empty = !s.info;
      const label = empty ? 'Vazio' : `${s.info.actor?.short || s.info.actor?.name || String(s.info.playerId || '').toUpperCase()} · ${fmtDate(s.info.turn, s.info.startYear)}`;
      const actions = h('div', { class: 'slot-acoes' },
        s.writable && st ? button('Salvar aqui', async () => {
          if (!empty && !(await confirmDialog(`Substituir o save em "${s.label}"?`, { okLabel: 'Substituir', title: 'Salvar' }))) return;
          if (store.saveSlot(s.name)) { toast(`Salvo em ${s.label}.`, 'good'); rerender(); } else toast(store.saveError || 'Não foi possível salvar.', 'bad');
        }, { small: true, icon: 'salvar', iconSize: 16 }) : null,
        !empty ? button('Carregar', async () => {
          if (st && !(await confirmDialog(`Carregar "${s.label}"? O jogo atual continua no salvamento automático.`, { okLabel: 'Carregar', title: 'Carregar' }))) return;
          const ok = await store.loadSlot(s.name);
          if (!ok) toast(store.saveError || 'Não foi possível carregar este save.', 'bad', 5000);
        }, { small: true, kind: 'ghost' }) : null);
      return h('div', { class: ['list-row', 'slot-row', empty && 'vazio'] },
        h('span', { class: 'list-lead' }, icon(s.kind === 'era' ? 'trofeu' : s.kind === 'auto' ? 'relogio' : 'salvar', 18)),
        h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, s.label), h('div', { class: 'list-sub' }, label)),
        actions);
    };
    const group = (title, kind) => {
      const list = slots.filter((s) => s.kind === kind);
      return list.length ? h('div', null, sectionTitle(title), h('div', { class: 'list slot-list' }, list.map(row))) : null;
    };
    container.appendChild(h('div', { class: 'view-pad salvar' },
      viewHead('Salvar e capítulos', { lead: 'O jogo salva sozinho a cada turno. Use os espaços para guardar momentos.' }),
      group('Automático', 'auto'), group('Espaços', 'slot'), group('Início de cada era', 'era'),
      slots.length ? null : emptyState('Os saves ainda não estão disponíveis.', 'salvar')));
  },
};

export const ajustes = {
  render(container, store) {
    return renderSettings(container, store, {
      onExit: () => (globalThis.history?.length > 1 ? history.back() : store.ui?.navigate?.('painel')),
      onQuit: () => store.unload(),
    });
  },
};

export const sobre = {
  render(container, store) {
    const sc = store.data?.scenario || {};
    container.appendChild(h('div', { class: 'view-pad sobre' },
      viewHead('Sobre o Ad Astra', { lead: `Versão ${APP_VERSION} · ${BUILD || BUILD_DATE}` }),
      h('section', { class: 'card' },
        h('p', null, 'Você dirige uma agência espacial. O mundo simula ao seu redor: rivais, governos, blocos e o calendário real dos lançamentos.'),
        h('p', { class: 'muted small' }, `Jogando agora: ${sc.name || 'Corrida Lunar'}${sc.subtitle ? ` (${sc.subtitle})` : ''}.`),
        h('p', { class: 'muted small' }, 'Nomes reais aparecem só como referência histórica; não há logotipos oficiais. O futuro depois de hoje é simulação.')),
      button('Ajustes', () => store.ui?.navigate?.('ajustes'), { icon: 'ajustes', big: true })));
  },
};

// Pesquisa: 6 branches, node cards with state, start with safe/bold approach.
import {
  h, card, chip, bar, button, sectionTitle, emptyState, safePanel, openModal, toast, countUp, attempt,
  fmtEffect, fmtNum, fmtIn, fmtMoney,
} from './components.js';

const BRANCH_ICONS = { propulsion: '🔥', structures: '🧱', life_support: '🌱', computing: '🧠', energy: '⚡', science: '🔭' };
const STATE_LABELS = { locked: 'Bloqueado', available: 'Disponível', active: 'Em andamento', done: 'Concluído' };
const STATE_KIND = { locked: 'muted', available: 'accent', active: 'info', done: 'good' };

const ui = { branch: 'all' };

/** Nodes with state from research/tree, falling back to data + state.research. */
export function researchNodes(store) {
  const st = store.state;
  const q = store.tryQuery('research/tree', null);
  const list = Array.isArray(q) ? q : Array.isArray(q?.nodes) ? q.nodes : null;
  const dataNodes = store.data?.tech?.nodes || [];
  const byId = Object.fromEntries(dataNodes.map((n) => [n.id, n]));
  if (list) return list.map((n) => ({ ...(byId[n.id] || {}), ...n, state: n.state || n.status || 'locked' }));
  const r = st.research || {};
  const unlocked = new Set(r.unlocked || []);
  const active = Object.fromEntries((r.projects || []).map((p) => [p.nodeId, p]));
  return dataNodes.map((n) => {
    let state = 'locked';
    if (unlocked.has(n.id)) state = 'done';
    else if (active[n.id]) state = 'active';
    else if ((n.requires || []).every((x) => unlocked.has(x)) && !n.secret) state = 'available';
    const p = active[n.id];
    return { ...n, state, progress: p?.progress, approach: p?.approach, projectCost: p?.cost };
  });
}

function pointsInfo(store) {
  const sum = store.tryQuery('research/summary', null);
  if (sum && typeof sum === 'object') return sum;
  const q = store.tryQuery('research/points', null);
  if (typeof q === 'number') return { points: q };
  if (q && typeof q === 'object') return q;
  return { points: store.state.research?.points ?? 0 };
}

export function render(container, store) {
  const branches = store.data?.tech?.branches || [];
  const rerender = () => { container.innerHTML = ''; render(container, store); };
  container.appendChild(h('div', { class: 'view-pad research' },
    h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'Pesquisa')),
    safePanel(() => header(store), 'Pontos de ciência indisponíveis.'),
    safePanel(() => branchBar(store, branches, rerender)),
    safePanel(() => nodeList(store, branches), 'A árvore de tecnologia ainda está em construção.')));
}

function header(store) {
  const info = pointsInfo(store);
  const nodes = researchNodes(store);
  const active = nodes.filter((n) => n.state === 'active');
  return card({ cls: 'science-card' },
    h('div', { class: 'science-row' },
      h('div', null, h('div', { class: 'tile-label' }, '🔬 Pontos de ciência'), countUp('research.points', info.points ?? 0, fmtNum, 'tile-value')),
      h('div', { class: 'right' },
        info.perWeek != null ? h('div', { class: 'small' }, `+${fmtNum(info.perWeek)}/sem`) : null,
        info.slots != null ? h('div', { class: 'small muted' }, `${info.active ?? 0}/${info.slots} projetos simultâneos`) : null,
        h('div', { class: 'small muted' }, `${nodes.filter((n) => n.state === 'done').length}/${nodes.filter((n) => !n.secret || n.state !== 'locked').length} nós`))),
    active.length ? h('div', { class: 'active-projects' }, active.map((n) => progressBar(store, n))) : h('p', { class: 'muted small' }, 'Nenhum projeto em andamento. Missões e laboratórios geram ciência.'));
}

function progressBar(store, n) {
  const prog = Number(n.progress) || 0;
  const frac = prog <= 1 ? prog : prog / (n.science || n.projectCost || 100);
  return bar(frac * 100, { key: `rs.${n.id}`, label: `${n.name}${n.approach === 'bold' ? ' · ousada' : ''}${n.stalled ? ' · parado' : ''}${n.etaWeeks != null ? ` · ${fmtIn(store.state.turn + n.etaWeeks, store.state.turn)}` : ''}`, kind: n.approach === 'bold' ? 'warn' : 'accent' });
}

function branchBar(store, branches, rerender) {
  if (!branches.length) return null;
  const nodes = researchNodes(store);
  const opts = [{ id: 'all', name: 'Todos' }, ...branches];
  return h('div', { class: 'chip-scroll', role: 'tablist' }, opts.map((b) => {
    const list = b.id === 'all' ? nodes : nodes.filter((n) => n.branch === b.id);
    const done = list.filter((n) => n.state === 'done').length;
    return chip(`${BRANCH_ICONS[b.id] || '✦'} ${b.name} ${list.length ? `${done}/${list.length}` : ''}`, ui.branch === b.id ? 'accent' : '', {
      onclick: () => { ui.branch = b.id; rerender(); }, role: 'tab', 'aria-selected': ui.branch === b.id ? 'true' : 'false',
    });
  }));
}

const ORDER = { active: 0, available: 1, locked: 2, done: 3 };

/** Effect chips: prefer the sim's pt-BR effectText, else format raw effects. */
function effectChips(n) {
  const list = Array.isArray(n.effectText) && n.effectText.length ? n.effectText
    : Object.entries(n.effects || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => fmtEffect(k, v));
  return list.length ? h('div', { class: 'chips' }, list.map((t) => chip(t, 'info'))) : null;
}

function costText(n) {
  return [n.science ? `${fmtNum(n.science)} ciência` : null, n.cost ? fmtMoney(n.cost) : null].filter(Boolean).join(' + ');
}

function nodeList(store, branches) {
  const nodes = researchNodes(store).filter((n) => !(n.secret && n.state === 'locked'));
  if (!nodes.length) return emptyState('A árvore de tecnologia ainda não chegou desta era.', '🧪');
  const groups = ui.branch === 'all' ? (branches.length ? branches : [{ id: undefined, name: 'Tecnologias' }]) : branches.filter((b) => b.id === ui.branch);
  const out = h('div');
  for (const b of groups) {
    const list = nodes.filter((n) => b.id === undefined || n.branch === b.id).sort((a, c) => (ORDER[a.state] ?? 9) - (ORDER[c.state] ?? 9) || (a.cost || 0) - (c.cost || 0));
    if (!list.length) continue;
    out.append(sectionTitle(`${BRANCH_ICONS[b.id] || ''} ${b.name}`), h('div', { class: 'node-list' }, list.map((n) => nodeCard(store, n))));
  }
  return out;
}

function nodeCard(store, n) {
  const all = Object.fromEntries((store.data?.tech?.nodes || []).map((x) => [x.id, x]));
  const unlocked = new Set(store.state.research?.unlocked || []);
  const missing = (n.requires || []).filter((r) => !unlocked.has(r));
  const rivals = (n.rivalsWith || []).map((id) => store.state.actors?.[id]?.short || id);
  return card({
    cls: `node-card ns-${n.state}${n.secret ? ' secret' : ''}`, title: `${n.secret ? '✶ ' : ''}${n.name || n.id}`,
    subtitle: [costText(n), n.weeks != null ? `~${n.weeks} sem` : null].filter(Boolean).join(' · '),
    right: chip(STATE_LABELS[n.state] || n.state, STATE_KIND[n.state] || 'muted'),
    onClick: n.state === 'available' || n.state === 'active' || n.canRefine ? () => openNode(store, n) : undefined,
  },
  n.description ? h('p', { class: 'small' }, n.description) : null,
  effectChips(n),
  n.state === 'active' ? progressBar(store, n) : null,
  n.state === 'done' && n.quality != null && n.quality !== 1 ? chip(n.quality > 1 ? '✦ avanço inesperado' : '⚠ saiu com falhas: dá para refinar', n.quality > 1 ? 'good' : 'warn') : null,
  rivals.length ? h('div', { class: 'tiny muted' }, `Rivais que já dominam: ${rivals.join(', ')}`) : null,
  n.state === 'locked' && missing.length ? h('div', { class: 'tiny muted' }, `Requer: ${missing.map((r) => all[r]?.name || r).join(', ')}`) : null);
}

function openNode(store, n) {
  const st = store.state;
  openModal((close) => {
    const start = (approach) => {
      const r = store.dispatch({ type: 'research/start', nodeId: n.id, approach });
      if (r?.ok) { toast(`Pesquisa iniciada: ${n.name} (${approach === 'bold' ? 'ousada' : 'segura'}).`, 'good'); close(); }
      else toast(r?.error || 'Não foi possível iniciar.', 'bad');
    };
    if (n.state === 'done' && n.canRefine) {
      return h('div', null,
        h('p', null, 'O projeto terminou com falhas. Refinar recupera o efeito completo.'),
        button('Refinar tecnologia', () => {
          const r = store.dispatch({ type: 'research/refine', nodeId: n.id });
          if (r?.ok) { toast(`Refino iniciado: ${n.name}.`, 'good'); close(); } else toast(r?.error || 'Não foi possível refinar.', 'bad');
        }, { kind: 'primary' }));
    }
    if (n.state === 'active') {
      return h('div', null,
        progressBar(store, n),
        h('p', { class: 'small' }, n.approach === 'bold' ? 'Abordagem ousada: mais rápida, com chance de surpresa — boa ou ruim.' : 'Abordagem segura: ritmo constante, sem surpresas.'),
        button('Cancelar projeto', () => {
          const r = store.dispatch({ type: 'research/cancel', nodeId: n.id });
          if (r?.ok) { toast('Projeto cancelado.', 'warn'); close(); } else toast(r?.error || 'Não foi possível cancelar.', 'bad');
        }, { kind: 'danger' }));
    }
    const weeks = n.weeks ?? n.estWeeks;
    const safeW = n.weeksSafe ?? weeks;
    const boldW = n.weeksBold ?? (weeks != null ? Math.max(1, Math.round(weeks * 0.65)) : null);
    const info = attempt(() => pointsInfo(store), {});
    const ap = info.approaches || store.data?.tech?.config?.approaches || {};
    return h('div', { class: 'node-sheet' },
      n.description ? h('p', null, n.description) : null,
      effectChips(n),
      h('div', { class: 'muted small' }, `Custo: ${costText(n) || '—'}${n.costBold && n.costBold !== n.cost ? ` (ousada: ${fmtMoney(n.costBold)})` : ''} · você tem ${fmtNum(info.points ?? 0)} de ciência`),
      n.canAffordScience === false ? h('div', { class: 'warn-text small' }, 'Ciência insuficiente: missões e laboratórios geram mais.') : null,
      h('div', { class: 'approach-grid' },
        h('button', { class: 'approach safe', type: 'button', onclick: () => start('safe') },
          h('div', { class: 'approach-title' }, '🛡 Segura'),
          h('div', { class: 'small' }, safeW != null ? `~${safeW} semanas` : 'Mais lenta'),
          h('div', { class: 'tiny muted' }, ap.safe?.description || 'Sem surpresas. Ideal para o que a missão precisa a tempo.')),
        h('button', { class: 'approach bold', type: 'button', onclick: () => start('bold') },
          h('div', { class: 'approach-title' }, '🎲 Ousada'),
          h('div', { class: 'small' }, boldW != null ? `~${boldW} semanas` : 'Mais rápida'),
          h('div', { class: 'tiny muted' }, ap.bold?.description || 'Chance de resultado inesperado: um salto ou um tropeço.'))),
      st.research?.projects?.length ? h('p', { class: 'tiny muted' }, `${st.research.projects.length} projeto(s) já em andamento dividem a equipe.`) : null);
  }, { title: n.name || 'Tecnologia' });
}

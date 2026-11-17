// UI entry point: boot, title screen, 5-tab shell, headline ticker, time controls,
// decision cards, launch scene hand-off and game over. The UI only observes state and dispatches actions.

import { loadData, browserReader } from '../core/data.js';
import { createStore } from './store.js';
import { h, raw, button, toast, fallbackPanel, closeAllModals, fmtDate, chip, openModal, fmtBand, esc, newsIcon } from './components.js';
import { emblemSVG } from './portrait.js';
import { applySettings, render as renderSettings, APP_VERSION, BUILD_DATE } from './settings.js';
import { renderTitle, renderGameOver } from './newgame.js';
import { openDecision, sortDecisions, closeDecision } from './decisions.js';
import * as dashboard from './dashboard.js';
import * as missionsTab from './missions-tab.js';
import * as researchTab from './research-tab.js';
import * as worldTab from './world-tab.js';
import * as crewView from './crew-view.js';

const TABS = [
  { id: 'painel', label: 'Painel', icon: '◉' },
  { id: 'missoes', label: 'Missões', icon: '🚀' },
  { id: 'pesquisa', label: 'Pesquisa', icon: '⚗' },
  { id: 'mapa', label: 'Mapa', icon: '🌍' },
  { id: 'mundo', label: 'Mundo', icon: '📰' },
];
// views reachable from a tab (highlight the parent tab)
const VIEW_PARENT = { equipe: 'painel', ajustes: null };

const ui = {
  route: { tab: 'painel', sub: '' },
  lookingAfterEnd: false,
  cleanup: null,
  shell: null,
  tickerTop: null,
  seenNewsTurn: -1,
  mapModule: undefined, // undefined = not loaded yet, null = failed
};

let store = null;
let appRoot = null;

// ------------------------------------------------------------------ boot

async function boot() {
  appRoot = document.getElementById('app') || document.body.appendChild(h('div', { id: 'app' }));
  appRoot.removeAttribute('aria-live'); // full re-renders would be too chatty for screen readers
  let data;
  try {
    data = await loadData(browserReader());
  } catch (e) {
    console.error(e);
    appRoot.innerHTML = '';
    appRoot.appendChild(h('div', { class: 'boot-error' },
      h('h1', null, 'Ad Astra'),
      h('p', null, 'Não foi possível carregar os dados do jogo.'),
      h('small', { class: 'muted' }, String(e.message || e)),
      button('Tentar de novo', () => location.reload(), { kind: 'primary' })));
    return;
  }
  document.body.dataset.era = String(data.scenario?.era || 4);
  store = createStore(data);
  applySettings(store.settings);
  store.ui = {
    navigate, openDecision: (id) => openDecision(store, id), advance, route: () => ui.route, version: APP_VERSION,
    // a view that swaps screens inside one route (builder steps) asks for the top explicitly
    scrollTop: () => { if (ui.shell?.view) ui.shell.view.scrollTop = 0; },
  };
  globalThis.adastra = store; // debugging aid in the console
  store.subscribe(onStoreChange);
  // sheets push their own history entry (components.openModal), so back closes a sheet first; a real route
  // change leaves those entries behind it
  window.addEventListener('hashchange', () => { closeAllModals({ keepHistory: true }); parseHash(); renderView(); renderTabbar(); });
  parseHash();
  // resume straight into the game if a save exists and we were mid-launch (Pilar: fechar o app não prejudica)
  const info = store.saveInfo();
  if (info?.actor && store.state == null && hasActiveLaunchInSave()) {
    if (store.load()) { renderAll(); return; }
  }
  showTitle();
}

function hasActiveLaunchInSave() {
  try { return !!JSON.parse(localStorage.getItem('adastra.save.v1') || 'null')?.activeLaunch; } catch { return false; }
}

function showTitle() {
  ui.shell = null;
  ui.lookingAfterEnd = false;
  closeAllModals();
  closeLaunch();
  // the title screen has no route: drop a stale '#ajustes' (a later start navigates to #painel)
  if (location.hash) { try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* */ } }
  renderTitle(appRoot, store, {
    onStart: () => { navigate('painel'); renderAll(); },
    onSettings: () => {
      appRoot.innerHTML = '';
      const c = h('div', { class: 'standalone' });
      appRoot.appendChild(c);
      renderSettings(c, store, { onExit: showTitle, onQuit: showTitle });
    },
  });
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [tab, ...rest] = raw.split('/');
  const known = TABS.some((t) => t.id === tab) || tab in VIEW_PARENT;
  ui.route = { tab: known ? tab : 'painel', sub: rest.join('/') };
}

/** navigate('missoes', 'nova') — changes hash (Android back button works). */
function navigate(tab, sub = '') {
  const target = `#${tab}${sub ? '/' + sub : ''}`;
  if (location.hash !== target) location.hash = target; // triggers hashchange -> render
  else { parseHash(); renderView(); renderTabbar(); }
}

// ------------------------------------------------------------------ store reaction

function onStoreChange(state, action, res) {
  if (!state) { showTitle(); return; }
  const type = action?.type || '';
  launchState.lastType = type;
  if (type === 'ui/settings') { applySettings(store.settings); if (ui.shell) renderView(); return; }
  if (type === 'ui/load' || type === 'ui/newGame') { renderAll(); return; }
  // during an active launch the overlay covers the shell: skip heavy re-renders on every step
  if (state.activeLaunch && type.startsWith('launch/')) { syncLaunch(); return; }
  renderAll();
  if (type === 'time/advance') afterAdvance(res);
}

function renderAll() {
  const st = store.state;
  if (!st) { showTitle(); return; }
  if (st.gameOver && !ui.lookingAfterEnd) {
    ui.shell = null;
    closeLaunch();
    renderGameOver(appRoot, store, { onNewGame: showTitle, onKeepLooking: () => { ui.lookingAfterEnd = true; renderAll(); } });
    return;
  }
  ensureShell();
  renderHeader();
  renderTicker();
  renderTimebar();
  renderTabbar();
  renderView();
  syncLaunch();
}

// ------------------------------------------------------------------ shell

function ensureShell() {
  if (ui.shell && ui.shell.root.isConnected) return;
  appRoot.innerHTML = '';
  const s = {
    header: h('header', { class: 'topbar' }),
    ticker: h('div', { class: 'ticker', role: 'marquee', 'aria-label': 'Manchetes', onclick: () => navigate('mundo') }),
    view: h('main', { class: 'view', id: 'view' }),
    timebar: h('div', { class: 'timebar' }),
    tabbar: h('nav', { class: 'tabbar', 'aria-label': 'Abas' }),
  };
  s.root = h('div', { class: 'shell' }, s.header, s.ticker, s.view, s.timebar, s.tabbar);
  appRoot.appendChild(s.root);
  ui.shell = s;
  ui.tickerTop = null;
}

function renderHeader() {
  const st = store.state;
  const me = st.actors?.[st.playerId] || { id: st.playerId, short: String(st.playerId || '').toUpperCase() };
  const el = ui.shell.header;
  el.innerHTML = '';
  el.append(
    h('button', { class: 'agency', type: 'button', onclick: () => navigate('painel'), 'aria-label': 'Ir ao painel' },
      raw(emblemSVG(me, { size: 34 }), 'agency-emblem'),
      h('div', { class: 'agency-text' },
        h('div', { class: 'agency-name' }, `${me.flag ? me.flag + ' ' : ''}${me.short || me.name || st.playerId}`),
        h('div', { class: 'agency-date' }, fmtDate(st.turn, st.startYear)))),
    h('span', { class: 'era-chip', title: 'Era 4: A Década Lunar' }, 'Era 4 · Década Lunar'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Ajustes', onclick: () => navigate('ajustes') }, '⚙'));
}

function renderTicker() {
  const news = (store.state.news || []).slice(0, 8);
  const top = news[0]?.id || 'none';
  if (ui.tickerTop === top) return; // keep the marquee running smoothly
  ui.tickerTop = top;
  const el = ui.shell.ticker;
  el.innerHTML = '';
  const items = news.length ? news.map((n) => `${newsIcon(n)} ${n.headline}`) : ['Sem manchetes por enquanto. O mundo está observando.'];
  const line = items.map((t) => `<span class="tick-item">${esc(t)}</span>`).join('');
  const secs = Math.max(20, Math.round(items.join('').length * 0.16)); // constant reading speed
  el.append(h('span', { class: 'ticker-label' }, 'AO VIVO'),
    h('div', { class: 'ticker-track' }, h('div', { class: 'ticker-move', style: { animationDuration: `${secs}s` }, html: line + line })));
}

function renderTabbar() {
  if (!ui.shell) return;
  const st = store.state;
  const active = VIEW_PARENT[ui.route.tab] !== undefined ? VIEW_PARENT[ui.route.tab] : ui.route.tab;
  const nDec = st.decisions?.length || 0;
  const newsBadge = (st.news || []).filter((n) => n.importance >= 2 && n.turn > ui.seenNewsTurn).length;
  const badges = { painel: nDec, mundo: active === 'mundo' ? 0 : Math.min(newsBadge, 9) };
  if (active === 'mundo') ui.seenNewsTurn = st.turn;
  const el = ui.shell.tabbar;
  el.innerHTML = '';
  for (const t of TABS) {
    el.appendChild(h('button', {
      class: ['tab', t.id === active && 'active'], type: 'button', 'aria-current': t.id === active ? 'page' : null,
      onclick: () => navigate(t.id),
    }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon), h('span', { class: 'tab-label' }, t.label),
    badges[t.id] ? h('span', { class: ['badge', t.id === 'painel' && st.decisions.some((d) => d.blocking) && 'badge-hot'] }, String(badges[t.id])) : null));
  }
}

function renderTimebar() {
  const el = ui.shell.timebar;
  el.innerHTML = '';
  const st = store.state;
  // hidden where the screen needs the room (map, settings, mission builder has its own sticky nav)
  el.classList.toggle('hidden', ui.route.tab === 'mapa' || ui.route.tab === 'ajustes' || (ui.route.tab === 'missoes' && ui.route.sub === 'nova'));
  if (st.gameOver) {
    el.append(h('div', { class: 'timebar-msg' }, 'Campanha encerrada.'), button('Resumo', () => { ui.lookingAfterEnd = false; renderAll(); }, { kind: 'primary', small: true }));
    return;
  }
  const blocked = store.blocked();
  if (blocked === 'decision') {
    const d = sortDecisions(st.decisions).find((x) => x.blocking);
    el.append(h('div', { class: 'timebar-msg' }, h('strong', null, 'Tempo parado: '), d?.title || 'decisão pendente'),
      button('Decidir', () => d && openDecision(store, d.id), { kind: 'urgent', small: true }));
    return;
  }
  if (blocked === 'launch') {
    el.append(h('div', { class: 'timebar-msg' }, h('strong', null, 'Lançamento em andamento')),
      button('Sala de controle', () => { launchState.key = null; syncLaunch(); }, { kind: 'urgent', small: true }));
    return;
  }
  el.append(
    button(h('span', { class: 'btn-label' }, '+1 semana'), () => advance(1, false), { kind: 'ghost', icon: '⏵', cls: 'time-btn' }),
    // "evento" hides on narrow screens with big text (styles.css @container timebar); aria-label keeps the full name
    button(h('span', { class: 'btn-label' }, 'Próximo', h('span', { class: 'lbl-more' }, ' evento')), () => advance(26, true), { kind: 'primary', icon: '⏩', cls: 'time-btn grow', title: 'Próximo evento' }));
}

function renderView() {
  if (!ui.shell || !store.state) return;
  const view = ui.shell.view;
  const key = `${ui.route.tab}/${ui.route.sub}`;
  const sameRoute = view.dataset.route === key;
  // a re-render of the same screen keeps its place; a new screen starts at the top (the old offset used to
  // carry over and open views mid-page with their headers hidden)
  const scroll = sameRoute ? view.scrollTop : 0;
  try { ui.cleanup?.(); } catch (e) { console.warn(e); }
  ui.cleanup = null;
  view.innerHTML = '';
  view.dataset.route = `${ui.route.tab}/${ui.route.sub}`;
  view.classList.toggle('view-map', ui.route.tab === 'mapa');
  const container = h('div', { class: 'view-inner' });
  view.appendChild(container);
  const tab = ui.route.tab;
  try {
    let ret;
    if (tab === 'painel') ret = dashboard.render(container, store);
    else if (tab === 'missoes') ret = missionsTab.render(container, store);
    else if (tab === 'pesquisa') ret = researchTab.render(container, store);
    else if (tab === 'mundo') ret = worldTab.render(container, store);
    else if (tab === 'equipe') ret = crewView.render(container, store);
    else if (tab === 'ajustes') ret = renderSettings(container, store, { onExit: () => history.length > 1 ? history.back() : navigate('painel'), onQuit: () => { store.unload(); } });
    else if (tab === 'mapa') ret = renderMap(container);
    if (typeof ret === 'function') ui.cleanup = ret;
  } catch (e) {
    console.error(e);
    container.innerHTML = '';
    container.appendChild(fallbackPanel('Esta aba ainda está em construção. O resto do jogo continua funcionando.', e));
  }
  view.scrollTop = scroll;
  renderTimebar();
}

/** Mapa tab comes from another module (map.js): load lazily and fall back gracefully. */
function renderMap(container) {
  if (ui.mapModule === null) {
    container.appendChild(fallbackPanel('O mapa ainda não está disponível nesta versão.'));
    return null;
  }
  if (ui.mapModule === undefined) {
    container.appendChild(h('div', { class: 'loading' }, 'Carregando mapa…'));
    import('./map.js').then((m) => { ui.mapModule = m; if (ui.route.tab === 'mapa') renderView(); })
      .catch((e) => { console.error(e); ui.mapModule = null; if (ui.route.tab === 'mapa') renderView(); });
    return null;
  }
  try {
    const fn = ui.mapModule.render || ui.mapModule.default;
    if (typeof fn !== 'function') throw new Error('map.js sem render()');
    const ret = fn(container, store);
    return typeof ret === 'function' ? ret : null;
  } catch (e) {
    console.error(e);
    container.innerHTML = '';
    container.appendChild(fallbackPanel('O mapa encontrou um problema.', e));
    return null;
  }
}

// ------------------------------------------------------------------ time

function advance(weeks, stopOnEvent) {
  const st = store.state;
  if (!st || st.gameOver) return;
  const b = store.blocked();
  if (b === 'decision') {
    const d = sortDecisions(st.decisions).find((x) => x.blocking);
    if (d) openDecision(store, d.id);
    return;
  }
  if (b === 'launch') { launchState.key = null; syncLaunch(); return; }
  const res = store.dispatch({ type: 'time/advance', weeks, stopOnEvent });
  if (!res?.ok) toast(res?.error || 'O tempo não pôde avançar.', 'bad');
}

/** Feedback after time passes: toast + auto-open the decision that stopped the clock. */
function afterAdvance(res) {
  const st = store.state;
  if (!st || !res?.ok || st.gameOver) return;
  const n = res.advanced || 0;
  const weeks = n === 1 ? '1 semana' : `${n} semanas`;
  const queue = sortDecisions(st.decisions);
  const top = queue[0];
  if (st.activeLaunch) return;
  if (res.stoppedBy === 'decision' || (res.stoppedBy === 'newDecision' && top && (top.blocking || top.urgency >= 3))) {
    store.vibrate([30, 40, 30]);
    if (top) setTimeout(() => openDecision(store, top.id), 120);
    return;
  }
  if (res.stoppedBy === 'newDecision') toast(`+${weeks} · nova decisão no painel`, 'warn');
  else if (res.stoppedBy === 'news') toast(`+${weeks} · ${st.news[0]?.headline || 'notícia importante'}`, 'info', 4000);
  else if (n > 0) toast(`+${weeks}`, 'info', 1500);
}

// ------------------------------------------------------------------ launch scene

const launchState = { key: null, close: null };

function closeLaunch() {
  const c = launchState.close;
  launchState.close = null;
  launchState.key = null;
  if (c) try { c(); } catch (e) { console.warn(e); }
}

/** Open the launch scene exactly once per (mission, phase); close it when activeLaunch clears. */
function syncLaunch() {
  const al = store.state?.activeLaunch;
  if (!al) {
    if (launchState.close) {
      const c = launchState.close;
      launchState.close = null;
      // a scrub (launch ended without 'launch/finish') leaves the scene's 1,6 s ADIADO banner on screen
      const delay = launchState.lastType === 'launch/finish' ? 60 : 1800;
      setTimeout(() => { try { c(); } catch { /* already closed */ } }, delay);
    }
    launchState.key = null;
    return;
  }
  const key = `${al.missionId}|${al.phase}`;
  if (launchState.key === key) return;
  if (launchState.close) { try { launchState.close(); } catch { /* */ } launchState.close = null; }
  launchState.key = key;
  closeDecision();
  closeAllModals();
  import('./launch-scene.js')
    .then((m) => {
      if (launchState.key !== key) return;
      if (typeof m.openLaunchScene !== 'function') throw new Error('launch-scene.js sem openLaunchScene');
      const c = m.openLaunchScene(store);
      launchState.close = typeof c === 'function' ? c : null;
    })
    .catch((e) => {
      console.error('[Ad Astra] cena de lançamento indisponível, usando sala simplificada', e);
      if (launchState.key === key) launchState.close = openFallbackLaunch(store);
    });
}

/** Minimal control room so the game never gets stuck if launch-scene.js fails. */
function openFallbackLaunch(store) {
  const body = h('div', { class: 'fallback-launch' });
  let closeModal = null;
  const draw = () => {
    const al = store.state?.activeLaunch;
    body.innerHTML = '';
    if (!al) { closeModal?.(); return; }
    const m = (store.state.missions || []).find((x) => x.id === al.missionId);
    body.append(
      h('div', { class: 'muted small' }, 'Sala de controle simplificada'),
      h('h2', null, m?.name || 'Lançamento'),
      h('div', { class: 'chips' }, chip(`Ato: ${al.act}`, 'accent'), al.estimate ? chip(`Chance ${fmtBand(al.estimate.low, al.estimate.high)}`, 'info') : null,
        al.weather?.label ? chip(al.weather.label, 'muted') : null, chip(`Comando: ${al.commandPoints ?? 0}`, 'muted')),
      h('ol', { class: 'ms-list' }, (al.milestones || []).map((ms) => h('li', { class: `ms-${ms.status}` },
        `${ms.status === 'ok' ? '✓' : ms.status === 'fail' ? '✕' : ms.status === 'anomaly' ? '!' : '·'} ${ms.label}`))),
      h('div', { class: 'log small' }, (al.log || []).slice(-4).map((l) => h('div', null, l.text))),
      al.outcome ? h('p', { class: 'outcome' }, al.outcome.headline || al.outcome.level) : null);
    const act = (a) => { const r = store.dispatch(a); if (!r?.ok) toast(r?.error || 'Ação falhou', 'bad'); draw(); };
    const row = h('div', { class: 'btn-col' });
    if (al.pendingIntervention) {
      body.append(h('p', null, h('strong', null, al.pendingIntervention.prompt)));
      for (const o of al.pendingIntervention.options || []) row.append(button(`${o.label}${o.cost ? ` (−${o.cost})` : ''}`, () => act({ type: 'launch/choose', optionId: o.id }), { disabled: o.disabled }));
    } else if (al.pendingHold) {
      body.append(h('p', null, h('strong', null, al.pendingHold.reason)));
      for (const o of al.pendingHold.options || []) row.append(button(o.label, () => act({ type: 'launch/hold', choice: o.id })));
    } else if (al.act === 'prelaunch') row.append(button('Iniciar contagem', () => act({ type: 'launch/countdown' }), { kind: 'primary' }));
    else if (al.act === 'result') row.append(button('Concluir', () => act({ type: 'launch/finish' }), { kind: 'primary' }));
    else row.append(button('Próximo marco', () => act({ type: 'launch/step' }), { kind: 'primary' }));
    body.append(row);
  };
  draw();
  const unsub = store.subscribe(() => draw());
  closeModal = openModal(body, { title: '', dismissable: false, cls: 'launch-fallback', onClose: () => unsub() });
  return closeModal;
}

// ------------------------------------------------------------------ go

window.addEventListener('error', (e) => console.error('[Ad Astra]', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[Ad Astra]', e.reason));
console.info(`Ad Astra v${APP_VERSION} (${BUILD_DATE})`);
boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = '';
    root.appendChild(fallbackPanel('Algo deu errado ao iniciar. Recarregue a página.', e));
  }
});

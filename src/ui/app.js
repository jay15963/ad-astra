// UI entry point: boot, title screen, 5-tab shell, headline ticker, time controls,
// decision cards, launch scene hand-off and game over. The UI only observes state and dispatches actions.

import { loadData, browserReader } from '../core/data.js';
import { createStore } from './store.js';
import { h, raw, button, toast, fallbackPanel, closeAllModals, fmtDate, chip, openModal, fmtBand, esc, iconSVG, cleanFlags } from './components.js';
import { emblemSVG } from './portrait.js';
import { applySettings, render as renderSettings, APP_VERSION, BUILD_DATE } from './settings.js';
import { renderTitle, renderGameOver } from './newgame.js';
import { openDecision, sortDecisions, closeDecision } from './decisions.js';
import * as dashboard from './dashboard.js';
import * as missionsTab from './missions-tab.js';
import * as researchTab from './research-tab.js';
import * as worldTab from './world-tab.js';
import * as crewView from './crew-view.js';

// bottom navbar (CSmanager .barra-inferior): stroke icon names from components.ICONS. The centre disc (time)
// sits after Pesquisa (DISC_AT = index of the first tab drawn after it). 6 tabs + the disc = 7 equal slots, so
// the disc lands exactly on the screen centre, like CSmanager's 7-slot bar (cs-dash-1.png).
const DISC_AT = 3;
const HOLD_MS = 450; // long-press on the disc before "Próximo evento" fires
const RUN_MAX_WEEKS = 26; // "Próximo evento" looks at most half a year ahead (as before)
const RUN_STEP_MS = 90; // pause between the run's weeks, so a 1-4 week run is visible on the disc
const RUN_MIN_MS = 520; // a run shows its ring at least this long (most runs stop on an event within 1-4 weeks)
const MOVE_CANCEL_PX = 10; // a finger that slides this far off its start point cancels the long-press
const HINT_KEY = 'adastra.hint.hold';
const TABS = [
  { id: 'painel', label: 'Painel' },
  { id: 'missoes', label: 'Missões' },
  { id: 'pesquisa', label: 'Pesquisa' },
  { id: 'mapa', label: 'Mapa' },
  { id: 'mundo', label: 'Mundo' },
  { id: 'equipe', label: 'Equipe' },
];
// screen names shown as the header title
const SCREEN_TITLES = { painel: 'Painel', missoes: 'Missões', pesquisa: 'Pesquisa', mapa: 'Mapa', mundo: 'Mundo', equipe: 'Equipe', ajustes: 'Ajustes' };
// views reachable from a tab (highlight the parent tab)
const VIEW_PARENT = { ajustes: null };

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
  markPerfTier();
  let data;
  try {
    data = await loadData(prefetchedReader());
    perfMark('adastra:data');
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
    navigate, openDecision: (id) => openDecision(store, id), advance, advanceToEvent: () => runToEvent(), route: () => ui.route, version: APP_VERSION,
    // a view that swaps screens inside one route (builder steps) asks for the top explicitly
    scrollTop: () => { if (ui.shell?.view) ui.shell.view.scrollTop = 0; },
    // space map "Planejar missão aqui": open Missões › Montar with this destination preselected
    planMission: (destId) => { store.ui.pendingDestination = destId || null; navigate('missoes', 'nova'); },
  };
  globalThis.adastra = store; // debugging aid in the console
  store.subscribe(onStoreChange);
  // sheets push their own history entry (components.openModal), so back closes a sheet first; a real route
  // change leaves those entries behind it
  window.addEventListener('hashchange', () => { closeAllModals({ keepHistory: true }); parseHash(); renderView(); renderTabbar(); renderHeader(); });
  parseHash();
  // resume straight into the game if a save exists and we were mid-launch (Pilar: fechar o app não prejudica)
  const info = store.saveInfo();
  if (info?.actor && store.state == null && hasActiveLaunchInSave()) {
    if (store.load()) { renderAll(); afterFirstPaint(); return; }
  }
  showTitle();
  afterFirstPaint();
}

/**
 * Reader that first takes the downloads index.html started before the module graph (window.__adastraData),
 * then falls back to a normal fetch (old browser, failed prefetch, retry after an error).
 */
function prefetchedReader() {
  const fallback = browserReader();
  const pre = globalThis.__adastraData || null;
  return async (name) => {
    const p = pre?.[name];
    if (p) {
      delete pre[name]; // one use: a retry fetches fresh
      try { return await p; } catch { /* fall through */ }
    }
    return fallback(name);
  };
}

function perfMark(name) { try { performance.mark(name); } catch { /* */ } }

/**
 * Low-end hint for CSS and canvas code: <html data-perf="lite"> on phones with ≤ 4 cores or ≤ 3 GB, or when
 * the browser asks to save data. Read it with document.documentElement.dataset.perf === 'lite'.
 */
function markPerfTier() {
  try {
    const n = navigator;
    const lite = (n.hardwareConcurrency && n.hardwareConcurrency <= 4) || (n.deviceMemory && n.deviceMemory <= 3) || n.connection?.saveData;
    document.documentElement.dataset.perf = lite ? 'lite' : 'full';
  } catch { /* */ }
}

/** After the first screen is up: note the timing and warm the lazy Mapa module while the phone is idle. */
function afterFirstPaint() {
  perfMark('adastra:first-render');
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => {
    if (ui.mapModule !== undefined) return;
    import('./map.js').then((m) => { if (ui.mapModule === undefined) ui.mapModule = m; }).catch(() => { /* loaded on demand */ });
  }, { timeout: 4000 });
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
  document.body.classList.remove('in-shell');
  renderTitle(appRoot, store, {
    onStart: () => { navigate('painel'); renderAll(); },
    onSettings: () => {
      appRoot.innerHTML = '';
      const c = h('div', { class: 'standalone' });
      appRoot.appendChild(h('div', { class: 'title-page' }, c));
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
  else { parseHash(); renderView(); renderTabbar(); renderHeader(); }
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
  // "Próximo evento" runs week by week: only the cheap chrome (date, ticker, disc ring) follows each step;
  // the screen redraws once at the end (runToEvent)
  if (ui.run && type === 'time/advance' && !state.gameOver && !state.activeLaunch && ui.shell) {
    renderHeader(); renderTicker(); renderTabbar();
    return;
  }
  renderAll();
  if (type === 'time/advance' && !ui.run) afterAdvance(res);
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
  renderTabbar();
  renderView();
  syncLaunch();
}

// ------------------------------------------------------------------ shell

function ensureShell() {
  if (ui.shell && ui.shell.root.isConnected) return;
  appRoot.innerHTML = '';
  document.body.classList.add('in-shell');
  const s = {
    header: h('header', { class: 'topbar' }),
    ticker: h('div', { class: 'ticker', role: 'marquee', 'aria-label': 'Manchetes', onclick: () => navigate('mundo') }),
    view: h('main', { class: 'view', id: 'view' }),
    tabbar: h('nav', { class: 'tabbar', 'aria-label': 'Abas' }),
  };
  s.root = h('div', { class: 'shell' }, s.header, s.ticker, s.view, s.tabbar);
  appRoot.appendChild(s.root);
  ui.shell = s;
  ui.tickerTop = null;
  buildTabbar(s.tabbar);
}

/** Header (CSmanager .barra-topo): emblem + current screen name, "agência · data" below, Ajustes on the right. */
function renderHeader() {
  if (!ui.shell || !store?.state) return;
  const st = store.state;
  const me = st.actors?.[st.playerId] || { id: st.playerId, short: String(st.playerId || '').toUpperCase() };
  const el = ui.shell.header;
  const title = SCREEN_TITLES[ui.route.tab] || 'Painel';
  // skip rebuilding the emblem SVG on every action: only route, agency or date change the header
  const key = `${title}|${st.playerId}|${st.turn}|${me.flag || ''}|${me.short || me.name || ''}|${me.color || ''}`;
  if (el.dataset.key === key && el.firstChild) return;
  el.dataset.key = key;
  el.innerHTML = '';
  // no flag here: the emblem already identifies the agency (and Windows has no flag-emoji glyphs)
  const agency = `${me.short || me.name || st.playerId}`;
  el.append(
    h('button', { class: 'agency', type: 'button', onclick: () => navigate('painel'), 'aria-label': `${title} · ${agency}. Ir ao painel` },
      raw(emblemSVG(me, { size: 30 }), 'agency-emblem'),
      h('div', { class: 'agency-text' },
        h('h1', { class: 'agency-title' }, title),
        h('div', { class: 'agency-sub' }, `${agency} · ${fmtDate(st.turn, st.startYear)}`))),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Ajustes', title: 'Ajustes', onclick: () => navigate('ajustes') }, raw(iconSVG('ajustes', 24), 'ic-wrap')));
}

function renderTicker() {
  const news = (store.state.news || []).slice(0, 8);
  const top = news[0]?.id || 'none';
  if (ui.tickerTop === top) return; // keep the marquee running smoothly
  ui.tickerTop = top;
  const el = ui.shell.ticker;
  el.innerHTML = '';
  // no emoji in the strip (DESIGN §2): headlines only, separated by a dot
  const items = news.length ? news.map((n) => cleanFlags(n.headline || '')) : ['Sem manchetes por enquanto. O mundo está observando.'];
  const line = items.map((t) => `<span class="tick-item">${esc(t)}</span>`).join('');
  const secs = Math.max(20, Math.round(items.join('').length * 0.16)); // constant reading speed
  el.append(h('span', { class: 'ticker-label' }, 'Ao vivo'),
    h('div', { class: 'ticker-track' }, h('div', { class: 'ticker-move', style: { animationDuration: `${secs}s` }, html: line + line })));
}

/** Tab buttons + centre disc, built once per shell: renders update them in place (a long-press survives). */
function buildTabbar(el) {
  el.innerHTML = '';
  ui.tabs = {};
  TABS.forEach((t, i) => {
    if (i === DISC_AT) el.appendChild(buildDisc());
    const badge = h('span', { class: 'tab-badge', 'aria-hidden': 'true' });
    badge.hidden = true;
    const btn = h('button', { class: 'tab', type: 'button', onclick: () => navigate(t.id) },
      h('span', { class: 'tab-icon' }, raw(iconSVG(t.id, 24), 'ic-wrap'), badge),
      h('span', { class: 'tab-label' }, t.label));
    ui.tabs[t.id] = { btn, badge };
    el.appendChild(btn);
  });
}

function renderTabbar() {
  if (!ui.shell || !ui.tabs) return;
  const st = store.state;
  const active = VIEW_PARENT[ui.route.tab] !== undefined ? VIEW_PARENT[ui.route.tab] : ui.route.tab;
  const nDec = st.decisions?.length || 0;
  const newsBadge = (st.news || []).filter((n) => n.importance >= 2 && n.turn > ui.seenNewsTurn).length;
  const badges = { painel: nDec, mundo: active === 'mundo' ? 0 : Math.min(newsBadge, 10) };
  if (active === 'mundo') ui.seenNewsTurn = st.turn;
  const hot = nDec > 0 && st.decisions.some((d) => d.blocking);
  for (const t of TABS) {
    const { btn, badge } = ui.tabs[t.id];
    const n = badges[t.id] || 0;
    const shown = t.id === 'mundo' && newsBadge > 9 ? '9+' : String(n);
    const badgeLabel = t.id === 'painel' ? `${n} ${n === 1 ? 'decisão pendente' : 'decisões pendentes'}` : `${shown} ${n === 1 ? 'notícia nova' : 'notícias novas'}`;
    btn.classList.toggle('active', t.id === active);
    btn.classList.toggle('hot', t.id === 'painel' && hot);
    if (t.id === active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    if (n) btn.setAttribute('aria-label', `${t.label}, ${badgeLabel}`); else btn.removeAttribute('aria-label');
    badge.hidden = !n;
    if (n && badge.textContent !== shown) badge.textContent = shown;
  }
  renderDisc();
}

// ------------------------------------------------------------------ centre disc (time)
// CSmanager .barra-inferior-central: tap = +1 semana; hold = próximo evento (the ring fills while held, then
// shows the run). A stopped clock turns the disc into the way out (Decidir / Lançar) instead of a dead button.

function buildDisc() {
  const disc = h('span', { class: 'tab-disc', 'aria-hidden': 'true' });
  const label = h('span', { class: 'tab-label', 'aria-hidden': 'true' });
  const btn = h('button', { class: 'tab-central', type: 'button' }, disc, label);
  const d = ui.disc = { btn, disc, label, mode: '', key: '', raf: 0, fired: false, releasedAt: 0, down: null, slid: false };
  btn.addEventListener('pointerdown', (e) => {
    d.fired = false;
    d.slid = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // remember what the disc was when the finger came down: a run that ends between pointerdown and click
    // must not turn a "Parar" tap into "+1 semana"
    d.down = { mode: d.mode, x: e.clientX, y: e.clientY, at: performance.now() };
    // touch pointers are captured implicitly, so pointerleave would only fire on release: let it go
    try { if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId); } catch { /* */ }
    if (d.mode === 'play') startHold();
  });
  btn.addEventListener('pointermove', (e) => {
    if (!d.down || d.slid || !e.buttons) return;
    if (Math.hypot(e.clientX - d.down.x, e.clientY - d.down.y) > MOVE_CANCEL_PX) { d.slid = true; endHold(); }
  });
  // leaving while still pressed = slid away (touch fires pointerleave after pointerup too: buttons is 0 then)
  btn.addEventListener('pointerleave', (e) => { if (d.down && e.buttons) d.slid = true; endHold(); });
  for (const ev of ['pointerup', 'pointercancel']) btn.addEventListener(ev, endHold);
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // Android long-press menu
  btn.addEventListener('click', onDiscClick);
  // Shift+Enter = the hold action from a keyboard (the Painel links also offer both actions)
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey && d.mode === 'play') { e.preventDefault(); runToEvent(); }
  });
  return btn;
}

function startHold() {
  const d = ui.disc;
  const t0 = performance.now();
  d.btn.classList.add('segurando');
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / HOLD_MS);
    d.disc.style.setProperty('--anel', `${Math.round(p * 360)}deg`);
    if (p < 1) { d.raf = requestAnimationFrame(step); return; }
    d.raf = 0;
    d.fired = true; // the click that follows the release is not a tap
    d.btn.classList.remove('segurando');
    store.vibrate(15);
    rememberHint();
    runToEvent();
  };
  d.raf = requestAnimationFrame(step);
}

function endHold() {
  const d = ui.disc;
  if (!d) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  d.raf = 0;
  d.btn.classList.remove('segurando');
  if (!ui.run) d.disc.style.removeProperty('--anel');
  d.releasedAt = performance.now();
}

function onDiscClick() {
  const d = ui.disc;
  const now = performance.now();
  // the mode the press started in (pointer), else the current one (keyboard: Space/Enter)
  const down = d.down && now - d.down.at < 2000 ? d.down : null;
  const slid = d.slid;
  d.down = null;
  d.slid = false;
  // the click that ends a long-press is not a tap (a stale flag from a release outside the button is ignored)
  if (d.fired) { d.fired = false; if (now - d.releasedAt < 800) return; }
  if (slid) return; // the finger slid away: cancelled, neither a hold nor a tap
  const mode = down ? down.mode : d.mode;
  if (mode === 'run') { if (ui.run) ui.run.cancel = true; return; }
  // a run that just ended on its own: this tap was meant as "Parar", not as another week
  if (mode === 'play' && now - (ui.runEndedAt || 0) < 300) return;
  if (mode === 'over' || d.mode === 'over') { showSummary(); return; }
  advance(1, false); // stopped clock: advance() opens the decision / the control room
  if (mode === 'play') maybeHint();
}

/** Game over, looking at the final world: the disc goes back to the campaign summary. */
function showSummary() {
  if (!store?.state?.gameOver) return;
  ui.lookingAfterEnd = false;
  renderAll();
}

function discState() {
  const st = store.state;
  if (ui.run) return { mode: 'run', icon: 'carregando', label: 'Parar', aria: 'Avançando até o próximo evento. Toque para parar.' };
  if (!st || st.gameOver) return { mode: 'over', icon: 'trofeu', label: 'Resumo', aria: 'Campanha encerrada. Ver o resumo da campanha' };
  const b = store.blocked();
  if (b === 'decision') {
    const dec = sortDecisions(st.decisions).find((x) => x.blocking);
    return { mode: 'decision', icon: 'alerta', label: 'Decidir', aria: `Tempo parado: ${dec?.title || 'decisão pendente'}. Abrir a decisão` };
  }
  if (b === 'launch') return { mode: 'launch', icon: 'missoes', label: 'Lançar', aria: 'Lançamento em andamento. Abrir a sala de controle' };
  return { mode: 'play', icon: 'continuar', label: '+1 semana', aria: 'Avançar 1 semana. Segure para avançar até o próximo evento' };
}

function renderDisc() {
  const d = ui.disc;
  if (!d || !store?.state) return;
  const s = discState();
  // the run's length is unknown (it stops on the next event, usually within 1-4 weeks): the ring is an
  // indeterminate arc that spins (.girando) and grows a little with each week, never a near-empty x/26 fill
  if (ui.run) d.disc.style.setProperty('--anel', `${Math.round(Math.min(330, 110 + ui.run.done * 30))}deg`);
  const key = `${s.mode}|${s.label}|${s.aria}`;
  if (d.key === key) return;
  if (d.mode === 'play' && s.mode !== 'play') endHold();
  d.key = key;
  d.mode = s.mode;
  d.btn.className = ['tab-central', `is-${s.mode}`, s.mode === 'run' && 'ocupado girando'].filter(Boolean).join(' ');
  d.btn.disabled = !store.state;
  d.btn.setAttribute('aria-label', s.aria);
  d.btn.title = s.mode === 'play' ? 'Toque: +1 semana · Segure: próximo evento' : s.aria;
  if (s.mode !== 'run') d.disc.style.removeProperty('--anel');
  d.disc.innerHTML = iconSVG(s.icon, 26);
  d.label.textContent = s.label;
}

/** First tap: say once that holding the disc skips to the next event. */
function maybeHint() {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch { return; }
  setTimeout(() => toast('Segure para avançar até o próximo evento', 'info', 4200), 500);
}
function rememberHint() { try { localStorage.setItem(HINT_KEY, '1'); } catch { /* */ } }

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
  // entry motion only when the screen changes, not on every re-render of the same screen
  const container = h('div', { class: ['view-inner', !sameRoute && 'entering'] });
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
  if (ui.run) return; // a "Próximo evento" run owns the clock until it stops
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Próximo evento": the same advance as time/advance {weeks: 26, stopOnEvent: true}, dispatched one week at a
 * time so the disc ring can show the run (CSmanager .ocupado). The engine checks its stop conditions per
 * week, so it stops at the same place; it also stops on a stopped clock or when the disc is tapped again.
 */
async function runToEvent(maxWeeks = RUN_MAX_WEEKS) {
  const st = store?.state;
  if (ui.run || !st || st.gameOver) return;
  if (store.blocked()) { advance(1, false); return; }
  const run = ui.run = { done: 0, max: maxWeeks, cancel: false };
  const quick = !!store.settings.reduceMotion;
  const t0 = performance.now();
  renderDisc();
  let last = null;
  let total = 0;
  try {
    while (total < maxWeeks && !run.cancel) {
      if (!store.state || store.state.gameOver || store.blocked()) break;
      const res = store.dispatch({ type: 'time/advance', weeks: 1, stopOnEvent: true });
      if (!res?.ok) { toast(res?.error || 'O tempo não pôde avançar.', 'bad'); break; }
      last = res;
      total += res.advanced || 0;
      run.done = total;
      renderDisc();
      if (res.stoppedBy || !res.advanced) break;
      await wait(quick ? 0 : RUN_STEP_MS);
    }
    // keep the ring up long enough to be seen (a 1-week run would otherwise flash for ~90ms)
    const left = RUN_MIN_MS - (performance.now() - t0);
    if (!quick && left > 0 && !run.cancel) await wait(left);
  } finally {
    ui.run = null;
    ui.runEndedAt = performance.now();
  }
  if (!store.state) return;
  renderAll();
  afterAdvance({ ok: true, advanced: total, stoppedBy: last?.stoppedBy || null });
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
registerServiceWorker();

/** Network-first service worker (sw.js at the root): no stale mix of modules after a deploy, offline fallback. */
function registerServiceWorker() {
  try {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update?.().catch(() => { /* offline */ }))
      .catch((e) => console.warn('[Ad Astra] service worker:', e?.message || e));
  } catch { /* not supported */ }
}
boot().catch((e) => {
  console.error(e);
  const root = document.getElementById('app');
  if (root) {
    root.innerHTML = '';
    root.appendChild(fallbackPanel('Algo deu errado ao iniciar. Recarregue a página.', e));
  }
});

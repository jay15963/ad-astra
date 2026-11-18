// UI entry point: boot, title screen, the shell (CSmanager movel.css: compact header with ☰, ticker, view, bottom
// bar with 4 destinations + the time disc, left drawer .gaveta over .veu), decision cards, launch scene hand-off
// and game over. Screens come from the registry (screens.js); the UI only observes state and dispatches actions.

import { loadData, browserReader } from '../core/data.js';
import * as time from '../core/time.js';
import { createStore } from './store.js';
import { h, raw, button, toast, fallbackPanel, closeAllModals, fmtDate, fmtMonth, chip, openModal, fmtBand, esc, iconSVG, cleanFlags, eraInfo, passedText } from './components.js';
import { emblemSVG } from './portrait.js';
import { useEmblemData } from './emblem.js';
import { applySettings, render as renderSettings, APP_VERSION, BUILD_DATE } from './settings.js';
import { renderTitle, renderGameOver } from './newgame.js';
import { openDecision, sortDecisions, closeDecision } from './decisions.js';
import { screenById, bottomScreens, drawerSections, resolveRoute, bottomOwner, drawerCurrent, badgeOf, isAvailable } from './screens.js';
import { createDrawer } from './drawer.js';
import * as dashboard from './dashboard.js';
import * as missionsTab from './missions-tab.js';
import * as researchTab from './research-tab.js';
import * as worldTab from './world-tab.js';
import * as crewView from './crew-view.js';

// bottom navbar (CSmanager .barra-inferior): the 4 bottom screens of the registry with the time disc in the
// middle (DISC_AT = index of the first tab drawn after it). 4 tabs + the disc = 5 equal slots, so the disc lands
// exactly on the screen centre. Everything else lives in the drawer (☰).
const DISC_AT = 2;
const HOLD_MS = 450; // long-press on the disc before "Próximo evento" fires
const RUN_STEP_MS = 90; // pause between the run's turns, so a 1-4 turn run is visible on the disc
const RUN_MIN_MS = 520; // a run shows its ring at least this long (most runs stop on an event within 1-4 turns)
const MOVE_CANCEL_PX = 10; // a finger that slides this far off its start point cancels the long-press
const HINT_KEY = 'adastra.hint.hold';

const ui = {
  route: { tab: 'painel', sub: '' },
  lookingAfterEnd: false,
  cleanup: null,
  shell: null,
  tickerTop: null,
  seenNewsTurn: -1,
  // screen modules: id -> module (loaded), null (failed). The bottom screens and the old tabs are static
  // imports (index.html preloads them), so they render without a loading flash.
  mods: new Map([['painel', dashboard], ['missoes', missionsTab], ['mundo', worldTab], ['pesquisa', researchTab], ['equipe', crewView]]),
  drawer: null,
  drawerEntry: false, // a history entry of ours sits on top while the drawer is open (Android back closes it)
  drawerPop: false,
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
  store = createStore(data, {
    reader: browserReader(),
    // campaign vs Corrida Lunar: the loader merges the packs the scenario needs (data.js, §4)
    loadScenario: (scenarioId) => loadData(browserReader(), { scenarioId }).then((d) => { useEmblemData(d); return d; }),
  });
  // emblem specs (data/core/emblems.json, emblem-parts.json) come with the core pack: register them before the first paint
  useEmblemData(data);
  window.addEventListener('adastra:emblems', () => { if (store?.state) renderAll(); });
  syncEra();
  applySettings(store.settings);
  store.ui = {
    navigate, openDecision: (id) => openDecision(store, id), advance, advanceToEvent: () => runToEvent(), route: () => ui.route, version: APP_VERSION,
    // a view that swaps screens inside one route (builder steps) asks for the top explicitly
    scrollTop: () => { if (ui.shell?.view) ui.shell.view.scrollTop = 0; },
    // space map "Planejar missão aqui": open Missões › Montar with this destination preselected
    planMission: (destId) => { store.ui.pendingDestination = destId || null; navigate('missoes', 'nova'); },
    // item 9: a briefing/opportunity accepted without hardware opens the mission at the vehicle step
    openMissionHardware: (missionId) => { if (missionId) navigate('missoes', `m/${missionId}`); },
    openDrawer: () => openDrawer(),
    stepLabel: () => store.stepLabel(),
  };
  globalThis.adastra = store; // debugging aid in the console
  store.subscribe(onStoreChange);
  // sheets push their own history entry (components.openModal), so back closes a sheet first; a real route
  // change leaves those entries behind it
  window.addEventListener('hashchange', () => { closeAllModals({ keepHistory: true }); onRoute(); });
  // Android back with the drawer open: close the drawer, stay on the screen
  window.addEventListener('popstate', () => {
    if (ui.drawer?.isOpen() && ui.drawerEntry) { ui.drawerPop = true; ui.drawer.close(); ui.drawerPop = false; ui.drawerEntry = false; }
  });
  parseHash();
  // resume straight into the game if a save exists and we were mid-launch (Pilar: fechar o app não prejudica)
  const info = store.saveInfo();
  if (info?.actor && store.state == null && info.activeLaunch) {
    if (await store.loadSlot('auto')) { renderAll(); afterFirstPaint(); return; }
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

/** Era skin hook (DESIGN.md: body[data-era="e1".."e7"] token blocks; e4 is the current look). */
function syncEra() {
  try {
    const id = eraInfo(store?.state, store?.data).id;
    if (document.body.dataset.era !== id) document.body.dataset.era = id;
  } catch { /* */ }
}

/** After the first screen is up: note the timing and warm the lazy Mapa module while the phone is idle. */
function afterFirstPaint() {
  perfMark('adastra:first-render');
  const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => { loadScreen('mapa').catch(() => { /* loaded on demand */ }); }, { timeout: 4000 });
}

function showTitle() {
  ui.shell = null;
  ui.lookingAfterEnd = false;
  closeDrawer({ restoreFocus: false });
  closeAllModals();
  closeLaunch();
  // the title screen has no route: drop a stale '#ajustes' (a later start navigates to #painel)
  if (location.hash) { try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* */ } }
  document.body.classList.remove('in-shell');
  syncEra();
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
  ui.route = resolveRoute(location.hash || '', store?.state ?? undefined, store?.data);
}

/** navigate('missoes', 'nova') — changes hash (Android back button works). */
function navigate(tab, sub = '') {
  const target = `#${tab}${sub ? '/' + sub : ''}`;
  if (location.hash !== target) location.hash = target; // triggers hashchange -> render
  else onRoute();
}

function onRoute() {
  parseHash();
  if (!ui.shell) return;
  renderView(); renderTabbar(); renderHeader(); renderDrawer();
}

// ------------------------------------------------------------------ store reaction

function onStoreChange(state, action, res) {
  if (!state) { showTitle(); return; }
  const type = action?.type || '';
  launchState.lastType = type;
  syncEra();
  if (type === 'ui/settings') { applySettings(store.settings); if (ui.shell) renderView(); return; }
  if (type === 'ui/load' || type === 'ui/newGame') { parseHash(); renderAll(); return; }
  // during an active launch the overlay covers the shell: skip heavy re-renders on every step
  if (state.activeLaunch && type.startsWith('launch/')) { syncLaunch(); return; }
  // "Próximo evento" runs turn by turn: only the cheap chrome (date, ticker, disc ring) follows each step;
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
    closeDrawer({ restoreFocus: false });
    closeLaunch();
    renderGameOver(appRoot, store, { onNewGame: showTitle, onKeepLooking: () => { ui.lookingAfterEnd = true; renderAll(); } });
    return;
  }
  ensureShell();
  renderHeader();
  renderTicker();
  renderTabbar();
  renderView();
  renderDrawer();
  syncLaunch();
}

// ------------------------------------------------------------------ shell

function ensureShell() {
  if (ui.shell && ui.shell.root.isConnected) return;
  appRoot.innerHTML = '';
  document.body.classList.add('in-shell');
  const s = {
    header: h('header', { class: 'topbar' }),
    ticker: h('div', { class: 'ticker', role: 'marquee', 'aria-label': 'Manchetes', onclick: () => navigate('mundo', 'noticias') }),
    view: h('main', { class: 'view', id: 'view' }),
    tabbar: h('nav', { class: 'tabbar', 'aria-label': 'Abas' }),
  };
  s.root = h('div', { class: 'shell' }, s.header, s.ticker, s.view, s.tabbar);
  ui.drawer = createDrawer({
    onPick: pickDrawerItem,
    onOpenChange: (open) => {
      ui.shell?.menuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
      s.root.toggleAttribute('inert', open); // the screen behind the veil is out of reach while the menu is open
      if (!open && ui.drawerEntry && !ui.drawerPop) { ui.drawerEntry = false; try { history.back(); } catch { /* */ } }
    },
    header: drawerHeader,
  });
  appRoot.append(s.root, ui.drawer.veil, ui.drawer.el);
  ui.shell = s;
  ui.tickerTop = null;
  buildTabbar(s.tabbar);
}

function openDrawer() {
  if (!ui.drawer || ui.drawer.isOpen()) return;
  renderDrawer();
  try { history.pushState({ adastraDrawer: 1 }, ''); ui.drawerEntry = true; } catch { ui.drawerEntry = false; }
  ui.drawer.open(ui.shell?.menuBtn);
}

function closeDrawer(opts) {
  if (ui.drawer?.isOpen()) ui.drawer.close(opts);
}

/** A drawer item: a screen, a shortcut into a sub-view (go), or a shell action. */
function pickDrawerItem(d) {
  if (d.action === 'title') {
    closeDrawer({ restoreFocus: false });
    // the game is saved after every action: leaving only unloads it (Continuar brings it back)
    setTimeout(() => store.unload(), 0);
    return;
  }
  const [tab, sub] = d.go ? [d.go.split('/')[0], d.go.split('/').slice(1).join('/')] : [d.id, ''];
  const target = `#${tab}${sub ? '/' + sub : ''}`;
  // replace the drawer's own history entry with the destination: back from there returns to where we were
  if (ui.drawerEntry) {
    ui.drawerEntry = false;
    closeDrawer({ restoreFocus: false });
    try { history.replaceState(null, '', target); } catch { location.hash = target; }
    closeAllModals({ keepHistory: true });
    onRoute();
  } else {
    closeDrawer({ restoreFocus: false });
    navigate(tab, sub);
  }
  ui.shell?.view?.focus?.({ preventScroll: true });
}

/** Badges for every visible screen: registry badges + the shell's own (Mundo = unread important news). */
function screenBadges() {
  const st = store.state;
  const out = {};
  for (const s of drawerSections(st, store.data)) for (const d of s.items) out[d.id] = badgeOf(d, st, store);
  for (const d of bottomScreens()) out[d.id] = badgeOf(d, st, store);
  const newsBadge = (st.news || []).filter((n) => n.importance >= 2 && n.turn > ui.seenNewsTurn).length;
  out.mundo = bottomOwner(ui.route.tab) === 'mundo' ? 0 : Math.min(newsBadge, 10);
  return out;
}

function renderDrawer() {
  if (!ui.drawer || !store?.state) return;
  ui.drawer.update(drawerSections(store.state, store.data), drawerCurrent(ui.route), screenBadges());
}

function drawerHeader() {
  const st = store.state;
  const me = st?.actors?.[st.playerId] || { id: st?.playerId };
  const era = eraInfo(st, store.data);
  return h('div', { class: 'gaveta-marca' },
    raw(emblemSVG(me, { size: 36 }), 'agency-emblem gaveta-emblema'),
    h('div', { class: 'gaveta-marca-txt' },
      h('strong', null, me.name || me.short || String(st?.playerId || '').toUpperCase()),
      h('span', null, [era.n ? `Era ${era.n}` : null, era.name, dateText(st)].filter(Boolean).join(' · '))));
}

/** Date chip text by step length: "sem 14 · abr/2026" (weekly), "mar/1962", "T3 2087", "2741". */
function dateText(st) {
  if (!st) return '';
  const w = store.stepWeeks();
  try {
    if (typeof time.formatTurnEra === 'function' && w > 1) return time.formatTurnEra(st.turn, st.startYear, w);
  } catch { /* */ }
  if (w <= 1) return fmtDate(st.turn, st.startYear);
  const d = time.turnToDate(st.turn, st.startYear);
  if (w >= 52) return String(d.year);
  if (w >= 13) return `T${Math.floor(d.month / 3) + 1} ${d.year}`;
  return fmtMonth(st.turn, st.startYear);
}

/** Header (CSmanager .barra-topo): ☰ · screen title (agency · era below) · date chip · agency emblem. */
function renderHeader() {
  if (!ui.shell || !store?.state) return;
  const st = store.state;
  const me = st.actors?.[st.playerId] || { id: st.playerId, short: String(st.playerId || '').toUpperCase() };
  const el = ui.shell.header;
  const desc = screenById(ui.route.tab);
  const title = desc?.short || desc?.title || 'Painel'; // short: the top bar's compact name (320px)
  const date = dateText(st);
  const needs = Object.entries(screenBadges()).some(([id, b]) => b && screenById(id)?.nav === 'drawer');
  // skip rebuilding the emblem SVG on every action: only route, agency, date or the menu dot change the header
  const key = `${title}|${st.playerId}|${date}|${me.flag || ''}|${me.short || me.name || ''}|${me.color || ''}|${needs}|${st.clock?.eraId || ''}`;
  if (el.dataset.key === key && el.firstChild) return;
  el.dataset.key = key;
  el.innerHTML = '';
  const agency = `${me.short || me.name || st.playerId}`;
  const era = eraInfo(st, store.data);
  const menuBtn = h('button', {
    class: ['icon-btn', 'menu-btn', needs && 'precisa'], type: 'button', 'aria-label': needs ? 'Menu, há telas que precisam de você' : 'Menu',
    'aria-expanded': ui.drawer?.isOpen() ? 'true' : 'false', 'aria-controls': 'gaveta', onclick: openDrawer,
  }, raw(iconSVG('menu', 24), 'ic-wrap'), needs ? h('span', { class: 'menu-ponto', 'aria-hidden': 'true' }) : null);
  ui.shell.menuBtn = menuBtn;
  const [semPart, restPart] = date.includes(' · ') ? date.split(' · ') : [null, date];
  el.append(
    menuBtn,
    h('div', { class: 'agency-text' },
      h('h1', { class: 'agency-title' }, title),
      h('div', { class: 'agency-sub' }, [agency, era.n ? `Era ${era.n}` : null].filter(Boolean).join(' · '))),
    h('span', { class: 'data-chip', 'aria-label': `Data: ${date}` }, semPart ? h('span', { class: 'data-sem' }, `${semPart} · `) : null, restPart),
    h('button', { class: 'agency', type: 'button', onclick: () => navigate('painel'), 'aria-label': `${agency}. Ir ao painel`, title: agency },
      raw(emblemSVG(me, { size: 30 }), 'agency-emblem')));
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
  bottomScreens().forEach((t, i) => {
    if (i === DISC_AT) el.appendChild(buildDisc());
    const badge = h('span', { class: 'tab-badge', 'aria-hidden': 'true' });
    badge.hidden = true;
    const label = t.id === 'mapa' ? 'Mapa' : t.title;
    const btn = h('button', { class: 'tab', type: 'button', onclick: () => navigate(t.id) },
      h('span', { class: 'tab-icon' }, raw(iconSVG(t.icon, 24), 'ic-wrap'), badge),
      h('span', { class: 'tab-label' }, label));
    ui.tabs[t.id] = { btn, badge, label };
    el.appendChild(btn);
  });
}

function renderTabbar() {
  if (!ui.shell || !ui.tabs) return;
  const st = store.state;
  const active = bottomOwner(ui.route.tab);
  const badges = screenBadges();
  if (active === 'mundo') ui.seenNewsTurn = st.turn;
  const hot = (st.decisions || []).some((d) => d.blocking);
  for (const [id, t] of Object.entries(ui.tabs)) {
    const { btn, badge, label } = t;
    const b = badges[id] || 0;
    const n = b === true ? 0 : b;
    const shown = id === 'mundo' && n > 9 ? '9+' : String(n);
    const badgeLabel = id === 'painel' ? `${n} ${n === 1 ? 'decisão pendente' : 'decisões pendentes'}`
      : id === 'mundo' ? `${shown} ${n === 1 ? 'notícia nova' : 'notícias novas'}` : 'precisa de você';
    btn.classList.toggle('active', id === active);
    btn.classList.toggle('hot', id === 'painel' && hot);
    btn.classList.toggle('precisa', b === true);
    if (id === active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    if (b) btn.setAttribute('aria-label', `${label}, ${badgeLabel}`); else btn.removeAttribute('aria-label');
    badge.hidden = !b;
    badge.classList.toggle('ponto', b === true);
    const txt = b === true ? '' : shown;
    if (badge.textContent !== txt) badge.textContent = txt;
  }
  renderDisc();
}

// ------------------------------------------------------------------ centre disc (time)
// CSmanager .barra-inferior-central: tap = one turn (its length depends on the era: "+1 semana", "+1 trimestre"…);
// hold = próximo evento (the ring fills while held, then shows the run). A stopped clock turns the disc into the
// way out (Decidir / Lançar) instead of a dead button.

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
    // must not turn a "Parar" tap into another turn
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
  // a run that just ended on its own: this tap was meant as "Parar", not as another turn
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
  if (b === 'decision' || b === 'era') {
    const dec = sortDecisions(st.decisions).find((x) => x.blocking);
    return { mode: 'decision', icon: 'alerta', label: 'Decidir', aria: `Tempo parado: ${dec?.title || 'decisão pendente'}. Abrir a decisão` };
  }
  if (b === 'needsData') return { mode: 'decision', icon: 'carregando', label: 'Carregando', aria: 'Carregando a próxima era' };
  if (b === 'launch') return { mode: 'launch', icon: 'missoes', label: 'Lançar', aria: 'Lançamento em andamento. Abrir a sala de controle' };
  const step = store.stepLabel();
  return { mode: 'play', icon: 'continuar', label: step, aria: `Avançar: ${step}. Segure para avançar até o próximo evento` };
}

function renderDisc() {
  const d = ui.disc;
  if (!d || !store?.state) return;
  const s = discState();
  // the run's length is unknown (it stops on the next event, usually within 1-4 turns): the ring is an
  // indeterminate arc that spins (.girando) and grows a little with each turn, never a near-empty x/26 fill
  if (ui.run) d.disc.style.setProperty('--anel', `${Math.round(Math.min(330, 110 + ui.run.done * 30))}deg`);
  const key = `${s.mode}|${s.label}|${s.aria}`;
  if (d.key === key) return;
  if (d.mode === 'play' && s.mode !== 'play') endHold();
  d.key = key;
  d.mode = s.mode;
  d.btn.className = ['tab-central', `is-${s.mode}`, s.mode === 'run' && 'ocupado girando'].filter(Boolean).join(' ');
  d.btn.disabled = !store.state;
  d.btn.setAttribute('aria-label', s.aria);
  d.btn.title = s.mode === 'play' ? `Toque: ${s.label} · Segure: próximo evento` : s.aria;
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

// ------------------------------------------------------------------ screens

/** Module of a registered screen (cached; null = failed to load). */
function loadScreen(id) {
  if (ui.mods.has(id)) return Promise.resolve(ui.mods.get(id));
  const d = screenById(id);
  if (!d?.load) return Promise.resolve(null);
  return Promise.resolve().then(() => d.load()).then((m) => { ui.mods.set(id, m || null); return m; })
    .catch((e) => { console.error(e); ui.mods.set(id, null); return null; });
}

function renderView() {
  if (!ui.shell || !store.state) return;
  const view = ui.shell.view;
  let { tab } = ui.route;
  let d = screenById(tab);
  if (!d || d.go || d.action || !isAvailable(d, store.state, store.data)) { tab = 'painel'; d = screenById('painel'); ui.route = { tab, sub: '' }; }
  const key = `${ui.route.tab}/${ui.route.sub}`;
  const sameRoute = view.dataset.route === key;
  // a re-render of the same screen keeps its place; a new screen starts at the top (the old offset used to
  // carry over and open views mid-page with their headers hidden)
  const scroll = sameRoute ? view.scrollTop : 0;
  try { ui.cleanup?.(); } catch (e) { console.warn(e); }
  ui.cleanup = null;
  view.innerHTML = '';
  view.dataset.route = key;
  view.setAttribute('tabindex', '-1');
  view.classList.toggle('view-map', tab === 'mapa');
  // entry motion only when the screen changes, not on every re-render of the same screen
  const container = h('div', { class: ['view-inner', !sameRoute && 'entering'] });
  view.appendChild(container);
  if (!ui.mods.has(tab)) {
    container.appendChild(h('div', { class: 'loading' }, tab === 'mapa' ? 'Carregando mapa…' : 'Carregando…'));
    loadScreen(tab).then(() => { if (ui.route.tab === tab && ui.shell) { view.dataset.route = ''; renderView(); } });
    return;
  }
  const mod = ui.mods.get(tab);
  try {
    const fn = mod?.render || mod?.default;
    if (typeof fn !== 'function') throw new Error(`${tab}: tela sem render()`);
    const ret = fn(container, store, ui.route);
    if (typeof ret === 'function') ui.cleanup = ret;
  } catch (e) {
    console.error(e);
    container.innerHTML = '';
    container.appendChild(fallbackPanel(tab === 'mapa' ? 'O mapa encontrou um problema.' : 'Esta tela ainda está em construção. O resto do jogo continua funcionando.', e));
  }
  view.scrollTop = scroll;
}

// ------------------------------------------------------------------ time

function advance(turns, stopOnEvent) {
  const st = store.state;
  if (!st || st.gameOver) return;
  if (ui.run) return; // a "Próximo evento" run owns the clock until it stops
  const b = store.blocked();
  if (b === 'decision' || b === 'era') {
    const d = sortDecisions(st.decisions).find((x) => x.blocking);
    if (d) openDecision(store, d.id);
    return;
  }
  if (b === 'launch') { launchState.key = null; syncLaunch(); return; }
  ui.turnBefore = st.turn; // afterAdvance (called from the store notification) says how much time passed
  const res = store.dispatch(store.advanceAction(turns, stopOnEvent));
  if (!res?.ok) toast(res?.error || 'O tempo não pôde avançar.', 'bad');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Próximo evento": the same advance as time/advance {stopOnEvent: true} over the run budget, dispatched one
 * turn at a time so the disc ring can show the run (CSmanager .ocupado). The engine checks its stop conditions
 * per turn, so it stops at the same place; it also stops on a stopped clock or when the disc is tapped again.
 * Run budget: RUN_MAX_STEPS (12) turns or 26 weeks, whichever is longer (store.runMaxSteps).
 */
async function runToEvent(maxSteps = store?.runMaxSteps?.() || 26) {
  const st = store?.state;
  if (ui.run || !st || st.gameOver) return;
  if (store.blocked()) { advance(1, false); return; }
  const run = ui.run = { done: 0, max: maxSteps, cancel: false };
  const quick = !!store.settings.reduceMotion;
  const t0 = performance.now();
  const turn0 = st.turn;
  renderDisc();
  let last = null;
  let steps = 0;
  try {
    while (steps < maxSteps && !run.cancel) {
      if (!store.state || store.state.gameOver || store.blocked()) break;
      const res = store.dispatch(store.advanceAction(1, true));
      if (!res?.ok) { toast(res?.error || 'O tempo não pôde avançar.', 'bad'); break; }
      last = res;
      steps += 1;
      run.done = steps;
      renderDisc();
      if (res.stoppedBy || !res.advanced) break;
      await wait(quick ? 0 : RUN_STEP_MS);
    }
    // keep the ring up long enough to be seen (a 1-turn run would otherwise flash for ~90ms)
    const left = RUN_MIN_MS - (performance.now() - t0);
    if (!quick && left > 0 && !run.cancel) await wait(left);
  } finally {
    ui.run = null;
    ui.runEndedAt = performance.now();
  }
  if (!store.state) return;
  renderAll();
  afterAdvance({ ok: true, advanced: steps, weeksPassed: (store.state.turn ?? turn0) - turn0, stoppedBy: last?.stoppedBy || null });
}

/** Feedback after time passes: toast + auto-open the decision that stopped the clock. */
function afterAdvance(res) {
  const st = store.state;
  if (!st || !res?.ok || st.gameOver) return;
  const passed = res.weeksPassed ?? (ui.turnBefore != null ? st.turn - ui.turnBefore : res.advanced ?? 0);
  ui.turnBefore = null;
  const weeks = passedText(passed);
  const queue = sortDecisions(st.decisions);
  const top = queue[0];
  if (st.activeLaunch) return;
  if (res.stoppedBy === 'decision' || res.stoppedBy === 'era' || (res.stoppedBy === 'newDecision' && top && (top.blocking || top.urgency >= 3))) {
    store.vibrate([30, 40, 30]);
    if (top) setTimeout(() => openDecision(store, top.id), 120);
    return;
  }
  if (res.stoppedBy === 'newDecision') toast(`+${weeks} · nova decisão no painel`, 'warn');
  else if (res.stoppedBy === 'news') toast(`+${weeks} · ${st.news[0]?.headline || 'notícia importante'}`, 'info', 4000);
  else if (passed > 0) toast(`+${weeks}`, 'info', 1500);
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

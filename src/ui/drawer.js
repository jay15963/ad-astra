// The drawer (CSmanager `.gaveta` over `.veu`, responsivo.tsx useGaveta): the hamburger menu with every secondary
// screen from the registry (screens.js). Closes on Esc, on a tap on the veil, on a left swipe, on choosing an item
// and on the Android back button (app.js pushes a history entry while it is open). Focus moves into the drawer
// (the current item first) and is trapped there; on close it returns to whoever opened it (the ☰ button).
import { h, raw, iconSVG } from './components.js';

/** How far a finger must drag left for the drawer to understand "close" (CSmanager ARRASTO_QUE_FECHA). */
export const SWIPE_CLOSE_PX = 64;

/** True when a touch from (x0,y0) to (x1,y1) is a horizontal left swipe that closes the drawer. Pure (tests). */
export function isCloseSwipe(x0, y0, x1, y1) {
  const dx = x1 - x0;
  return dx < -SWIPE_CLOSE_PX && Math.abs(dx) > Math.abs(y1 - y0) * 1.5;
}

/** Focusable elements inside a root, in DOM order. */
function focusables(root) {
  return [...root.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.hidden && el.offsetParent !== null);
}

/**
 * createDrawer({ onPick(desc), onOpenChange(open), header() -> Node }) -> drawer
 * drawer = { el, veil, open(trigger?), close({restoreFocus}), isOpen(), update(sections, currentId, badges) }
 */
export function createDrawer({ onPick, onOpenChange, header } = {}) {
  const list = h('div', { class: 'gaveta-lista' });
  const head = h('div', { class: 'gaveta-topo' });
  const closeBtn = h('button', { class: 'icon-btn gaveta-fechar', type: 'button', 'aria-label': 'Fechar o menu', onclick: () => api.close() }, raw(iconSVG('fechar', 22), 'ic-wrap'));
  const el = h('nav', { class: 'gaveta', id: 'gaveta', 'aria-label': 'Menu', 'aria-hidden': 'true', tabindex: '-1' }, h('div', { class: 'gaveta-cabeca' }, head, closeBtn), list);
  const veil = h('div', { class: 'veu', 'aria-hidden': 'true', onclick: () => api.close() });
  el.inert = true;
  let opened = false;
  let trigger = null;
  let touch = null;

  const onKey = (e) => {
    if (!opened) return;
    if (e.key === 'Escape') { e.preventDefault(); api.close(); return; }
    if (e.key === 'Tab') { // focus trap
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  };
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = t ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const s = touch;
    touch = null;
    // only the horizontal gesture closes: scrolling the list must not
    if (s && t && isCloseSwipe(s.x, s.y, t.clientX, t.clientY)) api.close();
  }, { passive: true });

  const api = {
    el, veil,
    isOpen: () => opened,
    open(from = null) {
      if (opened) return;
      opened = true;
      trigger = from || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      if (header) { head.innerHTML = ''; try { const n = header(); if (n) head.append(n); } catch { /* */ } }
      el.inert = false;
      el.classList.add('aberta');
      el.setAttribute('aria-hidden', 'false');
      veil.classList.add('visivel');
      document.addEventListener('keydown', onKey, true);
      // the current destination gets the focus: that is where whoever opened the menu wants to start
      const target = el.querySelector('[aria-current="page"]') || el.querySelector('.gaveta-item');
      try { target?.focus({ preventScroll: true }); } catch { /* */ }
      onOpenChange?.(true);
    },
    close({ restoreFocus = true } = {}) {
      if (!opened) return;
      opened = false;
      el.classList.remove('aberta');
      el.setAttribute('aria-hidden', 'true');
      el.inert = true;
      veil.classList.remove('visivel');
      document.removeEventListener('keydown', onKey, true);
      // the shell leaves `inert` first (onOpenChange): an inert ☰ button cannot take the focus back
      onOpenChange?.(false);
      if (restoreFocus) { try { trigger?.focus({ preventScroll: true }); } catch { /* */ } }
      trigger = null;
    },
    /** sections = screens.drawerSections(); badges = {id: 0|true|n}; currentId = screens.drawerCurrent(route). */
    update(sections, currentId, badges = {}) {
      list.innerHTML = '';
      for (const s of sections) {
        list.append(h('div', { class: 'gaveta-grupo', role: 'presentation' }, s.label));
        for (const d of s.items) {
          const b = badges[d.id];
          const dot = b === true ? h('span', { class: 'gaveta-ponto', 'aria-hidden': 'true' })
            : b > 0 ? h('span', { class: 'gaveta-contador', 'aria-hidden': 'true' }, b > 99 ? '99+' : String(b)) : null;
          const label = b === true ? `${d.title}, precisa de você` : b > 0 ? `${d.title}, ${b} pendente${b === 1 ? '' : 's'}` : null;
          list.append(h('button', {
            class: ['gaveta-item', d.soon && 'em-breve', d.action && 'acao'], type: 'button',
            'aria-current': d.id === currentId ? 'page' : null, 'aria-label': label, 'data-screen': d.id,
            onclick: () => onPick?.(d),
          },
          raw(iconSVG(d.icon, 20), 'gaveta-ic'),
          h('span', { class: 'gaveta-rotulo' }, d.title),
          d.soon ? h('span', { class: 'gaveta-breve' }, 'em breve') : (d.lockedNow ? h('span', { class: 'gaveta-breve' }, d.lockedNow) : null),
          dot));
        }
      }
    },
  };
  return api;
}

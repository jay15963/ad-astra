// Shared layout of the drawer screens (docs/DESIGN.md §3.3, §4.1–4.7; EXPANSION.md §12): every screen reads
// title → one primary action → sections. Calendário de lançamentos, Identidade, Finanças and Anais use it; it only
// builds DOM inside functions, so the pure helpers below can be imported in Node.
import { h, raw, chip, button, sectionTitle, viewHead, iconSVG } from './components.js';

/**
 * Page head + (at most) one primary action under it.
 * { title, lead, emblem: svg string, primary: {label, onClick, icon, disabled, note}, aside: Node }
 */
export function screenHead({ title, lead, emblem, primary, aside } = {}) {
  const head = viewHead(title, { lead, right: aside || null });
  if (emblem) head.prepend(raw(emblem, 'tela-emblema'));
  const act = primary ? h('div', { class: 'tela-acao' },
    button(primary.label, primary.onClick, { kind: 'primary', big: true, icon: primary.icon, disabled: !!primary.disabled }),
    primary.note ? h('p', { class: 'tela-acao-nota' }, primary.note) : null) : null;
  return h('header', { class: 'tela-cab' }, head, act);
}

/** A titled section (eyebrow + optional right slot) holding cards/lists. Null children are skipped. */
export function section(title, { right, cls, id } = {}, ...children) {
  const body = children.flat().filter(Boolean);
  if (!body.length) return null;
  return h('section', { class: ['tela-sec', cls], id: id || null }, sectionTitle(title, right || null), ...body);
}

/** A count chip for a section title's right slot. */
export const countChip = (n) => h('span', { class: 'pn-count' }, String(n));

/**
 * KPI tiles (CSmanager .dir-kpi). items: [{label, value, sub, tone: 'up'|'down'|'', wide, onClick, spark: Node}].
 * Non-tappable tiles are <div>s (no fake buttons).
 */
export function kpis(items, { label = 'Números' } = {}) {
  const list = (items || []).filter(Boolean);
  return h('section', { class: 'tiles tela-kpis', 'aria-label': label }, list.map((k) => {
    const tag = typeof k.onClick === 'function' ? 'button' : 'div';
    return h(tag, { class: ['tile', k.wide && 'tile-wide', tag === 'div' && 'tile-static'], type: tag === 'button' ? 'button' : null, onclick: k.onClick || null },
      h('span', { class: 'tile-label' }, k.label),
      h('span', { class: 'tile-main' }, h('span', { class: ['tile-value', k.tone] }, k.value)),
      k.sub ? h('span', { class: 'tile-sub' }, k.sub) : null,
      k.spark ? h('span', { class: 'tile-spark', 'aria-hidden': 'true' }, k.spark) : null);
  }));
}

/** Filter pills (DESIGN §4.4 button.chip, aria-pressed). options [{id, label, count?}]. */
export function pills(options, active, onChange, { label = 'Filtro' } = {}) {
  return h('div', { class: 'chip-scroll tela-filtros', role: 'group', 'aria-label': label },
    options.map((o) => h('button', {
      class: ['chip', o.id === active && 'active'], type: 'button', 'aria-pressed': o.id === active ? 'true' : 'false',
      onclick: () => { if (o.id !== active) onChange(o.id); },
    }, o.label, o.count != null ? h('span', { class: 'tela-filtro-n' }, String(o.count)) : null)));
}

/** Neutral note (DESIGN §4.11): icon + text; kind 'warn' | 'bad' | 'ok' tints it. */
export function note(text, { kind = '', icon = 'info' } = {}) {
  return h('p', { class: ['pn-note', 'tela-nota', kind && `tela-nota-${kind}`] }, raw(iconSVG(icon, 16), 'ic-wrap'), h('span', null, text));
}

/** Divided list card. */
export const listCard = (rows, cls = '') => h('div', { class: ['pn-list', cls] }, rows);

/** Chip for a truth layer ('fato' | 'plano_oficial' | 'projecao' | 'especulacao'). */
export const truthChip = (label) => (label ? chip(label, 'muted') : null);

/** Re-render helper: clears a container and calls render again (local UI state lives in the screen module). */
export function rerender(container, render, store, route) {
  container.innerHTML = '';
  return render(container, store, route);
}

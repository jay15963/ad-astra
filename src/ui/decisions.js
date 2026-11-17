// Decision card (bottom sheet, CSmanager .folha + .dir-destaque): face, kind eyebrow, 3-5 lines, choices with effect
// preview before confirming. Also the shared list-row helper and stylesheet loader of the Painel / Equipe screens.
import { h, raw, chip, button, icon, openModal, toast, fmtIn, esc, cleanFlags } from './components.js';
import { portraitSVG, emblemSVG, iconPortraitSVG } from './portrait.js';

/**
 * Painel / decision / Equipe styles (src/ui/css/dashboard.css), injected once like techtree.css / worldmap.css.
 * Called at import time in the browser (no-op in Node) so the first Painel paint is already styled.
 */
export function ensurePainelCss() {
  try {
    // index.html links it too (no flash on first paint); this is the fallback for older shells
    if (typeof document === 'undefined' || document.querySelector('link[data-painel-css], link[href$="css/dashboard.css"]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/dashboard.css', import.meta.url).href;
    l.dataset.painelCss = '';
    document.head.appendChild(l);
  } catch { /* styles are progressive */ }
}
ensurePainelCss();

/**
 * One row of a divided list card (CSmanager .dir-lista-mensagens): leading 36px circle, bold title with optional
 * mono meta on the right, sub line, optional extra node (bar, chips), optional right slot and chevron.
 */
export function listRow({ lead, leadCls, title, sub, meta, extra, right, onClick, cls, chevron } = {}) {
  const tappable = typeof onClick === 'function';
  return h(tappable ? 'button' : 'div', { class: ['pn-row', tappable && 'tappable', cls], type: tappable ? 'button' : null, onclick: tappable ? onClick : null },
    lead != null ? h('span', { class: ['pn-lead', leadCls], 'aria-hidden': 'true' }, lead) : null,
    h('span', { class: 'pn-text' },
      h('span', { class: 'pn-top' }, h('b', { class: 'pn-name' }, title), meta != null && meta !== '' ? h('span', { class: 'pn-meta' }, meta) : null),
      sub ? h('span', { class: 'pn-sub' }, sub) : null,
      extra || null),
    right || null,
    (chevron ?? tappable) ? icon('avancar', 16, 'pn-chev') : null);
}

const KIND_LABELS = {
  launch: 'Dia de Lançamento', briefing: 'Briefing', contract: 'Contrato', diplomacy: 'Diplomacia', politics: 'Governo',
  event: 'Evento', crew: 'Equipe', research: 'Pesquisa', mission: 'Missão', budget: 'Orçamento',
};

/** Kind header of a card. The arrival of a mission reuses 'launch/ready' (payload.phase 'arrival'): it is a "Chegada". */
export function kindLabel(kind, d = null) {
  const k = String(kind || '').split('/')[0];
  if (k === 'launch' && d?.payload?.phase === 'arrival') return 'Chegada';
  return KIND_LABELS[k] || 'Decisão';
}

/** Order: blocking first, then urgency (3 high), then soonest expiry, then oldest. */
export function sortDecisions(list) {
  return (list || []).slice().sort((a, b) =>
    (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0)
    || (b.urgency || 1) - (a.urgency || 1)
    || (a.expiresTurn ?? Infinity) - (b.expiresTurn ?? Infinity)
    || (a.createdTurn ?? 0) - (b.createdTurn ?? 0));
}

/** SVG string for the card's face: crew portrait, actor emblem or a kind icon. */
export function decisionPortraitSVG(state, d, size = 72) {
  try {
    const p = d?.portrait;
    const crewId = p?.crewId || (p === 'crew' ? d?.payload?.crewId : null);
    const actorId = p?.actorId || (p === 'actor' ? d?.payload?.actorId : null);
    if (crewId && state?.crew?.[crewId]) {
      const c = state.crew[crewId];
      return portraitSVG(c.portrait || c.id, { size, mood: c.status === 'dead' ? 'dead' : (d.urgency >= 3 ? 'tense' : 'neutral'), title: c.name });
    }
    if (actorId && state?.actors?.[actorId]) return emblemSVG(state.actors[actorId], { size });
  } catch { /* fall through */ }
  return iconPortraitSVG(d?.kind, { size });
}

/** Title without a repeated kind prefix ("Briefing: Artemis II" under the "Briefing" eyebrow -> "Artemis II"). */
export function displayTitle(d, fallback = 'Decisão') {
  const t = cleanFlags(d?.title || '').trim();
  if (!t) return fallback;
  const k = kindLabel(d.kind, d).toLowerCase();
  const m = t.match(/^([^:·—–]+?)\s*[:·—–]\s*(.+)$/);
  if (m && m[1].toLowerCase() === k) return m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return t;
}

/** Compact row for queues (dashboard, missions tab, world tab): a row of a divided list card. */
export function decisionRow(store, d, { onOpen } = {}) {
  const st = store.state;
  const urg = d.blocking ? 'block' : d.urgency >= 3 ? 'high' : d.urgency >= 2 ? 'mid' : 'low';
  const soon = d.expiresTurn != null && d.expiresTurn - st.turn <= 1;
  return h('button', {
    class: ['decision-row', 'pn-row', 'tappable', d.blocking && 'blocking', `urg-${d.urgency || 1}`], type: 'button',
    onclick: () => (onOpen ? onOpen(d) : openDecision(store, d.id)),
  },
  raw(decisionPortraitSVG(st, d, 36), `decision-face pn-lead urg-${urg}`),
  h('span', { class: 'decision-text pn-text' },
    h('span', { class: 'decision-kind' }, kindLabel(d.kind, d),
      d.blocking ? chip('bloqueia o tempo', 'bad') : d.urgency >= 3 ? chip('urgente', 'warn') : null),
    h('span', { class: 'decision-title' }, d.title || 'Decisão pendente'),
    d.expiresTurn != null ? h('span', { class: ['pn-sub', soon && 'down'] }, `Vence ${fmtIn(d.expiresTurn, st.turn)}`) : null),
  icon('avancar', 16, 'pn-chev'));
}

let openId = null;
let openClose = null;

export function isDecisionOpen(id) {
  return id == null ? openId != null : openId === id;
}
export function closeDecision() {
  try { openClose?.(); } catch { /* */ }
}

/** Body text: up to ~5 short lines. Supports "\n" line breaks. */
function bodyLines(text) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return lines.map((l) => h('p', null, l));
}

/**
 * Open the decision card. Resolves through store.dispatch('decision/resolve').
 * Returns close().
 */
export function openDecision(store, id, { onResolved } = {}) {
  const d = store.state?.decisions?.find((x) => x.id === id);
  if (!d) { toast('Essa decisão já foi resolvida.', 'info'); return () => {}; }
  closeDecision();
  let selected = null;
  const choices = Array.isArray(d.choices) ? d.choices : [];

  const close = openModal((close) => {
    const previewBox = h('div', { class: 'choice-preview', 'aria-live': 'polite' },
      h('span', { class: 'muted' }, choices.length ? 'Toque numa escolha para ver o efeito.' : ''));
    const confirm = button(choices.length ? 'Escolha uma opção' : 'Ciente', () => resolve(), { kind: 'primary', big: true, disabled: choices.length > 0, cls: 'confirm-btn' });

    const resolve = () => {
      if (choices.length && !selected) return;
      const res = store.dispatch({ type: 'decision/resolve', id: d.id, choiceId: selected?.id });
      if (!res?.ok) { toast(res?.error || 'Não foi possível decidir agora.', 'bad'); return; }
      store.vibrate(25);
      toast(res.message || (selected ? `Decidido: ${selected.label}` : 'Registrado.'), 'good');
      close();
      try { onResolved?.(res, selected); } catch (e) { console.error(e); }
    };

    const choiceBtns = choices.map((c) => {
      const btn = h('button', {
        class: ['choice', c.disabled && 'disabled'], type: 'button', disabled: !!c.disabled, 'aria-pressed': 'false',
        onclick: () => {
          if (c.disabled) return;
          if (selected === c) { resolve(); return; } // second tap confirms
          selected = c;
          for (const b of choiceBtns) { b.classList.remove('selected'); b.setAttribute('aria-pressed', 'false'); }
          btn.classList.add('selected');
          btn.setAttribute('aria-pressed', 'true');
          previewBox.innerHTML = '';
          previewBox.appendChild(h('div', { class: 'preview-label' }, 'Efeito previsto'));
          previewBox.appendChild(h('div', { class: 'preview-text' }, c.preview || 'Consequências incertas.'));
          confirm.disabled = false;
          confirm.textContent = `Confirmar: ${c.label}`;
        },
      },
      h('span', { class: 'choice-label' }, c.label || c.id),
      c.preview ? h('span', { class: 'choice-hint' }, c.preview) : null,
      c.disabled && c.reason ? h('span', { class: 'choice-reason' }, icon('cadeado', 14), c.reason) : null);
      return btn;
    });

    const left = d.expiresTurn != null ? d.expiresTurn - store.state.turn : null;
    return h('div', { class: ['event-card', `kind-${String(d.kind || '').split('/')[0]}`, d.blocking && 'blocking'] },
      h('div', { class: 'event-banner' },
        raw(decisionPortraitSVG(store.state, d, 56), 'event-face'),
        h('div', { class: 'event-meta' },
          h('h3', { class: 'event-title' }, displayTitle(d)),
          d.blocking || d.urgency >= 3 || left != null ? h('div', { class: 'chips' },
            d.blocking ? chip('bloqueia o tempo', 'bad') : null,
            d.urgency >= 3 ? chip('urgente', 'warn') : null,
            left != null ? chip(`vence ${fmtIn(d.expiresTurn, store.state.turn)}`, left <= 1 ? 'bad' : '') : null) : null)),
      h('div', { class: 'event-body' }, bodyLines(d.body)),
      h('div', { class: 'choices' }, choiceBtns),
      previewBox,
      h('div', { class: 'modal-actions' }, confirm));
  }, { cls: ['decision-modal', d.blocking && 'blocking-sheet'].filter(Boolean).join(' '), title: kindLabel(d.kind, d), onClose: () => { if (openId === id) { openId = null; openClose = null; } } });

  openId = id;
  openClose = close;
  return close;
}

/** Plain text for screen readers / tests. */
export function decisionSummary(d) {
  return esc(`${kindLabel(d.kind, d)}: ${d.title || ''}`);
}

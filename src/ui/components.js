// Small DOM component kit + pt-BR formatters for the Ad Astra UI.
// DOM is only touched inside functions (never at import time), so the formatters
// can be imported and tested in Node.

import { formatTurnLong, formatTurn, weeksToText } from '../core/time.js';

// ---------------------------------------------------------------- formatters

const nf1 = (v) => v.toFixed(1).replace('.', ',');

/** US$ millions -> "US$ 1,2 bi" / "US$ 350 mi" / "−US$ 20 mi". */
export function fmtMoney(m) {
  if (m == null || !Number.isFinite(Number(m))) return 'US$ —';
  const v = Number(m);
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1000) {
    const b = a / 1000;
    return `${sign}US$ ${b >= 100 ? Math.round(b) : nf1(b).replace(/,0$/, '')} bi`;
  }
  if (a >= 10 || a === 0) return `${sign}US$ ${Math.round(a)} mi`;
  return `${sign}US$ ${nf1(a).replace(/,0$/, '')} mi`;
}

/** Signed money delta: "+US$ 20 mi". */
export function fmtMoneyDelta(m) {
  if (!Number.isFinite(Number(m))) return '';
  return (m > 0 ? '+' : '') + fmtMoney(m);
}

/** 0..1 -> "62%". Accepts 0..100 values as well when > 1. */
export function fmtPct(p, digits = 0) {
  if (p == null || !Number.isFinite(Number(p))) return '—';
  let v = Number(p);
  if (Math.abs(v) <= 1) v *= 100;
  return `${digits ? v.toFixed(digits).replace('.', ',') : Math.round(v)}%`;
}

/** Chance band: "62 a 78%". */
export function fmtBand(low, high) {
  if (low == null || high == null) return '—';
  const l = Math.round((low <= 1 ? low * 100 : low));
  const hh = Math.round((high <= 1 ? high * 100 : high));
  return l === hh ? `${l}%` : `${l} a ${hh}%`;
}

export function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Math.round(Number(n)).toLocaleString('pt-BR');
}

/** turn -> "sem 14 · abr/2026". startYear is required (no era default: the campaign starts in 1950). */
export function fmtDate(turn, startYear) {
  if (turn == null || !Number.isFinite(Number(turn)) || !Number.isFinite(Number(startYear))) return '—';
  return formatTurnLong(turn, startYear);
}
export function fmtMonth(turn, startYear) {
  if (turn == null || !Number.isFinite(Number(turn)) || !Number.isFinite(Number(startYear))) return '—';
  return formatTurn(turn, startYear);
}
/** pt-BR era names (docs/EXPANSION.md §2.3); data/core/eras.json wins when loaded. */
export const ERA_NAMES = { e1: 'A Corrida', e2: 'Estações e Sondas', e3: 'A Era Comercial', e4: 'A Década Lunar', e5: 'Expansão do Sistema', e6: 'Interplanetária e Interestelar', e7: 'Galáctica' };

/** Current era of a game: {id: 'e4', n: 4, name} from state.clock / data.eras, falling back to the scenario. */
export function eraInfo(state, data) {
  const sc = data?.scenario || {};
  const list = Array.isArray(data?.eras) ? data.eras : Array.isArray(data?.eras?.eras) ? data.eras.eras : [];
  let id = state?.clock?.eraId || null;
  if (!id && Array.isArray(sc.eras) && sc.eras.length === 1) id = sc.eras[0];
  if (!id && sc.era != null) id = /^e\d$/.test(String(sc.era)) ? String(sc.era) : `e${sc.era}`;
  id = id || 'e4';
  const def = list.find((e) => e && e.id === id) || {};
  const n = Number(String(id).replace(/\D/g, '')) || null;
  return { id, n, name: def.name || ERA_NAMES[id] || '', def };
}

/** "3 semanas", "2 meses", "1,5 anos": how much time a turn (or a run of turns) took. */
export function passedText(weeks) {
  const w = Math.max(0, Math.round(Number(weeks) || 0));
  if (w < 9) return w === 1 ? '1 semana' : `${w} semanas`;
  if (w < 52) { const m = Math.max(1, Math.round(w / (52 / 12))); return m === 1 ? '1 mês' : `${m} meses`; }
  const y = Math.round((w / 52) * 10) / 10;
  return y === 1 ? '1 ano' : `${String(y).replace('.', ',')} anos`;
}

/** relative weeks: "em 3 sem", "agora", "há 2 meses" */
export function fmtIn(turn, now) {
  if (turn == null || !Number.isFinite(Number(turn))) return '—';
  const d = Math.round(turn - now);
  if (d === 0) return 'esta semana';
  return d > 0 ? `em ${weeksToText(d)}` : `há ${weeksToText(-d)}`;
}

/** Escape text for innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- labels (pt-BR)

export const TYPE_LABELS = {
  satellite: 'Satélite', probe: 'Sonda', crewed: 'Tripulada', cargo: 'Carga', station: 'Estação', lander: 'Pouso',
};
export const TYPE_ICONS = { satellite: '🛰️', probe: '🔭', crewed: '👩‍🚀', cargo: '📦', station: '🏗️', lander: '🌘' };
export const STATUS_LABELS = {
  planning: 'Em planejamento', scheduled: 'Agendada', launch: 'No pátio', transit: 'Em trânsito', arrival: 'Chegando',
  operations: 'Em operação', done: 'Concluída', cancelled: 'Cancelada',
};
export const OUTCOME_TEXT = {
  total: 'Sucesso total', partial: 'Sucesso parcial', recoverable: 'Falha recuperável', catastrophic: 'Falha catastrófica',
};
export const STRATEGY_LABELS = { conservative: 'Conservadora', balanced: 'Equilibrada', aggressive: 'Agressiva' };
export const ROLE_LABELS = { engineer: 'Engenheira(o)', flight_director: 'Diretor(a) de voo', astronaut: 'Astronauta' };
export const TRUTH_LABELS = { fato: 'Fato', plano_oficial: 'Plano oficial', projecao: 'Projeção', especulacao: 'Especulação' };
export const TENSION_LABELS = ['Normal', 'Tensão', 'Crise', 'Conflito regional', 'Guerra aberta'];
export const EFFECT_LABELS = {
  reliability: 'Confiabilidade', launchCost: 'Custo de lançamento', payload: 'Carga útil', chanceBand: 'Precisão da estimativa',
  commandPoints: 'Pontos de Comando', sciencePerMission: 'Ciência por missão', landingReliability: 'Confiabilidade de pouso',
  crewSafety: 'Segurança da tripulação', delayReduction: 'Redução de atrasos',
};
export const PROPOSAL_LABELS = {
  mission_partnership: 'Parceria de missão', cost_sharing: 'Divisão de custos', crew_exchange: 'Troca de tripulantes',
  tech_transfer: 'Transferência de tecnologia', peaceful_use: 'Tratado de uso pacífico', lunar_resources: 'Recursos lunares',
  orbital_traffic: 'Tráfego orbital', join_bloc: 'Adesão a bloco',
};

// "Os Primeiros" — fixed milestone vocabulary from ARCHITECTURE.md
export const FIRST_LABELS = {
  crewed_lunar_flyby: 'Sobrevoo lunar tripulado', crewed_lunar_orbit: 'Órbita lunar tripulada', crewed_lunar_landing: 'Pouso tripulado na Lua',
  lunar_south_pole_landing: 'Pouso no polo sul lunar', lunar_south_pole_crewed: 'Pessoas no polo sul lunar', lunar_sample_return: 'Amostras lunares trazidas',
  lunar_resource_demo: 'Uso de recursos lunares', lunar_base: 'Base lunar', mars_landing_robotic: 'Pouso robótico em Marte',
  mars_sample_return: 'Amostras de Marte', titan_arrival: 'Chegada a Titã', jupiter_arrival: 'Chegada a Júpiter',
  commercial_station: 'Estação comercial', national_station: 'Estação nacional', crewed_orbit_national: 'Voo orbital tripulado próprio',
};

/** "+5% Confiabilidade" style text for a tech effect. */
export function fmtEffect(key, value) {
  const label = EFFECT_LABELS[key] || key;
  if (key === 'commandPoints') return `${value > 0 ? '+' : ''}${value} ${label}`;
  const pct = Math.round(value * 100);
  return `${pct > 0 ? '+' : ''}${pct}% ${label}`;
}

// ---------------------------------------------------------------- icons
// Inline stroke icons (24x24 grid, 1.8 stroke, currentColor), ported from CSmanager's responsivo.tsx TRACOS
// plus the Ad Astra tabs drawn on the same grid. docs/DESIGN.md §2.

export const ICONS = {
  painel: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
  missoes: '<path d="M12 2.8c2.9 1.9 4.4 5 4.4 8.9v4.8H7.6v-4.8c0-3.9 1.5-7 4.4-8.9z"/><circle cx="12" cy="9.8" r="1.7"/><path d="M7.6 12.8l-2.6 2.6v3.6l2.6-1.6M16.4 12.8l2.6 2.6v3.6l-2.6-1.6M10.2 19.4L12 21.2l1.8-1.8"/>',
  pesquisa: '<path d="M9 3.5h6M10 3.5v5.6L4.9 17.9A2.1 2.1 0 0 0 6.7 21h10.6a2.1 2.1 0 0 0 1.8-3.1L14 9.1V3.5"/><path d="M7 15h10"/>',
  mapa: '<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9.5" ry="4.6" transform="rotate(-28 12 12)"/><circle cx="20.4" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
  mundo: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5s1.1-6.2 3.4-8.5z"/>',
  ajustes: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M10 14.5v5"/>',
  fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
  voltar: '<path d="M15 5l-7 7 7 7"/>',
  avancar: '<path d="M9 5l7 7-7 7"/>',
  proximo: '<path d="M4.5 6.5v11l7.5-5.5zM12 6.5v11l7.5-5.5zM20 6v12"/>',
  continuar: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  carregando: '<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>',
  relogio: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendario: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  trofeu: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7M9.5 17h5"/>',
  ranking: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V9M3 20.5h18"/>',
  equipe: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.1 2.8-5 5.5-5s4.9 1.9 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.5.7 2.6 2.4 3 4.7"/>',
  caixa: '<path d="M3.5 13.5l2.6-7.3A1.5 1.5 0 0 1 7.5 5h9a1.5 1.5 0 0 1 1.4 1.2l2.6 7.3V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  transferir: '<path d="M4 8.5h15l-4-4M20 15.5H5l4 4"/>',
  editar: '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  menos: '<path d="M5 12h14"/>',
  alvo: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  expandir: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
  alerta: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.4v.1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cadeado: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  noticia: '<path d="M4 5.5h13v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9.5h3v9a2 2 0 0 1-4 0M7.5 9h6M7.5 12.5h6M7.5 16h4"/>',
  seta: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chave: '<path d="M14.5 4.2a4.6 4.6 0 0 0-5.8 5.9L3.8 15a2 2 0 0 0 2.8 2.8l4.9-4.9a4.6 4.6 0 0 0 5.9-5.8l-2.9 2.9-2.4-.4-.4-2.4z"/>',
  livro: '<path d="M4 5.5A2 2 0 0 1 6 3.5h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20.5a2 2 0 0 1 2-2h13v2H6"/><path d="M8.5 8h7M8.5 11.5h5"/>',
  salvar: '<path d="M5 3.5h11l3.5 3.5v12A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z"/><path d="M8 3.5v5h7v-5M8 20.5v-6h8v6"/>',
  sair: '<path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  estrela: '<path d="M12 3.8l2.5 5.2 5.6.7-4.1 3.9 1.1 5.6L12 16.4l-5.1 2.8 1.1-5.6-4.1-3.9 5.6-.7z"/>',
  vela: '<path d="M9 10.5h6v10H9z"/><path d="M12 10.5V8M12 3.5c1.6 1.6 1.6 3.2 0 4.5-1.6-1.3-1.6-2.9 0-4.5zM6.5 20.5h11"/>',
  acoes: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5V12l6 6"/>',
  eco: '<path d="M3.5 12h2l2-5 3 10 3-14 3 12 2-3h2"/>',
};

/** SVG markup string for a stroke icon. Unknown name -> empty svg (never throws). */
export function iconSVG(name, size = 24) {
  const s = Number(size) || 24;
  return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

/** Stroke icon as an element: <span class="ic-wrap">. */
export function icon(name, size = 24, cls = '') {
  return raw(iconSVG(name, size), ['ic-wrap', cls].filter(Boolean).join(' '));
}

// ---------------------------------------------------------------- DOM helpers

/**
 * Hyperscript: h('div', {class:'x', onclick: fn, style:{...}, html:'<b>raw</b>'}, child, [children]).
 * Strings become text nodes; null/false/undefined are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Raw HTML/SVG string into an element. */
export function raw(html, cls = '') {
  return h('span', { class: cls, html });
}

export function card({ title, subtitle, icon, cls, onClick, right } = {}, ...children) {
  const head = title || icon || right
    ? h('div', { class: 'card-head' },
      icon ? h('span', { class: 'card-icon', 'aria-hidden': 'true' }, icon instanceof Node ? icon : String(icon)) : null,
      h('div', { class: 'card-titles' },
        title ? h('div', { class: 'card-title' }, title) : null,
        subtitle ? h('div', { class: 'card-sub' }, subtitle) : null),
      right || null)
    : null;
  const props = { class: ['card', cls, onClick && 'tappable'] };
  if (onClick) {
    props.onclick = onClick;
    props.role = 'button';
    props.tabindex = '0';
    props.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } };
  }
  return h('div', props, head, children);
}

let flagOk = null;
/**
 * True when this platform draws regional-indicator pairs as flags. Windows has no flag-emoji glyphs and shows
 * "us" / "IN" letters instead, which reads as a typo next to a name. Outside a browser (tests) flags are kept.
 */
export function hasFlagEmoji() {
  if (flagOk != null) return flagOk;
  flagOk = true;
  try {
    if (typeof document === 'undefined') return flagOk;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return flagOk;
    ctx.font = '32px sans-serif';
    const pair = ctx.measureText(String.fromCodePoint(0x1F1FA, 0x1F1F8)).width;
    const one = ctx.measureText(String.fromCodePoint(0x1F1FA)).width;
    // a real flag is one glyph (about one indicator wide); unsupported shows two letters side by side
    flagOk = one > 0 && pair < one * 1.5;
  } catch { flagOk = true; }
  return flagOk;
}

/** Flag emoji + space before an actor name when the platform draws flags, else "" (emblem/name identify it). */
export function flagPrefix(a) {
  return a?.flag && hasFlagEmoji() ? `${a.flag} ` : '';
}

/** Text from the sim (headlines, decision titles) without flag emoji where the platform would draw them as letters. */
export function cleanFlags(text) {
  const s = String(text ?? '');
  return hasFlagEmoji() ? s : s.replace(/[\u{1F1E6}-\u{1F1FF}]{2}\s?/gu, '');
}

/** kind: '' | 'good' | 'bad' | 'warn' | 'info' | 'muted' | 'accent' */
export function chip(text, kind = '', props = {}) {
  return h(props.onclick ? 'button' : 'span', { ...props, class: ['chip', kind && `chip-${kind}`, props.class] }, text);
}

const barCache = new Map();
/**
 * Progress/relation bar. value in [min,max]. `key` keeps the previous value so the bar
 * animates from old to new across re-renders ("barras enchem").
 */
export function bar(value, { min = 0, max = 100, kind = '', label, key, showValue = false, center = false } = {}) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  const frac = Math.max(0, Math.min(1, (v - min) / ((max - min) || 1)));
  const fill = h('div', { class: ['bar-fill', kind && `bar-${kind}`] });
  const track = h('div', { class: ['bar', center && 'bar-center'], role: 'meter', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': Math.round(v), 'aria-label': label || '' }, fill);
  if (center) {
    // diverging bar (e.g. trust -100..100) grows from the middle
    const mid = (0 - min) / ((max - min) || 1);
    const left = Math.min(mid, frac), width = Math.abs(frac - mid);
    fill.style.left = `${left * 100}%`;
    fill.style.width = `${width * 100}%`;
    fill.classList.add(frac >= mid ? 'pos' : 'neg');
  } else {
    const prev = key != null ? barCache.get(key) : undefined;
    if (prev != null && prev !== frac && !reduceMotion()) {
      fill.style.width = `${prev * 100}%`;
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${frac * 100}%`; }));
    } else fill.style.width = `${frac * 100}%`;
    if (key != null) barCache.set(key, frac);
  }
  if (!label && !showValue) return track;
  return h('div', { class: 'bar-row' },
    label ? h('span', { class: 'bar-label' }, label) : null,
    track,
    showValue ? h('span', { class: 'bar-value' }, String(Math.round(v))) : null);
}

/**
 * Button. kind: '' | primary | ghost | danger | urgent | light | link. icon: an ICONS name (stroke icon) or any
 * text/Node. big: 48px / radius 12 (action bar, sheet footers). iconSize: px for a stroke icon (default 18).
 */
export function button(label, onClick, { kind = '', disabled = false, icon: ic, title, cls, small, big, iconSize = 18 } = {}) {
  let iconEl = null;
  if (ic instanceof Node) iconEl = h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, ic);
  else if (typeof ic === 'string' && ICONS[ic]) iconEl = raw(iconSVG(ic, iconSize), 'btn-icon');
  else if (ic) iconEl = h('span', { class: 'btn-icon', 'aria-hidden': 'true' }, String(ic));
  return h('button', {
    class: ['btn', kind && `btn-${kind}`, small && 'btn-small', big && 'btn-big', cls], type: 'button', disabled: !!disabled, title, 'aria-label': title || null,
    onclick: (e) => { if (!e.currentTarget.disabled) onClick?.(e); }, // live state: callers may toggle .disabled later
  }, iconEl, label);
}

/**
 * Segmented control: options [{id,label,badge?}].
 * Default = joined in-card toggle; { cls: 'tabs' } = screen sub-navigation with an underline (DESIGN §4.6).
 */
export function segmented(options, active, onChange, { cls } = {}) {
  return h('div', { class: ['segmented', cls], role: 'tablist' },
    options.map((o) => h('button', {
      class: ['seg', o.id === active && 'active'], type: 'button', role: 'tab', 'aria-selected': o.id === active ? 'true' : 'false',
      onclick: () => onChange(o.id),
    }, o.label, o.badge ? h('span', { class: 'badge' }, String(o.badge)) : null)));
}

/** ▲ / ▼ / ■ with good/bad meaning (never color alone). */
export function trend(delta, { goodWhenUp = true, format = (d) => String(Math.round(d)), threshold = 0.5 } = {}) {
  if (delta == null || !Number.isFinite(delta) || Math.abs(delta) < threshold) {
    return h('span', { class: 'trend flat', title: 'estável', 'aria-label': 'estável' });
  }
  const up = delta > 0;
  const good = up === goodWhenUp;
  return h('span', { class: ['trend', up ? 'up' : 'down', good ? 'good' : 'bad'], title: up ? 'subiu' : 'caiu' },
    `${up ? '▲' : '▼'} ${format(Math.abs(delta))}`);
}

/** Empty state (CSmanager .vazio). iconName: an ICONS name; emoji/other glyphs are ignored. */
export function emptyState(text, iconName = '') {
  const ic = typeof iconName === 'string' && ICONS[iconName] ? raw(iconSVG(iconName, 20), 'empty-icon') : null;
  return h('div', { class: 'empty' }, ic, h('p', null, text));
}

export function sectionTitle(text, right) {
  return h('div', { class: 'section-title' }, h('h2', null, text), right || null);
}

/** Small text link for section-title right slots: "Ver tudo →". */
export function linkButton(label, onClick, { arrow = true, title } = {}) {
  return h('button', { class: 'btn-link', type: 'button', onclick: onClick, title: title || null },
    label, arrow ? raw(iconSVG('seta', 14), 'btn-link-ic') : null);
}

/** Page head (CSmanager .dir-cabecalho): h1 + optional lead + optional right slot. */
export function viewHead(title, { lead, right } = {}) {
  return h('div', { class: 'view-head' },
    h('div', { class: 'view-head-text' }, h('h1', { class: 'view-title' }, title), lead ? h('p', { class: 'view-lead' }, lead) : null),
    right || null);
}

/** Tiny SVG sparkline element from numbers. */
export function sparkline(values, { w = 80, h: hh = 22, cls = '' } = {}) {
  return raw(sparklineSVG(values, w, hh), ['spark', cls].join(' '));
}
export function sparklineSVG(values, w = 80, hh = 22) {
  const vals = (values || []).filter((v) => Number.isFinite(v));
  if (vals.length < 2) return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" aria-hidden="true"></svg>`;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 2) + 1).toFixed(1)},${(hh - 2 - ((v - lo) / span) * (hh - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return `<svg width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="currentColor"/></svg>`;
}

// ---------------------------------------------------------------- motion

export function reduceMotion() {
  try { return document.body.classList.contains('reduce-motion'); } catch { return true; }
}

const countCache = new Map();
/**
 * Number that counts up/down from the last displayed value for `key` ("números contam").
 * format(n) -> string.
 */
export function countUp(key, value, format = fmtNum, cls = 'num') {
  const el = h('span', { class: cls });
  const to = Number(value);
  const from = countCache.get(key);
  countCache.set(key, to);
  if (!Number.isFinite(to)) { el.textContent = format(value); return el; }
  if (from == null || format(from) === format(to) || reduceMotion()) { el.textContent = format(to); return el; }
  el.textContent = format(from);
  el.classList.add(to > from ? 'pulse-up' : 'pulse-down');
  const ms = 650, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = format(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = format(to);
  };
  requestAnimationFrame(step);
  return el;
}

// ---------------------------------------------------------------- overlays

function overlayRoot() {
  let r = document.getElementById('overlay-root');
  if (!r) { r = h('div', { id: 'overlay-root' }); document.body.appendChild(r); }
  return r;
}

const modalStack = [];

// Android back / browser back closes the top sheet instead of leaving the screen: every dismissable sheet
// pushes a same-URL history entry ({ adastraModal: n }); popstate closes the sheets above the entry we
// landed on, and closing a sheet by hand pops its own entry.
// markers grow across page loads too (entries left by an earlier visit always sort below this visit's sheets)
let modalSeq = (() => { try { return Date.now(); } catch { return 0; } })();
let pendingBacks = 0; // history.back() calls we made ourselves (their popstate is not the player's)
let historyTop = 0; // marker of the entry we are on once our own pending backs land (history.state lags behind them)
const markerOf = (st) => (st && typeof st === 'object' && Number.isFinite(st.adastraModal) ? st.adastraModal : 0);
function hasHistory() {
  try { return typeof history !== 'undefined' && typeof history.pushState === 'function' && typeof window !== 'undefined'; } catch { return false; }
}
function onPopState(e) {
  if (pendingBacks > 0) { pendingBacks -= 1; return; }
  const at = markerOf(e.state);
  historyTop = at;
  const above = modalStack.filter((c) => c.marker && c.marker > at);
  if (above.length) { for (const c of above.reverse()) c({ fromHistory: true }); return; }
  // landed on the entry of a sheet that was closed by navigation: skip it (that sheet is gone)
  if (at && !modalStack.some((c) => c.marker === at)) { try { history.back(); } catch { /* */ } }
}
let popBound = false;

/**
 * Bottom-sheet modal. content: Node | (close) => Node.
 * opts: { title, cls, dismissable = true, onClose }
 * Returns close().
 */
export function openModal(content, { title, cls, dismissable = true, onClose } = {}) {
  let closed = false;
  const close = ({ fromHistory = false } = {}) => {
    if (closed) return;
    closed = true;
    const i = modalStack.indexOf(close);
    if (i >= 0) modalStack.splice(i, 1);
    // closed by hand: drop our history entry so the next back press goes where the player expects
    if (close.marker && !fromHistory && hasHistory() && historyTop === close.marker) {
      pendingBacks += 1;
      historyTop = close.prevTop || 0;
      try { history.back(); } catch { pendingBacks -= 1; }
    }
    backdrop.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => backdrop.remove(), reduceMotion() ? 0 : 240);
    try { onClose?.(); } catch (e) { console.error(e); }
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable && modalStack[modalStack.length - 1] === close) close(); };
  let body;
  try { body = typeof content === 'function' ? content(close) : content; } catch (e) {
    console.error(e);
    body = fallbackPanel('Não foi possível abrir este cartão.', e);
  }
  const sheet = h('div', { class: ['modal', cls], role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Janela' },
    h('div', { class: 'modal-grab', 'aria-hidden': 'true' }),
    title || dismissable ? h('div', { class: 'modal-head' },
      title ? h('h2', { class: 'modal-title' }, title) : h('span'),
      dismissable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar', onclick: close }, icon('fechar', 20)) : null) : null,
    h('div', { class: 'modal-body' }, body));
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop && dismissable) close(); } }, sheet);
  overlayRoot().appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  if (dismissable && hasHistory()) {
    if (!popBound) { window.addEventListener('popstate', onPopState); popBound = true; }
    try {
      close.marker = ++modalSeq;
      close.prevTop = historyTop;
      history.pushState({ adastraModal: close.marker }, '');
      historyTop = close.marker;
    } catch { close.marker = 0; }
  }
  modalStack.push(close);
  setTimeout(() => sheet.querySelector('button:not(.icon-btn), [tabindex="0"]')?.focus?.({ preventScroll: true }), 30);
  return close;
}

/**
 * Close every sheet. keepHistory: the route already changed (hashchange), so the sheets' history entries are
 * behind us and must stay; otherwise pop them in one step so back is not "eaten" later.
 */
export function closeAllModals({ keepHistory = false } = {}) {
  const open = modalStack.slice();
  const marked = open.filter((c) => c.marker);
  if (!keepHistory && marked.length && hasHistory() && historyTop === marked[marked.length - 1].marker) {
    pendingBacks += 1;
    historyTop = marked[0].prevTop || 0;
    try { history.go(-marked.length); } catch { pendingBacks -= 1; }
  } else if (keepHistory && hasHistory()) historyTop = markerOf(history.state);
  for (const c of open.reverse()) c({ fromHistory: true });
}

/** Yes/no confirmation sheet. Resolves true/false. */
export function confirmDialog(text, { okLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const close = openModal((close) => h('div', { class: 'confirm' },
      typeof text === 'string' ? h('p', null, text) : text, // a Node brings its own layout
      h('div', { class: 'btn-row' },
        button(cancelLabel, () => { answered = true; resolve(false); close(); }, { big: true }),
        button(okLabel, () => { answered = true; resolve(true); close(); }, { kind: danger ? 'danger' : 'primary', big: true }))),
    { title, onClose: () => { if (!answered) resolve(false); } });
    void close;
  });
}

let toastBox = null;
/** Short floating message. kind: info | good | bad | warn */
export function toast(text, kind = 'info', ms = 2800) {
  try {
    if (!toastBox || !toastBox.isConnected) {
      toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastBox);
    }
    const t = h('div', { class: ['toast', `toast-${kind}`] }, text);
    toastBox.appendChild(t);
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  } catch (e) { console.warn('toast', text, e); }
}

// ---------------------------------------------------------------- robustness

/** Friendly placeholder shown when a panel fails (another module still in construction). */
export function fallbackPanel(text = 'Este painel ainda está em construção.', err) {
  if (err) console.warn('[Ad Astra] painel:', err);
  return h('div', { class: 'fallback' },
    raw(iconSVG('alerta', 18), 'fallback-icon'),
    h('div', null, h('div', null, text), err ? h('small', { class: 'muted' }, String(err.message || err).slice(0, 120)) : null));
}

/** Run fn() -> Node; any exception becomes a small fallback card. */
export function safePanel(fn, text) {
  try {
    const n = fn();
    return n == null ? null : n;
  } catch (e) {
    return fallbackPanel(text, e);
  }
}

/** Call fn and return its value or `fallback` on error (for queries). */
export function attempt(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** News icon: modules may store an emoji or a short name ('failure', 'budget', ...). Names map to emoji here. */
const NEWS_ICONS = {
  budget: '💰', launch: '🚀', rocket: '🚀', event: '📜', chart: '📊', delay: '⏳', cancel: '✖️', success: '✅',
  first: '🏁', failure: '💥', memorial: '🕯️', crew: '👩‍🚀', research: '🔬', politics: '🏛', diplomacy: '🤝',
};
export function newsIcon(n) {
  const i = n?.icon;
  if (i && /^[a-z_]+$/.test(i)) return NEWS_ICONS[i] || (n.importance >= 3 ? '⚡' : '•');
  return i || (n?.importance >= 3 ? '⚡' : n?.importance >= 2 ? '◆' : '•');
}

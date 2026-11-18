// Identidade e logo (EXPANSION.md §5.3–5.4, §12, drawer › Agência): the agency's emblem, name, country, HQ, launch
// sites and lineage (NACA → NASA…), how the emblem shows up in the game, and the one action "Editar o logo", which
// opens the Phase B logo editor of src/ui/found-agency.js.
//
// Editor contract (B1, tolerated when missing): found-agency.js exports one of openEmblemEditor | openLogoEditor |
// emblemEditor, called as fn({ store, actor, emblem, title, onSave(spec) }) and may also resolve to the spec. The
// new spec is saved with the action 'agency/emblem' {emblem} (fallback 'agency/identity' {emblem}).
import { h, raw, chip, fmtMonth, toast, attempt, flagPrefix } from './components.js';
import { emblemSVG } from './portrait.js';
import { specForActor } from './emblem.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { screenHead, section, listCard, note, countChip, rerender } from './screen-kit.js';
import { dateToTurn } from '../core/time.js';

const SHAPES = { roundel: 'Círculo', shield: 'Escudo', hex: 'Hexágono', chevron: 'Divisa', wing: 'Asa', star: 'Estrela', wordmark: 'Letreiro' };
const GLYPHS = { rocket: 'Foguete', orbit: 'Órbita', star: 'Estrela', planet: 'Planeta', comet: 'Cometa', capsule: 'Cápsula', atom: 'Átomo', globe: 'Globo', wreath: 'Coroa de louros' };
const DIVISIONS = { none: 'Liso', half: 'Meio a meio', band: 'Faixa', chevron: 'Divisa', quarter: 'Quartos' };
const HEX = /^#[0-9a-f]{3,8}$/i;
const listOf = (x, key) => (Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : []);

/** Pure model of the identity screen. specFor(actor) → emblem spec (B1 emblem.specForActor) for agencies without their own. */
export function identityModel(state, data, { specFor } = {}) {
  const st = state || {};
  const a = st.actors?.[st.playerId] || {};
  const lineageId = a.lineage || a.id || st.playerId;
  const lin = listOf(data?.lineages, 'lineages').find((l) => l?.id === lineageId) || null;
  const sy = st.startYear ?? 0;
  const idents = (lin?.identities || []).map((x, i) => ({
    i, name: x.name, short: x.short, turn: x.from ? dateToTurn(x.from.year, x.from.month ?? 0, sy) : null,
    when: x.from ? `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][x.from.month ?? 0]}/${x.from.year}` : '',
  }));
  const nowTurn = st.turn ?? 0;
  let currentIdx = -1;
  idents.forEach((x, i) => { if (x.turn == null || x.turn <= nowTurn) currentIdx = i; });
  const lineage = idents.filter((x) => x.turn == null || x.turn <= nowTurn).map((x) => ({ ...x, current: x.i === currentIdx }));
  const future = idents.length > lineage.length;
  let spec = a.emblem && typeof a.emblem === 'object' ? a.emblem : null;
  if (!spec && typeof specFor === 'function') { try { const x = specFor(a); spec = x && typeof x === 'object' ? x : null; } catch { spec = null; } }
  const colors = [];
  const addColor = (c, label) => { if (HEX.test(c || '') && !colors.some((x) => x.hex.toLowerCase() === c.toLowerCase())) colors.push({ hex: c, label }); };
  if (spec) { addColor(spec.field, 'Campo'); addColor(spec.field2, 'Segundo campo'); addColor(spec.glyphColor, 'Símbolo'); addColor(spec.ring?.color, 'Aro'); }
  addColor(a.color, 'Cor da agência');
  const sites = listOf(data?.hqSites, 'sites').concat(listOf(data?.['hq-sites'], 'sites'));
  let hq = null;
  if (a.hq && typeof a.hq === 'object') {
    const site = a.hq.id ? sites.find((x) => x?.id === a.hq.id) : null;
    const name = a.hq.name || site?.name || site?.city || null;
    const lat = a.hq.lat ?? site?.lat;
    const lon = a.hq.lon ?? site?.lon;
    hq = { name, coords: Number.isFinite(lat) && Number.isFinite(lon) ? `${Math.abs(lat).toFixed(1).replace('.', ',')}° ${lat >= 0 ? 'N' : 'S'} · ${Math.abs(lon).toFixed(1).replace('.', ',')}° ${lon >= 0 ? 'L' : 'O'}` : null };
  } else if (typeof a.hq === 'string') hq = { name: a.hq, coords: null };
  const born = a.born && typeof a.born === 'object' ? a.born : lin?.born || null;
  return {
    id: a.id || st.playerId, name: a.name || a.id || '', short: a.short || '', flag: a.flag || '', country: a.country || '',
    kind: a.kind, kindLabel: a.kind === 'company' ? 'Empresa privada' : 'Agência estatal', custom: !!(a.custom || lin?.custom),
    bornText: born?.year ? `${fmtMonthOf(born)}` : null, color: a.color || null, spec,
    specText: spec ? [SHAPES[spec.shape], DIVISIONS[spec.division], GLYPHS[spec.glyph], spec.stars ? `${spec.stars} estrela${spec.stars === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') : null,
    colors, hq, launchSites: (a.capabilities?.launchSites || []).slice(0, 8), lineage, futureNames: future,
    truth: lin?.truthLayer || null,
  };
}
const fmtMonthOf = (d) => `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][d.month ?? 0]}/${d.year}`;

/** The B1 editor function, or null when found-agency.js (or the export) is missing. Cached. */
let editorFn;
export async function loadEditor() {
  if (editorFn !== undefined) return editorFn;
  try {
    const m = await import('./found-agency.js');
    editorFn = m.openEmblemEditor || m.openLogoEditor || m.emblemEditor || null;
  } catch { editorFn = null; }
  return editorFn;
}

/** Save a new emblem spec through the sim (B1 action), trying the reserved names in order. */
export function saveEmblem(store, emblem) {
  let res = null;
  for (const type of ['agency/emblem', 'agency/identity']) {
    res = store.dispatch({ type, emblem });
    if (res?.ok) return res;
  }
  return res || { ok: false };
}

export function render(container, store, route) {
  ensurePainelCss();
  const st = store.state;
  const me = st.actors?.[st.playerId] || {};
  const m = identityModel(st, store.data, { specFor: specForActor });
  const nav = (tab, sub) => store.ui?.navigate?.(tab, sub);

  const edit = async () => {
    const fn = await loadEditor();
    if (!fn) { toast('O editor de logos chega junto com a criação de agências.', 'info'); return; }
    let saved = false;
    const onSave = (spec) => {
      if (!spec || saved) return;
      saved = true;
      const res = saveEmblem(store, spec);
      if (res?.ok) { toast('Logo atualizado.', 'good'); rerender(container, render, store, route); } else toast(res?.error || 'Não foi possível salvar o logo agora.', 'bad');
    };
    try {
      const out = await fn({ store, actor: me, emblem: m.spec, title: 'Editar o logo', onSave });
      if (out && typeof out === 'object' && !saved) onSave(out);
    } catch (e) { console.error(e); toast('O editor de logos encontrou um problema.', 'bad'); }
  };

  const big = emblemSVG(me, { size: 112 });
  const facts = [
    ['País', `${flagPrefix(me)}${m.country || '—'}`],
    ['Tipo', m.kindLabel],
    m.bornText ? ['Fundação', m.bornText] : null,
    m.hq ? ['Sede', [m.hq.name, m.hq.coords].filter(Boolean).join(' · ') || '—'] : null,
  ].filter(Boolean);

  const root = h('div', { class: 'view-pad tela identidade' },
    screenHead({ title: 'Identidade e logo', lead: m.custom ? 'Agência fundada por você' : 'Como o mundo reconhece a sua agência', primary: { label: 'Editar o logo', icon: 'editar', onClick: edit } }),
    h('section', { class: 'card id-cartao' },
      raw(big, 'id-emblema'),
      h('div', { class: 'id-nome' },
        h('h2', { class: 'id-titulo' }, m.name),
        h('div', { class: 'id-sigla' }, m.short ? chip(m.short, 'accent') : null, m.truth === 'fato' ? chip('agência real', 'muted') : m.custom ? chip('criada por você', 'muted') : null),
        m.specText ? h('p', { class: 'id-spec' }, m.specText) : null)),
    section('Ficha', {}, h('dl', { class: 'pn-card id-ficha' }, facts.map(([k, v]) => h('div', { class: 'id-linha' }, h('dt', null, k), h('dd', null, v))))),
    section('Cores', {}, m.colors.length ? h('div', { class: 'pn-card id-cores' }, m.colors.map((c) => h('div', { class: 'id-cor' },
      h('span', { class: 'id-amostra', style: `background:${c.hex}` }), h('span', { class: 'id-cor-txt' }, h('b', null, c.label), h('span', { class: 'mono' }, c.hex.toUpperCase()))))) : null),
    section('Como o emblema aparece', {},
      h('div', { class: 'pn-card id-usos' },
        h('div', { class: 'id-uso' }, h('span', { class: 'id-uso-rotulo' }, 'Cabeçalho'),
          h('div', { class: 'id-mock-topo' }, raw(emblemSVG(me, { size: 30 }), 'agency-emblem'), h('b', null, m.short || m.name), h('span', { class: 'data-chip' }, fmtMonth(st.turn, st.startYear)))),
        h('div', { class: 'id-uso' }, h('span', { class: 'id-uso-rotulo' }, 'Notícias e Tabela'),
          listCard([listRow({ lead: raw(emblemSVG(me, { size: 30 })), leadCls: 'pn-emblem', title: m.name, sub: 'Manchete com a sua agência', cls: 'mine' })])),
        h('div', { class: 'id-uso id-uso-mapa' }, h('span', { class: 'id-uso-rotulo' }, 'Sede no mapa-múndi'),
          h('div', { class: 'id-mock-mapa' }, raw(emblemSVG(me, { size: 26 }), 'id-pino'))))),
    m.launchSites.length ? section('Bases de lançamento', { right: countChip(m.launchSites.length) }, h('div', { class: 'pn-card id-bases' }, m.launchSites.map((s) => chip(s)))) : null,
    m.lineage.length > 1 || m.futureNames ? section('Linhagem', {},
      listCard(m.lineage.slice().reverse().map((x) => listRow({ lead: h('span', { class: 'mono id-ano' }, x.when.split('/')[1] || ''), title: x.name, sub: x.current ? 'Nome atual' : `Desde ${x.when}`, cls: x.current ? 'mine' : '' }))),
      m.futureNames ? note('A história pode mudar o nome da agência nos próximos anos.') : null) : null,
    attempt(() => (st.cap ? section('Acionistas', {}, note('Os investidores também têm emblema. Veja quem são no Conselho.', { icon: 'acoes' }),
      h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => nav('conselho') }, 'Abrir o Conselho')) : null), null));
  container.appendChild(root);
  // tell early when the editor is not in this version (the button stays, the tap explains)
  loadEditor().then((fn) => {
    if (fn || !root.isConnected) return;
    const btn = root.querySelector('.tela-acao .btn-primary');
    if (btn) btn.setAttribute('aria-describedby', 'id-editor-nota');
    root.querySelector('.tela-acao')?.append(h('p', { class: 'tela-acao-nota', id: 'id-editor-nota' }, 'O editor de logos chega junto com a criação de agências.'));
  });
}

// Hangar (rocket builder, docs/EXPANSION.md §6 and §12): list of the agency's designs, "new from a family
// template", "license a catalog rocket" and the editor (stage cards, engine sheet with deltas, tank steps, boosters,
// fairing/avionics/escape/paint, live bars and a silhouette from the launch painter). Every change is ≤ 2 taps and
// time never passes while editing: the editor keeps a local draft and asks the pure query 'designs/preview';
// only Salvar / Desenvolver / Voo de teste dispatch actions.
// Routes: #hangar · #hangar/novo · #hangar/licenca · #hangar/d/<designId>
import {
  h, chip, button, segmented, sectionTitle, emptyState, viewHead, toast, openModal, confirmDialog, icon, fmtMoney,
} from './components.js';
import { listRow } from './decisions.js';

const CAP_KEYS = ['leo', 'gto', 'tli', 'mars', 'outer'];
const CAP_SHORT = { leo: 'Órbita baixa', gto: 'GTO', tli: 'Lua', mars: 'Marte', outer: 'Externos' };
const PROP_SHORT = { kerolox: 'Querosene', alcolox: 'Álcool', hypergolic: 'Hipergólico', hydrolox: 'Hidrogênio', methalox: 'Metano', nuclear: 'Nuclear', fusion: 'Fusão', solid: 'Sólido' };
const STATUS_KIND = { project: 'muted', work: 'info', tests: 'warn', operational: 'good', retired: 'muted' };

// ------------------------------------------------------------------ research links (MISSIONS-V2 §5.3)

/** Route of a tech node in Pesquisa (opens its sheet). */
export const researchHref = (nodeId) => `#pesquisa/n/${encodeURIComponent(nodeId)}`;
function goResearch(nodeId) { if (nodeId) location.hash = researchHref(nodeId); }

/**
 * Option row of a locked part: a research lock (nodeId) stays tappable and opens that node in Pesquisa; date or
 * access locks are plain disabled rows, as before.
 */
export function lockedOption(p, right = '') {
  if (p?.nodeId) {
    return { title: p.part.name, right, sub: `${p.reason} · toque para abrir a pesquisa`, locked: true, onPick: () => goResearch(p.nodeId) };
  }
  return { title: p.part.name, right, sub: p.reason, disabled: true, onPick: () => {} };
}

// ------------------------------------------------------------------ pure helpers (tested in Node)

/** pt-BR number with up to `d` decimals ("1,5"). */
export function fmtNum(x, d = 1) {
  const v = Number(x) || 0;
  const p = 10 ** d;
  return String(Math.round(v * p) / p).replace('.', ',');
}

/** Tonnes: "0,35 t", "12 t", "1.240 t". */
export function fmtT(t) {
  const v = Number(t) || 0;
  if (v <= 0) return '0 t';
  if (v < 1) return `${fmtNum(v, 2)} t`;
  if (v < 100) return `${fmtNum(v, 1)} t`;
  return `${Math.round(v).toLocaleString('pt-BR')} t`;
}

/** Weeks as months/years in pt-BR. */
export function fmtWeeks(w) {
  const n = Math.max(0, Math.round(Number(w) || 0));
  if (n < 9) return `${n} semana${n === 1 ? '' : 's'}`;
  const m = n / 4.345;
  if (m < 24) return `${Math.round(m)} meses`;
  return `${fmtNum(n / 52, 1)} anos`;
}

/** Signed delta text with unit, or '' when it is ~0. kind: 't' | 'pct' | 'money'. */
export function fmtDelta(delta, kind = 't') {
  const v = Number(delta) || 0;
  if (kind === 'pct') {
    if (Math.abs(v) < 0.005) return '';
    return `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}% confiança`;
  }
  if (kind === 'money') {
    if (Math.abs(v) < 0.05) return '';
    return `${v > 0 ? '+' : '−'}${fmtMoney(Math.abs(v))}`;
  }
  if (Math.abs(v) < 0.01) return '';
  return `${v > 0 ? '+' : '−'}${fmtT(Math.abs(v))}`;
}

/** Reliability as pt-BR percent: one decimal near 100% ("99,8%" is not "100%"). */
export function fmtRel(p) {
  const v = Math.max(0, Math.min(1, Number(p) || 0));
  return v >= 0.99 ? `${fmtNum(Math.min(99.9, v * 100), 1)}%` : `${Math.round(v * 100)}%`;
}

/** Log-scale fill for capacity bars (0.05 t … 300 t). */
export function capFrac(t) {
  const v = Number(t) || 0;
  if (v <= 0) return 0;
  return Math.max(0.02, Math.min(1, Math.log10(1 + v * 20) / Math.log10(1 + 300 * 20)));
}

/** Local draft key: game seed + design id (drafts never leak between games). */
export const draftKey = (state, id) => `${state?.seed ?? 0}:${id}`;

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
/** Stable JSON (sorted keys): key order of edited drafts must not look like a change. */
export function canon(x) {
  if (Array.isArray(x)) return `[${x.map(canon).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).filter((k) => x[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}
const sameJSON = (a, b) => canon(a) === canon(b);

// ------------------------------------------------------------------ styles (scoped .hg-*, design tokens only)

const CSS = `
.hg { gap: var(--gap); }
.hg-actions { display: grid; grid-template-columns: 1fr; gap: 8px; }
.hg-card { background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-card); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.hg-card > header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hg-card > header .hg-t { font-size: var(--t13); font-weight: 600; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-eyebrow { font-size: var(--t10); font-weight: 500; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); }
.hg-sub { font-size: var(--t11); color: var(--text-3); }
.hg-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.hg-top { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; align-items: stretch; }
.hg-pre { background: var(--s2); border: 1px solid var(--line); border-radius: var(--r); height: 236px; display: flex; align-items: flex-end; justify-content: center; overflow: hidden; position: relative; }
.hg-pre canvas { display: block; }
.hg-pre .hg-h { position: absolute; left: 6px; top: 5px; font: 500 var(--t9)/1 var(--mono); color: var(--text-3); }
.hg-side { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hg-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.hg-name b { font-size: var(--t15); font-weight: 650; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.hg-name .icon-btn { width: 32px; height: 32px; min-height: 32px; flex: 0 0 auto; }
.hg-kv { display: flex; justify-content: space-between; gap: 8px; font-size: var(--t11); border-bottom: 1px solid var(--line); padding: 4px 0; min-width: 0; }
.hg-kv:last-child { border-bottom: 0; }
.hg-kv > span:first-child { color: var(--text-3); white-space: nowrap; }
.hg-kv > span:last-child { color: var(--text); text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-bars { display: flex; flex-direction: column; gap: 7px; }
.hg-bar { display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: var(--t11); min-width: 0; }
.hg-bar > span:first-child { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hg-track { display: block; height: 6px; border-radius: 3px; background: var(--s4); overflow: hidden; }
.hg-fill { display: block; height: 100%; border-radius: 3px; background: var(--text-2); transition: width .3s var(--curve); }
.hg-fill.acc { background: var(--yellow); }
.hg-val { font-family: var(--mono); font-size: var(--t10); color: var(--text); text-align: right; white-space: nowrap; }
.hg-d { font-family: var(--mono); font-size: var(--t9); margin-left: 4px; }
.hg-d.up { color: var(--green); } .hg-d.down { color: var(--red); }
.hg-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.hg-tile { background: var(--s2); border: 1px solid var(--line); border-radius: var(--r); padding: 8px 10px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hg-tile b { font-family: var(--mono); font-size: var(--t15); font-weight: 600; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hg-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; border-top: 1px solid var(--line); padding-top: 6px; min-width: 0; }
.hg-row:first-of-type { border-top: 0; padding-top: 0; }
.hg-row > .hg-lbl { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.hg-row > .hg-lbl > span:first-child { font-size: var(--t12); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-pick { display: flex; align-items: center; gap: 6px; background: var(--s3); border: 1px solid var(--line-strong); border-radius: var(--r); min-height: 44px; padding: 0 10px; color: var(--text); font-size: var(--t12); width: 100%; text-align: left; min-width: 0; }
.hg-pick > span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-pick:active { transform: scale(.98); }
.hg-step { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.hg-step button { width: 40px; min-width: 40px; height: 40px; min-height: 40px; padding: 0; border-radius: var(--r); background: var(--s3); border: 1px solid var(--line-strong); color: var(--text); display: inline-flex; align-items: center; justify-content: center; }
.hg-step button:disabled { opacity: .35; }
.hg-step output { min-width: 30px; text-align: center; font-family: var(--mono); font-size: var(--t13); }
.hg-chips { position: relative; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -14px; padding: 2px 14px 4px; }
.hg-chips::-webkit-scrollbar { display: none; }
.hg-chips button { flex: 0 0 auto; min-height: 36px; border-radius: 999px; background: var(--s2); border: 1px solid var(--line-strong); padding: 0 12px; color: var(--text-2); font-size: var(--t11); font-family: var(--mono); }
.hg-chips button[aria-pressed="true"] { background: var(--text); border-color: var(--text); color: var(--s0); }
.hg-chips button:disabled { opacity: .35; }
.hg-toggle { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--s2); color: var(--text-2); font-size: var(--t11); }
.hg-toggle[aria-pressed="true"] { background: var(--text); border-color: var(--text); color: var(--s0); }
.hg-toggles { display: flex; gap: 6px; flex-wrap: wrap; }
.hg-bar-act { position: sticky; bottom: 0; z-index: 2; margin: 0 calc(-12px - var(--safe-r)) -28px calc(-12px - var(--safe-l)); padding: 10px calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l)); background: linear-gradient(180deg, #07070900, var(--s0) 14px); padding-top: 16px; display: flex; flex-direction: column; gap: 6px; }
.hg-bar-act .btn { width: 100%; }
.hg-bar-row { display: grid; grid-template-columns: 1fr; gap: 8px; }
.hg-bar-row.two { grid-template-columns: auto minmax(0, 1fr); }
.hg-bar-row .btn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hg-bar-act .hg-note { font-size: var(--t10); color: var(--text-3); text-align: center; }
.hg-err { display: flex; flex-direction: column; gap: 6px; }
.hg-mini { width: 36px; height: 56px; flex: 0 0 36px; border-radius: var(--r-sm); background: var(--s2); border: 1px solid var(--line); display: flex; align-items: flex-end; justify-content: center; overflow: hidden; }
.hg-sheet-list { display: flex; flex-direction: column; background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-card); overflow: hidden; }
.hg-opt { display: flex; flex-direction: column; gap: 2px; align-items: stretch; text-align: left; padding: 10px 14px; min-height: 56px; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--text); width: 100%; }
.hg-opt:last-child { border-bottom: 0; }
.hg-opt:active { background: var(--s2); }
.hg-opt[aria-current="true"] { box-shadow: inset 3px 0 0 var(--yellow); background: var(--s2); }
.hg-opt:disabled { opacity: .45; }
.hg-opt .hg-o1 { display: flex; justify-content: space-between; gap: 8px; font-size: var(--t12); font-weight: 600; min-width: 0; }
.hg-opt .hg-o1 > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.hg-opt .hg-o2 { font-size: var(--t10); color: var(--text-3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-opt .hg-o3 { font-size: var(--t10); font-family: var(--mono); display: flex; gap: 8px; flex-wrap: wrap; }
.hg-opt .hg-o3 .up { color: var(--green); } .hg-opt .hg-o3 .down { color: var(--red); } .hg-opt .hg-o3 .flat { color: var(--text-3); }
.hg-design { display: flex; flex-direction: row; gap: 12px; align-items: center; text-align: left; color: var(--text); width: 100%; }
.hg-design:disabled { opacity: .45; }
.hg-head { display: flex; }
.hg-head .btn { padding-left: 4px; }
.hg-design .hg-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hg-design .hg-txt b { font-size: var(--t13); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hg-prog { height: 4px; border-radius: 2px; background: var(--s4); overflow: hidden; }
.hg-prog > i { display: block; height: 100%; background: var(--info); }
.hg-tpl-grid { display: flex; flex-direction: column; gap: 8px; }
.hg-locked { align-items: flex-start; }
.hg-locked .hg-mini { opacity: 0.5; }
.hg-lock-reason { display: flex; align-items: center; gap: 4px; font-size: var(--t12); font-weight: 600; color: var(--amber, var(--yellow)); margin-top: 4px; }
.hg-lock-why { font-size: var(--t12); color: var(--text-2); line-height: 1.45; }
.hg-lock-how { display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-top: 4px; font-size: var(--t12); color: var(--text-2); }
.hg-lock-how .btn { border: 1px solid var(--line-strong); justify-content: flex-start; text-align: left; white-space: normal; height: auto; min-height: 40px; padding: 8px 10px; line-height: 1.35; }
.hg-lock-step { padding: 2px 0; }
.hg-input { width: 100%; background: var(--s0); border: 1px solid var(--line-strong); border-radius: var(--r); min-height: 44px; font-size: 16px; color: var(--text); padding: 0 12px; }
@media (max-width: 360px) {
  .hg-top { grid-template-columns: 92px minmax(0, 1fr); gap: 10px; }
  .hg-pre { height: 210px; }
  .hg-bar { grid-template-columns: 62px minmax(0, 1fr) auto; }
  .hg-step button { width: 36px; min-width: 36px; height: 36px; min-height: 36px; }
}
`;

function ensureCss() {
  if (typeof document === 'undefined' || document.getElementById('hangar-css')) return;
  const s = document.createElement('style');
  s.id = 'hangar-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ painter (lazy; the Hangar works without it)

let painter = null;
function loadPainter() {
  if (!painter) {
    painter = import('./launch-render/vehicles.js')
      .then(async (m) => { try { await m.loadVehicleArt?.(); } catch { /* generic art */ } return m; })
      .catch(() => null);
  }
  return painter;
}

/** Fake vehicle for the painter: the draft's geometry (+ base vehicle for the unmodified license look). */
function previewVehicle(name, provider, derived, design) {
  return { id: `hg-${design?.id || 'draft'}`, name, provider, design: { geometry: derived?.geometry || null, baseVehicleId: design?.baseVehicleId || null, unmodified: !!derived?.unmodified, paint: derived?.geometry?.paint } };
}

/** Silhouette canvas (W×H css px). Paints asynchronously when the painter module is ready. */
function silhouette(vehicle, W, H) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const c = h('canvas', { width: Math.round(W * dpr), height: Math.round(H * dpr), style: { width: `${W}px`, height: `${H}px` }, 'aria-hidden': 'true' });
  if (!vehicle?.design?.geometry) return c;
  loadPainter().then((m) => {
    if (!m || !c.isConnected && !c.parentNode) return;
    try {
      const stack = m.resolveStack(vehicle.id, null, { vehicleData: vehicle });
      const ctx = c.getContext('2d');
      const pad = 4 * dpr;
      const k = Math.min((c.height - pad * 2) / Math.max(1, stack.heightM * 1.04 + 3), (c.width - pad * 2) / Math.max(1, stack.maxWidthM));
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.translate(c.width / 2, c.height - pad);
      m.paintVehicle(ctx, stack, { pxPerM: k, flags: {} });
      ctx.restore();
    } catch (e) { console.warn('hangar: silhueta', e); }
  });
  return c;
}

// ------------------------------------------------------------------ store helpers

const q = (store, name, fb, ...a) => store.tryQuery(name, fb, ...a);
const nav = (store, sub = '') => store.ui?.navigate?.('hangar', sub);

function result(res, okText) {
  if (res?.ok) { if (okText) toast(okText, 'good'); return true; }
  toast(res?.error || 'Não foi possível.', 'bad');
  return false;
}

// ------------------------------------------------------------------ screen

const drafts = new Map();

export function render(container, store, route) {
  ensureCss();
  const sub = String(route?.sub || '');
  const st = store.state;
  const unlocked = q(store, 'designs/unlocked', null);
  const root = h('div', { class: 'view-pad hg' });
  container.appendChild(root);
  if (!unlocked) {
    root.append(viewHead('Hangar', { lead: 'Construtor de foguetes' }), emptyState('O Hangar ainda não está ligado nesta versão do jogo.', 'chave'));
    return;
  }
  if (!unlocked.loaded) {
    root.append(viewHead('Hangar', { lead: 'Construtor de foguetes' }), emptyState('O catálogo de peças não carregou. Recarregue o jogo.', 'alerta'));
    return;
  }
  if (!unlocked.ok) {
    root.append(viewHead('Hangar', { lead: 'Construtor de foguetes' }), emptyState(`O Hangar abre em ${unlocked.fromYear}, quando os primeiros foguetes orbitais existirem.`, 'cadeado'));
    return;
  }
  if (sub === 'novo') return renderTemplates(root, store);
  if (sub === 'licenca') return renderLicenses(root, store);
  if (sub.startsWith('d/')) return renderEditor(root, store, sub.slice(2));
  return renderList(root, store, st);
}

// ------------------------------------------------------------------ list

function statusChip(s) {
  return chip(s?.label || 'Projeto', STATUS_KIND[s?.id] || 'muted');
}

function progressOf(d, turn) {
  const p = d.program;
  if (!p) return null;
  if (p.phase === 'work') {
    const span = Math.max(1, (p.readyTurn ?? turn) - (p.startedTurn ?? turn));
    return { frac: Math.min(1, Math.max(0, (turn - (p.startedTurn ?? turn)) / span)), text: `Pronto em ${fmtWeeks((p.readyTurn ?? turn) - turn)}` };
  }
  if (p.phase === 'testFlights') return { frac: (p.testOk || 0) / Math.max(1, p.needFlights || 1), text: `Testes ${p.testOk || 0}/${p.needFlights}${p.nextTestTurn != null ? ` · voo em ${fmtWeeks(p.nextTestTurn - turn)}` : ''}` };
  return null;
}

function designRow(store, d) {
  const turn = store.state.turn;
  const pr = progressOf(d, turn);
  const box = h('span', { class: 'hg-mini' });
  box.appendChild(silhouette(previewVehicle(d.name, '', { geometry: d.geometry, unmodified: d.asVehicle?.design?.unmodified }, d), 34, 54));
  return h('button', { class: 'hg-card hg-design tappable', type: 'button', onclick: () => nav(store, `d/${d.id}`), 'aria-label': `${d.name}, ${d.status?.label}` },
    box,
    h('span', { class: 'hg-txt' },
      h('span', { class: 'hg-name' }, h('b', null, d.name)),
      h('span', { class: 'hg-toggles' }, statusChip(d.status), chip(`${fmtT(d.capacity?.leo)} LEO`, 'muted'), chip(fmtMoney(d.costM), 'muted')),
      pr ? h('span', { class: 'hg-sub' }, pr.text) : null,
      pr ? h('span', { class: 'hg-prog' }, h('i', { style: { width: `${Math.round(pr.frac * 100)}%` } })) : null),
    icon('avancar', 16, 'pn-chev'));
}

function renderList(root, store, st) {
  const list = q(store, 'designs/list', []);
  const me = st.actors?.[st.playerId] || {};
  root.append(viewHead('Hangar', { lead: `Foguetes de ${me.short || me.name || 'sua agência'}: projete, licencie, teste` }));
  root.append(h('div', { class: 'hg-actions' },
    button('Novo foguete do zero', () => nav(store, 'novo'), { kind: 'primary', big: true, icon: 'mais' }),
    button('Comprar a licença de um foguete', () => nav(store, 'licenca'), { big: true, icon: 'transferir' })));
  root.append(sectionTitle('Seus projetos', h('span', { class: 'pn-count' }, `${list.length}/12`)));
  if (!list.length) {
    root.append(emptyState('Nenhum projeto ainda. Comece de um modelo da família certa ou compre um foguete pronto e modifique.', 'chave'));
  } else {
    for (const d of list) root.append(designRow(store, d));
  }
  root.append(h('p', { class: 'aviso' }, icon('info', 16), h('span', null, 'Um foguete novo passa por desenvolvimento e voos de teste com lastro antes de entrar na escolha de veículo das missões. Os voos de teste amadurecem a confiabilidade.')));
}

// ------------------------------------------------------------------ templates

function renderTemplates(root, store) {
  const tpls = q(store, 'designs/templates', []);
  root.append(h('div', { class: 'hg-head' }, button('Hangar', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })),
    viewHead('Novo foguete', { lead: 'Escolha a família: o Hangar monta um primeiro rascunho com as peças que você tem hoje.' }));
  const grid = h('div', { class: 'hg-tpl-grid' });
  for (const t of tpls) {
    if (!t.ok) { grid.append(lockedTemplateCard(store, t)); continue; }
    const prev = t.ok ? q(store, 'designs/preview', null, { spec: t.spec }) : null;
    const der = prev?.derived;
    const box = h('span', { class: 'hg-mini', style: { width: '44px', height: '72px', flex: '0 0 44px' } });
    if (der?.geometry) box.appendChild(silhouette(previewVehicle(t.name, '', der, null), 42, 70));
    grid.append(h('button', {
      class: ['hg-card hg-design tappable', !t.ok && t.nodeId && 'hg-research'], type: 'button', disabled: !t.ok && !t.nodeId,
      'aria-label': !t.ok && t.nodeId ? `${t.name}: ${t.reason}. Abrir a pesquisa.` : null,
      onclick: () => {
        if (!t.ok && t.nodeId) { goResearch(t.nodeId); return; }
        const res = store.dispatch({ type: 'design/new', templateId: t.id });
        if (result(res, 'Rascunho criado')) nav(store, `d/${res.designId}`);
      },
    }, box, h('span', { class: 'hg-txt' },
      h('b', null, t.name),
      h('span', { class: 'hg-sub' }, t.desc),
      t.ok && der?.ok
        ? h('span', { class: 'hg-toggles' }, der.capacity.leo > 0 ? chip(`${fmtT(der.capacity.leo)} LEO`, 'muted') : chip('Não chega à órbita', 'warn'), chip(`${fmtMoney(der.costM)}/voo`, 'muted'), prev?.costs ? chip(`${fmtMoney(prev.costs.devCostM)} · ${fmtWeeks(prev.costs.devWeeks)}`, 'muted') : null)
        : h('span', { class: 'hg-sub' }, t.reason || (der?.errors?.[0] ?? 'Faltam peças'), t.nodeId ? h('span', { class: 'hg-research-link' }, ' · Ver pesquisa') : null)),
    icon('avancar', 16, 'pn-chev')));
  }
  if (!tpls.length) grid.append(emptyState('Nenhum modelo disponível.', 'chave'));
  root.append(grid);
}

/**
 * A family the player cannot build yet: what is missing, why, and one tappable way per option to unlock it
 * (research node, diplomacy, or just waiting). Not a <button>: it holds its own buttons.
 */
function lockedTemplateCard(store, t) {
  const how = Array.isArray(t.how) ? t.how : [];
  const goTo = (o) => {
    if (o.nodeId) { goResearch(o.nodeId); return; }
    if (o.go) store.ui?.navigate?.(o.go);
  };
  return h('div', { class: 'hg-card hg-design hg-locked' },
    h('span', { class: 'hg-mini', style: { width: '44px', height: '72px', flex: '0 0 44px' } }),
    h('span', { class: 'hg-txt' },
      h('b', null, t.name),
      h('span', { class: 'hg-sub' }, t.desc),
      h('span', { class: 'hg-lock-reason' }, icon('cadeado', 14), ' ', t.reason || 'Bloqueado'),
      t.why ? h('span', { class: 'hg-lock-why' }, h('b', null, 'Por quê: '), t.why) : null,
      how.length ? h('span', { class: 'hg-lock-how' },
        h('b', null, 'Como liberar:'),
        ...how.map((o) => (o.nodeId || o.go)
          ? button(o.text, () => goTo(o), { kind: 'ghost', small: true, icon: o.nodeId ? 'pesquisa' : o.go === 'mundo' ? 'mundo' : 'avancar' })
          : h('span', { class: 'hg-lock-step' }, o.text))) : null));
}

// ------------------------------------------------------------------ licenses

function renderLicenses(root, store) {
  const st = store.state;
  const all = q(store, 'designs/licensable', []);
  const ok = all.filter((x) => x.ok).sort((a, b) => (a.feeM - b.feeM) || a.name.localeCompare(b.name));
  const no = all.filter((x) => !x.ok);
  root.append(h('div', { class: 'hg-head' }, button('Hangar', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })),
    viewHead('Comprar licença', { lead: 'Leve o projeto completo de um foguete em serviço, com o histórico de voos, e modifique como quiser.' }));
  const cash = st.actors?.[st.playerId]?.cash ?? 0;
  root.append(sectionTitle('Disponíveis', h('span', { class: 'pn-count' }, String(ok.length))));
  const list = h('div', { class: 'pn-list' });
  for (const v of ok) {
    const op = st.actors?.[v.operator];
    list.append(listRow({
      lead: icon('chave', 18), title: v.name, meta: v.feeM > 0 ? fmtMoney(v.feeM) : 'próprio',
      sub: `${op?.short || v.provider || v.operator || ''} · ${fmtT(v.capacity?.leo)} LEO · ${fmtMoney(v.costM)}/voo`,
      onClick: async () => {
        const msg = v.feeM > 0
          ? `Licença do ${v.name} por ${fmtMoney(v.feeM)}. Sem modificações, a adaptação leva cerca de 6 meses e ele entra em serviço sem voos de teste.${cash < v.feeM ? ' Seu caixa não cobre o valor.' : ''}`
          : `Abrir um projeto a partir do ${v.name}, que já é seu. Não há licença a pagar.`;
        if (!await confirmDialog(msg, { title: 'Comprar licença', okLabel: v.feeM > 0 ? `Pagar ${fmtMoney(v.feeM)}` : 'Abrir projeto' })) return;
        const res = store.dispatch({ type: 'design/license', vehicleId: v.vehicleId });
        if (result(res, 'Licença comprada')) nav(store, `d/${res.designId}`);
      },
    }));
  }
  if (!ok.length) list.append(emptyState('Nenhum foguete à venda para você agora.', 'cadeado'));
  root.append(list);
  if (no.length) {
    root.append(sectionTitle('Fora do seu alcance', h('span', { class: 'pn-count' }, String(no.length))));
    const l2 = h('div', { class: 'pn-list' });
    for (const v of no) {
      l2.append(listRow({
        lead: icon('cadeado', 18), title: v.name, sub: v.nodeId ? `${v.reason} · toque para abrir a pesquisa` : v.reason, cls: 'hg-locked',
        onClick: v.nodeId ? () => goResearch(v.nodeId) : null,
      }));
    }
    root.append(l2);
  }
}

// ------------------------------------------------------------------ editor

function getDraft(store, d) {
  const key = draftKey(store.state, d.id);
  let dr = drafts.get(key);
  // a saved design that changed under us (save, revision, new game) resets the draft
  if (!dr || !sameJSON(dr.base, d.spec) || dr.baseName !== d.name) {
    dr = { spec: clone(d.spec), name: d.name, base: clone(d.spec), baseName: d.name };
    drafts.set(key, dr);
  }
  return dr;
}

function renderEditor(root, store, id) {
  const d = q(store, 'designs/get', null, id);
  if (!d) {
    root.append(viewHead('Hangar'), emptyState('Projeto não encontrado.', 'alerta'), button('Voltar ao Hangar', () => nav(store), { big: true, icon: 'voltar' }));
    return;
  }
  const info = q(store, 'designs/catalogInfo', {}) || {};
  const parts = q(store, 'designs/parts', [], { licensed: d.licensedParts });
  const dias = q(store, 'designs/diameters', [], { licensed: d.licensedParts });
  const byId = Object.fromEntries(parts.map((p) => [p.part.id, p]));
  const dr = getDraft(store, d);
  const editable = !d.program || d.program.phase === 'operational';

  const redraw = () => {
    const view = root.parentElement?.parentElement;
    const top = view?.scrollTop;
    root.innerHTML = '';
    build();
    if (view && top != null) view.scrollTop = top;
  };
  const preview = (spec) => q(store, 'designs/preview', null, { designId: d.id, spec });
  const set = (fn) => { if (!editable) return; const s = clone(dr.spec); fn(s); dr.spec = s; redraw(); };

  function build() {
    const pv = preview(dr.spec);
    const saved = preview(dr.base);
    const der = pv?.derived || {};
    const sder = saved?.derived || {};
    const dirty = !sameJSON(dr.spec, dr.base) || dr.name !== d.name;
    const relNow = d.reliability?.mean ?? 0;
    const relDraft = Math.max(0, Math.min(1, (der.inherent ?? 0) - (pv?.costs?.newness ?? 0)));

    root.append(h('div', { class: 'hg-head' }, button('Hangar', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })));
    // ---- preview + identity
    const pre = h('div', { class: 'hg-pre' }, h('span', { class: 'hg-h' }, `${fmtNum(der.heightM ?? 0, 0)} m`));
    pre.appendChild(silhouette(previewVehicle(dr.name, store.state.actors?.[store.state.playerId]?.short, der, d), 110, 232));
    const nameRow = h('div', { class: 'hg-name' }, h('b', null, dr.name),
      editable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Renomear', onclick: () => renameSheet(dr, redraw) }, icon('editar', 18)) : null);
    root.append(h('section', { class: 'hg-card' },
      h('div', { class: 'hg-top' }, pre,
        h('div', { class: 'hg-side' },
          nameRow,
          h('div', { class: 'hg-toggles' }, statusChip(d.status), d.origin === 'license' ? chip(d.parentId ? 'Revisão' : 'Licença', 'muted') : chip('Do zero', 'muted')),
          kv('Massa na decolagem', fmtT(der.massT)),
          kv('Empuxo/peso', `${fmtNum(der.liftoffTWR ?? 0, 2)}×`),
          kv('Diâmetro', `${fmtNum(der.diaM ?? 0, 1)} m`),
          kv('Estágios', String(dr.spec.stages.length) + (dr.spec.boosters ? ` + ${dr.spec.boosters.count} laterais` : '')),
          kv('Voos', `${d.reliability?.flights ?? 0}`))),
    ));
    // ---- live numbers
    const bars = h('div', { class: 'hg-bars' });
    for (const k of CAP_KEYS) {
      const v = der.capacity?.[k] ?? 0;
      const dv = dirty ? v - (sder.capacity?.[k] ?? 0) : 0;
      bars.append(h('div', { class: 'hg-bar' },
        h('span', null, CAP_SHORT[k]),
        h('span', { class: 'hg-track' }, h('span', { class: ['hg-fill', k === 'leo' && 'acc'], style: { width: `${Math.round(capFrac(v) * 100)}%` } })),
        h('span', { class: 'hg-val' }, fmtT(v), dv ? h('span', { class: ['hg-d', dv > 0 ? 'up' : 'down'] }, fmtDelta(dv)) : null)));
    }
    const pc = pv?.costs;
    const dCost = dirty ? (der.costM ?? 0) - (sder.costM ?? 0) : 0;
    root.append(h('section', { class: 'hg-card', 'aria-label': 'Números do projeto' },
      h('span', { class: 'hg-eyebrow' }, 'Carga por destino'),
      bars,
      h('div', { class: 'hg-tiles' },
        tile('Confiança', d.program?.phase === 'operational' || d.program?.phase === 'testFlights' ? fmtRel(relNow) : fmtRel(relDraft), d.program ? `${d.reliability?.flights || 0} voo(s)` : 'estimada no 1º voo'),
        tile('Custo por voo', fmtMoney(der.costM ?? 0), dCost ? fmtDelta(dCost, 'money') : (der.capacity?.leo > 0 ? `${fmtMoney((der.costM ?? 0) / der.capacity.leo)}/t` : '')),
        d.program && d.program.phase !== 'operational'
          ? tile('Desenvolvimento', fmtMoney(d.program.devCostM), `pago ${fmtMoney(d.program.paidM || 0)}`)
          : tile(pv?.revision ? 'Revisão' : 'Desenvolvimento', pc ? fmtMoney(pc.devCostM) : '—', pc ? fmtWeeks(pc.devWeeks) : ''),
        tile('Voos de teste', d.program ? `${d.program.testOk || 0}/${d.program.needFlights}` : (pc ? String(pc.needFlights) : '—'), pc && !pc.needFlights ? 'entra direto em serviço' : 'com lastro, sem tripulação'))));
    // ---- problems
    const probs = [...(pv?.errors || []), ...(pv?.locked || []).map((l) => `${l.name}: ${l.reason}`)];
    if (probs.length || pv?.warnings?.length) {
      root.append(h('div', { class: 'hg-err' },
        probs.map((t) => h('p', { class: 'aviso bad' }, icon('alerta', 16), h('span', null, t))),
        (pv?.warnings || []).map((t) => h('p', { class: 'aviso warn' }, icon('info', 16), h('span', null, t)))));
    }
    if (!editable) root.append(h('p', { class: 'aviso' }, icon('cadeado', 16), h('span', null, 'Em desenvolvimento: o projeto fica travado. Quando estiver operacional, editar cria uma revisão.')));

    // ---- stage cards, top first (as the rocket stands)
    root.append(sectionTitle('Estrutura', h('span', { class: 'pn-count' }, `${dr.spec.stages.length}/${info.rules?.maxStages ?? 4}`)));
    root.append(topCard());
    for (let i = dr.spec.stages.length - 1; i >= 0; i--) root.append(stageCard(i, pv));
    if (editable && dr.spec.stages.length < (info.rules?.maxStages ?? 4)) {
      root.append(button('Acrescentar estágio superior', () => set((s) => {
        const prev = s.stages[s.stages.length - 1];
        const eng = parts.filter((p) => p.ok && p.part.kind === 'engine').map((p) => p.part).sort((a, b) => (b.upperOnly ? 1 : 0) - (a.upperOnly ? 1 : 0) || b.ispVac - a.ispVac)[0];
        s.stages.push(prev?.moduleId || !eng ? { moduleId: parts.find((p) => p.ok && p.part.kind === 'upper')?.part.id } : { engineId: eng.id, engines: 1, tank: prev.tank, size: Math.max(1, Math.round((prev.size || 4) / 4)) });
      }), { icon: 'mais' }));
    }
    root.append(boosterCard());

    if (!d.program) {
      root.append(button('Descartar projeto', async () => {
        if (!await confirmDialog(`Descartar o ${d.name}? A licença paga não volta.`, { title: 'Descartar', okLabel: 'Descartar', danger: true })) return;
        if (result(store.dispatch({ type: 'design/retire', designId: d.id }), 'Projeto descartado')) nav(store);
      }, { kind: 'ghost', small: true }));
    }
    // ---- action bar
    root.append(actionBar(pv, dirty));
  }

  function kv(a, b) { return h('div', { class: 'hg-kv' }, h('span', null, a), h('span', null, b)); }
  function tile(label, value, subTxt) { return h('div', { class: 'hg-tile' }, h('span', { class: 'hg-eyebrow' }, label), h('b', null, value), subTxt ? h('span', { class: 'hg-sub' }, subTxt) : null); }

  function stepper(value, min, max, onChange, label) {
    return h('span', { class: 'hg-step', role: 'group', 'aria-label': label },
      h('button', { type: 'button', 'aria-label': `Menos ${label}`, disabled: !editable || value <= min, onclick: () => onChange(value - 1) }, icon('menos', 18)),
      h('output', null, String(value)),
      h('button', { type: 'button', 'aria-label': `Mais ${label}`, disabled: !editable || value >= max, onclick: () => onChange(value + 1) }, icon('mais', 18)));
  }

  function partName(id) { return byId[id]?.part?.name || (id ? id : '—'); }

  function stageCard(i, pv) {
    const s = dr.spec.stages[i];
    const sd = pv?.derived?.stages?.[i];
    const title = i === 0 ? '1º estágio' : `${i + 1}º estágio`;
    const card = h('section', { class: 'hg-card' });
    const head = h('header', null, h('span', { class: 'hg-t' }, `${title}${sd ? ` · ${PROP_SHORT[sd.prop] || ''}` : ''}`),
      sd ? h('span', { class: 'hg-sub hg-mono' }, `${fmtT(sd.propT)} · ${fmtNum(sd.len, 0)} m`) : null,
      editable && i > 0 && i === dr.spec.stages.length - 1 ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remover ${title}`, onclick: () => set((x) => { x.stages.pop(); }) }, icon('fechar', 18)) : null);
    card.append(head);
    if (s.moduleId) {
      card.append(h('div', { class: 'hg-row' },
        h('button', { class: 'hg-pick', type: 'button', disabled: !editable, onclick: () => moduleSheet(i) }, h('span', null, partName(s.moduleId)), icon('avancar', 16)),
      ));
      if (editable && i > 0) card.append(h('div', { class: 'hg-toggles' }, h('button', { class: 'hg-toggle', type: 'button', onclick: () => set((x) => { x.stages[i] = { engineId: dr.spec.stages[i - 1]?.engineId || parts.find((p) => p.ok && p.part.kind === 'engine')?.part.id, engines: 1, tank: dr.spec.stages[i - 1]?.tank || dias.find((dd) => dd.ok)?.id, size: 3 }; }) }, 'Montar com motor e tanque')));
      return card;
    }
    const eng = byId[s.engineId]?.part;
    card.append(h('div', { class: 'hg-row' },
      h('button', { class: 'hg-pick', type: 'button', disabled: !editable, onclick: () => engineSheet(i), 'aria-label': `Motor do ${title}: ${partName(s.engineId)}` },
        h('span', null, partName(s.engineId) + (s.engineId2 ? ` + ${partName(s.engineId2)}` : '')), icon('avancar', 16))));
    card.append(h('div', { class: 'hg-row' },
      h('span', { class: 'hg-lbl' }, h('span', null, 'Motores'), h('span', { class: 'hg-sub hg-mono' }, eng ? `${Math.round((sd?.thrustKN ?? 0)).toLocaleString('pt-BR')} kN · Isp ${sd?.isp ?? '—'} s` : '')),
      stepper(s.engines, 1, info.rules?.maxEnginesPerStage ?? 33, (v) => set((x) => { x.stages[i].engines = v; }), 'motores')));
    card.append(h('div', { class: 'hg-row' },
      h('span', { class: 'hg-lbl' }, h('span', null, 'Tanque'), h('span', { class: 'hg-sub hg-mono' }, sd ? `${fmtNum(sd.d, 2)} m × ${fmtNum(sd.len, 0)} m` : '')),
      stepper(s.size, 1, 32, (v) => set((x) => { x.stages[i].size = v; }), 'degraus de tanque')));
    const chips = h('div', { class: 'hg-chips', role: 'group', 'aria-label': 'Diâmetro do tanque' });
    for (const dd of dias) {
      if (!dd.ok && dd.id !== s.tank) continue;
      chips.append(h('button', { type: 'button', 'aria-pressed': dd.id === s.tank ? 'true' : 'false', disabled: !editable, onclick: () => set((x) => { x.stages[i].tank = dd.id; }) }, `${fmtNum(dd.d, 2)} m`));
    }
    card.append(chips);
    globalThis.requestAnimationFrame?.(() => { const sel = chips.querySelector('[aria-pressed="true"]'); if (sel) chips.scrollLeft = Math.max(0, sel.offsetLeft - chips.clientWidth / 2 + sel.offsetWidth / 2); });
    const tg = h('div', { class: 'hg-toggles' });
    const year = Math.floor(store.state.startYear + store.state.turn / 52);
    if (i <= 1 && year >= (i === 0 ? 2015 : 2026)) tg.append(toggle('Reutilizável', !!s.reuse, () => set((x) => { if (x.stages[i].reuse) delete x.stages[i].reuse; else x.stages[i].reuse = true; })));
    if (eng && eng.prop !== 'solid') tg.append(toggle('Tanque-balão', !!s.balloon, () => set((x) => { if (x.stages[i].balloon) delete x.stages[i].balloon; else x.stages[i].balloon = true; })));
    if (i > 0 && editable && parts.some((p) => p.ok && p.part.kind === 'upper')) tg.append(h('button', { class: 'hg-toggle', type: 'button', onclick: () => moduleSheet(i) }, 'Usar módulo pronto'));
    if (tg.childNodes.length) card.append(tg);
    return card;
  }

  function toggle(label, on, onClick) {
    return h('button', { class: 'hg-toggle', type: 'button', 'aria-pressed': on ? 'true' : 'false', disabled: !editable, onclick: onClick }, on ? icon('check', 14) : null, label);
  }

  function topCard() {
    const s = dr.spec;
    const card = h('section', { class: 'hg-card' }, h('header', null, h('span', { class: 'hg-t' }, 'Topo: coifa, aviônica e escape')));
    card.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-lbl' }, h('span', null, 'Coifa'), h('span', { class: 'hg-sub' }, s.fairingId ? '' : 'Sem coifa: a nave vai exposta')),
      h('button', { class: 'hg-pick', type: 'button', disabled: !editable, style: { width: '58%' }, onclick: () => simpleSheet('fairing', 'Coifa', 'fairingId', true) }, h('span', null, s.fairingId ? partName(s.fairingId) : 'Nenhuma'), icon('avancar', 16))));
    card.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-lbl' }, h('span', null, 'Aviônica')),
      h('button', { class: 'hg-pick', type: 'button', disabled: !editable, style: { width: '58%' }, onclick: () => simpleSheet('avionics', 'Aviônica', 'avionicsId', false) }, h('span', null, partName(s.avionicsId)), icon('avancar', 16))));
    card.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-lbl' }, h('span', null, 'Escape'), h('span', { class: 'hg-sub' }, s.escapeId ? 'Pode ser certificado para gente' : 'Só carga')),
      h('button', { class: 'hg-pick', type: 'button', disabled: !editable, style: { width: '58%' }, onclick: () => simpleSheet('escape', 'Sistema de escape', 'escapeId', true) }, h('span', null, s.escapeId ? partName(s.escapeId) : 'Nenhum'), icon('avancar', 16))));
    const paints = info.paints || [];
    if (paints.length) {
      const pc = h('div', { class: 'hg-chips', role: 'group', 'aria-label': 'Pintura' });
      for (const p of paints) pc.append(h('button', { type: 'button', 'aria-pressed': p.id === (s.paint || 'white') ? 'true' : 'false', disabled: !editable, onclick: () => set((x) => { x.paint = p.id; }) }, p.label));
      card.append(h('span', { class: 'hg-eyebrow' }, 'Pintura'), pc);
    }
    return card;
  }

  function boosterCard() {
    const b = dr.spec.boosters;
    const counts = (info.rules?.boosterCounts || [0, 2, 4, 6]);
    const card = h('section', { class: 'hg-card' }, h('header', null, h('span', { class: 'hg-t' }, 'Propulsores laterais'),
      b ? h('span', { class: 'hg-sub hg-mono' }, `${b.count} × ${fmtT(byId[b.id]?.part?.propT)}`) : null));
    card.append(segmented(counts.map((c) => ({ id: String(c), label: c ? `${c}` : 'Nenhum' })), String(b?.count || 0), (v) => set((x) => {
      const n = Number(v);
      if (!n) { x.boosters = null; return; }
      const id = x.boosters?.id || parts.filter((p) => p.ok && p.part.kind === 'booster').map((p) => p.part).sort((p1, p2) => p2.reliability - p1.reliability)[0]?.id;
      x.boosters = id ? { ...(x.boosters || {}), id, count: n } : null;
    })));
    if (b) {
      card.append(h('div', { class: 'hg-row' },
        h('button', { class: 'hg-pick', type: 'button', disabled: !editable, onclick: () => boosterSheet() }, h('span', null, partName(b.id)), icon('avancar', 16))));
      if (byId[b.id]?.part?.reusable) card.append(h('div', { class: 'hg-toggles' }, toggle('Recuperar e reusar', !!b.reuse, () => set((x) => { if (x.boosters.reuse) delete x.boosters.reuse; else x.boosters.reuse = true; }))));
    }
    return card;
  }

  // ---- sheets with deltas (each option is previewed against the current draft)
  function deltaLine(base, spec) {
    const p = preview(spec);
    if (!p?.derived?.ok) return h('span', { class: 'hg-o3' }, h('span', { class: 'down' }, p?.errors?.[0] || 'Não funciona assim'));
    const b = base?.derived || {};
    const n = p.derived;
    const dl = (n.capacity?.leo ?? 0) - (b.capacity?.leo ?? 0);
    const dr2 = ((n.inherent ?? 0) - (p.costs?.newness ?? 0)) - ((b.inherent ?? 0) - (base?.costs?.newness ?? 0));
    const dc = (n.costM ?? 0) - (b.costM ?? 0);
    const part = (txt, v, good) => (txt ? h('span', { class: Math.abs(v) < 1e-9 ? 'flat' : (good ? 'up' : 'down') }, txt) : null);
    const items = [
      part(fmtDelta(dl) ? `${fmtDelta(dl)} LEO` : '', dl, dl > 0),
      part(fmtDelta(dr2, 'pct'), dr2, dr2 > 0),
      part(fmtDelta(dc, 'money'), dc, dc < 0),
    ].filter(Boolean);
    return h('span', { class: 'hg-o3' }, items.length ? items : h('span', { class: 'flat' }, `${fmtT(n.capacity?.leo)} LEO, sem mudança`));
  }

  function optionsSheet(title, options, { note } = {}) {
    openModal((close) => h('div', { class: 'hg-sheet' },
      note ? h('p', { class: 'hg-sub', style: { margin: '0 0 8px' } }, note) : null,
      h('div', { class: 'hg-sheet-list' }, options.map((o) => h('button', {
        class: 'hg-opt', type: 'button', disabled: !!o.disabled, 'aria-current': o.current ? 'true' : 'false',
        onclick: () => { close(); o.onPick(); },
      }, h('span', { class: 'hg-o1' }, h('span', null, o.title), o.right ? h('span', { class: 'hg-mono' }, o.right) : null),
      o.sub ? h('span', { class: 'hg-o2' }, o.sub) : null,
      o.delta || null)))), { title });
  }

  function engineSheet(i) {
    const s = dr.spec.stages[i];
    const base = preview(dr.spec);
    const engines = parts.filter((p) => p.part.kind === 'engine' && !(i === 0 && p.part.upperOnly));
    const ym = (p) => (p.part.availableFrom?.year ?? 0) * 12 + (p.part.availableFrom?.month ?? 1);
    // the current engine first, then the newest on the market
    const ok = engines.filter((p) => p.ok).sort((a, b) => (b.part.id === s.engineId) - (a.part.id === s.engineId) || ym(b) - ym(a) || b.part.thrustKN - a.part.thrustKN);
    const locked = engines.filter((p) => !p.ok).slice(0, 8);
    const options = ok.map((p) => {
      const e = p.part;
      const spec = clone(dr.spec);
      spec.stages[i] = { ...spec.stages[i], engineId: e.id };
      delete spec.stages[i].engineId2; delete spec.stages[i].engines2;
      return {
        title: e.name, right: PROP_SHORT[e.prop] || e.prop, current: e.id === s.engineId,
        sub: `${Math.round(e.thrustKN).toLocaleString('pt-BR')} kN · Isp ${e.ispSL ? `${e.ispSL}–` : ''}${e.ispVac} s · ${fmtNum(e.massT, 2)} t · ${fmtMoney(e.costM)}`,
        delta: e.id === s.engineId ? null : deltaLine(base, spec),
        onPick: () => set((x) => { x.stages[i] = spec.stages[i]; }),
      };
    });
    for (const p of locked) options.push(lockedOption(p, PROP_SHORT[p.part.prop] || ''));
    optionsSheet(`Motor do ${i === 0 ? '1º' : `${i + 1}º`} estágio`, options, { note: 'Variação comparada ao projeto atual, com a mesma quantidade de motores.' });
  }

  function moduleSheet(i) {
    const base = preview(dr.spec);
    const mods = parts.filter((p) => p.part.kind === 'upper' && (i > 0 || p.part.firstStage));
    const options = mods.filter((p) => p.ok).map((p) => {
      const spec = clone(dr.spec);
      spec.stages[i] = { moduleId: p.part.id };
      return {
        title: p.part.name, right: PROP_SHORT[p.part.prop] || '', current: dr.spec.stages[i]?.moduleId === p.part.id,
        sub: `${fmtT(p.part.propT)} de propelente · Isp ${p.part.ispVac} s · ${fmtMoney(p.part.costM)}`,
        delta: deltaLine(base, spec), onPick: () => set((x) => { x.stages[i] = { moduleId: p.part.id }; }),
      };
    });
    for (const p of mods.filter((x) => !x.ok).slice(0, 6)) options.push(lockedOption(p));
    if (!options.length) options.push({ title: 'Nenhum módulo disponível', disabled: true, onPick: () => {} });
    optionsSheet('Módulo pronto', options, { note: 'Estágios completos de foguetes reais (Centaur, Fregat, Agena…).' });
  }

  function boosterSheet() {
    const base = preview(dr.spec);
    const list = parts.filter((p) => p.part.kind === 'booster');
    const options = list.filter((p) => p.ok).map((p) => {
      const spec = clone(dr.spec);
      spec.boosters = { id: p.part.id, count: dr.spec.boosters?.count || 2 };
      return {
        title: p.part.name, right: PROP_SHORT[p.part.prop] || '', current: dr.spec.boosters?.id === p.part.id,
        sub: `${fmtT(p.part.propT)} cada · ${fmtMoney(p.part.costM)}`, delta: deltaLine(base, spec),
        onPick: () => set((x) => { x.boosters = spec.boosters; }),
      };
    });
    for (const p of list.filter((x) => !x.ok).slice(0, 6)) options.push(lockedOption(p));
    optionsSheet('Propulsores laterais', options);
  }

  function simpleSheet(kind, title, field, allowNone) {
    const base = preview(dr.spec);
    const list = parts.filter((p) => p.part.kind === kind);
    const options = [];
    if (allowNone) {
      const spec = clone(dr.spec); delete spec[field]; if (field === 'fairingId') spec.fairingId = null;
      options.push({ title: 'Nenhum', current: !dr.spec[field], delta: dr.spec[field] ? deltaLine(base, spec) : null, onPick: () => set((x) => { if (field === 'fairingId') x.fairingId = null; else delete x[field]; }) });
    }
    for (const p of list.filter((x) => x.ok)) {
      const spec = clone(dr.spec); spec[field] = p.part.id;
      options.push({
        title: p.part.name, current: dr.spec[field] === p.part.id,
        sub: [p.part.d ? `${fmtNum(p.part.d, 1)} m` : null, `${fmtT(p.part.massT)}`, p.part.reliability ? `${fmtNum(p.part.reliability * 100, 1)}%` : null, fmtMoney(p.part.costM)].filter(Boolean).join(' · '),
        delta: dr.spec[field] === p.part.id ? null : deltaLine(base, spec), onPick: () => set((x) => { x[field] = p.part.id; }),
      });
    }
    for (const p of list.filter((x) => !x.ok).slice(0, 4)) options.push(lockedOption(p));
    optionsSheet(title, options);
  }

  function renameSheet(draft, after) {
    const input = h('input', { class: 'hg-input', type: 'text', maxlength: '28', value: draft.name, 'aria-label': 'Nome do foguete' });
    openModal((close) => h('div', { class: 'hg-sheet' }, input,
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        button('Cancelar', () => close(), { big: true }),
        button('Usar este nome', () => { const v = input.value.trim(); if (v) draft.name = v.slice(0, 28); close(); after(); }, { kind: 'primary', big: true }))), { title: 'Nome do foguete' });
    setTimeout(() => input.focus(), 60);
  }

  function actionBar(pv, dirty) {
    const bar = h('div', { class: 'hg-bar-act' });
    const phase = d.program?.phase || null;
    const save = (then) => {
      const res = store.dispatch({ type: 'design/save', designId: d.id, draft: { ...dr.spec, name: dr.name } });
      if (!result(res, res?.revision ? 'Revisão criada' : 'Projeto salvo')) return null;
      drafts.delete(draftKey(store.state, d.id));
      if (res.designId !== d.id) nav(store, `d/${res.designId}`);
      then?.(res);
      return res;
    };
    if (!phase) {
      const pc = pv?.costs;
      const row = h('div', { class: ['hg-bar-row', dirty && 'two'] });
      bar.append(row);
      if (dirty) row.append(button('Salvar', () => save(), { big: true, icon: 'salvar', disabled: !pv?.ok }));
      row.append(button(pc ? `Desenvolver · ${fmtMoney(pc.upfrontM)}` : 'Desenvolver', async () => {
        if (dirty && !save()) return;
        const p2 = q(store, 'designs/preview', null, { designId: d.id, spec: dr.spec });
        const c = p2?.costs || pc;
        const ok = await confirmDialog(`Desenvolver o ${dr.name}: ${fmtMoney(c.devCostM)} no total (${fmtMoney(c.upfrontM)} agora, o resto aos poucos), cerca de ${fmtWeeks(c.devWeeks)}${c.needFlights ? ` e ${c.needFlights} voo(s) de teste` : ', sem voos de teste'}.`, { title: 'Começar o desenvolvimento', okLabel: 'Desenvolver' });
        if (!ok) return;
        result(store.dispatch({ type: 'design/develop', designId: d.id }), 'Desenvolvimento iniciado');
      }, { kind: 'primary', big: true, icon: 'chave', disabled: !pv?.ok || !(pv?.derived?.capacity?.leo > 0) }));
    } else if (phase === 'work') {
      const p = d.program;
      bar.append(h('p', { class: 'hg-note' }, `${p.paused ? 'Parado por falta de caixa. ' : ''}Pronto em ${fmtWeeks((p.readyTurn ?? 0) - store.state.turn)} · pago ${fmtMoney(p.paidM || 0)} de ${fmtMoney(p.devCostM)}`));
      bar.append(button('Cancelar desenvolvimento', async () => {
        if (!await confirmDialog('Cancelar o desenvolvimento? O que já foi gasto não volta.', { title: 'Cancelar', okLabel: 'Cancelar desenvolvimento', danger: true, cancelLabel: 'Continuar' })) return;
        result(store.dispatch({ type: 'design/cancel', designId: d.id }), 'Desenvolvimento cancelado');
      }, { kind: 'danger', big: true }));
    } else if (phase === 'testFlights') {
      const p = d.program;
      const cost = q(store, 'designs/testFlightPlan', null, d.id)?.costM ?? d.costM;
      if (d.testMission) {
        // the mission system flies it with the launch scene (Missões › Programa)
        bar.append(button(d.testMission.status === 'planning' ? 'Agendar o voo de teste em Missões' : 'Ver o voo de teste em Missões', () => store.ui?.navigate?.('missoes', `m/${d.testMission.id}`), { kind: 'primary', big: true, icon: 'missoes' }));
        bar.append(h('p', { class: 'hg-note' }, `${p.testOk || 0} de ${p.needFlights} voo(s) com sucesso · lastro em órbita`));
        return bar;
      }
      if (p.nextTestTurn != null) bar.append(h('p', { class: 'hg-note' }, `Voo de teste ${(p.testFlights || 0) + 1} em ${fmtWeeks(p.nextTestTurn - store.state.turn)}`));
      bar.append(button(p.nextTestTurn != null ? 'Voo de teste marcado' : `Marcar voo de teste · ${fmtMoney(cost)}`, () => {
        result(store.dispatch({ type: 'design/testFlight', designId: d.id }), 'Voo de teste marcado');
      }, { kind: 'primary', big: true, icon: 'calendario', disabled: p.nextTestTurn != null }));
      bar.append(h('p', { class: 'hg-note' }, `${p.testOk || 0} de ${p.needFlights} voo(s) com sucesso · lastro em órbita baixa`));
    } else {
      if (dirty) {
        const rev = !sameJSON(dr.spec, dr.base);
        bar.append(button(rev ? 'Salvar como revisão' : 'Salvar nome e pintura', () => save(), { kind: 'primary', big: true, icon: 'salvar', disabled: !pv?.ok }));
        if (rev && pv?.costs) bar.append(h('p', { class: 'hg-note' }, `Revisão: ${fmtMoney(pv.costs.devCostM)} · ${fmtWeeks(pv.costs.devWeeks)} · ${pv.costs.needFlights} voo de teste`));
      } else {
        bar.append(button('Usar numa missão', () => store.ui?.navigate?.('missoes', 'nova'), { big: true, icon: 'missoes' }));
        bar.append(h('p', { class: 'hg-note' }, 'Operacional: aparece na escolha de veículo das missões. Editar cria uma revisão.'));
      }
    }
    return bar;
  }

  build();
}

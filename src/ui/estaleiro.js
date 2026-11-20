// Estaleiro (spacecraft designer), sibling of the Hangar: list of the agency's craft designs, "nova nave do zero"
// (pick a role: the Estaleiro fills a first draft for its usual target), "partir de uma nave do catálogo" and the
// editor (structure, shape, finish, arrays/antenna placement, part groups with steppers, propellant, live numbers,
// the craft drawn by the launch painter, a destination target with the red "Por que não serve" box, and the missions
// it can fly). Time never passes while editing: the editor keeps a local draft and asks the pure query
// 'craft/preview'; only Salvar / Desenvolver / Qualificar dispatch actions (src/sim/craftdesigns.js).
// Routes: #estaleiro · #estaleiro/novo · #estaleiro/catalogo · #estaleiro/d/<designId>
import { h, chip, button, sectionTitle, emptyState, viewHead, toast, openModal, confirmDialog, icon, fmtMoney } from './components.js';
import { listRow } from './decisions.js';
import { ensureCss as hangarCss, fmtNum, fmtT, fmtWeeks, fmtRel, fmtDelta, canon, draftKey, lockedOption, researchHref } from './hangar.js';

const STATUS_KIND = { project: 'muted', work: 'info', tests: 'warn', operational: 'good', retired: 'muted' };
const ROLE_ICON = { satellite: 'satelite', probe: 'sonda', lander: 'base', rover: 'rodas', capsule: 'capsula', cargo: 'modulo', module: 'estacao' };
const KIND_LABEL = { orbit: 'Órbita', station: 'Estação', flyby: 'Sobrevoo', surface: 'Superfície', atmosphere: 'Atmosfera', rendezvous: 'Encontro', suborbital: 'Suborbital', interstellar: 'Interestelar' };

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const sameJSON = (a, b) => canon(a) === canon(b);
const q = (store, name, fb, ...a) => store.tryQuery(name, fb, ...a);
const nav = (store, sub = '') => store.ui?.navigate?.('estaleiro', sub);
const goResearch = (nodeId) => { if (nodeId) location.hash = researchHref(nodeId); };

/** "1,2 km/s" */
export const fmtDv = (v) => `${fmtNum(v, 2)} km/s`;
/** Power in W/kW. */
export function fmtW(w) {
  const v = Math.round(Number(w) || 0);
  return v >= 10000 ? `${fmtNum(v / 1000, 0)} kW` : v >= 1000 ? `${fmtNum(v / 1000, 1)} kW` : `${v} W`;
}
/** Life in pt-BR (weeks under ~3 months). */
export function fmtLife(y) {
  const v = Number(y) || 0;
  if (v <= 0) return '—';
  if (v < 0.25) return fmtWeeks(v * 52);
  return `${fmtNum(v, v < 3 ? 1 : 0)} ano${v >= 2 ? 's' : ''}`;
}

const CSS = `
.es-tgt { display: flex; flex-direction: column; gap: 6px; }
.es-ok { border: 1px solid var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--text); border-radius: var(--r); padding: 10px 12px; font-size: var(--t12); line-height: 1.45; }
.es-ok b { color: var(--green); }
.es-parts { display: flex; flex-direction: column; }
.es-part { display: flex; align-items: center; gap: 8px; min-height: 48px; border-top: 1px solid var(--line); padding: 4px 0; min-width: 0; }
.es-part:first-child { border-top: 0; }
.es-part .hg-lbl { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.es-part .hg-lbl > span:first-child { font-size: var(--t12); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.es-dests { display: flex; flex-wrap: wrap; gap: 6px; }
.es-dests .chip { max-width: 100%; }
.es-types { display: flex; flex-direction: column; gap: 4px; font-size: var(--t12); color: var(--text-2); }
.es-types b { color: var(--text); font-weight: 600; }
.es-pre { height: 200px; align-items: center; }
`;
function ensureCss() {
  hangarCss();
  if (typeof document === 'undefined' || document.getElementById('estaleiro-css')) return;
  const s = document.createElement('style');
  s.id = 'estaleiro-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ painter (lazy; the Estaleiro works without it)

let painter = null;
function loadPainter() {
  if (!painter) painter = import('./launch-render/vehicles.js').then(async (m) => { try { await m.loadVehicleArt?.(); } catch { /* generic */ } return m; }).catch(() => null);
  return painter;
}

/** Canvas with the designed craft (geometry from craft/preview) drawn by the launch painter. */
function craftCanvas(name, geometry, W, H) {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const c = h('canvas', { width: Math.round(W * dpr), height: Math.round(H * dpr), style: { width: `${W}px`, height: `${H}px` }, 'aria-hidden': 'true' });
  if (!geometry) return c;
  loadPainter().then((m) => {
    if (!m?.craftDesignArt) return;
    try {
      const art = m.craftDesignArt({ name, design: { geometry } });
      const ctx = c.getContext('2d');
      const hM = Math.max(0.5, Number(art.heightM) || 2);
      const wM = Math.max(0.5, Number(art.widthM) || 2);
      const k = Math.min((c.height * 0.8) / hM, (c.width * 0.9) / wM);
      const centred = ['probe', 'module', 'rover'].includes(art.template);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.translate(c.width / 2, centred ? c.height / 2 : c.height * 0.88);
      m.paintCraft(ctx, art, { pxPerM: k, mode: 'flight', legs: 1, arrays: 1 });
      ctx.restore();
    } catch (e) { console.warn('estaleiro: desenho', e); }
  });
  return c;
}

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
  const root = h('div', { class: 'view-pad hg' });
  container.appendChild(root);
  const un = q(store, 'craft/unlocked', null);
  const head = () => viewHead('Estaleiro', { lead: 'Projetista de espaçonaves' });
  if (!un) { root.append(head(), emptyState('O Estaleiro ainda não está ligado nesta versão do jogo.', 'chave')); return; }
  if (!un.loaded) { root.append(head(), emptyState('O catálogo de peças de naves não carregou. Recarregue o jogo.', 'alerta')); return; }
  if (!un.ok) { root.append(head(), emptyState(`O Estaleiro abre em ${un.fromYear}.`, 'cadeado')); return; }
  if (sub === 'novo') return renderRoles(root, store);
  if (sub === 'catalogo') return renderCatalog(root, store);
  if (sub.startsWith('d/')) return renderEditor(root, store, sub.slice(2));
  return renderList(root, store);
}

// ------------------------------------------------------------------ list

/** Test campaign progress of a design (list and editor). */
export function testProgress(d) {
  const p = d?.program;
  if (p?.phase !== 'testFlights') return null;
  const need = Math.max(1, p.needFlights || 1);
  const ok = Math.min(need, p.testOk || 0);
  const m = d.testMission;
  const st = !m ? 'o próximo voo de demonstração entra em Missões' : m.status === 'planning' ? 'voo de teste aguardando foguete e data em Missões' : 'voo de teste agendado';
  return { frac: ok / need, ok, need, text: `Voos de teste ${ok}/${need} · ${st}` };
}

function designRow(store, d) {
  const der = d.derived || {};
  const box = h('span', { class: 'hg-mini', style: { width: '48px', height: '48px', flex: '0 0 48px' } });
  box.appendChild(craftCanvas(d.name, der.geometry, 46, 46));
  const pr = d.program?.phase === 'work' ? (() => {
    const p = d.program; const turn = store.state.turn;
    const span = Math.max(1, (p.readyTurn ?? turn) - (p.startedTurn ?? turn));
    return { frac: Math.min(1, Math.max(0, (turn - (p.startedTurn ?? turn)) / span)), text: `Pronta em ${fmtWeeks((p.readyTurn ?? turn) - turn)}` };
  })() : d.program?.phase === 'testFlights' ? testProgress(d) : null;
  return h('button', { class: 'hg-card hg-design tappable', type: 'button', onclick: () => nav(store, `d/${d.id}`), 'aria-label': `${d.name}, ${d.status?.label}` },
    box,
    h('span', { class: 'hg-txt' },
      h('span', { class: 'hg-name' }, h('b', null, d.name)),
      h('span', { class: 'hg-toggles' }, chip(d.status?.label || 'Projeto', STATUS_KIND[d.status?.id] || 'muted'), chip(der.roleLabel || d.role, 'muted'), chip(fmtT(der.massT), 'muted'), chip(fmtMoney(der.costM), 'muted')),
      h('span', { class: 'hg-sub' }, d.fitCount ? `Serve para ${d.fitCount} destino${d.fitCount === 1 ? '' : 's'}` : 'Ainda não serve para nenhum destino'),
      pr ? h('span', { class: 'hg-sub' }, pr.text) : null,
      pr ? h('span', { class: 'hg-prog' }, h('i', { style: { width: `${Math.round(pr.frac * 100)}%` } })) : null),
    icon('avancar', 16, 'pn-chev'));
}

function renderList(root, store) {
  const st = store.state;
  const list = q(store, 'craft/list', []);
  const info = q(store, 'craft/catalogInfo', {}) || {};
  const me = st.actors?.[st.playerId] || {};
  root.append(viewHead('Estaleiro', { lead: `Naves de ${me.short || me.name || 'sua agência'}: satélites, sondas, pousadores, rovers, cápsulas e módulos sob medida` }));
  root.append(h('div', { class: 'hg-actions' },
    button('Nova nave do zero', () => nav(store, 'novo'), { kind: 'primary', big: true, icon: 'mais' }),
    button('Partir de uma nave do catálogo', () => nav(store, 'catalogo'), { big: true, icon: 'transferir' })));
  root.append(sectionTitle('Seus projetos', h('span', { class: 'pn-count' }, `${list.length}/${info.maxLive || 12}`)));
  if (!list.length) root.append(emptyState('Nenhuma nave ainda. Escolha a função (satélite, sonda, pousador…) e o Estaleiro monta um primeiro rascunho com as peças que você tem.', 'satelite'));
  else for (const d of list) root.append(designRow(store, d));
  root.append(h('p', { class: 'aviso' }, icon('info', 16), h('span', null, 'Uma nave sob medida custa menos para o seu trabalho, mas passa por desenvolvimento e começa menos confiável que as do catálogo: a confiança amadurece a cada voo (ou com testes de qualificação).')));
}

// ------------------------------------------------------------------ roles (new from scratch)

function renderRoles(root, store) {
  const roles = q(store, 'craft/roles', []);
  root.append(h('div', { class: 'hg-head' }, button('Estaleiro', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })),
    viewHead('Nova nave', { lead: 'Escolha a função: o Estaleiro monta um rascunho que já serve para o destino típico, com as peças de hoje. Depois é só ajustar.' }));
  const grid = h('div', { class: 'hg-tpl-grid' });
  for (const r of roles) {
    if (!r.ok) {
      grid.append(h('div', { class: 'hg-card hg-design hg-locked' },
        h('span', { class: 'hg-mini', style: { width: '44px', height: '44px', flex: '0 0 44px' } }, icon(ROLE_ICON[r.id] || 'satelite', 22)),
        h('span', { class: 'hg-txt' }, h('b', null, r.label), h('span', { class: 'hg-sub' }, r.desc),
          h('span', { class: 'hg-lock-reason' }, icon('cadeado', 14), ' ', r.reason || 'Bloqueado'),
          r.nextBus && r.reason !== r.nextBus.reason ? h('span', { class: 'hg-lock-why' }, `${r.nextBus.name}: ${r.nextBus.reason}`) : null,
          r.nodeId ? h('span', { class: 'hg-lock-how' }, button('Abrir a pesquisa', () => goResearch(r.nodeId), { kind: 'ghost', small: true, icon: 'pesquisa' })) : null)));
      continue;
    }
    grid.append(h('button', {
      class: 'hg-card hg-design tappable', type: 'button',
      onclick: () => {
        const res = store.dispatch({ type: 'craft/new', role: r.id, crew: r.id === 'capsule' ? 1 : 0 });
        if (result(res, 'Rascunho criado')) nav(store, `d/${res.designId}`);
      },
    }, h('span', { class: 'hg-mini', style: { width: '44px', height: '44px', flex: '0 0 44px' } }, icon(ROLE_ICON[r.id] || 'satelite', 22)),
    h('span', { class: 'hg-txt' }, h('b', null, r.label), h('span', { class: 'hg-sub' }, r.desc)),
    icon('avancar', 16, 'pn-chev')));
  }
  root.append(grid);
}

// ------------------------------------------------------------------ from a catalog craft

function renderCatalog(root, store) {
  const list = q(store, 'craft/catalogTemplates', []);
  const info = q(store, 'craft/catalogInfo', {}) || {};
  const roleLabel = Object.fromEntries((info.roles || []).map((r) => [r.id, r.label]));
  root.append(h('div', { class: 'hg-head' }, button('Estaleiro', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })),
    viewHead('Partir do catálogo', { lead: 'Use uma nave que você já pode comprar como modelo: o Estaleiro copia a função, o porte e a carga útil. Mexendo pouco, o desenvolvimento sai mais barato.' }));
  if (!list.length) { root.append(emptyState('Nenhuma nave do catálogo disponível para você agora.', 'cadeado')); return; }
  for (const role of (info.roles || []).map((r) => r.id)) {
    const rows = list.filter((x) => x.role === role);
    if (!rows.length) continue;
    root.append(sectionTitle(roleLabel[role] || role, h('span', { class: 'pn-count' }, String(rows.length))));
    const box = h('div', { class: 'pn-list' });
    for (const s of rows) {
      box.append(listRow({
        lead: icon(ROLE_ICON[role] || 'satelite', 18), title: s.name, meta: fmtMoney(s.costM),
        sub: `${fmtT(s.massT)}${s.crew ? ` · ${s.crew} lugares` : ''}${s.generic ? ' · genérica' : ''}${s.roleOk ? '' : ' · função ainda não pesquisada'}`,
        cls: s.roleOk ? null : 'hg-locked',
        onClick: s.roleOk ? () => {
          const res = store.dispatch({ type: 'craft/new', fromCraftId: s.craftId });
          if (result(res, 'Projeto criado a partir do catálogo')) nav(store, `d/${res.designId}`);
        } : null,
      }));
    }
    root.append(box);
  }
}

// ------------------------------------------------------------------ editor

function getDraft(store, d) {
  const key = draftKey(store.state, `craft:${d.id}`);
  let dr = drafts.get(key);
  if (!dr || !sameJSON(dr.base, d.spec) || dr.baseName !== d.name) {
    dr = { spec: clone(d.spec), name: d.name, base: clone(d.spec), baseName: d.name, destId: dr?.destId || null };
    drafts.set(key, dr);
  }
  return dr;
}

function renderEditor(root, store, id) {
  const d = q(store, 'craft/get', null, id);
  if (!d) { root.append(viewHead('Estaleiro'), emptyState('Projeto não encontrado.', 'alerta'), button('Voltar ao Estaleiro', () => nav(store), { big: true, icon: 'voltar' })); return; }
  const info = q(store, 'craft/catalogInfo', {}) || {};
  const dr = getDraft(store, d);
  const editable = d.program?.phase !== 'work';
  const hwLocked = d.program?.phase === 'testFlights'; // in test only the name and the looks change
  const roleRow = (info.roles || []).find((r) => r.id === d.role) || {};
  if (!dr.destId) dr.destId = d.targetId || roleRow.target || null;

  const redraw = () => {
    const view = root.parentElement?.parentElement;
    const top = view?.scrollTop;
    root.innerHTML = '';
    build();
    if (view && top != null) view.scrollTop = top;
  };
  const preview = (spec, destId = dr.destId) => q(store, 'craft/preview', null, { designId: d.id, spec, destId });
  const set = (fn) => { if (!editable) return; const s = clone(dr.spec); fn(s); dr.spec = s; redraw(); };
  const partsAll = q(store, 'craft/parts', [], { role: d.role });
  const byId = Object.fromEntries(partsAll.map((p) => [p.part.id, p]));

  function build() {
    const pv = preview(dr.spec);
    const saved = preview(dr.base);
    const der = pv?.derived || {};
    const sder = saved?.derived || {};
    const dirty = !sameJSON(dr.spec, dr.base) || dr.name !== d.name;
    if (!dr.destId || !(pv?.fits || []).some((f) => f.id === dr.destId)) dr.destId = (pv?.fits || []).find((f) => f.ok)?.id || roleRow.target || null;
    const target = dr.destId ? (pv?.fits || []).find((f) => f.id === dr.destId) || pv?.target : null;

    root.append(h('div', { class: 'hg-head' }, button('Estaleiro', () => nav(store), { kind: 'ghost', icon: 'voltar', small: true })));
    // ---- preview + identity
    const pre = h('div', { class: 'hg-pre es-pre' }, h('span', { class: 'hg-h' }, `${fmtT(der.massT)}`));
    pre.appendChild(craftCanvas(dr.name, der.geometry, 110, 196));
    const nameRow = h('div', { class: 'hg-name' }, h('b', null, dr.name),
      editable ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Renomear', onclick: () => renameSheet() }, icon('editar', 18)) : null);
    root.append(h('section', { class: 'hg-card' },
      h('div', { class: 'hg-top' }, pre,
        h('div', { class: 'hg-side' }, nameRow,
          h('div', { class: 'hg-toggles' }, chip(d.status?.label || 'Projeto', STATUS_KIND[d.status?.id] || 'muted'), chip(roleRow.label || d.role, 'muted'), d.origin === 'catalog' ? chip('Do catálogo', 'muted') : d.origin === 'revision' ? chip('Revisão', 'muted') : null),
          kv('Massa total', fmtT(der.massT)),
          kv('Propelente', der.maxPropT > 0 ? `${fmtT(der.propT)} de ${fmtT(der.maxPropT)}` : '—'),
          kv('Δv próprio', der.dv > 0 ? fmtDv(der.dv) : '—'),
          kv('Energia', `${fmtW(der.powerW)} · usa ${fmtW(der.useW)}`),
          kv('Antena', der.comms >= 0 ? `até ${(info.commsLabels || [])[der.comms] || '?'}` : 'nenhuma'),
          kv('Encaixes', `${der.nParts ?? 0}/${der.slots ?? 0}`)))));
    // ---- live numbers
    const dCost = dirty ? (der.costM ?? 0) - (sder.costM ?? 0) : 0;
    const relTxt = d.program?.phase === 'operational' || d.program?.phase === 'testFlights' ? fmtRel(d.reliability?.mean ?? 0) : fmtRel(pv?.firstFlightRel ?? 0);
    const pc = pv?.costs;
    root.append(h('section', { class: 'hg-card', 'aria-label': 'Números do projeto' },
      h('div', { class: 'hg-tiles' },
        tile('Custo por unidade', fmtMoney(der.costM ?? 0), dCost ? fmtDelta(dCost, 'money') : `${fmtMoney((der.costM ?? 0) / Math.max(0.01, der.massT || 1))}/t`),
        tile('Confiança', relTxt, d.program?.phase === 'testFlights' ? `${d.program.testOk || 0}/${d.program.needFlights || 1} voos de teste · madura ${fmtRel(der.inherent ?? 0)}` : d.program?.phase === 'operational' ? `${d.stats?.flights || 0} voo(s) · madura em ${fmtRel(der.inherent ?? 0)}` : `no 1º voo · madura ${fmtRel(der.inherent ?? 0)}`),
        tile('Vida útil', fmtLife(target?.lifeYears ?? der.lifeYears), target ? `em ${target.short || target.name}` : 'da estrutura'),
        tile('Ciência por ano', fmtNum(target?.scienceYr ?? der.scienceYr ?? 0, 1), der.sub ? `subtipo ${der.sub}` : der.crew ? `${der.crew} tripulante(s)` : der.cargoT > 0 ? `carga ${fmtT(der.cargoT)}` : ''),
        devTile(pv, pc),
        tile('Leva', der.crew ? `${der.crew} pessoa(s)` : der.cargoT > 0 ? fmtT(der.cargoT) : '—', der.crew ? `suporte de vida ${der.lsDays} dias` : der.cargoT > 0 ? 'de carga' : 'sem carga nem tripulação'))));
    // ---- target destination and why it cannot fly there
    root.append(targetCard(pv, target));
    // ---- problems
    const probs = [...(pv?.errors || []), ...(pv?.locked || []).map((l) => `${l.name}: ${l.reason}`)];
    if (probs.length || pv?.warnings?.length) {
      root.append(h('div', { class: 'hg-err' },
        probs.map((t) => h('p', { class: 'aviso bad' }, icon('alerta', 16), h('span', null, t))),
        (pv?.warnings || []).map((t) => h('p', { class: 'aviso warn' }, icon('info', 16), h('span', null, t)))));
    }
    if (!editable) root.append(h('p', { class: 'aviso' }, icon('cadeado', 16), h('span', null, 'Em desenvolvimento: o projeto fica travado. Quando estiver pronta, editar cria uma revisão.')));
    // ---- structure and looks
    root.append(sectionTitle('Estrutura e aparência'));
    root.append(structureCard(der));
    // ---- part groups
    for (const g of info.groups || []) {
      const card = groupCard(g, der);
      if (card) root.append(card);
    }
    if (!d.program) {
      root.append(button('Descartar projeto', async () => {
        if (!await confirmDialog(`Descartar a ${d.name}?`, { title: 'Descartar', okLabel: 'Descartar', danger: true })) return;
        if (result(store.dispatch({ type: 'craft/retire', designId: d.id }), 'Projeto descartado')) nav(store);
      }, { kind: 'ghost', small: true }));
      const bl = blockers(pv);
      if (bl.reasons.length || bl.missing.length) {
        root.append(h('section', { class: 'hg-block', role: 'alert' },
          h('b', { class: 'hg-block-title' }, icon('alerta', 16), ' Ainda não dá para desenvolver'),
          bl.reasons.length ? h('ul', { class: 'hg-block-list' }, bl.reasons.map((t) => h('li', null, t))) : null,
          bl.missing.length ? h('div', null, h('span', { class: 'hg-block-sub' }, 'Sistemas obrigatórios que faltam:'), h('ul', { class: 'hg-block-list' }, bl.missing.map((t) => h('li', null, t)))) : null));
      }
    }
    root.append(actionBar(pv, dirty));
  }

  /** Real state of the program (not the preview's cost): a dirty revision shows the revision's own cost. */
  function devTile(pv, pc) {
    const p = d.program;
    if (pv?.revision) return tile('Revisão', pc ? fmtMoney(pc.devCostM) : '—', pc ? `${fmtWeeks(pc.devWeeks)} · ${pc.needFlights || 0} voo(s) de teste` : '');
    if (p?.phase === 'work') return tile('Desenvolvimento', fmtMoney(p.devCostM), `pago ${fmtMoney(p.paidM || 0)} · pronta em ${fmtWeeks((p.readyTurn ?? 0) - store.state.turn)}`);
    if (p?.phase === 'testFlights') { const t = testProgress(d); return tile('Voos de teste', `${t.ok}/${t.need}`, `desenvolvimento pago: ${fmtMoney(p.paidM || p.devCostM || 0)}`); }
    if (p?.phase === 'operational') return tile('Desenvolvimento', 'Pronta', `pago ${fmtMoney(p.paidM || p.devCostM || 0)}${p.needFlights ? ` · ${p.needFlights} voo(s) de teste` : ''}`);
    return tile('Desenvolvimento', pc ? fmtMoney(pc.devCostM) : '—', pc ? `${fmtWeeks(pc.devWeeks)} · ${pc.needFlights || 0} voo(s) de teste` : '');
  }

  function blockers(pv) {
    const reasons = [...(pv?.errors || []), ...(pv?.locked || []).map((l) => `${l.name}: ${l.reason}`)];
    if (pv?.ok && !pv.fitCount) reasons.push('A nave ainda não serve para nenhum destino aberto hoje (veja "Por que não serve").');
    return { reasons, missing: pv?.missing || [] };
  }

  function kv(a, b) { return h('div', { class: 'hg-kv' }, h('span', null, a), h('span', null, b)); }
  function tile(label, value, subTxt) { return h('div', { class: 'hg-tile' }, h('span', { class: 'hg-eyebrow' }, label), h('b', null, value), subTxt ? h('span', { class: 'hg-sub' }, subTxt) : null); }
  function stepper(value, min, max, onChange, label, txt = String(value)) {
    return h('span', { class: 'hg-step', role: 'group', 'aria-label': label },
      h('button', { type: 'button', 'aria-label': `Menos ${label}`, disabled: !editable || hwLocked || value <= min + 1e-9, onclick: () => onChange(-1) }, icon('menos', 18)),
      h('output', null, txt),
      h('button', { type: 'button', 'aria-label': `Mais ${label}`, disabled: !editable || hwLocked || value >= max - 1e-9, onclick: () => onChange(1) }, icon('mais', 18)));
  }

  function targetCard(pv, target) {
    const fits = pv?.fits || [];
    const ok = fits.filter((f) => f.ok);
    const card = h('section', { class: 'hg-card es-tgt' }, h('header', null, h('span', { class: 'hg-t' }, 'Destino e missões'), h('span', { class: 'hg-sub' }, `serve para ${ok.length} de ${fits.length}`)));
    card.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-lbl' }, h('span', null, 'Destino-alvo'), h('span', { class: 'hg-sub' }, 'Teste a nave contra um lugar')),
      h('button', { class: 'hg-pick', type: 'button', style: { width: '58%' }, onclick: () => destSheet(fits) }, h('span', null, target?.name || 'Escolher'), icon('avancar', 16))));
    if (target) {
      if (target.ok) {
        card.append(h('p', { class: 'es-ok' }, h('b', null, `Serve para ${target.name}. `), `Δv pedido ${fmtDv(target.needDv)} · vida ${fmtLife(target.lifeYears)} · ciência ${fmtNum(target.scienceYr, 1)}/ano${target.companion ? ' · pousa com um módulo de pouso tripulado separado' : ''}.`,
          ...(target.warnings || []).map((w) => h('span', { style: { display: 'block', marginTop: '4px', color: 'var(--amber, var(--yellow))' } }, w))));
      } else {
        const tips = [...new Set((target.reasons || []).map((r) => r.tip).filter(Boolean))];
        card.append(h('section', { class: 'hg-block', role: 'alert', style: { margin: '0' } },
          h('b', { class: 'hg-block-title' }, icon('alerta', 16), ` Por que não serve para ${target.name}`),
          h('ul', { class: 'hg-block-list' }, (target.reasons || []).map((r) => h('li', null, r.text))),
          tips.length ? h('div', { class: 'hg-block-tip' }, h('span', { class: 'hg-block-sub' }, 'Como resolver:'), h('ul', { class: 'hg-block-list' }, tips.map((t) => h('li', null, t)))) : null));
      }
    }
    if (ok.length) {
      const shown = ok.slice(0, 8);
      const shortN = {};
      for (const f of ok) shortN[f.short || f.name] = (shortN[f.short || f.name] || 0) + 1;
      card.append(h('span', { class: 'hg-eyebrow' }, 'Serve para'),
        h('div', { class: 'es-dests' }, shown.map((f) => chip(shortN[f.short || f.name] > 1 ? f.name : (f.short || f.name), f.id === dr.destId ? 'good' : 'muted', { onclick: () => { dr.destId = f.id; redraw(); } })), ok.length > shown.length ? chip(`+${ok.length - shown.length}`, 'muted', { onclick: () => destSheet(fits) }) : null));
    }
    const types = pv?.types || [];
    if (types.length) {
      card.append(h('span', { class: 'hg-eyebrow' }, 'Missões que pode fazer'),
        h('div', { class: 'es-types' }, types.map((t) => h('span', null, h('b', null, t.label), t.subs.length ? `: ${t.subs.map((s) => s.label).join(', ')}` : ''))));
    }
    return card;
  }

  function structureCard(der) {
    const s = dr.spec;
    const bus = byId[s.busId]?.part;
    const card = h('section', { class: 'hg-card' });
    card.append(h('div', { class: 'hg-row' }, h('span', { class: 'hg-lbl' }, h('span', null, 'Estrutura'), h('span', { class: 'hg-sub hg-mono' }, bus ? `${fmtT(bus.massT)} · ${bus.slots} encaixes · vida ${fmtLife(bus.lifeYears)}` : '')),
      h('button', { class: 'hg-pick', type: 'button', disabled: !editable || hwLocked, style: { width: '58%' }, onclick: () => busSheet() }, h('span', null, bus?.name || 'Escolher'), icon('avancar', 16))));
    const chipsRow = (label, list, cur, key) => {
      const row = h('div', { class: 'hg-chips', role: 'group', 'aria-label': label });
      for (const o of list) row.append(h('button', { type: 'button', 'aria-pressed': o.id === cur ? 'true' : 'false', disabled: !editable, onclick: () => set((x) => { x[key] = o.id; }) }, o.label));
      return [h('span', { class: 'hg-eyebrow' }, label), row];
    };
    const shapes = (info.shapes || []).filter((x) => !bus?.shapes || bus.shapes.includes(x.id));
    if (shapes.length > 1) card.append(...chipsRow('Formato do corpo', shapes, der.geometry?.shape || s.shape, 'shape'));
    card.append(...chipsRow('Acabamento', info.finishes || [], s.finish, 'finish'));
    if ((der.solarW || 0) > 0) card.append(...chipsRow('Painéis solares', info.placements?.arrays || [], s.arrays, 'arrays'));
    if (der.geometry?.hgaD > 0.3 && ['satellite', 'probe'].includes(d.role)) card.append(...chipsRow('Antena', info.placements?.antenna || [], s.antenna, 'antenna'));
    return card;
  }

  function partSub(p) {
    const bits = [];
    if (p.massFrac) bits.push(`${Math.round(p.massFrac * 100)}% da massa`); else bits.push(fmtT(p.massT));
    bits.push(fmtMoney(p.costM));
    if (p.solarW) bits.push(`${fmtW(p.solarW)} a 1 UA`);
    if (p.rtgW) bits.push(fmtW(p.rtgW));
    if (p.genW) bits.push(fmtW(p.genW));
    if (p.range != null) bits.push(`até ${(info.commsLabels || [])[p.range] || ''}`);
    if (p.isp) bits.push(`Isp ${p.isp} s · ${p.thrustKN >= 1 ? `${fmtNum(p.thrustKN, 1)} kN` : `${Math.round(p.thrustKN * 1000)} N`}`);
    if (p.scienceYr) bits.push(`ciência ${fmtNum(p.scienceYr, 1)}/ano`);
    if (p.shield) bits.push(`escudo ${p.shield}`);
    if (p.lsDays) bits.push(`${p.lsDays} dias`);
    if (p.cargoT) bits.push(`${fmtT(p.cargoT)} de carga`);
    if (p.powerW) bits.push(`usa ${fmtW(p.powerW)}`);
    return bits.join(' · ');
  }

  function groupCard(g, der) {
    const kinds = new Set(g.kinds || []);
    const avail = partsAll.filter((p) => kinds.has(p.part.kind) && !p.role);
    if (!avail.length) return null;
    const have = Object.entries(dr.spec.parts || {}).filter(([id]) => kinds.has(byId[id]?.part?.kind));
    const card = h('section', { class: 'hg-card' }, h('header', null, h('span', { class: 'hg-t' }, g.label), h('span', { class: 'hg-sub hg-mono' }, have.length ? `${have.reduce((a, [, n]) => a + n, 0)} peça(s)` : 'nenhuma')));
    const list = h('div', { class: 'es-parts' });
    for (const [pid, n] of have) {
      const p = byId[pid]?.part;
      if (!p) continue;
      list.append(h('div', { class: 'es-part' },
        h('span', { class: 'hg-lbl' }, h('span', null, p.name), h('span', { class: 'hg-sub hg-mono' }, partSub(p))),
        stepper(n, 0, p.max ?? 4, (dv) => set((x) => { const v = (x.parts[pid] || 0) + dv; if (v <= 0) delete x.parts[pid]; else x.parts[pid] = v; }), p.name)));
    }
    if (g.id === 'engine' && (der.maxPropT || 0) > 0) {
      const step = der.maxPropT <= 0.02 ? 0.001 : der.maxPropT <= 0.5 ? 0.005 : der.maxPropT <= 3 ? 0.05 : 0.25;
      list.append(h('div', { class: 'es-part' },
        h('span', { class: 'hg-lbl' }, h('span', null, 'Propelente'), h('span', { class: 'hg-sub hg-mono' }, `Δv ${fmtDv(der.dv)}${der.cargoT > 0 ? ' com carga cheia' : ''} · máx. ${fmtT(der.maxPropT)}`)),
        stepper(dr.spec.propT || 0, 0, der.maxPropT, (dv) => set((x) => { x.propT = Math.max(0, Math.min(der.maxPropT, Math.round(((x.propT || 0) + dv * step) / step) * step)); }), 'propelente', fmtT(dr.spec.propT || 0))));
    }
    if (list.childNodes.length) card.append(list);
    if (editable && !hwLocked) card.append(button(`Acrescentar · ${g.label.toLowerCase()}`, () => addSheet(g), { small: true, icon: 'mais' }));
    return card;
  }

  // ---- sheets
  function deltaLine(base, spec) {
    const p = preview(spec);
    if (!p?.derived?.ok) return h('span', { class: 'hg-o3' }, h('span', { class: 'down' }, p?.errors?.[0] || 'Não funciona assim'));
    const b = base?.derived || {};
    const n = p.derived;
    const part = (txt, v, good) => (txt ? h('span', { class: Math.abs(v) < 1e-9 ? 'flat' : (good ? 'up' : 'down') }, txt) : null);
    const dm = (n.massT ?? 0) - (b.massT ?? 0);
    const dc = (n.costM ?? 0) - (b.costM ?? 0);
    const df = (p.fitCount ?? 0) - (base?.fitCount ?? 0);
    const items = [
      part(fmtDelta(dm), dm, dm < 0),
      part(fmtDelta(dc, 'money'), dc, dc < 0),
      df ? part(`${df > 0 ? '+' : '−'}${Math.abs(df)} destino(s)`, df, df > 0) : null,
    ].filter(Boolean);
    return h('span', { class: 'hg-o3' }, items.length ? items : h('span', { class: 'flat' }, 'sem mudança nos números'));
  }

  function optionsSheet(title, options, { note } = {}) {
    openModal((close) => h('div', { class: 'hg-sheet' },
      note ? h('p', { class: 'hg-sub', style: { margin: '0 0 8px' } }, note) : null,
      h('div', { class: 'hg-sheet-list' }, options.map((o) => h('button', {
        class: 'hg-opt', type: 'button', disabled: !!o.disabled, 'aria-current': o.current ? 'true' : 'false',
        onclick: () => { close(); o.onPick(); },
      }, h('span', { class: 'hg-o1' }, h('span', null, o.title), o.right ? h('span', { class: 'hg-mono' }, o.right) : null),
      o.sub ? h('span', { class: 'hg-o2' }, o.sub) : null, o.delta || null)))), { title });
  }

  function addSheet(g) {
    const kinds = new Set(g.kinds || []);
    const base = preview(dr.spec);
    const list = partsAll.filter((p) => kinds.has(p.part.kind) && !p.role);
    const options = list.filter((p) => p.ok).map((p) => {
      const spec = clone(dr.spec);
      spec.parts[p.part.id] = (spec.parts[p.part.id] || 0) + 1;
      return { title: p.part.name, right: dr.spec.parts[p.part.id] ? `×${dr.spec.parts[p.part.id]}` : '', sub: partSub(p.part), delta: deltaLine(base, spec), onPick: () => set((x) => { x.parts[p.part.id] = (x.parts[p.part.id] || 0) + 1; }) };
    });
    for (const p of list.filter((x) => !x.ok && x.reason !== 'Fora de produção').slice(0, 8)) options.push(lockedOption(p, ''));
    if (!options.length) options.push({ title: 'Nenhuma peça disponível', disabled: true, onPick: () => {} });
    optionsSheet(g.label, options, { note: 'Variação comparada ao projeto atual.' });
  }

  function busSheet() {
    const base = preview(dr.spec);
    const buses = partsAll.filter((p) => p.part.kind === 'bus' && (p.part.roles || []).includes(d.role));
    const options = buses.filter((p) => p.ok).map((p) => {
      const spec = clone(dr.spec);
      spec.busId = p.part.id;
      spec.propT = Math.min(spec.propT || 0, p.part.maxPropT || 0);
      return { title: p.part.name, current: p.part.id === dr.spec.busId, sub: `${fmtT(p.part.massT)} · ${p.part.slots} encaixes · vida ${fmtLife(p.part.lifeYears)} · ${fmtMoney(p.part.costM)}${p.part.crewMax ? ` · até ${p.part.crewMax} pessoas` : ''}`,
        delta: p.part.id === dr.spec.busId ? null : deltaLine(base, spec), onPick: () => set((x) => { x.busId = spec.busId; x.propT = spec.propT; }) };
    });
    for (const p of buses.filter((x) => !x.ok && x.reason !== 'Fora de produção').slice(0, 6)) options.push(lockedOption(p));
    optionsSheet('Estrutura', options);
  }

  function destSheet(fits) {
    const sorted = fits.slice().sort((a, b) => (b.ok - a.ok) || String(a.name).localeCompare(String(b.name)));
    optionsSheet('Destino-alvo', sorted.slice(0, 80).map((f) => ({
      title: f.name, right: f.ok ? 'serve' : '', current: f.id === dr.destId,
      sub: `${KIND_LABEL[f.kind] || f.kind}${f.ok ? ` · vida ${fmtLife(f.lifeYears)}` : ` · ${f.reasons?.[0]?.text || 'não serve'}`}`,
      onPick: () => { dr.destId = f.id; redraw(); },
    })), { note: 'Os que servem primeiro. Escolher um destino não muda a nave: só mostra se ela serve e por quê.' });
  }

  function renameSheet() {
    const input = h('input', { class: 'hg-input', type: 'text', maxlength: '28', value: dr.name, 'aria-label': 'Nome da nave' });
    openModal((close) => h('div', { class: 'hg-sheet' }, input,
      h('div', { class: 'btn-row', style: { marginTop: '12px' } },
        button('Cancelar', () => close(), { big: true }),
        button('Usar este nome', () => { const v = input.value.trim(); if (v) dr.name = v.slice(0, 28); close(); redraw(); }, { kind: 'primary', big: true }))), { title: 'Nome da nave' });
    setTimeout(() => input.focus(), 60);
  }

  function actionBar(pv, dirty) {
    const bar = h('div', { class: 'hg-bar-act' });
    const phase = d.program?.phase || null;
    const save = () => {
      const res = store.dispatch({ type: 'craft/save', designId: d.id, draft: { ...dr.spec, name: dr.name } });
      if (!result(res, res?.revision ? 'Revisão criada' : 'Projeto salvo')) return null;
      drafts.delete(draftKey(store.state, `craft:${d.id}`));
      if (res.designId !== d.id) nav(store, `d/${res.designId}`);
      return res;
    };
    if (!phase) {
      const pc = pv?.costs;
      const row = h('div', { class: ['hg-bar-row', dirty && 'two'] });
      bar.append(row);
      if (dirty) row.append(button('Salvar', () => save(), { big: true, icon: 'salvar', disabled: !pv?.ok }));
      row.append(button(pc ? `Desenvolver · ${fmtMoney(pc.upfrontM)}` : 'Desenvolver', async () => {
        if (dirty && !save()) return;
        const p2 = q(store, 'craft/preview', null, { designId: d.id, spec: dr.spec });
        const c = p2?.costs || pc;
        if (!c) return;
        const ok = await confirmDialog(`Desenvolver a ${dr.name}: ${fmtMoney(c.devCostM)} no total (${fmtMoney(c.upfrontM)} agora, o resto aos poucos), cerca de ${fmtWeeks(c.devWeeks)}. Cada unidade custa ${fmtMoney(p2?.derived?.costM ?? 0)}.`, { title: 'Começar o desenvolvimento', okLabel: 'Desenvolver' });
        if (!ok) return;
        result(store.dispatch({ type: 'craft/develop', designId: d.id }), 'Desenvolvimento iniciado');
      }, { kind: 'primary', big: true, icon: 'chave', disabled: !pv?.ready || !pv?.fitCount }));
    } else if (phase === 'work') {
      const p = d.program;
      bar.append(h('p', { class: 'hg-note' }, `${p.paused ? 'Parado por falta de caixa. ' : ''}Pronta em ${fmtWeeks((p.readyTurn ?? 0) - store.state.turn)} · pago ${fmtMoney(p.paidM || 0)} de ${fmtMoney(p.devCostM)}`));
      bar.append(button('Cancelar desenvolvimento', async () => {
        if (!await confirmDialog('Cancelar o desenvolvimento? O que já foi gasto não volta.', { title: 'Cancelar', okLabel: 'Cancelar desenvolvimento', danger: true, cancelLabel: 'Continuar' })) return;
        result(store.dispatch({ type: 'craft/cancel', designId: d.id }), 'Desenvolvimento cancelado');
      }, { kind: 'danger', big: true }));
    } else if (phase === 'testFlights') {
      const t = testProgress(d);
      if (dirty) bar.append(button('Salvar nome e aparência', () => save(), { big: true, icon: 'salvar', disabled: !pv?.ok }));
      const row = h('div', { class: 'hg-bar-row two' });
      row.append(button('Qualificar', () => result(store.dispatch({ type: 'craft/qualify', designId: d.id }), 'Testes de qualificação marcados'), { big: true, icon: 'check', disabled: d.qual?.untilTurn != null || (d.gap ?? 0) < 0.01 }));
      row.append(button(d.testMission ? (d.testMission.status === 'planning' ? 'Agendar o voo de teste' : 'Ver o voo de teste') : 'Voos de teste em Missões', () => store.ui?.navigate?.('missoes', d.testMission ? `m/${d.testMission.id}` : 'lista'), { kind: 'primary', big: true, icon: 'missoes' }));
      bar.append(row, h('p', { class: 'hg-note' }, `${t.text}. Cada voo bom aumenta a confiança; a qualificação em solo é um extra opcional.`));
    } else if (dirty) {
      const rev = !sameJSON({ ...dr.spec, shape: 0, finish: 0, arrays: 0, antenna: 0 }, { ...dr.base, shape: 0, finish: 0, arrays: 0, antenna: 0 });
      bar.append(button(rev ? 'Salvar como revisão' : 'Salvar nome e aparência', () => save(), { kind: 'primary', big: true, icon: 'salvar', disabled: !pv?.ok }));
      if (rev && pv?.costs) bar.append(h('p', { class: 'hg-note' }, `Revisão: ${fmtMoney(pv.costs.devCostM)} · ${fmtWeeks(pv.costs.devWeeks)}`));
    } else {
      const row = h('div', { class: 'hg-bar-row two' });
      row.append(button('Qualificar', () => result(store.dispatch({ type: 'craft/qualify', designId: d.id }), 'Testes de qualificação marcados'), { big: true, icon: 'check', disabled: d.qual?.untilTurn != null || (d.gap ?? 0) < 0.01 }));
      row.append(button('Usar numa missão', () => store.ui?.navigate?.('missoes', 'nova'), { kind: 'primary', big: true, icon: 'missoes' }));
      bar.append(row, h('p', { class: 'hg-note' }, d.qual?.untilTurn != null ? `Testes de qualificação até ${fmtWeeks(d.qual.untilTurn - store.state.turn)}` : 'Pronta: aparece na escolha de nave das missões. Editar cria uma revisão.'));
    }
    return bar;
  }

  build();
}

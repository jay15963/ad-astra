// "Fundar a sua agência" (docs/EXPANSION.md §5.3): a 4-step wizard, one decision per screen —
//   1 Tipo (agência estatal / empresa privada, with the era rule), 2 País e sede (list + world map, tap to place the
//   HQ), 3 Nome, sigla e logo (live logo editor), 4 Resumo (derived difficulty) -> "Fundar agência".
// Plus the logo editor used by the wizard and by Identidade e logo (openEmblemEditor, EXPANSION.md §5.4): live
// preview at three sizes, Sortear, shape / symbol / field pattern / details, colours limited to curated palettes.
// The UI only builds the payload; the sim validates it (lifecycle 'agency/found', 'agency/emblem').
import { h, raw, chip, button, icon, fmtMoney, toast, openModal } from './components.js';
import {
  emblemSVG, normalizeSpec, compactSpec, specFromSeed, specForActor, palettes, partOptions, useEmblemData, shade, MAX_RING_TEXT,
} from './emblem.js';
import { query as engineQuery } from '../core/engine.js';

// Founding rules live in the sim (lifecycle 'agency/*' queries are pure and need no game yet): the UI asks the engine.
const q = (data, name, ...args) => engineQuery({}, data, name, ...args);
const foundingOptions = (data, sc) => q(data, 'agency/foundingOptions', sc);
const validateFound = (data, payload, sc) => q(data, 'agency/validateFound', payload, sc);
const foundPreview = (data, value, sc) => q(data, 'agency/previewValue', value, sc);
const customIdFor = (payload, seed) => q(null, 'agency/customId', payload, seed);

// ------------------------------------------------------------------ styles (one stylesheet, linked once)

function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-found-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/found.css', import.meta.url).href;
    l.dataset.foundCss = '1';
    document.head.appendChild(l);
  } catch { /* Node */ }
}

const uiSeed = () => {
  try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch { return (Date.now() >>> 0); } // UI only
};

// ------------------------------------------------------------------ pure helpers (tested in Node)

const KIND_LABEL = { agency: 'Agência estatal', company: 'Empresa privada' };

/** Name and short suggestions for a nation and kind (deterministic from `seed`). */
export function suggestName(data, nation, kind, seed = 0) {
  const g = data?.actorGen?.grammar || {};
  const abbr = String(nation?.abbr || nation?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2) || 'X';
  if (kind === 'company') {
    const pre = (g.pre || ['Astra'])[seed % (g.pre?.length || 1)];
    const suf = (g.suf || ['Orbital'])[(seed >>> 4) % (g.suf?.length || 1)];
    const short = pre.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
    return { name: `${pre} ${suf}`, short };
  }
  const forms = [['Agência Espacial', 'AE'], ['Instituto Espacial', 'IE'], ['Agência Nacional do Espaço', 'AN']];
  const [base, s] = forms[seed % forms.length];
  return { name: `${base} ${nation?.of || ''}`.trim(), short: `${s}${abbr}`.slice(0, 6) };
}

/** Default emblem for a fresh founding: procedural from the seed, nation and kind, with the short as label. */
export function defaultEmblem(seed, { kind = 'agency', short = '', era } = {}) {
  return compactSpec(specFromSeed(`found-${seed}`, { kind: kind === 'company' ? 'company' : 'agency', label: short, era }));
}

/** The wizard model: which steps are complete and the payload 'agency/found' gets. Pure. */
export function wizardModel(data, draft) {
  const d = draft || {};
  const opts = foundingOptions(data);
  const nation = opts.nations.find((n) => n.id === d.nationId) || null;
  const payload = { name: d.name, short: d.short, kind: d.kind, nationId: d.nationId, hq: d.hq, emblem: d.emblem };
  const v = validateFound(data, payload);
  const steps = [
    { id: 'tipo', label: 'Tipo', done: d.kind === 'agency' || (d.kind === 'company' && opts.privateOk) },
    { id: 'sede', label: 'País e sede', done: !!nation && !!d.hq },
    { id: 'nome', label: 'Nome e logo', done: !!d.name && !!d.short && !!d.emblem && (v.ok || !/nome|sigla|logo/i.test(v.error || '')) },
    { id: 'resumo', label: 'Resumo', done: v.ok },
  ];
  return { opts, nation, payload, valid: v, preview: v.ok ? foundPreview(data, v.value) : null, steps };
}

// ------------------------------------------------------------------ world map (equirectangular-ish Natural Earth I)

const XMAX = Math.PI * 0.8707;
function project(lon, lat) {
  const l = (lon * Math.PI) / 180;
  const p = (Math.max(-89.9, Math.min(89.9, lat)) * Math.PI) / 180;
  const p2 = p * p, p4 = p2 * p2;
  const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
  const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
  return [x, -y];
}
const Y_TOP = project(0, 84)[1];
const Y_BOT = project(0, -58)[1];
const MAP_W = 1000;
const MAP_K = MAP_W / (2 * XMAX);
const MAP_H = Math.round((Y_BOT - Y_TOP) * MAP_K);
const toMap = (lon, lat) => { const [x, y] = project(lon, lat); return [(x + XMAX) * MAP_K, (y - Y_TOP) * MAP_K]; };
/** Inverse of toMap (bisection on latitude, then longitude from the x polynomial). */
export function fromMap(mx, my) {
  const y = my / MAP_K + Y_TOP;
  let lo = -89.9, hi = 89.9;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (project(0, mid)[1] > y) lo = mid; else hi = mid; }
  const lat = (lo + hi) / 2;
  const unit = project(1, lat)[0]; // x per degree of longitude at this latitude
  const lon = Math.max(-180, Math.min(180, (mx / MAP_K - XMAX) / unit));
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

let WORLD = null;
let WORLD_P = null;
function loadWorld() {
  if (WORLD) return Promise.resolve(WORLD);
  if (!WORLD_P) {
    WORLD_P = fetch(new URL('../../data/world.json', import.meta.url)).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((w) => {
        WORLD = (w.countries || []).map((c) => {
          let d = '';
          let bb = [Infinity, Infinity, -Infinity, -Infinity];
          for (const poly of c.polygons || []) for (const ring of poly) {
            ring.forEach(([lon, lat], i) => {
              const [x, y] = toMap(lon, lat);
              d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
              bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
            });
            d += 'Z';
          }
          return { id: c.id, name: c.name, d, bb };
        });
        return WORLD;
      }).catch((e) => { WORLD_P = null; throw e; });
  }
  return WORLD_P;
}

/** viewBox around a set of country boxes (with margin, aspect of the map frame). */
function viewFor(isos, extraPts = []) {
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of WORLD || []) {
    if (!isos.includes(c.id)) continue;
    // ignore tiny far-flung islands that would blow up the box (overseas territories)
    bb = [Math.min(bb[0], c.bb[0]), Math.min(bb[1], c.bb[1]), Math.max(bb[2], c.bb[2]), Math.max(bb[3], c.bb[3])];
  }
  for (const [x, y] of extraPts) bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
  if (!Number.isFinite(bb[0])) return [0, 0, MAP_W, MAP_H];
  const ar = 1.6;
  let w = Math.max(120, (bb[2] - bb[0]) * 1.5), hh = Math.max(75, (bb[3] - bb[1]) * 1.5);
  if (w / hh > ar) hh = w / ar; else w = hh * ar;
  w = Math.min(w, MAP_W); hh = Math.min(hh, MAP_H);
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const x = Math.max(0, Math.min(MAP_W - w, cx - w / 2)), y = Math.max(0, Math.min(MAP_H - hh, cy - hh / 2));
  return [x, y, w, hh].map((v) => Math.round(v));
}

function hqMap(nation, opts, draft, onPick) {
  const box = h('div', { class: 'fa-map' }, h('div', { class: 'fa-map-msg' }, 'Carregando o mapa-múndi…'));
  const isoToNation = new Map();
  for (const n of opts.nations) for (const iso of n.isos) if (!isoToNation.has(iso)) isoToNation.set(iso, n.id);
  const draw = () => {
    const isos = nation?.isos || [];
    const pins = (nation?.sites || []).map((s) => ({ ...s, xy: toMap(s.lon, s.lat) }));
    const cur = draft.hq && Number.isFinite(draft.hq.lat) ? toMap(draft.hq.lon, draft.hq.lat) : null;
    const vb = viewFor(isos, pins.map((p) => p.xy));
    const r = vb[2] / 90;
    const countries = WORLD.map((c) => {
      const mine = isos.includes(c.id);
      const pick = isoToNation.has(c.id);
      return `<path d="${c.d}" data-iso="${c.id}" class="${mine ? 'fa-c-mine' : pick ? 'fa-c-pick' : 'fa-c'}"/>`;
    }).join('');
    const pinSvg = pins.map((p) => {
      const sel = draft.hq?.id === p.id;
      return `<g class="fa-pin${sel ? ' sel' : ''}" data-site="${p.id}"><circle cx="${p.xy[0].toFixed(1)}" cy="${p.xy[1].toFixed(1)}" r="${(r * (sel ? 1.25 : 0.9)).toFixed(2)}"/>${p.launch ? `<circle cx="${p.xy[0].toFixed(1)}" cy="${p.xy[1].toFixed(1)}" r="${(r * 1.9).toFixed(2)}" class="fa-pin-ring"/>` : ''}</g>`;
    }).join('');
    const custom = cur && !draft.hq?.id ? `<g class="fa-pin sel"><circle cx="${cur[0].toFixed(1)}" cy="${cur[1].toFixed(1)}" r="${(r * 1.25).toFixed(2)}"/></g>` : '';
    box.innerHTML = `<svg viewBox="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mapa: toque para escolher a sede"><rect x="0" y="0" width="${MAP_W}" height="${MAP_H}" class="fa-sea"/>${countries}${pinSvg}${custom}</svg>`;
    const svg = box.querySelector('svg');
    svg.addEventListener('click', (e) => {
      const site = e.target.closest?.('[data-site]')?.getAttribute('data-site');
      if (site) { onPick({ site }); return; }
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const m = svg.getScreenCTM();
      if (!m) return;
      const p = pt.matrixTransform(m.inverse());
      const iso = e.target.getAttribute?.('data-iso') || null;
      onPick({ iso, nationId: iso ? isoToNation.get(iso) || null : null, ...fromMap(p.x, p.y) });
    });
  };
  if (WORLD) draw();
  else loadWorld().then(draw).catch(() => { box.innerHTML = ''; box.append(h('div', { class: 'fa-map-msg' }, 'Não foi possível carregar o mapa. Escolha uma das cidades abaixo.')); });
  return box;
}

// ------------------------------------------------------------------ logo editor

const SECTIONS = [
  { id: 'cores', label: 'Cores' }, { id: 'forma', label: 'Forma' }, { id: 'simbolo', label: 'Símbolo' },
  { id: 'fundo', label: 'Fundo' }, { id: 'detalhes', label: 'Detalhes' },
];

/** Thumb of a spec variation (for the option grids). */
const thumb = (spec, size = 44) => raw(emblemSVG(spec, { size, detail: 0 }), 'fa-thumb');

/**
 * Logo editor element: live preview (big, medium, header size), "Sortear", 5 control groups. Colours come only from
 * the curated palettes (plus "Inverter"). onChange(compactSpec) on every change. opts: {spec, label, kind, era}.
 */
export function logoEditor({ spec, label = '', kind = 'agency', era, onChange } = {}) {
  ensureCss();
  let cur = normalizeSpec(spec || specFromSeed(`found-${uiSeed()}`, { kind, label, era }), { label });
  if (label) cur.label = normalizeSpec({ label }).label || cur.label;
  let tab = 'cores';
  const root = h('div', { class: 'fa-editor' });
  const emit = () => { try { onChange?.(compactSpec(cur)); } catch (e) { console.error(e); } };
  const set = (patch) => { cur = normalizeSpec({ ...cur, ...patch }); draw(); emit(); };

  const preview = () => h('div', { class: 'fa-preview' },
    raw(emblemSVG(cur, { size: 132 }), 'fa-prev-big'),
    h('div', { class: 'fa-prev-side' },
      h('div', { class: 'fa-prev-row' }, raw(emblemSVG(cur, { size: 56 }), 'fa-prev-mid'), raw(emblemSVG(cur, { size: 30 }), 'fa-prev-small')),
      h('div', { class: 'fa-prev-cap' }, 'Grande, em listas e no topo'),
      button('Sortear', () => {
        const fresh = specFromSeed(`found-${uiSeed()}`, { kind, label: cur.label, era });
        cur = normalizeSpec({ ...fresh, label: cur.label, ring: fresh.ring ? { ...fresh.ring, text: cur.ring?.text || '' } : null });
        draw(); emit();
      }, { icon: 'estrela', small: true, cls: 'fa-sortear' })));

  const grid = (items, cls = '') => h('div', { class: ['fa-grid', cls] }, items);
  const opt = (selected, content, onClick, labelText) => h('button', {
    type: 'button', class: ['fa-opt', selected && 'selected'], 'aria-pressed': selected ? 'true' : 'false', 'aria-label': labelText, title: labelText, onclick: onClick,
  }, content);

  const panel = () => {
    if (tab === 'cores') {
      const pals = palettes();
      const sel = pals.find((p) => p.colors[0] === cur.field && p.colors[1] === cur.field2) || null;
      return h('div', { class: 'fa-panel' },
        grid(pals.map((p) => opt(sel?.id === p.id, h('span', { class: 'fa-swatch', 'aria-hidden': 'true' },
          h('i', { style: { background: p.colors[0] } }), h('i', { style: { background: p.colors[1] } }), h('i', { style: { background: p.colors[2] } }), h('i', { style: { background: p.colors[3] } })),
        () => set({ field: p.colors[0], field2: p.colors[1], glyphColor: p.colors[2], accent: p.colors[3], ring: cur.ring ? { ...cur.ring, color: shade(p.colors[0], -0.38) } : null }), p.name)), 'fa-grid-pal'),
        h('div', { class: 'btn-row fa-row' },
          button('Inverter cores', () => set({ field: cur.glyphColor, glyphColor: cur.field, field2: shade(cur.glyphColor, -0.18), ring: cur.ring ? { ...cur.ring, color: shade(cur.glyphColor, -0.38) } : null }), { small: true, icon: 'transferir' }),
          button('Trocar campos', () => set({ field: cur.field2, field2: cur.field }), { small: true, kind: 'ghost' })));
    }
    if (tab === 'forma') return h('div', { class: 'fa-panel' }, grid(partOptions('shapes').map((o) => opt(cur.shape === o.id, h('span', { class: 'fa-opt-in' }, thumb({ ...cur, shape: o.id }), h('small', null, o.name)), () => set({ shape: o.id }), o.name))));
    if (tab === 'simbolo') return h('div', { class: 'fa-panel' }, grid(partOptions('glyphs').map((o) => opt(cur.glyph === o.id, h('span', { class: 'fa-opt-in' }, thumb({ ...cur, glyph: o.id, orbit: 0 }), h('small', null, o.name)), () => set({ glyph: o.id }), o.name))));
    if (tab === 'fundo') return h('div', { class: 'fa-panel' }, grid(partOptions('divisions').map((o) => opt(cur.division === o.id, h('span', { class: 'fa-opt-in' }, thumb({ ...cur, division: o.id }), h('small', null, o.name)), () => set({ division: o.id }), o.name))));
    // detalhes: stars, orbits, ring/ribbon and motto
    const motto = h('input', {
      class: 'input', type: 'text', maxlength: String(MAX_RING_TEXT), value: cur.ring?.text || '', placeholder: 'Ex.: AD ASTRA', 'aria-label': 'Lema',
      oninput: (e) => { cur = normalizeSpec({ ...cur, ring: { color: cur.ring?.color || shade(cur.field, -0.38), text: e.target.value } }); refreshPreview(); emit(); },
    });
    const stepper = (labelText, value, min, max, key) => h('div', { class: 'fa-step' },
      h('span', { class: 'fa-step-label' }, labelText),
      h('div', { class: 'fa-step-ctl' },
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Menos ${labelText.toLowerCase()}`, disabled: value <= min, onclick: () => set({ [key]: value - 1 }) }, icon('menos', 16)),
        h('span', { class: 'fa-step-v' }, String(value)),
        h('button', { type: 'button', class: 'btn btn-small', 'aria-label': `Mais ${labelText.toLowerCase()}`, disabled: value >= max, onclick: () => set({ [key]: value + 1 }) }, icon('mais', 16))));
    return h('div', { class: 'fa-panel' },
      stepper('Estrelas', cur.stars, 0, 12, 'stars'),
      stepper('Órbitas', cur.orbit, 0, 2, 'orbit'),
      h('div', { class: 'fa-step' },
        h('span', { class: 'fa-step-label' }, cur.shape === 'roundel' ? 'Aro com o nome' : 'Faixa com cor própria'),
        h('button', { type: 'button', class: ['fa-switch', cur.ring && 'on'], role: 'switch', 'aria-checked': cur.ring ? 'true' : 'false', 'aria-label': 'Aro ou faixa',
          onclick: () => set({ ring: cur.ring ? null : { color: shade(cur.field, -0.38), text: '' } }) }, h('i'))),
      h('label', { class: 'field' }, h('span', null, 'Lema (no aro, na faixa ou abaixo do nome)'), motto));
  };

  let previewEl = null;
  const refreshPreview = () => { const p = preview(); previewEl?.replaceWith(p); previewEl = p; };
  const draw = () => {
    root.innerHTML = '';
    previewEl = preview();
    root.append(previewEl,
      h('div', { class: 'segmented tabs fa-tabs', role: 'tablist' }, SECTIONS.map((s) => h('button', {
        type: 'button', class: ['seg', s.id === tab && 'active'], role: 'tab', 'aria-selected': s.id === tab ? 'true' : 'false',
        onclick: () => { tab = s.id; draw(); },
      }, s.label))),
      panel());
  };
  draw();
  root.setLabel = (l) => { cur = normalizeSpec({ ...cur, label: l }); refreshPreview(); };
  root.getSpec = () => compactSpec(cur);
  return root;
}

/**
 * Bottom sheet with the logo editor (Identidade e logo). Resolves to the new spec, or null when closed.
 * opts: {store, actor, emblem, title, onSave(spec)}.
 */
export function openEmblemEditor({ store, actor, emblem, title = 'Editar o logo', onSave } = {}) {
  ensureCss();
  if (store?.data) useEmblemData(store.data);
  const start = emblem && typeof emblem === 'object' && emblem.shape ? emblem : specForActor(actor || {});
  let spec = compactSpec(start);
  return new Promise((resolve) => {
    let done = false;
    openModal((close) => h('div', { class: 'fa-sheet' },
      logoEditor({ spec: start, label: start.label || actor?.short || '', kind: actor?.kind === 'company' ? 'company' : 'agency', onChange: (s) => { spec = s; } }),
      h('div', { class: 'modal-actions' },
        button('Salvar o logo', () => {
          done = true;
          let ok = true;
          try { const r = onSave?.(spec); if (r && r.ok === false) { ok = false; toast(r.error || 'Não foi possível salvar o logo.', 'bad'); } } catch (e) { ok = false; console.error(e); }
          if (ok) { resolve(spec); close(); } else done = false;
        }, { kind: 'primary', big: true, icon: 'check' }),
        button('Cancelar', () => close(), { big: true, kind: 'ghost' }))),
    { title, cls: 'fa-modal', onClose: () => { if (!done) resolve(null); } });
  });
}
export const openLogoEditor = openEmblemEditor;

// ------------------------------------------------------------------ the wizard

/**
 * Full-screen founding wizard (title-page look). opts: {seed, onDone(state), onCancel()}. Creates the game
 * (store.newGame with the founded id) and dispatches 'agency/found'.
 */
export function renderFoundWizard(root, store, { seed, onDone, onCancel } = {}) {
  ensureCss();
  useEmblemData(store.data);
  const data = store.data;
  const opts = foundingOptions(data);
  const worldSeed = Number.isFinite(Number(seed)) ? Number(seed) >>> 0 : uiSeed() % 1000000;
  const nameSeed = uiSeed();
  const era = store.data?.scenario?.snapshot || null;
  const draft = { kind: 'agency', nationId: null, hq: null, name: '', short: '', emblem: null, nameTouched: false };
  let step = 0;
  let error = '';

  const page = h('div', { class: 'title-page fa-page' });
  root.innerHTML = '';
  root.appendChild(page);

  const go = (i) => { step = Math.max(0, Math.min(3, i)); error = ''; draw(); try { page.scrollIntoView?.({ block: 'start' }); window.scrollTo?.(0, 0); } catch { /* */ } };
  const ensureName = () => {
    const nation = opts.nations.find((n) => n.id === draft.nationId);
    if (!draft.nameTouched && nation) {
      const s = suggestName(data, { ...nation, abbr: data?.index?.nations?.[nation.id]?.abbr }, draft.kind, nameSeed);
      draft.name = s.name; draft.short = s.short;
    }
    if (!draft.emblem) draft.emblem = defaultEmblem(nameSeed, { kind: draft.kind, short: draft.short, era });
    else draft.emblem = { ...draft.emblem, label: draft.short.slice(0, 6) };
  };

  const head = (m) => h('div', { class: 'fa-head' },
    h('div', { class: 'fa-top' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': step ? 'Voltar' : 'Sair', onclick: () => (step ? go(step - 1) : onCancel?.()) }, icon(step ? 'voltar' : 'fechar', 22)),
      h('div', { class: 'fa-top-text' }, h('div', { class: 'mono-eyebrow' }, `Fundar a sua agência · ${opts.year}`), h('div', { class: 'fa-top-title' }, ['Que tipo de organização?', 'País e sede', 'Nome e logo', 'Resumo'][step])),
      h('span', { class: 'fa-count' }, `${step + 1}/4`)),
    h('ol', { class: 'fa-steps', 'aria-label': 'Etapas' }, m.steps.map((s, i) => h('li', {
      class: [i === step && 'active', i < step && s.done && 'done'], 'aria-current': i === step ? 'step' : null,
    }, h('span', { class: 'fa-bar' }), h('span', { class: 'fa-step-name' }, s.label)))));

  const stepKind = () => h('div', { class: 'fa-body' },
    h('p', { class: 'fa-lead' }, 'Uma agência estatal vive da verba do governo e do apoio político. Uma empresa vive de contratos, clientes e investidores.'),
    h('div', { class: 'fa-kinds' },
      kindCard('agency', 'Agência estatal', 'Verba anual do governo; mandatos do programa nacional. Possível em qualquer ano.', 'politics'),
      kindCard('company', 'Empresa privada', opts.privateOk ? 'Capital inicial pequeno; cresce vendendo participação a investidores.' : opts.privateNote, 'contract', !opts.privateOk)),
    !opts.privateOk ? h('div', { class: 'aviso' }, icon('info', 16), `Em ${opts.year} só existem programas estatais. ${opts.privateNote}`) : null);

  function kindCard(kind, title, sub, ic, disabled = false) {
    const sel = draft.kind === kind;
    return h('button', {
      type: 'button', class: ['fa-kind', sel && 'selected', disabled && 'disabled'], disabled: disabled || null, 'aria-pressed': sel ? 'true' : 'false',
      onclick: () => { if (disabled) return; if (draft.kind !== kind) { draft.kind = kind; draft.emblem = null; if (!draft.nameTouched) draft.name = ''; } draw(); },
    },
    raw(emblemSVG(specFromSeed(`kind-${kind}`, { kind, label: kind === 'company' ? 'CORP' : 'AGEN' }), { size: 48, detail: 0 }), 'fa-kind-em'),
    h('div', { class: 'fa-kind-text' }, h('div', { class: 'fa-kind-title' }, title, disabled ? chip('anos 80', 'muted') : null), h('div', { class: 'fa-kind-sub' }, sub)),
    h('span', { class: 'fa-radio', 'aria-hidden': 'true' }));
  }

  const stepSede = () => {
    const nation = opts.nations.find((n) => n.id === draft.nationId) || null;
    const select = h('select', {
      class: 'input', 'aria-label': 'País',
      onchange: (e) => { pickNation(e.target.value); },
    }, h('option', { value: '' }, 'Escolha o país…'), opts.nations.map((n) => h('option', { value: n.id, selected: n.id === draft.nationId ? true : null }, n.name)));
    const sites = nation?.sites || [];
    return h('div', { class: 'fa-body' },
      h('label', { class: 'field' }, h('span', null, `Países em ${opts.year}`), select),
      hqMap(nation, opts, draft, (p) => {
        if (p.site) { const s = sites.find((x) => x.id === p.site); if (s) draft.hq = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, launch: !!s.launch }; draw(); return; }
        if (p.nationId && p.nationId !== draft.nationId) { pickNation(p.nationId, { lat: p.lat, lon: p.lon }); return; }
        if (!p.nationId && !nation) { toast('Toque num país destacado no mapa.', 'warn'); return; }
        if (p.nationId === draft.nationId || (!p.nationId && nation)) {
          if (!p.nationId) { toast('A sede precisa ficar dentro do país escolhido.', 'warn'); return; }
          draft.hq = { lat: p.lat, lon: p.lon, name: `Sede própria (${nation.name})` }; draw();
        }
      }),
      h('div', { class: 'fa-map-legend' }, h('span', null, h('i', { class: 'lg-mine' }), 'país escolhido'), h('span', null, h('i', { class: 'lg-pick' }), 'outros países'), h('span', null, h('i', { class: 'lg-launch' }), 'com base de lançamento')),
      nation ? h('div', null,
        h('div', { class: 'fa-sec' }, 'Cidades sugeridas'),
        h('div', { class: 'list fa-sites' }, sites.map((s) => {
          const sel = draft.hq?.id === s.id;
          return h('button', { type: 'button', class: ['list-row', 'fa-site', sel && 'mine'], 'aria-pressed': sel ? 'true' : 'false', onclick: () => { draft.hq = { id: s.id, name: s.name, lat: s.lat, lon: s.lon, launch: !!s.launch }; draw(); } },
            h('span', { class: ['fa-site-dot', sel && 'sel'], 'aria-hidden': 'true' }, sel ? icon('check', 16) : icon('alvo', 16)),
            h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, s.name), h('div', { class: 'list-sub' }, s.launch ? 'Base de lançamento própria' : 'Sede administrativa')),
            s.launch ? chip('lançamentos', 'info') : null);
        }).concat(draft.hq && !draft.hq.id ? [h('div', { class: 'list-row fa-site mine' }, h('span', { class: 'fa-site-dot sel' }, icon('check', 16)),
          h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, 'Ponto escolhido no mapa'), h('div', { class: 'list-sub' }, coordText(draft.hq))))] : []))) : h('div', { class: 'aviso' }, icon('info', 16), 'Escolha o país na lista ou toque nele no mapa.'));
  };

  function pickNation(id, at) {
    if (!id) { draft.nationId = null; draft.hq = null; draw(); return; }
    const n = opts.nations.find((x) => x.id === id);
    if (!n) return;
    draft.nationId = id;
    if (at) draft.hq = { lat: at.lat, lon: at.lon, name: `Sede própria (${n.name})` };
    else { const s = n.sites[0]; draft.hq = s ? { id: s.id, name: s.name, lat: s.lat, lon: s.lon, launch: !!s.launch } : null; }
    if (!draft.nameTouched) { draft.name = ''; draft.short = ''; }
    draw();
  }

  let editor = null;
  const stepNome = () => {
    ensureName();
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: '40', value: draft.name, 'aria-label': 'Nome da agência', autocomplete: 'off',
      oninput: (e) => { draft.name = e.target.value; draft.nameTouched = true; } });
    const shortIn = h('input', { class: 'input fa-short', type: 'text', maxlength: '6', value: draft.short, 'aria-label': 'Sigla', autocomplete: 'off', autocapitalize: 'characters',
      oninput: (e) => {
        const v = e.target.value.toUpperCase().replace(/[^\p{L}\p{N}-]/gu, '').slice(0, 6);
        if (v !== e.target.value) e.target.value = v;
        draft.short = v; draft.nameTouched = true;
        if (draft.emblem) draft.emblem = { ...draft.emblem, label: v };
        editor?.setLabel(v);
      } });
    editor = logoEditor({ spec: draft.emblem, label: draft.short, kind: draft.kind, era, onChange: (s) => { draft.emblem = s; } });
    return h('div', { class: 'fa-body' },
      h('div', { class: 'fa-names' },
        h('label', { class: 'field fa-name' }, h('span', null, 'Nome'), nameIn),
        h('label', { class: 'field fa-sigla' }, h('span', null, 'Sigla (até 6)'), shortIn)),
      h('div', { class: 'fa-sec' }, 'Logo'),
      editor);
  };

  const stepResumo = (m) => {
    const v = m.valid;
    if (!v.ok) return h('div', { class: 'fa-body' }, h('div', { class: 'aviso bad' }, icon('alerta', 16), v.error));
    const val = v.value;
    const pv = m.preview;
    const actorLike = { id: 'preview', short: val.short, name: val.name, emblem: val.emblem };
    return h('div', { class: 'fa-body' },
      h('div', { class: 'fa-hero' },
        raw(emblemSVG(specForActor(actorLike), { size: 112 }), 'fa-hero-em'),
        h('div', { class: 'fa-hero-text' },
          h('div', { class: 'fa-hero-name' }, val.name),
          h('div', { class: 'fa-hero-sub' }, `${val.short} · ${KIND_LABEL[val.kind]} · ${val.nation.name}`),
          h('div', { class: 'chips' }, chip(`Dificuldade: ${pv.difficulty.label}`, pv.difficulty.id === 'media' ? 'info' : pv.difficulty.id === 'dificil' ? 'warn' : 'bad')))),
      h('div', { class: 'fa-kpis' },
        kpi(val.kind === 'company' ? 'Receita/ano' : 'Verba/ano', fmtMoney(pv.budget)),
        kpi('Caixa inicial', fmtMoney(pv.cash)),
        kpi('Apoio', String(pv.support)),
        kpi('Reputação', String(pv.reputation))),
      h('div', { class: 'card fa-card' },
        h('div', { class: 'kv' },
          kv('Sede', val.hq?.name || '—'),
          kv('Coordenadas', val.hq ? coordText(val.hq) : '—'),
          kv('Base de lançamento', pv.launchSites.length ? pv.launchSites[0] : 'Nenhuma (aluga de outros)'),
          kv('Participação', '100% sua no início'))),
      h('div', { class: 'fa-sec' }, 'O que esperar'),
      h('ul', { class: 'fa-notes' }, pv.difficulty.notes.map((n) => h('li', null, n))),
      error ? h('div', { class: 'aviso bad', role: 'alert' }, icon('alerta', 16), error) : null);
  };
  const kpi = (l, v) => h('div', { class: 'go-kpi' }, h('div', { class: 'k-label' }, l), h('div', { class: 'k-value' }, v));
  const kv = (l, v) => h('div', { class: 'kv-row' }, h('span', null, l), h('span', null, v));

  const found = () => {
    const m = wizardModel(data, draft);
    if (!m.valid.ok) { error = m.valid.error; draw(); return; }
    const id = customIdFor(m.payload, worldSeed);
    try {
      store.newGame({ playerId: id, seed: worldSeed, scenarioId: store.scenarioId?.() });
      const res = store.dispatch({ type: 'agency/found', ...m.payload });
      if (!res?.ok) { error = res?.error || 'Não foi possível fundar a agência.'; try { store.deleteSave?.(); } catch { /* */ } draw(); return; }
      onDone?.(store.state);
    } catch (e) {
      console.error(e);
      error = `Não foi possível criar o jogo: ${e.message}`;
      draw();
    }
  };

  const footer = (m) => {
    const can = m.steps[step].done || (step === 2 && draft.name && draft.short);
    const next = step < 3
      ? button('Continuar', () => {
        if (step === 2) { const v = wizardModel(data, draft).valid; if (!v.ok && /nome|sigla|logo/i.test(v.error || '')) { error = v.error; draw(); return; } }
        go(step + 1);
      }, { kind: 'primary', big: true, disabled: !can, icon: 'avancar' })
      : button('Fundar agência', found, { kind: 'primary', big: true, disabled: !m.valid.ok, icon: 'check' });
    return h('div', { class: 'fa-foot' },
      step ? button('Voltar', () => go(step - 1), { big: true, kind: 'ghost' }) : button('Cancelar', () => onCancel?.(), { big: true, kind: 'ghost' }),
      next);
  };

  function draw() {
    const m = wizardModel(data, draft);
    const body = [stepKind, stepSede, stepNome, stepResumo][step](m);
    page.innerHTML = '';
    page.append(h('div', { class: 'title-screen fa-screen' }, head(m), step !== 3 && error ? h('div', { class: 'aviso bad', role: 'alert' }, icon('alerta', 16), error) : null, body), footer(m));
  }
  draw();
  return { go, draft };
}

function coordText(hq) {
  const f = (v) => Math.abs(v).toFixed(1).replace('.', ',');
  return `${f(hq.lat)}° ${hq.lat >= 0 ? 'N' : 'S'} · ${f(hq.lon)}° ${hq.lon >= 0 ? 'L' : 'O'}`;
}

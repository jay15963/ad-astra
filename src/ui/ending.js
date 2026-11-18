// The jan/3000 final event (docs/EXPANSION.md §9): the choice scene ('ending/final', all three endings always open,
// requirements met/unmet and a preview coloured by the agency's lean) and the epilogue that replaces the game over
// screen when the campaign ends with an ending: Contato, Silêncio or Herança, then the 1,050 years of the player's
// agency (history, Os Primeiros, the Memorial and the families that came back, the worlds, the Eco, the annals).
// Pages swipe like the era scene; respects reduced motion; never throws (anything missing falls back to text).
// Models are pure and DOM-free (tests/eco.test.mjs reads them).
import { h, raw, button, chip, toast, reduceMotion, attempt, confirmDialog, FIRST_LABELS } from './components.js';
import { emblemSVG } from './portrait.js';
import { query as engineQuery } from '../core/engine.js';

const ENDING_IDS = ['contato', 'silencio', 'heranca'];
/** Same rule as src/sim/eco.js dominantLean: the top ending, or null on a tie or with no lean at all. */
function dominantLean(lean) {
  const sorted = ENDING_IDS.map((id) => [id, Number(lean?.[id]) || 0]).sort((a, b) => b[1] - a[1]);
  return sorted[0][1] <= 0 || sorted[0][1] === sorted[1][1] ? null : sorted[0][0];
}
const q = (state, data, name, ...args) => attempt(() => (state?.eco ? engineQuery(state, data, name, ...args) : null), null);

const SWIPE_PX = 60;
const TONE_LABEL = { pleno: 'Pleno', incerto: 'Incerto', fragil: 'Frágil' };
const TONE_KIND = { pleno: 'good', incerto: 'info', fragil: 'muted' };
const ENDING_NAME = { contato: 'Contato', silencio: 'Silêncio', heranca: 'Herança' };

function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-ending-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/ending.css', import.meta.url).href;
    l.dataset.endingCss = '1';
    document.head.appendChild(l);
  } catch { /* Node */ }
}

const yearAt = (state, turn) => (Number(state?.startYear) || 1950) + Math.floor((Number(turn) || 0) / 52);

/** pt-BR milestone label: UI table, eco.json table (from the vocabulary), data labels, then the id. */
export function labelOf(data, id) {
  const base = String(id).split(':')[0];
  return FIRST_LABELS[base] || data?.eco?.milestoneLabels?.[base] || data?.calendar?.milestoneLabels?.[base]
    || data?.bodies?.milestoneLabels?.[base] || base.replace(/_/g, ' ');
}

// ------------------------------------------------------------------ choice scene

/** Text model of the final card (pure): the three endings with tone, requirements and preview. */
export function choiceModel(decision, state, data) {
  const live = q(state, data, 'eco/endingChoices');
  const fromDec = Array.isArray(decision?.choices) ? decision.choices : [];
  const lean = state?.eco?.lean || decision?.payload?.lean || null;
  const total = lean ? ENDING_IDS.reduce((s, k) => s + (Number(lean[k]) || 0), 0) : 0;
  return {
    eyebrow: 'Janeiro de 3000',
    title: decision?.title || 'O Grande Silêncio',
    body: decision?.body || 'O sinal que atravessou mil anos espera uma resposta. Os três caminhos estão abertos.',
    lean: ENDING_IDS.map((id) => ({ id, label: ENDING_NAME[id], value: lean ? Math.round(Number(lean[id]) || 0) : 0, share: total > 0 ? (Number(lean[id]) || 0) / total : 0 })),
    dominant: lean ? dominantLean(lean) : null,
    options: ENDING_IDS.map((id) => {
      const d = fromDec.find((c) => c?.id === id) || {};
      const l = live?.find((c) => c.id === id) || {};
      const reqs = Array.isArray(d.requirements) ? d.requirements : Array.isArray(l.requirements) ? l.requirements : [];
      const tone = d.tone || l.tone || null;
      return {
        id, title: d.label || l.label || ENDING_NAME[id], tone, toneLabel: tone ? TONE_LABEL[tone] : null,
        preview: d.preview || l.preview || '', leaning: !!(d.leaning ?? l.leaning),
        requirements: reqs.map((r) => ({ label: r.label || String(r.id || r), met: !!r.met })),
      };
    }),
  };
}

function overlayRoot() {
  let r = document.getElementById('overlay-root');
  if (!r) { r = h('div', { id: 'overlay-root' }); document.body.appendChild(r); }
  return r;
}

let openClose = null;

/** Jan/3000 final card. Returns close(). */
export function openEndingCard(store, decision) {
  ensureCss();
  try { openClose?.(); } catch { /* */ }
  const m = choiceModel(decision, store.state, store.data);
  let picked = null;
  let armed = null;
  const confirm = button('Escolha um final', () => resolve(), { kind: 'primary', big: true, disabled: true });
  const warn = h('p', { class: 'fim-aviso', role: 'status', hidden: true }, 'Esta escolha encerra a campanha. Toque de novo para confirmar.');
  const cards = m.options.map((o) => {
    const b = h('button', {
      class: ['choice', 'fim-opcao', o.leaning && 'inclinada'], type: 'button', 'aria-pressed': 'false',
      onclick: () => {
        picked = o;
        for (const x of cards) { x.classList.remove('selected'); x.setAttribute('aria-pressed', 'false'); }
        b.classList.add('selected');
        b.setAttribute('aria-pressed', 'true');
        confirm.disabled = false;
        armed = null;
        warn.hidden = true;
        confirm.lastChild.textContent = `Escolher: ${o.title}`;
      },
    },
    h('span', { class: 'fim-opcao-topo' },
      h('span', { class: 'choice-label' }, o.title),
      o.toneLabel ? chip(o.toneLabel, TONE_KIND[o.tone] || 'muted') : null),
    o.preview ? h('span', { class: 'choice-hint' }, o.preview) : null,
    o.requirements.length ? h('span', { class: 'fim-reqs' }, o.requirements.map((r) => h('span', { class: ['fim-req', r.met ? 'ok' : 'falta'] },
      h('span', { class: 'fim-req-marca', 'aria-hidden': 'true' }, r.met ? '✓' : '·'),
      h('span', null, r.label),
      h('span', { class: 'sr-only' }, r.met ? ' (cumprido)' : ' (não cumprido)')))) : null);
    return b;
  });
  const resolve = () => {
    if (!picked) return;
    // two taps: the first arms the choice (the ending closes a 1,050-year campaign), the second confirms it.
    // Inline on purpose: a confirm sheet would open under this full-screen scene.
    if (armed !== picked.id) {
      armed = picked.id;
      confirm.lastChild.textContent = `Confirmar: ${picked.title}`;
      warn.hidden = false;
      return;
    }
    const res = store.dispatch({ type: 'decision/resolve', id: decision.id, choiceId: picked.id });
    if (!res?.ok) { toast(res?.error || 'Não foi possível concluir agora.', 'bad'); return; }
    close();
  };
  const leanBar = h('div', { class: 'fim-inclinacao', role: 'img', 'aria-label': `Inclinação da agência: ${m.lean.map((l) => `${l.label} ${l.value}`).join(', ')}` },
    h('div', { class: 'mono-eyebrow' }, 'Inclinação da agência'),
    h('div', { class: 'fim-barra' }, m.lean.map((l) => h('span', { class: ['fim-barra-seg', `seg-${l.id}`, m.dominant === l.id && 'dominante'], style: `flex-grow:${Math.max(0.04, l.share).toFixed(3)}` }))),
    h('div', { class: 'fim-barra-rotulos' }, m.lean.map((l) => h('span', { class: m.dominant === l.id ? 'dominante' : null }, `${l.label} `, h('span', { class: 'mono' }, String(l.value))))));
  const root = h('div', { class: ['era-cena', 'fim-cena', reduceMotion() && 'sem-movimento'], role: 'dialog', 'aria-modal': 'true', 'aria-label': m.title },
    h('div', { class: 'era-caixa fim-caixa' },
      h('div', { class: 'era-cartao fim-cartao' },
        h('div', { class: 'mono-eyebrow' }, m.eyebrow),
        h('h2', { class: 'era-titulo' }, m.title),
        h('p', { class: 'fim-prosa' }, m.body),
        leanBar,
        h('div', { class: 'choices' }, cards)),
      warn,
      h('div', { class: 'era-acoes' }, confirm)));
  const close = () => { root.remove(); if (openClose === close) openClose = null; };
  overlayRoot().appendChild(root);
  openClose = close;
  return close;
}

// ------------------------------------------------------------------ epilogue

/** Annals headlines, up to two per century, oldest first: [{label, h}]. Pure. */
export function annalsByCentury(state, max = 14) {
  const an = state?.annals || {};
  const byCentury = new Map();
  for (const [k, list] of Object.entries(an)) {
    if (!Array.isArray(list) || !list.length) continue;
    const kind = k[0] === 'c' ? 'c' : k[0] === 'd' ? 'd' : 'y';
    const y = Number(kind === 'y' ? k : k.slice(1));
    if (!Number.isFinite(y)) continue;
    const c = Math.floor(y / 100) * 100;
    const arr = byCentury.get(c) || [];
    for (const e of list) if (e?.h) arr.push({ y: Number.isFinite(e.t) ? yearAt(state, e.t) : y, h: e.h, i: e.i || 1 });
    byCentury.set(c, arr);
  }
  const out = [];
  for (const c of [...byCentury.keys()].sort((a, b) => a - b)) {
    const top = byCentury.get(c).sort((a, b) => (b.i - a.i) || (a.y - b.y)).slice(0, 2).sort((a, b) => a.y - b.y);
    for (const e of top) out.push({ label: String(e.y), h: e.h });
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, k) => out[Math.floor(k * step)]);
}
/** Everything the epilogue shows (pure, DOM-free; no undefined/NaN in its strings). */
export function endingModel(state, data) {
  const go = state?.gameOver || {};
  const pid = state?.playerId;
  const me = state?.actors?.[pid] || state?.lifecycle?.tombstones?.[pid] || { id: pid };
  const stored = state?.eco?.epilogue || null;
  const ep = q(state, data, 'eco/epilogue', go.ending ?? stored?.ending, { ai: go.reason !== 'ending', labelOf: (id) => labelOf(data, id) });
  const endingId = ep?.ending || go.ending || 'heranca';
  const fallbackText = (data?.ending?.choices || []).find?.((c) => c?.id === endingId)?.text || (typeof go.summary === 'string' ? go.summary : '');
  const paras = ep?.paras?.length ? ep.paras : stored?.paras?.length ? stored.paras : [fallbackText || 'Janeiro de 3000. Mil anos de história terminam com a sua escolha.'];
  const legacy = ep?.legacy || stored?.legacy || [];
  const eco = q(state, data, 'eco/summary');
  // era by era: the Tabela da Era rank and the agency's name at the end of each era
  const eraDefs = Array.isArray(data?.eras?.eras) ? data.eras.eras : Array.isArray(data?.eras) ? data.eras : [];
  const chron = state?.eco?.chron || [];
  const eras = (state?.eraHistory || []).map((eh) => {
    const def = eraDefs.find((e) => e?.id === eh.eraId) || {};
    const rank = (eh.standings || []).findIndex((s) => s.id === pid) + 1;
    const c = chron.find((x) => x.era === eh.eraId);
    return { id: eh.eraId, n: def.n ?? null, name: def.name || eh.eraId, rank: rank || null, of: (eh.standings || []).length, as: c?.name || null, headline: eh.headline || null };
  });
  const firsts = Object.entries(state?.firsts || {}).filter(([id, f]) => f?.actorId === pid && !id.includes(':'))
    .map(([id, f]) => ({ id, label: labelOf(data, id), year: yearAt(state, f.turn) })).sort((a, b) => a.year - b.year);
  const shownFirsts = firsts.length > 10 ? [...firsts.slice(0, 5), ...firsts.slice(-5)] : firsts;
  const memorial = (state?.memorial || []).filter((m) => m?.name).map((m) => ({ name: m.name, year: Number.isFinite(m.year) ? m.year : yearAt(state, m.turn) }));
  const wall = memorial.length > 40 ? [...memorial.slice(0, 20), ...memorial.slice(-20)] : memorial;
  const colonies = attempt(() => {
    const c = state?.colonies;
    const raw0 = !c ? [] : Array.isArray(c) ? c : Array.isArray(c.list) ? c.list : Object.values(c.list && typeof c.list === 'object' ? c.list : {});
    return raw0.filter((x) => x && (x.name || x.id)).map((x) => ({ name: x.name || x.id, mine: !(x.ownerId || x.owner) || (x.ownerId || x.owner) === pid, stage: Number.isFinite(x.stage) ? x.stage : null }));
  }, []);
  const colonyFirsts = firsts.filter((f) => /colony|base|outpost|habitat|world/.test(f.id));
  const tone = ep?.tone || stored?.tone || null;
  const title = `Final: ${ENDING_NAME[endingId] || 'o Grande Silêncio'}`;
  const year = yearAt(state, state?.turn);
  return {
    endingId, title, tone, toneLabel: tone ? TONE_LABEL[tone] : null, met: ep?.met ?? stored?.met ?? null, total: ep?.total ?? 3,
    agency: { id: pid, name: me.name || me.short || pid || 'Agência', short: me.short || me.name || pid || '' },
    date: `Janeiro de ${year}`,
    cards: [
      { id: 'final', eyebrow: `Janeiro de ${year}`, title, paras, chips: tone ? [{ text: `${TONE_LABEL[tone]} · ${ep?.met ?? stored?.met ?? 0} de ${ep?.total ?? 3} condições`, kind: TONE_KIND[tone] }] : [] },
      { id: 'agencia', eyebrow: 'A agência', title: me.name || me.short || 'A agência', lines: legacy.slice(0, 3),
        rows: eras.map((e) => ({ lead: e.n != null ? `Era ${e.n}` : e.id, title: e.name, meta: e.rank ? `${e.rank}º de ${e.of}` : '—', sub: e.as && e.as !== me.name ? `como ${e.as}` : (e.headline || null) })) },
      { id: 'primeiros', eyebrow: 'Os Primeiros', title: firsts.length ? `${firsts.length} primeiro${firsts.length === 1 ? '' : 's'} feito${firsts.length === 1 ? '' : 's'}` : 'Nenhum primeiro feito',
        lines: firsts.length ? [] : ['A agência nunca chegou primeiro. Chegou, e isso também conta.'],
        rows: shownFirsts.map((f) => ({ lead: String(f.year), title: f.label })) },
      { id: 'memorial', eyebrow: 'O Memorial', title: memorial.length ? `${memorial.length} nome${memorial.length === 1 ? '' : 's'} na parede` : 'Uma parede sem nomes',
        lines: legacy.filter((l) => /^Os |carregou o nome/.test(l)), names: wall, more: Math.max(0, memorial.length - wall.length) },
      { id: 'mundos', eyebrow: 'Os mundos e o Eco', title: eco ? `${eco.pieces.length} de ${eco.total} peças do Eco` : 'O Eco',
        lines: [
          ...legacy.filter((l) => /mundos com gente|Colégio/.test(l)),
          colonies.length ? null : colonyFirsts.length ? `Mundos abertos pela agência: ${colonyFirsts.slice(0, 4).map((f) => f.label.toLowerCase()).join(', ')}.` : null,
        ].filter(Boolean),
        rows: [
          ...colonies.filter((c) => c.mine).slice(0, 6).map((c) => ({ lead: 'Mundo', title: c.name, meta: c.stage ? `estágio ${c.stage}` : '' })),
          ...(eco?.pieces || []).map((p) => ({ lead: String(p.year), title: p.title, sub: p.via === 'arquivo' ? 'nos arquivos' : null })),
        ] },
      { id: 'anais', eyebrow: 'Anais', title: 'Mil anos em manchetes', rows: annalsByCentury(state).map((a) => ({ lead: a.label, title: a.h })) },
      { id: 'fim', eyebrow: 'Fim', title: ep?.close || stored?.close || 'A história continua sem placar.', lines: [`${me.short || me.name || 'A agência'}, ${state?.startYear ?? 1950}–${year}.`], last: true },
    ],
  };
}

/** Epilogue screen (replaces the game over screen for gameOver.reason 'ending'). */
export function renderEnding(root, store, { onNewGame, onKeepLooking } = {}) {
  ensureCss();
  const st = store.state;
  const model = attempt(() => endingModel(st, store.data), null);
  if (!model) return false;
  root.innerHTML = '';
  let i = 0;
  const dots = h('div', { class: 'era-pontos', 'aria-hidden': 'true' });
  const body = h('div', { class: 'era-cartao fim-cartao fim-epilogo', 'aria-live': 'polite' });
  const next = button('Próximo', () => go(i + 1), { kind: 'primary', big: true });
  const back = button('Voltar', () => go(i - 1), { big: true, kind: 'ghost' });
  const endBtns = h('div', { class: 'btn-col fim-finais' },
    button('Nova campanha', async () => {
      if (await confirmDialog('Começar uma campanha nova apaga este save.', { okLabel: 'Começar', title: 'Nova campanha' })) {
        store.deleteSave?.();
        onNewGame?.();
      }
    }, { kind: 'primary', icon: 'continuar', big: true }),
    onKeepLooking ? button('Ver o mundo final', onKeepLooking, { icon: 'mundo', big: true }) : null);
  const draw = () => {
    const c = model.cards[i];
    body.innerHTML = '';
    body.classList.remove('entra');
    void body.offsetWidth;
    body.classList.add('entra');
    body.append(...[
      h('div', { class: 'mono-eyebrow' }, c.eyebrow),
      c.id === 'agencia' ? h('div', { class: 'fim-emblema' }, raw(emblemSVG(st.actors?.[st.playerId] || st.lifecycle?.tombstones?.[st.playerId] || { id: st.playerId }, { size: 44 }), 'agency-emblem')) : null,
      h('h2', { class: ['era-titulo', c.last && 'fim-ultima'] }, c.title),
      c.chips?.length ? h('div', { class: 'chips' }, c.chips.map((x) => chip(x.text, x.kind))) : null,
      ...(c.paras || []).map((p) => h('p', { class: 'fim-prosa' }, p)),
      ...(c.lines || []).map((l) => h('p', { class: 'era-linha' }, l)),
      c.names?.length ? h('ul', { class: 'fim-memorial', 'aria-label': 'Nomes do Memorial' }, c.names.map((n) => h('li', null, h('span', null, n.name), h('span', { class: 'mono' }, String(n.year))))) : null,
      c.more ? h('p', { class: 'era-linha' }, `E mais ${c.more} nome${c.more === 1 ? '' : 's'}.`) : null,
      c.rows?.length ? h('ol', { class: 'fim-lista' }, c.rows.map((r) => h('li', null,
        h('span', { class: 'fim-lista-lead mono' }, r.lead),
        h('span', { class: 'fim-lista-texto' }, h('span', { class: 'fim-lista-titulo' }, r.title), r.sub ? h('span', { class: 'fim-lista-sub' }, r.sub) : null),
        r.meta ? h('span', { class: 'fim-lista-meta mono' }, r.meta) : null))) : null,
      c.last ? endBtns : null,
    ].filter(Boolean));
    dots.innerHTML = '';
    model.cards.forEach((_, k) => dots.append(h('span', { class: k === i ? 'atual' : null })));
    back.hidden = i === 0;
    next.hidden = i === model.cards.length - 1;
    body.scrollTop = 0;
  };
  const go = (k) => {
    if (k < 0 || k >= model.cards.length) return;
    i = k;
    draw();
  };
  const scene = h('div', { class: ['era-cena', 'fim-cena', 'fim-tela', `fim-${model.endingId}`, reduceMotion() && 'sem-movimento'], role: 'region', 'aria-label': model.title },
    h('div', { class: 'era-caixa fim-caixa' }, dots, body, h('div', { class: 'era-acoes' }, back, next)));
  let touch = null;
  scene.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = t ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
  scene.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const s = touch;
    touch = null;
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(t.clientY - s.y) * 1.5) go(dx < 0 ? i + 1 : i - 1);
  }, { passive: true });
  const onKey = (e) => {
    if (!scene.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'ArrowRight') go(i + 1); else if (e.key === 'ArrowLeft') go(i - 1);
  };
  document.addEventListener('keydown', onKey);
  root.appendChild(scene);
  draw();
  setTimeout(() => next.focus?.({ preventScroll: true }), 30);
  return true;
}

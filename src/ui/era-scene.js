// Era transition scene (docs/EXPANSION.md §2.4) and the Phase A stand-in for the year-3000 ending (§9).
// Both are blocking decisions pushed by the engine ('era/transition', 'ending/final'); decisions.openDecision hands
// them here. Full-screen overlay, 4 cards (swipe or "Próximo"), respects reduced motion. Never throws: anything
// missing from the engine/data falls back to plain text, so the scene can never trap the player.
import { h, raw, button, chip, toast, reduceMotion, attempt, eraInfo, ERA_NAMES, FIRST_LABELS } from './components.js';
import { emblemSVG } from './portrait.js';

const SWIPE_PX = 60;

function overlayRoot() {
  let r = document.getElementById('overlay-root');
  if (!r) { r = h('div', { id: 'overlay-root' }); document.body.appendChild(r); }
  return r;
}

const eraList = (data) => (Array.isArray(data?.eras) ? data.eras : Array.isArray(data?.eras?.eras) ? data.eras.eras : []);
function eraDef(data, id) {
  const def = eraList(data).find((e) => e?.id === id) || {};
  const n = def.n ?? (Number(String(id || '').replace(/\D/g, '')) || null);
  const from = def.from?.year ?? def.from ?? null;
  return { id, n, name: def.name || ERA_NAMES[id] || '', from: Number.isFinite(Number(from)) ? Number(from) : null, def };
}

/** Step length (weeks) of the first band of an era, from data/core/eras.json bands. */
export function firstStepOfEra(data, eraId) {
  const bands = data?.eras?.bands || data?.bands || [];
  const b = (Array.isArray(bands) ? bands : []).find((x) => x?.eraId === eraId || x?.era === eraId);
  return Number(b?.stepWeeks) || null;
}
const STEP_WORDS = { 1: '+1 semana', 2: '+2 semanas', 4: '+4 semanas', 13: '+1 trimestre', 26: '+1 semestre', 52: '+1 ano' };

/** Text content of the 4 cards (pure, DOM-free; tests check it has no undefined/NaN). */
export function eraSceneModel(state, data, decision = null) {
  const pe = state?.clock?.pendingEra || decision?.payload || {};
  const fromId = pe.from || state?.clock?.eraId || eraInfo(state, data).id;
  const toId = pe.to || null;
  const from = eraDef(data, fromId);
  const to = toId ? eraDef(data, toId) : null;
  const pid = state?.playerId;
  const since = Number(state?.clock?.eraStartTurn) || 0;
  const actors = state?.actors || {};
  const ranked = Object.values(actors).filter(Boolean)
    .map((a) => ({ id: a.id, name: a.short || a.name || a.id, p: Number(a.prestigeEra ?? a.prestige) || 0 }))
    .sort((a, b) => b.p - a.p);
  const pos = ranked.findIndex((r) => r.id === pid) + 1;
  const firsts = Object.entries(state?.firsts || {}).filter(([, f]) => f?.actorId === pid && (Number(f.turn) || 0) >= since)
    .map(([id]) => FIRST_LABELS[String(id).split(':')[0]] || String(id).replace(/[:_]/g, ' ')).slice(0, 3);
  const launches = (state?.missions || []).filter((m) => m?.result && (Number(m.launchTurn) || 0) >= since).length;
  const album = (state?.album || []).filter((c) => (Number(c?.turn) || 0) >= since);
  const best = album.slice().sort((a, b) => (Number(b.rarity) || 0) - (Number(a.rarity) || 0))[0] || null;
  const memorial = (state?.memorial || []).filter((m) => (Number(m?.turn) || 0) >= since).map((m) => m.name).filter(Boolean).slice(0, 6);
  const step = to ? firstStepOfEra(data, to.id) : null;
  const unlocks = Object.entries(data?.scenario?.unlocks || {}).filter(([, u]) => to?.from != null && Number(u?.fromYear) === Number(to.from))
    .map(([k]) => ({ builder: 'Construtor de foguetes', investors: 'Investidores', colonies: 'Colônias' }[k] || k));
  const eraTitle = (e) => (e ? `Era ${e.n ?? ''}${e.name ? `: ${e.name}` : ''}`.trim() : '');
  return {
    fromId: from.id, toId: to?.id || null,
    cards: [
      { eyebrow: 'Fim de uma era', title: `Fim da ${eraTitle(from)}`, lines: [pos ? `Você termina a era em ${pos}º lugar na Tabela da Era, entre ${ranked.length} agências.` : 'A Tabela da Era está fechada.', ranked[0] ? `Líder da era: ${ranked[0].name}.` : null].filter(Boolean) },
      { eyebrow: 'O que você fez', title: firsts.length ? 'Seus feitos' : 'Seu legado', lines: [...(firsts.length ? firsts.map((f) => `Primeiro: ${f}`) : ['Nenhum feito inédito nesta era.']), `${launches} lançamento${launches === 1 ? '' : 's'} com resultado.`, best ? `Melhor carta do álbum: ${best.title || best.name || 'sem título'}.` : null].filter(Boolean) },
      { eyebrow: 'Quem ficou', title: 'O mundo que continua', lines: [`${ranked.length} agência${ranked.length === 1 ? '' : 's'} seguem em atividade.`, memorial.length ? `No Memorial: ${memorial.join(', ')}.` : 'Ninguém da agência entrou para o Memorial nesta era.'], faces: ranked.slice(0, 8).map((r) => r.id) },
      { eyebrow: 'A próxima era', title: to ? eraTitle(to) : 'Uma nova era', lines: [step ? `Agora cada toque = ${STEP_WORDS[step] || `+${step} semanas`}.` : 'O ritmo do tempo muda com a era.', unlocks.length ? `Novo: ${unlocks.join(', ')}.` : null].filter(Boolean) },
    ],
    cta: to ? `Começar a Era ${to.n ?? ''}`.trim() : 'Continuar',
  };
}

let openClose = null;
export function isSceneOpen() { return !!openClose; }

/** Full-screen era transition. Returns close(). */
export function openEraScene(store, decision) {
  try { openClose?.(); } catch { /* */ }
  const model = attempt(() => eraSceneModel(store.state, store.data, decision), null)
    || { fromId: null, toId: null, cards: [{ eyebrow: 'Nova era', title: 'Uma nova era começa', lines: [] }], cta: 'Continuar' };
  if (model.toId) store.ensureEra?.(model.toId)?.catch?.(() => { /* retried on continue */ });
  let i = 0;
  let busy = false;
  const dots = h('div', { class: 'era-pontos', 'aria-hidden': 'true' });
  const body = h('div', { class: 'era-cartao', 'aria-live': 'polite' });
  const next = button('Próximo', () => go(i + 1), { kind: 'primary', big: true });
  const back = button('Voltar', () => go(i - 1), { big: true, kind: 'ghost' });
  const root = h('div', { class: ['era-cena', reduceMotion() && 'sem-movimento'], role: 'dialog', 'aria-modal': 'true', 'aria-label': model.cards[0]?.title || 'Nova era' },
    h('div', { class: 'era-caixa' }, dots, body, h('div', { class: 'era-acoes' }, back, next)));
  const draw = () => {
    const c = model.cards[i];
    body.innerHTML = '';
    body.classList.remove('entra');
    void body.offsetWidth;
    body.classList.add('entra');
    // native append turns null into the text "null": only nodes go in
    body.append(...[
      h('div', { class: 'mono-eyebrow' }, c.eyebrow),
      h('h2', { class: 'era-titulo' }, c.title),
      c.faces?.length ? h('div', { class: 'era-rostos' }, c.faces.map((id) => raw(emblemSVG(store.state?.actors?.[id] || { id }, { size: 34 }), 'era-rosto'))) : null,
      ...c.lines.map((l) => h('p', { class: 'era-linha' }, l)),
    ].filter(Boolean));
    dots.innerHTML = '';
    model.cards.forEach((_, k) => dots.append(h('span', { class: k === i ? 'atual' : null })));
    back.hidden = i === 0;
    const last = i === model.cards.length - 1;
    next.lastChild.textContent = last ? model.cta : 'Próximo';
    // the checkpoint is written before the last card (it holds the finished era)
    if (last && model.fromId && !draw.saved) { draw.saved = true; try { store.eraCheckpoint?.(model.fromId); } catch { /* */ } }
  };
  const go = async (k) => {
    if (busy) return;
    if (k < 0) return;
    if (k >= model.cards.length) { await finish(); return; }
    i = k;
    draw();
  };
  const finish = async () => {
    busy = true;
    next.disabled = true;
    try {
      let res = store.dispatch({ type: 'decision/resolve', id: decision.id, choiceId: 'continue' });
      if (!res?.ok && res?.needsData) {
        next.lastChild.textContent = 'Carregando a próxima era…';
        await store.ensureEra(res.needsData);
        res = store.dispatch({ type: 'decision/resolve', id: decision.id, choiceId: 'continue' });
      }
      if (!res?.ok) { toast(res?.error || 'Não foi possível começar a próxima era.', 'bad', 5000); next.lastChild.textContent = model.cta; return; }
      close();
    } catch (e) {
      console.error(e);
      toast('Não foi possível carregar a próxima era. Verifique a conexão e tente de novo.', 'bad', 5000);
      next.lastChild.textContent = model.cta;
    } finally { busy = false; next.disabled = false; }
  };
  let touch = null;
  root.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = t ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
  root.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const s = touch;
    touch = null;
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    // a swipe pages the cards; the last card only moves on with its button (starting the era is explicit)
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(t.clientY - s.y) * 1.5) go(dx < 0 ? Math.min(i + 1, model.cards.length - 1) : i - 1);
  }, { passive: true });
  const onKey = (e) => { if (e.key === 'ArrowRight') go(Math.min(i + 1, model.cards.length - 1)); else if (e.key === 'ArrowLeft') go(i - 1); };
  document.addEventListener('keydown', onKey);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    root.remove();
    if (openClose === close) openClose = null;
  };
  overlayRoot().appendChild(root);
  draw();
  setTimeout(() => next.focus?.({ preventScroll: true }), 30);
  openClose = close;
  return close;
}

const ENDING_FALLBACK = {
  contato: ['Contato', 'Responder ao sinal e abrir a humanidade para quem está do outro lado.'],
  silencio: ['Silêncio', 'Calar e seguir sozinhos, guardando o segredo do Eco.'],
  heranca: ['Herança', 'Deixar tudo preparado para quem vier depois: arquivos, rotas e um convite.'],
};

/** The three endings (Contato, Silêncio, Herança): all always offered (§9). Pure. */
export function endingOptions(decision, data) {
  const texts = data?.ending?.endings || data?.ending || {};
  const ids = ['contato', 'silencio', 'heranca'];
  const fromDecision = Array.isArray(decision?.choices) ? decision.choices : [];
  const list = Array.isArray(texts) ? texts : Array.isArray(texts?.choices) ? texts.choices : null;
  return ids.map((id) => {
    const c = fromDecision.find((x) => x?.id === id) || {};
    const t = (list ? list.find((x) => x?.id === id) : texts[id]) || {};
    return {
      id, title: c.label || t.title || t.name || ENDING_FALLBACK[id][0],
      text: c.preview || t.text || t.summary || ENDING_FALLBACK[id][1],
      requirements: Array.isArray(c.requirements) ? c.requirements : [],
    };
  });
}

/** Jan/3000 final card (Phase A stand-in for src/ui/ending.js). Returns close(). */
export function openEndingCard(store, decision) {
  try { openClose?.(); } catch { /* */ }
  const opts = endingOptions(decision, store.data);
  let picked = null;
  const confirm = button('Escolha um final', () => resolve(), { kind: 'primary', big: true, disabled: true });
  const cards = opts.map((o) => {
    const b = h('button', { class: 'choice final-opcao', type: 'button', 'aria-pressed': 'false', onclick: () => {
      picked = o;
      for (const x of cards) { x.classList.remove('selected'); x.setAttribute('aria-pressed', 'false'); }
      b.classList.add('selected');
      b.setAttribute('aria-pressed', 'true');
      confirm.disabled = false;
      confirm.lastChild.textContent = `Escolher: ${o.title}`;
    } },
    h('span', { class: 'choice-label' }, o.title),
    h('span', { class: 'choice-hint' }, o.text),
    o.requirements.length ? h('span', { class: 'chips' }, o.requirements.map((r) => chip(r.label || String(r), r.met ? 'good' : 'muted'))) : null);
    return b;
  });
  const resolve = () => {
    if (!picked) return;
    const res = store.dispatch({ type: 'decision/resolve', id: decision.id, choiceId: picked.id });
    if (!res?.ok) { toast(res?.error || 'Não foi possível concluir agora.', 'bad'); return; }
    close();
  };
  const root = h('div', { class: ['era-cena', 'final-cena', reduceMotion() && 'sem-movimento'], role: 'dialog', 'aria-modal': 'true', 'aria-label': 'O Grande Silêncio' },
    h('div', { class: 'era-caixa' },
      h('div', { class: 'era-cartao' },
        h('div', { class: 'mono-eyebrow' }, 'Janeiro de 3000'),
        h('h2', { class: 'era-titulo' }, decision?.title || 'O Grande Silêncio'),
        h('p', { class: 'era-linha' }, decision?.body || 'O sinal que atravessou mil anos espera uma resposta. Os três caminhos estão abertos.'),
        h('div', { class: 'choices' }, cards)),
      h('div', { class: 'era-acoes' }, confirm)));
  const close = () => { root.remove(); if (openClose === close) openClose = null; };
  overlayRoot().appendChild(root);
  openClose = close;
  return close;
}


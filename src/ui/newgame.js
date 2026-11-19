// Title screen (continue / new game / pick agency) and the game over screen.
import { h, raw, chip, flagPrefix, button, icon, fmtMoney, fmtDate, fmtMonth, sectionTitle, confirmDialog, attempt, safePanel, toast, FIRST_LABELS } from './components.js';
import { playableAtStart } from './store.js';
import { emblemSVG } from './portrait.js';
import { useEmblemData, emblemSVG as drawEmblem, specFromSeed } from './emblem.js';
import { APP_VERSION } from './settings.js';

// Title poster: rocket + moon over a sunburst, in the sober palette (DESIGN §2): navy/graphite rays, a pale
// grey moon, amber only on the rocket band and flame (the "your agency" colour).
const POSTER = `<svg viewBox="0 0 320 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="poster-art">
<defs><radialGradient id="pm" cx="42%" cy="38%" r="65%"><stop offset="0" stop-color="#d9dbe0"/><stop offset="1" stop-color="#8d929c"/></radialGradient>
<linearGradient id="psky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0e16"/><stop offset="1" stop-color="#131a26"/></linearGradient>
<radialGradient id="pglow" cx="50%" cy="100%" r="70%"><stop offset="0" stop-color="#e3b341" stop-opacity=".16"/><stop offset="1" stop-color="#e3b341" stop-opacity="0"/></radialGradient></defs>
<rect width="320" height="220" fill="url(#psky)"/>
<g fill="#1a2232">${Array.from({ length: 14 }, (_, k) => {
    const a0 = Math.PI + (k / 14) * Math.PI, a1 = a0 + Math.PI / 28;
    return `<path d="M160 210L${(160 + 260 * Math.cos(a0)).toFixed(0)} ${(210 + 260 * Math.sin(a0)).toFixed(0)}L${(160 + 260 * Math.cos(a1)).toFixed(0)} ${(210 + 260 * Math.sin(a1)).toFixed(0)}Z"/>`;
  }).join('')}</g>
<rect width="320" height="220" fill="url(#pglow)"/>
<g opacity=".07" stroke="#9b9ba6" stroke-width="1" fill="none"><path d="M0 40H320M0 80H320M0 120H320M0 160H320M0 200H320M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220M280 0V220"/></g>
<circle cx="236" cy="62" r="40" fill="url(#pm)"/><circle cx="222" cy="52" r="7" fill="#7b808a" opacity=".55"/><circle cx="250" cy="74" r="5" fill="#7b808a" opacity=".55"/><circle cx="240" cy="44" r="3.5" fill="#7b808a" opacity=".55"/>
<path d="M0 220V196Q80 176 160 188Q240 176 320 196V220Z" fill="#07090d"/>
<g transform="translate(150 54) rotate(14)"><path d="M10 0Q22 16 22 50V96H-2V50Q-2 16 10 0Z" fill="#dcdee3"/><rect x="-2" y="58" width="24" height="7" fill="#e3b341"/><circle cx="10" cy="36" r="5" fill="#1f2a3c" stroke="#07090d" stroke-width="2"/><path d="M-2 76L-14 100H-2ZM22 76L34 100H22Z" fill="#3a4354"/><path d="M3 98Q10 140 17 98Z" fill="#e3b341"/><path d="M6 98Q10 122 14 98Z" fill="#f4e7c3"/></g>
<g fill="#c9ccd3"><circle cx="30" cy="30" r="1.6"/><circle cx="70" cy="18" r="1.2"/><circle cx="110" cy="44" r="1"/><circle cx="290" cy="130" r="1.4"/><circle cx="300" cy="24" r="1.1"/><circle cx="46" cy="96" r="1"/></g>
</svg>`;

// GDD "Quem você dirige": uma potência, uma média ou uma empresa. The tier is who you are, not your budget
// (China is a potência with less money than NASA; India a média with little).
const TIERS = {
  potencia: ['Potência', ''], 'potência': ['Potência', ''],
  media: ['Média', ''], 'média': ['Média', ''],
  empresa: ['Empresa', 'info'], company: ['Empresa', 'info'],
};

/** [label, chip kind] of the actor's tier: actors.json `tier` when present, else from what the actor is. */
export function tierOf(actor) {
  const t = TIERS[String(actor?.tier || '').toLowerCase()];
  if (t) return t;
  if (actor?.kind === 'company') return TIERS.empresa;
  // a power launches its own crews and cargo by policy (NASA, CNSA, Roscosmos); the rest are médias
  if (actor?.launchPolicy === 'domestic') return TIERS.potencia;
  return TIERS.media;
}

function randomSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % 1000000;
  } catch { return (Date.now() % 1000000) >>> 0; } // UI only (never in sim)
}

/** "1950 a 3000" from a scenario summary ({start, end} or legacy startYear/endYear). */
export function yearsOf(sc) {
  const a = sc?.start?.year ?? sc?.startYear;
  const b = sc?.end?.year ?? sc?.endYear;
  return a && b ? `${a} a ${b}` : sc?.subtitle || '';
}

/** True once the player has reached an ending of the campaign (unlocks 'locked' scenarios such as O Grande Silêncio). */
export function campaignDone() {
  try { return globalThis.localStorage?.getItem('adastra.campaign.done') === '1'; } catch { return false; }
}

/** Split the scenario list into the campaign and the short scenarios (Corrida Lunar first among those). */
export function titleModes(list) {
  const all = Array.isArray(list) ? list.filter(Boolean) : [];
  const campaign = all.find((x) => x.kind === 'campaign' || x.id === 'campaign') || null;
  const scenarios = all.filter((x) => x !== campaign && (!x.locked || campaignDone()))
    .sort((a, b) => (a.id === 'lunar_race' ? -1 : b.id === 'lunar_race' ? 1 : 0) || (a.start?.year ?? a.startYear ?? 0) - (b.start?.year ?? b.startYear ?? 0));
  return { campaign, scenarios };
}

/** The founding entry is styled by css/found.css (linked once). */
function ensureFoundCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-found-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/found.css', import.meta.url).href;
    l.dataset.foundCss = '1';
    document.head.appendChild(l);
  } catch { /* Node */ }
}

/** Save the raw text of a rejected save as a local file (no network: a Blob link). */
function downloadText(name, text) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    return true;
  } catch { return false; }
}

/**
 * Title screen (CSmanager .modo-inicial): Continuar (saves), Campanha 1950–3000, Cenários. Choosing a mode loads
 * its data (store.useScenario) and shows the agencies alive at its start date. onStart() runs once a game is up.
 */
export function renderTitle(root, store, { onStart, onSettings } = {}) {
  root.innerHTML = '';
  useEmblemData(store.data);
  ensureFoundCss();
  const redraw = () => renderTitle(root, store, { onStart, onSettings });
  const info = store.saveInfo();
  const { campaign, scenarios } = titleModes(store.scenarios?.() || []);
  const picker = h('div', { class: 'actor-picker hidden', id: 'escolha-agencia' });
  const notice = h('div', { class: 'title-aviso' });
  const seedInput = h('input', { type: 'number', inputmode: 'numeric', class: 'input', value: String(randomSeed()), min: '0', 'aria-label': 'Semente' });
  let busy = false;

  const startGame = (playerId) => {
    try {
      store.newGame({ playerId, seed: Number(seedInput.value) || randomSeed(), scenarioId: store.scenarioId() });
      onStart?.();
    } catch (e) {
      console.error(e);
      picker.prepend(h('div', { class: 'aviso bad' }, `Não foi possível criar o jogo: ${e.message}`));
    }
  };

  // founding branch (EXPANSION.md §5.3): the wizard takes the whole title page; cancel comes back here
  const openFounding = async () => {
    try {
      const m = await import('./found-agency.js');
      m.renderFoundWizard(root, store, { seed: Number(seedInput.value) || randomSeed(), onDone: () => onStart?.(), onCancel: () => { redraw(); } });
    } catch (e) {
      console.error(e);
      toast('Não foi possível abrir a fundação de agência.', 'bad');
    }
  };

  const fillPicker = () => {
    const data = store.data;
    useEmblemData(data);
    const playable = playableAtStart(data);
    const year = data?.scenario?.start?.year ?? data?.scenario?.startYear;
    picker.innerHTML = '';
    picker.append(
      sectionTitle(`Escolha sua agência${year ? ` · ${year}` : ''}`),
      h('p', { class: 'lead' }, year && year < 2000
        ? `As agências que existem em ${year}. Outras nascem com os anos; algumas mudam de nome.`
        : 'Cada ator tem verba, aliados e rivais próprios. O mundo reage diferente a cada campanha.'),
      playable.length ? h('div', { class: 'list actor-list' }, playable.map((a) => actorRow(store, a, () => startGame(a.id))))
        : h('div', { class: 'aviso warn' }, 'Nenhuma agência jogável nesta data.'),
      foundEntry(store, () => openFounding()),
      h('details', { class: 'advanced' },
        h('summary', null, icon('avancar', 16), 'Opções avançadas'),
        h('label', { class: 'field' }, h('span', null, 'Semente do mundo (mesma semente, mesmo mundo)'), seedInput)));
  };

  const choose = async (sc) => {
    if (busy) return;
    if (info && !(await confirmDialog('Começar um jogo novo substitui o salvamento automático (os espaços de save continuam). Continuar?', { okLabel: 'Novo jogo', danger: true, title: 'Novo jogo' }))) return;
    busy = true;
    notice.innerHTML = '';
    picker.classList.remove('hidden');
    picker.innerHTML = '';
    picker.append(h('div', { class: 'loading' }, `Preparando ${sc.name || 'o cenário'}…`));
    let ok = false;
    // a founding wizard visited before may have moved the campaign start ("Quando começar"): back to the scenario's own
    try { ok = await store.useScenario(sc.id); if (ok) await store.useStart?.(null); } catch (e) { console.error(e); }
    busy = false;
    if (!ok) {
      picker.classList.add('hidden');
      notice.append(h('div', { class: 'aviso warn' }, sc.kind === 'campaign' || sc.id === 'campaign'
        ? 'A campanha completa ainda não está disponível nesta versão. Jogue a Corrida Lunar enquanto isso.'
        : 'Este cenário não pôde ser carregado. Verifique a conexão e tente de novo.'));
      return;
    }
    fillPicker();
    picker.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const rej = store.rejection;
  const rejection = rej ? h('div', { class: 'aviso bad rejeicao', role: 'alert' },
    h('p', null, rej.message),
    h('div', { class: 'btn-row' },
      button('Exportar o save', () => {
        const raw = store.rawSave?.(rej.slot) || null;
        if (!raw || !downloadText(`adastra-save-${rej.slot || 'auto'}.json`, raw)) toast('Não foi possível exportar este save.', 'bad');
      }, { small: true, icon: 'salvar', iconSize: 16 }),
      button('Começar de novo', () => { store.dismissRejected?.(); redraw(); }, { small: true, kind: 'ghost' }))) : null;

  const otherSlots = (store.slots?.() || []).filter((s) => s.name !== 'auto' && s.info);
  const continueBtn = info && !rej ? button(`Continuar · ${info.actor?.short || info.actor?.name || String(info.playerId || '').toUpperCase()} · ${fmtDate(info.turn, info.startYear)}`, async () => {
    if (await store.loadSlot('auto')) onStart?.();
    else redraw();
  }, { kind: 'primary', icon: 'continuar', big: true }) : null;

  const campaignCard = h('button', {
    class: ['mode-card', 'mode-card-btn', !campaign && 'indisponivel'], type: 'button',
    onclick: () => choose(campaign || { id: 'campaign', kind: 'campaign', name: 'Campanha' }),
  },
  h('div', { class: 'mode-card-top' }, h('span', { class: 'idx' }, '01'), h('span', { class: 'mono-eyebrow' }, 'Campanha · 1950 a 3000'), !campaign ? chip('em breve', 'warn') : null),
  raw(POSTER, 'poster-wrap'),
  h('div', { class: 'mode-card-body' },
    h('div', { class: 'mode-card-title' }, 'Da NACA ao ano 3000'),
    h('div', { class: 'mode-card-sub' }, campaign?.blurb || campaign?.description || 'Agências nascem e somem, as eras passam, e no ano 3000 o Grande Silêncio pede uma resposta.')));

  const list = scenarios.length ? scenarios : [{ id: 'lunar_race', name: 'Corrida Lunar', startYear: 2026, endYear: 2030 }];
  const scenarioCard = h('div', { class: 'mode-card' },
    h('div', { class: 'mode-card-top' }, h('span', { class: 'idx' }, '02'), h('span', { class: 'mono-eyebrow' }, 'Cenários')),
    h('div', { class: 'mode-card-body' },
      h('div', { class: 'mode-card-title' }, 'Partidas curtas'),
      h('div', { class: 'mode-card-sub' }, 'Uma era, um objetivo, uma ou duas horas.')),
    h('div', { class: 'list scenario-list' }, list.map((sc) =>
      h('button', { class: 'list-row scenario-row', type: 'button', onclick: () => choose(sc) },
        h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, sc.name || sc.id), h('div', { class: 'list-sub' }, yearsOf(sc))),
        icon('avancar', 16, 'list-chev')))));

  const slotsBox = otherSlots.length ? h('details', { class: 'advanced title-slots' },
    h('summary', null, icon('avancar', 16), `Outros saves (${otherSlots.length})`),
    h('div', { class: 'list' }, otherSlots.map((sl) => h('button', { class: 'list-row', type: 'button', onclick: async () => { if (await store.loadSlot(sl.name)) onStart?.(); else redraw(); } },
      h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, sl.label), h('div', { class: 'list-sub' }, `${sl.info.actor?.short || String(sl.info.playerId || '').toUpperCase()} · ${fmtDate(sl.info.turn, sl.info.startYear)}`)),
      icon('avancar', 16, 'list-chev'))))) : null;

  const screen = h('div', { class: 'title-screen' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-row' }, h('span', { class: 'monogram', 'aria-hidden': 'true' }, 'AA'), h('strong', { class: 'brand-name' }, 'Ad Astra')),
      h('div', { class: 'mono-eyebrow' }, 'Agência espacial / estratégia')),
    h('div', { class: 'opening' },
      h('h1', null, 'Mil anos de corrida,', h('br'), h('em', null, 'uma agência.')),
      h('p', { class: 'tagline' }, 'Você dirige uma agência espacial. No dia do lançamento, tudo o que decidiu vira torcida.')),
    rejection,
    continueBtn || slotsBox ? h('div', { class: 'btn-col title-actions' }, continueBtn, slotsBox) : null,
    h('div', { class: 'mono-eyebrow title-sec' }, info ? 'Novo jogo' : 'Começar'),
    campaignCard,
    scenarioCard,
    notice,
    picker,
    onSettings ? h('div', { class: 'btn-col title-actions' }, button('Ajustes', onSettings, { icon: 'ajustes', big: true })) : null,
    h('footer', { class: 'title-foot' }, `v${APP_VERSION} · passado fiel até hoje; o futuro é simulação`));
  root.appendChild(h('div', { class: 'title-page' }, screen));
}

/** "Fundar a sua" entry under the agency list, when the scenario allows founding (scenario.playable.found). */
function foundEntry(store, onOpen) {
  const sc = store.data?.scenario || {};
  if (!(sc.playable?.found ?? false)) return null;
  const year = sc.start?.year ?? sc.startYear;
  return h('div', { class: 'fa-entry-wrap' },
    sectionTitle('Ou comece do zero'),
    h('button', { class: 'fa-entry', type: 'button', onclick: onOpen },
      raw(drawEmblem(specFromSeed('found-entry', { kind: 'agency', label: 'NOVA' }), { size: 40, detail: 1 }), 'fa-entry-em'),
      h('div', { class: 'list-text' },
        h('div', { class: 'list-title' }, 'Fundar a sua agência'),
        h('div', { class: 'list-sub' }, `Escolha o país, a sede e desenhe o logo. Começa pequena${year ? ` em ${year}` : ''}, 100% sua.`)),
      icon('avancar', 16, 'list-chev')));
}

/** One agency row of the picker. */
function actorRow(store, a, onPick) {
  const [diff, kind] = tierOf(a);
  return h('button', { class: 'list-row actor-option', type: 'button', onclick: onPick },
    raw(emblemSVG(a, { size: 40 }), 'actor-emblem'),
    h('div', { class: 'list-text' },
      h('div', { class: 'actor-top' },
        h('div', { class: 'list-title' }, `${flagPrefix(a)}${a.name || a.id}`),
        chip(diff, kind)),
      h('div', { class: 'list-sub' }, a.style || (a.kind === 'company' ? 'Empresa privada' : 'Agência espacial')),
      h('div', { class: 'chips' },
        a.budget ? h('span', { class: 'selo' }, `${fmtMoney(a.budget)}/ano`) : null,
        a.difficulty ? chip(`dificuldade: ${a.difficulty}`, 'muted') : null,
        a.capabilities?.crewed ? chip('voo tripulado', 'info') : chip('sem voo tripulado próprio', 'muted'),
        a.bloc ? chip(blocName(store, a.bloc), 'muted') : null)),
    icon('avancar', 16, 'list-chev'));
}

function blocName(store, blocId) {
  const b = (store.data?.actors?.blocs || []).find((x) => x.id === blocId) || store.state?.blocs?.[blocId];
  return b?.name || blocId;
}

// ------------------------------------------------------------------ fired: the campaign goes on (v0.9.13)

const OUST_TEXT = {
  fired: 'O apoio chegou a zero depois de semanas no vermelho, e quem paga as contas trocou a direção.',
  board: 'Os acionistas votaram pela troca da direção.',
};

const yearOfTurn = (st, t) => (st.startYear ?? 0) + Math.floor((Number(t) || 0) / 52);
const yearsText = (n) => (n <= 0 ? 'menos de um ano' : n === 1 ? '1 ano' : `${n} anos`);

/** One past or current tenure as a list row (Anais, game over, the fired screen). */
export function tenureRow(st, t) {
  const from = yearOfTurn(st, t.fromTurn);
  const to = t.toTurn == null ? null : yearOfTurn(st, t.toTurn);
  const why = t.reason === 'fired' ? 'demitido' : t.reason === 'board' ? 'destituído pelo conselho' : t.pending ? 'afastado' : null;
  return h('div', { class: ['list-row', 'tenure-row', t.current && 'mine'] },
    raw(emblemSVG({ id: t.actorId, name: t.name, short: t.short, emblem: t.emblem }, { size: 32 }), 'actor-emblem'),
    h('div', { class: 'list-text' },
      h('div', { class: 'list-title' }, `${t.flag ? `${t.flag} ` : ''}${t.name || t.short}`),
      h('div', { class: 'list-sub' }, [`${from}–${to ?? 'hoje'}`, why, `${t.ok ?? 0}/${t.missions ?? 0} missões`, t.firsts ? `${t.firsts} primeiro${t.firsts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')),
      t.highlights?.length ? h('div', { class: 'list-sub tenure-hl' }, t.highlights.join(' · ')) : null),
    t.current ? chip('agora', 'accent') : null);
}

/**
 * "Você foi afastado da direção da <agência>": the reason, the tenure, and the choice (another live agency, or a new
 * one founded today). The world and the save go on; time waits for the choice. opts: {onTake, onFound, onBrowse}.
 * Returns false when the player is not out (nothing drawn).
 */
export function renderOusted(root, store, { onTake, onFound, onBrowse } = {}) {
  const st = store.state;
  const s = store.tryQuery('director/status', null);
  if (!st || !s) return false;
  root.innerHTML = '';
  useEmblemData(store.data);
  ensureFoundCss();
  const me = st.actors?.[s.actorId] || {};
  const t = s.tenure || {};
  const fromY = yearOfTurn(st, t.fromTurn);
  const toY = yearOfTurn(st, s.turn);
  const league = Object.values(st.actors || {}).sort((a, b) => (b.prestige || 0) - (a.prestige || 0));
  const pos = league.findIndex((a) => a.id === s.actorId) + 1;
  const name = me.short || me.name || s.short;
  const screen = h('div', { class: 'title-screen gameover ousted' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-row' }, raw(emblemSVG(me, { size: 30 }), 'agency-emblem'), h('strong', { class: 'brand-name' }, name)),
      h('div', { class: 'mono-eyebrow' }, `Fim da sua direção · ${fmtMonth(s.turn, st.startYear)}`)),
    h('div', { class: 'opening' },
      h('h1', null, `Você foi afastado da direção da ${name}`),
      h('p', { class: 'tagline' }, s.summary || OUST_TEXT[s.reason] || s.reasonLabel)),
    safePanel(() => h('div', { class: 'go-summary' },
      sectionTitle(`Sua passagem pela ${name}`),
      h('div', { class: 'go-kpis' },
        stat('Período', `${fromY}–${toY}`),
        stat('Duração', yearsText(toY - fromY)),
        stat('Missões', `${t.ok ?? 0}/${t.missions ?? 0}`),
        stat('Os Primeiros', String(t.firsts ?? 0)),
        stat('Prestígio', String(t.prestige ?? Math.round(me.prestige || 0))),
        stat('Posição na Tabela', pos ? `${pos}º de ${league.length}` : '—')),
      t.highlights?.length ? h('div', null, sectionTitle('Destaques'),
        h('div', { class: 'list' }, t.highlights.map((x) => h('div', { class: 'list-row' },
          h('span', { class: 'list-lead needs' }, icon('trofeu', 18)),
          h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, x)))))) : null)),
    s.past?.length ? h('div', null, sectionTitle('Direções anteriores'), h('div', { class: 'list' }, s.past.map((x) => tenureRow(st, x)))) : null,
    h('div', { class: 'aviso ousted-note' }, icon('info', 16),
      h('span', null, `O mundo continua: a ${name} segue com uma nova direção, e o seu save também. Escolha onde continuar a partir de ${fmtMonth(st.turn, st.startYear)}.`)),
    h('div', { class: 'btn-col title-actions' },
      s.candidates.length ? button('Assumir outra agência', () => onTake?.(), { kind: 'primary', icon: 'continuar', big: true }) : null,
      s.canFound ? button('Fundar uma nova agência', () => onFound?.(), { icon: 'mais', big: true, kind: s.candidates.length ? undefined : 'primary' }) : null,
      !s.candidates.length && !s.canFound ? h('div', { class: 'aviso warn' }, 'Nenhuma agência pode ser assumida agora.') : null,
      onBrowse ? button('Ver o mundo antes de decidir', () => onBrowse(), { icon: 'mundo', big: true, kind: 'ghost' }) : null),
    h('footer', { class: 'title-foot' }, `v${APP_VERSION} · Ad Astra`));
  root.appendChild(h('div', { class: 'title-page' }, screen));
  try { window.scrollTo?.(0, 0); } catch { /* Node */ }
  return true;
}

/** "Assumir outra agência": the live agencies the player may direct from today (director/status candidates). */
export function renderTakePicker(root, store, { onTaken, onBack } = {}) {
  const st = store.state;
  const s = store.tryQuery('director/status', null);
  if (!st || !s) return false;
  root.innerHTML = '';
  useEmblemData(store.data);
  ensureFoundCss();
  const date = fmtMonth(st.turn, st.startYear);
  const take = async (c) => {
    const ok = await confirmDialog(`Você assume a direção da ${c.name} a partir de ${date}, com o caixa, a equipe e os programas que ela tem hoje.`, { okLabel: 'Assumir a direção', title: c.short || c.name });
    if (!ok) return;
    const res = store.dispatch({ type: 'director/take', actorId: c.id });
    if (!res?.ok) { toast(res?.error || 'Não foi possível assumir esta agência.', 'bad'); return; }
    onTaken?.(c);
  };
  const row = (c) => {
    const warn = c.note === 'Caixa no vermelho' || c.note === 'Apoio baixo';
    return h('button', { class: 'list-row actor-option', type: 'button', onclick: () => take(c) },
      raw(emblemSVG(st.actors?.[c.id] || c, { size: 40 }), 'actor-emblem'),
      h('div', { class: 'list-text' },
        h('div', { class: 'actor-top' },
          h('div', { class: 'list-title' }, `${flagPrefix(c)}${c.name}`),
          chip(`${c.rank}º na Tabela`, c.rank <= 3 ? 'info' : 'muted')),
        h('div', { class: 'list-sub' }, [c.country, c.kind === 'company' ? 'Empresa' : 'Agência', c.tier === 'minor' ? 'coadjuvante' : null].filter(Boolean).join(' · ')),
        h('div', { class: 'chips' },
          h('span', { class: 'selo' }, `${fmtMoney(c.budget)}/ano`),
          h('span', { class: 'selo' }, `caixa ${fmtMoney(c.cash)}`),
          h('span', { class: 'selo' }, `prestígio ${c.prestige}`),
          chip(c.note, warn ? 'warn' : 'muted'),
          c.crewed ? chip('voo tripulado', 'info') : null,
          c.before ? chip('já dirigiu', 'muted') : null)),
      icon('avancar', 16, 'list-chev'));
  };
  const screen = h('div', { class: 'title-screen fa-screen take-picker' },
    h('div', { class: 'fa-head' },
      h('div', { class: 'fa-top' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Voltar', onclick: () => onBack?.() }, icon('voltar', 22)),
        h('div', { class: 'fa-top-text' }, h('div', { class: 'mono-eyebrow' }, `Nova direção · ${date}`), h('div', { class: 'fa-top-title' }, 'Assumir outra agência')),
        h('span', { class: 'fa-count' }, String(s.candidates.length)))),
    h('p', { class: 'lead' }, 'As agências e empresas que existem hoje. Você chega com o que ela tem: verba, caixa, equipe, programas e rivais.'),
    s.candidates.length ? h('div', { class: 'list actor-list' }, s.candidates.map(row)) : h('div', { class: 'aviso warn' }, 'Nenhuma agência pode ser assumida agora.'),
    h('div', { class: 'btn-col title-actions' }, button('Voltar', () => onBack?.(), { big: true, kind: 'ghost' })));
  root.appendChild(h('div', { class: 'title-page' }, screen));
  try { window.scrollTo?.(0, 0); } catch { /* Node */ }
  return true;
}

const REASONS = {
  end: ['Fim do cenário', 'A era continua, mas o placar desta corrida está fechado.'],
  fired: ['Você foi demitido', 'O apoio chegou a zero. O governo trocou a direção da agência.'],
  bankrupt: ['Falência', 'O caixa não aguentou. A agência fechou as portas.'],
};

/** Game over screen with campaign summary (same language as the title screen). */
export function renderGameOver(root, store, { onNewGame, onKeepLooking } = {}) {
  root.innerHTML = '';
  const st = store.state;
  const go = st.gameOver || {};
  let [title, text] = REASONS[go.reason] || ['Fim de jogo', go.summary?.text || 'A campanha terminou.'];
  const sc = store.data?.scenario || {};
  if (go.reason === 'end') title = `Fim da ${sc.name || 'Corrida Lunar'}`;
  if (go.reason === 'ending') {
    // year 3000: the ending the player chose (data/core/ending.json texts; Phase C adds the epilogue screen)
    const ends = store.data?.ending?.choices || store.data?.ending?.endings || store.data?.ending || {};
    const e = (Array.isArray(ends) ? ends.find((x) => x?.id === go.ending) : ends[go.ending]) || {};
    const names = { contato: 'Contato', silencio: 'Silêncio', heranca: 'Herança' };
    title = `Final: ${e.title || e.name || names[go.ending] || 'o Grande Silêncio'}`;
    text = e.text || (typeof go.summary === 'string' ? go.summary : null) || 'Janeiro de 3000. Mil anos de história terminam com a sua escolha.';
  }
  const me = st.actors?.[st.playerId] || {};

  const league = attempt(() => {
    const t = store.tryQuery('league/table', null);
    const rows = Array.isArray(t) ? t : t?.rows;
    if (Array.isArray(rows) && rows.length) return rows.map((r) => ({ id: r.actorId || r.id, prestige: r.prestige ?? 0 }));
    return Object.values(st.actors || {}).map((a) => ({ id: a.id, prestige: a.prestige || 0 })).sort((a, b) => b.prestige - a.prestige);
  }, []);
  const pos = league.findIndex((r) => r.id === st.playerId) + 1;
  const missions = st.missions || [];
  const success = missions.filter((m) => m.result?.outcome === 'total' || m.result?.outcome === 'partial').length;
  const firsts = Object.entries(st.firsts || {}).filter(([, f]) => f.actorId === st.playerId);
  const tenures = attempt(() => store.tryQuery('director/tenures', []), []);

  const screen = h('div', { class: 'title-screen gameover' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-row' }, raw(emblemSVG(me, { size: 30 }), 'agency-emblem'), h('strong', { class: 'brand-name' }, `${me.short || me.name || st.playerId}`)),
      h('div', { class: 'mono-eyebrow' }, `Fim de campanha · ${fmtDate(st.turn - 1, st.startYear)}`)),
    h('div', { class: 'opening' },
      h('h1', null, title),
      h('p', { class: 'tagline' }, text)),
    safePanel(() => h('div', { class: 'go-summary' },
      sectionTitle('Resumo da campanha'),
      h('div', { class: 'go-kpis' },
        stat('Posição na Tabela', pos ? `${pos}º de ${league.length}` : '—'),
        stat('Prestígio', String(Math.round(me.prestige || 0))),
        stat('Missões', `${success}/${missions.length}`),
        stat('Os Primeiros', String(firsts.length)),
        stat('Memorial', String((st.memorial || []).length)),
        stat('Álbum', `${(st.album || []).length} cartas`),
        stat('Caixa final', fmtMoney(me.cash)),
        stat('Apoio', `${Math.round(me.support || 0)}`)))),
    firsts.length ? h('div', null, sectionTitle('Marcos conquistados'),
      h('div', { class: 'list' }, firsts.map(([id]) => h('div', { class: 'list-row' },
        h('span', { class: 'list-lead needs' }, icon('trofeu', 18)),
        h('div', { class: 'list-text' }, h('div', { class: 'list-title' }, milestoneLabel(store, id))))))) : null,
    go.summary && typeof go.summary === 'object' && go.summary.headline ? h('div', null, sectionTitle('Manchete final'), h('p', { class: 'go-headline' }, go.summary.headline)) : null,
    tenures.length > 1 ? h('div', null, sectionTitle('Suas direções'), h('div', { class: 'list' }, tenures.map((x) => tenureRow(st, x)))) : null,
    h('div', { class: 'btn-col title-actions' },
      button('Nova campanha', async () => {
        if (await confirmDialog('Começar uma campanha nova apaga este save.', { okLabel: 'Começar', title: 'Nova campanha' })) {
          store.deleteSave();
          onNewGame?.();
        }
      }, { kind: 'primary', icon: 'continuar', big: true }),
      onKeepLooking ? button('Ver o mundo final', onKeepLooking, { icon: 'mundo', big: true }) : null),
    h('footer', { class: 'title-foot' }, `v${APP_VERSION} · Ad Astra`));
  root.appendChild(h('div', { class: 'title-page' }, screen));
}

function stat(label, value) {
  return h('div', { class: 'go-kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-value' }, value));
}

export function milestoneLabel(store, id) {
  const base = String(id).split(':')[0];
  if (FIRST_LABELS[base]) return FIRST_LABELS[base];
  const goal = store.data?.scenario?.victory?.goals?.find((g) => g.id === id);
  if (goal) return goal.label;
  for (const d of store.data?.destinations?.destinations || []) {
    for (const m of d.arrivalMilestones || []) if (m.id === id && m.label) return m.label;
  }
  return String(id).replace(/[:_]/g, ' ').replace(/\b\w/, (c) => c.toUpperCase());
}

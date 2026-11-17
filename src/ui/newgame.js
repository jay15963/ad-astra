// Title screen (continue / new game / pick agency) and the game over screen.
import { h, raw, card, chip, button, fmtMoney, fmtDate, sectionTitle, confirmDialog, attempt, safePanel, FIRST_LABELS } from './components.js';
import { emblemSVG } from './portrait.js';
import { APP_VERSION } from './settings.js';

const POSTER = `<svg viewBox="0 0 320 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" class="poster-art">
<defs><radialGradient id="pm" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#f2e6c9"/><stop offset="1" stop-color="#cdbf9f"/></radialGradient></defs>
<g opacity=".18" stroke="#4fb3d9" stroke-width="1" fill="none"><path d="M0 40H320M0 80H320M0 120H320M0 160H320M0 200H320M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220M280 0V220"/></g>
<g fill="#e2553a" opacity=".9">${Array.from({ length: 14 }, (_, k) => {
    const a0 = Math.PI + (k / 14) * Math.PI, a1 = a0 + Math.PI / 28;
    return `<path d="M160 210L${(160 + 260 * Math.cos(a0)).toFixed(0)} ${(210 + 260 * Math.sin(a0)).toFixed(0)}L${(160 + 260 * Math.cos(a1)).toFixed(0)} ${(210 + 260 * Math.sin(a1)).toFixed(0)}Z"/>`;
  }).join('')}</g>
<circle cx="236" cy="62" r="40" fill="url(#pm)"/><circle cx="222" cy="52" r="7" fill="#b9a988"/><circle cx="250" cy="74" r="5" fill="#b9a988"/><circle cx="240" cy="44" r="3.5" fill="#b9a988"/>
<path d="M0 220V196Q80 176 160 188Q240 176 320 196V220Z" fill="#0b1020"/>
<g transform="translate(150 54) rotate(14)"><path d="M10 0Q22 16 22 50V96H-2V50Q-2 16 10 0Z" fill="#f7f1e3"/><rect x="-2" y="58" width="24" height="7" fill="#e2553a"/><circle cx="10" cy="36" r="5" fill="#28628f" stroke="#0b1020" stroke-width="2"/><path d="M-2 76L-14 100H-2ZM22 76L34 100H22Z" fill="#e2553a"/><path d="M3 98Q10 140 17 98Z" fill="#e2ad35"/><path d="M6 98Q10 122 14 98Z" fill="#f7f1e3"/></g>
<g fill="#f7f1e3"><circle cx="30" cy="30" r="1.6"/><circle cx="70" cy="18" r="1.2"/><circle cx="110" cy="44" r="1"/><circle cx="290" cy="130" r="1.4"/><circle cx="300" cy="24" r="1.1"/><circle cx="46" cy="96" r="1"/></g>
</svg>`;

function difficultyOf(actor) {
  const b = Number(actor?.budget) || 0;
  if (b >= 8000) return ['Potência', 'good'];
  if (b >= 3000) return ['Média', 'accent'];
  return ['Desafio', 'warn'];
}

function actorInfo(store, id) {
  return store.data?.index?.actors?.[id] || { id, name: id.toUpperCase(), short: id.toUpperCase() };
}

function randomSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % 1000000;
  } catch { return (Date.now() % 1000000) >>> 0; } // UI only (never in sim)
}

/** Title screen. onStart() is called once a game is loaded or created. */
export function renderTitle(root, store, { onStart, onSettings } = {}) {
  root.innerHTML = '';
  const sc = store.data?.scenario || {};
  const info = store.saveInfo();
  const picker = h('div', { class: 'actor-picker hidden' });
  const startNew = async () => {
    if (info && !(await confirmDialog('Começar um jogo novo substitui o save atual. Continuar?', { okLabel: 'Novo jogo', danger: true, title: 'Novo jogo' }))) return;
    picker.classList.remove('hidden');
    picker.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const seedInput = h('input', { type: 'number', inputmode: 'numeric', class: 'input', value: String(randomSeed()), min: '0', 'aria-label': 'Semente' });
  const playable = sc.playableActors?.length ? sc.playableActors : Object.keys(store.data?.index?.actors || {});

  picker.append(
    sectionTitle('Escolha sua agência'),
    h('p', { class: 'muted small' }, 'Cada ator tem verba, aliados e rivais próprios. O mundo reage diferente a cada campanha.'),
    ...playable.map((id) => {
      const a = actorInfo(store, id);
      const [diff, kind] = difficultyOf(a);
      return card({
        cls: 'actor-option', onClick: () => start(id),
        icon: raw(emblemSVG(a, { size: 48 })),
        title: `${a.flag ? a.flag + ' ' : ''}${a.name || id}`,
        subtitle: a.style || (a.kind === 'company' ? 'Empresa privada' : 'Agência espacial'),
        right: chip(diff, kind),
      },
      h('div', { class: 'chips' },
        a.budget ? chip(`${fmtMoney(a.budget)}/ano`, 'muted') : null,
        a.capabilities?.crewed ? chip('voo tripulado', 'info') : chip('sem voo tripulado próprio', 'muted'),
        a.bloc ? chip(blocName(store, a.bloc), 'muted') : null));
    }),
    h('details', { class: 'advanced' },
      h('summary', null, 'Opções avançadas'),
      h('label', { class: 'field' }, h('span', null, 'Semente do mundo (mesma semente, mesmo mundo)'), seedInput)));

  const start = (playerId) => {
    try {
      store.newGame({ playerId, seed: Number(seedInput.value) || randomSeed() });
      onStart?.();
    } catch (e) {
      console.error(e);
      picker.prepend(h('div', { class: 'fallback' }, `Não foi possível criar o jogo: ${e.message}`));
    }
  };

  root.appendChild(h('div', { class: 'title-screen' },
    h('div', { class: 'poster' },
      raw(POSTER, 'poster-wrap'),
      h('div', { class: 'poster-text' },
        h('div', { class: 'poster-kicker' }, `Era ${sc.era || 4} · A Década Lunar`),
        h('h1', { class: 'poster-title' }, 'Ad Astra'),
        h('div', { class: 'poster-sub' }, `${sc.name || 'Corrida Lunar'} · ${sc.subtitle || '2026 a 2030'}`))),
    h('p', { class: 'tagline' }, 'Você dirige uma agência espacial. No dia do lançamento, tudo o que decidiu vira torcida.'),
    h('div', { class: 'btn-col title-actions' },
      info ? button(`Continuar · ${info.actor?.short || info.actor?.name || String(info.playerId || '').toUpperCase()} · ${fmtDate(info.turn, info.startYear)}`, () => {
        if (store.load()) onStart?.();
        else root.prepend(h('div', { class: 'fallback' }, 'O save não pôde ser lido (versão antiga?). Comece um jogo novo.'));
      }, { kind: 'primary', icon: '▶' }) : null,
      button(info ? 'Novo jogo' : 'Começar', startNew, { kind: info ? 'ghost' : 'primary', icon: '✦' }),
      onSettings ? button('Ajustes', onSettings, { kind: 'ghost', icon: '⚙' }) : null),
    picker,
    sc.victory?.description ? h('p', { class: 'muted small center' }, sc.victory.description) : null,
    h('footer', { class: 'title-foot muted small' }, `v${APP_VERSION} · dados reais até nov/2026, futuro é simulação`)));
}

function blocName(store, blocId) {
  const b = (store.data?.actors?.blocs || []).find((x) => x.id === blocId) || store.state?.blocs?.[blocId];
  return b?.name || blocId;
}

const REASONS = {
  end: ['Fim da Corrida Lunar', 'Dezembro de 2030. A era continua, mas o placar desta corrida está fechado.'],
  fired: ['Você foi demitido', 'O apoio chegou a zero. O governo trocou a direção da agência.'],
  bankrupt: ['Falência', 'O caixa não aguentou. A agência fechou as portas.'],
};

/** Game over screen with campaign summary. */
export function renderGameOver(root, store, { onNewGame, onKeepLooking } = {}) {
  root.innerHTML = '';
  const st = store.state;
  const go = st.gameOver || {};
  const [title, text] = REASONS[go.reason] || ['Fim de jogo', go.summary?.text || 'A campanha terminou.'];
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

  root.appendChild(h('div', { class: 'title-screen gameover' },
    h('div', { class: 'poster small' }, raw(POSTER, 'poster-wrap'),
      h('div', { class: 'poster-text' }, h('div', { class: 'poster-kicker' }, fmtDate(st.turn - 1, st.startYear)), h('h1', { class: 'poster-title' }, title))),
    h('p', { class: 'tagline' }, text),
    safePanel(() => card({ title: 'Resumo da campanha', icon: raw(emblemSVG(me, { size: 40 })) },
      h('div', { class: 'stat-grid' },
        stat('Posição na Tabela', pos ? `${pos}º de ${league.length}` : '—'),
        stat('Prestígio', String(Math.round(me.prestige || 0))),
        stat('Missões', `${success}/${missions.length} com sucesso`),
        stat('Os Primeiros', String(firsts.length)),
        stat('Memorial', String((st.memorial || []).length)),
        stat('Álbum', `${(st.album || []).length} cartas`),
        stat('Caixa final', fmtMoney(me.cash)),
        stat('Apoio', `${Math.round(me.support || 0)}`)))),
    firsts.length ? card({ title: 'Marcos conquistados' }, h('div', { class: 'chips' }, firsts.map(([id]) => chip(milestoneLabel(store, id), 'good')))) : null,
    go.summary && typeof go.summary === 'object' && go.summary.headline ? card({ title: 'Manchete final' }, h('p', null, go.summary.headline)) : null,
    h('div', { class: 'btn-col' },
      onKeepLooking ? button('Ver o mundo final', onKeepLooking, { kind: 'ghost', icon: '🌍' }) : null,
      button('Nova campanha', async () => {
        if (await confirmDialog('Começar uma campanha nova apaga este save.', { okLabel: 'Começar', title: 'Nova campanha' })) {
          store.deleteSave();
          onNewGame?.();
        }
      }, { kind: 'primary', icon: '✦' }))));
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
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

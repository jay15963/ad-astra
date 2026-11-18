// Settings / accessibility screen + app version (so players know the phone has the latest build).
import { h, card, button, segmented, toast, confirmDialog, sectionTitle, viewHead, eraInfo } from './components.js';

export const APP_VERSION = '0.9.2';          // keep in sync with package.json "version"
export const BUILD_DATE = '2026-11-18';      // bump on every deploy
export const BUILD = '2026.11.19-2';        // build id shown in Ajustes (bump with BUILD_DATE; keep sw.js SW_VERSION = APP_VERSION)

/** Apply settings to the document (text scale, motion, colorblind palette). */
export function applySettings(settings) {
  try {
    const root = document.documentElement;
    root.style.setProperty('--text-scale', String(settings.textScale || 1));
    document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
    document.body.classList.toggle('colorblind', !!settings.colorblind);
  } catch { /* not in a browser */ }
}

/** Intervention timer from settings: 5 (default), 10, or 0 for no limit. */
export function interventionSecondsOf(settings) {
  const v = Number(settings?.interventionSeconds);
  return v === 0 || v === 10 ? v : 5;
}

function toggleRow(label, hint, value, onChange) {
  const id = `opt-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return h('label', { class: 'toggle-row', for: id },
    h('div', { class: 'toggle-text' }, h('div', { class: 'toggle-label' }, label), hint ? h('div', { class: 'toggle-hint' }, hint) : null),
    h('input', { type: 'checkbox', id, class: 'switch', checked: !!value, onchange: (e) => onChange(e.target.checked) }));
}

/**
 * render(container, store, {onExit, onQuit}) — full settings view.
 * onQuit: go back to title screen; onExit: close settings.
 */
export function render(container, store, { onExit, onQuit } = {}) {
  const s = store.settings;
  const set = (patch) => { store.setSettings(patch); applySettings(store.settings); };

  const era = eraInfo(store.state, store.data);
  container.appendChild(h('div', { class: 'view-pad settings' },
    viewHead('Preferências', {
      lead: `Era ${era.n || 4} · ${era.name || 'A Década Lunar'} · v${APP_VERSION}`,
      right: onExit ? button('Voltar', onExit, { kind: 'ghost', icon: 'voltar', small: true }) : null,
    }),

    sectionTitle('Som e toque'),
    card({ cls: 'settings-group' },
      toggleRow('Som', 'Música de tensão e efeitos sintetizados no lançamento.', s.sound, (v) => set({ sound: v })),
      toggleRow('Vibração', 'Vibra nos marcos do lançamento e nas decisões urgentes.', s.vibrate, (v) => {
        set({ vibrate: v });
        if (v) store.vibrate(40);
      })),

    sectionTitle('Acessibilidade'),
    card({ cls: 'settings-group' },
      toggleRow('Reduzir movimento', 'Sem animações de contagem, ticker parado, transições curtas.', s.reduceMotion, (v) => set({ reduceMotion: v })),
      toggleRow('Modo daltonismo', 'Azul e laranja no lugar de verde e vermelho, sempre com ícones.', s.colorblind, (v) => set({ colorblind: v })),
      h('div', { class: 'toggle-row col' },
        h('div', { class: 'toggle-label' }, 'Tamanho do texto'),
        segmented([{ id: 1, label: 'A' }, { id: 1.15, label: 'A+' }, { id: 1.3, label: 'A++' }], s.textScale || 1, (v) => {
          set({ textScale: v });
          rerender();
        }, { cls: 'text-scale' })),
      h('div', { class: 'toggle-row col' },
        h('div', { class: 'toggle-label' }, 'Tempo das intervenções'),
        h('div', { class: 'toggle-hint' }, 'Quanto tempo você tem para responder a um cartão no lançamento. Sem resposta, a sala mantém o plano.'),
        segmented([{ id: 5, label: '5 s' }, { id: 10, label: '10 s' }, { id: 0, label: 'Sem limite' }], interventionSecondsOf(s), (v) => {
          set({ interventionSeconds: v });
          rerender();
        }, { cls: 'iv-time' }))),

    sectionTitle('Instalar'),
    installCard(),

    sectionTitle('Jogo salvo'),
    card({},
      h('p', { class: 'muted small', style: { margin: 0 } }, 'O jogo salva sozinho a cada ação. Fechar o app nunca muda o resultado de um lançamento.'),
      store.saveError ? h('div', { class: 'aviso warn' }, `Aviso: não foi possível salvar (${store.saveError}).`) : null,
      h('div', { class: 'btn-col' },
        store.state ? button('Exportar save', () => exportSave(store), { icon: 'transferir' }) : null,
        button('Importar save', () => importSave(store), { icon: 'caixa' }),
        onQuit && store.state ? button('Voltar à tela inicial', onQuit, { icon: 'voltar' }) : null,
        button('Apagar jogo salvo', async () => {
          const ok = await confirmDialog('Apagar o jogo salvo deste aparelho? Não dá para desfazer.', { okLabel: 'Apagar', danger: true, title: 'Apagar save' });
          if (!ok) return;
          store.deleteSave();
          toast('Jogo salvo apagado.', 'warn');
          onQuit?.();
        }, { kind: 'danger', icon: 'fechar' }))),

    sectionTitle('Sobre'),
    card({ cls: 'about' },
      h('div', { class: 'about-line' }, 'Ad Astra'),
      h('div', { class: 'muted small' }, 'Se o número do build não bater com o anúncio, recarregue a página para pegar a versão nova.'),
      swStatusLine(),
      h('div', { class: 'muted small' }, 'Corte vertical "Corrida Lunar" (2026 a 2030). Nomes reais usados só como referência histórica; sem logotipos oficiais.'),
      h('div', null, button('Recarregar app', () => { try { location.reload(); } catch { /* */ } }, { small: true, icon: 'carregando', iconSize: 16 }))),
    h('div', { class: 'about-foot' }, `v${APP_VERSION} · build ${BUILD} · ${BUILD_DATE.split('-').reverse().join('/')}`)));

  function rerender() {
    container.innerHTML = '';
    render(container, store, { onExit, onQuit });
  }
}

// ------------------------------------------------------------------ install (PWA)

// Chrome/Edge/Brave/Samsung fire beforeinstallprompt once the manifest + worker qualify; keep it for the button.
const install = { prompt: null, installed: false, redraw: null };
try {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // no mini-infobar: the player installs from Ajustes
      install.prompt = e;
      install.redraw?.();
    });
    window.addEventListener('appinstalled', () => {
      install.prompt = null;
      install.installed = true;
      install.redraw?.();
    });
  }
} catch { /* not in a browser */ }

/** Where the game is running: 'standalone' (installed app), 'ios' (Safari on iPhone/iPad), 'android', 'other'. */
export function installContext(nav = globalThis.navigator, mm = globalThis.matchMedia) {
  try {
    const standalone = nav?.standalone === true || !!mm?.('(display-mode: standalone)')?.matches || !!mm?.('(display-mode: fullscreen)')?.matches;
    if (standalone) return 'standalone';
    const ua = String(nav?.userAgent || '');
    // iPadOS 13+ reports itself as a Mac with touch
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
  } catch { /* */ }
  return 'other';
}

/** "Instalar app" card: native prompt when the browser offers one, otherwise step-by-step instructions. */
function installCard() {
  const body = h('div', { class: 'install-body' });
  const draw = () => {
    body.innerHTML = '';
    const ctx = installContext();
    if (install.installed || ctx === 'standalone') {
      body.append(h('div', { class: 'aviso ok' }, 'Ad Astra já está instalado neste aparelho. Ele abre em tela cheia e funciona sem internet depois da primeira visita.'));
      return;
    }
    body.append(h('p', { class: 'muted small', style: { margin: 0 } }, 'Instale o jogo como um app: ícone na tela inicial, tela cheia sem barra do navegador e jogo offline. O save continua o mesmo.'));
    if (install.prompt) {
      body.append(h('div', { class: 'btn-col' }, button('Instalar app', async () => {
        const ev = install.prompt;
        if (!ev) return;
        install.prompt = null; // a prompt can be shown only once
        try {
          await ev.prompt();
          const choice = await ev.userChoice;
          if (choice?.outcome === 'accepted') { install.installed = true; toast('Ad Astra instalado. Procure o ícone na tela inicial.', 'good'); }
        } catch (e) { toast(`Não foi possível instalar: ${e?.message || e}`, 'bad'); }
        draw();
      }, { kind: 'primary', big: true })));
      return;
    }
    const steps = ctx === 'ios'
      ? ['Abra este jogo no Safari.', 'Toque em Compartilhar (o quadrado com a seta para cima).', 'Escolha "Adicionar à Tela de Início" e toque em Adicionar.']
      : ctx === 'android'
      ? ['Abra o menu do navegador (⋮ no Chrome, ≡ no Brave).', 'Toque em "Instalar app" ou "Adicionar à tela inicial".', 'Confirme. O ícone do Ad Astra aparece junto dos seus apps.']
      : ['No Chrome ou Edge, use o ícone de instalar na barra de endereço ou o menu ⋮ › "Instalar Ad Astra".', 'No celular, abra o jogo no Chrome (Android) ou no Safari (iPhone) e adicione à tela inicial.'];
    body.append(h('ol', { class: 'install-steps small', style: { paddingLeft: '1.3em', margin: '6px 0 0', lineHeight: '1.5' } }, steps.map((t) => h('li', null, t))));
  };
  draw();
  // one Ajustes screen at a time: the latest card is the one that redraws when the browser offers/installs
  install.redraw = () => { if (body.isConnected) draw(); };
  return card({ cls: 'install' }, body);
}

/** One line about the offline/update worker; filled in asynchronously. */
function swStatusLine() {
  const el = h('div', { class: 'muted small sw-status' }, 'Atualização automática: verificando…');
  try {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (!sw) { el.textContent = 'Atualização automática: indisponível neste navegador (recarregue para atualizar).'; return el; }
    sw.getRegistration().then((reg) => {
      el.textContent = !reg ? 'Atualização automática: desligada neste navegador (recarregue para pegar a versão nova).'
        : reg.active
        ? 'Atualização automática ativa: cada arquivo é conferido com o servidor; sem rede, o jogo abre com a cópia guardada.'
        : 'Atualização automática: ainda instalando (ativa na próxima abertura).';
    }).catch(() => { el.textContent = 'Atualização automática: indisponível.'; });
  } catch { el.textContent = 'Atualização automática: indisponível.'; }
  return el;
}

function exportSave(store) {
  try {
    const text = store.exportSave();
    if (!text) return;
    const blob = new Blob([text], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `adastra-save-sem${store.state.turn}.json` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Save exportado.', 'good');
  } catch (e) {
    toast(`Falha ao exportar: ${e.message}`, 'bad');
  }
}

function importSave(store) {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    try {
      store.importSave(await f.text());
      toast('Save importado.', 'good');
    } catch (e) {
      toast(`Save inválido: ${e.message}`, 'bad');
    }
  });
  document.body.appendChild(input);
  input.click();
}

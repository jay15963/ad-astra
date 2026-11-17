// Settings / accessibility screen + app version (so players know the phone has the latest build).
import { h, card, button, segmented, toast, confirmDialog, sectionTitle } from './components.js';

export const APP_VERSION = '0.1.0';          // keep in sync with package.json "version"
export const BUILD_DATE = '2026-11-17';      // bump on every deploy

/** Apply settings to the document (text scale, motion, colorblind palette). */
export function applySettings(settings) {
  try {
    const root = document.documentElement;
    root.style.setProperty('--text-scale', String(settings.textScale || 1));
    document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
    document.body.classList.toggle('colorblind', !!settings.colorblind);
  } catch { /* not in a browser */ }
}

function toggleRow(label, hint, value, onChange) {
  const id = `opt-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return h('label', { class: 'toggle-row', for: id },
    h('div', { class: 'toggle-text' }, h('div', { class: 'toggle-label' }, label), hint ? h('div', { class: 'muted small' }, hint) : null),
    h('input', { type: 'checkbox', id, class: 'switch', checked: !!value, onchange: (e) => onChange(e.target.checked) }));
}

/**
 * render(container, store, {onExit, onQuit}) — full settings view.
 * onQuit: go back to title screen; onExit: close settings.
 */
export function render(container, store, { onExit, onQuit } = {}) {
  const s = store.settings;
  const set = (patch) => { store.setSettings(patch); applySettings(store.settings); };

  container.appendChild(h('div', { class: 'view-pad settings' },
    h('div', { class: 'view-head' },
      onExit ? button('Voltar', onExit, { kind: 'ghost', icon: '‹', small: true }) : null,
      h('h1', { class: 'view-title' }, 'Ajustes')),

    sectionTitle('Som e toque'),
    card({},
      toggleRow('Som', 'Música de tensão e efeitos sintetizados no lançamento.', s.sound, (v) => set({ sound: v })),
      toggleRow('Vibração', 'Vibra nos marcos do lançamento e nas decisões urgentes.', s.vibrate, (v) => {
        set({ vibrate: v });
        if (v) store.vibrate(40);
      })),

    sectionTitle('Acessibilidade'),
    card({},
      toggleRow('Reduzir movimento', 'Sem animações de contagem, ticker parado, transições curtas.', s.reduceMotion, (v) => set({ reduceMotion: v })),
      toggleRow('Modo daltonismo', 'Azul e laranja no lugar de verde e vermelho, sempre com ícones.', s.colorblind, (v) => set({ colorblind: v })),
      h('div', { class: 'toggle-row col' },
        h('div', { class: 'toggle-label' }, 'Tamanho do texto'),
        segmented([{ id: 1, label: 'A' }, { id: 1.15, label: 'A+' }, { id: 1.3, label: 'A++' }], s.textScale || 1, (v) => {
          set({ textScale: v });
          rerender();
        }, { cls: 'text-scale' }))),

    sectionTitle('Jogo salvo'),
    card({},
      h('p', { class: 'muted small' }, 'O jogo salva sozinho a cada ação. Fechar o app nunca muda o resultado de um lançamento.'),
      store.saveError ? h('p', { class: 'warn-text small' }, `Aviso: não foi possível salvar (${store.saveError}).`) : null,
      h('div', { class: 'btn-col' },
        store.state ? button('Exportar save', () => exportSave(store), { kind: 'ghost', icon: '⇩' }) : null,
        button('Importar save', () => importSave(store), { kind: 'ghost', icon: '⇧' }),
        onQuit && store.state ? button('Voltar à tela inicial', onQuit, { kind: 'ghost', icon: '⌂' }) : null,
        button('Apagar jogo salvo', async () => {
          const ok = await confirmDialog('Apagar o jogo salvo deste aparelho? Não dá para desfazer.', { okLabel: 'Apagar', danger: true, title: 'Apagar save' });
          if (!ok) return;
          store.deleteSave();
          toast('Jogo salvo apagado.', 'warn');
          onQuit?.();
        }, { kind: 'danger', icon: '🗑' }))),

    sectionTitle('Sobre'),
    card({ cls: 'about' },
      h('div', { class: 'about-line' }, h('strong', null, 'Ad Astra'), ` · versão ${APP_VERSION}`),
      h('div', { class: 'muted small' }, `Build de ${BUILD_DATE.split('-').reverse().join('/')}. Se este número não bater com o anúncio, recarregue a página para pegar a versão nova.`),
      h('div', { class: 'muted small' }, 'Corte vertical "Corrida Lunar" (2026 a 2030). Nomes reais usados só como referência histórica; sem logotipos oficiais.'),
      button('Recarregar app', () => { try { location.reload(); } catch { /* */ } }, { kind: 'ghost', small: true, icon: '↻' }))));

  function rerender() {
    container.innerHTML = '';
    render(container, store, { onExit, onQuit });
  }
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

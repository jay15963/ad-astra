// Arquivo do Eco (drawer › Arquivo; docs/EXPANSION.md §9, GDD "o mistério do Eco"): as peças reunidas era a era, a
// inclinação da agência (Contato · Silêncio · Herança) e o Colégio Silêncio. Só lê query('eco/summary') (src/sim/eco.js).
import { h, chip } from './components.js';
import { listRow, ensurePainelCss } from './decisions.js';
import { screenHead, section, kpis, listCard, note, countChip } from './screen-kit.js';

const LEAN = [['contato', 'Contato'], ['silencio', 'Silêncio'], ['heranca', 'Herança']];

/** Pure view model of the archive (tests and render). */
export function ecoModel(sum) {
  if (!sum) return null;
  const total = LEAN.reduce((a, [k]) => a + Math.max(0, sum.lean?.[k] || 0), 0);
  return {
    count: sum.pieces.length, total: sum.total,
    pieces: sum.pieces.slice().sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0)),
    lean: LEAN.map(([k, label]) => ({ id: k, label, value: Math.round(sum.lean?.[k] || 0), share: total ? (sum.lean?.[k] || 0) / total : 0 })),
    dominant: LEAN.find(([k]) => k === sum.dominant)?.[1] || null,
    colegio: sum.colegio, families: sum.families || [],
  };
}

export function render(container, store) {
  ensurePainelCss();
  const m = ecoModel(store.tryQuery('eco/summary', null));
  const wrap = h('div', { class: 'view-pad tela eco-arquivo' },
    screenHead({ title: 'Arquivo do Eco', lead: m ? `${m.count} de ${m.total} peças reunidas` : 'Ainda nada para guardar' }));
  if (!m || !m.count) {
    wrap.append(note('Cada era guarda um pedaço do Eco: uma anomalia de rádio, uma falha de telemetria, um padrão nos dados. As peças que a agência encontrar ficam aqui.', { icon: 'eco' }));
    container.appendChild(wrap);
    return;
  }
  wrap.append(
    // the dominant lean first and wide (one tile + two halves, no empty cell); every tile shows its share
    kpis(m.lean.slice().sort((a, b) => (b.label === m.dominant) - (a.label === m.dominant)).map((l) => ({
      label: l.label, value: String(l.value), wide: l.label === m.dominant,
      sub: l.label === m.dominant ? `${Math.round(l.share * 100)}% da inclinação · para onde a agência pende` : `${Math.round(l.share * 100)}% da inclinação`,
    })), { label: 'Inclinação da agência' }),
    section('Peças', { right: countChip(m.count) }, listCard(m.pieces.map((p) => listRow({
      lead: h('span', { class: 'mono' }, p.era ? String(p.era) : '·'), title: p.title, sub: p.line || null, meta: p.year != null ? String(p.year) : '',
    })))),
    m.colegio ? section('Colégio Silêncio', {}, listCard([listRow({
      lead: h('span', { class: 'mono' }, '◌'), title: `Desde ${m.colegio.since}`, sub: `Relação com a agência: ${Math.round(m.colegio.rel ?? 0)}`,
      right: (m.colegio.rel ?? 0) >= 50 ? chip('aliado', 'accent') : null,
    })])) : null,
    m.families.length ? section('Famílias da agência', { right: countChip(m.families.length) }, listCard(m.families.slice(0, 12).map((f) => listRow({
      lead: h('span', { class: 'mono' }, String(f.gen ?? '')), title: f.surname || '—',
      sub: [f.gen ? `${f.gen} gerações` : null, f.from != null ? `${f.from}–${f.to}` : null, f.first && f.last && f.first !== f.last ? `de ${f.first} a ${f.last}` : null].filter(Boolean).join(' · '),
    })))) : null,
  );
  container.appendChild(wrap);
}

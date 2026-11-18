// Conselho (drawer › Agência; docs/EXPANSION.md §5, §12): who owns the agency, what each shareholder demands
// (mandates), the open funding round, buy-back and dividends. Reads query('investors/board') (src/sim/investors.js)
// and acts only through store.dispatch. Layout: title → one primary action → sections (screen-kit), DESIGN.md
// tokens; the few board-only styles are injected once (no global stylesheet edits). Mobile-first: no row is wider
// than the 320 px viewport (flex + min-width: 0 + ellipsis everywhere).
import { h, raw, button, chip, bar, fmtMoney, fmtMonth, toast, openModal, confirmDialog, emptyState } from './components.js';
import { emblemSVG as actorEmblemSVG } from './portrait.js';
import { listRow, ensurePainelCss, openDecision, afterResolveTarget } from './decisions.js';
import { screenHead, section, kpis, listCard, note, countChip, rerender } from './screen-kit.js';

// B1's emblem renderer (§5.4 specs) when present; the round portrait emblem otherwise
const emblemMod = await import('./emblem.js').catch(() => null);

/** SVG of a holder emblem spec (§5.4) or of an actor. */
export function specSVG(spec, size = 32, fallback = {}) {
  try {
    if (spec && typeof spec === 'object' && typeof emblemMod?.emblemSVG === 'function') return emblemMod.emblemSVG(spec, { size });
  } catch { /* fall through */ }
  return actorEmblemSVG({ color: spec?.field || fallback.color || '#3a3f4a', emblem: spec?.label || fallback.short || fallback.name || '?', short: fallback.short, name: fallback.name }, { size });
}

function actorSVG(actor, size = 40) {
  try {
    if (typeof emblemMod?.actorEmblemSVG === 'function') return emblemMod.actorEmblemSVG(actor, { size });
  } catch { /* fall through */ }
  return actorEmblemSVG(actor || {}, { size });
}

const pct = (p) => `${Math.round(Number(p) || 0)}%`;

/** Mood word + bar tone (0..100). */
export function moodInfo(m) {
  const v = Number.isFinite(m) ? m : 50;
  if (v < 20) return { label: 'Furioso', kind: 'bad' };
  if (v < 40) return { label: 'Insatisfeito', kind: 'warn' };
  if (v < 60) return { label: 'Neutro', kind: '' };
  if (v < 80) return { label: 'Satisfeito', kind: 'good' };
  return { label: 'Entusiasmado', kind: 'good' };
}

const TYPE_PT = { satellite: 'Satélite', probe: 'Sonda', crewed: 'Tripulada', cargo: 'Carga', station: 'Estação', lander: 'Pouso' };

// ------------------------------------------------------------------ styles (board-only)

const CSS = `
.conselho .bd-cota{background:var(--s1);border:1px solid var(--line);border-radius:var(--r-card);padding:14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.conselho .bd-cota-topo{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;flex-wrap:wrap;min-width:0}
.conselho .bd-cota-num{display:flex;flex-direction:column;gap:2px;min-width:0}
.conselho .bd-cota-num b{font-family:var(--mono);font-size:var(--t24);font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.1;color:var(--text)}
.conselho .bd-eyebrow{font-size:var(--t10);text-transform:uppercase;letter-spacing:.08em;color:var(--text-3)}
.conselho .bd-barra{position:relative;display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--s4)}
.conselho .bd-seg{height:100%;min-width:2px;border-right:1px solid var(--s1)}
.conselho .bd-seg:last-child{border-right:0}
.conselho .bd-seg.sua{background:var(--yellow)}
.conselho .bd-seg.s0{background:#6b6b78}.conselho .bd-seg.s1{background:#4f4f5a}.conselho .bd-seg.s2{background:#3c3c46}.conselho .bd-seg.s3{background:#2f2f38}
.conselho .bd-marca{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text);opacity:.8}
.conselho .bd-marcas{position:relative;height:14px;font-size:var(--t10);color:var(--text-3);font-family:var(--mono)}
.conselho .bd-marcas span{position:absolute;transform:translateX(-50%);white-space:nowrap}
.conselho .bd-legenda{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:var(--t11);color:var(--text-2);min-width:0}
.conselho .bd-legenda i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:0}
.conselho .bd-oferta{background:var(--s1);border:1px solid var(--line);border-radius:var(--r-card);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:0}
.conselho .bd-oferta-topo{display:flex;align-items:center;gap:10px;min-width:0}
.conselho .bd-oferta-topo .bd-emb{flex:none;line-height:0}
.conselho .bd-oferta-nome{flex:1;min-width:0;display:flex;flex-direction:column}
.conselho .bd-oferta-nome b{font-size:var(--t13);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conselho .bd-oferta-nome span{font-size:var(--t11);color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conselho .bd-oferta-num{flex:none;text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;display:flex;flex-direction:column}
.conselho .bd-oferta-num b{font-size:var(--t15);font-weight:600}
.conselho .bd-oferta-num span{font-size:var(--t10);color:var(--text-3)}
.conselho .bd-oferta p{margin:0;font-size:var(--t11);color:var(--text-2);line-height:1.45}
.conselho .bd-oferta .btn-row{display:flex;gap:8px;flex-wrap:wrap}
.conselho .bd-oferta .btn-row .btn{flex:1 1 120px}
.conselho .bd-humor{flex:none;width:64px;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.conselho .bd-humor .bar{width:100%}
.conselho .bd-humor span{font-family:var(--mono);font-size:var(--t10);color:var(--text-3)}
.conselho .bd-pct{font-family:var(--mono);font-size:var(--t13);font-weight:600;font-variant-numeric:tabular-nums}
.conselho .bd-hist{display:grid;grid-template-columns:auto 1fr auto;gap:6px 10px;align-items:center;font-size:var(--t11);color:var(--text-2);background:var(--s1);border:1px solid var(--line);border-radius:var(--r-card);padding:12px 14px}
.conselho .bd-hist .mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.conselho .bd-hist .bar{min-width:0}
.conselho .bd-acoes{display:flex;gap:8px;flex-wrap:wrap}
.conselho .bd-acoes .btn{flex:1 1 140px}
.bd-folha{display:flex;flex-direction:column;gap:12px;min-width:0}
.bd-folha .bd-folha-topo{display:flex;align-items:center;gap:12px;min-width:0}
.bd-folha .bd-folha-topo>span:first-child{flex:none;line-height:0}
.bd-folha .bd-folha-topo div{min-width:0}
.bd-folha .bd-folha-topo b{display:block;font-size:var(--t15);font-weight:600}
.bd-folha .bd-folha-topo small{color:var(--text-3);font-size:var(--t11)}
.bd-folha p{margin:0;font-size:var(--t12);color:var(--text-2);line-height:1.5}
.bd-folha dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0;font-size:var(--t12)}
.bd-folha dt{color:var(--text-3)}
.bd-folha dd{margin:0;text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text);min-width:0;overflow-wrap:anywhere}
.bd-folha .bd-passos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.bd-folha .bd-passos .btn{flex-direction:column;height:auto;min-height:52px;padding:6px 8px;gap:0;line-height:1.25}
.bd-folha .bd-passos .btn>span{display:flex;flex-direction:column;align-items:center;gap:2px}
.bd-folha .bd-passos .btn small{font-family:var(--mono);font-size:var(--t10);color:var(--text-3)}
.bd-folha .btn-col{display:flex;flex-direction:column;gap:8px}
`;
function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.getElementById('bd-css')) return;
    document.head.appendChild(h('style', { id: 'bd-css' }, CSS));
  } catch { /* styles are progressive */ }
}

// ------------------------------------------------------------------ pieces

function stakeCard(v, me) {
  const segs = [h('span', { class: 'bd-seg sua', style: `width:${v.playerPct}%`, title: `Você: ${pct(v.playerPct)}` })];
  v.holders.forEach((x, i) => segs.push(h('span', { class: `bd-seg s${Math.min(i, 3)}`, style: `width:${x.pct}%`, title: `${x.name}: ${pct(x.pct)}` })));
  const marks = [[v.autonomyPct, `${v.autonomyPct}% autonomia`], [100 - v.cap, `mín. ${100 - v.cap}%`]];
  return h('section', { class: 'bd-cota', 'aria-label': 'Divisão das ações' },
    h('div', { class: 'bd-cota-topo' },
      h('div', { class: 'bd-cota-num' }, h('span', { class: 'bd-eyebrow' }, `${me.short || 'Sua agência'} · suas ações`), h('b', null, pct(v.playerPct))),
      v.autonomous ? chip('Com autonomia', 'good') : chip('Sem autonomia', 'bad')),
    h('div', { class: 'bd-barra', role: 'img', 'aria-label': `Você tem ${pct(v.playerPct)}; investidores ${pct(v.investorsPct)}` },
      ...segs, ...marks.map(([p]) => h('span', { class: 'bd-marca', style: `left:calc(${p}% - 1px)`, 'aria-hidden': 'true' }))),
    h('div', { class: 'bd-marcas', 'aria-hidden': 'true' }, marks.map(([p, t]) => h('span', { style: `left:${p}%` }, t))),
    h('div', { class: 'bd-legenda' },
      h('span', null, h('i', { style: 'background:var(--yellow)' }), `Você ${pct(v.playerPct)}`),
      ...v.holders.slice(0, 4).map((x, i) => h('span', null, h('i', { class: `bd-seg s${Math.min(i, 3)}` }), `${x.short || x.name} ${pct(x.pct)}`)),
      v.holders.length > 4 ? h('span', null, `+${v.holders.length - 4}`) : null),
    note(v.autonomous
      ? `Com ${v.autonomyPct}% ou mais, você manda: pode recusar ou adiar um mandato, e o conselho não pode tirar você.`
      : `Abaixo de ${v.autonomyPct}%, os mandatos são obrigatórios e um conselho furioso pode trocar a direção.`, { kind: v.autonomous ? '' : 'warn', icon: v.autonomous ? 'info' : 'alerta' }));
}

function offerCard(store, container, route, v, o) {
  const after = v.playerPct - o.pct;
  const accept = async () => {
    if (v.autonomous && after < v.autonomyPct) {
      const ok = await confirmDialog(`Vendendo ${o.pct}% você fica com ${pct(after)} e perde a autonomia: os mandatos passam a ser obrigatórios.`, { okLabel: 'Vender mesmo assim', title: 'Perder a autonomia?' });
      if (!ok) return;
    }
    const res = store.dispatch({ type: 'investors/accept', offerId: o.id });
    if (res?.ok) toast(`${o.name} entra com ${fmtMoney(res.cashM)}.`, 'good');
    else toast(res?.error || 'A oferta não está mais disponível.', 'bad');
    rerender(container, render, store, route);
  };
  return h('article', { class: 'bd-oferta' },
    h('div', { class: 'bd-oferta-topo' },
      raw(specSVG(o.emblem, 36, { name: o.name }), 'bd-emb'),
      h('div', { class: 'bd-oferta-nome' }, h('b', null, o.name), h('span', null, `${o.profileLabel || 'Investidor'} · ${o.termYears} anos`)),
      h('div', { class: 'bd-oferta-num' }, h('b', null, fmtMoney(o.cashM)), h('span', null, `por ${o.pct}%`))),
    h('p', null, o.choice?.preview || ''),
    h('div', { class: 'btn-row' }, button(`Vender ${o.pct}%`, accept, { kind: 'primary', small: true })));
}

function holderSheet(store, container, route, v, x) {
  const st = store.state;
  const me = st.actors?.[st.playerId] || {};
  const cash = me.cash ?? 0;
  const steps = [1, 5, 10, x.pct].filter((p, i, a) => p <= x.pct && a.indexOf(p) === i && p >= 1);
  const mi = moodInfo(x.mood);
  openModal((close) => {
    const buy = async (p) => {
      const price = Math.round(x.buyback1 * p * 10) / 10;
      const ok = await confirmDialog(`Recomprar ${p}% de ${x.name} por ${fmtMoney(price)} (valor da agência + 15%).`, { okLabel: 'Recomprar', title: 'Recompra de ações' });
      if (!ok) return;
      const res = store.dispatch({ type: 'investors/buyback', holderId: x.id, pct: p });
      if (res?.ok) { toast(res.regainedAutonomy ? 'Você recuperou a autonomia.' : `Recompra de ${p}% feita.`, 'good'); close(); rerender(container, render, store, route); } else toast(res?.error || 'Não foi possível recomprar.', 'bad');
    };
    return h('div', { class: 'bd-folha' },
      h('div', { class: 'bd-folha-topo' }, raw(specSVG(x.emblem, 52, x), ''), h('div', null, h('b', null, x.name), h('small', null, `${x.kindLabel}${x.anchor ? ' · dono original' : ''}`))),
      h('dl', null,
        h('dt', null, 'Participação'), h('dd', null, pct(x.pct)),
        h('dt', null, 'Humor'), h('dd', null, `${Math.round(x.mood ?? 50)} · ${mi.label}`),
        h('dt', null, 'Cobra'), h('dd', null, x.profileLabel || '—'),
        h('dt', null, 'Mandatos abertos'), h('dd', null, String(x.openMandates)),
        h('dt', null, 'Desde'), h('dd', null, fmtMonth(x.sinceTurn ?? 0, st.startYear))),
      bar(x.mood ?? 50, { kind: mi.kind, label: 'Humor' }),
      h('p', null, 'Recomprar custa o valor da agência mais 15%. Sem sócios, menos mandatos no seu calendário.'),
      h('div', { class: 'bd-passos' }, steps.map((p) => {
        const price = Math.round(x.buyback1 * p * 10) / 10;
        const b = button(h('span', null, p === x.pct ? `Tudo (${p}%)` : `${p}%`, h('small', null, fmtMoney(price))), () => buy(p), { disabled: price > cash + Math.max(0, (me.budget || 0) * 0.1) });
        return b;
      })));
  }, { title: 'Acionista' });
}

function mandateSheet(store, container, route, v, md) {
  const st = store.state;
  const nav = (res) => { const t = afterResolveTarget(res); if (t) store.ui?.navigate?.(t.tab, t.sub); };
  const card = (st.decisions || []).find((d) => d.kind === 'investors/mandate' && d.payload?.mandateId === md.id);
  const missionId = (md.missionIds || []).find((id) => (st.missions || []).some((m) => m.id === id && !['done', 'cancelled'].includes(m.status)));
  const op = (o, close) => {
    const res = store.dispatch({ type: 'investors/mandate', mandateId: md.id, op: o });
    if (!res?.ok) { toast(res?.error || 'Não foi possível.', 'bad'); return; }
    close();
    if (o === 'accept' || o === 'mission') { if (res.openBuilder) nav(res); else rerender(container, render, store, route); toast(res.missionError ? `Mandato aceito. ${res.missionError}` : 'Mandato aceito: escolha o foguete e a nave.', res.missionError ? 'warn' : 'good'); return; }
    toast(o === 'postpone' ? 'Prazo adiado em um ano.' : 'Mandato recusado.', 'info');
    rerender(container, render, store, route);
  };
  openModal((close) => h('div', { class: 'bd-folha' },
    h('div', { class: 'bd-folha-topo' }, raw(specSVG(md.holder?.emblem, 52, md.holder || {}), ''), h('div', null, h('b', null, md.title), h('small', null, md.holder?.name || 'Investidor'))),
    h('dl', null,
      h('dt', null, 'Missão'), h('dd', null, `${TYPE_PT[md.type] || md.type} · ${md.destName}`),
      h('dt', null, 'Prazo'), h('dd', null, `${fmtMonth(md.deadlineTurn, st.startYear)}${md.weeksLeft < 0 ? ' (vencido)' : ''}`),
      md.rewardM > 0 ? [h('dt', null, 'Prêmio'), h('dd', null, fmtMoney(md.rewardM))] : null,
      !v.autonomous && md.penalty?.cashM ? [h('dt', null, 'Se perder o prazo'), h('dd', null, `multa ${fmtMoney(md.penalty.cashM)}${md.penalty.pct ? ` e ${md.penalty.pct}% das ações` : ''}`)] : null,
      h('dt', null, 'Situação'), h('dd', null, md.statusLabel)),
    h('p', null, md.source === 'calendar'
      ? 'Programa do governo: o briefing da missão chega perto da data. Adiar ou cancelar no briefing custa o humor do sócio.'
      : v.autonomous ? 'Com a maioria das ações você pode adiar uma vez ou recusar (humor −15).' : 'Sem autonomia: o mandato é obrigatório.'),
    h('div', { class: 'btn-col' },
      missionId ? button('Abrir a missão', () => { close(); store.ui?.navigate?.('missoes', `m/${missionId}`); }, { kind: 'primary', big: true, icon: 'missoes' })
        : md.source !== 'calendar' ? button(card ? 'Aceitar e escolher o veículo' : 'Criar a missão', () => op(card ? 'accept' : 'mission', close), { kind: 'primary', big: true, icon: 'missoes' }) : null,
      md.source !== 'calendar' && v.autonomous && !md.postponed ? button('Adiar um ano', () => op('postpone', close), { big: true }) : null,
      md.source !== 'calendar' && v.autonomous ? button('Recusar o mandato', () => op('decline', close), { kind: 'danger', big: true }) : null)), { title: 'Mandato' });
}

function dividendSheet(store, container, route, v) {
  const st = store.state;
  const me = st.actors?.[st.playerId] || {};
  const opts = [0.01, 0.02, 0.05].map((f) => Math.max(1, Math.round(v.valuationM * f)));
  openModal((close) => h('div', { class: 'bd-folha' },
    h('p', null, `Dividendos melhoram o humor de todos os sócios. Caixa agora: ${fmtMoney(me.cash ?? 0)}.`),
    h('div', { class: 'bd-passos' }, opts.map((amt) => {
      const gain = Math.min(20, Math.round((amt / Math.max(1, v.valuationM)) * 400));
      return button(h('span', null, fmtMoney(amt), h('small', null, `humor +${gain}`)), () => {
        const res = store.dispatch({ type: 'investors/dividend', amountM: amt });
        if (res?.ok) { toast(`Dividendos pagos: humor +${res.moodGain}.`, 'good'); close(); rerender(container, render, store, route); } else toast(res?.error || 'Não foi possível pagar.', 'bad');
      }, { disabled: amt > (me.cash ?? 0) });
    }))), { title: 'Pagar dividendos' });
}

// ------------------------------------------------------------------ screen

export function render(container, store, route) {
  ensurePainelCss();
  ensureCss();
  const st = store.state;
  const me = st?.actors?.[st?.playerId] || {};
  const v = store.tryQuery('investors/board', null);
  const root = h('div', { class: 'view-pad tela conselho' });
  container.appendChild(root);
  if (!v) {
    root.append(screenHead({ title: 'Conselho', lead: 'Acionistas e mandatos' }),
      emptyState(st?.cap ? 'O conselho ainda está se reunindo. Volte depois do próximo turno.' : 'Nesta partida a agência não tem acionistas.', 'acoes'));
    return;
  }
  const again = () => rerender(container, render, store, route);
  const mood = v.boardMood;
  const mi = moodInfo(mood ?? 50);
  const roundCard = v.round ? (st.decisions || []).find((d) => d.id === v.round.decisionId) : null;
  const primary = v.round ? { label: v.round.offers.length > 1 ? `Ver as ${v.round.offers.length} ofertas da rodada` : 'Ver a oferta da rodada', icon: 'acoes', onClick: () => root.querySelector('#bd-rodada')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
    : v.openMandates.some((m) => m.pendingCard) ? { label: 'Responder ao mandato novo', icon: 'alerta', onClick: () => { const d = (st.decisions || []).find((x) => x.kind === 'investors/mandate'); if (d) openDecision(store, d.id); } } : null;

  const year = (st.startYear ?? 0) + Math.floor((st.turn ?? 0) / 52);
  root.append(...[
    screenHead({ title: 'Conselho', lead: `${me.short || me.name || ''} · acionistas, mandatos e rodadas`, emblem: actorSVG(me, 40), primary }),
    v.lowRounds > 0 && !v.autonomous ? note(`O conselho está ${mi.label.toLowerCase()} (humor ${mood}). Se continuar abaixo de ${v.removalMood} na próxima rodada, a direção é trocada.`, { kind: 'bad', icon: 'alerta' }) : null,
    stakeCard(v, me),
    kpis([
      { label: 'Valor da agência', value: fmtMoney(v.valuationM), sub: v.lastRoundTurn != null ? `última rodada ${fmtMonth(v.lastRoundTurn, st.startYear)}` : v.unlocked ? 'rodadas uma vez por ano' : `rodadas a partir de ${v.unlockYear}` },
      { label: 'Humor do conselho', value: mood == null ? '—' : String(mood), tone: mood != null && mood < 40 ? 'down' : mood != null && mood >= 60 ? 'up' : '', sub: mood == null ? 'sem sócios' : mi.label },
      { label: 'Missões por ano', value: String(v.agenda.K), sub: `${v.agenda.M} dos sócios · ${v.agenda.own} ${v.agenda.own === 1 ? 'sua' : 'suas'}` },
      { label: `Suas em ${year}`, value: `${v.agenda.ownUsed}/${v.agenda.own}`, tone: v.agenda.ownUsed > v.agenda.own ? 'down' : '', sub: v.autonomous ? 'sem limite do conselho' : 'cota do conselho' },
    ], { label: 'Números do conselho' }),
    v.round ? section('Rodada de investimento', { id: 'bd-rodada', right: countChip(v.round.offers.length) },
      ...v.round.offers.map((o) => offerCard(store, container, route, v, o)),
      roundCard ? h('div', { class: 'bd-acoes' }, button('Recusar todas', () => { const r = store.dispatch({ type: 'decision/resolve', id: roundCard.id, choiceId: 'none' }); if (r?.ok) toast('Rodada recusada.', 'info'); again(); }, { kind: 'ghost' })) : null,
      v.round.expiresTurn != null ? note(`As ofertas valem até ${fmtMonth(v.round.expiresTurn, st.startYear)}. Investidores juntos podem ter até ${v.cap}%.`) : null) : null,
    section('Mandatos em aberto', { right: countChip(v.openMandates.length) },
      v.openMandates.length ? listCard(v.openMandates.slice().sort((a, b) => a.deadlineTurn - b.deadlineTurn).map((md) => listRow({
        lead: raw(specSVG(md.holder?.emblem, 30, md.holder || {})), leadCls: 'pn-emblem',
        title: md.title, sub: `${md.holder?.name || 'Investidor'} · ${md.destName}`, meta: fmtMonth(md.deadlineTurn, st.startYear),
        right: md.pendingCard ? chip('responder', 'warn') : md.status === 'flying' ? chip('em voo', 'info') : md.weeksLeft < 13 ? chip('prazo curto', 'bad') : md.source === 'calendar' ? chip('programa', 'muted') : null,
        cls: md.pendingCard ? 'mine' : null,
        onClick: () => mandateSheet(store, container, route, v, md),
      }))) : note(v.agenda.M > 0 ? 'Nenhum mandato agora. Os sócios mandam os pedidos no começo de cada ano.' : 'Sem sócios com poder de mandato: o calendário é todo seu.')),
    section('Acionistas', { right: countChip(v.holders.length + 1) },
      listCard([
        listRow({ lead: raw(actorSVG(me, 30)), leadCls: 'pn-emblem', title: `${me.short || me.name || 'Você'} (direção)`, sub: v.autonomous ? 'maioria das ações' : 'minoria', right: h('span', { class: 'bd-pct' }, pct(v.playerPct)), cls: 'mine' }),
        ...v.holders.map((x) => {
          const m2 = moodInfo(x.mood);
          return listRow({
            lead: raw(specSVG(x.emblem, 30, x)), leadCls: 'pn-emblem', title: x.name,
            sub: `${x.kindLabel}${x.profileLabel ? ` · ${x.profileLabel}` : ''}`,
            right: h('span', { class: 'bd-humor' }, h('b', { class: 'bd-pct' }, pct(x.pct)), bar(x.mood ?? 50, { kind: m2.kind }), h('span', null, m2.label.toLowerCase())),
            onClick: () => holderSheet(store, container, route, v, x),
          });
        }),
      ]),
      v.holders.length ? h('div', { class: 'bd-acoes' }, button('Pagar dividendos', () => dividendSheet(store, container, route, v), { icon: 'caixa' })) : null),
    v.history.length ? section('Histórico', {},
      h('div', { class: 'bd-hist' }, v.history.slice(-6).reverse().map((y) => [
        h('span', { class: 'mono' }, y.span || y.decade ? `${y.year}–${String(y.year + (y.span || 10) - 1).slice(-2)}` : String(y.year)),
        bar(y.playerPct, { kind: y.playerPct >= v.autonomyPct ? 'accent' : 'warn' }),
        h('span', { class: 'mono' }, `${pct(y.playerPct)}${y.raisedM ? ` · +${fmtMoney(y.raisedM).replace('US$ ', '')}` : ''}`),
      ]))) : null,
    v.pastMandates.length ? section('Mandatos encerrados', { right: countChip(v.pastMandates.length) },
      listCard(v.pastMandates.slice(0, 8).map((md) => listRow({
        lead: raw(specSVG(md.holder?.emblem, 30, md.holder || {})), leadCls: 'pn-emblem', title: md.title,
        sub: `${md.holder?.name || 'Ex-sócio'} · ${md.destName}`,
        right: chip(md.declined ? 'recusado' : md.statusLabel.toLowerCase(), md.status === 'done' ? 'good' : md.declined ? 'muted' : 'bad'),
      })))) : null,
  ].filter(Boolean));
}

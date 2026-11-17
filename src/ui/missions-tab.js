// Missões: list by status, 3-step builder (alvo/tipo -> veículo/nave/tripulação/config -> resumo) and contracts.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtBand, fmtPct, fmtDate, fmtIn, fmtMonth,
  TYPE_LABELS, TYPE_ICONS, STATUS_LABELS, OUTCOME_TEXT, STRATEGY_LABELS, ROLE_LABELS, TRUTH_LABELS,
} from './components.js';
import { portraitSVG, emblemSVG } from './portrait.js';
import { decisionRow, sortDecisions } from './decisions.js';

const TYPES = ['satellite', 'probe', 'crewed', 'cargo', 'station', 'lander'];
const TYPE_HINT = {
  satellite: 'Órbita terrestre, retorno rápido', probe: 'Ciência longe de casa', crewed: 'Gente a bordo: glória e risco',
  cargo: 'Suprimentos e contratos', station: 'Módulos em órbita', lander: 'Descer em outro mundo',
};
// fallback compatibility when missions/draftOptions is not available yet
const TYPE_KINDS = {
  satellite: ['satellite'], probe: ['probe', 'rover'], crewed: ['capsule'], cargo: ['cargo'], station: ['station_module'], lander: ['lander', 'rover'],
};
const MARGINS = [0, 0.1, 0.2, 0.3];

const ui = {
  seg: 'lista',
  step: 1,
  draft: null,
  launchTurn: null,
  name: '',
  openedRoute: null,
};

function newDraft(patch = {}) {
  return {
    source: 'custom', type: null, destination: null, vehicleId: null, spacecraftId: null, secondarySpacecraftId: null,
    crew: { flightDirector: null, commander: null, astronauts: [] },
    config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: null },
    ...patch,
  };
}

/** Mission type to preselect for a destination: its own list (missionTypes) first, then a guess from the id. */
export function defaultTypeFor(dest, currentType = null) {
  const list = Array.isArray(dest?.missionTypes) && dest.missionTypes.length ? dest.missionTypes : null;
  if (list) return list.includes(currentType) ? currentType : list[0];
  const id = String(dest?.id || '');
  if (/surface|south_pole/.test(id)) return 'lander';
  if (id === 'iss') return 'cargo';
  if (['leo', 'sso', 'gto'].includes(id)) return currentType && ['satellite', 'crewed', 'cargo', 'station'].includes(currentType) ? currentType : 'satellite';
  return currentType && currentType !== 'satellite' ? currentType : 'probe';
}

/** Start the builder on a destination (map "Planejar missão"): destination + a compatible type, step 1. */
/** Launcher name for a mission; calendar programs on a retired rocket carry their own name (Ariane 5). */
export function vehicleLabel(m, idx) {
  return m?.vehicleName || (m?.calendarId && idx?.calendar?.[m.calendarId]?.vehicleName) || idx?.vehicles?.[m?.vehicleId]?.name || m?.vehicleId || null;
}

export function planMissionFor(store, destId) {
  const dest = store.data?.index?.destinations?.[destId];
  if (!dest) return false;
  const keep = ui.draft && ui.draft.source === 'custom' ? ui.draft : null;
  ui.draft = newDraft({ ...(keep ? { config: keep.config } : {}), destination: destId, type: defaultTypeFor(dest, keep?.type) });
  ui.step = 1; ui.noFd = false; ui.noCraft = false; ui.launchTurn = null;
  ui.seg = 'nova';
  return true;
}

/** The builder's current draft (read-only use: tests, debugging). */
export function currentDraft() { return ui.draft; }

export function render(container, store) {
  const st = store.state;
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  const sub = route.sub || '';
  if (sub === 'nova' || sub === 'contratos' || sub === 'lista') ui.seg = sub;
  else if (sub.startsWith('m/')) ui.seg = 'lista';
  // the map hands a destination over (store.ui.pendingDestination): preselect it once, then forget it
  if (store.ui && store.ui.pendingDestination) {
    const destId = store.ui.pendingDestination;
    store.ui.pendingDestination = null;
    planMissionFor(store, destId);
  }
  if (!ui.draft) ui.draft = newDraft();

  const go = (seg) => { ui.seg = seg; store.ui?.navigate ? store.ui.navigate('missoes', seg) : rerender(); };
  const rerender = () => { container.innerHTML = ''; render(container, store); };

  const contracts = getContracts(store);
  const offers = (st.decisions || []).filter((d) => String(d.kind).startsWith('contract'));
  const root = h('div', { class: 'view-pad missions' },
    h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'Missões')),
    segmented([
      { id: 'lista', label: 'Programa' },
      { id: 'nova', label: 'Montar' },
      { id: 'contratos', label: 'Contratos', badge: offers.length || null },
    ], ui.seg, go));
  container.appendChild(root);

  if (ui.seg === 'nova') root.appendChild(safePanel(() => builder(store, rerender), 'A montagem de missões ainda está em construção.'));
  else if (ui.seg === 'contratos') root.appendChild(safePanel(() => contractsView(store, contracts, offers, go), 'Contratos indisponíveis por enquanto.'));
  else root.appendChild(safePanel(() => listView(store, go), 'A lista de missões não pôde ser exibida.'));

  // deep link from the dashboard: #missoes/m/<id> opens the mission sheet once
  if (sub.startsWith('m/') && ui.openedRoute !== sub) {
    ui.openedRoute = sub;
    const m = (st.missions || []).find((x) => x.id === sub.slice(2));
    if (m) setTimeout(() => openMission(store, m.id), 0);
  } else if (!sub.startsWith('m/')) ui.openedRoute = null;
}

// ------------------------------------------------------------------ list

const GROUPS = [
  ['Em voo', ['launch', 'transit', 'arrival', 'operations']],
  ['Agendadas', ['scheduled']],
  ['Em planejamento', ['planning']],
  ['Concluídas', ['done']],
  ['Canceladas', ['cancelled']],
];

function listView(store, go) {
  const st = store.state;
  const q = store.tryQuery('missions/list', null);
  const missions = Array.isArray(q) ? q : (st.missions || []);
  const related = sortDecisions((st.decisions || []).filter((d) => /^(launch|briefing|mission)/.test(String(d.kind))));
  const out = h('div');
  if (related.length) {
    out.append(sectionTitle('Aguardando você'), h('div', { class: 'decision-list' }, related.map((d) => decisionRow(store, d))));
  }
  if (!missions.length) {
    out.append(emptyState('Nenhuma missão no programa ainda. Briefings do calendário e contratos chegam com o tempo — ou monte a sua.', '🚀'),
      button('Montar uma missão', () => go('nova'), { kind: 'primary', icon: '+' }));
    return out;
  }
  for (const [label, statuses] of GROUPS) {
    const list = missions.filter((m) => statuses.includes(m.status))
      .sort((a, b) => (a.launchTurn ?? a.createdTurn ?? 0) - (b.launchTurn ?? b.createdTurn ?? 0));
    if (label === 'Concluídas' || label === 'Canceladas') list.reverse();
    if (!list.length) continue;
    out.append(sectionTitle(label, chip(String(list.length), 'muted')), h('div', { class: 'mission-list' }, list.slice(0, label === 'Canceladas' ? 5 : 30).map((m) => missionCard(store, m))));
  }
  out.append(button('Montar nova missão', () => go('nova'), { kind: 'ghost', icon: '+' }));
  return out;
}

/**
 * True when the mission's result is only the ascent's (the probe is still on its way): the outcome chip would claim
 * "Sucesso total" before arrival. The card then shows the flight status, and the ascent as a secondary chip.
 */
export function isProvisionalResult(m) {
  const r = m?.result;
  if (!r || r.outcome == null) return false;
  if (['launch', 'transit', 'arrival'].includes(m.status)) return true;
  return m.status === 'operations' && r.phase === 'ascent' && !!m.transit;
}

function outcomeKindOf(outcome) {
  return outcome === 'total' ? 'good' : outcome === 'partial' ? 'accent' : outcome === 'recoverable' ? 'warn' : 'bad';
}

function missionCard(store, m) {
  const st = store.state;
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[m.destination]?.name || m.destination || '—';
  const veh = vehicleLabel(m, idx) || 'sem veículo';
  const provisional = isProvisionalResult(m);
  const ascent = provisional ? m.result : null;
  const res = provisional ? null : m.result;
  const outcomeKind = res ? outcomeKindOf(res.outcome) : null;
  return card({
    cls: `mission-card st-${m.status}`, onClick: () => openMission(store, m.id), icon: TYPE_ICONS[m.type] || '🚀',
    title: m.name || 'Missão', subtitle: `${TYPE_LABELS[m.type] || m.type || ''} · ${dest} · ${veh}`,
    right: res ? chip(OUTCOME_TEXT[res.outcome] || res.outcome, outcomeKind)
      : chip(STATUS_LABELS[m.status] || m.status, m.status === 'scheduled' ? 'accent' : provisional ? 'info' : 'muted'),
  },
  h('div', { class: 'chips' },
    ascent ? chip(ascent.outcome === 'total' ? '✓ subida ok' : `subida: ${(OUTCOME_TEXT[ascent.outcome] || ascent.outcome).toLowerCase()}`, outcomeKindOf(ascent.outcome)) : null,
    m.launchTurn != null && !m.result ? chip(`🗓 ${fmtMonth(m.launchTurn, st.startYear)} · ${fmtIn(m.launchTurn, st.turn)}`, 'muted') : null,
    m.estimate && !m.result ? chip(`Chance ${fmtBand(m.estimate.low, m.estimate.high)}`, 'info') : null,
    !m.result && crewRiskOf(m.estimate) != null ? chip(crewRiskText(crewRiskOf(m.estimate)), 'warn', { class: 'ms-crewrisk-chip' }) : null,
    m.source === 'calendar' ? chip('calendário real', 'muted') : m.source === 'contract' ? chip('contrato', 'muted') : null,
    m.paid === false && m.status === 'planning' ? chip('não paga', 'warn') : null,
    m.stranded && m.status === 'planning' ? chip('sem data antes do fim', 'bad') : null,
    Number.isFinite(m.readyTurn) && m.readyTurn > st.turn && !m.result ? chip(`hardware pronto em ${fmtMonth(m.readyTurn, st.startYear)}`, 'warn') : null),
  m.transit && m.status === 'transit' ? bar(((st.turn - m.transit.departTurn) / Math.max(1, m.transit.arriveTurn - m.transit.departTurn)) * 100, { key: `mt.${m.id}`, label: `Chegada ${fmtIn(m.transit.arriveTurn, st.turn)}`, kind: 'accent' }) : null);
}

/** Mission sheet: details, crew, result report and actions. */
export function openMission(store, missionId) {
  const get = () => store.tryQuery('missions/get', null, missionId) || (store.state.missions || []).find((m) => m.id === missionId);
  const m = get();
  if (!m) { toast('Missão não encontrada.', 'warn'); return; }
  const st = store.state;
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[m.destination];
  const sc = idx.spacecraft?.[m.spacecraftId];
  openModal((close) => {
    const crewIds = [m.crew?.flightDirector, m.crew?.commander, ...(m.crew?.astronauts || [])].filter(Boolean);
    const uniq = [...new Set(crewIds)];
    const actions = h('div', { class: 'btn-col' });
    if (m.status === 'planning') {
      const opts = launchTurnOptions(store, m, null);
      const hint = windowHint(store, m, null);
      actions.append(...[h('div', { class: 'muted small' }, 'Agendar lançamento:'),
        hint ? h('div', { class: 'tiny muted' }, hint) : null,
        opts.length ? h('div', { class: 'chips wrap' }, opts.map((o) => chip(o.label, 'accent', {
          onclick: () => {
            const r = store.dispatch({ type: 'mission/schedule', missionId: m.id, launchTurn: o.turn });
            if (r?.ok) { toast(`Agendada para ${fmtDate(o.turn, st.startYear)}.`, 'good'); close(); } else toast(scheduleErrorText(r), 'bad', 5000);
          },
        }))) : h('p', { class: 'small warn-text' }, noSlotText(store, m, null))].filter(Boolean));
    }
    if (['planning', 'scheduled'].includes(m.status)) {
      actions.append(button('Cancelar missão', async () => {
        if (!(await confirmDialog(`Cancelar "${m.name}"? Parte do dinheiro gasto não volta, e a imprensa vai notar.`, { okLabel: 'Cancelar missão', danger: true, cancelLabel: 'Manter' }))) return;
        const r = store.dispatch({ type: 'mission/cancel', missionId: m.id });
        if (r?.ok) { toast('Missão cancelada.', 'warn'); close(); } else toast(r?.error || 'Não foi possível cancelar.', 'bad');
      }, { kind: 'danger', icon: '✕' }));
    }
    const r = m.result;
    const calDef = m.calendarId ? (store.data?.calendar?.missions || []).find((x) => x.id === m.calendarId) : null;
    const calText = calDef?.partnersText || null;
    return h('div', { class: 'mission-sheet' },
      h('div', { class: 'chips' },
        chip(STATUS_LABELS[m.status] || m.status, 'accent'), chip(TYPE_LABELS[m.type] || m.type || '—', 'muted'),
        m.launchTurn != null ? chip(`🗓 ${fmtDate(m.launchTurn, st.startYear)}`, 'muted') : null,
        m.cost != null ? chip(fmtMoney(m.cost), 'muted') : null),
      m.source === 'calendar' ? h('p', { class: 'tiny muted' }, 'Programa do calendário real: destino, tipo e tripulação já estão definidos.') : null,
      calText ? h('p', { class: 'tiny muted' }, calText) : null,
      h('div', { class: 'kv' },
        kv('Destino', dest?.name || m.destination || '—'),
        Number.isFinite(m.readyTurn) && m.readyTurn > st.turn ? kv('Hardware pronto', `${fmtDate(m.readyTurn, st.startYear)} (${fmtIn(m.readyTurn, st.turn)})`) : null,
        kv('Veículo', vehicleLabel(m, idx) || '—'),
        kv('Espaçonave', sc?.name || m.spacecraftId || '—'),
        m.secondarySpacecraftId ? kv('Módulo de apoio', idx.spacecraft?.[m.secondarySpacecraftId]?.name || m.secondarySpacecraftId) : null,
        kv('Estratégia', STRATEGY_LABELS[m.config?.strategy] || '—'),
        kv('Margem de combustível', m.config?.fuelMargin != null ? fmtPct(m.config.fuelMargin) : '—')),
      m.estimate && !r ? chanceGauge(m.estimate) : null,
      uniq.length ? h('div', null, sectionTitle('Equipe'), h('div', { class: 'crew-strip' }, uniq.map((id) => crewMini(store, id)))) : null,
      r ? resultReport(store, m) : null,
      m.transit?.events?.length ? h('div', null, sectionTitle('Diário de bordo'), h('ul', { class: 'log-list' }, m.transit.events.map((e) => h('li', null, typeof e === 'string' ? e : (e.text || e.title || e.eventId || ''))))) : null,
      actions);
  }, { title: m.name || 'Missão' });
}

function resultReport(store, m) {
  const r = m.result;
  const kind = outcomeKindOf(r.outcome);
  const provisional = isProvisionalResult(m);
  const causes = (r.causes || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const CK = { part: '🔩 Peça', decision: '🧭 Decisão', luck: '🎲 Sorte', environment: '🌩 Ambiente', crew: '👩‍🚀 Equipe' };
  return h('div', { class: 'report' },
    sectionTitle('Relatório'),
    h('div', { class: `outcome-banner ob-${kind}` }, provisional ? `Subida: ${OUTCOME_TEXT[r.outcome] || r.outcome}` : OUTCOME_TEXT[r.outcome] || r.outcome),
    provisional ? h('p', { class: 'small muted' }, m.transit?.arriveTurn != null
      ? `A nave segue viagem: o resultado da missão sai na chegada, ${fmtIn(m.transit.arriveTurn, store.state.turn)}.`
      : 'A nave segue viagem: o resultado da missão sai na chegada.') : null,
    causes.length ? h('ol', { class: 'causes' }, causes.map((c) => h('li', null,
      h('span', { class: 'cause-kind' }, CK[c.kind] || c.kind), ' ', h('strong', null, c.label || ''), c.detail ? h('div', { class: 'muted small' }, c.detail) : null))) : null,
    h('div', { class: 'chips' },
      r.prestige ? chip(`+${Math.round(r.prestige)} prestígio`, 'good') : null,
      r.science ? chip(`+${Math.round(r.science)} ciência`, 'info') : null),
    (r.headlines || []).length ? h('div', { class: 'headlines' }, r.headlines.map((t) => h('blockquote', null, t))) : null);
}

function kv(k, v) {
  return h('div', { class: 'kv-row' }, h('span', { class: 'muted' }, k), h('span', null, v));
}

function crewMini(store, id) {
  const c = store.state.crew?.[id];
  if (!c) return null;
  return h('div', { class: 'crew-mini' }, raw(portraitSVG(c.portrait || c.id, { size: 44, mood: c.status === 'dead' ? 'dead' : 'neutral' }), 'face'),
    h('div', { class: 'small' }, c.name?.split(' ')[0] || c.id), h('div', { class: 'muted tiny' }, ROLE_LABELS[c.role] || c.role));
}

/** Crew-loss probability of a crewed estimate (sim omits it, or sends 0, for robotic flights); null when not crewed. */
function crewRiskOf(est) {
  const x = Number(est?.pCrewLoss);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** "Risco à tripulação ~2%" (small risks keep a decimal: "~0,4%", "<0,1%"). */
function crewRiskText(x) {
  const v = Math.max(0, Math.min(1, x)) * 100;
  const s = v < 0.1 ? '<0,1%' : v < 10 ? `~${(Math.round(v * 10) / 10).toString().replace('.', ',')}%` : `~${Math.round(v)}%`;
  return `Risco à tripulação ${s}`;
}

/** The sim's own crew-loss warning line, redundant once the gauge shows the crew risk. */
const isCrewLossWarning = (w) => /^Risco (estimado )?de perder a tripulação/.test(String(w));

function crewRiskLine(est) {
  const x = crewRiskOf(est);
  if (x == null) return null;
  return h('div', { class: 'ms-crewrisk', role: 'note' },
    h('span', { 'aria-hidden': 'true' }, '⚠'), ' ', h('b', null, crewRiskText(x)),
    h('span', { class: 'muted' }, ' · chance de perder alguém a bordo'));
}

function chanceGauge(est, { invalid = false } = {}) {
  if (!est) return null;
  if (invalid) {
    return h('div', { class: 'gauge g-muted' },
      h('div', { class: 'gauge-label' }, 'Chance estimada'),
      h('div', { class: 'gauge-value muted' }, '—'),
      h('div', { class: 'muted tiny' }, 'Corrija os itens marcados com ✕ para ver a chance.'));
  }
  const low = est.low ?? est.p, high = est.high ?? est.p;
  const lp = Math.max(0, Math.min(1, low <= 1 ? low : low / 100)), hp = Math.max(0, Math.min(1, high <= 1 ? high : high / 100));
  const kind = (lp + hp) / 2 >= 0.75 ? 'good' : (lp + hp) / 2 >= 0.5 ? 'warn' : 'bad';
  return h('div', { class: `gauge g-${kind}` },
    h('div', { class: 'gauge-label' }, 'Chance estimada'),
    h('div', { class: 'gauge-value' }, fmtBand(low, high)),
    h('div', { class: 'gauge-track', 'aria-hidden': 'true' },
      h('div', { class: 'gauge-band', style: { left: `${lp * 100}%`, width: `${Math.max(1.5, (hp - lp) * 100)}%` } })),
    crewRiskLine(est),
    h('div', { class: 'muted tiny' }, 'Seus engenheiros nunca têm certeza: a faixa estreita com equipe e pesquisa melhores.'));
}

// ------------------------------------------------------------------ builder

/** Normalize an option entry (string id or object) and join it with catalog data. */
function norm(item, table) {
  if (item == null) return null;
  if (typeof item === 'string') return { id: item, ...(table?.[item] || {}), ok: true };
  const base = table?.[item.id] || {};
  const ok = item.ok ?? item.valid ?? item.available ?? (item.disabled != null ? !item.disabled : true);
  return { ...base, ...item, ok: ok !== false, reason: item.reason || item.error || item.reasons?.[0] || (Array.isArray(item.errors) ? item.errors[0] : null) };
}

function normList(list, table) {
  return Array.isArray(list) ? list.map((x) => norm(x, table)).filter(Boolean) : null;
}

function dateAvailable(item, st) {
  const af = item.availableFrom;
  const now = st.startYear + st.turn / 52;
  if (af && af.year + (af.month || 0) / 12 > now + 0.001) return false;
  const au = item.availableUntil;
  if (au && au.year + (au.month || 0) / 12 < now) return false;
  return true;
}

/** Options for the current draft, from missions/draftOptions with a data-based fallback. */
function draftOptions(store, draft) {
  const st = store.state;
  const idx = store.data?.index || {};
  const q = store.tryQuery('missions/draftOptions', null, draft) || {};
  const destTable = idx.destinations || {};
  const vehTable = idx.vehicles || {};
  const scTable = idx.spacecraft || {};

  const destinations = normList(q.destinations, destTable)
    || (store.data?.destinations?.destinations || []).map((d) => ({ ...d, ok: true }));

  let vehicles = normList(q.vehicles, vehTable);
  if (!vehicles) {
    const cat = store.tryQuery('catalog/vehicles', null, st.playerId);
    const base = Array.isArray(cat) ? cat : (store.data?.vehicles?.vehicles || []).filter((v) => dateAvailable(v, st));
    const capKey = destTable[draft.destination]?.capacityKey;
    vehicles = base.map((v) => {
      const vv = norm(v, vehTable);
      const cap = capKey ? Number(vv.capacity?.[capKey] || 0) : null;
      if (cap === 0) return { ...vv, ok: false, reason: 'não alcança este destino' };
      if (draft.type === 'crewed' && vv.crewRated === false) return { ...vv, ok: false, reason: 'não é certificado para tripulação' };
      return vv;
    });
  }

  let spacecraft = normList(q.spacecraft, scTable);
  if (!spacecraft) {
    const cat = store.tryQuery('catalog/spacecraft', null, st.playerId);
    const base = Array.isArray(cat) ? cat : (store.data?.spacecraft?.spacecraft || []).filter((s) => dateAvailable(s, st));
    spacecraft = base.map((s) => norm(s, scTable)).filter((s) => {
      if (draft.type && TYPE_KINDS[draft.type] && s.kind && !TYPE_KINDS[draft.type].includes(s.kind)) return false;
      if (draft.destination && Array.isArray(s.destinations) && s.destinations.length && !s.destinations.includes(draft.destination)) return false;
      return true;
    });
  }

  const veh = vehTable[draft.vehicleId];
  const sc = scTable[draft.spacecraftId];
  let cost = typeof q.cost === 'number' ? q.cost : (q.cost?.total ?? null);
  if (cost == null && (veh || sc)) cost = (Number(veh?.costM) || 0) + (Number(sc?.costM) || 0);
  const estimate = q.estimate || q.risk || null;
  const window = q.window || q.nextWindow || null;
  const errors = [...(q.errors || []), ...(estimate?.errors || [])];
  const warnings = [...(q.warnings || []), ...(estimate?.warnings || [])];
  return {
    raw: q, destinations, vehicles, spacecraft, cost, estimate, window, errors: dedupeMessages(errors), warnings: dedupeMessages(warnings),
    valid: q.valid ?? estimate?.valid ?? errors.length === 0,
    earliest: q.earliestLaunchTurn ?? q.earliestTurn ?? q.launchTurnMin ?? null,
    crewSeats: (Number.isFinite(q.seats) && q.seats > 0 ? q.seats : null) ?? q.crewSeats ?? sc?.crew ?? (draft.type === 'crewed' ? 3 : 0),
    crew: q.crew && typeof q.crew === 'object' ? q.crew : null,
    payloadT: q.payloadT ?? null,
    capacityT: q.capacityT ?? null,
  };
}

function rosterOf(store) {
  const st = store.state;
  const q = store.tryQuery('crew/roster', null);
  const list = Array.isArray(q) ? q : Object.values(st.crew || {}).filter((c) => c?.actorId === st.playerId);
  return list.filter((c) => c && (c.status ?? 'active') === 'active');
}

function builder(store, rerender) {
  const st = store.state;
  let d = ui.draft;
  let opts = draftOptions(store, d);
  // past step 1 with no spacecraft chosen: preselect the cheapest compatible one (the player can still change it)
  if (ui.step >= 2 && d.type && d.destination && !d.spacecraftId && !ui.noCraft) {
    const pick = opts.spacecraft.filter((s) => s.ok && !flightBlock(store, s.id, d.vehicleId)).sort((a, b) => (a.costM || 0) - (b.costM || 0))[0];
    if (pick) { ui.draft = d = { ...d, spacecraftId: pick.id }; opts = draftOptions(store, d); }
  }
  // and the best free flight director (an empty control room is rarely what the player wants)
  if (ui.step >= 2 && !d.crew?.flightDirector && !ui.noFd) {
    const raw = opts.raw?.crew?.flightDirector;
    const fd = (Array.isArray(raw) ? raw : []).filter((p) => !p.busy).sort((a, b) => (b.skill || 0) - (a.skill || 0))[0];
    if (fd) { ui.draft = d = { ...d, crew: { ...(d.crew || {}), flightDirector: fd.id } }; opts = draftOptions(store, d); }
  }
  const set = (patch) => { ui.draft = { ...ui.draft, ...patch }; rerender(); };
  // a new step is a new screen: start it at the top (same route, so the shell keeps the scroll otherwise)
  const blockers = step2Blockers(store, d, opts);
  const goStep = (n) => { ui.step = n; rerender(); store.ui?.scrollTop?.(); };
  const steps = ['Alvo e tipo', 'Veículo e equipe', 'Resumo'];

  const stepper = h('ol', { class: 'stepper' }, steps.map((s, i) => h('li', {
    class: [ui.step === i + 1 && 'active', ui.step > i + 1 && 'done'],
    onclick: () => { if (i + 1 < ui.step || canGo(i + 1, d, blockers)) goStep(i + 1); },
  }, h('span', { class: 'step-n' }, String(i + 1)), h('span', { class: 'step-t' }, s))));

  const body = h('div', { class: 'builder-body' });
  if (ui.step === 1) body.append(step1(store, d, opts, set));
  else if (ui.step === 2) body.append(step2(store, d, opts, set));
  else body.append(step3(store, d, opts, rerender));
  // what still blocks "Próximo" on step 2, said right above the button (not only on step 3)
  if (ui.step === 2 && blockers.length) body.append(h('div', { class: 'notes bad', role: 'status' }, blockers.map((b) => h('div', null, `✕ ${b}`))));

  const nav = h('div', { class: 'builder-nav' },
    ui.step > 1 ? button('Voltar', () => goStep(ui.step - 1), { kind: 'ghost', icon: '‹' }) : button('Limpar', () => { ui.draft = newDraft(); ui.noFd = false; ui.noCraft = false; goStep(1); }, { kind: 'ghost' }),
    ui.step < 3 ? button('Próximo', () => goStep(ui.step + 1), { kind: 'primary', disabled: !canGo(ui.step + 1, d, blockers) }) : null);

  return h('div', { class: 'builder' },
    d.contractId ? h('div', { class: 'contract-banner' }, `📜 Missão para contrato`, button('remover', () => set({ contractId: null, source: 'custom' }), { kind: 'ghost', small: true })) : null,
    stepper, body, nav);
}

function canGo(step, d, blockers = []) {
  if (step >= 2 && !(d.type && d.destination)) return false;
  if (step >= 3 && (!d.vehicleId || blockers.length)) return false;
  return true;
}

/** Reason a spacecraft cannot ride a vehicle (spacecraft.compatibleVehicles), or null. */
function flightBlock(store, scId, vehId) {
  const idx = store.data?.index || {};
  const sc = idx.spacecraft?.[scId];
  if (!sc || !vehId) return null;
  const list = sc.compatibleVehicles;
  if (!Array.isArray(list) || !list.length || list.includes(vehId)) return null;
  const names = list.map((id) => idx.vehicles?.[id]?.name || id);
  return `só voa no ${names.join(' / ')}`;
}

/** Step-2 problems that make step 3 pointless: no usable vehicle, craft that can't ride it, crewed flight without commander. */
function step2Blockers(store, d, opts) {
  const idx = store.data?.index || {};
  const out = [];
  if (!d.type || !d.destination) return out;
  const v = opts.vehicles.find((x) => x.id === d.vehicleId);
  if (d.vehicleId && v && !v.ok) out.push(`${v.name || v.id}: ${v.reason || 'indisponível para esta missão'}`);
  const sc = idx.spacecraft?.[d.spacecraftId];
  if (sc && d.vehicleId && flightBlock(store, sc.id, d.vehicleId)) out.push(`${sc.name} não voa no ${idx.vehicles?.[d.vehicleId]?.name || d.vehicleId}.`);
  const crewed = d.type === 'crewed' || (sc?.crew > 0);
  if (d.vehicleId && crewed && !d.crew?.commander) out.push('Escolha o comandante.');
  return out;
}

function step1(store, d, opts, set) {
  const st = store.state;
  return h('div', null,
    sectionTitle('1 · Tipo de missão'),
    h('div', { class: 'type-grid' }, TYPES.map((t) => h('button', {
      class: ['type-btn', d.type === t && 'selected'], type: 'button', 'aria-pressed': d.type === t ? 'true' : 'false',
      onclick: () => set({ type: t, vehicleId: null, spacecraftId: null }),
    }, h('span', { class: 'type-icon', 'aria-hidden': 'true' }, TYPE_ICONS[t]), h('span', { class: 'type-name' }, TYPE_LABELS[t]), h('span', { class: 'type-hint' }, TYPE_HINT[t])))),
    sectionTitle('Alvo'),
    opts.destinations.length ? h('div', { class: 'dest-list' }, sortByArrival(opts.destinations, (x) => cardLaunchTurn(store, x), st.endTurn).map((x) => destCard(store, x, d, set)))
      : emptyState('O catálogo de destinos ainda não carregou.', '🌑'));
}

/**
 * Arrival estimate for a destination launched at launchTurn: { arriveTurn, late } where late means the probe gets
 * there after the campaign's last turn (the government pitches use the same rule). Pure: exported for tests.
 */
export function arrivalOf(dest, launchTurn, endTurn) {
  const tw = Number(dest?.transitWeeks) || 0;
  if (!Number.isFinite(launchTurn)) return { arriveTurn: null, late: false };
  const arriveTurn = launchTurn + tw;
  return { arriveTurn, late: Number.isFinite(endTurn) && tw > 0 && arriveTurn > endTurn };
}

/** Earliest plausible launch for a destination card: now, or when its next window opens. */
function cardLaunchTurn(store, x) {
  const st = store.state;
  if (!x.window) return st.turn;
  const w = attempt(() => store.tryQuery('catalog/window', null, x.id), null);
  return w?.openTurn != null ? Math.max(st.turn, w.openTurn) : st.turn;
}

/** Destination list for step 1: those that arrive after the campaign ends go last (order otherwise kept). */
export function sortByArrival(list, launchOf, endTurn) {
  return list.map((x, i) => ({ x, i, late: arrivalOf(x, launchOf(x), endTurn).late }))
    .sort((a, b) => (a.late - b.late) || (a.i - b.i)).map((e) => e.x);
}

function destCard(store, x, d, set) {
  const st = store.state;
  const dv = (x.route || []).reduce((s, r) => s + (Number(r.dv) || 0), 0);
  const win = x.window ? attempt(() => {
    const w = store.tryQuery('catalog/window', null, x.id);
    return w?.openTurn != null ? w : null;
  }, null) : null;
  const sel = d.destination === x.id;
  const arr = x.transitWeeks ? arrivalOf(x, cardLaunchTurn(store, x), st.endTurn) : null;
  return h('button', {
    class: ['dest-card', sel && 'selected', !x.ok && 'disabled'], type: 'button', disabled: !x.ok,
    onclick: () => set({ destination: x.id, vehicleId: null, spacecraftId: null }),
  },
  h('div', { class: 'dest-top' },
    h('span', { class: 'dest-name' }, x.name || x.id),
    x.transitWeeks ? chip(`${x.transitWeeks} sem de viagem`, 'muted') : null),
  // "mapa de metrô": energy per leg as bars, no formulas
  x.route?.length ? h('div', { class: 'metro', 'aria-label': `custo de energia ${dv.toFixed(1)} km/s` },
    x.route.map((r) => h('span', { class: 'metro-leg', style: { flexGrow: String(Math.max(0.3, r.dv || 0.3)) }, title: `${r.from} → ${r.to}: ${r.dv} km/s` })),
    h('span', { class: 'metro-dv tiny' }, `${dv.toFixed(1).replace('.', ',')} km/s`)) : null,
  x.window ? h('div', { class: 'tiny muted' }, win ? `Janela ${win.openTurn <= st.turn ? 'aberta até ' + fmtMonth(win.closeTurn, st.startYear) : 'abre ' + fmtIn(win.openTurn, st.turn)}` : `Janela a cada ${Math.round(x.window.periodWeeks / 4.33)} meses`) : null,
  arr?.late ? h('div', { class: 'tiny warn-text' }, `⚠ Chega só em ${fmtMonth(arr.arriveTurn, st.startYear)}: depois do fim da campanha (${st.startYear + Math.floor(st.endTurn / 52)}). Sem resultado científico no jogo.`)
    : arr && arr.arriveTurn > st.turn + 8 ? h('div', { class: 'tiny muted' }, `Chegada ~${fmtMonth(arr.arriveTurn, st.startYear)}`) : null,
  !x.ok && x.reason ? h('div', { class: 'tiny warn-text' }, x.reason) : null);
}

function step2(store, d, opts, set) {
  const st = store.state;
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[d.destination];
  const capKey = dest?.capacityKey;
  const vehicles = opts.vehicles.slice().sort((a, b) => (b.ok - a.ok) || (a.costM || 0) - (b.costM || 0));
  const roster = rosterOf(store);
  const fds = Array.isArray(opts.crew?.flightDirector) ? opts.crew.flightDirector : roster.filter((c) => c.role === 'flight_director');
  const astros = Array.isArray(opts.crew?.astronauts) && opts.crew.astronauts.length ? opts.crew.astronauts : roster.filter((c) => c.role === 'astronaut');
  const crewed = d.type === 'crewed' || (idx.spacecraft?.[d.spacecraftId]?.crew > 0);
  const setCrew = (patch) => set({ crew: { ...d.crew, ...patch } });

  return h('div', null,
    sectionTitle('2 · Veículo lançador'),
    vehicles.length ? h('div', { class: 'veh-list' }, vehicles.map((v) => {
      const op = st.actors?.[v.operator] || { id: v.operator };
      const cap = v.effectiveCapacityT ?? v.capacityT ?? (capKey ? v.capacity?.[capKey] : null);
      const rel = v.reliability || v.rel;
      const flights = rel?.flights ?? v.history?.flights ?? v.flights;
      return h('button', {
        class: ['veh-card', d.vehicleId === v.id && 'selected', !v.ok && 'disabled'], type: 'button', disabled: !v.ok,
        onclick: () => (d.spacecraftId && flightBlock(store, d.spacecraftId, v.id)
          ? (ui.noCraft = false, set({ vehicleId: v.id, spacecraftId: null, secondarySpacecraftId: null }))
          : set({ vehicleId: v.id })),
      },
      raw(emblemSVG(op, { size: 30 }), 'veh-emblem'),
      h('div', { class: 'veh-text' },
        h('div', { class: 'veh-name' }, v.name || v.id),
        h('div', { class: 'tiny muted' }, [
          v.costM != null ? fmtMoney(v.costM) : null,
          cap != null && d.destination ? `${String(cap).replace('.', ',')} t até o alvo` : null,
          flights != null ? `${flights} voo${flights === 1 ? "" : "s"}` : null,
          v.reusable ? 'reutilizável' : null,
        ].filter(Boolean).join(' · ')),
        !v.ok && v.reason ? h('div', { class: 'tiny warn-text' }, v.reason) : null),
      rel?.low != null ? chip(fmtBand(rel.low, rel.high), 'info') : v.estimatedReliability ? chip(`~${fmtPct(v.estimatedReliability)}`, 'muted') : null,
      v.truthLayer && v.truthLayer !== 'fato' ? chip(TRUTH_LABELS[v.truthLayer] || v.truthLayer, 'muted') : null);
    })) : emptyState('Nenhum veículo disponível para este alvo agora.', '🛑'),

    sectionTitle('Espaçonave'),
    opts.spacecraft.length ? h('div', { class: 'chips wrap' },
      chip('nenhuma', !d.spacecraftId ? 'accent' : 'muted', { onclick: () => { ui.noCraft = true; set({ spacecraftId: null, secondarySpacecraftId: null }); } }),
      opts.spacecraft.filter((s) => s.ok || s.id === d.spacecraftId).map((s) => {
        const block = s.ok ? flightBlock(store, s.id, d.vehicleId) : null;
        const usable = s.ok && !block;
        return chip(`${s.name || s.id}${s.crew ? ` · ${s.crew} lugares` : ''}${s.costM ? ` · ${fmtMoney(s.costM)}` : ''}${block ? ` · ${block}` : ''}`,
          d.spacecraftId === s.id ? (usable ? 'accent' : 'bad') : usable ? '' : 'muted',
          { onclick: usable ? () => { ui.noCraft = false; set({ spacecraftId: s.id, secondarySpacecraftId: null }); } : () => toast(`${s.name}: ${block || s.reason || 'incompatível'}.`, 'warn'), title: block || s.reason || s.notes || '', 'aria-disabled': usable ? null : 'true' });
      }))
      : h('p', { class: 'muted small' }, 'Sem espaçonaves compatíveis no catálogo (a carga vai como satélite genérico).'),
    landerPicker(opts, d, set),

    sectionTitle('Sala de controle'),
    pickPerson(store, 'Diretor(a) de voo', fds, d.crew.flightDirector, (id) => { ui.noFd = !id; setCrew({ flightDirector: id }); }),
    crewed ? pickPerson(store, 'Comandante', astros, d.crew.commander, (id) => setCrew({ commander: id, astronauts: (d.crew.astronauts || []).filter((x) => x !== id) })) : null,
    crewed ? pickMany(store, `Tripulação (${opts.crewSeats || '?'} lugares)`, astros.filter((a) => a.id !== d.crew.commander), d.crew.astronauts || [], Math.max(0, (opts.crewSeats || 3) - 1), (ids) => setCrew({ astronauts: ids })) : null,

    sectionTitle('Configuração'),
    h('div', { class: 'field' }, h('span', { class: 'small' }, 'Estratégia'),
      segmented(Object.entries(STRATEGY_LABELS).map(([id, label]) => ({ id, label })), d.config.strategy, (v) => set({ config: { ...d.config, strategy: v } }))),
    h('div', { class: 'field' }, h('span', { class: 'small' }, 'Margem de combustível'),
      segmented(MARGINS.map((m) => ({ id: m, label: fmtPct(m) })), d.config.fuelMargin, (v) => set({ config: { ...d.config, fuelMargin: v } }))),
    h('p', { class: 'tiny muted' }, 'Mais margem = menos carga, mais segurança. Agressiva encurta prazos e aumenta o risco.'));
}

/** Crewed landing with a capsule that needs a separate lander (Orion + HLS/Blue Moon): pick the lander. */
function landerPicker(opts, d, set) {
  const landers = opts.raw?.landers || [];
  const comp = opts.raw?.companion;
  if (!landers.length && !comp?.required) return null;
  return h('div', { class: 'field' },
    h('span', { class: 'small' }, 'Módulo de pouso (lançado à parte)'),
    landers.length ? h('div', { class: 'chips wrap' }, landers.map((l) => chip(
      `${l.name}${l.costM ? ` · ${fmtMoney(l.costM)}` : ''}${l.reliability?.low != null ? ` · ${fmtBand(l.reliability.low, l.reliability.high)}` : ''}`,
      (comp?.id === l.id) ? 'accent' : '', { onclick: () => set({ secondarySpacecraftId: l.id }) })))
      : h('p', { class: 'tiny warn-text' }, 'Nenhum módulo de pouso tripulado disponível para a agência agora.'),
    h('p', { class: 'tiny muted' }, 'O módulo vai em outro foguete e espera a tripulação em órbita lunar. O custo entra no total.'));
}

function pickPerson(store, label, people, selected, onPick) {
  return h('div', { class: 'field' }, h('span', { class: 'small' }, label),
    people.length ? h('div', { class: 'person-row' }, people.map((p) => h('button', {
      class: ['person-pick', selected === p.id && 'selected', p.busy && 'busy'], type: 'button', 'aria-pressed': selected === p.id ? 'true' : 'false',
      title: p.busy ? `Escalada(o) em ${p.busyWith || 'outra missão'}` : null,
      onclick: () => (p.busy && selected !== p.id ? toast(`${p.name} já está em ${p.busyWith || 'outra missão'}.`, 'warn') : onPick(selected === p.id ? null : p.id)),
    }, raw(portraitSVG(p.portrait || p.id, { size: 40 }), 'face'), h('span', { class: 'tiny' }, p.name?.split(' ').slice(-1)[0] || p.id), h('span', { class: 'tiny muted' }, `★${Math.round(p.skill ?? 0)}`))))
      : h('p', { class: 'muted small' }, 'Ninguém disponível nesta função. Contrate na tela de Equipe.'));
}

function pickMany(store, label, people, selected, max, onChange) {
  return h('div', { class: 'field' }, h('span', { class: 'small' }, label),
    people.length ? h('div', { class: 'person-row' }, people.map((p) => {
      const on = selected.includes(p.id);
      return h('button', {
        class: ['person-pick', on && 'selected', p.busy && 'busy'], type: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => {
          if (p.busy && !on) { toast(`${p.name} já está em ${p.busyWith || 'outra missão'}.`, 'warn'); return; }
          if (on) onChange(selected.filter((x) => x !== p.id));
          else if (selected.length < max) onChange([...selected, p.id]);
          else toast(`Só cabem ${max} além do comandante.`, 'warn');
        },
      }, raw(portraitSVG(p.portrait || p.id, { size: 40 }), 'face'), h('span', { class: 'tiny' }, p.name?.split(' ').slice(-1)[0] || p.id), h('span', { class: 'tiny muted' }, `★${Math.round(p.skill ?? 0)}`));
    })) : h('p', { class: 'muted small' }, 'Sem astronautas ativos.'));
}

/**
 * Legal launch range for a draft or a planned mission, as the sim sees it: preparation lead + destination window.
 * Builder passes its draftOptions result (earliest + window); the mission sheet asks the sim for the mission itself.
 * Returns { earliest, openTurn, closeTurn } (closeTurn exclusive, Infinity when the destination has no window).
 */
function launchRange(store, m, opts) {
  const st = store.state;
  let earliest = opts?.earliest;
  let w = opts?.window || null;
  if (earliest == null && m?.id) earliest = store.tryQuery('missions/get', null, m.id)?.check?.earliestLaunchTurn ?? null;
  if (earliest == null) {
    const q = store.tryQuery('missions/draftOptions', null, { ...m, missionId: m?.id });
    earliest = q?.earliestLaunchTurn ?? null;
    w = w || q?.window || null;
  }
  if (earliest == null) earliest = st.turn + 8; // sim default lead when nothing answers
  if (!opts && m?.destination) w = store.tryQuery('missions/nextWindow', null, m.destination, earliest) || w;
  const close = w?.closeTurn != null && Number.isFinite(Number(w.closeTurn)) ? Number(w.closeTurn) : Infinity;
  return { earliest: Math.max(earliest, st.turn + 1), openTurn: w?.openTurn ?? null, closeTurn: close };
}

/**
 * Date chips inside [earliest, closeTurn) and the scenario end, at most one per month (two chips that read
 * "abr/2026" are noise). Pure: exported for tests.
 */
export function launchSlots(range, now, endTurn, startYear, max = 4) {
  const last = Math.min(range.closeTurn - 1, endTurn ?? Infinity);
  if (!(range.earliest <= last)) return [];
  const cands = [0, 4, 8, 13, 17, 26, 39].map((k) => range.earliest + k).filter((t) => t <= last);
  if (Number.isFinite(range.closeTurn) && !cands.includes(last)) cands.push(last); // the window's last week
  const seen = new Set();
  const out = [];
  for (const t of cands) {
    const month = fmtMonth(t, startYear);
    if (seen.has(month)) continue;
    seen.add(month);
    out.push({ turn: t, label: `${out.length === 0 ? 'O quanto antes · ' : ''}${month} (${fmtIn(t, now)})` });
    if (out.length >= max) break;
  }
  return out;
}

/** Launch date options for a draft/mission (see launchRange + launchSlots). */
export function launchTurnOptions(store, draftOrMission, opts) {
  const st = store.state;
  return launchSlots(launchRange(store, draftOrMission, opts), st.turn, st.endTurn, st.startYear);
}

/** Why there is no date to pick (window not reachable before the scenario ends, or none at all). */
function noSlotText(store, m, opts) {
  const st = store.state;
  const r = launchRange(store, m, opts);
  if (r.earliest > (st.endTurn ?? Infinity)) return 'Não há data possível antes do fim do cenário.';
  return `Sem data possível agora. Primeira data: ${fmtMonth(r.earliest, st.startYear)}.`;
}

/** Window hint for the sheet: "Janela para Órbita de Marte: out/2026 a dez/2026". */
function windowHint(store, m, opts) {
  const st = store.state;
  const r = launchRange(store, m, opts);
  if (!Number.isFinite(r.closeTurn) || r.openTurn == null) return null;
  const name = store.data?.index?.destinations?.[m.destination]?.name || m.destination;
  const opensLater = r.openTurn > st.turn;
  return `${opensLater ? 'Janela abre' : 'Janela aberta'} para ${name}: ${fmtMonth(Math.max(r.openTurn, r.earliest), st.startYear)} a ${fmtMonth(r.closeTurn - 1, st.startYear)}.`;
}

/** Scheduling failure: all distinct reasons, not just the first (the window error used to be hidden). */
export function scheduleErrorText(r) {
  const list = Array.isArray(r?.errors) && r.errors.length ? r.errors : [r?.error || 'Não foi possível agendar.'];
  return dedupeMessages(list).join(' ');
}

/**
 * Drop near-duplicate validation messages: the same rule worded by two modules ("Carga de 26,5 t excede a
 * capacidade de 15,8 t do Falcon 9…" vs "…com essa margem.") shares the opening words. Pure: exported for tests.
 */
export function dedupeMessages(list) {
  const key = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  const keys = [];
  for (const msg of list || []) {
    if (!msg) continue;
    const k = key(msg);
    const head = k.slice(0, 24);
    // same opening, or one of the pair is a known generic restatement ("caixa insuficiente ...")
    const dup = keys.some((o) => o === k || (head.length >= 18 && o.slice(0, 24) === head) || (o.startsWith('caixa insuficiente') && k.startsWith('caixa insuficiente')));
    if (dup) continue;
    keys.push(k);
    out.push(msg);
  }
  return out;
}

/** The name the sim will give this draft (draftOptions.autoName when offered; same pattern otherwise). */
function autoNameOf(store, d, opts) {
  if (opts.raw?.autoName) return opts.raw.autoName;
  const st = store.state;
  const me = st.actors?.[st.playerId];
  const dest = store.data?.index?.destinations?.[d.destination];
  const n = (st.missions || []).filter((m) => m.type === d.type).length + 1;
  return `${me?.short || me?.name || ''} ${TYPE_LABELS[d.type] || 'Missão'}${dest ? ` · ${dest.name}` : ''} ${n}`.trim();
}

function step3(store, d, optsBase, rerender) {
  const st = store.state;
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[d.destination];
  const veh = idx.vehicles?.[d.vehicleId];
  const sc = idx.spacecraft?.[d.spacecraftId];
  const me = st.actors?.[st.playerId];
  // dates come from the sim's own earliest turn + window (same helper as the planned-mission sheet)
  const dates = launchTurnOptions(store, d, optsBase);
  if (ui.launchTurn == null || !dates.some((x) => x.turn === ui.launchTurn)) ui.launchTurn = dates[0]?.turn ?? null;
  // estimate, factors and errors for the date actually picked (a tight date costs points: show it here)
  const opts = ui.launchTurn != null ? draftOptions(store, { ...d, launchTurn: ui.launchTurn }) : optsBase;
  const autoName = autoNameOf(store, d, opts);
  const nameInput = h('input', { class: 'input', value: ui.name || '', placeholder: `${autoName} (nome automático)`, maxlength: '40', 'aria-label': 'Nome da missão', oninput: (e) => { ui.name = e.target.value; } });
  const cantPay = opts.cost != null && me && !(me.cash >= opts.cost);
  const errors = dedupeMessages([...opts.errors, ...(cantPay ? ['Caixa insuficiente para pagar a missão agora.'] : [])]);
  if (!dates.length) errors.push(noSlotText(store, d, optsBase));
  const arr = ui.launchTurn != null && dest?.transitWeeks ? arrivalOf(dest, ui.launchTurn, st.endTurn) : null;
  const lateNote = arr?.late ? `A nave chega em ${fmtMonth(arr.arriveTurn, st.startYear)}, depois do fim da campanha (${st.startYear + Math.floor(st.endTurn / 52)}): o lançamento conta, mas a chegada e a ciência dela ficam fora do jogo.` : null;
  const est = opts.estimate;
  // the gauge shows the crew risk itself: drop the sim's duplicate warning line when it does
  const showsCrewRisk = !!est && errors.length === 0 && crewRiskOf(est) != null;
  const warnings = showsCrewRisk ? opts.warnings.filter((w) => !isCrewLossWarning(w)) : opts.warnings;
  const factors = (est?.factors || []).slice().sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0)).slice(0, 6);

  const create = (schedule) => {
    const draft = { ...ui.draft, launchTurn: ui.launchTurn };
    if (nameInput.value.trim()) draft.name = nameInput.value.trim(); // else the sim names it
    const r = store.dispatch({ type: 'mission/create', draft });
    if (!r?.ok) { toast(r?.error || 'Não foi possível criar a missão.', 'bad'); return; }
    const id = r.missionId || r.id || r.mission?.id;
    if (schedule && id) {
      const r2 = store.dispatch({ type: 'mission/schedule', missionId: id, launchTurn: ui.launchTurn });
      if (!r2?.ok) { toast(`Criada, mas não agendada: ${scheduleErrorText(r2)}`, 'warn', 5000); }
      else { toast(`🚀 ${store.state.missions?.find((m) => m.id === id)?.name || draft.name || 'Missão'} agendada para ${fmtMonth(ui.launchTurn, st.startYear)}.`, 'good'); store.vibrate(30); }
    } else toast('Missão salva em planejamento.', 'good');
    ui.draft = newDraft(); ui.step = 1; ui.noFd = false; ui.noCraft = false; ui.name = ''; ui.launchTurn = null;
    store.ui?.navigate ? store.ui.navigate('missoes', 'lista') : rerender();
  };

  return h('div', null,
    sectionTitle('3 · Resumo'),
    h('label', { class: 'field' }, h('span', { class: 'small' }, 'Nome'), nameInput),
    card({ cls: 'summary-card' },
      h('div', { class: 'kv' },
        kv('Tipo', `${TYPE_ICONS[d.type] || ''} ${TYPE_LABELS[d.type] || '—'}`),
        kv('Alvo', dest?.name || d.destination || '—'),
        kv('Veículo', veh?.name || d.vehicleId || '—'),
        kv('Espaçonave', sc?.name || (d.spacecraftId || 'nenhuma')),
        opts.raw?.companion ? kv('Módulo de apoio', opts.raw.companion.name) : null,
        kv('Estratégia', `${STRATEGY_LABELS[d.config.strategy]} · margem ${fmtPct(d.config.fuelMargin)}`),
        opts.payloadT != null ? kv('Carga', `${String(opts.payloadT).replace('.', ',')} t${opts.capacityT != null ? ` de ${String(opts.capacityT).replace('.', ',')} t possíveis` : ''}`) : null,
        kv('Custo', opts.cost != null ? fmtMoney(opts.cost) : '—'),
        me ? kv('Caixa depois', fmtMoney((me.cash || 0) - (opts.cost || 0))) : null,
        opts.window?.openTurn != null && Number.isFinite(opts.window.closeTurn) ? kv('Janela', `${fmtMonth(opts.window.openTurn, st.startYear)} a ${fmtMonth(opts.window.closeTurn - 1, st.startYear)}`) : null,
        arr ? kv('Chegada', `${fmtMonth(arr.arriveTurn, st.startYear)}${arr.late ? ' ⚠ após o fim' : ''}`) : null)),
    // a chance for a mission that cannot fly is misleading: grey it out until the errors are fixed
    est ? chanceGauge(est, { invalid: errors.length > 0 }) : h('p', { class: 'muted small' }, 'A estimativa de chance aparece quando o módulo de risco estiver pronto.'),
    factors.length ? h('ul', { class: 'factors' }, factors.map((f) => h('li', { class: (f.delta || 0) >= 0 ? 'pos' : 'neg' },
      h('span', null, (f.delta || 0) >= 0 ? '▲' : '▼'), ' ', f.label, h('span', { class: 'muted' }, ` ${f.delta > 0 ? '+' : ''}${fmtPct(f.delta)}`)))) : null,
    warnings.length || lateNote ? h('div', { class: 'notes warn' }, [...(lateNote ? [lateNote] : []), ...warnings].map((w) => h('div', null, `⚠ ${w}`))) : null,
    errors.length ? h('div', { class: 'notes bad' }, errors.map((w) => h('div', null, `✕ ${w}`))) : null,
    sectionTitle('Data de lançamento'),
    dates.length ? h('div', { class: 'chips wrap' }, dates.map((o) => chip(o.label, ui.launchTurn === o.turn ? 'accent' : '', { onclick: () => { ui.launchTurn = o.turn; rerender(); } }))) : null,
    h('div', { class: 'btn-col' },
      button('Criar e agendar lançamento', () => create(true), { kind: 'primary', icon: '🚀', disabled: !opts.valid || errors.length > 0 || ui.launchTurn == null }),
      button('Salvar em planejamento', () => create(false), { kind: 'ghost', disabled: !d.type })));
}

// ------------------------------------------------------------------ contracts

function getContracts(store) {
  const q = store.tryQuery('missions/contracts', null);
  if (Array.isArray(q)) return q;
  return Array.isArray(store.state.contracts) ? store.state.contracts : [];
}

function contractsView(store, contracts, offers, go) {
  const st = store.state;
  const idx = store.data?.index || {};
  const out = h('div');
  if (offers.length) out.append(sectionTitle('Ofertas na mesa'), h('div', { class: 'decision-list' }, sortDecisions(offers).map((d) => decisionRow(store, d))));
  const OPEN = ['open', 'bidding', 'awarded', 'late', 'offered', 'accepted', 'won'];
  const open = contracts.filter((c) => OPEN.includes(c.status));
  const closed = contracts.filter((c) => !open.includes(c));
  if (!contracts.length && !offers.length) {
    out.append(emptyState('Nenhum contrato agora. Reputação alta atrai clientes e leilões melhores.', '📜'));
    return out;
  }
  const row = (c) => {
    const client = st.actors?.[c.clientId || c.client || c.from] || null;
    const clientName = client ? (client.short || client.name) : (typeof c.client === 'string' ? c.client : null);
    const dest = idx.destinations?.[c.destination]?.name || c.destination;
    const deadline = c.deadlineTurn ?? c.dueTurn ?? c.expiresTurn;
    const mine = c.winner === st.playerId || c.awardedTo === st.playerId || ['won', 'awarded', 'accepted', 'late', 'delivered'].includes(c.status);
    const hasMission = !!c.missionId || (st.missions || []).some((m) => m.contractId === c.id && m.status !== 'cancelled');
    return card({
      cls: 'contract-card', icon: client ? raw(emblemSVG(client, { size: 36 })) : '📜',
      title: c.title || c.name || 'Contrato', subtitle: [clientName, TYPE_LABELS[c.type], dest].filter(Boolean).join(' · '),
      right: chip(contractStatus(c), mine ? 'good' : 'muted'),
    },
    c.description || c.body ? h('p', { class: 'small' }, c.description || c.body) : null,
    h('div', { class: 'chips' },
      (c.winningPrice ?? c.reward ?? c.valueM) != null ? chip(`💰 ${fmtMoney(c.winningPrice ?? c.reward ?? c.valueM)}`, 'good') : null,
      c.playerBid && c.status === 'bidding' ? chip(`seu lance ${fmtMoney(c.playerBid.price)}`, 'accent') : null,
      c.winner && !mine ? chip(`vencedor: ${st.actors?.[c.winner]?.short || c.winner}`, 'muted') : null,
      c.payloadT ? chip(`${c.payloadT} t`, 'muted') : null,
      deadline != null ? chip(`prazo ${fmtMonth(deadline, st.startYear)}`, deadline - st.turn < 8 ? 'warn' : 'muted') : null,
      c.penalty ? chip(`multa ${fmtMoney(c.penalty)}`, 'bad') : null),
    mine && hasMission && c.missionId ? button('Ver missão', () => openMission(store, c.missionId), { kind: 'ghost', small: true }) : null,
    mine && !hasMission ? button('Montar missão do contrato', () => {
      ui.draft = newDraft({ source: 'contract', contractId: c.id, type: c.type || null, destination: c.destination || null, config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: c.payloadT ?? null } });
      ui.step = c.type && c.destination ? 2 : 1;
      go('nova');
    }, { kind: 'primary', small: true, icon: '🛠' }) : null);
  };
  if (open.length) out.append(sectionTitle('Em aberto'), ...open.map(row));
  if (closed.length) out.append(sectionTitle('Encerrados'), ...closed.slice(-6).reverse().map(row));
  return out;
}

function contractStatus(c) {
  const S = { open: 'aberto', offered: 'oferta', bidding: 'lance enviado', won: 'ganho', awarded: 'ganho', accepted: 'aceito', late: 'atrasado', closed: 'perdido', lost: 'perdido', delivered: 'entregue', done: 'cumprido', completed: 'cumprido', failed: 'falhou', defaulted: 'descumprido', expired: 'expirou' };
  return S[c.status] || c.status || 'aberto';
}

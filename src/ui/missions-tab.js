// Missões: list by status, 3-step builder (alvo/tipo -> veículo/nave/tripulação/config -> resumo) and contracts.
import {
  h, raw, card, chip, bar, button, segmented, sectionTitle, emptyState, safePanel, openModal, toast, confirmDialog, attempt,
  fmtMoney, fmtBand, fmtPct, fmtDate, fmtIn, fmtMonth, icon, iconSVG, viewHead,
  TYPE_LABELS, TYPE_ICONS, STATUS_LABELS, OUTCOME_TEXT, STRATEGY_LABELS, ROLE_LABELS, TRUTH_LABELS,
  SUB_LABELS, SUB_YEARS, PAYLOAD_LABELS, missionTypeOf, typeSubLabel,
} from './components.js';
import { portraitSVG, emblemSVG } from './portrait.js';
import * as portraitNs from './portrait.js';
import { decisionRow, sortDecisions } from './decisions.js';
import { renderBoard } from './contracts.js';
import { contractsBadge } from './screens.js';

// Missões styles (docs/DESIGN.md §5, Builder "missões"): one stylesheet linked once, after styles.css so it wins
// on equal specificity. Linked when the module loads (app.js imports it at boot): no unstyled first visit.
function ensureCss() {
  try {
    if (typeof document === 'undefined' || document.querySelector('link[data-missions-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = new URL('./css/missions.css', import.meta.url).href;
    l.dataset.missionsCss = '1';
    document.head.appendChild(l);
  } catch { /* no DOM (tests) */ }
}
ensureCss();

/** Inline note (CSmanager .aviso): tinted box with a stroke icon. kind: '' (neutral) | 'warn' | 'bad' | 'ok'. */
function note(text, kind = 'warn', ic = 'alerta') {
  return h('div', { class: ['aviso', 'ms-note', kind], role: kind === 'bad' ? 'status' : null }, icon(ic, 14, 'ms-note-ic'), h('span', null, text));
}

// ------------------------------------------------------------------ Phase B: investors and designs (B5)

const HOLDER_TINT = { government: '#28628f', founders: '#2f7f6c', fund: '#5e4589', corporation: '#8a5a1f', consortium: '#6b3f6f', colony: '#3f6b5a' };
// portrait.emblemSVG takes a designed spec ({shape, field…}) once B1's emblem.js lands; the v0.6 one only a label
const specEmblems = (() => { try { return !/OBJECT/.test(String(portraitNs.emblemLabel?.({ emblem: {} }) ?? '')); } catch { return false; } })();

/** Small emblem of an investor (its designed spec when the emblem module supports it, else a lettered roundel). */
export function holderEmblemSVG(holder, size = 18) {
  if (!holder) return '';
  const spec = holder.emblem && typeof holder.emblem === 'object' ? holder.emblem : null;
  const pseudo = { id: holder.id || 'holder', name: holder.name || 'Investidor', color: spec?.field || HOLDER_TINT[holder.kind] || '#5e4589' };
  if (spec && specEmblems) pseudo.emblem = spec;
  else if (typeof holder.emblem === 'string') pseudo.emblem = holder.emblem;
  try { return emblemSVG(pseudo, { size }); } catch { return ''; }
}

/** "Governo 40%" style label for a holder. */
export function holderLabel(holder) {
  if (!holder) return '';
  return `${holder.name || 'Investidor'}${Number.isFinite(holder.pct) ? ` ${Math.round(holder.pct)}%` : ''}`;
}

/** Investor badge (violet chip with the holder's emblem): mandates and programs of the anchor holder. */
function holderChip(holder) {
  if (!holder) return null;
  return h('span', { class: 'chip chip-investor', title: `Mandato de ${holder.name}` }, raw(holderEmblemSVG(holder, 16), 'ms-holder-em'), h('span', null, holder.name || 'Investidor'));
}

/** Penalty of a missed mandate in words (contract §5.1 penalty {mood, cashM?, pct?}). */
export function penaltyText(p, binding = false) {
  const parts = [`−${Math.abs(Number(p?.mood) || 25)} de humor do investidor`];
  if (Number(p?.cashM) > 0) parts.push(`multa de ${fmtMoney(p.cashM)}`);
  if (Number(p?.pct) > 0) parts.push(`${p.pct}% a mais da agência para ele`);
  return `${parts.join(', ')}${binding ? '. Abaixo de 50%, humor médio baixo em dois conselhos seguidos derruba a diretoria' : ''}.`;
}

/** The sim's agenda of own-mission slots (null without a cap table). */
function agendaOf(store) {
  const a = store.tryQuery('missions/agenda', null);
  return a && Number.isFinite(a.own) ? a : null;
}

/** "Agenda de 1962": own slots left vs the investors' share (EXPANSION.md §5.2). */
function agendaStrip(store, a, { compact = false } = {}) {
  if (!a) return null;
  const full = a.left <= 0;
  // in the builder (compact) the strip is one line + slots while there is room: the type grid must fit a 320x640 screen
  const brief = compact && (!full || !a.enforced);
  return h('div', { class: ['ms-agenda', full && 'full', brief && 'compact'], role: 'group', 'aria-label': `Agenda de ${a.year}` },
    h('div', { class: 'ms-agenda-row' },
      h('span', { class: 'ms-eyebrow' }, `Agenda de ${a.year}`),
      h('span', { class: 'ms-agenda-pct tiny' }, `Você tem ${Math.round(a.playerPct)}%${a.binding ? ' · mandatos obrigatórios' : ' · autonomia'}`)),
    h('div', { class: 'ms-slots', 'aria-hidden': 'true' },
      ...Array.from({ length: a.own }, (_, i) => h('span', { class: ['ms-slot', 'own', i < a.used && 'used'] })),
      ...Array.from({ length: a.M }, () => h('span', { class: 'ms-slot inv' }))),
    brief ? null : h('div', { class: 'tiny muted' }, full && !a.enforced
      ? `Cota própria de ${a.year} usada. Com autonomia o conselho não veta, mas os investidores esperam os mandatos deles.`
      : full
      ? `Sem vaga para missão própria até jan/${a.year + 1}. Os outros ${a.M} lugares são dos investidores.`
      : `${a.left} de ${a.own} vaga${a.own === 1 ? '' : 's'} própria${a.own === 1 ? '' : 's'} livre${a.left === 1 ? '' : 's'} · ${a.M} para mandatos dos investidores.`));
}

/** Open mandates of the investors, with or without a mission yet. */
function mandatesSection(store) {
  const list = store.tryQuery('missions/mandates', null);
  if (!Array.isArray(list) || !list.length) return null;
  const st = store.state;
  return h('div', null,
    sectionTitle('Mandatos dos investidores', h('span', { class: 'ms-count' }, String(list.length))),
    h('div', { class: 'mission-list ms-mandates' }, list.map((md) => {
      const m = md.missionId ? (st.missions || []).find((x) => x.id === md.missionId) : null;
      const open = () => {
        if (m) { if (needsHardware(m)) store.ui?.navigate?.('missoes', `m/${m.id}`); else openMission(store, m.id); return; }
        if (md.fulfilled) { toast('Mandato cumprido: o investidor confirma a entrega no próximo conselho.', 'good'); return; }
        const r = store.dispatch({ type: 'mission/fromMandate', mandateId: md.id });
        if (!r?.ok) { toast(r?.error || 'Não foi possível abrir o mandato.', 'bad'); return; }
        toast('Missão do mandato criada. Escolha o foguete e a nave.', 'good');
        store.ui?.navigate?.('missoes', `m/${r.missionId}`);
      };
      return card({
        cls: ['mission-card', 'ms-mandate', md.late && 'late'].filter(Boolean).join(' '), onClick: open,
        icon: raw(holderEmblemSVG(md.holder, 36), 'ms-holder-dot'), title: md.title,
        subtitle: `${holderLabel(md.holder)} · ${md.destinationName || '—'}${md.count > 1 ? ` · ${md.delivered}/${md.count} entregues` : ''}`,
      },
      h('div', { class: 'chips' },
        md.deadline ? chip(`prazo ${md.deadline}`, md.late ? 'bad' : 'warn', { class: 'ms-date' }) : null,
        md.rewardM ? chip(`+${fmtMoney(md.rewardM)} na entrega`, 'good') : null,
        m ? (needsHardware(m) ? chip('falta o veículo', 'warn', { class: 'falta-veiculo' }) : chip(STATUS_LABELS[m.status] || m.status, ''))
          : md.fulfilled ? chip('entregue', 'good') : chip('toque para montar a missão', 'accent')));
    })));
}

/** Leading 36px circle with a type emoji (emoji allowed inside content, DESIGN §2). */
function typeDot(type) {
  return h('span', { class: 'ms-dot', 'aria-hidden': 'true' }, TYPE_ICONS[missionTypeOf(type)] || TYPE_ICONS[type] || '🚀');
}

/** Status chip kind: info = in flight, accent = waits on you (planning), neutral = scheduled, muted = cancelled. */
function statusKind(m, provisional) {
  if (provisional || ['launch', 'transit', 'arrival', 'operations'].includes(m.status)) return 'info';
  if (m.status === 'planning') return '';
  if (m.status === 'done') return 'good';
  if (m.status === 'cancelled') return 'muted';
  return '';
}

// MISSIONS-V2 §1.1: "Pouso" is gone (a probe sent to a surface is the landing); Rover is the long-lived surface type
export const TYPES = ['satellite', 'probe', 'rover', 'crewed', 'cargo', 'station'];
const TYPE_HINT = {
  satellite: 'Comunicação, observação, ciência', probe: 'Sobrevoo, órbita ou pouso', rover: 'Ciência na superfície por anos',
  crewed: 'Gente a bordo: glória e risco', cargo: 'Suprimentos, módulos, veículos', station: 'Montar ou ampliar em órbita',
};
// fallback compatibility when missions/draftOptions is not available yet (spacecraft kinds per type, §1.1)
const TYPE_KINDS = {
  satellite: ['satellite'], probe: ['probe', 'lander', 'satellite'], rover: ['rover'], crewed: ['capsule', 'lander', 'habitat'],
  cargo: ['cargo', 'capsule', 'lander'], station: [],
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
    source: 'custom', type: null, sub: null, payload: null, destination: null, vehicleId: null, spacecraftId: null, secondarySpacecraftId: null,
    crew: { flightDirector: null, commander: null, astronauts: [] },
    config: { strategy: 'balanced', fuelMargin: 0.1, payloadT: null },
    ...patch,
  };
}

/** Mission type to preselect for a destination: its own list (missionTypes) first, then a guess from the id. */
export function defaultTypeFor(dest, currentType = null) {
  currentType = missionTypeOf(currentType);
  const list = Array.isArray(dest?.missionTypes) && dest.missionTypes.length ? [...new Set(dest.missionTypes.map(missionTypeOf))] : null;
  if (list) return list.includes(currentType) ? currentType : list[0];
  const id = String(dest?.id || '');
  if (/surface|south_pole/.test(id) || dest?.kind === 'surface') return currentType === 'rover' || currentType === 'crewed' || currentType === 'cargo' ? currentType : 'probe';
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
  const type = defaultTypeFor(dest, keep?.type);
  ui.draft = newDraft({ ...(keep ? { config: keep.config } : {}), destination: destId, type, sub: type === 'probe' ? deriveProbeSub(dest.kind) : null });
  ui.subAuto = type === 'probe';
  ui.step = 1; ui.noFd = false; ui.noCraft = false; ui.launchTurn = null; ui.destOpen = false;
  ui.seg = 'nova';
  return true;
}

/** The builder's current draft (read-only use: tests, debugging). */
export function currentDraft() { return ui.draft; }
/** Builder step (1–3) to show next (tests and deep links; the stepper keeps its own rules for the player). */
export function setBuilderStep(n) { ui.step = Math.max(1, Math.min(3, Number(n) || 1)); return ui.step; }

/**
 * Open the builder prefilled (Infraestrutura actions, the derelict card's "Resgatar", contracts): patch = draft
 * fields ({type, sub, destination, payload}). Starts on step 1 so the player sees target and cargo; the caller
 * navigates to #missoes/nova.
 */
export function prefillBuilder(patch = {}) {
  const t = missionTypeOf(patch.type);
  ui.draft = newDraft({ ...patch, type: t, sub: patch.sub || (patch.type === 'lander' ? 'lander' : null), payload: patch.payload ? { ...emptyPayload(), ...patch.payload } : null });
  ui.subAuto = false; ui.destOpen = false;
  ui.step = 1; ui.noFd = false; ui.noCraft = false; ui.launchTurn = null; ui.name = '';
  ui.seg = 'nova';
  return ui.draft;
}

// ------------------------------------------------------------------ Missões v2: subtypes, targets, cargo (MISSIONS-V2 §1, §11)

/** Empty payload of a draft (§1.4). */
export function emptyPayload(kind = null) {
  return { kind, moduleId: null, vehicleTypeId: null, qty: 1, targetAssetId: null, newAsset: false, newAssetName: null };
}

/** Probe subtype from the destination kind when the player did not pick one (§1.2: probe + surface = the landing). */
export const PROBE_SUB_BY_KIND = { surface: 'lander', atmosphere: 'atmospheric', flyby: 'flyby', orbit: 'orbiter', rendezvous: 'small_body', station: 'orbiter', interstellar: 'interstellar' };
export function deriveProbeSub(destKind) { return PROBE_SUB_BY_KIND[destKind] || null; }

/** Draft needs a station/base/satellite asset as its target (§1.5 "Escolha a estação ou base de destino."). */
export function needsTarget(d) {
  const t = missionTypeOf(d?.type), s = d?.sub;
  if (t === 'station') return true;
  if (t === 'cargo') return !!s && s !== 'client';
  if (t === 'crewed') return s === 'rotation' || s === 'servicing';
  return false;
}

/** Asset kind the draft delivers into: 'station' | 'base' | 'satellite'. */
export function targetKindOf(d, dest) {
  const t = missionTypeOf(d?.type);
  if (t === 'station') return 'station';
  if (d?.sub === 'servicing') return 'satellite';
  if (t === 'cargo' && (d.sub === 'base_module' || d.sub === 'base_vehicle')) return 'base';
  return dest?.kind === 'surface' ? 'base' : 'station';
}

/**
 * A new asset can be founded by this draft: a first station module in orbit, a first base module/vehicle on a
 * surface. A station destination (ISS, Salyut: `kind: 'station'`) is somebody's station: modules sent there expand
 * it (missions.resolveSub derives 'expand'), never found a second one.
 */
export function canFound(d, dest) {
  const t = missionTypeOf(d?.type);
  if (t === 'station') return !!dest && !['surface', 'flyby', 'station', 'atmosphere', 'interstellar'].includes(dest.kind) && dest.stationOk !== false;
  if (t === 'cargo' && (d.sub === 'base_module' || d.sub === 'base_vehicle')) return dest?.kind === 'surface';
  return false;
}

/** Payload kind implied by type + sub (cargo sub = payload kind; station = a station module). */
export function payloadKindOf(d) {
  const t = missionTypeOf(d?.type);
  if (t === 'station') return 'station_module';
  if (t === 'cargo') return d?.sub || null;
  return null;
}

// fallback keys of the subtypes whose key is not "<type>:<sub>" (§4.5)
const SUB_KEYS = {
  crewed: { rotation: 'missionType:rotation', servicing: 'missionType:servicing', tourism: 'missionType:tourism', landing: 'spacecraft:lander_crewed' },
  cargo: { supply: 'missionType:supply', base_module: 'missionType:base', base_vehicle: 'missionType:base', propellant: 'missionType:propellant', servicing: 'missionType:servicing_robotic' },
};

/** Subtype rows of a type: data/core/missions.json `subtypes` when loaded, else the §1.2 labels. Pure. */
export function subtypeRows(data, type) {
  const t = missionTypeOf(type);
  const raw = data?.missions?.subtypes;
  let list = null;
  if (Array.isArray(raw)) list = raw.filter((r) => r && r.type === t);
  else if (raw && typeof raw === 'object' && raw[t]) list = Object.entries(raw[t]).map(([id, r]) => ({ id, type: t, ...(r || {}) }));
  if (list && list.length) return list.map((r) => ({ ...r, label: r.label || SUB_LABELS[t]?.[r.id] || r.id, histYear: r.histYear ?? SUB_YEARS[t]?.[r.id] ?? null }));
  return Object.entries(SUB_LABELS[t] || {}).map(([id, label]) => ({
    id, type: t, label, histYear: SUB_YEARS[t]?.[id] ?? null,
    key: SUB_KEYS[t]?.[id] || (['satellite', 'probe', 'rover'].includes(t) ? `${t}:${id}` : null),
  }));
}

const yearOfState = (st) => (st?.startYear ?? 0) + Math.floor((st?.turn ?? 0) / 52);

/**
 * UI-side lock of an unlock key (the sim's draftOptions `locked` wins when present): null = open, else
 * { reason, nodeId }. Same rule as gating.keyHeld (§5.1): with scenario.techGating the player's research decides
 * (research.keys, or the unlocked nodes granting it); otherwise the year of the earliest node granting it.
 * Unknown keys (no node grants them) are open. Pure.
 */
export function keyLock(state, data, key, histYear = null) {
  const year = yearOfState(state);
  const nodes = key ? (data?.tech?.nodes || []).filter((n) => Array.isArray(n?.unlocks) && n.unlocks.some((u) => u?.key === key)) : [];
  if (data?.scenario?.techGating === true && nodes.length) {
    const keys = state?.research?.keys;
    const have = Array.isArray(keys) ? keys.includes(key) : nodes.some((n) => (state?.research?.unlocked || []).includes(n.id));
    if (have) return null;
    const node = nodes.slice().sort((a, b) => (a.fromYear ?? 0) - (b.fromYear ?? 0) || (a.cost ?? 0) - (b.cost ?? 0))[0];
    return { reason: `Pesquise ${node.name || node.id}`, nodeId: node.id, nodeName: node.name || node.id, year: node.histYear ?? null };
  }
  const ky = nodes.length ? Math.min(...nodes.map((n) => Number(n.histYear ?? n.fromYear ?? Infinity))) : Number(histYear);
  if (Number.isFinite(ky) && year < ky) return { reason: `Disponível a partir de ${ky}`, nodeId: null, year: ky };
  return null;
}

/**
 * Safety net for rows the sim left open: gating.keyHeld reads a key that no LOADED tech node grants as held, and the
 * browser loads only the tech packs up to the current era (§4.3). So, for a row with `key`/`histYear`:
 * - with scenario.techGating, a key the player does not hold (research.keys) and no loaded node grants is research
 *   of a later era: locked ("Pesquisa de uma era futura"); a key a loaded node grants is the sim's call (left open);
 * - without techGating (Corrida Lunar, era packs excluded) the date rule of §0.2 on the row's own histYear.
 * Pure; null = open.
 */
export function dateLock(state, data, histYear, key = null) {
  const y = Number(histYear);
  if (data?.scenario?.techGating === true) {
    if (!key) return null;
    const keys = state?.research?.keys;
    if (Array.isArray(keys) && keys.includes(key)) return null;
    const granted = (data?.tech?.nodes || []).some((n) => Array.isArray(n?.unlocks) && n.unlocks.some((u) => u?.key === key));
    if (granted) return null;
    return { reason: Number.isFinite(y) ? `Pesquisa de uma era futura (por volta de ${y})` : 'Pesquisa de uma era futura', nodeId: null, year: Number.isFinite(y) ? y : null };
  }
  return Number.isFinite(y) && yearOfState(state) < y ? { reason: `Disponível a partir de ${y}`, nodeId: null, year: y } : null;
}

/** The sim's lock of an option entry ({locked:{reason,nodeId}} or ok/valid false + reason), normalized. */
function simLock(x) {
  if (!x) return null;
  if (x.locked && typeof x.locked === 'object') return { reason: x.locked.reason || 'Bloqueado', nodeId: x.locked.nodeId || null, year: x.locked.year ?? null };
  if (x.locked === true) return { reason: x.reason || 'Bloqueado', nodeId: x.nodeId || null };
  return null;
}

/**
 * Subtype chips for the draft: [{id, label, lock, fit, hidden}] — `fit` false when the destination does not suit
 * the sub ("{Sub} não serve para {destino}."), `hidden` for far-future locked subs (summarized in one line).
 */
export function subOptions(state, data, d, simSubs = null, dest = null) {
  const t = missionTypeOf(d?.type);
  if (!t || t === 'station') return [];
  const year = yearOfState(state);
  const bySim = Array.isArray(simSubs) ? new Map(simSubs.filter(Boolean).map((s) => [typeof s === 'string' ? s : s.id, s])) : null;
  return subtypeRows(data, t).filter((r) => !(r.id === 'client' && d.sub !== 'client') && (!bySim || bySim.has(r.id) || r.id === d.sub)).map((r) => {
    const s = bySim?.get(r.id);
    const lock = s && typeof s === 'object' ? simLock(s) || dateLock(state, data, s.histYear ?? r.histYear, s.key || r.key) : keyLock(state, data, r.key, r.histYear);
    const kinds = r.dest?.kinds;
    const simUnfit = !!s && typeof s === 'object' && (s.ok === false || s.valid === false);
    const fit = simUnfit ? false : !dest || !Array.isArray(kinds) || !kinds.length || kinds.includes(dest.kind);
    const why = simUnfit ? (s.reason || s.reasons?.[0] || null) : !fit && dest ? `${r.label} não serve para ${dest.name || dest.id}.` : null;
    const far = !!lock && Number.isFinite(lock.year ?? r.histYear) && (lock.year ?? r.histYear) > year + 25 && r.id !== d.sub;
    return { id: r.id, label: (s && s.label) || r.label, lock, fit, why, hidden: far, row: r };
  });
}

/** Subtype to preselect when a type (or destination) is picked: the destination's natural one, else the first open. */
export function defaultSubFor(type, dest, subs) {
  const t = missionTypeOf(type);
  const open = (subs || []).filter((s) => !s.lock && s.fit !== false && !s.hidden);
  const has = (id) => open.some((s) => s.id === id);
  let want = null;
  if (t === 'probe') want = deriveProbeSub(dest?.kind);
  else if (t === 'crewed') want = dest?.kind === 'surface' ? 'landing' : dest?.kind === 'station' ? 'rotation' : dest?.kind === 'flyby' ? 'flyby' : 'orbital';
  else if (t === 'cargo') want = dest?.kind === 'surface' ? 'base_module' : 'supply';
  else if (t === 'satellite') want = ['comms', 'science', 'weather'].find(has) || null;
  if (want && has(want)) return want;
  return open[0]?.id || null;
}

/** Carrier cargo capacity in t (spacecraft cargoT; §1.4 default by kind). */
export function carrierCargoT(sc) {
  if (!sc) return 0;
  if (Number.isFinite(Number(sc.cargoT))) return Number(sc.cargoT);
  const m = Number(sc.massT) || 0;
  if (sc.kind === 'cargo' || sc.kind === 'capsule') return Math.round(m * 0.35 * 10) / 10;
  if (sc.kind === 'lander') return Math.round(m * 0.25 * 10) / 10;
  return 0;
}

/** Payload mass in t for the draft's cargo (§1.4): modules, vehicles × qty, supply/propellant tonnes, 0.5 t kit. */
export function payloadMassT(payload, { module = null, vehicle = null } = {}) {
  const p = payload || {};
  const qty = Math.max(1, Number(p.qty) || 1);
  switch (p.kind) {
    case 'station_module': case 'base_module': return module ? Number(module.massT) || 0 : null;
    case 'base_vehicle': return vehicle ? Math.round((Number(vehicle.massT) || 0) * qty * 10) / 10 : null;
    case 'supply': case 'propellant': return qty;
    case 'servicing': return 0.5;
    case 'experiments': return Number(p.massT) || 1;
    default: return null;
  }
}

const TRAIT_TEXT = {
  eva: 'caminhadas espaciais: desgaste −30%', arm: 'braço robótico: atracação', depot: '+5% de carga saindo desta órbita',
  gravity: 'gravidade artificial', shipyard: '−10% no custo das naves daqui', support: 'apoio do público',
};
const n1 = (x) => String(Math.round((Number(x) || 0) * 10) / 10).replace('.', ',');

/** What a module or surface vehicle adds, in words ("+8 ciência/ano · +3 tripulantes"). Pure. */
export function moduleAddsText(m, max = Infinity) {
  if (!m) return '';
  const out = [];
  if (Number(m.science) > 0) out.push(`+${n1(m.science)} ciência/ano`);
  if (Number(m.crew) > 0) out.push(`+${m.crew} tripulante${m.crew === 1 ? '' : 's'}`);
  if (Number(m.housing) > 0) out.push(`moradia para ${m.housing}`);
  if (Number(m.ports) > 0) out.push(`+${m.ports} porta${m.ports === 1 ? '' : 's'}`);
  if (Number(m.power) > 0) out.push(`+${m.power} energia`);
  if (Number(m.life) > 0) out.push(`+${m.life} suporte de vida`);
  if (Number(m.storageT) > 0) out.push(`+${n1(m.storageT)} t de estoque`);
  if (Number(m.isruTYr) > 0) out.push(`produz ${n1(m.isruTYr)} t/ano no local`);
  if (Number(m.food) > 0) out.push('alimento');
  if (Number(m.unload) > 0 || m.unload === true) out.push('descarrega as naves');
  for (const t of m.traits || []) if (TRAIT_TEXT[t]) out.push(TRAIT_TEXT[t]);
  return out.slice(0, max).join(' · ');
}

/** Module/vehicle tables (data/core/modules.json): station, base, vehicles. */
function modulesData(store) { return store.data?.modules || null; }

/**
 * Module or surface-vehicle cards for the draft's cargo: [{...row, lock}] from the sim (draftOptions.modules /
 * surfaceVehicles, with `locked`) or from modules.json + keyLock. Vehicles are filtered by the target body.
 */
export function cargoRows(state, data, d, sim = null, dest = null) {
  const kind = payloadKindOf(d);
  const isVeh = kind === 'base_vehicle';
  if (!['station_module', 'base_module', 'base_vehicle'].includes(kind)) return [];
  const simList = Array.isArray(sim) ? sim : null;
  const md = data?.modules || {};
  const base = isVeh ? md.vehicles : kind === 'station_module' ? md.station : md.base;
  const table = new Map((Array.isArray(base) ? base : []).map((r) => [r.id, r]));
  const rows = simList ? simList.map((x) => ({ ...(table.get(x.id) || {}), ...x })) : [...table.values()];
  const body = dest?.body || null;
  const year = yearOfState(state);
  return rows.filter((r) => r && r.id && (!isVeh || !Array.isArray(r.bodies) || !r.bodies.length || !body || r.bodies.includes(body))).map((r) => {
    const lock = simList ? simLock(r) || (r.ok === false || r.valid === false ? { reason: r.reason || r.reasons?.[0] || 'Indisponível', nodeId: r.nodeId || null } : null) || dateLock(state, data, r.histYear, r.key)
      : keyLock(state, data, r.key, r.histYear);
    const ly = lock ? (lock.year ?? r.histYear) : null;
    return { ...r, label: r.label || r.name || r.id, lock, hidden: !!lock && Number.isFinite(ly) && ly > year + 25 };
  }).sort((a, b) => (!!a.lock - !!b.lock) || ((a.histYear ?? 0) - (b.histYear ?? 0)));
}

// ------------------------------------------------------------------ assets (state.assets via infra/* queries)

/** Upkeep in t/year of an asset (§3.4): module upkeep + crew × 2.5 − local production. Pure. */
export function upkeepTYr(asset, md) {
  const table = new Map([...(md?.station || []), ...(md?.base || [])].map((r) => [r.id, r]));
  const crewTYr = Number(md?.tuning?.crewTYr ?? 2.5);
  let up = 0, isru = 0;
  for (const m of Array.isArray(asset?.modules) ? asset.modules : []) { const r = table.get(m.id); up += (Number(r?.upkeepTYr) || 0) * (m.n || 1); isru += (Number(r?.isruTYr) || 0) * (m.n || 1); }
  up += (Number(asset?.crew?.n ?? asset?.crew) || 0) * crewTYr;
  return Math.max(0, up - isru);
}

/** Storage in t of an asset (Σ storageT, min 2 t). Pure. */
export function storageT(asset, md) {
  const table = new Map([...(md?.station || []), ...(md?.base || [])].map((r) => [r.id, r]));
  let s = 0;
  for (const m of Array.isArray(asset?.modules) ? asset.modules : []) s += (Number(table.get(m.id)?.storageT) || 0) * (m.n || 1);
  return Math.max(2, s);
}

/** Player's share of an asset (§3.3): (massT + crewWeeks × 0.05) / Σ; owner alone = 100%. Pure. */
export function shareOf(asset, actorId) {
  if (Number.isFinite(asset?.share) && asset.shareActorId === actorId) return asset.share;
  const ps = Array.isArray(asset?.partners) ? asset.partners : [];
  if (ps.some((p) => Number.isFinite(p?.share) && p.massT == null)) return (ps.find((p) => p.actorId === actorId)?.share || 0) / 100;
  const w = (p) => (Number(p.massT) || 0) + (Number(p.crewWeeks) || 0) * 0.05;
  const total = ps.reduce((s, p) => s + w(p), 0);
  if (!(total > 0)) return asset?.ownerId === actorId ? 1 : 0;
  return ps.filter((p) => p.actorId === actorId).reduce((s, p) => s + w(p), 0) / total;
}

/**
 * One asset view for the UI, from the 'infra/list' view (preferred) or a raw state.assets entry: names, owner,
 * supply weeks, science, share, flags. Never undefined/NaN in the fields the UI prints. Pure.
 */
export function normalizeAsset(a, st, data) {
  const md = data?.modules || null;
  const pid = st?.playerId;
  const up = Number.isFinite(a.upkeepTYr) ? a.upkeepTYr : upkeepTYr(a, md);
  const stor = Number.isFinite(a.storageT) ? a.storageT : storageT(a, md);
  const supplyT = Number(a.supplyT) || 0;
  const usesSupply = a.kind === 'station' || a.kind === 'base';
  const supplyWeeks = Number.isFinite(a.supplyWeeks) ? a.supplyWeeks : usesSupply ? (up > 0 ? Math.floor((supplyT * 52) / up) : Infinity) : null;
  const owner = st?.actors?.[a.ownerId];
  const dest = data?.index?.destinations?.[a.site];
  const partners = (Array.isArray(a.partners) ? a.partners : []).filter((p) => p && p.actorId);
  // the sim's view carries percentages (myShare, partners[].share); a raw slice entry carries contributions
  const share = Number.isFinite(a.myShare) ? a.myShare / 100 : Number.isFinite(a.share) ? a.share : shareOf(a, pid);
  const units = Number.isFinite(Number(a.units)) && !Array.isArray(a.units) ? Number(a.units) : Array.isArray(a.units) ? a.units.reduce((s, u) => s + (Number(u?.n) || 0), 0) : 0;
  const mods = Array.isArray(a.modules) ? a.modules : [];
  const vehs = Array.isArray(a.vehicles) ? a.vehicles : [];
  const lifeEnd = Number.isFinite(a.lifeEndTurn) ? a.lifeEndTurn
    : Array.isArray(a.units) && a.units.length ? Math.max(...a.units.map((u) => Number(u?.endTurn) || 0)) : null;
  return {
    ...a,
    name: a.name || 'Sem nome',
    status: a.status || 'active',
    health: Math.max(0, Math.min(100, Number.isFinite(Number(a.health)) ? Number(a.health) : 100)),
    ownerName: a.ownerName || owner?.short || owner?.name || a.ownerId || '—',
    siteName: a.siteName || dest?.name || a.site || '—',
    mine: a.ownerId === pid,
    partner: a.ownerId !== pid && partners.some((p) => p.actorId === pid),
    partners,
    share: Math.max(0, Math.min(1, Number(share) || 0)),
    upkeepTYr: up, storageT: stor, supplyT, supplyWeeks,
    modules: mods, vehicles: vehs,
    crewN: Number(a.crew?.n ?? a.crew) || 0,
    crewCap: Number.isFinite(a.crewCap) && a.crewCap > 0 ? a.crewCap : null,
    sciYr: Number.isFinite(Number(a.sciYr)) ? Number(a.sciYr) : 0,
    mySciYr: Number.isFinite(Number(a.mySciYr)) ? Number(a.mySciYr) : null,
    distanceKm: Number.isFinite(Number(a.km ?? a.distanceKm)) && (a.km ?? a.distanceKm) != null ? Number(a.km ?? a.distanceKm) : null,
    modulesN: Number.isFinite(Number(a.modules)) && !Array.isArray(a.modules) ? Number(a.modules) : mods.reduce((s, m) => s + (Number(m?.n) || 1), 0),
    vehiclesN: vehs.reduce((s, v) => s + (Number(v?.n) || 1), 0),
    unitsN: units,
    lifeEndTurn: lifeEnd,
    alerts: Array.isArray(a.alerts) ? a.alerts : [],
  };
}

/** All assets the UI can show (infra/list, else state.assets.list), normalized; ended ones last. */
export function assetViews(store) {
  const q = store.tryQuery?.('infra/list', null);
  const list = Array.isArray(q) ? q : Array.isArray(q?.list) ? q.list : Array.isArray(store.state?.assets?.list) ? store.state.assets.list : [];
  return list.filter((a) => a && a.id).map((a) => normalizeAsset(a, store.state, store.data));
}

/** Player assets that need attention: supply for < 13 weeks, or derelict (Infra badge, Painel alerts). Pure on views. */
export function assetsNeedingSupply(views) {
  return (views || []).filter((a) => (a.mine || a.partner) && a.status !== 'ended'
    && (a.status === 'derelict' || (Number.isFinite(a.supplyWeeks) && a.supplyWeeks < 13)));
}

/**
 * Target rows for the draft at its destination: own assets first, then partners', then others' (§11).
 * From draftOptions.targets (sim, with ok/reason) joined with the asset views, else derived from the views.
 */
export function targetOptions(store, d, simTargets = null, dest = null) {
  const st = store.state;
  const views = assetViews(store);
  const byId = new Map(views.map((a) => [a.id, a]));
  const kind = targetKindOf(d, dest);
  let rows;
  if (Array.isArray(simTargets)) {
    rows = simTargets.filter(Boolean).map((t) => {
      const a = byId.get(t.assetId || t.id) || normalizeAsset({ ...t, id: t.assetId || t.id }, st, store.data);
      return { ...a, ok: t.ok !== false, reason: t.reason || null };
    });
  } else {
    const site = d?.destination;
    rows = views.filter((a) => a.status !== 'ended' && a.kind === kind && (!site || a.site === site || (dest?.assetHist && a.histId === dest.assetHist)))
      .map((a) => {
        let ok = true, reason = null;
        const rescue = d?.sub === 'supply' || d?.sub === 'servicing';
        if (a.status === 'derelict' && !(a.mine && rescue)) { ok = false; reason = `${a.name} está abandonada.`; }
        else if (!a.mine && !a.partner) { ok = false; reason = `Precisa de uma parceria de estação com ${a.ownerName}.`; }
        return { ...a, ok, reason };
      });
  }
  const rank = (a) => (a.mine ? 0 : a.partner ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.ok - a.ok) || String(a.name).localeCompare(String(b.name)));
}

const ROVER_LIFE = { light: 1, micro: 0.25, medium: 3, heavy: 10, rotorcraft: 2, swarm: 6, cryobot: 5, submarine: 4 };
const ROVER_SCI = { light: 8, micro: 4, medium: 14, heavy: 22, rotorcraft: 10, swarm: 25, cryobot: 30, submarine: 35 };
const SAT_SCI = { observatory: 18, deep_observatory: 40, gravity_lens: 120, science: 5, earth_obs: 2 };
const SAT_REV = { comms: 30, constellation: 4, power: 80 };

/**
 * "O que esta missão cria/muda" (§11 step 3): { title, rows: [[label, value]], note } or null. The sim's own
 * draftOptions.preview wins; this is the data-based estimate. Pure.
 */
export function assetPreview({ d, dest = null, target = null, module = null, vehicle = null, subRow = null, md = null, playerId = null, sc = null } = {}) {
  const t = missionTypeOf(d?.type);
  const where = dest?.name || d?.destination || 'o destino';
  const yrs = (x) => (x >= 1 ? `${n1(x)} ano${x >= 2 ? 's' : ''}` : `${Math.max(1, Math.round(x * 12))} meses`);
  if (t === 'satellite') {
    const sub = d.sub;
    const life = Number(subRow?.asset?.lifeYears) || null;
    const sci = Number(subRow?.yield?.scienceYr ?? SAT_SCI[sub]) || 0;
    const rev = Number(subRow?.yield?.revenueMYr ?? SAT_REV[sub]) || 0;
    const rows = [['Cria', `+1 unidade na frota de ${(SUB_LABELS.satellite[sub] || 'satélites').toLowerCase()} ${dest?.emLabel || `em ${where}`}`]];
    if (life) rows.push(['Vida útil', yrs(life)]);
    if (sci) rows.push(['Ciência', `~${n1(sci)} por ano até o fim da vida útil`]);
    if (rev) rows.push(['Receita', `~US$ ${n1(rev)} mi por ano`]);
    return { title: 'Satélite em serviço', rows, note: subRow?.asset?.serviceable ? 'Pode receber manutenção (kit de reparo ou tripulação) para durar mais.' : null };
  }
  if (t === 'rover') {
    const life = Number(subRow?.asset?.lifeYears ?? ROVER_LIFE[d.sub]) || 0;
    const sci = Number(subRow?.yield?.scienceYr ?? ROVER_SCI[d.sub]) || 0;
    const rows = [['Cria', `${SUB_LABELS.rover[d.sub] || 'Rover'} ${dest?.emLabel || `em ${where}`}`]];
    if (life) rows.push(['Vida útil prevista', yrs(life)]);
    if (sci) rows.push(['Ciência', `~${n1(sci)} por ano (mais em mundos ricos)`]);
    return { title: 'Rover na superfície', rows, note: 'Ciência na chegada e depois todo ano enquanto ele rodar.' };
  }
  if (t === 'crewed' && d.sub === 'rotation' && target) {
    return { title: `Tripulação em ${target.name}`, rows: [['Muda', `${target.name} recebe tripulantes por ~26 semanas`], ['Ciência hoje', `${n1(target.sciYr)} por ano`]], note: 'Com a tripulação completa, os laboratórios rendem até 2,5× mais.' };
  }
  if (t !== 'station' && t !== 'cargo') return null;
  const kind = payloadKindOf(d);
  const p = d.payload || {};
  if (kind === 'client' || !kind) return null;
  const isNew = !target && !!p.newAsset;
  const name = isNew ? (p.newAssetName || (t === 'station' ? 'Nova estação' : 'Nova base')) : target?.name;
  if (!name) return null;
  const rows = [];
  const mods = (target?.modules || []).map((m) => ({ ...m }));
  if ((kind === 'station_module' || kind === 'base_module') && module) {
    const ex = mods.find((m) => m.id === module.id);
    if (ex) ex.n = (ex.n || 1) + 1; else mods.push({ id: module.id, n: 1 });
    rows.push([isNew ? 'Cria' : 'Muda', isNew ? `${name} com ${module.label || module.id}` : `+ ${module.label || module.id} (${mods.reduce((s, m) => s + (m.n || 1), 0)} módulos)`]);
  }
  if (kind === 'base_vehicle' && vehicle) rows.push([isNew ? 'Cria' : 'Muda', `${isNew ? `${name} com ` : '+ '}${Math.max(1, p.qty || 1)} × ${vehicle.label || vehicle.id}`]);
  const after = { modules: mods, crew: target?.crew || { n: 0 } };
  const sciFull = mods.reduce((s, m) => s + (Number([...(md?.station || []), ...(md?.base || [])].find((r) => r.id === m.id)?.science) || 0) * (m.n || 1), 0);
  if (md && mods.length) {
    const up = upkeepTYr(after, md);
    const addSci = (kind === 'base_vehicle' && vehicle ? (Number(vehicle.science) || 0) * Math.max(1, p.qty || 1) : Number(module?.science) || 0);
    rows.push(['Ciência', target && Number.isFinite(target.sciYr)
      ? `${n1(target.sciYr)} por ano hoje${addSci > 0 ? ` · +${n1(addSci)} com a entrega` : ''}`
      : `até ${n1(sciFull + (kind === 'base_vehicle' ? addSci : 0))} por ano com tripulação`]);
    rows.push(['Manutenção', `${n1(up)} t de carga por ano`]);
    const stor = storageT(after, md);
    let sup = Number(target?.supplyT) || 0;
    if (kind === 'supply') sup = Math.min(stor, sup + Math.max(1, p.qty || 1));
    rows.push(['Reserva', up > 0 ? `${Math.floor((sup * 52) / up)} semanas (estoque ${n1(stor)} t)` : 'sem consumo']);
  } else if (kind === 'supply' || kind === 'propellant') {
    rows.push(['Entrega', `${Math.max(1, p.qty || 1)} t ${kind === 'supply' ? 'de suprimentos' : 'de propelente'}`]);
    if (target && Number.isFinite(target.supplyWeeks)) rows.push(['Reserva hoje', `${target.supplyWeeks} semanas`]);
  } else if (kind === 'experiments') rows.push(['Muda', `${name}: +50% de ciência por 26 semanas`]);
  else if (kind === 'servicing') rows.push(['Muda', `${name}: a unidade mais velha ganha +5 anos de vida`]);
  if (target && !target.mine && playerId) {
    const massAdd = payloadMassT(p, { module, vehicle }) || 0;
    const ps = [...(target.partners || [])];
    const w = (q) => (Number(q.massT) || 0) + (Number(q.crewWeeks) || 0) * 0.05;
    const tot = ps.reduce((s, q) => s + w(q), 0) + massAdd;
    const mine = ps.filter((q) => q.actorId === playerId).reduce((s, q) => s + w(q), 0) + massAdd;
    if (tot > 0) rows.push(['Sua participação', `${Math.round((mine / tot) * 100)}%`]);
  } else if (isNew) rows.push(['Sua participação', '100%']);
  return { title: isNew ? `Nova: ${name}` : name, rows, note: kind === 'supply' ? 'Sem suprimentos a estação ou base se degrada e a tripulação é evacuada.' : null };
}

export function render(container, store) {
  const st = store.state;
  const route = attempt(() => store.ui?.route?.(), { sub: '' }) || { sub: '' };
  const sub = route.sub || '';
  if (sub === 'nova' || sub === 'contratos' || sub === 'lista' || sub === 'frota') ui.seg = sub;
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
  const nContracts = contracts.filter((c) => c.status === 'awarded' || c.status === 'late').length;
  const offers = contractsBadge(st);
  ensureCss();
  const all = Array.isArray(st.missions) ? st.missions : [];
  const flying = all.filter((m) => ['launch', 'transit', 'arrival', 'operations'].includes(m.status)).length;
  const sched = all.filter((m) => m.status === 'scheduled').length;
  const lead = [`${flying} em voo`, `${sched} agendada${sched === 1 ? '' : 's'}`, nContracts ? `${nContracts} contrato${nContracts === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ');
  const root = h('div', { class: 'view-pad missions' },
    viewHead('Programa espacial', { lead }),
    segmented([
      { id: 'lista', label: 'Programa' },
      { id: 'nova', label: 'Montar' },
      { id: 'contratos', label: 'Contratos', badge: offers === true ? '!' : offers || null },
      { id: 'frota', label: 'Frota' },
    ], ui.seg, go, { cls: 'tabs' }));
  container.appendChild(root);

  // item 9: an accepted mission without a rocket opens on its vehicle step (#missoes/m/<id>); 'm/<id>/veiculo'
  // is the same step for a mission that already has one (Trocar o veículo)
  const routeMission = sub.startsWith('m/') ? (st.missions || []).find((x) => x.id === sub.slice(2).split('/')[0]) : null;
  const hwMission = routeMission && (needsHardware(routeMission) || (sub.endsWith('/veiculo') && routeMission.status === 'planning' && !lockedVehicle(routeMission))) ? routeMission : null;
  if (hwMission) {
    ui.openedRoute = sub;
    root.appendChild(safePanel(() => hardwareStep(store, hwMission, rerender), 'A escolha do veículo não pôde ser exibida.'));
    return;
  }
  if (ui.seg === 'nova') root.appendChild(safePanel(() => builder(store, rerender), 'A montagem de missões ainda está em construção.'));
  else if (ui.seg === 'contratos') root.appendChild(safePanel(() => contractsView(store, rerender), 'Contratos indisponíveis por enquanto.'));
  else if (ui.seg === 'frota') root.appendChild(safePanel(() => fleetView(store, rerender), 'A frota não pôde ser exibida.'));
  else root.appendChild(safePanel(() => listView(store, go), 'A lista de missões não pôde ser exibida.'));

  // deep link from the dashboard: #missoes/m/<id> opens the mission sheet once
  if (sub.startsWith('m/') && ui.openedRoute !== sub) {
    ui.openedRoute = sub;
    const m = (st.missions || []).find((x) => x.id === sub.slice(2));
    if (m) setTimeout(() => openMission(store, m.id), 0);
  } else if (!sub.startsWith('m/')) ui.openedRoute = null;
}

// ------------------------------------------------------------------ vehicle step of an accepted mission (item 9)

/** The mission still needs the player's rocket/craft choice (planning, no vehicle, not a certification flight). */
export function needsHardware(m) {
  // an Estaleiro craft test (testCraftId) flies on a rocket the player picks; a Hangar rocket test is the rocket
  return m && m.status === 'planning' && !m.vehicleId && m.source !== 'cert' && (m.source !== 'test' || !!m.testCraftId) ? m : null;
}

/** The vehicle is the object of the flight (crew-certification demo, builder test flight): it cannot be swapped. */
export function lockedVehicle(m) {
  return !!m && (m.source === 'cert' || (m.source === 'test' && !m.testCraftId) || !!m.certVehicleId || !!m.testDesignId);
}

/** Choice -> mission/update payload (only the hardware fields; the sim recomputes cost, estimate and fuel fit). */
export function hardwareUpdate(missionId, pick) {
  return { type: 'mission/update', missionId, patch: { vehicleId: pick.vehicleId || null, spacecraftId: pick.spacecraftId || null, secondarySpacecraftId: pick.secondarySpacecraftId || null } };
}

/** Holder + deadline under the vehicle step's title (investor mandates and anchor-holder programs). */
function hwHolderLine(store, m) {
  const hd = store.tryQuery('missions/get', null, m.id)?.holder || null;
  if (!hd) return null;
  const st = store.state;
  return h('div', { class: 'chips hw-holder' }, holderChip(hd),
    Number.isFinite(m.deadlineTurn) ? chip(`prazo ${fmtMonth(m.deadlineTurn, st.startYear)}`, st.turn > m.deadlineTurn ? 'bad' : 'warn', { class: 'ms-date' }) : null);
}

/** "Sugestão dos engenheiros: X + Y, o mais barato que leva a carga." with a one-tap "Usar a sugestão". */
function suggestionNote(sug, sugName, use) {
  return h('div', { class: 'aviso ms-note sugestao' }, icon('info', 14, 'ms-note-ic'),
    h('span', null, h('b', null, 'Sugestão dos engenheiros: '), `${sugName}${SUG_REASON[sug.reason] ? `, ${SUG_REASON[sug.reason]}` : sug.reason ? ` (${sug.reason})` : ''}.`),
    button('Usar a sugestão', use, { small: true, kind: 'ghost' }));
}

const SUG_REASON = { 'Plano do programa': 'o hardware do plano do programa', 'Mais barato que leva a carga': 'o mais barato que leva a carga' };

/**
 * "Escolha o veículo": the accepted mission's type, destination and crew stay as they are; the player picks the
 * rocket and the craft. The engineers' suggestion is shown and highlighted, never preselected.
 */
function hardwareStep(store, m, rerender) {
  if (!ui.hw || ui.hw.missionId !== m.id) ui.hw = { missionId: m.id, vehicleId: null, spacecraftId: null, secondarySpacecraftId: null };
  const pick = ui.hw;
  const idx = store.data?.index || {};
  const base = newDraft();
  const d = {
    ...base, ...m, missionId: m.id, crew: m.crew || base.crew, config: m.config || base.config,
    vehicleId: pick.vehicleId, spacecraftId: pick.spacecraftId, secondarySpacecraftId: pick.secondarySpacecraftId,
  };
  const opts = draftOptions(store, d);
  const sug = m.suggestion || null;
  const set = (patch) => { Object.assign(pick, patch); rerender(); };
  // the crew of an accepted mission is set elsewhere (programs lock it): only hardware problems block here
  const blockers = step2Blockers(store, d, opts).filter((b) => b !== 'Escolha o comandante.');
  const sugName = sug ? [idx.vehicles?.[sug.vehicleId]?.name || sug.vehicleId, sug.spacecraftId ? (idx.spacecraft?.[sug.spacecraftId]?.name || sug.spacecraftId) : null].filter(Boolean).join(' + ') : null;
  const dest = idx.destinations?.[m.destination]?.name || m.destination || '—';
  const confirm = () => {
    const r = store.dispatch(hardwareUpdate(m.id, pick));
    if (!r?.ok) { toast(r?.error || 'Não foi possível usar este veículo.', 'bad', 5000); return; }
    toast('Veículo escolhido. Agora agende o lançamento.', 'good');
    store.vibrate(20);
    ui.hw = null;
    store.ui?.navigate?.('missoes', 'lista');
    setTimeout(() => openMission(store, m.id), 60);
  };
  return h('div', { class: 'hw-step' },
    h('section', { class: 'card hw-head' },
      h('div', { class: 'card-head' }, h('span', { class: 'card-icon', 'aria-hidden': 'true' }, typeDot(m.type)),
        h('div', { class: 'card-titles' }, h('div', { class: 'card-title' }, m.name || 'Missão'), h('div', { class: 'card-sub' }, `${typeSubLabel(m.type, m.sub) || m.type || ''} · ${dest}`))),
      h('p', { class: 'small muted hw-lead' }, m.source === 'calendar' ? 'Tipo, destino e tripulação vêm do programa. O foguete e a nave são escolha sua.' : m.mandateId ? 'Mandato do investidor: tipo e destino são dele. O foguete e a nave são escolha sua.' : 'Missão aceita. Falta escolher o foguete e a nave.'),
      hwHolderLine(store, m)),
    sug && sugName ? suggestionNote(sug, sugName, () => set({ vehicleId: sug.vehicleId || null, spacecraftId: sug.spacecraftId || null, secondarySpacecraftId: sug.secondarySpacecraftId || null })) : null,
    hardwareSections(store, d, opts, set, sug),
    pick.vehicleId && opts.estimate ? h('div', null, sectionTitle('Chance estimada'), chanceGauge(opts.estimate, { invalid: opts.valid === false })) : null,
    pick.vehicleId && opts.cost != null ? h('div', { class: 'kv' }, kv('Custo com esta escolha', fmtMoney(opts.cost))) : null,
    blockers.length ? h('div', { class: 'ms-notes' }, blockers.map((b) => note(b, 'bad', 'fechar'))) : null,
    h('div', { class: 'builder-nav' },
      button('Voltar', () => { ui.hw = null; store.ui?.navigate?.('missoes', 'lista'); }, { icon: 'voltar', big: true }),
      button('Confirmar foguete e nave', confirm, { kind: 'primary', big: true, disabled: !pick.vehicleId || blockers.length > 0 })));
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
  const ag = agendaOf(store);
  if (ag) out.append(agendaStrip(store, ag));
  if (related.length) {
    out.append(sectionTitle('Aguardando você'), h('div', { class: 'decision-list' }, related.map((d) => decisionRow(store, d))));
  }
  const mds = mandatesSection(store);
  if (mds) out.append(mds);
  if (!missions.length) {
    out.append(h('div', { class: 'ms-empty' }, emptyState('Nenhuma missão no programa ainda. Briefings do calendário e contratos chegam com o tempo — ou monte a sua.', 'missoes')),
      button('Montar uma missão', () => go('nova'), { kind: 'primary', icon: 'mais', big: true, cls: 'ms-wide' }));
    return out;
  }
  for (const [label, statuses] of GROUPS) {
    const list = missions.filter((m) => statuses.includes(m.status))
      .sort((a, b) => (a.launchTurn ?? a.createdTurn ?? 0) - (b.launchTurn ?? b.createdTurn ?? 0));
    if (label === 'Concluídas' || label === 'Canceladas') list.reverse();
    if (!list.length) continue;
    out.append(sectionTitle(label, h('span', { class: 'ms-count' }, String(list.length))), h('div', { class: 'mission-list' }, list.slice(0, label === 'Canceladas' ? 5 : 30).map((m) => missionCard(store, m))));
  }
  out.append(button('Montar nova missão', () => go('nova'), { icon: 'mais', big: true, cls: 'ms-wide' }));
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
  // Status lives in the chips row, not at the right of the head: a ~105px chip there squeezed the title and
  // cut names at 320px. Planning/scheduled are omitted because the section title already says it.
  const statusChip = res ? chip(OUTCOME_TEXT[res.outcome] || res.outcome, outcomeKind)
    : ['planning', 'scheduled'].includes(m.status) ? null : chip(STATUS_LABELS[m.status] || m.status, statusKind(m, provisional));
  const chips = h('div', { class: 'chips' },
    statusChip,
    ascent ? chip(ascent.outcome === 'total' ? 'subida ok' : `subida: ${(OUTCOME_TEXT[ascent.outcome] || ascent.outcome).toLowerCase()}`, outcomeKindOf(ascent.outcome)) : null,
    m.launchTurn != null && !m.result ? chip(`${fmtMonth(m.launchTurn, st.startYear)} · ${fmtIn(m.launchTurn, st.turn)}`, '', { class: 'ms-date' }) : null,
    m.estimate && !m.result ? chip(`Chance ${fmtBand(m.estimate.low, m.estimate.high)}`, '') : null,
    !m.result && crewRiskOf(m.estimate) != null ? chip(crewRiskText(crewRiskOf(m.estimate)), crewRiskOf(m.estimate) >= CREW_RISK_HIGH ? 'bad' : '', { class: 'ms-crewrisk-chip' }) : null,
    m.holder ? holderChip(m.holder) : null,
    m.deadline && !m.result ? chip(`prazo ${m.deadline}`, m.late ? 'bad' : 'warn', { class: 'ms-date ms-deadline' }) : null,
    m.source === 'calendar' ? chip('calendário real', 'muted') : m.source === 'contract' ? chip('contrato', 'muted') : m.source === 'cert' ? chip('certificação', 'muted')
      : m.source === 'test' ? chip(m.testFlight?.need ? `voo de teste ${Math.min(m.testFlight.flights + 1, m.testFlight.need)}/${m.testFlight.need}` : 'voo de teste', 'info') : null,
    m.isDesign && m.source !== 'test' ? chip('projeto próprio', 'muted') : null,
    needsHardware(m) ? chip('falta o veículo', 'warn', { class: 'falta-veiculo' }) : null,
    m.paid === false && m.status === 'planning' ? chip('não paga', 'muted') : null,
    m.stranded && m.status === 'planning' ? chip('sem data antes do fim', 'bad') : null,
    Number.isFinite(m.readyTurn) && m.readyTurn > st.turn && !m.result ? chip(`hardware pronto em ${fmtMonth(m.readyTurn, st.startYear)}`, 'muted') : null);
  return card({
    cls: `mission-card st-${m.status}${m.paid === false && m.status === 'planning' ? ' needs-pay' : ''}${needsHardware(m) ? ' needs-hw' : ''}`,
    onClick: () => (needsHardware(m) ? store.ui?.navigate?.('missoes', `m/${m.id}`) : openMission(store, m.id)), icon: typeDot(m.type),
    title: m.name || 'Missão',
    subtitle: h('span', null, `${typeSubLabel(m.type, m.sub) || m.type || ''} · ${dest} · `, h('span', { class: 'ms-veh' }, veh)),
  },
  chips.childElementCount ? chips : null,
  m.transit && m.status === 'transit' ? bar(((st.turn - m.transit.departTurn) / Math.max(1, m.transit.arriveTurn - m.transit.departTurn)) * 100, { key: `mt.${m.id}`, label: `Chegada ${fmtIn(m.transit.arriveTurn, st.turn)}` }) : null);
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
    if (needsHardware(m)) {
      actions.append(note('Escolha o foguete e a nave antes de agendar.', 'warn'),
        button('Escolher o veículo', () => { close({ fromHistory: true }); store.ui?.navigate?.('missoes', `m/${m.id}`); }, { kind: 'primary', icon: 'missoes', big: true }));
    } else if (m.status === 'planning') {
      const opts = launchTurnOptions(store, m, null);
      const hint = windowHint(store, m, null);
      actions.append(...[h('div', { class: 'ms-eyebrow' }, 'Agendar lançamento'),
        hint ? h('div', { class: 'tiny muted' }, hint) : null,
        opts.length ? h('div', { class: 'chips wrap ms-pills' }, opts.map((o) => chip(o.label, '', {
          onclick: () => {
            const r = store.dispatch({ type: 'mission/schedule', missionId: m.id, launchTurn: o.turn });
            if (r?.ok) { toast(`Agendada para ${fmtDate(o.turn, st.startYear)}.`, 'good'); close(); } else toast(scheduleErrorText(r), 'bad', 5000);
          },
        }))) : note(noSlotText(store, m, null), 'warn'),
        !lockedVehicle(m) ? button('Trocar o veículo', () => {
          close({ fromHistory: true });
          ui.hw = { missionId: m.id, vehicleId: m.vehicleId, spacecraftId: m.spacecraftId || null, secondarySpacecraftId: m.secondarySpacecraftId || null };
          store.ui?.navigate?.('missoes', `m/${m.id}/veiculo`);
        }, { kind: 'ghost', small: true, icon: 'transferir', iconSize: 16 }) : null].filter(Boolean));
    }
    if (['planning', 'scheduled'].includes(m.status)) {
      actions.append(button('Cancelar missão', async () => {
        if (!(await confirmDialog(`Cancelar "${m.name}"? Parte do dinheiro gasto não volta, e a imprensa vai notar.`, { okLabel: 'Cancelar missão', danger: true, cancelLabel: 'Manter' }))) return;
        const r = store.dispatch({ type: 'mission/cancel', missionId: m.id });
        if (r?.ok) { toast('Missão cancelada.', 'warn'); close(); } else toast(r?.error || 'Não foi possível cancelar.', 'bad');
      }, { kind: 'danger', icon: 'fechar', big: true }));
    }
    const r = m.result;
    const calDef = m.calendarId ? (store.data?.calendar?.missions || []).find((x) => x.id === m.calendarId) : null;
    const calText = calDef?.partnersText || null;
    return h('div', { class: 'mission-sheet' },
      h('div', { class: 'ms-sheet-hero' }, typeDot(m.type),
        h('div', { class: 'chips' },
          chip(STATUS_LABELS[m.status] || m.status, statusKind(m, isProvisionalResult(m))), chip(typeSubLabel(m.type, m.sub) || m.type || '—', 'muted'),
          m.launchTurn != null ? chip(fmtDate(m.launchTurn, st.startYear), '', { class: 'ms-date' }) : null,
          m.cost != null ? chip(fmtMoney(m.cost), '', { class: 'ms-date' }) : null)),
      m.source === 'calendar' ? h('p', { class: 'tiny muted' }, 'Programa do calendário real: destino, tipo e tripulação já estão definidos.') : null,
      m.source === 'cert' ? h('p', { class: 'tiny muted' }, 'Voo de demonstração sem tripulação: se chegar à órbita, o foguete fica certificado para levar gente.') : null,
      m.source === 'test' ? h('p', { class: 'tiny muted' }, m.testCraftId
        ? 'Voo de teste da sua nave do Estaleiro: escolha o foguete que vai levá-la. A nave e o destino não mudam; um voo bem-sucedido conta para liberá-la.'
        : `Voo de teste com lastro do seu projeto${m.testFlight?.need ? ` (${m.testFlight.flights} de ${m.testFlight.need} aprovados)` : ''}. Sucesso conta para liberar o foguete; o veículo não pode ser trocado.`) : null,
      m.holder ? mandateBlock(store, m) : null,
      calText ? h('p', { class: 'tiny muted' }, calText) : null,
      h('div', { class: 'kv' },
        kv('Destino', dest?.name || m.destination || '—'),
        ...missionCargoRows(store, m),
        Number.isFinite(m.readyTurn) && m.readyTurn > st.turn ? kv('Hardware pronto', `${fmtDate(m.readyTurn, st.startYear)} (${fmtIn(m.readyTurn, st.turn)})`) : null,
        kv('Veículo', vehicleLabel(m, idx) || '—'),
        kv('Espaçonave', sc?.name || m.spacecraftId || (m.clientPayload
          ? (m.source === 'test' || m.source === 'cert' ? `Lastro de ${String(m.config?.payloadT ?? '?').replace('.', ',')} t` : 'Carga do cliente') : '—')),
        m.secondarySpacecraftId ? kv('Módulo de apoio', idx.spacecraft?.[m.secondarySpacecraftId]?.name || m.secondarySpacecraftId) : null,
        kv('Estratégia', STRATEGY_LABELS[m.config?.strategy] || '—'),
        kv('Margem de combustível', m.config?.fuelMargin != null ? fmtPct(m.config.fuelMargin) : '—', m.config?.fuelMargin != null)),
      m.estimate && !r ? chanceGauge(m.estimate) : null,
      uniq.length ? h('div', null, sectionTitle('Equipe'), h('div', { class: 'crew-strip' }, uniq.map((id) => crewMini(store, id)))) : null,
      r ? resultReport(store, m) : null,
      m.transit?.events?.length ? h('div', null, sectionTitle('Diário de bordo'), h('ul', { class: 'log-list ms-log' }, m.transit.events.map((e) => logLine(e, idx, st, m.name)).filter(Boolean).map((t) => h('li', null, t)))) : null,
      actions.childElementCount ? actions : null);
  }, { title: m.name || 'Missão', cls: 'ms-sheet' });
}

/** Cargo/target rows of a stored mission (payload of §1.4). */
function missionCargoRows(store, m) {
  const p = m.payload;
  if (!p || typeof p !== 'object') return [];
  const md = modulesData(store) || {};
  const out = [];
  const mod = p.moduleId ? [...(md.station || []), ...(md.base || [])].find((r) => r.id === p.moduleId) : null;
  const veh = p.vehicleTypeId ? (md.vehicles || []).find((r) => r.id === p.vehicleTypeId) : null;
  const q = Math.max(1, p.qty || 1);
  if (p.kind && PAYLOAD_LABELS[p.kind]) {
    out.push(kv('Carga', mod ? `${PAYLOAD_LABELS[p.kind]}: ${mod.label || mod.id}` : veh ? `${q} × ${veh.label || veh.id}`
      : (p.kind === 'supply' || p.kind === 'propellant') ? `${PAYLOAD_LABELS[p.kind]} (${q} t)` : PAYLOAD_LABELS[p.kind]));
  }
  const a = p.targetAssetId ? assetViews(store).find((x) => x.id === p.targetAssetId) : null;
  if (a || p.newAsset) out.push(kv('Destino da carga', a ? a.name : `${p.newAssetName || 'Novo'} (nova)`));
  return out;
}

/** Investor block of the mission sheet: holder, stake, deadline, reward and what a miss costs. */
function mandateBlock(store, m) {
  const st = store.state;
  const md = m.mandate || {};
  const hd = m.holder;
  const program = md.kind === 'program' || (!!m.calendarId && !m.mandateId);
  return h('div', { class: ['ms-mandate-block', m.late && 'late'] },
    h('div', { class: 'ms-mandate-head' }, raw(holderEmblemSVG(hd, 32), 'ms-holder-em'),
      h('div', { class: 'ms-mandate-titles' },
        h('div', { class: 'ms-eyebrow' }, program ? 'Programa do acionista' : 'Mandato do investidor'),
        h('div', { class: 'ms-mandate-name' }, holderLabel(hd)))),
    h('div', { class: 'kv' },
      m.deadline ? kv('Prazo', `${m.deadline}${Number.isFinite(m.deadlineTurn) ? ` (${m.deadlineTurn >= st.turn ? fmtIn(m.deadlineTurn, st.turn) : 'vencido'})` : ''}`) : null,
      Number.isFinite(md.rewardM) && md.rewardM > 0 ? kv('Na entrega', `+${fmtMoney(md.rewardM)}`, true) : null,
      Number.isFinite(hd?.mood) ? kv('Humor do investidor', `${Math.round(hd.mood)}/100`, true) : null),
    h('p', { class: 'tiny muted' }, `Se perder o prazo: ${penaltyText(md.penalty, !!md.binding)}`),
    m.late ? note('O lançamento marcado passa do prazo do mandato.', 'bad', 'alerta') : null);
}

function resultReport(store, m) {
  const r = m.result;
  const kind = outcomeKindOf(r.outcome);
  const provisional = isProvisionalResult(m);
  const causes = (r.causes || []).slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const CK = { part: 'Peça', decision: 'Decisão', luck: 'Sorte', environment: 'Ambiente', crew: 'Equipe' };
  return h('div', { class: 'report' },
    sectionTitle('Relatório'),
    h('div', { class: `outcome-banner ob-${kind}` }, provisional ? `Subida: ${OUTCOME_TEXT[r.outcome] || r.outcome}` : OUTCOME_TEXT[r.outcome] || r.outcome),
    provisional ? h('p', { class: 'small muted' }, m.transit?.arriveTurn != null
      ? `A nave segue viagem: o resultado da missão sai na chegada, ${fmtIn(m.transit.arriveTurn, store.state.turn)}.`
      : 'A nave segue viagem: o resultado da missão sai na chegada.') : null,
    causes.length ? h('ol', { class: 'causes' }, causes.map((c) => h('li', null,
      h('span', { class: 'cause-kind' }, CK[c.kind] || c.kind), h('strong', null, c.label || ''), c.detail ? h('div', { class: 'muted small' }, c.detail) : null))) : null,
    h('div', { class: 'chips' },
      r.prestige ? chip(`+${Math.round(r.prestige)} prestígio`, 'good') : null,
      r.science ? chip(`+${Math.round(r.science)} ciência`, 'info') : null),
    (r.headlines || []).length ? h('div', { class: 'headlines' }, r.headlines.map((t) => h('blockquote', null, t))) : null);
}

/** Key/value row; num = numeric value set in mono (DESIGN §4.18). */
function kv(k, v, num = false) {
  return h('div', { class: 'kv-row' }, h('span', { class: 'muted' }, k), h('span', { class: num ? 'num' : null }, v));
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

/** One "Diário de bordo" line in pt-BR: event title from data (never the raw internal key), with the month. */
function logLine(e, idx, st, name) {
  const title = (id) => {
    const t = idx.events?.[id]?.title;
    return t ? t.replace(/\{mission\}/g, name || 'a missão').replace(/\s*\{[^}]*\}\s*/g, ' ').trim() : null;
  };
  if (typeof e === 'string') return /^[a-z0-9]+(_[a-z0-9]+)+$/.test(e) ? title(e) : e;
  const text = e?.text || e?.title || title(e?.eventId);
  if (!text) return null;
  return Number.isFinite(e.turn) ? `${fmtMonth(e.turn, st.startYear)} · ${text}` : text;
}

/** Crew-loss risk at or above this reads red on the mission list (below it the chip stays neutral). */
const CREW_RISK_HIGH = 0.05;

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
    icon('alerta', 14, 'ms-note-ic'), h('b', null, crewRiskText(x)),
    h('span', { class: 'muted' }, ' · chance de perder alguém a bordo'));
}

function chanceGauge(est, { invalid = false } = {}) {
  if (!est) return null;
  if (invalid) {
    return h('div', { class: 'gauge g-muted' },
      h('div', { class: 'gauge-label' }, 'Chance estimada'),
      h('div', { class: 'gauge-value muted' }, '—'),
      h('div', { class: 'muted tiny' }, 'Corrija os itens marcados em vermelho para ver a chance.'));
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
  // item 9 (docs/EXPANSION.md §7.6): the rocket and the craft are the player's call, nothing is preselected.
  // The best free flight director still is (crew, not hardware: an empty control room is rarely wanted) (an empty control room is rarely what the player wants)
  if (ui.step >= 2 && !d.crew?.flightDirector && !ui.noFd) {
    const raw = opts.raw?.crew?.flightDirector;
    const fd = (Array.isArray(raw) ? raw : []).filter((p) => !p.busy).sort((a, b) => (b.skill || 0) - (a.skill || 0))[0];
    if (fd) { ui.draft = d = { ...d, crew: { ...(d.crew || {}), flightDirector: fd.id } }; opts = draftOptions(store, d); }
  }
  // Missões v2: subtype, target and cargo follow the type/destination (defaults derived, never a hidden choice)
  let v2 = v2Context(store, d, opts);
  const synced = syncDraft(d, v2);
  if (synced !== d) { ui.draft = d = synced; opts = draftOptions(store, d); v2 = v2Context(store, d, opts); }
  const set = (patch) => { ui.draft = { ...ui.draft, ...patch }; rerender(); };
  // a new step is a new screen: start it at the top (same route, so the shell keeps the scroll otherwise)
  const blockers = step2Blockers(store, d, opts);
  const b1 = v2.blockers;
  const goStep = (n) => { ui.step = n; rerender(); store.ui?.scrollTop?.(); };
  const steps = ['Alvo e tipo', 'Veículo e equipe', 'Resumo'];

  const stepper = h('ol', { class: 'stepper' }, steps.map((s, i) => h('li', {
    class: [ui.step === i + 1 && 'active', ui.step > i + 1 && 'done'],
    onclick: () => { if (i + 1 < ui.step || canGo(i + 1, d, blockers, b1)) goStep(i + 1); },
    'aria-current': ui.step === i + 1 ? 'step' : null,
  }, ui.step > i + 1 ? raw(iconSVG('check', 14), 'step-n') : h('span', { class: 'step-n' }, String(i + 1)), h('span', { class: 'step-t' }, s))));

  const body = h('div', { class: 'builder-body' });
  if (ui.step === 1) body.append(step1(store, d, opts, set, v2));
  else if (ui.step === 2) body.append(step2(store, d, opts, set));
  else body.append(step3(store, d, opts, rerender));
  // what still blocks "Próximo" on step 2, said right above the button (not only on step 3)
  if (ui.step === 2 && blockers.length) body.append(h('div', { class: 'ms-notes' }, blockers.map((b) => note(b, 'bad', 'fechar'))));
  // a prefilled draft can land on step 2 with step 1 still open (target, module): say so, with the way back
  if (ui.step === 2 && b1.length) {
    body.append(h('div', { class: 'ms-notes' }, b1.map((b) => note(`Passo 1: ${b}`, 'bad', 'fechar')),
      button('Voltar ao passo 1', () => goStep(1), { small: true, icon: 'voltar' })));
  }

  const nav = h('div', { class: ['builder-nav', ui.step === 3 && 'is-last'] },
    ui.step > 1 ? button('Voltar', () => goStep(ui.step - 1), { icon: 'voltar', big: true }) : button('Limpar', () => { ui.draft = newDraft(); ui.noFd = false; ui.noCraft = false; ui.subAuto = true; ui.destOpen = false; goStep(1); }, { big: true }),
    ui.step < 3 ? button('Próximo', () => goStep(ui.step + 1), { kind: 'primary', big: true, disabled: !canGo(ui.step + 1, d, blockers, b1) }) : null);

  const ag = agendaOf(store);
  return h('div', { class: 'builder' },
    ag && !d.contractId ? agendaStrip(store, ag, { compact: true }) : null,
    d.contractId ? h('div', { class: 'contract-banner' }, icon('transferir', 16, 'ms-note-ic'), h('span', null, 'Missão para contrato'), button('Remover', () => set({ contractId: null, source: 'custom' }), { kind: 'ghost', small: true })) : null,
    stepper, body, nav);
}

function canGo(step, d, blockers = [], step1Blockers = []) {
  if (step >= 2 && !(d.type && d.destination)) return false;
  if (step >= 2 && step1Blockers.length) return false;
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

/** Cargo of the draft: { massT, module, vehicle } (module/vehicle rows from modules.json or the sim). */
function cargoOf(store, d, opts) {
  const kind = payloadKindOf(d);
  if (!kind || kind === 'client') return { massT: null, module: null, vehicle: null };
  const p = d.payload || {};
  const dest = store.data?.index?.destinations?.[d.destination] || null;
  const rows = cargoRows(store.state, store.data, d, kind === 'base_vehicle' ? (opts.raw?.surfaceVehicles || opts.raw?.baseVehicles || null) : (opts.raw?.modules || null), dest);
  const module = kind === 'station_module' || kind === 'base_module' ? rows.find((r) => r.id === p.moduleId) || null : null;
  const vehicle = kind === 'base_vehicle' ? rows.find((r) => r.id === p.vehicleTypeId) || null : null;
  const simMass = Number(opts.raw?.payloadMassT ?? (opts.raw?.carried ? opts.raw?.cargoT : NaN));
  const massT = Number.isFinite(simMass) && simMass > 0 ? simMass : payloadMassT(p, { module, vehicle });
  return { massT, module, vehicle };
}

/** The carrier holds the cargo (§1.4): {cargoT, massT, over} or null when no carrier check applies. Pure. */
export function carrierCheck(sc, massT) {
  if (!sc || !(Number(massT) > 0)) return null;
  const known = Number.isFinite(Number(sc.cargoT)) || ['cargo', 'capsule', 'lander'].includes(sc.kind);
  if (!known) return null;
  const cargoT = carrierCargoT(sc);
  return { cargoT, massT: Number(massT), over: Number(massT) > cargoT + 1e-9 };
}

/** "Carga útil 4 t de 8,5 t" under the carrier choice (§11 step 2). */
function carrierLine(store, d, opts, set = null) {
  const { massT } = cargoOf(store, d, opts);
  if (!(Number(massT) > 0)) return null;
  const sc = { ...(store.data?.index?.spacecraft?.[d.spacecraftId] || {}), ...(opts.spacecraft.find((x) => x.id === d.spacecraftId) || {}) };
  const cap = Number(opts.raw?.carrierCapT);
  const chk = d.spacecraftId ? carrierCheck(Number.isFinite(cap) && cap > 0 ? { ...sc, cargoT: cap } : sc, massT) : null;
  if (!chk) return carrierFitHint(store, d, opts, massT, set) || h('div', { class: 'tiny muted ms-carrier-hint' }, `Carga a levar: ${n1(massT)} t. Escolha uma nave que comporte.`);
  return h('div', { class: ['ms-carrier', chk.over && 'over'] },
    h('div', { class: 'ms-carrier-top' }, h('span', { class: 'ms-eyebrow' }, 'Carga útil'), h('span', { class: 'ms-carrier-val' }, `${n1(chk.massT)} t de ${n1(chk.cargoT)} t`)),
    bar(Math.min(100, (chk.massT / Math.max(0.1, chk.cargoT)) * 100), { kind: chk.over ? 'bad' : 'good', key: `cg.${d.spacecraftId}` }));
}

/**
 * A craft the sim turned down only because the cargo is heavier than its hold (pure: exported for tests).
 * Returns its hold in t, or null when it is usable or blocked by something else.
 */
export function cargoOnlyBlock(s, massT, table = null) {
  if (!s || s.ok || !(Number(massT) > 0)) return null;
  const errs = Array.isArray(s.reasons) ? s.reasons : Array.isArray(s.errors) ? s.errors : null;
  if (errs && errs.length > 1) return null;
  if (s.reason && !/t de carga/i.test(String(s.reason))) return null;
  const chk = carrierCheck({ ...(table?.[s.id] || {}), ...s }, massT);
  return chk?.over ? chk.cargoT : null;
}

/**
 * No usable craft holds the cargo, but some would with less of it: say why and offer the fix
 * ("Levar 4 t" for supply/propellant; for modules/vehicles, name the biggest hold).
 */
function carrierFitHint(store, d, opts, massT, set) {
  if (!(Number(massT) > 0)) return null;
  const table = store.data?.index?.spacecraft || null;
  if (opts.spacecraft.some((s) => s.ok && !flightBlock(store, s.id, d.vehicleId))) return null;
  let best = null;
  for (const s of opts.spacecraft) {
    const cap = cargoOnlyBlock(s, massT, table);
    if (cap != null && cap > 0 && (!best || cap > best.cap)) best = { s, cap };
  }
  if (!best) return null;
  const kind = payloadKindOf(d);
  const who = best.s.name || best.s.id;
  const fitQty = Math.floor(best.cap + 1e-9);
  const adjustable = (kind === 'supply' || kind === 'propellant') && fitQty >= 1 && typeof set === 'function';
  return h('div', { class: 'ms-carrier-fit' },
    note(`Carga de ${n1(massT)} t: nenhuma nave de carga disponível leva tanto. Maior porão: ${who}, ${n1(best.cap)} t.${adjustable ? ' Reduza a carga ou divida em mais voos.' : ' Escolha um módulo ou veículo mais leve.'}`, 'warn'),
    adjustable ? chip(`Levar ${fitQty} t (cabe: ${who})`, '', { onclick: () => set({ payload: { ...(d.payload || {}), qty: fitQty } }) }) : null);
}

/** Step-2 problems that make step 3 pointless: no usable vehicle, craft that can't ride it, crewed flight without commander. */
function step2Blockers(store, d, opts) {
  const idx = store.data?.index || {};
  const out = [];
  if (!d.type || !d.destination) return out;
  const cg = cargoOf(store, d, opts);
  const carrier = d.spacecraftId ? carrierCheck({ ...(idx.spacecraft?.[d.spacecraftId] || {}), ...(opts.spacecraft.find((x) => x.id === d.spacecraftId) || {}) }, cg.massT) : null;
  if (carrier?.over) out.push(`A ${idx.spacecraft?.[d.spacecraftId]?.name || 'nave'} leva no máximo ${n1(carrier.cargoT)} t de carga.`);
  const v = opts.vehicles.find((x) => x.id === d.vehicleId);
  if (d.vehicleId && v && !v.ok) out.push(`${v.name || v.id}: ${v.reason || 'indisponível para esta missão'}`);
  const sc = idx.spacecraft?.[d.spacecraftId];
  if (sc && d.vehicleId && flightBlock(store, sc.id, d.vehicleId)) out.push(`${sc.name} não voa no ${idx.vehicles?.[d.vehicleId]?.name || d.vehicleId}.`);
  const crewed = d.type === 'crewed' || (sc?.crew > 0);
  if (d.vehicleId && crewed && !d.crew?.commander) out.push('Escolha o comandante.');
  return out;
}

function step1(store, d, opts, set, v2) {
  const st = store.state;
  const pickType = (t) => {
    ui.subAuto = true; ui.lockPeek = null;
    const dest = v2.destTable[d.destination];
    // a destination that cannot take the new type is dropped (the list re-enables what fits)
    const keepDest = !dest || !Array.isArray(dest.missionTypes) || !dest.missionTypes.length || dest.missionTypes.map(missionTypeOf).includes(t);
    set({ type: t, sub: null, payload: null, vehicleId: null, spacecraftId: null, secondarySpacecraftId: null, ...(keepDest ? {} : { destination: null }) });
  };
  const dests = sortByArrival(opts.destinations, (x) => cardLaunchTurn(store, x), st.endTurn).map((x) => destFit(x, d, v2));
  const sel = d.destination ? dests.find((x) => x.id === d.destination) : null;
  const collapsed = !!sel && !ui.destOpen;
  // a type the player has not researched yet (sim types[].locked, gating.missionGate): lock badge, still pickable
  // so the player can see what it needs; the note under the grid links to the research node
  const typeLock = (t) => typeLockOf(opts.raw?.types, t);
  const selLock = d.type ? typeLock(missionTypeOf(d.type)) : null;
  return h('div', null,
    sectionTitle('Tipo de missão'),
    // a new agency (1950, no technology) sees six padlocks: say why and where to start, before it picks anything
    !d.type && TYPES.every((t) => typeLock(t)) ? lockNote(store, `Nenhum tipo de missão liberado ainda. Comece pela Pesquisa: ${typeLock(TYPES[0]).reason.replace(/\.$/, '')}.`, typeLock(TYPES[0])) : null,
    h('div', { class: 'type-grid' }, TYPES.map((t) => {
      const lk = typeLock(t);
      return h('button', {
        class: ['type-btn', missionTypeOf(d.type) === t && 'selected', lk && 'locked'], type: 'button', 'aria-pressed': missionTypeOf(d.type) === t ? 'true' : 'false',
        'aria-label': lk ? `${TYPE_LABELS[t]} (bloqueado: ${lk.reason})` : null, title: lk ? lk.reason : null,
        onclick: () => pickType(t),
      }, lk ? raw(iconSVG('cadeado', 12), 'type-lock') : null,
      h('span', { class: 'type-icon ms-dot', 'aria-hidden': 'true' }, TYPE_ICONS[t]), h('span', { class: 'type-name' }, TYPE_LABELS[t]), h('span', { class: 'type-hint' }, TYPE_HINT[t]));
    })),
    selLock ? lockNote(store, `${TYPE_LABELS[missionTypeOf(d.type)]}: ${selLock.reason.replace(/\.$/, '')}.`, selLock) : null,
    v2.subs.length ? subPicker(store, d, v2, set) : null,
    sectionTitle('Alvo', collapsed ? h('button', { class: 'btn-link', type: 'button', onclick: () => { ui.destOpen = true; set({}); } }, 'Trocar alvo') : null),
    !dests.length ? emptyState('O catálogo de destinos ainda não carregou.', 'mapa')
      : collapsed ? h('div', { class: 'dest-list' }, destCard(store, sel, d, set))
      : h('div', { class: 'dest-list' }, dests.map((x) => destCard(store, x, d, set))),
    d.type && d.destination && needsTarget(d) ? targetBlock(store, d, v2, set) : null,
    d.type && d.destination ? cargoBlock(store, d, v2, set) : null,
    d.type && d.destination && v2.blockers.length ? h('div', { class: 'ms-notes' }, v2.blockers.map((b) => note(b, 'warn', 'info'))) : null);
}

/** Lock of a mission type from the sim's draftOptions.types ([{id, locked:{reason,nodeId}|null}]), or null. Pure. */
export function typeLockOf(types, t) {
  const row = Array.isArray(types) ? types.find((x) => x && x.id === t) : null;
  return row ? simLock(row) : null;
}

/** Destination entry with the subtype's narrowing applied (§1.2 `dest.kinds`/`dest.ids`). */
function destFit(x, d, v2) {
  const r = v2.subRow;
  if (!x.ok || !r?.dest) return x;
  const kinds = r.dest.kinds, ids = r.dest.ids;
  const bad = (Array.isArray(kinds) && kinds.length && !kinds.includes(x.kind)) || (Array.isArray(ids) && ids.length && !ids.includes(x.id));
  return bad ? { ...x, ok: false, reason: `${r.label} não serve para ${x.name || x.id}.` } : x;
}

const SUB_PICK = { satellite: 'Escolha o tipo de satélite.', probe: 'Escolha o tipo de sonda.', rover: 'Escolha o modelo de rover.', crewed: 'Escolha o objetivo da missão.', cargo: 'Escolha o tipo de carga.' };
const SUB_TITLE = { satellite: 'Tipo de satélite', probe: 'Tipo de sonda', rover: 'Modelo de rover', crewed: 'Objetivo', cargo: 'Tipo de carga' };

/** Subtype chips (§11): open ones selectable, locked ones with a lock and the research link. */
function subPicker(store, d, v2, set) {
  const visible = v2.subs.filter((s) => !s.hidden);
  const hidden = v2.subs.length - visible.length;
  const pick = (s) => {
    if (s.lock) { ui.lockPeek = ui.lockPeek === s.id ? null : s.id; set({}); return; }
    ui.subAuto = false; ui.lockPeek = null;
    const patch = { sub: s.id, vehicleId: null, spacecraftId: null };
    const kind = payloadKindOf({ type: d.type, sub: s.id });
    const keepTarget = targetKindOf({ type: d.type, sub: s.id }, v2.dest) === targetKindOf(d, v2.dest) ? d.payload?.targetAssetId || null : null;
    patch.payload = kind || needsTarget({ type: d.type, sub: s.id }) ? { ...emptyPayload(kind), targetAssetId: keepTarget, qty: kind === 'supply' || kind === 'propellant' ? Math.max(1, d.payload?.qty || 2) : 1 } : null;
    if (v2.dest && s.fit === false) { patch.destination = null; ui.destOpen = true; }
    set(patch);
  };
  const peek = ui.lockPeek ? visible.find((s) => s.id === ui.lockPeek && s.lock) : null;
  return h('div', { class: 'field ms-subs' },
    h('span', { class: 'ms-eyebrow' }, SUB_TITLE[missionTypeOf(d.type)] || 'Subtipo'),
    h('div', { class: 'chips wrap ms-pills ms-sub-chips', role: 'group', 'aria-label': SUB_TITLE[missionTypeOf(d.type)] || 'Subtipo' }, visible.map((s) => chip(
      s.lock ? [icon('cadeado', 14, 'ms-chip-ic'), h('span', null, s.label)] : s.label,
      s.lock || s.fit === false ? 'muted' : '',
      {
        class: ['ms-sub', d.sub === s.id && !s.lock && 'active', s.lock && 'locked', !s.lock && s.fit === false && 'unfit'].filter(Boolean).join(' '),
        'aria-pressed': d.sub === s.id ? 'true' : 'false', title: s.lock ? s.lock.reason : s.why || null, onclick: () => pick(s),
      }))),
    peek ? lockNote(store, `${peek.label}: ${peek.lock.reason}.`, peek.lock) : null,
    d.sub && d.type === 'probe' && ui.subAuto && v2.dest ? h('div', { class: 'tiny muted' }, `Escolhido pelo alvo: ${v2.dest.name || v2.dest.id} pede ${(SUB_LABELS.probe[d.sub] || d.sub).toLowerCase()}.`) : null,
    hidden > 0 ? h('div', { class: 'tiny muted' }, `Mais ${hidden} chega${hidden === 1 ? '' : 'm'} com a pesquisa de eras futuras.`) : null);
}

/** "Pesquise {nó}" note with a link to the research node (#pesquisa/n/<id>). */
function lockNote(store, text, lock) {
  return h('div', { class: 'aviso ms-note ms-lock-note' }, icon('cadeado', 14, 'ms-note-ic'), h('span', null, text),
    lock?.nodeId ? button('Ver na Pesquisa', () => store.ui?.navigate?.('pesquisa', `n/${lock.nodeId}`), { small: true, kind: 'ghost', icon: 'pesquisa', iconSize: 14 }) : null);
}

/** Everything step 1 needs about subtype, target and cargo, plus what still blocks "Próximo". */
function v2Context(store, d, opts) {
  const st = store.state;
  const idx = store.data?.index || {};
  const destTable = idx.destinations || {};
  const dest = d.destination ? { ...(destTable[d.destination] || {}), ...(opts.destinations.find((x) => x.id === d.destination) || {}) } : null;
  const raw = opts.raw || {};
  const subs = subOptions(st, store.data, d, raw.subs || null, dest);
  const subRow = subs.find((s) => s.id === d.sub)?.row || null;
  const simTargets = raw.targets || (needsTarget(d) && d.destination ? store.tryQuery('infra/targets', null, { type: missionTypeOf(d.type), sub: d.sub, destination: d.destination, payloadKind: payloadKindOf(d) }) : null);
  const targets = needsTarget(d) && d.destination ? targetOptions(store, d, Array.isArray(simTargets) ? simTargets : null, dest) : [];
  const cargo = cargoRows(st, store.data, d, payloadKindOf(d) === 'base_vehicle' ? (raw.surfaceVehicles || raw.baseVehicles || null) : (raw.modules || null), dest);
  const p = d.payload || {};
  const target = p.targetAssetId ? targets.find((a) => a.id === p.targetAssetId) || null : null;
  const blockers = [];
  if (d.type && d.destination) {
    const t = missionTypeOf(d.type);
    const subSel = subs.find((s) => s.id === d.sub);
    if (t !== 'station' && subs.length && !d.sub) blockers.push(SUB_PICK[t] || 'Escolha o subtipo.');
    if (subSel?.lock) blockers.push(subSel.lock.nodeName ? `Pesquise ${subSel.lock.nodeName} para liberar ${subSel.label}.` : `${subSel.label}: ${subSel.lock.reason}.`);
    if (needsTarget(d)) {
      if (!p.targetAssetId && !p.newAsset) blockers.push('Escolha a estação ou base de destino.');
      else if (target && !target.ok) blockers.push(target.reason || `${target.name} não pode receber esta missão.`);
    }
    const kind = payloadKindOf(d);
    if (kind === 'station_module' || kind === 'base_module') {
      const m = cargo.find((r) => r.id === p.moduleId);
      if (!m) blockers.push('Escolha o módulo.');
      else if (m.lock) blockers.push(m.lock.nodeName ? `Pesquise ${m.lock.nodeName} para liberar o módulo ${m.label}.` : `${m.label}: ${m.lock.reason}.`);
    }
    if (kind === 'base_vehicle') {
      const v = cargo.find((r) => r.id === p.vehicleTypeId);
      if (!v) blockers.push('Escolha o veículo de superfície.');
      else if (v.lock) blockers.push(v.lock.nodeName ? `Pesquise ${v.lock.nodeName} para liberar o módulo ${v.label}.` : `${v.label}: ${v.lock.reason}.`);
    }
  }
  return { dest, destTable, subs, subRow, targets, target, cargo, blockers, md: modulesData(store), simTargetId: raw.targetAssetId || null };
}

/**
 * Derived draft fields (pure apart from ui.subAuto): default subtype, probe subtype from the target, station
 * found/expand from the chosen target, payload kind from type + sub, "Nova …" when nothing exists there yet.
 * Returns the same object when nothing changes.
 */
function syncDraft(d, v2) {
  if (!d.type) return d;
  let out = d;
  const patch = (p) => { out = { ...out, ...p }; };
  const t = missionTypeOf(d.type);
  if (t !== d.type) patch({ type: t, sub: d.sub || (d.type === 'lander' ? 'lander' : null) });
  if (t !== 'station') {
    const want = ui.subAuto !== false || !out.sub ? defaultSubFor(t, v2.dest, v2.subs) : out.sub;
    if (want && want !== out.sub && (ui.subAuto !== false || !out.sub)) patch({ sub: want });
  }
  const kind = payloadKindOf(out);
  if ((kind || needsTarget(out)) && (!out.payload || out.payload.kind !== kind)) patch({ payload: { ...emptyPayload(kind), ...(out.payload || {}), kind } });
  if (!kind && !needsTarget(out) && out.payload && out.payload.kind !== 'client') patch({ payload: null });
  if (t === 'station') {
    const sub = out.payload?.targetAssetId ? 'expand' : out.payload?.newAsset ? 'found' : null;
    if (sub !== out.sub) patch({ sub });
  }
  // the sim's own pick (own asset first, §1.5) is shown selected, never applied behind the player's back
  if (needsTarget(out) && out.payload && !out.payload.targetAssetId && !out.payload.newAsset && v2.simTargetId
      && v2.targets.some((a) => a.id === v2.simTargetId && a.ok)) patch({ payload: { ...out.payload, targetAssetId: v2.simTargetId } });
  if (needsTarget(out) && out.destination && out.payload && !out.payload.targetAssetId && !out.payload.newAsset
      && canFound(out, v2.dest) && !v2.targets.length && !ui.noFoundAuto) {
    patch({ payload: { ...out.payload, newAsset: true } });
    if (t === 'station') patch({ sub: 'found' });
  }
  return out;
}

const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const weeksText = (w) => (!Number.isFinite(w) ? 'sem consumo' : w <= 0 ? 'sem suprimentos' : w >= 104 ? `${Math.floor(w / 52)} anos` : `${w} semana${w === 1 ? '' : 's'}`);
const healthKind = (hp) => (hp >= 40 ? 'good' : hp >= 15 ? 'warn' : 'bad');

/** "Estação de destino" block (§11): Nova estação/base with a name field, or an existing asset at that destination. */
function targetBlock(store, d, v2, set) {
  const st = store.state;
  const p = d.payload || emptyPayload(payloadKindOf(d));
  const kind = targetKindOf(d, v2.dest);
  const found = canFound(d, v2.dest);
  const title = kind === 'satellite' ? 'Satélite a atender' : kind === 'base' ? 'Base de destino' : 'Estação de destino';
  const setP = (q) => set({ payload: { ...p, ...q } });
  const newName = defaultAssetName(store, kind, v2.dest);
  const rows = v2.targets;
  return h('div', { class: 'ms-targets' },
    sectionTitle(title, rows.length ? h('span', { class: 'ms-count' }, String(rows.length)) : null),
    found ? h('div', { class: ['ms-target', 'ms-target-new', p.newAsset && !p.targetAssetId && 'selected'] },
      h('button', { class: 'ms-target-main', type: 'button', 'aria-pressed': p.newAsset && !p.targetAssetId ? 'true' : 'false', onclick: () => { ui.noFoundAuto = false; setP({ newAsset: true, targetAssetId: null }); } },
        h('span', { class: 'ms-target-ic', 'aria-hidden': 'true' }, icon(kind === 'base' ? 'base' : 'estacao', 20)),
        h('span', { class: 'ms-target-text' },
          h('b', null, kind === 'base' ? 'Nova base' : 'Nova estação'),
          h('span', { class: 'tiny muted' }, kind === 'base' ? `Primeiro módulo de uma base sua ${v2.dest?.emLabel || 'aqui'}.` : `Primeiro módulo de uma estação sua ${v2.dest?.emLabel || 'nesta órbita'}.`))),
      p.newAsset && !p.targetAssetId ? h('label', { class: 'field ms-newname' }, h('span', { class: 'ms-eyebrow' }, 'Nome'),
        h('input', { class: 'input', value: p.newAssetName || '', placeholder: newName, maxlength: '32', 'aria-label': kind === 'base' ? 'Nome da nova base' : 'Nome da nova estação',
          oninput: (e) => { ui.draft = { ...ui.draft, payload: { ...(ui.draft.payload || p), newAssetName: e.target.value.slice(0, 32) || null } }; } })) : null) : null,
    rows.map((a) => targetRow(store, a, p.targetAssetId === a.id, () => { ui.noFoundAuto = true; setP({ targetAssetId: a.id, newAsset: false, newAssetName: null }); })),
    !rows.length && !found ? h('p', { class: 'muted small ms-empty-line' }, kind === 'satellite'
      ? `Nenhum satélite que aceite manutenção ${v2.dest?.emLabel || 'aqui'}.`
      : `Nenhuma ${kind === 'base' ? 'base' : 'estação'} ativa ${v2.dest?.emLabel || 'neste destino'}. Monte uma com uma missão de ${kind === 'base' ? 'carga (módulo de base)' : 'estação'}.`) : null);
}

/** Default name of a new station/base: modules.json `names`, else "Estação {Agência} {n}". */
export function defaultAssetName(store, kind, dest) {
  const st = store.state;
  const me = st?.actors?.[st?.playerId];
  const names = store.data?.modules?.names?.[kind === 'base' ? 'base' : 'station'];
  const place = dest?.short || dest?.name || 'Lua';
  const n = (Array.isArray(st?.assets?.list) ? st.assets.list.filter((a) => a?.ownerId === st.playerId && a.kind === kind).length : 0);
  if (Array.isArray(names) && names.length) return String(names[n % names.length]).replace('{place}', place).slice(0, 32);
  return (kind === 'base' ? `Base ${place}` : `Estação ${me?.short || me?.name || ''} ${n + 1}`).replace(/\s+/g, ' ').trim().slice(0, 32);
}

/** One existing asset as a target row: owner emblem, modules, health, supply; reason + "Propor parceria" when closed. */
function targetRow(store, a, selected, onPick) {
  const st = store.state;
  const owner = st.actors?.[a.ownerId] || { id: a.ownerId, name: a.ownerName };
  const facts = [
    a.mine ? 'sua' : a.partner ? `parceria · ${pct(a.share)}` : a.ownerName,
    a.kind === 'satellite' ? `${a.unitsN || 1} unidade${(a.unitsN || 1) === 1 ? '' : 's'}` : `${a.modulesN} módulo${a.modulesN === 1 ? '' : 's'}`,
    a.crewN ? `${a.crewN} a bordo` : null,
  ].filter(Boolean).join(' · ');
  const main = h('button', { class: 'ms-target-main', type: 'button', disabled: !a.ok, 'aria-pressed': selected ? 'true' : 'false', onclick: a.ok ? onPick : null },
    raw(emblemSVG(owner, { size: 28 }), 'ms-target-em'),
    h('span', { class: 'ms-target-text' },
      h('b', null, a.name),
      h('span', { class: 'tiny muted' }, facts),
      a.kind !== 'satellite' ? h('span', { class: 'ms-target-bars' },
        bar(a.health, { kind: healthKind(a.health), label: 'Saúde', key: `tg.${a.id}` }),
        h('span', { class: ['tiny', 'ms-supply', Number.isFinite(a.supplyWeeks) && a.supplyWeeks < 13 && 'low'] }, `Suprimentos: ${weeksText(a.supplyWeeks)}`)) : null),
    a.status !== 'active' ? chip(ASSET_STATUS_TEXT[a.status] || a.status, a.status === 'degraded' ? 'warn' : 'bad') : null);
  return h('div', { class: ['ms-target', selected && 'selected', !a.ok && 'disabled'] }, main,
    !a.ok && a.reason ? h('div', { class: 'ms-target-why tiny' }, icon('cadeado', 14, 'ms-note-ic'), h('span', null, a.reason),
      !a.mine && !a.partner && a.status !== 'derelict' ? button('Propor parceria', () => proposePartnership(store, a), { small: true, kind: 'ghost', icon: 'transferir', iconSize: 14 }) : null) : null);
}
const ASSET_STATUS_TEXT = { active: 'ativa', degraded: 'degradada', derelict: 'abandonada', ended: 'encerrada' };

/**
 * "Propor parceria" (§8.2 station_partnership): the same confirm-and-send flow as the Mundo proposal sheet.
 * Exported for the Infraestrutura screen.
 */
export async function proposePartnership(store, a) {
  const st = store.state;
  const to = a.ownerId;
  const who = st.actors?.[to]?.short || st.actors?.[to]?.name || a.ownerName || to;
  const terms = { assetId: a.id, owner: to };
  const types = store.tryQuery('diplomacy/proposalTypes', null, to);
  const row = Array.isArray(types) ? types.find((x) => x.id === 'station_partnership') : null;
  if (!row) { toast('Parcerias de estação ainda não estão abertas nesta partida.', 'warn'); return false; }
  if (row.available === false) { toast(row.reason || `${who} não aceita uma parceria agora.`, 'warn', 4500); return false; }
  const pre = store.tryQuery('diplomacy/preview', null, to, 'station_partnership', terms) || {};
  const chance = row.chance ?? pre.chance;
  const ok = await confirmDialog(
    `Propor uma parceria de estação a ${who} para ${a.name}? Com ela você pode enviar módulos, carga e tripulantes, e ganha uma parte da ciência pelo que entregar.${chance != null ? ` Chance de aceite: ${Math.round(chance * 100)}%.` : ''}`,
    { title: 'Parceria de estação', okLabel: 'Enviar proposta', cancelLabel: 'Voltar' });
  if (!ok) return false;
  const r = store.dispatch({ type: 'diplomacy/propose', to, proposalType: 'station_partnership', terms: pre.terms || row.terms || terms });
  if (r?.ok) toast(r.message || `Proposta enviada a ${who}.`, 'good');
  else toast(r?.error || 'Proposta não pôde ser enviada.', 'bad');
  return !!r?.ok;
}

/** Cargo picker (§11): module cards, surface vehicles + count, supply/propellant tonnes, notes for the rest. */
function cargoBlock(store, d, v2, set) {
  const kind = payloadKindOf(d);
  if (!kind) return null;
  const p = d.payload || emptyPayload(kind);
  const setP = (q) => set({ payload: { ...p, ...q } });
  if (kind === 'station_module' || kind === 'base_module' || kind === 'base_vehicle') {
    const isVeh = kind === 'base_vehicle';
    const sel = isVeh ? p.vehicleTypeId : p.moduleId;
    const rows = v2.cargo.filter((m) => !m.hidden || m.id === sel);
    const later = v2.cargo.length - rows.length;
    const picked = rows.find((m) => m.id === sel);
    const coreFirst = !isVeh && p.newAsset && !p.targetAssetId && picked && kind === 'station_module' && !(picked.traits || []).includes('core');
    return h('div', { class: 'ms-cargo' },
      sectionTitle(isVeh ? 'Veículo de superfície' : kind === 'station_module' ? 'Módulo da estação' : 'Módulo da base'),
      rows.length ? h('div', { class: 'ms-mod-grid' }, rows.map((m) => moduleCard(store, m, sel === m.id, () => setP(isVeh ? { vehicleTypeId: m.id } : { moduleId: m.id }))))
        : emptyState(v2.cargo.length ? 'Nada disponível nesta era.' : 'O catálogo de módulos ainda não carregou.', 'alerta'),
      later > 0 ? h('div', { class: 'tiny muted' }, `Mais ${later} chega${later === 1 ? '' : 'm'} com a pesquisa de eras futuras.`) : null,
      coreFirst ? note('Uma estação nova costuma começar pelo Núcleo: energia, suporte de vida e portas para os próximos módulos.', 'warn') : null,
      isVeh ? h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Quantidade'),
        stepper(Math.max(1, p.qty || 1), 1, 4, (q) => setP({ qty: q }), { label: 'Quantidade de veículos', unit: (q) => `${q} veículo${q === 1 ? '' : 's'}` })) : null);
  }
  if (kind === 'supply' || kind === 'propellant') {
    const tgt = v2.target;
    const room = tgt && Number.isFinite(tgt.storageT) ? Math.max(0, Math.ceil(tgt.storageT - tgt.supplyT)) : null;
    const q = Math.max(1, p.qty || 1);
    return h('div', { class: 'ms-cargo' },
      sectionTitle(kind === 'supply' ? 'Suprimentos' : 'Propelente'),
      h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Toneladas'),
        stepper(q, 1, 200, (x) => setP({ qty: x }), { label: 'Toneladas', unit: (x) => `${x} t`, step: (x) => (x >= 20 ? 5 : 1) })),
      kind === 'supply' && tgt ? h('div', { class: 'tiny muted' }, [
        Number.isFinite(tgt.supplyWeeks) ? `Hoje: ${weeksText(tgt.supplyWeeks)} de reserva` : null,
        tgt.upkeepTYr > 0 ? `consumo ${n1(tgt.upkeepTYr)} t/ano` : null,
        room != null ? `cabem mais ${room} t` : null].filter(Boolean).join(' · ')) : null,
      kind === 'supply' && room ? chip(`Encher o estoque (${room} t)`, '', { class: q === room ? 'active' : null, onclick: () => setP({ qty: room }) }) : null);
  }
  if (kind === 'experiments') return note('Experimentos dobram o ritmo dos laboratórios: +50% de ciência na estação ou base por 26 semanas.', '', 'info');
  if (kind === 'servicing') return note('Kit de reparo robótico: a unidade mais velha do observatório ganha +5 anos de vida e volta a 100% de saúde.', '', 'info');
  return null;
}

/** Module / vehicle card: name, mass and price, what it adds; locked ones greyed with the research link. */
function moduleCard(store, m, selected, onPick) {
  const facts = [Number.isFinite(Number(m.massT)) ? `${n1(m.massT)} t` : null, Number.isFinite(Number(m.costM)) ? fmtMoney(m.costM) : null].filter(Boolean).join(' · ');
  const adds = moduleAddsText(m, 3);
  return h('div', { class: ['ms-mod', selected && 'selected', m.lock && 'locked'] },
    h('button', { class: 'ms-mod-main', type: 'button', 'aria-pressed': selected ? 'true' : 'false', disabled: !!m.lock, onclick: m.lock ? null : onPick, title: m.desc || null },
      h('span', { class: 'ms-mod-top' }, m.lock ? icon('cadeado', 14, 'ms-chip-ic') : null, h('b', { class: 'ms-mod-name' }, m.label)),
      facts ? h('span', { class: 'ms-mod-facts' }, facts) : null,
      adds ? h('span', { class: 'ms-mod-adds' }, adds) : null),
    m.lock ? h('div', { class: 'ms-mod-lock tiny' },
      m.lock.nodeId ? h('button', { class: 'btn-link', type: 'button', onclick: () => store.ui?.navigate?.('pesquisa', `n/${m.lock.nodeId}`) }, m.lock.reason)
        : h('span', null, m.lock.reason)) : null);
}

/** − value + stepper with 44px buttons (§11). step: number or (value) => number. */
function stepper(value, min, max, onChange, { label = 'Quantidade', unit = (x) => String(x), step = 1 } = {}) {
  const stp = (x, dir) => (typeof step === 'function' ? step(dir > 0 ? x : x - 1) : step);
  return h('div', { class: 'ms-stepper', role: 'group', 'aria-label': label },
    h('button', { class: 'ms-step-btn', type: 'button', 'aria-label': 'Menos', disabled: value <= min, onclick: () => onChange(Math.max(min, value - stp(value, -1))) }, icon('menos', 18)),
    h('span', { class: 'ms-step-val', 'aria-live': 'polite' }, unit(value)),
    h('button', { class: 'ms-step-btn', type: 'button', 'aria-label': 'Mais', disabled: value >= max, onclick: () => onChange(Math.min(max, value + stp(value, 1))) }, icon('mais', 18)));
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
    onclick: () => {
      ui.destOpen = false; ui.noFoundAuto = false;
      const same = d.destination === x.id;
      set({ destination: x.id, vehicleId: same ? d.vehicleId : null, spacecraftId: same ? d.spacecraftId : null, ...(same || !d.payload ? {} : { payload: { ...d.payload, targetAssetId: null, newAsset: false } }) });
    },
  },
  h('div', { class: 'dest-top' },
    h('span', { class: 'dest-name' }, x.name || x.id),
    x.transitWeeks ? chip(`${x.transitWeeks} sem de viagem`, 'muted') : null),
  // "mapa de metrô": energy per leg as bars, no formulas
  x.route?.length ? h('div', { class: 'metro', 'aria-label': `custo de energia ${dv.toFixed(1)} km/s` },
    x.route.map((r) => h('span', { class: 'metro-leg', style: { flexGrow: String(Math.max(0.3, r.dv || 0.3)) }, title: `${r.from} → ${r.to}: ${r.dv} km/s` })),
    h('span', { class: 'metro-dv tiny' }, `${dv.toFixed(1).replace('.', ',')} km/s`)) : null,
  x.window ? h('div', { class: 'tiny muted' }, win ? `Janela ${win.openTurn <= st.turn ? 'aberta até ' + fmtMonth(win.closeTurn, st.startYear) : 'abre ' + fmtIn(win.openTurn, st.turn)}` : `Janela a cada ${Math.round(x.window.periodWeeks / 4.33)} meses`) : null,
  arr?.late ? note(`Chega só em ${fmtMonth(arr.arriveTurn, st.startYear)}: depois do fim da campanha (${st.startYear + Math.floor(st.endTurn / 52)}). Sem resultado científico no jogo.`, 'warn')
    : arr && arr.arriveTurn > st.turn + 8 ? h('div', { class: 'tiny muted' }, `Chegada ~${fmtMonth(arr.arriveTurn, st.startYear)}`) : null,
  !x.ok && x.reason ? h('div', { class: 'tiny ms-reason' }, x.reason) : null);
}

function step2(store, d, opts, set) {
  const idx = store.data?.index || {};
  const vehicles = sortVehicles(opts.vehicles, d);
  const roster = rosterOf(store);
  const fds = Array.isArray(opts.crew?.flightDirector) ? opts.crew.flightDirector : roster.filter((c) => c.role === 'flight_director');
  const astros = Array.isArray(opts.crew?.astronauts) && opts.crew.astronauts.length ? opts.crew.astronauts : roster.filter((c) => c.role === 'astronaut');
  const crewed = d.type === 'crewed' || (idx.spacecraft?.[d.spacecraftId]?.crew > 0);
  const setCrew = (patch) => set({ crew: { ...d.crew, ...patch } });

  // the engineers' pick for this target (item 9): highlighted and offered, never preselected
  const sug = d.suggestion || (d.type && d.destination ? store.tryQuery('missions/suggest', null, d) : null);
  const sugName = sug ? [sug.vehicleName || idx.vehicles?.[sug.vehicleId]?.name || sug.vehicleId, sug.spacecraftId ? (sug.spacecraftName || idx.spacecraft?.[sug.spacecraftId]?.name || sug.spacecraftId) : null].filter(Boolean).join(' + ') : null;
  const tookSug = !!sug && d.vehicleId === sug.vehicleId && (d.spacecraftId || null) === (sug.spacecraftId || null);
  return h('div', null,
    sug && sugName && !tookSug ? suggestionNote(sug, sugName, () => set({ vehicleId: sug.vehicleId || null, spacecraftId: sug.spacecraftId || null, secondarySpacecraftId: null })) : null,
    hardwareSections(store, d, opts, set, sug, vehicles),

    sectionTitle('Sala de controle'),
    pickPerson(store, 'Diretor(a) de voo', fds, d.crew.flightDirector, (id) => { ui.noFd = !id; setCrew({ flightDirector: id }); }),
    crewed ? pickPerson(store, 'Comandante', astros, d.crew.commander, (id) => setCrew({ commander: id, astronauts: (d.crew.astronauts || []).filter((x) => x !== id) })) : null,
    crewed ? pickMany(store, `Tripulação (${opts.crewSeats || '?'} lugares)`, astros.filter((a) => a.id !== d.crew.commander), d.crew.astronauts || [], Math.max(0, (opts.crewSeats || 3) - 1), (ids) => setCrew({ astronauts: ids })) : null,

    sectionTitle('Configuração'),
    h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Estratégia'),
      segmented(Object.entries(STRATEGY_LABELS).map(([id, label]) => ({ id, label })), d.config.strategy, (v) => set({ config: { ...d.config, strategy: v } }))),
    h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Margem de combustível'),
      segmented(MARGINS.map((m) => ({ id: m, label: fmtPct(m) })), d.config.fuelMargin, (v) => set({ config: { ...d.config, fuelMargin: v } }))),
    h('p', { class: 'tiny muted' }, 'Mais margem = menos carga, mais segurança. Agressiva encurta prazos e aumenta o risco.'));
}

/** Vehicles usable first, then the blocked ones the player can unlock (thinner margin, certification), nearest first. */
function sortVehicles(list, d) {
  return list.slice().sort((a, b) => (b.ok - a.ok) || (!a.ok && !b.ok ? vehicleFixRank(a, d) - vehicleFixRank(b, d)
    || (Number(a.capacityShortT) || 0) - (Number(b.capacityShortT) || 0) : 0) || (a.costM || 0) - (b.costM || 0));
}

/**
 * Rocket + craft pickers (builder step 2 and the vehicle step of an accepted mission). `sug` = the engineers'
 * suggestion ({vehicleId, spacecraftId, reason}): highlighted, never preselected (item 9).
 */
function hardwareSections(store, d, opts, set, sug = null, sorted = null) {
  const st = store.state;
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[d.destination];
  const capKey = dest?.capacityKey;
  const vehicles = sorted || sortVehicles(opts.vehicles, d);
  const sugTag = () => h('span', { class: 'sugestao-tag' }, 'sugestão');
  // Craft that only miss on tonnage stay visible (greyed, with their hold) so the player sees why (F2).
  const pk = payloadKindOf(d);
  const cargoMassT = pk && pk !== 'client' ? cargoOf(store, d, opts).massT : null;
  const holdOf = (s) => cargoOnlyBlock(s, cargoMassT, idx.spacecraft);
  return h('div', { class: 'hardware' },
    sectionTitle('Veículo lançador'),
    vehicles.length ? h('div', { class: 'veh-list' }, vehicles.map((v) => {
      const op = st.actors?.[v.operator] || { id: v.operator };
      const cap = v.effectiveCapacityT ?? v.capacityT ?? (capKey ? v.capacity?.[capKey] : null);
      const rel = v.reliability || v.rel;
      const flights = rel?.flights ?? v.history?.flights ?? v.flights;
      const cardEl = h('button', {
        class: ['veh-card', d.vehicleId === v.id && 'selected', !v.ok && 'disabled', sug?.vehicleId === v.id && 'sugerido'], type: 'button', disabled: !v.ok,
        'aria-pressed': d.vehicleId === v.id ? 'true' : 'false',
        onclick: () => (d.spacecraftId && flightBlock(store, d.spacecraftId, v.id)
          ? (ui.noCraft = false, set({ vehicleId: v.id, spacecraftId: null, secondarySpacecraftId: null }))
          : set({ vehicleId: v.id })),
      },
      raw(emblemSVG(op, { size: 30 }), 'veh-emblem'),
      h('div', { class: 'veh-text' },
        h('div', { class: 'veh-name' }, v.name || v.id, sug?.vehicleId === v.id ? sugTag() : null, v.design ? h('span', { class: ['design-tag', v.designPhase !== 'operational' && 'testing'] }, v.designPhase === 'operational' ? 'seu projeto' : v.designPhase === 'testFlights' ? 'em teste' : 'no hangar') : null),
        h('div', { class: 'tiny muted' }, [
          v.costM != null ? fmtMoney(v.costM) : null,
          cap != null && d.destination ? `${String(cap).replace('.', ',')} t até o alvo` : null,
          flights != null ? `${flights} voo${flights === 1 ? "" : "s"}` : null,
          v.reusable ? 'reutilizável' : null,
        ].filter(Boolean).join(' · ')),
        !v.ok && v.reason ? h('div', { class: 'tiny ms-reason' }, v.reason) : null),
      h('span', { class: 'veh-chips' },
        rel?.low != null ? chip(fmtBand(rel.low, rel.high), 'info') : v.estimatedReliability ? chip(`~${fmtPct(v.estimatedReliability)}`, 'muted') : null,
        v.truthLayer && v.truthLayer !== 'fato' && !v.design && TRUTH_LABELS[v.truthLayer] ? chip(TRUTH_LABELS[v.truthLayer], 'muted') : null));
      const help = !v.ok ? vehicleHelp(store, v, d, () => set({}), set) : null;
      return help ? h('div', { class: 'veh-wrap' }, cardEl, help) : cardEl;
    })) : emptyState('Nenhum veículo disponível para este alvo agora.', 'alerta'),

    missionTypeOf(d.type) === 'station' ? [sectionTitle('Espaçonave'), h('p', { class: 'muted small' }, 'O módulo voa sozinho até a órbita e se acopla (ou é posicionado): não precisa de espaçonave.')] : [
    sectionTitle(payloadKindOf(d) && payloadKindOf(d) !== 'client' ? 'Nave de carga' : 'Espaçonave'),
    opts.spacecraft.length ? h('div', { class: 'chips wrap ms-pills' },
      chip('Nenhuma', '', { class: !d.spacecraftId ? 'active' : null, 'aria-pressed': !d.spacecraftId ? 'true' : 'false', onclick: () => { ui.noCraft = true; set({ spacecraftId: null, secondarySpacecraftId: null }); } }),
      // every craft of this mission type shows up: the ones that do not fit stay greyed with the reason (they used to
      // be hidden, so a researched lander looked missing when the chosen rocket could not carry it)
      opts.spacecraft.filter((s) => s.ok || s.design || s.id === d.spacecraftId || holdOf(s) != null || (s.reason && !/tipo incompat|não serve para este destino/i.test(s.reason)))
        .sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0)).map((s) => {
        const block = s.ok ? flightBlock(store, s.id, d.vehicleId) : null;
        const usable = s.ok && !block;
        const hold = usable ? null : holdOf(s);
        const why = !usable && !block && hold == null ? (s.reason ? ` · ${shortWhy(s.reason)}` : ' · não serve') : '';
        return chip(`${s.name || s.id}${s.design ? ' · seu projeto' : ''}${s.crew ? ` · ${s.crew} lugares` : ''}${s.costM ? ` · ${fmtMoney(s.costM)}` : ''}${block ? ` · ${block}` : ''}${hold != null ? ` · leva só ${n1(hold)} t` : ''}${why}${sug?.spacecraftId === s.id ? ' · sugestão' : ''}`,
          d.spacecraftId === s.id && !usable ? 'bad' : usable ? '' : 'muted',
          { class: [d.spacecraftId === s.id && usable ? 'active' : null, sug?.spacecraftId === s.id ? 'sugerido' : null].filter(Boolean).join(' ') || null, 'aria-pressed': d.spacecraftId === s.id ? 'true' : 'false', onclick: usable ? () => { ui.noCraft = false; set({ spacecraftId: s.id, secondarySpacecraftId: null }); } : () => toast(`${s.name}: ${block || s.reason || 'incompatível'}.`, 'warn'), title: block || s.reason || s.notes || '', 'aria-disabled': usable ? null : 'true' });
      }))
      : h('p', { class: 'muted small' }, 'Sem espaçonaves compatíveis no catálogo (a carga vai como satélite genérico).'),
    carrierLine(store, d, opts, set)],
    landerPicker(opts, d, set));
}

// ------------------------------------------------------------------ crew certification + capacity help

const pctTxt = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
/** A spacecraft's refusal reason, short enough for a chip (the full text goes to the toast/title). */
function shortWhy(r) {
  const t = String(r || '').replace(/.$/, '');
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}
const tTxt = (x) => String(Math.round((Number(x) || 0) * 10) / 10).replace('.', ',');

/**
 * Plain-language explanation of "Capacidade < carga" (pure: exported for tests). v = draftOptions vehicle entry.
 * Returns null when the vehicle carries the payload.
 */
export function capacityHelpText(v, { destName = 'o alvo', margin = 0.1, farTarget = false } = {}) {
  const short = Number(v?.capacityShortT) || 0;
  if (!(short > 0)) return null;
  const head = `Faltam ${tTxt(short)} t: a carga (nave + módulos) pesa ${tTxt(v.payloadT)} t e o ${v.name || v.id} leva só ${tTxt(v.effectiveCapacityT)} t até ${destName} com margem de ${pctTxt(margin)}. `;
  const fit = v.marginFit;
  if (fit && fit.margin < margin) return `${head}Com margem de combustível de ${pctTxt(fit.margin)} ele leva ${tTxt(fit.capacityT)} t: cabe (com um pouco mais de risco).`;
  const tips = ['um foguete mais pesado', 'uma nave ou módulo mais leve'];
  if (margin > 0) tips.push('menos margem de combustível (mas nem com 0% cabe)');
  return `${head}Tente ${tips.join(', ')}.${farTarget ? ' Para a Lua e além, cargas grandes pedem um superpesado ou reabastecimento em órbita.' : ''}`;
}

/**
 * How close a greyed-out vehicle is to being usable (pure: exported for tests). Lower = show first.
 * 0 = fixable now (thinner margin and/or a certification the player can start or already runs), 1 = waits on
 * someone else (rival program, calendar milestone, access), 2 = cannot be certified, 3 = too weak for the payload.
 */
export function vehicleFixRank(v, d = {}) {
  const short = Number(v?.capacityShortT) || 0;
  if (short > 0 && !v?.marginFit) return 3;
  const needsCert = d.type === 'crewed' && v?.crewRated === false;
  const cs = v?.crewCert;
  if (!needsCert || !cs || cs.rated) return short > 0 ? 0 : 1;
  if (!cs.feasible) return 2;
  if (cs.start?.ok || cs.program?.mine) return 0;
  return 1;
}

/** One-line summary of a vehicle's crew-certification path (pure: exported for tests). cs = catalog/crewCert view. */
export function certSummaryText(cs, money = (m) => `US$ ${Math.round(m)} mi`) {
  if (!cs) return null;
  if (cs.rated) return cs.native ? 'Certificado para tripulação.' : 'Certificado para tripulação durante a campanha.';
  if (!cs.feasible) return `Indisponível: ${cs.reason || 'a operadora não oferece versão tripulada.'}`;
  const p = cs.program;
  if (p) {
    const who = p.mine ? 'Sua certificação' : `Certificação de ${p.sponsorName}`;
    return `${who} em andamento: ${p.phaseLabel} (${pctTxt(p.progress)}).`;
  }
  const s = cs.start || {};
  const months = Math.max(1, Math.round((s.weeks || 0) / 4.33));
  const cost = s.costM != null ? `, ${money(s.costM)}` : '';
  return `Certificar: ${cs.flightsNeeded} voos bem-sucedidos (tem ${cs.flightsOk}) + demo não tripulado${cost}, ~${months} meses${s.customer ? ' (contrato com a operadora)' : ''}.`;
}

function certChecklist(cs) {
  const p = cs.program;
  const row = (done, text) => h('li', { class: done ? 'ok' : '' }, done ? icon('check', 14, 'cert-ic') : h('span', { class: 'cert-ic cert-todo', 'aria-hidden': 'true' }), h('span', null, text));
  return h('ul', { class: 'cert-steps tiny' },
    p ? row(p.workDone, `Engenharia e revisão${p.workDone ? '' : ` até ${p.readyText}`}`) : row(false, `Engenharia e revisão (~${Math.max(1, Math.round((cs.start?.weeks || 0) / 4.33))} meses)`),
    row(cs.flightsOk >= cs.flightsNeeded, `Voos bem-sucedidos: ${cs.flightsOk}/${cs.flightsNeeded} (contam os de qualquer cliente)`),
    row(cs.reliability >= cs.minReliability, `Confiabilidade: ${pctTxt(cs.reliability)} de ${pctTxt(cs.minReliability)}`),
    row(false, p?.phase === 'demo' ? `Voo de demonstração sem tripulação${p.demoAttempts ? ` (${p.demoAttempts} falha${p.demoAttempts > 1 ? 's' : ''})` : ''}: em Missões › Programa` : 'Voo de demonstração sem tripulação (pago à parte)'));
}

/** Cash before/after paying for a certification (pure: exported for tests). */
export function certCashCheck(cash, costM) {
  const before = Number(cash) || 0;
  const after = before - (Number(costM) || 0);
  return { before, after, short: after < 0, shortBy: after < 0 ? -after : 0 };
}

const playerCash = (store) => store.state?.actors?.[store.state?.playerId]?.cash ?? 0;

async function startCert(store, cs, after) {
  const s = cs.start || {};
  if (!s.ok) { toast(s.error || 'Não dá para certificar agora.', 'warn'); return; }
  if (!s.resume) {
    const cc = certCashCheck(playerCash(store), s.costM);
    const money = cc.short
      ? ` Atenção: você tem ${fmtMoney(cc.before)} em caixa: pagar deixa a agência ${fmtMoney(cc.shortBy)} no vermelho (linha de crédito, com juros e desgaste político).`
      : ` Caixa: ${fmtMoney(cc.before)} → ${fmtMoney(cc.after)} depois de pagar.`;
    const ok = await confirmDialog(
      `Certificar o ${cs.name} para tripulação? Custa ${fmtMoney(s.costM)} agora e leva ~${Math.round((s.weeks || 0) / 4.33)} meses de engenharia. Depois faltam ${Math.max(0, cs.flightsNeeded - cs.flightsOk)} voos bem-sucedidos do foguete e um voo de demonstração sem tripulação.${money}`,
      { okLabel: cc.short ? `Pagar no vermelho (${fmtMoney(s.costM)})` : `Certificar (${fmtMoney(s.costM)})`, cancelLabel: 'Agora não', title: 'Certificação tripulada' });
    if (!ok) return;
  }
  const r = store.dispatch({ type: 'vehicle/certify', vehicleId: cs.vehicleId });
  if (r?.ok) toast(r.resumed ? 'Demonstração retomada: veja Missões › Programa.' : `Certificação do ${cs.name} iniciada.`, 'ok');
  else toast(r?.error || 'Não foi possível iniciar a certificação.', 'warn');
  after?.();
}

/** The crew-certification block for one vehicle (builder help and fleet view). */
function certBlock(store, cs, after) {
  if (!cs || cs.rated) return null;
  if (!cs.feasible) return h('div', { class: 'cert-box muted' }, h('div', { class: 'cert-locked tiny' }, icon('cadeado', 14, 'cert-ic'), h('span', null, certSummaryText(cs, fmtMoney))));
  const p = cs.program;
  const cc = !p && cs.start?.ok ? certCashCheck(playerCash(store), cs.start.costM) : null;
  return h('div', { class: 'cert-box' },
    h('div', { class: 'tiny cert-title' }, certSummaryText(cs, fmtMoney)),
    p ? bar(Math.round((p.progress || 0) * 100), { kind: 'info', label: 'Progresso da certificação' }) : null,
    certChecklist(cs),
    cs.grant ? h('div', { class: 'tiny muted' }, `Ou no cronograma real: o sucesso de "${cs.grant.name}" (${cs.grant.ownerName}, previsto ${cs.grant.when}) certifica o ${cs.name}.`) : null,
    cs.note ? h('div', { class: 'tiny muted' }, cs.note) : null,
    p ? (p.mine && p.paused ? button('Retomar demonstração', () => startCert(store, cs, after), { small: true }) : null)
      : cs.start?.ok ? [
        cc?.short ? note(`Caixa ${fmtMoney(cc.before)}: pagar agora deixa a agência ${fmtMoney(cc.shortBy)} no vermelho.`, 'warn') : null,
        button(`Certificar · ${fmtMoney(cs.start.costM)}`, () => startCert(store, cs, after), { small: true, kind: cc?.short ? 'ghost' : 'primary' }),
      ]
        : h('div', { class: 'cert-locked tiny' }, icon('cadeado', 14, 'cert-ic'), h('span', null, cs.start?.error || 'Não dá para certificar agora.')));
}

/**
 * Under a greyed-out vehicle in the builder: why it cannot fly this mission and how to fix it. Collapsed behind
 * "Por quê?" (open by default only for vehicles the player can unlock now), so the list stays short on a phone.
 */
function vehicleHelp(store, v, d, after, set) {
  const dest = store.data?.index?.destinations?.[d.destination];
  const margin = d.config?.fuelMargin ?? 0.1;
  const capText = capacityHelpText(v, { destName: dest?.name || 'o alvo', margin, farTarget: !!dest && dest.capacityKey !== 'leo' && dest.capacityKey !== 'gto' });
  const needsCert = d.type === 'crewed' && v.crewRated === false;
  const cs = needsCert ? (v.crewCert || attempt(() => store.tryQuery('catalog/crewCert', null, v.id), null)) : null;
  if (!capText && !cs) return null;
  const tooWeak = (Number(v.capacityShortT) || 0) > 0 && !v.marginFit;
  const fit = v.marginFit && v.marginFit.margin < margin ? v.marginFit : null;
  const rank = vehicleFixRank({ ...v, crewCert: cs }, d);
  ui.vehHelpOpen = ui.vehHelpOpen || {};
  const open = ui.vehHelpOpen[v.id] ?? rank === 0;
  const body = [
    capText ? h('div', { class: 'tiny ms-help-text' }, capText) : null,
    fit && set ? button(`Usar margem ${pctTxt(fit.margin)}`, () => set({ config: { ...d.config, fuelMargin: fit.margin } }), { small: true, kind: cs ? 'ghost' : 'primary' }) : null,
    // certification never fixes a payload the rocket cannot lift: say so instead of offering a billion-dollar program
    cs && tooWeak ? h('div', { class: 'tiny muted' }, `Também não é certificado para tripulação, mas certificar não resolve: mesmo certificado, o ${v.name || v.id} não leva esta carga.`)
      : cs ? certBlock(store, cs, after) : null,
  ];
  return h('details', { class: 'veh-help', open, ontoggle: (e) => { ui.vehHelpOpen[v.id] = e.currentTarget.open; } },
    h('summary', { class: 'tiny veh-help-sum' }, icon('avancar', 14, 'veh-help-chev'), h('span', null, rank === 0 ? 'Como liberar' : 'Por quê?')),
    h('div', { class: 'veh-help-body' }, body));
}

/** Missões › Frota: every launcher you can buy now, what it carries and whether people can fly on it. */
function fleetView(store, rerender) {
  const st = store.state;
  const list = store.tryQuery('catalog/fleet', null, st.playerId);
  if (!Array.isArray(list) || !list.length) return emptyState('O catálogo de lançadores ainda não carregou.', 'missoes');
  const rows = list.slice().sort((a, b) => (b.available - a.available) || (b.crewRated - a.crewRated) || ((b.capacity?.leo || 0) - (a.capacity?.leo || 0)));
  const mine = rows.filter((v) => v.crewCert?.program?.mine);
  return h('div', { class: 'fleet' },
    h('p', { class: 'ms-lead' }, 'Foguetes em serviço. Para levar gente, o foguete precisa de certificação tripulada: voos bem-sucedidos, confiabilidade mínima e um voo de demonstração sem tripulação.'),
    mine.length ? sectionTitle('Suas certificações') : null,
    ...mine.map((v) => card({ cls: 'ms-cert-card', title: v.name, subtitle: v.provider || v.operator }, certBlock(store, v.crewCert, rerender))),
    sectionTitle('Catálogo'),
    h('div', { class: 'fleet-list' }, rows.map((v) => {
      const op = st.actors?.[v.operator] || { id: v.operator };
      const cs = v.crewCert;
      const crewChip = v.crewRated ? chip('Tripulado', 'good') : cs?.program ? chip(`Certificando ${pctTxt(cs.program.progress)}`, 'info') : cs?.feasible ? chip('Certificável', 'muted') : chip('Só carga', 'muted');
      const rel = v.reliability;
      return h('div', { class: ['fleet-card', !v.available && 'disabled'] },
        h('div', { class: 'fleet-top' },
          raw(emblemSVG(op, { size: 28 }), 'veh-emblem'),
          h('div', { class: 'veh-text' },
            h('div', { class: 'veh-name' }, v.name),
            h('div', { class: 'tiny muted' }, [v.provider || v.operator, v.costM != null ? fmtMoney(v.costM) : null, v.reusable ? 'reutilizável' : null].filter(Boolean).join(' · '))),
          crewChip),
        h('div', { class: 'fleet-stats' },
          fleetStat('LEO', `${tTxt(v.capacity?.leo)} t`), fleetStat('Lua', `${tTxt(v.capacity?.tli)} t`), fleetStat('Marte', `${tTxt(v.capacity?.mars)} t`),
          rel?.mean != null ? fleetStat('Confiab.', pctTxt(rel.mean)) : null,
          rel?.flights != null ? fleetStat('Voos', String(rel.flights)) : null),
        !v.available ? h('div', { class: 'cert-locked tiny' }, icon('cadeado', 14, 'cert-ic'), h('span', null, v.access?.reason || 'Indisponível para a agência agora.')) : null,
        v.available && !v.crewRated && !cs?.program?.mine ? certBlock(store, cs, rerender) : null);
    })));
}

function fleetStat(label, value) {
  return h('div', { class: 'fleet-stat' }, h('span', { class: 'ms-eyebrow' }, label), h('b', null, value));
}

/** Crewed landing with a capsule that needs a separate lander (Orion + HLS/Blue Moon): pick the lander. */
function landerPicker(opts, d, set) {
  const landers = opts.raw?.landers || [];
  const comp = opts.raw?.companion;
  if (!landers.length && !comp?.required) return null;
  return h('div', { class: 'field' },
    h('span', { class: 'ms-eyebrow' }, 'Módulo de pouso (lançado à parte)'),
    landers.length ? h('div', { class: 'chips wrap ms-pills' }, landers.map((l) => chip(
      `${l.name}${l.costM ? ` · ${fmtMoney(l.costM)}` : ''}${l.reliability?.low != null ? ` · ${fmtBand(l.reliability.low, l.reliability.high)}` : ''}`,
      '', { class: comp?.id === l.id ? 'active' : null, 'aria-pressed': comp?.id === l.id ? 'true' : 'false', onclick: () => set({ secondarySpacecraftId: l.id }) })))
      : note('Nenhum módulo de pouso tripulado disponível para a agência agora.', 'warn'),
    h('p', { class: 'tiny muted' }, 'O módulo vai em outro foguete e espera a tripulação em órbita lunar. O custo entra no total.'));
}

function pickPerson(store, label, people, selected, onPick) {
  return h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, label),
    people.length ? h('div', { class: 'person-row' }, people.map((p) => h('button', {
      class: ['person-pick', selected === p.id && 'selected', p.busy && 'busy'], type: 'button', 'aria-pressed': selected === p.id ? 'true' : 'false',
      title: p.busy ? `Escalada(o) em ${p.busyWith || 'outra missão'}` : null,
      onclick: () => (p.busy && selected !== p.id ? toast(`${p.name} já está em ${p.busyWith || 'outra missão'}.`, 'warn') : onPick(selected === p.id ? null : p.id)),
    }, raw(portraitSVG(p.portrait || p.id, { size: 40 }), 'face'), h('span', { class: 'tiny' }, p.name?.split(' ').slice(-1)[0] || p.id), h('span', { class: 'tiny muted ms-skill' }, `★ ${Math.round(p.skill ?? 0)}`))))
      : h('p', { class: 'muted small' }, 'Ninguém disponível nesta função. Contrate na tela de Equipe.'));
}

function pickMany(store, label, people, selected, max, onChange) {
  return h('div', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, label),
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
      }, raw(portraitSVG(p.portrait || p.id, { size: 40 }), 'face'), h('span', { class: 'tiny' }, p.name?.split(' ').slice(-1)[0] || p.id), h('span', { class: 'tiny muted ms-skill' }, `★ ${Math.round(p.skill ?? 0)}`));
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

/** Cost lines of the sim's breakdown (§1.5 "Módulo {nome}", "Veículos ({n})", "Suprimentos ({t} t)"…), non-zero only. */
function costLines(opts) {
  const b = opts.raw?.cost?.breakdown;
  return Array.isArray(b) ? b.filter((l) => l && l.label && Number.isFinite(Number(l.amount)) && Number(l.amount) !== 0).map((l) => ({ label: l.label, amount: Number(l.amount) })) : [];
}

/** Cargo and target rows of the summary card. */
function summaryCargoRows(store, d, opts) {
  const kind = payloadKindOf(d);
  const p = d.payload || {};
  const out = [];
  const { module, vehicle, massT } = cargoOf(store, d, opts);
  if (kind && kind !== 'client') {
    const what = module ? `${PAYLOAD_LABELS[kind]}: ${module.label}` : vehicle ? `${Math.max(1, p.qty || 1)} × ${vehicle.label}`
      : kind === 'supply' || kind === 'propellant' ? `${PAYLOAD_LABELS[kind]} (${Math.max(1, p.qty || 1)} t)` : PAYLOAD_LABELS[kind];
    out.push(kv('Carga', `${what}${Number(massT) > 0 && (module || vehicle) ? ` · ${n1(massT)} t` : ''}`));
  }
  if (needsTarget(d)) {
    const dest = store.data?.index?.destinations?.[d.destination];
    const a = p.targetAssetId ? assetViews(store).find((x) => x.id === p.targetAssetId) : null;
    out.push(kv('Destino da carga', a ? a.name : p.newAsset ? `${p.newAssetName || defaultAssetName(store, targetKindOf(d, dest), dest)} (nova)` : '—'));
  }
  return out;
}

/** "O que esta missão cria ou muda" (§11 step 3): the sim's preview, or the data-based estimate. */
function previewCard(store, d, opts) {
  const idx = store.data?.index || {};
  const dest = idx.destinations?.[d.destination] || null;
  let pv = opts.raw?.preview && Array.isArray(opts.raw.preview.rows) ? opts.raw.preview : null;
  if (!pv) {
    const target = d.payload?.targetAssetId ? assetViews(store).find((x) => x.id === d.payload.targetAssetId) || null : null;
    const { module, vehicle } = cargoOf(store, d, opts);
    const subRow = subtypeRows(store.data, d.type).find((r) => r.id === d.sub) || null;
    pv = assetPreview({ d, dest, target, module, vehicle, subRow, md: modulesData(store), playerId: store.state.playerId });
  }
  if (!pv || !pv.rows?.length) return null;
  const rows = pv.rows.map((r) => (Array.isArray(r) ? r : [r.label, r.value])).filter((r) => r[0] && r[1] != null);
  return h('section', { class: 'card ms-preview' },
    h('div', { class: 'ms-eyebrow' }, 'O que esta missão cria ou muda'),
    pv.title ? h('div', { class: 'ms-preview-title' }, pv.title) : null,
    h('div', { class: 'kv' }, rows.map(([k, v]) => kv(k, String(v)))),
    pv.note ? h('p', { class: 'tiny muted' }, pv.note) : null);
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
  // investors hold the agenda (EXPANSION.md §5.2): no own slot left this year means no new own mission
  const ag = agendaOf(store);
  const noSlot = !!ag?.enforced && ag.left <= 0 && !d.contractId;
  const errors = dedupeMessages([...opts.errors, ...(cantPay ? ['Caixa insuficiente para pagar a missão agora.'] : []),
    ...(noSlot ? [`Agenda tomada pelos investidores: as ${ag.own} vaga${ag.own === 1 ? '' : 's'} de missão própria de ${ag.year} já foram usadas.`] : [])]);
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
      else { toast(`${store.state.missions?.find((m) => m.id === id)?.name || draft.name || 'Missão'} agendada para ${fmtMonth(ui.launchTurn, st.startYear)}.`, 'good'); store.vibrate(30); }
    } else toast('Missão salva em planejamento.', 'good');
    ui.draft = newDraft(); ui.step = 1; ui.noFd = false; ui.noCraft = false; ui.name = ''; ui.launchTurn = null; ui.subAuto = true; ui.destOpen = false;
    store.ui?.navigate ? store.ui.navigate('missoes', 'lista') : rerender();
  };

  return h('div', null,
    sectionTitle('Resumo'),
    h('label', { class: 'field' }, h('span', { class: 'ms-eyebrow' }, 'Nome'), nameInput),
    card({ cls: 'summary-card' },
      h('div', { class: 'kv' },
        kv('Tipo', typeSubLabel(d.type, d.sub) || '—'),
        kv('Alvo', dest?.name || d.destination || '—'),
        ...summaryCargoRows(store, d, opts),
        kv('Veículo', veh?.name || d.vehicleId || '—'),
        kv('Espaçonave', sc?.name || (d.spacecraftId || 'nenhuma')),
        opts.raw?.companion ? kv('Módulo de apoio', opts.raw.companion.name) : null,
        kv('Estratégia', `${STRATEGY_LABELS[d.config.strategy]} · margem ${fmtPct(d.config.fuelMargin)}`),
        opts.payloadT != null ? kv('Carga', `${String(opts.payloadT).replace('.', ',')} t${opts.capacityT != null ? ` de ${String(opts.capacityT).replace('.', ',')} t possíveis` : ''}`, true) : null,
        ...costLines(opts).map((l) => kv(l.label, fmtMoney(l.amount), true)),
        kv('Custo', opts.cost != null ? fmtMoney(opts.cost) : '—', opts.cost != null),
        me ? kv('Caixa depois', fmtMoney((me.cash || 0) - (opts.cost || 0)), true) : null,
        opts.window?.openTurn != null && Number.isFinite(opts.window.closeTurn) ? kv('Janela', `${fmtMonth(opts.window.openTurn, st.startYear)} a ${fmtMonth(opts.window.closeTurn - 1, st.startYear)}`) : null,
        arr ? kv('Chegada', `${fmtMonth(arr.arriveTurn, st.startYear)}${arr.late ? ' · após o fim' : ''}`) : null)),
    previewCard(store, d, opts),
    // a chance for a mission that cannot fly is misleading: grey it out until the errors are fixed
    est ? chanceGauge(est, { invalid: errors.length > 0 }) : h('p', { class: 'muted small' }, 'A estimativa de chance aparece quando o módulo de risco estiver pronto.'),
    factors.length ? h('ul', { class: 'factors' }, factors.map((f) => h('li', { class: (f.delta || 0) >= 0 ? 'pos' : 'neg' },
      h('span', null, (f.delta || 0) >= 0 ? '▲' : '▼'), ' ', f.label, h('span', { class: 'muted' }, ` ${f.delta > 0 ? '+' : ''}${fmtPct(f.delta)}`)))) : null,
    warnings.length || lateNote ? h('div', { class: 'ms-notes' }, [...(lateNote ? [lateNote] : []), ...warnings].map((w) => note(w, 'warn'))) : null,
    errors.length ? h('div', { class: 'ms-notes' }, errors.map((w) => note(w, 'bad', 'fechar'))) : null,
    sectionTitle('Data de lançamento'),
    dates.length ? h('div', { class: 'chips wrap ms-pills' }, dates.map((o) => chip(o.label, '', { class: ui.launchTurn === o.turn ? 'active' : null, 'aria-pressed': ui.launchTurn === o.turn ? 'true' : 'false', onclick: () => { ui.launchTurn = o.turn; rerender(); } }))) : null,
    h('div', { class: 'btn-col ms-final' },
      button('Criar e agendar lançamento', () => create(true), { kind: 'primary', icon: 'missoes', big: true, disabled: !opts.valid || errors.length > 0 || ui.launchTurn == null }),
      button('Salvar em planejamento', () => create(false), { big: true, disabled: !d.type || noSlot })));
}

// ------------------------------------------------------------------ contracts

function getContracts(store) {
  const q = store.tryQuery('missions/contracts', null);
  if (Array.isArray(q)) return q;
  return Array.isArray(store.state.contracts) ? store.state.contracts : [];
}

/** Missões › Contratos: the tender board of the drawer's Contratos screen, embedded (src/ui/contracts.js). */
function contractsView(store, rerender) {
  const out = h('div', { class: 'ms-contratos' });
  renderBoard(out, store, rerender, { embedded: true });
  return out;
}

function contractStatus(c) {
  const S = { open: 'aberto', offered: 'oferta', bidding: 'lance enviado', won: 'ganho', awarded: 'ganho', accepted: 'aceito', late: 'atrasado', closed: 'perdido', lost: 'perdido', delivered: 'entregue', done: 'cumprido', completed: 'cumprido', failed: 'falhou', defaulted: 'descumprido', expired: 'expirou' };
  return S[c.status] || c.status || 'aberto';
}

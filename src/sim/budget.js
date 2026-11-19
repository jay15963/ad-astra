// Finances of the player and of AI actors (ARCHITECTURE "src/sim/budget.js"). US$ millions everywhere.
// Slice: state.finance (player ledger + yearly totals + rival yearly totals). Actor cash changes via changeActor.

import { addNews, changeActor, log, clamp, player } from '../core/helpers.js';
import { crossed, yearAt } from './simtime.js';

export const CATEGORIES = ['missions', 'research', 'crew', 'facilities', 'contracts', 'diplomacy', 'grants', 'infra', 'market'];
export const CATEGORY_LABELS = {
  missions: 'Missões',
  research: 'Pesquisa',
  crew: 'Equipe',
  facilities: 'Instalações',
  contracts: 'Contratos',
  diplomacy: 'Diplomacia',
  grants: 'Verba e repasses',
  infra: 'Infraestrutura',      // MISSIONS-V2 §3.4: ground operations of stations and bases, satellite services
  market: 'Vendas de foguetes', // MISSIONS-V2 §8.3: launches sold to other agencies
};

const LEDGER_CAP = 120; // EXPANSION.md §10
const WEEKS = 52;
const DEFAULT_FIXED_SHARE = 0.55;
/** Overdraft allowed (fraction of annual budget) before spend() refuses. */
const CREDIT_LINE = 0.1;
/** Weeks in the red before support starts to bleed. */
const DEBT_GRACE = 6;
/** Weeks in the red after which support 0 means being fired. */
const FIRE_AFTER = 8;
const FUNDS_COOLDOWN = 26;
/** Share of the yearly budget the player's research payments never touch (1950–3000 campaign, D1). */
const RESEARCH_RESERVE = 0.08;

// ---------- attention windows (Phase D1: stops per turn 0.15–0.35 in eras 5–7) ----------
// With steps of a quarter or longer, every step used to stop on something (a contract, an event card, a round, a
// mandate…). Non-urgent cards of the player's own modules (narrative, missions, investors, market) now arrive
// together in "attention" steps; urgent ones (launches, crises, derelicts, the board) are not gated. A step is an
// attention step when the modules that tick before budget (politics, diplomacy, calendar) already raised a card in
// it (the clock stops there anyway), or when ATTENTION_EVERY steps went by without one. budget.tick decides it in
// the step's first substep (slice state.finance.attn = {end, on, last}); without that decision (unit tests calling
// a module alone) the periodic rule holds. Steps shorter than ATTENTION_MIN_STEP weeks (eras 1–4, the Corrida Lunar)
// are never gated.
export const ATTENTION_MIN_STEP = 13;
export const ATTENTION_EVERY = 6;

/** Weeks of one attention window at this step length (0 = not gated). Pure. */
export function attentionPeriod(stepWeeks) {
  const sw = Math.max(1, Math.round(Number(stepWeeks) || 1));
  return sw >= ATTENTION_MIN_STEP ? sw * ATTENTION_EVERY : 0;
}

/**
 * True when non-urgent cards may be pushed in the current step: always with short steps; with long steps only in the
 * step that contains a multiple of the attention period (the first quarter of each year in era 5, every other year in
 * era 6, every fourth year in era 7). Works from any substep (reads ctx.stepEnd and the clock's step length).
 */
export function attentionStep(state, ctx) {
  const sw = state?.clock?.stepWeeks ?? 1;
  const P = attentionPeriod(sw);
  if (!P) return true;
  const end = Number.isFinite(ctx?.stepEnd) ? ctx.stepEnd : (state.turn || 0) + sw;
  const s = state.finance?.attn;
  if (s && s.end === end) return !!s.on;
  return Math.floor((end - 1) / P) > Math.floor((end - 1 - sw) / P);
}

const WORLD_CARD = /^(politics|diplomacy|lifecycle)\//;

/** budget.tick, first substep of a long step: is this an attention step? (see attentionStep) */
function planAttention(state, ctx) {
  const sw = state.clock?.stepWeeks ?? 1;
  const P = attentionPeriod(sw);
  const f = state.finance;
  if (!P || !Number.isFinite(ctx?.stepEnd)) { if (f.attn) delete f.attn; return; }
  const s = f.attn || (f.attn = { end: null, on: false, last: null });
  if (s.end === ctx.stepEnd) return;
  const start = state.turn;
  s.end = ctx.stepEnd;
  // only the cards of the modules that tick before budget (politics, diplomacy, lifecycle) count: the launch-day
  // card and the cards of the launch the player just played carry this turn too, and counting them made every step
  // after a launch an attention step (D1: 0.42–0.47 stops per turn in era 6 for an agency that flies a lot)
  const others = (state.decisions || []).some((d) => (d.createdTurn ?? -1) >= start && WORLD_CARD.test(d.kind || ''));
  s.on = others || !Number.isFinite(s.last) || start - s.last >= P;
  if (s.on) s.last = start;
}

/** "US$ 1,2 bi" / "US$ 350 mi" */
export function fmtMoney(m) {
  const v = Number(m) || 0;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}US$ ${(Math.round(a / 100) / 10).toString().replace('.', ',')} bi`;
  if (a >= 10) return `${sign}US$ ${Math.round(a)} mi`;
  return `${sign}US$ ${(Math.round(a * 10) / 10).toString().replace('.', ',')} mi`;
}

const yearOf = (state) => yearAt(state);
const emptyYear = (state) => ({ year: yearOf(state), income: 0, spent: {}, budgetStart: state.actors?.[state.playerId]?.budget ?? 0, cashStart: state.actors?.[state.playerId]?.cash ?? 0 });

function fin(state) {
  if (!state.finance || !Array.isArray(state.finance.ledger)) {
    state.finance = { ledger: [], year: emptyYear(state), lastYear: null, debtWeeks: 0, history: [], rivals: {}, lastFundsTurn: null };
  }
  const f = state.finance;
  f.year = f.year || emptyYear(state);
  f.rivals = f.rivals || {};
  f.history = f.history || [];
  if (!f.programs || typeof f.programs !== 'object') f.programs = {};
  if (!Number.isFinite(f.debtWeeks)) f.debtWeeks = 0;
  return f;
}

export function init(state, data, ctx) {
  // diplomacy's init normally seeds cash = budget*0.25; be defensive if it did not.
  for (const a of Object.values(state.actors || {})) {
    if (!Number.isFinite(a.cash)) a.cash = (a.budget || 0) * 0.25;
    if (!Number.isFinite(a.fixedCostShare)) a.fixedCostShare = DEFAULT_FIXED_SHARE;
  }
  state.finance = { ledger: [], year: emptyYear(state), lastYear: null, debtWeeks: 0, history: [], rivals: {}, lastFundsTurn: null, programs: {} };
}

export function creditLine(state, actorId) {
  return Math.max(0, (state.actors?.[actorId]?.budget || 0) * CREDIT_LINE);
}

/** True if the actor can pay `amount` without exceeding its credit line. */
export function canAfford(state, actorId, amount) {
  const a = state.actors?.[actorId];
  if (!a) return false;
  const amt = Number(amount) || 0;
  if (amt <= 0) return true;
  return (a.cash || 0) - amt >= -creditLine(state, actorId);
}

function record(state, actorId, amount, category, note) {
  const f = fin(state);
  const cat = CATEGORIES.includes(category) ? category : 'facilities';
  if (actorId === state.playerId) {
    f.ledger.push({ turn: state.turn, amount: Math.round(amount * 1000) / 1000, category: cat, note: note || CATEGORY_LABELS[cat] });
    const cap = Number.isFinite(state.endTurn) && state.endTurn > 520 ? 40 : LEDGER_CAP; // 1950–3000: save budget
    if (f.ledger.length > cap) f.ledger.splice(0, f.ledger.length - cap);
    if (amount >= 0) f.year.income += amount;
    else f.year.spent[cat] = (f.year.spent[cat] || 0) - amount;
  } else {
    const r = (f.rivals[actorId] = f.rivals[actorId] || { income: 0, spent: 0 });
    if (amount >= 0) r.income += amount;
    else r.spent -= amount;
  }
}

/** Pay `amount`. Returns false (and changes nothing) if it would exceed the credit line. */
export function spend(state, actorId, amount, category = 'missions', note = '') {
  const amt = Number(amount) || 0;
  if (!state.actors?.[actorId]) return false;
  if (amt <= 0) return true;
  if (!canAfford(state, actorId, amt)) return false;
  // 1950–3000 (D1): the player's weekly research payments keep a reserve of RESEARCH_RESERVE × budget (about a month
  // of fixed costs) and the projects wait for money. Before, research ate every week's income at the edge of the
  // credit line, the fixed costs pushed the cash below zero and a small agency stayed in the red for months until
  // the government fired it.
  if (category === 'research' && actorId === state.playerId && Number.isFinite(state.endTurn) && state.endTurn > 520
    && (state.actors[actorId].cash || 0) - amt < (state.actors[actorId].budget || 0) * RESEARCH_RESERVE) return false;
  changeActor(state, actorId, 'cash', -amt);
  record(state, actorId, -amt, category, note);
  return true;
}

export function earn(state, actorId, amount, category = 'grants', note = '') {
  const amt = Number(amount) || 0;
  if (!state.actors?.[actorId] || amt <= 0) return false;
  changeActor(state, actorId, 'cash', amt);
  record(state, actorId, amt, category, note);
  return true;
}

/** Unconditional charge (fixed costs cannot be refused). */
function charge(state, actorId, amount, category, note) {
  if (amount <= 0 || !state.actors?.[actorId]) return;
  changeActor(state, actorId, 'cash', -amount);
  record(state, actorId, -amount, category, note);
}

// Headline variants: picked by a counter (year, streak), so the same line never shows twice in a row.
const pickV = (list, i) => list[((i % list.length) + list.length) % list.length];
const YEAR_HEADLINES = [
  (y, inc, out) => `Balanço de ${y}: entrou ${inc}, saiu ${out}`,
  (y, inc, out, net) => (net >= 0 ? `Contas de ${y} fecham no azul: ${out} gastos de ${inc}` : `Contas de ${y} fecham no vermelho: ${out} gastos, ${inc} de receita`),
  (y, inc, out) => `Fechamento de ${y}: ${out} investidos, ${inc} recebidos`,
  (y, inc, out, net) => `${y} em números: saldo de ${fmtMoney(net)}`,
];
const RED_HEADLINES = ['Caixa da agência no vermelho', 'Tesouro cobre o rombo, por enquanto', 'Conta da agência fica negativa', 'Saldo negativo acende alerta no governo'];
const DEBT_HEADLINES = [
  (w) => `Dívida prolongada derruba o apoio à agência (${w} semanas)`,
  (w) => `${w} semanas no vermelho: Parlamento fala em intervenção`,
  (w) => `Rombo de ${w} semanas corrói a confiança na agência`,
  (w) => `Imprensa conta ${w} semanas de caixa negativo e pede cabeças`,
];
const OUT_OF_RED = ['Agência sai do vermelho', 'Caixa volta ao azul', 'Fim do rombo: contas positivas de novo'];

const sumSpent = (spent) => Object.values(spent || {}).reduce((s, v) => s + v, 0);

/**
 * Unspent money at year end: agencies return half of the cash above RESERVE_KEEP x budget to the treasury;
 * companies pay out half of the cash above COMPANY_KEEP x budget to investors (dividends/buybacks).
 */
const RESERVE_KEEP = 0.6;
const COMPANY_KEEP = 0.6;
const RETURN_SHARE = 0.5;

function returnUnspent(state) {
  let mine = 0;
  for (const a of Object.values(state.actors || {})) {
    if (!a?.id) continue;
    const company = a.kind === 'company';
    const excess = (a.cash || 0) - (a.budget || 0) * (company ? COMPANY_KEEP : RESERVE_KEEP);
    if (excess <= 0) continue;
    const back = Math.round(excess * RETURN_SHARE);
    charge(state, a.id, back, 'grants', company ? 'Caixa excedente distribuído aos investidores' : 'Verba não usada devolvida ao tesouro');
    if (a.id === state.playerId) mine = back;
  }
  return mine;
}

/** Piecewise-linear [[year, value], …] curve at `year` (flat outside). Pure. */
export function curveAt(points, year) {
  const s = (Array.isArray(points) ? points : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!s.length) return 1;
  if (year <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (year <= s[i][0]) { const [y0, v0] = s[i - 1]; const [y1, v1] = s[i]; return v0 + (v1 - v0) * ((year - y0) / Math.max(1, y1 - y0)); }
  }
  return s[s.length - 1][1];
}

/**
 * D1: a founded agency has no budget series of its own, so the government's reference budget (politics'
 * `world.baseBudget`, the anchor its yearly budget is pulled toward) used to stay at the 1950 figure for a thousand
 * years while hardware, crews and facilities got dearer each era: a 1950 agency lived on US$ 50–150 mi/ano in 2900,
 * when the same agency founded in 2600 starts with US$ 1,4 bi. The reference now follows the founding scale of
 * data/core/hq-sites.json (`founding.scale`, the same curve the wizard uses), from the founding year on. The yearly
 * budget itself still moves with support, flights and the economy (politics pulls it toward 0.67–1.5 × the anchor).
 */
function foundedAnchor(state, data) {
  const pid = state.playerId;
  const a = state.actors?.[pid];
  const w = state.world;
  const scale = data?.hqSites?.founding?.scale;
  if (!a?.custom || !w?.baseBudget || !Array.isArray(scale) || !scale.length) return;
  const f = fin(state);
  if (!f.anchor || f.anchor.actorId !== pid) {
    const base = Number(w.baseBudget[pid]) || Number(a.budget) || 0;
    if (!(base > 0)) return;
    const born = Number(a.born?.year) || yearAt(state);
    f.anchor = { actorId: pid, base: Math.round(base * 10) / 10, scale: curveAt(scale, born) || 1 };
  }
  const k = curveAt(scale, yearAt(state)) / (f.anchor.scale || 1);
  w.baseBudget[pid] = Math.round(f.anchor.base * Math.max(1, k) * 10) / 10;
}

function closeYear(state) {
  const f = fin(state);
  const me = state.actors?.[state.playerId];
  const returned = returnUnspent(state);
  const y = f.year;
  const totalSpent = sumSpent(y.spent);
  const last = {
    year: y.year,
    income: Math.round(y.income),
    spent: Object.fromEntries(Object.entries(y.spent).map(([k, v]) => [k, Math.round(v)])),
    totalSpent: Math.round(totalSpent),
    net: Math.round(y.income - totalSpent),
    endCash: Math.round(me?.cash ?? 0),
    budget: me?.budget ?? 0,
    prevBudget: y.budgetStart ?? me?.budget ?? 0,
    returned,
  };
  f.lastYear = last;
  f.history.push({ year: last.year, income: last.income, spent: last.totalSpent, net: last.net, cash: last.endCash });
  if (f.history.length > 12) f.history.splice(0, f.history.length - 12);
  f.rivalsLastYear = f.rivals;
  f.rivals = {};
  f.year = emptyYear(state);

  if (me) {
    const top = Object.entries(last.spent).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const parts = top.map(([k, v]) => `${CATEGORY_LABELS[k] || k} ${fmtMoney(v)}`).join(', ');
    const bChange = last.budget - last.prevBudget;
    const budgetLine = Math.abs(bChange) >= 1
      ? `Verba de ${last.year + 1}: ${fmtMoney(last.budget)} (${bChange > 0 ? '+' : '−'}${fmtMoney(Math.abs(bChange))}).`
      : `Verba de ${last.year + 1} mantida em ${fmtMoney(last.budget)}.`;
    const tone = last.net >= 0 ? 'Ano fechado no azul.' : last.endCash < 0 ? 'Ano fechado no vermelho, e o caixa está negativo.' : 'Gastamos mais do que entrou.';
    addNews(state, {
      headline: pickV(YEAR_HEADLINES, last.year - (state.startYear ?? last.year))(last.year, fmtMoney(last.income), fmtMoney(last.totalSpent), last.net),
      body: `${tone} Maiores gastos: ${parts || 'nenhum'}. Caixa: ${fmtMoney(last.endCash)}. ${budgetLine}${returned > 0 ? (player(state)?.kind === 'company' ? ` Os investidores receberam ${fmtMoney(returned)} do caixa parado.` : ` O tesouro recolheu ${fmtMoney(returned)} de verba parada.`) : ''}`,
      tags: ['budget', 'year'],
      actors: [state.playerId],
      importance: 2,
      icon: 'budget',
    });
  }
}

// ---------- AI calendar programs ----------
// The player pays for the calendar programs it flies (missions.js: hardware minus the program's own appropriation);
// AI owners now pay for theirs too. Each program's bill (vehicle + spacecraft hardware × launches, minus the funded
// share) accrues linearly over the `buildWeeks` before its current launch date and is paid from cash, never below
// the reserve: what cannot be paid stays owed and is paid when cash allows (slips pause the accrual, a reflight is a
// new bill). Tuning: data/actors.json "finance.programs". Slice: state.finance.programs {`${calendarId}#${attempt}`: paid}.
const PROGRAM_DEFAULTS = {
  buildWeeks: 104,        // the bill accrues over the two years before launch
  agencyFundedShare: 0.35, // same appropriation share the player gets (missions.js calendarDraft)
  companyFundedShare: 0.2,
  clientFundedShare: 0.85, // a company flying for a paying customer (Vast, Axiom) fronts little of its own money
  partnerShare: 0.12,      // each partner pays this share (max 2 partners)
  costScale: 1,
  reserveShare: 0.08,      // cash below this share of the yearly budget is never used for programs
  maxWeeklyShare: 0.25,    // at most this share of the spare cash goes to programs in one week
};
// merged once per data object (read-only: no caller writes into the tuning)
const TUNING_CACHE = new WeakMap();
const NO_TUNING = {};
function programTuning(data) {
  const src = data?.actors?.finance?.programs || NO_TUNING;
  let t = TUNING_CACHE.get(src);
  if (!t) { t = { ...PROGRAM_DEFAULTS, ...src }; TUNING_CACHE.set(src, t); }
  return t;
}
const costOf = (list, id) => (id && list?.[id]?.costM) || 0;

/** Total bill an AI owner pays for one attempt of a calendar program (US$ mi). Pure. */
export function programBill(state, data, item, tun = programTuning(data)) {
  if (!item) return 0;
  const owner = state.actors?.[item.owner];
  const idx = data?.index || {};
  const hw = costOf(idx.vehicles, item.vehicleId) * Math.max(1, item.launches || 1)
    + costOf(idx.spacecraft, item.spacecraftId) + costOf(idx.spacecraft, item.secondarySpacecraftId);
  const company = owner?.kind === 'company';
  let funded = item.fundedShare ?? (company ? (item.client ? tun.clientFundedShare : tun.companyFundedShare) : tun.agencyFundedShare);
  funded += tun.partnerShare * Math.min(2, (item.partners || []).length);
  return Math.round(hw * tun.costScale * clamp(1 - funded, 0.05, 1));
}

/** What `actorId` still has to put into its calendar programs: {owedNow, upcoming} (US$ mi). */
export function programLoad(state, data, actorId) {
  const tun = programTuning(data);
  const f = fin(state);
  let owedNow = 0;
  let upcoming = 0;
  for (const inst of state.calendar || []) {
    const item = data?.index?.calendar?.[inst.id];
    if (!item || item.owner !== actorId || inst.status === 'player') continue;
    const key = `${inst.id}#${inst.attempts || 0}`;
    const bill = programBill(state, data, item, tun);
    const paid = f.programs[key] || 0;
    if (inst.status === 'planned') {
      const lead = (inst.currentTurn ?? inst.plannedTurn ?? 0) - (state.turn || 0);
      owedNow += Math.max(0, bill * clamp(1 - lead / tun.buildWeeks, 0, 1) - paid);
      upcoming += Math.max(0, bill - paid);
    } else if (paid > 0 && paid < bill) {
      owedNow += bill - paid;
      upcoming += bill - paid;
    }
  }
  return { owedNow, upcoming };
}

// Long campaigns: what a launched program still owes two years after its flight is written off. Before, a 1957 bill
// could stay open for centuries, and whether it did depended on the era packs in memory (the item leaves data.index
// when its pack is unloaded), so a lazy-loading phone and an eager desktop disagreed.
const WRITE_OFF_WEEKS = 104;
function writtenOff(state, inst) {
  if (!(Number.isFinite(state.endTurn) && state.endTurn > 520)) return false;
  const flew = inst.launchTurn ?? inst.resolvedTurn ?? inst.currentTurn;
  return Number.isFinite(flew) && state.turn - flew > WRITE_OFF_WEEKS;
}

function payPrograms(state, data, a, byOwner = null) {
  const tun = programTuning(data);
  const f = fin(state);
  let spare = Math.max(0, (a.cash || 0) - (a.budget || 0) * tun.reserveShare) * tun.maxWeeklyShare;
  const live = new Set();
  let paidNow = 0;
  for (const inst of (byOwner ? byOwner.get(a.id) || [] : state.calendar || [])) {
    const item = data?.index?.calendar?.[inst.id];
    if (!item || item.owner !== a.id || inst.status === 'player') continue;
    const key = `${inst.id}#${inst.attempts || 0}`;
    const paid = f.programs[key];
    const bill = programBill(state, data, item, tun);
    let target;
    if (inst.status === 'planned') {
      const lead = (inst.currentTurn ?? inst.plannedTurn ?? 0) - (state.turn || 0);
      target = bill * clamp(1 - lead / tun.buildWeeks, 0, 1);
    } else if (paid != null && paid < bill && inst.status !== 'cancelled' && !writtenOff(state, inst)) {
      target = bill; // launched with money still owed: the contractors still get paid
    } else continue;
    live.add(key);
    const due = target - (paid || 0);
    if (due <= 0.5) { if (paid == null) f.programs[key] = 0; continue; }
    const put = Math.round(Math.min(due, spare) * 10) / 10;
    f.programs[key] = Math.round(((paid || 0) + put) * 10) / 10;
    spare -= put;
    paidNow += put;
  }
  if (paidNow > 0) {
    charge(state, a.id, paidNow, 'missions', 'Programas do calendário');
    const r = f.rivals[a.id] || (f.rivals[a.id] = { income: 0, spent: 0 });
    r.programs = Math.round(((r.programs || 0) + paidNow) * 10) / 10;
  }
  return live;
}

function aiWeek(state, data, a, byOwner = null) {
  // 1) calendar programs are real bills; 2) the rest of the surplus goes into abstract programs/R&D, keeping the
  // reserve plus the discretionary fund the agency is saving for its own missions (calendar.js rivalOps) and the
  // next quarter of program bills
  const live = payPrograms(state, data, a, byOwner);
  const tun = programTuning(data);
  const keepFund = Math.min(state.rivalOps?.fund?.[a.id] || 0, (a.budget || 0) * (tun.keepFundShare ?? 0.4));
  const reserve = (a.budget || 0) * 0.2 + keepFund;
  if ((a.cash || 0) <= reserve) return live;
  const s = ((a.cash || 0) - reserve) * (tun.abstractRate ?? 0.06);
  const bold = clamp((a.ai?.aggression ?? 0.5) * 0.5 + 0.35, 0.2, 0.8);
  spend(state, a.id, s * bold, 'missions', 'Programas');
  spend(state, a.id, s * (1 - bold), 'research', 'P&D');
  return live;
}

function debtWeek(state) {
  const f = fin(state);
  const me = state.actors?.[state.playerId];
  if (!me) return;
  // D1: with steps of a quarter or longer the player only sees the red at the end of a step; the grace, the pace of
  // the support bleed and the firing threshold stretch by one step so there is always one step to react
  const sw = state.clock?.stepWeeks ?? 1;
  const slack = attentionPeriod(sw) ? sw : 0;
  const grace = DEBT_GRACE + slack;
  const pace = Math.max(6, slack);
  if ((me.cash || 0) < 0) {
    f.debtWeeks += 1;
    // 8 weeks of hysteresis: a cash line hovering around zero does not flip the headline every week
    if (f.debtWeeks === 1 && state.turn - (f.redNewsTurn ?? -99) >= 13) {
      f.redNewsTurn = state.turn;
      f.redCount = (f.redCount || 0) + 1;
      addNews(state, { headline: pickV(RED_HEADLINES, f.redCount - 1), body: 'O tesouro cobre por enquanto, mas o governo está de olho.', tags: ['budget'], actors: [state.playerId], importance: 2, icon: 'budget' });
    }
    if (f.debtWeeks >= grace) {
      const cut = 1 + Math.floor((f.debtWeeks - grace) / pace);
      changeActor(state, state.playerId, 'support', -cut);
      // first warning, then every 16 weeks of the same streak (and never twice within 16 weeks across streaks)
      if ((f.debtWeeks === grace || (f.debtWeeks - grace) % 16 === 0) && state.turn - (f.debtNewsTurn ?? -99) >= 16) {
        f.debtNewsTurn = state.turn;
        f.debtCount = (f.debtCount || 0) + 1;
        addNews(state, { headline: pickV(DEBT_HEADLINES, f.debtCount - 1)(f.debtWeeks), body: 'Parlamentares pedem cortes e a imprensa fala em descontrole.', tags: ['budget', 'politics', 'debt'], actors: [state.playerId], importance: 3, icon: 'budget' });
      }
    }
    if (f.debtWeeks >= FIRE_AFTER + slack && (me.support ?? 0) <= 0 && !state.gameOver) {
      state.gameOver = { reason: 'fired', turn: state.turn, summary: `Depois de ${f.debtWeeks} semanas no vermelho, o governo perdeu a paciência e trocou a direção da agência.` };
      addNews(state, { headline: 'Direção da agência é demitida', body: state.gameOver.summary, tags: ['budget', 'gameover'], actors: [state.playerId], importance: 3, icon: 'budget' });
      log(state, 'budget: game over (fired)');
    }
  } else if (f.debtWeeks > 0) {
    if (f.debtWeeks >= grace && state.turn - (f.redNewsTurn ?? -99) >= 8 && state.turn - (f.outNewsTurn ?? -99) >= 26) {
      f.outNewsTurn = state.turn;
      f.outCount = (f.outCount || 0) + 1;
      addNews(state, { headline: pickV(OUT_OF_RED, f.outCount - 1), body: 'O caixa voltou a ficar positivo.', tags: ['budget'], actors: [state.playerId], importance: 1, icon: 'budget' });
    }
    f.debtWeeks = 0;
  }
}

export function tick(state, data, ctx) {
  fin(state);
  planAttention(state, ctx);
  // year rollover (politics already adjusted actor.budget earlier in this tick)
  if (state.turn > 0 && crossed(state, ctx, WEEKS, 0)) { closeYear(state); foundedAnchor(state, data); }
  const live = new Set();
  // calendar instances by AI owner, in calendar order (payPrograms visited the whole calendar once per actor)
  const byOwner = new Map();
  for (const inst of state.calendar || []) {
    const owner = data?.index?.calendar?.[inst.id]?.owner;
    if (owner == null) continue;
    const l = byOwner.get(owner);
    if (l) l.push(inst); else byOwner.set(owner, [inst]);
  }
  for (const a of Object.values(state.actors || {})) {
    if (!a || !a.id) continue;
    const budget = Math.max(0, a.budget || 0);
    earn(state, a.id, budget / WEEKS, 'grants', a.kind === 'company' ? 'Receita semanal' : 'Verba semanal');
    charge(state, a.id, (budget * clamp(a.fixedCostShare ?? DEFAULT_FIXED_SHARE, 0, 1)) / WEEKS, 'facilities', 'Custos fixos (folha e instalações)');
    if (a.id !== state.playerId) for (const k of aiWeek(state, data, a, byOwner)) live.add(k);
  }
  // forget the bills of programs that flew, got cancelled or changed hands (keeps the slice small)
  const f = fin(state);
  for (const k of Object.keys(f.programs)) if (!live.has(k)) delete f.programs[k];
  if (crossed(state, ctx, 13, 12)) companyPayout(state);
  debtWeek(state);
}

// Companies do not sit on cash: investors take dividends every quarter, and a hoard well above a year of revenue
// makes them ask why the money is not flying (support = investor confidence). Keeps the player company cash-limited.
const PAYOUT_KEEP = 0.3;  // share of the yearly revenue a company keeps as working cash
const PAYOUT_SHARE = 0.5; // share of the excess paid out each quarter
function companyPayout(state) {
  const me = state.actors?.[state.playerId];
  if (!me || me.kind !== 'company') return;
  const excess = (me.cash || 0) - (me.budget || 0) * PAYOUT_KEEP;
  if (excess <= 0) return;
  charge(state, me.id, Math.round(excess * PAYOUT_SHARE), 'grants', 'Dividendos aos investidores');
  if ((me.cash || 0) > (me.budget || 0) * 0.75) {
    changeActor(state, me.id, 'support', -2);
    const f = fin(state);
    if (state.turn - (f.hoardNewsTurn ?? -99) >= 52) {
      f.hoardNewsTurn = state.turn;
      addNews(state, { headline: 'Investidores cobram: caixa parado não leva ninguém à Lua', body: 'O conselho quer o dinheiro em missões, não no banco.', tags: ['budget'], actors: [me.id], importance: 2, icon: 'budget' });
    }
  }
}

// ---------- actions ----------

export const actions = {
  /** Ask the government for emergency funds: cash now, support later. */
  'budget/requestFunds': (state, data, action, ctx) => {
    const f = fin(state);
    const me = state.actors?.[state.playerId];
    if (!me) return { ok: false, error: 'agência não encontrada' };
    if (f.lastFundsTurn != null && state.turn - f.lastFundsTurn < FUNDS_COOLDOWN) {
      return { ok: false, error: `Pedido recente. Tente de novo em ${FUNDS_COOLDOWN - (state.turn - f.lastFundsTurn)} semanas.` };
    }
    const amount = Math.round((me.budget || 0) * 0.06);
    earn(state, state.playerId, amount, 'grants', 'Verba emergencial');
    changeActor(state, state.playerId, 'support', -6);
    changeActor(state, state.playerId, 'reputation', -1);
    f.lastFundsTurn = state.turn;
    addNews(state, { headline: `Agência pede verba emergencial de ${fmtMoney(amount)}`, body: 'O dinheiro sai, mas o governo cobra resultados.', tags: ['budget'], actors: [state.playerId], importance: 2, icon: 'budget' });
    return { ok: true, amount };
  },
};

export const decisionHandlers = {};

// ---------- queries ----------

export function summary(state, actorId = state.playerId) {
  const a = state.actors?.[actorId];
  const f = fin(state);
  if (!a) return { cash: 0, budget: 0, weeklyIncome: 0, weeklyCost: 0, yearSpent: 0, lastYear: null, runwayWeeks: null, debtWeeks: 0 };
  const weeklyIncome = (a.budget || 0) / WEEKS;
  const fixed = ((a.budget || 0) * clamp(a.fixedCostShare ?? DEFAULT_FIXED_SHARE, 0, 1)) / WEEKS;
  let variable = 0;
  if (actorId === state.playerId) {
    const recent = f.ledger.filter((e) => e.amount < 0 && e.turn > state.turn - 9 && e.note !== 'Custos fixos (folha e instalações)');
    variable = -recent.reduce((s, e) => s + e.amount, 0) / 8;
  }
  const weeklyCost = fixed + variable;
  const net = weeklyIncome - weeklyCost;
  const room = (a.cash || 0) + creditLine(state, actorId);
  return {
    cash: a.cash || 0,
    budget: a.budget || 0,
    weeklyIncome,
    weeklyCost,
    weeklyNet: net,
    yearIncome: actorId === state.playerId ? f.year.income : f.rivals[actorId]?.income ?? 0,
    yearSpent: actorId === state.playerId ? sumSpent(f.year.spent) : f.rivals[actorId]?.spent ?? 0,
    spentByCategory: actorId === state.playerId ? { ...f.year.spent } : {},
    lastYear: actorId === state.playerId ? f.lastYear : null,
    history: actorId === state.playerId ? f.history.slice() : [],
    runwayWeeks: net < 0 ? Math.max(0, Math.floor(room / -net)) : null,
    creditLine: creditLine(state, actorId),
    debtWeeks: actorId === state.playerId ? f.debtWeeks : 0,
    fundsAvailableIn: f.lastFundsTurn == null ? 0 : Math.max(0, FUNDS_COOLDOWN - (state.turn - f.lastFundsTurn)),
  };
}

export const queries = {
  'budget/summary': (state, data, actorId) => summary(state, actorId || state.playerId),
  'budget/ledger': (state, data, n = 30) => fin(state).ledger.slice(-n).reverse().map((e) => ({ ...e, label: CATEGORY_LABELS[e.category] || e.category })),
  'budget/categories': () => CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
};

// ---------- 1950–3000 contract (EXPANSION.md §1.5, §3, §10) ----------

/** Weekly ledger, debt streaks and AI spending decisions: the engine substeps this module week by week. */
export const meta = { maxDt: 1 };

/** A new actor (lifecycle birth) gets the same defaults init gives everyone. */
export function onActorBorn(state, data, ctx, id) {
  const a = state.actors?.[id];
  if (!a) return;
  if (!Number.isFinite(a.cash)) a.cash = (a.budget || 0) * 0.25;
  if (!Number.isFinite(a.fixedCostShare)) a.fixedCostShare = DEFAULT_FIXED_SHARE;
}

/** A dead actor leaves the rival totals (its money went with it, or to `into`). */
export function onActorGone(state, data, ctx, id) {
  const f = state.finance;
  if (!f) return;
  if (f.rivals) delete f.rivals[id];
  if (f.rivalsLastYear) delete f.rivalsLastYear[id];
}

/** Caps: ledger 120 (enforced on write), yearly history 60 entries then decade means. */
export function compact(state) {
  const f = state.finance;
  if (!f) return;
  // a 1950–3000 campaign (save budget 400 KB) keeps a third of the ledger
  const cap = Number.isFinite(state.endTurn) && state.endTurn > 520 ? Math.min(LEDGER_CAP, 40) : LEDGER_CAP;
  if (Array.isArray(f.ledger) && f.ledger.length > cap) f.ledger.splice(0, f.ledger.length - cap);
  if (Array.isArray(f.history) && f.history.length > 60) {
    const old = f.history.splice(0, f.history.length - 50);
    const decades = [];
    for (const h of old) {
      const dec = Math.floor(h.year / 10) * 10;
      let d = decades.find((x) => x.year === dec);
      if (!d) decades.push((d = { year: dec, decade: true, n: 0, income: 0, spent: 0, net: 0, cash: 0 }));
      d.n++; d.income += h.income || 0; d.spent += h.spent || 0; d.net += h.net || 0; d.cash = h.cash ?? d.cash;
    }
    for (const d of decades) { d.income /= d.n; d.spent /= d.n; d.net /= d.n; }
    f.history.unshift(...decades);
  }
}

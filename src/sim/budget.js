// Finances of the player and of AI actors (ARCHITECTURE "src/sim/budget.js"). US$ millions everywhere.
// Slice: state.finance (player ledger + yearly totals + rival yearly totals). Actor cash changes via changeActor.

import { addNews, changeActor, log, clamp, player } from '../core/helpers.js';

export const CATEGORIES = ['missions', 'research', 'crew', 'facilities', 'contracts', 'diplomacy', 'grants'];
export const CATEGORY_LABELS = {
  missions: 'Missões',
  research: 'Pesquisa',
  crew: 'Equipe',
  facilities: 'Instalações',
  contracts: 'Contratos',
  diplomacy: 'Diplomacia',
  grants: 'Verba e repasses',
};

const LEDGER_CAP = 300;
const WEEKS = 52;
const DEFAULT_FIXED_SHARE = 0.55;
/** Overdraft allowed (fraction of annual budget) before spend() refuses. */
const CREDIT_LINE = 0.1;
/** Weeks in the red before support starts to bleed. */
const DEBT_GRACE = 6;
/** Weeks in the red after which support 0 means being fired. */
const FIRE_AFTER = 8;
const FUNDS_COOLDOWN = 26;

/** "US$ 1,2 bi" / "US$ 350 mi" */
export function fmtMoney(m) {
  const v = Number(m) || 0;
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1000) return `${sign}US$ ${(Math.round(a / 100) / 10).toString().replace('.', ',')} bi`;
  if (a >= 10) return `${sign}US$ ${Math.round(a)} mi`;
  return `${sign}US$ ${(Math.round(a * 10) / 10).toString().replace('.', ',')} mi`;
}

const yearOf = (state) => (state.startYear ?? 2026) + Math.floor((state.turn || 0) / WEEKS);
const emptyYear = (state) => ({ year: yearOf(state), income: 0, spent: {}, budgetStart: state.actors?.[state.playerId]?.budget ?? 0, cashStart: state.actors?.[state.playerId]?.cash ?? 0 });

function fin(state) {
  if (!state.finance || !Array.isArray(state.finance.ledger)) {
    state.finance = { ledger: [], year: emptyYear(state), lastYear: null, debtWeeks: 0, history: [], rivals: {}, lastFundsTurn: null };
  }
  const f = state.finance;
  f.year = f.year || emptyYear(state);
  f.rivals = f.rivals || {};
  f.history = f.history || [];
  if (!Number.isFinite(f.debtWeeks)) f.debtWeeks = 0;
  return f;
}

export function init(state, data, ctx) {
  // diplomacy's init normally seeds cash = budget*0.25; be defensive if it did not.
  for (const a of Object.values(state.actors || {})) {
    if (!Number.isFinite(a.cash)) a.cash = (a.budget || 0) * 0.25;
    if (!Number.isFinite(a.fixedCostShare)) a.fixedCostShare = DEFAULT_FIXED_SHARE;
  }
  state.finance = { ledger: [], year: emptyYear(state), lastYear: null, debtWeeks: 0, history: [], rivals: {}, lastFundsTurn: null };
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
    if (f.ledger.length > LEDGER_CAP) f.ledger.splice(0, f.ledger.length - LEDGER_CAP);
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
      headline: `Balanço de ${last.year}: entrou ${fmtMoney(last.income)}, saiu ${fmtMoney(last.totalSpent)}`,
      body: `${tone} Maiores gastos: ${parts || 'nenhum'}. Caixa: ${fmtMoney(last.endCash)}. ${budgetLine}${returned > 0 ? (player(state)?.kind === 'company' ? ` Os investidores receberam ${fmtMoney(returned)} do caixa parado.` : ` O tesouro recolheu ${fmtMoney(returned)} de verba parada.`) : ''}`,
      tags: ['budget', 'year'],
      actors: [state.playerId],
      importance: 2,
      icon: 'budget',
    });
  }
}

function aiWeek(state, a) {
  // AI actors pour surplus cash into their programs (abstract spending) and keep a reserve.
  const reserve = (a.budget || 0) * 0.2;
  if ((a.cash || 0) <= reserve) return;
  const s = ((a.cash || 0) - reserve) * 0.06;
  const bold = clamp((a.ai?.aggression ?? 0.5) * 0.5 + 0.35, 0.2, 0.8);
  spend(state, a.id, s * bold, 'missions', 'Programas');
  spend(state, a.id, s * (1 - bold), 'research', 'P&D');
}

function debtWeek(state) {
  const f = fin(state);
  const me = state.actors?.[state.playerId];
  if (!me) return;
  if ((me.cash || 0) < 0) {
    f.debtWeeks += 1;
    if (f.debtWeeks === 1) {
      addNews(state, { headline: 'Caixa da agência no vermelho', body: 'O tesouro cobre por enquanto, mas o governo está de olho.', tags: ['budget'], actors: [state.playerId], importance: 2, icon: 'budget' });
    }
    if (f.debtWeeks >= DEBT_GRACE) {
      const cut = 1 + Math.floor((f.debtWeeks - DEBT_GRACE) / 6);
      changeActor(state, state.playerId, 'support', -cut);
      if (f.debtWeeks === DEBT_GRACE || f.debtWeeks % 12 === 0) {
        addNews(state, { headline: `Dívida prolongada derruba o apoio à agência (${f.debtWeeks} semanas)`, body: 'Parlamentares pedem cortes e a imprensa fala em descontrole.', tags: ['budget', 'politics'], actors: [state.playerId], importance: 3, icon: 'budget' });
      }
    }
    if (f.debtWeeks >= FIRE_AFTER && (me.support ?? 0) <= 0 && !state.gameOver) {
      state.gameOver = { reason: 'fired', turn: state.turn, summary: `Depois de ${f.debtWeeks} semanas no vermelho, o governo perdeu a paciência e trocou a direção da agência.` };
      addNews(state, { headline: 'Direção da agência é demitida', body: state.gameOver.summary, tags: ['budget', 'gameover'], actors: [state.playerId], importance: 3, icon: 'budget' });
      log(state, 'budget: game over (fired)');
    }
  } else if (f.debtWeeks > 0) {
    if (f.debtWeeks >= DEBT_GRACE) addNews(state, { headline: 'Agência sai do vermelho', body: 'O caixa voltou a ficar positivo.', tags: ['budget'], actors: [state.playerId], importance: 1, icon: 'budget' });
    f.debtWeeks = 0;
  }
}

export function tick(state, data, ctx) {
  fin(state);
  // year rollover (politics already adjusted actor.budget earlier in this tick)
  if (state.turn > 0 && state.turn % WEEKS === 0) closeYear(state);
  for (const a of Object.values(state.actors || {})) {
    if (!a || !a.id) continue;
    const budget = Math.max(0, a.budget || 0);
    earn(state, a.id, budget / WEEKS, 'grants', a.kind === 'company' ? 'Receita semanal' : 'Verba semanal');
    charge(state, a.id, (budget * clamp(a.fixedCostShare ?? DEFAULT_FIXED_SHARE, 0, 1)) / WEEKS, 'facilities', 'Custos fixos (folha e instalações)');
    if (a.id !== state.playerId) aiWeek(state, a);
  }
  debtWeek(state);
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

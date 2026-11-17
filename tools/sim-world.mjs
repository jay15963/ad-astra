// World simulation in batch: N seeds x 5 years of economy, politics and tension (GDD Turno 5 "pronto quando").
// Usage: node tools/sim-world.mjs [seeds=20] [--engine] [--player=nasa] [--news]
//   default: isolated harness (only the politics module runs, on actors copied from data/actors.json),
//            so the result does not depend on the other modules being finished.
//   --engine: full engine (all modules), decisions resolved with the first enabled choice, launches auto-played.
//   --news:   print the political headlines of the first seed.
import { loadDataNode } from '../src/core/data.js';
import { createState, newGame, dispatch, resolveDecision } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate, formatTurn } from '../src/core/time.js';
import * as politics from '../src/sim/politics.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const args = process.argv.slice(2);
const nSeeds = Number(args.find((a) => /^\d+$/.test(a)) || 20);
const useEngine = args.includes('--engine');
const showNews = args.includes('--news');
const playerId = (args.find((a) => a.startsWith('--player=')) || '--player=nasa').split('=')[1];

// Fallback actors if data/actors.json is still empty (ids/budgets from ARCHITECTURE.md).
const FALLBACK = [
  ['nasa', 'agency', 'EUA', 9000], ['spacex', 'company', 'EUA', 5000], ['blueorigin', 'company', 'EUA', 2500],
  ['cnsa', 'agency', 'China', 6000], ['isro', 'agency', 'Índia', 1600], ['esa', 'agency', 'Europa', 3500],
  ['roscosmos', 'agency', 'Rússia', 2200], ['jaxa', 'agency', 'Japão', 1500],
].map(([id, kind, country, budget]) => ({ id, name: id, short: id.toUpperCase(), kind, country, budget, support: 60, reputation: 60, culture: 0, prestige: 0, capabilities: { crewed: ['nasa', 'spacex', 'cnsa', 'roscosmos'].includes(id) } }));

const ctxFor = (state, mod) => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, mod, l), date: turnToDate(state.turn, state.startYear) });

/** Politics-only world: minimal actor/relations init (like diplomacy would), then weekly politics ticks. */
function runIsolated(seed) {
  const state = createState(data, { seed, playerId });
  const acts = data.actors?.actors?.length ? data.actors.actors : FALLBACK;
  for (const a of acts) state.actors[a.id] = { ...JSON.parse(JSON.stringify(a)), cash: a.budget * 0.25 };
  for (const r of data.actors?.relations || []) state.relations[r.a < r.b ? `${r.a}|${r.b}` : `${r.b}|${r.a}`] = { trust: r.trust, dependence: r.dependence, rivalry: r.rivalry };
  for (const b of data.actors?.blocs || []) state.blocs[b.id] = JSON.parse(JSON.stringify(b));
  state.treaties = JSON.parse(JSON.stringify(data.actors?.treaties || []));
  politics.init(state, data, ctxFor(state, 'politics'));
  while (state.turn <= state.endTurn) {
    for (const d of state.decisions.slice()) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      state.decisions.splice(state.decisions.indexOf(d), 1);
      politics.decisionHandlers['politics/*'](state, data, d, c?.id, ctxFor(state, 'politics'));
    }
    state.signals = state.signalsPending;
    state.signalsPending = [];
    politics.tick(state, data, ctxFor(state, 'politics'));
    state.turn += 1;
  }
  return state;
}

/** Full engine run (all modules), robust to unfinished modules. */
function runEngine(seed) {
  const state = newGame(data, { seed, playerId });
  let guard = 0;
  while (!state.gameOver && guard++ < 3000) {
    for (const d of state.decisions.slice()) {
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      resolveDecision(state, data, d.id, c?.id);
    }
    let lg = 0;
    while (state.activeLaunch && lg++ < 200) {
      const al = state.activeLaunch;
      if (al.pendingIntervention) dispatch(state, data, { type: 'launch/choose', optionId: al.pendingIntervention.options[0].id });
      else if (al.act === 'prelaunch') dispatch(state, data, { type: 'launch/countdown' });
      else if (al.pendingHold) dispatch(state, data, { type: 'launch/hold', choice: 'go' });
      else if (al.act === 'result') dispatch(state, data, { type: 'launch/finish' });
      else dispatch(state, data, { type: 'launch/step' });
    }
    if (state.activeLaunch) state.activeLaunch = null;
    const r = dispatch(state, data, { type: 'time/advance', weeks: 4, stopOnEvent: false });
    if (!r.ok) throw new Error(r.error);
  }
  return state;
}

const NAMES = Object.fromEntries((data.politics?.nations || []).map((n) => [n.id, n.name]));
const MAIN_PAIRS = ['china|usa', 'russia|usa', 'europe|russia', 'china|india', 'china|japan'];

function trajectory(state, pk) {
  const p0 = state.world.history.tension.filter((h) => h.pair === pk);
  const levels = [];
  for (let y = 0; y <= 5; y++) {
    const t = y * 52;
    const last = [...p0].reverse().find((h) => h.turn < t);
    const first = p0[0];
    levels.push(last ? last.to : first ? first.from : state.world.pairs[pk].level);
  }
  levels[5] = state.world.pairs[pk].level;
  return levels.join('→');
}

const summaries = [];
let failures = 0;
for (let s = 1; s <= nSeeds; s++) {
  const seed = s * 7919;
  let state;
  try {
    state = useEngine ? runEngine(seed) : runIsolated(seed);
  } catch (e) {
    failures++;
    console.error(`FAIL seed=${seed}: ${e.stack || e.message}`);
    if (!useEngine) continue;
    try { state = runIsolated(seed); console.error('  (refeito em modo isolado)'); } catch (e2) { console.error(`  isolado também falhou: ${e2.message}`); continue; }
  }
  const w = state.world;
  const sy = state.startYear;
  const pol = state.news.filter((n) => n.tags?.includes('politics'));
  const perMonth = {};
  for (const n of pol) { const k = formatTurn(n.turn, sy); perMonth[k] = (perMonth[k] || 0) + 1; }
  const maxMonth = Math.max(0, ...Object.values(perMonth));
  const crises = w.history.crises.map((c) => `${NAMES[c.nation]}:${data.politics.crises[c.type]?.label}@${formatTurn(c.turn, sy)}`);
  const elections = w.history.elections.filter((e) => e.kind !== 'budget_summit').map((e) => `${e.id.replace(/_20\d\d$/, '')}=${e.result === 'change' ? 'MUDA' : e.result === 'continuity' ? 'mantém' : e.result}`);
  const budgets = Object.keys(state.actors).map((id) => {
    const b0 = w.baseBudget[id] ?? state.actors[id].budget;
    return `${id} ${Math.round(b0)}→${Math.round(state.actors[id].budget)}`;
  });
  const conflicts = w.conflicts.map((c) => `${c.names?.join?.('–') || c.nations.map((n) => NAMES[n]).join('–')} ${c.place} (pico ${c.peak}, ${formatTurn(c.startTurn, sy)}${c.endTurn != null ? '–' + formatTurn(c.endTurn, sy) : ', ativo'})`);
  const minBudget = Math.min(...Object.values(state.actors).map((a) => a.budget));
  const tensions = Object.values(state.tension);
  const bad = minBudget <= 0 || tensions.some((t) => t < 0 || t > 4 || !Number.isInteger(t));
  if (bad) failures++;
  console.log(`\n=== seed ${seed}${bad ? '  [INVARIANTE VIOLADA]' : ''} ===`);
  console.log(`  tensão (fim de ano 2026..2030): ${MAIN_PAIRS.map((k) => `${k.split('|').map((n) => NAMES[n]).join('–')} ${trajectory(state, k)}`).join(' | ')}`);
  console.log(`  tensão global final ${w.globalTension} · mudanças ${w.history.tension.length} · conflitos: ${conflicts.join('; ') || 'nenhum'}`);
  console.log(`  crises (${crises.length}): ${crises.join(', ') || 'nenhuma'}`);
  console.log(`  eleições: ${elections.join(', ')}`);
  console.log(`  verbas: ${budgets.join(', ')}`);
  console.log(`  eventos: ${w.history.events.length} · notícias políticas ${pol.length} (máx ${maxMonth}/mês) · decisões politics ${state.stats['politics.decisions'] || 0}`);
  summaries.push({
    seed, sig: MAIN_PAIRS.map((k) => trajectory(state, k)).join('/') + '#' + elections.join(','),
    conflicts: w.conflicts.length, wars: w.conflicts.filter((c) => c.peak >= 4).length, crises: crises.length, maxMonth, newsPerMonth: pol.length / 60,
    budgetSig: budgets.join(','),
  });
  if (showNews && s === 1) {
    console.log('\n  --- manchetes políticas (seed 1, mais antigas primeiro) ---');
    for (const n of pol.slice().reverse()) console.log(`  ${formatTurn(n.turn, sy).padEnd(9)} [${n.importance}] ${n.headline}`);
  }
}

const distinct = new Set(summaries.map((x) => x.sig)).size;
const avg = (k) => (summaries.reduce((s, x) => s + x[k], 0) / Math.max(1, summaries.length)).toFixed(2);
console.log(`\n=== resumo: ${summaries.length} mundos, ${distinct} trajetórias distintas, ${new Set(summaries.map((x) => x.budgetSig)).size} perfis de verba distintos`);
console.log(`    média por mundo: ${avg('conflicts')} conflitos regionais, ${avg('wars')} guerras abertas, ${avg('crises')} crises econômicas, ${avg('newsPerMonth')} notícias políticas/mês (pior mês ${Math.max(...summaries.map((x) => x.maxMonth))})`);
console.log(`    modo: ${useEngine ? 'motor completo' : 'isolado (só politics)'} · falhas: ${failures}`);
process.exitCode = failures ? 1 : 0;

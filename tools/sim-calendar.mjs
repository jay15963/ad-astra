// Living calendar batch simulation: N seeds x 5 years. Prints when each mission really launches
// (min / median / max over seeds), how it ends, who wins each "first", and background launch totals.
// Usage: node tools/sim-calendar.mjs [seeds=20] [--player=<actorId>] [--engine]
//   default: runs only the calendar module (isolated from other modules, like the real tick order/ctx)
//   --engine: runs the full engine (all modules) and reads the calendar slice.
import { loadDataNode } from '../src/core/data.js';
import { createState, newGame, tick as engineTick } from '../src/core/engine.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate, formatTurn } from '../src/core/time.js';
import * as calendar from '../src/sim/calendar.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const args = process.argv.slice(2);
const nSeeds = Number(args.find((a) => /^\d+$/.test(a)) || 20);
const playerId = (args.find((a) => a.startsWith('--player=')) || '').split('=')[1] || 'spectator';
const useEngine = args.includes('--engine');

function runStandalone(seed) {
  const state = createState(data, { seed, playerId });
  const ctxFor = () => ({ data, rng: (label = '') => rngFor(state.seed, state.turn, 'calendar', label), date: turnToDate(state.turn, state.startYear) });
  calendar.init(state, data, ctxFor());
  while (state.turn <= state.endTurn) {
    state.signals = state.signalsPending;
    state.signalsPending = [];
    calendar.tick(state, data, ctxFor());
    state.turn++;
  }
  return state;
}

function runEngine(seed) {
  const state = newGame(data, { seed, playerId: playerId === 'spectator' ? data.scenario.playableActors[0] : playerId });
  while (!state.gameOver) {
    state.decisions.length = 0; // spectator: ignore player decisions
    state.activeLaunch = null;
    engineTick(state, data);
  }
  return state;
}

const sy = data.scenario.startYear;
const fmt = (t) => (t == null ? '   -   ' : formatTurn(t, sy).padEnd(8));
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

const per = {}; // id -> {launch: [], delays: [], status: {}}
const firsts = {};
const bg = {};
let news = 0;
for (let s = 1; s <= nSeeds; s++) {
  const seed = s * 104729;
  const state = useEngine ? runEngine(seed) : runStandalone(seed);
  news += state.news.length;
  for (const inst of state.calendar) {
    const p = (per[inst.id] = per[inst.id] || { launch: [], delays: [], status: {}, planned: inst.plannedTurn });
    const launched = inst.history.find((h) => h.phase === 'ascent' || h.vehicleOk === false)?.turn ?? inst.history[0]?.turn ?? null;
    if (launched != null) { p.launch.push(launched); p.delays.push(launched - inst.plannedTurn); }
    const key = inst.history.length && inst.status === 'planned' ? 'refly' : inst.status;
    p.status[key] = (p.status[key] || 0) + 1;
  }
  for (const [m, f] of Object.entries(state.firsts)) {
    firsts[m] = firsts[m] || {};
    firsts[m][f.actorId] = (firsts[m][f.actorId] || 0) + 1;
  }
  for (const [v, st] of Object.entries(state.vehicleStats)) {
    const b = (bg[v] = bg[v] || { flights: 0, failures: 0 });
    b.flights += st.gameFlights || 0;
    b.failures += (st.failures || 0) - (data.index.vehicles[v]?.history?.failures || 0);
  }
}

console.log(`\nCalendário vivo — ${nSeeds} sementes, ${useEngine ? 'motor completo' : 'módulo isolado'}, jogador: ${playerId}\n`);
console.log('missão'.padEnd(28), 'plano    ', 'mín      ', 'mediana  ', 'máx      ', 'voou', 'atraso méd', ' resultados');
const order = data.calendar.missions.slice().sort((a, b) => per[a.id].planned - per[b.id].planned);
for (const item of order) {
  const p = per[item.id];
  const n = p.launch.length;
  const avgDelay = n ? (p.delays.reduce((a, b) => a + b, 0) / n / 4.33).toFixed(1) + ' m' : '   -';
  const res = Object.entries(p.status).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(item.id.padEnd(28), fmt(p.planned), fmt(n ? Math.min(...p.launch) : null), fmt(median(p.launch)), fmt(n ? Math.max(...p.launch) : null),
    String(n).padStart(4), avgDelay.padStart(10), ' ', res);
}
console.log('\nOs Primeiros (quem levou, em quantas sementes):');
for (const [m, by] of Object.entries(firsts).sort()) console.log('  ', m.padEnd(36), Object.entries(by).map(([a, c]) => `${a} ${c}`).join(', '));
console.log('\nVoos no jogo (total nas sementes, média por semente):');
for (const [v, b] of Object.entries(bg).sort((a, b) => b[1].flights - a[1].flights)) {
  if (!b.flights) continue;
  console.log('  ', v.padEnd(16), `${(b.flights / nSeeds).toFixed(1).padStart(6)} voos  ${(b.failures / nSeeds).toFixed(2).padStart(5)} falhas`);
}
console.log(`\nNotícias por semente (todas as fontes): ${(news / nSeeds).toFixed(0)}`);

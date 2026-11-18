#!/usr/bin/env node
// Headless campaign 1950 → 3000 the way a phone plays it: data packs are loaded LAZILY (core + legacy + the current
// era, the previous one and the next one past 85%; at most 3 era packs in memory) through src/core/data.js
// ensurePacks/packsNeeded, so the run proves the data pipeline end to end. Complements tools/campaign.mjs (core-time,
// eager packs, era-by-era invariants).
//
// Usage: node tools/full-campaign.mjs [seed=7919] [--actor nasa] [--eager] [--compare-eager] [--to e3] [--quiet]
//   --eager          load every pack up front (Node default) instead of lazily
//   --compare-eager  play the same seed twice (lazy and eager) and require identical saves (determinism rule §4.2)
//   --to eN          stop when the game leaves era eN
// Prints per era: turns, total and per-turn ms, p99 tick, save KB at the end of the era and the largest save at a
// year boundary, era packs in memory and data size. Exit 1 on any error (crash, stuck, NaN, save over 400 KB).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData, nodeReader, ensurePacks, packsNeeded, erasLoaded } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAVE_BUDGET_KB = 400;

/**
 * The Phase B bot (tools/bot-b.mjs: investor rounds, mandates, Hangar designs, test flights) over the shared bot of
 * tools/golden.mjs when present, else a minimal one with the same rules.
 */
async function loadBot() {
  try {
    const b = await import('./bot-b.mjs');
    const mem = {};
    if (typeof b.phaseBStep === 'function') return (state, data) => b.phaseBStep(state, data, engine, { schedule: true, keepControl: true }, mem);
  } catch { /* bot-b.mjs not available */ }
  try {
    const m = await import('./golden.mjs');
    if (typeof m.botStep === 'function') return (state, data) => m.botStep(state, data, engine, { schedule: true });
  } catch { /* golden.mjs not available */ }
  return (state, data) => {
    for (const d of state.decisions.slice()) {
      if (state.gameOver) return;
      const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
      engine.dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    }
    let guard = 0;
    while (state.activeLaunch && guard++ < 200) {
      const al = state.activeLaunch;
      if (al.pendingIntervention) engine.dispatch(state, data, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
      else if (al.act === 'prelaunch') engine.dispatch(state, data, { type: 'launch/countdown' });
      else if (al.pendingHold) engine.dispatch(state, data, { type: 'launch/hold', choice: 'go' });
      else if (al.act === 'result') engine.dispatch(state, data, { type: 'launch/finish' });
      else engine.dispatch(state, data, { type: 'launch/step' });
    }
  };
}

const yearOfState = (s) => s.startYear + Math.floor(s.turn / 52);
const eraNum = (id) => Number(String(id || '').slice(1)) || 0;
const pct = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

/**
 * Play one campaign. Returns {state, eras:[…], errors, totalMs, lazy}.
 * @param {{seed?:number, playerId?:string, eager?:boolean, toEra?:string|null, log?:(line:string)=>void}} opts
 */
export async function runFullCampaign({ seed = 7919, playerId = 'nasa', eager = false, toEra = null, log = () => {} } = {}) {
  const reader = await nodeReader(ROOT);
  const data = await loadData(reader, { scenarioId: 'campaign', eras: eager ? 'all' : 'auto' });
  const bot = await loadBot();
  const errors = [];
  if (data.scenario?.id !== 'campaign') errors.push('o carregador não abriu a campanha');
  let state = engine.newGame(data, { seed, playerId });
  const eras = [];
  let cur = null;
  let maxPacks = erasLoaded(data).length;
  const open = () => {
    cur = { eraId: state.clock?.eraId ?? '?', fromYear: yearOfState(state), turns: 0, ms: 0, ticks: [], maxSaveKB: 0, packs: 0, dataKB: 0 };
  };
  const close = () => {
    const json = engine.serialize(state);
    Object.assign(cur, {
      toYear: yearOfState(state), saveKB: Math.round(json.length / 1024), packs: erasLoaded(data).length,
      dataKB: Math.round(JSON.stringify(data).length / 1024), p99: pct(cur.ticks, 0.99),
    });
    delete cur.ticks;
    eras.push(cur);
    log(`  ${cur.eraId} ${cur.fromYear}–${cur.toYear}: ${cur.turns} turnos, ${cur.ms} ms (${(cur.ms / Math.max(1, cur.turns)).toFixed(1)} ms/turno, p99 ${cur.p99} ms), ` +
      `save ${cur.saveKB} KB (máx. ano ${cur.maxSaveKB} KB), pacotes de era ${erasLoaded(data).join('+')}, dados ${cur.dataKB} KB`);
    return json;
  };
  open();
  const t0 = Date.now();
  let lastYear = -1;
  let guard = 0;
  while (!state.gameOver && guard++ < 20000) {
    // lazy packs: what the store does on a phone (ensureEra) before the step that needs them
    const year = yearOfState(state);
    const blocked = engine.isBlocked(state, data);
    if (year !== lastYear || blocked === 'needsData') {
      const want = packsNeeded(state, data);
      const pending = state.clock?.pendingEra?.to;
      if (pending && !want.includes(pending)) want.push(pending);
      if (!eager) await ensurePacks(data, reader, want, { prune: true });
      maxPacks = Math.max(maxPacks, erasLoaded(data).length);
      if (year !== lastYear && lastYear >= 0) {
        const kb = Math.round(engine.serialize(state).length / 1024);
        cur.maxSaveKB = Math.max(cur.maxSaveKB, kb);
        if (kb > SAVE_BUDGET_KB) errors.push(`save com ${kb} KB em ${year} (limite ${SAVE_BUDGET_KB} KB)`);
      }
      lastYear = year;
    }
    // era boundary: close the row, save/load round trip, continue
    if (state.clock?.pendingEra && cur.eraId === state.clock.pendingEra.from) {
      const { from, to } = state.clock.pendingEra;
      const json = close();
      const back = engine.deserialize(json, data);
      if (engine.serialize(back) !== json) errors.push(`save/load diferente na transição ${from}→${to}`);
      state = back;
      if (toEra && eraNum(to) > eraNum(toEra)) { cur = null; break; }
      open();
      cur.eraId = to;
    }
    try { bot(state, data); } catch (e) { errors.push(`bot t${state.turn}: ${e.message}`); break; }
    if (state.gameOver) break;
    if (engine.isBlocked(state, data) === 'needsData') continue;
    const ts = performance.now();
    const r = engine.dispatch(state, data, { type: 'time/advance', turns: 1 });
    const dt = Math.round(performance.now() - ts);
    if (!r.ok) { errors.push(`advance t${state.turn}: ${r.error}`); break; }
    if (r.advanced) { cur.turns++; cur.ms += dt; cur.ticks.push(dt); }
    else if (!state.gameOver && !state.decisions.length && !state.clock?.pendingEra && engine.isBlocked(state, data) !== 'needsData') {
      errors.push(`travado em t${state.turn}: ${r.stoppedBy}`);
      break;
    }
    for (const [id, a] of Object.entries(state.actors || {})) {
      for (const k of ['cash', 'budget', 'prestige']) if (k in a && !Number.isFinite(a[k])) { errors.push(`NaN em ${id}.${k} (t${state.turn})`); guard = Infinity; }
    }
  }
  if (cur) close();
  if (!eager && maxPacks > 3) errors.push(`${maxPacks} pacotes de era na memória ao mesmo tempo (limite 3)`);
  const logErr = (state.log || []).filter((l) => String(l).includes('erro'));
  if (logErr.length) errors.push(`erros no log: ${logErr.slice(0, 3).join(' | ')}`);
  return { state, eras, errors, totalMs: Date.now() - t0, lazy: !eager, maxPacks, hash: engine.serialize(state) };
}

async function main(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const seed = Number(argv.find((a) => /^\d+$/.test(a)) || 7919);
  const playerId = opt('--actor') || 'nasa';
  const toEra = opt('--to');
  const quiet = argv.includes('--quiet');
  const log = quiet ? () => {} : (l) => console.log(l);
  const runs = argv.includes('--compare-eager') ? [false, true] : [argv.includes('--eager')];
  let failed = false;
  const results = [];
  for (const eager of runs) {
    console.log(`Campanha 1950→3000, ${playerId}, seed ${seed}, pacotes ${eager ? 'todos de uma vez' : 'sob demanda'}:`);
    const r = await runFullCampaign({ seed, playerId, eager, toEra, log });
    results.push(r);
    const s = r.state;
    const end = s.gameOver ? `${s.gameOver.reason}${s.gameOver.ending ? `/${s.gameOver.ending}` : ''}` : 'sem fim';
    const turns = r.eras.reduce((a, e) => a + e.turns, 0);
    console.log(`${r.errors.length ? 'FALHA' : 'ok'}: ${turns} turnos em ${(r.totalMs / 1000).toFixed(1)} s, ano ${yearOfState(s)}, fim ${end}, ` +
      `save final ${Math.round(r.hash.length / 1024)} KB, máx. ${r.maxPacks} pacotes de era na memória`);
    for (const e of r.errors.slice(0, 8)) console.log(`  - ${e}`);
    if (r.errors.length) failed = true;
  }
  if (results.length === 2) {
    // state.dataPacks records which packs were merged (metadata, legitimately different): compare everything else
    const sim = (json) => { const s = JSON.parse(json); delete s.dataPacks; return JSON.stringify(s); };
    const same = sim(results[0].hash) === sim(results[1].hash);
    console.log(same ? 'Determinismo: sob demanda = todos de uma vez (saves idênticos).' : 'FALHA: o resultado depende dos pacotes carregados.');
    if (!same) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

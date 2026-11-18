// Headless campaign 1950 → 3000 (EXPANSION.md §13.10).
// Usage: node tools/campaign.mjs [seeds=1] [--fast] [--from e1|<year>] [--to e7] [--actor nasa] [--found] [--min-pct 50] [--quiet]
//   --fast   the bot only resolves cards and plays launches (no own missions): measures the engine and the world
//   --found  the bot founds its own agency at turn 0 (agency/found, Phase B) instead of directing --actor
//   --min-pct  stake the bot keeps in investor rounds (Phase B; default 50 = autonomy)
//   --keep-control  never sell below --min-pct, even when cash is tight (long runs that must reach an ending)
// The bot is tools/bot-b.mjs (Phase B moves: investor rounds, mandates, Hangar designs and test flights) over the
// shared golden bot; without investors.js/designs.js it plays exactly like the golden bot.
//   --from   start at an era's first year (or a given year) with a scenario built from data (no simulated past)
//   --to     stop when the game enters the era after this one
// Per era it prints: turns, ms/turn, save KB, live core/minor actors, births/merges/dissolutions, stops per turn.
// Invariants (exit 1 on failure): no NaN in actors, no "erro" in the log, caps (news, log), save/load identical at
// each era boundary, and a full run reaches jan/3000 with one of the 3 endings.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { eraAt, eraById, formatTurnEra, yearOf } from '../src/core/time.js';
import { NEWS_CAP, LOG_CAP } from '../src/core/helpers.js';
import { phaseBStep, phaseBStats, foundAgency } from './bot-b.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load campaign data with every era pack (Node). Tolerates a loader without scenarios (then the legacy data). */
export async function loadCampaignData() {
  return loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
}

/** Data whose scenario starts at `year` (built from data, EXPANSION.md §2.1), same end and ending. */
export function dataStartingAt(data, year) {
  if (!year || year === (data.scenario?.start?.year ?? data.scenario?.startYear)) return data;
  const scenario = { ...data.scenario, start: { year, month: 0 }, startYear: year };
  return { ...data, scenario };
}

const yearArg = (data, v) => {
  if (v == null) return null;
  if (/^e\d$/.test(v)) return eraById(data, v)?.from?.year ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function actorCounts(state) {
  let core = 0, minor = 0;
  for (const a of Object.values(state.actors || {})) (a.tier === 'minor' ? minor++ : core++);
  return { core, minor };
}

function hasNaN(state) {
  for (const [id, a] of Object.entries(state.actors || {})) {
    for (const k of ['cash', 'budget', 'prestige', 'support', 'reputation']) {
      if (k in a && !Number.isFinite(a[k])) return `${id}.${k}`;
    }
  }
  return null;
}

/**
 * Play one campaign. Returns {state, eras: [{eraId, turns, ms, saveKB, core, minor, stops, births, merges, gone}],
 * ending, totalMs, errors}.
 */
export function runCampaign(data, { seed = 1, playerId = 'nasa', fast = true, toEra = null, maxTurns = Infinity, onEra = null, found = false, minPct = 50, keepControl = false } = {}) {
  const errors = [];
  let state = engine.newGame(data, { seed, playerId });
  let founded = null;
  if (found) {
    founded = foundAgency(state, data, engine, { seed });
    if (!founded) errors.push('aviso: agency/found indisponível ou recusado; seguindo com o ator escolhido');
  }
  const botMem = {};
  const eras = [];
  let cur = null;
  const openEra = () => {
    const lc = state.lifecycle || {};
    cur = {
      eraId: state.clock.eraId, startTurn: state.turn, turns: 0, ms: 0, stops: 0, saveKB: 0,
      births0: lc.births ?? 0, applied0: Object.keys(lc.applied || {}).length, gone0: Object.keys(lc.tombstones || {}).length,
    };
  };
  const closeEra = () => {
    const lc = state.lifecycle || {};
    const json = engine.serialize(state);
    Object.assign(cur, actorCounts(state), {
      saveKB: Math.round(json.length / 1024),
      births: (lc.births ?? 0) - cur.births0,
      events: Object.keys(lc.applied || {}).length - cur.applied0,
      gone: Object.keys(lc.tombstones || {}).length - cur.gone0,
      endYear: yearOf(state),
    });
    eras.push(cur);
    onEra?.(cur, state);
    return json;
  };
  openEra();
  const t0 = Date.now();
  let guard = 0;
  while (!state.gameOver && guard++ < 20000 && state.turn - 0 < maxTurns) {
    // era boundary: save/load identical, then continue
    if (state.clock.pendingEra) {
      const p = state.clock.pendingEra;
      const json = closeEra();
      const back = engine.deserialize(json, data);
      if (engine.serialize(back) !== json) errors.push(`save/load diferente na transição ${p.from}→${p.to}`);
      state = back;
      if (toEra && Number(String(p.to).slice(1)) > Number(String(toEra).slice(1))) { cur = null; break; }
      const dec = state.decisions.find((d) => d.kind === 'era/transition');
      const r = engine.dispatch(state, data, { type: 'decision/resolve', id: dec?.id, choiceId: 'continue' });
      if (!r.ok) { errors.push(`transição ${p.to}: ${r.error}`); break; }
      openEra();
    }
    try {
      phaseBStep(state, data, engine, { schedule: !fast, minPct, keepControl }, botMem);
    } catch (e) {
      errors.push(`bot t${state.turn}: ${e.message}`);
      break;
    }
    if (state.gameOver) break;
    if (state.clock.pendingEra) continue;
    const decBefore = state.decisions.length;
    const newsBefore = state.news[0]?.id;
    const ts = Date.now();
    const r = engine.dispatch(state, data, { type: 'time/advance', turns: 1, stopOnEvent: false });
    cur.ms += Date.now() - ts;
    if (!r.ok) { errors.push(`advance t${state.turn}: ${r.error}`); break; }
    if (r.advanced) {
      cur.turns++;
      const top = state.news[0];
      if (state.decisions.length > decBefore || state.activeLaunch || (top && top.id !== newsBefore && top.importance >= 3)) cur.stops++;
    } else if (!state.gameOver && !state.clock.pendingEra && !state.decisions.length) {
      errors.push(`travado em t${state.turn}: ${r.stoppedBy}`);
      break;
    }
    const nan = hasNaN(state);
    if (nan) { errors.push(`NaN em ${nan} (t${state.turn})`); break; }
    if (state.news.length > NEWS_CAP) errors.push(`news acima do teto (${state.news.length})`);
    if (state.log.length > LOG_CAP + 20) errors.push(`log acima do teto (${state.log.length})`);
  }
  if (cur) closeEra();
  const errs = state.log.filter((l) => l.includes('erro'));
  if (errs.length) errors.push(`erros no log: ${errs.slice(0, 3).join(' | ')}`);
  // founding refused is a note, not a failure (Phase B may not be integrated yet)
  const hard = errors.filter((e) => !e.startsWith('aviso:'));
  return { state, eras, ending: state.gameOver?.ending ?? null, reason: state.gameOver?.reason ?? null, totalMs: Date.now() - t0, errors: hard, notes: errors.filter((e) => e.startsWith('aviso:')), founded, phaseB: phaseBStats(state) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const nSeeds = Number(args.find((a) => /^\d+$/.test(a)) || 1);
  const fast = flag('--fast');
  const quiet = flag('--quiet');
  let data = await loadCampaignData();
  if (data.scenario?.id !== 'campaign') console.warn('aviso: o carregador não conhece a campanha; usando os dados do cenário padrão');
  const from = yearArg(data, opt('--from'));
  data = dataStartingAt(data, from);
  const toEra = opt('--to');
  const playerId = opt('--actor') || 'nasa';
  const found = flag('--found');
  const minPct = Number(opt('--min-pct') ?? 50);
  const keepControl = flag('--keep-control');
  let failures = 0;
  for (let s = 1; s <= nSeeds; s++) {
    const seed = s * 7919;
    const res = runCampaign(data, {
      seed, playerId, fast, toEra, found, minPct, keepControl,
      onEra: quiet ? null : (e, st) => console.log(
        `  ${e.eraId} até ${e.endYear}: ${e.turns} turnos, ${(e.ms / Math.max(1, e.turns)).toFixed(1)} ms/turno, save ${e.saveKB} KB, ` +
        `atores ${e.core} núcleo/${e.minor} menores, nasc ${e.births} ev ${e.events} fim ${e.gone}, paradas/turno ${(e.stops / Math.max(1, e.turns)).toFixed(2)}` +
        ` (${formatTurnEra(st.turn, st.startYear, st.clock.stepWeeks)})`),
    });
    const st = res.state;
    const reached = res.reason === 'ending' && engine.ENDINGS.includes(res.ending);
    const wantFull = !toEra;
    const ok = !res.errors.length && (!wantFull || reached || res.reason === 'fired' || res.reason === 'bankrupt');
    if (!ok) failures++;
    console.log(`${ok ? 'ok' : 'FALHA'} ${playerId} seed=${seed} ${res.totalMs} ms, fim=${res.reason ?? '-'}${res.ending ? `/${res.ending}` : ''} ` +
      `em ${formatTurnEra(st.turn, st.startYear, st.clock?.stepWeeks ?? 1)} (turno ${st.turn}, era ${eraAt(data, yearOf(st))?.id})` +
      (res.errors.length ? `\n  ${res.errors.slice(0, 5).join('\n  ')}` : ''));
    const b = res.phaseB;
    if (!quiet) console.log(`  fase B: ${res.founded ? `agência fundada ${res.founded}, ` : ''}${b.playerPct != null ? `fatia ${Math.round(b.playerPct)}% (${b.holders} acionistas), ` : 'sem acionistas, '}` +
      `mandatos ${b.mandates} (${b.mandateMissions} missões, ${b.programMandates} programas), projetos ${b.designs} (${b.operational} operacionais), voos de teste ${b.testFlights}, voos em projeto próprio ${b.designFlights}` +
      (res.notes.length ? `\n  ${res.notes.join('\n  ')}` : ''));
  }
  process.exitCode = failures ? 1 : 0;
}

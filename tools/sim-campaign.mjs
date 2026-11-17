// Campaign bot with a reasonable strategy: plays full 2026-2030 campaigns as each playable actor and prints
// balance metrics (missions flown, successes, firsts, rank, cash, deaths, news, decisions) plus rival milestones.
// Usage: node tools/sim-campaign.mjs [seeds=3] [actor=all] [--verbose] [--quiet]
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query, serialize, deserialize } from '../src/core/engine.js';
import { formatTurn } from '../src/core/time.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));
const nSeeds = Number(pos[0] || 3);
const actorArg = pos[1] || 'all';
const actors = actorArg === 'all' ? data.scenario.playableActors : [actorArg];
const VERBOSE = flags.has('--verbose');
const QUIET = flags.has('--quiet');

const q = (state, name, ...a) => { try { return query(state, data, name, ...a); } catch { return undefined; } };
const fmtM = (m) => (Math.abs(m) >= 1000 ? `${(m / 1000).toFixed(1)}bi` : `${Math.round(m)}mi`);

// Custom mission menu the bot tries when it has money and few missions in the pipeline (type, destination).
const CUSTOM = [
  ['satellite', 'sso'], ['satellite', 'gto'], ['probe', 'lunar_orbit'], ['lander', 'lunar_surface'], ['lander', 'lunar_south_pole'],
  ['probe', 'mars_orbit'], ['lander', 'mars_surface'], ['crewed', 'leo'], ['crewed', 'lunar_orbit'], ['cargo', 'iss'], ['probe', 'cislunar'],
  ['crewed', 'lunar_south_pole'], ['crewed', 'lunar_surface'],
];

function playerCash(state) { return state.actors[state.playerId]?.cash ?? 0; }

/** Pick a decision choice like a sensible player. */
function choose(state, d) {
  const ids = (d.choices || []).filter((c) => !c.disabled).map((c) => c.id);
  const has = (id) => ids.includes(id);
  const cash = playerCash(state);
  if (d.kind === 'briefing') {
    const planning = state.missions.filter((m) => m.status === 'planning').length;
    if (d.payload?.kind === 'calendar') return has('accept') ? 'accept' : ids[0];
    const draft = d.payload?.draft;
    const opts = draft ? q(state, 'missions/draftOptions', draft) : null;
    const cost = opts?.cost?.total ?? Infinity;
    if (has('accept') && planning < 3 && cost < cash * 0.3 && !savingForProgram(state)) return 'accept';
    return has('decline') ? 'decline' : ids[ids.length - 1];
  }
  if (d.kind === 'contract/offer') return has('bid_mid') ? 'bid_mid' : 'pass';
  if (d.kind === 'launch/ready') return has('go') ? 'go' : ids[0];
  if (d.kind === 'diplomacy/proposal') return has('accept') ? 'accept' : ids[0];
  if (d.defaultChoice && has(d.defaultChoice)) return d.defaultChoice;
  return ids[0] ?? d.choices?.[0]?.id;
}

/** Fix and schedule missions in planning. */
function manageMissions(state, m, stats) {
  for (const mis of state.missions.filter((x) => x.status === 'planning')) {
    let opts = q(state, 'missions/draftOptions', { ...mis, missionId: mis.id });
    if (!opts) continue;
    if (!opts.valid) {
      // try a valid vehicle / spacecraft combination
      const patch = {};
      // program hardware (calendar): wait for the planned rocket for a year before swapping it
      const patient = mis.calendarId && state.turn - mis.createdTurn < 52;
      if (!patient && opts.vehicles?.length && !opts.vehicles.find((v) => v.selected)?.valid) {
        const v = opts.vehicles.find((x) => x.valid);
        if (v) patch.vehicleId = v.id;
      }
      if (!mis.clientPayload && opts.spacecraft?.length && !opts.spacecraft.find((s) => s.selected)?.valid) {
        const s = opts.spacecraft.find((x) => x.valid);
        if (s) patch.spacecraftId = s.id;
      }
      // crew unavailable or busy: pick free people again
      if (opts.errors.some((e) => /dispon|escalad|comandante|Diretor/i.test(e))) {
        const fd = opts.crew.flightDirector.slice().sort((a, b) => b.skill - a.skill)[0];
        const astros = (opts.crew.commander || []).filter((p) => !p.busy).sort((a, b) => b.skill - a.skill);
        patch.crew = { flightDirector: fd?.id || null, commander: mis.crewed ? astros[0]?.id || null : null, astronauts: mis.crewed ? astros.slice(1, opts.seats).map((p) => p.id) : [] };
      }
      if (Object.keys(patch).length) dispatch(state, data, { type: 'mission/update', missionId: mis.id, patch });
      opts = q(state, 'missions/draftOptions', { ...mis, missionId: mis.id });
    }
    const target = Math.max(opts.earliestLaunchTurn ?? state.turn, mis.targetTurn ?? 0);
    const r = dispatch(state, data, { type: 'mission/schedule', missionId: mis.id, launchTurn: target });
    if (!r.ok) {
      const r2 = dispatch(state, data, { type: 'mission/schedule', missionId: mis.id });
      if (!r2.ok) {
        stats.scheduleErrors[r2.error] = (stats.scheduleErrors[r2.error] || 0) + 1;
        // hopeless after a long time in planning: cancel
        if (state.turn - mis.createdTurn > 40 && !mis.calendarId) dispatch(state, data, { type: 'mission/cancel', missionId: mis.id });
      }
    }
  }
}

/** Start an own mission when the pipeline is thin and cash is healthy. */
/** A program mission is waiting for money: hold discretionary spending. */
function savingForProgram(state) {
  return state.missions.some((m) => m.status === 'planning' && m.calendarId && (m.cost || 0) > playerCash(state));
}

function customMission(state, stats, rngIdx) {
  if (savingForProgram(state)) return;
  const active = state.missions.filter((x) => ['planning', 'scheduled', 'launch'].includes(x.status)).length;
  const budget = state.actors[state.playerId].budget;
  if (active >= 3 || playerCash(state) < budget * 0.25) return;
  for (let k = 0; k < CUSTOM.length; k++) {
    const [type, destination] = CUSTOM[(rngIdx + k) % CUSTOM.length];
    const opts = q(state, 'missions/draftOptions', { type, destination, crewed: type === 'crewed' });
    if (!opts) continue;
    const sc = opts.spacecraft.find((s) => s.valid);
    if (!sc) continue;
    let draft = { type, destination, crewed: type === 'crewed', spacecraftId: sc.id };
    const o2 = q(state, 'missions/draftOptions', draft);
    const v = o2?.vehicles.find((x) => x.valid && x.reliability.band !== 'experimental') || o2?.vehicles.find((x) => x.valid);
    if (!v) continue;
    draft.vehicleId = v.id;
    const o3 = q(state, 'missions/draftOptions', draft);
    const fd = o3.crew.flightDirector.slice().sort((a, b) => b.skill - a.skill)[0];
    const astros = o3.crew.commander.filter((p) => !p.busy).sort((a, b) => b.skill - a.skill);
    draft.crew = { flightDirector: fd?.id || null, commander: draft.crewed ? astros[0]?.id || null : null, astronauts: draft.crewed ? astros.slice(1, o3.seats).map((p) => p.id) : [] };
    const o4 = q(state, 'missions/draftOptions', draft);
    if (!o4?.valid || o4.cost.total > playerCash(state) * 0.4) continue;
    const r = dispatch(state, data, { type: 'mission/create', draft });
    if (r.ok) { stats.custom++; return; }
  }
}

function manageResearch(state) {
  const tree = q(state, 'research/tree') || [];
  const active = tree.filter((n) => n.status === 'active').length;
  if (active >= 2) return;
  const avail = tree.filter((n) => n.status === 'available' && n.canAffordScience !== false).sort((a, b) => (a.science ?? 0) - (b.science ?? 0));
  for (const n of avail.slice(0, 3)) {
    const r = dispatch(state, data, { type: 'research/start', nodeId: n.id, approach: 'safe' });
    if (r.ok) return;
  }
}

function manageCrew(state) {
  if (state.turn % 8 !== 0) return;
  const roster = Object.values(state.crew).filter((p) => p.status === 'active');
  const need = (role, n) => roster.filter((p) => p.role === role).length < n;
  const cands = q(state, 'crew/candidates') || [];
  for (const [role, n] of [['astronaut', 5], ['flight_director', 2], ['engineer', 3]]) {
    if (!need(role, n)) continue;
    const c = cands.filter((x) => x.role === role && x.available !== false).sort((a, b) => b.skill - a.skill)[0];
    if (c) dispatch(state, data, { type: 'crew/hire', candidateId: c.id });
  }
}

function playLaunch(state, stats) {
  let g = 0;
  while (state.activeLaunch && g++ < 300) {
    const al = state.activeLaunch;
    let r;
    if (al.pendingIntervention) {
      const opts = al.pendingIntervention.options.filter((o) => !o.disabled);
      const pick = opts.find((o) => o.id === 'contingency') || opts.find((o) => o.id === 'reduce') || opts.find((o) => o.id === 'maintain') || opts[0];
      stats.interventions[pick.id] = (stats.interventions[pick.id] || 0) + 1;
      r = dispatch(state, data, { type: 'launch/choose', optionId: pick.id });
    } else if (al.act === 'prelaunch') r = dispatch(state, data, { type: 'launch/countdown' });
    else if (al.pendingHold) r = dispatch(state, data, { type: 'launch/hold', choice: (al.weather?.risk ?? 0) > 0.03 ? 'hold' : 'go' });
    else if (al.act === 'result') {
      const o = al.outcome;
      if (o) stats.results[`${al.phase}:${o.level}`] = (stats.results[`${al.phase}:${o.level}`] || 0) + 1;
      r = dispatch(state, data, { type: 'launch/finish' });
    } else r = dispatch(state, data, { type: 'launch/step' });
    if (!r.ok) throw new Error(`launch: ${r.error}`);
  }
  if (state.activeLaunch) throw new Error('launch never finished');
}

export function runCampaign(playerId, seed, { untilTurn = Infinity } = {}) {
  let state = newGame(data, { seed, playerId });
  const stats = { decisions: 0, kinds: {}, custom: 0, scheduleErrors: {}, interventions: {}, results: {}, news: 0, cashByYear: [], lastNews: null };
  let guard = 0;
  while (!state.gameOver && state.turn < untilTurn && guard++ < 4000) {
    for (let pass = 0; pass < 5 && state.decisions.length; pass++) {
      for (const d of state.decisions.slice()) {
        const c = choose(state, d);
        stats.decisions++;
        const k = d.kind.startsWith('event/') ? 'event' : d.kind;
        stats.kinds[k] = (stats.kinds[k] || 0) + 1;
        const r = dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c });
        if (!r.ok) throw new Error(`decision ${d.kind}/${c}: ${r.error}`);
        playLaunch(state, stats);
      }
    }
    playLaunch(state, stats);
    manageMissions(state, null, stats);
    customMission(state, stats, guard);
    manageResearch(state);
    manageCrew(state);
    // count news since the last step
    const ids = new Set();
    for (const n of state.news) { if (n.id === stats.lastNews) break; ids.add(n.id); }
    stats.news += ids.size;
    stats.lastNews = state.news[0]?.id ?? stats.lastNews;
    const before = state.turn;
    const r = dispatch(state, data, { type: 'time/advance', weeks: 1, stopOnEvent: false });
    if (!r.ok) throw new Error(`advance: ${r.error}`);
    if (state.turn !== before && state.turn % 52 === 0) stats.cashByYear.push(Math.round(playerCash(state)));
    if (guard % 60 === 0) state = deserialize(serialize(state));
  }
  if (!state.gameOver && untilTurn === Infinity) throw new Error(`no game over (turn ${state.turn})`);
  return { state, stats };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const agg = {};
for (const playerId of isMain ? actors : []) {
  for (let s = 1; s <= nSeeds; s++) {
    const seed = s * 104729;
    let res;
    try { res = runCampaign(playerId, seed); } catch (e) { console.error(`FAIL ${playerId} seed=${seed}: ${e.stack}`); process.exitCode = 1; continue; }
    const { state, stats } = res;
    const ms = state.missions;
    const flown = ms.filter((m) => m.result?.launchedTurn != null || ['transit', 'operations', 'done'].includes(m.status) && m.result).length;
    const done = ms.filter((m) => m.status === 'done' || m.status === 'operations');
    const succ = done.filter((m) => m.result?.outcome === 'total').length;
    const part = done.filter((m) => m.result?.outcome === 'partial').length;
    const fail = done.filter((m) => ['recoverable', 'catastrophic'].includes(m.result?.outcome)).length;
    const myFirsts = Object.entries(state.firsts).filter(([, f]) => f.actorId === playerId).map(([k]) => k);
    const table = q(state, 'league/table') || [];
    const rows = Array.isArray(table) ? table : table.rows || table.table || [];
    const rank = rows.findIndex((r) => (r.actorId ?? r.id) === playerId) + 1;
    const deaths = state.memorial.length;
    const errs = state.log.filter((l) => l.includes('erro'));
    const p = state.actors[playerId];
    const key = playerId;
    agg[key] = agg[key] || { n: 0, flown: 0, succ: 0, firsts: 0, rank: 0, deaths: 0 };
    Object.assign(agg[key], { n: agg[key].n + 1, flown: agg[key].flown + flown, succ: agg[key].succ + succ, firsts: agg[key].firsts + myFirsts.length, rank: agg[key].rank + rank, deaths: agg[key].deaths + deaths });
    console.log(`\n== ${playerId} seed=${seed}  flown=${flown} (${(flown / 5).toFixed(1)}/ano) ok=${succ} parcial=${part} falha=${fail} custom=${stats.custom} cancel=${ms.filter((m) => m.status === 'cancelled').length}`);
    console.log(`   rank=${rank}/${rows.length} prestige=${Math.round(p.prestige)} support=${Math.round(p.support)} rep=${Math.round(p.reputation)} budget=${fmtM(p.budget)} cash/ano=${stats.cashByYear.map(fmtM).join(' → ')} gameOver=${state.gameOver?.reason}`);
    console.log(`   firsts(jogador)=${myFirsts.join(',') || '-'}  mortes=${deaths}  news=${stats.news} decisões=${stats.decisions} research=${(state.research.unlocked || []).length} crew=${Object.values(state.crew).filter((x) => x.status === 'active').length}`);
    if (!QUIET) {
      console.log(`   decisões: ${Object.entries(stats.kinds).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      console.log(`   cenas: ${Object.entries(stats.results).map(([k, v]) => `${k}:${v}`).join(' ')}  intervenções: ${JSON.stringify(stats.interventions)}`);
      const firsts = Object.entries(state.firsts).sort((a, b) => a[1].turn - b[1].turn).map(([k, f]) => `${k}=${f.actorId}@${formatTurn(f.turn, state.startYear)}`);
      console.log(`   primeiros: ${firsts.join('  ')}`);
      console.log(`   tabela: ${rows.slice(0, 8).map((r) => `${r.actorId ?? r.id}:${Math.round(r.prestige ?? 0)}`).join(' ')}`);
      const se = Object.entries(stats.scheduleErrors).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (se.length) console.log(`   erros de agendamento: ${se.map(([k, v]) => `${v}× ${k}`).join(' | ')}`);
      if (errs.length) console.log(`   LOG ERROS: ${errs.slice(0, 3).join(' | ')}`);
    }
    if (VERBOSE) for (const m of ms) console.log(`     ${m.name} [${m.type}/${m.destination}] ${m.status} ${m.result?.outcome || ''} ${m.launchTurn != null ? formatTurn(m.launchTurn, state.startYear) : ''} p=${m.estimate ? Math.round(m.estimate.p * 100) : '?'}% ${m.vehicleId}/${m.spacecraftId}${m.secondarySpacecraftId ? '+' + m.secondarySpacecraftId : ''}`);
    if (errs.length) process.exitCode = 1;
  }
}
if (isMain) console.log('\n== média por ator');
for (const [k, a] of Object.entries(agg)) {
  console.log(`${k.padEnd(10)} voos/ano=${(a.flown / a.n / 5).toFixed(1)} sucessos=${(a.succ / a.n).toFixed(1)} primeiros=${(a.firsts / a.n).toFixed(1)} rank=${(a.rank / a.n).toFixed(1)} mortes=${(a.deaths / a.n).toFixed(1)}`);
}

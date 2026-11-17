// Crew mortality across full campaigns (player + AI). Runs the campaign bot of tools/sim-campaign.mjs and counts
// crewed flights and crew losses of every actor: the player's (state.memorial, one event per mission) and the
// rivals' (calendar items flown with crew that ended catastrophic).
// Usage: node tools/sim-crew.mjs [seeds=4] [actor=all] [--verbose]
import { loadDataNode } from '../src/core/data.js';
import { runCampaign } from './sim-campaign.mjs';
import { formatTurn } from '../src/core/time.js';
import { backgroundCrewLoss } from '../src/sim/crew.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const pos = args.filter((a) => !a.startsWith('--'));
const nSeeds = Number(pos[0] || 4);
const actors = (pos[1] || 'all') === 'all' ? data.scenario.playableActors : [pos[1]];
const VERBOSE = flags.has('--verbose');
const calItem = (id) => data.index?.calendar?.[id] || (data.calendar?.missions || []).find((x) => x.id === id) || null;

/** Crew events of one finished campaign. */
export function crewEvents(state) {
  const events = [];
  let playerCrewed = 0;
  let rivalCrewed = 0;
  let playerSafe = 1; // chance of no player loss from the crew risk shown before each flight (low-variance view)
  let rivalSafe = 1; // expected view: chance no rival crew dies, from crew.backgroundCrewLoss on every failed crewed flight (calendar.js rolls it)
  // player: missions flown with crew; losses = distinct missions in the Memorial
  for (const m of state.missions || []) {
    if (!m.crewed || !m.result || m.result.launchedTurn == null) continue;
    playerCrewed++;
    playerSafe *= 1 - (m.estimate?.pCrewLoss || 0);
  }
  const byMission = {};
  for (const x of state.memorial || []) (byMission[x.missionId] ||= []).push(x);
  for (const [mid, list] of Object.entries(byMission)) {
    const m = (state.missions || []).find((y) => y.id === mid);
    events.push({ actorId: state.playerId, turn: list[0].turn, name: m?.name || mid, dest: m?.destination, n: list.length, player: true });
  }
  // rivals: calendar items with crew (every attempt is in inst.history)
  for (const inst of state.calendar || []) {
    const item = calItem(inst.id);
    if (!item?.crewed || inst.status === 'player') continue;
    const flights = (inst.history || []).filter((h) => h.phase === 'ascent' || h.level).length;
    const attempts = new Set((inst.history || []).map((h) => h.attempt ?? 0)).size;
    if (!(inst.history || []).length) continue;
    rivalCrewed += attempts || (flights ? 1 : 0);
    const dest = data.index?.destinations?.[item.destination];
    for (const h of inst.history || []) {
      if (h.level === 'recoverable' || h.level === 'catastrophic') rivalSafe *= 1 - backgroundCrewLoss(data, { phase: h.phase, landing: dest?.kind === 'surface' });
      if (h.lostCrew) events.push({ actorId: item.owner, turn: h.turn, name: item.name, dest: item.destination, n: item.crewSize || null, player: false });
    }
  }
  return { events, playerCrewed, rivalCrewed, rivalSafe, playerSafe };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let campaigns = 0;
  let withDeath = 0;
  let withPlayerDeath = 0;
  let withRivalDeath = 0;
  let pc = 0;
  let rc = 0;
  let pe = 0;
  let re = 0;
  const byActor = {};
  let whatIf = 0;
  for (const playerId of actors) {
    for (let s = 1; s <= nSeeds; s++) {
      const seed = s * 104729;
      let res;
      try { res = runCampaign(playerId, seed); } catch (e) { console.error(`FAIL ${playerId} seed=${seed}: ${e.message}`); process.exitCode = 1; continue; }
      const { events, playerCrewed, rivalCrewed, rivalSafe } = crewEvents(res.state);


      campaigns++;
      pc += playerCrewed;
      rc += rivalCrewed;
      const pl = events.filter((e) => e.player);
      const rv = events.filter((e) => !e.player);
      pe += pl.length;
      re += rv.length;
      if (events.length) withDeath++;
      if (pl.length) withPlayerDeath++;
      if (rv.length) withRivalDeath++;
      whatIf += pl.length ? 1 : 1 - rivalSafe;
      for (const e of events) byActor[e.actorId] = (byActor[e.actorId] || 0) + 1;
      const txt = events.map((e) => `${e.actorId}${e.player ? '*' : ''}:${e.name}@${formatTurn(e.turn, res.state.startYear)}`).join('  ');
      console.log(`${playerId.padEnd(10)} seed=${seed}  voos tripulados jogador=${playerCrewed} rivais=${rivalCrewed}  perdas=${events.length}${txt ? `  ${txt}` : ''}`);
      if (VERBOSE) for (const m of res.state.missions.filter((x) => x.crewed && x.result)) console.log(`     ${m.name} [${m.destination}] ${m.result.outcome} p=${Math.round((m.estimate?.p ?? 0) * 100)}%`);
    }
  }
  const f = (x) => `${Math.round((x / (campaigns || 1)) * 100)}%`;
  console.log(`\n${campaigns} campanhas · com alguma perda de tripulação: ${f(withDeath)} (jogador ${f(withPlayerDeath)}, rivais ${f(withRivalDeath)})`);
  console.log(`voos tripulados por campanha: jogador ${(pc / (campaigns || 1)).toFixed(1)}, rivais ${(rc / (campaigns || 1)).toFixed(1)}`);
  console.log(`perda por voo tripulado: jogador ${pc ? ((pe / pc) * 100).toFixed(2) : '-'}%, rivais ${rc ? ((re / rc) * 100).toFixed(2) : '-'}%`);
  console.log(`esperado (crew.backgroundCrewLoss nas falhas tripuladas dos rivais, sem o sorteio): ~${f(whatIf)} das campanhas com perda`);
  console.log(`perdas por ator: ${Object.entries(byActor).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`);
}

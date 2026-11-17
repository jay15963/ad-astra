// 10-year diplomacy simulation: prints a log of alliances and ruptures, then shows rivals that
// cooperate on one program while competing for another milestone.
// Usage: node tools/sim-diplomacy.mjs [seed=1] [years=10] [--pure] [--quiet] [--seeds=N]
//   default: runs the full engine (other modules may still be stubs);
//   --pure: runs only the diplomacy module (useful if another module's stub blocks the engine).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDataNode } from '../src/core/data.js';
import { rngFor } from '../src/core/rng.js';
import { turnToDate } from '../src/core/time.js';
import * as dip from '../src/sim/diplomacy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
const pos = args.filter((a) => !a.startsWith('--'));
const seed0 = Number(pos[0] || 1);
const years = Number(pos[1] || 10);
const nSeeds = Number((args.find((a) => a.startsWith('--seeds=')) || '--seeds=1').split('=')[1]);
const pure = flags.has('--pure');
const quiet = flags.has('--quiet');

const data = await loadDataNode(root);
let engine = null;
if (!pure) {
  try { engine = await import('../src/core/engine.js'); } catch (e) { console.warn(`engine indisponível (${e.message}); usando --pure`); }
}

/** Minimal state + loop that only runs diplomacy (fallback). */
function pureGame(seed, playerId) {
  const state = {
    seed: seed >>> 0, turn: 0, startYear: data.scenario.startYear, endTurn: years * 52 - 1, playerId, idCounter: 0, gameOver: null,
    actors: {}, relations: {}, blocs: {}, treaties: [], proposals: [], world: {}, politics: {}, tension: {}, firsts: {},
    decisions: [], news: [], log: [], stats: {}, signals: [], signalsPending: [], crew: {},
  };
  const ctx = () => ({ data, rng: (l = '') => rngFor(state.seed, state.turn, 'diplomacy', l), date: turnToDate(state.turn, state.startYear) });
  dip.init(state, data, ctx());
  return {
    state,
    tick() {
      for (const d of state.decisions.slice()) {
        if (d.expiresTurn != null && state.turn >= d.expiresTurn) {
          state.decisions = state.decisions.filter((x) => x.id !== d.id);
          dip.decisionHandlers[d.kind]?.(state, data, d, d.defaultChoice, { ...ctx(), expired: true });
        }
      }
      state.signals = state.signalsPending; state.signalsPending = [];
      dip.tick(state, data, ctx());
      state.turn++;
    },
    resolve(d, choiceId) {
      state.decisions = state.decisions.filter((x) => x.id !== d.id);
      return dip.decisionHandlers[d.kind]?.(state, data, d, choiceId, ctx());
    },
  };
}

function engineGame(seed, playerId) {
  const state = engine.newGame(data, { seed, playerId });
  state.endTurn = years * 52 - 1; // extend the scenario so diplomacy can run 10 years
  return {
    state,
    tick() { engine.tick(state, data); },
    resolve(d, choiceId) { return engine.resolveDecision(state, data, d.id, choiceId); },
  };
}

const fmt = (state, turn) => { const d = turnToDate(turn, state.startYear); return `${d.monthName}/${d.year}`; };
const sh = (state, id) => state.actors[id]?.short || id;

function runOne(seed) {
  const playerId = data.scenario.playableActors?.[0] || 'nasa';
  const g = engine ? engineGame(seed, playerId) : pureGame(seed, playerId);
  const { state } = g;
  const lines = [];
  const seen = new Map(state.treaties.map((t) => [t.id, `${t.status}|${t.parties.join(',')}`]));
  let blocsSeen = JSON.stringify(Object.values(state.blocs).map((b) => [b.id, b.members.slice().sort()]));
  const counts = { signed: 0, broken: 0, expired: 0, acceded: 0, withdrawn: 0, bloc: 0, toPlayer: 0, playerAnswered: 0 };
  const choiceCycle = ['accept', 'counter', 'reject'];
  const coop = new Map(); // first time each rival pair is seen cooperating while racing
  let guard = 0;
  while (state.turn < years * 52 && !state.gameOver && guard++ < years * 60) {
    // the "player" answers AI proposals in rotation (accept / counter / reject), other decisions take the first choice
    for (const d of state.decisions.slice()) {
      if (d.kind === 'diplomacy/proposal') {
        counts.toPlayer++;
        const c = choiceCycle[counts.toPlayer % 3];
        lines.push(`${fmt(state, state.turn)}  📨 ${d.title} → jogador responde: ${c}`);
        g.resolve(d, c);
        counts.playerAnswered++;
      } else if (engine) {
        const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
        g.resolve(d, c?.id);
      }
    }
    if (engine && state.activeLaunch) state.activeLaunch = null; // other modules' scenes are out of scope here
    g.tick();
    const turn = state.turn - 1;
    for (const t of state.treaties) {
      const key = `${t.status}|${t.parties.join(',')}`;
      const prev = seen.get(t.id);
      if (prev === key) continue;
      seen.set(t.id, key);
      const parties = t.parties.map((p) => sh(state, p)).join(' + ');
      if (prev == null) { counts.signed++; lines.push(`${fmt(state, turn)}  🤝 ASSINADO  ${t.name} [${t.type}] ${parties}`); continue; }
      const [pst, pparties] = prev.split('|');
      if (t.status === 'broken' && pst === 'active') { counts.broken++; lines.push(`${fmt(state, turn)}  💔 ROMPIDO   ${t.name} por ${sh(state, t.brokenBy)} (${pparties.split(',').map((p) => sh(state, p)).join(' + ')})`); }
      else if (t.status === 'expired') { counts.expired++; lines.push(`${fmt(state, turn)}  ⌛ expirou   ${t.name} (${parties})`); }
      else if (t.status === 'active') {
        const before = pparties.split(','), now = t.parties;
        for (const p of now.filter((x) => !before.includes(x))) { counts.acceded++; lines.push(`${fmt(state, turn)}  ✍️  ADESÃO    ${sh(state, p)} → ${t.name}`); }
        for (const p of before.filter((x) => !now.includes(x))) { counts.withdrawn++; lines.push(`${fmt(state, turn)}  🚪 SAÍDA     ${sh(state, p)} deixa ${t.name}`); }
      }
    }
    if (turn % 13 === 0) for (const o of coopWhileCompeting(state)) if (!coop.has(o.key)) coop.set(o.key, `${fmt(state, turn)}: ${o.text}`);
    const bs = JSON.stringify(Object.values(state.blocs).map((b) => [b.id, b.members.slice().sort()]));
    if (bs !== blocsSeen) {
      counts.bloc++;
      lines.push(`${fmt(state, turn)}  🏳️  BLOCOS    ${Object.values(state.blocs).map((b) => `${b.short || b.id}: ${b.members.map((m) => sh(state, m)).join(', ')}`).join(' | ')}`);
      blocsSeen = bs;
    }
  }
  return { state, lines, counts, coop: [...coop.values()] };
}

/** Rival pairs (rivalry >= 35 or rival blocs) with an active bilateral treaty that also race for a shared, unclaimed milestone. */
function coopWhileCompeting(state) {
  const out = [];
  const ms = data.actors.milestones || {};
  for (const t of state.treaties) {
    if (t.status !== 'active' || t.terms?.multilateral || t.parties.length !== 2 || t.type === 'peaceful_use') continue;
    const [a, b] = t.parties;
    const gb = new Set(state.actors[b].ai.goals || []);
    const programMs = (data.actors.programs || []).find((p) => p.id === t.terms?.program)?.milestone;
    const shared = (state.actors[a].ai.goals || []).filter((g) => gb.has(g) && !state.firsts[g] && g !== programMs);
    if (!shared.length) continue;
    const r = dip.relation(state, a, b);
    const rivalBlocs = state.actors[a].bloc && state.actors[b].bloc && state.actors[a].bloc !== state.actors[b].bloc;
    if (r.rivalry < 35 && !rivalBlocs) continue; // not really rivals
    out.push({
      key: `${a}|${b}|${t.id}`,
      text: `${sh(state, a)} e ${sh(state, b)} cooperam em "${t.name}" e disputam ${shared.map((g) => ms[g] || g).join(', ')} (rivalidade ${Math.round(r.rivalry)}, confiança ${Math.round(r.trust)})`,
    });
  }
  return out;
}

const totals = { signed: 0, broken: 0, bloc: 0, toPlayer: 0, coop: 0 };
for (let i = 0; i < nSeeds; i++) {
  const seed = seed0 + i;
  const { state, lines, counts, coop } = runOne(seed);
  for (const k of Object.keys(counts)) if (k in totals) totals[k] += counts[k] || 0;
  totals.coop += coop.length;
  console.log(`\n=== Ad Astra · diplomacia · semente ${seed} · ${years} anos · ${engine ? 'motor completo' : 'só diplomacia'} ===`);
  if (!quiet) for (const l of lines) console.log(l);
  console.log(`\nResumo: ${counts.signed} assinados, ${counts.acceded} adesões, ${counts.broken} rompidos, ${counts.withdrawn} saídas, ${counts.expired} expirados, ${counts.bloc} mudanças de bloco, ${counts.toPlayer} propostas ao jogador.`);
  console.log(`\nRivais que cooperam em um programa e competem em outro (${coop.length} casos em ${years} anos):`);
  for (const l of coop.slice(0, 10)) console.log(`  · ${l}`);
  if (!quiet) {
    console.log('\nRelações finais mais quentes e mais frias:');
    const rels = Object.entries(state.relations).map(([k, r]) => ({ k, ...r })).sort((x, y) => y.trust - x.trust);
    for (const r of [...rels.slice(0, 4), ...rels.slice(-4)]) {
      const [a, b] = r.k.split('|');
      console.log(`  ${sh(state, a)}–${sh(state, b)}: confiança ${Math.round(r.trust)}, rivalidade ${Math.round(r.rivalry)}, dependência ${Math.round(r.dependence)}`);
    }
    console.log('\nÚltimas manchetes de diplomacia:');
    for (const n of state.news.filter((x) => x.tags?.includes('diplomacia')).slice(0, 8)) console.log(`  [${fmt(state, n.turn)}] ${n.headline}`);
  }
  const errs = state.log.filter((l) => l.includes('erro'));
  if (errs.length) console.log(`\nErros no log: ${errs.slice(0, 3).join(' | ')}`);
}
if (nSeeds > 1) console.log(`\nTotal em ${nSeeds} sementes: ${totals.signed} assinados, ${totals.broken} rompidos, ${totals.bloc} mudanças de bloco, ${totals.toPlayer} propostas ao jogador, ${totals.coop} casos de rivais cooperando e competindo.`);

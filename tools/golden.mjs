// Golden fixture for the Corrida Lunar (dt = 1): proves the 1950–3000 time engine did not change the 2026–2030 game.
// Records hash32 of a projection of the v1 top-level state keys at turns 26/52/130/260 for 3 seeds × 5 playable actors,
// played by a scripted bot that picks the engineers' suggested hardware explicitly (valid before and after item 9).
//
// Usage:
//   node tools/golden.mjs            compare against tests/fixtures/golden-lunar.json (exit 1 on drift)
//   node tools/golden.mjs --record   rewrite the fixture (write the reason in the report/commit!)
//   node tools/golden.mjs --save-v1  (re)record tests/fixtures/save-v1-t120.json (only meaningful on a v1 engine)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { loadDataNode } from '../src/core/data.js';
import * as engine from '../src/core/engine.js';
import { hash32 } from '../src/core/rng.js';

export const GOLDEN_SEEDS = [7919, 15838, 23757];
export const GOLDEN_CHECKPOINTS = [26, 52, 130, 260];

/** Top-level keys of a v1 (v0.5) state. New keys (clock, lifecycle, annals…) are not part of the projection. */
export const V1_KEYS = [
  'version', 'scenarioId', 'seed', 'startYear', 'endTurn', 'turn', 'playerId', 'idCounter', 'gameOver',
  'actors', 'relations', 'blocs', 'treaties', 'proposals', 'world', 'politics', 'tension', 'calendar',
  'vehicleStats', 'finance', 'research', 'crew', 'missions', 'contracts', 'activeLaunch', 'commandPoints', 'events',
  'memorial', 'album', 'firsts', 'firstsHistory', 'decisions', 'news', 'stats', 'signals', 'signalsPending',
];

/**
 * Projection: the v1 slices, minus things that legitimately change in Phase A without changing the game:
 * - `version` (1 → 2), `log` (debug text, cap), news text and the live cap (compaction to 120), ledger cap,
 * - mission `suggestion` (item 9 adds it) and decision card text/labels (item 9 rewords the accept button).
 */
export function project(state) {
  const out = {};
  for (const k of V1_KEYS) {
    if (k === 'version') continue;
    let v = state[k];
    if (v === undefined) continue;
    if (k === 'news') v = v.slice(0, 100).map((n) => ({ turn: n.turn, importance: n.importance, tags: n.tags, actors: n.actors }));
    else if (k === 'decisions') v = v.map((d) => ({ kind: d.kind, createdTurn: d.createdTurn, expiresTurn: d.expiresTurn ?? null, blocking: !!d.blocking, n: d.choices?.length ?? 0 }));
    else if (k === 'missions') v = v.map((m) => { const { suggestion, ...rest } = m; return rest; });
    else if (k === 'finance' && v && Array.isArray(v.ledger)) v = { ...v, ledger: v.ledger.slice(-100) };
    out[k] = v;
  }
  return out;
}

export function hashProjection(state) {
  const p = project(state);
  const perKey = {};
  for (const [k, v] of Object.entries(p)) perKey[k] = hash32(JSON.stringify(v));
  return { all: hash32(JSON.stringify(p)), perKey };
}

/**
 * Tender board (tela Contratos, v0.9.12): a prudent director bids on what the agency can deliver at a profit, at 80%
 * of the client's reference price, with the rocket of the feasibility check; at most `maxActive` jobs at a time.
 */
export function tenderMove(state, data, { dispatch, query } = engine, { maxActive = 3, bid = 0.8 } = {}) {
  const board = query(state, data, 'contracts/board');
  if (!board?.open) return 0;
  let active = board.mine.length + board.open.filter((t) => t.playerBid).length;
  let n = 0;
  for (const t of board.open) {
    if (active >= maxActive) break;
    if (t.playerBid || t.feas.level === 'bad') continue;
    const price = Math.round(t.refM * bid);
    const cost = t.feas.costM ?? 0;
    if (cost >= price * 0.9) continue; // no margin with this rocket
    if ((state.actors[state.playerId]?.cash ?? 0) < cost * 0.5) continue;
    const r = dispatch(state, data, { type: 'contract/bid', contractId: t.id, price, vehicleId: t.feas.vehicleId });
    if (r.ok) { active++; n++; }
  }
  return n;
}

/** Scripted bot step outside of time: decisions, launches, hardware choice, scheduling, tender bids. */
export function botStep(state, data, { dispatch, query } = engine, { schedule = true, tenders = schedule } = {}) {
  for (const d of state.decisions.slice()) {
    if (state.gameOver) return; // a card ended the campaign (final event, director fired): nothing else to play
    const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
    let r = dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
    // a choice the sim refuses now (e.g. "Aceitar" a briefing with the investors' agenda full): like a player,
    // take the next enabled one (usually "Recusar"); only a card with no acceptable choice is a bot error
    for (const alt of (d.choices || []).filter((x) => !x.disabled && x !== c)) {
      if (r.ok || !state.decisions.includes(d)) break;
      r = dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: alt.id });
    }
    if (!r.ok) throw new Error(`decision ${d.kind}: ${r.error}`);
  }
  if (state.gameOver) return;
  let lg = 0;
  while (state.activeLaunch && lg++ < 200) {
    const al = state.activeLaunch;
    let r;
    if (al.pendingIntervention) r = dispatch(state, data, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
    else if (al.act === 'prelaunch') r = dispatch(state, data, { type: 'launch/countdown' });
    else if (al.pendingHold) r = dispatch(state, data, { type: 'launch/hold', choice: 'go' });
    else if (al.act === 'result') r = dispatch(state, data, { type: 'launch/finish' });
    else r = dispatch(state, data, { type: 'launch/step' });
    if (!r.ok) throw new Error(`launch: ${r.error}`);
  }
  if (state.activeLaunch) throw new Error('launch never finished');
  if (!schedule) return; // fast mode (tools/campaign.mjs): only decisions and launches, no new player launches
  if (tenders) tenderMove(state, data, { dispatch, query });
  for (const m of state.missions.filter((x) => x.status === 'planning')) {
    // item 9: the player (here, the bot) picks the hardware; the bot takes the engineers' suggestion
    if ((m.vehicleId == null || m.spacecraftId == null) && m.suggestion) {
      const patch = {};
      if (m.vehicleId == null && m.suggestion.vehicleId) patch.vehicleId = m.suggestion.vehicleId;
      if (m.spacecraftId == null && m.suggestion.spacecraftId) patch.spacecraftId = m.suggestion.spacecraftId;
      if (Object.keys(patch).length) dispatch(state, data, { type: 'mission/update', missionId: m.id, patch });
    }
    const opts = query(state, data, 'missions/draftOptions', { ...m, missionId: m.id });
    if ((opts?.earliestLaunchTurn ?? state.turn) >= state.endTurn) continue;
    // a prudent director: never schedule what would push the agency deep into the red (keeps the runs to the end)
    const cash = state.actors[state.playerId]?.cash ?? 0;
    if (cash - Math.max(0, (m.cost || 0) - (m.grantM || 0)) < 150) continue;
    dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
  }
}

/** Play one (seed, actor) run, calling onTurn(state) after every tick. */
export function playRun(data, seed, playerId, onTurn, maxTurn = 260) {
  const state = engine.newGame(data, { seed, playerId });
  let guard = 0;
  while (!state.gameOver && state.turn < maxTurn && guard++ < 2000) {
    botStep(state, data);
    if (state.gameOver) break;
    const before = state.turn;
    const r = engine.dispatch(state, data, { type: 'time/advance', weeks: 1, stopOnEvent: false });
    if (!r.ok) throw new Error(`advance: ${r.error}`);
    if (state.turn !== before) onTurn?.(state);
  }
  return state;
}

export function computeGolden(data) {
  const runs = {};
  for (const playerId of data.scenario.playableActors) {
    for (const seed of GOLDEN_SEEDS) {
      const key = `${playerId}@${seed}`;
      runs[key] = {};
      playRun(data, seed, playerId, (s) => {
        if (GOLDEN_CHECKPOINTS.includes(s.turn)) runs[key][s.turn] = hashProjection(s);
      });
    }
  }
  return { checkpoints: GOLDEN_CHECKPOINTS, seeds: GOLDEN_SEEDS, runs };
}

/** List of human-readable differences between two golden records ([] = identical). */
export function diffGolden(expected, actual) {
  const out = [];
  for (const [run, cps] of Object.entries(expected.runs)) {
    for (const [turn, h] of Object.entries(cps)) {
      const a = actual.runs?.[run]?.[turn];
      if (!a) { out.push(`${run} t${turn}: checkpoint ausente`); continue; }
      if (a.all === h.all) continue;
      const keys = Object.keys(h.perKey).filter((k) => h.perKey[k] !== a.perKey[k]);
      out.push(`${run} t${turn}: ${keys.join(', ') || '(chaves novas)'}`);
    }
  }
  return out;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GOLDEN_PATH = path.join(root, 'tests', 'fixtures', 'golden-lunar.json');
export const SAVE_V1_PATH = path.join(root, 'tests', 'fixtures', 'save-v1-t120.json');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const data = await loadDataNode(root);
  const t0 = Date.now();
  if (process.argv.includes('--save-v1')) {
    // a real v1 save at turn 120 with a player mission in transit
    let saved = null;
    outer: for (const playerId of data.scenario.playableActors) {
      for (const seed of GOLDEN_SEEDS) {
        let hit = null;
        playRun(data, seed, playerId, (s) => { if (s.turn === 120 && !hit) hit = s.missions.some((m) => m.status === 'transit') ? engine.serialize(s) : ''; }, 120);
        if (hit) { saved = { playerId, seed, json: hit }; break outer; }
      }
    }
    if (!saved) throw new Error('nenhuma corrida com missão em trânsito na semana 120');
    fs.mkdirSync(path.dirname(SAVE_V1_PATH), { recursive: true });
    fs.writeFileSync(SAVE_V1_PATH, saved.json);
    console.log(`save v1 gravado: ${saved.playerId}@${saved.seed}, ${(saved.json.length / 1024).toFixed(0)} KB`);
  } else {
    const g = computeGolden(data);
    if (process.argv.includes('--record')) {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(g, null, 1) + '\n');
      console.log(`golden gravado (${Object.keys(g.runs).length} corridas) em ${Date.now() - t0} ms`);
    } else {
      const expected = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
      const d = diffGolden(expected, g);
      if (d.length) { console.error(`golden DIFERENTE (${d.length}):\n` + d.slice(0, 40).join('\n')); process.exitCode = 1; }
      else console.log(`golden idêntico (${Object.keys(g.runs).length} corridas) em ${Date.now() - t0} ms`);
    }
  }
}

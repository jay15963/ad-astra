// Headless smoke test: plays full campaigns with a naive bot and checks invariants.
// Usage: node tools/smoke.mjs [seeds=5] [actor=all]
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, query, isBlocked, serialize, deserialize } from '../src/core/engine.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);
const nSeeds = Number(process.argv[2] || 5);
const actorArg = process.argv[3] || 'all';
const actors = actorArg === 'all' ? data.scenario.playableActors : [actorArg];

let failures = 0;
for (const playerId of actors) {
  for (let s = 1; s <= nSeeds; s++) {
    const seed = s * 7919;
    try {
      let state = newGame(data, { seed, playerId });
      let guard = 0;
      while (!state.gameOver && guard++ < 5000) {
        // resolve all decisions with the first enabled choice
        for (const d of state.decisions.slice()) {
          const c = d.choices?.find((x) => !x.disabled) || d.choices?.[0];
          const r = dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId: c?.id });
          if (!r.ok) throw new Error(`decision ${d.kind}: ${r.error}`);
        }
        // play through any active launch
        let lg = 0;
        while (state.activeLaunch && lg++ < 200) {
          const al = state.activeLaunch;
          let r;
          if (al.pendingIntervention) {
            r = dispatch(state, data, { type: 'launch/choose', optionId: (al.pendingIntervention.options.find((o) => !o.disabled) || al.pendingIntervention.options[0]).id });
          } else if (al.act === 'prelaunch') {
            r = dispatch(state, data, { type: 'launch/countdown' });
          } else if (al.pendingHold) {
            r = dispatch(state, data, { type: 'launch/hold', choice: 'go' });
          } else if (al.act === 'result') {
            r = dispatch(state, data, { type: 'launch/finish' });
          } else {
            r = dispatch(state, data, { type: 'launch/step' });
          }
          if (!r.ok) throw new Error(`launch: ${r.error}`);
        }
        if (state.activeLaunch) throw new Error('launch never finished');
        // schedule whatever is ready (exercises costs, launches, transit and arrivals)
        // (only missions that can still fly before the end of the scenario: no "Data além do fim do cenário")
        for (const m of state.missions.filter((x) => x.status === 'planning')) {
          // item 9: accepted briefings/contracts arrive without hardware; the bot takes the engineers' suggestion
          if ((!m.vehicleId || (!m.spacecraftId && !m.clientPayload)) && m.suggestion) {
            const patch = {};
            if (!m.vehicleId && m.suggestion.vehicleId) patch.vehicleId = m.suggestion.vehicleId;
            if (!m.spacecraftId && m.suggestion.spacecraftId) patch.spacecraftId = m.suggestion.spacecraftId;
            if (Object.keys(patch).length) dispatch(state, data, { type: 'mission/update', missionId: m.id, patch });
          }
          const opts = query(state, data, 'missions/draftOptions', { ...m, missionId: m.id });
          if ((opts?.earliestLaunchTurn ?? state.turn) >= state.endTurn) continue;
          dispatch(state, data, { type: 'mission/schedule', missionId: m.id });
        }
        const r = dispatch(state, data, { type: 'time/advance', weeks: 4, stopOnEvent: true });
        if (!r.ok) throw new Error(`advance: ${r.error}`);
        if (r.advanced === 0 && isBlocked(state) === 'decision' && state.decisions.length === 0) throw new Error('blocked with no decisions');
        if (guard % 50 === 0) state = deserialize(serialize(state)); // save/load roundtrip mid-game
      }
      if (!state.gameOver) throw new Error(`no game over after ${guard} iterations (turn ${state.turn})`);
      const errs = state.log.filter((l) => l.includes('erro'));
      if (errs.length) throw new Error(`errors logged: ${errs.slice(0, 3).join(' | ')}`);
      const p = state.actors[playerId];
      console.log(`ok ${playerId} seed=${seed} turn=${state.turn} news=${state.news.length} missions=${state.missions.length} cash=${p?.cash?.toFixed?.(0)} prestige=${Math.round(p?.prestige ?? 0)} fim=${state.gameOver?.reason}`);
    } catch (e) {
      failures++;
      console.error(`FAIL ${playerId} seed=${seed}: ${e.stack || e.message}`);
    }
  }
}
process.exitCode = failures ? 1 : 0;

// Short headless campaign (EXPANSION.md §13.10): 1950→1962 and the last stretch to jan/3000 with the ending.
// The full run is `npm run test:campaign`. While sim modules are not dt-native yet (meta.maxDt < 13), the late
// segment starts in 2985 instead of 2595 so the suite stays fast; it still crosses b8 → b9 and reaches the ending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, ENDINGS } from '../src/core/engine.js';
import { loadCampaignData, dataStartingAt, runCampaign } from '../tools/campaign.mjs';
import { dateToTurn } from '../src/core/time.js';

const data = await loadCampaignData();
const hasCampaign = data.scenario?.id === 'campaign';
const dtNative = MODULES.every(([, m]) => !m.tick || (m.meta?.maxDt ?? 1) >= 13);

test('campaign 1950→1962: prologue quarters, then 2-week steps; save/load stable; no errors', { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const res = runCampaign(data, { seed: 7919, playerId: 'nasa', fast: true, maxTurns: dateToTurn(1962, 0, 1950) + 1 });
  // runCampaign's maxTurns caps the absolute turn
  assert.deepEqual(res.errors, []);
  const s = res.state;
  assert.ok(s.turn >= dateToTurn(1962, 0, 1950), `turn ${s.turn}`);
  assert.equal(s.clock.eraId, 'e1');
  // 24 quarterly turns (1950–55) + 2-week turns since 1956
  assert.equal(s.clock.steps, 24 + (s.turn - dateToTurn(1956, 0, 1950)) / 2);
  assert.ok(res.eras[0].saveKB <= 400, `save ${res.eras[0].saveKB} KB`);
});

test(`campaign ${dtNative ? 2595 : 2985}→3000: reaches jan/3000 with one of the three endings`, { skip: !hasCampaign && 'loader sem campanha' }, () => {
  const from = dtNative ? 2595 : 2985;
  const d = dataStartingAt(data, from);
  const t0 = Date.now();
  const res = runCampaign(d, { seed: 15838, playerId: 'nasa', fast: true });
  assert.deepEqual(res.errors, []);
  assert.equal(res.reason, 'ending', `fim: ${res.reason}`);
  assert.ok(ENDINGS.includes(res.ending));
  assert.equal(res.state.turn, dateToTurn(3000, 0, from));
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
});

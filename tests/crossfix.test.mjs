// Cross-side requests from the UI review: refusal cost in previews, final flag on resolutions,
// stage-tagged risk factors, draft autoName/compat, destination phrases, negative-turn dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame } from '../src/core/engine.js';
import { formatTurn } from '../src/core/time.js';
import * as missions from '../src/sim/missions.js';
import * as diplomacy from '../src/sim/diplomacy.js';
import * as risk from '../src/sim/risk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

test('diplomacy preview tells the UI what a refusal costs', () => {
  const s = newGame(data, { seed: 3, playerId: 'isro' });
  const pre = diplomacy.previewProposal(s, data, 'jaxa', 'science', {});
  assert.equal(pre.refusalTrust, 1);
  assert.equal(pre.counterRefusalTrust, 2);
});

test('needsTransit is exported and the success_party event waits for the final phase', () => {
  assert.equal(missions.needsTransit(data, { destination: 'lunar_orbit' }), true);
  assert.equal(missions.needsTransit(data, { destination: 'leo' }), false);
  const ev = data.events.events.find((e) => e.id === 'success_party');
  assert.equal(ev.trigger.signalWhere.final, true);
});

test('vehicle reliability and tight prep are tagged as launch-only factors; drafts get createdTurn', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  const r = risk.missionRisk(s, data, { actorId: 'nasa', type: 'probe', destination: 'lunar_orbit', vehicleId: 'falcon9', spacecraftId: s && data.spacecraft.spacecraft.find((x) => x.kind === 'probe')?.id, crew: {}, config: { strategy: 'balanced', fuelMargin: 0.1 }, launchTurn: 2, createdTurn: 0 });
  const veh = r.factors.find((f) => /^Confiabilidade do /.test(f.label));
  assert.deepEqual(veh.stages, ['asc']);
  const prep = r.factors.find((f) => /Prazo apertado/.test(f.label));
  assert.ok(prep, 'tight prep shows up for a draft launched 2 weeks after creation');
  assert.deepEqual(prep.stages, ['asc']);
});

test('draftOptions: autoName and spacecraft that cannot ride the chosen vehicle', () => {
  const s = newGame(data, { seed: 5, playerId: 'nasa' });
  const q = missions.draftOptions(s, data, { type: 'crewed', destination: 'leo', vehicleId: 'falcon9' });
  assert.match(q.autoName || '', /\S/);
  const orion = q.spacecraft.find((x) => x.id === 'orion');
  if (orion) {
    assert.equal(orion.valid, false);
    assert.ok(orion.reasons.some((r) => /Só voa no/.test(r)));
  }
});

test('destinations carry pt-BR phrases; dates before the campaign format correctly', () => {
  for (const d of data.destinations.destinations) {
    assert.ok(d.emLabel && d.toLabel, `${d.id} sem emLabel/toLabel`);
  }
  assert.equal(formatTurn(-1, 2026), 'dez/2025');
  assert.equal(formatTurn(-30, 2026), 'jun/2025');
});

// Tests for the Launch Day scene's pure presentation helpers and the audio module (no DOM in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import {
  toPct, formatBand, formatDelta, viewForAct, milestoneTimes, buildProfile, telemetryAt,
  isEnded, fallbackOutcome, fmtClock, fmtNum, openLaunchScene, OUTCOME_INFO, STRATEGIES,
} from '../src/ui/launch-scene.js';
import { getAudio, unlockAudio } from '../src/ui/audio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASCENT = ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit', 'tli'].map((id) => ({ id, label: id, status: 'pending' }));

test('chance band formats fractions and points', () => {
  assert.equal(formatBand({ p: 0.7, low: 0.62, high: 0.78 }), '62–78%');
  assert.equal(formatBand({ p: 70, low: 62, high: 78 }), '62–78%');
  assert.equal(formatBand({ p: 0.5 }), '42–58%');
  assert.equal(formatBand({ low: 0.9, high: 0.9 }), '90%');
  assert.equal(formatBand(null), '—');
  assert.equal(toPct(undefined), null);
  assert.equal(toPct(0.5), 50);
});

test('factor deltas are signed points in pt-BR', () => {
  assert.equal(formatDelta(0.04), '+4 pts');
  assert.equal(formatDelta(-0.02), '−2 pts');
  assert.equal(formatDelta(-0.005), '−0,5 pts');
  assert.equal(formatDelta(0), '±0');
  assert.equal(formatDelta('x'), '±0');
});

test('view resumes at the stored act', () => {
  assert.equal(viewForAct(null), null);
  assert.equal(viewForAct({}), 'prelaunch');
  assert.equal(viewForAct({ act: 'countdown', current: 0 }), 'countdown');
  assert.equal(viewForAct({ act: 'countdown', current: 2 }), 'ascent');
  assert.equal(viewForAct({ act: 'ascent', current: 3 }), 'ascent');
  assert.equal(viewForAct({ act: 'climax' }), 'climax');
  assert.equal(viewForAct({ act: 'ascent', outcome: { level: 'total' } }), 'result');
  assert.equal(viewForAct({ act: 'result' }), 'result');
});

test('milestone times are increasing, spaced and capped', () => {
  const t = milestoneTimes(ASCENT);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 4 - 1e-9);
  assert.ok(t[t.length - 1] <= 120);
  const big = milestoneTimes([{ id: 'a', t: 0 }, { id: 'b', t: 300 }, { id: 'c', t: 600 }]);
  assert.ok(big[2] <= 90, 'long sim timelines are compressed');
  assert.deepEqual(milestoneTimes(undefined), []);
  const noT = milestoneTimes([{ id: 'x' }, { id: 'y' }], 'arrival');
  assert.ok(noT[1] > noT[0]);
});

test('ascent profile climbs monotonically; arrival descends to the ground', () => {
  const p = buildProfile(ASCENT, 'ascent');
  let prev = -1;
  for (let t = 0; t <= p.times[p.times.length - 1] + 5; t += 0.5) {
    const { alt, vel } = telemetryAt(p, t);
    assert.ok(alt >= prev - 1e-9, `alt monotonic at ${t}`);
    assert.ok(Number.isFinite(vel));
    prev = alt;
  }
  assert.ok(telemetryAt(p, 999).vel > 10, 'TLI speed');
  const arr = buildProfile([{ id: 'deorbit' }, { id: 'braking' }, { id: 'hazard' }, { id: 'touchdown' }], 'arrival', 'moon');
  assert.ok(telemetryAt(arr, 0).alt > 50);
  assert.equal(telemetryAt(arr, 999).alt, 0);
  const mars = buildProfile([{ id: 'entry' }, { id: 'touchdown' }], 'arrival', 'mars');
  assert.ok(telemetryAt(mars, 0).vel > 5);
  assert.deepEqual(telemetryAt(buildProfile([], 'ascent'), 3), { alt: 0, vel: 0 });
});

test('end detection and presentation fallback outcome', () => {
  assert.equal(isEnded(null), true);
  assert.equal(isEnded({ act: 'ascent', milestones: ASCENT, current: 2 }), false);
  assert.equal(isEnded({ act: 'ascent', milestones: ASCENT, current: 7 }), true);
  const failed = ASCENT.map((m, i) => ({ ...m, status: i < 2 ? 'ok' : i === 2 ? 'fail' : 'pending' }));
  assert.equal(isEnded({ act: 'ascent', milestones: failed, current: 3 }), true);
  assert.equal(fallbackOutcome({ milestones: failed }).level, 'catastrophic');
  assert.equal(fallbackOutcome({ milestones: failed, interventions: [{ optionId: 'abort' }] }).level, 'recoverable');
  assert.equal(fallbackOutcome({ milestones: [{ status: 'ok' }, { status: 'anomaly' }] }).level, 'partial');
  assert.equal(fallbackOutcome({}).level, 'total');
  for (const lv of ['total', 'partial', 'recoverable', 'catastrophic']) assert.ok(OUTCOME_INFO[lv].label);
  assert.deepEqual(STRATEGIES.map((s) => s.id), ['conservative', 'balanced', 'aggressive']);
});

test('formatting helpers', () => {
  assert.equal(fmtClock(75), '01:15');
  assert.equal(fmtClock(-3), '00:00');
  assert.equal(fmtNum(3.14159, 2), '3,14');
  assert.equal(fmtNum(undefined), '—');
});

test('scene and audio never throw without a DOM', () => {
  assert.equal(typeof openLaunchScene(null), 'function');
  assert.equal(typeof openLaunchScene({ state: { activeLaunch: { missionId: 'm1', phase: 'ascent' } } }), 'function');
  const a = getAudio({ settings: { sound: true } });
  for (const fn of ['beep', 'radio', 'chime', 'alarm', 'thump', 'boom', 'touchdown', 'rumble', 'stopRumble', 'tension', 'cutTension', 'silence', 'fanfare', 'failure', 'sync', 'stopAll']) {
    assert.doesNotThrow(() => a[fn](0.5), fn);
  }
  assert.doesNotThrow(() => unlockAudio());
  assert.equal(a.available, false);
});

test('scene helpers work with real milestone data shapes from data/destinations.json', async () => {
  const data = await loadDataNode(root);
  for (const d of data.destinations?.destinations || []) {
    const ms = d.arrivalMilestones || [];
    if (!ms.length) continue;
    const p = buildProfile(ms, 'arrival', d.body);
    assert.equal(p.times.length, ms.length);
    assert.equal(telemetryAt(p, 1e6).alt, 0, d.id);
  }
});

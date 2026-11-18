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

// ------------------------------------------------------------------ infrastructure beats (MISSIONS-V2 §7.1–7.2)
const sceneMod = await import('../src/ui/launch-scene.js');
const { infraIndex, infraEventOf, infraFlags, infraTimeline, rendezvousActive } = sceneMod;
const DOCK_MS = ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit', 'rendezvous', 'dock'].map((id) => ({ id, label: id, status: 'ok' }));
const REL_MS = ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit', 'module_release'].map((id) => ({ id, label: id, status: 'ok' }));
const ISS_T = { kind: 'station', assetId: 'as_1', name: 'ISS', newAsset: false, sequence: 'dock', modules: [{ id: 'st_core', n: 1 }, { id: 'st_arm', n: 1 }], vehicles: [], sizeTier: 3, stageN: 0, bodyId: 'earth', site: 'iss', payload: { kind: null, moduleId: null, vehicleTypeId: null, qty: 1 }, traits: ['arm'] };

test('infra milestones: index, events per sequence, failures', () => {
  assert.equal(infraIndex(DOCK_MS), 6);
  assert.equal(infraIndex(REL_MS), 6);
  assert.equal(infraIndex(ASCENT), -1);
  assert.equal(infraIndex(undefined), -1);
  assert.equal(infraEventOf({ id: 'rendezvous', status: 'ok' }, ISS_T), 'rendezvous');
  assert.equal(infraEventOf({ id: 'dock', status: 'ok' }, ISS_T), 'dock');
  assert.equal(infraEventOf({ id: 'dock', status: 'anomaly' }, { ...ISS_T, sequence: 'berth' }), 'berth');
  assert.equal(infraEventOf({ id: 'dock', status: 'fail' }, ISS_T), 'dockFail');
  assert.equal(infraEventOf({ id: 'rendezvous', status: 'fail' }, ISS_T), 'rvFail');
  assert.equal(infraEventOf({ id: 'module_release', status: 'ok' }, null), 'release');
  assert.equal(infraEventOf({ id: 'orbit', status: 'ok' }, ISS_T), null);
  assert.equal(infraEventOf({ id: 'undock', status: 'ok' }, ISS_T), null, 'undocking is not a docking beat');
});

test('infra timeline: the rendezvous view starts after SECO and the dock comes after the rendezvous', () => {
  const p = buildProfile(DOCK_MS, 'ascent');
  const tl = infraTimeline(p, DOCK_MS);
  const tOrbit = p.times[5], tRv = p.times[6], tDock = p.times[7];
  assert.ok(tl.start > tOrbit && tl.start < tRv, 'starts between SECO and the rendezvous milestone');
  assert.equal(tl.rv, tRv); assert.equal(tl.dock, tDock);
  assert.ok(tDock - tRv >= 4, 'room for hold + final approach');
  assert.ok(telemetryAt(p, tRv).alt >= 200, 'station altitude');
  const pr = buildProfile(REL_MS, 'ascent');
  const tr = infraTimeline(pr, REL_MS);
  assert.equal(tr.release, pr.times[6]);
  assert.equal(tr.dock, null);
  assert.equal(infraTimeline(buildProfile(ASCENT, 'ascent'), ASCENT), null);
  // arrival list (beyond Earth orbit): rendezvous + dock appended to the arrival milestones
  const arr = ['loi', 'rendezvous', 'dock'].map((id) => ({ id, status: 'ok' }));
  const pa = buildProfile(arr, 'arrival', 'moon', 'orbit');
  const ta = infraTimeline(pa, arr);
  assert.ok(ta.start <= ta.rv && ta.rv < ta.dock);
});

test('sequence from the snapshot: rendezvous view only for dock / berth / release, after SECO', () => {
  const base = { view: 'ascent', target: ISS_T, milestones: DOCK_MS, phase: 'ascent' };
  assert.equal(rendezvousActive({ ...base, presented: 5 }), false, 'still climbing');
  assert.equal(rendezvousActive({ ...base, presented: 6, secoAge: 1 }), false, 'SECO beat on the climb view first');
  assert.equal(rendezvousActive({ ...base, presented: 6, secoAge: 3 }), true);
  assert.equal(rendezvousActive({ ...base, presented: 6, secoAge: null }), true, 'resume: straight to the rendezvous view');
  assert.equal(rendezvousActive({ ...base, presented: 8, secoAge: 30 }), true);
  assert.equal(rendezvousActive({ ...base, view: 'countdown', presented: 8 }), false);
  assert.equal(rendezvousActive({ ...base, target: { ...ISS_T, sequence: 'surface' }, presented: 8 }), false, 'surface deliveries stay in the descent view');
  assert.equal(rendezvousActive({ ...base, target: null, presented: 8 }), false, 'no target → classic scene');
  assert.equal(rendezvousActive({ ...base, milestones: ASCENT, presented: 7 }), false, 'no infra milestones → classic scene');
  assert.equal(rendezvousActive({ view: 'ascent', target: { ...ISS_T, sequence: 'release', newAsset: true }, milestones: REL_MS, presented: 6, secoAge: 5, phase: 'ascent' }), true);
  assert.equal(rendezvousActive({ view: 'ascent', target: ISS_T, milestones: [{ id: 'loi' }, { id: 'rendezvous' }, { id: 'dock' }], presented: 1, phase: 'arrival' }), true, 'arrival: right after insertion');
});

test('resume mid-docking: flags from the milestones already rolled draw the same picture', () => {
  assert.deepEqual(infraFlags(DOCK_MS, 6, ISS_T), { rendezvous: false, docked: false, dockFail: false, rvFail: false, rvAnomaly: false, released: false });
  const mid = infraFlags(DOCK_MS, 7, ISS_T);
  assert.equal(mid.rendezvous, true); assert.equal(mid.docked, false);
  assert.equal(infraFlags(DOCK_MS, 8, ISS_T).docked, true);
  const anomalous = DOCK_MS.map((m) => (m.id === 'rendezvous' ? { ...m, status: 'anomaly' } : m));
  assert.equal(infraFlags(anomalous, 7, ISS_T).rvAnomaly, true, 'wobble during the hold');
  const failed = DOCK_MS.map((m) => (m.id === 'dock' ? { ...m, status: 'fail' } : m));
  const f = infraFlags(failed, 8, ISS_T);
  assert.equal(f.docked, false); assert.equal(f.dockFail, true);
  assert.equal(infraFlags(REL_MS, 7, { sequence: 'release' }).released, true);
  // the resumed clock sits at the last rolled milestone: the renderer's pose is then exactly the 30 m hold point
  const p = buildProfile(DOCK_MS, 'ascent');
  const tl = infraTimeline(p, DOCK_MS);
  return import('../src/ui/launch-render/infra.js').then(({ dockPose }) => {
    const pose = dockPose({ clock: p.times[6], t: 0, tl, flags: mid });
    assert.equal(pose.range, 30);
    assert.equal(dockPose({ clock: p.times[7], t: 0, tl, flags: infraFlags(DOCK_MS, 8, ISS_T) }).phase, 'docked');
  });
});

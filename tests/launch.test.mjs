// Tests for src/sim/launch.js (Dia de Lançamento state machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataNode } from '../src/core/data.js';
import { newGame, dispatch, serialize, deserialize } from '../src/core/engine.js';
import { pushDecision, cloneState } from '../src/core/helpers.js';
import { openScene, autoplay, MAX_INTERVENTIONS } from '../src/sim/launch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await loadDataNode(root);

const CAUSE_KINDS = ['part', 'decision', 'luck', 'environment', 'crew'];

function bestCrew(state) {
  const ppl = Object.values(state.crew || {}).filter((p) => p.actorId === state.playerId && (!p.status || p.status === 'active'));
  const best = (role) => ppl.filter((p) => p.role === role).sort((a, b) => b.skill - a.skill)[0]?.id || null;
  return { fd: best('flight_director'), cmd: best('astronaut') };
}

/** Fresh game with one injected mission ready to launch. */
function setup({ seed = 1, playerId = 'nasa', mission = {} } = {}) {
  const state = newGame(data, { seed, playerId });
  state.decisions = [];
  const c = bestCrew(state);
  const crewed = mission.crewed ?? mission.type === 'crewed';
  const m = {
    id: 'test_m1', name: 'Teste-1', source: 'custom', type: 'satellite', destination: 'leo', vehicleId: 'falcon9', spacecraftId: 'generic_sat',
    crewed: false,
    crew: { flightDirector: c.fd, commander: crewed ? c.cmd : null, astronauts: crewed && c.cmd ? [c.cmd] : [] },
    config: { strategy: 'balanced', fuelMargin: 0.1 }, status: 'launch', createdTurn: -40, launchTurn: state.turn,
    cost: 0, paid: true, estimate: null, riskMod: 0, attempts: 0, transit: null, ops: null, phases: [], result: null,
    ...mission,
  };
  m.crewed = crewed;
  state.missions.unshift(m); // first: inherited probes in flight (Lucy, Psyche...) are adopted at init
  return state;
}

function ready(state, phase = 'ascent', choiceId = 'go') {
  const d = pushDecision(state, { kind: 'launch/ready', title: 't', body: '', blocking: true, choices: [{ id: 'go', label: 'go' }, { id: 'scrub', label: 'adiar' }], payload: { missionId: 'test_m1', phase } });
  return dispatch(state, data, { type: 'decision/resolve', id: d.id, choiceId });
}

/** Drive with dispatch (like the UI): policy picks intervention options. */
function play(state, pick = () => 'maintain', hold = 'go', stopAt = null) {
  let guard = 0;
  while (state.activeLaunch && guard++ < 100) {
    const al = state.activeLaunch;
    if (stopAt && stopAt(al)) return 'stopped';
    let r;
    if (al.act === 'prelaunch') r = dispatch(state, data, { type: 'launch/countdown' });
    else if (al.pendingHold) r = dispatch(state, data, { type: 'launch/hold', choice: hold });
    else if (al.pendingIntervention) r = dispatch(state, data, { type: 'launch/choose', optionId: pick(al.pendingIntervention, al) });
    else if (al.act === 'result') return al.outcome;
    else r = dispatch(state, data, { type: 'launch/step' });
    assert.equal(r.ok, true, r.error);
    if (r.scrubbed) return 'scrubbed';
  }
  return state.activeLaunch?.outcome ?? null;
}

test("'launch/ready' go opens the control room in prelaunch with lineup, estimate, weather", () => {
  const s = setup();
  const r = ready(s);
  assert.equal(r.ok, true);
  const al = s.activeLaunch;
  assert.ok(al);
  assert.equal(al.act, 'prelaunch');
  assert.equal(al.seed, null);
  assert.ok(al.estimate.p > 0.9 && al.estimate.low <= al.estimate.p && al.estimate.p <= al.estimate.high);
  assert.ok(al.weather.label && Number.isFinite(al.weather.risk));
  assert.ok(al.milestones.length >= 6);
  assert.ok(al.commandPoints >= 1 && al.commandPoints <= 5);
  assert.equal(s.commandPoints, al.commandPoints);
  assert.ok(al.log.length > 0);
  assert.deepEqual(JSON.parse(JSON.stringify(s.activeLaunch)), s.activeLaunch, 'JSON-serializable');
});

test("'launch/ready' scrub postpones 1-2 weeks and costs support", () => {
  const s = setup();
  const before = s.actors.nasa.support;
  const t0 = s.missions[0].launchTurn;
  const r = ready(s, 'ascent', 'scrub');
  assert.equal(r.ok, true);
  assert.equal(s.activeLaunch, null);
  const dt = s.missions[0].launchTurn - t0;
  assert.ok(dt >= 1 && dt <= 2);
  assert.ok(s.actors.nasa.support < before);
  assert.equal(s.missions[0].status, 'scheduled');
});

test('configure only in prelaunch and it changes the estimate', () => {
  const s = setup({ mission: { vehicleId: 'starship' } });
  ready(s);
  const p0 = s.activeLaunch.estimate.p;
  let r = dispatch(s, data, { type: 'launch/configure', strategy: 'conservative', fuelMargin: 0.3 });
  assert.equal(r.ok, true);
  assert.ok(s.activeLaunch.estimate.p > p0);
  r = dispatch(s, data, { type: 'launch/configure', strategy: 'yolo' });
  assert.equal(r.ok, false);
  dispatch(s, data, { type: 'launch/countdown' });
  assert.ok(Number.isFinite(s.activeLaunch.seed), 'seed locked at countdown');
  r = dispatch(s, data, { type: 'launch/configure', strategy: 'aggressive' });
  assert.equal(r.ok, false);
});

test('determinism: same seed + same choices = same scene', () => {
  for (const seed of [1, 2, 3, 99]) {
    const a = setup({ seed, mission: { vehicleId: 'starship' } });
    const b = setup({ seed, mission: { vehicleId: 'starship' } });
    ready(a);
    ready(b);
    const pick = (pi) => (pi.options.find((o) => o.id === 'reduce' && !o.disabled) ? 'reduce' : 'maintain');
    const oa = play(a, pick);
    const ob = play(b, pick);
    assert.deepEqual(oa, ob);
    assert.deepEqual(a.activeLaunch?.log, b.activeLaunch?.log);
  }
});

test('save/load in the middle of a scene continues identically', () => {
  let checked = 0;
  for (let seed = 1; seed <= 40 && checked < 6; seed++) {
    const s = setup({ seed, mission: { vehicleId: 'starship' } });
    ready(s);
    const stopped = play(s, () => 'maintain', 'go', (al) => !!al.pendingIntervention || al.current >= 3);
    if (stopped !== 'stopped') continue;
    const copy = deserialize(serialize(s));
    const o1 = play(s, () => 'reduce');
    const o2 = play(copy, () => 'reduce');
    assert.deepEqual(o1, o2);
    assert.deepEqual(s.activeLaunch.log, copy.activeLaunch.log);
    checked++;
  }
  assert.ok(checked > 0);
});

test('interventions are bounded to 1-3 per scene; abort/maintain/timeout handled', () => {
  const counts = [];
  for (let seed = 1; seed <= 300; seed++) {
    const s = setup({ seed, mission: { vehicleId: seed % 2 ? 'starship' : 'falcon9' } });
    ready(s);
    const out = play(s, (pi) => (seed % 3 === 0 ? 'timeout' : 'maintain'));
    if (out === 'scrubbed') continue;
    const n = s.activeLaunch.interventions.length;
    assert.ok(n <= MAX_INTERVENTIONS, `seed ${seed}: ${n}`);
    if (!out.sudden) assert.ok(n >= 1, `seed ${seed}: no intervention (${out.how})`);
    counts.push(n);
  }
  assert.ok(counts.length > 250);
  assert.ok(counts.some((n) => n >= 2), 'multiple interventions happen on risky flights');
});

test('every outcome has causes (including successes) and a headline', () => {
  const levels = new Set();
  for (let seed = 1; seed <= 120; seed++) {
    const s = setup({ seed, mission: { vehicleId: 'starship' } });
    ready(s);
    const out = play(s);
    if (out === 'scrubbed') continue;
    levels.add(out.level);
    assert.ok(out.causes.length >= 2);
    for (const c of out.causes) {
      assert.ok(CAUSE_KINDS.includes(c.kind), c.kind);
      assert.equal(typeof c.label, 'string');
      assert.ok(Number.isFinite(c.weight));
    }
    assert.ok(out.headline && !out.headline.includes('{'));
    if (out.level === 'total') assert.ok(out.causes.some((c) => c.weight > 0), 'o que deu certo');
    else {
      assert.ok(out.failureType);
      assert.ok(out.causes.some((c) => c.weight < 0));
    }
  }
  assert.ok(levels.has('total') && levels.size >= 3, [...levels].join(','));
});

test('crewed abort during ascent saves the crew (recoverable)', () => {
  let done = 0;
  for (let seed = 1; seed <= 60 && done < 5; seed++) {
    const s = setup({ seed, mission: { type: 'crewed', crewed: true, spacecraftId: 'crew_dragon', destination: 'iss' } });
    ready(s);
    const out = play(s, () => 'abort');
    if (out === 'scrubbed' || out.sudden) continue;
    if (!s.activeLaunch.interventions.some((i) => i.optionId === 'abort')) continue;
    assert.equal(out.level, 'recoverable');
    assert.deepEqual(out.crewLost, []);
    done++;
  }
  assert.ok(done > 0);
});

test('hold: scrub ends the scene and postpones; go keeps flying', () => {
  let scrubbed = 0;
  let went = 0;
  for (let seed = 1; seed <= 200 && (scrubbed < 2 || went < 2); seed++) {
    const s = setup({ seed });
    ready(s);
    dispatch(s, data, { type: 'launch/countdown' });
    if (!s.activeLaunch.pendingHold) continue;
    assert.equal(dispatch(s, data, { type: 'launch/step' }).ok, false, 'must decide the hold first');
    if (seed % 2) {
      const t0 = s.missions[0].launchTurn;
      const r = dispatch(s, data, { type: 'launch/hold', choice: 'scrub' });
      assert.equal(r.scrubbed, true);
      assert.equal(s.activeLaunch, null);
      assert.ok(s.missions[0].launchTurn > t0);
      scrubbed++;
    } else {
      dispatch(s, data, { type: 'launch/hold', choice: 'go' });
      assert.ok(play(s) && s.activeLaunch?.outcome);
      went++;
    }
  }
  assert.ok(scrubbed > 0 && went > 0);
});

test('finish hands the result to missions and clears the scene', () => {
  const s = setup();
  ready(s);
  const out = play(s);
  assert.ok(out && out.level);
  const r = dispatch(s, data, { type: 'launch/finish' });
  assert.equal(r.ok, true);
  assert.equal(s.activeLaunch, null);
  assert.equal(s.stats['launch.scenes'], 1);
  const m = s.missions[0];
  assert.notEqual(m.status, 'launch', 'missions.onLaunchResolved moved the mission on');
  assert.equal(dispatch(s, data, { type: 'launch/step' }).ok, false);
});

test('arrival scene uses destination arrival milestones', () => {
  const s = setup({ mission: { type: 'lander', destination: 'lunar_surface', vehicleId: 'falconheavy', spacecraftId: 'generic_lander', status: 'arrival' } });
  ready(s, 'arrival');
  const al = s.activeLaunch;
  assert.equal(al.phase, 'arrival');
  const ids = (data.index.destinations.lunar_surface.arrivalMilestones || []).filter((m) => !m.crewedOnly).map((m) => m.id);
  assert.deepEqual(al.milestones.map((m) => m.id), ids);
  const out = play(s);
  assert.ok(['total', 'partial', 'recoverable', 'catastrophic'].includes(out.level));
});

test('rates are sane: Falcon 9 >= 95%, Starship clearly lower', () => {
  const rate = (vehicleId, n = 600) => {
    const s = setup({ mission: { vehicleId } });
    let ok = 0;
    let flown = 0;
    for (let i = 0; i < n; i++) {
      s.seed = 1000 + i * 31;
      s.activeLaunch = null;
      openScene(s, data, 'test_m1', 'ascent');
      const out = autoplay(s, data);
      if (out.scrubbed) continue;
      flown++;
      if (out.level === 'total' || out.level === 'partial') ok++;
    }
    return ok / flown;
  };
  const f9 = rate('falcon9');
  const ss = rate('starship');
  assert.ok(f9 >= 0.95, `f9 ${f9}`);
  assert.ok(ss < f9 - 0.1, `starship ${ss}`);
});

test('actions without a scene fail cleanly', () => {
  const s = setup();
  for (const type of ['launch/step', 'launch/countdown', 'launch/choose', 'launch/hold', 'launch/finish', 'launch/configure']) {
    const r = dispatch(s, data, { type });
    assert.equal(r.ok, false, type);
  }
  assert.equal(s.log.filter((l) => l.includes('erro')).length, 0);
  const c = cloneState(s);
  assert.deepEqual(c, s);
});

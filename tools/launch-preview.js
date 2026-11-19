// Standalone preview harness for src/ui/launch-render (no game state). See src/ui/launch-render/README.md §6.
// Deterministic: a scene is simulated at fixed 1/60 s steps from its start to `t` seconds after its key
// moment, then drawn once (or animated live with anim=1). Screenshots are reproducible.

import { createLaunchRenderer, loadVehicleArt, descentCraftId } from '../src/ui/launch-render/index.js';
import { resolveStack, paintVehicle, paintCraft, craftArt, listVehicleArtIds, listCraftArtIds, setCraftResolver } from '../src/ui/launch-render/vehicles.js';
import { BODY_LOOK, SITE_STYLE, SUN, drawPlanetDisc, drawSky, drawTerrain, drawLaunchSite, drawStarfield, hash } from '../src/ui/launch-render/textures.js';
import { drawPlume, PROPELLANT } from '../src/ui/launch-render/fx.js';
import { buildProfile, telemetryAt, metAt, infraTimeline } from '../src/ui/launch-scene.js';
import { layoutBase, baseCounts, resolveTarget } from '../src/ui/launch-render/infra.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) && Number.isFinite(Number(Q.get(k))) ? Number(Q.get(k)) : d);
const errEl = document.getElementById('err');
const hudEl = document.getElementById('hud');
if (Q.get('help') === '1') document.getElementById('help').hidden = false;
if (Q.get('hud') === '0') hudEl.hidden = true;

const DT = 1 / 60;
const ASCENT_IDS = ['ignition', 'liftoff', 'maxq', 'staging', 'fairing_or_les', 'orbit', 'tli'];
const ARRIVALS = {
  moon: ['loi', 'descent', 'hazard_avoidance', 'touchdown'],
  mars: ['entry', 'parachute', 'powered_descent', 'touchdown'],
  titan: ['entry', 'parachute', 'rotor_flight', 'touchdown'],
  earth: ['lunar_flyby', 'return_burn', 'reentry', 'splashdown'],
  phobos: ['moi', 'quasi_orbit', 'touchdown'],
  orbit: ['moi'],
};

// ------------------------------------------------------------------ infrastructure presets (MISSIONS-V2 §7.3)
// SceneTarget snapshots like the sim's infra.sceneTarget(): stations (docking / berthing / first module) and
// surface bases by size tier, with 0–6 vehicles, on the Moon / Mars / Titan.
const ISS = [['st_core', 1], ['st_node', 3], ['st_lab', 3], ['st_hab', 1], ['st_solar', 4], ['st_airlock', 1], ['st_cupola', 1], ['st_logistics', 1], ['st_arm', 1]];
const mods = (list) => list.map(([id, n]) => ({ id, n }));
const BASE_TIERS = [
  [['bs_hab_small', 1], ['bs_solar', 2]],
  [['bs_hab_small', 2], ['bs_solar', 2], ['bs_pad', 1], ['bs_lab', 1]],
  [['bs_hab_small', 3], ['bs_solar', 4], ['bs_pad', 1], ['bs_lab', 1], ['bs_hab_large', 1], ['bs_greenhouse', 1], ['bs_comms', 1], ['bs_fission', 1]],
  [['bs_hab_small', 4], ['bs_solar', 5], ['bs_pad', 2], ['bs_lab', 2], ['bs_hab_large', 2], ['bs_greenhouse', 2], ['bs_comms', 1], ['bs_fission', 1], ['bs_dome', 3], ['bs_garage', 1], ['bs_isru', 1]],
  [['bs_hab_small', 4], ['bs_solar', 6], ['bs_pad', 2], ['bs_lab', 2], ['bs_hab_large', 3], ['bs_greenhouse', 3], ['bs_comms', 2], ['bs_fission', 2], ['bs_dome', 6], ['bs_garage', 1], ['bs_isru', 2], ['bs_factory', 1], ['bs_mass_driver', 1]],
  [['bs_hab_small', 4], ['bs_solar', 6], ['bs_pad', 2], ['bs_lab', 2], ['bs_hab_large', 3], ['bs_greenhouse', 3], ['bs_comms', 2], ['bs_fission', 2], ['bs_dome', 8], ['bs_garage', 1], ['bs_isru', 2], ['bs_factory', 2], ['bs_mass_driver', 1], ['bs_arcology', 3], ['bs_megastructure', 1]],
];
const BASE_VEH = [[], [['vh_lrv', 1]], [['vh_lrv', 1], ['vh_pressurized', 1]], [['vh_truck', 1], ['vh_crane', 1], ['vh_lrv', 1], ['vh_excavator', 1]], [['vh_truck', 2], ['vh_crane', 1], ['vh_pressurized', 1], ['vh_drone', 1], ['vh_excavator', 1]], [['vh_truck', 2], ['vh_crane', 1], ['vh_pressurized', 1], ['vh_drone', 1], ['vh_crawler', 1]]];
const VEH_N = ['vh_truck', 'vh_crane', 'vh_lrv', 'vh_pressurized', 'vh_excavator', 'vh_drone'];
const LANDER = { moon: 'blue_moon_mk1', mars: 'generic_mars_lander', titan: 'generic_lander' };
function presetOf(name, body) {
  const b = ['moon', 'mars', 'titan'].includes(body) ? body : 'moon';
  const site = b === 'moon' ? 'lunar_south_pole' : b === 'mars' ? 'mars_surface' : 'titan_surface';
  switch (name) {
    case 'iss': return { scene: 'dock', vehicle: 'falcon9', craft: 'crew_dragon', crewed: true, target: { kind: 'station', assetId: 'as_iss', name: 'ISS', sequence: 'dock', modules: mods(ISS), sizeTier: 3, bodyId: 'earth', payload: { kind: null } } };
    case 'salyut': return { scene: 'dock', vehicle: 'soyuz2', craft: 'soyuz_ms', crewed: true, target: { kind: 'station', assetId: 'as_salyut', name: 'Salyut', sequence: 'dock', modules: mods([['st_core', 1]]), bodyId: 'earth', payload: { kind: null } } };
    case 'tiangong': return { scene: 'dock', vehicle: 'long_march_7', craft: 'tianzhou', target: { kind: 'station', assetId: 'as_tiangong', name: 'Tiangong', sequence: 'dock', modules: mods([['st_core', 1], ['st_node', 1], ['st_lab', 2], ['st_arm', 1]]), bodyId: 'earth', payload: { kind: 'supply', qty: 6 } } };
    case 'arm': return { scene: 'berth', vehicle: 'atlas_v', craft: 'generic_cargo', target: { kind: 'station', assetId: 'as_iss', name: 'ISS', sequence: 'berth', modules: mods(ISS), bodyId: 'earth', traits: ['arm'], payload: { kind: 'supply', qty: 3 } } };
    case 'expand': return { scene: 'dock', vehicle: 'long_march_5', craft: 'tiangong_module', target: { kind: 'station', assetId: 'as_tiangong', name: 'Tiangong', sequence: 'dock', modules: mods([['st_core', 1], ['st_node', 1], ['st_lab', 1]]), bodyId: 'earth', payload: { kind: 'station_module', moduleId: 'st_lab' } } };
    case 'first': return { scene: 'release', vehicle: 'long_march_5', craft: 'tiangong_module', target: { kind: 'station', assetId: null, name: 'Aurora', newAsset: true, sequence: 'release', modules: [], bodyId: 'earth', payload: { kind: 'station_module', moduleId: 'st_core' } } };
    case 'ring': return { scene: 'dock', vehicle: 'falcon9', craft: 'crew_dragon', crewed: true, target: { kind: 'station', assetId: 'as_ring', name: 'Horizonte', sequence: 'dock', modules: mods([['st_core', 1], ['st_node', 2], ['st_hab', 3], ['st_solar', 4], ['st_centrifuge', 1], ['st_ring', 1], ['st_depot', 1], ['st_shipyard', 1]]), bodyId: 'earth', payload: { kind: null } } };
    case 'oneill': return { scene: 'dock', vehicle: 'starship', craft: 'starship_cargo', target: { kind: 'station', assetId: 'as_oneill', name: 'Ilha Três', sequence: 'dock', modules: mods([['st_core', 1], ['st_node', 1], ['st_cylinder', 1], ['st_solar', 2]]), bodyId: 'earth', payload: { kind: 'supply', qty: 40 } } };
    case 'gateway': return { scene: 'dock', vehicle: 'sls_b1', craft: 'orion', crewed: true, target: { kind: 'station', assetId: 'as_gateway', name: 'Gateway', sequence: 'dock', modules: mods([['st_core', 1], ['st_hab', 1], ['st_solar', 1]]), bodyId: 'moon', site: 'lunar_orbit', payload: { kind: null } } };
    default: {
      let m = /^base([0-5])$/.exec(name || '');
      if (m) { const tier = +m[1]; return { scene: 'base', craft: LANDER[b], body: b, target: { kind: 'base', assetId: 'as_base', name: 'Base Shackleton', sequence: 'surface', modules: mods(BASE_TIERS[tier]), vehicles: mods(BASE_VEH[tier]), sizeTier: tier, bodyId: b, site, payload: { kind: 'supply', qty: 2 } } }; }
      m = /^veh([0-6])$/.exec(name || '');
      if (m) { const n = +m[1]; const v = VEH_N.slice(0, n).map((id) => [id, 1]); return { scene: 'base', craft: LANDER[b], body: b, target: { kind: 'base', assetId: 'as_base', name: 'Base Alfa', sequence: 'surface', modules: mods(BASE_TIERS[2]), vehicles: mods(v), sizeTier: 2, bodyId: b, site, payload: { kind: 'base_module', moduleId: 'bs_hab_small' } } }; }
      if (name === 'newbase') return { scene: 'base', craft: LANDER[b], body: b, target: { kind: 'base', assetId: null, name: 'Base nova', newAsset: true, sequence: 'surface', modules: [], vehicles: [], sizeTier: 0, bodyId: b, site, payload: { kind: 'base_module', moduleId: 'bs_hab_small' } } };
      if (name === 'rover') return { scene: 'base', craft: LANDER[b], body: b, target: { kind: 'base', assetId: 'as_base', name: 'Base Alfa', sequence: 'surface', modules: mods(BASE_TIERS[1]), vehicles: mods([['vh_lrv', 1]]), sizeTier: 1, bodyId: b, site, payload: { kind: 'base_vehicle', vehicleTypeId: 'vh_pressurized', qty: 2 } } };
      return null;
    }
  }
}

/** A preset from a real SceneTarget (e.g. the JSON infra.sceneTarget() writes: [{label, t}]), by its sequence. */
function presetFromTarget(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.kind === 'base' || t.sequence === 'surface') {
    const b = ['moon', 'mars', 'titan'].includes(t.bodyId) ? t.bodyId : 'moon';
    return { scene: 'base', craft: LANDER[b], body: b, target: t };
  }
  const scene = t.sequence === 'release' ? 'release' : t.sequence === 'berth' ? 'berth' : 'dock';
  const module = t.payload?.kind === 'station_module' || scene === 'release';
  return { scene, vehicle: module ? 'long_march_5' : 'falcon9', craft: module ? 'tiangong_module' : scene === 'berth' ? 'generic_cargo' : 'crew_dragon', crewed: !module && scene === 'dock', target: t };
}

// ------------------------------------------------------------------ scene definitions

/** { mode, phase, world, ms (milestone ids), kind, key(times) -> clock of the key moment, flagsAt(clock, T), events (id -> event name) } */
function sceneDef(name, body) {
  const asc = (keyId, extra = {}) => ({ mode: 'ascent', phase: 'ascent', world: 'earth', ms: ASCENT_IDS, kind: null, key: (T) => T[keyId] ?? 0, ...extra });
  const landBody = ['mars', 'titan', 'phobos'].includes(body) ? body : body === 'earth' ? 'moon' : body;
  const arr = (world, ids, keyFn, kind = 'landing') => ({ mode: 'descent', phase: 'arrival', world, ms: ids, kind, key: keyFn });
  switch (name) {
    case 'pad': return asc('ignition', { mode: 'pad', key: () => 0, padOnly: true });
    case 'countdown': return asc('ignition', { mode: 'pad', key: () => 0, padOnly: true, window: true });
    case 'liftoff': return asc('liftoff');
    case 'maxq': return asc('maxq');
    case 'boostersep': return asc('staging', { key: (T) => T.maxq + (T.staging - T.maxq) * 0.7, altKey: 42 }); // visual sep fires at 42 km
    case 'staging': return asc('staging');
    case 'fairing': return asc('fairing_or_les');
    case 'orbit': return asc('orbit');
    case 'tli': return asc('tli');
    case 'explosion': return asc('maxq', { explodeAtKey: true });
    case 'escape': return asc('maxq', { explodeAtKey: true, escapeAtKey: true, crewed: true });
    case 'entry': return arr(body === 'titan' ? 'titan' : 'mars', ARRIVALS[body === 'titan' ? 'titan' : 'mars'], (T) => T.entry ?? T[0]);
    case 'chute': return arr(body === 'titan' ? 'titan' : 'mars', ARRIVALS[body === 'titan' ? 'titan' : 'mars'], (T) => T.parachute ?? T[1]);
    case 'descent': { const ids = ARRIVALS[landBody] || ARRIVALS.moon; return arr(landBody, ids, (T) => T.descent ?? T.powered_descent ?? T[ids[1]] ?? 0); }
    case 'landing': { const ids = ARRIVALS[landBody] || ARRIVALS.moon; return arr(landBody, ids, (T) => (T.touchdown ?? 0) - 3); }
    case 'touchdown': { const ids = ARRIVALS[landBody] || ARRIVALS.moon; return arr(landBody, ids, (T) => T.touchdown ?? 0); }
    case 'splashdown': return arr('earth', ARRIVALS.earth, (T) => T.splashdown ?? 0);
    case 'arrival': return { mode: 'orbit', phase: 'arrival', world: body === 'earth' ? 'mars' : body, ms: ARRIVALS.orbit, kind: 'orbit', key: (T) => T.moi ?? 0 };
    // infrastructure: rendezvous + docking / berthing (key = contact), module release (key = separation),
    // surface delivery to a base (key = touchdown; unload 1.5 s later)
    case 'dock': case 'berth': return { mode: 'rendezvous', phase: 'ascent', world: 'earth', ms: [...ASCENT_IDS.slice(0, 6), 'rendezvous', 'dock'], kind: null, key: (T) => T.dock, infra: true };
    case 'approach': return { mode: 'rendezvous', phase: 'ascent', world: 'earth', ms: [...ASCENT_IDS.slice(0, 6), 'rendezvous', 'dock'], kind: null, key: (T) => T.rendezvous, infra: true };
    case 'release': return { mode: 'rendezvous', phase: 'ascent', world: 'earth', ms: [...ASCENT_IDS.slice(0, 6), 'module_release'], kind: null, key: (T) => T.module_release, infra: true };
    case 'base': { const ids = ARRIVALS[landBody] || ARRIVALS.moon; return { ...arr(landBody, ids, (T) => T.touchdown ?? 0), base: true }; }
    default: return asc('liftoff');
  }
}

/** Milestone id -> renderer event (same regexes as launch-scene.js present()). */
function eventFor(id, phase, last, kind, world, infra) {
  if (id === 'rendezvous') return 'rendezvous';
  if (id === 'dock') return infra?.fail ? 'dockFail' : infra?.sequence === 'berth' ? 'berth' : 'dock';
  if (id === 'module_release') return 'release';
  if (phase === 'ascent') {
    if (id === 'ignition' || id === 'liftoff' || id === 'maxq' || id === 'tli') return id;
    if (/stag|separ|meco/.test(id)) return 'staging';
    if (/fairing|les|coifa/.test(id)) return 'fairing';
    if (/orbit/.test(id)) return 'seco';
    return null;
  }
  if (/parachute|paraq/.test(id)) return 'chute';
  if (/powered|descent|descida/.test(id)) return 'powered';
  if (/entry|reentry/.test(id)) return 'entry';
  if (last) return kind === 'orbit' ? 'capture' : world === 'earth' ? 'splashdown' : 'touchdown';
  return null;
}

function buildRun(opts) {
  const def = sceneDef(opts.scene, opts.body);
  const milestones = def.ms.map((id) => ({ id, label: id, status: 'ok' }));
  const profile = buildProfile(milestones, def.phase, def.world, def.kind || 'landing');
  const T = {};
  def.ms.forEach((id, i) => { T[id] = profile.times[i]; T[i] = profile.times[i]; });
  let key = Math.max(0, def.key(T));
  if (def.altKey) { // key = first clock where the telemetry altitude crosses altKey (km)
    for (let c = 0; c < (profile.times[profile.times.length - 1] || 60); c += 1 / 60) if (telemetryAt(profile, c).alt > def.altKey) { key = c; break; }
  }
  const lastT = profile.times[profile.times.length - 1] || 1;
  const crewed = opts.crewed ?? def.crewed ?? (craftArt(opts.craft).template === 'capsule' || craftArt(opts.craft).template === 'capsule_sm');
  const dockT = def.infra ? infraTimeline(profile, milestones) : null;
  return { def, milestones, profile, T, key, lastT, crewed, dockT };
}

function flagsAt(run, clock, opts = {}) {
  const { def, T, milestones } = run;
  const exploded = !!def.explodeAtKey && clock >= run.key;
  if (def.infra) {
    const docked = T.dock != null && clock >= T.dock && !opts.fail;
    return { engineOn: false, staged: true, fairingOff: true, exploded: false, escaped: false, landed: false, chute: false, inOrbit: true, hold: false,
      docked, dockFail: !!opts.fail && T.dock != null && clock >= T.dock, rvFail: false, rvAnomaly: !!opts.wobble, released: T.module_release != null && clock >= T.module_release };
  }
  if (def.phase === 'ascent') {
    const ign = T.ignition ?? 0;
    const tliOn = T.tli != null && clock >= T.tli;
    return {
      engineOn: !def.padOnly && !exploded && clock >= ign && (clock < (T.orbit ?? Infinity) || tliOn),
      staged: clock >= (T.staging ?? Infinity), fairingOff: clock >= (T.fairing_or_les ?? Infinity),
      exploded, escaped: !!def.escapeAtKey && exploded, landed: false, chute: false, inOrbit: false, hold: false,
    };
  }
  const lastId = milestones[milestones.length - 1].id;
  const done = (id) => T[id] != null && clock >= T[id];
  const complete = done(lastId);
  const chute = (done('parachute') || (def.world === 'earth' && done('reentry') && clock >= T.reentry + 4)) && !done('powered_descent') && !done('rotor_flight');
  return {
    engineOn: !exploded && !(def.kind === 'landing' && complete) && !(def.world === 'earth') && !chute,
    staged: true, fairingOff: true, exploded, escaped: false,
    landed: def.kind === 'landing' && complete, chute: chute && !(def.world === 'earth' && complete), inOrbit: def.kind === 'orbit' && complete, hold: false,
  };
}

function renderState(run, opts, clock, dt) {
  const tele = telemetryAt(run.profile, clock);
  return {
    view: { W: opts.w, H: opts.h }, t: clock, dt, reduce: opts.reduce, seed: opts.seed,
    mode: run.def.mode === 'pad' ? 'pad' : run.def.mode, phase: run.def.phase,
    tele: { altKm: run.def.padOnly ? 0 : tele.alt, velKms: run.def.padOnly ? 0 : tele.vel, met: metAt(run.profile, clock) },
    clock, progress: Math.max(0, Math.min(1, clock / run.lastT)), cd: run.def.padOnly ? 10 : null,
    vehicleId: opts.vehicle, craftId: opts.craft, landerId: opts.lander, crewed: run.crewed,
    bodyId: opts.body, world: run.def.world, siteId: opts.site || null,
    weather: { risk: opts.weather, label: '' }, flags: flagsAt(run, clock, opts),
    target: opts.target || null, dockT: run.dockT, night: opts.night,
  };
}

// ------------------------------------------------------------------ scene mode

const frameMs = [];
function runScene(ctx, opts) {
  const run = buildRun(opts);
  const R = createLaunchRenderer({ seed: opts.seed });
  const infraOpts = { fail: opts.fail, sequence: opts.target?.sequence };
  const warm = run.def.padOnly ? 4 : run.def.infra ? 8 : 5;
  const start = Math.max(run.def.infra ? run.dockT?.start ?? 0 : 0, run.key - warm);
  const end = Math.max(start, run.key + Math.max(-warm, opts.t));
  // events that already happened before the simulated window: recorded, no fx spawned
  const pre = {};
  run.def.ms.forEach((id, i) => {
    const ev = eventFor(id, run.def.phase, i === run.def.ms.length - 1, run.def.kind, run.def.world, infraOpts);
    if (ev && run.profile.times[i] < start) pre[ev] = run.profile.times[i];
  });
  if (run.def.base && run.T.touchdown != null && run.T.touchdown + 1.5 < start) pre.unload = run.T.touchdown + 1.5;
  if (run.def.phase === 'ascent' && start > (run.T.liftoff ?? 0)) pre.liftoff = run.T.liftoff;
  let clock = start;
  let first = true;
  let fired = new Set(Object.keys(pre));
  const stepTo = (target) => {
    while (clock < target - 1e-9) {
      const dt = Math.min(DT, target - clock);
      clock += dt;
      const rs = renderState(run, opts, clock, dt);
      if (first) { rs.events = pre; first = false; }
      R.update(rs);
      run.def.ms.forEach((id, i) => {
        const ev = eventFor(id, run.def.phase, i === run.def.ms.length - 1, run.def.kind, run.def.world, infraOpts);
        if (ev && !fired.has(ev) && clock >= run.profile.times[i]) { fired.add(ev); R.event(ev, ev === 'touchdown' ? { hard: false } : {}); }
      });
      if (run.def.base && !fired.has('unload') && run.T.touchdown != null && clock >= run.T.touchdown + 1.5) { fired.add('unload'); R.event('unload'); }
      if (run.def.explodeAtKey && !fired.has('explode') && clock >= run.key) { fired.add('explode'); R.event('explode'); if (run.def.escapeAtKey) R.event('escape'); }
    }
  };
  const drawNow = () => {
    const rs = renderState(run, opts, clock, 0);
    ctx.save();
    ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
    ctx.clearRect(0, 0, opts.w, opts.h);
    if (run.def.window) {
      ctx.fillStyle = '#0f1a33'; ctx.fillRect(0, 0, opts.w, opts.h);
      const rect = { x: opts.w * 0.04, y: opts.h * 0.03, w: opts.w * 0.92, h: opts.h * 0.74 }; // as large as the game's countdown panel allows
      R.drawPadWindow(ctx, rect, rs);
      ctx.strokeStyle = '#e9e7e1'; ctx.lineWidth = 3; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    } else { const t0 = performance.now(); R.draw(ctx, rs); frameMs.push(performance.now() - t0); }
    ctx.restore();
    const st = R.stats();
    const tg = resolveTarget(opts.target);
    const infoLine = tg ? `\n${opts.preset || ''} · ${tg.sequence} · ${tg.name || '—'} · tier ${tg.sizeTier} · ${tg.modules.length} tipos de módulo${tg.sequence === 'surface' ? ' · ' + Object.entries(baseCounts(layoutBase(tg, { z0: 40 }))).map(([k, v]) => k + ' ' + v).join(', ') : ''}` : '';
    hudEl.textContent = `${opts.scene} · ${opts.vehicle} · ${opts.craft} · ${run.def.world}${infoLine}\nclock ${clock.toFixed(2)} s (key ${run.key.toFixed(2)} + ${(clock - run.key).toFixed(2)})\nalt ${rs.tele.altKm.toFixed(3)} km · vel ${rs.tele.velKms.toFixed(2)} km/s\nparticles ${st.particles} · textures ${st.textures} (${(st.bytes / 1048576).toFixed(1)} MB) · frame ${frameMs.length ? frameMs[frameMs.length - 1].toFixed(1) : '—'} ms`;
    window.__frameMs = frameMs;
  };
  stepTo(end);
  drawNow();
  if (opts.bench > 0) { // frame-time budget check (README §1.6): update + draw per frame, warm caches first
    for (let i = 0; i < 30; i++) { stepTo(clock + DT); drawNow(); }
    for (let i = 0; i < 300; i++) drawNow(); // drain the progressive background jobs (Earth / terrain row builds) at a fixed clock
    frameMs.length = 0;
    const tot = [];
    for (let i = 0; i < opts.bench; i++) { const t0 = performance.now(); stepTo(clock + DT); drawNow(); tot.push(performance.now() - t0); }
    const q = (a, f) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))];
    const res = { draw50: q(frameMs, 0.5), draw95: q(frameMs, 0.95), frame50: q(tot, 0.5), frame95: q(tot, 0.95), n: tot.length };
    window.__bench = res;
    document.body.dataset.bench = JSON.stringify(res);
  }
  if (opts.anim) {
    let lastTs = 0;
    const loop = (ts) => {
      const d = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : DT;
      lastTs = ts;
      stepTo(clock + d);
      drawNow();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

// ------------------------------------------------------------------ galleries

function grid(n, W, H, minCell = 150) {
  const cols = Math.max(1, Math.min(n, Math.floor(W / minCell)));
  const rows = Math.ceil(n / cols);
  return { cols, rows, cw: W / cols, ch: H / rows };
}

function label(ctx, text, x, y, w) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, w, 16);
  ctx.fillStyle = '#e9e7e1'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(text, x + 4, y + 2, w - 8);
}

function eachCell(ctx, items, opts, minCell, fn) {
  const g = grid(items.length, opts.w, opts.h, minCell);
  items.forEach((it, i) => {
    const x = (i % g.cols) * g.cw, y = Math.floor(i / g.cols) * g.ch;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, g.cw, g.ch); ctx.clip();
    ctx.translate(x, y);
    try { fn(it, g.cw, g.ch); } catch (e) { ctx.fillStyle = '#ff8a7a'; ctx.fillText(String(e.message || e), 4, 20); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(233,231,225,0.12)'; ctx.strokeRect(x + 0.5, y + 0.5, g.cw - 1, g.ch - 1);
  });
}

function gallery(ctx, opts) {
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = '#0a0d14'; ctx.fillRect(0, 0, opts.w, opts.h);
  const light = SUN;
  const kind = opts.gallery;
  if (kind === 'vehicles') {
    const ids = listVehicleArtIds();
    const stacks = ids.map((id) => { const a = resolveStack(id, null, {}); const ref = a.art.refCraft; return ref ? resolveStack(id, ref, { crewed: true }) : a; });
    const tallest = Math.max(...stacks.map((s) => s.heightM));
    const g = grid(ids.length, opts.w, opts.h, 110);
    const k = (g.ch - 30) / tallest; // one common scale: real relative heights
    eachCell(ctx, stacks, opts, 110, (st, cw, ch) => {
      drawSky(ctx, { W: cw, H: ch }, 'earth', 3);
      ctx.save(); ctx.translate(cw / 2, ch - 8); paintVehicle(ctx, st, { pxPerM: k, light, flags: {} }); ctx.restore();
      label(ctx, `${st.art.name} · ${st.heightM.toFixed(0)} m`, 0, 0, cw);
    });
  } else if (kind === 'craft') {
    const ids = listCraftArtIds();
    eachCell(ctx, ids, opts, 130, (id, cw, ch) => {
      const c = craftArt(id);
      drawStarfield(ctx, { W: cw, H: ch }, { alpha: 0.6, seed: hash(id) });
      const k = Math.min((ch - 40) / Math.max(1, c.heightM), (cw - 16) / Math.max(1, c.widthM));
      const centred = ['probe', 'module', 'rover', 'rotorcraft', 'spaceplane'].includes(c.template);
      ctx.save(); ctx.translate(cw / 2, centred ? ch / 2 + 8 : ch - 10); paintCraft(ctx, c, { pxPerM: k, light, mode: 'flight', legs: 1 }); ctx.restore();
      label(ctx, `${c.name} [${c.template}]`, 0, 0, cw);
    });
  } else if (kind === 'bodies') {
    const ids = Object.keys(BODY_LOOK);
    eachCell(ctx, ids, opts, 120, (id, cw, ch) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
      drawPlanetDisc(ctx, id, cw / 2, ch / 2 + 6, Math.min(cw, ch) * 0.38, { light });
      label(ctx, id, 0, 0, cw);
    });
  } else if (kind === 'terrain') {
    const ids = ['moon', 'mars', 'mercury', 'europa', 'titan', 'ganymede', 'callisto', 'phobos', 'bennu', 'earth', 'generic'];
    eachCell(ctx, ids, opts, 180, (id, cw, ch) => {
      const view = { W: cw, H: ch };
      drawSky(ctx, view, id, 0.2);
      drawTerrain(ctx, view, id, { altM: 50, pxPerM: 3, groundY: ch * 0.55, seed: hash('site|' + id), light });
      label(ctx, id, 0, 0, cw);
    });
  } else if (kind === 'sites') {
    const styles = [...new Set(Object.values(SITE_STYLE)), 'generic'];
    const st = resolveStack(opts.vehicle, opts.craft, {});
    eachCell(ctx, styles, opts, 180, (style, cw, ch) => {
      const view = { W: cw, H: ch };
      const k = (ch * 0.5) / st.heightM;
      drawSky(ctx, view, 'earth', 0);
      drawLaunchSite(ctx, view, { style, groundY: ch * 0.82, pxPerM: k, tower: st.tower, towerHeightM: st.heightM * 1.05 });
      ctx.save(); ctx.translate(cw / 2, ch * 0.82); paintVehicle(ctx, st, { pxPerM: k, light, flags: {} }); ctx.restore();
      label(ctx, style, 0, 0, cw);
    });
  } else if (kind === 'plumes') {
    const props = Object.keys(PROPELLANT);
    const pressures = [1.013, 0.3, 0.02, 0];
    const cells = props.flatMap((p) => pressures.map((b) => ({ p, b })));
    eachCell(ctx, cells, opts, Math.max(80, opts.w / 4.2), ({ p, b }, cw, ch) => {
      ctx.fillStyle = b > 0.5 ? '#3d7fb8' : b > 0.1 ? '#163a6a' : '#02040a'; ctx.fillRect(0, 0, cw, ch);
      drawPlume(ctx, { x: cw / 2, y: 30, d: 1.2 }, { prop: p, pBar: b, pxPerM: Math.min(cw, ch) / 14, t: 1.234, seed: 3 });
      label(ctx, `${p} · ${b} bar`, 0, 0, cw);
    });
  } else {
    errEl.textContent = `gallery desconhecida: ${kind}`;
  }
  hudEl.textContent = `gallery=${kind}`;
}

// ------------------------------------------------------------------ boot

async function main() {
  const gal = Q.get('gallery');
  const opts = {
    vehicle: Q.get('vehicle') || 'falcon9', craft: Q.get('craft') || 'crew_dragon', lander: Q.get('lander') || null,
    body: Q.get('body') || 'moon', scene: Q.get('scene') || 'liftoff', t: num('t', 1),
    w: num('w', gal ? 1280 : 375), h: num('h', gal ? 860 : 700), dpr: Math.max(1, Math.min(2, num('dpr', 1))),
    reduce: Q.get('reduce') === '1', anim: Q.get('anim') === '1', seed: num('seed', hash(`${Q.get('vehicle') || 'falcon9'}|${Q.get('scene') || ''}`)),
    crewed: Q.has('crewed') ? Q.get('crewed') === '1' : undefined, site: Q.get('site') || null, weather: num('weather', 20),
    gallery: gal, bench: num('bench', 0),
  };
  // ?craftDesign=<JSON {name, geometry}> : a spacecraft designed in the Estaleiro (src/sim/craftdesigns.js geometry)
  if (Q.has('craftDesign')) {
    try {
      const cdz = JSON.parse(Q.get('craftDesign'));
      const sc = { id: 'csg_preview', name: cdz.name || 'Projeto', design: { geometry: cdz.geometry || cdz } };
      setCraftResolver((id) => (id === 'csg_preview' ? sc : null));
      opts.craft = 'csg_preview';
    } catch (e) { errEl.textContent = `craftDesign: ${e.message || e}`; }
  }
  let pre = presetOf(Q.get('preset'), Q.get('body') || 'moon');
  if (!pre && Q.has('targets')) { // ?targets=<url of [{label, t}]>&i=N : real sim snapshots
    try {
      const list = await (await fetch(Q.get('targets'))).json();
      const row = list[Math.max(0, Math.min(list.length - 1, num('i', 0)))];
      pre = presetFromTarget(row?.t || row);
      if (pre) Q.set('preset', `sim:${row?.label || num('i', 0)}`);
    } catch (e) { errEl.textContent = `targets: ${e.message || e}`; }
  }
  if (pre) {
    opts.preset = Q.get('preset');
    opts.scene = Q.get('scene') && Q.get('scene') !== 'liftoff' && Q.has('scene') ? Q.get('scene') : pre.scene;
    if (!Q.has('vehicle') && pre.vehicle) opts.vehicle = pre.vehicle;
    if (!Q.has('craft') && pre.craft) opts.craft = pre.craft;
    if (!Q.has('crewed') && pre.crewed != null) opts.crewed = pre.crewed;
    if (pre.body) opts.body = pre.body;
    opts.target = pre.target;
    if (!Q.has('seed')) opts.seed = hash(`${opts.preset}|${opts.scene}`);
  }
  opts.fail = Q.get('fail') === '1'; opts.wobble = Q.get('wobble') === '1'; opts.night = Q.get('night') === '1';
  await loadVehicleArt();
  const cv = document.getElementById('cv');
  cv.width = Math.round(opts.w * opts.dpr); cv.height = Math.round(opts.h * opts.dpr);
  cv.style.width = `${opts.w}px`; cv.style.height = `${opts.h}px`;
  const ctx = cv.getContext('2d');
  if (gal) gallery(ctx, opts);
  else runScene(ctx, opts);
  window.__preview = { ready: true, opts, descentCraft: descentCraftId({ world: opts.body, craftId: opts.craft, landerId: opts.lander }) };
  document.title = `ready · ${gal ? 'gallery ' + gal : opts.scene}`;
}

main().catch((e) => { errEl.textContent = `Erro: ${e?.stack || e}`; console.error(e); document.title = 'error'; });

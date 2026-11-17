// Standalone preview harness for src/ui/launch-render (no game state). See src/ui/launch-render/README.md §6.
// Deterministic: a scene is simulated at fixed 1/60 s steps from its start to `t` seconds after its key
// moment, then drawn once (or animated live with anim=1). Screenshots are reproducible.

import { createLaunchRenderer, loadVehicleArt, descentCraftId } from '../src/ui/launch-render/index.js';
import { resolveStack, paintVehicle, paintCraft, craftArt, listVehicleArtIds, listCraftArtIds } from '../src/ui/launch-render/vehicles.js';
import { BODY_LOOK, SITE_STYLE, SUN, drawPlanetDisc, drawSky, drawTerrain, drawLaunchSite, drawStarfield, hash } from '../src/ui/launch-render/textures.js';
import { drawPlume, PROPELLANT } from '../src/ui/launch-render/fx.js';
import { buildProfile, telemetryAt, metAt } from '../src/ui/launch-scene.js';

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
    default: return asc('liftoff');
  }
}

/** Milestone id -> renderer event (same regexes as launch-scene.js present()). */
function eventFor(id, phase, last, kind, world) {
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
  return { def, milestones, profile, T, key, lastT, crewed };
}

function flagsAt(run, clock) {
  const { def, T, milestones } = run;
  const exploded = !!def.explodeAtKey && clock >= run.key;
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
    weather: { risk: opts.weather, label: '' }, flags: flagsAt(run, clock),
  };
}

// ------------------------------------------------------------------ scene mode

function runScene(ctx, opts) {
  const run = buildRun(opts);
  const R = createLaunchRenderer({ seed: opts.seed });
  const warm = run.def.padOnly ? 4 : 5;
  const start = Math.max(0, run.key - warm);
  const end = run.key + Math.max(0, opts.t);
  // events that already happened before the simulated window: recorded, no fx spawned
  const pre = {};
  run.def.ms.forEach((id, i) => {
    const ev = eventFor(id, run.def.phase, i === run.def.ms.length - 1, run.def.kind, run.def.world);
    if (ev && run.profile.times[i] < start) pre[ev] = run.profile.times[i];
  });
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
        const ev = eventFor(id, run.def.phase, i === run.def.ms.length - 1, run.def.kind, run.def.world);
        if (ev && !fired.has(ev) && clock >= run.profile.times[i]) { fired.add(ev); R.event(ev, ev === 'touchdown' ? { hard: false } : {}); }
      });
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
      const rect = { x: opts.w * 0.06, y: opts.h * 0.05, w: opts.w * 0.88, h: opts.h * 0.5 };
      R.drawPadWindow(ctx, rect, rs);
      ctx.strokeStyle = '#e9e7e1'; ctx.lineWidth = 3; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    } else R.draw(ctx, rs);
    ctx.restore();
    const st = R.stats();
    hudEl.textContent = `${opts.scene} · ${opts.vehicle} · ${opts.craft} · ${run.def.world}\nclock ${clock.toFixed(2)} s (key ${run.key.toFixed(2)} + ${(clock - run.key).toFixed(2)})\nalt ${rs.tele.altKm.toFixed(3)} km · vel ${rs.tele.velKms.toFixed(2)} km/s\nparticles ${st.particles} · textures ${st.textures} (${(st.bytes / 1048576).toFixed(1)} MB)`;
  };
  stepTo(end);
  drawNow();
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
    gallery: gal,
  };
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

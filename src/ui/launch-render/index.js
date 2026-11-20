// launch-render/index.js — scene composer. The ONLY module launch-scene.js (and tools/launch-preview.js)
// talk to. Builds each frame from a RenderState snapshot (README.md §3) plus events (§4).
// STUB (architect pass, owned by the integrator): composes the other modules' stubs into a complete,
// consistent picture so the preview harness works end to end. Builders improve their modules; this file
// only orchestrates (order of layers, event → fx/debris, camera).

import { hash, SUN, sunFor, drawSky, drawStarfield, drawEarthLimb, drawClouds, drawCloudsFront, drawLaunchSite, siteStyleOf, drawTerrain, drawGroundShadow, drawPlanetDisc, textureStats, drawBodyLimb, prewarmBodyLimb, prewarmEarthLimb, prewarmMaps, prewarmSprites, LIMB_BUCKETS } from './textures.js';
import { resolveStack, attachedParts, detachedBy, activeNozzles, paintVehicle, paintPart, paintCraft, craftArt, craftNozzles, payloadMount, breakupPieces } from './vehicles.js';
import { createFx, ambientPressure, drawPlume, drawCondensationCollar, drawParachutes, drawReentryPlasma, prewarmPlumes } from './fx.js';
import { createCamera, ascentFrame, descentFrame, orbitFrame, baseFrameHeightM } from './camera.js';
import { resolveTarget, layoutStation, paintStation, paintModule, moduleSize, drawArm, dockPose, releasePose, groundProjection, baseHorizonY, layoutBase, drawBase, drawBaseVehicles } from './infra.js';

export { SUN } from './textures.js';
export { loadVehicleArt, setVehicleArt } from './vehicles.js';
export { resolveTarget, layoutStation, layoutBase, dockPose, releasePose } from './infra.js';

// ---------------------------------------------------------------- infrastructure targets (MISSIONS-V2 §7)
const LAYOUT_CACHE = new Map();
function memoLayout(key, make) {
  let v = LAYOUT_CACHE.get(key);
  if (!v) { v = make(); LAYOUT_CACHE.set(key, v); if (LAYOUT_CACHE.size > 12) LAYOUT_CACHE.delete(LAYOUT_CACHE.keys().next().value); }
  return v;
}
const stationLayoutOf = (tg, seed) => memoLayout(`st|${tg.sig}|${seed}`, () => layoutStation(tg.modules, { seed: hash(String(tg.assetId || tg.name || 'st')) ^ (seed & 7) }));
/** The descent's base layout uses the touchdown distance of the nominal descent framing (stable all scene long). */
function baseLayoutOf(tg, rs, craft) {
  const H = rs.view?.H || 700;
  const hM = baseFrameHeightM(craft?.heightM || 4); // same framing height as camera.descentFrame over a base
  const z0 = H / Math.max(0.4, Math.min(60, (H * 0.2) / hM));
  return memoLayout(`bs|${tg.sig}|${Math.round(z0)}|${Math.round(craft?.widthM || 4)}`, () => layoutBase(tg, { seed: hash(String(tg.assetId || tg.name || 'base')), z0, landerW: Math.max(3, Math.min(14, craft?.widthM || 4)) }));
}
/** What flies in the rendezvous scene: a station module flies itself, otherwise the mission's spacecraft. */
function rvCraftOf(rs, tg) {
  const modArt = tg?.payloadArt && (tg.payload?.kind === 'station_module' || /^st_/.test(tg.payload?.moduleId || '')) ? tg.payloadArt : null;
  if (modArt) { const sz = moduleSize(modArt); return { type: 'module', art: modArt, lenM: sz.lenM, dM: sz.dM, noseM: sz.lenM / 2 }; }
  const c = craftArt(rs.craftId);
  const centred = ['probe', 'module', 'rover', 'spaceplane'].includes(c.template);
  const h = Math.max(1, c.heightM || 4);
  return { type: 'craft', craft: c, lenM: h, dM: Math.max(1, c.widthM || 3), noseM: centred ? h / 2 : h, centred };
}

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const AIRLESS = new Set(['moon', 'mercury', 'europa', 'ganymede', 'callisto', 'io', 'phobos', 'deimos', 'ceres', 'vesta', 'enceladus', 'triton', 'pluto', 'charon']);

/** Lander/capsule actually drawn in a descent (a crewed Orion mission lands in its partner lander). */
export function descentCraftId(rs) {
  if (rs.world === 'earth') return rs.craftId || 'crew_dragon';
  const c = craftArt(rs.craftId);
  if (c && (c.template === 'lander' || c.template === 'starship' || c.template === 'aeroshell' || c.template === 'rotorcraft')) return rs.craftId;
  if (rs.landerId) return rs.landerId;
  return rs.world === 'mars' ? 'generic_mars_lander' : 'generic_lander';
}

/**
 * Visual altitude for landings: the sim's telemetry keys can still read tens of metres at the touchdown
 * milestone; over the last ~5 % of the arrival timeline the picture eases the altitude to zero so the
 * footpads actually meet the ground (dust, shadow and leg contact line up). Presentation only.
 */
function visualRS(rs) {
  if (!rs || rs.mode !== 'descent' || rs.world === 'earth' || rs.flags?.landed || rs.flags?.chute) return rs;
  const p = Number(rs.progress);
  if (!Number.isFinite(p)) return rs;
  const k = Math.max(0, Math.min(1, (1 - p) / 0.05));
  if (k >= 1) return rs;
  const e = k * k * (3 - 2 * k);
  return { ...rs, tele: { ...(rs.tele || {}), altKm: (rs.tele?.altKm || 0) * e } };
}

/** Mars/Titan/Venus EDL: is the descent craft still inside its aeroshell, and has the heat shield gone? */
const EDL_WORLDS = new Set(['mars', 'titan', 'venus']);
function encapsulated(c) { return !!c && (c.template === 'rotorcraft' || c.template === 'rover' || (c.template === 'lander' && !!c.aeroshell)); }
/** Does this craft descend inside an aeroshell on `world`? Only on worlds with an atmosphere (Mars, Titan, Venus). */
export function descendsInAeroshell(craft, world) { return EDL_WORLDS.has(world) && encapsulated(craft); }
function edlStage(rs, craft, world, flags, evs) {
  const encaps = EDL_WORLDS.has(world) && encapsulated(craft);
  if (!encaps) return { encaps: false, shell: null, shieldOff: false };
  const ev = evs || rs.events || {};
  const powered = ev.powered != null && !flags.chute;
  if (flags.landed || powered) return { encaps: true, shell: null, shieldOff: true };
  const D = craft.aeroshell?.d || (craft.template === 'rotorcraft' ? 3.75 : 4.5);
  const shell = SHELLS.get(craft.id || craft.name) || { name: (craft.name || '') + ' aeroshell', template: 'aeroshell', shellD: D, backshellMat: 'white_paint', inner: descentCraftId(rs) };
  SHELLS.set(craft.id || craft.name, shell);
  const tc = ev.chute;
  const shieldOff = !!flags.chute && tc != null && rs.t - tc > 2.2;
  return { encaps: true, shell, shieldOff };
}
const SHELLS = new Map();

/** Core (centre) stage diameter: where the tower umbilicals attach. */
function coreDiameter(st) {
  const p = (st?.parts || []).find((q) => !q.x && (q.role === 'stage' || q.role === 'upper'));
  return p?.d || st?.art?.diameterM || 4;
}

/** Height (m above the footpad plane) of the highest firing nozzle exit: where the plume starts to hit the ground. */
function nozzleHeightM(craft) {
  const n = craftNozzles(craft, { mode: 'flight', legs: 1, engineOn: true });
  return n.length ? Math.max(0, ...n.map((q) => q.y || 0)) : 0;
}

export function createLaunchRenderer({ seed = 1, cap = 600 } = {}) {
  const fx = createFx({ seed, cap });
  const cam = createCamera();
  let events = {};
  let last = null;     // last RenderState seen by update()
  let prevGround = null;
  const clock = { t: 0, alt: 0, reduce: false };
  // continuous exhaust trail / contrail: screen points that move with the world like the smoke particles
  const TRAIL_N = 240;
  const trail = { x: new Float32Array(TRAIL_N), y: new Float32Array(TRAIL_N), age: new Float32Array(TRAIL_N), w: new Float32Array(TRAIL_N), n: 0, head: 0, acc: 0, prop: 'kerolox' };
  const trailShift = (dx, dy) => { for (let i = 0; i < trail.n; i++) { trail.x[i] += dx; trail.y[i] += dy; } }; // read by debris painters (tail-off plumes, fin deployment)

  const sepState = { done: false };
  let ullAcc = 0, ignFlash = false;
  // upper-stage ignition after staging: a few seconds of coast (cold-gas push-off, ullage) before the vacuum
  // engine lights; its radiatively-cooled extension then heats from dark grey to dull red-orange
  const S2_IGN = 2.6;
  const s2Since = (rs) => (rs.flags?.staged && events.staging != null ? Number(rs.t) - events.staging : Infinity);
  const flagsOf = (rs) => ({
    ...(rs.flags || {}),
    ...(rs.flags?.staged && s2Since(rs) < S2_IGN ? { engineOn: false } : {}),
    s2Glow: rs.flags?.staged ? 0.85 * sstep(S2_IGN, S2_IGN + 3, s2Since(rs)) : 0.85,
    s2Throttle: rs.flags?.staged ? sstep(S2_IGN, S2_IGN + 0.6, s2Since(rs)) : 1,
    boostersOff: !!(rs.flags?.boostersOff || events.boosterSep != null || rs.flags?.staged), payloadSep: sepState.done,
    // Orion-style service-module arrays unfold over ~4 s, a few seconds after the LAS / fairing jettison
    arraysK: events.fairing != null ? Math.max(0, Math.min(1, (Number(rs.t) - events.fairing - 2.5) / 4)) : rs.flags?.fairingOff && events.fairing == null ? 1 : 0,
  });

  /** Spacecraft separation ~1.5 s after SECO: springs push it off the adapter, it drifts away slowly, arrays out. */
  function payloadRelease(rs, st, flags) {
    if (sepState.done || events.seco == null || rs.t - events.seco < 1.5 || flags.exploded || !flags.fairingOff) return;
    const pm = payloadMount(st, flags);
    if (!pm) { sepState.done = true; return; }
    sepState.done = true;
    const fr = ascentFrame(rs, st.heightM);
    const ppm = fr.pxPerM, light = lightOf(rs);
    const at = toScreen(fr, 0, pm.y);
    const ux = Math.sin(fr.tilt), uy = -Math.cos(fr.tilt);
    const craft = pm.craft;
    const t0 = rs.t;
    fx.addDebris({
      paint: (c) => {
        const age = clock.t - t0;
        const k = ppm * pm.scale;
        paintCraft(c, craft, { pxPerM: k, light, mode: age > 2.5 ? 'flight' : 'stack', legs: 0, t: clock.t });
      },
      x: at.x, y: at.y, vx: ux * 0.7 * ppm, vy: uy * 0.7 * ppm, gravity: 0, drag: 0, rel: true, rot: fr.tilt, vr: 0.035, life: 600, recede: 0.004,
    });
    fx.jet(at.x, at.y, Math.atan2(-uy, -ux), { ppm: Math.max(0.6, ppm * 0.4), hot: false, len: 0.4 });
  }
  /** The camera reads event times (staging re-framing) from rs.events: give it the renderer's own record too. */
  const withEvents = (rs) => (events.staging != null && rs.events?.staging == null ? { ...rs, events: { ...(rs.events || {}), staging: events.staging } } : rs);
  const stackOf = (rs) => resolveStack(rs.vehicleId, rs.craftId, { crewed: !!rs.crewed });
  const lightOf = (rs) => rs.light || sunFor(rs.mode, rs.world, rs.siteId) || SUN;

  /** Nozzle (vehicle metres) → screen px under the ascent frame. */
  function toScreen(fr, xM, yM) {
    const c = Math.cos(fr.tilt), s = Math.sin(fr.tilt);
    const lx = xM * fr.pxPerM, ly = -yM * fr.pxPerM;
    return { x: fr.anchorX + lx * c - ly * s, y: fr.anchorY + lx * s + ly * c };
  }

  function vehicleScreenPos(rs) {
    if (!rs) return { x: 0, y: 0 };
    if (rs.mode === 'orbit') { const o = orbitFrame(rs); return { x: o.craftX, y: o.craftY }; }
    if (rs.mode === 'rendezvous') return rvCraftScreen(rs);
    if (rs.mode === 'descent') { const c = craftArt(descentCraftId(rs)); const d = descentFrame(rs, c.heightM); return { x: d.craftX, y: d.craftY - (c.heightM * d.pxPerM) / 2 }; }
    const st = stackOf(rs);
    const fr = ascentFrame(rs, st.heightM);
    return toScreen(fr, 0, st.heightM * 0.5);
  }

  function spawnDetached(rs, name) {
    if (rs.mode !== 'ascent' && rs.mode !== 'pad') return;
    const st = stackOf(rs);
    const prev = flagsOf(rs);
    if (name === 'staging') prev.staged = false;
    if (name === 'fairing') prev.fairingOff = false;
    if (name === 'boosterSep') prev.boostersOff = false;
    const fr = ascentFrame(rs, st.heightM);
    const light = lightOf(rs);
    const ppm = fr.pxPerM;
    const ux = Math.sin(fr.tilt), uy = -Math.cos(fr.tilt); // vehicle "up" on screen
    const qx = Math.cos(fr.tilt), qy = Math.sin(fr.tilt);  // across (+x side)
    const t0 = rs.t;
    const reusable = !!st.art?.reuse;
    for (const p of detachedBy(st, name, prev)) {
      if (p.role === 'booster' || p.role === 'stage') {
        addSep(rs, st, p, reusable);
        if (seps[seps.length - 1]?.kind === 'srb') { // booster separation motors: forward (nose) + aft clusters firing outward
          const side = Math.sign(p.x || 0) || 1, L = (p.len || 30) * ppm, at = toScreen(fr, p.x || 0, p.y || 0);
          for (const along of [0.93, 0.07]) {
            const bx = at.x + ux * L * along + qx * side * (p.d || 3) * 0.5 * ppm, by = at.y + uy * L * along + qy * side * (p.d || 3) * 0.5 * ppm;
            const ang = Math.atan2(qy * side, qx * side);
            fx.jet(bx, by, ang, { ppm, hot: true, len: 1.1 });
            fx.jet(bx, by, ang + (along > 0.5 ? -0.5 : 0.5) * side, { ppm, hot: true, len: 0.7 });
          }
        }
        continue;
      }
      const halves = p.role === 'fairing' && !p.hippo ? [':L', ':R'] : [''];
      for (const h of halves) {
        const part = h ? { ...p, id: p.id + h } : p;
        const at = toScreen(fr, p.x || 0, p.y || 0);
        const side = h === ':L' ? -1 : h === ':R' ? 1 : Math.sign(p.x || 0) || (p.role === 'stage' ? -1 : 1);
        // physics in the frame of the still-accelerating vehicle (metres → px): the dropped part keeps the vehicle's
        // velocity, gets a small lateral kick, and falls back along the axis at the vehicle's thrust acceleration
        const aRel = (p.role === 'booster' ? 16 : p.role === 'stage' ? 9 : p.role === 'les' ? -6 : 13) * ppm;
        const lat = (p.role === 'booster' ? 9 : p.role === 'fairing' ? 6 : p.role === 'stage' ? 0.6 : 3) * ppm * side;
        const spin = p.role === 'booster' ? side * 0.2 : p.role === 'fairing' ? side * 0.75 : p.role === 'stage' ? -0.04 : side * 0.4;
        const ageOf = () => clock.t - t0;
        const bell = p.engines ? (p.engines.bellLen || 1) : 0;
        const tailOff = p.role === 'booster' && p.engines?.prop === 'solid';
        fx.addDebris({
          paint: (ctx) => {
            const age = ageOf();
            if (tailOff && age < 1.3 && !clock.reduce) { // SRB tail-off: a dying, smoky plume for ~1 s
              drawPlume(ctx, { x: 0, y: bell * ppm, d: p.engines.bellD || 3 }, { prop: 'solid', pBar: ambientPressure('earth', clock.alt), pxPerM: ppm, t: clock.t, throttle: Math.max(0.05, 1 - age / 1.3) * 0.8, seed: 7 });
            }
            const fins = p.role === 'stage' && p.gridFins ? Math.max(0, Math.min(1, (age - 0.8) / 1.2)) : 0;
            paintPart(ctx, st, part, { pxPerM: ppm, light, tilt: fr.tilt, finsOut: fins, glow: 0 });
          },
          x: at.x, y: at.y, vx: qx * lat, vy: qy * lat,
          ax: -ux * aRel, ay: -uy * aRel, gravity: 0, drag: p.role === 'fairing' ? 0.25 : 0.04, rel: true,
          rot: fr.tilt, vr: spin, life: p.role === 'stage' ? 9 : 7, recede: p.role === 'fairing' ? 0.03 : 0.012,
          tick: (o, d, f) => {
            const age = ageOf();
            if (p.role === 'stage' && reusable && age > 1.0 && age < 5) { // cold-gas N2 thrusters at the top flip the booster
              o.vr += -0.12 * d;
              o.puff = (o.puff || 0) + d;
              if (o.puff > 0.22) {
                o.puff = 0;
                const L = (p.len || 40) * ppm, sx = Math.sin(o.rot), sy = -Math.cos(o.rot), cx2 = Math.cos(o.rot), cy2 = Math.sin(o.rot);
                const tx = o.x + sx * L * 0.96, ty = o.y + sy * L * 0.96;
                const dir = Math.atan2(cy2, cx2) + (Math.sin(age * 7) > 0 ? 0 : Math.PI);
                f.jet(tx, ty, dir, { ppm: Math.max(0.6, ppm * 0.6), hot: false, len: 0.7 });
              }
            }
          },
        });
        if (p.role === 'booster') { // booster separation motors: 4 forward (nose) + 4 aft per booster, firing outward
          const L = (p.len || 30) * ppm;
          for (const along of [0.92, 0.95, 0.06, 0.1]) {
            const bx = at.x + ux * L * along + qx * side * (p.d || 3) * 0.5 * ppm, by = at.y + uy * L * along + qy * side * (p.d || 3) * 0.5 * ppm;
            const ang = Math.atan2(qy * side, qx * side) + (along > 0.5 ? -0.5 : 0.5) * side * 0;
            fx.jet(bx, by, ang, { ppm, hot: true, len: 1.2 });
            fx.jet(bx, by, ang + (along > 0.5 ? -0.6 : 0.6) * side, { ppm, hot: true, len: 0.8 });
          }
        }
      }
    }
    const sep = toScreen(fr, 0, st.heightM * (name === 'fairing' ? 0.85 : 0.45));
    if (name === 'fairing') fx.fairingPuff(sep.x, sep.y, { angle: fr.tilt, pxPerM: fr.pxPerM });
    else fx.staging(sep.x, sep.y, { angle: fr.tilt, pxPerM: fr.pxPerM });
  }

  // ---------------------------------------------------------------- separated stages / boosters
  // Kept in vehicle metres relative to the still-flying stack (x across, y along its axis, centre of mass), so
  // they stay consistent while the camera re-frames / zooms on the upper stage. Physically paced: a few m/s of
  // outward push, a few degrees per second of rotation, relative deceleration so they fall behind; reusable
  // cores flip with nitrogen RCS puffs, deploy grid fins and start the boostback; everything recedes in depth.
  const seps = [];
  function addSep(rs, st, p, reusable) {
    const side = Math.sign(p.x || 0) || 0;
    const solid = p.role === 'booster' && (p.engines?.prop === 'solid' || (!p.engines?.prop && /srb|gem|p120|eap|s200|pso/i.test(p.id || '')));
    const soyuz = /soyuz/.test(st.vehicleId || '') && p.role === 'booster';
    const kind = p.role === 'stage' ? 'stage' : solid ? 'srb' : 'liq';
    const flip = kind === 'stage' ? reusable && !!p.gridFins : kind === 'liq' && !!p.gridFins;
    const len = p.len || 30;
    seps.push({
      p, st, kind, side, flip, soyuz, t0: rs.t, len,
      cx: p.x || 0, cy: (p.y || 0) + len / 2, ref: p.role === 'stage' ? (p.y || 0) + len : (p.y || 0) + len * 0.6,
      vx: kind === 'stage' ? 0 : side * (solid ? 4 : soyuz ? 2.5 : 3.2),
      vy: kind === 'stage' ? -1.4 : -0.5,
      rot: 0, vr: kind === 'stage' ? (flip ? 0 : -0.035) : side * (solid ? 0.09 : soyuz ? 0.42 : 0.03),
      depth: 0, puff: 0, smoke: 0,
      life: kind === 'stage' ? 10.5 : kind === 'liq' ? 11 : 9,
    });
    if (seps.length > 8) seps.shift();
  }
  function stepSeps(rs, dt, fr) {
    for (let i = seps.length - 1; i >= 0; i--) {
      const s = seps[i];
      const age = rs.t - s.t0;
      if (age > s.life || age < -1) { seps.splice(i, 1); continue; }
      let ay;
      if (s.kind === 'srb') ay = -11;
      else if (s.kind === 'liq') ay = -(s.soyuz ? 9 : 6) * Math.min(1, age / 1.5);
      else ay = age < S2_IGN ? -0.25 : -1.6 * Math.min(1, (age - S2_IGN) / 1.5);
      s.vy += ay * dt;
      s.cx += s.vx * dt; s.cy += s.vy * dt;
      if (s.flip && age > 1.3) { // N2 cold-gas thrusters at the top flip the stage (slow, ~12 deg/s)
        const dir = s.kind === 'stage' ? -1 : s.side || -1;
        if (Math.abs(s.vr) < 0.21) s.vr += dir * 0.07 * dt;
        if (!rs.reduce && age < 8) {
          s.puff += dt;
          if (s.puff > 0.3) {
            s.puff = 0;
            const top = sepPoint(fr, s, 0, s.len * 0.47);
            const a = fr.tilt + s.rot;
            const out = Math.sin(age * 5.3) > 0 ? 1 : -1;
            fx.rcs(top.x, top.y, a + (out > 0 ? 0 : Math.PI));
          }
        }
      }
      s.rot += s.vr * dt;
      s.depth += dt * (s.kind === 'stage' ? (age < S2_IGN ? 0.015 : 0.25) : s.kind === 'srb' ? 0.06 : 0.05);
      if (s.kind === 'srb' && !rs.reduce && age < 3.5) { // residual smoke from the burnt-out motor
        s.smoke += dt;
        if (s.smoke > 0.09) {
          s.smoke = 0;
          const n = sepPoint(fr, s, 0, -s.len * 0.5);
          const a = fr.tilt + s.rot + Math.PI / 2;
          fx.jet(n.x, n.y, a, { ppm: Math.max(0.6, fr.pxPerM * 0.7), hot: false, len: 0.6 * (1 - age / 3.5) + 0.2 });
        }
      }
    }
  }
  /** Screen point of a separated body's local point (metres from its centre of mass, y up its axis). */
  function sepPoint(fr, s, lx, ly) {
    const sc = 1 / (1 + s.depth);
    const c = Math.cos(s.rot), sn = Math.sin(s.rot);
    const wx = s.cx + (lx * c + ly * sn), wy = s.cy + (-lx * sn + ly * c);
    const ref = s.ref; // perspective about the base of the tracked upper stack
    return toScreen(fr, wx * sc, ref + (wy - ref) * sc);
  }
  function drawSeps(ctx, rs, fr, light) {
    for (const s of seps) {
      const age = rs.t - s.t0;
      const sc = 1 / (1 + s.depth);
      const c = sepPoint(fr, s, 0, 0);
      const ppm = fr.pxPerM * sc;
      const L = s.len * ppm;
      if (L < 1) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (s.life - age) / 2));
      ctx.translate(c.x, c.y);
      ctx.rotate(fr.tilt + s.rot);
      ctx.translate(0, L / 2);
      const e = s.p.engines;
      const bell = e ? (e.bellLen || 1) : 0;
      const pBar = ambientPressure('earth', clock.alt);
      if (s.kind === 'srb' && age < 1.3 && !rs.reduce && e) { // SRB tail-off: a dying, smoky plume
        drawPlume(ctx, { x: 0, y: bell * ppm, d: e.bellD || 3 }, { prop: 'solid', pBar, pxPerM: ppm, t: rs.t, throttle: Math.max(0.05, 1 - age / 1.3) * 0.7, seed: 7 });
      }
      if (s.flip && e && age > 7 && age < s.life - 0.3) { // boostback burn: three engines relight, plume up-range
        const thr = Math.min(1, (age - 7) / 0.5);
        drawPlume(ctx, { x: 0, y: bell * ppm, d: (e.bellD || 0.9) * 1.6 }, { prop: e.prop || 'kerolox', pBar, pxPerM: ppm, t: rs.t, throttle: thr * 0.5, lengthM: s.len * 0.9, reduce: rs.reduce, seed: 11 });
      }
      const fins = s.flip ? Math.max(0, Math.min(1, (age - 1.6) / 1.8)) : 0;
      paintPart(ctx, s.st, s.p, { pxPerM: ppm, light, tilt: fr.tilt + s.rot, finsOut: fins, glow: 0 });
      ctx.restore();
    }
  }

  /**
   * Falcon transporter-erector strongback: a white lattice column beside the stack with clamp arms on the
   * first and second stage. It rocks back a few degrees (arms open) in the last seconds of the count and stays
   * on the pad after liftoff. ox/oy = pad centre on screen (vehicle base), k = px per metre.
   */
  function drawStrongback(ctx, st, k, ox, oy, retract, light) {
    if (st.art?.family !== 'falcon' || !(k > 0.2)) return;
    const R = coreDiameter(st) / 2;
    const top = Math.min(st.heightM, (Number(st.art?.payloadTop) || st.heightM) + 0.5);
    const x0 = R + 1.0, w = 2.4, hinge = x0 + w;
    const a = Math.max(0, Math.min(1, retract)) * 0.07;
    const lit = (Number(light?.ax) || -0.6) < 0; // sun from the left: the vehicle-facing chord is lit
    ctx.save();
    ctx.translate(ox + hinge * k, oy);
    ctx.rotate(a);
    ctx.translate(-hinge * k, 0);
    // chords
    const cw = Math.max(0.7, 0.32 * k);
    ctx.fillStyle = lit ? '#e6e6e2' : '#b9bbbb'; ctx.fillRect(x0 * k, -top * k, cw, top * k);
    ctx.fillStyle = lit ? '#a9abac' : '#d6d6d2'; ctx.fillRect((x0 + w) * k - cw, -top * k, cw, top * k);
    // zig-zag bracing + horizontal battens
    ctx.strokeStyle = 'rgba(205,206,204,0.85)'; ctx.lineWidth = Math.max(0.5, 0.14 * k);
    ctx.beginPath();
    const bay = 2.6;
    for (let y = 0, i = 0; y < top - 0.1; y += bay, i++) {
      const y1 = Math.min(top, y + bay);
      ctx.moveTo((i % 2 ? x0 : x0 + w) * k, -y * k); ctx.lineTo((i % 2 ? x0 + w : x0) * k, -y1 * k);
      ctx.moveTo(x0 * k, -y * k); ctx.lineTo((x0 + w) * k, -y * k);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(30,32,34,0.35)'; ctx.fillRect(x0 * k + cw, -top * k, Math.max(0.5, 0.12 * k), top * k); // inner shadow
    // clamp arms: reach the skin while latched, swing open as the strongback retracts
    const open = Math.max(0, Math.min(1, retract));
    for (const yA of [top - 2.5, st.heightM * 0.62, st.heightM * 0.3]) {
      const len = (x0 - R) * (1 - 0.65 * open);
      ctx.fillStyle = '#d8d8d4';
      ctx.fillRect((x0 - len) * k, -(yA + 0.35) * k, len * k, Math.max(0.8, 0.7 * k));
      ctx.fillStyle = '#4a4c50'; ctx.fillRect((x0 - len) * k, -(yA + 0.5) * k, Math.max(0.6, 0.25 * k), Math.max(1, 1 * k));
    }
    ctx.restore();
  }

  // EDL hardware dropped on the way down: heat shield (falls away below), backshell + chute (left behind above)
  const edlSpawned = { shield: false, back: false };
  function edlDebris(rs, flags) {
    const world = rs.world || 'moon';
    const craft = craftArt(descentCraftId(rs));
    if (!EDL_WORLDS.has(world) || !encapsulated(craft)) return;
    const ev = events;
    const d = descentFrame(rs, craft.heightM);
    const k = d.pxPerM, light = lightOf(rs);
    const D = craft.aeroshell?.d || (craft.template === 'rotorcraft' ? 3.75 : 4.5);
    const shell = { name: (craft.name || '') + ' aeroshell', template: 'aeroshell', shellD: D, backshellMat: 'white_paint' };
    if (!edlSpawned.shield && flags.chute && ev.chute != null && rs.t - ev.chute > 2.2) {
      edlSpawned.shield = true;
      fx.addDebris({ paint: (c) => paintCraft(c, shell, { pxPerM: k, light, part: 'shield' }), x: d.craftX, y: d.craftY, vx: 4, vy: 10, gravity: 40, drag: 0.05, rot: 0, vr: 0.35, life: 6, recede: 0.08 });
    }
    if (!edlSpawned.back && ev.powered != null && !flags.chute && ev.chute != null && !flags.landed) {
      edlSpawned.back = true;
      const t0 = rs.t;
      fx.addDebris({
        paint: (c) => {
          drawParachutes(c, 0, -D * 0.75 * k, { count: 1, kind: 'dgb', deploy: 1, t: clock.t, pxPerM: k * 0.5, sway: 0 });
          paintCraft(c, shell, { pxPerM: k, light, part: 'back' });
        },
        x: d.craftX, y: d.craftY, vx: -14, vy: -30, gravity: 0, ay: 18, drag: 0.3, rot: 0, vr: -0.05, life: 5, recede: 0.1,
        tick: (o) => { if (clock.t - t0 > 0.6) o.vr = -0.12; },
      });
    }
  }

  // ---------------------------------------------------------------- idle-time prewarm
  // While the countdown / cruise is on screen, the textures the next beats need (Earth maps, the Earth-limb
  // altitude buckets of the climb, the target world's maps and its limb buckets) are built in idle slices of
  // ≤ ~8 ms, so staging and landing never stall on a texture build.
  const pw = { sig: '', queue: [], running: false };
  function schedulePrewarm(ctx, rs) {
    if (typeof document === 'undefined') return; // Node (tests): nothing to warm, and no idle loop may keep the process alive
    let dpr = 1, FW = rs.view?.W || 375, FH = rs.view?.H || 700;
    try { const m = ctx.getTransform(); dpr = Math.max(1, Math.min(2, Math.hypot(m.a, m.b) || 1)); if (ctx.canvas?.width) { FW = ctx.canvas.width / dpr; FH = ctx.canvas.height / dpr; } } catch { /* keep */ }
    const sig = `${rs.mode}|${rs.world}|${rs.bodyId}|${Math.round(FW)}x${Math.round(FH)}|${dpr}`;
    if (pw.sig === sig || typeof requestIdleCallback === 'undefined' && typeof setTimeout === 'undefined') return;
    pw.sig = sig;
    const full = { W: FW, H: FH };
    const fake = { getTransform: () => ({ a: dpr, b: 0, d: dpr, e: 0, f: 0 }) };
    const q = [];
    if (rs.mode === 'pad' || rs.mode === 'ascent') {
      const st = stackOf(rs);
      const props = [...new Set((st.parts || []).filter((p) => p.engines).map((p) => p.engines.prop || 'kerolox'))];
      q.push(() => prewarmPlumes(props));
      q.push(() => prewarmSprites({ clouds: true, light: SUN }));
      q.push(() => prewarmMaps('earth'));
      q.push(() => prewarmEarthLimb(dpr, full, LIMB_BUCKETS, sunFor('ascent', 'earth') || SUN));
    } else {
      const w = rs.world || rs.bodyId || 'moon';
      if (w !== 'earth') {
        q.push(() => prewarmMaps(w));
        q.push(() => prewarmSprites({ rocksWorld: w, light: sunFor('descent', w) || SUN }));
        q.push(() => prewarmBodyLimb(fake, full, w, [360, 240, 160, 110, 75, 50, 33, 22, 15, 10, 7, 4.5, 3], sunFor('descent', w) || SUN));
      }
      q.push(() => prewarmMaps('earth'));
    }
    pw.queue = q;
    if (pw.running) return;
    pw.running = true;
    const ric = typeof requestIdleCallback === 'function' ? (fn) => requestIdleCallback(fn, { timeout: 300 }) : (fn) => setTimeout(() => fn({ timeRemaining: () => 10 }), 40);
    const loop = (dl) => {
      let guard = 0;
      while (pw.queue.length && guard++ < 6 && (!dl || dl.timeRemaining() > 3)) {
        let done = true;
        try { done = pw.queue[0](); } catch { done = true; }
        if (done) pw.queue.shift();
      }
      if (pw.queue.length) ric(loop); else pw.running = false;
    };
    ric(loop);
  }

  // the countdown pad window frames the stack lower and smaller than the full-screen pad shot (see drawPadWindow)
  let winMode = false;
  const padWinFrame = (rs, st) => ({ pxPerM: ((rs.view?.H || 600) * 0.5) / Math.max(5, st.heightM), anchorX: (rs.view?.W || 375) / 2, anchorY: (rs.view?.H || 600) * 0.9, tilt: 0 });


  // ---------------------------------------------------------------- rendezvous, docking and module release (§7.3)
  // mode 'rendezvous': an orbit frame without capture. With a station target the craft (or the new module) comes
  // in from +x along the V-bar to the target port; without one the module separates from the upper stage.
  // Everything is a function of rs.clock / rs.flags / event times, so resume and replay draw the same picture.
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerpN = (a, b, t) => a + (b - a) * t;
  let rvAcc = 0;
  function upperPartOf(st) {
    const ps = (st?.parts || []).filter((p) => !p.x && (p.role === 'upper' || p.role === 'stage'));
    return ps.filter((p) => p.role === 'upper').slice(-1)[0] || ps.slice(-1)[0] || null;
  }
  function rvState(rs) {
    const tg = resolveTarget(rs.target);
    const W = rs.view?.W || 375, H = rs.view?.H || 700;
    const ev = { ...(rs.events || {}), ...events };
    const fl = rs.flags || {};
    const cr = rvCraftOf(rs, tg);
    const seq = tg && (tg.sequence === 'dock' || tg.sequence === 'berth') ? tg.sequence : 'release';
    const lay = seq !== 'release' && tg.modules.length ? stationLayoutOf(tg, rs.seed || 1) : null;
    if (lay) {
      const berth = seq === 'berth' && !!lay.arm;
      const pose = dockPose({ clock: rs.clock, t: rs.t, tl: rs.dockT || {}, seq: berth ? 'berth' : 'dock', flags: fl, events: ev });
      const kClose = clamp((W * 0.52) / (pose.range + cr.lenM * 1.5 + 6), 0.2, (W * 0.3) / Math.max(3, cr.lenM));
      const b = lay.bbox;
      const bw = b.x1 - b.x0 + cr.lenM + 2, bh = b.y1 - b.y0;
      const kFit = Math.max(0.02, Math.min((W * 0.86) / bw, (H * 0.5) / bh));
      const td = Number.isFinite(ev.dock) ? ev.dock : Number.isFinite(ev.berth) ? ev.berth : null;
      const z = pose.phase === 'docked' ? (td == null ? 1 : sstep(2.5, 6.5, rs.t - td)) : 0;
      const k = Math.exp(lerpN(Math.log(kClose), Math.log(kFit), z));
      const port = lay.port;
      const fx0 = lerpN(port.x, (b.x0 + b.x1 + cr.lenM) / 2, z), fy0 = lerpN(port.y, (b.y0 + b.y1) / 2, z);
      const sx0 = W * lerpN(0.36, 0.5, z), sy0 = H * 0.42;
      const ox = sx0 - fx0 * k, oy = sy0 + fy0 * k;
      const cx = port.x + pose.range + cr.noseM, cy = port.y + pose.off;
      return { tg, lay, pose, cr, k, ox, oy, cx, cy, seq, berth, W, H, ev };
    }
    const released = !!fl.released || ev.release != null;
    const rp = releasePose({ since: ev.release != null ? rs.t - ev.release : null, released, founding: !!tg?.newAsset && tg?.kind === 'station' });
    const st = stackOf(rs);
    const up = upperPartOf(st);
    const stageL = up ? up.len : 8;
    const k = clamp((W * 0.55) / (cr.lenM + stageL * 0.9 + 4), 0.5, 40);
    const mx = W * 0.4 - rp.sep * 0.35 * k, my = H * 0.42;
    const sx = mx + (cr.lenM / 2 + 0.5 + stageL) * k + rp.sep * 0.65 * k + rp.stageAway * 0.35 * k, sy = my + rp.stageAway * 0.9 * k;
    return { tg, rp, cr, k, mx, my, st, up, stageL, sx, sy, seq: 'release', W, H, ev };
  }
  /** Screen point of the visiting craft (its nose for docking, module centre for release). */
  function rvCraftScreen(rs, S = rvState(rs)) {
    if (S.lay) return { x: S.ox + (S.cx - S.cr.noseM) * S.k, y: S.oy - S.cy * S.k };
    return { x: S.mx, y: S.my };
  }
  function paintRvCraft(ctx, S, light, rs, { rot = 0, unfold = 1, lights = true } = {}) {
    if (S.cr.type === 'module') { ctx.rotate(Math.PI + rot); paintModule(ctx, S.cr.art, { pxPerM: S.k, light, unfold, lights }); return; }
    ctx.rotate(-Math.PI / 2 + rot);
    paintCraft(ctx, S.cr.craft, { pxPerM: S.k, light, mode: 'flight', legs: 0, t: rs.t, arrays: unfold });
  }
  function craftLight(ctx, x, y, kind, t, reduce, k) {
    const col = kind === 'docked' ? '120,255,150' : kind === 'abort' ? '255,180,60' : '255,255,240';
    const a = kind === 'docked' || reduce ? 0.85 : Math.sin(t * 5.1) > 0.4 ? 0.95 : 0.12;
    const r = Math.max(1.4, 0.4 * k);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, `rgba(${col},${a.toFixed(3)})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawRendezvous(ctx, rs) {
    const view = rs.view;
    const light = lightOf(rs);
    const S = rvState(rs);
    const world = S.tg?.bodyId && S.tg.bodyId !== 'earth' ? S.tg.bodyId : 'earth';
    ctx.fillStyle = '#000'; ctx.fillRect(-40, -40, view.W + 80, view.H + 80);
    drawStarfield(ctx, view, { alpha: 0.3, drift: (rs.clock || 0) * 0.5, t: rs.t, seed: 17, reduce: rs.reduce });
    if (world === 'earth') drawEarthLimb(ctx, view, { altKm: 420, light, t: rs.t });
    else { const r = view.W * 1.6; drawPlanetDisc(ctx, world, view.W * 0.5, view.H + r * 0.6, r, { light, t: rs.t }); }
    fx.draw(ctx, 'back');
    if (S.lay) {
      const { pose, k } = S;
      ctx.save(); ctx.translate(S.ox, S.oy);
      paintStation(ctx, S.lay, { pxPerM: k, light, t: rs.t, reduce: rs.reduce, armTarget: S.berth ? null : undefined });
      ctx.restore();
      const c = { x: S.ox + S.cx * k, y: S.oy - S.cy * k };
      if (!rs.flags?.exploded) {
        ctx.save(); ctx.translate(c.x, c.y);
        paintRvCraft(ctx, S, light, rs, { rot: pose.rot });
        ctx.restore();
        const nose = rvCraftScreen(rs, S);
        craftLight(ctx, nose.x + S.cr.lenM * 0.15 * k, nose.y - S.cr.dM * 0.3 * k, pose.lights, rs.t, rs.reduce, k);
      }
      if (S.berth) { // the arm reaches out, grapples the hovering craft and pulls it to the port
        const stow = { x: S.lay.arm.x - S.lay.arm.boom * 1.3, y: S.lay.arm.y + S.lay.arm.boom * 0.6 };
        const grab = { x: S.cx - S.cr.noseM + S.cr.lenM * 0.45, y: S.cy + S.cr.dM * 0.5 };
        const u = pose.armHold ? 1 : pose.arm;
        const tgt = { x: lerpN(stow.x, grab.x, u), y: lerpN(stow.y, grab.y, u) };
        ctx.save(); ctx.translate(S.ox, S.oy); drawArm(ctx, S.lay, k, light, tgt); ctx.restore();
      }
      if (pose.flash > 0) { // contact flash at the port
        const p = { x: S.ox + S.lay.port.x * k, y: S.oy - S.lay.port.y * k };
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const r = Math.max(8, 2.5 * k);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(255,250,230,${(0.9 * pose.flash).toFixed(3)})`); g.addColorStop(1, 'rgba(255,250,230,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      if (S.cr.lenM * k < 26 && pose.phase !== 'docked') { // far away: target brackets + range readout
        const w = Math.max(10, S.cr.lenM * k + 8), h = Math.max(10, S.cr.dM * k + 8);
        const bx = c.x - (S.cr.noseM - S.cr.lenM / 2) * k;
        ctx.save();
        ctx.strokeStyle = 'rgba(160,220,255,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = bx + sx * w / 2, y = c.y + sy * h / 2; ctx.moveTo(x - sx * 4, y); ctx.lineTo(x, y); ctx.lineTo(x, y - sy * 4); }
        ctx.stroke();
        ctx.fillStyle = 'rgba(190,230,255,0.85)'; ctx.font = '600 10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(`${Math.round(pose.range)} m`, bx, c.y + h / 2 + 3);
        ctx.restore();
      }
    } else drawRelease(ctx, rs, S, light);
    fx.draw(ctx, 'front');
  }
  function drawRelease(ctx, rs, S, light) {
    const { rp, k } = S;
    if (rs.flags?.exploded) return;
    // upper stage: axis along x, top toward the module (−x); turns away and burns retrograde after separation
    const scx = S.sx - (S.stageL / 2) * k, scy = S.sy;
    ctx.save(); ctx.translate(scx, scy); ctx.rotate(rp.stageRot);
    if (S.up) {
      const e = S.up.engines;
      if (rp.stageBurn > 0 && e) drawPlume(ctx, { x: (S.stageL / 2 + (e.bellLen || 1.5)) * k, y: 0, d: e.bellD || 1.2 }, { prop: e.prop || 'kerolox', pBar: 0, pxPerM: k, t: rs.t, angle: -Math.PI / 2, throttle: 0.55 * rp.stageBurn, lengthM: S.stageL * 0.9, reduce: rs.reduce, seed: 21 });
      ctx.translate((S.stageL / 2) * k, 0); ctx.rotate(-Math.PI / 2);
      // the stage keeps its lighting through the turn-away (light turned with it): a re-lit sprite at every 15°
      // light bucket would cost a render hitch per bucket; the turn is short and the stage small on screen
      const c = Math.cos(rp.stageRot), s = Math.sin(rp.stageRot);
      const lax = Number.isFinite(light?.ax) ? light.ax : SUN.ax, lay = Number.isFinite(light?.ay) ? light.ay : SUN.ay;
      const held = rp.stageRot ? { ...light, ax: lax * c - lay * s, ay: lax * s + lay * c } : light;
      paintPart(ctx, S.st, S.up, { pxPerM: k, light: held, tilt: -Math.PI / 2 + rp.stageRot, glow: 0, showHiddenEngines: true });
    }
    ctx.restore();
    // the module / payload
    ctx.save(); ctx.translate(S.mx, S.my);
    if (S.cr.type === 'module') { ctx.rotate(rp.moduleRot); paintModule(ctx, S.cr.art, { pxPerM: k, light, unfold: rp.phase === 'attached' ? 0 : Math.min(rp.arrays, 1), lights: rp.lights }); }
    else { ctx.rotate(-Math.PI / 2 + rp.moduleRot); ctx.translate(0, (S.cr.centred ? 0 : S.cr.lenM / 2) * k); paintCraft(ctx, S.cr.craft, { pxPerM: k, light, mode: 'flight', legs: 0, t: rs.t, arrays: rp.arrays }); }
    ctx.restore();
    if (rp.lights && rp.phase !== 'attached') craftLight(ctx, S.mx - (S.cr.lenM / 2) * k, S.my, 'docked', rs.t, rs.reduce, k);
  }

  const R = {
    reset() { events = {}; fx.clear(); prevGround = null; trail.n = 0; trail.head = 0; edlSpawned.shield = edlSpawned.back = false; sepState.done = false; seps.length = 0; ullAcc = 0; ignFlash = false; rvAcc = 0; },
    events() { return { ...events }; },

    event(name, payload = {}) {
      if (!name || events[name] != null) return;
      const rs = last;
      events[name] = rs ? rs.t : 0;
      if (!rs) return;
      switch (name) {
        case 'liftoff': cam.shake(0.6); break;
        case 'boosterSep': case 'staging': case 'fairing': spawnDetached(rs, name); cam.shake(name === 'staging' ? 0.7 : 0.3); break;
        case 'explode': {
          const p = payload.x != null ? payload : vehicleScreenPos(rs);
          const tilt = rs.mode === 'ascent' ? ascentFrame(rs, stackOf(rs).heightM).tilt : 0;
          fx.explosion(p.x, p.y, { scale: 1.2, world: rs.world, dir: tilt - Math.PI / 2 }); cam.shake(2);
          if (rs.mode === 'ascent') {
            // the exhaust column ends at the failure point: the last few hundred metres of trail are blown apart
            const drop = Math.min(trail.n, 10);
            trail.head = (trail.head - drop + TRAIL_N) % TRAIL_N; trail.n -= drop;
            // torn fragments of the actual vehicle, tumbling out of the fireball with smoke / fire trails
            const st = stackOf(rs), fr = ascentFrame(rs, st.heightM), ppm = fr.pxPerM;
            const pre = { ...flagsOf(rs), exploded: false };
            const pieces = breakupPieces(st, pre, { pxPerM: ppm, light: lightOf(rs), seed: hash(String(rs.seed || 1)), max: rs.reduce ? 4 : 10 });
            pieces.forEach((pc, i) => {
              const at = toScreen(fr, pc.x, pc.y);
              const ux = Math.sin(fr.tilt), uy = -Math.cos(fr.tilt);
              fx.addDebris({
                paint: pc.paint, x: at.x, y: at.y,
                vx: (pc.vx * 2.2 + ux * 18) * ppm, vy: (-pc.vy * 1.6 + uy * 18) * ppm,
                rot: fr.tilt, vr: pc.vr * 1.4, gravity: 24 * ppm, drag: 0.5, life: 3.5 + (i % 3) * 0.8, recede: 0.08,
                trail: i % 3 === 0 ? 'fire' : 'smoke',
              });
            });
          }
          break;
        }
        case 'touchdown': { const c = craftArt(descentCraftId(rs)); const d = descentFrame(rs, c.heightM); cam.shake(payload.hard ? 1.2 : 0.5); fx.landingDust(d.craftX, d.groundY, { intensity: 1, world: rs.world, pxPerM: d.pxPerM, dt: 0.5 }); break; } // last gust of regolith at engine cutoff, at the footpads
        case 'splashdown': {
          const c = craftArt(descentCraftId(rs)); const d = descentFrame(rs, c.heightM);
          fx.splash(d.craftX, d.groundY, { scale: Math.max(0.6, Math.min(2, (c.widthM || 4) * d.pxPerM / 40)) }); break;
        }
        case 'anomaly': cam.shake(0.4 + 0.8 * (payload.severity || 0)); break;
        case 'dock': case 'berth': cam.shake(0.25); break;
        case 'dockFail': cam.shake(0.55); break;
        case 'release': if (rs.mode === 'rendezvous' && !rs.reduce) { // spring separation: cold-gas puffs at the interface
          const S = rvState(rs);
          if (!S.lay) { const x = S.mx + (S.cr.lenM / 2 + 0.3) * S.k; for (const a of [-1.2, 1.2, -1.9, 1.9]) fx.rcs(x, S.my + Math.sign(a) * S.cr.dM * 0.3 * S.k, a); }
        } break;
        default: break;
      }
    },

    update(rs) {
      if (!rs) return;
      rs = visualRS(rs);
      if (rs.events) for (const [k, v] of Object.entries(rs.events)) if (events[k] == null && Number.isFinite(v)) events[k] = v;
      rs = withEvents(rs);
      last = rs;
      clock.t = Number(rs.t) || 0; clock.alt = rs.tele?.altKm || 0; clock.reduce = !!rs.reduce;
      const dt = Math.max(0, Math.min(0.1, Number(rs.dt) || 0));
      fx.setReduce(!!rs.reduce);
      cam.update(dt, rs.reduce);
      const flags = flagsOf(rs);
      if (rs.mode === 'ascent' || rs.mode === 'pad') {
        const st = stackOf(rs);
        payloadRelease(rs, st, flags);
        // visual-only booster separation (no milestone): at ~42 km, before staging
        if (st.hasBoosters && !flags.staged && events.boosterSep == null && (rs.tele?.altKm || 0) > 42) R.event('boosterSep');
        const fr = ascentFrame(rs, st.heightM);
        stepSeps(rs, dt, fr);
        const s2t = s2Since(rs);
        if (s2t < S2_IGN + 0.4 && !rs.reduce && !flags.exploded) { // cold-gas ullage / attitude puffs during the coast
          const up = (st.parts || []).find((q) => !q.x && q.role === 'upper');
          ullAcc += dt;
          if (ullAcc > 0.42 && up) {
            ullAcc = 0;
            const sd = Math.sin(s2t * 9.1) > 0 ? 1 : -1;
            const q = toScreen(fr, sd * (up.d || 3) * 0.5, up.y + 0.8);
            fx.rcs(q.x, q.y, fr.tilt + (sd > 0 ? 0 : Math.PI) + 0.4);
          }
          if (s2t >= S2_IGN && !ignFlash && up?.engines) { // ignition: TEA-TEB green-white flash at the throat
            ignFlash = true;
            const q = toScreen(fr, 0, up.y - (up.engines.bellLen || 2) * 0.3);
            fx.jet(q.x, q.y, fr.tilt + Math.PI / 2, { ppm: Math.max(0.6, fr.pxPerM * 0.4), hot: true, len: 0.5 });
          }
        }
        if (prevGround != null) {
          const dy = Math.max(-80, Math.min(80, fr.groundY - prevGround));
          if (Number.isFinite(dy) && !flags.exploded) { const sh = (rs.tele?.altKm || 0) < 3 ? dy : dy * 0.05 + 0.8; fx.shift(0, sh); trailShift(0, sh); }
        }
        prevGround = fr.groundY;
        const pBar = ambientPressure('earth', rs.tele?.altKm);
        for (let i = 0; i < trail.n; i++) trail.age[i] += dt * (flags.exploded ? 2 : 1); // a broken-off column disperses faster
        if (flags.engineOn && !flags.exploded && (rs.tele?.altKm || 0) > 0.05 && (rs.tele?.altKm || 0) < 48) {
          const noz = activeNozzles(st, flags);
          if (noz.length) {
            let sx = 0, sy = 0;
            for (const n of noz) { const s = toScreen(fr, n.x, n.y); sx += s.x; sy += s.y; }
            sx /= noz.length; sy /= noz.length;
            // the trail starts where the visible flame ends (one plume length aft of the nozzles)
            const ext = Math.max(...noz.map((n) => Math.abs(n.x))) * 2 + noz[0].d;
            const lenPx = noz[0].d * fr.pxPerM * (pBar > 0.3 ? 9 : 5);
            sx -= Math.sin(fr.tilt) * lenPx; sy += Math.cos(fr.tilt) * lenPx;
            trail.acc += dt;
            if (trail.acc > 1 / 30 || trail.n === 0) {
              trail.acc = 0;
              const i = trail.head;
              trail.x[i] = sx; trail.y[i] = sy; trail.age[i] = 0; trail.w[i] = Math.max(2, ext * fr.pxPerM * 1.1);
              trail.head = (trail.head + 1) % TRAIL_N; trail.n = Math.min(TRAIL_N, trail.n + 1);
              trail.prop = noz[0].prop;
            }
          }
        }
        if (flags.engineOn && !flags.exploded) {
          for (const n of activeNozzles(st, flags)) {
            const s = toScreen(fr, n.x, n.y);
            fx.exhaust(s.x, s.y, { angle: fr.tilt, prop: n.prop, pBar, pxPerM: fr.pxPerM, dt, rate: pBar > 0.05 ? 1 : 0.15, d: n.d });
          }
          if ((rs.tele?.altKm || 0) < 0.4) fx.padBillow(fr.anchorX, fr.groundY, { intensity: 1, dt, pxPerM: fr.pxPerM });
        } else if (!flags.exploded && (rs.tele?.altKm || 0) <= 0) {
          // LOX boil-off on the pad: upper-stage vent, booster LOX vent and the T-0 umbilical, streaming downwind
          // and sinking (cold, dense vapour); the sound-suppression deluge starts at T-10 s
          const vf = winMode ? padWinFrame(rs, st) : fr;
          const ppm = vf.pxPerM, vR = coreDiameter(st) / 2;
          const s1 = (st.parts || []).find((p) => !p.x && p.role === 'stage');
          const s2 = (st.parts || []).find((p) => !p.x && p.role === 'upper');
          const pts = [];
          if (s2) pts.push([vR * 0.95, s2.y + s2.len * 0.75, 1, 1.1], [-vR * 0.95, s2.y + s2.len * 0.55, -1, 0.45]);
          if (s1) pts.push([vR * 0.95, s1.y + s1.len * 0.58, 1, 0.9], [-vR * 0.95, s1.y + s1.len * 0.8, -1, 0.4]);
          pts.push([vR * 1.05, 2.5, 1, 0.5]);
          for (const [x, y, dir, r] of pts) { const q = toScreen(vf, x, y); fx.vent(q.x, q.y, { dir, dt, rate: r, ppm }); }
          if (rs.mode === 'pad' && Number.isFinite(rs.cd) && rs.cd <= 10) {
            const g = toScreen(vf, 0, 0);
            fx.deluge(g.x, g.y, { ppm, dt, intensity: Math.min(1, (10 - rs.cd) / 2), halfW: Math.max(8, coreDiameter(st) * 2.2) });
          }
        }
      } else if (rs.mode === 'descent') edlDebris(rs, flags);
      else if (rs.mode === 'rendezvous' && !rs.reduce) {
        const S = rvState(rs);
        if (S.lay && S.pose.rcs && !flags.exploded) { // attitude / translation puffs while closing in
          rvAcc += dt;
          if (rvAcc > 0.55) {
            rvAcc = 0;
            const n = rvCraftScreen(rs, S), up = Math.sin(rs.t * 3.7) > 0 ? 1 : -1;
            fx.rcs(n.x + S.cr.lenM * 0.25 * S.k, n.y + up * S.cr.dM * 0.45 * S.k, up > 0 ? Math.PI / 2 : -Math.PI / 2);
            if (S.pose.phase === 'final' || S.pose.phase === 'closing') fx.rcs(n.x, n.y, Math.PI);
          }
        } else if (!S.lay && S.rp.phase === 'departure' && S.rp.stageBurn <= 0) {
          rvAcc += dt;
          if (rvAcc > 0.4) { rvAcc = 0; fx.rcs(S.sx - S.stageL * S.k, S.sy, -Math.PI / 2); }
        }
      }
      if (rs.mode === 'descent' && flags.engineOn && !flags.landed) {
        const c = craftArt(descentCraftId(rs));
        const d = descentFrame(rs, c.heightM);
        const altM = (rs.tele?.altKm || 0) * 1000;
        const reach = Math.max(rs.world === "mars" || rs.world === "titan" ? 95 : 70, 60 + 1.5 * nozzleHeightM(c)); // plume reaches the ground from this height (HLS: high-mounted thrusters)
        if (rs.world !== 'earth' && altM < Math.max(1000, reach * 2)) {
          const near = Math.max(0, 1 - altM / reach);
          const far = 0;
          const I = Math.max(Math.pow(near, 0.7), far);
          if (I > 0.01) fx.landingDust(d.craftX, d.groundY, { intensity: I, world: rs.world, pxPerM: d.pxPerM, dt });
        }
      }
      fx.update(dt);
    },

    draw(ctx, rs) {
      if (!rs) return;
      rs = withEvents(visualRS(rs));
      schedulePrewarm(ctx, rs);
      winMode = false;
      ctx.save();
      const o = cam.offset();
      ctx.translate(o.x, o.y);
      if (rs.mode === 'orbit') drawOrbit(ctx, rs);
      else if (rs.mode === 'rendezvous') drawRendezvous(ctx, rs);
      else if (rs.mode === 'descent') drawDescent(ctx, rs);
      else drawAscent(ctx, rs);
      ctx.restore();
    },

    drawPadWindow(ctx, rect, rs) {
      schedulePrewarm(ctx, rs);
      winMode = true;
      const st = stackOf(rs);
      // framed a little lower and smaller than the full-screen pad shot so the telemetry cards across the top
      // of the stage never cover the payload / fairing (vehicle top ≈ 40 % down the window)
      const pf = { pxPerM: (rect.h * 0.5) / Math.max(5, st.heightM) };
      const gyR = 0.9;
      const view = { W: rect.w, H: rect.h };
      ctx.save();
      ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
      ctx.translate(rect.x, rect.y);
      drawSky(ctx, view, 'earth', 0, { weather: rs.weather });
      drawClouds(ctx, view, { altKm: 0, pxPerKm: 30, anchorY: rect.h * gyR, t: rs.t, coverage: (rs.weather?.risk || 20) / 100 });
      drawLaunchSite(ctx, view, { style: siteStyleOf(rs.siteId || st.site), groundY: rect.h * gyR, pxPerM: pf.pxPerM, t: rs.t, tower: st.tower, towerArm: 1, towerHeightM: st.heightM * 1.05, vehicleD: coreDiameter(st) });
      fx.draw(ctx, 'back');
      drawStrongback(ctx, st, pf.pxPerM, rect.w / 2, rect.h * gyR, Number.isFinite(rs.cd) ? (12 - rs.cd) / 6 : 0, lightOf(rs));
      ctx.save();
      ctx.translate(rect.w / 2, rect.h * gyR);
      paintVehicle(ctx, st, { pxPerM: pf.pxPerM, light: lightOf(rs), flags: {}, frost: 1, t: rs.t, reduce: rs.reduce });
      ctx.restore();
      fx.draw(ctx, 'front');
      ctx.restore();
    },

    vehicleScreenPos,
    stats() { return { particles: fx.count(), textures: textureStats().count, bytes: textureStats().bytes }; },
  };

  function drawAscent(ctx, rs) {
    const view = rs.view;
    const alt = Math.max(0, rs.tele?.altKm || 0);
    const st = stackOf(rs);
    const flags = flagsOf(rs);
    const fr = ascentFrame(rs, st.heightM);
    const light = lightOf(rs);
    const sky = drawSky(ctx, view, 'earth', alt, { weather: rs.weather });
    drawStarfield(ctx, view, { alpha: sky.starAlpha * (alt > 22 ? 0.4 : 1), drift: fr.drift, t: rs.t, seed: 7, reduce: rs.reduce }); // Earth limb in frame → short exposure
    drawEarthLimb(ctx, view, { altKm: alt, light, t: rs.t, tilt: fr.tilt });
    drawClouds(ctx, view, { altKm: alt, pxPerKm: fr.pxPerKm, anchorY: fr.anchorY, drift: fr.drift, t: rs.t, coverage: (rs.weather?.risk || 25) / 100 });
    if (fr.groundY < view.H + 400 && alt < 4) { // the pad never reappears under the Earth limb at orbital altitudes
      const since = events.liftoff != null ? rs.t - events.liftoff : -1;
      drawLaunchSite(ctx, view, { style: siteStyleOf(rs.siteId || st.site), groundY: fr.groundY, pxPerM: fr.pxPerM, t: rs.t, tower: st.tower, towerArm: since < 0 ? 1 : Math.max(0, 1 - since / 1.5), towerHeightM: st.heightM * 1.05, reduce: rs.reduce, vehicleD: coreDiameter(st) });
    }
    if (fr.groundY < view.H + 400 && alt < 1.5) {
      const padX = fr.anchorX + Math.sin(fr.tilt) * (fr.groundY - fr.anchorY); // the pad stays put while the rocket climbs
      drawStrongback(ctx, st, fr.pxPerM, padX, fr.groundY, rs.mode === 'pad' && Number.isFinite(rs.cd) ? (12 - rs.cd) / 6 : 1, light);
    }
    if (!flags.exploded && flags.engineOn) drawContrail(ctx, rs, st, fr, flags, light, alt);
    drawTrail(ctx, rs, light);
    fx.draw(ctx, 'back');
    if (!flags.exploded) {
      const pBar = ambientPressure('earth', alt);
      if (flags.engineOn) {
        for (const n of activeNozzles(st, flags)) {
          const s = toScreen(fr, n.x, n.y);
          drawPlume(ctx, { x: s.x, y: s.y, d: n.d }, { prop: n.prop, pBar, pxPerM: fr.pxPerM, t: rs.t, angle: fr.tilt, reduce: rs.reduce, seed: hash(n.partId || '') % 97, throttle: flags.staged ? flags.s2Throttle : 1 });
        }
      }
      drawSeps(ctx, rs, fr, light); // separated hardware sits over the upper-stage plume, under the vehicle
      ctx.save();
      ctx.translate(fr.anchorX, fr.anchorY);
      ctx.rotate(fr.tilt);
      paintVehicle(ctx, st, { pxPerM: fr.pxPerM, light, tilt: fr.tilt, flags, frost: Math.max(0, 1 - (events.liftoff != null ? rs.t - events.liftoff : 0) / 20), t: rs.t, reduce: rs.reduce });
      ctx.restore();
      if (alt > 8 && alt < 16 && flags.engineOn) {
        const c = toScreen(fr, 0, st.heightM * 0.62);
        drawCondensationCollar(ctx, c.x, c.y, coreDiameter(st) * fr.pxPerM * 0.8, { intensity: 1 - Math.abs(alt - 12) / 4, t: rs.t, angle: fr.tilt, reduce: rs.reduce });
      }
    }
    if (alt < 7) drawCloudsFront(ctx, view, { altKm: alt, pxPerKm: fr.pxPerKm, anchorY: fr.anchorY, t: rs.t, coverage: (rs.weather?.risk || 25) / 100, light, reduce: rs.reduce });
    fx.draw(ctx, 'front');
    if (flags.escaped && events.escape != null) {
      const since = rs.t - events.escape;
      const top = toScreen(fr, 0, st.heightM * 0.9);
      const dist = since < 2.2 ? 30 * since + 70 * since * since : 30 * 2.2 + 70 * 4.84 + 60 * (since - 2.2); // ~10 g pull, then coasting
      const x = top.x - dist * 0.42, y = top.y - dist + Math.max(0, since - 2.2) ** 2 * 30;
      const craft = craftArt(rs.craftId);
      const k = fr.pxPerM;
      const tower = (st.parts || []).some((p) => p.role === 'les');  // Soyuz SAS / Shenzhou / Orion LAS tower
      const burnT = tower ? 2.4 : 2.0;
      const H = craft.heightM || 3, D = craft.widthM || 3;
      const ang = -0.35 * Math.min(1, since / 1.5); // pitches away from the failing booster
      if (since > 2.2) drawParachutes(ctx, x, y - 8, { count: 1, kind: 'main', deploy: Math.min(1, (since - 2.2) / 0.8), t: rs.t, pxPerM: k * 0.6 });
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      const thr = since < burnT ? Math.min(1, since * 8) * (since > burnT - 0.4 ? (burnT - since) / 0.4 : 1) : 0;
      if (tower) {
        // escape tower above the capsule: truss + solid motor with canted nozzles
        const t0 = H * 1.05, t1 = t0 + Math.max(3, H * 1.6);
        ctx.strokeStyle = '#8a8d90'; ctx.lineWidth = Math.max(0.8, 0.12 * k);
        ctx.beginPath(); ctx.moveTo(-D * 0.18 * k, -H * 0.95 * k); ctx.lineTo(0, -t0 * k); ctx.lineTo(D * 0.18 * k, -H * 0.95 * k); ctx.stroke();
        const g = ctx.createLinearGradient(-0.35 * k, 0, 0.35 * k, 0); g.addColorStop(0, '#f2f2ee'); g.addColorStop(1, '#8e9094');
        ctx.fillStyle = g; ctx.fillRect(-0.35 * k, -t1 * k, 0.7 * k, (t1 - t0) * k);
        ctx.beginPath(); ctx.moveTo(-0.35 * k, -t1 * k); ctx.lineTo(0, -(t1 + 1.2) * k); ctx.lineTo(0.35 * k, -t1 * k); ctx.fill();
        if (thr > 0) for (const sx of [-1, 1]) drawPlume(ctx, { x: sx * 0.4 * k, y: -(t0 + 0.6) * k, d: 0.35 }, { prop: 'solid', pBar: ambientPressure('earth', alt), pxPerM: k, t: rs.t, angle: sx * 0.62, throttle: thr, lengthM: 9, reduce: rs.reduce, seed: sx > 0 ? 3 : 9 });
      } else if (thr > 0) { // pusher abort (SuperDraco-style side pods)
        for (const sx of [-1, 1]) drawPlume(ctx, { x: sx * D * 0.46 * k, y: -H * 0.25 * k, d: 0.4 }, { prop: 'hypergolic', pBar: ambientPressure('earth', alt), pxPerM: k, t: rs.t, angle: sx * 0.4, throttle: thr, lengthM: 8, reduce: rs.reduce, seed: sx > 0 ? 5 : 11 });
      }
      paintCraft(ctx, craft, { pxPerM: k, light, mode: since > 2.2 ? 'chute' : 'entry' });
      ctx.restore();
    }
  }

  /**
   * Persistent contrail / smoke column: a ribbon from the end of the flame down the past trajectory (which was
   * steeper) to the bottom of the screen, widening with age. White and sun-lit low down, thinning out by ~40 km.
   */
  function drawContrail(ctx, rs, st, fr, flags, light, alt) {
    const fade = sstep(0.25, 1.5, alt) * (1 - sstep(24, 44, alt));
    if (fade < 0.01) return;
    const noz = activeNozzles(st, flags);
    if (!noz.length) return;
    const prop = noz[0].prop;
    let sx = 0, sy = 0;
    for (const n of noz) { const q = toScreen(fr, n.x, n.y); sx += q.x; sy += q.y; }
    sx /= noz.length; sy /= noz.length;
    const pBar = ambientPressure('earth', alt);
    const ext = Math.max(...noz.map((n) => Math.abs(n.x))) * 2 + noz[0].d;
    const flameL = noz[0].d * fr.pxPerM * (pBar > 0.3 ? 8 : 6);
    const H = rs.view.H, W = rs.view.W;
    const solid = prop === 'solid', clean = prop === 'hydrolox' || prop === 'methalox';
    const col = solid ? [246, 244, 240] : prop === 'hypergolic' ? [206, 168, 132] : clean ? [240, 244, 248] : [228, 226, 222];
    const A = (solid ? 0.75 : clean ? 0.42 : 0.55) * fade;
    const w0 = Math.max(3, ext * fr.pxPerM * 1.1);
    const pts = [];
    let x = sx - Math.sin(fr.tilt) * flameL, y = sy + Math.cos(fr.tilt) * flameL;
    const t0 = fr.tilt;
    const seg = Math.max(14, (H - y) / 18);
    for (let i = 0; i < 40 && y < H + 60 && x > -80 && x < W + 80; i++) {
      pts.push([x, y]);
      const a = t0 * (1 - Math.min(1, i / 26) * 0.75); // older parts of the path were steeper
      x -= Math.sin(a) * seg; y += Math.cos(a) * seg;
    }
    pts.push([x, y]);
    if (pts.length < 2) return;
    const lx = Number(light?.ax) || -0.6;
    const wob = rs.reduce ? 0 : 1;
    ctx.save();
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < pts.length - 1; i++) {
        const f = i / (pts.length - 1);
        const w = (w0 + f * w0 * (solid ? 9 : 6)) * (1 + 0.08 * Math.sin(i * 1.7 + rs.t * 0.6 * wob));
        const a = A * (pass === 0 ? 0.22 : pass === 1 ? 0.5 : 0.35) * Math.min(1, 0.35 + i * 0.25) * (1 - 0.45 * f);
        const sh = pass === 2 ? lx * w * 0.2 : 0;
        const k = pass === 2 ? 1.06 : pass === 1 ? 0.9 : 0.82;
        ctx.strokeStyle = `rgba(${Math.min(255, col[0] * k) | 0},${Math.min(255, col[1] * k) | 0},${Math.min(255, col[2] * k) | 0},${a.toFixed(3)})`;
        ctx.lineWidth = w * (pass === 0 ? 1.8 : pass === 1 ? 1 : 0.42);
        ctx.beginPath(); ctx.moveTo(pts[i][0] + sh, pts[i][1]); ctx.lineTo(pts[i + 1][0] + sh, pts[i + 1][1]); ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Continuous exhaust trail: soft ribbon from the flame tail down the past trajectory, widening and fading. */
  function drawTrail(ctx, rs, light) {
    if (trail.n < 2) return;
    const alt = Math.max(0, rs.tele?.altKm || 0);
    const life = 6;
    const solid = trail.prop === 'solid', hypo = trail.prop === 'hypergolic', clean = trail.prop === 'hydrolox' || trail.prop === 'methalox';
    const col = solid ? [244, 242, 238] : hypo ? [196, 150, 112] : clean ? [236, 240, 244] : [214, 210, 204];
    const thin = 1 - Math.min(1, Math.max(0, (alt - 30) / 18)); // the trail thins out in the upper stratosphere
    const baseA = (solid ? 0.55 : clean ? 0.26 : 0.4) * thin;
    if (baseA < 0.01) return;
    const lx = Number(light?.ax) || -0.6;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // newest → oldest; three passes: soft wide halo, body, sun-lit edge
    for (let pass = 0; pass < 3; pass++) {
      // older samples are joined with a coarser stride (2, then 3): the ribbon is wide and soft there, so the
      // fewer strokes are invisible but halve the per-frame stroke count of a long climb
      for (let k = 0, step = 1; k < trail.n - 1; k += step) {
        const i = (trail.head - 1 - k + TRAIL_N * 2) % TRAIL_N;
        const ag = trail.age[i];
        if (ag > life) break;
        step = Math.min(ag < 1 ? 1 : ag < 3 ? 2 : 3, trail.n - 1 - k);
        const j = (i - step + TRAIL_N) % TRAIL_N;
        const f = ag / life;
        const w = trail.w[i] * (1 + ag * (solid ? 0.7 : 0.4));
        const a = baseA * Math.pow(1 - f, 1.4) * Math.min(1, ag * 6 + 0.25);
        if (a < 0.006) continue;
        const sh = pass === 2 ? lx * w * 0.18 : 0;
        const kL = pass === 2 ? 1.08 : pass === 1 ? 0.92 : 0.86;
        ctx.strokeStyle = `rgba(${Math.min(255, col[0] * kL) | 0},${Math.min(255, col[1] * kL) | 0},${Math.min(255, col[2] * kL) | 0},${(a * (pass === 0 ? 0.35 : pass === 1 ? 0.55 : 0.35)).toFixed(3)})`;
        ctx.lineWidth = w * (pass === 0 ? 1.9 : pass === 1 ? 1 : 0.45);
        ctx.beginPath(); ctx.moveTo(trail.x[i] + sh, trail.y[i]); ctx.lineTo(trail.x[j] + sh, trail.y[j]); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawDescent(ctx, rs) {
    const view = rs.view;
    const alt = Math.max(0, rs.tele?.altKm || 0);
    const world = rs.world || 'moon';
    const craft = craftArt(descentCraftId(rs));
    const d = descentFrame(rs, craft.heightM);
    const light = lightOf(rs);
    const flags = flagsOf(rs);
    const sky = drawSky(ctx, view, world, alt);
    drawStarfield(ctx, view, { alpha: AIRLESS.has(world) ? 0.16 : sky.starAlpha * 0.4, drift: (rs.clock || 0) * 2, t: rs.t, seed: 11, reduce: rs.reduce }); // sunlit ground in frame
    if (world === 'moon') drawPlanetDisc(ctx, 'earth', view.W * 0.8, view.H * 0.14, 18, { light, t: rs.t });
    if (world === 'europa') drawPlanetDisc(ctx, 'jupiter', view.W * 0.75, view.H * 0.16, 46, { light, t: rs.t });
    // above ~9 km the world is seen as a curved limb (its map, craters, haze); below ~3 km the perspective terrain
    const limbK = world === 'earth' ? 0 : sstep(3, 9, alt);
    const tg = world !== 'earth' ? resolveTarget(rs.target) : null;
    const baseScene = !!tg && tg.sequence === 'surface';
    const horY = baseScene ? baseHorizonY(view, d.groundY) : undefined; // a higher camera over a base
    const limbArgs = { altKm: alt, light, horizonY: horY ?? Math.min(d.groundY - view.H * 0.05, view.H * 0.62) };
    let limbDone = limbK >= 0.999 && drawBodyLimb(ctx, view, world, { ...limbArgs, alpha: 1 });
    if (!limbDone) {
      drawTerrain(ctx, view, world, { altM: alt * 1000, pxPerM: d.pxPerM, groundY: d.groundY, scrollX: d.scrollX, t: rs.t, seed: hash('site|' + world + '|' + (rs.seed || 0)), light, horizonY: horY });
      if (limbK > 0) limbDone = drawBodyLimb(ctx, view, world, { ...limbArgs, alpha: limbK });
    }
    const altM = alt * 1000;
    // surface base behind the landing site (MISSIONS-V2 §7.3): on the same perspective ground as the terrain
    if (baseScene && limbK < 0.95) {
      const proj = groundProjection(view, { groundY: d.groundY, pxPerM: d.pxPerM, altM, scrollX: d.scrollX, horizonY: horY });
      const lay = baseLayoutOf(tg, rs, craft);
      const since = events.unload != null ? rs.t - events.unload : null;
      const parked = !!flags.landed && events.touchdown == null && events.unload == null; // resumed after the landing
      // one depth-sorted pass: structures, vehicles and the crate together (drawBaseVehicles alone draws only vehicles)
      drawBase(ctx, view, lay, { proj, light, t: rs.t, reduce: rs.reduce, world, night: !!rs.night, alpha: 1 - limbK, vehicles: { since, parked, reduce: rs.reduce && !!flags.landed, landerH: craft.heightM || 6, landerW: craft.widthM || 4, crewed: !!rs.crewed } });
    }
    if (world !== 'earth' && limbK < 0.6) drawGroundShadow(ctx, d.craftX, d.groundY, { widthPx: (craft.widthM || 3) * d.pxPerM * 0.6, heightAboveM: altM, pxPerM: d.pxPerM, light, world, objHeightM: craft.heightM, objWidthM: Math.min(craft.widthM || 3, (craft.heightM || 3) * 0.6) });
    fx.draw(ctx, 'back');
    if (!flags.exploded) {
      const edl = edlStage(rs, craft, world, flags, events);
      const since = events.touchdown != null ? rs.t - events.touchdown : -1;
      // legs deploy during the terminal descent (~2.5 → 1.2 km) and stay out; footpads compress at contact
      const legs = flags.landed ? 1 : Math.max(0, Math.min(1, (2500 - altM) / 1300));
      const compress = since >= 0 ? Math.max(0, 1 - since / 0.45) * 0.75 + 0.25 : 0;
      // solar arrays stay stowed through entry, descent and touchdown; they unfold ~2 s after the dust settles
      const arrays = edl.encaps || craft.template === 'lander' ? (since >= 0 ? Math.max(0, Math.min(1, (since - 2) / 2.5)) : 0) : 1;
      if (edl.shell) {
        // entry inside the aeroshell: heat shield leading, plasma sheath + wake scaled by velocity; then the
        // supersonic chute on the backshell, heat-shield jettison, and the lander hanging under the backshell
        const D = edl.shell.shellD, k = d.pxPerM;
        const hShell = D * 0.67;
        const vel = Math.max(0, rs.tele?.velKms || 0);
        const topY = d.craftY - (edl.shieldOff ? D * 0.75 : hShell) * k;
        if (flags.chute) drawParachutes(ctx, d.craftX, topY, { count: 1, kind: 'dgb', deploy: Math.min(1, Math.max(0.15, (rs.t - (events.chute ?? rs.t - 2)) / 0.8)), t: rs.t, pxPerM: k * 0.5, sway: rs.reduce ? 0 : 3 });
        const heat = flags.chute ? 0 : Math.min(1, Math.max(0, (vel - 1.2) / 3.5)) * Math.min(1, Math.max(0, (alt - 8) / 15));
        if (heat > 0.02) drawReentryPlasma(ctx, d.craftX, d.craftY - D * 0.5 * k * 0.92, { intensity: heat, radiusPx: D * k * 0.5, angle: Math.PI, t: rs.t, reduce: rs.reduce }); // bow shock hugs the heat shield
        ctx.save(); ctx.translate(d.craftX, d.craftY);
        paintCraft(ctx, edl.shell, { pxPerM: k, light, mode: edl.shieldOff ? 'chute' : 'flight', legs: edl.shieldOff ? Math.min(1, (rs.t - (events.chute || 0) - 2.6) / 1.5) : 0, engineOn: false, t: rs.t });
        if (heat > 0.05) { // the heat shield glows dull orange
          const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, D * 0.6 * k);
          gr.addColorStop(0, `rgba(255,150,70,${(0.55 * heat).toFixed(3)})`); gr.addColorStop(1, 'rgba(255,90,30,0)');
          ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(0, -D * 0.05 * k, D * 0.62 * k, D * 0.2 * k, 0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      } else {
        if (flags.chute) drawParachutes(ctx, d.craftX, d.craftY - craft.heightM * d.pxPerM, { count: world === 'earth' ? 4 : 1, kind: world === 'earth' ? 'main' : 'dgb', deploy: 1, t: rs.t, pxPerM: d.pxPerM * 0.5, sway: rs.reduce ? 0 : 3 });
        if (world !== 'moon' && alt > 35 && alt < 120 && !flags.chute && !edl.encaps) drawReentryPlasma(ctx, d.craftX, d.craftY - craft.heightM * d.pxPerM * 0.4, { intensity: Math.min(1, (alt - 35) / 30), radiusPx: (craft.widthM || 4) * d.pxPerM * 0.6, angle: Math.PI, t: rs.t });
        const firing = flags.engineOn && !flags.landed && world !== 'earth';
        const co = { pxPerM: d.pxPerM, light, mode: flags.landed ? 'landed' : flags.chute ? 'chute' : 'flight', legs, compress, engineOn: flags.engineOn, t: rs.t, arrays };
        // plumes come out of each nozzle exit in craft-local metres (same transform as the hull): painted behind the hull
        const noz = firing ? craftNozzles(craft, co) : [];
        for (const n of noz) {
          drawPlume(ctx, { x: d.craftX + n.x * d.pxPerM, y: d.craftY - n.y * d.pxPerM, d: n.d }, { prop: n.prop || 'hypergolic', pBar: ambientPressure(world, alt), pxPerM: d.pxPerM, t: rs.t, angle: n.angle || 0, reduce: rs.reduce, seed: Math.round(n.x * 7) & 63, lengthM: n.lengthM ?? (n.d < 1.2 ? n.d * 10 : undefined), throttle: n.throttle ?? (n.prop === 'hypergolic' ? 0.75 : 1) });
        }
        if (world === 'earth' && flags.landed) drawFloating(ctx, rs, craft, d, light, co);
        else {
          ctx.save();
          ctx.translate(d.craftX, d.craftY);
          paintCraft(ctx, craft, co);
          ctx.restore();
        }
      }
    }
    fx.draw(ctx, 'front');
  }

  /**
   * Capsule floating after splashdown: bobbing, clipped at a wavy waterline, absorbed below, a vertically smeared
   * wave-broken reflection (slices of one offscreen render of the hull), a thin foam line, mains lying downwind.
   * No flotation collar: Dragon / Orion / Starliner float on their own hull.
   */
  const FLOAT = { c: null, g: null };
  function drawFloating(ctx, rs, craft, d, light, co) {
    const k = d.pxPerM, t = rs.reduce ? 0 : rs.t;
    const since = events.splashdown != null ? rs.t - events.splashdown : 3;
    const D = craft.widthM || 4, Hc = (craft.heightM || 3) + 1;
    const settle = Math.min(1, since / 1.2);
    const bob = Math.sin(t * 1.3) * 0.12 + Math.sin(t * 2.1 + 1) * 0.06;
    const sink = (0.25 + 0.55 * settle + bob) * k;                 // heat shield + ~25 % of the side under water
    const roll = rs.reduce ? 0 : Math.sin(t * 0.9) * 0.05 + Math.sin(t * 1.7) * 0.02;
    const wy = d.groundY;                                          // mean water level at the capsule
    const wave = (x) => wy + Math.sin(x * 0.09 + t * 2.2) * 0.9 + Math.sin(x * 0.23 - t * 3.1) * 0.5;
    const paint = (alpha = 1) => { ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(d.craftX, d.craftY + sink); ctx.rotate(roll); paintCraft(ctx, craft, co); ctx.restore(); };
    const x0 = d.craftX - D * k, x1 = d.craftX + D * k;
    const waterPath = (below) => {
      ctx.beginPath(); ctx.moveTo(x0 - 20, below ? rs.view.H + 10 : -10);
      for (let x = x0 - 20; x <= x1 + 20; x += 3) ctx.lineTo(x, wave(x));
      ctx.lineTo(x1 + 20, below ? rs.view.H + 10 : -10); ctx.closePath();
    };
    // collapsed mains floating well downwind (cut away at splashdown), mostly awash: muted, flat, irregular
    const mains = Math.max(1, craft.chutes || 3);
    for (let i = 0; i < Math.min(4, mains); i++) {
      const cx = d.craftX + (3.6 + i * 1.7) * D * 0.45 * k * (1 + 0.15 * Math.sin(i * 2.3)), cy = wy + (0.5 + i * 0.4) * k;
      const rx = D * 0.5 * k * (0.9 + 0.2 * Math.sin(i * 1.7 + t * 0.4)), ry = Math.max(1, D * 0.05 * k);
      ctx.save();
      const g = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
      g.addColorStop(0, 'rgba(214,210,198,0.5)'); g.addColorStop(0.3, 'rgba(184,92,62,0.45)'); g.addColorStop(0.55, 'rgba(220,216,206,0.5)'); g.addColorStop(0.8, 'rgba(184,92,62,0.4)'); g.addColorStop(1, 'rgba(214,210,198,0.3)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0.03 * Math.sin(t + i), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // hull rendered once per frame offscreen; the reflection is made of thin slices of it, flipped, smeared down and
    // displaced by the swell (smoothly varying offsets, so it ripples instead of breaking into bars)
    const dpr = (() => { try { const m = ctx.getTransform(); return Math.max(1, Math.min(2, Math.hypot(m.a, m.b))); } catch { return 1; } })();
    const SWp = Math.ceil(D * 2 * k * dpr) + 4, SHp = Math.ceil(Hc * k * dpr) + 4;
    if (!FLOAT.c || FLOAT.c.width < SWp || FLOAT.c.height < SHp) {
      try { FLOAT.c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SWp, SHp) : Object.assign(document.createElement('canvas'), { width: SWp, height: SHp }); FLOAT.g = FLOAT.c.getContext('2d'); } catch { FLOAT.c = null; }
    }
    ctx.save();
    waterPath(true); ctx.clip();
    if (FLOAT.g) {
      const g = FLOAT.g;
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, FLOAT.c.width, FLOAT.c.height);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.translate(D * k + 2 / dpr, Hc * k); g.rotate(roll); paintCraft(g, craft, co);
      const hPx = (Hc * k - sink) * 1.25;
      const step = 1.5;
      for (let y = 0; y < hPx; y += step) {
        const f = y / hPx;
        const off = (Math.sin(y * 0.16 + t * 2.4) * 1.2 + Math.sin(y * 0.045 - t * 1.3) * 2.2) * (0.4 + f * 1.6);
        const srcY = (Hc * k - sink - y / 1.25) * dpr; // flipped, smeared ×1.25
        if (srcY < 0) break;
        ctx.globalAlpha = 0.26 * (1 - f) * (1 - f);
        ctx.drawImage(FLOAT.c, 0, Math.max(0, srcY - step * dpr), SWp, step * dpr, d.craftX - D * k - 2 / dpr + off, wy + y, SWp / dpr, step + 0.6);
      }
    }
    ctx.globalAlpha = 1;
    // submerged hull: faint, blue-green absorbed
    paint(0.3);
    ctx.fillStyle = 'rgba(16,74,88,0.35)';
    ctx.beginPath(); ctx.ellipse(d.craftX, wy + 0.4 * k, D * 0.55 * k, 0.9 * k, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // hull above the waterline
    ctx.save();
    waterPath(false); ctx.clip();
    paint(1);
    ctx.restore();
    // thin broken foam line where the hull meets the water (stronger in the first seconds), no collar
    ctx.save();
    const fw = D * 0.52 * k;
    for (let i = 0; i < 28; i++) {
      const h = Math.sin(i * 12.9898) * 43758.5453, r1 = h - Math.floor(h), h2 = Math.sin(i * 78.233) * 12543.21, r2 = h2 - Math.floor(h2);
      const a = (i / 28) * Math.PI * 2 + r1 * 0.2 + (rs.reduce ? 0 : t * 0.05);
      const ex = d.craftX + Math.cos(a) * fw * (1 + r2 * 0.1), ey = wave(d.craftX + Math.cos(a) * fw) + 0.05 * k + Math.sin(a) * Math.max(1, 0.12 * k);
      ctx.globalAlpha = (0.08 + 0.2 * r2) * (Math.sin(a) > 0 ? 1 : 0.4) * (0.5 + 0.5 * (1 - settle));
      ctx.fillStyle = '#eef3f4';
      ctx.beginPath(); ctx.ellipse(ex, ey, Math.max(0.7, (0.08 + r1 * 0.16) * k), Math.max(0.4, (0.025 + r2 * 0.03) * k), 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    void light;
  }

  function drawOrbit(ctx, rs) {
    const view = rs.view;
    const o = orbitFrame(rs);
    const light = lightOf(rs);
    const flags = flagsOf(rs);
    ctx.fillStyle = '#000'; ctx.fillRect(-40, -40, view.W + 80, view.H + 80);
    drawStarfield(ctx, view, { alpha: o.r > view.W * 0.25 ? 0.32 : 0.8, drift: (rs.clock || 0) * 3, t: rs.t, seed: 13, reduce: rs.reduce }); // lit disc in frame
    drawPlanetDisc(ctx, rs.world || rs.bodyId || 'moon', o.cx, o.cy, o.r, { light, t: rs.t });
    fx.draw(ctx, 'back');
    if (!flags.exploded) {
      const raw = craftArt(rs.craftId);
      const encapsulated = raw && (raw.template === 'rotorcraft' || raw.template === 'rover' || (raw.aeroshell && raw.template === 'lander'));
      if (encapsulated) { drawEntryStack(ctx, raw, o, light, rs); fx.draw(ctx, 'front'); return; }
      const craft = raw;
      // probes are framed by their real array span (Europa Clipper: ~30 m wings, 3 m HGA); crewed craft by width
      const span = craft.template === 'probe' ? 0.84 : 0.32;
      const k = Math.max(2, Math.min(14, (view.W * span) / Math.max(1, craft.widthM || 4)));
      const co = { pxPerM: k, light, mode: 'flight', heading: 0, engineOn: flags.engineOn, t: rs.t };
      if (flags.engineOn) { // the burn comes out of the craft's own engine bell(s), painted behind the hull
        for (const n of craftNozzles(craft, co)) {
          if (n.prop === 'ion') continue;
          drawPlume(ctx, { x: o.craftX + n.x * k, y: o.craftY - n.y * k, d: n.d }, { prop: n.prop || 'hypergolic', pBar: 0, pxPerM: k, t: rs.t, angle: n.angle || 0, lengthM: Math.max(4, n.d * 12), throttle: 0.8, reduce: rs.reduce, seed: 5 });
        }
      }
      ctx.save(); ctx.translate(o.craftX, o.craftY); paintCraft(ctx, craft, co); ctx.restore();
    }
    fx.draw(ctx, 'front');
  }

  /** Entry vehicle on approach: cruise stage (solar cells, radiators) on the backshell, heat shield leading. */
  function drawEntryStack(ctx, raw, o, light, rs) {
    const D = raw.aeroshell?.d || (raw.template === 'rotorcraft' ? 3.75 : 4.5);
    const shell = { name: (raw.name || '') + ' aeroshell', template: 'aeroshell', shellD: D, backshellMat: 'white_paint' };
    const k = Math.max(3, Math.min(16, (rs.view.W * 0.26) / D));
    ctx.save();
    ctx.translate(o.craftX, o.craftY);
    ctx.rotate(-Math.PI / 2 + 0.12); // heat shield leading (toward the planet, below-left), seen from the side
    // cruise stage behind the backshell: short cylinder with a ring of solar cells and two radiators
    const cw = D * 0.8 * k, ch = D * 0.16 * k, cy = -(D * 0.67) * k;
    const g = ctx.createLinearGradient(-cw / 2, 0, cw / 2, 0);
    g.addColorStop(0, '#5f6670'); g.addColorStop(0.35, '#d4d8dc'); g.addColorStop(1, '#3b4048');
    ctx.fillStyle = g; ctx.fillRect(-cw / 2, cy - ch, cw, ch);
    ctx.fillStyle = '#1a2650'; ctx.fillRect(-cw / 2 + 1, cy - ch * 0.85, cw - 2, ch * 0.5);
    ctx.strokeStyle = 'rgba(140,160,210,0.35)'; ctx.lineWidth = 0.6; ctx.beginPath();
    for (let x = -cw / 2 + cw / 10; x < cw / 2; x += cw / 10) { ctx.moveTo(x, cy - ch * 0.85); ctx.lineTo(x, cy - ch * 0.35); }
    ctx.stroke();
    ctx.fillStyle = '#c9ccd0'; ctx.fillRect(-cw * 0.08, cy - ch - 0.35 * k, cw * 0.16, 0.35 * k); // antenna / thruster cluster
    paintCraft(ctx, shell, { pxPerM: k, light, mode: 'flight', t: rs.t });
    ctx.restore();
  }

  return R;
}

/** Convenience used by the preview harness: everything still attached for given flags. */
export { attachedParts };

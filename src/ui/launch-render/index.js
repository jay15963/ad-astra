// launch-render/index.js — scene composer. The ONLY module launch-scene.js (and tools/launch-preview.js)
// talk to. Builds each frame from a RenderState snapshot (README.md §3) plus events (§4).
// STUB (architect pass, owned by the integrator): composes the other modules' stubs into a complete,
// consistent picture so the preview harness works end to end. Builders improve their modules; this file
// only orchestrates (order of layers, event → fx/debris, camera).

import { hash, SUN, sunFor, drawSky, drawStarfield, drawEarthLimb, drawClouds, drawCloudsFront, drawLaunchSite, siteStyleOf, drawTerrain, drawGroundShadow, drawPlanetDisc, textureStats } from './textures.js';
import { resolveStack, attachedParts, detachedBy, activeNozzles, paintVehicle, paintPart, paintCraft, craftArt, craftNozzles } from './vehicles.js';
import { createFx, ambientPressure, drawPlume, drawCondensationCollar, drawParachutes, drawReentryPlasma } from './fx.js';
import { createCamera, ascentFrame, descentFrame, orbitFrame } from './camera.js';

export { SUN } from './textures.js';
export { loadVehicleArt, setVehicleArt } from './vehicles.js';

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

  const flagsOf = (rs) => ({ ...(rs.flags || {}), boostersOff: !!(rs.flags?.boostersOff || events.boosterSep != null || rs.flags?.staged) });
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

  const R = {
    reset() { events = {}; fx.clear(); prevGround = null; trail.n = 0; trail.head = 0; },
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
          fx.explosion(p.x, p.y, { scale: 1.2, world: rs.world, dir: tilt - Math.PI / 2 }); cam.shake(2); break;
        }
        case 'touchdown': { const p = vehicleScreenPos(rs); cam.shake(payload.hard ? 1.2 : 0.5); fx.landingDust(p.x, p.y + 20, { intensity: 1, world: rs.world, pxPerM: 4, dt: 0.5 }); break; }
        case 'splashdown': {
          const c = craftArt(descentCraftId(rs)); const d = descentFrame(rs, c.heightM);
          fx.splash(d.craftX, d.groundY, { scale: Math.max(0.6, Math.min(2, (c.widthM || 4) * d.pxPerM / 40)) }); break;
        }
        case 'anomaly': cam.shake(0.4 + 0.8 * (payload.severity || 0)); break;
        default: break;
      }
    },

    update(rs) {
      if (!rs) return;
      rs = visualRS(rs);
      if (rs.events) for (const [k, v] of Object.entries(rs.events)) if (events[k] == null && Number.isFinite(v)) events[k] = v;
      last = rs;
      clock.t = Number(rs.t) || 0; clock.alt = rs.tele?.altKm || 0; clock.reduce = !!rs.reduce;
      const dt = Math.max(0, Math.min(0.1, Number(rs.dt) || 0));
      fx.setReduce(!!rs.reduce);
      cam.update(dt, rs.reduce);
      const flags = flagsOf(rs);
      if (rs.mode === 'ascent' || rs.mode === 'pad') {
        const st = stackOf(rs);
        // visual-only booster separation (no milestone): at ~42 km, before staging
        if (st.hasBoosters && !flags.staged && events.boosterSep == null && (rs.tele?.altKm || 0) > 42) R.event('boosterSep');
        const fr = ascentFrame(rs, st.heightM);
        if (prevGround != null) {
          const dy = Math.max(-80, Math.min(80, fr.groundY - prevGround));
          if (Number.isFinite(dy) && !flags.exploded) { const sh = (rs.tele?.altKm || 0) < 3 ? dy : dy * 0.05 + 0.8; fx.shift(0, sh); trailShift(0, sh); }
        }
        prevGround = fr.groundY;
        const pBar = ambientPressure('earth', rs.tele?.altKm);
        for (let i = 0; i < trail.n; i++) trail.age[i] += dt;
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
          // LOX boil-off venting on the pad (builder: vent valve positions per stack)
          const v1 = toScreen(fr, st.maxWidthM * 0.2, st.heightM * 0.55), v2 = toScreen(fr, -st.maxWidthM * 0.2, st.heightM * 0.3);
          fx.vent(v1.x, v1.y, { dir: 1, dt, rate: 1 }); fx.vent(v2.x, v2.y, { dir: -1, dt, rate: 0.6 });
        }
      } else if (rs.mode === 'descent' && flags.engineOn && !flags.landed) {
        const c = craftArt(descentCraftId(rs));
        const d = descentFrame(rs, c.heightM);
        const altM = (rs.tele?.altKm || 0) * 1000;
        const reach = 60 + 1.5 * nozzleHeightM(c); // plume reaches the ground from this height (HLS: high-mounted thrusters)
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
      rs = visualRS(rs);
      ctx.save();
      const o = cam.offset();
      ctx.translate(o.x, o.y);
      if (rs.mode === 'orbit') drawOrbit(ctx, rs);
      else if (rs.mode === 'descent') drawDescent(ctx, rs);
      else drawAscent(ctx, rs);
      ctx.restore();
    },

    drawPadWindow(ctx, rect, rs) {
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
      ctx.translate(rect.w / 2, rect.h * gyR);
      paintVehicle(ctx, st, { pxPerM: pf.pxPerM, light: lightOf(rs), flags: {}, frost: 1, t: rs.t, reduce: rs.reduce });
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
    if (fr.groundY < view.H + 400) {
      const since = events.liftoff != null ? rs.t - events.liftoff : -1;
      drawLaunchSite(ctx, view, { style: siteStyleOf(rs.siteId || st.site), groundY: fr.groundY, pxPerM: fr.pxPerM, t: rs.t, tower: st.tower, towerArm: since < 0 ? 1 : Math.max(0, 1 - since / 1.5), towerHeightM: st.heightM * 1.05, reduce: rs.reduce, vehicleD: coreDiameter(st) });
    }
    drawTrail(ctx, rs, light);
    fx.draw(ctx, 'back');
    if (!flags.exploded) {
      const pBar = ambientPressure('earth', alt);
      if (flags.engineOn) {
        for (const n of activeNozzles(st, flags)) {
          const s = toScreen(fr, n.x, n.y);
          drawPlume(ctx, { x: s.x, y: s.y, d: n.d }, { prop: n.prop, pBar, pxPerM: fr.pxPerM, t: rs.t, angle: fr.tilt, reduce: rs.reduce, seed: hash(n.partId || '') % 97 });
        }
      }
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
      for (let k = 0; k < trail.n - 1; k++) {
        const i = (trail.head - 1 - k + TRAIL_N * 2) % TRAIL_N, j = (i - 1 + TRAIL_N) % TRAIL_N;
        const ag = trail.age[i];
        if (ag > life) break;
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
    drawTerrain(ctx, view, world, { altM: alt * 1000, pxPerM: d.pxPerM, groundY: d.groundY, scrollX: d.scrollX, t: rs.t, seed: hash('site|' + world + '|' + (rs.seed || 0)), light });
    const altM = alt * 1000;
    if (world !== 'earth') drawGroundShadow(ctx, d.craftX, d.groundY, { widthPx: (craft.widthM || 3) * d.pxPerM * 0.6, heightAboveM: altM, pxPerM: d.pxPerM, light, world, objHeightM: craft.heightM, objWidthM: Math.min(craft.widthM || 3, (craft.heightM || 3) * 0.6) });
    fx.draw(ctx, 'back');
    if (!flags.exploded) {
      if (flags.chute) drawParachutes(ctx, d.craftX, d.craftY - craft.heightM * d.pxPerM, { count: world === 'earth' ? 4 : 1, kind: world === 'earth' ? 'main' : 'dgb', deploy: 1, t: rs.t, pxPerM: d.pxPerM * 0.5, sway: rs.reduce ? 0 : 3 });
      if (world !== 'moon' && alt > 35 && alt < 120 && !flags.chute) drawReentryPlasma(ctx, d.craftX, d.craftY - craft.heightM * d.pxPerM * 0.4, { intensity: Math.min(1, (alt - 35) / 30), radiusPx: (craft.widthM || 4) * d.pxPerM * 0.6, angle: Math.PI, t: rs.t });
      const since = events.touchdown != null ? rs.t - events.touchdown : -1;
      // legs deploy during the terminal descent (~2.5 → 1.2 km) and stay out; footpads compress at contact
      const legs = flags.landed ? 1 : Math.max(0, Math.min(1, (2500 - altM) / 1300));
      const compress = since >= 0 ? Math.max(0, 1 - since / 0.45) * 0.75 + 0.25 : 0;
      const firing = flags.engineOn && !flags.landed && world !== 'earth';
      const co = { pxPerM: d.pxPerM, light, mode: flags.landed ? 'landed' : flags.chute ? 'chute' : 'flight', legs, compress, engineOn: flags.engineOn, t: rs.t };
      // plumes come out of each nozzle exit in craft-local metres (same transform as the hull): painted behind the hull
      const noz = firing ? craftNozzles(craft, co) : [];
      for (const n of noz) {
        drawPlume(ctx, { x: d.craftX + n.x * d.pxPerM, y: d.craftY - n.y * d.pxPerM, d: n.d }, { prop: n.prop || 'hypergolic', pBar: ambientPressure(world, alt), pxPerM: d.pxPerM, t: rs.t, angle: n.angle || 0, reduce: rs.reduce, seed: Math.round(n.x * 7) & 63, lengthM: n.lengthM ?? (n.d < 1.2 ? n.d * 10 : undefined), throttle: n.prop === 'hypergolic' ? 0.75 : 1 });
      }
      if (world === 'earth' && flags.landed) drawFloating(ctx, rs, craft, d, light, co);
      else {
        ctx.save();
        ctx.translate(d.craftX, d.craftY);
        paintCraft(ctx, craft, co);
        ctx.restore();
      }
    }
    fx.draw(ctx, 'front');
  }

  /** Capsule floating after splashdown: bobbing, clipped at a wavy waterline, absorbed below, broken reflection, foam, collapsed mains. */
  function drawFloating(ctx, rs, craft, d, light, co) {
    const k = d.pxPerM, W = rs.view.W, t = rs.reduce ? 0 : rs.t;
    const since = events.splashdown != null ? rs.t - events.splashdown : 3;
    const D = craft.widthM || 4;
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
    // collapsed main chutes lying on the water downwind, with risers to the capsule apex
    const mains = Math.max(1, craft.chutes || 3);
    for (let i = 0; i < Math.min(4, mains); i++) {
      const cx = d.craftX + (2.2 + i * 1.4) * D * 0.45 * k * (1 + 0.15 * Math.sin(i * 2.3)), cy = wy + (0.3 + i * 0.35) * k;
      const rx = D * 0.55 * k * (0.9 + 0.2 * Math.sin(i * 1.7 + t * 0.4)), ry = Math.max(1.2, D * 0.08 * k);
      ctx.save();
      ctx.strokeStyle = 'rgba(220,214,200,0.55)'; ctx.lineWidth = Math.max(0.5, 0.03 * k);
      ctx.beginPath(); ctx.moveTo(d.craftX, wy - (craft.heightM || 3) * 0.85 * k + sink); ctx.quadraticCurveTo((d.craftX + cx) / 2, wy - 0.4 * k, cx - rx, cy); ctx.stroke();
      const g = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
      g.addColorStop(0, '#e9e4d8'); g.addColorStop(0.3, '#d65a2c'); g.addColorStop(0.5, '#efeae0'); g.addColorStop(0.75, '#d65a2c'); g.addColorStop(1, '#e2ddd0');
      ctx.globalAlpha = 0.85; ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0.03 * Math.sin(t + i), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#0b2a3a'; ctx.beginPath(); ctx.ellipse(cx, cy + ry * 0.5, rx * 0.95, ry * 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // broken reflection (vertically stretched, wavy strips) below the waterline
    ctx.save();
    waterPath(true); ctx.clip();
    const hPx = (craft.heightM || 3) * k;
    for (let y = 0; y < hPx * 1.3; y += 2) {
      const off = Math.sin(y * 0.35 + t * 3) * (1 + y * 0.04) + Math.sin(y * 0.11 - t * 1.7) * 1.5;
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, wy + y, x1 - x0, 2); ctx.clip();
      ctx.translate(off, wy); ctx.scale(1, -1.15); ctx.translate(0, -wy);
      ctx.globalAlpha = 0.22 * (1 - y / (hPx * 1.3));
      ctx.translate(d.craftX, d.craftY + sink); ctx.rotate(roll);
      paintCraft(ctx, craft, co);
      ctx.restore();
    }
    // submerged hull: faint, blue-green absorbed
    paint(0.32);
    ctx.restore();
    ctx.save();
    waterPath(true); ctx.clip();
    ctx.fillStyle = 'rgba(16,74,88,0.35)';
    ctx.beginPath(); ctx.ellipse(d.craftX, wy + 0.4 * k, D * 0.55 * k, 0.9 * k, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // hull above the waterline
    ctx.save();
    waterPath(false); ctx.clip();
    paint(1);
    ctx.restore();
    // foam collar hugging the hull + wet line
    ctx.save();
    const fw = D * 0.56 * k;
    // irregular foam: seeded blobs along the ring where the hull meets the water (denser at the front)
    for (let i = 0; i < 46; i++) {
      const h = Math.sin(i * 12.9898) * 43758.5453, r1 = h - Math.floor(h), h2 = Math.sin(i * 78.233) * 12543.21, r2 = h2 - Math.floor(h2);
      const a = (i / 46) * Math.PI * 2 + r1 * 0.2 + (rs.reduce ? 0 : t * 0.05);
      const ex = d.craftX + Math.cos(a) * fw * (1 + r2 * 0.12), ey = wy + 0.1 * k + Math.sin(a) * Math.max(1.5, 0.22 * k);
      const front = Math.sin(a) > 0 ? 1 : 0.55;
      ctx.globalAlpha = (0.35 + 0.45 * r2) * front;
      ctx.fillStyle = '#f2f6f7';
      ctx.beginPath(); ctx.ellipse(ex, ey, Math.max(0.8, (0.12 + r1 * 0.22) * k), Math.max(0.5, (0.04 + r2 * 0.05) * k), 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalAlpha = 0.35 + 0.25 * (1 - settle);
    ctx.fillStyle = '#f4f7f8';
    ctx.beginPath(); ctx.ellipse(d.craftX, wy + 0.25 * k, fw * (1.25 + 0.6 * (1 - settle)), Math.max(1.5, 0.35 * k), 0, 0, Math.PI); ctx.fill();
    ctx.restore();
    void W; void light;
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
      const k = Math.max(2, Math.min(14, (view.W * 0.32) / Math.max(1, craft.widthM || 4)));
      if (flags.engineOn) drawPlume(ctx, { x: o.craftX - (craft.bus?.w || 2) * k * 0.5, y: o.craftY, d: 0.5 }, { prop: 'hypergolic', pBar: 0, pxPerM: k, t: rs.t, angle: Math.PI / 2, lengthM: 6, reduce: rs.reduce });
      ctx.save(); ctx.translate(o.craftX, o.craftY); paintCraft(ctx, craft, { pxPerM: k, light, mode: 'flight', heading: 0, engineOn: flags.engineOn, t: rs.t }); ctx.restore();
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

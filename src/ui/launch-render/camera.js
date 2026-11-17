// launch-render/camera.js — framing (px per metre), follow, shake and parallax. Contract: README.md §5.4.
// Ascent: fixed tracking camera on the pad, then follow + zoom-out, re-frame on the upper stage after staging.
// Descent: metric near the ground, log above, pulled back under parachutes. Deterministic (no Math.random).

import { resolveStack, attachedParts } from './vehicles.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/** Shake/offset state. Deterministic: offsets come from sums of sines of an internal clock. */
export function createCamera() {
  let amt = 0, tt = 0, red = false;
  return {
    shake(a = 1) { amt = Math.max(amt, clamp(num(a), 0, 2)); },
    update(dt, reduce = false) { red = !!reduce; tt += num(dt); amt = Math.max(0, amt - num(dt) * 1.6); },
    offset() {
      if (red || amt <= 0) return { x: 0, y: 0 };
      const a = amt * 5;
      return { x: a * (Math.sin(tt * 61.3) * 0.6 + Math.sin(tt * 23.1) * 0.4), y: a * (Math.sin(tt * 47.9) * 0.6 + Math.sin(tt * 31.7) * 0.4) };
    },
    rot() { return red ? 0 : amt * 0.004 * Math.sin(tt * 37); },
    amount() { return amt; },
  };
}

const smooth = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/**
 * Lowest attached part (vehicle metres) and how far the camera has moved onto it (0..1). After staging the
 * framing glides from the whole stack to the upper stack, ~0.6 s after the separation so the player sees
 * the first stage fall away before the camera follows the upper stage.
 */
function focusOf(rs, hM) {
  if (!rs?.flags?.staged) return { yLo: 0, b: 0 };
  let minY = 0;
  try {
    const st = resolveStack(rs.vehicleId, rs.craftId, { crewed: !!rs.crewed });
    const parts = attachedParts(st, { ...rs.flags, boostersOff: true });
    minY = parts.length ? Math.min(...parts.map((p) => num(p.y))) : 0;
  } catch { minY = 0; }
  minY = clamp(minY, 0, hM * 0.85);
  const tS = rs?.events?.staging;
  const since = Number.isFinite(tS) ? num(rs.t) - tS : Infinity;
  const b = Number.isFinite(since) ? smooth((since - 0.6) / 2.4) : 1;
  // zoom onto the upper stack once the spent stage has fallen well behind (it stays in frame meanwhile);
  // while it is still close the framing slides up-right so the stage has room below-left
  const zb = Number.isFinite(since) ? smooth((since - 6.5) / 4.5) : 1;
  const kB = Number.isFinite(since) ? smooth(since / 1.5) * (1 - smooth((since - 9) / 3)) : 0;
  return { yLo: minY * b, b, zb, kB, minY };
}

/** Visual height (m) of the climb used for the ground: metric near the pad, logarithmic above (the
 *  animation clock compresses a 2-minute climb into ~10 s; this keeps the pad in view for a few seconds). */
export function visualClimbM(altKm) {
  const h = Math.max(0, num(altKm)) * 1000;
  return 45 * Math.log(1 + h / 45);
}

/** Pitch from vertical (rad) of a gravity turn: kicks over after the tower, ~16° at Max-Q, ~55° at MECO. */
export function gravityTurn(altKm) {
  const a = Math.max(0, num(altKm) - 0.4);
  return 1.25 * (1 - Math.exp(-a / 45));
}

/**
 * Ascent framing. On the pad the camera is a fixed long-range tracking camera: the rocket rises through the
 * frame while the ground stays put; once it reaches the middle of the screen the camera tracks it and the
 * pad falls away below. The stack zooms out while it climbs and the camera re-frames on the upper stage after
 * staging. Pad mode ('pad', countdown window) matches padFrame() so window and full screen agree.
 */
export function ascentFrame(rs, stackHeightM) {
  const W = num(rs?.view?.W, 375), H = num(rs?.view?.H, 600);
  const alt = Math.max(0, num(rs?.tele?.altKm));
  const hM = Math.max(5, num(stackHeightM, 50));
  const pad = rs?.mode === 'pad';
  const vis = pad ? 0 : visualClimbM(alt);
  // one world scale for rocket, tower, pad and smoke: the pad shot (0.58 H) eases into the climb framing (0.42 H)
  // over the first ~60 visual metres, so nothing jumps at T-0 and the camera zooms out by scaling the whole world
  const base = (H * (pad ? 0.58 : 0.42 + 0.16 * (1 - smooth(vis / 60)))) / hM;
  const z1 = 1 - 0.5 * smooth(vis / 150);
  const z2 = 1 - 0.22 * clamp(alt / 60, 0, 1);
  const f = focusOf(rs, hM);
  const upper = Math.max(4, hM - (f.minY || 0));
  // after staging the camera closes in on the upper stack: ~120-160 px long on a phone, so the vacuum bell,
  // interstage and payload adapter read clearly (never zooms out)
  const pre = base * z1 * z2;
  const targetPx = clamp(H * 0.19, 110, 165);
  const ppmUp = Math.max(pre, Math.min(targetPx / upper, (W * 0.55) / upper));
  const pxPerM = f.minY > 0 ? pre + (ppmUp - pre) * f.zb : pre;
  const tilt = pad ? 0 : gravityTurn(alt);
  // tracked: the middle of the visible stack sits a bit above screen centre
  const yMid = (f.yLo + hM) / 2;
  const kB = f.kB || 0;
  const fx = W * (0.5 + 0.16 * kB * Math.sign(Math.sin(tilt) || 1)), fy = H * (0.45 - 0.09 * kB);
  const trackX = fx - Math.sin(tilt) * yMid * pxPerM;
  const trackY = fy + Math.cos(tilt) * yMid * pxPerM;
  const padY = H * 0.84;
  const rise = vis * pxPerM;
  const anchorY = pad ? padY : Math.max(trackY, padY - rise);
  const anchorX = pad ? W / 2 : trackX;
  const groundY = anchorY + rise;
  const pxPerKm = 150 * clamp(H / 620, 0.6, 1.6);
  const drift = Math.pow(alt, 1.25) * 6;
  return { pxPerM, anchorX, anchorY, tilt, groundY, pxPerKm, drift };
}

/** Descent framing: craft held near mid-screen; the ground rises to meet it (metric near the ground). */
/** 0..1 blend toward the parachute framing (eases in when the chute opens, out after cut/landing). */
function chuteFraming(rs) {
  const ev = rs?.events || {};
  const t = num(rs?.t);
  if (rs?.flags?.chute) return Number.isFinite(ev.chute) ? smooth((t - ev.chute) / 1.5) : 1;
  if (!Number.isFinite(ev.chute)) return 0;
  const ends = [ev.powered, ev.splashdown, ev.touchdown].filter((v) => Number.isFinite(v) && v >= ev.chute);
  return ends.length ? 1 - smooth((t - Math.min(...ends)) / 1.5) : 0;
}

export function descentFrame(rs, craftHeightM) {
  const W = num(rs?.view?.W, 375), H = num(rs?.view?.H, 600);
  const altM = Math.max(0, num(rs?.tele?.altKm)) * 1000;
  const hM = Math.max(1, num(craftHeightM, 4));
  // under parachutes the camera pulls back and drops the craft lower so the canopies fit above it
  const k = chuteFraming(rs);
  const pxPerM = clamp((H * 0.2) / hM, 0.4, 60) * (1 - 0.68 * k);
  const craftX = W / 2;
  const craftY = H * (0.52 + 0.2 * k); // base of the craft (footpads / heat shield)
  const metric = altM * pxPerM;
  const far = Math.log10(1 + altM / 20) * H * 0.18 + H * 0.3;
  const landed = !!rs?.flags?.landed;
  // metric close to the ground, logarithmic above; min() keeps the hand-over continuous (no jump)
  const dist = landed ? 0 : Math.min(metric, far, H * 1.4);
  const groundY = craftY + dist;
  const horizonY = Math.min(groundY - H * 0.05, H * 0.62);
  const scrollX = num(rs?.clock) * 40 * clamp(altM / 2000, 0, 1);
  return { pxPerM, craftX, craftY: landed ? groundY : craftY, groundY, horizonY, scrollX, landedY: groundY };
}

/** Orbit-arrival framing: planet disc rising from the bottom as the craft approaches. */
export function orbitFrame(rs) {
  const W = num(rs?.view?.W, 375), H = num(rs?.view?.H, 600);
  const k = clamp(num(rs?.progress, 0), 0, 1);
  const r = W * (0.55 + 1.6 * k);
  return { cx: W / 2, cy: H + r * 0.62, r, craftX: W * 0.5, craftY: H * 0.36 };
}

/** Pad view inside a rect (countdown window). */
export function padFrame(rect, stackHeightM) {
  const hM = Math.max(5, num(stackHeightM, 50));
  return { pxPerM: (rect.h * 0.58) / hM, baseX: rect.x + rect.w * 0.5, groundY: rect.y + rect.h * 0.84 };
}

export function parallax(depth, x) { return num(x) * num(depth, 1); }

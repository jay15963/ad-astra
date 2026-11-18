// launch-render/infra.js — orbital stations and surface bases in the Launch Day scene (MISSIONS-V2.md §7.3).
// Presentation only: reads the SceneTarget snapshot (rs.target, copied from state.activeLaunch.target) and the art
// in data/vehicle-art.json (`modules`, `baseVehicles`). Never touches game state. Pure layout functions
// (layoutStation, layoutBase, dockPose, releasePose, vehicleStates) are deterministic and Node-safe; painters draw
// at the current ctx origin, never reset the transform and never throw on unknown ids.

import { hash, rng, SUN, cached, peekCached, lightBucket, skyColors, bodyLook } from './textures.js';
import { moduleArt, baseVehicleArt, paintCraft, MATERIALS } from './vehicles.js';

const TAU = Math.PI * 2;
const num = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(+v) ? +v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (u) => { const t = clamp(u, 0, 1); return t * t * (3 - 2 * t); };
const AIRLESS = new Set(['moon', 'mercury', 'europa', 'ganymede', 'callisto', 'io', 'phobos', 'deimos', 'ceres', 'vesta', 'enceladus', 'triton', 'pluto', 'charon']);

// ------------------------------------------------------------------ colour helpers
const RGBC = new Map();
function rgbOf(c) {
  let v = RGBC.get(c);
  if (v) return v;
  if (/^rgb/.test(String(c))) {
    const m = String(c).match(/[\d.]+/g) || [];
    v = [num(m[0], 128), num(m[1], 128), num(m[2], 128)];
    RGBC.set(c, v);
    return v;
  }
  const s = String(c || '#888888').replace('#', '');
  const h = s.length === 3 ? s.split('').map((x) => x + x).join('') : s.padEnd(6, '8');
  v = [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
  RGBC.set(c, v);
  return v;
}
const css = (c, a = 1) => `rgba(${Math.round(clamp(c[0], 0, 255))},${Math.round(clamp(c[1], 0, 255))},${Math.round(clamp(c[2], 0, 255))},${a >= 1 ? 1 : a.toFixed(3)})`;
const scaleC = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const matC = (id) => MATERIALS[id] || MATERIALS.white_paint;

/** Device scale of the destination (scene applies setTransform(dpr)); clamp 1..2. */
function devScale(ctx) {
  try { const m = ctx.getTransform?.(); if (m) return clamp(Math.hypot(m.a, m.b) || 1, 1, 2); } catch { /* ignore */ }
  return 1;
}
function L3(light) {
  const ax = num(light?.ax, SUN.ax), ay = num(light?.ay, SUN.ay);
  const n = Math.hypot(ax, ay, 0.55) || 1;
  return [ax / n, ay / n, 0.55 / n];
}

/**
 * Cylinder-shaded gradient across a body, from screen point a to b (the two silhouette edges). n(s) sweeps from
 * a to b with a z component toward the viewer: ambient + Lambert + a little specular, material colours.
 */
function cylGrad(ctx, ax, ay, bx, by, mat, light, { amb = 0.3, spec = null, tint = null } = {}) {
  const m = typeof mat === 'string' ? matC(mat) : mat;
  const base = tint ? rgbOf(tint) : rgbOf(m.base), hi = rgbOf(m.light || '#ffffff'), lo = rgbOf(m.dark || '#333333');
  const L = L3(light);
  let ux = bx - ax, uy = by - ay;
  const ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
  const g = ctx.createLinearGradient(ax, ay, bx, by);
  const sp = spec == null ? num(m.spec, 0.2) : spec;
  for (let i = 0; i <= 6; i++) {
    const s = -1 + (2 * i) / 6;
    const z = Math.sqrt(Math.max(0, 1 - s * s));
    const nl = Math.max(0, s * ux * L[0] + s * uy * L[1] + z * L[2]);
    const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz) || 1;
    const nh = Math.max(0, (s * ux * hx + s * uy * hy + z * hz) / hl);
    const I = amb + (1 - amb) * nl;
    let c = I < 0.5 ? mixC(lo, base, I * 2) : mixC(base, hi, (I - 0.5) * 0.7);
    const sv = sp * Math.pow(nh, 18);
    c = mixC(c, hi, clamp(sv, 0, 1));
    g.addColorStop(i / 6, css(c));
  }
  return g;
}

// ------------------------------------------------------------------ target snapshot

const SEQUENCES = new Set(['dock', 'berth', 'release', 'surface']);
const TGT = new WeakMap();
/**
 * Normalised SceneTarget with resolved art (MISSIONS-V2 §7.2): modules[i].art, vehicles[i].art, payloadArt.
 * Tolerant of missing fields; null for anything that is not an object. Memoised per input object.
 */
export function resolveTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const hit = TGT.get(t);
  if (hit) return hit;
  const grp = (list, artOf, cap) => (Array.isArray(list) ? list : [])
    .filter((m) => m && (typeof m === 'string' || m.id))
    .map((m) => (typeof m === 'string' ? { id: m, n: 1 } : m))
    .map((m) => ({ id: String(m.id), n: clamp(Math.round(num(m.n, 1)), 1, cap), art: artOf(m.id) }));
  const kind = t.kind === 'base' ? 'base' : 'station';
  const sequence = SEQUENCES.has(t.sequence) ? t.sequence : kind === 'base' ? 'surface' : (Array.isArray(t.modules) && t.modules.length && !t.newAsset ? 'dock' : 'release');
  const p = t.payload && typeof t.payload === 'object' ? t.payload : {};
  const payload = { kind: p.kind || null, moduleId: p.moduleId || null, vehicleTypeId: p.vehicleTypeId || null, qty: clamp(Math.round(num(p.qty, 1)), 1, 6) };
  const r = {
    ...t, kind, sequence, newAsset: !!t.newAsset, name: String(t.name || ''),
    modules: grp(t.modules, moduleArt, 999), vehicles: grp(t.vehicles, baseVehicleArt, 99), vehicleList: Array.isArray(t.vehicles),
    sizeTier: clamp(Math.round(num(t.sizeTier, 0)), 0, 5), stageN: num(t.stageN, 0),
    bodyId: t.bodyId || (kind === 'base' ? 'moon' : 'earth'), site: t.site || null,
    traits: Array.isArray(t.traits) ? t.traits.map(String) : [],
    payload,
    payloadArt: payload.moduleId ? moduleArt(payload.moduleId) : null,
    payloadVehicleArt: payload.vehicleTypeId ? baseVehicleArt(payload.vehicleTypeId) : null,
  };
  r.sig = targetSig(r);
  TGT.set(t, r);
  return r;
}
function targetSig(r) {
  return [r.kind, r.sequence, r.sizeTier, r.newAsset ? 1 : 0, r.bodyId, r.modules.map((m) => m.id + '*' + m.n).join(','), r.vehicles.map((v) => v.id + '*' + v.n).join(','), r.payload.kind, r.payload.moduleId, r.payload.vehicleTypeId, r.payload.qty, r.assetId || ''].join('|');
}

// ------------------------------------------------------------------ station layout (pure)

const AXIAL = new Set(['module', 'node', 'inflatable', 'tank', 'wheel']);
const MAX_PARTS = 40;

/**
 * Station geometry in station metres (x along the station axis, y up). Pure and deterministic.
 * The core sits at the origin on the x axis; nodes extend the axial chain toward −x and offer radial ports (±y);
 * labs/habs fill free radial ports in module order, else extend the chain; one solar truss crosses the core
 * (perpendicular) and gains a wing pair per st_solar; small modules (airlock, cupola) sit on surface spots;
 * a ring / O'Neill cylinder becomes the layout centre. The +x end is kept free: it is the approach side and its
 * docking adapter is the **target port** (first free port facing +x).
 * @returns {{parts, ports, port, bbox:{x0,y0,x1,y1}, truss, arm, hash, count}}
 */
export function layoutStation(modules, { seed = 1 } = {}) {
  const list = [];
  for (const m of Array.isArray(modules) ? modules : []) {
    if (!m || !m.id) continue;
    const art = m.art || moduleArt(m.id);
    const n = clamp(Math.round(num(m.n, 1)), 1, 24);
    for (let i = 0; i < n && list.length < MAX_PARTS; i++) list.push({ id: String(m.id), art });
  }
  const R = rng(((num(seed, 1) >>> 0) ^ 0x5bd1e995) >>> 0);
  const parts = [];
  const chain = [];
  const radial = [];   // free radial ports for big modules: {x, y, dir}
  const spots = [];    // surface spots for small modules: {x, y, dir}
  const below = { y: 0 };
  let xl = 0, xr = 0, maxD = 4;
  let truss = null, arm = null, centre = null, rosa = null;
  const shapeOf = (it) => String(it.art?.shape || 'module');
  const solarN = list.filter((it) => shapeOf(it) === 'truss').length;
  const axialN = list.filter((it) => AXIAL.has(shapeOf(it))).length;
  // one solar module on a small station = roll-out arrays on the aft module (Gateway's PPE), not an ISS truss
  const rosaMode = solarN === 1 && axialN >= 2;
  const hasTruss = solarN > 0 && !rosaMode;

  const addAxial = (it) => {
    const a = it.art, sh = shapeOf(it);
    const len = sh === 'wheel' ? 6 : num(a.len, 8), d = sh === 'wheel' ? 3.4 : num(a.d, 4);
    let x;
    // the chain grows toward +x from the core (the aft / Russian-style segment at −x); the +x end is the approach port
    if (!chain.length) { x = 0; xl = -len / 2; xr = len / 2; } else { x = xr + len / 2; xr += len; }
    const p = { id: it.id, shape: sh, art: a, x, y: 0, rot: 0, len, d, ext: sh === 'wheel' ? { w: num(a.r, 18) * 0.5, h: num(a.r, 18) * 2 } : null };
    parts.push(p); chain.push(p);
    maxD = Math.max(maxD, d);
    // with a solar truss over the stack the space above is the truss's: radial ports and small modules go below
    if (sh === 'node') { const s = hasTruss ? -1 : R() < 0.5 ? 1 : -1; radial.push({ x, y: s * d / 2, dir: s }); if (!hasTruss) radial.push({ x, y: -s * d / 2, dir: -s }); }
    else if (sh !== 'wheel') { if (!hasTruss) spots.push({ x: x + len * 0.18, y: d / 2, dir: 1 }); spots.push({ x: x - len * 0.18, y: -d / 2, dir: -1 }); }
    return p;
  };
  const addRadial = (it, slot) => {
    const a = it.art, len = num(a.len, 8), d = num(a.d, 4);
    const p = { id: it.id, shape: shapeOf(it), art: a, x: slot.x, y: slot.y + slot.dir * len / 2, rot: slot.dir > 0 ? -Math.PI / 2 : Math.PI / 2, len, d };
    parts.push(p);
    spots.push({ x: slot.x + d / 2, y: p.y, dir: 0 });
    return p;
  };
  const addSmall = (it, prefer) => {
    let i = spots.findIndex((s) => s.dir === prefer);
    if (i < 0) i = spots.findIndex((s) => s.dir !== 0);
    if (i < 0) return addAxial(it);
    const s = spots.splice(i, 1)[0];
    const a = it.art, sh = shapeOf(it);
    const len = sh === 'cupola' ? num(a.h, 1.5) : num(a.len, 5), d = num(a.d, 3);
    const p = { id: it.id, shape: sh, art: a, x: s.x, y: s.y + s.dir * len / 2, rot: s.dir > 0 ? -Math.PI / 2 : Math.PI / 2, len, d, small: true, dir: s.dir };
    parts.push(p);
    return p;
  };
  const place = (it) => {
    const sh = shapeOf(it);
    if (sh === 'node' || sh === 'wheel') return addAxial(it);
    if (sh === 'truss') { if (rosaMode) { rosa = { art: it.art, id: it.id }; return null; } if (!truss) truss = { n: 0, art: it.art, id: it.id }; truss.n++; return null; }
    if (sh === 'arm') { if (!arm) arm = { art: it.art, id: it.id }; return null; }
    if (sh === 'cupola') return addSmall(it, -1);
    if (sh === 'airlock') return addSmall(it, 1);
    if (sh === 'ring' || sh === 'cylinder') { if (!centre || (sh === 'cylinder' && centre.shape === 'ring')) centre = { shape: sh, art: it.art, id: it.id }; return null; }
    if (sh === 'shipyard') {
      const a = it.art, len = num(a.len, 110), h = num(a.h, 42);
      below.y -= h / 2 + 6;
      const p = { id: it.id, shape: sh, art: a, x: xl + len / 2 - 6, y: below.y - maxD / 2, rot: 0, len, d: h, frame: true };
      below.y -= h / 2;
      parts.push(p);
      return p;
    }
    if (radial.length && (sh === 'module' || sh === 'inflatable')) return addRadial(it, radial.shift());
    return addAxial(it);
  };
  // the chain starts with the first axial-capable module (core first if listed); others wait for it
  const firstAx = list.findIndex((it) => it.id === 'st_core') >= 0 ? list.findIndex((it) => it.id === 'st_core') : list.findIndex((it) => AXIAL.has(shapeOf(it)));
  if (firstAx >= 0) addAxial(list[firstAx]);
  list.forEach((it, i) => { if (i !== firstAx) place(it); });
  if (!chain.length) addAxial({ id: '_station', art: moduleArt('_station') });

  // solar truss (ISS-like): HORIZONTAL above the pressurised stack on two struts, from just past the core (whose
  // own small wings stay clear) to beyond the approach port; wing pairs at both truss ends (one wing up at full
  // length, its partner below feathered by the beta gimbal so it never crosses the stack or the approach
  // corridor), radiators on the truss between the stack and the arrays
  if (truss) {
    const a = truss.art;
    const wingW = num(a.wingW, 11.6), wingLen = num(a.wingLen, 34);
    const pairs = clamp(truss.n, 1, 8);
    const perEnd = Math.ceil(pairs / 2);
    const grp = perEnd * wingW * 1.12;
    const tw = num(a.trussW, 3.2);
    const core = chain[0];
    const coreWings = core && num(core.art?.arrays?.spanM, 0) > 0 && chain.length > 1;
    const ts = coreWings ? core.x + core.len / 2 + 1.5 : xl - grp * 0.5;
    const te = Math.max(xr + grp + 6, ts + Math.max(num(a.trussLen, 44), grp * 2 + 12));
    truss.horizontal = true;
    truss.y = maxD / 2 + 6.5; truss.x = (ts + te) / 2; truss.len = te - ts; truss.w = tw; truss.x0 = ts; truss.x1 = te;
    truss.struts = chain.filter((p) => p.x > ts + 1 && p.x < xr).slice(0, 2).map((p) => p.x);
    if (!truss.struts.length) truss.struts = [clamp((xl + xr) / 2, ts + 1, te - 1)];
    truss.wings = [];
    for (let i = 0; i < pairs; i++) {
      const end = i % 2 === 0 ? 1 : -1, j = Math.floor(i / 2);
      const x = end > 0 ? te - wingW * 0.6 - j * wingW * 1.12 : ts + wingW * 0.6 + j * wingW * 1.12;
      truss.wings.push({ x, y: truss.y, w: wingW, len: wingLen, up: 0.82, down: end > 0 ? 0.03 : 0.09 }); // the +x end's lower wings fold away from the approach corridor
    }
    const rl = num(a.radiator?.len, 13), rw = num(a.radiator?.w, 3);
    const rx0 = ts + grp + 2, rx1 = te - grp - 2;
    truss.radiators = a.radiator && rx1 - rx0 > rw * 2.5 ? (rx1 - rx0 > rw * 6 ? [{ x: lerp(rx0, rx1, 0.15), len: rl * 0.7, w: rw * 1.2 }, { x: lerp(rx0, rx1, 0.85), len: rl * 0.7, w: rw * 1.2 }] : [{ x: (rx0 + rx1) / 2, len: rl * 0.7, w: rw * 1.2 }]) : [];
  }
  // robotic arm: on the truss near the port (mobile base) when there is one, else on top of the biggest module
  if (arm) {
    arm.boom = num(arm.art.boomM, 8.6);
    if (truss) { arm.x = clamp(xr + 3, truss.x0 + 2, truss.x1 - 2); arm.y = truss.y + truss.w / 2; }
    else { const host = [...chain].filter((p) => p.shape === 'module').sort((p, q) => q.len - p.len)[0] || chain[0]; arm.x = host.x + host.len * 0.25; arm.y = host.d / 2 + 0.4; }
  }
  // roll-out arrays (ROSA) on the aft module of a small station
  if (rosa) { const aft = chain[0]; rosa.x = aft.x - aft.len * 0.3; rosa.len = 19; rosa.w = 4.6; rosa.y0 = aft.d / 2 + 0.6; }
  // big radial modules of a truss-less station carry their own wing pair at the outer end (Tiangong's labs)
  if (!truss) {
    const c0 = chain[0], cw = c0 && num(c0.art?.arrays?.spanM, 0) > 0 ? c0.x + c0.len * 0.3 : -Infinity; // keep clear of the core's own wings
    for (const p of parts) if (p.rot && !p.small && p.shape === 'module' && !p.art?.arrays) {
      const room = p.x - cw - 2;
      p.tipWings = { len: clamp(Math.min(p.len * 1.4, room), 4, 16), w: Math.min(4.5, p.d) };
    }
  }
  // ring / cylinder centre
  if (centre) {
    const a = centre.art;
    if (centre.shape === 'ring') {
      const r = num(a.r, 110), xc = (xl + xr) / 2;
      const rx = r * 0.24;
      parts.unshift({ id: centre.id, shape: 'ring', art: a, x: xc, y: 0, rot: 0, r, tube: num(a.tube, 16), spokes: num(a.spokes, 6), len: rx * 2, d: r * 2 });
      if (xr < xc + rx + 10) { const len = xc + rx + 12 - xr; parts.push({ id: '_spindle', shape: 'spindle', art: { mat: 'grey_paint' }, x: xr + len / 2, y: 0, rot: 0, len, d: 3 }); xr += len; }
    } else {
      const len = num(a.len, 1800), d = num(a.d, 420);
      parts.unshift({ id: centre.id, shape: 'cylinder', art: a, x: xl - len / 2, y: 0, rot: 0, len, d });
      xl -= len;
    }
  }
  // docking adapter at the +x end: the target port
  parts.push({ id: '_adapter', shape: 'adapter', art: { mat: 'bare_aluminium' }, x: xr + 0.6, y: 0, rot: 0, len: 1.2, d: 1.8 });
  const ports = [{ x: xr + 1.2, y: 0, dir: '+x', free: true }];
  if (!centre || centre.shape !== 'cylinder') ports.push({ x: xl, y: 0, dir: '-x', free: true });
  for (const s of radial) ports.push({ x: s.x, y: s.y, dir: s.dir > 0 ? '+y' : '-y', free: true });

  // bounding box (station metres, y up)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ext = (ax0, ay0, ax1, ay1) => { x0 = Math.min(x0, ax0); y0 = Math.min(y0, ay0); x1 = Math.max(x1, ax1); y1 = Math.max(y1, ay1); };
  for (const p of parts) {
    const vertical = Math.abs(Math.sin(p.rot || 0)) > 0.5;
    let hw = (vertical ? p.d : p.len) / 2, hh = (vertical ? p.len : p.d) / 2;
    if (p.ext) { hw = Math.max(hw, p.ext.w); hh = Math.max(hh, p.ext.h / 2); }
    const span = num(p.art?.arrays?.spanM, 0) / 2;
    if (span && !vertical) hh = Math.max(hh, span * 0.7);
    ext(p.x - hw, p.y - hh, p.x + hw, p.y + hh);
  }
  if (truss) {
    ext(truss.x0, truss.y - truss.w / 2, truss.x1, truss.y + truss.w / 2);
    for (const w of truss.wings) ext(w.x - w.w / 2, w.y - w.len * w.down - 1, w.x + w.w / 2, w.y + w.len * w.up + 1);
    for (const r of truss.radiators) ext(r.x - r.w, truss.y, r.x + r.w, truss.y + r.len + 1);
  }
  if (rosa) ext(rosa.x - rosa.w, -(rosa.y0 + rosa.len), rosa.x + rosa.w, rosa.y0 + rosa.len);
  for (const p of parts) if (p.tipWings) { const tipY = p.y + Math.sign(p.y) * p.len / 2; ext(p.x - p.tipWings.len - 1, tipY - p.tipWings.w, p.x + p.tipWings.len + 1, tipY + p.tipWings.w); }
  if (arm) ext(arm.x - arm.boom * 2, arm.y, arm.x + arm.boom * 2, arm.y + arm.boom * 1.2);
  const port = ports.find((p) => p.free && p.dir === '+x') || ports[0];
  return {
    parts, ports, port, truss, arm, rosa, count: list.length,
    bbox: { x0: x0 - 1, y0: y0 - 1, x1: x1 + 1, y1: y1 + 1 },
    hash: hash(list.map((it) => it.id).join(',') + '|' + num(seed, 1)),
  };
}

// ------------------------------------------------------------------ station painters

function solarWing(ctx, k, light, x0, y0, x1, y1, { color = '#1b2a56', mast = true, unfold = 1 } = {}) {
  const ux = Math.sign(x1 - x0) || 1;
  const len = Math.abs(x1 - x0) * clamp(unfold, 0, 1);
  if (len * k < 0.4) return;
  const X0 = Math.min(x0, x0 + ux * len) * k, W = len * k;
  const Y0 = -Math.max(y0, y1) * k, H = Math.abs(y1 - y0) * k;
  const L = L3(light);
  const sheen = clamp(0.35 + L[0] * ux * 0.35 - L[1] * 0.3, 0, 1);
  const c = rgbOf(color);
  const g = ctx.createLinearGradient(X0, Y0, X0 + W, Y0 + H);
  g.addColorStop(0, css(mixC(c, [196, 138, 74], sheen * 0.45)));
  g.addColorStop(0.5, css(scaleC(c, 0.85)));
  g.addColorStop(1, css(mixC(c, [120, 150, 220], sheen * 0.35)));
  ctx.fillStyle = g;
  ctx.fillRect(X0, Y0, W, H);
  const cell = Math.max(0.9, 2.2 * k);
  if (cell > 2.4) {
    ctx.strokeStyle = 'rgba(160,176,220,0.18)'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let x = X0 + cell; x < X0 + W - 0.5; x += cell) { ctx.moveTo(x, Y0); ctx.lineTo(x, Y0 + H); }
    ctx.stroke();
  }
  if (mast) { ctx.fillStyle = 'rgba(214,206,186,0.75)'; ctx.fillRect(X0, Y0 + H / 2 - Math.max(0.35, 0.18 * k), W, Math.max(0.7, 0.36 * k)); }
  ctx.strokeStyle = 'rgba(205,210,214,0.55)'; ctx.lineWidth = Math.max(0.5, 0.08 * k);
  ctx.strokeRect(X0, Y0, W, H);
}

function radiatorPanel(ctx, k, light, x0, y0, x1, y1) {
  const X0 = Math.min(x0, x1) * k, W = Math.abs(x1 - x0) * k, Y0 = -Math.max(y0, y1) * k, H = Math.abs(y1 - y0) * k;
  ctx.fillStyle = cylGrad(ctx, X0, Y0, X0, Y0 + H, 'white_paint', light, { amb: 0.55 });
  ctx.fillRect(X0, Y0, W, H);
  if (k > 1.2) { ctx.strokeStyle = 'rgba(80,86,96,0.25)'; ctx.lineWidth = 0.5; ctx.beginPath(); for (let x = X0 + 1.6 * k; x < X0 + W; x += 1.6 * k) { ctx.moveTo(x, Y0); ctx.lineTo(x, Y0 + H); } ctx.stroke(); }
}

/** A horizontal tube from x0 to x1 (metres) centred at y with diameter d (custom, cheap). */
function tube(ctx, k, light, x0, x1, y, d, mat, { caps = true, tint = null, ribs = 0 } = {}) {
  const X0 = Math.min(x0, x1) * k, X1 = Math.max(x0, x1) * k, Yc = -y * k, R = Math.max(0.4, (d / 2) * k);
  ctx.fillStyle = cylGrad(ctx, 0, Yc - R, 0, Yc + R, mat, light, { tint });
  ctx.fillRect(X0, Yc - R, X1 - X0, R * 2);
  if (ribs && k * ribs > 3) {
    ctx.strokeStyle = 'rgba(40,44,50,0.16)'; ctx.lineWidth = 0.6;
    ctx.beginPath(); for (let x = X0 + ribs * k; x < X1 - 0.5; x += ribs * k) { ctx.moveTo(x, Yc - R); ctx.lineTo(x, Yc + R); } ctx.stroke();
  }
  if (caps) {
    ctx.fillStyle = css(scaleC(rgbOf(matC(mat).base), 0.55), 0.5);
    ctx.beginPath(); ctx.ellipse(X1, Yc, Math.max(0.5, R * 0.18), R, 0, 0, TAU); ctx.fill();
  }
}

/** Module lying along x (front toward +x), centred at the ctx origin. Uses the craft painter for cylinders. */
function paintModulePart(ctx, p, k, light, opts = {}) {
  const a = p.art || {};
  const sh = p.shape || a.shape || 'module';
  const len = num(p.len, num(a.len, 8)), d = num(p.d, num(a.d, 4));
  const unfold = opts.unfold == null ? 1 : opts.unfold;
  switch (sh) {
    case 'module': case 'node': case 'spindle': {
      if (sh === 'spindle') { tube(ctx, k, light, -len / 2, len / 2, 0, d, a.mat || 'grey_paint', { ribs: 2 }); break; }
      const craft = MODCRAFT.get(p.art) || { name: a.name || 'Módulo', template: 'module', len, d, mat: a.mat || 'white_paint', heightM: len, widthM: d, window: !!a.windows, arrays: a.arrays && unfold > 0.98 ? a.arrays : { type: 'none' } };
      if (unfold > 0.98) MODCRAFT.set(p.art, craft);
      ctx.save(); ctx.rotate(Math.PI / 2);
      paintCraft(ctx, craft, { pxPerM: k, light, mode: 'flight' });
      ctx.restore();
      if (a.arrays && unfold <= 0.98 && unfold > 0.02) { // unfolding wings (release sequence)
        const span = num(a.arrays.spanM, 20) / 2;
        for (const s of [-1, 1]) solarWing(ctx, k, light, -len * 0.4 + len * 0.05, s * (d / 2 + 0.6), -len * 0.4 + len * 0.2, s * (d / 2 + 0.6 + (span - d / 2) * unfold), { mast: false });
      }
      if (sh === 'node' && k > 1.5) { // radial berthing rings
        ctx.fillStyle = css(rgbOf('#9aa0a8'));
        for (const s of [-1, 1]) ctx.fillRect(-d * 0.22 * k, s > 0 ? -(d / 2 + 0.25) * k : (d / 2) * k, d * 0.44 * k, 0.25 * k);
      }
      if (a.windows && k > 2.5) { // lit portholes
        ctx.fillStyle = 'rgba(255,214,150,0.75)';
        const n = clamp(num(a.windows, 1), 1, 6);
        for (let i = 0; i < n; i++) { const x = (-len * 0.3 + (len * 0.6 * (i + 0.5)) / n) * k; ctx.beginPath(); ctx.arc(x, -d * 0.12 * k, Math.max(0.5, 0.16 * k), 0, TAU); ctx.fill(); }
      }
      break;
    }
    case 'inflatable': {
      const R = d / 2;
      ctx.fillStyle = cylGrad(ctx, 0, -R * k, 0, R * k, a.mat || 'beta_cloth', light, { amb: 0.4 });
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-len / 2 * k, -R * k, len * k, d * k, R * k * 0.9) : ctx.rect(-len / 2 * k, -R * k, len * k, d * k); ctx.fill();
      ctx.strokeStyle = 'rgba(120,112,96,0.28)'; ctx.lineWidth = Math.max(0.5, 0.08 * k);
      ctx.beginPath(); for (let i = 1; i < 6; i++) { const x = (-len / 2 + (len * i) / 6) * k; ctx.moveTo(x, -R * k * 0.96); ctx.lineTo(x, R * k * 0.96); } ctx.stroke();
      tube(ctx, k, light, len / 2 - 0.2, len / 2 + 0.6, 0, d * 0.32, 'bare_aluminium');
      break;
    }
    case 'tank': {
      const R = d / 2;
      ctx.fillStyle = cylGrad(ctx, 0, -R * k, 0, R * k, a.mat || 'silver_foil', light);
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-len / 2 * k, -R * k, len * k, d * k, R * k) : ctx.rect(-len / 2 * k, -R * k, len * k, d * k); ctx.fill();
      ctx.strokeStyle = 'rgba(60,64,70,0.25)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); for (const f of [-0.25, 0, 0.25]) { ctx.moveTo(f * len * k, -R * k); ctx.lineTo(f * len * k, R * k); } ctx.stroke();
      const rad = a.radiators;
      if (rad) for (const s of [-1, 1]) radiatorPanel(ctx, k, light, -rad.len / 2, s * (R + 0.4), rad.len / 2, s * (R + 0.4 + num(rad.w, 3) * unfold));
      break;
    }
    case 'airlock': {
      tube(ctx, k, light, -len / 2, len * 0.2, 0, d, a.mat || 'white_paint', { ribs: 1.2 });
      const sR = num(a.sphereD, 2.4) / 2;
      ctx.fillStyle = cylGrad(ctx, len * 0.2 * k, -sR * k, (len * 0.2 + sR * 2) * k, sR * k, a.mat || 'white_paint', light);
      ctx.beginPath(); ctx.arc((len * 0.2 + sR) * k, 0, sR * k, 0, TAU); ctx.fill();
      break;
    }
    case 'cupola': {
      const R = d / 2, h = len;
      ctx.fillStyle = cylGrad(ctx, -h / 2 * k, -R * k, -h / 2 * k, R * k, 'bare_aluminium', light);
      ctx.beginPath(); ctx.moveTo(-h / 2 * k, -R * k); ctx.lineTo(h / 2 * k, -R * 0.55 * k); ctx.lineTo(h / 2 * k, R * 0.55 * k); ctx.lineTo(-h / 2 * k, R * k); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(40,70,110,0.9)';
      ctx.fillRect((h / 2 - 0.12) * k, -R * 0.45 * k, Math.max(0.6, 0.12 * k), R * 0.9 * k);
      if (k > 2) { ctx.fillStyle = 'rgba(255,220,170,0.55)'; ctx.fillRect((h / 2 - 0.1) * k, -R * 0.2 * k, Math.max(0.5, 0.08 * k), R * 0.4 * k); }
      break;
    }
    case 'adapter': {
      ctx.fillStyle = cylGrad(ctx, 0, -d / 2 * k, 0, d / 2 * k, 'bare_aluminium', light);
      ctx.beginPath(); ctx.moveTo(-len / 2 * k, -d / 2 * k); ctx.lineTo(len / 2 * k, -d * 0.36 * k); ctx.lineTo(len / 2 * k, d * 0.36 * k); ctx.lineTo(-len / 2 * k, d / 2 * k); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#2a2c30'; ctx.fillRect((len / 2 - 0.08) * k, -d * 0.3 * k, Math.max(0.5, 0.1 * k), d * 0.6 * k);
      break;
    }
    case 'wheel': case 'ring': {
      const r = sh === 'ring' ? num(p.r, 110) : num(a.r, 18), tb = sh === 'ring' ? num(p.tube, 16) : num(a.tube, 3.4);
      const rx = r * 0.24, spokes = sh === 'ring' ? num(p.spokes, 6) : num(a.spokes, 4);
      tube(ctx, k, light, -3, 3, 0, Math.max(3, tb * 0.5), 'grey_paint', { ribs: 1 });
      ringHalf(ctx, k, light, rx, r, tb, spokes, a.mat || 'white_paint', false, opts);
      ringHalf(ctx, k, light, rx, r, tb, spokes, a.mat || 'white_paint', true, opts);
      break;
    }
    case 'cylinder': paintCylinder(ctx, k, light, len, d, a, opts); break;
    case 'shipyard': paintShipyard(ctx, k, light, len, d, a, opts); break;
    default: tube(ctx, k, light, -len / 2, len / 2, 0, d, a.mat || 'white_paint', { ribs: 1.1 });
  }
}
const MODCRAFT = new WeakMap();

/** One half (back = −x side, front = +x side) of a ring / wheel around the station axis, seen almost edge-on. */
function ringHalf(ctx, k, light, rx, r, tb, spokes, mat, front, opts = {}) {
  const m = matC(mat);
  const base = rgbOf(m.base), dark = rgbOf(m.dark || '#444'), hi = rgbOf(m.light || '#fff');
  const L = L3(light);
  const R0 = Math.max(0.5, r - tb / 2), R1 = r + tb / 2;
  ctx.save();
  ctx.beginPath();
  const big = (R1 + rx + tb + 4) * k * 1.2;
  if (front) ctx.rect(0, -big, big, big * 2); else ctx.rect(-big, -big, big, big * 2);
  ctx.clip();
  // spokes (behind the rim on this half)
  ctx.strokeStyle = css(scaleC(base, front ? 0.8 : 0.5));
  ctx.lineWidth = Math.max(0.6, tb * 0.2 * k);
  ctx.beginPath();
  for (let i = 0; i < spokes; i++) {
    const an = (i / spokes) * TAU + 0.35;
    if ((Math.cos(an) >= 0) !== front) continue;
    ctx.moveTo(0, 0); ctx.lineTo(Math.cos(an) * rx * k, -Math.sin(an) * R0 * k);
  }
  ctx.stroke();
  // tube: elliptical annulus (outer rx + tb/2, inner rx − tb/2) so the cross-section keeps its width all round
  const ox = (rx + tb / 2) * k, oy = R1 * k, ix = Math.max(0.3, (rx - tb / 2)) * k, iy = R0 * k;
  const f = front ? 1 : 0.62;
  const ring = () => { ctx.beginPath(); ctx.ellipse(0, 0, ox, oy, 0, 0, TAU); ctx.ellipse(0, 0, ix, iy, 0, 0, TAU, true); };
  ring();
  const lg = ctx.createLinearGradient(0, -oy, 0, oy);
  const top = mixC(base, hi, clamp(0.35 * -L[1], 0, 0.5));
  lg.addColorStop(0, css(scaleC(top, f))); lg.addColorStop(0.5, css(scaleC(base, 0.86 * f))); lg.addColorStop(1, css(scaleC(mixC(dark, base, 0.55), f)));
  ctx.fillStyle = lg; ctx.fill();
  // rounded tube: dark inner edge, lit outer crown
  ctx.lineWidth = Math.max(0.6, tb * 0.18 * k);
  ctx.strokeStyle = css(scaleC(dark, 0.9 * f), 0.6);
  ctx.beginPath(); ctx.ellipse(0, 0, ix + ctx.lineWidth / 2, iy + ctx.lineWidth / 2, 0, 0, TAU); ctx.stroke();
  ctx.strokeStyle = css(scaleC(hi, f), 0.35);
  ctx.lineWidth = Math.max(0.5, tb * 0.1 * k);
  ctx.beginPath(); ctx.ellipse(0, 0, ox - ctx.lineWidth, oy - ctx.lineWidth, 0, 0, TAU); ctx.stroke();
  if (tb * k > 4) { // segment seams
    ctx.strokeStyle = 'rgba(30,32,36,0.22)'; ctx.lineWidth = Math.max(0.5, 0.1 * k);
    ctx.beginPath();
    for (let i = 0; i < 24; i++) { const an = (i / 24) * TAU, c = Math.cos(an), sn = Math.sin(an); ctx.moveTo(c * ix, sn * iy); ctx.lineTo(c * ox, sn * oy); }
    ctx.stroke();
  }
  // window band (lit) on the visible face
  if (front && opts.lights !== false && k * tb > 3) {
    ctx.fillStyle = 'rgba(255,214,160,0.6)';
    for (let i = 0; i < 72; i++) {
      const an = (i / 72) * TAU;
      if (Math.cos(an) <= 0.05 || (hash('rw' + i) & 3) === 0) continue;
      ctx.fillRect(Math.cos(an) * (rx + tb * 0.25) * k - 0.5, -Math.sin(an) * r * k - 0.5, Math.max(1, 0.5 * k), Math.max(1, 0.5 * k));
    }
  }
  ctx.restore();
}

function paintCylinder(ctx, k, light, len, d, a, opts = {}) {
  const R = d / 2;
  const X0 = -len / 2 * k, W = len * k, Y0 = -R * k, H = d * k;
  ctx.fillStyle = cylGrad(ctx, 0, Y0, 0, Y0 + H, a.mat || 'grey_paint', light, { amb: 0.22 });
  ctx.fillRect(X0, Y0, W, H);
  // alternating land / window strips running along the axis (seen as horizontal bands)
  const bands = [[-0.62, -0.38], [0.05, 0.28]];
  for (const [b0, b1] of bands) {
    const g = ctx.createLinearGradient(0, -b1 * R * k, 0, -b0 * R * k);
    g.addColorStop(0, 'rgba(30,58,96,0.85)'); g.addColorStop(0.5, 'rgba(80,120,170,0.8)'); g.addColorStop(1, 'rgba(24,44,78,0.9)');
    ctx.fillStyle = g; ctx.fillRect(X0, -b1 * R * k, W, (b1 - b0) * R * k);
    if (opts.lights !== false) {
      ctx.fillStyle = 'rgba(255,220,170,0.4)';
      for (let i = 0; i < 90; i++) { const h = hash('cyl' + i); const x = X0 + ((h & 1023) / 1023) * W, y = -lerp(b0, b1, ((h >>> 10) & 255) / 255) * R * k; ctx.fillRect(x, y, Math.max(1, 0.8 * k), Math.max(1, 0.8 * k)); }
    }
  }
  // structural rings
  ctx.strokeStyle = 'rgba(40,42,46,0.25)'; ctx.lineWidth = Math.max(0.6, 1.2 * k);
  ctx.beginPath(); for (let i = 1; i < 12; i++) { const x = X0 + (W * i) / 12; ctx.moveTo(x, Y0); ctx.lineTo(x, Y0 + H); } ctx.stroke();
  // angled mirrors above and below
  ctx.fillStyle = 'rgba(190,206,224,0.45)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(X0 + W * 0.08, s * R * k); ctx.lineTo(X0 + W * 0.9, s * R * k); ctx.lineTo(X0 + W * 0.84, s * R * 1.55 * k); ctx.lineTo(X0 + W * 0.14, s * R * 1.42 * k); ctx.closePath(); ctx.fill();
  }
  // end cap (+x)
  ctx.fillStyle = cylGrad(ctx, X0 + W, Y0, X0 + W, Y0 + H, 'grey_paint', light, { amb: 0.35 });
  ctx.beginPath(); ctx.ellipse(X0 + W, 0, R * 0.16 * k, R * k, 0, 0, TAU); ctx.fill();
}

function paintShipyard(ctx, k, light, len, h, a, opts = {}) {
  const X0 = -len / 2 * k, W = len * k, Y0 = -h / 2 * k, H = h * k;
  // ship under construction inside the bay
  tube(ctx, k, light, -len * 0.36, len * 0.3, 0, h * 0.42, 'grey_paint', { ribs: 3 });
  ctx.fillStyle = 'rgba(20,22,26,0.55)';
  ctx.fillRect(-len * 0.05 * k, -h * 0.21 * k, len * 0.18 * k, h * 0.42 * k); // open hull section
  // lattice frame
  ctx.strokeStyle = css(rgbOf(matC(a.mat || 'bare_aluminium').base), 0.85);
  ctx.lineWidth = Math.max(0.6, Math.min(4, 0.3 * k));
  ctx.strokeRect(X0, Y0, W, H);
  ctx.strokeStyle = css(rgbOf(matC(a.mat || 'bare_aluminium').base), 0.55);
  ctx.lineWidth = Math.max(0.4, Math.min(2, 0.12 * k));
  ctx.beginPath();
  const bay = Math.max(4, h / 3);
  for (let x = 0, i = 0; x < len; x += bay, i++) {
    const xa = X0 + x * k, xb = X0 + Math.min(len, x + bay) * k;
    ctx.moveTo(xa, Y0); ctx.lineTo(xa, Y0 + H);
    ctx.moveTo(xa, i % 2 ? Y0 : Y0 + H); ctx.lineTo(xb, i % 2 ? Y0 + H : Y0);
  }
  ctx.stroke();
  if (opts.lights !== false) {
    ctx.fillStyle = 'rgba(255,226,150,0.9)';
    for (let i = 0; i < 10; i++) { const x = X0 + (W * (i + 0.5)) / 10; ctx.fillRect(x - 0.6, Y0 - 0.6, Math.max(1.2, 0.5 * k), Math.max(1.2, 0.5 * k)); ctx.fillRect(x - 0.6, Y0 + H - 0.6, Math.max(1.2, 0.5 * k), Math.max(1.2, 0.5 * k)); }
  }
}

/**
 * One solar wing hanging off a horizontal truss at (x, y) (station metres, y up), dir +1 up / −1 down, projected
 * length len·cosβ (beta-gimbal tilt seen in perspective: the far end a little narrower and offset). Two blankets
 * of cells either side of the mast, frame, blanket gaps, glint.
 */
function trussWing(ctx, k, light, x, y, w, len, proj, dir) {
  const pl = len * proj;
  if (pl * k < 0.6) return;
  const tilt = 1 - proj; // the more foreshortened, the narrower the far end
  const near = w * k, far = w * k * (1 - 0.12 * tilt) * (proj > 0.5 ? 0.94 : 1);
  const X = x * k, Y0 = -(y + dir * 0.9) * k, Y1 = -(y + dir * (0.9 + pl)) * k;
  const skew = dir * w * 0.06 * k * proj;
  ctx.save();
  // mast
  ctx.strokeStyle = 'rgba(200,192,170,0.9)'; ctx.lineWidth = Math.max(0.5, 0.16 * k);
  ctx.beginPath(); ctx.moveTo(X, Y0); ctx.lineTo(X + skew, Y1); ctx.stroke();
  // two blankets (left / right of the mast) as perspective quads, each filled with a cell panel
  for (const side of [-1, 1]) {
    const a0 = X + side * 0.25 * k, a1 = X + side * near / 2, b0 = X + skew + side * 0.25 * k, b1 = X + skew + side * far / 2;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(a0, Y0); ctx.lineTo(a1, Y0); ctx.lineTo(b1, Y1); ctx.lineTo(b0, Y1); ctx.closePath(); ctx.clip();
    const bx = Math.min(a0, a1, b0, b1), bw = Math.max(a0, a1, b0, b1) - bx;
    cellPanel(ctx, bx, Math.min(Y0, Y1), bw, Math.abs(Y1 - Y0), light, { color: '#1c2a58', cellPx: Math.max(1.2, Math.min(w * k / 16, pl * k / 22)), glint: side * dir > 0 ? 0.9 : 0.45, gaps: 0 });
    // blanket gaps across the length (folded panel hinges)
    if (pl * k > 30) { ctx.fillStyle = 'rgba(210,198,160,0.5)'; for (let i = 1; i < 4; i++) { const yy = lerp(Y0, Y1, i / 4); ctx.fillRect(bx, yy - 0.4, bw, 0.8); } }
    ctx.restore();
    ctx.strokeStyle = 'rgba(205,210,214,0.65)'; ctx.lineWidth = Math.max(0.5, 0.06 * k);
    ctx.beginPath(); ctx.moveTo(a0, Y0); ctx.lineTo(a1, Y0); ctx.lineTo(b1, Y1); ctx.lineTo(b0, Y1); ctx.closePath(); ctx.stroke();
  }
  // tip box (stowed blanket container)
  ctx.fillStyle = '#c9c2ae'; ctx.fillRect(X + skew - far / 2, Y1 - dir * Math.max(0.6, 0.35 * k), far, Math.max(1, 0.5 * k) * dir);
  ctx.restore();
}

/** Horizontal ISS-like truss (see layoutStation): radiators and wings behind, the lattice girder, rotary joints. */
function paintTrussH(ctx, k, light, truss) {
  const Y = -truss.y * k, hw = (truss.w / 2) * k, X0 = truss.x0 * k, X1 = truss.x1 * k;
  // radiators (upward, ribbed white panels in a stack, slightly tilted)
  for (const r of truss.radiators || []) {
    const n = 4, segL = r.len / n;
    for (let i = 0; i < n; i++) {
      const y0 = truss.y + truss.w / 2 + 0.4 + i * segL, y1 = y0 + segL * 0.94;
      const sk = (i + 0.5) * 0.25;
      ctx.save(); ctx.translate((r.x + sk) * k, 0);
      radiatorPanel(ctx, k, light, -r.w / 2, y0, r.w / 2, y1);
      ctx.restore();
    }
    ctx.fillStyle = '#8d9299'; ctx.fillRect((r.x - 0.15) * k, -(truss.y + truss.w / 2 + r.len) * k, Math.max(0.6, 0.3 * k), r.len * k);
  }
  for (const wg of truss.wings || []) { trussWing(ctx, k, light, wg.x, wg.y + truss.w / 2, wg.w, wg.len, wg.up, 1); trussWing(ctx, k, light, wg.x, wg.y - truss.w / 2, wg.w, wg.len, wg.down, -1); }
  // girder: shaded box beam with bays and diagonals
  ctx.fillStyle = cylGrad(ctx, 0, Y - hw, 0, Y + hw, 'bare_aluminium', light, { amb: 0.42 });
  ctx.fillRect(X0, Y - hw, X1 - X0, hw * 2);
  if (k > 0.8) {
    ctx.strokeStyle = 'rgba(30,34,40,0.4)'; ctx.lineWidth = Math.max(0.4, 0.1 * k);
    ctx.beginPath();
    const bay = truss.w * 1.1 * k;
    for (let x = X0, i = 0; x < X1 - 0.5; x += bay, i++) { const xb = Math.min(X1, x + bay); ctx.moveTo(x, Y - hw); ctx.lineTo(x, Y + hw); ctx.moveTo(x, i % 2 ? Y - hw : Y + hw); ctx.lineTo(xb, i % 2 ? Y + hw : Y - hw); }
    ctx.stroke();
  }
  for (const wg of truss.wings || []) { ctx.fillStyle = '#7f858d'; ctx.fillRect((wg.x - 0.9) * k, Y - hw * 1.35, 1.8 * k, hw * 2.7); } // beta gimbals / rotary joints
}

/** Struts from the stack to the horizontal truss (drawn before the modules). */
function paintTrussStruts(ctx, k, light, truss, topY) {
  for (const sx of truss.struts || []) {
    ctx.fillStyle = cylGrad(ctx, (sx - 0.7) * k, 0, (sx + 0.7) * k, 0, 'bare_aluminium', light, { amb: 0.4 });
    ctx.fillRect((sx - 0.6) * k, -truss.y * k, 1.2 * k, (truss.y - topY) * k);
  }
}

function paintTruss(ctx, k, light, truss) {
  if (truss.horizontal) { paintTrussH(ctx, k, light, truss); return; }
  const x = truss.x, L = truss.len, w = truss.w;
  const X = x * k, Y0 = -L / 2 * k, H = L * k, hw = (w / 2) * k;
  // radiators first (behind the truss)
  for (const r of truss.radiators || []) radiatorPanel(ctx, k, light, x + w / 2, r.y - r.w / 2, x + w / 2 + r.len, r.y + r.w / 2);
  ctx.fillStyle = cylGrad(ctx, X - hw, 0, X + hw, 0, 'bare_aluminium', light, { amb: 0.4 });
  ctx.fillRect(X - hw, Y0, hw * 2, H);
  if (k > 0.9) {
    ctx.strokeStyle = 'rgba(30,34,40,0.35)'; ctx.lineWidth = Math.max(0.4, 0.12 * k);
    ctx.beginPath();
    const bay = w * 1.1;
    for (let y = 0, i = 0; y < L; y += bay, i++) {
      const ya = Y0 + y * k, yb = Y0 + Math.min(L, y + bay) * k;
      ctx.moveTo(X - hw, ya); ctx.lineTo(X + hw, ya);
      ctx.moveTo(i % 2 ? X - hw : X + hw, ya); ctx.lineTo(i % 2 ? X + hw : X - hw, yb);
    }
    ctx.stroke();
  }
  for (const wg of truss.wings || []) {
    for (const s of [-1, 1]) solarWing(ctx, k, light, x + s * (w / 2 + 0.6), wg.y - wg.w / 2, x + s * (w / 2 + 0.6 + wg.len), wg.y + wg.w / 2);
    ctx.fillStyle = css(rgbOf('#8d9299')); ctx.fillRect(X - hw * 1.3, -(wg.y + 0.8) * k, hw * 2.6, 1.6 * k); // rotary joint
  }
}

/** 2-link arm from its base on the station to a target point (station metres), deterministic IK. */
export function armJoints(arm, tx, ty) {
  const L1 = arm.boom, L2 = arm.boom;
  const dx = tx - arm.x, dy = ty - arm.y;
  const dist = clamp(Math.hypot(dx, dy), 0.5, L1 + L2 - 0.01);
  const base = Math.atan2(dy, dx);
  const cosA = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const a1 = base + Math.acos(cosA); // elbow up
  const ex = arm.x + Math.cos(a1) * L1, ey = arm.y + Math.sin(a1) * L1;
  const ang2 = Math.atan2(ty - ey, tx - ex);
  return { ex, ey, wx: ex + Math.cos(ang2) * L2, wy: ey + Math.sin(ang2) * L2 };
}

/** Draw the robotic arm (station metres → ctx at the station origin, scale k). target null = stowed. */
export function drawArm(ctx, layout, k, light, target = null) {
  const arm = layout?.arm;
  if (!arm) return;
  const tgt = target || { x: arm.x - arm.boom * 1.3, y: arm.y + arm.boom * 0.6 };
  const j = armJoints(arm, tgt.x, tgt.y);
  const w = Math.max(0.8, 0.38 * k);
  ctx.save();
  ctx.lineCap = 'round';
  const seg = (x0, y0, x1, y1) => {
    ctx.strokeStyle = cylGrad(ctx, x0 * k, -y0 * k - w, x0 * k, -y0 * k + w, 'white_paint', light, { amb: 0.5 });
    ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0 * k, -y0 * k); ctx.lineTo(x1 * k, -y1 * k); ctx.stroke();
  };
  seg(arm.x, arm.y, j.ex, j.ey); seg(j.ex, j.ey, j.wx, j.wy);
  ctx.fillStyle = '#7d828a';
  for (const [x, y] of [[arm.x, arm.y], [j.ex, j.ey], [j.wx, j.wy]]) { ctx.beginPath(); ctx.arc(x * k, -y * k, Math.max(0.9, 0.42 * k), 0, TAU); ctx.fill(); }
  ctx.restore();
}

/** All static station geometry at the ctx origin (station metres, y up), scale k. */
function paintStationRaw(ctx, layout, k, light, opts = {}) {
  const parts = layout.parts || [];
  const centreParts = parts.filter((p) => p.shape === 'ring' || p.shape === 'cylinder' || p.shape === 'wheel');
  // ring back halves
  for (const p of centreParts) if (p.shape !== 'cylinder') { ctx.save(); ctx.translate(p.x * k, -p.y * k); ringHalf(ctx, k, light, (p.shape === 'ring' ? p.r : num(p.art.r, 18)) * 0.24, p.shape === 'ring' ? p.r : num(p.art.r, 18), p.shape === 'ring' ? p.tube : num(p.art.tube, 3.4), p.shape === 'ring' ? p.spokes : num(p.art.spokes, 4), p.art.mat || 'white_paint', false, opts); ctx.restore(); }
  for (const p of centreParts) if (p.shape === 'cylinder') { ctx.save(); ctx.translate(p.x * k, -p.y * k); paintModulePart(ctx, p, k, light, opts); ctx.restore(); }
  if (layout.truss) paintTruss(ctx, k, light, layout.truss);
  if (layout.truss?.horizontal) paintTrussStruts(ctx, k, light, layout.truss, 1.5);
  if (layout.rosa) { // roll-out arrays: long narrow blankets up and down from the aft module, on booms
    const r = layout.rosa;
    for (const dir of [1, -1]) {
      ctx.fillStyle = '#8d9299'; ctx.fillRect((r.x - 0.15) * k, dir > 0 ? -(r.y0 + 1) * k : r.y0 * k, Math.max(0.6, 0.3 * k), k);
      trussWing(ctx, k, light, r.x, dir * (r.y0 + 0.2), r.w, r.len, 0.9, dir);
    }
  }
  // tip wings of radial modules (behind the modules)
  for (const p of parts) if (p.tipWings) {
    const dir = Math.sign(p.y) || 1, tipY = p.y + dir * (p.len / 2 - 0.8);
    ctx.fillStyle = '#8d9299'; ctx.fillRect((p.x - p.tipWings.len - 0.4) * k, -(tipY + 0.15) * k, (p.tipWings.len * 2 + 0.8) * k, Math.max(0.6, 0.3 * k));
    for (const sx of [-1, 1]) {
      ctx.save(); ctx.translate(p.x * k, -tipY * k); ctx.rotate(sx * Math.PI / 2);
      trussWing(ctx, k, light, 0, 1.2, p.tipWings.w, p.tipWings.len, 0.92, 1);
      ctx.restore();
    }
  }
  const order = parts.filter((p) => !centreParts.includes(p)).sort((a, b) => (a.small ? 1 : 0) - (b.small ? 1 : 0) || (a.frame ? -1 : 0) - (b.frame ? -1 : 0));
  for (const p of order) {
    ctx.save();
    ctx.translate(p.x * k, -p.y * k);
    if (p.rot) ctx.rotate(p.rot);
    paintModulePart(ctx, p, k, light, opts);
    ctx.restore();
  }
  // ring/wheel front halves
  for (const p of centreParts) if (p.shape !== 'cylinder') { ctx.save(); ctx.translate(p.x * k, -p.y * k); ringHalf(ctx, k, light, (p.shape === 'ring' ? p.r : num(p.art.r, 18)) * 0.24, p.shape === 'ring' ? p.r : num(p.art.r, 18), p.shape === 'ring' ? p.tube : num(p.art.tube, 3.4), p.shape === 'ring' ? p.spokes : num(p.art.spokes, 4), p.art.mat || 'white_paint', true, opts); ctx.restore(); }
  if (opts.arm !== false && layout.arm && opts.armTarget === undefined) drawArm(ctx, layout, k, light, null);
}

// Above this the station is painted directly (≈ 0.5–0.9 ms desktop, measured): building a sprite that big costs a
// 10–100 ms hitch, and the docked zoom-out would pay it again at every ⅓ octave.
const SPRITE_MAX_PX = 0.5e6;
/**
 * Station at the ctx origin (station metres, y up). Cached sprite per (layout hash, size bucket, light bucket);
 * stations too large for a sprite at this zoom are painted directly. While zooming out, a sprite up to one octave
 * larger already in the cache is reused (downsampled). Animated bits (strobes, docking target light) are drawn
 * every frame on top; the arm is drawn by the caller when it moves (opts.armTarget).
 */
export function paintStation(ctx, layout, { pxPerM = 2, light = SUN, t = 0, lightsOn = true, reduce = false, armTarget } = {}) {
  if (!ctx || !layout) return;
  const k = Math.max(0.02, num(pxPerM, 2));
  const b = layout.bbox;
  const dpr = devScale(ctx);
  const q = Math.round(Math.log2(k * dpr) * 3) / 3;
  const lb = lightBucket(light);
  const dims = (kb) => [Math.ceil((b.x1 - b.x0) * kb) + 8, Math.ceil((b.y1 - b.y0) * kb) + 8];
  const keyOf = (kb) => `station|${layout.hash}|${kb.toFixed(3)}|${lb}|${lightsOn ? 1 : 0}|${armTarget === undefined ? 'a' : 'n'}`;
  const blitSpr = (spr, kb) => { const [W, H] = dims(kb); const s = k / kb; ctx.drawImage(spr, (b.x0 * kb - 4) * s, (-b.y1 * kb - 4) * s, W * s, H * s); };
  let drawn = false;
  for (let j = 1; j <= 3 && !drawn; j++) {
    const kj = Math.pow(2, q + j / 3);
    const spr = peekCached(keyOf(kj));
    if (spr) { blitSpr(spr, kj); drawn = true; }
  }
  const kb = Math.pow(2, q);
  const [W, H] = dims(kb);
  if (!drawn && W * H <= SPRITE_MAX_PX && W < 4096 && H < 4096) {
    const spr = cached(keyOf(kb), W, H, (g) => {
      g.translate(4 - b.x0 * kb, 4 + b.y1 * kb);
      paintStationRaw(g, layout, kb, light, { lights: lightsOn, armTarget });
    });
    if (spr) { blitSpr(spr, kb); drawn = true; }
  }
  if (!drawn) paintStationRaw(ctx, layout, k, light, { lights: lightsOn, armTarget });
  // strobes: nav lights at the extremes, docking target light at the port (opacity only)
  const blink = reduce ? 1 : (Math.sin(num(t) * 4.2) > 0.55 ? 1 : 0.15);
  const r = Math.max(1, 0.35 * k);
  const dot = (x, y, c, a) => { ctx.fillStyle = c.replace('A', String(a)); ctx.beginPath(); ctx.arc(x * k, -y * k, r, 0, TAU); ctx.fill(); };
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  dot(b.x0 + 1, 0, 'rgba(255,70,60,A)', 0.8 * blink);
  dot(b.x1 - 1, b.y1 - 1, 'rgba(90,255,120,A)', 0.8 * blink);
  const p = layout.port;
  if (p && lightsOn) {
    const g = ctx.createRadialGradient(p.x * k, -p.y * k, 0, p.x * k, -p.y * k, r * 4);
    g.addColorStop(0, `rgba(255,255,240,${(0.9 * (reduce ? 1 : 0.6 + 0.4 * Math.sin(num(t) * 2.1))).toFixed(3)})`); g.addColorStop(1, 'rgba(255,255,240,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x * k, -p.y * k, r * 4, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

/** A single module (or the delivered module "craft") lying along x, front toward +x, centred at the ctx origin. */
export function paintModule(ctx, art, { pxPerM = 4, light = SUN, unfold = 1, lights = true } = {}) {
  if (!ctx) return { lenM: num(art?.len, 8), dM: num(art?.d, 4) };
  const a = art || moduleArt('_station');
  const sh = a.shape || 'module';
  const p = { art: a, shape: sh, len: sh === 'cupola' ? num(a.h, 1.5) : sh === 'ring' ? num(a.r, 110) * 0.48 : num(a.len, 8), d: sh === 'ring' ? num(a.r, 110) * 2 : num(a.d, 4), r: num(a.r, 110), tube: num(a.tube, 16), spokes: num(a.spokes, 6) };
  if (sh === 'truss') {
    const tr = { x: 0, len: num(a.trussLen, 44), w: num(a.trussW, 3.2), wings: [{ y: num(a.trussLen, 44) * 0.36, w: num(a.wingW, 11.6), len: num(a.wingLen, 34) * clamp(unfold, 0.05, 1) }, { y: -num(a.trussLen, 44) * 0.36, w: num(a.wingW, 11.6), len: num(a.wingLen, 34) * clamp(unfold, 0.05, 1) }], radiators: [] };
    ctx.save(); ctx.rotate(Math.PI / 2); paintTruss(ctx, num(pxPerM, 4), light, tr); ctx.restore();
    return { lenM: 4, dM: tr.len };
  }
  if (sh === 'arm') { drawArm(ctx, { arm: { x: -num(a.boomM, 8.6), y: 0, boom: num(a.boomM, 8.6) } }, num(pxPerM, 4), light, { x: num(a.boomM, 8.6) * 0.6, y: 0.5 }); return { lenM: num(a.boomM, 8.6) * 2, dM: 1 }; }
  paintModulePart(ctx, p, Math.max(0.02, num(pxPerM, 4)), light, { unfold, lights });
  return { lenM: p.len, dM: p.d };
}
/** Length along x and height of a module drawn by paintModule (metres). */
export function moduleSize(art) {
  const a = art || {};
  const sh = a.shape || 'module';
  if (sh === 'truss') return { lenM: 4, dM: num(a.trussLen, 44) };
  if (sh === 'ring' || sh === 'wheel') return { lenM: num(a.r, 18) * 0.48, dM: num(a.r, 18) * 2 };
  if (sh === 'cupola') return { lenM: num(a.h, 1.5), dM: num(a.d, 3) };
  if (sh === 'arm') return { lenM: num(a.boomM, 8.6) * 2, dM: 1 };
  return { lenM: num(a.len, 8), dM: Math.max(num(a.d, 4), num(a.arrays?.spanM, 0) * 0.5) };
}

// ------------------------------------------------------------------ docking / release choreography (pure)

/**
 * Pose of the visiting craft relative to the target port (MISSIONS-V2 §7.3): approach along the V-bar from +x
 * (range 200 m → 30 m), hold at 10 m, final approach, contact, latch. Driven by the scene clock (pinned by the
 * sim at unresolved milestones) so resume/replay give the same picture; event times (rs.t units) only add the
 * short contact/failure beats.
 * @param o {clock, t, tl: {start, rv, dock}, seq: 'dock'|'berth', flags: {docked, dockFail, rvFail, rvAnomaly}, events: {dock, berth, dockFail, rvFail}}
 * @returns {{range, off, rot, phase, flash, arm, armHold, lights, rcs}}  metres / radians; arm 0..1 reach, armHold = arm holds the craft
 */
export function dockPose(o = {}) {
  const clock = num(o.clock), t = num(o.t);
  const tl = o.tl || {};
  const start = num(tl.start, 0);
  const dock = Math.max(start + 2, num(tl.dock, start + 14));
  const rv = clamp(num(tl.rv, (start + dock) / 2), start + 0.5, dock - 0.5);
  const f = o.flags || {}, ev = o.events || {};
  const berth = o.seq === 'berth';
  const out = { range: 200, off: 0, rot: 0, phase: 'approach', flash: 0, arm: 0, armHold: false, lights: 'approach', rcs: false };
  if (f.docked) {
    const tc = Number.isFinite(ev.dock) ? ev.dock : Number.isFinite(ev.berth) ? ev.berth : null;
    const s = tc == null ? 9 : t - tc;
    out.range = 0; out.phase = 'docked'; out.lights = 'docked';
    out.flash = s >= 0 && s < 0.6 ? 1 - s / 0.6 : 0;
    out.arm = berth ? clamp(1 - (s - 1.5) / 2, 0, 1) : 0; out.armHold = berth && s < 1.5;
    return out;
  }
  if (f.dockFail) { // glancing contact, then the craft drifts away (no explosion)
    const s = Math.max(0, Number.isFinite(ev.dockFail) ? t - ev.dockFail : 3);
    out.phase = 'drift'; out.lights = 'abort';
    out.range = 0.35 + 0.9 * s + 0.12 * s * s; out.off = -0.5 * s - 0.05 * s * s; out.rot = 0.06 * s;
    out.flash = s < 0.35 ? (1 - s / 0.35) * 0.6 : 0;
    return out;
  }
  if (f.rvFail) {
    const s = Math.max(0, Number.isFinite(ev.rvFail) ? t - ev.rvFail : 3);
    out.phase = 'drift'; out.lights = 'abort';
    out.range = 30 + 2.2 * s; out.off = -0.8 * s; out.rot = -0.04 * s;
    return out;
  }
  if (clock < rv) {
    const u = (clock - start) / (rv - start);
    out.range = 30 + 170 * (1 - ease(u));
    out.rcs = u > 0.05;
    return out;
  }
  const u = clamp((clock - rv) / (dock - rv), 0, 1);
  const wob = f.rvAnomaly ? 1 : 0;
  if (u < 0.45) { out.range = lerp(30, 10, ease(u / 0.45)); out.phase = 'closing'; out.rcs = true; }
  else if (u < 0.78 || berth) {
    out.range = 10; out.phase = 'hold';
    out.off = wob * 0.45 * Math.sin(t * 2.3); out.rot = wob * 0.035 * Math.sin(t * 1.7 + 1);
    if (berth) {
      out.arm = clamp((u - 0.45) / 0.25, 0, 1);
      if (u >= 0.7) { out.armHold = true; out.range = lerp(10, 0.15, ease((u - 0.7) / 0.3)); out.phase = 'berthing'; out.off = 0; out.rot = 0; }
    }
  } else { out.range = lerp(10, 0.15, ease((u - 0.78) / 0.22)); out.phase = 'final'; out.rcs = true; }
  return out;
}

/**
 * Module release from the upper stage (no station): spring separation, arrays then radiators unfold (0.8 s each),
 * the stage backs off, turns its engines away (90°) and makes a small deorbit burn that takes it down and out; a founding module turns to its attitude and lights up.
 * @param o {since: t − events.release | null, released: bool, founding: bool}
 */
export function releasePose(o = {}) {
  const released = !!o.released;
  const s = released ? (Number.isFinite(o.since) ? Math.max(0, o.since) : 30) : -1;
  if (!released) return { sep: 0, arrays: 0, radiators: 0, stageRot: 0, stageBurn: 0, stageAway: 0, moduleRot: 0, lights: false, phase: 'attached' };
  return {
    sep: 0.6 * s + 0.12 * s * s,
    arrays: clamp((s - 1.0) / 0.8, 0, 1),
    radiators: clamp((s - 1.8) / 0.8, 0, 1),
    stageRot: -(Math.PI / 2) * ease((s - 1.2) / 2.6), // turns its engines away from the module before the burn
    stageBurn: s > 4 && s < 5.6 ? Math.min(1, (s - 4) / 0.3) * Math.min(1, (5.6 - s) / 0.3) : 0,
    stageAway: s > 4 ? 1.6 * (s - 4) + 1.2 * Math.max(0, s - 4) ** 2 : 0,
    moduleRot: o.founding ? -0.18 * ease((s - 2.6) / 2.4) : 0,
    lights: !o.founding || s > 5,
    phase: s < 1 ? 'separation' : s < 2.6 ? 'deploy' : s < 5.6 ? 'departure' : 'done',
  };
}

// ------------------------------------------------------------------ surface base: projection + layout (pure)

/**
 * Ground band between the touchdown point and the horizon over a surface base, as a fraction of H. The camera
 * sits high enough (≈ 1.4 lander heights) for the base to spread out in depth: the pad in the foreground
 * (camera.descentFrame puts it at ≈ 0.66 H), the base in a mid-ground band, the giants on the horizon.
 */
export const BASE_HOR_K = 0.28;
const BASE_ASPECT = 390 / 844; // portrait phone: the layout keeps everything inside this frame

/** Horizon over a surface base (see BASE_HOR_K). */
export function baseHorizonY(view, groundY) {
  const H = num(view?.H, 700);
  return Math.min(num(groundY, H) - H * BASE_HOR_K, H * 0.62);
}

/**
 * The landing terrain's perspective (textures.drawTerrain): ground point (x lateral m, d m behind the touchdown
 * point) → screen. Mirrors the terrain's camera height / focal length so the base sits on the same ground.
 */
export function groundProjection(view, { groundY, pxPerM = 4, altM = 0, scrollX = 0, horizonY } = {}) {
  const W = num(view?.W, 375), H = num(view?.H, 700);
  const ppm = Math.max(0.05, num(pxPerM, 4));
  const gy = num(groundY, H * 0.8);
  const hor = Number.isFinite(horizonY) ? clamp(horizonY, H * 0.15, gy - 2) : Math.min(gy - H * 0.05, H * 0.62);
  const f = H;
  const hcGeo = Math.max(0.5, (gy - hor) / ppm);
  const hc = lerp(hcGeo, Math.max(hcGeo, Math.max(0, num(altM)) * 0.5), sstep(H * 0.95, H * 1.35, gy));
  const Xoff = num(scrollX) / ppm;
  const z0 = (f * hc) / Math.max(0.2, gy - hor);
  return {
    W, H, hor, hc, f, z0, Xoff,
    project(x, d) { const Z = Math.max(0.5, z0 + d); const s = f / Z; return { x: W / 2 + (x - Xoff) * s, y: hor + hc * s, s, Z }; },
  };
}

// tier → generic module counts (cumulative; only for existing bases, never for a base being founded)
const GENERIC = [
  [['bs_hab_small', 2], ['bs_solar', 2], ['_mast', 1]],
  [['bs_pad', 1], ['bs_lab', 1]],
  [['bs_hab_large', 1], ['bs_greenhouse', 1], ['bs_comms', 1], ['bs_hab_small', 3]],
  [['bs_dome', 3], ['bs_garage', 1], ['bs_isru', 1], ['bs_solar', 4]],
  [['bs_dome', 5], ['bs_factory', 1], ['bs_mass_driver', 1], ['bs_fission', 1]],
  [['bs_arcology', 3], ['bs_megastructure', 1]],
];
const GENERIC_VEH = [[], [['vh_lrv', 1]], [['vh_lrv', 1]], [['vh_truck', 1], ['vh_crane', 1]], [['vh_pressurized', 1]], [['vh_crawler', 1]]];
const CAPS = [2, 3, 4, 6, 8, 10];
// horizon giants: distance range (m); each is pushed back further until its whole width fits the frame
const HORIZON_D = { rail: [4000, 7000], arcology: [5200, 9500], mega: [22000, 30000] };
const DRIVERS = new Set(['buggy', 'crane', 'excavator', 'cabin', 'truck', 'drone', 'hopper']);
// where each kind stands: depth range (m behind touchdown) and side ('A' = habitat side, 'B' = power side, 0 = any)
const ZONE = {
  hab: { d: [13, 36], side: 'A' }, lab: { d: [16, 44], side: 'A' }, garage: { d: [20, 52], side: 'A' }, mound: { d: [34, 80], side: 'A' },
  solar: { d: [12, 46], side: 'B' }, mast: { d: [12, 30], side: 'B' }, tower: { d: [46, 100], side: 'B' },
  greenhouse: { d: [34, 80], side: 'A' }, plant: { d: [50, 120], side: 'B' }, reactor: { d: [110, 190], side: 'B' },
  dome: { d: [140, 460], side: 0 }, factory: { d: [260, 640], side: 0 }, pad: { d: [46, 96], side: 'B' },
};
const ROUND = new Set(['dome', 'greenhouse', 'reactor', 'tower', 'mast', 'garage']);
/** Ground depth extent (m) of an item's footprint. */
const depthOf = (it) => (ROUND.has(it.kind) ? it.w * (it.kind === 'garage' ? 0.6 : 1) : it.kind === 'solar' ? 3 : it.kind === 'pad' ? it.w : it.kind === 'rail' ? 30 : Math.max(3, it.h * 0.9));
/** Sprite height over the item's nominal height (dish masts, the arch over the pylons…). */
const upOf = (kind) => (kind === 'lab' || kind === 'tower' ? 1.5 : kind === 'mega' ? 1.4 : kind === 'arcology' ? 1.12 : kind === 'pad' ? 0.2 : 1.08);

/**
 * Screen-space helper of a base layout in units of H (x = 0 at the centre, y = 0 on the horizon, frame ±A/2 wide):
 * the same perspective as groundProjection with the base framing (BASE_HOR_K, z0 = touchdown distance).
 */
function baseScreen(z, A) {
  const halfW = (d) => (A / 2) * (z + d);
  const rect = (x, d, w, h, up = 1.08) => { const s = 1 / (z + d), y1 = BASE_HOR_K * z * s; return { x0: (x - w / 2) * s, x1: (x + w / 2) * s, y0: y1 - h * up * s, y1 }; };
  return { halfW, rect };
}
const hitR = (a, b, m = 0.004) => a.x0 < b.x1 + m && b.x0 < a.x1 + m && a.y0 < b.y1 + m && b.y0 < a.y1 + m;
const footHit = (a, b, gap = 2) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.d - b.d) < ((a.dep ?? depthOf(a)) + depthOf(b)) / 2 + gap;

/**
 * Base layout (pure, deterministic). Composition (MISSIONS-V2 §7.3): the landing pad in the foreground under the
 * lander, clear ground around it; habitats / labs / garage connected by tunnels on one side of the mid-ground,
 * the solar field and the comms tower on the other, the plant and the reactor further back, domes and factories
 * far away, the tier-5 giants on the horizon. Every item is placed in screen space too: inside the frame, never
 * behind the lander or on the pad, and (near the camera) never inside another item's screen footprint.
 * Vehicles get parking spots and unload slots beside the lander with the same rules.
 * @param target SceneTarget (raw or resolved)  @param o {seed, sizeTier, bodyId, z0 (touchdown distance m), landerW, aspect}
 */
export function layoutBase(target, { seed = 1, sizeTier, bodyId, z0 = 40, landerW = 5, aspect = BASE_ASPECT } = {}) {
  const t = resolveTarget(target) || resolveTarget({ kind: 'base', sequence: 'surface' });
  const tier = clamp(Math.round(num(sizeTier, t.sizeTier)), 0, 5);
  const R = rng(((num(seed, 1) >>> 0) ^ hash(t.sig || '')) >>> 0);
  const cap = CAPS[tier];
  const want = new Map();
  for (const m of t.modules) {
    if (!/^bs_|^_/.test(m.id) && m.art.kind == null) continue;
    const c = m.art.kind === 'pad' ? (tier >= 3 ? 2 : 1) : m.art.kind === 'mega' ? 1 : Math.min(m.n, cap);
    want.set(m.id, Math.max(want.get(m.id) || 0, c));
  }
  if (!t.newAsset) for (let i = 0; i <= tier; i++) for (const [id, c] of GENERIC[i]) { if (id === 'bs_hab_small' && i === 0 && (R() < 0.4)) { want.set(id, Math.max(want.get(id) || 0, 1)); continue; } want.set(id, Math.max(want.get(id) || 0, c)); }
  const z = Math.max(5, num(z0, 40));
  const A = clamp(num(aspect, BASE_ASPECT), 0.3, 2.2);
  const lw = Math.max(1, num(landerW, 5));
  const S = baseScreen(z, A);
  const sideA = R() < 0.5 ? -1 : 1; // the habitat side
  // the lander's screen box (≤ 0.2 H tall by the descent framing) and the pad (radius ≥ 1.6 × the leg half-span,
  // the whole disc inside the frame)
  const landerR = { x0: -(lw / 2 + 1.3) / z, x1: (lw / 2 + 1.3) / z, y0: BASE_HOR_K - 0.215, y1: BASE_HOR_K + 0.01 };
  const items = [];
  const placed = [];
  const blocks = [landerR];
  // the Earth in the lunar sky (index.js: 0.8 W, 0.14 H, r 18 px): the horizon giants stand clear of it
  if ((bodyId || t.bodyId) === 'moon') blocks.push({ x0: 0.3 * A - 0.03, x1: 0.3 * A + 0.03, y0: 0.14 - (0.66 - BASE_HOR_K) - 0.03, y1: 0.14 - (0.66 - BASE_HOR_K) + 0.03 });
  let pad = null;
  const hasPad = [...want.keys()].some((id) => moduleArt(id).kind === 'pad');
  if (hasPad) {
    const id = [...want.keys()].find((k) => moduleArt(k).kind === 'pad');
    const art = moduleArt(id);
    const Rp = clamp(Math.max(lw * 1.6, 6), 3, S.halfW(0) * 0.8);
    pad = { id, art, kind: 'pad', x: 0, d: 0, w: 2 * Rp, h: num(art.h, 0.6), band: 'pad' };
    blocks.push({ x0: -Rp / (z - Rp * 0.9), x1: Rp / (z - Rp * 0.9), y0: BASE_HOR_K * z / (z + Rp), y1: BASE_HOR_K * z / Math.max(1, z - Rp) });
  }
  const Rpad = pad ? pad.w / 2 : lw * 1.2;
  // pad floodlight masts at the back corners of the pad (also on a bare landing site from tier 1)
  const lights = [];
  if (pad) for (const sg of [-1, 1]) { const d = Rpad * 0.55, x = sg * Math.min(Rpad + 1.4, S.halfW(d) * 0.9); lights.push({ x, d, h: 7 }); placed.push({ x, d, w: 1.5, kind: 'mast' }); }
  /** Best spot for a box w × h (m) in a depth range / side; screen hits cost, ground overlaps cost more. */
  const findSpot = (w, h, dep, d0, d1, side, { up = 1.08, near = 120, tries = 30, foot = true, uMin = 0 } = {}) => {
    const dFit = w / (0.9 * A) - z; // the whole width inside the frame
    let best = null, bestScore = Infinity;
    for (let k = 0; k < tries; k++) {
      const d = Math.max(dFit, lerp(d0, d1, Math.pow(R(), 1.2)) + (k > tries * 0.6 ? (k - tries * 0.6) * 0.08 * (d1 - d0) : 0));
      const hw = S.halfW(d);
      const umax = 0.95 - w / 2 / hw;
      if (umax <= 0) continue;
      // a crowded side spills over to the other one (at a small cost)
      const pref = side === 'A' ? sideA : side === 'B' ? -sideA : 0;
      const sg = pref && k % 3 !== 2 ? pref : R() < 0.5 ? 1 : -1;
      const u = sg * lerp(Math.min(uMin, umax), umax, R());
      const x = u * hw;
      const r = S.rect(x, d, w, h, up);
      let score = pref && sg !== pref ? 8 : 0;
      for (const b of blocks) if (hitR(r, b, 0.006)) score += 60;
      for (const p of placed) {
        if (foot && footHit({ x, d, w, h, dep }, p, 2.5)) score += 400;
        else if (p.r && d < near && p.d < near && hitR(r, p.r)) score += 12;
      }
      if (score < bestScore) { best = { x, d, r }; bestScore = score; if (score === 0) break; }
    }
    return best || { x: sideA * S.halfW(d1) * 0.5, d: d1, r: S.rect(sideA * S.halfW(d1) * 0.5, d1, w, h, up) };
  };
  // vehicles: the base's own first (≤ 6 drawn), generic ones for an existing base without any
  const vlist = [];
  for (const v of t.vehicles) for (let i = 0; i < v.n && vlist.length < 6; i++) vlist.push({ id: v.id, art: v.art });
  // generic vehicles only when the snapshot carries no vehicle list at all (a base with vehicles: [] has none: the
  // lander then lowers its crate / the crew walks out, §7.3)
  if (!vlist.length && !t.newAsset && !t.vehicleList) for (let i = 0; i <= tier; i++) for (const [id, c] of GENERIC_VEH[i]) for (let j = 0; j < c && vlist.length < 6; j++) vlist.push({ id, art: baseVehicleArt(id) });
  const vbox = (len, h, kind) => ({ w: len, h: kind === 'drone' ? 1.2 : h });
  /** Unload slot beside the lander: the nearest depth where the whole vehicle shows between the lander and the frame edge. */
  const slotFor = (sd, len, h, kind) => {
    const bx = vbox(len, h, kind);
    for (let d = 1.5; d < Rpad + 60; d += 1.5) {
      const hw = S.halfW(d);
      const xIn = Math.max(lw / 2 + 0.8 + len / 2, (landerR.x1 + 0.012) * (z + d) + len / 2);
      const xOut = 0.9 * hw - len / 2;
      if (xIn > xOut) continue;
      for (const x of [xIn, lerp(xIn, xOut, 0.5), xOut]) {
        const r = S.rect(sd * x, d, bx.w, bx.h, 1.1);
        if (blocks.some((b) => hitR(r, b, 0.004)) || placed.some((p) => p.r && hitR(r, p.r, 0.002))) continue;
        return { x: sd * x, d, r };
      }
    }
    const d = Rpad + 4; const x = sd * Math.max(lw / 2 + 1 + len / 2, 0.9 * S.halfW(d) - len / 2);
    return { x, d, r: S.rect(x, d, len, h, 1.1) };
  };
  // at most two vehicles come to the lander (the loader that takes the crate and one more); the rest stay parked.
  // Their unload slots are reserved before the buildings are placed, so the apron beside the pad stays clear.
  // the smallest loader comes for the crate: it can park right beside the lander inside the frame
  const loaderI = vlist.map((v, i) => [i, num(v.art.len, 3.5), v.art.kind || 'buggy']).filter(([, , kd]) => ['truck', 'crane', 'cabin', 'buggy'].includes(kd)).sort((a, b) => a[1] - b[1])[0]?.[0] ?? -1;
  const driverIs = new Set();
  if (loaderI >= 0) driverIs.add(loaderI);
  const other = vlist.findIndex((v, i) => !driverIs.has(i) && DRIVERS.has(v.art.kind || 'buggy') && num(v.art.len, 3.5) <= 6.5);
  if (other >= 0) driverIs.add(other);
  else if (loaderI < 0) { const any = vlist.findIndex((v) => DRIVERS.has(v.art.kind || 'buggy') && (v.art.kind || 'buggy') !== 'crawler'); if (any >= 0) driverIs.add(any); }
  let side = R() < 0.5 ? 1 : -1;
  const slots = vlist.map((v, i) => {
    if (!driverIs.has(i)) return null;
    const len = num(v.art.len, 3.5), h = num(v.art.h, 1.8);
    const sd = side; side = -side;
    const sl = slotFor(sd, len, h, v.art.kind);
    placed.push({ x: sl.x, d: sl.d, w: len, h, kind: 'hab', r: sl.r, veh: true });
    return sl;
  });
  const pvArt = t.payload?.kind === 'base_vehicle' ? t.payloadVehicleArt || baseVehicleArt(t.payload.vehicleTypeId) : null;
  const pvSlots = [];
  // delivered vehicles roll off the lander's ramp right beside it (they emerge from behind it)
  if (pvArt) for (let i = 0; i < t.payload.qty && i < 4; i++) {
    const len = num(pvArt.len, 3.5);
    pvSlots.push({ x: (i % 2 ? -1 : 1) * (lw / 2 + len / 2 + 0.4), d: 1 + i * 0.8 });
  }
  // a delivered base module is set down clear of the lander's footprint
  let moduleSpot = null;
  if (t.payload?.kind === 'base_module') {
    const art = t.payloadArt || moduleArt(t.payload.moduleId || 'bs_hab_small');
    const w = num(art.w, 6.5), h = num(art.h, 4.2);
    const sd = slots.find(Boolean)?.x > 0 ? -1 : 1;
    const sp = slotFor(sd, w, h, 'hab');
    if (!vlist.length) placed.push({ x: sp.x, d: sp.d, w, h, kind: 'hab', r: sp.r });
    moduleSpot = { x: sp.x, d: sp.d, w, h, art, id: art.id || t.payload.moduleId || 'bs_hab_small', side: Math.sign(sp.x) || sd };
  }
  // big things first so the small ones fill the gaps; the pad first of all
  const KIND_ORDER = ['mega', 'arcology', 'rail', 'factory', 'dome', 'mound', 'garage', 'lab', 'hab', 'greenhouse', 'plant', 'reactor', 'tower', 'solar', 'mast', 'pad'];
  const order = [...want.entries()].sort((a, b) => KIND_ORDER.indexOf(moduleArt(a[0]).kind || 'hab') - KIND_ORDER.indexOf(moduleArt(b[0]).kind || 'hab'));
  let padUsed = false;
  for (const [id, count] of order) {
    const art = moduleArt(id);
    for (let i = 0; i < count && items.length < 48; i++) {
      const kind = art.kind || 'hab';
      if (kind === 'pad' && !padUsed) { padUsed = true; continue; }
      const w = num(art.w, 6), h = num(art.h, 4);
      const it = { id, art, kind, x: 0, d: 0, w, h, band: kind === 'pad' ? 'pad' : art.band || 'near', v: R() };
      if (it.kind === 'arcology') it.h *= 0.7 + 0.6 * it.v;
      let spot;
      if (it.band === 'horizon') {
        const [h0, h1] = HORIZON_D[kind] || [2400, 6000];
        spot = findSpot(w, it.h, depthOf(it), h0, h1, 0, { up: upOf(kind), near: 0, foot: false, tries: 14 });
        // horizon giants must not stand in front of each other's silhouette
        for (let k = 0; k < 8 && placed.some((p) => p.band === 'horizon' && p.r && hitR(spot.r, p.r, 0.01)); k++) spot = findSpot(w, it.h, depthOf(it), h0, h1 * 1.2, 0, { up: upOf(kind), near: 0, foot: false, tries: 6 });
      } else {
        const zn = ZONE[kind] || ZONE.hab;
        // near the camera a kind keeps to its side; a crowded side spills over to the other one
        spot = findSpot(w, it.h, depthOf(it), zn.d[0], zn.d[1], zn.side, { up: upOf(kind), uMin: zn.d[0] < 100 ? 0.25 : 0 });
      }
      it.x = spot.x; it.d = spot.d;
      it.r = spot.r; it.kindHint = kind;
      items.push(it);
      placed.push(it);
    }
  }
  // tunnels between neighbouring pressurised buildings on the habitat side
  const tunnels = [];
  const pres = items.filter((it) => ['hab', 'lab', 'mound', 'garage', 'greenhouse'].includes(it.kind) && it.d < 90).sort((a, b) => a.x - b.x);
  for (let i = 0; i < pres.length - 1; i++) {
    const a = pres[i], b = pres[i + 1];
    if (Math.hypot(a.x - b.x, a.d - b.d) < 34) tunnels.push([[a.x, a.d], [b.x, b.d]]);
  }
  // roads (tier ≥ 2): compacted tracks from the pad's edge to the nearest buildings; from tier 1 an approach
  // road comes up from the foreground to the pad and the solar field is cabled to the habitats
  const roads = [];
  if (tier >= 2) {
    const dest = items.filter((it) => it.d < 160 && it.kind !== 'solar' && it.kind !== 'mast' && it.kind !== 'pad').sort((a, b) => a.d - b.d).slice(0, Math.min(5, 2 + tier));
    for (const it of dest) { const sg = Math.sign(it.x) || 1; roads.push([[sg * Rpad * 0.8, Rpad * 0.6], [lerp(sg * Rpad, it.x, 0.5), lerp(Rpad, it.d, 0.35)], [it.x, Math.max(Rpad + 2, it.d - depthOf(it) / 2 - 0.5)]]); }
  }
  const approach = tier >= 1 && pad ? [[-sideA * S.halfW(-z * 0.6) * 0.55, -z * 0.6], [-sideA * Rpad * 1.4, -Rpad * 1.2], [-sideA * Rpad * 0.85, -Rpad * 0.35]] : null;
  const cables = [];
  const sol = items.filter((it) => it.kind === 'solar').sort((a, b) => a.d - b.d)[0];
  const hab0 = items.filter((it) => it.kind === 'hab' || it.kind === 'lab').sort((a, b) => a.d - b.d)[0];
  if (sol && hab0) cables.push([[sol.x, sol.d - 1], [lerp(sol.x, hab0.x, 0.5), Math.max(Rpad + 3, Math.min(sol.d, hab0.d) - 2)], [hab0.x, hab0.d - depthOf(hab0) / 2]]);
  /** Parking spot in the motor pool (habitat side, in front of / between the buildings). */
  const parkFor = (len, h, kind, nearK = 0.02) => {
    const bx = vbox(len, h, kind);
    if (kind === 'crawler') return findSpot(len, h, len * 0.5, 160, 420, 0, { foot: true, near: 0 });
    let best = null, bestS = Infinity;
    for (let k = 0; k < 70; k++) {
      const d = lerp(Rpad + 6 + len * 0.6, Rpad + 40 + k * 1.2, R());
      const hw = S.halfW(d);
      const umax = 0.95 - len / 2 / hw;
      if (umax <= 0.05) continue;
      const sg = k % 3 === 2 ? -sideA : sideA;
      const x = sg * lerp(0.05, umax, R()) * hw;
      const r = S.rect(x, d, bx.w, bx.h, 1.1);
      let sc = d * nearK + (sg === sideA ? 0 : 0.5);
      for (const b of blocks) if (hitR(r, b, 0.004)) sc += 1000;
      for (const p of placed) { if (footHit({ x, d, w: len, h }, p, 1)) sc += 100; else if (p.r && hitR(r, p.r, 0.002)) sc += p.veh ? 30 : 6; }
      if (sc < bestS) { bestS = sc; best = { x, d, r }; }
    }
    return best;
  };
  const vehicles = [];
  vlist.forEach((v, i) => {
    const art = v.art;
    const len = num(art.len, 3.5), h = num(art.h, 1.8);
    const kind = art.kind || 'buggy';
    const park = parkFor(len, h, kind);
    placed.push({ x: park.x, d: park.d, w: len, h, kind: 'hab', r: park.r, veh: true });
    const sl = slots[i];
    vehicles.push({ id: v.id, art, kind, len, h, park: { x: park.x, d: park.d }, slot: sl ? { x: sl.x, d: sl.d } : { x: park.x, d: park.d }, drives: !!sl, delay: i * 0.6, loader: i === loaderI });
  });
  // payload vehicles roll off beside the lander and drive to a parking spot that stays in view
  const payloadVehicles = pvSlots.map((sl, i) => {
    const len = num(pvArt.len, 3.5), h = num(pvArt.h, 1.8);
    const park = parkFor(len, h, pvArt.kind, 0.25);
    placed.push({ x: park.x, d: park.d, w: len, h, kind: 'hab', r: park.r, veh: true });
    return { id: pvArt.id, art: pvArt, kind: pvArt.kind || 'buggy', len, h, park: { x: park.x, d: park.d }, slot: { x: sl.x, d: sl.d }, drives: true, delay: 0.4 + i * 0.9 };
  });
  for (const it of items) { delete it.r; delete it.kindHint; }
  items.sort((a, b) => b.d - a.d);
  return { tier, items, pad, roads, approach, cables, tunnels, lights, vehicles, payloadVehicles, moduleSpot, z0: z, landerW: lw, sideA, newAsset: t.newAsset, bodyId: bodyId || t.bodyId, payload: t.payload, sig: `${t.sig}|${tier}|${Math.round(z)}|${num(seed, 1)}` };
}

/** Quadratic path from a to b through c; arc length estimate. */
function pathPoint(a, c, b, u) { const v = 1 - u; return { x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, d: v * v * a.d + 2 * v * u * c.d + u * u * b.d }; }
function pathLen(a, c, b) { let L = 0, p = a; for (let i = 1; i <= 8; i++) { const q = pathPoint(a, c, b, i / 8); L += Math.hypot(q.x - p.x, q.d - p.d); p = q; } return L; }

/**
 * Where every vehicle is (pure). since = seconds after the `unload` event (null = not yet); parked = show them
 * already beside the lander (reduced motion / resumed after landing). Speed 3 m/s visual, each trip 2–9 s.
 * @returns [{x, d, facing (−1|1), moving, arrived, hover, carrying}]
 */
export function vehicleStates(layout, { since = null, parked = false } = {}) {
  const res = [];
  const list = layout?.vehicles || [];
  let crateTaken = null;
  list.forEach((v, i) => {
    if (!v.drives) { res.push({ x: v.park.x, d: v.park.d, facing: 1, moving: false, arrived: false, hover: 0 }); return; }
    const a = v.park, b = v.slot, c = { x: lerp(a.x, b.x, 0.25), d: b.d + Math.min(10, Math.max(0, a.d - b.d) * 0.5) };
    if (parked) { res.push({ x: b.x, d: b.d, facing: b.x > 0 ? -1 : 1, moving: false, arrived: true, hover: v.kind === 'drone' ? 2 : 0 }); if (v.loader && crateTaken == null) { crateTaken = i; res[res.length - 1].loader = true; } return; }
    if (since == null || since < v.delay) { res.push({ x: a.x, d: a.d, facing: b.x > a.x ? 1 : -1, moving: false, arrived: false, hover: v.kind === 'drone' ? num(v.art.hover, 6) * 0.35 : 0 }); return; }
    const L = pathLen(a, c, b);
    const dur = clamp(L / 3, 2, 9);
    const u = clamp((since - v.delay) / dur, 0, 1);
    const p = pathPoint(a, c, b, ease(u));
    const q = pathPoint(a, c, b, ease(Math.min(1, u + 0.02)));
    const arrived = u >= 1;
    const hov = v.kind === 'drone' ? num(v.art.hover, 6) * (arrived ? 0.35 : 1) : v.kind === 'hopper' ? Math.sin(u * Math.PI) * 6 : 0;
    const st = { x: p.x, d: p.d, facing: arrived ? (b.x > 0 ? -1 : 1) : Math.sign(q.x - p.x) || (b.x > 0 ? -1 : 1), moving: !arrived, arrived, hover: hov, arriveAt: v.delay + dur };
    if (arrived && v.loader && crateTaken == null) { crateTaken = i; st.loader = true; }
    res.push(st);
  });
  // payload vehicles roll out from the lander to the parking area
  (layout?.payloadVehicles || []).forEach((v) => {
    if (parked || since == null) { res.push({ x: parked ? v.park.x : v.slot.x, d: parked ? v.park.d : v.slot.d, facing: 1, moving: false, arrived: parked, hover: 0, payload: true, hidden: !parked && since == null }); return; }
    const a = v.slot, b = v.park, c = { x: a.x + (b.x - a.x) * 0.2, d: a.d + (b.d - a.d) * 0.6 };
    const dur = clamp(pathLen(a, c, b) / 3, 2.5, 9);
    const u = clamp((since - v.delay) / dur, 0, 1);
    const p = pathPoint(a, c, b, ease(u)), q = pathPoint(a, c, b, ease(Math.min(1, u + 0.02)));
    res.push({ x: p.x, d: p.d, facing: Math.sign(q.x - p.x) || 1, moving: u > 0 && u < 1, arrived: u >= 1, hover: 0, payload: true, hidden: since < v.delay - 0.2 });
  });
  return res;
}

/** Size tier → the counts drawn (for tests and the preview HUD). */
export function baseCounts(layout) {
  const c = {};
  for (const it of layout?.items || []) c[it.kind] = (c[it.kind] || 0) + 1;
  if (layout?.pad) c.pad = (c.pad || 0) + 1;
  c.vehicles = (layout?.vehicles || []).length;
  return c;
}

// ------------------------------------------------------------------ base painters

function groundTone(world) {
  const look = bodyLook(world);
  const pal = look.palette || ['#7e7b76'];
  return rgbOf(pal[Math.min(pal.length - 1, 2)]);
}

/** Solar cells on a flat panel (x0..x1, y0..y1 in px): cell grid, frame, blanket gaps, a soft sun glint. */
function cellPanel(g, X0, Y0, W, H, light, { color = '#1d2b58', cellPx = 3, glint = 0.5, gaps = 0 } = {}) {
  if (W < 0.5 || H < 0.5) return;
  const c = rgbOf(color);
  const gr = g.createLinearGradient(X0, Y0, X0 + W, Y0 + H);
  gr.addColorStop(0, css(mixC(c, [120, 150, 215], 0.28)));
  gr.addColorStop(0.55, css(scaleC(c, 0.82)));
  gr.addColorStop(1, css(mixC(c, [70, 90, 150], 0.25)));
  g.fillStyle = gr; g.fillRect(X0, Y0, W, H);
  if (cellPx >= 1.6 && W > 4) {
    g.strokeStyle = 'rgba(150,170,225,0.22)'; g.lineWidth = Math.min(0.6, cellPx * 0.18);
    g.beginPath();
    for (let x = X0 + cellPx; x < X0 + W - 0.4; x += cellPx) { g.moveTo(x, Y0); g.lineTo(x, Y0 + H); }
    for (let y = Y0 + cellPx; y < Y0 + H - 0.4; y += cellPx) { g.moveTo(X0, y); g.lineTo(X0 + W, y); }
    g.stroke();
  }
  if (gaps > 0) { g.fillStyle = 'rgba(200,190,160,0.55)'; for (let i = 1; i < gaps; i++) g.fillRect(X0 + (W * i) / gaps - 0.4, Y0, 0.8, H); }
  if (glint > 0) { // specular glint band toward the sun
    const L = L3(light);
    const gx = X0 + W * clamp(0.5 + L[0] * 0.5, 0.1, 0.9);
    const gg = g.createLinearGradient(gx - W * 0.3, Y0, gx + W * 0.3, Y0 + H);
    gg.addColorStop(0, 'rgba(210,225,255,0)'); gg.addColorStop(0.5, `rgba(210,225,255,${(0.28 * glint).toFixed(3)})`); gg.addColorStop(1, 'rgba(210,225,255,0)');
    g.fillStyle = gg; g.fillRect(X0, Y0, W, H);
  }
  g.strokeStyle = 'rgba(190,196,204,0.7)'; g.lineWidth = Math.max(0.5, Math.min(1.2, cellPx * 0.25));
  g.strokeRect(X0, Y0, W, H);
}

/** One base item in local metres (origin = base centre on the ground, y up), scale k. */
function paintBaseItem(g, it, k, light, world, night) {
  const a = it.art || {};
  const w = it.w, h = it.h;
  const L = L3(light);
  const lit = L[0] < 0 ? -1 : 1; // side the sun comes from
  const ground = groundTone(world);
  const winC = night ? [255, 206, 130] : [255, 222, 168];
  const winDot = (x, y, r = 0.22, ww = 1, hh = 1) => {
    const X = (x - r * ww) * k, Y = -(y + r * hh) * k, Wp = Math.max(0.8, 2 * r * ww * k), Hp = Math.max(0.8, 2 * r * hh * k);
    if (night && Array.isArray(g.__wins)) { g.__wins.push([X, Y, Wp, Hp]); return; } // lit after the night darkening (drawItem)
    if (night && Wp > 1.2) { g.fillStyle = css(winC, 0.25); g.fillRect(X - Wp * 0.6, Y - Hp * 0.6, Wp * 2.2, Hp * 2.2); }
    g.fillStyle = night ? css(winC, 0.95) : 'rgba(40,52,66,0.85)'; g.fillRect(X, Y, Wp, Hp);
    if (!night && Wp > 2) { g.fillStyle = 'rgba(190,210,230,0.45)'; g.fillRect(X, Y, Wp * 0.4, Hp * 0.5); }
  };
  // side shading: the end away from the sun darker (one sun for the whole scene)
  const sideShade = (x0, y0, x1, y1, amt = 0.32) => {
    const gr = g.createLinearGradient(x0 * k, 0, x1 * k, 0);
    gr.addColorStop(lit < 0 ? 0 : 1, 'rgba(0,0,0,0)'); gr.addColorStop(lit < 0 ? 1 : 0, `rgba(0,0,0,${amt})`);
    g.save(); g.globalCompositeOperation = 'source-atop'; g.fillStyle = gr; g.fillRect(x0 * k, -y1 * k, (x1 - x0) * k, (y1 - y0) * k); g.restore();
  };
  const box = (x0, y0, x1, y1, mat, tint) => { g.fillStyle = cylGrad(g, x0 * k, 0, x1 * k, 0, mat, light, { amb: 0.45, spec: 0.05, tint }); g.fillRect(x0 * k, -y1 * k, (x1 - x0) * k, (y1 - y0) * k); };
  const roof = (x0, x1, y, rH, mat) => { g.fillStyle = cylGrad(g, 0, -(y + rH) * k, 0, -y * k, mat, light, { amb: 0.5 }); g.fillRect(x0 * k, -(y + rH) * k, (x1 - x0) * k, rH * k); };
  const berm = (hw, hh) => { // regolith piled against the footing (sits the building in the ground)
    g.fillStyle = cylGrad(g, 0, -hh * k, 0, 0, { base: css(scaleC(ground, 0.85)), light: css(scaleC(ground, 1.2)), dark: css(scaleC(ground, 0.5)), spec: 0 }, light, { amb: 0.5 });
    g.beginPath(); g.moveTo(-hw * k, 0); g.quadraticCurveTo(-hw * 0.9 * k, -hh * k, -hw * 0.7 * k, -hh * k); g.lineTo(hw * 0.7 * k, -hh * k); g.quadraticCurveTo(hw * 0.9 * k, -hh * k, hw * k, 0); g.closePath(); g.fill();
  };
  switch (it.kind) {
    case 'hab': case 'lab': {
      // horizontal pressure vessel on a footing, end domes, hoop ribs, an airlock hatch, framed windows
      const R = h * 0.4, cy = h - R;
      g.fillStyle = '#5e6268'; g.fillRect(-w * 0.36 * k, -(cy - R * 0.7) * k, w * 0.72 * k, (cy - R * 0.7) * k);
      const bx0 = -w / 2 + R * 0.5, bx1 = w / 2 - R * 0.5;
      g.save();
      g.beginPath();
      g.moveTo(bx0 * k, -(cy + R) * k); g.lineTo(bx1 * k, -(cy + R) * k);
      g.ellipse(bx1 * k, -cy * k, R * 0.5 * k, R * k, 0, -Math.PI / 2, Math.PI / 2);
      g.lineTo(bx0 * k, -(cy - R) * k);
      g.ellipse(bx0 * k, -cy * k, R * 0.5 * k, R * k, 0, Math.PI / 2, Math.PI * 1.5);
      g.closePath();
      g.fillStyle = cylGrad(g, 0, -(cy + R) * k, 0, -(cy - R) * k, a.mat || 'white_paint', light, { amb: 0.36 });
      g.fill();
      g.clip();
      sideShade(-w / 2, cy - R, w / 2, cy + R, 0.3);
      if (k > 1.5) {
        g.strokeStyle = 'rgba(70,74,80,0.28)'; g.lineWidth = Math.max(0.5, 0.07 * k);
        g.beginPath(); for (let f = -0.36; f <= 0.37; f += 0.18) { g.moveTo(f * w * k, -(cy + R) * k); g.lineTo(f * w * k, -(cy - R) * k); } g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.moveTo(bx0 * k, -(cy + R * 0.72) * k); g.lineTo(bx1 * k, -(cy + R * 0.72) * k); g.stroke();
      }
      g.restore();
      const n = clamp(num(a.windows, 2), 1, 5);
      for (let i = 0; i < n; i++) winDot(-w * 0.26 + (w * 0.52 * (i + 0.5)) / n, cy + R * 0.12, 0.26, 1.2, 0.8);
      // airlock hatch on the end away from the sun side
      const hx = -lit * (w / 2 - R * 0.1);
      g.fillStyle = cylGrad(g, (hx - 0.9) * k, 0, (hx + 0.9) * k, 0, 'grey_paint', light, { amb: 0.4 }); g.fillRect((hx - 0.8) * k, -(cy + R * 0.55) * k, 1.6 * k, R * 1.25 * k);
      g.fillStyle = night ? 'rgba(255,190,110,0.9)' : 'rgba(60,64,70,0.8)'; g.fillRect((hx - 0.35) * k, -(cy + R * 0.35) * k, 0.7 * k, R * 0.8 * k);
      if (it.kind === 'lab') { g.strokeStyle = '#9aa0a6'; g.lineWidth = Math.max(0.5, 0.1 * k); g.beginPath(); g.moveTo(w * 0.3 * k, -(cy + R) * k); g.lineTo(w * 0.3 * k, -(h + 1.6) * k); g.stroke(); g.fillStyle = cylGrad(g, (w * 0.3 - 0.8) * k, 0, (w * 0.3 + 0.8) * k, 0, 'white_paint', light); g.beginPath(); g.ellipse(w * 0.3 * k, -(h + 1.7) * k, Math.max(0.8, 0.8 * k), Math.max(0.5, 0.32 * k), -0.4, 0, TAU); g.fill(); }
      // regolith berm against the hull ends
      g.fillStyle = css(scaleC(ground, 0.82), 0.95);
      for (const sg of [-1, 1]) { g.beginPath(); g.moveTo(sg * w * 0.56 * k, 0); g.quadraticCurveTo(sg * w * 0.5 * k, -R * 0.5 * k, sg * w * 0.4 * k, -R * 0.45 * k); g.lineTo(sg * w * 0.36 * k, 0); g.fill(); }
      break;
    }
    case 'solar': {
      if (AIRLESS.has(world)) {
        // vertical solar array on a mast (polar sun near the horizon): two wings with cells, tripod base
        const mh = h, pw = w * 0.2;
        g.strokeStyle = '#8a8f96'; g.lineWidth = Math.max(0.5, 0.14 * k);
        g.beginPath(); g.moveTo(-1.1 * k, 0); g.lineTo(0, -1.6 * k); g.lineTo(1.1 * k, 0); g.stroke();
        g.fillStyle = cylGrad(g, -0.15 * k, 0, 0.15 * k, 0, 'bare_aluminium', light); g.fillRect(-0.12 * k, -mh * k, Math.max(0.6, 0.24 * k), mh * k);
        for (const sg of [-1, 1]) {
          const x0 = sg * 0.25, x1 = sg * (0.25 + pw * 2);
          cellPanel(g, Math.min(x0, x1) * k, -mh * 0.97 * k, Math.abs(x1 - x0) * k, mh * 0.62 * k, light, { cellPx: 0.55 * k, glint: sg === lit ? 0.9 : 0.35, gaps: 3 });
        }
      } else {
        // ground racks: three panels tilted toward the sun on posts, cells, glint
        const pw = w / 3, rh = Math.min(h, 3.2);
        for (let i = 0; i < 3; i++) {
          const x0 = -w / 2 + i * pw + 0.2, x1 = x0 + pw - 0.4;
          g.fillStyle = '#7f848b'; g.fillRect(((x0 + x1) / 2 - 0.08) * k, -rh * 0.62 * k, Math.max(0.5, 0.16 * k), rh * 0.62 * k);
          g.save(); g.translate(((x0 + x1) / 2) * k, -rh * 0.62 * k); g.transform(1, 0, lit * -0.3, 0.55, 0, 0);
          cellPanel(g, -(x1 - x0) / 2 * k, -rh * 0.5 * k, (x1 - x0) * k, rh * k, light, { cellPx: 0.5 * k, glint: 0.8 });
          g.restore();
        }
      }
      break;
    }
    case 'mast': {
      g.strokeStyle = '#8a8f96'; g.lineWidth = Math.max(0.5, 0.1 * k);
      g.beginPath(); g.moveTo(-0.8 * k, 0); g.lineTo(0, -1.2 * k); g.lineTo(0.8 * k, 0); g.stroke();
      g.fillStyle = cylGrad(g, -0.1 * k, 0, 0.1 * k, 0, 'bare_aluminium', light); g.fillRect(-0.08 * k, -h * k, Math.max(0.5, 0.16 * k), h * k);
      g.fillStyle = cylGrad(g, -0.5 * k, 0, 0.5 * k, 0, 'white_paint', light); g.beginPath(); g.ellipse(0.25 * k, -(h - 0.3) * k, Math.max(0.6, 0.55 * k), Math.max(0.4, 0.24 * k), -0.6, 0, TAU); g.fill();
      break;
    }
    case 'tower': {
      g.strokeStyle = '#a7acb3'; g.lineWidth = Math.max(0.5, 0.14 * k);
      g.beginPath();
      g.moveTo(-w / 2 * k, 0); g.lineTo(-0.25 * k, -h * k); g.moveTo(w / 2 * k, 0); g.lineTo(0.25 * k, -h * k);
      for (let y = 0; y < h - 1; y += 1.8) { const f0 = 1 - y / h, f1 = 1 - Math.min(h, y + 1.8) / h; g.moveTo(-w / 2 * f0 * k - (1 - f0) * 0.25 * k, -y * k); g.lineTo((w / 2 * f1 + (1 - f1) * 0.25) * k, -(y + 1.8) * k); }
      g.stroke();
      g.fillStyle = '#6c7076'; g.fillRect(-w * 0.6 * k, -0.4 * k, w * 1.2 * k, 0.4 * k); // footing
      g.fillStyle = cylGrad(g, -1.4 * k, 0, 1.4 * k, 0, 'white_paint', light);
      g.beginPath(); g.ellipse(lit * -0.6 * k, -(h * 0.8) * k, 1.4 * k, 0.55 * k, 0.5 * lit, 0, TAU); g.fill();
      break;
    }
    case 'reactor': {
      // compact fission reactor: core cylinder under a conical radiator, shielded by a regolith berm
      g.fillStyle = cylGrad(g, -w * 0.2 * k, 0, w * 0.2 * k, 0, 'bare_aluminium', light);
      g.fillRect(-w * 0.2 * k, -h * 0.35 * k, w * 0.4 * k, h * 0.35 * k);
      g.fillStyle = cylGrad(g, -w / 2 * k, 0, w / 2 * k, 0, 'grey_paint', light, { amb: 0.4 });
      g.beginPath(); g.moveTo(-w * 0.12 * k, -h * k); g.lineTo(w * 0.12 * k, -h * k); g.lineTo(w / 2 * k, -h * 0.35 * k); g.lineTo(-w / 2 * k, -h * 0.35 * k); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(40,44,48,0.35)'; g.lineWidth = Math.max(0.4, 0.06 * k);
      g.beginPath(); for (let i = -3; i <= 3; i++) { g.moveTo(i * w * 0.02 * k, -h * k); g.lineTo(i * w * 0.07 * k, -h * 0.35 * k); } g.stroke();
      berm(w * 0.9, h * 0.2);
      break;
    }
    case 'plant': {
      box(-w / 2, 0, w * 0.15, h * 0.55, 'grey_paint');
      box(w * 0.15, 0, w / 2, h * 0.38, 'bare_aluminium');
      roof(-w / 2, w * 0.15, h * 0.55, h * 0.04, 'white_paint');
      g.fillStyle = cylGrad(g, -w * 0.32 * k, 0, -w * 0.12 * k, 0, 'white_paint', light);
      g.fillRect(-w * 0.32 * k, -h * k, w * 0.2 * k, h * 0.45 * k); // hopper / reactor column
      g.strokeStyle = '#8a8f96'; g.lineWidth = Math.max(0.5, 0.18 * k);
      g.beginPath(); g.moveTo(w * 0.32 * k, -h * 0.38 * k); g.lineTo(w * 0.55 * k, -h * 0.05 * k); g.stroke(); // conveyor
      winDot(-w * 0.05, h * 0.3, 0.3); winDot(w * 0.3, h * 0.2, 0.3);
      sideShade(-w / 2, 0, w / 2, h, 0.25);
      break;
    }
    case 'garage': {
      // half-cylinder hangar in a berm with a lit door
      g.fillStyle = cylGrad(g, 0, -h * k, 0, 0, 'bare_aluminium', light, { amb: 0.4 });
      g.beginPath(); g.ellipse(0, 0, w / 2 * k, h * k, 0, Math.PI, TAU); g.fill();
      sideShade(-w / 2, 0, w / 2, h, 0.35);
      g.strokeStyle = 'rgba(40,44,48,0.25)'; g.lineWidth = Math.max(0.4, 0.07 * k);
      g.beginPath(); for (let i = 1; i < 6; i++) { const x = -w / 2 + (w * i) / 6; const yy = h * Math.sqrt(Math.max(0, 1 - (2 * x / w) ** 2)); g.moveTo(x * k, 0); g.lineTo(x * k, -yy * k); } g.stroke();
      g.fillStyle = night ? 'rgba(255,214,150,0.9)' : 'rgba(70,74,80,0.85)';
      g.fillRect(-w * 0.18 * k, -h * 0.55 * k, w * 0.36 * k, h * 0.55 * k);
      if (night && Array.isArray(g.__wins)) g.__wins.push([-w * 0.18 * k, -h * 0.55 * k, w * 0.36 * k, h * 0.55 * k]);
      if (!night) { g.fillStyle = 'rgba(255,224,170,0.25)'; g.fillRect(-w * 0.18 * k, -h * 0.2 * k, w * 0.36 * k, h * 0.2 * k); }
      berm(w * 0.56, h * 0.12);
      break;
    }
    case 'mound': {
      // buried habitat: regolith mound with an entrance tube and a row of windows
      g.fillStyle = cylGrad(g, 0, -h * k, 0, 0, { base: css(ground), light: css(scaleC(ground, 1.35)), dark: css(scaleC(ground, 0.45)), spec: 0 }, light, { amb: 0.45 });
      g.beginPath(); g.moveTo(-w / 2 * k, 0); g.bezierCurveTo(-w * 0.4 * k, -h * 1.2 * k, w * 0.4 * k, -h * 1.2 * k, w / 2 * k, 0); g.closePath(); g.fill();
      sideShade(-w / 2, 0, w / 2, h, 0.3);
      tube(g, k, light, w * 0.32, w * 0.55, h * 0.18, h * 0.32, 'white_paint', { caps: true });
      const n = clamp(num(a.windows, 4), 1, 8);
      for (let i = 0; i < n; i++) winDot(-w * 0.25 + (w * 0.5 * (i + 0.5)) / n, h * 0.42, 0.3, 1.3, 0.8);
      break;
    }
    case 'greenhouse': {
      const R = w / 2;
      berm(R * 1.06, h * 0.08);
      g.fillStyle = night ? 'rgba(150,235,150,0.78)' : 'rgba(118,160,128,0.82)';
      g.beginPath(); g.ellipse(0, -h * 0.06 * k, R * k, h * 0.94 * k, 0, Math.PI, TAU); g.fill();
      g.fillStyle = night ? 'rgba(80,190,90,0.85)' : 'rgba(60,120,64,0.9)'; g.fillRect(-R * 0.8 * k, -h * 0.3 * k, R * 1.6 * k, h * 0.24 * k); // plant beds
      if (night && Array.isArray(g.__wins)) g.__wins.push([-R * 0.6 * k, -h * 0.5 * k, R * 1.2 * k, h * 0.3 * k, 'grow']);
      const gr = g.createRadialGradient(lit * -R * 0.4 * k, -h * 0.7 * k, 0, 0, -h * 0.4 * k, R * 1.1 * k);
      gr.addColorStop(0, 'rgba(255,255,255,0.45)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(0, -h * 0.06 * k, R * k, h * 0.94 * k, 0, Math.PI, TAU); g.fill();
      g.strokeStyle = 'rgba(225,232,236,0.75)'; g.lineWidth = Math.max(0.4, 0.09 * k);
      g.beginPath(); g.ellipse(0, -h * 0.06 * k, R * k, h * 0.94 * k, 0, Math.PI, TAU); for (let i = 1; i < 6; i++) { const x = -R + (2 * R * i) / 6; g.moveTo(x * k, -h * 0.06 * k); g.lineTo(x * k, -(h * 0.06 + h * 0.94 * Math.sqrt(Math.max(0, 1 - (x / R) ** 2))) * k); } g.stroke();
      break;
    }
    case 'dome': {
      // pressurised dome on a ring wall sunk in a berm: geodesic frame, interior city, sky reflection
      const R = w / 2, wall = h * 0.12;
      g.fillStyle = cylGrad(g, -R * k, 0, R * k, 0, 'grey_paint', light, { amb: 0.4 }); g.fillRect(-R * k, -wall * k, 2 * R * k, wall * k);
      const gg = g.createRadialGradient(lit * -R * 0.35 * k, -h * 0.8 * k, 0, 0, -h * 0.35 * k, R * 1.1 * k);
      gg.addColorStop(0, 'rgba(225,236,246,0.95)'); gg.addColorStop(0.45, 'rgba(140,165,190,0.9)'); gg.addColorStop(1, 'rgba(60,76,96,0.92)');
      g.fillStyle = gg; g.beginPath(); g.ellipse(0, -wall * k, R * k, (h - wall) * k, 0, Math.PI, TAU); g.fill();
      g.fillStyle = 'rgba(70,112,70,0.65)'; g.fillRect(-R * 0.86 * k, -(wall + h * 0.14) * k, R * 1.72 * k, h * 0.14 * k);
      for (let i = 0; i < 22; i++) { // interior buildings (lit windows at night)
        const hh = hash(it.id + i + (it.v * 1000 | 0)); const x = (((hh & 255) / 255) * 1.5 - 0.75) * R, y = wall + ((hh >>> 8) & 255) / 255 * h * 0.3, bh = 1 + ((hh >>> 16) & 7) * 0.5;
        g.fillStyle = night ? 'rgba(90,96,110,0.7)' : 'rgba(214,216,212,0.75)'; g.fillRect((x - 0.9) * k, -(y + bh) * k, 1.8 * k, bh * k);
        if (night) winDot(x, y + bh * 0.6, 0.3);
      }
      g.strokeStyle = 'rgba(215,224,232,0.55)'; g.lineWidth = Math.max(0.4, 0.1 * k);
      g.beginPath();
      for (const f of [0.35, 0.68]) g.ellipse(0, -wall * k, R * f * k, (h - wall) * k, 0, Math.PI, TAU);
      for (const f of [0.35, 0.65, 0.88]) { const yy = wall + (h - wall) * f, xx = R * Math.sqrt(1 - f * f); g.moveTo(-xx * k, -yy * k); g.lineTo(xx * k, -yy * k); }
      g.stroke();
      g.strokeStyle = 'rgba(230,236,242,0.7)'; g.lineWidth = Math.max(0.5, 0.14 * k); g.beginPath(); g.ellipse(0, -wall * k, R * k, (h - wall) * k, 0, Math.PI, TAU); g.stroke();
      berm(R * 1.1, wall * 0.8);
      break;
    }
    case 'factory': {
      box(-w / 2, 0, -w * 0.05, h * 0.55, 'grey_paint');
      box(-w * 0.05, 0, w * 0.32, h * 0.42, 'bare_aluminium');
      box(w * 0.32, 0, w / 2, h * 0.7, 'grey_paint');
      roof(-w / 2, -w * 0.05, h * 0.55, h * 0.05, 'white_paint');
      for (const fx of [-0.36, -0.22]) { g.fillStyle = cylGrad(g, (fx * w - 1.4) * k, 0, (fx * w + 1.4) * k, 0, 'grey_paint', light); g.fillRect((fx * w - 1.4) * k, -h * k, 2.8 * k, h * 0.45 * k); }
      sideShade(-w / 2, 0, w / 2, h, 0.3);
      for (let i = 0; i < 6; i++) winDot(-w * 0.45 + i * w * 0.07, h * 0.3, 0.45);
      for (let i = 0; i < 4; i++) winDot(w * 0.36 + (i % 2) * w * 0.06, h * (0.2 + 0.2 * Math.floor(i / 2)), 0.45);
      g.fillStyle = '#55585e'; g.fillRect(-w * 0.53 * k, -Math.max(0.8, h * 0.05 * k), w * 1.06 * k, Math.max(0.8, h * 0.05 * k)); // foundation slab
      break;
    }
    case 'rail': {
      // electromagnetic launcher: a grounded ramp on pylons, climbing from a foundation toward the far end
      const yAt = (u) => lerp(h * 0.03, h, u * u);
      const xAt = (u) => lerp(-w / 2, w / 2, u);
      g.strokeStyle = 'rgba(92,96,104,0.95)'; g.lineWidth = Math.max(0.6, 0.012 * w * k);
      g.beginPath(); for (let i = 1; i <= 16; i++) { const u = i / 16; g.moveTo(xAt(u) * k, 0); g.lineTo(xAt(u) * k, -yAt(u) * k); } g.stroke();
      g.strokeStyle = '#b2b7be'; g.lineWidth = Math.max(0.8, 0.02 * w * k);
      g.beginPath(); g.moveTo(xAt(0) * k, -yAt(0) * k); for (let i = 1; i <= 24; i++) { const u = i / 24; g.lineTo(xAt(u) * k, -yAt(u) * k); } g.stroke();
      g.fillStyle = '#5c6066'; g.fillRect(-w * 0.52 * k, -Math.max(0.8, h * 0.04 * k), w * 0.16 * k, Math.max(0.8, h * 0.04 * k));
      for (let i = 1; i <= 16; i++) { const u = i / 16; g.fillStyle = '#5c6066'; g.fillRect(xAt(u) * k - Math.max(0.6, 0.01 * w * k), -Math.max(0.6, 0.012 * h * k), Math.max(1.2, 0.02 * w * k), Math.max(0.6, 0.012 * h * k)); }
      { g.fillStyle = 'rgba(160,210,255,0.85)'; for (let i = 0; i < 12; i++) { const u = (i + 0.5) / 12; g.fillRect(xAt(u) * k - 0.6, -yAt(u) * k - 1.4, 1.2, 1.2); } }
      break;
    }
    case 'arcology': {
      // stepped tower on a podium, many lit floors
      const tiers = 4;
      box(-w * 0.62, 0, w * 0.62, h * 0.05, 'grey_paint', '#7d838b');
      for (let i = 0; i < tiers; i++) {
        const f = 1 - i * 0.2, y0 = h * 0.05 + (h * 0.95 * i) / tiers, y1 = h * 0.05 + (h * 0.95 * (i + 1)) / tiers;
        box(-w / 2 * f, y0, w / 2 * f, y1, 'grey_paint', '#9aa2ab');
      }
      sideShade(-w * 0.62, 0, w * 0.62, h, 0.3);
      g.fillStyle = 'rgba(200,210,220,0.8)'; g.fillRect(-0.02 * w * k, -(h * 1.08) * k, Math.max(0.6, 0.04 * w * k), h * 0.08 * k);
      const rows = clamp(Math.round(h * k / 3), 4, 60);
      for (let r = 0; r < rows; r++) {
        const y = h * 0.05 + (h * 0.95 * (r + 0.5)) / rows, f = 1 - Math.floor((r / rows) * tiers) * 0.2;
        for (let c = 0; c < 6; c++) { if ((hash(it.id + r * 7 + c) & 3) === 0) continue; winDot((-0.4 + c * 0.16) * w * f, y, Math.max(0.15, 0.4 / Math.max(0.05, k))); }
      }
      break;
    }
    case 'mega': {
      // colossal arch on the horizon: two tapered pylons on footings joined by a truss arch (no line into the sky)
      const pyl = (sg) => {
        g.fillStyle = cylGrad(g, sg * w * 0.5 * k, 0, sg * w * 0.26 * k, 0, 'grey_paint', light, { amb: 0.4, tint: '#8a929c' });
        g.beginPath(); g.moveTo(sg * w / 2 * k, 0); g.lineTo(sg * w * 0.32 * k, -h * k); g.lineTo(sg * w * 0.26 * k, -h * k); g.lineTo(sg * w * 0.36 * k, 0); g.closePath(); g.fill();
        g.fillStyle = '#5a5f66'; g.fillRect(sg > 0 ? w * 0.33 * k : -w * 0.53 * k, -h * 0.03 * k, w * 0.2 * k, h * 0.03 * k); // footing
      };
      pyl(-1); pyl(1);
      g.strokeStyle = 'rgba(150,158,168,0.95)'; g.lineWidth = Math.max(0.8, w * 0.025 * k);
      g.beginPath(); g.moveTo(-w * 0.29 * k, -h * k); g.quadraticCurveTo(0, -h * 1.32 * k, w * 0.29 * k, -h * k); g.stroke();
      g.strokeStyle = 'rgba(110,116,126,0.8)'; g.lineWidth = Math.max(0.5, w * 0.008 * k);
      g.beginPath(); g.moveTo(-w * 0.27 * k, -h * 0.94 * k); g.quadraticCurveTo(0, -h * 1.22 * k, w * 0.27 * k, -h * 0.94 * k); g.stroke();
      for (let i = 0; i < 10; i++) winDot(lerp(-0.42, -0.3, i / 10) * w, h * (i / 10), Math.max(0.3, 1 / Math.max(0.02, k)));
      for (let i = 0; i < 10; i++) winDot(lerp(0.42, 0.3, i / 10) * w, h * (i / 10), Math.max(0.3, 1 / Math.max(0.02, k)));
      break;
    }
    case 'pad': { // a second landing pad: flat sintered disc with a ring (drawn on the ground pass)
      break;
    }
    default: box(-w / 2, 0, w / 2, h, 'white_paint');
  }
}

const ITEM_SPRITE_MAX = 600;
/**
 * Draw one item at screen (x, yBase) with scale s px/m: cached sprite per (id, kind, size bucket, light, night,
 * haze bucket). Aerial haze (atmospheric worlds, far structures) is baked into the sprite over the item's own pixels.
 */
function drawItem(ctx, it, x, y, s, light, world, night, haze, hazeC) {
  const wPx = it.w * s, hPx = it.h * s;
  if (hPx < 0.6 && wPx < 0.6) return;
  const extra = upOf(it.kind) + 0.08;
  const hz = Math.round(clamp(haze, 0, 0.9) * 20) / 20;
  if (hPx < 2.5) { // speck: flat lit block
    ctx.fillStyle = css(mixC(rgbOf(it.kind === 'solar' ? '#26335e' : '#c9c8c2'), hazeC, hz));
    ctx.fillRect(x - wPx / 2, y - Math.max(0.8, hPx), Math.max(0.8, wPx), Math.max(0.8, hPx));
    return;
  }
  const dpr = devScale(ctx);
  const sb = Math.pow(2, Math.round(Math.log2(s * dpr) * 4) / 4);
  const SW = Math.ceil(it.w * sb * 1.3) + 6, SH = Math.ceil(it.h * sb * extra) + 6;
  const lb = lightBucket(light);
  let spr = null;
  if (SW <= ITEM_SPRITE_MAX * 2 && SH <= ITEM_SPRITE_MAX * 2) {
    const key = `base2|${it.id}|${it.kind}|${Math.round(it.w * 10)}x${Math.round(it.h * 10)}|${sb.toFixed(3)}|${lb}|${world}|${night ? 1 : 0}|${hz}|${it.kind === 'dome' || it.kind === 'arcology' ? Math.round(it.v * 50) : 0}`;
    spr = cached(key, SW, SH, (g) => {
      if (night) g.__wins = [];
      g.save(); g.translate(SW / 2, SH - 3); paintBaseItem(g, it, sb, light, world, night); g.restore();
      if (night) { // the sun has set: the hull falls dark, only the windows and doors glow
        g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(4,6,14,0.7)'; g.fillRect(0, 0, SW, SH); g.globalCompositeOperation = 'source-over';
        g.save(); g.translate(SW / 2, SH - 3);
        for (const [X, Y, Wp, Hp, kind] of g.__wins) {
          const col = kind === 'grow' ? [190, 120, 255] : [255, 206, 130];
          const cx = X + Wp / 2, cy = Y + Hp / 2, rr = Math.max(Wp, Hp) * (kind === 'grow' ? 0.9 : 1.8) + 1.5;
          const gl = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
          gl.addColorStop(0, css(col, kind === 'grow' ? 0.35 : 0.4)); gl.addColorStop(1, css(col, 0));
          g.fillStyle = gl; g.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
          if (kind !== 'grow') { g.fillStyle = css(col, 0.95); g.fillRect(X, Y, Wp, Hp); }
        }
        g.restore();
        g.__wins = null;
      }
      if (hz > 0) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = css(hazeC, hz); g.fillRect(0, 0, SW, SH); g.globalCompositeOperation = 'source-over'; }
    });
  }
  ctx.save();
  if (spr) {
    const f = s / sb;
    ctx.drawImage(spr, x - (SW / 2) * f, y - (SH - 3) * f, SW * f, SH * f);
  } else {
    ctx.translate(x, y);
    paintBaseItem(ctx, it, s, light, world, night);
  }
  ctx.restore();
}

/** Shadow geometry shared by every base object (and matching textures.drawGroundShadow): run to the side away from the sun. */
function shadowRun(light) {
  const elev = clamp(-num(light?.ay, -0.6), 0.12, 0.99);
  const cot = Math.sqrt(1 - elev * elev) / elev;
  return { dir: -Math.sign(num(light?.ax, -1)) || 1, k: cot * 0.5 };
}
/**
 * Cast shadow of an upright object on the ground at screen (x, y): footprint wPx wide (depth thickness tPx) swept
 * away from the sun by its height (hPx). One union path, one alpha: no darker overlaps.
 */
function castShadow(ctx, x, y, wPx, tPx, hPx, light, col, alpha, taper = 0.75) {
  if (alpha <= 0.01 || wPx < 0.8) return;
  const sr = shadowRun(light);
  const run = hPx * sr.k * sr.dir, dy = Math.abs(run) * 0.22;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = col;
  ctx.beginPath();
  const n = Math.max(2, Math.min(10, Math.ceil(Math.abs(run) / Math.max(2, tPx))));
  for (let i = 0; i <= n; i++) {
    const u = i / n, f = lerp(1, taper, u);
    ctx.moveTo(x + run * u + wPx * 0.5 * f, y + dy * u);
    ctx.ellipse(x + run * u, y + dy * u, wPx * 0.5 * f, Math.max(0.6, tPx * 0.5 * f), 0, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

/** Ground strip along a polyline of [x, d] ground points (roads, cables, tracks): width wM metres. */
function groundStrip(ctx, proj, pts, wM, fill, { steps = 8 } = {}) {
  if (!pts || pts.length < 2) return;
  const P = [];
  if (pts.length === 3) { const a = { x: pts[0][0], d: pts[0][1] }, c = { x: pts[1][0], d: pts[1][1] }, b = { x: pts[2][0], d: pts[2][1] }; for (let i = 0; i <= steps; i++) { const p = pathPoint(a, c, b, i / steps); P.push([p.x, p.d]); } }
  else P.push(...pts);
  const L = [], Rr = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), nd = b[0] - a[0]; const nl = Math.hypot(nx, nd) || 1; nx /= nl; nd /= nl;
    L.push(proj.project(P[i][0] + nx * wM / 2, P[i][1] + nd * wM / 2)); Rr.push(proj.project(P[i][0] - nx * wM / 2, P[i][1] - nd * wM / 2));
  }
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.moveTo(L[0].x, L[0].y); for (let i = 1; i < L.length; i++) ctx.lineTo(L[i].x, L[i].y); for (let i = Rr.length - 1; i >= 0; i--) ctx.lineTo(Rr[i].x, Rr[i].y); ctx.closePath(); ctx.fill();
}

/** A 3-point ground path shifted sideways by off metres (wheel ruts). */
function offsetPath(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let nx = -(b[1] - a[1]), nd = b[0] - a[0]; const nl = Math.hypot(nx, nd) || 1; nx /= nl; nd /= nl;
    return [p[0] + nx * off, p[1] + nd * off];
  });
}

/** Night: the sun has set: sky and ground fall to ~25 % (the base's own lights do the rest). */
function nightVeil(ctx, proj, world, light = SUN) {
  const W = proj.W, H = proj.H;
  ctx.save();
  ctx.fillStyle = AIRLESS.has(world) ? 'rgba(1,2,6,0.76)' : world === 'titan' ? 'rgba(10,6,2,0.74)' : 'rgba(5,5,14,0.74)';
  ctx.fillRect(-40, -40, W + 80, H + 80);
  if (!AIRLESS.has(world)) { ctx.restore(); return; }
  // blot out the sun disc (drawSky puts it at (0.5 + ax·0.62, 0.42 + ay·0.5) of the view)
  const sx = W * (0.5 + num(light?.ax, SUN.ax) * 0.62), sy = H * (0.42 + num(light?.ay, SUN.ay) * 0.5);
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 34);
  g.addColorStop(0, 'rgba(1,2,6,0.95)'); g.addColorStop(0.6, 'rgba(1,2,6,0.85)'); g.addColorStop(1, 'rgba(1,2,6,0)');
  ctx.fillStyle = g; ctx.fillRect(sx - 40, sy - 40, 80, 80);
  ctx.restore();
}

/** Landing pad (ground pass): berm, sintered disc, blast scorch, marking ring well outside the footpads, edge lights. */
function drawPad(ctx, proj, pad, { ground, t, reduce, night, atmo, hazeC }) {
  const R = pad.w / 2;
  const c = proj.project(pad.x, pad.d), back = proj.project(pad.x, pad.d + R), front = proj.project(pad.x, pad.d - R);
  const rx = R * c.s, ryB = Math.max(0.5, c.y - back.y), ryF = Math.max(0.5, front.y - c.y);
  const ell = (k, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(c.x, c.y, rx * k, ryB * k, 0, Math.PI, TAU); ctx.ellipse(c.x, c.y, rx * k, ryF * k, 0, 0, Math.PI); ctx.fill(); };
  const hz = atmo ? 0.08 : 0;
  ell(1.1, css(mixC(scaleC(ground, 0.62), hazeC, hz), 0.85));
  ell(1, css(mixC([98, 99, 102], hazeC, hz), 0.95));
  const sc = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rx * 0.7);
  sc.addColorStop(0, 'rgba(30,28,26,0.55)'); sc.addColorStop(1, 'rgba(30,28,26,0)');
  ctx.save(); ctx.translate(c.x, c.y); ctx.scale(1, (ryB + ryF) / 2 / rx); ctx.translate(-c.x, -c.y); ctx.fillStyle = sc; ctx.beginPath(); ctx.arc(c.x, c.y, rx * 0.7, 0, TAU); ctx.fill(); ctx.restore();
  // marking ring at 0.84 R and short ticks at the edge
  ctx.strokeStyle = night ? 'rgba(210,200,170,0.4)' : 'rgba(232,226,206,0.7)'; ctx.lineWidth = Math.max(0.8, 0.22 * c.s);
  ctx.beginPath(); ctx.ellipse(c.x, c.y, rx * 0.84, ryB * 0.84, 0, Math.PI, TAU); ctx.ellipse(c.x, c.y, rx * 0.84, ryF * 0.84, 0, 0, Math.PI); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU, sy = Math.sin(a) > 0 ? ryF : ryB; ctx.moveTo(c.x + Math.cos(a) * rx * 0.9, c.y + Math.sin(a) * sy * 0.9); ctx.lineTo(c.x + Math.cos(a) * rx * 0.97, c.y + Math.sin(a) * sy * 0.97); }
  ctx.stroke();
  // edge lights evenly on the rim; small in daylight, a wide glow at night
  const n = 14;
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * TAU;
    const on = reduce ? 0.85 : 0.4 + 0.6 * Math.max(0, Math.cos(a - t * 3.2)) ** 4;
    const sy = Math.sin(a) > 0 ? ryF : ryB;
    const px = c.x + Math.cos(a) * rx * 0.995, py = c.y + Math.sin(a) * sy * 0.995;
    const sc2 = proj.project(pad.x + Math.cos(a) * R, pad.d - Math.sin(a) * R).s;
    const r = clamp(0.09 * sc2, 0.7, 3);
    ctx.fillStyle = `rgba(255,196,100,${(0.95 * on).toFixed(3)})`; ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
    const hr = r * (night ? 5 : 1.8), ha = night ? 0.22 : 0.1;
    const gl = ctx.createRadialGradient(px, py, 0, px, py, hr);
    gl.addColorStop(0, `rgba(255,170,70,${(ha * on).toFixed(3)})`); gl.addColorStop(1, 'rgba(255,170,70,0)');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(px, py, hr, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

/** A flat secondary pad (tier ≥ 3) on the ground pass. */
function drawFlatPad(ctx, proj, it, ground) {
  const R = it.w / 2;
  const c = proj.project(it.x, it.d), back = proj.project(it.x, it.d + R), front = proj.project(it.x, it.d - R);
  ctx.fillStyle = css(scaleC(ground, 0.65), 0.8);
  ctx.beginPath(); ctx.ellipse(c.x, c.y, R * c.s * 1.08, Math.max(0.5, c.y - back.y) * 1.08, 0, Math.PI, TAU); ctx.ellipse(c.x, c.y, R * c.s * 1.08, Math.max(0.5, front.y - c.y) * 1.08, 0, 0, Math.PI); ctx.fill();
  ctx.fillStyle = 'rgba(96,98,102,0.9)';
  ctx.beginPath(); ctx.ellipse(c.x, c.y, R * c.s, Math.max(0.5, c.y - back.y), 0, Math.PI, TAU); ctx.ellipse(c.x, c.y, R * c.s, Math.max(0.5, front.y - c.y), 0, 0, Math.PI); ctx.fill();
  ctx.strokeStyle = 'rgba(232,226,206,0.5)'; ctx.lineWidth = Math.max(0.5, 0.2 * c.s);
  ctx.beginPath(); ctx.ellipse(c.x, c.y, R * c.s * 0.8, Math.max(0.4, c.y - back.y) * 0.8, 0, Math.PI, TAU); ctx.ellipse(c.x, c.y, R * c.s * 0.8, Math.max(0.4, front.y - c.y) * 0.8, 0, 0, Math.PI); ctx.stroke();
}

/**
 * Every upright thing on the base as a depth-sorted draw list (structures, floodlight masts, vehicles, the crate,
 * a delivered module, the crew): [{d, draw()}], drawn far → near so nothing nearer is ever covered.
 */
function baseEntries(ctx, view, layout, o) {
  const { proj, light, t, world, night, reduce } = o;
  const atmo = !AIRLESS.has(world) && !!bodyLook(world).sky;
  const hazeC = o.hazeC;
  const shCol = atmo ? (world === 'titan' ? 'rgb(30,20,8)' : 'rgb(40,22,14)') : 'rgb(10,10,12)';
  const shA = atmo ? (world === 'titan' ? 0.3 : 0.42) : 0.7;
  const hazeOf = (Z) => (atmo ? clamp(1 - Math.exp(-Z / (world === 'titan' ? 1100 : 5200)), 0, world === 'titan' ? 0.78 : 0.7) : clamp((Z - 2000) / 40000, 0, 0.12));
  const E = [];
  const L = L3(light);
  if (o.items !== false) for (const it of layout.items) {
    if (it.kind === 'pad') continue;
    const p = proj.project(it.x, it.d);
    const wPx = it.w * p.s;
    if (p.x + wPx < -40 || p.x - wPx > proj.W + 40 || p.y < -10) continue;
    const haze = hazeOf(p.Z);
    E.push({ d: it.d, draw() {
      if (it.h * p.s > 1.5) {
        const back = proj.project(it.x, it.d + depthOf(it) / 2), front = proj.project(it.x, it.d - depthOf(it) / 2);
        const solid = it.kind === 'solar' || it.kind === 'tower' || it.kind === 'mast' || it.kind === 'rail' ? 0.55 : 1;
        castShadow(ctx, p.x, p.y, wPx * (it.kind === 'mega' ? 0.5 : 0.96), Math.max(1, front.y - back.y), it.h * p.s * (it.kind === 'rail' ? 0.25 : 1), light, shCol, shA * solid * (1 - haze * 0.8));
      }
      drawItem(ctx, it, p.x, p.y, p.s, light, world, night, haze, hazeC);
      // beacons on tall structures (opacity blink only)
      if ((it.kind === 'tower' || it.kind === 'arcology' || it.kind === 'mega' || it.kind === 'rail' || it.kind === 'mast') && it.h * p.s > 6) {
        const on = reduce ? 0.7 : (Math.sin(t * 3 + it.v * 9) > 0.6 ? 1 : 0.15);
        const by = p.y - it.h * p.s * (it.kind === 'rail' ? 1 : it.kind === 'mega' ? 1.16 : 1.02);
        const bx = it.kind === 'rail' ? p.x + it.w * p.s / 2 : p.x;
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,70,60,${on.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(bx, by, Math.max(1, Math.min(2.5, 0.4 * p.s)), 0, TAU); ctx.fill();
        if (night) { const gl = ctx.createRadialGradient(bx, by, 0, bx, by, 9); gl.addColorStop(0, `rgba(255,60,50,${(0.35 * on).toFixed(3)})`); gl.addColorStop(1, 'rgba(255,60,50,0)'); ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(bx, by, 9, 0, TAU); ctx.fill(); }
        ctx.restore();
      }
    } });
  }
  // pad floodlight masts: a pole and a lamp head; at night a cone and a pool of light on the pad
  if (o.items !== false) for (const lm of layout.lights || []) {
    const p = proj.project(lm.x, lm.d);
    E.push({ d: lm.d, draw() {
      const s = p.s, top = p.y - lm.h * s;
      castShadow(ctx, p.x, p.y, 0.5 * s, 0.3 * s, lm.h * s, light, shCol, shA * 0.6, 0.9);
      ctx.fillStyle = cylGrad(ctx, p.x - 0.12 * s, 0, p.x + 0.12 * s, 0, 'bare_aluminium', light); ctx.fillRect(p.x - Math.max(0.5, 0.1 * s), top, Math.max(1, 0.2 * s), lm.h * s);
      ctx.fillStyle = '#5c6066'; ctx.fillRect(p.x - 0.5 * s, p.y - 0.2 * s, s, 0.2 * s);
      const dir = -Math.sign(lm.x) || 1;
      ctx.fillStyle = '#3c4046'; ctx.fillRect(p.x + (dir > 0 ? 0 : -0.9 * s), top - 0.3 * s, 0.9 * s, 0.5 * s);
      const lx = p.x + dir * 0.6 * s, ly = top;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = night ? 'rgba(255,240,205,0.95)' : 'rgba(255,240,205,0.35)'; ctx.fillRect(lx - 0.35 * s, ly - 0.05 * s, 0.7 * s, 0.25 * s);
      if (night) {
        const c = proj.project(0, 0);
        const cg = ctx.createLinearGradient(lx, ly, c.x, c.y);
        cg.addColorStop(0, 'rgba(255,236,190,0.22)'); cg.addColorStop(1, 'rgba(255,236,190,0)');
        ctx.fillStyle = cg; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(c.x - dir * 2 * c.s, c.y + 1.5 * c.s); ctx.lineTo(c.x + dir * 3 * c.s, c.y - 2.5 * c.s); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    } });
  }
  if (o.vehicles) vehicleEntries(ctx, layout, E, { ...o, ...o.vehicles, shCol, shA, hazeOf });
  E.sort((a, b) => b.d - a.d);
  return E;
}

/**
 * Surface base on the landing terrain (MISSIONS-V2 §7.3): night veil, the ground pass (approach road, roads,
 * cables, tunnels, the landing pad and its lights), then every upright object depth-sorted far → near with one
 * shadow direction, aerial haze by distance on atmospheric worlds, window and flood lights at night.
 * With o.vehicles ({since, parked, reduce, landerH, landerW, crewed}) the vehicles, the crate and the crew join the
 * same sorted pass (the composer's path); without it only the structures are drawn. Call after drawTerrain and
 * before the lander. proj = groundProjection(...).
 */
export function drawBase(ctx, view, layout, { proj, light = SUN, t = 0, reduce = false, world = 'moon', night = false, alpha = 1, vehicles = null } = {}) {
  if (!ctx || !layout || !proj || alpha <= 0.01) return;
  const atmo = !AIRLESS.has(world) && !!bodyLook(world).sky;
  const hazeC = scaleC(rgbOf(atmo ? cssHex(skyColors(world, 0).horizon) : '#000000'), night ? 0.24 : 1);
  const ground = groundTone(world);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (night) nightVeil(ctx, proj, world, light);
  const dark = night ? 0.45 : 1;
  // ground pass: approach road from the foreground, roads to the buildings, power cables, tunnels
  // compacted strips are only a faint darkening; the wheel ruts carry the shape
  const ruts = (pts, wM, steps) => { for (const off of [-wM * 0.32, wM * 0.32]) groundStrip(ctx, proj, offsetPath(pts, off), 0.45, 'rgba(0,0,0,0.16)', { steps }); };
  if (layout.approach) { groundStrip(ctx, proj, layout.approach, 3.6, 'rgba(0,0,0,0.09)', { steps: 14 }); ruts(layout.approach, 3.6, 14); }
  for (const r of layout.roads || []) { groundStrip(ctx, proj, r, 3, 'rgba(0,0,0,0.08)'); ruts(r, 3, 8); }
  for (const c of layout.cables || []) groundStrip(ctx, proj, c, 0.18, 'rgba(30,30,34,0.75)');
  for (const tn of layout.tunnels || []) {
    groundStrip(ctx, proj, tn, 2.6, css(scaleC(ground, 0.95 * dark), 0.95));
    groundStrip(ctx, proj, tn, 1.2, css(scaleC(ground, 1.18 * dark), 0.6));
  }
  for (const it of layout.items) if (it.kind === 'pad') drawFlatPad(ctx, proj, it, scaleC(ground, dark));
  if (layout.pad) {
    drawPad(ctx, proj, layout.pad, { ground: scaleC(ground, dark), t, reduce, night, atmo, hazeC });
    if (night) { // floodlight pool on the pad
      const c = proj.project(0, 0), R = layout.pad.w / 2;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.translate(c.x, c.y); ctx.scale(1, 0.22);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * c.s);
      g.addColorStop(0, 'rgba(255,228,180,0.32)'); g.addColorStop(0.7, 'rgba(255,228,180,0.12)'); g.addColorStop(1, 'rgba(255,228,180,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * c.s, 0, TAU); ctx.fill();
      ctx.restore();
    }
  }
  const veh = vehicles ? { landerH: 6, landerW: layout.landerW, crewed: false, ...vehicles, reduce: vehicles.reduce ?? reduce } : null;
  for (const e of baseEntries(ctx, view, layout, { proj, light, t, world, night, reduce, hazeC, vehicles: veh })) e.draw();
  ctx.restore();
}
function cssHex(c) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(c));
  if (!m) return String(c).startsWith('#') ? c : '#000000';
  return '#' + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, '0')).join('');
}

/** Bed / hook height (fraction of the vehicle height) and forward offset (fraction of its length) where a crate rides. */
const CARRY = { truck: [0.41, -0.11], buggy: [0.36, -0.2], cabin: [1.0, -0.1], crane: [0.42, 0.62], excavator: [0.75, -0.1] };

/** One surface vehicle in local metres (origin = ground under its centre, y up), facing +x. */
function paintVehicleKind(g, v, k, light, t, moving, night = false) {
  const a = v.art || {};
  const len = num(a.len, 3.5), h = num(a.h, 1.8);
  const col = a.color || '#c9c3b5';
  const tint = { base: col, light: css(scaleC(rgbOf(col), 1.3)), dark: css(scaleC(rgbOf(col), 0.4)), spec: 0.15 };
  const wheel = (x, r) => {
    g.fillStyle = '#2a2b2e'; g.beginPath(); g.arc(x * k, -r * k, r * k, 0, TAU); g.fill();
    g.fillStyle = '#8f949a'; g.beginPath(); g.arc(x * k, -r * k, r * 0.45 * k, 0, TAU); g.fill();
    if (r * k > 2.5) { const sp = moving ? t * 6 : 0; g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 0.6; g.beginPath(); for (let i = 0; i < 3; i++) { const an = sp + i * 2.09; g.moveTo(x * k, -r * k); g.lineTo(x * k + Math.cos(an) * r * k, -r * k + Math.sin(an) * r * k); } g.stroke(); }
  };
  const body = (x0, y0, x1, y1) => { g.fillStyle = cylGrad(g, 0, -y1 * k, 0, -y0 * k, tint, light, { amb: 0.45 }); g.fillRect(x0 * k, -y1 * k, (x1 - x0) * k, (y1 - y0) * k); };
  switch (a.kind || v.kind) {
    case 'drone': {
      body(-len * 0.25, 0, len * 0.25, h * 0.5);
      g.fillStyle = 'rgba(200,205,210,0.4)'; for (const sx of [-1, 1]) { g.beginPath(); g.ellipse(sx * len * 0.42 * k, -h * 0.6 * k, len * 0.22 * k, Math.max(0.4, 0.08 * k), 0, 0, TAU); g.fill(); }
      break;
    }
    case 'hopper': {
      body(-len * 0.3, h * 0.35, len * 0.3, h);
      g.strokeStyle = '#9ca1a8'; g.lineWidth = Math.max(0.5, 0.12 * k);
      g.beginPath(); for (const sx of [-1, 1]) { g.moveTo(sx * len * 0.25 * k, -h * 0.35 * k); g.lineTo(sx * len * 0.5 * k, 0); } g.stroke();
      break;
    }
    case 'crane': {
      const r = h * 0.09;
      body(-len / 2, r * 1.4, len / 2, r * 3);
      body(-len * 0.42, r * 3, -len * 0.12, h * 0.36); // cab
      g.fillStyle = 'rgba(50,80,110,0.9)'; g.fillRect(-len * 0.2 * k, -h * 0.33 * k, len * 0.06 * k, h * 0.08 * k);
      for (const x of [-len * 0.38, 0, len * 0.38]) wheel(x, r);
      g.strokeStyle = col; g.lineWidth = Math.max(0.7, 0.28 * k); g.lineCap = 'round';
      g.beginPath(); g.moveTo(-len * 0.2 * k, -r * 3 * k); g.lineTo(len * 0.45 * k, -h * 0.92 * k); g.lineTo(len * 0.62 * k, -h * 0.86 * k); g.stroke();
      g.strokeStyle = 'rgba(40,40,40,0.7)'; g.lineWidth = Math.max(0.4, 0.05 * k);
      g.beginPath(); g.moveTo(len * 0.62 * k, -h * 0.86 * k); g.lineTo(len * 0.62 * k, -h * 0.5 * k); g.stroke();
      g.fillStyle = '#3a3b3e'; g.fillRect((len * 0.62 - 0.15) * k, -h * 0.52 * k, 0.3 * k, 0.25 * k); // hook block
      break;
    }
    case 'excavator': {
      const r = h * 0.2;
      body(-len / 2, r * 1.2, len * 0.25, h * 0.75);
      g.fillStyle = 'rgba(50,80,110,0.9)'; g.fillRect(-len * 0.1 * k, -h * 0.7 * k, len * 0.14 * k, h * 0.2 * k);
      for (const x of [-len * 0.32, len * 0.1]) wheel(x, r);
      g.fillStyle = css(scaleC(rgbOf(col), 0.8)); g.beginPath(); g.moveTo(len * 0.25 * k, -h * 0.6 * k); g.lineTo(len * 0.55 * k, -h * 0.25 * k); g.lineTo(len * 0.5 * k, 0); g.lineTo(len * 0.3 * k, -h * 0.1 * k); g.closePath(); g.fill();
      break;
    }
    case 'cabin': {
      const r = h * 0.15;
      g.fillStyle = cylGrad(g, 0, -h * k, 0, -r * 1.6 * k, tint, light, { amb: 0.45 });
      g.beginPath(); g.roundRect ? g.roundRect(-len / 2 * k, -h * k, len * k, (h - r * 1.6) * k, h * 0.3 * k) : g.rect(-len / 2 * k, -h * k, len * k, (h - r * 1.6) * k); g.fill();
      g.fillStyle = 'rgba(50,80,110,0.9)'; g.fillRect(len * 0.28 * k, -h * 0.9 * k, len * 0.18 * k, h * 0.3 * k);
      g.fillStyle = night ? 'rgba(255,214,150,0.95)' : 'rgba(40,52,66,0.8)'; for (const fx of [-0.3, -0.12, 0.06]) g.fillRect(len * fx * k, -h * 0.75 * k, Math.max(0.8, len * 0.08 * k), Math.max(0.8, h * 0.14 * k));
      g.fillStyle = '#9ca1a8'; g.fillRect(-len * 0.52 * k, -h * 0.7 * k, len * 0.04 * k, h * 0.35 * k); // suitport hatch
      for (const x of [-len * 0.36, 0, len * 0.36]) wheel(x, r);
      break;
    }
    case 'truck': {
      const r = h * 0.17;
      body(-len / 2, r * 1.5, len * 0.28, r * 2.4); // flatbed
      g.fillStyle = cylGrad(g, 0, -h * k, 0, -r * 1.5 * k, tint, light, { amb: 0.45 }); g.fillRect(len * 0.28 * k, -h * k, len * 0.22 * k, (h - r * 1.5) * k);
      g.fillStyle = 'rgba(50,80,110,0.9)'; g.fillRect(len * 0.38 * k, -h * 0.92 * k, len * 0.1 * k, h * 0.25 * k);
      for (const x of [-len * 0.38, -len * 0.12, len * 0.36]) wheel(x, r);
      break;
    }
    case 'crawler': {
      body(-len / 2, h * 0.25, len / 2, h * 0.8);
      g.fillStyle = '#3a3b3e'; g.beginPath(); g.roundRect ? g.roundRect(-len / 2 * k, -h * 0.28 * k, len * k, h * 0.28 * k, h * 0.14 * k) : g.rect(-len / 2 * k, -h * 0.28 * k, len * k, h * 0.28 * k); g.fill();
      g.fillStyle = 'rgba(255,214,150,0.75)'; for (let i = 0; i < 8; i++) g.fillRect((-len * 0.4 + i * len * 0.11) * k, -h * 0.6 * k, Math.max(0.8, 0.6 * k), Math.max(0.8, 0.6 * k));
      body(-len * 0.1, h * 0.8, len * 0.2, h);
      break;
    }
    default: { // open buggy (LRV-like)
      const r = h * 0.22;
      body(-len / 2, r * 1.2, len / 2, r * 1.6);
      for (const x of [-len * 0.34, len * 0.34]) wheel(x, r);
      g.strokeStyle = '#9ca1a8'; g.lineWidth = Math.max(0.4, 0.06 * k);
      g.beginPath(); g.moveTo(-len * 0.1 * k, -r * 1.6 * k); g.lineTo(-len * 0.1 * k, -h * k); g.stroke();
      g.fillStyle = '#e6e3da'; g.beginPath(); g.ellipse(-len * 0.1 * k, -h * k, Math.max(0.6, 0.35 * k), Math.max(0.4, 0.14 * k), 0, 0, TAU); g.fill();
      g.fillStyle = cylGrad(g, 0, -h * 0.75 * k, 0, -r * 1.6 * k, 'white_paint', light); g.fillRect(-len * 0.35 * k, -h * 0.7 * k, len * 0.18 * k, (h * 0.7 - r * 1.6) * k);
    }
  }
  // headlight
  if (a.kind !== 'crawler') { g.fillStyle = 'rgba(255,244,210,0.95)'; g.beginPath(); g.arc(len / 2 * k, -h * 0.42 * k, Math.max(0.6, 0.12 * k), 0, TAU); g.fill(); }
}

/** A vehicle painted once into a darkened sprite for night scenes (wheels still: nobody sees them spin in the dark). */
function nightVehicleSprite(v, s, light, dpr) {
  const sb = Math.pow(2, Math.round(Math.log2(s * dpr) * 4) / 4);
  const len = num(v.art?.len, 3.5), h = num(v.art?.h, 1.8);
  const W = Math.ceil(len * sb * 1.4) + 6, H = Math.ceil(h * sb * 1.25) + 6;
  if (W > 1200 || H > 1200) return null;
  const c = cached(`bveh-n|${v.id}|${v.kind}|${sb.toFixed(3)}|${lightBucket(light)}`, W, H, (g) => {
    g.save(); g.translate(W / 2, H - 3); paintVehicleKind(g, v, sb, light, 0, false, true); g.restore();
    g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(4,6,14,0.66)'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  });
  return c ? { c, sb } : null;
}

/** Vehicles, the crate, a delivered module and the crew as sorted entries (see baseEntries). */
function vehicleEntries(ctx, layout, E, o) {
  const { proj, t, light, world, night, shCol, shA, hazeOf } = o;
  const since = o.since ?? null;
  const parked = !!o.parked || !!o.reduce;
  const landerH = num(o.landerH, 6), landerW = num(o.landerW, layout.landerW || 4);
  const states = vehicleStates(layout, { since, parked });
  const all = [...(layout.vehicles || []), ...(layout.payloadVehicles || [])];
  const airless = AIRLESS.has(world);
  const dust = rgbOf(bodyLook(world).dust || '#a8a49b');
  states.forEach((st, i) => {
    const v = all[i];
    if (!v || st.hidden) return;
    const p = proj.project(st.x, st.d);
    if (p.x < -80 || p.x > proj.W + 80) return;
    const s = p.s;
    if (v.len * s < 0.8) return;
    const haze = hazeOf(p.Z);
    E.push({ d: st.d, veh: true, draw() {
      const y = p.y - st.hover * s;
      castShadow(ctx, p.x, p.y + 0.3, v.len * s * 0.95, Math.max(1, v.len * s * 0.09), (v.kind === 'drone' ? 0.4 : v.h * 0.7) * s, light, shCol, shA * (st.hover > 1 ? 0.5 : 1) * (1 - haze), 0.85);
      // dust behind moving wheels
      if (st.moving && !o.reduce && st.hover < 0.5) {
        for (let j = 0; j < 4; j++) {
          const ph = (t * 2.2 + j * 0.25 + i * 0.13) % 1;
          const bx = p.x - st.facing * v.len * s * (0.5 + ph * 0.9);
          const by = p.y - (airless ? Math.sin(ph * Math.PI) * v.len * 0.35 * s : (0.15 + ph * 0.35) * v.len * s);
          ctx.fillStyle = css(dust, (airless ? 0.5 : 0.28) * (1 - ph));
          ctx.beginPath(); ctx.arc(bx, by, Math.max(0.5, (airless ? 0.12 : 0.25 + ph * 0.5) * v.len * s * 0.35), 0, TAU); ctx.fill();
        }
      }
      if (night && v.kind !== 'crawler') { // headlight pool ahead on the ground
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const gx = p.x + st.facing * v.len * s * 1.1, gy = p.y + 0.2 * s;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, v.len * s * 0.7);
        g.addColorStop(0, 'rgba(255,244,210,0.3)'); g.addColorStop(1, 'rgba(255,244,210,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(gx, gy, v.len * s * 0.7, v.len * s * 0.15, 0, 0, TAU); ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.translate(p.x, y);
      if (st.facing < 0) ctx.scale(-1, 1);
      const bounce = st.moving && !o.reduce ? Math.sin(t * 17 + i) * 0.04 * s : 0;
      ctx.translate(0, bounce);
      const lv = st.facing < 0 ? { ax: -num(light.ax, SUN.ax), ay: num(light.ay, SUN.ay) } : light;
      // night: a darkened sprite (the sun has set), the headlight stays bright
      const spr = night ? nightVehicleSprite(v, s, lv, devScale(ctx)) : null;
      if (spr) { const f = s / spr.sb; ctx.drawImage(spr.c, -(spr.c.width / 2) * f, -(spr.c.height - 3) * f, spr.c.width * f, spr.c.height * f); }
      else paintVehicleKind(ctx, v, s, lv, t, st.moving, night);
      if (night) { ctx.fillStyle = 'rgba(255,244,210,0.95)'; ctx.beginPath(); ctx.arc(v.len / 2 * s, -v.h * 0.42 * s, Math.max(0.8, 0.14 * s), 0, TAU); ctx.fill(); }
      if (haze > 0.05) { ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = css(o.hazeC || [0, 0, 0], haze); ctx.fillRect(-v.len * s, -v.h * s * 1.2, v.len * s * 2, v.h * s * 1.3); }
      ctx.restore();
    } });
  });
  const pk = layout.payload?.kind;
  if (since == null && !parked) return;
  const sinceU = parked ? 99 : since;
  // a delivered base module (no vehicles to carry it): lowered beside the lander on the davit, then skidded clear
  // of the lander's footprint, where it becomes a habitat with its shadow
  if (pk === 'base_module' && !layout.vehicles?.length && layout.moduleSpot) {
    const ms = layout.moduleSpot;
    const drop = { x: ms.side * (landerW / 2 + ms.w * 0.25 + 0.6), d: Math.min(ms.d, 1.5) };
    const lowerK = clamp(sinceU / 1.8, 0, 1), slideK = clamp((sinceU - 2.2) / 3, 0, 1);
    const hgt = (1 - ease(lowerK)) * landerH * 0.4;
    const x = lerp(drop.x, ms.x, ease(slideK)), d = lerp(drop.d, ms.d, ease(slideK));
    const it = { id: ms.id, art: ms.art, kind: ms.art.kind || 'hab', w: ms.w, h: ms.h, v: 0.5 };
    const p = proj.project(x, d);
    E.push({ d, draw() {
      if (hgt > 0.05) { // davit cable from the lander's side
        const top = proj.project(ms.side * landerW * 0.45, 0);
        ctx.strokeStyle = 'rgba(60,60,60,0.8)'; ctx.lineWidth = Math.max(0.5, 0.05 * p.s);
        ctx.beginPath(); ctx.moveTo(top.x, top.y - landerH * 0.62 * top.s); ctx.lineTo(p.x, top.y - landerH * 0.62 * top.s); ctx.lineTo(p.x, p.y - (hgt + ms.h) * p.s); ctx.stroke();
      }
      castShadow(ctx, p.x, p.y, ms.w * p.s * 0.96, Math.max(1, ms.h * p.s * 0.12), ms.h * p.s, light, shCol, shA * (hgt > 0.05 ? 0.5 : 1));
      drawItem(ctx, it, p.x, p.y - hgt * p.s, p.s, light, world, night, 0, [0, 0, 0]);
    } });
  } else if (pk && pk !== 'base_vehicle' && pk !== 'station_module') {
    // the crate (supply / experiments / a module part) lowered from the lander, then set on the first loader's bed
    {
      const lv0 = (layout.vehicles || []).find((v) => v.loader) || layout.vehicles?.[0];
      const sideV = lv0?.slot?.x > 0 ? 1 : -1;
      const size = pk === 'base_module' ? 2.2 : 1.3;
      const groundPt = { x: sideV * (landerW / 2 + size / 2 + 0.6), d: 0.8 };
      const lowerK = clamp(sinceU / 1.4, 0, 1);
      let cp = { x: groundPt.x, d: groundPt.d, h: (1 - ease(lowerK)) * landerH * 0.5 };
      let onVeh = false;
      const li = states.findIndex((s) => s.loader);
      if (li >= 0) {
        const ls = states[li], lv = all[li];
        const at = num(ls.arriveAt, 0);
        const k2 = parked ? 1 : clamp((sinceU - at - 0.4) / 1.2, 0, 1);
        // the crate is lifted onto the loader only when it parked within reach; otherwise it stays on the ground
        if (k2 > 0 && Math.hypot(ls.x - groundPt.x, ls.d - groundPt.d) < lv.len / 2 + 5) {
          const cr = CARRY[lv.kind] || [0.5, 0];
          const tgt = { x: ls.x + ls.facing * cr[1] * lv.len, d: ls.d - 0.05, h: lv.h * cr[0] - (lv.kind === 'crane' ? size : 0) };
          cp = { x: lerp(cp.x, tgt.x, ease(k2)), d: lerp(cp.d, tgt.d, ease(k2)), h: lerp(cp.h, tgt.h, ease(k2)) + Math.sin(k2 * Math.PI) * 0.8 };
          onVeh = k2 >= 1;
        }
      }
      const p = proj.project(cp.x, cp.d);
      E.push({ d: cp.d - (onVeh ? 0.01 : 0), draw() {
        const s = p.s;
        if (cp.h > 0.05 && lowerK < 1) { // lowered on the lander's davit
          const top = proj.project(sideV * landerW * 0.45, 0);
          const ty = top.y - landerH * 0.55 * top.s;
          ctx.strokeStyle = 'rgba(60,60,60,0.85)'; ctx.lineWidth = Math.max(0.5, 0.05 * s);
          ctx.beginPath(); ctx.moveTo(top.x, ty); ctx.lineTo(p.x, ty); ctx.lineTo(p.x, p.y - (cp.h + size) * s); ctx.stroke();
        }
        if (!onVeh) castShadow(ctx, p.x, p.y, size * s * 1.05, Math.max(1, size * s * 0.18), size * s, light, shCol, shA * (cp.h > 0.3 ? 0.4 : 1), 0.9);
        const y0 = p.y - (cp.h + size) * s;
        ctx.fillStyle = cylGrad(ctx, p.x - size * s / 2, 0, p.x + size * s / 2, 0, 'gold_foil', light, { amb: 0.5 });
        ctx.fillRect(p.x - size * s / 2, y0, size * s, size * s);
        ctx.fillStyle = 'rgba(255,240,200,0.35)'; ctx.fillRect(p.x - size * s / 2, y0, size * s, Math.max(0.6, size * s * 0.12)); // lit lid
        ctx.strokeStyle = 'rgba(60,40,10,0.55)'; ctx.lineWidth = Math.max(0.4, 0.05 * s); ctx.strokeRect(p.x - size * s / 2, y0, size * s, size * s);
        ctx.beginPath(); ctx.moveTo(p.x - size * s / 2, y0 + size * s / 2); ctx.lineTo(p.x + size * s / 2, y0 + size * s / 2); ctx.stroke(); // strap
        if (night) { ctx.fillStyle = 'rgba(4,6,14,0.6)'; ctx.fillRect(p.x - size * s / 2 - 0.5, y0 - 0.5, size * s + 1, size * s + 1); }
      } });
    }
  }
  if (!layout.vehicles?.length && o.crewed) { // two astronauts with helmet lights walking to the crate
    const side = 1;
    const gpx = side * (landerW / 2 + 1.2);
    for (let j = 0; j < 2; j++) {
      const walk = clamp((sinceU - 0.8 - j * 0.7) / 4, 0, 1);
      const ax = lerp(side * landerW * 0.3, gpx + side * (1.7 + j * 1.2), ease(walk)), ad = lerp(-0.5, 1.6 + j * 0.7, ease(walk));
      E.push({ d: ad, draw() {
        const q = proj.project(ax, ad), ss = q.s;
        const bob = walk > 0 && walk < 1 && !o.reduce ? Math.abs(Math.sin(t * 5 + j)) * 0.1 * ss : 0;
        const face = -side;
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const gx = q.x + face * 1.1 * ss, gy = q.y - 0.1 * ss;
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 1.2 * ss);
        g.addColorStop(0, `rgba(255,248,220,${night ? 0.4 : 0.22})`); g.addColorStop(1, 'rgba(255,248,220,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(gx, gy, 1.2 * ss, 0.35 * ss, 0, 0, TAU); ctx.fill();
        ctx.restore();
        castShadow(ctx, q.x, q.y, 0.6 * ss, 0.15 * ss, 1.9 * ss, light, shCol, shA, 0.7);
        ctx.fillStyle = '#d9d8d2'; ctx.fillRect(q.x - 0.24 * ss, q.y - 0.75 * ss - bob, 0.2 * ss, 0.75 * ss); ctx.fillRect(q.x + 0.04 * ss, q.y - 0.75 * ss - bob, 0.2 * ss, 0.75 * ss);
        ctx.fillStyle = '#ecebe6';
        ctx.fillRect(q.x - 0.3 * ss, q.y - 1.5 * ss - bob, 0.6 * ss, 0.8 * ss);
        ctx.fillStyle = '#c9c7bf'; ctx.fillRect(q.x - face * 0.42 * ss - 0.12 * ss, q.y - 1.45 * ss - bob, 0.24 * ss, 0.6 * ss); // backpack
        ctx.fillStyle = '#ecebe6'; ctx.beginPath(); ctx.arc(q.x, q.y - 1.7 * ss - bob, 0.24 * ss, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(214,170,60,0.95)'; ctx.beginPath(); ctx.arc(q.x + face * 0.09 * ss, q.y - 1.7 * ss - bob, 0.15 * ss, 0, TAU); ctx.fill();
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,250,225,0.9)'; ctx.beginPath(); ctx.arc(q.x + face * 0.2 * ss, q.y - 1.88 * ss - bob, Math.max(0.6, 0.07 * ss), 0, TAU); ctx.fill();
        ctx.restore();
      } });
    }
  }
}

/**
 * Base vehicles (≤ 6) and the delivered payload on their own (the composer draws them inside drawBase's sorted
 * pass): parked → drive to the lander after `unload` → a loader takes the crate; payload vehicles roll out to the
 * base; without vehicles a crate / module is lowered and, on crewed landings, two astronauts walk out.
 * @param o {proj, t, since (s after unload | null), parked, light, world, reduce, landerH (m), crewed}
 */
export function drawBaseVehicles(ctx, view, layout, { proj, t = 0, since = null, parked = false, light = SUN, world = 'moon', reduce = false, landerH = 6, crewed = false, night = false } = {}) {
  if (!ctx || !layout || !proj) return;
  const atmo = !AIRLESS.has(world) && !!bodyLook(world).sky;
  const hazeC = rgbOf(atmo ? cssHex(skyColors(world, 0).horizon) : '#000000');
  const E = baseEntries(ctx, view, layout, { proj, light, t, world, night, reduce, hazeC, items: false, vehicles: { since, parked, reduce, landerH, landerW: layout.landerW, crewed } });
  for (const e of E) e.draw();
}

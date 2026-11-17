// launch-render/vehicles.js — data-driven painter for launch vehicles and spacecraft.
// Art data: data/vehicle-art.json (real dimensions in metres). Contract: README.md §5.2.
//
// How it draws (vehicles builder):
// - Every rigid body (stage, booster, fairing, capsule, tank, bus, nozzle bell) is a "body": a stack of
//   segments of revolution (or a prism section for boxes/hexagons) in real metres.
// - A body is rendered ONCE into an offscreen sprite at a quantised device scale (third-octave buckets) and a
//   quantised local sun angle (24 buckets): first an albedo layer (base paint, interstage bands, tiles, solar
//   cells, lettering, flags…) with canvas 2D, then a per-pixel lighting pass (Lambert + Blinn spec + sky/ground
//   ambient + rim light + environment reflection for stainless/foil, wrapped grime noise, soot streaks, panel
//   seams, contact AO). Frost is a second sprite from the same pass, blended with alpha at draw time.
// - Things that move (engine bells with gimbal, grid fins, landing legs, flaps, rotors, nozzle glow) are drawn
//   live every frame on top of / below the cached sprites, using the same lighting model.
// Conventions: vehicle-local metres, y UP, origin = base centre; canvas y = -yM * pxPerM. No Math.random:
// all variation is seeded from ids (hash/rng from textures.js).

import { hash, rng, SUN } from './textures.js';

// ------------------------------------------------------------------ materials

// base/dark/light/spec/shin/rough: contract fields. metal: environment reflection share; wrap: diffuse wrap
// (soft terminator for painted/rough surfaces); grain/mottle: albedo noise; crinkle: MLI foil normal noise.
export const MATERIALS = {
  white_paint: { base: '#e4e2dc', dark: '#6f747c', light: '#ffffff', spec: 0.2, shin: 14, rough: 0.6, wrap: 0.1, grain: 0.03, mottle: 0.05 },
  stainless: { base: '#c4c9ce', dark: '#4c5258', light: '#f4f6f8', spec: 0.85, shin: 70, rough: 0.15, metal: 0.85, wrap: 0, grain: 0.025, mottle: 0.05 },
  orange_foam: { base: '#c2652a', dark: '#5e2a0c', light: '#e8955a', spec: 0.02, shin: 4, rough: 1, wrap: 0.18, grain: 0.08, mottle: 0.12 },
  carbon_black: { base: '#25272b', dark: '#0c0d0f', light: '#5a5e66', spec: 0.3, shin: 22, rough: 0.5, wrap: 0.1, grain: 0.04, mottle: 0.06 },
  bare_aluminium: { base: '#b6bbc1', dark: '#5c6168', light: '#eef1f4', spec: 0.5, shin: 28, rough: 0.35, metal: 0.45, wrap: 0.05, grain: 0.03, mottle: 0.06 },
  gold_foil: { base: '#c99a3e', dark: '#6e4a12', light: '#ffe7a0', spec: 0.75, shin: 26, rough: 0.4, metal: 0.8, wrap: 0, crinkle: 0.55, grain: 0.02, mottle: 0.08 },
  silver_foil: { base: '#c6c9ce', dark: '#62666c', light: '#ffffff', spec: 0.7, shin: 26, rough: 0.4, metal: 0.75, wrap: 0, crinkle: 0.3, grain: 0.02, mottle: 0.06 },
  silver_tile: { base: '#d2d5d7', dark: '#70757b', light: '#ffffff', spec: 0.28, shin: 14, rough: 0.5, wrap: 0.15, grain: 0.03, mottle: 0.05 },
  ablator: { base: '#4b3b2f', dark: '#140f0c', light: '#6a5646', spec: 0.03, shin: 3, rough: 1, wrap: 0.3, grain: 0.08, mottle: 0.14 },
  tile_black: { base: '#1e1f21', dark: '#070708', light: '#44474c', spec: 0.12, shin: 8, rough: 0.8, wrap: 0.1, grain: 0.05, mottle: 0.06 },
  solar_cell: { base: '#1a2448', dark: '#070b16', light: '#3d5aa8', spec: 0.7, shin: 40, rough: 0.2, wrap: 0, grain: 0.01, mottle: 0.03 },
  grey_paint: { base: '#b4b8b2', dark: '#5f625e', light: '#eceee9', spec: 0.14, shin: 10, rough: 0.6, wrap: 0.1, grain: 0.03, mottle: 0.06 },
  bronze: { base: '#c07a45', dark: '#5a3418', light: '#e3a670', spec: 0.08, shin: 8, rough: 0.7, wrap: 0.3, grain: 0.06, mottle: 0.1 },
  soyuz_green: { base: '#7c876a', dark: '#3a4230', light: '#b4c09a', spec: 0.1, shin: 6, rough: 0.7, wrap: 0.2, grain: 0.04, mottle: 0.08, crinkle: 0.18 },
  nozzle_dark: { base: '#34353a', dark: '#111', light: '#777', spec: 0.55, shin: 24, rough: 0.4, metal: 0.5, wrap: 0, grain: 0.03, mottle: 0.08 },
  nozzle_niobium: { base: '#3d3936', dark: '#111', light: '#777', spec: 0.45, shin: 18, rough: 0.4, metal: 0.5, wrap: 0, grain: 0.03, mottle: 0.1 },
  nozzle_steel: { base: '#a7abb0', dark: '#333', light: '#eee', spec: 0.8, shin: 40, rough: 0.2, metal: 0.8, wrap: 0, grain: 0.02, mottle: 0.08 },
  nozzle_bronze: { base: '#6e5038', dark: '#222', light: '#c90', spec: 0.6, shin: 26, rough: 0.3, metal: 0.6, wrap: 0, grain: 0.03, mottle: 0.1 },
  srb_nozzle: { base: '#2c2a28', dark: '#0a0a0a', light: '#555', spec: 0.15, shin: 8, rough: 0.8, wrap: 0.1, grain: 0.06, mottle: 0.1 },
  engine_dark: { base: '#3b3c40', dark: '#111', light: '#888', spec: 0.4, shin: 16, rough: 0.5, metal: 0.4, wrap: 0.05, grain: 0.05, mottle: 0.1 },
  beta_cloth: { base: '#e7e4d9', dark: '#777', light: '#fff', spec: 0.06, shin: 6, rough: 0.9, wrap: 0.3, grain: 0.03, mottle: 0.05, crinkle: 0.12 },
  mli_black: { base: '#232326', dark: '#000', light: '#555', spec: 0.35, shin: 18, rough: 0.5, metal: 0.3, wrap: 0.05, crinkle: 0.4, grain: 0.02, mottle: 0.05 },
  black_paint: { base: '#17181a', dark: '#000', light: '#444', spec: 0.22, shin: 16, rough: 0.5, wrap: 0.1, grain: 0.03, mottle: 0.05 },
  rtg_dark: { base: '#45474b', dark: '#111', light: '#888', spec: 0.3, shin: 12, rough: 0.6, metal: 0.3, wrap: 0.1, grain: 0.04, mottle: 0.08 },
};
const matOf = (id) => MATERIALS[id] || MATERIALS.white_paint;

// ------------------------------------------------------------------ small math / colour helpers

const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const HEXC = new Map();
function hexLin(h) {
  let c = HEXC.get(h);
  if (c) return c;
  let s = String(h || '#888').replace('#', '');
  if (s.length === 3) s = s.split('').map((x) => x + x).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => v * v);
  HEXC.set(h, c);
  return c;
}
const toByte = (lin) => { let v = Math.sqrt(Math.max(0, lin)); if (v > 0.9) v = 0.9 + (v - 0.9) * 0.35; return Math.round(clamp(v, 0, 1) * 255); };
const cssLin = (c, a = 1) => (a >= 1 ? `rgb(${toByte(c[0])},${toByte(c[1])},${toByte(c[2])})` : `rgba(${toByte(c[0])},${toByte(c[1])},${toByte(c[2])},${a.toFixed(3)})`);

// scene light constants (linear)
const SUNC = [1.38, 1.3, 1.18];
const SKY = [0.13, 0.16, 0.22];
const GND = [0.075, 0.065, 0.055];
const RIM = [0.3, 0.42, 0.62];

/** Shade one normal with a material (CPU, for live 2D extras). n = [x, y(up), z(viewer)], L 3D unit. */
function litLin(matId, n, L, tint) {
  const m = matOf(matId);
  const alb = hexLin(tint || m.base);
  const ndl = n[0] * L[0] + n[1] * L[1] + n[2] * L[2];
  const w = m.wrap || 0;
  const dif = Math.max(0, (ndl + w) / (1 + w));
  const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
  const ndh = (n[0] * hx + n[1] * hy + n[2] * hz) / hl;
  const sp = ndl > 0 && ndh > 0 ? m.spec * Math.pow(ndh, m.shin) : 0;
  const sw = 0.5 + 0.5 * n[1];
  const out = [0, 0, 0];
  const metal = m.metal || 0;
  for (let i = 0; i < 3; i++) {
    const amb = GND[i] + (SKY[i] - GND[i]) * sw;
    const diffuse = alb[i] * (amb + SUNC[i] * dif) * (1 - metal * 0.6);
    const env = metal ? alb[i] * metal * (0.32 + 0.4 * Math.max(0, n[0] * L[0] * 1.2 + 0.3)) : 0;
    out[i] = diffuse + env + sp * SUNC[i] * (metal ? 0.5 + 0.5 * alb[i] : 1);
  }
  return out;
}
const litCss = (matId, n, L, tint, a) => cssLin(litLin(matId, n, L, tint), a);

/** Gradient across a strut/tube from a to b (screen px) with half width hw (px). */
function tubeFill(ctx, ax, ay, bx, by, hw, matId, L, tint) {
  const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
  const px = -dy / l, py = dx / l;          // perpendicular (canvas coords)
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const g = ctx.createLinearGradient(mx - px * hw, my - py * hw, mx + px * hw, my + py * hw);
  for (let i = 0; i <= 4; i++) {
    const s = -1 + i / 2;
    const nz = Math.sqrt(Math.max(0, 1 - s * s));
    g.addColorStop(i / 4, litCss(matId, [s * px, -s * py, nz], L, tint));
  }
  return g;
}

// ------------------------------------------------------------------ art data

const BUILTIN_GENERIC = {
  name: 'Foguete', family: 'generic', site: null, tower: 'umbilical', reuse: null, heightM: 50, diameterM: 3.7, payloadTop: 40, crewTop: 'craft',
  parts: [
    { id: 's1', role: 'stage', y: 1.5, len: 30, d: 3.7, mat: 'white_paint', segs: [{ len: 28, d: 3.7 }, { len: 2, d: 3.7, mat: 'carbon_black' }], engines: { n: 5, prop: 'kerolox', bellD: 1, bellLen: 1.5, layout: 'cluster' } },
    { id: 's2', role: 'upper', y: 31.5, len: 8.5, d: 3.7, mat: 'white_paint', engines: { n: 1, prop: 'kerolox', bellD: 1.6, bellLen: 2, layout: 'single', vac: true, hidden: true } },
  ],
  fairing: { id: 'fairing', role: 'fairing', y: 40, len: 10, d: 4.2, mat: 'white_paint', nose: 'ogive', sep: 'fairing' },
};
const BUILTIN_CRAFT = { name: 'Sonda', template: 'probe', heightM: 2.5, widthM: 10, bus: { w: 2, h: 2.5, mat: 'gold_foil' }, arrays: { type: 'wing', spanM: 10, panels: 2 }, hga: { d: 1.6 } };

let ART = null;
let loading = null;
const STACKS = new Map();

/** Inject the art JSON (tests, preview). */
export function setVehicleArt(json) {
  ART = json && typeof json === 'object' ? json : null;
  STACKS.clear();
}

/** Fetch data/vehicle-art.json once (browser). Resolves to the JSON (or null on failure). */
export function loadVehicleArt(url) {
  if (ART) return Promise.resolve(ART);
  if (loading) return loading;
  if (typeof fetch !== 'function') return Promise.resolve(null);
  const u = url || new URL('../../../data/vehicle-art.json', import.meta.url).href;
  loading = fetch(u, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j) setVehicleArt(j); return ART; })
    .catch(() => null);
  return loading;
}

const FAMILY_GUESS = (v) => {
  const id = String(v?.id || '');
  if (/falcon/.test(id)) return 'falcon9';
  if (/starship/.test(id)) return 'starship';
  if (/sls/.test(id)) return 'sls_b1';
  if (/long_march|cz/.test(id)) return 'long_march_7';
  if (/soyuz/.test(id)) return 'soyuz2';
  if (/ariane/.test(id)) return 'ariane6';
  if (/glenn/.test(id)) return 'new_glenn';
  if (/vulcan|atlas/.test(id)) return 'vulcan';
  if (/h3|h2/.test(id)) return 'h3';
  if (/lvm|gslv|pslv/.test(id)) return 'lvm3';
  return null;
};

/** Art for a launcher (never null). */
export function vehicleArt(vehicleId, vehicleData) {
  const V = ART?.vehicles || {};
  if (V[vehicleId]) return V[vehicleId];
  const guess = FAMILY_GUESS(vehicleData || { id: vehicleId });
  if (guess && V[guess]) return V[guess];
  return ART?.families?.generic || BUILTIN_GENERIC;
}

/** Spacecraft kind from spacecraft.json fields. */
export function craftKindOf(craftData) {
  const k = String(craftData?.kind || '');
  if (['capsule', 'lander', 'probe', 'cargo', 'station_module', 'rover', 'satellite'].includes(k)) return k;
  if ((craftData?.crew || 0) > 0) return 'capsule';
  return 'probe';
}

/** Art for a spacecraft (never null). */
export function craftArt(craftId, craftData) {
  const C = ART?.craft || {};
  if (craftId && C[craftId]) return C[craftId];
  const kinds = ART?.craftKinds || {};
  return kinds[craftKindOf(craftData)] || kinds.probe || BUILTIN_CRAFT;
}

export function listVehicleArtIds() { return Object.keys(ART?.vehicles || {}); }
export function listCraftArtIds() { return Object.keys(ART?.craft || {}); }

// ------------------------------------------------------------------ stacks

const STAGE_ROLES = new Set(['stage', 'booster', 'nose']);

/** Full launch stack: vehicle parts + payload on top. Cached per (vehicle, craft, crewed). */
export function resolveStack(vehicleId, craftId, { crewed = false, vehicleData, craftData } = {}) {
  const key = `${vehicleId}|${craftId}|${crewed ? 1 : 0}|${ART ? 1 : 0}`;
  const hit = STACKS.get(key);
  if (hit) return hit;
  const art = vehicleArt(vehicleId, vehicleData);
  const craft = craftArt(craftId, craftData);
  const parts = (art.parts || []).map((p) => ({ ...p }));
  const top = Number(art.payloadTop) || Math.max(0, ...parts.map((p) => p.y + p.len));
  let payload = 'fairing';
  if (art.crewTop === 'integrated') payload = 'integrated';
  else if (Array.isArray(craft.onStack) && craft.onStack.length && (crewed || craft.template === 'capsule' || craft.template === 'capsule_sm')) {
    for (const p of craft.onStack) parts.push({ ...p, id: `p:${p.id}`, y: top + (Number(p.y) || 0), payload: true });
    payload = 'craft';
  } else if (art.fairing) parts.push({ ...art.fairing, payload: true });
  for (const p of parts) {
    if (Array.isArray(p.segs) && p.segs.length) {
      if (!(p.len > 0)) p.len = p.segs.reduce((s, g) => s + num(g.len, 0), 0);
      if (!(p.d > 0)) p.d = num(p.segs[0].d, 1);
    }
  }
  const heightM = Math.max(0, ...parts.map((p) => (p.y || 0) + (p.len || 0)));
  const maxWidthM = Math.max(1, ...parts.map((p) => Math.abs(p.x || 0) * 2 + Math.max(p.d || 1, ...(p.segs || []).map((s) => num(s.d, 0)))));
  const stack = {
    id: key, vehicleId, craftId, heightM, maxWidthM, parts, art, craft, payload,
    hasBoosters: parts.some((p) => p.sep === 'boosterSep'),
    hasLES: parts.some((p) => p.role === 'les'),
    site: art.site || null, tower: art.tower || 'umbilical', reuse: art.reuse || null,
  };
  STACKS.set(key, stack);
  return stack;
}

function goneIn(p, flags = {}) {
  const boostersOff = !!(flags.boostersOff || flags.staged);
  if (p.sep === 'boosterSep') return boostersOff;
  if (p.sep === 'staging') return !!flags.staged;
  if (p.sep === 'fairing') return !!flags.fairingOff;
  if (!p.payload && STAGE_ROLES.has(p.role) && !p.x) return !!flags.staged; // core first stage
  return false;
}

/** Parts still on the vehicle for these flags. */
export function attachedParts(stack, flags = {}) {
  return (stack?.parts || []).filter((p) => !goneIn(p, flags));
}

/** Parts that leave the vehicle on an event ('boosterSep' | 'staging' | 'fairing'). */
export function detachedBy(stack, eventName, prevFlags = {}) {
  const next = { ...prevFlags };
  if (eventName === 'boosterSep') next.boostersOff = true;
  if (eventName === 'staging') { next.staged = true; next.boostersOff = true; }
  if (eventName === 'fairing') next.fairingOff = true;
  const before = new Set(attachedParts(stack, prevFlags));
  const after = new Set(attachedParts(stack, next));
  return [...before].filter((p) => !after.has(p));
}

function visibleEngines(e) {
  const n = Math.max(1, e?.n || 1);
  if (e.layout === 'single' || n === 1) return 1;
  if (e.layout === 'pair') return 2;
  if (e.layout === 'octaweb') return 3;
  if (e.layout === 'ring') return Math.min(n, n > 12 ? 7 : 3);
  return Math.min(n, 3);
}

/** Nozzle exits of the engines burning now (vehicle metres, y up). Representative subset for plumes. */
export function activeNozzles(stack, flags = {}) {
  const att = attachedParts(stack, flags);
  const out = [];
  const firing = flags.staged
    ? att.filter((p) => p.engines && p.role === 'upper').slice(0, 1)
    : att.filter((p) => p.engines && (p.role === 'stage' || p.role === 'booster'));
  for (const p of firing) {
    const e = p.engines;
    const k = visibleEngines(e);
    const lay = engineLayout(e, p.d || 1);
    const ext = lay.length > 1 ? Math.max(...lay.map((q) => Math.abs(q.x))) : 0;
    for (let i = 0; i < k; i++) {
      const x = (p.x || 0) + (k > 1 ? -ext + (2 * ext * i) / (k - 1) : 0);
      out.push({ x, y: p.y - e.bellLen, d: e.bellD, prop: e.prop || 'kerolox', vac: !!e.vac, partId: p.id });
    }
  }
  return out;
}

// ------------------------------------------------------------------ noise tiles (generated once)

const TS = 256;
let NT = null;
function noiseTile() {
  if (NT) return NT;
  const r = rng(hash('vehicles|noise'));
  NT = new Float32Array(TS * TS);
  let amp = 1, tot = 0;
  for (const cells of [4, 8, 16, 32, 64]) {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    const step = TS / cells;
    for (let y = 0; y < TS; y++) {
      const gy = y / step, iy = Math.floor(gy), fy = gy - iy, sy = fy * fy * (3 - 2 * fy);
      const y0 = (iy % cells) * cells, y1 = ((iy + 1) % cells) * cells;
      for (let x = 0; x < TS; x++) {
        const gx = x / step, ix = Math.floor(gx), fx = gx - ix, sx = fx * fx * (3 - 2 * fx);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * sx;
        const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * sx;
        NT[y * TS + x] += (a + (b - a) * sy) * amp;
      }
    }
    tot += amp; amp *= 0.55;
  }
  for (let i = 0; i < NT.length; i++) NT[i] /= tot;
  // stretch contrast to ~[0,1]
  let lo = 1, hi = 0;
  for (let i = 0; i < NT.length; i++) { if (NT[i] < lo) lo = NT[i]; if (NT[i] > hi) hi = NT[i]; }
  for (let i = 0; i < NT.length; i++) NT[i] = (NT[i] - lo) / (hi - lo || 1);
  return NT;
}
const nAt = (T, u, v) => T[((v | 0) & 255) * TS + ((u | 0) & 255)];

let CT = null; // crinkle (worley F1) tile for foil normals
function crinkleTile() {
  if (CT) return CT;
  const N = 128, cells = 9, r = rng(hash('vehicles|crinkle'));
  const pts = [];
  for (let i = 0; i < cells * cells; i++) pts.push([r(), r()]);
  CT = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const gx = (x / N) * cells, gy = (y / N) * cells, cx = Math.floor(gx), cy = Math.floor(gy);
    let best = 9, second = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const ix = (cx + ox + cells) % cells, iy = (cy + oy + cells) % cells;
      const p = pts[iy * cells + ix];
      const dx = cx + ox + p[0] - gx, dy = cy + oy + p[1] - gy;
      const dd = dx * dx + dy * dy;
      if (dd < best) { second = best; best = dd; } else if (dd < second) second = dd;
    }
    CT[y * N + x] = Math.sqrt(second) - Math.sqrt(best); // ridges at cell borders → crumple facets
  }
  return CT;
}
const cAt = (T, u, v) => T[((v | 0) & 127) * 128 + ((u | 0) & 127)];

// ------------------------------------------------------------------ canvases + sprite cache

function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  } catch { /* none */ }
  return null;
}
const SPR = new Map();
let sprBytes = 0;
const SPR_BUDGET = 28e6;
function sprGet(key) { const h = SPR.get(key); if (h) { SPR.delete(key); SPR.set(key, h); } return h; }
function sprPut(key, s) {
  SPR.set(key, s);
  sprBytes += s.bytes;
  for (const [k, v] of SPR) { if (sprBytes <= SPR_BUDGET || k === key) break; SPR.delete(k); sprBytes -= v.bytes; }
}
/** Debug: cached vehicle sprites. */
export function vehicleSpriteStats() { return { count: SPR.size, bytes: sprBytes }; }

/** Device scale + rotation of the current ctx transform and the sun in the local frame. */
function frameOf(ctx, light, tilt) {
  let sc = 1, rot = num(tilt, 0);
  try { const m = ctx.getTransform(); sc = Math.hypot(m.a, m.b) || 1; rot = Math.atan2(m.b, m.a); } catch { /* no getTransform */ }
  const ax = num(light?.ax, SUN.ax), ay = num(light?.ay, SUN.ay);
  const c = Math.cos(rot), s = Math.sin(rot);
  const lx = ax * c + ay * s, ly = -ax * s + ay * c;          // screen → local (y down)
  const ang = Math.atan2(ly, lx);
  const lb = ((Math.round((ang / (Math.PI * 2)) * 24) % 24) + 24) % 24;
  const qa = (lb / 24) * Math.PI * 2;
  const L = norm3([Math.cos(qa), -Math.sin(qa), 0.55]);     // 3D, y up, z toward viewer
  const Lexact = norm3([lx, -ly, 0.55]);
  return { sc, rot, lb, L, Lx: Lexact };
}
function norm3(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// ------------------------------------------------------------------ body geometry (segments of revolution)

/** Normalise a part / body description into segments {y0,len,d,dTop,shape,mat,...}. */
const SEGC = new WeakMap();
function segsOf(p) {
  let c = SEGC.get(p);
  if (c) return c;
  let src = p.segs;
  if (!(Array.isArray(src) && src.length)) {
    const { soot, frost, marks, engines, segs, y, x, ...rest } = p; // eslint-disable-line no-unused-vars
    src = [rest];
  }
  const out = [];
  let y = 0, prevTop = num(p.d, num(src[0]?.d, 1));
  for (const s0 of src) {
    const d = Math.max(0.01, num(s0.d, prevTop)), len = Math.max(0.01, num(s0.len, 1));
    let dTop = s0.dTop != null ? Math.max(0, num(s0.dTop, d)) : d;
    const nose = s0.nose || null;
    const base = { ...s0, d, mat: s0.mat || p.mat || 'white_paint', tint: s0.tint || (s0.mat ? null : p.tint) || null };
    if (nose === 'ogive' || nose === 'starship') {
      const nf = clamp(num(s0.noseFrac, nose === 'starship' ? 0.36 : (p.role === 'fairing' ? 0.56 : 1)), 0.05, 1);
      const tip = num(s0.tipD, s0.dTop != null && s0.dTop < d ? s0.dTop : nose === 'starship' ? 2.2 : d * 0.07);
      if (nf < 0.999) { out.push({ ...base, y0: y, len: len * (1 - nf), dTop: d, shape: 'line', nose: null, cyl: true }); y += len * (1 - nf); }
      out.push({ ...base, y0: y, len: len * nf, d, dTop: tip, shape: 'ogive', isNose: true });
      y += len * nf;
    } else {
      let shape = s0.shape || 'line';
      if (nose === 'cone') { shape = 'cone'; if (s0.dTop == null) dTop = d * 0.08; }
      if (nose === 'blunt') shape = 'ellipse';
      if (nose === 'dome') { shape = 'ellipse'; if (s0.dTop == null) dTop = 0; }
      out.push({ ...base, y0: y, len, dTop, shape, isNose: !!nose });
      y += len;
    }
    prevTop = out[out.length - 1].dTop;
  }
  c = { segs: out, len: y };
  SEGC.set(p, c);
  return c;
}

function segR(sg, u) {
  const r0 = sg.d / 2, r1 = sg.dTop / 2;
  switch (sg.shape) {
    case 'ogive': {
      const L = sg.len, R = r0 - r1;
      if (R <= 1e-4) return r0;
      if (L < R) return r1 + R * Math.sqrt(Math.max(0, 1 - u * u));
      const rho = (R * R + L * L) / (2 * R), yy = u * L;
      return r1 + Math.sqrt(Math.max(0, rho * rho - yy * yy)) - (rho - R);
    }
    case 'cone': { // straight cone with a small rounded tip
      const r = r0 + (r1 - r0) * u;
      return u > 0.97 && r1 < r0 * 0.2 ? r * Math.sqrt(Math.max(0, 1 - ((u - 0.97) / 0.03) ** 2 * 0.6)) : r;
    }
    case 'ellipse': return r1 + (r0 - r1) * Math.sqrt(Math.max(0, 1 - u * u));
    case 'easeOut': return r0 + (r1 - r0) * (1 - (1 - u) * (1 - u));
    case 'easeIn': return r0 + (r1 - r0) * u * u;
    case 'bell': return r1 + (r0 - r1) * Math.pow(1 - u, 1.8);
    case 'sphere': {
      const rm = num(sg.dMid, Math.max(sg.d, sg.dTop) * 1.0) / 2;
      const e = Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
      return Math.max(r0 + (r1 - r0) * u, rm * e);
    }
    case 'headlight': return r0 - (r0 - r1) * Math.pow(u, 1.5);
    default: return r0 + (r1 - r0) * u;
  }
}

/** Profile sampler for a body: r(y), slope, centre shift (skew), seg. */
function profileOf(body) {
  if (body._prof) return body._prof;
  const { segs, len } = segsOf(body);
  const r0 = segs[0].d / 2;
  const skew = num(body.skew, 0);
  function segAt(y) {
    for (let i = segs.length - 1; i >= 0; i--) if (y >= segs[i].y0 - 1e-6) return i;
    return 0;
  }
  function rAt(y) {
    const i = segAt(clamp(y, 0, len));
    const sg = segs[i];
    return segR(sg, clamp((y - sg.y0) / sg.len, 0, 1));
  }
  let maxR = 0;
  for (let i = 0; i <= 160; i++) { const y = (i / 160) * len; const r = rAt(y); const cx = skew * (r0 - r); maxR = Math.max(maxR, Math.abs(cx) + r); }
  body._prof = { segs, len, segAt, rAt, cxAt: (y) => skew * (r0 - rAt(y)), maxR, r0 };
  return body._prof;
}

// polygon cross-section → visible faces in normalised x ∈ [-1, 1]
function polyFaces(n, rotDeg) {
  const rot = (num(rotDeg, 0) * Math.PI) / 180;
  const v = [];
  for (let k = 0; k < n; k++) { const a = rot + (2 * Math.PI * k) / n; v.push([Math.cos(a), Math.sin(a)]); }
  const faces = [];
  let xmin = Infinity, xmax = -Infinity;
  for (const p of v) { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); }
  for (let k = 0; k < n; k++) {
    const a = v[k], b = v[(k + 1) % n];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, l = Math.hypot(mx, mz) || 1;
    const nx = mx / l, nz = mz / l;
    if (nz <= 0.001) continue;
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const map = (x) => -1 + (2 * (x - xmin)) / (xmax - xmin);
    faces.push({ x0: map(x0), x1: map(x1), nx, nz });
  }
  faces.sort((p, q) => p.x0 - q.x0);
  return faces;
}

// ------------------------------------------------------------------ body sprite rendering

/**
 * Render (cached) a body: { id, segs | len/d/dTop/nose, mat, section?:{n,rot}, skew?, soot?, sootColor?, frost?,
 *   frostZones?, seamEvery?, seamStrength?, ringTone?, decor?(G), seed? } at device px/m kDev, light bucket fr.
 */
function bodySprite(body, kDev, fr) {
  const prof = profileOf(body);
  let q = Math.round(Math.log2(Math.max(0.05, kDev)) * 3) / 3;
  let kb = Math.pow(2, q);
  const pad = 3;
  let W = Math.ceil(2 * prof.maxR * kb) + pad * 2, H = Math.ceil(prof.len * kb) + pad * 2;
  const LIM = 2048;
  if (W > LIM || H > LIM) { kb *= LIM / Math.max(W, H); W = Math.ceil(2 * prof.maxR * kb) + pad * 2; H = Math.ceil(prof.len * kb) + pad * 2; }
  const key = `${body.id}|${kb.toFixed(4)}|${fr.lb}`;
  const hit = sprGet(key);
  if (hit) return hit;
  const c = makeCanvas(W, H);
  if (!c) return null;
  const g = c.getContext('2d');
  const ox = W / 2, oy = H - pad;
  const G = { g, kb, ox, oy, prof, X: (xm) => ox + xm * kb, Y: (ym) => oy - ym * kb, W, H, body };
  // 1. silhouette + per segment albedo
  silhouette(G);
  g.save();
  g.clip();
  for (const sg of prof.segs) {
    g.fillStyle = sg.tint || matOf(sg.mat).base;
    g.fillRect(0, G.Y(sg.y0 + sg.len) - 1, W, sg.len * kb + 2);
  }
  try { decorSegs(G); if (body.decor) body.decor(G); } catch (e) { void e; }
  g.restore();
  // 2. per-pixel lighting
  let frostC = null;
  try {
    const img = g.getImageData(0, 0, W, H);
    let fimg = null;
    if (body.frost > 0) { frostC = makeCanvas(W, H); fimg = frostC ? frostC.getContext('2d').createImageData(W, H) : null; }
    shadeBody(img, fimg, G, fr.L);
    g.putImageData(img, 0, 0);
    if (fimg) frostC.getContext('2d').putImageData(fimg, 0, 0);
  } catch (e) { void e; }
  const s = { c, frost: frostC, kb, ox, oy, W, H, bytes: W * H * 4 * (frostC ? 2 : 1) };
  sprPut(key, s);
  return s;
}

function silhouette(G) {
  const { g, prof, kb } = G;
  const pts = [];
  for (const sg of prof.segs) {
    const n = Math.min(160, 2 + Math.ceil((sg.len * kb) / 2.5));
    for (let i = 0; i <= n; i++) {
      const y = sg.y0 + (sg.len * i) / n;
      const r = segR(sg, i / n);
      pts.push([y, r, num(G.body.skew, 0) * (prof.r0 - r)]);
    }
  }
  g.beginPath();
  pts.forEach(([y, r, cx], i) => { const X = G.X(cx - r), Y = G.Y(y); if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
  for (let i = pts.length - 1; i >= 0; i--) { const [y, r, cx] = pts[i]; g.lineTo(G.X(cx + r), G.Y(y)); }
  g.closePath();
  g.fillStyle = matOf(prof.segs[0].mat).base;
  g.fill();
}

function shadeBody(img, fimg, G, L) {
  const { kb, ox, oy, W, H, prof, body } = G;
  const d = img.data, fd = fimg ? fimg.data : null;
  const T = noiseTile(), C = body.crinkle !== false ? crinkleTile() : null;
  const seed = (num(body.seed, hash(String(body.id))) >>> 0) % 997;
  const [Lx, Ly, Lz] = L;
  let Hx = Lx, Hy = Ly, Hz = Lz + 1;
  const hl = Math.hypot(Hx, Hy, Hz); Hx /= hl; Hy /= hl; Hz /= hl;
  const faces = body.section && body.section.n ? polyFaces(body.section.n, body.section.rot) : null;
  const soot = num(body.soot, 0), sootC = body.sootColor ? hexLin(body.sootColor) : [0.018, 0.014, 0.011];
  const seamEvery = num(body.seamEvery, 0), seamK = num(body.seamStrength, 0.16);
  const seamFade = seamEvery ? clamp((seamEvery * kb - 3) / 5, 0, 1) : 0;
  const frost = fd ? num(body.frost, 0) : 0;
  const fz = body.frostZones || [[prof.len * 0.04, prof.len * 0.9]];
  const fSharp = !!body.frostSharp;
  const bounds = prof.segs.slice(1).map((s) => s.y0);
  const ringTone = body.ringTone ? num(body.ringTone, 0.1) : 0;
  const grainOn = kb > 2.5 ? 1 : kb / 2.5;
  const matCache = new Map();
  for (let j = 0; j < H; j++) {
    const ym = (oy - j - 0.5) / kb;
    if (ym < -0.02 || ym > prof.len + 0.02) continue;
    const yy = clamp(ym, 0, prof.len);
    const si = prof.segAt(yy), sg = prof.segs[si];
    let m = matCache.get(sg.mat);
    if (!m) { m = matOf(sg.mat); matCache.set(sg.mat, m); }
    const r = Math.max(1e-3, prof.rAt(yy));
    const dy = 0.5 / kb + 0.01;
    const slope = (prof.rAt(Math.min(prof.len, yy + dy)) - prof.rAt(Math.max(0, yy - dy))) / (2 * dy);
    const cc = 1 / Math.sqrt(1 + slope * slope), nyRow = -slope * cc;
    const cx = num(body.skew, 0) ? prof.cxAt(yy) : 0;
    // contact AO at segment joints / part ends
    let edge = Math.min(yy, prof.len - yy) * 0.6;
    for (const b of bounds) edge = Math.min(edge, Math.abs(yy - b));
    const ao = 1 - 0.32 * Math.exp(-(edge * kb) / 1.6) - (body.noEndAO ? 0 : 0.12 * Math.exp(-(Math.min(yy, prof.len - yy) * kb) / 5));
    // seams
    let seam = 1, ring = 0;
    if (seamEvery && seamFade > 0) {
      const f = yy / seamEvery, dd = Math.abs(f - Math.round(f)) * seamEvery * kb;
      if (dd < 0.8) seam = 1 - seamK * seamFade * (1 - dd / 0.8);
      else if (dd < 1.6 && f - Math.round(f) < 0) seam = 1 + seamK * 0.35 * seamFade;
      ring = Math.floor(f);
    }
    const tone = ringTone ? 1 + ((((ring * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 2 * ringTone : 1;
    const sootRow = soot > 0 ? soot * Math.pow(clamp(1.12 - (yy / prof.len) * 1.25, 0, 1), 1.4) : 0;
    const segSoot = num(sg.soot, 0);
    let frostRow = 0;
    let frostE = 0.6;
    if (frost > 0) {
      for (const [a, b] of fz) {
        const e = fSharp ? 0.12 : Math.max(0.6, (b - a) * 0.14);
        frostE = e;
        const pad = fSharp ? 0 : e * 1.2; // per-pixel jitter below can push the edge out by up to this
        frostRow = Math.max(frostRow, smooth(a - e - pad, a + e, yy) * (1 - smooth(b - e, b + e + pad, yy)));
      }
    }
    const i0 = Math.max(0, Math.floor(ox + (cx - r) * kb) - 1), i1 = Math.min(W - 1, Math.ceil(ox + (cx + r) * kb) + 1);
    const metal = m.metal || 0, wrap = m.wrap || 0, spec = m.spec, shin = m.shin;
    const crink = C ? num(m.crinkle, 0) : 0;
    const mottle = m.mottle || 0, grain = (m.grain || 0) * grainOn;
    for (let i = i0; i <= i1; i++) {
      const idx = (j * W + i) * 4;
      const a = d[idx + 3];
      if (!a) continue;
      const xm = (i + 0.5 - ox) / kb - cx;
      let s = clamp(xm / r, -0.995, 0.995);
      let nx, nz, u;
      if (faces) {
        let f = faces[faces.length - 1];
        for (const q2 of faces) if (s <= q2.x1) { f = q2; break; }
        nx = f.nx; nz = f.nz; u = xm;
        // edge highlight at prism corners
        for (const q2 of faces) if (Math.abs(s - q2.x0) * r * kb < 0.7 && q2.x0 > -0.99) { nx *= 0.7; nz = Math.min(1, nz + 0.25); }
      } else {
        nx = s; nz = Math.sqrt(1 - s * s); u = Math.asin(s) * r;
      }
      nx *= cc; nz *= cc;
      let ny = nyRow;
      if (crink) {
        const cu = (u + seed) * 90, cv = ym * 90;
        const c0 = cAt(C, cu, cv), c1 = cAt(C, cu + 1, cv), c2 = cAt(C, cu, cv + 1);
        const fade = clamp(kb / 12, 0.15, 1);
        nx += (c1 - c0) * crink * 6 * fade; ny += (c2 - c0) * crink * 6 * fade;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      }
      // albedo (sRGB→linear)
      let ar = d[idx] / 255, ag = d[idx + 1] / 255, ab = d[idx + 2] / 255;
      ar *= ar; ag *= ag; ab *= ab;
      const lum = 0.3 * ar + 0.6 * ag + 0.1 * ab;
      const mo = 1 + (nAt(T, u * 5 + seed, ym * 5) - 0.5) * 2 * mottle + (grain ? (nAt(T, u * kb * 0.9 + 91, ym * kb * 0.9) - 0.5) * 2 * grain : 0);
      ar *= mo; ag *= mo; ab *= mo;
      const streak = nAt(T, u * 9 + seed * 3, ym * 0.45);
      // soot (multiply toward brown-black, streaky)
      let st = sootRow * (0.4 + 1.2 * streak) + segSoot * (0.5 + 0.8 * streak);
      if (st > 0) { st = Math.min(0.94, st); ar += (sootC[0] - ar) * st; ag += (sootC[1] - ag) * st; ab += (sootC[2] - ab) * st; }
      // lighting
      const ndl = nx * Lx + ny * Ly + nz * Lz;
      let dif = (ndl + wrap) / (1 + wrap); if (dif < 0) dif = 0;
      const ndh = nx * Hx + ny * Hy + nz * Hz;
      const isTile = metal > 0 && lum < 0.06;
      const mt = isTile ? 0 : metal;
      let sp = ndh > 0 && ndl > -0.05 ? (isTile ? 0.1 : spec) * Math.pow(ndh, isTile ? 8 : shin) : 0;
      sp *= Math.min(1, (ndl + 0.05) * 6);
      const sw = 0.5 + 0.5 * ny;
      const fres = 1 - nz;
      const rim = fres * fres * fres * fres * (1 - Math.min(1, dif * 1.4)) * 0.28;
      let env = 0;
      if (mt) {
        const rx = 2 * nz * nx, ry = 2 * nz * ny;
        env = (0.2 + 1.05 * Math.exp(-(((rx - Lx * 1.25) / 0.5) ** 2)) + 0.35 * Math.exp(-(((rx + Lx * 0.35) / 0.22) ** 2)) - 0.12 * Math.exp(-(((rx + Lx * 1.3) / 0.35) ** 2)) + 0.08 * ry + (streak - 0.5) * 0.26 + fres * 0.18) * tone;
        if (env < 0.03) env = 0.03;
      }
      const k = ao * seam;
      const cr = (ar * ((GND[0] + (SKY[0] - GND[0]) * sw) + SUNC[0] * dif) * (1 - mt * 0.75) + ar * env * mt * 1.25 + sp * SUNC[0] * (mt ? 0.45 + 0.55 * ar / Math.max(0.05, lum + 0.2) : 1) + RIM[0] * rim) * k;
      const cg = (ag * ((GND[1] + (SKY[1] - GND[1]) * sw) + SUNC[1] * dif) * (1 - mt * 0.75) + ag * env * mt * 1.25 + sp * SUNC[1] * (mt ? 0.45 + 0.55 * ag / Math.max(0.05, lum + 0.2) : 1) + RIM[1] * rim) * k;
      const cb = (ab * ((GND[2] + (SKY[2] - GND[2]) * sw) + SUNC[2] * dif) * (1 - mt * 0.75) + ab * env * mt * 1.3 + sp * SUNC[2] * (mt ? 0.45 + 0.55 * ab / Math.max(0.05, lum + 0.2) : 1) + RIM[2] * rim) * k;
      d[idx] = toByte(cr); d[idx + 1] = toByte(cg); d[idx + 2] = toByte(cb);
      if (frostRow > 0) {
        const fn = nAt(T, u * 2.6 + 31 + seed, ym * 1.3);
        const sp2 = nAt(T, u * 24 + 7, ym * 24);
        let fm = fSharp ? 0.72 + 0.28 * fn : smooth(0.3, 0.7, fn * 0.92 + sp2 * 0.1);
        if (!fSharp && lum > 0.35) fm *= 0.42; // on white paint frost is a faint bluish bloom, not a bright patch
        let zoneK = frostRow;
        if (!fSharp) { // ragged edges + vertical drip streaks (ice forms in runs down the tank)
          const jit = (nAt(T, u * 3.1 + seed, ym * 0.35) - 0.5) * frostE * 2.4;
          zoneK = 0;
          for (const [za, zb] of fz) zoneK = Math.max(zoneK, smooth(za - frostE, za + frostE, yy + jit) * (1 - smooth(zb - frostE, zb + frostE, yy - jit)));
          const drip = nAt(T, u * 7.3 + seed * 2, ym * 0.22);
          fm *= 0.45 + 0.75 * drip;
        }
        fm *= zoneK * frost * (isTile ? 0.22 : 1);
        if (fm > 0.01) {
          const fdif = Math.max(0, (ndl + 0.45) / 1.45);
          const fr2 = 0.74 * (GND[0] + (SKY[0] - GND[0]) * sw + SUNC[0] * fdif) * 0.9;
          const fg2 = 0.85 * (GND[1] + (SKY[1] - GND[1]) * sw + SUNC[1] * fdif) * 0.9;
          const fb2 = 0.94 * (GND[2] + (SKY[2] - GND[2]) * sw + SUNC[2] * fdif) * 0.9 + 0.02;
          fd[idx] = toByte(fr2 * ao); fd[idx + 1] = toByte(fg2 * ao); fd[idx + 2] = toByte(fb2 * ao);
          fd[idx + 3] = Math.round(a * Math.min(0.93, fm));
        }
      }
    }
  }
}

function blit(ctx, spr, k, frostA = 0) {
  if (!spr) return;
  const s = k / spr.kb;
  ctx.drawImage(spr.c, -spr.ox * s, -spr.oy * s, spr.W * s, spr.H * s);
  if (spr.frost && frostA > 0.01) {
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * Math.min(1, frostA);
    ctx.drawImage(spr.frost, -spr.ox * s, -spr.oy * s, spr.W * s, spr.H * s);
    ctx.globalAlpha = a;
  }
}

/** Fallback when no canvas can be created (Node, very old browsers): flat silhouette. */
function flatBody(ctx, body, k) {
  const prof = profileOf(body);
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const y = (prof.len * i) / 40; ctx.lineTo((prof.cxAt(y) - prof.rAt(y)) * k, -y * k); }
  for (let i = 40; i >= 0; i--) { const y = (prof.len * i) / 40; ctx.lineTo((prof.cxAt(y) + prof.rAt(y)) * k, -y * k); }
  ctx.closePath();
  ctx.fillStyle = matOf(prof.segs[0].mat).base;
  ctx.fill();
}

function drawBody(ctx, body, k, fr, frostA = 0) {
  if (DRY) return;
  const spr = bodySprite(body, k * fr.sc, fr);
  if (spr) blit(ctx, spr, k, frostA);
  else flatBody(ctx, body, k);
}

// ------------------------------------------------------------------ albedo decoration (device px, in sprite)

const FONT = '"Helvetica Neue", Arial, Helvetica, sans-serif';

function decorSegs(G) {
  const { g, prof, kb } = G;
  for (const sg of prof.segs) {
    const y0 = sg.y0, y1 = sg.y0 + sg.len;
    if (sg.lattice) { // open truss interstage: dark interior + struts
      g.fillStyle = '#0d0e10';
      g.fillRect(0, G.Y(y1), G.W, sg.len * kb);
      const n = Math.max(3, Math.round((sg.d * 1.6) / Math.max(0.6, sg.len)));
      g.strokeStyle = matOf(sg.latticeMat || 'grey_paint').base;
      g.lineWidth = Math.max(1, 0.12 * kb);
      g.beginPath();
      const r = sg.d / 2;
      for (let i = 0; i <= n; i++) {
        const xa = -r + (2 * r * i) / n, xb = -r + (2 * r * (i + 1)) / n;
        g.moveTo(G.X(xa), G.Y(y0)); g.lineTo(G.X(Math.min(r, xb)), G.Y(y1));
        g.moveTo(G.X(xa), G.Y(y1)); g.lineTo(G.X(Math.min(r, xb)), G.Y(y0));
      }
      g.stroke();
      g.fillStyle = matOf(sg.latticeMat || 'grey_paint').base;
      g.fillRect(0, G.Y(y0) - Math.max(1, 0.15 * kb), G.W, Math.max(1, 0.15 * kb));
      g.fillRect(0, G.Y(y1), G.W, Math.max(1, 0.15 * kb));
    }
    if (sg.vents) { // hot-staging ring: vertical vent slots
      const n = 9, r = sg.d / 2;
      g.fillStyle = '#060606';
      for (let i = 0; i < n; i++) {
        const ph = -1.35 + (2.7 * i) / (n - 1);
        const x = Math.sin(ph) * r, w = Math.max(1, 0.45 * Math.cos(ph) * kb);
        g.fillRect(G.X(x) - w / 2, G.Y(y1 - sg.len * 0.15), w, sg.len * 0.7 * kb);
      }
    }
    if (sg.tiles) tilesDecor(G, y0, y1, sg);
    if (sg.cells) cellsDecor(G, y0 + sg.len * 0.05, y1 - sg.len * 0.05, sg.cells === 'half' ? [-1, 0.05] : [-1, 1]);
    if (sg.band) { g.fillStyle = sg.band; g.fillRect(0, G.Y(y0 + sg.len * num(sg.bandY, 0.3) + sg.len * num(sg.bandH, 0.25)), G.W, sg.len * num(sg.bandH, 0.25) * kb); }
    if (sg.segments) { // SRB segment joints (field joints)
      g.fillStyle = 'rgba(40,40,44,0.55)';
      for (let i = 1; i < sg.segments; i++) { const y = y0 + (sg.len * i) / sg.segments; g.fillRect(0, G.Y(y) - Math.max(1, 0.12 * kb), G.W, Math.max(1, 0.22 * kb)); }
    }
    if (sg.ribs && kb > 2) { // stringers/corrugation (Saturn-like, Soyuz Block I, SLS intertank)
      const nR = typeof sg.ribs === 'number' ? Math.max(4, Math.round(sg.ribs / 2)) : 8;
      const r = sg.d / 2, tr = num(sg.dTop, sg.d) / sg.d;
      for (let i = -nR; i <= nR; i++) {
        const ph = (i / nR) * 1.45, x = Math.sin(ph) * r;
        g.strokeStyle = `rgba(0,0,0,${typeof sg.ribs === 'number' ? 0.2 : 0.12})`; g.lineWidth = Math.max(1, 0.06 * kb * Math.cos(ph));
        g.beginPath(); g.moveTo(G.X(x), G.Y(y0)); g.lineTo(G.X(x * tr), G.Y(y1)); g.stroke();
        if (typeof sg.ribs === 'number') { // lit edge of each stringer
          g.strokeStyle = 'rgba(255,230,200,0.12)'; g.lineWidth = Math.max(0.6, 0.03 * kb);
          const xo = x - Math.max(0.6, 0.05 * kb) / kb;
          g.beginPath(); g.moveTo(G.X(xo), G.Y(y0)); g.lineTo(G.X(xo * tr), G.Y(y1)); g.stroke();
        }
      }
    }
  }
  const b = G.body;
  if (b.raceway) { // cable raceway: a slim strip down the side
    const s = num(b.raceway === true ? 0.42 : b.raceway, 0.42);
    const y0 = num(b.racewayFrom, prof.len * 0.04), y1 = num(b.racewayTo, prof.len * 0.92);
    const r = prof.rAt((y0 + y1) / 2), w = Math.max(1, 0.28 * kb * Math.sqrt(1 - s * s));
    g.fillStyle = 'rgba(0,0,0,0.13)';
    g.fillRect(G.X(s * r) - w / 2 - 1, G.Y(y1), w + 2, (y1 - y0) * kb);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(G.X(s * r) - w / 2, G.Y(y1), w, (y1 - y0) * kb);
  }
  if (b.splitLine) { // fairing clamshell seam (vertical, facing the viewer)
    g.fillStyle = 'rgba(30,32,36,0.55)';
    g.fillRect(G.X(0) - Math.max(0.6, 0.04 * kb), G.Y(prof.len * 0.985), Math.max(1.2, 0.08 * kb), prof.len * 0.985 * kb);
    const cyl = prof.segs.find((s) => s.cyl);
    if (cyl) { g.fillStyle = 'rgba(30,32,36,0.3)'; g.fillRect(0, G.Y(cyl.y0 + cyl.len) - 0.5, G.W, Math.max(1, 0.06 * kb)); }
  }
  for (const mk of b.marks || []) markDecor(G, mk);
}

function tilesDecor(G, y0, y1, sg) {
  const { g, prof, kb } = G;
  // windward hexagonal TPS tiles cover the left part of the visible face, with a ragged hex boundary
  const edge = num(sg.tileEdge, 0.12);
  const step = Math.max(0.3, 0.32);
  g.save();
  g.fillStyle = matOf('tile_black').base;
  g.beginPath();
  const n = Math.max(8, Math.ceil(((y1 - y0) / step)));
  const r0 = prof.rAt(y0 + 0.01);
  g.moveTo(G.X(-r0 - 1), G.Y(y0));
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const r = prof.rAt(Math.min(prof.len, y));
    const jag = (i % 2 ? 0.06 : -0.06) + (((hash(`t${i}`) % 100) / 100) - 0.5) * 0.08;
    g.lineTo(G.X((edge + jag) * r), G.Y(y));
  }
  g.lineTo(G.X(-prof.maxR - 1), G.Y(y1));
  g.closePath();
  g.fill();
  if (step * kb > 4) { // tile grid
    g.clip();
    g.strokeStyle = 'rgba(120,124,130,0.22)';
    g.lineWidth = 1;
    const h = step * kb, w = step * kb * 0.87;
    for (let yy = G.Y(y1); yy < G.Y(y0); yy += h) {
      g.beginPath();
      for (let x = 0, k = 0; x < G.W; x += w, k++) { const off = k % 2 ? h / 2 : 0; g.moveTo(x, yy + off); g.lineTo(x + w, yy + off); g.moveTo(x, yy + off); g.lineTo(x, yy + off + h); }
      g.stroke();
    }
  }
  g.restore();
}

function cellsDecor(G, y0, y1, [sa, sb], color = '#141b36') {
  const { g, prof, kb } = G;
  const r = prof.rAt((y0 + y1) / 2);
  const x0 = G.X(sa * r), x1 = G.X(sb * r);
  g.fillStyle = color;
  g.fillRect(x0, G.Y(y1), x1 - x0, (y1 - y0) * kb);
  const cell = 0.42 * kb;
  if (cell > 2.5) {
    g.strokeStyle = 'rgba(160,175,215,0.22)'; g.lineWidth = 1;
    g.beginPath();
    for (let y = G.Y(y1); y < G.Y(y0); y += cell) { g.moveTo(x0, y); g.lineTo(x1, y); }
    for (let a = -1.5; a <= 1.5; a += 0.16) { const x = G.X(Math.sin(a) * r); if (x > x0 && x < x1) { g.moveTo(x, G.Y(y1)); g.lineTo(x, G.Y(y0)); } }
    g.stroke();
  }
}

/** Text helper: fits `text` inside alongPx × acrossPx; vertical = reads top→bottom. */
function drawText(g, text, cx, cy, alongPx, acrossPx, { vertical = false, color = '#1b1d21', weight = 700, spacing = 0.12, font = FONT } = {}) {
  let fs = acrossPx;
  g.font = `${weight} ${fs}px ${font}`;
  const ls = 'letterSpacing' in g;
  if (ls) g.letterSpacing = `${(fs * spacing).toFixed(1)}px`;
  const w = g.measureText(text).width;
  if (w > alongPx) { fs *= alongPx / w; g.font = `${weight} ${fs}px ${font}`; if (ls) g.letterSpacing = `${(fs * spacing).toFixed(1)}px`; }
  if (fs < 2.2) { // too small to read: a faint smudge keeps the livery recognisable
    g.fillStyle = color; g.globalAlpha = 0.35;
    if (vertical) g.fillRect(cx - acrossPx * 0.3, cy - alongPx / 2, acrossPx * 0.6, alongPx); else g.fillRect(cx - alongPx / 2, cy - acrossPx * 0.3, alongPx, acrossPx * 0.6);
    g.globalAlpha = 1;
    return;
  }
  g.save();
  g.translate(cx, cy);
  if (vertical) g.rotate(Math.PI / 2);
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 0, fs * 0.04);
  g.restore();
  if (ls) g.letterSpacing = '0px';
}

function drawFlag(g, x, y, w, h, code) {
  g.save();
  g.translate(x - w / 2, y - h / 2);
  const R = (c, a, b, ww, hh) => { g.fillStyle = c; g.fillRect(a, b, ww, hh); };
  switch (code) {
    case 'USA': for (let i = 0; i < 7; i++) R(i % 2 ? '#eeeeee' : '#b22234', 0, (h * i) / 7, w, h / 7 + 0.5); R('#3c3b6e', 0, 0, w * 0.42, h * 0.54); break;
    case 'CHN': R('#de2910', 0, 0, w, h); g.fillStyle = '#ffde00'; g.beginPath(); g.arc(w * 0.18, h * 0.3, h * 0.14, 0, 7); g.fill(); break;
    case 'IND': R('#ff9933', 0, 0, w, h / 3); R('#f4f4f4', 0, h / 3, w, h / 3); R('#138808', 0, (2 * h) / 3, w, h / 3 + 0.5); g.fillStyle = '#000080'; g.beginPath(); g.arc(w / 2, h / 2, h * 0.12, 0, 7); g.fill(); break;
    case 'JPN': R('#f4f4f4', 0, 0, w, h); g.fillStyle = '#bc002d'; g.beginPath(); g.arc(w / 2, h / 2, h * 0.3, 0, 7); g.fill(); break;
    case 'RUS': R('#f4f4f4', 0, 0, w, h / 3); R('#0039a6', 0, h / 3, w, h / 3); R('#d52b1e', 0, (2 * h) / 3, w, h / 3 + 0.5); break;
    case 'EUR': R('#003399', 0, 0, w, h); g.strokeStyle = '#ffcc00'; g.lineWidth = Math.max(0.6, h * 0.08); g.setLineDash([h * 0.06, h * 0.12]); g.beginPath(); g.arc(w / 2, h / 2, h * 0.3, 0, 7); g.stroke(); break;
    case 'FRA': R('#002395', 0, 0, w / 3, h); R('#f4f4f4', w / 3, 0, w / 3, h); R('#ed2939', (2 * w) / 3, 0, w / 3 + 0.5, h); break;
    default: R('#888', 0, 0, w, h);
  }
  g.restore();
}

function markDecor(G, mk) {
  const { g, prof, kb } = G;
  const y = num(mk.y, 0), h = num(mk.h, 1);
  const r = prof.rAt(clamp(y + h / 2, 0, prof.len));
  const s = num(mk.s, 0);
  const cx = G.X(prof.cxAt ? prof.cxAt(y) + s * r : s * r);
  const cy = G.Y(y + h / 2);
  const fore = Math.sqrt(Math.max(0.05, 1 - s * s));
  switch (mk.type) {
    case 'band': g.fillStyle = mk.color || '#1b1d21'; g.fillRect(0, G.Y(y + h), G.W, h * kb); break;
    case 'stripe': { const w = num(mk.w, 0.4) * kb * fore; g.fillStyle = mk.color || '#1b1d21'; g.fillRect(cx - w / 2, G.Y(y + h), w, h * kb); break; }
    case 'flag': { const fw = Math.min(r * 1.3, h * 1.55) * kb * fore; drawFlag(g, cx, cy, fw, h * kb, mk.country || 'USA'); break; }
    case 'text': drawText(g, mk.text || '', cx, cy, (mk.vertical ? h : num(mk.w, r * 1.6)) * kb, num(mk.size, mk.vertical ? r * 0.62 : h) * kb * fore, { vertical: !!mk.vertical, color: mk.color || '#1b1d21', weight: mk.weight || 700, spacing: num(mk.spacing, 0.12) }); break;
    case 'logo': logoDecor(G, mk, cx, cy, h * kb, r * kb * fore); break;
    case 'window': { // dark rounded window(s) placed around the circumference
      const n = Math.max(1, num(mk.n, 1)), spread = num(mk.spread, 0.9);
      for (let i = 0; i < n; i++) {
        const ph = n === 1 ? s * 1.2 : -spread + (2 * spread * i) / (n - 1);
        const x = G.X(Math.sin(ph) * r), w = num(mk.w, 0.5) * kb * Math.cos(ph);
        if (w < 0.6) continue;
        g.fillStyle = '#0b0e14';
        roundRect(g, x - w / 2, G.Y(y + h), w, h * kb, Math.min(w, h * kb) * 0.35); g.fill();
        g.fillStyle = 'rgba(160,190,230,0.18)'; roundRect(g, x - w / 2 + w * 0.15, G.Y(y + h) + h * kb * 0.12, w * 0.3, h * kb * 0.4, 1); g.fill();
      }
      break;
    }
    case 'patch': { g.fillStyle = mk.color || '#222'; const w = num(mk.w, 0.5) * kb * fore; g.fillRect(cx - w / 2, G.Y(y + h), w, h * kb); break; }
    default: break;
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

function logoDecor(G, mk, cx, cy, hPx, rPx) {
  const { g } = G;
  const kind = mk.logo || mk.text;
  if (kind === 'meatball' || kind === 'NASA_meatball') {
    const R = Math.min(hPx, rPx * 1.2) / 2;
    g.fillStyle = '#0b3d91'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    g.strokeStyle = '#fc3d21'; g.lineWidth = Math.max(0.6, R * 0.16);
    g.beginPath(); g.moveTo(cx - R * 0.9, cy + R * 0.35); g.quadraticCurveTo(cx, cy - R * 0.1, cx + R * 0.9, cy - R * 0.55); g.stroke();
    drawText(g, 'NASA', cx, cy, R * 1.6, R * 0.7, { color: '#fff', weight: 700, spacing: 0.02 });
    return;
  }
  if (kind === 'NASA' || kind === 'worm') { drawText(g, 'NASA', cx, cy, mk.vertical ? hPx : rPx * 1.5, mk.vertical ? rPx * 0.62 : hPx, { vertical: !!mk.vertical, color: mk.color || '#e03c31', weight: 800, spacing: 0.04 }); return; }
  if (kind === 'esa') { drawText(g, 'esa', cx, cy, rPx * 1.2, hPx, { color: mk.color || '#003247', weight: 800, spacing: 0 }); return; }
  if (kind === 'feather') { // Blue Origin feather
    const s = Math.min(hPx, rPx);
    g.fillStyle = mk.color || '#1d3c78';
    g.beginPath(); g.ellipse(cx, cy, s * 0.18, s * 0.5, 0.35, 0, 7); g.fill();
    return;
  }
  drawText(g, String(mk.text || ''), cx, cy, mk.vertical ? hPx : rPx * 1.7, mk.vertical ? rPx * 0.6 : hPx, { vertical: !!mk.vertical, color: mk.color || '#1b1d21', weight: 800, spacing: num(mk.spacing, 0.1) });
}

// ------------------------------------------------------------------ parts → bodies

const BODYC = new WeakMap();
/** Body description for a launch-vehicle part (cached per part object). */
function partBody(stack, p) {
  let b = BODYC.get(p);
  if (b) return b;
  const baseId = String(p.id || 'part').replace(/:[LR]$/, '');
  const owner = p.payload ? `c:${stack?.craftId || ''}` : `v:${stack?.vehicleId || ''}`;
  b = {
    id: `${owner}|${baseId}|${p.role}`,
    segs: lesSegs(p) || p.segs, len: p.len, d: p.d, dTop: p.dTop, nose: p.nose, mat: p.mat, tint: p.tint, noseFrac: p.noseFrac, tipD: p.tipD, role: p.role,
    skew: p.skew ? -Math.sign(p.x || 0) || 0 : 0,
    soot: num(p.soot, 0), sootColor: p.sootColor,
    frost: num(p.frost, 0), frostZones: p.frostZones, frostSharp: p.mat === 'stainless',
    seamEvery: p.seamEvery ?? (p.mat === 'stainless' ? 1.83 : 0), seamStrength: p.seamStrength ?? (p.mat === 'stainless' ? 0.2 : 0.12),
    ringTone: p.mat === 'stainless' ? 0.09 : 0,
    raceway: p.raceway, racewayFrom: p.racewayFrom, racewayTo: p.racewayTo,
    splitLine: p.role === 'fairing' && !p.hippo,
    marks: p.marks, seed: hash(baseId + owner),
    decor: partDecor(p),
  };
  BODYC.set(p, b);
  return b;
}

/** LES/escape tower shroud segments from {len, d, dTop, towerLen}. */
function lesSegs(p) {
  if (p.nose !== 'tower') return null;
  const tl = num(p.towerLen, 6), sh = Math.max(1, p.len - tl);
  const dt = Math.max(0.3, num(p.dTop, 0.6));
  const cyl = num(p.shroudCyl, 0.42);
  return [
    { len: sh * cyl, d: p.d, mat: p.mat },
    { len: sh * (1 - cyl), d: p.d, dTop: dt * 1.35, shape: 'easeOut', mat: p.mat },
    { len: tl * 0.12, d: dt * 1.35, dTop: dt * 0.7, mat: 'grey_paint' },                          // jettison motor skirt
    { len: tl * 0.5, d: dt * 0.7, dTop: dt * 0.75, mat: p.towerMat || 'white_paint', ribs: true }, // abort motor
    { len: tl * 0.13, d: dt * 0.75, mat: 'grey_paint' },                                         // attitude control ring
    { len: tl * 0.25, d: dt * 0.75, dTop: 0.12, shape: 'ogive', mat: p.towerMat || 'white_paint' },
  ];
}

function partDecor(p) {
  if (p.role === 'les') {
    return (G) => {
      const { g, prof, kb } = G;
      const sg = prof.segs[4];
      if (!sg) return;
      g.fillStyle = '#111';
      for (let i = -1; i <= 1; i++) { const x = G.X(i * prof.rAt(sg.y0 + 0.1) * 0.6); g.beginPath(); g.arc(x, G.Y(sg.y0 + sg.len / 2), Math.max(0.7, 0.07 * kb), 0, 7); g.fill(); }
    };
  }
  return null;
}

// ------------------------------------------------------------------ engines

/** Real engine arrangement projected on the side view: [{x, depth}] (metres; depth > 0 = toward viewer). */
const LAYC = new Map();
function engineLayout(e, d) {
  const key = `${e.n}|${e.layout}|${d}|${e.bellD}`;
  let out = LAYC.get(key);
  if (out) return out;
  const n = Math.max(1, Math.min(40, num(e.n, 1)));
  const bd = num(e.bellD, 1);
  const Rmax = Math.max(0, (d - bd) / 2) * 0.98;
  out = [];
  const ring = (k, R, a0 = 0) => { for (let i = 0; i < k; i++) { const a = a0 + (2 * Math.PI * i) / k; out.push({ x: Math.cos(a) * R, depth: Math.sin(a) }); } };
  if (n === 1 || e.layout === 'single') out.push({ x: 0, depth: 0 });
  else if (e.layout === 'pair' || n === 2) { const R = Math.min(Rmax, bd * 0.58); out.push({ x: -R, depth: 0 }, { x: R, depth: 0 }); }
  else if (e.layout === 'octaweb') { ring(n - 1, Math.min(Rmax, d * 0.36), Math.PI / 8); out.push({ x: 0, depth: 0 }); }
  else if (n >= 30) { ring(20, Math.min(Rmax, d * 0.45), 0.1); ring(10, d * 0.28, 0.2); ring(3, d * 0.08, 0.5); }
  else if (n >= 5 && e.layout !== 'cluster') { ring(n - 1, Math.min(Rmax, d * 0.32), Math.PI / (n - 1)); out.push({ x: 0, depth: 0 }); }
  else if (n === 5) { ring(4, Math.min(Rmax, d * 0.3), Math.PI / 4); out.push({ x: 0, depth: 0 }); }
  else ring(n, Math.min(Rmax, Math.max(bd * 0.6, d * 0.26)), Math.PI / 4);
  out.sort((a, b) => a.depth - b.depth);
  LAYC.set(key, out);
  return out;
}

function nozzleMat(e) {
  if (e.mat) return e.mat;
  if (e.prop === 'solid') return 'srb_nozzle';
  if (e.vac && e.prop === 'kerolox') return 'nozzle_niobium';
  if (e.prop === 'methalox') return 'nozzle_steel';
  if (e.prop === 'hydrolox') return 'nozzle_bronze';
  return 'nozzle_dark';
}

const BELLC = new Map();
function bellBody(e) {
  const mat = nozzleMat(e);
  const key = `bell|${e.bellD}|${e.bellLen}|${mat}|${e.prop}`;
  let b = BELLC.get(key);
  if (b) return b;
  const D = num(e.bellD, 1), Lb = num(e.bellLen, 1.2);
  const solid = e.prop === 'solid';
  const throat = solid ? 0.55 : 0.36;
  const radExt = e.vac && (e.prop === 'kerolox' || e.prop === 'hydrolox') && D > 1.5; // big radiatively-cooled extension (MVac, RL10C-X)
  b = radExt ? {
    id: key, noEndAO: true, crinkle: false, seed: 17,
    segs: [
      { len: Lb * 0.025, d: D, dTop: D * 0.99, mat },                                   // stiffener ring at the exit
      { len: Lb * 0.66, d: D * 0.99, dTop: D * 0.46, mat },                              // thin niobium / C-C extension: nearly straight cone
      { len: Lb * 0.03, d: D * 0.47, dTop: D * 0.47, mat: 'grey_paint' },                // flange
      { len: Lb * 0.285, d: D * 0.46, dTop: D * 0.2, shape: 'bell', mat: 'nozzle_dark' }, // regeneratively cooled nozzle
      { len: Lb * 0.18, d: D * 0.2, dTop: D * 0.3, mat: 'engine_dark' },                 // chamber / turbopump
    ],
    decor: null,
  } : {
    id: key, noEndAO: true, crinkle: false, seed: 17,
    segs: [
      { len: Lb * 0.06, d: D, dTop: D * 0.985, mat },                                   // exit lip
      { len: Lb * 0.94, d: D * 0.985, dTop: D * throat, shape: 'bell', mat },
      { len: Lb * (solid ? 0.12 : 0.3), d: D * throat, dTop: D * (solid ? 0.6 : 0.46), mat: 'engine_dark' },
    ],
    decor: e.prop !== 'solid' && !e.vac ? (G) => { // regenerative cooling tubes
      const { g, prof, kb } = G;
      if (D * kb < 18) return;
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
      for (let a = -1.4; a <= 1.4; a += 0.18) {
        g.beginPath();
        for (let y = 0; y <= Lb * 0.98; y += Lb / 12) { const x = Math.sin(a) * prof.rAt(y); g.lineTo(G.X(x), G.Y(y)); }
        g.stroke();
      }
    } : null,
  };
  BELLC.set(key, b);
  return b;
}

/** Engine cluster below a part base (ctx origin = part base centre). Back bells first; gimbal about throats. */
function drawEngines(ctx, p, k, fr, { gimbal = 0, glow = 0, front = null } = {}) {
  const e = p.engines;
  if (!e) return;
  const lay = engineLayout(e, num(p.d, 1));
  const body = bellBody(e);
  const Lb = num(e.bellLen, 1.2) * (e.prop === 'solid' ? 1 : 1);
  const top = Lb * (e.prop === 'solid' ? 1.12 : 1.3);
  for (const q of lay) {
    if (front === true && q.depth < -0.05) continue;
    if (front === false && q.depth >= -0.05) continue;
    ctx.save();
    ctx.translate(q.x * k, -(top - Lb) * k * 0 + 0);
    // throat sits at the part base; bell hangs below. Rotate about throat.
    ctx.translate(0, (top - Lb) * k * 0);
    ctx.rotate(gimbal * (0.7 + 0.3 * q.depth));
    ctx.translate(0, Lb * k);
    // shrink back bells a touch (perspective) and keep them under the front ones
    drawBody(ctx, body, k, fr);
    if (q.depth < -0.3) { ctx.globalAlpha = 0.35; ctx.fillStyle = '#000'; ctx.fillRect(-num(e.bellD, 1) * k * 0.5, -Lb * k, num(e.bellD, 1) * k, Lb * k); ctx.globalAlpha = 1; }
    if (glow > 0) nozzleGlow(ctx, e, k, glow);
    ctx.restore();
  }
}

function nozzleGlow(ctx, e, k, glow) {
  const D = num(e.bellD, 1), Lb = num(e.bellLen, 1.2);
  if (e.vac && D > 1.5 && (e.prop === 'kerolox' || e.prop === 'hydrolox')) {
    // radiatively cooled extension: white-orange where it joins the hot nozzle, cooling to dull red at the exit
    const hTop = Lb * 0.69 * k;
    const gr = ctx.createLinearGradient(0, 0, 0, -hTop);
    const a = clamp(glow, 0, 1);
    gr.addColorStop(0, `rgba(150,30,10,${(0.35 * a).toFixed(3)})`);
    gr.addColorStop(0.45, `rgba(235,90,30,${(0.62 * a).toFixed(3)})`);
    gr.addColorStop(0.85, `rgba(255,170,80,${(0.9 * a).toFixed(3)})`);
    gr.addColorStop(1, `rgba(255,214,140,${(0.95 * a).toFixed(3)})`);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = gr;
    // radial falloff across the cone (limb darker): two passes, narrow core brighter
    for (const [wk, al] of [[1, 0.7], [0.62, 0.5]]) {
      ctx.globalAlpha = al;
      ctx.beginPath(); ctx.moveTo(-D * k * 0.495 * wk, 0); ctx.lineTo(-D * k * 0.23 * wk, -hTop); ctx.lineTo(D * k * 0.23 * wk, -hTop); ctx.lineTo(D * k * 0.495 * wk, 0); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    return;
  }
  const gr = ctx.createLinearGradient(0, 0, 0, -Lb * k * 0.8);
  gr.addColorStop(0, `rgba(255,150,60,${(0.75 * glow).toFixed(3)})`);
  gr.addColorStop(0.35, `rgba(220,70,25,${(0.45 * glow).toFixed(3)})`);
  gr.addColorStop(1, 'rgba(120,20,10,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.moveTo(-D * k * 0.49, 0); ctx.lineTo(-D * k * 0.3, -Lb * k * 0.8); ctx.lineTo(D * k * 0.3, -Lb * k * 0.8); ctx.lineTo(D * k * 0.49, 0);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ------------------------------------------------------------------ live extras (grid fins, legs, fins…)

function gridFinFace(ctx, x, y, w, h, L, mat = 'nozzle_dark') {
  ctx.fillStyle = litCss(mat, [0, 0.2, 0.98], L);
  ctx.fillRect(x, y, w, h);
  const cells = Math.max(2, Math.min(9, Math.round(Math.min(w, h) / 2.2)));
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = Math.max(0.5, w / 40);
  ctx.beginPath();
  for (let i = 1; i < cells; i++) {
    const a = (i / cells) * (w + h);
    ctx.moveTo(x + Math.min(a, w), y + Math.max(0, a - w)); ctx.lineTo(x + Math.max(0, a - h), y + Math.min(a, h));
    ctx.moveTo(x + w - Math.min(a, w), y + Math.max(0, a - w)); ctx.lineTo(x + w - Math.max(0, a - h), y + Math.min(a, h));
  }
  ctx.stroke();
  ctx.strokeStyle = litCss(mat, [0, 0.6, 0.8], L); ctx.lineWidth = Math.max(0.6, w / 18);
  ctx.strokeRect(x, y, w, h);
}

/** Grid fins at the top of a part. out: 0 folded … 1 deployed. fixed = Super Heavy style. */
function drawGridFins(ctx, p, k, fr, out, layer) {
  const prof = profileOf(partBodyLite(p));
  const fixed = p.gridFins === 'fixed';
  const o = fixed ? 1 : clamp(out, 0, 1);
  const size = num(p.gridFinSize, fixed ? p.d * 0.5 : p.d * 0.4);
  const chord = size * 0.18;
  const yH = prof.len - num(p.gridFinFromTop, fixed ? 2.2 : 1.1);
  const r = prof.rAt(yH);
  const L = fr.Lx;
  const ang = (1 - o) * (Math.PI / 2); // 0 = sticking out, π/2 = folded up
  if (layer === 'side') {
    for (const sx of [-1, 1]) {
      ctx.save();
      ctx.translate(sx * r * k, -yH * k);
      ctx.rotate(-sx * ang);
      const w = size * k, h = Math.max(1.2, chord * (fixed ? 1.8 : 1) * k);
      const x0 = sx > 0 ? 0 : -w;
      const gr = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
      gr.addColorStop(0, litCss(fixed ? 'stainless' : 'nozzle_dark', [sx * 0.2, 0.95, 0.2], L));
      gr.addColorStop(1, litCss(fixed ? 'stainless' : 'nozzle_dark', [sx * 0.2, -0.6, 0.5], L));
      ctx.fillStyle = gr;
      ctx.fillRect(x0, -h / 2, w, h);
      if (w > 14) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; for (let i = 1; i < 4; i++) ctx.fillRect(x0 + (w * i) / 4, -h / 2, Math.max(0.5, w / 80), h); }
      // hinge/actuator block
      ctx.fillStyle = litCss('engine_dark', [sx * 0.5, 0.3, 0.8], L);
      ctx.fillRect(sx > 0 ? -0.15 * k : -0.25 * k + 0.1 * k, -h * 0.9, 0.4 * k, h * 1.8);
      ctx.restore();
    }
  } else if (!fixed) { // the fin facing the viewer: lattice face while folded, edge-on when deployed
    const h = size * Math.sin(ang) + chord * Math.cos(ang);
    const w = size * 0.8;
    if (h * k > 1) gridFinFace(ctx, -w * k / 2, -(yH + (size * Math.sin(ang)) * 0.9) * k, w * k, Math.max(1, h * k), L);
  }
}
const LITE = new WeakMap();
function partBodyLite(p) { let b = LITE.get(p); if (!b) { b = { id: 'lite', segs: p.segs, len: p.len, d: p.d, dTop: p.dTop, nose: p.nose, mat: p.mat, role: p.role }; LITE.set(p, b); } return b; }

/** Falcon-style landing legs hinged near the base. out 0 = folded against the stage, 1 = deployed. */
function drawStageLegs(ctx, p, k, fr, out, front) {
  const n = num(p.legs, 0);
  if (!n) return;
  const prof = profileOf(partBodyLite(p));
  const r = prof.rAt(0.5);
  const legL = num(p.legLen, p.d * 2.4);
  const hinge = 0.4;
  const alpha = clamp(out, 0, 1) * 2.05; // 0 = up along the body, ~117° = down/out
  const L = fr.Lx;
  for (let i = 0; i < n; i++) {
    const th = (Math.PI * 2 * i) / n + (n === 4 ? Math.PI / 4 : 0);
    const cx = Math.cos(th), dz = Math.sin(th);
    if (front && dz < -0.05) continue;
    if (!front && dz >= -0.05) continue;
    const bx = cx * r, by = hinge;
    const tx = bx + Math.sin(alpha) * cx * legL, ty = by + Math.cos(alpha) * legL;
    const w = 0.75 * Math.max(0.35, Math.abs(dz) * 0.6 + 0.4);
    ctx.save();
    if (dz < -0.05) ctx.globalAlpha = 0.85;
    // leg: tapered carbon beam
    const ax = bx * k, ay = -by * k, ex = tx * k, ey = -ty * k;
    const len = Math.hypot(ex - ax, ey - ay) || 1;
    const px = -(ey - ay) / len, py = (ex - ax) / len;
    ctx.fillStyle = tubeFill(ctx, ax, ay, ex, ey, w * k * 0.5, 'carbon_black', L);
    ctx.beginPath();
    ctx.moveTo(ax + px * w * k * 0.5, ay + py * w * k * 0.5); ctx.lineTo(ex + px * w * k * 0.3, ey + py * w * k * 0.3);
    ctx.lineTo(ex - px * w * k * 0.3, ey - py * w * k * 0.3); ctx.lineTo(ax - px * w * k * 0.5, ay - py * w * k * 0.5);
    ctx.closePath(); ctx.fill();
    if (out > 0.05) { // telescoping strut + footpad
      const sx2 = cx * r * k, sy2 = -(hinge + legL * 0.55) * k;
      const mx = ax + (ex - ax) * 0.55, my = ay + (ey - ay) * 0.55;
      ctx.strokeStyle = litCss('bare_aluminium', [0, 0.3, 0.95], L); ctx.lineWidth = Math.max(0.8, 0.18 * k);
      ctx.beginPath(); ctx.moveTo(sx2, sy2); ctx.lineTo(mx, my); ctx.stroke();
      ctx.fillStyle = litCss('carbon_black', [0, 1, 0.2], L);
      ctx.beginPath(); ctx.ellipse(ex, ey, Math.max(1, 0.45 * k), Math.max(0.6, 0.16 * k), 0, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
}

/** Fixed fins / air rudders / strakes / Starship flaps. */
function drawFins(ctx, p, k, fr) {
  const L = fr.Lx;
  const prof = profileOf(partBodyLite(p));
  const sides = p.x ? [Math.sign(p.x)] : [-1, 1];
  if (p.fins) {
    const h = num(p.finH, Math.min(3.2, prof.len * 0.16)), span = num(p.finSpan, p.d * 0.45);
    for (const sx of sides) {
      const r = prof.rAt(0.5);
      ctx.fillStyle = litCss(p.finMat || p.mat || 'white_paint', [sx * 0.3, 0.1, 0.95], L);
      ctx.beginPath();
      ctx.moveTo(sx * r * k, -0.2 * k); ctx.lineTo(sx * (r + span) * k, -0.2 * k);
      ctx.lineTo(sx * (r + span) * k, -(h * 0.55) * k); ctx.lineTo(sx * r * k, -h * k);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = Math.max(0.5, 0.05 * k); ctx.stroke();
    }
  }
  if (p.strakes) { // New Glenn aft strakes
    for (const sx of [-1, 1]) {
      const r = prof.rAt(1);
      ctx.fillStyle = litCss('white_paint', [sx * 0.4, 0, 0.9], L);
      ctx.beginPath();
      ctx.moveTo(sx * r * k, -0.6 * k); ctx.lineTo(sx * (r + 1.5) * k, -0.9 * k); ctx.lineTo(sx * (r + 0.05) * k, -prof.len * 0.24 * k);
      ctx.closePath(); ctx.fill();
    }
  }
  if (p.canards) { // forward folding fins (New Glenn, Neutron)
    for (const sx of [-1, 1]) {
      const y = prof.len - num(p.canardFromTop, 3), r = prof.rAt(y);
      ctx.fillStyle = litCss(p.canardMat || 'carbon_black', [sx * 0.3, 0.2, 0.9], L);
      ctx.beginPath();
      ctx.moveTo(sx * r * k, -(y + 1.6) * k); ctx.lineTo(sx * (r + 1.2) * k, -(y + 0.7) * k); ctx.lineTo(sx * (r + 1.2) * k, -(y - 0.6) * k); ctx.lineTo(sx * r * k, -(y - 1.2) * k);
      ctx.closePath(); ctx.fill();
    }
  }
  if (p.flaps) drawFlaps(ctx, prof, k, L, p.tiles !== false);
}

function drawFlaps(ctx, prof, k, L, tiled) {
  const len = prof.len;
  const flaps = [
    { y0: 1.2, y1: 10.5, out: 3.6, tipH: 0.55 },                  // aft flaps
    { y0: len - 15.5, y1: len - 7.5, out: 2.4, tipH: 0.5 },       // forward flaps (on the ogive)
  ];
  for (const f of flaps) {
    for (const sx of [-1, 1]) {
      const r0 = prof.rAt(f.y0), r1 = prof.rAt(f.y1);
      const mat = sx < 0 && tiled ? 'tile_black' : 'stainless';
      const gr = ctx.createLinearGradient(sx * r0 * k, 0, sx * (r0 + f.out) * k, 0);
      gr.addColorStop(0, litCss(mat, [sx * 0.15, 0.1, 0.98], L));
      gr.addColorStop(1, litCss(mat, [sx * 0.45, 0.25, 0.86], L));
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(sx * (r0 - 0.1) * k, -f.y0 * k);
      ctx.lineTo(sx * (r0 + f.out) * k, -(f.y0 + 0.4) * k);
      ctx.lineTo(sx * (r0 + f.out * 0.92) * k, -(f.y0 + (f.y1 - f.y0) * f.tipH) * k);
      ctx.lineTo(sx * (r1 - 0.1) * k, -f.y1 * k);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = Math.max(0.5, 0.06 * k); ctx.stroke();
      if (sx > 0 && tiled) { // tile edge visible on the steel flap
        ctx.strokeStyle = litCss('tile_black', [0.3, 0, 0.95], L); ctx.lineWidth = Math.max(0.8, 0.25 * k);
        ctx.beginPath(); ctx.moveTo(sx * (r0 + f.out) * k, -(f.y0 + 0.4) * k); ctx.lineTo(sx * (r0 + f.out * 0.92) * k, -(f.y0 + (f.y1 - f.y0) * f.tipH) * k); ctx.stroke();
      }
    }
  }
}

/** Escape tower motor nozzles (canted) + Soyuz-style shroud grid fins. */
function drawLesExtras(ctx, p, k, fr) {
  const prof = profileOf(partBody(null, p));
  const segs = prof.segs;
  const L = fr.Lx;
  const motor = segs[3];
  if (motor) {
    const y = motor.y0 + motor.len * 0.22, r = prof.rAt(y);
    for (const sx of [-1, 1]) {
      ctx.save();
      ctx.translate(sx * r * k, -y * k);
      ctx.rotate(sx * 0.6);
      ctx.fillStyle = litCss('nozzle_dark', [sx * 0.5, -0.3, 0.8], L);
      ctx.beginPath(); ctx.moveTo(-0.12 * k, 0); ctx.lineTo(0.12 * k, 0); ctx.lineTo(0.22 * k, 0.6 * k); ctx.lineTo(-0.22 * k, 0.6 * k); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  if (p.gridFins) {
    const y = segs[0].len * 0.55, r = prof.rAt(y), s = p.d * 0.32;
    gridFinFace(ctx, -s * 0.4 * k, -(y + s) * k, s * 0.8 * k, s * k, L, 'grey_paint');
    for (const sx of [-1, 1]) { ctx.fillStyle = litCss('grey_paint', [sx, 0, 0.3], L); ctx.fillRect(sx > 0 ? r * k : -(r + 0.15) * k, -(y + s) * k, 0.15 * k, s * k); }
  }
}

/** Short struts between a side booster and the core (side view). */
function drawBoosterStruts(ctx, stack, p, k, fr) {
  if (!p.x || p.skew || p.depth) return;
  const core = (stack?.parts || []).find((q) => !q.x && (q.role === 'stage'));
  if (!core) return;
  const cp = profileOf(partBodyLite(core)), bp = profileOf(partBodyLite(p));
  const sx = -Math.sign(p.x);
  for (const f of [0.12, 0.86]) {
    const yB = bp.len * f, yAbs = p.y + yB;
    const gap = Math.abs(p.x) - bp.rAt(yB) - cp.rAt(clamp(yAbs - core.y, 0, cp.len));
    if (gap <= 0.05) continue;
    ctx.fillStyle = litCss('grey_paint', [0, 1, 0.3], fr.Lx);
    ctx.fillRect(sx > 0 ? bp.rAt(yB) * k : -(bp.rAt(yB) + gap) * k, -(yB + 0.25) * k, gap * k, Math.max(1, 0.5 * k));
  }
}

// ------------------------------------------------------------------ painters (contract)

/** One part, origin at the part's base centre. part.id ending in ':L' / ':R' draws one fairing half. */
export function paintPart(ctx, stack, part, { pxPerM = 4, light = SUN, tilt = 0, finsOut = false, legsOut = 0, showHiddenEngines = false, gimbal = 0, glow = 0, frost = 0, variant = null } = {}) {
  if (!part || !ctx) return;
  const k = Math.max(0.01, num(pxPerM, 4));
  const half = /:L$/.test(part.id || '') ? 'L' : /:R$/.test(part.id || '') ? 'R' : null;
  const fr = frameOf(ctx, light, tilt);
  const body = variant ? variantBody(stack, part, variant) : partBody(stack, part);
  const fins = finsOut === true ? 1 : num(finsOut, 0);
  ctx.save();
  if (half) {
    const w = (Math.max(part.d || 1, part.dTop || 0) + 2) * k;
    ctx.beginPath(); ctx.rect(half === 'L' ? -w : 0, -(part.len + 2) * k, w, (part.len + 4) * k); ctx.clip();
  }
  const engines = part.engines && (!part.engines.hidden || showHiddenEngines);
  if (engines) drawEngines(ctx, part, k, fr, { gimbal, glow });
  if (part.legs && part.role !== 'les') drawStageLegs(ctx, part, k, fr, legsOut, false);
  if (part.gridFins && part.role !== 'les') drawGridFins(ctx, part, k, fr, fins, 'side');
  drawBody(ctx, body, k, fr, frost * num(part.frost, 0) > 0 ? frost : 0);
  if (half) { // cut edge of the half shell
    ctx.fillStyle = 'rgba(25,27,30,0.6)';
    ctx.fillRect(half === 'L' ? -Math.max(1, 0.06 * k) : 0, -part.len * k, Math.max(1, 0.06 * k), part.len * k);
  }
  if (part.gridFins && part.role !== 'les') drawGridFins(ctx, part, k, fr, fins, 'front');
  if (part.legs && part.role !== 'les') drawStageLegs(ctx, part, k, fr, legsOut, true);
  drawFins(ctx, part, k, fr);
  if (part.role === 'les') drawLesExtras(ctx, part, k, fr);
  if (part.struts !== false) drawBoosterStruts(ctx, stack, part, k, fr);
  ctx.restore();
}

/** Variant bodies: Orion ESM without the SAJ panels, etc. */
const VARC = new WeakMap();
function variantBody(stack, part, variant) {
  let m = VARC.get(part);
  if (!m) { m = {}; VARC.set(part, m); }
  if (m[variant]) return m[variant];
  const b = { ...partBody(stack, part) };
  delete b._prof;
  if (variant === 'esm') {
    b.id += '|esm'; b.segs = [{ len: part.len * 0.12, d: part.d * 0.8, mat: 'engine_dark' }, { len: part.len * 0.68, d: part.d * 0.8, mat: 'silver_foil' }, { len: part.len * 0.2, d: part.d * 0.8, dTop: part.d, mat: 'white_paint' }];
    b.splitLine = false; b.marks = null; b.decor = null;
  }
  m[variant] = b;
  return b;
}

/** Attached stack at the ctx origin (base centre, y up). */
export function paintVehicle(ctx, stack, { pxPerM = 4, light = SUN, tilt = 0, flags = {}, frost = 0, t = 0, reduce = false, gimbal, fairingOpen = 0, legsOut = 0 } = {}) {
  if (!stack || !ctx) return { topM: 0, widthM: 0 };
  const k = Math.max(0.01, num(pxPerM, 4));
  const att = attachedParts(stack, flags);
  const firstUpper = flags.staged ? att.find((p) => p.role === 'upper' && p.engines) : null;
  const order = [...att].sort((a, b) => (a.depth || 0) - (b.depth || 0) || (a.x ? 1 : 0) - (b.x ? 1 : 0) || (a.payload ? 1 : 0) - (b.payload ? 1 : 0) || (a.y - b.y));
  const fireOn = !!flags.engineOn && !flags.exploded;
  const gim = gimbal != null ? num(gimbal, 0) : fireOn && !reduce ? Math.sin(t * 1.7) * 0.025 + Math.sin(t * 4.3) * 0.01 : 0;
  let topM = 0;
  const lesOn = att.some((q) => q.role === 'les');
  for (const p of order) {
    if (p.hiddenUntil === 'staging' && !flags.staged) continue;
    if (p.role === 'payload' && att.some((q) => q.role === 'les' && q.y <= p.y)) continue; // under the LES cover
    ctx.save();
    ctx.translate((p.x || 0) * k, -(p.y || 0) * k);
    const firing = fireOn && (flags.staged ? p === firstUpper : (p.role === 'stage' || p.role === 'booster'));
    const variant = p.payload && p.panels && (flags.fairingOff || !lesOn) ? 'esm' : null;
    if (p.role === 'fairing' && fairingOpen > 0) {
      for (const h of ['L', 'R']) {
        ctx.save();
        const sx = h === 'L' ? -1 : 1;
        ctx.translate(sx * (p.d / 2) * k, 0);
        ctx.rotate(sx * fairingOpen * 0.5);
        ctx.translate(-sx * (p.d / 2) * k, 0);
        paintPart(ctx, stack, { ...p, id: `${p.id}:${h}` }, { pxPerM: k, light, tilt });
        ctx.restore();
      }
    } else {
      paintPart(ctx, stack, p, {
        pxPerM: k, light, tilt, showHiddenEngines: p === firstUpper, gimbal: firing ? gim : 0,
        glow: firing && p.engines?.vac ? 0.85 : 0, frost, variant, legsOut: p.role === 'stage' ? legsOut : 0,
      });
    }
    ctx.restore();
    topM = Math.max(topM, p.y + p.len);
  }
  // payload exposed after fairing separation
  if (stack.payload === 'fairing' && flags.fairingOff && !flags.exploded) {
    const fair = stack.parts.find((p) => p.role === 'fairing');
    const upper = [...att].filter((p) => !p.x).sort((a, b) => b.y + b.len - (a.y + a.len))[0];
    if (fair && upper && (!flags.staged || upper.role !== 'stage')) {
      const y0 = upper.y + upper.len;
      ctx.save();
      ctx.translate(0, -y0 * k);
      paintPayload(ctx, stack, fair, upper, k, light);
      ctx.restore();
    }
  }
  return { topM, widthM: stack.maxWidthM };
}

function paintPayload(ctx, stack, fair, upper, k, light) {
  const fr = frameOf(ctx, light, 0);
  const dU = Math.min(num(upper.dTop, upper.d), upper.d);
  const paf = { id: `paf|${stack.vehicleId}`, segs: [{ len: 1.1, d: dU * 0.92, dTop: Math.min(1.7, dU * 0.45), mat: 'grey_paint' }, { len: 0.25, d: 1.7, mat: 'bare_aluminium' }] };
  drawBody(ctx, paf, k, fr);
  const c = stack.craft || BUILTIN_CRAFT;
  const dims = craftStackDims(c);
  const f = Math.min(1, (fair.d * 0.82) / Math.max(0.5, dims.w), (fair.len * 0.75) / Math.max(0.5, dims.h));
  ctx.translate(0, -1.35 * k);
  paintCraft(ctx, c, { pxPerM: k * f, light, mode: 'stack', legs: 0 });
}

// ------------------------------------------------------------------ spacecraft

function craftStackDims(c) {
  const t = c.template;
  if (t === 'probe') return { w: num(c.bus?.w, 2) + 0.8, h: num(c.bus?.h, 2.5) + num(c.hga?.d, 1) * 0.35 + 0.6 };
  if (t === 'module') return { w: num(c.d, 4) + 0.8, h: num(c.len, 8) };
  if (t === 'lander' || t === 'rotorcraft') return { w: num(c.bodyW, c.widthM) * 1.25, h: num(c.heightM, 3) };
  if (t === 'capsule') return { w: num(c.shieldD, 4), h: num(c.capH, 3.4) + num(c.sm?.h, 3) + 1 };
  if (t === 'capsule_sm') return { w: num(c.service?.d, 2.7), h: num(c.heightM, 7) };
  if (t === 'aeroshell') return { w: num(c.shellD, 4), h: num(c.shellD, 4) * 0.7 };
  if (t === 'rover') return { w: num(c.widthM, 2), h: num(c.heightM, 1.6) };
  return { w: num(c.widthM, 3), h: num(c.heightM, 3) };
}

const CRAFTC = new WeakMap();
function cid(c) { let id = CRAFTC.get(c); if (!id) { id = `craft:${c.name || ''}:${c.template || ''}:${hash(JSON.stringify(c).slice(0, 400))}`; CRAFTC.set(c, id); } return id; }
const CBODY = new Map();
function cbody(c, name, make) {
  const key = `${cid(c)}|${name}`;
  let b = CBODY.get(key);
  if (!b) { b = { id: key, seed: hash(key), ...make() }; CBODY.set(key, b); }
  return b;
}
function drawAt(ctx, body, x, y, k, fr, frostA = 0) {
  ctx.save(); ctx.translate(x * k, -y * k); drawBody(ctx, body, k, fr, frostA); ctx.restore();
}

/** Flat solar array panel(s) from x0 to x1 (metres) centred at y, height h; foreshortening f (0..1). */
function drawPanel(ctx, k, L, x0, x1, y, h, { panels = 1, gap = 0.12, cellM = 0.45, color = '#18224a', frame = 'bare_aluminium', tilt = 0, shade = 0 } = {}) {
  const dir = Math.sign(x1 - x0) || 1;
  const len = Math.abs(x1 - x0);
  const pl = (len - gap * (panels - 1)) / panels;
  const n = [0.0, 0.25, 0.97];
  const lum = litLin('solar_cell', n, L, color);
  const sheen = Math.max(0, L[0] * dir * 0.4 + L[1] * 0.5 + 0.3);
  for (let i = 0; i < panels; i++) {
    const a = x0 + dir * (i * (pl + gap)), b = a + dir * pl;
    const X0 = Math.min(a, b) * k, W = pl * k, Y0 = -(y + h / 2) * k + tilt * (i + 0.5) * k, Hh = h * k;
    const gr = ctx.createLinearGradient(X0, Y0, X0 + W, Y0 + Hh);
    gr.addColorStop(0, cssLin(lum.map((v) => v * (1.2 + sheen * 1.6) * (1 - shade))));
    gr.addColorStop(0.55, cssLin(lum.map((v) => v * (0.8) * (1 - shade))));
    gr.addColorStop(1, cssLin(lum.map((v) => v * (1 + sheen) * (1 - shade))));
    ctx.fillStyle = gr;
    ctx.fillRect(X0, Y0, W, Hh);
    const cpx = cellM * k;
    if (cpx > 2.2) {
      ctx.strokeStyle = 'rgba(150,170,220,0.2)'; ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let x = X0 + cpx; x < X0 + W - 0.5; x += cpx) { ctx.moveTo(x, Y0); ctx.lineTo(x, Y0 + Hh); }
      for (let yy = Y0 + cpx; yy < Y0 + Hh - 0.5; yy += cpx) { ctx.moveTo(X0, yy); ctx.lineTo(X0 + W, yy); }
      ctx.stroke();
    }
    ctx.strokeStyle = litCss(frame, [0, 0.5, 0.85], L); ctx.lineWidth = Math.max(0.6, 0.05 * k);
    ctx.strokeRect(X0, Y0, W, Hh);
  }
}

function drawDisc(ctx, k, L, cx, cy, R, { color = '#18224a', squash = 1, ribs = 10, edge = false } = {}) { // UltraFlex circular array
  if (edge) { // almost edge-on: lit cell face sliver, dark back, bright rim tube; ribs read as converging lines
    const lumF = litLin('solar_cell', [0, 0.85, 0.5], L, color);
    ctx.save(); ctx.translate(cx * k, -cy * k);
    const rx = R * k, ry = Math.max(0.9, R * k * squash);
    ctx.fillStyle = litCss('black_paint', [0, -0.6, 0.6], L);
    ctx.beginPath(); ctx.ellipse(0, ry * 0.35, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    const gr = ctx.createLinearGradient(-rx, 0, rx, 0);
    gr.addColorStop(0, cssLin(lumF.map((v) => v * 1.6))); gr.addColorStop(0.5, cssLin(lumF.map((v) => v * 0.9))); gr.addColorStop(1, cssLin(lumF.map((v) => v * 1.3)));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(190,198,210,0.45)'; ctx.lineWidth = Math.max(0.4, 0.025 * k);
    ctx.beginPath(); for (let i = 0; i < ribs; i++) { const a = (i / ribs) * Math.PI * 2; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * rx, Math.sin(a) * ry); } ctx.stroke();
    ctx.strokeStyle = litCss('bare_aluminium', [0, 0.6, 0.8], L); ctx.lineWidth = Math.max(0.6, 0.05 * k);
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return;
  }
  const lum = litLin('solar_cell', [0, 0.3, 0.95], L, color);
  ctx.save();
  ctx.translate(cx * k, -cy * k); ctx.scale(1, squash);
  const gr = ctx.createRadialGradient(-R * k * 0.3, -R * k * 0.3, 0, 0, 0, R * k);
  gr.addColorStop(0, cssLin(lum.map((v) => v * 2.2))); gr.addColorStop(1, cssLin(lum.map((v) => v * 0.8)));
  ctx.fillStyle = gr;
  ctx.beginPath();
  for (let i = 0; i < ribs; i++) { const a = (i / ribs) * Math.PI * 2; ctx.lineTo(Math.cos(a) * R * k, Math.sin(a) * R * k); }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(200,205,215,0.55)'; ctx.lineWidth = Math.max(0.5, 0.04 * k);
  ctx.beginPath(); for (let i = 0; i < ribs; i++) { const a = (i / ribs) * Math.PI * 2; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R * k, Math.sin(a) * R * k); } ctx.stroke();
  ctx.restore();
}

function drawDish(ctx, k, L, cx, cy, D, { tilt = -0.25, mat = 'white_paint' } = {}) { // high-gain antenna (seen obliquely)
  ctx.save();
  ctx.translate(cx * k, -cy * k); ctx.rotate(tilt);
  const R = (D / 2) * k;
  ctx.fillStyle = tubeFill(ctx, -R, 0, R, 0, R * 0.3, mat, L);
  ctx.beginPath(); ctx.ellipse(0, 0, R, R * 0.32, 0, 0, Math.PI); ctx.fill();             // convex back
  ctx.fillStyle = litCss(mat, [-0.2, 0.9, 0.35], L);
  ctx.beginPath(); ctx.ellipse(0, 0, R, R * 0.22, 0, 0, Math.PI * 2); ctx.fill();         // dish face
  ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.ellipse(R * 0.1, R * 0.03, R * 0.75, R * 0.15, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = litCss('bare_aluminium', [0, 0.5, 0.8], L); ctx.lineWidth = Math.max(0.5, 0.04 * k);
  ctx.beginPath(); ctx.moveTo(-R * 0.6, 0); ctx.lineTo(0, -R * 0.55); ctx.lineTo(R * 0.6, 0); ctx.stroke();
  ctx.fillStyle = litCss('bare_aluminium', [0, 0.8, 0.5], L); ctx.beginPath(); ctx.arc(0, -R * 0.55, Math.max(0.8, R * 0.08), 0, 7); ctx.fill();
  ctx.restore();
}

function drawStrut(ctx, k, L, x0, y0, x1, y1, wM, mat = 'bare_aluminium') {
  const ax = x0 * k, ay = -y0 * k, bx = x1 * k, by = -y1 * k;
  ctx.strokeStyle = tubeFill(ctx, ax, ay, bx, by, Math.max(0.5, (wM * k) / 2), mat, L);
  ctx.lineWidth = Math.max(0.8, wM * k); ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
}

function drawBell(ctx, k, fr, x, yThroat, e, { glow = 0, angle = 0 } = {}) {
  ctx.save();
  ctx.translate(x * k, -yThroat * k);
  ctx.rotate(angle);
  ctx.translate(0, num(e.bellLen, 0.6) * k);
  drawBody(ctx, bellBody({ prop: e.prop || 'hypergolic', bellD: num(e.bellD, 0.5), bellLen: num(e.bellLen, 0.6), vac: true, mat: e.mat }), k, fr);
  if (glow) nozzleGlow(ctx, { bellD: num(e.bellD, 0.5), bellLen: num(e.bellLen, 0.6) }, k, glow);
  ctx.restore();
}

/** Lander legs: n legs around the body; drawn back (front=false) or front (front=true). */
function drawLanderLegs(ctx, k, L, g, legs, compress, front) {
  const n = g.n;
  for (let i = 0; i < n; i++) {
    const th = g.th0 + (Math.PI * 2 * i) / n;
    const cx = Math.cos(th), dz = Math.sin(th);
    if (front && dz < -0.05) continue;
    if (!front && dz >= -0.05) continue;
    const dy = -g.stroke * compress;
    const ax = g.attachR * cx, ay = g.attachY + dy;
    const fxD = (g.span / 2) * cx, fyD = 0;
    const fxF = g.attachR * 1.02 * cx, fyF = g.bottomY + 0.25 + dy;
    const fx = fxF + (fxD - fxF) * legs, fy = fyF + (fyD - fyF) * legs;
    ctx.save();
    if (dz < -0.05) ctx.globalAlpha = 0.8;
    const w = g.strutW;
    // secondary strut from body bottom to primary mid
    const mx = ax + (fx - ax) * 0.62, my = ay + (fy - ay) * 0.62;
    drawStrut(ctx, k, L, g.attachR * 0.55 * cx, g.bottomY + dy, mx, my, w * 0.65, g.mat);
    drawStrut(ctx, k, L, ax, ay, fx, fy, w, g.mat);
    // shock absorber sleeve near the footpad
    drawStrut(ctx, k, L, ax + (fx - ax) * 0.55, ay + (fy - ay) * 0.55, ax + (fx - ax) * 0.85, ay + (fy - ay) * 0.85, w * 1.5, g.mat);
    // footpad
    const pr = g.padR;
    ctx.fillStyle = tubeFill(ctx, fx * k - pr * k, -fy * k, fx * k + pr * k, -fy * k, pr * k * 0.3, g.padMat || g.mat, L);
    ctx.beginPath(); ctx.ellipse(fx * k, -(fy + pr * 0.18) * k, pr * k, Math.max(0.7, pr * 0.3 * k), 0, 0, 7); ctx.fill();
    ctx.restore();
  }
}

// --- capsule bodies
function capsuleBody(c, mode) {
  const D = num(c.shieldD, 4), top = num(c.topD, 1.6), H = num(c.capH, 3.4);
  const hs = 0.05 * D + 0.06, sh = H * 0.1;
  const char = mode === 'chute' || mode === 'landed' ? 1 : mode === 'entry' ? 0.45 : 0;
  return cbody(c, `cm|${char}`, () => ({
    segs: [
      { len: hs, d: D * 0.9, dTop: D, shape: 'easeOut', mat: 'ablator' },
      { len: H - hs - sh, d: D, dTop: top + (D - top) * 0.14, mat: c.mat || 'white_paint', tint: c.tint || null },
      { len: sh, d: top + (D - top) * 0.14, dTop: top, shape: 'ellipse', mat: c.mat || 'white_paint', tint: c.tint || null },
    ],
    soot: char * 0.95, sootColor: '#3a2a1e', seamEvery: c.mat === 'silver_tile' ? 0.42 : 0, seamStrength: 0.1,
    marks: [
      ...(c.windows ? [{ type: 'window', y: H * 0.55, h: Math.min(0.55, H * 0.14), w: 0.45, n: Math.min(3, c.windows), spread: 0.75 }] : []),
      ...(c.band ? [{ type: 'band', y: hs + H * 0.05, h: H * 0.16, color: c.band }] : []),
      ...(c.superDraco ? [{ type: 'patch', y: hs + 0.15, h: 0.9, w: 0.75, s: -0.7, color: '#1d1f22' }, { type: 'patch', y: hs + 0.15, h: 0.9, w: 0.75, s: 0.7, color: '#1d1f22' }] : []),
      ...(c.logo ? [{ type: 'text', y: H * 0.3, h: H * 0.12, text: c.logo, color: c.logoColor || '#1b1d21', w: D * 0.45 }] : []),
    ],
    decor: c.mat === 'silver_tile' ? (G) => { // Orion backshell tile grid with vertical lines
      const { g, prof, kb } = G;
      if (kb * 0.42 < 3) return;
      g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 1;
      for (let a = -1.4; a <= 1.4; a += 0.14) { g.beginPath(); for (let y = hs; y < H - sh; y += 0.2) g.lineTo(G.X(Math.sin(a) * prof.rAt(y)), G.Y(y)); g.stroke(); }
    } : null,
  }));
}

function paintCapsule(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const mode = o.mode;
  const H = num(c.capH, 3.4), D = num(c.shieldD, 4), top = num(c.topD, 1.6);
  const nozzles = [];
  const withSM = mode === 'flight' || mode === 'stack';
  if (withSM && c.sm) {
    const sm = c.sm, h = num(sm.h, 3), d = num(sm.d, D);
    if (sm.type === 'trunk') {
      const tb = cbody(c, 'trunk', () => ({ segs: [{ len: h, d, dTop: d, mat: 'white_paint', cells: sm.cells || 'half' }], seamEvery: 0 }));
      drawAt(ctx, tb, 0, -h, k, fr);
      for (const sx of [-1, 1]) { // trunk fins
        ctx.fillStyle = litCss('white_paint', [sx * 0.3, 0.1, 0.95], L);
        ctx.beginPath(); ctx.moveTo(sx * d / 2 * k, h * k); ctx.lineTo(sx * (d / 2 + 0.8) * k, h * k); ctx.lineTo(sx * (d / 2 + 0.8) * k, (h - 0.6) * k); ctx.lineTo(sx * d / 2 * k, (h - 2.0) * k); ctx.closePath(); ctx.fill();
      }
    } else {
      const esm = sm.type === 'esm';
      const smb = cbody(c, 'sm', () => ({
        segs: esm
          ? [{ len: 0.35, d: d * 0.92, mat: 'engine_dark' }, { len: h - 0.95, d, mat: sm.mat || 'silver_foil' }, { len: 0.6, d, dTop: D * 0.98, mat: 'white_paint' }]
          : [{ len: 0.3, d: d * 0.9, dTop: d, mat: 'engine_dark' }, { len: h - 0.3, d, mat: sm.mat || 'white_paint' }],
        seamEvery: 0.9, seamStrength: 0.08,
      }));
      if (esm || sm.arrays) {
        const span = num(sm.arraySpanM, 12) / 2, ay = -h * 0.42, ph = esm ? 2.0 : 1.6;
        const panels = esm ? 3 : 2;
        if (sm.arrays === 'xwing' || esm) {
          drawPanel(ctx, k, L, -d / 2 - 0.4, -span * 0.95, ay + 0.6, ph * 0.8, { panels, shade: 0.35, tilt: -0.12 });
          drawPanel(ctx, k, L, d / 2 + 0.4, span * 0.95, ay + 0.6, ph * 0.8, { panels, shade: 0.35, tilt: -0.12 });
        }
        drawAt(ctx, smb, 0, -h, k, fr);
        drawPanel(ctx, k, L, -d / 2 - 0.3, -span, ay, ph, { panels, tilt: 0.1 });
        drawPanel(ctx, k, L, d / 2 + 0.3, span, ay, ph, { panels, tilt: 0.1 });
        for (const sx of [-1, 1]) drawStrut(ctx, k, L, sx * d / 2, ay, sx * (d / 2 + 0.4), ay, 0.18);
      } else drawAt(ctx, smb, 0, -h, k, fr);
      if (sm.pods) for (const sx of [-1, 1]) { ctx.fillStyle = litCss('white_paint', [sx * 0.6, 0.2, 0.7], L); ctx.fillRect(sx > 0 ? d / 2 * k : -(d / 2 + 0.35) * k, h * 0.35 * k, 0.35 * k, 0.9 * k); }
      const e = { prop: 'hypergolic', bellD: esm ? 1.0 : 0.8, bellLen: esm ? 1.3 : 0.9 };
      drawBell(ctx, k, fr, 0, -h, e, { glow: o.engineOn ? 0.5 : 0 });
      nozzles.push({ x: 0, y: -h - e.bellLen, d: e.bellD, prop: e.prop, angle: 0 });
    }
  }
  drawAt(ctx, capsuleBody(c, mode), 0, 0, k, fr);
  if (c.nose === 'hinged') {
    const nb = cbody(c, `nose|${mode === 'chute' || mode === 'landed' ? 1 : 0}`, () => ({ segs: [{ len: 0.85, d: top * 0.98, dTop: top * 0.3, shape: 'ellipse', mat: c.mat || 'white_paint' }], soot: mode === 'chute' || mode === 'landed' ? 0.4 : 0, sootColor: '#3a2a1e' }));
    drawAt(ctx, nb, 0, H, k, fr);
  } else {
    const tun = cbody(c, 'tunnel', () => ({ segs: [{ len: 0.35, d: top * 0.62, mat: 'bare_aluminium' }] }));
    drawAt(ctx, tun, 0, H, k, fr);
  }
  if (mode === 'landed' && c.airbags) {
    ctx.fillStyle = litCss('white_paint', [0, -0.2, 0.95], L, '#d8d2c0');
    for (const sx of [-0.55, 0, 0.55]) { ctx.beginPath(); ctx.ellipse(sx * D * k * 0.5, 0.25 * k, D * 0.2 * k, 0.4 * k, 0, 0, 7); ctx.fill(); }
  }
  if (!nozzles.length) nozzles.push({ x: 0, y: H * 0.5, d: 0.3, prop: 'hypergolic', angle: 0 });
  return { heightM: H + 0.85, widthM: D, nozzles };
}

function paintCapsuleSM(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const mode = o.mode;
  const de = c.descent || {}, om = c.orbital || {}, sv = c.service || {};
  const dH = num(de.len, 2.2), dD = num(de.d, 2.2);
  const char = mode === 'chute' || mode === 'landed' ? 1 : mode === 'entry' ? 0.5 : 0;
  const dm = cbody(c, `dm|${char}`, () => ({
    segs: [{ len: 0.18, d: dD * 0.9, dTop: dD, shape: 'easeOut', mat: 'ablator' }, { len: dH - 0.18, d: dD, dTop: dD * 0.55, shape: 'headlight', mat: de.mat || 'soyuz_green' }],
    soot: char * 1.1, sootColor: '#2a2018',
    marks: [{ type: 'window', y: dH * 0.45, h: 0.3, w: 0.3, n: 1, s: 0.3 }],
  }));
  const nozzles = [];
  if (mode === 'flight' || mode === 'stack') {
    const sH = num(sv.len, 2.6), sD = num(sv.d, 2.7);
    const smb = cbody(c, 'svc', () => ({ segs: [{ len: sH * 0.55, d: sD, dTop: sD * 0.82, mat: sv.mat || 'soyuz_green' }, { len: sH * 0.45, d: sD * 0.8, dTop: dD * 0.85, mat: sv.mat || 'soyuz_green' }], seamEvery: 0.6, seamStrength: 0.08 }));
    const span = num(c.arrays?.spanM, 10) / 2;
    const four = c.arrays?.type === 'pair4';
    if (mode === 'flight') {
      drawPanel(ctx, k, L, -sD / 2 - 0.2, -span, -sH * 0.6, four ? 2.0 : 1.1, { panels: four ? 4 : 4, gap: 0.08 });
      drawPanel(ctx, k, L, sD / 2 + 0.2, span, -sH * 0.6, four ? 2.0 : 1.1, { panels: four ? 4 : 4, gap: 0.08 });
    }
    drawAt(ctx, smb, 0, -sH, k, fr);
    const omH = num(om.len, 3), omD = num(om.d, 2.25);
    const omb = cbody(c, 'om', () => ({ segs: om.mat === 'white_paint' ? [{ len: 0.2, d: dD * 0.5, dTop: omD, shape: 'easeOut', mat: om.mat }, { len: omH - 0.6, d: omD, mat: om.mat }, { len: 0.4, d: omD, dTop: omD * 0.45, shape: 'ellipse', mat: om.mat }] : [{ len: omH, d: dD * 0.4, dTop: dD * 0.4, dMid: omD, shape: 'sphere', mat: om.mat || 'soyuz_green' }] }));
    drawAt(ctx, omb, 0, dH, k, fr);
    if (om.arrays === 'small' && mode === 'flight') { drawPanel(ctx, k, L, -omD / 2, -omD / 2 - 2.2, dH + omH * 0.5, 0.8); drawPanel(ctx, k, L, omD / 2, omD / 2 + 2.2, dH + omH * 0.5, 0.8); }
    drawStrut(ctx, k, L, 0, dH + omH, 0, dH + omH + 0.5, 0.15);
    nozzles.push({ x: 0, y: -sH - 0.4, d: 0.5, prop: 'hypergolic', angle: 0 });
  }
  drawAt(ctx, dm, 0, 0, k, fr);
  if (!nozzles.length) nozzles.push({ x: 0, y: 0, d: 0.3, prop: 'hypergolic', angle: 0 });
  return { heightM: dH, widthM: dD, nozzles };
}

// --- landers
function landerGeom(c) {
  const bodyH = num(c.bodyH, num(c.heightM, 3) * 0.55);
  const bodyW = num(c.bodyW, num(c.widthM, 3) * 0.6);
  let extraTop = 0;
  if (c.cabin) extraTop += Math.min(2.6, bodyH * 0.9);
  if (c.ascent) extraTop += 0.9;
  if (c.solar === 'top') extraTop += 0.15;
  const clear = Math.max(0.5, num(c.clearM, num(c.heightM, 3) - bodyH - extraTop));
  const n = Math.max(3, num(c.legs, 4));
  return {
    n, th0: n === 4 ? Math.PI / 4 : n === 3 ? Math.PI / 2 : 0,
    span: num(c.legSpanM, bodyW * 1.6), attachR: bodyW / 2, attachY: clear + bodyH * 0.45, bottomY: clear,
    stroke: Math.min(0.4, clear * 0.25), padR: Math.max(0.26, bodyW * 0.11), strutW: Math.max(0.08, bodyW * 0.045),
    mat: c.legMat || (c.mat === 'white_paint' ? 'bare_aluminium' : 'gold_foil'), padMat: 'bare_aluminium',
    bodyH, bodyW, clear,
  };
}

function landerBodies(c) {
  const g = landerGeom(c);
  const list = [];
  const kind = c.body || 'box';
  const mat = c.mat || 'gold_foil';
  if (kind === 'cyl') {
    list.push({ y: g.clear, b: cbody(c, 'body', () => ({
      segs: [{ len: 0.4, d: g.bodyW * 0.85, dTop: g.bodyW, mat: 'engine_dark' }, { len: g.bodyH - 1.6, d: g.bodyW, mat }, { len: 1.2, d: g.bodyW, dTop: g.bodyW * 0.55, shape: c.cabin ? 'line' : 'ellipse', mat }],
      seamEvery: 1.6, seamStrength: 0.07,
      marks: [
        ...(c.accent ? [{ type: 'band', y: g.bodyH * 0.18, h: 0.35, color: c.accent }, { type: 'logo', logo: 'feather', y: g.bodyH * 0.45, h: 1.8, color: c.accent }] : []),
        ...(c.solarBand ? [{ type: 'band', y: g.bodyH * 0.6, h: 1.4, color: '#18224a' }] : []),
        ...(c.cabin ? [{ type: 'window', y: g.bodyH - 2.2, h: 0.5, w: 0.5, n: 2, spread: 0.5 }] : []),
      ],
    })) });
  } else if (kind === 'deck') {
    list.push({ y: g.clear, b: cbody(c, 'body', () => ({ segs: [{ len: g.bodyH * 0.55, d: g.bodyW * 0.7, dTop: g.bodyW, mat: c.foil || 'gold_foil' }, { len: g.bodyH * 0.45, d: g.bodyW, dTop: g.bodyW * 0.96, mat }], section: { n: 6, rot: 0 } })) });
  } else if (kind === 'tanks') {
    list.push({ y: g.clear, b: cbody(c, 'body', () => ({ segs: [{ len: g.bodyH * 0.7, d: g.bodyW * 0.5, dTop: g.bodyW * 0.5, dMid: g.bodyW * 0.92, shape: 'sphere', mat: 'silver_foil' }, { len: g.bodyH * 0.3, d: g.bodyW, mat }], section: { n: 8, rot: 22.5 } })) });
  } else {
    const hex = kind === 'hex';
    list.push({ y: g.clear, b: cbody(c, 'body', () => ({
      segs: [{ len: g.bodyH * 0.12, d: g.bodyW, mat: hex ? 'black_paint' : 'mli_black' }, { len: g.bodyH * 0.76, d: g.bodyW, mat: c.foil || mat }, { len: g.bodyH * 0.12, d: g.bodyW, mat: c.topMat || (hex ? 'white_paint' : 'silver_foil') }],
      section: hex ? { n: 6, rot: 0 } : { n: 4, rot: 30 },
      decor: c.solar === 'sides' ? (G) => { // body-mounted cells on the side faces
        const { g: gg, prof, kb } = G;
        const r = prof.rAt(prof.len / 2);
        gg.fillStyle = '#16204a';
        gg.fillRect(G.X(-r * (hex ? 0.95 : 0.98)), G.Y(prof.len * 0.82), r * (hex ? 0.85 : 0.75) * kb, prof.len * 0.55 * kb);
        if (hex) gg.fillRect(G.X(r * 0.12), G.Y(prof.len * 0.82), r * 0.83 * kb, prof.len * 0.55 * kb);
      } : null,
    })) });
  }
  let top = g.clear + g.bodyH;
  if (c.propModule) { /* the cabin sits on the propulsion module (box above) */ }
  if (c.cabin && kind !== 'cyl') {
    const ch = Math.min(2.6, g.bodyH * 0.9), cd = g.bodyW * 0.62;
    list.push({ y: top, b: cbody(c, 'cabin', () => ({ segs: [{ len: ch * 0.75, d: cd, mat: c.cabinMat || 'white_paint' }, { len: ch * 0.25, d: cd, dTop: cd * 0.5, shape: 'ellipse', mat: c.cabinMat || 'white_paint' }], marks: [{ type: 'window', y: ch * 0.45, h: 0.4, w: 0.4, n: 2, spread: 0.45 }], seamEvery: 0.7, seamStrength: 0.08 })) });
    top += ch;
  }
  if (c.ascent) {
    list.push({ y: top, b: cbody(c, 'ascent', () => ({ segs: [{ len: 0.6, d: g.bodyW * 0.45, mat: 'silver_foil' }, { len: 0.3, d: g.bodyW * 0.45, dTop: g.bodyW * 0.25, shape: 'ellipse', mat: 'gold_foil' }], section: { n: 6, rot: 0 } })) });
    top += 0.9;
  }
  return { g, list, top };
}

function paintLander(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const { g, list, top } = landerBodies(c);
  const legs = clamp(num(o.legs, 1), 0, 1), comp = clamp(num(o.compress, 0), 0, 1);
  const dy = -g.stroke * comp;
  const e = c.engine || { prop: 'hypergolic', bellD: 0.6, bellLen: 0.8 };
  const nozzles = [];
  if (c.solar === 'round') { // two UltraFlex discs seen obliquely
    const R = (num(c.solarSpanM, 5.5) / 2 - g.bodyW / 2) / 2;
    for (const sx of [-1, 1]) { // side view: the deployed fans are seen nearly edge-on (thin ellipses), hinged at the deck edge
      drawStrut(ctx, k, L, sx * g.bodyW * 0.42, g.clear + g.bodyH * 0.92 + dy, sx * (g.bodyW / 2 + R * 0.12), g.clear + g.bodyH * 0.96 + dy, 0.06);
      drawDisc(ctx, k, L, sx * (g.bodyW / 2 + R), g.clear + g.bodyH * 0.96 + dy, R, { squash: 0.11, edge: true });
    }
  }
  if (c.solar === 'wings') for (const sx of [-1, 1]) drawPanel(ctx, k, L, sx * g.bodyW / 2, sx * num(c.widthM, 4) / 2, g.clear + g.bodyH * 0.9 + dy, Math.max(0.8, g.bodyH * 0.8), { panels: 1, tilt: -0.05 });
  drawLanderLegs(ctx, k, L, g, legs, comp, false);
  // main engine(s)
  const nE = Math.max(1, num(e.n, 1));
  const xs = nE === 1 ? [0] : nE >= 12 ? [-g.bodyW * 0.3, -g.bodyW * 0.1, g.bodyW * 0.1, g.bodyW * 0.3] : nE === 4 ? [-g.bodyW * 0.22, g.bodyW * 0.22] : [-g.bodyW * 0.25, 0, g.bodyW * 0.25];
  for (const x of xs) {
    drawBell(ctx, k, fr, x, g.clear + dy + 0.02, e, { glow: o.engineOn ? 0.55 : 0 });
    nozzles.push({ x, y: g.clear + dy - num(e.bellLen, 0.6), d: num(e.bellD, 0.5), prop: e.prop || 'hypergolic', angle: 0 });
  }
  for (const it of list) drawAt(ctx, it.b, 0, it.y + dy, k, fr);
  if (c.solar === 'top') drawPanel(ctx, k, L, -g.bodyW * 0.55, g.bodyW * 0.55, top + dy + 0.06, 0.12, { panels: 1, cellM: 0.2 });
  if (c.rover) { // small rover parked on the top deck
    const rw = g.bodyW * 0.35;
    ctx.fillStyle = litCss('gold_foil', [0.2, 0.4, 0.9], L);
    ctx.fillRect(-rw * k * 0.2, -(g.clear + g.bodyH + 0.35 + dy) * k, rw * k, 0.3 * k);
    ctx.fillStyle = '#18224a'; ctx.fillRect(-rw * k * 0.3, -(g.clear + g.bodyH + 0.45 + dy) * k, rw * k * 1.2, 0.08 * k);
    for (const wx of [0, 0.5, 1]) { ctx.fillStyle = '#2a2a2c'; ctx.beginPath(); ctx.arc((-rw * 0.2 + rw * wx) * k, -(g.clear + g.bodyH + 0.08 + dy) * k, 0.1 * k, 0, 7); ctx.fill(); }
  }
  // antenna mast
  drawStrut(ctx, k, L, g.bodyW * 0.3, top + dy, g.bodyW * 0.3, top + dy + 0.6, 0.05);
  drawDish(ctx, k, L, g.bodyW * 0.3, top + dy + 0.7, Math.max(0.35, g.bodyW * 0.22), { tilt: -0.4 });
  drawLanderLegs(ctx, k, L, g, legs, comp, true);
  return { heightM: num(c.heightM, top), widthM: num(c.widthM, g.span), nozzles };
}

// --- Starship (HLS / cargo / tanker)
function paintStarship(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const H = num(c.heightM, 50.3), D = num(c.widthM, 9);
  const legsN = num(c.legs, 0);
  const clear = legsN ? 2.6 : 2.8;
  const b = cbody(c, 'ship', () => {
    const segs = [];
    const noseL = H * 0.36;
    const barrel = H - noseL;
    if (c.topWhite) {
      segs.push({ len: barrel * 0.5, d: D, mat: 'stainless' });
      segs.push({ len: barrel * 0.5, d: D, mat: 'white_paint' });
      segs.push({ len: noseL, d: D, dTop: 1.2, shape: 'ogive', mat: 'white_paint' });
    } else {
      segs.push({ len: barrel, d: D, mat: 'stainless', tiles: c.tiles ? 'windward' : null });
      segs.push({ len: noseL, d: D, dTop: 1.2, shape: 'ogive', mat: 'stainless', tiles: c.tiles ? 'windward' : null });
    }
    return {
      segs, seamEvery: 1.83, seamStrength: 0.18, ringTone: 0.09, frost: 0,
      marks: [
        ...(c.windows ? [{ type: 'window', y: H * 0.86, h: 0.6, w: 0.7, n: 3, spread: 0.6 }] : []),
        ...(c.landingThrusters ? [{ type: 'band', y: H * 0.71, h: 0.9, color: '#2a2b2e' }] : []),
        ...(c.door ? [{ type: 'patch', y: H * 0.72, h: 5, w: 3, color: '#9da2a8' }] : []),
        { type: 'text', y: H * 0.42, h: H * 0.2, text: 'STARSHIP', vertical: true, color: c.topWhite ? '#1b1d21' : '#2a2c30', size: 1.8, s: 0.35 },
      ],
    };
  });
  const nozzles = [];
  if (legsN) {
    const g = { n: legsN, th0: 0, span: D * 1.25, attachR: D * 0.48, attachY: clear + 3.5, bottomY: clear, stroke: 0.5, padR: 0.6, strutW: 0.35, mat: 'stainless', padMat: 'stainless' };
    drawLanderLegs(ctx, k, L, g, clamp(num(o.legs, 1), 0, 1), num(o.compress, 0), false);
  }
  const e = { prop: 'methalox', bellD: 1.3, bellLen: 1.6 };
  for (const x of [-2.3, 0, 2.3]) drawBell(ctx, k, fr, x, clear, e, { glow: 0 });
  drawAt(ctx, b, 0, clear, k, fr);
  if (c.flaps) drawFlaps(ctx, profileOf(b), k, L, !!c.tiles);
  ctx.save(); ctx.translate(0, -clear * k); ctx.restore();
  if (c.landingThrusters) {
    for (const sx of [-1, 1]) {
      ctx.fillStyle = litCss('engine_dark', [sx, 0, 0.3], L);
      ctx.fillRect(sx > 0 ? (D / 2 - 0.05) * k : -(D / 2 + 0.55) * k, -(clear + H * 0.72 + 0.9) * k, 0.6 * k, 1.2 * k);
      nozzles.push({ x: sx * (D / 2 + 0.3), y: clear + H * 0.72 - 0.9, d: 0.75, prop: 'methalox', angle: -sx * 0.32, lengthM: 24 });
    }
    if (o.engineOn) for (const sx of [-1, 1]) {
      const gx = sx * (D / 2 + 0.25) * k, gy = -(clear + H * 0.72 - 0.3) * k;
      const gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, 1.5 * k);
      gr.addColorStop(0, 'rgba(255,240,220,0.9)'); gr.addColorStop(1, 'rgba(160,140,255,0)');
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(gx, gy, 1.5 * k, 0, 7); ctx.fill(); ctx.restore();
    }
  } else for (const x of [-2.3, 0, 2.3]) nozzles.push({ x, y: clear - 1.6, d: 1.3, prop: 'methalox', angle: 0 });
  if (legsN) {
    const g = { n: legsN, th0: 0, span: D * 1.25, attachR: D * 0.48, attachY: clear + 3.5, bottomY: clear, stroke: 0.5, padR: 0.6, strutW: 0.35, mat: 'stainless', padMat: 'stainless' };
    drawLanderLegs(ctx, k, L, g, clamp(num(o.legs, 1), 0, 1), num(o.compress, 0), true);
  }
  return { heightM: H + clear, widthM: D, nozzles };
}

// --- probes / satellites
function paintProbe(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const stackMode = o.mode === 'stack';
  const bw = num(c.bus?.w, 2), bh = num(c.bus?.h, 2.5);
  const bmat = c.bus?.mat || 'gold_foil';
  const arr = c.arrays || {};
  const span = num(arr.spanM, 0) / 2;
  const nozzles = [];
  const busB = cbody(c, 'bus', () => {
    if (c.bus?.stack) return { segs: [{ len: bh * 0.4, d: bw, mat: 'silver_foil' }, { len: bh * 0.35, d: bw * 0.9, mat: 'white_paint' }, { len: bh * 0.25, d: bw * 0.7, mat: 'silver_foil' }], section: { n: 8, rot: 22.5 } };
    return { segs: [{ len: bh * 0.08, d: bw, mat: 'mli_black' }, { len: bh * 0.84, d: bw, mat: bmat }, { len: bh * 0.08, d: bw, mat: 'mli_black' }], section: { n: 4, rot: 30 } };
  });
  // arrays (behind the bus)
  if (!stackMode && span > bw / 2 && arr.type !== 'rtg' && arr.type !== 'none') {
    const panels = Math.max(1, num(arr.panels, 2));
    const ph = num(arr.panelW, Math.min(3, Math.max(1.2, bh * 0.8)));
    const x0 = bw / 2 + 0.5;
    if (arr.type === 'circular') { const R = (span - x0) / 2; for (const sx of [-1, 1]) drawDisc(ctx, k, L, sx * (x0 + R), 0, R, { squash: 0.92, ribs: 14 }); }
    else for (const sx of [-1, 1]) {
      drawStrut(ctx, k, L, sx * bw / 2, 0, sx * x0, 0, 0.12);
      drawPanel(ctx, k, L, sx * x0, sx * span, 0, arr.type === 'rollout' ? ph * 0.6 : ph, { panels });
      if (arr.type === 'cross') { const mid = x0 + (span - x0) / 2, pw = (span - x0) / panels; drawPanel(ctx, k, L, sx * (mid - pw / 2), sx * (mid + pw / 2), ph, ph, {}); drawPanel(ctx, k, L, sx * (mid - pw / 2), sx * (mid + pw / 2), -ph, ph, {}); }
    }
  }
  if (stackMode && arr.type !== 'rtg' && span > 0) for (const sx of [-1, 1]) { // folded wings against the bus
    ctx.fillStyle = litCss('solar_cell', [sx * 0.8, 0.1, 0.5], L, '#1a2448');
    ctx.fillRect(sx > 0 ? bw / 2 * k : -(bw / 2 + 0.3) * k, -(bh * 0.95) * k + (-0.5) * 0, 0.3 * k, bh * 0.9 * k);
  }
  if (arr.type === 'rtg' && !stackMode) { // RTG on a boom
    drawStrut(ctx, k, L, -bw / 2, -bh * 0.2, -bw / 2 - 1.2, -bh * 0.55, 0.1);
    const rtg = cbody(c, 'rtg', () => ({ segs: [{ len: 1.1, d: 0.42, mat: 'rtg_dark', ribs: true }], seamEvery: 0.18, seamStrength: 0.3 }));
    ctx.save(); ctx.translate((-bw / 2 - 1.5) * k, (bh * 0.55) * k); ctx.rotate(-1.1); drawBody(ctx, rtg, k, fr); ctx.restore();
  }
  if (c.boom && !stackMode) drawStrut(ctx, k, L, bw / 2, bh * 0.3, bw / 2 + Math.min(span * 0.6, 7), bh * 0.3 + 2.5, 0.07, 'carbon_black');
  // engine below the bus
  const e = { prop: 'hypergolic', bellD: Math.max(0.3, bw * 0.22), bellLen: Math.max(0.35, bw * 0.28) };
  if (c.ion && !stackMode) {
    for (const x of [-bw * 0.25, bw * 0.25]) {
      ctx.fillStyle = '#2b2d30'; ctx.beginPath(); ctx.ellipse(x * k, (bh / 2 + 0.1) * k, bw * 0.15 * k, 0.12 * k, 0, 0, 7); ctx.fill();
      if (o.engineOn) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const gx = x * k, gy = (bh / 2 + 0.15) * k; const gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, bw * 0.4 * k); gr.addColorStop(0, 'rgba(150,190,255,0.9)'); gr.addColorStop(1, 'rgba(60,90,255,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(gx, gy, bw * 0.4 * k, 0, 7); ctx.fill(); ctx.restore(); }
      nozzles.push({ x, y: -bh / 2 - 0.1, d: bw * 0.3, prop: 'ion', angle: 0 });
    }
  } else {
    drawBell(ctx, k, fr, 0, -bh / 2, e, { glow: o.engineOn ? 0.6 : 0 });
    nozzles.push({ x: 0, y: -bh / 2 - e.bellLen, d: e.bellD, prop: e.prop, angle: 0 });
  }
  if (c.legs) for (const sx of [-1, 1]) drawStrut(ctx, k, L, sx * bw * 0.4, -bh / 2, sx * bw * 0.7, -bh / 2 - 0.8, 0.08);
  drawAt(ctx, busB, 0, -bh / 2, k, fr);
  if (c.hga?.d) drawDish(ctx, k, L, 0, bh / 2 + num(c.hga.d) * 0.12 + 0.1, num(c.hga.d), { tilt: stackMode ? 0 : -0.22 });
  if (c.entryProbe && !stackMode) {
    const eb = cbody(c, 'eprobe', () => ({ segs: [{ len: 0.2, d: 0.4, dTop: 1, shape: 'easeOut', mat: 'ablator' }, { len: 0.5, d: 1, dTop: 0.5, mat: 'white_paint' }] }));
    drawAt(ctx, eb, bw / 2 + 0.6, -0.4, k, fr);
  }
  if ((c.sampler || c.arm) && !stackMode) { drawStrut(ctx, k, L, bw * 0.3, -bh / 2, bw * 0.9, -bh / 2 - 1.4, 0.08); ctx.fillStyle = litCss('bare_aluminium', [0, 0.5, 0.8], L); ctx.beginPath(); ctx.arc(bw * 0.9 * k, (bh / 2 + 1.5) * k, 0.18 * k, 0, 7); ctx.fill(); }
  // small instruments
  ctx.fillStyle = litCss('black_paint', [0.3, 0.3, 0.9], L);
  ctx.fillRect(-bw * 0.45 * k, -(bh / 2 + 0.25) * k, 0.4 * k, 0.25 * k);
  return { heightM: bh, widthM: Math.max(bw, span * 2), nozzles };
}

// --- station modules (axis vertical, centred)
function paintModule(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const len = num(c.len, num(c.heightM, 10)), d = num(c.d, num(c.widthM, 4));
  const stackMode = o.mode === 'stack';
  const b = cbody(c, 'mod', () => ({
    segs: [
      { len: 0.6, d: d * 0.42, mat: 'bare_aluminium' },
      { len: 0.5, d: d * 0.42, dTop: d, shape: 'easeOut', mat: c.mat === 'white_paint' ? 'beta_cloth' : c.mat },
      { len: len - (c.aperture ? 1.4 : 2.2), d, mat: c.mat === 'white_paint' ? 'beta_cloth' : c.mat, ribs: true },
      ...(c.aperture ? [{ len: 0.3, d, mat: 'mli_black' }] : [{ len: 0.5, d, dTop: d * 0.42, shape: 'ellipse', mat: c.mat === 'white_paint' ? 'beta_cloth' : c.mat }, { len: 0.6, d: d * 0.42, mat: 'bare_aluminium' }]),
    ],
    seamEvery: 1.1, seamStrength: 0.12,
    marks: c.window ? [{ type: 'window', y: len * 0.85, h: 0.7, w: 1.4, n: 1 }] : [],
  }));
  const arr = c.arrays || {};
  const span = num(arr.spanM, 0) / 2;
  if (!stackMode && span > 0 && arr.type !== 'none') {
    const fs = 0.62; // wings rotated away from the camera → foreshortened
    const ph = arr.type === 'rollout' ? 2.6 : arr.flexible ? 3.5 : 2.4;
    for (const sx of [-1, 1]) {
      drawStrut(ctx, k, L, sx * d / 2, len * 0.1, sx * (d / 2 + 0.8), len * 0.1, 0.15);
      drawPanel(ctx, k, L, sx * (d / 2 + 0.8), sx * (d / 2 + 0.8 + (span - d / 2) * fs), len * 0.1, ph, { panels: arr.flexible ? 1 : 3, tilt: -0.12 * sx, color: arr.flexible ? '#232c56' : '#18224a' });
    }
  }
  drawAt(ctx, b, 0, -len / 2, k, fr);
  if (c.ion && o.engineOn) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const gr = ctx.createRadialGradient(0, (len / 2 + 0.3) * k, 0, 0, (len / 2 + 0.3) * k, d * 0.5 * k); gr.addColorStop(0, 'rgba(150,190,255,0.9)'); gr.addColorStop(1, 'rgba(60,90,255,0)'); ctx.fillStyle = gr; ctx.fillRect(-d * k, len / 2 * k - d * k, 2 * d * k, 2 * d * k); ctx.restore(); }
  return { heightM: len, widthM: d, nozzles: [{ x: 0, y: -len / 2 - 0.4, d: 0.4, prop: c.ion ? 'ion' : 'hypergolic', angle: 0 }] };
}

// --- rovers (centred)
function paintRover(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const W = num(c.widthM, 2.2), H = num(c.heightM, 1.6);
  const wr = H * 0.17;
  const nW = num(c.wheels, 6) >= 6 ? 3 : 2;
  const by = -H / 2 + wr * 2.0;
  const bodyH = H * 0.28;
  const b = cbody(c, 'chassis', () => ({ segs: [{ len: bodyH, d: W * 0.72, mat: c.mat || 'white_paint' }], section: { n: 4, rot: 25 }, marks: [{ type: 'band', y: bodyH * 0.1, h: bodyH * 0.15, color: '#c9a03a' }] }));
  // rocker-bogie + wheels
  ctx.strokeStyle = litCss('bare_aluminium', [0, 0.5, 0.8], L); ctx.lineWidth = Math.max(0.8, 0.06 * k);
  const xs = nW === 3 ? [-W * 0.42, 0, W * 0.42] : [-W * 0.38, W * 0.38];
  ctx.beginPath();
  for (const x of xs) { ctx.moveTo(x * k, -(-H / 2 + wr) * k); ctx.lineTo(x * 0.6 * k, -(by + 0.05) * k); }
  ctx.stroke();
  for (const x of xs) {
    const cx = x * k, cy = -(-H / 2 + wr) * k;
    ctx.fillStyle = '#26272a'; ctx.beginPath(); ctx.arc(cx, cy, wr * k, 0, 7); ctx.fill();
    ctx.fillStyle = litCss('bare_aluminium', [-0.3, 0.4, 0.86], L); ctx.beginPath(); ctx.arc(cx, cy, wr * 0.75 * k, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.7;
    ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * 1.047; ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * wr * 0.75 * k, cy + Math.sin(a) * wr * 0.75 * k); } ctx.stroke();
  }
  if (c.solar === 'wings' && o.mode !== 'stack') for (const sx of [-1, 1]) drawPanel(ctx, k, L, sx * W * 0.36, sx * W * 0.62, by + bodyH + 0.05, 0.08, { panels: 1, cellM: 0.15 });
  drawAt(ctx, b, 0, by, k, fr);
  ctx.fillStyle = litCss('solar_cell', [0, 0.95, 0.3], L, '#1a2448');
  ctx.fillRect(-W * 0.38 * k, -(by + bodyH + 0.07) * k, W * 0.76 * k, 0.07 * k);
  if (c.mast) {
    drawStrut(ctx, k, L, W * 0.25, by + bodyH, W * 0.25, H / 2 - 0.2, 0.08);
    ctx.fillStyle = litCss('white_paint', [0.2, 0.3, 0.92], L); ctx.fillRect((W * 0.25 - 0.18) * k, -(H / 2) * k, 0.36 * k, 0.22 * k);
    ctx.fillStyle = '#0b0e14'; ctx.fillRect((W * 0.25 + 0.05) * k, -(H / 2 - 0.06) * k, 0.1 * k, 0.08 * k);
  }
  if (c.drill) { ctx.fillStyle = litCss('bare_aluminium', [0.4, 0, 0.9], L); ctx.fillRect((W * 0.3) * k, -(by + 0.05) * k, 0.12 * k, 0.6 * k); }
  return { heightM: H, widthM: W, nozzles: [] };
}

// --- Dragonfly-like rotorcraft (origin: skids)
function paintRotorcraft(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const W = num(c.widthM, 3.9), H = num(c.heightM, 1.8), rd = num(c.rotorD, 1.35);
  const skid = 0.55, bh = H * 0.42, bw = W * 0.55;
  const b = cbody(c, 'fuselage', () => ({ segs: [{ len: bh * 0.2, d: bw * 0.9, dTop: bw, shape: 'easeOut', mat: c.mat || 'white_paint' }, { len: bh * 0.6, d: bw, mat: c.mat || 'white_paint' }, { len: bh * 0.2, d: bw, dTop: bw * 0.85, shape: 'ellipse', mat: c.mat || 'white_paint' }], section: { n: 4, rot: 20 } }));
  // skids
  for (const sx of [-1, 1]) { drawStrut(ctx, k, L, sx * bw * 0.3, skid, sx * bw * 0.45, 0.05, 0.07); }
  drawStrut(ctx, k, L, -bw * 0.6, 0.05, bw * 0.6, 0.05, 0.08);
  // RTG at the back
  const rtg = cbody(c, 'rtg', () => ({ segs: [{ len: 1, d: 0.45, mat: 'rtg_dark', ribs: true }], seamEvery: 0.15, seamStrength: 0.3 }));
  ctx.save(); ctx.translate(-bw * 0.55 * k, -(skid + bh * 0.6) * k); ctx.rotate(-0.9); drawBody(ctx, rtg, k, fr); ctx.restore();
  drawAt(ctx, b, 0, skid, k, fr);
  const spin = o.mode !== 'landed' && o.mode !== 'stack';
  for (const sx of [-1, 1]) for (const xr of [0.5, 0.95]) {
    const x = sx * W * 0.5 * xr * (xr > 0.6 ? 1 : 0.9), y = skid + bh + 0.25;
    drawStrut(ctx, k, L, sx * bw * 0.4, skid + bh * 0.8, x, y - 0.05, 0.08);
    for (const dyR of [0.12, -0.12]) {
      const cx = x * k, cy = -(y + dyR) * k;
      if (spin) {
        ctx.fillStyle = 'rgba(40,42,46,0.28)'; ctx.beginPath(); ctx.ellipse(cx, cy, rd / 2 * k, Math.max(0.6, rd * 0.06 * k), 0, 0, 7); ctx.fill();
      } else {
        ctx.strokeStyle = '#2a2b2e'; ctx.lineWidth = Math.max(0.8, 0.06 * k);
        ctx.beginPath(); ctx.moveTo(cx - rd / 2 * k, cy); ctx.lineTo(cx + rd / 2 * k, cy); ctx.stroke();
      }
    }
  }
  drawDish(ctx, k, L, bw * 0.15, skid + bh + 0.2, 0.7, { tilt: -0.5 });
  return { heightM: H, widthM: W, nozzles: [] };
}

// --- aeroshell (origin: heat-shield nose)
function paintAeroshell(ctx, c, k, fr, o) {
  const L = fr.Lx;
  const D = num(c.shellD, 4);
  const mode = o.mode;
  const inner = c.inner && ART?.craft?.[c.inner] && o.depth < 2 ? ART.craft[c.inner] : null;
  if (inner && ((mode === 'flight' && o.engineOn) || mode === 'landed')) return paintCraft(ctx, inner, { ...o, depth: (o.depth || 0) + 1 });
  const shield = cbody(c, 'shield', () => ({ segs: [{ len: D * 0.14, d: D * 0.3, dTop: D, shape: 'easeOut', mat: c.shellMat || 'ablator' }], soot: 0.4, sootColor: '#2a1e16' }));
  const back = cbody(c, 'back', () => ({ segs: [{ len: D * 0.05, d: D, dTop: D * 0.96, mat: 'black_paint' }, { len: D * 0.36, d: D * 0.96, dTop: D * 0.48, mat: c.backshellMat || 'white_paint' }, { len: D * 0.12, d: D * 0.48, dTop: D * 0.3, shape: 'ellipse', mat: c.backshellMat || 'white_paint' }], seamEvery: D * 0.08, seamStrength: 0.08 }));
  if (mode === 'chute' && inner) { // heat shield dropped: lander visible under the backshell
    paintCraft(ctx, inner, { ...o, mode: 'flight', legs: 0.6, depth: (o.depth || 0) + 1, pxPerM: k });
    drawAt(ctx, back, 0, D * 0.22, k, fr);
    return { heightM: D * 0.75, widthM: D, nozzles: [] };
  }
  drawAt(ctx, back, 0, D * 0.14, k, fr);
  drawAt(ctx, shield, 0, 0, k, fr);
  return { heightM: D * 0.67, widthM: D, nozzles: [] };
}

// --- spaceplane (Space Rider), centred, nose toward +x
function paintSpaceplane(ctx, c, k, fr) {
  const L = fr.Lx;
  const len = num(c.lenM, num(c.widthM, 4.6)), H = num(c.heightM, 2.2) * 0.62;
  const x0 = -len / 2, x1 = len / 2;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x0 * k, (H * 0.35) * k);
    ctx.lineTo((x1 - 0.5) * k, (H * 0.45) * k);
    ctx.quadraticCurveTo((x1 + 0.1) * k, (H * 0.3) * k, x1 * k, 0);
    ctx.quadraticCurveTo((x1 - 0.6) * k, -(H * 0.55) * k, (x0 + len * 0.35) * k, -(H * 0.6) * k);
    ctx.lineTo(x0 * k, -(H * 0.45) * k);
    ctx.closePath();
  };
  const gr = ctx.createLinearGradient(0, -H * 0.6 * k, 0, H * 0.45 * k);
  gr.addColorStop(0, litCss('white_paint', [0, 0.9, 0.4], L)); gr.addColorStop(0.45, litCss('white_paint', [0, 0.2, 0.98], L));
  gr.addColorStop(0.62, litCss('tile_black', [0, -0.2, 0.97], L)); gr.addColorStop(1, litCss('tile_black', [0, -0.8, 0.5], L));
  path(); ctx.fillStyle = gr; ctx.fill();
  ctx.fillStyle = litCss('tile_black', [0.2, 0.4, 0.9], L);
  ctx.beginPath(); ctx.moveTo((x0 + 0.2) * k, -(H * 0.45) * k); ctx.lineTo((x0 - 0.15) * k, -(H * 1.1) * k); ctx.lineTo((x0 + 0.7) * k, -(H * 1.05) * k); ctx.lineTo((x0 + 1.1) * k, -(H * 0.55) * k); ctx.closePath(); ctx.fill();
  return { heightM: H, widthM: len, nozzles: [{ x: x0, y: 0, d: 0.3, prop: 'hypergolic', angle: Math.PI / 2 }] };
}

// Dry run (geometry only): paintCraft against a no-op context to learn nozzle positions without drawing.
let DRY = false;
const GRAD0 = { addColorStop() {} };
const NOOP = () => GRAD0;
const NULLCTX = typeof Proxy === 'function' ? new Proxy({}, { get: (t, p) => (p === 'getTransform' || p === 'canvas' ? undefined : p === 'measureText' ? () => ({ width: 0 }) : NOOP), set: () => true }) : null;
const NOZC = new Map();
/**
 * Nozzle exits of a craft in craft-local metres (y up, origin = paintCraft origin) for the given paint options
 * (legs / compress / mode change them). Each: { x, y, d, prop, angle }. Cached per craft + option bucket.
 */
export function craftNozzles(craft, opts = {}) {
  const c = craft || BUILTIN_CRAFT;
  if (!NULLCTX) return [];
  const key = `${cid(c)}|${opts.mode || 'flight'}|${Math.round(num(opts.legs, 1) * 8)}|${Math.round(num(opts.compress, 0) * 8)}|${opts.engineOn ? 1 : 0}`;
  let r = NOZC.get(key);
  if (!r) {
    DRY = true;
    try { r = (paintCraft(NULLCTX, c, { ...opts, pxPerM: 1 }).nozzles || []).map((n) => ({ ...n })); } catch { r = []; } finally { DRY = false; }
    if (NOZC.size > 200) NOZC.clear();
    NOZC.set(key, r);
  }
  return r;
}

/** Spacecraft at the ctx origin. Returns { heightM, widthM, nozzles } (nozzles in craft metres, y up). */
export function paintCraft(ctx, craft, opts = {}) {
  const c = craft || BUILTIN_CRAFT;
  if (!ctx) return { heightM: num(c.heightM, 3), widthM: num(c.widthM, 3), nozzles: [] };
  const { pxPerM = 6, light = SUN, mode = 'flight', heading = 0 } = opts;
  const k = Math.max(0.01, num(pxPerM, 6));
  const tpl = c.template || 'probe';
  const o = { ...opts, mode, depth: opts.depth || 0, legs: opts.legs == null ? 1 : opts.legs };
  ctx.save();
  let res;
  try {
    const centred = tpl === 'probe' || tpl === 'module' || tpl === 'rover' || tpl === 'spaceplane';
    if (mode === 'stack') {
      const dims = craftStackDims(c);
      if (centred) ctx.translate(0, -dims.h / 2 * k);
    } else if (centred && heading) ctx.rotate(num(heading, 0));
    const fr = frameOf(ctx, light, 0);
    switch (tpl) {
      case 'capsule': res = paintCapsule(ctx, c, k, fr, o); break;
      case 'capsule_sm': res = paintCapsuleSM(ctx, c, k, fr, o); break;
      case 'lander': res = paintLander(ctx, c, k, fr, mode === 'stack' ? { ...o, legs: 0 } : o); break;
      case 'starship': res = paintStarship(ctx, c, k, fr, o); break;
      case 'module': res = paintModule(ctx, c, k, fr, o); break;
      case 'rover': res = paintRover(ctx, c, k, fr, o); break;
      case 'rotorcraft': res = paintRotorcraft(ctx, c, k, fr, o); break;
      case 'aeroshell': res = paintAeroshell(ctx, c, k, fr, o); break;
      case 'spaceplane': res = paintSpaceplane(ctx, c, k, fr, o); break;
      default: res = paintProbe(ctx, c, k, fr, o);
    }
  } catch (e) {
    if (typeof console !== 'undefined') console.error('paintCraft', c?.name, e);
    res = { heightM: num(c.heightM, 3), widthM: num(c.widthM, 3), nozzles: [] };
  }
  ctx.restore();
  return res;
}

// ------------------------------------------------------------------ breakup (explosions)

/**
 * Debris pieces for an exploding stack. Each piece: { paint(ctx), x, y (vehicle metres, y up, piece centre),
 * vx, vy (m/s, y up), vr (rad/s), sizeM }. Feed into fx.addDebris after converting to screen px.
 */
export function breakupPieces(stack, flags = {}, { pxPerM = 4, light = SUN, seed = 1, max = 14 } = {}) {
  const r = rng((num(seed, 1) ^ hash(String(stack?.id || ''))) >>> 0);
  const out = [];
  for (const p of attachedParts(stack, flags)) {
    const n = Math.max(1, Math.min(4, Math.round(p.len / Math.max(3, p.d * 2.2))));
    for (let i = 0; i < n && out.length < max; i++) {
      const y0 = (p.len * i) / n, y1 = (p.len * (i + 1)) / n;
      const jag = [];
      for (let j = 0; j <= 6; j++) jag.push((r() - 0.5) * p.d * 0.35);
      const piece = { ...p };
      out.push({
        sizeM: Math.max(p.d, y1 - y0),
        x: p.x || 0, y: p.y + (y0 + y1) / 2,
        vx: (r() - 0.5) * 30 + (p.x || 0) * 3, vy: (r() - 0.2) * 25, vr: (r() - 0.5) * 3,
        paint: (ctx) => {
          ctx.save();
          const k = pxPerM, w = (p.d + 2) * k;
          ctx.beginPath();
          ctx.moveTo(-w, (y1 - y0) / 2 * k + jag[0] * k);
          for (let j = 0; j <= 6; j++) ctx.lineTo(-w + (2 * w * j) / 6, (y1 - y0) / 2 * k + jag[j] * k);
          for (let j = 6; j >= 0; j--) ctx.lineTo(-w + (2 * w * j) / 6, -(y1 - y0) / 2 * k - jag[6 - j] * k * 0.8);
          ctx.closePath(); ctx.clip();
          ctx.translate(0, (y0 + (y1 - y0) / 2) * k);
          paintPart(ctx, stack, piece, { pxPerM: k, light });
          // scorched torn edge
          ctx.strokeStyle = 'rgba(25,14,8,0.85)'; ctx.lineWidth = Math.max(1, 0.25 * k);
          ctx.beginPath();
          const cy = (y0 + (y1 - y0) / 2) * k;
          for (let j = 0; j <= 6; j++) ctx.lineTo(-w + (2 * w * j) / 6, -(y1 * k) + cy + jag[j] * k);
          ctx.stroke();
          ctx.restore();
        },
      });
    }
  }
  return out;
}

/** Stable per-id seed for visual variation (soot streaks, panel jitter). */
export function artSeed(id) { return hash(`art|${id}`); }
